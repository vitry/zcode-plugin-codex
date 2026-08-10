import { PluginError } from './errors.mjs';
import { isSafeIdentifier } from './identifier.mjs';
import net from 'node:net';
import { spawnProcess, terminateProcess } from './process.mjs';

export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_MAX_OUTBOUND_BYTES = 4 * 1024 * 1024;
export const DEFAULT_DRAIN_TIMEOUT_MS = 1_000;
export const MAX_DRAIN_TIMEOUT_MS = 30_000;
export const COMPLETION_REASONS = Object.freeze(['prompt_completed', 'prompt_failed']);

export class ZCodeProtocolClient {
  /** @param {import('node:child_process').ChildProcess} child @param {{ requestTimeoutMs?:number, completionTimeoutMs?:number, maxFrameBytes?:number, maxOutboundBytes?:number, drainTimeoutMs?:number, acceptBrokerControl?:boolean }} [options] */
  constructor(child, options = {}) {
    this.child = child;
    this.requestTimeoutMs = boundedInteger(options.requestTimeoutMs, 30_000, 1, 3_600_000);
    this.completionTimeoutMs = boundedInteger(options.completionTimeoutMs, 3_600_000, 1, 86_400_000);
    this.maxFrameBytes = boundedInteger(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, 128, 16 * 1024 * 1024);
    /** @type {Map<number,{resolve:(value:any)=>void,reject:(error:Error)=>void,timer:NodeJS.Timeout,method:string}>} */
    this.pending = new Map();
    /** @type {Map<string, any[]>} */ this.completed = new Map();
    /** @type {Map<string,NodeJS.Timeout>} */ this.completionExpiry = new Map();
    /** @type {Map<string,{status:'sending'|'armed',baseline?:number,inputId?:string}>} */ this.turns = new Map();
    /** @type {Map<string,any[]>} */ this.earlyCompletions = new Map();
    /** @type {Set<any>} */ this.completionWaiters = new Set();
    /** @type {Set<(message:any)=>void>} */ this.subscribers = new Set();
    /** @type {Set<Promise<void>>} */ this.serverTasks = new Set();
    /** @type {Set<AbortController>} */ this.serverTaskControllers = new Set();
    /** @type {Map<AbortController,string>} */ this.serverTaskSessions = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.closed = false;
    /** @type {Promise<void>|null} */ this.closePromise = null;
    /** @type {Promise<void>|null} */ this.terminationPromise = null;
    this.permissionHandler = null;
    this.subscriberErrorHandler = null;
    this.closeHandler = null;
    this.terminalHandler = null;
    this.consumeTerminal = false;
    this.acceptBrokerControl = options.acceptBrokerControl === true;
    this.waiterSessions = new Set();
    this.permissionRequestIds = new Map();
    this.drainTimeoutMs = boundedInteger(options.drainTimeoutMs, DEFAULT_DRAIN_TIMEOUT_MS, 1, MAX_DRAIN_TIMEOUT_MS);
    this.writer = new BoundedWriter(child.stdin, { maxQueuedBytes: boundedInteger(options.maxOutboundBytes, DEFAULT_MAX_OUTBOUND_BYTES, 128, 64 * 1024 * 1024), drainTimeoutMs: this.drainTimeoutMs, onFailure: (error) => this.fail(error) });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    this.stderrTail = new RedactedTail();
    child.stderr?.on('data', (chunk) => this.stderrTail.append(chunk));
    child.stdout?.on('data', (chunk) => this.handleChunk(chunk));
    child.once('error', (error) => this.fail(new PluginError('ZCODE_DISCONNECTED', 'The ZCode process connection failed.', { category: 'runtime', remedy: 'Restart the operation.', cause: error })));
    child.once('exit', (code, signal) => this.fail(new PluginError('ZCODE_DISCONNECTED', 'The ZCode process disconnected.', { category: 'runtime', remedy: 'Restart the operation.', details: { code, signal } })));
  }

