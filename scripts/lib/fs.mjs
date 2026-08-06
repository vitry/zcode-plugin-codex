import { randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
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
 * @param {{ pollIntervalMs?: number, timeoutMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withFileLock(lockPath, operation, options = {}) {
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
  await ensurePrivateDirectory(lockPath);
  const lockFilePath = join(lockPath, 'advisory.lock');
  let handle;
  try {
    handle = await open(lockFilePath, 'a+', 0o600);
    await chmod(lockFilePath, 0o600);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    throw wrapError(error, 'LOCK_OPEN_FAILED', `Could not open lock file: ${lockFilePath}`, {
      category: 'storage',
      remedy: 'Check plugin data permissions and retry.',
      details: { lockFilePath },
    });
  }

  let acquired = false;
  try {
    while (!acquired) {
      acquired = tryLock(handle.fd);
      if (acquired) break;
      if (Date.now() - startedAt >= settings.timeoutMs) {
        throw new PluginError('LOCK_TIMEOUT', `Timed out acquiring lock: ${lockPath}`, {
          category: 'storage',
          remedy: 'Retry after the active plugin operation completes.',
          details: { lockPath, timeoutMs: settings.timeoutMs },
        });
      }
      await delay(settings.pollIntervalMs);
    }
  } catch (error) {
    await handle.close().catch(() => {});
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
    result = await operation();
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

/** @param {number} milliseconds */
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** @param {unknown} error @param {string} code */
function isNodeError(error, code) {
  return error instanceof Error && 'code' in error && error.code === code;
}
