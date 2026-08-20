import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PluginError } from '../scripts/lib/errors.mjs';
import { atomicWriteJson } from '../scripts/lib/fs.mjs';
import { createJobController, durableCancelledWinner, ownerIdForSession, readBoundRescueStatus } from '../scripts/lib/job-control.mjs';
import { createStateStore } from '../scripts/lib/state.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';
import { executeJob } from '../scripts/lib/review.mjs';
import { conversationFrame, toolRow } from './fixtures/conversation-progress-frames.mjs';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'zcode-job-control-'));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const store = createStateStore({ dataRoot: join(root, 'data') });
  return { root, workspace, store, controller: createJobController({ store, pollIntervalMs: 1 }) };
}

const reservation = { ownerSessionId: 'session-a', ownerTurnId: 'turn-a', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } };
const silentSubscribe = () => () => {};

/** @param {string} value */
function hasPublicControl(value) {
  return [...value].some((character) => {
    const code = /** @type {number} */ (character.codePointAt(0));
    return code <= 0x1f || code >= 0x7f && code <= 0x9f || code === 0x061c || code === 0x200e || code === 0x200f || code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069;
  });
}

/** @param {string} root @param {string} workspace @param {string} jobId */
async function attemptFixture(root, workspace, jobId) {
  const storage = await resolveWorkspaceStorage({ dataRoot: join(root, 'data'), workspace }); const path = join(storage.directory, 'cancel-attempts', `${jobId}.json`);
  return { path, read: async () => JSON.parse(await readFile(path, 'utf8')) };
}

test('owner IDs are stable, opaque and session-confined', () => {
  assert.equal(ownerIdForSession('session-a'), ownerIdForSession('session-a'));
  assert.notEqual(ownerIdForSession('session-a'), ownerIdForSession('session-b'));
  assert.doesNotMatch(ownerIdForSession('session-a'), /session-a/);
});

test('bound Rescue status selects the exact binding current job and returns only the fixed safe projection', async () => {
  const preview = ['one', 'two', 'three', 'four', 'five'];
  const jobs = [
    { id: 'job-wrong-turn', workspace: '/repo', ownerSessionId: 'parent', ownerTurnId: 'other-turn', command: 'rescue', status: 'running' },
    { id: 'job-wrong-command', workspace: '/repo', ownerSessionId: 'parent', ownerTurnId: 'parent-turn', command: 'review', status: 'running' },
    { id: 'job-bound', workspace: '/repo', ownerSessionId: 'parent', ownerTurnId: 'parent-turn', command: 'rescue', status: 'running', phase: 'running', lastActivityAt: '2026-08-17T00:00:00.000Z', progressPreview: preview, workerLeaseId: 'PRIVATE_WORKER', resultArtifact: 'PRIVATE_ARTIFACT' },
  ];
  let requested;
  const result = await readBoundRescueStatus({
    store: { readBoundRescueCurrentJob: async (/** @type {any} */ input) => { requested = input; return jobs[2]; } },
    workspace: '/repo',
    executor: { parentSessionId: 'parent', agentId: 'child' },
  });

  assert.deepEqual(requested, { workspace: '/repo', parentSessionId: 'parent', executorAgentId: 'child' });
  assert.deepEqual(Object.keys(result), ['type', 'status', 'phase', 'lastActivityAt', 'progressPreview', 'terminal']);
  assert.deepEqual(result, {
    type: 'rescue-status', status: 'running', phase: 'running', lastActivityAt: '2026-08-17T00:00:00.000Z',
    progressPreview: ['two', 'three', 'four', 'five'], terminal: false,
  });
  assert.notEqual(result.progressPreview, preview);
  assert.doesNotMatch(JSON.stringify(result), /job-|parent|repo|worker|artifact|PRIVATE/i);

  const terminal = await readBoundRescueStatus({
    store: { readBoundRescueCurrentJob: async () => ({ ...jobs[2], status: 'succeeded', phase: 'finalizing' }) },
    workspace: '/repo', executor: { parentSessionId: 'parent', agentId: 'child' },
  });
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.status, 'succeeded');
});

test('bound Rescue status maps exact binding lookup failures to fixed safe errors', async () => {
  const executor = { parentSessionId: 'parent', agentId: 'child' };
  const matching = { id: 'job-bound', workspace: '/repo', ownerSessionId: 'parent', ownerTurnId: 'parent-turn', command: 'rescue', status: 'succeeded', updatedAt: '2026-08-17T00:00:00.000Z' };
  await assert.rejects(readBoundRescueStatus({ store: { readBoundRescueCurrentJob: async () => { throw new PluginError('RESCUE_BINDING_CLOSED', 'private'); } }, workspace: '/repo', executor }), { code: 'BOUND_RESCUE_STATUS_NOT_FOUND' });
  await assert.rejects(readBoundRescueStatus({ store: {}, workspace: '/repo', executor }), { code: 'BOUND_RESCUE_STATUS_INPUT_INVALID' });
  await assert.rejects(readBoundRescueStatus({ store: { readBoundRescueCurrentJob: async () => matching }, workspace: '/repo', executor: /** @type {any} */ ({}) }), { code: 'BOUND_RESCUE_STATUS_INPUT_INVALID' });
  await assert.rejects(
    readBoundRescueStatus({ store: { readBoundRescueCurrentJob: async () => { throw new PluginError('PRIVATE_STATE_FAILURE', 'PRIVATE_JOB_ID'); } }, workspace: '/repo', executor }),
    (/** @type {any} */ error) => error?.code === 'BOUND_RESCUE_STATUS_UNAVAILABLE' && error.message === 'Bound Rescue status is unavailable.' && Object.keys(error.details).length === 0,
  );
});

test('latest selection is canonical-workspace and owner confined', async () => {
  const { workspace, store, controller } = await setup();
  const mine = await store.reserveJob({ workspace, ...reservation });
  await store.reserveJob({ workspace, ...reservation, ownerSessionId: 'session-b', readOnly: true });
  assert.equal((await controller.selectOwned(workspace, 'session-a')).id, mine.id);
  assert.equal((await controller.listOwned(workspace, 'session-a')).length, 1);
});

test('owned client selection ignores a corrupt foreign job through its trusted owner binding', async () => {
  const { root, workspace, store, controller } = await setup();
  const mine = await store.reserveJob({ workspace, ...reservation, readOnly: true });
  const foreign = await store.reserveJob({ workspace, ...reservation, ownerSessionId: 'session-b', readOnly: true });
  const storage = await resolveWorkspaceStorage({ dataRoot: join(root, 'data'), workspace });
  await writeFile(join(storage.directory, 'jobs', `${foreign.id}.json`), '{');

  assert.deepEqual((await controller.listOwned(workspace, 'session-a')).map((/** @type {any} */ job) => job.id), [mine.id]);
  assert.equal((await controller.selectOwned(workspace, 'session-a', mine.id)).id, mine.id);
});

test('implicit cancel and result use command-specific eligibility while explicit IDs stay exact', async () => {
  const { root, workspace, store, controller } = await setup();
  const succeeded = await store.reserveJob({ workspace, ...reservation, readOnly: true, ownerTurnId: 'succeeded' });
  await store.transitionJob(workspace, succeeded.id, ['queued'], 'running');
  await store.transitionJob(workspace, succeeded.id, ['running'], 'succeeded', { resultArtifact: `results/${succeeded.id}.md` });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const failed = await store.reserveJob({ workspace, ...reservation, readOnly: true, ownerTurnId: 'failed' });
  await store.transitionJob(workspace, failed.id, ['queued'], 'failed', { error: 'failed' });
  assert.equal((await controller.selectOwned(workspace, 'session-a', undefined, 'result')).id, failed.id);
  await new Promise((resolve) => setTimeout(resolve, 2));
  const cancelled = await store.reserveJob({ workspace, ...reservation, readOnly: true, ownerTurnId: 'cancelled' });
  await store.transitionJob(workspace, cancelled.id, ['queued'], 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 2));
  const active = await store.reserveJob({ workspace, ...reservation, readOnly: true, ownerTurnId: 'active' });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const sibling = await store.reserveJob({ workspace, ...reservation, ownerSessionId: 'session-b', readOnly: true, ownerTurnId: 'sibling' });
  await store.transitionJob(workspace, sibling.id, ['queued'], 'failed', { error: 'sibling failed' });
  const otherWorkspace = join(root, 'other-workspace'); await mkdir(otherWorkspace);
  const other = await store.reserveJob({ workspace: otherWorkspace, ...reservation, readOnly: true, ownerTurnId: 'other-workspace' });
  await store.transitionJob(otherWorkspace, other.id, ['queued'], 'cancelled');

  assert.equal((await controller.selectOwned(workspace, 'session-a', undefined, 'cancel')).id, active.id);
  assert.equal((await controller.selectOwned(workspace, 'session-a', undefined, 'result')).id, cancelled.id);
  assert.equal((await controller.selectOwned(workspace, 'session-a', failed.id, 'result')).id, failed.id, 'explicit result IDs retain exact prior selection');
  assert.equal((await controller.selectOwned(workspace, 'session-a', active.id, 'result')).id, active.id, 'explicit active result IDs remain exact');
  assert.equal((await controller.selectOwned(workspace, 'session-a', succeeded.id, 'cancel')).id, succeeded.id, 'explicit cancel IDs retain exact idempotent selection');
  await assert.rejects(controller.selectOwned(workspace, 'session-a', sibling.id, 'result'), { code: 'OWNED_JOB_NOT_FOUND' });
  await assert.rejects(controller.selectOwned(workspace, 'session-a', other.id, 'result'), { code: 'OWNED_JOB_NOT_FOUND' });
});

test('wait reaches terminal state or returns a stable timeout error', async () => {
  const { workspace, store, controller } = await setup();
  const job = await store.reserveJob({ workspace, ...reservation });
  setTimeout(() => { void store.transitionJob(workspace, job.id, ['queued'], 'cancelled'); }, 5);
  assert.equal((await controller.wait(workspace, job.id, 100)).status, 'cancelled');
  const active = await store.reserveJob({ workspace, ...reservation });
  await assert.rejects(controller.wait(workspace, active.id, 0), { code: 'JOB_WAIT_TIMEOUT' });
});

test('wait rejects an already-aborted signal before polling', async () => {
  const { workspace, store } = await setup();
  const job = await store.reserveJob({ workspace, ...reservation });
  const interruption = new PluginError('JOB_INTERRUPTED', 'Interrupted by SIGINT.');
  const abort = new AbortController(); abort.abort(interruption);
  let polls = 0;
  const controller = createJobController({ store, beforeWaitPoll: async () => { polls += 1; } });
  await assert.rejects(controller.wait(workspace, job.id, 100, abort.signal), (error) => error === interruption);
  assert.equal(polls, 0);
});

test('wait interrupts a pending poll and handles its later rejection', async () => {
  const { workspace, store } = await setup();
  const job = await store.reserveJob({ workspace, ...reservation });
  /** @type {()=>void} */ let startPoll = () => {};
  /** @type {Promise<void>} */ const pollStarted = new Promise((resolve) => { startPoll = resolve; });
  /** @type {(error:Error)=>void} */ let rejectPoll = () => {};
  const controller = createJobController({ store, beforeWaitPoll: () => new Promise((resolve, reject) => { void resolve; rejectPoll = reject; startPoll(); }) });
  const abort = new AbortController();
  const interruption = new PluginError('JOB_INTERRUPTED', 'Interrupted by SIGTERM.');
  const waiting = controller.wait(workspace, job.id, 10_000, abort.signal);
  await pollStarted; abort.abort(interruption);
  const outcome = await Promise.race([
    waiting.catch((error) => error),
    new Promise((resolve) => setTimeout(() => resolve('deadline'), 25)),
  ]);
  assert.equal(outcome, interruption);
  rejectPoll(new Error('late reconciliation failure'));
  await new Promise((resolve) => setImmediate(resolve));
});

