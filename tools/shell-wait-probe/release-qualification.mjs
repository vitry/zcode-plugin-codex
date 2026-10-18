// @ts-check
/**
 * Small offline release-qualification verdicts (plan §2 "conditional new
 * release-qualification.mjs"; report §16.4–§16.6). Pure, closed-enum, and
 * fail-closed: missing evidence stays null/unknown — never zero, never a
 * fabricated pass. This module is a VERDICT layer only: it reads already
 * adjudicated typed facts (the observer's and mapper's projections) and adds
 * NO second interpreter, rollout parser, or business-state machine.
 *
 * Families:
 *  - M extraction (`deriveMeasuredInnerCapMs`): the measured inner cap from
 *    an original-handle NONTERMINAL poll's own time only.
 *  - Long/repeat gates (`evaluateDecisivePollHeadroom`,
 *    `classifyLongObservation`, `evaluateRepeatQualification`): the plan §3
 *    Gate B arithmetic — each of L and R independently needs decisive-
 *    poll-start remaining lifetime ≥ M+30000 and an attributable original-
 *    handle natural observation beyond M.
 *  - Exact output linkage (`evaluateExactTerminalLinkage`): byte-exact
 *    terminal/exit linkage — the legacy substring sentinel can never
 *    satisfy it.
 *  - Cadence (`summarizeObservationCadence`, `compareObservationCadence`):
 *    inner observations, outer continuations, and total observation
 *    re-entry counted separately from Root joins and preparation; unknown
 *    counts are never whole-job-zero claims.
 *  - Survival control (`evaluateSurvivalControl`): the §16.4 emission-time
 *    no-collateral qualification with the mandated buffered-output
 *    negatives.
 *  - Native settlement (`evaluateNativeInterruptionSettlement`): the §16.3/
 *    §16.6 Gate-D layer aggregation with every mandated rejection.
 */

import { renderOutput } from '../../scripts/lib/render.mjs';

// The DESIGNED exit code of the §16.4 survival control — the fixture-owned
// script's declared design constant (fixture.mjs survivalControlDeclaration
// `designedExitCode`): the control completes line 30 with exit code 0.
// Natural-completion credit requires the OBSERVED exit code to equal it
// (codex review round 13).
const DESIGNED_CONTROL_EXIT_CODE = 0;
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Module-INIT snapshot of THIS module's executing source (the same
// provenance discipline as evidence.mjs): the driver's observer digest
// hashes these bytes because this helper actually executes during evidence
// adjudication (the exact terminal expectation) — changing this helper alone
// must change the observer digest and flip sourcesChangedDuringRun, never
// preserve them.
export const EXECUTING_RELEASE_QUALIFICATION_SOURCE = readFileSync(fileURLToPath(import.meta.url));

/** The closed oracle version carried by every verdict-bearing export. */
export const RELEASE_QUALIFICATION_VERSION = 1;

/**
 * The plan §3 Gate B margin: each of L and R needs decisive-poll-start
 * remaining lifetime ≥ measured M + this margin.
 */
export const REPEAT_MIN_HEADROOM_MS = 30_000;

/** @param {string} message @returns {TypeError} */
function invalidQualificationInput(message) {
  return new TypeError(`Invalid release-qualification input: ${message}`);
}

/**
 * Stamp the closed oracle version onto a verdict: offline re-adjudication
 * must be able to prove WHICH oracle version produced any persisted verdict,
 * so every verdict-bearing export embeds the version in its return shape.
 * @template T
 * @param {T} verdict
 * @returns {T & { releaseQualificationVersion: number }}
 */
function withOracleVersion(verdict) {
  return { ...verdict, releaseQualificationVersion: RELEASE_QUALIFICATION_VERSION };
}

/** @param {unknown} value @returns {value is number} */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** @param {unknown} value @returns {value is number} */
function isNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * One Gate B arm's measured facts.
 * @typedef {{
 *   remainingLifetimeMs: number | null,
 *   longObservationWallMs: number | null,
 *   observationAttributable: boolean,
 *   exactTerminalMatch: boolean | null,
 * }} ReleaseQualificationArm
 */

/**
 * Derive the measured inner cap M (plan Task 3): ONLY an original-handle
 * inner poll that reached its cap with a LIVE process handle qualifies — the
 * poll must be attributable to the original handle, the INNER call must be
 * nonterminal (it awaited its clamped cap and returned a live handle without
 * an exit code while the worker still runs), the requested window must NOT
 * have expired (otherwise the return is explained by the window, not the
 * cap), and no interrupt/preempt/alternate ender (a delivered interrupt, an
 * explicit pragma, or a non-code-mode call surface) may have ended the poll.
 * A mere OUTER code-mode cell yield (`outer-yield-inner-unresolved`) leaves
 * the inner call unresolved and NEVER establishes the inner cap; an inner
 * process that exited is terminal, not a cap measurement. Every
 * unestablishable input stays null with its closed reason — never a source
 * default, never the last terminal poll, never zero.
 * @param {{
 *   attributable: boolean,
 *   innerNonterminality: 'inner-cap-live-handle' | 'inner-process-exited' | 'outer-yield-inner-unresolved' | 'unknown',
 *   firstReturnWallMs: number | null,
 *   requestedInnerYieldMs: number | null,
 *   interruptAttempted: boolean | null,
 *   decisivePollExplicitYield: 'absent' | 'present' | 'unknown',
 *   decisiveCallSurface: 'code-mode-wrapper' | 'direct-native' | 'unknown' | null,
 * }} observation the waitPolicy observation facts of the decisive poll
 * @returns {{ measuredCapMs: number | null, reason: string | null, releaseQualificationVersion: number }}
 */
