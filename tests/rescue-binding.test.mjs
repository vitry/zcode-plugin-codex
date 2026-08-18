// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rename, stat, symlink, writeFile } from 'node:fs/promises';
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
  assert.throws(() => createRescueBinding({ ...identity, permissionMode: undefined, anchorJobId: 'a'.repeat(64), currentJobId: 'a'.repeat(64), operationId: 'c'.repeat(64) }), { code: 'RESCUE_BINDING_INVALID' });
  assert.throws(() => createRescueBinding({ ...identity, workspace: '/canonical/../workspace', anchorJobId: 'a'.repeat(64), currentJobId: 'a'.repeat(64), operationId: 'c'.repeat(64) }), { code: 'RESCUE_BINDING_INVALID' });
  assert.throws(() => parseRescueBinding(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])), { code: 'RESCUE_BINDING_INVALID' });
});

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zcode-rescue-binding-'));
  const dataRoot = join(root, 'data'); const workspace = join(root, 'workspace');
  await mkdir(workspace);
  return { root, dataRoot, workspace, store: createStateStore({ dataRoot, ...options }) };
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
    for (const name of await readdir(join(directory, partition.name))) if (/^[a-f0-9]{64}\.json$/u.test(name)) files.push(join(directory, partition.name, name));
  }
  return files;
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

test('StateStore fails closed when a same-session sibling claims a foreign canonical workspace', async () => {
  const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const root = join(storage.directory, 'rescue-bindings');
  const directory = join(root, (await readdir(root))[0]);
  const foreign = createRescueBinding({ ...identity, workspace: '/foreign/workspace', executorAgentId: 'foreign-child', anchorJobId: fresh.job.id, currentJobId: fresh.job.id, operationId: 'e'.repeat(64) });
  await writeFile(join(directory, `${foreign.key}.json`), `${JSON.stringify(foreign)}\n`);
  await assert.rejects(store.resolveRescueBinding(bindingExpected(workspace, executor(workspace, { agentId: 'absent-child' }))), { code: 'RESCUE_BINDING_INVALID' });
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

test('atomic temp remnants fail closed instead of masquerading as missing bindings', async () => {
  const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
  await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const root = join(storage.directory, 'rescue-bindings');
  const directory = join(root, (await readdir(root))[0]); await writeFile(join(directory, '.binding.interrupted.tmp'), '{}');
  await assert.rejects(store.resolveRescueBinding(bindingExpected(workspace, trusted)), { code: 'RESCUE_BINDING_INVALID' });
});

test('publication rejects binding-partition and state-lock replacement without authorizing partial state', async () => {
  {
    const base = await fixture(); const storage = await resolveWorkspaceStorage({ dataRoot: base.dataRoot, workspace: base.workspace }); let replaced = false;
    const store = createStateStore({ dataRoot: base.dataRoot, testOnlyPublicationHook: async (seam) => {
      if (replaced || seam !== 'fresh:binding') return; replaced = true;
      const root = join(storage.directory, 'rescue-bindings'); const [partition] = await readdir(root);
      await rename(join(root, partition), join(root, `${partition}.replaced`)); await mkdir(join(root, partition), { mode: 0o700 });
    } });
    await assert.rejects(store.reserveFreshRescueJob({ workspace: base.workspace, reservation: reservation(base.workspace), executor: executor(base.workspace) }), { code: 'RESCUE_BINDING_INVALID' });
  }
  {
    const base = await fixture(); const storage = await resolveWorkspaceStorage({ dataRoot: base.dataRoot, workspace: base.workspace }); let replaced = false;
    const store = createStateStore({ dataRoot: base.dataRoot, testOnlyPublicationHook: async (seam) => {
      if (replaced || seam !== 'fresh:owner-binding') return; replaced = true;
      const lock = join(storage.directory, '.state.lock'); await rename(lock, `${lock}.replaced`); await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, 'advisory.lock'), '', { mode: 0o600 });
    } });
    await assert.rejects(store.reserveFreshRescueJob({ workspace: base.workspace, reservation: reservation(base.workspace), executor: executor(base.workspace) }), { code: 'RESCUE_BINDING_INVALID' });
    const clean = createStateStore({ dataRoot: base.dataRoot });
    await assert.rejects(clean.resolveRescueBindingForResume(bindingExpected(base.workspace, executor(base.workspace))), { code: 'RESCUE_BINDING_INVALID' });
  }
});

