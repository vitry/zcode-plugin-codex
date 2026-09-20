// @ts-nocheck
/**
 * Durable append-only evidence store for the disposable Codex MCP context
 * probe. The observer owns `<run>/events.jsonl`; the final reducer alone owns
 * `<run>/result.json`. Every record carries only a random probe-run nonce, a
 * closed event enum, call nonces, salted hashes/equality booleans, and closed
 * observation enums — never raw thread, turn, session, workspace, task,
 * binding, job, PID, timing, or path values.
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, open, rename } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { withFileLock } from '../../scripts/lib/fs.mjs';

/** Maximum accepted size of the JSONL event log in bytes. */
export const PROBE_EVENTS_MAX_BYTES = 4 * 1024 * 1024;

/** The closed qualification phase vocabulary, in required order. */
export const PROBE_PHASES = Object.freeze(['negative-control', 'matrix', 'cli-sigint', 'cli-sigkill', 'app-server-interrupt', 'plugin-tool-timeout', 'direct-config-timeout']);

/** The phases whose Host spawns must durably start the probe server. */
const POSITIVE_SERVER_PHASES = Object.freeze(['matrix', 'cli-sigint', 'cli-sigkill', 'app-server-interrupt', 'plugin-tool-timeout', 'direct-config-timeout']);

/** The closed context-assertion vocabulary (pass/fail authority gates). */
export const PROBE_CONTEXT_ASSERTIONS = Object.freeze([
  'identityFieldsVisible', 'identityNamespaceQualified', 'laterTurnDistinct',
  'concurrentChildrenDistinct', 'metadataChangesAcrossTurns', 'serverLoadedWithConfig',
]);

/** The closed lifecycle characterization cases (honest observations). */
export const PROBE_LIFECYCLE_CASES = Object.freeze([
  'appServerTurnInterrupt', 'cliSigint', 'cliSigkill', 'directConfigToolTimeout', 'pluginToolTimeout',
]);

/**
 * The closed app-server control outcomes (the amended 0.155.1 controls) in
 * required canonical order: the Skill resolution result, the structured
 * treatment capture turn, the text-only control capture turn, the
 * `mcpServer/tool/call` transport control, and the held turn's
 * interrupt-delivery result. Each control durably records exactly one
 * event, so a reduced result can only come from a log that substantiates
 * the three-way Skill-resolution / structured-injection / model-tool-
 * selection distinction AND durably proves the interruption was exercised.
 */
export const PROBE_APP_SERVER_CONTROLS = Object.freeze([
  'skill-resolution', 'structured-treatment-turn', 'text-only-control-turn', 'transport-control', 'held-turn-interrupt',
]);

/** The closed outcome vocabulary per app-server control. */
export const PROBE_APP_SERVER_CONTROL_OUTCOMES = Object.freeze({
  'skill-resolution': Object.freeze(['resolved', 'unresolved', 'failed']),
  'structured-treatment-turn': Object.freeze(['completed', 'failed', 'interrupted', 'ceiling', 'skipped']),
  'text-only-control-turn': Object.freeze(['completed', 'failed', 'interrupted', 'ceiling', 'skipped']),
  'transport-control': Object.freeze(['capture-recorded', 'error-result-undetermined-origin', 'call-failed', 'unobserved']),
  'held-turn-interrupt': Object.freeze(['delivered', 'rejected', 'failed', 'not-sent']),
});

/** The candidate field paths hashed from per-call `_meta` captures. */
export const PROBE_EQUALITY_CANDIDATES = Object.freeze(['envelopeThreadId', 'innerSessionId', 'innerThreadId', 'innerTurnId']);

/** The authority field paths hashed independently by the driver and hook. */
export const PROBE_EQUALITY_AUTHORITIES = Object.freeze([
  'appServerThreadId', 'appServerTurnId', 'hookSessionId', 'hookTurnId', 'hookAgentId', 'returnedChildHandle',
]);

/** The scopes of the salted equality matrix. */
export const PROBE_EQUALITY_SCOPES = Object.freeze(['root', 'child']);

/** The thread authorities recorded for the Root scope. */
export const PROBE_ROOT_THREAD_AUTHORITIES = Object.freeze(['appServerThreadId', 'hookSessionId']);

/** The thread authorities recorded for the Child scope. */
export const PROBE_CHILD_THREAD_AUTHORITIES = Object.freeze(['appServerThreadId', 'hookSessionId', 'hookAgentId', 'returnedChildHandle']);

/** The turn authorities recorded for both scopes. */
export const PROBE_TURN_AUTHORITIES = Object.freeze(['appServerTurnId', 'hookTurnId']);

