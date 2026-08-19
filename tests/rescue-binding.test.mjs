// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import {
  closeRescueBinding,
  createRescueBindingAuthority,
  createRescueBindingPartition,
  createRescueBinding,
  parseRescueBinding,
  parseRescueBindingAuthority,
  parseRescueBindingPartition,
  RESCUE_BINDING_AUTHORITY_MAX_BYTES,
  RESCUE_BINDING_PARTITION_MAX_BYTES,
  rescueBindingKey,
} from '../scripts/lib/rescue-binding.mjs';
import { createStateStore } from '../scripts/lib/state.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';

const codecWorkspace = resolve(tmpdir(), 'zcode-canonical-codec-workspace');
const foreignCodecWorkspace = resolve(tmpdir(), 'zcode-foreign-codec-workspace');
const identity = {
  parentSessionId: 'parent-session',
  executorAgentId: 'rescue-child',
  executorAgentType: 'zcode-rescue',
  executorParentTurnId: 'origin-turn',
  executorParentPermissionMode: 'workspace-write',
  workspace: codecWorkspace,
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
    'executorAgentId', 'executorAgentType', 'executorParentPermissionMode', 'executorParentTurnId', 'key', 'operationId', 'parentSessionId', 'permissionMode',
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
    JSON.stringify({ ...active, workspace: foreignCodecWorkspace }),
    JSON.stringify({ ...active, state: 'unknown' }),
    `{"version":1,"version":1}`,
  ]) assert.throws(() => parseRescueBinding(text, identity), (error) => error?.code === 'RESCUE_BINDING_INVALID' && !error.message.includes('do-not-leak'));
  assert.throws(() => parseRescueBinding(JSON.stringify(active), { ...identity, executorAgentId: 'sibling' }), { code: 'RESCUE_BINDING_INVALID' });
});

test('binding key and codec enforce bounded safe identity, digest, timestamp, and nullability fields', () => {
  assert.notEqual(rescueBindingKey(identity), rescueBindingKey({ ...identity, executorAgentId: 'other-child' }));
  for (const patch of [
    { parentSessionId: '' }, { executorAgentId: 'bad\nchild' }, { workspace: 'relative' },
    { permissionMode: 'root' }, { executorParentPermissionMode: 'root' }, { executorParentTurnId: 'bad\nturn' }, { anchorJobId: 'a' }, { currentJobId: 'b' },
    { operationId: 'c' }, { now: 'tomorrow' },
  ]) assert.throws(() => createRescueBinding({ ...identity, anchorJobId: 'a'.repeat(64), currentJobId: 'a'.repeat(64), operationId: 'c'.repeat(64), now: '2026-08-18T01:02:03.000Z', ...patch }), { code: 'RESCUE_BINDING_INVALID' });
  assert.throws(() => createRescueBinding({ ...identity, permissionMode: undefined, anchorJobId: 'a'.repeat(64), currentJobId: 'a'.repeat(64), operationId: 'c'.repeat(64) }), { code: 'RESCUE_BINDING_INVALID' });
  assert.throws(() => createRescueBinding({ ...identity, workspace: `${codecWorkspace}${sep}..${sep}workspace`, anchorJobId: 'a'.repeat(64), currentJobId: 'a'.repeat(64), operationId: 'c'.repeat(64) }), { code: 'RESCUE_BINDING_INVALID' });
  assert.throws(() => parseRescueBinding(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])), { code: 'RESCUE_BINDING_INVALID' });
});

test('partition codec enforces one exact bounded parent-session envelope and unique child keys', () => {
  const record = createRescueBinding({ ...identity, anchorJobId: 'a'.repeat(64), currentJobId: 'a'.repeat(64), operationId: 'c'.repeat(64) });
  const partition = createRescueBindingPartition({ parentSessionId: identity.parentSessionId, workspace: identity.workspace, records: [record] });
  assert.deepEqual(Object.keys(partition).sort(), ['key', 'parentSessionId', 'records', 'version', 'workspace']);
  assert.equal(partition.records.length, 1);
  assert.throws(() => parseRescueBindingPartition(`${JSON.stringify({ ...partition, workspace: foreignCodecWorkspace })}\n`, identity), { code: 'RESCUE_BINDING_INVALID' });
  assert.throws(() => parseRescueBindingPartition(`${JSON.stringify({ ...partition, parentSessionId: 'foreign-session' })}\n`, identity), { code: 'RESCUE_BINDING_INVALID' });
  assert.throws(() => parseRescueBindingPartition(`${JSON.stringify({ ...partition, records: [record, record] })}\n`, identity), { code: 'RESCUE_BINDING_INVALID' });
  const compact = `${JSON.stringify(partition)}\n`; const boundary = `${compact.slice(0, -1)}${' '.repeat(RESCUE_BINDING_PARTITION_MAX_BYTES - Buffer.byteLength(compact))}\n`;
  assert.equal(parseRescueBindingPartition(boundary, identity).records.length, 1);
  assert.throws(() => parseRescueBindingPartition(`${boundary.slice(0, -1)} \n`, identity), { code: 'RESCUE_BINDING_INVALID' });
  const authority = createRescueBindingAuthority(identity); assert.equal(parseRescueBindingAuthority(`${JSON.stringify(authority)}\n`, identity).key, partition.key);
  for (const invalid of [
    { ...authority, version: 2 }, { ...authority, workspace: foreignCodecWorkspace }, { ...authority, parentSessionId: 'foreign' },
    { ...authority, createdAt: authority.createdAt.replace('Z', '+00:00') }, { ...authority, unknown: true },
  ]) assert.throws(() => parseRescueBindingAuthority(`${JSON.stringify(invalid)}\n`, identity), { code: 'RESCUE_BINDING_INVALID' });
  assert.throws(() => parseRescueBindingAuthority(`${JSON.stringify(authority).replace('"version":1', '"version":1,"version":1')}\n`, identity), { code: 'RESCUE_BINDING_INVALID' });
  assert.throws(() => parseRescueBindingAuthority(Buffer.alloc(RESCUE_BINDING_AUTHORITY_MAX_BYTES + 1, 0x20), identity), { code: 'RESCUE_BINDING_INVALID' });
});

