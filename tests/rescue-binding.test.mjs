// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  closeRescueBinding,
  createRescueBinding,
  parseRescueBinding,
  rescueBindingKey,
} from '../scripts/lib/rescue-binding.mjs';
import { createStateStore } from '../scripts/lib/state.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';

const identity = {
  parentSessionId: 'parent-session',
  executorAgentId: 'rescue-child',
  executorAgentType: 'zcode-rescue',
  workspace: '/canonical/workspace',
  permissionMode: 'workspace-write',
};

test('binding codec creates one exact active generation without copying caller objects', () => {
  const created = createRescueBinding({
    ...identity,
    anchorJobId: 'a'.repeat(64),
    currentJobId: 'b'.repeat(64),
    operationId: 'c'.repeat(64),
    now: '2026-08-18T01:02:03.000Z',
  });
  assert.deepEqual(Object.keys(created).sort(), [
    'anchorJobId', 'closeReason', 'closedAt', 'createdAt', 'currentJobId',
    'executorAgentId', 'executorAgentType', 'key', 'operationId', 'parentSessionId', 'permissionMode',
    'state', 'updatedAt', 'version', 'workspace',
  ].sort());
  assert.equal(created.key, rescueBindingKey(identity));
  assert.equal(created.state, 'active');
  assert.equal(created.closedAt, null);
  assert.equal(created.closeReason, null);
  const parsed = parseRescueBinding(`${JSON.stringify(created)}\n`, identity);
  parsed.state = 'closed';
  assert.equal(created.state, 'active');
});

test('binding codec closes only the expected generation with an exact tombstone', () => {
  const active = createRescueBinding({ ...identity, anchorJobId: 'a'.repeat(64), currentJobId: 'a'.repeat(64), operationId: 'c'.repeat(64), now: '2026-08-18T01:02:03.000Z' });
  const closed = closeRescueBinding(active, { operationId: active.operationId, reason: 'session-ended', now: '2026-08-18T02:02:03.000Z' });
  assert.equal(closed.state, 'closed');
  assert.equal(closed.closedAt, '2026-08-18T02:02:03.000Z');
  assert.equal(closed.closeReason, 'session-ended');
  assert.equal(closed.operationId, active.operationId);
  assert.throws(() => closeRescueBinding(active, { operationId: 'd'.repeat(64), reason: 'fresh' }), { code: 'RESCUE_BINDING_STALE' });
});

test('binding codec rejects unknown, duplicate, unsafe, and identity-mismatched data with fixed errors', () => {
  const active = createRescueBinding({ ...identity, anchorJobId: 'a'.repeat(64), currentJobId: 'a'.repeat(64), operationId: 'c'.repeat(64), now: '2026-08-18T01:02:03.000Z' });
  for (const text of [
    JSON.stringify({ ...active, secret: 'do-not-leak' }),
    JSON.stringify({ ...active, operationId: '' }),
    JSON.stringify({ ...active, workspace: '/other' }),
    JSON.stringify({ ...active, state: 'unknown' }),
    `{"version":1,"version":1}`,
  ]) assert.throws(() => parseRescueBinding(text, identity), (error) => error?.code === 'RESCUE_BINDING_INVALID' && !error.message.includes('do-not-leak'));
  assert.throws(() => parseRescueBinding(JSON.stringify(active), { ...identity, executorAgentId: 'sibling' }), { code: 'RESCUE_BINDING_INVALID' });
});

test('binding key and codec enforce bounded safe identity, digest, timestamp, and nullability fields', () => {
  assert.notEqual(rescueBindingKey(identity), rescueBindingKey({ ...identity, executorAgentId: 'other-child' }));
  for (const patch of [
    { parentSessionId: '' }, { executorAgentId: 'bad\nchild' }, { workspace: 'relative' },
    { permissionMode: 'root' }, { anchorJobId: 'a' }, { currentJobId: 'b' },
    { operationId: 'c' }, { now: 'tomorrow' },
  ]) assert.throws(() => createRescueBinding({ ...identity, anchorJobId: 'a'.repeat(64), currentJobId: 'a'.repeat(64), operationId: 'c'.repeat(64), now: '2026-08-18T01:02:03.000Z', ...patch }), { code: 'RESCUE_BINDING_INVALID' });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zcode-rescue-binding-'));
  const dataRoot = join(root, 'data'); const workspace = join(root, 'workspace');
  await mkdir(workspace);
  return { root, dataRoot, workspace, store: createStateStore({ dataRoot }) };
}

function executor(workspace, patch = {}) {
  return { parentSessionId: 'parent-session', agentId: 'rescue-child', agentType: 'zcode-rescue', workspace, parentPermissionMode: 'workspace-write', ...patch };
}

function bindingExpected(workspace, value, patch = {}) {
  return { workspace, parentSessionId: value.parentSessionId, executorAgentId: value.agentId, permissionMode: value.parentPermissionMode, ...patch };
}

function reservation(workspace, turn = 'turn-a') {
  return { workspace, ownerSessionId: 'parent-session', ownerTurnId: turn, command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } };
}

