// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createIdentityStore } from '../../scripts/lib/identity.mjs';
import { PluginError } from '../../scripts/lib/errors.mjs';
import { withFileLock } from '../../scripts/lib/fs.mjs';
import { createInvocationStore } from '../../scripts/lib/invocation.mjs';
import { createRescuePreparationStore } from '../../scripts/lib/rescue-preparation.mjs';
import { withWorkerLease } from '../../scripts/lib/recovery.mjs';
import { createStateStore } from '../../scripts/lib/state.mjs';
import { resolveWorkspaceStorage } from '../../scripts/lib/workspace.mjs';
import { runCompanion, runDirectInvocation } from '../../scripts/zcode-companion.mjs';
import { runChild } from '../helpers/run-child.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(root, 'scripts', 'zcode-companion.mjs');
const fakeZCode = join(root, 'tests/fixtures/fake-zcode-cli.mjs');
const fakeCodex = join(root, 'tests/fixtures/fake-codex-app-server.mjs');

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
  const env = { ...process.env, PLUGIN_DATA: dataRoot, PLUGIN_ROOT: root, ZCODE_PATH: fakeZCode };
  const context = { directory, workspace, dataRoot, callerA, callerB, env, preserveEvidence: false };
  t.after(async () => { if (!context.preserveEvidence) await cleanupFixture(directory); else t.diagnostic(`preserved background cleanup evidence at ${directory}`); });
  return context;
}

async function startRescueChild(ctx, parentSessionId, childId, turnId = `${childId}-turn`, agentType = 'zcode-rescue') {
  const result = await runChild(process.execPath, [join(root, 'hooks', 'subagent-hook.mjs')], {
    cwd: ctx.workspace, env: ctx.env, ordinaryInput: true,
    input: { session_id: parentSessionId, turn_id: turnId, cwd: ctx.workspace, hook_event_name: 'SubagentStart', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', agent_id: childId, agent_type: agentType },
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
}

async function prepareRescue(ctx, parentSessionId, envelope) {
  return runDirectInvocation(['prepare', 'rescue'], {
    cwd: ctx.workspace,
    env: { ...ctx.env, CODEX_THREAD_ID: parentSessionId },
    input: Readable.from([`${JSON.stringify(envelope)}\n`]),
  });
}

async function invokePreparedRescue(ctx, parentSessionId, childId, task, options = { execution: 'foreground', resume: 'fresh' }, env = ctx.env) {
  await prepareRescue(ctx, parentSessionId, { version: 1, source: 'explicit', task, options });
  return runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: { ...env, CODEX_THREAD_ID: childId } });
}

async function rewriteOnlyExecutor(ctx, patch) {
  const storage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.workspace });
  const names = (await readdir(join(storage.directory, 'hook-state'))).filter((name) => name.startsWith('executor-'));
  assert.equal(names.length, 1); const path = join(storage.directory, 'hook-state', names[0]); const record = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, `${JSON.stringify({ ...record, ...patch }, null, 2)}\n`);
}

test('prepared Rescue forwards only the normalized incident objective to ZCode', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const record = join(ctx.directory, 'prepared-objective.jsonl');
  const objective = 'implement the approved authentication specification';
  await identity.beginCallerTurn({
    sessionId: 'incident-parent', turnId: 'incident-turn', workspace: ctx.workspace, permissionMode: 'workspace-write',
    prompt: `Please ${objective}. Embedded marker: $zcode:rescue --fresh. If rescue fails, stop and report.`,
  });
  assert.deepEqual(await prepareRescue(ctx, 'incident-parent', { version: 1, source: 'explicit', task: objective, options: { execution: 'foreground', resume: 'fresh', model: 'model', effort: 'high' } }), { type: 'prepared', command: 'rescue' });
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
  assert.deepEqual(await prepareRescue(ctx, 'proactive-parent', { version: 1, source: 'proactive', task: 'approved objective', options: { resume: 'fresh' } }), { type: 'prepared', command: 'rescue' });
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
  const fallback = setTimeout(() => input.destroy(), 250); t.after(() => { clearTimeout(fallback); input.destroy(); });
  const operation = runDirectInvocation(['prepare', 'rescue'], {
    cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'transport-parent' }, input,
    preparationTransport: { writeReady: (line) => { events.push(`ready:${line}`); input.write(`${JSON.stringify({ version: 1, source: 'explicit', task, options: { resume: 'fresh' } })}\n`); } },
  });
  assert.deepEqual(await operation, { type: 'prepared', command: 'rescue' });
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
  assert.notEqual(parent.code, 0); assert.match(parent.stdout, /EXECUTOR_IDENTITY_(?:NOT_FOUND|UNAVAILABLE)/);
  const sibling = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'sibling-child' } });
  assert.notEqual(sibling.code, 0); assert.match(sibling.stdout, /EXECUTOR_IDENTITY_(?:NOT_FOUND|UNAVAILABLE)/);
  await startRescueChild(ctx, 'bound-parent', 'bound-child');
  const wrongWorkspace = join(ctx.directory, 'wrong-workspace'); await mkdir(wrongWorkspace);
  const wrong = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: wrongWorkspace, env: { ...ctx.env, CODEX_THREAD_ID: 'bound-child' } });
  assert.notEqual(wrong.code, 0); assert.match(wrong.stdout, /EXECUTOR_IDENTITY_(?:NOT_FOUND|UNAVAILABLE)/);
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