const EVENT_KINDS = Object.freeze([
  'server-started', 'capture-started', 'capture-settled',
  'hold-started', 'hold-settled', 'phase-observed',
  'hook-observed', 'authority-hash', 'equality-fact', 'lifecycle-observed',
  'app-server-control',
]);
const TERMINAL_KINDS = Object.freeze(['capture-settled', 'hold-settled']);
const START_KINDS = Object.freeze(['capture-started', 'hold-started']);
const SETTLEMENTS = Object.freeze(['signal-abort', 'transport-close', 'host-timeout']);
const HOOK_NAMES = Object.freeze(['session-start', 'user-prompt-submit', 'subagent-start', 'subagent-stop', 'stop', 'session-end']);
const AUTHORITY_HASH_KINDS = Object.freeze(['stdoutThreadId', 'appServerThreadId', 'appServerTurnId', 'returnedChildHandle']);
const OBSERVATION_ENUMS = Object.freeze({
  hostProcess: Object.freeze(['running', 'exited-clean', 'exited-signal', 'not-observed', 'unknown']),
  turnTerminalStatus: Object.freeze(['completed', 'interrupted', 'failed', 'pending', 'not-observed', 'unknown']),
  toolCallOutcome: Object.freeze(['completed', 'failed', 'timed-out', 'pending', 'not-observed', 'unknown']),
  handlerSettlement: Object.freeze(['signal-abort', 'transport-close', 'completed', 'pending', 'server-exited', 'not-observed', 'unknown']),
  transportState: Object.freeze(['open', 'stdin-eof', 'closed', 'server-exited', 'not-observed', 'unknown']),
  hookEvent: Object.freeze(['stop', 'session-end', 'none', 'not-observed', 'unknown']),
  unknownReason: Object.freeze(['none', 'ceiling-reached', 'host-omitted-event', 'process-exited-first', 'unsupported']),
});
const HASH_KEYS = Object.freeze(['threadHash', 'turnHash', 'workspaceHash', 'metaHash', 'envelopeThreadIdHash', 'innerSessionIdHash']);
const EVENT_ALLOWED_KEYS = Object.freeze({
  'server-started': Object.freeze(['kind', 'serverPid', 'eventsPath', 'lockPath']),
  'phase-observed': Object.freeze(['kind', 'phase', 'observed']),
  'capture-started': Object.freeze(['kind', 'callNonce', 'identityComplete', 'threadHash', 'turnHash', 'workspaceHash', 'metaHash', 'envelopeThreadIdHash', 'innerSessionIdHash', 'metaFields', 'envelopeFields']),
  'capture-settled': Object.freeze(['kind', 'callNonce']),
  'hold-started': Object.freeze(['kind', 'callNonce']),
  'hold-settled': Object.freeze(['kind', 'callNonce', 'settlement']),
  'hook-observed': Object.freeze(['kind', 'hook', 'sessionHash', 'turnHash', 'agentHash']),
  'authority-hash': Object.freeze(['kind', 'authority', 'scope', 'hash']),
  'equality-fact': Object.freeze(['kind', 'scope', 'candidate', 'authority', 'equal']),
  'lifecycle-observed': Object.freeze(['kind', 'lifecycleCase', ...Object.keys(OBSERVATION_ENUMS)]),
  'app-server-control': Object.freeze(['kind', 'control', 'outcome', 'captures']),
});
const RUN_NONCE_PATTERN = /^[0-9a-f]{64}$/;
const CALL_NONCE_PATTERN = /^[0-9a-f]{32}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAXIMUM_META_FIELD_ENTRIES = 32;

/** @param {string} code @param {string} message */
function probeError(code, message) {
  const error = /** @type {Error & {code:string}} */ (new Error(message));
  error.code = code;
  return error;
}

/** @param {unknown} error */
function errorCode(error) {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
}