test('all binding parsers map deeply nested JSON scanner exhaustion to one secret-free fixed error', () => {
  const nested = `${'['.repeat(6_000)}"do-not-leak"${']'.repeat(6_000)}\n`;
  for (const parse of [
    () => parseRescueBinding(nested),
    () => parseRescueBindingPartition(nested, identity),
    () => parseRescueBindingAuthority(nested, identity),
  ]) assert.throws(parse, (error) => error?.code === 'RESCUE_BINDING_INVALID' && !error.message.includes('do-not-leak'));
});

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zcode-rescue-binding-'));
  const dataRoot = join(root, 'data'); const workspace = join(root, 'workspace');
  await mkdir(workspace);
  return { root, dataRoot, workspace, store: createStateStore({ dataRoot, ...options }) };
}

function executor(workspace, patch = {}) {
  return { parentSessionId: 'parent-session', parentTurnId: 'origin-turn', agentId: 'rescue-child', agentType: 'zcode-rescue', workspace, parentPermissionMode: 'workspace-write', ...patch };
}

function bindingExpected(workspace, value, patch = {}) {
  return { workspace, parentSessionId: value.parentSessionId, executorAgentId: value.agentId, executorAgentType: value.agentType,
    executorParentTurnId: value.parentTurnId, executorParentPermissionMode: value.parentPermissionMode, permissionMode: value.parentPermissionMode, ...patch };
}

function reservation(workspace, turn = 'turn-a') {
  return { workspace, ownerSessionId: 'parent-session', ownerTurnId: turn, command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } };
}

async function makeEligible(store, workspace, job, sessionId) {
  return store.transitionJob(workspace, job.id, ['queued'], 'running', { startedAt: new Date().toISOString(), zcodeSessionId: sessionId });
}

async function bindingFiles(directory) {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^rescue-binding-session-[a-f0-9]{64}\.json$/u.test(entry.name))
    .map((entry) => join(directory, entry.name));
}

