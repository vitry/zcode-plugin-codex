import { PluginError } from './errors.mjs';
import { createIdentityStore } from './identity.mjs';
import { boundedCancelMessage, durableCancelledWinner, ownerIdForSession, withJobCancellationLock } from './job-control.mjs';
import { extractFinalResult, SuccessfulResultFinalizationError, writeResultArtifact } from './review.mjs';
import { withFileLock } from './fs.mjs';
import { openRuntimeJobLog } from './job-log-runtime.mjs';
import { readQueuedRescueMigrationRollback } from './rescue-migration.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';
import { classifyCurrentTurnSnapshot, hasCurrentTurnActivity, persistedTurnBoundary } from './turn-terminal.mjs';
import { reconcileBrokerOwnership } from '../zcode-broker.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const REMOTE_ACTIVE = new Set(['running', 'waiting']);
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
      if (current.status === 'queued') return classifyEndedSettlement(await cancelQueuedJob(input, current));
      if (!['running', 'cancelling'].includes(current.status) || typeof current.zcodeSessionId !== 'string') return { kind: 'retained-writable-guard', job: current };
      return settleEndedRemoteJob(input, current);
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
        ? failJob(input, job, unavailableOrphanError('managed-establishment'))
        : retainAfterStopFailure(input, job, error);
    }
    if (!client) {
      throwIfRecoveryInterrupted(input);
      return retainAfterStopFailure(input, job, recoveryError('The ZCode recovery client is unavailable.'));
    }
    jobLog = await openRecoveryJobLog(input, job);
    let listed;
    try { listed = await client.listSessions(); }
    catch (error) { throwIfRecoveryInterrupted(input, error); return input.intent === 'scavenge' && controlChannelUnavailable(error) ? failJob(input, job, establishedUnavailableOrphanError(error)) : stopThenSettle(input, job, client, error, jobLog); }
    throwIfRecoveryInterrupted(input);
    if (!Array.isArray(listed?.sessions)) return stopThenSettle(input, job, client, recoveryError('ZCode session listing is malformed during recovery.'), jobLog);
    if (!listed.sessions.some((/** @type {any} */ session) => session.sessionId === job.zcodeSessionId)) return failJob(input, job, recoveryError('ZCode session is missing during recovery.'));
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
      ? failJob(input, current, establishedUnavailableOrphanError(error))
      : stopThenSettle(input, current, client, error, jobLog);
  } finally { await client?.close().catch(() => {}); await jobLog?.close(Date.now() + OPTIONAL_JOB_LOG_FENCE_MS); }
}

