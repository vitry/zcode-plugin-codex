import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { PluginError } from './errors.mjs';
import {
  atomicWriteJson, ensurePrivateDirectory, readBoundedJsonFile, readJsonFile,
  readPrivateDirectory, withFileLock,
} from './fs.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';

const CALLER_LIFETIME_MS = 30 * 60_000;
const MAX_CALLER_RECORD_BYTES = 48 * 1024;
const MAX_ACTIVE_TURN_BYTES = 96 * 1024;
const MAX_SESSION_BYTES = 32 * 1024;
const MAX_ORIGIN_INDEX_BYTES = 16 * 1024;
const MAX_ORIGIN_INDEX_RECORDS = 64;
const MAX_LEGACY_ACTIVE_RECORDS = 256;
const MAX_SESSION_AGE_MS = 31 * 24 * 60 * 60_000;
const MAX_ID_BYTES = 4 * 1024;
const MAX_PATH_BYTES = 16 * 1024;
const execFile = promisify(execFileCallback);
export const PERMISSION_MODES = Object.freeze([
  'default', 'plan', 'dontAsk', 'read-only', 'workspace-write', 'acceptEdits', 'bypassPermissions',
]);
export const EXECUTION_OPERATIONS = Object.freeze([
  'review', 'adversarial-review', 'rescue', 'transfer', 'status', 'result', 'cancel', 'setup',
  'run-reserved-job', 'continue',
]);

/**
 * @param {{ dataRoot: string, gitProbe?: (workspace:string)=>Promise<string>, publicationSeam?: (point:string)=>Promise<void>|void }} options
 * @private gitProbe and publicationSeam are test-only fault-injection seams.
 */
