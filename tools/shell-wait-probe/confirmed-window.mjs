// @ts-check
/**
 * The confirmed-window staged controller (report §40.2, the confirmed-window
 * plan Task 2 preregistration): research session/controller lifecycle ONLY —
 * bounded staging, an observed live target, the positive admission barrier,
 * exactly ONE native delivery and deterministic resource disposal. The frozen
 * §39.9 choreography is implemented verbatim; every gate failure persists its
 * named state and stops escalation; the controller never substitutes,
 * re-parents or terminates the host's Child, and never manufactures
 * settlement.
 *
 * Importing this module launches nothing: the ONE owned host instance is
 * launched inside {@link runConfirmedWindowChoreography} through the
 * injectable `launchConfirmedWindowHost` dependency (the default real
 * launcher composes {@link composeConfirmedWindowHostArguments} against the
 * fixture home; offline tests inject deterministic fake protocol streams).
 * All observers are injected and consume the EXISTING collectors' premises —
 * this module never runs a second, divergent runtime interpretation.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { admitConfirmedWindowNativeEvidence, projectConfirmedWindowBlock, projectConfirmedWindowDutyAdjudication } from './native-control-evidence.mjs';

// The module-INIT snapshot of the EXECUTING controller source (plan §3, the
// observer-provenance duty): the driver's v10 construction binds these bytes
// so the choreography that actually runs is exactly the provenance that
// attributes the record.
export const EXECUTING_CONFIRMED_WINDOW_SOURCE = readFileSync(fileURLToPath(import.meta.url));

/** The controller contract version (§40.2): registered prospectively. */
export const CONFIRMED_WINDOW_CONTROLLER_VERSION = 1;

/**
 * The frozen §39.9 five-state machine, in escalation order. Any gate failure
 * persists its named state and STOPS escalation.
 */
export const CONFIRMED_WINDOW_STATES = Object.freeze([
  'staging-not-ready',
  'pending-window-confirmed',
  'native-request-sent',
  'native-resolution-observed',
  'all-duties-adjudicated',
]);

/** The §39.9 step 6 staging readiness bound, measured from ACTUAL host launch. */
export const CONFIRMED_WINDOW_STAGING_READY_BOUND_MS = 180_000;

/** The Task-3 common case deadline ceiling; the case runs under `min(budgetMs, this)`. */
export const CONFIRMED_WINDOW_CASE_DEADLINE_MS = 1_200_000;

/** The §16.5/§24.8 native responsiveness comparison bound (causal admission only). */
export const CONFIRMED_WINDOW_NATIVE_RESPONSE_BOUND_MS = 60_000;

/** The Task-3 per-case Root input ceiling (initial staging, one continuation, one post-interrupt request). */
export const CONFIRMED_WINDOW_MAX_ROOT_INPUTS = 3;

/**
 * Passive durable reads are never faster than this cadence (§39.9's inherited
 * rule; the same numeric anchor the durable-sampling registration carries).
 * The choreography's own barrier re-evaluations are rate-limited to this
 * floor on the injected monotonic clock.
 */
export const CONFIRMED_WINDOW_PASSIVE_READ_FLOOR_MS = 1_000;

/** The §24.8 anchors carried verbatim: cutoff after the hold deadline, teardown after the cutoff. */
export const CONFIRMED_WINDOW_MEASUREMENT_CUTOFF_AFTER_HOLD_MS = 10_000;
export const CONFIRMED_WINDOW_OBSERVATION_TEARDOWN_AFTER_CUTOFF_MS = 5_000;

/** The bounded error text any record may carry (bytes, redacted upstream). */
const MAX_ERROR_TEXT_CHARS = 512;
/** Bounded identity stamps (the production protocol limits, mirrored read-only). */
const MAX_THREAD_ID_BYTES = 512;
/**
 * The unmatched Child turn/started buffer's named cap (mirrors MAX_WRONG_JOINS
 * in native-control-evidence.mjs): every controller-side accumulation is
 * bounded — the buffer holds the MOST RECENT unmatched starts and any
 * eviction is named in the projected block, never silent.
 */
const MAX_UNMATCHED_CHILD_TURN_STARTS = 16;

/** @param {string} message @returns {TypeError} */
function invalidControllerInput(message) {
  return new TypeError(`Invalid confirmed-window controller input: ${message}`);
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
 * A bounded monotonic/wall stamp: any FINITE non-negative number. The
 * fractional `performance.now()` values the default clocks produce are real
 * stamps — requiring safe integers here (the pre-review gate) silently nulled
 * every real stamp and misclassified a successfully sent interrupt as
 * `unsent-request` (P1-4, 2026-11-18 codex gate round); the integer-only
 * fake clocks concealed the failure. Values beyond the safe-integer range
 * are still refused (a stamp must stay exactly comparable).
 * @param {unknown} value
 */
function safeStamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : null;
}

/** @param {unknown} text @returns {string} bounded error text */
function boundedErrorText(text) {
  const raw = text instanceof Error ? text.message : String(text);
  return raw.length > MAX_ERROR_TEXT_CHARS ? `${raw.slice(0, MAX_ERROR_TEXT_CHARS)}<truncated>` : raw;
}

/** @param {string} value */
function sha256Digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The ONE owned host's research argv (§39.7): the app-server transport with
 * the SAME config-transport keys the exec composition registers, expressed
 * through the app-server's own `-c`/`--enable` surface. PURE: no process is
 * launched and no file is read; the composition is offline-testable and is
 * exactly what the default real launcher executes. The fixture carries the
 * isolated home (env) and the cap key; the workspace rides the spawn cwd and
 * the `thread/start` parameters.
 * @param {{ workspace?: string, codexHome?: string, env?: Record<string, string | undefined> }} fixture
 * @param {{ execDefaultMs?: number | null, model?: string | null }} input
 * @returns {string[]}
 */
export function composeConfirmedWindowHostArguments(fixture, input = {}) {
  if (!fixture || typeof fixture !== 'object') throw invalidControllerInput('the fixture handle is required for the host composition.');
  if (typeof fixture.workspace !== 'string' || fixture.workspace.length === 0) throw invalidControllerInput('the fixture workspace must be a non-empty string.');
  if (typeof fixture.codexHome !== 'string' || fixture.codexHome.length === 0) throw invalidControllerInput('the fixture codexHome must be a non-empty string.');
  if (input.execDefaultMs !== null && input.execDefaultMs !== undefined
    && (!Number.isSafeInteger(input.execDefaultMs) || input.execDefaultMs <= 0 || input.execDefaultMs > 3_600_000)) {
    throw invalidControllerInput('the exec default override must be a positive integer number of milliseconds no greater than 3600000.');
  }
  if (input.model !== null && input.model !== undefined
    && (typeof input.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/u.test(input.model))) {
    throw invalidControllerInput('the requested model must be a bounded safe identifier.');
  }
  return [
    'app-server',
    // The SUPPORTED transport URL (verified against the pinned 0.163.0
    // binary on 2026-11-18: `--listen` takes a URL — `stdio://` (default),
    // `unix://`, `unix://PATH`, `ws://IP:PORT`, `off` — and the bare `stdio`
    // spelling the pre-review composition carried is rejected during
    // argument parsing ("unsupported --listen URL `stdio`"), so the real
    // host exited BEFORE initialization and the case could never start.
    // The §40.7 dated correction records this post-freeze fix.
    '--listen', 'stdio://',
    '--enable', 'hooks',
    '-c', 'shell_environment_policy.inherit=all',
    ...(input.execDefaultMs !== null && input.execDefaultMs !== undefined
      ? ['-c', `features.code_mode.default_exec_yield_time_ms=${String(input.execDefaultMs)}`]
      : []),
  ];
}

// The bounded whitelisted projection (§40.2's `projectConfirmedWindowSession`)
// is the CANONICAL pure projector of native-control-evidence.mjs — a single
// shared implementation, never a second divergent interpretation (plan §3).
export { projectConfirmedWindowBlock as projectConfirmedWindowSession } from './native-control-evidence.mjs';

/**
 * The staged §39.9 choreography. ALL dependencies are injectable so the
 * whole lifecycle is deterministic offline; the default (no injected host
 * launcher / observers) refuses fail-closed rather than inventing one.
 * @param {any} session the validated route session (case input + fixture + composed prompts)
 * @param {{ now?: () => number, wallClockNow?: () => number, sleep?: (ms: number) => Promise<void>, waitUntil?: (targetAbsMs: number) => Promise<void>, launchConfirmedWindowHost?: (launch: any) => Promise<any>, observers?: any, dutyAdjudication?: any, redact?: (error: unknown) => string }} [dependencies]
 */
