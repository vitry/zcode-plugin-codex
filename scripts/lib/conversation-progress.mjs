import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const PREVIEW_LIMIT = 96;
const START_STATUSES = new Set(['inputStreaming', 'pendingApproval', 'running']);
const SUCCESS_STATUSES = new Set(['success']);
const FAILURE_STATUSES = new Set(['error', 'cancelled']);
const TOOL_STATUSES = new Set([...START_STATUSES, ...SUCCESS_STATUSES, ...FAILURE_STATUSES]);
const TURN_STATES = new Set(['running', 'completedSuccess', 'completedInterrupted', 'failed']);
const MAX_WIRE_TEXT = 1_048_576;
const MAX_DURATION_MS = 86_400_000;
const MAX_PUBLIC_MESSAGE_BYTES = 256;
const MAX_DELTAS_PER_FRAME = 500;
const MAX_PUBLIC_EVENTS_PER_FRAME = 64;
const MAX_TRACKED_ROWS = 256;
const MAX_PENDING_OBSERVATIONS = 4;
const MAX_OPAQUE_JSON_DEPTH = 64;
const MAX_OPAQUE_JSON_NODES = 65_536;
const PATH_RESOLUTION_TIMEOUT_MS = 100;
const CONVERSATION_WIRE_VERSION = 3;
const SUPPORTED_ROW_KINDS = new Set(['toolCall', 'turnHeader']);
/** @typedef {{phase:string,message:string,observedAt:string}} PublicProgressEvent */
/** @typedef {{op:string,row:Record<string,any>|null,fromRowId?:number}} ValidatedDelta */
/** @typedef {{kind:'succeeded'|'interrupted'|'failed',turnId:string}|{kind:'unavailable'}} TurnTerminalResult */
/** @typedef {{disposition:'accepted',phase:'initial'|'online'|'recovery',events:PublicProgressEvent[]}|{disposition:'rejected'|'ignored',reason:string,events:PublicProgressEvent[]}} ObservationResult */
/** @param {string} reason @returns {ObservationResult} */
const rejected = (reason) => ({ disposition: 'rejected', reason, events: [] });
/** @param {string} reason @returns {ObservationResult} */
const ignored = (reason) => ({ disposition: 'ignored', reason, events: [] });
/** @param {'initial'|'online'|'recovery'} phase @param {PublicProgressEvent[]} [events] @returns {ObservationResult} */
const accepted = (phase, events = []) => ({ disposition: 'accepted', phase, events });

/** @param {unknown} value @param {number} [limit] */
export function normalizePreview(value, limit = PREVIEW_LIMIT) {
  if (typeof value !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || value.length > MAX_WIRE_TEXT) return '';
  const clean = [...value].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code >= 127 && code <= 159 ? ' ' : character;
  }).join('').replace(/\s+/gu, ' ').trim();
  const points = [...clean];
  return points.length <= limit ? clean : `${points.slice(0, Math.max(0, limit - 1)).join('')}…`;
}

/**
 * @param {{sessionId:string,subscriptionId:string,workspace:string}} options
 * @param {{resolvePath?:(value:unknown,workspaceRoot:string)=>Promise<string|null>,pathTimeoutMs?:number}} [dependencies]
 * @returns {Promise<{observe:(notification:unknown,observedAt:string)=>Promise<ObservationResult>,beginTurnBoundary:()=>void,waitForTurnTerminal:()=>Promise<TurnTerminalResult>,terminalAuthorityState:()=>string,markGap:()=>void,markTerminal:()=>void}>}
 */
