// @ts-check
/**
 * Post-run C0/C1 comparison adjudication (plan Task 4 bullets 3-4; pure,
 * offline, closed-enum). The root feeds the TWO persisted case records — the
 * control arm (`--exec-default-ms 30000`) and the raised arm (240000) — and
 * receives one verdict about the CONFIGURED DEFAULT's observed effect.
 *
 * Contract (every gate fail-closed, in evaluation order):
 *  1. Both records must carry the validated `provenance.waitPolicy` marker
 *     (closed `config-default` literal plus a positive integer exec default)
 *     and an explicit, EQUAL, authorized `requestedModel` — two silent
 *     defaults are never comparable. Absent markers on legacy records are
 *     `no-causal-comparison`, never a positive: legacy structural/terminal
 *     completion is NOT a config-effect gate.
 *  2. The manipulated variable must be a real contrast (equal or reversed
 *     exec defaults cannot compare).
 *  3. Required identity evidence (normalized instruction hashes, observer
 *     digest, codex version, plugin identity+version) must be PRESENT on
 *     both arms — absent-absent identity nulls never match.
 *  4. Executable/version/plugin pins, the inner cap, Root waits, worker
 *     duration, observation budget and the path-normalized instruction
 *     hashes must match across arms; any mismatch is `no-causal-comparison`.
 *  5. The decisive poll's ACTUAL inner window must be verifiable, equal
 *     across arms, and equal to the intended observation window
 *     (`requestedPollMs`): differing inner requests already explain any
 *     contrast, so such a pair is a refusal (`mismatched-inner-yield`).
 *  6. Evidence outside the managed code-mode Child surface (route actual not
 *     named/generic, or unchecked child linkage) is `different-surface`.
 *  7. An explicit pragma on either decisive outer cell (the record's closed
 *     `waitPolicyObservation.decisivePollExplicitYield === 'present'`
 *     marker) makes default-causality `inconclusive`.
 *  8. The decisive call's admitted surface must be a code-mode wrapper on
 *     both arms: a direct native call is `different-surface` (routing
 *     establishes delegation, not code-mode execution); an unestablished
 *     surface is `unknown`.
 *  9. AFFIRMATIVE structural qualification on both arms — the record's own
 *     `inconclusive` verdict absent/null and `linkage.originalHandleChecked`
 *     true. An observation-discipline violation (e.g. a second original-
 *     handle poll while the first cell was pending) is `inconclusive`/
 *     `unqualified-arm`, never a positive effect verdict, whatever the
 *     terminal sentinel booleans read.
 * 10. Missing/null evidence — including the decisive cell's pipeline-derived
 *     FIRST RETURN duration — maps to `unknown`, never zero.
 * 11. Early completion or unknown terminal output, or less than 60000 ms of
 *     conservative headroom at either decisive poll start, stays
 *     `inconclusive` (the short-window contrast cannot be interpreted).
 * 12. Only then, under the timing tolerance (10% of the control default,
 *     1000 ms floor — see the discriminator's basis note): the control
 *     arm's first return at-or-under its default while the raised arm's
 *     holds beyond the whole tolerance band is `config-effect-observed`; a
 *     first return inside the band is `timing-borderline` (inconclusive); a
 *     control return decisively beyond the band, or both arms inside the
 *     short window, is `no-config-effect-observed`.
 */

/** The closed verdict enum. */
export const WAIT_COMPARISON_VERDICTS = Object.freeze([
  'config-effect-observed',
  'no-config-effect-observed',
  'inconclusive',
  'unknown',
  'no-causal-comparison',
  'different-surface',
]);

/**
 * The closed reason enum accompanying every non-null reason (the two effect
 * verdicts and `different-surface` carry `null` — the verdict is the basis).
 */
export const WAIT_COMPARISON_REASONS = Object.freeze([
  'missing-wait-policy-marker',
  'identical-exec-default',
  'reversed-exec-default-order',
  'missing-identity-evidence',
  'missing-or-invalid-model-selection',
  'mismatched-model-selection',
  'mismatched-pin',
  'mismatched-instruction-variant',
  'mismatched-inner-yield',
  'mismatched-route',
  'explicit-pragma',
  'unqualified-arm',
  'missing-evidence',
  'early-or-unknown-terminal',
  'insufficient-headroom',
  'timing-borderline',
  'control-returned-early',
  'control-completed-without-yield',
]);

// Spec Q3's interpretability bound: the decisive poll must START with at
// least this much conservative hold lifetime remaining, or the short-window
// contrast cannot be interpreted.
const MIN_INTERPRETABILITY_HEADROOM_MS = 60_000;