export function deriveMeasuredInnerCapMs(observation) {
  if (!observation || typeof observation !== 'object') throw invalidQualificationInput('the M observation must be an object.');
  if (observation.attributable !== true) return withOracleVersion({ measuredCapMs: null, reason: 'observation-unattributed' });
  if (observation.innerNonterminality === 'outer-yield-inner-unresolved') {
    return withOracleVersion({ measuredCapMs: null, reason: 'outer-yield-inner-unresolved' });
  }
  if (observation.innerNonterminality === 'inner-process-exited') {
    return withOracleVersion({ measuredCapMs: null, reason: 'first-return-not-nonterminal' });
  }
  if (observation.innerNonterminality !== 'inner-cap-live-handle') {
    return withOracleVersion({ measuredCapMs: null, reason: 'inner-nonterminality-unestablished' });
  }
  if (observation.interruptAttempted === true) return withOracleVersion({ measuredCapMs: null, reason: 'alternate-ender-interrupt' });
  if (observation.interruptAttempted !== false) return withOracleVersion({ measuredCapMs: null, reason: 'interrupt-state-unestablished' });
  if (observation.decisivePollExplicitYield === 'present') return withOracleVersion({ measuredCapMs: null, reason: 'explicit-pragma-present' });
  // M requires the ABSENCE of explicit overrides to be OBSERVED, never
  // assumed: the supported 'unknown' state (and anything else) leaves the
  // pragma question unestablished and cannot ground a cap measurement.
  if (observation.decisivePollExplicitYield !== 'absent') return withOracleVersion({ measuredCapMs: null, reason: 'pragma-state-unestablished' });
  if (observation.decisiveCallSurface !== 'code-mode-wrapper') return withOracleVersion({ measuredCapMs: null, reason: 'unsupported-call-surface' });
  if (!isFiniteNumber(observation.firstReturnWallMs) || observation.firstReturnWallMs <= 0) return withOracleVersion({ measuredCapMs: null, reason: 'missing-evidence' });
  if (!isFiniteNumber(observation.requestedInnerYieldMs) || observation.requestedInnerYieldMs <= 0) return withOracleVersion({ measuredCapMs: null, reason: 'missing-evidence' });
  if (observation.firstReturnWallMs >= observation.requestedInnerYieldMs) return withOracleVersion({ measuredCapMs: null, reason: 'requested-window-expired' });
  return withOracleVersion({ measuredCapMs: observation.firstReturnWallMs, reason: null });
}

/**
 * The plan §3 precondition: decisive-poll-start remaining lifetime must be
 * at least measured M + 30000. Both inputs are the driver's measured
 * monotonic-clock facts (the remaining lifetime's detection lag makes it a
 * conservative lower bound). null M or null remaining lifetime never
 * fabricates a pass.
 * @param {{ measuredCapMs: number | null, remainingLifetimeMs: number | null }} input
 * @returns {{ qualified: boolean, headroomMs: number | null, reason: string | null, releaseQualificationVersion: number }}
 */
export function evaluateDecisivePollHeadroom(input) {
  if (!input || typeof input !== 'object') throw invalidQualificationInput('the headroom input must be an object.');
  if (!isFiniteNumber(input.measuredCapMs) || input.measuredCapMs <= 0) {
    return withOracleVersion({ qualified: false, headroomMs: null, reason: 'measured-cap-unavailable' });
  }
  if (!isFiniteNumber(input.remainingLifetimeMs) || input.remainingLifetimeMs < 0) {
    return withOracleVersion({ qualified: false, headroomMs: null, reason: 'remaining-lifetime-unavailable' });
  }
  const headroomMs = input.remainingLifetimeMs - input.measuredCapMs;
  if (headroomMs < REPEAT_MIN_HEADROOM_MS) {
    return withOracleVersion({ qualified: false, headroomMs, reason: 'insufficient-headroom' });
  }
  return withOracleVersion({ qualified: true, headroomMs, reason: null });
}

/**
 * Classify the attributable original-handle natural long observation against
 * the measured reference M. An observation that finished naturally BEFORE
 * the reference is INCONCLUSIVE for cap propagation — never host failure —
 * and an unattributed or unestablishable observation is never evidence.
 * @param {{ observationWallMs: number | null, measuredCapMs: number | null, attributable: boolean }} input
 * @returns {{ classification: 'beyond-reference' | 'inconclusive-before-reference' | 'unattributed' | 'unavailable', releaseQualificationVersion: number }}
 */
export function classifyLongObservation(input) {
  if (!input || typeof input !== 'object') throw invalidQualificationInput('the long-observation input must be an object.');
  if (input.attributable !== true) return withOracleVersion({ classification: 'unattributed' });
  if (!isFiniteNumber(input.observationWallMs) || !isFiniteNumber(input.measuredCapMs)) {
    return withOracleVersion({ classification: 'unavailable' });
  }
  return withOracleVersion(input.observationWallMs > input.measuredCapMs
    ? { classification: 'beyond-reference' }
    : { classification: 'inconclusive-before-reference' });
}

/**
 * Evaluate one Gate B arm. Internal helper for
 * {@link evaluateRepeatQualification}: a DEFINITIVE failure (too-short
 * headroom, terminal mismatch, unattributed observation) fails the arm; an
 * UNESTABLISHED fact leaves it inconclusive.
 * @param {ReleaseQualificationArm} arm
 * @param {number | null} measuredCapMs
 * @returns {{ state: 'qualified' | 'failed' | 'inconclusive', reasons: string[] }}
 */