export async function createConversationProgressDescriber({ sessionId, subscriptionId, workspace }, dependencies = {}) {
  const workspaceRoot = await realpath(resolve(workspace));
  const topic = `conversation/${sessionId}`;
  const resolvePath = dependencies.resolvePath ?? containedRelativePath;
  const requestedPathTimeout = dependencies.pathTimeoutMs;
  const pathTimeoutMs = Number.isSafeInteger(requestedPathTimeout) && /** @type {number} */ (requestedPathTimeout) >= 1 ? /** @type {number} */ (requestedPathTimeout) : PATH_RESOLUTION_TIMEOUT_MS;
  /** @type {Map<string,{rowId:number,started:boolean,terminal:boolean,message:string|null}>} */
  const toolStates = new Map();
  const rowStates = new Map();
  const seenTurnIdentities = new Set();
  /** @type {Array<{notification:unknown,observedAt:string,resolve:(result:ObservationResult)=>void}>} */
  const pending = [];
  let active = false;
  /** @type {number|undefined} */
  let lastOrdinal;
  /** @type {number|undefined} */
  let lastSeq;
  let terminal = false; let needsRecovery = false;
  let authorityState = 'idle';
  /** @type {{rowId:number,turnId:string}|null} */ let authoritativeTurn = null;
  /** @type {(result:TurnTerminalResult)=>void} */ let resolveTurnTerminal;
  /** @type {Promise<TurnTerminalResult>} */ let turnTerminal = new Promise((resolveResult) => { resolveTurnTerminal = resolveResult; });

  /** @type {{observe:(notification:unknown,observedAt:string)=>Promise<ObservationResult>,beginTurnBoundary:()=>void,waitForTurnTerminal:()=>Promise<TurnTerminalResult>,terminalAuthorityState:()=>string,markGap:()=>void,markTerminal:()=>void}} */
  const api = {
    observe(notification, observedAt) {
      if (terminal) return Promise.resolve(ignored('terminal'));
      return new Promise((resolveResult) => {
        if (active && pending.length >= MAX_PENDING_OBSERVATIONS) { markGap(); resolveResult(ignored('overflow')); return; }
        pending.push({ notification, observedAt, resolve: resolveResult });
        drain();
      });
    },
    beginTurnBoundary,
    waitForTurnTerminal: prepareTurnTerminalWait,
    terminalAuthorityState: () => authorityState,
    markGap,
    markTerminal: latchTerminal,
  };
  return api;

  function resetAuthorityCycle() {
    turnTerminal = new Promise((resolveResult) => { resolveTurnTerminal = resolveResult; });
    authoritativeTurn = null; authorityState = 'idle';
  }
  function prepareTurnTerminalWait() {
    if (authorityState === 'resolved') {
      resetAuthorityCycle(); if (terminal) makeAuthorityUnavailable();
    }
    return turnTerminal;
  }
  function beginTurnBoundary() {
    if (authorityState === 'resolved') resetAuthorityCycle();
    if (authorityState === 'unavailable') return;
    if (terminal) { makeAuthorityUnavailable(); return; }
    authoritativeTurn = null; authorityState = 'waiting-running';
  }
  function makeAuthorityUnavailable() {
    if (authorityState === 'resolved' || authorityState === 'unavailable') return;
    authorityState = 'unavailable'; authoritativeTurn = null; resolveTurnTerminal({ kind: 'unavailable' });
  }
  /** @param {'succeeded'|'interrupted'|'failed'} kind @param {string} turnId */
  function resolveAuthoritativeTerminal(kind, turnId) {
    if (authorityState !== 'waiting-terminal') return;
    authorityState = 'resolved'; resolveTurnTerminal({ kind, turnId });
  }
  function markGap() { if (!terminal) { needsRecovery = true; makeAuthorityUnavailable(); } }
  function latchTerminal() { terminal = true; makeAuthorityUnavailable(); while (pending.length > 0) pending.shift()?.resolve(ignored('terminal')); }

  function drain() {
    if (active || pending.length === 0) return;
    const item = pending.shift(); if (!item) return;
    active = true;
    Promise.resolve().then(() => observeFrame(item.notification, item.observedAt)).catch(() => rejected('row-shape')).then((result) => {
      if (result.disposition === 'rejected' && result.reason !== 'topic') makeAuthorityUnavailable();
      item.resolve(result);
    }).finally(() => { active = false; drain(); });
  }

  /** @param {unknown} notification @param {unknown} observedAt @returns {Promise<ObservationResult>} */
  async function observeFrame(notification, observedAt) {
    if (terminal) return ignored('terminal');
    if (!validObservedAt(observedAt)) return rejected('envelope-shape');
    const publicObservedAt = /** @type {string} */ (observedAt);
    const validated = validateNotification(notification, topic, subscriptionId, sessionId);
    if (!validated.ok) return rejected(validated.reason);
    const frame = validated.value;
    if (frame.deliveryKind === 'initial') {
      if (lastOrdinal !== undefined) return ignored('stale');
      lastOrdinal = frame.ordinal; lastSeq = frame.toSeq; needsRecovery = false;
      resetLifecycleState();
      absorbSnapshotTurnIdentities(frame.snapshotTurnIdentities);
      return accepted('initial');
    }
    if (frame.deliveryKind === 'recovery') {
      const repeatedDeltas = lastSeq !== undefined && frame.toSeq === lastSeq && frame.payloadKind === 'deltas' && frame.deltas.length > 0;
      if (lastOrdinal !== undefined && repeatedDeltas && frame.ordinal > lastOrdinal) { lastOrdinal = frame.ordinal; return ignored('stale'); }
      if (lastOrdinal !== undefined && (frame.ordinal <= lastOrdinal || frame.toSeq < /** @type {number} */ (lastSeq))) {
        return ignored('stale');
      }
      if (lastSeq !== undefined && frame.payloadKind === 'deltas' && frame.fromSeq > lastSeq) {
        needsRecovery = true; return rejected('sequence');
      }
      lastOrdinal = frame.ordinal; lastSeq = frame.toSeq; needsRecovery = false;
      if (frame.payloadKind === 'snapshot') { resetLifecycleState(); absorbSnapshotTurnIdentities(frame.snapshotTurnIdentities); }
      else absorbRecovery(frame.deltas);
      return accepted('recovery');
    }
    if (frame.payloadKind === 'snapshot') {
      if (lastOrdinal !== undefined && frame.ordinal <= lastOrdinal) return ignored('stale');
      if (authorityState === 'waiting-running' || authorityState === 'waiting-terminal') makeAuthorityUnavailable();
      lastOrdinal = frame.ordinal; lastSeq = frame.toSeq; needsRecovery = false; resetLifecycleState();
      absorbSnapshotTurnIdentities(frame.snapshotTurnIdentities);
      return accepted('online');
    }
    if (needsRecovery) return ignored('recovery-required');
    if (lastOrdinal !== undefined && frame.ordinal <= lastOrdinal) return ignored('stale');
    const sequenceGap = lastOrdinal !== undefined
      && (frame.ordinal !== lastOrdinal + 1 || frame.fromSeq !== lastSeq);
    if (sequenceGap) { needsRecovery = true; return rejected('sequence'); }
    const stagedToolStates = new Map(toolStates);
    const stagedRowStates = new Map(rowStates);
    const staged = [];
    for (const delta of frame.deltas) {
      if (delta.op === 'row.removed') {
        applyRemoval(/** @type {number} */ (delta.fromRowId), stagedToolStates, stagedRowStates);
        continue;
      }
      if (!delta.row) continue;
      if (delta.row.kind === 'toolCall') {
        if (staged.length >= MAX_PUBLIC_EVENTS_PER_FRAME) { absorbToolState(delta.row, stagedToolStates); continue; }
        const event = await describeTool(delta.row, stagedToolStates, workspaceRoot, publicObservedAt, resolvePath, pathTimeoutMs, () => terminal || needsRecovery);
        if (terminal || needsRecovery) return ignored(terminal ? 'terminal' : 'recovery-required');
        if (event && staged.length < MAX_PUBLIC_EVENTS_PER_FRAME) staged.push(event);
      } else {
        const row = delta.row;
        const previous = stagedRowStates.get(row.rowId);
        const turnIdentity = `${row.rowId}\u0000${row.turnId}`;
        const identitySeen = seenTurnIdentities.has(turnIdentity);
        const identityTrackable = identitySeen || seenTurnIdentities.size < MAX_TRACKED_ROWS;
        if (!identitySeen && identityTrackable) seenTurnIdentities.add(turnIdentity);
        if (row.state === 'completedSuccess' || row.state === 'failed' || row.state === 'completedInterrupted') {
          if (previous !== undefined || stagedRowStates.size < MAX_TRACKED_ROWS) stagedRowStates.set(row.rowId, row.state);
          const trackedTurn = authoritativeTurn;
          if (authorityState === 'waiting-terminal' && trackedTurn?.rowId === row.rowId && trackedTurn?.turnId === row.turnId) {
            if (staged.length < MAX_PUBLIC_EVENTS_PER_FRAME) staged.push({ phase: 'finalizing', message: row.state === 'completedSuccess' ? 'ZCode turn completed.' : 'ZCode turn ended without success.', observedAt: publicObservedAt });
            resolveAuthoritativeTerminal(row.state === 'completedSuccess' ? 'succeeded' : row.state === 'completedInterrupted' ? 'interrupted' : 'failed', row.turnId);
          }
          continue;
        }
        if (previous === undefined && stagedRowStates.size >= MAX_TRACKED_ROWS) {
          if (row.state === 'running' && row.origin === 'userInput' && authorityState === 'waiting-running') makeAuthorityUnavailable();
          continue;
        }
        stagedRowStates.set(row.rowId, row.state);
        if (previous === row.state) continue;
        if (row.state === 'running' && row.origin === 'userInput' && authorityState === 'waiting-running' && !identitySeen) {
          if (!identityTrackable) { makeAuthorityUnavailable(); continue; }
          authoritativeTurn = { rowId: row.rowId, turnId: row.turnId }; authorityState = 'waiting-terminal';
        }
        if (row.state === 'running' && previous === undefined && staged.length < MAX_PUBLIC_EVENTS_PER_FRAME) staged.push({ phase: 'starting', message: 'ZCode turn started.', observedAt: publicObservedAt });
      }
    }
    if (terminal || needsRecovery) return ignored(terminal ? 'terminal' : 'recovery-required');
    replaceMap(toolStates, stagedToolStates); replaceMap(rowStates, stagedRowStates);
    lastOrdinal = frame.ordinal; lastSeq = frame.toSeq;
    return accepted('online', staged);
  }

  function resetLifecycleState() { toolStates.clear(); rowStates.clear(); seenTurnIdentities.clear(); }

  /** @param {string[]|null} identities */
  function absorbSnapshotTurnIdentities(identities) {
    if (identities === null) { makeAuthorityUnavailable(); return; }
    for (const identity of identities) seenTurnIdentities.add(identity);
  }

  /** @template K,V @param {Map<K,V>} target @param {Map<K,V>} replacement */
  function replaceMap(target, replacement) {
    target.clear();
    for (const [key, value] of replacement) target.set(key, value);
  }

  /** @param {number} fromRowId @param {Map<string,{rowId:number,started:boolean,terminal:boolean,message:string|null}>} [targetToolStates] @param {Map<number,string>} [targetRowStates] */
  function applyRemoval(fromRowId, targetToolStates = toolStates, targetRowStates = rowStates) {
    for (const [toolCallId, state] of targetToolStates) if (state.rowId >= fromRowId) targetToolStates.delete(toolCallId);
    for (const rowId of targetRowStates.keys()) if (rowId >= fromRowId) targetRowStates.delete(rowId);
  }

  /** @param {any} row @param {Map<string,{rowId:number,started:boolean,terminal:boolean,message:string|null}>} [states] */
  function absorbToolState(row, states = toolStates) {
    const prior = states.get(row.toolCallId) ?? { rowId: row.rowId, started: false, terminal: false, message: null };
    if (prior.terminal || !states.has(row.toolCallId) && states.size >= MAX_TRACKED_ROWS) return;
    if (START_STATUSES.has(row.status)) states.set(row.toolCallId, { rowId: row.rowId, started: true, terminal: false, message: prior.message });
    else states.set(row.toolCallId, { rowId: row.rowId, started: prior.started, terminal: true, message: prior.message });
  }

  /** @param {ValidatedDelta[]} deltas */
  function absorbRecovery(deltas) {
    for (const delta of deltas) {
      if (delta.op === 'row.removed') { applyRemoval(/** @type {number} */ (delta.fromRowId)); continue; }
      const row = delta.row; if (!row) continue;
      if (row.kind === 'toolCall') { absorbToolState(row); continue; }
      if (row.state === 'completedSuccess' || row.state === 'failed' || row.state === 'completedInterrupted') {
        if (rowStates.has(row.rowId) || rowStates.size < MAX_TRACKED_ROWS) rowStates.set(row.rowId, row.state);
        continue;
      }
      if (!rowStates.has(row.rowId) && rowStates.size >= MAX_TRACKED_ROWS) continue;
      rowStates.set(row.rowId, row.state);
    }
  }
}