export function createIdentityStore({ dataRoot, gitProbe, publicationSeam } = /** @type {any} */ ({})) {
  if (typeof dataRoot !== 'string' || dataRoot.length === 0) {
    throw new PluginError('DATA_ROOT_REQUIRED', 'A plugin data root must be provided explicitly.', {
      category: 'configuration',
      remedy: 'Pass the installed plugin data directory as dataRoot.',
    });
  }
  if (gitProbe !== undefined && typeof gitProbe !== 'function') throw invalidIdentityInput();
  if (publicationSeam !== undefined && typeof publicationSeam !== 'function') throw invalidIdentityInput();

  return {
    /** Remove credentials belonging to one ended parent session only. */
    /** @param {string} workspace @param {string} sessionId @returns {Promise<any>} */
    async cleanupSession(workspace, sessionId) {
      if (!isNonEmptyString(sessionId)) throw invalidIdentityInput();
      const cleanupWorkspace = await canonicalWorkspace(workspace);
      const global = await globalIdentityStorage(dataRoot);
      return withFileLock(sessionLockPath(global, sessionId), async () => {
        const state = await readGlobalCleanupState(global, sessionId);
        if (state === null) {
          const legacyStorage = await identityStorage(dataRoot, workspace);
          await withFileLock(legacyStorage.lockPath, () => cleanupWorkspaceSession(legacyStorage, sessionId));
          return null;
        }
        const { active, ledger } = state;
        if (ledger === null) {
          if (active.originWorkspace !== cleanupWorkspace) throw workspaceIneligible();
          const endedAt = monotonicTimestamp(active.createdAt);
          const tombstone = orphanSessionTombstone(active, endedAt);
          await atomicWriteJson(state.sessionPath, tombstone, { privateRoot: global.directory });
          await publicationSeam?.('after-cleanup-tombstone');
          await unlink(state.activePath).catch((error) => { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error; });
          const orphanStorage = await identityStorageForCanonical(global.dataRootPath, active.originWorkspace);
          await withFileLock(orphanStorage.lockPath, () => cleanupWorkspaceSession(orphanStorage, sessionId));
          return { knownWorkspaces: [active.originWorkspace] };
        }
        if (!ledger.knownWorkspaces.includes(cleanupWorkspace)) throw workspaceIneligible();
        if (ledger.endedAt === null) {
          const endedAt = monotonicTimestamp(ledger.updatedAt);
          await atomicWriteJson(state.sessionPath, { ...ledger, endedAt, updatedAt: endedAt }, { privateRoot: global.directory });
        }
        await publicationSeam?.('after-cleanup-tombstone');
        if (active !== null) await unlink(state.activePath).catch((error) => { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error; });
        for (const knownWorkspace of ledger.knownWorkspaces) {
          const knownStorage = await identityStorageForCanonical(global.dataRootPath, knownWorkspace);
          await withFileLock(knownStorage.lockPath, () => cleanupWorkspaceSession(knownStorage, sessionId));
        }
        return { knownWorkspaces: [...ledger.knownWorkspaces] };
      });
    },
    /** @param {CallerContextInput} input */
    async createCallerContext(input) {
      const operationTimestamp = validateCallerInput(input);
      const storage = await identityStorage(dataRoot, input.workspace);
      const { token, digest, record } = callerRecord(input, storage.workspacePath, operationTimestamp);
      const global = await globalIdentityStorage(dataRoot);
      await withFileLock(sessionLockPath(global, input.sessionId), async () => {
        const state = await readGlobalState(global, input.sessionId, false);
        if (state === null) {
          await withFileLock(storage.lockPath, () => atomicWriteJson(
            join(storage.callersDirectory, `${digest}.json`), record,
          ));
          return;
        }
        if (state.active === null || state.active.status !== 'active' || state.ledger.endedAt !== null
          || state.active.turnId !== input.turnId || state.active.originWorkspace !== storage.workspacePath
          || state.active.permissionMode !== input.permissionMode) throw invalidCallerContext();
        await withFileLock(storage.lockPath, async () => {
          await atomicWriteJson(
            join(storage.callersDirectory, `${digest}.json`), provedCallerRecord(record, state.active.generationId),
          );
          await publicationSeam?.('after-protected-caller-write');
        });
      });
      return token;
    },

    /** Atomically starts one caller turn and revokes older turns for this exact session. @param {CallerContextInput} input @returns {Promise<any>} */
    async beginCallerTurn(input) {
      const operationTimestamp = validateCallerInput(input);
      const storage = await identityStorage(dataRoot, input.workspace);
      const { token, digest, record } = callerRecord(input, storage.workspacePath, operationTimestamp);
      if (!hasSessionProof(input)) {
        await withFileLock(storage.lockPath, async () => {
          await removeCallerRecords(storage.callersDirectory, (current) => current.sessionId === input.sessionId && current.turnId !== input.turnId);
          await atomicWriteJson(join(storage.callersDirectory, `${digest}.json`), record);
          const active = activeTurnRecord(input, storage.workspacePath, operationTimestamp);
          await atomicWriteJson(join(storage.activeTurnsDirectory, `${activeTurnKey(input.sessionId, storage.workspacePath)}.json`), active);
        });
        return token;
      }

      const global = await globalIdentityStorage(dataRoot);
      /** @type {string} */ let generationId = ''; let replacedTurn = null;
      /** @type {string[]} */ let priorWorkspaces = [];
      const lifecycleLockPath = sessionLockPath(global, input.sessionId);
      await withFileLock(lifecycleLockPath, async () => {
        const state = await readGlobalBeginState(global, input, operationTimestamp);
        const existing = state?.active ?? null; const ledger = state?.ledger ?? null;
        if (ledger !== null) {
          if (ledger.endedAt !== null && Date.parse(input.sessionStartedAt) <= Date.parse(ledger.sessionStartedAt)) {
            throw authorizationError('IDENTITY_SESSION_ENDED', 'The identity session has ended.', 'Start or resume a newer Codex session.');
          }
          if (ledger.endedAt === null && (ledger.sessionStartedAt !== input.sessionStartedAt || ledger.sessionSource !== input.sessionSource)) {
            throw authorizationError('IDENTITY_SESSION_MISMATCH', 'The identity session proof does not match the active session.');
          }
        }
        const orphanRetry = ledger === null && existing !== null && existing.status === 'pending'
          && strictTimestamp(input.sessionStartedAt) <= Date.parse(existing.createdAt);
        const duplicate = existing !== null && activeAuthorityEqual(existing, input, storage.workspacePath)
          && (ledger?.endedAt === null || orphanRetry);
        const recoverableWorkspaces = ledger !== null && ledger.endedAt === null
          ? ledger.knownWorkspaces : ledger === null && existing !== null ? [existing.originWorkspace] : [];
        priorWorkspaces = [...recoverableWorkspaces];
        generationId = duplicate ? existing.generationId : randomBytes(32).toString('hex');
        if (!duplicate && existing !== null) replacedTurn = replacedTurnMetadata(existing);
        const knownWorkspaces = appendKnownWorkspace(
          recoverableWorkspaces, storage.workspacePath,
        );
        const updatedAt = new Date(Math.max(operationTimestamp, ledger === null ? 0 : Date.parse(ledger.updatedAt))).toISOString();
        const nextLedger = sessionRecord(input, globalIdentityKey(input.sessionId), knownWorkspaces, updatedAt);
        const pending = duplicate ? existing : globalActiveTurnRecord(
          input, storage.workspacePath, globalIdentityKey(input.sessionId), generationId, 'pending', operationTimestamp,
        );
        await publicationSeam?.('before-pending');
        if (!duplicate) {
          await atomicWriteJson(state?.activePath ?? join(global.activeTurnsDirectory, `${pending.key}.json`), pending, { privateRoot: global.directory });
          await publicationSeam?.('after-begin-pending-write');
        }
        await atomicWriteJson(state?.sessionPath ?? join(global.sessionsDirectory, `${pending.key}.json`), nextLedger, { privateRoot: global.directory });
        await publicationSeam?.('after-pending');
      });

      await publicationSeam?.('before-workspace-publish');
      await withFileLock(lifecycleLockPath, async () => {
        const beforeWorkspace = await readGlobalState(global, input.sessionId, false);
        if (beforeWorkspace === null || beforeWorkspace.active === null || beforeWorkspace.ledger.endedAt !== null
          || beforeWorkspace.active.generationId !== generationId
          || !activeAuthorityEqual(beforeWorkspace.active, input, storage.workspacePath)) {
          throw invalidAuthorizationRecord('active turn publication');
        }
        for (const priorWorkspace of priorWorkspaces) {
          if (priorWorkspace === storage.workspacePath) continue;
          const priorStorage = await identityStorageForCanonical(global.dataRootPath, priorWorkspace);
          await withFileLock(priorStorage.lockPath, () => removeCallerRecords(
            priorStorage.callersDirectory, (current) => current.sessionId === input.sessionId,
          ));
        }
        await withFileLock(storage.lockPath, async () => {
          await removeCallerRecords(storage.callersDirectory, (current) => current.sessionId === input.sessionId);
          await atomicWriteJson(join(storage.callersDirectory, `${digest}.json`), provedCallerRecord(record, generationId));
          await publicationSeam?.('after-caller-write');
          const index = originIndexRecord(input.sessionId, generationId, storage.workspacePath);
          await atomicWriteJson(join(storage.originIndexesDirectory, `${index.key}.json`), index);
          await publicationSeam?.('after-index-write');
        });
        await publicationSeam?.('after-workspace-publish');
        await publicationSeam?.('before-active-publish');
        const state = await readGlobalState(global, input.sessionId, false);
        if (state === null || state.active === null || state.ledger.endedAt !== null
          || state.active.generationId !== generationId || !activeAuthorityEqual(state.active, input, storage.workspacePath)) {
          throw invalidAuthorizationRecord('active turn publication');
        }
        if (state.active.status === 'pending') {
          await atomicWriteJson(state.activePath, { ...state.active, status: 'active' }, { privateRoot: global.directory });
        }
        await publicationSeam?.('after-active-publish');
      });
      return input.lifecycleResult ? { token, replacedTurn } : token;
    },

    /** Resolve only the exact ambient session and canonical workspace. @param {{sessionId:string,workspace:string,workspaceBinding?:'preview'|'claim'|'execution'|'effective',now?:Date|number|string}} expected @returns {Promise<any>} */
    async resolveActiveTurn(expected) {
      validateActiveExpected(expected); const candidate = await canonicalWorkspace(expected.workspace); const global = await globalIdentityStorage(dataRoot);
      const lifecycleLockPath = sessionLockPath(global, expected.sessionId);
      const first = await withFileLock(lifecycleLockPath, async () => {
        const state = await readGlobalState(global, expected.sessionId, true);
        if (state === null) return { kind: 'legacy' };
        const { active, ledger } = state;
        if (active === null || active.status !== 'active' || ledger.endedAt !== null) throw authorizationError('ACTIVE_TURN_NOT_FOUND', 'No active turn matches this session and workspace.');
        const mode = expected.workspaceBinding;
        if (mode === undefined) {
          if (candidate !== active.originWorkspace) throw workspaceIneligible();
          return { kind: 'resolved', caller: publicActiveTurn(active, candidate, false) };
        }
        if (mode === 'effective') {
          if (!lifecycleRecordsConsistent(active, ledger)) throw invalidAuthorizationRecord('identity session');
          if (active.executionWorkspace === null) {
            if (candidate !== active.originWorkspace) throw workspaceIneligible();
            return { kind: 'resolved', caller: publicActiveTurn(active, active.originWorkspace, false) };
          }
          if (candidate !== active.originWorkspace && candidate !== active.executionWorkspace) throw workspaceIneligible();
          return { kind: 'resolved', caller: publicActiveTurn(active, active.executionWorkspace, true) };
        }
        if (mode === 'execution') {
          if (active.executionWorkspace === null
            || candidate !== active.originWorkspace && candidate !== active.executionWorkspace) throw workspaceIneligible();
          return { kind: 'resolved', caller: publicActiveTurn(active, active.executionWorkspace, true) };
        }
        if (active.executionWorkspace !== null) {
          if (active.executionWorkspace !== candidate) throw workspaceIneligible();
          if (mode === 'claim') await persistClaim(state, candidate, publicationSeam, global.directory);
          return { kind: 'resolved', caller: publicActiveTurn(active, candidate, true) };
        }
        if (candidate === active.originWorkspace) {
          if (mode === 'preview') return { kind: 'resolved', caller: publicActiveTurn(active, candidate, true) };
          const bound = await persistClaim(state, candidate, publicationSeam, global.directory);
          return { kind: 'resolved', caller: publicActiveTurn(bound, candidate, true) };
        }
        return { kind: 'probe', generationId: active.generationId, originWorkspace: active.originWorkspace };
      });
      if (first.kind === 'resolved') return first.caller;
      if (first.kind === 'legacy') {
        const storage = await identityStorage(dataRoot, expected.workspace);
        const legacy = await resolveLegacyActiveTurn(storage, expected);
        const stillAbsent = await withFileLock(lifecycleLockPath, () => readGlobalState(global, expected.sessionId, false));
        if (stillAbsent !== null) throw authorizationError('ACTIVE_TURN_NOT_FOUND', 'No active turn matches this session and workspace.');
        return legacy;
      }
      await assertWorkspaceEligible(first.originWorkspace, candidate, gitProbe);
      return withFileLock(lifecycleLockPath, async () => {
        const state = await readGlobalState(global, expected.sessionId, true);
        if (state === null || state.active === null || state.active.status !== 'active' || state.ledger.endedAt !== null
          || state.active.generationId !== first.generationId) throw workspaceIneligible();
        if (state.active.executionWorkspace !== null) {
          if (state.active.executionWorkspace !== candidate) throw workspaceIneligible();
          if (expected.workspaceBinding === 'claim') await persistClaim(state, candidate, publicationSeam, global.directory);
          return publicActiveTurn(state.active, candidate, true);
        }
        if (expected.workspaceBinding === 'preview') return publicActiveTurn(state.active, candidate, true);
        const bound = await persistClaim(state, candidate, publicationSeam, global.directory);
        return publicActiveTurn(bound, candidate, true);
      });
    },

    /** Resolve exactly one runtime-recorded active turn for a canonical workspace, independent of prompt text. @param {{workspace:string,now?:Date|number|string}} expected */
    async resolveOnlyActiveTurn(expected) {
      if (!isPlainObject(expected) || !isNonEmptyString(expected.workspace)) throw invalidIdentityInput();
      const storage = await identityStorage(dataRoot, expected.workspace);
      const local = await withFileLock(storage.lockPath, async () => {
        const legacy = []; const indexes = [];
        const entries = await readPrivateDirectory(storage.directory, storage.originIndexesDirectory, MAX_ORIGIN_INDEX_RECORDS);
        for (const entry of entries) {
          if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) throw invalidAuthorizationRecord('active turn index');
          const index = await readRequiredBoundedIdentity(storage.directory, join(storage.originIndexesDirectory, entry.name), MAX_ORIGIN_INDEX_BYTES, 'active turn index');
          const filenameKey = entry.name.slice(0, -5);
          if (!isOriginIndexRecord(index) || !safeEqual(index.key, filenameKey)
            || !safeEqual(index.key, activeTurnKey(index.sessionId, storage.workspacePath))
            || !safeEqual(index.globalKey, globalIdentityKey(index.sessionId))
            || index.originWorkspace !== storage.workspacePath) throw invalidAuthorizationRecord('active turn index');
          indexes.push(index);
        }
        const activeEntries = await readPrivateDirectory(storage.directory, storage.activeTurnsDirectory, MAX_LEGACY_ACTIVE_RECORDS);
        for (const entry of activeEntries) {
          if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
          const name = entry.name;
          const record = await readRequiredBoundedIdentity(storage.directory, join(storage.activeTurnsDirectory, name), MAX_ACTIVE_TURN_BYTES, 'active turn');
          if (!isActiveTurnRecord(record)) throw invalidAuthorizationRecord('active turn');
          const filenameKey = name.slice(0, -'.json'.length);
          if (record.workspace !== storage.workspacePath || !safeEqual(record.key, filenameKey)
            || !safeEqual(record.key, activeTurnKey(record.sessionId, storage.workspacePath))) throw invalidAuthorizationRecord('active turn');
          if (isCurrentActiveTurnRecord(record) || toTimestamp(expected.now) < Date.parse(record.expiresAt)) legacy.push(record);
        }
        return { indexes, legacy };
      });
      const global = await globalIdentityStorage(dataRoot);
      const active = []; const suppressedSessions = new Set(); const states = new Map();
      /** @param {string} sessionId */
      const stateFor = async (sessionId) => {
        if (!states.has(sessionId)) {
          const state = await withFileLock(sessionLockPath(global, sessionId), () => readGlobalState(global, sessionId, true));
          states.set(sessionId, state);
        }
        return states.get(sessionId);
      };
      for (const index of local.indexes) {
        suppressedSessions.add(index.sessionId);
        const state = await stateFor(index.sessionId);
        if (state === null || state.active === null || state.active.status !== 'active' || state.ledger.endedAt !== null) continue;
        if (state.active.generationId !== index.generationId) continue;
        if (state.active.originWorkspace !== storage.workspacePath || state.active.key !== index.globalKey) throw invalidAuthorizationRecord('active turn index');
        active.push(state.active);
      }
      for (const legacy of local.legacy) {
        if (suppressedSessions.has(legacy.sessionId)) continue;
        if (await stateFor(legacy.sessionId) !== null) suppressedSessions.add(legacy.sessionId);
      }
      const candidates = [...local.legacy.filter((record) => !suppressedSessions.has(record.sessionId)), ...active];
      if (candidates.length !== 1) throw setupSessionUnproven(candidates.length);
      return isGlobalActiveTurnRecord(candidates[0]) ? publicActiveTurn(candidates[0], storage.workspacePath, false) : publicRecord(candidates[0]);
    },

    /** Revokes every caller credential for one exact completed turn. @param {GateBaselineIdentity} input */
    async endCallerTurn(input) {
      validateTurnIdentity(input);
      const candidate = await canonicalWorkspace(input.workspace); const global = await globalIdentityStorage(dataRoot);
      return withFileLock(sessionLockPath(global, input.sessionId), async () => {
        const state = await readGlobalState(global, input.sessionId, false);
        let globalResult = null;
        if (state?.active !== null && state?.active !== undefined) {
          const active = state.active;
          if (active.turnId !== input.turnId) globalResult = { matched: false, originWorkspace: active.originWorkspace, executionWorkspace: active.executionWorkspace };
          else {
            if (candidate !== active.originWorkspace && candidate !== active.executionWorkspace) throw workspaceIneligible();
            await unlink(state.activePath);
            await publicationSeam?.('after-active-revoke');
            globalResult = { matched: true, originWorkspace: active.originWorkspace, executionWorkspace: active.executionWorkspace };
          }
        } else globalResult = { matched: false, originWorkspace: null, executionWorkspace: null };
        const storage = globalResult?.originWorkspace === null
          ? await identityStorage(dataRoot, input.workspace)
          : await identityStorageForCanonical(global.dataRootPath, globalResult?.originWorkspace ?? candidate);
        await withFileLock(storage.lockPath, () => endWorkspaceTurn(storage, input));
        if (globalResult === null || !globalResult.matched) return undefined;
        return { originWorkspace: globalResult.originWorkspace, executionWorkspace: globalResult.executionWorkspace };
      });
    },

    /** @param {string} token @param {{ workspace: string, now?: Date | number | string }} expected */
    async consumeCallerContext(token, expected) {
      validateTokenAndWorkspace(token, expected);
      const storage = await identityStorage(dataRoot, expected.workspace);
      const digest = tokenDigest(token);
      const discovered = await withFileLock(storage.lockPath,
        () => readCallerContextRecord(storage, digest, expected));
      await publicationSeam?.('after-caller-discovery');
      const global = await globalIdentityStorage(dataRoot);
      return withFileLock(sessionLockPath(global, discovered.sessionId), async () => {
        const state = await readGlobalState(global, discovered.sessionId, false);
        if (state !== null && (state.ledger.endedAt !== null || state.active === null || state.active.status !== 'active')) {
          throw invalidCallerContext();
        }
        return withFileLock(storage.lockPath, async () => {
          const current = await readCallerContextRecord(storage, digest, expected);
          if (!safeEqual(current.sessionId, discovered.sessionId)) throw invalidCallerContext();
          if (state === null ? isProvedCallerRecord(current) : !callerMatchesActive(current, state.active)) throw invalidCallerContext();
          return publicCallerRecord(current);
        });
      });
    },

    /** @param {ExecutionCapabilityInput} input */
    async createExecutionCapability(input) {
      validateExecutionInput(input, true);
      const storage = await identityStorage(dataRoot, input.workspace);
      const token = createToken();
      const digest = tokenDigest(token);
      const record = {
        digest,
        jobId: input.jobId,
        ownerSessionId: input.ownerSessionId,
        workspace: storage.workspacePath,
        operation: input.operation,
        permissionSnapshot: input.permissionSnapshot,
        ...(input.jobSpecFormat === undefined ? {} : { jobSpecFormat: input.jobSpecFormat }),
        ...(input.specDigest === undefined ? {} : { specDigest: input.specDigest }),
        createdAt: new Date().toISOString(),
        consumedAt: null,
        revokedAt: null,
      };
      await withFileLock(storage.lockPath, () => atomicWriteJson(
        join(storage.capabilitiesDirectory, `${digest}.json`),
        record,
      ));
      return token;
    },

    /** Read-only capability validation used before StateStore historical-proof validation.
     * @param {string} token @param {ExecutionCapabilityExpected} expected @param {string} reservationId */
    async inspectExecutionCapability(token, expected, reservationId) {
      validateExecutionInput(expected, false); validateToken(token);
      if (!isDigest(reservationId)) throw invalidIdentityInput();
      const storage = await identityStorage(dataRoot, expected.workspace); const digest = tokenDigest(token);
      return withFileLock(storage.lockPath, async () => {
        const { record } = await readMatchingExecutionCapability(storage, digest, expected);
        validateAvailableExecutionCapability(record, reservationId);
        return publicRecord(record);
      });
    },

    /** Reserve capability consumption without setting consumedAt; idempotent for one exact attempt.
     * @param {string} token @param {ExecutionCapabilityExpected} expected @param {string} reservationId @param {string} [workerLeaseId] */
    async reserveExecutionCapability(token, expected, reservationId, workerLeaseId) {
      validateExecutionInput(expected, false); validateToken(token);
      if (!isDigest(reservationId) || workerLeaseId !== undefined && !isDigest(workerLeaseId)) throw invalidIdentityInput();
      const storage = await identityStorage(dataRoot, expected.workspace); const digest = tokenDigest(token);
      return withFileLock(storage.lockPath, async () => {
        const { path, record } = await readMatchingExecutionCapability(storage, digest, expected);
        validateAvailableExecutionCapability(record, reservationId);
        if (record.executionReservationWorkerLeaseId !== undefined
          && record.executionReservationWorkerLeaseId !== workerLeaseId) throw invalidAuthorizationRecord('execution capability reservation');
        if (record.executionReservationId === reservationId
          && (workerLeaseId === undefined || record.executionReservationWorkerLeaseId === workerLeaseId)) return publicRecord(record);
        const reserved = { ...record, executionReservationId: reservationId,
          ...(workerLeaseId === undefined ? {} : { executionReservationWorkerLeaseId: workerLeaseId }) };
        await atomicWriteJson(path, reserved); return publicRecord(reserved);
      });
    },

    /** Commit a previously reserved capability only after the StateStore claim succeeds.
     * @param {string} token @param {ExecutionCapabilityExpected} expected @param {string} reservationId @param {string} [workerLeaseId] */
    async commitExecutionCapability(token, expected, reservationId, workerLeaseId) {
      validateExecutionInput(expected, false); validateToken(token);
      if (!isDigest(reservationId) || workerLeaseId !== undefined && !isDigest(workerLeaseId)) throw invalidIdentityInput();
      const storage = await identityStorage(dataRoot, expected.workspace); const digest = tokenDigest(token);
      return withFileLock(storage.lockPath, async () => {
        const { path, record } = await readMatchingExecutionCapability(storage, digest, expected);
        validateAvailableExecutionCapability(record, reservationId);
        if (record.executionReservationId !== reservationId
          || record.executionReservationWorkerLeaseId !== undefined
            && record.executionReservationWorkerLeaseId !== workerLeaseId) throw invalidAuthorizationRecord('execution capability reservation');
        const consumed = { ...record, consumedAt: new Date().toISOString(),
          ...(workerLeaseId === undefined ? {} : {
            executionCommittedReservationId: reservationId,
            executionCommittedWorkerLeaseId: workerLeaseId,
          }) };
        delete consumed.executionReservationId; delete consumed.executionReservationWorkerLeaseId;
        await atomicWriteJson(path, consumed); return publicRecord(consumed);
      });
    },

    /** Release one failed pre-claim reservation without consuming the capability.
     * @param {string} token @param {ExecutionCapabilityExpected} expected @param {string} reservationId @param {string} [workerLeaseId] */
    async releaseExecutionCapability(token, expected, reservationId, workerLeaseId) {
      validateExecutionInput(expected, false); validateToken(token);
      if (!isDigest(reservationId) || workerLeaseId !== undefined && !isDigest(workerLeaseId)) throw invalidIdentityInput();
      const storage = await identityStorage(dataRoot, expected.workspace); const digest = tokenDigest(token);
      return withFileLock(storage.lockPath, async () => {
        const { path, record } = await readMatchingExecutionCapability(storage, digest, expected);
        if (record.consumedAt !== null || (record.revokedAt ?? null) !== null) return;
        if (record.executionReservationId !== reservationId) return;
        if (record.executionReservationWorkerLeaseId !== undefined
          && record.executionReservationWorkerLeaseId !== workerLeaseId) throw invalidAuthorizationRecord('execution capability reservation');
        const released = { ...record }; delete released.executionReservationId; delete released.executionReservationWorkerLeaseId;
        await atomicWriteJson(path, released);
      });
    },

    /** Release an orphaned reservation from one exact private terminal State proof, without its bearer token.
     * A null lease proves pre-reservation terminalization and may clear only an actually unreserved capability.
     * @param {{capabilityDigest:string,reservationId:string,workerLeaseId:string|null,jobId:string,ownerSessionId:string,workspace:string,operation:'run-reserved-job',jobSpecFormat:'sealed-v2'|'legacy-v1',specDigest?:string,terminalStatus:'succeeded'|'failed'|'cancelled'}} proof */
    async releaseExecutionReservation(proof) {
      validateExecutionReservationProof(proof);
      const storage = await identityStorage(dataRoot, proof.workspace);
      return withFileLock(storage.lockPath, async () => {
        const expected = { jobId: proof.jobId, ownerSessionId: proof.ownerSessionId, workspace: proof.workspace,
          operation: proof.operation, ...(proof.jobSpecFormat === 'sealed-v2'
            ? { jobSpecFormat: proof.jobSpecFormat } : { specDigest: proof.specDigest }) };
        const { path, record } = await readMatchingExecutionCapability(storage, proof.capabilityDigest, expected);
        if (record.consumedAt !== null) {
          if (record.executionCommittedReservationId !== proof.reservationId
            || record.executionCommittedWorkerLeaseId !== proof.workerLeaseId) {
            throw invalidAuthorizationRecord('execution capability terminal proof');
          }
          return;
        }
        if ((record.revokedAt ?? null) !== null) return;
        if (proof.workerLeaseId === null) {
          if (record.executionReservationId !== undefined) throw invalidAuthorizationRecord('execution capability reservation');
          return;
        }
        if (record.executionReservationId === undefined) return;
        if (record.executionReservationId !== proof.reservationId
          || record.executionReservationWorkerLeaseId !== proof.workerLeaseId) {
          throw invalidAuthorizationRecord('execution capability reservation');
        }
        const released = { ...record }; delete released.executionReservationId; delete released.executionReservationWorkerLeaseId;
        await atomicWriteJson(path, released);
      });
    },

    /** @param {string} token @param {ExecutionCapabilityExpected} expected */
    async consumeExecutionCapability(token, expected) {
      validateExecutionInput(expected, false);
      validateToken(token);
      const storage = await identityStorage(dataRoot, expected.workspace);
      const digest = tokenDigest(token);
      return withFileLock(storage.lockPath, async () => {
        const path = join(storage.capabilitiesDirectory, `${digest}.json`);
        const record = await readAuthorizationRecord(
          path,
          'EXECUTION_CAPABILITY_INVALID',
          'Execution capability is invalid for this workspace.',
        );
        if (!isExecutionRecord(record)) throw invalidAuthorizationRecord('execution capability');
        if (!safeEqual(record.digest, digest) || record.workspace !== storage.workspacePath) {
          throw authorizationError(
            'EXECUTION_CAPABILITY_INVALID',
            'Execution capability is invalid for this workspace.',
          );
        }
        /** @type {(keyof ExecutionCapabilityExpected)[]} */
        const identityFields = ['jobId', 'ownerSessionId', 'operation'];
        if (expected.jobSpecFormat !== undefined) identityFields.push('jobSpecFormat');
        if (expected.specDigest !== undefined) identityFields.push('specDigest');
        for (const field of identityFields) {
          if (!safeEqual(record[field], expected[field])) {
            throw authorizationError(
              'EXECUTION_CAPABILITY_MISMATCH',
              `Execution capability does not match ${field}.`,
            );
          }
        }
        if (record.consumedAt !== null) {
          throw authorizationError(
            'EXECUTION_CAPABILITY_CONSUMED',
            'Execution capability has already been consumed.',
            'Create a new child execution capability.',
          );
        }
        if ((record.revokedAt ?? null) !== null) {
          throw authorizationError('EXECUTION_CAPABILITY_REVOKED', 'Execution capability has been revoked.', 'Create a new execution capability.');
        }
        if (record.executionReservationId !== undefined) {
          throw authorizationError('EXECUTION_CAPABILITY_CONSUMED', 'Execution capability is reserved by another execution attempt.',
            'Wait for the owning execution attempt to settle.');
        }
        const consumed = { ...record, consumedAt: new Date().toISOString() };
        await atomicWriteJson(path, consumed);
        return publicRecord(consumed);
      });
    },

    /** @param {string} token @param {ExecutionCapabilityExpected} expected */
    async revokeExecutionCapability(token, expected) {
      validateExecutionInput(expected, false);
      validateToken(token);
      const storage = await identityStorage(dataRoot, expected.workspace);
      const digest = tokenDigest(token);
      return withFileLock(storage.lockPath, async () => {
        const path = join(storage.capabilitiesDirectory, `${digest}.json`);
        const record = await readAuthorizationRecord(path, 'EXECUTION_CAPABILITY_INVALID', 'Execution capability is invalid for this workspace.');
        if (!isExecutionRecord(record) || !safeEqual(record.digest, digest) || record.workspace !== storage.workspacePath) {
          throw authorizationError('EXECUTION_CAPABILITY_INVALID', 'Execution capability is invalid for this workspace.');
        }
        /** @type {(keyof ExecutionCapabilityExpected)[]} */
        const fields = ['jobId', 'ownerSessionId', 'operation'];
        if (expected.jobSpecFormat !== undefined) fields.push('jobSpecFormat');
        if (expected.specDigest !== undefined) fields.push('specDigest');
        for (const field of fields) {
          if (!safeEqual(record[field], expected[field])) throw authorizationError('EXECUTION_CAPABILITY_MISMATCH', `Execution capability does not match ${field}.`);
        }
        if (record.consumedAt !== null) {
          throw authorizationError('EXECUTION_CAPABILITY_CONSUMED', 'Execution capability has already been consumed.', 'Create a new child execution capability.');
        }
        if (record.executionReservationId !== undefined) {
          throw authorizationError('EXECUTION_CAPABILITY_CONSUMED', 'Execution capability is reserved by an execution attempt.',
            'Wait for the owning execution attempt to settle.');
        }
        if ((record.revokedAt ?? null) !== null) return;
        await atomicWriteJson(path, { ...record, revokedAt: new Date().toISOString() });
      });
    },

    /** @param {GateBaselineIdentity} input */
    async recordGateBaseline(input) {
      validateGateIdentity(input);
      const storage = await identityStorage(dataRoot, input.workspace);
      const key = gateKey(input.sessionId, input.turnId, storage.workspacePath);
      const record = {
        kind: 'baseline',
        key,
        sessionId: input.sessionId,
        turnId: input.turnId,
        workspace: storage.workspacePath,
        ...(input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }),
        ...(input.permissionSnapshot === undefined ? {} : { permissionSnapshot: input.permissionSnapshot }),
        createdAt: new Date().toISOString(),
        consumedAt: null,
      };
      await withFileLock(storage.lockPath, async () => {
        const path = join(storage.gatesDirectory, `${key}.json`);
        if (await authorizationRecordExists(path)) {
          throw new PluginError('GATE_BASELINE_EXISTS', 'Gate baseline already exists for this turn.', {
            category: 'authorization',
            remedy: 'Consume the existing baseline or begin a new turn.',
            details: { sessionId: input.sessionId, turnId: input.turnId },
          });
        }
        await atomicWriteJson(path, record);
      });
      return publicRecord(record);
    },

    /** @param {GateBaselineIdentity} input */
    async consumeGateBaseline(input) {
      validateGateIdentity(input);
      const storage = await identityStorage(dataRoot, input.workspace);
      const key = gateKey(input.sessionId, input.turnId, storage.workspacePath);
      return withFileLock(storage.lockPath, async () => {
        const path = join(storage.gatesDirectory, `${key}.json`);
        const record = await readAuthorizationRecord(
          path,
          'GATE_BASELINE_NOT_FOUND',
          'No gate baseline matches this session, turn, and workspace.',
        );
        if (!isGateRecord(record)) throw invalidAuthorizationRecord('gate baseline');
        if (!safeEqual(record.key, key)
          || !safeEqual(record.sessionId, input.sessionId)
          || !safeEqual(record.turnId, input.turnId)
          || record.workspace !== storage.workspacePath) {
          throw authorizationError(
            'GATE_BASELINE_NOT_FOUND',
            'No gate baseline matches this session, turn, and workspace.',
          );
        }
        if (record.consumedAt !== null) {
          throw authorizationError(
            'GATE_BASELINE_CONSUMED',
            'Gate baseline has already been consumed.',
            'Record a new baseline for a new turn.',
          );
        }
        const consumed = { ...record, consumedAt: new Date().toISOString() };
        await atomicWriteJson(path, consumed);
        return publicRecord(consumed);
      });
    },
  };
}

