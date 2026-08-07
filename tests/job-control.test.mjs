import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PluginError } from '../scripts/lib/errors.mjs';
import { atomicWriteJson } from '../scripts/lib/fs.mjs';
import { createJobController, ownerIdForSession } from '../scripts/lib/job-control.mjs';
import { createStateStore } from '../scripts/lib/state.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';
import { executeJob } from '../scripts/lib/review.mjs';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'zcode-job-control-'));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const store = createStateStore({ dataRoot: join(root, 'data') });
  return { root, workspace, store, controller: createJobController({ store, pollIntervalMs: 1 }) };
}

const reservation = { ownerSessionId: 'session-a', ownerTurnId: 'turn-a', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } };
const silentSubscribe = () => () => {};

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

test('latest selection is canonical-workspace and owner confined', async () => {
  const { workspace, store, controller } = await setup();
  const mine = await store.reserveJob({ workspace, ...reservation });
  await store.reserveJob({ workspace, ...reservation, ownerSessionId: 'session-b', readOnly: true });
  assert.equal((await controller.selectOwned(workspace, 'session-a')).id, mine.id);
  assert.equal((await controller.listOwned(workspace, 'session-a')).length, 1);
});

test('implicit cancel and result use command-specific eligibility while explicit IDs stay exact', async () => {
  const { workspace, store, controller } = await setup();
  const succeeded = await store.reserveJob({ workspace, ...reservation, readOnly: true, ownerTurnId: 'succeeded' });
  await store.transitionJob(workspace, succeeded.id, ['queued'], 'running');
  await store.transitionJob(workspace, succeeded.id, ['running'], 'succeeded', { resultArtifact: `results/${succeeded.id}.md` });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const failed = await store.reserveJob({ workspace, ...reservation, readOnly: true, ownerTurnId: 'failed' });
  await store.transitionJob(workspace, failed.id, ['queued'], 'failed', { error: 'failed' });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const active = await store.reserveJob({ workspace, ...reservation, readOnly: true, ownerTurnId: 'active' });

  assert.equal((await controller.selectOwned(workspace, 'session-a', undefined, 'cancel')).id, active.id);
  assert.equal((await controller.selectOwned(workspace, 'session-a', undefined, 'result')).id, succeeded.id);
  assert.equal((await controller.selectOwned(workspace, 'session-a', failed.id, 'result')).id, failed.id, 'explicit result IDs retain exact prior selection');
  assert.equal((await controller.selectOwned(workspace, 'session-a', succeeded.id, 'cancel')).id, succeeded.id, 'explicit cancel IDs retain exact idempotent selection');
  await assert.rejects(controller.selectOwned(workspace, 'session-b', undefined, 'cancel'), { code: 'OWNED_JOB_NOT_FOUND' });
});

test('wait reaches terminal state or returns a stable timeout error', async () => {
  const { workspace, store, controller } = await setup();
  const job = await store.reserveJob({ workspace, ...reservation });
  setTimeout(() => { void store.transitionJob(workspace, job.id, ['queued'], 'cancelled'); }, 5);
  assert.equal((await controller.wait(workspace, job.id, 100)).status, 'cancelled');
  const active = await store.reserveJob({ workspace, ...reservation });
  await assert.rejects(controller.wait(workspace, active.id, 0), { code: 'JOB_WAIT_TIMEOUT' });
});

test('queued cancellation is safe and terminal cancellation is idempotent', async () => {
  const { workspace, store, controller } = await setup();
  const queued = await store.reserveJob({ workspace, ...reservation });
  assert.equal((await controller.cancel(workspace, queued.id, 'session-a')).status, 'cancelled');
  assert.equal((await controller.cancel(workspace, queued.id, 'session-a')).status, 'cancelled');
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
    const wrapped = { ...store, transitionJob: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobIdArg, /** @type {string[]} */ expected, /** @type {string} */ next, /** @type {Record<string,unknown>} */ patchArg = {}) => { observed ??= await attemptFile.read(); return store.transitionJob(workspaceArg, jobIdArg, expected, next, patchArg); } };
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
  const wrapped = { ...store, transitionJob: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobIdArg, /** @type {string[]} */ expected, /** @type {string} */ next, /** @type {Record<string,unknown>} */ patch = {}) => { if (next === 'cancelled' && failFinalize) { failFinalize = false; throw new PluginError('JSON_WRITE_FAILED', 'disk failed', { category: 'storage', remedy: 'retry' }); } return store.transitionJob(workspaceArg, jobIdArg, expected, next, patch); } };
  const controller = createJobController({ store: wrapped, stopSession: async () => { stops += 1; } });
  await assert.rejects(controller.cancel(workspace, job.id, 'session-a'), { code: 'JOB_CANCEL_FINALIZE_FAILED' }); assert.equal(stops, 1); assert.equal((await store.readJob(workspace, job.id)).status, 'cancelling'); const pending = await attemptFile.read(); assert.equal(pending.status, 'finalize-pending');
  assert.equal((await controller.cancel(workspace, job.id, 'session-a')).status, 'cancelled'); const succeeded = await attemptFile.read(); assert.equal(stops, 1); assert.equal(succeeded.attemptId, pending.attemptId); assert.equal(succeeded.status, 'succeeded');
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

