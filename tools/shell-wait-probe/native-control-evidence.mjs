// @ts-check
/**
 * The pure, source-discriminated native-control evidence contract (report
 * §40.3, the confirmed-window plan Task 2 preregistration): bounded
 * whitelisted projection of the controller's runtime session, plus the
 * reload-side request/receipt/causal validation over the persisted block.
 * This module is PURE — no process, no socket, no clock, no file. It is the
 * transport-specific §39.9 step 8 registration with its OWN prospective
 * version, and it is NEVER fed to the historical model-tool contracts (join
 * v38/oracle v5 stay byte-unchanged): the whitelist contains NO model-tool
 * field, no tool event is ever fabricated, and a model-tool-sourced block is
 * refused by source class with the named reason.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// The module-INIT snapshot of the EXECUTING consumer source (plan §3): the
// driver's v10 construction binds these bytes — the final adjudication that
// actually runs is exactly the provenance that attributes the record.
export const EXECUTING_NATIVE_CONTROL_EVIDENCE_SOURCE = readFileSync(fileURLToPath(import.meta.url));


/** The transport-specific evidence contract version (registered prospectively). */
export const NATIVE_CONTROL_EVIDENCE_VERSION = 1;

/** The frozen §39.9 source-class set; unknown sources fail closed. */
export const NATIVE_CONTROL_SOURCES = Object.freeze(['model-tool', 'same-host-rpc', 'operator-child-stop']);

/** The controller version this contract adjudicates (mirrored from the controller). */
export const CONFIRMED_WINDOW_CONTROLLER_VERSION = 1;

const MAX_THREAD_ID_BYTES = 512;
const MAX_ERROR_TEXT_CHARS = 512;
const MAX_DUTY_NAMES = 16;
const MAX_WRONG_JOINS = 16;
const MAX_ROOT_INPUTS = 3;
/** (round-2 P2) the registered passive-read cadence the control freshness replay recomputes against. */
const CONTROL_FRESHNESS_CADENCE_MS = 1_000;
/** (round-3 P2-8) a projected duty name is a bounded string, never a runtime object. */
const MAX_DUTY_NAME_CHARS = 64;
/** The §16.5/§24.8 native responsiveness comparison bound (causal admission only). */
const RESPONSE_BOUND_MS = 60_000;
/**
 * The route's registered applicable duty slots (the §24.7 duty table as the
 * confirmed-window route injects it): settlement certifies these slots from
 * the PERSISTED names — aggregate flags alone never certify all-duty
 * settlement (round-4 P2).
 */
const REQUIRED_CONFIRMED_WINDOW_DUTY_SLOTS = Object.freeze(['invocation', 'broker', 'transport', 'runner', 'job', 'guard', 'integrity']);

/** @param {string} message @returns {TypeError} */
function invalidEvidenceContractInput(message) {
  return new TypeError(`Invalid native-control evidence input: ${message}`);
}

/** @param {unknown} value */
function boundedThreadId(value) {
  return typeof value === 'string' && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_THREAD_ID_BYTES
    && ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    })
    ? value
    : null;
}

/**
 * A bounded stamp: any FINITE non-negative number (mirrored from the
 * controller's gate, P1-4 — fractional monotonic stamps are real stamps and
 * never silently null; values beyond the safe-integer range are refused so a
 * stamp stays exactly comparable).
 * @param {unknown} value
 */
function safeStamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : null;
}

/**
 * The bounded whitelisted projection of the persisted duty adjudication
 * (round-4 P2): the duty object rides the SAME canonical shapes the reload
 * consumer accepts — aggregate booleans coerce to their `=== true` facts,
 * duty names project as bounded strings (the P2-8 rule), and the cleanup
 * fence projects as a bounded stamp. Unknown fields (diagnostics, private
 * paths, credentials) are DROPPED, never passed through. The controller
 * consumes this projection for its verdict AND the executor persists it, so
 * the adjudication and the offline replay share one representation.
 * @param {any} duties the injected/persisted duty adjudication
 */
export function projectConfirmedWindowDutyAdjudication(duties) {
  if (duties === null || typeof duties !== 'object') return null;
  return {
    allObserved: duties.allObserved === true,
    names: Array.isArray(duties.names)
      ? duties.names.slice(0, MAX_DUTY_NAMES).map((/** @type {any} */ name) => (typeof name === 'string' && name.length > 0 && name.length <= MAX_DUTY_NAME_CHARS ? name : null))
      : null,
    durableSettled: duties.durableSettled === true,
    cleanupFenceAtMs: safeStamp(duties.cleanupFenceAtMs),
    collectionIntervalsValid: duties.collectionIntervalsValid === true,
  };
}