/** @param {string} value */
function isBoundedText(value) {
  // The regex deliberately matches control characters: rejecting them is the
  // entire purpose of this check.
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Canonical JSON with recursively sorted object keys so metadata hashing is
 * key-order independent.
 * @param {unknown} value
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Hashes one raw identity value under the probe-run nonce. The raw value is
 * never retained by the resulting evidence.
 * @param {string} runNonce @param {string} value
 */
export function hashProbeValue(runNonce, value) {
  if (!RUN_NONCE_PATTERN.test(runNonce)) throw probeError('PROBE_NONCE_INVALID', 'The probe run nonce must be 64 lowercase hexadecimal characters.');
  if (typeof value !== 'string') throw probeError('PROBE_HASH_INPUT_INVALID', 'The probe hash input must be a string.');
  return createHash('sha256').update(`${runNonce}\u0000${value}`).digest('hex');
}

/** Validates one salted 64-hex hash or an explicit null. */
function validateNullableHash(event, kind, key) {
  const value = event[key];
  if (value === null || value === undefined) return;
  if (!HASH_PATTERN.test(/** @type {string} */ (value))) {
    throw probeError('PROBE_EVENT_INVALID', `${kind} requires ${key} to be null or a 64 hexadecimal salted hash.`);
  }
}

/**
 * Validates one closed event body. Throws when the body is not part of the
 * probe evidence vocabulary.
 * @param {unknown} body
 */
export function validateProbeEventBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw probeError('PROBE_EVENT_INVALID', 'The probe event must be an object.');
  const event = /** @type {Record<string, unknown>} */ (body);
  if (typeof event.kind !== 'string' || !EVENT_KINDS.includes(event.kind)) {
    throw probeError('PROBE_EVENT_KIND_UNKNOWN', 'Unknown probe event kind.');
  }
  // Closed, redacted evidence: every event kind accepts exactly its declared
  // key set, so raw metadata or identity values can never be persisted under
  // an ad-hoc field name.
  const allowedKeys = EVENT_ALLOWED_KEYS[event.kind];
  for (const key of Object.keys(event)) {
    if (!allowedKeys.includes(key)) throw probeError('PROBE_EVENT_INVALID', `${event.kind} rejects unknown field ${String(key)}.`);
  }
  switch (event.kind) {
    case 'server-started': {
      if (!Number.isSafeInteger(event.serverPid) || /** @type {number} */ (event.serverPid) <= 0) throw probeError('PROBE_EVENT_INVALID', 'server-started requires a positive serverPid.');
      if (!isBoundedText(/** @type {string} */ (event.eventsPath)) || !isAbsolute(/** @type {string} */ (event.eventsPath))) throw probeError('PROBE_EVENT_INVALID', 'server-started requires an absolute eventsPath.');
      if (!isBoundedText(/** @type {string} */ (event.lockPath)) || !isAbsolute(/** @type {string} */ (event.lockPath))) throw probeError('PROBE_EVENT_INVALID', 'server-started requires an absolute lockPath.');
      break;
    }
    case 'capture-started': {
      if (!CALL_NONCE_PATTERN.test(/** @type {string} */ (event.callNonce))) throw probeError('PROBE_EVENT_INVALID', 'capture-started requires a 32 hexadecimal callNonce.');
      if (typeof event.identityComplete !== 'boolean') throw probeError('PROBE_EVENT_INVALID', 'capture-started requires an identityComplete boolean.');
      for (const key of HASH_KEYS) {
        if (!(key in event)) throw probeError('PROBE_EVENT_FIELD_MISSING', `capture-started event requires identity hash fields (${key} missing).`);
        const value = event[key];
        const nullable = key === 'workspaceHash' || key === 'metaHash' || key === 'envelopeThreadIdHash' || key === 'innerSessionIdHash';
        if (value === null) {
          if (!nullable) throw probeError('PROBE_EVENT_INVALID', `capture-started requires ${key} to be a 64 hexadecimal hash.`);
        } else if (!HASH_PATTERN.test(/** @type {string} */ (value))) {
          throw probeError('PROBE_EVENT_INVALID', `capture-started requires ${key} to be ${nullable ? 'null or ' : ''}a 64 hexadecimal hash.`);
        }
      }
      for (const key of ['metaFields', 'envelopeFields']) {
        if (event[key] === undefined) continue;
        if (!Array.isArray(event[key]) || /** @type {unknown[]} */ (event[key]).length > MAXIMUM_META_FIELD_ENTRIES) {
          throw probeError('PROBE_EVENT_INVALID', `capture-started ${key} must be a bounded array.`);
        }
        for (const entry of /** @type {unknown[]} */ (event[key])) {
          if (!Array.isArray(entry) || entry.length !== 2 || !isBoundedText(entry[0]) || !isBoundedText(entry[1])) {
            throw probeError('PROBE_EVENT_INVALID', `capture-started ${key} entries must be bounded [name, type] pairs.`);
          }
        }
      }
      break;
    }
    case 'hold-started': {
      if (!CALL_NONCE_PATTERN.test(/** @type {string} */ (event.callNonce))) throw probeError('PROBE_EVENT_INVALID', 'hold-started requires a 32 hexadecimal callNonce.');
      break;
    }
    case 'capture-settled': {
      if (!CALL_NONCE_PATTERN.test(/** @type {string} */ (event.callNonce))) throw probeError('PROBE_EVENT_INVALID', 'capture-settled requires a 32 hexadecimal callNonce.');
      break;
    }
    case 'hold-settled': {
      if (!CALL_NONCE_PATTERN.test(/** @type {string} */ (event.callNonce))) throw probeError('PROBE_EVENT_INVALID', 'hold-settled requires a 32 hexadecimal callNonce.');
      if (typeof event.settlement !== 'string' || !SETTLEMENTS.includes(event.settlement)) {
        throw probeError('PROBE_EVENT_INVALID', 'hold-settled requires a closed settlement value.');
      }
      break;
    }
    case 'phase-observed': {
      if (typeof event.phase !== 'string' || !PROBE_PHASES.includes(event.phase)) throw probeError('PROBE_EVENT_INVALID', 'phase-observed requires a closed probe phase.');
      if (typeof event.observed !== 'boolean') throw probeError('PROBE_EVENT_INVALID', 'phase-observed requires an observed boolean.');
      break;
    }
    case 'hook-observed': {
      if (typeof event.hook !== 'string' || !HOOK_NAMES.includes(event.hook)) throw probeError('PROBE_EVENT_INVALID', 'hook-observed requires a closed hook name.');
      for (const key of ['sessionHash', 'turnHash', 'agentHash']) {
        if (key === 'sessionHash') {
          if (!HASH_PATTERN.test(/** @type {string} */ (event.sessionHash))) throw probeError('PROBE_EVENT_INVALID', 'hook-observed requires sessionHash to be a 64 hexadecimal salted hash.');
        } else {
          validateNullableHash(event, 'hook-observed', key);
        }
      }
      break;
    }
    case 'authority-hash': {
      if (typeof event.authority !== 'string' || !AUTHORITY_HASH_KINDS.includes(event.authority)) throw probeError('PROBE_EVENT_INVALID', 'authority-hash requires a closed authority kind.');
      if (typeof event.scope !== 'string' || !PROBE_EQUALITY_SCOPES.includes(event.scope)) throw probeError('PROBE_EVENT_INVALID', 'authority-hash requires a closed scope.');
      if (!HASH_PATTERN.test(/** @type {string} */ (event.hash))) throw probeError('PROBE_EVENT_INVALID', 'authority-hash requires hash to be a 64 hexadecimal salted hash.');
      break;
    }
    case 'equality-fact': {
      if (typeof event.scope !== 'string' || !PROBE_EQUALITY_SCOPES.includes(event.scope)) throw probeError('PROBE_EVENT_INVALID', 'equality-fact requires a closed scope.');
      if (typeof event.candidate !== 'string' || !PROBE_EQUALITY_CANDIDATES.includes(event.candidate)) throw probeError('PROBE_EVENT_INVALID', 'equality-fact requires a closed candidate field.');
      if (typeof event.authority !== 'string' || !PROBE_EQUALITY_AUTHORITIES.includes(event.authority)) throw probeError('PROBE_EVENT_INVALID', 'equality-fact requires a closed authority field.');
      if (typeof event.equal !== 'boolean') throw probeError('PROBE_EVENT_INVALID', 'equality-fact requires an equal boolean.');
      break;
    }
    case 'lifecycle-observed': {
      if (typeof event.lifecycleCase !== 'string' || !PROBE_LIFECYCLE_CASES.includes(event.lifecycleCase)) throw probeError('PROBE_EVENT_INVALID', 'lifecycle-observed requires a closed lifecycle case.');
      for (const [field, allowed] of Object.entries(OBSERVATION_ENUMS)) {
        if (typeof event[field] !== 'string' || !allowed.includes(event[field])) {
          throw probeError('PROBE_EVENT_INVALID', `lifecycle-observed requires ${field} from its closed vocabulary.`);
        }
      }
      break;
    }
    case 'app-server-control': {
      // The amended 0.155.1 controls' durable record: a closed control, an
      // outcome from that control's own closed subset, and a bounded
      // non-negative integer capture count — never ids, paths, or values.
      if (typeof event.control !== 'string' || !PROBE_APP_SERVER_CONTROLS.includes(event.control)) {
        throw probeError('PROBE_EVENT_INVALID', 'app-server-control requires a closed control kind.');
      }
      const allowedOutcomes = PROBE_APP_SERVER_CONTROL_OUTCOMES[event.control] ?? [];
      if (typeof event.outcome !== 'string' || !allowedOutcomes.includes(event.outcome)) {
        throw probeError('PROBE_EVENT_INVALID', `app-server-control requires an outcome from the closed ${event.control} vocabulary.`);
      }
      if (!Number.isSafeInteger(event.captures) || /** @type {number} */ (event.captures) < 0) {
        throw probeError('PROBE_EVENT_INVALID', 'app-server-control requires a non-negative integer capture count.');
      }
      break;
    }
    default:
      throw probeError('PROBE_EVENT_KIND_UNKNOWN', 'Unknown probe event kind.');
  }
}

