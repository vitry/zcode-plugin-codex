// @ts-nocheck
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, win32 } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { createIdentityStore } from '../../scripts/lib/identity.mjs';
import { PluginError } from '../../scripts/lib/errors.mjs';
import { withFileLock } from '../../scripts/lib/fs.mjs';
import { createInvocationStore } from '../../scripts/lib/invocation.mjs';
import { createJobLog } from '../../scripts/lib/job-log.mjs';
import { createRescuePreparationStore } from '../../scripts/lib/rescue-preparation.mjs';
import { withWorkerLease } from '../../scripts/lib/recovery.mjs';
import { writeResultArtifact } from '../../scripts/lib/review.mjs';
import { createStateStore } from '../../scripts/lib/state.mjs';
import { resolveWorkspaceStorage } from '../../scripts/lib/workspace.mjs';
import { writeWorkspaceModelConfig } from '../../scripts/lib/workspace-config.mjs';
import { runDirectInvocation } from '../../scripts/zcode-companion.mjs';
import { instantiatePr39OriginRouteTemplate, PR39_ORIGIN_ROUTE_TEMPLATES } from '../fixtures/pr39-origin-route-compatibility.mjs';
import { runChild } from '../helpers/run-child.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(root, 'scripts', 'zcode-companion.mjs');
const fakeZCode = join(root, 'tests/fixtures/fake-zcode-cli.mjs');
const fakeCodex = join(root, 'tests/fixtures/fake-codex-app-server.mjs');
const pr39Fixture = join(root, 'tests/fixtures/pr39-origin-route-compatibility.mjs');
const pr39ClockPreload = join(root, 'tests/fixtures/pr39-frozen-clock-preload.mjs');
const legacyPreparedRoute = Object.freeze({ type: 'prepared', command: 'rescue', route: { version: 1, action: 'spawn', taskName: 'zcode_rescue_task' } });
const baseAgentPathDigest = createHash('sha256').update('/root/zcode_rescue_task').digest('hex');
const legacyPreparationDependencies = Object.freeze({
  planRescueActivation: async () => ({ activation: { kind: 'spawn', taskName: 'zcode_rescue_task', agentPathDigest: baseAgentPathDigest }, directive: legacyPreparedRoute.route }),
});

async function cleanupFixture(directory) {
  const delays = process.platform === 'win32' ? [80, 100, 250, 500, 1_000] : [80];
  let lastError;
  for (const delay of delays) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
    try {
      await rm(directory, { force: true, recursive: true });
      return;
    } catch (error) {
      if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolvePromise) => setTimeout(resolvePromise, 20)); }
  assert.fail(message);
}

async function workerLeaseAvailable(ctx, job) {
  if (!job?.workerLeaseId) return false;
  try { await withWorkerLease({ dataRoot: ctx.dataRoot, workspace: ctx.workspace, jobId: job.id, workerLeaseId: job.workerLeaseId, timeoutMs: 0 }, async () => {}); return true; }
  catch (error) { if (error?.code === 'LOCK_TIMEOUT') return false; throw error; }
}

async function waitForExactJobCleanup(ctx, store, jobId, timeoutMs = process.platform === 'win32' ? 30_000 : 5_000, cancel) {
  let latest;
  const settled = async () => { latest = await store.readJob(ctx.workspace, jobId); return ['succeeded', 'failed', 'cancelled'].includes(latest.status) && (!latest.workerLeaseId || await workerLeaseAvailable(ctx, latest)); };
  try { await waitUntil(settled, timeoutMs, `exact background job ${jobId} did not become terminal and release its worker lease`); }
  catch (error) {
    if (cancel) { await cancel().catch(() => {}); try { await waitUntil(settled, timeoutMs, `exact background job ${jobId} did not settle after job-aware cancellation`); return latest; } catch { /* preserve the original bounded cleanup failure */ } }
    ctx.preserveEvidence = true; throw error;
  }
  return latest;
}

async function findNewJobs(store, workspace, baselineIds) {
  const jobs = await store.listJobs(workspace);
  return jobs.filter((job) => !baselineIds.has(job.id));
}

async function run(command, args, cwd) {
  const result = await runChild(command, args, { cwd });
  if (result.code !== 0) throw new Error(`${command} exited ${result.code}`);
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-skills-'));
  const workspace = await realpath(await mkdir(join(directory, 'workspace'), { recursive: true }).then(() => join(directory, 'workspace')));
  const dataRoot = join(directory, 'data');
  await writeFile(join(workspace, 'tracked.txt'), 'base\n');
  await run('git', ['init', '-q'], workspace);
  await run('git', ['add', 'tracked.txt'], workspace);
  await run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], workspace);
  await writeFile(join(workspace, 'tracked.txt'), 'changed\n');
  const identity = createIdentityStore({ dataRoot });
  const callerA = await identity.createCallerContext({ sessionId: 'codex-a', turnId: 'turn-a', workspace, permissionMode: 'workspace-write' });
  const callerB = await identity.createCallerContext({ sessionId: 'codex-b', turnId: 'turn-b', workspace, permissionMode: 'read-only' });
  const env = {
    ...process.env, PLUGIN_DATA: dataRoot, PLUGIN_ROOT: root, ZCODE_PATH: fakeZCode,
    CODEX_APP_SERVER_PATH: process.execPath,
    CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([fakeCodex]),
    FAKE_CODEX_THREAD_LIST_RESULTS_JSON: JSON.stringify({ data: [], nextCursor: null, backwardsCursor: null }),
  };
  const context = { directory, workspace, dataRoot, callerA, callerB, env, preserveEvidence: false, stoppedChildren: new Set(), codexChildren: new Map() };
  t.after(async () => { if (!context.preserveEvidence) await cleanupFixture(directory); else t.diagnostic(`preserved background cleanup evidence at ${directory}`); });
  return context;
}

async function startRescueChild(ctx, parentSessionId, childId, turnId = `${childId}-turn`, agentType = 'zcode-rescue') {
  const result = await runChild(process.execPath, [join(root, 'hooks', 'subagent-hook.mjs')], {
    cwd: ctx.workspace, env: ctx.env, ordinaryInput: true,
    input: { session_id: parentSessionId, turn_id: turnId, cwd: ctx.workspace, hook_event_name: 'SubagentStart', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', agent_id: childId, agent_type: agentType },
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const rawChild = JSON.stringify(persistedCodexChild({
    id: childId, parentThreadId: parentSessionId, agentPath: '/root/zcode_rescue_task', cwd: await realpath(ctx.workspace),
    agentRole: agentType === 'zcode-rescue' ? 'zcode-rescue' : null,
  }));
  ctx.codexChildren.set(childId, rawChild); ctx.stoppedChildren.delete(childId); ctx.env.FAKE_CODEX_THREAD_JSON = rawChild;
}

function persistedCodexChild({ id, parentThreadId, agentPath, cwd, agentRole = 'zcode-rescue' }) {
  return {
    id, sessionId: parentThreadId, parentThreadId, ephemeral: false, preview: '', projectId: null,
    historyMode: 'legacy', modelProvider: 'openai', createdAt: 1, updatedAt: 2, recencyAt: 2,
    status: { type: 'notLoaded' }, path: null, cwd,
    source: { subAgent: { thread_spawn: {
      parent_thread_id: parentThreadId, depth: 1, agent_path: agentPath,
      agent_nickname: null, agent_role: agentRole,
    } } },
    canAcceptDirectInput: null, threadSource: null, agentNickname: null,
    agentRole, gitInfo: null, name: null, turns: [],
  };
}

async function prepareRescue(ctx, parentSessionId, envelope, childId) {
  const stopped = childId !== undefined && ctx.stoppedChildren.has(childId);
  const dependencies = stopped ? { planRescueActivation: async () => ({
    activation: { kind: 'reactivate', executorAgentId: childId, agentPathDigest: baseAgentPathDigest },
    directive: { version: 2, action: 'followup', target: '/root/zcode_rescue_task', assignment: 'zcode-rescue' },
  }) } : legacyPreparationDependencies;
  return runDirectInvocation(['prepare', 'rescue'], {
    cwd: ctx.workspace,
    env: { ...ctx.env, CODEX_THREAD_ID: parentSessionId },
    input: Readable.from([`${JSON.stringify(envelope)}\n`]),
    dependencies,
  });
}

async function invokePreparedRescue(ctx, parentSessionId, childId, task, options = { execution: 'foreground', resume: 'fresh' }, env = ctx.env) {
  await prepareRescue(ctx, parentSessionId, { version: 1, source: 'explicit', task, options }, childId);
  return runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: { ...env, FAKE_CODEX_THREAD_JSON: ctx.codexChildren.get(childId), CODEX_THREAD_ID: childId } });
}

async function startReservedRescueForTest(store, workspace, job, patch) {
  const workerLeaseId = createHash('sha256').update(`skills-fixture\0${job.id}`).digest('hex');
  const claimed = await store.claimJobWorkerForExecution(workspace, job.id, { childPid: process.pid, workerLeaseId });
  return store.transitionJob(workspace, job.id, ['queued'], 'running', {
    ...patch, childPid: claimed.childPid, workerLeaseId: claimed.workerLeaseId,
  });
}

async function materializePr39Scenario(t, name) {
  const ctx = await fixture(t); const target = join(ctx.directory, `pr39-${name}-target`);
  await run('git', ['worktree', 'add', '-q', '-b', `pr39-${name}-target`, target], ctx.workspace);
  const canonicalTarget = await realpath(target); await mkdir(ctx.dataRoot, { recursive: true, mode: 0o700 }); const canonicalDataRoot = await realpath(ctx.dataRoot);
  const scenario = instantiatePr39OriginRouteTemplate(PR39_ORIGIN_ROUTE_TEMPLATES[name], { dataRoot: canonicalDataRoot, origin: ctx.workspace, target: canonicalTarget });
  for (const record of scenario.records) {
    await mkdir(join(record.path, '..'), { recursive: true, mode: 0o700 });
    await writeFile(record.path, record.bytes, { mode: 0o600 });
  }
  for (const directory of [join(scenario.originDirectory, 'hook-state', '.lock'), join(scenario.targetDirectory, 'hook-state', '.lock')]) {
    await mkdir(directory, { recursive: true, mode: 0o700 }); await writeFile(join(directory, 'advisory.lock'), '', { mode: 0o600 });
  }
  const immutable = new Map();
  for (const record of scenario.records.filter((item) => item.classification === 'immutable')) immutable.set(record.path, await readFile(record.path));
  const env = { ...ctx.env, PLUGIN_DATA: canonicalDataRoot, PR39_FROZEN_CLOCK: '1', NODE_OPTIONS: `${ctx.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(pr39ClockPreload).href}`.trim() };
  return { ctx, scenario, target: canonicalTarget, immutable, env };
}

async function assertPr39Immutable(snapshot) {
  for (const [path, bytes] of snapshot) assert.deepEqual(await readFile(path), bytes, `frozen authority changed: ${path.split('/').at(-1)}`);
}

function assertPrivateRouteFailure(result, scenario, origin, target) {
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.code, 0);
  for (const secret of [origin, target, scenario.agentId, scenario.sessionId, scenario.parentTurnId, scenario.activeTurnId, scenario.childTurnId, scenario.generationId].filter(Boolean)) assert.equal(output.includes(secret), false, `public failure leaked ${secret}`);
}

function normalizeRelativeKey(value) { return value.replace(/[\\/]+/gu, '/'); }
function findPr39RouteRecord(records) { return records.find((record) => normalizeRelativeKey(record.path).includes('/hook-state/route-')); }

async function fileTree(directory, prefix = '') {
  let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of entries) {
    const relative = normalizeRelativeKey(prefix ? `${prefix}/${entry.name}` : entry.name); const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await fileTree(path, relative)); else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

async function assertOriginExecutionStateAbsent(dataRoot, origin) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace: origin }); const files = await fileTree(storage.directory);
  const forbidden = files.filter((path) => /^(?:invocations\/(?:prepared|pending)|jobs|job-owners|broker|results|prompts|worker-leases|cancel-locks)(?:\/|$)|^rescue-binding-(?:authority|session)-|^hook-state\/executor-/u.test(path));
  assert.deepEqual(forbidden, [], `origin contains Rescue execution state: ${forbidden.join(', ')}`);
}

async function documentedOperationSnapshot(workspaceDirectory) {
  const snapshot = new Map();
  for (const relative of await fileTree(workspaceDirectory)) {
    const advisoryLock = /^(?:\.artifacts\.lock|\.rescue-preparation-lock|\.state\.lock|(?:hook-state|broker|invocations)\/\.lock|broker\/session-owners\.json\.lock|cancel-locks\/[0-9a-f]{64}\.lock|worker-leases\/[0-9a-f]{64}-[0-9a-f]{64}\.lock|jobs\/\.job-log-(?:append|publication)-locks\/[0-9a-f]{64})\/advisory\.lock$/u.test(relative);
    const publicationTemp = /^jobs\/\.job-log-publication-locks\/([0-9a-f]{64})\/\.\1\.[0-9a-f]{32}\.tmp$/u.test(relative);
    if (advisoryLock || publicationTemp) continue;
    snapshot.set(relative, await readFile(join(workspaceDirectory, relative)));
  }
  return snapshot;
}

function assertSnapshotMatchesScenario(snapshot, scenario) {
  const expected = scenario.records.map((record) => {
    const nativeRelative = relative(scenario.targetDirectory, record.path); return { nativeRelative, key: normalizeRelativeKey(nativeRelative) };
  }).filter(({ nativeRelative, key }) => key !== '..' && !key.startsWith('../') && !isAbsolute(nativeRelative)).map(({ key }) => key).sort();
  assert.deepEqual([...snapshot.keys()], expected, 'initial target tree diverged from the frozen manifest');
}

function unchangedSnapshotPaths(before, changed) {
  const excluded = new Set(changed); return [...before.keys()].filter((path) => !excluded.has(path)).sort();
}

function snapshotDelta(before, after) {
  const added = [...after.keys()].filter((path) => !before.has(path)).sort();
  const deleted = [...before.keys()].filter((path) => !after.has(path)).sort();
  const updated = [...after.keys()].filter((path) => before.has(path) && !after.get(path).equals(before.get(path))).sort();
  const unchanged = [...after.keys()].filter((path) => before.has(path) && after.get(path).equals(before.get(path))).sort();
  return { added, deleted, updated, unchanged };
}

function exactlyOnePath(paths, predicate, description) {
  const matches = [...paths].filter(predicate); assert.equal(matches.length, 1, `expected one ${description}, found ${matches.join(', ')}`); return matches[0];
}

async function assertNoTransientTargetState(workspaceDirectory) {
  const files = await fileTree(workspaceDirectory);
  const transient = files.filter((path) => /^(?:worker-leases|cancel-locks)(?:\/|$)/u.test(path));
  assert.equal(transient.length, 2);
  assert.equal(transient.every((path) => /\.lock\/advisory\.lock$/u.test(path)), true, `transient execution record survived cleanup: ${transient.join(', ')}`);
}

test('PR #39 fixture manifests contain four independent literal record byte sets', async () => {
  const source = await readFile(pr39Fixture, 'utf8');
  assert.doesNotMatch(source, /records\.push|\bconst add\b|createIdentityStore|createRescuePreparationStore|createInvocationStore|createStateStore|SubagentStart/);
  assert.equal(source.match(/String\.raw`/gu)?.length, 4);
  const manifests = Object.values(PR39_ORIGIN_ROUTE_TEMPLATES); assert.equal(manifests.length, 4); assert.equal(new Set(manifests).size, 4);
  const expected = {
    prepared: { count: 9, digest: 'ecefe94305f0d20e4de9da226326773a99bf25fb692b21ff41efc9b3854c6cea', oneShot: '/invocations/prepared/' },
    status: { count: 14, digest: '5876c7822d8275ba7eaebb073fe159e5697ee3679a2f0a451a6a8b2e83fd162b' },
    choice: { count: 15, digest: 'ef78e516d83e5bd0dab5a91c4a8bff58a1e461931d0b29b56c28e63bebe2ed8f', oneShot: '/invocations/pending/' },
    stopped: { count: 15, digest: 'ccf4d21122c37b0f9a8d169da591c1acc76cd6cf22c68d82d603ffc6f4e2d716', oneShot: '/invocations/prepared/' },
  };
  const filenameTokens = new Set(['ORIGIN_WORKSPACE_HASH', 'TARGET_WORKSPACE_HASH', 'GLOBAL_KEY', 'ORIGIN_INDEX_KEY', 'TARGET_INDEX_KEY', 'CALLER_DIGEST', 'ROUTE_KEY', 'FORWARD_KEY', 'EXECUTOR_KEY', 'PREPARATION_KEY', 'PENDING_KEY', 'BINDING_PARTITION_KEY', 'BINDING_KEY', 'OWNER_DIRECTORY', 'OWNER_ID']);
  const byteTokens = new Set([...filenameTokens, 'JOB_LOG_JSON', 'ORIGIN_JSON', 'TARGET_JSON']);
  const tokens = (value) => [...value.matchAll(/\{\{([A-Z_]+)\}\}/gu)].map((match) => match[1]);
  for (const [name, raw] of Object.entries(PR39_ORIGIN_ROUTE_TEMPLATES)) {
    const manifest = JSON.parse(raw); assert.equal(manifest.name, name); assert.equal(manifest.records.length, expected[name].count); assert.equal(createHash('sha256').update(raw).digest('hex'), expected[name].digest);
    const paths = manifest.records.map((record) => record.path);
    for (const required of ['identity-lifecycle/active-turns/', 'identity-lifecycle/sessions/', '/identity/callers/', '/hook-state/route-', '/hook-state/forward-', '/hook-state/executor-']) assert.ok(paths.some((path) => path.includes(required)), `${name} lacks ${required}`);
    if (expected[name].oneShot) assert.ok(paths.some((path) => path.includes(expected[name].oneShot)));
    if (name !== 'prepared') for (const required of ['/jobs/', '/job-owners/index.json', '/broker/session-owners.json', '/rescue-binding-authority-', '/rescue-binding-session-']) assert.ok(paths.some((path) => path.includes(required)), `${name} lacks ${required}`);
    const instantiated = instantiatePr39OriginRouteTemplate(raw, { dataRoot: '/oracle/data', origin: '/repo/origin', target: '/repo/target' });
    for (const record of manifest.records) {
      assert.deepEqual(Object.keys(record).sort(), ['bytes', 'classification', 'path']);
      assert.equal(typeof record.path, 'string'); assert.equal(typeof record.bytes, 'string'); assert.match(record.bytes, /^\{[\s\S]*\}\n$/);
      assert.ok(['immutable', 'one-shot', 'operation'].includes(record.classification));
      assert.equal(tokens(record.path).every((token) => filenameTokens.has(token)), true, `${name} path has a non-filename token`);
      assert.equal(tokens(record.bytes).every((token) => byteTokens.has(token)), true, `${name} bytes have an unknown token`);
      assert.doesNotMatch(record.bytes, /\{\{(?:DATA_ROOT|ORIGIN|TARGET)\}\}/u);
    }
    for (let index = 0; index < manifest.records.length; index += 1) {
      const literal = manifest.records[index]; const instance = instantiated.records[index]; assert.equal(instance.classification, literal.classification); assert.doesNotThrow(() => JSON.parse(instance.bytes)); assert.doesNotMatch(instance.bytes, /\{\{[^}]+\}\}/u);
      let cursor = 0; for (const segment of literal.bytes.split(/\{\{[A-Z_]+\}\}/gu)) { const found = instance.bytes.indexOf(segment, cursor); assert.notEqual(found, -1, `${name} instantiated bytes changed literal content`); cursor = found + segment.length; }
    }
  }
});

test('PR #39 fixture JSON-escapes cross-platform paths without changing raw filename paths', () => {
  const paths = {
    dataRoot: 'C:\\Users\\A B\\data"root',
    origin: 'C:\\Users\\A B\\origin\tworkspace',
    target: 'C:\\Users\\A B\\target\nworkspace',
  };
  for (const name of ['status', 'choice', 'stopped']) {
    const scenario = instantiatePr39OriginRouteTemplate(PR39_ORIGIN_ROUTE_TEMPLATES[name], paths);
    assert.ok(scenario.records.every((record) => record.path.startsWith(paths.dataRoot)));
    for (const record of scenario.records) assert.doesNotThrow(() => JSON.parse(record.bytes), record.path);
    const activeTurn = JSON.parse(scenario.records.find((record) => record.path.includes('active-turns')).bytes);
    assert.equal(activeTurn.originWorkspace, paths.origin); assert.equal(activeTurn.executionWorkspace, paths.target);
    const job = JSON.parse(scenario.records.find((record) => record.path.endsWith(`${scenario.operation.jobId}.json`)).bytes);
    const targetHash = createHash('sha256').update(paths.target).digest('hex');
    assert.equal(job.logFile, join(paths.dataRoot, 'workspaces', targetHash, 'jobs', `${scenario.operation.jobId}.log`));
  }
});

test('PR #39 operation snapshots expose unexpected namespaces and job log mutations', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pr39-operation-snapshot-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'jobs'), { recursive: true }); await writeFile(join(directory, 'jobs', 'known.log'), 'before\n');
  const before = await documentedOperationSnapshot(directory);
  await writeFile(join(directory, 'jobs', 'known.log'), 'after\n'); await mkdir(join(directory, 'unexpected'), { recursive: true }); await writeFile(join(directory, 'unexpected', 'record.bin'), 'surprise');
  const disguised = join(directory, 'jobs', '.job-log-publication-locks', 'a'.repeat(64)); await mkdir(disguised, { recursive: true }); await writeFile(join(disguised, 'unexpected.bin'), 'surprise');
  assert.deepEqual(snapshotDelta(before, await documentedOperationSnapshot(directory)), { added: [`jobs/.job-log-publication-locks/${'a'.repeat(64)}/unexpected.bin`, 'unexpected/record.bin'], deleted: [], updated: ['jobs/known.log'], unchanged: [] });
});

test('PR #39 scenario relative keys use the snapshot separator on Windows', () => {
  assert.equal(normalizeRelativeKey(win32.relative('C:\\data\\target', 'C:\\data\\target\\jobs\\job.json')), 'jobs/job.json');
  const route = findPr39RouteRecord([{ path: 'C:\\data\\workspaces\\origin\\hook-state\\route-key.json' }]);
  assert.equal(route?.path, 'C:\\data\\workspaces\\origin\\hook-state\\route-key.json');
});

test('importing the PR #39 manifest never freezes the runner clock', async () => {
  const script = `await import(${JSON.stringify(pathToFileURL(pr39Fixture).href)}); process.stdout.write(String(Date.now()));`;
  const result = await runChild(process.execPath, ['--input-type=module', '--eval', script], { cwd: root, env: { ...process.env, PR39_FROZEN_CLOCK: '1' } });
  assert.equal(result.code, 0, result.stderr); assert.ok(Number(result.stdout) > Date.parse('2026-08-22T00:10:01.000Z'));
});

test('the PR #39 clock freezes only through a file-URL preload', async () => {
  const preloadUrl = pathToFileURL(pr39ClockPreload).href; assert.match(preloadUrl, /^file:\/\//u);
  assert.match(pathToFileURL(join(tmpdir(), 'checkout with space', 'clock preload.mjs')).href, /checkout%20with%20space\/clock%20preload\.mjs$/u);
  const result = await runChild(process.execPath, ['--input-type=module', '--eval', 'process.stdout.write(String(Date.now()))'], {
    cwd: root, env: { ...process.env, PR39_FROZEN_CLOCK: '1', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${preloadUrl}`.trim() },
  });
  assert.equal(result.code, 0, result.stderr); assert.equal(Number(result.stdout), Date.parse('2026-08-22T00:10:00.000Z'));
});

