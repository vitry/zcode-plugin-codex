import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { PluginError } from './errors.mjs';
import { withFileLock } from './fs.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** @param {string} sessionId */
export function ownerIdForSession(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) throw new PluginError('OWNER_ID_INVALID', 'Owner session is invalid.', { category: 'authorization', remedy: 'Use a validated caller context.' });
  return createHash('sha256').update(JSON.stringify(['zcode-owner-v1', sessionId])).digest('hex');
}

/** @param {{store:any,dataRoot?:string,stopSession?:(sessionId:string)=>Promise<unknown>,pollIntervalMs?:number,clock?:()=>number,delay?:(ms:number)=>Promise<void>,afterRollbackBeforeSettle?:()=>Promise<void>,afterFollowerSelected?:()=>Promise<void>}} options */
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
    /** @param {string} workspace @param {string} ownerSessionId @param {string} [jobId] */
    async selectOwned(workspace, ownerSessionId, jobId) {
      const jobs = (await options.store.listJobs(workspace)).filter((/** @type {any} */ job) => job.ownerSessionId === ownerSessionId && (!jobId || job.id === jobId));
      const selected = jobs.at(-1);
      if (!selected) throw new PluginError('OWNED_JOB_NOT_FOUND', 'No matching owned job was found.', { category: 'authorization', remedy: 'Check the job ID and invoke the command from its owning Codex session.' });
      return selected;
    },
    /** @param {string} workspace @param {string} jobId @param {number} timeoutMs */
    async wait(workspace, jobId, timeoutMs) {
      const started = clock();
      while (true) {
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
  const lockPath = join(input.storage.directory, 'cancel-locks', `${input.jobId}.lock`); let operationStarted = false;
  try { return await withFileLock(lockPath, () => { operationStarted = true; return performCancellation(input, false); }, { timeoutMs: 0 }); }
  catch (error) {
    if (operationStarted || !(error instanceof PluginError) || error.code !== 'LOCK_TIMEOUT') throw error;
    await input.options.afterFollowerSelected?.();
    return withFileLock(lockPath, () => performCancellation(input, true), { timeoutMs: 30_000 });
  }
}

/** @param {{options:any,workspace:string,jobId:string,ownerSessionId:string}} input @param {boolean} follower */
async function performCancellation(input, follower) {
  const job = await input.options.store.readJob(input.workspace, input.jobId);
  if (job.ownerSessionId !== input.ownerSessionId) throw new PluginError('OWNED_JOB_NOT_FOUND', 'No matching owned job was found.', { category: 'authorization', remedy: 'Check the job ID and invoke the command from its owning Codex session.' });
  if (TERMINAL.has(job.status)) return job;
  if (job.status === 'queued') {
    return input.options.store.transitionJob(input.workspace, job.id, ['queued'], 'cancelled', { finishedAt: new Date().toISOString(), exitCode: null });
  }
  if (!['running', 'cancelling'].includes(job.status)) throw cancelError(job.id, 'Job is not cancellable.');
  if (follower && job.status === 'running') {
    if (job.lastCancelError) throw cancelError(job.id, cancellationMessage(job.lastCancelError));
  }
  const cancelling = job.status === 'running' ? await input.options.store.transitionJob(input.workspace, job.id, ['running'], 'cancelling', job.lastCancelError ? { lastCancelError: null } : {}) : job;
  try {
    if (!cancelling.zcodeSessionId || !input.options.stopSession) throw new Error('No live ZCode session stop handler is available.');
    await input.options.stopSession(cancelling.zcodeSessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ZCode stop failed';
    await input.options.store.transitionJob(input.workspace, job.id, ['cancelling'], 'running', { lastCancelError: message }).catch(() => {});
    await input.options.afterRollbackBeforeSettle?.();
    throw cancelError(job.id, message, error);
  }
  try { return await input.options.store.transitionJob(input.workspace, job.id, ['cancelling'], 'cancelled', { finishedAt: new Date().toISOString(), exitCode: null }); }
  catch (error) { throw finalizeError(job.id, error); }
}

/** @param {number} milliseconds */
function pollDelay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
/** @param {unknown} value */
function cancellationMessage(value) { return typeof value === 'string' ? value : value && typeof value === 'object' && 'message' in value && typeof value.message === 'string' ? value.message : 'ZCode stop failed'; }
/** @param {string} jobId @param {unknown} cause */
function finalizeError(jobId, cause) { return new PluginError('JOB_CANCEL_FINALIZE_FAILED', `ZCode stopped, but job ${jobId} could not be finalized as cancelled.`, { category: 'storage', remedy: 'Retry cancellation to reconcile and finalize the cancelling job.', cause }); }
/** @param {string} jobId @param {string} message @param {unknown} [cause] */
function cancelError(jobId, message, cause) { return new PluginError('JOB_CANCEL_FAILED', `Could not cancel job ${jobId}: ${message}`, { category: 'runtime', remedy: 'The job remains running; retry cancellation or inspect the ZCode session.', ...(cause ? { cause } : {}) }); }
