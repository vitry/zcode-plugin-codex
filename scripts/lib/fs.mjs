import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';

import { PluginError, wrapError } from './errors.mjs';

const require = createRequire(import.meta.url);
const { tryLock, unlock, swap } = /** @type {{ tryLock(fd: number): boolean, unlock(fd: number): void, swap(from: string, to: string): Promise<void> }} */ (
  require('fs-native-extensions')
);

const DEFAULT_LOCK_OPTIONS = Object.freeze({
  pollIntervalMs: 20,
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
 * @param {{signal?:AbortSignal}} [options]
 */
export async function atomicWriteJson(path, value, options = {}) {
  await atomicWritePrivateFile(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

/**
 * @param {string} path
 * @param {string|Buffer} bytes
 * @param {{signal?:AbortSignal}} [options]
 */
export async function atomicWritePrivateFile(path, bytes, options = {}) {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`,
  );
  let handle;
  try {
    options.signal?.throwIfAborted();
    await ensurePrivateDirectory(directory);
    options.signal?.throwIfAborted();
    handle = await open(temporaryPath, 'wx', 0o600);
    options.signal?.throwIfAborted();
    await handle.writeFile(bytes, { signal: options.signal });
    options.signal?.throwIfAborted();
    await handle.sync();
    options.signal?.throwIfAborted();
    await handle.close();
    handle = undefined;
    options.signal?.throwIfAborted();
    try {
      await rename(temporaryPath, path);
    } catch (error) {
      // Node's Windows rename cannot replace an existing destination.  The
      // native swap helper uses MoveFileEx(REPLACE_EXISTING) on Windows and
      // keeps the replacement operation within the filesystem primitive
      // instead of opening an unlink/rename window.  The old destination is
      // left at temporaryPath and is removed after the swap.
      if (process.platform !== 'win32' || /** @type {NodeJS.ErrnoException} */ (error)?.code !== 'EPERM') throw error;
      await swap(temporaryPath, path);
      await unlink(temporaryPath);
    }
    options.signal?.throwIfAborted();
    await chmod(path, 0o600);
    options.signal?.throwIfAborted();
    await syncDirectory(directory);
    options.signal?.throwIfAborted();
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    if (options.signal?.aborted) throw options.signal.reason;
    throw wrapError(error, 'ATOMIC_WRITE_FAILED', `Could not atomically write file: ${path}`, {
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
 * @param {{ pollIntervalMs?: number, timeoutMs?: number, beforeLockOpen?: () => Promise<void>, signal?:AbortSignal }} [options]
 * @returns {Promise<T>}
 */
export async function withFileLock(lockPath, operation, options = {}) {
  options.signal?.throwIfAborted();
  const settings = { ...DEFAULT_LOCK_OPTIONS, ...options };
  if (
    !Number.isSafeInteger(settings.timeoutMs) || settings.timeoutMs < 0
    || !Number.isSafeInteger(settings.pollIntervalMs) || settings.pollIntervalMs <= 0
  ) {
    throw new PluginError('LOCK_OPTIONS_INVALID', 'Lock timing options must be safe integer milliseconds.', {
      category: 'storage',
      remedy: 'Use timeoutMs >= 0 and pollIntervalMs > 0.',
      details: { pollIntervalMs: settings.pollIntervalMs, timeoutMs: settings.timeoutMs },
    });
  }
  const startedAt = Date.now();
  await ensureLockLayout(lockPath);
  options.signal?.throwIfAborted();
  const lockFilePath = join(lockPath, 'advisory.lock');
  const lockDirectoryStats = await safeLockStats(lockPath, 'lock directory', 'directory');
  const lockFileStats = await safeLockStats(lockFilePath, 'advisory lock file', 'file');
  let handle;
  let confirmationHandle;
  try {
    handle = await open(lockFilePath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    options.signal?.throwIfAborted();
    const openedStats = await handle.stat();
    await options.beforeLockOpen?.();
    options.signal?.throwIfAborted();
    confirmationHandle = await open(lockFilePath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    const [confirmationStats, currentDirectoryStats, currentFileStats] = await Promise.all([
      confirmationHandle.stat(),
      safeLockStats(lockPath, 'lock directory', 'directory'),
      safeLockStats(lockFilePath, 'advisory lock file', 'file'),
    ]);
    if (!sameIdentity(lockDirectoryStats, currentDirectoryStats)
      || !sameIdentity(lockFileStats, currentFileStats)
      || !sameIdentity(openedStats, confirmationStats)) throw unsafeLockPath(lockFilePath, 'advisory lock file');
    await confirmationHandle.close();
    confirmationHandle = undefined;
    await handle.chmod(0o600);
    options.signal?.throwIfAborted();
  } catch (error) {
    if (confirmationHandle) await confirmationHandle.close().catch(() => {});
    if (handle) await handle.close().catch(() => {});
    if (options.signal?.aborted) throw options.signal.reason;
    throw wrapError(error, 'LOCK_OPEN_FAILED', `Could not open lock file: ${lockFilePath}`, {
      category: 'storage',
      remedy: 'Check plugin data permissions and retry.',
      details: { lockFilePath },
    });
  }

  let acquired = false;
  try {
    while (!acquired) {
      options.signal?.throwIfAborted();
      acquired = tryLock(handle.fd);
      if (acquired) break;
      if (Date.now() - startedAt >= settings.timeoutMs) {
        throw new PluginError('LOCK_TIMEOUT', `Timed out acquiring lock: ${lockPath}`, {
          category: 'storage',
          remedy: 'Retry after the active plugin operation completes.',
          details: { lockPath, timeoutMs: settings.timeoutMs },
        });
      }
      await delay(settings.pollIntervalMs, options.signal);
    }
  } catch (error) {
    await handle.close().catch(() => {});
    if (options.signal?.aborted) throw options.signal.reason;
    if (error instanceof PluginError) throw error;
    throw wrapError(error, 'LOCK_ACQUIRE_FAILED', `Could not acquire lock: ${lockPath}`, {
      category: 'storage',
      remedy: 'Check native lock support for this filesystem and retry.',
      details: { lockPath },
    });
  }

  /** @type {T | undefined} */
  let result;
  let operationError;
  let operationFailed = false;
  try {
    options.signal?.throwIfAborted();
    result = await operation();
    options.signal?.throwIfAborted();
  } catch (error) {
    operationError = error;
    operationFailed = true;
  }

  let releaseError;
  try {
    unlock(handle.fd);
  } catch (error) {
    releaseError = error;
  }
  try {
    await handle.close();
  } catch (error) {
    releaseError ??= error;
  }
  if (releaseError !== undefined) {
    throw new PluginError('LOCK_RELEASE_FAILED', `Could not release lock: ${lockPath}`, {
      category: 'storage',
      remedy: 'Close the process lock file descriptor before retrying.',
      cause: releaseError,
      details: { lockPath },
    });
  }
  if (operationFailed) throw operationError;
  return /** @type {T} */ (result);
}

/** @param {string} lockPath */
async function ensureLockLayout(lockPath) {
  await ensurePrivateDirectory(dirname(lockPath));
  try {
    await safeLockStats(lockPath, 'lock directory', 'directory');
    await safeLockStats(join(lockPath, 'advisory.lock'), 'advisory lock file', 'file');
    return;
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
  const temporaryPath = join(dirname(lockPath), `.${basename(lockPath)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`);
  let handle;
  try {
    await mkdir(temporaryPath, { mode: 0o700 });
    handle = await open(join(temporaryPath, 'advisory.lock'), 'wx', 0o600);
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, lockPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(join(temporaryPath, 'advisory.lock')).catch(() => {});
    await rmdir(temporaryPath).catch(() => {});
    if (!isNodeError(error, 'EEXIST') && !isNodeError(error, 'ENOTEMPTY')) throw error;
  }
  await safeLockStats(lockPath, 'lock directory', 'directory');
  await safeLockStats(join(lockPath, 'advisory.lock'), 'advisory lock file', 'file');
}

/** @param {string} path @param {string} kind @param {'directory'|'file'} type */
async function safeLockStats(path, kind, type) {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || (type === 'directory' ? !stats.isDirectory() : !stats.isFile())) throw unsafeLockPath(path, kind);
  return stats;
}

/** @param {{dev:number|bigint,ino:number|bigint}} left @param {{dev:number|bigint,ino:number|bigint}} right */
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

/** @param {string} path @param {string} kind */
function unsafeLockPath(path, kind) {
  return new PluginError('LOCK_PATH_UNSAFE', `The ${kind} is a symbolic link or has an unsafe type: ${path}`, {
    category: 'storage', remedy: 'Remove the unsafe lock path and retry.', details: { path },
  });
}

/** @param {string} directory */
async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } catch (error) {
    if (!isNodeError(error, 'EINVAL') && !isNodeError(error, 'ENOTSUP') && !isNodeError(error, 'EPERM')) throw error;
  } finally {
    await handle.close();
  }
}

/** @param {number} milliseconds @param {AbortSignal|undefined} signal */
function delay(milliseconds, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(() => resolve(undefined), milliseconds));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(undefined); }, milliseconds);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** @param {unknown} error @param {string} code */
function isNodeError(error, code) {
  return error instanceof Error && 'code' in error && error.code === code;
}
