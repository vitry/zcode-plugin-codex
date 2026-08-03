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
import { basename, dirname, join } from 'node:path';

import { PluginError, wrapError } from './errors.mjs';

const DEFAULT_LOCK_OPTIONS = Object.freeze({
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
 * @param {{ pollIntervalMs?: number, staleAfterMs?: number, timeoutMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withFileLock(lockPath, operation, options = {}) {
  const settings = { ...DEFAULT_LOCK_OPTIONS, ...options };
  const startedAt = Date.now();
  await ensurePrivateDirectory(dirname(lockPath));

  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
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

  /** @type {T | undefined} */
  let result;
  let operationError;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  try {
    await rm(lockPath, { recursive: true });
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) {
      throw wrapError(error, 'LOCK_RELEASE_FAILED', `Could not release lock: ${lockPath}`, {
        category: 'storage',
        remedy: 'Remove the stale lock directory before retrying.',
        details: { lockPath },
      });
    }
  }
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
  try {
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs > staleAfterMs) {
      await rm(lockPath, { recursive: true });
    }
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) {
      throw wrapError(error, 'LOCK_INSPECT_FAILED', `Could not inspect lock: ${lockPath}`, {
        category: 'storage',
        remedy: 'Check plugin data permissions and retry.',
        details: { lockPath },
      });
    }
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
