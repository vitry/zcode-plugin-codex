import { randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { PluginError, wrapError } from './errors.mjs';

const DEFAULT_LOCK_OPTIONS = Object.freeze({
  heartbeatIntervalMs: 10_000,
  pollIntervalMs: 20,
  staleAfterMs: 30_000,
  timeoutMs: 5_000,
});

/** @param {string} path */
export async function ensurePrivateDirectory(path) {
  try {
    await mkdir(path, { mode: 0o700, recursive: true });
    await chmod(path, 0o700);
  } catch (error) {
    throw wrapError(error, 'DIRECTORY_CREATE_FAILED', `Could not create private directory: ${path}`, {
      category: 'storage',
      remedy: 'Check that the plugin data root exists and is writable.',
      details: { path },
    });
  }
}

/**
 * @param {string} path
 * @param {unknown} value
 */
export async function atomicWriteJson(path, value) {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`,
  );
  let handle;
  try {
    await ensurePrivateDirectory(directory);
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw wrapError(error, 'ATOMIC_WRITE_FAILED', `Could not atomically write JSON: ${path}`, {
      category: 'storage',
      remedy: 'Check available disk space and permissions, then retry.',
      details: { path },
    });
  }
}

/**
 * @param {string} path
 * @returns {Promise<any>}
 */
export async function readJsonFile(path) {
  let contents;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    throw wrapError(error, 'JSON_READ_FAILED', `Could not read JSON: ${path}`, {
      category: 'storage',
      remedy: 'Check that the persisted record exists and is readable.',
      details: { path },
    });
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw wrapError(error, 'JSON_PARSE_FAILED', `Persisted JSON is invalid: ${path}`, {
      category: 'storage',
      remedy: 'Restore or remove the corrupted persisted record.',
      details: { path },
    });
  }
}

/**
 * @template T
 * @param {string} lockPath
 * @param {() => Promise<T>} operation
 * @param {{ heartbeatIntervalMs?: number, pollIntervalMs?: number, staleAfterMs?: number, timeoutMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withFileLock(lockPath, operation, options = {}) {
  const settings = { ...DEFAULT_LOCK_OPTIONS, ...options };
  const startedAt = Date.now();
  const owner = {
    nonce: randomBytes(32).toString('hex'),
    pid: process.pid,
    hostname: hostname(),
    heartbeatAt: new Date().toISOString(),
  };
  await ensurePrivateDirectory(dirname(lockPath));

  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await atomicWriteJson(join(lockPath, 'owner.json'), owner);
      break;
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) {
        throw wrapError(error, 'LOCK_ACQUIRE_FAILED', `Could not acquire lock: ${lockPath}`, {
          category: 'storage',
          remedy: 'Check plugin data permissions and retry.',
          details: { lockPath },
        });
      }
      await recoverStaleLock(lockPath, settings.staleAfterMs);
      if (Date.now() - startedAt >= settings.timeoutMs) {
        throw new PluginError('LOCK_TIMEOUT', `Timed out acquiring lock: ${lockPath}`, {
          category: 'storage',
          remedy: 'Retry after the active plugin operation completes.',
          details: { lockPath, timeoutMs: settings.timeoutMs },
        });
      }
      await delay(settings.pollIntervalMs);
    }
  }

  let heartbeatError;
  let heartbeatWork = Promise.resolve();
  const heartbeat = setInterval(() => {
    heartbeatWork = heartbeatWork
      .then(() => refreshLockHeartbeat(lockPath, owner))
      .catch((error) => {
        heartbeatError = error;
      });
  }, settings.heartbeatIntervalMs);
  heartbeat.unref();

  /** @type {T | undefined} */
  let result;
  let operationError;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  clearInterval(heartbeat);
  await heartbeatWork;
  try {
    await releaseOwnedLock(lockPath, owner);
  } catch (error) {
    throw wrapError(error, 'LOCK_RELEASE_FAILED', `Could not release lock: ${lockPath}`, {
      category: 'storage',
      remedy: 'Allow the current lock owner to finish or recover the stale lock.',
      details: { lockPath, ownerNonce: owner.nonce },
    });
  }
  if (heartbeatError !== undefined) throw heartbeatError;
  if (operationError !== undefined) throw operationError;
  return /** @type {T} */ (result);
}

/** @param {string} directory */
async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!isNodeError(error, 'EINVAL') && !isNodeError(error, 'ENOTSUP')) throw error;
  } finally {
    if (handle) await handle.close();
  }
}

/** @param {string} lockPath @param {number} staleAfterMs */
async function recoverStaleLock(lockPath, staleAfterMs) {
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw wrapError(error, 'LOCK_INSPECT_FAILED', `Could not inspect lock: ${lockPath}`, {
      category: 'storage',
      remedy: 'Check plugin data permissions and retry.',
      details: { lockPath },
    });
  }

  let owner;
  try {
    owner = await readJsonFile(join(lockPath, 'owner.json'));
  } catch {
    if (Date.now() - lockStat.mtimeMs <= staleAfterMs) return;
    await quarantineStaleLock(lockPath, { stat: lockStat });
    return;
  }

  if (!isLockOwner(owner)) {
    if (Date.now() - lockStat.mtimeMs <= staleAfterMs) return;
    await quarantineStaleLock(lockPath, { stat: lockStat });
    return;
  }
  const heartbeatAt = Date.parse(owner.heartbeatAt);
  if (!Number.isFinite(heartbeatAt)) {
    if (Date.now() - lockStat.mtimeMs <= staleAfterMs) return;
    await quarantineStaleLock(lockPath, { stat: lockStat });
    return;
  }
  if (Date.now() - heartbeatAt <= staleAfterMs) return;
  if (owner.hostname === hostname() && isProcessAlive(owner.pid)) return;
  await quarantineStaleLock(lockPath, { nonce: owner.nonce });
}

/** @param {string} lockPath @param {LockOwner} owner */
async function refreshLockHeartbeat(lockPath, owner) {
  const persistedOwner = await readLockOwner(lockPath);
  if (persistedOwner.nonce !== owner.nonce) {
    throw lockOwnershipError(lockPath, owner.nonce);
  }
  owner.heartbeatAt = new Date().toISOString();
  await atomicWriteJson(join(lockPath, 'owner.json'), owner);
}

/** @param {string} lockPath @param {LockOwner} owner */
async function releaseOwnedLock(lockPath, owner) {
  const persistedOwner = await readLockOwner(lockPath);
  if (persistedOwner.nonce !== owner.nonce) {
    throw lockOwnershipError(lockPath, owner.nonce);
  }

  const releasedPath = `${lockPath}.released.${owner.nonce}`;
  try {
    await rename(lockPath, releasedPath);
  } catch (error) {
    throw wrapError(error, 'LOCK_OWNERSHIP_LOST', 'Lock ownership changed before release.', {
      category: 'storage',
      remedy: 'Do not remove a lock now owned by another process.',
      details: { lockPath, ownerNonce: owner.nonce },
    });
  }
  const releasedOwner = await readLockOwner(releasedPath);
  if (releasedOwner.nonce !== owner.nonce) {
    throw lockOwnershipError(releasedPath, owner.nonce);
  }
  await rm(releasedPath, { recursive: true });
}

/**
 * @param {string} lockPath
 * @param {{ nonce?: string, stat?: import('node:fs').Stats }} expected
 */
async function quarantineStaleLock(lockPath, expected) {
  const recoveryPath = `${lockPath}.recovery.${process.pid}.${randomBytes(12).toString('hex')}`;
  try {
    await rename(lockPath, recoveryPath);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw wrapError(error, 'LOCK_RECOVERY_FAILED', `Could not quarantine stale lock: ${lockPath}`, {
      category: 'storage',
      remedy: 'Retry lock acquisition.',
      details: { lockPath },
    });
  }

  let ownsQuarantine = false;
  if (expected.nonce !== undefined) {
    try {
      const owner = await readLockOwner(recoveryPath);
      ownsQuarantine = owner.nonce === expected.nonce;
    } catch {
      ownsQuarantine = false;
    }
  } else if (expected.stat !== undefined) {
    const recoveryStat = await stat(recoveryPath);
    ownsQuarantine = recoveryStat.dev === expected.stat.dev
      && recoveryStat.ino === expected.stat.ino;
  }

  if (!ownsQuarantine) {
    throw new PluginError('LOCK_RECOVERY_CONFLICT', 'Lock changed ownership during stale recovery.', {
      category: 'storage',
      remedy: 'Retry after the current lock owner finishes.',
      details: { lockPath },
    });
  }
  await rm(recoveryPath, { recursive: true });
}

/** @param {string} lockPath */
async function readLockOwner(lockPath) {
  try {
    const owner = await readJsonFile(join(lockPath, 'owner.json'));
    if (!isLockOwner(owner)) throw new Error('Lock owner record is invalid.');
    return owner;
  } catch (error) {
    throw new PluginError('LOCK_OWNERSHIP_LOST', 'Lock ownership record is missing or invalid.', {
      category: 'storage',
      remedy: 'Do not remove a lock unless its owner nonce still matches.',
      cause: error,
      details: { lockPath },
    });
  }
}

/** @param {unknown} value @returns {value is LockOwner} */
function isLockOwner(value) {
  return typeof value === 'object' && value !== null
    && 'nonce' in value && typeof value.nonce === 'string'
    && 'pid' in value && Number.isInteger(value.pid)
    && 'hostname' in value && typeof value.hostname === 'string'
    && 'heartbeatAt' in value && typeof value.heartbeatAt === 'string';
}

/** @param {number} pid */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, 'ESRCH');
  }
}

/** @param {string} lockPath @param {string} ownerNonce */
function lockOwnershipError(lockPath, ownerNonce) {
  return new PluginError('LOCK_OWNERSHIP_LOST', 'Lock is no longer owned by this operation.', {
    category: 'storage',
    remedy: 'Do not remove a lock now owned by another process.',
    details: { lockPath, ownerNonce },
  });
}

/** @param {number} milliseconds */
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** @param {unknown} error @param {string} code */
function isNodeError(error, code) {
  return error instanceof Error && 'code' in error && error.code === code;
}

/**
 * @typedef {object} LockOwner
 * @property {string} nonce
 * @property {number} pid
 * @property {string} hostname
 * @property {string} heartbeatAt
 */