/**
 * Parses the bounded event log, validating every record and building the
 * terminal/start index. Assumes the caller holds the event lock.
 * @param {string} eventsPath @param {string} runNonce
 * @returns {{records:{runNonce:string, timestamp:string, event:object}[], terminals:Set<string>, starts:Set<string>}}
 */
async function parseEventLog(eventsPath, runNonce) {
  const bytes = await readBoundedEventLog(eventsPath);
  const text = bytes.toString('utf8');
  /** @type {{runNonce:string, timestamp:string, event:object}[]} */
  const records = [];
  /** @type {Set<string>} */
  const terminals = new Set();
  /** @type {Set<string>} */
  const starts = new Set();
  if (text.length === 0) return { records, terminals, starts };
  const lines = text.split('\n');
  if (lines.at(-1) !== '') throw probeError('PROBE_LOG_TORN', 'The probe event log ends with a partial line.');
  for (const line of lines.slice(0, -1)) {
    let record;
    try { record = JSON.parse(line); } catch {
      throw probeError('PROBE_LOG_MALFORMED', 'The probe event log contains a malformed JSON line.');
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw probeError('PROBE_LOG_MALFORMED', 'The probe event log contains a non-object record.');
    if (record.runNonce !== runNonce) throw probeError('PROBE_RUN_NONCE_FOREIGN', 'The probe event log contains a foreign run nonce.');
    if (typeof record.timestamp !== 'string' || Number.isNaN(Date.parse(record.timestamp))) {
      throw probeError('PROBE_LOG_MALFORMED', 'The probe event log contains a record without a timestamp.');
    }
    validateProbeEventBody(record.event);
    const body = /** @type {{kind:string, callNonce?:string}} */ (record.event);
    if (START_KINDS.includes(body.kind) && body.callNonce) starts.add(body.callNonce);
    if (TERMINAL_KINDS.includes(body.kind) && body.callNonce) {
      if (terminals.has(body.callNonce)) throw probeError('PROBE_TERMINAL_DUPLICATE', 'The probe event log contains a duplicate terminal event.');
      terminals.add(body.callNonce);
    }
    records.push(record);
  }
  return { records, terminals, starts };
}

/**
 * Opens the log without following a final symlink, rejects its declared size
 * before allocating, and reads at most the bound so concurrent growth cannot
 * bypass it. Assumes the caller holds the event lock.
 * @param {string} path
 */
async function readBoundedEventLog(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > PROBE_EVENTS_MAX_BYTES) throw probeError('PROBE_LOG_SIZE_BOUND', 'The probe event log exceeds its size bound.');
    const bytes = Buffer.alloc(PROBE_EVENTS_MAX_BYTES);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > PROBE_EVENTS_MAX_BYTES) throw probeError('PROBE_LOG_SIZE_BOUND', 'The probe event log exceeds its size bound.');
    return bytes.subarray(0, offset);
  } finally { await handle.close().catch(() => {}); }
}

/**
 * Appends one durable event under the advisory event lock. Rejects symlinks,
 * wrong-mode or oversized logs, foreign run nonces, unknown kinds, and
 * duplicate or startless terminal events.
 * @param {{runDirectory:string, runNonce:string, event:object}} input
 */
export async function appendProbeEvent(input) {
  const { runDirectory, runNonce, event } = input;
  if (!isAbsolute(runDirectory)) throw probeError('PROBE_RUN_DIRECTORY_INVALID', 'The probe run directory must be an absolute path.');
  if (!RUN_NONCE_PATTERN.test(runNonce)) throw probeError('PROBE_NONCE_INVALID', 'The probe run nonce must be 64 lowercase hexadecimal characters.');
  if (event && typeof event === 'object' && 'runNonce' in event && event.runNonce !== runNonce) {
    throw probeError('PROBE_RUN_NONCE_FOREIGN', 'The event runNonce does not match the probe run nonce.');
  }
  validateProbeEventBody(event);
  const eventsPath = join(runDirectory, 'events.jsonl');
  const lockPath = join(runDirectory, 'events.lock');
  return withFileLock(lockPath, async () => {
    const pathStats = await lstat(eventsPath).then((value) => value, (error) => {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    });
    if (pathStats) {
      if (pathStats.isSymbolicLink()) throw probeError('PROBE_LOG_SYMLINK', 'The probe event log must not be a symlink.');
      if (!pathStats.isFile()) throw probeError('PROBE_LOG_NOT_FILE', 'The probe event log path must be a regular file.');
      if (process.platform !== 'win32' && (pathStats.mode & 0o777) !== 0o600) {
        throw probeError('PROBE_LOG_MODE', 'The probe event log must be mode 0600.');
      }
      if (pathStats.size > PROBE_EVENTS_MAX_BYTES) throw probeError('PROBE_LOG_SIZE_BOUND', 'The probe event log exceeds its size bound.');
    }
    const history = pathStats ? await parseEventLog(eventsPath, runNonce) : { records: [], terminals: new Set(), starts: new Set() };
    const body = /** @type {{kind:string, callNonce?:string}} */ (event);
    if (TERMINAL_KINDS.includes(body.kind) && body.callNonce) {
      if (history.terminals.has(body.callNonce)) throw probeError('PROBE_TERMINAL_DUPLICATE', 'A terminal event already exists for this call nonce.');
      if (!history.starts.has(body.callNonce)) throw probeError('PROBE_TERMINAL_STARTLESS', 'A terminal event requires a matching start event.');
    }
    const record = { runNonce, timestamp: new Date().toISOString(), event };
    const line = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    if ((pathStats?.size ?? 0) + line.length > PROBE_EVENTS_MAX_BYTES) {
      throw probeError('PROBE_LOG_SIZE_BOUND', 'The probe event log exceeds its size bound.');
    }
    const handle = await open(eventsPath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const handleStats = await handle.stat();
      if (!handleStats.isFile()) throw probeError('PROBE_LOG_SYMLINK', 'The probe event log must be a regular file.');
      // The inode stays stable across lstat and FileHandle.stat on every
      // platform, including Windows; only the device value is unstable
      // there (scripts/lib/fs.mjs samePathHandleIdentity), so the identity
      // comparison always runs and dev joins it on POSIX alone.
      if (pathStats && (handleStats.ino !== pathStats.ino || (process.platform !== 'win32' && handleStats.dev !== pathStats.dev))) {
        throw probeError('PROBE_LOG_REPLACED', 'The probe event log was replaced while it was opened.');
      }
      await handle.writeFile(line);
      await handle.sync();
      if (process.platform !== 'win32') await handle.chmod(0o600);
    } finally { await handle.close(); }
  });
}

