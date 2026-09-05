import { PluginError } from './errors.mjs';
import { createIdentityStore } from './identity.mjs';
import { createHostLifecycleStore } from './host-lifecycle.mjs';
import { boundedCancelMessage, durableCancelledWinner, ownerIdForSession, withJobCancellationLock } from './job-control.mjs';
import { extractFinalResult, SuccessfulResultFinalizationError, writeResultArtifact } from './review.mjs';
import { realpath } from 'node:fs/promises';
import { withFileLock } from './fs.mjs';
import { terminateRecordedProcessTree } from './process.mjs';
import { openRuntimeJobLog } from './job-log-runtime.mjs';
import { readQueuedRescueMigrationRollback } from './rescue-migration.mjs';
import { createRescueLifecycleReconciler } from './rescue-lifecycle.mjs';
import { hostOwnedCancelledPatch, hostOwnedStopIntentPatch, validHostLifecycleRecord, validStopIntent } from './rescue-binding.mjs';
import { isJobNotFound } from './state.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';
import { classifyCurrentTurnSnapshot, hasCurrentTurnActivity, persistedTurnBoundary } from './turn-terminal.mjs';
import { reconcileBrokerOwnership } from '../zcode-broker.mjs';

/** The single closed set of terminal job statuses, shared with the Rescue route planner. */
export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const REMOTE_ACTIVE = new Set(['running', 'waiting']);
// Evidence projection (endedRemoteEvidence) treats paused as attributable
// activity so a persisted stop can be retried against a paused turn; the
// orphan-scavenge path keeps its stricter paused semantics above.
const EVIDENCE_ACTIVE = new Set(['running', 'waiting', 'paused']);
const CONTROL_CHANNEL_UNAVAILABLE = new Set(['ZCODE_BROKER_PROTOCOL_UNAVAILABLE', 'ZCODE_DISCONNECTED']);
export const LEGACY_QUEUED_STALE_MS = 5 * 60_000;
const OPTIONAL_JOB_LOG_FENCE_MS = 250;

/** Hold the exact production worker identity for its full lifetime. @param {{dataRoot:string,workspace:string,jobId:string,workerLeaseId:string,timeoutMs?:number}} input @param {()=>Promise<any>} operation */
export async function withWorkerLease(input, operation) {
  if (!isDigest(input.jobId) || !isDigest(input.workerLeaseId)) throw recoveryError('Worker lease identity is invalid.');
  const storage = await resolveWorkspaceStorage({ dataRoot: input.dataRoot, workspace: input.workspace });
  return withFileLock(joinWorkerLease(storage.directory, input.jobId, input.workerLeaseId), operation, { timeoutMs: input.timeoutMs ?? 30_000 });
}

/** Reconcile only provably orphaned jobs owned by one exact Codex session. @param {{store:any,identity?:any,dataRoot:string,workspace:string,ownerSessionId:string,createClient:(job:any,ownerId:string)=>Promise<any>,reconcileOwnership?:(input:any)=>Promise<any>,now?:()=>number,signal?:AbortSignal}} input */
export async function reconcileOwnedJobs(input) {
  const listed = await input.store.listOwnedJobs(input.workspace, input.ownerSessionId);
  const outcomes = await cleanupListedTerminalReservations(input, listed);
  const jobs = listed.filter((/** @type {any} */ job) => !TERMINAL.has(job.status));
  for (const job of jobs) {
    try {
      const settled = await settleSelectedJob({ ...input, selectedJobId: job.id, expectedOwnerSessionId: job.ownerSessionId, intent: 'owner-recovery' });
      outcomes.push(await cleanupTerminalReservation(input, settled));
    }
    catch (error) { throwIfRecoveryInterrupted(input, error); if (error instanceof SuccessfulResultFinalizationError) throw error; outcomes.push(job); }
  }
  return outcomes;
}

/** Settle provably orphaned writable Rescue blockers without adopting their public ownership. @param {{store:any,identity?:any,dataRoot:string,workspace:string,createClient:(job:any,ownerId:string)=>Promise<any>,reconcileOwnership?:(input:any)=>Promise<any>,now?:()=>number,signal?:AbortSignal}} input */
export async function scavengeWritableJobs(input) {
  const listed = await input.store.listJobs(input.workspace);
  const outcomes = await cleanupListedTerminalReservations(input, listed);
  const jobs = listed
    .filter((/** @type {any} */ job) => job.command === 'rescue' && job.readOnly === false && !TERMINAL.has(job.status));
  for (const job of jobs) {
    try {
      const settled = await settleSelectedJob({ ...input, selectedJobId: job.id, expectedOwnerSessionId: job.ownerSessionId, intent: 'scavenge' });
      outcomes.push(await cleanupTerminalReservation(input, settled));
    }
    catch (error) { throwIfRecoveryInterrupted(input, error); if (error instanceof SuccessfulResultFinalizationError) throw error; outcomes.push(job); }
  }
  return outcomes;
}

/** @param {any} input @param {any[]} jobs */
async function cleanupListedTerminalReservations(input, jobs) {
  const outcomes = [];
  for (const job of jobs.filter((/** @type {any} */ candidate) => TERMINAL.has(candidate.status)
    && candidate.rescueExecutionReservation !== undefined)) {
    try { outcomes.push(await cleanupTerminalReservation(input, job)); }
    catch (error) { throwIfRecoveryInterrupted(input, error); outcomes.push(job); }
  }
  return outcomes;
}

/** @param {any} input @param {any} job */
async function cleanupTerminalReservation(input, job) {
  if (!TERMINAL.has(job.status) || job.rescueExecutionReservation === undefined) return job;
  const identity = input.identity ?? createIdentityStore({ dataRoot: input.dataRoot });
  return input.store.cleanupTerminalExecutionReservation(input.workspace, job.id, identity);
}

/**
 * Best-effort settlement for the ending owner's one active writable Rescue.
 * Unlike orphan scavenging, SessionEnd is an explicit owner lifecycle signal, so
 * an accepted remote turn may be stopped even while its worker lease is held.
 * The stop ordering itself is owned by the Rescue Lifecycle Reconciler.
 * @param {{store:any,identity?:any,dataRoot:string,workspace:string,ownerSessionId:string,lockTimeoutMs?:number,requestTimeoutMs?:number,createClient:(job:any,ownerId:string)=>Promise<any>,signal?:AbortSignal,includeSettlementEvidence?:boolean}} input
 */
export async function settleEndedOwnerWritableJob(input) {
  const listed = await input.store.listOwnedJobs(input.workspace, input.ownerSessionId);
  for (const terminal of listed.filter((/** @type {any} */ job) => TERMINAL.has(job.status)
    && job.rescueExecutionReservation !== undefined)) {
    await cleanupTerminalReservation(input, terminal).catch(() => terminal);
  }
  const selected = listed
    .filter((/** @type {any} */ job) => job.command === 'rescue'
      && job.readOnly === false && !TERMINAL.has(job.status))
    .at(-1);
  if (!selected) return input.includeSettlementEvidence === true ? { kind: 'no-active-job', job: null } : null;
  let settlement;
  try {
    settlement = await withJobCancellationLock({
      dataRoot: input.dataRoot,
      workspace: input.workspace,
      jobId: selected.id,
      timeoutMs: input.lockTimeoutMs ?? 0,
    }, async () => {
      const current = await input.store.readJob(input.workspace, selected.id);
      if (current.id !== selected.id || current.ownerSessionId !== input.ownerSessionId
        || current.command !== 'rescue' || current.readOnly !== false || TERMINAL.has(current.status)) return classifyEndedSettlement(current);
      const remotelySettleable = current.status === 'queued'
        || (['running', 'cancelling'].includes(current.status) && typeof current.zcodeSessionId === 'string');
      return remotelySettleable ? settleEndedRescueThroughReconciler(input, current) : { kind: 'retained-writable-guard', job: current };
    });
  } catch (error) {
    if (error instanceof PluginError && error.code === 'LOCK_TIMEOUT') settlement = { kind: 'retained-writable-guard', job: await input.store.readJob(input.workspace, selected.id) };
    else throw error;
  }
  try { settlement = { ...settlement, job: await cleanupTerminalReservation(input, settlement.job) }; }
  catch { /* retain the durable settlement winner */ }
  return input.includeSettlementEvidence === true ? settlement : settlement.job;
}

/** @param {any} job */
function classifyEndedSettlement(job) {
  if (job?.status === 'succeeded' && typeof job.resultArtifact === 'string') return { kind: 'durable-completion', job };
  if (job?.status === 'cancelled') return { kind: 'confirmed-cancellation', job };
  return { kind: TERMINAL.has(job?.status) ? 'terminal' : 'retained-writable-guard', job };
}

/** A durable winner that is terminal, or a record still in the durable
 * `cancelling` guard (a retained unresolved stop, with or without a persisted
 * session-end stop intent), discharges one receipt obligation: the receipt may
 * settle without ever claiming that the job has stopped. @param {any} outcome */
export function endedObligationSettled(outcome) {
  if (outcome?.kind === 'no-active-job') return true;
  const job = outcome?.job;
  if (!job) return true;
  if (TERMINAL.has(job.status)) return true;
  // A bare legacy 'cancelling' guard — no exact persisted stop intent — is NOT
  // settlement: the pending receipt remains the durable compensation authority.
  return job.status === 'cancelling' && validStopIntent(job.stopIntent);
}

