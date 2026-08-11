export const PROGRESS_PHASES = Object.freeze(['starting', 'running', 'waiting', 'finalizing']);
export const MAX_PROGRESS_PREVIEW_ENTRIES = 4;
export const MAX_PROGRESS_PENDING_EVENTS = 4;
export const MAX_PROGRESS_MESSAGE_BYTES = 256;
export const PROGRESS_HEARTBEAT_MS = 20_000;
export const MAX_PROGRESS_DIAGNOSTIC_KINDS = 8;
const PROGRESS_FLUSH_TIMEOUT_MS = 250;
const PROGRESS_SEMANTIC_GRACE_MS = 125;

const PROGRESS_DIAGNOSTICS = new Map([
  ['conversation-subscribe-failed', 'ZCode conversation progress is unavailable.'],
  ['conversation-unsubscribe-failed', 'ZCode conversation progress cleanup was incomplete.'],
  ['conversation-frame-overflow', 'ZCode conversation progress paused after an activity burst.'],
  ['conversation-render-failed', 'ZCode conversation progress rendering was disabled.'],
  ['writer-disabled', 'ZCode progress output was disabled.'],
  ['preview-disabled', 'ZCode progress preview was disabled.'],
  ['progress-flush-timeout', 'ZCode progress cleanup reached its time limit.'],
]);

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
 * @param {{sessionId:string,deferred?:boolean,write?:(line:string)=>void,persist?:(event:{phase:string,message:string,observedAt:string})=>Promise<void>|void,describeNotification?:(notification:unknown,observedAt:string)=>Array<{phase:string,message:string,observedAt:string}>|Promise<Array<{phase:string,message:string,observedAt:string}>>,onDescriptorOverflow?:()=>void,onDiagnostic?:(diagnostic:{kind:string})=>void,now?:()=>string,setInterval?:(callback:()=>void,milliseconds:number)=>any,clearInterval?:(timer:any)=>void}} options
 */
