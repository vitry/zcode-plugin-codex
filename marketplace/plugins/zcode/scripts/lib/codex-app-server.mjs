import { spawn as nodeSpawn } from 'node:child_process';
import { posix, win32 } from 'node:path';

import { PluginError } from './errors.mjs';
import { RedactedTail } from './zcode-protocol.mjs';

export const CODEX_APP_SERVER_DEFAULT_TIMEOUT_MS = 15_000;
export const CODEX_THREAD_ID_MAX_BYTES = 512;
const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 8192;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 32;
const DEFAULT_MAX_ITEMS = 1024;
const MAX_CURSOR_BYTES = 4096;
const MAX_AGENT_PATH_BYTES = 1024;
const MAX_CWD_BYTES = 4096;
const MAX_ROLE_BYTES = 256;
const SHUTDOWN_GRACE_MS = 1_000;
const MAX_VALUE_DEPTH = 128;
const MAX_VALUE_NODES = 100_000;
const INITIALIZE_PARAMS = { clientInfo: { name: 'zcode-plugin-codex', title: 'ZCode plugin for Codex', version: '0.1.0' }, capabilities: null };

/** @typedef {{executable?:string,args?:string[],cwd?:string,env?:NodeJS.ProcessEnv,timeoutMs?:number,maxLineBytes?:number,maxOutputBytes?:number,maxStderrBytes?:number,spawn?:(command:string,args:string[],options:any)=>any,pageSize?:number,maxPages?:number,maxItems?:number,signal?:AbortSignal}} AppServerOptions */
/** @typedef {{id:string,parentThreadId:string,agentPath:string,agentRole:string|null,cwd:string,status:Record<string,unknown>,createdAt:number,updatedAt:number}} SpawnChild */

/** @param {string} threadId @param {AppServerOptions} [options] */
export async function readCodexThread(threadId, options = {}) {
  validateInput(threadId, options, true);
  return withAppServer(options, async (request, notify) => {
    notify({ method: 'initialized', params: {} });
    const result = await request('thread/read', { threadId, includeTurns: true });
    if (!Object.hasOwn(result, 'thread')) throw malformed('Codex thread/read response omitted its thread.');
    return result.thread;
  }, true);
}

/** @param {string} parentThreadId @param {AppServerOptions} [options] */
export async function listCodexThreadSpawnChildren(parentThreadId, options = {}) {
  validateInput(parentThreadId, options);
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  if (!boundedPositive(pageSize, 100) || !boundedPositive(maxPages, 32) || !boundedPositive(maxItems, 1024)) throw inputError();
  return withAppServer(options, async (request, notify) => {
    notify({ method: 'initialized', params: {} });
    /** @type {SpawnChild[]} */ const children = [];
    const ids = new Set(); const paths = new Set(); const cursors = new Set();
    /** @type {string|null} */ let cursor = null; let itemCount = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await request('thread/list', { sourceKinds: ['subAgentThreadSpawn'], limit: pageSize, sortKey: 'created_at', sortDirection: 'desc', ...(cursor === null ? {} : { cursor }) });
      if (!safePlainValue(result) || !Array.isArray(result.data) || !Object.hasOwn(result, 'nextCursor') || !Object.hasOwn(result, 'backwardsCursor')
        || result.backwardsCursor !== null && !validBoundedString(result.backwardsCursor, MAX_CURSOR_BYTES)) throw listInvalid();
      itemCount += result.data.length;
      if (itemCount > maxItems) throw listLimit();
      for (const thread of result.data) {
        const child = validateRawThreadSpawnChild(thread);
        if (ids.has(child.id)) throw metadataInvalid();
        ids.add(child.id);
        if (child.parentThreadId !== parentThreadId) continue;
        if (paths.has(child.agentPath)) throw metadataInvalid();
        paths.add(child.agentPath); children.push(child);
      }
      if (result.nextCursor === null) return children;
      if (!validBoundedString(result.nextCursor, MAX_CURSOR_BYTES)) throw listInvalid();
      if (cursors.has(result.nextCursor)) throw new PluginError('CODEX_THREAD_LIST_CURSOR_CYCLE', 'Codex thread pagination repeated a cursor.', { category: 'protocol', remedy: 'Upgrade or restart Codex and retry.' });
      cursors.add(result.nextCursor); cursor = result.nextCursor;
    }
    throw listLimit();
  });
}