  /** @param {string} method @param {Record<string,unknown>} params @param {number} [timeoutMs] */
  request(method, params, timeoutMs) {
    if (this.closed) return Promise.reject(disconnected());
    if (!nonEmpty(method) || !plainObject(params) || timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > this.requestTimeoutMs)) return Promise.reject(protocolInputError());
    if (this.pending.size >= 1024) return Promise.reject(new PluginError('ZCODE_PENDING_OVERFLOW', 'Too many pending ZCode requests.', { category: 'protocol', remedy: 'Wait for pending requests to finish.' })); const id = this.nextId++;
    const effectiveTimeoutMs = timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PluginError('ZCODE_REQUEST_TIMEOUT', `ZCode request timed out: ${method}.`, { category: 'timeout', remedy: 'Retry the operation.', details: { method, timeoutMs: effectiveTimeoutMs } }));
      }, effectiveTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.sendFrame({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  /** @param {((params:any,signal:AbortSignal)=>Promise<any>|any)|null} handler */
  setPermissionHandler(handler) {
    if (handler !== null && typeof handler !== 'function') throw protocolInputError();
    this.permissionHandler = handler;
  }
  /** @param {(error:unknown)=>void} handler */
  setSubscriberErrorHandler(handler) { if (typeof handler !== 'function') throw protocolInputError(); this.subscriberErrorHandler = handler; }
  /** Broker-only terminal hook. Validated terminal notifications are consumed before this callback. @param {(params:any,turn:{status:'armed',baseline:number,inputId:string})=>void} handler */
  consumeTerminalsWith(handler) { if (typeof handler !== 'function') throw protocolInputError(); this.terminalHandler = handler; this.consumeTerminal = true; }
  /** @param {(error:PluginError)=>void} handler */ setCloseHandler(handler) { if (typeof handler !== 'function') throw protocolInputError(); this.closeHandler = handler; }

  /** @param {string} sessionId */
  beginTurn(sessionId) { if (!nonEmpty(sessionId) || this.turns.has(sessionId)) throw new PluginError('ZCODE_TURN_ACTIVE', 'A turn is already active for this session.', { category: 'state', remedy: 'Wait for the active turn to finish.' }); if (this.turns.size >= 256) throw new PluginError('ZCODE_TURN_OVERFLOW', 'Too many active ZCode turns.', { category: 'state', remedy: 'Wait for active turns to finish.' }); clearTimeout(this.completionExpiry.get(sessionId)); this.completionExpiry.delete(sessionId); this.completed.delete(sessionId); this.turns.set(sessionId, { status: 'sending' }); }
  /** @param {string} sessionId @param {number} baseline @param {string} inputId */
  armTurn(sessionId, baseline, inputId) { const turn = this.turns.get(sessionId); if (!turn || turn.status !== 'sending' || !Number.isSafeInteger(baseline) || baseline < 0 || !nonEmpty(inputId)) throw protocolInputError(); const armed = { status: /** @type {'armed'} */ ('armed'), baseline, inputId }; this.turns.set(sessionId, armed); const early = this.earlyCompletions.get(sessionId) ?? []; this.earlyCompletions.delete(sessionId); const valid = early.find((params) => isCompletionFor({ method: 'state.updated', params }, sessionId, armed)); if (valid) this.queueCompletion(sessionId, valid); }
  /** @param {string} sessionId */ abortTurn(sessionId) { this.turns.delete(sessionId); this.earlyCompletions.delete(sessionId); this.completed.delete(sessionId); clearTimeout(this.completionExpiry.get(sessionId)); this.completionExpiry.delete(sessionId); }
  /** @param {string} sessionId @returns {'sending'|'armed'|null} */ turnState(sessionId) { if (!nonEmpty(sessionId)) throw protocolInputError(); return this.turns.get(sessionId)?.status ?? null; }
  /** @param {string} sessionId @param {PluginError} [error] */
  cancelTurn(sessionId, error = new PluginError('ZCODE_SESSION_STOPPED', `ZCode session ${sessionId} was stopped.`, { category: 'state', remedy: 'Start a new turn before waiting for completion.', details: { sessionId } })) {
    for (const waiter of this.completionWaiters) if (waiter.sessionId === sessionId) { if (waiter.timer) clearTimeout(waiter.timer); waiter.unsubscribe(); this.completionWaiters.delete(waiter); this.waiterSessions.delete(sessionId); waiter.reject(error); }
    for (const [controller, taskSessionId] of this.serverTaskSessions) if (taskSessionId === sessionId) controller.abort();
    this.abortTurn(sessionId);
  }

  /** @param {(message:any)=>void} handler */
  subscribe(handler) { if (typeof handler !== 'function' || this.subscribers.size >= 256) throw protocolInputError(); this.subscribers.add(handler); return () => this.subscribers.delete(handler); }

  /** @param {string} sessionId @param {number} [timeoutMs] */
  waitForCompletion(sessionId, timeoutMs = this.completionTimeoutMs) {
    if (!nonEmpty(sessionId) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || this.turns.get(sessionId)?.status !== 'armed' || this.waiterSessions.has(sessionId)) return Promise.reject(protocolInputError());
    const queued = this.completed.get(sessionId)?.shift();
    if (queued) { this.abortTurn(sessionId); return Promise.resolve(queued); }
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      this.waiterSessions.add(sessionId); const waiter = { reject, timer: /** @type {NodeJS.Timeout|null} */ (null), unsubscribe, sessionId };
      const timer = setTimeout(() => {
        this.completionWaiters.delete(waiter); this.waiterSessions.delete(sessionId); this.abortTurn(sessionId);
        unsubscribe();
        reject(new PluginError('ZCODE_COMPLETION_TIMEOUT', `ZCode session ${sessionId} did not complete in time.`, { category: 'timeout', remedy: 'Read or resume the session before retrying.', details: { sessionId, timeoutMs } }));
      }, timeoutMs);
      waiter.timer = timer;
      timer.unref?.();
      unsubscribe = this.subscribe((message) => {
        if (!isCompletionFor(message, sessionId, this.turns.get(sessionId))) return;
        this.completed.get(sessionId)?.shift();
        this.completionWaiters.delete(waiter); this.waiterSessions.delete(sessionId); clearTimeout(timer); unsubscribe(); this.abortTurn(sessionId); resolve(message.params);
      });
      waiter.unsubscribe = unsubscribe;
      this.completionWaiters.add(waiter);
    });
  }

  close() {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  async closeOnce() {
    const firstClose = !this.closed;
    this.closed = true;
    for (const controller of this.serverTaskControllers) controller.abort();
    if (firstClose) {
      this.stderrTail.close();
      this.rejectPending(disconnected()); this.rejectCompletionWaiters(disconnected()); this.writer.close();
      for (const timer of this.completionExpiry.values()) clearTimeout(timer);
      this.completionExpiry.clear(); this.completed.clear(); this.earlyCompletions.clear(); this.turns.clear(); this.permissionRequestIds.clear();
      try { this.child.stdin?.end(); } catch { /* already closed */ }
    }
    const tasks = [...this.serverTasks];
    if (tasks.length) await Promise.race([Promise.allSettled(tasks), boundedDelay(25)]);
    this.serverTasks.clear(); this.serverTaskControllers.clear(); this.serverTaskSessions.clear();
    this.terminationPromise ??= terminateProcess(this.child); await this.terminationPromise;
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
    if (message.id !== undefined && message.method !== undefined) { const controller = new AbortController(); this.trackServerTask(this.handleServerRequest(message, controller.signal), controller, message.params?.sessionId); return; }
    if (message.id !== undefined) { this.handleResponse(message); return; }
    if (typeof message.method === 'string' && plainObject(message.params)) {
      if (this.acceptBrokerControl && message.method === 'broker/sessionStopped') {
        if (Object.keys(message.params).length !== 1 || !isSafeIdentifier(message.params.sessionId)) { this.fail(malformedFrame()); return; }
        this.cancelTurn(message.params.sessionId); return;
      }
      const turn = this.turns.get(message.params.sessionId);
      if (isTerminalNotification(message) && turn?.status === 'sending') { const early = this.earlyCompletions.get(message.params.sessionId) ?? []; if (early.length >= 16) { this.fail(new PluginError('ZCODE_COMPLETION_OVERFLOW', 'Too many early completion candidates.', { category: 'protocol', remedy: 'Restart the connection.' })); return; } early.push(message.params); this.earlyCompletions.set(message.params.sessionId, early); }
      else if (isCompletionFor(message, message.params.sessionId, turn)) this.queueCompletion(message.params.sessionId, message.params);
      for (const subscriber of this.subscribers) {
        try { subscriber(message); } catch (error) { try { this.subscriberErrorHandler?.(error); } catch { /* diagnostics must not affect protocol */ } }
      }
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
      if (!plainObject(message.error) || typeof message.error.message !== 'string' || !Number.isSafeInteger(message.error.code)) { pending.reject(malformedFrame()); this.fail(malformedFrame()); return; }
      const remote = message.error.data?.pluginError;
      if (plainObject(remote) && nonEmpty(remote.code) && nonEmpty(remote.category) && nonEmpty(remote.remedy)) {
        pending.reject(new PluginError(remote.code, message.error.message, { category: remote.category, remedy: remote.remedy, details: plainObject(remote.details) ? remote.details : {} }));
        return;
      }
      /** @type {{method:string,rpcCode:unknown,remoteCode?:string}} */
      const details = { method: pending.method, rpcCode: message.error.code };
      if (isSafeRemoteCode(message.error.data?.code)) details.remoteCode = message.error.data.code;
      pending.reject(new PluginError('ZCODE_REQUEST_FAILED', `ZCode ${pending.method} failed: ${message.error.message}`, { category: 'runtime', remedy: 'Inspect the request and retry.', details }));
    } else pending.resolve(message.result);
  }

  /** @param {any} message @param {AbortSignal} signal */
  async handleServerRequest(message, signal) {
    if (!isServerRequestId(message.id) || typeof message.method !== 'string' || !plainObject(message.params)) { this.fail(malformedFrame()); return; }
    if (message.method !== 'interaction/requestPermission') { if (!this.closed) this.sendFrame({ id: message.id, error: { code: -32601, message: 'Unsupported server request.' } }); return; }
    try {
      validatePermissionRequest(message.params);
      if (!this.turns.has(message.params.sessionId)) throw new PluginError('ZCODE_PERMISSION_SESSION_INVALID', 'Permission request does not match an active session turn.', { category: 'authorization', remedy: 'Deny the request and restart the turn.' });
      const cutoff = Date.now() - 10 * 60_000; for (const [key, timestamp] of this.permissionRequestIds) if (timestamp < cutoff) this.permissionRequestIds.delete(key);
      const replayKey = JSON.stringify([message.params.sessionId, message.params.turnId ?? '', message.params.requestId, message.params.toolCallId]);
      if (this.permissionRequestIds.has(replayKey)) throw new PluginError('ZCODE_PERMISSION_REPLAY', 'A duplicate permission request was rejected.', { category: 'authorization', remedy: 'Restart the affected ZCode turn.' });
      if (this.permissionRequestIds.size >= 1024) throw new PluginError('ZCODE_PERMISSION_OVERFLOW', 'Too many permission requests were rejected.', { category: 'authorization', remedy: 'Restart the affected ZCode turn.' });
      this.permissionRequestIds.set(replayKey, Date.now());
      const result = this.permissionHandler ? await this.permissionHandler(message.params, signal) : message.params.options.find((/** @type {any} */ option) => option.response.decision === 'deny')?.response;
      validatePermissionResult(result);
      if (!message.params.options.some((/** @type {any} */ option) => JSON.stringify(option.response) === JSON.stringify(result))) throw new PluginError('ZCODE_PERMISSION_OPTION_INVALID', 'Permission response was not one of the offered options.', { category: 'authorization', remedy: 'Return an exact response offered by ZCode.' });
      if (!this.closed) this.sendFrame({ id: message.id, result });
    } catch (error) {
      if (signal.aborted) return;
      if (!this.closed) {
        try { this.sendFrame({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : 'Permission handler failed.' } }); }
        catch (sendError) { this.fail(asDisconnected(sendError, this.stderrTail.value())); }
      }
    }
  }

  /** @param {Promise<void>} task @param {AbortController} controller @param {unknown} sessionId */
  trackServerTask(task, controller, sessionId) { this.serverTasks.add(task); this.serverTaskControllers.add(controller); if (nonEmpty(sessionId)) this.serverTaskSessions.set(controller, /** @type {string} */ (sessionId)); const cleanup = () => { this.serverTasks.delete(task); this.serverTaskControllers.delete(controller); this.serverTaskSessions.delete(controller); }; void task.then(cleanup, (error) => { cleanup(); this.fail(asDisconnected(error, this.stderrTail.value())); }); }

  /** @param {Record<string,unknown>} frame */
  sendFrame(frame) {
    const data = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(data) > this.maxFrameBytes) throw frameTooLarge();
    this.writer.write(data);
  }

  /** @param {PluginError} error */
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.serverTaskControllers) controller.abort();
    this.serverTasks.clear(); this.serverTaskControllers.clear(); this.serverTaskSessions.clear(); this.permissionRequestIds.clear();
    this.stderrTail.close();
    const diagnosticError = withStderr(error, this.stderrTail.value());
    this.writer.close(); this.rejectPending(diagnosticError); this.rejectCompletionWaiters(diagnosticError); for (const timer of this.completionExpiry.values()) clearTimeout(timer); this.completionExpiry.clear(); this.completed.clear(); this.earlyCompletions.clear(); this.turns.clear();
    try { this.closeHandler?.(diagnosticError); } catch { /* close diagnostics cannot destabilize host */ }
    try { this.child.stdin?.destroy(); this.child.stdout?.destroy(); } catch { /* best effort */ }
    this.terminationPromise ??= terminateProcess(this.child); void this.terminationPromise.catch(() => {});
  }

  /** @param {PluginError} error */
  rejectPending(error) { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }

  /** @param {PluginError} error */
  rejectCompletionWaiters(error) { for (const waiter of this.completionWaiters) { if (waiter.timer) clearTimeout(waiter.timer); waiter.unsubscribe(); this.waiterSessions.delete(waiter.sessionId); waiter.reject(error); } this.completionWaiters.clear(); }

  /** @param {string} sessionId @param {any} params */
  queueCompletion(sessionId, params) { if (this.consumeTerminal) { const turn = this.turns.get(sessionId); this.abortTurn(sessionId); if (turn?.status === 'armed' && typeof turn.baseline === 'number' && typeof turn.inputId === 'string') this.terminalHandler?.(params, { status: 'armed', baseline: turn.baseline, inputId: turn.inputId }); return; } if (!this.completed.has(sessionId) && this.completed.size >= 1024) { this.fail(new PluginError('ZCODE_COMPLETION_OVERFLOW', 'Too many unconsumed completions were received.', { category: 'protocol', remedy: 'Restart the connection and consume completions promptly.' })); return; } const queue = this.completed.get(sessionId) ?? []; queue.splice(0, queue.length, params); this.completed.set(sessionId, queue); clearTimeout(this.completionExpiry.get(sessionId)); const expiry = setTimeout(() => this.abortTurn(sessionId), 10 * 60_000); expiry.unref?.(); this.completionExpiry.set(sessionId, expiry); }
}