function evaluateRepeatArm(arm, measuredCapMs) {
  if (!arm || typeof arm !== 'object') throw invalidQualificationInput('each repeat arm must be an object.');
  /** @type {string[]} */
  const reasons = [];
  /** @type {'qualified' | 'failed' | 'inconclusive'} */
  let state = 'qualified';
  const headroom = evaluateDecisivePollHeadroom({ measuredCapMs, remainingLifetimeMs: arm.remainingLifetimeMs });
  if (!headroom.qualified) {
    if (headroom.reason === 'insufficient-headroom') {
      reasons.push('insufficient-headroom');
      state = 'failed';
    } else {
      reasons.push(headroom.reason ?? 'headroom-unestablished');
      // `state` is still 'qualified' here (the failed branch returned above
      // it in the headroom gate), so the arm stays inconclusive.
      state = 'inconclusive';
    }
  }
  const observation = classifyLongObservation({
    observationWallMs: arm.longObservationWallMs,
    measuredCapMs,
    attributable: arm.observationAttributable === true,
  });
  if (observation.classification === 'beyond-reference') {
    // required evidence present
  } else if (observation.classification === 'inconclusive-before-reference' || observation.classification === 'unavailable') {
    reasons.push(`inconclusive-${observation.classification === 'inconclusive-before-reference' ? 'before-reference' : 'observation'}`);
    if (state !== 'failed') state = 'inconclusive';
  } else {
    reasons.push('observation-unattributed');
    state = 'failed';
  }
  if (arm.exactTerminalMatch === false) {
    reasons.push('terminal-linkage-mismatch');
    state = 'failed';
  } else if (arm.exactTerminalMatch !== true) {
    reasons.push('terminal-linkage-unestablished');
    if (state !== 'failed') state = 'inconclusive';
  }
  return { state, reasons };
}

/**
 * Gate B (plan §3): EACH of L and R must independently satisfy decisive-
 * poll-start remaining lifetime ≥ M+30000 AND an attributable original-
 * handle natural observation beyond M, with exact terminal linkage, on
 * identical (fresh-repeat) settings. Definitive arm failures or changed
 * settings are NOT qualified; unestablishable facts stay inconclusive —
 * null M never fabricates a pass.
 * @param {{
 *   measuredCapMs: number | null,
 *   settingsIdentical: boolean | null,
 *   leader: ReleaseQualificationArm,
 *   repeat: ReleaseQualificationArm,
 * }} input
 * @returns {{ verdict: 'repeat-qualified' | 'repeat-not-qualified' | 'inconclusive', reasons: string[], releaseQualificationVersion: number }}
 */
export function evaluateRepeatQualification(input) {
  if (!input || typeof input !== 'object') throw invalidQualificationInput('the repeat input must be an object.');
  if (!isFiniteNumber(input.measuredCapMs) || input.measuredCapMs <= 0) {
    return withOracleVersion({ verdict: 'inconclusive', reasons: ['measured-cap-unavailable'] });
  }
  /** @type {string[]} */
  const reasons = [];
  for (const [label, arm] of /** @type {[string, ReleaseQualificationArm][]} */ ([['leader', input.leader], ['repeat', input.repeat]])) {
    const evaluated = evaluateRepeatArm(arm, input.measuredCapMs);
    for (const reason of evaluated.reasons) reasons.push(`${label}:${reason}`);
    if (evaluated.state === 'failed') {
      return withOracleVersion({ verdict: 'repeat-not-qualified', reasons });
    }
  }
  if (input.settingsIdentical === false) return withOracleVersion({ verdict: 'repeat-not-qualified', reasons: ['settings-mismatch'] });
  if (input.settingsIdentical !== true) return withOracleVersion({ verdict: 'inconclusive', reasons: ['settings-unestablished'] });
  if (reasons.length > 0) return withOracleVersion({ verdict: 'inconclusive', reasons });
  return withOracleVersion({ verdict: 'repeat-qualified', reasons: [] });
}

/**
 * The exact-output gate (plan Task 2; report §16.6 Gate B wording "exact
 * terminal linkage"): the linked terminal output must equal the expected
 * production-rendered framing BYTE-FOR-BYTE and the exit code must link
 * exactly. Codex review round 12: the compared surface is the VALIDATED
 * stdout-only capture (`terminalStdout`) — a source with TRUE stream
 * attribution. The pinned unified-exec serialization merges stdout/stderr
 * chunks as they arrive, so merged rollout bytes carry no attributable
 * stream split: with no capture the equality is UNESTABLISHED (explicit
 * reason) — never a false `extra-output`, never a strip heuristic. The
 * legacy substring sentinel semantics can never satisfy this gate;
 * sentinel-plus-extra-stdout and truncated output are named rejections.
 * @param {{
 *   terminalStdout: string | null,
 *   exitCode: number | null,
 *   expectedOutput: string,
 *   expectedExitCode: number,
 * }} input
 * @returns {{ matched: boolean | null, reason: string | null, releaseQualificationVersion: number }}
 */
export function evaluateExactTerminalLinkage(input) {
  if (!input || typeof input !== 'object') throw invalidQualificationInput('the exact-linkage input must be an object.');
  if (typeof input.expectedOutput !== 'string' || input.expectedOutput.length === 0
    || !isNonNegativeInteger(input.expectedExitCode)) {
    throw invalidQualificationInput('the exact expectation must carry a nonempty output string and a nonnegative exit code.');
  }
  // Stream attribution first: without a validated stdout-only capture the
  // byte comparison is unestablished, whatever the merged buffer contains.
  // Codex review round 16: an EMPTY capture is a VALID attributable capture
  // (a process can exit without emitting the expected result) and compares
  // definitively (truncated output against the nonempty expectation); the
  // unavailable verdict is reserved for ABSENT (null/undefined) captures.
  if (input.terminalStdout === null || input.terminalStdout === undefined) {
    return withOracleVersion({ matched: null, reason: 'stdout-stream-attribution-unavailable' });
  }
  if (typeof input.terminalStdout !== 'string') {
    throw invalidQualificationInput('the terminalStdout must be a string (the validated stdout capture) or null/undefined (absent capture).');
  }
  if (!isNonNegativeInteger(input.exitCode)) {
    return withOracleVersion({ matched: null, reason: 'missing-evidence' });
  }
  const terminalOutput = input.terminalStdout;
  if (terminalOutput === input.expectedOutput) {
    return withOracleVersion(input.exitCode === input.expectedExitCode
      ? { matched: true, reason: null }
      : { matched: false, reason: 'exit-code-mismatch' });
  }
  if (terminalOutput.includes(input.expectedOutput)) return withOracleVersion({ matched: false, reason: 'extra-output' });
  if (input.expectedOutput.startsWith(terminalOutput)) return withOracleVersion({ matched: false, reason: 'output-truncated' });
  return withOracleVersion({ matched: false, reason: 'output-mismatch' });
}

