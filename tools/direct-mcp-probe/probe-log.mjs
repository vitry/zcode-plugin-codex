// @ts-nocheck
/**
 * Private append-only JSONL log primitive for the direct `mcpServer/tool/
 * call` feasibility probe (small single-responsibility helper introduced by
 * the Task 2 gate re-review round 3, named per the plan's helper rule). One
 * responsibility: durable record IO under the advisory event lock — closed-
 * record validation, dense sequence assignment, and the evidence invariants
 * (private mode 0600, no symlinks, size bound, foreign-nonce and torn-line
 * refusal, settlement prerequisites) — with NO knowledge of which writer is
 * calling. Handler-kind writes are additionally bound to PROCESS IDENTITY
 * plus a CAPABILITY SECRET: the disposable server registers its own pid and
 * the digest of its spawn-time/instantiation-time capability secret — a
 * transient, runNonce-bound, mode-0600 file inside the private run directory
 *, removed with the run — and this primitive accepts
 * `DIRECT_HANDLER_EVENT_KINDS` only when the caller PRESENTS the secret that
 * hashes to the registered digest, from the registered owner process. The
 * server never writes the secret itself to any file. The owner file is
 * WRITTEN only by server.mjs's module-private function as a side effect of
 * genuinely starting a server; there is deliberately no importable API that
 * claims ownership, because that would let a driver process forge handler
 * provenance before the server starts. ACCEPTED INVARIANT, stated and
 * recorded: in the real campaign the server is a spawned separate process
 * holding the spawn-time secret in memory, so driver-process code physically
 * cannot write handler evidence. File-based provenance is TAMPER-EVIDENT,
 * NOT tamper-proof: a same-user process with run-directory access can write
 * its own owner file with its own secret and land handler-kind records, but
 * the driver's verify-then-reduce gate
 * (`observer.reduceDirectProbeLog`) fails such runs closed with
 * `PROBE_OWNER_INVALID`, so forged records are never REDUCIBLE as handler
 * evidence. A driver process that itself fabricates evidence is out of scope
 * (its artifacts are the evidence) — an instrument limitation, recorded, not
 * hidden.
 */
