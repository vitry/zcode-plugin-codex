export const PROGRESS_PHASES = Object.freeze(['starting', 'running', 'waiting', 'finalizing']);
export const MAX_PROGRESS_PREVIEW_ENTRIES = 4;
export const MAX_PROGRESS_PENDING_EVENTS = 4;
export const MAX_PROGRESS_MESSAGE_BYTES = 256;
export const PROGRESS_HEARTBEAT_MS = 20_000;
export const MAX_PROGRESS_DIAGNOSTIC_KINDS = 8;
export const MAX_PROGRESS_PROBE_COUNT = 255;
export const PROGRESS_PROBE_REJECTION_THRESHOLD = 4;
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
  ['conversation-snapshot-fallback', 'ZCode conversation frames were unavailable; using bounded session progress.'],
  ['conversation-lifecycle-only', 'ZCode semantic progress is unavailable; lifecycle updates will continue.'],
]);

const PROBE_REJECTION_REASONS = Object.freeze(['wire-version', 'envelope-shape', 'sequence', 'topic', 'row-kind', 'row-shape']);

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
 * @param {{sessionId:string,deferred?:boolean,write?:(line:string)=>void,persist?:(event:{phase:string,message:string,observedAt:string})=>Promise<void>|void,persistProbe?:(probe:any)=>Promise<void>|void,activateSnapshotFallback?:()=>false|(()=>unknown),describeNotification?:(notification:unknown,observedAt:string)=>any|Promise<any>,onDescriptorOverflow?:()=>void,onDiagnostic?:(diagnostic:{kind:string})=>void,now?:()=>string,setInterval?:(callback:()=>void,milliseconds:number)=>any,clearInterval?:(timer:any)=>void}} options
 */
