import { PluginError } from './errors.mjs';
import net from 'node:net';
import { spawnProcess, terminateProcess } from './process.mjs';

export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
export const COMPLETION_REASONS = Object.freeze(['prompt_completed', 'prompt_cancelled', 'prompt_failed']);

export class ZCodeProtocolClient {
  /** @param {import('node:child_process').ChildProcess} child @param {{ requestTimeoutMs?:number, completionTimeoutMs?:number, maxFrameBytes?:number }} [options] */
  constructor(child, options = {}) {
    this.child = child;
    this.requestTimeoutMs = boundedInteger(options.requestTimeoutMs, 30_000, 1, 3_600_000);
    this.completionTimeoutMs = boundedInteger(options.completionTimeoutMs, 3_600_000, 1, 86_400_000);
    this.maxFrameBytes = boundedInteger(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, 128, 16 * 1024 * 1024);
    /** @type {Map<number,{resolve:(value:any)=>void,reject:(error:Error)=>void,timer:NodeJS.Timeout,method:string}>} */
    this.pending = new Map();
    /** @type {Map<string, any[]>} */ this.completed = new Map();
    /** @type {Set<any>} */ this.completionWaiters = new Set();
    /** @type {Set<(message:any)=>void>} */ this.subscribers = new Set();
    this.nextId = 1;
    this.buffer = '';
    this.closed = false;
    this.permissionHandler = null;
    this.permissionRequestIds = new Set();
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => this.handleChunk(chunk));
    child.once('error', (error) => this.fail(new PluginError('ZCODE_DISCONNECTED', 'The ZCode process connection failed.', { category: 'runtime', remedy: 'Restart the operation.', cause: error })));
    child.once('exit', (code, signal) => this.fail(new PluginError('ZCODE_DISCONNECTED', 'The ZCode process disconnected.', { category: 'runtime', remedy: 'Restart the operation.', details: { code, signal } })));
  }

  /** @param {string} method @param {Record<string,unknown>} params */
  request(method, params) {
    if (this.closed) return Promise.reject(disconnected());
    if (!nonEmpty(method) || !plainObject(params)) return Promise.reject(protocolInputError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PluginError('ZCODE_REQUEST_TIMEOUT', `ZCode request timed out: ${method}.`, { category: 'timeout', remedy: 'Retry the operation.', details: { method, timeoutMs: this.requestTimeoutMs } }));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.sendFrame({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  /** @param {(params:any)=>Promise<any>|any} handler */
  setPermissionHandler(handler) {
    if (handler !== null && typeof handler !== 'function') throw protocolInputError();
    this.permissionHandler = handler;
  }

  /** @param {string} sessionId */
  beginTurn(sessionId) { if (!nonEmpty(sessionId)) throw protocolInputError(); this.completed.delete(sessionId); }

  /** @param {(message:any)=>void} handler */
  subscribe(handler) { if (typeof handler !== 'function') throw protocolInputError(); this.subscribers.add(handler); return () => this.subscribers.delete(handler); }

  /** @param {string} sessionId @param {number} [timeoutMs] */
  waitForCompletion(sessionId, timeoutMs = this.completionTimeoutMs) {
    if (!nonEmpty(sessionId) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return Promise.reject(protocolInputError());
    const queued = this.completed.get(sessionId)?.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const waiter = { reject, timer: /** @type {NodeJS.Timeout|null} */ (null), unsubscribe };
      const timer = setTimeout(() => {
        this.completionWaiters.delete(waiter);
        unsubscribe();
        reject(new PluginError('ZCODE_COMPLETION_TIMEOUT', `ZCode session ${sessionId} did not complete in time.`, { category: 'timeout', remedy: 'Read or resume the session before retrying.', details: { sessionId, timeoutMs } }));
      }, timeoutMs);
      waiter.timer = timer;
      timer.unref?.();
      unsubscribe = this.subscribe((message) => {
        if (!isCompletionFor(message, sessionId)) return;
        this.completed.get(sessionId)?.shift();
        this.completionWaiters.delete(waiter); clearTimeout(timer); unsubscribe(); resolve(message.params);
      });
      waiter.unsubscribe = unsubscribe;
      this.completionWaiters.add(waiter);
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(disconnected());
    this.rejectCompletionWaiters(disconnected());
    try { this.child.stdin?.end(); } catch { /* already closed */ }
    await terminateProcess(this.child);
  }

  /** @param {string} chunk */
  handleChunk(chunk) {
    if (this.closed) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > this.maxFrameBytes && !this.buffer.includes('\n')) {
      this.fail(frameTooLarge()); return;
    }
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1 && !this.closed) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > this.maxFrameBytes) { this.fail(frameTooLarge()); return; }
      if (line.trim()) this.handleLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  /** @param {string} line */
  handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch (error) {
      this.fail(new PluginError('ZCODE_PROTOCOL_MALFORMED', 'ZCode sent malformed JSON.', { category: 'protocol', remedy: 'Restart ZCode and retry.', cause: error })); return;
    }
    if (!plainObject(message)) { this.fail(malformedFrame()); return; }
    if (message.id !== undefined && message.method !== undefined) { void this.handleServerRequest(message); return; }
    if (message.id !== undefined) { this.handleResponse(message); return; }
    if (typeof message.method === 'string' && plainObject(message.params)) {
      if (isCompletionFor(message, message.params.sessionId)) {
        const queue = this.completed.get(message.params.sessionId) ?? [];
        queue.splice(0, queue.length, message.params); this.completed.set(message.params.sessionId, queue);
      }
      for (const subscriber of this.subscribers) subscriber(message);
      return;
    }
    this.fail(malformedFrame());
  }

  /** @param {any} message */
  handleResponse(message) {
    if (!Number.isSafeInteger(message.id) || ('result' in message) === ('error' in message)) { this.fail(malformedFrame()); return; }
    const pending = this.pending.get(message.id);
    if (!pending) { this.fail(new PluginError('ZCODE_RESPONSE_UNCORRELATED', 'ZCode sent an uncorrelated response.', { category: 'protocol', remedy: 'Restart ZCode and retry.', details: { id: message.id } })); return; }
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if ('error' in message) {
      if (!plainObject(message.error) || typeof message.error.message !== 'string') { pending.reject(malformedFrame()); this.fail(malformedFrame()); return; }
      const remote = message.error.data?.pluginError;
      if (plainObject(remote) && nonEmpty(remote.code) && nonEmpty(remote.category) && nonEmpty(remote.remedy)) {
        pending.reject(new PluginError(remote.code, message.error.message, { category: remote.category, remedy: remote.remedy, details: plainObject(remote.details) ? remote.details : {} }));
        return;
      }
      pending.reject(new PluginError('ZCODE_REQUEST_FAILED', `ZCode ${pending.method} failed: ${message.error.message}`, { category: 'runtime', remedy: 'Inspect the request and retry.', details: { method: pending.method, rpcCode: message.error.code } }));
    } else pending.resolve(message.result);
  }

  /** @param {any} message */
  async handleServerRequest(message) {
    if (!Number.isSafeInteger(message.id) || typeof message.method !== 'string' || !plainObject(message.params)) { this.fail(malformedFrame()); return; }
    if (message.method !== 'interaction/requestPermission') { this.sendFrame({ id: message.id, error: { code: -32601, message: 'Unsupported server request.' } }); return; }
    try {
      validatePermissionRequest(message.params);
      if (this.permissionRequestIds.has(message.params.requestId)) throw new PluginError('ZCODE_PERMISSION_REPLAY', 'A duplicate permission request was rejected.', { category: 'authorization', remedy: 'Restart the affected ZCode turn.' });
      this.permissionRequestIds.add(message.params.requestId);
      const result = this.permissionHandler ? await this.permissionHandler(message.params) : { decision: 'deny', reason: 'No permission handler is attached.' };
      validatePermissionResult(result);
      this.sendFrame({ id: message.id, result });
    } catch (error) {
      this.sendFrame({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : 'Permission handler failed.' } });
    }
  }

  /** @param {Record<string,unknown>} frame */
  sendFrame(frame) {
    const data = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(data) > this.maxFrameBytes) throw frameTooLarge();
    if (!this.child.stdin?.writable) throw disconnected();
    this.child.stdin.write(data);
  }

  /** @param {PluginError} error */
  fail(error) {
    if (this.closed) return;
    this.closed = true; this.rejectPending(error); this.rejectCompletionWaiters(error); this.completed.clear();
    try { this.child.stdin?.destroy(); this.child.stdout?.destroy(); } catch { /* best effort */ }
    void terminateProcess(this.child);
  }

  /** @param {PluginError} error */
  rejectPending(error) { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }

  /** @param {PluginError} error */
  rejectCompletionWaiters(error) { for (const waiter of this.completionWaiters) { if (waiter.timer) clearTimeout(waiter.timer); waiter.unsubscribe(); waiter.reject(error); } this.completionWaiters.clear(); }
}