/**
 * Build the exact production-rendered expectation for the rescue fixture
 * result: the REAL production renderer is the single source of truth — the
 * returned framing is the renderer's own output for the succeeded terminal
 * view (result line plus the Resumability Indicator and its conditional
 * resume hint), never a transcription. Codex round-4 review fix: the
 * indicator line is part of the rendered view whenever the indicator is
 * definite, so an expectation WITHOUT it is PARTIAL — it false-rejects valid
 * output as extra-output and false-accepts framing-less output. An
 * UNESTABLISHED resumability fact (null/undefined — the indicator is derived
 * at projection time from the durable record, the viewing turn's permission
 * mode and binding-currency evidence, and is never persisted) therefore
 * derives NO expectation: the caller leaves the exact equality unestablished
 * instead of comparing against a partial framing.
 * @param {{ result: string, resumable?: boolean | null }} input
 * @returns {{ output: string, exitCode: number } | null} null when the
 *   resumability fact is unestablished
 */
export function exactRescueRenderedExpectation(input) {
  if (!input || typeof input !== 'object' || typeof input.result !== 'string' || input.result.length === 0
    || input.result.length > 4096 || input.resumable !== undefined && input.resumable !== null && typeof input.resumable !== 'boolean') {
    throw invalidQualificationInput('the rescue expectation needs a bounded nonempty result string and an optional boolean resumable fact.');
  }
  if (input.resumable !== true && input.resumable !== false) return null;
  const view = { result: input.result, job: { resumable: input.resumable } };
  return { output: renderOutput(view), exitCode: 0 };
}

/**
 * Cadence accounting (plan Task 2 / Gate C): inner observations and outer
 * continuations compose the total observation re-entry; Root child joins and
 * preparation writes are SEPARATE facts and never part of it. Unknown counts
 * stay unknown — a whole-job-zero claim requires both measured components.
 * @param {{
 *   innerObservations: number | null,
 *   outerContinuations: number | null,
 *   rootJoins: number | null,
 *   preparationWrites: number | null,
 * }} input
 * @returns {{
 *   innerObservations: number | null,
 *   outerContinuations: number | null,
 *   totalObservationReEntry: number | null,
 *   rootJoins: number | null,
 *   preparationWrites: number | null,
 *   establishable: boolean,
 *   reason: string | null,
 *   releaseQualificationVersion: number,
 * }}
 */
export function summarizeObservationCadence(input) {
  if (!input || typeof input !== 'object') throw invalidQualificationInput('the cadence input must be an object.');
  for (const [field, value] of [
    ['innerObservations', input.innerObservations],
    ['outerContinuations', input.outerContinuations],
    ['rootJoins', input.rootJoins],
    ['preparationWrites', input.preparationWrites],
  ]) {
    if (value !== null && value !== undefined && !isNonNegativeInteger(value)) {
      throw invalidQualificationInput(`the ${field} count must be a nonnegative integer or null (unestablished).`);
    }
  }
  const establishable = isNonNegativeInteger(input.innerObservations) && isNonNegativeInteger(input.outerContinuations);
  return withOracleVersion({
    innerObservations: input.innerObservations ?? null,
    outerContinuations: input.outerContinuations ?? null,
    totalObservationReEntry: establishable
      ? /** @type {number} */ (input.innerObservations) + /** @type {number} */ (input.outerContinuations)
      : null,
    rootJoins: input.rootJoins ?? null,
    preparationWrites: input.preparationWrites ?? null,
    establishable,
    reason: establishable ? null : 'cadence-unavailable',
  });
}

/**
 * The reduced-intervention comparison (Gate C): fewer measured observation
 * re-entries under the candidate; equal-or-greater is not reduced; unknown
 * cadence on either side is inconclusive — never a zero claim.
 * @param {{ baseline: ReturnType<typeof summarizeObservationCadence>, candidate: ReturnType<typeof summarizeObservationCadence> }} input
 * @returns {{ verdict: 'reduced' | 'not-reduced' | 'inconclusive', reason: string | null, releaseQualificationVersion: number }}
 */
export function compareObservationCadence(input) {
  if (!input || typeof input !== 'object') throw invalidQualificationInput('the cadence comparison input must be an object.');
  const baselineTotal = input.baseline?.totalObservationReEntry ?? null;
  const candidateTotal = input.candidate?.totalObservationReEntry ?? null;
  if (input.baseline?.establishable !== true || input.candidate?.establishable !== true
    || !isNonNegativeInteger(baselineTotal) || !isNonNegativeInteger(candidateTotal)) {
    return withOracleVersion({ verdict: 'inconclusive', reason: 'cadence-unavailable' });
  }
  const verdict = candidateTotal < baselineTotal ? 'reduced' : 'not-reduced';
  return withOracleVersion({ verdict, reason: null });
}

/**
 * The §16.4 survival-control qualification. Survival binds to EMISSION time,
 * never observation time: continued liveness is proven ONLY by a line whose
 * OWN emission tag falls strictly after the recorded delivery bound, and
 * natural completion ONLY by the completion marker's OWN emission tag after
 * that bound. A post-delivery read that returns buffered bytes proves
 * nothing about when they were written, so every mandated buffered-output
 * negative rejects. Projected facts are the closed §16.4 whitelist.
 * @param {{
 *   deliveryBoundTag: number | null,
 *   lineCount: number,
 *   emittedLines: { index: number, tag: number }[] | null,
 *   completionMarker: { index: number, tag: number } | null,
 *   postDeliveryRead: { occurred: boolean, readable: boolean, returnedLines: boolean } | null,
 *   beforeDeliveryReadObserved: boolean,
 *   ownership: 'root' | 'child' | 'unidentifiable',
 *   controlExitObserved?: boolean | null,
 *   controlExitPremature?: boolean | null,
 *   controlExitCode?: number | null,
 *   completionBeforeDeliveryObserved?: boolean | null,
 * }} input the §16.4 positive-activity clause REQUIRES the bounded
 *   pre-delivery read: `beforeDeliveryReadObserved` is true only when a read
 *   showing a fresh mid-run line was observed ordered before the interrupt
 *   call
 * @returns {{
 *   started: boolean,
 *   lastLineIndexAtDelivery: number | null,
 *   lastEmissionTagBeforeDelivery: number | null,
 *   activityAtDelivery: 'active' | 'completed-before' | 'unknown',
 *   postDelivery: 'alive' | 'completed' | 'lost' | 'unknown',
 *   postDeliveryEmissionTag: number | null,
 *   noCollateralQualified: boolean,
 *   completionBeforeDeliveryObserved: boolean,
 *   reason: string | null,
 *   releaseQualificationVersion: number,
 * }}
 */