/** @param {string} threadId @param {string} parentThreadId @param {AppServerOptions} [options] */
export async function readCodexThreadSpawnChild(threadId, parentThreadId, options = {}) {
  validateInput(threadId, options); validateInput(parentThreadId, options);
  return withAppServer(options, async (request, notify) => {
    notify({ method: 'initialized', params: {} });
    const result = await request('thread/read', { threadId, includeTurns: false });
    if (!Object.hasOwn(result, 'thread')) throw malformed('Codex thread/read response omitted its thread.');
    return validateRawThreadSpawnChild(result.thread, parentThreadId, threadId);
  });
}

/** @template T @param {AppServerOptions} options @param {(request:(method:string,params:Record<string,unknown>)=>Promise<Record<string,any>>,notify:(value:unknown)=>void)=>Promise<T>} work @param {boolean} [rawReadDiagnostics] @returns {Promise<T>} */
async function withAppServer(options, work, rawReadDiagnostics = false) {
  if (options.signal?.aborted) throw interruptionError(options.signal.reason);
  const executable = options.executable ?? 'codex'; const args = options.args ?? ['app-server'];
  const timeoutMs = options.timeoutMs ?? CODEX_APP_SERVER_DEFAULT_TIMEOUT_MS;
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  let child;
  try { child = (options.spawn ?? nodeSpawn)(executable, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false }); }
  catch (cause) { throw spawnError(cause); }
  const stderrTail = new RedactedTail(maxStderrBytes); let stdoutBytes = 0; let lineBuffer = Buffer.alloc(0);
  /** @type {any} */ let fatalError; let nextId = 1;
  /** @type {{id:number,method:string,resolve:(value:Record<string,any>)=>void,reject:(error:any)=>void}|null} */ let pending = null;
  const detail = () => { stderrTail.close(); return { stderrTail: stderrTail.value() }; };
  const fail = (/** @type {any} */ error) => { if (fatalError) return; fatalError = attachDetails(error, detail()); if (pending) { const current = pending; pending = null; current.reject(fatalError); } };
  const onAbort = () => fail(interruptionError(options.signal?.reason));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(() => fail(new PluginError('CODEX_APP_SERVER_TIMEOUT', rawReadDiagnostics
    ? 'Codex app-server timed out while reading the source thread.' : 'Codex app-server timed out.', {
    category: 'timeout', remedy: rawReadDiagnostics
      ? 'Retry after confirming Codex can read the requested thread.' : 'Retry after confirming Codex can serve the requested thread operation.',
  })), timeoutMs);
  const onStderrData = (/** @type {Buffer|string} */ chunk) => stderrTail.append(chunk);
  const onStdoutData = (/** @type {Buffer|string} */ chunk) => {
    try {
      if (fatalError) return;
      const bytes = Buffer.from(chunk); stdoutBytes += bytes.length;
      if (stdoutBytes > maxOutputBytes) return fail(protocolError('CODEX_APP_SERVER_OUTPUT_TOO_LARGE', 'Codex app-server output exceeded its total limit.'));
      lineBuffer = Buffer.concat([lineBuffer, bytes]);
      if (lineBuffer.length > maxLineBytes && lineBuffer.indexOf(10) === -1) return fail(protocolError('CODEX_APP_SERVER_FRAME_TOO_LARGE', 'Codex app-server emitted an oversized frame.'));
      while (!fatalError) {
        const newline = lineBuffer.indexOf(10); if (newline < 0) break;
        let line = lineBuffer.subarray(0, newline); lineBuffer = lineBuffer.subarray(newline + 1);
        if (line.at(-1) === 13) line = line.subarray(0, -1);
        if (line.length === 0) continue;
        if (line.length > maxLineBytes) return fail(protocolError('CODEX_APP_SERVER_FRAME_TOO_LARGE', 'Codex app-server emitted an oversized frame.'));
        let frame;
        try { frame = JSON.parse(line.toString('utf8')); } catch (cause) { return fail(protocolError('CODEX_APP_SERVER_MALFORMED', 'Codex app-server emitted malformed JSON.', cause)); }
        if (!plainObject(frame) || unsafeKeys(frame)) return fail(malformed('Codex app-server emitted an unsafe response.'));
        if (!Object.hasOwn(frame, 'id') || !pending || frame.id !== pending.id) continue;
        if (!safePlainValue(frame) || Object.keys(frame).some((key) => !['id', 'result', 'error'].includes(key)) || Object.hasOwn(frame, 'result') === Object.hasOwn(frame, 'error')) return fail(malformed('Codex app-server returned an ambiguous response.'));
        const current = pending; pending = null;
        if (Object.hasOwn(frame, 'error')) { current.reject(attachDetails(remoteRequestError(current.method), detail())); continue; }
        if (!plainObject(frame.result)) { current.reject(attachDetails(malformed('Codex app-server returned an invalid response.'), detail())); continue; }
        current.resolve(frame.result);
      }
    } catch (cause) { fail(protocolError('CODEX_APP_SERVER_MALFORMED', 'Codex app-server response processing failed safely.', cause)); }
  };
  const onStdoutError = (/** @type {unknown} */ cause) => fail(protocolError('CODEX_APP_SERVER_STREAM_FAILED', 'Codex app-server stdout failed.', cause));
  const onStderrError = (/** @type {unknown} */ cause) => fail(protocolError('CODEX_APP_SERVER_STREAM_FAILED', 'Codex app-server stderr failed.', cause));
  const onStdinError = (/** @type {unknown} */ cause) => fail(protocolError('CODEX_APP_SERVER_WRITE_FAILED', 'Could not write to Codex app-server.', cause));
  const onChildError = (/** @type {unknown} */ cause) => fail(spawnError(cause));
  const onChildExit = (/** @type {number|null} */ code, /** @type {NodeJS.Signals|null} */ signal) => fail(new PluginError('CODEX_APP_SERVER_DISCONNECTED', rawReadDiagnostics
    ? 'Codex app-server exited before returning the source thread.' : 'Codex app-server exited before completing the request.', {
    category: 'runtime', remedy: 'Restart Codex and retry.', details: { code, signal },
  }));
  child.stderr?.on('data', onStderrData); child.stdout?.on('data', onStdoutData);
  child.stdout?.once('error', onStdoutError); child.stderr?.once('error', onStderrError); child.stdin?.once('error', onStdinError);
  child.once('error', onChildError); child.once('exit', onChildExit);
  const request = (/** @type {string} */ method, /** @type {Record<string,unknown>} */ params) => {
    if (fatalError) return Promise.reject(fatalError);
    if (pending) return Promise.reject(malformed('Codex app-server requests must be sequential.'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending = { id, method, resolve, reject };
      try { writeFrame(child, { id, method, params }, maxLineBytes); }
      catch (cause) { pending = null; reject(attachDetails(protocolError('CODEX_APP_SERVER_WRITE_FAILED', method === 'initialize' ? 'Could not initialize Codex app-server.' : 'Could not write to Codex app-server.', cause), detail())); }
    });
  };
  const notify = (/** @type {unknown} */ value) => {
    try { writeFrame(child, value, maxLineBytes); }
    catch (cause) { throw attachDetails(protocolError('CODEX_APP_SERVER_WRITE_FAILED', 'Could not write to Codex app-server.', cause), detail()); }
  };
  try { await request('initialize', INITIALIZE_PARAMS); return await work(request, notify); }
  finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); await terminate(child);
    child.stdout?.off('data', onStdoutData); child.stderr?.off('data', onStderrData);
    child.stdout?.off('error', onStdoutError); child.stderr?.off('error', onStderrError); child.stdin?.off('error', onStdinError);
    child.off('error', onChildError); child.off('exit', onChildExit);
  }
}

