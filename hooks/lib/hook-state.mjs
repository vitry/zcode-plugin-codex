// @ts-nocheck
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, open, readlink, readdir, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { atomicWriteJson, ensurePrivateDirectory, readBoundedJsonFile, readJsonFile, readPrivateDirectory, withFileLock } from '../../scripts/lib/fs.mjs';
import { PluginError } from '../../scripts/lib/errors.mjs';
import { createHostLifecycleStore, hostLifecycleEpoch } from '../../scripts/lib/host-lifecycle.mjs';
import { createIdentityStore, PERMISSION_MODES } from '../../scripts/lib/identity.mjs';
import { RESCUE_UNREAD_JOB_LIMIT } from '../../scripts/lib/rescue-launcher-command.mjs';
import { resolveWorkspaceStorage } from '../../scripts/lib/workspace.mjs';

const exec = promisify(execFile);
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const MAX_UNTRACKED_FILES = 10_000;
const MAX_UNTRACKED_BYTES = 256 * 1024 * 1024;
const MAX_SYMLINK_TARGET_BYTES = 64 * 1024;
const EXECUTOR_LIFETIME_MS = 30 * 60_000;
const MAX_EXECUTOR_BYTES = 16 * 1024;
const MAX_EXECUTOR_ROUTE_BYTES = 16 * 1024;
const MAX_HOOK_STATE_RECORDS = 2_048;
const FORWARDING_PENDING_LIFETIME_MS = 30_000;
const EXECUTOR_KEYS = ['active', 'agentId', 'agentType', 'childTurnId', 'createdAt', 'kind', 'originWorkspace', 'parentGenerationId', 'parentPermissionMode', 'parentSessionId', 'parentTurnId', 'workspace'];
const LEGACY_EXECUTOR_KEYS = ['active', 'agentId', 'agentType', 'childTurnId', 'createdAt', 'kind', 'parentPermissionMode', 'parentSessionId', 'parentTurnId', 'workspace'];
const EXECUTOR_ROUTE_KEYS = ['agentId', 'agentType', 'childTurnId', 'createdAt', 'kind', 'originWorkspace', 'parentGenerationId', 'parentPermissionMode', 'parentSessionId', 'parentTurnId', 'state', 'targetWorkspace', 'updatedAt', 'version'];
const FORWARDING_KEYS = ['active', 'agentId', 'generationId', 'kind', 'sessionId', 'targetWorkspace', 'turnId', 'updatedAt'];
const LEGACY_FORWARDING_KEYS = ['active', 'agentId', 'kind', 'sessionId', 'turnId', 'updatedAt'];

async function paths(dataRoot, workspace) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const directory = join(storage.directory, 'hook-state');
  await ensurePrivateDirectory(directory); return { ...storage, directory, lock: join(directory, '.lock') };
}
async function readOnlyPaths(dataRoot, workspace) {
  const workspacePath = await realpath(resolve(workspace)); const workspaceKey = createHash('sha256').update(workspacePath).digest('hex');
  let dataRootPath;
  try { dataRootPath = await realpath(resolve(dataRoot)); } catch (error) { if (error?.code === 'ENOENT') return { workspacePath, workspaceKey, existing: false }; throw error; }
  const workspacesDirectory = join(dataRootPath, 'workspaces'); const directory = join(workspacesDirectory, workspaceKey); const hookState = join(directory, 'hook-state'); const lock = join(hookState, '.lock');
  for (const path of [dataRootPath, workspacesDirectory, directory, hookState]) {
    try { await validateExistingDirectory(path); }
    catch (error) { if (error?.code === 'ENOENT') return { dataRootPath, directory, workspaceKey, workspacePath, lock, existing: false }; throw error; }
  }
  try {
    await validateExistingDirectory(lock);
    const lockFile = join(lock, 'advisory.lock'); const lockStats = await lstat(lockFile);
    if (lockStats.isSymbolicLink() || !lockStats.isFile() || await realpath(lockFile) !== lockFile) throw new Error('unsafe private lock file');
  } catch (cause) { throw executorError('EXECUTOR_ROUTE_INVALID', 'The private hook-state lock layout is invalid.', cause); }
  return { dataRootPath, directory: hookState, workspaceKey, workspacePath, lock, existing: true };
}
async function validateExistingDirectory(path) {
  const stats = await lstat(path); if (stats.isSymbolicLink() || !stats.isDirectory() || await realpath(path) !== path
    || process.platform !== 'win32' && (stats.mode & 0o777) !== 0o700) throw new Error('unsafe private directory');
}
function key(...values) { return createHash('sha256').update(JSON.stringify(values)).digest('hex'); }

export async function fingerprintWorkspace(workspace) {
  const result = await exec('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: workspace, encoding: 'buffer', timeout: 8_000, maxBuffer: 4 * 1024 * 1024, shell: false });
  let hasHead = true; try { await exec('git', ['rev-parse', '--verify', 'HEAD'], { cwd: workspace, timeout: 2_000, maxBuffer: 64 * 1024, shell: false }); } catch { hasHead = false; }
  const diffArgs = hasHead ? [['diff', '--no-ext-diff', '--binary', 'HEAD', '--']] : [['diff', '--no-ext-diff', '--binary', '--cached', '--'], ['diff', '--no-ext-diff', '--binary', '--']];
  const diffs = await Promise.all(diffArgs.map((args) => exec('git', args, { cwd: workspace, encoding: 'buffer', timeout: 8_000, maxBuffer: 8 * 1024 * 1024, shell: false })));
  const hash = createHash('sha256').update(result.stdout); for (const diff of diffs) hash.update(diff.stdout); const entries = result.stdout.toString('utf8').split('\0').filter((line) => line.startsWith('?? ')).map((line) => line.slice(3)).sort();
  if (entries.length > MAX_UNTRACKED_FILES) throw new Error('Git fingerprint exceeded the untracked file limit.'); let totalBytes = 0;
  for (const relative of entries) { const path = join(workspace, relative); const stat = await lstat(path).catch(() => null); hash.update(JSON.stringify(relative)); if (stat?.isSymbolicLink()) { let target; try { target = await readlink(path, { encoding: 'buffer' }); } catch (error) { hash.update(`symlink-unreadable:${error?.code ?? 'unknown'}:`); continue; } if (target.length > MAX_SYMLINK_TARGET_BYTES) throw new Error('Git fingerprint exceeded the symlink target limit.'); totalBytes += target.length; if (totalBytes > MAX_UNTRACKED_BYTES) throw new Error('Git fingerprint exceeded the untracked byte limit.'); hash.update(`symlink:${stat.mode}:${target.length}:`).update(target); } else if (stat?.isFile()) { totalBytes += stat.size; if (totalBytes > MAX_UNTRACKED_BYTES) throw new Error('Git fingerprint exceeded the untracked byte limit.'); hash.update(`size:${stat.size}:`); const handle = await open(path, 'r'); try { const buffer = Buffer.alloc(64 * 1024); let position = 0; while (true) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, position); if (!bytesRead) break; position += bytesRead; hash.update(buffer.subarray(0, bytesRead)); if (position > stat.size || totalBytes - stat.size + position > MAX_UNTRACKED_BYTES) throw new Error('Git fingerprint changed beyond its byte limit.'); } } finally { await handle.close(); } } else hash.update(`:${stat?.mode ?? 'missing'}:`); }
  hash.update(`count:${entries.length}`); return hash.digest('hex');
}