test('wait clears its polling timer and abort listener when interrupted', { timeout: 5_000 }, async () => {
  const { workspace, store } = await setup();
  const job = await store.reserveJob({ workspace, ...reservation });
  const timerToken = { timer: true };
  /** @type {()=>void} */ let releasePoll = () => {};
  /** @type {Promise<void>} */ const pollGate = new Promise((resolve) => { releasePoll = resolve; });
  /** @type {()=>void} */ let announceTimer = () => {};
  /** @type {Promise<void>} */ const timerStarted = new Promise((resolve) => { announceTimer = resolve; });
  let cleared;
  const controller = createJobController({
    store,
    pollIntervalMs: 1_000,
    beforeWaitPoll: () => pollGate,
    setTimeout: () => { announceTimer(); return timerToken; },
    clearTimeout: (token) => { cleared = token; },
  });
  const abort = new AbortController();
  const interruption = new PluginError('JOB_INTERRUPTED', 'Interrupted by SIGINT.');
  const waiting = controller.wait(workspace, job.id, 10_000, abort.signal);
  releasePoll();
  await timerStarted;
  assert.equal(getEventListeners(abort.signal, 'abort').length, 1);
  abort.abort(interruption);
  await assert.rejects(waiting, (error) => error === interruption);
  assert.equal(cleared, timerToken);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('queued cancellation is safe and terminal cancellation is idempotent', async () => {
  const { workspace, store, controller } = await setup();
  const queued = await store.reserveJob({ workspace, ...reservation });
  assert.equal((await controller.cancel(workspace, queued.id, 'session-a')).status, 'cancelled');
  assert.equal((await controller.cancel(workspace, queued.id, 'session-a')).status, 'cancelled');
});

test('queued and running cancellation return a durable cancelled winner after attempt evidence faults', async () => {
  for (const initialStatus of ['queued', 'running']) {
    const { root, workspace, store } = await setup();
    const job = await store.reserveJob({ workspace, ...reservation, ownerTurnId: `turn-${initialStatus}` });
    if (initialStatus === 'running') await store.transitionJob(workspace, job.id, ['queued'], 'running', { zcodeSessionId: `zs-${initialStatus}` });
    const attemptFile = await attemptFixture(root, workspace, job.id); let stops = 0; let injected = false;
    const wrapped = {
      ...store,
      /** @param {string} workspaceArg @param {string} jobIdArg @param {string[]} expectedStatuses @param {string} nextStatus @param {Record<string,unknown>} [patch] */
      finishJob: async (workspaceArg, jobIdArg, expectedStatuses, nextStatus, patch = {}) => {
        const winner = await store.finishJob(workspaceArg, jobIdArg, expectedStatuses, nextStatus, patch);
        if (!injected) { injected = true; await atomicWriteJson(attemptFile.path, { broken: true }); }
        return winner;
      },
    };
    const controller = createJobController({ store: wrapped, dataRoot: join(root, 'data'), stopSession: async () => { stops += 1; } });
    const cancelled = await controller.cancel(workspace, job.id, 'session-a');
    assert.equal(cancelled.status, 'cancelled', initialStatus);
    assert.equal((await store.readJob(workspace, job.id)).status, 'cancelled', initialStatus);
    assert.deepEqual(await attemptFile.read(), { broken: true }, `${initialStatus}: auxiliary attempt evidence stays conservative`);
    assert.equal((await controller.cancel(workspace, job.id, 'session-a')).status, 'cancelled', initialStatus);
    assert.equal(stops, initialStatus === 'running' ? 1 : 0, `${initialStatus}: terminal retry must not stop again`);
  }
});

test('queued and running cancellation return an exact durable cancelled winner when finish applies then throws', async () => {
  for (const initialStatus of ['queued', 'running']) {
    const { root, workspace, store } = await setup(); const dataRoot = join(root, 'data');
    const job = await store.reserveJob({ workspace, ...reservation, ownerTurnId: `apply-then-throw-${initialStatus}` });
    if (initialStatus === 'running') await store.transitionJob(workspace, job.id, ['queued'], 'running', { zcodeSessionId: `zs-${initialStatus}` });
    const storageError = new PluginError('ATOMIC_WRITE_FAILED', `${initialStatus} finish reported a late write failure`, { category: 'storage', remedy: 'retry' }); let stops = 0; let applied = 0;
    const wrapped = {
      ...store,
      finishJob: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobIdArg, /** @type {string[]} */ expected, /** @type {string} */ next, /** @type {Record<string,unknown>} */ patch = {}) => {
        const winner = await store.finishJob(workspaceArg, jobIdArg, expected, next, patch); applied += 1; assert.equal(winner.status, 'cancelled'); throw storageError;
      },
    };
    const controller = createJobController({ store: wrapped, dataRoot, stopSession: async () => { stops += 1; } });
    const winner = await controller.cancel(workspace, job.id, job.ownerSessionId);
    assert.equal(applied, 1); assert.equal(winner.id, job.id); assert.equal(winner.ownerSessionId, job.ownerSessionId); assert.equal(winner.status, 'cancelled');
    assert.equal((await controller.cancel(workspace, job.id, job.ownerSessionId)).status, 'cancelled');
    assert.equal(stops, initialStatus === 'running' ? 1 : 0, `${initialStatus} winner must prevent a second stop`);
  }
});

test('durable cancelled winner resolution preserves the initiating error on ambiguous identity, state, or read failure', async () => {
  const original = new PluginError('ATOMIC_WRITE_FAILED', 'original finalize error', { category: 'storage', remedy: 'retry' });
  const exact = { id: 'a'.repeat(64), ownerSessionId: 'owner-a', status: 'cancelled' };
  for (const readJob of [
    async () => ({ ...exact, id: 'b'.repeat(64) }),
    async () => ({ ...exact, ownerSessionId: 'owner-b' }),
    async () => ({ ...exact, status: 'cancelling' }),
    async () => { throw new Error('winner read unavailable'); },
  ]) await assert.rejects(durableCancelledWinner({ store: { readJob }, workspace: '/workspace', jobId: exact.id, ownerSessionId: exact.ownerSessionId }, original), (error) => error === original);
});

test('queued apply-before cancel finalization preserves the original error and nonterminal job', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  const storageError = new PluginError('ATOMIC_WRITE_FAILED', 'queued finish failed before apply', { category: 'storage', remedy: 'retry' });
  const controller = createJobController({
    store: { ...store, finishJob: async () => { throw storageError; } },
    dataRoot: join(root, 'data'),
  });
  await assert.rejects(controller.cancel(workspace, job.id, job.ownerSessionId), (error) => error === storageError);
  assert.equal((await store.readJob(workspace, job.id)).status, 'queued');
});

test('cancellation retains a queued job already claimed by a potentially live worker', async () => {
  const { root, store, workspace } = await setup(); const dataRoot = join(root, 'data');
  const job = await store.reserveJob({ workspace, ownerSessionId: 'owner', ownerTurnId: 'turn', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } });
  await store.claimJobWorker(workspace, job.id, { childPid: process.pid, workerLeaseId: 'a'.repeat(64) });
  const controller = createJobController({ store, dataRoot });
  await assert.rejects(controller.cancel(workspace, job.id, 'owner'), { code: 'JOB_CANCEL_FAILED' });
  assert.equal((await store.readJob(workspace, job.id)).status, 'queued');
  await assert.rejects(store.reserveJob({ workspace, ownerSessionId: 'owner', ownerTurnId: 'later', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } }), { code: 'WRITABLE_JOB_EXISTS' });
});

test('running cancellation acknowledges stop and restores running on stop failure', async () => {
  const { workspace, store } = await setup();
  const job = await store.reserveJob({ workspace, ...reservation });
  await store.transitionJob(workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'zs' });
  const ok = createJobController({ store, stopSession: async () => ({}) });
  assert.equal((await ok.cancel(workspace, job.id, 'session-a')).status, 'cancelled');

  const failed = await store.reserveJob({ workspace, ...reservation });
  await store.transitionJob(workspace, failed.id, ['queued'], 'running', { zcodeSessionId: 'zs2' });
  const bad = createJobController({ store, stopSession: async () => { throw new Error('refused'); } });
  await assert.rejects(bad.cancel(workspace, failed.id, 'session-a'), { code: 'JOB_CANCEL_FAILED' });
  const restored = await store.readJob(workspace, failed.id);
  assert.equal(restored.status, 'running'); assert.match(String(restored.lastCancelError), /refused/);
});

test('failed cancellation is durably settled and a later immediate caller starts a new attempt', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation }); await store.transitionJob(workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'zs' });
  const attemptFile = await attemptFixture(root, workspace, job.id); let failedStops = 0;
  await assert.rejects(createJobController({ store, stopSession: async () => { failedStops += 1; throw new Error('refused'); } }).cancel(workspace, job.id, 'session-a'), { code: 'JOB_CANCEL_FAILED' });
  const failed = await attemptFile.read(); assert.equal(failed.status, 'failed'); assert.equal(failed.error.message, 'refused'); assert.match(failed.attemptId, /^[a-f0-9]{64}$/); const attemptStat = await stat(attemptFile.path); if (process.platform === 'win32') assert.equal(attemptStat.isFile(), true); else assert.equal(attemptStat.mode & 0o777, 0o600);
  let retryStops = 0; assert.equal((await createJobController({ store, stopSession: async () => { retryStops += 1; } }).cancel(workspace, job.id, 'session-a')).status, 'cancelled');
  const succeeded = await attemptFile.read(); assert.equal(succeeded.status, 'succeeded'); assert.notEqual(succeeded.attemptId, failed.attemptId); assert.equal(failedStops, 1); assert.equal(retryStops, 1);
});

test('a new active attempt is durable before the first job transition', async () => {
  for (const initialStatus of ['queued', 'running']) {
    const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation }); if (initialStatus === 'running') await store.transitionJob(workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'zs' }); const attemptFile = await attemptFixture(root, workspace, job.id);
    /** @type {any} */
    let observed;
    const observe = async () => { observed ??= await attemptFile.read(); };
    const wrapped = { ...store, transitionJob: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobIdArg, /** @type {string[]} */ expected, /** @type {string} */ next, /** @type {Record<string,unknown>} */ patchArg = {}) => { await observe(); return store.transitionJob(workspaceArg, jobIdArg, expected, next, patchArg); }, finishJob: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobIdArg, /** @type {string[]} */ expected, /** @type {string} */ next, /** @type {Record<string,unknown>} */ patchArg = {}) => { await observe(); return store.finishJob(workspaceArg, jobIdArg, expected, next, patchArg); } };
    assert.equal((await createJobController({ store: wrapped, stopSession: async () => {} }).cancel(workspace, job.id, 'session-a')).status, 'cancelled'); assert.ok(observed); assert.equal(observed.status, 'active'); assert.match(observed.attemptId, /^[a-f0-9]{64}$/);
  }
});

test('observation hook runs after attempt capture and before the lock probe', async () => {
  const { workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation }); let observations = 0;
  const controller = createJobController({ store, afterObservationBeforeLock: async () => { observations += 1; } });
  assert.equal((await controller.cancel(workspace, job.id, 'session-a')).status, 'cancelled'); assert.equal(observations, 1);
});

