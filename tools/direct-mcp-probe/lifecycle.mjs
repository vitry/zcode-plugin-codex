// @ts-nocheck
/**
 * Lifecycle settlement rules for the direct `mcpServer/tool/call`
 * feasibility probe (plan Task 5). This module is PURE — no IO, no host, no
 * durable state — and owns three frozen decision surfaces:
 *
 * 1. `directLifecycleExpectation` — the command-specific expected-outcome
 *    table mapping each probed command placement (Rescue/Review foreground
 *    execution, allowed background placement, `status --wait` observation)
 *    and trigger to the settlement expectation that matches EXISTING plugin
 *    behavior. `status --wait` cancellation ends only the observation and
 *    leaves the tracked job active; one generic "kill the worker" rule can
 *    never qualify all tools.
 * 2. `classifyDirectLifecycleCase` — the local state machine for ONE case:
 *    it reads the durable records and the authenticated reduction only, and
 *    never infers downstream settlement from RPC outcomes or turn status.
 * 3. `assessDirectReconciliationStrategy` — the assessment of the durable
 *    stop-intent/supervision-style reconciliation candidate: accepted only
 *    under demonstrated exact ownership and bounded settlement, and never
 *    for host loss, where no durable writer survives.
 *
 * Every classification is derived from durable `handler-settled` /
 * `worker-settled` records joined to the held call. A missing prerequisite
 * records `not-sent`; a settlement that cannot be established records
 * `settlement-unproven`; nothing here upgrades G3 by itself.
 */

/** The closed command-placement vocabulary of the expectation table. */
export const DIRECT_LIFECYCLE_COMMANDS = Object.freeze([
  'execution-foreground', // Rescue/Review foreground: cancellation reaches the exact operation
  'execution-background', // allowed background placement: the job survives caller cancellation
  'status-wait',          // `status --wait`: pure observation of a tracked job
]);

/** The closed trigger vocabulary of one lifecycle case. */
export const DIRECT_LIFECYCLE_TRIGGERS = Object.freeze([
  'turn-interrupt', 'connection-close', 'host-stop', 'host-kill',
  'config-timeout', 'safety-deadline', 'completion', 'cancel-race',
]);

/** The closed classification vocabulary of one lifecycle case. */
export const DIRECT_LIFECYCLE_CASE_CLASSIFICATIONS = Object.freeze([
  'settlement-observed',   // durable terminals observed and matching the command expectation
  'behavior-confirmed',    // the command's observation-only placement confirmed (job stays active)
  'expectation-mismatch',  // the durable observation contradicts the command expectation
  'settlement-unproven',   // the case demanded a settlement decision and none was durably observed
  'not-sent',              // a prerequisite (durable hold, confirmed exact turn) was missing
  'not-observed',          // no dispatched request for the case
]);

/** The closed reason codes emitted by the case classifier and the expectation table (driver-emitted prerequisite reasons live in `DIRECT_LIFECYCLE_DRIVER_REASON_CODES`). */
export const DIRECT_LIFECYCLE_REASON_CODES = Object.freeze([
  'request-not-sent', 'entry-not-joined', 'hold-not-started', 'turn-not-confirmed', 'trigger-not-sent',
  'status-target-killed', 'sentinel-caught', 'sentinel-undispatched', 'sentinel-missing', 'sentinel-never-settled',
  'sentinel-expired-before-boundary', 'sentinel-started-after-boundary', 'sentinel-ordering-unprovable',
  'sentinel-ordering-inverted', 'settlement-before-trigger', 'trigger-not-acknowledged', 'sentinel-watchdog-unprovable',
  'sentinel-handler-before-release',
  'sentinel-handler-terminal-missing', 'sentinel-terminals-inconsistent', 'sentinel-handler-expired-before-boundary',
  'sentinel-decision-order-unprovable', 'sentinel-outcome-unprovable', 'wait-ended-unobserved',
  'boundary-not-yet-observed', 'worker-never-settled',
  'job-remains-active', 'unexpected-worker-outcome', 'worker-unowned', 'handler-terminal-missing',
  'inconsistent-terminals', 'cancellation-boundary-unobserved',
]);

