import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { createCancelAttemptStore } from './cancel-attempt.mjs';
import { PluginError } from './errors.mjs';
import { withFileLock } from './fs.mjs';
import { waitForCompletionOrAbort } from './progress.mjs';
import { readQueuedRescueMigrationRollback } from './rescue-migration.mjs';
import { classifyCurrentTurnSnapshot, hasCurrentTurnActivity, persistedTurnBoundary } from './turn-terminal.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * Read the one Rescue job bound to a trusted forwarding executor without
 * exposing any durable identity or execution metadata.
 * @param {{store:any,workspace:string,executor:{parentSessionId:string,agentId:string}}} input
 */
export async function readBoundRescueStatus(input) {
  if (!input?.store || typeof input.store.readBoundRescueCurrentJob !== 'function'
    || typeof input.workspace !== 'string' || input.workspace.length === 0
    || typeof input.executor?.parentSessionId !== 'string' || input.executor.parentSessionId.length === 0
    || typeof input.executor?.agentId !== 'string' || input.executor.agentId.length === 0) {
    throw new PluginError('BOUND_RESCUE_STATUS_INPUT_INVALID', 'The bound Rescue status input is invalid.', {
      category: 'authorization', remedy: 'Invoke status only from the active Rescue child.',
    });
  }
  let job;
  try { job = await input.store.readBoundRescueCurrentJob({ workspace: input.workspace, parentSessionId: input.executor.parentSessionId, executorAgentId: input.executor.agentId }); }
  catch (error) {
    if (error instanceof PluginError && error.code === 'RESCUE_BINDING_CLOSED') throw new PluginError('BOUND_RESCUE_STATUS_NOT_FOUND', 'No exact bound Rescue status is available.', { category: 'authorization', remedy: 'Continue waiting on the original Rescue foreground execution.' });
    throw boundRescueStatusUnavailable();
  }
  const progressPreview = Array.isArray(job.progressPreview)
    ? job.progressPreview.filter((/** @type {unknown} */ value) => typeof value === 'string').slice(-4)
    : [];
  return {
    type: 'rescue-status',
    status: job.status,
    phase: job.phase ?? null,
    lastActivityAt: job.lastActivityAt ?? job.updatedAt ?? null,
    progressPreview: [...progressPreview],
    terminal: TERMINAL.has(job.status),
  };
}

function boundRescueStatusUnavailable() {
  return new PluginError('BOUND_RESCUE_STATUS_UNAVAILABLE', 'Bound Rescue status is unavailable.', {
    category: 'state', remedy: 'Continue waiting on the original Rescue foreground execution.',
  });
}

/**
 * Serialize executor finalization with cancellation, using the same durable workspace lock.
 * @param {{dataRoot:string,workspace:string,jobId:string,storage?:any,timeoutMs?:number}} input
 * @param {()=>Promise<any>} operation
 */
export async function withJobCancellationLock(input, operation) {
  const storage = input.storage ?? await resolveWorkspaceStorage({ dataRoot: input.dataRoot, workspace: input.workspace });
  return withFileLock(join(storage.directory, 'cancel-locks', `${input.jobId}.lock`), operation, { timeoutMs: input.timeoutMs ?? 30_000 });
}

/** @param {string} sessionId */
export function ownerIdForSession(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) throw new PluginError('OWNER_ID_INVALID', 'Owner session is invalid.', { category: 'authorization', remedy: 'Use a validated caller context.' });
  return createHash('sha256').update(JSON.stringify(['zcode-owner-v1', sessionId])).digest('hex');
}