export function createProgressReporter({
  sessionId,
  deferred = false,
  write,
  persist,
  persistProbe,
  activateSnapshotFallback,
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
  /** @type {Array<{kind:'event',event:{phase:string,message:string,observedAt:string},sequence:number}|{kind:'descriptor',notification:unknown,observedAt:string,sequence:number,state:'pending'|'ready'|'dropped',events:Array<{phase:string,message:string,observedAt:string}>}>} */
  const logicalPending = [];
  /** @type {Array<{event:{phase:string,message:string,observedAt:string},sequence:number}>} */ const writerPending = [];
  /** @type {Array<{event:{phase:string,message:string,observedAt:string},sequence:number}>} */ const persistPending = [];
  /** @type {Promise<void>|null} */ let writerInFlight = null;
  /** @type {Promise<void>|null} */ let persistInFlight = null;
  let writerEpoch = 0; let persistEpoch = 0;
  /** @type {string|null} */ let lastPersistedAt = null;
  let writerDisabled = false; let persistDisabled = false;
  /** @type {Promise<void>|null} */ let descriptorInFlight = null;
  /** @type {Extract<(typeof logicalPending)[number],{kind:'descriptor'}>|null} */ let activeDescriptor = null;
  let descriptorEpoch = 0;
  let descriptorOverflowed = false;
  let observationSequence = 0;
  /** @type {number|null} */ let terminalSequence = null;
  let terminalDispatched = false;
  const progressProbe = {
    state: 'probing', subscriptionAcknowledged: false, framesReceived: 0,
    acceptedInitial: 0, acceptedOnline: 0, acceptedRecovery: 0,
    rejected: Object.fromEntries(PROBE_REJECTION_REASONS.map((reason) => [reason, 0])),
    snapshotFallbackActive: false, snapshotFallbackUnavailable: false,
  };
  let compatibilityBoundaryActivated = false;
  /** @type {null|(()=>unknown)} */ let snapshotFallbackCleanup = null;
  const cleanupSnapshotFallback = () => {
    const cleanup = snapshotFallbackCleanup; snapshotFallbackCleanup = null;
    if (cleanup === null) return false;
    try { Promise.resolve(cleanup()).catch(() => {}); } catch { /* fallback cleanup is observational */ }
    return true;
  };
  const probeSnapshot = () => ({ ...progressProbe, rejected: { ...progressProbe.rejected } });
  /** @type {Promise<void>|null} */ let probePersistInFlight = null;
  /** @type {any|null} */ let probePersistPending = null;
  /** @param {any} snapshot */
  const startProbePersist = (snapshot) => {
    let operation;
    try { operation = Promise.resolve(/** @type {(probe:any)=>Promise<void>|void} */ (persistProbe)(snapshot)); }
    catch { operation = Promise.reject(new Error('progress probe persistence failed')); }
    const tracked = operation.catch(() => {}).then(() => {
      if (probePersistInFlight !== tracked) return;
      probePersistInFlight = null;
      if (closed || probePersistPending === null) { probePersistPending = null; return; }
      const next = probePersistPending; probePersistPending = null; startProbePersist(next);
    });
    probePersistInFlight = tracked;
  };
  const persistProbeSnapshot = () => {
    if (closed || typeof persistProbe !== 'function') return;
    const snapshot = probeSnapshot();
    if (probePersistInFlight === null) startProbePersist(snapshot);
    else probePersistPending = snapshot;
  };
  /** @param {number} value */
  const saturatingIncrement = (value) => Math.min(MAX_PROGRESS_PROBE_COUNT, value + 1);
  const diagnosedKinds = new Set();
  /** @param {string} kind */
  const diagnose = (kind) => {
    const message = PROGRESS_DIAGNOSTICS.get(kind);
    if (!message || diagnosedKinds.has(kind) || diagnosedKinds.size >= MAX_PROGRESS_DIAGNOSTIC_KINDS) return false;
    diagnosedKinds.add(kind);
    try { onDiagnostic?.({ kind }); } catch { /* diagnostics are observational */ }
    queueMicrotask(() => {
      if (closed) return;
      const observedAt = now(); if (!validTimestamp(observedAt)) return;
      const event = { phase: 'waiting', message, observedAt };
      const sequence = observationSequence; observationSequence += 1;
      if (!active && terminalSequence === null) bufferEvent(event, sequence);
      else dispatchDiagnostic(event, sequence);
    });
    return true;
  };
  /** @type {any} */
  let timer = null;
  const startTimer = () => {
    if (timer !== null || typeof write !== 'function' && typeof persistProbe !== 'function' && typeof activateSnapshotFallback !== 'function') return;
    timer = setIntervalFn(() => {
      activateCompatibilityBoundary();
      const currentTime = now();
      if (!validTimestamp(currentTime) || !validTimestamp(lastActivityAt)) return;
      const elapsedMs = Date.parse(currentTime) - Date.parse(lastActivityAt);
      if (elapsedMs < PROGRESS_HEARTBEAT_MS) return;
      const seconds = Math.floor(elapsedMs / 1_000);
      try { if (!writerDisabled && typeof write === 'function') write(`[zcode] Still waiting for ZCode; last activity ${seconds}s ago.\n`); }
      catch { writerDisabled = true; diagnose('writer-disabled'); }
    }, PROGRESS_HEARTBEAT_MS);
    timer?.unref?.();
  };
  const activateCompatibilityBoundary = () => {
    if (closed || compatibilityBoundaryActivated || progressProbe.state !== 'probing' || progressProbe.acceptedOnline > 0) return false;
    compatibilityBoundaryActivated = true;
    /** @type {unknown} */ let activation = false;
    try { activation = typeof activateSnapshotFallback === 'function' ? activateSnapshotFallback() : false; } catch { activation = false; }
    if (typeof activation === 'function') {
      snapshotFallbackCleanup = /** @type {()=>unknown} */ (activation);
      progressProbe.state = 'snapshot-fallback'; progressProbe.snapshotFallbackActive = true;
      diagnose('conversation-snapshot-fallback');
    } else {
      try { if (activation !== null && typeof activation === 'object') Promise.resolve(activation).catch(() => {}); }
      catch { /* fallback activation failures are observational */ }
      progressProbe.state = 'lifecycle-only'; progressProbe.snapshotFallbackUnavailable = true;
      diagnose('conversation-lifecycle-only');
    }
    persistProbeSnapshot(); return true;
  };
  /** @param {unknown} result */
  const recordDescriptionResult = (result) => {
    if (!plainObject(result) || !Array.isArray(result.events)) return [];
    if (result.disposition === 'accepted' && ['initial', 'online', 'recovery'].includes(result.phase)) {
      const field = result.phase === 'initial' ? 'acceptedInitial' : result.phase === 'online' ? 'acceptedOnline' : 'acceptedRecovery';
      progressProbe[field] = saturatingIncrement(progressProbe[field]);
      if (result.phase === 'online') {
        cleanupSnapshotFallback();
        progressProbe.state = 'online'; progressProbe.snapshotFallbackActive = false; progressProbe.snapshotFallbackUnavailable = false;
      }
      persistProbeSnapshot(); return result.events;
    }
    if (result.disposition === 'rejected' && PROBE_REJECTION_REASONS.includes(result.reason)) {
      progressProbe.rejected[result.reason] = saturatingIncrement(progressProbe.rejected[result.reason]);
      persistProbeSnapshot();
      const total = PROBE_REJECTION_REASONS.reduce((sum, reason) => sum + progressProbe.rejected[reason], 0);
      if (total >= PROGRESS_PROBE_REJECTION_THRESHOLD) activateCompatibilityBoundary();
    }
    return [];
  };
  /** @param {{event:{phase:string,message:string,observedAt:string},sequence:number}} entry */
  const startWriter = (entry) => {
    if (typeof write !== 'function' || writerDisabled) return;
    const epoch = writerEpoch;
    let operation;
    try { operation = Promise.resolve(write(`[zcode] ${entry.event.message}\n`)); }
    catch { operation = Promise.reject(new Error('progress writer failed')); }
    const tracked = operation.catch(() => {
      if (epoch !== writerEpoch) return;
      writerDisabled = true; writerPending.length = 0; diagnose('writer-disabled');
    }).then(() => {
      if (epoch !== writerEpoch) return;
      writerInFlight = null;
      const next = writerPending.shift(); if (next) startWriter(next);
    });
    writerInFlight = tracked;
  };
  /** @param {{event:{phase:string,message:string,observedAt:string},sequence:number}} entry */
  const startPersist = (entry) => {
    const event = validTimestamp(lastPersistedAt) && Date.parse(entry.event.observedAt) < Date.parse(lastPersistedAt)
      ? { ...entry.event, observedAt: lastPersistedAt }
      : entry.event;
    if (typeof persist !== 'function' || persistDisabled) return;
    const epoch = persistEpoch;
    let operation;
    try { operation = Promise.resolve(persist(event)); }
    catch { operation = Promise.reject(new Error('progress persistence failed')); }
    const tracked = operation.then(() => {
      if (epoch !== persistEpoch) return;
      lastPersistedAt = event.observedAt;
    }).catch(() => {
      if (epoch !== persistEpoch) return;
      persistDisabled = true; persistPending.length = 0; diagnose('preview-disabled');
    }).then(() => {
      if (epoch !== persistEpoch) return;
      persistInFlight = null;
      const next = persistPending.shift();
      if (next) startPersist(next);
    });
    persistInFlight = tracked;
  };
  /** @param {Array<{event:{phase:string,message:string,observedAt:string},sequence:number}>} queue @param {{event:{phase:string,message:string,observedAt:string},sequence:number}} entry */
  const retainBounded = (queue, entry) => {
    queue.push(entry);
    if (queue.length <= MAX_PROGRESS_PENDING_EVENTS) return;
    const removeIndex = queue.findIndex((item) => item.event.phase !== 'finalizing');
    if (removeIndex !== -1) queue.splice(removeIndex, 1); else queue.pop();
  };
  /** @param {{phase:string,message:string,observedAt:string}} event @param {number} sequence */
  const enqueueWriter = (event, sequence) => {
    if (typeof write !== 'function' || writerDisabled) return;
    const entry = { event, sequence };
    if (writerInFlight === null) startWriter(entry); else retainBounded(writerPending, entry);
  };
  /** @param {{phase:string,message:string,observedAt:string}} event @param {number} sequence */
  const enqueuePersist = (event, sequence) => {
    if (typeof persist !== 'function' || persistDisabled) return;
    const entry = { event, sequence };
    if (persistInFlight === null) startPersist(entry); else retainBounded(persistPending, entry);
  };
  /** @param {{phase:string,message:string,observedAt:string}} event @param {number} [sequence] */
  const dispatch = (event, sequence = observationSequence++) => {
    if (terminalSequence !== null && sequence > terminalSequence || terminalDispatched) return null;
    if (!validTimestamp(lastActivityAt) || Date.parse(event.observedAt) > Date.parse(lastActivityAt)) lastActivityAt = event.observedAt;
    const key = `${event.phase}\u0000${event.message}`;
    if (key === previousKey) return null;
    previousKey = key;
    if (event.phase === 'finalizing') terminalDispatched = true;
    enqueueWriter(event, sequence); enqueuePersist(event, sequence);
    return event;
  };
  /** Diagnostics remain observational and may follow terminal semantic progress. @param {{phase:string,message:string,observedAt:string}} event @param {number} sequence */
  const dispatchDiagnostic = (event, sequence) => {
    if (!validTimestamp(lastActivityAt) || Date.parse(event.observedAt) > Date.parse(lastActivityAt)) lastActivityAt = event.observedAt;
    enqueueWriter(event, sequence); enqueuePersist(event, sequence);
    return event;
  };
  /** @param {(typeof logicalPending)[number]} item */
  const enqueueLogical = (item) => {
    logicalPending.push(item);
    const allowance = MAX_PROGRESS_PENDING_EVENTS + (activeDescriptor === null ? 0 : 1);
    while (logicalPending.length > allowance) {
      const removeIndex = logicalPending.findIndex((entry) => entry !== activeDescriptor
        && !(entry.kind === 'event' && entry.event.phase === 'finalizing'));
      if (removeIndex === -1) { logicalPending.pop(); break; }
      const [removed] = logicalPending.splice(removeIndex, 1);
      if (removed?.kind === 'descriptor') removed.state = 'dropped';
    }
    pumpLogical();
  };
  /** @param {Extract<(typeof logicalPending)[number],{kind:'descriptor'}>} item */
  const startDescribe = (item) => {
    if (typeof describeNotification !== 'function') return;
    const epoch = descriptorEpoch;
    activeDescriptor = item;
    let described;
    try { described = Promise.resolve(describeNotification(item.notification, item.observedAt)); }
    catch { diagnose('conversation-render-failed'); described = Promise.resolve([]); }
    descriptorInFlight = described.then((description) => {
      if (epoch !== descriptorEpoch || closed) return;
      const events = Array.isArray(description) ? description : recordDescriptionResult(description);
      if (!Array.isArray(events)) return;
      item.events = events.slice(0, MAX_PROGRESS_PENDING_EVENTS).filter(validPublicEvent);
      for (const describedEvent of item.events) {
        if (describedEvent.phase === 'finalizing') {
          terminalSequence = terminalSequence === null ? item.sequence : Math.min(terminalSequence, item.sequence);
          for (const later of logicalPending) if (later.sequence > terminalSequence) {
            if (later.kind === 'descriptor') later.state = 'dropped';
          }
        }
      }
      item.state = 'ready';
    }).catch(() => { if (epoch === descriptorEpoch) { item.state = 'dropped'; diagnose('conversation-render-failed'); } }).then(() => {
      if (epoch !== descriptorEpoch) return;
      descriptorInFlight = null; activeDescriptor = null; pumpLogical();
    });
  };
  /** @param {{notification:unknown,observedAt:string,sequence:number}} item */
  const enqueueDescribe = (item) => {
    /** @type {Array<Extract<(typeof logicalPending)[number],{kind:'descriptor'}>>} */ const pendingDescriptors = [];
    for (const entry of logicalPending) if (entry.kind === 'descriptor' && entry.state === 'pending' && entry !== activeDescriptor) pendingDescriptors.push(entry);
    if (activeDescriptor !== null && pendingDescriptors.length >= MAX_PROGRESS_PENDING_EVENTS) {
      for (const entry of pendingDescriptors) entry.state = 'dropped';
      if (!descriptorOverflowed) {
        descriptorOverflowed = true;
        try { onDescriptorOverflow?.(); } catch { /* overflow recovery is observational */ }
        diagnose('conversation-frame-overflow');
      }
    }
    enqueueLogical({ kind: 'descriptor', ...item, state: 'pending', events: [] });
  };
  const pumpLogical = () => {
    while (logicalPending.length > 0) {
      const item = logicalPending[0];
      if (terminalSequence !== null && item.sequence > terminalSequence) { logicalPending.shift(); continue; }
      if (item.kind === 'descriptor') {
        if (item.state === 'dropped') { logicalPending.shift(); continue; }
        if (item.state === 'pending') {
          if (activeDescriptor === null) startDescribe(item);
          return;
        }
        logicalPending.shift();
        for (const event of item.events) {
          if (!active) bufferEvent(event, item.sequence); else dispatch(event, item.sequence);
        }
        continue;
      }
      logicalPending.shift();
      if (!active) bufferEvent(item.event, item.sequence); else dispatch(item.event, item.sequence);
    }
    if (activeDescriptor === null) descriptorOverflowed = false;
  };
  if (active) startTimer();

  return {
    markConversationSubscribed() {
      if (closed || !accepting || progressProbe.subscriptionAcknowledged) return false;
      progressProbe.subscriptionAcknowledged = true; persistProbeSnapshot(); return true;
    },
    activateCompatibilityBoundary,
    probeSnapshot,
    /** @param {unknown} notification */
    observe(notification) {
      if (closed || !accepting) return null;
      const sequence = observationSequence; observationSequence += 1;
      if (terminalSequence !== null && sequence > terminalSequence) return null;
      const observedAt = now();
      const event = normalizeZCodeProgress(notification, sessionId, observedAt);
      if (event === null && typeof describeNotification === 'function' && plainObject(notification) && notification.method === 'v4/conversation/frame') {
        progressProbe.framesReceived = saturatingIncrement(progressProbe.framesReceived); persistProbeSnapshot();
        enqueueDescribe({ notification, observedAt, sequence }); return null;
      }
      if (event === null) return null;
      const terminal = event.phase === 'finalizing';
      if (terminal) terminalSequence = sequence;
      enqueueLogical({ kind: 'event', event, sequence }); return event;
    },
    /** @param {unknown} initialNotification */
    activate(initialNotification) {
      if (active || closed) return false;
      const activatedAt = now(); active = true; lastActivityAt = activatedAt; startTimer();
      persistProbeSnapshot();
      const initial = normalizeZCodeProgress(initialNotification, sessionId, activatedAt);
      if (initial) dispatch(initial, -1);
      for (const { event, sequence } of buffered.sort((left, right) => left.sequence - right.sequence)) dispatch({ ...event, observedAt: activatedAt }, sequence);
      buffered.length = 0; bufferedKeys.clear(); pumpLogical(); return true;
    },
    /** @param {string} kind */
    diagnose(kind) { return diagnose(kind); },
    stopAccepting() { accepting = false; },
    async flush(absoluteDeadline = Date.now() + PROGRESS_FLUSH_TIMEOUT_MS) {
      const deadline = Math.min(absoluteDeadline, Date.now() + PROGRESS_FLUSH_TIMEOUT_MS);
      await Promise.resolve();
      const descriptorsDrained = await waitWithin(drainDescriptors(), Math.min(PROGRESS_SEMANTIC_GRACE_MS, remaining(deadline)));
      if (!descriptorsDrained && descriptorInFlight !== null && activeDescriptor !== null) {
        descriptorEpoch += 1;
        activeDescriptor.state = 'dropped';
        for (const item of logicalPending) if (item.kind === 'descriptor' && item.state === 'pending') item.state = 'dropped';
        descriptorInFlight = null; activeDescriptor = null; descriptorOverflowed = false; pumpLogical();
        diagnose('progress-flush-timeout'); await Promise.resolve();
      }
      const sinkBudget = remaining(deadline);
      const [writerDrained, persistenceDrained, probePersistenceDrained] = await Promise.all([
        waitWithin(drainWriter(), sinkBudget), waitWithin(drainPersistence(), sinkBudget), waitWithin(drainProbePersistence(), sinkBudget),
      ]);
      if (!writerDrained || !persistenceDrained || !probePersistenceDrained) {
        diagnose('progress-flush-timeout'); await Promise.resolve();
        if (!writerDrained) disableWriter();
        if (!persistenceDrained) disablePersist();
        if (!probePersistenceDrained) disableProbePersist();
        const finalBudget = remaining(deadline);
        await Promise.all([
          writerDisabled ? Promise.resolve() : waitWithin(drainWriter(), finalBudget),
          persistDisabled ? Promise.resolve() : waitWithin(drainPersistence(), finalBudget),
          probePersistInFlight === null ? Promise.resolve() : waitWithin(drainProbePersistence(), finalBudget),
        ]);
      }
      return true;
    },
    close() {
      cleanupSnapshotFallback();
      accepting = false; closed = true; buffered.length = 0; bufferedKeys.clear();
      disableProbePersist();
      descriptorEpoch += 1;
      for (const item of logicalPending) if (item.kind === 'descriptor') item.state = 'dropped';
      activeDescriptor = null; descriptorInFlight = null; pumpLogical(); logicalPending.length = 0;
      disableWriter(); disablePersist();
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

  async function drainDescriptors() {
    while (descriptorInFlight !== null) await descriptorInFlight;
  }

  async function drainPersistence() {
    while (persistInFlight !== null) await persistInFlight;
  }

  async function drainProbePersistence() {
    while (probePersistInFlight !== null) await probePersistInFlight;
  }

  async function drainWriter() { while (writerInFlight !== null) await writerInFlight; }

  function disableWriter() { writerEpoch += 1; writerDisabled = true; writerInFlight = null; writerPending.length = 0; }
  function disablePersist() { persistEpoch += 1; persistDisabled = true; persistInFlight = null; persistPending.length = 0; }
  function disableProbePersist() { probePersistInFlight = null; probePersistPending = null; }
}

/** @param {Promise<void>} operation @param {number} milliseconds */
async function waitWithin(operation, milliseconds) {
  /** @type {ReturnType<typeof globalThis.setTimeout>|undefined} */ let timer;
  let completed = false;
  const tracked = Promise.resolve(operation).then(() => { completed = true; });
  try {
    if (milliseconds > 0) await Promise.race([
      tracked,
      new Promise((resolve) => { timer = globalThis.setTimeout(resolve, milliseconds); }),
    ]);
    if (!completed) {
      await new Promise((resolve) => globalThis.setImmediate(resolve));
      await Promise.resolve();
    }
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
