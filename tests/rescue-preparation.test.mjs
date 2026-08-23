import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { PluginError } from '../scripts/lib/errors.mjs';
import { samePathHandleFileSnapshot, withFileLock } from '../scripts/lib/fs.mjs';
import {
  RESCUE_ENVELOPE_MAX_BYTES,
  RESCUE_PREPARATION_VERSION,
  RESCUE_TASK_MAX_BYTES,
  createRescuePreparationStore,
  hasRecordedRescueMarker,
  readRescuePreparation,
  validateRescuePreparation,
} from '../scripts/lib/rescue-preparation.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';

const validEnvelope = Object.freeze({
  version: 1,
  source: 'explicit',
  task: 'implement the approved specification',
  options: Object.freeze({ execution: 'foreground', resume: 'fresh', effort: 'high' }),
});
const spawnActivation = Object.freeze({
  kind: 'spawn', taskName: 'zcode_rescue_task', agentPathDigest: 'a'.repeat(64),
});
const spawnActivationProof = Object.freeze({ ...spawnActivation });
const reactivateActivation = Object.freeze({
  kind: 'reactivate', executorAgentId: 'rescue-child', agentPathDigest: 'b'.repeat(64),
});
const reactivateActivationProof = Object.freeze({
  kind: 'reactivate', agentPathDigest: 'b'.repeat(64),
});

/** @param {unknown} value */
function input(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return Readable.from([bytes]);
}

/** @param {unknown} value */
async function rejectsPreparation(value) {
  await assert.rejects(readRescuePreparation(input(value)), { code: 'RESCUE_PREPARATION_INVALID' });
}

/** @param {any} error */
function errorChainText(error) {
  const messages = [];
  for (let current = error; current; current = current.cause) messages.push(String(current.message));
  return messages.join('\n');
}

test('exports the versioned Rescue preparation byte bounds', () => {
  assert.equal(RESCUE_PREPARATION_VERSION, 1);
  assert.equal(RESCUE_TASK_MAX_BYTES, 64 * 1024);
  assert.equal(RESCUE_ENVELOPE_MAX_BYTES, 64 * 1024 + 4096);
});

test('path-to-handle snapshots tolerate only the Windows device split', () => {
  const pathStats = { dev: 41n, ino: 73n, size: 101n, mtimeNs: 107n, ctimeNs: 109n };
  const handleStats = { ...pathStats, dev: 43n };
  assert.equal(samePathHandleFileSnapshot(pathStats, handleStats, 'win32'), true);
  assert.equal(samePathHandleFileSnapshot(pathStats, handleStats, 'linux'), false);
  assert.equal(samePathHandleFileSnapshot(pathStats, { ...handleStats, ino: 79n }, 'win32'), false);
  for (const field of ['size', 'mtimeNs', 'ctimeNs']) {
    assert.equal(samePathHandleFileSnapshot(pathStats, { ...handleStats, [field]: 127n }, 'win32'), false);
  }
});

test('reads exactly one LF-terminated preparation envelope and defensively copies it', async () => {
  const original = {
    ...validEnvelope,
    options: { ...validEnvelope.options, model: 'provider/model' },
  };
  const decoded = await readRescuePreparation(input(`${JSON.stringify(original)}\n`));
  assert.deepEqual(decoded, original);
  assert.notEqual(decoded, original);
  assert.notEqual(decoded.options, original.options);
  decoded.options.model = 'changed';
  assert.equal(original.options.model, 'provider/model');
});

test('rejects malformed framing, UTF-8, duplicate keys, and envelope overflow', async () => {
  await rejectsPreparation(JSON.stringify(validEnvelope));
  await rejectsPreparation(`${JSON.stringify(validEnvelope)}\nextra`);
  await rejectsPreparation(`${JSON.stringify(validEnvelope)}\n{}\n`);
  await rejectsPreparation(Buffer.from([0xc3, 0x28, 0x0a]));
  await rejectsPreparation('{"version":1,"version":1,"source":"explicit","task":"x","options":{}}\n');
  await rejectsPreparation('{"version":1,"source":"explicit","task":"x","options":{"model":"a","model":"b"}}\n');
  await rejectsPreparation(`${' '.repeat(RESCUE_ENVELOPE_MAX_BYTES)}\n`);
});

test('stream errors are always converted to a new task-free preparation error', async () => {
  const sentinel = 'UPSTREAM_PLUGIN_ERROR_TASK_SENTINEL';
  for (const upstream of [
    new PluginError('RESCUE_PREPARATION_INVALID', sentinel, { cause: new Error(sentinel) }),
    new PluginError('FORGED', sentinel, { cause: new PluginError('NESTED', sentinel) }),
  ]) {
    const stream = Readable.from((async function* broken() {
      yield Buffer.alloc(0);
      throw upstream;
    }()));
    await assert.rejects(readRescuePreparation(stream), (/** @type {any} */ error) => {
      assert.notEqual(error, upstream);
      assert.equal(error.code, 'RESCUE_PREPARATION_INVALID');
      assert.doesNotMatch(errorChainText(error), new RegExp(sentinel));
      return true;
    });
  }
});

test('stdin skips empty chunks and accepts arbitrary byte-bounded transport fragmentation', async () => {
  const bytes = Buffer.from(`${JSON.stringify(validEnvelope)}\n`);
  const emptyChunks = Array.from({ length: 2048 }, () => Buffer.alloc(0));
  assert.deepEqual(await readRescuePreparation(Readable.from([...emptyChunks, bytes])), validEnvelope);
  const largeEnvelope = { ...validEnvelope, task: 'x'.repeat(2048) };
  const fragmentedBytes = Buffer.from(`${JSON.stringify(largeEnvelope)}\n`);
  assert.ok(fragmentedBytes.length > 1024);
  const fragmented = Readable.from([...fragmentedBytes].map((byte) => Buffer.from([byte])));
  assert.deepEqual(await readRescuePreparation(fragmented), largeEnvelope);
});

test('validation requires the exact envelope and option schemas', () => {
  const invalid = [
    null,
    { ...validEnvelope, extra: true },
    { source: validEnvelope.source, task: validEnvelope.task, options: validEnvelope.options },
    { ...validEnvelope, version: 2 },
    { ...validEnvelope, source: 'automatic' },
    { ...validEnvelope, task: '' },
    { ...validEnvelope, task: 'x'.repeat(RESCUE_TASK_MAX_BYTES + 1) },
    { ...validEnvelope, options: null },
    { ...validEnvelope, options: { unknown: true } },
    { ...validEnvelope, options: { execution: null } },
    { ...validEnvelope, options: { execution: 'parallel' } },
    { ...validEnvelope, options: { resume: 'continue' } },
    { ...validEnvelope, options: { effort: 'maximum' } },
    { ...validEnvelope, options: { model: '' } },
    { ...validEnvelope, options: { model: 'x'.repeat(513) } },
    { ...validEnvelope, options: { model: 'provider\nmodel' } },
  ];
  for (const value of invalid) {
    assert.throws(() => validateRescuePreparation(value), { code: 'RESCUE_PREPARATION_INVALID' });
  }
});