export async function runConfirmedWindowChoreography(session, dependencies = {}) {
  if (!session || typeof session !== 'object') throw invalidControllerInput('the session input is required.');
  if (session.case !== 'rescue-interrupt') throw invalidControllerInput('the confirmed-window route is registered for the rescue-interrupt case only.');
  if (typeof session.stagingPrompt !== 'string' || session.stagingPrompt.length === 0) throw invalidControllerInput('the composed staging prompt is required (the §16.4 control directive rides the SAME turn).');
  if (session.continuationPrompt !== undefined && (typeof session.continuationPrompt !== 'string' || session.continuationPrompt.length === 0)) throw invalidControllerInput('the continuation prompt must be a non-empty CHANGED prompt when present.');
  if (!session.fixture || typeof session.fixture !== 'object') throw invalidControllerInput('the fixture handle is required.');
  // The default monotonic clock is NORMALIZED to integer milliseconds so the
  // controller's own stamps and the wall clock agree on granularity (P1-4):
  // fractional `performance.now()` values are still accepted wherever a
  // stamp is consumed (safeStamp admits any finite non-negative number), so
  // an injected fractional clock can never silently null real evidence.
  const now = dependencies.now ?? (() => Math.floor(performance.now()));
  const wallClockNow = dependencies.wallClockNow ?? Date.now;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // (round-2 P1) a PURE deadline SIGNAL for the observer bounding below: it
  // resolves when the caller's clock reaches the target and NEVER advances
  // the shared clock. The default is a REAL unref'd timer whose delay is
  // computed from the injected clock — offline virtual clocks therefore get
  // a signal that fires after the virtual remaining time in real
  // milliseconds (a never-resolving collector is bounded by the case
  // deadline), and a fast collector always wins the race. An injected
  // waitUntil must be a pure signal, never the notification-scheduling wait
  // that advances a fake clock.
  const waitUntil = dependencies.waitUntil ?? ((targetAbsMs) => new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, targetAbsMs - now()));
    timer.unref?.();
  }));
  void wallClockNow;
  const launchHost = dependencies.launchConfirmedWindowHost ?? null;
  const redact = dependencies.redact ?? ((error) => boundedErrorText(error));
  const observers = dependencies.observers ?? {};
  const dutyAdjudication = dependencies.dutyAdjudication ?? null;
  if (launchHost === null) {
    throw invalidControllerInput('the confirmed-window choreography requires an injected host launcher (the default real launcher composes one); an unlaunched run must never pretend to host contact.');
  }

  /** The runtime session facts; built ONLY from whitelisted-shaped fields (an untyped accumulator — the whitelisted projection is the typed boundary). */
  const facts = /** @type {any} */ ({
    source: 'same-host-rpc',
    host: { pid: null, argvDigest: null, startedAtMs: null, launchCount: 0 },
    rootInputs: [],
    identity: { parentThreadId: null, childThreadId: null, childTurnId: null, joinBasis: null, joinObservedAtMs: null, modelObserved: null, wrongJoins: [], joinHolds: false, childTurnActive: false },
    staging: { startedAtMs: null, descriptorPublicationObserved: null, liveReceiptObserved: null, spawnActivityObserved: null, childTerminalPreAdmission: null, continuationUsed: null },
    window: {},
    nativeRequest: { threadId: null, turnId: null, sentAtMs: null, repliedAtMs: null, outcome: null, errorText: null, attemptCount: 0, responseWithinBound: null },
    receipt: {},
    fences: {},
    disposal: { connectionClosed: null, hostDisposed: null, teardownLabel: null, settlementManufactured: false },
    states: [],
    finalState: null,
    refusal: null,
    inconclusive: null,
  });
  const reach = (/** @type {string} */ state) => {
    facts.states.push({ state, atMs: now() });
  };
  const refuse = (/** @type {string} */ reason) => {
    facts.refusal = { state: facts.finalState, reason };
  };

  const startedAtMs = now();
  const caseDeadlineAtMs = startedAtMs + Math.min(Number(session.budgetMs) || CONFIRMED_WINDOW_CASE_DEADLINE_MS, CONFIRMED_WINDOW_CASE_DEADLINE_MS);
  facts.fences.caseDeadlineAtMs = caseDeadlineAtMs;

  let host = null;
  let connection = /** @type {any} */ (null);
  try {
    // §39.9 step 1: ONE owned host instance, ONE deadline, ONE connection.
    const composedArguments = composeConfirmedWindowHostArguments(session.fixture, session);
    facts.host.argvDigest = sha256Digest(JSON.stringify(composedArguments));
    host = await launchHost({
      codexBinary: session.codexBinary,
      codexHome: session.fixture.codexHome,
      workspace: session.fixture.workspace,
      env: session.fixture.env,
      arguments: composedArguments,
      caseDeadlineAtMs,
      launchedAtMs: startedAtMs,
    });
    facts.host.launchCount += 1;
    facts.host.pid = safeStamp(host?.identity?.pid);
    facts.host.startedAtMs = safeStamp(host?.identity?.startedAtMs) ?? now();
    connection = host.connection;
    if (!connection || typeof connection.request !== 'function' || typeof connection.nextNotification !== 'function') {
      throw new Error('the owned host did not provide the one protocol connection');
    }
    const hostLaunchedAtMs = facts.host.startedAtMs;
    const stagingDeadlineAtMs = hostLaunchedAtMs + CONFIRMED_WINDOW_STAGING_READY_BOUND_MS;
    facts.fences.stagingDeadlineAtMs = stagingDeadlineAtMs;
    facts.staging.startedAtMs = hostLaunchedAtMs;

    // §39.9 step 2: the native parent creates the real Child (initialize →
    // thread/start → turn/start with the composed staging prompt; Root input 1).
    // (round-3 P2-3) the SETUP PHASE is bounded by the staging deadline: each
    // setup request is stopped before it is sent once the allowance expired,
    // and a slow setup reply cannot push further setup work past the bound
    // (the request itself additionally races the remaining staging time; the
    // losing request's cleanup rides the choreography's disposal).
    const SETUP_TIMEOUT = Symbol('confirmed-window-setup-timeout');
    const setupBoundAtMs = Math.min(stagingDeadlineAtMs, caseDeadlineAtMs);
    const boundedSetupRequest = async (/** @type {string} */ method, /** @type {any} */ params) => {
      if (now() >= setupBoundAtMs) {
        throw new Error('the staging readiness bound expired before the setup phase completed (no further protocol work starts past the staging allowance)');
      }
      const guarded = connection.request(method, params);
      guarded.catch(() => { /* the race owns the outcome */ });
      const value = await Promise.race([guarded, waitUntil(setupBoundAtMs).then(() => SETUP_TIMEOUT)]);
      if (value === SETUP_TIMEOUT) {
        throw new Error(`the ${method} setup request exceeded the staging readiness bound`);
      }
      return value;
    };
    const initialize = await boundedSetupRequest('initialize', {
      clientInfo: { name: 'zcode-shell-wait-probe', title: 'shell wait probe confirmed-window controller', version: 'research' },
      capabilities: null,
    });
    void initialize;
    // (P2-1, 2026-11-18 codex gate round) the requested model is applied at
    // the protocol-SUPPORTED per-thread boundary: the pinned 0.163.0
    // `ThreadStartParams` carries `model` (string|null; verified against the
    // binary's generated schema). A requested-but-unapplied model would run
    // the fixture's default model while recording a different selection.
    const threadStart = await boundedSetupRequest('thread/start', {
      cwd: session.fixture.workspace,
      // (round-4 P1) the fixture-only hook-trust bypass rides the SUPPORTED
      // thread-creation config boundary: `ThreadStartParams.config` rides the
      // request overrides and the pinned config manager removes
      // `bypass_hook_trust` into `ConfigOverrides` (config_manager.rs:472-477
      // at the source pin; boolean required), while hooks discovery admits an
      // enabled handler only when `source.bypass_hook_trust || trust_status
      // is Managed|Trusted` (discovery.rs:715-720). With a FRESH isolated
      // fixture home the fixture hooks are untrusted — without this override
      // the real parent's UserPromptSubmit/SubagentStart hooks are filtered
      // out and the managed Rescue preparation/binding flow can never run.
      // The repo's installed-suite precedent carries the same override as the
      // argv `-c bypass_hook_trust=true` (disposable fixture control, never
      // persisted production-trust qualification).
      config: { bypass_hook_trust: true },
      ...(session.model !== null && session.model !== undefined ? { model: session.model } : {}),
    });
    const parentThreadId = boundedThreadId(threadStart?.result?.thread?.id) ?? boundedThreadId(threadStart?.result?.threadId);
    if (parentThreadId === null) throw new Error('the owned host reply carried no bounded parent thread identity');
    facts.identity.parentThreadId = parentThreadId;
    // The pinned protocol's `TurnStartParams` requires exactly
    // `['input', 'threadId']` (`input` an array of `UserInput`; verified
    // against the pinned 0.163.0 binary's generated schema, 2026-11-18) —
    // the pre-review `items` spelling is not a field of the request and the
    // real server rejects it during validation instead of starting the Root
    // turn. The §40.7 dated correction records this post-freeze fix.
    const turnStart = await boundedSetupRequest('turn/start', { threadId: parentThreadId, input: [{ type: 'text', text: session.stagingPrompt }] });
    const parentTurnId = boundedThreadId(turnStart?.result?.turn?.id) ?? boundedThreadId(turnStart?.result?.turnId);
    facts.rootInputs.push({ kind: 'initial-staging', turnId: parentTurnId, sentAtMs: safeStamp(turnStart?.sentAtMs) });
    if (facts.rootInputs.length > CONFIRMED_WINDOW_MAX_ROOT_INPUTS) throw new Error('the Root input ceiling was exceeded');

    /** Barrier conjunct evaluation, rate-limited to the passive read floor. */
    let lastBarrierEvaluationAtMs = -Number.MAX_SAFE_INTEGER;
    // (round-2 P1) ONE observer call BOUNDED by the remaining deadlines: a
    // collector that never resolves cannot hold the choreography past its
    // staging/case deadlines — the timeout yields the typed not-established
    // shape (never a guessed conjunct), and a late collector rejection can
    // never become an unhandled crash. The bound is the EARLIER of the
    // staging and case deadlines.
    const OBSERVER_TIMEOUT = Symbol('confirmed-window-observer-timeout');
    /** @param {any} collector @param {() => any} missingShape @param {string} timeoutReason @param {number} boundAtMs @returns {Promise<any>} */
    const boundedObserver = async (collector, missingShape, timeoutReason, boundAtMs) => {
      if (typeof collector !== 'function') return missingShape();
      const bound = Math.min(boundAtMs, caseDeadlineAtMs);
      const guarded = Promise.resolve().then(collector);
      guarded.catch(() => { /* the race owns the outcome */ });
      const value = await Promise.race([guarded, waitUntil(bound).then(() => OBSERVER_TIMEOUT)]);
      if (value === OBSERVER_TIMEOUT) {
        const shape = missingShape();
        shape.timedOut = true;
        shape.reason = timeoutReason;
        return shape;
      }
      return value;
    };
    // (round-2 P1) the SAME bounding for the collection/horizon instrument
    // reads: a never-resolving collector cannot hold the resolution
    // collection or the disposal past their fences — a timed-out read is
    // simply not-resolved (never guessed).
    /** @param {any} collector @param {number} boundAtMs @returns {Promise<any>} */
    const boundedCollectionRead = async (collector, boundAtMs) => {
      if (typeof collector !== 'function') return null;
      const bound = Math.min(boundAtMs, caseDeadlineAtMs);
      const guarded = Promise.resolve().then(collector);
      guarded.catch(() => { /* the race owns the outcome */ });
      const value = await Promise.race([guarded, waitUntil(bound).then(() => OBSERVER_TIMEOUT)]);
      return value === OBSERVER_TIMEOUT ? null : value;
    };
    const barrier = async (/** @type {boolean} */ force = false) => {
      const stamp = now();
      if (!force && stamp - lastBarrierEvaluationAtMs < CONFIRMED_WINDOW_PASSIVE_READ_FLOOR_MS) return null;
      lastBarrierEvaluationAtMs = stamp;
      const observerBoundAtMs = Math.min(stagingDeadlineAtMs, caseDeadlineAtMs);
      // (round-4 P2) the pending observation is read LAST — immediately
      // before the admission decision — so its snapshot is the FRESHEST
      // evidence the evaluation can have: a slow ancestry/duty/control read
      // can no longer consume the single interrupt attempt outside the
      // observation's pending window (a stale not-resolved snapshot used to
      // admit a delivery after the observation had already ended).
      const ancestry = await boundedObserver(
        observers.ancestryBaseline,
        () => ({ established: false, reason: 'the ancestry-baseline collector is not armed' }),
        'the ancestry-baseline collector did not answer before the remaining deadline',
        observerBoundAtMs,
      );
      const duties = await boundedObserver(
        observers.dutyFacts,
        () => ({ observable: false, reason: 'the duty collector is not armed' }),
        'the duty collector did not answer before the remaining deadline',
        observerBoundAtMs,
      );
      const control = await boundedObserver(
        observers.controlFacts,
        () => ({ active: false, reason: 'the control collector is not armed' }),
        'the control collector did not answer before the remaining deadline',
        observerBoundAtMs,
      );
      const pending = await boundedObserver(
        observers.pendingObservation,
        () => ({ confirmed: false, reason: 'the pending-observation collector is not armed' }),
        'the pending-observation collector did not answer before the remaining deadline',
        observerBoundAtMs,
      );
      // (round-3 P2-2) the freshness/lifetime predicates are evaluated at the
      // POST-COLLECTION time: the pre-read stamp cannot vouch for evidence
      // whose validity expired while the collectors were still answering
      // (a collector that advances the clock past the cadence or the
      // declared lifetime never admits).
      // The pending observation's confirmation is its OWN fact (recorded in
      // the window block at admission) — it never overwrites the L1 live
      // receipt stamp, which only a parent-bound started activity may set
      // (§39.8's witness levels stay distinct).
      const evaluatedAtMs = now();
      return {
        pending, ancestry, duties, control,
        // The barrier's own evaluation instant — the freshness/lifetime
        // arithmetic below (and the named miss reasons) anchor on the
        // POST-COLLECTION time, not the pre-read stamp.
        atMs: evaluatedAtMs,
        // (round-3 P2-1) the operative window requires an observation that is
        // STILL pending: an already-resolved observation is history, never
        // the pending ORIGINAL observation the conjunct requires.
        operativeWindow: safeStamp(pending?.holdDeadlineAtMs) !== null && pending.confirmed === true && pending.resolved !== true,
        // (P2-4, 2026-11-18 codex gate round) the control conjunct carries its
        // REQUIRED evidence: fresh data (no older than the passive-read
        // cadence — the §3 Task-3 schedule constant) AND a declared lifetime
        // that is still sufficient AT REQUEST. An observer returning only
        // `{active: true}` never satisfied the §40.4 admission predicate.
        controlFresh: safeStamp(control?.freshAtMs) !== null
          && evaluatedAtMs - (/** @type {number} */ (safeStamp(control?.freshAtMs))) <= CONFIRMED_WINDOW_PASSIVE_READ_FLOOR_MS,
        controlLifetimeSufficient: safeStamp(control?.freshAtMs) !== null && safeStamp(control?.declaredLifetimeMs) !== null
          && (/** @type {number} */ (safeStamp(control?.freshAtMs))) + (/** @type {number} */ (safeStamp(control?.declaredLifetimeMs))) > evaluatedAtMs,
        // The §39.9 step 6 conjunct order: real Child/turn authority is the
        // join (checked before the barrier runs); the barrier itself requires
        // the pending ORIGINAL observation (confirmed and NOT already
        // resolved), the ancestry baseline, the observable duties, the active
        // control with fresh evidence and a sufficient declared lifetime AND
        // a hold deadline that is present and still in the future (the
        // operative measurement window).
        holds: pending.confirmed === true && pending.resolved !== true && ancestry.established === true && duties.observable === true && control.active === true
          && safeStamp(control?.freshAtMs) !== null
          && evaluatedAtMs - (/** @type {number} */ (safeStamp(control?.freshAtMs))) <= CONFIRMED_WINDOW_PASSIVE_READ_FLOOR_MS
          && safeStamp(control?.declaredLifetimeMs) !== null
          && (/** @type {number} */ (safeStamp(control?.freshAtMs))) + (/** @type {number} */ (safeStamp(control?.declaredLifetimeMs))) > evaluatedAtMs
          && safeStamp(pending?.holdDeadlineAtMs) !== null
          && (/** @type {number} */ (safeStamp(pending?.holdDeadlineAtMs))) > now(),
      };
    };
    const barrierMissReason = (/** @type {any} */ evaluation) => {
      if (!evaluation) return 'the positive barrier was never evaluated';
      if (evaluation.pending.confirmed !== true) return `the pending ORIGINAL observation never confirmed (${boundedErrorText(evaluation.pending.reason ?? 'collector reported unconfirmed')})`;
      if (evaluation.ancestry.established !== true) return `the generation/ancestry baseline never held (${boundedErrorText(evaluation.ancestry.reason ?? 'collector reported unestablished')})`;
      if (evaluation.duties.observable !== true) return `the applicable duties were never observable (${boundedErrorText(evaluation.duties.reason ?? 'collector reported unobservable')})`;
      if (evaluation.control.active !== true) return `the unrelated control was never active with fresh data (${boundedErrorText(evaluation.control.reason ?? 'collector reported inactive')})`;
      if (evaluation.controlFresh !== true) return `the unrelated control had no fresh evidence at admission (freshness within the ${String(CONFIRMED_WINDOW_PASSIVE_READ_FLOOR_MS)} ms passive-read cadence is required; actual ${boundedErrorText(evaluation.control.reason ?? 'no freshness stamp rode the control facts')})`;
      if (evaluation.controlLifetimeSufficient !== true) return `the unrelated control's declared lifetime was absent or exhausted at request (a lifetime covering the admission instant is required)`;
      // (round-3 P2-1) an observation that ALREADY resolved is history — the
      // pending-observation conjunct requires it STILL pending at admission.
      if (evaluation.pending.resolved === true) return 'the original observation had ALREADY resolved when the barrier read it (a historical confirmation is not proof the observation is STILL pending: the delivery is refused before the single interrupt attempt is consumed)';
      return 'the operative measurement window never opened (the observation carried no hold deadline, or its hold deadline had already passed: the cutoff arithmetic is anchored on it)';
    };

    // §39.9 steps 3/4/6: staging observation — the identity join and the
    // positive barrier, bounded by the staging readiness bound.
    let admitted = /** @type {boolean} */ (false);
    let stagingClosed = /** @type {boolean} */ (false);
    let usedContinuation = false;
    let evaluation = null;
    // (F2) Child turn/started events that arrived before their parent's
    // SubAgentActivity: buffered by thread id so the order-free §39.3 join
    // completes whenever the matching side arrives. Each buffered entry also
    // tracks the turn's own completion (P2-3): an unmatched start whose
    // completion arrived before the activity side is TERMINAL — the join
    // completes the identity but never resurrects a stale target.
    /** @type {{ threadId: string, turnId: string | null, turnStartedAtMs: number | null, atMs: number | null, completedAtMs: number | null, terminalStatus: string | null }[]} */
    const unmatchedChildTurnStarts = [];
    while (!admitted && !stagingClosed) {
      const deadline = Math.min(stagingDeadlineAtMs, caseDeadlineAtMs);
      if (now() >= deadline) {
        stagingClosed = true;
        break;
      }
      // (P2-2, 2026-11-18 codex gate round) while the join HOLDS, the wait
      // wakes at the passive-read cadence instead of sleeping until the whole
      // staging deadline: a readiness that arrives after the join (the
      // pending-observation or ancestry artifacts becoming collectable) must
      // be re-evaluated even when the protocol stream stays silent — a
      // notification timeout is NOT exhausted staging.
      const joinHolding = facts.identity.joinHolds === true && facts.identity.joinAmbiguous !== true && facts.identity.childTurnActive === true;
      const wakeAtMs = joinHolding
        ? Math.min(deadline, lastBarrierEvaluationAtMs + CONFIRMED_WINDOW_PASSIVE_READ_FLOOR_MS)
        : deadline;
      const event = await connection.nextNotification(wakeAtMs);
      if (event === null) {
        if (now() >= deadline) {
          stagingClosed = true;
          break;
        }
        // The wake was the floor tick, not the staging deadline: ONE
        // rate-limited barrier re-evaluation, then the wait continues.
        if (joinHolding) {
          evaluation = await barrier();
          if (evaluation?.holds === true) {
            // (round-2 P1) the deadline is RECHECKED after the observers
            // complete and BEFORE admission: a collector that completes after
            // the staging bound (or advances the clock past it) can never
            // cause a delivery.
            if (now() >= deadline) {
              stagingClosed = true;
              break;
            }
            admitted = true;
            break;
          }
        }
        continue;
      }
      const params = event?.params ?? {};
      // The event KIND is read from `params.type` first and falls back to the
      // notification METHOD name (F4): the pinned binary's exact stdio
      // envelope (which of the two carries the discriminant) is a staged
      // verification item inside the counted case (§39.6), so the controller
      // accepts either spelling and records which one it used.
      const type = typeof params.type === 'string' && params.type.length > 0
        ? params.type
        : (typeof event?.method === 'string' ? event.method : '');
      const eventThreadId = boundedThreadId(params.threadId);
      if (type === 'sessionConfigured' || params.descriptor !== undefined) {
        // The setup descriptor publication is the L0 fixture-generation
        // level only — NEVER a live receipt (§39.8).
        facts.staging.descriptorPublicationObserved = true;
      } else if (params.item?.type === 'subAgentActivity' || type === 'SubAgentActivity' || params.item?.type === 'SubAgentActivity') {
        // The pinned protocol serializes the spawn activity as a thread item
        // with the DISCRIMINANT `subAgentActivity` (the
        // SubAgentActivityThreadItemType enum value; verified against the
        // pinned 0.163.0 binary's generated schema and the source pin's
        // event_mapping.rs on 2026-11-18), riding the `item/started`
        // notification `{threadId, turnId, item, startedAtMs}` — and the
        // direct `EventMsg::SubAgentActivity` mapping rides `item/completed`
        // with the SAME item shape. The join therefore reads the ITEM's
        // type/kind and never the carrier method. The `SubAgentActivity`
        // spellings (bare type or item type, the pre-review fake-stream
        // shapes) stay accepted as DOCUMENTED ALIASES so the offline rows
        // and any earlier staged interpretation keep running; the real
        // envelope is matched FIRST. (The §40.7 dated correction records
        // this post-freeze envelope fix.)
        // §39.9 step 3: kind `started` is the join source; the other kinds
        // (interacted/interrupted/completed) are ordinary activity items and
        // never participate in identity or receipt.
        const activityKind = typeof (params.item?.kind ?? params.kind) === 'string' ? (params.item?.kind ?? params.kind) : null;
        if (activityKind !== 'started') {
          continue;
        }
        // (round-2 P2) the parent side of the join requires the EXACT
        // observed parent identity: a missing or malformed threadId is never
        // accepted (null never bypasses the parent match) — a parentless
        // started activity is a named wrong join, never the join side and
        // never spawn evidence.
        if (eventThreadId !== facts.identity.parentThreadId) {
          facts.identity.wrongJoins.push({ kind: eventThreadId === null ? 'unidentified-parent-thread' : 'wrong-parent-thread', atMs: safeStamp(event.receivedAtMs) });
          continue;
        }
        // (round-2 P2, evidence levels) this event is SPAWN evidence — it
        // establishes a Child was spawned through the observed parent — and
        // is recorded as `staging.spawnActivityObserved`. It is NEVER the
        // §39.8 L1 hook-receipt level (a session/turn-bound HOOK invocation
        // inside the real parent): the controller collects no hook witness,
        // so hook receipt stays named-unestablished (null) until an actual
        // hook witness is collected. The round-1 claim that this stamp was
        // "the L1 receipt" is corrected prospectively in §40.7.
        facts.staging.spawnActivityObserved = true;
        const agentThreadId = boundedThreadId(params.item?.agentThreadId) ?? boundedThreadId(params.agentThreadId);
        if (agentThreadId !== null) {
          facts.identity.modelObserved = typeof (params.item?.model ?? params.model) === 'string' ? (params.item?.model ?? params.model) : facts.identity.modelObserved;
          if (facts.identity.childThreadId === null) {
            facts.identity.childThreadId = agentThreadId;
            // (F2, the order-free join) a Child turn/started that arrived
            // BEFORE this activity is buffered — completing the join now
            // with the buffered event's own stamps. The LAST matching
            // NON-TERMINAL buffered entry for the thread is the join
            // candidate (P2-3): a Child may have produced several turns
            // before its activity arrived, and the server's active-turn
            // equality only ever accepts the MOST RECENT STARTED turn — an
            // earlier one is stale, and one whose completion ALREADY arrived
            // is terminal and would burn the counted case by resurrecting a
            // dead target for the interrupt.
            let bufferedIndex = -1;
            for (let index = unmatchedChildTurnStarts.length - 1; index >= 0; index -= 1) {
              if (unmatchedChildTurnStarts[index].threadId === agentThreadId && unmatchedChildTurnStarts[index].completedAtMs === null) {
                bufferedIndex = index;
                break;
              }
            }
            const buffered = bufferedIndex >= 0 ? unmatchedChildTurnStarts[bufferedIndex] : undefined;
            if (buffered !== undefined && facts.identity.childTurnId === null) {
              unmatchedChildTurnStarts.splice(bufferedIndex, 1);
              facts.identity.childTurnId = buffered.turnId;
              facts.identity.joinBasis = 'SubAgentActivity.agentThreadId x turn/started.threadId';
              facts.identity.joinObservedAtMs = buffered.atMs;
              facts.identity.childTurnActive = true;
              facts.identity.joinHolds = true;
              facts.window.childTurnStartedAtMs = buffered.turnStartedAtMs;
            } else if (buffered === undefined && facts.identity.childTurnId === null) {
              // (P2-3) EVERY buffered turn for this Child reached terminal
              // before its activity arrived: the join completes the identity,
              // but the most recent buffered turn is TERMINAL — the stale-id
              // refusal (the Child turn reached terminal before the window
              // was confirmed), never an admission that would deliver
              // against an already-terminal target.
              let terminalIndex = -1;
              for (let index = unmatchedChildTurnStarts.length - 1; index >= 0; index -= 1) {
                if (unmatchedChildTurnStarts[index].threadId === agentThreadId) {
                  terminalIndex = index;
                  break;
                }
              }
              if (terminalIndex >= 0) {
                const terminal = unmatchedChildTurnStarts[terminalIndex];
                unmatchedChildTurnStarts.splice(terminalIndex, 1);
                facts.identity.childTurnId = terminal.turnId;
                facts.identity.joinBasis = 'SubAgentActivity.agentThreadId x turn/started.threadId';
                facts.identity.joinObservedAtMs = terminal.atMs;
                facts.identity.joinHolds = true;
                facts.identity.childTurnActive = false;
                facts.staging.childTerminalPreAdmission = true;
                stagingClosed = true;
                break;
              }
            }
          } else if (facts.identity.childThreadId !== agentThreadId) {
            // Two different started activities name two different Children:
            // the identity is AMBIGUOUS — named-unestablished per §39.9 step
            // 3, never resolvable by picking the first.
            facts.identity.joinAmbiguous = true;
            facts.identity.wrongJoins.push({ kind: 'conflicting-agent-thread-id', atMs: safeStamp(event.receivedAtMs) });
          }
        }
      } else if (type === 'turn/started') {
        const turnId = boundedThreadId(params.turn?.id) ?? boundedThreadId(params.turnId);
        if (eventThreadId !== null && eventThreadId === facts.identity.parentThreadId) {
          continue; // the parent's own staging turn opening
        }
        if (eventThreadId !== null && turnId !== null && eventThreadId === facts.identity.childThreadId) {
          // The JOIN: the Child's own turn/started on the Child stream joins the
          // parent's SubAgentActivity.agentThreadId. thread/started is NEVER
          // required (§39.2/§39.3: a spawned v2 Child emits none).
          if (facts.identity.childTurnId === null && facts.identity.joinAmbiguous !== true) {
            facts.identity.childTurnId = turnId;
            facts.identity.joinBasis = 'SubAgentActivity.agentThreadId x turn/started.threadId';
            facts.identity.joinObservedAtMs = safeStamp(event.receivedAtMs);
            facts.identity.childTurnActive = true;
            facts.identity.joinHolds = true;
            facts.window.childTurnStartedAtMs = safeStamp(event.receivedAtMs);
          }
          } else if (eventThreadId !== null && facts.identity.childThreadId === null) {
          // (F2) No SubAgentActivity side yet: the event is BUFFERED by
          // thread id — when the matching activity arrives the join
          // completes with this event's own stamps. It is never recorded as
          // a wrong join merely for arriving first. The buffer is BOUNDED
          // (the named cap): beyond it the OLDEST unmatched start is evicted
          // — keeping the most recent active-turn candidates — and the
          // eviction is NAMED in the projected block, never silent.
          if (unmatchedChildTurnStarts.length >= MAX_UNMATCHED_CHILD_TURN_STARTS) {
            unmatchedChildTurnStarts.shift();
            facts.identity.unmatchedTurnStartOverflow = true;
          }
          unmatchedChildTurnStarts.push({ threadId: eventThreadId, turnId, turnStartedAtMs: safeStamp(event.receivedAtMs), atMs: safeStamp(event.receivedAtMs), completedAtMs: null, terminalStatus: null });
        } else if (eventThreadId !== null && eventThreadId !== facts.identity.childThreadId) {
          facts.identity.wrongJoins.push({ kind: 'wrong-child-thread', atMs: safeStamp(event.receivedAtMs) });
        }
      } else if (type === 'turn/completed') {
        // (P2-3) a completion for a thread whose turn/started is still
        // BUFFERED (its activity side not yet arrived) binds to that buffered
        // entry: the order-free join must never resurrect an
        // already-terminal turn as the active candidate.
        if (eventThreadId !== null && facts.identity.childThreadId === null) {
          const completedTurnId = boundedThreadId(params.turn?.id) ?? boundedThreadId(params.turnId);
          for (let index = unmatchedChildTurnStarts.length - 1; index >= 0; index -= 1) {
            const entry = unmatchedChildTurnStarts[index];
            if (entry.threadId !== eventThreadId) continue;
            if (entry.completedAtMs !== null) continue;
            if (completedTurnId !== null && entry.turnId !== null && entry.turnId !== completedTurnId) continue;
            entry.completedAtMs = safeStamp(event.receivedAtMs);
            entry.terminalStatus = typeof params.turn?.status === 'string' ? params.turn.status : null;
            break;
          }
        }
        if (eventThreadId !== null && eventThreadId === facts.identity.childThreadId && admitted === false) {
          // The Child already reached terminal BEFORE the window was confirmed:
          // the stale-id refusal — never admitted, never delivered.
          facts.staging.childTerminalPreAdmission = true;
          facts.identity.childTurnActive = false;
          stagingClosed = true;
          break;
        }
        if (eventThreadId !== null && eventThreadId === facts.identity.parentThreadId) {
          // The staging turn ended. With the join ALREADY holding and the
          // Child turn active, ONE final positive-barrier evaluation runs
          // before staging closes (§40.4: the window does not end with the
          // parent's turn) — a held window is ADMITTED here.
          if (facts.identity.joinHolds === true && facts.identity.joinAmbiguous !== true && facts.identity.childTurnActive === true) {
            // (round-3 P2-7) the final evaluation SCHEDULES at the next
            // permitted passive-read time instead of bypassing the cadence
            // floor: a forced read right after a recent evaluation used to
            // reread every collector within the 1000 ms floor. When no
            // permitted slot remains before the deadline, the rate limiter
            // declines the read and staging closes honestly.
            const readyAtMs = lastBarrierEvaluationAtMs + CONFIRMED_WINDOW_PASSIVE_READ_FLOOR_MS;
            if (now() < readyAtMs && readyAtMs < deadline) {
              await sleep(readyAtMs - now());
            }
            evaluation = await barrier();
            if (evaluation?.holds === true) {
              // (round-2 P1) the same post-observer deadline recheck.
              if (now() >= deadline) {
                stagingClosed = true;
                break;
              }
              admitted = true;
              break;
            }
            stagingClosed = true;
            break;
          }
          // The staging turn ended without a qualifying Child so far: at most
          // ONE directed continuation on the SAME parent (§39.9 step 4).
          // AMBIGUOUS identity is never that case: two started activities
          // mean a Child EXISTS (the identity is ambiguous, never absent) —
          // the continuation would invite a third Child and further pollute
          // the identity, so staging closes with the ambiguous refusal.
          if (facts.identity.joinAmbiguous === true) {
            stagingClosed = true;
            break;
          }
          if (usedContinuation || typeof session.continuationPrompt !== 'string') {
            stagingClosed = true;
            break;
          }
          usedContinuation = true;
          facts.staging.continuationUsed = true;
          // (round-4 P2) the directed continuation is bounded by the staging
          // deadline exactly like the initial setup: the same pre-send
          // deadline check and bounded request race — a silent server can
          // never hold staging open past the readiness bound, and no new Root
          // work starts after the allowance.
          const continuation = await boundedSetupRequest('turn/start', { threadId: facts.identity.parentThreadId, input: [{ type: 'text', text: session.continuationPrompt }] });
          facts.rootInputs.push({ kind: 'directed-continuation', turnId: boundedThreadId(continuation?.result?.turn?.id) ?? boundedThreadId(continuation?.result?.turnId), sentAtMs: safeStamp(continuation?.sentAtMs) });
          if (facts.rootInputs.length > CONFIRMED_WINDOW_MAX_ROOT_INPUTS) throw new Error('the Root input ceiling was exceeded');
        }
      }
      // The positive barrier: evaluated only with the join holding (and NOT
      // ambiguous) and the Child turn active, rate-limited to the passive
      // read floor.
      if (facts.identity.joinHolds === true && facts.identity.joinAmbiguous !== true && facts.identity.childTurnActive === true) {
        evaluation = await barrier();
        if (evaluation?.holds === true) {
          // (round-2 P1) the same post-observer deadline recheck.
          if (now() >= deadline) {
            stagingClosed = true;
            break;
          }
          admitted = true;
          break;
        }
      }
    }
    // (round-2 P1) the final safety net: an admitted window whose staging
    // (or case) deadline has already passed is never delivered — the loop
    // rechecks cover the admission sites; this net covers any future path.
    if (admitted === true && now() >= Math.min(stagingDeadlineAtMs, caseDeadlineAtMs)) {
      admitted = false;
      stagingClosed = true;
    }

    if (!admitted) {
      facts.finalState = 'staging-not-ready';
      reach('staging-not-ready');
      facts.window.confirmedAtMs = null;
      refuse(facts.staging.childTerminalPreAdmission === true
        ? 'the Child turn reached terminal before the pending window was confirmed (the stale-id refusal)'
        : facts.identity.joinAmbiguous === true
          ? 'the identity join is ambiguous: two different started SubAgentActivity items named two different Children (§39.9 step 3: the identity stays named-unestablished and is never resolved by picking one)'
          : facts.identity.joinHolds === true
            ? barrierMissReason(evaluation)
            : `the identity join never held (parent SubAgentActivity.agentThreadId x Child turn/started.threadId; thread/started is never required): ${facts.staging.descriptorPublicationObserved === true ? 'the setup descriptor publication is not a live receipt' : 'no parent-bound spawn activity was observed'}; ${facts.identity.childThreadId === null ? (unmatchedChildTurnStarts.length > 0 ? 'a Child turn/started was observed but its parent SubAgentActivity side never arrived (the join stays open)' : 'no Child was spawned through the real parent') : 'the Child turn/started was never observed on the Child stream'}`);
      return finalizeSession(facts, connection, host, now, dutyAdjudication, redact);
    }

    // §39.9 step 6: the positive barrier holds — record the window.
    facts.finalState = 'pending-window-confirmed';
    reach('pending-window-confirmed');
    facts.window.confirmedAtMs = now();
    facts.window.pendingObservationConfirmedAtMs = safeStamp(evaluation?.pending?.observedAtMs);
    facts.window.pendingIntervalStartedAtMs = facts.window.childTurnStartedAtMs;
    facts.window.holdDeadlineAtMs = safeStamp(evaluation?.pending?.holdDeadlineAtMs);
    facts.window.ancestryBaselineDigest = typeof evaluation?.ancestry?.digest === 'string' ? evaluation.ancestry.digest : null;
    facts.window.ancestryHops = evaluation?.ancestry?.hops ?? null;
    facts.window.dutiesObservable = evaluation?.duties?.observable === true;
    facts.window.dutyNames = Array.isArray(evaluation?.duties?.duties) ? evaluation.duties.duties : null;
    facts.window.controlActiveAtMs = safeStamp(evaluation?.control?.active === true ? now() : null);
    facts.window.controlFreshAtMs = safeStamp(evaluation?.control?.freshAtMs);
    facts.window.controlDeclaredLifetimeMs = safeStamp(evaluation?.control?.declaredLifetimeMs);
    const holdDeadlineAtMs = facts.window.holdDeadlineAtMs ?? (caseDeadlineAtMs - CONFIRMED_WINDOW_MEASUREMENT_CUTOFF_AFTER_HOLD_MS - CONFIRMED_WINDOW_OBSERVATION_TEARDOWN_AFTER_CUTOFF_MS);
    facts.window.measurementCutoffAtMs = Math.min(holdDeadlineAtMs + CONFIRMED_WINDOW_MEASUREMENT_CUTOFF_AFTER_HOLD_MS, caseDeadlineAtMs);
    facts.window.observationTeardownAtMs = Math.min(facts.window.measurementCutoffAtMs + CONFIRMED_WINDOW_OBSERVATION_TEARDOWN_AFTER_CUTOFF_MS, caseDeadlineAtMs);

    // §39.9 step 7: exactly ONE native delivery — the empty-turn-id
    // startup-interrupt form is FORBIDDEN for this case (pre-send refusal).
    if (facts.identity.childTurnId === null || facts.identity.childTurnId === '') {
      facts.nativeRequest.outcome = 'forbidden-empty-turn-id';
      refuse('the empty-turn-id startup-interrupt form is forbidden for this case (it is not an exact active-turn target)');
      return finalizeSession(facts, connection, host, now, dutyAdjudication, redact);
    }
    facts.nativeRequest.threadId = facts.identity.childThreadId;
    facts.nativeRequest.turnId = facts.identity.childTurnId;
    facts.nativeRequest.attemptCount = 1;
    let transportReplyAtMs = null;
    try {
      const reply = await connection.request('turn/interrupt', { threadId: facts.nativeRequest.threadId, turnId: facts.nativeRequest.turnId });
      // The attributable request bounds are recorded BEFORE anything else
      // consumes them (§39.9 step 7).
      facts.nativeRequest.sentAtMs = safeStamp(reply?.sentAtMs);
      facts.nativeRequest.repliedAtMs = safeStamp(reply?.repliedAtMs);
      transportReplyAtMs = facts.nativeRequest.repliedAtMs;
      facts.nativeRequest.outcome = 'sent';
      facts.nativeRequest.responseWithinBound = transportReplyAtMs !== null
        && transportReplyAtMs - facts.nativeRequest.sentAtMs <= CONFIRMED_WINDOW_NATIVE_RESPONSE_BOUND_MS;
      facts.receipt.transportReplyAtMs = transportReplyAtMs;
      reach('native-request-sent');
      facts.finalState = 'native-request-sent';
    } catch (deliveryError) {
      // A failed/unsent request is recorded typed and NEVER invisibly
      // retried. The server's own active-turn rejection is the named
      // wrong/stale-target outcome and fails closed.
      // (round-3 P2-5) the attributable INITIATION bounds ride the launcher's
      // error path (`initiatedAtMs`); the REJECTION time is never substituted
      // as the send stamp — a genuinely unattributable initiation stays
      // explicitly unsent (null), never fabricated from now().
      const text = redact(deliveryError);
      facts.nativeRequest.sentAtMs = safeStamp((/** @type {any} */ (deliveryError))?.initiatedAtMs);
      facts.nativeRequest.repliedAtMs = safeStamp((/** @type {any} */ (deliveryError))?.repliedAtMs);
      facts.nativeRequest.outcome = /expected active turn id|no active turn to interrupt|thread not found/u.test(text)
        ? 'stale-turn-target'
        : 'rejected';
      facts.nativeRequest.errorText = text;
      facts.nativeRequest.responseWithinBound = null;
      facts.receipt.transportReplyAtMs = null;
      reach('native-request-sent');
      refuse(`the native request was not delivered (${facts.nativeRequest.outcome}): ${text}`);
      return finalizeSession(facts, connection, host, now, dutyAdjudication, redact);
    }

    // §39.9 step 8: resolution collection until the measurement cutoff. The
    // transport reply is NEVER itself the settlement; a reply riding a
    // natural completion is the named response-at-unrelated-completion
    // failure; parent-only cancellation is typed separately and never
    // stands in for the Child's resolution.
    const collectionDeadlineAtMs = Math.min(facts.window.measurementCutoffAtMs ?? caseDeadlineAtMs, caseDeadlineAtMs);
    let childResolution = null;
    let observationResolved = false;
    // (round-4 P2) the instrument's own resolution timestamp, captured when
    // first reported (never the later polling/loop-completion time).
    let observationResolvedAtMs = null;
    let parentCancellationAtMs = null;
    // (P2-5) an observed parent terminal that is NOT cancellation carries its
    // own observed status; the Child's non-resolution cause stays
    // named-unestablished (the refusal text carries it, never a presumed
    // cancellation stamp).
    /** @type {string | null} */
    let parentTerminalStatusObserved = null;
    let lastObservationEvaluationAtMs = lastBarrierEvaluationAtMs;
    while (now() < collectionDeadlineAtMs && childResolution === null) {
      // The original observation's resolution through the unchanged
      // instrument rides the same injected collectors, rate-limited to the
      // passive read floor; the notification wait wakes at the next floor
      // tick so a resolution is never missed for lack of host events.
      const wakeAtMs = Math.min(collectionDeadlineAtMs, lastObservationEvaluationAtMs + CONFIRMED_WINDOW_PASSIVE_READ_FLOOR_MS);
      const event = await connection.nextNotification(Math.min(wakeAtMs, caseDeadlineAtMs));
      if (typeof observers.pendingObservation === 'function' && now() - lastObservationEvaluationAtMs >= CONFIRMED_WINDOW_PASSIVE_READ_FLOOR_MS) {
        lastObservationEvaluationAtMs = now();
        // (round-4 P2) an independent collector failure is recorded as
        // inconclusive — it never escapes to the outer catch, which would
        // finalize before the already-observed terminal facts were persisted.
        const pending = await boundedCollectionRead(observers.pendingObservation, collectionDeadlineAtMs)
          .catch((collectorError) => {
            facts.inconclusive = facts.inconclusive ?? { reason: `the collection instrument read failed (the retained terminal evidence stands): ${redact(collectorError)}` };
            return null;
          });
        if (pending?.resolved === true && observationResolved !== true) {
          // (round-4 P2) the instrument's OWN resolution timestamp is
          // preserved when first reported — never the later polling time.
          observationResolved = true;
          observationResolvedAtMs = safeStamp(pending.resolvedAtMs) ?? now();
        }
      }
      if (event === null) {
        if (now() >= collectionDeadlineAtMs) break;
        continue; // the wake was the floor tick, not the cutoff — keep collecting
      }
      const params = event?.params ?? {};
      // The SAME F4 envelope read as the staging loop: the event KIND is read
      // from `params.type` first and falls back to the notification METHOD
      // name — both phases of ONE controller accept the same envelope
      // spellings, so a method-only host can never admit-and-then-burn.
      const type = typeof params.type === 'string' && params.type.length > 0
        ? params.type
        : (typeof event?.method === 'string' ? event.method : '');
      const eventThreadId = boundedThreadId(params.threadId);
      if (type === 'turn/completed' && eventThreadId === facts.nativeRequest.threadId) {
        const status = typeof params.turn?.status === 'string' ? params.turn.status : null;
        const completedTurnId = boundedThreadId(params.turn?.id) ?? boundedThreadId(params.turnId);
        facts.receipt.completedTurnId = completedTurnId;
        if (status === 'interrupted') {
          childResolution = { atMs: safeStamp(event.receivedAtMs), status, basis: 'child-terminal-event' };
        } else {
          // A natural completion: any transport reply on THIS path is the
          // response-at-unrelated-completion fact and fails closed.
          childResolution = { atMs: safeStamp(event.receivedAtMs), status, basis: 'natural-completion' };
          facts.receipt.unrelatedCompletionReply = transportReplyAtMs !== null;
        }
        // (round-4 P2) the terminal facts persist EAGERLY at consumption: an
        // independent collector failure later in the loop must never erase
        // native resolution evidence already observed.
        facts.receipt.childResolutionAtMs = childResolution.atMs;
        facts.receipt.childTerminalStatus = childResolution.status;
        facts.receipt.childResolutionBasis = childResolution.basis;
      } else if (type === 'turn/completed' && eventThreadId === facts.identity.parentThreadId && childResolution === null) {
        // (P2-5, 2026-11-18 codex gate round) the pinned protocol exposes the
        // parent's terminal cause on the turn/completed payload (`turn.status`
        // = completed|interrupted|failed|inProgress; verified against the
        // binary's generated schema — there is NO turn/aborted notification
        // on this protocol). ONLY an affirmative `interrupted` parent
        // terminal is the cancellation fact; an ordinary completed/failed
        // parent turn is recorded with its observed status and the cause of
        // the Child's non-resolution stays named-unestablished — never
        // presumed cancellation.
        const parentTerminalStatus = typeof params.turn?.status === 'string' ? params.turn.status : null;
        if (parentTerminalStatus === 'interrupted') {
          parentCancellationAtMs = safeStamp(event.receivedAtMs);
        } else {
          parentTerminalStatusObserved = parentTerminalStatus;
        }
      }
    }
    // The observation leg is NEVER abandoned while the measurement window is
    // open: the natural late ordering (interrupt → the Child terminal → the
    // held worker releases → the instrument resolves) needs further
    // floor-cadence reads AFTER the terminal, and the fast offline shape (no
    // in-loop read ever ran) still owes its decisive read. Collection
    // continues — reads rate-limited to the passive read floor — until BOTH
    // legs are observed or the measurement cutoff.
    while (typeof observers.pendingObservation === 'function' && observationResolved !== true
      && now() < collectionDeadlineAtMs) {
      const readyAtMs = lastObservationEvaluationAtMs + CONFIRMED_WINDOW_PASSIVE_READ_FLOOR_MS;
      if (readyAtMs >= collectionDeadlineAtMs) break;
      if (now() < readyAtMs) await sleep(readyAtMs - now());
      lastObservationEvaluationAtMs = now();
      const pending = await boundedCollectionRead(observers.pendingObservation, collectionDeadlineAtMs)
        .catch((collectorError) => {
          facts.inconclusive = facts.inconclusive ?? { reason: `the collection instrument read failed (the retained terminal evidence stands): ${redact(collectorError)}` };
          return null;
        });
      if (pending?.resolved === true) {
        observationResolved = true;
        observationResolvedAtMs = safeStamp(pending.resolvedAtMs) ?? now();
      }
    }
    facts.receipt.childResolutionAtMs = childResolution?.atMs ?? null;
    facts.receipt.childTerminalStatus = childResolution?.status ?? null;
    facts.receipt.childResolutionBasis = childResolution?.basis ?? null;
    facts.receipt.observationResolvedAtMs = observationResolvedAtMs;
    facts.receipt.parentCancellationAtMs = parentCancellationAtMs;
    if (childResolution !== null && childResolution.basis === 'child-terminal-event' && observationResolved === true) {
      // §40.4: native-resolution-observed = the Child's own interrupted
      // terminal AND the original observation's resolution — BOTH legs.
      facts.finalState = 'native-resolution-observed';
      reach('native-resolution-observed');
    } else if (childResolution !== null && childResolution.basis === 'child-terminal-event') {
      // The Child terminal arrived but the ORIGINAL observation never
      // resolved: the second leg of the resolution state is missing —
      // escalation stops honestly at the sent request.
      facts.finalState = 'native-request-sent';
      refuse('the Child turn reached its interrupted terminal but the original observation never resolved inside the measurement window: native-resolution-observed owes BOTH legs');
    } else if (childResolution !== null && childResolution.basis === 'natural-completion') {
      // The request WAS sent (its bounds ride the record); the resolution
      // observation typed as the named failure, so escalation stops at
      // native-request-sent.
      facts.finalState = 'native-request-sent';
      refuse('the transport reply rode the natural-completion path: response-at-unrelated-completion fails closed and is NEVER the settlement');
    } else {
      refuse(parentCancellationAtMs !== null
        ? 'the parent turn ended (interrupted) while the Child stayed unresolved: parent-only cancellation never settles the exact-Child delivery'
        : parentTerminalStatusObserved !== null
          ? `the parent turn ended (status ${parentTerminalStatusObserved}) while the Child stayed unresolved: the parent's terminal cause is not cancellation — why the Child never resolved stays unestablished`
          : 'the Child resolution was never observed inside the measurement window');
    }
    // (P2-6, 2026-11-18 codex gate round) §39.9 step 9: collection stops at
    // the carried FENCES — never at an early resolution. When the Child
    // resolution and the original observation arrive early, the planned
    // independent collection continues through the registered
    // observation-teardown fence (the notification stream stays drained and
    // the unchanged instrument's duty/control reads keep their floor-cadence
    // horizon) so remaining duty and control evidence cannot be truncated by
    // an early native resolution; the host is disposed only at/after the
    // fence. A post-completion instrument failure is recorded as
    // inconclusive — it never erases an already-observed resolution.
    const collectionHorizonAtMs = Math.min(facts.window.observationTeardownAtMs ?? caseDeadlineAtMs, caseDeadlineAtMs);
    facts.fences.collectionHorizonAtMs = collectionHorizonAtMs;
    while (now() < collectionHorizonAtMs) {
      const horizonWakeAtMs = Math.min(collectionHorizonAtMs, lastObservationEvaluationAtMs + CONFIRMED_WINDOW_PASSIVE_READ_FLOOR_MS);
      // (round-5 P3-1) the horizon DRAIN runs POST-escalation: a fatal here
      // (a host exit mid-drain) is recorded through the SAME redacted
      // inconclusive boundary as the collector reads and ends the drain — the
      // already-set typed refusal (or a settled record's clean refusal-free
      // state) is never overwritten by a false "failed before escalation
      // completed" claim.
      let horizonEvent = null;
      try {
        horizonEvent = await connection.nextNotification(Math.max(horizonWakeAtMs, now()));
      } catch (horizonDrainError) {
        facts.inconclusive = { reason: `the post-resolution horizon drain failed (the recorded escalation stands): ${redact(horizonDrainError)}` };
        break;
      }
      if (typeof observers.pendingObservation === 'function' && now() - lastObservationEvaluationAtMs >= CONFIRMED_WINDOW_PASSIVE_READ_FLOOR_MS) {
        lastObservationEvaluationAtMs = now();
        try {
          await boundedCollectionRead(observers.pendingObservation, collectionHorizonAtMs);
          await boundedCollectionRead(observers.dutyFacts, collectionHorizonAtMs);
          await boundedCollectionRead(observers.controlFacts, collectionHorizonAtMs);
        } catch (horizonReadError) {
          // (round-2 P2) the SAME redaction boundary as the staging and
          // delivery failures: a collector error can carry fixture-private
          // absolute paths, and the inconclusive facts are persisted.
          facts.inconclusive = { reason: `the post-resolution independent collection read failed (the observed resolution stands): ${redact(horizonReadError)}` };
          break;
        }
      }
      if (horizonEvent === null && now() >= collectionHorizonAtMs) break;
    }
    return finalizeSession(facts, connection, host, now, dutyAdjudication, redact);
  } catch (error) {
    facts.finalState = facts.finalState ?? 'staging-not-ready';
    if (facts.states.length === 0) reach('staging-not-ready');
    refuse(`the choreography failed before escalation completed: ${redact(error)}`);
    return finalizeSession(facts, connection, host, now, dutyAdjudication, redact);
  }
}

