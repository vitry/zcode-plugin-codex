import { createHash } from 'node:crypto';
import { constants, lstatSync, unlinkSync } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import { PluginError } from './errors.mjs';
import {
  atomicWriteJson,
  ensurePrivateDirectoryWithin,
  readBoundedJsonFile,
  readPrivateDirectory,
  withFileLock,
} from './fs.mjs';
import { PERMISSION_MODES } from './identity.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';

export const RESCUE_PREPARATION_VERSION = 1;
export const RESCUE_TASK_MAX_BYTES = 64 * 1024;
export const RESCUE_ENVELOPE_MAX_BYTES = RESCUE_TASK_MAX_BYTES + 4096;

const SOURCES = new Set(['explicit', 'proactive']);
const EXECUTIONS = new Set(['foreground', 'background']);
const RESUMES = new Set(['fresh', 'resume']);
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const ENVELOPE_KEYS = ['options', 'source', 'task', 'version'];
const OPTION_KEYS = new Set(['effort', 'execution', 'model', 'resume']);
const PREPARATION_LIFETIME_MS = 30 * 60_000;
const PREPARATION_SCAN_MAX_RECORDS = 1024;
const PREPARATION_RECORD_MAX_BYTES = 2 * 1024 * 1024;
const RECORD_KEYS = [
  'consumedAt', 'createdAt', 'envelope', 'executorAgentId', 'expiresAt', 'key',
  'permissionMode', 'sessionId', 'source', 'turnId', 'version', 'workspace',
];

/** @param {NodeJS.ReadableStream} stream */
export async function readRescuePreparation(stream) {
  if (stream === null || typeof stream !== 'object' || !(Symbol.asyncIterator in stream)) {
    throw invalidPreparation();
  }
  const buffer = Buffer.allocUnsafe(RESCUE_ENVELOPE_MAX_BYTES);
  let length = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.length === 0) continue;
      if (length + bytes.length > RESCUE_ENVELOPE_MAX_BYTES) throw invalidPreparation();
      bytes.copy(buffer, length); length += bytes.length;
    }
  } catch { throw invalidPreparation(); }
  const bytes = buffer.subarray(0, length);
  if (bytes.length === 0 || bytes.at(-1) !== 0x0a || bytes.subarray(0, -1).includes(0x0a)) {
    throw invalidPreparation();
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -1)); }
  catch { throw invalidPreparation(); }
  rejectDuplicateObjectKeys(text);
  let value;
  try { value = JSON.parse(text); } catch { throw invalidPreparation(); }
  return validateRescuePreparation(value);
}

/** @param {unknown} value */
export function validateRescuePreparation(value) {
  if (!plain(value) || !sameKeys(value, ENVELOPE_KEYS)
    || value.version !== RESCUE_PREPARATION_VERSION
    || !SOURCES.has(value.source)
    || typeof value.task !== 'string' || value.task.trim().length === 0
    || Buffer.byteLength(value.task) > RESCUE_TASK_MAX_BYTES
    || !plain(value.options)) throw invalidPreparation();
  for (const key of Object.keys(value.options)) {
    if (!OPTION_KEYS.has(key) || value.options[key] === null) throw invalidPreparation();
  }
  if (value.options.execution !== undefined && !EXECUTIONS.has(value.options.execution)) throw invalidPreparation();
  if (value.options.resume !== undefined && !RESUMES.has(value.options.resume)) throw invalidPreparation();
  if (value.options.effort !== undefined && !EFFORTS.has(value.options.effort)) throw invalidPreparation();
  if (value.options.model !== undefined && !validModel(value.options.model)) throw invalidPreparation();
  return {
    version: value.version,
    source: value.source,
    task: value.task,
    options: { ...value.options },
  };
}

/** @param {string} prompt */
export function hasRecordedRescueMarker(prompt) {
  return typeof prompt === 'string' && /(?:^|\s)\$zcode:rescue(?=$|\s)/u.test(prompt);
}

