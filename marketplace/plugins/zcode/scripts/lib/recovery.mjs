import { PluginError } from './errors.mjs';
import { boundedCancelMessage, durableCancelledWinner, ownerIdForSession, withJobCancellationLock } from './job-control.mjs';
import { extractFinalResult, SuccessfulResultFinalizationError, writeResultArtifact } from './review.mjs';
import { withFileLock } from './fs.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';
import { reconcileBrokerOwnership } from '../zcode-broker.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const REMOTE_ACTIVE = new Set(['running', 'waiting']);
const CONTROL_CHANNEL_UNAVAILABLE = new Set(['ZCODE_BROKER_PROTOCOL_UNAVAILABLE', 'ZCODE_DISCONNECTED']);
export const LEGACY_QUEUED_STALE_MS = 5 * 60_000;

/** Hold the exact production worker identity for its full lifetime. @param {{dataRoot:string,workspace:string,jobId:string,workerLeaseId:string,timeoutMs?:number}} input @param {()=>Promise<any>} operation */
export async function withWorkerLease(input, operation) {
  if (!isDigest(input.jobId) || !isDigest(input.workerLeaseId)) throw recoveryError('Worker lease identity is invalid.');
  const storage = await resolveWorkspaceStorage({ dataRoot: input.dataRoot, workspace: input.workspace });
  return withFileLock(joinWorkerLease(storage.directory, input.jobId, input.workerLeaseId), operation, { timeoutMs: input.timeoutMs ?? 30_000 });
}

/** Reconcile only provably orphaned jobs owned by one exact Codex session. @param {{store:any,dataRoot:string,workspace:string,ownerSessionId:string,createClient:(job:any,ownerId:string)=>Promise<any>,reconcileOwnership?:(input:any)=>Promise<any>,now?:()=>number,signal?:AbortSignal}} input */
export async function reconcileOwnedJobs(input) {
  const jobs = (await input.store.listOwnedJobs(input.workspace, input.ownerSessionId))
    .filter((/** @type {any} */ job) => !TERMINAL.has(job.status));
  const outcomes = [];
  for (const job of jobs) {
    try { outcomes.push(await settleSelectedJob({ ...input, selectedJobId: job.id, expectedOwnerSessionId: job.ownerSessionId, intent: 'owner-recovery' })); }
    catch (error) { throwIfRecoveryInterrupted(input, error); if (error instanceof SuccessfulResultFinalizationError) throw error; outcomes.push(job); }
  }
  return outcomes;
}

/** Settle provably orphaned writable Rescue blockers without adopting their public ownership. @param {{store:any,dataRoot:string,workspace:string,createClient:(job:any,ownerId:string)=>Promise<any>,reconcileOwnership?:(input:any)=>Promise<any>,now?:()=>number,signal?:AbortSignal}} input */
export async function scavengeWritableJobs(input) {
  const jobs = (await input.store.listJobs(input.workspace))
    .filter((/** @type {any} */ job) => job.command === 'rescue' && job.readOnly === false && !TERMINAL.has(job.status));
  const outcomes = [];
  for (const job of jobs) {
    try { outcomes.push(await settleSelectedJob({ ...input, selectedJobId: job.id, expectedOwnerSessionId: job.ownerSessionId, intent: 'scavenge' })); }
    catch (error) { throwIfRecoveryInterrupted(input, error); if (error instanceof SuccessfulResultFinalizationError) throw error; outcomes.push(job); }
  }
  return outcomes;
}

/**
 * Best-effort settlement for the ending owner's one active writable Rescue.
 * Unlike orphan scavenging, SessionEnd is an explicit owner lifecycle signal, so
 * an accepted remote turn may be stopped even while its worker lease is held.
 * @param {{store:any,dataRoot:string,workspace:string,ownerSessionId:string,lockTimeoutMs?:number,requestTimeoutMs?:number,createClient:(job:any,ownerId:string)=>Promise<any>,signal?:AbortSignal}} input
 */