function throwingAt(expected) {
  let fired = false;
  return async (seam) => { if (!fired && seam === expected) { fired = true; throw new Error(`injected ${seam}`); } };
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
  const [partitionPath] = await bindingFiles(storage.directory); const metadata = await stat(partitionPath); assert.equal(metadata.isFile(), true); if (process.platform !== 'win32') assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal((await bindingFiles(storage.directory)).length, 1);
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

test('bound choice reservations atomically reject stale operation or current snapshots without publishing a job', async () => {
  const { workspace, store } = await fixture(); const trusted = executor(workspace);
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  await makeEligible(store, workspace, fresh.job, 'zcode-session-a');
  await store.finishJob(workspace, fresh.job.id, ['running'], 'succeeded');
  const continued = await store.reserveBoundRescueContinuation({
    workspace, reservation: reservation(workspace, 'turn-b'), executor: trusted,
    operationId: fresh.binding.operationId,
    expectedAnchorJobId: fresh.binding.anchorJobId,
    expectedCurrentJobId: fresh.binding.currentJobId,
  });
  await store.finishJob(workspace, continued.job.id, ['queued'], 'failed');
  const before = (await store.listJobs(workspace)).map((job) => job.id).sort();
  await assert.rejects(store.reserveBoundRescueContinuation({
    workspace, reservation: reservation(workspace, 'stale-resume'), executor: trusted,
    operationId: fresh.binding.operationId,
    expectedAnchorJobId: fresh.binding.anchorJobId,
    expectedCurrentJobId: fresh.binding.currentJobId,
  }), { code: 'RESCUE_BINDING_STALE' });
  await assert.rejects(store.reserveFreshRescueJob({
    workspace, reservation: reservation(workspace, 'stale-fresh'), executor: trusted,
    expectedOperationId: fresh.binding.operationId,
    expectedAnchorJobId: fresh.binding.anchorJobId,
    expectedCurrentJobId: fresh.binding.currentJobId,
  }), { code: 'RESCUE_BINDING_STALE' });
  assert.deepEqual((await store.listJobs(workspace)).map((job) => job.id).sort(), before);
});

test('bound choice reservations reject a wrong candidate and anchor-only mutation without publication', async () => {
  const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  await makeEligible(store, workspace, fresh.job, 'session-a'); await store.finishJob(workspace, fresh.job.id, ['running'], 'succeeded');
  const before = (await store.listJobs(workspace)).map((job) => job.id).sort();
  for (const route of ['resume', 'fresh']) {
    const input = { workspace, reservation: reservation(workspace, `wrong-${route}`), executor: trusted, expectedAnchorJobId: 'f'.repeat(64), expectedCurrentJobId: fresh.binding.currentJobId };
    const operation = route === 'resume'
      ? store.reserveBoundRescueContinuation({ ...input, operationId: fresh.binding.operationId })
      : store.reserveFreshRescueJob({ ...input, expectedOperationId: fresh.binding.operationId });
    await assert.rejects(operation, { code: 'RESCUE_BINDING_STALE' });
  }
  assert.deepEqual((await store.listJobs(workspace)).map((job) => job.id).sort(), before);
  const alternate = await store.reserveJob({ ...reservation(workspace, 'alternate'), readOnly: true }); await makeEligible(store, workspace, alternate, 'session-b');
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const [path] = await bindingFiles(storage.directory); const partition = JSON.parse(await readFile(path, 'utf8'));
  partition.records[0].anchorJobId = alternate.id; partition.records[0].updatedAt = new Date(Date.parse(partition.records[0].updatedAt) + 1).toISOString(); await writeFile(path, `${JSON.stringify(partition, null, 2)}\n`);
  const afterMutation = (await store.listJobs(workspace)).map((job) => job.id).sort();
  for (const route of ['resume', 'fresh']) {
    const input = { workspace, reservation: reservation(workspace, `mutated-${route}`), executor: trusted, expectedAnchorJobId: fresh.binding.anchorJobId, expectedCurrentJobId: fresh.binding.currentJobId };
    const operation = route === 'resume'
      ? store.reserveBoundRescueContinuation({ ...input, operationId: fresh.binding.operationId })
      : store.reserveFreshRescueJob({ ...input, expectedOperationId: fresh.binding.operationId });
    await assert.rejects(operation, { code: 'RESCUE_BINDING_STALE' });
  }
  assert.deepEqual((await store.listJobs(workspace)).map((job) => job.id).sort(), afterMutation);
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
  await makeEligible(store, workspace, fresh.job, 'zcode-session-a'); await store.finishJob(workspace, fresh.job.id, ['running'], 'succeeded');
  const siblingExecutor = executor(workspace, { parentSessionId: 'sibling-session', agentId: 'sibling-child' });
  const siblingReservation = { ...reservation(workspace, 'sibling-turn'), ownerSessionId: 'sibling-session' };
  const sibling = await store.reserveFreshRescueJob({ workspace, reservation: siblingReservation, executor: siblingExecutor }); await store.finishJob(workspace, sibling.job.id, ['queued'], 'failed');
  const closed = await store.closeRescueBindingsForSession({ workspace, parentSessionId: trusted.parentSessionId, reason: 'session-ended' });
  assert.equal(closed, 1);
  await assert.rejects(store.resolveRescueBinding(bindingExpected(workspace, trusted)), { code: 'RESCUE_BINDING_CLOSED' });
  assert.equal((await store.resolveRescueBinding(bindingExpected(workspace, siblingExecutor))).kind, 'bound');
  assert.equal((await store.readJob(workspace, fresh.job.id)).id, fresh.job.id);
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const paths = await bindingFiles(storage.directory); const partitions = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, 'utf8'))));
  assert.equal(partitions.find((partition) => partition.parentSessionId === trusted.parentSessionId).records[0].closeReason, 'session-ended');
});

test('StateStore treats only true absence as missing and fails closed for invalid binding state', async () => {
  const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
  await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const [path] = await bindingFiles(storage.directory);
  await writeFile(path, '{"version":1,"version":1}\n');
  await assert.rejects(store.resolveRescueBinding(bindingExpected(workspace, trusted)), { code: 'RESCUE_BINDING_INVALID' });
});