import fs, { constants, readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import fsp, { lstat, open, rename, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';

import { withFileLock } from '../../scripts/lib/fs.mjs';
import { canonicalJson } from '../mcp-context-probe/observer.mjs';
import { DIRECT_HANDLER_EVENT_KINDS, hashProbeValue, validateDirectEventRecord } from './observer.mjs';

/** Maximum accepted size of the JSONL event log in bytes. */
export const DIRECT_PROBE_EVENTS_MAX_BYTES = 4 * 1024 * 1024;

const RUN_NONCE_PATTERN = /^[0-9a-f]{64}$/;

/** @param {string} code @param {string} message */
function directError(code, message) {
  // The code is embedded in the message (the entry-inventory convention) so
  // closed-code assertions can match failures textually as well as via .code.
  const error = /** @type {Error & {code:string}} */ (new Error(`${code}: ${message}`));
  error.code = code;
  return error;
}

/**
 * ROUND 45/46: evidence-file reads reject a final symlink, a non-regular
 * file, and non-private mode, closed: the private run directory's evidence
 * boundary is byte-identical content INSIDE the directory, so a symlinked
 * alias — even to byte-identical bytes outside it — is never read. The
 * path is resolved exactly ONCE by an O_NOFOLLOW open, the boundary checks
 * run with fstat ON THAT DESCRIPTOR, and the bytes flow through the same
 * descriptor — a concurrent directory-entry swap between validation and IO
 * cannot redirect the read through an alias. ENOENT propagates unchanged so
 * the protocol's missing-file windows keep their approved semantics.
 * @param {string} path
 * @param {string|undefined} [encoding]
 * @returns {Buffer|string}
 */
export function readEvidenceFileSync(path, encoding = undefined, identityOut = null) {
  const fd = openEvidenceFile(path, constants.O_RDONLY);
  try {
    if (identityOut !== null) Object.assign(identityOut, assertEvidenceFileDescriptor(fd));
    return fs.readFileSync(fd, encoding);
  } finally { fs.closeSync(fd); }
}

/**
 * ROUND 46: truncates an evidence file through a descriptor opened with
 * O_NOFOLLOW and verified by fstat on that same descriptor — the repair
 * path's validation and IO share one descriptor, so a concurrent
 * directory-entry swap cannot redirect the truncation through an alias.
 * @param {string} path
 * @param {number} length
 * @returns {void}
 */
function truncateEvidenceFileSync(path, length, validatedIdentity = null) {
  const fd = openEvidenceFile(path, constants.O_WRONLY);
  try {
    const identity = assertEvidenceFileDescriptor(fd);
    // ROUND 48: the truncation mutates exactly the inode that was validated
    // — a mode-0600 regular file swapped into the path after validation is
    // refused instead of being truncated.
    if (validatedIdentity !== null
      && (identity.dev !== validatedIdentity.dev || identity.ino !== validatedIdentity.ino || identity.mode !== validatedIdentity.mode)) {
      throw directError('PROBE_LOG_REPLACED', 'The evidence file was replaced after validation; the repair truncation refuses to follow the swap.');
    }
    fs.ftruncateSync(fd, length);
  } finally { fs.closeSync(fd); }
}

/**
 * ROUND 46: resolves an evidence path exactly once with O_NOFOLLOW. A
 * symlink at the path is refused closed (ELOOP mapped to the protocol's
 * symlink code); ENOENT propagates unchanged.
 * @param {string} path
 * @param {number} flags
 * @returns {number}
 */
function openEvidenceFile(path, flags) {
  try {
    return fs.openSync(path, flags | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (errorCode(error) === 'ELOOP') throw directError('PROBE_LOG_SYMLINK', 'The direct probe evidence file must not be a symlink.');
    throw error;
  }
}

/**
 * ROUND 46: the evidence-file boundary checks, evaluated with fstat on the
 * already-open descriptor so they describe the very inode the IO reads.
 * @param {number} fd
 * @returns {void}
 */
function assertEvidenceFileDescriptor(fd) {
  const stats = fs.fstatSync(fd);
  if (!stats.isFile()) throw directError('PROBE_LOG_NOT_FILE', 'The direct probe evidence file must be a regular file.');
  if (process.platform !== 'win32' && (stats.mode & 0o777) !== 0o600) throw directError('PROBE_LOG_MODE', 'The direct probe evidence file must be mode 0600.');
  return { dev: stats.dev, ino: stats.ino, mode: stats.mode & 0o777 };
}

/** @param {unknown} error */
function errorCode(error) {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
}

/** @param {string} nonce */
function requireRunNonce(nonce) {
  if (!RUN_NONCE_PATTERN.test(nonce)) throw directError('PROBE_NONCE_INVALID', 'The probe run nonce must be 64 lowercase hexadecimal characters.');
}

/**
 * The transient handler-owner registration file, inside the private run
 * directory. The filename is the fixed contract between this module's
 * reader and server.mjs's module-private writer.
 */
const HANDLER_OWNER_FILENAME = 'handler-owner.json';

/**
 * The APPEND-ONLY events seal journal, inside the private run directory.
 * One line per committed append: {version, runNonce, recordCount,
 * eventsDigest, sealMac}. Never renamed, never truncated — appended and
 * fsynced under the same advisory lock as the record it commits. The last
 * VALID journal line defines the committed prefix; records beyond it are
 * uncommitted (a crash between record fsync and journal fsync) and never
 * reduce as evidence.
 */
const SEAL_JOURNAL_FILENAME = 'events-seal.jsonl';

/**
 * The sidecar preserving uncommitted trailing records recovered on append
 * (kill between record fsync and journal fsync). Appended, never truncated,
 * so every recovery event stays visible in evidence.
 */
const UNCOMMITTED_FILENAME = 'events-uncommitted.jsonl';

/**
 * The durable, authenticated recovery INTENT: written and fsynced before the
 * event log is truncated, removed only after the recovery commit line is
 * durable. A crash in the truncation-to-commit window leaves the intent
 * behind, and every later append (and reduction) must resolve it — the
 * sidecar can never become unanchored, silently deletable evidence.
 */
const RECOVERY_INTENT_FILENAME = 'recovery-intent.json';

/**
 * The sidecar preserving TORN seal-journal tails removed by the append-time
 * repair: each entry is one authenticated record carrying the removed
 * fragment verbatim, so the removed bytes stay bounded, visible, and
 * tamper-evident.
 */
const TORN_JOURNAL_FILENAME = 'journal-torn.jsonl';

/**
 * The durable, authenticated repair INTENT: written and fsynced before the
 * repaired journal is truncated, removed only after the repair-anchor
 * commit line is durable. A crash in the truncation-to-anchor window leaves
 * the intent behind, and every later append (and reduction) must resolve it
 * — the preserved fragments can never become unanchored, silently deletable
 * evidence.
 */
const REPAIR_INTENT_FILENAME = 'repair-intent.json';

/**
 * The sidecar preserving PARTIAL torn-sidecar tails recovered on repair: a
 * crashed fragment write can leave bytes beyond the last valid record
 * boundary of journal-torn.jsonl; those bytes are moved here verbatim as one
 * authenticated record per recovery, so the repair can resume on a clean
 * boundary without erasing the evidence of the crashed attempt.
 */
const REPAIRED_PARTIAL_FILENAME = 'journal-torn-partial.jsonl';

/**
 * Computes the journal line's authentication code: HMAC-SHA256 keyed by the
 * run capability secret bytes over the canonical {runNonce, recordCount,
 * eventsDigest} triple — plus {recoveredCount, recoveredDigest,
 * recoveredLength} when the line records a recovery, and plus
 * {tornFragmentCount, tornDigest, tornLength} when the line anchors
 * preserved torn-journal fragments. Both writer processes hold the secret
 * (the driver generated it; the server received it through spawn-time env),
 * so both can commit journal lines; a process without it can neither commit
 * nor forge.
 * @param {string} ownerSecret
 * @param {{runNonce: string, recordCount: number, eventsDigest: string, recoveredCount?: number, recoveredDigest?: string, recoveredLength?: number, tornFragmentCount?: number, tornDigest?: string, tornLength?: number}} sealed
 */
function computeSealMac(ownerSecret, { runNonce, recordCount, eventsDigest, recoveredCount, recoveredDigest, recoveredLength, tornFragmentCount, tornDigest, tornLength, partialDigest, partialLength }) {
  const payload = { runNonce, recordCount, eventsDigest };
  if (recoveredCount !== undefined) {
    payload.recoveredCount = recoveredCount;
    payload.recoveredDigest = recoveredDigest;
    payload.recoveredLength = recoveredLength;
  }
  if (tornDigest !== undefined) {
    payload.tornFragmentCount = tornFragmentCount;
    payload.tornDigest = tornDigest;
    payload.tornLength = tornLength;
  }
  if (partialDigest !== undefined) {
    payload.partialDigest = partialDigest;
    payload.partialLength = partialLength;
  }
  return createHmac('sha256', Buffer.from(ownerSecret, 'utf8')).update(canonicalJson(payload)).digest('hex');
}

/**
 * COMMITS one append: appends the journal line for the just-fsynced record
 * and fsyncs it. MUST run under the advisory event lock, after the event
 * record is durable, with recordCount = committed records including this
 * one. When the append recovered uncommitted trailing records (the sidecar
 * was appended and fsynced first), the commit line must RECORD that
 * recovery: recoveredCount, the sha256 of the exact sidecar bytes, and the
 * cumulative sidecar byte length are folded into the seal Mac and written
 * onto the line, so the reader verifies the sidecar PREFIX against every
 * later reduction. When the append repaired the journal (or anchors an
 * earlier repair), tornFragmentCount, tornDigest, and tornLength bind the
 * preserved fragments the same way, and partialDigest/partialLength bind the
 * preserved partial-tail evidence. Every commit also fsyncs the run
 * directory after the journal line and fails closed (PROBE_OWNER_INVALID)
 * when that fsync cannot complete, so a commit is only ever REPORTED once
 * its journal entry's directory durability holds. Returns the committed
 * state — the caller (driver) keeps the LAST commit as its in-memory final
 * anchor.
 * @param {{eventsPath: string, runDirectory: string, runNonce: string, ownerSecret: string, recordCount: number, recoveredCount?: number, recoveredDigest?: string, recoveredLength?: number, tornFragmentCount?: number, tornDigest?: string, tornLength?: number, partialDigest?: string, partialLength?: number}} input
 * @returns {Promise<{recordCount: number, eventsDigest: string}>}
 */
async function commitDirectProbeSealLocked({ eventsPath, runDirectory, runNonce, ownerSecret, recordCount, recoveredCount, recoveredDigest, recoveredLength, tornFragmentCount, tornDigest, tornLength, partialDigest, partialLength, verifiedJournalIdentity = null }) {
  const bytes = await readBoundedEventLog(eventsPath);
  const eventsDigest = createHash('sha256').update(bytes).digest('hex');
  const sealMac = computeSealMac(ownerSecret, { runNonce, recordCount, eventsDigest, recoveredCount, recoveredDigest, recoveredLength, tornFragmentCount, tornDigest, tornLength, partialDigest, partialLength });
  const journalPath = join(runDirectory, SEAL_JOURNAL_FILENAME);
  // ROUND 57: an EXISTING journal makes the appended line durable the
  // moment its own sync succeeds (its directory entry predates the line);
  // a NEWLY CREATED journal needs the creation-path directory fsync below
  // as part of its durability. The split decides whether failures after
  // the sync carry the landed commit (existing) or refuse without adoption
  // (newly created, as today).
  let journalExisted = true;
  let journalHandle;
  let journalCloseError = null;
  try {
    journalHandle = await fsp.open(journalPath, constants.O_APPEND | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    journalExisted = false;
    journalHandle = await fsp.open(journalPath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  }
  let landedCommit = null;
  try {
    // ROUND 48: the appended commit line must land on the journal that was
    // chain-verified by the caller — a regular-file swap between
    // verification and this open is refused before anything is written, so
    // the function can never report a commit the verified journal does not
    // carry.
    if (verifiedJournalIdentity !== null) {
      const openStats = fs.fstatSync(journalHandle.fd);
      if (openStats.dev !== verifiedJournalIdentity.dev || openStats.ino !== verifiedJournalIdentity.ino
        || (openStats.mode & 0o777) !== verifiedJournalIdentity.mode) {
        throw directError('PROBE_LOG_REPLACED', 'The seal journal was replaced after verification; the commit refuses to append to the swap.');
      }
    }
    const line = { version: 1, runNonce, recordCount, eventsDigest, sealMac };
    if (recoveredCount !== undefined) {
      line.recoveredCount = recoveredCount;
      line.recoveredDigest = recoveredDigest;
      line.recoveredLength = recoveredLength;
    }
    if (tornDigest !== undefined) {
      line.tornFragmentCount = tornFragmentCount;
      line.tornDigest = tornDigest;
      line.tornLength = tornLength;
    }
    if (partialDigest !== undefined) {
      line.partialDigest = partialDigest;
      line.partialLength = partialLength;
    }
    await journalHandle.writeFile(Buffer.from(`${JSON.stringify(line)}\n`, 'utf8'));
    await journalHandle.sync();
    if (journalExisted) landedCommit = { recordCount, eventsDigest };
  } finally {
    try { await journalHandle.close(); } catch (error) { journalCloseError = error; }
  }
  if (journalCloseError !== null) {
    // ROUND 57: the close failed after the line is durable — for an
    // existing journal the failure is AMBIGUOUS and carries the landed
    // commit so both writers adopt it.
    if (landedCommit !== null) journalCloseError.commit = landedCommit;
    throw journalCloseError;
  }
  // The journal's own DIRECTORY ENTRY must be durable before ANY commit is
  // reported: a power loss can drop a newly created entry while the event
  // bytes survive, turning a reported durable record into "uncommitted" ones
  // on restart. Whether an EXISTING entry is durable cannot be confirmed from
  // file state alone on a later append — after a soft-failed first directory
  // fsync the journal file and its valid commit line remain visible, so a
  // retry that only fsynced on journal creation would skip the fsync and
  // report its commit anyway (the round 29 gate). EVERY commit therefore
  // fsyncs the run directory and FAILS CLOSED when that fsync cannot
  // complete (the soft-fail codes): the record stays unreported, its bytes
  // remain recoverable, and the caller is never told a durability lie. A
  // redundant directory fsync per commit is cheap at probe scale and makes
  // every commit's directory durability unconditional — no cross-process
  // state can be skipped.
  // ROUND 58: for an EXISTING journal the failure is AMBIGUOUS once the
  // journal line is durable — EVERY rejection from the post-sync directory
  // fsync carries the landed commit, INCLUDING thrown hard errors (EIO),
  // not just the soft-false branch. For a NEWLY CREATED journal the
  // directory fsync is part of durability: the error stays unadopted (as
  // today).
  let directoryError = null;
  try {
    if (!await syncRunDirectory(runDirectory)) {
      directoryError = directError('PROBE_OWNER_INVALID', 'The seal journal could not be made durable: the run directory cannot be fsynced.');
    }
  } catch (syncError) {
    directoryError = syncError;
  }
  if (directoryError !== null) {
    if (landedCommit !== null) directoryError.commit = landedCommit;
    throw directoryError;
  }
  return { recordCount, eventsDigest };
}

/**
 * Verifies the seal journal chain against the current event file bytes and
 * the caller's expectations. Returns the committed state:
 * { committedCount, uncommittedCount, committedDigest, prefixLen }.
 *
 * - expectedFinalState (reduction path): the last valid journal line must
 *   match the driver's in-memory final anchor exactly, or the journal was
 *   rolled back / replayed / grew past it → PROBE_OWNER_INVALID.
 * - heldCommit (append path): the writer's last-known commit must still
 *   chain (the journal reaches it with the same digest, and every line
 *   after it chains validly too) → else PROBE_STATE_DIVERGED, nothing may
 *   be written.
 * - A torn final journal fragment (crash mid-write) is never a committed
 *   line: it is dropped here and physically truncated by the recovery step.
 * @param {{eventsBytes: Buffer, journalPath: string, runNonce: string, ownerSecret: string, expectedFinalState: {recordCount: number, eventsDigest: string}|null, heldCommit: {recordCount: number, eventsDigest: string}|null}} input
 */
/**
 * Walks the seal journal lines under the capability secret and returns the
 * consecutive valid commits from the start (the walk stops at the first
 * invalid line — a torn or forged tail is never part of the committed
 * chain), together with the event-file line split and prefix offsets.
 * @param {{eventsBytes: Buffer, journalText: string, runNonce: string, ownerSecret: string}} input
 */
function walkSealJournal({ eventsBytes, journalText, journalPath, runNonce, ownerSecret }) {
  const tornJournalTail = journalText.length > 0 && !journalText.endsWith('\n');
  const journalBody = tornJournalTail ? journalText.slice(0, journalText.lastIndexOf('\n') + 1) : journalText;
  const journalLines = journalBody === '' ? [] : journalBody.slice(0, -1).split('\n');
  const eventText = eventsBytes.toString('utf8');
  const eventLines = eventText === '' ? [] : eventText.slice(0, -1).split('\n');
  const prefixOffsets = [0];
  for (const line of eventLines) prefixOffsets.push(prefixOffsets[prefixOffsets.length - 1] + Buffer.byteLength(line, 'utf8') + 1);
  const validCommits = [];
  let previousRecoveredLength = 0;
  let previousTornLength = 0;
  let previousPartialLength = 0;
  let previousPartialDigest = null;
  let finalLineEventCorrupted = false;
  for (const [index, line] of journalLines.entries()) {
    let commit;
    try { commit = JSON.parse(line); } catch { break; }
    if (!commit || typeof commit !== 'object' || commit.version !== 1) {
      throw directError('PROBE_OWNER_INVALID', 'The seal journal contains a malformed entry.');
    }
    if (commit.runNonce !== runNonce) {
      throw directError('PROBE_RUN_NONCE_FOREIGN', 'The seal journal contains an entry from a different run.');
    }
    if (commit.recordCount !== index + 1) break;
    if (typeof commit.eventsDigest !== 'string' || !/^[0-9a-f]{64}$/.test(commit.eventsDigest)
      || typeof commit.sealMac !== 'string' || !/^[0-9a-f]{64}$/.test(commit.sealMac)) break;
    // The Mac recomputation folds the line's own recovery and repair fields
    // back in (computeSealMac omits them when absent), so a recovery or
    // repair commit line authenticates exactly as it was written and the
    // sidecar checks below run against verified evidence.
    if (commit.sealMac !== computeSealMac(ownerSecret, {
      runNonce,
      recordCount: commit.recordCount,
      eventsDigest: commit.eventsDigest,
      recoveredCount: commit.recoveredCount,
      recoveredDigest: commit.recoveredDigest,
      recoveredLength: commit.recoveredLength,
      tornFragmentCount: commit.tornFragmentCount,
      tornDigest: commit.tornDigest,
      tornLength: commit.tornLength,
      partialDigest: commit.partialDigest,
      partialLength: commit.partialLength,
    })) break;
    // An authenticated final commit whose event bytes no longer match its
    // recorded digest is CORRUPTION, not an incomplete write: it must never
    // be classified as a repairable tail.
    if (commit.recordCount > eventLines.length) {
      if (index === journalLines.length - 1) finalLineEventCorrupted = true;
      break;
    }
    const prefixDigest = createHash('sha256').update(eventsBytes.subarray(0, prefixOffsets[commit.recordCount])).digest('hex');
    if (prefixDigest !== commit.eventsDigest) {
      if (index === journalLines.length - 1) finalLineEventCorrupted = true;
      break;
    }
    // Recovery metadata (present on lines that followed a recovery) is
    // authenticated as part of the line: each recovery line binds a
    // CUMULATIVE sidecar PREFIX — the bytes up to its recorded length must
    // hash to the recorded digest, and lengths strictly increase across
    // recoveries — so a deleted sidecar, an altered segment, or a rewritten
    // recovery history all fail closed.
    if (commit.recoveredDigest !== undefined) {
      if (typeof commit.recoveredDigest !== 'string' || !/^[0-9a-f]{64}$/.test(commit.recoveredDigest)
        || !Number.isSafeInteger(commit.recoveredCount) || commit.recoveredCount < 1
        || !Number.isSafeInteger(commit.recoveredLength) || commit.recoveredLength < 1) {
        throw directError('PROBE_OWNER_INVALID', 'The seal journal contains a recovery entry with malformed recovery fields.');
      }
      if (commit.recoveredLength <= previousRecoveredLength) {
        throw directError('PROBE_OWNER_INVALID', 'The seal journal records recovery sidecar lengths out of order.');
      }
      let sidecarBytes;
      try { sidecarBytes = readEvidenceFileSync(join(journalPath, '..', UNCOMMITTED_FILENAME)); } catch (error) {
        if (errorCode(error) === 'ENOENT') throw directError('PROBE_OWNER_INVALID', 'The commit journal records a recovery but the sidecar is missing.');
        throw error;
      }
      if (commit.recoveredLength > sidecarBytes.length
        || createHash('sha256').update(sidecarBytes.subarray(0, commit.recoveredLength)).digest('hex') !== commit.recoveredDigest) {
        throw directError('PROBE_OWNER_INVALID', 'The recovery sidecar was altered after the recorded recovery.');
      }
      previousRecoveredLength = commit.recoveredLength;
    }
    // Repair metadata (present on lines that anchored preserved torn-journal
    // fragments) is authenticated as part of the line: the preserved
    // fragments must exist, hash to the recorded cumulative digest, and
    // every covered fragment record must authenticate — so deleting,
    // altering, or rewriting the repair evidence fails closed.
    if (commit.tornDigest !== undefined) {
      if (typeof commit.tornDigest !== 'string' || !/^[0-9a-f]{64}$/.test(commit.tornDigest)
        || !Number.isSafeInteger(commit.tornFragmentCount) || commit.tornFragmentCount < 1
        || !Number.isSafeInteger(commit.tornLength) || commit.tornLength < 1) {
        throw directError('PROBE_OWNER_INVALID', 'The seal journal contains a repair entry with malformed repair fields.');
      }
      if (commit.tornLength <= previousTornLength) {
        throw directError('PROBE_OWNER_INVALID', 'The seal journal records repaired journal lengths out of order.');
      }
      let tornBytes;
      try { tornBytes = readEvidenceFileSync(join(journalPath, '..', TORN_JOURNAL_FILENAME)); } catch (error) {
        if (errorCode(error) === 'ENOENT') throw directError('PROBE_OWNER_INVALID', 'The commit journal records a journal repair but the preserved fragments are missing.');
        throw error;
      }
      verifyTornFragmentPrefix(tornBytes, commit, { runNonce, ownerSecret });
      previousTornLength = commit.tornLength;
    }
    // Partial-evidence metadata (present on lines whose repair preserved a
    // crashed partial write) is authenticated as part of the line: the
    // preserved partial fragments must exist and hash to the recorded
    // cumulative digest, and lengths strictly increase — deletion or
    // alteration of the partial evidence fails closed.
    if (commit.partialDigest !== undefined) {
      if (typeof commit.partialDigest !== 'string' || !/^[0-9a-f]{64}$/.test(commit.partialDigest)
        || !Number.isSafeInteger(commit.partialLength) || commit.partialLength < 1) {
        throw directError('PROBE_OWNER_INVALID', 'The seal journal contains a repair entry with malformed partial-recovery fields.');
      }
      if (commit.partialLength < previousPartialLength
        || (commit.partialLength === previousPartialLength && commit.partialDigest !== previousPartialDigest)) {
        throw directError('PROBE_OWNER_INVALID', 'The seal journal records preserved partial lengths out of order.');
      }
      let partialBytes;
      try { partialBytes = readEvidenceFileSync(join(journalPath, '..', REPAIRED_PARTIAL_FILENAME)); } catch (error) {
        if (errorCode(error) === 'ENOENT') throw directError('PROBE_OWNER_INVALID', 'The commit journal records a partial-fragment recovery but the preserved partial fragments are missing.');
        throw error;
      }
      if (commit.partialLength > partialBytes.length
        || createHash('sha256').update(partialBytes.subarray(0, commit.partialLength)).digest('hex') !== commit.partialDigest) {
        throw directError('PROBE_OWNER_INVALID', 'The preserved partial fragments were altered after the recorded repair.');
      }
      previousPartialDigest = commit.partialDigest;
      previousPartialLength = commit.partialLength;
    }
    validCommits.push(commit);
  }
  return { validCommits, journalLineCount: journalLines.length, eventLines, prefixOffsets, tornJournalTail, finalLineEventCorrupted };
}

function verifySealJournalLocked({ eventsBytes, journalPath, runNonce, ownerSecret, expectedFinalState = null, heldCommit = null, journalIdentityOut = null }) {
  let journalText;
  try {
    journalText = readEvidenceFileSync(journalPath, 'utf8', journalIdentityOut);
  } catch (error) {
    if (error instanceof SyntaxError) throw directError('PROBE_LOG_MALFORMED', 'The seal journal is malformed.');
    if (errorCode(error) === 'ENOENT') journalText = '';
    else throw error;
  }
  const { validCommits, journalLineCount, eventLines, prefixOffsets, tornJournalTail, finalLineEventCorrupted } = walkSealJournal({ eventsBytes, journalText, journalPath, runNonce, ownerSecret });
  const committedCount = validCommits.length;
  const committedDigest = committedCount > 0 ? validCommits[committedCount - 1].eventsDigest : null;
  if (heldCommit) {
    if (committedCount < heldCommit.recordCount
      || validCommits[heldCommit.recordCount - 1].eventsDigest !== heldCommit.eventsDigest) {
      throw directError('PROBE_STATE_DIVERGED', 'The event log or seal journal was rolled back or diverged from this writer held commit; nothing was written.');
    }
  }
  if (expectedFinalState) {
    if (expectedFinalState.recordCount !== committedCount
      || expectedFinalState.eventsDigest !== committedDigest) {
      throw directError('PROBE_OWNER_INVALID', 'The committed journal state does not match the driver final anchor; the run was rolled back, replayed, or grew past the anchor.');
    }
  }
  return {
    committedCount,
    committedDigest,
    lastCommit: committedCount > 0 ? validCommits[committedCount - 1] : null,
    lastRecoveryAnchor: validCommits.filter((commit) => commit.recoveredDigest !== undefined).at(-1) ?? null,
    lastRepairAnchor: validCommits.filter((commit) => commit.tornDigest !== undefined).at(-1) ?? null,
    lastPartialAnchor: validCommits.filter((commit) => commit.partialDigest !== undefined).at(-1) ?? null,
    uncommittedCount: eventLines.length - committedCount,
    prefixLen: prefixOffsets[committedCount],
    tornJournalTail,
    chainAuthentic: journalLineCount === validCommits.length,
    finalLineEventCorrupted,
    finalLineRejected: !tornJournalTail && !finalLineEventCorrupted && journalLineCount > 0 && validCommits.length === journalLineCount - 1,
    chainComplete: journalLineCount === validCommits.length && !tornJournalTail,
  };
}

/**
 * READ-ONLY journal head for a run: the last valid committed {recordCount,
 * eventsDigest} under the capability secret, or null when nothing is
 * committed. Writers use it to initialize their held commit; it grants no
 * write authority.
 * @param {{runDirectory: string, runNonce: string, ownerSecret: string}} input
 */
export function directProbeSealHead({ runDirectory, runNonce, ownerSecret }) {
  if (!isAbsolute(runDirectory)) throw directError('PROBE_RUN_DIRECTORY_INVALID', 'The direct probe run directory must be an absolute path.');
  requireRunNonce(runNonce);
  if (typeof ownerSecret !== 'string' || !RUN_NONCE_PATTERN.test(ownerSecret)) {
    throw directError('PROBE_OWNER_INVALID', 'Reading the seal head requires the run capability secret.');
  }
  let eventsBytes;
  let journalText;
  try {
    eventsBytes = readFileSync(join(runDirectory, 'events.jsonl'));
    journalText = readEvidenceFileSync(join(runDirectory, SEAL_JOURNAL_FILENAME), 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
  const { validCommits } = walkSealJournal({ eventsBytes, journalText, journalPath: join(runDirectory, SEAL_JOURNAL_FILENAME), runNonce, ownerSecret });
  if (validCommits.length === 0) return null;
  const head = validCommits[validCommits.length - 1];
  return { recordCount: head.recordCount, eventsDigest: head.eventsDigest };
}

/**
 * AUTHENTICATED CHAIN VERIFICATION for factory adoption: walks the seal
 * journal and returns its verified head, refusing (PROBE_STATE_DIVERGED)
 * unless the chain reaches the caller's process-held count AND digest — a
 * longer but divergent journal is never adoptable, and the caller keeps its
 * held state on ANY failure. Synchronous by contract: the server factory is
 * synchronous, so this walks the files directly; the instance's first
 * append re-verifies the same held commit under the advisory event lock.
 * @param {{runDirectory: string, runNonce: string, ownerSecret: string, heldCommit: {recordCount: number, eventsDigest: string}|null}} input
 * @returns {{recordCount: number, eventsDigest: string}|null}
 */
export function verifyDirectProbeSealChain({ runDirectory, runNonce, ownerSecret, heldCommit }) {
  if (!isAbsolute(runDirectory)) throw directError('PROBE_RUN_DIRECTORY_INVALID', 'The direct probe run directory must be an absolute path.');
  requireRunNonce(runNonce);
  if (typeof ownerSecret !== 'string' || !RUN_NONCE_PATTERN.test(ownerSecret)) {
    throw directError('PROBE_OWNER_INVALID', 'Verifying the seal chain requires the run capability secret.');
  }
  let eventsBytes = null;
  let journalText = null;
  try {
    eventsBytes = readFileSync(join(runDirectory, 'events.jsonl'));
    journalText = readEvidenceFileSync(join(runDirectory, SEAL_JOURNAL_FILENAME), 'utf8');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  const validCommits = eventsBytes === null || journalText === null ? [] : walkSealJournal({
    eventsBytes, journalText, journalPath: join(runDirectory, SEAL_JOURNAL_FILENAME), runNonce, ownerSecret,
  }).validCommits;
  if (heldCommit && (validCommits.length < heldCommit.recordCount
    || validCommits[heldCommit.recordCount - 1].eventsDigest !== heldCommit.eventsDigest)) {
    throw directError('PROBE_STATE_DIVERGED', 'The seal journal does not chain to the process-held commit; a longer but divergent journal cannot be adopted.');
  }
  if (validCommits.length === 0) return null;
  const head = validCommits[validCommits.length - 1];
  return { recordCount: head.recordCount, eventsDigest: head.eventsDigest };
}

/**
 * Computes the recovery intent's authentication code: HMAC-SHA256 keyed by
 * the run capability secret over the canonical intent fields, so only a
 * writer holding the secret can plant or forge a recovery intent.
 * @param {string} ownerSecret
 * @param {{version: number, runNonce: string, recoveredCount: number, recoveredDigest: string, recoveredLength: number}} intent
 */
function computeIntentMac(ownerSecret, intent) {
  const payload = { version: intent.version, runNonce: intent.runNonce, recoveredCount: intent.recoveredCount, recoveredDigest: intent.recoveredDigest, recoveredLength: intent.recoveredLength };
  return createHmac('sha256', Buffer.from(ownerSecret, 'utf8')).update(canonicalJson(payload)).digest('hex');
}

/**
 * Validates a parsed recovery intent's closed shape.
 * @param {unknown} intent
 * @returns {{version: number, runNonce: string, recoveredCount: number, recoveredDigest: string, recoveredLength: number, intentMac: string}}
 */
function validateRecoveryIntentShape(intent) {
  if (!intent || typeof intent !== 'object' || intent.version !== 1) {
    throw directError('PROBE_LOG_MALFORMED', 'The recovery intent is malformed.');
  }
  if (typeof intent.recoveredDigest !== 'string' || !/^[0-9a-f]{64}$/.test(intent.recoveredDigest)
    || !Number.isSafeInteger(intent.recoveredCount) || intent.recoveredCount < 1
    || !Number.isSafeInteger(intent.recoveredLength) || intent.recoveredLength < 1
    || typeof intent.intentMac !== 'string' || !/^[0-9a-f]{64}$/.test(intent.intentMac)) {
    throw directError('PROBE_LOG_MALFORMED', 'The recovery intent is missing its closed recovery fields.');
  }
  return intent;
}

/**
 * Reads and authenticates the recovery intent file, or returns null when
 * none exists. A present intent must carry the run nonce and a valid Mac:
 * a foreign or forged intent fails closed.
 * @param {{runDirectory: string, runNonce: string, ownerSecret: string}} input
 * @returns {{version: number, runNonce: string, recoveredCount: number, recoveredDigest: string, recoveredLength: number, intentMac: string}|null}
 */
function readRecoveryIntent({ runDirectory, runNonce, ownerSecret }) {
  let intent;
  try { intent = JSON.parse(readEvidenceFileSync(join(runDirectory, RECOVERY_INTENT_FILENAME), 'utf8')); } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw directError('PROBE_LOG_MALFORMED', 'The recovery intent is malformed.');
    throw error;
  }
  validateRecoveryIntentShape(intent);
  if (intent.runNonce !== runNonce) {
    throw directError('PROBE_RUN_NONCE_FOREIGN', 'The recovery intent belongs to a different run.');
  }
  if (intent.intentMac !== computeIntentMac(ownerSecret, intent)) {
    throw directError('PROBE_OWNER_INVALID', 'The recovery intent failed its authentication; the recovery record is forged or tampered.');
  }
  return intent;
}

/**
 * Fails closed unless the sidecar bytes up to the intent's recorded
 * cumulative length still hash to the recorded digest: deleting or altering
 * the sidecar while a recovery intent is unresolved can never pass.
 * @param {{recoveredDigest: string, recoveredLength: number}} intent
 * @param {{runDirectory: string}} input
 */
function verifyIntentSidecarDigest(intent, { runDirectory }) {
  let sidecarBytes;
  try { sidecarBytes = readEvidenceFileSync(join(runDirectory, UNCOMMITTED_FILENAME)); } catch (error) {
    if (errorCode(error) === 'ENOENT') throw directError('PROBE_OWNER_INVALID', 'The recovery intent records a recovery but the sidecar is missing.');
    throw error;
  }
  if (intent.recoveredLength > sidecarBytes.length
    || createHash('sha256').update(sidecarBytes.subarray(0, intent.recoveredLength)).digest('hex') !== intent.recoveredDigest) {
    throw directError('PROBE_OWNER_INVALID', 'The recovery sidecar no longer matches the unresolved recovery intent.');
  }
}

/**
 * Replaces an intent file ATOMICALLY: the new bytes are written to a unique
 * temporary file, fsynced, then durably renamed over the target with a
 * run-directory fsync. A crash at any point leaves either the OLD intent or
 * the NEW one intact at the target path — never an empty or partial file —
 * so resolution always has a valid durable record.
 * @param {string} intentPath
 * @param {string} runDirectory
 * @param {Buffer} bytes
 */
async function replaceIntentAtomically(intentPath, runDirectory, bytes) {
  const temporaryPath = join(runDirectory, `.${basename(intentPath)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`);
  const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  // Snapshot the previous file (when one exists) so a failed directory fsync
  // can ATOMICALLY restore it: the prior intent is the binding the
  // repeat-repair verification gates enforce, and losing it would bypass
  // those gates.
  let previousBytes = null;
  try { previousBytes = readEvidenceFileSync(intentPath); } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  await rename(temporaryPath, intentPath);
  // FAIL-CLOSED: every caller replaces a file whose durability licenses a
  // subsequent TRUNCATION of its source — the event log (recovery), the
  // seal journal and torn sidecar (repair). A soft-failed directory fsync
  // (EPERM/EACCES/EINVAL/ENOTSUP) leaves the new file's directory entry
  // non-durable while the truncation removes the source bytes, so a power
  // loss in that window loses the removed records' only evidence. Refuse
  // instead: restore the previous file, leave the caller's source intact,
  // and let the write re-execute once the platform can fsync.
  if (!await syncRunDirectory(runDirectory)) {
    // ROLLBACK through the same atomic protocol: the previous bytes are
    // fsynced in their own temporary file and renamed over the target, so
    // at every instant — and after any crash — the intent path holds either
    // the complete NEW intent or the complete OLD intent, never a missing
    // or partial file. A failure inside the rollback (the platform may keep
    // refusing) is contained: the caller still fails closed on the gate
    // error, the source stays intact, and the next attempt re-executes the
    // whole write against the surviving complete intent.
    try {
      if (previousBytes === null) {
        await unlink(intentPath).catch(() => {});
      } else {
        const restorePath = join(runDirectory, `.${basename(intentPath)}.${process.pid}.${randomBytes(12).toString('hex')}.restore.tmp`);
        const restoreHandle = await open(restorePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        try {
          await restoreHandle.writeFile(previousBytes);
          await restoreHandle.sync();
        } finally { await restoreHandle.close(); }
        await rename(restorePath, intentPath);
        if (!readEvidenceFileSync(intentPath).equals(previousBytes)) {
          throw directError('PROBE_OWNER_INVALID', `The rollback of the intent write for ${basename(intentPath)} could not restore the previous intent bytes.`);
        }
      }
    } catch (error) {
      if (errorCode(error) === 'PROBE_OWNER_INVALID') throw error;
    }
    throw directError('PROBE_OWNER_INVALID', `The intent write for ${basename(intentPath)} could not be made durable: the run directory cannot be fsynced.`);
  }
}

/**
 * Persists the authenticated recovery intent durably (write + fsync) BEFORE
 * the event log is truncated, so the truncation can never happen without a
 * durable record that binds the sidecar and forces resolution.
 * @param {{runDirectory: string, runNonce: string, ownerSecret: string}} input
 * @param {{recoveredCount: number, recoveredDigest: string, recoveredLength: number}} recovery
 */
async function writeRecoveryIntent({ runDirectory, runNonce, ownerSecret }, { recoveredCount, recoveredDigest, recoveredLength }) {
  const intent = { version: 1, runNonce, recoveredCount, recoveredDigest, recoveredLength };
  const authenticated = { ...intent, intentMac: computeIntentMac(ownerSecret, intent) };
  await replaceIntentAtomically(join(runDirectory, RECOVERY_INTENT_FILENAME), runDirectory, Buffer.from(`${JSON.stringify(authenticated)}\n`, 'utf8'));
  return authenticated;
}

/**
 * Fsyncs the run directory so newly created (or removed) recovery-file
 * DIRECTORY ENTRIES survive a power loss: on POSIX a synced file's bytes can
 * still be lost when its directory entry is not durable, and an unlinked
 * file can reappear. Platforms that cannot fsync directories fail softly —
 * the semantics are unsupported there, not violated — and the return value
 * REPORTS whether the fsync actually completed: callers whose durability
 * promise requires a real directory fsync (the probe server's
 * handler-owner gate) must treat false as fatal, while evidence-anchoring
 * call sites keep the soft-fail semantics (their windows stay recoverable
 * through the protocol's own crash machinery).
 * @param {string} runDirectory
 * @returns {Promise<boolean>} true when the directory fsync completed
 */
export async function syncRunDirectory(runDirectory) {
  let handle;
  try {
    handle = await open(runDirectory, 'r');
  } catch (error) {
    if (['EPERM', 'EACCES', 'EINVAL'].includes(errorCode(error))) return false;
    throw error;
  }
  try {
    await handle.sync();
    return true;
  } catch (error) {
    if (!['EPERM', 'EACCES', 'EINVAL', 'ENOTSUP'].includes(errorCode(error))) throw error;
    return false;
  } finally { await handle.close().catch(() => {}); }
}

/**
 * Computes the torn-journal record's authentication code: HMAC-SHA256 keyed
 * by the run capability secret over the canonical record fields without the
 * Mac, so only a writer holding the secret can plant a preserved fragment.
 * @param {string} ownerSecret
 * @param {{version: number, runNonce: string, fragment: string}} record
 */
function computeTornFragmentMac(ownerSecret, { version, runNonce, fragment }) {
  return createHmac('sha256', Buffer.from(ownerSecret, 'utf8')).update(canonicalJson({ version, runNonce, fragment })).digest('hex');
}

/**
 * Verifies a covered prefix of the torn-journal sidecar against recorded
 * repair anchor fields: byte digest, record count, and every covered
 * fragment record's authentication Mac.
 * @param {Buffer} tornBytes
 * @param {{tornFragmentCount: number, tornDigest: string, tornLength: number}} anchor
 * @param {{runNonce: string, ownerSecret: string}} input
 */
function verifyTornFragmentPrefix(tornBytes, { tornLength, tornDigest, tornFragmentCount }, { runNonce, ownerSecret }) {
  if (tornLength > tornBytes.length
    || createHash('sha256').update(tornBytes.subarray(0, tornLength)).digest('hex') !== tornDigest) {
    throw directError('PROBE_OWNER_INVALID', 'The preserved journal fragments were altered after the recorded repair.');
  }
  const coveredRecords = tornBytes.subarray(0, tornLength).toString('utf8').split('\n').filter((fragmentLine) => fragmentLine.trim() !== '');
  if (coveredRecords.length !== tornFragmentCount) {
    throw directError('PROBE_OWNER_INVALID', 'The preserved journal fragment count does not match the recorded repair.');
  }
  for (const fragmentLine of coveredRecords) {
    let fragmentRecord;
    try { fragmentRecord = JSON.parse(fragmentLine); } catch {
      throw directError('PROBE_OWNER_INVALID', 'A preserved journal fragment is malformed.');
    }
    if (!fragmentRecord || typeof fragmentRecord !== 'object' || fragmentRecord.version !== 1
      || fragmentRecord.runNonce !== runNonce || typeof fragmentRecord.fragment !== 'string'
      || typeof fragmentRecord.tornMac !== 'string' || !/^[0-9a-f]{64}$/.test(fragmentRecord.tornMac)
      || fragmentRecord.tornMac !== computeTornFragmentMac(ownerSecret, fragmentRecord)) {
      throw directError('PROBE_OWNER_INVALID', 'A preserved journal fragment failed its authentication; the repair evidence is forged or tampered.');
    }
  }
}

/**
 * Computes the partial-recovery record's authentication code: HMAC-SHA256
 * keyed by the run capability secret over the canonical record fields, so
 * only a writer holding the secret can plant or forge a preserved partial
 * fragment.
 * @param {string} ownerSecret
 * @param {{version: number, runNonce: string, data: string}} record
 */
function computePartialRecoveryMac(ownerSecret, { version, runNonce, data }) {
  return createHmac('sha256', Buffer.from(ownerSecret, 'utf8')).update(canonicalJson({ version, runNonce, data })).digest('hex');
}

/**
 * Builds one serialized, authenticated preservation record carrying the
 * exact original bytes (base64) of a recovered fragment, HMACed under the
 * run capability secret, so only a writer holding the secret can plant or
 * forge preserved partial evidence.
 * @param {string} runNonce
 * @param {string} ownerSecret
 * @param {Buffer} dataBytes
 * @returns {string} the serialized record line
 */
function makePartialRecoveryRecord(runNonce, ownerSecret, dataBytes) {
  const record = { version: 1, runNonce, data: dataBytes.toString('base64'), partialMac: '' };
  record.partialMac = computePartialRecoveryMac(ownerSecret, record);
  return JSON.stringify(record);
}

/**
 * Checks whether one partial-evidence sidecar line is a complete,
 * structurally valid, authenticated preservation record for this run.
 * @param {string} line
 * @param {{runNonce: string, ownerSecret: string}} input
 */
function isValidPartialRecoveryRecord(line, { runNonce, ownerSecret }) {
  let record;
  try { record = JSON.parse(line); } catch { return false; }
  return Boolean(record) && typeof record === 'object' && record.version === 1
    && record.runNonce === runNonce && typeof record.data === 'string'
    && typeof record.partialMac === 'string' && /^[0-9a-f]{64}$/.test(record.partialMac)
    && record.partialMac === computePartialRecoveryMac(ownerSecret, record);
}

/**
 * NORMALIZES the partial-evidence sidecar's existing bytes into complete
 * authenticated record lines: complete records (including every
 * journal-anchored one) stay FIRST byte-identical, a structurally invalid
 * complete line is re-wrapped as one authenticated record preserving its
 * exact bytes (trailing newline included), and a torn trailing line is
 * recovered as one authenticated record appended AFTER the complete records
 * — never before them, so a normalization rewrite can never change the
 * bytes of a journal-anchored prefix digest.
 * @param {Buffer|null} existingBytes
 * @param {{runNonce: string, ownerSecret: string}} input
 * @returns {string[]}
 */
function normalizePartialEvidenceLines(existingBytes, { runNonce, ownerSecret }) {
  if (existingBytes === null || existingBytes.length === 0) return [];
  const text = existingBytes.toString('utf8');
  const endsClean = text.endsWith('\n');
  const segments = text.split('\n');
  // After the split the LAST element is either '' (clean final newline) or
  // the torn trailing line — the complete lines are everything before it.
  const completeCount = segments.length - 1;
  const lines = [];
  for (let segmentIndex = 0; segmentIndex < completeCount; segmentIndex++) {
    const segment = segments[segmentIndex];
    if (segment.trim() === '') continue;
    if (isValidPartialRecoveryRecord(segment, { runNonce, ownerSecret })) {
      lines.push(segment);
      continue;
    }
    lines.push(makePartialRecoveryRecord(runNonce, ownerSecret, Buffer.from(`${segment}\n`, 'utf8')));
  }
  const tornTailSegment = segments[completeCount];
  if (!endsClean && tornTailSegment !== undefined && tornTailSegment.trim() !== '') {
    lines.push(makePartialRecoveryRecord(runNonce, ownerSecret, Buffer.from(tornTailSegment, 'utf8')));
  }
  return lines;
}

/**
 * REPAIRS a torn or structurally broken FINAL seal-journal line under the
 * event lock, with the partial-evidence move durably bound BEFORE anything
 * is truncated:
 * 1. the partial-evidence sidecar is normalized (complete records stay
 *    byte-identical FIRST; its own torn or invalid trailing line is
 *    recovered as one authenticated record appended after them) and the
 *    torn sidecar's unanchored partial tail is preserved into it — written
 *    ATOMICALLY and fsynced (with its directory entry) FIRST, while the
 *    torn sidecar still holds the same bytes;
 * 2. the DURABLE, AUTHENTICATED repair intent is written, binding the torn
 *    sidecar's valid prefix, its unanchored tail (moved into the partial
 *    evidence), the expected final torn state, and the partial evidence —
 *    all BEFORE any truncation, so the moved bytes are never left as
 *    unbound, silently deletable evidence;
 * 3. only then is the torn sidecar truncated to its valid boundary, the
 *    fragment evidence record appended, and the journal truncated. A crash
 *    in any window leaves the binding enforceable on the next append and
 *    every reduction.
 * A repeat repair VERIFIES the existing intent first (the caller did) and
 * EXTENDS the covered history: every attempt appends its own fragment
 * record. A resume of an interrupted attempt whose sidecar work already
 * completed (the sidecar holds the intent's exact final state and its last
 * record carries this same fragment) performs no further sidecar mutation —
 * the durable intent already binds the state on disk, and the append
 * proceeds straight to the journal truncation.
 * @param {{journalPath: string, tornPath: string, partialPath: string, runDirectory: string, runNonce: string, ownerSecret: string, existingIntent: object|null, lastRepairAnchor: object|null, lastPartialAnchor: object|null}} input
 */
/**
 * ROUND 41: extracts the journal's repair fragment EXACTLY as
 * repairTornJournalTail's own final-line extraction does: the fragment is
 * the journal's final line whether or not it is newline-terminated — an
 * unterminated crash tail AND a complete, structurally rejected final line
 * are both preserved as the bound fragment evidence. The pre-append crash
 * windows re-derive the same text on retry so a durable intent's binding
 * can be verified against the intact journal before anything is written.
 * @param {string} journalText
 * @returns {string} the journal's final line without its trailing newline
 */
function extractRepairFragmentText(journalText) {
  if (!journalText.endsWith('\n')) {
    return journalText.slice(journalText.lastIndexOf('\n') + 1);
  }
  const lastLineStart = journalText.lastIndexOf('\n', journalText.length - 2) + 1;
  return journalText.slice(lastLineStart).replace(/\n$/, '');
}

async function repairTornJournalTail({ journalPath, tornPath, partialPath, runDirectory, runNonce, ownerSecret, existingIntent = null, lastRepairAnchor = null, lastPartialAnchor = null }) {
  // ROUND 40/41: the journal's intact repair fragment, derived with the
  // SAME extraction this repair's own PHASE 3 uses, so the pre-append crash
  // windows can verify the intact fragment against the durable intent
  // before anything is written — whether the fragment is an unterminated
  // tail or a newline-terminated structurally rejected final line.
  const journalIdentity = {};
  const journalText = readEvidenceFileSync(journalPath, 'utf8', journalIdentity);
  const journalFragmentText = extractRepairFragmentText(journalText);
  // PHASE 1 — read the torn sidecar and walk its valid record prefix: the
  // bytes up to the first invalid line are complete authenticated records
  // (including every journal-anchored fragment); anything beyond is an
  // unanchored partial tail (a crashed fragment write).
  let tornBytes = Buffer.alloc(0);
  let tornExists = false;
  const tornIdentity = {};
  try { tornBytes = readEvidenceFileSync(tornPath, undefined, tornIdentity); tornExists = true; } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  let validBoundary = 0;
  let lastFragment = null;
  if (tornBytes.length > 0) {
    const tornText = tornBytes.toString('utf8');
    const tornSegments = tornText.split('\n');
    // Only NEWLINE-TERMINATED segments count as valid prefix records: after
    // the split the last element is either '' (clean final newline) or the
    // unterminated trailing bytes. Even a complete, authenticated record
    // missing only its final newline is a torn tail — it is preserved as
    // partial evidence below instead of being concatenated with the next
    // appended record.
    const tornCompleteCount = tornSegments.length - 1;
    let offset = 0;
    for (let segmentIndex = 0; segmentIndex < tornCompleteCount; segmentIndex++) {
      const segment = tornSegments[segmentIndex];
      let fragmentRecord = null;
      let structurallyValid = false;
      if (segment === '') { offset += 1; structurallyValid = true; }
      else {
        try { fragmentRecord = JSON.parse(segment); } catch { fragmentRecord = null; }
        structurallyValid = fragmentRecord !== null && typeof fragmentRecord === 'object'
          && fragmentRecord.version === 1 && fragmentRecord.runNonce === runNonce
          && typeof fragmentRecord.fragment === 'string'
          && typeof fragmentRecord.tornMac === 'string' && /^[0-9a-f]{64}$/.test(fragmentRecord.tornMac)
          && fragmentRecord.tornMac === computeTornFragmentMac(ownerSecret, fragmentRecord);
      }
      if (!structurallyValid) break;
      offset += Buffer.byteLength(segment, 'utf8') + 1;
      validBoundary = offset;
      if (fragmentRecord) lastFragment = fragmentRecord.fragment;
    }
  }
  const tornTailBytes = tornBytes.subarray(validBoundary);
  // ROUND 32 GATE: the torn sidecar's EXISTING bytes are authenticated
  // state — their length must already be bound BEFORE this repair extends or
  // preserves them, or an injected tail beyond the last anchor would be
  // wrapped as a Mac-authenticated partial-evidence record and anchored by
  // the fresh repair commit, laundering it into the reported recovery
  // evidence (the journal walk above verifies only the ANCHORED prefix).
  // The bound states are exactly the ones the recovery gate accepts: the
  // sidecar exactly at the last committed repair anchor, or — when a repair
  // intent is unresolved — one of the intent's narrowly verified in-flight
  // states, re-checked here so the accepted set stays defined in one place.
  // Anything else refuses the repair closed WITHOUT writing anything.
  if (tornExists) {
    if (existingIntent !== null) {
      verifyRepairIntentFragments(existingIntent, { tornPath, partialPath, runNonce, ownerSecret, journalFragmentText });
    } else if (lastRepairAnchor === null || tornBytes.length !== lastRepairAnchor.tornLength) {
      throw directError('PROBE_OWNER_INVALID', 'The preserved journal fragments do not match their recorded anchor; repairing would anchor unauthenticated bytes.');
    }
  }
  // ROUND 33 GATE (reworked by round 35): a present partial sidecar must be
  // BOUND before the repair touches it. Anchorless with no repair intent —
  // or with an intent that binds no partial content — means the bytes were
  // planted: the repair would wrap them in MAC-authenticated records and
  // anchor their digest, laundering planted bytes into reported recovery
  // evidence, so it refuses WITHOUT writing. Anchorless with an intent =
  // the round 35 intent-only crash window: the existing content is verified
  // against the intent's own partialDigest/partialLength. Anchored = exact
  // length (the journal walk verifies the anchored prefix digest).
  let existingPartialBytes = null;
  try { existingPartialBytes = readEvidenceFileSync(partialPath); } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  if (existingPartialBytes !== null) {
    if (existingIntent !== null) {
      if (existingIntent.partialDigest === undefined
        || existingPartialBytes.length !== existingIntent.partialLength
        || createHash('sha256').update(existingPartialBytes).digest('hex') !== existingIntent.partialDigest) {
        throw directError('PROBE_OWNER_INVALID', 'The preserved partial fragments do not match the unresolved repair intent; repairing would anchor unauthenticated bytes.');
      }
    } else if (lastPartialAnchor === null) {
      throw directError('PROBE_OWNER_INVALID', 'The preserved partial fragments exist without a repair intent or committed partial anchor; repairing would authenticate planted bytes.');
    } else if (existingPartialBytes.length !== lastPartialAnchor.partialLength) {
      throw directError('PROBE_OWNER_INVALID', 'The preserved partial fragments do not match their recorded anchor; repairing would anchor unauthenticated bytes.');
    }
  }
  // PHASE 2 — assemble the final partial-evidence bytes: the normalized
  // existing records FIRST (byte-identical prefix), then the torn sidecar's
  // unanchored tail as one authenticated preservation record. The
  // preservation is idempotent per content: an interrupted attempt's record
  // (already the sidecar's last line) is never duplicated by a retry.
  const partialLines = normalizePartialEvidenceLines(existingPartialBytes, { runNonce, ownerSecret });
  if (tornTailBytes.length > 0) {
    const preservationLine = makePartialRecoveryRecord(runNonce, ownerSecret, tornTailBytes);
    if (partialLines[partialLines.length - 1] !== preservationLine) partialLines.push(preservationLine);
  }
  const finalPartialBytes = partialLines.length > 0 ? Buffer.from(`${partialLines.join('\n')}\n`, 'utf8') : null;
  const finalPartialLength = finalPartialBytes !== null ? finalPartialBytes.length : undefined;
  const finalPartialDigest = finalPartialBytes !== null ? createHash('sha256').update(finalPartialBytes).digest('hex') : undefined;
  // PHASE 3 — extract the journal's torn tail and build this attempt's
  // fragment evidence record.
  let fragment;
  let keptByteLength;
  if (!journalText.endsWith('\n')) {
    const completeEnd = journalText.lastIndexOf('\n') + 1;
    fragment = journalText.slice(completeEnd);
    keptByteLength = Buffer.byteLength(journalText.slice(0, completeEnd), 'utf8');
  } else {
    const lastLineStart = journalText.lastIndexOf('\n', journalText.length - 2) + 1;
    fragment = journalText.slice(lastLineStart).replace(/\n$/, '');
    keptByteLength = Buffer.byteLength(journalText.slice(0, lastLineStart), 'utf8');
  }
  // RESUME: an interrupted attempt whose sidecar work already completed (the
  // sidecar holds the intent's exact final state and its last record carries
  // this same fragment) needs no further sidecar mutation — the durable
  // intent already binds the state on disk.
  const resumeComplete = existingIntent !== null && tornExists
    && tornBytes.length === existingIntent.tornLength
    && createHash('sha256').update(tornBytes).digest('hex') === existingIntent.tornDigest
    && lastFragment === fragment;
  const record = { version: 1, runNonce, fragment, tornMac: '' };
  record.tornMac = computeTornFragmentMac(ownerSecret, record);
  const recordBytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
  const finalTornBytes = resumeComplete ? tornBytes : Buffer.concat([tornBytes.subarray(0, validBoundary), recordBytes]);
  const tornLength = finalTornBytes.length;
  const tornDigest = createHash('sha256').update(finalTornBytes).digest('hex');
  const tornFragmentCount = finalTornBytes.toString('utf8').split('\n').filter((line) => line.trim() !== '').length;
  let partialDigest;
  let partialLength;
  if (finalPartialBytes !== null) {
    partialLength = finalPartialLength;
    partialDigest = finalPartialDigest;
  }
  // PHASE 4 — DURABLE REPAIR INTENT: authenticated, fsynced, and renamed
  // over (with its directory entry) BEFORE the partial-evidence file is
  // written and BEFORE the torn-sidecar truncation. Round 35: the intent
  // binds the computed partial content BEFORE that content exists as a file,
  // so a partial sidecar can only ever come to exist behind a durable,
  // authenticated binding of its exact bytes.
  const intentUnchanged = existingIntent !== null
    && existingIntent.tornFragmentCount === tornFragmentCount
    && existingIntent.tornDigest === tornDigest
    && existingIntent.tornLength === tornLength
    && existingIntent.partialDigest === partialDigest
    && existingIntent.partialLength === partialLength;
  if (!intentUnchanged) {
    await writeRepairIntent({ runDirectory, runNonce, ownerSecret }, {
      tornValidLength: validBoundary,
      tornValidDigest: createHash('sha256').update(tornBytes.subarray(0, validBoundary)).digest('hex'),
      tornTailLength: tornTailBytes.length,
      tornTailDigest: createHash('sha256').update(tornTailBytes).digest('hex'),
      tornFragmentCount,
      tornDigest,
      tornLength,
      partialDigest,
      partialLength,
    });
  }
  // PHASE 4.5 — ROUND 35: the partial-evidence file is written BEHIND the
  // durable intent, and the written bytes are verified against the intent's
  // binding before anything is truncated. A recomputed content that does not
  // match the durable intent — or a durable intent whose bound partial
  // evidence is missing — refuses the repair WITHOUT writing.
  if (existingIntent !== null && existingIntent.partialDigest !== undefined && finalPartialBytes === null) {
    throw directError('PROBE_OWNER_INVALID', 'The repair intent binds partial evidence that is missing; the repair refuses without writing.');
  }
  if (finalPartialBytes !== null && !(existingPartialBytes !== null && existingPartialBytes.equals(finalPartialBytes))) {
    if (existingIntent !== null && existingIntent.partialDigest !== undefined
      && (finalPartialLength !== existingIntent.partialLength || finalPartialDigest !== existingIntent.partialDigest)) {
      throw directError('PROBE_OWNER_INVALID', 'The recomputed partial content does not match the unresolved repair intent; the repair refuses without writing.');
    }
    await replaceIntentAtomically(partialPath, runDirectory, finalPartialBytes);
    const writtenPartialBytes = readEvidenceFileSync(partialPath);
    if (writtenPartialBytes.length !== finalPartialLength || createHash('sha256').update(writtenPartialBytes).digest('hex') !== finalPartialDigest) {
      throw directError('PROBE_OWNER_INVALID', 'The written partial evidence does not match its repair intent; refusing the repair.');
    }
  }
  // PHASE 5 — behind the durable intent: truncate the torn sidecar to its
  // valid boundary (dropping only the bound, preserved tail), append the
  // fragment evidence record, and fsync once — then truncate the journal to
  // its complete prefix and fsync. A crash in any window leaves the intent
  // binding enforceable on the next append and every reduction.
  if (!resumeComplete) {
    if (tornTailBytes.length > 0) truncateEvidenceFileSync(tornPath, validBoundary, tornIdentity);
    const tornAppend = await fsp.open(tornPath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      // ROUND 49: the fragment write lands on the inode that was validated
      // (and just truncated) — a regular-file swap into the append open's
      // gap is refused before any byte is written.
      const appendStats = fs.fstatSync(tornAppend.fd);
      if (tornExists && (appendStats.dev !== tornIdentity.dev || appendStats.ino !== tornIdentity.ino
        || (appendStats.mode & 0o777) !== tornIdentity.mode)) {
        throw directError('PROBE_LOG_REPLACED', 'The torn sidecar was replaced after validation; the repair refuses to append the fragment to the swap.');
      }
      await tornAppend.writeFile(recordBytes);
      await tornAppend.sync();
    } finally { await tornAppend.close(); }
    // ROUND 49: a sidecar CREATED by this repair must have its directory
    // entry durably synced BEFORE the journal truncation — a soft directory
    // fsync failure here is FATAL. Otherwise a crash could lose the
    // sidecar's entry while the journal fragment is already gone, and the
    // surviving repair intent would strand the run irreducible.
  }
  // ROUND 49/50: the journal truncation requires a durable run-directory
  // fsync — UNCONDITIONALLY, on the resume path too: the sidecar's entry
  // may have been created by the refused attempt whose directory fsync
  // soft-failed, and that entry is still not durable. A crash could
  // otherwise lose the entry while the journal fragment is already gone,
  // stranding the surviving intent without its preserved fragment.
  if (!(await syncRunDirectory(runDirectory))) {
    throw directError('PROBE_OWNER_INVALID', 'The torn sidecar could not be made durable; the journal truncation refuses to run.');
  }
  truncateEvidenceFileSync(journalPath, keptByteLength, journalIdentity);
  const journalHandle = await open(journalPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try { await journalHandle.sync(); } finally { await journalHandle.close(); }
}

/**
 * Computes the repair intent's authentication code: HMAC-SHA256 keyed by
 * the run capability secret over the canonical intent fields, so only a
 * writer holding the secret can plant or forge a repair intent. The payload
 * binds the torn sidecar's valid prefix (tornValidLength/tornValidDigest),
 * its unanchored tail at intent time (tornTailLength/tornTailDigest — the
 * bytes the repair moves into the partial-evidence sidecar), and the
 * expected final torn state.
 * @param {string} ownerSecret
 * @param {{version: number, runNonce: string, tornValidLength: number, tornValidDigest: string, tornTailLength: number, tornTailDigest: string, tornFragmentCount: number, tornDigest: string, tornLength: number, partialDigest?: string, partialLength?: number}} intent
 */
function computeRepairIntentMac(ownerSecret, intent) {
  const payload = { version: intent.version, runNonce: intent.runNonce, tornValidLength: intent.tornValidLength, tornValidDigest: intent.tornValidDigest, tornTailLength: intent.tornTailLength, tornTailDigest: intent.tornTailDigest, tornFragmentCount: intent.tornFragmentCount, tornDigest: intent.tornDigest, tornLength: intent.tornLength };
  if (intent.partialDigest !== undefined) {
    payload.partialDigest = intent.partialDigest;
    payload.partialLength = intent.partialLength;
  }
  return createHmac('sha256', Buffer.from(ownerSecret, 'utf8')).update(canonicalJson(payload)).digest('hex');
}

/**
 * Reads and authenticates the repair intent file, or returns null when none
 * exists. A present intent must carry the run nonce and a valid Mac: a
 * foreign or forged intent fails closed.
 * @param {{runDirectory: string, runNonce: string, ownerSecret: string}} input
 * @returns {{version: number, runNonce: string, tornValidLength: number, tornValidDigest: string, tornTailLength: number, tornTailDigest: string, tornFragmentCount: number, tornDigest: string, tornLength: number, partialDigest?: string, partialLength?: number, repairIntentMac: string}|null}
 */
function readRepairIntent({ runDirectory, runNonce, ownerSecret }) {
  let intent;
  try { intent = JSON.parse(readEvidenceFileSync(join(runDirectory, REPAIR_INTENT_FILENAME), 'utf8')); } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw directError('PROBE_LOG_MALFORMED', 'The repair intent is malformed.');
    throw error;
  }
  if (!intent || typeof intent !== 'object' || intent.version !== 1) {
    throw directError('PROBE_LOG_MALFORMED', 'The repair intent is malformed.');
  }
  if (typeof intent.tornDigest !== 'string' || !/^[0-9a-f]{64}$/.test(intent.tornDigest)
    || !Number.isSafeInteger(intent.tornFragmentCount) || intent.tornFragmentCount < 1
    || !Number.isSafeInteger(intent.tornLength) || intent.tornLength < 1
    || !Number.isSafeInteger(intent.tornValidLength) || intent.tornValidLength < 0
    || intent.tornValidLength > intent.tornLength
    || typeof intent.tornValidDigest !== 'string' || !/^[0-9a-f]{64}$/.test(intent.tornValidDigest)
    || !Number.isSafeInteger(intent.tornTailLength) || intent.tornTailLength < 0
    || typeof intent.tornTailDigest !== 'string' || !/^[0-9a-f]{64}$/.test(intent.tornTailDigest)
    || typeof intent.repairIntentMac !== 'string' || !/^[0-9a-f]{64}$/.test(intent.repairIntentMac)) {
    throw directError('PROBE_LOG_MALFORMED', 'The repair intent is missing its closed repair fields.');
  }
  if (intent.partialDigest !== undefined
    && (typeof intent.partialDigest !== 'string' || !/^[0-9a-f]{64}$/.test(intent.partialDigest)
      || !Number.isSafeInteger(intent.partialLength) || intent.partialLength < 1)) {
    throw directError('PROBE_LOG_MALFORMED', 'The repair intent carries malformed partial-recovery fields.');
  }
  if (intent.runNonce !== runNonce) {
    throw directError('PROBE_RUN_NONCE_FOREIGN', 'The repair intent belongs to a different run.');
  }
  if (intent.repairIntentMac !== computeRepairIntentMac(ownerSecret, intent)) {
    throw directError('PROBE_OWNER_INVALID', 'The repair intent failed its authentication; the repair record is forged or tampered.');
  }
  return intent;
}

/**
 * Fails closed unless an unresolved repair intent's bindings still verify
 * against the CURRENT files — checked before any repeat repair or intent
 * replacement, and on every reduction:
 * - the intent-bound partial evidence must be PRESENT, and its covered
 *   prefix must hash to the recorded digest: a missing, short, or altered
 *   partial file refuses outright, so the deletion of preserved partial
 *   evidence can never be laundered behind a replacement intent;
 * - the torn sidecar must be in one of the intent's LEGAL states: (c) the
 *   exact final record state once the sidecar work completed, (a) the exact
 *   bound pre-truncation bytes while a truncation was still pending, or (b)
 *   the exact valid prefix immediately after that truncation — every other
 *   length or digest refuses outright, so a tampered sidecar can never have
 *   the intent's expected torn digest committed over absent bytes.
 * @param {{tornValidLength: number, tornValidDigest: string, tornTailLength: number, tornTailDigest: string, tornFragmentCount: number, tornDigest: string, tornLength: number, partialDigest?: string, partialLength?: number}} intent
 * @param {{tornPath: string, partialPath: string, runNonce: string, ownerSecret: string}} input
 */
function verifyRepairIntentFragments(intent, { tornPath, partialPath, runNonce, ownerSecret, journalFragmentText }) {
  let tornBytes;
  try { tornBytes = readEvidenceFileSync(tornPath); } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      // ROUND 40 (window a): the FIRST repair's intent durable with the torn
      // sidecar not yet created — the intent-only window. The journal's
      // intact torn fragment must match the intent's binding: the fragment
      // record built from the journal's tail text authenticates and the
      // intent's torn fields bind exactly that fragment record.
      if (journalFragmentText === undefined || intent.tornValidLength !== 0 || intent.tornTailLength !== 0
        || intent.tornFragmentCount !== 1) {
        throw directError('PROBE_OWNER_INVALID', 'The repair intent records a repair but the preserved fragments are missing.');
      }
      const fragmentRecord = { version: 1, runNonce, fragment: journalFragmentText, tornMac: computeTornFragmentMac(ownerSecret, { version: 1, runNonce, fragment: journalFragmentText }) };
      const fragmentRecordBytes = Buffer.from(`${JSON.stringify(fragmentRecord)}\n`, 'utf8');
      if (createHash('sha256').update(fragmentRecordBytes).digest('hex') !== intent.tornDigest
        || fragmentRecordBytes.length !== intent.tornLength) {
        throw directError('PROBE_OWNER_INVALID', 'The intact journal fragment does not match the unresolved repair intent; the repair refuses without writing.');
      }
      return;
    }
    throw error;
  }
  // An unresolved intent accepts ONLY the protocol's legal sidecar states —
  // (c) the exact final record state, (a) the exact bound pre-truncation
  // bytes, or (b) the exact valid prefix immediately after truncation.
  // EVERY other length or digest is rejected before anything is appended or
  // the intent cleared, so a tampered sidecar can never have the intent's
  // expected torn digest committed over its absent bytes.
  const validLength = intent.tornValidLength;
  const tailEnd = validLength + intent.tornTailLength;
  let sidecarState = null;
  if (tornBytes.length === intent.tornLength) {
    // (c) The sidecar work completed: the covered final state must be
    // byte-intact (digest, record count, and every covered fragment Mac).
    verifyTornFragmentPrefix(tornBytes, intent, { runNonce, ownerSecret });
    sidecarState = 'final';
  } else if (intent.tornTailLength > 0 && tornBytes.length === tailEnd
    && (validLength === 0
      || createHash('sha256').update(tornBytes.subarray(0, validLength)).digest('hex') === intent.tornValidDigest)
    && createHash('sha256').update(tornBytes.subarray(validLength)).digest('hex') === intent.tornTailDigest) {
    // (a) The exact bound pre-truncation bytes: BOTH the valid prefix and
    // the tail must still match their recorded digests — a same-length
    // mutation of the prefix is tampering, not the interrupted state. The
    // sidecar work was interrupted between the durable intent and the
    // truncation; the bound tail's own bytes are safe in the bound partial
    // evidence above.
    sidecarState = 'pre-truncation';
  } else if (intent.tornTailLength > 0 && tornBytes.length === validLength
    && (validLength === 0
      || createHash('sha256').update(tornBytes.subarray(0, validLength)).digest('hex') === intent.tornValidDigest)) {
    // (b) The exact valid prefix immediately after truncation.
    sidecarState = 'truncated';
  }
  // ROUND 40 (window b): the torn sidecar UNCHANGED at its previous anchor
  // length with a ZERO bound tail (an existing anchored sidecar), plus the
  // journal's intact torn fragment authenticating as the fragment record
  // the intent binds — the interrupted pre-append state of a second repair.
  if (sidecarState === null && journalFragmentText !== undefined && intent.tornTailLength === 0
    && tornBytes.length === intent.tornValidLength
    && (validLength === 0
      || createHash('sha256').update(tornBytes.subarray(0, validLength)).digest('hex') === intent.tornValidDigest)) {
    const fragmentRecord = { version: 1, runNonce, fragment: journalFragmentText, tornMac: computeTornFragmentMac(ownerSecret, { version: 1, runNonce, fragment: journalFragmentText }) };
    const fragmentRecordLine = Buffer.from(`${JSON.stringify(fragmentRecord)}\n`, 'utf8');
    const sidecarRecordCount = tornBytes.toString('utf8').split('\n').filter((line) => line.trim() !== '').length;
    if (intent.tornLength === tornBytes.length + fragmentRecordLine.length
      && createHash('sha256').update(Buffer.concat([tornBytes, fragmentRecordLine])).digest('hex') === intent.tornDigest
      && intent.tornFragmentCount === sidecarRecordCount + 1) {
      sidecarState = 'pre-append-unchanged';
    }
  }
  if (sidecarState === null) {
    throw directError('PROBE_OWNER_INVALID', 'The preserved journal fragments no longer match the unresolved repair intent.');
  }
  // ROUND 36: the partial-evidence file is checked against the intent AFTER
  // the torn state is known. A MISSING partial file is the intent-only
  // crash window ONLY in the pre-truncation state — its bytes can still be
  // recomputed from the bound tail. Once the tail is truncated (or the
  // final state was reached) the binding is unsatisfiable: refuse without
  // replacing the intent, so the missing evidence keeps the run
  // irreducible instead of being laundered away.
  if (intent.partialDigest !== undefined) {
    let partialBytes = null;
    try { partialBytes = readEvidenceFileSync(partialPath); } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    if (partialBytes === null) {
      if (sidecarState !== 'pre-truncation') {
        throw directError('PROBE_OWNER_INVALID', 'The repair intent binds partial evidence that is missing and can no longer be recomputed; the repair refuses without replacing the intent.');
      }
    } else if (intent.partialLength > partialBytes.length
      || createHash('sha256').update(partialBytes.subarray(0, intent.partialLength)).digest('hex') !== intent.partialDigest) {
      throw directError('PROBE_OWNER_INVALID', 'The preserved partial fragments no longer match the unresolved repair intent.');
    }
  }
}

/**
 * Persists the authenticated repair intent durably (atomic write + fsync +

/**
 * Persists the authenticated repair intent durably (atomic write + fsync +
 * directory fsync) BEFORE any truncation, so the truncations can never
 * happen without a durable record that binds the preserved evidence (torn
 * sidecar valid prefix and unanchored tail, expected final torn state, and
 * partial evidence) and forces resolution.
 * @param {{runDirectory: string, runNonce: string, ownerSecret: string}} input
 * @param {{tornValidLength: number, tornValidDigest: string, tornTailLength: number, tornTailDigest: string, tornFragmentCount: number, tornDigest: string, tornLength: number, partialDigest?: string, partialLength?: number}} repair
 */
async function writeRepairIntent({ runDirectory, runNonce, ownerSecret }, { tornValidLength, tornValidDigest, tornTailLength, tornTailDigest, tornFragmentCount, tornDigest, tornLength, partialDigest, partialLength }) {
  const intent = { version: 1, runNonce, tornValidLength, tornValidDigest, tornTailLength, tornTailDigest, tornFragmentCount, tornDigest, tornLength };
  if (partialDigest !== undefined) {
    intent.partialDigest = partialDigest;
    intent.partialLength = partialLength;
  }
  const authenticated = { ...intent, repairIntentMac: computeRepairIntentMac(ownerSecret, intent) };
  await replaceIntentAtomically(join(runDirectory, REPAIR_INTENT_FILENAME), runDirectory, Buffer.from(`${JSON.stringify(authenticated)}\n`, 'utf8'));
  return authenticated;
}

/**
 * SINGLE-SNAPSHOT authenticated read: under ONE advisory lock, reads the
 * event file bytes and the seal journal together, verifies the journal chain
 * and the driver final anchor, takes the committed prefix, validates those
 * records, and (when handler evidence is present) verifies the owner file
 * and every per-record Mac — all against the same bytes. No release between
 * verify and read.
 * @param {{runDirectory: string, runNonce: string, ownerSecret: string, expectedFinalState: {recordCount: number, eventsDigest: string}, ownerPid?: number|null}} input
 * @returns {Promise<{records: object[], uncommittedCount: number}>}
 */
export async function readCommittedDirectProbeLog({ runDirectory, runNonce, ownerSecret, expectedFinalState, ownerPid = null }) {
  if (!isAbsolute(runDirectory)) throw directError('PROBE_RUN_DIRECTORY_INVALID', 'The direct probe run directory must be an absolute path.');
  requireRunNonce(runNonce);
  if (typeof ownerSecret !== 'string' || !RUN_NONCE_PATTERN.test(ownerSecret)) {
    throw directError('PROBE_OWNER_INVALID', 'Reducing a direct probe run requires the driver expected capability secret.');
  }
  if (!expectedFinalState || typeof expectedFinalState !== 'object' || Array.isArray(expectedFinalState)) {
    throw directError('PROBE_OWNER_INVALID', 'Reducing a direct probe run requires the driver final-state anchor.');
  }
  const eventsPath = join(runDirectory, 'events.jsonl');
  const lockPath = join(runDirectory, 'events.lock');
  const journalPath = join(runDirectory, SEAL_JOURNAL_FILENAME);
  return withFileLock(lockPath, async () => {
    const eventsBytes = await readBoundedEventLog(eventsPath);
    // ROUND 38: an unterminated trailing event line (partial JSON bytes, no
    // final newline) is write debris that the append-path recovery cleans up
    // (sidecar move + truncation to the committed prefix). Authenticated
    // reduction refuses such a log — it has not completed its recovery —
    // while COMPLETE sealed-uncommitted records keep the abrupt-kill
    // behavior (excluded from the committed prefix, reported via
    // uncommittedCount).
    if (eventsBytes.length > 0 && eventsBytes[eventsBytes.length - 1] !== 0x0a) {
      throw directError('PROBE_OWNER_INVALID', 'The event log ends with a torn trailing record; the recovery has not completed. Run a recovery append before reducing.');
    }
    const { committedCount, uncommittedCount, lastCommit, lastRecoveryAnchor, lastRepairAnchor, lastPartialAnchor, chainComplete } = verifySealJournalLocked({
      eventsBytes, journalPath, runNonce, ownerSecret, expectedFinalState,
    });
    // RESOLUTION GATE: an unresolved recovery intent fails the reduction
    // closed — the sidecar must still verify against the intent's recorded
    // digest and the journal head must carry the intent's exact recovery
    // fields, so evidence in the truncation-to-commit window is never
    // reducible while its anchoring commit is missing.
    const recoveryIntent = readRecoveryIntent({ runDirectory, runNonce, ownerSecret });
    if (recoveryIntent) {
      verifyIntentSidecarDigest(recoveryIntent, { runDirectory });
      if (!lastCommit || lastCommit.recoveredCount !== recoveryIntent.recoveredCount
        || lastCommit.recoveredDigest !== recoveryIntent.recoveredDigest
        || lastCommit.recoveredLength !== recoveryIntent.recoveredLength) {
        throw directError('PROBE_OWNER_INVALID', 'A recovery intent is unresolved: the committed journal head does not carry the recorded recovery.');
      }
    }
    // RESOLUTION GATE: the same fail-closed rule for the repair intent — the
    // preserved fragments must still verify against the intent and the
    // journal head must carry the intent's exact repair anchor fields, so a
    // repaired-but-unanchored journal is never reducible.
    const repairIntent = readRepairIntent({ runDirectory, runNonce, ownerSecret });
    if (repairIntent) {
      verifyRepairIntentFragments(repairIntent, {
        tornPath: join(runDirectory, TORN_JOURNAL_FILENAME),
        partialPath: join(runDirectory, REPAIRED_PARTIAL_FILENAME),
        runNonce,
        ownerSecret,
      });
      if (!lastRepairAnchor || lastRepairAnchor.tornFragmentCount !== repairIntent.tornFragmentCount
        || lastRepairAnchor.tornDigest !== repairIntent.tornDigest
        || lastRepairAnchor.tornLength !== repairIntent.tornLength
        || lastRepairAnchor.partialDigest !== repairIntent.partialDigest
        || lastRepairAnchor.partialLength !== repairIntent.partialLength) {
        throw directError('PROBE_OWNER_INVALID', 'A repair intent is unresolved: the committed journal head does not carry the recorded repair.');
      }
    }
    // ROUND 45/46: reduction requires a COMPLETE journal — every line
    // verified into the committed prefix. ANY complete lines beyond the
    // verified prefix (regardless of count or rejection reason: torn
    // partial writes, structurally rejected lines, even an authenticated
    // commit whose event digest fails) are unanchored evidence the
    // reduction can neither report nor bind, so they could be erased
    // without changing the accepted result; the append-time repair must
    // durably preserve and anchor (or truncate) those bytes first. A
    // journal that is merely SHORTER than the event log (a missing final
    // commit line from a record-fsync/journal-fsync crash) has no such
    // suffix: that approved abrupt-kill state keeps reducing with
    // uncommittedCount.
    if (!chainComplete) {
      throw directError('PROBE_OWNER_INVALID', 'The seal journal contains unverified lines beyond its committed prefix; reduction refuses until the repairing append preserves them.');
    }
    // Recovery surface: the sidecar preserving records recovered on append,
    // the preserved torn seal-journal fragments removed by repairs, and the
    // preserved partial-tail evidence. These reported recovery facts are
    // AUTHENTICATED STATE, not free bytes: the journal walk verifies each
    // anchor's sidecar PREFIX, but nothing tied a sidecar's FULL length to
    // its anchor — appending bytes beyond the anchored length changed the
    // reported recovery counts without failing reduction, and such a suffix
    // could be erased again without detection (the round 30 gate). Every
    // present sidecar's byte length must therefore EQUAL its last recorded
    // anchor exactly, and a sidecar present with no anchoring journal line
    // at all is refused outright. The unresolved intent gates above already
    // own the legitimate in-flight states: an unresolved intent fails its
    // own gate before these checks run, and an intent-resolved journal head
    // IS the anchor the length is checked against.
    const readSidecarBytes = (filename) => {
      let bytes = null;
      try { bytes = readEvidenceFileSync(join(runDirectory, filename)); } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
      return bytes;
    };
    const sidecarBytes = readSidecarBytes(UNCOMMITTED_FILENAME);
    if (sidecarBytes !== null) {
      if (!lastRecoveryAnchor) throw directError('PROBE_OWNER_INVALID', 'The recovery sidecar exists but no committed journal line anchors it.');
      if (sidecarBytes.length !== lastRecoveryAnchor.recoveredLength) {
        throw directError('PROBE_OWNER_INVALID', 'The recovery sidecar holds bytes beyond its recorded recovery; the recovery evidence is unauthenticated or tampered.');
      }
    }
    const sidecarPresent = sidecarBytes !== null;
    const sidecarRecords = sidecarPresent ? sidecarBytes.toString('utf8').split('\n').filter((line) => line.trim() !== '').length : 0;
    const tornSidecarBytes = readSidecarBytes(TORN_JOURNAL_FILENAME);
    if (tornSidecarBytes !== null) {
      if (!lastRepairAnchor) throw directError('PROBE_OWNER_INVALID', 'The preserved journal fragments exist but no committed journal line anchors them.');
      if (tornSidecarBytes.length !== lastRepairAnchor.tornLength) {
        throw directError('PROBE_OWNER_INVALID', 'The preserved journal fragments hold bytes beyond the recorded repair; the repair evidence is unauthenticated or tampered.');
      }
    }
    const tornJournalFragments = tornSidecarBytes !== null ? tornSidecarBytes.toString('utf8').split('\n').filter((line) => line.trim() !== '').length : 0;
    // Partial-tail evidence sidecar: every preserved record must
    // authenticate — alteration fails the reduction closed — and the file's
    // full length must equal the anchored partial evidence exactly, so even
    // Mac-valid bytes beyond the anchor (exactly what a writer holding the
    // run capability secret could produce) can never change the reported
    // recovery counts.
    const partialBytes = readSidecarBytes(REPAIRED_PARTIAL_FILENAME);
    if (partialBytes !== null) {
      if (!lastPartialAnchor) throw directError('PROBE_OWNER_INVALID', 'The preserved partial fragments exist but no committed journal line anchors them.');
      if (partialBytes.length !== lastPartialAnchor.partialLength) {
        throw directError('PROBE_OWNER_INVALID', 'The preserved partial fragments hold bytes beyond the recorded repair; the repair evidence is unauthenticated or tampered.');
      }
    }
    let repairedPartialFragments = 0;
    if (partialBytes !== null) {
      const partialRecords = partialBytes.toString('utf8').split('\n').filter((line) => line.trim() !== '');
      for (const partialLine of partialRecords) {
        let preservationRecord;
        try { preservationRecord = JSON.parse(partialLine); } catch {
          throw directError('PROBE_OWNER_INVALID', 'A preserved partial fragment is malformed.');
        }
        if (!preservationRecord || typeof preservationRecord !== 'object' || preservationRecord.version !== 1
          || preservationRecord.runNonce !== runNonce || typeof preservationRecord.data !== 'string'
          || typeof preservationRecord.partialMac !== 'string' || !/^[0-9a-f]{64}$/.test(preservationRecord.partialMac)
          || preservationRecord.partialMac !== computePartialRecoveryMac(ownerSecret, preservationRecord)) {
          throw directError('PROBE_OWNER_INVALID', 'A preserved partial fragment failed its authentication; the repair evidence is forged or tampered.');
        }
      }
      repairedPartialFragments = partialRecords.length;
    }
    const committedText = eventsBytes.toString('utf8').split('\n').slice(0, committedCount).join('\n');
    const committedLines = committedText === '' ? [] : committedText.split('\n');
    const records = committedLines.map((line, index) => {
      let record;
      try { record = JSON.parse(line); } catch {
        throw directError('PROBE_LOG_MALFORMED', 'The committed event log contains a malformed JSON line.');
      }
      validateDirectEventRecord(record, { runNonce });
      if (record.sequence !== index) throw directError('PROBE_SEQUENCE_INVALID', 'The committed event log records sequences out of order.');
      return record;
    });
    const hasHandlerEvidence = records.some((record) => DIRECT_HANDLER_EVENT_KINDS.includes(record.kind));
    if (hasHandlerEvidence) {
      verifyDirectProbeHandlerOwnership({ runDirectory, runNonce, ownerSecret, ownerPid });
      verifyHandlerRecordMacs(records, { ownerSecret });
    }
    return { records, uncommittedCount, recovery: { sidecarPresent, sidecarRecords, tornJournalFragments, repairedPartialFragments } };
  });
}

/**
 * Computes the per-record authentication code for one handler-side record:
 * HMAC-SHA256 keyed by the run capability secret bytes over the canonical
 * serialization (sorted keys, fixed separators) of the full record WITHOUT
 * the mac — version, run nonce, sequence, phase, kind, and every kind field
 * — so the Mac binds the exact record bytes including its log position.
 * @param {string} ownerSecret
 * @param {{recordMac?: string}} record
 */
function computeHandlerRecordMac(ownerSecret, record) {
  const payload = { ...record };
  delete payload.recordMac;
  return createHmac('sha256', Buffer.from(ownerSecret, 'utf8')).update(canonicalJson(payload)).digest('hex');
}

/**
 * Verifies the per-record Mac of EVERY handler-side record against the
 * driver expected capability secret. Any missing, malformed, or
 * non-matching Mac fails the whole reduction closed: handler-side records
 * written by a process without the secret (direct file writes, or writes
 * under a swapped owner file) can never be reduced as handler evidence.
 * Driver-kind records carry no Mac and are unaffected.
 * @param {object[]} records
 * @param {{ownerSecret: string}} options
 * @returns {boolean} true when every handler record authenticates
 */
export function verifyHandlerRecordMacs(records, { ownerSecret }) {
  if (typeof ownerSecret !== 'string' || !RUN_NONCE_PATTERN.test(ownerSecret)) {
    throw directError('PROBE_OWNER_INVALID', 'Verifying handler evidence requires the driver expected capability secret.');
  }
  for (const record of records) {
    if (!DIRECT_HANDLER_EVENT_KINDS.includes(record.kind)) continue;
    if (typeof record.recordMac !== 'string' || record.recordMac !== computeHandlerRecordMac(ownerSecret, record)) {
      throw directError('PROBE_OWNER_INVALID', `A ${record.kind} record failed its record Mac authentication; the handler evidence is forged or tampered.`);
    }
  }
  return true;
}

/**
 * Fails closed unless the CALLING process presents the run's handler-owner
 * capability: the registration must exist, carry the same run nonce, hash the
 * presented secret to the registered digest, and name `process.pid`. The
 * registration file is WRITTEN only by server.mjs's module-private function
 * as a side effect of genuinely starting a server — there is deliberately no
 * importable API that claims ownership, because that would let a driver
 * process forge handler provenance before the server starts.
 * @param {{runDirectory: string, runNonce: string, ownerSecret: string}} input
 */
function assertHandlerOwner({ runDirectory, runNonce, ownerSecret }) {
  if (typeof ownerSecret !== 'string' || !RUN_NONCE_PATTERN.test(ownerSecret)) {
    throw directError('PROBE_EVENT_FORBIDDEN', 'Handler-side kinds require presenting the run capability secret (a 64 hexadecimal digest input).');
  }
  let owner;
  try {
    owner = JSON.parse(readEvidenceFileSync(join(runDirectory, HANDLER_OWNER_FILENAME), 'utf8'));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw directError('PROBE_EVENT_FORBIDDEN', 'No handler-owner registration exists for this run; handler-side kinds are writable only by the registered server process.');
    }
    if (error instanceof SyntaxError) {
      throw directError('PROBE_LOG_MALFORMED', 'The handler-owner registration is malformed.');
    }
    throw error;
  }
  if (!owner || typeof owner !== 'object' || owner.version !== 1 || owner.runNonce !== runNonce) {
    throw directError('PROBE_RUN_NONCE_FOREIGN', 'The handler-owner registration belongs to a different run.');
  }
  if (owner.secretDigest !== hashProbeValue(runNonce, ownerSecret)) {
    throw directError('PROBE_EVENT_FORBIDDEN', 'The presented capability secret does not match the registered handler owner.');
  }
  if (owner.pid !== process.pid) {
    throw directError('PROBE_EVENT_FORBIDDEN', 'The calling process is not the registered handler-owner process; handler-side kinds are writable only by the disposable server.');
  }
}

/**
 * REDUCTION-SIDE provenance gate for the driver: verifies the owner file
 * against the driver's EXPECTED capability secret and expected server pid —
 * the spawn-time values only the driver process holds. Read-only; it writes
 * nothing and fabricates nothing. Fails closed with PROBE_OWNER_INVALID so
 * a run whose owner file was written by a forger (or whose server secret
 * was replaced) can never be reduced as handler evidence.
 * @param {{runDirectory: string, runNonce: string, ownerSecret: string, ownerPid: number}} input
 * @returns {boolean} true when the capability matches
 */
export function verifyDirectProbeHandlerOwnership({ runDirectory, runNonce, ownerSecret, ownerPid }) {
  if (!isAbsolute(runDirectory)) throw directError('PROBE_RUN_DIRECTORY_INVALID', 'The direct probe run directory must be an absolute path.');
  requireRunNonce(runNonce);
  if (typeof ownerSecret !== 'string' || !RUN_NONCE_PATTERN.test(ownerSecret) || !Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
    throw directError('PROBE_OWNER_INVALID', 'Reducing a run with handler evidence requires the driver expected capability secret and expected server pid.');
  }
  let owner;
  try {
    owner = JSON.parse(readEvidenceFileSync(join(runDirectory, HANDLER_OWNER_FILENAME), 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw directError('PROBE_LOG_MALFORMED', 'The handler-owner registration is malformed.');
    if (error && typeof error === 'object' && /** @type {any} */ (error).code === 'PROBE_LOG_SYMLINK') throw error;
    throw directError('PROBE_OWNER_INVALID', 'No handler-owner registration exists for this run; handler evidence cannot be reduced.');
  }
  if (!owner || typeof owner !== 'object' || owner.version !== 1 || owner.runNonce !== runNonce) {
    throw directError('PROBE_OWNER_INVALID', 'The handler-owner registration belongs to a different run.');
  }
  if (owner.secretDigest !== hashProbeValue(runNonce, ownerSecret) || owner.pid !== ownerPid) {
    throw directError('PROBE_OWNER_INVALID', 'The owner registration does not match the driver expected capability secret and server pid; the run handler evidence is forged or stale.');
  }
  return true;
}

/**
 * Appends one durable, validated event and assigns its dense sequence under
 * the advisory event lock, then rewrites the events seal. Both writer
 * capability wrappers present the run capability secret: every append is
 * sealed, so the seal always reflects the last durable record. Rejects
 * missing secrets, symlinks, wrong-mode or oversized logs, foreign run
 * nonces, unknown kinds, unknown fields, duplicate handler entries (per
 * label or per call nonce), settlement records without their durable
 * handler-side prerequisites, and replaced logs.
 * @param {{runDirectory: string, runNonce: string, phase: string, event: object, ownerSecret: string}} input
 * @returns {Promise<{record: object, commit: {recordCount: number, eventsDigest: string}, recovered: number}>}
 */
export async function appendDirectProbeLogRecord(input) {
  const { runDirectory, runNonce, phase, event, ownerSecret, heldCommit } = input;
  if (!isAbsolute(runDirectory)) throw directError('PROBE_RUN_DIRECTORY_INVALID', 'The direct probe run directory must be an absolute path.');
  requireRunNonce(runNonce);
  // Both writers hold the run capability secret; every append reseals the
  // log under it, so the secret is required on all kinds.
  if (typeof ownerSecret !== 'string' || !RUN_NONCE_PATTERN.test(ownerSecret)) {
    throw directError('PROBE_EVENT_FORBIDDEN', 'Appending to the direct probe log requires the run capability secret; both writer processes hold it and every append is sealed under it.');
  }
  if (typeof phase !== 'string' || event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw directError('PROBE_EVENT_INVALID', 'The direct probe event must be an object with a closed probe phase.');
  }
  // Validate the event body against the closed contract before touching the
  // log; the sequence is assigned under the lock below.
  validateDirectEventRecord({ ...event, version: 1, runNonce, sequence: 0, phase }, { runNonce });
  // PROCESS-IDENTITY + CAPABILITY BOUNDARY: handler-side kinds pass only
  // when the caller presents the run capability secret, from the registered
  // handler-owner process. Every importable append path funnels through this
  // primitive, so a driver process can never write handler evidence, no
  // matter which module it imports.
  if (DIRECT_HANDLER_EVENT_KINDS.includes(event.kind)) {
    assertHandlerOwner({ runDirectory, runNonce, ownerSecret });
  }
  const eventsPath = join(runDirectory, 'events.jsonl');
  const journalPath = join(runDirectory, SEAL_JOURNAL_FILENAME);
  const lockPath = join(runDirectory, 'events.lock');
  // ROUND 56: any rejection AFTER the durable commit lands — including the
  // lock release itself — must carry the landed commit for the callers'
  // process-held witnesses (the driver's driverCommitStates and the server's
  // runHandlerCommitStates both adopt error.commit).
  let landedCommit = null;
  const appendOperation = withFileLock(lockPath, async () => {
    const pathStats = await lstat(eventsPath).then((value) => value, (error) => {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    });
    if (pathStats) {
      if (pathStats.isSymbolicLink()) throw directError('PROBE_LOG_SYMLINK', 'The direct probe event log must not be a symlink.');
      if (!pathStats.isFile()) throw directError('PROBE_LOG_NOT_FILE', 'The direct probe event log path must be a regular file.');
      if (process.platform !== 'win32' && (pathStats.mode & 0o777) !== 0o600) {
        throw directError('PROBE_LOG_MODE', 'The direct probe event log must be mode 0600.');
      }
      if (pathStats.size > DIRECT_PROBE_EVENTS_MAX_BYTES) throw directError('PROBE_LOG_SIZE_BOUND', 'The direct probe event log exceeds its size bound.');
    }
    // The very first append has no log file yet: an empty byte sequence is
    // the committed state.
    const eventsBytes = pathStats ? await readBoundedEventLog(eventsPath) : Buffer.alloc(0);
    // JOURNAL CHAIN + WRITER-HELD VERIFICATION (before any write): the seal
    // journal must chain from this writer's held commit; a rolled back or
    // diverged state refuses the append with PROBE_STATE_DIVERGED.
    const verifiedJournalIdentity = {};
    const journalState = verifySealJournalLocked({
      eventsBytes, journalPath, runNonce, ownerSecret, heldCommit, journalIdentityOut: verifiedJournalIdentity,
    });
    if (!journalState.chainComplete) {
      // A complete, MAC-valid final commit whose event bytes no longer match
      // is CORRUPTION, not an incomplete write: refuse outright without
      // truncating the journal, moving event records, or anchoring anything.
      if (journalState.finalLineEventCorrupted) {
        throw directError('PROBE_STATE_DIVERGED', 'The final journal commit is authenticated but its event bytes no longer match its recorded digest; the event log was corrupted.');
      }
      // A crash mid journal-line write leaves a torn final line, and a torn
      // or structurally broken FINAL line (every preceding line chains
      // validly) was never a committed record: repair it in place —
      // preserve the fragment as authenticated evidence, physically truncate
      // it, and let the chain continue. Any OTHER incompleteness (forged,
      // rolled-back, or event-corrupted lines) still refuses the append.
      if (!((journalState.tornJournalTail && journalState.chainAuthentic) || journalState.finalLineRejected)) {
        throw directError('PROBE_STATE_DIVERGED', 'The seal journal contains entries this writer cannot authenticate; appending is refused.');
      }
      // VALIDATE any existing repair intent BEFORE repairing again: the
      // repair replaces the intent (atomic replacement), so an intent whose
      // bindings no longer verify against the CURRENT files — its covered
      // torn-fragment state, or its bound partial evidence — must refuse
      // the repair outright: never overwrite it, never truncate the
      // journal. Otherwise a repeat repair could launder the deletion of
      // previously preserved fragments or partial evidence behind a fresh
      // replacement history.
      const existingRepairIntent = readRepairIntent({ runDirectory, runNonce, ownerSecret });
      if (existingRepairIntent) {
        // ROUND 40/41: the journal's intact repair fragment, for the two
        // pre-append crash windows (the intent durable before the sidecar
        // materialization/replacement) — extracted with the SAME logic as
        // repairTornJournalTail's own final-line extraction, so a
        // NEWLINE-TERMINATED structurally rejected final line reconstructs
        // the same bound fragment an unterminated tail always did.
        const journalFragmentText = extractRepairFragmentText(readEvidenceFileSync(journalPath, 'utf8'));
        verifyRepairIntentFragments(existingRepairIntent, {
          tornPath: join(runDirectory, TORN_JOURNAL_FILENAME),
          partialPath: join(runDirectory, REPAIRED_PARTIAL_FILENAME),
          runNonce,
          ownerSecret,
          journalFragmentText,
        });
      }
      await repairTornJournalTail({
        journalPath,
        tornPath: join(runDirectory, TORN_JOURNAL_FILENAME),
        partialPath: join(runDirectory, REPAIRED_PARTIAL_FILENAME),
        runDirectory,
        runNonce,
        ownerSecret,
        existingIntent: existingRepairIntent,
        lastRepairAnchor: journalState.lastRepairAnchor,
        lastPartialAnchor: journalState.lastPartialAnchor,
      });
    }
    // ANCHOR preserved torn-journal fragments: whenever the torn sidecar's
    // current cumulative state is not yet anchored by a journal line, this
    // append's commit carries the anchor fields — the repairing append
    // itself, or the first append after a crash in the repair-to-commit
    // window. Once anchored, later commits carry nothing. The preserved
    // partial-tail evidence is bound alongside: whenever its cumulative
    // state is not already bound by the last repair anchor, the same commit
    // anchors it too.
    let commitRepair = null;
    let tornBytes = null;
    try { tornBytes = readEvidenceFileSync(join(runDirectory, TORN_JOURNAL_FILENAME)); } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    let partialText = null;
    try { partialText = readEvidenceFileSync(join(runDirectory, REPAIRED_PARTIAL_FILENAME), 'utf8'); } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    // ROUND 34: the repair intent is read and verified BEFORE the anchoring
    // computation, so the ordinary append can bind the sidecars to the
    // verified in-flight state.
    const repairIntent = readRepairIntent({ runDirectory, runNonce, ownerSecret });
    if (repairIntent) {
      verifyRepairIntentFragments(repairIntent, {
        tornPath: join(runDirectory, TORN_JOURNAL_FILENAME),
        partialPath: join(runDirectory, REPAIRED_PARTIAL_FILENAME),
        runNonce,
        ownerSecret,
      });
    }
    // ROUND 34 GATE: on the ordinary append path the sidecars are only ever
    // RE-anchored, never repaired — the journal is complete, so the repair
    // machinery (and its binding gates) never runs. Each present sidecar
    // must therefore already be bound: exactly at its last committed anchor,
    // or at the verified in-flight repair-intent state. A replayed or forged
    // suffix would otherwise be hashed into commitRepair and anchored by
    // this very append, laundering unauthenticated bytes into reported
    // recovery evidence. A mismatch refuses the WHOLE append closed — no
    // event, no anchor — and the caller retries after restoring the bound
    // bytes.
    if (tornBytes !== null && tornBytes.length > 0) {
      const boundTornLength = repairIntent !== null
        ? repairIntent.tornLength
        : journalState.lastRepairAnchor?.tornLength;
      if (boundTornLength === undefined || tornBytes.length !== boundTornLength) {
        throw directError('PROBE_OWNER_INVALID', 'The preserved journal fragments do not match their recorded anchor; appending would anchor unauthenticated bytes.');
      }
    }
    if (partialText !== null && partialText.length > 0) {
      const boundPartialLength = repairIntent !== null && repairIntent.partialDigest !== undefined
        ? repairIntent.partialLength
        : journalState.lastPartialAnchor?.partialLength;
      if (boundPartialLength === undefined || Buffer.byteLength(partialText, 'utf8') !== boundPartialLength) {
        throw directError('PROBE_OWNER_INVALID', 'The preserved partial fragments do not match their recorded anchor; appending would anchor unauthenticated bytes.');
      }
    }
    const anchor = journalState.lastRepairAnchor;
    if (tornBytes !== null && tornBytes.length > 0) {
      const tornLength = tornBytes.length;
      const tornDigest = createHash('sha256').update(tornBytes).digest('hex');
      const tornFragmentCount = tornBytes.toString('utf8').split('\n').filter((fragmentLine) => fragmentLine.trim() !== '').length;
      if (!anchor || anchor.tornLength !== tornLength || anchor.tornDigest !== tornDigest || anchor.tornFragmentCount !== tornFragmentCount) {
        commitRepair = { tornFragmentCount, tornDigest, tornLength };
      }
    }
    if (partialText !== null && partialText.length > 0) {
      const partialLength = Buffer.byteLength(partialText, 'utf8');
      const partialDigest = createHash('sha256').update(Buffer.from(partialText, 'utf8')).digest('hex');
      if (!anchor || anchor.partialDigest !== partialDigest || anchor.partialLength !== partialLength) {
        commitRepair = { ...commitRepair, partialDigest, partialLength };
      }
    }
    // RESOLVE any repair intent a crashed repair left behind — before
    // anything else is committed. The intent is authenticated and bound to
    // the preserved fragments first, so deleted or altered fragments under
    // an unresolved intent refuse the append outright.
    let clearRepairIntent = false;
    if (repairIntent) {
      const repairAnchor = journalState.lastRepairAnchor;
      if (repairAnchor && repairAnchor.tornFragmentCount === repairIntent.tornFragmentCount
        && repairAnchor.tornDigest === repairIntent.tornDigest
        && repairAnchor.tornLength === repairIntent.tornLength
        && repairAnchor.partialDigest === repairIntent.partialDigest
        && repairAnchor.partialLength === repairIntent.partialLength) {
        // The anchor commit landed before the crash; only the intent removal
        // was lost. Resolve by removing it.
        await unlink(join(runDirectory, REPAIR_INTENT_FILENAME));
        await syncRunDirectory(runDirectory);
      } else {
        // Unresolved: the next commit MUST carry the intent-bound anchor
        // fields (including the partial-evidence binding) so the preserved
        // fragments become anchored.
        commitRepair = {
          tornFragmentCount: repairIntent.tornFragmentCount,
          tornDigest: repairIntent.tornDigest,
          tornLength: repairIntent.tornLength,
          ...(repairIntent.partialDigest !== undefined
            ? { partialDigest: repairIntent.partialDigest, partialLength: repairIntent.partialLength }
            : {}),
        };
        clearRepairIntent = true;
      }
    }
    // RESOLVE any recovery intent a crashed recovery left behind — before
    // anything else is committed. The intent is authenticated and bound to
    // the sidecar bytes first, so a deleted or altered sidecar under an
    // unresolved intent refuses the append outright.
    let commitRecovery = null;
    let clearIntent = false;
    const recoveryIntent = readRecoveryIntent({ runDirectory, runNonce, ownerSecret });
    if (recoveryIntent) {
      // ROUND 36: the intent-first ordering makes the intent-only crash
      // window legal — the intent durable while the sidecar write is still
      // pending. A MISSING sidecar is tolerated here so the recovery below
      // can recompute its bytes from the event source and verify them
      // against the intent before writing; a PRESENT sidecar is verified
      // against the intent's prefix binding as before. Reduction keeps its
      // own strict check.
      let recoverySidecarPresent = true;
      let sidecarNow = null;
      try { sidecarNow = readEvidenceFileSync(join(runDirectory, UNCOMMITTED_FILENAME)); } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
        recoverySidecarPresent = false;
      }
      if (recoverySidecarPresent) {
        // ROUND 39: the sidecar must match a durable binding — the
        // unresolved intent's exact content (the sidecar write completed
        // behind it), or the previous journal anchor's exact content (the
        // crash landed after the intent for the ENLARGED sidecar was
        // persisted but before the sidecar replacement — the retry
        // reconstructs the target from the intact event source and verifies
        // it against the intent below). Anything else refuses.
        const matchesAnchor = journalState.lastRecoveryAnchor !== null
          && sidecarNow.length === journalState.lastRecoveryAnchor.recoveredLength
          && createHash('sha256').update(sidecarNow).digest('hex') === journalState.lastRecoveryAnchor.recoveredDigest;
        const matchesIntent = sidecarNow.length === recoveryIntent.recoveredLength
          && createHash('sha256').update(sidecarNow).digest('hex') === recoveryIntent.recoveredDigest;
        if (!matchesAnchor && !matchesIntent) {
          throw directError('PROBE_OWNER_INVALID', 'The recovery sidecar does not match the unresolved recovery intent or its recorded anchor; appending would anchor unauthenticated bytes.');
        }
      }
      const head = journalState.lastCommit;
      if (head && head.recoveredCount === recoveryIntent.recoveredCount
        && head.recoveredDigest === recoveryIntent.recoveredDigest
        && head.recoveredLength === recoveryIntent.recoveredLength) {
        // The recovery commit landed before the crash; only the intent
        // removal was lost. Resolve by removing it.
        await unlink(join(runDirectory, RECOVERY_INTENT_FILENAME));
        await syncRunDirectory(runDirectory);
      } else if (journalState.uncommittedCount === 0) {
        // Truncated but uncommitted: this append's commit MUST carry the
        // intent's recovery fields so the sidecar becomes anchored.
        // ROUND 37: with the events truncated, the sidecar held the ONLY
        // copy of the recovered bytes — a missing sidecar cannot be
        // recomputed from anywhere, so the recovery refuses WITHOUT
        // appending or clearing the intent (repeated retries preserve the
        // intent; reduction keeps reporting the unresolved state).
        if (!recoverySidecarPresent) {
          throw directError('PROBE_OWNER_INVALID', 'The recovery sidecar is missing but the recovery intent binds its preserved bytes; the recovery refuses without writing.');
        }
        // ROUND 38: the intent binds the sidecar's FULL content — the
        // commit path requires the sidecar's length and digest to equal the
        // intent's binding exactly. Bytes beyond recoveredLength are an
        // unauthenticated suffix: the recovery refuses WITHOUT appending or
        // clearing the intent.
        const boundSidecarBytes = readEvidenceFileSync(join(runDirectory, UNCOMMITTED_FILENAME));
        if (boundSidecarBytes.length !== recoveryIntent.recoveredLength
          || createHash('sha256').update(boundSidecarBytes).digest('hex') !== recoveryIntent.recoveredDigest) {
          throw directError('PROBE_OWNER_INVALID', 'The recovery sidecar does not match the recovery intent\'s bound content; the recovery refuses without writing.');
        }
        commitRecovery = {
          recoveredCount: recoveryIntent.recoveredCount,
          recoveredDigest: recoveryIntent.recoveredDigest,
          recoveredLength: recoveryIntent.recoveredLength,
        };
        clearIntent = true;
      }
      // else: uncommitted records remain — the recovery below re-executes
      // (this intent was just verified against the sidecar), supersedes it
      // with a fresh durable intent before ITS truncation, and commits the
      // fresh fields.
    }
    // RECOVERY ON APPEND (Finding 2 of the commit-protocol review): records
    // beyond the committed prefix (kill between record fsync and journal
    // fsync) move to the sidecar — preserving the gap as visible evidence —
    // and the log is truncated to the committed prefix before this append
    // proceeds, so sequences continue densely from the committed state.
    let recovered = 0;
    let recoveredDigest;
    let recoveredLength;
    if (journalState.uncommittedCount > 0) {
      const uncommittedLines = eventsBytes.toString('utf8').split('\n').filter((line) => line !== '').slice(journalState.committedCount);
      const sidecarPath = join(runDirectory, UNCOMMITTED_FILENAME);
      // ROUND 31 GATE (reworked by round 36): a present sidecar must be
      // bound — by the durable recovery intent's exact content, or by the
      // last committed recovery anchor's exact content. A planted or drifted
      // file refuses the append WITHOUT writing. The round 36 intent-first
      // ordering adds the intent-only crash window: the sidecar missing
      // while a durable intent binds the bytes to be preserved.
      let existingSidecarBytes = null;
      try { existingSidecarBytes = readEvidenceFileSync(sidecarPath); } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
      const matchesAnchor = existingSidecarBytes !== null && journalState.lastRecoveryAnchor !== null
        && existingSidecarBytes.length === journalState.lastRecoveryAnchor.recoveredLength
        && createHash('sha256').update(existingSidecarBytes).digest('hex') === journalState.lastRecoveryAnchor.recoveredDigest;
      const matchesIntent = existingSidecarBytes !== null && recoveryIntent !== null && recoveryIntent.recoveredDigest !== undefined
        && existingSidecarBytes.length === recoveryIntent.recoveredLength
        && createHash('sha256').update(existingSidecarBytes).digest('hex') === recoveryIntent.recoveredDigest;
      if (existingSidecarBytes !== null && !matchesAnchor && !matchesIntent) {
        throw directError('PROBE_OWNER_INVALID', 'The recovery sidecar does not match its recorded recovery anchor or the unresolved recovery intent; appending would anchor unauthenticated bytes.');
      }
      // ROUND 36 (mirror of 35): the exact post-recovery sidecar bytes are
      // computed in memory from the uncommitted event records, and the
      // recovery intent is made durable FIRST — binding those bytes — before
      // the sidecar is created or extended. The old ordering (sidecar write
      // first, intent second) left a crash window where the sidecar existed
      // without any binding, stranding the recovery; intent-first makes that
      // state unreachable, and a planted sidecar refuses at the gate above.
      // When the durable intent already binds the EXISTING sidecar bytes
      // AND those bytes end with exactly the events' uncommitted records
      // (the crash landed between the sidecar write and the truncation),
      // the batch is already preserved — the recovery only truncates the
      // events and commits the intent's binding. Any OTHER uncommitted
      // records (a torn record written after the sidecar work) are new
      // evidence: they are appended to the sidecar and the intent is
      // superseded with the extended binding.
      const uncommittedText = `${uncommittedLines.join('\n')}\n`;
      const alreadyPreserved = matchesIntent
        && existingSidecarBytes !== null
        && existingSidecarBytes.toString('utf8').endsWith(uncommittedText);
      const separator = existingSidecarBytes !== null && existingSidecarBytes.length > 0 ? '\n' : '';
      const appendedBytes = Buffer.from(`${separator}${uncommittedLines.join('\n')}\n`, 'utf8');
      if (process.env.DEBUG_DIRECT_PROBE) console.error('DEBUG-REC36\n' + eventsBytes.toString('utf8').split('\n').filter((l) => l !== '').map((l) => { try { const p = JSON.parse(l); return `seq=${p.sequence} kind=${p.kind} outcome=${p.outcome ?? '-'}`; } catch { return `JUNK:${l.slice(0, 40)}`; } }).join('\n') + '\n---');
      const targetSidecarBytes = alreadyPreserved
        ? existingSidecarBytes
        : (existingSidecarBytes === null ? appendedBytes : Buffer.concat([existingSidecarBytes, appendedBytes]));
      recovered = alreadyPreserved ? 0 : uncommittedLines.length;
      recoveredLength = targetSidecarBytes.length;
      recoveredDigest = createHash('sha256').update(targetSidecarBytes).digest('hex');
      if (alreadyPreserved) {
        // The durable intent already binds these exact bytes; the commit
        // re-records them and clears the intent.
        commitRecovery = {
          recoveredCount: recoveryIntent.recoveredCount,
          recoveredDigest: recoveryIntent.recoveredDigest,
          recoveredLength: recoveryIntent.recoveredLength,
        };
        clearIntent = true;
      }
      // DURABLE RECOVERY INTENT FIRST: binds the exact final sidecar bytes.
      // Skipped when the durable intent already binds exactly these bytes —
      // the crashed attempt got as far as writing the sidecar behind it, so
      // only the truncation and the commit remain.
      const intentBindsTarget = recoveryIntent !== null
        && recoveryIntent.recoveredCount === recovered
        && recoveryIntent.recoveredDigest === recoveredDigest
        && recoveryIntent.recoveredLength === recoveredLength;
      if (!alreadyPreserved && !intentBindsTarget) {
        await writeRecoveryIntent({ runDirectory, runNonce, ownerSecret }, { recoveredCount: recovered, recoveredDigest, recoveredLength });
      }
      // ATOMIC SIDECAR WRITE behind the durable intent, verified against it:
      await replaceIntentAtomically(sidecarPath, runDirectory, targetSidecarBytes);
      const writtenSidecarBytes = readEvidenceFileSync(sidecarPath);
      if (writtenSidecarBytes.length !== recoveredLength || createHash('sha256').update(writtenSidecarBytes).digest('hex') !== recoveredDigest) {
        throw directError('PROBE_OWNER_INVALID', 'The written recovery sidecar does not match its recovery intent; refusing the recovery.');
      }
      // Truncate to the committed prefix; the kept bytes' digest was verified
      // against the committed journal line before truncating. An EMPTY
      // committed prefix (the first record was fsynced but its seal never
      // landed) is a valid initial state: the zero-length prefix has no
      // committed digest to match.
      const prefixBytes = eventsBytes.subarray(0, journalState.prefixLen);
      const prefixDigest = createHash('sha256').update(prefixBytes).digest('hex');
      if (journalState.committedCount > 0 && prefixDigest !== journalState.committedDigest) {
        throw directError('PROBE_STATE_DIVERGED', 'The committed prefix digest does not match its journal line; refusing to append.');
      }
      // The DURABLE RECOVERY INTENT was written before the sidecar write
      // (round 36 ordering), so by this point it already binds the exact
      // final sidecar bytes; a crash in the truncation-to-commit window
      // leaves a durable record that forces the next append (and every
      // reduction) to resolve the recovery — the sidecar can never become
      // unanchored, silently deletable evidence.
      // The sidecar's and intent's DIRECTORY ENTRIES (including the intent's
      // atomic rename) are durable before the truncation: on POSIX a synced
      // file can still vanish in a power loss when its directory entry never
      // reached the disk. replaceIntentAtomically already fsynced the
      // directory; the sidecar's entry was synced above.
      // ROUND 47: the recovery truncation is a WRITE through the validated
      // descriptor, not a pathname call: events.jsonl is reopened with
      // O_NOFOLLOW, its descriptor is verified to still identify the SAME
      // regular file that was validated above (same device, inode, and
      // private mode), and both the truncation and its fsync flow through
      // that descriptor. A directory-entry swap after validation can never
      // redirect the truncation to a writable file outside the private run
      // directory.
      let eventsHandle;
      try {
        eventsHandle = await fsp.open(eventsPath, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
      } catch (error) {
        if (errorCode(error) === 'ELOOP') throw directError('PROBE_LOG_SYMLINK', 'The direct probe event log must not be a symlink.');
        throw error;
      }
      try {
        // fstatSync on the descriptor (never the prototype stat) keeps the
        // FileHandle observability surface identical to the pre-round-47
        // flow for crash-window instrumentation.
        const truncateStats = fs.fstatSync(eventsHandle.fd);
        if (truncateStats.dev !== pathStats.dev || truncateStats.ino !== pathStats.ino
          || (truncateStats.mode & 0o777) !== (pathStats.mode & 0o777)) {
          throw directError('PROBE_LOG_REPLACED', 'The event log was replaced after validation; the recovery truncation refuses to follow the swap.');
        }
        await eventsHandle.truncate(journalState.prefixLen);
        await eventsHandle.sync();
      } finally { await eventsHandle.close(); }
    }
    const history = pathStats ? await parseDirectEventLog(eventsPath, runNonce) : [];
    if (event.kind === 'handler-entered') {
      for (const record of history) {
        if (record.kind !== 'handler-entered') continue;
        if (record.callNonce === event.callNonce) throw directError('PROBE_ENTRY_DUPLICATE', 'A handler entry already exists for this call nonce.');
        if (record.probeLabel === event.probeLabel) throw directError('PROBE_LABEL_DUPLICATE', 'A handler entry already exists for this probe label.');
      }
    }
    if (event.kind === 'handler-settled' || event.kind === 'worker-settled') {
      // Durable settlements must stand on durable handler-side records from
      // this same log: a durable entry, and for the worker a durable
      // matching hold. Ordering never proves WHO observed the settlement —
      // that is the writer partition's job — but a settlement without its
      // prerequisites fails closed at write time.
      const entry = history.find((record) => record.kind === 'handler-entered' && record.callNonce === event.callNonce);
      if (!entry) {
        throw directError('PROBE_ORDER_INVALID', `${event.kind} requires a durable handler entry for the call.`);
      }
      if (event.kind === 'worker-settled') {
        const hold = history.find((record) => record.kind === 'hold-started' && record.callNonce === event.callNonce);
        if (!hold) throw directError('PROBE_ORDER_INVALID', 'worker-settled requires a durable hold start for the same call.');
        if (hold.workerHash !== event.workerHash) throw directError('PROBE_WORKER_MISMATCH', 'worker-settled does not match the held synthetic worker.');
      }
    }
    const sequence = history.length;
    // Envelope keys are forced last: the log, never the caller, owns
    // version, run nonce, assigned sequence, and phase.
    const record = { ...event, version: 1, runNonce, sequence, phase };
    // Per-record authentication: handler-side records are MACed under the
    // run capability secret over their canonical form (sequence included),
    // so the server-held secret authenticates the exact record bytes and
    // position. Reordering or replaying a record breaks its Mac.
    if (DIRECT_HANDLER_EVENT_KINDS.includes(event.kind)) {
      record.recordMac = computeHandlerRecordMac(ownerSecret, record);
    }
    validateDirectEventRecord(record, { runNonce });
    const line = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    if ((pathStats?.size ?? 0) + line.length > DIRECT_PROBE_EVENTS_MAX_BYTES) {
      throw directError('PROBE_LOG_SIZE_BOUND', 'The direct probe event log exceeds its size bound.');
    }
    const handle = await open(eventsPath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const handleStats = await handle.stat();
      if (!handleStats.isFile()) throw directError('PROBE_LOG_SYMLINK', 'The direct probe event log must be a regular file.');
      // Identity comparison as in the original probe: the inode is stable
      // across platforms, and dev joins it on POSIX alone.
      if (pathStats && (handleStats.ino !== pathStats.ino || (process.platform !== 'win32' && handleStats.dev !== pathStats.dev))) {
        throw directError('PROBE_LOG_REPLACED', 'The direct probe event log was replaced while it was opened.');
      }
      await handle.writeFile(line);
      await handle.sync();
      if (process.platform !== 'win32') await handle.chmod(0o600);
    } finally { await handle.close(); }
    // Completeness anchor: reseal under the same lock so the seal always
    // reflects exactly the durable records, even after abrupt kills.
    // COMMIT: append the journal line for this record and fsync it. The
    // commit state returns to the caller — the driver keeps the last one as
    // its in-memory final anchor. A commit that followed a recovery records
    // the recovery (count + sidecar digest + cumulative length) on the line;
    // a commit resolving an unresolved intent carries the INTENT's fields.
    const commit = await commitDirectProbeSealLocked({
      eventsPath,
      runDirectory,
      runNonce,
      ownerSecret,
      // A journal absent at verification time is CREATED here: there is no
      // verified identity to compare, and none is needed.
      verifiedJournalIdentity: verifiedJournalIdentity.ino !== undefined ? verifiedJournalIdentity : null,
      recordCount: history.length + 1,
      ...(recovered > 0
        ? { recoveredCount: recovered, recoveredDigest, recoveredLength }
        : commitRecovery),
      ...(commitRepair ?? {}),
    });
    landedCommit = commit;
    // The intent is removed only after its recovery commit line is durable;
    // the removal's directory entry is then made durable too. ROUND 54: a
    // failure in these trailing steps is AMBIGUOUS — the commit already
    // landed — so the rejection carries the durable commit for the callers'
    // process-held witness.
    try {
      if (recovered > 0 || clearIntent) {
        await unlink(join(runDirectory, RECOVERY_INTENT_FILENAME));
        await syncRunDirectory(runDirectory);
      }
      // Same for the repair intent: removed only after the repair anchor
      // commit line is durable, then its directory entry is made durable.
      if (clearRepairIntent) {
        await unlink(join(runDirectory, REPAIR_INTENT_FILENAME));
        await syncRunDirectory(runDirectory);
      }
    } catch (trailingError) {
      if (trailingError && typeof trailingError === 'object') {
        trailingError.commit = commit;
      }
      throw trailingError;
    }
    return { record, commit, recovered };
  });
  try {
    return await appendOperation;
  } catch (error) {
    if (landedCommit !== null && error && typeof error === 'object' && error.commit === undefined) {
      error.commit = landedCommit;
    }
    throw error;
  }
}

/**
 * Reads and validates the complete event log under the advisory event lock.
 * @param {{runDirectory: string, runNonce: string}} input
 * @returns {Promise<object[]>}
 */
export async function readDirectProbeLog(input) {
  const { runDirectory, runNonce } = input;
  if (!isAbsolute(runDirectory)) throw directError('PROBE_RUN_DIRECTORY_INVALID', 'The direct probe run directory must be an absolute path.');
  requireRunNonce(runNonce);
  const eventsPath = join(runDirectory, 'events.jsonl');
  const lockPath = join(runDirectory, 'events.lock');
  return withFileLock(lockPath, async () => {
    const present = await lstat(eventsPath).then((value) => value, (error) => {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    });
    if (!present) return [];
    if (present.isSymbolicLink()) throw directError('PROBE_LOG_SYMLINK', 'The direct probe event log must not be a symlink.');
    return parseDirectEventLog(eventsPath, runNonce);
  });
}

/**
 * COMMITTED-STATE RECONCILIATION for a failed append: under ONE advisory
 * lock, reads the event file bytes and the seal journal together, walks the
 * journal chain, and reports whether a record matching {kind, callNonce}
 * sits inside the COMMITTED prefix — the bytes covered by the chained
 * eventsDigest. A rejected append can still have committed: its trailing
 * steps (intent unlinks, the run-directory fsync) reject after the journal
 * line is durable, so callers reconcile against this read before treating
 * an event as never-durable.
 * @param {{runDirectory: string, runNonce: string, ownerSecret: string, kind: string, callNonce?: string, label?: string}} input
 * @returns {Promise<boolean>}
 */
export async function hasCommittedDirectProbeEvent({ runDirectory, runNonce, ownerSecret, kind, callNonce, label, heldCommit = null }) {
  if (!isAbsolute(runDirectory)) throw directError('PROBE_RUN_DIRECTORY_INVALID', 'The direct probe run directory must be an absolute path.');
  requireRunNonce(runNonce);
  if (typeof ownerSecret !== 'string' || !RUN_NONCE_PATTERN.test(ownerSecret)) {
    throw directError('PROBE_OWNER_INVALID', 'Reading the committed state requires the run capability secret.');
  }
  if (typeof kind !== 'string' || (callNonce === undefined && label === undefined)) {
    throw directError('PROBE_LOG_MALFORMED', 'The committed-state reconciliation requires a record kind and a call nonce or label.');
  }
  const eventsPath = join(runDirectory, 'events.jsonl');
  const lockPath = join(runDirectory, 'events.lock');
  const journalPath = join(runDirectory, SEAL_JOURNAL_FILENAME);
  return withFileLock(lockPath, async () => {
    let eventsBytes = null;
    let eventsMissing = false;
    try {
      eventsBytes = await readBoundedEventLog(eventsPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      eventsMissing = true;
    }
    let journalText = null;
    let journalMissing = false;
    try {
      journalText = readEvidenceFileSync(journalPath, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') journalMissing = true;
      else throw error;
    }
    // ROUND 52/53/54: absence is provable ONLY for a fresh, empty run — no
    // committed records anywhere AND no commit this process has ever
    // observed. Every other missing-or-empty shape is UNKNOWN: erasure or
    // transient loss is not proof that nothing committed, and the callers
    // keep their labels reserved and their holds registered. When the
    // process holds a commit, the verified chain must REACH it — a shorter
    // chain, or a different digest at the held recordCount (a rollback to
    // an earlier valid prefix), is UNKNOWN as well; the held-commit check
    // runs inside verifySealJournalLocked.
    if (eventsMissing) {
      if (heldCommit !== null || journalText !== null) {
        throw directError('PROBE_OWNER_INVALID', 'The event log is missing while the seal journal or this process records commits; the committed state cannot be proven.');
      }
      return false;
    }
    if (journalMissing || journalText === '') {
      if (heldCommit !== null) {
        throw directError('PROBE_OWNER_INVALID', 'The seal journal is missing or empty after this process observed a commit; the committed state cannot be proven.');
      }
      throw directError('PROBE_LOG_MALFORMED', 'Event bytes exist without a seal journal; the committed state cannot be proven.');
    }
    const { committedCount, prefixLen } = verifySealJournalLocked({ eventsBytes, journalPath, runNonce, ownerSecret, heldCommit });
    if (committedCount === 0) {
      if (heldCommit !== null) {
        throw directError('PROBE_OWNER_INVALID', 'The seal journal records no commits; the committed state cannot be proven.');
      }
      return false;
    }
    for (const line of eventsBytes.subarray(0, prefixLen).toString('utf8').slice(0, -1).split('\n')) {
      let record;
      try { record = JSON.parse(line); } catch {
        throw directError('PROBE_LOG_MALFORMED', 'The committed event log contains a malformed JSON line.');
      }
      if (record && typeof record === 'object' && record.kind === kind
        && (callNonce === undefined || record.callNonce === callNonce)
        && (label === undefined || record.probeLabel === label)) return true;
    }
    return false;
  });
}

/**
 * Parses the bounded event log without following a final symlink, enforcing
 * the size bound, terminated final line, foreign run nonce, and dense
 * sequence order. Assumes the caller holds the event lock.
 * @param {string} path
 * @param {string} runNonce
 */
async function parseDirectEventLog(path, runNonce) {
  const bytes = await readBoundedEventLog(path);
  const text = bytes.toString('utf8');
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines.at(-1) !== '') throw directError('PROBE_LOG_TORN', 'The direct probe event log ends with a partial line.');
  /** @type {object[]} */
  const records = [];
  for (const [index, line] of lines.slice(0, -1).entries()) {
    let record;
    try { record = JSON.parse(line); } catch {
      throw directError('PROBE_LOG_MALFORMED', 'The direct probe event log contains a malformed JSON line.');
    }
    validateDirectEventRecord(record, { runNonce });
    if (record.sequence !== index) throw directError('PROBE_SEQUENCE_INVALID', 'The direct probe event log records sequences out of order.');
    records.push(record);
  }
  return records;
}

/**
 * Opens the log without following a final symlink, rejects its declared size
 * before allocating, and reads at most the bound. Assumes the caller holds
 * the event lock.
 * @param {string} path
 */
async function readBoundedEventLog(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > DIRECT_PROBE_EVENTS_MAX_BYTES) throw directError('PROBE_LOG_SIZE_BOUND', 'The direct probe event log exceeds its size bound.');
    const bytes = Buffer.alloc(DIRECT_PROBE_EVENTS_MAX_BYTES);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > DIRECT_PROBE_EVENTS_MAX_BYTES) throw directError('PROBE_LOG_SIZE_BOUND', 'The direct probe event log exceeds its size bound.');
    return bytes.subarray(0, offset);
  } finally { await handle.close().catch(() => {}); }
}
