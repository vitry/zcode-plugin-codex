import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

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

test('corrupt prepared state and excessive scans fail closed without deleting siblings', async () => {
  const { dataRoot, store, workspaceA } = await storeFixture();
  /** @param {string} turnId */
  const save = (turnId) => store.save({
    sessionId: 'session-a', turnId, workspace: workspaceA, permissionMode: 'default',
    recordedPrompt: 'proactive work', envelope: { ...validEnvelope, source: 'proactive' },
  });
  await save('healthy');
  const { directory } = await preparedDirectory(dataRoot, workspaceA);
  await writeFile(join(directory, `${'f'.repeat(64)}.json`), '{broken');
  await assert.rejects(store.cleanupSession({ sessionId: 'session-a', workspace: workspaceA }));
  await store.consume({ sessionId: 'session-a', turnId: 'healthy', workspace: workspaceA, permissionMode: 'default', executorAgentId: 'child' });

  await Promise.all(Array.from({ length: 1025 }, (_, index) => writeFile(
    join(directory, `${String(index).padStart(64, '0')}.json`), '{}\n',
  )));
  await assert.rejects(store.cleanupOlderTurns({ sessionId: 'session-a', turnId: 'healthy', workspace: workspaceA }), {
    code: 'RESCUE_PREPARATION_SCAN_LIMIT',
  });
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
  const { directory } = await preparedDirectory(dataRoot, workspaceA);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${'e'.repeat(64)}.json`), `{${sentinel}`);
  await assert.rejects(store.cleanupSession({ sessionId: 'session-a', workspace: workspaceA }), (/** @type {any} */ error) => {
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