/** Resolve exact rollback evidence for atomic queued terminalization. @param {any} input @param {any} job */
async function queuedMigrationRollback(input, job) {
  return readQueuedRescueMigrationRollback({ dataRoot: input.dataRoot, workspace: input.workspace, job, store: input.store,
    invalid: () => recoveryError('Queued migration specification is invalid.') });
}
/** @param {any} input @param {any} job @param {unknown} error */
async function failJob(input, job, error) {
  const current = await input.store.readJob(input.workspace, job.id);
  if (TERMINAL.has(current.status)) return current;
  const patch = { error: { message: recoveryMessage(error) }, exitCode: 1 };
  if (current.status === 'queued') return finishQueuedJobAfterLeaseProbe(input, current, 'failed', patch);
  try { return await input.store.finishJob(input.workspace, job.id, [current.status], 'failed', patch); }
  catch (transitionError) { return conflictWinner(input, job, transitionError); }
}
/** @param {any} input @param {any} job */
async function cancelJob(input, job) {
  const current = await input.store.readJob(input.workspace, job.id);
  if (TERMINAL.has(current.status)) return current;
  try {
    if (current.status === 'running') await input.store.transitionJob(input.workspace, job.id, ['running'], 'cancelling');
    return await input.store.finishJob(input.workspace, job.id, ['cancelling'], 'cancelled', { exitCode: null });
  } catch (error) { return cancelledConflictWinner(input, job, error); }
}
/** @param {any} input @param {any} job */
async function cancelQueuedJob(input, job) {
  const current = await input.store.readJob(input.workspace, job.id);
  if (TERMINAL.has(current.status) || current.status !== 'queued') return current;
  try { return await finishQueuedJobAfterLeaseProbe(input, current, 'cancelled', { exitCode: null }); }
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

/** @param {any} input @param {any} job */
async function settleEndedRemoteJob(input, job) {
  let client;
  const observedStop = await revalidateBoundRescueStop(input, job);
  if (observedStop?.kind === 'stale') return classifyEndedSettlement(observedStop.job);
  const jobLog = await openRecoveryJobLog(input, job);
  try {
    try { client = await input.createClient(job, ownerIdForSession(job.ownerSessionId)); throwIfRecoveryInterrupted(input); }
    catch (error) {
      throwIfRecoveryInterrupted(input, error);
      const winner = controlChannelUnavailable(error)
        ? await failEndedUnavailableJob(input, job, establishedUnavailableOrphanError(error))
        : await retainAfterStopFailure(input, job, error);
      return classifyEndedSettlement(winner);
    }
    if (!client) return classifyEndedSettlement(await failEndedUnavailableJob(input, job, unavailableOrphanError('existing-broker-missing')));
    let snapshot;
    try { snapshot = await client.readSession(job.zcodeSessionId); }
    catch (error) { throwIfRecoveryInterrupted(input, error); return classifyEndedSettlement(controlChannelUnavailable(error) ? await failEndedUnavailableJob(input, job, establishedUnavailableOrphanError(error)) : await retainAfterStopFailure(input, job, error)); }
    throwIfRecoveryInterrupted(input);
    const boundary = persistedTurnBoundary(job);
    const initialClassification = boundary ? classifyCurrentTurnSnapshot(snapshot, boundary) : { kind: 'pending' };
    const completed = initialClassification.kind === 'succeeded' ? await completeEndedJob(input, job, snapshot, jobLog) : null;
    if (completed) return classifyEndedSettlement(completed);
    if (['interrupted', 'failed'].includes(initialClassification.kind)) return classifyEndedSettlement(await cancelJob(input, job));
    if (!REMOTE_ACTIVE.has(snapshot?.projection?.status)) return classifyEndedSettlement(await input.store.readJob(input.workspace, job.id));
    if (!boundary || !hasCurrentTurnActivity(snapshot, boundary)) return classifyEndedSettlement(await input.store.readJob(input.workspace, job.id));
    const revalidated = await revalidateBoundRescueStop(input, job, observedStop?.guard);
    if (revalidated?.kind === 'stale') return classifyEndedSettlement(revalidated.job);
    try { await client.stopSession(job.zcodeSessionId); throwIfRecoveryInterrupted(input); }
    catch (error) { throwIfRecoveryInterrupted(input, error); return classifyEndedSettlement(await retainAfterStopFailure(input, job, error)); }
    try { snapshot = await client.readSession(job.zcodeSessionId); }
    catch (error) { throwIfRecoveryInterrupted(input, error); return classifyEndedSettlement(await retainAfterStopFailure(input, job, error)); }
    throwIfRecoveryInterrupted(input);
    const settledClassification = boundary ? classifyCurrentTurnSnapshot(snapshot, boundary) : { kind: 'pending' };
    const racedCompletion = settledClassification.kind === 'succeeded' ? await completeEndedJob(input, job, snapshot, jobLog) : null;
    if (racedCompletion) return classifyEndedSettlement(racedCompletion);
    if (['interrupted', 'failed'].includes(settledClassification.kind)) return classifyEndedSettlement(await cancelJob(input, job));
    return classifyEndedSettlement(await retainAfterStopFailure(input, job,
      recoveryError('SessionEnd cancellation settlement remains unresolved after stop acknowledgement.')));
  } catch (error) {
    throwIfRecoveryInterrupted(input, error);
    if (error instanceof SuccessfulResultFinalizationError) throw error;
    const winner = controlChannelUnavailable(error)
      ? await failEndedUnavailableJob(input, job, establishedUnavailableOrphanError(error))
      : await retainAfterStopFailure(input, job, error);
    return classifyEndedSettlement(winner);
  } finally { await client?.close().catch(() => {}); await jobLog?.close(Date.now() + OPTIONAL_JOB_LOG_FENCE_MS); }
}

/** Return null when completion is not proven and leave the durable job active. @param {any} input @param {any} job @param {any} snapshot @param {any} jobLog */
async function completeEndedJob(input, job, snapshot, jobLog) {
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
    ? failJob(input, job, establishedUnavailableOrphanError(stopped.error))
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
/** Archive SessionEnd control loss only after proving the exact worker lease is free. @param {any} input @param {any} job @param {PluginError} diagnostic */
async function failEndedUnavailableJob(input, job, diagnostic) {
  throwIfRecoveryInterrupted(input);
  if (!persistedTurnBoundary(job) && job.command === 'rescue' && job.readOnly === false) return retainAfterStopFailure(input, job, diagnostic);
  if (!isDigest(job.workerLeaseId)) return retainAfterStopFailure(input, job, diagnostic);
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