test('every post-partition publication checkpoint and final return rejects partition replacement durably', async () => {
  const scenarios = [
    ...['fresh:owner-binding', 'fresh:job', 'fresh:marker', 'fresh:final'].map((seam) => ({ route: 'fresh', seam })),
    ...['continuation:owner-binding', 'continuation:job', 'continuation:marker', 'continuation:current-advance', 'continuation:final'].map((seam) => ({ route: 'continuation', seam })),
    ...['adopt:base-binding', 'adopt:owner-binding', 'adopt:job', 'adopt:marker', 'adopt:current-advance', 'adopt:final'].map((seam) => ({ route: 'adopt', seam })),
  ];
  for (const scenario of scenarios) {
    const base = await fixture(); const trusted = executor(base.workspace); let anchor;
    if (scenario.route !== 'fresh') {
      anchor = await base.store.reserveJob(reservation(base.workspace)); await makeEligible(base.store, base.workspace, anchor, 'stable-session'); await base.store.finishJob(base.workspace, anchor.id, ['running'], 'failed');
      if (scenario.route === 'continuation') {
        const adopted = await base.store.adoptRescueCandidate({ workspace: base.workspace, reservation: reservation(base.workspace, 'seed'), executor: trusted, candidateJobId: anchor.id });
        await base.store.finishJob(base.workspace, adopted.job.id, ['queued'], 'failed'); anchor = adopted;
      }
    }
    const storage = await resolveWorkspaceStorage({ dataRoot: base.dataRoot, workspace: base.workspace }); let replaced = false;
    const store = createStateStore({ dataRoot: base.dataRoot, testOnlyPublicationHook: async (seam) => {
      if (replaced || seam !== scenario.seam) return; replaced = true;
      const root = join(storage.directory, 'rescue-bindings'); const [partition] = (await readdir(root)).filter((name) => /^[a-f0-9]{64}$/u.test(name));
      await rename(join(root, partition), join(root, `${partition}.replaced`)); await mkdir(join(root, partition), { mode: 0o700 });
    } });
    const operation = scenario.route === 'fresh'
      ? store.reserveFreshRescueJob({ workspace: base.workspace, reservation: reservation(base.workspace, 'attempt'), executor: trusted })
      : scenario.route === 'continuation'
        ? store.reserveBoundRescueContinuation({ workspace: base.workspace, reservation: reservation(base.workspace, 'attempt'), executor: trusted, operationId: anchor.binding.operationId })
        : store.adoptRescueCandidate({ workspace: base.workspace, reservation: reservation(base.workspace, 'attempt'), executor: trusted, candidateJobId: anchor.id });
    await assert.rejects(operation, { code: 'RESCUE_BINDING_INVALID' }, `${scenario.seam} must reject replacement`);
    await assert.rejects(createStateStore({ dataRoot: base.dataRoot }).resolveRescueBinding(bindingExpected(base.workspace, trusted)), { code: 'RESCUE_BINDING_INVALID' }, `${scenario.seam} must not become missing`);
  }
});

test('oversized persisted binding records fail closed before allocation or parsing', async () => {
  const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
  await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const [path] = await bindingFiles(join(storage.directory, 'rescue-bindings'));
  await writeFile(path, Buffer.alloc(16 * 1024 + 1, 0x20));
  await assert.rejects(store.resolveRescueBinding(bindingExpected(workspace, trusted)), { code: 'RESCUE_BINDING_INVALID' });
});