/**
 * Reads and validates the complete event log under the advisory event lock.
 * @param {{runDirectory:string, runNonce:string}} input
 * @returns {Promise<{runNonce:string, timestamp:string, event:object}[]>}
 */
export async function readProbeEvents(input) {
  const { runDirectory, runNonce } = input;
  if (!isAbsolute(runDirectory)) throw probeError('PROBE_RUN_DIRECTORY_INVALID', 'The probe run directory must be an absolute path.');
  if (!RUN_NONCE_PATTERN.test(runNonce)) throw probeError('PROBE_NONCE_INVALID', 'The probe run nonce must be 64 lowercase hexadecimal characters.');
  const eventsPath = join(runDirectory, 'events.jsonl');
  const lockPath = join(runDirectory, 'events.lock');
  return withFileLock(lockPath, async () => {
    const present = await lstat(eventsPath).then(() => true, (error) => {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    });
    return present ? (await parseEventLog(eventsPath, runNonce)).records : [];
  });
}

/** The exact `_meta` field path stored for a winning candidate. */
const CANDIDATE_FIELD_PATHS = Object.freeze({
  envelopeThreadId: '_meta.threadId',
  innerSessionId: '_meta.x-codex-turn-metadata.session_id',
  innerThreadId: '_meta.x-codex-turn-metadata.thread_id',
  innerTurnId: '_meta.x-codex-turn-metadata.turn_id',
});

/** Computes the closed equality-matrix key list. */
function equalityMatrixKeys() {
  const keys = [];
  for (const candidate of ['envelopeThreadId', 'innerSessionId', 'innerThreadId']) {
    for (const authority of PROBE_ROOT_THREAD_AUTHORITIES) keys.push(`root:${candidate}==${authority}`);
    for (const authority of PROBE_CHILD_THREAD_AUTHORITIES) keys.push(`child:${candidate}==${authority}`);
  }
  for (const authority of PROBE_TURN_AUTHORITIES) {
    keys.push(`root:innerTurnId==${authority}`);
    keys.push(`child:innerTurnId==${authority}`);
  }
  return keys.sort();
}

/**
 * Reduces a validated event sequence to the closed context-plus-lifecycle
 * result. Missing evidence yields false or `not-observed`; it never throws
 * for incompleteness and never relabels an observation.
 *
 * Context semantics: `identityFieldsVisible` means every matrix-phase capture
 * carries all four candidate hashes. `identityNamespaceQualified` requires at
 * least one exact Root and one exact Child thread/turn pair to match the
 * app-server/Hook authority namespace (an equality-fact cell is true only
 * when every recorded fact for that cell is equal, so a contradicted pair
 * can never qualify); distinctness alone is insufficient.
 * `serverLoadedWithConfig` requires the negative/positive A/B window, a
 * positive server start with canonical paths, and a successful positive tool
 * call. Lifecycle cases reduce exactly what the driver recorded, one
 * `lifecycle-observed` event per case, never relabeled.
 *
 * @param {{runNonce:string, timestamp:string, event:object}[]} records
 * @param {{runNonce:string, runDirectory?:string|null}} input
 */