export function createProgressReporter({
  sessionId,
  deferred = false,
  write,
  persist,
  describeNotification,
  onDescriptorOverflow,
  onDiagnostic,
  now = () => new Date().toISOString(),
  setInterval: setIntervalFn = globalThis.setInterval,
  clearInterval: clearIntervalFn = globalThis.clearInterval,
}) {
  let active = !deferred;
  let accepting = true;
  let closed = false;
  let lastActivityAt = active ? now() : null;
  /** @type {string|null} */
  let previousKey = null;
  /** @type {Array<{event:{phase:string,message:string,observedAt:string},sequence:number}>} */
  const buffered = [];
  const bufferedKeys = new Set();
  /** @type {Array<{event:{phase:string,message:string,observedAt:string},sequence:number}>} */
  const pending = [];
  /** @type {Promise<void>|null} */
  let inFlight = null;
  /** @type {string|null} */ let lastPersistedAt = null;
  let writerDisabled = false; let persistDisabled = false;
  /** @type {Promise<void>|null} */ let descriptorInFlight = null;
  /** @type {number|null} */ let descriptorActiveSequence = null;
  /** @type {Array<{notification:unknown,observedAt:string,sequence:number}>} */ const descriptorPending = [];
  let descriptorEpoch = 0;
  let descriptorOverflowed = false;
  let observationSequence = 0;
  /** @type {number|null} */ let terminalSequence = null;
  /** @type {{event:{phase:string,message:string,observedAt:string},sequence:number}|null} */ let heldTerminal = null;
  let terminalStarted = false; let terminalPersisted = false;
  const diagnosedKinds = new Set();
  /** @param {string} kind @param {boolean} [writeImmediately] */
  const diagnose = (kind, writeImmediately = false) => {
    const message = PROGRESS_DIAGNOSTICS.get(kind);
    if (!message || diagnosedKinds.has(kind) || diagnosedKinds.size >= MAX_PROGRESS_DIAGNOSTIC_KINDS) return false;
    diagnosedKinds.add(kind);
    try { onDiagnostic?.({ kind }); } catch { /* diagnostics are observational */ }
    queueMicrotask(() => {
      if (closed) return;
      const observedAt = now(); if (!validTimestamp(observedAt)) return;
      const event = { phase: 'waiting', message, observedAt };
      const sequence = observationSequence; observationSequence += 1;
      if (writeImmediately) {
        writeEvent(event); enqueue(event, sequence, false); return;
      }
      if (terminalSequence !== null) { dispatchDiagnostic(event, sequence); return; }
      if (!active) bufferEvent(event, sequence); else dispatch(event, sequence);
    });
    return true;
  };
  /** @param {{phase:string,message:string,observedAt:string}} event */
  const writeEvent = (event) => {
    if (typeof write !== 'function' || writerDisabled) return;
    try { write(`[zcode] ${event.message}\n`); }
    catch { writerDisabled = true; diagnose('writer-disabled'); }
  };
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
      try { if (!writerDisabled) write(`[zcode] Still waiting for ZCode; last activity ${seconds}s ago.\n`); }
      catch { writerDisabled = true; diagnose('writer-disabled'); }
    }, PROGRESS_HEARTBEAT_MS);
    timer?.unref?.();
  };
  /** @param {{event:{phase:string,message:string,observedAt:string},sequence:number,write?:boolean}} entry */
  const startPersist = (entry) => {
    const event = validTimestamp(lastPersistedAt) && Date.parse(entry.event.observedAt) < Date.parse(lastPersistedAt)
      ? { ...entry.event, observedAt: lastPersistedAt }
      : entry.event;
    if (typeof persist !== 'function' || persistDisabled) { if (entry.write !== false) writeEvent(event); return; }
    if (entry.write !== false) writeEvent(event);
    if (event.phase === 'finalizing') terminalStarted = true;
    let operation;
    try { operation = Promise.resolve(persist(event)); }
    catch { operation = Promise.reject(new Error('progress persistence failed')); }
    const tracked = operation.then(() => {
      lastPersistedAt = event.observedAt;
      if (event.phase === 'finalizing') terminalPersisted = true;
    }).catch(() => { persistDisabled = true; pending.length = 0; diagnose('preview-disabled'); }).then(() => {
      inFlight = null;
      const next = pending.shift();
      if (next) startPersist(next);
    });
    inFlight = tracked;
  };
  /** @param {{phase:string,message:string,observedAt:string}} event @param {number} sequence @param {boolean} [write] */
  const enqueue = (event, sequence, write = true) => {
    if (typeof persist !== 'function' || persistDisabled) { if (write) writeEvent(event); return; }
    const entry = { event, sequence, write };
    if (inFlight === null) { startPersist(entry); return; }
    pending.push(entry);
    pending.sort((left, right) => left.sequence - right.sequence);
    if (pending.length <= MAX_PROGRESS_PENDING_EVENTS) return;
    const removeIndex = pending.findIndex((item) => item.event.phase !== 'finalizing');
    if (removeIndex !== -1) pending.splice(removeIndex, 1);
    else pending.pop();
  };
  /** @param {{phase:string,message:string,observedAt:string}} event @param {number} [sequence] */
  const dispatch = (event, sequence = observationSequence++) => {
    if (terminalSequence !== null && sequence > terminalSequence || terminalStarted && event.phase !== 'finalizing' || terminalPersisted) return null;
    if (!validTimestamp(lastActivityAt) || Date.parse(event.observedAt) > Date.parse(lastActivityAt)) lastActivityAt = event.observedAt;
    const key = `${event.phase}\u0000${event.message}`;
    if (key === previousKey) return null;
    previousKey = key;
    enqueue(event, sequence);
    return event;
  };
  /** Diagnostics remain observational and may follow terminal semantic progress. @param {{phase:string,message:string,observedAt:string}} event @param {number} sequence */
  const dispatchDiagnostic = (event, sequence) => {
    if (!validTimestamp(lastActivityAt) || Date.parse(event.observedAt) > Date.parse(lastActivityAt)) lastActivityAt = event.observedAt;
    enqueue(event, sequence);
    return event;
  };
  /** @param {{notification:unknown,observedAt:string,sequence:number}} item */
  const startDescribe = (item) => {
    if (typeof describeNotification !== 'function') return;
    const epoch = descriptorEpoch;
    descriptorActiveSequence = item.sequence;
    let described;
    try { described = Promise.resolve(describeNotification(item.notification, item.observedAt)); }
    catch { diagnose('conversation-render-failed'); described = Promise.resolve([]); }
    descriptorInFlight = described.then((events) => {
      if (epoch !== descriptorEpoch || !Array.isArray(events) || closed) return;
      for (const describedEvent of events.slice(0, MAX_PROGRESS_PENDING_EVENTS)) if (validPublicEvent(describedEvent)) {
        if (terminalSequence !== null && item.sequence > terminalSequence) continue;
        if (describedEvent.phase === 'finalizing') {
          terminalSequence = terminalSequence === null ? item.sequence : Math.min(terminalSequence, item.sequence);
          if (heldTerminal && heldTerminal.sequence > terminalSequence) heldTerminal = null;
        }
        if (!active) bufferEvent(describedEvent, item.sequence);
        else dispatch(describedEvent, item.sequence);
      }
    }).catch(() => { if (epoch === descriptorEpoch) diagnose('conversation-render-failed'); }).then(() => {
      if (epoch !== descriptorEpoch) return;
      descriptorInFlight = null; descriptorActiveSequence = null;
      while (descriptorPending.length > 0 && terminalSequence !== null && descriptorPending[0].sequence > terminalSequence) descriptorPending.shift();
      const next = descriptorPending.shift();
      if (next) startDescribe(next);
      else {
        descriptorOverflowed = false;
        releaseHeldTerminal();
      }
    });
  };
  /** @param {{notification:unknown,observedAt:string,sequence:number}} item */
  const enqueueDescribe = (item) => {
    if (descriptorInFlight === null) { startDescribe(item); return; }
    if (descriptorPending.length < MAX_PROGRESS_PENDING_EVENTS) descriptorPending.push(item);
    else {
      descriptorPending.length = 0; descriptorPending.push(item);
      if (!descriptorOverflowed) {
        descriptorOverflowed = true;
        try { onDescriptorOverflow?.(); } catch { /* overflow recovery is observational */ }
        diagnose('conversation-frame-overflow');
      }
    }
  };
  if (active) startTimer();

  return {
    /** @param {unknown} notification */
    observe(notification) {
      if (closed || !accepting) return null;
      const sequence = observationSequence; observationSequence += 1;
      if (terminalSequence !== null && sequence > terminalSequence) return null;
      const observedAt = now();
      const event = normalizeZCodeProgress(notification, sessionId, observedAt);
      if (event === null && typeof describeNotification === 'function' && plainObject(notification) && notification.method === 'v4/conversation/frame') {
        enqueueDescribe({ notification, observedAt, sequence }); return null;
      }
      if (event === null) return null;
      const terminal = event.phase === 'finalizing';
      if (terminal) terminalSequence = sequence;
      if (!active) {
        bufferEvent(event, sequence); return event;
      }
      if (terminal && (descriptorActiveSequence !== null && descriptorActiveSequence < sequence
        || descriptorPending.some((item) => item.sequence < sequence))) {
        heldTerminal = { event, sequence }; return event;
      }
      return dispatch(event, sequence);
    },
    /** @param {unknown} initialNotification */
    activate(initialNotification) {
      if (active || closed) return false;
      const activatedAt = now(); active = true; lastActivityAt = activatedAt; startTimer();
      const initial = normalizeZCodeProgress(initialNotification, sessionId, activatedAt);
      if (initial) dispatch(initial, -1);
      for (const { event, sequence } of buffered.sort((left, right) => left.sequence - right.sequence)) dispatch({ ...event, observedAt: activatedAt }, sequence);
      buffered.length = 0; bufferedKeys.clear(); return true;
    },
    /** @param {string} kind */
    diagnose(kind) { return diagnose(kind); },
    stopAccepting() { accepting = false; },
    async flush() {
      const deadline = Date.now() + PROGRESS_FLUSH_TIMEOUT_MS;
      const descriptorsDrained = await waitWithin(drainDescriptors(), Math.min(PROGRESS_SEMANTIC_GRACE_MS, remaining(deadline)));
      if (!descriptorsDrained && descriptorInFlight !== null) {
        descriptorEpoch += 1; descriptorInFlight = null; descriptorActiveSequence = null;
        descriptorPending.length = 0; descriptorOverflowed = false;
        releaseHeldTerminal();
        diagnose('progress-flush-timeout', true);
        await Promise.resolve();
      }
      const persistenceDrained = await waitWithin(drainPersistence(), remaining(deadline));
      if (!persistenceDrained) {
        diagnose('progress-flush-timeout', true);
        await Promise.resolve();
        pending.length = 0; persistDisabled = true;
      }
    },
    close() {
      accepting = false; closed = true; buffered.length = 0; bufferedKeys.clear(); descriptorPending.length = 0;
      if (timer === null) return;
      clearIntervalFn(timer);
      timer = null;
    },
  };

  /** @param {{phase:string,message:string,observedAt:string}} event */
  function bufferEvent(event, sequence = observationSequence++) {
    const key = `${event.phase}\u0000${event.message}`;
    if (bufferedKeys.has(key)) return;
    if (buffered.length === MAX_PROGRESS_PREVIEW_ENTRIES) {
      const removed = buffered.shift();
      if (removed) bufferedKeys.delete(`${removed.event.phase}\u0000${removed.event.message}`);
    }
    buffered.push({ event, sequence }); bufferedKeys.add(key);
  }

  function releaseHeldTerminal() {
    const terminal = heldTerminal; heldTerminal = null;
    if (terminal && terminal.sequence === terminalSequence) dispatch(terminal.event, terminal.sequence);
  }

  async function drainDescriptors() {
    while (descriptorInFlight !== null) await descriptorInFlight;
  }

  async function drainPersistence() {
    while (inFlight !== null) await inFlight;
  }
}

/** @param {Promise<void>} operation @param {number} milliseconds */
async function waitWithin(operation, milliseconds) {
  if (milliseconds <= 0) return false;
  /** @type {ReturnType<typeof globalThis.setTimeout>|undefined} */ let timer;
  let completed = false;
  try {
    await Promise.race([
      operation.then(() => { completed = true; }),
      new Promise((resolve) => { timer = globalThis.setTimeout(resolve, milliseconds); }),
    ]);
  } finally { if (timer !== undefined) globalThis.clearTimeout(timer); }
  return completed;
}

/** @param {number} deadline */
function remaining(deadline) { return Math.max(0, deadline - Date.now()); }

/** @param {unknown} event */
function validPublicEvent(event) {
  return plainObject(event) && PROGRESS_PHASES.includes(event.phase) && typeof event.message === 'string' && event.message.length > 0
    && Buffer.byteLength(event.message) <= MAX_PROGRESS_MESSAGE_BYTES && !hasControl(event.message) && validTimestamp(event.observedAt);
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
