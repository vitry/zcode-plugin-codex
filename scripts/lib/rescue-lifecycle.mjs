import { PluginError } from './errors.mjs';
import { HOST_PLACEMENTS, STOP_CAUSES } from './rescue-binding.mjs';

/**
 * The Rescue Lifecycle Reconciler is the deep module that joins validated Host
 * child observation, the exact binding and current job, the durable stop
 * intent, SessionEnd receipt evidence, and ZCode turn evidence, then owns the
 * complete lifecycle mutation order and returns one bounded outcome. It is a
 * pure orchestrator over injected internal adapters: it never touches the
 * filesystem, the broker, or the store itself, and it never turns an uncertain
 * stop into a terminal claim or releases a writable guard on elapsed time.
 */

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const HOST_LOSS_STATES = new Set(['systemError', 'notLoaded', 'absent']);
const INTENT_KINDS = new Set(['observe', 'stop', 'wait']);
const REQUEST_KEYS = new Set(['intent', 'authority', 'workspace', 'selector', 'signal']);
const JOB_STATUSES = new Set(['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled']);
const HOST_OBSERVATION_STATES = new Set(['active', 'idle', 'notLoaded', 'systemError', 'absent']);
const SESSION_END_RECEIPT_EVIDENCE = new Set(['matching', 'older']);
const REMOTE_KINDS = new Set(['none', 'unavailable', 'unreadable', 'evidence']);
const REMOTE_CLASSIFICATIONS = new Set(['succeeded', 'failed', 'interrupted', 'pending']);
const ADAPTER_NAMES = Object.freeze([
  'loadJoinedState', 'persistStopIntent', 'revalidateGeneration', 'stopExactTurn',
  'rereadRemote', 'publishWinner', 'retainUnresolved', 'settleUnavailableExecutor',
]);

/**
 * @param {any} adapters Internal lifecycle adapters; extra non-adapter properties are ignored.
 * @returns {{ reconcile: (request: any) => Promise<any> }}
 */
export function createRescueLifecycleReconciler(adapters) {
  validateAdapters(adapters);
  return Object.freeze({ reconcile: (request) => reconcile(adapters, request) });
}

/**
 * One reconcile pass: load and validate the joined lifecycle state, return an
 * existing durable terminal winner untouched, otherwise derive the bounded stop
 * cause, settle a required stop in the mandated order, retry an unresolved
 * persisted stop, or select the bounded observation outcome.
 * @param {any} adapters @param {any} request
 */
async function reconcile(adapters, request) {
  validateRequest(request);
  request.signal?.throwIfAborted();
  const joined = await adapters.loadJoinedState(request);
  request.signal?.throwIfAborted();
  validateJoinedState(joined);
  if (joined.winner) return racedOutcome(joined.winner, joined);
  const cause = stopCauseFor(joined, request.intent);
  if (cause !== null) return stopAndSettle(adapters, joined, cause, request.signal);
  if (joined.job?.status === 'cancelling' && joined.stopIntent) {
    return stopAndSettle(adapters, joined, joined.stopIntent.cause, request.signal);
  }
  return observeSettle(adapters, joined);
}

/**
 * Derive the bounded stop cause for this request. An explicit stop carries its
 * caller-validated cause, except that Host Coordination Loss authorizes only a
 * foreground placement; an observation stops only for a SessionEnd receipt
 * matching the job's owning lifecycle epoch or a foreground Host child loss.
 * An older-epoch receipt grants no stop authority over a post-resume job.
 * @param {any} joined @param {any} intent
 * @returns {string | null}
 */
function stopCauseFor(joined, intent) {
  if (intent.kind === 'stop') {
    if (intent.cause === 'host-coordination-loss') return joined?.hostPlacement === 'foreground' ? intent.cause : null;
    return intent.cause;
  }
  if (joined?.sessionEndReceipt === 'matching') return 'session-end';
  if (joined?.hostPlacement === 'foreground' && HOST_LOSS_STATES.has(joined?.hostState)) return 'host-coordination-loss';
  return null;
}

/**
 * Own the stop mutation order: persist the durable stop intent first, then
 * revalidate the exact generation, then stop and reread the exact remote turn
 * through the cancellation election. Natural success wins the race, an
 * acknowledged stop with coherent interruption or failure evidence publishes
 * the cancelled winner with its Stop Cause, and every uncertain outcome keeps
 * the writable guard without a terminal claim.
 * @param {any} adapters @param {any} joined @param {string} cause @param {AbortSignal} [signal]
 */