export function reduceProbeEvents(records, { runNonce, runDirectory = null }) {
  if (!RUN_NONCE_PATTERN.test(runNonce)) throw probeError('PROBE_NONCE_INVALID', 'The probe run nonce must be 64 lowercase hexadecimal characters.');
  if (runDirectory !== null && !isAbsolute(runDirectory)) {
    throw probeError('PROBE_RUN_DIRECTORY_INVALID', 'The probe run directory must be an absolute path.');
  }
  /** @type {{event:any, phase:string|null, settled:boolean}[]} */
  const captures = [];
  /** @type {{event:any, phase:string|null, settlement:string|null}[]} */
  const holds = [];
  /** @type {{event:any, phase:string|null}[]} */
  const serverStarts = [];
  /** @type {Map<string, boolean[]>} */
  const equalityFacts = new Map();
  /** @type {Map<string, {event:any, phase:string|null}>} */
  const lifecycleObservations = new Map();
  /** @type {Map<string, boolean>} */
  const phaseObserved = new Map();
  /** @type {Map<string, number>} */
  const phaseIndex = new Map();
  let currentPhase = /** @type {string | null} */ (null);
  let phaseOrder = 0;
  /** @type {Map<string, {start:boolean, terminal:boolean}>} */
  const callState = new Map();
  for (const record of records) {
    if (!record || record.runNonce !== runNonce) throw probeError('PROBE_RUN_NONCE_FOREIGN', 'The event sequence contains a foreign run nonce.');
    validateProbeEventBody(record.event);
    const event = record.event;
    if (event.kind === 'phase-observed') {
      if (!phaseObserved.has(event.phase)) {
        phaseIndex.set(event.phase, phaseOrder);
        phaseOrder += 1;
      }
      // Last marker wins: a driver-observed failure overrides an earlier
      // optimistic marker so phase-dependent assertions fail honestly.
      phaseObserved.set(event.phase, event.observed);
      currentPhase = event.phase;
      continue;
    }
    if (event.kind === 'server-started') {
      serverStarts.push({ event, phase: currentPhase });
      continue;
    }
    if (event.kind === 'equality-fact') {
      const key = `${event.scope}:${event.candidate}==${event.authority}`;
      if (!equalityFacts.has(key)) equalityFacts.set(key, []);
      equalityFacts.get(key).push(event.equal);
      continue;
    }
    if (event.kind === 'lifecycle-observed') {
      // First observation per case wins; the final census rejects duplicates.
      if (!lifecycleObservations.has(event.lifecycleCase)) lifecycleObservations.set(event.lifecycleCase, { event, phase: currentPhase });
      continue;
    }
    if (START_KINDS.includes(event.kind)) {
      const state = callState.get(event.callNonce) ?? { start: false, terminal: false };
      if (state.start) throw probeError('PROBE_START_DUPLICATE', 'The event sequence contains a duplicate start event.');
      state.start = true;
      callState.set(event.callNonce, state);
      if (event.kind === 'capture-started') captures.push({ event, phase: currentPhase, settled: false });
      else holds.push({ event, phase: currentPhase, settlement: null });
      continue;
    }
    if (TERMINAL_KINDS.includes(event.kind)) {
      const state = callState.get(event.callNonce);
      if (!state || !state.start) throw probeError('PROBE_TERMINAL_STARTLESS', 'The event sequence contains a terminal event without a start.');
      if (state.terminal) throw probeError('PROBE_TERMINAL_DUPLICATE', 'The event sequence contains a duplicate terminal event.');
      state.terminal = true;
      if (event.kind === 'capture-settled') {
        const capture = captures.find((entry) => entry.event.callNonce === event.callNonce);
        if (capture) capture.settled = true;
      } else {
        const hold = holds.find((entry) => entry.event.callNonce === event.callNonce);
        if (hold) hold.settlement = event.settlement;
      }
    }
  }
  const matrixCaptures = captures.filter((entry) => entry.phase === 'matrix');
  const root = matrixCaptures[0];
  const child = matrixCaptures[1];
  const later = matrixCaptures[2];
  const concurrentOne = matrixCaptures[3];
  const concurrentTwo = matrixCaptures[4];
  const rootResume = matrixCaptures[5];
  const candidateFieldsComplete = (entry) => Boolean(entry && entry.event.envelopeThreadIdHash && entry.event.innerSessionIdHash
    && entry.event.threadHash && entry.event.turnHash);
  const identityFieldsVisible = matrixCaptures.length > 0 && matrixCaptures.every(candidateFieldsComplete);
  // The later-turn proof is only meaningful for a Child whose thread is
  // distinct from the Root: a host that reports the Root thread for the
  // initial Child must fail this assertion, not pass it vacuously.
  const laterTurnDistinct = Boolean(root && child && later
    && root.event.threadHash && child.event.threadHash
    && child.event.threadHash !== root.event.threadHash
    && later.event.threadHash && child.event.threadHash
    && later.event.threadHash === child.event.threadHash
    && later.event.turnHash && child.event.turnHash
    && later.event.turnHash !== child.event.turnHash
    && later.event.metaHash && child.event.metaHash
    && later.event.metaHash !== child.event.metaHash);
  const identityThreads = [root, child, later].filter(Boolean).map((entry) => entry.event.threadHash);
  const concurrentChildrenDistinct = Boolean(concurrentOne && concurrentTwo
    && concurrentOne.settled && concurrentTwo.settled
    && concurrentOne.event.threadHash && concurrentTwo.event.threadHash
    && concurrentOne.event.threadHash !== concurrentTwo.event.threadHash
    && identityThreads.every((threadHash) => threadHash
      && threadHash !== concurrentOne.event.threadHash && threadHash !== concurrentTwo.event.threadHash));
  // The Root-resume sink: the state-machine step-2 capture must sit on the
  // Root conversation's thread and carry a new turn identity.
  const metadataChangesAcrossTurns = Boolean(root && rootResume && rootResume.settled
    && root.event.threadHash && root.event.turnHash && root.event.metaHash
    && rootResume.event.threadHash && rootResume.event.turnHash && rootResume.event.metaHash
    && rootResume.event.threadHash === root.event.threadHash
    && rootResume.event.turnHash !== root.event.turnHash
    && rootResume.event.metaHash !== root.event.metaHash);
  // The A/B combination: positive-phase startup evidence with canonical
  // observer paths, and a successful positive tool call, over a
  // negative-control window provably free of any server-started or
  // capture-started event before its driver-recorded marker.
  const negativeControlMarker = records.findIndex((record) => record.event.kind === 'phase-observed' && record.event.phase === 'negative-control');
  const negativeControlWindowClean = negativeControlMarker >= 0
    && phaseObserved.get('negative-control') === true
    && records.slice(0, negativeControlMarker).every((record) => record.event.kind !== 'server-started' && record.event.kind !== 'capture-started');
  const positiveServerStartPresent = serverStarts.some((entry) => POSITIVE_SERVER_PHASES.includes(entry.phase)
    && (!runDirectory
      || (entry.event.eventsPath === join(runDirectory, 'events.jsonl') && entry.event.lockPath === join(runDirectory, 'events.lock'))));
  const positiveToolCallPresent = captures.some((entry) => POSITIVE_SERVER_PHASES.includes(entry.phase) && entry.settled);
  const serverLoadedWithConfig = Boolean(negativeControlWindowClean && positiveServerStartPresent && positiveToolCallPresent);
  // Salted equality matrix: a cell is true only when every recorded fact for
  // that exact pair is equal; missing evidence is false.
  const equalityMatrix = {};
  for (const key of equalityMatrixKeys()) {
    const facts = equalityFacts.get(key);
    equalityMatrix[key] = Boolean(facts && facts.length > 0 && facts.every((equal) => equal === true));
  }
  const cellTrue = (scope, candidate, authority) => equalityMatrix[`${scope}:${candidate}==${authority}`] === true;
  // The authority chains: one exact Root and one exact Child thread/turn pair
  // must match the app-server/Hook authority namespace. Distinctness alone is
  // insufficient, and hook-column contradictions are recorded but the
  // qualifying pair is the app-server thread/turn join the plan's Task 4
  // resolver consumes.
  const threadWinner = (scope) => ['envelopeThreadId', 'innerSessionId', 'innerThreadId']
    .find((candidate) => cellTrue(scope, candidate, 'appServerThreadId')) ?? null;
  const rootThreadWinner = threadWinner('root');
  const childThreadWinner = threadWinner('child');
  const turnQualified = cellTrue('root', 'innerTurnId', 'appServerTurnId') && cellTrue('child', 'innerTurnId', 'appServerTurnId');
  // The Host/Hook join is part of the required chain, with the authority
  // mapping the Task 4 join table specifies: the Root thread authority is
  // the Hook session id, while the Child thread/executor authority is the
  // Hook agent id (the SubagentStart hook reports the spawn's agent id —
  // the recorded matrix confirms the child's thread candidates join
  // hookAgentId, not hookSessionId); both scopes' turns join the Hook turn
  // id. The winning candidates — resolved independently per scope — must
  // SATISFY their hook cells (at least one fact and every fact true): a
  // candidate that matches the app-server authority but contradicts the
  // corresponding Hook identity must not qualify, and hook facts merely
  // existing is not enough. The hook cells' values stay honest in the
  // matrix.
  const hookJoinQualified = rootThreadWinner !== null && childThreadWinner !== null
    && cellTrue('root', rootThreadWinner, 'hookSessionId')
    && cellTrue('child', childThreadWinner, 'hookAgentId')
    && cellTrue('root', 'innerTurnId', 'hookTurnId')
    && cellTrue('child', 'innerTurnId', 'hookTurnId');
  const identityNamespaceQualified = Boolean(rootThreadWinner && childThreadWinner && turnQualified && hookJoinQualified);
  const authorityFields = {
    rootThread: rootThreadWinner ? CANDIDATE_FIELD_PATHS[rootThreadWinner] : null,
    childThread: childThreadWinner ? CANDIDATE_FIELD_PATHS[childThreadWinner] : null,
    turn: turnQualified ? CANDIDATE_FIELD_PATHS.innerTurnId : null,
  };
  const assertions = {
    identityFieldsVisible,
    identityNamespaceQualified,
    laterTurnDistinct,
    concurrentChildrenDistinct,
    metadataChangesAcrossTurns,
    serverLoadedWithConfig,
  };
  const lifecycle = {};
  for (const lifecycleCase of PROBE_LIFECYCLE_CASES) {
    const observation = lifecycleObservations.get(lifecycleCase);
    lifecycle[lifecycleCase] = observation
      ? {
          hostProcess: observation.event.hostProcess,
          turnTerminalStatus: observation.event.turnTerminalStatus,
          toolCallOutcome: observation.event.toolCallOutcome,
          handlerSettlement: observation.event.handlerSettlement,
          transportState: observation.event.transportState,
          hookEvent: observation.event.hookEvent,
          unknownReason: observation.event.unknownReason,
        }
      // A case the run never recorded previews as fully unobserved; the
      // final census refuses to write a result with any missing case.
      : {
          hostProcess: 'not-observed',
          turnTerminalStatus: 'not-observed',
          toolCallOutcome: 'not-observed',
          handlerSettlement: 'not-observed',
          transportState: 'not-observed',
          hookEvent: 'not-observed',
          unknownReason: 'unsupported',
        };
  }
  return {
    context: { assertions, authorityFields, equalityMatrix },
    lifecycle,
  };
}