/** @param {string} dataRoot @param {string} workspace */
async function identityStorage(dataRoot, workspace) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  return identityStorageLayout(storage);
}

/** @param {string} dataRootPath @param {string} workspacePath */
async function identityStorageForCanonical(dataRootPath, workspacePath) {
  const workspaceKey = createHash('sha256').update(workspacePath).digest('hex');
  const directory = join(dataRootPath, 'workspaces', workspaceKey);
  await ensurePrivateDirectory(directory);
  return identityStorageLayout({ dataRootPath, directory, workspaceKey, workspacePath });
}

/** @param {{dataRootPath:string,directory:string,workspaceKey:string,workspacePath:string}} storage */
async function identityStorageLayout(storage) {
  const identityDirectory = join(storage.directory, 'identity');
  const callersDirectory = join(identityDirectory, 'callers');
  const activeTurnsDirectory = join(identityDirectory, 'active-turns');
  const capabilitiesDirectory = join(identityDirectory, 'capabilities');
  const gatesDirectory = join(identityDirectory, 'gates');
  const originIndexesDirectory = join(identityDirectory, 'active-turn-indexes');
  await Promise.all([
    ensurePrivateDirectory(callersDirectory),
    ensurePrivateDirectory(activeTurnsDirectory),
    ensurePrivateDirectory(capabilitiesDirectory),
    ensurePrivateDirectory(gatesDirectory),
    ensurePrivateDirectory(originIndexesDirectory),
  ]);
  return {
    ...storage,
    callersDirectory,
    activeTurnsDirectory,
    capabilitiesDirectory,
    gatesDirectory,
    originIndexesDirectory,
    lockPath: join(identityDirectory, '.lock'),
  };
}