export function evaluateSurvivalControl(input) {
  if (!input || typeof input !== 'object') throw invalidQualificationInput('the survival-control input must be an object.');
  if (input.ownership !== 'root' && input.ownership !== 'child' && input.ownership !== 'unidentifiable') {
    throw invalidQualificationInput('the ownership must be "root", "child", or "unidentifiable" (the launch rollout\'s owning-session identity).');
  }
  // Codex review round 8: the independent loss-evidence fact. Absent
  // (undefined) tolerates legacy fact shapes and counts as null — no loss
  // evidence, fail closed.
  if (input.controlExitObserved !== null && input.controlExitObserved !== undefined && typeof input.controlExitObserved !== 'boolean') {
    throw invalidQualificationInput('the controlExitObserved must be a boolean or null (the post-delivery read\'s own observed control exit).');
  }
  // Codex review round 11: the exit's position fact — true when the exit was
  // observed BEFORE the designed final completion (a premature/mid-run exit).
  if (input.controlExitPremature !== null && input.controlExitPremature !== undefined && typeof input.controlExitPremature !== 'boolean') {
    throw invalidQualificationInput('the controlExitPremature must be a boolean or null (whether the observed control exit preceded the designed completion).');
  }
  // Codex review round 13: the OBSERVED exit code — preserved, never
  // discarded; natural-completion credit requires it to equal the designed
  // exit code.
  if (input.controlExitCode !== null && input.controlExitCode !== undefined && !Number.isSafeInteger(input.controlExitCode)) {
    throw invalidQualificationInput('the controlExitCode must be a safe integer or null (the observed control exit code).');
  }
  // Codex review round 14: the independently established pre-delivery
  // completion evidence — the marker-returning read completed before the
  // interrupt request. Absent (undefined) tolerates legacy shapes ⇒ null.
  if (input.completionBeforeDeliveryObserved !== null && input.completionBeforeDeliveryObserved !== undefined && typeof input.completionBeforeDeliveryObserved !== 'boolean') {
    throw invalidQualificationInput('the completionBeforeDeliveryObserved must be a boolean or null (the marker-returning read completed before the request).');
  }
  if (typeof input.beforeDeliveryReadObserved !== 'boolean') {
    throw invalidQualificationInput('the beforeDeliveryReadObserved must be a boolean (the §16.4 pre-delivery read requirement).');
  }
  if (input.deliveryBoundTag !== null && !isFiniteNumber(input.deliveryBoundTag)) {
    throw invalidQualificationInput('the deliveryBoundTag must be a finite number or null (unestablished).');
  }
  if (!Number.isSafeInteger(input.lineCount) || input.lineCount <= 0) {
    throw invalidQualificationInput('the lineCount must be the declared positive integer line count.');
  }
  if (input.emittedLines !== null && (!Array.isArray(input.emittedLines) || input.emittedLines.length === 0)) {
    throw invalidQualificationInput('the emittedLines must be a nonempty array of { index, tag } or null (unobserved).');
  }
  /** @type {{ index: number, tag: number }[]} */
  const lines = input.emittedLines ?? [];
  let previousTag = null;
  let previousIndex = null;
  // Codex self-review round 18: cross-line CONTRADICTIONS (duplicate or
  // decreasing indices, non-monotonic tags) are contradictory emission
  // evidence — the same contradiction class the reader's conflicting-tag
  // path treats as null facts — and produce a NAMED not-qualified verdict,
  // never a throw that would lose the whole run's record. Shape errors
  // (line objects, index bounds, non-finite tags) stay typed-input throws.
  /** @type {() => { started: boolean, lastLineIndexAtDelivery: null, lastEmissionTagBeforeDelivery: null, activityAtDelivery: 'unknown', postDelivery: 'unknown', postDeliveryEmissionTag: null, noCollateralQualified: boolean, completionBeforeDeliveryObserved: boolean, reason: string, releaseQualificationVersion: number }} */
  const contradictoryEmissionVerdict = () => withOracleVersion({
    started: lines.length > 0,
    lastLineIndexAtDelivery: null,
    lastEmissionTagBeforeDelivery: null,
    activityAtDelivery: 'unknown',
    postDelivery: 'unknown',
    postDeliveryEmissionTag: null,
    noCollateralQualified: false,
    completionBeforeDeliveryObserved: input.completionBeforeDeliveryObserved === true,
    reason: 'contradictory-emission-evidence',
  });
  for (const line of lines) {
    if (!line || typeof line !== 'object' || !Number.isSafeInteger(line.index) || line.index < 1 || line.index > input.lineCount) {
      throw invalidQualificationInput(`every emitted line index must be an integer within 1..${String(input.lineCount)} (lineCount).`);
    }
    if (previousIndex !== null && line.index <= previousIndex) {
      return contradictoryEmissionVerdict();
    }
    previousIndex = line.index;
    if (!isFiniteNumber(line.tag)) throw invalidQualificationInput('every emitted line needs a finite emission tag.');
    if (previousTag !== null && line.tag < previousTag) {
      return contradictoryEmissionVerdict();
    }
    previousTag = line.tag;
  }
  if (input.completionMarker !== null && input.completionMarker !== undefined) {
    const marker = input.completionMarker;
    if (!marker || typeof marker !== 'object' || !Number.isSafeInteger(marker.index) || marker.index < 1 || marker.index > input.lineCount
      || !isFiniteNumber(marker.tag)) {
      throw invalidQualificationInput('the completionMarker must be a valid { index, tag } within the declared line count or null (not establishable).');
    }
  }
  if (input.postDeliveryRead !== null && input.postDeliveryRead !== undefined) {
    const read = input.postDeliveryRead;
    if (!read || typeof read !== 'object' || typeof read.occurred !== 'boolean' || typeof read.returnedLines !== 'boolean') {
      throw invalidQualificationInput('the postDeliveryRead must be { occurred: boolean, readable: boolean, returnedLines: boolean } or null.');
    }
    // codex review round 5: `readable` marks the read's OWN attributable
    // decoded response. When absent (legacy fact shapes) it counts as NOT
    // readable — fail closed; when present it must be a real boolean.
    if (read.readable !== undefined && typeof read.readable !== 'boolean') {
      throw invalidQualificationInput('the postDeliveryRead.readable must be a boolean (the read\'s own decoded response) when present.');
    }
  }
  const completionMarker = input.completionMarker ?? null;
  const postDeliveryRead = input.postDeliveryRead ?? null;
  const deliveryBoundTag = input.deliveryBoundTag ?? null;

  const started = lines.length > 0;
  // Codex review round 9: ownership is the more fundamental rejection — a
  // child-owned or unidentifiable control is rejected for OWNERSHIP even
  // when the delivery bound is unestablished; the bound checks below stay
  // authoritative for root-owned controls.
  if (input.ownership !== 'root') {
    return withOracleVersion({
      started,
      lastLineIndexAtDelivery: null,
      lastEmissionTagBeforeDelivery: null,
      activityAtDelivery: 'unknown',
      postDelivery: 'unknown',
      postDeliveryEmissionTag: null,
      noCollateralQualified: false,
      completionBeforeDeliveryObserved: input.completionBeforeDeliveryObserved === true,
      reason: 'control-not-root-owned',
    });
  }
  if (deliveryBoundTag === null) {
    return withOracleVersion({
      started,
      lastLineIndexAtDelivery: null,
      lastEmissionTagBeforeDelivery: null,
      activityAtDelivery: 'unknown',
      postDelivery: 'unknown',
      postDeliveryEmissionTag: null,
      noCollateralQualified: false,
      completionBeforeDeliveryObserved: input.completionBeforeDeliveryObserved === true,
      reason: 'delivery-bound-unestablished',
    });
  }
  if (!started) {
    return withOracleVersion({
      started,
      lastLineIndexAtDelivery: null,
      lastEmissionTagBeforeDelivery: null,
      activityAtDelivery: 'unknown',
      postDelivery: 'unknown',
      postDeliveryEmissionTag: null,
      noCollateralQualified: false,
      completionBeforeDeliveryObserved: input.completionBeforeDeliveryObserved === true,
      reason: 'control-start-unobserved',
    });
  }
  // EMISSION-time facts only: a line belongs to the pre-delivery activity
  // window exactly when its own tag is at or before the delivery bound.
  let lastLineIndexAtDelivery = null;
  let lastEmissionTagBeforeDelivery = null;
  for (const line of lines) {
    if (line.tag <= deliveryBoundTag) {
      lastLineIndexAtDelivery = line.index;
      lastEmissionTagBeforeDelivery = line.tag;
    }
  }
  // Codex review round 14: B bounds LATENESS, never earliness — a tag at or
  // below the bound does NOT prove pre-delivery emission. Completion before
  // delivery requires the INDEPENDENTLY established pre-delivery evidence
  // (the read that returned the completion marker completed before the
  // request); otherwise the completion timing stays unknown.
  const completionBeforeDelivery = completionMarker !== null && completionMarker.tag <= deliveryBoundTag
    && input.completionBeforeDeliveryObserved === true;
  // The §16.4 positive-activity clause requires BOTH the emission-time
  // mid-run proof (a line below the line count at or before the bound) AND
  // the bounded pre-delivery read observed ordered before the interrupt —
  // emission tags alone never substitute for the required read.
  const activityAtDelivery = completionBeforeDelivery
    ? 'completed-before'
    : input.beforeDeliveryReadObserved === true && lastLineIndexAtDelivery !== null && lastLineIndexAtDelivery < input.lineCount ? 'active' : 'unknown';
  const postDeliveryEmissionTag = (() => {
    /** @type {number[]} */
    const candidates = [];
    for (const line of lines) if (line.tag > deliveryBoundTag) candidates.push(line.tag);
    if (completionMarker !== null && completionMarker.tag > deliveryBoundTag) candidates.push(completionMarker.tag);
    return candidates.length > 0 ? Math.min(...candidates) : null;
  })();
  const completionAfterDelivery = completionMarker !== null && completionMarker.tag > deliveryBoundTag;
  const anyLineAfterDelivery = lines.some((line) => line.tag > deliveryBoundTag);
  // The §16.4 requirement is the bounded post-delivery READ itself: emission
  // tags alone cannot establish that the required observation occurred, so a
  // positively established read is part of qualification (codex review
  // round 2). Missing or unexecuted reads keep the layer not-qualified with
  // an explicit reason — never silently unknown, never fabricated.
  // The mandatory post-delivery read is established only by a READABLE
  // attributable result: invocation alone leaves an unanswered or
  // undecodable read indistinguishable from a straddling read's tags
  // (codex review round 5).
  const postDeliveryReadEstablished = postDeliveryRead?.occurred === true && postDeliveryRead?.readable === true;
  // Codex review round 8: 'lost' requires INDEPENDENT loss evidence — the
  // control's own exit observed by the post-delivery read. A readable
  // response without a tag beyond the bound does NOT establish loss (the
  // fixture emits every 2000 ms but reads ask every 1000 ms, so a healthy
  // control can return no new line between emissions, even with a live
  // process handle): the state stays unknown with qualification false.
  // Codex review round 11: an observed PREMATURE exit (before the designed
  // line-30 completion) rejects liveness even when a buffered post-bound
  // line proves brief survival past the bound — the control did not stay
  // alive, and it did not complete naturally: 'lost' with the explicit
  // premature-exit reason.
  // Codex review round 13: an observed ABNORMAL exit (the full designed
  // output but a code other than the designed 0) is a distinct rejection —
  // the final progress line alone never credits natural completion. An
  // observed exit with an unobservable code keeps the fail-closed
  // semantics: lost, never completed, never alive, never qualified.
  const controlExitWasObserved = input.controlExitObserved === true;
  const controlPrematureExit = controlExitWasObserved && input.controlExitPremature === true;
  const controlAbnormalExit = controlExitWasObserved && !controlPrematureExit
    && input.controlExitCode !== null && input.controlExitCode !== undefined
    && input.controlExitCode !== DESIGNED_CONTROL_EXIT_CODE;
  const controlNaturalExit = controlExitWasObserved && !controlPrematureExit && !controlAbnormalExit
    && input.controlExitCode === DESIGNED_CONTROL_EXIT_CODE;
  const postDelivery = controlNaturalExit && completionAfterDelivery
    ? 'completed'
    : controlExitWasObserved ? 'lost'
      : anyLineAfterDelivery ? 'alive'
        : 'unknown';
  const noCollateralQualified = input.ownership === 'root'
    && activityAtDelivery === 'active'
    && (postDelivery === 'alive' || postDelivery === 'completed')
    && postDeliveryReadEstablished;
  const reason = noCollateralQualified
    ? null
    : input.ownership !== 'root' ? 'control-not-root-owned'
      : controlPrematureExit ? 'premature-control-exit'
        : controlAbnormalExit ? 'abnormal-control-exit'
          : activityAtDelivery === 'completed-before' ? 'control-completed-before-delivery'
            : activityAtDelivery === 'unknown' ? 'activity-at-delivery-unobserved'
              : (postDelivery === 'alive' || postDelivery === 'completed') && !postDeliveryReadEstablished ? 'post-delivery-read-not-established'
                : postDelivery === 'lost' ? 'no-post-delivery-emission-after-bound'
                  : 'post-delivery-state-unestablished';
  return withOracleVersion({
    started,
    lastLineIndexAtDelivery,
    lastEmissionTagBeforeDelivery,
    activityAtDelivery,
    postDelivery,
    postDeliveryEmissionTag,
    noCollateralQualified,
    completionBeforeDeliveryObserved: input.completionBeforeDeliveryObserved === true,
    reason,
  });
}