export async function recordSession(dataRoot, input) {
  const store = await paths(dataRoot, input.cwd); const id = key('session', input.session_id);
  const recordPath = join(store.directory, `session-${id}.json`); const source = input.source ?? 'startup';
  await withFileLock(store.lock, async () => {
    if (source === 'compact') {
      try {
        const existing = await readJsonFile(recordPath);
        if (existing.kind === 'session' && existing.sessionId === input.session_id && existing.workspace === store.workspacePath
          && ['startup', 'resume', 'clear'].includes(existing.source) && Number.isFinite(Date.parse(existing.createdAt))) return;
      } catch (error) { if (error?.cause?.code !== 'ENOENT') throw error; }
    } else if (source === 'resume') {
      // Resume after SessionEnd: BEFORE publishing the new epoch record, atomically
      // read the previous record under this same lock and synthesize a LOCAL
      // resume-compensation receipt when that epoch closed with nonterminal owned
      // jobs and no SessionEnd receipt. Strictly local — no broker, no ZCode call,
      // no remote settlement wait — and bounded by RESUME_COMPENSATION_BUDGET_MS.
      // A FAILED compensation leaves the previous record in place AND fails the
      // SessionStart loudly: the epoch digest stays recoverable and the stale
      // epoch record is never silently replaced by one that cannot compensate.
      // The next resume re-derives the same epoch and retries.
      const compensatedScope = await compensateUnclosedPreviousEpoch(dataRoot, store, recordPath, input.session_id);
      // The previous epoch's identity ledger may still be alive — SessionEnd
      // defers its destructive cleanup under contention — and an unterminated
      // ledger would reject this resumed session's first caller turn
      // (IDENTITY_SESSION_MISMATCH) forever. Retry the cleanup ONCE here with
      // the previous record's own sessionStartedAt proof: epoch-fenced, so a
      // successor's ledger is never touched. A FAILED retry fails the
      // SessionStart loudly: exiting successfully would leave the host running
      // the ended epoch while its pending receipt is excluded from
      // reconciliation as 'current'.
      const previous = await readJsonFile(recordPath).catch(() => null);
      if (previous?.kind === 'session' && previous.sessionId === input.session_id
        && Number.isFinite(Date.parse(previous.createdAt))) {
        await createIdentityStore({ dataRoot }).cleanupSession(store.workspacePath, input.session_id, {
          sessionStartedAt: previous.createdAt,
          timeoutMs: Math.min(750, RESUME_FENCE_BUDGET_MS),
          signal: AbortSignal.timeout(RESUME_FENCE_BUDGET_MS),
        });
      }
      // FENCE old-epoch reservations before the epoch record is replaced: while
      // each known workspace's job lock is held, the compensation scan reruns —
      // an old child's reservation racing this resume is discovered and
      // compensated durably instead of losing its epoch digest forever.
      // FENCE old-epoch reservations before AND through the epoch record
      // replacement: every known workspace's job lock is acquired NESTED (sorted
      // for a stable order) and stays held while the compensation scan reruns
      // and the new record is written — an old child's reservation racing this
      // resume is either discovered and compensated durably, or blocked until
      // the new epoch is authoritative; it can never slip through unrecorded.
      if (Array.isArray(compensatedScope)) {
        const { resolveWorkspaceStorage } = await import('../../scripts/lib/workspace.mjs');
        const fenceDeadline = Date.now() + RESUME_FENCE_BUDGET_MS;
        const fenceSignal = AbortSignal.timeout(RESUME_FENCE_BUDGET_MS);
        const fenceLockPaths = [];
        for (const fenceWorkspace of compensatedScope) {
          fenceSignal.throwIfAborted();
          const fenceStorage = await resolveWorkspaceStorage({ dataRoot, workspace: fenceWorkspace });
          fenceLockPaths.push(join(fenceStorage.directory, '.state.lock'));
        }
        fenceLockPaths.sort();
        const writeRecordFenced = async (/** @type {number} */ index) => {
          if (index >= fenceLockPaths.length) {
            // Under the full fence the final scan is authoritative: any old-
            // epoch obligation it finds gains a durable receipt, and no further
            // old-epoch reservation can arrive while the record is replaced.
            await compensateUnclosedPreviousEpoch(dataRoot, store, recordPath, input.session_id, { signal: fenceSignal, timeoutMs: Math.max(1, Math.min(RESUME_COMPENSATION_BUDGET_MS, fenceDeadline - Date.now())) });
            await atomicWriteJson(recordPath, { kind: 'session', sessionId: input.session_id, workspace: store.workspacePath, source, createdAt: new Date().toISOString() });
            return;
          }
          await withFileLock(fenceLockPaths[index], async () => { await writeRecordFenced(index + 1); }, { signal: fenceSignal, timeoutMs: Math.max(1, Math.min(750, fenceDeadline - Date.now())) });
        };
        await writeRecordFenced(0);
        return;
      }
    }
    await atomicWriteJson(recordPath, { kind: 'session', sessionId: input.session_id, workspace: store.workspacePath, source, createdAt: new Date().toISOString() });
  });
}

// The whole compensation phase shares one local abort budget, mirroring the
// SessionEnd receipt publication budget it substitutes for.
const RESUME_COMPENSATION_BUDGET_MS = 500;
const RESUME_FENCE_BUDGET_MS = 1_500;

/**
 * Publish one `resume-compensation` receipt for the previous lifecycle epoch when
 * that epoch owns nonterminal jobs in the ambient workspace and has no receipt.
 * An existing receipt — pending or settled — is recognized and left untouched
 * (first-writer-wins publication would only merge hints, so recognition here
 * means doing nothing). The scan reuses the exact SessionEnd obligation discovery
 * (writable Rescue plus active read-only detached runs) so a later prompt-time
 * reconciliation consumes exactly what this publication recorded.
 * @param {string} dataRoot @param {any} store @param {string} recordPath @param {string} sessionId
 */
async function compensateUnclosedPreviousEpoch(dataRoot, store, recordPath, sessionId, options = {}) {
  const signal = options.signal ?? AbortSignal.timeout(RESUME_COMPENSATION_BUDGET_MS);
  const budget = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) ? options.timeoutMs : RESUME_COMPENSATION_BUDGET_MS;
  let previous;
  try { previous = await readJsonFile(recordPath); }
  catch (error) { if (error?.cause?.code === 'ENOENT') return; throw error; }
  if (previous.kind !== 'session' || previous.sessionId !== sessionId || previous.workspace !== store.workspacePath
    || !['startup', 'resume', 'clear'].includes(previous.source) || !Number.isFinite(Date.parse(previous.createdAt))) return;
  const lifecycle = createHostLifecycleStore({ dataRoot });
  const epoch = hostLifecycleEpoch(sessionId, previous.createdAt);
  const existing = await lifecycle.readReceipt(epoch);
  if (existing !== null) {
    // A PENDING receipt from a scope-deferred SessionEnd still needs the old
    // ledger's linked-workspace scope recovered and merged BEFORE this resume's
    // cleanup tombstones that ledger — otherwise the receipt can later settle
    // after scanning only the ambient cwd while linked jobs remain active. A
    // settled receipt is already complete and stays untouched.
    if (existing.state === 'pending') {
      const retainedScope = await createIdentityStore({ dataRoot }).sessionWorkspaces(store.workspacePath, sessionId).catch(() => null);
      if (retainedScope !== null && Array.isArray(retainedScope.knownWorkspaces) && retainedScope.knownWorkspaces.length > 0) {
        await lifecycle.publishSessionEnd({
          sessionId, sessionStartedAt: previous.createdAt, endedAt: existing.endedAt,
          origin: existing.origin, workspaceHints: retainedScope.knownWorkspaces,
        }, { signal });
      }
    }
    return;
  }
  // Loaded lazily so the SessionStart hook's static import graph stays free of
  // the recovery/schema machinery: an install missing optional runtime assets
  // still records sessions and renders launcher context.
  const [{ createStateStore }, { discoverSessionEndObligations }] = await Promise.all([
    import('../../scripts/lib/state.mjs'),
    import('../../scripts/lib/recovery.mjs'),
  ]);
  // The obligation scan covers the session's FULL identity-ledger scope — the
  // same read-only enumeration the SessionEnd hook uses — so linked-workspace
  // jobs of the previous epoch are recorded in the receipt's durable hints and
  // later prompt-time reconciliation covers them, not just the ambient cwd.
  // Only a genuine NULL (no global identity state: the ambient legacy shape IS
  // the whole scope) falls back to the ambient workspace — an unreadable or
  // corrupt ledger propagates so recordSession defers the epoch record and the
  // next resume retries the compensation.
  const identityScope = await createIdentityStore({ dataRoot }).sessionWorkspaces(store.workspacePath, sessionId);
  const knownWorkspaces = identityScope === null ? [store.workspacePath] : identityScope.knownWorkspaces;
  const scanStore = createStateStore({ dataRoot });
  const obligations = await discoverSessionEndObligations({
    store: scanStore, dataRoot, knownWorkspaces, ownerSessionId: sessionId,
    epoch: null, endedAt: null, signal, timeoutMs: budget,
    // The resume fence re-scans while HOLDING each workspace's job lock, so the
    // scan itself must be lock-free (re-entrant acquisition would deadlock).
    lockFree: typeof scanStore.peekOwnedJobs === 'function',
  });
  if (obligations.length > 0) {
    await lifecycle.publishSessionEnd({
      sessionId,
      sessionStartedAt: previous.createdAt,
      endedAt: new Date().toISOString(),
      origin: 'resume-compensation',
      workspaceHints: knownWorkspaces,
    }, { signal });
  }
  // The enumerated scope is returned even when nothing needed compensating: the
  // resume fence re-scans THESE workspaces under their job locks before the
  // epoch record is replaced, closing the scan-to-write race.
  return knownWorkspaces;
}
export async function resolveRecordedSessionStart(dataRoot, workspace, sessionId) {
  // Strictly read-only: proving a boundary's epoch must never mutate state (no
  // ensurePrivateDirectory mkdir/chmod), so the SessionEnd receipt can remain
  // the boundary's FIRST durable mutation even when this hook is killed right
  // after the proof.
  const store = await readOnlyPaths(dataRoot, workspace); const id = key('session', sessionId);
  try {
    // An absent layout reads the would-be record path directly so the failure
    // shape stays exactly 'record file missing' (JSON_READ_FAILED/ENOENT) for
    // every consumer, without creating any directory.
    const hookStateDirectory = store.existing === false
      ? join(store.dataRootPath ?? resolve(dataRoot), 'workspaces', store.workspaceKey, 'hook-state')
      : store.directory;
    const record = await readJsonFile(join(hookStateDirectory, `session-${id}.json`));
    if (record.kind !== 'session' || record.sessionId !== sessionId || record.workspace !== store.workspacePath
      || !['startup', 'resume', 'clear'].includes(record.source) || !Number.isFinite(Date.parse(record.createdAt))) throw new Error('invalid session record');
    return { startedAt: record.createdAt, source: record.source };
  } catch (cause) {
    throw Object.assign(new Error('Setup could not prove the active Codex SessionStart record.'), {
      code: 'SETUP_SESSION_UNPROVEN', category: 'authorization', remedy: 'Restart Codex, then run $zcode:setup from one active session.', cause,
    });
  }
}
export async function isOwnedSession(dataRoot, input) { const store = await paths(dataRoot, input.cwd); const id = key('session', input.session_id); try { const record = await readJsonFile(join(store.directory, `session-${id}.json`)); return record.kind === 'session' && record.sessionId === input.session_id && record.workspace === store.workspacePath; } catch { return false; } }