/** @param {string} method */
function remoteRequestError(method) {
  if (method === 'initialize') return new PluginError('CODEX_APP_SERVER_INITIALIZE_FAILED', 'Codex app-server initialization failed.', { category: 'protocol', remedy: 'Upgrade or restart Codex and retry.' });
  if (method === 'thread/list') return new PluginError('CODEX_THREAD_LIST_FAILED', 'Codex could not list persisted threads.', { category: 'configuration', remedy: 'Confirm this Codex version supports stable thread listing.' });
  return new PluginError('CODEX_THREAD_READ_FAILED', 'Codex could not read the requested thread.', { category: 'configuration', remedy: 'Confirm the Codex thread ID is persisted and accessible from this Codex home.' });
}

/** Sanitize one raw or already-sanitized Codex thread-spawn child snapshot. @param {unknown} thread @param {string} [expectedParentId] @param {string} [expectedChildId] @returns {SpawnChild} */
export function sanitizeCodexThreadSpawnChild(thread, expectedParentId, expectedChildId) {
  if (isSanitizedSpawnChild(thread)) return validateSanitizedSpawnChild(thread, expectedParentId, expectedChildId);
  return validateRawThreadSpawnChild(thread, expectedParentId, expectedChildId);
}

/** @param {unknown} thread @param {string} [expectedParentId] @param {string} [expectedChildId] @returns {SpawnChild} */
function validateRawThreadSpawnChild(thread, expectedParentId, expectedChildId) {
  if (!plainObject(thread) || !safePlainValue(thread)) throw metadataInvalid();
  const source = thread.source; const subAgent = plainObject(source) ? source.subAgent : null; const spawn = plainObject(subAgent) ? subAgent.thread_spawn : null;
  if (!plainObject(source) || Object.keys(source).length !== 1 || !plainObject(subAgent) || Object.keys(subAgent).length !== 1 || !plainObject(spawn)
    || Object.keys(spawn).some((key) => !['parent_thread_id', 'depth', 'agent_path', 'agent_nickname', 'agent_role'].includes(key))) throw metadataInvalid();
  const id = thread.id; const parentThreadId = thread.parentThreadId; const nestedParentId = spawn.parent_thread_id;
  const role = thread.agentRole; const nestedRole = spawn.agent_role; const agentPath = spawn.agent_path;
  if (!validBoundedString(id, CODEX_THREAD_ID_MAX_BYTES) || !validBoundedString(parentThreadId, CODEX_THREAD_ID_MAX_BYTES) || !validBoundedString(nestedParentId, CODEX_THREAD_ID_MAX_BYTES)
    || parentThreadId !== nestedParentId || expectedChildId !== undefined && id !== expectedChildId || expectedParentId !== undefined && parentThreadId !== expectedParentId
    || !validRole(role) || !validRole(nestedRole) || role !== nestedRole || !canonicalAgentPath(agentPath) || !canonicalCwd(thread.cwd)
    || !Number.isSafeInteger(thread.createdAt) || thread.createdAt < 0 || !Number.isSafeInteger(thread.updatedAt) || thread.updatedAt < 0
    || !Number.isSafeInteger(spawn.depth) || spawn.depth < 1 || spawn.depth > 64) throw metadataInvalid();
  const status = cloneStatus(thread.status);
  return {
    id: /** @type {string} */ (id), parentThreadId: /** @type {string} */ (parentThreadId),
    agentPath: /** @type {string} */ (agentPath), agentRole: /** @type {string|null} */ (role),
    cwd: /** @type {string} */ (thread.cwd), status,
    createdAt: /** @type {number} */ (thread.createdAt), updatedAt: /** @type {number} */ (thread.updatedAt),
  };
}