/**
 * Source-class discrimination: whether a source class is supported at all and
 * whether it carries controller-attributable REQUEST-side bounds. The
 * model-tool class is the historical exec cohort's (its counts and
 * adjudications stay with the historical consumers — never fabricated here);
 * the operator-child-stop class carries strictly weaker, non-attributable
 * request-side bounds (§39.4); only the same-host RPC route is attributable
 * by THIS consumer.
 * @param {string} source
 * @returns {{ supported: boolean, source: string, rpcAttributable: boolean }}
 */
export function validateNativeControlSource(source) {
  const supported = NATIVE_CONTROL_SOURCES.includes(source);
  return { supported, source: String(source), rpcAttributable: supported && source === 'same-host-rpc' };
}

/**
 * The bounded whitelisted projection (§39.9 privacy): ids, stamps, kinds,
 * statuses and named reasons/digests ONLY. Unknown fields are DROPPED —
 * never passed through. No full turn bodies, no task or private preparation
 * text, no raw hook snapshots, no credentials; free-form protocol error text
 * is bounded. This is the CANONICAL runtime→persisted projection; the
 * controller exports the same function under its §40.2 name (a single
 * implementation — never a second divergent interpretation).
 * @param {any} session the runtime session facts collected by the choreography
 */
export function projectConfirmedWindowBlock(session) {
  const identity = session?.identity ?? {};
  const window = session?.window ?? {};
  const nativeRequest = session?.nativeRequest ?? {};
  const receipt = session?.receipt ?? {};
  const staging = session?.staging ?? {};
  return {
    controllerVersion: CONFIRMED_WINDOW_CONTROLLER_VERSION,
    evidenceVersion: NATIVE_CONTROL_EVIDENCE_VERSION,
    route: 'confirmed-window',
    source: typeof session?.source === 'string' ? session.source : null,
    host: {
      pid: safeStamp(session?.host?.pid) ?? null,
      argvDigest: typeof session?.host?.argvDigest === 'string' ? session.host.argvDigest : null,
      startedAtMs: safeStamp(session?.host?.startedAtMs),
      launchCount: safeStamp(session?.host?.launchCount),
    },
    rootInputs: Array.isArray(session?.rootInputs)
      ? session.rootInputs.slice(0, MAX_ROOT_INPUTS).map((/** @type {any} */ entry) => ({
        kind: typeof entry?.kind === 'string' ? entry.kind : null,
        turnId: boundedThreadId(entry?.turnId),
        sentAtMs: safeStamp(entry?.sentAtMs),
      }))
      : [],
    identity: {
      parentThreadId: boundedThreadId(identity.parentThreadId),
      childThreadId: boundedThreadId(identity.childThreadId),
      childTurnId: boundedThreadId(identity.childTurnId),
      joinBasis: typeof identity.joinBasis === 'string' ? identity.joinBasis : null,
      threadStartedRequired: false,
      joinObservedAtMs: safeStamp(identity.joinObservedAtMs),
      joinAmbiguous: identity.joinAmbiguous === true,
      unmatchedTurnStartOverflow: identity.unmatchedTurnStartOverflow === true,
      modelObservedDigest: typeof identity.modelObserved === 'string' && identity.modelObserved.length <= 64
        ? createHash('sha256').update(identity.modelObserved).digest('hex')
        : null,
      wrongJoins: Array.isArray(identity.wrongJoins)
        ? identity.wrongJoins.slice(0, MAX_WRONG_JOINS).map((/** @type {any} */ entry) => ({
          kind: typeof entry?.kind === 'string' ? entry.kind : null,
          atMs: safeStamp(entry?.atMs),
        }))
        : [],
    },
    staging: {
      startedAtMs: safeStamp(staging.startedAtMs),
      boundMs: 180_000,
      descriptorPublicationObserved: typeof staging.descriptorPublicationObserved === 'boolean' ? staging.descriptorPublicationObserved : null,
      liveReceiptObserved: typeof staging.liveReceiptObserved === 'boolean' ? staging.liveReceiptObserved : null,
      // (round-2 P2, evidence levels) the SPAWN evidence fact — a parent-bound
      // started activity establishes a Child was spawned, never the §39.8 L1
      // hook-receipt level (which stays named-unestablished until an actual
      // hook witness is collected).
      spawnActivityObserved: typeof staging.spawnActivityObserved === 'boolean' ? staging.spawnActivityObserved : null,
      childTerminalPreAdmission: typeof staging.childTerminalPreAdmission === 'boolean' ? staging.childTerminalPreAdmission : null,
      continuationUsed: typeof staging.continuationUsed === 'boolean' ? staging.continuationUsed : null,
    },
    window: {
      confirmedAtMs: safeStamp(window.confirmedAtMs),
      pendingObservationConfirmedAtMs: safeStamp(window.pendingObservationConfirmedAtMs),
      childTurnStartedAtMs: safeStamp(window.childTurnStartedAtMs),
      pendingIntervalStartedAtMs: safeStamp(window.pendingIntervalStartedAtMs),
      holdDeadlineAtMs: safeStamp(window.holdDeadlineAtMs),
      ancestryBaselineDigest: typeof window.ancestryBaselineDigest === 'string' ? window.ancestryBaselineDigest : null,
      ancestryHops: window.ancestryHops !== null && typeof window.ancestryHops === 'object'
        ? {
          launcherToBroker: window.ancestryHops.launcherToBroker === true,
          brokerToTransport: window.ancestryHops.brokerToTransport === true,
        }
        : null,
      dutiesObservable: typeof window.dutiesObservable === 'boolean' ? window.dutiesObservable : null,
      // (round-3 P2-8) the array-length cap alone is NOT the privacy
      // boundary: elements project as BOUNDED duty-name strings only — a
      // nested runtime object (or an unbounded string) can never ride the
      // persisted block.
      dutyNames: Array.isArray(window.dutyNames)
        ? window.dutyNames.slice(0, MAX_DUTY_NAMES).map((/** @type {any} */ name) => (typeof name === 'string' && name.length > 0 && name.length <= MAX_DUTY_NAME_CHARS ? name : null))
        : null,
      controlActiveAtMs: safeStamp(window.controlActiveAtMs),
      controlFreshAtMs: safeStamp(window.controlFreshAtMs),
      controlDeclaredLifetimeMs: safeStamp(window.controlDeclaredLifetimeMs),
      measurementCutoffAtMs: safeStamp(window.measurementCutoffAtMs),
      observationTeardownAtMs: safeStamp(window.observationTeardownAtMs),
    },
    nativeRequest: {
      sentAtMs: safeStamp(nativeRequest.sentAtMs),
      repliedAtMs: safeStamp(nativeRequest.repliedAtMs),
      threadId: boundedThreadId(nativeRequest.threadId),
      turnId: boundedThreadId(nativeRequest.turnId),
      outcome: typeof nativeRequest.outcome === 'string' ? nativeRequest.outcome : null,
      errorText: typeof nativeRequest.errorText === 'string' ? nativeRequest.errorText.slice(0, MAX_ERROR_TEXT_CHARS) : null,
      attemptCount: safeStamp(nativeRequest.attemptCount) ?? 0,
      responseBoundMs: 60_000,
      responseWithinBound: typeof nativeRequest.responseWithinBound === 'boolean' ? nativeRequest.responseWithinBound : null,
    },
    receipt: {
      transportReplyAtMs: safeStamp(receipt.transportReplyAtMs),
      childResolutionAtMs: safeStamp(receipt.childResolutionAtMs),
      childTerminalStatus: typeof receipt.childTerminalStatus === 'string' ? receipt.childTerminalStatus : null,
      childResolutionBasis: typeof receipt.childResolutionBasis === 'string' ? receipt.childResolutionBasis : null,
      completedTurnId: boundedThreadId(receipt.completedTurnId),
      observationResolvedAtMs: safeStamp(receipt.observationResolvedAtMs),
      unrelatedCompletionReply: typeof receipt.unrelatedCompletionReply === 'boolean' ? receipt.unrelatedCompletionReply : null,
      parentCancellationAtMs: safeStamp(receipt.parentCancellationAtMs),
    },
    fences: {
      caseDeadlineAtMs: safeStamp(session?.fences?.caseDeadlineAtMs),
      stagingDeadlineAtMs: safeStamp(session?.fences?.stagingDeadlineAtMs),
      collectionHorizonAtMs: safeStamp(session?.fences?.collectionHorizonAtMs),
      persistedBeforeDisposal: typeof session?.fences?.persistedBeforeDisposal === 'boolean' ? session.fences.persistedBeforeDisposal : null,
    },
    disposal: {
      connectionClosed: typeof session?.disposal?.connectionClosed === 'boolean' ? session.disposal.connectionClosed : null,
      hostDisposed: typeof session?.disposal?.hostDisposed === 'boolean' ? session.disposal.hostDisposed : null,
      teardownLabel: typeof session?.disposal?.teardownLabel === 'string' ? session.disposal.teardownLabel : null,
      settlementManufactured: false,
    },
    finalState: typeof session?.finalState === 'string' ? session.finalState : null,
    refusal: session?.refusal !== null && typeof session?.refusal === 'object'
      ? {
        state: typeof session.refusal.state === 'string' ? session.refusal.state : null,
        reason: typeof session.refusal.reason === 'string' ? session.refusal.reason.slice(0, MAX_ERROR_TEXT_CHARS) : null,
      }
      : null,
  };
}

