// @ts-check
/**
 * The GENERATED PRELOAD seam (research-only): the fixture-generated passive
 * stdout-capture + startup-identity preload source, its writer, and the
 * frozen constants both the generated source and the read side share.
 * Split out of closure-observation.mjs (review round 8) so the executing
 * provenance closure of local-process-observation.mjs is small and fully
 * byte-bound; closure-observation.mjs re-exports this surface unchanged.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Module-INIT snapshot of THIS module's executing source (the provenance
// discipline): the local-process observer's v4 digest binds these bytes.
export const EXECUTING_CLOSURE_PRELOAD_SOURCE = readFileSync(fileURLToPath(import.meta.url));

/** The frozen §19.3 fail-closed terminal stdout capture bound. */
export const STDOUT_CAPTURE_MAX_BYTES = 65_536;

/** @param {string} message @returns {TypeError} */
function invalidClosureInput(message) {
  return new TypeError(`Invalid closure preload input: ${message}`);
}

/** The frozen exact terminal argv selector (launcher.mjs ALLOWED set). */
export const TERMINAL_ARGV_SELECTOR = Object.freeze(['invoke-prepared', 'rescue']);

/** The closed version of the startup identity record the preload writes (local-settlement Task 2, report §25.4 item 3; v2 adds the precise generation instants). */
export const IDENTITY_RECORD_VERSION = 2;

/** Bounded identity-record size bound (the record is a small closed JSON, like the exit meta). */
export const IDENTITY_RECORD_MAX_BYTES = 4 * 1024;

/**
 * Nonce-keyed record-file suffixes, one per role (§25.4: the nonce binds the
 * invocation SCOPE — the broker daemon inherits the capture environment at
 * its spawn — and the entry/argv shape selects the role, never the nonce).
 */
export const INVOCATION_IDENTITY_SUFFIX = '.identity.json';
export const BROKER_IDENTITY_SUFFIX = '.identity-broker.json';

/** Fixture-only capture environment variables (the (1) gate of §19.3(b)). */
export const CAPTURE_DIRECTORY_VARIABLE = 'ZCODE_SHELL_WAIT_CAPTURE_DIR';
export const CAPTURE_NONCE_VARIABLE = 'ZCODE_SHELL_WAIT_CAPTURE_NONCE';
export const CAPTURE_ENTRY_VARIABLE = 'ZCODE_SHELL_WAIT_CAPTURE_ENTRY_REALPATH';
export const CAPTURE_MAX_BYTES_VARIABLE = 'ZCODE_SHELL_WAIT_CAPTURE_MAX_BYTES';
/**
 * The declared broker-daemon entry (local-settlement Task 2): the fixture
 * composes the installed zcode-broker.mjs realpath so the preload can record
 * the daemon's own startup identity (§25.4 item 4 — the daemon is the
 * mediation hop of the ancestry join). Absent → the broker gate is disabled
 * and the preload stays inert for broker processes.
 */