/**
 * Deterministic disposal (§39.9 step 9): the bounded facts are projected
 * BEFORE disposal, the ONE connection closes bounded, the ONE host is
 * disposed, and teardown is labelled for what it is — never settlement.
 * @param {any} facts @param {any} connection @param {any} host @param {() => number} now @param {any} dutyAdjudication
 */
async function finalizeSession(facts, connection, host, now, dutyAdjudication, redact = boundedErrorText) {
  facts.fences.persistedBeforeDisposal = true;
  // §39.9 steps 8/9: the final reload-side consumer runs over the PERSISTED
  // bytes (a JSON round trip — exactly what an offline reader reloads). The
  // `all-duties-adjudicated` state is reached ONLY on an admitted delivery
  // whose settlement the consumer accepts over the retained record; every
  // other outcome keeps its named refusal and rides the verdict honestly.
  // (round-4 P2) the duty adjudication rides the bounded whitelisted
  // projection: the verdict consumes the SAME projected representation the
  // record persists (never the raw injected object).
  const projectedDuties = projectConfirmedWindowDutyAdjudication(dutyAdjudication);
  const evidenceVerdict = admitConfirmedWindowNativeEvidence(
    JSON.parse(JSON.stringify(projectConfirmedWindowBlock(facts))),
    projectedDuties,
  );
  facts.evidenceVerdict = evidenceVerdict;
  if (evidenceVerdict.delivery.status === 'admitted' && evidenceVerdict.settlement.settled === true) {
    facts.finalState = 'all-duties-adjudicated';
    facts.states.push({ state: 'all-duties-adjudicated', atMs: now() });
  }
  const projected = projectConfirmedWindowBlock(facts);
  if (connection && typeof connection.close === 'function') {
    try {
      await connection.close();
      facts.disposal.connectionClosed = true;
    } catch (error) {
      facts.disposal.connectionClosed = false;
      // (round-2 P2) the SAME redaction boundary as every other persisted
      // failure text: a close failure can carry fixture-private paths.
      facts.inconclusive = { reason: `the protocol connection could not be closed bounded: ${redact(error)}` };
    }
  }
  if (host && typeof host.dispose === 'function') {
    try {
      await host.dispose();
      facts.disposal.hostDisposed = true;
    } catch (error) {
      facts.disposal.hostDisposed = false;
      const disposalFailureText = `the host disposal failed: ${redact(error)}`;
      facts.inconclusive = facts.inconclusive
        ? { reason: `${facts.inconclusive.reason}; ${disposalFailureText}` }
        : { reason: disposalFailureText };
    }
  }
  facts.disposal.teardownLabel = 'planned-observation-teardown';
  void now;
  return {
    controllerVersion: CONFIRMED_WINDOW_CONTROLLER_VERSION,
    route: 'confirmed-window',
    source: facts.source,
    host: { pid: facts.host.pid, argvDigest: facts.host.argvDigest, startedAtMs: facts.host.startedAtMs, launchCount: facts.host.launchCount },
    states: facts.states,
    evidenceVerdict: facts.evidenceVerdict,
    finalState: facts.finalState,
    refusal: facts.refusal,
    inconclusive: facts.inconclusive,
    identity: {
      parentThreadId: facts.identity.parentThreadId,
      childThreadId: facts.identity.childThreadId,
      childTurnId: facts.identity.childTurnId,
      joinBasis: facts.identity.joinBasis,
      threadStartedRequired: false,
      joinObservedAtMs: facts.identity.joinObservedAtMs,
      wrongJoins: facts.identity.wrongJoins,
    },
    rootInputs: facts.rootInputs,
    staging: facts.staging,
    window: facts.window,
    nativeRequest: facts.nativeRequest,
    receipt: facts.receipt,
    fences: facts.fences,
    disposal: facts.disposal,
    block: projected,
  };
}