/** @param {{dataRoot:string}} options */
export function createRescuePreparationStore({ dataRoot }) {
  if (typeof dataRoot !== 'string' || dataRoot.length === 0) throw preparationError(
    'RESCUE_PREPARATION_INVALID', 'A plugin data root is required.',
  );
  return {
    /** @param {any} input */
    async save(input) {
      validateSaveInput(input);
      const envelope = validateRescuePreparation(input.envelope);
      const marker = hasRecordedRescueMarker(input.recordedPrompt);
      if ((envelope.source === 'explicit') !== marker) throw preparationError(
        'RESCUE_PREPARATION_SOURCE_MISMATCH',
        'The Rescue preparation source does not match the recorded prompt.',
      );
      const storage = await preparationStorage(dataRoot, input.workspace);
      const key = preparationKey(input.sessionId, input.turnId, storage.workspacePath);
      const path = join(storage.directory, `${key}.json`);
      const createdAt = timestamp(input.now);
      const record = {
        version: RESCUE_PREPARATION_VERSION,
        key,
        sessionId: input.sessionId,
        turnId: input.turnId,
        workspace: storage.workspacePath,
        permissionMode: input.permissionMode,
        source: envelope.source,
        envelope,
        createdAt: new Date(createdAt).toISOString(),
        expiresAt: new Date(createdAt + PREPARATION_LIFETIME_MS).toISOString(),
        consumedAt: null,
        executorAgentId: null,
      };
      if (Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`) > PREPARATION_RECORD_MAX_BYTES) {
        throw invalidPreparation();
      }
      await withPreparationLock(storage, async () => {
        const names = await boundedRecordNames(storage);
        if (names.includes(`${key}.json`) || await exists(path)) throw preparationError(
          'RESCUE_PREPARATION_EXISTS', 'A Rescue preparation already exists for this turn.',
        );
        if (names.length === PREPARATION_SCAN_MAX_RECORDS) throw preparationError(
          'RESCUE_PREPARATION_SCAN_LIMIT', 'The Rescue preparation record scan limit was exceeded.',
        );
        await atomicWriteJson(path, record, { privateRoot: storage.privateRoot });
      });
    },

    /** @param {any} input */
    async consume(input) {
      validateConsumeInput(input);
      const storage = await preparationStorage(dataRoot, input.workspace);
      const key = preparationKey(input.sessionId, input.turnId, storage.workspacePath);
      const path = join(storage.directory, `${key}.json`);
      return withPreparationLock(storage, async () => {
        const record = await readPreparedRecord(storage, path, key, true);
        if (record.sessionId !== input.sessionId || record.turnId !== input.turnId
          || record.workspace !== storage.workspacePath || record.permissionMode !== input.permissionMode) {
          throw preparationError('RESCUE_PREPARATION_MISMATCH', 'The Rescue preparation identity does not match.');
        }
        if (record.consumedAt !== null) {
          if (record.executorAgentId !== input.executorAgentId) throw preparationError(
            'RESCUE_PREPARATION_MISMATCH', 'The Rescue preparation executor does not match.',
          );
          throw preparationError('RESCUE_PREPARATION_CONSUMED', 'The Rescue preparation has already been consumed.');
        }
        const consumedAt = timestamp(input.now);
        if (consumedAt < Date.parse(record.createdAt)) throw invalidPreparation();
        if (consumedAt >= Date.parse(record.expiresAt)) throw preparationError(
          'RESCUE_PREPARATION_EXPIRED', 'The Rescue preparation has expired.',
        );
        const consumed = {
          ...record,
          envelope: validateRescuePreparation(record.envelope),
          consumedAt: new Date(consumedAt).toISOString(),
          executorAgentId: input.executorAgentId,
        };
        await atomicWriteJson(path, consumed, { privateRoot: storage.privateRoot });
        return cloneRecord(consumed);
      });
    },

    /** @param {any} input */
    async cleanupTurn(input) {
      validateTurnInput(input);
      const storage = await preparationStorage(dataRoot, input.workspace);
      const key = preparationKey(input.sessionId, input.turnId, storage.workspacePath);
      const path = join(storage.directory, `${key}.json`);
      await withPreparationLock(storage, async () => {
        if (!await exists(path)) return;
        const record = await readPreparedRecord(storage, path, key, false);
        if (record.sessionId !== input.sessionId || record.turnId !== input.turnId) throw invalidRecord();
        await unlinkPreparedRecord(storage, path);
      });
    },

    /** @param {any} input */
    async cleanupOlderTurns(input) {
      validateTurnInput(input);
      const storage = await preparationStorage(dataRoot, input.workspace);
      await cleanupMatching(storage, (record) => (
        record.sessionId === input.sessionId && record.turnId !== input.turnId
      ));
    },

    /** @param {any} input */
    async cleanupSession(input) {
      validateSessionInput(input);
      const storage = await preparationStorage(dataRoot, input.workspace);
      await cleanupMatching(storage, (record) => record.sessionId === input.sessionId);
    },
  };
}

/** @param {any} storage @param {(record:any)=>boolean} predicate */
async function cleanupMatching(storage, predicate) {
  await withPreparationLock(storage, async () => {
    const names = await boundedRecordNames(storage);
    const targets = [];
    for (const name of names) {
      const key = name.slice(0, -5);
      const path = join(storage.directory, name);
      let record;
      try { record = await readPreparedRecord(storage, path, key, false); }
      catch (error) {
        if (error instanceof PluginError && error.code === 'RESCUE_PREPARATION_RECORD_INVALID') continue;
        throw error;
      }
      if (predicate(record)) targets.push(path);
    }
    for (const path of targets) await unlinkPreparedRecord(storage, path);
  });
}

/** @param {any} storage */
async function boundedRecordNames(storage) {
  let entries;
  try {
    entries = await readPrivateDirectory(
      storage.privateRoot, storage.directory, PREPARATION_SCAN_MAX_RECORDS,
    );
  } catch (error) {
    if (await hasActualEntryOverflow(storage)) throw preparationError(
      'RESCUE_PREPARATION_SCAN_LIMIT', 'The Rescue preparation record scan limit was exceeded.',
    );
    if (error instanceof PluginError && error.code === 'PRIVATE_PATH_UNSAFE') throw invalidRecord();
    throw storageError();
  }
  if (entries.some((entry) => !entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name))) throw invalidRecord();
  return entries.map((entry) => entry.name);
}

/** @param {any} storage @param {string} path @param {string} key @param {boolean} missingIsNotFound */
async function readPreparedRecord(storage, path, key, missingIsNotFound) {
  let record;
  try { record = await readPrivatePreparationJson(storage, path); }
  catch (error) {
    if (missingIsNotFound && (/** @type {any} */ (error)?.code === 'ENOENT'
      || error instanceof PluginError && error.code === 'JSON_READ_FAILED'
      && /** @type {any} */ (error.cause)?.code === 'ENOENT')) {
      throw preparationError('RESCUE_PREPARATION_NOT_FOUND', 'No Rescue preparation matches this turn.');
    }
    if (recordCorruptionError(error)) throw invalidRecord();
    throw storageError();
  }
  if (!validRecord(record, key, storage.workspacePath)) throw invalidRecord();
  return record;
}

/** @param {any} storage */
async function hasActualEntryOverflow(storage) {
  let handle;
  try {
    const [rootBefore, directoryBefore, canonicalRoot, canonicalDirectory] = await Promise.all([
      lstat(storage.privateRoot, { bigint: true }),
      lstat(storage.directory, { bigint: true }),
      realpath(storage.privateRoot),
      realpath(storage.directory),
    ]);
    const descendant = relative(canonicalRoot, canonicalDirectory);
    if (!rootBefore.isDirectory() || !directoryBefore.isDirectory()
      || descendant === '..' || descendant.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
      || isAbsolute(descendant)) return false;
    handle = await opendir(storage.directory); let count = 0;
    for await (const entry of handle) {
      void entry; count += 1;
      if (count > PREPARATION_SCAN_MAX_RECORDS) break;
    }
    const [rootAfter, directoryAfter] = await Promise.all([
      lstat(storage.privateRoot, { bigint: true }), lstat(storage.directory, { bigint: true }),
    ]);
    return count > PREPARATION_SCAN_MAX_RECORDS
      && sameDirectoryIdentity(rootBefore, rootAfter)
      && sameDirectoryIdentity(directoryBefore, directoryAfter);
  } catch { return false; }
  finally { await handle?.close().catch(() => {}); }
}

/** @param {unknown} error */
function recordCorruptionError(error) {
  return error instanceof SyntaxError
    || error instanceof PluginError && [
      'PRIVATE_PATH_UNSAFE', 'RESCUE_PREPARATION_RECORD_INVALID',
    ].includes(error.code)
    || ['EISDIR', 'ELOOP', 'ENOTDIR'].includes(/** @type {any} */ (error)?.code);
}

/** @param {any} storage @param {string} path */
async function readPrivatePreparationJson(storage, path) {
  const trusted = await readBoundedJsonFile(
    storage.privateRoot, path, PREPARATION_RECORD_MAX_BYTES,
  );
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(PREPARATION_RECORD_MAX_BYTES)) throw invalidRecord();
    const bytes = Buffer.allocUnsafe(Number(before.size)); let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset !== bytes.length) throw invalidRecord();
    const [after, current] = await Promise.all([
      handle.stat({ bigint: true }), lstat(path, { bigint: true }),
    ]);
    if (current.isSymbolicLink() || !current.isFile()
      || !sameFileIdentity(before, after) || !sameFileIdentity(before, current)) throw invalidRecord();
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw invalidRecord(); }
    try {
      rejectDuplicateObjectKeys(text);
      const parsed = JSON.parse(text);
      if (JSON.stringify(parsed) !== JSON.stringify(trusted)) throw invalidRecord();
      await assertStorageIdentity(storage);
      return trusted;
    } catch { throw invalidRecord(); }
  } finally { await handle?.close().catch(() => {}); }
}

/** @param {import('node:fs').BigIntStats} left @param {import('node:fs').BigIntStats} right */
function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** @param {any} record @param {string} key @param {string} workspace */
function validRecord(record, key, workspace) {
  if (!plain(record) || !sameKeys(record, RECORD_KEYS)
    || record.version !== RESCUE_PREPARATION_VERSION || record.key !== key
    || !/^[a-f0-9]{64}$/u.test(record.key) || record.workspace !== workspace
    || !nonempty(record.sessionId) || !nonempty(record.turnId)
    || !PERMISSION_MODES.includes(record.permissionMode)
    || !SOURCES.has(record.source) || !validDate(record.createdAt) || !validDate(record.expiresAt)
    || Date.parse(record.expiresAt) - Date.parse(record.createdAt) !== PREPARATION_LIFETIME_MS
    || preparationKey(record.sessionId, record.turnId, record.workspace) !== record.key) return false;
  let envelope;
  try { envelope = validateRescuePreparation(record.envelope); } catch { return false; }
  if (envelope.source !== record.source) return false;
  if (record.consumedAt === null) return record.executorAgentId === null;
  return validDate(record.consumedAt) && nonempty(record.executorAgentId)
    && Date.parse(record.consumedAt) >= Date.parse(record.createdAt);
}

/** @param {any} input */
function validateSaveInput(input) {
  if (!plain(input) || !nonempty(input.sessionId) || !nonempty(input.turnId)
    || !nonempty(input.workspace) || !PERMISSION_MODES.includes(input.permissionMode)
    || typeof input.recordedPrompt !== 'string' || Buffer.byteLength(input.recordedPrompt) > RESCUE_TASK_MAX_BYTES) {
    throw invalidPreparation();
  }
  timestamp(input.now);
}

/** @param {any} input */
function validateConsumeInput(input) {
  validateTurnInput(input);
  if (!PERMISSION_MODES.includes(input.permissionMode) || !nonempty(input.executorAgentId)) throw invalidPreparation();
  timestamp(input.now);
}

/** @param {any} input */
function validateTurnInput(input) {
  if (!plain(input) || !nonempty(input.sessionId) || !nonempty(input.turnId) || !nonempty(input.workspace)) {
    throw invalidPreparation();
  }
}

/** @param {any} input */
function validateSessionInput(input) {
  if (!plain(input) || !nonempty(input.sessionId) || !nonempty(input.workspace)) throw invalidPreparation();
}

/** @param {string} dataRoot @param {string} workspace */
async function preparationStorage(dataRoot, workspace) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const invocationsDirectory = join(storage.directory, 'invocations');
  const directory = join(invocationsDirectory, 'prepared');
  await ensurePrivateDirectoryWithin(storage.directory, invocationsDirectory);
  await ensurePrivateDirectoryWithin(storage.directory, directory);
  const lockPath = join(storage.directory, '.rescue-preparation-lock');
  const lockIdentity = await preparationLockIdentity(lockPath);
  return {
    ...storage,
    privateRoot: storage.directory,
    invocationsDirectory,
    directory,
    lockPath,
    lockDirectoryIdentity: lockIdentity.directory,
    lockFileIdentity: lockIdentity.file,
    invocationsIdentity: await lstat(invocationsDirectory, { bigint: true }),
    directoryIdentity: await lstat(directory, { bigint: true }),
  };
}

/** @template T @param {any} storage @param {()=>Promise<T>} operation @returns {Promise<T>} */
async function withPreparationLock(storage, operation) {
  return withFileLock(storage.lockPath, async () => {
    assertLockIdentity(storage);
    await assertStorageIdentity(storage);
    try {
      const result = await operation();
      assertLockIdentity(storage);
      await assertStorageIdentity(storage);
      return result;
    } catch (error) {
      assertLockIdentity(storage);
      await assertStorageIdentity(storage);
      throw error;
    }
  });
}

/** @param {string} lockPath */
async function preparationLockIdentity(lockPath) {
  try { return currentLockIdentity(lockPath); }
  catch (error) {
    if (/** @type {any} */ (error)?.code !== 'ENOENT') throw error;
    await withFileLock(lockPath, async () => {});
    return currentLockIdentity(lockPath);
  }
}

/** @param {string} lockPath */
function currentLockIdentity(lockPath) {
  const directory = lstatSync(lockPath, { bigint: true });
  const file = lstatSync(join(lockPath, 'advisory.lock'), { bigint: true });
  if (!directory.isDirectory() || !file.isFile()) throw invalidRecord();
  return { directory, file };
}

/** @param {any} storage */
function assertLockIdentity(storage) {
  const current = currentLockIdentity(storage.lockPath);
  if (!sameDirectoryIdentity(storage.lockDirectoryIdentity, current.directory)
    || !sameDirectoryIdentity(storage.lockFileIdentity, current.file)) throw invalidRecord();
}

/** @param {any} storage @param {string} path */
async function unlinkPreparedRecord(storage, path) {
  await assertStorageIdentity(storage);
  assertLockIdentity(storage);
  const invocations = lstatSync(storage.invocationsDirectory, { bigint: true });
  const directory = lstatSync(storage.directory, { bigint: true });
  const record = lstatSync(path, { bigint: true });
  if (!record.isFile()
    || !sameDirectoryIdentity(storage.invocationsIdentity, invocations)
    || !sameDirectoryIdentity(storage.directoryIdentity, directory)) throw invalidRecord();
  unlinkSync(path);
}

/** @param {any} storage */
async function assertStorageIdentity(storage) {
  await ensurePrivateDirectoryWithin(storage.privateRoot, storage.invocationsDirectory);
  await ensurePrivateDirectoryWithin(storage.privateRoot, storage.directory);
  const [invocations, directory] = await Promise.all([
    lstat(storage.invocationsDirectory, { bigint: true }),
    lstat(storage.directory, { bigint: true }),
  ]);
  if (!invocations.isDirectory() || !directory.isDirectory()
    || !sameDirectoryIdentity(storage.invocationsIdentity, invocations)
    || !sameDirectoryIdentity(storage.directoryIdentity, directory)) throw invalidRecord();
}

/** @param {import('node:fs').BigIntStats} left @param {import('node:fs').BigIntStats} right */
function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

/** @param {string} sessionId @param {string} turnId @param {string} workspace */
function preparationKey(sessionId, turnId, workspace) {
  return createHash('sha256').update(JSON.stringify([sessionId, turnId, workspace, 'rescue'])).digest('hex');
}

/** @param {any} record */
function cloneRecord(record) {
  return { ...record, envelope: validateRescuePreparation(record.envelope) };
}

/** @param {string} path */
async function exists(path) {
  try { await lstat(path); return true; } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') return false;
    throw error;
  }
}

/** @param {unknown} value */
function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= RESCUE_TASK_MAX_BYTES;
}

/** @param {unknown} value */
function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** @param {Date|number|string|undefined} now */
function timestamp(now) {
  const value = now === undefined ? Date.now() : new Date(now).getTime();
  if (!Number.isFinite(value)) throw invalidPreparation();
  return value;
}

function invalidRecord() {
  return preparationError('RESCUE_PREPARATION_RECORD_INVALID', 'A persisted Rescue preparation record is invalid.');
}

function storageError() {
  return preparationError('RESCUE_PREPARATION_STORAGE_FAILED', 'Rescue preparation storage could not be read safely.');
}

/** @param {string} code @param {string} message */
function preparationError(code, message) {
  return new PluginError(code, message, {
    category: 'authorization',
    remedy: 'Prepare Rescue again from the active parent turn.',
  });
}

/** @param {string} text */
function rejectDuplicateObjectKeys(text) {
  let offset = 0;
  const whitespace = () => { while (/\s/u.test(text[offset] ?? '')) offset += 1; };
  const string = () => {
    if (text[offset] !== '"') throw invalidPreparation();
    const start = offset++;
    let escaped = false;
    while (offset < text.length) {
      const character = text[offset++];
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character === '"') {
        try { return JSON.parse(text.slice(start, offset)); } catch { throw invalidPreparation(); }
      }
    }
    throw invalidPreparation();
  };
  const value = () => {
    whitespace();
    if (text[offset] === '{') return object();
    if (text[offset] === '[') return array();
    if (text[offset] === '"') { string(); return; }
    const start = offset;
    while (offset < text.length && !/[\s,\]}]/u.test(text[offset])) offset += 1;
    if (offset === start) throw invalidPreparation();
  };
  const object = () => {
    offset += 1; whitespace();
    const keys = new Set();
    if (text[offset] === '}') { offset += 1; return; }
    while (offset < text.length) {
      whitespace(); const key = string(); whitespace();
      if (keys.has(key)) throw invalidPreparation();
      keys.add(key);
      if (text[offset++] !== ':') throw invalidPreparation();
      value(); whitespace();
      if (text[offset] === '}') { offset += 1; return; }
      if (text[offset++] !== ',') throw invalidPreparation();
    }
    throw invalidPreparation();
  };
  const array = () => {
    offset += 1; whitespace();
    if (text[offset] === ']') { offset += 1; return; }
    while (offset < text.length) {
      value(); whitespace();
      if (text[offset] === ']') { offset += 1; return; }
      if (text[offset++] !== ',') throw invalidPreparation();
    }
    throw invalidPreparation();
  };
  whitespace(); value(); whitespace();
  if (offset !== text.length) throw invalidPreparation();
}

/** @param {unknown} value */
function validModel(value) {
  return typeof value === 'string' && value.trim().length > 0
    && Buffer.byteLength(value) <= 512 && ![...value].some((character) => {
      const codePoint = character.charCodeAt(0);
      return codePoint <= 31 || codePoint >= 127 && codePoint <= 159;
    });
}

/** @param {Record<string, unknown>} value @param {string[]} keys */
function sameKeys(value, keys) {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function plain(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidPreparation() {
  return new PluginError('RESCUE_PREPARATION_INVALID', 'The Rescue preparation is invalid.', {
    category: 'authorization',
    remedy: 'Prepare one valid Rescue envelope for the active parent turn.',
  });
}
