// @ts-nocheck
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import {
  closeRescueBinding,
  createRescueBindingAuthority,
  createRescueBindingPartition,
  createRescueBinding,
  EXECUTION_OWNERS,
  HOST_PLACEMENTS,
  parseRescueBinding,
  parseRescueBindingAuthority,
  parseRescueBindingPartition,
  rescueBindingAuthorityView,
  RESCUE_BINDING_AUTHORITY_MAX_BYTES,
  RESCUE_BINDING_PARTITION_MAX_BYTES,
  rescueBindingKey,
  rescueBindingPartitionKey,
  STOP_CAUSES,
  validLifecycleEpoch,
  validStopIntent,
} from '../scripts/lib/rescue-binding.mjs';
import { hostLifecycleEpoch } from '../scripts/lib/host-lifecycle.mjs';
import { createJobController } from '../scripts/lib/job-control.mjs';
import { scavengeWritableJobs, settleEndedOwnerWritableJob } from '../scripts/lib/recovery.mjs';
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
  executorAgentPath: '/root/zcode_rescue_task',
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
    'childAuthority', 'key', 'operationId', 'parentSessionId', 'permissionMode',
    'state', 'superseded', 'updatedAt', 'version', 'workspace',
  ].sort());
  assert.equal(created.key, rescueBindingKey(identity));
  assert.equal(created.version, 3);
  assert.deepEqual(created.childAuthority, {
    kind: 'subagent-start', childAgentId: 'rescue-child', childAgentType: 'zcode-rescue',
    parentTurnId: 'origin-turn', parentPermissionMode: 'workspace-write', agentPath: '/root/zcode_rescue_task',
  });
  assert.equal(created.state, 'active');
  assert.equal(created.closedAt, null);
  assert.equal(created.closeReason, null);
  const parsed = parseRescueBinding(`${JSON.stringify(created)}\n`, identity);
  parsed.state = 'closed';
  assert.equal(created.state, 'active');
});

test('v3 Hook authority preserves an exact real canonical absolute agent path', () => {
  const executorAgentPath = '/Users/codex/.codex/agents/zcode-rescue.toml';
  const created = createRescueBinding({
    ...identity,
    executorAgentPath,
    anchorJobId: 'a'.repeat(64),
    currentJobId: 'b'.repeat(64),
    operationId: 'c'.repeat(64),
  });
  assert.equal(created.childAuthority.agentPath, executorAgentPath);
  assert.equal(parseRescueBinding(`${JSON.stringify(created)}\n`, { ...identity, executorAgentPath }).childAuthority.agentPath, executorAgentPath);
  for (const invalid of ['relative/agent.toml', '/Users/codex/../other/agent.toml', '/Users/codex/agent\u0000.toml']) {
    assert.throws(() => createRescueBinding({ ...identity, executorAgentPath: invalid,
      anchorJobId: 'a'.repeat(64), currentJobId: 'b'.repeat(64), operationId: 'c'.repeat(64) }),
    { code: 'RESCUE_BINDING_INVALID' });
  }
});

test('version one binding remains readable through the version-neutral child authority view', () => {
  const legacy = {
    version: 1, key: rescueBindingKey(identity), operationId: 'c'.repeat(64), state: 'active',
    parentSessionId: identity.parentSessionId, executorAgentId: identity.executorAgentId,
    executorAgentType: identity.executorAgentType, executorParentTurnId: identity.executorParentTurnId,
    executorParentPermissionMode: identity.executorParentPermissionMode, workspace: identity.workspace,
    permissionMode: identity.permissionMode, anchorJobId: 'a'.repeat(64), currentJobId: 'b'.repeat(64),
    createdAt: '2026-08-18T01:02:03.000Z', updatedAt: '2026-08-18T01:02:03.000Z', closedAt: null, closeReason: null,
  };
  const parsed = parseRescueBinding(`${JSON.stringify(legacy)}\n`, identity);
  assert.deepEqual(parsed, legacy);
  assert.deepEqual(rescueBindingAuthorityView(parsed), {
    kind: 'subagent-start', childAgentId: 'rescue-child', childAgentType: 'zcode-rescue',
    parentTurnId: 'origin-turn', parentPermissionMode: 'workspace-write',
  });
  const closed = closeRescueBinding(legacy, { operationId: legacy.operationId, reason: 'session-ended', now: '2026-08-18T02:02:03.000Z' });
  assert.equal(closed.version, 1);
  assert.deepEqual(rescueBindingAuthorityView(closed), rescueBindingAuthorityView(legacy));
});

test('binding codec persists and validates exact legacy adoption authority', () => {
  const authority = {
    kind: 'codex-legacy-adoption', authorityId: 'd'.repeat(64), childAgentId: 'rescue-child',
    childAgentType: 'zcode-rescue', authorizingParentTurnId: 'turn-current',
    authorizingParentGenerationId: 'e'.repeat(64), authorizingPermissionMode: 'workspace-write',
    originWorkspace: codecWorkspace, executionWorkspace: codecWorkspace, agentPathDigest: 'f'.repeat(64),
  };
  const created = createRescueBinding({ parentSessionId: identity.parentSessionId, childAuthority: authority,
    workspace: codecWorkspace, permissionMode: 'workspace-write', anchorJobId: 'a'.repeat(64),
    currentJobId: 'b'.repeat(64), operationId: 'c'.repeat(64) });
  assert.deepEqual(rescueBindingAuthorityView(created), authority);
  for (const mutation of [
    { ...authority, childAgentType: 'default' }, { ...authority, authorityId: 'bad' },
    { ...authority, executionWorkspace: foreignCodecWorkspace }, { ...authority, unknown: true },
  ]) assert.throws(() => createRescueBinding({ parentSessionId: identity.parentSessionId, childAuthority: mutation,
    workspace: codecWorkspace, permissionMode: 'workspace-write', anchorJobId: 'a'.repeat(64),
    currentJobId: 'b'.repeat(64), operationId: 'c'.repeat(64) }), { code: 'RESCUE_BINDING_INVALID' });
});

test('binding codec closes only the expected generation with an exact tombstone', () => {
  const active = createRescueBinding({ ...identity, anchorJobId: 'a'.repeat(64), currentJobId: 'a'.repeat(64), operationId: 'c'.repeat(64), now: '2026-08-18T01:02:03.000Z' });
  const closed = closeRescueBinding(active, { operationId: active.operationId, reason: 'session-ended', now: '2026-08-18T02:02:03.000Z' });
  assert.equal(closed.state, 'closed');
  assert.equal(closed.closedAt, '2026-08-18T02:02:03.000Z');
  assert.equal(closed.closeReason, 'session-ended');
  assert.equal(closed.operationId, active.operationId);
  assert.throws(() => closeRescueBinding(active, { operationId: active.operationId, reason: 'fresh' }),
    { code: 'RESCUE_BINDING_INVALID' });
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

test('mixed v1/v3 partitions retain stable ordering, keys, and authority variants', () => {
  const legacyIdentity = { ...identity, executorAgentId: 'legacy-v1' };
  const legacy = { version: 1, key: rescueBindingKey(legacyIdentity), operationId: '1'.repeat(64), state: 'active',
    parentSessionId: identity.parentSessionId, executorAgentId: 'legacy-v1', executorAgentType: 'default',
    executorParentTurnId: 'old-turn', executorParentPermissionMode: 'read-only', workspace: identity.workspace,
    permissionMode: 'read-only', anchorJobId: '2'.repeat(64), currentJobId: '2'.repeat(64),
    createdAt: '2026-08-18T01:02:03.000Z', updatedAt: '2026-08-18T01:02:03.000Z', closedAt: null, closeReason: null };
  const current = createRescueBinding({ ...identity, anchorJobId: '3'.repeat(64), currentJobId: '3'.repeat(64), operationId: '4'.repeat(64) });
  const partition = createRescueBindingPartition({ parentSessionId: identity.parentSessionId, workspace: identity.workspace,
    records: [current, legacy] });
  const parsed = parseRescueBindingPartition(`${JSON.stringify(partition)}\n`, identity);
  assert.deepEqual(parsed.records.map((record) => record.key), [...parsed.records.map((record) => record.key)].sort());
  assert.deepEqual(parsed.records.map((record) => record.version).sort(), [1, 3]);
  assert.deepEqual(parsed.records.map(rescueBindingAuthorityView).map((authority) => authority.kind), ['subagent-start', 'subagent-start']);
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
  return { root, dataRoot, workspace: await realpath(workspace), store: createStateStore({ dataRoot, ...options }) };
}

function executor(workspace, patch = {}) {
  return { parentSessionId: 'parent-session', parentTurnId: 'origin-turn', agentId: 'rescue-child', agentType: 'zcode-rescue', agentPath: '/root/zcode_rescue_task', workspace, parentPermissionMode: 'workspace-write', ...patch };
}

function bindingExpected(workspace, value, patch = {}) {
  return { workspace, parentSessionId: value.parentSessionId, executorAgentId: value.agentId, executorAgentType: value.agentType,
    executorParentTurnId: value.parentTurnId, executorParentPermissionMode: value.parentPermissionMode,
    executorAgentPath: value.agentPath, permissionMode: value.parentPermissionMode, ...patch };
}

function reservation(workspace, turn = 'turn-a') {
  return { workspace, ownerSessionId: 'parent-session', ownerTurnId: turn, command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'workspace-write' } };
}


async function makeEligible(store, workspace, job, sessionId) {
  const claimed = await store.claimJobWorkerForExecution(workspace, job.id, {
    childPid: 999_999_999, workerLeaseId: job.id,
  });
  return store.transitionJob(workspace, job.id, ['queued'], 'running', {
    startedAt: new Date().toISOString(), zcodeSessionId: sessionId,
    childPid: claimed.childPid, workerLeaseId: claimed.workerLeaseId,
  });
}

async function activeContinuationFailureFixture(options = {}) {
  const base = await fixture(options); const hook = executor(base.workspace);
  const first = await base.store.reserveFreshRescueJob({ workspace: base.workspace,
    reservation: reservation(base.workspace), executor: hook });
  await makeEligible(base.store, base.workspace, first.job, 'active-rollback-session');
  await base.store.finishJob(base.workspace, first.job.id, ['running'], 'succeeded');
  const continuation = await base.store.reserveBoundRescueContinuation({ workspace: base.workspace,
    reservation: reservation(base.workspace, 'turn-b'), executor: hook, operationId: first.binding.operationId });
  return { ...base, hook, first, continuation, proof: continuation.job.rescueContinuationOrigin };
}

async function bindingFiles(directory) {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^rescue-binding-session-[a-f0-9]{64}\.json$/u.test(entry.name))
    .map((entry) => join(directory, entry.name));
}

async function downgradeOnlyBindingToV2(dataRoot, workspace) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const [path] = await bindingFiles(storage.directory);
  const partition = JSON.parse(await readFile(path, 'utf8')); assert.equal(partition.records.length, 1);
  const record = partition.records[0]; record.version = 2; delete record.superseded;
  if (record.childAuthority?.kind === 'subagent-start') delete record.childAuthority.agentPath;
  await writeFile(path, `${JSON.stringify(partition, null, 2)}\n`);
}

async function downgradeReservationToOwnerV1(dataRoot, workspace, job, bindingVersion) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const jobRecordPath = join(storage.directory, 'jobs', `${job.id}.json`);
  const historical = JSON.parse(await readFile(jobRecordPath, 'utf8'));
  delete historical.rescueReservationKind;
  await writeFile(jobRecordPath, `${JSON.stringify(historical, null, 2)}\n`);
  const ownerRoot = join(storage.directory, 'job-owners'); let ownerBindingPath;
  for (const entry of await readdir(ownerRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) continue;
    const candidate = join(ownerRoot, entry.name, `${job.id}.json`);
    try { await readFile(candidate); ownerBindingPath = candidate; break; }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  assert.ok(ownerBindingPath);
  await writeFile(ownerBindingPath, `${JSON.stringify({ jobId: job.id,
    ownerSessionId: job.ownerSessionId, version: 1 }, null, 2)}\n`);
  if (bindingVersion === undefined) return;
  const [bindingPath] = await bindingFiles(storage.directory);
  const partition = JSON.parse(await readFile(bindingPath, 'utf8')); const current = partition.records[0];
  if (bindingVersion === 2) {
    const v2 = { ...current, version: 2, childAuthority: { ...current.childAuthority } };
    delete v2.superseded; delete v2.childAuthority.agentPath; partition.records = [v2];
  } else {
    const authority = current.childAuthority;
    partition.records = [{ version: 1, key: current.key, operationId: current.operationId, state: current.state,
      parentSessionId: current.parentSessionId, executorAgentId: authority.childAgentId,
      executorAgentType: authority.childAgentType, executorParentTurnId: authority.parentTurnId,
      executorParentPermissionMode: authority.parentPermissionMode, workspace: current.workspace,
      permissionMode: current.permissionMode, anchorJobId: current.anchorJobId, currentJobId: current.currentJobId,
      createdAt: current.createdAt, updatedAt: current.updatedAt, closedAt: current.closedAt, closeReason: current.closeReason }];
  }
  await writeFile(bindingPath, `${JSON.stringify(createRescueBindingPartition({
    parentSessionId: job.ownerSessionId, workspace, records: partition.records,
  }), null, 2)}\n`);
}

async function classlessOwnerV1V3QueuedForTest(kind) {
  const context = await fixture(); const { dataRoot, workspace, store } = context;
  const hook = executor(workspace); let queued;
  if (kind === 'continuation') {
    const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
    await makeEligible(store, workspace, first.job, 'classless-v3-continuation-session');
    await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
    queued = (await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
      executor: hook, operationId: first.binding.operationId })).job;
  }
  await downgradeReservationToOwnerV1(dataRoot, workspace, queued);
  return { ...context, queued };
}