/** @param {{store:any,dataRoot?:string,stopSession?:(sessionId:string)=>Promise<unknown>,readSession?:(sessionId:string)=>Promise<any>,publishSucceededSnapshot?:(input:{workspace:string,job:any,snapshot:any,turnBoundary:any})=>Promise<any>,cancellationObservationMs?:number,cancellationObservationIntervalMs?:number,pollIntervalMs?:number,clock?:()=>number,delay?:(ms:number)=>Promise<void>,setTimeout?:(callback:()=>void,ms:number)=>any,clearTimeout?:(timer:any)=>void,beforeWaitPoll?:()=>Promise<unknown>,afterRollbackBeforeSettle?:()=>Promise<void>,afterFollowerSelected?:()=>Promise<void>,afterObservationBeforeLock?:()=>Promise<void>}} options */
export function createJobController(options) {
  if (!options?.store) throw new PluginError('JOB_CONTROLLER_INPUT_INVALID', 'A state store is required.', { category: 'validation', remedy: 'Provide the Task 2 state store.' });
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const clock = options.clock ?? Date.now;
  const scheduleTimeout = options.setTimeout ?? globalThis.setTimeout;
  const cancelTimeout = options.clearTimeout ?? globalThis.clearTimeout;
  /** @type {Map<string,Promise<any>>} */
  const inFlight = new Map();
  return {
    /** @param {string} workspace @param {string} ownerSessionId */
    async listOwned(workspace, ownerSessionId) {
      return options.store.listOwnedJobs(workspace, ownerSessionId);
    },
    /** @param {string} workspace @param {string} ownerSessionId @param {string} [jobId] @param {'status'|'result'|'cancel'} [eligibility] */
    async selectOwned(workspace, ownerSessionId, jobId, eligibility = 'status') {
      const jobs = (await options.store.listOwnedJobs(workspace, ownerSessionId))
        .filter((/** @type {any} */ job) => jobId ? job.id === jobId : eligibleImplicit(job, eligibility));
      const selected = jobs.at(-1);
      if (!selected) throw new PluginError('OWNED_JOB_NOT_FOUND', 'No matching owned job was found.', { category: 'authorization', remedy: 'Check the job ID and invoke the command from its owning Codex session.' });
      return selected;
    },
    /** @param {string} workspace @param {string} jobId @param {number} timeoutMs @param {AbortSignal} [signal] */
    async wait(workspace, jobId, timeoutMs, signal) {
      const started = clock();
      while (true) {
        signal?.throwIfAborted();
        await abortable(() => options.beforeWaitPoll?.(), signal);
        const job = await abortable(() => options.store.readJob(workspace, jobId), signal);
        if (TERMINAL.has(job.status)) return job;
        if (clock() - started >= timeoutMs) throw new PluginError('JOB_WAIT_TIMEOUT', `Timed out waiting for job ${jobId}.`, { category: 'timeout', remedy: `Retry $zcode:status ${jobId} --wait.`, details: { jobId, status: job.status, timeoutMs } });
        const waitMs = Math.min(pollIntervalMs, Math.max(0, timeoutMs - (clock() - started)));
        const customDelay = options.delay;
        if (customDelay) await abortable(() => customDelay(waitMs), signal);
        else await pollDelay(waitMs, signal, scheduleTimeout, cancelTimeout);
      }
    },
    /** @param {string} workspace @param {string} jobId @param {string} ownerSessionId */
    cancel(workspace, jobId, ownerSessionId) {
      const dataRoot = options.dataRoot ?? options.store.dataRoot;
      if (!dataRoot) return Promise.reject(cancelError(jobId, 'Cancellation lock storage is unavailable.'));
      let canonicalWorkspace;
      try { canonicalWorkspace = realpathSync(resolve(workspace)); }
      catch { return resolveWorkspaceStorage({ dataRoot, workspace }).then((storage) => cancelWithElection({ options, storage, workspace: storage.workspacePath, jobId, ownerSessionId })); }
      const key = `${canonicalWorkspace}:${jobId}`; const existing = inFlight.get(key); if (existing) return existing;
      const attempt = resolveWorkspaceStorage({ dataRoot, workspace: canonicalWorkspace }).then((storage) => cancelWithElection({ options, storage, workspace: canonicalWorkspace, jobId, ownerSessionId }));
      inFlight.set(key, attempt); const cleanup = () => { if (inFlight.get(key) === attempt) inFlight.delete(key); }; attempt.then(cleanup, cleanup); return attempt;
    },
    /** @param {string} workspace @param {string} ownerSessionId */
    async resumeCandidate(workspace, ownerSessionId) {
      const candidates = (await options.store.listOwnedJobs(workspace, ownerSessionId))
        .filter((/** @type {any} */ job) => job.command === 'rescue' && typeof job.zcodeSessionId === 'string' && ['running', 'succeeded', 'failed'].includes(job.status));
      return candidates.at(-1) ?? null;
    },
  };
}

