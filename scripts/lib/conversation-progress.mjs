import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const PREVIEW_LIMIT = 96;
const START_STATUSES = new Set(['inputStreaming', 'pendingApproval', 'running']);
const SUCCESS_STATUSES = new Set(['success', 'completed']);
const FAILURE_STATUSES = new Set(['failed', 'error', 'cancelled', 'denied']);
const MAX_WIRE_TEXT = 1_048_576;
const MAX_DURATION_MS = 86_400_000;
const MAX_PUBLIC_MESSAGE_BYTES = 256;
const CONVERSATION_WIRE_VERSION = 3;

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
 * @returns {Promise<{observe:(notification:unknown,observedAt:string)=>Promise<Array<{phase:string,message:string,observedAt:string}>>,markTerminal:()=>void}>}
 */
export async function createConversationProgressDescriber({ sessionId, subscriptionId, workspace }) {
  const workspaceRoot = await realpath(resolve(workspace));
  const toolStates = new Map();
  const rowStates = new Map();
  let lastOrdinal = 0; let lastSeq = -1; let terminal = false; let observationTail = Promise.resolve();

  return {
    observe(notification, observedAt) {
      const operation = observationTail.then(() => observeFrame(notification, observedAt));
      observationTail = operation.catch(() => []).then(() => {});
      return operation;
    },
    markTerminal() { terminal = true; },
  };

  /** @param {unknown} notification @param {unknown} observedAt */
  async function observeFrame(notification, observedAt) {
      if (terminal || !validTimestamp(observedAt) || !plainObject(notification) || notification.method !== 'v4/conversation/frame' || !plainObject(notification.params)) return [];
      const wire = /** @type {any} */ (notification.params); const topic = `conversation/${sessionId}`;
      if (wire.wireVersion !== CONVERSATION_WIRE_VERSION || wire.kind !== 'complete' || wire.deliveryKind !== 'online' || wire.topic !== topic || wire.subscriptionId !== subscriptionId
        || !Number.isSafeInteger(wire.logicalFrameOrdinal) || wire.logicalFrameOrdinal <= lastOrdinal || !plainObject(wire.frame)
        || wire.frame.topic !== topic || wire.frame.subscriptionId !== subscriptionId || !Number.isSafeInteger(wire.frame.fromSeq)
        || !Number.isSafeInteger(wire.frame.toSeq) || wire.frame.fromSeq < 0 || wire.frame.toSeq < wire.frame.fromSeq || wire.frame.toSeq <= lastSeq
        || !plainObject(wire.frame.payload) || wire.frame.payload.kind !== 'deltas' || !Array.isArray(wire.frame.payload.deltas)) return [];
      lastOrdinal = wire.logicalFrameOrdinal; lastSeq = wire.frame.toSeq;
      const events = [];
      for (const delta of wire.frame.payload.deltas) {
        if (!plainObject(delta) || !['row.appended', 'row.upserted'].includes(delta.op) || !plainObject(delta.row) || !Number.isSafeInteger(delta.row.rowId)) continue;
        const row = delta.row;
        if (row.kind === 'toolCall') {
          const event = await describeTool(row, toolStates, workspaceRoot, observedAt);
          if (terminal) return [];
          if (event) events.push(event);
        } else if (row.kind === 'turnHeader') {
          const previous = rowStates.get(row.rowId); rowStates.set(row.rowId, row.state);
          if (previous === row.state) continue;
          if (row.state === 'running' && previous === undefined) events.push({ phase: 'starting', message: 'ZCode turn started.', observedAt });
          else if (row.state === 'completedSuccess') { events.push({ phase: 'finalizing', message: 'ZCode turn completed.', observedAt }); terminal = true; break; }
          else if (['failed', 'completedInterrupted'].includes(row.state)) { events.push({ phase: 'finalizing', message: 'ZCode turn ended without success.', observedAt }); terminal = true; break; }
        }
      }
      return events;
  }
}