async function historicalLegacyAdoptionSettlementFixture() {
  const context = await fixture(); const { dataRoot, workspace, store } = context; const hook = executor(workspace, { parentTurnId: 'adopt' });
  const candidate = await store.reserveJob(reservation(workspace, 'candidate'));
  await makeEligible(store, workspace, candidate, 'historical-adoption-session');
  await store.finishJob(workspace, candidate.id, ['running'], 'succeeded');
  const adoption = await store.reserveJob(reservation(workspace, 'adopt'));
  const base = createRescueBinding({ ...bindingExpected(workspace, hook), anchorJobId: candidate.id,
    currentJobId: candidate.id, operationId: 'a'.repeat(64), now: candidate.createdAt });
  const successor = parseRescueBinding(`${JSON.stringify({ ...base, currentJobId: adoption.id,
    updatedAt: adoption.createdAt })}\n`);
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const jobPath = join(storage.directory, 'jobs', `${adoption.id}.json`);
  const persisted = JSON.parse(await readFile(jobPath, 'utf8'));
  persisted.rescueReservationKind = 'bound';
  persisted.rescueContinuationOrigin = { kind: 'legacy-adoption', binding: successor, priorBinding: base };
  await writeFile(jobPath, `${JSON.stringify(persisted, null, 2)}\n`);
  const ownerRoot = join(storage.directory, 'job-owners'); let ownerBindingPath;
  for (const entry of await readdir(ownerRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) continue;
    const candidatePath = join(ownerRoot, entry.name, `${adoption.id}.json`);
    try { await readFile(candidatePath); ownerBindingPath = candidatePath; break; }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  assert.ok(ownerBindingPath);
  const ownerBinding = JSON.parse(await readFile(ownerBindingPath, 'utf8'));
  ownerBinding.rescueReservationKind = 'bound'; await writeFile(ownerBindingPath, `${JSON.stringify(ownerBinding, null, 2)}\n`);
  const bindingPath = join(storage.directory, `rescue-binding-session-${rescueBindingPartitionKey({
    parentSessionId: adoption.ownerSessionId, workspace,
  })}.json`);
  const authorityPath = join(storage.directory, `rescue-binding-authority-${rescueBindingPartitionKey({
    parentSessionId: adoption.ownerSessionId, workspace,
  })}.json`);
  await writeFile(authorityPath, `${JSON.stringify(createRescueBindingAuthority({
    parentSessionId: adoption.ownerSessionId, workspace, createdAt: base.createdAt,
  }), null, 2)}\n`);
  await writeFile(bindingPath, `${JSON.stringify(createRescueBindingPartition({
    parentSessionId: adoption.ownerSessionId, workspace, records: [base],
  }), null, 2)}\n`);
  return { ...context, hook, candidate, adoption: persisted, bindingPath, baseBytes: await readFile(bindingPath) };
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
  assert.equal(rescueBindingAuthorityView(record.binding).childAgentType, 'zcode-rescue');
  const resolved = await store.resolveRescueBindingForResume(bindingExpected(workspace, trusted));
  assert.equal(resolved.kind, 'bound');
  assert.equal(resolved.operationId, reserved.binding.operationId);
  assert.equal(resolved.anchorJob.zcodeSessionId, 'zcode-session-a');
  assert.equal(resolved.currentJob.id, reserved.job.id);
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const [partitionPath] = await bindingFiles(storage.directory); const metadata = await stat(partitionPath); assert.equal(metadata.isFile(), true); if (process.platform !== 'win32') assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal((await bindingFiles(storage.directory)).length, 1);
});


test('StateStore reads and legally continues an active v1 Hook binding', async () => {
  const { dataRoot, workspace, store } = await fixture(); const hook = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  await makeEligible(store, workspace, first.job, 'hook-session'); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const [path] = await bindingFiles(storage.directory);
  const partition = JSON.parse(await readFile(path, 'utf8')); const current = partition.records[0];
  partition.records[0] = { version: 1, key: current.key, operationId: current.operationId, state: current.state,
    parentSessionId: current.parentSessionId, executorAgentId: hook.agentId, executorAgentType: hook.agentType,
    executorParentTurnId: hook.parentTurnId, executorParentPermissionMode: hook.parentPermissionMode,
    workspace: current.workspace, permissionMode: current.permissionMode, anchorJobId: current.anchorJobId,
    currentJobId: current.currentJobId, createdAt: current.createdAt, updatedAt: current.updatedAt,
    closedAt: current.closedAt, closeReason: current.closeReason };
  await writeFile(path, `${JSON.stringify(partition, null, 2)}\n`);
  assert.equal((await store.resolveRescueBinding(bindingExpected(workspace, hook))).binding.version, 1);
  const continued = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
    executor: hook, operationId: first.binding.operationId });
  assert.equal(continued.binding.version, 1);
  assert.equal(rescueBindingAuthorityView(continued.binding).kind, 'subagent-start');
  await store.finishJob(workspace, continued.job.id, ['queued'], 'failed');
});

test('StateStore lazily migrates an exact session-ended v1 Hook binding using persisted child path proof', async () => {
  const { dataRoot, workspace, store } = await fixture(); const hook = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  await makeEligible(store, workspace, first.job, 'historical-hook-session');
  await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const [path] = await bindingFiles(storage.directory);
  const partition = JSON.parse(await readFile(path, 'utf8')); const current = partition.records[0];
  partition.records[0] = { version: 1, key: current.key, operationId: current.operationId, state: current.state,
    parentSessionId: current.parentSessionId, executorAgentId: hook.agentId, executorAgentType: hook.agentType,
    executorParentTurnId: hook.parentTurnId, executorParentPermissionMode: hook.parentPermissionMode,
    workspace: current.workspace, permissionMode: current.permissionMode, anchorJobId: current.anchorJobId,
    currentJobId: current.currentJobId, createdAt: current.createdAt, updatedAt: current.updatedAt,
    closedAt: current.closedAt, closeReason: current.closeReason };
  await writeFile(path, `${JSON.stringify(partition, null, 2)}\n`);
  const closed = await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, operationId: first.binding.operationId, reason: 'session-ended' });
  assert.equal(closed.binding.version, 1);
  const lookup = { workspace, parentSessionId: hook.parentSessionId, executorAgentId: hook.agentId,
    childAgentType: hook.agentType, originWorkspace: workspace, executionWorkspace: workspace, agentPath: hook.agentPath };
  const proof = await store.readRescueBindingMigrationProof(lookup);
  assert.equal(proof.kind, 'proof'); assert.equal(proof.migrationProof.agentPath, hook.agentPath);
  const attempts = await Promise.allSettled(['turn-b', 'turn-c'].map((turnId) => store.reserveBoundRescueContinuation({
    workspace, reservation: reservation(workspace, turnId), executor: hook,
    operationId: first.binding.operationId, migrationProof: proof.migrationProof,
    expectedCurrentJobId: first.job.id, expectedAnchorJobId: first.job.id,
  })));
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === 'rejected' && attempt.reason?.code === 'RESCUE_BINDING_STALE').length, 1);
  const resumed = attempts.find((attempt) => attempt.status === 'fulfilled').value;
  assert.equal(resumed.binding.version, 3); assert.equal(resumed.binding.state, 'active');
  assert.equal(resumed.binding.childAuthority.agentPath, hook.agentPath);
  assert.equal(resumed.anchorJob.zcodeSessionId, 'historical-hook-session');
  await assert.rejects(store.resolveRescueBindingForResume(bindingExpected(workspace,
    { ...hook, agentPath: '/root/different_rescue_child' }, { permissionMode: 'workspace-write' })),
  { code: 'RESCUE_BINDING_INVALID' });
  await store.finishSessionEndedRescueContinuation(workspace, resumed.job.id, resumed.migrationRollback, 'failed',
    { error: { message: 'migration rejected' }, exitCode: 1 });
  const rolledBack = JSON.parse(await readFile(path, 'utf8')).records[0];
  assert.equal(rolledBack.version, 1); assert.equal(rolledBack.state, 'closed');
  assert.deepEqual(rolledBack, closed.binding);
  const legacyAuthority = rescueBindingAuthorityView(rolledBack);
  const v2 = { version: 2, key: rolledBack.key, operationId: rolledBack.operationId, state: rolledBack.state,
    parentSessionId: rolledBack.parentSessionId, childAuthority: { kind: legacyAuthority.kind,
      childAgentId: legacyAuthority.childAgentId, childAgentType: legacyAuthority.childAgentType,
      parentTurnId: legacyAuthority.parentTurnId, parentPermissionMode: legacyAuthority.parentPermissionMode },
    workspace: rolledBack.workspace, permissionMode: rolledBack.permissionMode, anchorJobId: rolledBack.anchorJobId,
    currentJobId: rolledBack.currentJobId, createdAt: rolledBack.createdAt, updatedAt: rolledBack.updatedAt,
    closedAt: rolledBack.closedAt, closeReason: rolledBack.closeReason };
  await writeFile(path, `${JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), records: [v2] }, null, 2)}\n`);
  const v2Proof = await store.readRescueBindingMigrationProof(lookup); assert.equal(v2Proof.kind, 'proof');
  const v2Resumed = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-d'),
    executor: hook, operationId: first.binding.operationId, migrationProof: v2Proof.migrationProof,
    expectedCurrentJobId: first.job.id, expectedAnchorJobId: first.job.id });
  assert.equal(v2Resumed.binding.version, 3); assert.equal(v2Resumed.binding.childAuthority.agentPath, hook.agentPath);
});

for (const version of [1, 2]) for (const terminalizer of ['controller cancel', 'recovery failure']) test(`${terminalizer} restores the exact v${version} session-ended tombstone from its queued marker`, async () => {
  const { dataRoot, workspace, store } = await fixture(); const hook = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  await makeEligible(store, workspace, first.job, `v${version}-session`); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const [path] = await bindingFiles(storage.directory);
  const partition = JSON.parse(await readFile(path, 'utf8')); const current = partition.records[0]; const authority = rescueBindingAuthorityView(current);
  if (version === 1) partition.records[0] = { version: 1, key: current.key, operationId: current.operationId, state: current.state,
    parentSessionId: current.parentSessionId, executorAgentId: authority.childAgentId, executorAgentType: authority.childAgentType,
    executorParentTurnId: authority.parentTurnId, executorParentPermissionMode: authority.parentPermissionMode,
    workspace: current.workspace, permissionMode: current.permissionMode, anchorJobId: current.anchorJobId,
    currentJobId: current.currentJobId, createdAt: current.createdAt, updatedAt: current.updatedAt,
    closedAt: current.closedAt, closeReason: current.closeReason };
  else if (version === 2) partition.records[0] = { version: 2, key: current.key, operationId: current.operationId, state: current.state,
    parentSessionId: current.parentSessionId, childAuthority: { kind: authority.kind, childAgentId: authority.childAgentId,
      childAgentType: authority.childAgentType, parentTurnId: authority.parentTurnId, parentPermissionMode: authority.parentPermissionMode },
    workspace: current.workspace, permissionMode: current.permissionMode, anchorJobId: current.anchorJobId,
    currentJobId: current.currentJobId, createdAt: current.createdAt, updatedAt: current.updatedAt,
    closedAt: current.closedAt, closeReason: current.closeReason };
  await writeFile(path, `${JSON.stringify(partition, null, 2)}\n`);
  const closed = await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, operationId: current.operationId, reason: 'session-ended' });
  assert.equal(closed.binding.version, version);
  const proof = await store.readRescueBindingMigrationProof({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, childAgentType: hook.agentType, originWorkspace: workspace,
    executionWorkspace: workspace, agentPath: hook.agentPath });
  assert.equal(proof.kind, 'proof');
  const continuation = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
    executor: hook, operationId: current.operationId, migrationProof: proof.migrationProof });
  assert.equal(continuation.job.rescueMigrationRollback.priorVersion, version);
  assert.deepEqual(continuation.job.rescueMigrationRollback.priorBinding, closed.binding);
  if (terminalizer === 'controller cancel') await createJobController({ store, dataRoot }).cancel(workspace, continuation.job.id, hook.parentSessionId);
  else {
    await store.claimJobWorker(workspace, continuation.job.id, { childPid: 999_999_999, workerLeaseId: '9'.repeat(64) });
    await scavengeWritableJobs({ store, dataRoot, workspace, createClient: async () => { throw new Error('queued worker must fail before client creation'); } });
  }
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).records[0], closed.binding);
  const terminal = await store.readJob(workspace, continuation.job.id);
  assert.equal(terminal.rescueMigrationRollback, undefined); assert.ok(['cancelled', 'failed'].includes(terminal.status));
});

test('StateStore rejects a closed v3 session-ended record as migration evidence without mutation', async () => {
  const { dataRoot, workspace, store } = await fixture(); const hook = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  await makeEligible(store, workspace, first.job, 'closed-v3-session');
  await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  const closed = await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, operationId: first.binding.operationId, reason: 'session-ended' });
  assert.equal(closed.binding.version, 3);
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const [bindingPath] = await bindingFiles(storage.directory);
  const beforeBinding = await readFile(bindingPath); const beforeJobs = await store.listJobs(workspace);
  await assert.rejects(store.readRescueBindingMigrationProof({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, childAgentType: hook.agentType, originWorkspace: workspace,
    executionWorkspace: workspace, agentPath: hook.agentPath }), { code: 'RESCUE_BINDING_INVALID' });
  assert.deepEqual(await readFile(bindingPath), beforeBinding);
  assert.deepEqual(await store.listJobs(workspace), beforeJobs);
});

test('legacy migration requires anchor and current jobs to preserve one exact completed session', async (t) => {
  for (const [name, mutate] of [
    ['current session mismatch', (job) => ({ ...job, zcodeSessionId: 'different-session' })],
    ['current owner mismatch', (job) => ({ ...job, ownerSessionId: 'other-parent' })],
    ['current command mismatch', (job) => ({ ...job, command: 'review', readOnly: true })],
  ]) await t.test(name, async () => {
    const { dataRoot, workspace, store } = await fixture(); const hook = executor(workspace);
    const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
    await makeEligible(store, workspace, first.job, 'original-session');
    await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
    const second = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
      executor: hook, operationId: first.binding.operationId });
    await makeEligible(store, workspace, second.job, 'original-session');
    await store.finishJob(workspace, second.job.id, ['running'], 'succeeded');
    const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const [bindingPath] = await bindingFiles(storage.directory);
    const partition = JSON.parse(await readFile(bindingPath, 'utf8')); const active = partition.records[0];
    partition.records[0] = { version: 1, key: active.key, operationId: active.operationId, state: active.state,
      parentSessionId: active.parentSessionId, executorAgentId: hook.agentId, executorAgentType: hook.agentType,
      executorParentTurnId: hook.parentTurnId, executorParentPermissionMode: hook.parentPermissionMode,
      workspace: active.workspace, permissionMode: active.permissionMode, anchorJobId: active.anchorJobId,
      currentJobId: active.currentJobId, createdAt: active.createdAt, updatedAt: active.updatedAt,
      closedAt: active.closedAt, closeReason: active.closeReason };
    await writeFile(bindingPath, `${JSON.stringify(partition, null, 2)}\n`);
    const closed = await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId,
      executorAgentId: hook.agentId, operationId: active.operationId, reason: 'session-ended' });
    const currentPath = join(storage.directory, 'jobs', `${second.job.id}.json`);
    const current = JSON.parse(await readFile(currentPath, 'utf8'));
    await writeFile(currentPath, `${JSON.stringify(mutate(current), null, 2)}\n`);
    const beforeBinding = await readFile(bindingPath); const beforeJobs = await readdir(join(storage.directory, 'jobs'));
    await assert.rejects(store.resolveRescueBindingForResume({ workspace, parentSessionId: hook.parentSessionId,
      executorAgentId: hook.agentId, executorAgentPath: hook.agentPath, permissionMode: hook.parentPermissionMode,
      migrationProof: { parentSessionId: hook.parentSessionId, childAgentId: hook.agentId, childAgentType: hook.agentType,
        operationId: closed.binding.operationId, originWorkspace: workspace, executionWorkspace: workspace,
        agentPath: hook.agentPath, bindingDigest: createHash('sha256').update(JSON.stringify(closed.binding)).digest('hex') } }),
    { code: 'RESCUE_BINDING_INVALID' });
    assert.deepEqual(await readFile(bindingPath), beforeBinding);
    assert.deepEqual(await readdir(join(storage.directory, 'jobs')), beforeJobs);
  });
});