/** @param {{options:any,storage:any,workspace:string,jobId:string,ownerSessionId:string}} input */
async function cancelWithElection(input) {
  if (!/^[a-f0-9]{64}$/.test(input.jobId)) throw new PluginError('JOB_ID_INVALID', 'Job identifier has an invalid format.', { category: 'validation', remedy: 'Use a job ID returned by the state store.', details: { jobId: input.jobId } });
  const attempts = createCancelAttemptStore(input.storage); let operationStarted = false;
  let observed = null; let observedError = null;
  try { observed = await attempts.read(input.jobId, input.ownerSessionId); } catch (attemptError) { observedError = attemptError; }
  await input.options.afterObservationBeforeLock?.();
  try {
    const outcome = await withJobCancellationLock({ ...input, dataRoot: input.options.dataRoot ?? input.options.store.dataRoot, timeoutMs: 0 }, () => { operationStarted = true; return performCancellation(input, attempts, { observed, observedError }); });
    return await settleCancellationOutcome(input, attempts, outcome);
  }
  catch (error) {
    if (operationStarted || !(error instanceof PluginError) || error.code !== 'LOCK_TIMEOUT') throw error;
    await input.options.afterFollowerSelected?.();
    const outcome = await withJobCancellationLock({ ...input, dataRoot: input.options.dataRoot ?? input.options.store.dataRoot, timeoutMs: 30_000 }, () => performCancellation(input, attempts, { observed, observedError }));
    return settleCancellationOutcome(input, attempts, outcome);
  }
}

/** @param {{options:any,workspace:string,jobId:string,ownerSessionId:string}} input @param {ReturnType<typeof createCancelAttemptStore>} attempts @param {{observed:any,observedError:unknown}} election */
async function performCancellation(input, attempts, election) {
  const job = await input.options.store.readJob(input.workspace, input.jobId);
  if (job.ownerSessionId !== input.ownerSessionId) throw new PluginError('OWNED_JOB_NOT_FOUND', 'No matching owned job was found.', { category: 'authorization', remedy: 'Check the job ID and invoke the command from its owning Codex session.' });
  if (TERMINAL.has(job.status)) return job;
  if (election.observedError) throw election.observedError;
  const current = await attempts.read(job.id, input.ownerSessionId); let attempt;
  if (current?.status === 'failed-pending-release') return failedOutcome(current);
  if (current?.status === 'failed' && completedDuringAcquisition(election.observed, current)) return failedOutcome(current);
  if (current?.status === 'active' || current?.status === 'finalize-pending') attempt = current;
  else attempt = await attempts.start(job.id, input.ownerSessionId);
  if (job.status === 'queued') {
    if (job.workerLeaseId) throw cancelError(job.id, 'The claimed worker is still starting; retry after it advances or recovery proves it orphaned.');
    const rollback = await readQueuedRescueMigrationRollback({ dataRoot: input.options.dataRoot ?? input.options.store.dataRoot,
      workspace: input.workspace, job, store: input.options.store,
      invalid: () => cancelError(job.id, 'Queued migration specification is invalid.') });
    let cancelled;
    try { cancelled = rollback
      ? await input.options.store.finishSessionEndedRescueContinuation(input.workspace, job.id, rollback, 'cancelled', { exitCode: null })
      : await finishJob(input.options.store, input.workspace, job.id, ['queued'], 'cancelled', { exitCode: null }); }
    catch (error) { cancelled = await durableCancelledWinner(cancelledWinnerInput(input), error); }
    return recordCancelledAttempt(input, attempts, attempt, cancelled);
  }
  if (!['running', 'cancelling'].includes(job.status)) throw cancelError(job.id, 'Job is not cancellable.');
  if (job.status === 'cancelling' && attempt.status === 'finalize-pending') {
    let cancelled;
    try {
      cancelled = await finishJob(input.options.store, input.workspace, job.id, ['cancelling'], 'cancelled', { exitCode: null });
    } catch (error) {
      try { cancelled = await durableCancelledWinner(cancelledWinnerInput(input), error); }
      catch (finalizeFailure) { throw finalizeError(job.id, finalizeFailure); }
    }
    return recordCancelledAttempt(input, attempts, attempt, cancelled);
  }
  const cancelling = job.status === 'running' ? await input.options.store.transitionJob(input.workspace, job.id, ['running'], 'cancelling', job.lastCancelError ? { lastCancelError: null } : {}) : job;
  const observedStop = await revalidateBoundRescueStop(input.options.store, input.workspace, cancelling);
  if (observedStop?.kind === 'stale') return observedStop.job;
  try {
    if (!cancelling.zcodeSessionId || !input.options.stopSession) throw new Error('No live ZCode session stop handler is available.');
    const revalidated = await revalidateBoundRescueStop(input.options.store, input.workspace, cancelling, observedStop?.guard);
    if (revalidated?.kind === 'stale') return revalidated.job;
    await input.options.stopSession(cancelling.zcodeSessionId);
  } catch (error) {
    const message = boundedCancelMessage(error instanceof Error ? error.message : 'ZCode stop failed');
    await input.options.store.transitionJob(input.workspace, job.id, ['cancelling'], 'running', { lastCancelError: message });
    await attempts.update(job.id, input.ownerSessionId, attempt.attemptId, 'failed-pending-release', message);
    await input.options.afterRollbackBeforeSettle?.();
    return { failedAttempt: attempt.attemptId, message, cause: error };
  }
  const boundary = persistedTurnBoundary(cancelling);
  if (input.options.readSession && boundary) {
    const settlement = await observeCancellationSettlement(input, cancelling, observedStop?.guard);
    if (settlement.kind === 'stale') return settlement.job;
    if (settlement.kind === 'succeeded') {
      if (!input.options.publishSucceededSnapshot) return cancellationUncertain(input, attempts, attempt, cancelling,
        new Error('ZCode completed during cancellation but no result publisher is available.'));
      const winner = await input.options.publishSucceededSnapshot({ workspace: input.workspace, job: cancelling,
        snapshot: /** @type {any} */ (settlement).snapshot, turnBoundary: boundary });
      return recordCancelledAttempt(input, attempts, attempt, winner);
    }
    if (!['interrupted', 'failed'].includes(settlement.kind)) {
      return cancellationUncertain(input, attempts, attempt, cancelling,
        settlement.error ?? new Error('ZCode cancellation observation expired while the current turn remained unresolved.'));
    }
  }
  let cancelled;
  try { cancelled = await finishJob(input.options.store, input.workspace, job.id, ['cancelling'], 'cancelled', { exitCode: null }); }
  catch (error) {
    try { cancelled = await durableCancelledWinner(cancelledWinnerInput(input), error); }
    catch (finalizeFailure) {
      await attempts.update(job.id, input.ownerSessionId, attempt.attemptId, 'finalize-pending'); throw finalizeError(job.id, finalizeFailure);
    }
  }
  return recordCancelledAttempt(input, attempts, attempt, cancelled);
}

