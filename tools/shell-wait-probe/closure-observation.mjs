// @ts-check
/**
 * Research-only closure observation seam for the 2026-10-21 evidence-closure
 * Task 2 (plan §2/§3; report §19.3 freeze — implemented WITHOUT re-deciding
 * any frozen parameter).
 *
 * Two strictly separated halves:
 *
 * 1. The FIXTURE-GENERATED preload (`closurePreloadSource` /
 *    `writeClosurePreload`): a passive stdout tee for the exact selected
 *    `invoke-prepared rescue` launcher invocation. The repository ships only
 *    the SOURCE STRING; an executable copy exists exclusively inside the
 *    disposable fixture (or an offline pipeline test's temp root), where the
 *    fixture composes it into NODE_OPTIONS. The gate is the frozen §19.3
 *    selector: the fixture-only capture environment must be present and
 *    well-formed, `realpathSync(process.argv[1])` must equal the
 *    fixture-declared installed launcher realpath, and `process.argv.slice(2)`
 *    must be exactly `['invoke-prepared','rescue']` — the preload is INERT in
 *    every other process (preparation entries, Status, the background runner,
 *    the companion entry, foreign Node processes). On match it tees every
 *    `process.stdout.write` chunk (string with explicit/default encoding, or
 *    a Buffer/TypedArray) to one private `wx` 0600 capture file, delegates the
 *    ORIGINAL write call through unchanged (same arguments, same return
 *    value, same callback dispatch), and records at process exit one bounded
 *    meta record: captureComplete, truncated, byteCount, captureSha256 (the
 *    SHA-256 of the captured stdout bytes, computed AT CAPTURE CLOSE by the
 *    preload over exactly the bytes it wrote), maxBytes 65536, exitCode,
 *    argv, entryRealpath, durationMs. Bytes beyond 64 KiB set `truncated` and
 *    the capture stays INCOMPLETE (fail closed, never a partial expectation).
 *    Capture failure is a NAMED observer failure recorded in the meta record
 *    — never a replaced business result: production stdout delivery and
 *    `process.exitCode` are untouched either way.
 *
 * 2. The read side (`admitStdoutCapture`): a purely offline adjudicator that
 *    admits/validates a capture pair and re-verifies the captured bytes
 *    against the capture-time digest BEFORE use (the oracle consumes the
 *    capture-time digest; this module never re-derives it). Missing,
 *    incomplete (no final exit/flush meta), truncated, and tampered captures
 *    are NAMED observer failures that expose NO stdout — never a replaced
 *    business result, never bytes reconstructed from the merged transcript.
 *    `closureExactLinkage` joins an admitted capture and an independently
 *    derived production expectation to the frozen `evaluateExactTerminalLinkage`
 *    oracle; an unestablished expectation stays unestablished.
 *
 * This module is a research instrument only: it authorizes nothing, mutates
 * no production state, and is imported solely by the research fixture/driver
 * and the opt-in shell-research tests. Its own provenance follows the module
 * convention: `CLOSURE_OBSERVATION_VERSION` stamps every admission verdict
 * and `EXECUTING_CLOSURE_OBSERVATION_SOURCE` is the module-init snapshot the
 * driver's observer digest binds (every helper executing during observation
 * enters the observer digest).
 */