test('a migrated continuation removes its queued rollback marker when running commits', async () => {
  const { dataRoot, workspace, store } = await fixture(); const hook = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  await makeEligible(store, workspace, first.job, 'running-marker-session'); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  await downgradeOnlyBindingToV2(dataRoot, workspace);
  const closed = await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, operationId: first.binding.operationId, reason: 'session-ended' });
  const proof = await store.readRescueBindingMigrationProof({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, childAgentType: hook.agentType, originWorkspace: workspace,
    executionWorkspace: workspace, agentPath: hook.agentPath });
  assert.equal(proof.kind, 'proof');
  const continuation = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
    executor: hook, operationId: closed.binding.operationId, migrationProof: proof.migrationProof });
  assert.ok(continuation.job.rescueMigrationRollback);
  const claimed = await store.claimJobWorkerForExecution(workspace, continuation.job.id, {
    childPid: 999_999_999, workerLeaseId: '8'.repeat(64),
  });
  const running = await store.transitionJob(workspace, continuation.job.id, ['queued'], 'running', {
    startedAt: new Date().toISOString(), zcodeSessionId: 'running-marker-session',
    childPid: claimed.childPid, workerLeaseId: claimed.workerLeaseId,
  });
  assert.equal(running.rescueMigrationRollback, undefined);
  assert.equal((await store.readJob(workspace, continuation.job.id)).rescueMigrationRollback, undefined);
});

for (const seam of ['continuation:marker', 'continuation:current-advance']) test(`controller cancellation settles a continuation published through ${seam} without changing its prior binding`, async () => {
  const { dataRoot, workspace, store } = await fixture(); const hook = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  await makeEligible(store, workspace, first.job, 'pre-advance-session'); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const [bindingPath] = await bindingFiles(storage.directory);
  const priorBytes = await readFile(bindingPath);
  const faulted = createStateStore({ dataRoot, testOnlyPublicationHook: throwingAt(seam) });
  await assert.rejects(faulted.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
    executor: hook, operationId: first.binding.operationId }), { code: 'RESCUE_PUBLICATION_TEST_FAULT' });
  const continuation = (await store.listJobs(workspace)).find((job) => job.id !== first.job.id);
  assert.ok(continuation?.rescueContinuationOrigin); assert.deepEqual(await readFile(bindingPath), priorBytes);
  const cancelled = await createJobController({ store, dataRoot }).cancel(workspace, continuation.id, hook.parentSessionId);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.rescueContinuationOrigin, undefined);
  assert.deepEqual(await readFile(bindingPath), priorBytes);
});

for (const terminalizer of ['direct', 'controller', 'recovery', 'SessionEnd']) test(`historical persisted legacy adoption settles through ${terminalizer} without changing its base binding`, async () => {
  const { dataRoot, workspace, store, hook, candidate, adoption, bindingPath, baseBytes } = await historicalLegacyAdoptionSettlementFixture();
  let terminal;
  if (terminalizer === 'direct') terminal = await store.finishJob(workspace, adoption.id, ['queued'], 'failed', {
    error: { message: 'direct settlement' }, exitCode: 1,
  });
  else if (terminalizer === 'controller') terminal = await createJobController({ store, dataRoot }).cancel(workspace, adoption.id, adoption.ownerSessionId);
  else if (terminalizer === 'recovery') {
    await store.claimJobWorker(workspace, adoption.id, { childPid: 999_999_999, workerLeaseId: '6'.repeat(64) });
    await scavengeWritableJobs({ store, dataRoot, workspace, createClient: async () => { throw new Error('queued worker must not create a client'); } });
    terminal = await store.readJob(workspace, adoption.id);
  } else terminal = await settleEndedOwnerWritableJob({ store, dataRoot, workspace, ownerSessionId: adoption.ownerSessionId,
    createClient: async () => { throw new Error('queued SessionEnd must not create a client'); } });
  assert.equal(terminal.status, ['controller', 'SessionEnd'].includes(terminalizer) ? 'cancelled' : 'failed');
  assert.equal(terminal.rescueContinuationOrigin, undefined); assert.deepEqual(await readFile(bindingPath), baseBytes);
  assert.equal((await store.resolveRescueBinding(bindingExpected(workspace, hook))).binding.currentJobId, candidate.id);
});

for (const transition of ['execution preflight', 'running', 'failed', 'controller', 'recovery']) test(`missing bound reservation proof and binding fail closed during ${transition}`, async () => {
  const { dataRoot, workspace, store } = await fixture(); const hook = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  await makeEligible(store, workspace, first.job, 'missing-all-proof-session'); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  await downgradeOnlyBindingToV2(dataRoot, workspace);
  await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId, executorAgentId: hook.agentId,
    operationId: first.binding.operationId, reason: 'session-ended' });
  const proof = await store.readRescueBindingMigrationProof({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, childAgentType: hook.agentType, originWorkspace: workspace,
    executionWorkspace: workspace, agentPath: hook.agentPath });
  const continuation = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
    executor: hook, operationId: first.binding.operationId, migrationProof: proof.migrationProof });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const jobPath = join(storage.directory, 'jobs', `${continuation.job.id}.json`);
  const stripped = JSON.parse(await readFile(jobPath, 'utf8')); delete stripped.rescueMigrationRollback;
  await writeFile(jobPath, `${JSON.stringify(stripped, null, 2)}\n`);
  for (const name of await readdir(storage.directory)) if (/^rescue-binding-(?:authority|session)-[a-f0-9]{64}\.json$/u.test(name)) await unlink(join(storage.directory, name));
  if (transition === 'recovery') await store.claimJobWorker(workspace, continuation.job.id, { childPid: 999_999_999, workerLeaseId: '5'.repeat(64) });
  const operation = transition === 'execution preflight'
    ? () => store.resolveQueuedRescueMigrationRollback(workspace, continuation.job.id, undefined)
    : transition === 'running' ? () => store.transitionJob(workspace, continuation.job.id, ['queued'], 'running')
      : transition === 'failed' ? () => store.finishJob(workspace, continuation.job.id, ['queued'], 'failed', { error: { message: 'must fail closed' }, exitCode: 1 })
        : transition === 'controller' ? () => createJobController({ store, dataRoot }).cancel(workspace, continuation.job.id, continuation.job.ownerSessionId)
          : () => scavengeWritableJobs({ store, dataRoot, workspace, createClient: async () => { throw new Error('queued worker must not create a client'); } });
  if (transition === 'recovery') await operation(); else await assert.rejects(operation(), { code: transition === 'controller' ? 'JOB_CANCEL_FAILED' : 'RESCUE_BINDING_INVALID' });
  assert.equal((await store.readJob(workspace, continuation.job.id)).status, 'queued');
});

for (const transition of ['execution', 'failed', 'controller', 'recovery']) test(`genuine ordinary unbound Rescue job remains settleable through ${transition}`, async () => {
  const { dataRoot, workspace, store } = await fixture(); const job = await store.reserveJob(reservation(workspace)); let settled;
  if (transition === 'execution') {
    assert.equal(await store.resolveQueuedRescueMigrationRollback(workspace, job.id, undefined, 'execution'), undefined);
    const claimed = await store.claimJobWorkerForExecution(workspace, job.id, {
      childPid: 999_999_999, workerLeaseId: '3'.repeat(64),
    });
    settled = await store.transitionJob(workspace, job.id, ['queued'], 'running', {
      childPid: claimed.childPid, workerLeaseId: claimed.workerLeaseId,
    });
  } else if (transition === 'failed') settled = await store.finishJob(workspace, job.id, ['queued'], 'failed', { error: { message: 'ordinary failure' }, exitCode: 1 });
  else if (transition === 'controller') settled = await createJobController({ store, dataRoot }).cancel(workspace, job.id, job.ownerSessionId);
  else {
    await store.claimJobWorker(workspace, job.id, { childPid: 999_999_999, workerLeaseId: '4'.repeat(64) });
    await scavengeWritableJobs({ store, dataRoot, workspace, createClient: async () => { throw new Error('queued worker must not create a client'); } });
    settled = await store.readJob(workspace, job.id);
  }
  assert.equal(settled.status, transition === 'execution' ? 'running' : transition === 'controller' ? 'cancelled' : 'failed');
});

test('queued to running revalidates missing continuation proof under the final StateStore lock', async () => {
  const { dataRoot, workspace, store } = await fixture(); const hook = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  await makeEligible(store, workspace, first.job, 'missing-running-proof-session'); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  const continuation = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
    executor: hook, operationId: first.binding.operationId });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const jobPath = join(storage.directory, 'jobs', `${continuation.job.id}.json`);
  const markerless = JSON.parse(await readFile(jobPath, 'utf8')); delete markerless.rescueContinuationOrigin;
  await writeFile(jobPath, `${JSON.stringify(markerless, null, 2)}\n`);
  await assert.rejects(store.transitionJob(workspace, continuation.job.id, ['queued'], 'running'), { code: 'RESCUE_BINDING_INVALID' });
  assert.equal((await store.readJob(workspace, continuation.job.id)).status, 'queued');
});

test('queued to running rejects a binding closed after preflight and retains its exact continuation proof', async () => {
  const { workspace, store } = await fixture(); const hook = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  await makeEligible(store, workspace, first.job, 'running-race-session'); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  const continuation = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
    executor: hook, operationId: first.binding.operationId });
  const proof = continuation.job.rescueContinuationOrigin;
  assert.equal(await store.resolveQueuedRescueMigrationRollback(workspace, continuation.job.id, undefined), undefined);
  await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId, executorAgentId: hook.agentId,
    operationId: continuation.binding.operationId, reason: 'invalidated' });
  await assert.rejects(store.transitionJob(workspace, continuation.job.id, ['queued'], 'running'), { code: 'RESCUE_BINDING_INVALID' });
  const queued = await store.readJob(workspace, continuation.job.id);
  assert.equal(queued.status, 'queued'); assert.deepEqual(queued.rescueContinuationOrigin, proof);
});

test('queued migrated continuation revalidates its marker after preflight and retains it when the binding is revoked', async () => {
  const { dataRoot, workspace, store } = await fixture(); const hook = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  await makeEligible(store, workspace, first.job, 'migration-running-race-session'); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  await downgradeOnlyBindingToV2(dataRoot, workspace);
  await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId, executorAgentId: hook.agentId,
    operationId: first.binding.operationId, reason: 'session-ended' });
  const proof = await store.readRescueBindingMigrationProof({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, childAgentType: hook.agentType, originWorkspace: workspace,
    executionWorkspace: workspace, agentPath: hook.agentPath });
  const continuation = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
    executor: hook, operationId: first.binding.operationId, migrationProof: proof.migrationProof });
  assert.deepEqual(await store.resolveQueuedRescueMigrationRollback(workspace, continuation.job.id, undefined), continuation.migrationRollback);
  await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId, executorAgentId: hook.agentId,
    operationId: continuation.binding.operationId, reason: 'invalidated' });
  await assert.rejects(store.transitionJob(workspace, continuation.job.id, ['queued'], 'running'), { code: /RESCUE_BINDING_(?:INVALID|STALE)/u });
  const queued = await store.readJob(workspace, continuation.job.id);
  assert.equal(queued.status, 'queued'); assert.deepEqual(queued.rescueMigrationRollback, continuation.migrationRollback);
});

test('execution claim rejects a revoke winner and exact terminalization preserves that revocation', async () => {
  const { workspace, store } = await fixture(); const hook = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  await makeEligible(store, workspace, first.job, 'claim-revoke-session'); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  const continuation = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
    executor: hook, operationId: first.binding.operationId });
  const closed = await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, operationId: continuation.binding.operationId, reason: 'invalidated' });
  await assert.rejects(store.claimJobWorkerForExecution(workspace, continuation.job.id, {
    childPid: 999_999_999, workerLeaseId: 'a'.repeat(64),
  }), { code: 'RESCUE_BINDING_INVALID' });
  const failed = await store.finishJob(workspace, continuation.job.id, ['queued'], 'failed', {
    error: { message: 'authorization was revoked before execution claim' }, exitCode: 1,
  });
  assert.equal(failed.status, 'failed'); assert.equal(failed.workerLeaseId, undefined);
  const persisted = await store.resolveRescueBinding({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId }).catch((error) => error);
  assert.equal(persisted.code, 'RESCUE_BINDING_CLOSED');
  const repeated = await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, operationId: continuation.binding.operationId, reason: 'invalidated' });
  assert.deepEqual(repeated.binding, closed.binding);
});

test('fresh execution claim rejects a revoke winner and remains terminalizable', async () => {
  const { workspace, store } = await fixture(); const hook = executor(workspace);
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  const closed = await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, operationId: fresh.binding.operationId, reason: 'invalidated' });
  await assert.rejects(store.claimJobWorkerForExecution(workspace, fresh.job.id, {
    childPid: 999_999_999, workerLeaseId: 'f'.repeat(64),
  }), { code: 'RESCUE_BINDING_INVALID' });
  const failed = await store.finishJob(workspace, fresh.job.id, ['queued'], 'failed', {
    error: { message: 'fresh authorization was revoked before execution claim' }, exitCode: 1,
  });
  assert.equal(failed.status, 'failed'); assert.equal(failed.rescueExecutionClaim, undefined);
  const repeated = await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, operationId: fresh.binding.operationId, reason: 'invalidated' });
  assert.deepEqual(repeated.binding, closed.binding);
});

test('execution claim is the authorization boundary for a later binding revoke', async () => {
  const { workspace, store } = await fixture(); const hook = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  await makeEligible(store, workspace, first.job, 'claimed-revoke-session'); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  const continuation = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
    executor: hook, operationId: first.binding.operationId });
  const claimed = await store.claimJobWorkerForExecution(workspace, continuation.job.id, {
    childPid: 999_999_999, workerLeaseId: 'b'.repeat(64),
  });
  assert.equal(claimed.status, 'queued'); assert.ok(claimed.rescueExecutionClaim);
  await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, operationId: continuation.binding.operationId, reason: 'invalidated' });
  const running = await store.transitionJob(workspace, continuation.job.id, ['queued'], 'running', {
    startedAt: new Date().toISOString(), childPid: claimed.childPid, workerLeaseId: claimed.workerLeaseId,
  });
  assert.equal(running.status, 'running'); assert.equal(running.rescueExecutionClaim, undefined);
  assert.equal(running.rescueContinuationOrigin, undefined);
});

test('queued to running accepts only the exact worker lease that owns the execution claim', async () => {
  const { workspace, store } = await fixture(); const hook = executor(workspace);
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  const claimed = await store.claimJobWorkerForExecution(workspace, fresh.job.id, {
    childPid: 999_999_999, workerLeaseId: 'd'.repeat(64),
  });
  await assert.rejects(store.transitionJob(workspace, fresh.job.id, ['queued'], 'running', {
    startedAt: new Date().toISOString(), childPid: claimed.childPid, workerLeaseId: 'e'.repeat(64),
  }), { code: 'RESCUE_BINDING_INVALID' });
  const queued = await store.readJob(workspace, fresh.job.id);
  assert.equal(queued.status, 'queued'); assert.deepEqual(queued.rescueExecutionClaim, claimed.rescueExecutionClaim);
  assert.equal(queued.workerLeaseId, claimed.workerLeaseId);
});