test('StateStore fails closed when a same-session sibling claims a foreign canonical workspace', async () => {
  const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const [path] = await bindingFiles(storage.directory);
  const foreign = createRescueBinding({ ...identity, workspace: foreignCodecWorkspace, executorAgentId: 'foreign-child', anchorJobId: fresh.job.id, currentJobId: fresh.job.id, operationId: 'e'.repeat(64) });
  const partition = JSON.parse(await readFile(path, 'utf8')); partition.records.push(foreign); await writeFile(path, `${JSON.stringify(partition)}\n`);
  await assert.rejects(store.resolveRescueBinding(bindingExpected(workspace, executor(workspace, { agentId: 'absent-child' }))), { code: 'RESCUE_BINDING_INVALID' });
});

test('StateStore rejects a persisted exact-shape binding with a duplicate JSON key', async () => {
  const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  await makeEligible(store, workspace, fresh.job, 'zcode-session-a');
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const [path] = await bindingFiles(storage.directory); const text = await readFile(path, 'utf8');
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
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const [path] = await bindingFiles(storage.directory);
  const outside = join(root, 'outside.json'); await writeFile(outside, await readFile(path));
  await import('node:fs/promises').then(({ unlink }) => unlink(path)); await symlink(outside, path);
  await assert.rejects(store.resolveRescueBinding(bindingExpected(workspace, trusted)), { code: 'RESCUE_BINDING_INVALID' });
  await assert.rejects(store.closeRescueBindingsForSession({ workspace, parentSessionId: trusted.parentSessionId, reason: 'session-ended' }), { code: 'RESCUE_BINDING_INVALID' });
});

test('unpublished atomic temp remnants are harmless beside the exact partition file', async () => {
  const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
  await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); await writeFile(join(storage.directory, '.rescue-binding-session-interrupted.tmp'), '{}');
  assert.equal((await store.resolveRescueBinding(bindingExpected(workspace, trusted))).kind, 'bound');
});

test('publication rejects binding-partition and state-lock replacement without authorizing partial state', async () => {
  {
    const base = await fixture(); const storage = await resolveWorkspaceStorage({ dataRoot: base.dataRoot, workspace: base.workspace }); let replaced = false;
    const store = createStateStore({ dataRoot: base.dataRoot, testOnlyPublicationHook: async (seam) => {
      if (replaced || seam !== 'fresh:owner-binding') return; replaced = true;
      const [partition] = await bindingFiles(storage.directory); await rename(partition, `${partition}.replaced`); await writeFile(partition, '{}');
    } });
    await assert.rejects(store.reserveFreshRescueJob({ workspace: base.workspace, reservation: reservation(base.workspace), executor: executor(base.workspace) }), { code: 'RESCUE_BINDING_INVALID' });
  }
  {
    const base = await fixture(); const storage = await resolveWorkspaceStorage({ dataRoot: base.dataRoot, workspace: base.workspace }); let replaced = false;
    const store = createStateStore({ dataRoot: base.dataRoot, testOnlyPublicationHook: async (seam) => {
      if (replaced || seam !== 'fresh:owner-binding') return; replaced = true;
      const lock = join(storage.directory, '.state.lock');
      await rename(lock, `${lock}.replaced`); await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, 'advisory.lock'), '', { mode: 0o600 });
    } });
    await assert.rejects(store.reserveFreshRescueJob({ workspace: base.workspace, reservation: reservation(base.workspace), executor: executor(base.workspace) }), { code: process.platform === 'win32' ? 'RESCUE_PUBLICATION_TEST_FAULT' : 'RESCUE_BINDING_INVALID' });
    const clean = createStateStore({ dataRoot: base.dataRoot });
    await assert.rejects(clean.resolveRescueBindingForResume(bindingExpected(base.workspace, executor(base.workspace))), { code: 'RESCUE_BINDING_INVALID' });
  }
});