/**
 * The three-way settlement layer projection (release-qualification Task 2):
 * remote terminal, local process reaping, and durable obligations are
 * recorded as SEPARATE layers and never collapsed into one another. The
 * settlement BASIS is the remote terminal observation; an unestablishable
 * layer stays 'unestablished' — never silently merged into an observed
 * layer, and a cleanup termination stays distinguishable from a natural
 * exit.
 * @param {{
 *   remoteTerminal: boolean | null,
 *   localProcessReaping: 'natural-exit-observed' | 'cleanup-terminated' | null,
 *   durableObligations: 'settled' | 'unresolved' | null,
 * }} input
 * @returns {{
 *   remoteTerminal: 'observed' | 'unestablished',
 *   localProcessReaping: 'natural-exit-observed' | 'cleanup-terminated' | 'unestablished',
 *   durableObligations: 'observed' | 'unresolved' | 'unestablished',
 *   settlementEstablished: boolean,
 *   releaseQualificationVersion: number,
 * }}
 */
export function evaluateChildSettlementLayers(input) {
  if (!input || typeof input !== 'object') throw invalidQualificationInput('the settlement-layer input must be an object.');
  if (input.remoteTerminal !== true && input.remoteTerminal !== null) {
    throw invalidQualificationInput('the remoteTerminal layer must be true or null (unestablished).');
  }
  if (input.localProcessReaping !== null && input.localProcessReaping !== 'natural-exit-observed' && input.localProcessReaping !== 'cleanup-terminated') {
    throw invalidQualificationInput('the localProcessReaping layer must be "natural-exit-observed", "cleanup-terminated", or null (unestablished).');
  }
  if (input.durableObligations !== null && input.durableObligations !== 'settled' && input.durableObligations !== 'unresolved') {
    throw invalidQualificationInput('the durableObligations layer must be "settled", "unresolved", or null (unestablished).');
  }
  return withOracleVersion({
    remoteTerminal: input.remoteTerminal === true ? 'observed' : 'unestablished',
    localProcessReaping: input.localProcessReaping ?? 'unestablished',
    durableObligations: input.durableObligations === null ? 'unestablished' : input.durableObligations === 'settled' ? 'observed' : 'unresolved',
    settlementEstablished: input.remoteTerminal === true,
  });
}