async function rewriteOnlyExecutor(ctx, patch) {
  const storage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.workspace });
  const names = (await readdir(join(storage.directory, 'hook-state'))).filter((name) => name.startsWith('executor-'));
  assert.equal(names.length, 1); const path = join(storage.directory, 'hook-state', names[0]); const record = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, `${JSON.stringify({ ...record, ...patch }, null, 2)}\n`);
}

test('origin hook cwd executes prepared Rescue only in its bound linked worktree', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  const target = join(ctx.directory, 'linked-execution');
  await run('git', ['worktree', 'add', '-q', '-b', 'linked-execution', target], ctx.workspace);
  const canonicalTarget = await realpath(target);
  const record = join(ctx.directory, 'linked-execution.jsonl'); await writeFile(record, '');
  await identity.beginCallerTurn({
    sessionId: 'linked-parent', turnId: 'linked-parent-turn', workspace: ctx.workspace, permissionMode: 'workspace-write',
    prompt: '$zcode:rescue --fresh repair linked execution', sessionStartedAt: '2026-08-21T09:00:00.000Z', sessionSource: 'startup', lifecycleResult: true,
  });
  assert.deepEqual(await runDirectInvocation(['prepare', 'rescue'], {
    cwd: canonicalTarget,
    env: { ...ctx.env, CODEX_THREAD_ID: 'linked-parent' },
    input: Readable.from([`${JSON.stringify({ version: 1, source: 'explicit', task: 'repair linked execution', options: { execution: 'foreground', resume: 'fresh' } })}\n`]),
    dependencies: legacyPreparationDependencies,
  }), legacyPreparedRoute);
  const start = await runChild(process.execPath, [join(root, 'hooks', 'subagent-hook.mjs')], {
    cwd: ctx.workspace, env: ctx.env, ordinaryInput: true,
    input: { session_id: 'linked-parent', turn_id: 'linked-child-turn', cwd: ctx.workspace, hook_event_name: 'SubagentStart', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', agent_id: 'linked-child', agent_type: 'zcode-rescue' },
  });
  assert.equal(start.code, 0, start.stderr || start.stdout);
  ctx.env.FAKE_CODEX_THREAD_JSON = JSON.stringify(persistedCodexChild({ id: 'linked-child', parentThreadId: 'linked-parent', agentPath: '/root/zcode_rescue_task', cwd: await realpath(ctx.workspace) }));
  const invoked = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'linked-child', FAKE_ZCODE_RECORD: record } });
  assert.equal(invoked.code, 0, invoked.stderr || invoked.stdout);
  const created = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).find((frame) => frame.method === 'session/create');
  assert.equal(created.params.workspace.workspacePath, canonicalTarget);
  assert.equal((await createStateStore({ dataRoot: ctx.dataRoot }).listJobs(ctx.workspace)).length, 0);
  assert.equal((await createStateStore({ dataRoot: ctx.dataRoot }).listJobs(canonicalTarget)).length, 1);
  await assertOriginExecutionStateAbsent(ctx.dataRoot, ctx.workspace);
});

test('origin cwd status reads only the exact foreground job bound in the linked worktree', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const store = createStateStore({ dataRoot: ctx.dataRoot });
  const target = join(ctx.directory, 'status-linked-execution');
  await run('git', ['worktree', 'add', '-q', '-b', 'status-linked-execution', target], ctx.workspace);
  const canonicalTarget = await realpath(target);
  await identity.beginCallerTurn({ sessionId: 'route-status-parent', turnId: 'route-status-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait repair route status', sessionStartedAt: '2026-08-22T09:00:00.000Z', sessionSource: 'startup', lifecycleResult: true });
  await prepareRescue({ ...ctx, workspace: canonicalTarget }, 'route-status-parent', { version: 1, source: 'explicit', task: 'repair route status', options: { execution: 'foreground', resume: 'fresh' } });
  await startRescueChild(ctx, 'route-status-parent', 'route-status-child', 'route-status-child-turn');
  const targetReservation = { workspace: canonicalTarget, ownerSessionId: 'route-status-parent', ownerTurnId: 'route-status-turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } };
  const targetExecutor = { agentId: 'route-status-child', agentType: 'zcode-rescue', parentSessionId: 'route-status-parent', parentTurnId: 'route-status-turn', parentPermissionMode: 'workspace-write', workspace: canonicalTarget };
  const targetJob = (await store.reserveFreshRescueJob({ workspace: canonicalTarget, reservation: targetReservation, executor: targetExecutor })).job;
  const targetStartedAt = new Date().toISOString(); const targetObservedAt = new Date().toISOString();
  await startReservedRescueForTest(store, canonicalTarget, targetJob, { startedAt: targetStartedAt, zcodeSessionId: 'route-status-target-session' });
  await store.updateJobProgress(canonicalTarget, targetJob.id, { phase: 'running', message: 'target-only progress', observedAt: targetObservedAt });
  const originReservation = { workspace: ctx.workspace, ownerSessionId: 'unrelated-origin-parent', ownerTurnId: 'unrelated-origin-turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } };
  const originExecutor = { agentId: 'unrelated-origin-child', agentType: 'zcode-rescue', parentSessionId: 'unrelated-origin-parent', parentTurnId: 'unrelated-origin-turn', parentPermissionMode: 'workspace-write', workspace: ctx.workspace };
  const originJob = (await store.reserveFreshRescueJob({ workspace: ctx.workspace, reservation: originReservation, executor: originExecutor })).job;
  await startReservedRescueForTest(store, ctx.workspace, originJob, { startedAt: new Date().toISOString(), zcodeSessionId: 'route-status-origin-session' });
  await store.updateJobProgress(ctx.workspace, originJob.id, { phase: 'running', message: 'origin-unrelated progress', observedAt: new Date().toISOString() });
  const originStorage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.workspace });
  const originOperation = await documentedOperationSnapshot(originStorage.directory);

  const result = await runChild(process.execPath, [cli, 'invoke-status', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'route-status-child' } });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { type: 'rescue-status', status: 'running', phase: 'running', lastActivityAt: targetObservedAt, progressPreview: ['target-only progress'], terminal: false });
  assert.doesNotMatch(result.stdout, /origin-unrelated|route-status-origin-session/);
  assert.deepEqual(await documentedOperationSnapshot(originStorage.directory), originOperation);
});

test('origin cwd choice resume consumes and executes only in the linked worktree', async (t) => {
  for (const choice of ['resume']) {
    const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const store = createStateStore({ dataRoot: ctx.dataRoot });
    const target = join(ctx.directory, `choice-${choice}-linked-execution`);
    await run('git', ['worktree', 'add', '-q', '-b', `choice-${choice}-linked-execution`, target], ctx.workspace);
    const canonicalTarget = await realpath(target); const record = join(ctx.directory, `choice-${choice}.jsonl`); await writeFile(record, '');
    const parentId = `route-choice-${choice}-parent`; const childId = `route-choice-${choice}-child`; const childTurnId = `route-choice-${choice}-child-turn`;
    await identity.beginCallerTurn({ sessionId: parentId, turnId: `route-choice-${choice}-origin`, workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh seed', sessionStartedAt: '2026-08-22T09:00:00.000Z', sessionSource: 'startup', lifecycleResult: true });
    await prepareRescue({ ...ctx, workspace: canonicalTarget }, parentId, { version: 1, source: 'explicit', task: `${choice} seed`, options: { execution: 'foreground', resume: 'fresh' } });
    await startRescueChild(ctx, parentId, childId, childTurnId);
    const first = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record } });
    assert.equal(first.code, 0, first.stderr || first.stdout);
    await stopRescueChild(ctx, parentId, childId, childTurnId);
    await identity.beginCallerTurn({ sessionId: parentId, turnId: `route-choice-${choice}-later`, workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: `$zcode:rescue ${choice} later`, sessionStartedAt: '2026-08-22T09:00:00.000Z', sessionSource: 'startup', lifecycleResult: true });
    await prepareRescue({ ...ctx, workspace: canonicalTarget }, parentId, { version: 1, source: 'explicit', task: `${choice} later`, options: { execution: 'foreground' } }, childId);
    const pending = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: canonicalTarget, env: { ...ctx.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record } });
    assert.equal(pending.code, 3, pending.stderr || pending.stdout); assert.match(pending.stdout, /needs-choice/);
    assert.equal((await store.listJobs(ctx.workspace)).length, 0);

    const selected = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', choice], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record } });
    assert.equal(selected.code, 0, selected.stderr || selected.stdout);
    await assert.rejects(createInvocationStore({ dataRoot: ctx.dataRoot }).consumePending({ sessionId: parentId, workspace: canonicalTarget, command: 'rescue', choice, executorAgentId: childId }), { code: 'PENDING_INVOCATION_NOT_FOUND' });
    assert.equal((await store.listJobs(ctx.workspace)).length, 0);
    assert.equal((await store.listJobs(canonicalTarget)).length, 2);
    const frames = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    if (choice === 'fresh') assert.equal(frames.filter((frame) => frame.method === 'session/create').length, 2);
    else assert.ok(frames.some((frame) => frame.method === 'session/resume'));
    for (const frame of frames.filter((item) => item.method === 'session/create')) assert.equal(frame.params.workspace.workspacePath, canonicalTarget);
    await assertOriginExecutionStateAbsent(ctx.dataRoot, ctx.workspace);
  }
});

test('origin cwd stopped continuation preserves the routed target for named and qualified default children', async (t) => {
  for (const [routeName, agentType] of [['named', 'zcode-rescue'], ['qualified-default', 'default']]) {
    const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const store = createStateStore({ dataRoot: ctx.dataRoot });
    const target = join(ctx.directory, `${routeName}-stopped-linked-execution`);
    await run('git', ['worktree', 'add', '-q', '-b', `${routeName}-stopped-linked-execution`, target], ctx.workspace);
    const canonicalTarget = await realpath(target); const record = join(ctx.directory, `${routeName}-stopped.jsonl`); await writeFile(record, '');
    const parentId = `${routeName}-stopped-parent`; const childId = `${routeName}-stopped-child`; const childTurnId = `${routeName}-stopped-child-turn`;
    await identity.beginCallerTurn({ sessionId: parentId, turnId: `${routeName}-origin-turn`, workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh first', sessionStartedAt: '2026-08-22T09:00:00.000Z', sessionSource: 'startup', lifecycleResult: true });
    await prepareRescue({ ...ctx, workspace: canonicalTarget }, parentId, { version: 1, source: 'explicit', task: `${routeName} first`, options: { execution: 'foreground', resume: 'fresh' } });
    await startRescueChild(ctx, parentId, childId, childTurnId, agentType);
    const first = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record } });
    assert.equal(first.code, 0, first.stderr || first.stdout);
    await stopRescueChild(ctx, parentId, childId, childTurnId, agentType);
    await identity.beginCallerTurn({ sessionId: parentId, turnId: `${routeName}-continuation-turn`, workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --resume continue', sessionStartedAt: '2026-08-22T09:00:00.000Z', sessionSource: 'startup', lifecycleResult: true });
    await prepareRescue({ ...ctx, workspace: canonicalTarget }, parentId, { version: 1, source: 'explicit', task: `${routeName} continue`, options: { execution: 'foreground', resume: 'resume' } }, childId);

    const continued = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record } });
    assert.equal(continued.code, 0, continued.stderr || continued.stdout);
    assert.equal((await store.listJobs(ctx.workspace)).length, 0);
    assert.equal((await store.listJobs(canonicalTarget)).length, 2);
    const frames = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(frames.some((frame) => frame.method === 'session/resume'));
    for (const frame of frames.filter((item) => item.method === 'session/create')) assert.equal(frame.params.workspace.workspacePath, canonicalTarget);
    await assertOriginExecutionStateAbsent(ctx.dataRoot, ctx.workspace);
  }
});

test('PR #39 frozen pre-activation fresh bytes fail closed without job binding or ZCode mutation', async (t) => {
  const { ctx, scenario, target, immutable, env } = await materializePr39Scenario(t, 'prepared');
  const record = join(ctx.directory, 'pr39-prepared-zcode.jsonl'); await writeFile(record, '');
  const preparation = scenario.records.find((item) => item.classification === 'one-shot'); assert.ok(preparation);
  const beforeOperation = await documentedOperationSnapshot(scenario.targetDirectory);
  assertSnapshotMatchesScenario(beforeOperation, scenario);
  const invoked = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: { ...env, CODEX_THREAD_ID: scenario.agentId, FAKE_ZCODE_RECORD: record } });
  assert.notEqual(invoked.code, 0); assert.match(invoked.stdout, /RESCUE_PREPARATION_MISMATCH/);
  await assertPr39Immutable(immutable);
  const consumed = JSON.parse(await readFile(preparation.path, 'utf8'));
  assert.equal(consumed.generation, 1); assert.equal(consumed.requiredExecutorAgentId, null); assert.equal(consumed.executorAgentId, scenario.agentId); assert.notEqual(consumed.consumedAt, null);
  const store = createStateStore({ dataRoot: ctx.dataRoot }); assert.equal((await store.listJobs(ctx.workspace)).length, 0);
  assert.equal((await store.listJobs(target)).length, 0); assert.equal((await readFile(record, 'utf8')).trim(), '');
  const afterOperation = await documentedOperationSnapshot(scenario.targetDirectory); const operationDelta = snapshotDelta(beforeOperation, afterOperation);
  const preparationPath = exactlyOnePath(beforeOperation.keys(), (path) => path.startsWith('invocations/prepared/'), 'prepared invocation');
  assert.deepEqual(operationDelta, {
    added: [],
    deleted: [], updated: [preparationPath], unchanged: unchangedSnapshotPaths(beforeOperation, [preparationPath]),
  });
  await assertOriginExecutionStateAbsent(ctx.dataRoot, ctx.workspace);
  const replay = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: { ...env, CODEX_THREAD_ID: scenario.agentId } });
  assertPrivateRouteFailure(replay, scenario, ctx.workspace, target); assert.match(replay.stdout, /RESCUE_PREPARATION_CONSUMED/);
});

test('PR #39 frozen status bytes select the exact target binding without mutation', async (t) => {
  const { ctx, scenario, target, immutable, env } = await materializePr39Scenario(t, 'status'); const store = createStateStore({ dataRoot: ctx.dataRoot });
  const frozenOperation = new Map();
  for (const record of scenario.records.filter((item) => item.classification === 'operation')) frozenOperation.set(record.path, await readFile(record.path));
  const beforeOperation = await documentedOperationSnapshot(scenario.targetDirectory);
  assertSnapshotMatchesScenario(beforeOperation, scenario);
  const result = await runChild(process.execPath, [cli, 'invoke-status', 'rescue'], { cwd: ctx.workspace, env: { ...env, CODEX_THREAD_ID: scenario.agentId } });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { type: 'rescue-status', status: 'running', phase: 'running', lastActivityAt: '2026-08-22T00:05:00.000Z', progressPreview: ['frozen target progress'], terminal: false });
  await assertPr39Immutable(immutable);
  for (const [path, bytes] of frozenOperation) assert.deepEqual(await readFile(path), bytes, `status mutated ${path.split('/').at(-1)}`);
  assert.deepEqual(await documentedOperationSnapshot(scenario.targetDirectory), beforeOperation);
  await assertOriginExecutionStateAbsent(ctx.dataRoot, ctx.workspace);
  assert.equal((await store.listJobs(ctx.workspace)).length, 0); assert.equal((await store.listJobs(target)).length, 1);
  const missing = await runChild(process.execPath, [cli, 'invoke-status', 'rescue'], { cwd: ctx.workspace, env: { ...env, CODEX_THREAD_ID: `${scenario.agentId}-unrelated` } });
  assertPrivateRouteFailure(missing, scenario, ctx.workspace, target); assert.match(missing.stdout, /EXECUTOR_IDENTITY_NOT_FOUND/);
});

test('origin status preserves malformed executor route vocabulary without leaking authority', async (t) => {
  const { ctx, scenario, target, env } = await materializePr39Scenario(t, 'status');
  const route = findPr39RouteRecord(scenario.records); assert.ok(route);
  await writeFile(route.path, '{"version":1}\n', { mode: 0o600 });
  const result = await runChild(process.execPath, [cli, 'invoke-status', 'rescue'], { cwd: ctx.workspace, env: { ...env, CODEX_THREAD_ID: scenario.agentId, ZCODE_DEBUG: '1' } });
  assertPrivateRouteFailure(result, scenario, ctx.workspace, target); assert.match(result.stdout, /EXECUTOR_ROUTE_INVALID/); assert.equal(result.stderr, '');
});

