import { PluginError } from './errors.mjs';

const ACTIVE_STATUSES = new Set(['running', 'waiting', 'paused']);
const INTERRUPTED_FINISHES = new Set(['abort', 'aborted', 'cancelled', 'canceled', 'interrupted']);
const RECONCILE_INTERVAL_MS = 100;

/**
 * Classify only evidence attributable to the accepted current-turn boundary.
 * Unknown/additive upstream fields are intentionally ignored.
 * @param {any} snapshot
 * @param {{beforeMessageIds?:Set<string>,inputId?:string,stateRevision?:number}} boundary
 * @returns {{kind:'pending'|'succeeded'|'failed'|'interrupted'}}
 */
export function classifyCurrentTurnSnapshot(snapshot, boundary = {}) {
  const revision = snapshot?.runtime?.stateRevision;
  if (!Number.isSafeInteger(revision) || revision < 0 || boundary.stateRevision !== undefined && revision < boundary.stateRevision) return { kind: 'pending' };
  const status = snapshot?.projection?.status;
  if (typeof status !== 'string' || ACTIVE_STATUSES.has(status)) return { kind: 'pending' };
  if (status === 'error') return { kind: 'failed' };
  if (!['idle', 'completed'].includes(status)) return { kind: 'pending' };
  const assistant = selectCurrentTurnAssistant(snapshot, boundary);
  if (!assistant || !assistantCompleted(assistant)) return { kind: 'pending' };
  if (assistant.info.error !== undefined) return { kind: 'failed' };
  const finish = assistant.info.finish;
  if (typeof finish === 'string' && INTERRUPTED_FINISHES.has(finish.toLowerCase())) return { kind: 'interrupted' };
  return { kind: 'succeeded' };
}

/**
 * Use the exact direct-input/sole-real-user-root selection shared by result extraction.
 * A directly linked response locks selection even when hidden or otherwise unusable.
 * @param {any} snapshot
 * @param {{beforeMessageIds?:Set<string>,inputId?:string}} boundary
 */
export function selectCurrentTurnAssistant(snapshot, boundary = {}) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const beforeMessageIds = boundary.beforeMessageIds ?? new Set();
  const newAssistants = messages.filter((/** @type {any} */ message) => isAssistantResponse(message, beforeMessageIds));
  const directAssistants = boundary.inputId ? newAssistants.filter((/** @type {any} */ message) => message.info.parentMessageId === boundary.inputId) : [];
  if (directAssistants.length) return visibleAssistant(directAssistants.at(-1));
  if (!boundary.inputId) return visibleAssistant(newAssistants.at(-1));
  const currentUserRoots = messages.filter((/** @type {any} */ message) => isCurrentUserRoot(message, beforeMessageIds));
  if (currentUserRoots.length !== 1) return undefined;
  return visibleAssistant(newAssistants.filter((/** @type {any} */ message) => message.info.parentMessageId === currentUserRoots[0].info.messageId).at(-1));
}

/**
 * Coordinate the legacy admission wake with authoritative v4 lifecycle and snapshot reconciliation.
 * There is deliberately no normal-completion deadline.
 * @param {{legacyWake:Promise<unknown>,conversationObserver:any,readSnapshot:()=>Promise<any>,turnBoundary:{beforeMessageIds?:Set<string>,inputId?:string,stateRevision?:number},signal?:AbortSignal,reconcileIntervalMs?:number}} input
 * @returns {Promise<{kind:'succeeded'|'failed'|'interrupted',snapshot:any}>}
 */
export async function awaitCurrentTurnTerminal(input) {
  const requestedInterval = input.reconcileIntervalMs;
  const interval = typeof requestedInterval === 'number' && Number.isSafeInteger(requestedInterval) && requestedInterval >= 0 ? requestedInterval : RECONCILE_INTERVAL_MS;
  /** @type {{result:{kind:'succeeded'|'failed'|'interrupted'|'unavailable',turnId?:string}|undefined}} */
  const authorityState = { result: undefined };
  const authority = Promise.resolve(input.conversationObserver.waitForTurnTerminal()).then((result) => {
    authorityState.result = result; return { source: 'authority', result };
  });
  const legacy = Promise.resolve(input.legacyWake).then(() => ({ source: 'legacy' }));
  let wake = await abortable(Promise.race([authority, legacy]), input.signal);
  if (wake.source === 'authority' && wake.result?.kind === 'unavailable') wake = await abortable(legacy, input.signal);
  void wake;
  for (;;) {
    input.signal?.throwIfAborted();
    let snapshot;
    // Once a read has produced a coherent terminal snapshot, that terminal wins
    // an abort delivered from inside the same read completion boundary.
    try { snapshot = await Promise.resolve().then(input.readSnapshot); }
    catch (error) {
      input.signal?.throwIfAborted();
      if (!isTransitionalReadError(error)) throw error;
      await delay(interval, input.signal); continue;
    }
    const classified = classifyCurrentTurnSnapshot(snapshot, input.turnBoundary);
    if (classified.kind !== 'pending') {
      const authoritativeKind = authorityState.result?.kind;
      let kind = classified.kind;
      if (classified.kind === 'succeeded' && (authoritativeKind === 'failed' || authoritativeKind === 'interrupted')) kind = authoritativeKind;
      return { kind, snapshot };
    }
    await delay(interval, input.signal);
  }
}

/** @param {any} assistant */
function assistantCompleted(assistant) {
  const completed = assistant?.info?.time?.completed;
  return Number.isSafeInteger(completed) && completed >= 0 || typeof assistant?.info?.finish === 'string' && assistant.info.finish.length > 0 || assistant?.info?.error !== undefined;
}

/** @param {any} assistant */
function visibleAssistant(assistant) {
  return ['hidden', 'debug'].includes(assistant?.info?.semantics?.uiVisibility) ? undefined : assistant;
}

/** @param {any} message @param {Set<string>} beforeMessageIds */
function isAssistantResponse(message, beforeMessageIds) {
  const semantics = message?.info?.semantics;
  return message?.info?.role === 'assistant' && typeof message.info.messageId === 'string' && !beforeMessageIds.has(message.info.messageId)
    && (semantics === undefined || semantics.origin === 'agent_runtime' && semantics.kind === 'assistant_response');
}

/** @param {any} message @param {Set<string>} beforeMessageIds */
function isCurrentUserRoot(message, beforeMessageIds) {
  const info = message?.info; const semantics = info?.semantics;
  return info?.role === 'user' && typeof info.messageId === 'string' && !beforeMessageIds.has(info.messageId) && info.synthetic !== true && info.visibility !== 'model-only' && info.source === undefined
    && (semantics === undefined || semantics.origin === 'real_user' && semantics.kind === 'user_prompt' && semantics.uiVisibility === 'visible');
}

/** @param {unknown} error */
function isTransitionalReadError(error) {
  return error instanceof PluginError && error.code === 'ZCODE_OUTPUT_INVALID' && error.details?.method === 'session/read';
}

/** @template T @param {Promise<T>} promise @param {AbortSignal|undefined} signal */
function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** @param {number} milliseconds @param {AbortSignal|undefined} signal */
async function delay(milliseconds, signal) {
  if (milliseconds === 0) { await new Promise((resolve) => setImmediate(resolve)); signal?.throwIfAborted(); return; }
  await abortable(new Promise((resolve) => setTimeout(resolve, milliseconds)), signal);
}