/**
 * The §16.3/§16.6 Gate-D native-delivery/settlement aggregation over
 * already-adjudicated layer facts. Every mandated rejection fails closed:
 * wrong target, unresolved alias, terminal-before-interrupt, delivery
 * unsent, `previous_status`-only snapshots, unreadable continuations, an
 * unconfirmed pending window, unobserved turn settlement, a still-live
 * unsettled Companion, unresolved/unobserved durable obligations, cleanup
 * kills (never native settlement), an unadjudicated or lost collateral
 * control — and the production terminal winner/error semantics pass through
 * untouched: a natural completion racing cancellation is never rewritten to
 * `cancelled`, and a status observation-only timeout never counts as
 * stopping the unrelated control.
 * @param {{
 *   delivery: {
 *     delivered: boolean | null,
 *     exactTargetMatch: boolean | null,
 *     aliasResolved: boolean | null,
 *     terminalBeforeInterrupt: boolean | null,
 *     deliverySent: boolean | null,
 *     previousStatusOnly: boolean,
 *     unreadableContinuation: boolean,
 *     pendingWindowConfirmed: boolean | null,
 *   },
 *   turnSettled: boolean | null,
 *   companionOutcome: 'ceased' | 'terminal-result' | 'survived-unsettled' | null,
 *   durableObligations: 'settled' | 'unresolved' | null,
 *   cleanupKill: boolean,
 *   survivalControl: ReturnType<typeof evaluateSurvivalControl> | null,
 *   terminalWinner: 'succeeded' | 'failed' | 'cancelled' | null,
 *   naturalCompletionObserved: boolean,
 *   statusObservationTimeoutOnly: boolean,
 * }} input
 * @returns {{
 *   qualified: boolean,
 *   reasons: string[],
 *   layers: { delivery: boolean, turnSettlement: boolean, companion: boolean, durableObligations: boolean, noCollateral: boolean },
 *   terminalWinner: 'succeeded' | 'failed' | 'cancelled' | null,
 *   releaseQualificationVersion: number,
 * }}
 */