// Prompt-time reconciliation mirrors the SessionEnd settlement stage budgets:
// one shared deadline keeps every sub-budget (receipt scan, discovery, remote
// settlement, receipt settlement) under the native UserPromptSubmit limit, and
// remote control uses ONLY an existing broker client — never a lazy spawn.
const PROMPT_RECONCILIATION_BUDGET_MS = 2_000;
const PROMPT_RECEIPT_STAGE_BUDGET_MS = 500;
const PROMPT_EXISTING_BROKER_REQUEST_TIMEOUT_MS = process.platform === 'win32' ? 500 : 250;

/** The prior epoch's re-proved workspace scope could not be persisted into its
 * receipt hints: the caller must NOT replace the identity ledger (its linked
 * scope would be lost), so the prompt fails safely and the next pass retries. */
function priorScopeUnpersisted() {
  return new PluginError('PRIOR_SCOPE_UNPERSISTED', 'The prior epoch workspace scope could not be recorded.', {
    category: 'state', remedy: 'Retry the prompt; the reconciliation pass persists the scope before settlement.',
  });
}

/**
 * The pending host-session-end receipts of one session's PRIOR lifecycle epochs:
 * pending receipts carry the durable compensation authority of an epoch that
 * ended without full settlement. The current epoch (the recorded SessionStart of
 * the resumed session) is excluded — a receipt for the live epoch is not this
 * session's previous boundary to reconcile.
 * @param {string} dataRoot @param {string} sessionId @param {string} workspace @param {{signal?:AbortSignal, currentEpoch?:string|null}} [options]
 */
export async function pendingPriorEpochReceipts(dataRoot, sessionId, workspace, options = {}) {
  const receipts = await createHostLifecycleStore({ dataRoot }).listPendingReceipts({ signal: options.signal });
  let current = options.currentEpoch;
  if (current === undefined) {
    try { current = hostLifecycleEpoch(sessionId, (await resolveRecordedSessionStart(dataRoot, workspace, sessionId)).startedAt); }
    catch { current = null; }
  }
  return receipts.filter((receipt) => receipt.sessionId === sessionId && receipt.epoch !== current);
}

/**
 * Reconcile one session's pending prior-epoch receipts before new Rescue work:
 * for each receipt, re-run the SessionEnd convergence across its recorded
 * workspace hints plus the ambient workspace — discover the receipt epoch's
 * nonterminal owned obligations, settle or durably delegate each with the same
 * bounded budgets as the SessionEnd hook, then settle the receipt when every
 * obligation is terminal-or-delegated (a bare legacy `cancelling` guard without
 * a valid stop intent never settles). Remote control uses only an existing
 * broker client. Returns the still-pending prior-epoch receipts so callers can
 * block new writable Rescue work while reconciliation remains unresolved.
 * @param {{dataRoot:string,sessionId:string,workspace:string,currentEpoch?:string|null,budgetMs?:number,signal?:AbortSignal}} input
 */