// Read-only detached runs (Review / Adversarial Review, and read-only Rescue)
// remain session-bound: SessionEnd must converge them (bounded exact remote stop
// then recorded worker-tree termination), never the writable Rescue binding path.
const READ_ONLY_DETACHED_COMMANDS = new Set(['review', 'adversarial-review']);
function isReadOnlyDetachedObligation(/** @type {any} */ job) {
  return job.readOnly === true && (READ_ONLY_DETACHED_COMMANDS.has(job.command)
    || (job.command === 'rescue' && job.rescueExecutionReservation !== undefined));
}
function isWritableRescueObligation(/** @type {any} */ job) {
  return job.command === 'rescue' && job.readOnly === false;
}

/**
 * Discover the exact session-owned obligations one genuine SessionEnd receipt
 * owns across the receipt's workspace hints: writable Rescue records AND active
 * read-only detached runs. Read-only obligations carry `readOnly: true` so the
 * caller settles them through the existing recovery primitives rather than the
 * writable Reconciler. A Host-owned record whose owner lifecycle epoch does not
 * match the receipt epoch is not this receipt's obligation, so a retained
 * old-epoch receipt never claims a post-resume run as still owned. When no
 * authoritative receipt epoch is proven (`epoch` null), every nonterminal owned
 * obligation is discovered so the legacy settle path is preserved unchanged.
 * @param {{store:any,dataRoot?:string,knownWorkspaces:readonly string[],ownerSessionId:string,epoch:string|null,endedAt?:string|null,lockFree?:boolean,signal?:AbortSignal,timeoutMs?:number}} input
 * @returns {Promise<Array<{workspace:string,job:any,readOnly:boolean}>>}
 */
export async function discoverSessionEndObligations(input) {
  const obligations = [];
  for (const workspace of input.knownWorkspaces) {
    input.signal?.throwIfAborted();
    // A hinted workspace whose directory no longer exists (a deleted or moved
    // linked worktree) may still own CENTRALLY tracked jobs with live workers —
    // treating it as empty would settle the receipt and abandon them. Fail the
    // pass with a stable error so the caller keeps the receipt pending; the
    // central-state read for absent worktrees lands with historical
    // compatibility (Task 11).
    // Thread the shared signal and a bounded stage timeout into the job-state
    // lock so a contended listing fails closed at the SessionEnd sub-budget instead
    // of waiting the default five-second state lock (which cannot be interrupted by
    // a signal checked only before the call).
    const listed = await (input.lockFree && typeof input.store.peekOwnedJobs === 'function'
      ? input.store.peekOwnedJobs(workspace, input.ownerSessionId, { signal: input.signal, timeoutMs: input.timeoutMs })
      : input.store.listOwnedJobs(workspace, input.ownerSessionId, { signal: input.signal, timeoutMs: input.timeoutMs }));
    for (const job of listed) {
      if (TERMINAL.has(job.status)) continue;
      const writable = isWritableRescueObligation(job);
      const readOnly = isReadOnlyDetachedObligation(job);
      if (!writable && !readOnly) continue;
      if (!endedJobEpochOwned(input.epoch, job, input.endedAt)) continue;
      obligations.push({ workspace, job, readOnly });
    }
  }
  return obligations;
}

/**
 * Return the workspaces whose owned active writable Rescue jobs carry a
 * `ownerLifecycleEpoch` that does NOT match the ending receipt's epoch. Releasing
 * a broker owner stops that owner's sessions, so an old-epoch SessionEnd must not
 * release a workspace where a newer (post-resume) epoch still has an active run —
 * the newer turn has a live owner and an old receipt grants it no stop authority.
 * A null epoch cannot scope the exclusion, so nothing is treated as foreign.
 * @param {{store:any,knownWorkspaces:readonly string[],ownerSessionId:string,epoch:string|null,endedAt?:string|null,lockFree?:boolean,signal?:AbortSignal,timeoutMs?:number}} input
 * @returns {Promise<Set<string>>}
 */
export async function activeForeignEpochWorkspaces(input) {
  const foreign = new Set();
  if (typeof input.epoch !== 'string') return foreign;
  for (const workspace of input.knownWorkspaces) {
    input.signal?.throwIfAborted();
    // An absent workspace cannot prove the absence of its centrally tracked
    // jobs: its broker owner stays release-unsafe until the central state is
    // read without the worktree (historical compatibility).
    if (await realpath(workspace).then(() => false, (error) => error?.code === 'ENOENT')) { foreign.add(workspace); continue; }
    let listed;
    try {
      // lockFree: the caller already holds the workspace job-state lock (the
      // SessionEnd release fence), so re-entering listOwnedJobs would deadlock.
      listed = await (input.lockFree && typeof input.store.peekOwnedJobs === 'function'
        ? input.store.peekOwnedJobs(workspace, input.ownerSessionId, { signal: input.signal, timeoutMs: input.timeoutMs })
        : input.store.listOwnedJobs(workspace, input.ownerSessionId, { signal: input.signal, timeoutMs: input.timeoutMs }));
    } catch {
      // An unenumerable workspace is treated conservatively as unsafe to release so
      // a broker turn is never stopped behind durable state we could not read.
      foreign.add(workspace);
      continue;
    }
    for (const job of listed) {
      // ANY nonterminal session-bound successor of this receipt's epoch — writable
      // Rescue, read-only Rescue, or a read-only detached run — still owns the
      // session-ID-derived broker identity that an owner release would stop. A
      // record with the lifecycle trio is foreign by epoch; a trio-less record is
      // foreign when it was created strictly after the receipt's own boundary.
      if (TERMINAL.has(job.status)) continue;
      if (!endedJobEpochOwned(input.epoch, job, input.endedAt)) { foreign.add(workspace); break; }
    }
  }
  return foreign;
}

/**
 * Settle one exact SessionEnd obligation — the writable Rescue the receipt-scoped
 * discovery selected — through the Rescue Lifecycle Reconciler, persisting its
 * durable session-end stop intent before any remote control and retaining
 * uncertainty rather than claiming a terminal stop. This is the per-obligation
 * counterpart to settleEndedOwnerWritableJob: it targets the exact job id rather
 * than re-deriving the workspace's latest writable job, and it fails closed for
 * a Host-owned record whose owning epoch no longer matches the receipt epoch so
 * a stale obligation can never stop a post-resume run. The default settlement
 * intent is stop(session-end) against matching-receipt evidence; a SubagentStop
 * coordination-loss caller may instead pass its own bounded `intent`
 * ({kind:'stop',cause}|{kind:'observe'}) and `sessionEndReceiptEvidence`
 * ('matching'|'older') so the Reconciler's own policy governs the pass. That
 * caller may also pass `unavailableOutcome: 'retain'` so an unavailable control
 * channel RETAINS the durable cancelling guard instead of archiving the job —
 * coordination loss must never release the writable exclusion while the remote
 * turn is unconfirmed.
 * @param {{store:any,dataRoot:string,workspace:string,ownerSessionId:string,epoch:string|null,endedAt?:string|null,lockTimeoutMs?:number,timeoutMs?:number,createClient:(job:any,ownerId:string)=>Promise<any>,signal?:AbortSignal,includeSettlementEvidence?:boolean,intent?:any,sessionEndReceiptEvidence?:('matching'|'older'),unavailableOutcome?:('retain'),revalidateReceiptBeforeStop?:boolean}} input
 * @param {string} jobId
 */
export async function settleEndedRescueJob(input, jobId) {
  // Every inner store mutation shares this stage's bounded lock budget: the
  // default five-second waits cannot apply inside SessionEnd's shared deadline.
  // The wrapper adds no behavior — it only forwards {signal,timeoutMs} to the
  // store's bounded-option seams (readJob/transitionJob/finishJob).
  const boundedStore = input.signal === undefined && input.timeoutMs === undefined ? input.store : boundedSessionEndStore(input.store, input.signal, input.timeoutMs);
  input = { ...input, store: boundedStore };
  // A proven-not-found read may discharge the obligation; corruption, permission,
  // or a contended lock read must propagate so the caller keeps the obligation
  // pending rather than settling on an unreadable record.
  let selected = null;
  try {
    selected = await input.store.readJob(input.workspace, jobId, { signal: input.signal, timeoutMs: input.timeoutMs });
  } catch (error) {
    if (!isJobNotFound(error)) throw error;
  }
  if (!selected || selected.command !== 'rescue' || selected.readOnly !== false
    || selected.ownerSessionId !== input.ownerSessionId) {
    return input.includeSettlementEvidence === true ? { kind: 'no-active-job', job: null } : null;
  }
  if (TERMINAL.has(selected.status)) {
    const cleaned = await cleanupTerminalReservation(input, selected).catch(() => selected);
    return input.includeSettlementEvidence === true ? classifyEndedSettlement(cleaned) : cleaned;
  }
  if (!endedJobEpochOwned(input.epoch, selected, input.endedAt)) {
    return input.includeSettlementEvidence === true ? { kind: 'epoch-not-owned', job: selected } : selected;
  }
  let settlement;
  try {
    settlement = await withJobCancellationLock({
      dataRoot: input.dataRoot,
      workspace: input.workspace,
      jobId: selected.id,
      timeoutMs: input.lockTimeoutMs ?? 0,
    }, async () => {
      const current = await input.store.readJob(input.workspace, selected.id, { signal: input.signal, timeoutMs: input.timeoutMs });
      if (current.id !== selected.id || current.ownerSessionId !== input.ownerSessionId
        || current.command !== 'rescue' || current.readOnly !== false || TERMINAL.has(current.status)) return classifyEndedSettlement(current);
      if (!endedJobEpochOwned(input.epoch, current, input.endedAt)) return { kind: 'epoch-not-owned', job: current };
      const remotelySettleable = current.status === 'queued'
        || (['running', 'cancelling'].includes(current.status) && typeof current.zcodeSessionId === 'string');
      return remotelySettleable ? settleEndedRescueThroughReconciler(input, current) : { kind: 'retained-writable-guard', job: current };
    });
  } catch (error) {
    if (error instanceof PluginError && error.code === 'LOCK_TIMEOUT') settlement = { kind: 'retained-writable-guard', job: await input.store.readJob(input.workspace, selected.id, { signal: input.signal, timeoutMs: input.timeoutMs }) };
    else throw error;
  }
  try { settlement = { ...settlement, job: await cleanupTerminalReservation(input, settlement.job) }; }
  catch { /* retain the durable settlement winner */ }
  return input.includeSettlementEvidence === true ? settlement : settlement.job;
}

