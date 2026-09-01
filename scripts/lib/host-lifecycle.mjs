import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, open, opendir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { PluginError } from './errors.mjs';
import { atomicWriteJson, ensurePrivateDirectory, ensurePrivateDirectoryWithin, isLockPublishCollision, readBoundedJsonFile, withFileLock } from './fs.mjs';
import { hasControl } from './identifier.mjs';

export const RECEIPT_VERSION = 1;
export const RECEIPT_KIND = 'host-session-end';
export const RECEIPT_ORIGINS = Object.freeze(['session-end-hook', 'resume-compensation']);
export const RECEIPT_STATES = Object.freeze(['pending', 'settled']);
export const RECEIPT_MAX_WORKSPACE_HINTS = 128;
export const RECEIPT_WORKSPACE_HINT_MAX_BYTES = 4_096;
// The raw hint array accepted from a caller is hard-capped before any
// traversal or sorting so validation itself stays inside the publication
// budget; duplicates within the cap may still collapse to a canonical set
// within the persisted bound.
const RECEIPT_MAX_RAW_WORKSPACE_HINTS = 4_096;
export const RECEIPT_MAX_SETTLED = 512;
export const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const RECEIPT_ABORT_BUDGET_MS = 500;
const EPOCH_DOMAIN = 'host-lifecycle-epoch-v1';
// 128 hints x 4,096 UTF-8 bytes each can double under JSON escaping, plus the
// remaining fields and two-space indentation, so a valid maximum receipt is
// above 512 KiB; the read bound must admit every receipt publication accepts.
const RECEIPT_MAX_BYTES = 2 * 1_024 * 1_024;
// Retained per-epoch advisory lock directories live beside the receipt files
// and are excluded from the receipt-count bound; only this hard ceiling keeps
// the directory enumeration itself bounded.
const RECEIPTS_DIRECTORY_MAX_ENTRIES = 262_144;
const RECEIPTS_MAX_RECEIPT_FILES = 4_096;
// Maintenance enumeration scans up to the hard entry ceiling, so its local
// abort budget is larger than the 500 ms SessionEnd publication budget.
const RECEIPT_SCAN_ABORT_BUDGET_MS = 5_000;
const RECEIPT_FILE_NAME_PATTERN = /^[0-9a-f]{64}\.json$/u;
const RECEIPT_INPUT_KEYS = ['sessionId', 'sessionStartedAt', 'endedAt', 'origin', 'workspaceHints'];

/** @param {string} sessionId @param {string} sessionStartedAt */
export function hostLifecycleEpoch(sessionId, sessionStartedAt) {
  validateSessionId(sessionId);
  validateTimestamp(sessionStartedAt, 'sessionStartedAt');
  return createHash('sha256')
    .update(`${EPOCH_DOMAIN}\0`)
    .update(sessionId)
    .update('\0')
    .update(sessionStartedAt)
    .digest('hex');
}

/**
 * Races one storage operation against the abort budget: rejection happens
 * immediately with the signal's reason even if the underlying filesystem
 * operation settles later, and that abandoned operation's late rejection is
 * always absorbed — a no-op handler is attached before the already-aborted
 * check — so an operation abandoned by an already-aborted signal never
 * surfaces as an unhandled rejection. Exported for deterministic budget tests
 * only.
 * @template T
 * @param {Promise<T>} operation
 * @param {AbortSignal} signal
 * @returns {Promise<T>}
 */
