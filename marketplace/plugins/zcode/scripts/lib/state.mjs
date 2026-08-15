import { createHash, randomBytes } from 'node:crypto';
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { PluginError } from './errors.mjs';
import {
  atomicWriteJson,
  ensurePrivateDirectoryWithin,
  readBoundedJsonFile,
  readJsonFile,
  readPrivateDirectory,
  withFileLock,
} from './fs.mjs';
import { isSafeIdentifier } from './identifier.mjs';
import {
  MAX_PROGRESS_PROBE_COUNT,
  MAX_PROGRESS_MESSAGE_BYTES,
  MAX_PROGRESS_PREVIEW_ENTRIES,
  PROGRESS_PHASES,
} from './progress.mjs';
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
const BEFORE_MESSAGE_IDS_MAX_BYTES = 256 * 1024;
const OWNER_INDEX_VERSION = 3;
const OWNER_BINDING_VERSION = 1;
const OWNER_SESSION_ID_MAX_BYTES = 4 * 1024;
const OWNER_BINDING_MAX_BYTES = 8 * 1024;
const OWNER_INDEX_MARKER_MAX_BYTES = 1024;
const OWNER_JOB_ENTRIES_MAX = 10_000;
const JOB_PATCH_FIELDS = new Set([
  'beforeMessageIds', 'childPid', 'effort', 'error', 'exitCode', 'finishedAt', 'inputId',
  'lastCancelError', 'model', 'promptArtifact', 'resultArtifact', 'startedAt', 'startRevision',
  'workerLeaseId', 'zcodeSessionId',
]);
const TRANSITIONS = new Map([
  ['queued', new Set(['running', 'failed', 'cancelled'])],
  ['running', new Set(['running', 'cancelling', 'succeeded', 'failed'])],
  ['cancelling', new Set(['cancelled', 'running', 'succeeded', 'failed'])],
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
    dataRoot,
    /** @param {JobReservation} reservation */
    async reserveJob(reservation) {
      validateReservation(reservation);
      const storage = await jobStorage(dataRoot, reservation.workspace);
      return withFileLock(storage.lockPath, async () => {
        const jobs = await readAllJobs(storage.jobsDirectory, storage.workspacePath);
        await ensureOwnerIndex(storage, jobs);
        if (!reservation.readOnly && jobs.some(isActiveWritableJob)) {
          throw new PluginError('WRITABLE_JOB_EXISTS', 'This workspace already has an active writable rescue job.', {
            category: 'state',
            remedy: 'Retry later or inspect the redacted workspace list with $zcode:status --all.',
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
          ...(reservation.codexThreadId === undefined ? {} : { codexThreadId: reservation.codexThreadId }),
          status: 'queued',
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        // Publish the trusted owner binding first. A crash can then leave only a
        // harmless dangling binding, never an unindexed canonical job.
        await writeOwnerBinding(storage, job);
        await atomicWriteJson(jobPath(storage.jobsDirectory, job.id), job);
        await publishOwnerIndexMarker(storage);
        return job;
      });
    },

    /** @param {string} workspace @param {string} jobId @param {{childPid:number,workerLeaseId:string}} worker */
    async claimJobWorker(workspace, jobId, worker) {
      if (!isNonEmptyString(workspace) || !isDigest(jobId) || !isPlainJsonObject(worker)
        || !Number.isSafeInteger(worker.childPid) || worker.childPid <= 0 || !isDigest(worker.workerLeaseId)) {
        throw new PluginError('WORKER_LEASE_INVALID', 'Worker lease claim is invalid.', {
          category: 'state',
          remedy: 'Claim a queued job with one positive process ID and one 64-character lease digest.',
        });
      }
      const storage = await jobStorage(dataRoot, workspace);
      return withFileLock(storage.lockPath, async () => {
        const path = jobPath(storage.jobsDirectory, jobId);
        const job = await readJobRecord(path, jobId, storage.workspacePath);
        if (job.childPid === worker.childPid && job.workerLeaseId === worker.workerLeaseId) return job;
        if (job.status !== 'queued' || job.childPid !== undefined || job.workerLeaseId !== undefined) {
          throw new PluginError('WORKER_LEASE_CONFLICT', `Job ${jobId} is already claimed or no longer queued.`, {
            category: 'state',
            remedy: 'Only the worker holding the exact durable lease may execute this reservation.',
          });
        }
        const claimed = { ...job, ...worker, updatedAt: new Date(Math.max(Date.now(), Date.parse(job.updatedAt))).toISOString() };
        validateJobRecord(claimed, jobId, storage.workspacePath);
        await atomicWriteJson(path, claimed);
        return claimed;
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
      return transitionStoredJob(dataRoot, workspace, jobId, expectedStatuses, nextStatus, patch, false);
    },

    /**
     * Atomically chooses the terminal timestamp after reading the latest progress under the state lock.
     * @param {string} workspace @param {string} jobId @param {string[]} expectedStatuses
     * @param {string} nextStatus @param {Record<string,unknown>} [patch]
     */
    async finishJob(workspace, jobId, expectedStatuses, nextStatus, patch = {}) {
      validateTransitionInput(workspace, jobId, expectedStatuses, nextStatus, patch);
      if (!TERMINAL_STATUSES.has(nextStatus) || Object.hasOwn(patch, 'finishedAt')) {
        throw new PluginError('JOB_FINISH_INPUT_INVALID', 'Job finalization input is invalid.', {
          category: 'state', remedy: 'Choose a terminal status and let the state store assign finishedAt under its lock.',
          details: { jobId, nextStatus },
        });
      }
      return transitionStoredJob(dataRoot, workspace, jobId, expectedStatuses, nextStatus, patch, true);
    },

    /**
     * @param {string} workspace
     * @param {string} jobId
     * @param {{phase:string,message:string,observedAt:string}} event
     */
    async updateJobProgress(workspace, jobId, event) {
      validateProgressInput(workspace, jobId, event);
      const storage = await jobStorage(dataRoot, workspace);
      return withFileLock(storage.lockPath, async () => {
        const path = jobPath(storage.jobsDirectory, jobId);
        const job = await readJobRecord(path, jobId, storage.workspacePath);
        if (job.status === 'queued' || TERMINAL_STATUSES.has(job.status)) return job;
        const observedAtMs = Date.parse(event.observedAt);
        const currentTime = Date.now();
        const activityFloor = Date.parse(job.lastActivityAt ?? job.startedAt ?? job.createdAt);
        if (observedAtMs < activityFloor || observedAtMs > currentTime) {
          throw invalidProgressInput(['observedAt']);
        }
        const progressPreview = job.progressPreview ?? [];
        const messages = progressPreview.at(-1) === event.message
          ? progressPreview
          : [...progressPreview, event.message].slice(-MAX_PROGRESS_PREVIEW_ENTRIES);
        const updated = {
          ...job,
          phase: event.phase,
          lastActivityAt: event.observedAt,
          progressPreview: messages,
          updatedAt: new Date(Math.max(
            currentTime,
            Date.parse(job.updatedAt),
            observedAtMs,
          )).toISOString(),
        };
        validateJobRecord(updated, jobId, storage.workspacePath);
        await atomicWriteJson(path, updated);
        return updated;
      });
    },

    /** @param {string} workspace @param {string} jobId @param {unknown} progressProbe */
    async updateJobProgressProbe(workspace, jobId, progressProbe) {
      const boundedProbe = normalizeProgressProbeInput(workspace, jobId, progressProbe);
      const storage = await jobStorage(dataRoot, workspace);
      return withFileLock(storage.lockPath, async () => {
        const path = jobPath(storage.jobsDirectory, jobId);
        const job = await readJobRecord(path, jobId, storage.workspacePath);
        if (job.status === 'queued' || TERMINAL_STATUSES.has(job.status)) return job;
        const updated = {
          ...job,
          progressProbe: boundedProbe,
          updatedAt: new Date(Math.max(Date.now(), Date.parse(job.updatedAt))).toISOString(),
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

    /** @param {string} workspace @param {string} ownerSessionId */
    async listOwnedJobs(workspace, ownerSessionId) {
      if (!isNonEmptyString(workspace) || !isBoundedOwnerSessionId(ownerSessionId)) {
        throw new PluginError('OWNED_JOB_LIST_INPUT_INVALID', 'Owned job listing input is invalid.', {
          category: 'state',
          remedy: 'Provide one workspace and its exact bounded Codex session identifier.',
        });
      }
      const storage = await jobStorage(dataRoot, workspace);
      return withFileLock(storage.lockPath, async () => {
        await ensureOwnerIndex(storage);
        const jobs = await readOwnedJobs(storage, ownerSessionId);
        return jobs.sort((left, right) => left.createdAt.localeCompare(right.createdAt)
          || left.id.localeCompare(right.id));
      });
    },
  };
}

/** @param {string} dataRoot @param {string} workspace @param {string} jobId @param {string[]} expectedStatuses @param {string} nextStatus @param {Record<string,unknown>} patch @param {boolean} assignFinishedAt */
async function transitionStoredJob(dataRoot, workspace, jobId, expectedStatuses, nextStatus, patch, assignFinishedAt) {
  const storage = await jobStorage(dataRoot, workspace);
  return withFileLock(storage.lockPath, async () => {
    const forbiddenFields = Object.keys(patch).filter((field) => !JOB_PATCH_FIELDS.has(field));
    if (forbiddenFields.length > 0) {
      throw new PluginError('JOB_PATCH_FORBIDDEN', 'Job patch contains protected or unsupported fields.', {
        category: 'state', remedy: 'Only patch mutable job execution fields.', details: { forbiddenFields, jobId },
      });
    }
    const path = jobPath(storage.jobsDirectory, jobId);
    const job = await readJobRecord(path, jobId, storage.workspacePath);
    const effectivePatch = assignFinishedAt ? {
      ...patch,
      finishedAt: new Date(Math.max(Date.now(), Date.parse(job.lastActivityAt ?? job.startedAt ?? job.createdAt))).toISOString(),
    } : patch;
    validateJobPatch(job, nextStatus, effectivePatch, jobId);
    if (TERMINAL_STATUSES.has(job.status)) {
      throw new PluginError('JOB_TERMINAL', `Job ${jobId} is already terminal.`, {
        category: 'state', remedy: 'Create a new job instead of changing a terminal job.', details: { jobId, status: job.status },
      });
    }
    if (!expectedStatuses.includes(job.status)) {
      throw new PluginError('JOB_STATUS_CONFLICT', `Job ${jobId} changed status unexpectedly.`, {
        category: 'state', remedy: 'Reload the job and retry from its current status.', details: { actualStatus: job.status, expectedStatuses, jobId },
      });
    }
    if (!JOB_STATUSES.includes(nextStatus) || !TRANSITIONS.get(job.status)?.has(nextStatus)) {
      throw new PluginError('JOB_INVALID_TRANSITION', `Cannot transition job from ${job.status} to ${nextStatus}.`, {
        category: 'state', remedy: 'Use a transition allowed by the job state machine.', details: { from: job.status, jobId, to: nextStatus },
      });
    }
    if (job.status === 'cancelling' && nextStatus === 'running' && !isCancellationError(effectivePatch.lastCancelError)) {
      throw new PluginError('CANCEL_ERROR_REQUIRED', 'A failed cancellation must record lastCancelError.', {
        category: 'state', remedy: 'Include the stop failure message in lastCancelError.', details: { jobId },
      });
    }
    const updated = {
      ...job, ...effectivePatch, id: job.id, status: nextStatus,
      updatedAt: new Date(Math.max(
        Date.now(), Date.parse(job.createdAt), Date.parse(job.updatedAt),
        typeof effectivePatch.startedAt === 'string' ? Date.parse(effectivePatch.startedAt) : Number.NEGATIVE_INFINITY,
        typeof effectivePatch.finishedAt === 'string' ? Date.parse(effectivePatch.finishedAt) : Number.NEGATIVE_INFINITY,
      )).toISOString(),
      workspace: job.workspace,
    };
    if (effectivePatch.lastCancelError === null) delete updated.lastCancelError;
    validateJobRecord(updated, jobId, storage.workspacePath);
    await atomicWriteJson(path, updated);
    return updated;
  });
}

/** @param {string} dataRoot @param {string} workspace */
async function jobStorage(dataRoot, workspace) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const jobsDirectory = join(storage.directory, 'jobs');
  const ownerIndexDirectory = join(storage.directory, 'job-owners');
  try {
    await ensurePrivateDirectoryWithin(storage.directory, jobsDirectory);
    await ensurePrivateDirectoryWithin(storage.directory, ownerIndexDirectory);
  } catch { throw ownedJobIndexInvalid(); }
  return {
    ...storage,
    jobsDirectory,
    ownerIndexDirectory,
    ownerIndexMarkerPath: join(ownerIndexDirectory, 'index.json'),
    lockPath: join(storage.directory, '.state.lock'),
  };
}

/**
 * Validate and repair the owner index under the workspace state lock. The
 * marker records both live filename sets and is published last, so a deleted
 * binding, an older writer, or an interrupted reservation cannot hide a job.
 * @param {any} storage @param {any[]} [knownJobs]
 */
async function ensureOwnerIndex(storage, knownJobs) {
  const marker = await readOwnerIndexMarker(storage);
  let layout = await readOwnerIndexLayout(storage);
  if (marker?.version === OWNER_INDEX_VERSION && ownerIndexMarkerMatches(marker, layout)) return layout;

  const knownById = new Map((knownJobs ?? []).map((job) => [job.id, job]));
  const canonicalJobs = [];
  for (const jobId of layout.canonicalJobIds) {
    let job = knownById.get(jobId);
    if (job === undefined) {
      try {
        job = await readJobRecord(jobPath(storage.jobsDirectory, jobId), jobId, storage.workspacePath);
      } catch { throw ownedJobIndexInvalid(jobId); }
    }
    canonicalJobs.push(job);
  }
  const expectedTuples = canonicalJobs.map((job) => ownerBindingTuple(job.ownerSessionId, job.id)).sort();
  const expectedTupleSet = new Set(expectedTuples);
  if (expectedTupleSet.size !== expectedTuples.length) throw ownedJobIndexInvalid();
  for (const job of canonicalJobs) {
    await writeOwnerBinding(storage, job);
  }
  for (const binding of layout.bindings) {
    if (expectedTupleSet.has(binding.tuple)) continue;
    try { await unlink(join(storage.ownerIndexDirectory, binding.ownerDirectory, `${binding.jobId}.json`)); }
    catch { throw ownedJobIndexInvalid(binding.jobId); }
  }
  layout = await readOwnerIndexLayout(storage);
  const actualTuples = layout.bindings.map((binding) => binding.tuple).sort();
  if (!sameStringList(expectedTuples, actualTuples)) throw ownedJobIndexInvalid();
  await writeOwnerIndexMarker(storage, layout);
  return layout;
}

/** @param {any} storage */
async function readOwnerIndexMarker(storage) {
  let marker;
  try {
    marker = await readBoundedJsonFile(
      storage.ownerIndexDirectory,
      storage.ownerIndexMarkerPath,
      OWNER_INDEX_MARKER_MAX_BYTES,
    );
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') return null;
    throw ownedJobIndexInvalid();
  }
  if (isPlainJsonObject(marker)
    && Object.keys(marker).sort().join(',') === 'complete,version'
    && marker.complete === true && marker.version === OWNER_BINDING_VERSION) return marker;
  if (isPlainJsonObject(marker)
    && Object.keys(marker).sort().join(',') === 'bindingJobIds,canonicalJobIds,complete,version'
    && marker.complete === true && marker.version === 2
    && validJobIdSummary(marker.canonicalJobIds) && validJobIdSummary(marker.bindingJobIds)) return marker;
  if (!validOwnerIndexMarker(marker)) throw ownedJobIndexInvalid();
  return marker;
}

/** @param {any} storage @param {any} job */
async function writeOwnerBinding(storage, job) {
  if (!isDigest(job?.id) || !isBoundedOwnerSessionId(job?.ownerSessionId)) {
    throw ownedJobIndexInvalid(isDigest(job?.id) ? job.id : undefined);
  }
  const directory = ownerBindingDirectory(storage.ownerIndexDirectory, job.ownerSessionId);
  try {
    await ensurePrivateDirectoryWithin(storage.ownerIndexDirectory, directory);
    await atomicWriteJson(join(directory, `${job.id}.json`), {
      jobId: job.id,
      ownerSessionId: job.ownerSessionId,
      version: OWNER_BINDING_VERSION,
    }, { privateRoot: storage.ownerIndexDirectory });
  } catch { throw ownedJobIndexInvalid(job.id); }
}

/** @param {any} storage @param {string} ownerSessionId */
async function readOwnedJobs(storage, ownerSessionId) {
  const directory = ownerBindingDirectory(storage.ownerIndexDirectory, ownerSessionId);
  let entries;
  try {
    entries = await readPrivateDirectory(storage.ownerIndexDirectory, directory, OWNER_JOB_ENTRIES_MAX + 1);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') return [];
    throw ownedJobIndexInvalid();
  }
  const unexpected = entries.filter((entry) => !entry.name.startsWith('.')
    && !/^[a-f0-9]{64}\.json$/.test(entry.name));
  const canonical = entries.filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry.name));
  if (unexpected.length > 0 || canonical.length > OWNER_JOB_ENTRIES_MAX) {
    throw ownedJobIndexInvalid();
  }
  const jobs = [];
  for (const entry of canonical) {
    const jobId = entry.name.slice(0, -'.json'.length);
    let binding;
    try {
      binding = await readBoundedJsonFile(
        storage.ownerIndexDirectory,
        join(directory, entry.name),
        OWNER_BINDING_MAX_BYTES,
      );
    } catch {
      throw ownedJobIndexInvalid(jobId);
    }
    if (!isPlainJsonObject(binding)
      || Object.keys(binding).sort().join(',') !== 'jobId,ownerSessionId,version'
      || binding.version !== OWNER_BINDING_VERSION || binding.jobId !== jobId
      || binding.ownerSessionId !== ownerSessionId) {
      throw ownedJobIndexInvalid(jobId);
    }
    let job;
    try {
      job = await readJobRecord(
        jobPath(storage.jobsDirectory, jobId),
        jobId,
        storage.workspacePath,
      );
    } catch (error) {
      // Binding-first publication intentionally makes a missing canonical job
      // a recoverable crash remnant.
      if (error instanceof PluginError && error.code === 'JOB_NOT_FOUND') continue;
      throw ownedJobRecordInvalid(jobId);
    }
    if (job.ownerSessionId !== ownerSessionId) throw ownedJobRecordInvalid(jobId);
    jobs.push(job);
  }
  return jobs;
}

/** @param {string} root @param {string} ownerSessionId */
function ownerBindingDirectory(root, ownerSessionId) {
  return join(root, ownerBindingDirectoryName(ownerSessionId));
}

/** @param {string} ownerSessionId */
function ownerBindingDirectoryName(ownerSessionId) {
  return createHash('sha256')
    .update(`zcode-owner-index-v${OWNER_BINDING_VERSION}\0${ownerSessionId}`)
    .digest('hex');
}

/** @param {any} storage */
async function publishOwnerIndexMarker(storage) {
  const layout = await readOwnerIndexLayout(storage);
  const boundJobIds = new Set(layout.bindings.map((binding) => binding.jobId));
  const unbound = layout.canonicalJobIds.find((jobId) => !boundJobIds.has(jobId));
  if (unbound !== undefined || layout.bindings.length !== layout.canonicalJobIds.length) throw ownedJobIndexInvalid(unbound);
  await writeOwnerIndexMarker(storage, layout);
}

/** @param {any} storage @param {any} layout */
async function writeOwnerIndexMarker(storage, layout) {
  try {
    await atomicWriteJson(storage.ownerIndexMarkerPath, {
      bindingTuples: layout.bindingTuplesSummary,
      canonicalJobIds: layout.canonicalJobIdsSummary,
      complete: true,
      version: OWNER_INDEX_VERSION,
    }, { privateRoot: storage.ownerIndexDirectory });
  } catch { throw ownedJobIndexInvalid(); }
}

/** @param {any} storage */
async function readOwnerIndexLayout(storage) {
  let jobEntries; let indexEntries;
  try {
    [jobEntries, indexEntries] = await Promise.all([
      readPrivateDirectory(storage.directory, storage.jobsDirectory, OWNER_JOB_ENTRIES_MAX),
      readPrivateDirectory(storage.directory, storage.ownerIndexDirectory, OWNER_JOB_ENTRIES_MAX + 1),
    ]);
  } catch { throw ownedJobIndexInvalid(); }
  const canonicalJobIds = jobEntries.map((entry) => entry.name)
    .filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry))
    .map((entry) => entry.slice(0, -'.json'.length));
  if (canonicalJobIds.length > OWNER_JOB_ENTRIES_MAX) throw ownedJobIndexInvalid();

  const visibleIndexEntries = indexEntries.filter((entry) => !entry.name.startsWith('.'));
  const unexpected = visibleIndexEntries.filter((entry) => entry.name !== 'index.json'
    && !/^[a-f0-9]{64}$/.test(entry.name));
  const ownerDirectories = visibleIndexEntries.filter((entry) => /^[a-f0-9]{64}$/.test(entry.name));
  if (unexpected.length > 0 || ownerDirectories.length > OWNER_JOB_ENTRIES_MAX) throw ownedJobIndexInvalid();
  const bindings = [];
  for (const ownerDirectory of ownerDirectories) {
    let entries;
    try { entries = await readPrivateDirectory(storage.ownerIndexDirectory, join(storage.ownerIndexDirectory, ownerDirectory.name), OWNER_JOB_ENTRIES_MAX + 1); }
    catch { throw ownedJobIndexInvalid(); }
    const invalid = entries.filter((entry) => !entry.name.startsWith('.')
      && !/^[a-f0-9]{64}\.json$/.test(entry.name));
    if (invalid.length > 0) throw ownedJobIndexInvalid();
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const jobId = entry.name.slice(0, -'.json'.length);
      bindings.push({ jobId, ownerDirectory: ownerDirectory.name, tuple: `${ownerDirectory.name}/${jobId}` });
      if (bindings.length > OWNER_JOB_ENTRIES_MAX) throw ownedJobIndexInvalid();
    }
  }
  return {
    bindings,
    bindingTuplesSummary: summarizeBindingTuples(bindings.map((binding) => binding.tuple)),
    canonicalJobIds,
    canonicalJobIdsSummary: summarizeJobIds(canonicalJobIds),
  };
}

/** @param {string[]} jobIds */
function summarizeJobIds(jobIds) {
  const hash = createHash('sha256').update('zcode-owner-index-job-ids-v2\0');
  for (const jobId of [...jobIds].sort()) hash.update(jobId);
  return { count: jobIds.length, digest: hash.digest('hex') };
}

/** @param {string[]} tuples */
function summarizeBindingTuples(tuples) {
  const hash = createHash('sha256').update('zcode-owner-index-binding-tuples-v3\0');
  for (const tuple of [...tuples].sort()) hash.update(tuple);
  return { count: tuples.length, digest: hash.digest('hex') };
}

/** @param {any} marker @param {any} layout */
function ownerIndexMarkerMatches(marker, layout) {
  return marker.complete === true && marker.version === OWNER_INDEX_VERSION
    && markerSummaryMatches(marker.canonicalJobIds, layout.canonicalJobIdsSummary)
    && markerSummaryMatches(marker.bindingTuples, layout.bindingTuplesSummary);
}

/** @param {any} marker */
function validOwnerIndexMarker(marker) {
  return isPlainJsonObject(marker)
    && Object.keys(marker).sort().join(',') === 'bindingTuples,canonicalJobIds,complete,version'
    && marker.complete === true && marker.version === OWNER_INDEX_VERSION
    && validJobIdSummary(marker.canonicalJobIds) && validJobIdSummary(marker.bindingTuples);
}

/** @param {any} value */
function validJobIdSummary(value) {
  return isPlainJsonObject(value)
    && Object.keys(value).sort().join(',') === 'count,digest'
    && Number.isSafeInteger(value.count) && value.count >= 0 && value.count <= OWNER_JOB_ENTRIES_MAX
    && isDigest(value.digest);
}

/** @param {any} left @param {any} right */
function markerSummaryMatches(left, right) {
  return left.count === right.count && left.digest === right.digest;
}

/** @param {string} ownerSessionId @param {string} jobId */
function ownerBindingTuple(ownerSessionId, jobId) {
  return `${ownerBindingDirectoryName(ownerSessionId)}/${jobId}`;
}

/** @param {string[]} left @param {string[]} right */
function sameStringList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** @param {string} [jobId] */
function ownedJobIndexInvalid(jobId) {
  return new PluginError('OWNED_JOB_INDEX_INVALID', 'Trusted owned-job index failed validation.', {
    category: 'state',
    remedy: 'Repair the private owner index before retrying recovery.',
    details: jobId === undefined ? {} : { jobId },
  });
}

/** @param {string} jobId */
function ownedJobRecordInvalid(jobId) {
  return new PluginError('OWNED_JOB_RECORD_INVALID', `Owned job ${jobId} failed validation.`, {
    category: 'state',
    remedy: 'Repair the owned canonical job record before retrying recovery.',
    details: { jobId },
  });
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
  if (!isBoundedOwnerSessionId(reservation.ownerSessionId)) invalidFields.push('ownerSessionId');
  if (!isNonEmptyString(reservation.ownerTurnId)) invalidFields.push('ownerTurnId');
  if (!JOB_COMMANDS.includes(reservation.command)) invalidFields.push('command');
  if (typeof reservation.readOnly !== 'boolean') invalidFields.push('readOnly');
  if (!isPlainJsonObject(reservation.permissionSnapshot)) invalidFields.push('permissionSnapshot');
  if (reservation.command === 'transfer' ? !isBoundedThreadId(reservation.codexThreadId) : reservation.codexThreadId !== undefined) invalidFields.push('codexThreadId');
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

/** @param {unknown} workspace @param {unknown} jobId @param {unknown} event */
function validateProgressInput(workspace, jobId, event) {
  const invalidFields = [];
  if (!isNonEmptyString(workspace)) invalidFields.push('workspace');
  if (!isDigest(jobId)) invalidFields.push('jobId');
  if (!isPlainJsonObject(event)) invalidFields.push('event');
  else {
    const fields = Object.keys(event);
    const extraFields = fields.filter((field) => !['message', 'observedAt', 'phase'].includes(field));
    if (extraFields.length > 0) invalidFields.push(...extraFields);
    if (!PROGRESS_PHASES.includes(event.phase)) invalidFields.push('phase');
    if (!isSafeProgressMessage(event.message)) invalidFields.push('message');
    if (!isIsoTimestamp(event.observedAt)) invalidFields.push('observedAt');
  }
  if (invalidFields.length > 0) throw invalidProgressInput(invalidFields);
}

const PROGRESS_PROBE_STATES = new Set(['probing', 'online', 'snapshot-fallback', 'lifecycle-only']);
const PROGRESS_PROBE_REJECTIONS = ['wire-version', 'envelope-shape', 'sequence', 'topic', 'row-kind', 'row-shape'];

/** @param {unknown} value */
function validProgressProbe(value) {
  if (!isPlainJsonObject(value)
    || Object.keys(value).sort().join(',') !== 'acceptedInitial,acceptedOnline,acceptedRecovery,framesReceived,rejected,snapshotFallbackActive,snapshotFallbackUnavailable,state,subscriptionAcknowledged'
    || !PROGRESS_PROBE_STATES.has(value.state)
    || typeof value.subscriptionAcknowledged !== 'boolean'
    || typeof value.snapshotFallbackActive !== 'boolean'
    || typeof value.snapshotFallbackUnavailable !== 'boolean'
    || !isPlainJsonObject(value.rejected)
    || Object.keys(value.rejected).sort().join(',') !== [...PROGRESS_PROBE_REJECTIONS].sort().join(',')) return false;
  for (const field of ['framesReceived', 'acceptedInitial', 'acceptedOnline', 'acceptedRecovery']) {
    if (!boundedProbeCount(value[field])) return false;
  }
  for (const reason of PROGRESS_PROBE_REJECTIONS) if (!boundedProbeCount(value.rejected[reason])) return false;
  if (value.state === 'snapshot-fallback') return value.snapshotFallbackActive && !value.snapshotFallbackUnavailable;
  if (value.state === 'lifecycle-only') return !value.snapshotFallbackActive && value.snapshotFallbackUnavailable;
  return !value.snapshotFallbackActive && !value.snapshotFallbackUnavailable;
}

/** @param {unknown} value */
function boundedProbeCount(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_PROGRESS_PROBE_COUNT; }

/** @param {unknown} workspace @param {unknown} jobId @param {unknown} progressProbe */
function normalizeProgressProbeInput(workspace, jobId, progressProbe) {
  const invalid = () => new PluginError('JOB_PROGRESS_PROBE_INPUT_INVALID', 'Job progress compatibility probe is invalid.', {
    category: 'state', remedy: 'Provide only the fixed bounded progress compatibility schema.',
  });
  if (!isNonEmptyString(workspace) || !isDigest(jobId) || !isPlainJsonObject(progressProbe)
    || Object.keys(progressProbe).sort().join(',') !== 'acceptedInitial,acceptedOnline,acceptedRecovery,framesReceived,rejected,snapshotFallbackActive,snapshotFallbackUnavailable,state,subscriptionAcknowledged'
    || !isPlainJsonObject(progressProbe.rejected)
    || Object.keys(progressProbe.rejected).sort().join(',') !== [...PROGRESS_PROBE_REJECTIONS].sort().join(',')) throw invalid();
  const normalized = /** @type {Record<string,any>} */ ({ ...progressProbe, rejected: { ...progressProbe.rejected } });
  for (const field of ['framesReceived', 'acceptedInitial', 'acceptedOnline', 'acceptedRecovery']) {
    if (!Number.isSafeInteger(normalized[field]) || normalized[field] < 0) throw invalid();
    normalized[field] = Math.min(MAX_PROGRESS_PROBE_COUNT, normalized[field]);
  }
  for (const reason of PROGRESS_PROBE_REJECTIONS) {
    if (!Number.isSafeInteger(normalized.rejected[reason]) || normalized.rejected[reason] < 0) throw invalid();
    normalized.rejected[reason] = Math.min(MAX_PROGRESS_PROBE_COUNT, normalized.rejected[reason]);
  }
  if (!validProgressProbe(normalized)) throw invalid();
  return normalized;
}

/** @param {string[]} invalidFields */
function invalidProgressInput(invalidFields) {
  return new PluginError('JOB_PROGRESS_INPUT_INVALID', 'Job progress input is invalid.', {
    category: 'state',
    remedy: 'Provide one fixed phase, bounded control-free message, and ISO observation timestamp.',
    details: { invalidFields },
  });
}

/** @param {any} job @param {string} expectedJobId @param {string} expectedWorkspacePath @returns {any} */
function validateJobRecord(job, expectedJobId, expectedWorkspacePath) {
  const validShape = isPlainJsonObject(job)
    && job.id === expectedJobId
    && job.workspace === expectedWorkspacePath
    && isBoundedOwnerSessionId(job.ownerSessionId)
    && isNonEmptyString(job.ownerTurnId)
    && JOB_COMMANDS.includes(job.command)
    && typeof job.readOnly === 'boolean'
    && isPlainJsonObject(job.permissionSnapshot)
    && typeof job.status === 'string' && JOB_STATUSES.includes(job.status)
    && isValidDateString(job.createdAt) && isValidDateString(job.updatedAt)
    && (!('childPid' in job) || Number.isSafeInteger(job.childPid) && job.childPid > 0)
    && (!('workerLeaseId' in job) || isDigest(job.workerLeaseId))
    && (!('exitCode' in job) || job.exitCode === null || Number.isSafeInteger(job.exitCode))
    && (!('zcodeSessionId' in job) || isSafeIdentifier(job.zcodeSessionId))
    && (!('codexThreadId' in job) || job.command === 'transfer' && isBoundedThreadId(job.codexThreadId))
    && (job.command !== 'transfer' || isBoundedThreadId(job.codexThreadId))
    && (!('model' in job) || isModel(job.model))
    && (!('effort' in job) || EFFORT_LEVELS.includes(job.effort))
    && (!('startedAt' in job) || isIsoTimestamp(job.startedAt))
    && (!('finishedAt' in job) || isIsoTimestamp(job.finishedAt))
    && (!('promptArtifact' in job) || isSafeArtifact(job.promptArtifact))
    && (!('resultArtifact' in job) || isSafeArtifact(job.resultArtifact))
    && (!('error' in job) || isTrackedError(job.error))
    && (!('lastCancelError' in job) || isCancellationError(job.lastCancelError))
    && (!('phase' in job) || PROGRESS_PHASES.includes(job.phase))
    && (!('lastActivityAt' in job) || isIsoTimestamp(job.lastActivityAt))
    && (!('progressPreview' in job) || validProgressPreview(job.progressPreview))
    && (!('progressProbe' in job) || validProgressProbe(job.progressProbe));
  const boundaryFields = ['inputId', 'startRevision', 'beforeMessageIds'];
  const hasBoundary = boundaryFields.some((field) => field in job);
  const validBoundary = !hasBoundary || boundaryFields.every((field) => field in job)
    && isSafeIdentifier(job.inputId) && Number.isSafeInteger(job.startRevision) && job.startRevision >= 0
    && validBeforeMessageIds(job.beforeMessageIds)
    && typeof job.zcodeSessionId === 'string' && typeof job.startedAt === 'string' && job.status !== 'queued';
  const terminal = validShape && TERMINAL_STATUSES.has(job.status);
  const validQueuedClaim = job.status !== 'queued'
    || ('childPid' in job) === ('workerLeaseId' in job);
  const hasRunningMetadata = validShape && [
    'effort', 'model', 'promptArtifact', 'startedAt', 'zcodeSessionId',
  ].some((field) => field in job);
  const validLifecycle = validShape && validBoundary && validQueuedClaim
    && (!hasRunningMetadata || job.status !== 'queued')
    && (!('exitCode' in job) || terminal)
    && (!('finishedAt' in job) || terminal)
    && (!('resultArtifact' in job) || job.status === 'succeeded')
    && (!('error' in job) || job.status === 'failed' || job.status === 'cancelled')
    && (!('lastCancelError' in job) || job.status === 'running' || terminal);
  const createdAt = validShape ? Date.parse(job.createdAt) : Number.NaN;
  const startedAt = validShape && 'startedAt' in job ? Date.parse(job.startedAt) : undefined;
  const finishedAt = validShape && 'finishedAt' in job ? Date.parse(job.finishedAt) : undefined;
  const lastActivityAt = validShape && 'lastActivityAt' in job
    ? Date.parse(job.lastActivityAt) : undefined;
  const progressFields = ['phase', 'lastActivityAt', 'progressPreview'];
  const hasProgress = progressFields.some((field) => field in job);
  const validProgress = !hasProgress || progressFields.every((field) => field in job)
    && job.status !== 'queued'
    && lastActivityAt !== undefined
    && lastActivityAt >= (startedAt ?? createdAt)
    && Date.parse(job.updatedAt) >= lastActivityAt
    && (!terminal || finishedAt !== undefined && finishedAt >= lastActivityAt);
  const validTimeline = validShape
    && Date.parse(job.updatedAt) >= createdAt
    && (startedAt === undefined || Date.parse(job.updatedAt) >= startedAt)
    && (finishedAt === undefined || Date.parse(job.updatedAt) >= finishedAt)
    && (startedAt === undefined || startedAt >= createdAt)
    && (finishedAt === undefined || finishedAt >= (startedAt ?? createdAt));
  if (!validLifecycle || !validProgress || !validTimeline) {
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
  if ('workerLeaseId' in patch && (!isDigest(patch.workerLeaseId)
    || currentStatus !== 'queued' || nextStatus !== 'running')) invalidFields.push('workerLeaseId');
  if ('zcodeSessionId' in patch
    && (!isSafeIdentifier(patch.zcodeSessionId) || !writesRunningMetadata)) {
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
    || typeof job.lastActivityAt === 'string'
      && Date.parse(/** @type {string} */ (patch.finishedAt)) < Date.parse(job.lastActivityAt)
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
  if ('lastCancelError' in patch
    && !(currentStatus === 'cancelling' && nextStatus === 'running' && isCancellationError(patch.lastCancelError))
    && !(currentStatus === 'running' && nextStatus === 'running' && isCancellationError(patch.lastCancelError))
    && !(currentStatus === 'running' && nextStatus === 'cancelling' && patch.lastCancelError === null)) invalidFields.push('lastCancelError');
  const boundaryFields = ['inputId', 'startRevision', 'beforeMessageIds'];
  if (boundaryFields.some((field) => field in patch)
    && (currentStatus !== 'running' || nextStatus !== 'running' || 'inputId' in job
      || !boundaryFields.every((field) => field in patch)
      || !isSafeIdentifier(patch.inputId)
      || !Number.isSafeInteger(patch.startRevision) || Number(patch.startRevision) < 0
      || !validBeforeMessageIds(patch.beforeMessageIds))) invalidFields.push('turnBoundary');
  if (invalidFields.length > 0) {
    throw invalidJobPatch(jobId, invalidFields, nextStatus, currentStatus);
  }
}

/** @param {unknown} value */
function isDigest(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }

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
function isBoundedThreadId(value) { return isNonEmptyString(value) && Buffer.byteLength(value) <= 512 && ![...value].some((character) => { const code = /** @type {number} */ (character.codePointAt(0)); return code <= 31 || code === 127; }); }

/** @param {unknown} value */
function isBoundedOwnerSessionId(value) {
  return isNonEmptyString(value) && Buffer.byteLength(value) <= OWNER_SESSION_ID_MAX_BYTES
    && ![...value].some((character) => {
      const code = /** @type {number} */ (character.codePointAt(0));
      return code <= 31 || code === 127;
    });
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
function validBeforeMessageIds(value) {
  if (!Array.isArray(value) || value.length > 10_000 || new Set(value).size !== value.length) return false;
  let bytes = 0;
  for (const messageId of value) {
    if (!isSafeIdentifier(messageId)) return false;
    bytes += Buffer.byteLength(messageId);
    if (bytes > BEFORE_MESSAGE_IDS_MAX_BYTES) return false;
  }
  return true;
}

/** @param {unknown} value */
function validProgressPreview(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= MAX_PROGRESS_PREVIEW_ENTRIES
    && value.every(isSafeProgressMessage);
}

/** @param {unknown} value */
function isSafeProgressMessage(value) {
  return isNonEmptyString(value)
    && Buffer.byteLength(value) <= MAX_PROGRESS_MESSAGE_BYTES
    && ![...value].some((character) => {
      const code = /** @type {number} */ (character.codePointAt(0));
      return code <= 31 || code >= 127 && code <= 159 || isBidiControl(code);
    });
}

/** @param {number} code */
function isBidiControl(code) {
  return code === 0x061c || code === 0x200e || code === 0x200f
    || code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069;
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
 * @property {string} [codexThreadId]
 */