/**
 * The validated wait-policy provenance block, or null when the record does
 * not carry the closed marker (legacy records, wrong literal, or a missing
 * exec-default number).
 * @param {unknown} record
 */
function waitPolicyBlock(record) {
  const block = /** @type {any} */ (record)?.provenance?.waitPolicy;
  if (!block || typeof block !== 'object' || block.policy !== 'config-default') return null;
  if (!Number.isSafeInteger(block.execDefaultMs) || block.execDefaultMs <= 0) return null;
  return block;
}

/** @param {unknown} value */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The managed code-mode Child surface: an observed named/generic Rescue route
 * plus checked child linkage. Anything else is a different surface.
 * @param {unknown} record
 */
function surfaceEstablished(record) {
  const routeActual = /** @type {any} */ (record)?.route?.actual;
  return (routeActual === 'named' || routeActual === 'generic')
    && /** @type {any} */ (record)?.linkage?.childLinkageChecked === true;
}

/**
 * The required identity evidence: PRESENCE on an arm before any equality
 * comparison (codex gate round 1, finding 4). Identity facts — normalized
 * instruction hashes, executing-observer digest, codex version, plugin
 * identity and version — describe WHICH instrument produced the record, so
 * an absent value can never match an absent value as equal. Explicitly
 * nullable fields (the unraised cap) stay out of this gate.
 * @param {unknown} record
 */
function requiredIdentityPresent(record) {
  const provenance = /** @type {any} */ (record)?.provenance;
  if (typeof provenance?.codexVersion !== 'string' || provenance.codexVersion.length === 0) return false;
  if (typeof provenance?.plugin?.identity !== 'string' || provenance.plugin.identity.length === 0) return false;
  if (typeof provenance?.plugin?.version !== 'string' || provenance.plugin.version.length === 0) return false;
  if (typeof provenance?.observer?.digest !== 'string' || provenance.observer.digest.length === 0) return false;
  // The launched NATIVE EXECUTABLE's digest (codex gate round 5): the
  // driver's `--version`-derived codexVersion cannot distinguish different
  // same-version binaries, so the SHA-256 the record pins at run time is
  // required identity evidence.
  if (typeof provenance?.codexBinarySha256 !== 'string' || provenance.codexBinarySha256.length === 0) return false;
  const instructions = provenance?.waitPolicy?.instructions;
  if (typeof instructions?.normalizedNamedRoleSha256 !== 'string' || instructions.normalizedNamedRoleSha256.length === 0) return false;
  if (typeof instructions?.normalizedGenericMessageSha256 !== 'string' || instructions.normalizedGenericMessageSha256.length === 0) return false;
  return true;
}

/**
 * The comparable pin projection: executable source, host version, plugin
 * version, inner cap, Root waits, worker duration, observation budget, the
 * executing-observer DIGEST, and the launched NATIVE EXECUTABLE's SHA-256
 * (the whole instrument context must match across arms — a differing
 * same-version binary is as disqualifying as a differing observer
 * revision). Rendered instruction hashes are deliberately NOT
 * pins (they differ cross-run); the path-normalized hashes are compared
 * separately. Presence of the identity facts is enforced separately by
 * {@link requiredIdentityPresent}.
 * @param {unknown} record
 */
function pinProjection(record) {
  const provenance = /** @type {any} */ (record)?.provenance ?? {};
  return JSON.stringify([
    provenance.sourceSha ?? null,
    provenance.codexVersion ?? null,
    provenance.plugin?.version ?? null,
    provenance.requestedCapMs ?? null,
    provenance.requestedPollMs ?? null,
    provenance.requestedWorkerDurationMs ?? null,
    provenance.requestedBudgetMs ?? null,
    provenance.observer?.digest ?? null,
    provenance.codexBinarySha256 ?? null,
  ]);
}

/**
 * The path-normalized instruction projection for one record's waitPolicy
 * block (absent projections project as nulls, never as matches).
 * @param {unknown} record
 */
function instructionProjection(record) {
  const instructions = /** @type {any} */ (record)?.provenance?.waitPolicy?.instructions ?? null;
  return JSON.stringify([
    instructions?.normalizedNamedRoleSha256 ?? null,
    instructions?.normalizedGenericMessageSha256 ?? null,
  ]);
}

/**
 * The decisive outer cell's explicit pragma/yield marker for one arm, or null
 * when the record carries no observation block at all.
 * @param {unknown} record
 */