/** @param {string} dataRoot */
async function globalIdentityStorage(dataRoot) {
  const root = resolve(dataRoot);
  await ensurePrivateDirectory(root);
  const dataRootPath = await realpath(root);
  const directory = join(dataRootPath, 'identity-lifecycle');
  const activeTurnsDirectory = join(directory, 'active-turns');
  const sessionsDirectory = join(directory, 'sessions');
  const sessionLocksDirectory = join(directory, 'session-locks');
  await ensurePrivateDirectory(directory);
  await Promise.all([
    ensurePrivateDirectory(activeTurnsDirectory), ensurePrivateDirectory(sessionsDirectory),
    ensurePrivateDirectory(sessionLocksDirectory),
  ]);
  return { dataRootPath, directory, activeTurnsDirectory, sessionsDirectory, sessionLocksDirectory };
}

/** @param {ReturnType<typeof globalIdentityStorage> extends Promise<infer T> ? T : never} storage @param {string} sessionId */
function sessionLockPath(storage, sessionId) {
  // A bounded 256-stripe pool prevents attacker-chosen session IDs from creating unbounded lock paths.
  return join(storage.sessionLocksDirectory, globalIdentityKey(sessionId).slice(0, 2));
}

/** @param {ReturnType<typeof globalIdentityStorage> extends Promise<infer T> ? T : never} storage @param {string} sessionId @param {boolean} validatePaths */
async function readGlobalState(storage, sessionId, validatePaths) {
  const key = globalIdentityKey(sessionId);
  const activePath = join(storage.activeTurnsDirectory, `${key}.json`);
  const sessionPath = join(storage.sessionsDirectory, `${key}.json`);
  const [active, ledger] = await Promise.all([
    readOptionalBounded(storage.directory, activePath, MAX_ACTIVE_TURN_BYTES),
    readOptionalBounded(storage.directory, sessionPath, MAX_SESSION_BYTES),
  ]);
  if (active === null && ledger === null) return null;
  if (ledger === null || !isSessionRecord(ledger) || !safeEqual(ledger.key, key) || !safeEqual(ledger.sessionId, sessionId)) throw invalidAuthorizationRecord('identity session');
  if (active !== null) {
    if (!isGlobalActiveTurnRecord(active) || !safeEqual(active.key, key) || !safeEqual(active.sessionId, sessionId)) throw invalidAuthorizationRecord('active turn');
    if (validatePaths) {
      await assertPersistedCanonicalWorkspace(active.originWorkspace);
      if (active.executionWorkspace !== null) await assertPersistedCanonicalWorkspace(active.executionWorkspace);
    }
  }
  return { active, ledger, activePath, sessionPath };
}