export class BoundedWriter {
  /** @param {any} stream @param {{maxQueuedBytes?:number,drainTimeoutMs?:number,onFailure?:(error:PluginError)=>void}} [options] */
  constructor(stream, options = {}) {
    this.stream = stream; this.maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_OUTBOUND_BYTES; this.drainTimeoutMs = options.drainTimeoutMs ?? 1_000; this.onFailure = options.onFailure ?? (() => {}); this.blocked = false; this.pendingBytes = 0; this.currentBytes = 0;
    /** @type {string[]} */
    this.queue = [];
    /** @type {NodeJS.Timeout|undefined} */
    this.timer = undefined;
    this.closed = false; this.failed = false; this.onDrain = () => this.drain(); this.onError = (/** @type {unknown} */ error) => this.failOnce(asDisconnected(error)); stream?.on?.('drain', this.onDrain); stream?.on?.('error', this.onError);
  }
  /** @param {string} data */
  write(data) { if (this.closed || !this.stream?.writable) throw disconnected(); const bytes = Buffer.byteLength(data); if (bytes > this.maxQueuedBytes || this.pendingBytes + bytes > this.maxQueuedBytes) { const error = new PluginError('ZCODE_WRITE_OVERFLOW', 'ZCode outbound data exceeded the configured queue limit.', { category: 'protocol', remedy: 'Wait for the peer to consume data and retry.' }); this.failOnce(error); throw error; } if (this.blocked) { this.queue.push(data); this.pendingBytes += bytes; return; } this.writeNow(data, bytes, false); }
  /** @param {string} data @param {number} bytes */
  writeNow(data, bytes, /** @type {boolean} */ alreadyPending) { if (this.stream.write(data)) { if (alreadyPending) this.pendingBytes -= bytes; return; } this.blocked = true; this.currentBytes = bytes; if (!alreadyPending) this.pendingBytes += bytes; this.timer = setTimeout(() => this.failOnce(new PluginError('ZCODE_WRITE_TIMEOUT', 'ZCode outbound data remained backpressured.', { category: 'timeout', remedy: 'Restart the connection and retry.' })), this.drainTimeoutMs); this.timer.unref?.(); }
  drain() { if (this.closed || !this.blocked) return; clearTimeout(this.timer); this.timer = undefined; this.blocked = false; this.pendingBytes -= this.currentBytes; this.currentBytes = 0; while (!this.blocked && this.queue.length) { const data = /** @type {string} */ (this.queue.shift()); this.writeNow(data, Buffer.byteLength(data), true); } }
  close() { if (this.closed) return; this.closed = true; clearTimeout(this.timer); this.stream?.off?.('drain', this.onDrain); this.queue.length = 0; this.pendingBytes = 0; this.currentBytes = 0; }
  /** @param {PluginError} error */ failOnce(error) { if (this.failed) return; this.failed = true; this.close(); try { this.onFailure(error); } catch { /* failure callbacks cannot escape stream events */ } }
}