export async function settleEndedOwnerWritableJob(input) {
  const selected = (await listOwnedJobsForRecovery(input.store, input.workspace, input.ownerSessionId, input.signal))
    .filter((/** @type {any} */ job) => job.command === 'rescue'
      && job.readOnly === false && !TERMINAL.has(job.status))
    .at(-1);
  if (!selected) return null;
  try {
    return await withJobCancellationLock({
      dataRoot: input.dataRoot,
      workspace: input.workspace,
      jobId: selected.id,
      timeoutMs: input.lockTimeoutMs ?? 0,
    }, async () => {
      const current = await input.store.readJob(input.workspace, selected.id);
      if (current.id !== selected.id || current.ownerSessionId !== input.ownerSessionId
        || current.command !== 'rescue' || current.readOnly !== false || TERMINAL.has(current.status)) return current;
      if (current.status === 'queued' && !isDigest(current.workerLeaseId)) return cancelQueuedJob(input, current);
      if (current.status === 'queued') {
        try {
          return await withWorkerLease({
            dataRoot: input.dataRoot,
            workspace: input.workspace,
            jobId: current.id,
            workerLeaseId: current.workerLeaseId,
            timeoutMs: 0,
          }, () => cancelQueuedJob(input, current));
        } catch (error) {
          if (error instanceof PluginError && error.code === 'LOCK_TIMEOUT') return current;
          throw error;
        }
      }
      if (!['running', 'cancelling'].includes(current.status) || typeof current.zcodeSessionId !== 'string') return current;
      return settleEndedRemoteJob(input, current);
    });
  } catch (error) {
    if (error instanceof PluginError && error.code === 'LOCK_TIMEOUT') return input.store.readJob(input.workspace, selected.id);
    throw error;
  }
}

/**
 * Retries one exact owner-index validation after the check phase. A freshly
 * published Windows marker can be transiently unavailable to the first strict
 * identity read; persistent corruption and every other error remain fail-closed.
 * @param {any} store @param {string} workspace @param {string} ownerSessionId @param {AbortSignal} [signal]
 */
export async function listOwnedJobsForRecovery(store, workspace, ownerSessionId, signal) {
  try { return await store.listOwnedJobs(workspace, ownerSessionId); }
  catch (error) {
    if ((/** @type {{code?:unknown}} */ (error))?.code !== 'OWNED_JOB_INDEX_INVALID' || signal?.aborted) throw error;
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    signal?.throwIfAborted();
    return store.listOwnedJobs(workspace, ownerSessionId);
  }
}

/** @param {any} input */
async function settleSelectedJob(input) {
  return withJobCancellationLock({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: input.selectedJobId }, async () => {
    const current = await input.store.readJob(input.workspace, input.selectedJobId);
    if (current.id !== input.selectedJobId || current.ownerSessionId !== input.expectedOwnerSessionId || TERMINAL.has(current.status)) return current;
    if (input.intent === 'scavenge' && (current.command !== 'rescue' || current.readOnly !== false)) return current;
    if (current.status === 'queued' && !isDigest(current.workerLeaseId)) {
      return (input.now ?? Date.now)() - Date.parse(current.createdAt) >= LEGACY_QUEUED_STALE_MS
        ? failJob(input, current, recoveryError('Queued reservation exceeded the conservative worker-claim grace period.'))
        : current;
    }
    if (!isDigest(current.workerLeaseId) && legacyWorkerAlive(current)) return current;
    if (!isDigest(current.workerLeaseId)) return reconcileOrphan(input, current);
    try {
      return await withWorkerLease({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: current.id, workerLeaseId: current.workerLeaseId, timeoutMs: 0 }, () => current.status === 'queued'
        ? failJob(input, current, recoveryError('Claimed queued worker exited before execution started.'))
        : reconcileOrphan(input, current));
    } catch (error) {
      if (error instanceof PluginError && error.code === 'LOCK_TIMEOUT') return current;
      throw error;
    }
  });
}