/** @param {ReturnType<typeof globalIdentityStorage> extends Promise<infer T> ? T : never} storage @param {CallerContextInput & {sessionStartedAt:string,sessionSource:string}} input @param {number} operationTimestamp */
async function readGlobalBeginState(storage, input, operationTimestamp) {
  const key = globalIdentityKey(input.sessionId);
  const activePath = join(storage.activeTurnsDirectory, `${key}.json`);
  const sessionPath = join(storage.sessionsDirectory, `${key}.json`);
  const [active, ledger] = await Promise.all([
    readOptionalBounded(storage.directory, activePath, MAX_ACTIVE_TURN_BYTES),
    readOptionalBounded(storage.directory, sessionPath, MAX_SESSION_BYTES),
  ]);
  if (active === null && ledger === null) return null;
  if (active !== null) {
    if (!isGlobalActiveTurnRecord(active) || active.key !== key || active.sessionId !== input.sessionId) throw invalidAuthorizationRecord('active turn');
  }
  if (ledger !== null) {
    if (!isSessionRecord(ledger) || ledger.key !== key || ledger.sessionId !== input.sessionId) throw invalidAuthorizationRecord('identity session');
    if (active !== null && !lifecycleRecordsConsistent(active, ledger)) throw invalidAuthorizationRecord('identity session');
  } else if (!isRecoverableOrphanPending(active, operationTimestamp, strictTimestamp(input.sessionStartedAt))) {
    throw invalidAuthorizationRecord('identity session');
  }
  return { active, ledger, activePath, sessionPath };
}

/** @param {ReturnType<typeof globalIdentityStorage> extends Promise<infer T> ? T : never} storage @param {string} sessionId */
async function readGlobalCleanupState(storage, sessionId) {
  const key = globalIdentityKey(sessionId);
  const activePath = join(storage.activeTurnsDirectory, `${key}.json`);
  const sessionPath = join(storage.sessionsDirectory, `${key}.json`);
  const [active, ledger] = await Promise.all([
    readOptionalBounded(storage.directory, activePath, MAX_ACTIVE_TURN_BYTES),
    readOptionalBounded(storage.directory, sessionPath, MAX_SESSION_BYTES),
  ]);
  if (active === null && ledger === null) return null;
  if (ledger !== null) return readGlobalState(storage, sessionId, false);
  if (!isGlobalActiveTurnRecord(active) || active.key !== key || active.sessionId !== sessionId
    || !isRecoverableOrphanPending(active, Date.now(), undefined)) throw invalidAuthorizationRecord('identity session');
  return { active, ledger: null, activePath, sessionPath };
}

/** @param {string} root @param {string} path @param {number} maximumBytes */
async function readOptionalBounded(root, path, maximumBytes) {
  try { return await readStrictBoundedJson(root, path, maximumBytes); }
  catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') return null;
    if (error instanceof PluginError && error.code === 'JSON_READ_FAILED' && /** @type {any} */ (error.cause)?.code === 'ENOENT') return null;
    throw invalidAuthorizationRecord('identity');
  }
}

/** @param {string} root @param {string} path @param {number} maximumBytes @param {string} kind */
async function readRequiredBoundedIdentity(root, path, maximumBytes, kind) {
  try { return await readStrictBoundedJson(root, path, maximumBytes); }
  catch { throw invalidAuthorizationRecord(kind); }
}

/** @param {string} root @param {string} path @param {number} maximumBytes */
async function readStrictBoundedJson(root, path, maximumBytes) {
  const parsed = await readBoundedJsonFile(root, path, maximumBytes);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maximumBytes) throw invalidAuthorizationRecord('identity');
    const bytes = Buffer.alloc(maximumBytes + 1); let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const source = bytes.subarray(0, offset).toString('utf8');
    if (offset > maximumBytes || hasDuplicateJsonKeys(source)) throw invalidAuthorizationRecord('identity');
    let current;
    try { current = JSON.parse(source); } catch { throw invalidAuthorizationRecord('identity'); }
    if (JSON.stringify(current) !== JSON.stringify(parsed)) throw invalidAuthorizationRecord('identity');
    return current;
  } finally { await handle?.close().catch(() => {}); }
}

/** @param {string} source */
function hasDuplicateJsonKeys(source) {
  let index = 0; let duplicate = false;
  const whitespace = () => { while (/\s/.test(source[index] ?? '')) index += 1; };
  const string = () => {
    const start = index; index += 1;
    while (index < source.length) {
      if (source[index] === '\\') { index += 2; continue; }
      if (source[index] === '"') { index += 1; return JSON.parse(source.slice(start, index)); }
      index += 1;
    }
    throw new Error('unterminated JSON string');
  };
  const value = () => {
    whitespace();
    if (source[index] === '{') {
      index += 1; whitespace(); const keys = new Set();
      if (source[index] === '}') { index += 1; return; }
      while (index < source.length) {
        whitespace(); const key = string();
        if (keys.has(key)) duplicate = true;
        keys.add(key); whitespace();
        if (source[index] !== ':') throw new Error('invalid JSON object');
        index += 1; value(); whitespace();
        if (source[index] === '}') { index += 1; return; }
        if (source[index] !== ',') throw new Error('invalid JSON object');
        index += 1;
      }
      throw new Error('unterminated JSON object');
    }
    if (source[index] === '[') {
      index += 1; whitespace();
      if (source[index] === ']') { index += 1; return; }
      while (index < source.length) {
        value(); whitespace();
        if (source[index] === ']') { index += 1; return; }
        if (source[index] !== ',') throw new Error('invalid JSON array');
        index += 1;
      }
      throw new Error('unterminated JSON array');
    }
    if (source[index] === '"') { string(); return; }
    while (index < source.length && !/[\s,}\]]/.test(source[index])) index += 1;
  };
  try { value(); whitespace(); return duplicate || index !== source.length; }
  catch { return true; }
}

/** @param {string} workspace */
async function canonicalWorkspace(workspace) {
  try { return await realpath(resolve(workspace)); }
  catch { throw workspaceIneligible(); }
}

/** @param {string} workspace */
async function assertPersistedCanonicalWorkspace(workspace) {
  if (await canonicalWorkspace(workspace) !== workspace) throw invalidAuthorizationRecord('identity workspace');
}

/** @param {string} origin @param {string} candidate @param {((workspace:string)=>Promise<string>)|undefined} seam */
async function assertWorkspaceEligible(origin, candidate, seam) {
  if (origin === candidate) return;
  try {
    const [originGit, candidateGit] = await Promise.all([
      gitWorkspaceIdentity(origin, seam), gitWorkspaceIdentity(candidate, seam),
    ]);
    if (originGit.top !== origin || candidateGit.top !== candidate || originGit.common !== candidateGit.common) throw workspaceIneligible();
  } catch { throw workspaceIneligible(); }
}

/** @param {string} workspace @param {((workspace:string)=>Promise<string>)|undefined} seam */
async function gitWorkspaceIdentity(workspace, seam) {
  const output = seam === undefined
    ? (await execFile('git', ['rev-parse', '--path-format=absolute', '--is-inside-work-tree', '--show-toplevel', '--git-common-dir'], {
      cwd: workspace, encoding: 'utf8', maxBuffer: 4096, timeout: 2_000, windowsHide: true, shell: false,
    })).stdout
    : await seam(workspace);
  if (typeof output !== 'string' || Buffer.byteLength(output) > 4096 || output.includes('\0')) throw workspaceIneligible();
  const lines = output.trimEnd().split(/\r?\n/);
  if (lines.length !== 3 || lines[0] !== 'true' || lines[1].length === 0 || lines[2].length === 0) throw workspaceIneligible();
  const [top, common] = await Promise.all([realpath(resolve(workspace, lines[1])), realpath(resolve(workspace, lines[2]))]);
  return { top, common };
}

/** @param {string[]} workspaces @param {string} workspace */
function appendKnownWorkspace(workspaces, workspace) {
  if (workspaces.includes(workspace)) return [...workspaces];
  if (workspaces.length >= 16) throw authorizationError('IDENTITY_WORKSPACE_LEDGER_FULL', 'The identity workspace ledger is full.', 'End the current session before using another workspace.');
  return [...workspaces, workspace];
}

/** @param {any} state @param {string} candidate @param {((point:string)=>Promise<void>|void)|undefined} seam @param {string} privateRoot */
async function persistClaim(state, candidate, seam, privateRoot) {
  const knownWorkspaces = appendKnownWorkspace(state.ledger.knownWorkspaces, candidate);
  const updatedAt = monotonicTimestamp(state.ledger.updatedAt);
  await seam?.('before-claim-ledger-write');
  await atomicWriteJson(state.sessionPath, { ...state.ledger, knownWorkspaces, updatedAt }, { privateRoot });
  await seam?.('after-claim-ledger-write');
  const bound = { ...state.active, executionWorkspace: candidate };
  await seam?.('before-claim-active-write');
  await atomicWriteJson(state.activePath, bound, { privateRoot });
  await seam?.('after-claim-active-write');
  return bound;
}

