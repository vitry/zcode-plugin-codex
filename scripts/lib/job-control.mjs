import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createCancelAttemptStore } from './cancel-attempt.mjs';
import { PluginError } from './errors.mjs';
import { withFileLock } from './fs.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

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

/** @param {{store:any,dataRoot?:string,stopSession?:(sessionId:string)=>Promise<unknown>,pollIntervalMs?:number,clock?:()=>number,delay?:(ms:number)=>Promise<void>,beforeWaitPoll?:()=>Promise<unknown>,afterRollbackBeforeSettle?:()=>Promise<void>,afterFollowerSelected?:()=>Promise<void>,afterObservationBeforeLock?:()=>Promise<void>}} options */
export function createJobController(options) {
  if (!options?.store) throw new PluginError('JOB_CONTROLLER_INPUT_INVALID', 'A state store is required.', { category: 'validation', remedy: 'Provide the Task 2 state store.' });
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const clock = options.clock ?? Date.now;
  const delay = options.delay ?? pollDelay;
  /** @type {Map<string,Promise<any>>} */
  const inFlight = new Map();
  return {
    /** @param {string} workspace @param {string} ownerSessionId */
    async listOwned(workspace, ownerSessionId) {
      return (await options.store.listJobs(workspace)).filter((/** @type {any} */ job) => job.ownerSessionId === ownerSessionId);
    },
    /** @param {string} workspace @param {string} ownerSessionId @param {string} [jobId] @param {'status'|'result'|'cancel'} [eligibility] */
    async selectOwned(workspace, ownerSessionId, jobId, eligibility = 'status') {
      const jobs = (await options.store.listJobs(workspace)).filter((/** @type {any} */ job) => job.ownerSessionId === ownerSessionId && (jobId ? job.id === jobId : eligibleImplicit(job, eligibility)));
      const selected = jobs.at(-1);
      if (!selected) throw new PluginError('OWNED_JOB_NOT_FOUND', 'No matching owned job was found.', { category: 'authorization', remedy: 'Check the job ID and invoke the command from its owning Codex session.' });
      return selected;
    },
    /** @param {string} workspace @param {string} jobId @param {number} timeoutMs */
    async wait(workspace, jobId, timeoutMs) {
      const started = clock();
      while (true) {
        await options.beforeWaitPoll?.();
        const job = await options.store.readJob(workspace, jobId);
        if (TERMINAL.has(job.status)) return job;
        if (clock() - started >= timeoutMs) throw new PluginError('JOB_WAIT_TIMEOUT', `Timed out waiting for job ${jobId}.`, { category: 'timeout', remedy: `Retry $zcode:status ${jobId} --wait.`, details: { jobId, status: job.status, timeoutMs } });
        await delay(Math.min(pollIntervalMs, Math.max(0, timeoutMs - (clock() - started))));
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
      const candidates = (await options.store.listJobs(workspace)).filter((/** @type {any} */ job) => job.ownerSessionId === ownerSessionId && job.command === 'rescue' && typeof job.zcodeSessionId === 'string' && ['running', 'succeeded', 'failed'].includes(job.status));
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
    const cancelled = await input.options.store.transitionJob(input.workspace, job.id, ['queued'], 'cancelled', { finishedAt: new Date().toISOString(), exitCode: null });
    await attempts.update(job.id, input.ownerSessionId, attempt.attemptId, 'succeeded'); return cancelled;
  }
  if (!['running', 'cancelling'].includes(job.status)) throw cancelError(job.id, 'Job is not cancellable.');
  if (job.status === 'cancelling' && attempt.status === 'finalize-pending') {
    let cancelled;
    try {
      cancelled = await input.options.store.transitionJob(input.workspace, job.id, ['cancelling'], 'cancelled', { finishedAt: new Date().toISOString(), exitCode: null });
    } catch (error) { throw finalizeError(job.id, error); }
    await attempts.update(job.id, input.ownerSessionId, attempt.attemptId, 'succeeded'); return cancelled;
  }
  const cancelling = job.status === 'running' ? await input.options.store.transitionJob(input.workspace, job.id, ['running'], 'cancelling', job.lastCancelError ? { lastCancelError: null } : {}) : job;
  try {
    if (!cancelling.zcodeSessionId || !input.options.stopSession) throw new Error('No live ZCode session stop handler is available.');
    await input.options.stopSession(cancelling.zcodeSessionId);
  } catch (error) {
    const message = boundedCancelMessage(error instanceof Error ? error.message : 'ZCode stop failed');
    await input.options.store.transitionJob(input.workspace, job.id, ['cancelling'], 'running', { lastCancelError: message });
    await attempts.update(job.id, input.ownerSessionId, attempt.attemptId, 'failed-pending-release', message);
    await input.options.afterRollbackBeforeSettle?.();
    return { failedAttempt: attempt.attemptId, message, cause: error };
  }
  let cancelled;
  try { cancelled = await input.options.store.transitionJob(input.workspace, job.id, ['cancelling'], 'cancelled', { finishedAt: new Date().toISOString(), exitCode: null }); }
  catch (error) {
    await attempts.update(job.id, input.ownerSessionId, attempt.attemptId, 'finalize-pending'); throw finalizeError(job.id, error);
  }
  await attempts.update(job.id, input.ownerSessionId, attempt.attemptId, 'succeeded'); return cancelled;
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

/** @param {number} milliseconds */
function pollDelay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
/** @param {any} job @param {'status'|'result'|'cancel'} eligibility */
function eligibleImplicit(job, eligibility) {
  if (eligibility === 'cancel') return ['queued', 'running', 'cancelling'].includes(job.status);
  if (eligibility === 'result') return job.status === 'succeeded' && typeof job.resultArtifact === 'string';
  return true;
}
/** @param {string} jobId @param {unknown} cause */
function finalizeError(jobId, cause) { return new PluginError('JOB_CANCEL_FINALIZE_FAILED', `ZCode stopped, but job ${jobId} could not be finalized as cancelled.`, { category: 'storage', remedy: 'Retry cancellation to reconcile and finalize the cancelling job.', cause }); }
/** @param {string} jobId @param {string} message @param {unknown} [cause] */
function cancelError(jobId, message, cause) { return new PluginError('JOB_CANCEL_FAILED', `Could not cancel job ${jobId}: ${message}`, { category: 'runtime', remedy: 'The job remains running; retry cancellation or inspect the ZCode session.', ...(cause ? { cause } : {}) }); }
/** @param {string} message */
function boundedCancelMessage(message) {
  let result = ''; let bytes = 0;
  for (const character of message) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > 2_048) break;
    result += character; bytes += characterBytes;
  }
  return result || 'ZCode stop failed';
}
