import { createHash } from 'node:crypto';

import { PluginError } from './errors.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** @param {string} sessionId */
export function ownerIdForSession(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) throw new PluginError('OWNER_ID_INVALID', 'Owner session is invalid.', { category: 'authorization', remedy: 'Use a validated caller context.' });
  return createHash('sha256').update(JSON.stringify(['zcode-owner-v1', sessionId])).digest('hex');
}

/** @param {{store:any,stopSession?:(sessionId:string)=>Promise<unknown>,pollIntervalMs?:number,clock?:()=>number,delay?:(ms:number)=>Promise<void>}} options */
export function createJobController(options) {
  if (!options?.store) throw new PluginError('JOB_CONTROLLER_INPUT_INVALID', 'A state store is required.', { category: 'validation', remedy: 'Provide the Task 2 state store.' });
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const clock = options.clock ?? Date.now;
  const delay = options.delay ?? pollDelay;
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
    async cancel(workspace, jobId, ownerSessionId) {
      const job = await this.selectOwned(workspace, ownerSessionId, jobId);
      if (TERMINAL.has(job.status)) return job;
      if (job.status === 'queued') return options.store.transitionJob(workspace, job.id, ['queued'], 'cancelled', { finishedAt: new Date().toISOString(), exitCode: null });
      if (job.status === 'cancelling') return this.wait(workspace, job.id, 30_000);
      if (job.status !== 'running') throw cancelError(job.id, 'Job is not cancellable.');
      const cancelling = await options.store.transitionJob(workspace, job.id, ['running'], 'cancelling');
      try {
        if (!cancelling.zcodeSessionId || !options.stopSession) throw new Error('No live ZCode session stop handler is available.');
        await options.stopSession(cancelling.zcodeSessionId);
        return await options.store.transitionJob(workspace, job.id, ['cancelling'], 'cancelled', { finishedAt: new Date().toISOString(), exitCode: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'ZCode stop failed';
        await options.store.transitionJob(workspace, job.id, ['cancelling'], 'running', { lastCancelError: message });
        throw cancelError(job.id, message, error);
      }
    },
    /** @param {string} workspace @param {string} ownerSessionId */
    async resumeCandidate(workspace, ownerSessionId) {
      const candidates = (await options.store.listJobs(workspace)).filter((/** @type {any} */ job) => job.ownerSessionId === ownerSessionId && job.command === 'rescue' && typeof job.zcodeSessionId === 'string' && ['running', 'succeeded', 'failed'].includes(job.status));
      return candidates.at(-1) ?? null;
    },
  };
}

/** @param {number} milliseconds */
function pollDelay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
/** @param {string} jobId @param {string} message @param {unknown} [cause] */
function cancelError(jobId, message, cause) { return new PluginError('JOB_CANCEL_FAILED', `Could not cancel job ${jobId}: ${message}`, { category: 'runtime', remedy: 'The job remains running; retry cancellation or inspect the ZCode session.', ...(cause ? { cause } : {}) }); }