for (const omitted of ['both worker fields', 'childPid', 'workerLeaseId']) test(`queued to running requires the caller to submit ${omitted} explicitly for an execution claim`, async () => {
  const { workspace, store } = await fixture(); const hook = executor(workspace);
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  const claimed = await store.claimJobWorkerForExecution(workspace, fresh.job.id, {
    childPid: 999_999_999, workerLeaseId: '1'.repeat(64),
  });
  const patch = { startedAt: new Date().toISOString() };
  if (omitted === 'childPid') patch.workerLeaseId = claimed.workerLeaseId;
  if (omitted === 'workerLeaseId') patch.childPid = claimed.childPid;
  await assert.rejects(store.transitionJob(workspace, fresh.job.id, ['queued'], 'running', patch),
    { code: 'RESCUE_BINDING_INVALID' });
  const queued = await store.readJob(workspace, fresh.job.id);
  assert.equal(queued.status, 'queued'); assert.deepEqual(queued.rescueExecutionClaim, claimed.rescueExecutionClaim);
});

for (const reservationKind of ['unbound', 'bound']) test(`modern ${reservationKind} writable Rescue cannot enter running without an execution claim`, async () => {
  const { workspace, store } = await fixture(); const hook = executor(workspace);
  const job = reservationKind === 'unbound'
    ? await store.reserveJob(reservation(workspace))
    : (await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook })).job;
  await assert.rejects(store.transitionJob(workspace, job.id, ['queued'], 'running', {
    startedAt: new Date().toISOString(), childPid: 999_999_999, workerLeaseId: '2'.repeat(64),
  }), { code: 'RESCUE_BINDING_INVALID' });
  assert.equal((await store.readJob(workspace, job.id)).status, 'queued');
});

test('historical writable Rescue lacking reservation class retains direct queued to running compatibility', async () => {
  const { dataRoot, workspace, store } = await fixture();
  const job = await store.reserveJob(reservation(workspace));
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const path = join(storage.directory, 'jobs', `${job.id}.json`);
  const historical = JSON.parse(await readFile(path, 'utf8')); delete historical.rescueReservationKind;
  await writeFile(path, `${JSON.stringify(historical, null, 2)}\n`);
  const ownerRoot = join(storage.directory, 'job-owners'); let ownerBindingPath;
  for (const entry of await readdir(ownerRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) continue;
    const candidate = join(ownerRoot, entry.name, `${job.id}.json`);
    try { await readFile(candidate); ownerBindingPath = candidate; break; }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  assert.ok(ownerBindingPath); await writeFile(ownerBindingPath, `${JSON.stringify({
    jobId: job.id, ownerSessionId: job.ownerSessionId, version: 1,
  }, null, 2)}\n`);
  const running = await store.transitionJob(workspace, job.id, ['queued'], 'running', {
    startedAt: new Date().toISOString(), childPid: 999_999_999, workerLeaseId: '3'.repeat(64),
  });
  assert.equal(running.status, 'running'); assert.equal(running.rescueExecutionClaim, undefined);
});

for (const legacyKind of ['unbound', 'bound-v1', 'bound-v2']) test(`production claim authorizes exact owner-v1 classless ${legacyKind} Rescue`, async () => {
  const { dataRoot, workspace, store } = await fixture(); const hook = executor(workspace);
  const reserved = legacyKind === 'unbound' ? { job: await store.reserveJob(reservation(workspace)) }
    : await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  await downgradeReservationToOwnerV1(dataRoot, workspace, reserved.job,
    legacyKind === 'unbound' ? undefined : Number(legacyKind.at(-1)));
  const claimed = await store.claimJobWorkerForExecution(workspace, reserved.job.id, {
    childPid: 999_999_999, workerLeaseId: '8'.repeat(64),
  });
  assert.equal(claimed.status, 'queued'); assert.equal(claimed.rescueReservationKind, undefined);
  assert.equal(claimed.rescueExecutionClaim.version, 2);
  assert.equal(claimed.rescueExecutionClaim.reservationProof, 'owner-v1-classless');
  assert.equal(claimed.rescueExecutionClaim.kind, legacyKind === 'unbound' ? 'unbound' : 'bound');
  const running = await store.transitionJob(workspace, reserved.job.id, ['queued'], 'running', {
    childPid: claimed.childPid, workerLeaseId: claimed.workerLeaseId,
  });
  assert.equal(running.status, 'running'); assert.equal(running.rescueExecutionClaim, undefined);
});

test('production claim rejects owner-v1 classless Rescue attached to a modern v3 binding', async () => {
  const { dataRoot, workspace, store } = await fixture(); const hook = executor(workspace);
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  await downgradeReservationToOwnerV1(dataRoot, workspace, fresh.job);
  await assert.rejects(store.claimJobWorkerForExecution(workspace, fresh.job.id, {
    childPid: 999_999_999, workerLeaseId: '9'.repeat(64),
  }), { code: 'RESCUE_BINDING_INVALID' });
  await assert.rejects(store.transitionJob(workspace, fresh.job.id, ['queued'], 'running', {
    childPid: 999_999_999, workerLeaseId: 'a'.repeat(64),
  }), { code: 'RESCUE_BINDING_INVALID' });
  assert.equal((await store.readJob(workspace, fresh.job.id)).status, 'queued');
});

for (const kind of ['continuation']) for (const path of ['direct running', 'production claim']) test(`classless owner-v1 v3 ${kind} fails closed through ${path}`, async () => {
  const { workspace, store, queued } = await classlessOwnerV1V3QueuedForTest(kind);
  const operation = path === 'direct running'
    ? store.transitionJob(workspace, queued.id, ['queued'], 'running', {
      childPid: 999_999_999, workerLeaseId: 'b'.repeat(64),
    })
    : store.claimJobWorkerForExecution(workspace, queued.id, {
      childPid: 999_999_999, workerLeaseId: 'c'.repeat(64),
    });
  await assert.rejects(operation, { code: 'RESCUE_BINDING_INVALID' });
  const persisted = await store.readJob(workspace, queued.id);
  assert.equal(persisted.status, 'queued'); assert.equal(persisted.workerLeaseId, undefined);
});

for (const closeReason of ['invalidated', 'session-ended']) for (const phase of ['queued', 'running']) test(`claim-first ${phase} cancellation preserves a ${closeReason} binding tombstone`, async () => {
  const { dataRoot, workspace, store } = await fixture(); const hook = executor(workspace);
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  const claimed = await store.claimJobWorkerForExecution(workspace, fresh.job.id, {
    childPid: 999_999_999, workerLeaseId: '4'.repeat(64),
  });
  if (phase === 'running') await store.transitionJob(workspace, fresh.job.id, ['queued'], 'running', {
    startedAt: new Date().toISOString(), childPid: claimed.childPid, workerLeaseId: claimed.workerLeaseId,
    zcodeSessionId: 'claim-first-cancel-session',
  });
  const closed = await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, operationId: fresh.binding.operationId, reason: closeReason });
  let stops = 0; const cancelled = phase === 'queued'
    ? await store.finishJob(workspace, fresh.job.id, ['queued'], 'cancelled', { exitCode: null })
    : await createJobController({ store, dataRoot, stopSession: async () => { stops += 1; } })
      .cancel(workspace, fresh.job.id, fresh.job.ownerSessionId);
  assert.equal(cancelled.status, phase === 'queued' ? 'cancelled' : 'cancelling'); assert.equal(stops, 0);
  assert.equal(cancelled.rescueExecutionClaim, undefined);
  const repeated = await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, operationId: fresh.binding.operationId, reason: closeReason });
  assert.deepEqual(repeated.binding, closed.binding);
});

test('orphan recovery terminalizes a revoked execution claim without reopening its binding', async () => {
  const { dataRoot, workspace, store } = await fixture(); const hook = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  await makeEligible(store, workspace, first.job, 'claimed-orphan-session'); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  const continuation = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
    executor: hook, operationId: first.binding.operationId });
  const claimed = await store.claimJobWorkerForExecution(workspace, continuation.job.id, {
    childPid: 999_999_999, workerLeaseId: 'c'.repeat(64),
  });
  const closed = await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, operationId: continuation.binding.operationId, reason: 'invalidated' });
  await scavengeWritableJobs({ store, dataRoot, workspace,
    createClient: async () => { throw new Error('queued execution claim must recover before remote inspection'); } });
  const failed = await store.readJob(workspace, claimed.id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.rescueExecutionClaim, undefined);
  assert.equal(failed.workerLeaseId, claimed.workerLeaseId);
  const repeated = await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, operationId: continuation.binding.operationId, reason: 'invalidated' });
  assert.deepEqual(repeated.binding, closed.binding);
});

for (const kind of ['active continuation']) for (const action of ['running', 'controller cancel', 'recovery']) test(`pre-origin v2 ${kind} supports ${action} without weakening ambiguous v3 handling`, async () => {
  const { dataRoot, workspace, store } = await fixture(); const hook = executor(workspace); let queued;
  if (kind === 'active continuation') {
    const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
    await makeEligible(store, workspace, first.job, 'pre-origin-v2-session'); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
    const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const [bindingPath] = await bindingFiles(storage.directory);
    const partition = JSON.parse(await readFile(bindingPath, 'utf8')); const v2 = { ...partition.records[0], version: 2 };
    delete v2.superseded; delete v2.childAuthority.agentPath;
    await writeFile(bindingPath, `${JSON.stringify(createRescueBindingPartition({ parentSessionId: hook.parentSessionId,
      workspace, records: [v2] }), null, 2)}\n`);
    const legacyHook = structuredClone(hook); delete legacyHook.agentPath;
    queued = (await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
      executor: legacyHook, operationId: first.binding.operationId })).job;
  }
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const jobPath = join(storage.directory, 'jobs', `${queued.id}.json`);
  const legacy = JSON.parse(await readFile(jobPath, 'utf8')); delete legacy.rescueContinuationOrigin;
  await writeFile(jobPath, `${JSON.stringify(legacy, null, 2)}\n`);
  let settled;
  if (action === 'running') {
    const claimed = await store.claimJobWorkerForExecution(workspace, queued.id, {
      childPid: 999_999_999, workerLeaseId: '6'.repeat(64),
    });
    settled = await store.transitionJob(workspace, queued.id, ['queued'], 'running', {
      childPid: claimed.childPid, workerLeaseId: claimed.workerLeaseId,
    });
  }
  else if (action === 'controller cancel') settled = await createJobController({ store, dataRoot }).cancel(workspace, queued.id, queued.ownerSessionId);
  else {
    await store.claimJobWorker(workspace, queued.id, { childPid: 999_999_999, workerLeaseId: '7'.repeat(64) });
    await scavengeWritableJobs({ store, dataRoot, workspace, createClient: async () => { throw new Error('queued worker must not create a client'); } });
    settled = await store.readJob(workspace, queued.id);
  }
  assert.equal(settled.status, action === 'running' ? 'running' : action === 'controller cancel' ? 'cancelled' : 'failed');
  assert.equal(settled.rescueContinuationOrigin, undefined);
});

test('migration rollback and failed terminalization retain the queued marker across the injected write seam and retry idempotently', async () => {
  const { dataRoot, workspace, store } = await fixture(); const hook = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  await makeEligible(store, workspace, first.job, 'atomic-rollback-session'); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  await downgradeOnlyBindingToV2(dataRoot, workspace);
  const closed = await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, operationId: first.binding.operationId, reason: 'session-ended' });
  const proof = await store.readRescueBindingMigrationProof({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, childAgentType: hook.agentType, originWorkspace: workspace,
    executionWorkspace: workspace, agentPath: hook.agentPath });
  const continuation = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
    executor: hook, operationId: first.binding.operationId, migrationProof: proof.migrationProof });
  const patch = { error: { message: 'remote resume rejected' }, exitCode: 1 };
  const faulted = createStateStore({ dataRoot, testOnlyPublicationHook: throwingAt('rollback:terminal') });
  await assert.rejects(
    faulted.finishSessionEndedRescueContinuation(workspace, continuation.job.id, continuation.migrationRollback, 'failed', patch),
    { code: 'RESCUE_PUBLICATION_TEST_FAULT' },
  );
  assert.deepEqual((await store.readJob(workspace, continuation.job.id)).rescueMigrationRollback, continuation.migrationRollback);
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const [bindingPath] = await bindingFiles(storage.directory);
  assert.deepEqual(JSON.parse(await readFile(bindingPath, 'utf8')).records[0], closed.binding);
  const failed = await store.finishSessionEndedRescueContinuation(workspace, continuation.job.id, continuation.migrationRollback, 'failed', patch);
  assert.equal(failed.status, 'failed'); assert.equal(failed.rescueMigrationRollback, undefined);
  assert.deepEqual(await store.finishSessionEndedRescueContinuation(workspace, continuation.job.id, continuation.migrationRollback, 'failed', patch), failed);
});

test('active continuation failure restores the prior binding and terminalizes the retained attempt idempotently', async () => {
  const { workspace, store, hook, continuation, proof } = await activeContinuationFailureFixture();
  assert.ok(proof);
  const committed = await store.publishJobSpecCommitment(workspace, continuation.job.id, 'c'.repeat(64));
  assert.ok(committed.rescueJobSpecCommitment);
  const patch = { error: { message: 'session resume rejected' }, exitCode: 1 };
  const failed = await store.finishActiveRescueContinuationFailure(workspace, continuation.job.id, null, proof, 'failed', patch);
  assert.equal(failed.status, 'failed'); assert.equal(failed.rescueContinuationOrigin, undefined);
  assert.equal(failed.rescueExecutionClaim, undefined); assert.equal(failed.rescueJobSpecCommitment, undefined);
  const restored = (await store.resolveRescueBinding({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId })).binding;
  assert.deepEqual({ ...restored, updatedAt: proof.priorBinding.updatedAt }, proof.priorBinding);
  assert.ok(Date.parse(restored.updatedAt) > Date.parse(proof.priorBinding.updatedAt));
  assert.deepEqual(await store.finishActiveRescueContinuationFailure(workspace, continuation.job.id, null, proof, 'failed', patch), failed);
  assert.equal((await store.listJobs(workspace)).some((job) => job.id === continuation.job.id && job.status === 'failed'), true);
});

test('active continuation failure idempotence compares the caller patch using persisted JSON semantics', async () => {
  const base = await activeContinuationFailureFixture();
  const details = Object.assign(Object.create(null), { attempt: -0, source: 'resume' });
  const error = Object.assign(Object.create(null), { message: 'normalized resume failure', details });
  const patch = { error, exitCode: -0 };
  await base.store.finishActiveRescueContinuationFailure(base.workspace, base.continuation.job.id,
    null, base.proof, 'failed', patch);

  const persisted = await base.store.readJob(base.workspace, base.continuation.job.id);
  assert.equal(Object.getPrototypeOf(persisted.error), Object.prototype);
  assert.equal(Object.is(persisted.error.details.attempt, -0), false);
  assert.equal(Object.is(persisted.exitCode, -0), false);
  assert.deepEqual(await base.store.finishActiveRescueContinuationFailure(base.workspace,
    base.continuation.job.id, null, base.proof, 'failed', patch), persisted);
});