test('prepared explicit candidate choice preserves source and normalized argv for the same child', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  await runCompanion(['rescue', '--fresh', 'seed candidate'], { cwd: ctx.workspace, env: ctx.env, caller: { sessionId: 'choice-parent', turnId: 'seed-turn', permissionMode: 'workspace-write' } });
  await identity.beginCallerTurn({ sessionId: 'choice-parent', turnId: 'choice-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue choose continuation' });
  await prepareRescue(ctx, 'choice-parent', { version: 1, source: 'explicit', task: 'choose continuation', options: { execution: 'foreground', model: 'model', effort: 'high' } });
  await startRescueChild(ctx, 'choice-parent', 'prepared-choice-child');
  const undecided = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'prepared-choice-child' } });
  assert.equal(undecided.code, 3, undecided.stderr || undecided.stdout); assert.match(undecided.stdout, /needs-choice/);
  assert.deepEqual(await createInvocationStore({ dataRoot: ctx.dataRoot }).consumePending({ sessionId: 'choice-parent', workspace: ctx.workspace, command: 'rescue', choice: 'resume', executorAgentId: 'prepared-choice-child' }), {
    argv: ['rescue', '--resume', '--model', 'model', '--effort', 'high', '--', 'choose continuation'], source: 'explicit',
    caller: { sessionId: 'choice-parent', turnId: 'choice-turn', workspace: ctx.workspace, permissionMode: 'workspace-write' },
    route: { routeKind: 'legacy', candidateJobId: (await storeCandidate(ctx, 'choice-parent')).id },
  });
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
  await store.transitionJob(ctx.workspace, candidateB.id, ['queued'], 'running', { zcodeSessionId: 'newer-session-b', startedAt: new Date().toISOString() });
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

test('legacy executor-bound pending without a candidate rejects resume before reservation while fresh remains supported', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const pending = createInvocationStore({ dataRoot: ctx.dataRoot });
  const peerRecord = join(ctx.directory, 'legacy-choice-peer.jsonl');
  await identity.beginCallerTurn({ sessionId: 'legacy-parent', turnId: 'legacy-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue legacy' });
  await startRescueChild(ctx, 'legacy-parent', 'legacy-child', 'legacy-child-turn');
  await stopRescueChild(ctx, 'legacy-parent', 'legacy-child', 'legacy-child-turn');
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
  const fresh = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'fresh'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'legacy-child', FAKE_ZCODE_RECORD: peerRecord } });
  assert.equal(fresh.code, 0, fresh.stderr || fresh.stdout);
});