test('executor reports only same-session progress and drains persistence before success', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  /** @type {string[]} */
  const lines = [];
  /** @type {any[]} */
  const persisted = [];
  /** @type {string[]} */
  const order = [];
  /** @type {null|((message:any)=>void)} */ let handler = null; let unsubscribes = 0; let closes = 0; /** @type {null|(()=>void)} */ let intervalCallback = null; let cleared = 0;
  const wrapped = {
    ...store,
    updateJobProgress: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobId, /** @type {any} */ event) => {
      order.push(`persist:${event.phase}`); persisted.push(event);
      await new Promise((resolve) => setImmediate(resolve));
      return store.updateJobProgress(workspaceArg, jobId, event);
    },
    transitionJob: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobId, /** @type {string[]} */ expected, /** @type {string} */ next, /** @type {Record<string,unknown>} */ patch = {}) => {
      if (next === 'succeeded') {
        order.push('transition:succeeded');
        if (handler) handler(notification('zs-progress', 'api_retry', 5));
      }
      return store.transitionJob(workspaceArg, jobId, expected, next, patch);
    },
  };
  const notification = (/** @type {string} */ sessionId, /** @type {string} */ reason, /** @type {number} */ revision) => ({ method: 'state.updated', params: { type: 'state.updated', scope: 'session', sessionId, revision, reason, patch: {} } });
  const emit = (/** @type {any} */ message) => { if (!handler) throw new Error('progress handler missing'); handler(message); };
  const client = {
    createSession: async () => ({ session: { sessionId: 'zs-progress' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } }, messages: [] }),
    setPermissionHandler: () => {},
    subscribe: (/** @type {(message:any)=>void} */ subscriber) => { handler = subscriber; return () => { unsubscribes += 1; handler = null; }; },
    send: async () => ({ inputId: 'input-progress', stateRevision: 1 }),
    waitForCompletion: async () => {
      emit(notification('zs-sibling', 'tool_call_started', 2));
      emit(notification('zs-progress', 'model_streaming', 2));
      emit(notification('zs-progress', 'tool_call_started', 3));
      emit(notification('zs-progress', 'prompt_completed', 4));
    },
    readSession: async () => ({ messages: [{ info: { role: 'assistant', messageId: 'assistant-progress', parentMessageId: 'input-progress' }, parts: [{ type: 'text', text: 'done' }] }] }),
    close: async () => { closes += 1; },
  };
  const result = await executeJob({
    job, workspace, dataRoot: join(root, 'data'), store: wrapped, client, task: 'task',
    progressWriter: (line) => lines.push(line),
    progressDependencies: {
      now: () => new Date().toISOString(),
      setInterval: (callback) => { intervalCallback = callback; return { unref() {} }; },
      clearInterval: () => { cleared += 1; },
    },
  });
  assert.equal(result.job.status, 'succeeded'); assert.equal(typeof intervalCallback, 'function');
  assert.deepEqual(lines, [
    '[zcode] ZCode started the delegated turn.\n',
    '[zcode] ZCode is generating a response.\n',
    '[zcode] ZCode started a tool call.\n',
    '[zcode] ZCode completed the delegated turn.\n',
  ]);
  assert.deepEqual(persisted.map((event) => event.message), lines.map((line) => line.slice(8, -1)));
  assert.ok(order.lastIndexOf('persist:finalizing') < order.indexOf('transition:succeeded'));
  assert.equal(order.includes('persist:waiting'), false);
  assert.equal(unsubscribes, 1); assert.equal(cleared, 1); assert.equal(closes, 1); assert.equal(handler, null);
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
  const client = { createSession: async () => ({ session: { sessionId: 'zs' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } } }), setPermissionHandler: () => {}, subscribe: silentSubscribe, send: async () => ({ inputId: 'input-artifact-failure', stateRevision: 1 }), waitForCompletion: async () => ({}), readSession: async () => ({ messages: [{ info: { role: 'assistant', messageId: 'assistant-artifact', parentMessageId: 'input-artifact-failure' }, parts: [{ type: 'text', text: 'done' }] }] }), close: async () => {} };
  const error = Object.assign(new Error('disk sync failed'), { code: 'EIO' });
  await assert.rejects(executeJob({ job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task', syncDirectory: async () => { throw error; } }), { code: 'ARTIFACT_WRITE_FAILED' });
  assert.equal((await store.readJob(workspace, job.id)).status, 'failed');
});
