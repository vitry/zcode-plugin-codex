import { createHash, randomBytes } from 'node:crypto';
import { lstat, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { PluginError } from './errors.mjs';
import { isCanonicalCodexAgentPath } from './codex-app-server.mjs';
import {
  atomicWriteJson,
  ensurePrivateDirectoryWithin,
  readBoundedJsonFile,
  readJsonFile,
  readPrivateDirectory,
  withFileLock,
} from './fs.mjs';
import { isSafeIdentifier } from './identifier.mjs';
import { PERMISSION_MODES } from './identity.mjs';
import { consumePendingLegacyChildAuthorityContext, readPendingLegacyChildAuthorityContext } from './invocation.mjs';
import { consumeConsumedLegacyChildAuthorityContext, readConsumedLegacyChildAuthorityContext } from './rescue-preparation.mjs';
import {
  closeRescueBinding,
  createRescueBindingAuthority,
  createRescueBindingPartition,
  createRescueBinding,
  readRescueBindingAuthorityFile,
  readRescueBindingPartitionFile,
  rescueBindingAuthorityView,
  rescueBindingKey,
  rescueBindingPartitionKey,
  RESCUE_BINDING_MAX_RECORDS,
  RESCUE_BINDING_PARTITION_MAX_BYTES,
  validateRescueBinding,
  validateRescueBindingChildAuthority,
} from './rescue-binding.mjs';
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
const OWNER_BINDING_RECORD_VERSION = 2;
const OWNER_SESSION_ID_MAX_BYTES = 4 * 1024;
const OWNER_BINDING_MAX_BYTES = 8 * 1024;
const OWNER_INDEX_MARKER_MAX_BYTES = 1024;
const OWNER_JOB_ENTRIES_MAX = 10_000;
const RESCUE_BINDING_CLOSED_GC_MS = 30 * 24 * 60 * 60_000;
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

/** @typedef {{parentSessionId:string,childAgentId:string,childAgentType:string,operationId:string,originWorkspace:string,executionWorkspace:string,bindingDigest:string,agentPathDigest?:string,agentPath?:string}} RescueMigrationProof */
/** @typedef {{workspace:string,parentSessionId:string,executorAgentId:string,executorAgentType?:string,executorParentTurnId?:string,executorParentPermissionMode?:string,executorAgentPath?:string,permissionMode?:string,migrationProof?:RescueMigrationProof}} RescueBindingResumeInput */
/** @typedef {{kind:'missing'}|{kind:'bound',operationId:string,anchorJob:any,currentJob:any,binding:any}} RescueBindingResumeResult */

/** @param {{ dataRoot: string, testOnlyPublicationHook?:(seam:string)=>void|Promise<void>, testOnlyBindingPartitionMaxBytes?:number, testOnlyExecutionClaimWriteOptions?:{testOnlyAfterRename?:()=>void|Promise<void>} }} options Test-only fields are deterministic seams; production callers must omit them. */
export function createStateStore(options) {
  const validOptions = options !== null && typeof options === 'object' && !Array.isArray(options)
    && [Object.prototype, null].includes(Object.getPrototypeOf(options))
    && Object.keys(options).every((key) => ['dataRoot', 'testOnlyBindingPartitionMaxBytes', 'testOnlyExecutionClaimWriteOptions', 'testOnlyPublicationHook'].includes(key));
  const dataRoot = validOptions ? options.dataRoot : undefined;
  if (typeof dataRoot !== 'string' || dataRoot.length === 0) {
    throw new PluginError('DATA_ROOT_REQUIRED', 'A plugin data root must be provided explicitly.', {
      category: 'configuration',
      remedy: 'Pass the installed plugin data directory as dataRoot.',
    });
  }
  if (options.testOnlyPublicationHook !== undefined && typeof options.testOnlyPublicationHook !== 'function') throw new TypeError('testOnlyPublicationHook must be a function');
  if (options.testOnlyExecutionClaimWriteOptions !== undefined
    && (typeof options.testOnlyExecutionClaimWriteOptions !== 'object' || options.testOnlyExecutionClaimWriteOptions === null
      || Array.isArray(options.testOnlyExecutionClaimWriteOptions)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options.testOnlyExecutionClaimWriteOptions))
      || Object.keys(options.testOnlyExecutionClaimWriteOptions).some((key) => key !== 'testOnlyAfterRename')
      || typeof options.testOnlyExecutionClaimWriteOptions.testOnlyAfterRename !== 'function')) throw new TypeError('testOnlyExecutionClaimWriteOptions must contain one post-rename callback');
  if (options.testOnlyBindingPartitionMaxBytes !== undefined && (!Number.isSafeInteger(options.testOnlyBindingPartitionMaxBytes)
    || options.testOnlyBindingPartitionMaxBytes < 1 || options.testOnlyBindingPartitionMaxBytes > RESCUE_BINDING_PARTITION_MAX_BYTES)) throw new TypeError('testOnlyBindingPartitionMaxBytes must be a positive bounded integer');
  const publicationHook = options.testOnlyPublicationHook ?? (async () => {});
  const bindingPartitionMaxBytes = options.testOnlyBindingPartitionMaxBytes ?? RESCUE_BINDING_PARTITION_MAX_BYTES;

  return {
    dataRoot,
    /** @param {JobReservation} reservation */
    async reserveJob(reservation) {
      validateReservation(reservation);
      const storage = await jobStorage(dataRoot, reservation.workspace);
      return withFileLock(storage.lockPath, async () => {
        const jobs = await readAllJobs(storage.jobsDirectory, storage.workspacePath);
        await ensureOwnerIndex(storage, jobs);
        return reserveJobLocked(storage, jobs, reservation);
      });
    },

    /** @param {{workspace:string,parentSessionId:string,executorAgentId:string,executorAgentType?:string,executorParentTurnId?:string,executorParentPermissionMode?:string,permissionMode?:string}} input @returns {Promise<{kind:'missing'}|{kind:'bound',binding:any}>} */
    async resolveRescueBinding(input) {
      validateBindingIdentityInput(input);
      const storage = await jobStorage(dataRoot, input.workspace);
      return withFileLock(storage.lockPath, async () => {
        const binding = await readBindingLocked(storage, bindingIdentity(input, storage.workspacePath));
        if (binding === null) return { kind: 'missing' };
        if (binding.state !== 'active') throw closedRescueBinding();
        return { kind: 'bound', binding: { ...binding } };
      });
    },

    /** @param {RescueBindingResumeInput} input @returns {Promise<RescueBindingResumeResult>} */
    async resolveRescueBindingForResume(input) {
      validateBindingIdentityInput(input);
      if (input.migrationProof !== undefined) validateBindingMigrationProof(input.migrationProof);
      const storage = await jobStorage(dataRoot, input.workspace);
      return withFileLock(storage.lockPath, () => resolveBindingForResumeLocked(storage, bindingIdentity(input, storage.workspacePath), input.migrationProof));
    },

    /** @param {{workspace:string,parentSessionId:string,executorAgentId:string,childAgentType:string,originWorkspace:string,executionWorkspace:string,agentPathDigest?:string,agentPath?:string}} input */
    async readRescueBindingMigrationProof(input) {
      validateBindingMigrationLookup(input);
      const storage = await jobStorage(dataRoot, input.workspace);
      return withFileLock(storage.lockPath, async () => {
        const snapshot = await readBindingPartitionSnapshot(storage, input.parentSessionId, true);
        const binding = snapshot.records.get(rescueBindingKey(input)) ?? null;
        if (binding === null) return { kind: 'missing' };
        const authority = rescueBindingAuthorityView(binding);
        if (binding.state === 'active') return { kind: 'bound' };
        if (binding.closeReason !== 'session-ended') return { kind: 'ineligible' };
        if (![1, 2].includes(binding.version)) throw invalidRescueBinding();
        const migrationProof = migrationProofForBinding(binding, input);
        if (migrationProof.childAgentId !== input.executorAgentId || migrationProof.childAgentType !== input.childAgentType
          || migrationProof.originWorkspace !== input.originWorkspace || migrationProof.executionWorkspace !== input.executionWorkspace
          || authority.kind === 'codex-legacy-adoption' && migrationProof.agentPathDigest !== input.agentPathDigest
          || authority.kind === 'subagent-start' && migrationProof.agentPath !== input.agentPath) throw invalidRescueBinding();
        await resolveMigrationBindingJobsLocked(storage, binding);
        return { kind: 'proof', migrationProof };
      });
    },

    /** @param {{workspace:string,parentSessionId:string,executorAgentId:string}} input */
    async readBoundRescueCurrentJob(input) {
      if (!isPlainJsonObject(input) || !isNonEmptyString(input.workspace) || !isBoundedOwnerSessionId(input.parentSessionId) || !isNonEmptyString(input.executorAgentId)) throw invalidRescueBinding();
      const storage = await jobStorage(dataRoot, input.workspace);
      return withFileLock(storage.lockPath, async () => {
        const binding = await readBindingLocked(storage, bindingIdentity(input, storage.workspacePath));
        if (binding === null || binding.state !== 'active') throw binding === null ? invalidRescueBinding() : closedRescueBinding();
        const current = await readExactBindingJob(storage, binding.currentJobId);
        validateCurrentJob(current, binding.parentSessionId, storage.workspacePath);
        return structuredClone(current);
      });
    },

    /** @param {{workspace:string,reservation:JobReservation,executor?:any,authority?:any,expectedOperationId?:string,expectedCurrentJobId?:string,expectedAnchorJobId?:string}} input */
    async reserveFreshRescueJob(input) {
      validateRescueReservationInput(input);
      validateOptionalBindingExpectation(input);
      const storage = await jobStorage(dataRoot, input.workspace);
      return withFileLock(storage.lockPath, async () => {
        const lockIdentity = await captureStateLockIdentity(storage);
        const context = reservationBindingContext(input, storage.workspacePath, /** @type {any} */ (input.reservation.permissionSnapshot).permissionMode, true);
        const exactIdentity = context.identity;
        const readOnlySnapshot = await readBindingPartitionSnapshot(storage, exactIdentity.parentSessionId, true, true);
        const readOnlyPrevious = readOnlySnapshot.records.get(rescueBindingKey(exactIdentity)) ?? null;
        if (input.expectedOperationId !== undefined
          && (!(readOnlyPrevious?.state === 'active' || readOnlyPrevious?.state === 'closed' && readOnlyPrevious.closeReason === 'session-ended') || readOnlyPrevious.operationId !== input.expectedOperationId
            || readOnlyPrevious.anchorJobId !== input.expectedAnchorJobId || readOnlyPrevious.currentJobId !== input.expectedCurrentJobId)) throw staleRescueBinding();
        if (readOnlyPrevious !== null) throw staleRescueBinding();
        const childAuthority = authorityForReservation(context, readOnlyPrevious, input.reservation, storage.workspacePath, true);
        const jobs = await readAllJobs(storage.jobsDirectory, storage.workspacePath);
        const job = makeReservedJob(storage, jobs, input.reservation, 'bound');
        const createdAt = new Date().toISOString();
        const binding = createRescueBinding({ ...exactIdentity, childAuthority,
          anchorJobId: job.id, currentJobId: job.id, operationId: randomBytes(32).toString('hex'), now: createdAt,
          superseded: [] });
        const closedGcCutoff = Date.now() - RESCUE_BINDING_CLOSED_GC_MS;
        const plannedBeforeSnapshot = planBindingSlot(readOnlySnapshot, binding.key, closedGcCutoff);
        const plannedAfterSnapshot = bindingSnapshotWith(plannedBeforeSnapshot, binding);
        ensureProspectiveBindingCapacity(storage, binding.parentSessionId, plannedAfterSnapshot, bindingPartitionMaxBytes);
        await ensureOwnerIndex(storage, jobs);
        const { record: previous, snapshot: beforeSnapshot } = await prepareBindingSlot(storage, exactIdentity, lockIdentity,
          { allowAuthorityOnlyRepair: true, closedGcCutoff });
        if (JSON.stringify(previous) !== JSON.stringify(readOnlyPrevious)) throw invalidRescueBinding();
        if (!sameBindingRecords(beforeSnapshot.records, plannedBeforeSnapshot.records)) throw invalidRescueBinding();
        const afterSnapshot = bindingSnapshotWith(beforeSnapshot, binding);
        await publishRescueReservation(storage, job, binding, { bindingFirst: true, beforeSnapshot, afterSnapshot, lockIdentity, publicationHook, route: 'fresh' });
        await publicationCheckpoint(publicationHook, 'fresh:final'); await assertPublicationGuard(storage, lockIdentity, afterSnapshot, binding.parentSessionId);
        return { job, binding };
      });
    },

    /** @param {{workspace:string,reservation:JobReservation,executor?:any,authority?:any,operationId:string,expectedCurrentJobId?:string,expectedAnchorJobId?:string,migrationProof?:RescueMigrationProof}} input */
    async reserveBoundRescueContinuation(input) {
      validateRescueReservationInput(input);
      if (!isDigest(input.operationId)) throw staleRescueBinding();
      if (input.expectedCurrentJobId !== undefined && !isDigest(input.expectedCurrentJobId)) throw staleRescueBinding();
      const storage = await jobStorage(dataRoot, input.workspace);
      return withFileLock(storage.lockPath, async () => {
        const lockIdentity = await captureStateLockIdentity(storage);
        const context = reservationBindingContext(input, storage.workspacePath, /** @type {any} */ (input.reservation.permissionSnapshot).permissionMode, true);
        const resolved = await resolveBindingForResumeLocked(storage, {
          parentSessionId: context.identity.parentSessionId, executorAgentId: context.identity.executorAgentId,
          workspace: context.identity.workspace, permissionMode: context.identity.permissionMode,
          ...(context.kind === 'hook' && context.childAuthority.agentPath !== undefined
            ? { executorAgentPath: context.childAuthority.agentPath } : {}),
        }, input.migrationProof);
        if (resolved.kind !== 'bound' || resolved.operationId !== input.operationId
          || input.expectedCurrentJobId !== undefined && resolved.binding.currentJobId !== input.expectedCurrentJobId
          || input.expectedAnchorJobId !== undefined && resolved.binding.anchorJobId !== input.expectedAnchorJobId) throw staleRescueBinding();
        authorityForReservation(context, resolved.binding, input.reservation, storage.workspacePath, input.migrationProof !== undefined);
        const jobs = await readAllJobs(storage.jobsDirectory, storage.workspacePath);
        const beforeSnapshot = await readBindingPartitionSnapshot(storage, resolved.binding.parentSessionId, false);
        const reservedJob = makeReservedJob(storage, jobs, input.reservation, 'bound');
        await ensureOwnerIndex(storage, jobs);
        const now = new Date(Math.max(Date.now(), Date.parse(resolved.binding.updatedAt))).toISOString();
        const migrating = resolved.binding.state === 'closed';
        const migrationRollback = migrating ? {
          parentSessionId: resolved.binding.parentSessionId, childAgentId: context.identity.executorAgentId,
          operationId: resolved.binding.operationId, priorCurrentJobId: resolved.binding.currentJobId,
          priorUpdatedAt: resolved.binding.updatedAt, priorClosedAt: resolved.binding.closedAt,
          priorVersion: resolved.binding.version, priorBinding: structuredClone(resolved.binding),
        } : undefined;
        const continuationOrigin = migrating ? undefined : { kind: 'active-continuation', priorBinding: structuredClone(resolved.binding) };
        const job = migrationRollback ? { ...reservedJob, rescueMigrationRollback: migrationRollback }
          : { ...reservedJob, rescueContinuationOrigin: continuationOrigin };
        const binding = migrating
          ? migratedActiveBinding(resolved.binding, input.migrationProof, job.id, now)
          : validateRescueBinding({ ...resolved.binding, currentJobId: job.id, updatedAt: now });
        const afterSnapshot = bindingSnapshotWith(beforeSnapshot, binding);
        await publishRescueReservation(storage, job, binding, { bindingFirst: false, beforeSnapshot, afterSnapshot, lockIdentity, publicationHook, route: 'continuation' });
        await publicationCheckpoint(publicationHook, 'continuation:final'); await assertPublicationGuard(storage, lockIdentity, afterSnapshot, binding.parentSessionId);
        return { job, binding, anchorJob: resolved.anchorJob, ...(migrationRollback ? { migrationRollback } : {}) };
      });
    },

    /**
     * Restore one exact migrated tombstone and commit its queued attempt terminal under the same state lock.
     * Markerless rollback evidence is accepted only for legacy in-flight job specs whose active binding still
     * uniquely points at this queued job.
     * @param {string} workspace @param {string} jobId @param {any} rollback
     * @param {'failed'|'cancelled'} nextStatus @param {Record<string,unknown>} [patch]
     */
    async finishSessionEndedRescueContinuation(workspace, jobId, rollback, nextStatus, patch = {}) {
      validateTransitionInput(workspace, jobId, ['queued'], nextStatus, patch);
      const migrationInput = { workspace, jobId, ...rollback }; validateMigrationRollbackInput(migrationInput);
      if (!sameMigrationRollback(rollback, migrationRollbackFromInput(migrationInput))) throw invalidRescueBinding();
      if (!['failed', 'cancelled'].includes(nextStatus) || Object.hasOwn(patch, 'finishedAt')) throw invalidRescueBinding();
      return transitionStoredJob(dataRoot, workspace, jobId, ['queued'], nextStatus, patch, true,
        { migrationRollback: rollback, publicationHook });
    },

    /** Terminalize one queued recovery candidate only if its exact effective worker lease is unchanged.
     * `null` proves no claimed or private fenced lease existed at the caller's final probe.
     * @param {string} workspace @param {string} jobId @param {string|null} expectedWorkerLeaseId
     * @param {any} rollback @param {'failed'|'cancelled'} nextStatus @param {Record<string,unknown>} [patch] */
    async finishQueuedJobAfterRecoveryLease(workspace, jobId, expectedWorkerLeaseId, rollback, nextStatus, patch = {}) {
      validateTransitionInput(workspace, jobId, ['queued'], nextStatus, patch);
      if (expectedWorkerLeaseId !== null && !isDigest(expectedWorkerLeaseId)
        || rollback !== undefined && !isPlainJsonObject(rollback)
        || !['failed', 'cancelled'].includes(nextStatus) || Object.hasOwn(patch, 'finishedAt')) throw invalidRescueBinding();
      if (rollback !== undefined) {
        const migrationInput = { workspace, jobId, ...rollback }; validateMigrationRollbackInput(migrationInput);
        if (!sameMigrationRollback(rollback, migrationRollbackFromInput(migrationInput))) throw invalidRescueBinding();
      }
      return transitionStoredJob(dataRoot, workspace, jobId, ['queued'], nextStatus, patch, true, {
        ...(rollback === undefined ? {} : { migrationRollback: rollback }),
        publicationHook, recoveryWorkerLeaseId: expectedWorkerLeaseId,
      });
    },

    /**
     * Resolve durable or legacy rollback evidence against the exact queued job and its binding under one lock.
     * Absence is ordinary only with an exact private continuation proof, no current binding, or a fresh-anchor binding.
     * Execution preflight rejects terminal-only publication remnants explicitly; terminal callers omit the mode.
     * @param {string} workspace @param {string} jobId @param {any} legacyRollback @param {'terminal'|'execution'} [mode]
     */
    async resolveQueuedRescueMigrationRollback(workspace, jobId, legacyRollback, mode = 'terminal', legacySpecDigest = undefined) {
      if (!isNonEmptyString(workspace) || !isDigest(jobId)
        || legacyRollback !== undefined && !isPlainJsonObject(legacyRollback)
        || legacySpecDigest !== undefined && (!isDigest(legacySpecDigest) || mode !== 'execution' || legacyRollback === undefined)
        || !['terminal', 'execution'].includes(mode)) throw invalidRescueBinding();
      const storage = await jobStorage(dataRoot, workspace);
      return withFileLock(storage.lockPath, async () => {
        const job = await readJobRecord(jobPath(storage.jobsDirectory, jobId), jobId, storage.workspacePath);
        const classification = await classifyQueuedRescueTransitionLocked(storage, job, legacyRollback, legacySpecDigest,
          mode !== 'execution');
        if (mode === 'execution' && classification.kind === 'ordinary-unadvanced') throw notRunnableRescueBinding();
        return classification.kind === 'migration' ? classification.rollback : undefined;
      });
    },

    /** Publish the sealed payload commitment and private bearer-independent recovery authority before worker exposure.
     * @param {string} workspace @param {string} jobId @param {string} commitment @param {any} [executionReservation] */
    async publishJobSpecCommitment(workspace, jobId, commitment, executionReservation) {
      if (!isNonEmptyString(workspace) || !isDigest(jobId) || !isDigest(commitment)
        || executionReservation !== undefined && !isPlainJsonObject(executionReservation)) throw invalidRescueBinding();
      const storage = await jobStorage(dataRoot, workspace);
      return withFileLock(storage.lockPath, async () => {
        const path = jobPath(storage.jobsDirectory, jobId);
        const job = await readJobRecord(path, jobId, storage.workspacePath);
        if (job.status !== 'queued' || job.childPid !== undefined || job.workerLeaseId !== undefined
          || job.rescueJobSpecCommitment !== undefined || job.rescueLegacyJobSpecProof !== undefined
          || job.rescueExecutionReservation !== undefined
          || executionReservation !== undefined && !validExecutionReservation(executionReservation, job, false)) throw invalidRescueBinding();
        const published = { ...job, rescueJobSpecCommitment: commitment,
          ...(executionReservation === undefined ? {} : { rescueExecutionReservation: structuredClone(executionReservation) }),
          updatedAt: new Date(Math.max(Date.now(), Date.parse(job.updatedAt))).toISOString() };
        validateJobRecord(published, jobId, storage.workspacePath, expectedJobLogPath(storage.jobsDirectory, jobId));
        await atomicWriteJson(path, published);
        return published;
      });
    },

    /** Bind one published modern reservation to the exact attempt lease before Identity reservation.
     * @param {string} workspace @param {string} jobId @param {{capabilityDigest:string,reservationId:string,workerLeaseId:string}} input */
    async bindJobExecutionReservationLease(workspace, jobId, input) {
      if (!isNonEmptyString(workspace) || !isDigest(jobId) || !isPlainJsonObject(input)
        || Object.keys(input).sort().join(',') !== 'capabilityDigest,reservationId,workerLeaseId'
        || !isDigest(input.capabilityDigest) || !isDigest(input.reservationId) || !isDigest(input.workerLeaseId)) throw invalidRescueBinding();
      const storage = await jobStorage(dataRoot, workspace);
      return withFileLock(storage.lockPath, async () => {
        const path = jobPath(storage.jobsDirectory, jobId);
        const job = await readJobRecord(path, jobId, storage.workspacePath);
        const authority = job.rescueExecutionReservation;
        if (job.status !== 'queued' || !validExecutionReservation(authority, job, false)
          || authority.capabilityDigest !== input.capabilityDigest || authority.reservationId !== input.reservationId) throw invalidRescueBinding();
        if (job.childPid !== undefined || job.workerLeaseId !== undefined) {
          if (job.workerLeaseId !== input.workerLeaseId) throw workerLeaseConflict(jobId);
          return job;
        }
        if (authority.workerLeaseId !== undefined) {
          if (authority.workerLeaseId !== input.workerLeaseId) throw workerLeaseConflict(jobId);
          return job;
        }
        const bound = { ...job, rescueExecutionReservation: { ...authority, workerLeaseId: input.workerLeaseId },
          updatedAt: new Date(Math.max(Date.now(), Date.parse(job.updatedAt))).toISOString() };
        validateJobRecord(bound, jobId, storage.workspacePath, expectedJobLogPath(storage.jobsDirectory, jobId));
        await atomicWriteJson(path, bound); return bound;
      });
    },

    /** Atomically publish or bind the exact State execution fence before Identity reservation.
     * @param {string} workspace @param {string} jobId @param {{childPid:number,workerLeaseId:string}} worker
     * @param {any} legacyRollback @param {any} executionAuthorization @param {string} expectedInspection
     * @param {any} executionReservation */
    async fenceJobWorkerExecution(workspace, jobId, worker, legacyRollback, executionAuthorization,
      expectedInspection, executionReservation) {
      validateWorkerClaimInput(workspace, jobId, worker);
      if (legacyRollback !== undefined && !isPlainJsonObject(legacyRollback)
        || !validExecutionAuthorization(executionAuthorization) || !isDigest(expectedInspection)
        || !isPlainJsonObject(executionReservation)) throw invalidRescueBinding();
      const storage = await jobStorage(dataRoot, workspace);
      return withFileLock(storage.lockPath, async () => {
        const path = jobPath(storage.jobsDirectory, jobId);
        const job = await readJobRecord(path, jobId, storage.workspacePath);
        validateJobSpecExecutionAuthorization(job, executionAuthorization, legacyRollback);
        if (job.status !== 'queued' || job.childPid !== undefined || job.workerLeaseId !== undefined) throw workerLeaseConflict(jobId);
        const classification = job.command === 'rescue' && job.readOnly === false
          ? await classifyQueuedRescueTransitionLocked(storage, job, legacyRollback, executionAuthorization?.specDigest, false)
          : undefined;
        validateRunnableExecutionClassification(job, classification, executionAuthorization);
        const currentAuthority = job.rescueExecutionReservation;
        if (executionInspectionDigest(job, classification, legacyRollback, executionAuthorization) !== expectedInspection) {
          throw invalidRescueBinding();
        }
        if (!validExecutionReservation(executionReservation, job, false)
          || executionReservation.workerLeaseId !== undefined) throw invalidRescueBinding();
        if (currentAuthority !== undefined) {
          if (!sameExecutionReservationBase(currentAuthority, executionReservation)) throw invalidRescueBinding();
          if (currentAuthority.workerLeaseId !== undefined && currentAuthority.workerLeaseId !== worker.workerLeaseId) {
            throw workerLeaseConflict(jobId);
          }
        }
        const fenced = { ...job, rescueExecutionReservation: { ...executionReservation, workerLeaseId: worker.workerLeaseId },
          updatedAt: new Date(Math.max(Date.now(), Date.parse(job.updatedAt))).toISOString() };
        validateJobRecord(fenced, jobId, storage.workspacePath, expectedJobLogPath(storage.jobsDirectory, jobId));
        if (currentAuthority?.workerLeaseId === undefined) await atomicWriteJson(path, fenced);
        const persisted = currentAuthority?.workerLeaseId === undefined ? fenced : job;
        return { job: persisted, inspection: executionInspectionDigest(persisted, classification, legacyRollback, executionAuthorization) };
      });
    },

    /** @param {{workspace:string,reservation:JobReservation,executor?:any,authority?:any,candidateJobId:string}} input */
    async adoptRescueCandidate(input) {
      validateRescueReservationInput(input);
      if (!isDigest(input.candidateJobId)) throw invalidRescueBinding();
      const storage = await jobStorage(dataRoot, input.workspace);
      return withFileLock(storage.lockPath, async () => {
        const lockIdentity = await captureStateLockIdentity(storage);
        const permissionMode = /** @type {any} */ (input.reservation.permissionSnapshot).permissionMode;
        const preview = reservationBindingContext(input, storage.workspacePath, permissionMode);
        if (!['hook', 'adoption'].includes(preview.kind)) throw invalidRescueBinding();
        const jobs = await readAllJobs(storage.jobsDirectory, storage.workspacePath);
        const anchorJob = jobs.find((job) => job.id === input.candidateJobId);
        validateAnchorJob(anchorJob, preview.identity.parentSessionId, storage.workspacePath);
        const readOnlySnapshot = await readBindingPartitionSnapshot(storage, preview.identity.parentSessionId, true, true);
        if (readOnlySnapshot.records.has(rescueBindingKey(preview.identity))) throw invalidRescueBinding();
        const previewAuthority = authorityForReservation(preview, null, input.reservation, storage.workspacePath, false);
        const previewBase = createRescueBinding({ ...preview.identity, childAuthority: previewAuthority,
          anchorJobId: anchorJob.id, currentJobId: anchorJob.id, operationId: randomBytes(32).toString('hex'), superseded: [] });
        const plannedBeforeSnapshot = planBindingSlot(readOnlySnapshot, previewBase.key, Date.now() - RESCUE_BINDING_CLOSED_GC_MS);
        ensureProspectiveBindingCapacity(storage, preview.identity.parentSessionId,
          bindingSnapshotWith(plannedBeforeSnapshot, previewBase), bindingPartitionMaxBytes);
        const context = reservationBindingContext(input, storage.workspacePath, permissionMode, true);
        const childAuthority = authorityForReservation(context, null, input.reservation, storage.workspacePath, false);
        if (JSON.stringify(context.identity) !== JSON.stringify(preview.identity)
          || JSON.stringify(childAuthority) !== JSON.stringify(previewAuthority)) throw invalidRescueBinding();
        const exactIdentity = context.identity; await ensureOwnerIndex(storage, jobs);
        const reservedJob = makeReservedJob(storage, jobs, input.reservation, 'bound');
        const { record: existing, snapshot: beforeSnapshot } = await prepareBindingSlot(storage, exactIdentity, lockIdentity);
        if (existing !== null) throw invalidRescueBinding();
        const base = createRescueBinding({ ...exactIdentity, childAuthority,
          anchorJobId: anchorJob.id, currentJobId: anchorJob.id, operationId: randomBytes(32).toString('hex'), superseded: [] });
        const baseSnapshot = bindingSnapshotWith(beforeSnapshot, base);
        ensureProspectiveBindingCapacity(storage, base.parentSessionId, baseSnapshot, bindingPartitionMaxBytes);
        await publicationCheckpoint(publicationHook, 'adopt:base-binding');
        await writeBindingPartitionGuarded(storage, base.parentSessionId, beforeSnapshot, baseSnapshot, lockIdentity);
        const binding = validateRescueBinding({ ...base, currentJobId: reservedJob.id, updatedAt: new Date(Math.max(Date.now(), Date.parse(base.updatedAt))).toISOString() });
        const job = { ...reservedJob, rescueContinuationOrigin: {
          kind: 'legacy-adoption', priorBinding: structuredClone(base), binding: structuredClone(binding),
        } };
        await publishJobRecord(storage, job, { lockIdentity, expectedSnapshot: baseSnapshot, publicationHook, route: 'adopt', parentSessionId: base.parentSessionId });
        const afterSnapshot = bindingSnapshotWith(baseSnapshot, binding);
        await publicationCheckpoint(publicationHook, 'adopt:current-advance');
        await writeBindingPartitionGuarded(storage, binding.parentSessionId, baseSnapshot, afterSnapshot, lockIdentity);
        await publicationCheckpoint(publicationHook, 'adopt:final'); await assertPublicationGuard(storage, lockIdentity, afterSnapshot, binding.parentSessionId);
        return { job, binding, anchorJob };
      });
    },

    /** @param {{workspace:string,parentSessionId:string,executorAgentId:string,operationId:string,reason:'session-ended'|'invalidated'|'cancel'}} input */
    async closeRescueBindingForChild(input) {
      if (!isPlainJsonObject(input) || !isNonEmptyString(input.workspace) || !isBoundedOwnerSessionId(input.parentSessionId)
        || !isNonEmptyString(input.executorAgentId) || !isDigest(input.operationId)
        || !['session-ended', 'invalidated', 'cancel'].includes(input.reason)) throw invalidRescueBinding();
      const storage = await jobStorage(dataRoot, input.workspace);
      return withFileLock(storage.lockPath, async () => {
        const lockIdentity = await captureStateLockIdentity(storage);
        const snapshot = await readBindingPartitionSnapshot(storage, input.parentSessionId, true);
        const key = rescueBindingKey({ parentSessionId: input.parentSessionId,
          executorAgentId: input.executorAgentId, workspace: storage.workspacePath });
        const record = snapshot.records.get(key) ?? null;
        if (record === null) return { kind: 'missing' };
        if (record.operationId !== input.operationId) throw staleRescueBinding();
        if (record.state === 'closed') {
          if (record.closeReason !== input.reason) throw closedRescueBinding();
          return { kind: 'closed', binding: structuredClone(record) };
        }
        const binding = closeRescueBinding(record, { operationId: input.operationId, reason: input.reason });
        const after = bindingSnapshotWith(snapshot, binding);
        await publicationCheckpoint(publicationHook, 'close:binding');
        await writeBindingPartitionGuarded(storage, input.parentSessionId, snapshot, after, lockIdentity);
        return { kind: 'closed', binding };
      });
    },

    /** @param {{workspace:string,parentSessionId:string,jobId:string}} input */
    async closeRescueBindingForCancelledJob(input) {
      if (!isPlainJsonObject(input) || !isNonEmptyString(input.workspace) || !isBoundedOwnerSessionId(input.parentSessionId)
        || !isDigest(input.jobId)) throw invalidRescueBinding();
      const storage = await jobStorage(dataRoot, input.workspace);
      return withFileLock(storage.lockPath, async () => {
        const job = await readExactBindingJob(storage, input.jobId);
        if (job.ownerSessionId !== input.parentSessionId || job.command !== 'rescue' || job.status !== 'cancelled') throw invalidRescueBinding();
        const snapshot = await readBindingPartitionSnapshot(storage, input.parentSessionId, true);
        const matches = [...snapshot.records.values()].filter((record) => record.currentJobId === job.id);
        if (matches.length !== 1) return { kind: 'missing' };
        const record = matches[0];
        if (record.state === 'closed') {
          return { kind: 'closed', binding: structuredClone(record) };
        }
        const lockIdentity = await captureStateLockIdentity(storage);
        const binding = closeRescueBinding(record, { operationId: record.operationId, reason: 'cancel' });
        const after = bindingSnapshotWith(snapshot, binding);
        await writeBindingPartitionGuarded(storage, record.parentSessionId, snapshot, after, lockIdentity);
        return { kind: 'closed', binding };
      });
    },

    /** @param {string} workspace @param {string} jobId @param {{childPid:number,workerLeaseId:string}} worker */
    async claimJobWorker(workspace, jobId, worker) {
      validateWorkerClaimInput(workspace, jobId, worker);
      const storage = await jobStorage(dataRoot, workspace);
      return withFileLock(storage.lockPath, async () => {
        const path = jobPath(storage.jobsDirectory, jobId);
        const job = await readJobRecord(path, jobId, storage.workspacePath);
        if (job.childPid === worker.childPid && job.workerLeaseId === worker.workerLeaseId) return job;
        if (job.status !== 'queued' || job.childPid !== undefined || job.workerLeaseId !== undefined) {
          throw workerLeaseConflict(jobId);
        }
        const claimed = { ...job, ...worker, updatedAt: new Date(Math.max(Date.now(), Date.parse(job.updatedAt))).toISOString() };
        validateJobRecord(claimed, jobId, storage.workspacePath, expectedJobLogPath(storage.jobsDirectory, jobId));
        await atomicWriteJson(path, claimed);
        return claimed;
      });
    },

    /**
     * Read-only validation of the exact queued execution authority. The returned digest is a
     * private CAS token that claimJobWorkerForExecution revalidates under the same state lock.
     * @param {string} workspace @param {string} jobId @param {any} [legacyRollback] @param {any} [executionAuthorization]
     */
    async inspectJobWorkerExecution(workspace, jobId, legacyRollback, executionAuthorization) {
      if (!isNonEmptyString(workspace) || !isDigest(jobId)
        || legacyRollback !== undefined && !isPlainJsonObject(legacyRollback)
        || !validExecutionAuthorization(executionAuthorization)) throw invalidRescueBinding();
      const storage = await jobStorage(dataRoot, workspace);
      return withFileLock(storage.lockPath, async () => {
        const job = await readJobRecord(jobPath(storage.jobsDirectory, jobId), jobId, storage.workspacePath);
        validateJobSpecExecutionAuthorization(job, executionAuthorization, legacyRollback);
        if (job.status !== 'queued' || job.childPid !== undefined || job.workerLeaseId !== undefined) throw workerLeaseConflict(jobId);
        const classification = job.command === 'rescue' && job.readOnly === false
          ? await classifyQueuedRescueTransitionLocked(storage, job, legacyRollback, executionAuthorization?.specDigest, false)
          : undefined;
        validateRunnableExecutionClassification(job, classification, executionAuthorization);
        return executionInspectionDigest(job, classification, legacyRollback, executionAuthorization);
      });
    },

    /**
     * Atomically validates one queued execution's current Rescue authority and claims its worker.
     * The private claim is the linearization point: a later binding close cannot retroactively
     * revoke this attempt, while a close that wins first prevents the claim.
     * @param {string} workspace @param {string} jobId @param {{childPid:number,workerLeaseId:string}} worker
     * @param {any} [legacyRollback] @param {any} [executionAuthorization] @param {string} [expectedInspection]
     */
    async claimJobWorkerForExecution(workspace, jobId, worker, legacyRollback, executionAuthorization, expectedInspection) {
      validateWorkerClaimInput(workspace, jobId, worker);
      if (legacyRollback !== undefined && !isPlainJsonObject(legacyRollback)
        || !validExecutionAuthorization(executionAuthorization)
        || expectedInspection !== undefined && !isDigest(expectedInspection)) throw invalidRescueBinding();
      const storage = await jobStorage(dataRoot, workspace);
      return withFileLock(storage.lockPath, async () => {
        const path = jobPath(storage.jobsDirectory, jobId);
        let job = await readJobRecord(path, jobId, storage.workspacePath); const inspectedJob = job;
        validateJobSpecExecutionAuthorization(job, executionAuthorization, legacyRollback);
        if (job.childPid === worker.childPid && job.workerLeaseId === worker.workerLeaseId
          && validRescueExecutionClaim(job.rescueExecutionClaim, job)) return job;
        if (job.status !== 'queued' || job.childPid !== undefined || job.workerLeaseId !== undefined) throw workerLeaseConflict(jobId);
        let classification;
        if (job.command === 'rescue' && job.readOnly === false) {
          classification = await classifyQueuedRescueTransitionLocked(storage, job, legacyRollback, executionAuthorization?.specDigest, false);
          validateRunnableExecutionClassification(job, classification, executionAuthorization);
          if (expectedInspection !== undefined
            && executionInspectionDigest(inspectedJob, classification, legacyRollback, executionAuthorization) !== expectedInspection) throw invalidRescueBinding();
          if (legacyRollback !== undefined && job.rescueMigrationRollback === undefined) {
            classification = await classifyQueuedRescueTransitionLocked(storage, job, legacyRollback, executionAuthorization?.specDigest, true);
          }
          // Legacy marker adoption may have rewritten the queued job while this lock remained held.
          job = await readJobRecord(path, jobId, storage.workspacePath);
        } else if (expectedInspection !== undefined
          && executionInspectionDigest(inspectedJob, undefined, legacyRollback, executionAuthorization) !== expectedInspection) throw invalidRescueBinding();
        if (job.rescueExecutionReservation !== undefined
          && (!validExecutionReservation(job.rescueExecutionReservation, job, false)
            || job.rescueExecutionReservation.workerLeaseId !== worker.workerLeaseId)) throw invalidRescueBinding();
        const legacyReservation = classification !== undefined && job.rescueReservationKind === undefined;
        const rescueExecutionClaim = classification
          ? executionClaimForClassification(classification, worker.workerLeaseId, legacyReservation) : undefined;
        const claimed = { ...job, ...worker, ...(rescueExecutionClaim ? { rescueExecutionClaim } : {}),
          updatedAt: new Date(Math.max(Date.now(), Date.parse(job.updatedAt))).toISOString() };
        validateJobRecord(claimed, jobId, storage.workspacePath, expectedJobLogPath(storage.jobsDirectory, jobId));
        await atomicWriteJson(path, claimed, options.testOnlyExecutionClaimWriteOptions);
        return claimed;
      });
    },

    /** @param {string} workspace @param {string} jobId @param {string} logFile */
    async attachJobLog(workspace, jobId, logFile) {
      if (!isNonEmptyString(workspace) || !isDigest(jobId) || !isNonEmptyString(logFile)) {
        throw new PluginError('JOB_LOG_INPUT_INVALID', 'Job log attachment input is invalid.', {
          category: 'state', remedy: 'Provide one workspace, canonical job ID, and absolute canonical log path.',
        });
      }
      const storage = await jobStorage(dataRoot, workspace);
      return withFileLock(storage.lockPath, async () => {
        const expectedLogFile = expectedJobLogPath(storage.jobsDirectory, jobId);
        if (logFile !== expectedLogFile) {
          throw new PluginError('JOB_LOG_PATH_INVALID', 'Job log path does not match the canonical job log path.', {
            category: 'state', remedy: 'Attach only the exact log path allocated for this job.', details: { jobId },
          });
        }
        const path = jobPath(storage.jobsDirectory, jobId);
        const job = await readJobRecord(path, jobId, storage.workspacePath);
        if (TERMINAL_STATUSES.has(job.status)) {
          throw new PluginError('JOB_LOG_TERMINAL', `Job ${jobId} is already terminal.`, {
            category: 'state', remedy: 'Attach the log while the job is active.', details: { jobId, status: job.status },
          });
        }
        if (job.logFile === logFile) return job;
        const updated = {
          ...job,
          logFile,
          updatedAt: new Date(Math.max(Date.now(), Date.parse(job.updatedAt))).toISOString(),
        };
        validateJobRecord(updated, jobId, storage.workspacePath, expectedLogFile);
        await atomicWriteJson(path, updated);
        return updated;
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

    /** Terminalize a failed execution attempt only while the job is unclaimed or carries this attempt's exact lease.
     * A competing winner's claim makes this compensation a no-op. @param {string} workspace @param {string} jobId
     * @param {string} workerLeaseId @param {Record<string,unknown>} [patch] */
    async finishJobAfterExecutionClaimFailure(workspace, jobId, workerLeaseId, patch = {}) {
      validateTransitionInput(workspace, jobId, ['queued'], 'failed', patch);
      if (!isDigest(workerLeaseId) || Object.hasOwn(patch, 'finishedAt')) throw invalidRescueBinding();
      return transitionStoredJob(dataRoot, workspace, jobId, ['queued'], 'failed', patch, true,
        { failedExecutionLeaseId: workerLeaseId });
    },

    /** Release and clear one exact terminal private reservation while holding the State proof lock.
     * @param {string} workspace @param {string} jobId @param {{releaseExecutionReservation:(proof:any)=>Promise<void>}} identity */
    async cleanupTerminalExecutionReservation(workspace, jobId, identity) {
      if (!isNonEmptyString(workspace) || !isDigest(jobId)
        || !identity || typeof identity.releaseExecutionReservation !== 'function') throw invalidRescueBinding();
      const storage = await jobStorage(dataRoot, workspace);
      return withFileLock(storage.lockPath, async () => {
        const path = jobPath(storage.jobsDirectory, jobId);
        const job = await readJobRecord(path, jobId, storage.workspacePath);
        const authority = job.rescueExecutionReservation;
        if (authority === undefined) return job;
        if (!TERMINAL_STATUSES.has(job.status) || !validExecutionReservation(authority, job, true)) throw invalidRescueBinding();
        await identity.releaseExecutionReservation({
          capabilityDigest: authority.capabilityDigest, reservationId: authority.reservationId,
          workerLeaseId: authority.workerLeaseId ?? null, jobId: authority.jobId,
          ownerSessionId: authority.ownerSessionId, workspace: authority.workspace,
          operation: authority.operation, jobSpecFormat: authority.jobSpecFormat,
          ...(authority.specDigest === undefined ? {} : { specDigest: authority.specDigest }),
          terminalStatus: job.status,
        });
        const cleaned = { ...job }; delete cleaned.rescueExecutionReservation;
        cleaned.updatedAt = new Date(Math.max(Date.now(), Date.parse(job.updatedAt))).toISOString();
        validateJobRecord(cleaned, jobId, storage.workspacePath, expectedJobLogPath(storage.jobsDirectory, jobId));
        await atomicWriteJson(path, cleaned); return cleaned;
      });
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
        validateJobRecord(updated, jobId, storage.workspacePath, expectedJobLogPath(storage.jobsDirectory, jobId));
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
        validateJobRecord(updated, jobId, storage.workspacePath, expectedJobLogPath(storage.jobsDirectory, jobId));
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

/** @param {string} dataRoot @param {string} workspace @param {string} jobId @param {string[]} expectedStatuses @param {string} nextStatus @param {Record<string,unknown>} patch @param {boolean} assignFinishedAt @param {{migrationRollback?:any,publicationHook?:(seam:string)=>void|Promise<void>,failedExecutionLeaseId?:string,recoveryWorkerLeaseId?:string|null}} [options] */
async function transitionStoredJob(dataRoot, workspace, jobId, expectedStatuses, nextStatus, patch, assignFinishedAt, options = {}) {
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
    if (Object.hasOwn(options, 'recoveryWorkerLeaseId')) {
      const effectiveWorkerLeaseId = job.workerLeaseId ?? job.rescueExecutionReservation?.workerLeaseId ?? null;
      if (effectiveWorkerLeaseId !== options.recoveryWorkerLeaseId) throw workerLeaseConflict(jobId);
    }
    if (options.failedExecutionLeaseId !== undefined) {
      const reservationLease = job.rescueExecutionReservation?.workerLeaseId;
      const foreignClaim = job.workerLeaseId !== undefined && job.workerLeaseId !== options.failedExecutionLeaseId
        || reservationLease !== undefined && reservationLease !== options.failedExecutionLeaseId;
      if (job.status !== 'queued' || foreignClaim) return { kind: foreignClaim ? 'foreign-claim' : 'settled', job };
    }
    const requestedRollback = options.migrationRollback;
    if (requestedRollback !== undefined) {
      if (job.rescueMigrationRollback !== undefined && !sameMigrationRollback(job.rescueMigrationRollback, requestedRollback)) throw invalidRescueBinding();
      if (TERMINAL_STATUSES.has(job.status)) {
        if (job.status !== nextStatus) throw invalidRescueBinding();
        await verifyRestoredMigrationLocked(storage, job, requestedRollback);
        return job;
      }
    }
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
    let executionClaim;
    if (job.status === 'queued' && nextStatus === 'running' && job.rescueExecutionClaim !== undefined) {
      if (!validRescueExecutionClaim(job.rescueExecutionClaim, job)) throw invalidRescueBinding();
      executionClaim = job.rescueExecutionClaim;
      if (!Object.hasOwn(effectivePatch, 'childPid') || !Object.hasOwn(effectivePatch, 'workerLeaseId')
        || effectivePatch.workerLeaseId !== executionClaim.workerLeaseId
        || effectivePatch.workerLeaseId !== job.workerLeaseId
        || effectivePatch.childPid !== job.childPid) throw invalidRescueBinding();
    }
    if (job.status === 'queued' && nextStatus === 'running' && job.command === 'rescue' && job.readOnly === false
      && job.rescueReservationKind !== undefined && executionClaim === undefined) throw invalidRescueBinding();
    const queuedClassification = job.status === 'queued' && (nextStatus === 'running' || TERMINAL_STATUSES.has(nextStatus))
      && executionClaim === undefined ? await classifyQueuedRescueTransitionLocked(storage, job, requestedRollback) : undefined;
    if (nextStatus === 'running' && (queuedClassification?.kind === 'ordinary-unadvanced'
      || queuedClassification?.kind === 'ordinary-revoked-current'
      || queuedClassification?.kind === 'migration' && queuedClassification.bindingState !== 'active')) throw invalidRescueBinding();
    const migrationRollback = queuedClassification?.kind === 'migration'
      ? queuedClassification.rollback : job.rescueMigrationRollback ?? requestedRollback;
    if (migrationRollback && nextStatus !== 'queued') delete updated.rescueMigrationRollback;
    if (nextStatus !== 'queued') delete updated.rescueContinuationOrigin;
    if (nextStatus !== 'queued') delete updated.rescueExecutionClaim;
    if (nextStatus !== 'queued') delete updated.rescueJobSpecCommitment;
    if (nextStatus !== 'queued') delete updated.rescueLegacyJobSpecProof;
    if (effectivePatch.lastCancelError === null) delete updated.lastCancelError;
    validateJobRecord(updated, jobId, storage.workspacePath, expectedJobLogPath(storage.jobsDirectory, jobId));
    if (job.status === 'queued' && migrationRollback && TERMINAL_STATUSES.has(nextStatus)
      && queuedClassification?.bindingState !== 'revoked') {
      await restoreQueuedMigrationLocked(storage, job, migrationRollback);
      await publicationCheckpoint(options.publicationHook ?? (async () => {}), 'rollback:terminal');
    } else if (nextStatus === 'cancelled' && job.command === 'rescue') {
      await closeCurrentRescueBindingForCancellationLocked(storage, job);
    }
    await atomicWriteJson(path, updated);
    return options.failedExecutionLeaseId === undefined ? updated : { kind: 'settled', job: updated };
  });
}

/** Close the exact current operation before publishing its cancelled job. A crash between
 * these writes is fail-closed: the operation is revoked while the job remains retryably
 * cancelling. @param {any} storage @param {any} job */
async function closeCurrentRescueBindingForCancellationLocked(storage, job) {
  const snapshot = await readBindingPartitionSnapshot(storage, job.ownerSessionId, true);
  const matches = [...snapshot.records.values()].filter((record) => record.currentJobId === job.id);
  if (matches.length === 0) return;
  if (matches.length !== 1) throw invalidRescueBinding();
  const record = matches[0];
  if (record.state === 'closed') {
    return;
  }
  const lockIdentity = await captureStateLockIdentity(storage);
  const binding = closeRescueBinding(record, { operationId: record.operationId, reason: 'cancel' });
  await writeBindingPartitionGuarded(storage, record.parentSessionId, snapshot, bindingSnapshotWith(snapshot, binding), lockIdentity);
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

/** @param {any} storage @param {any[]} jobs @param {JobReservation} reservation */
async function reserveJobLocked(storage, jobs, reservation) {
  const job = makeReservedJob(storage, jobs, reservation);
  await writeOwnerBinding(storage, job);
  await atomicWriteJson(jobPath(storage.jobsDirectory, job.id), job);
  await publishOwnerIndexMarker(storage);
  return job;
}

/** @param {any} storage @param {any[]} jobs @param {JobReservation} reservation @param {'bound'|'unbound'} [rescueReservationKind] */
function makeReservedJob(storage, jobs, reservation, rescueReservationKind = 'unbound') {
  validateReservation(reservation);
  if (!reservation.readOnly && jobs.some(isActiveWritableJob)) {
    throw new PluginError('WRITABLE_JOB_EXISTS', 'This workspace already has an active writable rescue job.', {
      category: 'state', remedy: 'Retry later or inspect the redacted workspace list with $zcode:status --all.', details: { workspaceKey: storage.workspaceKey },
    });
  }
  const timestamp = new Date().toISOString();
  return {
    id: randomBytes(32).toString('hex'), workspace: storage.workspacePath,
    ownerSessionId: reservation.ownerSessionId, ownerTurnId: reservation.ownerTurnId,
    command: reservation.command, readOnly: reservation.readOnly,
    permissionSnapshot: reservation.permissionSnapshot,
    ...(reservation.command === 'rescue' && reservation.readOnly === false ? { rescueReservationKind } : {}),
    ...(reservation.codexThreadId === undefined ? {} : { codexThreadId: reservation.codexThreadId }),
    status: 'queued', createdAt: timestamp, updatedAt: timestamp,
  };
}

/** @param {any} storage @param {any} job @param {any} binding @param {any} options */
async function publishRescueReservation(storage, job, binding, options) {
  if (options.bindingFirst) {
    await publicationCheckpoint(options.publicationHook, `${options.route}:binding`);
    await writeBindingPartitionGuarded(storage, binding.parentSessionId, options.beforeSnapshot, options.afterSnapshot, options.lockIdentity);
  }
  await publishJobRecord(storage, job, { ...options, expectedSnapshot: options.bindingFirst ? options.afterSnapshot : options.beforeSnapshot, parentSessionId: binding.parentSessionId });
  if (!options.bindingFirst) {
    await publicationCheckpoint(options.publicationHook, `${options.route}:current-advance`);
    await writeBindingPartitionGuarded(storage, binding.parentSessionId, options.beforeSnapshot, options.afterSnapshot, options.lockIdentity);
  }
}

/** @param {any} storage @param {any} job @param {any} options */
async function publishJobRecord(storage, job, options) {
  await publicationCheckpoint(options.publicationHook, `${options.route}:owner-binding`);
  await assertPublicationGuard(storage, options.lockIdentity, options.expectedSnapshot, options.parentSessionId);
  await writeOwnerBinding(storage, job);
  await publicationCheckpoint(options.publicationHook, `${options.route}:job`);
  await assertPublicationGuard(storage, options.lockIdentity, options.expectedSnapshot, options.parentSessionId);
  await atomicWriteJson(jobPath(storage.jobsDirectory, job.id), job);
  await publicationCheckpoint(options.publicationHook, `${options.route}:marker`);
  await assertPublicationGuard(storage, options.lockIdentity, options.expectedSnapshot, options.parentSessionId);
  await publishOwnerIndexMarker(storage);
  await assertPublicationGuard(storage, options.lockIdentity, options.expectedSnapshot, options.parentSessionId);
}

/** @param {(seam:string)=>void|Promise<void>} hook @param {string} seam */
async function publicationCheckpoint(hook, seam) {
  try { await hook(seam); }
  catch { throw new PluginError('RESCUE_PUBLICATION_TEST_FAULT', 'The test-only Rescue publication fault was injected.', { category: 'state', remedy: 'Retry without the test-only publication hook.' }); }
}

/** @param {any} storage @param {string} parentSessionId @param {any} before @param {any} after @param {any} lockIdentity */
async function writeBindingPartitionGuarded(storage, parentSessionId, before, after, lockIdentity) {
  await assertPublicationGuard(storage, lockIdentity, before, parentSessionId);
  await atomicWriteJson(bindingPartitionPath(storage, parentSessionId), partitionEnvelope(storage, parentSessionId, after.records), { privateRoot: storage.directory });
  await assertPublicationGuard(storage, lockIdentity, after, parentSessionId);
}

/** @param {any} storage @param {any} lockIdentity @param {any} expectedSnapshot @param {string} parentSessionId */
async function assertPublicationGuard(storage, lockIdentity, expectedSnapshot, parentSessionId) {
  await assertStateLockIdentity(storage, lockIdentity);
  const current = await readBindingPartitionSnapshot(storage, parentSessionId, true, !expectedSnapshot.exists);
  if (!sameBindingSnapshot(expectedSnapshot, current)) throw invalidRescueBinding();
}

/** @param {any} storage */
async function captureStateLockIdentity(storage) {
  try {
    return { directory: await lstat(storage.lockPath, { bigint: true }), file: await lstat(join(storage.lockPath, 'advisory.lock'), { bigint: true }) };
  } catch { throw invalidRescueBinding(); }
}

/** @param {any} storage @param {any} expected */
async function assertStateLockIdentity(storage, expected) {
  let current;
  try { current = await captureStateLockIdentity(storage); } catch { throw invalidRescueBinding(); }
  if (!sameDirectoryIdentity(expected.directory, current.directory) || !sameFileIdentity(expected.file, current.file)) throw invalidRescueBinding();
}

/** @param {import('node:fs').BigIntStats} left @param {import('node:fs').BigIntStats} right */
function sameFileIdentity(left, right) { return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino; }

/** @param {any} storage @param {any} expected @param {RescueMigrationProof|undefined} migrationProof @returns {Promise<RescueBindingResumeResult>} */
async function resolveBindingForResumeLocked(storage, expected, migrationProof) {
  const snapshot = await readBindingPartitionSnapshot(storage, expected.parentSessionId, true);
  const binding = snapshot.records.get(rescueBindingKey(expected)) ?? null;
  if (binding !== null) {
    const authority = rescueBindingAuthorityView(binding);
    if (expected.permissionMode !== undefined && binding.permissionMode !== expected.permissionMode
      || expected.executorAgentType !== undefined && authority.childAgentType !== expected.executorAgentType
      || expected.executorParentTurnId !== undefined && (authority.kind !== 'subagent-start' || authority.parentTurnId !== expected.executorParentTurnId)
      || expected.executorParentPermissionMode !== undefined && (authority.kind !== 'subagent-start' || authority.parentPermissionMode !== expected.executorParentPermissionMode)
      || binding.version === 3 && authority.kind === 'subagent-start'
        && expected.executorAgentPath !== undefined && authority.agentPath !== expected.executorAgentPath) throw invalidRescueBinding();
  }
  if (binding === null) return { kind: 'missing' };
  if (migrationProof !== undefined && binding.state === 'active') throw staleRescueBinding();
  if (migrationProof !== undefined && ![1, 2].includes(binding.version)) throw invalidRescueBinding();
  if (migrationProof !== undefined) validateMigrationProofForBinding(binding, expected, migrationProof);
  if (binding.state !== 'active') {
    if (binding.closeReason !== 'session-ended') throw closedRescueBinding();
    validateMigrationProofForBinding(binding, expected, migrationProof);
    return resolveMigrationBindingJobsLocked(storage, binding);
  }
  return await resolveBindingJobsLocked(storage, binding);
}

/** @param {any} binding @param {{agentPath?:string}|undefined} proof @param {string} currentJobId @param {string} updatedAt */
function migratedActiveBinding(binding, proof, currentJobId, updatedAt) {
  if (![1, 2].includes(binding.version) || binding.state !== 'closed' || binding.closeReason !== 'session-ended') throw invalidRescueBinding();
  const authority = rescueBindingAuthorityView(binding);
  const childAuthority = authority.kind === 'subagent-start'
    ? { ...authority, agentPath: proof?.agentPath }
    : authority;
  return validateRescueBinding({ version: 3, key: binding.key, operationId: binding.operationId, state: 'active',
    parentSessionId: binding.parentSessionId, childAuthority, workspace: binding.workspace,
    permissionMode: binding.permissionMode, anchorJobId: binding.anchorJobId, currentJobId,
    superseded: [], createdAt: binding.createdAt, updatedAt, closedAt: null, closeReason: null });
}

/** @param {any} record @param {any} input */
function restoreMigratedTombstone(record, input) {
  const common = { key: record.key, operationId: record.operationId, state: 'closed', parentSessionId: record.parentSessionId,
    workspace: record.workspace, permissionMode: record.permissionMode, anchorJobId: record.anchorJobId,
    currentJobId: input.priorCurrentJobId, createdAt: record.createdAt, updatedAt: input.priorUpdatedAt,
    closedAt: input.priorClosedAt, closeReason: 'session-ended' };
  if (input.priorVersion === 3) return validateRescueBinding({ ...record, ...common });
  const authority = rescueBindingAuthorityView(record);
  if (input.priorVersion === 1) return validateRescueBinding({ version: 1, ...common,
    executorAgentId: authority.childAgentId, executorAgentType: authority.childAgentType,
    executorParentTurnId: authority.parentTurnId, executorParentPermissionMode: authority.parentPermissionMode });
  const childAuthority = authority.kind === 'subagent-start'
    ? { kind: authority.kind, childAgentId: authority.childAgentId, childAgentType: authority.childAgentType,
      parentTurnId: authority.parentTurnId, parentPermissionMode: authority.parentPermissionMode }
    : authority;
  return validateRescueBinding({ version: 2, ...common, childAuthority });
}

/** @param {any} storage @param {any} job @param {any} rollback */
async function restoreQueuedMigrationLocked(storage, job, rollback) {
  const migration = await inspectQueuedMigrationLocked(storage, job, rollback);
  if (migration.state === 'active') {
    if (job.rescueMigrationRollback === undefined || job.rescueMigrationRollback.priorBinding === undefined) {
      const marked = { ...job, rescueMigrationRollback: migration.rollback };
      validateJobRecord(marked, job.id, storage.workspacePath, expectedJobLogPath(storage.jobsDirectory, job.id));
      await atomicWriteJson(jobPath(storage.jobsDirectory, job.id), marked);
    }
    const lockIdentity = await captureStateLockIdentity(storage);
    await writeBindingPartitionGuarded(storage, migration.rollback.parentSessionId, migration.snapshot,
      bindingSnapshotWith(migration.snapshot, migration.restored), lockIdentity);
  }
  return migration.restored;
}

/** Classify one queued Rescue transition from exact persisted proof while the StateStore lock is held. @param {any} storage @param {any} job @param {any} legacyRollback */
async function classifyQueuedRescueTransitionLocked(storage, job, legacyRollback, legacySpecDigest = undefined, publishLegacyProof = true) {
  if (job.status !== 'queued') throw invalidRescueBinding();
  const writableRescue = job.command === 'rescue' && job.readOnly === false;
  const reservationEvidence = writableRescue ? await readRescueReservationEvidence(storage, job) : undefined;
  /** @param {any} value @param {any} [binding] */
  const classified = (value, binding = value.binding) => {
    if (reservationEvidence?.kind === 'legacy' && binding?.version >= 3
      && !(value.kind === 'migration' && value.rollback?.priorVersion <= 2)) throw invalidRescueBinding();
    return value;
  };
  const requireBoundReservation = () => {
    if (reservationEvidence?.kind === 'unbound') throw invalidRescueBinding();
  };
  if (job.rescueMigrationRollback !== undefined) {
    if (legacySpecDigest !== undefined && job.rescueLegacyJobSpecProof?.specDigest !== legacySpecDigest) throw invalidRescueBinding();
    requireBoundReservation();
    if (!validPersistedMigrationRollback(job.rescueMigrationRollback, job)
      || legacyRollback !== undefined && !sameMigrationRollback(job.rescueMigrationRollback, legacyRollback)) throw invalidRescueBinding();
    const migration = await inspectQueuedMigrationLocked(storage, job, job.rescueMigrationRollback);
    return classified({ kind: 'migration', rollback: migration.rollback, bindingState: migration.state, binding: migration.binding });
  }
  if (job.rescueContinuationOrigin !== undefined) {
    requireBoundReservation();
    if (legacyRollback !== undefined || !validRescueContinuationOrigin(job.rescueContinuationOrigin, job)) throw invalidRescueBinding();
    const originBinding = job.rescueContinuationOrigin.binding ?? job.rescueContinuationOrigin.priorBinding;
    if (originBinding.permissionMode !== job.permissionSnapshot.permissionMode) throw invalidRescueBinding();
    const snapshot = await readBindingPartitionSnapshot(storage, job.ownerSessionId, false);
    const matches = [...snapshot.records.values()].filter((record) => record.currentJobId === job.id);
    if (matches.length > 1) throw invalidRescueBinding();
    const current = matches[0]; const origin = job.rescueContinuationOrigin;
    if (current === undefined) {
      const priorBinding = origin.priorBinding ?? legacyAdoptionBaseBinding(origin, job);
      if (priorBinding === null) throw invalidRescueBinding();
      const prior = snapshot.records.get(priorBinding.key);
      if (prior === undefined || !sameExactBinding(prior, priorBinding)) throw invalidRescueBinding();
      const anchorJob = await readExactBindingJob(storage, priorBinding.anchorJobId);
      validateAnchorJob(anchorJob, priorBinding.parentSessionId, storage.workspacePath);
      validateCurrentJob(job, priorBinding.parentSessionId, storage.workspacePath);
      return classified({ kind: 'ordinary-unadvanced' }, priorBinding);
    }
    const expected = origin.kind === 'legacy-adoption' ? origin.binding
      : validateRescueBinding({ ...origin.priorBinding, currentJobId: job.id, updatedAt: current.updatedAt });
    if (current.state === 'active' && sameExactBinding(current, expected)) return classified({ kind: 'ordinary-current', binding: current });
    if (sameClosedBindingLifecycle(current, expected)) return classified({ kind: 'ordinary-revoked-current', binding: current });
    throw invalidRescueBinding();
  }
  if (legacyRollback !== undefined) {
    if (reservationEvidence?.kind !== 'legacy') throw invalidRescueBinding();
    if (!validPersistedMigrationRollback(legacyRollback, job)) throw invalidRescueBinding();
    const migration = await inspectQueuedMigrationLocked(storage, job, legacyRollback);
    if (migration.state !== 'active') throw invalidRescueBinding();
    const classification = classified({ kind: 'migration', rollback: migration.rollback,
      bindingState: migration.state, binding: migration.binding });
    if (publishLegacyProof) {
      const marked = { ...job, rescueMigrationRollback: migration.rollback,
        ...(legacySpecDigest === undefined ? {} : { rescueLegacyJobSpecProof: {
          version: 1, kind: 'markerless-migration', specDigest: legacySpecDigest,
        } }) };
      validateJobRecord(marked, job.id, storage.workspacePath, expectedJobLogPath(storage.jobsDirectory, job.id));
      await atomicWriteJson(jobPath(storage.jobsDirectory, job.id), marked);
    }
    return classification;
  }
  if (!writableRescue) return classified({ kind: 'ordinary-unbound' });
  const snapshot = await readBindingPartitionSnapshot(storage, job.ownerSessionId, true);
  const matches = [...snapshot.records.values()].filter((record) => record.currentJobId === job.id);
  if (matches.length === 0) {
    if (!['legacy', 'unbound'].includes(reservationEvidence?.kind)) throw invalidRescueBinding();
    return classified({ kind: 'ordinary-unbound' });
  }
  if (matches.length !== 1) throw invalidRescueBinding();
  const binding = matches[0];
  if (binding.parentSessionId !== job.ownerSessionId || binding.permissionMode !== job.permissionSnapshot.permissionMode
    || reservationEvidence?.kind === 'unbound') throw invalidRescueBinding();
  if (binding.state === 'closed' && binding.anchorJobId === job.id) return classified({ kind: 'ordinary-revoked-current', binding });
  if (binding.state !== 'active') throw invalidRescueBinding();
  if (binding.anchorJobId === job.id) return classified({ kind: 'ordinary-current', binding });
  if (binding.version < 3) {
    const anchorJob = await readExactBindingJob(storage, binding.anchorJobId);
    validateAnchorJob(anchorJob, binding.parentSessionId, storage.workspacePath);
    validateCurrentJob(job, binding.parentSessionId, storage.workspacePath);
    return classified({ kind: 'ordinary-current', binding });
  }
  throw invalidRescueBinding();
}

/** Reconstruct only the exact base emitted by the historical adoption publisher. @param {any} origin @param {any} job */
function legacyAdoptionBaseBinding(origin, job) {
  if (origin.kind !== 'legacy-adoption' || origin.priorBinding !== undefined) return null;
  try {
    const successor = validateRescueBinding(origin.binding);
    if (successor.state !== 'active' || successor.currentJobId !== job.id
      || successor.anchorJobId === job.id || Date.parse(successor.createdAt) < Date.parse(job.createdAt)
      || Date.parse(successor.updatedAt) < Date.parse(successor.createdAt)
      || successor.version === 3 && successor.superseded.length !== 0) return null;
    return validateRescueBinding({ ...successor,
      currentJobId: successor.anchorJobId, updatedAt: successor.createdAt });
  } catch { return null; }
}

/** Validate the exact active migrated successor or exact already-restored tombstone without changing either. @param {any} storage @param {any} job @param {any} rollback */
async function inspectQueuedMigrationLocked(storage, job, rollback) {
  if (!validPersistedMigrationRollback(rollback, job)) throw invalidRescueBinding();
  const snapshot = await readBindingPartitionSnapshot(storage, rollback.parentSessionId, false);
  const key = rescueBindingKey({ parentSessionId: rollback.parentSessionId, executorAgentId: rollback.childAgentId, workspace: storage.workspacePath });
  const record = snapshot.records.get(key) ?? null;
  if (record === null || record.operationId !== rollback.operationId) throw staleRescueBinding();
  if (record.state === 'active' && record.currentJobId === job.id) {
    const activeMatches = [...snapshot.records.values()].filter((candidate) => candidate.state === 'active' && candidate.currentJobId === job.id);
    if (activeMatches.length !== 1 || activeMatches[0].key !== record.key || record.version !== 3
      || Date.parse(record.updatedAt) < Date.parse(rollback.priorUpdatedAt)) throw invalidRescueBinding();
    const anchorJob = await readExactBindingJob(storage, record.anchorJobId); validateAnchorJob(anchorJob, record.parentSessionId, storage.workspacePath);
    const priorJob = await readExactBindingJob(storage, rollback.priorCurrentJobId); validateCurrentJob(priorJob, record.parentSessionId, storage.workspacePath);
    if (priorJob.id === job.id || Date.parse(priorJob.updatedAt) > Date.parse(rollback.priorUpdatedAt)) throw invalidRescueBinding();
    const restored = rollback.priorBinding === undefined ? restoreMigratedTombstone(record, rollback) : structuredClone(rollback.priorBinding);
    const authority = rescueBindingAuthorityView(record);
    const expectedActive = migratedActiveBinding(restored,
      authority.kind === 'subagent-start' ? { agentPath: authority.agentPath } : undefined,
      job.id, record.updatedAt);
    if (!sameExactBinding(record, expectedActive)) throw invalidRescueBinding();
    return { state: 'active', snapshot, binding: record, restored, rollback: { ...rollback, priorBinding: structuredClone(restored) } };
  }
  if (record.state === 'closed' && record.closeReason === 'session-ended'
    && record.version === rollback.priorVersion && record.currentJobId === rollback.priorCurrentJobId
    && record.updatedAt === rollback.priorUpdatedAt && record.closedAt === rollback.priorClosedAt
    && rollback.priorBinding !== undefined && sameExactBinding(record, rollback.priorBinding)) {
    return { state: 'restored', snapshot, binding: record, restored: structuredClone(record), rollback: structuredClone(rollback) };
  }
  const restored = rollback.priorBinding === undefined ? null : structuredClone(rollback.priorBinding);
  if (restored !== null && record.state === 'closed' && record.currentJobId === job.id) {
    const authority = rescueBindingAuthorityView(record);
    const expectedActive = migratedActiveBinding(restored,
      authority.kind === 'subagent-start' ? { agentPath: authority.agentPath } : undefined,
      job.id, record.updatedAt);
    if (sameClosedBindingLifecycle(record, expectedActive)) {
      return { state: 'revoked', snapshot, binding: record, restored, rollback: structuredClone(rollback) };
    }
  }
  throw staleRescueBinding();
}

/** Prove that only the lifecycle fields of one exact active binding changed. @param {any} record @param {any} active */
function sameClosedBindingLifecycle(record, active) {
  if (record?.state !== 'closed' || !['cancel', 'invalidated', 'session-ended'].includes(record.closeReason)
    || record.closedAt !== record.updatedAt || Date.parse(record.updatedAt) < Date.parse(active.updatedAt)) return false;
  try {
    const expected = validateRescueBinding({ ...active, state: 'closed', updatedAt: record.updatedAt,
      closedAt: record.closedAt, closeReason: record.closeReason });
    return sameExactBinding(record, expected);
  } catch { return false; }
}

/**
 * Version 2 is a durable private proof that this lock holder classified an exact owner-v1
 * classless reservation. A bound v3 claim is allowed only for an exact markerless migration
 * whose restored predecessor was v1/v2; ordinary classless v3 records remain invalid.
 * @param {any} classification @param {string} workerLeaseId @param {boolean} legacyReservation
 */
function executionClaimForClassification(classification, workerLeaseId, legacyReservation) {
  const version = legacyReservation ? 2 : 1;
  const historicalMigration = legacyReservation && classification.kind === 'migration' && classification.rollback?.priorVersion <= 2;
  const proof = legacyReservation ? { reservationProof: historicalMigration
    ? 'owner-v1-markerless-migration' : 'owner-v1-classless' } : {};
  if (classification.kind === 'ordinary-unbound') return { version, kind: 'unbound', workerLeaseId, ...proof };
  if (!classification.binding || classification.binding.state !== 'active') throw invalidRescueBinding();
  if (legacyReservation && classification.binding.version >= 3 && !historicalMigration) throw invalidRescueBinding();
  return { version, kind: 'bound', workerLeaseId, binding: structuredClone(classification.binding), ...proof };
}

/** @param {any} value @param {any} job */
function validRescueExecutionClaim(value, job) {
  if (!isPlainJsonObject(value) || ![1, 2].includes(value.version) || value.workerLeaseId !== job.workerLeaseId
    || job.status !== 'queued' || job.command !== 'rescue' || job.readOnly !== false) return false;
  const legacyReservation = value.version === 2;
  if (legacyReservation !== (job.rescueReservationKind === undefined)) return false;
  const unboundKeys = legacyReservation ? 'kind,reservationProof,version,workerLeaseId' : 'kind,version,workerLeaseId';
  const boundKeys = legacyReservation ? 'binding,kind,reservationProof,version,workerLeaseId' : 'binding,kind,version,workerLeaseId';
  if (legacyReservation && !['owner-v1-classless', 'owner-v1-markerless-migration'].includes(value.reservationProof)) return false;
  if (value.kind === 'unbound') return Object.keys(value).sort().join(',') === unboundKeys
    && (legacyReservation || job.rescueReservationKind === 'unbound')
    && job.rescueContinuationOrigin === undefined && job.rescueMigrationRollback === undefined;
  if (value.kind !== 'bound' || Object.keys(value).sort().join(',') !== boundKeys) return false;
  try {
    const binding = validateRescueBinding(value.binding);
    if (binding.state !== 'active' || binding.currentJobId !== job.id || binding.parentSessionId !== job.ownerSessionId
      || binding.workspace !== job.workspace || binding.permissionMode !== job.permissionSnapshot.permissionMode) return false;
    const historicalMigration = legacyReservation && value.reservationProof === 'owner-v1-markerless-migration'
      && job.rescueLegacyJobSpecProof?.kind === 'markerless-migration'
      && job.rescueMigrationRollback?.priorVersion <= 2;
    if (legacyReservation && binding.version >= 3 && !historicalMigration) return false;
    if (job.rescueContinuationOrigin !== undefined) {
      const origin = job.rescueContinuationOrigin;
      const expected = origin.kind === 'legacy-adoption' ? origin.binding
        : validateRescueBinding({ ...origin.priorBinding, currentJobId: job.id, updatedAt: binding.updatedAt });
      return sameExactBinding(binding, expected);
    }
    if (job.rescueMigrationRollback !== undefined) {
      const restored = job.rescueMigrationRollback.priorBinding;
      if (restored === undefined) return false;
      const authority = rescueBindingAuthorityView(binding);
      const expected = migratedActiveBinding(restored,
        authority.kind === 'subagent-start' ? { agentPath: authority.agentPath } : undefined,
        job.id, binding.updatedAt);
      return sameExactBinding(binding, expected);
    }
    return legacyReservation ? binding.version < 3
      : job.rescueReservationKind === 'bound' && (binding.anchorJobId === job.id || binding.version < 3);
  } catch { return false; }
}

/** @param {any} value */
function validExecutionAuthorization(value) {
  if (value === undefined) return true;
  if (!isPlainJsonObject(value)) return false;
  const keys = Object.keys(value).sort().join(',');
  if (keys === 'sealedCommitment') return isDigest(value.sealedCommitment);
  if (keys === 'legacyProof' && ['classless-owner-v1', 'classless-owner-v1-bound'].includes(value.legacyProof)) return true;
  return keys === 'legacyProof,specDigest' && value.legacyProof === 'markerless-migration' && isDigest(value.specDigest);
}

/** Apply the shared final execution rules to read-only inspection and committing claim. @param {any} job @param {any} classification @param {any} authorization */
function validateRunnableExecutionClassification(job, classification, authorization) {
  if (classification?.kind === 'ordinary-unadvanced') throw notRunnableRescueBinding();
  if (classification?.kind === 'ordinary-revoked-current'
    || classification?.kind === 'migration' && classification.bindingState === 'revoked') throw invalidRescueBinding();
  const legacyReservation = classification !== undefined && job.rescueReservationKind === undefined;
  if (['classless-owner-v1', 'classless-owner-v1-bound'].includes(authorization?.legacyProof)
    && (!legacyReservation || classification?.kind === 'migration')) throw invalidRescueBinding();
  if (authorization?.legacyProof === 'classless-owner-v1-bound'
    && classification?.binding === undefined) throw invalidRescueBinding();
  if (authorization?.legacyProof === 'markerless-migration' && classification?.kind !== 'migration') throw invalidRescueBinding();
  if (legacyReservation && classification?.binding?.version >= 3
    && !(authorization?.legacyProof === 'markerless-migration' && classification.kind === 'migration'
      && classification.rollback?.priorVersion <= 2)) throw invalidRescueBinding();
}

/** Bind a read-only inspection to the complete queued job and exact classified binding/rollback state. @param {any} job @param {any} classification @param {any} legacyRollback @param {any} authorization */
function executionInspectionDigest(job, classification, legacyRollback, authorization) {
  const evidence = classification === undefined ? null : {
    kind: classification.kind,
    bindingState: classification.bindingState ?? null,
    bindingDigest: classification.binding === undefined ? null : bindingRecordDigest(classification.binding),
    rollback: classification.rollback ?? null,
  };
  return createHash('sha256').update(JSON.stringify({ job, evidence, legacyRollback: legacyRollback ?? null,
    authorization: authorization ?? null })).digest('hex');
}

/** Reject any attempt that omits or contradicts the private queued job-spec publication proof. @param {any} job @param {any} authorization @param {any} legacyRollback */
function validateJobSpecExecutionAuthorization(job, authorization, legacyRollback) {
  if (job.rescueJobSpecCommitment !== undefined) {
    if (authorization?.sealedCommitment !== job.rescueJobSpecCommitment) throw invalidRescueBinding();
  } else if (authorization?.sealedCommitment !== undefined) throw invalidRescueBinding();
  if (job.rescueLegacyJobSpecProof !== undefined) {
    if (authorization?.legacyProof !== 'markerless-migration'
      || authorization.specDigest !== job.rescueLegacyJobSpecProof.specDigest) throw invalidRescueBinding();
  }
  if (['classless-owner-v1', 'classless-owner-v1-bound'].includes(authorization?.legacyProof)
    && (job.rescueMigrationRollback !== undefined || job.rescueLegacyJobSpecProof !== undefined)) throw invalidRescueBinding();
  if (authorization?.legacyProof === 'markerless-migration') {
    if (legacyRollback === undefined || job.rescueMigrationRollback !== undefined && job.rescueLegacyJobSpecProof === undefined) throw invalidRescueBinding();
  } else if (job.rescueLegacyJobSpecProof !== undefined) throw invalidRescueBinding();
  if (authorization === undefined && (job.rescueJobSpecCommitment !== undefined || job.rescueLegacyJobSpecProof !== undefined)) throw invalidRescueBinding();
}

/** @param {any} value @param {any} job */
function validLegacyJobSpecProof(value, job) {
  return isPlainJsonObject(value)
    && Object.keys(value).sort().join(',') === 'kind,specDigest,version'
    && value.version === 1 && value.kind === 'markerless-migration' && isDigest(value.specDigest)
    && job.status === 'queued' && job.command === 'rescue' && job.readOnly === false
    && job.rescueMigrationRollback !== undefined;
}

/** @param {any} value @param {any} job @param {boolean} allowTerminal */
function validExecutionReservation(value, job, allowTerminal) {
  if (!isPlainJsonObject(value)) return false;
  const keys = Object.keys(value).sort().join(',');
  const sealed = ['capabilityDigest,jobId,jobSpecFormat,operation,ownerSessionId,reservationId,version,workspace',
    'capabilityDigest,jobId,jobSpecFormat,operation,ownerSessionId,reservationId,version,workerLeaseId,workspace'].includes(keys)
    && value.jobSpecFormat === 'sealed-v2' && value.specDigest === undefined;
  const legacy = ['capabilityDigest,jobId,jobSpecFormat,operation,ownerSessionId,reservationId,specDigest,version,workspace',
    'capabilityDigest,jobId,jobSpecFormat,operation,ownerSessionId,reservationId,specDigest,version,workerLeaseId,workspace'].includes(keys)
    && value.jobSpecFormat === 'legacy-v1' && isDigest(value.specDigest)
    && job.rescueReservationKind === undefined && job.rescueJobSpecCommitment === undefined;
  if (!sealed && !legacy) return false;
  return value.version === 1 && isDigest(value.capabilityDigest) && isDigest(value.reservationId)
    && value.jobId === job.id && value.ownerSessionId === job.ownerSessionId && value.workspace === job.workspace
    && value.operation === 'run-reserved-job'
    && (value.workerLeaseId === undefined || isDigest(value.workerLeaseId))
    && (allowTerminal || job.status === 'queued')
    && (job.workerLeaseId === undefined || value.workerLeaseId === job.workerLeaseId)
    && (job.status !== 'running' || value.workerLeaseId !== undefined);
}

/** @param {any} left @param {any} right */
function sameExecutionReservationBase(left, right) {
  return left.version === right.version && left.capabilityDigest === right.capabilityDigest
    && left.reservationId === right.reservationId && left.jobId === right.jobId
    && left.ownerSessionId === right.ownerSessionId && left.workspace === right.workspace
    && left.operation === right.operation && left.jobSpecFormat === right.jobSpecFormat
    && left.specDigest === right.specDigest;
}

/** Verify an idempotent terminal retry against the exact already-restored tombstone. @param {any} storage @param {any} job @param {any} rollback */
async function verifyRestoredMigrationLocked(storage, job, rollback) {
  if (!validMigrationRollbackIdentity(rollback, job)) throw invalidRescueBinding();
  const snapshot = await readBindingPartitionSnapshot(storage, rollback.parentSessionId, false);
  const key = rescueBindingKey({ parentSessionId: rollback.parentSessionId, executorAgentId: rollback.childAgentId, workspace: storage.workspacePath });
  const record = snapshot.records.get(key) ?? null;
  if (record === null || record.operationId !== rollback.operationId || record.state !== 'closed' || record.closeReason !== 'session-ended'
    || record.version !== rollback.priorVersion || record.currentJobId !== rollback.priorCurrentJobId
    || record.updatedAt !== rollback.priorUpdatedAt || record.closedAt !== rollback.priorClosedAt
    || rollback.priorBinding === undefined || !sameExactBinding(record, rollback.priorBinding)) throw invalidRescueBinding();
}

/** @param {any} left @param {any} right */
function sameExactBinding(left, right) {
  try { return bindingRecordDigest(left) === bindingRecordDigest(right); } catch { return false; }
}

/** @param {any} input */
function migrationRollbackFromInput(input) {
  return { parentSessionId: input.parentSessionId, childAgentId: input.childAgentId, operationId: input.operationId,
    priorCurrentJobId: input.priorCurrentJobId, priorUpdatedAt: input.priorUpdatedAt,
    priorClosedAt: input.priorClosedAt, priorVersion: input.priorVersion,
    ...(input.priorBinding === undefined ? {} : { priorBinding: input.priorBinding }) };
}

/** @param {any} left @param {any} right */
function sameMigrationRollback(left, right) {
  const keys = ['childAgentId', 'operationId', 'parentSessionId', 'priorClosedAt', 'priorCurrentJobId', 'priorUpdatedAt', 'priorVersion'];
  return isPlainJsonObject(left) && isPlainJsonObject(right)
    && keys.every((key) => left[key] === right[key])
    && (left.priorBinding === undefined || right.priorBinding === undefined || sameExactBinding(left.priorBinding, right.priorBinding));
}

/** @param {any} value @param {any} job */
function validPersistedMigrationRollback(value, job) {
  return validMigrationRollbackIdentity(value, job) && job.status === 'queued';
}

/** @param {unknown} value @param {any} job */
function validMigrationRollbackIdentity(value, job) {
  const keys = ['childAgentId', 'operationId', 'parentSessionId', 'priorClosedAt', 'priorCurrentJobId', 'priorUpdatedAt', 'priorVersion'];
  const validKeys = isPlainJsonObject(value) && [keys, [...keys, 'priorBinding']]
    .some((candidate) => Object.keys(value).sort().join('\0') === candidate.sort().join('\0'));
  if (!validKeys) return false;
  const priorBinding = value.priorBinding === undefined ? undefined : validRollbackPriorBinding(value.priorBinding, value, job);
  return (value.priorBinding === undefined || priorBinding)
    && job.command === 'rescue' && job.readOnly === false
    && value.parentSessionId === job.ownerSessionId && isNonEmptyString(value.childAgentId)
    && isDigest(value.operationId) && isDigest(value.priorCurrentJobId) && [1, 2, 3].includes(value.priorVersion)
    && isIsoTimestamp(value.priorUpdatedAt) && isIsoTimestamp(value.priorClosedAt)
    && Date.parse(value.priorUpdatedAt) === Date.parse(value.priorClosedAt)
    && value.priorCurrentJobId !== job.id && Date.parse(job.createdAt) >= Date.parse(value.priorClosedAt);
}

/** @param {any} candidate @param {any} rollback @param {any} job */
function validRollbackPriorBinding(candidate, rollback, job) {
  try {
    const binding = validateRescueBinding(candidate); const authority = rescueBindingAuthorityView(binding);
    return binding.state === 'closed' && binding.closeReason === 'session-ended' && binding.parentSessionId === rollback.parentSessionId
      && binding.workspace === job.workspace && authority.childAgentId === rollback.childAgentId
      && binding.operationId === rollback.operationId && binding.currentJobId === rollback.priorCurrentJobId
      && binding.updatedAt === rollback.priorUpdatedAt && binding.closedAt === rollback.priorClosedAt
      && binding.version === rollback.priorVersion;
  } catch { return false; }
}

/** @param {any} value @param {any} job */
function validRescueContinuationOrigin(value, job) {
  if (!isPlainJsonObject(value) || ![
    ['kind', 'priorBinding'], ['binding', 'kind'], ['binding', 'kind', 'priorBinding'],
  ].some((keys) => Object.keys(value).sort().join('\0') === keys.sort().join('\0'))
    || !['active-continuation', 'legacy-adoption'].includes(value.kind)
    || value.kind === 'active-continuation' && !Object.hasOwn(value, 'priorBinding')
    || value.kind === 'legacy-adoption' && !Object.hasOwn(value, 'binding')) return false;
  try {
    const binding = validateRescueBinding(value.binding ?? value.priorBinding); const authority = rescueBindingAuthorityView(binding);
    const common = job.command === 'rescue' && job.readOnly === false && job.status === 'queued'
      && binding.state === 'active' && binding.parentSessionId === job.ownerSessionId && binding.workspace === job.workspace
      && authority.childAgentId.length > 0;
    if (!common) return false;
    if (value.kind === 'legacy-adoption' && value.priorBinding !== undefined) {
      const prior = validateRescueBinding(value.priorBinding);
      const expected = validateRescueBinding({ ...prior, currentJobId: job.id, updatedAt: binding.updatedAt });
      return prior.state === 'active' && prior.parentSessionId === job.ownerSessionId && prior.workspace === job.workspace
        && prior.currentJobId === prior.anchorJobId && prior.currentJobId !== job.id
        && Date.parse(binding.updatedAt) >= Date.parse(prior.updatedAt)
        && Date.parse(binding.updatedAt) >= Date.parse(job.createdAt) && sameExactBinding(binding, expected);
    }
    return binding.currentJobId !== job.id && value.kind === 'active-continuation'
      && Date.parse(job.createdAt) >= Date.parse(binding.updatedAt)
      || binding.currentJobId === job.id && value.kind === 'legacy-adoption'
      && Date.parse(binding.updatedAt) >= Date.parse(job.createdAt);
  } catch { return false; }
}

/** @param {unknown} value */
function validRescueReservationKind(value) { return value === 'bound' || value === 'unbound'; }

/** @param {any} storage @param {any} binding @returns {Promise<Extract<RescueBindingResumeResult, {kind:'bound'}>>} */
async function resolveBindingJobsLocked(storage, binding) {
  const anchorJob = await readExactBindingJob(storage, binding.anchorJobId);
  const currentJob = binding.currentJobId === binding.anchorJobId ? anchorJob
    : await readExactBindingJob(storage, binding.currentJobId);
  validateAnchorJob(anchorJob, binding.parentSessionId, storage.workspacePath);
  validateCurrentJob(currentJob, binding.parentSessionId, storage.workspacePath);
  return { kind: 'bound', operationId: binding.operationId, anchorJob: structuredClone(anchorJob), currentJob: structuredClone(currentJob), binding: { ...binding } };
}

/** A migration candidate has no writable current attempt and retains one original non-empty session. @param {any} storage @param {any} binding */
async function resolveMigrationBindingJobsLocked(storage, binding) {
  if (![1, 2].includes(binding.version) || binding.state !== 'closed' || binding.closeReason !== 'session-ended') throw invalidRescueBinding();
  const resolved = await resolveBindingJobsLocked(storage, binding);
  const { anchorJob, currentJob } = resolved;
  if (!isSafeIdentifier(anchorJob.zcodeSessionId) || !isSafeIdentifier(currentJob.zcodeSessionId)
    || anchorJob.zcodeSessionId !== currentJob.zcodeSessionId
    || !TERMINAL_STATUSES.has(anchorJob.status) || anchorJob.status === 'cancelled'
    || !TERMINAL_STATUSES.has(currentJob.status) || currentJob.status === 'cancelled') throw invalidRescueBinding();
  return resolved;
}

/** @param {any} binding @param {any} expected @param {RescueMigrationProof|undefined} proof */
function validateMigrationProofForBinding(binding, expected, proof) {
  if (!isPlainJsonObject(proof) || proof.parentSessionId !== expected.parentSessionId
    || proof.childAgentId !== expected.executorAgentId || proof.operationId !== binding.operationId
    || proof.bindingDigest !== bindingRecordDigest(binding)) throw invalidRescueBinding();
  const authority = rescueBindingAuthorityView(binding);
  if (proof.childAgentType !== authority.childAgentType || proof.executionWorkspace !== binding.workspace
    || authority.kind === 'codex-legacy-adoption' && (proof.originWorkspace !== authority.originWorkspace
      || proof.executionWorkspace !== authority.executionWorkspace || proof.agentPathDigest !== authority.agentPathDigest)
    || authority.kind === 'subagent-start' && (proof.agentPath !== (authority.agentPath ?? expected.executorAgentPath)
      || binding.version < 3 && expected.executorAgentPath === undefined)) throw invalidRescueBinding();
}

/** @param {any} binding @param {any} evidence */
function migrationProofForBinding(binding, evidence) {
  const authority = rescueBindingAuthorityView(binding);
  const bindingDigest = bindingRecordDigest(binding);
  return authority.kind === 'codex-legacy-adoption'
    ? { parentSessionId: binding.parentSessionId, childAgentId: authority.childAgentId, childAgentType: authority.childAgentType,
      operationId: binding.operationId, originWorkspace: authority.originWorkspace, executionWorkspace: authority.executionWorkspace,
      agentPathDigest: authority.agentPathDigest, bindingDigest }
    : { parentSessionId: binding.parentSessionId, childAgentId: authority.childAgentId, childAgentType: authority.childAgentType,
      operationId: binding.operationId, originWorkspace: evidence.originWorkspace, executionWorkspace: binding.workspace,
      agentPath: authority.agentPath ?? evidence.agentPath, bindingDigest };
}

/** @param {any} binding */
function bindingRecordDigest(binding) { return createHash('sha256').update(JSON.stringify(validateRescueBinding(binding))).digest('hex'); }

/** @param {any} storage @param {any} expected */
async function readBindingLocked(storage, expected) {
  const snapshot = await readBindingPartitionSnapshot(storage, expected.parentSessionId, true);
  const record = snapshot.records.get(rescueBindingKey(expected)) ?? null;
  const authority = record === null ? null : rescueBindingAuthorityView(record);
  if (record && (expected.permissionMode !== undefined && record.permissionMode !== expected.permissionMode
    || expected.executorAgentType !== undefined && authority.childAgentType !== expected.executorAgentType
    || expected.executorParentTurnId !== undefined && (authority.kind !== 'subagent-start' || authority.parentTurnId !== expected.executorParentTurnId)
    || expected.executorParentPermissionMode !== undefined && (authority.kind !== 'subagent-start' || authority.parentPermissionMode !== expected.executorParentPermissionMode)
    || record.version === 3 && expected.executorAgentPath !== undefined && (authority.kind !== 'subagent-start' || authority.agentPath !== expected.executorAgentPath))) throw invalidRescueBinding();
  return record;
}

/** @param {any} storage @param {string} jobId */
async function readExactBindingJob(storage, jobId) { try { return await readJobRecord(jobPath(storage.jobsDirectory, jobId), jobId, storage.workspacePath); } catch { throw invalidRescueBinding(); } }

/** @param {any} storage @param {string} parentSessionId */
function bindingPartitionPath(storage, parentSessionId) { return join(storage.directory, `rescue-binding-session-${rescueBindingPartitionKey({ parentSessionId, workspace: storage.workspacePath })}.json`); }
/** @param {any} storage @param {string} parentSessionId */
function bindingAuthorityPath(storage, parentSessionId) { return join(storage.directory, `rescue-binding-authority-${rescueBindingPartitionKey({ parentSessionId, workspace: storage.workspacePath })}.json`); }

/** @param {any} storage @param {string} parentSessionId @param {boolean} allowMissing @param {boolean} [allowAuthorityOnly] */
async function readBindingPartitionSnapshot(storage, parentSessionId, allowMissing, allowAuthorityOnly = false) {
  const expected = { parentSessionId, workspace: storage.workspacePath }; const authorityPath = bindingAuthorityPath(storage, parentSessionId); const partitionPath = bindingPartitionPath(storage, parentSessionId);
  const [authorityExists, partitionExists] = await Promise.all([authorityPath, partitionPath].map(async (path) => {
    try { await lstat(path); return true; } catch (error) { if (/** @type {any} */ (error)?.code === 'ENOENT') return false; throw invalidRescueBinding(); }
  }));
  if (!authorityExists && !partitionExists) { if (!allowMissing) throw invalidRescueBinding(); return { authority: null, exists: false, records: new Map() }; }
  if (!authorityExists || !partitionExists && !allowAuthorityOnly) throw invalidRescueBinding();
  let authority; let partition;
  try {
    authority = await readRescueBindingAuthorityFile(storage.directory, authorityPath, expected);
    if (partitionExists) partition = await readRescueBindingPartitionFile(storage.directory, partitionPath, expected);
  } catch { throw invalidRescueBinding(); }
  return { authority, exists: partitionExists, records: new Map((partition?.records ?? []).map((record) => [record.key, record])) };
}

/** @param {any} storage @param {string} parentSessionId @param {Map<string,any>} records */
function partitionEnvelope(storage, parentSessionId, records) { return createRescueBindingPartition({ parentSessionId, workspace: storage.workspacePath, records: [...records.values()] }); }

/** @param {any} storage @param {string} parentSessionId @param {any} snapshot @param {number} maximumBytes */
function ensureProspectiveBindingCapacity(storage, parentSessionId, snapshot, maximumBytes) {
  let envelope;
  try { envelope = partitionEnvelope(storage, parentSessionId, snapshot.records); } catch { throw rescueBindingCapacity(); }
  if (Buffer.byteLength(`${JSON.stringify(envelope, null, 2)}\n`) > maximumBytes) throw rescueBindingCapacity();
}

/** @param {any} snapshot @param {any} binding */
function bindingSnapshotWith(snapshot, binding) { const records = new Map(snapshot.records); records.set(binding.key, binding); return { authority: snapshot.authority, exists: true, records }; }

/** @param {any} left @param {any} right */
function sameBindingSnapshot(left, right) {
  if (left.exists !== right.exists || JSON.stringify(left.authority) !== JSON.stringify(right.authority)) return false;
  return JSON.stringify([...left.records].sort()) === JSON.stringify([...right.records].sort());
}

/** Purely plan the retained partition for one new slot before any marker, GC, or repair write. @param {any} snapshot @param {string} key @param {number} closedGcCutoff */
function planBindingSlot(snapshot, key, closedGcCutoff) {
  if (snapshot.records.has(key)) return snapshot;
  const retained = new Map([...snapshot.records].filter(([, record]) => !gcEligibleBinding(record, closedGcCutoff)));
  if (retained.size >= RESCUE_BINDING_MAX_RECORDS) throw rescueBindingCapacity();
  return { authority: snapshot.authority, exists: snapshot.exists, records: retained };
}

/** @param {any} record @param {number} cutoff */
function gcEligibleBinding(record, cutoff) {
  return record.state === 'closed' && record.closeReason !== 'session-ended' && Date.parse(record.closedAt) < cutoff;
}

/** @param {Map<string,any>} left @param {Map<string,any>} right */
function sameBindingRecords(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

/** Validate one session partition, GC old closed slots only for new-slot creation, and return this slot. @param {any} storage @param {any} identity @param {any} lockIdentity @param {{allowAuthorityOnlyRepair?:boolean,closedGcCutoff?:number}} [options] */
async function prepareBindingSlot(storage, identity, lockIdentity, options = {}) {
  let snapshot = await readBindingPartitionSnapshot(storage, identity.parentSessionId, true, options.allowAuthorityOnlyRepair === true); const key = rescueBindingKey(identity);
  if (snapshot.authority === null) {
    const authority = createRescueBindingAuthority({ parentSessionId: identity.parentSessionId, workspace: storage.workspacePath });
    await assertStateLockIdentity(storage, lockIdentity);
    await atomicWriteJson(bindingAuthorityPath(storage, identity.parentSessionId), authority, { privateRoot: storage.directory });
    await assertStateLockIdentity(storage, lockIdentity);
    snapshot = { authority, exists: false, records: new Map() };
  }
  if (snapshot.records.has(key)) return { record: snapshot.records.get(key), snapshot };
  const cutoff = options.closedGcCutoff ?? Date.now() - RESCUE_BINDING_CLOSED_GC_MS;
  const retained = new Map([...snapshot.records].filter(([, record]) => !gcEligibleBinding(record, cutoff)));
  if (retained.size !== snapshot.records.size) { const after = { authority: snapshot.authority, exists: true, records: retained }; await writeBindingPartitionGuarded(storage, identity.parentSessionId, snapshot, after, lockIdentity); snapshot = after; }
  if (snapshot.records.size >= RESCUE_BINDING_MAX_RECORDS) throw rescueBindingCapacity();
  return { record: null, snapshot };
}

const LEGACY_CONTINUATION_KEYS = Object.freeze([
  'agentPathDigest', 'authorizingParentGenerationId', 'authorizingParentTurnId', 'authorizingPermissionMode',
  'bindingKey', 'childAgentId', 'childAgentType', 'executionWorkspace', 'kind', 'originWorkspace', 'preparationAuthorityId',
]);

/** @param {any} input @param {string} workspace @param {string} permissionMode @param {boolean} [consumeAuthority] */
function reservationBindingContext(input, workspace, permissionMode, consumeAuthority = false) {
  const hasExecutor = input?.executor !== undefined; const hasAuthority = input?.authority !== undefined;
  if (hasExecutor === hasAuthority) throw invalidRescueBinding();
  if (hasExecutor) {
    if (!isPlainJsonObject(input.executor)) throw invalidRescueBinding();
    validateExecutorBindingInput(input.executor);
    const rawChildAuthority = {
      kind: 'subagent-start', childAgentId: input.executor.agentId, childAgentType: input.executor.agentType,
      parentTurnId: input.executor.parentTurnId, parentPermissionMode: input.executor.parentPermissionMode,
      ...(input.executor.agentPath === undefined ? {} : { agentPath: input.executor.agentPath }),
    };
    const childAuthority = input.executor.agentPath === undefined ? rawChildAuthority
      : validateRescueBindingChildAuthority(rawChildAuthority, workspace);
    return { kind: 'hook', childAuthority, identity: {
      parentSessionId: input.executor.parentSessionId, executorAgentId: childAuthority.childAgentId,
      executorAgentType: childAuthority.childAgentType, executorParentTurnId: childAuthority.parentTurnId,
      executorParentPermissionMode: childAuthority.parentPermissionMode, workspace, permissionMode,
      ...(childAuthority.agentPath === undefined ? {} : { executorAgentPath: childAuthority.agentPath }),
    } };
  }
  if (!isPlainJsonObject(input.authority)) throw invalidRescueBinding();
  let trustedContext;
  try { trustedContext = consumeAuthority
    ? consumeConsumedLegacyChildAuthorityContext(input.authority) : readConsumedLegacyChildAuthorityContext(input.authority); }
  catch {
    try { trustedContext = consumeAuthority
      ? consumePendingLegacyChildAuthorityContext(input.authority) : readPendingLegacyChildAuthorityContext(input.authority); }
    catch { throw invalidRescueBinding(); }
  }
  if (trustedContext.parentSessionId !== input.reservation.ownerSessionId) throw invalidRescueBinding();
  const trustedAuthority = trustedContext.authority;
  if (trustedAuthority.kind === 'codex-legacy-adoption') {
    const childAuthority = validateRescueBindingChildAuthority(trustedAuthority, workspace);
    return { kind: 'adoption', childAuthority, identity: {
      parentSessionId: trustedContext.parentSessionId, executorAgentId: childAuthority.childAgentId, workspace, permissionMode,
    } };
  }
  const authority = trustedAuthority;
  if (authority.kind !== 'codex-legacy-continuation'
    || Object.keys(authority).sort().join('\0') !== [...LEGACY_CONTINUATION_KEYS].sort().join('\0')
    || !isDigest(authority.preparationAuthorityId) || !isDigest(authority.bindingKey)
    || !isNonEmptyString(authority.childAgentId) || authority.childAgentType !== 'zcode-rescue'
    || !isNonEmptyString(authority.authorizingParentTurnId) || !isDigest(authority.authorizingParentGenerationId)
    || !PERMISSION_MODES.includes(authority.authorizingPermissionMode)
    || !isNonEmptyString(authority.originWorkspace) || authority.executionWorkspace !== workspace
    || !isDigest(authority.agentPathDigest)) throw invalidRescueBinding();
  return { kind: 'continuation', authority: structuredClone(authority), identity: {
    parentSessionId: trustedContext.parentSessionId, executorAgentId: authority.childAgentId, workspace, permissionMode,
  } };
}

/** @param {any} context @param {any} previous @param {any} reservation @param {string} workspace @param {boolean} allowPermissionReplacement */
function authorityForReservation(context, previous, reservation, workspace, allowPermissionReplacement) {
  if (context.kind === 'hook') {
    if (previous === null) return context.childAuthority;
    const durable = rescueBindingAuthorityView(previous);
    if (durable.kind === 'codex-legacy-adoption') {
      if (durable.childAgentId !== context.childAuthority.childAgentId
        || durable.childAgentType !== context.childAuthority.childAgentType
        || context.childAuthority.parentTurnId !== reservation.ownerTurnId
        || context.childAuthority.parentPermissionMode !== reservation.permissionSnapshot.permissionMode) throw invalidRescueBinding();
      return durable;
    }
    if (!sameHookAuthority(durable, context.childAuthority)) throw invalidRescueBinding();
    return durable.agentPath === undefined ? context.childAuthority : durable;
  }
  if (context.kind === 'adoption') {
    if (previous !== null || context.childAuthority.authorizingParentTurnId !== reservation.ownerTurnId
      || context.childAuthority.authorizingPermissionMode !== reservation.permissionSnapshot.permissionMode
      || context.childAuthority.executionWorkspace !== workspace) throw invalidRescueBinding();
    return context.childAuthority;
  }
  if (previous === null || previous.state !== 'active' && !(allowPermissionReplacement && previous.state === 'closed' && previous.closeReason === 'session-ended')
    || previous.key !== context.authority.bindingKey
    || context.authority.authorizingParentTurnId !== reservation.ownerTurnId
    || context.authority.authorizingPermissionMode !== reservation.permissionSnapshot.permissionMode
    || !allowPermissionReplacement && previous.permissionMode !== context.authority.authorizingPermissionMode) throw invalidRescueBinding();
  const durable = rescueBindingAuthorityView(previous);
  if (durable.kind !== 'codex-legacy-adoption' || durable.childAgentId !== context.authority.childAgentId
    || durable.childAgentType !== context.authority.childAgentType || durable.originWorkspace !== context.authority.originWorkspace
    || durable.executionWorkspace !== context.authority.executionWorkspace || durable.agentPathDigest !== context.authority.agentPathDigest) throw invalidRescueBinding();
  return durable;
}

/** @param {any} left @param {any} right */
function sameHookAuthority(left, right) {
  return left.kind === 'subagent-start' && right.kind === 'subagent-start'
    && left.childAgentId === right.childAgentId && left.childAgentType === right.childAgentType
    && left.parentTurnId === right.parentTurnId && left.parentPermissionMode === right.parentPermissionMode
    && (left.agentPath === undefined || right.agentPath === undefined || left.agentPath === right.agentPath);
}
/** @param {import('node:fs').BigIntStats} left @param {import('node:fs').BigIntStats} right */
function sameDirectoryIdentity(left, right) { return left.isDirectory() && right.isDirectory() && left.dev === right.dev && left.ino === right.ino; }

/** @param {any} input */
function validateRescueReservationInput(input) {
  if (!isPlainJsonObject(input) || !isNonEmptyString(input.workspace) || !isPlainJsonObject(input.reservation)) throw invalidRescueBinding();
  validateReservation(input.reservation);
  const hasExecutor = input.executor !== undefined; const hasAuthority = input.authority !== undefined;
  if (hasExecutor === hasAuthority) throw invalidRescueBinding();
  if (hasExecutor) validateExecutorBindingInput(input.executor);
  else if (!isPlainJsonObject(input.authority)) throw invalidRescueBinding();
  if (input.reservation.command !== 'rescue' || input.reservation.readOnly !== false
    || input.workspace !== input.reservation.workspace
    || hasExecutor && (!['zcode-rescue', 'default'].includes(input.executor.agentType)
      || input.workspace !== input.executor.workspace || input.reservation.ownerSessionId !== input.executor.parentSessionId)) throw invalidRescueBinding();
  const context = reservationBindingContext(input, input.workspace, /** @type {any} */ (input.reservation.permissionSnapshot).permissionMode);
  if (context.kind !== 'hook') {
    const authority = context.kind === 'adoption' ? context.childAuthority : context.authority;
    if (authority.authorizingParentTurnId !== input.reservation.ownerTurnId
      || authority.authorizingPermissionMode !== input.reservation.permissionSnapshot.permissionMode
      || authority.executionWorkspace !== input.workspace) throw invalidRescueBinding();
  }
}

/** Optional exact snapshot used only by a previously presented bound choice. @param {any} input */
function validateOptionalBindingExpectation(input) {
  const hasOperation = input.expectedOperationId !== undefined; const hasCurrent = input.expectedCurrentJobId !== undefined; const hasAnchor = input.expectedAnchorJobId !== undefined;
  if (hasOperation !== hasCurrent || hasOperation !== hasAnchor || hasOperation && (!isDigest(input.expectedOperationId) || !isDigest(input.expectedCurrentJobId) || !isDigest(input.expectedAnchorJobId))) throw staleRescueBinding();
}

/** @param {any} input */
function validateExecutorBindingInput(input) {
  if (!isPlainJsonObject(input) || !isNonEmptyString(input.parentSessionId) || !isNonEmptyString(input.parentTurnId) || !isNonEmptyString(input.agentId)
    || !isNonEmptyString(input.agentType) || !isNonEmptyString(input.workspace)
    || input.agentPath !== undefined && !validAgentPath(input.agentPath)
    || !PERMISSION_MODES.includes(input.parentPermissionMode)) throw invalidRescueBinding();
  try { rescueBindingKey(executorBindingIdentity(input, input.workspace)); } catch { throw invalidRescueBinding(); }
}

/** @param {any} input */
function validateBindingIdentityInput(input) {
  try { rescueBindingKey(input); } catch { throw invalidRescueBinding(); }
  if (input.permissionMode !== undefined && !PERMISSION_MODES.includes(input.permissionMode)) throw invalidRescueBinding();
}

/** @param {any} proof */
function validateBindingMigrationProof(proof) {
  if (!isPlainJsonObject(proof)
    || ![
      ['agentPathDigest', 'bindingDigest', 'childAgentId', 'childAgentType', 'executionWorkspace', 'operationId', 'originWorkspace', 'parentSessionId'],
      ['agentPath', 'bindingDigest', 'childAgentId', 'childAgentType', 'executionWorkspace', 'operationId', 'originWorkspace', 'parentSessionId'],
    ].some((keys) => Object.keys(proof).sort().join('\0') === keys.sort().join('\0'))
    || !isNonEmptyString(proof.parentSessionId) || !isNonEmptyString(proof.childAgentId)
    || !['zcode-rescue', 'default'].includes(proof.childAgentType) || !isDigest(proof.operationId) || !isDigest(proof.bindingDigest)
    || proof.agentPathDigest !== undefined && !isDigest(proof.agentPathDigest)
    || proof.agentPath !== undefined && !validAgentPath(proof.agentPath)
    || typeof proof.originWorkspace !== 'string' || typeof proof.executionWorkspace !== 'string') throw invalidRescueBinding();
}

/** @param {any} input */
function validateBindingMigrationLookup(input) {
  if (!isPlainJsonObject(input) || ![
    ['agentPathDigest', 'childAgentType', 'executionWorkspace', 'executorAgentId', 'originWorkspace', 'parentSessionId', 'workspace'],
    ['agentPath', 'childAgentType', 'executionWorkspace', 'executorAgentId', 'originWorkspace', 'parentSessionId', 'workspace'],
    ['agentPath', 'agentPathDigest', 'childAgentType', 'executionWorkspace', 'executorAgentId', 'originWorkspace', 'parentSessionId', 'workspace'],
  ].some((keys) => Object.keys(input).sort().join('\0') === keys.sort().join('\0'))
    || !isNonEmptyString(input.parentSessionId) || !isNonEmptyString(input.executorAgentId) || !['zcode-rescue', 'default'].includes(input.childAgentType)
    || input.agentPathDigest !== undefined && !isDigest(input.agentPathDigest)
    || input.agentPath !== undefined && !validAgentPath(input.agentPath)
    || typeof input.workspace !== 'string' || typeof input.originWorkspace !== 'string'
    || typeof input.executionWorkspace !== 'string') throw invalidRescueBinding();
  try { rescueBindingKey({ parentSessionId: input.parentSessionId, executorAgentId: input.executorAgentId, workspace: input.workspace }); } catch { throw invalidRescueBinding(); }
}

/** @param {any} input */
function validateMigrationRollbackInput(input) {
  const keys = ['childAgentId', 'jobId', 'operationId', 'parentSessionId', 'priorClosedAt', 'priorCurrentJobId', 'priorUpdatedAt', 'priorVersion', 'workspace'];
  if (!isPlainJsonObject(input) || ![keys, [...keys, 'priorBinding']]
    .some((candidate) => Object.keys(input).sort().join('\0') === candidate.sort().join('\0'))
    || !isNonEmptyString(input.workspace) || !isBoundedOwnerSessionId(input.parentSessionId)
    || !isNonEmptyString(input.childAgentId) || !isDigest(input.jobId) || !isDigest(input.operationId)
    || !isDigest(input.priorCurrentJobId) || !isIsoTimestamp(input.priorUpdatedAt)
    || ![1, 2, 3].includes(input.priorVersion)
    || !isIsoTimestamp(input.priorClosedAt) || Date.parse(input.priorUpdatedAt) !== Date.parse(input.priorClosedAt)) {
    throw invalidRescueBinding();
  }
}

/** @param {any} input @param {string} workspace */
function bindingIdentity(input, workspace) {
  return { parentSessionId: input.parentSessionId, executorAgentId: input.executorAgentId, workspace,
    ...(input.executorAgentType === undefined ? {} : { executorAgentType: input.executorAgentType }),
    ...(input.executorParentTurnId === undefined ? {} : { executorParentTurnId: input.executorParentTurnId }),
    ...(input.executorParentPermissionMode === undefined ? {} : { executorParentPermissionMode: input.executorParentPermissionMode }),
    ...(input.executorAgentPath === undefined ? {} : { executorAgentPath: input.executorAgentPath }),
    ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }) };
}

/** Map the trusted SubagentStart executor record to persisted binding terminology. @param {any} executor @param {string} workspace */
function executorBindingIdentity(executor, workspace, permissionMode = executor.parentPermissionMode) {
  return { parentSessionId: executor.parentSessionId, executorAgentId: executor.agentId, executorAgentType: executor.agentType,
    executorParentTurnId: executor.parentTurnId, executorParentPermissionMode: executor.parentPermissionMode,
    executorAgentPath: executor.agentPath, workspace, permissionMode };
}

/** @param {unknown} value */
function validAgentPath(value) {
  return isCanonicalCodexAgentPath(value);
}

/** @param {any} job @param {string} parentSessionId @param {string} workspace */
function validateAnchorJob(job, parentSessionId, workspace) {
  if (!job || job.workspace !== workspace || job.ownerSessionId !== parentSessionId || job.command !== 'rescue'
    || typeof job.zcodeSessionId !== 'string' || !['running', 'succeeded', 'failed'].includes(job.status)) throw invalidRescueBinding();
}
/** @param {any} job @param {string} parentSessionId @param {string} workspace */
function validateCurrentJob(job, parentSessionId, workspace) {
  if (!job || job.workspace !== workspace || job.ownerSessionId !== parentSessionId || job.command !== 'rescue'
    || job.status === 'cancelled') throw invalidRescueBinding();
}
function invalidRescueBinding() { return new PluginError('RESCUE_BINDING_INVALID', 'The private Rescue operation binding is invalid.', { category: 'authorization', remedy: 'Start a fresh Rescue operation from the active parent turn.' }); }
function notRunnableRescueBinding() { return new PluginError('RESCUE_BINDING_NOT_RUNNABLE', 'The queued Rescue reservation was never advanced to its runnable binding.', { category: 'state', remedy: 'Terminalize the interrupted reservation and retry from the persisted child operation.' }); }
/** @param {string} workspace @param {string} jobId @param {any} worker */
function validateWorkerClaimInput(workspace, jobId, worker) {
  if (!isNonEmptyString(workspace) || !isDigest(jobId) || !isPlainJsonObject(worker)
    || !Number.isSafeInteger(worker.childPid) || worker.childPid <= 0 || !isDigest(worker.workerLeaseId)) {
    throw new PluginError('WORKER_LEASE_INVALID', 'Worker lease claim is invalid.', {
      category: 'state', remedy: 'Claim a queued job with one positive process ID and one 64-character lease digest.',
    });
  }
}
/** @param {string} jobId */
function workerLeaseConflict(jobId) {
  return new PluginError('WORKER_LEASE_CONFLICT', `Job ${jobId} is already claimed or no longer queued.`, {
    category: 'state', remedy: 'Only the worker holding the exact durable lease may execute this reservation.',
  });
}
function closedRescueBinding() { return new PluginError('RESCUE_BINDING_CLOSED', 'The Rescue operation binding is closed.', { category: 'state', remedy: 'Start a fresh Rescue operation from the active parent turn.' }); }
function staleRescueBinding() { return new PluginError('RESCUE_BINDING_STALE', 'The Rescue operation generation changed.', { category: 'state', remedy: 'Reload the exact Rescue binding before retrying.' }); }
function rescueBindingCapacity() { return new PluginError('RESCUE_BINDING_CAPACITY', 'The Rescue binding capacity is exhausted.', { category: 'state', remedy: 'End or clean up old Rescue operations before retrying.' }); }

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
    const rescueReservationKind = validRescueReservationKind(job.rescueReservationKind)
      ? job.rescueReservationKind : undefined;
    await atomicWriteJson(join(directory, `${job.id}.json`), rescueReservationKind === undefined ? {
      jobId: job.id, ownerSessionId: job.ownerSessionId, version: OWNER_BINDING_VERSION,
    } : {
      jobId: job.id, ownerSessionId: job.ownerSessionId, rescueReservationKind,
      version: OWNER_BINDING_RECORD_VERSION,
    }, { privateRoot: storage.ownerIndexDirectory });
  } catch { throw ownedJobIndexInvalid(job.id); }
}

/** Read the independently-published reservation class for one writable Rescue job. @param {any} storage @param {any} job */
async function readRescueReservationEvidence(storage, job) {
  const path = join(ownerBindingDirectory(storage.ownerIndexDirectory, job.ownerSessionId), `${job.id}.json`);
  let binding;
  try {
    binding = await readBoundedJsonFile(storage.ownerIndexDirectory, path, OWNER_BINDING_MAX_BYTES);
  } catch { throw invalidRescueBinding(); }
  const common = isPlainJsonObject(binding) && binding.jobId === job.id && binding.ownerSessionId === job.ownerSessionId;
  if (common && Object.keys(binding).sort().join(',') === 'jobId,ownerSessionId,version'
    && binding.version === OWNER_BINDING_VERSION && job.rescueReservationKind === undefined) return { kind: 'legacy' };
  if (common && Object.keys(binding).sort().join(',') === 'jobId,ownerSessionId,rescueReservationKind,version'
    && binding.version === OWNER_BINDING_RECORD_VERSION && validRescueReservationKind(binding.rescueReservationKind)
    && binding.rescueReservationKind === job.rescueReservationKind) return { kind: binding.rescueReservationKind };
  throw invalidRescueBinding();
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
    const validLegacy = isPlainJsonObject(binding)
      && Object.keys(binding).sort().join(',') === 'jobId,ownerSessionId,version'
      && binding.version === OWNER_BINDING_VERSION;
    const validModern = isPlainJsonObject(binding)
      && Object.keys(binding).sort().join(',') === 'jobId,ownerSessionId,rescueReservationKind,version'
      && binding.version === OWNER_BINDING_RECORD_VERSION && validRescueReservationKind(binding.rescueReservationKind);
    if (!(validLegacy || validModern) || binding.jobId !== jobId || binding.ownerSessionId !== ownerSessionId) {
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
    if (job.ownerSessionId !== ownerSessionId
      || validModern !== validRescueReservationKind(job.rescueReservationKind)
      || validModern && binding.rescueReservationKind !== job.rescueReservationKind) throw ownedJobRecordInvalid(jobId);
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
      expectedJobLogPath(jobsDirectory, entry.slice(0, -'.json'.length)),
    )));
}