export class RedactedTail {
  /** @param {number} [maxBytes] @param {number} [maxLineBytes] */
  constructor(maxBytes = 8192, maxLineBytes = 64 * 1024) { this.maxBytes = maxBytes; this.maxLineBytes = maxLineBytes; this.tail = ''; this.line = ''; this.oversized = false; this.closed = false; }
  /** @param {unknown} chunk */
  append(chunk) {
    if (this.closed) return;
    let input = String(chunk);
    let newline = input.indexOf('\n');
    while (newline !== -1) {
      this.appendLineSegment(input.slice(0, newline)); this.finishLine(true);
      input = input.slice(newline + 1); newline = input.indexOf('\n');
    }
    this.appendLineSegment(input);
  }
  /** @param {string} segment */
  appendLineSegment(segment) {
    if (this.oversized || !segment) return;
    if (Buffer.byteLength(this.line) + Buffer.byteLength(segment) > this.maxLineBytes) { this.line = ''; this.oversized = true; return; }
    this.line += segment;
  }
  /** @param {boolean} newline */
  finishLine(newline) {
    const diagnostic = this.oversized ? '[oversized stderr line omitted]' : redactSecrets(this.line.replace(/\r$/, ''));
    if (diagnostic || newline) this.appendDiagnostic(`${diagnostic}${newline ? '\n' : ''}`);
    this.line = ''; this.oversized = false;
  }
  /** @param {string} diagnostic */
  appendDiagnostic(diagnostic) {
    this.tail += diagnostic;
    while (Buffer.byteLength(this.tail) > this.maxBytes) this.tail = this.tail.slice(Math.max(1, Math.floor(this.tail.length / 4)));
  }
  close() { if (this.closed) return; this.closed = true; if (this.line || this.oversized) this.finishLine(false); }
  value() { return this.tail; }
}

