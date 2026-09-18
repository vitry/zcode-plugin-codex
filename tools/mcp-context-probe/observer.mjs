// @ts-nocheck
/**
 * Durable append-only evidence store for the disposable Codex MCP context
 * probe. The observer owns `<run>/events.jsonl`; only the final reducer owns
 * `<run>/result.json`. Every record carries the probe-run nonce, a closed
 * event enum, a call nonce, and hashes/equality booleans — never raw identity.
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, open, rename } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { withFileLock } from '../../scripts/lib/fs.mjs';

/** Maximum accepted size of the JSONL event log in bytes. */
export const PROBE_EVENTS_MAX_BYTES = 4 * 1024 * 1024;

/** The closed qualification phase vocabulary, in required order. */
export const PROBE_PHASES = Object.freeze(['negative-control', 'matrix', 'sigint-cancel', 'sigkill-disconnect', 'short-timeout']);

/** The phases whose Host spawns must durably start the probe server. */
const POSITIVE_SERVER_PHASES = Object.freeze(['matrix', 'sigint-cancel', 'sigkill-disconnect', 'short-timeout']);

/**
 * The exact settlement kind(s) each held-call phase accepts as delivery: a
 * settlement of the wrong kind is not delivery. SIGINT cancellation must be
 * the server's explicit abort settlement (a Host that exits and merely
 * closes stdin records a transport close, which is not cancellation); the
 * tool timeout accepts the abort or a recorded host-timeout settlement;
 * connection loss is exactly the transport-close settlement written by the
 * stdin watcher.
 */
const PHASE_SETTLEMENT_KINDS = Object.freeze({
  'sigint-cancel': Object.freeze(['signal-abort']),
  'sigkill-disconnect': Object.freeze(['transport-close']),
  'short-timeout': Object.freeze(['signal-abort', 'host-timeout']),
});

/** The closed eight-boolean result vocabulary. */
export const PROBE_RESULT_KEYS = Object.freeze([
  'cancelDelivered', 'concurrentChildrenDistinct', 'connectionLossDelivered',
  'laterTurnDistinct', 'metadataChangesAcrossTurns', 'rootIdentityComplete',
  'serverLoadedWithConfig', 'shortTimeoutSettled',
]);

const EVENT_KINDS = Object.freeze([
  'server-started', 'capture-started', 'capture-settled',
  'hold-started', 'hold-settled', 'phase-observed',
]);
const TERMINAL_KINDS = Object.freeze(['capture-settled', 'hold-settled']);
const START_KINDS = Object.freeze(['capture-started', 'hold-started']);
const SETTLEMENTS = Object.freeze(['signal-abort', 'transport-close', 'host-timeout']);
const HASH_KEYS = Object.freeze(['threadHash', 'turnHash', 'workspaceHash', 'metaHash']);
const EVENT_ALLOWED_KEYS = Object.freeze({
  'server-started': Object.freeze(['kind', 'serverPid', 'eventsPath', 'lockPath']),
  'phase-observed': Object.freeze(['kind', 'phase', 'observed']),
  'capture-started': Object.freeze(['kind', 'callNonce', 'identityComplete', 'threadHash', 'turnHash', 'workspaceHash', 'metaHash', 'metaFields', 'envelopeFields']),
  'capture-settled': Object.freeze(['kind', 'callNonce']),
  'hold-started': Object.freeze(['kind', 'callNonce']),
  'hold-settled': Object.freeze(['kind', 'callNonce', 'settlement']),
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
        const nullable = key === 'workspaceHash' || key === 'metaHash';
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

/**
 * Reduces a validated event sequence to the closed eight-boolean result.
 * Missing evidence yields false; it never throws for incompleteness.
 * `runDirectory` is optional; when supplied, positive server startups must
 * carry the canonical observer paths for that directory (the final reducer
 * always supplies it).
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
  const phase = (name) => phaseIndex.has(name) && phaseObserved.get(name) === true;
  const phaseOrderStrictlyIncreasing = PROBE_PHASES.filter((name) => phaseIndex.has(name))
    .every((name, position, list) => position === 0 || /** @type {number} */ (phaseIndex.get(list[position - 1])) < /** @type {number} */ (phaseIndex.get(name)));
  const matrixCaptures = captures.filter((entry) => entry.phase === 'matrix');
  const root = matrixCaptures[0];
  const child = matrixCaptures[1];
  const later = matrixCaptures[2];
  const concurrentOne = matrixCaptures[3];
  const concurrentTwo = matrixCaptures[4];
  const rootResume = matrixCaptures[5];
  const rootIdentityComplete = Boolean(phase('matrix') && root && root.settled
    && root.event.identityComplete === true && root.event.threadHash && root.event.turnHash);
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
  // observer paths, and a negative-control window provably free of any
  // server-started or capture-started event before its driver-recorded marker.
  const negativeControlMarker = records.findIndex((record) => record.event.kind === 'phase-observed' && record.event.phase === 'negative-control');
  const negativeControlWindowClean = negativeControlMarker >= 0
    && phaseObserved.get('negative-control') === true
    && records.slice(0, negativeControlMarker).every((record) => record.event.kind !== 'server-started' && record.event.kind !== 'capture-started');
  const positiveServerStartPresent = serverStarts.some((entry) => POSITIVE_SERVER_PHASES.includes(entry.phase)
    && (!runDirectory
      || (entry.event.eventsPath === join(runDirectory, 'events.jsonl') && entry.event.lockPath === join(runDirectory, 'events.lock'))));
  const serverLoadedWithConfig = Boolean(negativeControlWindowClean && positiveServerStartPresent);
  const phaseHoldSettled = (name) => {
    if (!phase(name) || !phaseOrderStrictlyIncreasing) return false;
    const hold = holds.find((entry) => entry.phase === name);
    return Boolean(hold && hold.settlement !== null && PHASE_SETTLEMENT_KINDS[name].includes(hold.settlement));
  };
  return /** @type {Record<string, boolean>} */ ({
    rootIdentityComplete,
    laterTurnDistinct,
    concurrentChildrenDistinct,
    metadataChangesAcrossTurns,
    serverLoadedWithConfig,
    cancelDelivered: phaseHoldSettled('sigint-cancel'),
    connectionLossDelivered: phaseHoldSettled('sigkill-disconnect'),
    shortTimeoutSettled: phaseHoldSettled('short-timeout'),
  });
}