for (const mutation of ['extra mutable field', 'missing requested field']) {
  test(`active continuation failure idempotence rejects a terminal job with ${mutation}`, async () => {
    const base = await activeContinuationFailureFixture();
    const patch = { error: { message: 'resume failed before execution' }, exitCode: 1 };
    const failed = await base.store.finishActiveRescueContinuationFailure(base.workspace, base.continuation.job.id,
      null, base.proof, 'failed', patch);
    const storage = await resolveWorkspaceStorage({ dataRoot: base.dataRoot, workspace: base.workspace });
    const path = join(storage.directory, 'jobs', `${failed.id}.json`);
    const mutated = JSON.parse(await readFile(path, 'utf8'));
    if (mutation === 'extra mutable field') mutated.lastCancelError = { message: 'unrequested terminal mutation' };
    else delete mutated.exitCode;
    await writeFile(path, `${JSON.stringify(mutated, null, 2)}\n`);

    await assert.rejects(base.store.finishActiveRescueContinuationFailure(base.workspace, failed.id,
      null, base.proof, 'failed', patch), { code: 'RESCUE_BINDING_INVALID' });
  });
}

test('active continuation failure converges after binding restoration faults before terminal publication', async () => {
  const base = await activeContinuationFailureFixture();
  const patch = { error: { message: 'resume failed before execution' }, exitCode: 1 };
  const faulted = createStateStore({ dataRoot: base.dataRoot,
    testOnlyPublicationHook: throwingAt('active-continuation-rollback:binding') });
  await assert.rejects(faulted.finishActiveRescueContinuationFailure(base.workspace, base.continuation.job.id,
    null, base.proof, 'failed', patch), { code: 'RESCUE_PUBLICATION_TEST_FAULT' });
  const queued = await base.store.readJob(base.workspace, base.continuation.job.id);
  assert.equal(queued.status, 'queued'); assert.deepEqual(queued.rescueContinuationOrigin, base.proof);
  const restoredAfterFault = (await base.store.resolveRescueBinding({ workspace: base.workspace,
    parentSessionId: base.hook.parentSessionId, executorAgentId: base.hook.agentId })).binding;
  assert.deepEqual({ ...restoredAfterFault, updatedAt: base.proof.priorBinding.updatedAt }, base.proof.priorBinding);
  assert.ok(Date.parse(restoredAfterFault.updatedAt) > Date.parse(base.proof.priorBinding.updatedAt));
  const failed = await base.store.finishActiveRescueContinuationFailure(base.workspace, base.continuation.job.id,
    null, base.proof, 'failed', patch);
  assert.equal(failed.status, 'failed');
  const restoredAfterRetry = (await base.store.resolveRescueBinding({ workspace: base.workspace,
    parentSessionId: base.hook.parentSessionId, executorAgentId: base.hook.agentId })).binding;
  assert.deepEqual(restoredAfterRetry, restoredAfterFault);
});

test('active continuation failure terminal publication fault retains the exact failed result for idempotent retry', async () => {
  const base = await activeContinuationFailureFixture(); const workerLeaseId = '5'.repeat(64);
  const commitment = '4'.repeat(64); const job = base.continuation.job;
  const executionReservation = { version: 1, capabilityDigest: '3'.repeat(64), reservationId: '2'.repeat(64),
    jobId: job.id, ownerSessionId: job.ownerSessionId, workspace: base.workspace,
    operation: 'run-reserved-job', jobSpecFormat: 'sealed-v2' };
  await base.store.publishJobSpecCommitment(base.workspace, job.id, commitment, executionReservation);
  await base.store.bindJobExecutionReservationLease(base.workspace, job.id, {
    capabilityDigest: executionReservation.capabilityDigest,
    reservationId: executionReservation.reservationId, workerLeaseId,
  });
  const claimed = await base.store.claimJobWorkerForExecution(base.workspace, job.id,
    { childPid: 999_999_999, workerLeaseId }, undefined, { sealedCommitment: commitment });
  const patch = { error: { code: 'RESUME_REJECTED', message: 'claimed resume failed' }, exitCode: 1 };
  const faulted = createStateStore({ dataRoot: base.dataRoot,
    testOnlyPublicationHook: throwingAt('active-continuation-rollback:terminal') });

  await assert.rejects(faulted.finishActiveRescueContinuationFailure(base.workspace, job.id,
    workerLeaseId, base.proof, 'failed', patch), { code: 'RESCUE_PUBLICATION_TEST_FAULT' });

  const durable = await base.store.readJob(base.workspace, job.id);
  assert.equal(durable.status, 'failed'); assert.deepEqual(durable.error, patch.error);
  assert.equal(durable.exitCode, patch.exitCode); assert.ok(durable.finishedAt);
  assert.equal(durable.childPid, claimed.childPid); assert.equal(durable.workerLeaseId, workerLeaseId);
  assert.equal(durable.rescueContinuationOrigin, undefined); assert.equal(durable.rescueExecutionClaim, undefined);
  assert.equal(durable.rescueJobSpecCommitment, undefined); assert.equal(durable.rescueLegacyJobSpecProof, undefined);
  assert.equal(durable.rescueExecutionReservation.workerLeaseId, workerLeaseId);
  const restored = (await base.store.resolveRescueBinding({ workspace: base.workspace,
    parentSessionId: base.hook.parentSessionId, executorAgentId: base.hook.agentId })).binding;
  assert.deepEqual({ ...restored, updatedAt: base.proof.priorBinding.updatedAt }, base.proof.priorBinding);

  assert.deepEqual(await base.store.finishActiveRescueContinuationFailure(base.workspace, job.id,
    workerLeaseId, base.proof, 'failed', patch), durable);
  await assert.rejects(base.store.finishActiveRescueContinuationFailure(base.workspace, job.id,
    workerLeaseId, base.proof, 'failed', { ...patch, exitCode: 70 }), { code: 'RESCUE_BINDING_INVALID' });
  assert.deepEqual(await base.store.readJob(base.workspace, job.id), durable);
});

test('active continuation failure retry rejects a different generic terminal patch paired with the restored binding', async () => {
  const base = await activeContinuationFailureFixture();
  const requestedPatch = { error: { code: 'RESUME_REJECTED', message: 'resume failed before execution' }, exitCode: 1 };
  const winningPatch = { error: { code: 'GENERIC_SETTLEMENT', message: 'another failure path won' }, exitCode: 70 };
  const winner = await base.store.finishJob(base.workspace, base.continuation.job.id, ['queued'], 'failed', winningPatch);
  assert.equal(winner.status, 'failed');

  // Reproduce the durable state that the rollback's binding-first publication can leave behind while
  // a different terminal writer wins: the binding is exactly restored, but the failed job has another patch.
  const storage = await resolveWorkspaceStorage({ dataRoot: base.dataRoot, workspace: base.workspace });
  const [partitionPath] = await bindingFiles(storage.directory); const partition = JSON.parse(await readFile(partitionPath, 'utf8'));
  partition.records[0] = { ...base.proof.priorBinding,
    updatedAt: new Date(Math.max(Date.now(), Date.parse(base.proof.priorBinding.updatedAt) + 1)).toISOString() };
  await writeFile(partitionPath, `${JSON.stringify(partition, null, 2)}\n`);

  await assert.rejects(base.store.finishActiveRescueContinuationFailure(base.workspace, base.continuation.job.id,
    null, base.proof, 'failed', requestedPatch), { code: 'RESCUE_BINDING_INVALID' });
  assert.deepEqual((await base.store.readJob(base.workspace, base.continuation.job.id)).error, winningPatch.error);
});

test('active continuation rollback stale lock holder cannot publish the failed job after restoring the binding', async () => {
  const base = await activeContinuationFailureFixture();
  const storage = await resolveWorkspaceStorage({ dataRoot: base.dataRoot, workspace: base.workspace });
  const lockPath = join(storage.directory, '.state.lock');
  const staleLockPath = `${lockPath}.stale-holder`; const replacementLockPath = `${lockPath}.replacement`;
  let hookAttempted = false; let replaced = false; let renameError;
  const faulted = createStateStore({ dataRoot: base.dataRoot, testOnlyPublicationHook: async (seam) => {
    if (hookAttempted || seam !== 'active-continuation-rollback:binding') return;
    hookAttempted = true;
    try { await rename(lockPath, staleLockPath); }
    catch (error) { renameError = error; throw error; }
    replaced = true;
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(join(lockPath, 'advisory.lock'), '', { mode: 0o600 });
  } });
  const patch = { error: { message: 'resume failed before execution' }, exitCode: 1 };
  let rejection;
  try {
    await faulted.finishActiveRescueContinuationFailure(base.workspace, base.continuation.job.id,
      null, base.proof, 'failed', patch);
  } catch (error) { rejection = error; }
  finally {
    if (replaced) {
      await rename(lockPath, replacementLockPath);
      await rename(staleLockPath, lockPath);
    }
  }

  assert.equal(hookAttempted, true);
  if (process.platform === 'win32') {
    assert.equal(replaced, false);
    assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(renameError?.code), `unexpected Windows rename error: ${renameError?.code}`);
    assert.equal(rejection?.code, 'RESCUE_PUBLICATION_TEST_FAULT');
  } else {
    assert.equal(replaced, true); assert.equal(renameError, undefined);
    assert.equal(rejection?.code, 'RESCUE_BINDING_INVALID');
  }
  const queued = await base.store.readJob(base.workspace, base.continuation.job.id);
  assert.equal(queued.status, 'queued'); assert.deepEqual(queued.rescueContinuationOrigin, base.proof);
  assert.equal(queued.error, undefined); assert.equal(queued.exitCode, undefined);
  const failed = await base.store.finishActiveRescueContinuationFailure(base.workspace, base.continuation.job.id,
    null, base.proof, 'failed', patch);
  assert.equal(failed.status, 'failed');
});

test('active continuation failure idempotence rejects an unrelated failed job', async () => {
  const base = await activeContinuationFailureFixture();
  const patch = { error: { message: 'resume failed before execution' }, exitCode: 1 };
  await base.store.finishActiveRescueContinuationFailure(base.workspace, base.continuation.job.id,
    null, base.proof, 'failed', patch);
  const unrelated = await base.store.reserveJob({ ...reservation(base.workspace, 'unrelated-turn'),
    command: 'review', readOnly: true });
  await base.store.finishJob(base.workspace, unrelated.id, ['queued'], 'failed', patch);
  await assert.rejects(base.store.finishActiveRescueContinuationFailure(base.workspace, unrelated.id,
    null, base.proof, 'failed', patch), { code: 'RESCUE_BINDING_INVALID' });
});

test('active continuation failure idempotence rejects terminal running evidence', async () => {
  const base = await activeContinuationFailureFixture();
  const patch = { error: { message: 'resume failed before execution' }, exitCode: 1 };
  const failed = await base.store.finishActiveRescueContinuationFailure(base.workspace, base.continuation.job.id,
    null, base.proof, 'failed', patch);
  const storage = await resolveWorkspaceStorage({ dataRoot: base.dataRoot, workspace: base.workspace });
  const path = join(storage.directory, 'jobs', `${failed.id}.json`);
  await writeFile(path, `${JSON.stringify({ ...failed, startedAt: failed.createdAt,
    zcodeSessionId: 'unexpected-started-session' }, null, 2)}\n`);
  await assert.rejects(base.store.finishActiveRescueContinuationFailure(base.workspace, failed.id,
    null, base.proof, 'failed', patch), { code: 'RESCUE_BINDING_INVALID' });
});

test('active continuation failure accepts only its exact queued production execution fence', async () => {
  const base = await activeContinuationFailureFixture(); const workerLeaseId = '8'.repeat(64);
  const commitment = '9'.repeat(64); const job = base.continuation.job;
  const executionReservation = { version: 1, capabilityDigest: 'a'.repeat(64), reservationId: 'b'.repeat(64),
    jobId: job.id, ownerSessionId: job.ownerSessionId, workspace: base.workspace,
    operation: 'run-reserved-job', jobSpecFormat: 'sealed-v2' };
  await base.store.publishJobSpecCommitment(base.workspace, job.id, commitment, executionReservation);
  await base.store.bindJobExecutionReservationLease(base.workspace, job.id, {
    capabilityDigest: executionReservation.capabilityDigest,
    reservationId: executionReservation.reservationId, workerLeaseId,
  });
  const claimed = await base.store.claimJobWorkerForExecution(base.workspace, job.id,
    { childPid: 999_999_999, workerLeaseId }, undefined, { sealedCommitment: commitment });
  assert.equal(claimed.rescueExecutionClaim.workerLeaseId, workerLeaseId);
  assert.equal(claimed.rescueExecutionReservation.workerLeaseId, workerLeaseId);
  const patch = { error: { message: 'claimed resume failed' }, exitCode: 1 };
  const failed = await base.store.finishActiveRescueContinuationFailure(base.workspace, job.id,
    workerLeaseId, base.proof, 'failed', patch);
  assert.equal(failed.status, 'failed'); assert.equal(failed.childPid, claimed.childPid);
  assert.equal(failed.workerLeaseId, workerLeaseId); assert.equal(failed.rescueExecutionClaim, undefined);
  assert.equal(failed.rescueExecutionReservation.workerLeaseId, workerLeaseId);
  assert.equal(failed.rescueContinuationOrigin, undefined); assert.equal(failed.rescueJobSpecCommitment, undefined);
  let released;
  const cleaned = await base.store.cleanupTerminalExecutionReservation(base.workspace, job.id, {
    releaseExecutionReservation: async (proof) => { released = proof; },
  });
  assert.equal(released.workerLeaseId, workerLeaseId);
  assert.equal(cleaned.rescueExecutionReservation, undefined);
});

for (const condition of ['foreign expected lease', 'claimed job on unclaimed path', 'missing claim for expected lease']) {
  test(`active continuation failure rejects a ${condition}`, async () => {
    const base = await activeContinuationFailureFixture(); const workerLeaseId = 'c'.repeat(64);
    if (condition !== 'missing claim for expected lease') {
      await base.store.claimJobWorkerForExecution(base.workspace, base.continuation.job.id,
        { childPid: 999_999_999, workerLeaseId });
    }
    const expectedWorkerLeaseId = condition === 'foreign expected lease' ? 'd'.repeat(64)
      : condition === 'claimed job on unclaimed path' ? null : workerLeaseId;
    await assert.rejects(base.store.finishActiveRescueContinuationFailure(base.workspace, base.continuation.job.id,
      expectedWorkerLeaseId, base.proof, 'failed', { error: { message: 'expected rejection' }, exitCode: 1 }),
    { code: 'RESCUE_BINDING_INVALID' });
    assert.equal((await base.store.readJob(base.workspace, base.continuation.job.id)).status, 'queued');
    const binding = (await base.store.resolveRescueBinding({ workspace: base.workspace,
      parentSessionId: base.hook.parentSessionId, executorAgentId: base.hook.agentId })).binding;
    assert.deepEqual(binding, base.continuation.binding);
  });
}

