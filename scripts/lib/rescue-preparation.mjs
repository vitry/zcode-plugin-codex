import { createHash } from 'node:crypto';
import { access, opendir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { PluginError } from './errors.mjs';
import { atomicWriteJson, ensurePrivateDirectory, readBoundedJsonFile, withFileLock } from './fs.mjs';
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
  /** @type {Buffer[]} */
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > RESCUE_ENVELOPE_MAX_BYTES) throw invalidPreparation();
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks, length);
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
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw invalidPreparation();
  }
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
      await withFileLock(storage.lockPath, async () => {
        const names = await boundedRecordNames(storage.directory);
        if (names.includes(`${key}.json`) || await exists(path)) throw preparationError(
          'RESCUE_PREPARATION_EXISTS', 'A Rescue preparation already exists for this turn.',
        );
        if (names.length === PREPARATION_SCAN_MAX_RECORDS) throw preparationError(
          'RESCUE_PREPARATION_SCAN_LIMIT', 'The Rescue preparation record scan limit was exceeded.',
        );
        await atomicWriteJson(path, record);
      });
    },

    /** @param {any} input */
    async consume(input) {
      validateConsumeInput(input);
      const storage = await preparationStorage(dataRoot, input.workspace);
      const key = preparationKey(input.sessionId, input.turnId, storage.workspacePath);
      const path = join(storage.directory, `${key}.json`);
      return withFileLock(storage.lockPath, async () => {
        const record = await readPreparedRecord(path, key, storage.workspacePath, true);
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
        if (consumedAt >= Date.parse(record.expiresAt)) throw preparationError(
          'RESCUE_PREPARATION_EXPIRED', 'The Rescue preparation has expired.',
        );
        const consumed = {
          ...record,
          envelope: validateRescuePreparation(record.envelope),
          consumedAt: new Date(consumedAt).toISOString(),
          executorAgentId: input.executorAgentId,
        };
        await atomicWriteJson(path, consumed);
        return cloneRecord(consumed);
      });
    },

    /** @param {any} input */
    async cleanupTurn(input) {
      validateTurnInput(input);
      const storage = await preparationStorage(dataRoot, input.workspace);
      const key = preparationKey(input.sessionId, input.turnId, storage.workspacePath);
      const path = join(storage.directory, `${key}.json`);
      await withFileLock(storage.lockPath, async () => {
        if (!await exists(path)) return;
        const record = await readPreparedRecord(path, key, storage.workspacePath, false);
        if (record.sessionId !== input.sessionId || record.turnId !== input.turnId) throw invalidRecord();
        await unlink(path);
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
  await withFileLock(storage.lockPath, async () => {
    const names = await boundedRecordNames(storage.directory);
    const targets = [];
    for (const name of names) {
      const key = name.slice(0, -5);
      const path = join(storage.directory, name);
      const record = await readPreparedRecord(path, key, storage.workspacePath, false);
      if (predicate(record)) targets.push(path);
    }
    for (const path of targets) await unlink(path);
  });
}

/** @param {string} directory */
async function boundedRecordNames(directory) {
  const handle = await opendir(directory);
  const entries = [];
  try {
    for await (const entry of handle) {
      if (entries.length === PREPARATION_SCAN_MAX_RECORDS) throw preparationError(
        'RESCUE_PREPARATION_SCAN_LIMIT', 'The Rescue preparation record scan limit was exceeded.',
      );
      entries.push(entry);
    }
  } finally { await handle.close().catch(() => {}); }
  if (entries.some((entry) => !entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name))) throw invalidRecord();
  return entries.map((entry) => entry.name);
}

/** @param {string} path @param {string} key @param {string} workspace @param {boolean} missingIsNotFound */
async function readPreparedRecord(path, key, workspace, missingIsNotFound) {
  let record;
  try { record = await readBoundedJsonFile(dirname(path), path, PREPARATION_RECORD_MAX_BYTES); }
  catch (error) {
    if (missingIsNotFound && (/** @type {any} */ (error)?.code === 'ENOENT'
      || error instanceof PluginError && error.code === 'JSON_READ_FAILED'
      && /** @type {any} */ (error.cause)?.code === 'ENOENT')) {
      throw preparationError('RESCUE_PREPARATION_NOT_FOUND', 'No Rescue preparation matches this turn.');
    }
    throw invalidRecord();
  }
  if (!validRecord(record, key, workspace)) throw invalidRecord();
  return record;
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
  await ensurePrivateDirectory(directory);
  return { ...storage, directory, lockPath: join(invocationsDirectory, '.lock') };
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
  try { await access(path); return true; } catch (error) {
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