test('nonterminal cancellation fails closed on corrupt or mismatched attempt records', async () => {
  for (const record of [{ broken: true }, { jobId: 'wrong', ownerSessionId: 'session-a', attemptId: 'd'.repeat(64), status: 'active', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]) {
    const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation }); const attemptFile = await attemptFixture(root, workspace, job.id); await atomicWriteJson(attemptFile.path, record);
    await assert.rejects(createJobController({ store }).cancel(workspace, job.id, 'session-a'), { code: 'CANCEL_ATTEMPT_RECORD_INVALID' }); assert.equal((await store.readJob(workspace, job.id)).status, 'queued');
  }
});

test('terminal cancellation ignores a stale corrupt attempt record', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation }); const controller = createJobController({ store }); assert.equal((await controller.cancel(workspace, job.id, 'session-a')).status, 'cancelled');
  const attemptFile = await attemptFixture(root, workspace, job.id); await atomicWriteJson(attemptFile.path, { broken: true }); assert.equal((await createJobController({ store }).cancel(workspace, job.id, 'session-a')).status, 'cancelled');
});

test('concurrent cancellation calls stop once and both observe cancelled', async () => {
  const { workspace, store } = await setup();
  const job = await store.reserveJob({ workspace, ...reservation });
  await store.transitionJob(workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'zs' });
  let stops = 0; let release = () => {};
  const gate = new Promise((resolve) => { release = () => resolve(undefined); });
  const controller = createJobController({ store, pollIntervalMs: 1, stopSession: async () => { stops += 1; await gate; } });
  const first = controller.cancel(workspace, job.id, 'session-a');
  while ((await store.readJob(workspace, job.id)).status !== 'cancelling') await new Promise((resolve) => setTimeout(resolve, 1));
  const second = controller.cancel(workspace, job.id, 'session-a');
  release();
  const results = await Promise.all([first, second]);
  assert.equal(stops, 1); assert.deepEqual(results.map(({ status }) => status), ['cancelled', 'cancelled']);
});

test('overlapping failed cancellations join one in-flight attempt through rollback settlement', async () => {
  const { workspace, store } = await setup();
  const job = await store.reserveJob({ workspace, ...reservation });
  await store.transitionJob(workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'zs' });
  let stops = 0; let releaseSettlement = () => {}; let markRollback = () => {}; let hookCalls = 0;
  const settlementGate = new Promise((resolve) => { releaseSettlement = () => resolve(undefined); });
  const rollbackReached = new Promise((resolve) => { markRollback = () => resolve(undefined); });
  const controller = createJobController({ store, stopSession: async () => { stops += 1; throw new Error('refused'); }, afterRollbackBeforeSettle: async () => { hookCalls += 1; if (hookCalls === 1) { markRollback(); await settlementGate; } } });
  const first = controller.cancel(workspace, job.id, 'session-a');
  await Promise.race([rollbackReached, first.then(() => { throw new Error('leader settled before rollback hook'); }, () => { throw new Error('leader settled before rollback hook'); })]);
  const second = controller.cancel(workspace, job.id, 'session-a'); releaseSettlement();
  const concurrent = await Promise.allSettled([first, second]); assert.equal(stops, 1);
  assert.ok(concurrent.every(({ status }) => status === 'rejected')); const [firstError, secondError] = concurrent.map((result) => result.status === 'rejected' ? result.reason : null);
  assert.equal(secondError, firstError); assert.deepEqual({ code: firstError.code, message: firstError.message }, { code: 'JOB_CANCEL_FAILED', message: `Could not cancel job ${job.id}: refused` });
  const restored = await store.readJob(workspace, job.id); assert.equal(restored.status, 'running'); assert.equal(restored.lastCancelError, 'refused');
  await assert.rejects(controller.cancel(workspace, job.id, 'session-a'), { code: 'JOB_CANCEL_FAILED', message: `Could not cancel job ${job.id}: refused` });
  assert.equal(stops, 2); assert.equal((await store.readJob(workspace, job.id)).status, 'running');
});

test('a caller joins an attempt completed between observation and immediate lock acquisition', async () => {
  const { workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation }); await store.transitionJob(workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'zs' });
  let stops = 0; let releaseLeader = () => {}; let stopEntered = () => {}; const leaderGate = new Promise((resolve) => { releaseLeader = () => resolve(undefined); }); const leaderStopping = new Promise((resolve) => { stopEntered = () => resolve(undefined); });
  const leaderController = createJobController({ store, stopSession: async () => { stops += 1; stopEntered(); await leaderGate; throw new Error('refused'); } }); const leader = leaderController.cancel(workspace, job.id, 'session-a'); await leaderStopping;
  let releaseFollower = () => {}; let observationDone = () => {}; const followerGate = new Promise((resolve) => { releaseFollower = () => resolve(undefined); }); const followerObserved = new Promise((resolve) => { observationDone = () => resolve(undefined); });
  const followerController = createJobController({ store, afterObservationBeforeLock: async () => { observationDone(); await followerGate; }, stopSession: async () => { stops += 1; throw new Error('unexpected retry'); } }); const follower = followerController.cancel(workspace, job.id, 'session-a'); await followerObserved;
  releaseLeader(); const leaderError = await leader.then(() => null, (error) => error); assert.equal(leaderError.code, 'JOB_CANCEL_FAILED'); releaseFollower();
  await assert.rejects(follower, { code: 'JOB_CANCEL_FAILED', message: leaderError.message }); assert.equal(stops, 1);
  assert.equal((await createJobController({ store, stopSession: async () => { stops += 1; } }).cancel(workspace, job.id, 'session-a')).status, 'cancelled'); assert.equal(stops, 2);
});

test('new and replacement attempts completed after observation are joined on immediate acquisition', async () => {
  for (const observedState of ['missing', 'historical-failed']) {
    const { workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation }); await store.transitionJob(workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'zs' });
    if (observedState === 'historical-failed') await assert.rejects(createJobController({ store, stopSession: async () => { throw new Error('historical'); } }).cancel(workspace, job.id, 'session-a'), { code: 'JOB_CANCEL_FAILED' });
    let releaseFollower = () => {}; let observationDone = () => {}; const followerGate = new Promise((resolve) => { releaseFollower = () => resolve(undefined); }); const followerObserved = new Promise((resolve) => { observationDone = () => resolve(undefined); }); let stops = 0;
    const follower = createJobController({ store, afterObservationBeforeLock: async () => { observationDone(); await followerGate; }, stopSession: async () => { stops += 1; throw new Error('unexpected retry'); } }).cancel(workspace, job.id, 'session-a'); await followerObserved;
    const leader = createJobController({ store, stopSession: async () => { stops += 1; throw new Error('current refusal'); } }).cancel(workspace, job.id, 'session-a'); const leaderError = await leader.then(() => null, (error) => error); assert.equal(leaderError.code, 'JOB_CANCEL_FAILED'); releaseFollower();
    await assert.rejects(follower, { code: 'JOB_CANCEL_FAILED', message: leaderError.message }); assert.equal(stops, 1);
  }
});

test('operation LOCK_TIMEOUT errors are not mistaken for cancel-lock contention', async () => {
  for (const failingOperation of ['read', 'transition']) {
    const { workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
    await store.transitionJob(workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'zs' });
    let reads = 0; let transitions = 0; let followers = 0; let stops = 0;
    const wrapped = {
      ...store,
      readJob: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobIdArg) => { reads += 1; if (failingOperation === 'read') throw new PluginError('LOCK_TIMEOUT', 'inner read lock timed out', { category: 'storage', remedy: 'retry' }); return store.readJob(workspaceArg, jobIdArg); },
      transitionJob: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobIdArg, /** @type {string[]} */ expected, /** @type {string} */ next, /** @type {Record<string,unknown>} */ patch = {}) => { transitions += 1; if (failingOperation === 'transition') throw new PluginError('LOCK_TIMEOUT', 'inner transition lock timed out', { category: 'storage', remedy: 'retry' }); return store.transitionJob(workspaceArg, jobIdArg, expected, next, patch); },
    };
    const controller = createJobController({ store: wrapped, afterFollowerSelected: async () => { followers += 1; }, stopSession: async () => { stops += 1; } });
    await assert.rejects(controller.cancel(workspace, job.id, 'session-a'), { code: 'LOCK_TIMEOUT' });
    assert.equal(followers, 0); assert.equal(stops, 0); assert.equal(reads, 1); assert.equal(transitions, failingOperation === 'transition' ? 1 : 0); assert.equal((await store.readJob(workspace, job.id)).status, 'running');
  }
});

test('finalize failure after stop acknowledgement preserves cancelling for reconciliation', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation }); await store.transitionJob(workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'zs' }); const attemptFile = await attemptFixture(root, workspace, job.id);
  let failFinalize = true; let stops = 0;
  const wrapped = { ...store, finishJob: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobIdArg, /** @type {string[]} */ expected, /** @type {string} */ next, /** @type {Record<string,unknown>} */ patch = {}) => { if (failFinalize) { failFinalize = false; throw new PluginError('JSON_WRITE_FAILED', 'disk failed', { category: 'storage', remedy: 'retry' }); } return store.finishJob(workspaceArg, jobIdArg, expected, next, patch); } };
  const controller = createJobController({ store: wrapped, stopSession: async () => { stops += 1; } });
  await assert.rejects(controller.cancel(workspace, job.id, 'session-a'), { code: 'JOB_CANCEL_FINALIZE_FAILED' }); assert.equal(stops, 1); assert.equal((await store.readJob(workspace, job.id)).status, 'cancelling'); const pending = await attemptFile.read(); assert.equal(pending.status, 'finalize-pending');
  assert.equal((await controller.cancel(workspace, job.id, 'session-a')).status, 'cancelled'); const succeeded = await attemptFile.read(); assert.equal(stops, 1); assert.equal(succeeded.attemptId, pending.attemptId); assert.equal(succeeded.status, 'succeeded');
});

test('apply-before cancel finalization plus winner-read failure preserves finalize-pending and the original error', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation }); await store.transitionJob(workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'zs' }); const attemptFile = await attemptFixture(root, workspace, job.id);
  const storageError = new PluginError('ATOMIC_WRITE_FAILED', 'finish failed before apply', { category: 'storage', remedy: 'retry' }); let failFinalize = true; let winnerReadFailed = false; let finalizeStarted = false; let stops = 0;
  const wrapped = {
    ...store,
    readJob: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobIdArg) => { if (finalizeStarted && !winnerReadFailed) { winnerReadFailed = true; throw new Error('winner read unavailable'); } return store.readJob(workspaceArg, jobIdArg); },
    finishJob: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobIdArg, /** @type {string[]} */ expected, /** @type {string} */ next, /** @type {Record<string,unknown>} */ patch = {}) => { if (failFinalize) { failFinalize = false; finalizeStarted = true; throw storageError; } return store.finishJob(workspaceArg, jobIdArg, expected, next, patch); },
  };
  const controller = createJobController({ store: wrapped, stopSession: async () => { stops += 1; } });
  await assert.rejects(controller.cancel(workspace, job.id, job.ownerSessionId), (error) => error instanceof PluginError && error.code === 'JOB_CANCEL_FINALIZE_FAILED' && error.cause === storageError);
  assert.equal(winnerReadFailed, true); assert.equal((await store.readJob(workspace, job.id)).status, 'cancelling'); assert.equal((await attemptFile.read()).status, 'finalize-pending'); assert.equal(stops, 1);
  assert.equal((await controller.cancel(workspace, job.id, job.ownerSessionId)).status, 'cancelled'); assert.equal(stops, 1);
});