for (const [condition, arrange] of [
  ['changed binding key', async (base) => {
    const storage = await resolveWorkspaceStorage({ dataRoot: base.dataRoot, workspace: base.workspace });
    const [path] = await bindingFiles(storage.directory); const partition = JSON.parse(await readFile(path, 'utf8'));
    const current = partition.records[0]; partition.records[0] = createRescueBinding({
      parentSessionId: current.parentSessionId, executorAgentId: 'sibling-child', executorAgentType: 'zcode-rescue',
      executorParentTurnId: 'sibling-turn', executorParentPermissionMode: current.permissionMode,
      executorAgentPath: '/root/sibling-child', workspace: current.workspace, permissionMode: current.permissionMode,
      anchorJobId: current.anchorJobId, currentJobId: current.currentJobId, operationId: current.operationId,
      now: current.updatedAt,
    });
    await writeFile(path, `${JSON.stringify(partition, null, 2)}\n`); return {};
  }],
  ['changed operation', async (base) => {
    const storage = await resolveWorkspaceStorage({ dataRoot: base.dataRoot, workspace: base.workspace });
    const [path] = await bindingFiles(storage.directory); const partition = JSON.parse(await readFile(path, 'utf8'));
    partition.records[0].operationId = 'f'.repeat(64);
    partition.records[0].updatedAt = new Date(Date.parse(partition.records[0].updatedAt) + 1).toISOString();
    await writeFile(path, `${JSON.stringify(partition, null, 2)}\n`); return {};
  }],
  ['changed prior binding', async (base) => ({ proof: { ...base.proof,
    priorBinding: { ...base.proof.priorBinding, createdAt: '2020-01-01T00:00:00.000Z' } } })],
  ['changed current job', async (base) => {
    const storage = await resolveWorkspaceStorage({ dataRoot: base.dataRoot, workspace: base.workspace });
    const [path] = await bindingFiles(storage.directory); const partition = JSON.parse(await readFile(path, 'utf8'));
    partition.records[0].currentJobId = 'e'.repeat(64);
    partition.records[0].updatedAt = new Date(Date.parse(partition.records[0].updatedAt) + 1).toISOString();
    await writeFile(path, `${JSON.stringify(partition, null, 2)}\n`); return {};
  }],
  ['non-queued job', async (base) => {
    await base.store.finishJob(base.workspace, base.continuation.job.id, ['queued'], 'failed', {
      error: { message: 'generic settlement won' }, exitCode: 1,
    }); return {};
  }],
  ['started job', async (base) => {
    const claimed = await base.store.claimJobWorkerForExecution(base.workspace, base.continuation.job.id,
      { childPid: 999_999_999, workerLeaseId: 'a'.repeat(64) });
    await base.store.transitionJob(base.workspace, base.continuation.job.id, ['queued'], 'running', {
      startedAt: new Date().toISOString(), zcodeSessionId: 'started-session',
      childPid: claimed.childPid, workerLeaseId: claimed.workerLeaseId,
    }); return {};
  }],
  ['mismatched workspace', async (base) => {
    const foreign = join(base.root, 'foreign-workspace'); await mkdir(foreign); return { workspace: await realpath(foreign) };
  }],
]) test(`active continuation failure rejects a ${condition} without rollback publication`, async () => {
  const base = await activeContinuationFailureFixture(); const before = structuredClone(base.continuation.binding);
  const overrides = await arrange(base); const patch = { error: { message: 'expected rejection' }, exitCode: 1 };
  await assert.rejects(base.store.finishActiveRescueContinuationFailure(overrides.workspace ?? base.workspace,
    base.continuation.job.id, null, overrides.proof ?? base.proof, 'failed', patch));
  if (!['non-queued job', 'started job', 'mismatched workspace'].includes(condition)) {
    const persisted = await base.store.readJob(base.workspace, base.continuation.job.id);
    assert.notEqual(persisted.status, 'failed');
  }
  if (!['changed binding key', 'changed operation', 'changed current job', 'started job'].includes(condition)) {
    const binding = (await base.store.resolveRescueBinding({ workspace: base.workspace,
      parentSessionId: base.hook.parentSessionId, executorAgentId: base.hook.agentId })).binding;
    assert.deepEqual(binding, before);
  }
});

test('markerless legacy rollback metadata is adopted only for its unique queued migrated binding', async () => {
  const { dataRoot, workspace, store } = await fixture(); const hook = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  await makeEligible(store, workspace, first.job, 'legacy-adoption-session'); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  await downgradeReservationToOwnerV1(dataRoot, workspace, first.job, 2);
  await downgradeOnlyBindingToV2(dataRoot, workspace);
  await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, operationId: first.binding.operationId, reason: 'session-ended' });
  const proof = await store.readRescueBindingMigrationProof({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, childAgentType: hook.agentType, originWorkspace: workspace,
    executionWorkspace: workspace, agentPath: hook.agentPath });
  const continuation = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
    executor: hook, operationId: first.binding.operationId, migrationProof: proof.migrationProof });
  await downgradeReservationToOwnerV1(dataRoot, workspace, continuation.job);
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const jobPath = join(storage.directory, 'jobs', `${continuation.job.id}.json`); const legacyJob = JSON.parse(await readFile(jobPath, 'utf8'));
  const { priorBinding, ...legacyRollback } = continuation.migrationRollback;
  delete legacyJob.rescueMigrationRollback; delete legacyJob.rescueJobSpecCommitment;
  await writeFile(jobPath, `${JSON.stringify(legacyJob, null, 2)}\n`);
  const [bindingPath] = await bindingFiles(storage.directory); const originalPartition = JSON.parse(await readFile(bindingPath, 'utf8'));
  const active = originalPartition.records[0]; const ambiguous = createRescueBinding({ parentSessionId: hook.parentSessionId,
    executorAgentId: 'ambiguous-child', executorAgentType: hook.agentType, executorParentTurnId: 'ambiguous-turn',
    executorParentPermissionMode: hook.parentPermissionMode, executorAgentPath: '/root/ambiguous-child', workspace,
    permissionMode: active.permissionMode, anchorJobId: active.anchorJobId, currentJobId: active.currentJobId,
    operationId: 'e'.repeat(64), now: active.updatedAt });
  await writeFile(bindingPath, `${JSON.stringify(createRescueBindingPartition({ parentSessionId: hook.parentSessionId,
    workspace, records: [active, ambiguous] }), null, 2)}\n`);
  await assert.rejects(
    store.finishSessionEndedRescueContinuation(workspace, continuation.job.id, legacyRollback, 'failed',
      { error: { message: 'ambiguous legacy metadata' }, exitCode: 1 }),
    { code: 'RESCUE_BINDING_INVALID' },
  );
  assert.equal((await store.readJob(workspace, continuation.job.id)).status, 'queued');
  await writeFile(bindingPath, `${JSON.stringify(originalPartition, null, 2)}\n`);
  const corrupt = { ...legacyRollback, priorCurrentJobId: 'f'.repeat(64) };
  await assert.rejects(
    store.finishSessionEndedRescueContinuation(workspace, continuation.job.id, corrupt, 'failed', { error: { message: 'bad legacy metadata' }, exitCode: 1 }),
    { code: 'RESCUE_BINDING_INVALID' },
  );
  assert.equal((await store.readJob(workspace, continuation.job.id)).status, 'queued');
  const patch = { error: { message: 'valid legacy metadata' }, exitCode: 1 };
  const faulted = createStateStore({ dataRoot, testOnlyPublicationHook: throwingAt('rollback:terminal') });
  await assert.rejects(faulted.finishSessionEndedRescueContinuation(workspace, continuation.job.id, legacyRollback, 'failed', patch),
    { code: 'RESCUE_PUBLICATION_TEST_FAULT' });
  const adopted = await store.readJob(workspace, continuation.job.id);
  assert.equal(adopted.status, 'queued'); assert.deepEqual(adopted.rescueMigrationRollback, { ...legacyRollback, priorBinding });
  assert.deepEqual(JSON.parse(await readFile(bindingPath, 'utf8')).records[0], priorBinding);
  const failed = await store.finishSessionEndedRescueContinuation(workspace, continuation.job.id, legacyRollback, 'failed', patch);
  assert.equal(failed.status, 'failed'); assert.equal(failed.rescueMigrationRollback, undefined);
});

test('legacy execution preflight adopts exact markerless rollback proof before the locked running commit', async () => {
  const { dataRoot, workspace, store } = await fixture(); const hook = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  await makeEligible(store, workspace, first.job, 'legacy-running-adoption-session'); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  await downgradeReservationToOwnerV1(dataRoot, workspace, first.job, 2);
  await downgradeOnlyBindingToV2(dataRoot, workspace);
  await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId, executorAgentId: hook.agentId,
    operationId: first.binding.operationId, reason: 'session-ended' });
  const proof = await store.readRescueBindingMigrationProof({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, childAgentType: hook.agentType, originWorkspace: workspace,
    executionWorkspace: workspace, agentPath: hook.agentPath });
  const continuation = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
    executor: hook, operationId: first.binding.operationId, migrationProof: proof.migrationProof });
  await downgradeReservationToOwnerV1(dataRoot, workspace, continuation.job);
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const jobPath = join(storage.directory, 'jobs', `${continuation.job.id}.json`);
  const markerless = JSON.parse(await readFile(jobPath, 'utf8')); delete markerless.rescueMigrationRollback;
  delete markerless.rescueJobSpecCommitment;
  await writeFile(jobPath, `${JSON.stringify(markerless, null, 2)}\n`);
  const legacyRollback = structuredClone(continuation.migrationRollback); delete legacyRollback.priorBinding;
  const resolved = await store.resolveQueuedRescueMigrationRollback(workspace, continuation.job.id, legacyRollback, 'execution');
  assert.deepEqual(resolved, continuation.migrationRollback);
  assert.equal((await store.readJob(workspace, continuation.job.id)).rescueMigrationRollback, undefined);
  const authorization = { legacyProof: 'markerless-migration', specDigest: 'a'.repeat(64) };
  const inspection = await store.inspectJobWorkerExecution(workspace, continuation.job.id, legacyRollback, authorization);
  const claimed = await store.claimJobWorkerForExecution(workspace, continuation.job.id, {
    childPid: 999_999_999, workerLeaseId: '5'.repeat(64),
  }, legacyRollback, authorization, inspection);
  assert.deepEqual(claimed.rescueMigrationRollback, continuation.migrationRollback);
  const running = await store.transitionJob(workspace, continuation.job.id, ['queued'], 'running', {
    childPid: claimed.childPid, workerLeaseId: claimed.workerLeaseId,
  });
  assert.equal(running.status, 'running'); assert.equal(running.rescueMigrationRollback, undefined);
});

test('ordinary controller cancel adopts markerless legacy job-spec evidence and restores the exact tombstone', async () => {
  const { dataRoot, workspace, store } = await fixture(); const hook = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  await makeEligible(store, workspace, first.job, 'legacy-controller-session'); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  await downgradeReservationToOwnerV1(dataRoot, workspace, first.job, 2);
  await downgradeOnlyBindingToV2(dataRoot, workspace);
  const closed = await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, operationId: first.binding.operationId, reason: 'session-ended' });
  const proof = await store.readRescueBindingMigrationProof({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, childAgentType: hook.agentType, originWorkspace: workspace,
    executionWorkspace: workspace, agentPath: hook.agentPath });
  const continuation = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
    executor: hook, operationId: first.binding.operationId, migrationProof: proof.migrationProof });
  await downgradeReservationToOwnerV1(dataRoot, workspace, continuation.job);
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const jobPath = join(storage.directory, 'jobs', `${continuation.job.id}.json`); const legacyJob = JSON.parse(await readFile(jobPath, 'utf8'));
  const rollback = legacyJob.rescueMigrationRollback; delete legacyJob.rescueMigrationRollback;
  delete legacyJob.rescueJobSpecCommitment; await writeFile(jobPath, `${JSON.stringify(legacyJob, null, 2)}\n`);
  const spec = { command: 'rescue', migrationParentSessionId: rollback.parentSessionId, migrationChildAgentId: rollback.childAgentId,
    migrationOperationId: rollback.operationId, migrationPriorCurrentJobId: rollback.priorCurrentJobId,
    migrationPriorUpdatedAt: rollback.priorUpdatedAt, migrationPriorClosedAt: rollback.priorClosedAt,
    migrationPriorVersion: String(rollback.priorVersion) };
  const digest = createHash('sha256').update(JSON.stringify(spec, Object.keys(spec).sort())).digest('hex');
  const specDirectory = join(storage.directory, 'job-specs'); await mkdir(specDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(specDirectory, `${continuation.job.id}.json`), `${JSON.stringify({ version: 1, jobId: continuation.job.id,
    ownerSessionId: continuation.job.ownerSessionId, workspace, digest, spec }, null, 2)}\n`, { mode: 0o600 });
  const cancelled = await createJobController({ store, dataRoot }).cancel(workspace, continuation.job.id, hook.parentSessionId);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.rescueMigrationRollback, undefined);
  const [bindingPath] = await bindingFiles(storage.directory);
  assert.deepEqual(JSON.parse(await readFile(bindingPath, 'utf8')).records[0], closed.binding);
});

for (const caller of ['controller', 'recovery']) test(`${caller} rejects a markerless legacy job-spec with an extra outer field`, async () => {
  const { dataRoot, workspace, store } = await fixture(); const hook = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  await makeEligible(store, workspace, first.job, `extra-v1-${caller}-session`); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  await downgradeOnlyBindingToV2(dataRoot, workspace);
  await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, operationId: first.binding.operationId, reason: 'session-ended' });
  const proof = await store.readRescueBindingMigrationProof({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, childAgentType: hook.agentType, originWorkspace: workspace,
    executionWorkspace: workspace, agentPath: hook.agentPath });
  const continuation = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
    executor: hook, operationId: first.binding.operationId, migrationProof: proof.migrationProof });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const jobPath = join(storage.directory, 'jobs', `${continuation.job.id}.json`);
  const markerless = JSON.parse(await readFile(jobPath, 'utf8')); const rollback = markerless.rescueMigrationRollback;
  delete markerless.rescueMigrationRollback; delete markerless.rescueJobSpecCommitment; await writeFile(jobPath, `${JSON.stringify(markerless, null, 2)}\n`);
  const spec = { command: 'rescue', migrationParentSessionId: rollback.parentSessionId, migrationChildAgentId: rollback.childAgentId,
    migrationOperationId: rollback.operationId, migrationPriorCurrentJobId: rollback.priorCurrentJobId,
    migrationPriorUpdatedAt: rollback.priorUpdatedAt, migrationPriorClosedAt: rollback.priorClosedAt,
    migrationPriorVersion: String(rollback.priorVersion) };
  const digest = createHash('sha256').update(JSON.stringify(spec, Object.keys(spec).sort())).digest('hex');
  const specDirectory = join(storage.directory, 'job-specs'); await mkdir(specDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(specDirectory, `${continuation.job.id}.json`), `${JSON.stringify({ version: 1,
    jobId: continuation.job.id, ownerSessionId: continuation.job.ownerSessionId, workspace, digest, spec, extra: true }, null, 2)}\n`, { mode: 0o600 });
  if (caller === 'controller') {
    await assert.rejects(createJobController({ store, dataRoot }).cancel(workspace, continuation.job.id, hook.parentSessionId), { code: 'JOB_CANCEL_FAILED' });
  } else {
    await store.claimJobWorker(workspace, continuation.job.id, { childPid: 999_999_999, workerLeaseId: '8'.repeat(64) });
    await scavengeWritableJobs({ store, dataRoot, workspace, createClient: async () => { throw new Error('orphaned worker'); } });
  }
  assert.equal((await store.readJob(workspace, continuation.job.id)).status, 'queued');
  const [bindingPath] = await bindingFiles(storage.directory);
  assert.deepEqual(JSON.parse(await readFile(bindingPath, 'utf8')).records[0], continuation.binding);
});