import { createHash } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { lstat, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

import { resumableJobIndicator } from '../../scripts/lib/job-control.mjs';

import { readBoundedJsonFile, readPrivateDirectory } from '../../scripts/lib/fs.mjs';
import { isSafeIdentifier } from '../../scripts/lib/identifier.mjs';
import { endedObligationSettled, isMarkedRunnerClaim, TERMINAL } from '../../scripts/lib/recovery.mjs';
import { EFFORT_LEVELS, JOB_COMMANDS, JOB_STATUSES, validProgressProbe } from '../../scripts/lib/state.mjs';
import { MAX_PROGRESS_MESSAGE_BYTES, MAX_PROGRESS_PREVIEW_ENTRIES, PROGRESS_PHASES } from '../../scripts/lib/progress.mjs';
import { validDetachedRescueRunnerJob, validateRescueExecutionInput } from '../../scripts/lib/rescue-execution-input.mjs';
import { STOP_CAUSES, readRescueBindingAuthorityFile, readRescueBindingPartitionFile, rescueBindingPartitionKey, validHostLifecycleRecord, validStopIntent } from '../../scripts/lib/rescue-binding.mjs';
import { evaluateExactTerminalLinkage } from './release-qualification.mjs';

/** The closed version carried by every admission verdict of this module. */
export const CLOSURE_OBSERVATION_VERSION = 1;

/** The frozen §19.3 fail-closed terminal stdout capture bound. */
export const STDOUT_CAPTURE_MAX_BYTES = 65_536;

/** The frozen exact terminal argv selector (launcher.mjs ALLOWED set). */
const TERMINAL_ARGV_SELECTOR = Object.freeze(['invoke-prepared', 'rescue']);

/** Fixture-only capture environment variables (the (1) gate of §19.3(b)). */
export const CAPTURE_DIRECTORY_VARIABLE = 'ZCODE_SHELL_WAIT_CAPTURE_DIR';
export const CAPTURE_NONCE_VARIABLE = 'ZCODE_SHELL_WAIT_CAPTURE_NONCE';
export const CAPTURE_ENTRY_VARIABLE = 'ZCODE_SHELL_WAIT_CAPTURE_ENTRY_REALPATH';
export const CAPTURE_MAX_BYTES_VARIABLE = 'ZCODE_SHELL_WAIT_CAPTURE_MAX_BYTES';

/** Bounded meta record size (the meta contract is a small closed JSON). */
const CAPTURE_META_MAX_BYTES = 4 * 1024;

/** Module-INIT snapshot of THIS module's executing source (the same provenance discipline as evidence.mjs/release-qualification.mjs). */
export const EXECUTING_CLOSURE_OBSERVATION_SOURCE = readFileSync(fileURLToPath(import.meta.url));

const HEX_64 = /^[a-f0-9]{64}$/u;

/** @param {string} message @returns {TypeError} */
function invalidClosureInput(message) {
  return new TypeError(`Invalid closure observation input: ${message}`);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The fixture-generated passive stdout capture preload source (CJS, loaded
 * through `--require`). Pure text: no repository import, no research-module
 * import, and no template literal of its own — the executable copy exists
 * only inside the disposable fixture. Codex round 11: the preload is the
 * COMPLETE structural rewrite against the P1-P5 specification (report
 * §19.8): P1 gate; P2 interception with a hasher-authoritative digest over
 * the INTERCEPTED bytes (the capture file is never read back for the
 * digest) and default-encoding resolution for every write form; P3
 * last-writer-wins finalization meta (closed field set, finalization
 * bookkeeping, no forced exit); the read side (P4) verifies the file
 * against the hasher and the exit code against the handle-linked authority.
 */
export function closurePreloadSource() {
  return `'use strict';
// Fixture-generated passive stdout capture preload (research-only; report
// §19.3 + the round-11 P1-P5 structural rewrite). Generated into the
// disposable fixture by the research fixture; the repository never ships an
// executable copy.
// P1 GATE: active only when the fixture-only capture environment is present
// and well-formed (absolute capture directory, 64-hex nonce, absolute
// declared entry, maxBytes exactly 65536), the child's entry realpaths to
// the declared launcher realpath, and argv.slice(2) deep-equals
// ['invoke-prepared','rescue']. Any other process installs NOTHING.
// P2 INTERCEPTION: process.stdout.write is wrapped — every call form
// (chunk) / (chunk, encoding) / (chunk, callback) / (chunk, encoding,
// callback) computes the DELIVERED bytes (Buffer/TypedArray as-is; string
// through the explicit encoding, else the stream's tracked default
// encoding), feeds them to the AUTHORITATIVE running SHA-256 hasher, and
// appends them to the wx 0600 capture file, subject to the 64 KiB cap
// (exceeding sets truncated). The original call is forwarded unchanged (same
// arguments, same return value, callback untouched, errors propagate); a
// capture-side fs error names captureError and stops capturing without ever
// altering delivery. The digest is derived ONLY from the intercepted bytes
// (the capture file is never read back for it).
// P3 FINALIZATION: last-writer-wins meta at two idempotent points — the
// 'exit' listener (registered at install and re-ordered to the END of the
// listener list on beforeExit, so on the natural drain it runs after the
// application listeners registered so far) and the wrapped
// process.reallyExit (the authoritative last word on explicit exits). No
// forced exit, no exitCode mutation. A write landing after a finalization
// increments writesAfterFinalization, still appends+hashes, and immediately
// republishes the meta.
(function () {
  var FS = require('node:fs');
  var PATH = require('node:path');
  var CRYPTO = require('node:crypto');
  var DIRECTORY = process.env[${JSON.stringify(CAPTURE_DIRECTORY_VARIABLE)}];
  var NONCE = process.env[${JSON.stringify(CAPTURE_NONCE_VARIABLE)}];
  var ENTRY = process.env[${JSON.stringify(CAPTURE_ENTRY_VARIABLE)}];
  var MAX_BYTES = Number(process.env[${JSON.stringify(CAPTURE_MAX_BYTES_VARIABLE)}]);
  // ---- P1 gate ----
  if (typeof DIRECTORY !== 'string' || DIRECTORY.length === 0 || DIRECTORY.charAt(0) !== '/') return;
  if (typeof NONCE !== 'string' || !/^[a-f0-9]{64}$/.test(NONCE)) return;
  if (typeof ENTRY !== 'string' || ENTRY.length === 0 || ENTRY.charAt(0) !== '/') return;
  if (!Number.isSafeInteger(MAX_BYTES) || MAX_BYTES !== ${JSON.stringify(STDOUT_CAPTURE_MAX_BYTES)}) return;
  if (process.argv.length !== ${2 + TERMINAL_ARGV_SELECTOR.length}) return;
  if (process.argv[2] !== ${JSON.stringify(TERMINAL_ARGV_SELECTOR[0])} || process.argv[3] !== ${JSON.stringify(TERMINAL_ARGV_SELECTOR[1])}) return;
  var entryRealpath;
  try { entryRealpath = FS.realpathSync(process.argv[1]); } catch (error) { return; }
  if (entryRealpath !== ENTRY) return;
  // ---- P2 install ----
  var capturePath = PATH.join(DIRECTORY, NONCE + '.stdout');
  var metaPath = PATH.join(DIRECTORY, NONCE + '.meta.json');
  var META_VERSION = 1;
  var hash = CRYPTO.createHash('sha256');
  var startedAtMs = Date.now();
  var fd = null;
  var bytes = 0;
  var truncated = false;
  var captureError = null;
  var finalized = false;
  var finalizedBy = null;
  var finalizations = 0;
  var writesAfterFinalization = 0;
  var metaWritten = false;
  var defaultEncoding = 'utf8';
  function errorCode(error) { return error && typeof error.code === 'string' ? error.code : 'unknown'; }
  try { fd = FS.openSync(capturePath, 'wx', 0o600); }
  catch (error) { captureError = 'capture-file-unavailable:' + errorCode(error); }
  function resolveEncoding(encoding) {
    // Codex round 12 (finding 2): Node treats an EMPTY encoding argument as
    // unspecified — resolve it (and any non-string) to the tracked stream
    // default; only a nonempty string encoding is used as given.
    if (typeof encoding === 'string' && encoding !== '') return encoding;
    return defaultEncoding;
  }
  function toBuffer(chunk, encoding) {
    return typeof chunk === 'string'
      ? Buffer.from(chunk, encoding)
      : Buffer.isBuffer(chunk)
        ? chunk
        : ArrayBuffer.isView(chunk)
          ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          : Buffer.from(String(chunk));
  }
  function currentExitCode() { return typeof process.exitCode === 'number' ? process.exitCode : 0; }
  // ---- P3 last-writer-wins meta publication (closed field set) ----
  function publishMeta(basis) {
    finalizations += 1;
    finalizedBy = basis;
    var digest = null;
    if (captureError === null) {
      // The hasher is AUTHORITATIVE: digest a COPY of its live state over
      // exactly the intercepted bytes — the capture file is never read back
      // for the digest, so file tamper can never manufacture a match.
      try { digest = hash.copy().digest('hex'); } catch (error) { digest = null; }
    }
    var meta = {
      version: META_VERSION,
      nonce: NONCE,
      entryRealpath: entryRealpath,
      argv: process.argv.slice(2),
      byteCount: bytes,
      captureSha256: digest,
      truncated: truncated,
      maxBytes: MAX_BYTES,
      exitCode: currentExitCode(),
      finalizedBy: basis,
      finalizations: finalizations,
      writesAfterFinalization: writesAfterFinalization,
      durationMs: Math.max(0, Date.now() - startedAtMs),
    };
    if (captureError !== null) meta.captureError = captureError;
    // One capture per fixture nonce: a foreign meta is never overwritten
    // (first publication 'wx'; our own republications 'w').
    try { FS.writeFileSync(metaPath, JSON.stringify(meta) + '\\n', { mode: 0o600, flag: metaWritten ? 'w' : 'wx' }); metaWritten = true; } catch (error) { /* named by the surviving capture pair */ }
  }
  function finalizeMeta(basis) {
    finalized = true;
    publishMeta(basis);
  }
  function record(chunk, encoding) {
    if (captureError !== null) return;
    var buffer;
    try { buffer = toBuffer(chunk, resolveEncoding(encoding)); }
    catch (error) { captureError = 'capture-encode-failed:' + errorCode(error); return; }
    if (finalized) writesAfterFinalization += 1;
    if (!truncated) {
      // Codex round 12 (finding 3): truncation is declared ONLY when bytes
      // were DISCARDED — a capture totaling exactly the cap keeps every byte
      // and stays complete.
      var take = bytes + buffer.length > MAX_BYTES ? buffer.subarray(0, MAX_BYTES - bytes) : buffer;
      var discarded = buffer.length - take.length;
      if (take.length > 0) {
        try { hash.update(take); } catch (error) { captureError = 'capture-hash-failed:' + errorCode(error); return; }
        try { FS.writeSync(fd, take); bytes += take.length; }
        catch (error) { captureError = 'capture-write-failed:' + errorCode(error); return; }
      }
      if (discarded > 0) truncated = true;
    }
    if (finalized) publishMeta(finalizedBy);
  }
  if (fd !== null) {
    var originalWrite = process.stdout.write;
    // The stream's tracked default encoding (initial 'utf8') resolves an
    // OMITTED encoding for every write form, including the callback form.
    var originalSetDefaultEncoding = /** @type {any} */ (process.stdout).setDefaultEncoding;
    if (typeof originalSetDefaultEncoding === 'function') {
      /** @type {any} */ (process.stdout).setDefaultEncoding = function (encoding) {
        if (typeof encoding === 'string' && Buffer.isEncoding(encoding)) defaultEncoding = encoding;
        return originalSetDefaultEncoding.apply(this, arguments);
      };
    }
    process.stdout.write = function (chunk, encoding, callback) {
      // Codex round 12 (finding 1): the ORIGINAL write runs FIRST. A
      // synchronous rejection propagates unchanged and records NOTHING (the
      // caller's bytes were never accepted by stdout); the bytes are
      // recorded only after the write returned — async failures (EPIPE via
      // the callback) do NOT invalidate the capture (the established
      // round-4 contract: the bytes were accepted/queued).
      var result = originalWrite.apply(process.stdout, arguments);
      record(chunk, encoding);
      return result;
    };
  }
  // ---- P3 finalization points ----
  var exitFinalizer = function () { finalizeMeta('exit-listeners'); };
  process.once('exit', exitFinalizer);
  process.on('beforeExit', function () {
    // Re-order ONLY our own listener to the END of the 'exit' listener list:
    // on the natural drain it finalizes AFTER the application listeners
    // registered so far. No exit is forced; the business exit status is
    // never touched.
    process.removeListener('exit', exitFinalizer);
    process.once('exit', exitFinalizer);
  });
  if (typeof process.reallyExit === 'function') {
    var originalReallyExit = process.reallyExit;
    process.reallyExit = function () {
      // The authoritative LAST word on explicit exits: it republishes the
      // meta with the final business exit code (last-writer-wins).
      finalizeMeta('really-exit');
      return originalReallyExit.apply(process, arguments);
    };
  }
})();
`;
}

export const CLOSURE_PRELOAD_FILE_NAME = 'closure-stdout-preload.cjs';

/**
 * Write the fixture-generated preload into a private directory. The write is
 * the only side effect and happens after the directory validation.
 * @param {string} directory an absolute private directory (the disposable
 *   fixture root or an offline test's temp root)
 * @returns {Promise<{ path: string, sha256: string, nodeOptionsFragment: string }>}
 */
export async function writeClosurePreload(directory) {
  if (typeof directory !== 'string' || directory.length === 0 || !isAbsolute(directory)) {
    throw invalidClosureInput('the preload directory must be an absolute path.');
  }
  const source = closurePreloadSource();
  const path = join(directory, CLOSURE_PRELOAD_FILE_NAME);
  await writeFile(path, source, { mode: 0o600 });
  // Codex round 2: the fragment QUOTES the complete preload path per Node's
  // NODE_OPTIONS parsing (only U+0020 separates arguments; a double quote
  // opens a quoted segment; inside quotes a backslash escapes the next
  // character) — an unquoted path with spaces (custom TMPDIR) would split
  // into multiple arguments and node would exit before any entry runs.
  const quotedPath = `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return {
    path,
    sha256: createHash('sha256').update(source, 'utf8').digest('hex'),
    nodeOptionsFragment: `--require ${quotedPath}`,
  };
}

/**
 * Compose the fixture-only capture environment for one fresh capture scope
 * (one nonce). Validates every option BEFORE returning; no side effects.
 * @param {{
 *   captureDirectory: string,
 *   nonce: string,
 *   entryRealpath: string,
 *   maxBytes?: number,
 *   baseEnv?: NodeJS.ProcessEnv,
 *   nodeOptionsFragment?: string,
 * }} input
 * @returns {NodeJS.ProcessEnv}
 */
export function captureEnvironment(input) {
  if (!isPlainObject(input)) throw invalidClosureInput('the capture environment input must be an object.');
  const { captureDirectory, nonce, entryRealpath } = input;
  if (typeof captureDirectory !== 'string' || captureDirectory.length === 0 || !isAbsolute(captureDirectory)) {
    throw invalidClosureInput('the capture directory must be an absolute path.');
  }
  if (typeof nonce !== 'string' || !HEX_64.test(nonce)) {
    throw invalidClosureInput('the capture nonce must be a 64-hex digest.');
  }
  if (typeof entryRealpath !== 'string' || entryRealpath.length === 0 || !isAbsolute(entryRealpath)) {
    throw invalidClosureInput('the declared entry realpath must be an absolute path.');
  }
  const maxBytes = input.maxBytes ?? STDOUT_CAPTURE_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw invalidClosureInput('the capture max bytes must be a positive integer.');
  }
  if (maxBytes !== STDOUT_CAPTURE_MAX_BYTES) {
    // A smaller value would compose an environment whose captures the
    // admission can always reject (the meta contract pins the same bound):
    // construction validates options COHERENTLY at the frozen 65536 bound.
    throw invalidClosureInput('the capture max bytes must be exactly the frozen 65536 bound.');
  }
  const fragment = input.nodeOptionsFragment;
  if (fragment !== undefined && (typeof fragment !== 'string' || !fragment.startsWith('--require '))) {
    throw invalidClosureInput('the preload NODE_OPTIONS fragment must be a --require fragment.');
  }
  const baseEnv = input.baseEnv ?? {};
  const existingOptions = typeof baseEnv.NODE_OPTIONS === 'string' && baseEnv.NODE_OPTIONS.length > 0
    ? `${baseEnv.NODE_OPTIONS} `
    : '';
  return {
    ...baseEnv,
    [CAPTURE_DIRECTORY_VARIABLE]: captureDirectory,
    [CAPTURE_NONCE_VARIABLE]: nonce,
    [CAPTURE_ENTRY_VARIABLE]: entryRealpath,
    [CAPTURE_MAX_BYTES_VARIABLE]: String(maxBytes),
    ...(fragment === undefined ? {} : { NODE_OPTIONS: `${existingOptions}${fragment}` }),
  };
}

/**
 * One admission verdict: a bounded typed projection exposing only the data
 * the exact-output oracle consumes. `stdout` is exposed ONLY for a
 * `complete` admission (an empty capture is a valid complete admission);
 * every other status is a NAMED observer failure with `stdout: null`.
 * @typedef {{
 *   closureObservationVersion: number,
 *   status: 'complete' | 'missing' | 'incomplete' | 'truncated' | 'invalid',
 *   reason: string | null,
 *   stdout: string | null,
 *   byteCount: number | null,
 *   captureSha256: string | null,
 *   verifiedDigest: string | null,
 *   exitCode: number | null,
 *   captureComplete: boolean | null,
 *   truncated: boolean | null,
 * }} StdoutCaptureAdmission
 */

/** @param {StdoutCaptureAdmission['status']} status @param {string | null} reason @returns {StdoutCaptureAdmission} */
function admissionVerdict(status, reason) {
  return {
    closureObservationVersion: CLOSURE_OBSERVATION_VERSION,
    status,
    reason,
    stdout: null,
    byteCount: null,
    captureSha256: null,
    verifiedDigest: null,
    exitCode: null,
    captureComplete: null,
    truncated: null,
  };
}

/**
 * Validate the closed meta-record contract (§19.3(b)). Returns the typed
 * meta or the named shape-violation reason.
 * @param {unknown} meta
 * @returns {{ ok: true, meta: { version: number, nonce: string, truncated: boolean, byteCount: number, captureSha256: string | null, maxBytes: number, exitCode: number, finalizedBy: string, finalizations: number, writesAfterFinalization: number, argv: string[], entryRealpath: string, durationMs: number, captureError?: string } } | { ok: false, reason: string }}
 */
function validateCaptureMeta(meta) {
  // Codex round 11 (P3/P4): the closed meta field set of the structural
  // rewrite — `captureComplete` is DERIVED by admission (never published),
  // and the finalization bookkeeping (version/nonce/finalizedBy/
  // finalizations/writesAfterFinalization) is required.
  if (!isPlainObject(meta)) return { ok: false, reason: 'capture-meta-shape-invalid' };
  const keys = Object.keys(meta).sort();
  const required = ['argv', 'byteCount', 'captureSha256', 'durationMs', 'entryRealpath', 'exitCode', 'finalizations', 'finalizedBy', 'maxBytes', 'nonce', 'truncated', 'version', 'writesAfterFinalization'];
  const allowed = meta.captureError === undefined ? required : [...required, 'captureError'];
  if (keys.join(',') !== allowed.sort().join(',')) return { ok: false, reason: 'capture-meta-shape-invalid' };
  if (meta.version !== 1) return { ok: false, reason: 'capture-meta-shape-invalid' };
  if (typeof meta.nonce !== 'string' || !HEX_64.test(meta.nonce)) return { ok: false, reason: 'capture-meta-shape-invalid' };
  if (typeof meta.finalizedBy !== 'string' || meta.finalizedBy.length === 0) return { ok: false, reason: 'capture-meta-shape-invalid' };
  if (!Number.isSafeInteger(meta.finalizations) || /** @type {number} */ (meta.finalizations) < 1) return { ok: false, reason: 'capture-meta-shape-invalid' };
  if (!Number.isSafeInteger(meta.writesAfterFinalization) || /** @type {number} */ (meta.writesAfterFinalization) < 0) return { ok: false, reason: 'capture-meta-shape-invalid' };
  if (typeof meta.truncated !== 'boolean') return { ok: false, reason: 'capture-meta-shape-invalid' };
  if (!Number.isSafeInteger(meta.byteCount) || /** @type {number} */ (meta.byteCount) < 0) return { ok: false, reason: 'capture-meta-shape-invalid' };
  if (meta.captureSha256 !== null && (typeof meta.captureSha256 !== 'string' || !HEX_64.test(meta.captureSha256))) return { ok: false, reason: 'capture-meta-shape-invalid' };
  if (meta.maxBytes !== STDOUT_CAPTURE_MAX_BYTES) return { ok: false, reason: 'capture-meta-shape-invalid' };
  if (!Number.isSafeInteger(meta.exitCode) || /** @type {number} */ (meta.exitCode) < 0) return { ok: false, reason: 'capture-meta-shape-invalid' };
  if (!Array.isArray(meta.argv) || meta.argv.length !== TERMINAL_ARGV_SELECTOR.length
    || TERMINAL_ARGV_SELECTOR.some((segment, index) => /** @type {unknown[]} */ (meta.argv)[index] !== segment)) return { ok: false, reason: 'capture-meta-shape-invalid' };
  if (typeof meta.entryRealpath !== 'string' || meta.entryRealpath.length === 0 || !isAbsolute(meta.entryRealpath)) return { ok: false, reason: 'capture-meta-shape-invalid' };
  if (!Number.isSafeInteger(meta.durationMs) || /** @type {number} */ (meta.durationMs) < 0) return { ok: false, reason: 'capture-meta-shape-invalid' };
  if (meta.captureError !== undefined && typeof meta.captureError !== 'string') return { ok: false, reason: 'capture-meta-shape-invalid' };
  if (/** @type {number} */ (meta.byteCount) > /** @type {number} */ (meta.maxBytes)) return { ok: false, reason: 'capture-meta-shape-invalid' };
  return { ok: true, meta: /** @type {any} */ (meta) };
}

/**
 * Read exactly `expectedBytes` capture bytes with the production no-follow
 * discipline (final-symlink refusal, size identity before and after).
 * Returns null on ANY identity/size deviation (named by the caller).
 * @param {string} capturePath
 * @param {number} expectedBytes
 * @returns {Promise<Buffer | null>}
 */
async function readCaptureBytes(capturePath, expectedBytes) {
  let handle;
  try {
    const before = await lstat(capturePath);
    if (before.isSymbolicLink() || !before.isFile() || before.size !== expectedBytes) return null;
    handle = await open(capturePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const handleBefore = await handle.stat();
    if (!handleBefore.isFile() || handleBefore.size !== expectedBytes) return null;
    const bytes = Buffer.alloc(expectedBytes);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== expectedBytes) return null;
    const [handleAfter, pathAfter] = await Promise.all([handle.stat(), lstat(capturePath)]);
    if (handleAfter.size !== expectedBytes || pathAfter.isSymbolicLink() || !pathAfter.isFile() || pathAfter.size !== expectedBytes) return null;
    return bytes;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Admit one capture pair (bytes + meta) from a fixture-owned capture
 * directory, bound to the fixture nonce. Purely offline; performs NO writes.
 * The captured bytes are re-verified against the capture-time digest before
 * any use; a truncated or failed capture exposes NO stdout (fail closed).
 * @param {{
 *   captureDirectory: string,
 *   nonce: string,
 *   expectedEntryRealpath?: string,
 *   expectedExitCode?: number,
 * }} input
 * @returns {Promise<StdoutCaptureAdmission>}
 */
export async function admitStdoutCapture(input) {
  if (!isPlainObject(input)) throw invalidClosureInput('the capture admission input must be an object.');
  const { captureDirectory, nonce } = input;
  if (typeof captureDirectory !== 'string' || captureDirectory.length === 0 || !isAbsolute(captureDirectory)) {
    throw invalidClosureInput('the capture directory must be an absolute path.');
  }
  if (typeof nonce !== 'string' || !HEX_64.test(nonce)) {
    throw invalidClosureInput('the capture nonce must be a 64-hex digest.');
  }
  const expectedEntry = input.expectedEntryRealpath;
  if (expectedEntry !== undefined && (typeof expectedEntry !== 'string' || expectedEntry.length === 0 || !isAbsolute(expectedEntry))) {
    throw invalidClosureInput('the expected entry realpath must be an absolute path.');
  }
  // Codex round 9 (exit-code authority contract): the PARENT-OBSERVED process
  // exit (the launch-handle boundary) is the exit code of record for the
  // oracle — the meta's self-reported exitCode is only a CONSISTENCY CHECK
  // against it. A mismatch is the named incomplete state (never matched).
  const expectedExitCode = input.expectedExitCode;
  if (expectedExitCode !== undefined && (!Number.isSafeInteger(expectedExitCode) || expectedExitCode < 0)) {
    throw invalidClosureInput('the expected exit code must be a nonnegative integer.');
  }
  const capturePath = join(captureDirectory, `${nonce}.stdout`);
  const metaPath = join(captureDirectory, `${nonce}.meta.json`);
  const captureStats = await lstat(capturePath).catch((error) => {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') return null;
    throw error;
  });
  if (captureStats === null) return admissionVerdict('missing', 'capture-file-missing');
  if (captureStats.isSymbolicLink() || !captureStats.isFile()) return admissionVerdict('invalid', 'capture-file-not-regular');
  const metaStats = await lstat(metaPath).catch((error) => {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') return null;
    throw error;
  });
  if (metaStats === null) return admissionVerdict('incomplete', 'capture-meta-missing');
  if (metaStats.isSymbolicLink() || !metaStats.isFile()) return admissionVerdict('invalid', 'capture-meta-not-regular');
  let meta;
  try {
    meta = await readBoundedJsonFile(captureDirectory, metaPath, CAPTURE_META_MAX_BYTES, { requirePrivatePermissions: true });
  } catch {
    return admissionVerdict('invalid', 'capture-meta-unreadable');
  }
  const shape = validateCaptureMeta(meta);
  if (!shape.ok) return admissionVerdict('invalid', shape.reason);
  const record = shape.meta;
  // P4: the meta is bound to the queried fixture nonce.
  if (record.nonce !== nonce) {
    return admissionVerdict('invalid', 'capture-meta-nonce-mismatch');
  }
  if (expectedEntry !== undefined && record.entryRealpath !== expectedEntry) {
    return admissionVerdict('invalid', 'entry-realpath-mismatch');
  }
  if (record.captureError !== undefined) {
    return {
      ...admissionVerdict('incomplete', record.captureError),
      captureSha256: record.captureSha256,
      exitCode: record.exitCode,
      captureComplete: false,
      truncated: record.truncated,
    };
  }
  // P4: a write landing after any finalization is the named incomplete
  // state (the count is the preload's own bookkeeping).
  if (record.writesAfterFinalization > 0) {
    return {
      ...admissionVerdict('incomplete', 'write-after-finalization'),
      captureSha256: record.captureSha256,
      exitCode: record.exitCode,
      captureComplete: false,
      truncated: record.truncated,
    };
  }
  if (expectedExitCode !== undefined && record.exitCode !== expectedExitCode) {
    return {
      ...admissionVerdict('incomplete', 'capture-exit-code-mismatch'),
      captureSha256: record.captureSha256,
      exitCode: record.exitCode,
      captureComplete: false,
      truncated: record.truncated,
    };
  }
  const bytes = await readCaptureBytes(capturePath, record.byteCount);
  if (bytes === null) return admissionVerdict('invalid', 'byte-count-mismatch');
  const verifiedDigest = createHash('sha256').update(bytes).digest('hex');
  // P4: the hasher is authoritative — the FILE is verified against the
  // digest of the INTERCEPTED bytes, so a same-length tamper can never pass.
  if (record.captureSha256 === null || verifiedDigest !== record.captureSha256) {
    return admissionVerdict('invalid', 'capture-digest-mismatch');
  }
  if (record.truncated) {
    return {
      ...admissionVerdict('truncated', 'capture-truncated'),
      byteCount: record.byteCount,
      captureSha256: record.captureSha256,
      verifiedDigest,
      exitCode: record.exitCode,
      captureComplete: false,
      truncated: true,
    };
  }
  // Codex round 1: the decode is BYTE-EXACT — `ignoreBOM` preserves a
  // leading U+FEFF (three real bytes the exact comparison must see as
  // content) and `fatal` turns invalid UTF-8 into the NAMED fail-closed
  // state instead of silently substituted characters.
  let stdout;
  try {
    stdout = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }).decode(bytes);
  } catch {
    // The byte-level facts stay verified (digest/byteCount); only the lossy
    // STRING surface is refused.
    return {
      ...admissionVerdict('invalid', 'capture-utf8-invalid'),
      byteCount: record.byteCount,
      captureSha256: record.captureSha256,
      verifiedDigest,
      exitCode: record.exitCode,
      captureComplete: false,
      truncated: record.truncated,
    };
  }
  return {
    closureObservationVersion: CLOSURE_OBSERVATION_VERSION,
    status: 'complete',
    reason: null,
    stdout,
    byteCount: record.byteCount,
    captureSha256: record.captureSha256,
    verifiedDigest,
    exitCode: record.exitCode,
    captureComplete: true,
    truncated: false,
  };
}

/**
 * Join an admitted capture and an independently derived production
 * expectation to the frozen exact-linkage oracle. An unestablished
 * expectation (`null` — the resumability fact was unknown) stays
 * unestablished; a non-complete admission feeds the oracle NO stdout, so the
 * exact equality stays unestablished — never reconstructed from the merged
 * transcript, never compared against a partial capture.
 * @param {StdoutCaptureAdmission} admission
 * @param {{ output: string, exitCode: number } | null} expectation the
 *   real-renderer expectation (exactRescueRenderedExpectation), or null when
 *   the expectation is unestablished
 * @returns {{ matched: boolean | null, reason: string | null, releaseQualificationVersion?: number, closureObservationVersion?: number }}
 */
export function closureExactLinkage(admission, expectation) {
  if (!isPlainObject(admission) || typeof admission.status !== 'string') {
    throw invalidClosureInput('the capture admission must carry a closed status.');
  }
  if (expectation === null || expectation === undefined) {
    return { matched: null, reason: 'expectation-unestablished', closureObservationVersion: CLOSURE_OBSERVATION_VERSION };
  }
  if (!isPlainObject(expectation) || typeof expectation.output !== 'string' || expectation.output.length === 0
    || !Number.isSafeInteger(expectation.exitCode) || /** @type {number} */ (expectation.exitCode) < 0) {
    throw invalidClosureInput('the exact expectation must carry a nonempty output string and a nonnegative exit code.');
  }
  if (admission.status !== 'complete' || typeof admission.stdout !== 'string') {
    return evaluateExactTerminalLinkage({
      terminalStdout: null,
      exitCode: admission.exitCode ?? null,
      expectedOutput: expectation.output,
      expectedExitCode: expectation.exitCode,
    });
  }
  return evaluateExactTerminalLinkage({
    terminalStdout: admission.stdout,
    exitCode: admission.exitCode,
    expectedOutput: expectation.output,
    expectedExitCode: expectation.exitCode,
  });
}

// ---------------------------------------------------------------------------
// The passive durable obligation snapshot reader (report §19.5 freeze —
// implemented WITHOUT re-deciding any frozen predicate).
//
// PASSIVITY CONTRACT (verified by the pipeline tests with whole-partition
// directory/content/mode fingerprints before and after every read):
//   - the partition is resolved exactly like the production
//     `existingJobStorageForRepair` precedent (pure lstat chain, no symlink,
//     mode 0700, realpath identity) — any incompleteness fails closed to a
//     NAMED incomplete state, never mkdir, never chmod;
//   - the exact bound job is read through the production bounded read
//     contract (`readBoundedJsonFile`: no-follow final symlink, declared-size
//     rejection, bound+1 reads) plus the private-permission contract;
//   - obligations are evaluated ONLY with the EXPORTED production predicates
//     (`TERMINAL`, `endedObligationSettled`, `isMarkedRunnerClaim`,
//     `validStopIntent`, `resumableJobIndicator`) — this reader is NOT
//     another lifecycle state machine and authorizes nothing;
//   - NO lock is ever acquired, probed, or waited on: the advisory lock's
//     on-disk presence is an observed fact only (production never unlinks
//     lock files, so presence is not hold-evidence);
//   - the partition is fingerprinted (entries, contents, modes) before and
//     after every read pass and equality is REQUIRED for a settled aggregate.
//
// CONSISTENCY LIMITS (frozen): per-file reads are atomic but the cross-file
// snapshot is not — a concurrent writer can produce a torn multi-file view,
// so a detected before/after inequality marks the whole observation
// unestablished (null stays null; null never becomes zero or
// not-applicable without a demonstrated path reason). Aggregates are
// `settled` ONLY when ALL applicable duties are POSITIVELY established;
// partial observations remain per-layer facts and are never folded into
// Companion or terminal-stdout outcomes. A missing record is recorded
// `missing`, never successful cleanup.
// ---------------------------------------------------------------------------

/** The closed version carried by every durable snapshot verdict. */
export const DURABLE_SNAPSHOT_VERSION = 1;

/**
 * The owner-index directory-name derivation, pinned to the production source
 * (scripts/lib/state.mjs `ownerBindingDirectoryName` with
 * `OWNER_BINDING_VERSION = 1`). The pipeline tests create real owner indexes
 * through the production store, which proves this constant matches.
 * @param {string} ownerSessionId
 * @returns {string}
 */
function ownerBindingDirectoryName(ownerSessionId) {
  return createHash('sha256').update(`zcode-owner-index-v1\0${ownerSessionId}`, 'utf8').digest('hex');
}

/** Hard research bounds (§19.5: hard entry/byte bounds; never unbounded). */
const OWNER_INDEX_ENTRY_BOUND = 32;
/** The owner-binding entry byte bound mirrors production OWNER_BINDING_MAX_BYTES (state.mjs). */
const OWNER_BINDING_ENTRY_MAX_BYTES = 8 * 1024;

/**
 * The production owner-binding entry contract (scripts/lib/state.mjs
 * `readOwnedJobs`): exactly the legacy v1 shape `{jobId, ownerSessionId,
 * version: 1}` or the modern v2 shape `{jobId, ownerSessionId,
 * rescueReservationKind, version: 2}` with the bounded reservation kind, and
 * the tuple bound to the entry filename's job id and the queried owner.
 * `validRescueReservationKind` is module-private in state.mjs; the two
 * closed literals are pinned here (pipeline-proven against production-written
 * indexes) — registered as the same class of closed-projection substitute as
 * the job-record validation.
 * @param {unknown} entry @param {string} entryJobId @param {string} ownerSessionId
 * @returns {boolean}
 */
function validOwnerBindingEntry(entry, entryJobId, ownerSessionId) {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
  const record = /** @type {Record<string, unknown>} */ (entry);
  const keys = Object.keys(record).sort();
  const legacy = keys.join(',') === 'jobId,ownerSessionId,version' && record.version === 1;
  const modern = keys.join(',') === 'jobId,ownerSessionId,rescueReservationKind,version'
    && record.version === 2
    && (record.rescueReservationKind === 'bound' || record.rescueReservationKind === 'unbound');
  if (!legacy && !modern) return false;
  return record.jobId === entryJobId && record.ownerSessionId === ownerSessionId;
}
/** The fs-level enumeration guard mirrors the production owner-index bound (state.mjs OWNER_JOB_ENTRIES_MAX); the RESEARCH bound above is admitted on the returned entry set, so an over-bound index is named `owner-index-entry-bound-exceeded`, never mislabeled unreadable. */
const OWNER_INDEX_FS_BOUND = 10_000;
const OWNER_JOB_BODY_BOUND = 1024 * 1024;
const JOB_FILE_PRIVATE_MODE = 0o600;
const DIRECTORY_PRIVATE_MODE = 0o700;

/** @param {string} message @returns {TypeError} */
function invalidSnapshotInput(message) {
  return new TypeError(`Invalid durable snapshot input: ${message}`);
}

/**
 * Pure partition resolution following the `existingJobStorageForRepair`
 * precedent: realpath identity, no symlinks, private directory modes, every
 * path pre-existing. Returns the named incomplete state instead of creating
 * anything.
 * @param {string} dataRoot @param {string} workspace
 * @returns {Promise<{ status: 'resolved' | 'incomplete', reason: string | null, directory: string | null, workspaceKey: string | null, workspacePath: string, canonicalWorkspace: boolean }>}
 */
async function resolveDurablePartition(dataRoot, workspace) {
  const requestedDataRoot = resolve(dataRoot);
  const requestedWorkspace = resolve(workspace);
  let dataRootPath;
  let workspacePath;
  try {
    [dataRootPath, workspacePath] = await Promise.all([realpath(requestedDataRoot), realpath(requestedWorkspace)]);
  } catch (error) {
    const label = /** @type {NodeJS.ErrnoException} */ (error)?.path === requestedWorkspace ? 'workspace' : 'data-root';
    return { status: 'incomplete', reason: `${label}-missing`, directory: null, workspaceKey: null, workspacePath: requestedWorkspace, canonicalWorkspace: false };
  }
  const canonicalWorkspace = workspacePath === requestedWorkspace;
  const workspaceKey = createHash('sha256').update(workspacePath, 'utf8').digest('hex');
  const workspacesDirectory = join(dataRootPath, 'workspaces');
  const directory = join(workspacesDirectory, workspaceKey);
  const jobsDirectory = join(directory, 'jobs');
  const ownerIndexDirectory = join(directory, 'job-owners');
  for (const [path, label] of [
    [dataRootPath, 'data-root'],
    [workspacesDirectory, 'workspaces-directory'],
    [directory, 'partition'],
    [jobsDirectory, 'jobs-directory'],
    [ownerIndexDirectory, 'owner-index-directory'],
  ]) {
    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') {
        return { status: 'incomplete', reason: `${label}-missing`, directory: null, workspaceKey: label === 'jobs-directory' || label === 'owner-index-directory' ? workspaceKey : null, workspacePath, canonicalWorkspace };
      }
      return { status: 'incomplete', reason: `${label}-unreadable`, directory: null, workspaceKey: null, workspacePath, canonicalWorkspace };
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return { status: 'incomplete', reason: `${label}-not-a-private-directory`, directory: null, workspaceKey: null, workspacePath, canonicalWorkspace };
    }
    if (process.platform !== 'win32' && (stats.mode & 0o777) !== DIRECTORY_PRIVATE_MODE) {
      return { status: 'incomplete', reason: `${label}-permission-deviates`, directory: null, workspaceKey: null, workspacePath, canonicalWorkspace };
    }
  }
  return { status: 'resolved', reason: null, directory, workspaceKey, workspacePath, canonicalWorkspace };
}

/** Per-file fingerprint byte bound: files at or below it digest whole; larger files digest their head and tail halves (any size change, and any content change within the bounded window, flips the fingerprint). */
const FINGERPRINT_FILE_BOUND_BYTES = 1024 * 1024;
const FINGERPRINT_ENTRY_BOUND = 4096;

/**
 * Fingerprint one directory subtree: bounded entry names, modes, sizes, and
 * BOUNDED content digests (no unbounded per-file read). Used ONLY by the
 * reader's own before/after equality check. Nonregular entries (FIFOs,
 * sockets, devices — damaged partitions) are CLASSIFIED from the lstat
 * result and NEVER opened (opening a FIFO blocks forever waiting for a
 * writer); each is reported in `nonregular` so the caller can fail the
 * observation closed.
 * @param {string} directory
 * @returns {Promise<{ text: string, nonregular: string[], oversized: string[] }>}
 */
async function fingerprintTree(directory) {
  /** @type {string[]} */
  const entries = [];
  /** @type {string[]} */
  const nonregular = [];
  /** @type {string[]} */
  const oversized = [];
  /**
   * @param {string} current
   * @param {string} prefix
   */
  async function walk(current, prefix) {
    const names = (await readdir(current)).sort();
    if (names.length > FINGERPRINT_ENTRY_BOUND || entries.length > FINGERPRINT_ENTRY_BOUND) {
      throw invalidSnapshotInput('the fingerprint bound was exceeded.');
    }
    for (const name of names) {
      const path = join(current, name);
      const stats = await lstat(path);
      if (stats.isDirectory()) {
        entries.push(`d ${prefix}${name} 0o${(stats.mode & 0o777).toString(8)}`);
        await walk(path, `${prefix}${name}/`);
      } else if (stats.isSymbolicLink()) {
        // A symlink appearing mid-read is a mutation that must flip the
        // fingerprint; it is represented distinctly, never followed.
        entries.push(`l ${prefix}${name} 0o${(stats.mode & 0o777).toString(8)}`);
      } else if (!stats.isFile()) {
        // Codex round 1: FIFOs/sockets/devices are typed from lstat and NEVER
        // opened — a FIFO read would block forever without a writer.
        entries.push(`p ${prefix}${name} 0o${(stats.mode & 0o777).toString(8)}`);
        nonregular.push(`${prefix}${name}`);
      } else {
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const handleStats = await handle.stat();
          if (!handleStats.isFile()) throw invalidSnapshotInput('the fingerprint encountered a non-regular file.');
          // Codex round 2: files beyond the per-file bound are head+tail
          // fingerprinted for equality detection but their contents are only
          // PARTIALLY covered — a same-length mid-file mutation would be
          // invisible. They are named so the aggregate can never settle on a
          // partially fingerprinted partition (production binding partitions
          // reach 16 MiB).
          const isOversized = handleStats.size > FINGERPRINT_FILE_BOUND_BYTES;
          const bytes = !isOversized
            ? await readBoundedFileBytes(handle, handleStats.size, 0)
            : Buffer.concat([
              await readBoundedFileBytes(handle, FINGERPRINT_FILE_BOUND_BYTES / 2, 0),
              await readBoundedFileBytes(handle, FINGERPRINT_FILE_BOUND_BYTES / 2, handleStats.size - FINGERPRINT_FILE_BOUND_BYTES / 2),
            ]);
          entries.push(`f ${prefix}${name} 0o${(stats.mode & 0o777).toString(8)} ${handleStats.size} ${createHash('sha256').update(bytes).digest('hex')}`);
          if (isOversized) oversized.push(`${prefix}${name}`);
        } finally {
          await handle.close().catch(() => {});
        }
      }
    }
  }
  await walk(directory, '');
  return { text: `${entries.length}\n${entries.join('\n')}`, nonregular, oversized };
}

/**
 * One bounded positional read of an open handle (short reads looped).
 * @param {import('node:fs/promises').FileHandle} handle
 * @param {number} length @param {number} position
 * @returns {Promise<Buffer>}
 */
async function readBoundedFileBytes(handle, length, position) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, position + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return bytes.subarray(0, offset);
}

/**
 * The ported production isPlainJsonObject (state.mjs :3444 + isJsonValue
 * :3450): prototype check AND finite/acyclic JSON-value-ness.
 * @param {unknown} value @returns {boolean}
 */
function isPlainJsonObjectValue(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!(prototype === Object.prototype || prototype === null)) return false;
  /** @type {Set<object>} */
  const seen = new Set();
  /** @param {unknown} candidate @returns {boolean} */
  const isJsonValue = (candidate) => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return true;
    if (typeof candidate === 'number') return Number.isFinite(candidate);
    if (typeof candidate !== 'object') return false;
    if (seen.has(/** @type {object} */ (candidate))) return false;
    seen.add(/** @type {object} */ (candidate));
    const valid = /** @type {boolean} */ (Array.isArray(candidate)
      ? candidate.every((item) => isJsonValue(item))
      : (Object.getPrototypeOf(candidate) === Object.prototype || Object.getPrototypeOf(candidate) === null)
        && Object.values(candidate).every((item) => isJsonValue(item)));
    seen.delete(/** @type {object} */ (candidate));
    return valid;
  };
  return isJsonValue(value);
}

/**
 * Codex round 8 (structural endgame b): the COMPLETE port of production
 * `validateJobRecord` (scripts/lib/state.mjs:3141-3257) — every
 * JOB_RECORD_INVALID branch at this pin, arm for arm. `validateJobRecord`
 * and `readJobRecord` are module-private (the surveyed export surface of
 * state.mjs is JOB_STATUSES, JOB_COMMANDS, EFFORT_LEVELS, createStateStore,
 * resumableHostOwnedCancellation, isJobNotFound, validProgressProbe — no
 * pure validator), so the checklist ports them. Production throws the SINGLE
 * JOB_RECORD_INVALID for every arm; this port returns the one named
 * `job-record-schema-invalid` verdict. Production line citations per arm:
 *   :3142 isPlainJsonObject           :3143-3144 id/workspace equality
 *   :3145-3146 owner fields           :3147 command enum
 *   :3148-3149 readOnly/snapshot      :3150 status enum
 *   :3151 createdAt/updatedAt dates   :3152 childPid arm
 *   :3153 workerLeaseId arm           :3154 exitCode arm
 *   :3155 zcodeSessionId arm          :3156-3157 codexThreadId/transfer arms
 *   :3158 model arm                   :3159 effort arm
 *   :3160-3161 startedAt/finishedAt   :3162-3163 artifact arms
 *   :3164 logFile equality            :3165 error arm
 *   :3166 lastCancelError arm         :3167 phase arm
 *   :3168 lastActivityAt arm          :3169-3170 progress arms
 *   :3171-3172 reservation kind       :3173 lifecycle-trio arm
 *   :3174 stopIntent arm              :3175-3176 stopCause arm
 *   :3177 cancelled-stopCause arm     :3178 migrationRollback arm
 *   :3179 continuationOrigin arm      :3180 executionClaim arm
 *   :3181 executionReservation arm    :3182 jobSpecCommitment arm
 *   :3183 legacyJobSpecProof arm      :3184-3185 exclusivity arms
 *   :3193 runner-marker arm           :3197-3199 executionInput arms
 *   :3203 originWorkspace arm         :3205-3210 boundary triple
 *   :3212-3213 queued claim parity    :3214-3216 running metadata
 *   :3217-3224 lifecycle arms         :3230-3237 progress triple
 *   :3238-3243 timeline ordering
 * Private leaf validators are ported verbatim below (isNonEmptyString
 * :3434, isValidDateString :3439, isIsoTimestamp :3428, isBoundedThreadId
 * :3364, isBoundedOwnerSessionId :3367 (byte bound from :72), isTrackedError
 * :3359, isModel :3376, isSafeArtifact :3385, validBeforeMessageIds :3392
 * (byte bound from :69), validProgressPreview :3404 + isSafeProgressMessage
 * :3409 + isBidiControl :3418 (bounds from progress.mjs exports),
 * validCanonicalWorkspacePath :1580, expectedJobLogPath :3484,
 * isPlainJsonObject :3444 + isJsonValue :3450, isDigest :3342,
 * validRescueReservationKind :2221). The FOUR arms whose full evaluation
 * requires the module-private binding validator (validateRescueBinding —
 * execution claim 'bound' kind :1930-1949, migration-rollback priorBinding
 * :2094-2109, continuation origin :2112-2143) are ported for every
 * record-local arm and FAIL CLOSED (reject) exactly where the binding
 * validator would be required — a narrower-than-production substitute in
 * the registered fail-safe direction: production-rejected shapes are never
 * accepted; a production-valid shape of those four arms is lost as
 * unestablished, never settled.
 * @param {Record<string, unknown>} job @param {{ jobId: string, workspacePath: string, ownerSessionId: string, jobsDirectory: string }} expected
 * @returns {boolean}
 */
function validateDurableJobRecordSchema(job, expected) {
  /** @param {unknown} value */
  const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
  /** @param {unknown} value */
  const isDigestValue = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
  /** @param {unknown} value */
  const isValidDateString = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
  /** @param {unknown} value */
  const isIsoTimestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
  /** @param {unknown} value */
  const hasControlCode = (value) => [.../** @type {string} */ (value)].some((character) => {
    const code = /** @type {number} */ (character.codePointAt(0));
    return code <= 31 || code === 127;
  });
  /** @param {unknown} value */
  const isBoundedThreadId = (value) => {
    const text = /** @type {string} */ (value);
    return isNonEmptyString(text) && Buffer.byteLength(text) <= 512 && !hasControlCode(text);
  };
  /** @param {unknown} value */
  const isBoundedOwnerSessionId = (value) => {
    const text = /** @type {string} */ (value);
    return isNonEmptyString(text) && Buffer.byteLength(text) <= 4096 && !hasControlCode(text);
  };
  /** @param {unknown} value */
  const isTrackedError = (value) => isNonEmptyString(value)
    || (isPlainJsonObjectValue(value) && isNonEmptyString(/** @type {any} */ (value).message));
  /** @param {unknown} value */
  const isModel = (value) => {
    if (isNonEmptyString(value)) return true;
    const record = /** @type {any} */ (value);
    if (!isPlainJsonObjectValue(value) || !isNonEmptyString(record.providerId)
      || !isNonEmptyString(record.modelId)) return false;
    if ('variant' in record && !isNonEmptyString(record.variant)) return false;
    return Object.keys(record).every((key) => key === 'providerId' || key === 'modelId' || key === 'variant');
  };
  /** @param {unknown} value */
  const isSafeArtifact = (value) => {
    const text = /** @type {string} */ (value);
    if (!isNonEmptyString(text) || text !== text.trim() || text.length > 1_024
      || text.includes('\0') || /^[/\\]/.test(text) || /^[A-Za-z]:[/\\]/.test(text)) return false;
    return text.split(/[/\\]/).every((segment) => segment !== '' && segment !== '.' && segment !== '..');
  };
  /** @param {unknown} value */
  const validBeforeMessageIds = (value) => {
    if (!Array.isArray(value) || value.length > 10_000 || new Set(value).size !== value.length) return false;
    let totalBytes = 0;
    for (const messageId of value) {
      if (!isSafeIdentifier(messageId)) return false;
      totalBytes += Buffer.byteLength(messageId);
      if (totalBytes > 256 * 1024) return false;
    }
    return true;
  };
  /** @param {number} code */
  const isBidiControl = (code) => code === 0x061c || code === 0x200e || code === 0x200f
    || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
  /** @param {unknown} value */
  const isSafeProgressMessage = (value) => {
    const text = /** @type {string} */ (value);
    return isNonEmptyString(text)
      && Buffer.byteLength(text) <= MAX_PROGRESS_MESSAGE_BYTES
      && ![...text].some((character) => {
        const code = /** @type {number} */ (character.codePointAt(0));
        return code <= 31 || (code >= 127 && code <= 159) || isBidiControl(code);
      });
  };
  /** @param {unknown} value */
  const validProgressPreview = (value) => Array.isArray(value)
    && value.length > 0
    && value.length <= MAX_PROGRESS_PREVIEW_ENTRIES
    && value.every((entry) => isSafeProgressMessage(entry));
  /** @param {unknown} value */
  const validCanonicalWorkspacePath = (value) => typeof value === 'string' && isAbsolute(value)
    && normalize(value) === value && Buffer.byteLength(value) <= 4096 && !/[\0\r\n]/u.test(value);
  /** @param {unknown} value */
  const validRescueReservationKind = (value) => value === 'bound' || value === 'unbound';
  /** @param {any} candidate */
  const hasHostOwnedLifecycle = (candidate) => ['executionOwner', 'hostPlacement', 'ownerLifecycleEpoch']
    .every((field) => field in candidate)
    && candidate.command === 'rescue' && candidate.readOnly === false && validHostLifecycleRecord(candidate);
  // Binding-validator-dependent arms: record-local arms ported; fail closed
  // exactly where validateRescueBinding would be required (registered
  // substitutes — see the function doc).
  /** @param {any} candidate */
  const validPersistedMigrationRollback = (candidate) => {
    const value = candidate.rescueMigrationRollback;
    const keys = ['childAgentId', 'operationId', 'parentSessionId', 'priorClosedAt', 'priorCurrentJobId', 'priorUpdatedAt', 'priorVersion'];
    const validKeys = isPlainJsonObjectValue(value) && [keys, [...keys, 'priorBinding']]
      .some((candidateKeys) => Object.keys(value).sort().join('\0') === candidateKeys.sort().join('\0'));
    if (!validKeys) return false;
    if (value.priorBinding !== undefined) return false;
    return candidate.command === 'rescue' && candidate.readOnly === false
      && value.parentSessionId === candidate.ownerSessionId && isNonEmptyString(value.childAgentId)
      && isDigestValue(value.operationId) && isDigestValue(value.priorCurrentJobId) && [1, 2, 3].includes(value.priorVersion)
      && isIsoTimestamp(value.priorUpdatedAt) && isIsoTimestamp(value.priorClosedAt)
      && Date.parse(value.priorUpdatedAt) === Date.parse(value.priorClosedAt)
      && value.priorCurrentJobId !== candidate.id && Date.parse(candidate.createdAt) >= Date.parse(value.priorClosedAt)
      && candidate.status === 'queued';
  };
  const validRescueContinuationOrigin = () => false;
  /** @param {any} candidate */
  const validRescueExecutionClaim = (candidate) => {
    const value = candidate.rescueExecutionClaim;
    if (!isPlainJsonObjectValue(value) || ![1, 2].includes(value.version) || value.workerLeaseId !== candidate.workerLeaseId
      || candidate.status !== 'queued' || candidate.command !== 'rescue' || candidate.readOnly !== false) return false;
    const legacyReservation = value.version === 2;
    if (legacyReservation !== (candidate.rescueReservationKind === undefined)) return false;
    const unboundKeys = legacyReservation ? 'kind,reservationProof,version,workerLeaseId' : 'kind,version,workerLeaseId';
    if (legacyReservation && !['owner-v1-classless', 'owner-v1-markerless-migration'].includes(value.reservationProof)) return false;
    if (value.kind === 'unbound') return Object.keys(value).sort().join(',') === unboundKeys
      && (legacyReservation || candidate.rescueReservationKind === 'unbound')
      && candidate.rescueContinuationOrigin === undefined && candidate.rescueMigrationRollback === undefined;
    return false;
  };
  /** @param {any} candidate */
  const validExecutionReservation = (candidate) => {
    const value = candidate.rescueExecutionReservation;
    if (!isPlainJsonObjectValue(value)) return false;
    const keys = Object.keys(value).sort().join(',');
    const sealed = ['capabilityDigest,jobId,jobSpecFormat,operation,ownerSessionId,reservationId,version,workspace',
      'capabilityDigest,jobId,jobSpecFormat,operation,ownerSessionId,reservationId,version,workerLeaseId,workspace'].includes(keys)
      && value.jobSpecFormat === 'sealed-v2' && value.specDigest === undefined;
    const legacy = ['capabilityDigest,jobId,jobSpecFormat,operation,ownerSessionId,reservationId,specDigest,version,workspace',
      'capabilityDigest,jobId,jobSpecFormat,operation,ownerSessionId,reservationId,specDigest,version,workerLeaseId,workspace'].includes(keys)
      && value.jobSpecFormat === 'legacy-v1' && isDigestValue(value.specDigest)
      && candidate.rescueReservationKind === undefined && candidate.rescueJobSpecCommitment === undefined;
    if (!sealed && !legacy) return false;
    return value.version === 1 && isDigestValue(value.capabilityDigest) && isDigestValue(value.reservationId)
      && value.jobId === candidate.id && value.ownerSessionId === candidate.ownerSessionId && value.workspace === candidate.workspace
      && value.operation === 'run-reserved-job'
      && (value.workerLeaseId === undefined || isDigestValue(value.workerLeaseId))
      && (candidate.workerLeaseId === undefined || value.workerLeaseId === candidate.workerLeaseId)
      && (candidate.status !== 'running' || value.workerLeaseId !== undefined);
  };
  /** @param {any} candidate */
  const validLegacyJobSpecProof = (candidate) => {
    const value = candidate.rescueLegacyJobSpecProof;
    return isPlainJsonObjectValue(value)
      && Object.keys(value).sort().join(',') === 'kind,specDigest,version'
      && value.version === 1 && value.kind === 'markerless-migration' && isDigestValue(value.specDigest)
      && candidate.status === 'queued' && candidate.command === 'rescue' && candidate.readOnly === false
      && candidate.rescueMigrationRollback !== undefined;
  };
  /** @param {any} value */
  const sameStoredRescueExecutionInput = (value) => {
    try { return isDeepStrictEqual(validateRescueExecutionInput(value), value); } catch { return false; }
  };

  const validShape = isPlainJsonObjectValue(job)
    && job.id === expected.jobId
    && job.workspace === expected.workspacePath
    && isBoundedOwnerSessionId(/** @type {string} */ (job.ownerSessionId))
    && isNonEmptyString(/** @type {string} */ (job.ownerTurnId))
    && JOB_COMMANDS.includes(/** @type {any} */ (job.command))
    && typeof job.readOnly === 'boolean'
    && isPlainJsonObjectValue(job.permissionSnapshot)
    && typeof job.status === 'string' && JOB_STATUSES.includes(job.status)
    && isValidDateString(/** @type {string} */ (job.createdAt)) && isValidDateString(/** @type {string} */ (job.updatedAt))
    && (!('childPid' in job) || Number.isSafeInteger(job.childPid) && /** @type {number} */ (job.childPid) > 0)
    && (!('workerLeaseId' in job) || isDigestValue(/** @type {string} */ (job.workerLeaseId)))
    && (!('exitCode' in job) || job.exitCode === null || Number.isSafeInteger(job.exitCode))
    && (!('zcodeSessionId' in job) || isSafeIdentifier(/** @type {string} */ (job.zcodeSessionId)))
    && (!('codexThreadId' in job) || job.command === 'transfer' && isBoundedThreadId(/** @type {string} */ (job.codexThreadId)))
    && (job.command !== 'transfer' || isBoundedThreadId(/** @type {string} */ (job.codexThreadId)))
    && (!('model' in job) || isModel(/** @type {any} */ (job.model)))
    && (!('effort' in job) || EFFORT_LEVELS.includes(/** @type {any} */ (job.effort)))
    && (!('startedAt' in job) || isIsoTimestamp(/** @type {string} */ (job.startedAt)))
    && (!('finishedAt' in job) || isIsoTimestamp(/** @type {string} */ (job.finishedAt)))
    && (!('promptArtifact' in job) || isSafeArtifact(job.promptArtifact))
    && (!('resultArtifact' in job) || isSafeArtifact(job.resultArtifact))
    && (!('logFile' in job) || job.logFile === join(expected.jobsDirectory, /** @type {string} */ (job.id) + '.log'))
    && (!('error' in job) || isTrackedError(/** @type {any} */ (job.error)))
    && (!('lastCancelError' in job) || isTrackedError(/** @type {any} */ (job.lastCancelError)))
    && (!('phase' in job) || PROGRESS_PHASES.includes(/** @type {any} */ (job.phase)))
    && (!('lastActivityAt' in job) || isIsoTimestamp(/** @type {string} */ (job.lastActivityAt)))
    && (!('progressPreview' in job) || validProgressPreview(/** @type {any} */ (job.progressPreview)))
    && (!('progressProbe' in job) || validProgressProbe(/** @type {any} */ (job.progressProbe)))
    && (!('rescueReservationKind' in job) || job.command === 'rescue' && job.readOnly === false
      && validRescueReservationKind(/** @type {any} */ (job.rescueReservationKind)))
    && (['executionOwner', 'hostPlacement', 'ownerLifecycleEpoch'].some((field) => field in job) ? hasHostOwnedLifecycle(job) : true)
    && (!('stopIntent' in job) || job.command === 'rescue' && job.readOnly === false && validStopIntent(/** @type {any} */ (job.stopIntent)))
    && (!('stopCause' in job) || job.status === 'cancelled' && job.command === 'rescue' && job.readOnly === false
      && STOP_CAUSES.has(/** @type {any} */ (job.stopCause)) && validStopIntent(/** @type {any} */ (job.stopIntent)) && /** @type {any} */ (job.stopIntent).cause === job.stopCause)
    && (!hasHostOwnedLifecycle(job) || job.status !== 'cancelled' || 'stopCause' in job)
    && (!('rescueMigrationRollback' in job) || validPersistedMigrationRollback(job))
    && (!('rescueContinuationOrigin' in job) || validRescueContinuationOrigin())
    && (!('rescueExecutionClaim' in job) || validRescueExecutionClaim(job))
    && (!('rescueExecutionReservation' in job) || validExecutionReservation(job))
    && (!('rescueJobSpecCommitment' in job) || job.status === 'queued' && isDigestValue(job.rescueJobSpecCommitment))
    && (!('rescueLegacyJobSpecProof' in job) || validLegacyJobSpecProof(job))
    && !('rescueJobSpecCommitment' in job && 'rescueLegacyJobSpecProof' in job)
    && !('rescueMigrationRollback' in job && 'rescueContinuationOrigin' in job)
    && (!('rescueRunnerVersion' in job) || validDetachedRescueRunnerJob(job))
    && (!('rescueExecutionInput' in job) || job.status === 'queued' && 'rescueRunnerVersion' in job
      && sameStoredRescueExecutionInput(job.rescueExecutionInput))
    && (!('rescueRunnerVersion' in job) || job.status !== 'queued' || 'rescueExecutionInput' in job)
    && (!('rescueOriginWorkspace' in job) || hasHostOwnedLifecycle(job)
      && validCanonicalWorkspacePath(job.rescueOriginWorkspace));
  if (!validShape) return false;
  const boundaryFields = ['inputId', 'startRevision', 'beforeMessageIds'];
  const hasBoundary = boundaryFields.some((field) => field in job);
  const validBoundary = !hasBoundary || boundaryFields.every((field) => field in job)
    && isSafeIdentifier(job.inputId) && Number.isSafeInteger(job.startRevision) && /** @type {number} */ (job.startRevision) >= 0
    && validBeforeMessageIds(job.beforeMessageIds)
    && typeof job.zcodeSessionId === 'string' && typeof job.startedAt === 'string' && job.status !== 'queued';
  const terminal = TERMINAL.has(String(job.status));
  const validQueuedClaim = job.status !== 'queued'
    || ('childPid' in job) === ('workerLeaseId' in job);
  const hasRunningMetadata = ['effort', 'model', 'promptArtifact', 'startedAt', 'zcodeSessionId']
    .some((field) => field in job);
  const validLifecycle = validBoundary && validQueuedClaim
    && (!hasRunningMetadata || job.status !== 'queued')
    && (!('exitCode' in job) || terminal)
    && (!('finishedAt' in job) || terminal)
    && (!('resultArtifact' in job) || job.status === 'succeeded')
    && (!('error' in job) || job.status === 'failed' || job.status === 'cancelled')
    && (!('lastCancelError' in job) || job.status === 'running' || terminal
      || (job.status === 'cancelling' && job.command === 'rescue' && job.readOnly === false && validStopIntent(job.stopIntent)));
  const createdAt = Date.parse(/** @type {string} */ (job.createdAt));
  const updatedAtMs = Date.parse(/** @type {string} */ (job.updatedAt));
  const startedAt = 'startedAt' in job ? Date.parse(/** @type {string} */ (job.startedAt)) : undefined;
  const finishedAt = 'finishedAt' in job ? Date.parse(/** @type {string} */ (job.finishedAt)) : undefined;
  const lastActivityAt = 'lastActivityAt' in job ? Date.parse(/** @type {string} */ (job.lastActivityAt)) : undefined;
  const progressFields = ['phase', 'lastActivityAt', 'progressPreview'];
  const hasProgress = progressFields.some((field) => field in job);
  const validProgress = !hasProgress || progressFields.every((field) => field in job)
    && job.status !== 'queued'
    && lastActivityAt !== undefined
    && lastActivityAt >= (startedAt ?? createdAt)
    && updatedAtMs >= lastActivityAt
    && (!terminal || (finishedAt !== undefined && finishedAt >= lastActivityAt));
  const validTimeline = updatedAtMs >= createdAt
    && (startedAt === undefined || updatedAtMs >= startedAt)
    && (finishedAt === undefined || updatedAtMs >= finishedAt)
    && (startedAt === undefined || startedAt >= createdAt)
    && (finishedAt === undefined || finishedAt >= (startedAt ?? createdAt));
  return validLifecycle && validProgress && validTimeline;
}

/**
 * The WHOLESALE closed admission checklist for one durable job record (codex
 * round 4 structural closure): ONE ordered clause table, ONE evaluator,
 * applied ENTIRELY before any settlement predicate runs. Each clause mirrors
 * a production admission requirement at this pin; every production-rejected
 * shape yields its clause's NAMED reason (invalid → unestablished, never
 * settled), every production-accepted shape passes unchanged.
 *
 * Clause → production derivation (all read at the working tree):
 *  c01 shape            — state.mjs validateJobRecord isPlainJsonObject
 *  c02 job id 64-hex    — validateJobRecord `job.id === expectedJobId` type arm
 *  c03 workspace        — validateJobRecord canonical workspace bound
 *  c04 owner fields     — validateJobRecord isBoundedOwnerSessionId /
 *                         isNonEmptyString(ownerTurnId)
 *  c05 command enum     — JOB_COMMANDS (exported, state.mjs :59)
 *  c06 readOnly/snapshot— validateJobRecord boolean + isPlainJsonObject
 *  c07 status enum      — JOB_STATUSES (exported, state.mjs :51)
 *  c08 claim fields     — validateJobRecord childPid/workerLeaseId types
 *  c09 epoch type       — validateHostLifecycleRecord validLifecycleEpoch
 *  c09b lifecycle trio  — validateJobRecord `!HOST_LIFECYCLE_FIELDS.some(
 *                         (field) => field in job) || hasHostOwnedLifecycle(
 *                         job)` (state.mjs): ANY lifecycle field present ⇒
 *                         ALL three present AND validHostLifecycleRecord
 *                         (round 5; no substitute — validHostLifecycleRecord
 *                         is EXPORTED, rescue-binding.mjs)
 *  c10 identity         — readJobRecord id/workspace equality + owner-index
 *                         tuple (state.mjs readOwnedJobs ownerSessionId match)
 *  c11 stop intent      — validateJobRecord `validStopIntent(job.stopIntent)`
 *                         (exported validStopIntent, rescue-binding.mjs)
 *  c12 cancellation     — validateJobRecord `hasHostOwnedLifecycle ⇒
 *                         status cancelled ⇒ 'stopCause' in job` (Host-owned
 *                         arm; non-Host-owned cancelled records carry no
 *                         stop evidence and are NOT required to)
 *  c13 stop-cause match — validateJobRecord stopCause arm: `status ===
 *                         'cancelled' && command rescue && !readOnly &&
 *                         STOP_CAUSES.has(stopCause) && validStopIntent(
 *                         stopIntent) && stopIntent.cause === stopCause`
 *                         (STOP_CAUSES exported, rescue-binding.mjs)
 *  c14 runner marker    — validDetachedRescueRunnerJob (EXPORTED,
 *                         rescue-execution-input.mjs — mirrors the
 *                         validateJobRecord rescueRunnerVersion arm)
 *
 * SUBSTITUTES (module-private production code that cannot be imported, with
 * the fail-safe direction): the per-field TYPE bounds (c02/c03/c04/c08/c09)
 * re-implement private isBoundedOwnerSessionId/isSafeIdentifier/
 * validLifecycleEpoch leaf checks as closed literal checks — a record
 * production accepts but a leaf check misjudges is rejected as
 * `job-record-shape-invalid` (never accepted); c05/c07 use the EXPORTED
 * enums. NO clause invents acceptance: the checklist can only narrow.
 * @type {readonly { reason: string, check: (job: Record<string, unknown>, expected: { jobId: string, workspacePath: string, ownerSessionId: string }) => boolean }[]}
 */
const DURABLE_JOB_RECORD_ADMISSION = Object.freeze([
  { reason: 'job-record-shape-invalid', check: (job) => !(Array.isArray(job)) },
  { reason: 'job-record-shape-invalid', check: (job) => typeof job.id === 'string' && /^[a-f0-9]{64}$/u.test(job.id) },
  {
    reason: 'job-record-shape-invalid',
    check: (job) => typeof job.workspace === 'string' && job.workspace.length > 0 && job.workspace.length <= 256
      && job.workspace === resolve(job.workspace),
  },
  {
    reason: 'job-record-shape-invalid',
    check: (job) => typeof job.ownerSessionId === 'string' && job.ownerSessionId.length > 0 && job.ownerSessionId.length <= 256
      && typeof job.ownerTurnId === 'string' && job.ownerTurnId.length > 0 && job.ownerTurnId.length <= 256,
  },
  { reason: 'job-record-shape-invalid', check: (job) => JOB_COMMANDS.includes(/** @type {any} */ (job.command)) },
  {
    reason: 'job-record-shape-invalid',
    check: (job) => typeof job.readOnly === 'boolean'
      && (typeof job.permissionSnapshot === 'object' && job.permissionSnapshot !== null && !Array.isArray(job.permissionSnapshot)),
  },
  { reason: 'job-record-shape-invalid', check: (job) => typeof job.status === 'string' && JOB_STATUSES.includes(/** @type {any} */ (job.status)) },
  {
    reason: 'job-record-shape-invalid',
    check: (job) => (job.childPid === undefined || (Number.isSafeInteger(job.childPid) && /** @type {number} */ (job.childPid) > 0))
      && (job.workerLeaseId === undefined || (typeof job.workerLeaseId === 'string' && HEX_64.test(job.workerLeaseId))),
  },
  {
    // Codex round 6 (finding 1): the session identifier is a CONSUMED field —
    // the resumability projection feeds it to `resumableJobIndicator`, whose
    // `typeof job.zcodeSessionId === 'string'` accepted-session check admits
    // ANY string. Production validateJobRecord requires
    // `isSafeIdentifier(job.zcodeSessionId)` whenever the field is present
    // (state.mjs; the validator is EXPORTED, scripts/lib/identifier.mjs — no
    // substitute needed), so a present-but-unsafe identifier is corruption:
    // named invalid before any predicate runs.
    reason: 'job-record-session-identifier-invalid',
    check: (job) => job.zcodeSessionId === undefined || isSafeIdentifier(job.zcodeSessionId),
  },
  {
    reason: 'job-record-shape-invalid',
    check: (job) => job.ownerLifecycleEpoch === undefined || (typeof job.ownerLifecycleEpoch === 'string' && HEX_64.test(job.ownerLifecycleEpoch)),
  },
  {
    // Codex round 5 (finding 1): the lifecycle trio is INDIVISIBLE exactly as
    // production validateJobRecord requires (`!HOST_LIFECYCLE_FIELDS.some(…
    // in job) || hasHostOwnedLifecycle(job)`, state.mjs): whenever ANY of
    // ownerLifecycleEpoch/executionOwner/hostPlacement is present, ALL three
    // must be present AND valid (validHostLifecycleRecord, command rescue,
    // readOnly false). Without this clause a `cancelled` record carrying a
    // valid epoch but missing the other members passed the checklist AND
    // skipped clause c12 (its validHostLifecycleRecord guard is false) —
    // settling without its required stop evidence.
    reason: 'job-record-lifecycle-trio-incomplete',
    check: (job) => (job.executionOwner === undefined && job.hostPlacement === undefined && job.ownerLifecycleEpoch === undefined)
      || (job.executionOwner !== undefined && job.hostPlacement !== undefined && job.ownerLifecycleEpoch !== undefined
        && job.command === 'rescue' && job.readOnly === false && validHostLifecycleRecord(job)),
  },
  {
    reason: 'job-record-identity-mismatch',
    check: (job, expected) => job.id === expected.jobId
      && job.workspace === expected.workspacePath
      && job.ownerSessionId === expected.ownerSessionId,
  },
  { reason: 'job-record-stop-intent-invalid', check: (job) => job.stopIntent === undefined || validStopIntent(job.stopIntent) },
  {
    // Codex round 7 (finding 2): the stop-intent arm is COMMAND-SCOPED —
    // production validateJobRecord permits a stop intent ONLY on the writable
    // Rescue command (`!('stopIntent' in job) || job.command === 'rescue' &&
    // job.readOnly === false && validStopIntent(job.stopIntent)`, state.mjs).
    // A structurally valid intent on a read-only Rescue or a Review record is
    // post-write corruption; without this clause `endedObligationSettled`
    // accepted the nonterminal `cancelling` winner (cancelling + valid
    // intent) while the writable-guard and marked-runner duties were
    // inapplicable — aggregate settled from state production rejects.
    reason: 'job-record-stop-intent-command-mismatch',
    check: (job) => job.stopIntent === undefined || (job.command === 'rescue' && job.readOnly === false),
  },
  {
    reason: 'job-record-cancellation-evidence-missing',
    check: (job) => !(job.status === 'cancelled' && job.command === 'rescue' && job.readOnly === false
      && validHostLifecycleRecord(job)
      && (job.stopIntent === undefined || job.stopCause === undefined)),
  },
  {
    reason: 'job-record-cancellation-evidence-mismatch',
    check: (job) => !('stopCause' in job) || (job.status === 'cancelled' && job.command === 'rescue' && job.readOnly === false
      && STOP_CAUSES.has(/** @type {any} */ (job.stopCause))
      && validStopIntent(job.stopIntent)
      && /** @type {any} */ (job.stopIntent).cause === job.stopCause),
  },
  {
    reason: 'job-record-runner-marker-invalid',
    check: (job) => !(job.rescueRunnerVersion !== undefined || job.rescueExecutionInput !== undefined)
      || validDetachedRescueRunnerJob(job),
  },
]);

/**
 * Evaluate the WHOLESALE admission checklist against one parsed record.
 * Returns the record on success or the FIRST failing clause's named reason.
 * @param {unknown} record
 * @param {{ jobId: string, workspacePath: string, ownerSessionId: string, jobsDirectory: string }} expected
 * @returns {{ ok: true, projection: Record<string, unknown> } | { ok: false, reason: string }}
 */
function projectDurableJobRecord(record, expected) {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return { ok: false, reason: 'job-record-shape-invalid' };
  const job = /** @type {Record<string, unknown>} */ (record);
  for (const clause of DURABLE_JOB_RECORD_ADMISSION) {
    if (!clause.check(job, expected)) return { ok: false, reason: clause.reason };
  }
  // Codex round 8 (structural endgame b): the COMPLETE validateJobRecord
  // port runs after the specialized clauses — every production-rejected
  // shape that the specialized clauses do not name is the ported
  // `job-record-schema-invalid` rejection (no validation residue).
  if (!validateDurableJobRecordSchema(job, expected)) return { ok: false, reason: 'job-record-schema-invalid' };
  return { ok: true, projection: job };
}

/**
 * The passive durable obligation snapshot for ONE exact bound job (§19.5).
 * @param {{
 *   dataRoot: string,
 *   workspace: string,
 *   ownerSessionId: string,
 *   jobId: string,
 *   expectedOwnerLifecycleEpoch?: string,
 *   viewingPermissionMode?: string,
 * }} input
 * @param {{ mutateBetween?: () => Promise<void> }} [dependencies] test-only
 *   injection point simulating a concurrent writer between the reader's own
 *   before/after fingerprints (the documented consistency limit).
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readDurableObligationSnapshot(input, dependencies = {}) {
  if (typeof input !== 'object' || input === null) throw invalidSnapshotInput('the snapshot input must be an object.');
  const { dataRoot, workspace, ownerSessionId, jobId } = input;
  if (typeof dataRoot !== 'string' || dataRoot.length === 0 || !isAbsolute(dataRoot)) throw invalidSnapshotInput('the data root must be an absolute path.');
  if (typeof workspace !== 'string' || workspace.length === 0 || !isAbsolute(workspace)) throw invalidSnapshotInput('the workspace must be an absolute path.');
  if (typeof ownerSessionId !== 'string' || ownerSessionId.length === 0 || ownerSessionId.length > 256
    || [...ownerSessionId].some((character) => {
      const code = /** @type {number} */ (character.codePointAt(0) ?? 0);
      return code <= 31 || code === 127;
    })) {
    throw invalidSnapshotInput('the owner session must be a bounded control-free identifier.');
  }
  if (typeof jobId !== 'string' || !HEX_64.test(jobId)) throw invalidSnapshotInput('the job id must be a 64-hex digest.');
  const expectedEpoch = input.expectedOwnerLifecycleEpoch;
  if (expectedEpoch !== undefined && (typeof expectedEpoch !== 'string' || !HEX_64.test(expectedEpoch))) {
    throw invalidSnapshotInput('the expected owner lifecycle epoch must be a 64-hex digest.');
  }
  const viewingPermissionMode = input.viewingPermissionMode;
  if (viewingPermissionMode !== undefined && (typeof viewingPermissionMode !== 'string' || viewingPermissionMode.length === 0 || viewingPermissionMode.length > 64)) {
    throw invalidSnapshotInput('the viewing permission mode must be a bounded string.');
  }
  if (typeof dependencies !== 'object' || dependencies === null) throw invalidSnapshotInput('the dependencies must be an object.');
  if (typeof dependencies.mutateBetween !== 'undefined' && typeof dependencies.mutateBetween !== 'function') {
    throw invalidSnapshotInput('the mutateBetween dependency must be a function.');
  }

  /** @type {Record<string, any>} */
  const snapshot = {
    durableSnapshotVersion: DURABLE_SNAPSHOT_VERSION,
    closureObservationVersion: CLOSURE_OBSERVATION_VERSION,
    partition: null,
    enumeration: { entryCount: null, withinBounds: null, reason: null },
    ownerBinding: { present: null, reason: null },
    job: { presence: 'missing', reason: null, projection: null },
    layers: null,
    passive: { snapshotEqual: null, reason: null, lockState: null },
    aggregate: 'unestablished',
    reasons: [],
  };
  const partition = await resolveDurablePartition(dataRoot, workspace);
  snapshot.partition = /** @type {Record<string, any>} */ ({ status: partition.status, reason: partition.reason, workspaceKey: partition.workspaceKey, canonicalWorkspace: partition.canonicalWorkspace });
  if (partition.status !== 'resolved') {
    snapshot.job = { presence: 'missing', reason: partition.reason, projection: null };
    /** @type {string[]} */ (snapshot.reasons).push(partition.reason ?? 'partition-incomplete');
    if ((partition.reason ?? '').includes('missing')
      && !(/** @type {string[]} */ (snapshot.reasons)).includes('partition-missing')) {
      // Cleanup removed the partition: the capture after cleanup is a named
      // failure, never successful cleanup. (When the failing component IS the
      // partition itself, the reason is already exactly `partition-missing`.)
      /** @type {string[]} */ (snapshot.reasons).push('partition-missing');
    }
    return snapshot;
  }
  const directory = /** @type {string} */ (partition.directory);
  const before = await fingerprintTree(directory).catch(() => null);
  if (before !== null && before.nonregular.length > 0) {
    // Codex round 1: a damaged partition entry is a NAMED condition recorded
    // up front (it survives the equality verdict below); the exact bound job
    // may still be readable — the aggregate can never settle either way.
    snapshot.passive.reason = 'partition-nonregular-entry';
  }
  if (before !== null && before.oversized.length > 0) {
    // Codex round 2: a partially fingerprinted (>1 MiB) file is a NAMED
    // condition — a same-length mid-file mutation would be invisible to the
    // head+tail digest, so equality is never trusted on its account.
    snapshot.passive.reason = 'partition-file-oversized';
  }
  snapshot.passive.lockState = await lstat(join(directory, '.state.lock')).then(
    () => 'present',
    (error) => /** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT' ? 'absent' : 'unknown',
  );

  // The exact owner-binding enumeration (hard entry bound; the owner-index
  // derivation is pinned to the production source and pipeline-proven).
  const ownerDirectory = join(directory, 'job-owners', ownerBindingDirectoryName(ownerSessionId));
  let ownerEntries;
  try {
    ownerEntries = await readPrivateDirectory(directory, ownerDirectory, OWNER_INDEX_FS_BOUND);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') {
      snapshot.ownerBinding = { present: false, reason: 'owner-index-missing' };
      snapshot.job = { presence: 'missing', reason: 'owner-binding-missing', projection: null };
      /** @type {string[]} */ (snapshot.reasons).push('owner-binding-missing');
    } else {
      snapshot.ownerBinding = { present: null, reason: 'owner-index-unreadable' };
      snapshot.job = { presence: 'invalid', reason: 'owner-index-unreadable', projection: null };
      /** @type {string[]} */ (snapshot.reasons).push('owner-index-unreadable');
    }
    await finishPassive(snapshot, directory, before, dependencies);
    return snapshot;
  }
  if (ownerEntries.length > OWNER_INDEX_ENTRY_BOUND) {
    snapshot.enumeration = { entryCount: ownerEntries.length, withinBounds: false, reason: 'owner-index-entry-bound-exceeded' };
    snapshot.job = { presence: 'invalid', reason: 'owner-index-entry-bound-exceeded', projection: null };
    /** @type {string[]} */ (snapshot.reasons).push('owner-index-entry-bound-exceeded');
    await finishPassive(snapshot, directory, before, dependencies);
    return snapshot;
  }
  snapshot.enumeration = { entryCount: ownerEntries.length, withinBounds: true, reason: null };
  const ownerEntryNames = ownerEntries.map((entry) => entry.name).sort();
  if (!ownerEntryNames.includes(`${jobId}.json`)) {
    snapshot.ownerBinding = { present: false, reason: 'owner-entry-missing' };
    // Binding-first publication: no owner entry for THIS job is a confirmed
    // absence for this owner — recorded missing, never successful cleanup.
    snapshot.job = { presence: 'missing', reason: 'owner-binding-missing', projection: null };
    /** @type {string[]} */ (snapshot.reasons).push('owner-binding-missing');
    await finishPassive(snapshot, directory, before, dependencies);
    return snapshot;
  }
  // Codex round 1: the exact owner-binding ENTRY is read through the bounded
  // no-follow reader and its ownership tuple validated exactly as production
  // readOwnedJobs defines it (closed key sets, legacy v1 or modern v2 shape
  // with a bounded reservation kind, jobId equal to the entry filename, and
  // ownerSessionId equal to the queried owner) BEFORE the job counts as
  // owned. Corrupt JSON, a conflicting tuple, or a symlinked entry is the
  // named invalid state and can never ground a settled aggregate.
  const ownerEntryPath = join(ownerDirectory, `${jobId}.json`);
  let bindingEntry;
  try {
    bindingEntry = await readBoundedJsonFile(directory, ownerEntryPath, OWNER_BINDING_ENTRY_MAX_BYTES);
  } catch {
    snapshot.ownerBinding = { present: null, reason: 'owner-binding-invalid' };
    snapshot.job = { presence: 'invalid', reason: 'owner-binding-invalid', projection: null };
    /** @type {string[]} */ (snapshot.reasons).push('owner-binding-invalid');
    await finishPassive(snapshot, directory, before, dependencies);
    return snapshot;
  }
  if (!validOwnerBindingEntry(bindingEntry, jobId, ownerSessionId)) {
    snapshot.ownerBinding = { present: null, reason: 'owner-binding-invalid' };
    snapshot.job = { presence: 'invalid', reason: 'owner-binding-invalid', projection: null };
    /** @type {string[]} */ (snapshot.reasons).push('owner-binding-invalid');
    await finishPassive(snapshot, directory, before, dependencies);
    return snapshot;
  }
  snapshot.ownerBinding = { present: true, reason: null };

  // The exact bound job through the production bounded read contract.
  const jobPath = join(directory, 'jobs', `${jobId}.json`);
  let jobStats;
  try {
    jobStats = await lstat(jobPath);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') {
      snapshot.job = { presence: 'missing', reason: 'job-record-missing', projection: null };
      /** @type {string[]} */ (snapshot.reasons).push('job-record-missing');
    } else {
      snapshot.job = { presence: 'invalid', reason: 'job-record-unreadable', projection: null };
      /** @type {string[]} */ (snapshot.reasons).push('job-record-unreadable');
    }
    await finishPassive(snapshot, directory, before, dependencies);
    return snapshot;
  }
  if (jobStats.isSymbolicLink() || !jobStats.isFile()) {
    snapshot.job = { presence: 'invalid', reason: 'job-file-not-regular', projection: null };
    /** @type {string[]} */ (snapshot.reasons).push('job-file-not-regular');
    await finishPassive(snapshot, directory, before, dependencies);
    return snapshot;
  }
  if (process.platform !== 'win32' && (jobStats.mode & 0o777) !== JOB_FILE_PRIVATE_MODE) {
    snapshot.job = { presence: 'invalid', reason: 'job-file-permission-deviates', projection: null };
    /** @type {string[]} */ (snapshot.reasons).push('job-file-permission-deviates');
    await finishPassive(snapshot, directory, before, dependencies);
    return snapshot;
  }
  let record;
  try {
    record = await readBoundedJsonFile(directory, jobPath, OWNER_JOB_BODY_BOUND);
  } catch {
    snapshot.job = { presence: 'invalid', reason: 'job-record-unparseable', projection: null };
    /** @type {string[]} */ (snapshot.reasons).push('job-record-unparseable');
    await finishPassive(snapshot, directory, before, dependencies);
    return snapshot;
  }
  const projection = projectDurableJobRecord(record, { jobId, workspacePath: partition.workspacePath, ownerSessionId, jobsDirectory: join(directory, 'jobs') });
  if (!projection.ok) {
    snapshot.job = { presence: 'invalid', reason: projection.reason, projection: null };
    /** @type {string[]} */ (snapshot.reasons).push(projection.reason);
    await finishPassive(snapshot, directory, before, dependencies);
    return snapshot;
  }
  // Codex round 9: the production readOwnedJobs CROSS-FILE invariants
  // (state.mjs:2833-2835: `job.ownerSessionId !== ownerSessionId ||
  // validModern !== validRescueReservationKind(job.rescueReservationKind) ||
  // validModern && binding.rescueReservationKind !== job.rescueReservationKind`
  // → OWNED_JOB_RECORD_INVALID) between the owner ENTRY and the canonical
  // JOB: legacy/modern entry-version parity against the job's reservation
  // marker, and reservation-kind equality. The ownerSessionId equality arm
  // is already the identity clause above; these two arms are new. A
  // mismatched pair is post-write corruption → the named invalid state,
  // never settled.
  const entryIsModern = /** @type {any} */ (bindingEntry).version === 2;
  const jobReservationKind = projection.projection.rescueReservationKind;
  const jobHasValidKind = jobReservationKind === 'bound' || jobReservationKind === 'unbound';
  if (entryIsModern !== jobHasValidKind
    || (entryIsModern && /** @type {any} */ (bindingEntry).rescueReservationKind !== jobReservationKind)) {
    snapshot.ownerBinding = { present: null, reason: 'owner-binding-cross-invariant-mismatch' };
    snapshot.job = { presence: 'invalid', reason: 'owner-binding-cross-invariant-mismatch', projection: null };
    /** @type {string[]} */ (snapshot.reasons).push('owner-binding-cross-invariant-mismatch');
    await finishPassive(snapshot, directory, before, dependencies);
    return snapshot;
  }
  // Codex round 1: a present detached-runner marker is validated with the
  // EXPORTED production validator (rescue-execution-input.mjs
  // validDetachedRescueRunnerJob) BEFORE any obligation predicate is
  // interpreted — production state validation rejects an invalid marker at
  // write time, so its presence on disk is corruption: the record is the
  // named invalid state and can never ground a settled aggregate.
  if ((projection.projection.rescueRunnerVersion !== undefined
    || projection.projection.rescueExecutionInput !== undefined)
    && !validDetachedRescueRunnerJob(record)) {
    snapshot.job = { presence: 'invalid', reason: 'job-record-runner-marker-invalid', projection: null };
    /** @type {string[]} */ (snapshot.reasons).push('job-record-runner-marker-invalid');
    await finishPassive(snapshot, directory, before, dependencies);
    return snapshot;
  }
  const job = projection.projection;
  snapshot.job = {
    presence: 'found',
    reason: null,
    projection: {
      id: job.id,
      workspace: job.workspace,
      ownerSessionId: job.ownerSessionId,
      ownerTurnId: job.ownerTurnId,
      command: job.command,
      readOnly: job.readOnly,
      status: job.status,
      childPid: job.childPid ?? null,
      workerLeaseId: job.workerLeaseId ?? null,
      // Codex round 3: both production runner versions are NUMBERS
      // (rescue-execution-input.mjs RESCUE_RUNNER_HISTORICAL_VERSION = 1,
      // RESCUE_RUNNER_VERSION = 2) — the validated marker persists its
      // numeric identity, never a null from a string-only check.
      rescueRunnerVersion: job.rescueRunnerVersion ?? null,
      stopIntent: job.stopIntent ?? null,
      stopCause: typeof job.stopCause === 'string' ? job.stopCause : null,
      resultArtifact: typeof job.resultArtifact === 'string' ? job.resultArtifact : null,
      ownerLifecycleEpoch: job.ownerLifecycleEpoch ?? null,
      executionOwner: typeof job.executionOwner === 'string' ? job.executionOwner : null,
      hostPlacement: typeof job.hostPlacement === 'string' ? job.hostPlacement : null,
    },
  };

  // ---- Obligation layers: the EXPORTED production predicates ONLY. ----
  const jobStatus = String(job.status);
  const terminal = TERMINAL.has(jobStatus);
  const markedClaim = isMarkedRunnerClaim(job);
  const rawOutcome = { kind: null, job };
  const endedSettled = endedObligationSettled(rawOutcome);
  const stopIntentApplicable = job.command === 'rescue' && job.readOnly === false
    && (jobStatus === 'cancelling' || jobStatus === 'cancelled');
  // Codex round 5 (finding 3): presence and validity are derived from the
  // record's persisted stopIntent for ANY status — production permits a
  // natural success/failure to win AFTER a stop intent was persisted
  // (stopAndSettle persists the intent FIRST, then elects the winner), and
  // restricting this projection to cancelling/cancelled reported
  // present:null/valid:null for those valid terminal records. `applicable`
  // stays the separate cancellation-duty fact below.
  const stopIntent = {
    present: job.stopIntent !== undefined,
    valid: job.stopIntent !== undefined && validStopIntent(job.stopIntent),
  };
  const writableGuardApplicable = job.command === 'rescue' && job.readOnly === false && !terminal;
  const writableGuardRetained = writableGuardApplicable ? true : job.command === 'rescue' && job.readOnly === false && terminal ? false : null;

  // Binding currency from the EXACT rescue-binding partition (exported pure
  // readers; the partition key derivation is production's own).
  const partitionKey = rescueBindingPartitionKey({ parentSessionId: ownerSessionId, workspace: partition.workspacePath });
  const bindingPartitionPath = join(directory, `rescue-binding-session-${partitionKey}.json`);
  const bindingAuthorityPath = join(directory, `rescue-binding-authority-${partitionKey}.json`);
  /** @type {{ state: string, reason: string | null, anchorsJob: string | null }} */
  let binding = { state: 'unknown', reason: 'binding-partition-unreadable', anchorsJob: null };
  // Codex round 4 (binding-pair completeness clause): BOTH files are checked
  // BEFORE any classification. Production readBindingPartitionSnapshot
  // rejects a partition-only pair AND an authority-only pair (its
  // `allowAuthorityOnly` is an explicit REPAIR-ONLY option the passive
  // reader never sets), so either incomplete combination is the unknown
  // binding state — never a confirmed `not-current`, never resumable.
  let partitionExists = false;
  let authorityExists = false;
  try {
    await lstat(bindingPartitionPath);
    partitionExists = true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== 'ENOENT') partitionExists = true;
  }
  try {
    await lstat(bindingAuthorityPath);
    authorityExists = true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== 'ENOENT') authorityExists = true;
  }
  if (!partitionExists && !authorityExists) {
    binding = { state: 'not-current', reason: 'binding-partition-absent', anchorsJob: null };
  } else if (partitionExists !== authorityExists) {
    binding = { state: 'unknown', reason: 'binding-pair-incomplete', anchorsJob: null };
  } else {
    try {
      const partitionRecord = await readRescueBindingPartitionFile(directory, bindingPartitionPath, { parentSessionId: ownerSessionId, workspace: partition.workspacePath });
      const anchors = partitionRecord.records.filter((bindingRecord) => bindingRecord.currentJobId === jobId);
      // Codex round 4 (anchor-cardinality clause): production
      // rescueBindingPointsAtJob requires EXACTLY ONE matching record and it
      // active — partition validation enforces key/executor uniqueness, NOT
      // currentJobId uniqueness, so multiple anchors on one job are a real
      // shape that can never manufacture a positive resumability fact.
      const activeAnchors = anchors.filter((bindingRecord) => bindingRecord.state === 'active');
      if (anchors.length > 1) {
        binding = { state: 'unknown', reason: 'binding-anchor-ambiguous', anchorsJob: null };
      } else if (activeAnchors.length === 1) {
        binding = { state: 'current', reason: null, anchorsJob: jobId };
      } else if (anchors.length === 1) {
        binding = { state: 'not-current', reason: 'binding-not-active', anchorsJob: jobId };
      } else {
        binding = { state: 'not-current', reason: 'binding-does-not-anchor-job', anchorsJob: null };
      }
    } catch {
      binding = { state: 'unknown', reason: 'binding-partition-unreadable', anchorsJob: null };
    }
    // Codex round 1 (refined round 4): with the partition present the
    // authority is REQUIRED (the pair rule above already handled every
    // incomplete combination); an unreadable authority keeps the binding
    // unknown and blocks a settled aggregate.
    try {
      await readRescueBindingAuthorityFile(directory, bindingAuthorityPath, { parentSessionId: ownerSessionId, workspace: partition.workspacePath });
    } catch {
      binding = { state: 'unknown', reason: 'binding-authority-unreadable', anchorsJob: null };
    }
  }

  const epochApplicable = expectedEpoch !== undefined;
  const epochMatches = epochApplicable ? job.ownerLifecycleEpoch === expectedEpoch : null;

  snapshot.layers = {
    winner: { state: terminal ? 'terminal' : 'nonterminal', terminalStatus: terminal ? jobStatus : null },
    stopIntent: {
      applicable: stopIntentApplicable,
      present: stopIntent.present,
      valid: stopIntent.valid,
      reason: stopIntentApplicable
        ? null
        : 'not-applicable: a durable stop intent exists only on the cancelling/cancelled writable rescue path (stop-intent validity contract; foreign-origin interrupts persist none)',
    },
    runnerCleanupDuty: {
      applicable: markedClaim,
      outstanding: markedClaim ? true : null,
      reason: markedClaim
        ? 'terminal-or-active record still carries the marked runner claim (markedRescueRunnerVersion + digest lease + safe childPid): the local termination duty is outstanding'
        : 'not-applicable: the record carries no marked runner claim',
    },
    endedObligation: { settled: endedSettled, reason: endedSettled ? null : 'endedObligationSettled(raw-record projection) is false' },
    writableGuard: {
      applicable: writableGuardApplicable,
      retained: writableGuardRetained,
      reason: writableGuardApplicable
        ? 'the nonterminal writable rescue job holds the workspace writable guard (WRITABLE_JOB_EXISTS semantics) — the safe unresolved state'
        : 'not-applicable',
    },
    bindingCurrency: { state: binding.state, reason: binding.reason, anchorsJob: binding.anchorsJob },
    lifecycleEpoch: {
      applicable: epochApplicable,
      matches: epochMatches,
      reason: epochApplicable
        ? (epochMatches ? null : 'the declared owner lifecycle epoch does not match the record')
        : 'not-applicable: no epoch was declared for this observation',
    },
    resumable: viewingPermissionMode === undefined || binding.state === 'unknown'
      ? null
      : resumableIndicatorFor(job, viewingPermissionMode, binding.state === 'current'),
  };

  // ---- Aggregate: settled ONLY when every applicable duty is positively
  // established and the reader's own passivity is proven. ----
  const reasons = /** @type {string[]} */ (snapshot.reasons);
  // Independent per-layer reasons — never an else-if chain: a terminal record
  // with an outstanding marked claim carries BOTH named facts.
  if (snapshot.job.presence === 'found' && !endedSettled) reasons.push('ended-obligation-unsettled');
  if (snapshot.job.presence === 'found' && markedClaim) reasons.push('runner-cleanup-duty-outstanding');
  if (snapshot.job.presence === 'found' && writableGuardApplicable) reasons.push('writable-guard-retained');
  if (snapshot.job.presence === 'found' && epochApplicable && epochMatches !== true) reasons.push('lifecycle-epoch-mismatch');
  if (binding.state === 'unknown') reasons.push('binding-currency-unknown');
  await finishPassive(snapshot, directory, before, dependencies);
  if (snapshot.passive.snapshotEqual === false) reasons.push('snapshot-unequal');
  if (snapshot.passive.reason === 'partition-nonregular-entry') reasons.push('partition-nonregular-entry');
  if (snapshot.passive.reason === 'partition-file-oversized') reasons.push('partition-file-oversized');
  const intactSnapshot = snapshot.passive.snapshotEqual === true;
  // Codex round 1: binding currency must be POSITIVELY resolved (current or
  // not-current) for a settled aggregate — an unknown binding (torn pair,
  // unreadable partition) leaves the exact resumability conjunct
  // unestablished, and `resumable` is never asserted from it.
  const bindingResolved = /** @type {Record<string, any>} */ (snapshot.layers)?.bindingCurrency?.state !== 'unknown';
  if (reasons.length === 0 && snapshot.job.presence === 'found' && endedSettled && !markedClaim
    && !writableGuardApplicable && (!epochApplicable || epochMatches === true) && intactSnapshot
    && bindingResolved && snapshot.passive.reason !== 'partition-nonregular-entry'
    && snapshot.passive.reason !== 'partition-file-oversized') {
    snapshot.aggregate = 'settled';
  } else if (intactSnapshot && snapshot.job.presence === 'found' && (markedClaim || writableGuardApplicable)) {
    // Positively observed retained duties: the safe unresolved states. A torn
    // snapshot never reaches this branch — an unequal pass marks the whole
    // observation unestablished (the documented consistency limit), however
    // clear the individual record looked.
    snapshot.aggregate = 'unresolved';
  } else {
    snapshot.aggregate = 'unestablished';
  }
  return snapshot;
}

