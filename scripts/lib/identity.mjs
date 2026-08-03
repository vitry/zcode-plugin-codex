import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

import { PluginError } from './errors.mjs';
import { atomicWriteJson, ensurePrivateDirectory, readJsonFile, withFileLock } from './fs.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';

const CALLER_LIFETIME_MS = 30 * 60_000;

/** @param {{ dataRoot: string }} options */
export function createIdentityStore({ dataRoot }) {
  if (typeof dataRoot !== 'string' || dataRoot.length === 0) {
    throw new PluginError('DATA_ROOT_REQUIRED', 'A plugin data root must be provided explicitly.', {
      category: 'configuration',
      remedy: 'Pass the installed plugin data directory as dataRoot.',
    });
  }

  return {
    /** @param {CallerContextInput} input */
    async createCallerContext(input) {
      const storage = await identityStorage(dataRoot, input.workspace);
      const token = createToken();
      const digest = tokenDigest(token);
      const createdAt = toTimestamp(input.now);
      const record = {
        digest,
        sessionId: input.sessionId,
        turnId: input.turnId,
        workspace: storage.workspacePath,
        permissionMode: input.permissionMode,
        createdAt: new Date(createdAt).toISOString(),
        expiresAt: new Date(createdAt + CALLER_LIFETIME_MS).toISOString(),
      };
      await withFileLock(storage.lockPath, () => atomicWriteJson(
        join(storage.callersDirectory, `${digest}.json`),
        record,
      ));
      return token;
    },

    /** @param {string} token @param {{ workspace: string, now?: Date | number | string }} expected */
    async consumeCallerContext(token, expected) {
      const storage = await identityStorage(dataRoot, expected.workspace);
      const digest = tokenDigest(token);
      return withFileLock(storage.lockPath, async () => {
        const record = await readAuthorizationRecord(
          join(storage.callersDirectory, `${digest}.json`),
          'CALLER_CONTEXT_INVALID',
          'Caller context is invalid for this workspace.',
        );
        if (!safeEqual(record.digest, digest) || record.workspace !== storage.workspacePath) {
          throw authorizationError('CALLER_CONTEXT_INVALID', 'Caller context is invalid for this workspace.');
        }
        if (toTimestamp(expected.now) >= Date.parse(record.expiresAt)) {
          throw authorizationError('CALLER_CONTEXT_EXPIRED', 'Caller context has expired.',
            'Create a new caller context for the current turn.');
        }
        return publicRecord(record);
      });
    },

    /** @param {ExecutionCapabilityInput} input */
    async createExecutionCapability(input) {
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
        createdAt: new Date().toISOString(),
        consumedAt: null,
      };
      await withFileLock(storage.lockPath, () => atomicWriteJson(
        join(storage.capabilitiesDirectory, `${digest}.json`),
        record,
      ));
      return token;
    },

    /** @param {string} token @param {ExecutionCapabilityExpected} expected */
    async consumeExecutionCapability(token, expected) {
      const storage = await identityStorage(dataRoot, expected.workspace);
      const digest = tokenDigest(token);
      return withFileLock(storage.lockPath, async () => {
        const path = join(storage.capabilitiesDirectory, `${digest}.json`);
        const record = await readAuthorizationRecord(
          path,
          'EXECUTION_CAPABILITY_INVALID',
          'Execution capability is invalid for this workspace.',
        );
        if (!safeEqual(record.digest, digest) || record.workspace !== storage.workspacePath) {
          throw authorizationError(
            'EXECUTION_CAPABILITY_INVALID',
            'Execution capability is invalid for this workspace.',
          );
        }
        /** @type {(keyof ExecutionCapabilityExpected)[]} */
        const identityFields = ['jobId', 'ownerSessionId', 'operation'];
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
        const consumed = { ...record, consumedAt: new Date().toISOString() };
        await atomicWriteJson(path, consumed);
        return publicRecord(consumed);
      });
    },

    /** @param {GateBaselineIdentity} input */
    async recordGateBaseline(input) {
      const storage = await identityStorage(dataRoot, input.workspace);
      const key = gateKey(input.sessionId, input.turnId, storage.workspacePath);
      const record = {
        key,
        sessionId: input.sessionId,
        turnId: input.turnId,
        workspace: storage.workspacePath,
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
      const storage = await identityStorage(dataRoot, input.workspace);
      const key = gateKey(input.sessionId, input.turnId, storage.workspacePath);
      return withFileLock(storage.lockPath, async () => {
        const path = join(storage.gatesDirectory, `${key}.json`);
        const record = await readAuthorizationRecord(
          path,
          'GATE_BASELINE_NOT_FOUND',
          'No gate baseline matches this session, turn, and workspace.',
        );
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
  const identityDirectory = join(storage.directory, 'identity');
  const callersDirectory = join(identityDirectory, 'callers');
  const capabilitiesDirectory = join(identityDirectory, 'capabilities');
  const gatesDirectory = join(identityDirectory, 'gates');
  await Promise.all([
    ensurePrivateDirectory(callersDirectory),
    ensurePrivateDirectory(capabilitiesDirectory),
    ensurePrivateDirectory(gatesDirectory),
  ]);
  return {
    ...storage,
    callersDirectory,
    capabilitiesDirectory,
    gatesDirectory,
    lockPath: join(identityDirectory, '.lock'),
  };
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

function createToken() {
  return randomBytes(32).toString('base64url');
}

/** @param {string} token */
function tokenDigest(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/** @param {string} sessionId @param {string} turnId @param {string} workspace */
function gateKey(sessionId, turnId, workspace) {
  return createHash('sha256')
    .update(JSON.stringify([sessionId, turnId, workspace]))
    .digest('hex');
}

/** @param {unknown} left @param {unknown} right */
function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
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
  return visible;
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
 * @property {Date | number | string} [now]
 */

/**
 * @typedef {object} ExecutionCapabilityExpected
 * @property {string} jobId
 * @property {string} ownerSessionId
 * @property {string} workspace
 * @property {string} operation
 */

/**
 * @typedef {ExecutionCapabilityExpected & { permissionSnapshot: unknown }} ExecutionCapabilityInput
 */

/**
 * @typedef {object} GateBaselineIdentity
 * @property {string} sessionId
 * @property {string} turnId
 * @property {string} workspace
 */