for (const specState of ['missing', 'migration fields stripped']) test(`ordinary controller cancel fails closed for a markerless migrated successor with ${specState} legacy spec`, async () => {
  const { dataRoot, workspace, store } = await fixture(); const hook = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  await makeEligible(store, workspace, first.job, `legacy-${specState.replaceAll(' ', '-')}-session`);
  await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  await downgradeOnlyBindingToV2(dataRoot, workspace);
  await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, operationId: first.binding.operationId, reason: 'session-ended' });
  const proof = await store.readRescueBindingMigrationProof({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, childAgentType: hook.agentType, originWorkspace: workspace,
    executionWorkspace: workspace, agentPath: hook.agentPath });
  const continuation = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
    executor: hook, operationId: first.binding.operationId, migrationProof: proof.migrationProof });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const jobPath = join(storage.directory, 'jobs', `${continuation.job.id}.json`);
  const markerless = JSON.parse(await readFile(jobPath, 'utf8')); delete markerless.rescueMigrationRollback;
  await writeFile(jobPath, `${JSON.stringify(markerless, null, 2)}\n`);
  if (specState === 'migration fields stripped') {
    const spec = { command: 'rescue' }; const digest = createHash('sha256').update(JSON.stringify(spec, Object.keys(spec).sort())).digest('hex');
    const specDirectory = join(storage.directory, 'job-specs'); await mkdir(specDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(specDirectory, `${continuation.job.id}.json`), `${JSON.stringify({ version: 1,
      jobId: continuation.job.id, ownerSessionId: continuation.job.ownerSessionId, workspace, digest, spec }, null, 2)}\n`, { mode: 0o600 });
  }
  await assert.rejects(createJobController({ store, dataRoot }).cancel(workspace, continuation.job.id, hook.parentSessionId),
    { code: 'JOB_CANCEL_FAILED' });
  assert.equal((await store.readJob(workspace, continuation.job.id)).status, 'queued');
  const [bindingPath] = await bindingFiles(storage.directory);
  assert.deepEqual(JSON.parse(await readFile(bindingPath, 'utf8')).records[0], continuation.binding);
});

for (const bindingState of ['unbound', 'fresh-bound', 'active-bound']) test(`ordinary controller still cancels a genuinely ${bindingState} non-migration queued Rescue job`, async () => {
  const { dataRoot, workspace, store } = await fixture();
  const hook = executor(workspace); let job;
  if (bindingState === 'unbound') job = await store.reserveJob(reservation(workspace));
  else {
    const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
    if (bindingState === 'fresh-bound') job = first.job;
    else {
      await makeEligible(store, workspace, first.job, 'ordinary-active-bound-session');
      await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
      job = (await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
        executor: hook, operationId: first.binding.operationId })).job;
    }
  }
  const cancelled = await createJobController({ store, dataRoot }).cancel(workspace, job.id, job.ownerSessionId);
  assert.equal(cancelled.status, 'cancelled');
});

test('recovery fails closed for a markerless migrated successor with a missing legacy spec', async () => {
  const { dataRoot, workspace, store } = await fixture(); const hook = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  await makeEligible(store, workspace, first.job, 'missing-recovery-evidence-session');
  await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  await downgradeOnlyBindingToV2(dataRoot, workspace);
  await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, operationId: first.binding.operationId, reason: 'session-ended' });
  const proof = await store.readRescueBindingMigrationProof({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, childAgentType: hook.agentType, originWorkspace: workspace,
    executionWorkspace: workspace, agentPath: hook.agentPath });
  const continuation = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
    executor: hook, operationId: first.binding.operationId, migrationProof: proof.migrationProof });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const jobPath = join(storage.directory, 'jobs', `${continuation.job.id}.json`);
  const markerless = JSON.parse(await readFile(jobPath, 'utf8')); delete markerless.rescueMigrationRollback;
  await writeFile(jobPath, `${JSON.stringify(markerless, null, 2)}\n`);
  await store.claimJobWorker(workspace, continuation.job.id, { childPid: 999_999_999, workerLeaseId: '9'.repeat(64) });
  await scavengeWritableJobs({ store, dataRoot, workspace, createClient: async () => { throw new Error('orphaned worker'); } });
  assert.equal((await store.readJob(workspace, continuation.job.id)).status, 'queued');
  const [bindingPath] = await bindingFiles(storage.directory);
  assert.deepEqual(JSON.parse(await readFile(bindingPath, 'utf8')).records[0], continuation.binding);
});

for (const [field, mutate] of [
  ['anchorJobId', (binding) => { binding.anchorJobId = 'f'.repeat(64); }],
  ['permissionMode', (binding) => { binding.permissionMode = 'read-only'; }],
  ['child authority path', (binding) => { binding.childAuthority.agentPath = '/root/tampered-child'; }],
  ['child authority Role', (binding) => { binding.childAuthority.childAgentType = 'default'; }],
  ['createdAt', (binding) => { binding.createdAt = '2020-01-01T00:00:00.000Z'; }],
  ['v3 superseded history', (binding) => { binding.superseded = [{ operationId: 'd'.repeat(64), anchorJobId: binding.anchorJobId,
    currentJobId: binding.currentJobId, closedAt: binding.closedAt, closeReason: 'fresh' }]; }],
]) test(`rollback retry rejects a restored tombstone with tampered ${field} and retains its queued marker`, async () => {
  const { dataRoot, workspace, store } = await fixture(); const hook = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: hook });
  await makeEligible(store, workspace, first.job, `tampered-${field.replaceAll(' ', '-')}-session`); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  await downgradeOnlyBindingToV2(dataRoot, workspace);
  await store.closeRescueBindingForChild({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, operationId: first.binding.operationId, reason: 'session-ended' });
  const proof = await store.readRescueBindingMigrationProof({ workspace, parentSessionId: hook.parentSessionId,
    executorAgentId: hook.agentId, childAgentType: hook.agentType, originWorkspace: workspace,
    executionWorkspace: workspace, agentPath: hook.agentPath });
  const continuation = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
    executor: hook, operationId: first.binding.operationId, migrationProof: proof.migrationProof });
  const patch = { error: { message: 'resume rejected' }, exitCode: 1 };
  const faulted = createStateStore({ dataRoot, testOnlyPublicationHook: throwingAt('rollback:terminal') });
  await assert.rejects(faulted.finishSessionEndedRescueContinuation(workspace, continuation.job.id,
    continuation.migrationRollback, 'failed', patch), { code: 'RESCUE_PUBLICATION_TEST_FAULT' });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const [bindingPath] = await bindingFiles(storage.directory);
  const partition = JSON.parse(await readFile(bindingPath, 'utf8')); mutate(partition.records[0]);
  await writeFile(bindingPath, `${JSON.stringify(partition, null, 2)}\n`);
  await assert.rejects(store.finishSessionEndedRescueContinuation(workspace, continuation.job.id,
    continuation.migrationRollback, 'failed', patch), (error) => ['RESCUE_BINDING_INVALID', 'RESCUE_BINDING_STALE'].includes(error?.code));
  const queued = await store.readJob(workspace, continuation.job.id);
  assert.equal(queued.status, 'queued'); assert.deepEqual(queued.rescueMigrationRollback, continuation.migrationRollback);
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


test('StateStore closes exact session bindings as tombstones without deleting jobs', async () => {
  const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  await makeEligible(store, workspace, fresh.job, 'zcode-session-a'); await store.finishJob(workspace, fresh.job.id, ['running'], 'succeeded');
  const siblingExecutor = executor(workspace, { parentSessionId: 'sibling-session', agentId: 'sibling-child' });
  const siblingReservation = { ...reservation(workspace, 'sibling-turn'), ownerSessionId: 'sibling-session' };
  const sibling = await store.reserveFreshRescueJob({ workspace, reservation: siblingReservation, executor: siblingExecutor }); await store.finishJob(workspace, sibling.job.id, ['queued'], 'failed');
  const closed = await store.closeRescueBindingForChild({ workspace, parentSessionId: trusted.parentSessionId, executorAgentId: trusted.agentId, operationId: fresh.binding.operationId, reason: 'session-ended' });
  assert.equal(closed.kind, 'closed');
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

test('StateStore rejects sessionless and permission-mismatched anchors while reporting cancelled operations closed', async () => {
  const { workspace, store } = await fixture(); const trusted = executor(workspace);
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  await assert.rejects(store.resolveRescueBindingForResume(bindingExpected(workspace, trusted)), { code: 'RESCUE_BINDING_INVALID' });
  await assert.rejects(store.resolveRescueBindingForResume(bindingExpected(workspace, trusted, { permissionMode: 'read-only' })), { code: 'RESCUE_BINDING_INVALID' });
  await store.finishJob(workspace, fresh.job.id, ['queued'], 'cancelled', { exitCode: null });
  await assert.rejects(store.resolveRescueBindingForResume(bindingExpected(workspace, trusted)), { code: 'RESCUE_BINDING_CLOSED' });
  await assert.rejects(store.readBoundRescueCurrentJob({ workspace, parentSessionId: trusted.parentSessionId, executorAgentId: trusted.agentId }), { code: 'RESCUE_BINDING_CLOSED' });
});

test('StateStore rejects a symlinked binding and bounds SessionEnd scans', async () => {
  const { dataRoot, root, workspace, store } = await fixture(); const trusted = executor(workspace);
  await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const [path] = await bindingFiles(storage.directory);
  const outside = join(root, 'outside.json'); await writeFile(outside, await readFile(path));
  await import('node:fs/promises').then(({ unlink }) => unlink(path)); await symlink(outside, path);
  await assert.rejects(store.resolveRescueBinding(bindingExpected(workspace, trusted)), { code: 'RESCUE_BINDING_INVALID' });
  await assert.rejects(store.closeRescueBindingForChild({ workspace, parentSessionId: trusted.parentSessionId, executorAgentId: trusted.agentId, operationId: 'a'.repeat(64), reason: 'session-ended' }), { code: 'RESCUE_BINDING_INVALID' });
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
  ];
  for (const scenario of scenarios) {
    await Promise.all(['authority', 'session'].flatMap((kind) => ['delete', 'replace', 'corrupt', 'symlink'].map(async (mutation) => {
      const base = await fixture(); const trusted = executor(base.workspace); let anchor;
      if (scenario.route === 'continuation') {
        anchor = await base.store.reserveFreshRescueJob({ workspace: base.workspace,
          reservation: reservation(base.workspace, 'seed'), executor: trusted });
        await makeEligible(base.store, base.workspace, anchor.job, 'stable-session');
        await base.store.finishJob(base.workspace, anchor.job.id, ['running'], 'succeeded');
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
          : assert.fail('unexpected retired route');
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

test('legacy-style job readers tolerate the private Rescue reservation class and ignore binding storage', async () => {
  const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
  const legacy = await store.reserveJob({ ...reservation(workspace, 'legacy'), command: 'review', readOnly: true });
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const jobsDirectory = join(storage.directory, 'jobs');
  const legacyRead = async () => Promise.all((await readdir(jobsDirectory)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)).map(async (name) => JSON.parse(await readFile(join(jobsDirectory, name), 'utf8'))));
  const jobs = await legacyRead(); assert.equal(jobs.length, 2);
  const persistedFresh = jobs.find((job) => job.id === fresh.job.id); assert.equal(persistedFresh.rescueReservationKind, 'bound');
  delete persistedFresh.rescueReservationKind;
  assert.deepEqual(Object.keys(persistedFresh).sort(), Object.keys(legacy).sort());
  assert.equal((await bindingFiles(storage.directory)).length, 1);
});

test('legacy reservation ignores Rescue publication hooks and child closure is scoped and idempotent', async () => {
  const { dataRoot, workspace } = await fixture();
  const legacy = createStateStore({ dataRoot, testOnlyPublicationHook: throwingAt('fresh:binding') });
  assert.equal((await legacy.reserveJob({ ...reservation(workspace), command: 'review', readOnly: true })).command, 'review');
  const clean = createStateStore({ dataRoot });
  const firstExecutor = executor(workspace); const first = await clean.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: firstExecutor });
  await makeEligible(clean, workspace, first.job, 'first-session'); await clean.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  const secondExecutor = executor(workspace, { agentId: 'second-child' }); const second = await clean.reserveFreshRescueJob({ workspace, reservation: reservation(workspace, 'second'), executor: secondExecutor });
  await makeEligible(clean, workspace, second.job, 'second-session'); await clean.finishJob(workspace, second.job.id, ['running'], 'succeeded');
  const partial = createStateStore({ dataRoot, testOnlyPublicationHook: throwingAt('close:binding') });
  await assert.rejects(partial.closeRescueBindingForChild({ workspace, parentSessionId: firstExecutor.parentSessionId, executorAgentId: firstExecutor.agentId, operationId: first.binding.operationId, reason: 'session-ended' }), { code: 'RESCUE_PUBLICATION_TEST_FAULT' });
  assert.equal((await clean.resolveRescueBinding(bindingExpected(workspace, firstExecutor))).kind, 'bound');
  assert.equal((await clean.resolveRescueBinding(bindingExpected(workspace, secondExecutor))).kind, 'bound');
  assert.equal((await clean.closeRescueBindingForChild({ workspace, parentSessionId: firstExecutor.parentSessionId, executorAgentId: firstExecutor.agentId, operationId: first.binding.operationId, reason: 'session-ended' })).kind, 'closed');
  assert.equal((await clean.closeRescueBindingForChild({ workspace, parentSessionId: secondExecutor.parentSessionId, executorAgentId: secondExecutor.agentId, operationId: second.binding.operationId, reason: 'session-ended' })).kind, 'closed');
  assert.equal((await clean.closeRescueBindingForChild({ workspace, parentSessionId: firstExecutor.parentSessionId, executorAgentId: firstExecutor.agentId, operationId: first.binding.operationId, reason: 'session-ended' })).kind, 'closed');
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

test('fresh publication seams leave only safe fail-closed state and reject same-child retries', async () => {
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
    if (seam === 'fresh:binding') {
      assert.equal((await clean.reserveFreshRescueJob({ workspace, reservation: reservation(workspace, 'retry'), executor: trusted })).job.status, 'queued');
    } else {
      await assert.rejects(clean.reserveFreshRescueJob({ workspace, reservation: reservation(workspace, 'retry'), executor: trusted }),
        { code: 'RESCUE_BINDING_STALE' });
    }
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


test('fresh rejects an existing same-child binding without changing jobs or binding bytes', async () => {
  const { workspace, store } = await fixture(); const trusted = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  await makeEligible(store, workspace, first.job, 'zcode-session-a'); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  const storage = await resolveWorkspaceStorage({ dataRoot: store.dataRoot, workspace });
  const [bindingPath] = await bindingFiles(storage.directory); const bindingBefore = await readFile(bindingPath);
  const jobsBefore = await store.listJobs(workspace);
  await assert.rejects(store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace, 'turn-b'), executor: trusted }),
    { code: 'RESCUE_BINDING_STALE' });
  assert.deepEqual(await store.listJobs(workspace), jobsBefore);
  assert.deepEqual(await readFile(bindingPath), bindingBefore);
});

test('child-scoped closure cannot close a sibling and the session-wide close API is retired', async () => {
  const { workspace, store } = await fixture(); const firstExecutor = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: firstExecutor });
  await makeEligible(store, workspace, first.job, 'zcode-session-a'); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  const siblingExecutor = executor(workspace, { agentId: 'sibling-child', parentTurnId: 'sibling-turn' });
  const sibling = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace, 'sibling-turn'), executor: siblingExecutor });
  await makeEligible(store, workspace, sibling.job, 'zcode-session-b'); await store.finishJob(workspace, sibling.job.id, ['running'], 'succeeded');
  assert.equal(store.closeRescueBindingsForSession, undefined);
  await store.closeRescueBindingForChild({ workspace, parentSessionId: first.binding.parentSessionId,
    executorAgentId: firstExecutor.agentId, operationId: first.binding.operationId, reason: 'invalidated' });
  await assert.rejects(store.resolveRescueBinding(bindingExpected(workspace, firstExecutor)), { code: 'RESCUE_BINDING_CLOSED' });
  assert.equal((await store.resolveRescueBinding(bindingExpected(workspace, siblingExecutor))).binding.operationId, sibling.binding.operationId);
});

test('cancelling the exact current job atomically revokes its binding before publishing cancellation', async () => {
  const { workspace, store } = await fixture(); const trusted = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  await store.finishJob(workspace, first.job.id, ['queued'], 'cancelled');
  await assert.rejects(store.resolveRescueBindingForResume(bindingExpected(workspace, trusted)), { code: 'RESCUE_BINDING_CLOSED' });
  const closed = await store.closeRescueBindingForCancelledJob({ workspace, parentSessionId: first.binding.parentSessionId, jobId: first.job.id });
  assert.equal(closed.binding.state, 'closed'); assert.equal(closed.binding.closeReason, 'cancel');
});

test('fresh on a different child preserves the first child binding', async () => {
  const { workspace, store } = await fixture(); const firstExecutor = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: firstExecutor });
  await makeEligible(store, workspace, first.job, 'zcode-session-a'); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  const secondExecutor = executor(workspace, { agentId: 'second-child', parentTurnId: 'second-turn' });
  const second = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace, 'second-turn'), executor: secondExecutor });
  assert.notEqual(second.binding.operationId, first.binding.operationId);
  assert.equal((await store.resolveRescueBinding(bindingExpected(workspace, firstExecutor))).binding.operationId, first.binding.operationId);
  assert.equal((await store.resolveRescueBinding(bindingExpected(workspace, secondExecutor))).binding.operationId, second.binding.operationId);
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

