import { PluginError } from './errors.mjs';
import { createIdentityStore } from './identity.mjs';
import { boundedCancelMessage, durableCancelledWinner, ownerIdForSession, withJobCancellationLock } from './job-control.mjs';
import { extractFinalResult, SuccessfulResultFinalizationError, writeResultArtifact } from './review.mjs';
import { withFileLock } from './fs.mjs';
import { openRuntimeJobLog } from './job-log-runtime.mjs';
import { readQueuedRescueMigrationRollback } from './rescue-migration.mjs';
import { createRescueLifecycleReconciler } from './rescue-lifecycle.mjs';
import { hostOwnedCancelledPatch, hostOwnedStopIntentPatch, validHostLifecycleRecord, validStopIntent } from './rescue-binding.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';
import { classifyCurrentTurnSnapshot, hasCurrentTurnActivity, persistedTurnBoundary } from './turn-terminal.mjs';
import { reconcileBrokerOwnership } from '../zcode-broker.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
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
    await (input.reconcileOwnership ?? reconcileBrokerOwnership)({ dataRoot: input.dataRoot, workspace: input.workspace, ownerId, ownedSessionIds: [job.zcodeSessionId] });
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
      if (job.status === 'cancelling' || input.intent === 'scavenge') return stopThenSettle(input, job, client, recoveryError('The remote turn remained active after its executor exited.'), jobLog);
      return job;
    }
    if (remoteStatus === 'paused') {
      if (!hasCurrentTurnActivity(snapshot, boundary)) return input.store.readJob(input.workspace, job.id);
      return job.status === 'cancelling'
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
  /** @type {{job:any,client?:any,jobLog?:any,guard?:any,racedWinner?:any}} */
  const context = { job: current };
  const observedStop = await revalidateBoundRescueStop(input, current);
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
        // Pre-stop read: a turn that already reached a terminal outcome BEFORE
        // this stop keeps its own semantics (natural success publishes its
        // result; an engine terminal failure publishes failed) instead of being
        // misclassified as caused by the stop. The read reuses the open client.
        try {
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
      settleUnavailableExecutor: (/** @type {any} */ joined, /** @type {any} */ evidence) => failEndedUnavailableJob(input, joined.job, evidence.error),
    }).reconcile({
      intent: { kind: 'stop', cause: 'session-end' },
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
  const job = context.job;
  if (job.status === 'queued') return endedJoined(job, { kind: 'none' });
  context.jobLog = await openRecoveryJobLog(input, job);
  try {
    context.client = await input.createClient(job, ownerIdForSession(job.ownerSessionId));
  } catch (error) {
    throwIfRecoveryInterrupted(input, error);
    return endedJoined(job, unavailableOrReadableEvidence(error));
  }
  throwIfRecoveryInterrupted(input);
  if (!context.client) {
    throwIfRecoveryInterrupted(input);
    return endedJoined(job, { kind: 'unavailable', error: unavailableOrphanError('existing-broker-missing') });
  }
  let snapshot;
  try { snapshot = await context.client.readSession(job.zcodeSessionId); throwIfRecoveryInterrupted(input); }
  catch (error) {
    throwIfRecoveryInterrupted(input, error);
    return endedJoined(job, unavailableOrReadableEvidence(error));
  }
  return endedJoined(job, endedRemoteEvidence(snapshot, job));
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
 * reconciler's stopExactTurn/reread sequence.
 * @param {any} job @param {any} remote
 */
function endedJoined(job, remote) {
  return {
    job,
    winner: null,
    hostState: 'absent',
    hostPlacement: job.hostPlacement ?? null,
    hostOwned: validHostLifecycleRecord(job),
    sessionEndReceipt: 'matching',
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
  if (TERMINAL.has(current.status) || current.status === 'cancelling' || error === undefined) return current;
  return retainAfterStopFailure(input, current, error);
}

/** Persist the durable stop intent before any remote control; a queued job embeds it in its terminal patch. @param {any} input @param {{job:any,racedWinner?:any}} context @param {any} joined @param {string} cause @param {{signal?:AbortSignal}} [options] */
async function persistEndedStopIntent(input, context, joined, cause, options) {
  options?.signal?.throwIfAborted();
  if (joined.job.status === 'queued') return { kind: 'persisted', job: joined.job };
  const current = await input.store.readJob(input.workspace, joined.job.id);
  if (TERMINAL.has(current.status)) return { kind: 'conflict', winner: current };
  if (current.status === 'cancelling') { context.job = current; return { kind: 'persisted', job: current }; }
  try {
    const cancelling = await input.store.transitionJob(input.workspace, current.id, ['running'], 'cancelling', hostOwnedStopIntentPatch(current, cause));
    context.job = cancelling;
    return { kind: 'persisted', job: cancelling };
  } catch (error) {
    const winner = await cancelledConflictWinner(input, current, error);
    if (!TERMINAL.has(winner.status)) context.racedWinner = winner;
    return { kind: 'conflict', winner, resumableEvidence: racedResumableEvidence(winner) };
  }
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
  return input.store.revalidateBoundRescueStop({ workspace: input.workspace, jobId: job.id,
    ownerSessionId: job.ownerSessionId, status: job.status, zcodeSessionId: job.zcodeSessionId,
    ...(job.workerLeaseId === undefined ? {} : { workerLeaseId: job.workerLeaseId }),
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
      if (transitionError instanceof PluginError && ['JOB_TERMINAL', 'JOB_STATUS_CONFLICT', 'JOB_INVALID_TRANSITION'].includes(transitionError.code)) {
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
  if (!persistedTurnBoundary(job) && job.command === 'rescue' && job.readOnly === false) return retainUnresolvedEndedStop(input, job, diagnostic);
  if (!isDigest(job.workerLeaseId)) return retainUnresolvedEndedStop(input, job, diagnostic);
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