test('cancel finalization timestamps after progress persisted concurrently with stop acknowledgement', async () => {
  const { workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  await store.transitionJob(workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'zs' });
  let raced = false;
  const wrapped = {
    ...store,
    finishJob: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobId, /** @type {string[]} */ expected, /** @type {string} */ next, /** @type {Record<string,unknown>} */ patch = {}) => {
      if (!raced) {
        raced = true;
        await store.updateJobProgress(workspaceArg, jobId, { phase: 'waiting', message: 'Worker completed cancellation cleanup.', observedAt: new Date().toISOString() });
      }
      return store.finishJob(workspaceArg, jobId, expected, next, patch);
    },
  };
  const cancelled = await createJobController({ store: wrapped, stopSession: async () => {} }).cancel(workspace, job.id, 'session-a');
  assert.equal(raced, true); assert.equal(cancelled.status, 'cancelled');
  assert.ok(Date.parse(cancelled.finishedAt) >= Date.parse(cancelled.lastActivityAt));
});

test('resume candidates are only latest owned rescue sessions', async () => {
  const { workspace, store, controller } = await setup();
  const review = await store.reserveJob({ workspace, ...reservation, command: 'review', readOnly: true });
  await store.transitionJob(workspace, review.id, ['queued'], 'running', { zcodeSessionId: 'review-session' });
  const rescue = await store.reserveJob({ workspace, ...reservation, readOnly: true });
  await store.transitionJob(workspace, rescue.id, ['queued'], 'running', { zcodeSessionId: 'rescue-session' });
  await store.transitionJob(workspace, rescue.id, ['running'], 'failed', { error: 'turn failed' });
  assert.equal((await controller.resumeCandidate(workspace, 'session-a')).id, rescue.id);
});

test('executor failure cannot steal cancellation terminal ownership', async () => {
  const { root, workspace, store } = await setup();
  const job = await store.reserveJob({ workspace, ...reservation });
  let rejectCompletion = () => {};
  let signalWaitStarted = () => {};
  const waitStarted = new Promise((resolve) => { signalWaitStarted = () => resolve(undefined); });
  const completion = new Promise((resolve, reject) => { rejectCompletion = () => reject(new Error('stopped')); });
  const client = {
    createSession: async () => ({ session: { sessionId: 'zs' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } } }),
    setPermissionHandler: () => {}, subscribe: silentSubscribe, send: async () => ({ inputId: 'input-cancel-race', stateRevision: 1 }), waitForCompletion: () => { signalWaitStarted(); return completion; },
    readSession: async () => ({}), close: async () => {},
  };
  const execution = executeJob({ job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task' });
  const executionFailure = assert.rejects(execution, /stopped/);
  while ((await store.readJob(workspace, job.id)).status !== 'running') await new Promise((resolve) => setTimeout(resolve, 1));
  await waitStarted;
  const controller = createJobController({ store, stopSession: async () => { rejectCompletion(); } });
  const cancellation = controller.cancel(workspace, job.id, 'session-a');
  await executionFailure;
  assert.equal((await cancellation).status, 'cancelled');
  assert.equal((await store.readJob(workspace, job.id)).status, 'cancelled');
});

test('foreground interruption after an accepted send stops exactly once and durably cancels without a result', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  const controller = new AbortController(); let stops = 0; let waitStarted = () => {};
  const waiting = new Promise((resolve) => { waitStarted = () => resolve(undefined); });
  const completion = new Promise(() => {});
  const interruption = new PluginError('JOB_INTERRUPTED', 'interrupted', { category: 'interruption', remedy: 'retry' });
  const client = {
    createSession: async () => ({ session: { sessionId: 'zs-interrupted' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } }, messages: [] }),
    setPermissionHandler: () => {}, subscribe: silentSubscribe,
    send: async () => ({ inputId: 'input-interrupted', stateRevision: 4 }),
    waitForCompletion: () => { waitStarted(); return completion; },
    stopSession: async (/** @type {string} */ sessionId) => { assert.equal(sessionId, 'zs-interrupted'); stops += 1; }, close: async () => {},
  };
  const execution = executeJob({ job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task', signal: controller.signal });
  await waiting; controller.abort(interruption);
  await assert.rejects(execution, (error) => error === interruption);
  const persisted = await store.readJob(workspace, job.id);
  assert.equal(stops, 1); assert.equal(persisted.status, 'cancelled'); assert.ok(persisted.finishedAt);
  assert.equal(persisted.resultArtifact, undefined);
});

test('send transport rejection after abort preserves the interruption and stops exactly once', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  const controller = new AbortController(); let stops = 0;
  const interruption = new PluginError('JOB_INTERRUPTED', 'send interrupted', { category: 'interruption', remedy: 'retry' });
  const client = {
    createSession: async () => ({ session: { sessionId: 'zs-send-reject' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } }, messages: [] }),
    setPermissionHandler: () => {}, subscribe: silentSubscribe,
    send: async () => { controller.abort(interruption); throw new Error('transport closed after abort'); },
    stopSession: async (/** @type {string} */ sessionId) => { assert.equal(sessionId, 'zs-send-reject'); stops += 1; }, close: async () => {},
  };
  await assert.rejects(executeJob({ job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task', signal: controller.signal }), (error) => error === interruption);
  const persisted = await store.readJob(workspace, job.id);
  assert.equal(stops, 1); assert.equal(persisted.status, 'cancelled'); assert.equal(persisted.resultArtifact, undefined);
});

test('foreground interruption keeps running on stop failure, bounds the error, and rethrows the interruption', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  const controller = new AbortController(); let waitStarted = () => {};
  const waiting = new Promise((resolve) => { waitStarted = () => resolve(undefined); });
  const interruption = new PluginError('JOB_INTERRUPTED', 'interrupted', { category: 'interruption', remedy: 'retry' });
  const client = {
    createSession: async () => ({ session: { sessionId: 'zs-stop-refused' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } }, messages: [] }),
    setPermissionHandler: () => {}, subscribe: silentSubscribe,
    send: async () => ({ inputId: 'input-stop-refused', stateRevision: 5 }), waitForCompletion: () => { waitStarted(); return new Promise(() => {}); },
    stopSession: async () => { throw new Error(`refused-${'x'.repeat(4_000)}`); }, close: async () => {},
  };
  const execution = executeJob({ job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task', signal: controller.signal });
  await waiting; controller.abort(interruption);
  await assert.rejects(execution, (error) => error === interruption);
  const persisted = await store.readJob(workspace, job.id);
  assert.equal(persisted.status, 'running'); assert.match(persisted.lastCancelError, /^refused-/);
  assert.ok(Buffer.byteLength(persisted.lastCancelError) <= 2_048); assert.equal(persisted.finishedAt, undefined);
});

test('completion that wins the signal race remains successful', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  const controller = new AbortController(); let stops = 0;
  const client = {
    createSession: async () => ({ session: { sessionId: 'zs-completion-wins' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } }, messages: [] }),
    setPermissionHandler: () => {}, subscribe: silentSubscribe,
    send: async () => ({ inputId: 'input-completion-wins', stateRevision: 6 }), waitForCompletion: async () => {},
    readSession: async () => { controller.abort(new PluginError('JOB_INTERRUPTED', 'late')); return { projection: { status: 'completed' }, runtime: { stateRevision: 6 }, messages: [{ info: { role: 'assistant', messageId: 'assistant-completion-wins', parentMessageId: 'input-completion-wins' }, parts: [{ type: 'text', text: 'done' }] }] }; },
    stopSession: async () => { stops += 1; }, close: async () => {},
  };
  const result = await executeJob({ job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task', signal: controller.signal });
  assert.equal(result.job.status, 'succeeded'); assert.equal(stops, 0);
  assert.equal((await store.readJob(workspace, job.id)).status, 'succeeded');
});

test('authoritative terminal error fails the job with the exact provider reason instead of partial text', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  const providerReason = ' Provider rejected\n\u0000\u0085\u202e the delegated turn. ';
  const sanitizedReason = 'Provider rejected the delegated turn.';
  const client = {
    createSession: async () => ({ session: { sessionId: 'zs-terminal-error' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } }, messages: [] }),
    setPermissionHandler: () => {}, subscribe: silentSubscribe,
    send: async () => ({ inputId: 'input-terminal-error', stateRevision: 7 }), waitForCompletion: async () => {},
    readSession: async () => ({
      projection: { status: 'error', lastError: { message: providerReason } },
      runtime: { stateRevision: 7 },
      messages: [{ info: { role: 'assistant', messageId: 'assistant-terminal-error', parentMessageId: 'input-terminal-error' }, parts: [{ type: 'text', text: 'partial assistant text' }] }],
    }),
    close: async () => {},
  };

  const caught = await executeJob({ job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task' }).catch((error) => error);
  assert.equal(caught.code, 'ZCODE_TURN_FAILED'); assert.equal(caught.message, sanitizedReason);
  assert.equal(hasPublicControl(caught.message), false);
  const persisted = await store.readJob(workspace, job.id);
  assert.equal(persisted.status, 'failed'); assert.equal(persisted.error.message, sanitizedReason);
  assert.equal(persisted.error.message, caught.message); assert.equal(persisted.error.message.includes(providerReason), false);
  assert.equal(persisted.resultArtifact, undefined);
});

test('fresh active final status stops the exact session before failing the job', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation }); let stops = 0;
  const client = {
    createSession: async () => ({ session: { sessionId: 'zs-active-final' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } }, messages: [] }),
    setPermissionHandler: () => {}, subscribe: silentSubscribe,
    send: async () => ({ inputId: 'input-active-final', stateRevision: 9 }), waitForCompletion: async () => {},
    readSession: async () => ({ projection: { status: 'running' }, runtime: { stateRevision: 9 }, messages: [] }),
    stopSession: async (/** @type {string} */ sessionId) => { assert.equal(sessionId, 'zs-active-final'); stops += 1; }, close: async () => {},
  };

  await assert.rejects(executeJob({ job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task' }), { code: 'ZCODE_TERMINAL_STATE_INVALID' });
  const persisted = await store.readJob(workspace, job.id);
  assert.equal(stops, 1); assert.equal(persisted.status, 'failed');
});

test('unacknowledged stop for a fresh active final status retains the running guard', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation }); let stops = 0;
  const client = {
    createSession: async () => ({ session: { sessionId: 'zs-active-unacknowledged' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } }, messages: [] }),
    setPermissionHandler: () => {}, subscribe: silentSubscribe,
    send: async () => ({ inputId: 'input-active-unacknowledged', stateRevision: 11 }), waitForCompletion: async () => {},
    readSession: async () => ({ projection: { status: 'waiting' }, runtime: { stateRevision: 12 }, messages: [] }),
    stopSession: async (/** @type {string} */ sessionId) => { assert.equal(sessionId, 'zs-active-unacknowledged'); stops += 1; throw new Error(`stop refused ${'x'.repeat(4_000)}`); }, close: async () => {},
  };

  await assert.rejects(executeJob({ job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task' }), { code: 'ZCODE_TERMINAL_STATE_INVALID' });
  const persisted = await store.readJob(workspace, job.id);
  assert.equal(stops, 1); assert.equal(persisted.status, 'running'); assert.match(persisted.lastCancelError, /^stop refused /);
  assert.ok(Buffer.byteLength(persisted.lastCancelError) <= 2_048);
});

test('stale terminal error follows ambiguous stop semantics without persisting its provider message', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation }); let stops = 0;
  const staleProviderReason = 'stale provider detail must not escape';
  const client = {
    createSession: async () => ({ session: { sessionId: 'zs-stale-error' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } }, messages: [] }),
    setPermissionHandler: () => {}, subscribe: silentSubscribe,
    send: async () => ({ inputId: 'input-stale-error', stateRevision: 15 }), waitForCompletion: async () => {},
    readSession: async () => ({ projection: { status: 'error', lastError: { message: staleProviderReason } }, runtime: { stateRevision: 14 }, messages: [] }),
    stopSession: async (/** @type {string} */ sessionId) => { assert.equal(sessionId, 'zs-stale-error'); stops += 1; }, close: async () => {},
  };

  await assert.rejects(
    executeJob({ job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task' }),
    { code: 'ZCODE_TERMINAL_STATE_INVALID', message: 'ZCode completion did not produce a success-compatible terminal state.' },
  );
  const persisted = await store.readJob(workspace, job.id);
  assert.equal(stops, 1); assert.equal(persisted.status, 'failed');
  assert.equal(persisted.error.message, 'ZCode completion did not produce a success-compatible terminal state.');
  assert.notEqual(persisted.error.message, staleProviderReason);
});

