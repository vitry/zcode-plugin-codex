import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { PluginError } from '../scripts/lib/errors.mjs';
import { withFileLock } from '../scripts/lib/fs.mjs';
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

/** @param {string} sessionId @param {string} turnId @param {string} workspace */
function preparedKey(sessionId, turnId, workspace) {
  return createHash('sha256').update(JSON.stringify([sessionId, turnId, workspace, 'rescue'])).digest('hex');
}

/** @param {string} dataRoot @param {string} workspace */
async function preparedDirectory(dataRoot, workspace) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  return { storage, directory: join(storage.directory, 'invocations', 'prepared') };
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
  assert.deepEqual(Object.keys(record).sort(), [
    'consumedAt', 'createdAt', 'envelope', 'executorAgentId', 'expiresAt', 'key',
    'permissionMode', 'sessionId', 'source', 'turnId', 'version', 'workspace',
  ].sort());
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

test('save rejects replacement of the workspace-root lock while waiting', async () => {
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