/**
 * The public Resumability Indicator through the EXPORTED production
 * predicate (job-control.mjs resumableJobIndicator) — projected only when
 * the caller declared the viewing permission mode.
 * @param {Record<string, unknown>} job @param {string} viewingPermissionMode @param {boolean} bindingCurrent
 * @returns {boolean | null}
 */
function resumableIndicatorFor(job, viewingPermissionMode, bindingCurrent) {
  try {
    return resumableJobIndicator(job, viewingPermissionMode, bindingCurrent);
  } catch {
    return null;
  }
}

/**
 * Close the passive contract: re-fingerprint the partition (after the
 * optional injected mutation) and record the equality verdict.
 * @param {Record<string, any>} snapshot @param {string} directory
 * @param {{ text: string, nonregular: string[], oversized: string[] } | null} before @param {{ mutateBetween?: () => Promise<void> }} dependencies
 * @returns {Promise<void>}
 */
async function finishPassive(snapshot, directory, before, dependencies) {
  if (typeof dependencies.mutateBetween === 'function') await dependencies.mutateBetween();
  if (before === null) {
    snapshot.passive.snapshotEqual = null;
    snapshot.passive.reason = 'pre-read-fingerprint-unavailable';
    return;
  }
  const after = await fingerprintTree(directory).catch(() => null);
  if (after === null) {
    snapshot.passive.snapshotEqual = null;
    snapshot.passive.reason = 'post-read-fingerprint-unavailable';
    return;
  }
  snapshot.passive.snapshotEqual = after.text === before.text;
  // Codex round 2: equality is never trusted while a >1 MiB file stands
  // partially fingerprinted — its mid-file contents could have changed
  // undetected, so the pass reads as NOT equal by construction.
  if (after.oversized.length > 0 || before.oversized.length > 0) {
    snapshot.passive.snapshotEqual = false;
  }
  // A pre-set named condition (the nonregular/oversized classifications)
  // survives the equality verdict; a generic inequality only fills an
  // otherwise-unnamed pass.
  if (!snapshot.passive.snapshotEqual && snapshot.passive.reason === null) {
    snapshot.passive.reason = 'the partition changed during the read pass';
  }
}