/**
 * The closed reason codes the lifecycle schedule's prerequisite gates emit
 * into the redacted caseReasons output (driver-emitted, outside the
 * classifier): a host signal that could not be verified as delivered, and a
 * host lost during the client close. Together with
 * `DIRECT_LIFECYCLE_REASON_CODES` this enumerates every value the case
 * reasons output may carry.
 */
export const DIRECT_LIFECYCLE_DRIVER_REASON_CODES = Object.freeze(['signal-unverified', 'host-lost-during-close']);

/** The closed sentinel outcomes of one case: survival is unprovable by this
 * instrument (the sentinel's cancellation-DECISION instant is durably
 * unorderable against the targeted release), so the classifier emits only
 * caught, unproven, and not-observed. */
export const DIRECT_LIFECYCLE_SENTINEL_OUTCOMES = Object.freeze(['caught', 'unproven', 'not-observed']);

/** The closed rpc-observed outcomes that witness the WAIT itself concluded:
 * the call was answered or rejected. `not-observed` is an indefinitely
 * pending wait and proves nothing about the observation behavior. */
export const DIRECT_LIFECYCLE_WAIT_ENDED_OUTCOMES = Object.freeze(['success-result', 'error-result', 'rpc-rejected']);

/** The closed scopes of an expectation-table cell. */
export const DIRECT_LIFECYCLE_OBSERVATION_SCOPES = Object.freeze(['operation', 'observation', 'infrastructure']);

/** Triggers whose cancellation is scoped to the one target call (a sentinel must survive them). */
const DIRECT_LIFECYCLE_PER_CALL_TRIGGERS = Object.freeze(['turn-interrupt', 'config-timeout', 'cancel-race']);

/** @param {string} code @param {string} message */
function lifecycleError(code, message) {
  const error = /** @type {Error & {code:string}} */ (new Error(`${code}: ${message}`));
  error.code = code;
  return error;
}

/**
 * The command-specific expected-outcome table (plan Task 5 Step 2), encoding
 * EXISTING plugin behavior: a foreground execution's cancellation settles the
 * exact operation (`cancelled`, or the host timeout's `timed-out`); a
 * background placement and the `status --wait` observation survive caller
 * cancellation — the tracked job remains active and may only settle later by
 * its own completion; infrastructure loss never presumes a settlement; the
 * injected safety ceiling force-settles the held operation as the production
 * 100-hour ceiling's mechanism (mechanism-only evidence).
 * @param {{command: string, trigger: string}} input
 * @returns {{scope: string, settlesWorker: boolean, workerOutcomes: string[]|null}} the frozen cell
 */
export function directLifecycleExpectation({ command, trigger }) {
  if (!DIRECT_LIFECYCLE_COMMANDS.includes(command)) {
    throw lifecycleError('DIRECT_LIFECYCLE_INVALID', `Unknown lifecycle command placement: ${String(command)}`);
  }
  if (!DIRECT_LIFECYCLE_TRIGGERS.includes(trigger)) {
    throw lifecycleError('DIRECT_LIFECYCLE_INVALID', `Unknown lifecycle trigger: ${String(trigger)}`);
  }
  // Completion and the injected ceiling settle the held operation for every
  // placement; the race case is placement-specific: the configured caller
  // cancellation may reach the OPERATION-scoped foreground placement (one
  // durably decided winner), while observation placements (status --wait,
  // allowed background) are NEVER reached by caller cancellation — the
  // tracked job may only settle by its own completion, and a cancelled
  // outcome there is the status-target-killed contradiction.
  if (trigger === 'completion') return { scope: 'operation', settlesWorker: false, workerOutcomes: ['completed'] };
  if (trigger === 'safety-deadline') return { scope: 'operation', settlesWorker: false, workerOutcomes: ['safety-deadline'] };
  if (trigger === 'cancel-race') {
    if (command === 'execution-foreground') {
      return { scope: 'operation', settlesWorker: false, workerOutcomes: ['completed', 'cancelled', 'safety-deadline'] };
    }
    return { scope: 'observation', settlesWorker: false, workerOutcomes: ['completed'] };
  }
  // Infrastructure loss: classified from the durable record alone — no
  // presumed worker outcome exists, because no process may survive to write one.
  if (trigger === 'connection-close' || trigger === 'host-stop' || trigger === 'host-kill') {
    return { scope: 'infrastructure', settlesWorker: false, workerOutcomes: null };
  }
  // Caller-cancellation triggers: command-specific placement rules.
  if (command === 'execution-foreground') {
    return {
      scope: 'operation',
      settlesWorker: true,
      workerOutcomes: trigger === 'turn-interrupt' ? ['cancelled'] : ['cancelled', 'timed-out'],
    };
  }
  return { scope: 'observation', settlesWorker: false, workerOutcomes: ['completed'] };
}