/**
 * Buffers only the small subscribe-response race window; it has no protocol
 * interpretation until the server-provided subscription id is validated.
 * @param {{sessionId:string,workspace:string}} options
 */
export function createDeferredConversationProgressObserver({ sessionId, workspace }) {
  /** @type {Awaited<ReturnType<typeof createConversationProgressDescriber>>|undefined} */ let describer;
  /** @type {Array<{notification:unknown,observedAt:string,resolve:(result:ObservationResult)=>void}>} */ const buffered = [];
  let binding = false; let disabled = false; let terminal = false; let prebindGap = false;
  let authorityState = 'idle';
  /** @type {(result:TurnTerminalResult)=>void} */ let resolveTurnTerminal;
  /** @type {Promise<TurnTerminalResult>} */ let turnTerminal = new Promise((resolveResult) => { resolveTurnTerminal = resolveResult; });
  /** @type {Awaited<ReturnType<typeof createConversationProgressDescriber>>|undefined} */ let bridgedDescriber;
  /** @param {string} [reason] */
  const resolveBufferedEmpty = (reason = terminal ? 'terminal' : 'disabled') => { while (buffered.length > 0) buffered.shift()?.resolve(ignored(reason)); };
  const makeAuthorityUnavailable = () => {
    if (authorityState === 'resolved' || authorityState === 'unavailable') return;
    authorityState = 'unavailable'; resolveTurnTerminal({ kind: 'unavailable' });
  };
  const bridgeAuthority = () => {
    if (!describer || bridgedDescriber === describer) return;
    bridgedDescriber = describer;
    describer.waitForTurnTerminal().then((result) => {
      if (authorityState === 'resolved' || authorityState === 'unavailable') return;
      authorityState = result.kind === 'unavailable' ? 'unavailable' : 'resolved'; resolveTurnTerminal(result);
    });
  };
  const resetAuthorityCycle = () => {
    turnTerminal = new Promise((resolveResult) => { resolveTurnTerminal = resolveResult; });
    bridgedDescriber = undefined; authorityState = 'idle';
  };
  const prepareTurnTerminalWait = () => {
    if (authorityState === 'resolved') {
      resetAuthorityCycle();
      if (terminal || disabled) makeAuthorityUnavailable();
    }
    return turnTerminal;
  };
  return /** @type {{observe:(notification:unknown,observedAt:string)=>Promise<ObservationResult>,bind:(subscriptionId:string)=>Promise<void>,beginTurnBoundary:()=>void,waitForTurnTerminal:()=>Promise<TurnTerminalResult>,terminalAuthorityState:()=>string,fail:()=>void,markGap:()=>void,markTerminal:()=>void}} */ ({
    observe(notification, observedAt) {
      if (terminal || disabled) return Promise.resolve(ignored(terminal ? 'terminal' : 'disabled'));
      if (describer && !binding) return describer.observe(notification, observedAt).then((result) => {
        authorityState = describer?.terminalAuthorityState() ?? authorityState;
        return result;
      });
      if (buffered.length >= MAX_PENDING_OBSERVATIONS) {
        if (describer) describer.markGap(); else prebindGap = true;
        makeAuthorityUnavailable();
        return Promise.resolve(ignored('overflow'));
      }
      return new Promise((resolveResult) => buffered.push({ notification, observedAt, resolve: resolveResult }));
    },
    async bind(subscriptionId) {
      if (terminal || disabled || describer) return;
      binding = true;
      try {
        describer = await createConversationProgressDescriber({ sessionId, subscriptionId, workspace });
        if (authorityState === 'waiting-running') describer.beginTurnBoundary();
        bridgeAuthority();
        while (!terminal && !disabled && buffered.length > 0) {
          const item = buffered.shift(); if (!item) break;
          item.resolve(await describer.observe(item.notification, item.observedAt));
          authorityState = describer.terminalAuthorityState();
        }
        if (prebindGap) describer.markGap();
      } catch (error) {
        disabled = true; makeAuthorityUnavailable(); resolveBufferedEmpty(); throw error;
      } finally { binding = false; if (terminal || disabled) resolveBufferedEmpty(); }
    },
    beginTurnBoundary() {
      if (terminal || disabled) { makeAuthorityUnavailable(); return; }
      if (authorityState === 'resolved') resetAuthorityCycle();
      if (authorityState === 'unavailable') return;
      authorityState = 'waiting-running';
      describer?.beginTurnBoundary(); bridgeAuthority();
    },
    waitForTurnTerminal: prepareTurnTerminalWait,
    terminalAuthorityState: () => authorityState,
    fail() { disabled = true; makeAuthorityUnavailable(); resolveBufferedEmpty(); },
    markGap() {
      if (terminal || disabled) return;
      if (describer) describer.markGap();
      else if (prebindGap) return;
      else prebindGap = true;
      makeAuthorityUnavailable();
      resolveBufferedEmpty('recovery-required');
    },
    markTerminal() { terminal = true; describer?.markTerminal(); makeAuthorityUnavailable(); resolveBufferedEmpty(); },
  });
}