/** Keep the cancellation lock and managed client alive while the admission gap converges. @param {any} input @param {any} job @param {any} guard */
async function observeCancellationSettlement(input, job, guard) {
  const duration = nonnegativeSafeInteger(input.options.cancellationObservationMs) ? input.options.cancellationObservationMs : 1_000;
  const interval = nonnegativeSafeInteger(input.options.cancellationObservationIntervalMs) ? input.options.cancellationObservationIntervalMs : 25;
  const boundary = persistedTurnBoundary(job);
  if (!boundary) return { kind: 'uncertain', error: new Error('The durable turn boundary is incomplete.') };
  const scheduleTimeout = input.options.setTimeout ?? globalThis.setTimeout;
  const cancelTimeout = input.options.clearTimeout ?? globalThis.clearTimeout;
  /** @type {()=>void} */ let expire = () => {};
  const expiry = new Promise((resolvePromise) => { expire = () => resolvePromise(undefined); });
  const timer = scheduleTimeout(expire, duration);
  let stoppedActiveTurn = false;
  /** @param {()=>Promise<any>} operation @returns {Promise<{kind:'value',value:any}|{kind:'error',error:any}|{kind:'expired'}>} */
  const bounded = async (operation) => Promise.race([
    Promise.resolve().then(operation).then((value) => ({ kind: /** @type {const} */ ('value'), value }), (error) => ({ kind: /** @type {const} */ ('error'), error })),
    expiry.then(() => ({ kind: /** @type {const} */ ('expired') })),
  ]);
  try {
    for (;;) {
      const read = await bounded(() => input.options.readSession(job.zcodeSessionId));
      if (read.kind === 'expired') return { kind: 'unresolved' };
      if (read.kind === 'error') return { kind: 'uncertain', error: read.error };
      const snapshot = read.value;
      const classification = classifyCurrentTurnSnapshot(snapshot, boundary);
      if (classification.kind !== 'pending') return { ...classification, snapshot };
      if (!stoppedActiveTurn && ['running', 'waiting', 'paused'].includes(snapshot?.projection?.status)
        && hasCurrentTurnActivity(snapshot, boundary)) {
        const validation = await bounded(() => revalidateBoundRescueStop(input.options.store, input.workspace, job, guard));
        if (validation.kind === 'expired') return { kind: 'unresolved' };
        if (validation.kind === 'error') return { kind: 'uncertain', error: validation.error };
        if (validation.value?.kind === 'stale') return { kind: 'stale', job: validation.value.job };
        const stop = await bounded(() => input.options.stopSession(job.zcodeSessionId));
        if (stop.kind === 'expired') return { kind: 'unresolved' };
        if (stop.kind === 'error') return { kind: 'uncertain', error: stop.error };
        stoppedActiveTurn = true;
      }
      const wait = await bounded(() => input.options.delay
        ? input.options.delay(interval)
        : pollDelay(interval, undefined, scheduleTimeout, cancelTimeout));
      if (wait.kind === 'expired') return { kind: 'unresolved' };
      if (wait.kind === 'error') return { kind: 'uncertain', error: wait.error };
    }
  } finally { cancelTimeout(timer); }
}