test('validation accepts every enum and preserves absent optional keys', () => {
  for (const source of ['explicit', 'proactive']) {
    for (const execution of ['foreground', 'background']) {
      for (const resume of ['fresh', 'resume']) {
        for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
          assert.deepEqual(validateRescuePreparation({
            version: 1, source, task: 'x', options: { execution, resume, effort },
          }), { version: 1, source, task: 'x', options: { execution, resume, effort } });
        }
      }
    }
  }
  assert.deepEqual(validateRescuePreparation({
    version: 1, source: 'proactive', task: 'x', options: {},
  }), { version: 1, source: 'proactive', task: 'x', options: {} });
});

test('recorded Rescue marker uses the existing whitespace boundary and never task wording', () => {
  assert.equal(hasRecordedRescueMarker('$zcode:rescue repair auth'), true);
  assert.equal(hasRecordedRescueMarker('please run\n$zcode:rescue\tnow'), true);
  assert.equal(hasRecordedRescueMarker('task says rescue but has no marker'), false);
  assert.equal(hasRecordedRescueMarker('prefix$zcode:rescue repair'), false);
  assert.equal(hasRecordedRescueMarker('$zcode:rescue-now repair'), false);
  assert.equal(hasRecordedRescueMarker('repair the literal "$zcode:rescue-like" string'), false);
});

async function storeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'zcode-rescue-prepared-'));
  const dataRoot = join(root, 'plugin-data');
  const workspaceA = join(root, 'workspace-a');
  const workspaceB = join(root, 'workspace-b');
  await Promise.all([mkdir(workspaceA), mkdir(workspaceB)]);
  return {
    root,
    dataRoot,
    workspaceA,
    workspaceB,
    store: createRescuePreparationStore({ dataRoot }),
  };
}

test('omitted generation-one activation writes strict v2 and consumes without proof', async () => {
  const { dataRoot, store, workspaceA } = await storeFixture();
  const base = { sessionId: 'parent', turnId: 'turn-legacy', workspace: workspaceA,
    permissionMode: 'workspace-write', recordedPrompt: '$zcode:rescue legacy caller' };
  await store.save({ ...base, envelope: validEnvelope });
  const path = await preparedPath(dataRoot, workspaceA, 'parent', 'turn-legacy');
  const persisted = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(persisted.version, 2);
  assert.equal(persisted.generation, 1);
  assert.equal(persisted.requiredExecutorAgentId, null);
  assert.equal(persisted.activation, undefined);
  assert.deepEqual(Object.keys(persisted).sort(), [
    'consumedAt', 'createdAt', 'envelope', 'executorAgentId', 'expiresAt', 'generation',
    'key', 'permissionMode', 'requiredExecutorAgentId', 'sessionId', 'source', 'turnId',
    'version', 'workspace',
  ].sort());
  const consumed = await store.consume({ ...base, executorAgentId: 'legacy-child' });
  assert.equal(consumed.version, 2);
  assert.equal(consumed.executorAgentId, 'legacy-child');
});

test('generation-one spawn and reactivate activations round trip with exact proofs', async (t) => {
  /** @type {Array<[string, any, string, any]>} */
  const variants = [
    ['spawn', spawnActivation, 'spawned-child', spawnActivationProof],
    ['reactivate', reactivateActivation, 'rescue-child', reactivateActivationProof],
  ];
  for (const [name, activation, executorAgentId, activationProof] of variants) await t.test(name, async () => {
    const { dataRoot, store, workspaceA } = await storeFixture();
    const base = {
      sessionId: 'parent', turnId: `turn-${name}`, workspace: workspaceA,
      permissionMode: 'workspace-write', recordedPrompt: '$zcode:rescue activate',
    };
    await store.save({ ...base, envelope: validEnvelope, activation });
    const consumed = await store.consume({ ...base, executorAgentId, activationProof });
    assert.equal(consumed.version, 3);
    assert.equal(consumed.generation, 1);
    assert.equal(consumed.requiredExecutorAgentId, null);
    assert.deepEqual(consumed.activation, activation);
    const persisted = JSON.parse(await readFile(
      await preparedPath(dataRoot, workspaceA, 'parent', `turn-${name}`), 'utf8',
    ));
    assert.deepEqual(persisted.activation, activation);
  });
});

test('generation-one activation proof is exact and failed proofs do not consume', async (t) => {
  /** @type {Array<[string, any]>} */
  const cases = [
    ['missing proof', undefined],
    ['wrong kind', { kind: 'reactivate', agentPathDigest: 'a'.repeat(64) }],
    ['wrong digest', { ...spawnActivationProof, agentPathDigest: 'c'.repeat(64) }],
    ['wrong task', { ...spawnActivationProof, taskName: 'zcode_rescue_sibling' }],
    ['unknown proof key', { ...spawnActivationProof, extra: true }],
  ];
  for (const [name, activationProof] of cases) await t.test(name, async () => {
    const { store, workspaceA } = await storeFixture();
    const base = { sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
      permissionMode: 'workspace-write', recordedPrompt: '$zcode:rescue activate' };
    await store.save({ ...base, envelope: validEnvelope, activation: spawnActivation });
    await assert.rejects(store.consume({
      ...base, executorAgentId: 'spawned-child',
      ...(activationProof === undefined ? {} : { activationProof }),
    }), { code: 'RESCUE_PREPARATION_MISMATCH' });
    await store.consume({ ...base, executorAgentId: 'spawned-child', activationProof: spawnActivationProof });
  });
});

test('reactivation proof binds the exact executor and remains one-shot and expiring', async () => {
  const { store, workspaceA } = await storeFixture();
  const now = new Date('2026-08-17T00:00:00.000Z');
  const base = { sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'workspace-write', recordedPrompt: '$zcode:rescue activate' };
  await store.save({ ...base, envelope: validEnvelope, activation: reactivateActivation, now });
  await assert.rejects(store.consume({ ...base, executorAgentId: 'sibling-child',
    activationProof: reactivateActivationProof, now }), { code: 'RESCUE_PREPARATION_MISMATCH' });
  await assert.rejects(store.consume({ ...base, executorAgentId: 'rescue-child',
    activationProof: { kind: 'spawn', taskName: 'zcode_rescue_task', agentPathDigest: 'b'.repeat(64) }, now }),
  { code: 'RESCUE_PREPARATION_MISMATCH' });
  await store.consume({ ...base, executorAgentId: 'rescue-child', activationProof: reactivateActivationProof, now });
  await assert.rejects(store.consume({ ...base, executorAgentId: 'rescue-child',
    activationProof: reactivateActivationProof, now }), { code: 'RESCUE_PREPARATION_CONSUMED' });

  const expired = { ...base, turnId: 'turn-expired' };
  await store.save({ ...expired, envelope: validEnvelope, activation: reactivateActivation, now });
  await assert.rejects(store.consume({ ...expired, executorAgentId: 'rescue-child',
    activationProof: reactivateActivationProof, now: new Date(now.getTime() + 30 * 60_000) }),
  { code: 'RESCUE_PREPARATION_EXPIRED' });
});