/**
 * Validates that a finished run's log supports a qualified record: every
 * phase observed in canonical order, every call settled, canonical observer
 * paths, and the expected capture/hold census.
 * @param {{runNonce:string, timestamp:string, event:object}[]} records
 * @param {{runDirectory:string, result:Record<string,boolean>}} input
 */
function assertCompleteQualificationLog(records, { runDirectory, result }) {
  const canonicalEventsPath = join(runDirectory, 'events.jsonl');
  const canonicalLockPath = join(runDirectory, 'events.lock');
  let captures = 0;
  let settledCaptures = 0;
  let holds = 0;
  let settledHolds = 0;
  let serverStarts = 0;
  for (const record of records) {
    const event = record.event;
    if (event.kind === 'capture-started') captures += 1;
    if (event.kind === 'capture-settled') settledCaptures += 1;
    if (event.kind === 'hold-started') holds += 1;
    if (event.kind === 'hold-settled') settledHolds += 1;
    if (event.kind === 'server-started') {
      serverStarts += 1;
      // Every Host process starts its own stdio server, so each startup —
      // not a single global one — must record the canonical observer paths.
      if (event.eventsPath !== canonicalEventsPath || event.lockPath !== canonicalLockPath) {
        throw probeError('PROBE_LOG_INCOMPLETE', 'The observer recorded non-canonical event paths.');
      }
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
  // Five matrix captures (Root, initial Child, Child later turn, two
  // concurrent Children) plus the state-machine step-2 Root-resume capture.
  if (captures !== 6 || settledCaptures !== 6) throw probeError('PROBE_LOG_INCOMPLETE', 'The qualification log must contain exactly six settled capture calls.');
  // The scripted matrix contains exactly one held call per cancellation
  // phase; extra invocations would let a phase's reduced settlement point at
  // a different call than the driver validated.
  if (holds !== 3 || settledHolds !== holds) throw probeError('PROBE_LOG_INCOMPLETE', 'The qualification log must contain exactly three settled hold calls.');
  for (const value of Object.values(result)) {
    if (value !== true) throw probeError('PROBE_LOG_INCOMPLETE', 'The qualification log contains false assertions.');
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
    assertCompleteQualificationLog(records, { runDirectory, result });
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