async function stopAndSettle(adapters, joined, cause, signal) {
  signal?.throwIfAborted();
  if (!joined.stopIntent) {
    const persisted = await adapters.persistStopIntent(joined, cause, { signal });
    if (persisted?.kind === 'conflict') return racedOutcome(persisted.winner, { ...joined, resumableEvidence: refreshedEvidence(persisted) });
    if (persisted?.kind !== 'persisted' || !isPlainObject(persisted.job)) throw invalidStopIntentPersistence();
    joined = { ...joined, job: persisted.job, stopIntent: persisted.job.stopIntent ?? null };
  }
  signal?.throwIfAborted();
  if (joined.job?.status === 'queued') {
    const winner = await adapters.publishWinner(joined, { status: 'cancelled', stopCause: stopCauseOf(joined, cause) }, { signal });
    return publishedOutcome(winner, joined);
  }
  // Persist-before-control: a Host-owned record may reach remote control only
  // through its durable stop intent; legacy records authorize through their
  // durable cancelling transition instead.
  if (joined.hostOwned !== false && !joined.stopIntent) throw invalidStopIntentPersistence();
  return settleRemoteEvidence(adapters, joined, cause, signal);
}

/**
 * Elect and publish one winner from the joined remote evidence. Terminal
 * evidence settles directly — natural success publishes the authoritative
 * result and a stop-requested interruption or failure is claimed by the stop
 * cause — while attributable active evidence proceeds to the exact remote stop
 * and reread. Anything unreadable, unavailable, or non-attributable retains
 * the guard; an unavailable executor is archived only when the adapter can
 * safely prove its absence.
 * @param {any} adapters @param {any} joined @param {string} cause @param {AbortSignal} [signal] @param {any} [guard]
 */
async function settleRemoteEvidence(adapters, joined, cause, signal, guard = undefined) {
  signal?.throwIfAborted();
  const remote = joined.remote;
  if (!remote || remote.kind === 'none') return retainedOutcome(adapters, joined, undefined, signal);
  if (remote.kind === 'unavailable') {
    const settled = await adapters.settleUnavailableExecutor(joined, { error: remote.error }, { signal });
    return settledOutcome(settled, joined);
  }
  if (remote.kind === 'unreadable') return retainedOutcome(adapters, joined, remote.error, signal);
  if (remote.classification === 'succeeded') {
    const winner = await adapters.publishWinner(joined, { status: 'succeeded', classification: 'succeeded', snapshot: remote.snapshot }, { signal });
    return publishedOutcome(winner, joined);
  }
  if (remote.classification === 'failed' && guard === undefined) {
    // A pre-stop Engine Terminal Failure observed on the initial joined read
    // was not caused by this stop, so its failure semantics are published —
    // never rewritten as cancellation. Failure observed only after an
    // acknowledged stop remains the cancelled race winner below.
    const winner = await adapters.publishWinner(joined, { status: 'failed', classification: 'failed', snapshot: remote.snapshot,
      message: 'ZCode reported a terminal error before the stop could be attempted.' }, { signal });
    return publishedOutcome(winner, joined);
  }
  if (remote.classification === 'interrupted' || remote.classification === 'failed') {
    const winner = await adapters.publishWinner(joined, { status: 'cancelled', stopCause: stopCauseOf(joined, cause), classification: remote.classification, snapshot: remote.snapshot }, { signal });
    return publishedOutcome(winner, joined);
  }
  if (!(remote.active && remote.attributable)) return retainedOutcome(adapters, joined, undefined, signal);
  if (guard !== undefined) return retainedOutcome(adapters, joined, unresolvedStopError(), signal);
  const revalidated = await adapters.revalidateGeneration(joined, { signal });
  if (revalidated?.kind === 'stale') return racedOutcome(revalidated.winner, { ...joined, resumableEvidence: refreshedEvidence(revalidated) });
  signal?.throwIfAborted();
  const stopping = { ...joined, job: revalidated?.job ?? joined.job };
  const stop = await adapters.stopExactTurn(stopping, { signal, guard: revalidated?.guard });
  if (!stop?.acknowledged) return retainedOutcome(adapters, stopping, stop?.error, signal);
  const reread = await adapters.rereadRemote(stopping, { signal, guard: revalidated?.guard });
  return settleRemoteEvidence(adapters, { ...stopping, remote: reread }, stopCauseOf(stopping, cause), signal, revalidated?.guard ?? null);
}

/**
 * Without stop authority, observation publishes only proven remote terminal
 * evidence — natural success or Engine Terminal Failure — and otherwise keeps
 * the current nonterminal state for a later bounded reconciliation.
 * @param {any} adapters @param {any} joined
 */
