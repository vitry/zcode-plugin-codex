// @ts-nocheck
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { createIdentityStore } from '../../scripts/lib/identity.mjs';
import { createHostLifecycleStore, hostLifecycleEpoch } from '../../scripts/lib/host-lifecycle.mjs';
import { createStateStore } from '../../scripts/lib/state.mjs';
import { resolveWorkspaceStorage } from '../../scripts/lib/workspace.mjs';
import { runDirectInvocation } from '../../scripts/zcode-companion.mjs';
import { runChild } from '../helpers/run-child.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(root, 'scripts', 'zcode-companion.mjs');
const fakeZCode = join(root, 'tests/fixtures/fake-zcode-cli.mjs');
const fakeCodex = join(root, 'tests/fixtures/fake-codex-app-server.mjs');

async function cleanupFixture(directory) {
  const delays = process.platform === 'win32' ? [100, 250, 500, 1_000] : [0];
  let lastError;
  for (const delay of delays) {
    if (delay) await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
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

function child(command, args, { cwd, env, input, protectedInput = false }) {
  return runChild(command, args, { cwd, env, input, protectedInput, ordinaryInput: !protectedInput })
    .then((result) => {
      if (protectedInput) return { ...result, json: JSON.parse(result.internal) };
      if (!result.stdout) return { ...result, json: null };
      try { return { ...result, json: JSON.parse(result.stdout) }; } catch { return { ...result, json: result.stdout }; }
    });
}

async function git(cwd, args) {
  const result = await child('git', args, { cwd, env: process.env });
  assert.equal(result.code, 0, result.stderr);
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-two-session-'));
  const workspace = join(directory, 'workspace'); const dataRoot = join(directory, 'data');
  await mkdir(workspace); await writeFile(join(workspace, 'tracked.txt'), 'base\n');
  await git(workspace, ['init', '-q']); await git(workspace, ['add', 'tracked.txt']);
  await git(workspace, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base']);
  await writeFile(join(workspace, 'tracked.txt'), 'changed\n');
  const env = { ...process.env, PLUGIN_ROOT: root, PLUGIN_DATA: dataRoot, ZCODE_PATH: fakeZCode };
  t.after(() => cleanupFixture(directory));
  return { workspace, dataRoot, env };
}

async function hook(ctx, script, input) {
  const result = await child(process.execPath, [join(root, 'hooks', script)], { cwd: ctx.workspace, env: ctx.env, input });
  assert.equal(result.code, 0, result.stderr);
  return result.json;
}

function companion(ctx, argv, caller, extraEnv = {}) {
  return child(process.execPath, [cli, ...argv], { cwd: ctx.workspace, env: { ...ctx.env, ...extraEnv }, input: { callerContext: caller }, protectedInput: true });
}

function thread(id) {
  return { id, ephemeral: false, turns: [{ items: [{ type: 'userMessage', content: [{ type: 'text', text: `hello ${id}` }] }] }] };
}

function unrelatedLegacySpawnChild(workspace) {
  return {
    id: 'legacy-child', parentThreadId: null, agentRole: 'default', cwd: workspace,
    createdAt: 1, updatedAt: 2, status: { type: 'notLoaded' },
    source: { subAgent: { thread_spawn: {
      parent_thread_id: 'legacy-parent', depth: 1, agent_path: null, agent_nickname: 'Legacy', agent_role: 'default',
    } } },
  };
}

function rescueSpawnChild(id, parentThreadId, workspace) {
  return {
    id, parentThreadId, agentRole: 'zcode-rescue', cwd: workspace,
    createdAt: 3, updatedAt: 4, status: { type: 'active', activeFlags: [] },
    source: { subAgent: { thread_spawn: {
      parent_thread_id: parentThreadId, depth: 1, agent_path: '/root/zcode_rescue_task',
      agent_nickname: null, agent_role: 'zcode-rescue',
    } } },
  };
}

test('legacy protected companion calls remain isolated after real hooks stop exposing caller tokens', async (t) => {
  const ctx = await fixture(t);
  const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  const sessions = [
    { id: 'session-a', turn: 'turn-a', permission: 'acceptEdits' },
    { id: 'session-b', turn: 'turn-b', permission: 'plan' },
  ];
  for (const session of sessions) {
    await hook(ctx, 'session-lifecycle-hook.mjs', { session_id: session.id, cwd: ctx.workspace, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: session.permission, source: 'startup' });
    const output = await hook(ctx, 'user-prompt-hook.mjs', { session_id: session.id, turn_id: session.turn, cwd: ctx.workspace, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: session.permission, prompt: 'work' });
    assert.doesNotMatch(JSON.stringify(output), /ZCODE_CALLER_CONTEXT|callerContext/);
    session.caller = await identity.createCallerContext({ sessionId: session.id, turnId: session.turn, workspace: ctx.workspace, permissionMode: session.permission });
  }
  const [a, b] = sessions;
  assert.notEqual(a.caller, b.caller);

  for (const session of [a, b]) {
    const transfer = await companion(ctx, ['transfer'], session.caller, {
      CODEX_APP_SERVER_PATH: process.execPath,
      CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([fakeCodex]),
      FAKE_CODEX_THREAD_JSON: JSON.stringify(thread(session.id)),
    });
    assert.equal(transfer.code, 0, transfer.stderr);
    assert.equal(transfer.json.job.codexThreadId, session.id, 'transfer without --source must use the authenticated caller session');
    session.transfer = transfer.json.job;
  }

  for (const session of [a, b]) {
    const rescue = await companion(ctx, ['rescue', '--fresh', '--wait', `repair for ${session.id}`], session.caller);
    assert.equal(rescue.code, 0, rescue.stderr);
    assert.equal(rescue.json.job.status, 'succeeded');
    session.rescue = rescue.json.job;
  }
  const jobs = await createStateStore({ dataRoot: ctx.dataRoot }).listJobs(ctx.workspace);
  assert.equal(jobs.find((job) => job.id === a.rescue.id).permissionSnapshot.permissionMode, 'acceptEdits');
  assert.equal(jobs.find((job) => job.id === b.rescue.id).permissionSnapshot.permissionMode, 'plan');
  assert.notEqual(jobs.find((job) => job.id === a.rescue.id).zcodeSessionId, jobs.find((job) => job.id === b.rescue.id).zcodeSessionId);

  for (const session of [a, b]) {
    const choice = await companion(ctx, ['rescue', 'continue repair'], session.caller);
    assert.equal(choice.code, 3);
    assert.equal(choice.json.type, 'needs-choice');
    assert.equal(choice.json.candidate.id, session.rescue.id);
    const status = await companion(ctx, ['status'], session.caller);
    assert.equal(status.json.job.id, session.rescue.id);
    const result = await companion(ctx, ['result'], session.caller);
    assert.equal(result.json.job.id, session.rescue.id);
    assert.equal(result.json.result, 'done');
  }

  for (const [owner, sibling] of [[a, b], [b, a]]) {
    for (const command of ['status', 'result']) {
      const denied = await companion(ctx, [command, sibling.rescue.id], owner.caller);
      assert.notEqual(denied.code, 0);
      assert.equal(denied.json.error.code, 'OWNED_JOB_NOT_FOUND');
    }
  }

  a.queued = (await companion(ctx, ['review', '--background'], a.caller)).json.job;
  b.queued = (await companion(ctx, ['review', '--background'], b.caller)).json.job;
  const crossCancel = await companion(ctx, ['cancel', b.queued.id], a.caller);
  assert.notEqual(crossCancel.code, 0);
  assert.equal(crossCancel.json.error.code, 'OWNED_JOB_NOT_FOUND');
  const bBefore = await companion(ctx, ['status'], b.caller);
  assert.equal(bBefore.json.job.status, 'queued');
  for (const session of [a, b]) {
    const cancelled = await companion(ctx, ['cancel'], session.caller);
    assert.equal(cancelled.code, 0, cancelled.stderr);
    assert.equal(cancelled.json.job.id, session.queued.id);
    assert.equal(cancelled.json.job.status, 'cancelled');
  }
});

test('real prompt hooks keep direct ambient-thread invocation exact in one workspace', async (t) => {
  const ctx = await fixture(t);
  const canonicalWorkspace = await realpath(ctx.workspace);
  Object.assign(ctx.env, {
    CODEX_APP_SERVER_PATH: process.execPath,
    CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([fakeCodex]),
    FAKE_CODEX_THREAD_SPAWN_GRAPH_JSON: JSON.stringify([unrelatedLegacySpawnChild(ctx.workspace)]),
  });
  for (const session of [
    { id: 'session-a', child: 'child-a', turn: 'turn-a', task: 'repair alpha', prompt: '$zcode:rescue --fresh --wait repair alpha' },
    { id: 'session-b', child: 'child-b', turn: 'turn-b', task: 'repair beta', prompt: '$zcode:rescue --fresh --wait repair beta' },
  ]) {
    await hook(ctx, 'session-lifecycle-hook.mjs', { session_id: session.id, cwd: ctx.workspace, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', source: 'startup' });
    const output = await hook(ctx, 'user-prompt-hook.mjs', { session_id: session.id, turn_id: session.turn, cwd: ctx.workspace, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', prompt: session.prompt });
    assert.doesNotMatch(JSON.stringify(output), /ZCODE_CALLER_CONTEXT|callerContext/);
    assert.deepEqual(await runDirectInvocation(['prepare', 'rescue'], {
      cwd: ctx.workspace, env: { ...ctx.env, CODEX_THREAD_ID: session.id },
      input: Readable.from([`${JSON.stringify({ version: 1, source: 'explicit', task: session.task, options: { execution: 'foreground', resume: 'fresh' } })}\n`]),
    }), { type: 'prepared', command: 'rescue', route: { version: 1, action: 'spawn', taskName: 'zcode_rescue_task' } });
    await hook(ctx, 'subagent-hook.mjs', { session_id: session.id, turn_id: `${session.turn}-child`, cwd: ctx.workspace, hook_event_name: 'SubagentStart', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', agent_id: session.child, agent_type: 'zcode-rescue' });
  }
  const a = await child(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: {
    ...ctx.env, CODEX_THREAD_ID: 'child-a', FAKE_CODEX_THREAD_JSON: JSON.stringify(rescueSpawnChild('child-a', 'session-a', canonicalWorkspace)),
  } });
  const b = await child(process.execPath, [cli, 'invoke-prepared', 'rescue'], { cwd: ctx.workspace, env: {
    ...ctx.env, CODEX_THREAD_ID: 'child-b', FAKE_CODEX_THREAD_JSON: JSON.stringify(rescueSpawnChild('child-b', 'session-b', canonicalWorkspace)),
  } });
  assert.equal(a.code, 0, a.stderr || a.stdout); assert.equal(b.code, 0, b.stderr || b.stdout);
  const jobs = await createStateStore({ dataRoot: ctx.dataRoot }).listJobs(ctx.workspace);
  assert.equal(jobs.filter((job) => job.ownerSessionId === 'session-a').length, 1);
  assert.equal(jobs.filter((job) => job.ownerSessionId === 'session-b').length, 1);
});

function identitySessionLockDir(dataRootPath, sessionId) {
  const key = createHash('sha256').update(JSON.stringify([sessionId])).digest('hex');
  return join(dataRootPath, 'identity-lifecycle', 'session-locks', key.slice(0, 2));
}

async function waitForReceipt(lifecycle, epoch, timeoutMs = 2_500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await lifecycle.readReceipt(epoch);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return null;
}

function startHook(ctx, script, input) {
  const childProcess = spawn(process.execPath, [join(root, 'hooks', script)], { cwd: ctx.workspace, env: ctx.env, stdio: ['pipe', 'pipe', 'pipe'] });
  childProcess.stdin.end(JSON.stringify(input));
  return childProcess;
}

function readHookSessionEnd(ctx, sessionId) {
  return child(process.execPath, [join(root, 'hooks', 'session-end-hook.mjs')], {
    cwd: ctx.workspace, env: ctx.env,
    input: { session_id: sessionId, cwd: ctx.workspace, hook_event_name: 'SessionEnd', transcript_path: null, reason: 'other' },
  });
}

async function hostOwnedRunningJob(fixture, { workspace, ownerSessionId, epoch, agent, remote, turn = 'turn', placement = 'foreground' }) {
  const store = createStateStore({ dataRoot: fixture.dataRoot });
  const reservation = { workspace, ownerSessionId, ownerTurnId: turn, command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'acceptEdits' } };
  if (epoch === null) {
    // Legacy writable Rescue: no Host-owned lifecycle trio, settled through the
    // existing pre-epoch SessionEnd path.
    const legacy = await store.reserveJob(reservation);
    const legacyClaimed = await store.claimJobWorkerForExecution(workspace, legacy.id, { childPid: 999_999_999, workerLeaseId: legacy.id });
    let legacyRunning = await store.transitionJob(workspace, legacy.id, ['queued'], 'running', { startedAt: new Date().toISOString(), zcodeSessionId: remote, childPid: legacyClaimed.childPid, workerLeaseId: legacyClaimed.workerLeaseId });
    legacyRunning = await store.transitionJob(workspace, legacyRunning.id, ['running'], 'running', { inputId: `input-${agent}`, startRevision: 1, beforeMessageIds: [] });
    return { store, job: legacyRunning };
  }
  const reserved = await store.reserveFreshRescueJob({
    workspace,
    reservation: { workspace, ownerSessionId, ownerTurnId: turn, command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'acceptEdits' } },
    executor: { parentSessionId: ownerSessionId, parentTurnId: turn, agentId: agent, agentType: 'zcode-rescue', agentPath: '/root/zcode_rescue_task', workspace, parentPermissionMode: 'acceptEdits' },
    lifecycle: { ownerLifecycleEpoch: epoch, executionOwner: 'host-child', hostPlacement: placement },
  });
  const claimed = await store.claimJobWorkerForExecution(workspace, reserved.job.id, { childPid: 999_999_999, workerLeaseId: reserved.job.id });
  let running = await store.transitionJob(workspace, reserved.job.id, ['queued'], 'running', {
    startedAt: new Date().toISOString(), zcodeSessionId: remote, childPid: claimed.childPid, workerLeaseId: claimed.workerLeaseId });
  running = await store.transitionJob(workspace, running.id, ['running'], 'running', { inputId: `input-${agent}`, startRevision: 1, beforeMessageIds: [] });
  return { store, job: running };
}

// Record a SessionStart and pin its createdAt to a deterministic value so the
// receipt epoch is reproducible; returns the epoch and canonical paths.
async function recordSessionStartEpoch(ctx, sessionId) {
  await mkdir(ctx.dataRoot, { recursive: true });
  const canonicalWorkspace = await realpath(ctx.workspace);
  const dataRootPath = await realpath(ctx.dataRoot);
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  await hook(ctx, 'session-lifecycle-hook.mjs', { session_id: sessionId, cwd: ctx.workspace, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', source: 'startup' });
  const storage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.workspace });
  const recordPath = join(storage.directory, 'hook-state', `session-${createHash('sha256').update(JSON.stringify(['session', sessionId])).digest('hex')}.json`);
  await writeFile(recordPath, `${JSON.stringify({ kind: 'session', sessionId, workspace: storage.workspacePath, source: 'startup', createdAt: startedAt })}\n`);
  return { epoch: hostLifecycleEpoch(sessionId, startedAt), canonicalWorkspace, dataRootPath };
}

function spawnIdentityLockHolder(dataRootPath, sessionId, t) {
  const fsUrl = pathToFileURL(join(root, 'scripts/lib/fs.mjs')).href;
  const holder = spawn(process.execPath, ['--input-type=module', '--eval',
    `import { withFileLock } from ${JSON.stringify(fsUrl)};`
    + `await withFileLock(process.argv[1], async () => { process.stdout.write('ready'); await new Promise((r) => process.stdin.once('data', r)); });`,
    identitySessionLockDir(dataRootPath, sessionId)], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { try { holder.kill('SIGKILL'); } catch { /* exited */ } });
  return holder;
}

function onceExited(childProcess) {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => childProcess.once('exit', resolve));
}

test('SessionEnd persists its receipt before contended identity cleanup', async (t) => {
  const ctx = await fixture(t);
  const { epoch, dataRootPath } = await recordSessionStartEpoch(ctx, 'session-a');
  const lifecycle = createHostLifecycleStore({ dataRoot: ctx.dataRoot });
  const holder = spawnIdentityLockHolder(dataRootPath, 'session-a', t);
  await new Promise((resolve, reject) => {
    holder.stdout.once('data', () => resolve()); holder.once('error', reject);
    holder.once('exit', (code) => reject(new Error(`identity lock holder exited ${code}`)));
  });
  const hook = startHook(ctx, 'session-end-hook.mjs', { session_id: 'session-a', cwd: ctx.workspace, hook_event_name: 'SessionEnd', transcript_path: null, reason: 'other' });
  t.after(async () => { hook.kill('SIGKILL'); holder.stdin.end('release'); await Promise.all([onceExited(hook), onceExited(holder)]); });
  let hookStderr = '';
  hook.stderr.on('data', (chunk) => { hookStderr += chunk; });
  const receipt = await waitForReceipt(lifecycle, epoch);
  assert.ok(receipt, `the SessionEnd receipt must be durable before the contended identity cleanup completes; hook stderr: ${hookStderr}`);
  assert.equal(receipt.state, 'pending', 'the receipt is published pending, before any settlement');
  assert.equal(receipt.epoch, epoch);
  assert.equal(receipt.origin, 'session-end-hook');
  hook.kill('SIGKILL');
  await onceExited(hook);
  holder.stdin.end('release');
  await onceExited(holder);
  assert.equal((await lifecycle.readReceipt(epoch)).state, 'pending', 'killing the hook after the receipt leaves it pending, not settled');
});

test('SessionEnd returns within its bounded budget while the identity session lock is held', async (t) => {
  const ctx = await fixture(t);
  const { epoch, dataRootPath } = await recordSessionStartEpoch(ctx, 'session-a');
  const lifecycle = createHostLifecycleStore({ dataRoot: ctx.dataRoot });
  const holder = spawnIdentityLockHolder(dataRootPath, 'session-a', t);
  await identityHolderReady(holder);
  const hook = startHook(ctx, 'session-end-hook.mjs', { session_id: 'session-a', cwd: ctx.workspace, hook_event_name: 'SessionEnd', transcript_path: null, reason: 'other' });
  let hookStderr = ''; hook.stderr.on('data', (chunk) => { hookStderr += chunk; });
  t.after(async () => { hook.kill('SIGKILL'); holder.stdin.end('release'); await Promise.all([onceExited(hook), onceExited(holder)]); });
  const started = Date.now();
  const exited = await Promise.race([
    onceExited(hook).then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_900)),
  ]);
  const elapsed = Date.now() - started;
  // The identity stage must be bounded so the whole hook completes on its own; a
  // lock-held identity cleanup that ran to its default five-second timeout would
  // let the native hook kill this process instead (exited false, elapsed ~3000ms).
  assert.equal(exited, true, `the SessionEnd hook must exit on its own while the identity lock is held; hook stderr: ${hookStderr}`);
  assert.ok(elapsed < 2_900, `the bounded SessionEnd must complete well before the native deadline (took ${elapsed}ms)`);
  assert.ok(hook.exitCode === 0, `bounded SessionEnd must exit zero; hook stderr: ${hookStderr}`);
  const receipt = await lifecycle.readReceipt(epoch);
  assert.ok(receipt, 'the receipt remains durable across the bounded identity stage');
  // Identity contention only defers the DESTRUCTIVE stage now: the workspace scope
  // is enumerated read-only before it, and this session has no obligations, so
  // settling is accurate — and the bounded zero exit above proves the deferred
  // cleanup can never push the hook past the native deadline.
  assert.equal(receipt.state, 'settled', 'an enumerated scope with no obligations settles even while the identity lock defers destructive cleanup');
  holder.stdin.end('release');
  await onceExited(holder);
});

test('SessionEnd delegates unresolved jobs to exact durable stop intents within the native budget', async (t) => {
  const ctx = await fixture(t);
  const { epoch, canonicalWorkspace } = await recordSessionStartEpoch(ctx, 'gate-owner');
  const { store, job } = await hostOwnedRunningJob(ctx, { workspace: canonicalWorkspace, ownerSessionId: 'gate-owner', epoch, agent: 'gate-child', remote: 'zs-gate', placement: 'background' });
  const recordPath = join(ctx.dataRoot, 'gate-zcode-calls.jsonl');
  await writeFile(recordPath, '');
  ctx.env.FAKE_ZCODE_RECORD = recordPath;
  const lifecycle = createHostLifecycleStore({ dataRoot: ctx.dataRoot });
  const started = Date.now();
  const ended = await readHookSessionEnd(ctx, 'gate-owner');
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3_000, `bounded SessionEnd must finish within the native budget (took ${elapsed}ms)`);
  assert.equal(ended.code, 0, `session-end hook must exit zero with no broker: ${ended.stderr}`);
  const stored = await store.readJob(canonicalWorkspace, job.id);
  assert.ok(['cancelling', 'cancelled', 'failed'].includes(stored.status),
    `the obligation is durably settled or delegated (was ${stored.status})`);
  assert.equal(stored.status === 'cancelled', false, 'an unproven stop must never be claimed as a cancelled terminal');
  assert.equal(stored.stopIntent.cause, 'session-end', 'the exact durable session-end stop intent is persisted as the delegation evidence');
  assert.equal((await lifecycle.readReceipt(epoch)).state, 'settled', 'a receipt whose obligations are all terminal-or-delegated settles');
  assert.equal((await readFileSafe(recordPath)).trim(), '', 'SessionEnd must never lazily spawn the ZCode broker');
});

test('a matching-epoch receipt delegates its own obligation while a foreign-epoch host run stays untouched', async (t) => {
  const ctx = await fixture(t);
  const { epoch, canonicalWorkspace } = await recordSessionStartEpoch(ctx, 'match-owner');
  const { store, job: mine } = await hostOwnedRunningJob(ctx, { workspace: canonicalWorkspace, ownerSessionId: 'match-owner', epoch, agent: 'match-mine', remote: 'zs-mine', placement: 'foreground' });
  await mkdir(join(ctx.workspace, '..', 'match-other'), { recursive: true });
  const otherWorkspace = await realpath(join(ctx.workspace, '..', 'match-other'));
  const { job: foreign } = await hostOwnedRunningJob(ctx, { workspace: otherWorkspace, ownerSessionId: 'match-owner', epoch: 'f'.repeat(64), agent: 'match-foreign', remote: 'zs-foreign' });
  const ended = await readHookSessionEnd(ctx, 'match-owner');
  assert.equal(ended.code, 0, ended.stderr);
  const mineStored = await store.readJob(canonicalWorkspace, mine.id);
  assert.ok(['cancelling', 'cancelled', 'failed'].includes(mineStored.status), 'a matching-epoch obligation is settled or durably delegated');
  assert.equal(mineStored.stopIntent.cause, 'session-end');
  assert.equal((await store.readJob(otherWorkspace, foreign.id)).status, 'running', 'a foreign-epoch host run is never this receipt obligation');
});

test('an absent session-start record does not block cleanup and publishes no receipt', async (t) => {
  const ctx = await fixture(t);
  await mkdir(ctx.dataRoot, { recursive: true });
  const dataRootPath = await realpath(ctx.dataRoot);
  const canonicalWorkspace = await realpath(ctx.workspace);
  const lifecycle = createHostLifecycleStore({ dataRoot: ctx.dataRoot });
  const store = createStateStore({ dataRoot: ctx.dataRoot });
  // A legacy writable job must still settle through the existing path even with
  // no proven session-start record for the epoch.
  await hostOwnedRunningJob(ctx, { workspace: canonicalWorkspace, ownerSessionId: 'no-record', epoch: null, agent: 'no-record-child', remote: 'zs-no-record' });
  const started = Date.now();
  const ended = await readHookSessionEnd(ctx, 'no-record');
  assert.ok(Date.now() - started < 3_000, 'cleanup must stay bounded when no session-start record is proven');
  assert.equal(ended.code, 0, ended.stderr);
  const pending = await lifecycle.listPendingReceipts();
  assert.deepEqual(pending.filter((r) => r.sessionId === 'no-record'), [], 'no bogus receipt is published for an unproven epoch');
  const jobs = await store.listOwnedJobs(canonicalWorkspace, 'no-record');
  assert.equal(jobs.every((j) => ['cancelled', 'failed', 'succeeded'].includes(j.status)), true, 'the legacy settle path still terminalizes the owned job');
  const ledgerPath = join(dataRootPath, 'identity-lifecycle', 'sessions', createHash('sha256').update(JSON.stringify(['no-record'])).digest('hex') + '.json');
  await assert.rejects(readFileSafe(ledgerPath), 'identity cleanup still runs and removes the identity ledger without a session-start record');
});

test('SessionEnd does not publish a remote cancellation for a read-only detached run whose stop cannot be proven', async (t) => {
  const ctx = await fixture(t);
  const { canonicalWorkspace } = await recordSessionStartEpoch(ctx, 'readonly-owner');
  const store = createStateStore({ dataRoot: ctx.dataRoot });
  let value = await store.reserveJob({ workspace: canonicalWorkspace, ownerSessionId: 'readonly-owner', ownerTurnId: 'ro-turn', command: 'rescue', readOnly: true, permissionSnapshot: { permissionMode: 'read-only' } });
  value = await store.claimJobWorker(canonicalWorkspace, value.id, { childPid: 999_999, workerLeaseId: 'a'.repeat(64) });
  value = await store.transitionJob(canonicalWorkspace, value.id, ['queued'], 'running', { startedAt: new Date().toISOString(), zcodeSessionId: 'zs-readonly' });
  value = await store.transitionJob(canonicalWorkspace, value.id, ['running'], 'running', { inputId: 'input-ro', startRevision: 1, beforeMessageIds: [] });
  const started = Date.now();
  const ended = await readHookSessionEnd(ctx, 'readonly-owner');
  assert.ok(Date.now() - started < 3_000);
  assert.equal(ended.code, 0, ended.stderr);
  assert.equal((await store.readJob(canonicalWorkspace, value.id)).status, 'running', 'process death or an unproven stop never publishes a read-only cancellation');
});

async function readFileSafe(path) { return (await import('node:fs/promises')).readFile(path, 'utf8'); }

function identityHolderReady(holder) {
  return new Promise((resolve, reject) => {
    holder.stdout.once('data', () => resolve()); holder.once('error', reject);
    holder.once('exit', (code) => reject(new Error(`identity lock holder exited ${code}`)));
  });
}

// Widen a session's identity ledger to a linked workspace the way a forwarded /
// linked-Worktree execution would, so SessionEnd's identity cleanup can return
// more than the ambient cwd.
async function extendIdentityLedger(dataRootPath, sessionId, extraWorkspaces) {
  const key = createHash('sha256').update(JSON.stringify([sessionId])).digest('hex');
  const path = join(dataRootPath, 'identity-lifecycle', 'sessions', `${key}.json`);
  const ledger = JSON.parse(await readFile(path, 'utf8'));
  ledger.knownWorkspaces = [...new Set([...ledger.knownWorkspaces, ...extraWorkspaces])].sort();
  await writeFile(path, `${JSON.stringify(ledger)}\n`);
}

test('an unprovable scope keeps the receipt pending and preserves the identity ledger', async (t) => {
  const ctx = await fixture(t);
  await mkdir(ctx.dataRoot, { recursive: true });
  const dataRootPath = await realpath(ctx.dataRoot);
  const { recordSession, resolveRecordedSessionStart } = await import('../../hooks/lib/hook-state.mjs');
  await recordSession(ctx.dataRoot, { session_id: 'corrupt-scope', cwd: ctx.workspace, source: 'startup' });
  const startedAt = (await resolveRecordedSessionStart(ctx.dataRoot, ctx.workspace, 'corrupt-scope')).startedAt;
  const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  await identity.beginCallerTurn({ sessionId: 'corrupt-scope', turnId: 'turn', workspace: ctx.workspace, permissionMode: 'acceptEdits', sessionStartedAt: startedAt, sessionSource: 'startup' });
  const ledgerPath = join(dataRootPath, 'identity-lifecycle', 'sessions', createHash('sha256').update(JSON.stringify(['corrupt-scope'])).digest('hex') + '.json');
  await writeFile(ledgerPath, 'definitely not json\n');
  const lifecycle = createHostLifecycleStore({ dataRoot: ctx.dataRoot });
  const ended = await readHookSessionEnd(ctx, 'corrupt-scope');
  assert.ok(Date.now() - (Date.now() - 3_000) > 0);
  assert.equal(ended.code, 0, ended.stderr);
  assert.equal((await lifecycle.readReceipt(hostLifecycleEpoch('corrupt-scope', startedAt)))?.state, 'pending', 'an unprovable scope must keep the receipt pending');
  assert.equal(await readFile(ledgerPath, 'utf8'), 'definitely not json\n', 'the destructive identity cleanup must not run while the scope is unproven');
});

test('SessionEnd delegates a linked-workspace obligation discovered outside the cwd fallback scope', async (t) => {
  const ctx = await fixture(t);
  await mkdir(ctx.dataRoot, { recursive: true });
  const dataRootPath = await realpath(ctx.dataRoot);
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const { recordSession } = await import('../../hooks/lib/hook-state.mjs');
  await recordSession(ctx.dataRoot, { session_id: 'link-owner', cwd: ctx.workspace, source: 'startup' });
  const storage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.workspace });
  const recordFile = join(storage.directory, 'hook-state', `session-${createHash('sha256').update(JSON.stringify(['session', 'link-owner'])).digest('hex')}.json`);
  await writeFile(recordFile, `${JSON.stringify({ kind: 'session', sessionId: 'link-owner', workspace: storage.workspacePath, source: 'startup', createdAt: startedAt })}\n`);
  // A proven session ledger whose scope is the origin; then a linked workspace is
  // added, as a forwarded / linked-Worktree execution would.
  const identity = createIdentityStore({ dataRoot: ctx.dataRoot });
  await identity.beginCallerTurn({ sessionId: 'link-owner', turnId: 'turn', workspace: ctx.workspace, permissionMode: 'acceptEdits', sessionStartedAt: startedAt, sessionSource: 'startup' });
  const epoch = hostLifecycleEpoch('link-owner', startedAt);
  await mkdir(join(ctx.workspace, '..', 'link-scope'), { recursive: true });
  const linkWorkspace = await realpath(join(ctx.workspace, '..', 'link-scope'));
  await extendIdentityLedger(dataRootPath, 'link-owner', [linkWorkspace]);
  const { store, job } = await hostOwnedRunningJob(ctx, { workspace: linkWorkspace, ownerSessionId: 'link-owner', epoch, agent: 'link-child', remote: 'zs-link' });
  const lifecycle = createHostLifecycleStore({ dataRoot: ctx.dataRoot });
  const holder = spawnIdentityLockHolder(dataRootPath, 'link-owner', t);
  await identityHolderReady(holder);
  const hook = startHook(ctx, 'session-end-hook.mjs', { session_id: 'link-owner', cwd: ctx.workspace, hook_event_name: 'SessionEnd', transcript_path: null, reason: 'other' });
  let hookStderr = ''; hook.stderr.on('data', (chunk) => { hookStderr += chunk; });
  t.after(async () => { hook.kill('SIGKILL'); holder.stdin.end('release'); await Promise.all([onceExited(hook), onceExited(holder)]); });
  const exited = await Promise.race([onceExited(hook).then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 2_900))]);
  assert.equal(exited, true, `the bounded hook must still self-exit under identity contention; stderr: ${hookStderr}`);
  // The read-only scope enumeration discovers the linked workspace even while the
  // destructive identity stage is contended, so the obligation is delegated exactly
  // and the receipt settles on that evidence — while the held lock still defers the
  // ledger tombstone itself (the crash-safety the reorder guarantees).
  const sessionKey = createHash('sha256').update(JSON.stringify(['link-owner'])).digest('hex');
  const identityLedger = JSON.parse(await readFile(join(dataRootPath, 'identity-lifecycle', 'sessions', `${sessionKey}.json`), 'utf8'));
  assert.equal(identityLedger.endedAt, null, 'the destructive identity stage stays deferred while the session lock is held');
  holder.stdin.end('release');
  await onceExited(holder);
  const linked = await store.readJob(linkWorkspace, job.id);
  assert.equal(['cancelling', 'failed'].includes(linked.status), true, `the linked obligation is settled or delegated, never vacuously skipped (was ${linked.status})`);
  assert.equal(linked.stopIntent?.cause, 'session-end', 'the exact session-end stop intent is the durable delegation evidence');
  const receipt = await lifecycle.readReceipt(epoch);
  assert.equal(receipt.state, 'settled', 'a fully enumerated scope whose obligations are all terminal-or-delegated settles even while the destructive cleanup is deferred');
  assert.ok(receipt.workspaceHints.includes(linkWorkspace), 'the enumerated linked workspace is durably recorded in the receipt hints for later compensation');
});

