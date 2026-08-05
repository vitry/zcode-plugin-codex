import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PluginError } from '../scripts/lib/errors.mjs';
import { createJobController, ownerIdForSession } from '../scripts/lib/job-control.mjs';
import { createStateStore } from '../scripts/lib/state.mjs';
import { executeJob } from '../scripts/lib/review.mjs';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'zcode-job-control-'));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const store = createStateStore({ dataRoot: join(root, 'data') });
  return { root, workspace, store, controller: createJobController({ store, pollIntervalMs: 1 }) };
}

const reservation = { ownerSessionId: 'session-a', ownerTurnId: 'turn-a', command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } };

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
  const { workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation }); await store.transitionJob(workspace, job.id, ['queued'], 'running', { zcodeSessionId: 'zs' });
  let failFinalize = true; let stops = 0;
  const wrapped = { ...store, transitionJob: async (/** @type {string} */ workspaceArg, /** @type {string} */ jobIdArg, /** @type {string[]} */ expected, /** @type {string} */ next, /** @type {Record<string,unknown>} */ patch = {}) => { if (next === 'cancelled' && failFinalize) { failFinalize = false; throw new PluginError('JSON_WRITE_FAILED', 'disk failed', { category: 'storage', remedy: 'retry' }); } return store.transitionJob(workspaceArg, jobIdArg, expected, next, patch); } };
  const controller = createJobController({ store: wrapped, stopSession: async () => { stops += 1; } });
  await assert.rejects(controller.cancel(workspace, job.id, 'session-a'), { code: 'JOB_CANCEL_FINALIZE_FAILED' }); assert.equal(stops, 1); assert.equal((await store.readJob(workspace, job.id)).status, 'cancelling');
  assert.equal((await controller.cancel(workspace, job.id, 'session-a')).status, 'cancelled'); assert.equal(stops, 2);
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
  const completion = new Promise((resolve, reject) => { rejectCompletion = () => reject(new Error('stopped')); });
  const client = {
    createSession: async () => ({ session: { sessionId: 'zs' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } } }),
    setPermissionHandler: () => {}, send: async () => ({}), waitForCompletion: () => completion,
    readSession: async () => ({}), close: async () => {},
  };
  const execution = executeJob({ job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task' });
  while ((await store.readJob(workspace, job.id)).status !== 'running') await new Promise((resolve) => setTimeout(resolve, 1));
  const controller = createJobController({ store, stopSession: async () => { rejectCompletion(); } });
  const cancellation = controller.cancel(workspace, job.id, 'session-a');
  await assert.rejects(execution, /stopped/);
  assert.equal((await cancellation).status, 'cancelled');
  assert.equal((await store.readJob(workspace, job.id)).status, 'cancelled');
});

test('artifact directory fsync failure fails the job before success', async () => {
  const { root, workspace, store } = await setup(); const job = await store.reserveJob({ workspace, ...reservation });
  const client = { createSession: async () => ({ session: { sessionId: 'zs' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } } }), setPermissionHandler: () => {}, send: async () => ({}), waitForCompletion: async () => ({}), readSession: async () => ({ messages: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'done' }] }] }), close: async () => {} };
  const error = Object.assign(new Error('disk sync failed'), { code: 'EIO' });
  await assert.rejects(executeJob({ job, workspace, dataRoot: join(root, 'data'), store, client, task: 'task', syncDirectory: async () => { throw error; } }), { code: 'ARTIFACT_WRITE_FAILED' });
  assert.equal((await store.readJob(workspace, job.id)).status, 'failed');
});