test('every post-binding checkpoint rejects every authority and partition mutation durably', async () => {
  const scenarios = [
    ...['fresh:owner-binding', 'fresh:job', 'fresh:marker', 'fresh:final'].map((seam) => ({ route: 'fresh', seam })),
    ...['continuation:owner-binding', 'continuation:job', 'continuation:marker', 'continuation:current-advance', 'continuation:final'].map((seam) => ({ route: 'continuation', seam })),
    ...['adopt:owner-binding', 'adopt:job', 'adopt:marker', 'adopt:current-advance', 'adopt:final'].map((seam) => ({ route: 'adopt', seam })),
  ];
  for (const scenario of scenarios) {
    await Promise.all(['authority', 'session'].flatMap((kind) => ['delete', 'replace', 'corrupt', 'symlink'].map(async (mutation) => {
      const base = await fixture(); const trusted = executor(base.workspace); let anchor;
      if (scenario.route !== 'fresh') {
        anchor = await base.store.reserveJob(reservation(base.workspace)); await makeEligible(base.store, base.workspace, anchor, 'stable-session'); await base.store.finishJob(base.workspace, anchor.id, ['running'], 'failed');
        if (scenario.route === 'continuation') {
          const adopted = await base.store.adoptRescueCandidate({ workspace: base.workspace, reservation: reservation(base.workspace, 'seed'), executor: trusted, candidateJobId: anchor.id });
          await base.store.finishJob(base.workspace, adopted.job.id, ['queued'], 'failed'); anchor = adopted;
        }
      }
      const storage = await resolveWorkspaceStorage({ dataRoot: base.dataRoot, workspace: base.workspace }); let mutated = false;
      const store = createStateStore({ dataRoot: base.dataRoot, testOnlyPublicationHook: async (seam) => {
        if (mutated || seam !== scenario.seam) return; mutated = true;
        const [name] = (await readdir(storage.directory)).filter((entry) => entry.startsWith(`rescue-binding-${kind}-`)); const path = join(storage.directory, name); const { unlink } = await import('node:fs/promises');
        if (mutation === 'delete') await unlink(path);
        else if (mutation === 'replace') { await rename(path, `${path}.replaced`); await writeFile(path, '{}'); }
        else if (mutation === 'corrupt') await writeFile(path, '{broken');
        else { const outside = join(base.root, `${kind}.json`); await writeFile(outside, '{}'); await unlink(path); await symlink(outside, path); }
      } });
      const operation = scenario.route === 'fresh'
        ? store.reserveFreshRescueJob({ workspace: base.workspace, reservation: reservation(base.workspace, 'attempt'), executor: trusted })
        : scenario.route === 'continuation'
          ? store.reserveBoundRescueContinuation({ workspace: base.workspace, reservation: reservation(base.workspace, 'attempt'), executor: trusted, operationId: anchor.binding.operationId })
          : store.adoptRescueCandidate({ workspace: base.workspace, reservation: reservation(base.workspace, 'attempt'), executor: trusted, candidateJobId: anchor.id });
      await assert.rejects(operation, { code: 'RESCUE_BINDING_INVALID' }, `${scenario.seam}/${kind}/${mutation}`);
      await assert.rejects(createStateStore({ dataRoot: base.dataRoot }).resolveRescueBinding(bindingExpected(base.workspace, trusted)), { code: 'RESCUE_BINDING_INVALID' }, `${scenario.seam}/${kind}/${mutation} next resolve`);
    })));
  }
});

test('oversized persisted binding records fail closed before allocation or parsing', async () => {
  const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
  await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const [path] = await bindingFiles(storage.directory);
  await writeFile(path, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
  await assert.rejects(store.resolveRescueBinding(bindingExpected(workspace, trusted)), { code: 'RESCUE_BINDING_INVALID' });
});

test('a valid prospective new record that exceeds the partition byte budget reports capacity', async () => {
  const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted }); await store.finishJob(workspace, first.job.id, ['queued'], 'failed');
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const [path] = await bindingFiles(storage.directory); const maximumBytes = (await stat(path)).size;
  const bounded = createStateStore({ dataRoot, testOnlyBindingPartitionMaxBytes: maximumBytes }); const second = executor(workspace, { agentId: 'second-child' });
  await assert.rejects(bounded.reserveFreshRescueJob({ workspace, reservation: reservation(workspace, 'second'), executor: second }), { code: 'RESCUE_BINDING_CAPACITY' });
  assert.equal((await store.resolveRescueBinding(bindingExpected(workspace, trusted))).kind, 'bound');
});

test('legacy-style job readers observe unchanged job schema and ignore Rescue binding storage', async () => {
  const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
  const legacy = await store.reserveJob({ ...reservation(workspace, 'legacy'), command: 'review', readOnly: true });
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const jobsDirectory = join(storage.directory, 'jobs');
  const legacyRead = async () => Promise.all((await readdir(jobsDirectory)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)).map(async (name) => JSON.parse(await readFile(join(jobsDirectory, name), 'utf8'))));
  const jobs = await legacyRead(); assert.equal(jobs.length, 2);
  assert.deepEqual(Object.keys(jobs.find((job) => job.id === fresh.job.id)).sort(), Object.keys(legacy).sort());
  assert.equal((await bindingFiles(storage.directory)).length, 1);
});

