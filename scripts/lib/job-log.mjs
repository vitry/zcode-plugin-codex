import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { PluginError } from './errors.mjs';
import { ensurePrivateDirectoryWithin } from './fs.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';

export const MAX_JOB_LOG_EVENT_BYTES = 4 * 1024;
export const MAX_JOB_LOG_TITLE_BYTES = 256;
export const MAX_JOB_LOG_BODY_BYTES = 4 * 1024 * 1024;

const JOB_ID_PATTERN = /^[a-f0-9]{64}$/;
const queues = new Map();
let admissions = Promise.resolve();

/** @param {{dataRoot:string,workspace:string,jobId:string}} input */
export async function resolveJobLogFile(input) {
  validateJobId(input?.jobId);
  try {
    const storage = await resolveWorkspaceStorage({ dataRoot: input?.dataRoot, workspace: input?.workspace });
    const root = await secureJobsRoot(storage.directory);
    const logFile = join(root, `${input.jobId}.log`);
    try { await verifyExistingLog(root, logFile); }
    catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    return logFile;
  } catch (error) { throw safeResolveError(error); }
}

/** @param {{dataRoot:string,workspace:string,jobId:string,title:string}} input */
export async function createJobLog(input) {
  validateJobId(input?.jobId);
  const title = normalizedLine(input?.title, MAX_JOB_LOG_TITLE_BYTES);
  return admitCanonical(async () => {
    try {
      const opened = await createOrReopen(input);
      return { key: canonicalQueueKey(opened), target: opened };
    } catch (error) { throw safeCreateError(error); }
  }, async (opened) => {
    try {
      if (opened.created) await appendAt(opened.root, opened.logFile, eventBytes(`Starting ${title}.`), opened.identity);
      return opened.logFile;
    } catch (error) { throw safeCreateError(error); }
  });
}

/** @param {{dataRoot:string,workspace:string,jobId:string,event:string}} input */
export async function appendJobLogEvent(input) {
  validateJobId(input?.jobId);
  const bytes = eventBytes(input?.event);
  return serializeCanonical(input, ({ root, logFile }) => appendAt(root, logFile, bytes))
    .catch((error) => { throw safeAppendError(error); });
}

/** @param {{dataRoot:string,workspace:string,jobId:string,title:string,body:string}} input */
export async function appendJobLogBlock(input) {
  validateJobId(input?.jobId);
  const bytes = blockBytes(input?.title, input?.body);
  return serializeCanonical(input, ({ root, logFile }) => appendAt(root, logFile, bytes))
    .catch((error) => { throw safeAppendError(error); });
}

/** @param {{dataRoot:string,workspace:string,jobId:string}} input */
export async function createJobLogSink(input) {
  let opened;
  try { validateJobId(input?.jobId); opened = await serialize(invocationKey(input), () => createOrReopen(input)); }
  catch { return disabledSink(); }

  let disabled = false;
  let closed = false;
  let tail = Promise.resolve();
  const queueKey = canonicalQueueKey(opened);
  /** @param {()=>Promise<void>} operation */
  const enqueue = (operation) => {
    if (disabled || closed) return Promise.resolve();
    const pending = admitCanonical(async () => ({ key: queueKey, target: opened }), async () => {
      if (disabled || closed) return;
      try { await operation(); } catch { disabled = true; }
    });
    tail = pending.catch(() => {});
    return pending;
  };
  /** @param {unknown} event */
  const appendEvent = (event) => enqueue(() => appendAt(opened.root, opened.logFile, eventBytes(event), opened.identity));
  /** @param {unknown} title @param {unknown} body */
  const appendBlock = (title, body) => enqueue(() => appendAt(opened.root, opened.logFile, blockBytes(title, body), opened.identity));
  const flush = async () => { await tail; };
  const close = async () => { await flush(); closed = true; };
  return { logFile: opened.logFile, appendEvent, appendBlock, flush, close, get disabled() { return disabled; } };
}

/** @param {{dataRoot:string,workspace:string,jobId:string}} input */
async function createOrReopen(input) {
  const storage = await resolveWorkspaceStorage({ dataRoot: input.dataRoot, workspace: input.workspace });
  const root = await secureJobsRoot(storage.directory);
  const logFile = join(root, `${input.jobId}.log`);
  let handle;
  try {
    handle = await open(logFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    const verified = await verifyExistingLog(root, logFile);
    return { root, logFile, identity: verified.identity, created: false };
  }

  let identity;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw pathError();
    identity = fileIdentity(before);
    await handle.chmod(0o600);
    await handle.sync();
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(before, after)) throw pathError();
    identity = fileIdentity(after);
  } catch (error) {
    await handle.close().catch(() => {});
    handle = undefined;
    await unlinkIfIdentity(logFile, identity);
    throw error;
  } finally { await handle?.close().catch(() => {}); }

  try {
    const verified = await verifyExistingLog(root, logFile, identity);
    await syncDirectory(root);
    return { root, logFile, identity: verified.identity, created: true };
  } catch (error) {
    await unlinkIfIdentity(logFile, identity);
    throw error;
  }
}