test('activation codecs reject unknown keys, invalid digests, and illegal cross-field shapes', async () => {
  const { store, workspaceA } = await storeFixture();
  const base = { sessionId: 'parent', workspace: workspaceA, permissionMode: 'workspace-write',
    recordedPrompt: '$zcode:rescue activate', envelope: validEnvelope };
  const invalid = [
    null,
    { ...spawnActivation, unknown: true },
    { ...spawnActivation, agentPathDigest: 'A'.repeat(64) },
    { ...spawnActivation, executorAgentId: 'forbidden' },
    { ...reactivateActivation, taskName: 'forbidden' },
    { kind: 'reactivate', executorAgentId: '', agentPathDigest: 'b'.repeat(64) },
  ];
  for (const [index, activation] of invalid.entries()) {
    await assert.rejects(store.save({ ...base, turnId: `turn-${index}`, activation }), {
      code: 'RESCUE_PREPARATION_INVALID',
    });
  }
});

test('preparation store validates and invokes only its private save-lock seam', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zcode-rescue-prepared-seam-'));
  const dataRoot = join(root, 'plugin-data');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  assert.throws(() => createRescuePreparationStore({
    dataRoot, testOnlyBeforeSaveLockOpen: /** @type {any} */ (true),
  }), { code: 'RESCUE_PREPARATION_INVALID' });
  let calls = 0;
  const store = createRescuePreparationStore({
    dataRoot,
    testOnlyBeforeSaveLockOpen: async () => { calls += 1; },
  });
  await store.save({
    sessionId: 'parent', turnId: 'turn-a', workspace,
    permissionMode: 'default', recordedPrompt: 'proactive',
    envelope: { ...validEnvelope, source: 'proactive' },
  });
  assert.equal(calls, 1);

  const sentinel = 'PRIVATE_SAVE_LOCK_SEAM_SENTINEL';
  const throwing = createRescuePreparationStore({
    dataRoot,
    testOnlyBeforeSaveLockOpen: async () => { throw new Error(sentinel); },
  });
  await assert.rejects(throwing.save({
    sessionId: 'parent', turnId: 'turn-b', workspace,
    permissionMode: 'default', recordedPrompt: 'proactive',
    envelope: { ...validEnvelope, source: 'proactive' },
  }), (/** @type {any} */ error) => {
    assert.doesNotMatch(errorChainText(error), new RegExp(sentinel));
    return true;
  });
});

/** @param {string} sessionId @param {string} turnId @param {string} workspace */
function preparedKey(sessionId, turnId, workspace) {
  return createHash('sha256').update(JSON.stringify([sessionId, turnId, workspace, 'rescue'])).digest('hex');
}

/** @param {string} dataRoot @param {string} workspace */
async function preparedDirectory(dataRoot, workspace) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  return { storage, directory: join(storage.directory, 'invocations', 'prepared') };
}

/** @param {string} dataRoot @param {string} workspace @param {string} sessionId @param {string} turnId */
async function preparedPath(dataRoot, workspace, sessionId, turnId) {
  const { storage, directory } = await preparedDirectory(dataRoot, workspace);
  return join(directory, `${preparedKey(sessionId, turnId, storage.workspacePath)}.json`);
}

test('prepared store binds an exact turn and atomically retains a consumed executor tombstone', async () => {
  const { dataRoot, store, workspaceA } = await storeFixture();
  const now = new Date('2026-08-17T00:00:00.000Z');
  await store.save({
    sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'workspace-write', recordedPrompt: '$zcode:rescue develop feature',
    envelope: validEnvelope, now,
  });
  const consumed = await store.consume({
    sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'workspace-write', executorAgentId: 'rescue-child', now,
  });
  assert.deepEqual(consumed.envelope, validEnvelope);
  assert.equal(consumed.executorAgentId, 'rescue-child');
  assert.equal(consumed.consumedAt, now.toISOString());

  await assert.rejects(store.consume({
    sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'workspace-write', executorAgentId: 'rescue-child', now,
  }), { code: 'RESCUE_PREPARATION_CONSUMED' });

  const { storage, directory } = await preparedDirectory(dataRoot, workspaceA);
  const path = join(directory, `${preparedKey('parent', 'turn-a', storage.workspacePath)}.json`);
  const record = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(record.consumedAt, now.toISOString());
  assert.equal(record.executorAgentId, 'rescue-child');
  assert.equal(record.version, 2);
  assert.equal(record.generation, 1);
  assert.equal(record.requiredExecutorAgentId, null);
  assert.deepEqual(Object.keys(record).sort(), [
    'consumedAt', 'createdAt', 'envelope', 'executorAgentId', 'expiresAt', 'key',
    'generation', 'permissionMode', 'requiredExecutorAgentId', 'sessionId', 'source',
    'turnId', 'version', 'workspace',
  ].sort());
});

test('consumed preparation advances through proactive resume generations bound to one executor', async () => {
  const { store, workspaceA } = await storeFixture();
  const base = {
    sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'workspace-write', recordedPrompt: '$zcode:rescue initial',
  };
  await store.save({ ...base, envelope: validEnvelope });
  const first = await store.consume({ ...base, executorAgentId: 'rescue-child' });
  assert.equal(first.generation, 1);
  for (let generation = 2; generation <= 4; generation += 1) {
    await store.save({
      ...base,
      envelope: {
        version: 1, source: 'proactive', task: `continue generation ${generation}`,
        options: { execution: 'foreground', resume: 'resume' },
      },
    });
    await assert.rejects(store.consume({ ...base, executorAgentId: 'sibling-child' }), {
      code: 'RESCUE_PREPARATION_MISMATCH',
    });
    const current = await store.consume({ ...base, executorAgentId: 'rescue-child' });
    assert.equal(current.generation, generation);
    assert.equal(current.requiredExecutorAgentId, 'rescue-child');
    assert.equal(current.activation, null);
  }
  await assert.rejects(store.consume({ ...base, executorAgentId: 'rescue-child' }), {
    code: 'RESCUE_PREPARATION_CONSUMED',
  });
});

test('consumed expired generation produces one exact-bound proactive resume successor with a fresh TTL', async () => {
  const { store, workspaceA } = await storeFixture();
  const createdAt = new Date('2026-08-17T00:00:00.000Z'); const resumedAt = new Date(createdAt.getTime() + 61 * 60_000);
  const base = { sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'workspace-write', recordedPrompt: '$zcode:rescue initial' };
  await store.save({ ...base, envelope: validEnvelope, now: createdAt });
  await store.consume({ ...base, executorAgentId: 'rescue-child', now: new Date(createdAt.getTime() + 1_000) });
  const replacement = { ...base, now: resumedAt,
    envelope: { version: 1, source: 'proactive', task: 'continue after long work', options: { resume: 'resume' } } };
  const results = await Promise.allSettled(Array.from({ length: 16 }, () => store.save(replacement)));
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 15);
  await assert.rejects(store.consume({ ...base, executorAgentId: 'sibling', now: resumedAt }), { code: 'RESCUE_PREPARATION_MISMATCH' });
  const second = await store.consume({ ...base, executorAgentId: 'rescue-child', now: resumedAt });
  assert.equal(second.generation, 2); assert.equal(second.requiredExecutorAgentId, 'rescue-child');
  assert.equal(second.createdAt, resumedAt.toISOString());
  assert.equal(Date.parse(second.expiresAt) - Date.parse(second.createdAt), 30 * 60_000);
});