/**
 * Validates that a finished run's log supports the closed record: every
 * phase observed in canonical order, the exact matrix capture census, the
 * exact held-call census, one lifecycle observation per case, and canonical
 * observer paths.
 * @param {{runNonce:string, timestamp:string, event:object}[]} records
 * @param {{runDirectory:string, result:Record<string,boolean>}} input
 */
function assertCompleteQualificationLog(records, { runDirectory }) {
  const canonicalEventsPath = join(runDirectory, 'events.jsonl');
  const canonicalLockPath = join(runDirectory, 'events.lock');
  let captures = 0;
  let settledCaptures = 0;
  let matrixCaptures = 0;
  let matrixSettledCaptures = 0;
  let holds = 0;
  let serverStarts = 0;
  let currentPhase = null;
  const callNonceTerminal = new Set();
  const callNonceMatrix = new Map();
  /** @type {Map<string, number>} */
  const holdsByPhase = new Map();
  /** @type {Map<string, number>} */
  const lifecycleCounts = new Map();
  const controlCounts = new Map();
  /** @type {string[]} */
  const controlOrder = [];
  for (const record of records) {
    const event = record.event;
    if (event.kind === 'phase-observed') currentPhase = event.phase;
    if (event.kind === 'capture-started') {
      captures += 1;
      callNonceMatrix.set(event.callNonce, currentPhase);
      if (currentPhase === 'matrix') matrixCaptures += 1;
    }
    if (event.kind === 'capture-settled') {
      settledCaptures += 1;
      callNonceTerminal.add(event.callNonce);
      if (callNonceMatrix.get(event.callNonce) === 'matrix') matrixSettledCaptures += 1;
    }
    if (event.kind === 'hold-started') {
      holds += 1;
      holdsByPhase.set(currentPhase ?? 'unknown', (holdsByPhase.get(currentPhase ?? 'unknown') ?? 0) + 1);
    }
    if (event.kind === 'server-started') {
      serverStarts += 1;
      // Every Host process starts its own stdio server, so each startup —
      // not a single global one — must record the canonical observer paths.
      if (event.eventsPath !== canonicalEventsPath || event.lockPath !== canonicalLockPath) {
        throw probeError('PROBE_LOG_INCOMPLETE', 'The observer recorded non-canonical event paths.');
      }
    }
    if (event.kind === 'lifecycle-observed') {
      lifecycleCounts.set(event.lifecycleCase, (lifecycleCounts.get(event.lifecycleCase) ?? 0) + 1);
    }
    if (event.kind === 'app-server-control') {
      controlCounts.set(event.control, (controlCounts.get(event.control) ?? 0) + 1);
      if (!controlOrder.includes(event.control)) controlOrder.push(event.control);
    }
  }
  // At least one durable startup proves the probe server itself ran with
  // these paths; externally fabricated capture evidence without it can never
  // produce a result.
  if (serverStarts < 1) {
    throw probeError('PROBE_LOG_INCOMPLETE', 'The qualification log must contain a server-started event with canonical observer paths.');
  }
  // Every observed phase must appear, and their first occurrences must follow
  // the canonical phase order (negative control before the positive phases).
  /** @type {Map<string, number>} */
  const firstOccurrence = new Map();
  let scanOrder = 0;
  for (const record of records) {
    const event = record.event;
    if (event.kind === 'phase-observed' && event.observed && !firstOccurrence.has(event.phase)) {
      firstOccurrence.set(event.phase, scanOrder);
      scanOrder += 1;
    }
  }
  let previousOrder = -1;
  for (const phaseName of PROBE_PHASES) {
    if (!firstOccurrence.has(phaseName)) throw probeError('PROBE_LOG_INCOMPLETE', `The qualification log is missing observed phase ${phaseName}.`);
    const order = /** @type {number} */ (firstOccurrence.get(phaseName));
    if (order <= previousOrder) throw probeError('PROBE_LOG_INCOMPLETE', 'The qualification log records phases out of canonical order.');
    previousOrder = order;
  }
  // The scripted matrix is exactly five captures (Root, initial Child, Child
  // later turn, two concurrent Children) plus the state-machine step-2
  // Root-resume capture, all settled. Best-effort captures outside the
  // matrix phase (the app-server treatment/control turns and the
  // transport-control diagnostic) are tolerated observations
  // but must also have settled.
  if (captures !== settledCaptures) throw probeError('PROBE_LOG_INCOMPLETE', 'The qualification log contains unsettled capture calls.');
  if (matrixCaptures !== 6 || matrixSettledCaptures !== 6) throw probeError('PROBE_LOG_INCOMPLETE', 'The qualification log must contain exactly six settled matrix capture calls.');
  // Exactly one driver-driven held call per CLI/timeout lifecycle phase; the
  // app-server held call is model-dependent (0 or 1). Settlements are
  // observations, not requirements: a pending hold is honest evidence.
  for (const phaseName of ['cli-sigint', 'cli-sigkill', 'plugin-tool-timeout', 'direct-config-timeout']) {
    if ((holdsByPhase.get(phaseName) ?? 0) !== 1) {
      throw probeError('PROBE_LOG_INCOMPLETE', `The qualification log must contain exactly one hold-started call in ${phaseName}.`);
    }
  }
  const appServerHolds = holdsByPhase.get('app-server-interrupt') ?? 0;
  if (appServerHolds > 1) throw probeError('PROBE_LOG_INCOMPLETE', 'The qualification log contains extra app-server held calls.');
  if (holds < 4 || holds > 5) throw probeError('PROBE_LOG_INCOMPLETE', 'The qualification log must contain four or five hold-started lifecycle calls.');
  // One lifecycle observation per closed case, and nothing else.
  for (const lifecycleCase of PROBE_LIFECYCLE_CASES) {
    const count = lifecycleCounts.get(lifecycleCase) ?? 0;
    if (count !== 1) throw probeError('PROBE_LOG_INCOMPLETE', `The qualification log must contain exactly one lifecycle observation for ${lifecycleCase}.`);
  }
  if (lifecycleCounts.size !== PROBE_LIFECYCLE_CASES.length) {
    throw probeError('PROBE_LOG_INCOMPLETE', 'The qualification log contains lifecycle observations outside the closed vocabulary.');
  }
  // The amended 0.155.1 controls must be durable: exactly one
  // app-server-control event per closed control, in the driver's canonical
  // order, each already schema-validated on append. Without them the log
  // cannot substantiate the three-way Skill-resolution / structured-
  // injection / model-tool-selection distinction, and no result may be
  // reduced from it.
  for (const control of PROBE_APP_SERVER_CONTROLS) {
    if ((controlCounts.get(control) ?? 0) !== 1) {
      throw probeError('PROBE_LOG_INCOMPLETE', `The qualification log must contain exactly one app-server-control event for ${control}.`);
    }
  }
  if (controlCounts.size !== PROBE_APP_SERVER_CONTROLS.length) {
    throw probeError('PROBE_LOG_INCOMPLETE', 'The qualification log contains app-server-control events outside the closed vocabulary.');
  }
  let previousControlIndex = -1;
  for (const control of PROBE_APP_SERVER_CONTROLS) {
    const index = controlOrder.indexOf(control);
    if (index <= previousControlIndex) {
      throw probeError('PROBE_LOG_INCOMPLETE', 'The qualification log records app-server-control events out of canonical order.');
    }
    previousControlIndex = index;
  }
}