export const CAPTURE_BROKER_ENTRY_VARIABLE = 'ZCODE_SHELL_WAIT_CAPTURE_BROKER_ENTRY_REALPATH';

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
  // ---- P1 shared environment well-formedness (both roles) ----
  var ENV_OK = typeof DIRECTORY === 'string' && DIRECTORY.length > 0 && DIRECTORY.charAt(0) === '/'
    && typeof NONCE === 'string' && /^[a-f0-9]{64}$/.test(NONCE)
    && typeof ENTRY === 'string' && ENTRY.length > 0 && ENTRY.charAt(0) === '/'
    && Number.isSafeInteger(MAX_BYTES) && MAX_BYTES === ${JSON.stringify(STDOUT_CAPTURE_MAX_BYTES)};
  var entryRealpath = null;
  if (ENV_OK) { try { entryRealpath = FS.realpathSync(process.argv[1]); } catch (error) { entryRealpath = null; } }
  // ---- STARTUP IDENTITY RECORD writer (both roles; exclusive wx 0600;
  // a failed or already-present record is named by the read side and NEVER
  // affects delivery or exit behavior) ----
  // PRECISE GENERATION INSTANTS (review round 7): performance.timeOrigin is
  // the process's own sub-millisecond epoch start — the generation binding
  // can then require the OS lstart second to CONTAIN this instant, which
  // whole-second lstart arithmetic alone can never do for fast startups.
  var START_ORIGIN_MS = (typeof performance === 'object' && performance !== null && typeof performance.timeOrigin === 'number' && Number.isFinite(performance.timeOrigin))
    ? performance.timeOrigin
    : null;
  function writeIdentityRecord(suffix, payload) {
    try { FS.writeFileSync(PATH.join(DIRECTORY, NONCE + suffix), JSON.stringify(payload) + '\\n', { mode: 0o600, flag: 'wx' }); }
    catch (error) { /* named by the read side as identity-record-missing; delivery unaffected */ }
  }
  // ---- BROKER-DAEMON GATE (local-settlement Task 2; report §25.4 item 4):
  // the declared broker entry realpath present, argv exactly [broker, config]
  // (three argv segments, nonempty config), and the entry realpaths to the
  // declared broker entry. RECORD ONLY — no stdout interception and no exit
  // bookkeeping: the stdout capture stays the gated invocation's alone. The
  // raw config path is never persisted (only its canonical sha256). Without
  // a declared broker entry the gate is disabled and every broker process is
  // inert. The nonce binds the invocation SCOPE (the daemon inherits this
  // environment at its spawn); the argv shape selects the role.
  var BROKER_ENTRY = process.env[${JSON.stringify(CAPTURE_BROKER_ENTRY_VARIABLE)}];
  if (ENV_OK && entryRealpath !== null && typeof BROKER_ENTRY === 'string' && BROKER_ENTRY.length > 0 && BROKER_ENTRY.charAt(0) === '/'
    && process.argv.length === 3 && typeof process.argv[2] === 'string' && process.argv[2].length > 0 && entryRealpath === BROKER_ENTRY) {
    var configRealpath = process.argv[2];
    try { configRealpath = FS.realpathSync(process.argv[2]); } catch (error) { /* digest the given path */ }
    writeIdentityRecord(${JSON.stringify(BROKER_IDENTITY_SUFFIX)}, {
      version: ${JSON.stringify(IDENTITY_RECORD_VERSION)},
      role: 'broker-daemon',
      nonce: NONCE,
      entryRealpath: entryRealpath,
      configRealpathSha256: CRYPTO.createHash('sha256').update(configRealpath, 'utf8').digest('hex'),
      pid: process.pid,
      ppid: process.ppid,
      firstWriteEpochMs: Date.now(),
      startOriginMs: START_ORIGIN_MS,
      firstWritePreciseMs: START_ORIGIN_MS === null ? null : START_ORIGIN_MS + performance.now(),
    });
    return;
  }
  // ---- P1 INVOCATION gate (the frozen §19.3 selector, unchanged) ----
  if (!ENV_OK) return;
  if (process.argv.length !== ${2 + TERMINAL_ARGV_SELECTOR.length}) return;
  if (process.argv[2] !== ${JSON.stringify(TERMINAL_ARGV_SELECTOR[0])} || process.argv[3] !== ${JSON.stringify(TERMINAL_ARGV_SELECTOR[1])}) return;
  if (entryRealpath === null || entryRealpath !== ENTRY) return;
  writeIdentityRecord(${JSON.stringify(INVOCATION_IDENTITY_SUFFIX)}, {
    version: ${JSON.stringify(IDENTITY_RECORD_VERSION)},
    role: 'invocation',
    nonce: NONCE,
    entryRealpath: entryRealpath,
    argv: process.argv.slice(2),
    pid: process.pid,
    ppid: process.ppid,
    firstWriteEpochMs: Date.now(),
    startOriginMs: START_ORIGIN_MS,
    firstWritePreciseMs: START_ORIGIN_MS === null ? null : START_ORIGIN_MS + performance.now(),
  });
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