/**
 * The final reload-side consumer (§39.9 step 8): re-validates the persisted
 * block ALONE (after the redacted serialization round-trip) and returns the
 * typed verdict. Fail-closed invariants, each with its own named reason:
 * unknown sources, non-attributable sources on the RPC route, wrong/stale
 * turn targets, unsent/rejected/duplicate requests, the forbidden
 * empty-turn-id form, causal initiation outside the proven pending interval,
 * a transport reply riding a natural completion, parent-only cancellation,
 * teardown/signal attribution, a missing child/observation resolution, a
 * missing window baseline, a post-cutoff resolution, and an unprovable
 * cleanup fence. RPC success, a turn snapshot or an interrupted-shaped event
 * alone is NEVER all-duty settlement: the settlement additionally requires
 * the persisted duty adjudication (an absent one keeps the verdict
 * UNESTABLISHED — null, never guessed).
 * @param {any} block the persisted, JSON-round-tripped block
 * @param {{ allObserved?: boolean | null, names?: string[] | null, durableSettled?: boolean | null, cleanupFenceAtMs?: number | null, collectionIntervalsValid?: boolean | null } | null} [duties]
 *   the persisted duty adjudication. `durableSettled` is ENFORCED (anything
 *   but `true` refuses with `durable-settlement-unresolved`); an absent duty
 *   adjudication keeps the whole verdict unestablished.
 */