/** @param {{command:string,args:string[],target?:string}} launch @param {{cwd?:string,env?:NodeJS.ProcessEnv,requestTimeoutMs?:number,completionTimeoutMs?:number,maxFrameBytes?:number,maxOutboundBytes?:number,drainTimeoutMs?:number}} [options] */
export async function spawnZCodeProtocol(launch, options = {}) {
  const child = await spawnProcess(launch, { args: ['app-server'], cwd: options.cwd, env: options.env });
  return new ZCodeProtocolClient(child, options);
}

/** @param {string} endpoint @param {{brokerToken:string,ownerId:string,existingProtocolOnly?:boolean,requestTimeoutMs?:number,completionTimeoutMs?:number,maxFrameBytes?:number,maxOutboundBytes?:number,drainTimeoutMs?:number}} options */
export async function connectZCodeBroker(endpoint, options) {
  if (!nonEmpty(endpoint) || !plainObject(options) || !nonEmpty(options.brokerToken) || options.brokerToken.length < 32 || !nonEmpty(options.ownerId) || options.ownerId.length < 16
    || options.existingProtocolOnly !== undefined && typeof options.existingProtocolOnly !== 'boolean') throw protocolInputError();
  const requestTimeoutMs = boundedInteger(options.requestTimeoutMs, 30_000, 1, 3_600_000);
  const socket = net.createConnection(endpoint);
  await new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); socket.off('connect', onConnect); socket.off('error', onError); };
    const onConnect = () => { cleanup(); resolve(undefined); };
    const onError = (/** @type {Error} */ error) => { cleanup(); socket.destroy(); reject(error); };
    const timer = setTimeout(() => { cleanup(); socket.destroy(); reject(requestTimeout('broker/connect', requestTimeoutMs)); }, requestTimeoutMs);
    timer.unref?.(); socket.once('connect', onConnect); socket.once('error', onError);
  });
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
  /** @type {ZCodeProtocolClient|undefined} */
  let protocol;
  try {
    protocol = new ZCodeProtocolClient(transport, { ...options, acceptBrokerControl: true });
    const authenticated = await protocol.request('broker/auth', { token: options.brokerToken, ownerId: options.ownerId, ...(options.existingProtocolOnly === undefined ? {} : { existingProtocolOnly: options.existingProtocolOnly }) });
    if (!plainObject(authenticated) || authenticated.authenticated !== true
      || options.existingProtocolOnly === true && authenticated.existingProtocolOnly !== true) throw brokerCapabilityUnavailable();
    return protocol;
  } catch (error) {
    socket.destroy();
    await protocol?.close().catch(() => {});
    throw error;
  }
}