/**
 * The DEFAULT real host launcher (§39.9 step 1): spawns exactly ONE
 * `codex app-server` process with the composed research argv and the fixture
 * environment, and owns its ONE protocol connection (single-line JSON-RPC
 * frames over stdio; ONE outstanding request at a time — the production
 * client's own discipline, mirrored read-only from the reference validators;
 * bounded line/output bytes; typed disconnection). This is a research
 * launcher inside the tool — never a production surface.
 * @param {{ codexBinary: string, codexHome: string, workspace: string, env: Record<string, string | undefined>, arguments: string[], caseDeadlineAtMs: number, launchedAtMs: number }} launch
 * @param {{ spawn?: typeof import('node:child_process').spawn, now?: () => number, waitUntil?: (targetAbsMs: number) => Promise<void>, maxLineBytes?: number, maxOutputBytes?: number, maxStderrTailBytes?: number, killGraceMs?: number }} [dependencies]
 * @returns {Promise<any>} the owned host handle
 */
export async function launchCodexAppServerHost(launch, dependencies = {}) {
  if (!launch || typeof launch !== 'object') throw invalidControllerInput('the launch context is required.');
  if (typeof launch.codexBinary !== 'string' || launch.codexBinary.length === 0) throw invalidControllerInput('the codex binary path is required.');
  if (!Array.isArray(launch.arguments) || launch.arguments.length === 0) throw invalidControllerInput('the composed host arguments are required.');
  // (P1-6) the ONE shared case deadline is REQUIRED launch context and is
  // ENFORCED against every outstanding request (a missing deadline used to
  // leave the launcher unable to bound a silent host at all).
  if (typeof launch.caseDeadlineAtMs !== 'number' || !Number.isFinite(launch.caseDeadlineAtMs) || launch.caseDeadlineAtMs < 0) {
    throw invalidControllerInput('the shared case deadline (caseDeadlineAtMs, a finite non-negative number of milliseconds) is required for the owned host launch.');
  }
  const spawn = dependencies.spawn ?? (await import('node:child_process')).spawn;
  // (P1-4) the SAME integer normalization as the choreography's default
  // clock: ONE clock granularity for the launcher's request/notification
  // stamps and the controller's fences.
  const now = dependencies.now ?? (() => Math.floor(performance.now()));
  const waitUntil = dependencies.waitUntil ?? ((targetAbsMs) => new Promise((/** @type {(value: void) => void} */ resolve) => {
    const delay = Math.max(0, targetAbsMs - now());
    const timer = setTimeout(resolve, delay);
    timer.unref?.();
  }));
  const maxLineBytes = dependencies.maxLineBytes ?? 16 * 1024 * 1024;
  const maxOutputBytes = dependencies.maxOutputBytes ?? 32 * 1024 * 1024;
  const killGraceMs = dependencies.killGraceMs ?? 1_000;
  let stdoutBytes = 0;
  let lineBuffer = Buffer.alloc(0);
  let fatalError = /** @type {any} */ (null);
  let nextId = 1;
  let pending = /** @type {any} */ (null);
  let disconnected = false;
  /** @type {any[]} */
  const notificationQueue = [];
  /** @type {(() => void)[]} */
  const notificationWaiters = [];
  /** @type {{ method: string, params: any, sentAtMs: number, repliedAtMs: number | null }[]} */
  const inflightForLog = [];
  const child = spawn(launch.codexBinary, launch.arguments, {
    cwd: launch.workspace,
    env: { ...launch.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
  const handleLines = (/** @type {Buffer} */ chunk) => {
    if (fatalError) return;
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxOutputBytes) return fail(new Error('the owned host exceeded its total output bound'));
    lineBuffer = Buffer.concat([lineBuffer, chunk]);
    if (lineBuffer.length > maxLineBytes && lineBuffer.indexOf(10) === -1) return fail(new Error('the owned host emitted an oversized frame'));
    for (;;) {
      const newline = lineBuffer.indexOf(10);
      if (newline < 0) break;
      let line = lineBuffer.subarray(0, newline);
      lineBuffer = lineBuffer.subarray(newline + 1);
      if (line.at(-1) === 13) line = line.subarray(0, -1);
      if (line.length === 0) continue;
      if (line.length > maxLineBytes) return fail(new Error('the owned host emitted an oversized frame'));
      let frame;
      try {
        frame = JSON.parse(line.toString('utf8'));
      } catch {
        return fail(new Error('the owned host emitted malformed JSON'));
      }
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return fail(new Error('the owned host emitted a non-object frame'));
      if (pending !== null && frame.id === pending.id) {
        const current = pending;
        pending = null;
        current.entry.repliedAtMs = now();
        if (frame.error !== undefined && frame.error !== null) {
          const message = typeof frame.error?.message === 'string' ? frame.error.message : 'the owned host rejected the request';
          // (round-4 P2) a PROTOCOL rejection carries the attributable bounds
          // (initiation + rejection arrival) — consistent with the
          // disconnection and write-failure paths — so a real server
          // rejection keeps its send stamp instead of erasing it.
          current.reject(Object.assign(new Error(message), { initiatedAtMs: current.entry.sentAtMs, repliedAtMs: current.entry.repliedAtMs }));
        } else {
          current.resolve({ result: frame.result ?? null, sentAtMs: current.entry.sentAtMs, repliedAtMs: current.entry.repliedAtMs });
        }
        continue;
      }
      if (typeof frame.method === 'string') {
        notificationQueue.push({ method: frame.method, params: frame.params ?? null, receivedAtMs: now() });
        const waiter = notificationWaiters.shift();
        if (waiter) waiter();
      }
    }
  };
  const fail = (/** @type {Error} */ error) => {
    if (fatalError) return;
    fatalError = error;
    disconnected = true;
    if (pending !== null) {
      const current = pending;
      pending = null;
      // (round-3 P2-5) the attributable initiation bounds ride the error: the
      // consumer can preserve the real send stamp instead of fabricating one
      // from the failure time.
      current.reject(Object.assign(new Error(`the owned host disconnected before replying: ${error.message}`), { initiatedAtMs: current.entry.sentAtMs }));
    }
    while (notificationWaiters.length > 0) notificationWaiters.shift()?.();
  };
  // (round-2 P2) stderr is CONSUMED with a bounded in-memory retention tail:
  // the launcher pipes stderr, and a host whose diagnostics fill the OS pipe
  // buffer would block before producing its protocol response. The tail is
  // retained for bounded diagnostics ONLY — it is never projected into a
  // record (the whitelisted projection carries no stderr bytes).
  const maxStderrTailBytes = dependencies.maxStderrTailBytes ?? 8 * 1024;
  let stderrBytes = 0;
  let stderrTail = Buffer.alloc(0);
  child.stderr?.on('data', (/** @type {Buffer} */ chunk) => {
    stderrBytes += chunk.length;
    stderrTail = Buffer.concat([stderrTail, chunk]);
    if (stderrTail.length > maxStderrTailBytes) stderrTail = stderrTail.subarray(stderrTail.length - maxStderrTailBytes);
  });
  child.stdout?.on('data', handleLines);
  child.stdout?.once('error', (cause) => fail(new Error(`the owned host stdout failed: ${String(cause)}`)));
  child.stderr?.once('error', () => {});
  child.stdin?.once('error', (cause) => fail(new Error(`the owned host stdin failed: ${String(cause)}`)));
  child.once('error', (cause) => fail(new Error(`the owned host process failed: ${String(cause)}`)));
  child.once('exit', (code, signal) => fail(new Error(`the owned host exited before the choreography completed (code ${String(code)} signal ${String(signal)})`)));
  const writeFrame = (/** @type {any} */ value) => {
    const frame = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(frame) > maxLineBytes || !child.stdin?.writable) throw new Error('the owned host stdin is unavailable');
    child.stdin.write(frame);
  };
  const host = {
    identity: { pid: typeof child.pid === 'number' ? child.pid : null, argv: [...launch.arguments], startedAtMs: now() },
    // (round-2 P2) bounded in-memory stderr diagnostics (never persisted).
    stderrDiagnostics: () => ({
      totalBytes: stderrBytes,
      tailBytes: stderrTail.length,
      truncated: stderrBytes > stderrTail.length,
      tail: stderrTail.toString('utf8'),
    }),
    connection: {
      request: (/** @type {string} */ method, /** @type {any} */ params) => {
        if (fatalError) return Promise.reject(fatalError);
        if (pending !== null) return Promise.reject(new Error('the owned host connection carries ONE outstanding request'));
        const id = nextId++;
        const entry = { method, params, sentAtMs: now(), repliedAtMs: null };
        inflightForLog.push(entry);
        return new Promise((resolve, reject) => {
          pending = { id, entry, resolve, reject };
          try {
            writeFrame({ id, method, params });
          } catch (error) {
            pending = null;
            // (round-3 P2-5) the initiation stamp is attributable even when
            // the frame write failed — it rides the error, never a fabricated
            // post-hoc timestamp.
            reject(Object.assign(new Error(`the owned host request could not be written: ${error instanceof Error ? error.message : String(error)}`), { initiatedAtMs: entry.sentAtMs }));
            return;
          }
          // (P1-6, 2026-11-18 codex gate round) The ONE shared case deadline
          // bounds the OUTSTANDING REQUEST: a host that stays alive without
          // replying can never hold the choreography past its deadline (the
          // deadline checks and the deterministic disposal were unreachable
          // while a request promise never settled). The deadline failure
          // rides the SAME typed disconnection path, so the pending request
          // rejects by name and every notification waiter wakes — the
          // choreography's catch then runs the deterministic disposal.
          waitUntil(launch.caseDeadlineAtMs).then(() => {
            if (pending !== null && pending.id === id && fatalError === null) {
              fail(new Error('the owned host request exceeded the shared case deadline'));
            }
          }, () => { /* a failed deadline timer leaves the typed failure paths in charge */ });
        });
      },
      nextNotification: (/** @type {number} */ deadlineAtMs) => {
        const pump = () => {
          if (notificationQueue.length > 0) return Promise.resolve(notificationQueue.shift());
          // (round-2 P2) a fatal protocol error or host exit PROPAGATES from
          // the notification wait: the choreography treats null as a timeout,
          // so an immediately-resolved null here made it retry in a
          // microtask busy loop until its deadline — the typed rejection
          // starts the deterministic cleanup promptly instead.
          if (fatalError) return Promise.reject(fatalError);
          return new Promise((/** @type {(value: any) => void} */ resolve, /** @type {(cause: any) => void} */ reject) => {
            const waiter = () => {
              if (notificationQueue.length > 0) resolve(notificationQueue.shift());
              else if (fatalError) reject(fatalError);
              else notificationWaiters.push(waiter);
            };
            notificationWaiters.push(waiter);
            waitUntil(deadlineAtMs).then(() => {
              const index = notificationWaiters.indexOf(waiter);
              if (index >= 0) {
                notificationWaiters.splice(index, 1);
                resolve(notificationQueue.shift() ?? null);
              }
            });
          });
        };
        return pump();
      },
      close: async () => {
        try {
          child.stdin?.end();
        } catch { /* best-effort bounded close */ }
      },
      closed: () => disconnected,
    },
    dispose: async () => {
      try {
        child.stdin?.end();
      } catch { /* best-effort */ }
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((/** @type {(value: void) => void} */ resolve) => {
        const timer = setTimeout(resolve, killGraceMs);
        timer.unref?.();
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          child.kill('SIGTERM');
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch { /* already gone */ }
      }
    },
  };
  return host;
}

/**
 * The executor seam the driver's standard entry dispatches to for the
 * confirmed-window route (§40.1): runs the staged choreography and maps the
 * result to the redacted live-facts block the record persists. A staged
 * refusal is a COMPLETED observation — it is RETURNED (never thrown) so the
 * record persists the refused block with its named state; only
 * input/preflight rejections BEFORE the choreography throw (the driver then
 * disposes the fixture and surfaces the refusal with no record, mirroring
 * the default executor's pre-launch contract).
 * @param {{ input: any, fixture: any }} context
 * @param {{ launchConfirmedWindowHost?: any, observers?: any, dutyAdjudication?: any, stagingPrompt?: string, continuationPrompt?: string, now?: (() => number) | undefined, wallClockNow?: (() => number) | undefined, sleep?: ((ms: number) => Promise<void>) | undefined, waitUntil?: ((targetAbsMs: number) => Promise<void>) | undefined, redact?: (error: unknown) => string, hostLaunchDependencies?: any, preflight?: () => Promise<{ ok: boolean, reason: string | null } | { ok: boolean, reason: string }> }} [injected]
 */
export async function executeConfirmedWindowCase(context, injected = {}) {
  if (!context || typeof context !== 'object' || !context.input || typeof context.input !== 'object') throw invalidControllerInput('the executor needs the validated case input.');
  if (context.input.interruptRouteSelector !== 'confirmed-window') throw invalidControllerInput('the confirmed-window executor only runs the confirmed-window route.');
  if (!context.fixture || typeof context.fixture !== 'object') throw invalidControllerInput('the executor needs the fixture handle.');
  if (typeof injected.stagingPrompt !== 'string' || injected.stagingPrompt.length === 0) throw invalidControllerInput('the executor needs the composed staging prompt.');
  if (typeof injected.continuationPrompt !== 'string' || injected.continuationPrompt.length === 0) throw invalidControllerInput('the executor needs the composed CHANGED continuation prompt.');
  const hostLauncher = typeof injected.launchConfirmedWindowHost === 'function'
    ? injected.launchConfirmedWindowHost
    : (/** @type {any} */ launch) => launchCodexAppServerHost(launch, injected.hostLaunchDependencies ?? {});
  // The route's offline preflight (the Exit clause): every observer the
  // registered design REQUIRES must be armed BEFORE any launch would
  // happen — a known-absent mechanism is a named pre-launch refusal at
  // zero model turns. The preflight is instrumentation/configuration ONLY:
  // it never predicts the model's future action, and passing it is NEVER a
  // guaranteed spawn.
  if (typeof injected.preflight === 'function') {
    const preflight = await injected.preflight();
    if (!preflight || preflight.ok !== true) {
      throw invalidControllerInput(`the confirmed-window route preflight rejected the case before launch: ${preflight?.reason ?? 'unrecorded'}`);
    }
  } else {
    // The minimum composition gate still applies when the entry did not
    // inject its preflight (the direct research seam).
    composeConfirmedWindowHostArguments(
      { workspace: context.fixture.workspace, codexHome: context.fixture.codexHome, env: context.fixture.env },
      { execDefaultMs: context.input.execDefaultMs ?? null, model: context.input.model ?? null },
    );
  }
  const result = await runConfirmedWindowChoreography({
    case: context.input.case,
    codexBinary: context.input.codexBinary,
    sourceSha: context.input.sourceSha,
    output: context.input.output,
    budgetMs: context.input.budgetMs,
    workerDurationMs: context.input.workerDurationMs,
    // (P1-5/P2-1, 2026-11-18 codex gate round) the validated case input's
    // exec-default override and requested model ride the session: the
    // choreography composes the host arguments (including the required
    // `features.code_mode.default_exec_yield_time_ms` override) and applies
    // the model at the protocol-supported `thread/start` boundary from THESE
    // fields — a validated-but-unthreaded value launched a different
    // configuration from the selected and recorded experiment.
    execDefaultMs: context.input.execDefaultMs ?? null,
    model: context.input.model ?? null,
    fixture: context.fixture,
    stagingPrompt: injected.stagingPrompt,
    continuationPrompt: injected.continuationPrompt,
  }, {
    now: injected.now,
    wallClockNow: injected.wallClockNow,
    sleep: injected.sleep,
    // (round-2 P1) the PURE deadline signal the observer bounding races
    // against (never a clock-advancing wait).
    waitUntil: injected.waitUntil,
    launchConfirmedWindowHost: hostLauncher,
    observers: injected.observers ?? null,
    dutyAdjudication: injected.dutyAdjudication ?? null,
    redact: injected.redact,
  });
  const confirmedWindow = {
    controllerVersion: CONFIRMED_WINDOW_CONTROLLER_VERSION,
    block: result.block,
    // (round-4 P2) the persisted duty adjudication is the BOUNDED
    // WHITELISTED projection — extra diagnostics, private paths, credentials
    // and oversized names never ride the case record.
    duties: projectConfirmedWindowDutyAdjudication(injected.dutyAdjudication),
    evidence: result.evidenceVerdict ?? null,
  };
  if (result.refusal !== null || result.inconclusive !== null) {
    // A staged refusal is a COMPLETED observation with its named outcome —
    // not a thrown failure: the record persists it and the case stays
    // `executed` with the refused state honestly recorded.
    return {
      codexVersion: null,
      route: { requested: 'confirmed-window', actual: 'confirmed-window' },
      hostResult: { exitCode: null, sentinelMatched: null, terminalStdoutChecked: null },
      linkage: { checked: result.refusal === null, childThreadId: result.identity.childThreadId, parentThreadId: result.identity.parentThreadId, companionLaunchCount: null, companionSendCount: null, originalHandleChecked: null },
      observations: { outerReturns: null, modelCalls: null, rootJoins: null, decisiveWallMs: null, remainingLifetimeMs: null, pendingInnerAtEnd: null },
      interrupt: { requested: result.nativeRequest.sentAtMs !== null, delivered: result.nativeRequest.outcome === 'sent', settled: null, missingPrerequisite: result.refusal?.reason ?? null },
      held: { endedBeforeGate: null, cleanupLabel: 'confirmed-window-observation', gateReleased: null },
      excerpts: [],
      confirmedWindow,
      inconclusive: result.inconclusive ?? { reason: `the staged choreography refused escalation: ${result.refusal?.reason ?? 'unrecorded'}` },
    };
  }
  return {
    codexVersion: null,
    route: { requested: 'confirmed-window', actual: 'confirmed-window' },
    hostResult: { exitCode: null, sentinelMatched: null, terminalStdoutChecked: null },
    linkage: { checked: true, childThreadId: result.identity.childThreadId, parentThreadId: result.identity.parentThreadId, companionLaunchCount: null, companionSendCount: null, originalHandleChecked: null },
    observations: { outerReturns: null, modelCalls: null, rootJoins: null, decisiveWallMs: null, remainingLifetimeMs: null, pendingInnerAtEnd: null },
    interrupt: { requested: true, delivered: result.nativeRequest.outcome === 'sent', settled: result.evidenceVerdict?.settlement?.settled ?? null, missingPrerequisite: null },
    held: { endedBeforeGate: null, cleanupLabel: 'confirmed-window-observation', gateReleased: null },
    excerpts: [],
    confirmedWindow,
    inconclusive: result.inconclusive,
  };
}