export function admitConfirmedWindowNativeEvidence(block, duties = null) {
  if (!block || typeof block !== 'object') throw invalidEvidenceContractInput('the persisted native-control block is required.');
  const deliveryReasons = [];
  const settlementReasons = [];
  const source = validateNativeControlSource(block.source);
  const versioned = block.controllerVersion === CONFIRMED_WINDOW_CONTROLLER_VERSION
    && block.evidenceVersion === NATIVE_CONTROL_EVIDENCE_VERSION;
  if (!versioned) deliveryReasons.push('record-version-mismatch');
  if (!source.supported) deliveryReasons.push('unknown-native-source');
  else if (!source.rpcAttributable) {
    // The model-tool class is adjudicated by the HISTORICAL contracts (its
    // counts stay with them — this consumer never fabricates a tool event);
    // the operator-child-stop class has no controller-attributable request
    // bounds. Either way this RPC consumer has no authority over the record.
    deliveryReasons.push('source-route-mismatch');
  }
  const identity = block.identity ?? {};
  const request = block.nativeRequest ?? {};
  const receipt = block.receipt ?? {};
  const window = block.window ?? {};
  const joinProven = boundedThreadId(identity.parentThreadId) !== null
    && boundedThreadId(identity.childThreadId) !== null
    && boundedThreadId(identity.childTurnId) !== null
    && typeof identity.joinBasis === 'string';
  if (joinProven === false) deliveryReasons.push('identity-join-unproven');
  // (§39.9 step 3) an AMBIGUOUS recorded identity — two started activities
  // naming two different Children — is named-unestablished, never resolvable
  // by picking one: the join is unproven even when every id rode the record.
  // The projected `identity.joinAmbiguous` boolean is the DIRECT carrier of
  // the fact (the wrongJoins entries are a slice-bounded diagnostic); an
  // ambiguity beyond that slice can never become invisible to this consumer.
  const ambiguousRecorded = identity.joinAmbiguous === true
    || (Array.isArray(identity.wrongJoins)
      && identity.wrongJoins.some((/** @type {any} */ entry) => entry?.kind === 'conflicting-agent-thread-id'));
  if (ambiguousRecorded === true && !deliveryReasons.includes('identity-join-unproven')) {
    deliveryReasons.push('identity-join-unproven');
  }
  // The state machine must agree with the request bounds: a staging refusal
  // can never carry a sent request.
  const requestBoundsPresent = safeStamp(request.sentAtMs) !== null && safeStamp(request.repliedAtMs) !== null;
  if (block.finalState === 'staging-not-ready' && (requestBoundsPresent || request.attemptCount > 0)) {
    deliveryReasons.push('unsent-request');
  }
  if (request.outcome === 'forbidden-empty-turn-id') {
    // The §39.9 step 7 pre-send refusal (§40.3's frozen name): the
    // empty-turn-id startup-interrupt form is forbidden for this case (it is
    // not an exact active-turn target). The persisted id is empty/unprojectable
    // and the outcome carries the fact.
    deliveryReasons.push('empty-turn-id-forbidden');
  }
  // (P2-8, 2026-11-18 codex gate round) a request recorded as SENT owes BOTH
  // attributable bounds, and a reply stamp without an initiation stamp is
  // never attributable: such an INCOMPLETE shape is refused by name. Their
  // absence used to leave `requestBoundsPresent` false and silently bypass
  // the exact-target validation below, admitting a foreign-thread request.
  // (A rejected/failed request legitimately carries only the initiation
  // stamp — the controller's own typed delivery-failure shape — and is
  // refused by its own outcome reason, never by this one.)
  const requestSentAtMsBound = safeStamp(request.sentAtMs);
  const requestRepliedAtMsBound = safeStamp(request.repliedAtMs);
  const requestBoundsIncomplete = (request.outcome === 'sent' && (requestSentAtMsBound === null || requestRepliedAtMsBound === null))
    || (requestSentAtMsBound === null && requestRepliedAtMsBound !== null);
  if (requestBoundsIncomplete === true) deliveryReasons.push('request-bounds-incomplete');
  // The exact-target comparison applies whenever the request NAMES a target
  // (P2-8: never skipped because the bounds are incomplete); a pre-send
  // refusal has no target to compare. The projected completed turn id binds
  // the terminal EVENT to the interrupted turn itself: a foreign terminal
  // turn id is the same named wrong-target refusal.
  const requestTargetNamed = boundedThreadId(request.threadId) !== null || boundedThreadId(request.turnId) !== null;
  // (round-2 P2) a SENT request must POSITIVELY identify the joined Child
  // thread AND turn: a targetless shape is reserved for the typed pre-send
  // refusal (`forbidden-empty-turn-id`), never for a credited delivery —
  // both ids missing used to skip the exact-target check entirely and still
  // admit + settle.
  if (request.outcome === 'sent' && (boundedThreadId(request.threadId) === null || boundedThreadId(request.turnId) === null)) {
    deliveryReasons.push('request-target-unidentified');
  }
  if (joinProven === true && requestTargetNamed === true) {
    if (request.threadId !== identity.childThreadId || request.turnId !== identity.childTurnId) {
      deliveryReasons.push('wrong-turn-target');
    }
    const completedTurnId = boundedThreadId(receipt.completedTurnId);
    if (completedTurnId !== null && completedTurnId !== identity.childTurnId) {
      deliveryReasons.push('wrong-turn-target');
    }
  }
  if (request.outcome === 'stale-turn-target') deliveryReasons.push('stale-turn-target');
  else if (request.outcome === 'forbidden-empty-turn-id') {
    // The specific pre-send refusal already rides above; the generic
    // unsent classification never duplicates it.
  } else if (request.outcome === 'unsent-request' || safeStamp(request.sentAtMs) === null) deliveryReasons.push('unsent-request');
  else if (request.outcome === 'rejected') deliveryReasons.push('rejected-request');
  else if (request.outcome !== 'sent') deliveryReasons.push('request-outcome-unrecorded');
  // (P2-12, 2026-11-18 codex gate round) an AFFIRMATIVE attempt count of
  // exactly ONE is required whenever a sent request is credited: missing,
  // malformed and zero counts used to normalize to zero and accompany an
  // admitted settled delivery; counts above one stay the named duplicate.
  const requestAttemptCount = safeStamp(request.attemptCount);
  if (requestAttemptCount !== null && requestAttemptCount > 1) deliveryReasons.push('duplicate-request');
  else if (request.outcome === 'sent' && requestAttemptCount !== 1) deliveryReasons.push('request-attempt-count-unproven');
  // (P2-8 companion) the attributable bounds must be CHRONOLOGICALLY
  // consistent: a reply stamp before the send stamp is impossible transport
  // evidence (it would render a negative native latency).
  if (requestBoundsPresent === true && requestRepliedAtMsBound !== null && requestSentAtMsBound !== null
    && requestRepliedAtMsBound < requestSentAtMsBound) deliveryReasons.push('request-bounds-chronology-unproven');
  // The causal interval: the request INITIATION must sit inside the PROVEN
  // pending interval — bounded on BOTH sides (P2-7, 2026-11-18 codex gate
  // round): the Child's own turn/started instant onward, and no later than
  // the observation's expiry (the hold deadline) or the Child's resolution,
  // whichever comes first. A delayed acknowledgement or resolution is NEVER
  // an input to the INITIATION bound other than as the interval's end — it
  // cannot move the initiation.
  const intervalStartedAtMs = safeStamp(window.pendingIntervalStartedAtMs);
  const requestSentAtMs = safeStamp(request.sentAtMs);
  const repliedAtMs = safeStamp(request.repliedAtMs);
  // (round-3 P2-9) the responsiveness comparison is RECOMPUTED from the
  // validated persisted bounds against the fixed 60000 ms bound: a stale
  // summary flag can never grant responsiveness credit, and evidence whose
  // carried flag CONTRADICTS the retained stamps refuses the settlement.
  const recomputedResponseWithinBound = requestSentAtMs !== null && repliedAtMs !== null
    ? repliedAtMs - requestSentAtMs <= RESPONSE_BOUND_MS
    : null;
  // (round-3 P2-4) the ORIGINAL observation's actual resolution bounds the
  // interval too: an interrupt delivered after the observation ended gets no
  // causal settlement credit (the pending interval ends when the pending
  // observation ends, whichever bound is earliest).
  const intervalUpperBoundAtMs = [safeStamp(window.holdDeadlineAtMs), safeStamp(receipt.childResolutionAtMs), safeStamp(receipt.observationResolvedAtMs)].filter((value) => value !== null);
  let requestInsidePendingInterval = null;
  if (requestSentAtMs === null) requestInsidePendingInterval = null;
  else if (intervalStartedAtMs === null) requestInsidePendingInterval = null;
  else if (intervalUpperBoundAtMs.length === 0) requestInsidePendingInterval = null;
  else requestInsidePendingInterval = requestSentAtMs >= intervalStartedAtMs && requestSentAtMs <= Math.min(...intervalUpperBoundAtMs);
  if (requestInsidePendingInterval === false) deliveryReasons.push('initiation-outside-pending-interval');
  else if (requestInsidePendingInterval === null && requestBoundsPresent) deliveryReasons.push('causal-interval-unprovable');
  const deliveryAdmitted = deliveryReasons.length === 0;

  // The settlement layers (only meaningful on an admitted delivery; a
  // refused delivery fails the settlement closed on its own ground).
  if (deliveryAdmitted === false && !deliveryReasons.includes('record-version-mismatch')
    && !deliveryReasons.includes('unknown-native-source') && !deliveryReasons.includes('source-route-mismatch')) {
    settlementReasons.push(...deliveryReasons);
  } else if (deliveryReasons.includes('source-route-mismatch')) {
    settlementReasons.push('source-route-mismatch');
  } else if (deliveryReasons.includes('unknown-native-source')) {
    settlementReasons.push('unknown-native-source');
  }
  const childResolutionAtMs = safeStamp(receipt.childResolutionAtMs);
  const observationResolvedAtMs = safeStamp(receipt.observationResolvedAtMs);
  const cutoffAtMs = safeStamp(window.measurementCutoffAtMs);
  if (deliveryAdmitted === true) {
    if (receipt.unrelatedCompletionReply === true || receipt.childResolutionBasis === 'natural-completion'
      || (receipt.childTerminalStatus !== null && receipt.childTerminalStatus !== 'interrupted')) {
      settlementReasons.push('response-at-unrelated-completion');
    }
    if (safeStamp(receipt.parentCancellationAtMs) !== null) settlementReasons.push('parent-only-cancellation');
    if (receipt.childResolutionBasis === 'teardown-signal' || receipt.childResolutionBasis === 'signal-cleanup') {
      // §40.3's frozen name: a teardown/signal-attributed stop is never the
      // native settlement.
      settlementReasons.push('signal-or-cleanup-attribution');
    }
    // (P2-9, 2026-11-18 codex gate round) the settlement requires POSITIVE
    // exact-Child terminal evidence — an interrupted terminal status, the
    // child-terminal-event basis, AND the terminal event bound to the
    // REQUESTED turn's own id. A claimed resolution timestamp without its
    // native authority used to settle. (A record with NO resolution
    // timestamp is already named by missing-child-resolution.)
    if (childResolutionAtMs !== null && (receipt.childTerminalStatus !== 'interrupted' || receipt.childResolutionBasis !== 'child-terminal-event'
      || boundedThreadId(receipt.completedTurnId) !== boundedThreadId(identity.childTurnId))) {
      settlementReasons.push('child-terminal-authority-unproven');
    }
    if (childResolutionAtMs === null) settlementReasons.push('missing-child-resolution');
    if (observationResolvedAtMs === null) settlementReasons.push('missing-observation-resolution');
    if (safeStamp(window.pendingObservationConfirmedAtMs) === null) settlementReasons.push('missing-presence-baseline');
    // (round-2 P2) the positive window evidence must PRECEDE the request
    // initiation: an active Child turn is never proof of a pending
    // observation. Replay compares BOTH window stamps — the pending
    // observation's confirmation AND the window confirmation — against the
    // initiation; a window established only after the request never settles.
    if (requestSentAtMs !== null) {
      const pendingConfirmedAtMs = safeStamp(window.pendingObservationConfirmedAtMs);
      const windowConfirmedAtMs = safeStamp(window.confirmedAtMs);
      // A missing pending-observation confirmation stamp is already named by
      // missing-presence-baseline; a missing or late WINDOW confirmation
      // stamp, or a pending confirmation observed only AFTER the initiation,
      // is the ordering refusal.
      if (windowConfirmedAtMs === null || windowConfirmedAtMs > requestSentAtMs
        || (pendingConfirmedAtMs !== null && pendingConfirmedAtMs > requestSentAtMs)) {
        settlementReasons.push('window-unproven-before-initiation');
      }
    }
    if (typeof window.ancestryBaselineDigest !== 'string' || window.dutiesObservable !== true) {
      // §40.3's frozen name: the scan/baseline layer covers the generation/
      // ancestry baseline AND the observable applicable duties jointly.
      settlementReasons.push('missing-scan-baseline');
    }
    // (P2-4 companion, 2026-11-18 codex gate round) the control baseline
    // layer covers the active flag AND its required evidence: the freshness
    // stamp and the declared lifetime (§40.4's admission predicate). Nulls
    // used to settle on the active flag alone.
    if (safeStamp(window.controlActiveAtMs) === null || safeStamp(window.controlFreshAtMs) === null
      || safeStamp(window.controlDeclaredLifetimeMs) === null) {
      settlementReasons.push('missing-control-baseline');
    }
    // (round-2 P2) the control freshness/lifetime predicates are RECOMPUTED
    // against the request initiation during replay: presence alone used to
    // credit an unrelated control that was already stale or past its
    // declared lifetime AT initiation. The cadence is the registered
    // passive-read floor (1000 ms).
    if (requestSentAtMs !== null && safeStamp(window.controlFreshAtMs) !== null && safeStamp(window.controlDeclaredLifetimeMs) !== null
      && (requestSentAtMs - (/** @type {number} */ (safeStamp(window.controlFreshAtMs))) > CONTROL_FRESHNESS_CADENCE_MS
        || (/** @type {number} */ (safeStamp(window.controlFreshAtMs))) + (/** @type {number} */ (safeStamp(window.controlDeclaredLifetimeMs))) <= requestSentAtMs)) {
      settlementReasons.push('control-stale-or-expired-at-initiation');
    }
    // (round-3 P2-9) evidence whose carried responsiveness flag CONTRADICTS
    // the retained stamps refuses the settlement (the flag is recomputed for
    // the verdict — a disagreement is tampered or stale evidence).
    if (recomputedResponseWithinBound !== null && typeof request.responseWithinBound === 'boolean'
      && request.responseWithinBound !== recomputedResponseWithinBound) {
      settlementReasons.push('response-bound-contradicted');
    }
    // (P2-10, 2026-11-18 codex gate round) a missing or malformed
    // measurement cutoff DISABLED the post-cutoff checks and still granted
    // pre-cutoff credit: temporal qualification is unestablished without a
    // valid cutoff — never credited.
    if ((childResolutionAtMs !== null || observationResolvedAtMs !== null) && cutoffAtMs === null) {
      settlementReasons.push('measurement-cutoff-unproven');
    }
    if ((childResolutionAtMs !== null && cutoffAtMs !== null && childResolutionAtMs > cutoffAtMs)
      || (observationResolvedAtMs !== null && cutoffAtMs !== null && observationResolvedAtMs > cutoffAtMs)) {
      // (§39.9 step 9) post-cutoff facts get zero settlement credit — the
      // observation resolution is a post-cutoff fact like the Child's.
      settlementReasons.push('post-cutoff-resolution-no-credit');
    }
  }
  /** @type {boolean | null} */
  let settled = null;
  if (deliveryAdmitted === false) {
    // A refused delivery fails the settlement closed on the refusal ground.
    settled = false;
  } else if (duties === null || typeof duties !== 'object') {
    // An admitted delivery with NO persisted duty adjudication: the
    // settlement is UNESTABLISHED — never guessed from the RPC alone.
    settlementReasons.push('duty-adjudication-unestablished');
    settled = null;
  } else {
    if (duties.allObserved !== true) settlementReasons.push('duty-adjudication-incomplete');
    if (duties.durableSettled !== true) settlementReasons.push('durable-settlement-unresolved');
    // (round-4 P2) the REQUIRED duty slots are verified in BOTH the persisted
    // adjudication's names AND the window's projected duty names: an
    // aggregate allObserved flag with empty/partial names never certifies
    // all-duty settlement.
    const adjudicationMissingSlots = REQUIRED_CONFIRMED_WINDOW_DUTY_SLOTS.filter((slot) => !Array.isArray(duties.names) || !duties.names.includes(slot));
    const windowMissingSlots = REQUIRED_CONFIRMED_WINDOW_DUTY_SLOTS.filter((slot) => !Array.isArray(window.dutyNames) || !window.dutyNames.includes(slot));
    if (adjudicationMissingSlots.length > 0 || windowMissingSlots.length > 0) {
      settlementReasons.push('required-duty-slot-unproven');
    }
    // The earliest genuine cleanup fence stays mandatory: an observed
    // resolution must be PROVABLY pre-fence; an absent resolution is
    // already named by missing-child-resolution.
    const fenceAtMs = safeStamp(duties.cleanupFenceAtMs);
    // (round-2 P2) BOTH resolution legs must precede cleanup: a post-fence
    // observation resolution means the cleanup may have released the
    // original observation rather than the native interrupt — never
    // settlement credit. (An absent resolution is already named by
    // missing-child-resolution / missing-observation-resolution.)
    const fenceMissed = fenceAtMs === null
      || (childResolutionAtMs !== null && childResolutionAtMs >= fenceAtMs)
      || (observationResolvedAtMs !== null && observationResolvedAtMs >= fenceAtMs);
    if ((childResolutionAtMs !== null || observationResolvedAtMs !== null) && fenceMissed) {
      settlementReasons.push('cleanup-fence-unproven');
    }
    // (P2-11, 2026-11-18 codex gate round) the collection-interval validation
    // requires the AFFIRMATIVE `true`: only an explicit false was rejected
    // before, so omitting or nulling the fact still settled.
    if (duties.collectionIntervalsValid !== true) settlementReasons.push('collection-intervals-invalid');
    settled = settlementReasons.length === 0 ? true : false;
  }
  return {
    evidenceVersion: NATIVE_CONTROL_EVIDENCE_VERSION,
    controllerVersion: block.controllerVersion ?? null,
    source: block.source ?? null,
    delivery: { status: deliveryAdmitted ? 'admitted' : 'refused', reasons: deliveryReasons },
    causal: {
      requestInsidePendingInterval,
      initiationMoved: false,
      intervalStartedAtMs,
      requestSentAtMs,
    },
    transportReply: {
      observedAtMs: safeStamp(receipt.transportReplyAtMs),
      isSettlement: false,
      semantics: 'transport-reply-never-settlement',
    },
    resolution: {
      observedAtMs: childResolutionAtMs,
      basis: typeof receipt.childResolutionBasis === 'string' ? receipt.childResolutionBasis : null,
      terminalStatus: typeof receipt.childTerminalStatus === 'string' ? receipt.childTerminalStatus : null,
      observationResolvedAtMs,
    },
    settlement: {
      settled,
      basis: settled === true ? 'child-terminal-event-interrupted-plus-observation-plus-duties-pre-cutoff-pre-fence' : null,
      reasons: settlementReasons,
    },
    nativeLatencyMs: requestSentAtMs !== null && repliedAtMs !== null ? repliedAtMs - requestSentAtMs : null,
    nativeResponseWithinBound: recomputedResponseWithinBound,
  };
}