/** Validates one bounded non-negative integer window bound. */
function requireWindowBound(value, name) {
  if (value === undefined || value === null) return Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw lifecycleError('DIRECT_LIFECYCLE_INVALID', `${name} must be a non-negative safe integer sequence bound.`);
  }
  return value;
}

/**
 * The local state machine for ONE lifecycle case (plan Task 5 Step 3). The
 * verdict is derived ONLY from the durable records and the authenticated
 * reduction: the case joins the unique probe label to the durable handler
 * entry, requires the durable `hold-started` (with its synthetic worker
 * claim) before any trigger, and reads the terminal settlements from the
 * reducer — never from the RPC outcome or the turn status.
 * @param {{
 *   records: object[],
 *   reduced: {calls: object[]},
 *   probeLabel: string,
 *   phase?: string,
 *   command: string,
 *   trigger: string,
 *   exactTurnConfirmed?: boolean,
 *   sentinelLabel?: string|null,
 *   sentinelDispatchFailed?: boolean,
 *   cancellationObserved?: boolean,
 *   windowStart?: number,
 *   windowEnd?: number,
 * }} input
 */
export function classifyDirectLifecycleCase({
  records,
  reduced,
  probeLabel,
  phase = 'lifecycle',
  command,
  trigger,
  exactTurnConfirmed = false,
  sentinelLabel = null,
  sentinelDispatchFailed = false,
  cancellationObserved = false,
  windowStart = 0,
  windowEnd,
}) {
  if (!Array.isArray(records)) throw lifecycleError('DIRECT_LIFECYCLE_INVALID', 'The lifecycle case requires the validated event records.');
  if (!reduced || !Array.isArray(reduced.calls)) throw lifecycleError('DIRECT_LIFECYCLE_INVALID', 'The lifecycle case requires the authenticated reduction.');
  if (typeof probeLabel !== 'string' || !/^[0-9a-f]{32}$/.test(probeLabel)) {
    throw lifecycleError('DIRECT_LIFECYCLE_INVALID', 'The lifecycle case requires a valid probeLabel.');
  }
  if (!DIRECT_LIFECYCLE_COMMANDS.includes(command)) throw lifecycleError('DIRECT_LIFECYCLE_INVALID', 'The lifecycle case requires a closed command placement.');
  if (!DIRECT_LIFECYCLE_TRIGGERS.includes(trigger)) throw lifecycleError('DIRECT_LIFECYCLE_INVALID', 'The lifecycle case requires a closed trigger.');
  const start = requireWindowBound(windowStart, 'windowStart');
  const end = requireWindowBound(windowEnd ?? Number.MAX_SAFE_INTEGER, 'windowEnd');
  if (end <= start) throw lifecycleError('DIRECT_LIFECYCLE_INVALID', 'The lifecycle case window must be non-empty.');
  const expectation = directLifecycleExpectation({ command, trigger });
  // Per-case attribution window: only records inside the window may classify
  // the case, so a later case's records can never relabel this one.
  const inWindow = (record) => record.sequence >= start && record.sequence < end;
  const windowed = records.filter(inWindow);
  const evidenceRefs = [];

  const request = windowed.find((record) => record.kind === 'request-sent' && record.phase === phase && record.probeLabel === probeLabel) ?? null;
  if (!request) {
    return {
      classification: 'not-observed', command, trigger, requestState: null, holdStarted: false,
      handlerOutcome: null, workerOutcome: null, workerOwned: false, triggerOutcome: null,
      sentinelClassification: 'not-observed', reasonCode: null, evidenceRefs,
    };
  }
  if (request.state === 'sent') evidenceRefs.push(`request-sent@${request.sequence}`);

  const notSent = (reasonCode, extra = {}) => ({
    classification: 'not-sent', command, trigger, requestState: request.state, holdStarted: false,
    handlerOutcome: null, workerOutcome: null, workerOwned: false, triggerOutcome: null,
    sentinelClassification: 'not-observed', reasonCode, evidenceRefs, ...extra,
  });

  if (request.state !== 'sent') return notSent('request-not-sent');
  const call = reduced.calls.find((entry) => entry.phase === phase && entry.probeLabel === probeLabel) ?? null;
  if (!call) return notSent('entry-not-joined');
  const entryRecord = windowed.find((record) => record.kind === 'handler-entered' && record.phase === phase && record.probeLabel === probeLabel) ?? null;
  if (entryRecord) evidenceRefs.push(`handler-entered@${entryRecord.sequence}`);
  const holdRecord = windowed.find((record) => record.kind === 'hold-started' && record.phase === phase && record.callNonce === call.callNonce) ?? null;
  if (!holdRecord) return notSent('hold-not-started');
  evidenceRefs.push(`hold-started@${holdRecord.sequence}`);

  // The exact-turn prerequisite: an explicit interruption may only be sent
  // when the driver independently confirmed the exact active turn. Missing
  // prerequisite records not-sent — never an inferred trigger.
  if (trigger === 'turn-interrupt' && exactTurnConfirmed !== true) return notSent('turn-not-confirmed');

  const triggerRecord = windowed.find((record) => record.kind === 'trigger-sent' && record.phase === phase && record.callNonce === call.callNonce) ?? null;
  const triggerOutcome = triggerRecord ? triggerRecord.outcome : null;
  if (triggerRecord) evidenceRefs.push(`trigger-sent@${triggerRecord.sequence}`);
  if (triggerOutcome === 'not-sent') return notSent('trigger-not-sent');

  const handlerSettledRecord = windowed.find((record) => record.kind === 'handler-settled' && record.phase === phase && record.callNonce === call.callNonce) ?? null;
  const workerSettledRecord = windowed.find((record) => record.kind === 'worker-settled' && record.phase === phase && record.callNonce === call.callNonce) ?? null;
  if (handlerSettledRecord) evidenceRefs.push(`handler-settled@${handlerSettledRecord.sequence}`);
  if (workerSettledRecord) evidenceRefs.push(`worker-settled@${workerSettledRecord.sequence}`);
  const handlerOutcome = handlerSettledRecord ? handlerSettledRecord.outcome : null;
  const workerOutcome = workerSettledRecord ? workerSettledRecord.outcome : null;
  // Exact ownership: the settlement the reducer admitted already joined the
  // held worker (the authenticated reduction fails closed on a foreign
  // worker); the classifier re-derives the fact from the durable pair.
  const workerOwned = workerSettledRecord !== null && workerSettledRecord.workerHash === holdRecord.workerHash;
  if (workerSettledRecord !== null && !workerOwned) {
    return {
      classification: 'expectation-mismatch', command, trigger, requestState: request.state, holdStarted: true,
      handlerOutcome, workerOutcome, workerOwned: false, triggerOutcome,
      sentinelClassification: 'not-observed', reasonCode: 'worker-unowned', evidenceRefs,
    };
  }

  // The unrelated sentinel: for per-call triggers it must survive; being
  // cancelled by them is overly broad cancellation — a contradiction.
  let sentinelClassification = 'not-observed';
  let sentinelUnprovenReason = 'sentinel-never-settled';
  if (sentinelLabel !== null) {
    const sentinelCall = reduced.calls.find((entry) => entry.phase === phase && entry.probeLabel === sentinelLabel) ?? null;
    const sentinelWorkerRecord = sentinelCall
      ? windowed.find((record) => record.kind === 'worker-settled' && record.phase === phase && record.callNonce === sentinelCall.callNonce) ?? null
      : null;
    if (sentinelCall !== null && sentinelWorkerRecord !== null) {
      // The durable boundary marker for per-call triggers: the target's own
      // cancellation settlement.
      const boundaryRecord = DIRECT_LIFECYCLE_PER_CALL_TRIGGERS.includes(trigger)
        && workerSettledRecord !== null
        && (workerSettledRecord.outcome === 'cancelled' || workerSettledRecord.outcome === 'timed-out')
        ? workerSettledRecord
        : null;
      const sentinelHoldRecord = sentinelCall !== null
        ? windowed.find((record) => record.kind === 'hold-started' && record.phase === phase && record.callNonce === sentinelCall.callNonce) ?? null
        : null;
      const sentinelHandlerRecord = sentinelCall !== null
        ? windowed.find((record) => record.kind === 'handler-settled' && record.phase === phase && record.callNonce === sentinelCall.callNonce) ?? null
        : null;
      const triggerSentRecord = DIRECT_LIFECYCLE_PER_CALL_TRIGGERS.includes(trigger)
        ? windowed.find((record) => record.kind === 'trigger-sent' && record.phase === phase && record.callNonce === call.callNonce) ?? null
        : null;
      // The DRIVER-ordered release marker: an acknowledged trigger-observed
      // record for the sentinel's call, written by the DRIVER. The VERIFIED
      // release chain additionally requires the marker to follow BOTH the
      // trigger declaration and the durably observed cancellation boundary —
      // a marker that precedes either proves no post-boundary release.
      const releaseMarkerRecord = (sentinelCall === null)
        ? null
        : windowed.find((record) => record.kind === 'trigger-observed'
            && record.phase === phase
            && record.callNonce === sentinelCall.callNonce
            && record.outcome === 'acknowledged'
            && record.source === 'driver') ?? null;
      const driverReleaseMarker = releaseMarkerRecord !== null
        && triggerSentRecord !== null
        && boundaryRecord !== null
        && releaseMarkerRecord.sequence > triggerSentRecord.sequence
        && releaseMarkerRecord.sequence > boundaryRecord.sequence
        ? releaseMarkerRecord
        : null;
      if (DIRECT_LIFECYCLE_PER_CALL_TRIGGERS.includes(trigger) && trigger !== 'turn-interrupt') {
        // HOST-INTERNAL boundary (the configured timeout deciding inside the
        // host): the cancellation-decision instant cannot be durably ordered
        // against the externally observed hold, whatever the journal
        // orderings show — the server writes its settlement asynchronously,
        // so a slow-started sentinel can always appear to span the decision.
        // Neither survival nor broad-cancellation catches are orderable here;
        // isolation stays unproven for these triggers.
        sentinelClassification = 'unproven';
        sentinelUnprovenReason = 'sentinel-ordering-unprovable';
      } else if (releaseMarkerRecord !== null && driverReleaseMarker === null) {
        // A driver release marker that does not follow the trigger
        // declaration and the durably observed boundary is OUT OF ORDER:
        // the release chain it claims was never verified against the
        // boundary, so the ordering stays unprovable.
        sentinelClassification = 'unproven';
        sentinelUnprovenReason = 'sentinel-ordering-unprovable';
      } else if (driverReleaseMarker !== null) {
        // Verified driver-ordered release chain. Even here, isolation stays
        // UNPROVABLE: the server's tools/call RESPONSE is written only AFTER
        // both terminal records are durably committed (holdDirect awaits the
        // settlement, then the terminal reconciliation, and only then
        // returns its result), so a broad cancellation that DECIDED the
        // sentinel's outcome before the release — with its terminal writes
        // landing after the marker — produces a journal IDENTICAL to a
        // genuine post-release decision, while the request was still
        // outstanding (cancelRequestById returned true) either way. The
        // decision instant is durably unorderable against the targeted
        // release.
        if (sentinelHandlerRecord === null) {
          sentinelClassification = 'unproven';
          sentinelUnprovenReason = 'sentinel-handler-terminal-missing';
        } else if (sentinelHandlerRecord.sequence <= driverReleaseMarker.sequence
          || sentinelWorkerRecord.sequence <= driverReleaseMarker.sequence) {
          sentinelClassification = 'unproven';
          sentinelUnprovenReason = 'sentinel-handler-before-release';
        } else if (sentinelHandlerRecord.outcome !== sentinelWorkerRecord.outcome) {
          sentinelClassification = 'unproven';
          sentinelUnprovenReason = 'sentinel-terminals-inconsistent';
        } else if (sentinelWorkerRecord.outcome === 'completed') {
          // The watchdog won the race: the completion decision is the probe
          // server's internal timer.
          sentinelClassification = 'unproven';
          sentinelUnprovenReason = 'sentinel-watchdog-unprovable';
        } else if (sentinelWorkerRecord.outcome !== 'cancelled') {
          // Only a `cancelled` settlement is the server's cancellation
          // decision at all; any other non-completed outcome cannot witness
          // the targeted release.
          sentinelClassification = 'unproven';
          sentinelUnprovenReason = 'sentinel-outcome-unprovable';
        } else {
          // Cancelled terminals postdating the verified marker: the release
          // chain is real, but the DECISION may still have preceded it (a
          // broad cancellation with delayed terminal writes — see above), so
          // the misattribution cannot be excluded.
          sentinelClassification = 'unproven';
          sentinelUnprovenReason = 'sentinel-decision-order-unprovable';
        }
      } else if (sentinelWorkerRecord !== null && sentinelWorkerRecord.outcome !== 'completed') {
        // No verified release and the sentinel settled non-completed: broad
        // cancellation acted before any driver-ordered release.
        sentinelClassification = 'caught';
      } else if (boundaryRecord === null) {
        // The cancellation boundary was never durably observed: survival
        // cannot be claimed against a boundary that did not happen.
        sentinelClassification = 'unproven';
        sentinelUnprovenReason = 'boundary-not-yet-observed';
      } else if (sentinelHandlerRecord !== null && sentinelHandlerRecord.sequence <= boundaryRecord.sequence) {
        // The sentinel's handler terminal committed before the boundary
        // settlement: the sentinel had already finished when the cancellation
        // acted, and a worker terminal straddling the boundary afterward is
        // a delayed log write, not isolation.
        sentinelClassification = 'unproven';
        sentinelUnprovenReason = 'sentinel-handler-expired-before-boundary';
      } else if (sentinelWorkerRecord.sequence <= boundaryRecord.sequence) {
        // The sentinel completed before the boundary settlement landed: it
        // was already finished when the cancellation acted.
        sentinelClassification = 'unproven';
        sentinelUnprovenReason = 'sentinel-expired-before-boundary';
      } else if (sentinelHoldRecord !== null && sentinelHoldRecord.sequence >= triggerSentRecord.sequence) {
        // Driver-ordered boundary: the sentinel's hold-started must PRECEDE
        // the driver's trigger-sent marker. A hold-started that postdates the
        // declaration means the action may have occurred before the sentinel
        // existed.
        sentinelClassification = 'unproven';
        sentinelUnprovenReason = 'sentinel-ordering-inverted';
      } else {
        // A watchdog self-completed sentinel can never prove per-call
        // isolation: the completion decision is this probe server's internal
        // timer, durably unorderable against the host's cancellation action.
        sentinelClassification = 'unproven';
        sentinelUnprovenReason = 'sentinel-watchdog-unprovable';
      }
    } else if (sentinelCall !== null) {
      // A joined sentinel whose own durable worker settlement is missing
      // from the case window is UNPROVEN — a timed-out sentinel RPC can
      // still report a joined call, so survival may never be inferred from
      // the absence of a cancellation record.
      sentinelClassification = 'unproven';
    }
  }

  const mismatch = (reasonCode) => ({
    classification: 'expectation-mismatch', command, trigger, requestState: request.state, holdStarted: true,
    handlerOutcome, workerOutcome, workerOwned, triggerOutcome, sentinelClassification, reasonCode, evidenceRefs,
  });
  const observed = (classification, reasonCode) => ({
    classification, command, trigger, requestState: request.state, holdStarted: true,
    handlerOutcome, workerOutcome, workerOwned, triggerOutcome, sentinelClassification, reasonCode, evidenceRefs,
  });

  // A sentinel the case REQUIRED but could not dispatch is itself a
  // contradiction under the command expectation: it can never distinguish a
  // settled case from one where the trigger's cancellation was broader than
  // observed, so it is flagged, never silently dropped.
  if (sentinelDispatchFailed === true && DIRECT_LIFECYCLE_PER_CALL_TRIGGERS.includes(trigger)) {
    return mismatch('sentinel-undispatched');
  }
  // The observation-only placement rule: caller cancellation ends ONLY the
  // observation and can never settle the tracked job. A durable `cancelled`
  // worker terminal under an observation-scoped placement contradicts the
  // command expectation OUTRIGHT — flagged before any isolation or
  // unprovability state, so a race (or any trigger) that killed the observed
  // job can never pass behind an unproven sentinel.
  if (expectation.scope === 'observation' && workerSettledRecord !== null && workerOutcome === 'cancelled') {
    return mismatch(command === 'status-wait' ? 'status-target-killed' : 'unexpected-worker-outcome');
  }
  if (sentinelClassification === 'caught') return mismatch('sentinel-caught');
  // A per-call case without an established sentinel never ran its isolation
  // check: unproven, whatever the target's own terminals show.
  if (DIRECT_LIFECYCLE_PER_CALL_TRIGGERS.includes(trigger) && sentinelLabel === null) {
    return observed('settlement-unproven', 'sentinel-missing');
  }
  // WINDOW B (the gap): the target's cancellation settlement must POSTDATE
  // the driver's trigger declaration. A settlement that precedes the
  // declared action was independent of it — the apparent span proves no
  // action settlement, whatever the sentinel's own orderings show.
  if (DIRECT_LIFECYCLE_PER_CALL_TRIGGERS.includes(trigger) && workerSettledRecord !== null
    && triggerRecord !== null && workerSettledRecord.sequence <= triggerRecord.sequence) {
    return observed('settlement-unproven', 'settlement-before-trigger');
  }
  // A race case demonstrates completion-versus-cancellation only when the
  // cancellation boundary itself was durably observed (a cancellation-outcome
  // worker settlement). A worker that merely completed with a clean RPC — or
  // with only a generic host error — proves no race.
  if (trigger === 'cancel-race' && cancellationObserved !== true) {
    return observed('settlement-unproven', 'cancellation-boundary-unobserved');
  }

  if (workerSettledRecord === null) {
    // A handler terminal without its worker terminal is a partial
    // settlement — never a demonstrated one, whatever the placement.
    if (handlerSettledRecord !== null) {
      return observed('settlement-unproven', 'worker-never-settled');
    }
    // No durable terminal on the target. Observation-only placements: the
    // tracked job remaining active after the caller's wait ended IS the
    // existing behavior — but the placement fact alone confirms nothing.
    // The case must show (1) the caller's cancellation was durably
    // ACKNOWLEDGED for this call, and (2) a specific WAIT-ENDED observation:
    // the wait call itself answered or was rejected (an rpc-observed
    // `not-observed` is an indefinitely pending wait and can never become a
    // passing case). Anything less is unproven.
    if (expectation.scope === 'observation' && expectation.settlesWorker === false) {
      const triggerObservedForCall = windowed.find((record) => record.kind === 'trigger-observed' && record.phase === phase && record.callNonce === call.callNonce) ?? null;
      const rpcObservedForCall = windowed.find((record) => record.kind === 'rpc-observed' && record.phase === phase && record.callNonce === call.callNonce) ?? null;
      const waitEnded = rpcObservedForCall !== null && DIRECT_LIFECYCLE_WAIT_ENDED_OUTCOMES.includes(rpcObservedForCall.outcome);
      if (triggerObservedForCall === null || triggerObservedForCall.outcome !== 'acknowledged' || !waitEnded) {
        return observed('settlement-unproven', 'wait-ended-unobserved');
      }
      // The behavior claim covers the WHOLE case, and the G3 gate accepts
      // behavior-confirmed — so the sentinel's CLASSIFICATION RESULT must be
      // conclusive, not merely its terminal's existence. Since the
      // decision-order adjudication removed survival, NO per-call sentinel
      // classification is ever conclusive: a demonstrably caught sentinel is
      // the expectation mismatch, and every unproven classification
      // (ordering-unprovable, decision-order-unprovable, watchdog-unprovable,
      // never-settled) keeps the case unproven with that reason — broad
      // cancellation can never be counted as qualified behavior. Only a case
      // with NO sentinel at all can confirm the observation behavior.
      if (sentinelClassification === 'caught') {
        return mismatch('sentinel-caught');
      }
      if (sentinelLabel !== null) {
        return observed('settlement-unproven', sentinelClassification === 'unproven' ? sentinelUnprovenReason : 'sentinel-never-settled');
      }
      return observed('behavior-confirmed', 'job-remains-active');
    }
    // Operation-scoped demands with no observed boundary: the sentinel
    // cannot claim isolation, and the target never settled.
    if (sentinelClassification === 'unproven') {
      return observed('settlement-unproven', sentinelUnprovenReason);
    }
    return observed('settlement-unproven', 'worker-never-settled');
  }
  // The two-terminal invariant: a settlement is demonstrated only by BOTH
  // joined terminal records agreeing on one outcome.
  if (handlerSettledRecord === null) {
    return observed('settlement-unproven', 'handler-terminal-missing');
  }
  if (handlerOutcome !== workerOutcome) {
    return observed('settlement-unproven', 'inconsistent-terminals');
  }
  // A turn/interrupt settlement claim additionally requires the driver's
  // trigger-observed record for the SAME call to show the host ACKNOWLEDGED
  // the requested interrupt: a rejected (or unobserved) interrupt means the
  // target's cancellation was independent, and misattributing it — or the
  // sentinel's isolation — to the rejected action is forged evidence.
  if (trigger === 'turn-interrupt') {
    const triggerObservedRecord = windowed.find((record) => record.kind === 'trigger-observed' && record.phase === phase && record.callNonce === call.callNonce) ?? null;
    if (triggerObservedRecord === null || triggerObservedRecord.outcome !== 'acknowledged') {
      return observed('settlement-unproven', 'trigger-not-acknowledged');
    }
  }
  // A settlement claim additionally demands the sentinel's boundary-spanning
  // isolation proof for per-call triggers.
  if (sentinelClassification === 'unproven') {
    return observed('settlement-unproven', sentinelUnprovenReason);
  }
  if (expectation.workerOutcomes !== null && !expectation.workerOutcomes.includes(workerOutcome)) {
    return mismatch(command === 'status-wait' && workerOutcome === 'cancelled' ? 'status-target-killed' : 'unexpected-worker-outcome');
  }
  return observed('settlement-observed', null);
}