/**
 * Converge one active read-only detached run (Review / Adversarial Review, or a
 * historical read-only Rescue reservation) owned by the ending session. It reuses
 * the existing orphan-recovery settlement (`reconcileOrphan`: exact session
 * listing, bounded remote stop/reread, and winner election) and NEVER the writable
 * Rescue binding interface, then terminates ONLY the recorded worker process tree
 * when that tree still holds its lease. Process death alone is never remote
 * terminal proof: unless stop/reread proves a winner the record stays unresolved,
 * so the receipt keeps it as a pending obligation rather than settling as if the
 * run were absent. `terminateProcessTree` is injectable so callers/tests can
 * observe stop-then-kill ordering without a live process.
 * @param {{store:any,dataRoot:string,workspace:string,ownerSessionId:string,epoch:string|null,endedAt?:string|null,lockTimeoutMs?:number,timeoutMs?:number,deadlineMs?:number,createClient:(job:any,ownerId:string)=>Promise<any>,signal?:AbortSignal,reconcileOwnership?:(input:any)=>Promise<any>,terminateProcessTree?:(pid:number,options:{signal?:AbortSignal,timeoutMs?:number})=>Promise<unknown>,includeSettlementEvidence?:boolean}} input
 * @param {string} jobId
 */
export async function settleEndedReadOnlyDetachedJob(input, jobId) {
  // Bounded inner store operations, exactly like the writable settlement.
  const boundedStore = input.signal === undefined && input.timeoutMs === undefined ? input.store : boundedSessionEndStore(input.store, input.signal, input.timeoutMs);
  input = { ...input, store: boundedStore };
  const terminateProcessTree = input.terminateProcessTree ?? terminateRecordedProcessTree;
  let selected = null;
  let workerTerminated = false;
  try {
    selected = await input.store.readJob(input.workspace, jobId, { signal: input.signal, timeoutMs: input.timeoutMs });
  } catch (error) {
    if (!isJobNotFound(error)) throw error;
  }
  if (!selected || !isReadOnlyDetachedObligation(selected) || selected.ownerSessionId !== input.ownerSessionId) {
    return input.includeSettlementEvidence === true ? { kind: 'no-active-job', job: null } : null;
  }
  if (TERMINAL.has(selected.status)) {
    return input.includeSettlementEvidence === true ? classifyEndedSettlement(selected) : selected;
  }
  let settlement;
  try {
    settlement = await withJobCancellationLock({
      dataRoot: input.dataRoot,
      workspace: input.workspace,
      jobId: selected.id,
      timeoutMs: input.lockTimeoutMs ?? 0,
    }, async () => {
      const current = await input.store.readJob(input.workspace, selected.id, { signal: input.signal, timeoutMs: input.timeoutMs });
      if (current.id !== selected.id || current.ownerSessionId !== input.ownerSessionId
        || !isReadOnlyDetachedObligation(current) || TERMINAL.has(current.status)) return classifyEndedSettlement(current);
      // Bounded exact remote stop + reread + winner election through the existing
      // orphan-recovery path (never the writable binding interface). Local worker
      // termination runs on EVERY exit path after the bounded remote attempt —
      // a remote failure, abort, or deadline must not leave the detached worker
      // alive. Process death is never remote terminal proof: only the reread
      // above can publish a winner, so a remote failure retains the unresolved
      // record for the pending receipt.
      let settled;
      try {
        settled = await reconcileOrphan({ ...input, intent: 'session-end-readonly' }, current);
      } finally {
        workerTerminated = true;
        await terminateLeasedProcessTree(input, current, terminateProcessTree);
      }
      return settled;
    });
  } catch (error) {
    // Even when reconciliation threw before its own termination ran, the
    // recorded worker tree is terminated exactly once: repeating the kill
    // would spend the local termination budget twice and push the hook past
    // its hard deadline.
    if (!workerTerminated && isDigest(selected?.workerLeaseId)) {
      await terminateLeasedProcessTree(input, selected, terminateProcessTree).catch(() => {});
    }
    if (error instanceof PluginError && error.code === 'LOCK_TIMEOUT') return input.includeSettlementEvidence === true ? { kind: 'retained-writable-guard', job: selected } : selected;
    throw error;
  }
  return input.includeSettlementEvidence === true ? classifyEndedSettlement(settlement) : settlement;
}

/**
 * Wrap a StateStore so its mutating seams (readJob/transitionJob/finishJob —
 * and listOwnedJobs, which already accepts options) forward one shared bounded
 * lock budget; callers passing nothing keep every default.
 * @param {any} store @param {AbortSignal|undefined} signal @param {number|undefined} timeoutMs
 */
function boundedSessionEndStore(store, signal, timeoutMs) {
  const options = { ...(signal === undefined ? {} : { signal }), ...(timeoutMs === undefined ? {} : { timeoutMs }) };
  const forward = (/** @type {(workspace:string,jobId:string,expected:readonly string[],next:string,patch:Record<string,unknown>,methodOptions:{signal?:AbortSignal,timeoutMs?:number})=>Promise<unknown>} */ method) =>
    /** @param {string} workspace @param {string} jobId @param {readonly string[]} expected @param {string} next @param {Record<string,unknown>} [patch] @param {{signal?:AbortSignal,timeoutMs?:number}} [methodOptions] */
    async (workspace, jobId, expected, next, patch = {}, methodOptions = {}) =>
      method(workspace, jobId, expected, next, patch, { ...methodOptions, ...options });
  return {
    ...store,
    readJob: /** @param {string} workspace @param {string} jobId @param {{signal?:AbortSignal,timeoutMs?:number}} [methodOptions] */
      async (workspace, jobId, methodOptions = {}) => store.readJob(workspace, jobId, { ...methodOptions, ...options }),
    transitionJob: forward(store.transitionJob.bind(store)),
    finishJob: forward(store.finishJob.bind(store)),
    // The remaining job-state-lock seams the settle path reaches — bound-stop
    // revalidation (read-only detached convergence), queued recovery terminalization,
    // and terminal reservation cleanup — are wrapped ONLY when the underlying
    // store provides them, so callers' feature probes keep their exact semantics.
    ...(typeof store.revalidateBoundRescueStop === 'function'
      ? { revalidateBoundRescueStop: /** @param {any} input */ (input) => store.revalidateBoundRescueStop({ ...input, ...options }) } : {}),
    ...(typeof store.finishQueuedJobAfterRecoveryLease === 'function'
      ? { finishQueuedJobAfterRecoveryLease: /** @param {string} workspace @param {string} jobId @param {string|null} expectedWorkerLeaseId @param {any} rollback @param {string} nextStatus @param {Record<string,unknown>} [patch] @param {{signal?:AbortSignal,timeoutMs?:number}} [methodOptions] */
        (workspace, jobId, expectedWorkerLeaseId, rollback, nextStatus, patch = {}, methodOptions = {}) =>
          store.finishQueuedJobAfterRecoveryLease(workspace, jobId, expectedWorkerLeaseId, rollback, nextStatus, patch, { ...methodOptions, ...options }) } : {}),
    ...(typeof store.cleanupTerminalExecutionReservation === 'function'
      ? { cleanupTerminalExecutionReservation: /** @param {string} workspace @param {string} jobId @param {any} identity @param {{signal?:AbortSignal,timeoutMs?:number}} [methodOptions] */
        (workspace, jobId, identity, methodOptions = {}) =>
          store.cleanupTerminalExecutionReservation(workspace, jobId, identity, { ...methodOptions, ...options }) } : {}),
  };
}

/**
 * Terminate the exact recorded worker tree ONLY while its worker lease is still
 * HELD: an acquirable (free) lease means the worker already exited and released,
 * and the OS may have reused its pid — signaling it could kill an unrelated
 * process group. A LOCK_TIMEOUT proves a live holder still owns the lease, so
 * the recorded pid is still that worker. Records without a digest lease never
 * signal.
 * @param {any} input @param {any} job @param {(pid:number,options:{signal?:AbortSignal,timeoutMs?:number})=>Promise<unknown>} terminateProcessTree
 */