test('an interruption before session creation is observed at the safe boundary and cancels the queued job', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  const controller = new AbortController(); const interruption = new PluginError('JOB_INTERRUPTED', 'early'); controller.abort(interruption); let creates = 0;
  const client = { createSession: async () => { creates += 1; }, close: async () => {} };
  await assert.rejects(executeJob({ job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task', signal: controller.signal }), (error) => error === interruption);
  assert.equal(creates, 0); assert.equal((await store.readJob(workspace, job.id)).status, 'cancelled');
});

test('session creation completion observes abort before configuration and stops the known session once', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  const controller = new AbortController(); let permissions = 0; let stops = 0;
  const interruption = new PluginError('JOB_INTERRUPTED', 'create interrupted', { category: 'interruption', remedy: 'retry' });
  const client = {
    createSession: async () => { controller.abort(interruption); return { session: { sessionId: 'zs-create-abort' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } }, messages: [] }; },
    setPermissionHandler: () => { permissions += 1; }, subscribe: silentSubscribe,
    stopSession: async (/** @type {string} */ sessionId) => { assert.equal(sessionId, 'zs-create-abort'); stops += 1; }, close: async () => {},
  };
  await assert.rejects(executeJob({ job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task', signal: controller.signal }), (error) => error === interruption);
  assert.equal(permissions, 0); assert.equal(stops, 1);
  assert.equal((await store.readJob(workspace, job.id)).status, 'cancelled');
});

test('resume transport rejection after abort preserves the interruption and stops the known session once', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  const controller = new AbortController(); let stops = 0;
  const interruption = new PluginError('JOB_INTERRUPTED', 'resume interrupted', { category: 'interruption', remedy: 'retry' });
  const client = {
    resumeSession: async () => { controller.abort(interruption); throw new Error('resume transport closed'); },
    stopSession: async (/** @type {string} */ sessionId) => { assert.equal(sessionId, 'zs-resume-abort'); stops += 1; }, close: async () => {},
  };
  await assert.rejects(executeJob({ job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task', resumeSessionId: 'zs-resume-abort', signal: controller.signal }), (error) => error === interruption);
  assert.equal(stops, 1); assert.equal((await store.readJob(workspace, job.id)).status, 'cancelled');
});

test('model RPC rejection after abort preserves the interruption and stops the known session once', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  const controller = new AbortController(); let stops = 0;
  const interruption = new PluginError('JOB_INTERRUPTED', 'model interrupted', { category: 'interruption', remedy: 'retry' });
  const selectedModel = { providerId: 'p', modelId: 'new' };
  const client = {
    createSession: async () => ({ session: { sessionId: 'zs-model-abort' }, settings: { model: { current: { providerId: 'p', modelId: 'old' }, available: [] } }, messages: [] }),
    subscribe: silentSubscribe, setModel: async () => { controller.abort(interruption); throw new Error('model transport closed'); },
    stopSession: async (/** @type {string} */ sessionId) => { assert.equal(sessionId, 'zs-model-abort'); stops += 1; }, close: async () => {},
  };
  await assert.rejects(executeJob({ job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task', model: selectedModel, signal: controller.signal }), (error) => error === interruption);
  assert.equal(stops, 1); assert.equal((await store.readJob(workspace, job.id)).status, 'cancelled');
});

test('thought RPC rejection after abort preserves the interruption and stops the known session once', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  const controller = new AbortController(); let stops = 0;
  const interruption = new PluginError('JOB_INTERRUPTED', 'thought interrupted', { category: 'interruption', remedy: 'retry' });
  const client = {
    createSession: async () => ({ session: { sessionId: 'zs-thought-abort' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } }, messages: [] }),
    subscribe: silentSubscribe, setThoughtLevel: async () => { controller.abort(interruption); throw new Error('thought transport closed'); },
    stopSession: async (/** @type {string} */ sessionId) => { assert.equal(sessionId, 'zs-thought-abort'); stops += 1; }, close: async () => {},
  };
  await assert.rejects(executeJob({ job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task', effort: 'high', signal: controller.signal }), (error) => error === interruption);
  assert.equal(stops, 1); assert.equal((await store.readJob(workspace, job.id)).status, 'cancelled');
});

test('interruptions are observed immediately before resume and send RPC boundaries', async () => {
  {
    const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation }); const controller = new AbortController(); const interruption = new PluginError('JOB_INTERRUPTED', 'before resume'); let resumes = 0;
    const client = { resumeSession: async () => { resumes += 1; }, close: async () => {} };
    await assert.rejects(executeJob({ job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task', resumeSessionId: 'zs-resume', signal: controller.signal, onBeforeResume: async () => controller.abort(interruption) }), (error) => error === interruption);
    assert.equal(resumes, 0); assert.equal((await store.readJob(workspace, job.id)).status, 'cancelled');
  }
  {
    const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation }); const controller = new AbortController(); const interruption = new PluginError('JOB_INTERRUPTED', 'before send'); let sends = 0; let stops = 0;
    const wrapped = { ...store, transitionJob: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobId, /** @type {string[]} */ expected, /** @type {string} */ next, /** @type {Record<string,any>} */ patch = {}) => { const result = await store.transitionJob(workspaceArg, jobId, expected, next, patch); if (next === 'running' && patch.zcodeSessionId) controller.abort(interruption); return result; } };
    const client = {
      createSession: async () => ({ session: { sessionId: 'zs-before-send' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } }, messages: [] }),
      setPermissionHandler: () => {}, subscribe: silentSubscribe, send: async () => { sends += 1; }, stopSession: async (/** @type {string} */ sessionId) => { assert.equal(sessionId, 'zs-before-send'); stops += 1; }, close: async () => {},
    };
    await assert.rejects(executeJob({ job, workspace, dataRoot: join(root, 'data'), store: wrapped, client, task: 'task', signal: controller.signal }), (error) => error === interruption);
    assert.equal(sends, 0); assert.equal(stops, 1); assert.equal((await store.readJob(workspace, job.id)).status, 'cancelled');
  }
});

test('executor persists the accepted turn boundary and worker identity before startup acknowledgement', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  /** @type {any} */
  let acknowledged = null;
  const client = {
    createSession: async () => ({ session: { sessionId: 'zs-boundary' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } }, messages: [{ info: { messageId: 'before-1' } }] }),
    setPermissionHandler: () => {}, subscribe: silentSubscribe, send: async () => ({ inputId: 'input-boundary', stateRevision: 19 }),
    waitForCompletion: async () => { throw new Error('simulated worker crash after acknowledgement'); }, stopSession: async () => {}, close: async () => {},
  };
  const workerLeaseId = 'a'.repeat(64);
  await assert.rejects(executeJob({ job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task', childPid: 4321, workerLeaseId, onBoundaryPersisted: async (running) => { acknowledged = running; } }), /simulated worker crash/);
  assert.ok(acknowledged);
  assert.equal(acknowledged.childPid, 4321); assert.equal(acknowledged.workerLeaseId, workerLeaseId); assert.equal(acknowledged.inputId, 'input-boundary'); assert.equal(acknowledged.startRevision, 19); assert.deepEqual(acknowledged.beforeMessageIds, ['before-1']);
  const persisted = await store.readJob(workspace, job.id); assert.equal(persisted.status, 'failed'); assert.equal(persisted.inputId, 'input-boundary'); assert.equal(persisted.childPid, 4321); assert.equal(persisted.workerLeaseId, workerLeaseId);
});

test('executor activates bounded snapshot progress only after the exact accepted boundary is durable and keeps final read authoritative', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  const readKinds = [];
  let heartbeatAssigned = false;
  /** @type {()=>void} */
  let heartbeat = () => { throw new Error('heartbeat was not assigned'); };
  let releaseCompletion = () => {};
  const completion = new Promise((resolve) => { releaseCompletion = () => resolve(undefined); });
  let boundaryPersisted = false; let signalBoundary = () => {};
  const boundaryReady = new Promise((resolve) => { signalBoundary = () => resolve(undefined); });
  const client = {
    createSession: async () => ({
      session: { sessionId: 'zs-snapshot-boundary' },
      settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } },
      messages: [{ info: { messageId: 'historical' } }],
    }),
    setPermissionHandler: () => {}, subscribe: silentSubscribe,
    send: async () => ({ inputId: 'accepted-input', stateRevision: 7 }),
    waitForCompletion: async () => completion,
    readSession: async () => {
      assert.equal(boundaryPersisted, true, 'no session read may precede durable boundary persistence');
      if (readKinds.length === 0) {
        readKinds.push('progress');
        return {
          runtime: { stateRevision: 8 },
          messages: [
            { info: { role: 'user', messageId: 'accepted-input' }, parts: [] },
            { info: { role: 'assistant', messageId: 'assistant-progress', parentMessageId: 'accepted-input' }, parts: [
              { type: 'tool', callId: 'safe-call', tool: 'Bash', state: { status: 'running', input: { command: 'PRIVATE_COMMAND' }, startedAt: 1 } },
            ] },
          ],
        };
      }
      readKinds.push('final');
      return { projection: { status: 'completed' }, runtime: { stateRevision: 8 }, messages: [{ info: { role: 'assistant', messageId: 'assistant-final', parentMessageId: 'accepted-input' }, parts: [{ type: 'text', text: 'authoritative result' }] }] };
    },
    close: async () => {},
  };
  const execution = executeJob({
    job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task', progressWriter: (line) => lines.push(line),
    onBoundaryPersisted: async (running) => {
      assert.equal(running.inputId, 'accepted-input'); assert.equal(running.startRevision, 7); assert.deepEqual(running.beforeMessageIds, ['historical']);
      boundaryPersisted = true; signalBoundary();
    },
    progressDependencies: {
      now: () => '2026-08-15T00:00:00.000Z',
      setInterval: (callback) => { heartbeat = callback; heartbeatAssigned = true; return { unref() {} }; }, clearInterval: () => {},
    },
  });
  await boundaryReady;
  for (let turns = 0; turns < 4 && !heartbeatAssigned; turns += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(heartbeatAssigned, true); heartbeat();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(readKinds, ['progress']);
  assert.match(lines.join(''), /Running tool: Bash\./); assert.doesNotMatch(lines.join(''), /PRIVATE_COMMAND/);

  releaseCompletion(); const output = await execution;
  assert.equal(output.result, 'authoritative result'); assert.deepEqual(readKinds, ['progress', 'final']);
});

test('executor surfaces terminal storage failure instead of silently leaving active state', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation }); const storageError = new PluginError('JSON_WRITE_FAILED', 'terminal write failed', { category: 'storage', remedy: 'retry recovery' });
  const wrapped = { ...store, finishJob: async () => { throw storageError; } };
  const client = {
    createSession: async () => ({ session: { sessionId: 'zs-finalize-failure' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } }, messages: [] }),
    setPermissionHandler: () => {}, subscribe: silentSubscribe, send: async () => ({ inputId: 'input-finalize-failure', stateRevision: 1 }), waitForCompletion: async () => { throw new Error('worker failed'); }, stopSession: async () => {}, close: async () => {},
  };
  await assert.rejects(executeJob({ job, workspace, dataRoot: join(root, 'data'), store: wrapped, client, task: 'task' }), (error) => error === storageError);
  assert.equal((await store.readJob(workspace, job.id)).status, 'running');
});