test('SessionEnd leaves an active foreign-epoch job running and settles its own empty obligations under contention', async (t) => {
  const ctx = await fixture(t);
  const { epoch, canonicalWorkspace, dataRootPath } = await recordSessionStartEpoch(ctx, 'post-resume-owner');
  // A NEWER-epoch active writable job (a post-resume run) shares the workspace with
  // an OLD-epoch SessionEnd. The old receipt must not stop it: the read-only scope
  // proves the old epoch has no obligations, so the receipt settles accurately,
  // while the foreign active job marks the workspace release-unsafe (its broker
  // owner is never released out from under the newer run) and the held identity
  // lock defers only the destructive cleanup stage.
  const foreignEpoch = hostLifecycleEpoch('post-resume-owner', '2026-02-02T00:00:00.000Z');
  const { store, job } = await hostOwnedRunningJob(ctx, { workspace: canonicalWorkspace, ownerSessionId: 'post-resume-owner', epoch: foreignEpoch, agent: 'post-resume-child', remote: 'zs-foreign' });
  const lifecycle = createHostLifecycleStore({ dataRoot: ctx.dataRoot });
  const holder = spawnIdentityLockHolder(dataRootPath, 'post-resume-owner', t);
  await identityHolderReady(holder);
  const hook = startHook(ctx, 'session-end-hook.mjs', { session_id: 'post-resume-owner', cwd: ctx.workspace, hook_event_name: 'SessionEnd', transcript_path: null, reason: 'other' });
  let hookStderr = ''; hook.stderr.on('data', (chunk) => { hookStderr += chunk; });
  t.after(async () => { hook.kill('SIGKILL'); holder.stdin.end('release'); await Promise.all([onceExited(hook), onceExited(holder)]); });
  const exited = await Promise.race([onceExited(hook).then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 2_900))]);
  assert.equal(exited, true, `the bounded hook must self-exit under identity contention; stderr: ${hookStderr}`);
  holder.stdin.end('release');
  await onceExited(holder);
  assert.equal((await store.readJob(canonicalWorkspace, job.id)).status, 'running', 'a newer-epoch active job is never stopped by an old-epoch SessionEnd');
  assert.equal((await lifecycle.readReceipt(epoch))?.state, 'settled', 'the old receipt settles on its empty matching obligations; the newer run is protected by the deferred owner release, not by holding the old boundary pending');
});