/** @param {unknown} thread */
function isSanitizedSpawnChild(thread) {
  return plainObject(thread) && Object.keys(thread).sort().join('\0') === ['agentPath', 'agentRole', 'createdAt', 'cwd', 'id', 'parentThreadId', 'status', 'updatedAt'].sort().join('\0');
}

/** @param {unknown} thread @param {string} [expectedParentId] @param {string} [expectedChildId] @returns {SpawnChild} */
function validateSanitizedSpawnChild(thread, expectedParentId, expectedChildId) {
  if (!plainObject(thread) || !safePlainValue(thread)) throw metadataInvalid();
  const child = /** @type {Record<string,any>} */ (thread);
  if (!validBoundedString(child.id, CODEX_THREAD_ID_MAX_BYTES) || !validBoundedString(child.parentThreadId, CODEX_THREAD_ID_MAX_BYTES)
    || expectedChildId !== undefined && child.id !== expectedChildId || expectedParentId !== undefined && child.parentThreadId !== expectedParentId
    || !validRole(child.agentRole) || !canonicalAgentPath(child.agentPath) || !canonicalCwd(child.cwd)
    || !Number.isSafeInteger(child.createdAt) || child.createdAt < 0 || !Number.isSafeInteger(child.updatedAt) || child.updatedAt < 0) throw metadataInvalid();
  return { id: child.id, parentThreadId: child.parentThreadId, agentPath: child.agentPath, agentRole: child.agentRole,
    cwd: child.cwd, status: cloneStatus(child.status), createdAt: child.createdAt, updatedAt: child.updatedAt };
}

