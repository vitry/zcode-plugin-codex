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
export const JOB_COMMANDS = Object.freeze(['review', 'adversarial-review', 'rescue', 'transfer']);
export const EFFORT_LEVELS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const ACTIVE_STATUSES = new Set(['queued', 'running', 'cancelling']);
const JOB_PATCH_FIELDS = new Set([
  'childPid', 'effort', 'error', 'exitCode', 'finishedAt', 'lastCancelError', 'model',
  'promptArtifact', 'resultArtifact', 'startedAt', 'zcodeSessionId',
]);
const TRANSITIONS = new Map([
  ['queued', new Set(['running', 'failed', 'cancelled'])],
  ['running', new Set(['running', 'cancelling', 'succeeded', 'failed'])],
  ['cancelling', new Set(['cancelled', 'running', 'failed'])],
]);

/** @param {{ dataRoot: string }} options */
export function createStateStore(options) {
  const dataRoot = isPlainJsonObject(options) ? options.dataRoot : undefined;
  if (typeof dataRoot !== 'string' || dataRoot.length === 0) {
    throw new PluginError('DATA_ROOT_REQUIRED', 'A plugin data root must be provided explicitly.', {
      category: 'configuration',
      remedy: 'Pass the installed plugin data directory as dataRoot.',
    });
  }

  return {
    /** @param {JobReservation} reservation */
    async reserveJob(reservation) {
      validateReservation(reservation);
      const storage = await jobStorage(dataRoot, reservation.workspace);
      return withFileLock(storage.lockPath, async () => {
        const jobs = await readAllJobs(storage.jobsDirectory, storage.workspacePath);
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
      validateTransitionInput(workspace, jobId, expectedStatuses, nextStatus, patch);
      const storage = await jobStorage(dataRoot, workspace);
      return withFileLock(storage.lockPath, async () => {
        const forbiddenFields = Object.keys(patch)
          .filter((field) => !JOB_PATCH_FIELDS.has(field));
        if (forbiddenFields.length > 0) {
          throw new PluginError('JOB_PATCH_FORBIDDEN', 'Job patch contains protected or unsupported fields.', {
            category: 'state',
            remedy: 'Only patch mutable job execution fields.',
            details: { forbiddenFields, jobId },
          });
        }
        const path = jobPath(storage.jobsDirectory, jobId);
        const job = await readJobRecord(path, jobId, storage.workspacePath);
        validateJobPatch(job, nextStatus, patch, jobId);
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
          && !isCancellationError(patch.lastCancelError)) {
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
          updatedAt: new Date(Math.max(
            Date.now(),
            Date.parse(job.createdAt),
            Date.parse(job.updatedAt),
          )).toISOString(),
          workspace: job.workspace,
        };
        validateJobRecord(updated, jobId, storage.workspacePath);
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
        storage.workspacePath,
      ));
    },

    /** @param {string} workspace */
    async listJobs(workspace) {
      const storage = await jobStorage(dataRoot, workspace);
      return withFileLock(storage.lockPath, async () => {
        const jobs = await readAllJobs(storage.jobsDirectory, storage.workspacePath);
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

/** @param {string} jobsDirectory @param {string} expectedWorkspacePath */
async function readAllJobs(jobsDirectory, expectedWorkspacePath) {
  const entries = await readdir(jobsDirectory);
  return Promise.all(entries
    .filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry))
    .map(async (entry) => validateJobRecord(
      await readJsonFile(join(jobsDirectory, entry)),
      entry.slice(0, -'.json'.length),
      expectedWorkspacePath,
    )));
}

/** @param {string} path @param {string} jobId @param {string} expectedWorkspacePath */
async function readJobRecord(path, jobId, expectedWorkspacePath) {
  try {
    return validateJobRecord(await readJsonFile(path), jobId, expectedWorkspacePath);
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

/** @param {any} reservation */
function validateReservation(reservation) {
  if (!isPlainJsonObject(reservation)) throw invalidReservation(['reservation']);
  const invalidFields = [];
  if (!isNonEmptyString(reservation.workspace)) invalidFields.push('workspace');
  if (!isNonEmptyString(reservation.ownerSessionId)) invalidFields.push('ownerSessionId');
  if (!isNonEmptyString(reservation.ownerTurnId)) invalidFields.push('ownerTurnId');
  if (!JOB_COMMANDS.includes(reservation.command)) invalidFields.push('command');
  if (typeof reservation.readOnly !== 'boolean') invalidFields.push('readOnly');
  if (!isPlainJsonObject(reservation.permissionSnapshot)) invalidFields.push('permissionSnapshot');
  if (invalidFields.length > 0) throw invalidReservation(invalidFields);
}

/** @param {string[]} invalidFields */
function invalidReservation(invalidFields) {
  return new PluginError('JOB_INPUT_INVALID', 'Job reservation contains invalid fields.', {
    category: 'state',
    remedy: 'Provide non-empty identity and command strings, a boolean readOnly, and a JSON object permission snapshot.',
    details: { invalidFields },
  });
}

/**
 * @param {unknown} workspace
 * @param {unknown} jobId
 * @param {unknown} expectedStatuses
 * @param {unknown} nextStatus
 * @param {unknown} patch
 */
function validateTransitionInput(workspace, jobId, expectedStatuses, nextStatus, patch) {
  const invalidFields = [];
  if (!isNonEmptyString(workspace)) invalidFields.push('workspace');
  if (typeof jobId !== 'string' || !/^[a-f0-9]{64}$/.test(jobId)) invalidFields.push('jobId');
  if (!Array.isArray(expectedStatuses) || expectedStatuses.length === 0
    || expectedStatuses.some((status) => typeof status !== 'string'
      || !JOB_STATUSES.includes(status))) invalidFields.push('expectedStatuses');
  if (typeof nextStatus !== 'string' || !JOB_STATUSES.includes(nextStatus)) {
    invalidFields.push('nextStatus');
  }
  if (!isPlainJsonObject(patch)) invalidFields.push('patch');
  if (invalidFields.length > 0) {
    throw new PluginError('JOB_TRANSITION_INPUT_INVALID', 'Job transition input is invalid.', {
      category: 'state',
      remedy: 'Provide a valid workspace, job ID, status list, next status, and JSON object patch.',
      details: { invalidFields },
    });
  }
}

/** @param {any} job @param {string} expectedJobId @param {string} expectedWorkspacePath @returns {any} */
function validateJobRecord(job, expectedJobId, expectedWorkspacePath) {
  const validShape = isPlainJsonObject(job)
    && job.id === expectedJobId
    && job.workspace === expectedWorkspacePath
    && isNonEmptyString(job.ownerSessionId)
    && isNonEmptyString(job.ownerTurnId)
    && JOB_COMMANDS.includes(job.command)
    && typeof job.readOnly === 'boolean'
    && isPlainJsonObject(job.permissionSnapshot)
    && typeof job.status === 'string' && JOB_STATUSES.includes(job.status)
    && isValidDateString(job.createdAt) && isValidDateString(job.updatedAt)
    && (!('childPid' in job) || Number.isSafeInteger(job.childPid) && job.childPid > 0)
    && (!('exitCode' in job) || job.exitCode === null || Number.isSafeInteger(job.exitCode))
    && (!('zcodeSessionId' in job) || isNonEmptyString(job.zcodeSessionId))
    && (!('model' in job) || isModel(job.model))
    && (!('effort' in job) || EFFORT_LEVELS.includes(job.effort))
    && (!('startedAt' in job) || isIsoTimestamp(job.startedAt))
    && (!('finishedAt' in job) || isIsoTimestamp(job.finishedAt))
    && (!('promptArtifact' in job) || isSafeArtifact(job.promptArtifact))
    && (!('resultArtifact' in job) || isSafeArtifact(job.resultArtifact))
    && (!('error' in job) || isTrackedError(job.error))
    && (!('lastCancelError' in job) || isCancellationError(job.lastCancelError));
  const terminal = validShape && TERMINAL_STATUSES.has(job.status);
  const hasRunningMetadata = validShape && [
    'childPid', 'effort', 'model', 'promptArtifact', 'startedAt', 'zcodeSessionId',
  ].some((field) => field in job);
  const validLifecycle = validShape
    && (!hasRunningMetadata || job.status !== 'queued')
    && (!('exitCode' in job) || terminal)
    && (!('finishedAt' in job) || terminal)
    && (!('resultArtifact' in job) || job.status === 'succeeded')
    && (!('error' in job) || job.status === 'failed' || job.status === 'cancelled')
    && (!('lastCancelError' in job) || job.status === 'running' || terminal);
  const createdAt = validShape ? Date.parse(job.createdAt) : Number.NaN;
  const startedAt = validShape && 'startedAt' in job ? Date.parse(job.startedAt) : undefined;
  const finishedAt = validShape && 'finishedAt' in job ? Date.parse(job.finishedAt) : undefined;
  const validTimeline = validShape
    && Date.parse(job.updatedAt) >= createdAt
    && (startedAt === undefined || startedAt >= createdAt)
    && (finishedAt === undefined || finishedAt >= (startedAt ?? createdAt));
  if (!validLifecycle || !validTimeline) {
    throw new PluginError('JOB_RECORD_INVALID', 'Persisted job record failed schema validation.', {
      category: 'state',
      remedy: 'Restore or remove the corrupted job record.',
      details: {
        actualJobId: typeof job?.id === 'string' ? job.id : undefined,
        actualWorkspace: typeof job?.workspace === 'string' ? job.workspace : undefined,
        expectedJobId,
        expectedWorkspace: expectedWorkspacePath,
      },
    });
  }
  return job;
}

/** @param {any} job @param {string} nextStatus @param {Record<string, unknown>} patch @param {string} jobId */
function validateJobPatch(job, nextStatus, patch, jobId) {
  const currentStatus = job.status;
  const invalidFields = [];
  const writesRunningMetadata = nextStatus === 'running'
    && (currentStatus === 'queued' || currentStatus === 'running' || currentStatus === 'cancelling');
  if ('childPid' in patch && (!Number.isSafeInteger(patch.childPid) || Number(patch.childPid) <= 0
    || !writesRunningMetadata)) invalidFields.push('childPid');
  if ('zcodeSessionId' in patch
    && (!isNonEmptyString(patch.zcodeSessionId) || !writesRunningMetadata)) {
    invalidFields.push('zcodeSessionId');
  }
  if ('model' in patch && (!isModel(patch.model) || !writesRunningMetadata)) {
    invalidFields.push('model');
  }
  if ('effort' in patch && (typeof patch.effort !== 'string'
    || !EFFORT_LEVELS.includes(patch.effort) || !writesRunningMetadata)) {
    invalidFields.push('effort');
  }
  if ('startedAt' in patch && (!isIsoTimestamp(patch.startedAt)
    || Date.parse(/** @type {string} */ (patch.startedAt)) < Date.parse(job.createdAt)
    || currentStatus !== 'queued' || nextStatus !== 'running')) invalidFields.push('startedAt');
  if ('finishedAt' in patch && (!isIsoTimestamp(patch.finishedAt)
    || Date.parse(/** @type {string} */ (patch.finishedAt))
      < Date.parse(job.startedAt ?? job.createdAt)
    || !TERMINAL_STATUSES.has(nextStatus))) invalidFields.push('finishedAt');
  if ('promptArtifact' in patch
    && (!isSafeArtifact(patch.promptArtifact) || !writesRunningMetadata)) {
    invalidFields.push('promptArtifact');
  }
  if ('resultArtifact' in patch
    && (!isSafeArtifact(patch.resultArtifact) || nextStatus !== 'succeeded')) {
    invalidFields.push('resultArtifact');
  }
  if ('error' in patch && (!isTrackedError(patch.error)
    || (nextStatus !== 'failed' && nextStatus !== 'cancelled'))) invalidFields.push('error');
  if ('exitCode' in patch && (patch.exitCode !== null && !Number.isSafeInteger(patch.exitCode)
    || !TERMINAL_STATUSES.has(nextStatus))) invalidFields.push('exitCode');
  if ('lastCancelError' in patch && (currentStatus !== 'cancelling' || nextStatus !== 'running'
    || !isCancellationError(patch.lastCancelError))) invalidFields.push('lastCancelError');
  if (invalidFields.length > 0) {
    throw invalidJobPatch(jobId, invalidFields, nextStatus, currentStatus);
  }
}

/** @param {string} jobId @param {string[]} invalidFields @param {string} nextStatus @param {string} [currentStatus] */
function invalidJobPatch(jobId, invalidFields, nextStatus, currentStatus) {
  return new PluginError('JOB_PATCH_INVALID', 'Job patch is invalid for this transition.', {
    category: 'state',
    remedy: 'Use typed execution fields only in their applicable lifecycle transition.',
    details: { currentStatus, invalidFields, jobId, nextStatus },
  });
}

/** @param {unknown} value */
function isCancellationError(value) {
  return isTrackedError(value);
}

/** @param {unknown} value */
function isTrackedError(value) {
  return isNonEmptyString(value) || (isPlainJsonObject(value) && isNonEmptyString(value.message));
}

/** @param {unknown} value */
function isModel(value) {
  if (isNonEmptyString(value)) return true;
  if (!isPlainJsonObject(value) || !isNonEmptyString(value.providerId)
    || !isNonEmptyString(value.modelId)) return false;
  if ('variant' in value && !isNonEmptyString(value.variant)) return false;
  return Object.keys(value).every((key) => key === 'providerId' || key === 'modelId' || key === 'variant');
}

/** @param {unknown} value */
function isSafeArtifact(value) {
  if (!isNonEmptyString(value) || value !== value.trim() || value.length > 1_024
    || value.includes('\0') || /^[\\/]/.test(value) || /^[A-Za-z]:[\\/]/.test(value)) return false;
  return value.split(/[\\/]/).every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** @param {unknown} value */
function isIsoTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

/** @param {unknown} value @returns {value is string} */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** @param {unknown} value */
function isValidDateString(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainJsonObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && isJsonValue(value, new Set());
}

/** @param {unknown} value @param {Set<object>} seen @returns {boolean} */
function isJsonValue(value, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  /** @type {boolean} */
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
      && Object.values(value).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
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
 * @property {string} command
 * @property {boolean} readOnly
 * @property {unknown} permissionSnapshot
 */