/**
 * The driver's final reducer: under the event lock, validates the complete
 * log and atomically writes mode-0600 `result.json` exactly once.
 * @param {{runDirectory:string, runNonce:string}} input
 */
export async function reduceProbeResult(input) {
  const { runDirectory, runNonce } = input;
  if (!isAbsolute(runDirectory)) throw probeError('PROBE_RUN_DIRECTORY_INVALID', 'The probe run directory must be an absolute path.');
  if (!RUN_NONCE_PATTERN.test(runNonce)) throw probeError('PROBE_NONCE_INVALID', 'The probe run nonce must be 64 lowercase hexadecimal characters.');
  const eventsPath = join(runDirectory, 'events.jsonl');
  const lockPath = join(runDirectory, 'events.lock');
  const resultPath = join(runDirectory, 'result.json');
  return withFileLock(lockPath, async () => {
    const { records } = await parseEventLog(eventsPath, runNonce);
    const result = reduceProbeEvents(records, { runNonce, runDirectory });
    assertCompleteQualificationLog(records, { runDirectory });
    const existing = await lstat(resultPath).then(() => true, (error) => {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    });
    if (existing) throw probeError('PROBE_RESULT_EXISTS', 'result.json already exists; only the final reducer may write it once.');
    const temporaryPath = join(runDirectory, `.result.json.${process.pid}.${randomBytes(12).toString('hex')}.tmp`);
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporaryPath, resultPath);
    if (process.platform !== 'win32') await chmod(resultPath, 0o600);
    return result;
  });
}

/**
 * Returns the canonical observer paths for a run directory. Probe-only
 * convenience for the driver and server startup checks.
 * @param {string} runDirectory
 */
export function probeEventPaths(runDirectory) {
  if (!isAbsolute(runDirectory)) throw probeError('PROBE_RUN_DIRECTORY_INVALID', 'The probe run directory must be an absolute path.');
  return { eventsPath: join(runDirectory, 'events.jsonl'), lockPath: join(runDirectory, 'events.lock') };
}