/** @param {any} input @param {any} job */
async function reconcileOrphan(input, job) {
  let client;
  if (job.status === 'queued') return failJob(input, job, recoveryError('Queued worker reservation is orphaned.'));
  if (typeof job.zcodeSessionId !== 'string') return failJob(input, job, recoveryError('Worker exited before a remote session was accepted.'));
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
    let listed;
    try { listed = await client.listSessions(); }
    catch (error) { throwIfRecoveryInterrupted(input, error); return input.intent === 'scavenge' && controlChannelUnavailable(error) ? failJob(input, job, establishedUnavailableOrphanError(error)) : stopThenSettle(input, job, client, error); }
    throwIfRecoveryInterrupted(input);
    if (!Array.isArray(listed?.sessions)) return stopThenSettle(input, job, client, recoveryError('ZCode session listing is malformed during recovery.'));
    if (!listed.sessions.some((/** @type {any} */ session) => session.sessionId === job.zcodeSessionId)) return failJob(input, job, recoveryError('ZCode session is missing during recovery.'));
    if (job.command === 'transfer') return stopThenSettle(input, job, client, recoveryError('Transfer worker exited before local finalization.'));
    if (!hasBoundary(job)) return stopThenSettle(input, job, client, recoveryError('The durable turn boundary is incomplete.'));
    let snapshot;
    try { snapshot = await client.readSession(job.zcodeSessionId); }
    catch (error) { throwIfRecoveryInterrupted(input, error); return input.intent === 'scavenge' && controlChannelUnavailable(error) ? failJob(input, job, establishedUnavailableOrphanError(error)) : stopThenSettle(input, job, client, error); }
    throwIfRecoveryInterrupted(input);
    if (!Number.isSafeInteger(snapshot?.runtime?.stateRevision) || snapshot.runtime.stateRevision < job.startRevision) return stopThenSettle(input, job, client, recoveryError('ZCode recovery state is older than the accepted turn boundary.'));
    const remoteStatus = snapshot?.projection?.status;
    if (REMOTE_ACTIVE.has(remoteStatus)) {
      if (job.status === 'cancelling' || input.intent === 'scavenge') return stopThenSettle(input, job, client, recoveryError('The remote turn remained active after its executor exited.'));
      return job;
    }
    if (remoteStatus === 'paused') return job.status === 'cancelling'
      ? stopThenSettle(input, job, client, recoveryError('The cancelling remote turn is paused.'))
      : failJob(input, job, recoveryError('The orphaned remote turn is paused.'));
    if (remoteStatus === 'error') return failJob(input, job, recoveryError(snapshot?.projection?.lastError?.message ?? 'ZCode reported a terminal error during recovery.'));
    if (!['completed', 'idle'].includes(remoteStatus)) return stopThenSettle(input, job, client, recoveryError('ZCode recovery state is ambiguous.'));
    return completeJob(input, job, snapshot);
  } catch (error) {
    throwIfRecoveryInterrupted(input, error);
    if (error instanceof SuccessfulResultFinalizationError) throw error;
    const current = await input.store.readJob(input.workspace, job.id);
    if (TERMINAL.has(current.status)) return current;
    return input.intent === 'scavenge' && controlChannelUnavailable(error)
      ? failJob(input, current, establishedUnavailableOrphanError(error))
      : stopThenSettle(input, current, client, error);
  } finally { await client?.close().catch(() => {}); }
}

/** @param {any} job */
function hasBoundary(job) { return typeof job.inputId === 'string' && Number.isSafeInteger(job.startRevision) && Array.isArray(job.beforeMessageIds); }
/** @param {any} input @param {any} job @param {unknown} error */
async function failJob(input, job, error) {
  const current = await input.store.readJob(input.workspace, job.id);
  if (TERMINAL.has(current.status)) return current;
  try { return await input.store.finishJob(input.workspace, job.id, [current.status], 'failed', { error: { message: recoveryMessage(error) }, exitCode: 1 }); }
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
  try { return await input.store.finishJob(input.workspace, job.id, ['queued'], 'cancelled', { exitCode: null }); }
  catch (error) { return cancelledConflictWinner(input, job, error); }
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
  try {
    try { client = await input.createClient(job, ownerIdForSession(job.ownerSessionId)); throwIfRecoveryInterrupted(input); }
    catch (error) {
      throwIfRecoveryInterrupted(input, error);
      return controlChannelUnavailable(error)
        ? failEndedUnavailableJob(input, job, establishedUnavailableOrphanError(error))
        : retainAfterStopFailure(input, job, error);
    }
    if (!client) return failEndedUnavailableJob(input, job, unavailableOrphanError('existing-broker-missing'));
    let snapshot;
    try { snapshot = await client.readSession(job.zcodeSessionId); }
    catch (error) { throwIfRecoveryInterrupted(input, error); return controlChannelUnavailable(error) ? failEndedUnavailableJob(input, job, establishedUnavailableOrphanError(error)) : retainAfterStopFailure(input, job, error); }
    throwIfRecoveryInterrupted(input);
    const completed = await completeEndedJob(input, job, snapshot);
    if (completed) return completed;
    if (!REMOTE_ACTIVE.has(snapshot?.projection?.status)) return input.store.readJob(input.workspace, job.id);
    try { await client.stopSession(job.zcodeSessionId); throwIfRecoveryInterrupted(input); }
    catch (error) { throwIfRecoveryInterrupted(input, error); return controlChannelUnavailable(error) ? failEndedUnavailableJob(input, job, establishedUnavailableOrphanError(error)) : retainAfterStopFailure(input, job, error); }
    try { snapshot = await client.readSession(job.zcodeSessionId); }
    catch (error) { throwIfRecoveryInterrupted(input, error); return cancelJob(input, job); }
    throwIfRecoveryInterrupted(input);
    return await completeEndedJob(input, job, snapshot) ?? cancelJob(input, job);
  } catch (error) {
    throwIfRecoveryInterrupted(input, error);
    if (error instanceof SuccessfulResultFinalizationError) throw error;
    return controlChannelUnavailable(error)
      ? failEndedUnavailableJob(input, job, establishedUnavailableOrphanError(error))
      : retainAfterStopFailure(input, job, error);
  } finally { await client?.close().catch(() => {}); }
}