/** @param {any} message @param {unknown} sessionId */
function isCompletionFor(message, sessionId, /** @type {any} */ turn) { return nonEmpty(sessionId) && turn?.status === 'armed' && Number.isSafeInteger(message.params?.revision) && message.params.revision > turn.baseline && message.method === 'state.updated' && message.params?.scope === 'session' && message.params.sessionId === sessionId && COMPLETION_REASONS.includes(message.params.reason); }
/** @param {any} message */
function isTerminalNotification(message) { return message.method === 'state.updated' && message.params?.scope === 'session' && nonEmpty(message.params.sessionId) && Number.isSafeInteger(message.params.revision) && COMPLETION_REASONS.includes(message.params.reason); }
/** @param {number|undefined} value @param {number} fallback @param {number} minimum @param {number} maximum */
function boundedInteger(value, fallback, minimum, maximum) { if (value === undefined) return fallback; if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw protocolInputError(); return value; }
/** @param {number} milliseconds */
function boundedDelay(milliseconds) { return new Promise((resolve) => { setTimeout(resolve, milliseconds); }); }
/** @param {unknown} value */
function isServerRequestId(value) { return Number.isSafeInteger(value) || isSafeIdentifier(value) && !hasC1Control(/** @type {string} */ (value)); }
/** @param {unknown} value */
function isSafeRemoteCode(value) { return isSafeIdentifier(value, 128) && !hasC1Control(/** @type {string} */ (value)); }
/** @param {string} value */
function hasC1Control(value) { return [...value].some((character) => { const code = /** @type {number} */ (character.codePointAt(0)); return code >= 128 && code <= 159; }); }
/** @param {unknown} value */
function nonEmpty(value) { return typeof value === 'string' && value.length > 0; }
/** @param {unknown} value @returns {value is Record<string,any>} */
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function disconnected() { return new PluginError('ZCODE_DISCONNECTED', 'The ZCode connection is closed.', { category: 'runtime', remedy: 'Create a new client and retry.' }); }
function protocolInputError() { return new PluginError('ZCODE_PROTOCOL_INPUT_INVALID', 'ZCode protocol input is invalid.', { category: 'validation', remedy: 'Provide a valid method, params, session, and bounded timeout.' }); }
function brokerCapabilityUnavailable() { return new PluginError('ZCODE_BROKER_CAPABILITY_UNAVAILABLE', 'The broker did not authenticate the requested connection capability.', { category: 'protocol', remedy: 'Restart the broker with the current ZCode plugin version.' }); }
/** @param {string} method @param {number} timeoutMs */
function requestTimeout(method, timeoutMs) { return new PluginError('ZCODE_REQUEST_TIMEOUT', `ZCode request timed out: ${method}.`, { category: 'timeout', remedy: 'Retry the operation.', details: { method, timeoutMs } }); }
function malformedFrame() { return new PluginError('ZCODE_PROTOCOL_MALFORMED', 'ZCode sent a malformed protocol frame.', { category: 'protocol', remedy: 'Restart ZCode and retry.' }); }
function frameTooLarge() { return new PluginError('ZCODE_PROTOCOL_FRAME_TOO_LARGE', 'A ZCode protocol frame exceeded the configured limit.', { category: 'protocol', remedy: 'Reduce request size or inspect the peer for invalid output.' }); }
/** @param {unknown} error @param {string} [stderrTail] */
function asDisconnected(error, stderrTail = '') { return new PluginError('ZCODE_DISCONNECTED', 'The ZCode process connection failed.', { category: 'runtime', remedy: 'Restart the operation.', cause: error, details: stderrTail ? { stderrTail } : {} }); }
/** @param {PluginError} error @param {string} stderrTail */
function withStderr(error, stderrTail) { if (!stderrTail) return error; return new PluginError(error.code, error.message, { category: error.category, remedy: error.remedy, cause: error.cause, details: { ...error.details, stderrTail } }); }
/** @param {string} value */
function redactSecrets(value) {
  const credentialsRedacted = value.replace(/\b(Bearer|Basic)\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi, '$1 [REDACTED]');
  const key = String.raw`(?:"(?:authorization|auth|cookie|token|api[_-]?key|apikey|secret|password)"|'(?:authorization|auth|cookie|token|api[_-]?key|apikey|secret|password)'|\b(?:authorization|auth|cookie|token|api[_-]?key|apikey|secret|password|[A-Za-z][A-Za-z0-9_]*(?:_TOKEN|_API_KEY|_SECRET|_PASSWORD))\b)`;
  const secretValue = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,;]+)`;
  return credentialsRedacted.replace(new RegExp(`(${key}\\s*(?::|=|\\s)\\s*)${secretValue}`, 'gi'), '$1[REDACTED]');
}
/** @param {Record<string,any>} value */
function validatePermissionRequest(value) {
  const required = ['requestId', 'sessionId', 'toolCallId', 'toolName', 'reason', 'riskLevel', 'input', 'options'];
  const allowed = [...required, 'turnId', 'origin'];
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.includes(key))
    || !required.slice(0, 5).every((key) => nonEmpty(value[key]))
    || !['low', 'medium', 'high', 'critical'].includes(value.riskLevel)
    || !Array.isArray(value.options) || value.options.length === 0 || !value.options.every(validPermissionOption)
    || value.turnId !== undefined && !nonEmpty(value.turnId)
    || value.origin !== undefined && !validPermissionOrigin(value.origin)) throw malformedFrame();
}
/** @param {unknown} value */
function validPermissionOrigin(value) { if (!plainObject(value)) return false; const required = ['kind', 'agentId', 'agentType', 'childSessionId', 'parentSessionId']; const allowed = [...required, 'childTurnId', 'description', 'parentToolCallId', 'parentTurnId']; return value.kind === 'subagent' && required.slice(1).every((key) => nonEmpty(value[key])) && Object.keys(value).every((key) => allowed.includes(key)) && allowed.slice(5).every((key) => value[key] === undefined || nonEmpty(value[key])); }
/** @param {unknown} value */
function validPermissionOption(value) { if (!plainObject(value)) return false; const allowed = ['optionId', 'kind', 'name', 'description', 'response']; return Object.keys(value).every((key) => allowed.includes(key)) && ['optionId', 'kind', 'name'].every((key) => nonEmpty(value[key])) && (value.description === undefined || typeof value.description === 'string') && permissionResultValid(value.response); }
/** @param {unknown} value */
function validatePermissionResult(value) {
  if (!permissionResultValid(value)) throw protocolInputError();
}
/** @param {unknown} value */
function permissionResultValid(value) {
  const allowed = ['decision', 'reason', 'modifiedInput', 'permissionUpdates'];
  if (!plainObject(value) || !['allow', 'deny', 'escalate', 'modify'].includes(value.decision)
    || Object.keys(value).some((key) => !allowed.includes(key))
    || value.reason !== undefined && typeof value.reason !== 'string'
    || value.permissionUpdates !== undefined && (!Array.isArray(value.permissionUpdates) || !value.permissionUpdates.every(validPermissionUpdate))) return false;
  return true;
}
/** @param {unknown} value */
function validPermissionUpdate(value) { return plainObject(value) && Object.keys(value).every((key) => ['type', 'behavior', 'rules'].includes(key)) && value.type === 'addRules' && ['allow', 'deny', 'ask'].includes(value.behavior) && Array.isArray(value.rules) && value.rules.length > 0 && value.rules.every((rule) => plainObject(rule) && nonEmpty(rule.toolName) && Object.keys(rule).every((key) => ['toolName', 'ruleContent'].includes(key)) && (rule.ruleContent === undefined || typeof rule.ruleContent === 'string')); }
