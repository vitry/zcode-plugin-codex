import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PluginError, wrapError } from './errors.mjs';
import { atomicWriteJson, withFileLock } from './fs.mjs';

const STATUSES = new Set(['active', 'failed-pending-release', 'failed', 'finalize-pending', 'succeeded']);

/** @param {{directory:string}} storage */
export function createCancelAttemptStore(storage) {
  return {
    /** @param {string} jobId @param {string} ownerSessionId */
    read(jobId, ownerSessionId) { return withAttemptLock(storage, jobId, () => readRecord(storage, jobId, ownerSessionId)); },
    /** @param {string} jobId @param {string} ownerSessionId */
    start(jobId, ownerSessionId) {
      return withAttemptLock(storage, jobId, async () => {
        const current = await readRecord(storage, jobId, ownerSessionId);
        if (current && !['failed', 'succeeded'].includes(current.status)) throw invalidRecord();
        const now = new Date().toISOString(); const record = { jobId, ownerSessionId, attemptId: randomBytes(32).toString('hex'), status: 'active', startedAt: now, updatedAt: now };
        await atomicWriteJson(recordPath(storage, jobId), record); return record;
      });
    },
    /** @param {string} jobId @param {string} ownerSessionId @param {string} attemptId @param {'failed-pending-release'|'failed'|'finalize-pending'|'succeeded'} status @param {string} [message] */
    update(jobId, ownerSessionId, attemptId, status, message) {
      return withAttemptLock(storage, jobId, async () => {
        const current = await readRecord(storage, jobId, ownerSessionId);
        if (!current || current.attemptId !== attemptId) throw invalidRecord();
        if (current.status === status) return current;
        if (!isAllowedTransition(current.status, status)) throw invalidRecord();
        const record = { ...current, status, updatedAt: new Date().toISOString(), ...(status === 'failed-pending-release' || status === 'failed' ? { error: { message: message ?? current.error?.message ?? 'ZCode stop failed' } } : {}) };
        await atomicWriteJson(recordPath(storage, jobId), record); return record;
      });
    },
  };
}

/** @param {{directory:string}} storage @param {string} jobId @param {()=>Promise<any>} operation */
function withAttemptLock(storage, jobId, operation) { return withFileLock(join(storage.directory, 'cancel-attempt-locks', `${jobId}.lock`), operation); }
/** @param {{directory:string}} storage @param {string} jobId */
function recordPath(storage, jobId) { return join(storage.directory, 'cancel-attempts', `${jobId}.json`); }

/** @param {{directory:string}} storage @param {string} jobId @param {string} ownerSessionId */
async function readRecord(storage, jobId, ownerSessionId) {
  let contents;
  try { contents = await readFile(recordPath(storage, jobId), 'utf8'); }
  catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw wrapError(error, 'CANCEL_ATTEMPT_READ_FAILED', 'Could not read the persisted cancellation attempt.', { category: 'storage', remedy: 'Check plugin data permissions and retry.' });
  }
  let record;
  try { record = JSON.parse(contents); } catch (error) { throw invalidRecord(error); }
  if (!isRecord(record) || record.jobId !== jobId || record.ownerSessionId !== ownerSessionId) throw invalidRecord();
  return record;
}

/** @param {any} record */
function isRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const keys = Object.keys(record); const required = ['attemptId', 'jobId', 'ownerSessionId', 'startedAt', 'status', 'updatedAt'];
  if (!required.every((key) => keys.includes(key)) || keys.some((key) => ![...required, 'error'].includes(key))) return false;
  if (typeof record.jobId !== 'string' || !record.jobId || typeof record.ownerSessionId !== 'string' || !record.ownerSessionId || !/^[a-f0-9]{64}$/.test(record.attemptId) || !STATUSES.has(record.status) || !isDate(record.startedAt) || !isDate(record.updatedAt)) return false;
  const needsError = record.status === 'failed-pending-release' || record.status === 'failed';
  return needsError ? isErrorRecord(record.error) : !('error' in record);
}

/** @param {unknown} value */
function isErrorRecord(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && typeof /** @type {any} */ (value).message === 'string' && /** @type {any} */ (value).message.length > 0); }
/** @param {unknown} value */
function isDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
/** @param {string} current @param {string} next */
function isAllowedTransition(current, next) {
  return (current === 'active' && ['failed-pending-release', 'finalize-pending', 'succeeded'].includes(next))
    || (current === 'failed-pending-release' && next === 'failed')
    || (current === 'finalize-pending' && next === 'succeeded');
}
/** @param {unknown} [cause] */
function invalidRecord(cause) { return new PluginError('CANCEL_ATTEMPT_RECORD_INVALID', 'Persisted cancellation attempt failed schema or identity validation.', { category: 'storage', remedy: 'Restore or remove the corrupted cancellation attempt record before retrying.', ...(cause ? { cause } : {}) }); }
/** @param {unknown} error @param {string} code */
function isNodeError(error, code) { return error instanceof Error && 'code' in error && error.code === code; }