/** @param {unknown} value */
function cloneStatus(value) {
  if (!plainObject(value)) throw metadataInvalid();
  if (['notLoaded', 'idle', 'systemError'].includes(value.type) && Object.keys(value).length === 1) return { type: value.type };
  if (value.type === 'active' && Object.keys(value).length === 2 && Array.isArray(value.activeFlags) && new Set(value.activeFlags).size === value.activeFlags.length
    && value.activeFlags.every((flag) => ['waitingOnApproval', 'waitingOnUserInput'].includes(flag))) return { type: 'active', activeFlags: [...value.activeFlags] };
  throw metadataInvalid();
}
/** @param {unknown} value */
function validRole(value) { return value === null || validBoundedString(value, MAX_ROLE_BYTES); }
/** @param {unknown} value */
function canonicalAgentPath(value) { return typeof value === 'string' && validBoundedString(value, MAX_AGENT_PATH_BYTES) && posix.normalize(value) === value && /^\/root\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(value); }
/** @param {unknown} value */
function canonicalCwd(value) { return typeof value === 'string' && validBoundedString(value, MAX_CWD_BYTES) && (posix.isAbsolute(value) && posix.normalize(value) === value || win32.isAbsolute(value) && win32.normalize(value) === value); }

/** @param {any} child @param {unknown} value @param {number} maxBytes */
function writeFrame(child, value, maxBytes) { const frame = `${JSON.stringify(value)}\n`; if (Buffer.byteLength(frame) > maxBytes || !child.stdin?.writable) throw new Error('app-server stdin is unavailable'); child.stdin.write(frame); }
/** @param {any} child */
async function terminate(child) {
  if (!child) return; child.stdin?.end(); if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill('SIGTERM'); } catch { return; }
  if (await waitForExit(child, SHUTDOWN_GRACE_MS)) return;
  if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch { return; } }
  await waitForExit(child, SHUTDOWN_GRACE_MS);
}
/** @param {any} child @param {number} timeoutMs */
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => { let settled = false; const finish = (/** @type {boolean} */ value) => { if (settled) return; settled = true; clearTimeout(timer); child.off('exit', onExit); resolve(value); }; const onExit = () => finish(true); const timer = setTimeout(() => finish(false), timeoutMs); timer.unref?.(); child.once('exit', onExit); });
}