export function raceAbort(operation, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    // An operation abandoned by an already-aborted signal must never surface
    // its late rejection as an unhandled rejection; the raced path below
    // attaches its own handlers.
    operation.catch(() => {});
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

/**
 * A mutating receipt operation — a publication or settlement write, or a
 * prune unlink — is raced against the abort budget only at this outer
 * boundary, on the promise whose settlement also releases the epoch lock.
 * The caller is rejected at the deadline even while the underlying mutation
 * is still settling, while the passed lock-holding promise — the withFileLock
 * operation result, which settles only after the mutation settles — keeps
 * running so the advisory lock is never released while the mutation's
 * uninterruptible tail (the write's rename phase, or the unlink itself) can
 * still land; a retry that acquired the freed lock could otherwise be
 * overwritten by the timed-out writer — or a recreated receipt deleted by an
 * in-flight unlink — violating first-writer-wins and the settlement CAS. The
 * unconditional no-op catch absorbs that abandoned promise's late rejection —
 * a mutation that fails after the caller was already rejected — so it never
 * surfaces as an unhandled rejection. Exported for deterministic budget
 * tests only.
 * @template T
 * @param {Promise<T>} held The lock-holding promise; it must settle only after the mutation settles.
 * @param {AbortSignal} signal
 * @returns {Promise<T>} The caller-facing deadline view.
 */
export function raceAbortHeldWrite(held, signal) {
  held.catch(() => {});
  return raceAbort(held, signal);
}

/**
 * @param {{ dataRoot: string, now?: () => string, testOnlyAfterStorageValidation?: () => void|Promise<void>, testOnlyReceiptsDirectoryMaxEntries?: number, testOnlyPruneScanBudgetMs?: number }} options
 * The test-only seams are deterministic: the hook fires after storage
 * validation and before lock acquisition, and the entry ceiling may only be
 * lowered for tests. Production callers must omit both.
 */
export function createHostLifecycleStore(options) {
  const valid = options !== null && typeof options === 'object' && !Array.isArray(options)
    && [Object.prototype, null].includes(Object.getPrototypeOf(options))
    && Object.keys(options).every((key) => ['dataRoot', 'now', 'testOnlyAfterStorageValidation', 'testOnlyReceiptsDirectoryMaxEntries', 'testOnlyPruneScanBudgetMs'].includes(key));
  const dataRoot = valid ? options.dataRoot : undefined;
  if (typeof dataRoot !== 'string' || dataRoot.length === 0) {
    throw new PluginError('DATA_ROOT_REQUIRED', 'A plugin data root must be provided explicitly.', {
      category: 'configuration',
      remedy: 'Pass the installed plugin data directory as dataRoot.',
    });
  }
  const now = options.now ?? (() => new Date().toISOString());
  if (typeof now !== 'function') throw new PluginError('LIFECYCLE_INPUT_INVALID', 'The now clock must be a function returning an RFC3339 timestamp.');
  const afterStorageValidation = options.testOnlyAfterStorageValidation ?? (async () => {});
  if (typeof afterStorageValidation !== 'function') throw new TypeError('testOnlyAfterStorageValidation must be a function');
  const receiptsDirectoryMaxEntries = options.testOnlyReceiptsDirectoryMaxEntries ?? RECEIPTS_DIRECTORY_MAX_ENTRIES;
  if (receiptsDirectoryMaxEntries !== RECEIPTS_DIRECTORY_MAX_ENTRIES
    && (!Number.isSafeInteger(receiptsDirectoryMaxEntries) || receiptsDirectoryMaxEntries < 1 || receiptsDirectoryMaxEntries > RECEIPTS_DIRECTORY_MAX_ENTRIES)) {
    throw new TypeError('testOnlyReceiptsDirectoryMaxEntries must be a positive safe integer no larger than the production bound');
  }
  const pruneScanBudgetMs = options.testOnlyPruneScanBudgetMs ?? RECEIPT_SCAN_ABORT_BUDGET_MS;
  if (pruneScanBudgetMs !== RECEIPT_SCAN_ABORT_BUDGET_MS
    && (!Number.isSafeInteger(pruneScanBudgetMs) || pruneScanBudgetMs < 1 || pruneScanBudgetMs > RECEIPT_SCAN_ABORT_BUDGET_MS)) {
    throw new TypeError('testOnlyPruneScanBudgetMs must be a positive safe integer no larger than the production bound');
  }

  return Object.freeze({
    /** @param {any} input @param {{ signal?: AbortSignal }} [options] */
    publishSessionEnd: (input, options = {}) => publishReceipt(dataRoot, now, afterStorageValidation, input, options),
    /** @param {string} epoch */
    readReceipt: (epoch) => readReceiptAt(dataRoot, epoch),
    /** @param {{ signal?: AbortSignal }} [options] */
    listPendingReceipts: (options = {}) => listPending(dataRoot, options, receiptsDirectoryMaxEntries),
    /** @param {string} epoch @param {string} expectedUpdatedAt @param {{ signal?: AbortSignal }} [options] */
    settleReceipt: (epoch, expectedUpdatedAt, options = {}) => settleReceipt(dataRoot, now, afterStorageValidation, epoch, expectedUpdatedAt, options),
    pruneSettledReceipts: () => pruneSettled(dataRoot, now, receiptsDirectoryMaxEntries, pruneScanBudgetMs),
  });
}

/**
 * @param {string} dataRoot
 * @param {() => string} now
 * @param {() => void|Promise<void>} afterStorageValidation
 * @param {any} input
 * @param {{ signal?: AbortSignal }} options
 */
async function publishReceipt(dataRoot, now, afterStorageValidation, input, options) {
  const signal = budgetSignal(options);
  signal.throwIfAborted();
  await validatePublicationInput(input, signal);
  const clock = validatedClock(now);
  const epoch = hostLifecycleEpoch(input.sessionId, input.sessionStartedAt);
  const epochPath = receiptPath(dataRoot, epoch);
  const storage = await ensureReceiptStorage(dataRoot, signal);
  await afterStorageValidation();
  // The operation awaits the write directly, so the epoch lock is released
  // only after the write settles; the caller view is raced against the abort
  // budget at this outer boundary instead.
  const held = withReceiptLock(storage, epochPath.lockPath, async () => {
    const existing = await readReceiptFile(dataRoot, epochPath.filePath, epoch);
    const hints = existing === null
      ? canonicalWorkspaceHints(input.workspaceHints ?? [])
      : mergeWorkspaceHints(existing.workspaceHints, input.workspaceHints ?? []);
    if (existing !== null && sameCanonicalHintList(existing.workspaceHints, hints)) return withPath(existing, epochPath.filePath);
    const updatedAt = existing === null ? clock : nextMonotonicTimestamp(clock, existing.updatedAt);
    const receipt = existing === null
      ? {
        version: RECEIPT_VERSION,
        kind: RECEIPT_KIND,
        sessionId: input.sessionId,
        sessionStartedAt: input.sessionStartedAt,
        endedAt: input.endedAt,
        epoch,
        origin: input.origin,
        workspaceHints: hints,
        state: 'pending',
        publishedAt: updatedAt,
        updatedAt,
      }
      : {
        ...existing,
        workspaceHints: hints,
        updatedAt,
        // A hint merge on a settled receipt advances only the CAS token: the
        // original settledAt is preserved so retention keeps running from the
        // original settlement, within the validated invariant
        // publishedAt <= settledAt <= updatedAt.
      };
    await atomicWriteJson(epochPath.filePath, receipt, { signal, privateRoot: dataRoot });
    return withPath(receipt, epochPath.filePath);
  }, signal);
  return raceAbortHeldWrite(held, signal);
}

/** @param {string} dataRoot @param {string} epoch */
async function readReceiptAt(dataRoot, epoch) {
  const epochPath = receiptPath(dataRoot, epoch);
  // Every existing segment between the data root and the receipts directory
  // is validated before any read: a symlinked intermediate redirecting the
  // namespace — even back inside the data root — must fail closed.
  await validateReceiptsParentChain(dataRoot, dirname(epochPath.filePath));
  const receipt = await readReceiptFile(dataRoot, epochPath.filePath, epoch);
  return receipt === null ? null : withPath(receipt, epochPath.filePath);
}

/** @param {string} dataRoot @param {{ signal?: AbortSignal }} options @param {number} maxEntries */
async function listPending(dataRoot, options, maxEntries) {
  const signal = budgetSignal(options, RECEIPT_SCAN_ABORT_BUDGET_MS);
  signal.throwIfAborted();
  const receipts = await readAllReceipts(dataRoot, signal, { maxEntries });
  return receipts.filter((entry) => entry.receipt.state === 'pending')
    .map((entry) => withPath(entry.receipt, entry.path))
    .sort((left, right) => left.epoch.localeCompare(right.epoch));
}

/** @param {string} dataRoot @param {() => string} now @param {() => void|Promise<void>} afterStorageValidation @param {string} epoch @param {string} expectedUpdatedAt @param {{ signal?: AbortSignal }} [options] */
async function settleReceipt(dataRoot, now, afterStorageValidation, epoch, expectedUpdatedAt, options = {}) {
  validateEpoch(epoch);
  validateTimestamp(expectedUpdatedAt, 'expectedUpdatedAt');
  const clock = validatedClock(now);
  const epochPath = receiptPath(dataRoot, epoch);
  const signal = budgetSignal(options);
  const storage = await ensureReceiptStorage(dataRoot, signal);
  await afterStorageValidation();
  // Same decoupling as publication: the operation awaits the write so the
  // epoch lock outlives it, and the caller is raced at the outer boundary.
  const held = withReceiptLock(storage, epochPath.lockPath, async () => {
    const existing = await readReceiptFile(dataRoot, epochPath.filePath, epoch);
    if (existing === null) throw receiptNotFound(epoch);
    if (existing.updatedAt !== expectedUpdatedAt) {
      throw new PluginError('RECEIPT_STALE', 'The receipt changed before it could be settled.', {
        category: 'storage',
        remedy: 'Re-read the receipt and retry settlement against its current updatedAt.',
        details: { epoch },
      });
    }
    if (existing.state === 'settled') return withPath(existing, epochPath.filePath);
    const settledAt = nextMonotonicTimestamp(clock, existing.updatedAt);
    const receipt = { ...existing, state: 'settled', settledAt, updatedAt: settledAt };
    await atomicWriteJson(epochPath.filePath, receipt, { signal, privateRoot: dataRoot });
    return withPath(receipt, epochPath.filePath);
  }, signal);
  return raceAbortHeldWrite(held, signal);
}

/**
 * Prunes under each receipt's persistent advisory lock: the record is re-read
 * and revalidated as the exact selected settled winner before deletion, a
 * contended or concurrently removed receipt is tolerated and skipped, and the
 * remaining cleanup continues. Each file's loop view is bounded by its abort
 * budget combined with the scan-level deadline — so the whole deletion loop
 * stays inside the scan bound instead of summing N per-file waits — but its
 * lock-holding operation outlives that budget until the unlink settles, so an
 * in-flight unlink can never delete a receipt a concurrent publication
 * recreated after a freed lock. The returned count is
 * stable by construction: every started deletion settles (bounded by the
 * scan-level budget) before the count is reported, and once that bound
 * expires the count is frozen, so the returned number always equals exactly
 * the deletions settled by the time the caller observes the result.
 * @param {string} dataRoot @param {() => string} now @param {number} maxEntries @param {number} [scanBudgetMs]
 */
async function pruneSettled(dataRoot, now, maxEntries, scanBudgetMs = RECEIPT_SCAN_ABORT_BUDGET_MS) {
  const scanSignal = budgetSignal({}, scanBudgetMs);
  const entries = await readAllReceipts(dataRoot, scanSignal, { tolerateExcess: true, maxEntries });
  const settled = entries.filter((entry) => entry.receipt.state === 'settled')
    .sort((left, right) => left.receipt.settledAt.localeCompare(right.receipt.settledAt) || left.receipt.epoch.localeCompare(right.receipt.epoch));
  const cutoff = new Date(Date.parse(now()) - RECEIPT_RETENTION_MS).toISOString();
  const removable = settled.filter((entry, index) => index < settled.length - RECEIPT_MAX_SETTLED || entry.receipt.settledAt < cutoff);
  if (removable.length === 0) return { pruned: 0 };
  const storage = await ensureReceiptStorage(dataRoot, scanSignal);
  /** @type {Promise<void>[]} */
  const heldDeletions = [];
  let pruned = 0;
  let countsFrozen = false;
  for (const entry of removable) {
    // The per-file budget yields to the scan-level deadline too, so N
    // contended receipts cannot stretch the deletion loop to N per-file waits
    // beyond the advertised scan bound: once the scan deadline fires, the
    // in-flight file cuts short and later files fail fast at acquisition.
    const fileSignal = AbortSignal.any([AbortSignal.timeout(RECEIPT_ABORT_BUDGET_MS), scanSignal]);
    try {
      // Same discipline as the publication and settlement writes: the
      // operation awaits the unlink directly, so the epoch lock is released
      // only after the unlink settles — an in-flight unlink can never delete
      // a receipt a concurrent publication recreated after a freed lock —
      // while this loop's per-file view rejects at the deadline and the
      // abandoned lock promise's late rejection is absorbed.
      const held = withReceiptLock(storage, receiptPath(dataRoot, entry.receipt.epoch).lockPath, async () => {
        // The re-read is raced against the per-file budget; an abandoned
        // read is pure observation, so abandoning it is safe — the deletion
        // below only runs on a fully resolved re-read.
        const current = await raceAbort(readReceiptFile(dataRoot, entry.path, entry.receipt.epoch), fileSignal);
        if (current === null || current.state !== 'settled'
          || current.settledAt !== entry.receipt.settledAt || current.updatedAt !== entry.receipt.updatedAt) return;
        try {
          await unlink(entry.path);
        } catch (error) {
          if (isNodeErrorCode(error, 'ENOENT')) return;
          throw error;
        }
        // Counted at settlement inside the lock operation, and only while
        // counting is live: once the scan-level bound has frozen the count,
        // later completions must not mutate the number the caller observed.
        if (!countsFrozen) pruned += 1;
      }, fileSignal);
      heldDeletions.push(held);
      await raceAbortHeldWrite(held, fileSignal);
    } catch (error) {
      if (!fileSignal.aborted && !(error instanceof PluginError && error.code === 'LOCK_TIMEOUT')) throw error;
    }
  }
  // Every started deletion settles before the count is reported, bounded by
  // the scan-level budget; when that bound expires first, the count freezes
  // and deletions completing after the snapshot are excluded.
  await raceAbort(Promise.allSettled(heldDeletions), scanSignal).catch(() => { countsFrozen = true; });
  countsFrozen = true;
  return { pruned };
}

/**
 * @param {string} dataRoot
 * @param {AbortSignal} signal
 * @param {{ tolerateExcess?: boolean, maxEntries?: number }} [options] Pruning passes tolerateExcess so an above-ceiling directory still prunes down instead of blocking its own recovery; reads keep enforcing the ceiling. maxEntries defaults to the production hard entry ceiling and may only be lowered through the test-only factory option.
 */
async function readAllReceipts(dataRoot, signal, options = {}) {
  const receiptsRoot = join(dataRoot, 'host-lifecycle', 'receipts');
  // Every existing segment between the data root and the receipts directory
  // is validated before any scan: a symlinked intermediate redirecting the
  // namespace — even back inside the data root — must fail closed instead of
  // honoring redirected receipt authority.
  await raceAbort(validateReceiptsParentChain(dataRoot, receiptsRoot), signal);
  let entries;
  try {
    entries = await enumerateReceiptsDirectory(dataRoot, receiptsRoot, signal, options.maxEntries ?? RECEIPTS_DIRECTORY_MAX_ENTRIES);
  } catch (error) {
    // The parent chain was just validated, so ENOENT can only mean the
    // receipts namespace is genuinely absent.
    if (isNodeErrorCode(error, 'ENOENT')) return [];
    throw error;
  }
  signal.throwIfAborted();
  const loaded = [];
  let settledSeen = 0;
  for (const entry of entries) {
    signal.throwIfAborted();
    // Only digest-shaped receipt filenames are ever parsed, so a malformed or
    // stray file outside the bounded naming scheme cannot block enumeration;
    // correctly-named files keep failing closed when their content is corrupt.
    if (!entry.isFile() || !RECEIPT_FILE_NAME_PATTERN.test(entry.name)) continue;
    const path = join(receiptsRoot, entry.name);
    // Each per-file read is raced against the scan budget like every other
    // await, so a stalled bounded read cannot outlive the abort deadline.
    const receipt = await raceAbort(readReceiptFile(dataRoot, path), signal);
    if (receipt === null || entry.name !== receiptFileName(receipt.epoch)) continue;
    loaded.push({ path, receipt });
    // Pending receipts are durable compensation authority and must stay
    // discoverable at any count, bounded only by the hard entry ceiling and
    // the scan budget. Settled records fail closed the moment the ceiling is
    // crossed — while receipts are still loading — so loading never retains a
    // parse buffer beyond the crossing, and pruning (which tolerates excess)
    // drains settled overflow so the directory recovers.
    if (receipt.state === 'settled') {
      settledSeen += 1;
      if (options.tolerateExcess !== true && settledSeen > RECEIPTS_MAX_RECEIPT_FILES) {
        throw new PluginError('RECEIPTS_DIRECTORY_EXHAUSTED', `The receipts directory exceeds its bounded settled receipt count: ${receiptsRoot}`, {
          category: 'storage',
          remedy: 'Inspect the plugin data root for runaway settled receipt accumulation; pruning removes the excess settled records.',
          details: { path: receiptsRoot, settledReceipts: settledSeen },
        });
      }
    }
  }
  signal.throwIfAborted();
  return loaded.filter((entry) => entry.receipt !== null);
}

/**
 * Enumerates the receipts directory with the same containment and identity
 * discipline as the shared private-directory reader, but every await — the
 * identity stats, the directory open, and each iterator step — is raced
 * against the abort signal (rechecked before each step) so a ceiling-scale
 * enumeration stays abortable mid-scan and no single stalled filesystem await
 * can outlive the scan budget.
 * @param {string} dataRoot @param {string} receiptsRoot @param {AbortSignal} signal @param {number} maxEntries
 */
async function enumerateReceiptsDirectory(dataRoot, receiptsRoot, signal, maxEntries) {
  const { rootPath, targetPath } = containedReceiptsPath(dataRoot, receiptsRoot);
  signal.throwIfAborted();
  const before = await raceAbort(safeReceiptsDirectoryStats(rootPath, targetPath), signal);
  let directory;
  const entries = [];
  try {
    signal.throwIfAborted();
    const opened = opendir(targetPath);
    const racedOpen = raceAbort(opened, signal);
    // If the deadline wins the open race, the abandoned open still resolves
    // to a handle nobody else holds; close it as soon as it arrives.
    racedOpen.catch(() => { opened.then((abandoned) => { abandoned.close().catch(() => {}); }, () => {}); });
    directory = await racedOpen;
    const iterator = directory[Symbol.asyncIterator]();
    for (;;) {
      signal.throwIfAborted();
      const step = await raceAbort(iterator.next(), signal);
      if (step.done) break;
      entries.push(step.value);
      if (entries.length > maxEntries) throw unsafeReceiptsPath(targetPath);
    }
  } finally {
    if (directory !== undefined) {
      // The close is bounded by the same budget and fully absorbed: a
      // completed iterator has already auto-closed the handle, and once the
      // deadline has won the handle is abandoned anyway — so neither a close
      // rejection nor the race rejection may replace the enumeration result.
      const closed = directory.close();
      closed.catch(() => {});
      await raceAbort(closed, signal).catch(() => {});
    }
  }
  signal.throwIfAborted();
  const after = await raceAbort(safeReceiptsDirectoryStats(rootPath, targetPath), signal);
  if (before.dev !== after.dev || before.ino !== after.ino) throw unsafeReceiptsPath(targetPath);
  return entries;
}

/** @param {string} dataRoot @param {string} receiptsRoot */
function containedReceiptsPath(dataRoot, receiptsRoot) {
  const rootPath = resolve(dataRoot);
  const targetPath = resolve(receiptsRoot);
  if (!pathIsWithinDir(rootPath, targetPath)) throw unsafeReceiptsPath(targetPath);
  return { rootPath, targetPath };
}

/** @param {string} rootPath @param {string} targetPath */
async function safeReceiptsDirectoryStats(rootPath, targetPath) {
  const [rootStats, targetStats] = await Promise.all([lstat(rootPath), lstat(targetPath)]);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()
    || targetStats.isSymbolicLink() || !targetStats.isDirectory()) throw unsafeReceiptsPath(targetPath);
  const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(rootPath), realpath(targetPath)]);
  if (!pathIsWithinDir(canonicalRoot, canonicalTarget)) throw unsafeReceiptsPath(targetPath);
  return targetStats;
}