/**
 * Assesses the reconciliation-strategy candidate (plan Task 5 Step 5): a
 * missing handler abort may be satisfiable through an existing durable
 * stop-intent/supervision seam ONLY where a durable writer survives. The
 * synthetic worker tests must first prove exact ownership and bounded
 * settlement; without them the strategy is rejected under its conditions.
 * Even demonstrated, the strategy is mechanism evidence with limits — it can
 * never upgrade G3 by itself, and host loss stays outside its coverage
 * (no durable writer survives, so bounded settlement after host loss is
 * unreachable by construction).
 * @param {{exactOwnershipProven: boolean, boundedSettlementProven: boolean, hostLossSettlementDemonstrated: boolean}} input
 * @returns {{status: 'demonstrated'|'demonstrated-with-limits'|'rejected', reasonCode: string|null}}
 */
export function assessDirectReconciliationStrategy({ exactOwnershipProven, boundedSettlementProven, hostLossSettlementDemonstrated }) {
  if (exactOwnershipProven !== true || boundedSettlementProven !== true) {
    return { status: 'rejected', reasonCode: 'ownership-or-boundedness-unproven' };
  }
  if (hostLossSettlementDemonstrated !== true) {
    return { status: 'demonstrated-with-limits', reasonCode: 'host-loss-unreconcilable' };
  }
  return { status: 'demonstrated', reasonCode: null };
}