test('successful result finalization failure stays recoverable and is never rewritten failed', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation }); const storageError = new PluginError('JSON_WRITE_FAILED', 'success write failed once', { category: 'storage', remedy: 'retry recovery' }); let failedWrites = 0; let successWrites = 0;
  const wrapped = { ...store, finishJob: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobId, /** @type {string[]} */ expected, /** @type {string} */ next, /** @type {Record<string,unknown>} */ patch) => { if (next === 'succeeded') { successWrites += 1; throw storageError; } failedWrites += 1; return store.finishJob(workspaceArg, jobId, expected, next, patch); } };
  const client = {
    createSession: async () => ({ session: { sessionId: 'zs-success-finalize-failure' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } }, messages: [] }),
    setPermissionHandler: () => {}, subscribe: silentSubscribe, send: async () => ({ inputId: 'input-success-finalize-failure', stateRevision: 1 }), waitForCompletion: async () => {}, readSession: async () => ({ projection: { status: 'completed' }, runtime: { stateRevision: 1 }, messages: [{ info: { role: 'assistant', messageId: 'assistant-success', parentMessageId: 'input-success-finalize-failure' }, parts: [{ type: 'text', text: 'recoverable result' }] }] }), close: async () => {},
  };
  await assert.rejects(executeJob({ job, workspace, dataRoot: join(root, 'data'), store: wrapped, client, task: 'task' }), (error) => error === storageError || /** @type {any} */ (error)?.cause === storageError);
  assert.equal(successWrites, 1); assert.equal(failedWrites, 0); assert.equal((await store.readJob(workspace, job.id)).status, 'running');
  const storage = await resolveWorkspaceStorage({ dataRoot: join(root, 'data'), workspace }); assert.equal(await readFile(join(storage.directory, 'results', `${job.id}.md`), 'utf8'), 'recoverable result');
});

test('successful finalization apply-then-throw returns the durable winner', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation }); const storageError = new PluginError('JSON_WRITE_FAILED', 'ack lost after apply', { category: 'storage', remedy: 'read winner' }); let failedWrites = 0;
  const wrapped = { ...store, finishJob: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobId, /** @type {string[]} */ expected, /** @type {string} */ next, /** @type {Record<string,unknown>} */ patch) => { if (next === 'succeeded') { await store.finishJob(workspaceArg, jobId, expected, next, patch); throw storageError; } failedWrites += 1; return store.finishJob(workspaceArg, jobId, expected, next, patch); } };
  const client = { createSession: async () => ({ session: { sessionId: 'zs-apply-then-throw' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } }, messages: [] }), setPermissionHandler: () => {}, subscribe: silentSubscribe, send: async () => ({ inputId: 'input-apply-then-throw', stateRevision: 1 }), waitForCompletion: async () => {}, readSession: async () => ({ projection: { status: 'completed' }, runtime: { stateRevision: 1 }, messages: [{ info: { role: 'assistant', messageId: 'assistant-applied', parentMessageId: 'input-apply-then-throw' }, parts: [{ type: 'text', text: 'applied result' }] }] }), close: async () => {} };
  const output = await executeJob({ job, workspace, dataRoot: join(root, 'data'), store: wrapped, client, task: 'task' }); assert.equal(output.job.status, 'succeeded'); assert.equal(output.result, 'applied result'); assert.equal(failedWrites, 0);
});

test('successful finalization winner read failures preserve its artifact without rewriting failed', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation }); const storageError = new PluginError('JSON_WRITE_FAILED', 'finish failed before apply', { category: 'storage', remedy: 'retry recovery' }); let finalizeFailed = false; let winnerReadFailures = 0; let failedWrites = 0;
  const wrapped = { ...store, readJob: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobId) => { if (finalizeFailed) { winnerReadFailures += 1; throw new Error('winner read unavailable'); } return store.readJob(workspaceArg, jobId); }, finishJob: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobId, /** @type {string[]} */ expected, /** @type {string} */ next, /** @type {Record<string,unknown>} */ patch) => { if (next === 'succeeded') { finalizeFailed = true; throw storageError; } failedWrites += 1; return store.finishJob(workspaceArg, jobId, expected, next, patch); } };
  const client = { createSession: async () => ({ session: { sessionId: 'zs-winner-read-failure' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } }, messages: [] }), setPermissionHandler: () => {}, subscribe: silentSubscribe, send: async () => ({ inputId: 'input-winner-read-failure', stateRevision: 1 }), waitForCompletion: async () => {}, readSession: async () => ({ projection: { status: 'completed' }, runtime: { stateRevision: 1 }, messages: [{ info: { role: 'assistant', messageId: 'assistant-read-failed', parentMessageId: 'input-winner-read-failure' }, parts: [{ type: 'text', text: 'retain on read failure' }] }] }), close: async () => {} };
  await assert.rejects(executeJob({ job, workspace, dataRoot: join(root, 'data'), store: wrapped, client, task: 'task' }), (error) => error === storageError || /** @type {any} */ (error)?.cause === storageError); assert.equal(winnerReadFailures, 2); assert.equal(failedWrites, 0); assert.equal((await store.readJob(workspace, job.id)).status, 'running'); const storage = await resolveWorkspaceStorage({ dataRoot: join(root, 'data'), workspace }); assert.equal(await readFile(join(storage.directory, 'results', `${job.id}.md`), 'utf8'), 'retain on read failure');
});

test('successful apply-then-throw recovers when the first winner read fails', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation }); const storageError = new PluginError('JSON_WRITE_FAILED', 'apply ack and first read lost', { category: 'storage', remedy: 'read winner again' }); let applied = false; let winnerReadFailed = false; let failedWrites = 0;
  const wrapped = { ...store, readJob: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobId) => { if (applied && !winnerReadFailed) { winnerReadFailed = true; throw new Error('first winner read unavailable'); } return store.readJob(workspaceArg, jobId); }, finishJob: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobId, /** @type {string[]} */ expected, /** @type {string} */ next, /** @type {Record<string,unknown>} */ patch) => { if (next === 'succeeded') { await store.finishJob(workspaceArg, jobId, expected, next, patch); applied = true; throw storageError; } failedWrites += 1; return store.finishJob(workspaceArg, jobId, expected, next, patch); } };
  const client = { createSession: async () => ({ session: { sessionId: 'zs-apply-read-recovery' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } }, messages: [] }), setPermissionHandler: () => {}, subscribe: silentSubscribe, send: async () => ({ inputId: 'input-apply-read-recovery', stateRevision: 1 }), waitForCompletion: async () => {}, readSession: async () => ({ projection: { status: 'completed' }, runtime: { stateRevision: 1 }, messages: [{ info: { role: 'assistant', messageId: 'assistant-apply-read', parentMessageId: 'input-apply-read-recovery' }, parts: [{ type: 'text', text: 'recovered after second read' }] }] }), close: async () => {} };
  const output = await executeJob({ job, workspace, dataRoot: join(root, 'data'), store: wrapped, client, task: 'task' }); assert.equal(output.job.status, 'succeeded'); assert.equal(output.result, 'recovered after second read'); assert.equal(failedWrites, 0); assert.equal(winnerReadFailed, true);
});

test('outer successful-finalization recovery removes an artifact rejected by a terminal winner', async (t) => {
  for (const winnerStatus of ['failed', 'cancelled', 'succeeded']) await t.test(winnerStatus, async () => {
    const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation }); const storageError = new PluginError('JSON_WRITE_FAILED', `finalization lost to ${winnerStatus}`, { category: 'storage', remedy: 'read terminal winner' }); let finalizeStarted = false; let winnerReads = 0;
    const wrapped = { ...store, readJob: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobId) => { if (finalizeStarted && ++winnerReads === 1) throw new Error('inner winner read unavailable'); return store.readJob(workspaceArg, jobId); }, finishJob: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobId, /** @type {string[]} */ expected, /** @type {string} */ next, /** @type {Record<string,unknown>} */ patch) => { if (next !== 'succeeded') return store.finishJob(workspaceArg, jobId, expected, next, patch); finalizeStarted = true; if (winnerStatus === 'failed') await store.finishJob(workspaceArg, jobId, ['running'], 'failed', { error: { message: 'terminal winner' }, exitCode: 1 }); else if (winnerStatus === 'cancelled') { await store.transitionJob(workspaceArg, jobId, ['running'], 'cancelling', { lastCancelError: null }); await store.finishJob(workspaceArg, jobId, ['cancelling'], 'cancelled', { exitCode: null }); } else await store.finishJob(workspaceArg, jobId, ['running'], 'succeeded', { resultArtifact: 'results/winner.md', exitCode: 0 }); throw storageError; } };
    const client = { createSession: async () => ({ session: { sessionId: `zs-outer-${winnerStatus}` }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } }, messages: [] }), setPermissionHandler: () => {}, subscribe: silentSubscribe, send: async () => ({ inputId: `input-outer-${winnerStatus}`, stateRevision: 1 }), waitForCompletion: async () => {}, readSession: async () => ({ projection: { status: 'completed' }, runtime: { stateRevision: 1 }, messages: [{ info: { role: 'assistant', messageId: `assistant-outer-${winnerStatus}`, parentMessageId: `input-outer-${winnerStatus}` }, parts: [{ type: 'text', text: `outer ${winnerStatus}` }] }] }), close: async () => {} };
    await assert.rejects(executeJob({ job, workspace, dataRoot: join(root, 'data'), store: wrapped, client, task: 'task' }), (error) => error === storageError || /** @type {any} */ (error)?.cause === storageError); assert.equal(winnerReads, 2); const storage = await resolveWorkspaceStorage({ dataRoot: join(root, 'data'), workspace }); await assert.rejects(readFile(join(storage.directory, 'results', `${job.id}.md`)), (error) => /** @type {any} */ (error)?.code === 'ENOENT');
  });
});