test('expired unconsumed generation cannot be replaced by proactive resume', async () => {
  const { dataRoot, store, workspaceA } = await storeFixture(); const now = new Date('2026-08-17T00:00:00.000Z');
  const base = { sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'workspace-write', recordedPrompt: '$zcode:rescue initial' };
  await store.save({ ...base, envelope: validEnvelope, now });
  const path = await preparedPath(dataRoot, workspaceA, 'parent', 'turn-a'); const before = await readFile(path);
  await assert.rejects(store.save({ ...base, now: new Date(now.getTime() + 61 * 60_000),
    envelope: { version: 1, source: 'proactive', task: 'unauthorized replacement', options: { resume: 'resume' } } }),
  { code: 'RESCUE_PREPARATION_EXISTS' });
  assert.deepEqual(await readFile(path), before);
});

test('strict consumed legacy v1 preparation upgrades once to generation 2', async () => {
  const { dataRoot, store, workspaceA } = await storeFixture();
  const now = new Date('2026-08-17T00:00:00.000Z');
  const base = {
    sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'workspace-write', recordedPrompt: '$zcode:rescue initial', now,
  };
  await store.save({ ...base, envelope: validEnvelope });
  await store.consume({ ...base, executorAgentId: 'rescue-child' });
  const path = await preparedPath(dataRoot, workspaceA, 'parent', 'turn-a');
  const legacy = JSON.parse(await readFile(path, 'utf8'));
  legacy.version = 1;
  delete legacy.activation;
  delete legacy.generation;
  delete legacy.requiredExecutorAgentId;
  await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`);

  await store.save({
    ...base, now: new Date(now.getTime() + 1),
    envelope: { version: 1, source: 'proactive', task: 'continue', options: { resume: 'resume' } },
  });
  const upgraded = await store.consume({
    ...base, executorAgentId: 'rescue-child', now: new Date(now.getTime() + 1),
  });
  assert.equal(upgraded.version, 3);
  assert.equal(upgraded.generation, 2);
  assert.equal(upgraded.requiredExecutorAgentId, 'rescue-child');
  assert.equal(upgraded.activation, null);
});

test('strict unconsumed legacy v1 preparation remains create-only and consumable once', async () => {
  const { dataRoot, store, workspaceA } = await storeFixture();
  const base = {
    sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'workspace-write', recordedPrompt: '$zcode:rescue initial',
  };
  await store.save({ ...base, envelope: validEnvelope });
  const path = await preparedPath(dataRoot, workspaceA, 'parent', 'turn-a');
  const legacy = JSON.parse(await readFile(path, 'utf8'));
  legacy.version = 1;
  delete legacy.activation;
  delete legacy.generation;
  delete legacy.requiredExecutorAgentId;
  await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`);
  const before = await readFile(path);
  await assert.rejects(store.save({
    ...base,
    envelope: { version: 1, source: 'proactive', task: 'continue', options: { resume: 'resume' } },
  }), { code: 'RESCUE_PREPARATION_EXISTS' });
  assert.deepEqual(await readFile(path), before);
  const consumed = await store.consume({ ...base, executorAgentId: 'rescue-child' });
  assert.equal(consumed.version, 1);
  assert.equal(consumed.generation, undefined);
  await assert.rejects(store.consume({ ...base, executorAgentId: 'rescue-child' }), {
    code: 'RESCUE_PREPARATION_CONSUMED',
  });
});

test('unconsumed preparation cannot be overwritten and retains exact bytes', async () => {
  const { dataRoot, store, workspaceA } = await storeFixture();
  const base = {
    sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'default', recordedPrompt: 'proactive',
    envelope: { ...validEnvelope, source: 'proactive', options: { resume: 'resume' } },
  };
  await store.save(base);
  const path = await preparedPath(dataRoot, workspaceA, 'parent', 'turn-a');
  const before = await readFile(path);
  await assert.rejects(store.save(base), { code: 'RESCUE_PREPARATION_EXISTS' });
  assert.deepEqual(await readFile(path), before);
});

test('v2 records reject generation and required executor cross-field mismatches', async (t) => {
  /** @type {Array<[string, number, string|null]>} */
  const variants = [
    ['first generation with executor', 1, 'rescue-child'],
    ['later generation without executor', 2, null],
  ];
  for (const [name, generation, requiredExecutorAgentId] of variants) await t.test(name, async () => {
    const { dataRoot, store, workspaceA } = await storeFixture();
    const base = {
      sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
      permissionMode: 'workspace-write', recordedPrompt: '$zcode:rescue initial',
    };
    await store.save({ ...base, envelope: validEnvelope, activation: spawnActivation });
    const path = await preparedPath(dataRoot, workspaceA, 'parent', 'turn-a');
    const record = JSON.parse(await readFile(path, 'utf8'));
    record.version = 2;
    delete record.activation;
    record.generation = generation;
    record.requiredExecutorAgentId = requiredExecutorAgentId;
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
    const before = await readFile(path);
    await assert.rejects(store.consume({ ...base, executorAgentId: 'rescue-child' }), {
      code: 'RESCUE_PREPARATION_RECORD_INVALID',
    });
    assert.deepEqual(await readFile(path), before);
  });
});

test('v2 generation two rejects a sibling executor without mutating the preparation', async () => {
  const { dataRoot, store, workspaceA } = await storeFixture();
  const base = { sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'workspace-write', recordedPrompt: '$zcode:rescue initial' };
  await store.save({ ...base, envelope: validEnvelope });
  const path = await preparedPath(dataRoot, workspaceA, 'parent', 'turn-a');
  const record = JSON.parse(await readFile(path, 'utf8'));
  record.generation = 2;
  record.requiredExecutorAgentId = 'rescue-owner';
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  const before = await readFile(path);
  await assert.rejects(store.consume({ ...base, executorAgentId: 'sibling-child' }), {
    code: 'RESCUE_PREPARATION_MISMATCH',
  });
  assert.deepEqual(await readFile(path), before);
});

test('v3 records reject generation and activation cross-field mismatches', async (t) => {
  /** @type {Array<[string, (record:any)=>void]>} */
  const variants = [
    ['first generation with required executor', (record) => { record.requiredExecutorAgentId = 'child'; }],
    ['later generation with activation', (record) => {
      record.generation = 2;
      record.requiredExecutorAgentId = 'child';
    }],
  ];
  for (const [name, mutate] of variants) await t.test(name, async () => {
    const { dataRoot, store, workspaceA } = await storeFixture();
    const base = { sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
      permissionMode: 'workspace-write', recordedPrompt: '$zcode:rescue initial' };
    await store.save({ ...base, envelope: validEnvelope, activation: spawnActivation });
    const path = await preparedPath(dataRoot, workspaceA, 'parent', 'turn-a');
    const record = JSON.parse(await readFile(path, 'utf8'));
    mutate(record);
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
    const before = await readFile(path);
    await assert.rejects(store.consume({ ...base, executorAgentId: 'child' }), {
      code: 'RESCUE_PREPARATION_RECORD_INVALID',
    });
    assert.deepEqual(await readFile(path), before);
  });
});