function decisivePollExplicitYield(record) {
  return /** @type {any} */ (record)?.waitPolicyObservation?.decisivePollExplicitYield ?? null;
}

/**
 * The decisive outer cell's measured FIRST RETURN (codex gate round 1,
 * finding 2): the pipeline-derived event-timestamp duration carried by the
 * record's `waitPolicyObservation.decisiveFirstReturnWallMs`, measured for
 * pending yields exactly like completed observations. Null (unknown) unless
 * the record retains a finite value — a yielded poll's inner wall-time array
 * entry is null by design and is deliberately NOT read. Never zero.
 * @param {unknown} record
 */
function decisiveFirstReturnWallMs(record) {
  const value = /** @type {any} */ (record)?.waitPolicyObservation?.decisiveFirstReturnWallMs;
  return isFiniteNumber(value) ? value : null;
}

/** @param {unknown} record */
function remainingLifetimeMs(record) {
  const value = /** @type {any} */ (record)?.observations?.remainingLifetimeMs;
  return isFiniteNumber(value) ? value : null;
}

/** @param {unknown} record */
function outerReturns(record) {
  const value = /** @type {any} */ (record)?.observations?.outerReturns;
  return isFiniteNumber(value) ? value : null;
}

/**
 * Terminal completion is an INTERPRETABILITY gate only — never a positive
 * config-effect basis by itself (the legacy-success rule).
 * @param {unknown} record
 */
function terminalProven(record) {
  return /** @type {any} */ (record)?.result?.publicResultMatchedSentinel === true
    && /** @type {any} */ (record)?.result?.terminalStdoutChecked === true;
}

/**
 * Adjudicate one C0/C1 pair. Pure: reads the two persisted records, throws
 * nothing, and returns a closed `{ verdict, reason }` — `reason` is null only
 * for the two effect verdicts and `different-surface`.
 * @param {unknown} control the shorter-default arm's persisted case record
 * @param {unknown} raised the longer-default arm's persisted case record
 * @returns {{ verdict: (typeof WAIT_COMPARISON_VERDICTS)[number], reason: (typeof WAIT_COMPARISON_REASONS)[number] | null }}
 */
/** @param {unknown} record */
function decisiveCallSurface(record) {
  return /** @type {any} */ (record)?.waitPolicyObservation?.decisiveCallSurface ?? null;
}

/**
 * The decisive first return's observed STATE (codex gate round 6): whether
 * the control/raised cell yielded pending or completed — the plan's
 * discriminator requires a yielded-pending CONTROL cell.
 * @param {unknown} record
 */
function decisiveFirstReturnState(record) {
  return /** @type {any} */ (record)?.waitPolicyObservation?.decisiveFirstReturnState ?? null;
}

/**
 * The decisive poll's ACTUAL requested inner window (finding 2), or null
 * when the admitted arguments carry none (never assumed equal).
 * @param {unknown} record
 */
function decisiveInnerYieldMs(record) {
  const value = /** @type {any} */ (record)?.waitPolicyObservation?.decisiveInnerYieldMs;
  return isFiniteNumber(value) ? value : null;
}

/**
 * AFFIRMATIVE structural qualification (finding 1): the arm's own observer
 * verdict must be clean and its original-handle check must have passed. An
 * inconclusive reason (e.g. an unqualified completion) or a failed/unknown
 * handle check (e.g. a second original-handle poll issued while the first
 * cell was pending) is a protocol violation — never positive causal
 * evidence, however clean the terminal sentinel booleans read.
 * @param {unknown} record
 */
function structurallyQualified(record) {
  const inconclusive = /** @type {any} */ (record)?.inconclusive;
  if (inconclusive !== null && inconclusive !== undefined) return false;
  return /** @type {any} */ (record)?.linkage?.originalHandleChecked === true;
}

/**
 * Adjudicate one C0/C1 pair. Pure: reads the two persisted records, throws
 * nothing, and returns a closed `{ verdict, reason }` — `reason` is null only
 * for the two effect verdicts and `different-surface`.
 * @param {unknown} control the shorter-default arm's persisted case record
 * @param {unknown} raised the longer-default arm's persisted case record
 * @returns {{ verdict: (typeof WAIT_COMPARISON_VERDICTS)[number], reason: (typeof WAIT_COMPARISON_REASONS)[number] | null }}
 */