/** @param {string} path @param {string} jobId @param {string} expectedWorkspacePath */
async function readJobRecord(path, jobId, expectedWorkspacePath) {
  try {
    return validateJobRecord(await readJsonFile(path), jobId, expectedWorkspacePath, expectedJobLogPath(dirname(path), jobId));
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
export function validProgressProbe(value) {
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

/** @param {any} job @param {string} expectedJobId @param {string} expectedWorkspacePath @param {string} expectedLogFile @returns {any} */
function validateJobRecord(job, expectedJobId, expectedWorkspacePath, expectedLogFile) {
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
    && (!('logFile' in job) || job.logFile === expectedLogFile)
    && (!('error' in job) || isTrackedError(job.error))
    && (!('lastCancelError' in job) || isCancellationError(job.lastCancelError))
    && (!('phase' in job) || PROGRESS_PHASES.includes(job.phase))
    && (!('lastActivityAt' in job) || isIsoTimestamp(job.lastActivityAt))
    && (!('progressPreview' in job) || validProgressPreview(job.progressPreview))
    && (!('progressProbe' in job) || validProgressProbe(job.progressProbe))
    && (!('rescueReservationKind' in job) || job.command === 'rescue' && job.readOnly === false
      && validRescueReservationKind(job.rescueReservationKind))
    && (!('rescueMigrationRollback' in job) || validPersistedMigrationRollback(job.rescueMigrationRollback, job))
    && (!('rescueContinuationOrigin' in job) || validRescueContinuationOrigin(job.rescueContinuationOrigin, job))
    && (!('rescueExecutionClaim' in job) || validRescueExecutionClaim(job.rescueExecutionClaim, job))
    && (!('rescueExecutionReservation' in job) || validExecutionReservation(job.rescueExecutionReservation, job, true))
    && (!('rescueJobSpecCommitment' in job) || job.status === 'queued' && isDigest(job.rescueJobSpecCommitment))
    && (!('rescueLegacyJobSpecProof' in job) || validLegacyJobSpecProof(job.rescueLegacyJobSpecProof, job))
    && !('rescueJobSpecCommitment' in job && 'rescueLegacyJobSpecProof' in job)
    && !('rescueMigrationRollback' in job && 'rescueContinuationOrigin' in job);
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

/** @param {string} jobsDirectory @param {string} jobId */
function expectedJobLogPath(jobsDirectory, jobId) {
  return join(jobsDirectory, `${jobId}.log`);
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