/** @param {any} storage @param {{sessionId:string,workspace:string,now?:Date|number|string}} expected */
async function resolveLegacyActiveTurn(storage, expected) {
  const key = activeTurnKey(expected.sessionId, storage.workspacePath);
  return withFileLock(storage.lockPath, async () => {
    const record = await readOptionalBounded(storage.directory, join(storage.activeTurnsDirectory, `${key}.json`), MAX_ACTIVE_TURN_BYTES);
    if (record === null) throw authorizationError('ACTIVE_TURN_NOT_FOUND', 'No active turn matches this session and workspace.');
    if (!isActiveTurnRecord(record)) throw invalidAuthorizationRecord('active turn');
    if (!safeEqual(record.key, key) || !safeEqual(record.sessionId, expected.sessionId)
      || record.workspace !== storage.workspacePath) throw authorizationError('ACTIVE_TURN_NOT_FOUND', 'No active turn matches this session and workspace.');
    if (isLegacyActiveTurnRecord(record) && toTimestamp(expected.now) >= Date.parse(record.expiresAt)) {
      throw authorizationError('ACTIVE_TURN_EXPIRED', 'The active turn has expired.', 'Submit a new prompt in this Codex thread.');
    }
    return publicRecord(record);
  });
}

/** @param {any} storage @param {{sessionId:string,turnId:string}} input */
async function endWorkspaceTurn(storage, input) {
  await removeCallerRecords(storage.callersDirectory,
    (current) => current.sessionId === input.sessionId && current.turnId === input.turnId);
  const key = activeTurnKey(input.sessionId, storage.workspacePath); const path = join(storage.activeTurnsDirectory, `${key}.json`);
  const current = await readOptionalBounded(storage.directory, path, MAX_ACTIVE_TURN_BYTES);
  if (current === null) return;
  if (!isActiveTurnRecord(current) || !safeEqual(current.key, key)
    || !safeEqual(current.sessionId, input.sessionId) || current.workspace !== storage.workspacePath) throw invalidAuthorizationRecord('active turn');
  if (current.turnId === input.turnId) await unlink(path);
}

/** @param {any} storage @param {string} sessionId */
async function cleanupWorkspaceSession(storage, sessionId) {
  for (const directory of [storage.callersDirectory, storage.activeTurnsDirectory, storage.gatesDirectory, storage.originIndexesDirectory]) {
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const path = join(directory, name);
      try {
        const record = await readStrictBoundedJson(storage.directory, path, MAX_ACTIVE_TURN_BYTES);
        if (record.sessionId === sessionId) await unlink(path);
      } catch { /* authority was already tombstoned; malformed advisory state stays fail-closed */ }
    }
  }
}

/** @param {any} storage @param {string} digest @param {{now?:Date|number|string}} expected */
async function readCallerContextRecord(storage, digest, expected) {
  const record = await readOptionalBounded(
    storage.directory, join(storage.callersDirectory, `${digest}.json`), MAX_CALLER_RECORD_BYTES,
  );
  if (record === null) throw invalidCallerContext();
  if (!isCallerRecord(record)) throw invalidAuthorizationRecord('caller context');
  if (!safeEqual(record.digest, digest) || record.workspace !== storage.workspacePath) throw invalidCallerContext();
  if (toTimestamp(expected.now) >= Date.parse(record.expiresAt)) {
    throw authorizationError('CALLER_CONTEXT_EXPIRED', 'Caller context has expired.',
      'Create a new caller context for the current turn.');
  }
  return record;
}

/** @param {string} path @param {string} code @param {string} message */
async function readAuthorizationRecord(path, code, message) {
  try {
    return await readJsonFile(path);
  } catch (error) {
    if (error instanceof PluginError && error.code === 'JSON_READ_FAILED'
      && error.cause instanceof Error && 'code' in error.cause && error.cause.code === 'ENOENT') {
      throw new PluginError(code, message, {
        category: 'authorization',
        remedy: 'Use the exact credential issued for this operation.',
        cause: error,
      });
    }
    throw error;
  }
}