test('PR #39 frozen choice bytes consume once and keep the fixed resume transition in target', async (t) => {
  for (const choice of ['resume']) {
    const { ctx, scenario, target, immutable, env } = await materializePr39Scenario(t, 'choice'); const store = createStateStore({ dataRoot: ctx.dataRoot });
    const record = join(ctx.directory, `pr39-choice-${choice}-zcode.jsonl`); await writeFile(record, '');
    const pending = scenario.records.find((item) => item.classification === 'one-shot'); assert.ok(pending);
    const beforeOperation = await documentedOperationSnapshot(scenario.targetDirectory);
    assertSnapshotMatchesScenario(beforeOperation, scenario);
    const oldJobRecord = scenario.records.find((item) => item.path.endsWith(`${scenario.operation.jobId}.json`)); const oldJobBytes = await readFile(oldJobRecord.path);
    const beforeBinding = JSON.parse(await readFile(scenario.records.find((item) => item.path.includes('rescue-binding-session-')).path, 'utf8')).records[0];
    const selected = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', choice], { cwd: ctx.workspace, env: { ...env, CODEX_THREAD_ID: scenario.agentId, FAKE_ZCODE_RECORD: record, FAKE_ZCODE_WORKSPACE: target } });
    assert.equal(selected.code, 0, selected.stderr || selected.stdout);
    await assert.rejects(readFile(pending.path), { code: 'ENOENT' }); await assertPr39Immutable(immutable);
    assert.equal((await store.listJobs(ctx.workspace)).length, 0); const jobs = await store.listJobs(target); assert.equal(jobs.length, 2); assert.deepEqual(await readFile(oldJobRecord.path), oldJobBytes);
    const nextJob = jobs.find((job) => job.id !== scenario.operation.jobId); assert.equal(nextJob.status, 'succeeded'); assert.ok(nextJob.resultArtifact); assert.equal(await readFile(join(scenario.targetDirectory, nextJob.resultArtifact), 'utf8'), 'done');
    const binding = await store.resolveRescueBinding({ workspace: target, parentSessionId: scenario.sessionId, executorAgentId: scenario.agentId, executorAgentType: scenario.agentType, executorParentTurnId: scenario.parentTurnId, executorParentPermissionMode: 'workspace-write', permissionMode: 'workspace-write' });
    assert.equal(binding.kind, 'bound');
    if (choice === 'fresh') { assert.notEqual(binding.binding.anchorJobId, beforeBinding.anchorJobId); assert.equal(binding.binding.currentJobId, binding.binding.anchorJobId); assert.notEqual(binding.binding.operationId, beforeBinding.operationId); }
    else { assert.equal(binding.binding.anchorJobId, beforeBinding.anchorJobId); assert.notEqual(binding.binding.currentJobId, beforeBinding.currentJobId); assert.equal(binding.binding.operationId, beforeBinding.operationId); }
    const frames = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    if (choice === 'fresh') assert.ok(frames.some((frame) => frame.method === 'session/create'));
    else assert.ok(frames.some((frame) => frame.method === 'session/resume' && frame.params.sessionId === 'pr39-choice-zcode-session'));
    const brokerOwners = JSON.parse(await readFile(join(scenario.targetDirectory, 'broker', 'session-owners.json'), 'utf8')); assert.ok(brokerOwners.sessions['pr39-choice-zcode-session']);
    const afterOperation = await documentedOperationSnapshot(scenario.targetDirectory); const operationDelta = snapshotDelta(beforeOperation, afterOperation);
    exactlyOnePath(beforeOperation.keys(), (path) => path.startsWith('job-owners/') && path.endsWith(`/${scenario.operation.jobId}.json`), 'anchor owner binding');
    const nextOwnerPath = exactlyOnePath(operationDelta.added, (path) => path.startsWith('job-owners/') && path.endsWith(`/${nextJob.id}.json`), 'new owner binding');
    const pendingPath = exactlyOnePath(beforeOperation.keys(), (path) => path.startsWith('invocations/pending/'), 'pending invocation');
    exactlyOnePath(beforeOperation.keys(), (path) => path.startsWith('rescue-binding-authority-'), 'binding authority');
    const sessionPath = exactlyOnePath(beforeOperation.keys(), (path) => path.startsWith('rescue-binding-session-'), 'binding session');
    assert.deepEqual(operationDelta, {
      added: ['broker/identity.json', nextOwnerPath, `jobs/${nextJob.id}.json`, `jobs/${nextJob.id}.log`, `prompts/${nextJob.id}.md`, `results/${nextJob.id}.md`].sort(),
      deleted: [pendingPath],
      updated: [...(choice === 'fresh' ? ['broker/session-owners.json'] : []), 'job-owners/index.json', sessionPath].sort(),
      unchanged: unchangedSnapshotPaths(beforeOperation, [pendingPath, ...(choice === 'fresh' ? ['broker/session-owners.json'] : []), 'job-owners/index.json', sessionPath]),
    });
    assert.deepEqual(JSON.parse(await readFile(join(scenario.targetDirectory, nextOwnerPath), 'utf8')), {
      jobId: nextJob.id, ownerSessionId: scenario.sessionId, rescueReservationKind: 'bound', version: 2,
    });
    const ownerIndex = JSON.parse(await readFile(join(scenario.targetDirectory, 'job-owners', 'index.json'), 'utf8')); assert.equal(ownerIndex.canonicalJobIds.count, 2); assert.equal(ownerIndex.bindingTuples.count, 2); assert.equal(ownerIndex.complete, true);
    await assertNoTransientTargetState(scenario.targetDirectory);
    await assertOriginExecutionStateAbsent(ctx.dataRoot, ctx.workspace);
    const replay = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', choice], { cwd: ctx.workspace, env: { ...env, CODEX_THREAD_ID: scenario.agentId } });
    assertPrivateRouteFailure(replay, scenario, ctx.workspace, target); assert.match(replay.stdout, /PENDING_INVOCATION_NOT_FOUND/);
  }
});

test('PR #39 frozen stopped continuation consumes generation two and resumes its target session', async (t) => {
  const { ctx, scenario, target, immutable, env } = await materializePr39Scenario(t, 'stopped'); const store = createStateStore({ dataRoot: ctx.dataRoot });
  const record = join(ctx.directory, 'pr39-stopped-zcode.jsonl'); await writeFile(record, '');
  const preparation = scenario.records.find((item) => item.classification === 'one-shot'); assert.ok(preparation);
  const beforeOperation = await documentedOperationSnapshot(scenario.targetDirectory);
  assertSnapshotMatchesScenario(beforeOperation, scenario);
  const oldJobRecord = scenario.records.find((item) => item.path.endsWith(`${scenario.operation.jobId}.json`)); const oldJobBytes = await readFile(oldJobRecord.path);
  const continued = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: { ...env, CODEX_THREAD_ID: scenario.agentId, FAKE_ZCODE_RECORD: record, FAKE_ZCODE_WORKSPACE: target } });
  assert.equal(continued.code, 0, continued.stderr || continued.stdout); await assertPr39Immutable(immutable);
  const consumed = JSON.parse(await readFile(preparation.path, 'utf8'));
  assert.equal(consumed.generation, 2); assert.equal(consumed.requiredExecutorAgentId, scenario.agentId); assert.equal(consumed.executorAgentId, scenario.agentId); assert.notEqual(consumed.consumedAt, null);
  assert.equal((await store.listJobs(ctx.workspace)).length, 0); const jobs = await store.listJobs(target); assert.equal(jobs.length, 2); assert.deepEqual(await readFile(oldJobRecord.path), oldJobBytes);
  const nextJob = jobs.find((job) => job.id !== scenario.operation.jobId); assert.equal(nextJob.status, 'succeeded'); assert.ok(nextJob.resultArtifact); assert.equal(await readFile(join(scenario.targetDirectory, nextJob.resultArtifact), 'utf8'), 'done');
  const frames = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(frames.some((frame) => frame.method === 'session/resume' && frame.params.sessionId === 'pr39-stopped-zcode-session'));
  const binding = await store.resolveRescueBinding({ workspace: target, parentSessionId: scenario.sessionId, executorAgentId: scenario.agentId, executorAgentType: scenario.agentType, executorParentTurnId: scenario.parentTurnId, executorParentPermissionMode: 'workspace-write', permissionMode: 'workspace-write' });
  assert.equal(binding.kind, 'bound'); assert.equal(binding.binding.anchorJobId, scenario.operation.jobId); assert.equal(binding.binding.currentJobId, nextJob.id); assert.equal(binding.binding.operationId, scenario.operation.operationId);
  const afterOperation = await documentedOperationSnapshot(scenario.targetDirectory); const operationDelta = snapshotDelta(beforeOperation, afterOperation);
  exactlyOnePath(beforeOperation.keys(), (path) => path.startsWith('job-owners/') && path.endsWith(`/${scenario.operation.jobId}.json`), 'anchor owner binding');
  const nextOwnerPath = exactlyOnePath(operationDelta.added, (path) => path.startsWith('job-owners/') && path.endsWith(`/${nextJob.id}.json`), 'new owner binding');
  const preparationPath = exactlyOnePath(beforeOperation.keys(), (path) => path.startsWith('invocations/prepared/'), 'prepared invocation');
  exactlyOnePath(beforeOperation.keys(), (path) => path.startsWith('rescue-binding-authority-'), 'binding authority');
  const sessionPath = exactlyOnePath(beforeOperation.keys(), (path) => path.startsWith('rescue-binding-session-'), 'binding session');
  assert.deepEqual(operationDelta, {
    added: ['broker/identity.json', nextOwnerPath, `jobs/${nextJob.id}.json`, `jobs/${nextJob.id}.log`, `prompts/${nextJob.id}.md`, `results/${nextJob.id}.md`].sort(),
    deleted: [], updated: [preparationPath, 'job-owners/index.json', sessionPath].sort(),
    unchanged: unchangedSnapshotPaths(beforeOperation, [preparationPath, 'job-owners/index.json', sessionPath]),
  });
  assert.deepEqual(JSON.parse(await readFile(join(scenario.targetDirectory, nextOwnerPath), 'utf8')), {
    jobId: nextJob.id, ownerSessionId: scenario.sessionId, rescueReservationKind: 'bound', version: 2,
  });
  const ownerIndex = JSON.parse(await readFile(join(scenario.targetDirectory, 'job-owners', 'index.json'), 'utf8')); assert.equal(ownerIndex.canonicalJobIds.count, 2); assert.equal(ownerIndex.bindingTuples.count, 2); assert.equal(ownerIndex.complete, true);
  await assertNoTransientTargetState(scenario.targetDirectory);
  await assertOriginExecutionStateAbsent(ctx.dataRoot, ctx.workspace);
  const replay = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: { ...env, CODEX_THREAD_ID: scenario.agentId } });
  assertPrivateRouteFailure(replay, scenario, ctx.workspace, target); assert.match(replay.stdout, /RESCUE_PREPARATION_CONSUMED/);
});

test('prepared Rescue forwards only the normalized incident objective to ZCode', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const record = join(ctx.directory, 'prepared-objective.jsonl');
  const objective = 'implement the approved authentication specification';
  await identity.beginCallerTurn({
    sessionId: 'incident-parent', turnId: 'incident-turn', workspace: ctx.workspace, permissionMode: 'workspace-write',
    prompt: `Please ${objective}. Embedded marker: $zcode:rescue --fresh. If rescue fails, stop and report.`,
  });
  assert.deepEqual(await prepareRescue(ctx, 'incident-parent', { version: 1, source: 'explicit', task: objective, options: { execution: 'foreground', resume: 'fresh', model: 'model', effort: 'high' } }), legacyPreparedRoute);
  await startRescueChild(ctx, 'incident-parent', 'incident-child', 'incident-child-turn');
  const invoked = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'incident-child', FAKE_ZCODE_RECORD: record, FAKE_ZCODE_RESULT_FROM_AUTHORIZED_OBJECTIVE: '1' } });
  assert.equal(invoked.code, 0, invoked.stderr || invoked.stdout);
  const sent = (await readFile(record, 'utf8')).trim().split('\n').map(JSON.parse).find((frame) => frame.method === 'session/send');
  assert.match(sent.params.content, /AUTHORIZED RESCUE OBJECTIVE/);
  assert.match(sent.params.content, new RegExp(objective));
  assert.doesNotMatch(sent.params.content, /if rescue fails, stop and report/i);
  assert.doesNotMatch(`${invoked.stdout}${invoked.stderr}${invoked.spawnargs.join(' ')}`, /incident-parent|incident-turn|incident-child|explicit/);
});

test('prepared Rescue preserves option-like and shell-like tasks as one positional value', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const record = join(ctx.directory, 'option-like-tasks.jsonl'); await writeFile(record, '');
  const tasks = ['-leading objective', '--fresh', 'shell ; $(echo nope) "quoted"'];
  for (const [index, task] of tasks.entries()) {
    const parentId = `task-parent-${index}`; const childId = `task-child-${index}`;
    await identity.beginCallerTurn({ sessionId: parentId, turnId: `task-turn-${index}`, workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: `$zcode:rescue ${task}` });
    await prepareRescue(ctx, parentId, { version: 1, source: 'explicit', task, options: { execution: 'foreground', resume: 'fresh' } });
    await startRescueChild(ctx, parentId, childId);
    const invoked = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: childId, FAKE_ZCODE_RECORD: record } });
    assert.equal(invoked.code, 0, invoked.stderr || invoked.stdout);
    assert.equal(invoked.stdout, 'done\n'); assert.equal(`${invoked.stdout}${invoked.stderr}${invoked.spawnargs.join(' ')}`.includes(task), false);
    const sent = (await readFile(record, 'utf8')).trim().split('\n').map(JSON.parse).filter((frame) => frame.method === 'session/send').at(-1);
    const encodedObjective = /--- BEGIN AUTHORIZED RESCUE OBJECTIVE ---\n([^\n]+)\n--- END AUTHORIZED RESCUE OBJECTIVE ---/u.exec(sent.params.content)?.[1];
    assert.equal(JSON.parse(encodedObjective), task); assert.doesNotMatch(`${invoked.stdout}${invoked.stderr}${invoked.spawnargs.join(' ')}`, /task-parent-|task-turn-|task-child-/);
  }
});

test('prepare Rescue accepts proactive source without a marker and rejects malformed or mismatched input task-free', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  await identity.beginCallerTurn({ sessionId: 'proactive-parent', turnId: 'proactive-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: 'Implement the approved objective.' });
  assert.deepEqual(await prepareRescue(ctx, 'proactive-parent', { version: 1, source: 'proactive', task: 'approved objective', options: { resume: 'fresh' } }), legacyPreparedRoute);
  await identity.beginCallerTurn({ sessionId: 'bad-parent', turnId: 'bad-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue protected secret objective' });
  await assert.rejects(prepareRescue(ctx, 'bad-parent', { version: 1, source: 'proactive', task: 'protected secret objective', options: {} }), (error) => error?.code === 'RESCUE_PREPARATION_SOURCE_MISMATCH' && !`${error.message}${error.remedy}`.includes('protected secret objective'));
  await assert.rejects(runDirectInvocation(['prepare', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'bad-parent' }, input: Readable.from(['not-json\n']) }), (error) => error?.code === 'RESCUE_PREPARATION_INVALID' && !`${error.message}${error.remedy}`.includes('not-json'));
});

test('prepare Rescue aborts an injected input wait with the exact task-free interruption', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const input = new PassThrough(); const controller = new AbortController();
  await identity.beginCallerTurn({ sessionId: 'abort-parent', turnId: 'abort-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: 'proactive objective' });
  const interruption = new PluginError('JOB_INTERRUPTED', 'Preparation interrupted.', { category: 'interruption', remedy: 'Retry.' });
  const operation = runDirectInvocation(['prepare', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'abort-parent' }, input, signal: controller.signal });
  const abortTimer = setTimeout(() => controller.abort(interruption), 10); const fallbackTimer = setTimeout(() => input.destroy(), 200);
  t.after(() => { clearTimeout(abortTimer); clearTimeout(fallbackTimer); input.destroy(); });
  await assert.rejects(operation, (error) => error === interruption && !`${error.message}${error.remedy}`.includes('proactive objective'));
});

test('private prepare transport enables raw mode before readiness and accepts one LF frame without EOF', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const input = new PassThrough(); const events = []; const task = '--fresh ; $(echo private)';
  input.isTTY = true; input.setRawMode = (enabled) => { events.push(`raw:${enabled}`); return input; };
  await identity.beginCallerTurn({ sessionId: 'transport-parent', turnId: 'transport-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: `$zcode:rescue ${task}` });
  let timeout;
  t.after(() => { clearTimeout(timeout); input.destroy(); });
  const operation = runDirectInvocation(['prepare', 'rescue'], {
    cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'transport-parent' }, input,
    preparationTransport: { writeReady: (line) => { events.push(`ready:${line}`); input.write(`${JSON.stringify({ version: 1, source: 'explicit', task, options: { resume: 'fresh' } })}\n`); } },
  });
  const bounded = Promise.race([operation, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('private preparation did not consume its LF frame')), process.platform === 'win32' ? 30_000 : 5_000); })]);
  assert.deepEqual(await bounded, legacyPreparedRoute); clearTimeout(timeout);
  assert.deepEqual(events, ['raw:true', 'ready:{"type":"preparation-input-ready","command":"rescue"}\n', 'raw:false']);
  assert.equal(events.join('').includes(task), false); assert.equal(input.destroyed, false, 'one complete LF frame must not require or force EOF');
});

test('private prepare transport requires a raw-capable TTY before reading task bytes', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const input = new PassThrough(); let ready = false;
  await identity.beginCallerTurn({ sessionId: 'non-tty-parent', turnId: 'non-tty-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue private non-tty task' });
  const fallback = setTimeout(() => input.destroy(), 250); t.after(() => { clearTimeout(fallback); input.destroy(); });
  await assert.rejects(runDirectInvocation(['prepare', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'non-tty-parent' }, input, preparationTransport: { writeReady: () => { ready = true; } } }), (error) => error?.code === 'PREPARATION_TTY_REQUIRED' && !`${error.message}${error.remedy}`.includes('private non-tty task'));
  assert.equal(ready, false); assert.equal(input.listenerCount('data'), 0);
});

test('private prepare transport rejects bytes after its LF frame without waiting for EOF', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const input = new PassThrough(); const rawModes = [];
  input.isTTY = true; input.setRawMode = (enabled) => { rawModes.push(enabled); return input; };
  await identity.beginCallerTurn({ sessionId: 'trailing-parent', turnId: 'trailing-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: 'proactive trailing objective' });
  const fallback = setTimeout(() => input.destroy(), 250); t.after(() => { clearTimeout(fallback); input.destroy(); });
  await assert.rejects(runDirectInvocation(['prepare', 'rescue'], {
    cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'trailing-parent' }, input,
    preparationTransport: { writeReady: () => input.write(`${JSON.stringify({ version: 1, source: 'proactive', task: 'trailing objective', options: {} })}\nextra`) },
  }), { code: 'RESCUE_PREPARATION_INVALID' });
  assert.deepEqual(rawModes, [true, false]); assert.equal(input.destroyed, false);
});

test('prepare Rescue forwards an injected abort through a contended save without persisting', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const controller = new AbortController(); const interruption = new PluginError('JOB_INTERRUPTED', 'Contended preparation interrupted.', { category: 'interruption', remedy: 'Retry.' });
  await identity.beginCallerTurn({ sessionId: 'save-abort-parent', turnId: 'save-abort-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: 'proactive save objective' });
  const storage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.workspace }); const lockPath = join(storage.directory, '.rescue-preparation-lock'); let operation; let observed;
  await withFileLock(lockPath, async () => {
    operation = runDirectInvocation(['prepare', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'save-abort-parent' }, input: Readable.from([`${JSON.stringify({ version: 1, source: 'proactive', task: 'save objective', options: {} })}\n`]), signal: controller.signal }).then((value) => ({ value }), (error) => ({ error }));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50)); controller.abort(interruption);
    observed = await Promise.race([operation, new Promise((resolvePromise) => setTimeout(() => resolvePromise({ timeout: true }), 250))]);
  });
  await operation;
  assert.equal(observed?.error, interruption);
  await assert.rejects(createRescuePreparationStore({ dataRoot: ctx.dataRoot }).consume({ sessionId: 'save-abort-parent', turnId: 'save-abort-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', executorAgentId: 'child' }), { code: 'RESCUE_PREPARATION_NOT_FOUND' });
});