/** @param {unknown} notification @param {string} topic @param {string} subscriptionId @param {string} sessionId @returns {{ok:true,value:{deliveryKind:'initial'|'online'|'recovery',ordinal:number,fromSeq:number,toSeq:number,payloadKind:'snapshot'|'deltas',deltas:ValidatedDelta[],snapshotTurnIdentities:string[]|null}}|{ok:false,reason:string}} */
function validateNotification(notification, topic, subscriptionId, sessionId) {
  if (!boundedOpaqueJsonObject(notification)) return { ok: false, reason: 'envelope-shape' };
  const upstream = /** @type {Record<string,any>} */ (notification);
  if (upstream.method !== 'v4/conversation/frame' || !plainObject(upstream.params)) return { ok: false, reason: 'envelope-shape' };
  const wire = upstream.params;
  if (!hasRequiredKeys(wire, ['wireVersion', 'kind', 'deliveryKind', 'logicalFrameOrdinal', 'topic', 'subscriptionId', 'frame'])) return { ok: false, reason: 'envelope-shape' };
  if (wire.wireVersion !== CONVERSATION_WIRE_VERSION) return { ok: false, reason: 'wire-version' };
  if (wire.topic !== topic || wire.subscriptionId !== subscriptionId) return { ok: false, reason: 'topic' };
  if (wire.kind !== 'complete'
    || !['initial', 'online', 'recovery'].includes(wire.deliveryKind)
    || !plainObject(wire.frame)) return { ok: false, reason: 'envelope-shape' };
  if (!positiveInteger(wire.logicalFrameOrdinal)) return { ok: false, reason: 'sequence' };
  const frame = wire.frame;
  if (!hasRequiredKeys(frame, ['topic', 'subscriptionId', 'fromSeq', 'toSeq', 'payload'])) return { ok: false, reason: 'envelope-shape' };
  if (frame.topic !== topic || frame.subscriptionId !== subscriptionId) return { ok: false, reason: 'topic' };
  if (!nonnegativeInteger(frame.fromSeq) || !nonnegativeInteger(frame.toSeq) || frame.toSeq < frame.fromSeq) return { ok: false, reason: 'sequence' };
  if (!boundedOpaqueJsonObject(frame.payload)) return { ok: false, reason: 'envelope-shape' };
  if (frame.payload.kind === 'snapshot') {
    if (!hasRequiredKeys(frame.payload, ['kind', 'snapshot']) || !validSnapshot(frame.payload.snapshot, sessionId, frame.fromSeq, frame.toSeq)) return { ok: false, reason: 'envelope-shape' };
    return { ok: true, value: { deliveryKind: wire.deliveryKind, ordinal: wire.logicalFrameOrdinal, fromSeq: frame.fromSeq, toSeq: frame.toSeq, payloadKind: 'snapshot', deltas: [], snapshotTurnIdentities: snapshotTurnIdentities(frame.payload.snapshot) } };
  }
  if (!hasRequiredKeys(frame.payload, ['kind', 'deltas']) || frame.payload.kind !== 'deltas'
    || !Array.isArray(frame.payload.deltas) || frame.payload.deltas.length > MAX_DELTAS_PER_FRAME) return { ok: false, reason: 'envelope-shape' };
  const deltas = [];
  for (const value of frame.payload.deltas) {
    const delta = validateDelta(value); if (!delta.ok) return delta; deltas.push(delta.value);
  }
  return { ok: true, value: { deliveryKind: wire.deliveryKind, ordinal: wire.logicalFrameOrdinal, fromSeq: frame.fromSeq, toSeq: frame.toSeq, payloadKind: 'deltas', deltas, snapshotTurnIdentities: [] } };
}

