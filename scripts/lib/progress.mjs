export const PROGRESS_PHASES = Object.freeze(['starting', 'running', 'waiting', 'finalizing']);
export const MAX_PROGRESS_PREVIEW_ENTRIES = 4;
export const MAX_PROGRESS_PENDING_EVENTS = 4;
export const MAX_PROGRESS_MESSAGE_BYTES = 256;
export const PROGRESS_HEARTBEAT_MS = 20_000;

/** @template T @param {Promise<T>} completion @param {AbortSignal|undefined} signal @returns {Promise<T>} */
export async function waitForCompletionOrAbort(completion, signal) {
  const completionPromise = Promise.resolve(completion);
  // The completion RPC remains in flight after interruption. Keep its later
  // rejection observed even after the abort side wins the race.
  completionPromise.catch(() => {});
  if (!signal) return completionPromise;
  signal.throwIfAborted();
  /** @type {()=>void} */
  let removeAbortListener = () => {};
  const interrupted = new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  });
  interrupted.catch(() => {});
  try { return await Promise.race([completionPromise, interrupted]); }
  finally { removeAbortListener(); }
}

const KNOWN_PROGRESS = new Map([
  ['prompt_started', ['starting', 'ZCode started the delegated turn.']],
  ['model_streaming', ['running', 'ZCode is generating a response.']],
  ['tool_call_started', ['running', 'ZCode started a tool call.']],
  ['tool_call_progress', ['running', 'ZCode tool work is still running.']],
  ['tool_call_result', ['running', 'ZCode completed a tool call.']],
  ['api_retry', ['waiting', 'ZCode is retrying the model request.']],
  ['prompt_completed', ['finalizing', 'ZCode completed the delegated turn.']],
  ['prompt_failed', ['finalizing', 'ZCode reported a failed delegated turn.']],
]);

/** @param {unknown} notification @param {string} sessionId @param {unknown} observedAt */
export function normalizeZCodeProgress(notification, sessionId, observedAt) {
  if (!plainObject(notification) || notification.method !== 'state.updated' || !plainObject(notification.params)) return null;
  const { params } = notification;
  if (params.scope !== 'session' || params.sessionId !== sessionId || !safeReason(params.reason) || !validTimestamp(observedAt)) return null;
  const [phase, message] = KNOWN_PROGRESS.get(params.reason) ?? ['running', 'ZCode reported activity.'];
  return { phase, message, observedAt };
}

/**
 * @param {{sessionId:string,deferred?:boolean,write?:(line:string)=>void,persist?:(event:{phase:string,message:string,observedAt:string})=>Promise<void>|void,now?:()=>string,setInterval?:(callback:()=>void,milliseconds:number)=>any,clearInterval?:(timer:any)=>void}} options
 */
export function createProgressReporter({
  sessionId,
  deferred = false,
  write,
  persist,
  now = () => new Date().toISOString(),
  setInterval: setIntervalFn = globalThis.setInterval,
  clearInterval: clearIntervalFn = globalThis.clearInterval,
}) {
  let active = !deferred;
  let closed = false;
  let lastActivityAt = active ? now() : null;
  /** @type {string|null} */
  let previousKey = null;
  /** @type {Array<{phase:string,message:string,observedAt:string}>} */
  const buffered = [];
  const bufferedKeys = new Set();
  /** @type {Array<{phase:string,message:string,observedAt:string}>} */
  const pending = [];
  /** @type {Promise<void>|null} */
  let inFlight = null;
  let hasReporterError = false;
  /** @type {unknown} */
  let reporterError;
  const recordError = (/** @type {unknown} */ error) => { if (!hasReporterError) { hasReporterError = true; reporterError = error; } };
  /** @type {any} */
  let timer = null;
  const startTimer = () => {
    if (timer !== null || typeof write !== 'function') return;
    timer = setIntervalFn(() => {
      const currentTime = now();
      if (!validTimestamp(currentTime) || !validTimestamp(lastActivityAt)) return;
      const elapsedMs = Date.parse(currentTime) - Date.parse(lastActivityAt);
      if (elapsedMs < PROGRESS_HEARTBEAT_MS) return;
      const seconds = Math.floor(elapsedMs / 1_000);
      try { write(`[zcode] Still waiting for ZCode; last activity ${seconds}s ago.\n`); }
      catch (error) { recordError(error); }
    }, PROGRESS_HEARTBEAT_MS);
    timer?.unref?.();
  };
  /** @param {{phase:string,message:string,observedAt:string}} event */
  const startPersist = (event) => {
    if (typeof persist !== 'function') return;
    let operation;
    try { operation = Promise.resolve(persist(event)); }
    catch (error) { recordError(error); operation = Promise.resolve(); }
    const tracked = operation.catch((error) => { recordError(error); }).then(() => {
      inFlight = null;
      const next = pending.shift();
      if (next) startPersist(next);
    });
    inFlight = tracked;
  };
  /** @param {{phase:string,message:string,observedAt:string}} event */
  const enqueue = (event) => {
    if (typeof persist !== 'function') return true;
    if (inFlight === null) { startPersist(event); return true; }
    if (pending.length < MAX_PROGRESS_PENDING_EVENTS) { pending.push(event); return true; }
    pending[pending.length - 1] = event;
    return false;
  };
  /** @param {{phase:string,message:string,observedAt:string}} event */
  const dispatch = (event) => {
    lastActivityAt = event.observedAt;
    const key = `${event.phase}\u0000${event.message}`;
    if (key === previousKey) return null;
    previousKey = key;
    const admitted = enqueue(event);
    if (admitted && typeof write === 'function') {
      try { write(`[zcode] ${event.message}\n`); }
      catch (error) { recordError(error); }
    }
    return event;
  };
  if (active) startTimer();

  return {
    /** @param {unknown} notification */
    observe(notification) {
      if (closed) return null;
      const event = normalizeZCodeProgress(notification, sessionId, now());
      if (event === null) return null;
      const key = `${event.phase}\u0000${event.message}`;
      if (!active) {
        if (bufferedKeys.has(key)) return null;
        if (buffered.length === MAX_PROGRESS_PREVIEW_ENTRIES) {
          const removed = buffered.shift();
          if (removed) bufferedKeys.delete(`${removed.phase}\u0000${removed.message}`);
        }
        buffered.push(event); bufferedKeys.add(key); return event;
      }
      return dispatch(event);
    },
    /** @param {unknown} initialNotification */
    activate(initialNotification) {
      if (active || closed) return false;
      const activatedAt = now(); active = true; lastActivityAt = activatedAt; startTimer();
      const initial = normalizeZCodeProgress(initialNotification, sessionId, activatedAt);
      if (initial) dispatch(initial);
      for (const event of buffered) dispatch({ ...event, observedAt: activatedAt });
      buffered.length = 0; bufferedKeys.clear(); return true;
    },
    async flush() {
      while (inFlight !== null) await inFlight;
      if (hasReporterError) throw reporterError;
    },
    close() {
      closed = true; buffered.length = 0; bufferedKeys.clear();
      if (timer === null) return;
      clearIntervalFn(timer);
      timer = null;
    },
  };
}

/** @param {unknown} value */
function safeReason(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= MAX_PROGRESS_MESSAGE_BYTES && !hasControl(value);
}

/** @param {string} value */
function hasControl(value) { return [...value].some((character) => { const codePoint = character.charCodeAt(0); return codePoint <= 31 || codePoint >= 127 && codePoint <= 159; }); }

/** @param {unknown} value @returns {value is string} */
function validTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

/** @param {unknown} value @returns {value is Record<string,any>} */
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