test('aged stopped executor cannot resume an eligible latest job when its exact binding is missing', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const store = createStateStore({ dataRoot: ctx.dataRoot }); const peerRecord = join(ctx.directory, 'unbound-aged-peer.jsonl');
  await identity.beginCallerTurn({ sessionId: 'unbound-parent', turnId: 'origin-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh seed' });
  await startRescueChild(ctx, 'unbound-parent', 'unbound-child', 'unbound-child-turn');
  assert.equal((await invokePreparedRescue(ctx, 'unbound-parent', 'unbound-child', 'seed')).code, 0);
  await stopRescueChild(ctx, 'unbound-parent', 'unbound-child', 'unbound-child-turn');
  const storage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.workspace });
  const executorName = (await readdir(join(storage.directory, 'hook-state'))).find((name) => name.startsWith('executor-')); const executorPath = join(storage.directory, 'hook-state', executorName); const executor = JSON.parse(await readFile(executorPath, 'utf8'));
  await writeFile(executorPath, `${JSON.stringify({ ...executor, createdAt: new Date(Date.now() - 31 * 60_000).toISOString() })}\n`);
  for (const name of await readdir(storage.directory)) if (name.startsWith('rescue-binding-')) await rm(join(storage.directory, name));
  await identity.beginCallerTurn({ sessionId: 'unbound-parent', turnId: 'later-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: 'Continue the exact same stopped Rescue child.' });
  await prepareRescue(ctx, 'unbound-parent', { version: 1, source: 'proactive', task: 'continue', options: { execution: 'foreground', resume: 'resume' } });
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
  await store.transitionJob(ctx.workspace, job.id, ['queued'], 'running', { startedAt: new Date().toISOString(), zcodeSessionId: 'PRIVATE_SESSION' });
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
async function storeCandidate(ctx, sessionId) { return (await createStateStore({ dataRoot: ctx.dataRoot }).listOwnedJobs(ctx.workspace, sessionId)).find((job) => job.command === 'rescue'); }
async function stopRescueChild(ctx, parentSessionId, childId, turnId = `${childId}-turn`, agentType = 'zcode-rescue') {
  const result = await runChild(process.execPath, [join(root, 'hooks', 'subagent-hook.mjs')], { cwd: ctx.workspace, env: ctx.env, ordinaryInput: true, input: { session_id: parentSessionId, turn_id: turnId, cwd: ctx.workspace, hook_event_name: 'SubagentStop', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', agent_id: childId, agent_type: agentType, agent_transcript_path: null, stop_hook_active: false, last_assistant_message: null } });
  assert.equal(result.code, 0, result.stderr || result.stdout);
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
  await prepareRescue(ctx, 'shared-parent', { version: 1, source: 'proactive', task: 'continue first', options: { execution: 'foreground', resume: 'resume' } });
  const resumed = await runChild(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'child-a', FAKE_ZCODE_RECORD: record } });
  assert.equal(resumed.code, 0, resumed.stderr || resumed.stdout); assert.doesNotMatch(resumed.stdout, /needs-choice/);
  const requests = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const created = requests.filter((frame) => frame.method === 'session/create').map((frame) => frame.result?.session?.sessionId ?? frame.params?.sessionId).filter(Boolean);
  const resume = requests.filter((frame) => frame.method === 'session/resume').at(-1);
  assert.ok(resume, 'the stopped child must resume instead of creating a third session');
  assert.notEqual(resume.params.sessionId, created.at(-1), 'child A must never resume child B\'s later session');
});

test('a stopped Rescue child rotates current permission on fresh then resumes with immutable hook provenance', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot }); const store = createStateStore({ dataRoot: ctx.dataRoot });
  const record = join(ctx.directory, 'permission-rotation.jsonl'); await writeFile(record, '');
  await identity.beginCallerTurn({ sessionId: 'rotate-parent', turnId: 'origin-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh first' });
  await startRescueChild(ctx, 'rotate-parent', 'rotate-child', 'only-start');
  assert.equal((await invokePreparedRescue(ctx, 'rotate-parent', 'rotate-child', 'first', { execution: 'foreground', resume: 'fresh' }, { ...ctx.env, FAKE_ZCODE_RECORD: record })).code, 0);
  await stopRescueChild(ctx, 'rotate-parent', 'rotate-child', 'only-start');

  await identity.beginCallerTurn({ sessionId: 'rotate-parent', turnId: 'fresh-read-only', workspace: ctx.workspace, permissionMode: 'read-only', prompt: '$zcode:rescue --fresh replacement' });
  assert.equal((await invokePreparedRescue(ctx, 'rotate-parent', 'rotate-child', 'replacement', { execution: 'foreground', resume: 'fresh' }, { ...ctx.env, FAKE_ZCODE_RECORD: record })).code, 0);
  const rotated = await store.resolveRescueBinding({ workspace: ctx.workspace, parentSessionId: 'rotate-parent', executorAgentId: 'rotate-child', executorAgentType: 'zcode-rescue', executorParentTurnId: 'origin-turn', executorParentPermissionMode: 'workspace-write', permissionMode: 'read-only' });
  assert.equal(rotated.kind, 'bound');

  await identity.beginCallerTurn({ sessionId: 'rotate-parent', turnId: 'resume-read-only', workspace: ctx.workspace, permissionMode: 'read-only', prompt: '$zcode:rescue --resume continue' });
  const resumed = await invokePreparedRescue(ctx, 'rotate-parent', 'rotate-child', 'continue', { execution: 'foreground', resume: 'resume' }, { ...ctx.env, FAKE_ZCODE_RECORD: record });
  assert.equal(resumed.code, 0, resumed.stderr || resumed.stdout);
  const frames = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(frames.filter((frame) => frame.method === 'session/create').length, 2);
  assert.ok(frames.some((frame) => frame.method === 'session/resume'));
});