async function terminateLeasedProcessTree(input, job, terminateProcessTree) {
  if (!isDigest(job.workerLeaseId) || !Number.isSafeInteger(job.childPid) || job.childPid <= 0) return;
  try {
    await withWorkerLease({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: job.id, workerLeaseId: job.workerLeaseId, timeoutMs: 0 }, async () => {
      // The lease was FREE — the recorded worker already released it, so the
      // recorded pid is no longer proven to be that worker. Never signal it.
      return undefined;
    });
  } catch (error) {
    if (error instanceof PluginError && error.code === 'LOCK_TIMEOUT') {
      // A live holder still owns the lease: the recorded pid is still that
      // worker's group leader — the exact recorded tree, safe to terminate.
      // Local termination runs inside the caller's ABSOLUTE deadline when one
      // is proven (the stale initial remote timeout would grant a fresh budget
      // after the shared budget is already spent), capped at 750ms; when the
      // deadline is already spent, the kill is skipped and the pending receipt
      // remains the compensation authority. The remote-control signal never
      // gates this local kill.
      const absoluteDeadlineMs = typeof input.deadlineMs === 'number' && Number.isFinite(input.deadlineMs)
        ? input.deadlineMs - Date.now()
        : (typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) ? input.timeoutMs : 1_000);
      const terminationBudgetMs = Math.min(absoluteDeadlineMs, 750);
      if (terminationBudgetMs <= 0) return;
      // Re-probe once immediately before signaling: the first LOCK_TIMEOUT may
      // predate a scheduling gap in which the worker released its lease, exited,
      // and its pid was reused — signaling then could hit an unrelated process.
      // A second zero-timeout contention observation keeps the identity proof as
      // close to the kill as the lease protocol allows.
      try {
        await withWorkerLease({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: job.id, workerLeaseId: job.workerLeaseId, timeoutMs: 0 }, async () => undefined);
        return;
      } catch (reprobeError) {
        if (!(reprobeError instanceof PluginError && reprobeError.code === 'LOCK_TIMEOUT')) throw reprobeError;
      }
      await terminateProcessTree(job.childPid, { timeoutMs: terminationBudgetMs });
      return;
    }
    throw error;
  }
}

/**
 * Durably delegate one SessionEnd obligation that could not be terminally
 * settled within the bounded budget: persist its exact session-end stop intent
 * (transitioning a running writable Rescue to cancelling, the durable stop
 * intent the receipt can delegate to) without ever touching the remote broker.
 * An already-terminal or already-cancelling record is already delegated and is
 * returned untouched. This never claims a stopped terminal on uncertainty.
 * @param {{store:any,dataRoot:string,workspace:string,ownerSessionId:string,epoch?:string|null,endedAt?:string|null,signal?:AbortSignal,timeoutMs?:number}} input
 * @param {string} jobId
 */
export async function delegateEndedStopIntent(input, jobId) {
  // The delegated stop intent is the durable evidence the receipt settles on, so
  // this write shares the caller's bounded lock budget like every other SessionEnd
  // state touch; it also re-validates the epoch so a stale discovery can never
  // delegate a stop onto a post-resume (newer-epoch) run.
  const lockOptions = { ...(input.signal === undefined ? {} : { signal: input.signal }), ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) };
  const current = await input.store.readJob(input.workspace, jobId, lockOptions);
  if (current.ownerSessionId !== input.ownerSessionId || current.command !== 'rescue' || current.readOnly !== false) {
    throw recoveryError("The delegated job is not this owner's writable Rescue.");
  }
  if (!endedJobEpochOwned(typeof input.epoch === 'string' ? input.epoch : null, current, input.endedAt)) {
    throw recoveryError('The delegated job belongs to another host lifecycle epoch.');
  }
  if (TERMINAL.has(current.status)) return current;
  if (current.status === 'cancelling') {
    // An already delegated record is returned as the discharge evidence, but a
    // coordination-loss intent that outran its epoch's receipt publication is
    // corrected to session-end first: the matching receipt owns the boundary.
    if (validStopIntent(current.stopIntent)) return correctReceiptWinningStopCause(input, current);
    const patch = hostOwnedStopIntentPatch(current, 'session-end');
    // A legacy record carries no stop intent; leaving it as the durable cancelling
    // guard matches the pre-receipt settle path exactly.
    if (!('stopIntent' in patch)) return current;
    return input.store.transitionJob(input.workspace, current.id, ['cancelling'], 'cancelling', patch, lockOptions);
  }
  if (current.status !== 'running') return current;
  return input.store.transitionJob(input.workspace, current.id, ['running'], 'cancelling',
    hostOwnedStopIntentPatch(current, 'session-end'), lockOptions);
}

/** A Host-owned record is only this receipt's obligation when its owning epoch
 * matches exactly. A record without the lifecycle trio cannot name its epoch —
 * its boundary evidence is its creation time: only a record that existed by the
 * receipt's own endedAt can belong to this boundary, so a post-resume successor
 * run (created after the end timestamp) is never this receipt's obligation and,
 * conversely, always marks its workspace unsafe to release. Without a proven
 * epoch, or without a durable endedAt, the legacy settle semantics is preserved.
 * @param {string|null} epoch @param {any} job @param {unknown} [endedAt] */
function endedJobEpochOwned(epoch, job, endedAt = undefined) {
  if (typeof epoch !== 'string') return true;
  if (validHostLifecycleRecord(job)) return job.ownerLifecycleEpoch === epoch;
  // Strictly before: a record written exactly at the boundary millisecond can
  // be a successor's creation in the concurrent resume race, and treating it
  // as this epoch's would let an old receipt stop successor work.
  return typeof endedAt !== 'string' || Date.parse(job.createdAt) < Date.parse(endedAt);
}

/** @param {any} input */
async function settleSelectedJob(input) {
  return withJobCancellationLock({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: input.selectedJobId }, async () => {
    const current = await input.store.readJob(input.workspace, input.selectedJobId);
    if (current.id !== input.selectedJobId || current.ownerSessionId !== input.expectedOwnerSessionId || TERMINAL.has(current.status)) return current;
    if (input.intent === 'scavenge' && (current.command !== 'rescue' || current.readOnly !== false)) return current;
    const workerLeaseId = recoveryWorkerLease(current);
    if (current.status === 'queued') return !isDigest(workerLeaseId)
      && (input.now ?? Date.now)() - Date.parse(current.createdAt) < LEGACY_QUEUED_STALE_MS
      ? current : failJob(input, current, recoveryError(isDigest(workerLeaseId)
        ? 'Claimed queued worker exited before execution started.'
        : 'Queued reservation exceeded the conservative worker-claim grace period.'));
    if (!isDigest(workerLeaseId) && legacyWorkerAlive(current)) return current;
    if (!isDigest(workerLeaseId)) return reconcileOrphan(input, current);
    try {
      return await withWorkerLease({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: current.id, workerLeaseId, timeoutMs: 0 }, () => reconcileOrphan(input, current));
    } catch (error) {
      if (error instanceof PluginError && error.code === 'LOCK_TIMEOUT') return current;
      throw error;
    }
  });
}

/** Select only an exact claimed or private fenced worker lease. Corrupt authority is uncertainty, not absence. @param {any} job */
function recoveryWorkerLease(job) {
  if (job.workerLeaseId !== undefined && !isDigest(job.workerLeaseId)) throw recoveryError('Persisted worker lease is invalid.');
  const authority = job.rescueExecutionReservation;
  if (authority === undefined) return job.workerLeaseId;
  const keys = typeof authority === 'object' && authority !== null && !Array.isArray(authority)
    ? Object.keys(authority).sort().join(',') : '';
  const sealed = ['capabilityDigest,jobId,jobSpecFormat,operation,ownerSessionId,reservationId,version,workspace',
    'capabilityDigest,jobId,jobSpecFormat,operation,ownerSessionId,reservationId,version,workerLeaseId,workspace'].includes(keys)
    && authority.jobSpecFormat === 'sealed-v2' && authority.specDigest === undefined;
  const legacy = ['capabilityDigest,jobId,jobSpecFormat,operation,ownerSessionId,reservationId,specDigest,version,workspace',
    'capabilityDigest,jobId,jobSpecFormat,operation,ownerSessionId,reservationId,specDigest,version,workerLeaseId,workspace'].includes(keys)
    && authority.jobSpecFormat === 'legacy-v1' && isDigest(authority.specDigest);
  if ((!sealed && !legacy) || authority.version !== 1 || !isDigest(authority.capabilityDigest)
    || !isDigest(authority.reservationId) || authority.jobId !== job.id
    || authority.ownerSessionId !== job.ownerSessionId || authority.workspace !== job.workspace
    || authority.operation !== 'run-reserved-job'
    || authority.workerLeaseId !== undefined && !isDigest(authority.workerLeaseId)
    || job.workerLeaseId !== undefined && authority.workerLeaseId !== job.workerLeaseId) {
    throw recoveryError('Persisted execution reservation authority is invalid.');
  }
  return job.workerLeaseId ?? authority.workerLeaseId;
}

