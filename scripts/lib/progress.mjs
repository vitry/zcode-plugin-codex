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
  ['archive-disabled', 'ZCode progress archive was disabled.'],
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
  ['prompt_completed', ['waiting', 'ZCode reported legacy completion; awaiting confirmed turn state.']],
  ['prompt_failed', ['waiting', 'ZCode reported legacy failure; awaiting confirmed turn state.']],
]);

const CONFIRMED_TERMINALS = new Map([
  ['succeeded', 'ZCode completed the delegated turn.'],
  ['failed', 'ZCode failed the delegated turn.'],
  ['interrupted', 'ZCode interrupted the delegated turn.'],
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
 * @param {{sessionId:string,deferred?:boolean,write?:(line:string)=>void,relay?:(record:{sequence:number,phase:string,code:string,observedAt:string})=>void|Promise<void>,persist?:(event:{phase:string,message:string,observedAt:string})=>Promise<void>|void,archive?:(event:{phase:string,message:string,observedAt:string})=>Promise<void>|void,persistProbe?:(probe:any)=>Promise<void>|void,activateSnapshotFallback?:()=>false|(()=>unknown),describeNotification?:(notification:unknown,observedAt:string)=>any|Promise<any>,onDescriptorOverflow?:()=>void,onDiagnostic?:(diagnostic:{kind:string})=>void,now?:()=>string,setInterval?:(callback:()=>void,milliseconds:number)=>any,clearInterval?:(timer:any)=>void}} options
 */
export function createProgressReporter({
  sessionId,
  deferred = false,
  write,
  relay,
  persist,
  archive,
  persistProbe,
  activateSnapshotFallback: configuredSnapshotFallback,
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
  /** @type {Array<{event:{phase:string,message:string,observedAt:string},sequence:number,relaySource:string}>} */
  const buffered = [];
  const bufferedKeys = new Set();
  /** @type {Array<{kind:'event',event:{phase:string,message:string,observedAt:string},sequence:number,relaySource:string}|{kind:'descriptor',notification:unknown,observedAt:string,sequence:number,state:'pending'|'ready'|'dropped',events:Array<{phase:string,message:string,observedAt:string}>,relaySource:string}>} */
  const logicalPending = [];
  /** @type {Array<{event:{phase:string,message:string,observedAt:string},sequence:number}>} */ const writerPending = [];
  /** @type {Array<{event:{phase:string,message:string,observedAt:string},sequence:number}>} */ const persistPending = [];
  /** @type {Array<{event:{phase:string,message:string,observedAt:string},sequence:number}>} */ const archivePending = [];
  /** @type {Promise<void>|null} */ let writerInFlight = null;
  /** @type {Promise<void>|null} */ let persistInFlight = null;
  /** @type {Promise<void>|null} */ let archiveInFlight = null;
  let writerEpoch = 0; let persistEpoch = 0; let archiveEpoch = 0;
  /** @type {string|null} */ let lastPersistedAt = null;
  let writerDisabled = false; let persistDisabled = false; let archiveDisabled = false;
  /** @type {Promise<void>|null} */ let descriptorInFlight = null;
  /** @type {Extract<(typeof logicalPending)[number],{kind:'descriptor'}>|null} */ let activeDescriptor = null;
  let descriptorEpoch = 0;
  let descriptorOverflowed = false;
  let observationSequence = 0;
  /** @type {number|null} */ let terminalSequence = null;
  let terminalDispatched = false;
  let relaySequence = 0; let relayDisabled = false; let relayClosed = false;
  /** @type {string|null} */ let previousRelayPhase = null;
  /** @type {Array<{sequence:number,phase:string,code:string,observedAt:string}>} */ const relayPending = [];
  /** @type {Promise<void>|null} */ let relayInFlight = null;
  let relayEpoch = 0;
  const progressProbe = {
    state: 'probing', subscriptionAcknowledged: false, framesReceived: 0,
    acceptedInitial: 0, acceptedOnline: 0, acceptedRecovery: 0,
    rejected: Object.fromEntries(PROBE_REJECTION_REASONS.map((reason) => [reason, 0])),
    snapshotFallbackActive: false, snapshotFallbackUnavailable: false,
  };
  let compatibilityBoundaryActivated = false;
  let acceptedBoundaryActivated = typeof configuredSnapshotFallback === 'function';
  /** @type {undefined|(()=>false|(()=>unknown))} */ let activateSnapshotFallback = configuredSnapshotFallback;
  /** @type {null|(()=>unknown)} */ let snapshotFallbackCleanup = null;
  /** @type {null|(()=>Promise<unknown>)} */ let snapshotRead = null;
  /** @type {null|{observe:(snapshot:unknown,observedAt:string)=>unknown|Promise<unknown>}} */ let snapshotDescriber = null;
  /** @type {Promise<void>|null} */ let snapshotReadInFlight = null;
  let snapshotEpoch = 0;
  let adjacentHeartbeatClaimed = false;
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
      if (!active && terminalSequence === null) bufferEvent(event, sequence, 'none');
      else dispatchDiagnostic(event, sequence);
    });
    return true;
  };
  /** @type {any} */
  let timer = null;
  const startTimer = () => {
    if (timer !== null || typeof write !== 'function' && typeof relay !== 'function' && typeof persistProbe !== 'function' && typeof activateSnapshotFallback !== 'function') return;
    timer = setIntervalFn(() => {
      activateCompatibilityBoundary(true);
      if (progressProbe.state === 'snapshot-fallback') {
        if (adjacentHeartbeatClaimed) adjacentHeartbeatClaimed = false;
        else startSnapshotRead(false);
      }
      const currentTime = now();
      if (!validTimestamp(currentTime) || !validTimestamp(lastActivityAt)) return;
      const elapsedMs = Date.parse(currentTime) - Date.parse(lastActivityAt);
      if (elapsedMs < PROGRESS_HEARTBEAT_MS) return;
      const seconds = Math.floor(elapsedMs / 1_000);
      try { if (!writerDisabled && typeof write === 'function') write(`[zcode] Still waiting for ZCode; last activity ${seconds}s ago.\n`); }
      catch { writerDisabled = true; diagnose('writer-disabled'); }
      emitRelay('waiting', 'waiting', currentTime, true);
    }, PROGRESS_HEARTBEAT_MS);
    timer?.unref?.();
  };
  const stopTimer = () => {
    if (timer === null) return;
    clearIntervalFn(timer); timer = null;
  };
  /** @param {boolean} requireAcceptedBoundary */
  const activateCompatibilityBoundary = (requireAcceptedBoundary = false) => {
    if (closed || !accepting || requireAcceptedBoundary && !acceptedBoundaryActivated || compatibilityBoundaryActivated || progressProbe.state !== 'probing') return false;
    compatibilityBoundaryActivated = true;
    /** @type {unknown} */ let activation = false;
    try { activation = typeof activateSnapshotFallback === 'function' ? activateSnapshotFallback() : false; } catch { activation = false; }
    if (typeof activation === 'function') {
      snapshotFallbackCleanup = /** @type {()=>unknown} */ (activation);
      progressProbe.state = 'snapshot-fallback'; progressProbe.snapshotFallbackActive = true;
      diagnose('conversation-snapshot-fallback');
      startSnapshotRead();
    } else {
      try { if (activation !== null && typeof activation === 'object') Promise.resolve(activation).catch(() => {}); }
      catch { /* fallback activation failures are observational */ }
      progressProbe.state = 'lifecycle-only'; progressProbe.snapshotFallbackUnavailable = true;
      diagnose('conversation-lifecycle-only');
    }
    persistProbeSnapshot(); return true;
  };
  /** @param {boolean} claimAdjacentHeartbeat */
  const startSnapshotRead = (claimAdjacentHeartbeat = true) => {
    if (closed || !accepting || progressProbe.state !== 'snapshot-fallback' || snapshotReadInFlight !== null
      || snapshotRead === null || snapshotDescriber === null) return false;
    const epoch = snapshotEpoch;
    const read = snapshotRead; const describer = snapshotDescriber;
    let operation;
    try { operation = Promise.resolve().then(() => read()); }
    catch { operation = Promise.reject(new Error('snapshot progress read failed')); }
    const tracked = operation.then(async (snapshot) => {
      if (closed || !accepting || epoch !== snapshotEpoch || progressProbe.state !== 'snapshot-fallback') return;
      const observedAt = now(); if (!validTimestamp(observedAt)) throw new Error('snapshot progress timestamp invalid');
      const events = await describer.observe(snapshot, observedAt);
      if (closed || !accepting || epoch !== snapshotEpoch || progressProbe.state !== 'snapshot-fallback') return;
      if (!Array.isArray(events)) throw new Error('snapshot progress description invalid');
      const boundedEvents = events.slice(0, MAX_PROGRESS_PENDING_EVENTS);
      if (!boundedEvents.every(validPublicEvent)) throw new Error('snapshot progress event invalid');
      for (const event of boundedEvents) {
        const sequence = observationSequence; observationSequence += 1;
        enqueueLogical({ kind: 'event', event, sequence, relaySource: 'tool' });
      }
    }).catch(() => {
      if (closed || !accepting || epoch !== snapshotEpoch || progressProbe.state !== 'snapshot-fallback') return;
      cleanupSnapshotFallback();
      progressProbe.state = 'lifecycle-only'; progressProbe.snapshotFallbackActive = false; progressProbe.snapshotFallbackUnavailable = true;
      diagnose('conversation-lifecycle-only'); persistProbeSnapshot();
    }).then(() => { if (snapshotReadInFlight === tracked) snapshotReadInFlight = null; });
    snapshotReadInFlight = tracked;
    if (claimAdjacentHeartbeat) adjacentHeartbeatClaimed = true;
    return true;
  };
  /** @param {unknown} result @param {number} epoch */
  const recordDescriptionResult = (result, epoch) => {
    if (!accepting || epoch !== descriptorEpoch) return [];
    if (!plainObject(result) || !Array.isArray(result.events)) return [];
    if (result.disposition === 'accepted' && ['initial', 'online', 'recovery'].includes(result.phase)) {
      const field = result.phase === 'initial' ? 'acceptedInitial' : result.phase === 'online' ? 'acceptedOnline' : 'acceptedRecovery';
      progressProbe[field] = saturatingIncrement(progressProbe[field]);
      const hasBoundedPublicEvent = result.events.slice(0, MAX_PROGRESS_PENDING_EVENTS).some(validPublicEvent);
      if (result.phase === 'online' && hasBoundedPublicEvent) {
        cleanupSnapshotFallback();
        progressProbe.state = 'online'; progressProbe.snapshotFallbackActive = false; progressProbe.snapshotFallbackUnavailable = false;
      }
      persistProbeSnapshot(); return result.events;
    }
    if (result.disposition === 'rejected' && PROBE_REJECTION_REASONS.includes(result.reason)) {
      progressProbe.rejected[result.reason] = saturatingIncrement(progressProbe.rejected[result.reason]);
      persistProbeSnapshot();
      const total = PROBE_REJECTION_REASONS.reduce((sum, reason) => sum + progressProbe.rejected[reason], 0);
      if (total >= PROGRESS_PROBE_REJECTION_THRESHOLD) activateCompatibilityBoundary(true);
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
  /** @param {{event:{phase:string,message:string,observedAt:string},sequence:number}} entry */
  const startArchive = (entry) => {
    if (typeof archive !== 'function' || archiveDisabled) return;
    const epoch = archiveEpoch;
    let operation;
    try { operation = Promise.resolve(archive(entry.event)); }
    catch { operation = Promise.reject(new Error('progress archive failed')); }
    const tracked = operation.catch(() => {
      if (epoch !== archiveEpoch) return;
      disableArchive(true);
    }).then(() => {
      if (epoch !== archiveEpoch) return;
      archiveInFlight = null;
      const next = archivePending.shift();
      if (next) startArchive(next);
    });
    archiveInFlight = tracked;
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
  /** @param {{phase:string,message:string,observedAt:string}} event @param {number} sequence */
  const enqueueArchive = (event, sequence) => {
    if (typeof archive !== 'function' || archiveDisabled) return;
    const entry = { event, sequence };
    if (archiveInFlight === null) startArchive(entry); else retainBounded(archivePending, entry);
  };
  /** @param {{sequence:number,phase:string,code:string,observedAt:string}} record */
  const startRelay = (record) => {
    if (typeof relay !== 'function' || relayDisabled) return;
    const epoch = relayEpoch;
    let operation;
    try { operation = Promise.resolve(relay(record)); }
    catch { operation = Promise.reject(new Error('progress relay failed')); }
    const tracked = operation.catch(() => {
      if (epoch === relayEpoch) disableRelay();
    }).then(() => {
      if (epoch !== relayEpoch) return;
      relayInFlight = null;
      const next = relayPending.shift(); if (next) startRelay(next);
    });
    relayInFlight = tracked;
  };
  /** @param {{sequence:number,phase:string,code:string,observedAt:string}} record */
  const enqueueRelay = (record) => {
    if (relayInFlight === null) { startRelay(record); return; }
    relayPending.push(record);
    if (relayPending.length <= MAX_PROGRESS_PENDING_EVENTS) return;
    const removeIndex = relayPending.findIndex((entry) => entry.phase !== 'finalizing');
    if (removeIndex !== -1) relayPending.splice(removeIndex, 1); else relayPending.pop();
  };
  /** @param {string} phase @param {string} code @param {string} observedAt @param {boolean} [repeat] */
  const emitRelay = (phase, code, observedAt, repeat = false) => {
    if (relayClosed || relayDisabled || typeof relay !== 'function' || !repeat && phase === previousRelayPhase) return;
    previousRelayPhase = phase;
    const record = { sequence: relaySequence + 1, phase, code, observedAt };
    relaySequence += 1;
    enqueueRelay(record);
    if (phase === 'finalizing') relayClosed = true;
  };
  /** @param {{phase:string,message:string,observedAt:string}} event @param {string} source */
  const relayEvent = (event, source) => {
    if (event.phase === 'starting') return emitRelay('starting', 'started', event.observedAt);
    if (event.phase === 'waiting') return emitRelay('waiting', 'waiting', event.observedAt);
    if (event.phase === 'finalizing') return emitRelay('finalizing', 'finalizing', event.observedAt);
    if (event.phase === 'editing' || source === 'editing') return emitRelay('editing', 'editing', event.observedAt);
    if (event.phase === 'verifying' || source === 'verifying') return emitRelay('verifying', 'verifying', event.observedAt);
    if (event.phase === 'investigating' || source === 'tool') return emitRelay('investigating', 'tool-active', event.observedAt);
    return emitRelay('running', 'model-active', event.observedAt);
  };
  /** @param {{phase:string,message:string,observedAt:string}} event @param {number} [sequence] @param {string} [relaySource] */
  const dispatch = (event, sequence = observationSequence++, relaySource = 'model') => {
    if (terminalSequence !== null && sequence > terminalSequence || terminalDispatched) return null;
    if (!validTimestamp(lastActivityAt) || Date.parse(event.observedAt) > Date.parse(lastActivityAt)) lastActivityAt = event.observedAt;
    const key = `${event.phase}\u0000${event.message}`;
    if (key === previousKey) return null;
    previousKey = key;
    if (event.phase === 'finalizing') terminalDispatched = true;
    enqueueWriter(event, sequence); enqueuePersist(event, sequence); enqueueArchive(event, sequence);
    if (relaySource !== 'none') relayEvent(event, relaySource);
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
    const tracked = described.then((description) => {
      if (closed) return;
      const current = accepting && epoch === descriptorEpoch;
      const events = current
        ? Array.isArray(description) ? description : recordDescriptionResult(description, epoch)
        : [];
      if (!Array.isArray(events)) return;
      item.relaySource = plainObject(description) && description.disposition === 'accepted'
        ? relaySourceForAcceptedDescriptor(item.notification)
        : 'tool';
      item.events = events.slice(0, MAX_PROGRESS_PENDING_EVENTS).filter((event) => validPublicEvent(event) && (current || event.phase !== 'finalizing'));
      for (const describedEvent of item.events) {
        if (current && describedEvent.phase === 'finalizing') {
          terminalSequence = terminalSequence === null ? item.sequence : Math.min(terminalSequence, item.sequence);
          for (const later of logicalPending) if (later.sequence > terminalSequence) {
            if (later.kind === 'descriptor') later.state = 'dropped';
          }
        }
      }
      item.state = 'ready';
    }).catch(() => {
      item.state = 'dropped';
      if (accepting && epoch === descriptorEpoch) diagnose('conversation-render-failed');
    }).then(() => {
      if (descriptorInFlight === tracked) descriptorInFlight = null;
      if (activeDescriptor === item) activeDescriptor = null;
      pumpLogical();
    });
    descriptorInFlight = tracked;
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
    enqueueLogical({ kind: 'descriptor', ...item, state: 'pending', events: [], relaySource: 'tool' });
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
          if (!active) bufferEvent(event, item.sequence, item.relaySource); else dispatch(event, item.sequence, item.relaySource);
        }
        continue;
      }
      logicalPending.shift();
      if (!active) bufferEvent(item.event, item.sequence, item.relaySource); else dispatch(item.event, item.sequence, item.relaySource);
    }
    if (activeDescriptor === null) descriptorOverflowed = false;
  };
  if (active) startTimer();

  return {
    markConversationSubscribed() {
      if (closed || !accepting || progressProbe.subscriptionAcknowledged) return false;
      progressProbe.subscriptionAcknowledged = true; persistProbeSnapshot(); return true;
    },
    activateCompatibilityBoundary: () => activateCompatibilityBoundary(false),
    /** @param {{readSnapshot:()=>Promise<unknown>,describer:{observe:(snapshot:unknown,observedAt:string)=>unknown|Promise<unknown>}}} boundary */
    activateAcceptedBoundary(boundary) {
      if (closed || acceptedBoundaryActivated) return false;
      acceptedBoundaryActivated = true;
      if (typeof boundary?.readSnapshot === 'function' && typeof boundary?.describer?.observe === 'function') {
        snapshotRead = boundary.readSnapshot; snapshotDescriber = boundary.describer;
        activateSnapshotFallback = () => {
          if (closed || snapshotRead === null || snapshotDescriber === null) return false;
          const epoch = snapshotEpoch + 1; snapshotEpoch = epoch;
          startSnapshotRead();
          let cleaned = false;
          return () => {
            if (cleaned) return;
            cleaned = true;
            if (snapshotEpoch === epoch) snapshotEpoch += 1;
            snapshotReadInFlight = null;
          };
        };
      }
      const rejectedTotal = PROBE_REJECTION_REASONS.reduce((sum, reason) => sum + progressProbe.rejected[reason], 0);
      if (rejectedTotal >= PROGRESS_PROBE_REJECTION_THRESHOLD) activateCompatibilityBoundary(true);
      return true;
    },
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
      enqueueLogical({ kind: 'event', event, sequence, relaySource: relaySourceForNotification(notification) }); return event;
    },
    /** @param {unknown} initialNotification */
    activate(initialNotification) {
      if (active || closed) return false;
      const activatedAt = now(); active = true; lastActivityAt = activatedAt; startTimer();
      persistProbeSnapshot();
      const initial = normalizeZCodeProgress(initialNotification, sessionId, activatedAt);
      if (initial) dispatch(initial, -1, relaySourceForNotification(initialNotification));
      for (const { event, sequence, relaySource } of buffered.sort((left, right) => left.sequence - right.sequence)) dispatch({ ...event, observedAt: activatedAt }, sequence, relaySource);
      buffered.length = 0; bufferedKeys.clear(); pumpLogical(); return true;
    },
    /** @param {string} kind */
    diagnose(kind) { return diagnose(kind); },
    /** Publish one terminal event only after the turn coordinator proves the outcome. @param {string} kind */
    confirmTerminal(kind) {
      if (closed || terminalSequence !== null || terminalDispatched) return null;
      const message = CONFIRMED_TERMINALS.get(kind);
      if (message === undefined) return null;
      const sequence = observationSequence; observationSequence += 1; terminalSequence = sequence;
      if (!accepting) relayClosed = false;
      return dispatch({ phase: 'finalizing', message, observedAt: now() }, sequence);
    },
    stopAccepting() {
      if (!accepting) return;
      accepting = false; relayClosed = true; stopTimer(); descriptorEpoch += 1;
      for (const item of logicalPending) if (item.kind === 'descriptor' && item.state === 'pending' && item !== activeDescriptor) item.state = 'dropped';
      descriptorOverflowed = false; pumpLogical();
    },
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
      const [writerDrained, persistenceDrained, archiveDrained, probePersistenceDrained, relayDrained] = await Promise.all([
        waitWithin(drainWriter(), sinkBudget), waitWithin(drainPersistence(), sinkBudget), waitWithin(drainArchive(), sinkBudget),
        waitWithin(drainProbePersistence(), sinkBudget), waitWithin(drainRelay(), sinkBudget),
      ]);
      if (!writerDrained || !persistenceDrained || !archiveDrained || !probePersistenceDrained || !relayDrained) {
        diagnose('progress-flush-timeout'); await Promise.resolve();
        if (!writerDrained) disableWriter();
        if (!persistenceDrained) disablePersist();
        if (!archiveDrained) disableArchive(true);
        if (!probePersistenceDrained) disableProbePersist();
        if (!relayDrained) disableRelay();
        const finalBudget = remaining(deadline);
        await Promise.all([
          writerDisabled ? Promise.resolve() : waitWithin(drainWriter(), finalBudget),
          persistDisabled ? Promise.resolve() : waitWithin(drainPersistence(), finalBudget),
          archiveDisabled ? Promise.resolve() : waitWithin(drainArchive(), finalBudget),
          probePersistInFlight === null ? Promise.resolve() : waitWithin(drainProbePersistence(), finalBudget),
          relayInFlight === null ? Promise.resolve() : waitWithin(drainRelay(), finalBudget),
        ]);
      }
      return true;
    },
    close() {
      cleanupSnapshotFallback();
      accepting = false; closed = true; relayClosed = true; buffered.length = 0; bufferedKeys.clear();
      disableProbePersist();
      descriptorEpoch += 1;
      for (const item of logicalPending) if (item.kind === 'descriptor') item.state = 'dropped';
      activeDescriptor = null; descriptorInFlight = null; pumpLogical(); logicalPending.length = 0;
      disableWriter(); disablePersist(); disableArchive(); disableRelay();
      stopTimer();
    },
  };

  /** @param {{phase:string,message:string,observedAt:string}} event */
  function bufferEvent(event, sequence = observationSequence++, relaySource = 'model') {
    const key = `${event.phase}\u0000${event.message}`;
    if (bufferedKeys.has(key)) return;
    if (buffered.length === MAX_PROGRESS_PREVIEW_ENTRIES) {
      const removed = buffered.shift();
      if (removed) bufferedKeys.delete(`${removed.event.phase}\u0000${removed.event.message}`);
    }
    buffered.push({ event, sequence, relaySource }); bufferedKeys.add(key);
  }

  async function drainDescriptors() {
    while (descriptorInFlight !== null) await descriptorInFlight;
  }

  async function drainPersistence() {
    while (persistInFlight !== null) await persistInFlight;
  }

  async function drainArchive() { while (archiveInFlight !== null) await archiveInFlight; }

  async function drainProbePersistence() {
    while (probePersistInFlight !== null) await probePersistInFlight;
  }

  async function drainWriter() { while (writerInFlight !== null) await writerInFlight; }
  async function drainRelay() { while (relayInFlight !== null) await relayInFlight; }

  function disableWriter() { writerEpoch += 1; writerDisabled = true; writerInFlight = null; writerPending.length = 0; }
  function disablePersist() { persistEpoch += 1; persistDisabled = true; persistInFlight = null; persistPending.length = 0; }
  function disableArchive(withDiagnostic = false) {
    archiveEpoch += 1; archiveDisabled = true; archiveInFlight = null; archivePending.length = 0;
    if (withDiagnostic) diagnose('archive-disabled');
  }
  function disableProbePersist() { probePersistInFlight = null; probePersistPending = null; }
  function disableRelay() { relayEpoch += 1; relayDisabled = true; relayInFlight = null; relayPending.length = 0; }
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