/** @param {unknown} value @returns {{ok:true,value:ValidatedDelta}|{ok:false,reason:string}} */
function validateDelta(value) {
  if (!plainObject(value) || typeof value.op !== 'string') return { ok: false, reason: 'row-shape' };
  if (value.op === 'row.removed') return hasRequiredKeys(value, ['op', 'fromRowId']) && wireNumber(value.fromRowId)
    ? { ok: true, value: { op: value.op, row: null, fromRowId: value.fromRowId } } : { ok: false, reason: 'row-shape' };
  if (value.op === 'row.delta' || value.op === 'state.updated') return { ok: true, value: { op: value.op, row: null } };
  if (!['row.appended', 'row.upserted'].includes(value.op) || !hasRequiredKeys(value, ['op', 'row'])) return { ok: false, reason: 'row-shape' };
  if (!plainObject(value.row) || !safeRowEnvelope(value.row)) return { ok: false, reason: 'row-shape' };
  if (!SUPPORTED_ROW_KINDS.has(value.row.kind)) return { ok: true, value: { op: value.op, row: null } };
  const row = validateRow(value.row); return row ? { ok: true, value: { op: value.op, row } } : { ok: false, reason: 'row-shape' };
}

/** @param {unknown} value @param {string} sessionId @param {number} fromSeq @param {number} toSeq */
function validSnapshot(value, sessionId, fromSeq, toSeq) {
  if (!boundedOpaqueJsonObject(value)) return false;
  const snapshot = /** @type {Record<string,any>} */ (value);
  return hasRequiredKeys(snapshot, ['protocolVersion', 'seq', 'sessionId'])
    && snapshot.protocolVersion === 1 && snapshot.sessionId === sessionId
    && wireNumber(snapshot.seq) && snapshot.seq === toSeq && fromSeq === 0;
}