test('legacy reservation ignores Rescue publication hooks and SessionEnd closes one whole partition idempotently', async () => {
  const { dataRoot, workspace } = await fixture();
  const legacy = createStateStore({ dataRoot, testOnlyPublicationHook: throwingAt('fresh:binding') });
  assert.equal((await legacy.reserveJob({ ...reservation(workspace), command: 'review', readOnly: true })).command, 'review');
  const clean = createStateStore({ dataRoot });
  const firstExecutor = executor(workspace); const first = await clean.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: firstExecutor });
  await makeEligible(clean, workspace, first.job, 'first-session'); await clean.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  const secondExecutor = executor(workspace, { agentId: 'second-child' }); const second = await clean.reserveFreshRescueJob({ workspace, reservation: reservation(workspace, 'second'), executor: secondExecutor });
  await makeEligible(clean, workspace, second.job, 'second-session'); await clean.finishJob(workspace, second.job.id, ['running'], 'succeeded');
  const partial = createStateStore({ dataRoot, testOnlyPublicationHook: throwingAt('close:binding') });
  await assert.rejects(partial.closeRescueBindingsForSession({ workspace, parentSessionId: firstExecutor.parentSessionId, reason: 'session-ended' }), { code: 'RESCUE_PUBLICATION_TEST_FAULT' });
  assert.equal((await clean.resolveRescueBinding(bindingExpected(workspace, firstExecutor))).kind, 'bound');
  assert.equal((await clean.resolveRescueBinding(bindingExpected(workspace, secondExecutor))).kind, 'bound');
  assert.equal(await clean.closeRescueBindingsForSession({ workspace, parentSessionId: firstExecutor.parentSessionId, reason: 'session-ended' }), 2);
  assert.equal(await clean.closeRescueBindingsForSession({ workspace, parentSessionId: firstExecutor.parentSessionId, reason: 'session-ended' }), 0);
  await assert.rejects(clean.resolveRescueBinding(bindingExpected(workspace, firstExecutor)), { code: 'RESCUE_BINDING_CLOSED' });
  await assert.rejects(clean.resolveRescueBinding(bindingExpected(workspace, secondExecutor)), { code: 'RESCUE_BINDING_CLOSED' });
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

test('fresh publication seams leave only safe fail-closed state and deterministic retries', async () => {
  for (const seam of ['fresh:binding', 'fresh:owner-binding', 'fresh:job', 'fresh:marker', 'fresh:final']) {
    const { dataRoot, workspace, store } = await fixture({ testOnlyPublicationHook: throwingAt(seam) }); const trusted = executor(workspace);
    await assert.rejects(store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted }), { code: 'RESCUE_PUBLICATION_TEST_FAULT' });
    const clean = createStateStore({ dataRoot }); const jobs = await clean.listJobs(workspace);
    if (seam === 'fresh:binding') await assert.rejects(clean.resolveRescueBinding(bindingExpected(workspace, trusted)), { code: 'RESCUE_BINDING_INVALID' });
    else {
      const binding = await clean.resolveRescueBinding(bindingExpected(workspace, trusted));
      assert.equal(binding.kind, 'bound');
      if (seam !== 'fresh:final') await assert.rejects(clean.resolveRescueBindingForResume(bindingExpected(workspace, trusted)), { code: 'RESCUE_BINDING_INVALID' });
    }
    assert.equal(jobs.length, ['fresh:marker', 'fresh:final'].includes(seam) ? 1 : 0);
    if (['fresh:marker', 'fresh:final'].includes(seam)) await assert.rejects(clean.reserveFreshRescueJob({ workspace, reservation: reservation(workspace, 'retry'), executor: trusted }), { code: 'WRITABLE_JOB_EXISTS' });
    else assert.equal((await clean.reserveFreshRescueJob({ workspace, reservation: reservation(workspace, 'retry'), executor: trusted })).job.status, 'queued');
  }
});

test('legacy candidate adoption cannot repair an authority-only fresh crash remnant', async () => {
  const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
  const candidate = await store.reserveJob(reservation(workspace, 'candidate'));
  await makeEligible(store, workspace, candidate, 'candidate-session');
  await store.finishJob(workspace, candidate.id, ['running'], 'succeeded');
  const faulted = createStateStore({ dataRoot, testOnlyPublicationHook: throwingAt('fresh:binding') });
  await assert.rejects(
    faulted.reserveFreshRescueJob({ workspace, reservation: reservation(workspace, 'crashed-fresh'), executor: trusted }),
    { code: 'RESCUE_PUBLICATION_TEST_FAULT' },
  );
  const before = await store.listJobs(workspace);
  await assert.rejects(
    store.adoptRescueCandidate({ workspace, reservation: reservation(workspace, 'adopt'), executor: trusted, candidateJobId: candidate.id }),
    { code: 'RESCUE_BINDING_INVALID' },
  );
  assert.deepEqual(await store.listJobs(workspace), before);
});