test('consumed v3 reactivation rejects an executor that differs from its activation', async () => {
  const { dataRoot, store, workspaceA } = await storeFixture();
  const now = new Date('2026-08-17T00:00:00.000Z');
  const base = { sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'workspace-write', recordedPrompt: '$zcode:rescue initial', now };
  await store.save({ ...base, envelope: validEnvelope, activation: reactivateActivation });
  await store.consume({ ...base, executorAgentId: 'rescue-child', activationProof: reactivateActivationProof });
  const path = await preparedPath(dataRoot, workspaceA, 'parent', 'turn-a');
  const record = JSON.parse(await readFile(path, 'utf8'));
  record.executorAgentId = 'sibling-child';
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  const before = await readFile(path);
  await assert.rejects(store.save({
    ...base, now: new Date(now.getTime() + 1),
    envelope: { version: 1, source: 'proactive', task: 'continue', options: { resume: 'resume' } },
  }), { code: 'RESCUE_PREPARATION_RECORD_INVALID' });
  assert.deepEqual(await readFile(path), before);
});

test('strict v2 records remain consumable and consumed replacement upgrades to v3 generation two', async (t) => {
  await t.test('unconsumed v2', async () => {
    const { dataRoot, store, workspaceA } = await storeFixture();
    const base = { sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
      permissionMode: 'workspace-write', recordedPrompt: '$zcode:rescue initial' };
    await store.save({ ...base, envelope: validEnvelope });
    const path = await preparedPath(dataRoot, workspaceA, 'parent', 'turn-a');
    const v2 = JSON.parse(await readFile(path, 'utf8'));
    v2.version = 2;
    delete v2.activation;
    await writeFile(path, `${JSON.stringify(v2, null, 2)}\n`);
    const consumed = await store.consume({ ...base, executorAgentId: 'rescue-child' });
    assert.equal(consumed.version, 2);
    assert.equal(consumed.generation, 1);
  });

  await t.test('consumed v2 replacement', async () => {
    const { dataRoot, store, workspaceA } = await storeFixture();
    const now = new Date('2026-08-17T00:00:00.000Z');
    const base = { sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
      permissionMode: 'workspace-write', recordedPrompt: '$zcode:rescue initial', now };
    await store.save({ ...base, envelope: validEnvelope });
    await store.consume({ ...base, executorAgentId: 'rescue-child' });
    const path = await preparedPath(dataRoot, workspaceA, 'parent', 'turn-a');
    const v2 = JSON.parse(await readFile(path, 'utf8'));
    v2.version = 2;
    delete v2.activation;
    await writeFile(path, `${JSON.stringify(v2, null, 2)}\n`);
    const resumedAt = new Date(now.getTime() + 1);
    await store.save({ ...base, now: resumedAt,
      envelope: { version: 1, source: 'proactive', task: 'continue', options: { resume: 'resume' } } });
    const replacement = await store.consume({ ...base, executorAgentId: 'rescue-child', now: resumedAt });
    assert.equal(replacement.version, 3);
    assert.equal(replacement.generation, 2);
    assert.equal(replacement.activation, null);
    assert.equal(replacement.requiredExecutorAgentId, 'rescue-child');
  });
});

test('consumed preparation replacement rejects unauthorized or invalid prior state without mutation', async (t) => {
  /** @type {Array<[string, (record:any, save:any, now:Date)=>{record?:any, save?:any}]>} */
  const variants = [
    ['explicit replacement', (record, save) => ({ save: { ...save, envelope: { ...save.envelope, source: 'explicit' } } })],
    ['fresh replacement', (record, save) => ({
      save: { ...save, envelope: { ...save.envelope, options: { resume: 'fresh' } } },
    })],
    ['changed permission', (record, save) => ({ save: { ...save, permissionMode: 'read-only' } })],
    ['changed turn', (record, save) => ({ save: { ...save, turnId: 'turn-b' } })],
    ['clock before creation', (record, save, now) => ({ save: { ...save, now: new Date(now.getTime() - 1) } })],
    ['missing executor', (record) => { record.executorAgentId = ''; return { record }; }],
    ['oversized executor', (record) => { record.executorAgentId = 'x'.repeat(513); return { record }; }],
    ['generation overflow', (record) => { record.generation = Number.MAX_SAFE_INTEGER; return { record }; }],
    ['unknown field', (record) => { record.unknown = true; return { record }; }],
    ['mixed v1/v2', (record) => { record.version = 1; return { record }; }],
  ];
  for (const [name, mutate] of variants) await t.test(name, async () => {
    const { dataRoot, store, workspaceA } = await storeFixture();
    const now = new Date('2026-08-17T00:00:00.000Z');
    const base = {
      sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
      permissionMode: 'workspace-write', recordedPrompt: '$zcode:rescue initial', now,
    };
    await store.save({ ...base, envelope: validEnvelope });
    await store.consume({ ...base, executorAgentId: 'rescue-child' });
    const path = await preparedPath(dataRoot, workspaceA, 'parent', 'turn-a');
    let record = JSON.parse(await readFile(path, 'utf8'));
    let save = {
      ...base,
      envelope: { version: 1, source: 'proactive', task: 'continue', options: { resume: 'resume' } },
    };
    ({ record = record, save = save } = mutate(record, save, now));
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
    const before = await readFile(path);
    await assert.rejects(store.save(save), (/** @type {any} */ error) => {
      assert.doesNotMatch(errorChainText(error), /parent|turn-a|rescue-child/u);
      return /^RESCUE_PREPARATION_/u.test(error.code);
    });
    assert.deepEqual(await readFile(path), before);
  });
});

test('16-way concurrent consumed replacement permits exactly one new generation', async () => {
  const { store, workspaceA } = await storeFixture();
  const base = {
    sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'workspace-write', recordedPrompt: '$zcode:rescue initial',
  };
  await store.save({ ...base, envelope: validEnvelope });
  await store.consume({ ...base, executorAgentId: 'rescue-child' });
  const replacement = {
    ...base,
    envelope: { version: 1, source: 'proactive', task: 'continue', options: { resume: 'resume' } },
  };
  const results = await Promise.allSettled(Array.from({ length: 16 }, () => store.save(replacement)));
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 15);
  const second = await store.consume({ ...base, executorAgentId: 'rescue-child' });
  assert.equal(second.generation, 2);
});

test('replacement takes a fresh TTL from lock-linearized time after prior expiry', async () => {
  const { dataRoot, store, workspaceA } = await storeFixture();
  const createdAt = new Date('2026-08-17T00:00:00.000Z');
  const expiresAt = createdAt.getTime() + 30 * 60_000;
  const base = {
    sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'workspace-write', recordedPrompt: '$zcode:rescue initial',
  };
  await store.save({ ...base, envelope: validEnvelope, now: createdAt });
  await store.consume({ ...base, executorAgentId: 'rescue-child', now: createdAt });
  const path = await preparedPath(dataRoot, workspaceA, 'parent', 'turn-a');
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace: workspaceA });
  /** @type {()=>void} */
  let signalLockOpen = () => {};
  /** @type {Promise<void>} */
  const lockOpen = new Promise((resolve) => { signalLockOpen = resolve; });
  const contendedStore = createRescuePreparationStore({
    dataRoot,
    testOnlyBeforeSaveLockOpen: async () => { signalLockOpen(); },
  });
  const originalNow = Date.now;
  let clock = expiresAt - 1;
  Date.now = () => clock;
  try {
    /** @type {Promise<void>|undefined} */
    let pending;
    await withFileLock(join(storage.directory, '.rescue-preparation-lock'), async () => {
      pending = contendedStore.save({
        ...base,
        envelope: { version: 1, source: 'proactive', task: 'continue', options: { resume: 'resume' } },
      });
      await lockOpen;
      clock = expiresAt;
    });
    await /** @type {Promise<void>} */ (pending);
  } finally {
    Date.now = originalNow;
  }
  const replacement = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(replacement.generation, 2); assert.equal(replacement.createdAt, new Date(expiresAt).toISOString());
  assert.equal(Date.parse(replacement.expiresAt) - Date.parse(replacement.createdAt), 30 * 60_000);
});

