import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { PluginError } from './errors.mjs';
import { atomicWriteJson, ensurePrivateDirectory, readJsonFile, withFileLock } from './fs.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';

export const JOB_STATUSES = Object.freeze([
  'queued',
  'running',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
]);

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const ACTIVE_STATUSES = new Set(['queued', 'running', 'cancelling']);
const TRANSITIONS = new Map([
  ['queued', new Set(['running', 'failed', 'cancelled'])],
  ['running', new Set(['cancelling', 'succeeded', 'failed'])],
  ['cancelling', new Set(['cancelled', 'running', 'failed'])],
]);

/** @param {{ dataRoot: string }} options */
export function createStateStore({ dataRoot }) {
  if (typeof dataRoot !== 'string' || dataRoot.length === 0) {
    throw new PluginError('DATA_ROOT_REQUIRED', 'A plugin data root must be provided explicitly.', {
      category: 'configuration',
      remedy: 'Pass the installed plugin data directory as dataRoot.',
    });
  }

  return {
    /** @param {JobReservation} reservation */
    async reserveJob(reservation) {
      const storage = await jobStorage(dataRoot, reservation.workspace);
      return withFileLock(storage.lockPath, async () => {
        const jobs = await readAllJobs(storage.jobsDirectory);
        if (!reservation.readOnly && jobs.some(isActiveWritableJob)) {
          throw new PluginError('WRITABLE_JOB_EXISTS', 'This workspace already has an active writable rescue job.', {
            category: 'state',
            remedy: 'Wait for the writable job to finish or run this job read-only.',
            details: { workspaceKey: storage.workspaceKey },
          });
        }
        const timestamp = new Date().toISOString();
        const job = {
          id: randomBytes(32).toString('hex'),
          workspace: storage.workspacePath,
          ownerSessionId: reservation.ownerSessionId,
          ownerTurnId: reservation.ownerTurnId,
          command: reservation.command,
          readOnly: reservation.readOnly,
          permissionSnapshot: reservation.permissionSnapshot,
          status: 'queued',
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await atomicWriteJson(jobPath(storage.jobsDirectory, job.id), job);
        return job;
      });
    },

    /**
     * @param {string} workspace
     * @param {string} jobId
     * @param {string[]} expectedStatuses
     * @param {string} nextStatus
     * @param {Record<string, unknown>} [patch]
     */
    async transitionJob(workspace, jobId, expectedStatuses, nextStatus, patch = {}) {
      const storage = await jobStorage(dataRoot, workspace);
      return withFileLock(storage.lockPath, async () => {
        const path = jobPath(storage.jobsDirectory, jobId);
        const job = await readJobRecord(path, jobId);
        if (TERMINAL_STATUSES.has(job.status)) {
          throw new PluginError('JOB_TERMINAL', `Job ${jobId} is already terminal.`, {
            category: 'state',
            remedy: 'Create a new job instead of changing a terminal job.',
            details: { jobId, status: job.status },
          });
        }
        if (!expectedStatuses.includes(job.status)) {
          throw new PluginError('JOB_STATUS_CONFLICT', `Job ${jobId} changed status unexpectedly.`, {
            category: 'state',
            remedy: 'Reload the job and retry from its current status.',
            details: { actualStatus: job.status, expectedStatuses, jobId },
          });
        }
        if (!JOB_STATUSES.includes(nextStatus) || !TRANSITIONS.get(job.status)?.has(nextStatus)) {
          throw new PluginError('JOB_INVALID_TRANSITION', `Cannot transition job from ${job.status} to ${nextStatus}.`, {
            category: 'state',
            remedy: 'Use a transition allowed by the job state machine.',
            details: { from: job.status, jobId, to: nextStatus },
          });
        }
        if (job.status === 'cancelling' && nextStatus === 'running'
          && typeof patch.lastCancelError !== 'string') {
          throw new PluginError('CANCEL_ERROR_REQUIRED', 'A failed cancellation must record lastCancelError.', {
            category: 'state',
            remedy: 'Include the stop failure message in lastCancelError.',
            details: { jobId },
          });
        }
        const updated = {
          ...job,
          ...patch,
          id: job.id,
          status: nextStatus,
          updatedAt: new Date().toISOString(),
          workspace: job.workspace,
        };
        await atomicWriteJson(path, updated);
        return updated;
      });
    },

    /** @param {string} workspace @param {string} jobId */
    async readJob(workspace, jobId) {
      const storage = await jobStorage(dataRoot, workspace);
      return withFileLock(storage.lockPath, () => readJobRecord(
        jobPath(storage.jobsDirectory, jobId),
        jobId,
      ));
    },

    /** @param {string} workspace */
    async listJobs(workspace) {
      const storage = await jobStorage(dataRoot, workspace);
      return withFileLock(storage.lockPath, async () => {
        const jobs = await readAllJobs(storage.jobsDirectory);
        return jobs.sort((left, right) => left.createdAt.localeCompare(right.createdAt)
          || left.id.localeCompare(right.id));
      });
    },
  };
}

/** @param {string} dataRoot @param {string} workspace */
async function jobStorage(dataRoot, workspace) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const jobsDirectory = join(storage.directory, 'jobs');
  await ensurePrivateDirectory(jobsDirectory);
  return { ...storage, jobsDirectory, lockPath: join(storage.directory, '.state.lock') };
}

/** @param {string} jobsDirectory */
async function readAllJobs(jobsDirectory) {
  const entries = await readdir(jobsDirectory);
  return Promise.all(entries
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => readJsonFile(join(jobsDirectory, entry))));
}

/** @param {string} path @param {string} jobId */
async function readJobRecord(path, jobId) {
  try {
    return await readJsonFile(path);
  } catch (error) {
    if (error instanceof PluginError && error.code === 'JSON_READ_FAILED'
      && error.cause instanceof Error && 'code' in error.cause && error.cause.code === 'ENOENT') {
      throw new PluginError('JOB_NOT_FOUND', `Job ${jobId} was not found.`, {
        category: 'state',
        remedy: 'Check the workspace and job identifier.',
        cause: error,
        details: { jobId },
      });
    }
    throw error;
  }
}

/** @param {any} job */
function isActiveWritableJob(job) {
  return job.readOnly === false && ACTIVE_STATUSES.has(job.status);
}

/** @param {string} jobsDirectory @param {string} jobId */
function jobPath(jobsDirectory, jobId) {
  if (!/^[a-f0-9]{64}$/.test(jobId)) {
    throw new PluginError('JOB_ID_INVALID', 'Job identifier has an invalid format.', {
      category: 'state',
      remedy: 'Use the identifier returned by reserveJob.',
      details: { jobId },
    });
  }
  return join(jobsDirectory, `${jobId}.json`);
}

/**
 * @typedef {object} JobReservation
 * @property {string} workspace
 * @property {string} ownerSessionId
 * @property {string} ownerTurnId
 * @property {unknown} command
 * @property {boolean} readOnly
 * @property {unknown} permissionSnapshot
 */