async function makeEligible(store, workspace, job, sessionId) {
  return store.transitionJob(workspace, job.id, ['queued'], 'running', { startedAt: new Date().toISOString(), zcodeSessionId: sessionId });
}

async function bindingFiles(directory) {
  const files = [];
  for (const partition of await readdir(directory, { withFileTypes: true })) {
    if (!partition.isDirectory()) continue;
    for (const name of await readdir(join(directory, partition.name))) if (name.endsWith('.json')) files.push(join(directory, partition.name, name));
  }
  return files;
}

test('StateStore atomically reserves and resolves an exact fresh Rescue generation', async () => {
  const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
  assert.deepEqual(await store.resolveRescueBinding(bindingExpected(workspace, trusted)), { kind: 'missing' });
  const reserved = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  assert.equal(reserved.job.id, reserved.binding.anchorJobId);
  assert.equal(reserved.job.id, reserved.binding.currentJobId);
  assert.equal(reserved.binding.operationId.length, 64);
  await makeEligible(store, workspace, reserved.job, 'zcode-session-a');
  const record = await store.resolveRescueBinding(bindingExpected(workspace, trusted));
  assert.equal(record.kind, 'bound');
  assert.equal(record.binding.executorAgentType, 'zcode-rescue');
  const resolved = await store.resolveRescueBindingForResume(bindingExpected(workspace, trusted));
  assert.equal(resolved.kind, 'bound');
  assert.equal(resolved.operationId, reserved.binding.operationId);
  assert.equal(resolved.anchorJob.zcodeSessionId, 'zcode-session-a');
  assert.equal(resolved.currentJob.id, reserved.job.id);
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  assert.equal((await stat(join(storage.directory, 'rescue-bindings'))).mode & 0o777, 0o700);
  assert.equal((await bindingFiles(join(storage.directory, 'rescue-bindings'))).length, 1);
});

test('Rescue reservation methods require one explicit workspace matching reservation and executor', async () => {
  const { workspace, store } = await fixture(); const trusted = executor(workspace);
  await assert.rejects(store.reserveFreshRescueJob({ reservation: reservation(workspace), executor: trusted }), { code: 'RESCUE_BINDING_INVALID' });
  await assert.rejects(store.reserveFreshRescueJob({ workspace: '/different', reservation: reservation(workspace), executor: trusted }), { code: 'RESCUE_BINDING_INVALID' });
});