export async function reconcilePriorEpochReceipts(input) {
  const budgetMs = input.budgetMs ?? PROMPT_RECONCILIATION_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const overall = input.signal === undefined ? AbortSignal.timeout(budgetMs) : AbortSignal.any([input.signal, AbortSignal.timeout(budgetMs)]);
  const stage = (budgetMsLimit) => AbortSignal.any([overall, AbortSignal.timeout(Math.max(1, Math.min(budgetMsLimit, deadline - Date.now())))]);
  const remaining = () => Math.max(0, deadline - Date.now());
  const receipts = await pendingPriorEpochReceipts(input.dataRoot, input.sessionId, input.workspace, { signal: stage(PROMPT_RECEIPT_STAGE_BUDGET_MS), currentEpoch: input.currentEpoch });
  if (receipts.length === 0) return [];
  // The recovery, state, and existing-broker machinery loads lazily: with no
  // pending receipts — the overwhelmingly common prompt — the hook's static
  // graph gains nothing, and installs missing optional runtime assets keep
  // working (reconciliation is advisory and its callers fail closed elsewhere).
  const [{ delegateEndedStopIntent, discoverSessionEndObligations, endedObligationSettled, settleEndedReadOnlyDetachedJob, settleEndedRescueJob },
    { createStateStore, isJobNotFound },
    { createExistingManagedZCodeClient }] = await Promise.all([
    import('../../scripts/lib/recovery.mjs'),
    import('../../scripts/lib/state.mjs'),
    import('../../scripts/lib/zcode-client.mjs'),
  ]);
  const lifecycle = createHostLifecycleStore({ dataRoot: input.dataRoot });
  const store = createStateStore({ dataRoot: input.dataRoot });
  const createClient = (workspace) => (job, derivedOwnerId) => createExistingManagedZCodeClient({
    dataRoot: input.dataRoot, workspace, ownerId: derivedOwnerId, requestTimeoutMs: PROMPT_EXISTING_BROKER_REQUEST_TIMEOUT_MS,
  });
  for (const receipt of receipts) {
    if (overall.aborted) break;
    // Re-prove the workspace scope AT SETTLEMENT TIME: SessionEnd deliberately
    // retains the identity ledger when it could not enumerate or persist the
    // complete scope, so that ledger — not the receipt's possibly cwd-only
    // hints — is the union authority for discovery. An unreadable ledger means
    // completeness cannot be proven: the obligation work still runs over the
    // hints, but the receipt itself is never settled this pass.
    let scopeProvable = true;
    let identityScope = null;
    try { identityScope = await createIdentityStore({ dataRoot: input.dataRoot }).sessionWorkspaces(input.workspace, input.sessionId); }
    catch { scopeProvable = false; }
    const knownWorkspaces = [...new Set([
      resolve(input.workspace),
      ...receipt.workspaceHints,
      ...(scopeProvable && identityScope !== null && identityScope.sessionStartedAt === receipt.sessionStartedAt
        ? identityScope.knownWorkspaces : []),
    ])];
    let allSettled = true;
    // Persist the re-proved union BEFORE anything else — before discovery and
    // long before beginCallerTurn replaces the ledger: a merge that stays in
    // memory would lose the linked scope exactly when an obligation could not
    // settle in this pass. An idempotent merge resolves without advancing the
    // CAS token when the hints already match; a FAILED merge throws
    // PRIOR_SCOPE_UNPERSISTED so the caller refuses to replace the ledger.
    let settleToken = receipt.updatedAt;
    if (!scopeProvable) throw priorScopeUnpersisted();
    // Hints are discovery aids, never authority (design:186): a successor
    // ledger's workspaces must not widen this receipt's reach, so only a scope
    // whose epoch proof matches the receipt is merged.
    else if (identityScope !== null && identityScope.sessionStartedAt === receipt.sessionStartedAt) {
      try {
        const merged = await lifecycle.publishSessionEnd({
          sessionId: input.sessionId, sessionStartedAt: receipt.sessionStartedAt,
          endedAt: receipt.endedAt, origin: receipt.origin, workspaceHints: knownWorkspaces,
        }, { signal: stage(PROMPT_RECEIPT_STAGE_BUDGET_MS) });
        if (merged) settleToken = merged.updatedAt;
      } catch (error) {
        if (error instanceof PluginError && error.code === 'PRIOR_SCOPE_UNPERSISTED') throw error;
        throw priorScopeUnpersisted();
      }
    }
    const obligations = await discoverSessionEndObligations({
      store, dataRoot: input.dataRoot, knownWorkspaces, ownerSessionId: input.sessionId,
      epoch: receipt.epoch, endedAt: receipt.endedAt, signal: overall, timeoutMs: remaining(),
    });
      await runBounded(obligations, 2, async (obligation) => {
        try {
          const outcome = obligation.readOnly
            ? await settleEndedReadOnlyDetachedJob({
              store, dataRoot: input.dataRoot, workspace: obligation.workspace, ownerSessionId: input.sessionId,
              epoch: receipt.epoch, endedAt: receipt.endedAt, deadlineMs: deadline,
              lockTimeoutMs: 0, requestTimeoutMs: PROMPT_EXISTING_BROKER_REQUEST_TIMEOUT_MS,
              timeoutMs: remaining(), signal: overall, includeSettlementEvidence: true,
              createClient: createClient(obligation.workspace),
            }, obligation.job.id)
            : await settleEndedRescueJob({
              store, dataRoot: input.dataRoot, workspace: obligation.workspace, ownerSessionId: input.sessionId,
              epoch: receipt.epoch, endedAt: receipt.endedAt, lockTimeoutMs: 0,
              requestTimeoutMs: PROMPT_EXISTING_BROKER_REQUEST_TIMEOUT_MS, timeoutMs: remaining(),
              signal: overall, includeSettlementEvidence: true, createClient: createClient(obligation.workspace),
            }, obligation.job.id);
          if (!endedObligationSettled(outcome)) throw new Error('obligation not settled');
        } catch {
          // A reconcile/broker failure leaves durable state uncertain: durably
          // delegate to the exact session-end stop intent instead of claiming a
          // terminal, then re-read to decide whether the obligation discharged.
          if (!obligation.readOnly && !overall.aborted) {
            try {
              await delegateEndedStopIntent({
                store, dataRoot: input.dataRoot, workspace: obligation.workspace, ownerSessionId: input.sessionId,
                epoch: receipt.epoch, endedAt: receipt.endedAt, signal: overall, timeoutMs: remaining(),
              }, obligation.job.id);
            } catch { /* delegation is best-effort; the pending receipt remains authority */ }
          }
          const reread = { discharged: false };
          try {
            reread.discharged = endedObligationSettled({ kind: null, job: await store.readJob(obligation.workspace, obligation.job.id, { signal: overall, timeoutMs: remaining() }) });
          } catch (error) {
            // Only a PROVEN missing job discharges the obligation; corruption or a
            // contended read keeps the receipt pending as compensation authority.
            reread.discharged = isJobNotFound(error);
          }
          if (!reread.discharged) allSettled = false;
        }
        if (overall.aborted) allSettled = false;
      }, () => overall.aborted);
    // Note: a late reservation racing this pass is closed out by Task 8's
    // atomic reservation-side epoch fence, not by lock acquisition here — the
    // fail-closed writable gate already blocks new Rescue while this receipt
    // remains pending.
    if (allSettled && scopeProvable && !overall.aborted) {
      try { await lifecycle.settleReceipt(receipt.epoch, settleToken, { signal: stage(PROMPT_RECEIPT_STAGE_BUDGET_MS) }); }
      catch { /* settlement races are retried by the next reconciliation pass */ }
    }
  }
  return pendingPriorEpochReceipts(input.dataRoot, input.sessionId, input.workspace, { signal: stage(PROMPT_RECEIPT_STAGE_BUDGET_MS), currentEpoch: input.currentEpoch });
}