async function observeSettle(adapters, joined) {
  const remote = joined.remote;
  if (remote?.kind === 'evidence') {
    if (remote.classification === 'succeeded') {
      const winner = await adapters.publishWinner(joined, { status: 'succeeded', classification: 'succeeded', snapshot: remote.snapshot });
      return publishedOutcome(winner, joined);
    }
    if (remote.classification === 'failed') {
      const winner = await adapters.publishWinner(joined, { status: 'failed', classification: 'failed', snapshot: remote.snapshot,
        message: 'ZCode reported a terminal error during reconciliation.' });
      return publishedOutcome(winner, joined);
    }
    if (remote.classification === 'interrupted') {
      const winner = await adapters.publishWinner(joined, { status: 'failed', classification: 'interrupted',
        message: 'The remote turn was interrupted before reconciliation completed.' });
      return publishedOutcome(winner, joined);
    }
  }
  return { kind: 'wait-current', status: joined.job?.status };
}

/** The persisted stop intent wins; a stop request can never replace it. @param {any} joined @param {string} cause */
function stopCauseOf(joined, cause) { return joined.stopIntent?.cause ?? cause; }

/**
 * A raced winner never inherits pre-race resumability evidence: a generation
 * race may have closed the binding or changed permission after the joined
 * state was loaded. Prefer the racing adapter's refreshed evidence record and
 * project unproven (never resumable) when it supplies none.
 * @param {any} raced
 */
function refreshedEvidence(raced) {
  const refreshed = raced?.resumableEvidence;
  if (isPlainObject(refreshed) && typeof refreshed.acceptedSession === 'boolean'
    && typeof refreshed.bindingCurrent === 'boolean' && typeof refreshed.permissionMatch === 'boolean') return refreshed;
  return { acceptedSession: false, bindingCurrent: false, permissionMatch: false };
}

/** A published winner that stayed nonterminal was not proven, so uncertainty retains the guard. @param {any} winner @param {any} joined */
function publishedOutcome(winner, joined) {
  if (winner && TERMINAL_STATUSES.has(winner.status)) return terminalOutcome(winner, joined);
  return { kind: 'unresolved-stop', status: winner?.status ?? joined.job?.status };
}

/** A terminal pre-existing or raced winner is returned as-is; a nonterminal one fail-closes the stale caller. @param {any} winner @param {any} joined */
function racedOutcome(winner, joined) {
  if (winner && TERMINAL_STATUSES.has(winner.status)) return terminalOutcome(winner, joined);
  return { kind: 'fail-closed', status: winner?.status ?? joined.job?.status };
}

/** An executor-absence settlement only claims a terminal when the adapter proved it safely. @param {any} settled @param {any} joined */
function settledOutcome(settled, joined) {
  if (settled && TERMINAL_STATUSES.has(settled.status)) return terminalOutcome(settled, joined);
  return { kind: 'unresolved-stop', status: settled?.status ?? joined.job?.status };
}

/**
 * Retain an unresolved stop: the writable guard is kept, bounded retry evidence
 * is published through the adapter, and a terminal winner that raced the
 * retention is still reported durably. Uncertainty never becomes terminal and
 * never releases the guard.
 * @param {any} adapters @param {any} joined @param {unknown} error @param {AbortSignal} [signal]
 */
async function retainedOutcome(adapters, joined, error, signal) {
  const retained = await adapters.retainUnresolved(joined, error === undefined ? {} : { error }, { signal });
  if (retained && TERMINAL_STATUSES.has(retained.status)) return terminalOutcome(retained, joined);
  return { kind: 'unresolved-stop', status: retained?.status ?? joined.job?.status };
}

/**
 * Project one durable terminal winner into the bounded public outcome. The
 * resumability indicator is derived from exact accepted-session, binding, and
 * permission evidence; private identifiers, capabilities, and paths never
 * cross this seam.
 * @param {any} winner @param {any} joined
 */
function terminalOutcome(winner, joined) {
  const evidence = joined?.resumableEvidence;
  const resumable = Boolean(evidence?.acceptedSession && evidence?.bindingCurrent && evidence?.permissionMatch);
  return {
    kind: 'settled-terminal',
    status: winner.status,
    ...(winner.status === 'cancelled' && winner.stopCause !== undefined ? { stopCause: winner.stopCause } : {}),
    resumable,
  };
}

function unresolvedStopError() {
  return new PluginError('JOB_RECOVERY_FAILED', 'The remote turn settlement remains unresolved after the stop acknowledgement.', {
    category: 'state', remedy: 'Retry reconciliation to settle the cancelling job.',
  });
}