/** @param {string} path */
async function authorizationRecordExists(path) {
  try {
    await readJsonFile(path);
    return true;
  } catch (error) {
    if (error instanceof PluginError && error.code === 'JSON_READ_FAILED'
      && error.cause instanceof Error && 'code' in error.cause && error.cause.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/** @param {CallerContextInput} input @param {string} workspacePath @param {number} [timestamp] */
function callerRecord(input, workspacePath, timestamp) {
  const token = createToken(); const digest = tokenDigest(token); const createdAt = timestamp ?? toTimestamp(input.now);
  return { token, digest, record: { digest, sessionId: input.sessionId, turnId: input.turnId, workspace: workspacePath, permissionMode: input.permissionMode, createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(createdAt + CALLER_LIFETIME_MS).toISOString() } };
}

/** @param {any} record @param {string} generationId */
function provedCallerRecord(record, generationId) {
  return { version: 1, kind: 'caller-context', ...record, generationId };
}

/** @param {CallerContextInput} input @param {string} workspacePath @param {number} [timestamp] */
function activeTurnRecord(input, workspacePath, timestamp) {
  const createdAt = timestamp ?? toTimestamp(input.now); const key = activeTurnKey(input.sessionId, workspacePath);
  return { version: 2, kind: 'active-turn', key, sessionId: input.sessionId, turnId: input.turnId, workspace: workspacePath, permissionMode: input.permissionMode, prompt: input.prompt ?? '', createdAt: new Date(createdAt).toISOString() };
}

/** @param {CallerContextInput} input @param {string} originWorkspace @param {string} key @param {string} generationId @param {'pending'|'active'} status @param {number} timestamp */
function globalActiveTurnRecord(input, originWorkspace, key, generationId, status, timestamp) {
  const createdAt = new Date(timestamp).toISOString();
  return { version: 3, kind: 'active-turn', key, sessionId: input.sessionId, generationId, turnId: input.turnId, originWorkspace, executionWorkspace: null, permissionMode: input.permissionMode, prompt: input.prompt ?? '', createdAt, status };
}

/** @param {CallerContextInput} input @param {string} key @param {string[]} knownWorkspaces @param {string} updatedAt */
function sessionRecord(input, key, knownWorkspaces, updatedAt) {
  return { version: 1, kind: 'identity-session', key, sessionId: input.sessionId, sessionStartedAt: input.sessionStartedAt, sessionSource: input.sessionSource, knownWorkspaces: [...knownWorkspaces], endedAt: null, updatedAt };
}

/** @param {any} active @param {string} endedAt */
function orphanSessionTombstone(active, endedAt) {
  return { version: 1, kind: 'identity-session', key: active.key, sessionId: active.sessionId,
    sessionStartedAt: active.createdAt, sessionSource: 'startup', knownWorkspaces: [active.originWorkspace], endedAt, updatedAt: endedAt };
}

/** @param {string} sessionId @param {string} generationId @param {string} originWorkspace */
function originIndexRecord(sessionId, generationId, originWorkspace) {
  const key = activeTurnKey(sessionId, originWorkspace);
  return { version: 1, kind: 'active-turn-index', key, sessionId, generationId, globalKey: globalIdentityKey(sessionId), originWorkspace };
}

/** @param {any} record @param {CallerContextInput} input @param {string} originWorkspace */
function activeAuthorityEqual(record, input, originWorkspace) {
  return record.sessionId === input.sessionId && record.turnId === input.turnId
    && record.originWorkspace === originWorkspace && record.permissionMode === input.permissionMode
    && record.prompt === (input.prompt ?? '');
}

/** @param {any} record @param {number} now @param {number|undefined} sessionStartedAt */
function isRecoverableOrphanPending(record, now, sessionStartedAt) {
  if (record === null || record.status !== 'pending' || record.executionWorkspace !== null) return false;
  const createdAt = Date.parse(record.createdAt);
  return createdAt <= now && (sessionStartedAt === undefined || sessionStartedAt <= now);
}

/** @param {any} active @param {any} ledger */
function lifecycleRecordsConsistent(active, ledger) {
  const activeAt = Date.parse(active.createdAt);
  return ledger.knownWorkspaces.includes(active.originWorkspace)
    && (active.executionWorkspace === null || ledger.knownWorkspaces.includes(active.executionWorkspace))
    && Date.parse(ledger.sessionStartedAt) <= activeAt && activeAt <= Date.parse(ledger.updatedAt)
    && (ledger.endedAt === null || activeAt <= Date.parse(ledger.endedAt));
}

/** @param {any} record */
function replacedTurnMetadata(record) {
  return { turnId: record.turnId, generationId: record.generationId, executionWorkspace: record.executionWorkspace };
}

/** @param {string} sessionId @param {string} workspace */
function activeTurnKey(sessionId, workspace) { return createHash('sha256').update(JSON.stringify([sessionId, workspace])).digest('hex'); }

/** @param {string} sessionId */
function globalIdentityKey(sessionId) { return createHash('sha256').update(JSON.stringify([sessionId])).digest('hex'); }

/** @param {string} directory @param {(record:any)=>boolean} predicate */
async function removeCallerRecords(directory, predicate) {
  for (const name of await readdir(directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue; const path = join(directory, name);
    let record; try { record = await readJsonFile(path); } catch { continue; }
    if (isCallerRecord(record) && predicate(record)) { try { await unlink(path); } catch (error) { if ((/** @type {NodeJS.ErrnoException} */ (error))?.code !== 'ENOENT') throw error; } }
  }
}

function createToken() {
  return randomBytes(32).toString('base64url');
}

/** @param {string} token */
function tokenDigest(token) {
  return createHash('sha256').update(token).digest('hex');
}

/** Read and match one execution record while its identity-store lock is held. @param {any} storage @param {string} digest @param {ExecutionCapabilityExpected} expected */
async function readMatchingExecutionCapability(storage, digest, expected) {
  const path = join(storage.capabilitiesDirectory, `${digest}.json`);
  const record = await readAuthorizationRecord(path, 'EXECUTION_CAPABILITY_INVALID', 'Execution capability is invalid for this workspace.');
  if (!isExecutionRecord(record) || !safeEqual(record.digest, digest) || record.workspace !== storage.workspacePath) {
    throw authorizationError('EXECUTION_CAPABILITY_INVALID', 'Execution capability is invalid for this workspace.');
  }
  /** @type {(keyof ExecutionCapabilityExpected)[]} */
  const fields = ['jobId', 'ownerSessionId', 'operation'];
  if (expected.jobSpecFormat !== undefined) fields.push('jobSpecFormat');
  if (expected.specDigest !== undefined) fields.push('specDigest');
  for (const field of fields) if (!safeEqual(record[field], expected[field])) {
    throw authorizationError('EXECUTION_CAPABILITY_MISMATCH', `Execution capability does not match ${field}.`);
  }
  return { path, record };
}

/** @param {any} record @param {string} reservationId */
function validateAvailableExecutionCapability(record, reservationId) {
  if (record.consumedAt !== null) throw authorizationError('EXECUTION_CAPABILITY_CONSUMED',
    'Execution capability has already been consumed.', 'Create a new child execution capability.');
  if ((record.revokedAt ?? null) !== null) throw authorizationError('EXECUTION_CAPABILITY_REVOKED',
    'Execution capability has been revoked.', 'Create a new execution capability.');
  if (record.executionReservationId !== undefined && record.executionReservationId !== reservationId) {
    throw authorizationError('EXECUTION_CAPABILITY_CONSUMED', 'Execution capability is reserved by another execution attempt.',
      'Wait for the owning execution attempt to settle.');
  }
}

/** @param {string} sessionId @param {string} turnId @param {string} workspace */
function gateKey(sessionId, turnId, workspace) {
  return createHash('sha256')
    .update(JSON.stringify([sessionId, turnId, workspace]))
    .digest('hex');
}

/** @param {unknown} left @param {unknown} right */
function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/** @param {any} input @returns {number} */
function validateCallerInput(input) {
  if (!isPlainObject(input) || !isBoundedString(input.sessionId, MAX_ID_BYTES)
    || !isBoundedString(input.turnId, MAX_ID_BYTES) || !isBoundedString(input.workspace, MAX_PATH_BYTES)
    || !PERMISSION_MODES.includes(input.permissionMode)
    || input.prompt !== undefined && (typeof input.prompt !== 'string' || Buffer.byteLength(input.prompt) > 64 * 1024)) throw invalidIdentityInput();
  const now = toTimestamp(input.now);
  const hasStartedAt = input.sessionStartedAt !== undefined; const hasSource = input.sessionSource !== undefined;
  if (hasStartedAt !== hasSource) throw invalidIdentityInput();
  if (input.lifecycleResult !== undefined && input.lifecycleResult !== true
    || input.lifecycleResult === true && !hasStartedAt) throw invalidIdentityInput();
  if (hasStartedAt) {
    const startedAt = strictTimestamp(input.sessionStartedAt);
    if (!['startup', 'resume', 'clear'].includes(input.sessionSource)
      || startedAt > now || now - startedAt > MAX_SESSION_AGE_MS) throw invalidIdentityInput();
  }
  return now;
}

/** @param {any} input */
function validateActiveExpected(input) {
  if (!isPlainObject(input) || !isBoundedString(input.sessionId, MAX_ID_BYTES) || !isBoundedString(input.workspace, MAX_PATH_BYTES)
    || input.workspaceBinding !== undefined && !['preview', 'claim', 'execution', 'effective'].includes(input.workspaceBinding)) throw invalidIdentityInput();
}

/** @param {any} input */
function validateTurnIdentity(input) {
  if (!isPlainObject(input) || !isBoundedString(input.sessionId, MAX_ID_BYTES)
    || !isBoundedString(input.turnId, MAX_ID_BYTES) || !isBoundedString(input.workspace, MAX_PATH_BYTES)) throw invalidIdentityInput();
}

/** @param {any} input @param {boolean} requireSnapshot */
function validateExecutionInput(input, requireSnapshot) {
  const sealed = isPlainObject(input) && input.jobSpecFormat === 'sealed-v2' && input.specDigest === undefined;
  const historical = isPlainObject(input) && input.jobSpecFormat === undefined && isDigest(input.specDigest);
  if (!isPlainObject(input) || !isNonEmptyString(input.jobId)
    || !isNonEmptyString(input.ownerSessionId) || !isNonEmptyString(input.workspace)
    || !EXECUTION_OPERATIONS.includes(input.operation)
    || input.jobSpecFormat !== undefined && input.jobSpecFormat !== 'sealed-v2'
    || input.specDigest !== undefined && !isDigest(input.specDigest)
    || input.operation === 'run-reserved-job' && (requireSnapshot ? !sealed : !sealed && !historical)
    || requireSnapshot && !isPlainJsonObject(input.permissionSnapshot)) throw invalidIdentityInput();
}

/** @param {any} proof */
function validateExecutionReservationProof(proof) {
  if (!isPlainObject(proof)) throw invalidIdentityInput();
  const keys = Object.keys(proof).sort().join(',');
  const sealed = keys === 'capabilityDigest,jobId,jobSpecFormat,operation,ownerSessionId,reservationId,terminalStatus,workerLeaseId,workspace'
    && proof.jobSpecFormat === 'sealed-v2' && proof.specDigest === undefined;
  const legacy = keys === 'capabilityDigest,jobId,jobSpecFormat,operation,ownerSessionId,reservationId,specDigest,terminalStatus,workerLeaseId,workspace'
    && proof.jobSpecFormat === 'legacy-v1' && isDigest(proof.specDigest);
  if (!sealed && !legacy
    || !isDigest(proof.capabilityDigest) || !isDigest(proof.reservationId)
    || proof.workerLeaseId !== null && !isDigest(proof.workerLeaseId)
    || !isNonEmptyString(proof.jobId) || !isNonEmptyString(proof.ownerSessionId) || !isNonEmptyString(proof.workspace)
    || proof.operation !== 'run-reserved-job'
    || !['succeeded', 'failed', 'cancelled'].includes(proof.terminalStatus)) throw invalidIdentityInput();
}

/** @param {any} input */
function validateGateIdentity(input) {
  if (!isPlainObject(input) || !isNonEmptyString(input.sessionId)
    || !isNonEmptyString(input.turnId) || !isNonEmptyString(input.workspace)
    || input.fingerprint !== undefined && !isDigest(input.fingerprint)
    || input.permissionSnapshot !== undefined && !isPlainJsonObject(input.permissionSnapshot)) {
    throw invalidIdentityInput();
  }
}

/** @param {unknown} token @param {any} expected */
function validateTokenAndWorkspace(token, expected) {
  validateToken(token);
  if (!isPlainObject(expected) || !isNonEmptyString(expected.workspace)) throw invalidIdentityInput();
}

/** @param {unknown} token */
function validateToken(token) {
  if (!isNonEmptyString(token)) throw invalidIdentityInput();
}

function invalidIdentityInput() {
  return new PluginError('IDENTITY_INPUT_INVALID', 'Authorization identity input is invalid.', {
    category: 'authorization',
    remedy: 'Provide all required non-empty identities and a supported mode or operation.',
  });
}

/** @param {number} count */
function setupSessionUnproven(count) {
  return new PluginError('SETUP_SESSION_UNPROVEN', 'Setup could not prove exactly one active Codex session for this workspace.', {
    category: 'authorization', remedy: 'Run $zcode:setup from one active Codex session after its lifecycle hooks have started.', details: { activeTurnCount: count },
  });
}

/** @param {string} kind */
function invalidAuthorizationRecord(kind) {
  return new PluginError('AUTHORIZATION_RECORD_INVALID', `Persisted ${kind} record is invalid.`, {
    category: 'authorization',
    remedy: 'Remove the corrupted authorization record and issue a new credential.',
  });
}

/** @param {any} record */
function hasCallerFields(record) {
  return isPlainObject(record) && isDigest(record.digest) && isNonEmptyString(record.sessionId)
    && isNonEmptyString(record.turnId) && isNonEmptyString(record.workspace)
    && PERMISSION_MODES.includes(record.permissionMode) && isDate(record.createdAt)
    && isDate(record.expiresAt) && Date.parse(record.expiresAt) > Date.parse(record.createdAt);
}

const PROVED_CALLER_KEYS = ['createdAt', 'digest', 'expiresAt', 'generationId', 'kind', 'permissionMode', 'sessionId', 'turnId', 'version', 'workspace'];

/** @param {any} record */
function isProvedCallerRecord(record) {
  return hasCallerFields(record) && hasExactKeys(record, PROVED_CALLER_KEYS)
    && record.version === 1 && record.kind === 'caller-context' && isDigest(record.generationId);
}

/** @param {any} record */
function isCallerRecord(record) {
  return hasCallerFields(record) && (isProvedCallerRecord(record)
    || !('version' in record) && !('kind' in record) && !('generationId' in record));
}

/** @param {any} caller @param {any} active */
function callerMatchesActive(caller, active) {
  return isProvedCallerRecord(caller) && caller.sessionId === active.sessionId
    && caller.turnId === active.turnId && caller.workspace === active.originWorkspace
    && caller.permissionMode === active.permissionMode && caller.generationId === active.generationId;
}

const CURRENT_ACTIVE_TURN_KEYS = ['createdAt', 'key', 'kind', 'permissionMode', 'prompt', 'sessionId', 'turnId', 'version', 'workspace'];
const LEGACY_ACTIVE_TURN_KEYS = ['createdAt', 'expiresAt', 'key', 'permissionMode', 'prompt', 'sessionId', 'turnId', 'workspace'];
const GLOBAL_ACTIVE_TURN_KEYS = ['createdAt', 'executionWorkspace', 'generationId', 'key', 'kind', 'originWorkspace', 'permissionMode', 'prompt', 'sessionId', 'status', 'turnId', 'version'];
const SESSION_KEYS = ['endedAt', 'key', 'kind', 'knownWorkspaces', 'sessionId', 'sessionSource', 'sessionStartedAt', 'updatedAt', 'version'];
const ORIGIN_INDEX_KEYS = ['generationId', 'globalKey', 'key', 'kind', 'originWorkspace', 'sessionId', 'version'];

/** @param {any} record */
function hasActiveTurnFields(record) {
  return isDigest(record.key) && isBoundedString(record.sessionId, MAX_ID_BYTES) && isBoundedString(record.turnId, MAX_ID_BYTES)
    && isBoundedString(record.workspace, MAX_PATH_BYTES) && PERMISSION_MODES.includes(record.permissionMode)
    && typeof record.prompt === 'string' && Buffer.byteLength(record.prompt) <= 64 * 1024
    && isDate(record.createdAt);
}

/** @param {any} record */
function isCurrentActiveTurnRecord(record) {
  return isPlainObject(record) && hasExactKeys(record, CURRENT_ACTIVE_TURN_KEYS)
    && record.version === 2 && record.kind === 'active-turn' && hasActiveTurnFields(record);
}

/** @param {any} record */
function isLegacyActiveTurnRecord(record) {
  return isPlainObject(record) && hasExactKeys(record, LEGACY_ACTIVE_TURN_KEYS)
    && hasActiveTurnFields(record) && isDate(record.expiresAt)
    && Date.parse(record.expiresAt) > Date.parse(record.createdAt);
}

/** @param {any} record */
function isActiveTurnRecord(record) { return isCurrentActiveTurnRecord(record) || isLegacyActiveTurnRecord(record); }

/** @param {any} record */
function isGlobalActiveTurnRecord(record) {
  return isPlainObject(record) && hasExactKeys(record, GLOBAL_ACTIVE_TURN_KEYS)
    && record.version === 3 && record.kind === 'active-turn' && isDigest(record.key)
    && isBoundedString(record.sessionId, MAX_ID_BYTES) && isDigest(record.generationId) && isBoundedString(record.turnId, MAX_ID_BYTES)
    && isCanonicalStoredPath(record.originWorkspace)
    && (record.executionWorkspace === null || isCanonicalStoredPath(record.executionWorkspace))
    && PERMISSION_MODES.includes(record.permissionMode) && typeof record.prompt === 'string'
    && Buffer.byteLength(record.prompt) <= 64 * 1024 && isStrictDate(record.createdAt)
    && ['pending', 'active'].includes(record.status);
}

/** @param {any} record */
function isSessionRecord(record) {
  return isPlainObject(record) && hasExactKeys(record, SESSION_KEYS)
    && record.version === 1 && record.kind === 'identity-session' && isDigest(record.key)
    && isBoundedString(record.sessionId, MAX_ID_BYTES) && isStrictDate(record.sessionStartedAt)
    && ['startup', 'resume', 'clear'].includes(record.sessionSource)
    && Array.isArray(record.knownWorkspaces) && record.knownWorkspaces.length <= 16
    && new Set(record.knownWorkspaces).size === record.knownWorkspaces.length
    && record.knownWorkspaces.every(isCanonicalStoredPath)
    && (record.endedAt === null || isStrictDate(record.endedAt)) && isStrictDate(record.updatedAt)
    && (record.endedAt === null || Date.parse(record.endedAt) >= Date.parse(record.sessionStartedAt))
    && Date.parse(record.updatedAt) >= Date.parse(record.sessionStartedAt);
}

/** @param {any} record */
function isOriginIndexRecord(record) {
  return isPlainObject(record) && hasExactKeys(record, ORIGIN_INDEX_KEYS)
    && record.version === 1 && record.kind === 'active-turn-index' && isDigest(record.key)
    && isBoundedString(record.sessionId, MAX_ID_BYTES) && isDigest(record.generationId)
    && isDigest(record.globalKey) && isCanonicalStoredPath(record.originWorkspace);
}

/** @param {Record<string, any>} record @param {string[]} keys */
function hasExactKeys(record, keys) {
  const actual = Object.keys(record).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

/** @param {any} record */
function isExecutionRecord(record) {
  return isPlainObject(record) && isDigest(record.digest) && isNonEmptyString(record.jobId)
    && isNonEmptyString(record.ownerSessionId) && isNonEmptyString(record.workspace)
    && EXECUTION_OPERATIONS.includes(record.operation) && isPlainJsonObject(record.permissionSnapshot)
    && (!('jobSpecFormat' in record) || record.jobSpecFormat === 'sealed-v2')
    && (!('specDigest' in record) || isDigest(record.specDigest))
    && (!('executionReservationId' in record) || isDigest(record.executionReservationId) && record.consumedAt === null)
    && (!('executionReservationWorkerLeaseId' in record)
      || isDigest(record.executionReservationWorkerLeaseId) && isDigest(record.executionReservationId) && record.consumedAt === null)
    && (('executionCommittedReservationId' in record) === ('executionCommittedWorkerLeaseId' in record))
    && (!('executionCommittedReservationId' in record)
      || isDigest(record.executionCommittedReservationId) && isDigest(record.executionCommittedWorkerLeaseId)
        && record.consumedAt !== null && !('executionReservationId' in record))
    && (record.operation !== 'run-reserved-job' || record.jobSpecFormat === 'sealed-v2' && !('specDigest' in record)
      || !('jobSpecFormat' in record) && isDigest(record.specDigest))
    && isDate(record.createdAt) && (record.consumedAt === null || isDate(record.consumedAt))
    && (!('revokedAt' in record) || record.revokedAt === null || isDate(record.revokedAt));
}

/** @param {any} record */
function isGateRecord(record) {
  return isPlainObject(record) && (record.kind === undefined || record.kind === 'baseline') && isDigest(record.key) && isNonEmptyString(record.sessionId)
    && isNonEmptyString(record.turnId) && isNonEmptyString(record.workspace)
    && (record.fingerprint === undefined || isDigest(record.fingerprint))
    && (record.permissionSnapshot === undefined || isPlainJsonObject(record.permissionSnapshot))
    && isDate(record.createdAt) && (record.consumedAt === null || isDate(record.consumedAt));
}

/** @param {unknown} value */
function isDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

/** @param {unknown} value */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** @param {unknown} value @param {number} maximumBytes */
function isBoundedString(value, maximumBytes) {
  return isNonEmptyString(value) && Buffer.byteLength(/** @type {string} */ (value)) <= maximumBytes;
}

/** @param {unknown} value */
function isCanonicalStoredPath(value) {
  return isBoundedString(value, MAX_PATH_BYTES) && resolve(/** @type {string} */ (value)) === value;
}

/** @param {unknown} value */
function isDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** @param {unknown} value */
function isStrictDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** @param {unknown} value @returns {number} */
function strictTimestamp(value) {
  if (!isStrictDate(value)) throw invalidIdentityInput();
  return Date.parse(/** @type {string} */ (value));
}

/** @param {string} floor */
function monotonicTimestamp(floor) {
  return new Date(Math.max(Date.now(), Date.parse(floor))).toISOString();
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainJsonObject(value) {
  return isPlainObject(value) && isJsonValue(value, new Set());
}

/** @param {unknown} value @param {Set<object>} seen @returns {boolean} */
function isJsonValue(value, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  /** @type {boolean} */
  const valid = Array.isArray(value) ? value.every((item) => isJsonValue(item, seen))
    : isPlainObject(value) && Object.values(value).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

/** @param {Date | number | string | undefined} now */
function toTimestamp(now) {
  const timestamp = now === undefined ? Date.now() : new Date(now).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new PluginError('TIME_INVALID', 'The supplied time is invalid.', {
      category: 'authorization',
      remedy: 'Pass a valid Date, timestamp, or date string.',
    });
  }
  return timestamp;
}

/** @param {Record<string, any>} record */
function publicRecord(record) {
  const visible = { ...record };
  delete visible.digest;
  delete visible.key;
  delete visible.executionReservationId;
  delete visible.executionReservationWorkerLeaseId;
  delete visible.executionCommittedReservationId;
  delete visible.executionCommittedWorkerLeaseId;
  return visible;
}

/** @param {any} record */
function publicCallerRecord(record) {
  if (!isProvedCallerRecord(record)) return publicRecord(record);
  return {
    sessionId: record.sessionId, turnId: record.turnId, workspace: record.workspace,
    permissionMode: record.permissionMode, createdAt: record.createdAt, expiresAt: record.expiresAt,
  };
}

/** @param {any} record @param {string} workspace @param {boolean} bindingMetadata */
function publicActiveTurn(record, workspace, bindingMetadata) {
  const caller = {
    sessionId: record.sessionId, turnId: record.turnId, workspace,
    permissionMode: record.permissionMode, prompt: record.prompt, createdAt: record.createdAt,
  };
  return bindingMetadata ? {
    ...caller, generationId: record.generationId, originWorkspace: record.originWorkspace,
    executionWorkspace: record.executionWorkspace,
  } : { version: 2, kind: 'active-turn', ...caller };
}

/** @param {CallerContextInput} input @returns {input is CallerContextInput & {sessionStartedAt:string,sessionSource:string}} */
function hasSessionProof(input) { return input.sessionStartedAt !== undefined && input.sessionSource !== undefined; }

function workspaceIneligible() {
  return authorizationError('ACTIVE_TURN_WORKSPACE_INELIGIBLE', 'The requested workspace is not eligible for this active turn.');
}

function invalidCallerContext() {
  return authorizationError('CALLER_CONTEXT_INVALID', 'Caller context is invalid for this workspace.');
}

/** @param {string} code @param {string} message @param {string} [remedy] */
function authorizationError(code, message, remedy = 'Use the exact credential issued for this operation.') {
  return new PluginError(code, message, { category: 'authorization', remedy });
}

/**
 * @typedef {object} CallerContextInput
 * @property {string} sessionId
 * @property {string} turnId
 * @property {string} workspace
 * @property {string} permissionMode
 * @property {string} [prompt]
 * @property {Date | number | string} [now]
 * @property {string} [sessionStartedAt]
 * @property {string} [sessionSource]
 * @property {true} [lifecycleResult]
 */

/**
 * @typedef {object} ExecutionCapabilityExpected
 * @property {string} jobId
 * @property {string} ownerSessionId
 * @property {string} workspace
 * @property {string} operation
 * @property {'sealed-v2'} [jobSpecFormat]
 * @property {string} [specDigest]
 */

/**
 * @typedef {ExecutionCapabilityExpected & { permissionSnapshot: unknown }} ExecutionCapabilityInput
 */

/**
 * @typedef {object} GateBaselineIdentity
 * @property {string} sessionId
 * @property {string} turnId
 * @property {string} workspace
 * @property {string} [fingerprint]
 * @property {Record<string, unknown>} [permissionSnapshot]
 */