/** @param {unknown} value @returns {string[]|null} */
function snapshotTurnIdentities(value) {
  const snapshot = /** @type {Record<string,any>} */ (value);
  const rows = snapshot.rows;
  if (!plainObject(rows) || !Array.isArray(rows.window) || rows.window.length > MAX_TRACKED_ROWS
    || !nonnegativeInteger(rows.totalCount) || rows.totalCount !== rows.window.length) return null;
  const window = rows.window;
  const identities = [];
  for (const row of window) {
    if (!plainObject(row) || row.kind !== 'turnHeader') continue;
    if (!wireNumber(row.rowId) || !boundedIdentifier(row.turnId, 1024)) return null;
    identities.push(`${row.rowId}\u0000${row.turnId}`);
  }
  return identities;
}

/** @param {Record<string,any>} row */
function safeRowEnvelope(row) {
  return boundedIdentifier(row.kind, 256) && boundedOpaqueJsonObject(row);
}

/** @param {Record<string,any>} row */
function validateRow(row) {
  if (row.kind === 'toolCall') {
    const required = ['rowId', 'kind', 'toolCallId', 'toolName', 'status'];
    if (!hasRequiredKeys(row, required) || !wireNumber(row.rowId) || !boundedIdentifier(row.toolCallId, 1024)
      || !boundedIdentifier(row.toolName, 256) || !TOOL_STATUSES.has(row.status)) return null;
    return row;
  }
  if (row.kind === 'turnHeader') {
    if (!hasRequiredKeys(row, ['rowId', 'kind', 'turnId', 'origin', 'state']) || !wireNumber(row.rowId)
      || !boundedIdentifier(row.turnId, 1024) || !boundedIdentifier(row.origin, 256) || !TURN_STATES.has(row.state)) return null;
    return row;
  }
  return null;
}