test('legacy child invoke rescue requires the prepared route', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  await identity.beginCallerTurn({ sessionId: 'legacy-parent', turnId: 'legacy-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh secret objective' });
  await startRescueChild(ctx, 'legacy-parent', 'legacy-child');
  const result = await runChild(process.execPath, [cli, 'invoke', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'legacy-child' } });
  assert.notEqual(result.code, 0); assert.match(result.stdout, /PREPARED_INVOCATION_REQUIRED/); assert.match(result.stdout, /prepare rescue/i); assert.doesNotMatch(result.stdout, /secret objective/);
});

test('prepared Rescue is single-use and bound to the exact parent turn, workspace, and executor', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const unpreparedRecord = join(ctx.directory, 'unprepared-zcode.jsonl');
  await identity.beginCallerTurn({ sessionId: 'unprepared-parent', turnId: 'unprepared-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue unprepared objective' });
  await startRescueChild(ctx, 'unprepared-parent', 'unprepared-child');
  const unprepared = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'unprepared-child', FAKE_ZCODE_RECORD: unpreparedRecord } });
  assert.notEqual(unprepared.code, 0); assert.match(unprepared.stdout, /RESCUE_PREPARATION_NOT_FOUND/);
  await assert.rejects(readFile(unpreparedRecord, 'utf8'), { code: 'ENOENT' });
  await stopRescueChild(ctx, 'unprepared-parent', 'unprepared-child');

  await identity.beginCallerTurn({ sessionId: 'bound-parent', turnId: 'bound-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue exact objective' });
  await prepareRescue(ctx, 'bound-parent', { version: 1, source: 'explicit', task: 'exact objective', options: { resume: 'fresh' } });
  const parent = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'bound-parent' } });
  assert.notEqual(parent.code, 0); assert.match(parent.stdout, /(?:EXECUTOR_IDENTITY_(?:NOT_FOUND|UNAVAILABLE)|CODEX_CHILD_METADATA_INVALID)/);
  const sibling = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'sibling-child' } });
  assert.notEqual(sibling.code, 0); assert.match(sibling.stdout, /(?:EXECUTOR_IDENTITY_(?:NOT_FOUND|UNAVAILABLE)|CODEX_CHILD_METADATA_INVALID)/);
  await startRescueChild(ctx, 'bound-parent', 'bound-child');
  const wrongWorkspace = join(ctx.directory, 'wrong-workspace'); await mkdir(wrongWorkspace);
  const wrong = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: wrongWorkspace, env: { ...ctx.env, CODEX_THREAD_ID: 'bound-child' } });
  assert.notEqual(wrong.code, 0); assert.match(wrong.stdout, /(?:EXECUTOR_IDENTITY_(?:NOT_FOUND|UNAVAILABLE)|CODEX_CHILD_METADATA_INVALID|ACTIVE_TURN_(?:NOT_FOUND|WORKSPACE_INELIGIBLE))/);
  const accepted = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'bound-child' } });
  assert.equal(accepted.code, 0, accepted.stderr || accepted.stdout);
  const replay = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'bound-child' } });
  assert.notEqual(replay.code, 0); assert.match(replay.stdout, /RESCUE_PREPARATION_CONSUMED/);

  await identity.beginCallerTurn({ sessionId: 'stale-parent', turnId: 'original-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue stale objective' });
  await prepareRescue(ctx, 'stale-parent', { version: 1, source: 'explicit', task: 'stale objective', options: { resume: 'fresh' } });
  await startRescueChild(ctx, 'stale-parent', 'stale-child');
  await identity.beginCallerTurn({ sessionId: 'stale-parent', turnId: 'replacement-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue replacement' });
  const stale = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'stale-child' } });
  assert.notEqual(stale.code, 0); assert.match(stale.stdout, /EXECUTOR_PARENT_TURN_MISMATCH/);
});

test('bound needs-choice snapshots candidate A and ignores a newer eligible candidate B', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const store = createStateStore({ dataRoot: ctx.dataRoot });
  const record = join(ctx.directory, 'candidate-snapshot-peer.jsonl'); await writeFile(record, '');
  await identity.beginCallerTurn({ sessionId: 'snapshot-parent', turnId: 'anchor-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh anchor' });
  await startRescueChild(ctx, 'snapshot-parent', 'snapshot-child', 'snapshot-child-turn');
  const initial = await invokePreparedRescue(ctx, 'snapshot-parent', 'snapshot-child', 'anchor', { execution: 'foreground', resume: 'fresh' }, { ...ctx.env, FAKE_ZCODE_RECORD: record });
  assert.equal(initial.code, 0, initial.stderr || initial.stdout);
  const [candidateA] = await store.listOwnedJobs(ctx.workspace, 'snapshot-parent');
  assert.ok(candidateA?.zcodeSessionId);
  await stopRescueChild(ctx, 'snapshot-parent', 'snapshot-child', 'snapshot-child-turn');

  await identity.beginCallerTurn({ sessionId: 'snapshot-parent', turnId: 'choice-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue continue' });
  const undecided = await invokePreparedRescue(ctx, 'snapshot-parent', 'snapshot-child', 'continue', { execution: 'foreground' }, { ...ctx.env, FAKE_ZCODE_RECORD: record });
  assert.equal(undecided.code, 3, undecided.stderr || undecided.stdout); assert.match(undecided.stdout, /needs-choice/);

  const candidateB = await store.reserveJob({ workspace: ctx.workspace, ownerSessionId: 'snapshot-parent', ownerTurnId: 'inserted-turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await startReservedRescueForTest(store, ctx.workspace, candidateB, { zcodeSessionId: 'newer-session-b', startedAt: new Date().toISOString() });
  await store.transitionJob(ctx.workspace, candidateB.id, ['running'], 'succeeded', { finishedAt: new Date().toISOString(), exitCode: 0 });
  await identity.beginCallerTurn({ sessionId: 'snapshot-parent', turnId: 'answer-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: 'resume' });
  const resumed = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'resume'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'snapshot-child', FAKE_ZCODE_RECORD: record } });
  assert.equal(resumed.code, 0, resumed.stderr || resumed.stdout);
  const peer = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(peer.filter((frame) => frame.method === 'session/resume').at(-1)?.params?.sessionId, candidateA.zcodeSessionId);
  assert.notEqual(peer.filter((frame) => frame.method === 'session/resume').at(-1)?.params?.sessionId, 'newer-session-b');
  const binding = await store.resolveRescueBinding({ workspace: ctx.workspace, parentSessionId: 'snapshot-parent', executorAgentId: 'snapshot-child', executorAgentType: 'zcode-rescue', executorParentTurnId: 'anchor-turn', executorParentPermissionMode: 'workspace-write', permissionMode: 'workspace-write' });
  assert.equal(binding.kind, 'bound'); assert.equal(binding.binding.anchorJobId, candidateA.id);
});

test('legacy executor-bound pending without a candidate rejects resume and fresh returns to the parent without old-child work', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const pending = createInvocationStore({ dataRoot: ctx.dataRoot });
  const peerRecord = join(ctx.directory, 'legacy-choice-peer.jsonl'); const seedRecord = join(ctx.directory, 'legacy-choice-seed.jsonl'); await writeFile(seedRecord, '');
  await identity.beginCallerTurn({ sessionId: 'legacy-parent', turnId: 'legacy-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue legacy' });
  await startRescueChild(ctx, 'legacy-parent', 'legacy-child', 'legacy-child-turn');
  assert.equal((await invokePreparedRescue(ctx, 'legacy-parent', 'legacy-child', 'seed binding', { execution: 'foreground', resume: 'fresh' },
    { ...ctx.env, FAKE_ZCODE_RECORD: seedRecord })).code, 0);
  await stopRescueChild(ctx, 'legacy-parent', 'legacy-child', 'legacy-child-turn');
  const storage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.workspace });
  const bindingName = (await readdir(storage.directory)).find((name) => name.startsWith('rescue-binding-session-'));
  assert.ok(bindingName); const bindingPath = join(storage.directory, bindingName); const bindingBytes = await readFile(bindingPath);
  const saveOldPending = async () => {
    await pending.savePending({ sessionId: 'legacy-parent', turnId: 'legacy-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', command: 'rescue', source: 'proactive', executorAgentId: 'legacy-child', spec: { argv: ['rescue', 'legacy task'] } });
    const storage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.workspace }); const directory = join(storage.directory, 'invocations', 'pending'); const [name] = await readdir(directory);
    const record = JSON.parse(await readFile(join(directory, name), 'utf8')); delete record.version; delete record.source; delete record.routeKind; delete record.candidateJobId; delete record.expectedOperationId; delete record.expectedCurrentJobId;
    await writeFile(join(directory, name), `${JSON.stringify(record)}\n`);
  };
  await saveOldPending();
  const before = await createStateStore({ dataRoot: ctx.dataRoot }).listJobs(ctx.workspace);
  const resume = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'resume'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'legacy-child', FAKE_ZCODE_RECORD: peerRecord } });
  assert.notEqual(resume.code, 0); assert.match(resume.stdout, /PENDING_INVOCATION_INCOMPATIBLE/);
  assert.deepEqual(await createStateStore({ dataRoot: ctx.dataRoot }).listJobs(ctx.workspace), before);
  await assert.rejects(readFile(peerRecord, 'utf8'), { code: 'ENOENT' });
  await saveOldPending();
  await identity.beginCallerTurn({ sessionId: 'legacy-parent', turnId: 'legacy-fresh-answer-turn', workspace: ctx.workspace,
    permissionMode: 'workspace-write', prompt: 'fresh' });
  const beforeFresh = await createStateStore({ dataRoot: ctx.dataRoot }).listJobs(ctx.workspace);
  const fresh = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'fresh'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'legacy-child', FAKE_ZCODE_RECORD: peerRecord } });
  assert.equal(fresh.code, 0, fresh.stderr || fresh.stdout);
  assert.deepEqual(JSON.parse(fresh.stdout), { type: 'parent-replan', command: 'rescue' });
  assert.deepEqual(await createStateStore({ dataRoot: ctx.dataRoot }).listJobs(ctx.workspace), beforeFresh);
  assert.deepEqual(await readFile(bindingPath), bindingBytes);
  await assert.rejects(readFile(peerRecord, 'utf8'), { code: 'ENOENT' });
  await assert.rejects(createInvocationStore({ dataRoot: ctx.dataRoot }).consumePending({ sessionId: 'legacy-parent', workspace: ctx.workspace,
    command: 'rescue', choice: 'fresh', executorAgentId: 'legacy-child' }), { code: 'PENDING_INVOCATION_NOT_FOUND' });
});

test('pending fresh replan spawns a new child that creates exactly one new session without mutating the old binding', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const store = createStateStore({ dataRoot: ctx.dataRoot });
  const record = join(ctx.directory, 'cross-turn-pending-fresh.jsonl'); await writeFile(record, '');
  await identity.beginCallerTurn({ sessionId: 'cross-turn-parent', turnId: 'seed-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh seed' });
  await startRescueChild(ctx, 'cross-turn-parent', 'old-child', 'old-child-start');
  assert.equal((await invokePreparedRescue(ctx, 'cross-turn-parent', 'old-child', 'seed', { execution: 'foreground', resume: 'fresh' }, { ...ctx.env, FAKE_ZCODE_RECORD: record })).code, 0);
  await stopRescueChild(ctx, 'cross-turn-parent', 'old-child', 'old-child-start');

  await identity.beginCallerTurn({ sessionId: 'cross-turn-parent', turnId: 'choice-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue continue' });
  const undecided = await invokePreparedRescue(ctx, 'cross-turn-parent', 'old-child', 'continue', { execution: 'foreground' }, { ...ctx.env, FAKE_ZCODE_RECORD: record });
  assert.equal(undecided.code, 3, undecided.stderr || undecided.stdout); assert.match(undecided.stdout, /needs-choice/);
  const storage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.workspace });
  const bindingName = (await readdir(storage.directory)).find((name) => name.startsWith('rescue-binding-session-'));
  assert.ok(bindingName); const bindingPath = join(storage.directory, bindingName);
  const jobsBefore = await store.listJobs(ctx.workspace); const peerBefore = await readFile(record);

  await identity.beginCallerTurn({ sessionId: 'cross-turn-parent', turnId: 'answer-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: 'fresh' });
  const choice = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'fresh'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'old-child', FAKE_ZCODE_RECORD: record } });
  assert.equal(choice.code, 0, choice.stderr || choice.stdout); assert.deepEqual(JSON.parse(choice.stdout), { type: 'parent-replan', command: 'rescue' });
  await assert.rejects(createInvocationStore({ dataRoot: ctx.dataRoot }).consumePending({ sessionId: 'cross-turn-parent', workspace: ctx.workspace,
    command: 'rescue', choice: 'fresh', executorAgentId: 'old-child' }), { code: 'PENDING_INVOCATION_NOT_FOUND' });
  assert.deepEqual(await store.listJobs(ctx.workspace), jobsBefore); assert.deepEqual(await readFile(record), peerBefore);
  const bindingBeforeReplan = JSON.parse(await readFile(bindingPath, 'utf8'));
  const oldBindingBytes = new Map(bindingBeforeReplan.records.map((binding) => [binding.key, Buffer.from(JSON.stringify(binding))]));

  const taskName = 'zcode_rescue_task_2'; const agentPathDigest = createHash('sha256').update(`/root/${taskName}`).digest('hex');
  const envelope = { version: 1, source: 'explicit', task: 'continue', options: { execution: 'foreground', resume: 'fresh' } };
  const prepared = await runDirectInvocation(['prepare', 'rescue'], {
    cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'cross-turn-parent' }, input: Readable.from([`${JSON.stringify(envelope)}\n`]),
    dependencies: { planRescueActivation: async () => ({ activation: { kind: 'spawn', taskName, agentPathDigest }, directive: { version: 1, action: 'spawn', taskName } }) },
  });
  assert.deepEqual(prepared, { type: 'prepared', command: 'rescue', route: { version: 1, action: 'spawn', taskName } });
  await startRescueChild(ctx, 'cross-turn-parent', 'new-child', 'new-child-start');
  const spawnedChild = persistedCodexChild({ id: 'new-child', parentThreadId: 'cross-turn-parent', agentPath: `/root/${taskName}`, cwd: ctx.workspace });
  const newRecord = join(ctx.directory, 'cross-turn-pending-fresh-new.jsonl'); await writeFile(newRecord, '');
  const executed = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace,
    env: { ...ctx.env, CODEX_THREAD_ID: 'new-child', FAKE_CODEX_THREAD_JSON: JSON.stringify(spawnedChild), FAKE_ZCODE_RECORD: newRecord } });
  assert.equal(executed.code, 0, executed.stderr || executed.stdout);
  const frames = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const previousFrames = peerBefore.toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(frames.filter((frame) => frame.method === 'session/create').length
    - previousFrames.filter((frame) => frame.method === 'session/create').length, 1);
  assert.equal(frames.filter((frame) => frame.method === 'session/resume').length
    - previousFrames.filter((frame) => frame.method === 'session/resume').length, 0);
  const bindingAfterExecution = JSON.parse(await readFile(bindingPath, 'utf8'));
  assert.equal(bindingAfterExecution.records.length, bindingBeforeReplan.records.length + 1);
  for (const binding of bindingAfterExecution.records) {
    if (oldBindingBytes.has(binding.key)) assert.deepEqual(Buffer.from(JSON.stringify(binding)), oldBindingBytes.get(binding.key));
  }
  await assert.rejects(runDirectInvocation(['prepare', 'rescue'], {
    cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'cross-turn-parent' }, input: Readable.from([`${JSON.stringify(envelope)}\n`]),
    dependencies: { planRescueActivation: async () => ({ activation: { kind: 'spawn', taskName, agentPathDigest }, directive: { version: 1, action: 'spawn', taskName } }) },
  }), { code: 'RESCUE_PREPARATION_EXISTS' });
});

test('aged stopped executor cannot resume an eligible latest job when its exact binding is missing', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const store = createStateStore({ dataRoot: ctx.dataRoot }); const peerRecord = join(ctx.directory, 'unbound-aged-peer.jsonl');
  await identity.beginCallerTurn({ sessionId: 'unbound-parent', turnId: 'origin-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh seed' });
  await startRescueChild(ctx, 'unbound-parent', 'unbound-child', 'unbound-child-turn');
  assert.equal((await invokePreparedRescue(ctx, 'unbound-parent', 'unbound-child', 'seed')).code, 0);
  await stopRescueChild(ctx, 'unbound-parent', 'unbound-child', 'unbound-child-turn');
  const storage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.workspace });
  const hookStateNames = await readdir(join(storage.directory, 'hook-state')); const executorName = hookStateNames.find((name) => name.startsWith('executor-')); const routeName = hookStateNames.find((name) => name.startsWith('route-'));
  const executorPath = join(storage.directory, 'hook-state', executorName); const routePath = join(storage.directory, 'hook-state', routeName); const executor = JSON.parse(await readFile(executorPath, 'utf8')); const route = JSON.parse(await readFile(routePath, 'utf8')); const agedAt = new Date(Date.now() - 31 * 60_000).toISOString();
  await writeFile(executorPath, `${JSON.stringify({ ...executor, createdAt: agedAt })}\n`); await writeFile(routePath, `${JSON.stringify({ ...route, createdAt: agedAt })}\n`);
  for (const name of await readdir(storage.directory)) if (name.startsWith('rescue-binding-')) await rm(join(storage.directory, name));
  await identity.beginCallerTurn({ sessionId: 'unbound-parent', turnId: 'later-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: 'Continue the exact same stopped Rescue child.' });
  await prepareRescue(ctx, 'unbound-parent', { version: 1, source: 'proactive', task: 'continue', options: { execution: 'foreground', resume: 'resume' } }, 'unbound-child');
  const before = await store.listJobs(ctx.workspace);
  const rejected = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'unbound-child', FAKE_ZCODE_RECORD: peerRecord } });
  assert.notEqual(rejected.code, 0); assert.match(rejected.stdout, /(?:EXECUTOR_IDENTITY_NOT_FOUND|RESCUE_BINDING_(?:NOT_FOUND|INVALID))/);
  assert.deepEqual(await store.listJobs(ctx.workspace), before);
  await assert.rejects(readFile(peerRecord, 'utf8'), { code: 'ENOENT' });
});