/** The loadJoinedState adapter must return one fully validated joined record; a bare or partial miss is bounded misbehavior, never a fail-open lifecycle action. @param {any} joined */
function validateJoinedState(joined) {
  if (!isPlainObject(joined)) throw invalidJoinedState();
  if (!isPlainObject(joined.job) || !JOB_STATUSES.has(joined.job.status)) throw invalidJoinedState();
  if (!HOST_OBSERVATION_STATES.has(joined.hostState)) throw invalidJoinedState();
  if (!(joined.hostPlacement === null || HOST_PLACEMENTS.has(joined.hostPlacement))) throw invalidJoinedState();
  if (!(joined.sessionEndReceipt === null || SESSION_END_RECEIPT_EVIDENCE.has(joined.sessionEndReceipt))) throw invalidJoinedState();
  if (joined.stopIntent !== null && joined.stopIntent !== undefined
    && (!isPlainObject(joined.stopIntent) || !STOP_CAUSES.has(joined.stopIntent.cause))) throw invalidJoinedState();
  if (!isPlainObject(joined.resumableEvidence)
    || typeof joined.resumableEvidence.acceptedSession !== 'boolean'
    || typeof joined.resumableEvidence.bindingCurrent !== 'boolean'
    || typeof joined.resumableEvidence.permissionMatch !== 'boolean') throw invalidJoinedState();
  if (!validRemoteEvidence(joined.remote)) throw invalidJoinedState();
  if (joined.winner !== null && joined.winner !== undefined
    && !(isPlainObject(joined.winner) && JOB_STATUSES.has(joined.winner.status))) throw invalidJoinedState();
}

/** @param {any} remote */
function validRemoteEvidence(remote) {
  if (!isPlainObject(remote) || !REMOTE_KINDS.has(remote.kind)) return false;
  if (remote.kind !== 'evidence') return true;
  return REMOTE_CLASSIFICATIONS.has(remote.classification)
    && typeof remote.active === 'boolean' && typeof remote.attributable === 'boolean';
}

/** The loadJoinedState adapter must return one validated joined record; a bare miss is bounded misbehavior, not a raw TypeError. */
function invalidJoinedState() {
  return new PluginError('RESCUE_LIFECYCLE_STATE_INVALID', 'The joined Rescue lifecycle state is invalid.', {
    category: 'state', remedy: 'The lifecycle state adapter must return one validated joined record for the exact selector.',
  });
}

/** Persist-before-control: an adapter that cannot prove the durable stop intent on the persisted job must never enable remote lifecycle control. */
function invalidStopIntentPersistence() {
  return new PluginError('RESCUE_LIFECYCLE_STATE_INVALID', 'The durable stop intent was not provably persisted before lifecycle control.', {
    category: 'state', remedy: 'The stop intent adapter must return the persisted job record carrying its durable stop intent.',
  });
}

/** @param {any} adapters */
function validateAdapters(adapters) {
  if (!isPlainObject(adapters) || !ADAPTER_NAMES.every((name) => typeof adapters[name] === 'function')) {
    throw new PluginError('RESCUE_LIFECYCLE_ADAPTERS_INVALID', 'The Rescue lifecycle reconciler requires all of its internal adapters.', {
      category: 'configuration',
      remedy: `Provide exactly the adapter functions: ${ADAPTER_NAMES.join(', ')}.`,
      details: { adapters: ADAPTER_NAMES },
    });
  }
}

/** @param {any} request */
function validateRequest(request) {
  const invalid = () => new PluginError('RESCUE_LIFECYCLE_INPUT_INVALID', 'The Rescue lifecycle reconciliation request is invalid.', {
    category: 'validation',
    remedy: 'Pass exactly a bounded intent, validated authority, canonical workspace, optional selector, and optional abort signal.',
  });
  if (!isPlainObject(request) || !Object.keys(request).every((key) => REQUEST_KEYS.has(key))) throw invalid();
  if (!isPlainObject(request.intent) || !INTENT_KINDS.has(request.intent.kind)) throw invalid();
  const intentKeys = Object.keys(request.intent);
  if (request.intent.kind === 'stop' && (intentKeys.length !== 2 || !STOP_CAUSES.has(request.intent.cause))) throw invalid();
  if (request.intent.kind !== 'stop' && intentKeys.length !== 1) throw invalid();
  if (!isPlainObject(request.authority)) throw invalid();
  if (typeof request.workspace !== 'string' || request.workspace.length === 0) throw invalid();
  if (request.selector !== undefined && !isPlainObject(request.selector)) throw invalid();
  if (request.signal !== undefined && !(typeof request.signal.throwIfAborted === 'function' && typeof request.signal.addEventListener === 'function')) throw invalid();
}

/** @param {unknown} value */
function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