test('legacy-style job readers observe unchanged job schema and ignore Rescue binding storage', async () => {
  const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
  const legacy = await store.reserveJob({ ...reservation(workspace, 'legacy'), command: 'review', readOnly: true });
  const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const jobsDirectory = join(storage.directory, 'jobs');
  const legacyRead = async () => Promise.all((await readdir(jobsDirectory)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)).map(async (name) => JSON.parse(await readFile(join(jobsDirectory, name), 'utf8'))));
  const jobs = await legacyRead(); assert.equal(jobs.length, 2);
  assert.deepEqual(Object.keys(jobs.find((job) => job.id === fresh.job.id)).sort(), Object.keys(legacy).sort());
  assert.equal((await bindingFiles(join(storage.directory, 'rescue-bindings'))).length, 1);
});

test('legacy reservation ignores Rescue publication hooks and close resumes safely after a partial scan', async () => {
  const { dataRoot, workspace } = await fixture();
  const legacy = createStateStore({ dataRoot, testOnlyPublicationHook: throwingAt('fresh:binding') });
  assert.equal((await legacy.reserveJob({ ...reservation(workspace), command: 'review', readOnly: true })).command, 'review');
  const clean = createStateStore({ dataRoot });
  const firstExecutor = executor(workspace); const first = await clean.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: firstExecutor });
  await makeEligible(clean, workspace, first.job, 'first-session'); await clean.finishJob(workspace, first.job.id, ['running'], 'succeeded');
  const secondExecutor = executor(workspace, { agentId: 'second-child' }); const second = await clean.reserveFreshRescueJob({ workspace, reservation: reservation(workspace, 'second'), executor: secondExecutor });
  await makeEligible(clean, workspace, second.job, 'second-session'); await clean.finishJob(workspace, second.job.id, ['running'], 'succeeded');
  let writes = 0; const partial = createStateStore({ dataRoot, testOnlyPublicationHook: async (seam) => { if (seam === 'close:binding' && ++writes === 2) throw new Error('injected close:binding'); } });
  await assert.rejects(partial.closeRescueBindingsForSession({ workspace, parentSessionId: firstExecutor.parentSessionId, reason: 'session-ended' }), { code: 'RESCUE_PUBLICATION_TEST_FAULT' });
  assert.equal(await clean.closeRescueBindingsForSession({ workspace, parentSessionId: firstExecutor.parentSessionId, reason: 'session-ended' }), 1);
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
  for (const seam of ['fresh:binding', 'fresh:owner-binding', 'fresh:job', 'fresh:marker']) {
    const { dataRoot, workspace, store } = await fixture({ testOnlyPublicationHook: throwingAt(seam) }); const trusted = executor(workspace);
    await assert.rejects(store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted }), { code: 'RESCUE_PUBLICATION_TEST_FAULT' });
    const clean = createStateStore({ dataRoot }); const jobs = await clean.listJobs(workspace);
    const binding = await clean.resolveRescueBinding(bindingExpected(workspace, trusted));
    if (seam === 'fresh:binding') assert.deepEqual(binding, { kind: 'missing' });
    else {
      assert.equal(binding.kind, 'bound');
      await assert.rejects(clean.resolveRescueBindingForResume(bindingExpected(workspace, trusted)), { code: 'RESCUE_BINDING_INVALID' });
    }
    assert.equal(jobs.length, seam === 'fresh:marker' ? 1 : 0);
    if (seam === 'fresh:marker') await assert.rejects(clean.reserveFreshRescueJob({ workspace, reservation: reservation(workspace, 'retry'), executor: trusted }), { code: 'WRITABLE_JOB_EXISTS' });
    else assert.equal((await clean.reserveFreshRescueJob({ workspace, reservation: reservation(workspace, 'retry'), executor: trusted })).job.status, 'queued');
  }
});