/** @param {any} row @param {Map<string,{rowId:number,started:boolean,terminal:boolean,message:string|null}>} states @param {string} workspaceRoot @param {string} observedAt @param {(value:unknown,root:string)=>Promise<string|null>} resolvePath @param {number} timeoutMs @param {()=>boolean} isTerminal */
async function describeTool(row, states, workspaceRoot, observedAt, resolvePath, timeoutMs, isTerminal) {
  const key = row.toolCallId;
  const prior = states.get(key) ?? { rowId: row.rowId, started: false, terminal: false, message: null };
  if (prior.terminal) return null;
  const status = row.status;
  if (START_STATUSES.has(status)) {
    if (prior.started || !states.has(key) && states.size >= MAX_TRACKED_ROWS) return null;
    const message = fitProgressMessage(await formatToolStartMessage(row, workspaceRoot, resolvePath, timeoutMs));
    if (isTerminal()) return null;
    states.set(key, { rowId: row.rowId, started: true, terminal: false, message });
    return { phase: status === 'pendingApproval' ? 'waiting' : 'running', message, observedAt };
  }
  if (!SUCCESS_STATUSES.has(status) && !FAILURE_STATUSES.has(status)) return null;
  if (!states.has(key) && states.size >= MAX_TRACKED_ROWS) return null;
  const startMessageValue = prior.message ?? await formatToolStartMessage(row, workspaceRoot, resolvePath, timeoutMs);
  if (isTerminal()) return null;
  states.set(key, { rowId: row.rowId, started: prior.started, terminal: true, message: startMessageValue });
  const duration = durationSuffix(row.startedAt, row.endedAt);
  return { phase: 'running', message: fitProgressMessage(formatToolTerminalMessage(row, startMessageValue, SUCCESS_STATUSES.has(status), duration)), observedAt };
}

/** @param {any} row @param {string} workspaceRoot @param {(value:unknown,root:string)=>Promise<string|null>} resolvePath @param {number} timeoutMs */
export async function formatToolStartMessage(row, workspaceRoot, resolvePath = containedRelativePath, timeoutMs = PATH_RESOLUTION_TIMEOUT_MS, allowTextPreviews = true) {
  return formatToolStartMessageWithOptions(row, workspaceRoot, { resolvePath, timeoutMs, allowTextPreviews });
}

/** @param {any} row @param {string} workspaceRoot @param {{resolvePath:(value:unknown,root:string)=>Promise<string|null>,timeoutMs:number,allowTextPreviews:boolean}} options */
async function formatToolStartMessageWithOptions(row, workspaceRoot, { resolvePath, timeoutMs, allowTextPreviews }) {
  const toolName = normalizePreview(row.toolName, 64);
  const input = plainObject(row.input) ? row.input : {};
  if (!toolName) return 'Running a tool.';
  if (toolName === 'Bash') { const preview = allowTextPreviews ? normalizePreview(input.command) : ''; return preview ? `Running command: ${preview}.` : 'Running tool: Bash.'; }
  if (['Read', 'Edit', 'Write'].includes(toolName)) {
    const path = await boundedPath(resolvePath, input.file_path, workspaceRoot, timeoutMs);
    if (!path) return `Running tool: ${toolName}.`;
    return `${toolName === 'Read' ? 'Reading' : toolName === 'Edit' ? 'Editing' : 'Writing'}: ${path}.`;
  }
  if (toolName === 'Grep') { const preview = allowTextPreviews ? normalizePreview(input.pattern) : ''; return preview ? `Searching files: ${preview}.` : 'Running tool: Grep.'; }
  if (toolName === 'Glob') { const preview = allowTextPreviews ? normalizePreview(input.pattern) : ''; return preview ? `Finding files: ${preview}.` : 'Running tool: Glob.'; }
  if (toolName === 'WebSearch') { const preview = allowTextPreviews ? normalizePreview(input.query) : ''; return preview ? `Searching the web: ${preview}.` : 'Running tool: WebSearch.'; }
  return `Running tool: ${toolName}.`;
}

/** @param {(value:unknown,root:string)=>Promise<string|null>} resolvePath @param {unknown} value @param {string} root @param {number} timeoutMs */
async function boundedPath(resolvePath, value, root, timeoutMs) {
  let timer;
  try {
    const operation = Promise.resolve().then(() => resolvePath(value, root)); operation.catch(() => {});
    return await Promise.race([operation, new Promise((resolveResult) => { timer = setTimeout(() => resolveResult(null), timeoutMs); })]);
  } catch { return null; } finally { if (timer) clearTimeout(timer); }
}