test('0.147 default compatibility child persists and consumes one same-child Rescue choice', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  await identity.beginCallerTurn({ sessionId: 'generic-parent', turnId: 'generic-seed', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait seed' });
  await startRescueChild(ctx, 'generic-parent', 'generic-child', 'generic-seed-child', 'default');
  assert.equal((await invokePreparedRescue(ctx, 'generic-parent', 'generic-child', 'seed')).code, 0);
  await stopRescueChild(ctx, 'generic-parent', 'generic-child', 'generic-seed-child', 'default');
  await identity.beginCallerTurn({ sessionId: 'generic-parent', turnId: 'generic-origin', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --wait continue' });
  const undecided = await invokePreparedRescue(ctx, 'generic-parent', 'generic-child', 'continue', { execution: 'foreground' });
  assert.equal(undecided.code, 3); assert.match(undecided.stdout, /needs-choice/);
  await identity.beginCallerTurn({ sessionId: 'generic-parent', turnId: 'generic-answer', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: 'resume' });
  const choice = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'resume'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'generic-child' } });
  assert.equal(choice.code, 0, choice.stderr || choice.stdout); assert.equal(choice.stdout, 'done\n');
  await assert.rejects(createInvocationStore({ dataRoot: ctx.dataRoot }).consumePending({ sessionId: 'generic-parent', workspace: ctx.workspace, command: 'rescue', choice: 'resume', executorAgentId: 'generic-child' }), { code: 'PENDING_INVOCATION_NOT_FOUND' });
  const replay = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'resume'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'generic-child' } });
  assert.notEqual(replay.code, 0); assert.match(replay.stdout, /PENDING_INVOCATION_NOT_FOUND/);
});
test('initial Rescue invocation must match the parent turn captured by SubagentStart', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  await identity.beginCallerTurn({ sessionId: 'turn-parent', turnId: 'captured-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait repair' });
  await prepareRescue(ctx, 'turn-parent', { version: 1, source: 'explicit', task: 'repair', options: { execution: 'foreground', resume: 'fresh' } });
  await startRescueChild(ctx, 'turn-parent', 'turn-child');
  await identity.beginCallerTurn({ sessionId: 'turn-parent', turnId: 'replacement-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait different' });
  const result = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'turn-child' } });
  assert.notEqual(result.code, 0); assert.match(result.stdout, /EXECUTOR_PARENT_TURN_MISMATCH/);
});

test('bound Rescue status sidecar exposes only safe fixed fields and starts no ZCode protocol', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const store = createStateStore({ dataRoot: ctx.dataRoot });
  await identity.beginCallerTurn({ sessionId: 'status-parent', turnId: 'status-parent-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait repair' });
  await startRescueChild(ctx, 'status-parent', 'status-child', 'status-child-turn');
  const reserved = await store.reserveFreshRescueJob({ workspace: ctx.workspace, ownerSessionId: 'status-parent', reservation: { workspace: ctx.workspace, ownerSessionId: 'status-parent', ownerTurnId: 'status-parent-turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } }, executor: { agentId: 'status-child', agentType: 'zcode-rescue', parentSessionId: 'status-parent', parentTurnId: 'status-parent-turn', parentPermissionMode: 'workspace-write', workspace: ctx.workspace } }); const job = reserved.job;
  await startReservedRescueForTest(store, ctx.workspace, job, { startedAt: new Date().toISOString(), zcodeSessionId: 'PRIVATE_SESSION' });
  const observedAt = new Date().toISOString();
  await store.updateJobProgress(ctx.workspace, job.id, { phase: 'running', message: 'ZCode is working with a tool.', observedAt });
  const beforeStatus = await store.readJob(ctx.workspace, job.id);
  const protocolRecord = join(ctx.directory, 'status-protocol.jsonl');

  const result = await runChild(process.execPath, [cli, 'invoke-status', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'status-child', FAKE_ZCODE_RECORD: protocolRecord } });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const status = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(status), ['type', 'status', 'phase', 'lastActivityAt', 'progressPreview', 'terminal']);
  assert.deepEqual(status, { type: 'rescue-status', status: 'running', phase: 'running', lastActivityAt: observedAt, progressPreview: ['ZCode is working with a tool.'], terminal: false });
  assert.doesNotMatch(result.stdout, /job-|session-|workspace|worker|artifact|PRIVATE/i);
  assert.deepEqual(await store.readJob(ctx.workspace, job.id), beforeStatus);
  await assert.rejects(readFile(protocolRecord, 'utf8'), { code: 'ENOENT' });

  const workspaceLink = join(ctx.directory, 'workspace-link');
  await symlink(ctx.workspace, workspaceLink, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await runDirectInvocation(['invoke-status', 'rescue'], {
    cwd: workspaceLink, env: { ...ctx.env, CODEX_THREAD_ID: 'status-child', FAKE_ZCODE_RECORD: protocolRecord },
  }), status);
  await assert.rejects(readFile(protocolRecord, 'utf8'), { code: 'ENOENT' });

  for (const argv of [
    ['invoke-status'], ['invoke-status', 'rescue', '--all'], ['invoke-status', 'rescue', 'job-id'], ['invoke-status', 'review'],
    ['prepare'], ['prepare', 'rescue', '--fresh'], ['prepare', 'review'],
    ['invoke-prepared'], ['invoke-prepared', 'rescue', '--fresh'], ['invoke-prepared', 'review'],
  ]) {
    const rejected = await runChild(process.execPath, [cli, ...argv], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'status-child', FAKE_ZCODE_RECORD: protocolRecord } });
    assert.notEqual(rejected.code, 0, argv.join(' '));
  }
  await assert.rejects(readFile(protocolRecord, 'utf8'), { code: 'ENOENT' });
  const debugNearMiss = await runChild(process.execPath, [cli, 'invoke-status', 'rescue', '--all'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'status-child', ZCODE_DEBUG: '1' } });
  assert.notEqual(debugNearMiss.code, 0);
  assert.match(debugNearMiss.stderr, /PluginError: The direct companion command is invalid\./);
});