/** @param {string} root @param {string} path */
function pathIsWithinDir(root, path) {
  const descendant = relative(root, path);
  return descendant === '' || descendant !== '..' && !descendant.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(descendant);
}

/** @param {string} path */
function unsafeReceiptsPath(path) {
  return new PluginError('PRIVATE_PATH_UNSAFE', `Private state path is a symbolic link, outside its root, or has an unsafe type: ${path}`, {
    category: 'storage',
    remedy: 'Repair the private state path before retrying.',
    details: { path },
  });
}

/** @param {string} dataRoot @param {string} epoch */
function receiptPath(dataRoot, epoch) {
  validateEpoch(epoch);
  const digest = createHash('sha256').update(epoch).digest('hex');
  const receiptsRoot = join(dataRoot, 'host-lifecycle', 'receipts');
  return { filePath: join(receiptsRoot, `${digest}.json`), lockPath: join(receiptsRoot, `${digest}.lock`) };
}

/** Only a file named for the digest of its validated epoch is reachable, so duplicate or mismatched paths stay inert. @param {string} epoch */
function receiptFileName(epoch) {
  return `${createHash('sha256').update(epoch).digest('hex')}.json`;
}

/**
 * Validates and creates the receipt directory layout without symlink
 * traversal before any lock is taken, mirroring the StateStore pattern, and
 * captures the validated directory's dev/ino identity so lock acquisition can
 * re-verify that the same directory is still in place. A hostile symlinked
 * ancestor fails before withFileLock's layout creation could create or chmod
 * anything outside the private root. Setup itself is abort-aware: the caller's
 * budget signal is checked before and after each stage.
 * @param {string} dataRoot
 * @param {AbortSignal} signal
 * @returns {Promise<{ receiptsRoot: string, identity: { dev: number, ino: number } }>}
 */
