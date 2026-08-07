export const PROGRESS_PHASES = Object.freeze(['starting', 'running', 'waiting', 'finalizing']);
export const MAX_PROGRESS_PREVIEW_ENTRIES = 4;
export const MAX_PROGRESS_MESSAGE_BYTES = 256;
export const PROGRESS_HEARTBEAT_MS = 20_000;

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
 * @param {{sessionId:string,write?:(line:string)=>void,persist?:(event:{phase:string,message:string,observedAt:string})=>Promise<void>|void,now?:()=>string,setInterval?:(callback:()=>void,milliseconds:number)=>any,clearInterval?:(timer:any)=>void}} options
 */
export function createProgressReporter({
  sessionId,
  write,
  persist,
  now = () => new Date().toISOString(),
  setInterval: setIntervalFn = globalThis.setInterval,
  clearInterval: clearIntervalFn = globalThis.clearInterval,
}) {
  let lastActivityAt = now();
  /** @type {string|null} */
  let previousKey = null;
  let persistence = Promise.resolve();
  let timer = setIntervalFn(() => {
    const currentTime = now();
    if (typeof write !== 'function' || !validTimestamp(currentTime) || !validTimestamp(lastActivityAt)) return;
    const elapsedMs = Date.parse(currentTime) - Date.parse(lastActivityAt);
    if (elapsedMs < PROGRESS_HEARTBEAT_MS) return;
    const seconds = Math.floor(elapsedMs / 1_000);
    write(`[zcode] Still waiting for ZCode; last activity ${seconds}s ago.\n`);
  }, PROGRESS_HEARTBEAT_MS);
  timer?.unref?.();

  return {
    /** @param {unknown} notification */
    observe(notification) {
      const event = normalizeZCodeProgress(notification, sessionId, now());
      if (event === null) return null;
      const key = `${event.phase}\u0000${event.message}`;
      if (key === previousKey) return null;
      previousKey = key;
      lastActivityAt = event.observedAt;
      if (typeof write === 'function') write(`[zcode] ${event.message}\n`);
      if (typeof persist === 'function') persistence = persistence.then(() => persist(event));
      return event;
    },
    flush() { return persistence; },
    close() {
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