/** @param {any} row @param {Map<string,{started:boolean,terminal:boolean,message:string|null}>} states @param {string} workspaceRoot @param {string} observedAt */
async function describeTool(row, states, workspaceRoot, observedAt) {
  const key = safeIdentifier(row.toolCallId) ? row.toolCallId : `row-${row.rowId}`;
  const prior = states.get(key) ?? { started: false, terminal: false, message: null };
  if (prior.terminal) return null;
  const status = row.status;
  if (START_STATUSES.has(status)) {
    if (prior.started) return null;
    const message = fitProgressMessage(await startMessage(row, workspaceRoot));
    states.set(key, { started: true, terminal: false, message });
    return { phase: status === 'pendingApproval' ? 'waiting' : 'running', message, observedAt };
  }
  if (!SUCCESS_STATUSES.has(status) && !FAILURE_STATUSES.has(status)) return null;
  const startMessageValue = prior.message ?? await startMessage(row, workspaceRoot);
  states.set(key, { started: prior.started, terminal: true, message: startMessageValue });
  const succeeded = SUCCESS_STATUSES.has(status); const duration = durationSuffix(row.startedAt, row.endedAt);
  return { phase: 'running', message: fitProgressMessage(terminalMessage(row, startMessageValue, succeeded, duration)), observedAt };
}

/** @param {any} row @param {string} workspaceRoot */
async function startMessage(row, workspaceRoot) {
  const toolName = normalizePreview(row.toolName, 64);
  const input = plainObject(row.input) ? row.input : {};
  if (toolName === 'Bash') { const preview = normalizePreview(input.command); return preview ? `Running command: ${preview}.` : 'Running tool: Bash.'; }
  if (['Read', 'Edit', 'Write'].includes(toolName)) {
    const path = await containedRelativePath(input.file_path, workspaceRoot);
    if (!path) return `Running tool: ${toolName}.`;
    return `${toolName === 'Read' ? 'Reading' : toolName === 'Edit' ? 'Editing' : 'Writing'}: ${path}.`;
  }
  if (toolName === 'Grep') { const preview = normalizePreview(input.pattern); return preview ? `Searching files: ${preview}.` : 'Running tool: Grep.'; }
  if (toolName === 'Glob') { const preview = normalizePreview(input.pattern); return preview ? `Finding files: ${preview}.` : 'Running tool: Glob.'; }
  if (toolName === 'WebSearch') { const preview = normalizePreview(input.query); return preview ? `Searching the web: ${preview}.` : 'Running tool: WebSearch.'; }
  return safeIdentifier(row.toolName) ? `Running tool: ${toolName}.` : 'Running a ZCode tool.';
}

/** @param {any} row @param {string} started @param {boolean} succeeded @param {string} duration */
function terminalMessage(row, started, succeeded, duration) {
  const state = succeeded ? 'completed' : 'failed';
  if (started.startsWith('Running command: ')) {
    const value = started.slice(17); const command = value.endsWith('.') ? value.slice(0, -1) : value;
    return `Command ${state}: ${command}${duration}.`;
  }
  const toolName = safeIdentifier(normalizePreview(row.toolName, 64)) ? normalizePreview(row.toolName, 64) : 'ZCode tool';
  return `${toolName} ${state}${duration}.`;
}

/** @param {unknown} startedAt @param {unknown} endedAt */
function durationSuffix(startedAt, endedAt) {
  if (!validTimestamp(startedAt) || !validTimestamp(endedAt)) return '';
  const duration = Date.parse(endedAt) - Date.parse(startedAt);
  if (duration < 0) return '';
  return duration <= MAX_DURATION_MS ? ` (${duration}ms)` : '';
}

/** @param {string} message */
function fitProgressMessage(message) {
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
/** @param {unknown} value */
function safeIdentifier(value) { return typeof value === 'string' && value.length > 0 && value.length <= 128 && normalizePreview(value, 128) === value; }
/** @param {unknown} value @returns {value is string} */
function validTimestamp(value) { if (typeof value !== 'string') return false; try { return new Date(value).toISOString() === value; } catch { return false; } }
/** @param {unknown} value @returns {value is Record<string,any>} */
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