async function ensureReceiptStorage(dataRoot, signal) {
  signal.throwIfAborted();
  await raceAbort(validateDataRoot(dataRoot), signal);
  await raceAbort(ensurePrivateDirectory(dataRoot), signal);
  signal.throwIfAborted();
  const receiptsRoot = join(dataRoot, 'host-lifecycle', 'receipts');
  await raceAbort(ensurePrivateDirectoryWithin(dataRoot, receiptsRoot), signal);
  signal.throwIfAborted();
  const { rootPath, targetPath } = containedReceiptsPath(dataRoot, receiptsRoot);
  const stats = await raceAbort(safeReceiptsDirectoryStats(rootPath, targetPath), signal);
  return { receiptsRoot, identity: { dev: stats.dev, ino: stats.ino } };
}

/**
 * Every component of the data root is inspected top-down with lstat: an
 * existing component must be a real directory, a symlink is tolerated only
 * above the first real component of the data root's own path —
 * system-provided hierarchy symlinks such as /var on macOS, which resolve
 * into real directories before any meaningful component — and any symlink at
 * or below that first real component, any non-directory component, or any
 * absent component not preceded by a real directory fails closed. Only an
 * absent tail below a validated real directory may later be created, so a
 * missing root cannot be created through a symlinked ancestor hop outside the
 * intended namespace, and an existing symlinked root fails before
 * ensurePrivateDirectory could chmod its target.
 * @param {string} dataRoot
 */