/** @param {any} input @param {any} attempts @param {any} attempt @param {any} job @param {unknown} error */
async function cancellationUncertain(input, attempts, attempt, job, error) {
  const message = boundedCancelMessage(error instanceof Error ? error.message : 'ZCode cancellation settlement is uncertain.');
  const winner = await input.options.store.readJob(input.workspace, job.id).catch(() => null);
  if (winner && TERMINAL.has(winner.status)) return winner;
  await attempts.update(job.id, input.ownerSessionId, attempt.attemptId, 'failed-pending-release', message);
  await input.options.afterRollbackBeforeSettle?.();
  return { failedAttempt: attempt.attemptId, message, cause: error };
}

/** @param {unknown} value */
function nonnegativeSafeInteger(value) { return Number.isSafeInteger(value) && Number(value) >= 0; }

/** @param {any} store @param {string} workspace @param {any} job @param {any} [expected] @param {string} [zcodeSessionId] */
export async function revalidateBoundRescueStop(store, workspace, job, expected, zcodeSessionId = job.zcodeSessionId) {
  if (job.command !== 'rescue' || job.readOnly !== false || job.rescueReservationKind !== 'bound') return null;
  if (typeof store.revalidateBoundRescueStop !== 'function') return { kind: 'stale', job: await store.readJob(workspace, job.id) };
  return store.revalidateBoundRescueStop({ workspace, jobId: job.id, ownerSessionId: job.ownerSessionId,
    status: job.status, ...(zcodeSessionId === undefined ? {} : { zcodeSessionId }),
    ...(job.workerLeaseId === undefined ? {} : { workerLeaseId: job.workerLeaseId }),
    ...(expected === undefined ? {} : { expected }) });
}

/** Durable job terminality is authoritative; cancellation attempts remain auxiliary election evidence. @param {{options:any,workspace:string,jobId:string,ownerSessionId:string}} input @param {ReturnType<typeof createCancelAttemptStore>} attempts @param {any} attempt @param {any} cancelled */
async function recordCancelledAttempt(input, attempts, attempt, cancelled) {
  try { await attempts.update(cancelled.id, input.ownerSessionId, attempt.attemptId, 'succeeded'); return cancelled; }
  catch (error) {
    if (cancelled?.status === 'cancelled') return durableCancelledWinner(cancelledWinnerInput(input), error);
    let durable;
    try { durable = await input.options.store.readJob(input.workspace, input.jobId); } catch { throw error; }
    if (TERMINAL.has(cancelled?.status)
      && cancelled.id === input.jobId && cancelled.ownerSessionId === input.ownerSessionId
      && isDeepStrictEqual(durable, cancelled)) return durable;
    throw error;
  }
}