/** @param {{command:string,args:string[],target?:string}} launch @param {{cwd?:string,env?:NodeJS.ProcessEnv,requestTimeoutMs?:number,completionTimeoutMs?:number,maxFrameBytes?:number}} [options] */
export async function spawnZCodeProtocol(launch, options = {}) {
  const child = await spawnProcess(launch, { args: ['app-server'], cwd: options.cwd, env: options.env });
  return new ZCodeProtocolClient(child, options);
}

/** @param {string} endpoint @param {{brokerToken:string,requestTimeoutMs?:number,completionTimeoutMs?:number,maxFrameBytes?:number}} options */
export async function connectZCodeBroker(endpoint, options) {
  if (!nonEmpty(endpoint) || !nonEmpty(options.brokerToken) || options.brokerToken.length < 32) throw protocolInputError();
  const socket = net.createConnection(endpoint);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  /** @type {any} */
  const transport = {
    stdout: socket, stdin: socket, stderr: null, exitCode: null, signalCode: null,
    once(/** @type {string} */ event, /** @type {(...args:any[])=>void} */ handler) {
      if (event === 'exit') socket.once('close', () => { transport.exitCode = 0; handler(0, null); });
      else socket.once(event, handler);
      return transport;
    },
    kill() { transport.exitCode = 0; socket.destroy(); return true; },
  };
  const protocol = new ZCodeProtocolClient(transport, options);
  await protocol.request('broker/auth', { token: options.brokerToken });
  return protocol;
}

