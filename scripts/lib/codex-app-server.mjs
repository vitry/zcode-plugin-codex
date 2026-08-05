import { spawn as nodeSpawn } from 'node:child_process';

import { PluginError } from './errors.mjs';
import { RedactedTail } from './zcode-protocol.mjs';

export const CODEX_APP_SERVER_DEFAULT_TIMEOUT_MS = 15_000;
export const CODEX_THREAD_ID_MAX_BYTES = 512;
const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 8192;
const SHUTDOWN_GRACE_MS = 1_000;

/**
 * Read one persisted Codex thread through a short-lived app-server connection.
 * @param {string} threadId
 * @param {{executable?:string,args?:string[],cwd?:string,env?:NodeJS.ProcessEnv,timeoutMs?:number,maxLineBytes?:number,maxOutputBytes?:number,maxStderrBytes?:number,spawn?:(command:string,args:string[],options:any)=>any}} [options]
 */
export async function readCodexThread(threadId, options = {}) {
  validateInput(threadId, options);
  const executable = options.executable ?? 'codex'; const args = options.args ?? ['app-server'];
  const timeoutMs = options.timeoutMs ?? CODEX_APP_SERVER_DEFAULT_TIMEOUT_MS;
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  let child;
  try {
    child = (options.spawn ?? nodeSpawn)(executable, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  } catch (cause) { throw spawnError(cause); }

  const stderrTail = new RedactedTail(maxStderrBytes); let stdoutBytes = 0; let lineBuffer = Buffer.alloc(0);
  let settled = false; let requestStage = 'initialize'; const initializeId = 1; const readId = 2;
  /** @type {(value:any)=>void} */ let resolveResult;
  /** @type {(error:any)=>void} */ let rejectResult;
  const result = new Promise((resolvePromise, reject) => { resolveResult = resolvePromise; rejectResult = reject; });

  const detail = () => {
    stderrTail.close();
    return { stderrTail: stderrTail.value() };
  };
  const fail = (/** @type {any} */ error) => { if (settled) return; settled = true; rejectResult(attachDetails(error, detail())); };
  const succeed = (/** @type {any} */ thread) => { if (settled) return; settled = true; resolveResult(thread); };

  const timer = setTimeout(() => fail(new PluginError('CODEX_APP_SERVER_TIMEOUT', 'Codex app-server timed out while reading the source thread.', { category: 'timeout', remedy: 'Retry after confirming Codex can read the requested thread.' })), timeoutMs);
  child.stderr?.on('data', (/** @type {Buffer|string} */ chunk) => stderrTail.append(chunk));
  child.stdout?.on('data', (/** @type {Buffer|string} */ chunk) => {
    if (settled) return;
    const bytes = Buffer.from(chunk); stdoutBytes += bytes.length;
    if (stdoutBytes > maxOutputBytes) return fail(protocolError('CODEX_APP_SERVER_OUTPUT_TOO_LARGE', 'Codex app-server output exceeded its total limit.'));
    lineBuffer = Buffer.concat([lineBuffer, bytes]);
    if (lineBuffer.length > maxLineBytes && lineBuffer.indexOf(10) === -1) return fail(protocolError('CODEX_APP_SERVER_FRAME_TOO_LARGE', 'Codex app-server emitted an oversized frame.'));
    while (!settled) {
      const newline = lineBuffer.indexOf(10); if (newline < 0) break;
      let line = lineBuffer.subarray(0, newline); lineBuffer = lineBuffer.subarray(newline + 1);
      if (line.at(-1) === 13) line = line.subarray(0, -1);
      if (line.length === 0) continue;
      if (line.length > maxLineBytes) return fail(protocolError('CODEX_APP_SERVER_FRAME_TOO_LARGE', 'Codex app-server emitted an oversized frame.'));
      let frame;
      try { frame = JSON.parse(line.toString('utf8')); } catch (cause) { return fail(protocolError('CODEX_APP_SERVER_MALFORMED', 'Codex app-server emitted malformed JSON.', cause)); }
      if (!safePlainValue(frame)) return fail(protocolError('CODEX_APP_SERVER_MALFORMED', 'Codex app-server emitted an unsafe response.'));
      if (!Object.hasOwn(frame, 'id')) continue;
      const expectedId = requestStage === 'initialize' ? initializeId : readId;
      if (frame.id !== expectedId) continue;
      if (Object.keys(frame).some((key) => !['id', 'result', 'error'].includes(key))
        || Object.hasOwn(frame, 'result') === Object.hasOwn(frame, 'error')) return fail(protocolError('CODEX_APP_SERVER_MALFORMED', 'Codex app-server returned an ambiguous response.'));
      if (Object.hasOwn(frame, 'error')) {
        const code = requestStage === 'initialize' ? 'CODEX_APP_SERVER_INITIALIZE_FAILED' : 'CODEX_THREAD_READ_FAILED';
        return fail(new PluginError(code, requestStage === 'initialize' ? 'Codex app-server initialization failed.' : 'Codex could not read the requested thread.', { category: requestStage === 'initialize' ? 'protocol' : 'configuration', remedy: requestStage === 'initialize' ? 'Upgrade or restart Codex and retry.' : 'Confirm the Codex thread ID is persisted and accessible from this Codex home.' }));
      }
      if (!Object.hasOwn(frame, 'result') || !plainObject(frame.result)) return fail(protocolError('CODEX_APP_SERVER_MALFORMED', 'Codex app-server returned an invalid response.'));
      if (requestStage === 'initialize') {
        requestStage = 'read';
        try {
          writeFrame(child, { method: 'initialized', params: {} }, maxLineBytes);
          writeFrame(child, { id: readId, method: 'thread/read', params: { threadId, includeTurns: true } }, maxLineBytes);
        } catch (cause) { fail(protocolError('CODEX_APP_SERVER_WRITE_FAILED', 'Could not write to Codex app-server.', cause)); }
      } else {
        if (!Object.hasOwn(frame.result, 'thread')) return fail(protocolError('CODEX_APP_SERVER_MALFORMED', 'Codex thread/read response omitted its thread.'));
        succeed(frame.result.thread);
      }
    }
  });
  child.stdout?.once('error', (/** @type {unknown} */ cause) => fail(protocolError('CODEX_APP_SERVER_STREAM_FAILED', 'Codex app-server stdout failed.', cause)));
  child.stderr?.once('error', (/** @type {unknown} */ cause) => fail(protocolError('CODEX_APP_SERVER_STREAM_FAILED', 'Codex app-server stderr failed.', cause)));
  child.stdin?.once('error', (/** @type {unknown} */ cause) => fail(protocolError('CODEX_APP_SERVER_WRITE_FAILED', 'Could not write to Codex app-server.', cause)));
  child.once('error', (/** @type {unknown} */ cause) => fail(spawnError(cause)));
  child.once('exit', (/** @type {number|null} */ code, /** @type {NodeJS.Signals|null} */ signal) => { if (!settled) fail(new PluginError('CODEX_APP_SERVER_DISCONNECTED', 'Codex app-server exited before returning the source thread.', { category: 'runtime', remedy: 'Restart Codex and retry.', details: { code, signal } })); });

  try { writeFrame(child, { id: initializeId, method: 'initialize', params: { clientInfo: { name: 'zcode-plugin-codex', title: 'ZCode plugin for Codex', version: '0.1.0' }, capabilities: null } }, maxLineBytes); }
  catch (cause) { fail(protocolError('CODEX_APP_SERVER_WRITE_FAILED', 'Could not initialize Codex app-server.', cause)); }

  try { return await result; }
  finally { clearTimeout(timer); await terminate(child); }
}

/** @param {any} child @param {unknown} value @param {number} maxBytes */
function writeFrame(child, value, maxBytes) {
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame) > maxBytes || !child.stdin?.writable) throw new Error('app-server stdin is unavailable');
  child.stdin.write(frame);
}

