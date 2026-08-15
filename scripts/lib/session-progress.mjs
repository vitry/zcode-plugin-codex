import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import { fitProgressMessage, formatToolStartMessage, formatToolTerminalMessage } from './conversation-progress.mjs';
import { isSafeIdentifier } from './identifier.mjs';

const START_STATUSES = new Set(['pending', 'running']);
const TERMINAL_STATUSES = new Set(['completed', 'error']);
const SAFE_TOOL_NAMES = new Set(['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebSearch']);
const MAX_TRACKED_CALLS = 256;
const MAX_SNAPSHOT_MESSAGES = 4_096;

/**
 * Describe only schema-validated session snapshots for the accepted turn.
 * @param {{workspace:string,turnBoundary:{inputId:string,stateRevision:number,beforeMessageIds:Set<string>}}} options
 */
export async function createSessionProgressDescriber({ workspace, turnBoundary }) {
  const workspaceRoot = await realpath(resolve(workspace));
  const beforeMessageIds = turnBoundary.beforeMessageIds;
  const inputId = turnBoundary.inputId;
  const boundaryRevision = turnBoundary.stateRevision;
  const calls = new Map();

  return {
    /** @param {any} snapshot @param {string} observedAt */
    async observe(snapshot, observedAt) {
      if (!validTimestamp(observedAt) || !Number.isSafeInteger(snapshot?.runtime?.stateRevision)
        || snapshot.runtime.stateRevision < boundaryRevision || !Array.isArray(snapshot?.messages)
        || snapshot.messages.length > MAX_SNAPSHOT_MESSAGES || hasUnsafeOrDuplicateMessageRelationships(snapshot.messages)) return [];
      const root = selectRoot(snapshot.messages, inputId, beforeMessageIds);
      if (!root) return [];
      const assistants = snapshot.messages.filter((/** @type {any} */ message) => isLinkedAssistant(message, root.info.messageId, beforeMessageIds));
      const events = [];
      for (const assistant of assistants) {
        if (!Array.isArray(assistant.parts)) return [];
        for (const part of assistant.parts) {
          if (part?.type !== 'tool') continue;
          const event = await describePart(part, observedAt, workspaceRoot, calls);
          if (event) events.push(event);
        }
      }
      return events;
    },
  };
}

/** @param {any[]} messages */
function hasUnsafeOrDuplicateMessageRelationships(messages) {
  const seen = new Set();
  for (const message of messages) {
    const id = message?.info?.messageId;
    if (!isSafeIdentifier(id) || message?.info?.role === 'assistant' && !isSafeIdentifier(message.info.parentMessageId) || seen.has(id)) return true;
    seen.add(id);
  }
  return false;
}

/** @param {any[]} messages @param {string} inputId @param {Set<string>} beforeMessageIds */
function selectRoot(messages, inputId, beforeMessageIds) {
  const direct = messages.filter((message) => message?.info?.messageId === inputId);
  if (direct.length === 1 && isVisibleUserRoot(direct[0], beforeMessageIds)) return direct[0];
  if (direct.length !== 0) return null;
  const candidates = messages.filter((message) => isVisibleUserRoot(message, beforeMessageIds));
  return candidates.length === 1 ? candidates[0] : null;
}

/** @param {any} message @param {Set<string>} beforeMessageIds */
function isVisibleUserRoot(message, beforeMessageIds) {
  const info = message?.info; const semantics = info?.semantics;
  return info?.role === 'user' && isSafeIdentifier(info.messageId) && !beforeMessageIds.has(info.messageId)
    && info.synthetic !== true && info.visibility !== 'model-only' && info.source === undefined
    && (semantics === undefined || semantics.origin === 'real_user' && semantics.kind === 'user_prompt' && semantics.uiVisibility === 'visible');
}

/** @param {any} message @param {string} rootId @param {Set<string>} beforeMessageIds */
function isLinkedAssistant(message, rootId, beforeMessageIds) {
  const info = message?.info; const semantics = info?.semantics;
  return info?.role === 'assistant' && isSafeIdentifier(info.messageId) && !beforeMessageIds.has(info.messageId)
    && isSafeIdentifier(info.parentMessageId) && info.parentMessageId === rootId && !['hidden', 'debug'].includes(semantics?.uiVisibility)
    && (semantics === undefined || semantics.origin === 'agent_runtime' && semantics.kind === 'assistant_response');
}

/** @param {any} part @param {string} observedAt @param {string} workspaceRoot @param {Map<string,{started:boolean,terminal:boolean,message:string}>} calls */
async function describePart(part, observedAt, workspaceRoot, calls) {
  const callId = part.callId; const state = part.state;
  if (!isSafeIdentifier(callId) || !state || typeof state !== 'object') return null;
  const toolName = SAFE_TOOL_NAMES.has(part.tool) ? part.tool : '';
  const prior = calls.get(callId);
  if (prior?.terminal) return null;
  if (START_STATUSES.has(state.status)) {
    if (prior?.started || !prior && calls.size >= MAX_TRACKED_CALLS) return null;
    const message = fitProgressMessage(await formatToolStartMessage({ toolName, input: state.input }, workspaceRoot, undefined, undefined, false));
    calls.set(callId, { started: true, terminal: false, message });
    return { phase: state.status === 'pending' ? 'waiting' : 'running', message, observedAt };
  }
  if (!TERMINAL_STATUSES.has(state.status) || !prior && calls.size >= MAX_TRACKED_CALLS) return null;
  const startMessage = prior?.message ?? fitProgressMessage(await formatToolStartMessage({ toolName, input: state.input }, workspaceRoot, undefined, undefined, false));
  calls.set(callId, { started: prior?.started === true, terminal: true, message: startMessage });
  return {
    phase: 'running',
    message: fitProgressMessage(formatToolTerminalMessage(
      { toolName, startedAt: state.startedAt, endedAt: state.completedAt },
      startMessage,
      state.status === 'completed',
    )),
    observedAt,
  };
}

/** @param {unknown} value */
function validTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}