/** @param {{dataRoot:string,workspace:string,jobId:string}} input */
async function existingLog(input) {
  const storage = await resolveWorkspaceStorage({ dataRoot: input.dataRoot, workspace: input.workspace });
  const root = await secureJobsRoot(storage.directory);
  const logFile = join(root, `${input.jobId}.log`);
  const verified = await verifyExistingLog(root, logFile);
  return { root, logFile, identity: verified.identity };
}

/** @param {string} storageDirectory */
async function secureJobsRoot(storageDirectory) {
  try {
    const storageRoot = await realpath(resolve(storageDirectory));
    const lexicalRoot = join(storageDirectory, 'jobs');
    await ensurePrivateDirectoryWithin(storageRoot, lexicalRoot);
    const info = await lstat(lexicalRoot, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory()) throw pathError();
    const root = await realpath(lexicalRoot);
    if (root !== lexicalRoot || await realpath(dirname(root)) !== storageRoot) throw pathError();
    return root;
  } catch { throw pathError(); }
}

/** @param {string} root @param {string} logFile @param {{dev:bigint,ino:bigint}|undefined} [expected] */
async function verifyExistingLog(root, logFile, expected) {
  const lexical = await lstat(logFile, { bigint: true });
  if (lexical.isSymbolicLink() || !lexical.isFile() || await realpath(dirname(logFile)) !== root) throw pathError();
  if (!privateOwnerMode(lexical)) throw pathError();
  let handle;
  let confirmation;
  try {
    handle = await open(logFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    confirmation = await open(logFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const current = await confirmation.stat({ bigint: true });
    const after = await handle.stat({ bigint: true });
    if (!before.isFile() || !privateOwnerMode(before) || !privateOwnerMode(current) || !privateOwnerMode(after)
      || !sameIdentity(before, current) || !sameIdentity(before, after)
      || expected && !sameIdentity(before, expected)) throw pathError();
    return { identity: fileIdentity(before) };
  } finally {
    await confirmation?.close().catch(() => {});
    await handle?.close().catch(() => {});
  }
}

/** @param {string} root @param {string} logFile @param {Buffer} bytes @param {{dev:bigint,ino:bigint}|undefined} [expected] */
async function appendAt(root, logFile, bytes, expected) {
  const lexical = await lstat(logFile, { bigint: true });
  if (lexical.isSymbolicLink() || !lexical.isFile() || await realpath(dirname(logFile)) !== root) throw pathError();
  if (!privateOwnerMode(lexical)) throw pathError();
  let handle;
  let confirmation;
  try {
    handle = await open(logFile, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    confirmation = await open(logFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const current = await confirmation.stat({ bigint: true });
    const stable = await handle.stat({ bigint: true });
    const currentLexical = await lstat(logFile, { bigint: true });
    if (!before.isFile() || !privateOwnerMode(before) || !privateOwnerMode(current) || !privateOwnerMode(stable)
      || currentLexical.isSymbolicLink() || !currentLexical.isFile() || await realpath(dirname(logFile)) !== root
      || !sameIdentity(before, current) || !sameIdentity(before, stable)
      || expected && !sameIdentity(before, expected)) throw pathError();
    await confirmation.close(); confirmation = undefined;
    await handle.write(bytes);
    await handle.sync();
    const after = await handle.stat({ bigint: true });
    confirmation = await open(logFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const pathAfter = await confirmation.stat({ bigint: true });
    if (!sameIdentity(before, after) || !sameIdentity(before, pathAfter)) throw pathError();
  } finally {
    await confirmation?.close().catch(() => {});
    await handle?.close().catch(() => {});
  }
}

/** @param {unknown} event */
function eventBytes(event) {
  const normalized = normalizedLine(event, MAX_JOB_LOG_EVENT_BYTES);
  return Buffer.from(`[${new Date().toISOString()}] ${normalized}\n`, 'utf8');
}

/** @param {unknown} title @param {unknown} body */
function blockBytes(title, body) {
  const normalizedTitle = normalizedLine(title, MAX_JOB_LOG_TITLE_BYTES);
  if (typeof body !== 'string' || !body || Buffer.byteLength(body, 'utf8') > MAX_JOB_LOG_BODY_BYTES) throw contentError();
  return Buffer.concat([
    Buffer.from(`\n[${new Date().toISOString()}] ${normalizedTitle}\n`, 'utf8'),
    Buffer.from(body, 'utf8'),
    Buffer.from('\n', 'utf8'),
  ]);
}

/** @param {unknown} value @param {number} maximumBytes */
function normalizedLine(value, maximumBytes) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > maximumBytes) throw contentError();
  let normalized = '';
  let separating = false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 32 || code === 127 || code === 0x85 || code === 0x2028 || code === 0x2029) { separating = normalized.length > 0; continue; }
    if (separating) normalized += ' ';
    normalized += character;
    separating = false;
  }
  if (!normalized) throw contentError();
  return normalized;
}

/** @template T @param {string} key @param {()=>Promise<T>} operation @returns {Promise<T>} */
function serialize(key, operation) {
  const predecessor = queues.get(key) ?? Promise.resolve();
  const pending = predecessor.catch(() => {}).then(operation);
  queues.set(key, pending);
  pending.finally(() => { if (queues.get(key) === pending) queues.delete(key); }).catch(() => {});
  return pending;
}

/**
 * Admit append invocations in call order before dispatching them to a queue
 * keyed by the canonical file path and captured file identity. Resolution is
 * ordered, but writes to different job identities may proceed independently.
 * @template T,U
 * @param {()=>Promise<{key:string,target:T}>} resolveTarget
 * @param {(target:T)=>Promise<U>} operation
 * @returns {Promise<U>}
 */
function admitCanonical(resolveTarget, operation) {
  return new Promise((resolveResult, rejectResult) => {
    const admitted = admissions.then(async () => {
      const { key, target } = await resolveTarget();
      serialize(key, () => operation(target)).then(resolveResult, rejectResult);
    });
    admissions = admitted.catch(() => {});
    admitted.catch(rejectResult);
  });
}

/** @template T @param {{dataRoot:string,workspace:string,jobId:string}} input @param {(target:{root:string,logFile:string,identity:{dev:bigint,ino:bigint}})=>Promise<T>} operation */
function serializeCanonical(input, operation) {
  return admitCanonical(async () => {
    const target = await existingLog(input);
    return { key: canonicalQueueKey(target), target };
  }, operation);
}

/** @param {{logFile:string,identity:{dev:bigint,ino:bigint}}} target */
function canonicalQueueKey(target) { return `${target.logFile}\0${target.identity.dev}:${target.identity.ino}`; }

/** @param {{dataRoot?:unknown,workspace?:unknown,jobId?:unknown}} input */
function invocationKey(input) { return `${String(input?.dataRoot)}\0${String(input?.workspace)}\0${String(input?.jobId)}`; }
/** @param {unknown} jobId */
function validateJobId(jobId) { if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) throw idError(); }
/** @param {{dev:bigint,ino:bigint}} info */
function fileIdentity(info) { return { dev: info.dev, ino: info.ino }; }
/** @param {{dev:bigint,ino:bigint}} left @param {{dev:bigint,ino:bigint}} right */
function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }
/** @param {{mode:bigint|number}} info */
function privateOwnerMode(info) { return process.platform === 'win32' || (Number(info.mode) & 0o777) === 0o600; }
/** @param {string} path @param {{dev:bigint,ino:bigint}|undefined} identity */
async function unlinkIfIdentity(path, identity) {
  if (!identity) return;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (sameIdentity(await handle.stat({ bigint: true }), identity)) await unlink(path);
  } catch { /* Cleanup is best-effort and only occurs for the captured identity. */ }
  finally { await handle?.close().catch(() => {}); }
}
/** @param {string} path */
async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes(errorCode(error) ?? '')) throw error; }
  finally { await handle.close(); }
}
function disabledSink() {
  const ignored = async () => {};
  return { logFile: undefined, appendEvent: ignored, appendBlock: ignored, flush: ignored, close: ignored, get disabled() { return true; } };
}
/** @param {unknown} error */
function safeResolveError(error) { return isJobLogError(error) || requiredInputError(error) ? error : new PluginError('JOB_LOG_RESOLVE_FAILED', 'Could not safely resolve the private job log.', { category: 'storage', remedy: 'Inspect the private workspace job store.' }); }
/** @param {unknown} error */
function safeCreateError(error) { return isJobLogError(error) || requiredInputError(error) ? error : new PluginError('JOB_LOG_CREATE_FAILED', 'Could not safely create or reopen the private job log.', { category: 'storage', remedy: 'Inspect the private workspace job store.' }); }
/** @param {unknown} error */
function safeAppendError(error) { return isJobLogError(error) || requiredInputError(error) ? error : new PluginError('JOB_LOG_APPEND_FAILED', 'Could not safely append to the private job log.', { category: 'storage', remedy: 'Inspect the private workspace job store.' }); }
function pathError() { return new PluginError('JOB_LOG_PATH_UNSAFE', 'The private job log path or identity is unsafe.', { category: 'storage', remedy: 'Restore the private workspace jobs directory and job log.' }); }
function idError() { return new PluginError('JOB_LOG_ID_INVALID', 'The job log identity is invalid.', { category: 'state', remedy: 'Use the canonical 64-character lowercase job ID.' }); }
function contentError() { return new PluginError('JOB_LOG_CONTENT_INVALID', 'Job log content is empty, unsafe, or exceeds its bound.', { category: 'storage', remedy: 'Append bounded safe semantic content.' }); }
/** @param {unknown} error */
function isJobLogError(error) { return error instanceof PluginError && error.code.startsWith('JOB_LOG_'); }
/** @param {unknown} error */
function requiredInputError(error) { return error instanceof PluginError && ['DATA_ROOT_REQUIRED', 'WORKSPACE_REQUIRED'].includes(error.code); }
/** @param {unknown} error */
function errorCode(error) { return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined; }