/** @param {any} child */
async function terminate(child) {
  if (!child) return;
  child.stdin?.end();
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try { child.kill('SIGTERM'); } catch { return; }
  let grace;
  await Promise.race([exited, new Promise((resolve) => { grace = setTimeout(resolve, SHUTDOWN_GRACE_MS); })]);
  clearTimeout(grace);
  if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } await exited; }
}

/** @param {string} threadId @param {any} options */
function validateInput(threadId, /** @type {any} */ options) {
  const positive = (/** @type {unknown} */ value) => Number.isSafeInteger(value) && /** @type {number} */ (value) > 0;
  if (typeof threadId !== 'string' || !threadId || Buffer.byteLength(threadId) > CODEX_THREAD_ID_MAX_BYTES || hasControl(threadId)
    || !plainObject(options) || options.executable !== undefined && (typeof options.executable !== 'string' || !options.executable)
    || options.args !== undefined && (!Array.isArray(options.args) || options.args.some((item) => typeof item !== 'string'))
    || options.spawn !== undefined && typeof options.spawn !== 'function'
    || ['timeoutMs', 'maxLineBytes', 'maxOutputBytes', 'maxStderrBytes'].some((key) => options[key] !== undefined && !positive(options[key]))
    || options.timeoutMs > 120_000 || options.maxLineBytes > 16 * 1024 * 1024 || options.maxOutputBytes > 32 * 1024 * 1024 || options.maxStderrBytes > 64 * 1024) throw inputError();
}
function inputError() { return new PluginError('CODEX_APP_SERVER_INPUT_INVALID', 'Codex app-server input is invalid.', { category: 'validation', remedy: 'Provide a bounded thread ID and positive protocol limits.' }); }
/** @param {unknown} cause */
function spawnError(cause) { return new PluginError('CODEX_APP_SERVER_SPAWN_FAILED', 'Could not start Codex app-server.', { category: 'configuration', remedy: 'Install a compatible Codex CLI and run $zcode:setup.', cause }); }
/** @param {string} code @param {string} message @param {unknown} [cause] */
function protocolError(code, message, cause) { return new PluginError(code, message, { category: 'protocol', remedy: 'Upgrade or restart Codex and retry.', ...(cause ? { cause } : {}) }); }
/** @param {any} error @param {any} details */
function attachDetails(error, details) { if (error instanceof PluginError) { error.details = { ...(error.details ?? {}), ...details }; return error; } return error; }
/** @param {string} value */
function hasControl(value) { return [...value].some((character) => { const code = /** @type {number} */ (character.codePointAt(0)); return code <= 31 || code === 127; }); }
/** @param {unknown} value @returns {value is Record<string,any>} */
function plainObject(value) { if (value === null || typeof value !== 'object' || Array.isArray(value)) return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
/** @param {unknown} value @returns {boolean} */
function safePlainValue(value) { if (Array.isArray(value)) return value.every(safePlainValue); if (!plainObject(value)) return value === null || ['string', 'number', 'boolean'].includes(typeof value); return Object.keys(value).every((key) => !['__proto__', 'prototype', 'constructor'].includes(key) && safePlainValue(value[key])); }