test('continuation publication seams retain the stable prior binding and serialize two writers', async () => {
  for (const seam of ['continuation:owner-binding', 'continuation:job', 'continuation:marker', 'continuation:current-advance', 'continuation:final']) {
    const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
    const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
    await makeEligible(store, workspace, fresh.job, 'stable-session'); await store.finishJob(workspace, fresh.job.id, ['running'], 'succeeded');
    const faulted = createStateStore({ dataRoot, testOnlyPublicationHook: throwingAt(seam) });
    await assert.rejects(faulted.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'next'), executor: trusted, operationId: fresh.binding.operationId }), { code: 'RESCUE_PUBLICATION_TEST_FAULT' });
    const clean = createStateStore({ dataRoot }); const resolved = await clean.resolveRescueBindingForResume(bindingExpected(workspace, trusted));
    if (seam === 'continuation:final') assert.notEqual(resolved.currentJob.id, fresh.job.id); else assert.equal(resolved.currentJob.id, fresh.job.id);
    assert.equal(resolved.anchorJob.zcodeSessionId, 'stable-session');
    const jobs = await clean.listJobs(workspace); assert.equal(jobs.length, ['continuation:marker', 'continuation:current-advance', 'continuation:final'].includes(seam) ? 2 : 1);
    const retry = clean.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'retry'), executor: trusted, operationId: fresh.binding.operationId });
    if (['continuation:marker', 'continuation:current-advance', 'continuation:final'].includes(seam)) await assert.rejects(retry, { code: 'WRITABLE_JOB_EXISTS' });
    else assert.equal((await retry).binding.anchorJobId, fresh.job.id);
  }
  const { workspace, store } = await fixture(); const trusted = executor(workspace);
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  await makeEligible(store, workspace, fresh.job, 'stable-session'); await store.finishJob(workspace, fresh.job.id, ['running'], 'succeeded');
  const results = await Promise.allSettled(['a', 'b'].map((turn) => store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, turn), executor: trusted, operationId: fresh.binding.operationId })));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason?.code === 'WRITABLE_JOB_EXISTS').length, 1);
});

test('adoption publication seams pin only the explicit candidate and concurrent adoption has one winner', async () => {
  for (const seam of ['adopt:base-binding', 'adopt:owner-binding', 'adopt:job', 'adopt:marker', 'adopt:current-advance', 'adopt:final']) {
    const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
    const candidate = await store.reserveJob(reservation(workspace)); await makeEligible(store, workspace, candidate, 'candidate-session'); await store.finishJob(workspace, candidate.id, ['running'], 'failed');
    const faulted = createStateStore({ dataRoot, testOnlyPublicationHook: throwingAt(seam) });
    await assert.rejects(faulted.adoptRescueCandidate({ workspace, reservation: reservation(workspace, 'adopt'), executor: trusted, candidateJobId: candidate.id }), { code: 'RESCUE_PUBLICATION_TEST_FAULT' });
    const clean = createStateStore({ dataRoot }); let binding;
    if (seam === 'adopt:base-binding') await assert.rejects(clean.resolveRescueBinding(bindingExpected(workspace, trusted)), { code: 'RESCUE_BINDING_INVALID' });
    else { binding = await clean.resolveRescueBinding(bindingExpected(workspace, trusted)); assert.equal(binding.kind, 'bound'); assert.equal(binding.binding.anchorJobId, candidate.id); if (seam === 'adopt:final') assert.notEqual(binding.binding.currentJobId, candidate.id); else assert.equal(binding.binding.currentJobId, candidate.id); }
    assert.equal((await clean.listJobs(workspace)).length, ['adopt:marker', 'adopt:current-advance', 'adopt:final'].includes(seam) ? 2 : 1);
    if (seam === 'adopt:base-binding') {
      await assert.rejects(
        clean.adoptRescueCandidate({ workspace, reservation: reservation(workspace, 'retry'), executor: trusted, candidateJobId: candidate.id }),
        { code: 'RESCUE_BINDING_INVALID' },
      );
      const repaired = await clean.reserveFreshRescueJob({ workspace, reservation: reservation(workspace, 'fresh-repair'), executor: trusted });
      assert.equal(repaired.binding.anchorJobId, repaired.job.id);
    }
    else {
      const retry = clean.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'retry'), executor: trusted, operationId: binding.binding.operationId });
      if (['adopt:marker', 'adopt:current-advance', 'adopt:final'].includes(seam)) await assert.rejects(retry, { code: 'WRITABLE_JOB_EXISTS' });
      else assert.equal((await retry).anchorJob.id, candidate.id);
    }
  }
  const { workspace, store } = await fixture(); const trusted = executor(workspace);
  const candidate = await store.reserveJob(reservation(workspace)); await makeEligible(store, workspace, candidate, 'candidate-session'); await store.finishJob(workspace, candidate.id, ['running'], 'failed');
  const results = await Promise.allSettled(['a', 'b'].map((turn) => store.adoptRescueCandidate({ workspace, reservation: reservation(workspace, turn), executor: trusted, candidateJobId: candidate.id })));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
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
  const changedReservation = { ...reservation(workspace, 'turn-b'), permissionSnapshot: { permissionMode: 'read-only' } };
  const second = await store.reserveFreshRescueJob({ workspace, reservation: changedReservation, executor: trusted });
  assert.equal(second.binding.permissionMode, 'read-only');
  assert.equal(second.binding.executorParentTurnId, 'origin-turn'); assert.equal(second.binding.executorParentPermissionMode, 'workspace-write');
  assert.notEqual(second.binding.operationId, first.binding.operationId);
  await makeEligible(store, workspace, second.job, 'zcode-session-b'); await store.finishJob(workspace, second.job.id, ['running'], 'succeeded');
  for (const forged of [executor(workspace, { parentTurnId: 'rewritten-turn' }), executor(workspace, { parentPermissionMode: 'read-only' }), executor(workspace, { agentType: 'unapproved' })]) {
    await assert.rejects(store.reserveFreshRescueJob({ workspace, reservation: changedReservation, executor: forged }), { code: 'RESCUE_BINDING_INVALID' });
  }
});