/** @param {any} row @param {string} started @param {boolean} succeeded @param {string} duration */
export function formatToolTerminalMessage(row, started, succeeded, duration = durationSuffix(row.startedAt, row.endedAt)) {
  const state = succeeded ? 'completed' : 'failed';
  if (started.startsWith('Running command: ')) {
    const value = started.slice(17); const command = value.endsWith('.') ? value.slice(0, -1) : value;
    return `Command ${state}: ${command}${duration}.`;
  }
  const toolName = normalizePreview(row.toolName, 64);
  return `${toolName || 'Tool'} ${state}${duration}.`;
}

/** @param {unknown} startedAt @param {unknown} endedAt */
function durationSuffix(startedAt, endedAt) {
  if (!wireTimestamp(startedAt) || !wireTimestamp(endedAt)) return '';
  const duration = /** @type {number} */ (endedAt) - /** @type {number} */ (startedAt);
  return duration >= 0 && duration <= MAX_DURATION_MS ? ` (${duration}ms)` : '';
}

/** @param {string} message */
export function fitProgressMessage(message) {
  if (Buffer.byteLength(message) <= MAX_PUBLIC_MESSAGE_BYTES) return message;
  let output = '';
  for (const character of message) {
    if (Buffer.byteLength(`${output}${character}…`) > MAX_PUBLIC_MESSAGE_BYTES) break;
    output += character;
  }
  return output ? `${output}…` : 'ZCode reported activity.';
}

/** @param {unknown} value @param {string} workspaceRoot */
export async function containedRelativePath(value, workspaceRoot) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return null;
  const candidate = resolve(workspaceRoot, value); let existing = candidate;
  while (true) {
    try { await lstat(existing); break; }
    catch (error) {
      if ((/** @type {NodeJS.ErrnoException} */ (error))?.code !== 'ENOENT') return null;
      const parent = dirname(existing); if (parent === existing) return null; existing = parent;
    }
  }
  let canonicalAncestor;
  try { canonicalAncestor = await realpath(existing); } catch { return null; }
  if (!isContained(workspaceRoot, canonicalAncestor)) return null;
  const canonicalCandidate = resolve(canonicalAncestor, relative(existing, candidate));
  const relativePath = relative(workspaceRoot, canonicalCandidate);
  if (!relativePath || isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) return null;
  return relativePath.split(sep).join('/');
}

/** @param {string} root @param {string} candidate */
function isContained(root, candidate) { const value = relative(root, candidate); return value === '' || !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`); }
/** @param {Record<string,any>} value @param {string[]} required */
function hasRequiredKeys(value, required) { return required.every((key) => Object.hasOwn(value, key)); }
/** @param {unknown} value @param {number} max */
function boundedIdentifier(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max && !hasControl(value); }
/** @param {unknown} value */
function boundedOpaqueJsonObject(value) {
  if (!plainObject(value)) return false;
  if (!encodedJsonWithinBound(value)) return false;
  const seen = new Set();
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop(); if (!current) return false;
    nodes += 1; if (nodes > MAX_OPAQUE_JSON_NODES || current.depth > MAX_OPAQUE_JSON_DEPTH) return false;
    const item = current.value;
    if (item === null || typeof item === 'string' || typeof item === 'boolean') continue;
    if (typeof item === 'number') { if (!Number.isFinite(item)) return false; continue; }
    if (typeof item !== 'object' || seen.has(item)) return false;
    if (!Array.isArray(item) && !plainObject(item)) return false;
    seen.add(item);
    for (const child of Array.isArray(item) ? item : Object.values(item)) pending.push({ value: child, depth: current.depth + 1 });
  }
  return true;
}
/** @param {unknown} value */
function encodedJsonWithinBound(value) { try { const encoded = JSON.stringify(value); return typeof encoded === 'string' && Buffer.byteLength(encoded) <= MAX_WIRE_TEXT; } catch { return false; } }
/** @param {string} value */
function hasControl(value) { return [...value].some((character) => { const code = character.codePointAt(0) ?? 0; return code <= 31 || code >= 127 && code <= 159; }); }
/** @param {unknown} value */
function positiveInteger(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
/** @param {unknown} value */
function nonnegativeInteger(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
/** @param {unknown} value */
function wireNumber(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER; }
/** @param {unknown} value */
function wireTimestamp(value) { return wireNumber(value); }
/** @param {unknown} value */
function validObservedAt(value) { if (typeof value !== 'string') return false; try { return new Date(value).toISOString() === value; } catch { return false; } }
/** @param {unknown} value @returns {value is Record<string,any>} */
function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null;
}