test('bound Rescue status maps corrupt durable state to one metadata-free error', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const store = createStateStore({ dataRoot: ctx.dataRoot });
  await identity.beginCallerTurn({ sessionId: 'corrupt-parent', turnId: 'corrupt-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait repair' });
  await startRescueChild(ctx, 'corrupt-parent', 'corrupt-child', 'corrupt-child-turn');
  const job = (await store.reserveFreshRescueJob({ workspace: ctx.workspace, reservation: { workspace: ctx.workspace, ownerSessionId: 'corrupt-parent', ownerTurnId: 'corrupt-turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } }, executor: { agentId: 'corrupt-child', agentType: 'zcode-rescue', parentSessionId: 'corrupt-parent', parentTurnId: 'corrupt-turn', parentPermissionMode: 'workspace-write', workspace: ctx.workspace } })).job;
  const storage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.workspace });
  await writeFile(join(storage.directory, 'jobs', `${job.id}.json`), JSON.stringify({ ...job, workspace: 'PRIVATE_CORRUPT_WORKSPACE' }));
  const protocolRecord = join(ctx.directory, 'corrupt-status-protocol.jsonl');

  const corrupt = await runChild(process.execPath, [cli, 'invoke-status', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'corrupt-child', FAKE_ZCODE_RECORD: protocolRecord, ZCODE_DEBUG: '1' } });
  assert.notEqual(corrupt.code, 0);
  assert.match(corrupt.stdout, /BOUND_RESCUE_STATUS_UNAVAILABLE/);
  assert.doesNotMatch(`${corrupt.stdout}${corrupt.stderr}`, new RegExp(`${job.id}|PRIVATE_CORRUPT_WORKSPACE|${ctx.workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(corrupt.stderr, '');
  assert.doesNotMatch(corrupt.stdout, /\n\s*at |PluginError:|zcode-companion\.mjs:/);
  await assert.rejects(readFile(protocolRecord, 'utf8'), { code: 'ENOENT' });
});

test('bound Rescue status sidecar rejects missing, sibling, stale-turn and ambiguous bindings', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const store = createStateStore({ dataRoot: ctx.dataRoot });
  const missing = await runChild(process.execPath, [cli, 'invoke-status', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'missing-child', ZCODE_DEBUG: '1' } });
  assert.notEqual(missing.code, 0); assert.match(missing.stdout, /EXECUTOR_IDENTITY_NOT_FOUND/);
  assert.equal(missing.stderr, '');
  assert.doesNotMatch(missing.stdout, /\n\s*at |PluginError:|zcode-companion\.mjs:|hooks\/lib\/hook-state/);

  await identity.beginCallerTurn({ sessionId: 'side-parent', turnId: 'bound-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait repair' });
  await startRescueChild(ctx, 'side-parent', 'bound-child', 'bound-child-turn');
  await store.reserveFreshRescueJob({ workspace: ctx.workspace, reservation: { workspace: ctx.workspace, ownerSessionId: 'side-parent', ownerTurnId: 'bound-turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } }, executor: { agentId: 'bound-child', agentType: 'zcode-rescue', parentSessionId: 'side-parent', parentTurnId: 'bound-turn', parentPermissionMode: 'workspace-write', workspace: ctx.workspace } });
  await startRescueChild(ctx, 'side-parent', 'same-turn-sibling', 'same-turn-sibling-turn');
  const sameTurnSibling = await runChild(process.execPath, [cli, 'invoke-status', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'bound-child' } });
  assert.notEqual(sameTurnSibling.code, 0); assert.match(sameTurnSibling.stdout, /EXECUTOR_IDENTITY_AMBIGUOUS/);
  await stopRescueChild(ctx, 'side-parent', 'same-turn-sibling', 'same-turn-sibling-turn');
  await identity.beginCallerTurn({ sessionId: 'side-parent', turnId: 'new-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: 'new turn' });
  const stale = await runChild(process.execPath, [cli, 'invoke-status', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'bound-child' } });
  assert.notEqual(stale.code, 0); assert.match(stale.stdout, /EXECUTOR_PARENT_TURN_MISMATCH/);

  const sibling = await runChild(process.execPath, [cli, 'invoke-status', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'sibling-child' } });
  assert.notEqual(sibling.code, 0); assert.match(sibling.stdout, /EXECUTOR_IDENTITY_NOT_FOUND/);

  await store.reserveJob({ workspace: ctx.workspace, ownerSessionId: 'side-parent', ownerTurnId: 'bound-turn', command: 'rescue', readOnly: true, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await identity.beginCallerTurn({ sessionId: 'side-parent', turnId: 'bound-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait repair' });
  const exact = await runChild(process.execPath, [cli, 'invoke-status', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'bound-child' } });
  assert.equal(exact.code, 0, exact.stderr || exact.stdout);
});
async function stopRescueChild(ctx, parentSessionId, childId, turnId = `${childId}-turn`, agentType = 'zcode-rescue') {
  const result = await runChild(process.execPath, [join(root, 'hooks', 'subagent-hook.mjs')], { cwd: ctx.workspace, env: ctx.env, ordinaryInput: true, input: { session_id: parentSessionId, turn_id: turnId, cwd: ctx.workspace, hook_event_name: 'SubagentStop', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', agent_id: childId, agent_type: agentType, agent_transcript_path: null, stop_hook_active: false, last_assistant_message: null } });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  ctx.stoppedChildren.add(childId);
}

function invoke(ctx, rawArgv, authorization, extraEnv = {}, ordinaryStdio = false) {
  return runChild(process.execPath, [cli, ...rawArgv], {
    cwd: ctx.workspace,
    env: { ...ctx.env, ...extraEnv },
    input: authorization,
    protectedInput: !ordinaryStdio,
  }).then((result) => ({ ...result, json: result.internal ? JSON.parse(result.internal) : null }));
}

function publicInvoke(ctx, rawArgv, caller = ctx.callerA, extraEnv = {}) {
  return invoke(ctx, rawArgv, { callerContext: caller }, extraEnv);
}

test('all eight skill commands preserve argv and execute across the CLI fd boundary', async (t) => {
  const ctx = await fixture(t);
  for (const skill of ['review', 'adversarial-review', 'rescue', 'transfer', 'status', 'result', 'cancel', 'setup']) {
    assert.match(await readFile(join(root, 'skills', skill, 'SKILL.md'), 'utf8'), new RegExp(`\\$zcode:${skill}`));
  }

  const invocations = [];
  const call = async (argv, caller = ctx.callerA, env = {}) => {
    const result = await publicInvoke(ctx, argv, caller, env); invocations.push({ argv, result }); return result;
  };
  const review = await call(['review', '--wait']);
  assert.equal(review.json.job.status, 'succeeded');
  const adversarial = await call(['adversarial-review', '--wait', 'challenge auth'], ctx.callerB);
  assert.equal(adversarial.json.job.status, 'succeeded');
  const rescue = await call(['rescue', '--fresh', '--wait', 'repair the fixture']);
  assert.equal(rescue.json.job.status, 'succeeded');

  const thread = { id: 'codex-a', ephemeral: false, turns: [
    { items: [{ type: 'userMessage', content: [{ type: 'text', text: 'hello' }] }] },
    { items: [{ type: 'agentMessage', text: 'hi' }] },
  ] };
  const transfer = await call(['transfer'], ctx.callerA, {
    CODEX_APP_SERVER_PATH: process.execPath,
    CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([fakeCodex]),
    FAKE_CODEX_THREAD_JSON: JSON.stringify(thread),
  });
  assert.equal(transfer.json.job.status, 'succeeded');
  assert.equal(transfer.json.job.codexThreadId, 'codex-a');

  const status = await call(['status', rescue.json.job.id]);
  assert.equal(status.json.job.id, rescue.json.job.id);
  const result = await call(['result', rescue.json.job.id]);
  assert.equal(result.json.result, 'done');
  const queued = await call(['rescue', '--fresh', '--background', 'cancel this']);
  const cancelled = await call(['cancel', queued.json.job.id]);
  assert.equal(cancelled.json.job.status, 'cancelled');

  const setupArgv = ['setup'];
  const setupConfig = { config: { sandbox_workspace_write: { writable_roots: [ctx.dataRoot] } }, origins: {}, layers: [{ name: { type: 'user', file: join(ctx.dataRoot, 'config.toml') }, version: 'version-1', config: { sandbox_workspace_write: { writable_roots: [ctx.dataRoot] } } }] };
  const lifecycle = await runChild(process.execPath, [join(root, 'hooks', 'session-lifecycle-hook.mjs')], {
    cwd: ctx.workspace, env: ctx.env, ordinaryInput: true,
    input: { session_id: 'codex-setup', cwd: ctx.workspace, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', source: 'startup' },
  });
  assert.equal(lifecycle.code, 0, lifecycle.stderr || lifecycle.stdout);
  const prompt = await runChild(process.execPath, [join(root, 'hooks', 'user-prompt-hook.mjs')], {
    cwd: ctx.workspace, env: ctx.env, ordinaryInput: true,
    input: { session_id: 'codex-setup', turn_id: 'turn-setup', cwd: ctx.workspace, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', prompt: '$zcode:setup' },
  });
  assert.equal(prompt.code, 0, prompt.stderr || prompt.stdout);
  const setup = await invoke(ctx, setupArgv, undefined, {
    FAKE_ZCODE_VERSION: '0.1.0',
    CODEX_APP_SERVER_PATH: process.execPath,
    CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([fakeCodex]),
    FAKE_CODEX_CONFIG_RESULT: JSON.stringify(setupConfig),
  }, true);
  assert.equal(setup.code, 0, setup.stderr || setup.stdout);
  assert.match(setup.stdout, /outdated/);
  invocations.push({ argv: setupArgv, result: setup });

  assert.deepEqual(invocations.map(({ result: value }) => value.spawnargs),
    invocations.map(({ argv }) => [process.execPath, cli, ...argv]));
  const secret = ctx.callerA;
  for (const { result: value } of invocations) {
    assert.doesNotMatch(`${value.stdout}${value.stderr}${value.spawnargs.join(' ')}`, new RegExp(secret));
  }
});

test('background private child receives only its one-use execution envelope', async (t) => {
  const ctx = await fixture(t);
  const reserved = await publicInvoke(ctx, ['review', '--background']);
  assert.equal(reserved.code, 0, reserved.stderr);
  assert.equal(reserved.json.type, 'background');
  assert.deepEqual(reserved.json.privateInvocation, ['run-reserved-job', reserved.json.job.id]);
  assert.doesNotMatch(`${reserved.stdout}${reserved.stderr}${reserved.spawnargs.join(' ')}`, new RegExp(reserved.json.executionCapability));
  assert.doesNotMatch(JSON.stringify(reserved.json.job), new RegExp(reserved.json.executionCapability));

  const authorization = { executionCapability: reserved.json.executionCapability, jobId: reserved.json.job.id };
  const first = await invoke(ctx, reserved.json.privateInvocation, authorization);
  assert.deepEqual(first.spawnargs, [process.execPath, cli, ...reserved.json.privateInvocation]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.json.job.status, 'succeeded');
  assert.doesNotMatch(`${first.stdout}${first.stderr}${first.spawnargs.join(' ')}`, new RegExp(ctx.callerA));
  assert.doesNotMatch(`${first.stdout}${first.stderr}${first.spawnargs.join(' ')}`, new RegExp(authorization.executionCapability));

  const replay = await invoke(ctx, reserved.json.privateInvocation, authorization);
  assert.notEqual(replay.code, 0);
  assert.equal(replay.json.error.code, 'EXECUTION_CAPABILITY_CONSUMED');
});

test('installed-style invoke uses ordinary stdio, ambient thread identity, and literal recorded prompt text', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.env.PLUGIN_DATA });
  const marker = join(ctx.workspace, 'escaped'); const record = join(ctx.workspace, 'direct-record.jsonl');
  await identity.beginCallerTurn({ sessionId: 'codex-a', turnId: 'direct-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait repair $(touch escaped) literally' });
  await startRescueChild(ctx, 'codex-a', 'direct-child');
  const result = await invokePreparedRescue(ctx, 'codex-a', 'direct-child', 'repair $(touch escaped) literally', { execution: 'foreground', resume: 'fresh' }, { ...ctx.env, FAKE_ZCODE_RECORD: record });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, 'done\n');
  await assert.rejects(readFile(marker, 'utf8'), { code: 'ENOENT' });
  const sent = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).find((frame) => frame.method === 'session/send');
  assert.match(sent.params.content, /repair \$\(touch escaped\) literally/);
  assert.equal(result.internal, '');

  const envWithoutThread = { ...ctx.env };
  delete envWithoutThread.CODEX_THREAD_ID;
  const missing = await runChild(process.execPath, [cli, 'invoke', 'status'], { cwd: ctx.workspace, env: envWithoutThread });
  assert.notEqual(missing.code, 0); assert.match(missing.stdout, /THREAD_ID_REQUIRED/);
  const sibling = await runChild(process.execPath, [cli, 'invoke', 'status'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'codex-bogus' } });
  assert.notEqual(sibling.code, 0); assert.match(sibling.stdout, /ACTIVE_TURN_NOT_FOUND/);
});

test('direct job commands resolve a bound lifecycle to its execution workspace from origin or target', async (t) => {
  const ctx = await fixture(t);
  const execution = join(ctx.directory, 'execution-worktree');
  await run('git', ['worktree', 'add', '-q', '-b', 'effective-jobs', execution], ctx.workspace);
  const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  const store = createStateStore({ dataRoot: ctx.dataRoot });
  const sessionId = 'effective-owner';
  const sessionStartedAt = new Date().toISOString();
  await identity.beginCallerTurn({
    sessionId, turnId: 'effective-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:status --all',
    sessionStartedAt, sessionSource: 'startup',
  });
  await identity.resolveActiveTurn({ sessionId, workspace: execution, workspaceBinding: 'claim' });
  const target = await store.reserveJob({ workspace: execution, ownerSessionId: sessionId, ownerTurnId: 'effective-turn', command: 'review', readOnly: true, permissionSnapshot: { permissionMode: 'workspace-write' } });
  const decoy = await store.reserveJob({ workspace: ctx.workspace, ownerSessionId: sessionId, ownerTurnId: 'effective-turn', command: 'review', readOnly: true, permissionSnapshot: { permissionMode: 'workspace-write' } });
  const foreign = await store.reserveJob({ workspace: execution, ownerSessionId: 'effective-foreign', ownerTurnId: 'effective-foreign-turn', command: 'review', readOnly: true, permissionSnapshot: { permissionMode: 'workspace-write' } });
  const logFile = await createJobLog({ dataRoot: ctx.dataRoot, workspace: execution, jobId: target.id, title: 'target-only log' });
  await store.attachJobLog(execution, target.id, logFile);
  const artifact = await writeResultArtifact({ dataRoot: ctx.dataRoot, workspace: execution, jobId: target.id, contents: 'target-only result' });
  await store.transitionJob(execution, target.id, ['queued'], 'running', { startedAt: new Date().toISOString(), zcodeSessionId: 'effective-result-session' });
  await store.finishJob(execution, target.id, ['running'], 'succeeded', { resultArtifact: artifact, exitCode: 0 });
  await writeWorkspaceModelConfig({ dataRoot: ctx.dataRoot, workspace: execution, config: { version: 1, defaultModel: 'target-model', models: {} } });
  await writeWorkspaceModelConfig({ dataRoot: ctx.dataRoot, workspace: ctx.workspace, config: { version: 1, defaultModel: 'origin-decoy-model', models: {} } });
  const env = { ...ctx.env, CODEX_THREAD_ID: sessionId };
  for (const cwd of [ctx.workspace, execution]) {
    const output = await runDirectInvocation(['invoke', 'status'], { cwd, env });
    assert.deepEqual(output.jobs.map((job) => job.id), [target.id, foreign.id]);
    assert.ok(output.jobs.every((job) => job.id !== decoy.id));
    assert.deepEqual(output.modelPolicy, { configured: true, defaultModel: 'target-model', aliases: [] });
  }

  const activate = async (prompt, turnId) => {
    await identity.beginCallerTurn({
      sessionId, turnId, workspace: ctx.workspace, permissionMode: 'workspace-write', prompt,
      sessionStartedAt, sessionSource: 'startup',
    });
    await identity.resolveActiveTurn({ sessionId, workspace: execution, workspaceBinding: 'claim' });
  };
  await activate(`$zcode:status ${target.id}`, 'effective-status-detail');
  const detail = await runDirectInvocation(['invoke', 'status'], { cwd: ctx.workspace, env });
  assert.equal(detail.job.id, target.id);
  assert.equal(detail.job.logFile, logFile);
  assert.deepEqual(detail.modelPolicy, { configured: true, defaultModel: 'target-model', aliases: [] });

  await activate('$zcode:status', 'effective-status-latest');
  const latest = await runDirectInvocation(['invoke', 'status'], { cwd: execution, env });
  assert.equal(latest.job.id, target.id);

  await activate('inspect the current job without an explicit command marker', 'effective-status-implicit');
  const implicitLatest = await runDirectInvocation(['invoke', 'status'], { cwd: ctx.workspace, env });
  assert.equal(implicitLatest.job.id, target.id);

  await activate(`$zcode:result ${target.id}`, 'effective-result-explicit');
  const result = await runDirectInvocation(['invoke', 'result'], { cwd: ctx.workspace, env });
  assert.equal(result.job.id, target.id);
  assert.equal(result.result, 'target-only result');

  await activate('$zcode:result', 'effective-result-latest');
  const latestResult = await runDirectInvocation(['invoke', 'result'], { cwd: execution, env });
  assert.equal(latestResult.job.id, target.id);
  assert.equal(latestResult.result, 'target-only result');

  for (const [jobId, code] of [[foreign.id, 'OWNED_JOB_NOT_FOUND'], [decoy.id, 'OWNED_JOB_NOT_FOUND']]) {
    await activate(`$zcode:result ${jobId}`, `effective-result-rejected-${jobId.slice(0, 8)}`);
    await assert.rejects(runDirectInvocation(['invoke', 'result'], { cwd: execution, env }), { code });
  }

  const sibling = join(ctx.directory, 'effective-sibling');
  await run('git', ['worktree', 'add', '-q', '-b', 'effective-sibling', sibling], ctx.workspace);
  const unrelatedPath = join(ctx.directory, 'effective-unrelated');
  await mkdir(unrelatedPath);
  const unrelated = await realpath(unrelatedPath);
  await activate('$zcode:status --all', 'effective-boundary');
  for (const cwd of [sibling, unrelated]) {
    await assert.rejects(runDirectInvocation(['invoke', 'status'], { cwd, env }), { code: 'ACTIVE_TURN_WORKSPACE_INELIGIBLE' });
  }
});

test('real prompt replacement preserves only private job observation routing for direct commands', async (t) => {
  for (const command of ['status', 'result', 'cancel']) await t.test(command, async () => {
    const ctx = await fixture(t);
    const execution = join(ctx.directory, `hook-recovery-${command}`);
    await run('git', ['worktree', 'add', '-q', '-b', `hook-recovery-${command}`, execution], ctx.workspace);
    const canonicalExecution = await realpath(execution);
    const sessionId = `hook-recovery-${command}-owner`;
    const lifecycle = await runChild(process.execPath, [join(root, 'hooks', 'session-lifecycle-hook.mjs')], {
      cwd: ctx.workspace, env: ctx.env, ordinaryInput: true,
      input: { session_id: sessionId, cwd: ctx.workspace, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', source: 'startup' },
    });
    assert.equal(lifecycle.code, 0, lifecycle.stderr || lifecycle.stdout);
    const submit = (turnId, prompt) => runChild(process.execPath, [join(root, 'hooks', 'user-prompt-hook.mjs')], {
      cwd: ctx.workspace, env: ctx.env, ordinaryInput: true,
      input: { session_id: sessionId, turn_id: turnId, cwd: ctx.workspace, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', prompt },
    });
    const first = await submit('hook-recovery-first-turn', '$zcode:rescue --fresh establish target');
    assert.equal(first.code, 0, first.stderr || first.stdout);

    const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
    const store = createStateStore({ dataRoot: ctx.dataRoot });
    await identity.resolveActiveTurn({ sessionId, workspace: canonicalExecution, workspaceBinding: 'claim' });
    const target = await store.reserveJob({ workspace: canonicalExecution, ownerSessionId: sessionId, ownerTurnId: 'hook-recovery-first-turn', command: 'review', readOnly: true, permissionSnapshot: { permissionMode: 'acceptEdits' } });
    const decoy = await store.reserveJob({ workspace: ctx.workspace, ownerSessionId: sessionId, ownerTurnId: 'hook-recovery-first-turn', command: 'review', readOnly: true, permissionSnapshot: { permissionMode: 'acceptEdits' } });
    if (command === 'result') {
      const artifact = await writeResultArtifact({ dataRoot: ctx.dataRoot, workspace: canonicalExecution, jobId: target.id, contents: 'hook-recovered-result' });
      await store.transitionJob(canonicalExecution, target.id, ['queued'], 'running', { startedAt: new Date().toISOString(), zcodeSessionId: 'hook-recovery-result-session' });
      await store.finishJob(canonicalExecution, target.id, ['running'], 'succeeded', { resultArtifact: artifact, exitCode: 0 });
    }
    const prompt = command === 'status' ? '$zcode:status --all' : `$zcode:${command} ${target.id}`;
    const second = await submit('hook-recovery-second-turn', prompt);
    assert.equal(second.code, 0, second.stderr || second.stdout);
    const preview = await identity.resolveActiveTurn({ sessionId, workspace: ctx.workspace, workspaceBinding: 'preview' });
    assert.equal(preview.executionWorkspace, null);
    await assert.rejects(identity.resolveActiveTurn({ sessionId, workspace: ctx.workspace, workspaceBinding: 'execution' }),
      { code: 'ACTIVE_TURN_WORKSPACE_INELIGIBLE' });

    const output = await runDirectInvocation(['invoke', command], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: sessionId } });
    if (command === 'status') {
      assert.deepEqual(output.jobs.map((job) => job.id), [target.id]);
      assert.ok(output.jobs.every((job) => job.id !== decoy.id));
    } else if (command === 'result') {
      assert.equal(output.job.id, target.id);
      assert.equal(output.result, 'hook-recovered-result');
    } else {
      assert.equal(output.job.id, target.id);
      assert.equal(output.job.status, 'cancelled');
      assert.equal((await store.readJob(ctx.workspace, decoy.id)).status, 'queued');
    }
  });
});

test('direct running cancel stops and closes the bound Rescue only in its execution workspace', async (t) => {
  const ctx = await fixture(t);
  const execution = join(ctx.directory, 'cancel-execution-worktree');
  await run('git', ['worktree', 'add', '-q', '-b', 'effective-cancel', execution], ctx.workspace);
  const canonicalExecution = await realpath(execution);
  const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  const store = createStateStore({ dataRoot: ctx.dataRoot });
  const sessionId = 'effective-cancel-owner';
  const sessionStartedAt = new Date().toISOString();
  await identity.beginCallerTurn({
    sessionId, turnId: 'effective-cancel-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:cancel',
    sessionStartedAt, sessionSource: 'startup',
  });
  await identity.resolveActiveTurn({ sessionId, workspace: canonicalExecution, workspaceBinding: 'claim' });
  const reservation = {
    workspace: canonicalExecution, ownerSessionId: sessionId, ownerTurnId: 'effective-cancel-turn', command: 'rescue', readOnly: false,
    permissionSnapshot: { permissionMode: 'workspace-write' },
  };
  const executor = {
    agentId: 'effective-cancel-child', agentType: 'zcode-rescue', parentSessionId: sessionId,
    parentTurnId: 'effective-cancel-turn', parentPermissionMode: 'workspace-write', workspace: canonicalExecution,
  };
  const running = (await store.reserveFreshRescueJob({ workspace: canonicalExecution, reservation, executor })).job;
  await startReservedRescueForTest(store, canonicalExecution, running, { startedAt: new Date().toISOString(), zcodeSessionId: 'effective-cancel-session' });
  const clients = [];
  const persisted = await store.readJob(canonicalExecution, running.id);
  const output = await withWorkerLease({ dataRoot: ctx.dataRoot, workspace: canonicalExecution, jobId: running.id, workerLeaseId: persisted.workerLeaseId }, () =>
    runDirectInvocation(['invoke', 'cancel'], {
      cwd: ctx.workspace,
      env: { ...ctx.env, CODEX_THREAD_ID: sessionId },
      dependencies: {
        createManagedZCodeClient: async (options) => {
          clients.push(options);
          return {
            stopSession: async (zcodeSessionId) => assert.equal(zcodeSessionId, 'effective-cancel-session'),
            close: async () => {},
          };
        },
      },
    }));
  assert.equal(output.job.status, 'cancelled');
  assert.equal(clients.length, 1);
  assert.equal(clients[0].workspace, canonicalExecution);
  await assert.rejects(
    store.resolveRescueBinding({ workspace: canonicalExecution, parentSessionId: sessionId, executorAgentId: 'effective-cancel-child' }),
    { code: 'RESCUE_BINDING_CLOSED' },
  );
  assert.equal((await store.listJobs(ctx.workspace)).length, 0);

  await identity.beginCallerTurn({
    sessionId, turnId: 'effective-queued-cancel-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:cancel',
    sessionStartedAt, sessionSource: 'startup',
  });
  await identity.resolveActiveTurn({ sessionId, workspace: canonicalExecution, workspaceBinding: 'claim' });
  const queuedExecutor = { ...executor, agentId: 'effective-queued-cancel-child', parentTurnId: 'effective-queued-cancel-turn' };
  const queuedReservation = { ...reservation, ownerTurnId: 'effective-queued-cancel-turn' };
  const queued = (await store.reserveFreshRescueJob({ workspace: canonicalExecution, reservation: queuedReservation, executor: queuedExecutor })).job;
  await identity.beginCallerTurn({
    sessionId, turnId: 'effective-queued-cancel-explicit-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: `$zcode:cancel ${queued.id}`,
    sessionStartedAt, sessionSource: 'startup',
  });
  await identity.resolveActiveTurn({ sessionId, workspace: canonicalExecution, workspaceBinding: 'claim' });
  const queuedOutput = await runDirectInvocation(['invoke', 'cancel'], { cwd: canonicalExecution, env: { ...ctx.env, CODEX_THREAD_ID: sessionId } });
  assert.equal(queuedOutput.job.id, queued.id);
  assert.equal(queuedOutput.job.status, 'cancelled');
  await assert.rejects(
    store.resolveRescueBinding({ workspace: canonicalExecution, parentSessionId: sessionId, executorAgentId: queuedExecutor.agentId }),
    { code: 'RESCUE_BINDING_CLOSED' },
  );
});

test('effective observer mode stays narrow while exact-target creators respect current execution authority', async (t) => {
  const ctx = await fixture(t);
  const execution = join(ctx.directory, 'scope-execution-worktree');
  await run('git', ['worktree', 'add', '-q', '-b', 'effective-scope', execution], ctx.workspace);
  const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  const store = createStateStore({ dataRoot: ctx.dataRoot });
  const sessionStartedAt = new Date().toISOString();
  await identity.beginCallerTurn({
    sessionId: 'effective-unbound', turnId: 'effective-unbound-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:status --all',
    sessionStartedAt, sessionSource: 'startup',
  });
  const unbound = await store.reserveJob({ workspace: ctx.workspace, ownerSessionId: 'effective-unbound', ownerTurnId: 'effective-unbound-turn', command: 'review', readOnly: true, permissionSnapshot: { permissionMode: 'workspace-write' } });
  const unboundOutput = await runDirectInvocation(['invoke', 'status'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'effective-unbound' } });
  assert.deepEqual(unboundOutput.jobs.map((job) => job.id), [unbound.id]);
  await assert.rejects(runDirectInvocation(['invoke', 'status'], { cwd: execution, env: { ...ctx.env, CODEX_THREAD_ID: 'effective-unbound' } }), { code: 'ACTIVE_TURN_WORKSPACE_INELIGIBLE' });

  for (const command of ['review', 'adversarial-review', 'transfer']) {
    const prompt = command === 'review' ? '$zcode:review --background'
      : command === 'adversarial-review' ? '$zcode:adversarial-review --background focus'
        : '$zcode:transfer --source exact-target-source';
    await identity.beginCallerTurn({
      sessionId: 'effective-scope-owner', turnId: `effective-scope-${command}`, workspace: ctx.workspace, permissionMode: 'workspace-write', prompt,
      sessionStartedAt, sessionSource: 'startup',
    });
    await identity.resolveActiveTurn({ sessionId: 'effective-scope-owner', workspace: execution, workspaceBinding: 'claim' });
    const dependencies = command === 'transfer' ? {
      readCodexThread: async () => ({ id: 'exact-target-source', ephemeral: false, turns: [{ startedAt: 1, items: [{ type: 'userMessage', content: [{ type: 'text', text: 'source' }] }] }] }),
      createManagedZCodeClient: async () => ({ createSession: async () => ({ session: { sessionId: 'exact-target-session' } }), close: async () => {} }),
    } : { startBackgroundWorker: async () => {} };
    const created = await runDirectInvocation(['invoke', command], {
      cwd: execution, env: { ...ctx.env, CODEX_THREAD_ID: 'effective-scope-owner' }, dependencies,
    });
    assert.equal(created.job.workspace, await realpath(execution));
  }
});

test('an origin job creator replaces a recovered Rescue target as the authoritative observation partition', async (t) => {
  for (const command of ['review', 'adversarial-review', 'transfer']) await t.test(command, async () => {
    const ctx = await fixture(t); const targetPath = join(ctx.directory, `creator-${command}-target`);
    await run('git', ['worktree', 'add', '-q', '-b', `creator-${command}-target`, targetPath], ctx.workspace);
    const target = await realpath(targetPath); const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
    const store = createStateStore({ dataRoot: ctx.dataRoot }); const sessionId = `creator-${command}-owner`;
    const proof = { sessionStartedAt: new Date().toISOString(), sessionSource: 'startup' };
    await identity.beginCallerTurn({
      sessionId, turnId: 'rescue-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: 'rescue', ...proof,
    });
    await identity.resolveActiveTurn({ sessionId, workspace: target, workspaceBinding: 'claim' });
    const oldTarget = await store.reserveJob({
      workspace: target, ownerSessionId: sessionId, ownerTurnId: 'rescue-turn', command: 'rescue', readOnly: true,
      permissionSnapshot: { permissionMode: 'workspace-write' },
    });
    const prompt = command === 'review' ? '$zcode:review --background'
      : command === 'adversarial-review' ? '$zcode:adversarial-review --background partition focus'
        : '$zcode:transfer --source transfer-source';
    await identity.beginCallerTurn({
      sessionId, turnId: `${command}-turn`, workspace: ctx.workspace, permissionMode: 'workspace-write', prompt, ...proof,
    });
    const dependencies = command === 'transfer' ? {
      readCodexThread: async () => ({ id: 'transfer-source', ephemeral: false, turns: [{ startedAt: 1, items: [{ type: 'userMessage', content: [{ type: 'text', text: 'source' }] }] }] }),
      createManagedZCodeClient: async () => ({ createSession: async () => ({ session: { sessionId: 'transferred-zcode-session' } }), close: async () => {} }),
    } : { startBackgroundWorker: async () => {} };
    const created = await runDirectInvocation(['invoke', command], {
      cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: sessionId }, dependencies,
    });
    assert.equal(created.job.workspace, ctx.workspace);

    await identity.beginCallerTurn({
      sessionId, turnId: `${command}-status-turn`, workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:status --all', ...proof,
    });
    const observed = await runDirectInvocation(['invoke', 'status'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: sessionId } });
    assert.ok(observed.jobs.some((job) => job.id === created.job.id));
    assert.ok(observed.jobs.every((job) => job.id !== oldTarget.id));
    assert.equal((await store.readJob(target, oldTarget.id)).workspace, target);

    const resultJob = await store.reserveJob({
      workspace: ctx.workspace, ownerSessionId: sessionId, ownerTurnId: `${command}-status-turn`, command: 'review', readOnly: true,
      permissionSnapshot: { permissionMode: 'workspace-write' },
    });
    const artifact = await writeResultArtifact({ dataRoot: ctx.dataRoot, workspace: ctx.workspace, jobId: resultJob.id, contents: `${command}-origin-result` });
    await store.transitionJob(ctx.workspace, resultJob.id, ['queued'], 'running', { startedAt: new Date().toISOString(), zcodeSessionId: `${command}-result-session` });
    await store.finishJob(ctx.workspace, resultJob.id, ['running'], 'succeeded', { resultArtifact: artifact, exitCode: 0 });
    await identity.beginCallerTurn({
      sessionId, turnId: `${command}-result-turn`, workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: `$zcode:result ${resultJob.id}`, ...proof,
    });
    const result = await runDirectInvocation(['invoke', 'result'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: sessionId } });
    assert.equal(result.job.id, resultJob.id); assert.equal(result.result, `${command}-origin-result`);
    await identity.beginCallerTurn({
      sessionId, turnId: `${command}-partition-confined-turn`, workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: `$zcode:result ${oldTarget.id}`, ...proof,
    });
    await assert.rejects(runDirectInvocation(['invoke', 'result'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: sessionId } }), { code: 'OWNED_JOB_NOT_FOUND' });

    const cancelJob = await store.reserveJob({
      workspace: ctx.workspace, ownerSessionId: sessionId, ownerTurnId: `${command}-result-turn`, command: 'review', readOnly: true,
      permissionSnapshot: { permissionMode: 'workspace-write' },
    });
    await identity.beginCallerTurn({
      sessionId, turnId: `${command}-cancel-turn`, workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: `$zcode:cancel ${cancelJob.id}`, ...proof,
    });
    const cancelled = await runDirectInvocation(['invoke', 'cancel'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: sessionId } });
    assert.equal(cancelled.job.id, cancelJob.id); assert.equal(cancelled.job.status, 'cancelled');
    assert.equal((await store.readJob(target, oldTarget.id)).status, 'queued');
  });
});

test('pending review choice persists and consumes from the newly selected origin partition', async (t) => {
  const ctx = await fixture(t); const targetPath = join(ctx.directory, 'pending-partition-target');
  await run('git', ['worktree', 'add', '-q', '-b', 'pending-partition-target', targetPath], ctx.workspace);
  const target = await realpath(targetPath); const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  const sessionId = 'pending-partition-owner'; const proof = { sessionStartedAt: new Date().toISOString(), sessionSource: 'startup' };
  await identity.beginCallerTurn({ sessionId, turnId: 'rescue-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: 'rescue', ...proof });
  await identity.resolveActiveTurn({ sessionId, workspace: target, workspaceBinding: 'claim' });
  await identity.beginCallerTurn({ sessionId, turnId: 'review-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:review', ...proof });
  assert.deepEqual(await runDirectInvocation(['invoke', 'review'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: sessionId } }), {
    type: 'needs-choice', choices: ['wait', 'background'],
  });
  const originStorage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.workspace });
  const targetStorage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: target });
  assert.equal((await readdir(join(originStorage.directory, 'invocations', 'pending'))).length, 1);
  await assert.rejects(readdir(join(targetStorage.directory, 'invocations', 'pending')), { code: 'ENOENT' });
  const completed = await runDirectInvocation(['invoke-choice', 'review', 'wait'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: sessionId } });
  assert.equal(completed.job.workspace, ctx.workspace);
  assert.equal((await readdir(join(originStorage.directory, 'invocations', 'pending'))).length, 0);
});

test('a delayed older direct creator cannot retarget a newer prompt or reserve a job', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  const sessionId = 'delayed-selection-owner'; const proof = { sessionStartedAt: new Date().toISOString(), sessionSource: 'startup' };
  await identity.beginCallerTurn({ sessionId, turnId: 'old-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:review --background', ...proof });
  let markReached; let continueSelection;
  const reached = new Promise((resolve) => { markReached = resolve; });
  const release = new Promise((resolve) => { continueSelection = resolve; });
  const delayed = runDirectInvocation(['invoke', 'review'], {
    cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: sessionId },
    dependencies: { testOnlyBeforeJobWorkspaceSelection: async () => { markReached(); await release; }, startBackgroundWorker: async () => {} },
  });
  await reached;
  await identity.beginCallerTurn({ sessionId, turnId: 'new-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:status --all', ...proof });
  continueSelection();
  await assert.rejects(delayed, { code: 'ACTIVE_TURN_NOT_FOUND' });
  assert.deepEqual(await createStateStore({ dataRoot: ctx.dataRoot }).listJobs(ctx.workspace), []);
});

test('a creator replaced after workspace selection cannot reserve in the stale partition', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  const sessionId = 'post-selection-reservation-owner'; const proof = { sessionStartedAt: new Date().toISOString(), sessionSource: 'startup' };
  await identity.beginCallerTurn({ sessionId, turnId: 'old-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:review --background', ...proof });
  let markReached; let continueReservation;
  const reached = new Promise((resolve) => { markReached = resolve; });
  const release = new Promise((resolve) => { continueReservation = resolve; });
  const delayed = runDirectInvocation(['invoke', 'review'], {
    cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: sessionId },
    dependencies: { testOnlyBeforeJobReservation: async () => { markReached(); await release; }, startBackgroundWorker: async () => {} },
  });
  await reached;
  await identity.beginCallerTurn({ sessionId, turnId: 'new-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:status --all', ...proof });
  continueReservation();
  await assert.rejects(delayed, { code: 'ACTIVE_TURN_NOT_FOUND' });
  assert.deepEqual(await createStateStore({ dataRoot: ctx.dataRoot }).listJobs(ctx.workspace), []);
});

test('a pending choice replaced after workspace selection cannot persist in the stale partition', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  const sessionId = 'post-selection-pending-owner'; const proof = { sessionStartedAt: new Date().toISOString(), sessionSource: 'startup' };
  await identity.beginCallerTurn({ sessionId, turnId: 'old-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:review', ...proof });
  let markReached; let continuePending;
  const reached = new Promise((resolve) => { markReached = resolve; });
  const release = new Promise((resolve) => { continuePending = resolve; });
  const delayed = runDirectInvocation(['invoke', 'review'], {
    cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: sessionId },
    dependencies: { testOnlyBeforePendingInvocationWrite: async () => { markReached(); await release; } },
  });
  await reached;
  await identity.beginCallerTurn({ sessionId, turnId: 'new-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:status --all', ...proof });
  continuePending();
  await assert.rejects(delayed, { code: 'ACTIVE_TURN_NOT_FOUND' });
  const storage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.workspace });
  await assert.rejects(readdir(join(storage.directory, 'invocations', 'pending')), { code: 'ENOENT' });
});

test('a choice replaced after workspace selection cannot consume pending or reserve in the stale partition', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  const sessionId = 'post-selection-consume-owner'; const proof = { sessionStartedAt: new Date().toISOString(), sessionSource: 'startup' };
  await identity.beginCallerTurn({ sessionId, turnId: 'choice-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:review', ...proof });
  assert.equal((await runDirectInvocation(['invoke', 'review'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: sessionId } })).type, 'needs-choice');
  let markReached; let continueConsume;
  const reached = new Promise((resolve) => { markReached = resolve; });
  const release = new Promise((resolve) => { continueConsume = resolve; });
  const delayed = runDirectInvocation(['invoke-choice', 'review', 'wait'], {
    cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: sessionId },
    dependencies: { testOnlyBeforePendingInvocationConsume: async () => { markReached(); await release; } },
  });
  await reached;
  await identity.beginCallerTurn({ sessionId, turnId: 'new-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:status --all', ...proof });
  continueConsume();
  await assert.rejects(delayed, { code: 'ACTIVE_TURN_NOT_FOUND' });
  const storage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.workspace });
  assert.equal((await readdir(join(storage.directory, 'invocations', 'pending'))).length, 1);
  assert.deepEqual(await createStateStore({ dataRoot: ctx.dataRoot }).listJobs(ctx.workspace), []);
});

test('a choice replaced after pending consumption cannot reserve in the stale partition', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  const sessionId = 'post-consume-reservation-owner'; const proof = { sessionStartedAt: new Date().toISOString(), sessionSource: 'startup' };
  await identity.beginCallerTurn({ sessionId, turnId: 'choice-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:review', ...proof });
  assert.equal((await runDirectInvocation(['invoke', 'review'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: sessionId } })).type, 'needs-choice');
  let markReached; let continueReservation;
  const reached = new Promise((resolve) => { markReached = resolve; });
  const release = new Promise((resolve) => { continueReservation = resolve; });
  const delayed = runDirectInvocation(['invoke-choice', 'review', 'wait'], {
    cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: sessionId },
    dependencies: { testOnlyBeforeJobReservation: async () => { markReached(); await release; } },
  });
  await reached;
  await identity.beginCallerTurn({ sessionId, turnId: 'new-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:status --all', ...proof });
  continueReservation();
  await assert.rejects(delayed, { code: 'ACTIVE_TURN_NOT_FOUND' });
  assert.deepEqual(await createStateStore({ dataRoot: ctx.dataRoot }).listJobs(ctx.workspace), []);
});

test('a later-turn choice fences with current authority while preserving the pending owner turn', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  const sessionId = 'later-choice-authority-owner'; const proof = { sessionStartedAt: new Date().toISOString(), sessionSource: 'startup' };
  await identity.beginCallerTurn({ sessionId, turnId: 'pending-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:review', ...proof });
  assert.equal((await runDirectInvocation(['invoke', 'review'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: sessionId } })).type, 'needs-choice');
  await identity.beginCallerTurn({ sessionId, turnId: 'choice-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: 'wait', ...proof });
  const completed = await runDirectInvocation(['invoke-choice', 'review', 'wait'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: sessionId } });
  assert.equal(completed.job.ownerTurnId, 'pending-turn');
});

test('job creator selection fails before reservation and reservation failure preserves the selected pointer', async (t) => {
  const ctx = await fixture(t); const targetPath = join(ctx.directory, 'selection-failure-target'); const unknownPath = join(ctx.directory, 'selection-failure-unknown');
  await run('git', ['worktree', 'add', '-q', '-b', 'selection-failure-target', targetPath], ctx.workspace);
  await run('git', ['worktree', 'add', '-q', '-b', 'selection-failure-unknown', unknownPath], ctx.workspace);
  const target = await realpath(targetPath); const unknown = await realpath(unknownPath); const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  const sessionId = 'selection-failure-owner'; const proof = { sessionStartedAt: new Date().toISOString(), sessionSource: 'startup' };
  await identity.beginCallerTurn({ sessionId, turnId: 'rescue-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: 'rescue', ...proof });
  await identity.resolveActiveTurn({ sessionId, workspace: target, workspaceBinding: 'claim' });
  await identity.beginCallerTurn({ sessionId, turnId: 'unknown-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:review --background', ...proof });
  await assert.rejects(runDirectInvocation(['invoke', 'review'], {
    cwd: unknown, env: { ...ctx.env, CODEX_THREAD_ID: sessionId }, dependencies: { startBackgroundWorker: async () => {} },
  }), { code: 'ACTIVE_TURN_WORKSPACE_INELIGIBLE' });
  assert.deepEqual(await createStateStore({ dataRoot: ctx.dataRoot }).listJobs(unknown), []);

  const actualStore = createStateStore({ dataRoot: ctx.dataRoot });
  await assert.rejects(runDirectInvocation(['invoke', 'review'], {
    cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: sessionId }, dependencies: {
      createStateStore: () => ({ ...actualStore, reserveJob: async () => { throw new PluginError('INJECTED_RESERVATION_FAILURE', 'injected reservation failure'); } }),
    },
  }), { code: 'INJECTED_RESERVATION_FAILURE' });
  assert.equal((await identity.resolveActiveTurn({ sessionId, workspace: ctx.workspace, workspaceBinding: 'effective' })).workspace, ctx.workspace);
  assert.deepEqual(await actualStore.listJobs(ctx.workspace), []);
});

test('same-turn Rescue execution authority rejects a conflicting origin job creator before reservation', async (t) => {
  const ctx = await fixture(t); const targetPath = join(ctx.directory, 'same-turn-conflict-target');
  await run('git', ['worktree', 'add', '-q', '-b', 'same-turn-conflict-target', targetPath], ctx.workspace);
  const target = await realpath(targetPath); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const sessionId = 'same-turn-conflict-owner';
  await identity.beginCallerTurn({
    sessionId, turnId: 'claimed-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:review --background',
    sessionStartedAt: new Date().toISOString(), sessionSource: 'startup',
  });
  await identity.resolveActiveTurn({ sessionId, workspace: target, workspaceBinding: 'claim' });
  await assert.rejects(runDirectInvocation(['invoke', 'review'], {
    cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: sessionId }, dependencies: { startBackgroundWorker: async () => {} },
  }), { code: 'ACTIVE_TURN_WORKSPACE_INELIGIBLE' });
  assert.deepEqual(await createStateStore({ dataRoot: ctx.dataRoot }).listJobs(ctx.workspace), []);
});

test('role-status default app-server path is read-only and leaves caller context and jobs untouched', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  const sessionId = 'role-status-owner'; const turnId = 'role-status-turn';
  const callerContext = await identity.beginCallerTurn({ sessionId, turnId, workspace: ctx.workspace, permissionMode: 'acceptEdits', prompt: '$zcode:rescue --fresh repair' });
  await identity.beginCallerTurn({ sessionId: 'role-status-sibling', turnId: 'sibling-turn', workspace: ctx.workspace, permissionMode: 'read-only', prompt: 'unrelated sibling' });
  const lifecycle = await runChild(process.execPath, [join(root, 'hooks', 'session-lifecycle-hook.mjs')], {
    cwd: ctx.workspace, env: ctx.env, ordinaryInput: true,
    input: { session_id: sessionId, cwd: ctx.workspace, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', source: 'startup' },
  });
  assert.equal(lifecycle.code, 0, lifecycle.stderr || lifecycle.stdout);
  const configRecord = join(ctx.workspace, 'role-status-codex.jsonl');
  const zcodeRecord = join(ctx.workspace, 'role-status-zcode.jsonl');
  await writeFile(configRecord, ''); await writeFile(zcodeRecord, '');
  const configFile = join(ctx.dataRoot, 'config.toml');
  const config = { config: { features: { multi_agent_v2: { hide_spawn_agent_metadata: false } } }, origins: {}, layers: [{ name: { type: 'user', file: configFile }, version: 'version-1', config: {} }] };
  const result = await runChild(process.execPath, [cli, 'role-status', 'rescue'], {
    cwd: ctx.workspace,
    env: { ...ctx.env, CODEX_THREAD_ID: sessionId, CODEX_APP_SERVER_PATH: process.execPath, CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([fakeCodex]), FAKE_CODEX_CONFIG_RESULT: JSON.stringify(config), FAKE_CODEX_RECORD: configRecord, FAKE_ZCODE_RECORD: zcodeRecord },
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { type: 'role-status', role: 'zcode-rescue', status: 'install-required', remedy: '$zcode:setup' });
  assert.equal(result.internal, '');
  const configCalls = (await readFile(configRecord, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.deepEqual(configCalls.filter((frame) => frame.method).map((frame) => frame.method), ['initialize', 'initialized', 'config/read']);
  assert.equal(await readFile(zcodeRecord, 'utf8'), '');
  assert.deepEqual(await createStateStore({ dataRoot: ctx.dataRoot }).listJobs(ctx.workspace), []);
  const consumed = await identity.consumeCallerContext(callerContext, { workspace: ctx.workspace });
  assert.equal(consumed.sessionId, sessionId);
  assert.equal(consumed.turnId, turnId);
});

test('invoke-choice consumes only the same session pending rescue once', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.env.PLUGIN_DATA });
  await identity.beginCallerTurn({ sessionId: 'codex-a', turnId: 'seed', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait first repair' });
  await startRescueChild(ctx, 'codex-a', 'choice-child-a');
  assert.equal((await invokePreparedRescue(ctx, 'codex-a', 'choice-child-a', 'first repair')).code, 0);
  await stopRescueChild(ctx, 'codex-a', 'choice-child-a');
  await identity.beginCallerTurn({ sessionId: 'codex-a', turnId: 'choice-origin', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --wait continue repair' });
  const undecided = await invokePreparedRescue(ctx, 'codex-a', 'choice-child-a', 'continue repair', { execution: 'foreground' });
  assert.equal(undecided.code, 3); assert.match(undecided.stdout, /needs-choice/);
  await identity.beginCallerTurn({ sessionId: 'codex-a', turnId: 'choice-answer', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: 'resume' });
  await identity.beginCallerTurn({ sessionId: 'codex-b', turnId: 'sibling-answer', workspace: ctx.workspace, permissionMode: 'read-only', prompt: 'resume' });
  await startRescueChild(ctx, 'codex-b', 'choice-child-b');
  const sibling = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'resume'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'choice-child-b' } });
  assert.notEqual(sibling.code, 0); assert.match(sibling.stdout, /(?:PENDING_INVOCATION_NOT_FOUND|EXECUTOR_STATE_MISMATCH)/);
  const accepted = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'resume'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'choice-child-a' } });
  assert.equal(accepted.code, 0, accepted.stderr || accepted.stdout);
  const replay = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'fresh'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'choice-child-a' } });
  assert.notEqual(replay.code, 0); assert.match(replay.stdout, /PENDING_INVOCATION_NOT_FOUND/);
});

test('a stopped Rescue child resumes its exact bound peer session on a later parent turn without a second SubagentStart', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const record = join(ctx.directory, 'exact-bound-resume.jsonl'); await writeFile(record, '');
  await identity.beginCallerTurn({ sessionId: 'shared-parent', turnId: 'turn-a', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh first' });
  await startRescueChild(ctx, 'shared-parent', 'child-a', 'child-a-only-start');
  const first = await invokePreparedRescue(ctx, 'shared-parent', 'child-a', 'first', { execution: 'foreground', resume: 'fresh' }, { ...ctx.env, FAKE_ZCODE_RECORD: record });
  assert.equal(first.code, 0, first.stderr || first.stdout); await stopRescueChild(ctx, 'shared-parent', 'child-a', 'child-a-only-start');

  await identity.beginCallerTurn({ sessionId: 'shared-parent', turnId: 'turn-b', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh second' });
  await startRescueChild(ctx, 'shared-parent', 'child-b', 'child-b-start');
  const second = await invokePreparedRescue(ctx, 'shared-parent', 'child-b', 'second', { execution: 'foreground', resume: 'fresh' }, { ...ctx.env, FAKE_ZCODE_RECORD: record });
  assert.equal(second.code, 0, second.stderr || second.stdout); await stopRescueChild(ctx, 'shared-parent', 'child-b', 'child-b-start');

  await identity.beginCallerTurn({ sessionId: 'shared-parent', turnId: 'turn-a-followup', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: 'continue first' });
  await prepareRescue(ctx, 'shared-parent', { version: 1, source: 'proactive', task: 'continue first', options: { execution: 'foreground', resume: 'resume' } }, 'child-a');
  const resumed = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, FAKE_CODEX_THREAD_JSON: ctx.codexChildren.get('child-a'), CODEX_THREAD_ID: 'child-a', FAKE_ZCODE_RECORD: record } });
  assert.equal(resumed.code, 0, resumed.stderr || resumed.stdout); assert.doesNotMatch(resumed.stdout, /needs-choice/);
  const requests = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const created = requests.filter((frame) => frame.method === 'session/create').map((frame) => frame.result?.session?.sessionId ?? frame.params?.sessionId).filter(Boolean);
  const resume = requests.filter((frame) => frame.method === 'session/resume').at(-1);
  assert.ok(resume, 'the stopped child must resume instead of creating a third session');
  assert.notEqual(resume.params.sessionId, created.at(-1), 'child A must never resume child B\'s later session');
});

test('a stopped Rescue child rejects same-child fresh permission replacement without job binding or session mutation', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const store = createStateStore({ dataRoot: ctx.dataRoot });
  const record = join(ctx.directory, 'permission-rotation.jsonl'); await writeFile(record, '');
  await identity.beginCallerTurn({ sessionId: 'rotate-parent', turnId: 'origin-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh first' });
  await startRescueChild(ctx, 'rotate-parent', 'rotate-child', 'only-start');
  assert.equal((await invokePreparedRescue(ctx, 'rotate-parent', 'rotate-child', 'first', { execution: 'foreground', resume: 'fresh' }, { ...ctx.env, FAKE_ZCODE_RECORD: record })).code, 0);
  await stopRescueChild(ctx, 'rotate-parent', 'rotate-child', 'only-start');
  const storage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.workspace });
  const bindingName = (await readdir(storage.directory)).find((name) => name.startsWith('rescue-binding-session-'));
  assert.ok(bindingName); const bindingPath = join(storage.directory, bindingName); const bindingBefore = await readFile(bindingPath);
  const jobsBefore = await store.listJobs(ctx.workspace); const peerBefore = await readFile(record);

  await identity.beginCallerTurn({ sessionId: 'rotate-parent', turnId: 'fresh-read-only', workspace: ctx.workspace, permissionMode: 'read-only', prompt: '$zcode:rescue --fresh replacement' });
  const rejected = await invokePreparedRescue(ctx, 'rotate-parent', 'rotate-child', 'replacement', { execution: 'foreground', resume: 'fresh' }, { ...ctx.env, FAKE_ZCODE_RECORD: record });
  assert.notEqual(rejected.code, 0); assert.match(rejected.stdout, /RESCUE_PREPARATION_MISMATCH/);
  assert.deepEqual(await store.listJobs(ctx.workspace), jobsBefore); assert.deepEqual(await readFile(bindingPath), bindingBefore); assert.deepEqual(await readFile(record), peerBefore);
});

test('invoke-prepared retains an exact terminal stopped executor beyond thirty minutes', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  await identity.beginCallerTurn({ sessionId: 'aged-parent', turnId: 'origin-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh first' });
  await startRescueChild(ctx, 'aged-parent', 'aged-child', 'only-start');
  assert.equal((await invokePreparedRescue(ctx, 'aged-parent', 'aged-child', 'first')).code, 0);
  await stopRescueChild(ctx, 'aged-parent', 'aged-child', 'only-start');
  const storage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.workspace });
  const hookStateNames = await readdir(join(storage.directory, 'hook-state'));
  const executorName = hookStateNames.find((name) => name.startsWith('executor-')); const routeName = hookStateNames.find((name) => name.startsWith('route-'));
  assert.ok(executorName); assert.ok(routeName); const executorPath = join(storage.directory, 'hook-state', executorName); const routePath = join(storage.directory, 'hook-state', routeName);
  const executor = JSON.parse(await readFile(executorPath, 'utf8')); const route = JSON.parse(await readFile(routePath, 'utf8')); const agedAt = new Date(Date.now() - 31 * 60_000).toISOString();
  await writeFile(executorPath, `${JSON.stringify({ ...executor, createdAt: agedAt }, null, 2)}\n`);
  await writeFile(routePath, `${JSON.stringify({ ...route, createdAt: agedAt }, null, 2)}\n`);
  await identity.beginCallerTurn({ sessionId: 'aged-parent', turnId: 'later-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --resume later' });
  const resumed = await invokePreparedRescue(ctx, 'aged-parent', 'aged-child', 'later', { execution: 'foreground', resume: 'resume' });
  assert.equal(resumed.code, 0, resumed.stderr || resumed.stdout);
});

test('invoke-prepared resume rejects a structurally valid rewritten executor turn', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  await identity.beginCallerTurn({ sessionId: 'forged-parent', turnId: 'origin-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh first' });
  await startRescueChild(ctx, 'forged-parent', 'forged-child', 'only-start');
  assert.equal((await invokePreparedRescue(ctx, 'forged-parent', 'forged-child', 'first')).code, 0); await stopRescueChild(ctx, 'forged-parent', 'forged-child', 'only-start');
  await identity.beginCallerTurn({ sessionId: 'forged-parent', turnId: 'later-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --resume later' });
  await prepareRescue(ctx, 'forged-parent', { version: 1, source: 'explicit', task: 'later', options: { execution: 'foreground', resume: 'resume' } });
  await rewriteOnlyExecutor(ctx, { parentTurnId: 'rewritten-origin' });
  const rejected = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'forged-child' } });
  assert.notEqual(rejected.code, 0); assert.match(rejected.stdout, /EXECUTOR_ROUTE_INVALID/);
  assert.equal((await createStateStore({ dataRoot: ctx.dataRoot }).listJobs(ctx.workspace)).length, 1);
});

test('bound invoke-choice resume rejects a structurally valid rewritten executor permission', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  await identity.beginCallerTurn({ sessionId: 'choice-forged-parent', turnId: 'origin-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh first' });
  await startRescueChild(ctx, 'choice-forged-parent', 'choice-forged-child', 'only-start');
  assert.equal((await invokePreparedRescue(ctx, 'choice-forged-parent', 'choice-forged-child', 'first')).code, 0); await stopRescueChild(ctx, 'choice-forged-parent', 'choice-forged-child', 'only-start');
  await identity.beginCallerTurn({ sessionId: 'choice-forged-parent', turnId: 'choice-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue later' });
  assert.equal((await invokePreparedRescue(ctx, 'choice-forged-parent', 'choice-forged-child', 'later', { execution: 'foreground' })).code, 3);
  await rewriteOnlyExecutor(ctx, { parentPermissionMode: 'read-only' });
  const rejected = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'resume'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'choice-forged-child' } });
  assert.notEqual(rejected.code, 0); assert.match(rejected.stdout, /EXECUTOR_ROUTE_INVALID/);
  assert.equal((await createStateStore({ dataRoot: ctx.dataRoot }).listJobs(ctx.workspace)).length, 1);
});

test('same-parent sibling cannot consume a pending Rescue choice without trusted executor identity', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.env.PLUGIN_DATA });
  const hook = join(root, 'hooks', 'subagent-hook.mjs');
  const agentHook = (event, agentId, turnId) => runChild(process.execPath, [hook], {
    cwd: ctx.workspace, env: ctx.env, ordinaryInput: true,
    input: { session_id: 'shared-parent', turn_id: turnId, cwd: ctx.workspace, hook_event_name: event, transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', agent_id: agentId, agent_type: 'zcode-rescue', ...(event === 'SubagentStop' ? { agent_transcript_path: null, stop_hook_active: false, last_assistant_message: null } : {}) },
  });
  await identity.beginCallerTurn({ sessionId: 'shared-parent', turnId: 'seed', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait seed' });
  assert.equal((await agentHook('SubagentStart', 'rescue-child', 'child-seed')).code, 0);
  const rescueRaw = JSON.stringify(persistedCodexChild({ id: 'rescue-child', parentThreadId: 'shared-parent', agentPath: '/root/zcode_rescue_task', cwd: await realpath(ctx.workspace) }));
  ctx.codexChildren.set('rescue-child', rescueRaw); ctx.env.FAKE_CODEX_THREAD_JSON = rescueRaw;
  assert.equal((await invokePreparedRescue(ctx, 'shared-parent', 'rescue-child', 'seed')).code, 0);
  assert.equal((await agentHook('SubagentStop', 'rescue-child', 'child-seed')).code, 0);
  ctx.stoppedChildren.add('rescue-child');
  await identity.beginCallerTurn({ sessionId: 'shared-parent', turnId: 'origin', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --wait protected' });
  assert.equal((await invokePreparedRescue(ctx, 'shared-parent', 'rescue-child', 'protected', { execution: 'foreground' })).code, 3);
  await identity.beginCallerTurn({ sessionId: 'shared-parent', turnId: 'later-answer', workspace: ctx.workspace, permissionMode: 'bypassPermissions', prompt: 'resume' });
  assert.equal((await agentHook('SubagentStart', 'sibling-child', 'sibling-answer')).code, 0);
  const siblingRaw = JSON.stringify(persistedCodexChild({ id: 'sibling-child', parentThreadId: 'shared-parent', agentPath: '/root/zcode_rescue_task_2', cwd: await realpath(ctx.workspace) }));
  ctx.codexChildren.set('sibling-child', siblingRaw); ctx.env.FAKE_CODEX_THREAD_JSON = siblingRaw;
  const sibling = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'resume'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'sibling-child' } });
  assert.notEqual(sibling.code, 0);
  assert.match(sibling.stdout, /(?:PENDING_INVOCATION_NOT_FOUND|EXECUTOR_STATE_MISMATCH)/);
  const parent = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'resume'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'shared-parent' } });
  assert.notEqual(parent.code, 0); assert.match(parent.stdout, /(?:EXECUTOR_IDENTITY_(?:NOT_FOUND|UNAVAILABLE)|CODEX_CHILD_METADATA_INVALID)/);
  const accepted = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'resume'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'rescue-child' } });
  assert.equal(accepted.code, 0, accepted.stderr || accepted.stdout);
  await assert.rejects(
    createInvocationStore({ dataRoot: ctx.dataRoot }).consumePending({ sessionId: 'shared-parent', workspace: ctx.workspace, command: 'rescue', choice: 'fresh', executorAgentId: 'rescue-child' }),
    { code: 'PENDING_INVOCATION_NOT_FOUND' },
  );
});

test('installed Rescue instructions keep resume on one child and route pending fresh back to a new parent-planned child', async () => {
  const source = await readFile(join(root, 'skills', 'rescue', 'SKILL.md'), 'utf8');
  const role = await readFile(join(root, 'agents', 'zcode-rescue.toml.template'), 'utf8');
  const resume = 'Continue the pending ZCode Rescue with resume. Run only the installed resume forwarder command and return its public stdout verbatim.';
  const fresh = 'Continue the pending ZCode Rescue with fresh. Run only the installed fresh forwarder command and return its public stdout verbatim.';
  assert.match(source, /retain the exact canonical path in the returned result's `task_name`/);
  assert.match(source, /the child ID remains internal plugin identity/);
  assert.match(source, /returned `task_name` is both the active logical handle and canonical continuation path/);
  assert.doesNotMatch(source, /returned active collaboration handle|rescueChildId/i);
  assert.match(source, /While that operation remains selected, do not call `spawn_agent` again after `rescueChildPath` exists/);
  assert.match(source, /ask the user exactly once/i);
  assert.match(source, /followup_task\(\{\s*target:\s*rescueChildPath,\s*message:\s*continuationMessage,?\s*\}\)/s);
  assert.match(source, /wait_agent\(\{\s*timeout_ms:\s*30000\s*\}\)/);
  assert.match(source, /select only the result or status belonging to `rescueChildPath`/);
  assert.equal(source.split(resume).length - 1, 2);
  assert.equal(source.split(fresh).length - 1, 2);
  assert.match(role, /return a `needs-choice` response byte-for-byte and stop without selecting/i);
  assert.match(role, /For the exact resume continuation above, run only:[\s\S]+invoke-choice rescue resume/);
  assert.match(role, /For the exact fresh continuation above, run only:[\s\S]+invoke-choice rescue fresh/);
  assert.match(source, /`parent-replan`[\s\S]+prepare[\s\S]+spawn/i);
  assert.match(source, /old child[\s\S]+no ZCode/i);
});

test('installed named and generic Rescue forwarders define terminal yielded-execution handling identically', async () => {
  const source = await readFile(join(root, 'skills', 'rescue', 'SKILL.md'), 'utf8');
  const role = await readFile(join(root, 'agents', 'zcode-rescue.toml.template'), 'utf8');
  const generic = /```text\n(Act only as the installed ZCode Rescue forwarder\.[\s\S]+?)\n```/.exec(source)?.[1];
  assert.ok(generic);
  const semantics = [
    /result containing an exit code is terminal/i,
    /running execution or session handle is nonterminal/i,
    /poll only that same handle with the host continuation tool until it reports an exit code/i,
    /Partial stdout, stderr, heartbeat text, or an outer code-cell completion is not terminal/i,
    /needs-choice response with exit code 3 is terminal for the current child turn/i,
    /each exact assignment and child turn[\s\S]+at most one mapped foreground `exec_command`/i,
    /same-turn continuation calls only observe[^.]+original running handle/i,
    /never start concurrent or retry foreground executions for the same assignment/i,
    /initial needs-choice terminal[\s\S]+next exact parent continuation assignment[\s\S]+one new exact `invoke-choice` foreground handle/i,
  ];
  for (const forwarder of [role, generic]) for (const contract of semantics) assert.match(forwarder, contract);
  assert.equal((role.match(/invoke-prepared rescue/g) ?? []).length, 1);
  assert.equal((generic.match(/invoke-prepared rescue/g) ?? []).length, 1);
});

test('invoke-choice executes with the originating permission snapshot in both directions', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.env.PLUGIN_DATA }); const record = join(ctx.workspace, 'permission-record.jsonl');
  const env = { ...ctx.env, FAKE_ZCODE_PERMISSION: '1', FAKE_ZCODE_PERMISSION_RISK: 'high', FAKE_ZCODE_RECORD: record };
  const decisions = async () => (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((frame) => frame?.result?.decision).map((frame) => frame.result.decision);
  await identity.beginCallerTurn({ sessionId: 'normal-origin', turnId: 'seed-normal', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh --wait seed normal' });
  await startRescueChild(ctx, 'normal-origin', 'normal-child', 'seed-normal-child');
  assert.equal((await invokePreparedRescue(ctx, 'normal-origin', 'normal-child', 'seed normal', { execution: 'foreground', resume: 'fresh' }, env)).code, 0);
  await stopRescueChild(ctx, 'normal-origin', 'normal-child', 'seed-normal-child');
  await identity.beginCallerTurn({ sessionId: 'normal-origin', turnId: 'origin-normal', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --wait protected normal' });
  assert.equal((await invokePreparedRescue(ctx, 'normal-origin', 'normal-child', 'protected normal', { execution: 'foreground' }, env)).code, 3);
  await identity.beginCallerTurn({ sessionId: 'normal-origin', turnId: 'answer-bypass', workspace: ctx.workspace, permissionMode: 'bypassPermissions', prompt: 'fresh' });
  const denied = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'fresh'], { cwd: ctx.workspace, env: { ...env, CODEX_THREAD_ID: 'normal-child' } });
  assert.equal(denied.code, 0, denied.stderr || denied.stdout);
  assert.equal((await decisions()).at(-1), 'deny', 'a bypass answer turn must not upgrade the normal origin turn');

  await identity.beginCallerTurn({ sessionId: 'bypass-origin', turnId: 'seed-bypass', workspace: ctx.workspace, permissionMode: 'bypassPermissions', prompt: '$zcode:rescue --fresh --wait seed bypass' });
  await startRescueChild(ctx, 'bypass-origin', 'bypass-child', 'seed-bypass-child');
  assert.equal((await invokePreparedRescue(ctx, 'bypass-origin', 'bypass-child', 'seed bypass', { execution: 'foreground', resume: 'fresh' }, env)).code, 0);
  await stopRescueChild(ctx, 'bypass-origin', 'bypass-child', 'seed-bypass-child');
  await identity.beginCallerTurn({ sessionId: 'bypass-origin', turnId: 'origin-bypass', workspace: ctx.workspace, permissionMode: 'bypassPermissions', prompt: '$zcode:rescue --wait protected bypass' });
  assert.equal((await invokePreparedRescue(ctx, 'bypass-origin', 'bypass-child', 'protected bypass', { execution: 'foreground' }, env)).code, 3);
  await identity.beginCallerTurn({ sessionId: 'bypass-origin', turnId: 'answer-normal', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: 'fresh' });
  const allowed = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'fresh'], { cwd: ctx.workspace, env: { ...env, CODEX_THREAD_ID: 'bypass-child' } });
  assert.equal(allowed.code, 0, allowed.stderr || allowed.stdout);
  assert.equal((await decisions()).at(-1), 'allow', 'a normal answer turn must not downgrade the bypass origin turn');
});

test('direct background invocation keeps capabilities private and production owns the worker', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.env.PLUGIN_DATA });
  const callerContext = await identity.beginCallerTurn({ sessionId: 'background-owner', turnId: 'background-turn', workspace: ctx.workspace, permissionMode: 'read-only', prompt: '$zcode:review --background' });
  ctx.preserveEvidence = true; const launched = await runChild(process.execPath, [cli, 'invoke', 'review'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'background-owner' } });
  assert.equal(launched.code, 0, launched.stderr || launched.stdout);
  const jobId = /Reserved background job ([a-f0-9]{64})\./.exec(launched.stdout)?.[1];
  assert.ok(jobId, launched.stdout); assert.doesNotMatch(`${launched.stdout}${launched.stderr}${launched.spawnargs.join(' ')}`, /executionCapability|callerContext|privateInvocation/);
  const store = createStateStore({ dataRoot: ctx.env.PLUGIN_DATA }); let job;
  // Windows CI can be heavily contended while several independent fixtures
  // start brokers and native lock probes. Keep the worker bounded, but leave
  // enough room for that startup/lock contention before declaring it stuck.
  const deadline = Date.now() + (process.platform === 'win32' ? 30_000 : 5_000);
  do { job = await store.readJob(ctx.workspace, jobId); if (['succeeded', 'failed', 'cancelled'].includes(job.status)) break; await new Promise((resolvePromise) => setTimeout(resolvePromise, 20)); } while (Date.now() < deadline);
  job = await waitForExactJobCleanup(ctx, store, jobId, process.platform === 'win32' ? 30_000 : 5_000, () => publicInvoke(ctx, ['cancel', jobId], callerContext));
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  ctx.preserveEvidence = false;
});

test('named and generic Rescue children receive only queued background output while production workers remain controllable', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.env.PLUGIN_DATA }); const store = createStateStore({ dataRoot: ctx.env.PLUGIN_DATA });
  const gate = join(ctx.directory, 'background-completion.gate'); const gateReached = join(ctx.directory, 'background-completion.reached'); const record = join(ctx.directory, 'background-zcode.jsonl');
  for (const [route, agentType, control] of [['named', 'zcode-rescue', 'result'], ['generic', 'default', 'cancel']]) {
    const parentId = `background-${route}-parent`; const childId = `background-${route}-child`; const turnId = `background-${route}-turn`;
    const baselineJobIds = new Set((await store.listJobs(ctx.workspace)).map((job) => job.id));
    ctx.preserveEvidence = true; let backgroundVerified = false;
    await writeFile(gate, 'hold'); await writeFile(gateReached, ''); await writeFile(record, '');
    const callerContext = await identity.beginCallerTurn({ sessionId: parentId, turnId, workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: `$zcode:rescue --fresh --background ${route} native child` });
    await startRescueChild(ctx, parentId, childId, `${turnId}-child`, agentType);
    try {
      const launched = await invokePreparedRescue(ctx, parentId, childId, `${route} native child`, { execution: 'background', resume: 'fresh' }, { ...ctx.env, FAKE_ZCODE_RECORD: record, FAKE_ZCODE_COMPLETION_GATE: gate, FAKE_ZCODE_COMPLETION_GATE_REACHED: gateReached, FAKE_ZCODE_COMPLETION_GATE_REACHED_DELAY_MS: '100' });
      assert.equal(launched.code, 0, launched.stderr || launched.stdout);
      const jobId = /^Reserved background job ([a-f0-9]{64})\.\n$/.exec(launched.stdout)?.[1];
      assert.ok(jobId, `native ${route} child must receive only the public queued envelope: ${launched.stdout}`);
      let job = await store.readJob(ctx.workspace, jobId);
      await waitUntil(async () => await readFile(gateReached, 'utf8').catch(() => '') === 'blocked', 5_000, 'the fake peer did not reach its exact post-ack completion gate');
      assert.deepEqual(launched.spawnargs, [process.execPath, cli, 'invoke-prepared', 'rescue']);
      assert.equal(launched.internal, ''); assert.equal(launched.stderr, '');
      assert.doesNotMatch(`${launched.stdout}${launched.stderr}${launched.spawnargs.join(' ')}`, /executionCapability|callerContext|privateInvocation|capability-sentinel-only-fd3/);

      assert.equal(job.status, 'running', `the ${route} child must be able to exit after fd4 acknowledgement while its detached worker continues`);
      assert.equal(await workerLeaseAvailable(ctx, job), false, `the ${route} worker must still hold its exact lease after fd4 acknowledgement`);
      const status = await publicInvoke(ctx, ['status', jobId], callerContext);
      assert.equal(status.code, 0, status.stderr); assert.equal(status.json.job.status, 'running');
      assert.doesNotMatch(`${status.stdout}${status.stderr}${status.internal}`, /executionCapability|callerContext|privateInvocation/);

      if (control === 'cancel') {
        const cancelled = await publicInvoke(ctx, ['cancel', jobId], callerContext);
        const cancelJob = await store.readJob(ctx.workspace, jobId); const callsAtCancel = await readFile(record, 'utf8').catch((error) => `record-read:${error?.code}`); const storage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.workspace });
        const brokerFiles = await readFile(join(storage.directory, 'broker', 'identity.json'), 'utf8').catch((error) => `identity-read:${error?.code}`);
        const cancelEvidence = JSON.stringify({ code: cancelled.code, stdout: cancelled.stdout, stderr: cancelled.stderr, internal: cancelled.internal, json: cancelled.json, job: cancelJob, callsAtCancel, brokerFiles });
        assert.equal(cancelled.code, 0, cancelEvidence); assert.equal(cancelled.json.job.status, 'cancelled');
        await waitForExactJobCleanup(ctx, store, jobId, undefined, () => publicInvoke(ctx, ['cancel', jobId], callerContext));
        const calls = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
        assert.equal(calls.filter((call) => call.method === 'session/send').length, 1); assert.equal(calls.filter((call) => call.method === 'session/stop').length, 1); assert.equal(cancelled.json.job.resultArtifact, undefined);
      } else {
        await writeFile(gate, 'release');
        const waited = await publicInvoke(ctx, ['status', jobId, '--wait', '--timeout-ms', '5000'], callerContext);
        assert.equal(waited.code, 0, waited.stderr); assert.equal(waited.json.job.status, 'succeeded');
        const result = await publicInvoke(ctx, ['result', jobId], callerContext);
        assert.equal(result.code, 0, result.stderr); assert.equal(result.json.result, 'done');
        assert.doesNotMatch(`${result.stdout}${result.stderr}${result.internal}`, /executionCapability|callerContext|privateInvocation/);
      }
      backgroundVerified = true;
    } finally {
      await writeFile(gate, 'release').catch(() => {});
      const jobs = new Map();
      for (let attempt = 0; attempt < 20; attempt += 1) { for (const job of await findNewJobs(store, ctx.workspace, baselineJobIds)) jobs.set(job.id, job); await new Promise((resolvePromise) => setTimeout(resolvePromise, 50)); }
      for (const job of jobs.values()) await waitForExactJobCleanup(ctx, store, job.id, undefined, () => publicInvoke(ctx, ['cancel', job.id], callerContext));
      assert.equal(jobs.size, 1, `expected exactly one new ${route} background job during cleanup`);
      if (backgroundVerified) ctx.preserveEvidence = false;
    }
  }
});