test('cleanupTurn removes the current v2 generation slot', async () => {
  const { dataRoot, store, workspaceA } = await storeFixture();
  const base = {
    sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'default', recordedPrompt: 'proactive',
  };
  await store.save({
    ...base, envelope: { ...validEnvelope, source: 'proactive', options: { resume: 'resume' } },
  });
  await store.consume({ ...base, executorAgentId: 'child' });
  await store.save({
    ...base, envelope: { ...validEnvelope, source: 'proactive', options: { resume: 'resume' } },
  });
  await store.cleanupTurn(base);
  await assert.rejects(access(await preparedPath(dataRoot, workspaceA, 'parent', 'turn-a')), {
    code: 'ENOENT',
  });
});

test('all cleanup APIs accept strict legacy v1 slots', async () => {
  const { dataRoot, store, workspaceA } = await storeFixture();
  /** @param {string} sessionId @param {string} turnId */
  const save = (sessionId, turnId) => store.save({
    sessionId, turnId, workspace: workspaceA, permissionMode: 'default', recordedPrompt: 'proactive',
    envelope: { ...validEnvelope, source: 'proactive' },
  });
  await save('session-a', 'old');
  await save('session-a', 'current');
  await save('session-b', 'sibling');
  for (const [sessionId, turnId] of [
    ['session-a', 'old'], ['session-a', 'current'], ['session-b', 'sibling'],
  ]) {
    const path = await preparedPath(dataRoot, workspaceA, sessionId, turnId);
    const legacy = JSON.parse(await readFile(path, 'utf8'));
    legacy.version = 1;
    delete legacy.activation;
    delete legacy.generation;
    delete legacy.requiredExecutorAgentId;
    await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`);
  }
  await store.cleanupOlderTurns({ sessionId: 'session-a', turnId: 'current', workspace: workspaceA });
  await assert.rejects(access(await preparedPath(dataRoot, workspaceA, 'session-a', 'old')), { code: 'ENOENT' });
  await store.cleanupTurn({ sessionId: 'session-a', turnId: 'current', workspace: workspaceA });
  await assert.rejects(access(await preparedPath(dataRoot, workspaceA, 'session-a', 'current')), { code: 'ENOENT' });
  await store.cleanupSession({ sessionId: 'session-b', workspace: workspaceA });
  await assert.rejects(access(await preparedPath(dataRoot, workspaceA, 'session-b', 'sibling')), { code: 'ENOENT' });
});

test('prepared save is create-only and cross-checks source against the recorded marker', async () => {
  const { store, workspaceA } = await storeFixture();
  const common = {
    sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'workspace-write', recordedPrompt: '$zcode:rescue develop feature',
    envelope: validEnvelope,
  };
  await store.save(common);
  await assert.rejects(store.save(common), { code: 'RESCUE_PREPARATION_EXISTS' });
  await assert.rejects(store.save({ ...common, turnId: 'turn-b', recordedPrompt: 'develop feature' }), {
    code: 'RESCUE_PREPARATION_SOURCE_MISMATCH',
  });
  await assert.rejects(store.save({
    ...common,
    turnId: 'turn-c',
    envelope: { ...validEnvelope, source: 'proactive' },
  }), { code: 'RESCUE_PREPARATION_SOURCE_MISMATCH' });
});

test('prepared storage rejects invocations and prepared directory symlink escapes', async () => {
  for (const target of ['invocations', 'prepared']) {
    const { dataRoot, root, store, workspaceA } = await storeFixture();
    const storage = await resolveWorkspaceStorage({ dataRoot, workspace: workspaceA });
    const outside = join(root, `outside-${target}`);
    await mkdir(outside);
    const invocations = join(storage.directory, 'invocations');
    if (target === 'prepared') await mkdir(invocations);
    await symlink(outside, target === 'invocations' ? invocations : join(invocations, 'prepared'), 'dir');
    await assert.rejects(store.save({
      sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA,
      permissionMode: 'default', recordedPrompt: 'proactive',
      envelope: { ...validEnvelope, source: 'proactive' },
    }), (/** @type {any} */ error) => {
      assert.notEqual(error.code, 'RESCUE_PREPARATION_SCAN_LIMIT');
      assert.doesNotMatch(errorChainText(error), /implement the approved specification/u);
      return true;
    });
    assert.deepEqual(await readdir(outside), []);
  }
});

test('prepared cleanup rejects directory replacement while waiting for its workspace-root lock', async () => {
  const { dataRoot, root, store, workspaceA } = await storeFixture();
  await store.save({
    sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'default', recordedPrompt: 'proactive',
    envelope: { ...validEnvelope, source: 'proactive' },
  });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace: workspaceA });
  const prepared = join(storage.directory, 'invocations', 'prepared');
  const displaced = join(root, 'displaced-prepared');
  const lockPath = join(storage.directory, '.rescue-preparation-lock');
  /** @type {Promise<void>|undefined} */
  let cleanup;
  await withFileLock(lockPath, async () => {
    cleanup = store.cleanupSession({ sessionId: 'session-a', workspace: workspaceA });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rename(prepared, displaced);
    await mkdir(prepared);
  });
  await assert.rejects(/** @type {Promise<void>} */ (cleanup));
  assert.equal((await readdir(displaced)).filter((name) => name.endsWith('.json')).length, 1);
  assert.deepEqual(await readdir(prepared), []);
});

test('save rejects replacement of the workspace-root lock while waiting', {
  skip: process.platform === 'win32'
    ? 'Windows forbids renaming the lock directory while its advisory lock file is open'
    : false,
}, async () => {
  const { dataRoot, root, store, workspaceA } = await storeFixture();
  await store.save({
    sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'default', recordedPrompt: 'proactive',
    envelope: { ...validEnvelope, source: 'proactive' },
  });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace: workspaceA });
  const lockPath = join(storage.directory, '.rescue-preparation-lock');
  const displacedLock = join(root, 'displaced-lock');
  /** @type {Promise<void>|undefined} */
  let secondSave;
  await withFileLock(lockPath, async () => {
    secondSave = store.save({
      sessionId: 'session-a', turnId: 'turn-b', workspace: workspaceA,
      permissionMode: 'default', recordedPrompt: 'proactive',
      envelope: { ...validEnvelope, source: 'proactive' },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rename(lockPath, displacedLock);
    await withFileLock(lockPath, async () => {});
  });
  await assert.rejects(/** @type {Promise<void>} */ (secondSave));
  const { directory } = await preparedDirectory(dataRoot, workspaceA);
  assert.equal((await readdir(directory)).filter((name) => name.endsWith('.json')).length, 1);
});

test('prepared consume rejects expiry, permission and executor mismatch without exposing task text', async () => {
  const { store, workspaceA } = await storeFixture();
  const task = 'PRIVATE_TASK_SENTINEL_NEVER_ECHO';
  const now = new Date('2026-08-17T00:00:00.000Z');
  await store.save({
    sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'workspace-write', recordedPrompt: '$zcode:rescue',
    envelope: { ...validEnvelope, task }, now,
  });
  for (const inputValue of [
    { sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA, permissionMode: 'read-only', executorAgentId: 'rescue-child', now },
    { sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA, permissionMode: 'workspace-write', executorAgentId: '', now },
    { sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA, permissionMode: 'workspace-write', executorAgentId: 'rescue-child', now: new Date(now.getTime() + 30 * 60_000) },
  ]) {
    await assert.rejects(store.consume(inputValue), (/** @type {any} */ error) => {
      assert.doesNotMatch(`${error.message}\n${error.remedy}\n${JSON.stringify(error.details)}`, new RegExp(task));
      return /^RESCUE_PREPARATION_/u.test(error.code);
    });
  }
});

test('prepared consume rejects a clock earlier than record creation', async () => {
  const { store, workspaceA } = await storeFixture();
  const createdAt = new Date('2026-08-17T00:00:00.000Z');
  await store.save({
    sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'default', recordedPrompt: 'proactive',
    envelope: { ...validEnvelope, source: 'proactive' }, now: createdAt,
  });
  await assert.rejects(store.consume({
    sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'default', executorAgentId: 'child',
    now: new Date(createdAt.getTime() - 1),
  }), { code: 'RESCUE_PREPARATION_INVALID' });
});

test('prepared records cannot cross session, turn, canonical workspace, permission, or consumed executor', async () => {
  const { store, workspaceA, workspaceB } = await storeFixture();
  const now = new Date('2026-08-17T00:00:00.000Z');
  const expected = {
    sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'workspace-write', executorAgentId: 'rescue-child', now,
  };
  await store.save({
    sessionId: expected.sessionId, turnId: expected.turnId, workspace: expected.workspace,
    permissionMode: expected.permissionMode, recordedPrompt: '$zcode:rescue task',
    envelope: validEnvelope, now,
  });
  for (const changed of [
    { sessionId: 'sibling-session' },
    { turnId: 'turn-b' },
    { workspace: workspaceB },
  ]) {
    await assert.rejects(store.consume({ ...expected, ...changed }), { code: 'RESCUE_PREPARATION_NOT_FOUND' });
  }
  await assert.rejects(store.consume({ ...expected, permissionMode: 'read-only' }), {
    code: 'RESCUE_PREPARATION_MISMATCH',
  });
  await store.consume(expected);
  await assert.rejects(store.consume({ ...expected, executorAgentId: 'sibling-child' }), {
    code: 'RESCUE_PREPARATION_MISMATCH',
  });
});

test('prepared cleanup methods remove only their exact session, workspace, and turn scope', async () => {
  const { dataRoot, store, workspaceA, workspaceB } = await storeFixture();
  /** @param {string} sessionId @param {string} turnId @param {string} workspace */
  const save = (sessionId, turnId, workspace) => store.save({
    sessionId, turnId, workspace, permissionMode: 'default', recordedPrompt: 'proactive work',
    envelope: { ...validEnvelope, source: 'proactive' },
  });
  await save('session-a', 'old', workspaceA);
  await save('session-a', 'current', workspaceA);
  await save('session-b', 'sibling', workspaceA);
  await save('session-a', 'other-workspace', workspaceB);

  await store.cleanupOlderTurns({ sessionId: 'session-a', turnId: 'current', workspace: workspaceA });
  await assert.rejects(store.consume({ sessionId: 'session-a', turnId: 'old', workspace: workspaceA, permissionMode: 'default', executorAgentId: 'child' }), { code: 'RESCUE_PREPARATION_NOT_FOUND' });
  await store.cleanupTurn({ sessionId: 'session-a', turnId: 'current', workspace: workspaceA });
  await store.cleanupSession({ sessionId: 'session-b', workspace: workspaceA });
  const { directory } = await preparedDirectory(dataRoot, workspaceA);
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.json')), []);
  await store.consume({ sessionId: 'session-a', turnId: 'other-workspace', workspace: workspaceB, permissionMode: 'default', executorAgentId: 'child' });
});

test('broad cleanup skips corrupt sibling ownership while cleaning valid records for its session', async () => {
  const { dataRoot, store, workspaceA } = await storeFixture();
  /** @param {string} sessionId @param {string} turnId */
  const save = (sessionId, turnId) => store.save({
    sessionId, turnId, workspace: workspaceA, permissionMode: 'default',
    recordedPrompt: 'proactive work', envelope: { ...validEnvelope, source: 'proactive' },
  });
  await save('session-a', 'old');
  await save('session-a', 'current');
  await save('session-b', 'sibling');
  const { storage, directory } = await preparedDirectory(dataRoot, workspaceA);
  const siblingPath = join(directory, `${preparedKey('session-b', 'sibling', storage.workspacePath)}.json`);
  const corruptSibling = Buffer.from('{"sessionId":"session-b","task":"SIBLING_BYTES"');
  await writeFile(siblingPath, corruptSibling);

  await store.cleanupOlderTurns({ sessionId: 'session-a', turnId: 'current', workspace: workspaceA });
  await assert.rejects(store.consume({
    sessionId: 'session-a', turnId: 'old', workspace: workspaceA,
    permissionMode: 'default', executorAgentId: 'child',
  }), { code: 'RESCUE_PREPARATION_NOT_FOUND' });
  assert.deepEqual(await readFile(siblingPath), corruptSibling);

  await store.cleanupSession({ sessionId: 'session-a', workspace: workspaceA });
  await assert.rejects(store.consume({
    sessionId: 'session-a', turnId: 'current', workspace: workspaceA,
    permissionMode: 'default', executorAgentId: 'child',
  }), { code: 'RESCUE_PREPARATION_NOT_FOUND' });
  assert.deepEqual(await readFile(siblingPath), corruptSibling);
});

test('exact cleanupTurn fails closed for its corrupt key without changing the record', async () => {
  const { dataRoot, store, workspaceA } = await storeFixture();
  await store.save({
    sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'default', recordedPrompt: 'proactive work',
    envelope: { ...validEnvelope, source: 'proactive' },
  });
  const { storage, directory } = await preparedDirectory(dataRoot, workspaceA);
  const path = join(directory, `${preparedKey('session-a', 'turn-a', storage.workspacePath)}.json`);
  const corrupt = Buffer.from('{broken exact record');
  await writeFile(path, corrupt);
  await assert.rejects(
    store.cleanupTurn({ sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA }),
    { code: 'RESCUE_PREPARATION_RECORD_INVALID' },
  );
  assert.deepEqual(await readFile(path), corrupt);
});

test('excessive prepared scans fail closed without deleting records', async () => {
  const { dataRoot, store, workspaceA } = await storeFixture();
  /** @param {string} turnId */
  const save = (turnId) => store.save({
    sessionId: 'session-a', turnId, workspace: workspaceA, permissionMode: 'default',
    recordedPrompt: 'proactive work', envelope: { ...validEnvelope, source: 'proactive' },
  });
  await save('healthy');
  const { directory } = await preparedDirectory(dataRoot, workspaceA);
  await Promise.all(Array.from({ length: 1025 }, (_, index) => writeFile(
    join(directory, `${String(index).padStart(64, '0')}.json`), '{}\n',
  )));
  await assert.rejects(store.cleanupOlderTurns({ sessionId: 'session-a', turnId: 'healthy', workspace: workspaceA }), {
    code: 'RESCUE_PREPARATION_SCAN_LIMIT',
  });
  await store.consume({ sessionId: 'session-a', turnId: 'healthy', workspace: workspaceA, permissionMode: 'default', executorAgentId: 'child' });
});

test('prepared save refuses to exceed the record-count bound', async () => {
  const { dataRoot, store, workspaceA } = await storeFixture();
  const { directory } = await preparedDirectory(dataRoot, workspaceA);
  await mkdir(directory, { recursive: true });
  await Promise.all(Array.from({ length: 1024 }, (_, index) => writeFile(
    join(directory, `${String(index).padStart(64, '0')}.json`), '{}\n',
  )));
  await assert.rejects(store.save({
    sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'default', recordedPrompt: 'proactive work',
    envelope: { ...validEnvelope, source: 'proactive' },
  }), { code: 'RESCUE_PREPARATION_SCAN_LIMIT' });
});

test('corrupt record and stdin causes never retain task text', async () => {
  const { dataRoot, store, workspaceA } = await storeFixture();
  const sentinel = 'PRIVATE_TASK_CAUSE_SENTINEL';
  await store.save({
    sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'default', recordedPrompt: 'proactive work',
    envelope: { ...validEnvelope, source: 'proactive' },
  });
  const { storage, directory } = await preparedDirectory(dataRoot, workspaceA);
  const path = join(directory, `${preparedKey('session-a', 'turn-a', storage.workspacePath)}.json`);
  await writeFile(path, `{${sentinel}`);
  await assert.rejects(store.cleanupTurn({
    sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA,
  }), (/** @type {any} */ error) => {
    assert.doesNotMatch(errorChainText(error), new RegExp(sentinel));
    return error.code === 'RESCUE_PREPARATION_RECORD_INVALID';
  });

  const brokenStream = Readable.from((async function* broken() {
    yield Buffer.from(`${JSON.stringify(validEnvelope)}\n`);
    throw new Error(sentinel);
  }()));
  await assert.rejects(readRescuePreparation(brokenStream), (/** @type {any} */ error) => {
    assert.doesNotMatch(errorChainText(error), new RegExp(sentinel));
    return error.code === 'RESCUE_PREPARATION_INVALID';
  });
});

test('persisted records reject malformed UTF-8 without replacement decoding', async () => {
  const { dataRoot, store, workspaceA } = await storeFixture();
  await store.save({
    sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'default', recordedPrompt: 'proactive',
    envelope: { ...validEnvelope, source: 'proactive' },
  });
  const { directory } = await preparedDirectory(dataRoot, workspaceA);
  const [name] = (await readdir(directory)).filter((entry) => entry.endsWith('.json'));
  const bytes = await readFile(join(directory, name));
  const taskOffset = bytes.indexOf(Buffer.from('implement'));
  bytes[taskOffset] = 0xc3;
  bytes[taskOffset + 1] = 0x28;
  await writeFile(join(directory, name), bytes);
  await assert.rejects(store.consume({
    sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'default', executorAgentId: 'child',
  }), { code: 'RESCUE_PREPARATION_RECORD_INVALID' });
});

test('persisted records reject duplicate object keys before JSON parsing', async () => {
  const { dataRoot, store, workspaceA } = await storeFixture();
  await store.save({
    sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'default', recordedPrompt: 'proactive',
    envelope: { ...validEnvelope, source: 'proactive' },
  });
  const { directory } = await preparedDirectory(dataRoot, workspaceA);
  const [name] = (await readdir(directory)).filter((entry) => entry.endsWith('.json'));
  const path = join(directory, name);
  const text = await readFile(path, 'utf8');
  await writeFile(path, text.replace('  "source": "proactive",', '  "source": "proactive",\n  "source": "proactive",'));
  await assert.rejects(store.consume({
    sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'default', executorAgentId: 'child',
  }), { code: 'RESCUE_PREPARATION_RECORD_INVALID' });
});

test('16-way concurrent save and consume each permit exactly one success', async () => {
  const { store, workspaceA } = await storeFixture();
  const saveInput = {
    sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'default', recordedPrompt: 'proactive',
    envelope: { ...validEnvelope, source: 'proactive' },
  };
  const saves = await Promise.allSettled(Array.from({ length: 16 }, () => store.save(saveInput)));
  assert.equal(saves.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(saves.filter(({ status }) => status === 'rejected').length, 15);

  const consumeInput = {
    sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'default', executorAgentId: 'child',
  };
  const consumes = await Promise.allSettled(Array.from({ length: 16 }, () => store.consume(consumeInput)));
  assert.equal(consumes.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(consumes.filter(({ status }) => status === 'rejected').length, 15);
});

test('aborting save during lock contention rejects quickly without committing the record', async () => {
  const { dataRoot, store, workspaceA } = await storeFixture();
  await store.cleanupTurn({ sessionId: 'session-a', turnId: 'bootstrap', workspace: workspaceA });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace: workspaceA });
  const lockPath = join(storage.directory, '.rescue-preparation-lock');
  const controller = new AbortController();
  const reason = new Error('cancel contended preparation');
  const saveInput = {
    sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'default', recordedPrompt: 'proactive work',
    envelope: { ...validEnvelope, source: 'proactive' }, signal: controller.signal,
  };
  await withFileLock(lockPath, async () => {
    const pending = store.save(saveInput);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const beforeAbort = await Promise.race([
      pending.then(() => 'settled', () => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 25)),
    ]);
    assert.equal(beforeAbort, 'pending', 'save must have entered lock contention');
    controller.abort(reason);
    const outcome = await Promise.race([
      pending.then(
        () => ({ status: 'fulfilled' }),
        (error) => ({ status: 'rejected', error }),
      ),
      new Promise((resolve) => setTimeout(() => resolve({ status: 'pending' }), 250)),
    ]);
    assert.deepEqual(outcome, { status: 'rejected', error: reason });
  });

  const { directory } = await preparedDirectory(dataRoot, workspaceA);
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.json')), []);
  await store.save({ ...saveInput, signal: undefined });
  await store.consume({
    sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'default', executorAgentId: 'child',
  });
});

test('prepared storage is private and shell-like task text remains inert data', { skip: process.platform === 'win32' }, async () => {
  const { dataRoot, root, store, workspaceA } = await storeFixture();
  const escaped = join(root, 'shell-side-effect');
  const task = `$(touch ${escaped}) ; touch ${escaped}`;
  await store.save({
    sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'workspace-write', recordedPrompt: '$zcode:rescue',
    envelope: { ...validEnvelope, task },
  });
  await assert.rejects(access(escaped), { code: 'ENOENT' });
  const { directory } = await preparedDirectory(dataRoot, workspaceA);
  const [name] = (await readdir(directory)).filter((entry) => entry.endsWith('.json'));
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
  assert.match(await readFile(join(directory, name), 'utf8'), /touch/u);
});