test('executor reports only same-session progress and drains persistence before success', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  /** @type {string[]} */
  const lines = [];
  /** @type {any[]} */
  const relays = [];
  /** @type {any[]} */
  const persisted = [];
  /** @type {string[]} */
  const order = [];
  /** @type {()=>void} */ let signalFinalizingEntered = () => {}; const finalizingEntered = new Promise((resolve) => { signalFinalizingEntered = () => resolve(undefined); });
  /** @type {()=>void} */ let releaseFinalizing = () => {}; const finalizingGate = new Promise((resolve) => { releaseFinalizing = () => resolve(undefined); });
  /** @type {null|((message:any)=>void)} */ let handler = null; let unsubscribes = 0; let closes = 0; let readSessionCalls = 0; let successFinishes = 0; /** @type {null|(()=>void)} */ let intervalCallback = null; let cleared = 0;
  const wrapped = {
    ...store,
    updateJobProgress: async (/** @type {string} */ _workspaceArg, /** @type {string} */ _jobId, /** @type {any} */ event) => {
      persisted.push(event);
      if (event.phase === 'finalizing') { signalFinalizingEntered(); await finalizingGate; }
      order.push(`persist:${event.phase}`);
      return event;
    },
    transitionJob: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobId, /** @type {string[]} */ expected, /** @type {string} */ next, /** @type {Record<string,unknown>} */ patch = {}) => {
      return store.transitionJob(workspaceArg, jobId, expected, next, patch);
    },
    finishJob: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobId, /** @type {string[]} */ expected, /** @type {string} */ next, /** @type {Record<string,unknown>} */ patch = {}) => {
      if (next === 'succeeded') { successFinishes += 1; order.push('transition:succeeded'); if (handler) handler(notification('zs-progress', 'api_retry', 5)); }
      return store.finishJob(workspaceArg, jobId, expected, next, patch);
    },
  };
  const notification = (/** @type {string} */ sessionId, /** @type {string} */ reason, /** @type {number} */ revision) => ({ method: 'state.updated', params: { type: 'state.updated', scope: 'session', sessionId, revision, reason, patch: {} } });
  const emit = (/** @type {any} */ message) => { if (!handler) throw new Error('progress handler missing'); handler(message); };
  const client = {
    createSession: async () => ({ session: { sessionId: 'zs-progress' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } }, messages: [] }),
    setPermissionHandler: () => {},
    subscribe: (/** @type {(message:any)=>void} */ subscriber) => { handler = subscriber; return () => { unsubscribes += 1; handler = null; }; },
    send: async () => { emit(notification('zs-progress', 'tool_call_result', 1)); return { inputId: 'input-progress', stateRevision: 1 }; },
    waitForCompletion: async () => {
      emit(notification('zs-sibling', 'tool_call_started', 2));
      emit(notification('zs-progress', 'model_streaming', 2));
      emit(notification('zs-progress', 'tool_call_started', 3));
      emit(notification('zs-progress', 'prompt_completed', 4));
    },
    readSession: async () => { readSessionCalls += 1; return { projection: { status: 'completed' }, runtime: { stateRevision: 1 }, messages: [{ info: { role: 'assistant', messageId: 'assistant-progress', parentMessageId: 'input-progress' }, parts: [{ type: 'text', text: 'done' }] }] }; },
    close: async () => { closes += 1; throw new Error('close refused after success'); },
  };
  const execution = executeJob({
    job, workspace, dataRoot: join(root, 'data'), store: wrapped, client, task: 'task',
    progressWriter: (line) => lines.push(line),
    progressRelayWriter: (record) => { relays.push(record); },
    progressDependencies: {
      now: () => new Date().toISOString(),
      setInterval: (callback) => { intervalCallback = callback; return { unref() {} }; },
      clearInterval: () => { cleared += 1; },
    },
  });
  await finalizingEntered;
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(readSessionCalls, 0); assert.equal(successFinishes, 0); assert.equal(order.includes('transition:succeeded'), false);
  } finally { releaseFinalizing(); }
  const result = await execution;
  assert.equal(result.job.status, 'succeeded'); assert.equal(typeof intervalCallback, 'function');
  assert.deepEqual(lines, [
    '[zcode] ZCode started the delegated turn.\n',
    '[zcode] ZCode completed a tool call.\n',
    '[zcode] ZCode is generating a response.\n',
    '[zcode] ZCode started a tool call.\n',
    '[zcode] ZCode completed the delegated turn.\n',
  ]);
  assert.deepEqual(persisted.map((event) => event.message), lines.map((line) => line.slice(8, -1)));
  assert.deepEqual(relays.map(({ sequence, phase, code }) => ({ sequence, phase, code })), [
    { sequence: 1, phase: 'starting', code: 'started' },
    { sequence: 2, phase: 'investigating', code: 'tool-active' },
    { sequence: 3, phase: 'running', code: 'model-active' },
    { sequence: 4, phase: 'investigating', code: 'tool-active' },
    { sequence: 5, phase: 'finalizing', code: 'finalizing' },
  ]);
  assert.ok(order.lastIndexOf('persist:finalizing') < order.indexOf('transition:succeeded'));
  assert.equal(order.includes('persist:waiting'), false);
  assert.equal((await store.readJob(workspace, job.id)).status, 'succeeded');
  assert.equal(unsubscribes, 1); assert.equal(cleared, 1); assert.equal(closes, 1); assert.equal(handler, null);
});

test('slow send has no progress side effects until accepted', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  /** @type {string[]} */
  const lines = [];
  let intervalCalls = 0; let fireInterval = () => {};
  /** @type {(value:any)=>void} */ let resolveSend = () => {};
  /** @type {()=>void} */ let signalSendStarted = () => {};
  const sendStarted = new Promise((resolve) => { signalSendStarted = () => resolve(undefined); });
  const sendCompletion = new Promise((resolve) => { resolveSend = resolve; });
  let currentTime = new Date().toISOString();
  const client = {
    createSession: async () => ({ session: { sessionId: 'zs-slow-send' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } }, messages: [] }),
    setPermissionHandler: () => {}, subscribe: silentSubscribe,
    send: async () => { signalSendStarted(); return sendCompletion; }, waitForCompletion: async () => {},
    readSession: async () => ({ projection: { status: 'completed' }, runtime: { stateRevision: 1 }, messages: [{ info: { role: 'assistant', messageId: 'assistant-slow-send', parentMessageId: 'input-slow-send' }, parts: [{ type: 'text', text: 'done' }] }] }), close: async () => {},
  };
  const execution = executeJob({ job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task', progressWriter: (line) => lines.push(line), progressDependencies: { now: () => currentTime, setInterval: (callback) => { intervalCalls += 1; fireInterval = callback; return { unref() {} }; }, clearInterval: () => {} } });
  await sendStarted;
  currentTime = new Date(Date.parse(currentTime) + 21_000).toISOString(); fireInterval();
  assert.equal(intervalCalls, 0); assert.deepEqual(lines, []);
  const beforeAccepted = await store.readJob(workspace, job.id); assert.equal(beforeAccepted.phase, undefined); assert.equal(beforeAccepted.progressPreview, undefined);
  currentTime = new Date().toISOString(); resolveSend({ inputId: 'input-slow-send', stateRevision: 1 });
  assert.equal((await execution).job.status, 'succeeded'); assert.match(lines[0], /started the delegated turn/);
});

test('rejected send never activates progress or heartbeat', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  /** @type {string[]} */
  const lines = [];
  let intervalCalls = 0;
  const client = {
    createSession: async () => ({ session: { sessionId: 'zs-rejected-send' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } } }),
    setPermissionHandler: () => {}, subscribe: silentSubscribe, send: async () => { throw new Error('send rejected'); }, stopSession: async () => {}, close: async () => {},
  };
  await assert.rejects(executeJob({ job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task', progressWriter: (line) => lines.push(line), progressDependencies: { now: () => new Date().toISOString(), setInterval: () => { intervalCalls += 1; return { unref() {} }; }, clearInterval: () => {} } }), /send rejected/);
  const failed = await store.readJob(workspace, job.id);
  assert.equal(intervalCalls, 0); assert.deepEqual(lines, []); assert.equal(failed.status, 'failed'); assert.equal(failed.phase, undefined); assert.equal(failed.progressPreview, undefined);
});

test('writer failure stays observational while progress persists and the exact result succeeds', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  /** @type {any[]} */
  const persisted = [];
  const wrapped = { ...store, updateJobProgress: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobId, /** @type {any} */ event) => { persisted.push(event); return store.updateJobProgress(workspaceArg, jobId, event); } };
  const client = {
    createSession: async () => ({ session: { sessionId: 'zs-writer-failure' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } } }),
    setPermissionHandler: () => {}, subscribe: silentSubscribe,
    send: async () => ({ inputId: 'input-writer-failure', stateRevision: 1 }), waitForCompletion: async () => {},
    readSession: async () => ({ projection: { status: 'completed' }, runtime: { stateRevision: 1 }, messages: [{ info: { role: 'assistant', messageId: 'assistant-writer-failure', parentMessageId: 'input-writer-failure' }, parts: [{ type: 'text', text: 'done' }] }] }), close: async () => {},
  };
  const result = await executeJob({ job, workspace, dataRoot: join(root, 'data'), store: wrapped, client, task: 'task', progressWriter: () => { throw new Error('stderr closed'); }, progressRelayWriter: () => { throw new Error('PRIVATE_RELAY_FAILURE'); } });
  assert.equal(result.result, 'done');
  assert.ok(persisted.some((event) => event.message === 'ZCode started the delegated turn.'));
  assert.equal((await store.readJob(workspace, job.id)).status, 'succeeded');
});

test('preview persistence failure stays observational while writer and exact result succeed', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  /** @type {string[]} */ const lines = [];
  const wrapped = { ...store, updateJobProgress: async () => { throw new Error('preview storage unavailable'); } };
  const client = {
    createSession: async () => ({ session: { sessionId: 'zs-preview-failure' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } } }),
    setPermissionHandler: () => {}, subscribe: silentSubscribe,
    send: async () => ({ inputId: 'input-preview-failure', stateRevision: 1 }), waitForCompletion: async () => {},
    readSession: async () => ({ projection: { status: 'completed' }, runtime: { stateRevision: 1 }, messages: [{ info: { role: 'assistant', messageId: 'assistant-preview-failure', parentMessageId: 'input-preview-failure' }, parts: [{ type: 'text', text: 'done' }] }] }), close: async () => {},
  };
  const result = await executeJob({ job, workspace, dataRoot: join(root, 'data'), store: wrapped, client, task: 'task', progressWriter: (line) => lines.push(line) });
  assert.equal(result.result, 'done'); assert.equal((await store.readJob(workspace, job.id)).status, 'succeeded');
  assert.match(lines.join(''), /ZCode started the delegated turn/);
});

test('subscription acknowledgement waits for a structurally valid public identifier', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  /** @type {any[]} */ const probes = [];
  const wrapped = {
    ...store,
    updateJobProgressProbe: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobId, /** @type {any} */ probe) => {
      probes.push(probe); return store.updateJobProgressProbe(workspaceArg, jobId, probe);
    },
  };
  const client = {
    createSession: async () => ({ session: { sessionId: 'zs-bad-conversation-ack' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } } }),
    subscribeConversation: async () => ({ subscriptionId: 'subscription-\u0085-secret', unsubscribe: async () => {} }),
    setPermissionHandler: () => {}, subscribe: silentSubscribe,
    send: async () => ({ inputId: 'input-bad-conversation-ack', stateRevision: 1 }), waitForCompletion: async () => {},
    readSession: async () => ({ projection: { status: 'completed' }, runtime: { stateRevision: 1 }, messages: [{ info: { role: 'assistant', messageId: 'assistant-bad-conversation-ack', parentMessageId: 'input-bad-conversation-ack' }, parts: [{ type: 'text', text: 'done' }] }] }), close: async () => {},
  };
  const result = await executeJob({
    job, workspace, dataRoot: join(root, 'data'), store: wrapped, client, task: 'task',
    progressDependencies: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
  });
  assert.equal(result.result, 'done');
  assert.ok(probes.length > 0);
  assert.equal(probes.some((probe) => probe.subscriptionAcknowledged), false);
});

test('a never-settling conversation unsubscribe cannot block authoritative success', { timeout: 10_000 }, async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  /** @type {(value:any)=>void} */ let signalAuthoritativeSuccess = () => {};
  const authoritativeSuccess = new Promise((resolve) => { signalAuthoritativeSuccess = resolve; });
  const wrapped = {
    ...store,
    finishJob: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobId, /** @type {string[]} */ expected, /** @type {string} */ next, /** @type {Record<string,unknown>} */ patch) => {
      const terminal = await store.finishJob(workspaceArg, jobId, expected, next, patch);
      if (next === 'succeeded') signalAuthoritativeSuccess(terminal);
      return terminal;
    },
  };
  let unsubscribeCalls = 0;
  const client = {
    createSession: async () => ({ session: { sessionId: 'zs-unsubscribe-hang' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } } }),
    subscribeConversation: async () => ({ subscriptionId: 'subscription-1', unsubscribe: () => { unsubscribeCalls += 1; return new Promise(() => {}); } }),
    setPermissionHandler: () => {}, subscribe: silentSubscribe,
    send: async () => ({ inputId: 'input-unsubscribe-hang', stateRevision: 1 }), waitForCompletion: async () => {},
    readSession: async () => ({ projection: { status: 'completed' }, runtime: { stateRevision: 1 }, messages: [{ info: { role: 'assistant', messageId: 'assistant-unsubscribe-hang', parentMessageId: 'input-unsubscribe-hang' }, parts: [{ type: 'text', text: 'done' }] }] }), close: async () => {},
  };
  const execution = executeJob({ job, workspace, dataRoot: join(root, 'data'), store: wrapped, client, task: 'task' });
  const terminal = await authoritativeSuccess;
  const result = await execution;
  assert.equal(unsubscribeCalls, 1); assert.equal(result.result, 'done'); assert.equal(terminal.status, 'succeeded');
});