export function adjudicateWaitComparison(control, raised) {
  const controlPolicy = waitPolicyBlock(control);
  const raisedPolicy = waitPolicyBlock(raised);
  if (controlPolicy === null || raisedPolicy === null) return { verdict: 'no-causal-comparison', reason: 'missing-wait-policy-marker' };
  if (controlPolicy.execDefaultMs === raisedPolicy.execDefaultMs) return { verdict: 'no-causal-comparison', reason: 'identical-exec-default' };
  if (controlPolicy.execDefaultMs > raisedPolicy.execDefaultMs) return { verdict: 'no-causal-comparison', reason: 'reversed-exec-default-order' };
  // Identity evidence must be PRESENT on both arms before any equality
  // comparison: absent-absent identity nulls never match (finding 4).
  if (!requiredIdentityPresent(control) || !requiredIdentityPresent(raised)) return { verdict: 'no-causal-comparison', reason: 'missing-identity-evidence' };
  const controlModel = /** @type {any} */ (control)?.provenance?.requestedModel ?? null;
  const raisedModel = /** @type {any} */ (raised)?.provenance?.requestedModel ?? null;
  if (typeof controlModel !== 'string' || controlModel.length === 0 || typeof raisedModel !== 'string' || raisedModel.length === 0) {
    return { verdict: 'no-causal-comparison', reason: 'missing-or-invalid-model-selection' };
  }
  if (controlModel !== raisedModel) return { verdict: 'no-causal-comparison', reason: 'mismatched-model-selection' };
  if (pinProjection(control) !== pinProjection(raised)) return { verdict: 'no-causal-comparison', reason: 'mismatched-pin' };
  if (instructionProjection(control) !== instructionProjection(raised)) return { verdict: 'no-causal-comparison', reason: 'mismatched-instruction-variant' };
  // The decisive poll's ACTUAL inner window must be verifiable, equal across
  // arms, and equal to the intended observation window (finding 2): differing
  // inner requests already explain any contrast, so such a pair is a
  // refusal before any causal adjudication. The gate applies when BOTH arms
  // carry the comparison-facts block; an absent block is the missing-evidence
  // family, caught with the other decisive facts below.
  const bothObservationsPresent = /** @type {any} */ (control)?.waitPolicyObservation != null
    && /** @type {any} */ (raised)?.waitPolicyObservation != null;
  const controlInnerYieldMs = decisiveInnerYieldMs(control);
  const raisedInnerYieldMs = decisiveInnerYieldMs(raised);
  const intendedWindowMs = /** @type {any} */ (control)?.provenance?.requestedPollMs ?? null;
  if (bothObservationsPresent
    && (controlInnerYieldMs === null || raisedInnerYieldMs === null
      || controlInnerYieldMs !== raisedInnerYieldMs || controlInnerYieldMs !== intendedWindowMs)) {
    return { verdict: 'no-causal-comparison', reason: 'mismatched-inner-yield' };
  }
  // The planned arms are rescue-foreground → NAMED (finding 2): differing or
  // non-named actual routes mean the Role/instruction-delivery path changed
  // alongside the configured default — instruction-hash equality does not
  // prove the same variant was USED — so the pair refuses before any causal
  // adjudication.
  /** @param {unknown} record */
  const actualRoute = (record) => /** @type {any} */ (record)?.route?.actual;
  if (actualRoute(control) !== 'named' || actualRoute(raised) !== 'named') return { verdict: 'no-causal-comparison', reason: 'mismatched-route' };
  if (!surfaceEstablished(control) || !surfaceEstablished(raised)) return { verdict: 'different-surface', reason: null };
  if (decisivePollExplicitYield(control) === 'present' || decisivePollExplicitYield(raised) === 'present') {
    return { verdict: 'inconclusive', reason: 'explicit-pragma' };
  }
  // The decisive call's admitted SURFACE (finding 3): routing and checked
  // linkage establish delegation, not code-mode execution. A direct native
  // decisive call is a different surface; an unestablished surface is
  // missing evidence, never code mode.
  if (decisiveCallSurface(control) === 'direct-native' || decisiveCallSurface(raised) === 'direct-native') {
    return { verdict: 'different-surface', reason: null };
  }
  // AFFIRMATIVE structural qualification on BOTH arms (finding 1) before any
  // effect verdict: an inconclusive observer verdict or a failed original-
  // handle check is a protocol violation, never causal evidence.
  if (!structurallyQualified(control) || !structurallyQualified(raised)) return { verdict: 'inconclusive', reason: 'unqualified-arm' };
  if (decisivePollExplicitYield(control) !== 'absent' || decisivePollExplicitYield(raised) !== 'absent'
    || decisiveCallSurface(control) !== 'code-mode-wrapper' || decisiveCallSurface(raised) !== 'code-mode-wrapper'
    || decisiveFirstReturnWallMs(control) === null || decisiveFirstReturnWallMs(raised) === null
    || decisiveFirstReturnState(control) === null || decisiveFirstReturnState(control) === 'unknown'
    || decisiveFirstReturnState(raised) === null || decisiveFirstReturnState(raised) === 'unknown'
    || remainingLifetimeMs(control) === null || remainingLifetimeMs(raised) === null
    || outerReturns(control) === null || outerReturns(raised) === null
    // A yielded-pending control whose continuation was never verified cannot
    // attribute its return: the sanctioned wait linkage is part of the
    // observation, not an optional extra.
    || (decisiveFirstReturnState(control) === 'yielded-pending' && /** @type {number} */ (outerReturns(control)) < 1)) {
    return { verdict: 'unknown', reason: 'missing-evidence' };
  }
  if (!terminalProven(control) || !terminalProven(raised)) return { verdict: 'inconclusive', reason: 'early-or-unknown-terminal' };
  if (remainingLifetimeMs(control) < MIN_INTERPRETABILITY_HEADROOM_MS || remainingLifetimeMs(raised) < MIN_INTERPRETABILITY_HEADROOM_MS) {
    return { verdict: 'inconclusive', reason: 'insufficient-headroom' };
  }
  // The plan's expected discriminator is PENDING versus holding (codex gate
  // round 6): the CONTROL cell must be OBSERVED as yielded-pending WITH the
  // verified sanctioned continuation (outerReturns counts the wait calls in
  // the identified rollout; an unlinked continuation already fails
  // qualification upstream). A COMPLETED control cell is an inner or
  // transport return masquerading as default expiry — eventual terminal
  // success does not establish the causal link — so it stays inconclusive,
  // never a positive config effect.
  if (decisiveFirstReturnState(control) === 'completed') {
    return { verdict: 'inconclusive', reason: 'control-completed-without-yield' };
  }
  // The discriminator with the timing tolerance (finding 3): the first
  // return is measured between two rollout records, so it carries
  // scheduling/transport/append overhead on top of the configured timeout.
  // TOLERANCE BASIS: 10% of the control default with a 1000 ms floor — the
  // campaign's own measured overheads (D0: observation detected at 32436 ms
  // against a 30000 ms requested yield; ≤74 ms poll-vs-deadline arithmetic)
  // bound the real rollout-append and dispatch overhead well under 10%, 10%
  // stays an order of magnitude below the intended C1 separation
  // (240000 vs 30000), and the floor covers fixed transport costs for tiny
  // configured defaults. A first return INSIDE the band
  // (controlDefault, controlDefault + tolerance] cannot be distinguished
  // from overhead and is `timing-borderline` — inconclusive, never a
  // verdict.
  const controlDefaultMs = controlPolicy.execDefaultMs;
  const toleranceMs = Math.max(1000, Math.ceil(controlDefaultMs * 0.1));
  const bandMs = controlDefaultMs + toleranceMs;
  // The CONTROL band is TWO-SIDED (finding 3 of round 2 / round 3 finding 1):
  // default expiry means |firstReturn − controlDefault| ≤ tolerance. A first
  // return MATERIALLY BELOW the band is an ALTERNATIVE ENDER — explicit
  // yield/preemption, injected input, transport/resource limits, or real
  // completion (plan Task 4 bullet 6) — and the closed fact set does not
  // identify WHICH of them fired: the verdict stays inconclusive either way,
  // never a positive config effect. The same alternative-ender rule applies
  // to a raised arm returning below the SHORT window's band (a raised cell
  // that ended before even the control default's window cannot support a
  // "held" claim).
  const lowerBandMs = controlDefaultMs - toleranceMs;
  const controlReturnMs = /** @type {number} */ (decisiveFirstReturnWallMs(control));
  const raisedReturnMs = /** @type {number} */ (decisiveFirstReturnWallMs(raised));
  if (controlReturnMs < lowerBandMs || raisedReturnMs < lowerBandMs) return { verdict: 'inconclusive', reason: 'control-returned-early' };
  if (controlReturnMs > bandMs) return { verdict: 'no-config-effect-observed', reason: null };
  if (controlReturnMs > controlDefaultMs) return { verdict: 'inconclusive', reason: 'timing-borderline' };
  if (raisedReturnMs > bandMs) return { verdict: 'config-effect-observed', reason: null };
  if (raisedReturnMs > controlDefaultMs) return { verdict: 'inconclusive', reason: 'timing-borderline' };
  return { verdict: 'no-config-effect-observed', reason: null };
}