/** @param {any} message @param {unknown} sessionId */
function isCompletionFor(message, sessionId) { return nonEmpty(sessionId) && message.method === 'state.updated' && message.params?.scope === 'session' && message.params.sessionId === sessionId && COMPLETION_REASONS.includes(message.params.reason); }
/** @param {number|undefined} value @param {number} fallback @param {number} minimum @param {number} maximum */
function boundedInteger(value, fallback, minimum, maximum) { if (value === undefined) return fallback; if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw protocolInputError(); return value; }
/** @param {unknown} value */
function nonEmpty(value) { return typeof value === 'string' && value.length > 0; }
/** @param {unknown} value @returns {value is Record<string,any>} */
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function disconnected() { return new PluginError('ZCODE_DISCONNECTED', 'The ZCode connection is closed.', { category: 'runtime', remedy: 'Create a new client and retry.' }); }
function protocolInputError() { return new PluginError('ZCODE_PROTOCOL_INPUT_INVALID', 'ZCode protocol input is invalid.', { category: 'validation', remedy: 'Provide a valid method, params, session, and bounded timeout.' }); }
function malformedFrame() { return new PluginError('ZCODE_PROTOCOL_MALFORMED', 'ZCode sent a malformed protocol frame.', { category: 'protocol', remedy: 'Restart ZCode and retry.' }); }
function frameTooLarge() { return new PluginError('ZCODE_PROTOCOL_FRAME_TOO_LARGE', 'A ZCode protocol frame exceeded the configured limit.', { category: 'protocol', remedy: 'Reduce request size or inspect the peer for invalid output.' }); }
/** @param {Record<string,any>} value */
function validatePermissionRequest(value) {
  const required = ['requestId', 'sessionId', 'toolCallId', 'toolName', 'reason', 'riskLevel', 'input', 'options'];
  const allowed = [...required, 'turnId', 'origin'];
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.includes(key))
    || !required.slice(0, 5).every((key) => nonEmpty(value[key]))
    || !['low', 'medium', 'high', 'critical'].includes(value.riskLevel)
    || !Array.isArray(value.options) || value.options.length === 0) throw malformedFrame();
}
/** @param {unknown} value */
function validatePermissionResult(value) {
  const allowed = ['decision', 'reason', 'modifiedInput', 'permissionUpdates'];
  if (!plainObject(value) || !['allow', 'deny', 'escalate', 'modify'].includes(value.decision)
    || Object.keys(value).some((key) => !allowed.includes(key))
    || value.reason !== undefined && typeof value.reason !== 'string'
    || value.permissionUpdates !== undefined && !Array.isArray(value.permissionUpdates)) throw protocolInputError();
}