/** @param {any} input @param {any} job */
async function reconcileOrphan(input, job) {
  let client;
  let jobLog;
  if (job.status === 'queued') return failJob(input, job, recoveryError('Queued worker reservation is orphaned.'));
  if (typeof job.zcodeSessionId !== 'string') return failJob(input, job, recoveryError('Worker exited before a remote session was accepted.'));
  input = { ...input, boundStopGuard: await revalidateBoundRescueStop(input, job) };
  if (input.boundStopGuard?.kind === 'stale') return input.boundStopGuard.job;
  const ownerId = ownerIdForSession(job.ownerSessionId);
  try {
    // Ownership reconciliation shares the stage budget: a contended
    // session-owners lock must never delay local worker termination past the
    // SessionEnd deadline (an aborted ownership pass settles through the same
    // retain paths as any other remote failure).
    await raceRecoveryControl(Promise.resolve().then(() => (input.reconcileOwnership ?? reconcileBrokerOwnership)({ dataRoot: input.dataRoot, workspace: input.workspace, ownerId, ownedSessionIds: [job.zcodeSessionId],
      // The ownership pass must be bounded by the SAME shared budget, not its
      // default five-second lock timer: racing only the caller-facing promise
      // leaves the underlying wait holding the hook process alive.
      timeoutMs: Math.max(0, Math.min(typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) ? input.timeoutMs : 1_000, 1_000)) })), input.signal);
    throwIfRecoveryInterrupted(input);
  } catch (error) {
    throwIfRecoveryInterrupted(input, error);
    return retainAfterStopFailure(input, job, error);
  }
  try {
    try {
      client = await input.createClient(job, ownerId);
      throwIfRecoveryInterrupted(input);
    } catch (error) {
      throwIfRecoveryInterrupted(input, error);
      return input.intent === 'scavenge' && controlChannelUnavailable(error)
        ? settleUnavailableOrMissingOrphan(input, job, unavailableOrphanError('managed-establishment'))
        : retainAfterStopFailure(input, job, error);
    }
    if (!client) {
      throwIfRecoveryInterrupted(input);
      return retainAfterStopFailure(input, job, recoveryError('The ZCode recovery client is unavailable.'));
    }
    jobLog = await openRecoveryJobLog(input, job);
    let listed;
    try { listed = await client.listSessions(); }
    catch (error) { throwIfRecoveryInterrupted(input, error); return input.intent === 'scavenge' && controlChannelUnavailable(error) ? settleUnavailableOrMissingOrphan(input, job, establishedUnavailableOrphanError(error)) : stopThenSettle(input, job, client, error, jobLog); }
    throwIfRecoveryInterrupted(input);
    if (!Array.isArray(listed?.sessions)) return stopThenSettle(input, job, client, recoveryError('ZCode session listing is malformed during recovery.'), jobLog);
    if (!listed.sessions.some((/** @type {any} */ session) => session.sessionId === job.zcodeSessionId)) return settleUnavailableOrMissingOrphan(input, job, recoveryError('ZCode session is missing during recovery.'));
    if (job.command === 'transfer') return stopThenSettle(input, job, client, recoveryError('Transfer worker exited before local finalization.'), jobLog);
    const boundary = persistedTurnBoundary(job);
    if (!boundary) return stopThenSettle(input, job, client, recoveryError('The durable turn boundary is incomplete.'), jobLog);
    let snapshot;
    try { snapshot = await client.readSession(job.zcodeSessionId); }
    catch (error) { throwIfRecoveryInterrupted(input, error); return input.intent === 'scavenge' && controlChannelUnavailable(error) ? failJob(input, job, establishedUnavailableOrphanError(error)) : stopThenSettle(input, job, client, error, jobLog); }
    throwIfRecoveryInterrupted(input);
    if (!Number.isSafeInteger(snapshot?.runtime?.stateRevision) || snapshot.runtime.stateRevision < job.startRevision) return stopThenSettle(input, job, client, recoveryError('ZCode recovery state is older than the accepted turn boundary.'), jobLog);
    const classification = classifyCurrentTurnSnapshot(snapshot, boundary);
    const remoteStatus = snapshot?.projection?.status;
    if (classification.kind === 'succeeded') return completeJob(input, job, snapshot, 'fail', jobLog);
    if (classification.kind === 'failed') return job.status === 'cancelling'
      ? cancelJob(input, job)
      : failJob(input, job, recoveryError(snapshot?.projection?.lastError?.message ?? 'ZCode reported a terminal error during recovery.'));
    if (classification.kind === 'interrupted') return job.status === 'cancelling'
      ? cancelJob(input, job)
      : failJob(input, job, recoveryError('The remote turn was interrupted before recovery completed.'));
    if (REMOTE_ACTIVE.has(remoteStatus)) {
      if (!hasCurrentTurnActivity(snapshot, boundary)) return input.store.readJob(input.workspace, job.id);
      if (job.status === 'cancelling' || input.intent === 'scavenge' || input.intent === 'session-end-readonly') return stopThenSettle(input, job, client, recoveryError('The remote turn remained active after its executor exited.'), jobLog);
      return job;
    }
    if (remoteStatus === 'paused') {
      if (!hasCurrentTurnActivity(snapshot, boundary)) return input.store.readJob(input.workspace, job.id);
      return job.status === 'cancelling' || input.intent === 'session-end-readonly'
        ? stopThenSettle(input, job, client, recoveryError('The cancelling remote turn is paused.'), jobLog)
        : failJob(input, job, recoveryError('The orphaned remote turn is paused.'));
    }
    if (!['completed', 'idle'].includes(remoteStatus)) return stopThenSettle(input, job, client, recoveryError('ZCode recovery state is ambiguous.'), jobLog);
    return job;
  } catch (error) {
    throwIfRecoveryInterrupted(input, error);
    if (error instanceof SuccessfulResultFinalizationError) throw error;
    const current = await input.store.readJob(input.workspace, job.id);
    if (TERMINAL.has(current.status)) return current;
    return input.intent === 'scavenge' && controlChannelUnavailable(error)
      ? settleUnavailableOrMissingOrphan(input, current, establishedUnavailableOrphanError(error))
      : stopThenSettle(input, current, client, error, jobLog);
  } finally { await client?.close().catch(() => {}); await jobLog?.close(Date.now() + OPTIONAL_JOB_LOG_FENCE_MS); }
}

/** Resolve exact rollback evidence for atomic queued terminalization. @param {any} input @param {any} job */
async function queuedMigrationRollback(input, job) {
  return readQueuedRescueMigrationRollback({ dataRoot: input.dataRoot, workspace: input.workspace, job, store: input.store,
    invalid: () => recoveryError('Queued migration specification is invalid.') });
}
/** @param {any} input @param {any} job @param {unknown} error */
export async function failJob(input, job, error) {
  const current = await input.store.readJob(input.workspace, job.id);
  if (TERMINAL.has(current.status)) return current;
  const patch = { error: { message: recoveryMessage(error) }, exitCode: 1 };
  if (current.status === 'queued') return finishQueuedJobAfterLeaseProbe(input, current, 'failed', patch);
  try { return await input.store.finishJob(input.workspace, job.id, [current.status], 'failed', patch); }
  catch (transitionError) { return conflictWinner(input, job, transitionError); }
}
/** @param {any} input @param {any} job @param {string} [stopCause] */
export async function cancelJob(input, job, stopCause = 'host-coordination-loss') {
  const current = await input.store.readJob(input.workspace, job.id);
  if (TERMINAL.has(current.status)) return current;
  try {
    const cancelling = current.status === 'running'
      ? await input.store.transitionJob(input.workspace, job.id, ['running'], 'cancelling', hostOwnedStopIntentPatch(current, stopCause))
      : current;
    return await input.store.finishJob(input.workspace, job.id, ['cancelling'], 'cancelled',
      { exitCode: null, ...hostOwnedCancelledPatch(cancelling, stopCause) });
  } catch (error) { return cancelledConflictWinner(input, job, error); }
}
/** @param {any} input @param {any} job @param {string} [stopCause] */
async function cancelQueuedJob(input, job, stopCause = 'host-coordination-loss') {
  const current = await input.store.readJob(input.workspace, job.id);
  if (TERMINAL.has(current.status) || current.status !== 'queued') return current;
  try { return await finishQueuedJobAfterLeaseProbe(input, current, 'cancelled', { exitCode: null, ...hostOwnedCancelledPatch(current, stopCause) }); }
  catch (error) { return cancelledConflictWinner(input, job, error); }
}

/** Re-read, probe the exact effective lease, then let State CAS that same lease at terminal publication. @param {any} input @param {any} job @param {'failed'|'cancelled'} nextStatus @param {any} patch */
async function finishQueuedJobAfterLeaseProbe(input, job, nextStatus, patch) {
  const current = await input.store.readJob(input.workspace, job.id);
  if (TERMINAL.has(current.status) || current.status !== 'queued') return current;
  const workerLeaseId = recoveryWorkerLease(current); const rollback = await queuedMigrationRollback(input, current);
  const finish = () => input.store.finishQueuedJobAfterRecoveryLease(input.workspace, current.id,
    workerLeaseId ?? null, rollback, nextStatus, patch);
  try {
    return isDigest(workerLeaseId)
      ? await withWorkerLease({ dataRoot: input.dataRoot, workspace: input.workspace,
        jobId: current.id, workerLeaseId, timeoutMs: 0 }, finish)
      : await finish();
  } catch (error) {
    if (error instanceof PluginError && ['LOCK_TIMEOUT', 'WORKER_LEASE_CONFLICT'].includes(error.code)) {
      return input.store.readJob(input.workspace, current.id);
    }
    throw error;
  }
}

/** @param {any} input @param {any} job @param {unknown} error */
async function cancelledConflictWinner(input, job, error) {
  try {
    return await durableCancelledWinner({
      store: input.store,
      workspace: input.workspace,
      jobId: job.id,
      ownerSessionId: job.ownerSessionId,
    }, error);
  } catch (winnerError) { return conflictWinner(input, job, winnerError); }
}

/**
 * Settle the ending owner's exact writable Rescue through the Rescue Lifecycle
 * Reconciler. The Reconciler owns the complete mutation order — persist the
 * durable stop intent first, revalidate the exact binding/job/generation, stop
 * and reread the exact remote turn, elect the winner, retain uncertainty —
 * while these adapters bind that order to the durable store, the existing
 * cancellation machinery, and one existing ZCode control client.
 * @param {any} input @param {any} current
 */