test('executor stops notification intake then bounded-drains already received semantic progress before terminal fencing', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  /** @type {((notification:any)=>void)|undefined} */ let handler;
  let localUnsubscribed = false;
  /** @type {string[]} */
  const lines = [];
  const sessionId = 'zs-cleanup-drain'; const subscriptionId = 'subscription-1';
  const client = {
    createSession: async () => ({ session: { sessionId }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } } }),
    subscribeConversation: async () => ({ subscriptionId, unsubscribe: async () => {} }),
    subscribe: (/** @type {(notification:any)=>void} */ subscriber) => { handler = subscriber; return () => {
      localUnsubscribed = true;
      handler?.(conversationFrame(/** @type {any} */ ({ sessionId, subscriptionId, ordinal: 2, deltas: [toolRow({ rowId: 2, input: { command: 'LATE_AFTER_UNSUBSCRIBE_SECRET' } })] })));
      throw new Error('local unsubscribe failed after callback');
    }; },
    setPermissionHandler: () => {}, send: async () => ({ inputId: 'input-cleanup-drain', stateRevision: 1 }),
    waitForCompletion: async () => { handler?.(conversationFrame(/** @type {any} */ ({ sessionId, subscriptionId, deltas: [toolRow({ input: { command: 'echo drain me' } })] }))); },
    readSession: async () => ({ projection: { status: 'completed' }, runtime: { stateRevision: 1 }, messages: [{ info: { role: 'assistant', messageId: 'assistant-cleanup-drain', parentMessageId: 'input-cleanup-drain' }, parts: [{ type: 'text', text: 'done' }] }] }), close: async () => {},
  };
  const result = await executeJob({ job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task', progressWriter: (line) => lines.push(line) });
  assert.equal(result.result, 'done'); assert.equal(localUnsubscribed, true);
  assert.match(lines.join(''), /Running command: echo drain me\./);
  assert.doesNotMatch(lines.join(''), /LATE_AFTER_UNSUBSCRIBE_SECRET/);
  assert.match(lines.join(''), /conversation progress cleanup was incomplete/);
});

test('executor cleanup aggregates a late ready-I/O rejection before terminal close', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  const readyPath = join(workspace, 'ready-semantic.txt'); await writeFile(readyPath, 'ready');
  const readyRead = readFile(readyPath); await readyRead;
  /** @type {string[]} */ const lines = []; const sessionId = 'zs-cleanup-ready-io'; const subscriptionId = 'subscription-ready-io';
  /** @type {()=>void} */ let releaseUnsubscribe = () => {}; const unsubscribeGate = new Promise((resolve) => { releaseUnsubscribe = () => resolve(undefined); });
  let unsubscribeReadReady = false; let outerCaptured = false; let capturedMilliseconds = null;
  /** @type {()=>void} */ let signalOuterTimer = () => {};
  const outerTimerRegistered = new Promise((resolve) => { signalOuterTimer = () => resolve(undefined); });
  let cleared = 0;
  const client = {
    createSession: async () => ({ session: { sessionId }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } } }),
    subscribeConversation: async () => ({ subscriptionId, unsubscribe: async () => {
      await readyRead; unsubscribeReadReady = true; await unsubscribeGate; throw new Error('ready unsubscribe failure');
    } }),
    subscribe: () => () => {},
    setPermissionHandler: () => {}, send: async () => ({ inputId: 'input-cleanup-ready-io', stateRevision: 1 }),
    waitForCompletion: async () => {},
    readSession: async () => ({ projection: { status: 'completed' }, runtime: { stateRevision: 1 }, messages: [{ info: { role: 'assistant', messageId: 'assistant-cleanup-ready-io', parentMessageId: 'input-cleanup-ready-io' }, parts: [{ type: 'text', text: 'done' }] }] }), close: async () => {},
  };
  const originalSetTimeout = globalThis.setTimeout;
  /** @param {(...args:any[])=>void} callback @param {number} milliseconds @param {...any} args */
  const interceptTimeout = (callback, milliseconds, ...args) => {
    if (outerCaptured || milliseconds <= 200 || milliseconds > 250) return originalSetTimeout(callback, milliseconds, ...args);
    outerCaptured = true; capturedMilliseconds = milliseconds; signalOuterTimer();
    return originalSetTimeout(() => {
      callback(...args);
      // Keep the already-ready rejection in bounded check-phase work after the
      // outer timer wins. Cleanup must emit one aggregate timeout before close.
      queueMicrotask(() => {
        let checks = 6;
        const releaseAfterChecks = () => { if (checks === 0) releaseUnsubscribe(); else { checks -= 1; setImmediate(releaseAfterChecks); } };
        releaseAfterChecks();
      });
    }, milliseconds);
  };
  globalThis.setTimeout = /** @type {typeof globalThis.setTimeout} */ (interceptTimeout);
  const started = Date.now();
  try {
    const execution = executeJob({
      job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task', progressWriter: (line) => lines.push(line),
      progressDependencies: { setInterval: () => ({ unref() {} }), clearInterval: () => { cleared += 1; } },
    });
    await outerTimerRegistered; assert.equal(unsubscribeReadReady, true);
    assert.ok(typeof capturedMilliseconds === 'number' && capturedMilliseconds > 200 && capturedMilliseconds <= 250);
    const result = await execution;
    assert.ok(Date.now() - started < 1_000); assert.equal(result.result, 'done'); assert.equal(cleared, 1);
    assert.equal(lines.filter((line) => /progress cleanup reached its time limit/.test(line)).length, 1);
  } finally { globalThis.setTimeout = originalSetTimeout; releaseUnsubscribe(); }
});

test('cleanup failures preserve the primary PluginError envelope and close once', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  const primary = new PluginError('PRIMARY_STABLE', 'primary failure', { category: 'protocol', remedy: 'keep this remedy' }); let closes = 0;
  const client = {
    createSession: async () => ({ session: { sessionId: 'zs-primary-failure' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } } }),
    setPermissionHandler: () => {}, subscribe: silentSubscribe, send: async () => ({ inputId: 'input-primary-failure', stateRevision: 1 }),
    waitForCompletion: async () => { throw primary; }, stopSession: async () => {}, close: async () => { closes += 1; throw new Error('close is advisory'); },
  };
  const caught = await executeJob({ job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task', progressWriter: () => { throw new Error('writer cleanup failed'); } }).catch((error) => error);
  assert.equal(caught, primary);
  assert.deepEqual((await import('../scripts/lib/render.mjs')).errorEnvelope(caught), { error: { code: 'PRIMARY_STABLE', category: 'protocol', message: 'primary failure', remedy: 'keep this remedy', details: {} } });
  assert.equal(closes, 1);
});

test('executor failure still unsubscribes, stops heartbeat, and closes the client', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  let handler = null; let unsubscribes = 0; let cleared = 0; let closes = 0;
  const client = {
    createSession: async () => ({ session: { sessionId: 'zs-progress-failure' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } } }),
    setPermissionHandler: () => {}, subscribe: (/** @type {(message:any)=>void} */ subscriber) => { handler = subscriber; return () => { unsubscribes += 1; handler = null; }; },
    send: async () => ({ inputId: 'input-progress-failure', stateRevision: 1 }),
    waitForCompletion: async () => { throw new Error('progress wait failed'); }, stopSession: async () => {}, close: async () => { closes += 1; },
  };
  await assert.rejects(executeJob({
    job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task', progressWriter: () => {},
    progressDependencies: { now: () => new Date().toISOString(), setInterval: () => ({ unref() {} }), clearInterval: () => { cleared += 1; } },
  }), /progress wait failed/);
  assert.equal(unsubscribes, 1); assert.equal(cleared, 1); assert.equal(closes, 1); assert.equal(handler, null);
});

test('accepted send with boundary persistence failure requires remote stop proof before releasing the guard', async () => {
  for (const stopSucceeds of [true, false]) {
    const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation }); let stops = 0;
    const boundaryError = new Error('boundary fsync refused');
    const wrapped = /** @type {typeof store} */ ({ ...store, transitionJob: async (workspaceArg, jobId, expectedStatuses, nextStatus, patch = {}) => { if (patch.inputId) throw boundaryError; return store.transitionJob(workspaceArg, jobId, expectedStatuses, nextStatus, patch); } });
    const client = { createSession: async () => ({ session: { sessionId: 'zs-boundary-failure' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } } }), setPermissionHandler: () => {}, subscribe: silentSubscribe, send: async () => ({ inputId: 'accepted-not-durable', stateRevision: 2 }), stopSession: async () => { stops += 1; if (!stopSucceeds) throw new Error('stop not acknowledged'); }, close: async () => {} };
    await assert.rejects(executeJob({ job, workspace, dataRoot: join(root, 'data'), store: wrapped, client, task: 'task' }), boundaryError);
    const persisted = await store.readJob(workspace, job.id); assert.equal(stops, 1); assert.equal(persisted.status, stopSucceeds ? 'failed' : 'running');
    if (!stopSucceeds) { assert.match(persisted.lastCancelError, /stop not acknowledged/); await assert.rejects(store.reserveJob({ workspace, ...reservation, ownerTurnId: 'later' }), { code: 'WRITABLE_JOB_EXISTS' }); }
  }
});

test('wait and read ambiguity retain the running guard when remote stop is unacknowledged', async () => {
  for (const stage of ['wait', 'read']) {
    const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation }); let stops = 0;
    const client = { createSession: async () => ({ session: { sessionId: `zs-${stage}-failure` }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } } }), setPermissionHandler: () => {}, subscribe: silentSubscribe, send: async () => ({ inputId: `input-${stage}`, stateRevision: 3 }), waitForCompletion: async () => { if (stage === 'wait') throw new Error('wait protocol ambiguous'); }, readSession: async () => { throw new Error('read protocol ambiguous'); }, stopSession: async () => { stops += 1; throw new Error(`${stage} stop refused`); }, close: async () => {} };
    await assert.rejects(executeJob({ job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task' }), new RegExp(`${stage} protocol ambiguous`));
    const persisted = await store.readJob(workspace, job.id); assert.equal(stops, 1, stage); assert.equal(persisted.status, 'running', stage); assert.match(persisted.lastCancelError, new RegExp(`${stage} stop refused`));
  }
});

test('artifact directory fsync failure fails the job before success', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  const client = { createSession: async () => ({ session: { sessionId: 'zs' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } } }), setPermissionHandler: () => {}, subscribe: silentSubscribe, send: async () => ({ inputId: 'input-artifact-failure', stateRevision: 1 }), waitForCompletion: async () => ({}), readSession: async () => ({ projection: { status: 'completed' }, runtime: { stateRevision: 1 }, messages: [{ info: { role: 'assistant', messageId: 'assistant-artifact', parentMessageId: 'input-artifact-failure' }, parts: [{ type: 'text', text: 'done' }] }] }), close: async () => {} };
  const error = Object.assign(new Error('disk sync failed'), { code: 'EIO' });
  await assert.rejects(executeJob({ job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task', syncDirectory: async () => { throw error; } }), { code: 'ARTIFACT_WRITE_FAILED' });
  assert.equal((await store.readJob(workspace, job.id)).status, 'failed');
});