export function evaluateNativeInterruptionSettlement(input) {
  if (!input || typeof input !== 'object') throw invalidQualificationInput('the settlement input must be an object.');
  if (!input.delivery || typeof input.delivery !== 'object') throw invalidQualificationInput('the delivery facts must be an object.');
  /** @type {string[]} */
  const reasons = [];
  const delivery = input.delivery;
  if (delivery.delivered !== true) reasons.push('delivery-not-established');
  // Strict conjuncts (codex review round 4): actual dispatch and nonterminal
  // targeting must be POSITIVELY established — an unknown state is not a
  // pass, and each unestablished fact carries its own reason.
  if (delivery.deliverySent === false) reasons.push('delivery-unsent');
  if (delivery.deliverySent !== true && delivery.deliverySent !== false) reasons.push('delivery-dispatch-unestablished');
  if (delivery.aliasResolved !== true) reasons.push('alias-unresolved');
  if (delivery.terminalBeforeInterrupt === true) reasons.push('terminal-before-interrupt');
  if (delivery.terminalBeforeInterrupt !== true && delivery.terminalBeforeInterrupt !== false) reasons.push('terminal-state-unestablished');
  if (delivery.previousStatusOnly === true) reasons.push('previous-status-snapshot-only');
  if (delivery.unreadableContinuation === true) reasons.push('unreadable-continuation');
  if (delivery.pendingWindowConfirmed !== true) reasons.push('pending-window-unconfirmed');
  if (delivery.exactTargetMatch !== true) reasons.push('delivery-target-unmatched');
  const turnSettled = input.turnSettled === true;
  if (!turnSettled) reasons.push('turn-settlement-unobserved');
  const companionSettled = input.companionOutcome === 'ceased' || input.companionOutcome === 'terminal-result';
  if (input.companionOutcome === 'survived-unsettled') reasons.push('companion-still-live-unsettled');
  else if (!companionSettled) reasons.push('companion-outcome-unobserved');
  const durableSettled = input.durableObligations === 'settled';
  if (input.durableObligations === 'unresolved') reasons.push('durable-obligations-unresolved');
  else if (!durableSettled) reasons.push('durable-obligations-unobserved');
  if (input.cleanupKill === true) reasons.push('cleanup-termination-is-not-native-settlement');
  // The §16.4 survival layer. A status observation-only timeout NEVER stops
  // an unrelated job: a control whose only loss evidence is such a timeout
  // is not positively lost — the loss basis is invalid and the layer fails
  // closed on the timeout reason alone (the generic collateral reason is
  // NOT duplicated here: the invalid-basis downgrade IS the collateral
  // rejection).
  let survivalControl = input.survivalControl ?? null;
  let survivalLayerRejected = false;
  if (input.statusObservationTimeoutOnly === true && survivalControl?.postDelivery === 'lost') {
    reasons.push('observation-timeout-is-not-control-loss');
    survivalControl = { ...survivalControl, noCollateralQualified: false };
    survivalLayerRejected = true;
  }
  const noCollateral = survivalControl?.noCollateralQualified === true;
  if (survivalControl === null) reasons.push('survival-control-unadjudicated');
  else if (!noCollateral && !survivalLayerRejected) reasons.push('collateral-control-not-qualified');
  // Natural completion racing cancellation keeps the production winner/error
  // semantics: the winner passes through untouched, and an observed natural
  // completion reported as `cancelled` is a misclassification that blocks
  // the settlement instead of being silently accepted.
  if (input.naturalCompletionObserved === true && input.terminalWinner === 'cancelled') {
    reasons.push('natural-completion-misclassified-as-cancelled');
  }
  // Codex review round 7: qualification requires the OBSERVED exact durable
  // terminal outcome (§16.3 stage 6). An unobserved winner (null/missing)
  // never qualifies, with its own explicit reason; OBSERVED winners keep
  // their existing production semantics (the winner value passes through
  // untouched, including the cancelled-winner misclassification block above).
  if (input.terminalWinner !== 'succeeded' && input.terminalWinner !== 'failed' && input.terminalWinner !== 'cancelled') {
    reasons.push('terminal-winner-unobserved');
  }
  return withOracleVersion({
    qualified: reasons.length === 0,
    reasons,
    layers: {
      delivery: reasons.every((reason) => ![
        'delivery-not-established', 'delivery-unsent', 'delivery-dispatch-unestablished', 'alias-unresolved',
        'terminal-before-interrupt', 'terminal-state-unestablished', 'previous-status-snapshot-only',
        'unreadable-continuation', 'pending-window-unconfirmed', 'delivery-target-unmatched',
      ].includes(reason)),
      turnSettlement: turnSettled,
      companion: companionSettled,
      durableObligations: durableSettled,
      noCollateral,
    },
    terminalWinner: input.terminalWinner ?? null,
  });
}