test('new-slot creation GCs only revoked tombstones and retains session-ended migration candidates', async () => {
  const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
  const first = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  await makeEligible(store, workspace, first.job, 'zcode-session-a'); await store.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  await store.closeRescueBindingForChild({ workspace, parentSessionId: trusted.parentSessionId, executorAgentId: trusted.agentId, operationId: first.binding.operationId, reason: 'session-ended' });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const [closedPath] = await bindingFiles(storage.directory);
  const old = createRescueBinding({ ...identity, workspace: storage.workspacePath, anchorJobId: first.job.id, currentJobId: first.job.id, operationId: first.binding.operationId, now: '2020-01-01T00:00:00.000Z' });
  const revoked = createRescueBinding({ ...identity, workspace: storage.workspacePath, executorAgentId: 'revoked-child', anchorJobId: first.job.id, currentJobId: first.job.id, operationId: 'e'.repeat(64), now: '2020-01-01T00:00:00.000Z' });
  const records = [
    closeRescueBinding(old, { operationId: old.operationId, reason: 'session-ended', now: '2020-01-02T00:00:00.000Z' }),
    closeRescueBinding(revoked, { operationId: revoked.operationId, reason: 'invalidated', now: '2020-01-02T00:00:00.000Z' }),
  ];
  for (let index = 2; index < 1024; index += 1) {
    const item = createRescueBinding({ ...identity, workspace: storage.workspacePath, executorAgentId: `child-${index}`, anchorJobId: 'a'.repeat(64), currentJobId: 'a'.repeat(64), operationId: index.toString(16).padStart(64, '0'), now: '2020-01-01T00:00:00.000Z' });
    records.push(item);
  }
  await writeFile(closedPath, `${JSON.stringify(createRescueBindingPartition({ parentSessionId: identity.parentSessionId, workspace: storage.workspacePath, records }), null, 2)}\n`);
  const replacement = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace, 'turn-b'), executor: executor(workspace, { agentId: 'replacement-child' }) });
  assert.equal(rescueBindingAuthorityView(replacement.binding).childAgentId, 'replacement-child');
  const retained = JSON.parse(await readFile(closedPath, 'utf8')).records;
  assert.equal(retained.some((record) => record.key === old.key), true);
  assert.equal(retained.some((record) => record.key === revoked.key), false);
});

test('stop cause and stop intent codecs accept only the exact bounded schema', () => {
  assert.deepEqual([...STOP_CAUSES].sort(), ['host-coordination-loss', 'session-end', 'user']);
  assert.deepEqual([...EXECUTION_OWNERS], ['host-child']);
  assert.deepEqual([...HOST_PLACEMENTS].sort(), ['background', 'foreground']);
  const intent = { version: 1, cause: 'session-end', requestedAt: '2026-09-02T00:00:00.000Z' };
  assert.equal(validStopIntent(intent), true);
  const epoch = hostLifecycleEpoch('host-session-a', '2026-09-02T00:00:00.000Z');
  assert.equal(validLifecycleEpoch(epoch), true);
  assert.equal(validLifecycleEpoch('a'.repeat(64)), true);
  for (const invalid of [
    { ...intent, version: 2 }, { ...intent, cause: 'timeout' }, { ...intent, requestedAt: '2026-09-02T00:00:00Z' },
    { ...intent, extra: true }, { version: 1, cause: 'user' }, null, 'stop',
  ]) assert.equal(validStopIntent(invalid), false);
  for (const invalid of ['a'.repeat(63), 'A'.repeat(64), 'z'.repeat(64), 'not-a-digest']) {
    assert.equal(validLifecycleEpoch(invalid), false);
  }
});

test('confirmed new-schema cancellation preserves the exact binding', async () => {
  const { workspace, store } = await fixture(); const trusted = executor(workspace);
  const lifecycle = { ownerLifecycleEpoch: hostLifecycleEpoch('host-session-a', '2026-09-02T00:00:00.000Z'),
    executionOwner: 'host-child', hostPlacement: 'foreground' };
  const stopIntent = { version: 1, cause: 'user', requestedAt: '2026-09-02T00:00:00.000Z' };
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace),
    executor: trusted, lifecycle });
  await makeEligible(store, workspace, fresh.job, 'zcode-session-a');
  await store.transitionJob(workspace, fresh.job.id, ['running'], 'cancelling', { stopIntent });
  const cancelled = await store.finishJob(workspace, fresh.job.id, ['cancelling'], 'cancelled', { stopIntent, stopCause: 'user' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.stopCause, 'user');
  assert.deepEqual(cancelled.stopIntent, stopIntent);
  const resolved = await store.resolveRescueBinding(bindingExpected(workspace, trusted));
  assert.equal(resolved.kind, 'bound');
  assert.equal(resolved.binding.state, 'active');
  assert.equal(resolved.binding.currentJobId, fresh.job.id);
  assert.equal(resolved.binding.operationId, fresh.binding.operationId);
});

test('a preserved new-schema cancelled binding remains resumable through the continuation CAS', async () => {
  const { workspace, store } = await fixture(); const trusted = executor(workspace);
  const lifecycle = { ownerLifecycleEpoch: hostLifecycleEpoch('host-session-b', '2026-09-02T00:00:00.000Z'),
    executionOwner: 'host-child', hostPlacement: 'background' };
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace),
    executor: trusted, lifecycle });
  await makeEligible(store, workspace, fresh.job, 'zcode-session-b');
  await store.transitionJob(workspace, fresh.job.id, ['running'], 'cancelling',
    { stopIntent: { version: 1, cause: 'session-end', requestedAt: '2026-09-02T00:00:00.000Z' } });
  await store.finishJob(workspace, fresh.job.id, ['cancelling'], 'cancelled', { stopCause: 'session-end' });
  const continuation = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
    executor: trusted, operationId: fresh.binding.operationId });
  assert.equal(continuation.job.status, 'queued');
  assert.equal(continuation.binding.state, 'active');
  assert.equal(continuation.binding.currentJobId, continuation.job.id);
  assert.equal(continuation.binding.anchorJobId, fresh.job.id);
  assert.equal(continuation.binding.operationId, fresh.binding.operationId);
  assert.equal(continuation.anchorJob.zcodeSessionId, 'zcode-session-b');
  assert.equal((await store.readJob(workspace, fresh.job.id)).stopCause, 'session-end');
});

test('a Host-owned Rescue continuation keeps its binding resumable across repeated confirmed cancellations', async () => {
  const { workspace, store } = await fixture(); const trusted = executor(workspace);
  const lifecycle = { ownerLifecycleEpoch: hostLifecycleEpoch('host-session-c', '2026-09-02T00:00:00.000Z'),
    executionOwner: 'host-child', hostPlacement: 'background' };
  const stopIntent = { version: 1, cause: 'user', requestedAt: '2026-09-02T00:00:00.000Z' };
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace),
    executor: trusted, lifecycle });
  await makeEligible(store, workspace, fresh.job, 'zcode-session-c');
  await store.transitionJob(workspace, fresh.job.id, ['running'], 'cancelling', { stopIntent });
  await store.finishJob(workspace, fresh.job.id, ['cancelling'], 'cancelled', { stopCause: 'user' });
  await assert.rejects(store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
    executor: trusted, operationId: fresh.binding.operationId,
    lifecycle: { ownerLifecycleEpoch: lifecycle.ownerLifecycleEpoch, executionOwner: 'host-child' } }),
  { code: 'RESCUE_BINDING_INVALID' });
  const continuation = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
    executor: trusted, operationId: fresh.binding.operationId, lifecycle });
  assert.equal(continuation.job.ownerLifecycleEpoch, lifecycle.ownerLifecycleEpoch);
  assert.equal(continuation.job.executionOwner, 'host-child');
  assert.equal(continuation.job.hostPlacement, 'background');
  await makeEligible(store, workspace, continuation.job, 'zcode-session-c');
  await store.transitionJob(workspace, continuation.job.id, ['running'], 'cancelling', { stopIntent });
  await store.finishJob(workspace, continuation.job.id, ['cancelling'], 'cancelled', { stopCause: 'user' });
  const resolved = await store.resolveRescueBinding(bindingExpected(workspace, trusted));
  assert.equal(resolved.kind, 'bound');
  assert.equal(resolved.binding.state, 'active');
  assert.equal(resolved.binding.currentJobId, continuation.job.id);
  const again = await store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-c'),
    executor: trusted, operationId: fresh.binding.operationId, lifecycle });
  assert.equal(again.job.status, 'queued');
  assert.equal(again.binding.state, 'active');
  assert.equal(again.binding.currentJobId, again.job.id);
});

test('closure of a cancelled Host-owned Rescue binding is skipped and reported as preserved', async () => {
  const { workspace, store } = await fixture(); const trusted = executor(workspace);
  const lifecycle = { ownerLifecycleEpoch: hostLifecycleEpoch('host-session-d', '2026-09-02T00:00:00.000Z'),
    executionOwner: 'host-child', hostPlacement: 'foreground' };
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace),
    executor: trusted, lifecycle });
  await makeEligible(store, workspace, fresh.job, 'zcode-session-d');
  await store.transitionJob(workspace, fresh.job.id, ['running'], 'cancelling',
    { stopIntent: { version: 1, cause: 'user', requestedAt: '2026-09-02T00:00:00.000Z' } });
  await store.finishJob(workspace, fresh.job.id, ['cancelling'], 'cancelled', { stopCause: 'user' });
  const outcome = await store.closeRescueBindingForCancelledJob({ workspace, parentSessionId: fresh.binding.parentSessionId, jobId: fresh.job.id });
  assert.equal(outcome.kind, 'preserved');
  assert.equal(outcome.binding.state, 'active');
  assert.equal(outcome.binding.currentJobId, fresh.job.id);
  assert.equal((await store.resolveRescueBinding(bindingExpected(workspace, trusted))).binding.state, 'active');
});

test('a historical cancelled record without the lifecycle trio never resumes', async () => {
  const { workspace, store } = await fixture(); const trusted = executor(workspace);
  const legacy = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  await makeEligible(store, workspace, legacy.job, 'zcode-legacy-session');
  await store.transitionJob(workspace, legacy.job.id, ['running'], 'cancelling');
  await store.finishJob(workspace, legacy.job.id, ['cancelling'], 'cancelled');
  await assert.rejects(store.resolveRescueBindingForResume(bindingExpected(workspace, trusted)), { code: 'RESCUE_BINDING_CLOSED' });
  await assert.rejects(store.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'turn-b'),
    executor: trusted, operationId: legacy.binding.operationId }), { code: 'RESCUE_BINDING_CLOSED' });
});

test('a queued pre-session Host-owned cancellation revokes its binding instead of stranding the child slot', async () => {
  const { workspace, store } = await fixture(); const trusted = executor(workspace);
  const lifecycle = { ownerLifecycleEpoch: hostLifecycleEpoch('host-session-e', '2026-09-02T00:00:00.000Z'),
    executionOwner: 'host-child', hostPlacement: 'foreground' };
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace),
    executor: trusted, lifecycle });
  const cancelled = await store.finishJob(workspace, fresh.job.id, ['queued'], 'cancelled',
    { stopIntent: { version: 1, cause: 'user', requestedAt: '2026-09-02T00:00:00.000Z' }, stopCause: 'user' });
  assert.equal(cancelled.status, 'cancelled');
  await assert.rejects(store.resolveRescueBinding(bindingExpected(workspace, trusted)), { code: 'RESCUE_BINDING_CLOSED' });
  await assert.rejects(store.resolveRescueBindingForResume(bindingExpected(workspace, trusted)), { code: 'RESCUE_BINDING_CLOSED' });
  assert.equal((await store.closeRescueBindingForCancelledJob({ workspace, parentSessionId: fresh.binding.parentSessionId,
    jobId: fresh.job.id })).kind, 'closed');
  const replacement = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace, 'turn-b'),
    executor: executor(workspace, { agentId: 'replacement-child' }) });
  assert.equal(replacement.binding.state, 'active');
});