test('StateStore continuation keeps the stable anchor and CAS-advances only current job', async () => {
  const { workspace, store } = await fixture(); const trusted = executor(workspace);
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  await makeEligible(store, workspace, fresh.job, 'zcode-session-a');
  await store.finishJob(workspace, fresh.job.id, ['running'], 'succeeded');
  const continued = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'), executor: trusted, operationId: fresh.binding.operationId });
  assert.equal(continued.anchorJob.zcodeSessionId, 'zcode-session-a');
  assert.equal(continued.binding.anchorJobId, fresh.job.id);
  assert.equal(continued.binding.currentJobId, continued.job.id);
  assert.equal(continued.binding.operationId, fresh.binding.operationId);
  await assert.rejects(store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-c'), executor: trusted, operationId: 'f'.repeat(64) }), { code: 'RESCUE_BINDING_STALE' });
});

test('StateStore adopts only an exact eligible legacy candidate into a new generation', async () => {
  const { workspace, store } = await fixture(); const trusted = executor(workspace);
  const legacy = await store.reserveJob(reservation(workspace));
  await makeEligible(store, workspace, legacy, 'legacy-session');
  await store.finishJob(workspace, legacy.id, ['running'], 'failed', { error: 'expected' });
  const adopted = await store.adoptRescueCandidate({ workspace, reservation: reservation(workspace, 'turn-b'), executor: trusted, candidateJobId: legacy.id });
  assert.equal(adopted.anchorJob.id, legacy.id);
  assert.equal(adopted.binding.anchorJobId, legacy.id);
  assert.equal(adopted.binding.currentJobId, adopted.job.id);
  assert.equal((await store.resolveRescueBindingForResume(bindingExpected(workspace, trusted))).anchorJob.id, legacy.id);
});

test('StateStore closes exact session bindings as tombstones without deleting jobs', async () => {
  const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  await makeEligible(store, workspace, fresh.job, 'zcode-session-a');
  const closed = await store.closeRescueBindingsForSession({ workspace, parentSessionId: trusted.parentSessionId, reason: 'session-ended' });
  assert.equal(closed, 1);
  await assert.rejects(store.resolveRescueBinding(bindingExpected(workspace, trusted)), { code: 'RESCUE_BINDING_CLOSED' });
  assert.equal((await store.readJob(workspace, fresh.job.id)).id, fresh.job.id);
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const [path] = await bindingFiles(join(storage.directory, 'rescue-bindings'));
  assert.equal(JSON.parse(await readFile(path, 'utf8')).closeReason, 'session-ended');
});

test('StateStore treats only true absence as missing and fails closed for invalid binding state', async () => {
  const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
  await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const directory = join(storage.directory, 'rescue-bindings');
  const [path] = await bindingFiles(directory);
  await writeFile(path, '{"version":1,"version":1}\n');
  await assert.rejects(store.resolveRescueBinding(bindingExpected(workspace, trusted)), { code: 'RESCUE_BINDING_INVALID' });
});

test('StateStore rejects a persisted exact-shape binding with a duplicate JSON key', async () => {
  const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  await makeEligible(store, workspace, fresh.job, 'zcode-session-a');
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const directory = join(storage.directory, 'rescue-bindings');
  const [path] = await bindingFiles(directory); const text = await readFile(path, 'utf8');
  await writeFile(path, text.replace('"version": 1,', '"version": 1,\n  "version": 1,'));
  await assert.rejects(store.resolveRescueBindingForResume(bindingExpected(workspace, trusted)), { code: 'RESCUE_BINDING_INVALID' });
});

test('StateStore rejects permission changes, sessionless and cancelled anchors without fallback', async () => {
  const { workspace, store } = await fixture(); const trusted = executor(workspace);
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  await assert.rejects(store.resolveRescueBindingForResume(bindingExpected(workspace, trusted)), { code: 'RESCUE_BINDING_INVALID' });
  await assert.rejects(store.resolveRescueBindingForResume(bindingExpected(workspace, trusted, { permissionMode: 'read-only' })), { code: 'RESCUE_BINDING_INVALID' });
  await store.finishJob(workspace, fresh.job.id, ['queued'], 'cancelled', { exitCode: null });
  await assert.rejects(store.resolveRescueBindingForResume(bindingExpected(workspace, trusted)), { code: 'RESCUE_BINDING_INVALID' });
  assert.equal((await store.readBoundRescueCurrentJob({ workspace, parentSessionId: trusted.parentSessionId, executorAgentId: trusted.agentId })).status, 'cancelled');
});

test('StateStore rejects a symlinked binding and bounds SessionEnd scans', async () => {
  const { dataRoot, root, workspace, store } = await fixture(); const trusted = executor(workspace);
  await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const directory = join(storage.directory, 'rescue-bindings');
  const [path] = await bindingFiles(directory);
  const outside = join(root, 'outside.json'); await writeFile(outside, await readFile(path));
  await import('node:fs/promises').then(({ unlink }) => unlink(path)); await symlink(outside, path);
  await assert.rejects(store.resolveRescueBinding(bindingExpected(workspace, trusted)), { code: 'RESCUE_BINDING_INVALID' });
  await assert.rejects(store.closeRescueBindingsForSession({ workspace, parentSessionId: trusted.parentSessionId, reason: 'session-ended' }), { code: 'RESCUE_BINDING_INVALID' });
});

test('concurrent fresh reservations publish one job and one exact generation', async () => {
  const { workspace, store } = await fixture(); const trusted = executor(workspace);
  const results = await Promise.allSettled([
    store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace, 'turn-a'), executor: trusted }),
    store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace, 'turn-b'), executor: trusted }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await store.listOwnedJobs(workspace, trusted.parentSessionId)).length, 1);
});