/** Resolve only the exact durable cancellation winner; every ambiguous read or identity mismatch preserves the initiating error. @param {{store:any,workspace:string,jobId:string,ownerSessionId:string}} input @param {unknown} error */
export async function durableCancelledWinner(input, error) {
  let winner;
  try { winner = await input.store.readJob(input.workspace, input.jobId); } catch { throw error; }
  if (winner?.id === input.jobId && winner.ownerSessionId === input.ownerSessionId && winner.status === 'cancelled') return winner;
  throw error;
}

/** @param {{options:any,workspace:string,jobId:string,ownerSessionId:string}} input */
function cancelledWinnerInput(input) {
  return { store: input.options.store, workspace: input.workspace, jobId: input.jobId, ownerSessionId: input.ownerSessionId };
}

/** @param {{options:any,workspace:string,jobId:string,ownerSessionId:string}} input @param {ReturnType<typeof createCancelAttemptStore>} attempts @param {any} outcome */
async function settleCancellationOutcome(input, attempts, outcome) {
  if (!outcome?.failedAttempt) return outcome;
  await attempts.update(input.jobId, input.ownerSessionId, outcome.failedAttempt, 'failed', outcome.message);
  throw cancelError(input.jobId, outcome.message, outcome.cause);
}

/** @param {any} record */
function failedOutcome(record) { return { failedAttempt: record.attemptId, message: record.error.message }; }
/** @param {any} observed @param {any} current */
function completedDuringAcquisition(observed, current) {
  if (!observed) return true;
  if (observed.attemptId !== current.attemptId) return true;
  if (observed.status === current.status && observed.updatedAt === current.updatedAt) return false;
  return ['active', 'failed-pending-release', 'finalize-pending'].includes(observed.status)
    && ['failed', 'succeeded', 'finalize-pending'].includes(current.status);
}

/** @param {number} milliseconds @param {AbortSignal} [signal] @param {(callback:()=>void,ms:number)=>any} [schedule] @param {(timer:any)=>void} [cancel] */
function pollDelay(milliseconds, signal, schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = /** @type {any} */ (undefined);
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => { if (settled) return; settled = true; if (timer !== undefined) cancel(timer); cleanup(); reject(signal?.reason); };
    const onTimer = () => { if (settled) return; settled = true; cleanup(); resolve(undefined); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (!settled) {
      timer = schedule(onTimer, milliseconds);
      if (settled) cancel(timer);
    }
  });
}
/** @template T @param {()=>T|Promise<T>} operation @param {AbortSignal} [signal] */
function abortable(operation, signal) {
  signal?.throwIfAborted();
  const completion = Promise.resolve().then(() => { signal?.throwIfAborted(); return operation(); });
  return waitForCompletionOrAbort(completion, signal);
}
/** @param {any} job @param {'status'|'result'|'cancel'} eligibility */
function eligibleImplicit(job, eligibility) {
  if (eligibility === 'cancel') return ['queued', 'running', 'cancelling'].includes(job.status);
  if (eligibility === 'result') return TERMINAL.has(job.status);
  return true;
}
/** @param {any} store @param {string} workspace @param {string} jobId @param {string[]} expectedStatuses @param {string} nextStatus @param {Record<string,unknown>} patch */
function finishJob(store, workspace, jobId, expectedStatuses, nextStatus, patch) {
  return store.finishJob(workspace, jobId, expectedStatuses, nextStatus, patch);
}
/** @param {string} jobId @param {unknown} cause */
function finalizeError(jobId, cause) { return new PluginError('JOB_CANCEL_FINALIZE_FAILED', `ZCode stopped, but job ${jobId} could not be finalized as cancelled.`, { category: 'storage', remedy: 'Retry cancellation to reconcile and finalize the cancelling job.', cause }); }
/** @param {string} jobId @param {string} message @param {unknown} [cause] */
function cancelError(jobId, message, cause) { return new PluginError('JOB_CANCEL_FAILED', `Could not cancel job ${jobId}: ${message}`, { category: 'runtime', remedy: 'The job remains running; retry cancellation or inspect the ZCode session.', ...(cause ? { cause } : {}) }); }
/** @param {string} message */
export function boundedCancelMessage(message) {
  let result = ''; let bytes = 0;
  for (const character of message) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > 2_048) break;
    result += character; bytes += characterBytes;
  }
  return result || 'ZCode stop failed';
}