/** @param {string} threadId @param {any} options @param {boolean} [rawReadDiagnostics] */
function validateInput(threadId, options, rawReadDiagnostics = false) {
  const positive = (/** @type {unknown} */ value) => Number.isSafeInteger(value) && /** @type {number} */ (value) > 0;
  if (!validBoundedString(threadId, CODEX_THREAD_ID_MAX_BYTES) || !plainObject(options) || options.executable !== undefined && (typeof options.executable !== 'string' || !options.executable)
    || options.args !== undefined && (!Array.isArray(options.args) || options.args.some((item) => typeof item !== 'string')) || options.spawn !== undefined && typeof options.spawn !== 'function'
    || options.signal !== undefined && !(options.signal instanceof AbortSignal)
    || ['timeoutMs', 'maxLineBytes', 'maxOutputBytes', 'maxStderrBytes'].some((key) => options[key] !== undefined && !positive(options[key]))
    || options.timeoutMs > 120_000 || options.maxLineBytes > 16 * 1024 * 1024 || options.maxOutputBytes > 32 * 1024 * 1024 || options.maxStderrBytes > 64 * 1024) throw inputError(rawReadDiagnostics);
}
/** @param {unknown} value @param {number} maximum */
function boundedPositive(value, maximum) { return Number.isSafeInteger(value) && /** @type {number} */ (value) > 0 && /** @type {number} */ (value) <= maximum; }
/** @param {boolean} [rawReadDiagnostics] */
function inputError(rawReadDiagnostics = false) { return new PluginError('CODEX_APP_SERVER_INPUT_INVALID', 'Codex app-server input is invalid.', {
  category: 'validation', remedy: rawReadDiagnostics
    ? 'Provide a bounded thread ID and positive protocol limits.' : 'Provide bounded identifiers and positive protocol limits.',
}); }
function metadataInvalid() { return new PluginError('CODEX_CHILD_METADATA_INVALID', 'Codex returned invalid persisted child metadata.', { category: 'protocol', remedy: 'Upgrade or restart Codex and retry.' }); }
/** @param {unknown} reason */
function interruptionError(reason) {
  return reason instanceof PluginError && reason.code === 'JOB_INTERRUPTED' && reason.category === 'interruption'
    ? reason
    : new PluginError('JOB_INTERRUPTED', 'Codex app-server operation was interrupted.', { category: 'interruption', remedy: 'Retry the operation.' });
}
function listInvalid() { return new PluginError('CODEX_THREAD_LIST_INVALID', 'Codex returned an invalid persisted thread page.', { category: 'protocol', remedy: 'Upgrade or restart Codex and retry.' }); }
function listLimit() { return new PluginError('CODEX_THREAD_LIST_LIMIT_EXCEEDED', 'Codex persisted thread pagination exceeded its safety limit.', { category: 'protocol', remedy: 'Narrow the persisted thread set and retry.' }); }
/** @param {string} message */
function malformed(message) { return protocolError('CODEX_APP_SERVER_MALFORMED', message); }
/** @param {unknown} cause */
function spawnError(cause) { return new PluginError('CODEX_APP_SERVER_SPAWN_FAILED', 'Could not start Codex app-server.', { category: 'configuration', remedy: 'Install a compatible Codex CLI and run $zcode:setup.', cause }); }
/** @param {string} code @param {string} message @param {unknown} [cause] */
function protocolError(code, message, cause) { return new PluginError(code, message, { category: 'protocol', remedy: 'Upgrade or restart Codex and retry.', ...(cause ? { cause } : {}) }); }
/** @param {any} error @param {any} details */
function attachDetails(error, details) { if (error instanceof PluginError) { error.details = { ...(error.details ?? {}), ...details }; return error; } return error; }
/** @param {unknown} value @param {number} maxBytes */
function validBoundedString(value, maxBytes) { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maxBytes && !hasControl(value); }
/** @param {string} value */
function hasControl(value) { return [...value].some((character) => { const code = /** @type {number} */ (character.codePointAt(0)); return code <= 31 || code === 127; }); }
/** @param {unknown} value @returns {value is Record<string,any>} */
function plainObject(value) { if (value === null || typeof value !== 'object' || Array.isArray(value)) return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
/** @param {unknown} value @returns {boolean} */
function safePlainValue(value) {
  const stack = [{ value, depth: 0 }]; let nodes = 0;
  while (stack.length) { const current = stack.pop(); if (!current || current.depth > MAX_VALUE_DEPTH || ++nodes > MAX_VALUE_NODES) return false; if (current.value === null || ['string', 'number', 'boolean'].includes(typeof current.value)) continue; if (!Array.isArray(current.value) && !plainObject(current.value) || !Array.isArray(current.value) && unsafeKeys(current.value)) return false; for (const child of Array.isArray(current.value) ? current.value : Object.values(current.value)) stack.push({ value: child, depth: current.depth + 1 }); }
  return true;
}
/** @param {Record<string,unknown>} value */
function unsafeKeys(value) { return Object.keys(value).some((key) => ['__proto__', 'prototype', 'constructor'].includes(key)); }