test('invoke-prepared retains an exact terminal stopped executor beyond thirty minutes', async (t) => {
  const ctx = await fixture(t); const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  await identity.beginCallerTurn({ sessionId: 'aged-parent', turnId: 'origin-turn', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --fresh first' });
  await startRescueChild(ctx, 'aged-parent', 'aged-child', 'only-start');
  assert.equal((await invokePreparedRescue(ctx, 'aged-parent', 'aged-child', 'first')).code, 0);
  await stopRescueChild(ctx, 'aged-parent', 'aged-child', 'only-start');
  const storage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.workspace });
  const executorName = (await readdir(join(storage.directory, 'hook-state'))).find((name) => name.startsWith('executor-'));
  assert.ok(executorName); const executorPath = join(storage.directory, 'hook-state', executorName); const executor = JSON.parse(await readFile(executorPath, 'utf8'));
  await writeFile(executorPath, `${JSON.stringify({ ...executor, createdAt: new Date(Date.now() - 31 * 60_000).toISOString() }, null, 2)}\n`);
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
  assert.notEqual(rejected.code, 0); assert.match(rejected.stdout, /RESCUE_BINDING_INVALID/);
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
  assert.notEqual(rejected.code, 0); assert.match(rejected.stdout, /RESCUE_BINDING_INVALID/);
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
  assert.equal((await invokePreparedRescue(ctx, 'shared-parent', 'rescue-child', 'seed')).code, 0);
  assert.equal((await agentHook('SubagentStop', 'rescue-child', 'child-seed')).code, 0);
  await identity.beginCallerTurn({ sessionId: 'shared-parent', turnId: 'origin', workspace: ctx.workspace, permissionMode: 'workspace-write', prompt: '$zcode:rescue --wait protected' });
  assert.equal((await invokePreparedRescue(ctx, 'shared-parent', 'rescue-child', 'protected', { execution: 'foreground' })).code, 3);
  await identity.beginCallerTurn({ sessionId: 'shared-parent', turnId: 'later-answer', workspace: ctx.workspace, permissionMode: 'bypassPermissions', prompt: 'resume' });
  assert.equal((await agentHook('SubagentStart', 'sibling-child', 'sibling-answer')).code, 0);
  const sibling = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'resume'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'sibling-child' } });
  assert.notEqual(sibling.code, 0);
  assert.match(sibling.stdout, /(?:PENDING_INVOCATION_NOT_FOUND|EXECUTOR_STATE_MISMATCH)/);
  const parent = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'resume'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'shared-parent' } });
  assert.notEqual(parent.code, 0); assert.match(parent.stdout, /EXECUTOR_IDENTITY_(?:NOT_FOUND|UNAVAILABLE)/);
  const accepted = await runChild(process.execPath, [cli, 'invoke-choice', 'rescue', 'resume'], { cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: 'rescue-child' } });
  assert.equal(accepted.code, 0, accepted.stderr || accepted.stdout);
  await assert.rejects(
    createInvocationStore({ dataRoot: ctx.dataRoot }).consumePending({ sessionId: 'shared-parent', workspace: ctx.workspace, command: 'rescue', choice: 'fresh', executorAgentId: 'rescue-child' }),
    { code: 'PENDING_INVOCATION_NOT_FOUND' },
  );
});

test('installed Rescue instructions keep needs-choice and every wait continuation on one child', async () => {
  const source = await readFile(join(root, 'skills', 'rescue', 'SKILL.md'), 'utf8');
  const role = await readFile(join(root, 'agents', 'zcode-rescue.toml.template'), 'utf8');
  const resume = 'Continue the pending ZCode Rescue with resume. Run only the installed resume forwarder command and return its public stdout verbatim.';
  const fresh = 'Continue the pending ZCode Rescue with fresh. Run only the installed fresh forwarder command and return its public stdout verbatim.';
  assert.match(source, /Keep the returned child ID as `rescueChildId`/);
  assert.match(source, /Do not call `spawn_agent` again after `rescueChildId` exists/);
  assert.match(source, /ask the user exactly once/i);
  assert.match(source, /followup_task\(\{\s*target:\s*rescueChildId,\s*message:\s*continuationMessage,?\s*\}\)/s);
  assert.match(source, /wait_agent\(\{\s*timeout_ms:\s*30000\s*\}\)/);
  assert.match(source, /select only the result or status belonging to `rescueChildId`/);
  assert.equal(source.split(resume).length - 1, 2);
  assert.equal(source.split(fresh).length - 1, 2);
  assert.match(role, /return a `needs-choice` response byte-for-byte and stop without selecting/i);
  assert.match(role, /For the exact resume continuation above, run only:[\s\S]+invoke-choice rescue resume/);
  assert.match(role, /For the exact fresh continuation above, run only:[\s\S]+invoke-choice rescue fresh/);
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