/** Return null when completion is not proven and leave the durable job active. @param {any} input @param {any} job @param {any} snapshot */
async function completeEndedJob(input, job, snapshot) {
  if (!hasBoundary(job) || !Number.isSafeInteger(snapshot?.runtime?.stateRevision)
    || snapshot.runtime.stateRevision < job.startRevision || !['completed', 'idle'].includes(snapshot?.projection?.status)) return null;
  let resultArtifact;
  try {
    const result = extractFinalResult(snapshot, job.command, { inputId: job.inputId, stateRevision: job.startRevision, beforeMessageIds: new Set(job.beforeMessageIds) });
    resultArtifact = await writeResultArtifact({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: job.id, contents: result });
  } catch { return null; }
  return finishRecoveredResult(input, job, resultArtifact);
}
/** @param {any} input @param {any} job @param {any} snapshot @param {'fail'|'cancel'} [invalidResult] */
async function completeJob(input, job, snapshot, invalidResult = 'fail') {
  let resultArtifact;
  try {
    const result = extractFinalResult(snapshot, job.command, { inputId: job.inputId, stateRevision: job.startRevision, beforeMessageIds: new Set(job.beforeMessageIds) });
    resultArtifact = await writeResultArtifact({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: job.id, contents: result });
  } catch (error) {
    return invalidResult === 'cancel' ? cancelJob(input, job) : failJob(input, job, error);
  }
  return finishRecoveredResult(input, job, resultArtifact);
}

/** @param {any} input @param {any} job @param {string} resultArtifact */
async function finishRecoveredResult(input, job, resultArtifact) {
  try { return await input.store.finishJob(input.workspace, job.id, ['running', 'cancelling'], 'succeeded', { resultArtifact, exitCode: 0 }); }
  catch (error) {
    const winner = await input.store.readJob(input.workspace, job.id).catch(() => null);
    if (winner?.status === 'succeeded' && winner.resultArtifact === resultArtifact) return winner;
    if (isTransitionConflict(error) && winner) return winner;
    throw new SuccessfulResultFinalizationError(error, resultArtifact);
  }
}
/** @param {any} input @param {any} job @param {any} client @param {unknown} error */
async function stopThenSettle(input, job, client, error) {
  const stopped = await stopRemote(job, client);
  throwIfRecoveryInterrupted(input, stopped.ok ? undefined : stopped.error);
  if (!stopped.ok) return input.intent === 'scavenge' && controlChannelUnavailable(stopped.error)
    ? failJob(input, job, establishedUnavailableOrphanError(stopped.error))
    : retainAfterStopFailure(input, job, stopped.error);
  let snapshot;
  try { snapshot = await client.readSession(job.zcodeSessionId); }
  catch (readError) { throwIfRecoveryInterrupted(input, readError); /* acknowledged stop is sufficient for status-appropriate settlement */ }
  if (snapshot) throwIfRecoveryInterrupted(input);
  if (snapshot && hasBoundary(job) && Number.isSafeInteger(snapshot?.runtime?.stateRevision) && snapshot.runtime.stateRevision >= job.startRevision
    && ['completed', 'idle'].includes(snapshot?.projection?.status)) return completeJob(input, job, snapshot, job.status === 'cancelling' ? 'cancel' : 'fail');
  return job.status === 'cancelling' ? cancelJob(input, job) : failJob(input, job, error);
}
/** @param {any} job @param {any} client */
async function stopRemote(job, client) {
  try { await client.stopSession(job.zcodeSessionId); return { ok: true }; }
  catch (error) { return { ok: false, error }; }
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