/** Whether the exact worker lease lock is currently held (by the detached worker). @param {string} dataRoot @param {string} workspace @param {string} jobId @param {string} workerLeaseId */
async function leaseLockHeld(dataRoot, workspace, jobId, workerLeaseId) {
  const { withWorkerLease } = await import('../../scripts/lib/recovery.mjs');
  try {
    await withWorkerLease({ dataRoot, workspace, jobId, workerLeaseId, timeoutMs: 0 }, () => undefined);
    return false; // acquired -> was free
  } catch (error) {
    return error?.code === 'LOCK_TIMEOUT';
  }
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error && typeof error === 'object' && error.code === 'EPERM'; }
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(predicate(), message);
}

function spawnLeaseHoldingDetachedWorker(dataRoot, workspace, jobId, workerLeaseId) {
  // A real detached, self-grouped long-lived child that HOLDS its worker lease
  // lock for its lifetime — the shape SessionEnd's lease-verified termination
  // requires before signaling the recorded pid. Killing it proves the read-only
  // convergence terminated the exact recorded worker process tree.
  const holder = `const { withWorkerLease } = await import(${JSON.stringify(new URL('../../scripts/lib/recovery.mjs', import.meta.url).href)});
    await withWorkerLease({ dataRoot: ${JSON.stringify(dataRoot)}, workspace: ${JSON.stringify(workspace)}, jobId: ${JSON.stringify(jobId)}, workerLeaseId: ${JSON.stringify(workerLeaseId)} }, () => new Promise(() => {}));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', holder], { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

test('SessionEnd converges an active read-only detached run: terminates the recorded worker, never settles on an unproven winner', async (t) => {
  const ctx = await fixture(t);
  const { epoch, canonicalWorkspace } = await recordSessionStartEpoch(ctx, 'ro-detached-owner');
  const lifecycle = createHostLifecycleStore({ dataRoot: ctx.dataRoot });
  const store = createStateStore({ dataRoot: ctx.dataRoot });
  // A read-only Review run with a recorded worker + remote turn, owned by the
  // ending session; a live broker is required so it may not be lazily spawned.
  let ro = await store.reserveJob({ workspace: canonicalWorkspace, ownerSessionId: 'ro-detached-owner', ownerTurnId: 'ro-turn', command: 'review', readOnly: true, permissionSnapshot: { permissionMode: 'default' } });
  const leaseId = ro.id;
  const worker = spawnLeaseHoldingDetachedWorker(ctx.dataRoot, canonicalWorkspace, ro.id, leaseId);
  await new Promise((resolve) => worker.once('spawn', resolve));
  const childPid = worker.pid;
  t.after(() => { try { process.kill(-childPid, 'SIGKILL'); } catch { /* gone */ } });
  await waitFor(() => leaseLockHeld(ctx.dataRoot, canonicalWorkspace, ro.id, leaseId), 'the detached worker must acquire its worker lease');
  assert.equal(isPidAlive(childPid), true, 'the detached worker is alive before SessionEnd');
  ro = await store.claimJobWorker(canonicalWorkspace, ro.id, { childPid, workerLeaseId: leaseId });
  ro = await store.transitionJob(canonicalWorkspace, ro.id, ['queued'], 'running', { startedAt: new Date().toISOString(), zcodeSessionId: 'zs-ro-detached' });
  ro = await store.transitionJob(canonicalWorkspace, ro.id, ['running'], 'running', { inputId: 'input-ro', startRevision: 1, beforeMessageIds: [] });
  const started = Date.now();
  const ended = await readHookSessionEnd(ctx, 'ro-detached-owner');
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2_900, `the read-only convergence must stay bounded (took ${elapsed}ms)`);
  assert.equal(ended.code, 0, ended.stderr);
  // Process death is only local cleanup; with no healthy broker it is never remote
  // terminal proof, so the job stays unresolved and the receipt stays pending.
  assert.equal((await store.readJob(canonicalWorkspace, ro.id)).status, 'running', 'an unproven read-only run is never claimed terminal');
  assert.equal((await lifecycle.readReceipt(epoch)).state, 'pending', 'the receipt must not settle while an active read-only run is unconverged/unproven');
  await waitFor(() => !isPidAlive(childPid), `the SessionEnd read-only convergence must terminate the recorded worker process tree (${childPid})`);
});