test('fresh replacement changes the operation generation and rejects the old CAS token', async () => {
  const { workspace, store } = await fixture(); const trusted = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  await makeEligible(store, workspace, first.job, 'zcode-session-a'); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  const second = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace, 'turn-b'), executor: trusted });
  assert.notEqual(second.binding.operationId, first.binding.operationId);
  await makeEligible(store, workspace, second.job, 'zcode-session-b'); await store.finishJob(workspace, second.job.id, ['running'], 'succeeded');
  await assert.rejects(store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-c'), executor: trusted, operationId: first.binding.operationId }), { code: 'RESCUE_BINDING_STALE' });
});

test('fresh may replace a valid permission-mismatched slot but not corrupt provenance', async () => {
  const { workspace, store } = await fixture(); const trusted = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  await makeEligible(store, workspace, first.job, 'zcode-session-a'); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  const changed = executor(workspace, { parentPermissionMode: 'read-only' });
  const changedReservation = { ...reservation(workspace, 'turn-b'), permissionSnapshot: { permissionMode: 'read-only' } };
  const second = await store.reserveFreshRescueJob({ workspace, reservation: changedReservation, executor: changed });
  assert.equal(second.binding.permissionMode, 'read-only');
  assert.notEqual(second.binding.operationId, first.binding.operationId);
  await assert.rejects(store.reserveFreshRescueJob({ workspace, reservation: changedReservation, executor: executor(workspace, { agentType: 'unapproved', parentPermissionMode: 'read-only' }) }), { code: 'RESCUE_BINDING_INVALID' });
});

test('binding capacity is isolated per parent session and active slots are never age-GCed', async () => {
  const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  await makeEligible(store, workspace, first.job, 'zcode-session-a'); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const root = join(storage.directory, 'rescue-bindings');
  const [partition] = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()); const directory = join(root, partition.name);
  for (let index = 1; index < 1024; index += 1) {
    const item = createRescueBinding({ ...identity, workspace: storage.workspacePath, executorAgentId: `child-${index}`, anchorJobId: 'a'.repeat(64), currentJobId: 'a'.repeat(64), operationId: index.toString(16).padStart(64, '0'), now: '2020-01-01T00:00:00.000Z' });
    await writeFile(join(directory, `${item.key}.json`), `${JSON.stringify(item)}\n`);
  }
  await assert.rejects(store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace, 'turn-b'), executor: executor(workspace, { agentId: 'overflow-child' }) }), { code: 'RESCUE_BINDING_CAPACITY' });
  const siblingExecutor = executor(workspace, { parentSessionId: 'sibling-session', agentId: 'sibling-child' });
  const siblingReservation = { ...reservation(workspace, 'sibling-turn'), ownerSessionId: 'sibling-session' };
  assert.equal((await store.reserveFreshRescueJob({ workspace, reservation: siblingReservation, executor: siblingExecutor })).binding.parentSessionId, 'sibling-session');
});

test('new-slot creation GCs only valid closed tombstones older than thirty days', async () => {
  const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  await makeEligible(store, workspace, first.job, 'zcode-session-a'); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  await store.closeRescueBindingsForSession({ workspace, parentSessionId: trusted.parentSessionId, reason: 'session-ended' });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const root = join(storage.directory, 'rescue-bindings'); const [closedPath] = await bindingFiles(root);
  const old = createRescueBinding({ ...identity, workspace: storage.workspacePath, anchorJobId: first.job.id, currentJobId: first.job.id, operationId: first.binding.operationId, now: '2020-01-01T00:00:00.000Z' });
  await writeFile(closedPath, `${JSON.stringify(closeRescueBinding(old, { operationId: old.operationId, reason: 'session-ended', now: '2020-01-02T00:00:00.000Z' }))}\n`);
  const directory = join(root, (await readdir(root))[0]);
  for (let index = 1; index < 1024; index += 1) {
    const item = createRescueBinding({ ...identity, workspace: storage.workspacePath, executorAgentId: `child-${index}`, anchorJobId: 'a'.repeat(64), currentJobId: 'a'.repeat(64), operationId: index.toString(16).padStart(64, '0'), now: '2020-01-01T00:00:00.000Z' });
    await writeFile(join(directory, `${item.key}.json`), `${JSON.stringify(item)}\n`);
  }
  const replacement = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace, 'turn-b'), executor: executor(workspace, { agentId: 'replacement-child' }) });
  assert.equal(replacement.binding.executorAgentId, 'replacement-child');
  await assert.rejects(readFile(closedPath), { code: 'ENOENT' });
});