test('continuation publication seams retain the stable prior binding and serialize two writers', async () => {
  for (const seam of ['continuation:owner-binding', 'continuation:job', 'continuation:marker', 'continuation:current-advance']) {
    const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
    const fresh = await store.reserveFreshRescueJob({ workspace, reservation: reservation(workspace), executor: trusted });
    await makeEligible(store, workspace, fresh.job, 'stable-session'); await store.finishJob(workspace, fresh.job.id, ['running'], 'succeeded');
    const faulted = createStateStore({ dataRoot, testOnlyPublicationHook: throwingAt(seam) });
    await assert.rejects(faulted.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'next'), executor: trusted, operationId: fresh.binding.operationId }), { code: 'RESCUE_PUBLICATION_TEST_FAULT' });
    const clean = createStateStore({ dataRoot }); const resolved = await clean.resolveRescueBindingForResume(bindingExpected(workspace, trusted));
    assert.equal(resolved.currentJob.id, fresh.job.id); assert.equal(resolved.anchorJob.zcodeSessionId, 'stable-session');
    const jobs = await clean.listJobs(workspace); assert.equal(jobs.length, ['continuation:marker', 'continuation:current-advance'].includes(seam) ? 2 : 1);
    const retry = clean.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'retry'), executor: trusted, operationId: fresh.binding.operationId });
    if (['continuation:marker', 'continuation:current-advance'].includes(seam)) await assert.rejects(retry, { code: 'WRITABLE_JOB_EXISTS' });
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
  for (const seam of ['adopt:base-binding', 'adopt:owner-binding', 'adopt:job', 'adopt:marker', 'adopt:current-advance']) {
    const { dataRoot, workspace, store } = await fixture(); const trusted = executor(workspace);
    const candidate = await store.reserveJob(reservation(workspace)); await makeEligible(store, workspace, candidate, 'candidate-session'); await store.finishJob(workspace, candidate.id, ['running'], 'failed');
    const faulted = createStateStore({ dataRoot, testOnlyPublicationHook: throwingAt(seam) });
    await assert.rejects(faulted.adoptRescueCandidate({ workspace, reservation: reservation(workspace, 'adopt'), executor: trusted, candidateJobId: candidate.id }), { code: 'RESCUE_PUBLICATION_TEST_FAULT' });
    const clean = createStateStore({ dataRoot }); const binding = await clean.resolveRescueBinding(bindingExpected(workspace, trusted));
    if (seam === 'adopt:base-binding') assert.deepEqual(binding, { kind: 'missing' });
    else { assert.equal(binding.kind, 'bound'); assert.equal(binding.binding.anchorJobId, candidate.id); assert.equal(binding.binding.currentJobId, candidate.id); }
    assert.equal((await clean.listJobs(workspace)).length, ['adopt:marker', 'adopt:current-advance'].includes(seam) ? 2 : 1);
    if (seam === 'adopt:base-binding') assert.equal((await clean.adoptRescueCandidate({ workspace, reservation: reservation(workspace, 'retry'), executor: trusted, candidateJobId: candidate.id })).anchorJob.id, candidate.id);
    else {
      const retry = clean.reserveBoundRescueContinuation({ workspace, reservation: reservation(workspace, 'retry'), executor: trusted, operationId: binding.binding.operationId });
      if (['adopt:marker', 'adopt:current-advance'].includes(seam)) await assert.rejects(retry, { code: 'WRITABLE_JOB_EXISTS' });
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
  const overflow = createRescueBinding({ ...identity, workspace: storage.workspacePath, executorAgentId: 'physical-overflow-child', anchorJobId: 'a'.repeat(64), currentJobId: 'a'.repeat(64), operationId: 'f'.repeat(64), now: '2020-01-01T00:00:00.000Z' });
  await writeFile(join(directory, `${overflow.key}.json`), `${JSON.stringify(overflow)}\n`);
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
