import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

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