async function validateDataRoot(dataRoot) {
  /** @type {string[]} */
  const prefixes = [];
  for (let current = resolve(dataRoot);;) {
    prefixes.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // The filesystem root itself cannot be a symlink, so the anchor search
  // starts with the data root's own first component.
  let anchored = false;
  for (let index = 1; index < prefixes.length; index += 1) {
    const prefix = prefixes[index];
    let stats;
    try {
      stats = await lstat(prefix);
    } catch (error) {
      if (!isNodeErrorCode(error, 'ENOENT')) throw error;
      // An absent component is a creatable tail only below an already
      // validated real directory; below an unanchored symlink chain the
      // namespace fails closed instead.
      if (!anchored) throw unsafeReceiptsPath(prefix);
      return;
    }
    if (stats.isSymbolicLink()) {
      if (anchored) throw unsafeReceiptsPath(prefix);
      continue;
    }
    if (!stats.isDirectory()) throw unsafeReceiptsPath(prefix);
    anchored = true;
  }
  if (!anchored) throw unsafeReceiptsPath(prefixes[prefixes.length - 1]);
}

/**
 * The ENOENT-to-absence translation is legal only when every existing
 * component between the data root and the receipts directory — the data root
 * itself, the host-lifecycle directory, and the receipts directory — is a
 * real directory reached without a symlink hop: an unsafe intermediate
 * component must fail closed instead of masquerading as an absent (and
 * therefore empty) receipt namespace.
 * @param {string} dataRoot @param {string} receiptsRoot
 */
async function validateReceiptsParentChain(dataRoot, receiptsRoot) {
  await validateDataRoot(dataRoot);
  const segments = relative(dataRoot, receiptsRoot).split(sep).filter((segment) => segment !== '');
  let current = dataRoot;
  for (const segment of segments) {
    current = join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (!isNodeErrorCode(error, 'ENOENT')) throw error;
      // A missing component here means the receipts namespace itself is
      // absent — no deeper component can exist — which is the one legal
      // absence translation.
      return;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw unsafeReceiptsPath(current);
  }
}

/**
 * Acquires the epoch's advisory lock with no recursive layout creation: the
 * captured receipts-root identity is re-verified immediately before and after
 * the contained lock layout creation, the created lock directory must sit on
 * the validated root's device, and withFileLock runs with createLayout
 * disabled so nothing outside the validated root is ever created or chmodded
 * by the lock machinery. A same-UID attacker racing the identity checks
 * remains within the repo's existing same-UID trust assumptions.
 * @template T
 * @param {{ receiptsRoot: string, identity: { dev: number, ino: number } }} storage
 * @param {string} lockPath
 * @param {() => Promise<T>} operation
 * @param {AbortSignal} signal
 * @returns {Promise<T>}
 */
async function withReceiptLock(storage, lockPath, operation, signal) {
  signal.throwIfAborted();
  // Lock setup's filesystem awaits are raced against the abort budget too, so
  // slow identity checks or layout creation cannot stall past the deadline
  // before the signal-aware withFileLock acquisition begins.
  await raceAbort(assertReceiptsRootIdentity(storage), signal);
  await raceAbort(ensureReceiptLockLayout(storage.receiptsRoot, lockPath), signal);
  const lockStats = await raceAbort(lstat(lockPath), signal);
  if (lockStats.isSymbolicLink() || !lockStats.isDirectory() || lockStats.dev !== storage.identity.dev) {
    throw unsafeReceiptsPath(lockPath);
  }
  await raceAbort(assertReceiptsRootIdentity(storage), signal);
  return withFileLock(lockPath, operation, { signal, timeoutMs: RECEIPT_ABORT_BUDGET_MS, createLayout: false });
}

/** @param {{ receiptsRoot: string, identity: { dev: number, ino: number } }} storage */
async function assertReceiptsRootIdentity(storage) {
  const stats = await lstat(storage.receiptsRoot);
  if (stats.isSymbolicLink() || !stats.isDirectory()
    || stats.dev !== storage.identity.dev || stats.ino !== storage.identity.ino) {
    throw unsafeReceiptsPath(storage.receiptsRoot);
  }
}

/**
 * Creates the epoch's advisory lock layout with contained temp-plus-rename
 * publication inside the validated receipts root; a concurrent creator that
 * wins the rename is tolerated because the layout already exists.
 * @param {string} receiptsRoot @param {string} lockPath
 */
async function ensureReceiptLockLayout(receiptsRoot, lockPath) {
  try {
    await lstat(join(lockPath, 'advisory.lock'));
    return;
  } catch (error) {
    if (!isNodeErrorCode(error, 'ENOENT')) throw error;
  }
  const temporaryPath = join(receiptsRoot, `.${basename(lockPath)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`);
  let handle;
  try {
    await mkdir(temporaryPath, { mode: 0o700 });
    handle = await open(join(temporaryPath, 'advisory.lock'), 'wx', 0o600);
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, lockPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporaryPath, { recursive: true, force: true }).catch(() => {});
    if (isLockPublishCollision(error)) return;
    throw error;
  } finally {
    await rm(temporaryPath, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Reads one receipt file, translating malformed JSON into the bounded corrupt
 * error while preserving storage-safety errors, and rejecting a receipt whose
 * embedded epoch does not match the epoch the caller resolved this path for.
 * @param {string} dataRoot @param {string} path @param {string} [expectedEpoch]
 */
async function readReceiptFile(dataRoot, path, expectedEpoch) {
  let parsed;
  try {
    parsed = await readBoundedJsonFile(dataRoot, path, RECEIPT_MAX_BYTES, { requirePrivatePermissions: true });
  } catch (error) {
    // Absence is translated only by callers that validated the full parent
    // chain at their entry, so a symlinked intermediate never masquerades as
    // a missing receipt here.
    if (isNodeErrorCode(error, 'ENOENT')) return null;
    if (error instanceof SyntaxError) throw corruptReceipt(path);
    throw error;
  }
  const receipt = validateReceipt(parsed, path);
  if (receipt !== null && expectedEpoch !== undefined && receipt.epoch !== expectedEpoch) throw corruptReceipt(path);
  return receipt;
}

/** @param {string} path */
function corruptReceipt(path) {
  return new PluginError('RECEIPT_CORRUPT', `A persisted host lifecycle receipt is invalid: ${path}`, {
    category: 'storage',
    remedy: 'Restore or remove the corrupted receipt record.',
    details: { path },
  });
}

/** @param {any} value @param {string} path */
function validateReceipt(value, path) {
  const corrupt = () => corruptReceipt(path);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw corrupt();
  const keys = Object.keys(value);
  const baseKeys = ['endedAt', 'epoch', 'kind', 'origin', 'publishedAt', 'sessionId', 'sessionStartedAt', 'state', 'updatedAt', 'version', 'workspaceHints'];
  if (value.state === 'settled') baseKeys.push('settledAt');
  const sameKeys = keys.length === baseKeys.length && keys.every((key) => baseKeys.includes(key));
  if (!sameKeys || value.version !== RECEIPT_VERSION || value.kind !== RECEIPT_KIND
    || !RECEIPT_STATES.includes(value.state) || !RECEIPT_ORIGINS.includes(value.origin)) throw corrupt();
  try {
    hostLifecycleEpoch(value.sessionId, value.sessionStartedAt);
    validateTimestamp(value.endedAt, 'endedAt');
    validateTimestamp(value.publishedAt, 'publishedAt');
    validateTimestamp(value.updatedAt, 'updatedAt');
    if (value.state === 'settled') validateTimestamp(value.settledAt, 'settledAt');
    if (Date.parse(value.endedAt) < Date.parse(value.sessionStartedAt)) throw corrupt();
    if (Date.parse(value.updatedAt) < Date.parse(value.publishedAt)) throw corrupt();
    if (value.state === 'settled' && (Date.parse(value.settledAt) < Date.parse(value.publishedAt) || Date.parse(value.settledAt) > Date.parse(value.updatedAt))) throw corrupt();
    if (value.epoch !== hostLifecycleEpoch(value.sessionId, value.sessionStartedAt)) throw corrupt();
    const persistedHints = value.workspaceHints;
    if (!Array.isArray(persistedHints) || persistedHints.length > RECEIPT_MAX_WORKSPACE_HINTS
      || persistedHints.some((hint) => !isCanonicalWorkspaceHint(hint))
      || !alreadyCanonicalHints(persistedHints)) throw corrupt();
  } catch (error) {
    if (error instanceof PluginError && error.code === 'LIFECYCLE_INPUT_INVALID') throw corrupt();
    throw error;
  }
  return value;
}

/**
 * Input validation shares the publication deadline: the abort signal is
 * established first and rechecked between validation phases, and the raw
 * hints array is hard-capped before any traversal or sorting, so neither an
 * oversized duplicate-laden input nor an already-aborted caller can spend the
 * publication budget inside validation.
 * @param {any} input
 * @param {AbortSignal} signal
 */
async function validatePublicationInput(input, signal) {
  signal.throwIfAborted();
  const invalid = () => new PluginError('LIFECYCLE_INPUT_INVALID', 'The SessionEnd publication input is invalid.', {
    category: 'validation',
    remedy: 'Pass exactly sessionId, sessionStartedAt, endedAt, origin, and bounded workspaceHints.',
  });
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid();
  const keys = Object.keys(input);
  if (!keys.every((key) => RECEIPT_INPUT_KEYS.includes(key))) throw invalid();
  for (const required of ['sessionId', 'sessionStartedAt', 'endedAt', 'origin']) {
    if (!keys.includes(required)) throw invalid();
  }
  if (input.workspaceHints !== undefined && !Array.isArray(input.workspaceHints)) throw invalid();
  signal.throwIfAborted();
  validateSessionId(input.sessionId);
  validateTimestamp(input.sessionStartedAt, 'sessionStartedAt');
  validateTimestamp(input.endedAt, 'endedAt');
  if (Date.parse(input.endedAt) < Date.parse(input.sessionStartedAt)) throw invalid();
  if (!RECEIPT_ORIGINS.includes(input.origin)) throw invalid();
  signal.throwIfAborted();
  if (input.workspaceHints !== undefined) {
    // The raw array is hard-capped before any traversal, and each entry must
    // be a canonical hint; the 128 bound then applies to the deduplicated
    // canonical set, so a longer input whose duplicates collapse within the
    // bound is still a publishable SessionEnd receipt.
    if (input.workspaceHints.length > RECEIPT_MAX_RAW_WORKSPACE_HINTS) throw invalid();
    for (const hint of input.workspaceHints) {
      if (!isCanonicalWorkspaceHint(hint)) throw invalid();
    }
    signal.throwIfAborted();
    if (canonicalWorkspaceHints(input.workspaceHints).length > RECEIPT_MAX_WORKSPACE_HINTS) throw invalid();
  }
}

/** @param {readonly string[]} hints */
function canonicalWorkspaceHints(hints) {
  return [...new Set(hints)].sort();
}

/**
 * Existing hints are always retained; only as many new canonical hints as the
 * remaining capacity permits are added, then the selection is re-sorted so the
 * persisted list stays canonical without ever evicting recorded discovery
 * evidence.
 * @param {readonly string[]} existing
 * @param {readonly string[]} incoming
 */
function mergeWorkspaceHints(existing, incoming) {
  const base = canonicalWorkspaceHints(existing);
  const additions = canonicalWorkspaceHints(incoming).filter((hint) => !base.includes(hint));
  const capacity = Math.max(0, RECEIPT_MAX_WORKSPACE_HINTS - base.length);
  return [...base, ...additions.slice(0, capacity)].sort();
}

/** A workspace hint is a nonempty control-free string bounded to 4,096 UTF-8 bytes. @param {unknown} hint */
function isBoundedWorkspaceHint(hint) {
  return typeof hint === 'string' && hint.length > 0 && !hasControl(hint)
    && Buffer.byteLength(hint, 'utf8') <= RECEIPT_WORKSPACE_HINT_MAX_BYTES;
}

/**
 * A workspace hint must be a canonical absolute normalized workspace path:
 * absolute, free of `.`/`..` segments and redundant separators, in the
 * platform-normalized form `resolve` produces.
 * @param {unknown} hint
 */
function isCanonicalWorkspaceHint(hint) {
  if (!isBoundedWorkspaceHint(hint)) return false;
  const path = /** @type {string} */ (hint);
  return isAbsolute(path) && path === resolve(path);
}

/** A persisted hint list must already equal its sorted, deduplicated canonical form. @param {string[]} hints */
function alreadyCanonicalHints(hints) {
  const canonical = [...new Set(hints)].sort();
  return hints.length === canonical.length && hints.every((hint, index) => hint === canonical[index]);
}

/** @param {string[]} left @param {string[]} right */
function sameCanonicalHintList(left, right) {
  return left.length === right.length && left.every((hint, index) => hint === right[index]);
}

/**
 * The settlement token is updatedAt, so it must advance on every mutation even
 * when the wall clock returns the same millisecond: any proposed timestamp not
 * strictly after the previous one is replaced by the previous one plus 1 ms.
 * @param {string} proposed @param {string} previous
 */
function nextMonotonicTimestamp(proposed, previous) {
  return Date.parse(proposed) > Date.parse(previous) ? proposed : new Date(Date.parse(previous) + 1).toISOString();
}

/** @param {unknown} value */
function validateSessionId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 || hasControl(value)) {
    throw new PluginError('LIFECYCLE_INPUT_INVALID', 'A lifecycle session identifier must be a bounded control-free string.', {
      category: 'validation',
      remedy: 'Pass the exact host session identifier.',
    });
  }
}

/**
 * The injected clock is captured exactly once per mutation and validated, and
 * that exact captured value is what gets persisted as publishedAt/updatedAt
 * (and the settlement timestamp): a stateful clock that returns a valid value
 * on its first call and garbage later must never be able to wedge the epoch
 * with a receipt no later read can validate.
 * @param {() => string} now
 */
function validatedClock(now) {
  const clock = now();
  validateTimestamp(clock, 'now');
  return clock;
}

/** @param {unknown} value @param {string} field */
function validateTimestamp(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new PluginError('LIFECYCLE_INPUT_INVALID', `The lifecycle timestamp ${field} must be an exact RFC3339 millisecond timestamp.`, {
      category: 'validation',
      remedy: `Pass ${field} as new Date(...).toISOString().`,
    });
  }
}

/** @param {unknown} value */
function validateEpoch(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new PluginError('LIFECYCLE_INPUT_INVALID', 'A lifecycle epoch must be a 64-character hex digest.', {
      category: 'validation',
      remedy: 'Pass the epoch returned by hostLifecycleEpoch.',
    });
  }
}

/** The local abort budget is always bounded: a caller signal can tighten it but never remove the local timeout. @param {{ signal?: AbortSignal }} options @param {number} [timeoutMs] */
function budgetSignal(options, timeoutMs = RECEIPT_ABORT_BUDGET_MS) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
}

/** @param {unknown} error @param {string} code */
function isNodeErrorCode(error, code) {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** @param {string} epoch */
function receiptNotFound(epoch) {
  return new PluginError('RECEIPT_NOT_FOUND', `No host lifecycle receipt exists for epoch ${epoch}.`, {
    category: 'storage',
    remedy: 'Publish the SessionEnd receipt before settling it.',
    details: { epoch },
  });
}

/** @param {any} receipt @param {string} path */
function withPath(receipt, path) {
  return { ...receipt, path };
}
