import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const PREVIEW_LIMIT = 96;
const START_STATUSES = new Set(['inputStreaming', 'pendingApproval', 'running']);
const SUCCESS_STATUSES = new Set(['success']);
const FAILURE_STATUSES = new Set(['error', 'cancelled']);
const TOOL_STATUSES = new Set([...START_STATUSES, ...SUCCESS_STATUSES, ...FAILURE_STATUSES]);
const TURN_STATES = new Set(['running', 'completedSuccess', 'completedInterrupted', 'failed']);
const TURN_ORIGINS = new Set(['userInput', 'backgroundResult', 'goalContinuation', 'editRerun']);
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
const ROW_DELTA_PATHS = new Set(['text', 'inputText', 'output.text', 'summaryText']);
const SUPPORTED_ROW_KINDS = new Set(['toolCall', 'turnHeader']);
/** @typedef {{phase:string,message:string,observedAt:string}} PublicProgressEvent */
/** @typedef {{op:string,row:Record<string,any>|null,fromRowId?:number}} ValidatedDelta */
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
 * @returns {Promise<{observe:(notification:unknown,observedAt:string)=>Promise<ObservationResult>,markGap:()=>void,markTerminal:()=>void}>}
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
  /** @type {Array<{notification:unknown,observedAt:string,resolve:(result:ObservationResult)=>void}>} */
  const pending = [];
  let active = false;
  /** @type {number|undefined} */
  let lastOrdinal;
  /** @type {number|undefined} */
  let lastSeq;
  let terminal = false; let needsRecovery = false;

  /** @type {{observe:(notification:unknown,observedAt:string)=>Promise<ObservationResult>,markGap:()=>void,markTerminal:()=>void}} */
  const api = {
    observe(notification, observedAt) {
      if (terminal) return Promise.resolve(ignored('terminal'));
      return new Promise((resolveResult) => {
        if (active && pending.length >= MAX_PENDING_OBSERVATIONS) { markGap(); resolveResult(ignored('overflow')); return; }
        pending.push({ notification, observedAt, resolve: resolveResult });
        drain();
      });
    },
    markGap,
    markTerminal: latchTerminal,
  };
  return api;

  function markGap() { if (!terminal) needsRecovery = true; }
  function latchTerminal() { terminal = true; while (pending.length > 0) pending.shift()?.resolve(ignored('terminal')); }

  function drain() {
    if (active || pending.length === 0) return;
    const item = pending.shift(); if (!item) return;
    active = true;
    Promise.resolve().then(() => observeFrame(item.notification, item.observedAt)).catch(() => rejected('row-shape')).then((result) => item.resolve(result)).finally(() => { active = false; drain(); });
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
      return accepted('initial');
    }
    if (frame.deliveryKind === 'recovery') {
      const repeatedDeltas = lastSeq !== undefined && frame.toSeq === lastSeq && frame.payloadKind === 'deltas' && frame.deltas.length > 0;
      if (lastOrdinal !== undefined && repeatedDeltas && frame.ordinal > lastOrdinal) { lastOrdinal = frame.ordinal; return ignored('stale'); }
      if (lastOrdinal !== undefined && (frame.ordinal <= lastOrdinal || frame.toSeq < /** @type {number} */ (lastSeq))) {
        return ignored('stale');
      }
      lastOrdinal = frame.ordinal; lastSeq = frame.toSeq; needsRecovery = false;
      if (frame.payloadKind === 'snapshot') resetLifecycleState();
      else absorbRecovery(frame.deltas);
      return accepted('recovery');
    }
    if (needsRecovery) return ignored('recovery-required');
    if (lastOrdinal !== undefined && frame.ordinal <= lastOrdinal) return ignored('stale');
    const sequenceGap = lastOrdinal !== undefined
      && (frame.ordinal !== lastOrdinal + 1 || frame.fromSeq > /** @type {number} */ (lastSeq));
    lastOrdinal = frame.ordinal; lastSeq = Math.max(lastSeq ?? frame.toSeq, frame.toSeq);
    if (sequenceGap) return rejected('sequence');
    if (frame.payloadKind === 'snapshot') { resetLifecycleState(); return accepted('online'); }
    const staged = [];
    for (const delta of frame.deltas) {
      if (delta.op === 'row.removed') { applyRemoval(/** @type {number} */ (delta.fromRowId)); continue; }
      if (!delta.row) continue;
      if (delta.row.kind === 'toolCall') {
        if (staged.length >= MAX_PUBLIC_EVENTS_PER_FRAME) { absorbToolState(delta.row); continue; }
        const event = await describeTool(delta.row, toolStates, workspaceRoot, publicObservedAt, resolvePath, pathTimeoutMs, () => terminal || needsRecovery);
        if (terminal || needsRecovery) return ignored(terminal ? 'terminal' : 'recovery-required');
        if (event && staged.length < MAX_PUBLIC_EVENTS_PER_FRAME) staged.push(event);
      } else {
        const row = delta.row;
        const previous = rowStates.get(row.rowId);
        if (row.state === 'completedSuccess' || row.state === 'failed' || row.state === 'completedInterrupted') {
          if (previous !== undefined || rowStates.size < MAX_TRACKED_ROWS) rowStates.set(row.rowId, row.state);
          if (staged.length < MAX_PUBLIC_EVENTS_PER_FRAME) staged.push({ phase: 'finalizing', message: row.state === 'completedSuccess' ? 'ZCode turn completed.' : 'ZCode turn ended without success.', observedAt: publicObservedAt });
          latchTerminal(); break;
        }
        if (previous === undefined && rowStates.size >= MAX_TRACKED_ROWS) continue;
        rowStates.set(row.rowId, row.state);
        if (previous === row.state) continue;
        if (row.state === 'running' && previous === undefined && staged.length < MAX_PUBLIC_EVENTS_PER_FRAME) staged.push({ phase: 'starting', message: 'ZCode turn started.', observedAt: publicObservedAt });
      }
    }
    return accepted('online', staged);
  }

  function resetLifecycleState() { toolStates.clear(); rowStates.clear(); }

  /** @param {number} fromRowId */
  function applyRemoval(fromRowId) {
    for (const [toolCallId, state] of toolStates) if (state.rowId >= fromRowId) toolStates.delete(toolCallId);
    for (const rowId of rowStates.keys()) if (rowId >= fromRowId) rowStates.delete(rowId);
  }

  /** @param {any} row */
  function absorbToolState(row) {
    const prior = toolStates.get(row.toolCallId) ?? { rowId: row.rowId, started: false, terminal: false, message: null };
    if (prior.terminal || !toolStates.has(row.toolCallId) && toolStates.size >= MAX_TRACKED_ROWS) return;
    if (START_STATUSES.has(row.status)) toolStates.set(row.toolCallId, { rowId: row.rowId, started: true, terminal: false, message: prior.message });
    else toolStates.set(row.toolCallId, { rowId: row.rowId, started: prior.started, terminal: true, message: prior.message });
  }

  /** @param {ValidatedDelta[]} deltas */
  function absorbRecovery(deltas) {
    for (const delta of deltas) {
      if (delta.op === 'row.removed') { applyRemoval(/** @type {number} */ (delta.fromRowId)); continue; }
      const row = delta.row; if (!row) continue;
      if (row.kind === 'toolCall') { absorbToolState(row); continue; }
      if (row.state === 'completedSuccess' || row.state === 'failed' || row.state === 'completedInterrupted') {
        if (rowStates.has(row.rowId) || rowStates.size < MAX_TRACKED_ROWS) rowStates.set(row.rowId, row.state);
        latchTerminal(); return;
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
  /** @param {string} [reason] */
  const resolveBufferedEmpty = (reason = terminal ? 'terminal' : 'disabled') => { while (buffered.length > 0) buffered.shift()?.resolve(ignored(reason)); };
  return /** @type {{observe:(notification:unknown,observedAt:string)=>Promise<ObservationResult>,bind:(subscriptionId:string)=>Promise<void>,fail:()=>void,markGap:()=>void,markTerminal:()=>void}} */ ({
    observe(notification, observedAt) {
      if (terminal || disabled) return Promise.resolve(ignored(terminal ? 'terminal' : 'disabled'));
      if (describer && !binding) return describer.observe(notification, observedAt);
      if (buffered.length >= MAX_PENDING_OBSERVATIONS) {
        if (describer) describer.markGap(); else prebindGap = true;
        return Promise.resolve(ignored('overflow'));
      }
      return new Promise((resolveResult) => buffered.push({ notification, observedAt, resolve: resolveResult }));
    },
    async bind(subscriptionId) {
      if (terminal || disabled || describer) return;
      binding = true;
      try {
        describer = await createConversationProgressDescriber({ sessionId, subscriptionId, workspace });
        while (!terminal && !disabled && buffered.length > 0) {
          const item = buffered.shift(); if (!item) break;
          item.resolve(await describer.observe(item.notification, item.observedAt));
        }
        if (prebindGap) describer.markGap();
      } catch (error) {
        disabled = true; resolveBufferedEmpty(); throw error;
      } finally { binding = false; if (terminal || disabled) resolveBufferedEmpty(); }
    },
    fail() { disabled = true; resolveBufferedEmpty(); },
    markGap() {
      if (terminal || disabled) return;
      if (describer) describer.markGap();
      else if (prebindGap) return;
      else prebindGap = true;
      resolveBufferedEmpty('recovery-required');
    },
    markTerminal() { terminal = true; describer?.markTerminal(); resolveBufferedEmpty(); },
  });
}

/** @param {unknown} notification @param {string} topic @param {string} subscriptionId @param {string} sessionId @returns {{ok:true,value:{deliveryKind:'initial'|'online'|'recovery',ordinal:number,fromSeq:number,toSeq:number,payloadKind:'snapshot'|'deltas',deltas:ValidatedDelta[]}}|{ok:false,reason:string}} */
function validateNotification(notification, topic, subscriptionId, sessionId) {
  if (!plainObject(notification) || notification.method !== 'v4/conversation/frame' || !plainObject(notification.params)) return { ok: false, reason: 'envelope-shape' };
  const wire = notification.params;
  if (!exactKeys(wire, ['wireVersion', 'kind', 'deliveryKind', 'logicalFrameId', 'logicalFrameOrdinal', 'topic', 'subscriptionId', 'frame'])) return { ok: false, reason: 'envelope-shape' };
  if (wire.wireVersion !== CONVERSATION_WIRE_VERSION) return { ok: false, reason: 'wire-version' };
  if (wire.topic !== topic || wire.subscriptionId !== subscriptionId) return { ok: false, reason: 'topic' };
  if (wire.kind !== 'complete'
    || !['initial', 'online', 'recovery'].includes(wire.deliveryKind)
    || !boundedIdentifier(wire.logicalFrameId, 256) || !plainObject(wire.frame)) return { ok: false, reason: 'envelope-shape' };
  if (!positiveInteger(wire.logicalFrameOrdinal)) return { ok: false, reason: 'sequence' };
  const frame = wire.frame;
  if (!exactKeys(frame, ['topic', 'subscriptionId', 'fromSeq', 'toSeq', 'sentAt', 'payload'])) return { ok: false, reason: 'envelope-shape' };
  if (frame.topic !== topic || frame.subscriptionId !== subscriptionId) return { ok: false, reason: 'topic' };
  if (!nonnegativeInteger(frame.fromSeq) || !nonnegativeInteger(frame.toSeq) || frame.toSeq < frame.fromSeq) return { ok: false, reason: 'sequence' };
  if (!wireTimestamp(frame.sentAt) || !plainObject(frame.payload) || !encodedJsonWithinBound(frame.payload)) return { ok: false, reason: 'envelope-shape' };
  if (frame.payload.kind === 'snapshot') {
    if (!exactKeys(frame.payload, ['kind', 'snapshot']) || !validSnapshot(frame.payload.snapshot, sessionId, frame.fromSeq, frame.toSeq)) return { ok: false, reason: 'envelope-shape' };
    return { ok: true, value: { deliveryKind: wire.deliveryKind, ordinal: wire.logicalFrameOrdinal, fromSeq: frame.fromSeq, toSeq: frame.toSeq, payloadKind: 'snapshot', deltas: [] } };
  }
  if (!exactKeys(frame.payload, ['kind', 'deltas']) || frame.payload.kind !== 'deltas'
    || !Array.isArray(frame.payload.deltas) || frame.payload.deltas.length > MAX_DELTAS_PER_FRAME) return { ok: false, reason: 'envelope-shape' };
  const deltas = [];
  for (const value of frame.payload.deltas) {
    const delta = validateDelta(value); if (!delta.ok) return delta; deltas.push(delta.value);
  }
  return { ok: true, value: { deliveryKind: wire.deliveryKind, ordinal: wire.logicalFrameOrdinal, fromSeq: frame.fromSeq, toSeq: frame.toSeq, payloadKind: 'deltas', deltas } };
}

/** @param {unknown} value @returns {{ok:true,value:ValidatedDelta}|{ok:false,reason:string}} */
function validateDelta(value) {
  if (!plainObject(value) || typeof value.op !== 'string') return { ok: false, reason: 'row-shape' };
  if (value.op === 'row.removed') return exactKeys(value, ['op', 'fromRowId']) && wireNumber(value.fromRowId)
    ? { ok: true, value: { op: value.op, row: null, fromRowId: value.fromRowId } } : { ok: false, reason: 'row-shape' };
  if (value.op === 'row.delta') return exactKeys(value, ['op', 'rowId', 'path', 'append']) && wireNumber(value.rowId)
    && ROW_DELTA_PATHS.has(value.path) && boundedOpaqueText(value.append)
    ? { ok: true, value: { op: value.op, row: null } } : { ok: false, reason: 'row-shape' };
  if (value.op === 'state.updated') return exactKeys(value, ['op', 'patch']) && boundedOpaqueJsonObject(value.patch)
    ? { ok: true, value: { op: value.op, row: null } } : { ok: false, reason: 'row-shape' };
  if (!['row.appended', 'row.upserted'].includes(value.op) || !exactKeys(value, ['op', 'row'])) return { ok: false, reason: 'row-shape' };
  if (!plainObject(value.row) || !safeRowEnvelope(value.row)) return { ok: false, reason: 'row-shape' };
  if (!SUPPORTED_ROW_KINDS.has(value.row.kind)) return { ok: true, value: { op: value.op, row: null } };
  const row = validateRow(value.row); return row ? { ok: true, value: { op: value.op, row } } : { ok: false, reason: 'row-shape' };
}

/** @param {unknown} value @param {string} sessionId @param {number} fromSeq @param {number} toSeq */
function validSnapshot(value, sessionId, fromSeq, toSeq) {
  if (!boundedOpaqueJsonObject(value)) return false;
  const snapshot = /** @type {Record<string,any>} */ (value);
  if (!exactKeys(snapshot, [
    'availability', 'backgroundWorks', 'config', 'control', 'goal', 'inputRouting', 'logEpoch',
    'meta', 'modelTransition', 'pendingCommands', 'pendingInteractions', 'plan', 'protocolVersion',
    'queue', 'revision', 'rows', 'seq', 'sessionId', 'usage', 'workspaceHookAdmission',
  ], ['subagents'])) return false;
  if (snapshot.protocolVersion !== 1 || snapshot.sessionId !== sessionId || !boundedIdentifier(snapshot.logEpoch, 1024)
    || !wireNumber(snapshot.seq) || snapshot.seq !== toSeq || !wireNumber(snapshot.revision) || fromSeq !== 0) return false;
  const rows = snapshot.rows;
  return plainObject(rows) && exactKeys(rows, ['window', 'totalCount', 'firstRowId'])
    && Array.isArray(rows.window) && rows.window.length <= 60 && nonnegativeInteger(rows.totalCount)
    && (rows.firstRowId === null || wireNumber(rows.firstRowId));
}

/** @param {Record<string,any>} row */
function safeRowEnvelope(row) {
  if (!wireNumber(row.rowId) || !boundedIdentifier(row.turnId, 1024) || !wireTimestamp(row.createdAt)
    || !wireNumber(row.createdAtSeq) || !boundedIdentifier(row.kind, 256)
    || row.visibility !== undefined && row.visibility !== 'visible'
    || row.entityId !== undefined && !boundedIdentifier(row.entityId, 1024)
    || row.productTurnId !== undefined && !boundedIdentifier(row.productTurnId, 1024)
    || !validActions(row.actions)) return false;
  try { return Buffer.byteLength(JSON.stringify(row)) <= MAX_WIRE_TEXT; } catch { return false; }
}

/** @param {Record<string,any>} row */
function validateRow(row) {
  const base = ['rowId', 'turnId', 'createdAt', 'createdAtSeq', 'kind'];
  const baseOptional = ['entityId', 'productTurnId', 'visibility', 'actions'];
  if (!wireNumber(row.rowId) || !boundedIdentifier(row.turnId, 1024) || !wireTimestamp(row.createdAt) || !wireNumber(row.createdAtSeq)
    || row.visibility !== undefined && row.visibility !== 'visible' || row.entityId !== undefined && !boundedIdentifier(row.entityId, 1024)
    || row.productTurnId !== undefined && !boundedIdentifier(row.productTurnId, 1024) || !validActions(row.actions)) return null;
  if (row.kind === 'toolCall') {
    const required = [...base, 'toolCallId', 'toolName', 'status', 'inputText'];
    const optional = [...baseOptional, 'input', 'output', 'display', 'error', 'progress', 'approvalInteractionId', 'backgrounded', 'workId', 'startedAt', 'endedAt'];
    if (!exactKeys(row, required, optional) || !boundedIdentifier(row.toolCallId, 1024) || !boundedIdentifier(row.toolName, 256)
      || !TOOL_STATUSES.has(row.status) || !boundedWireText(row.inputText)
      || row.startedAt !== undefined && !wireTimestamp(row.startedAt) || row.endedAt !== undefined && !wireTimestamp(row.endedAt)
      || row.approvalInteractionId !== undefined && !boundedIdentifier(row.approvalInteractionId, 1024)
      || row.workId !== undefined && !boundedIdentifier(row.workId, 1024) || row.backgrounded !== undefined && row.backgrounded !== true
      || !validToolOutput(row.output) || !validToolError(row.error) || !validToolProgress(row.progress) || !validToolDisplay(row.display)) return null;
    return row;
  }
  if (row.kind === 'turnHeader') {
    const required = [...base, 'origin', 'state', 'startedAt'];
    const optional = [...baseOptional, 'executionKind', 'sourceCommandId', 'historyRoundCount', 'endedAt', 'activeMs', 'workSegments', 'originMeta', 'fileChanges'];
    if (!exactKeys(row, required, optional) || !TURN_ORIGINS.has(row.origin) || !TURN_STATES.has(row.state) || !wireTimestamp(row.startedAt)
      || row.endedAt !== undefined && !wireTimestamp(row.endedAt) || row.executionKind !== undefined && !['agent', 'controlOnly'].includes(row.executionKind)
      || row.sourceCommandId !== undefined && !boundedIdentifier(row.sourceCommandId, 1024)
      || row.historyRoundCount !== undefined && !nonnegativeInteger(row.historyRoundCount)
      || row.activeMs !== undefined && !wireNumber(row.activeMs)
      || !validWorkSegments(row.workSegments) || !validOriginMeta(row.originMeta) || !validFileChanges(row.fileChanges)) return null;
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
/** @param {Record<string,any>} value @param {string[]} required @param {string[]} [optional] */
function exactKeys(value, required, optional = []) { const keys = Object.keys(value); return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key)); }
/** @param {unknown} value @param {number} max */
function boundedIdentifier(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max && !hasControl(value); }
/** @param {unknown} value */
function boundedWireText(value) { return typeof value === 'string' && value.length <= MAX_WIRE_TEXT && !hasControl(value); }
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
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** @param {unknown} value */
function validActions(value) { const record = /** @type {Record<string,any>} */ (value); return value === undefined || plainObject(value) && exactKeys(value, [], ['canFork', 'canEdit', 'canRetry', 'canRewindFiles', 'editDisposition']) && ['canFork', 'canEdit', 'canRetry', 'canRewindFiles'].every((key) => record[key] === undefined || record[key] === true) && (record.editDisposition === undefined || ['rewind', 'fork'].includes(record.editDisposition)); }
/** @param {unknown} value */
function validToolOutput(value) { const record = /** @type {Record<string,any>} */ (value); return value === undefined || plainObject(value) && exactKeys(value, ['text'], ['truncated']) && boundedOpaqueText(record.text) && (record.truncated === undefined || plainObject(record.truncated) && exactKeys(record.truncated, ['totalBytes', 'ref']) && wireNumber(record.truncated.totalBytes) && boundedIdentifier(record.truncated.ref, 1024)); }
/** @param {unknown} value */
function validToolError(value) { return value === undefined || plainObject(value) && exactKeys(value, ['code', 'message']) && boundedIdentifier(value.code, 256) && boundedOpaqueText(value.message); }
/** @param {unknown} value */
function validToolProgress(value) { return value === undefined || plainObject(value) && exactKeys(value, ['bytes', 'updatedAt'], ['previewLine']) && wireNumber(value.bytes) && wireTimestamp(value.updatedAt) && (value.previewLine === undefined || boundedWireText(value.previewLine)); }
/** @param {unknown} value */
function validToolDisplay(value) {
  if (value === undefined) return true;
  if (!plainObject(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'node_repl_images') return exactKeys(value, ['kind', 'images'], ['truncated', 'source']) && Array.isArray(value.images) && value.images.length >= 1 && value.images.length <= 2
    && value.images.every((image) => plainObject(image) && exactKeys(image, ['base64', 'mimeType']) && typeof image.base64 === 'string' && image.base64.length >= 1 && image.base64.length <= 204_800 && typeof image.mimeType === 'string' && /^image\/[a-z0-9.+-]+$/iu.test(image.mimeType))
    && (value.truncated === undefined || typeof value.truncated === 'boolean') && (value.source === undefined || value.source === 'browser_turn_end');
  if (value.kind === 'task_output') return exactKeys(value, ['kind', 'retrievalStatus'], ['taskStatus', 'output', 'truncated']) && ['success', 'not_ready', 'timeout'].includes(value.retrievalStatus)
    && (value.taskStatus === undefined || boundedIdentifier(value.taskStatus, 64)) && (value.output === undefined || typeof value.output === 'string' && value.output.length >= 1 && value.output.length <= 2_000) && (value.truncated === undefined || value.truncated === true);
  if (value.kind === 'respond_to_coordinator') return exactKeys(value, ['kind', 'status']) && ['success', 'failed'].includes(value.status);
  if (value.kind === 'mcp_tool') return exactKeys(value, ['kind', 'serverName', 'toolName'], ['description']) && boundedIdentifier(value.serverName, 256) && boundedIdentifier(value.toolName, 256) && (value.description === undefined || typeof value.description === 'string' && value.description.length >= 1 && value.description.length <= 4_096);
  return false;
}
/** @param {unknown} value */
function validWorkSegments(value) { return value === undefined || Array.isArray(value) && value.length <= MAX_DELTAS_PER_FRAME && value.every((segment) => plainObject(segment) && exactKeys(segment, ['segmentId', 'startedAt'], ['triggerEntityId', 'endedAt', 'activeMs']) && boundedIdentifier(segment.segmentId, 1024) && wireTimestamp(segment.startedAt) && (segment.triggerEntityId === undefined || boundedIdentifier(segment.triggerEntityId, 1024)) && (segment.endedAt === undefined || wireTimestamp(segment.endedAt)) && (segment.activeMs === undefined || wireNumber(segment.activeMs))); }
/** @param {unknown} value */
function validOriginMeta(value) { return value === undefined || plainObject(value) && exactKeys(value, ['backgroundSource', 'workId', 'title']) && ['bash', 'subagent'].includes(value.backgroundSource) && boundedIdentifier(value.workId, 1024) && boundedIdentifier(value.title, 4_096); }
/** @param {unknown} value */
function validFileChanges(value) { return value === undefined || plainObject(value) && exactKeys(value, ['additions', 'deletions', 'files'], ['state']) && wireNumber(value.additions) && wireNumber(value.deletions) && wireNumber(value.files) && (value.state === undefined || ['active', 'reverted'].includes(value.state)); }
/** @param {unknown} value */
function boundedOpaqueText(value) { return typeof value === 'string' && Buffer.byteLength(value) <= MAX_WIRE_TEXT; }