/** Run one bounded parallelism loop with a shared abort predicate, mirroring the SessionEnd hook scheduler. @param {readonly any[]} values @param {number} concurrency @param {(value:any)=>Promise<void>} operation @param {()=>boolean} [isAborted] */
async function runBounded(values, concurrency, operation, isAborted = undefined) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      if (isAborted?.()) break;
      const index = next; next += 1;
      await operation(values[index]);
    }
  }));
}
export async function markForwarding(dataRoot, input, parentCaller, options = {}) {
  const publicationSeam = options.publicationSeam;
  if (publicationSeam !== undefined && typeof publicationSeam !== 'function') throw executorError('EXECUTOR_ROUTE_INVALID', 'The private executor route publication seam is invalid.');
  const origin = await paths(dataRoot, input.cwd); const id = key('forward', input.session_id, input.turn_id); const active = input.hook_event_name === 'SubagentStart';
  if (active) {
    const generationId = parentCaller?.generationId ?? null;
    const callerOrigin = parentCaller?.originWorkspace ?? parentCaller?.workspace;
    if (parentCaller?.sessionId !== input.session_id || callerOrigin !== origin.workspacePath
      || typeof parentCaller?.workspace !== 'string') throw executorError('EXECUTOR_PARENT_TURN_MISMATCH', 'SubagentStart is not linked to the exact active parent turn.');
    const target = await paths(dataRoot, parentCaller.workspace); const createdAt = new Date().toISOString();
    let route = { version: 1, kind: 'executor-route', agentId: input.agent_id, agentType: input.agent_type, parentSessionId: input.session_id, parentGenerationId: generationId, parentTurnId: parentCaller.turnId, parentPermissionMode: parentCaller.permissionMode, childTurnId: input.turn_id, originWorkspace: origin.workspacePath, targetWorkspace: target.workspacePath, state: 'pending', createdAt, updatedAt: createdAt };
    await withFileLock(origin.lock, async () => {
      const existing = await readExecutorRoute(routePath(origin, input.session_id, input.turn_id), origin.directory).catch((error) => error?.code === 'ENOENT' || error?.cause?.code === 'ENOENT' ? null : Promise.reject(error));
      if (existing !== null) {
        if (!validExecutorRoute(existing, origin.workspacePath, input) || existing.parentGenerationId !== generationId || existing.parentTurnId !== parentCaller.turnId || existing.parentPermissionMode !== parentCaller.permissionMode || existing.targetWorkspace !== target.workspacePath) throw executorError('EXECUTOR_ROUTE_INVALID', 'SubagentStart found a conflicting exact executor route.');
        if (existing.state === 'stopped') throw executorError('EXECUTOR_ROUTE_INVALID', 'SubagentStart cannot replay an exact stopped executor route.');
        route = existing;
        if (route.state === 'pending') {
          const updatedAt = new Date().toISOString(); route = { ...route, updatedAt };
          await atomicWriteJson(routePath(origin, input.session_id, input.turn_id), route);
          await atomicWriteJson(join(origin.directory, `forward-${id}.json`), { kind: 'forwarding', sessionId: input.session_id, generationId, turnId: input.turn_id, agentId: input.agent_id, active: true, targetWorkspace: target.workspacePath, updatedAt });
        }
      } else {
        await atomicWriteJson(join(origin.directory, `forward-${id}.json`), { kind: 'forwarding', sessionId: input.session_id, generationId, turnId: input.turn_id, agentId: input.agent_id, active: true, targetWorkspace: target.workspacePath, updatedAt: createdAt });
        await atomicWriteJson(routePath(origin, input.session_id, input.turn_id), route);
      }
    });
    await publicationSeam?.('after-route-pending');
    const executor = { kind: 'subagent-executor', agentId: input.agent_id, agentType: input.agent_type, parentSessionId: input.session_id, parentGenerationId: generationId, parentTurnId: parentCaller.turnId, parentPermissionMode: parentCaller.permissionMode, childTurnId: input.turn_id, originWorkspace: origin.workspacePath, workspace: target.workspacePath, active: true, createdAt: route.createdAt };
    let finalState = 'failed'; let finalError = null;
    try {
      await withFileLock(target.lock, async () => {
        await atomicWriteJson(join(target.directory, `executor-${key('executor', input.agent_id)}.json`), executor);
        await publicationSeam?.('after-executor-persisted');
      });
      await publicationSeam?.('after-executor-write');
      await withFileLock(origin.lock, async () => {
        let current;
        try { current = await readExecutorRoute(routePath(origin, input.session_id, input.turn_id), origin.directory); }
        catch (cause) { throw executorError('EXECUTOR_ROUTE_INVALID', 'SubagentStart could not finalize its exact executor route.', cause); }
        const exactRoute = validExecutorRoute(current, origin.workspacePath, input) && current.parentGenerationId === generationId
          && current.parentTurnId === parentCaller.turnId && current.parentPermissionMode === parentCaller.permissionMode && current.targetWorkspace === target.workspacePath;
        if (!exactRoute) { finalError = executorError('EXECUTOR_ROUTE_INVALID', 'SubagentStart lost its exact executor route.'); return; }
        const authority = await routeAuthorityExists(dataRoot, origin.workspacePath, current);
        if (!authority) {
          const updatedAt = new Date().toISOString();
          await atomicWriteJson(routePath(origin, input.session_id, input.turn_id), { ...current, state: 'stopped', updatedAt });
          await atomicWriteJson(join(origin.directory, `forward-${id}.json`), { kind: 'forwarding', sessionId: input.session_id, generationId, turnId: input.turn_id, agentId: input.agent_id, active: false, targetWorkspace: target.workspacePath, updatedAt });
          finalState = 'stopped'; finalError = executorError('EXECUTOR_PARENT_TURN_MISMATCH', 'SubagentStart parent authority ended before executor publication.'); return;
        }
        if (current.state === 'pending') {
          const updatedAt = new Date().toISOString();
          await atomicWriteJson(routePath(origin, input.session_id, input.turn_id), { ...current, state: 'active', updatedAt });
          await atomicWriteJson(join(origin.directory, `forward-${id}.json`), { kind: 'forwarding', sessionId: input.session_id, generationId, turnId: input.turn_id, agentId: input.agent_id, active: true, targetWorkspace: target.workspacePath, updatedAt });
          finalState = 'active'; return;
        }
        finalState = current.state;
      });
    } catch (error) {
      finalError = error instanceof PluginError && `${error.code}`.startsWith('EXECUTOR_')
        ? error : executorError('EXECUTOR_ROUTE_INVALID', 'SubagentStart could not finalize its exact executor route.', error);
    } finally {
      if (finalState !== 'active') await deactivateExactExecutor(target, input.agent_id, route);
    }
    if (finalError !== null) throw finalError;
    return;
  }

  let route;
  await withFileLock(origin.lock, async () => {
    route = await readExecutorRoute(routePath(origin, input.session_id, input.turn_id), origin.directory).catch((error) => {
      if (error?.code === 'ENOENT' || error?.cause?.code === 'ENOENT') return null;
      throw executorError('EXECUTOR_ROUTE_INVALID', 'SubagentStop found an invalid exact executor route.', error);
    });
    if (route !== null && !validExecutorRoute(route, origin.workspacePath, input)) throw executorError('EXECUTOR_ROUTE_INVALID', 'SubagentStop found an invalid exact executor route.');
    const updatedAt = new Date().toISOString();
    if (route !== null && route.state !== 'stopped') { route = { ...route, state: 'stopped', updatedAt }; await atomicWriteJson(routePath(origin, input.session_id, input.turn_id), route); }
    await atomicWriteJson(join(origin.directory, `forward-${id}.json`), { kind: 'forwarding', sessionId: input.session_id, generationId: route?.parentGenerationId ?? null, turnId: input.turn_id, agentId: input.agent_id, active: false, targetWorkspace: route?.targetWorkspace ?? origin.workspacePath, updatedAt });
  });
  const target = route === null ? origin : await paths(dataRoot, route.targetWorkspace);
  const executorPath = join(target.directory, `executor-${key('executor', input.agent_id)}.json`);
  await withFileLock(target.lock, async () => {
    let current; try { current = await readBoundedExecutor(executorPath); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    if (!validExecutorRecord(current, target.workspacePath)) throw executorError('EXECUTOR_IDENTITY_INVALID', 'SubagentStop found an invalid exact executor record.');
    if (route === null && (!isLegacyExecutorRecord(current, target.workspacePath)
      || !await legacyExecutorAuthorityExists(dataRoot, target.workspacePath, current))) throw executorError('EXECUTOR_ROUTE_INVALID', 'SubagentStop requires the exact executor route for this executor.');
    if (current.agentId === input.agent_id && current.parentSessionId === input.session_id && current.childTurnId === input.turn_id && current.agentType === input.agent_type
      && (route === null || executorMatchesRoute(current, route))) await atomicWriteJson(executorPath, { ...current, active: false });
  });
}

export async function resolveForwardingRoute(dataRoot, originWorkspace, sessionId, childTurnId) {
  const origin = await paths(dataRoot, originWorkspace);
  return withFileLock(origin.lock, async () => {
    let route;
    try { route = await readExecutorRoute(routePath(origin, sessionId, childTurnId), origin.directory, true); }
    catch (error) { throw executorError(error?.code === 'ENOENT' || error?.cause?.code === 'ENOENT' ? 'EXECUTOR_ROUTE_NOT_FOUND' : 'EXECUTOR_ROUTE_INVALID', 'No exact trusted executor route matches this child.', error); }
    if (!validExecutorRoute(route, origin.workspacePath) || route.parentSessionId !== sessionId || route.childTurnId !== childTurnId) throw executorError('EXECUTOR_ROUTE_INVALID', 'The private executor route is invalid.');
    return { ...route };
  });
}
async function resolveForwardingRouteReadOnly(dataRoot, originWorkspace, sessionId, childTurnId) {
  let origin; try { origin = await readOnlyPaths(dataRoot, originWorkspace); } catch (cause) { throw executorError('EXECUTOR_ROUTE_INVALID', 'The private executor route is invalid.', cause); }
  if (!origin.existing) throw executorError('EXECUTOR_ROUTE_NOT_FOUND', 'No exact trusted executor route matches this child.');
  return withFileLock(origin.lock, async () => {
    let route;
    try { route = await readExecutorRoute(routePath(origin, sessionId, childTurnId), origin.directory); }
    catch (error) { throw executorError(error?.code === 'ENOENT' || error?.cause?.code === 'ENOENT' ? 'EXECUTOR_ROUTE_NOT_FOUND' : 'EXECUTOR_ROUTE_INVALID', 'No exact trusted executor route matches this child.', error); }
    if (!validExecutorRoute(route, origin.workspacePath) || route.parentSessionId !== sessionId || route.childTurnId !== childTurnId) throw executorError('EXECUTOR_ROUTE_INVALID', 'The private executor route is invalid.');
    return { ...route };
  }, { createLayout: false }).catch((cause) => {
    if (cause instanceof PluginError && `${cause.code}`.startsWith('EXECUTOR_')) throw cause;
    throw executorError('EXECUTOR_ROUTE_INVALID', 'The private executor route is invalid.', cause);
  });
}
export async function resolveForwardingExecutor(dataRoot, workspace, agentId, options = {}) {
  const probe = await probeForwardingExecutor(dataRoot, workspace, agentId, options, false);
  if (probe.kind === 'absent') throw executorError('EXECUTOR_IDENTITY_NOT_FOUND', 'No trusted SubagentStart record matches this executor.');
  return validateForwardingExecutorRoute(dataRoot, probe.store, probe.executor, false);
}
export async function resolveRoutedForwardingExecutor(dataRoot, ambientWorkspace, agentId, options = {}) {
  const probe = await probeForwardingExecutor(dataRoot, ambientWorkspace, agentId, options, true);
  if (probe.kind === 'selected') {
    const executor = await validateForwardingExecutorRoute(dataRoot, probe.store, probe.executor, true);
    return { executor, executionWorkspace: probe.store.workspacePath };
  }
  if (!probe.store.existing) throw executorError('EXECUTOR_IDENTITY_NOT_FOUND', 'No trusted SubagentStart record matches this executor.');
  let route;
  try { route = await withFileLock(probe.store.lock, async () => {
    let entries; try { entries = await readPrivateDirectory(probe.store.directory, probe.store.directory, MAX_HOOK_STATE_RECORDS, { requirePrivatePermissions: true }); } catch (error) { throw executorError('EXECUTOR_IDENTITY_AMBIGUOUS', 'Too many private executor route records exist.', error); }
    const routeEntries = entries.filter((entry) => entry.name.startsWith('route-') && entry.name.endsWith('.json'));
    if (routeEntries.length > 1_024) throw executorError('EXECUTOR_IDENTITY_AMBIGUOUS', 'Too many private executor route records exist.');
    const routes = [];
    for (const entry of routeEntries) {
      if (!entry.isFile()) throw executorError('EXECUTOR_ROUTE_INVALID', 'A private executor route is invalid.');
      let record; try { record = await readExecutorRoute(join(probe.store.directory, entry.name), probe.store.directory, true); } catch (error) { throw executorError('EXECUTOR_ROUTE_INVALID', 'A private executor route is invalid.', error); }
      if (!validExecutorRoute(record, probe.store.workspacePath)) throw executorError('EXECUTOR_ROUTE_INVALID', 'A private executor route is invalid.');
      if (record.agentId === agentId) routes.push(record);
    }
    if (routes.length === 0) throw executorError('EXECUTOR_IDENTITY_NOT_FOUND', 'No trusted SubagentStart record matches this executor.');
    if (routes.length !== 1) throw executorError('EXECUTOR_IDENTITY_AMBIGUOUS', 'More than one private executor route claims this child identity.');
    const timestamp = options.now === undefined ? Date.now() : new Date(options.now).getTime();
    if (!Number.isFinite(timestamp) || timestamp < Date.parse(routes[0].createdAt) || timestamp < Date.parse(routes[0].updatedAt)) throw executorError('EXECUTOR_ROUTE_INVALID', 'The private executor route has a future timestamp.');
    if (options.continuation === true) {
      if (routes[0].state !== 'stopped') throw executorError('EXECUTOR_STATE_MISMATCH', 'A pending Rescue choice requires the original child to be stopped.');
    } else {
      if (options.durableProvenance === true || routes[0].state !== 'active') throw executorError('EXECUTOR_STATE_MISMATCH', 'The private executor route is not active.');
    }
    return { ...routes[0] };
  }, { createLayout: false }); } catch (cause) {
    if (cause instanceof PluginError && `${cause.code}`.startsWith('EXECUTOR_')) throw cause;
    throw executorError('EXECUTOR_ROUTE_INVALID', 'The private executor route store is invalid.', cause);
  }
  let targetProbe;
  try { targetProbe = await probeForwardingExecutor(dataRoot, route.targetWorkspace, agentId, options, true); }
  catch (cause) {
    if (['EXECUTOR_IDENTITY_EXPIRED', 'EXECUTOR_ROLE_UNAPPROVED', 'EXECUTOR_STATE_MISMATCH'].includes(cause?.code)) throw cause;
    throw executorError('EXECUTOR_ROUTE_INVALID', 'The private executor route target is invalid.', cause);
  }
  if (targetProbe.kind !== 'selected') throw executorError('EXECUTOR_ROUTE_INVALID', 'The private executor route target is invalid.');
  const executor = targetProbe.executor;
  if (!executorMatchesRoute(executor, route)) throw executorError('EXECUTOR_ROUTE_INVALID', 'The private executor route does not match its executor.');
  return { executor, executionWorkspace: executor.workspace };
}
export async function resolveRoutedStoppedForwardingExecutor(dataRoot, originWorkspace, agentId, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype
    || Object.keys(options).some((option) => !['continuation', 'durableProvenance', 'now'].includes(option))
    || options.continuation !== undefined && typeof options.continuation !== 'boolean'
    || options.durableProvenance !== undefined && typeof options.durableProvenance !== 'boolean') {
    throw executorError('EXECUTOR_ROUTE_INVALID', 'The stopped executor lookup options are invalid.');
  }
  return resolveRoutedForwardingExecutor(dataRoot, originWorkspace, agentId, {
    ...options,
    continuation: true,
    durableProvenance: true,
  });
}
async function probeForwardingExecutor(dataRoot, workspace, agentId, options, routed) {
  let store;
  try { store = routed ? await readOnlyPaths(dataRoot, workspace) : await paths(dataRoot, workspace); }
  catch (cause) {
    if (!routed) throw cause;
    if (cause instanceof PluginError && `${cause.code}`.startsWith('EXECUTOR_')) throw cause;
    throw executorError('EXECUTOR_IDENTITY_INVALID', 'The private subagent executor store is invalid.', cause);
  }
  if (routed && !store.existing) return { kind: 'absent', store };
  const canonicalName = `executor-${key('executor', agentId)}.json`;
  let selected;
  try { selected = await withFileLock(store.lock, async () => {
    let entries; try { entries = await readPrivateDirectory(store.directory, store.directory, MAX_HOOK_STATE_RECORDS, { requirePrivatePermissions: routed }); } catch (error) { throw executorError('EXECUTOR_IDENTITY_AMBIGUOUS', 'Too many private subagent executor records exist.', error); }
    const executorEntries = entries.filter((entry) => entry.name.startsWith('executor-') && entry.name.endsWith('.json'));
    if (routed && executorEntries.some((entry) => !entry.isFile())) throw executorError('EXECUTOR_IDENTITY_INVALID', 'A private subagent executor record is invalid.');
    const names = executorEntries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    if (names.length > 1_024) throw executorError('EXECUTOR_IDENTITY_AMBIGUOUS', 'Too many private subagent executor records exist.');
    const matches = [];
    for (const name of names) {
      let record; try { record = await readBoundedExecutor(join(store.directory, name), routed); } catch (error) { throw executorError('EXECUTOR_IDENTITY_INVALID', 'A private subagent executor record is invalid.', error); }
      if (!validExecutorRecord(record, store.workspacePath)) throw executorError('EXECUTOR_IDENTITY_INVALID', 'A private subagent executor record is invalid.');
      if (name === canonicalName) { if (!validExecutorRecord(record, store.workspacePath) || record.agentId !== agentId) throw executorError('EXECUTOR_IDENTITY_INVALID', 'The private subagent executor record is invalid.'); matches.push(record); continue; }
      if (record?.agentId === agentId) throw executorError('EXECUTOR_IDENTITY_AMBIGUOUS', 'More than one private executor record claims this child identity.');
    }
    if (matches.length === 0) return null;
    if (matches.length !== 1) throw executorError('EXECUTOR_IDENTITY_AMBIGUOUS', 'More than one trusted SubagentStart record matches this executor.');
    const selected = matches[0];
    if (!['zcode-rescue', 'default'].includes(selected.agentType)) throw executorError('EXECUTOR_ROLE_UNAPPROVED', 'Only the installed zcode-rescue Role or the qualified 0.147 default compatibility route may execute Rescue.');
    const timestamp = options.now === undefined ? Date.now() : new Date(options.now).getTime();
    const selectedAge = timestamp - Date.parse(selected.createdAt);
    if (!Number.isFinite(timestamp) || selectedAge < 0) throw executorError('EXECUTOR_IDENTITY_INVALID', 'The trusted child executor record has a future creation time.');
    if (selectedAge >= EXECUTOR_LIFETIME_MS && options.durableProvenance !== true) throw executorError('EXECUTOR_IDENTITY_EXPIRED', 'The trusted child executor record has expired.');
    if (options.continuation === true) {
      if (selected.active !== false) throw executorError('EXECUTOR_STATE_MISMATCH', 'A pending Rescue choice requires the original child to be stopped.');
      return selected;
    }
    if (options.durableProvenance === true) throw executorError('EXECUTOR_STATE_MISMATCH', 'Durable Rescue provenance is restricted to a stopped executor.');
    if (selected.active !== true) throw executorError('EXECUTOR_IDENTITY_NOT_FOUND', 'No active trusted SubagentStart record matches this executor.');
    const candidates = [];
    for (const name of names) {
      let record; try { record = await readBoundedExecutor(join(store.directory, name), routed); } catch { continue; }
      const age = timestamp - Date.parse(record.createdAt);
      if (validExecutorRecord(record, store.workspacePath) && record.active && ['zcode-rescue', 'default'].includes(record.agentType) && record.parentSessionId === selected.parentSessionId && record.parentTurnId === selected.parentTurnId && record.parentGenerationId === selected.parentGenerationId) {
        if (age < 0) throw executorError('EXECUTOR_IDENTITY_INVALID', 'A same-turn Rescue executor record has a future creation time.');
        if (age < EXECUTOR_LIFETIME_MS) candidates.push(record);
      }
    }
    if (candidates.length !== 1) throw executorError('EXECUTOR_IDENTITY_AMBIGUOUS', 'The parent turn does not have exactly one active Rescue executor.');
    return selected;
  }, routed ? { createLayout: false } : undefined); } catch (cause) {
    if (!routed) throw cause;
    if (cause instanceof PluginError && `${cause.code}`.startsWith('EXECUTOR_')) throw cause;
    throw executorError('EXECUTOR_IDENTITY_INVALID', 'The private subagent executor store is invalid.', cause);
  }
  return selected === null ? { kind: 'absent', store } : { kind: 'selected', store, executor: selected };
}
async function validateForwardingExecutorRoute(dataRoot, store, selected, readOnly) {
  if (isLegacyExecutorRecord(selected, store.workspacePath)) {
    if (!await legacyExecutorAuthorityExists(dataRoot, store.workspacePath, selected)) throw executorError('EXECUTOR_ROUTE_INVALID', 'Legacy executor routing is unavailable while lifecycle authority exists.');
    return selected;
  }
  const route = readOnly
    ? await resolveForwardingRouteReadOnly(dataRoot, selected.originWorkspace, selected.parentSessionId, selected.childTurnId)
    : await resolveForwardingRoute(dataRoot, selected.originWorkspace, selected.parentSessionId, selected.childTurnId);
  if (!executorMatchesRoute(selected, route)) throw executorError('EXECUTOR_ROUTE_INVALID', 'The private executor route does not match this executor.');
  if (selected.active && route.state !== 'active' || !selected.active && route.state !== 'stopped') throw executorError('EXECUTOR_ROUTE_INVALID', 'The private executor route state does not match this executor.');
  return selected;
}
export async function isForwarding(dataRoot, input, options = {}) {
  const origin = await paths(dataRoot, input.cwd); const id = key('forward', input.session_id, input.turn_id);
  try {
    const snapshot = await withFileLock(origin.lock, async () => {
      const marker = await readBoundedJsonFile(origin.directory, join(origin.directory, `forward-${id}.json`), MAX_EXECUTOR_ROUTE_BYTES);
      if (marker.active !== true) return { kind: 'not-forwarding' };
      let route;
      try { route = await readExecutorRoute(routePath(origin, input.session_id, input.turn_id), origin.directory); }
      catch (error) {
        if (error?.code !== 'ENOENT' && error?.cause?.code !== 'ENOENT') throw error;
        return validLegacyForwarding(marker, input) ? { kind: 'legacy', marker } : { kind: 'not-forwarding' };
      }
      if (!validExecutorRoute(route, origin.workspacePath) || !validForwarding(marker, route, input) || route.state === 'stopped') return { kind: 'not-forwarding' };
      return { kind: route.state, route };
    });
    if (snapshot.kind === 'not-forwarding') return false;
    if (snapshot.kind === 'legacy') {
      const executor = await readBoundedExecutor(join(origin.directory, `executor-${key('executor', snapshot.marker.agentId)}.json`));
      return isLegacyExecutorRecord(executor, origin.workspacePath) && executor.active === true && executor.parentSessionId === input.session_id && executor.childTurnId === input.turn_id
        && await legacyExecutorAuthorityExists(dataRoot, origin.workspacePath, executor, true);
    }
    if (snapshot.kind === 'pending') {
      const now = options.now === undefined ? Date.now() : new Date(options.now).getTime(); const age = now - Date.parse(snapshot.route.updatedAt);
      return Number.isFinite(now) && age >= 0 && age < FORWARDING_PENDING_LIFETIME_MS
        && await routeAuthorityExists(dataRoot, origin.workspacePath, snapshot.route);
    }
    const target = await paths(dataRoot, snapshot.route.targetWorkspace);
    const executor = await withFileLock(target.lock, () => readBoundedExecutor(join(target.directory, `executor-${key('executor', snapshot.route.agentId)}.json`)));
    return validExecutorRecord(executor, target.workspacePath) && executor.active === true && executorMatchesRoute(executor, snapshot.route);
  } catch { return false; }
}
export async function cleanupSession(dataRoot, workspace, sessionId, options = {}) {
  const store = await paths(dataRoot, workspace);
  const lockOptions = { ...(options.signal === undefined ? {} : { signal: options.signal }), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) };
  // Epoch fence: when the caller proves the ending boundary, a session record
  // Epoch fence: when the caller proves the ending boundary, any record written
  // AT OR AFTER it belongs to a resumed successor reusing the session id. The
  // successor's SessionStart marker only exists in its own workspace, so each
  // record's own write timestamp is the per-workspace durable succession
  // evidence — deleting such a record would break the successor's authorization
  // and its own receipt publication. The comparison is '>=' on purpose:
  // RFC3339 millisecond precision makes an exactly-equal timestamp possible in
  // the concurrent resume race.
  const provenEndedAt = typeof options.endedAt === 'string' && Number.isFinite(Date.parse(options.endedAt)) ? Date.parse(options.endedAt) : null;
  /** A record's own durable write time, when it carries one. @param {any} record @returns {number|null} */
  const recordWriteTime = (record) => {
    const value = record?.createdAt ?? record?.updatedAt;
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
  };
  await withFileLock(store.lock, async () => {
    let entries; try { entries = await readPrivateDirectory(store.directory, store.directory, MAX_HOOK_STATE_RECORDS); } catch (error) { throw executorError('HOOK_STATE_CAPACITY', 'Private hook state exceeds its cleanup bound.', error); }
    for (const entry of entries) {
      // The lock budget only gates acquisition: the sweep itself must observe
      // the SessionEnd deadline so cleanup cannot outlive the shared budget.
      options.signal?.throwIfAborted();
      if (!entry.isFile()) continue;
      if (!/^(?:session|forward|route|executor|notified)-[a-f0-9]{64}\.json$/u.test(entry.name)) {
        if (entry.name.startsWith('executor-') && entry.name.endsWith('.json')) await unlink(join(store.directory, entry.name)).catch(() => {});
        continue;
      }
      const path = join(store.directory, entry.name);
      try {
        const record = entry.name.startsWith('executor-')
          ? await readBoundedExecutor(path)
          : entry.name.startsWith('route-') ? await readExecutorRoute(path, store.directory) : await readBoundedJsonFile(store.directory, path, MAX_EXECUTOR_ROUTE_BYTES);
        if (provenEndedAt !== null) {
          const writtenAt = recordWriteTime(record);
          if (writtenAt !== null && writtenAt >= provenEndedAt) continue;
        }
        if (record.sessionId === sessionId || (['subagent-executor', 'executor-route'].includes(record.kind) && record.parentSessionId === sessionId)) await unlink(path);
      } catch (error) {
        if (entry.name.startsWith('executor-')) await unlink(path).catch(() => {});
        else throw executorError('HOOK_STATE_INVALID', 'Private hook state is invalid during exact session cleanup.', error);
      }
    }
  }, lockOptions);
}
export async function unreadJobs(dataRoot, workspace, sessionId) { const store = await paths(dataRoot, workspace); const jobs = join(store.directory, '..', 'jobs'); let names = []; try { names = await readdir(jobs); } catch { return []; } return withFileLock(store.lock, async () => { const markerPath = join(store.directory, `notified-${key('notified', sessionId)}.json`); let marker = { kind: 'notifications', sessionId, jobIds: [] }; try { marker = await readJsonFile(markerPath); } catch (error) { if (error?.cause?.code !== 'ENOENT') throw error; } const seen = new Set(Array.isArray(marker.jobIds) ? marker.jobIds : []); const found = []; for (const name of names.slice(0, 500)) { if (!name.endsWith('.json')) continue; try { const job = await readJsonFile(join(jobs, name)); if (job.ownerSessionId === sessionId && terminal.has(job.status) && !seen.has(job.id)) found.push({ id: job.id, status: job.status }); } catch { /* state command reports corrupt jobs */ } } const selected = found.slice(-RESCUE_UNREAD_JOB_LIMIT); for (const job of selected) seen.add(job.id); await atomicWriteJson(markerPath, { kind: 'notifications', sessionId, jobIds: [...seen].slice(-500), updatedAt: new Date().toISOString() }); return selected; }); }
export async function writeGateRun(dataRoot, workspace, record) { const store = await paths(dataRoot, workspace); const directory = join(store.directory, '..', 'gate-runs'); await ensurePrivateDirectory(directory); const id = key(record.sessionId, record.turnId, record.before, record.after); const path = join(directory, `${id}.json`); return withFileLock(join(directory, '.lock'), async () => { try { return { duplicate: true, path, record: await readJsonFile(path) }; } catch (error) { if (error?.cause?.code !== 'ENOENT') throw error; } await atomicWriteJson(path, record); return { duplicate: false, path, record }; }); }
export async function finishGateRun(path, record) { await atomicWriteJson(path, record); }
function validExecutorRecord(record, workspace) { return isCurrentExecutorRecord(record, workspace) || isLegacyExecutorRecord(record, workspace); }
function isCurrentExecutorRecord(record, workspace) { return record && typeof record === 'object' && !Array.isArray(record) && Object.keys(record).sort().join('\0') === [...EXECUTOR_KEYS].sort().join('\0') && record.kind === 'subagent-executor' && [record.agentId, record.agentType, record.parentSessionId, record.parentTurnId, record.childTurnId].every((value) => boundedIdentifier(value)) && (record.parentGenerationId === null || /^[a-f0-9]{64}$/u.test(record.parentGenerationId)) && PERMISSION_MODES.includes(record.parentPermissionMode) && boundedWorkspace(record.originWorkspace) && boundedWorkspace(record.workspace) && record.workspace === workspace && typeof record.active === 'boolean' && canonicalTimestamp(record.createdAt); }
function isLegacyExecutorRecord(record, workspace) { return record && typeof record === 'object' && !Array.isArray(record) && Object.keys(record).sort().join('\0') === [...LEGACY_EXECUTOR_KEYS].sort().join('\0') && record.kind === 'subagent-executor' && [record.agentId, record.agentType, record.parentSessionId, record.parentTurnId, record.childTurnId].every((value) => boundedIdentifier(value)) && PERMISSION_MODES.includes(record.parentPermissionMode) && boundedWorkspace(record.workspace) && record.workspace === workspace && typeof record.active === 'boolean' && canonicalTimestamp(record.createdAt); }
function validExecutorRoute(record, originWorkspace, input) { return record && typeof record === 'object' && !Array.isArray(record) && Object.keys(record).sort().join('\0') === [...EXECUTOR_ROUTE_KEYS].sort().join('\0') && record.version === 1 && record.kind === 'executor-route' && [record.agentId, record.agentType, record.parentSessionId, record.parentTurnId, record.childTurnId].every((value) => boundedIdentifier(value)) && (record.parentGenerationId === null || /^[a-f0-9]{64}$/u.test(record.parentGenerationId)) && PERMISSION_MODES.includes(record.parentPermissionMode) && boundedWorkspace(record.originWorkspace) && record.originWorkspace === originWorkspace && boundedWorkspace(record.targetWorkspace) && ['pending', 'active', 'stopped'].includes(record.state) && canonicalTimestamp(record.createdAt) && canonicalTimestamp(record.updatedAt) && Date.parse(record.updatedAt) >= Date.parse(record.createdAt) && (input === undefined || record.parentSessionId === input.session_id && record.childTurnId === input.turn_id && record.agentId === input.agent_id && record.agentType === input.agent_type); }
function executorMatchesRoute(executor, route) { return executor.agentId === route.agentId && executor.agentType === route.agentType && executor.parentSessionId === route.parentSessionId && executor.parentGenerationId === route.parentGenerationId && executor.parentTurnId === route.parentTurnId && executor.parentPermissionMode === route.parentPermissionMode && executor.childTurnId === route.childTurnId && executor.originWorkspace === route.originWorkspace && executor.workspace === route.targetWorkspace && executor.createdAt === route.createdAt; }
function validForwarding(record, route, input) { return record && typeof record === 'object' && !Array.isArray(record) && Object.keys(record).sort().join('\0') === [...FORWARDING_KEYS].sort().join('\0') && record.kind === 'forwarding' && record.sessionId === input.session_id && record.turnId === input.turn_id && record.agentId === route.agentId && record.generationId === route.parentGenerationId && record.targetWorkspace === route.targetWorkspace && typeof record.active === 'boolean' && canonicalTimestamp(record.updatedAt); }
function validLegacyForwarding(record, input) { return record && typeof record === 'object' && !Array.isArray(record) && Object.keys(record).sort().join('\0') === [...LEGACY_FORWARDING_KEYS].sort().join('\0') && record.kind === 'forwarding' && record.sessionId === input.session_id && record.turnId === input.turn_id && boundedIdentifier(record.agentId) && typeof record.active === 'boolean' && canonicalTimestamp(record.updatedAt); }
async function legacyExecutorAuthorityExists(dataRoot, workspace, executor, requireTurn = false) { try { const caller = await createIdentityStore({ dataRoot }).resolveActiveTurn({ sessionId: executor.parentSessionId, workspace, workspaceBinding: 'execution' }); return caller.generationId === undefined && (!requireTurn || caller.turnId === executor.parentTurnId); } catch { return false; } }
function routePath(store, sessionId, childTurnId) { return join(store.directory, `route-${key('executor-route', sessionId, childTurnId)}.json`); }
async function readBoundedExecutor(path, requirePrivatePermissions = false) { return readBoundedJsonFile(dirname(path), path, MAX_EXECUTOR_BYTES, { requirePrivatePermissions }); }
async function readExecutorRoute(path, privateRoot, requirePrivatePermissions = false) { return readBoundedJsonFile(privateRoot, path, MAX_EXECUTOR_ROUTE_BYTES, { requirePrivatePermissions }); }
async function deactivateExactExecutor(target, agentId, route) {
  try {
    await withFileLock(target.lock, async () => {
      const path = join(target.directory, `executor-${key('executor', agentId)}.json`); let current;
      try { current = await readBoundedExecutor(path); } catch { return; }
      if (validExecutorRecord(current, target.workspacePath) && executorMatchesRoute(current, route) && current.active) await atomicWriteJson(path, { ...current, active: false });
    });
  } catch { /* compensation is best-effort and must not replace the fixed finalization error */ }
}
function boundedIdentifier(value) { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 512 && ![...value].some((character) => { const code = character.charCodeAt(0); return code <= 31 || code === 127; }); }
function boundedWorkspace(value) { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 4_096 && ![...value].some((character) => ['\0', '\n', '\r'].includes(character)); }
function canonicalTimestamp(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)); }
function executorError(code, message, cause) { return new PluginError(code, message, { category: 'authorization', remedy: 'Retry from the original parent thread after the Rescue child is active.', cause }); }
async function routeAuthorityExists(dataRoot, workspace, route) {
  try {
    const caller = await createIdentityStore({ dataRoot }).resolveActiveTurn({ sessionId: route.parentSessionId, workspace, workspaceBinding: 'execution' });
    const generationMatches = route.parentGenerationId === null ? caller.generationId === undefined : caller.generationId === route.parentGenerationId;
    const originMatches = route.parentGenerationId === null ? caller.originWorkspace === undefined && caller.workspace === route.originWorkspace : caller.originWorkspace === route.originWorkspace;
    return caller.sessionId === route.parentSessionId && caller.turnId === route.parentTurnId && caller.permissionMode === route.parentPermissionMode
      && caller.workspace === route.targetWorkspace && generationMatches && originMatches;
  } catch { return false; }
}