/** @param {unknown} notification */
function relaySourceForNotification(notification) {
  if (!plainObject(notification) || !plainObject(notification.params)) return 'model';
  return ['tool_call_started', 'tool_call_progress', 'tool_call_result'].includes(notification.params.reason) ? 'tool' : 'model';
}

/** Derive only a fixed category after the conversation describer accepted the frame. @param {unknown} notification */
function relaySourceForAcceptedDescriptor(notification) {
  try {
    if (!plainObject(notification) || !plainObject(notification.params) || !plainObject(notification.params.frame)
      || !plainObject(notification.params.frame.payload) || !Array.isArray(notification.params.frame.payload.deltas)
      || notification.params.frame.payload.deltas.length > 64) return 'tool';
    let verifying = false;
    for (const delta of notification.params.frame.payload.deltas) {
      const row = plainObject(delta) && plainObject(delta.row) ? delta.row : null;
      if (row?.kind !== 'toolCall' || typeof row.toolName !== 'string' || Buffer.byteLength(row.toolName) > 256) continue;
      if (row.toolName === 'Edit' || row.toolName === 'Write') return 'editing';
      if (['Verify', 'Verification', 'Test', 'Tests', 'Lint', 'Typecheck'].includes(row.toolName)) verifying = true;
      if (row.toolName === 'Bash' && plainObject(row.input) && looksLikeVerificationCommand(row.input.command)) verifying = true;
    }
    return verifying ? 'verifying' : 'tool';
  } catch { return 'tool'; }
}

/** @param {unknown} value */
function looksLikeVerificationCommand(value) {
  return typeof value === 'string' && Buffer.byteLength(value) <= 4_096
    && /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(value);
}

/** @param {unknown} value @returns {value is Record<string,any>} */
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