async function settleEndedRescueThroughReconciler(input, current) {
  // Receipt-wins backstop FIRST: an intent persisted before a racing receipt
  // publication keeps the durable coordination-loss cause until this pass
  // corrects it, and every later projection (joined stop intent, retained
  // guard, cancelled winner's stop cause) must derive from the corrected record.
  current = await correctReceiptWinningStopCause(input, current);
  /** @type {{job:any,client?:any,jobLog?:any,guard?:any,racedWinner?:any}} */
  const context = { job: current };
  // A queued reservation never reached a remote session, so there is no remote
  // stop for the exact-binding guard to fence: skip revalidation (whose 'no
  // active anchor' stale classification must not skip queued terminalization)
  // and let the reconciler's own ownership CAS terminalize it.
  const observedStop = current.status === 'queued' ? null : await revalidateBoundRescueStop(input, current);
  if (observedStop?.kind === 'stale') return classifyEndedSettlement(observedStop.job);
  context.guard = observedStop?.guard;
  try {
    const outcome = await createRescueLifecycleReconciler({
      loadJoinedState: (/** @type {any} */ request) => loadEndedRescueJoinedState(input, context, request),
      persistStopIntent: (/** @type {any} */ joined, /** @type {any} */ cause, /** @type {any} */ options) => persistEndedStopIntent(input, context, joined, cause, options),
      revalidateGeneration: async (/** @type {any} */ joined, /** @type {any} */ options) => {
        options?.signal?.throwIfAborted();
        const revalidated = await revalidateBoundRescueStop(input, joined.job, context.guard);
        if (revalidated?.kind === 'stale') {
          if (!TERMINAL.has(revalidated.job.status)) context.racedWinner = revalidated.job;
          return { kind: 'stale', winner: revalidated.job, resumableEvidence: racedResumableEvidence(revalidated.job) };
        }
        context.guard = revalidated?.guard ?? context.guard ?? null;
        context.job = revalidated?.job ?? joined.job;
        return { kind: 'current', job: context.job, guard: context.guard };
      },
      stopExactTurn: async (/** @type {any} */ joined, /** @type {any} */ options) => {
        // Pre-stop read (retry passes only — already cancelling with a persisted
        // stop intent from a prior reconciliation pass): a turn that already
        // reached a terminal outcome BEFORE this stop keeps its own semantics
        // instead of being misclassified as caused by the stop. A first-stop
        // running pass skips it: the initial joined read observed the remote
        // state moments before, and the post-stop reread owns terminal
        // evidence — mirroring the job-control election's retry gating.
        const retryStop = joined.job.status === 'cancelling' && validStopIntent(joined.job.stopIntent);
        if (retryStop) try {
          const preStop = endedRemoteEvidence(await raceRecoveryControl(context.client.readSession(joined.job.zcodeSessionId), options?.signal), joined.job);
          if (preStop.kind === 'evidence' && (preStop.classification === 'succeeded' || preStop.classification === 'failed')) {
            return { acknowledged: true, preExistingTerminal: preStop };
          }
        } catch { /* an unreadable pre-stop read never blocks the exact stop */ }
        options?.signal?.throwIfAborted();
        try {
          await raceRecoveryControl(context.client.stopSession(joined.job.zcodeSessionId), options?.signal);
          options?.signal?.throwIfAborted();
          return { acknowledged: true };
        } catch (error) {
          options?.signal?.throwIfAborted();
          return { acknowledged: false, error };
        }
      },
      rereadRemote: async (/** @type {any} */ joined, /** @type {any} */ options) => {
        options?.signal?.throwIfAborted();
        let snapshot;
        try { snapshot = await raceRecoveryControl(context.client.readSession(joined.job.zcodeSessionId), options?.signal); }
        catch (error) { options?.signal?.throwIfAborted(); return { kind: 'unreadable', error }; }
        options?.signal?.throwIfAborted();
        return endedRemoteEvidence(snapshot, joined.job);
      },
      publishWinner: (/** @type {any} */ joined, /** @type {any} */ specification, /** @type {any} */ options) => publishEndedWinner(input, context, joined, specification, options),
      retainUnresolved: async (/** @type {any} */ joined, /** @type {any} */ evidence) => {
        const retained = await retainUnresolvedEndedStop(input, joined.job, evidence?.error);
        context.job = retained;
        return retained;
      },
      settleUnavailableExecutor: (/** @type {any} */ joined, /** @type {any} */ evidence) => input.unavailableOutcome === 'retain'
        // Coordination-loss callers retain on unconfirmed control: an unavailable
        // executor never proves the remote turn ended, so the durable cancelling
        // guard (status + stop intent + writable exclusion) must be kept exactly
        // like any other unresolved stop — never archived as failed.
        ? retainUnresolvedEndedStop(input, joined.job, undefined)
        : failEndedUnavailableJob(input, joined.job, evidence.error),
    }).reconcile({
      intent: input.intent ?? { kind: 'stop', cause: 'session-end' },
      authority: { ownerSessionId: input.ownerSessionId },
      workspace: input.workspace,
      selector: { jobId: current.id },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const winner = context.racedWinner ?? await input.store.readJob(input.workspace, current.id);
    return outcome.kind === 'settled-terminal' ? classifyEndedSettlement(winner) : { kind: 'retained-writable-guard', job: winner };
  } finally {
    await context.client?.close().catch(() => {});
    await context.jobLog?.close(Date.now() + OPTIONAL_JOB_LOG_FENCE_MS);
  }
}

/** Race one recovery control operation against its abort signal so a stuck stop or read can never outlive the settlement budget; the abandoned operation's late rejection is absorbed. @param {Promise<any>} operation @param {AbortSignal|undefined} signal */
function raceRecoveryControl(operation, signal) {
  operation.catch(() => {});
  if (signal === undefined) return operation;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then((value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}

/** Join the ending owner's exact job with existing ZCode control evidence. @param {any} input @param {{job:any,client?:any,jobLog?:any}} context @param {any} request */
async function loadEndedRescueJoinedState(input, context, request) {
  if (request.selector?.jobId !== context.job.id) throw recoveryError('The ended Rescue settlement selector no longer matches.');
  const receiptEvidence = input.sessionEndReceiptEvidence ?? 'matching';
  const job = context.job;
  if (job.status === 'queued') return endedJoined(job, { kind: 'none' }, receiptEvidence);
  context.jobLog = await openRecoveryJobLog(input, job);
  try {
    context.client = await input.createClient(job, ownerIdForSession(job.ownerSessionId));
  } catch (error) {
    throwIfRecoveryInterrupted(input, error);
    return endedJoined(job, unavailableOrReadableEvidence(error), receiptEvidence);
  }
  throwIfRecoveryInterrupted(input);
  if (!context.client) {
    throwIfRecoveryInterrupted(input);
    return endedJoined(job, { kind: 'unavailable', error: unavailableOrphanError('existing-broker-missing') }, receiptEvidence);
  }
  let snapshot;
  try { snapshot = await context.client.readSession(job.zcodeSessionId); throwIfRecoveryInterrupted(input); }
  catch (error) {
    throwIfRecoveryInterrupted(input, error);
    return endedJoined(job, unavailableOrReadableEvidence(error), receiptEvidence);
  }
  return endedJoined(job, endedRemoteEvidence(snapshot, job), receiptEvidence);
}

/** Map one control-channel failure onto bounded existing-executor evidence. @param {unknown} error */
export function unavailableOrReadableEvidence(error) {
  return controlChannelUnavailable(error)
    ? { kind: 'unavailable', error: establishedUnavailableOrphanError(error) }
    : { kind: 'unreadable', error };
}

/**
 * Project one ended-owner job into the private joined Reconciler view.
 * SessionEnd-caller-specific: bindingCurrent/permissionMatch/hostState/receipt
 * are asserted by this caller's own session-boundary authority, never derived —
 * do not reuse as generic joined-state evidence. A persisted stop intent is
 * durable authorization, NOT evidence that a stop occurred, so it never marks
 * the joined state as post-stop; within-pass stop semantics are owned by the
 * reconciler's stopExactTurn/reread sequence. The receipt evidence defaults to
 * the SessionEnd caller's matching receipt; a SubagentStop coordination-loss
 * caller threads its own computed evidence ('matching'|'older') so the
 * Reconciler's stop-cause policy sees exactly the authority its caller proved.
 * @param {any} job @param {any} remote @param {('matching'|'older')} [sessionEndReceipt]
 */
function endedJoined(job, remote, sessionEndReceipt = 'matching') {
  return {
    job,
    winner: null,
    hostState: 'absent',
    hostPlacement: job.hostPlacement ?? null,
    hostOwned: validHostLifecycleRecord(job),
    sessionEndReceipt,
    stopIntent: job.stopIntent ?? null,
    resumableEvidence: {
      acceptedSession: typeof job.zcodeSessionId === 'string',
      bindingCurrent: true,
      permissionMatch: true,
    },
    remote,
    guard: null,
  };
}

/** Classify the exact current-turn evidence of one ended-owner remote read; terminal evidence carries its snapshot so the natural-success winner can publish the authoritative result. @param {any} snapshot @param {any} job */
export function endedRemoteEvidence(snapshot, job) {
  const boundary = persistedTurnBoundary(job);
  const active = EVIDENCE_ACTIVE.has(snapshot?.projection?.status);
  if (!boundary) return { kind: 'evidence', classification: 'pending', active, attributable: false };
  const classification = classifyCurrentTurnSnapshot(snapshot, boundary);
  if (classification.kind !== 'pending') return { kind: 'evidence', classification: classification.kind, active: false, attributable: true, snapshot };
  return { kind: 'evidence', classification: 'pending', active, attributable: hasCurrentTurnActivity(snapshot, boundary) };
}

/**
 * Retain one unresolved SessionEnd stop without ever rolling the durable
 * status back to running: a cancelling job keeps its status, its persisted
 * stop intent, and its writable guard. The StateStore schema admits
 * lastCancelError only on running or terminal records, so the persisted
 * intent is the bounded retry evidence; a non-cancelling job (not expected
 * after intent persistence) keeps the legacy running-retention diagnostic.
 * @param {any} input @param {any} job @param {unknown} [error]
 */
async function retainUnresolvedEndedStop(input, job, error) {
  const current = await input.store.readJob(input.workspace, job.id);
  if (TERMINAL.has(current.status) || error === undefined) return current;
  // A cancelling record WITH a persisted stop intent keeps its status and
  // persists the bounded failure diagnostic (public status strips the private
  // intent, so the diagnostic is the only visible retry evidence); a legacy
  // cancelling record (no intent schema) keeps its status with NO diagnostic —
  // the schema admits lastCancelError on cancelling only with a valid intent.
  if (current.status === 'cancelling') {
    return validStopIntent(current.stopIntent) ? retainAfterStopFailure(input, current, error) : current;
  }
  return retainAfterStopFailure(input, current, error);
}

/** Persist the durable stop intent before any remote control; a queued job embeds it in its terminal patch. @param {any} input @param {{job:any,racedWinner?:any}} context @param {any} joined @param {string} cause @param {{signal?:AbortSignal}} [options] */
async function persistEndedStopIntent(input, context, joined, cause, options) {
  options?.signal?.throwIfAborted();
  if (joined.job.status === 'queued') return { kind: 'persisted', job: joined.job };
  const current = await input.store.readJob(input.workspace, joined.job.id);
  if (TERMINAL.has(current.status)) return { kind: 'conflict', winner: current };
  if (current.status === 'cancelling') {
    // The concurrent persist may itself have outrun a receipt publication; the
    // correction backstop re-checks the matching receipt before replaying it.
    context.job = await correctReceiptWinningStopCause(input, current);
    return { kind: 'persisted', job: context.job };
  }
  try {
    // The receipt recheck runs INSIDE the transitionJob state lock via the
    // stopCauseRevalidator seam: SessionEnd receipt publication does not take
    // this lock, so evaluating the cause inside the mutation is the only way
    // to keep the durable cause from lagging the authoritative boundary.
    const cancelling = await input.store.transitionJob(input.workspace, current.id, ['running'], 'cancelling',
      hostOwnedStopIntentPatch(current, cause),
      { stopCauseRevalidator: () => revalidatedStopCause(input, joined, cause) });
    context.job = cancelling;
    return { kind: 'persisted', job: cancelling };
  } catch (error) {
    const winner = await cancelledConflictWinner(input, current, error);
    if (!TERMINAL.has(winner.status)) context.racedWinner = winner;
    return { kind: 'conflict', winner, resumableEvidence: racedResumableEvidence(winner) };
  }
}

/**
 * Re-read the ending epoch's SessionEnd receipt inside the serialized mutation
 * just before the stop intent is first persisted (opt-in via
 * `revalidateReceiptBeforeStop`): a receipt published between the caller's
 * initial evidence read and this persist must win the cause selection, because
 * the later SessionEnd reconciliation preserves the FIRST persisted cause and
 * the matching receipt would otherwise never own its own boundary. An absent or
 * unreadable receipt keeps the caller's own cause — the exact fail-safe the
 * initial selection used.
 * @param {any} input @param {any} joined @param {string} cause
 */
async function revalidatedStopCause(input, joined, cause) {
  if (input.revalidateReceiptBeforeStop !== true || !isDigest(joined.job?.ownerLifecycleEpoch)) return cause;
  const receipt = await createHostLifecycleStore({ dataRoot: input.dataRoot })
    .readReceipt(joined.job.ownerLifecycleEpoch).catch(() => null);
  return receipt === null ? cause : 'session-end';
}

/**
 * Post-write backstop for the receipt-publication race the in-lock revalidator
 * cannot close (publication takes the independent receipt lock, so a receipt
 * landing between the revalidator's read and the job write still persists
 * `host-coordination-loss`): when a later reconciliation pass observes a
 * retained `cancelling` guard whose persisted intent still carries the
 * pre-publication coordination-loss cause while the matching-epoch receipt now
 * exists durably, the cause is one-way corrected to `session-end` under the
 * state lock before the guard is retained or discharged. Any other cause, a
 * missing or unreadable receipt, and legacy or non-cancelling records are
 * returned untouched; the correction never claims a stopped terminal.
 * @param {any} input @param {any} job
 */
async function correctReceiptWinningStopCause(input, job) {
  if (typeof input.store?.correctCoordinationLossStopCause !== 'function' || job?.status !== 'cancelling'
    || !validStopIntent(job.stopIntent) || job.stopIntent.cause !== 'host-coordination-loss'
    || !isDigest(job.ownerLifecycleEpoch)) return job;
  const receipt = await createHostLifecycleStore({ dataRoot: input.dataRoot })
    .readReceipt(job.ownerLifecycleEpoch).catch(() => null);
  if (receipt === null) return job;
  return input.store.correctCoordinationLossStopCause(input.workspace, job.id,
    { ...(input.signal === undefined ? {} : { signal: input.signal }), ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) });
}

/** Refreshed post-race evidence for a raced winner: staleness was proven by an exact binding/job/generation mismatch, so the binding is not current for the stale caller's job. @param {any} winner */
function racedResumableEvidence(winner) {
  return { acceptedSession: typeof winner.zcodeSessionId === 'string', bindingCurrent: false, permissionMatch: true };
}

/** Publish one durable settlement winner through the existing cancellation and result machinery. @param {any} input @param {{job:any,jobLog?:any}} context @param {any} joined @param {any} specification @param {{signal?:AbortSignal}} [options] */
async function publishEndedWinner(input, context, joined, specification, options) {
  options?.signal?.throwIfAborted();
  if (specification.status === 'cancelled') {
    const cancelled = joined.job.status === 'queued'
      ? await cancelQueuedJob(input, joined.job, specification.stopCause)
      : await cancelJob(input, joined.job, specification.stopCause);
    context.job = cancelled;
    return cancelled;
  }
  if (specification.status === 'succeeded') {
    const completed = await completeEndedJob(input, joined.job, specification.snapshot, context.jobLog);
    if (!completed) return joined.job; /* completion unproven: uncertainty never publishes a terminal claim */
    context.job = completed;
    return completed;
  }
  const failed = await failJob(input, joined.job, recoveryError(specification.message ?? 'ZCode settlement failed during recovery.'));
  context.job = failed;
  return failed;
}

/** Return null when completion is not proven and leave the durable job active. @param {any} input @param {any} job @param {any} snapshot @param {any} jobLog */
export async function completeEndedJob(input, job, snapshot, jobLog) {
  const boundary = persistedTurnBoundary(job);
  if (!boundary || classifyCurrentTurnSnapshot(snapshot, boundary).kind !== 'succeeded') return null;
  let resultArtifact;
  let result;
  try {
    result = extractFinalResult(snapshot, job.command, boundary);
    resultArtifact = await writeResultArtifact({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: job.id, contents: result });
  } catch { return null; }
  const finalization = await finishRecoveredResult(input, job, resultArtifact);
  await appendRecoveredFinal(jobLog, finalization, result);
  return finalization.winner;
}
/** @param {any} input @param {any} job @param {any} snapshot @param {'fail'|'cancel'} [invalidResult] @param {any} [jobLog] */
async function completeJob(input, job, snapshot, invalidResult = 'fail', jobLog) {
  let resultArtifact;
  let result;
  try {
    result = extractFinalResult(snapshot, job.command, persistedTurnBoundary(job) ?? {});
    resultArtifact = await writeResultArtifact({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: job.id, contents: result });
  } catch (error) {
    return invalidResult === 'cancel' ? cancelJob(input, job) : failJob(input, job, error);
  }
  const finalization = await finishRecoveredResult(input, job, resultArtifact);
  await appendRecoveredFinal(jobLog, finalization, result);
  return finalization.winner;
}

/** @param {any} input @param {any} job @param {string} resultArtifact */
async function finishRecoveredResult(input, job, resultArtifact) {
  try { return { winner: await input.store.finishJob(input.workspace, job.id, ['running', 'cancelling'], 'succeeded', { resultArtifact, exitCode: 0 }), appliedFinalization: true }; }
  catch (error) {
    const winner = await input.store.readJob(input.workspace, job.id).catch(() => null);
    if (winner?.status === 'succeeded' && winner.resultArtifact === resultArtifact) return { winner, appliedFinalization: true };
    if (isTransitionConflict(error) && winner) return { winner, appliedFinalization: false };
    throw new SuccessfulResultFinalizationError(error, resultArtifact);
  }
}

/** @param {any} jobLog @param {{winner:any,appliedFinalization:boolean}} finalization @param {string} result */
async function appendRecoveredFinal(jobLog, finalization, result) {
  if (!finalization.appliedFinalization || finalization.winner?.status !== 'succeeded') return;
  await jobLog?.appendCanonicalBlock('Final output', result, Date.now() + OPTIONAL_JOB_LOG_FENCE_MS);
}

/** @param {any} input @param {any} job */
async function openRecoveryJobLog(input, job) {
  return openRuntimeJobLog({
    dataRoot: input.dataRoot, workspace: input.workspace, job, store: input.store,
    attach: 'if-missing', writeDiagnostic: input.progressWriter, fenceMs: OPTIONAL_JOB_LOG_FENCE_MS,
  });
}
/** @param {any} input @param {any} job @param {any} client @param {unknown} error @param {any} jobLog */
async function stopThenSettle(input, job, client, error, jobLog) {
  const boundary = persistedTurnBoundary(job);
  const stopped = await stopRemote(input, job, client);
  if (stopped.stale) return stopped.job;
  throwIfRecoveryInterrupted(input, stopped.ok ? undefined : stopped.error);
  if (!stopped.ok) return input.intent === 'scavenge' && controlChannelUnavailable(stopped.error)
    ? settleUnavailableOrMissingOrphan(input, job, establishedUnavailableOrphanError(stopped.error))
    : retainAfterStopFailure(input, job, stopped.error);
  let snapshot;
  try { snapshot = await client.readSession(job.zcodeSessionId); }
  catch (readError) { throwIfRecoveryInterrupted(input, readError); /* acknowledged stop is sufficient for status-appropriate settlement */ }
  if (snapshot) throwIfRecoveryInterrupted(input);
  if (!boundary && job.command === 'rescue' && job.readOnly === false) return retainAfterStopFailure(input, job,
    recoveryError('The durable accepted turn boundary is incomplete after best-effort stop.'));
  if (snapshot && boundary) {
    const classification = classifyCurrentTurnSnapshot(snapshot, boundary);
    if (classification.kind === 'succeeded') return completeJob(input, job, snapshot, job.status === 'cancelling' ? 'cancel' : 'fail', jobLog);
    if (job.status === 'cancelling' && ['interrupted', 'failed'].includes(classification.kind)) return cancelJob(input, job);
    if (classification.kind === 'pending') return retainAfterStopFailure(input, job, recoveryError('ZCode cancellation settlement remains unresolved after stop acknowledgement.'));
  }
  return job.status === 'cancelling' ? retainAfterStopFailure(input, job, error) : failJob(input, job, error);
}
/** @param {any} input @param {any} job @param {any} client */
async function stopRemote(input, job, client) {
  const revalidated = await revalidateBoundRescueStop(input, job, input.boundStopGuard?.guard);
  if (revalidated?.kind === 'stale') return { ok: false, stale: true, job: revalidated.job };
  try { await client.stopSession(job.zcodeSessionId); return { ok: true }; }
  catch (error) { return { ok: false, error }; }
}

/** @param {any} input @param {any} job @param {any} [expected] */
async function revalidateBoundRescueStop(input, job, expected) {
  if (job.command !== 'rescue' || job.readOnly !== false || job.rescueReservationKind !== 'bound') return null;
  if (typeof input.store.revalidateBoundRescueStop !== 'function') return { kind: 'stale', job: await input.store.readJob(input.workspace, job.id) };
  // Corrupt authority or a malformed binding partition fails CLOSED: the error
  // propagates and the caller retains the record unresolved rather than
  // stopping a remote session without any binding/generation guard. A
  // WELL-FORMED historical partition with no active anchor is not an error —
  // revalidateBoundRescueStop itself returns { kind: 'stale' } for it.
  return await input.store.revalidateBoundRescueStop({ workspace: input.workspace, jobId: job.id,
    ownerSessionId: job.ownerSessionId, status: job.status, zcodeSessionId: job.zcodeSessionId,
    ...(job.workerLeaseId ? { workerLeaseId: job.workerLeaseId } : {}),
    ...(expected === undefined ? {} : { expected }) });
}
/** @param {any} input @param {any} job @param {unknown} error */
async function retainAfterStopFailure(input, job, error) {
  const current = await input.store.readJob(input.workspace, job.id);
  if (TERMINAL.has(current.status)) return current;
  // A cancelling record carrying a persisted stop intent keeps its status AND
  // persists the bounded failure diagnostic — public status strips the private
  // stop intent, so lastCancelError is the only visible retry evidence. Legacy
  // records without an intent keep the running-retention diagnostic.
  if (current.status === 'cancelling' && validStopIntent(current.stopIntent)) {
    const message = recoveryMessage(error);
    try {
      return await input.store.transitionJob(input.workspace, current.id, ['cancelling'], 'cancelling', { lastCancelError: message });
    } catch (transitionError) {
      // A concurrent settlement wins: reread the durable record — the stale
      // pre-race `cancelling` snapshot must never mask a terminal winner.
      // Genuine storage failures propagate instead of being masked.
      if (transitionError instanceof PluginError && ['JOB_TERMINAL', 'JOB_STATUS_CONFLICT', 'JOB_INVALID_TRANSITION', 'JOB_PATCH_INVALID'].includes(transitionError.code)) {
        return await input.store.readJob(input.workspace, current.id);
      }
      throw transitionError;
    }
  }
  const message = recoveryMessage(error);
  try { return await input.store.transitionJob(input.workspace, job.id, [current.status], 'running', { lastCancelError: message }); }
  catch (transitionError) {
    const winner = await input.store.readJob(input.workspace, job.id);
    if (TERMINAL.has(winner.status)) return winner;
    return conflictWinner(input, job, transitionError);
  }
}
/** @param {any} input @param {any} job @param {unknown} error */
async function conflictWinner(input, job, error) {
  if (isTransitionConflict(error)) return input.store.readJob(input.workspace, job.id);
  throw error;
}
/** @param {unknown} error */
function isTransitionConflict(error) { return error instanceof PluginError && ['JOB_TERMINAL', 'JOB_STATUS_CONFLICT'].includes(error.code); }
/** @param {unknown} error */
function isInterruption(error) { return error instanceof PluginError && error.code === 'JOB_INTERRUPTED'; }
/** @param {{signal?:AbortSignal}} input @param {unknown} [error] */
function throwIfRecoveryInterrupted(input, error) { input.signal?.throwIfAborted(); if (isInterruption(error)) throw error; }
/** @param {unknown} error */
function controlChannelUnavailable(error) { return error instanceof PluginError && CONTROL_CHANNEL_UNAVAILABLE.has(error.code); }
/** Preserve an unproven writable accepted-send gap; historical bounded turns retain archival behavior. @param {any} input @param {any} job @param {unknown} diagnostic */
function settleUnavailableOrMissingOrphan(input, job, diagnostic) {
  return !persistedTurnBoundary(job) && job.command === 'rescue' && job.readOnly === false
    ? retainAfterStopFailure(input, job, diagnostic)
    : failJob(input, job, diagnostic);
}
/** Archive SessionEnd control loss only after proving the exact worker lease is free; an unproven loss retains the durable cancelling status instead of rolling back to running. @param {any} input @param {any} job @param {PluginError} diagnostic */
async function failEndedUnavailableJob(input, job, diagnostic) {
  throwIfRecoveryInterrupted(input);
  // Broker/channel unavailability is not a stop failure: no stop was attempted,
  // so the retained record carries no cancellation diagnostic — the durable
  // status alone is the retry evidence (uncertainty never publishes a claim).
  if (!persistedTurnBoundary(job) && job.command === 'rescue' && job.readOnly === false) return retainUnresolvedEndedStop(input, job, undefined);
  if (!isDigest(job.workerLeaseId)) return retainUnresolvedEndedStop(input, job, undefined);
  try {
    return await withWorkerLease({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: job.id, workerLeaseId: job.workerLeaseId, timeoutMs: 0 }, () => failJob(input, job, diagnostic));
  } catch (error) {
    if (error instanceof PluginError && error.code === 'LOCK_TIMEOUT') return input.store.readJob(input.workspace, job.id);
    throw error;
  }
}
/** @param {'existing-broker-missing'|'managed-establishment'|'existing-protocol-unavailable'|'established-disconnected'} kind */
function unavailableOrphanError(kind) {
  const messages = {
    'existing-broker-missing': 'SessionEnd found no healthy existing ZCode broker identity; the orphan was archived.',
    'managed-establishment': 'Reservation-time recovery could not establish the managed ZCode control channel; the orphan was archived.',
    'existing-protocol-unavailable': 'The reachable ZCode broker reported no existing ZCode Protocol; the orphan was archived.',
    'established-disconnected': 'The established ZCode control channel disconnected during orphan recovery; the orphan was archived.',
  };
  return recoveryError(messages[kind]);
}
/** @param {unknown} error */
function establishedUnavailableOrphanError(error) { return unavailableOrphanError(error instanceof PluginError && error.code === 'ZCODE_BROKER_PROTOCOL_UNAVAILABLE' ? 'existing-protocol-unavailable' : 'established-disconnected'); }
/** @param {unknown} error */
function recoveryMessage(error) { return boundedCancelMessage(error instanceof Error ? error.message : 'Unknown recovery failure'); }
/** @param {string} message */
function recoveryError(message) { return new PluginError('JOB_RECOVERY_FAILED', message, { category: 'state', remedy: 'Inspect the durable job and its ZCode session.' }); }
/** @param {string} directory @param {string} jobId @param {string} workerLeaseId */
function joinWorkerLease(directory, jobId, workerLeaseId) { return `${directory}/worker-leases/${jobId}-${workerLeaseId}.lock`; }
/** @param {unknown} value */
function isDigest(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
/** @param {any} job */
function legacyWorkerAlive(job) {
  if (!Number.isSafeInteger(job.childPid) || job.childPid <= 0) return false;
  try { process.kill(job.childPid, 0); return true; }
  catch (error) { return error && typeof error === 'object' && 'code' in error && error.code === 'EPERM'; }
}