test('resolve and continuation reject forged stopped-executor provenance without publication', async () => {
  const { workspace, store } = await fixture(); const trusted = executor(workspace);
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  await makeEligible(store, workspace, fresh.job, 'zcode-session-a'); await store.finishJob(workspace, fresh.job.id, ['running'], 'succeeded');
  const before = (await store.listJobs(workspace)).map((job) => job.id);
  for (const patch of [{ parentTurnId: 'forged-turn' }, { parentPermissionMode: 'read-only' }]) {
    const forged = executor(workspace, patch);
    await assert.rejects(store.resolveRescueBindingForResume(bindingExpected(workspace, forged, { permissionMode: 'workspace-write' })), { code: 'RESCUE_BINDING_INVALID' });
    await assert.rejects(store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'later'), executor: forged, operationId: fresh.binding.operationId }), { code: 'RESCUE_BINDING_INVALID' });
  }
  assert.deepEqual((await store.listJobs(workspace)).map((job) => job.id), before);
});

test('binding capacity is isolated per parent session and active slots are never age-GCed', async () => {
  const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  await makeEligible(store, workspace, first.job, 'zcode-session-a'); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const [path] = await bindingFiles(storage.directory); const partition = JSON.parse(await readFile(path, 'utf8'));
  for (let index = 1; index < 1024; index += 1) {
    const item = createRescueBinding({ ...identity, workspace: storage.workspacePath, executorAgentId: `child-${index}`, anchorJobId: 'a'.repeat(64), currentJobId: 'a'.repeat(64), operationId: index.toString(16).padStart(64, '0'), now: '2020-01-01T00:00:00.000Z' });
    partition.records.push(item);
  }
  await writeFile(path, `${JSON.stringify(createRescueBindingPartition({ parentSessionId: identity.parentSessionId, workspace: storage.workspacePath, records: partition.records }), null, 2)}\n`);
  await assert.rejects(store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace, 'turn-b'), executor: executor(workspace, { agentId: 'overflow-child' }) }), { code: 'RESCUE_BINDING_CAPACITY' });
  const overflow = createRescueBinding({ ...identity, workspace: storage.workspacePath, executorAgentId: 'physical-overflow-child', anchorJobId: 'a'.repeat(64), currentJobId: 'a'.repeat(64), operationId: 'f'.repeat(64), now: '2020-01-01T00:00:00.000Z' });
  partition.records.push(overflow); await writeFile(path, `${JSON.stringify({ ...partition, records: partition.records })}\n`);
  await assert.rejects(store.resolveRescueBinding(bindingExpected(workspace, trusted)), { code: 'RESCUE_BINDING_INVALID' });
  const siblingExecutor = executor(workspace, { parentSessionId: 'sibling-session', agentId: 'sibling-child' });
  const siblingReservation = { ...reservation(workspace, 'sibling-turn'), ownerSessionId: 'sibling-session' };
  assert.equal((await store.reserveFreshRescueJob({ workspace, reservation: siblingReservation, executor: siblingExecutor })).binding.parentSessionId, 'sibling-session');
});

test('new-slot creation GCs only valid closed tombstones older than thirty days', async () => {
  const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  await makeEligible(store, workspace, first.job, 'zcode-session-a'); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  await store.closeRescueBindingsForSession({ workspace, parentSessionId: trusted.parentSessionId, reason: 'session-ended' });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const [closedPath] = await bindingFiles(storage.directory);
  const old = createRescueBinding({ ...identity, workspace: storage.workspacePath, anchorJobId: first.job.id, currentJobId: first.job.id, operationId: first.binding.operationId, now: '2020-01-01T00:00:00.000Z' });
  const records = [closeRescueBinding(old, { operationId: old.operationId, reason: 'session-ended', now: '2020-01-02T00:00:00.000Z' })];
  for (let index = 1; index < 1024; index += 1) {
    const item = createRescueBinding({ ...identity, workspace: storage.workspacePath, executorAgentId: `child-${index}`, anchorJobId: 'a'.repeat(64), currentJobId: 'a'.repeat(64), operationId: index.toString(16).padStart(64, '0'), now: '2020-01-01T00:00:00.000Z' });
    records.push(item);
  }
  await writeFile(closedPath, `${JSON.stringify(createRescueBindingPartition({ parentSessionId: identity.parentSessionId, workspace: storage.workspacePath, records }), null, 2)}\n`);
  const replacement = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace, 'turn-b'), executor: executor(workspace, { agentId: 'replacement-child' }) });
  assert.equal(replacement.binding.executorAgentId, 'replacement-child');
  assert.equal(JSON.parse(await readFile(closedPath, 'utf8')).records.some((record) => record.key === old.key), false);
});
