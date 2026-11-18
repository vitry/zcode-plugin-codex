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
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { admitConfirmedWindowNativeEvidence, projectConfirmedWindowBlock, projectConfirmedWindowDutyAdjudication, REQUIRED_CONFIRMED_WINDOW_DUTY_SLOTS } from './native-control-evidence.mjs';
import { SURVIVAL_CONTROL_READINESS_FLOOR_LINE_INDEX } from './evidence.mjs';
import { captureVerifiedProcessIdentity, terminateVerifiedProcess } from './local-process-observation.mjs';

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

/**
 * (round-19 re-review) the SHARED durable-read attempt ceiling across the
 * staged controller's WHOLE collection (the barrier, staging, resolution
 * and horizon phases): the same registered 600-attempt/1000-ms-cadence
 * contract the durable sampler freezes (§23.5 clause 4) applies to the
 * choreography's own duty reads — one counter, every phase, so an early
 * send + silent server can never exceed the cap by running the horizon
 * loop to the case deadline.
 */
export const CONFIRMED_WINDOW_DUTY_READ_MAX_ATTEMPTS = 600;

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

/**
 * The §41.5.1 frozen harmless-worker hold duration: the observation-detection
 * instant + 420000 ms on the controller clock. The registered CLI value is
 * 420000; the choreography reads the validated session's `workerDurationMs`
 * (defaulting to this constant) and the admission barrier enforces the
 * `observedAtMs + duration` derivation.
 */
export const CONFIRMED_WINDOW_HOLD_DURATION_MS = 420_000;

/**
 * The §41.5.2 closed clock-domain tag every collector fact must carry. The
 * controller is the tag enforcement point: a foreign tag refuses with
 * `clock-domain-mismatch` BEFORE any stamp arithmetic, and an arithmetic
 * violation of the frozen admission/settlement bounds refuses with
 * `clock-bounds-violation`.
 */
export const CONFIRMED_WINDOW_CLOCK_DOMAIN = 'controller-monotonic';

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
 * Whether one collector fact declares a FOREIGN clock domain (§41.5.2). The
 * controller's own synthesized missing-collector placeholders are not
 * collector facts and carry no tag (they hold no stamps either); every fact
 * returned by an actual collector must declare the closed
 * `controller-monotonic` tag.
 * @param {any} fact
 */
function hasForeignClockDomain(fact) {
  if (fact === null || typeof fact !== 'object') return false;
  if (fact.controllerPlaceholder === true) return false;
  return fact.clockDomain !== CONFIRMED_WINDOW_CLOCK_DOMAIN;
}

/**
 * The §41.5.2 admission bounds (a)–(e) over the collected facts, evaluated
 * AFTER the existing control freshness/lifetime predicates and BEFORE any
 * delivery. A missing stamp (null) is not an arithmetic violation — the
 * existing named conjunct misses still fire for absent evidence; a present
 * foreign-clock stamp is.
 * @param {{ pending: any, control: any }} facts
 * @param {number} evaluatedAtMs
 * @param {number} caseDeadlineAtMs
 * @param {number} holdDurationMs
 * @returns {string | null}
 */
function admissionClockBoundsViolation(facts, evaluatedAtMs, caseDeadlineAtMs, holdDurationMs) {
  const observedAtMs = safeStamp(facts?.pending?.observedAtMs);
  if (observedAtMs !== null && observedAtMs > evaluatedAtMs) {
    return `observedAtMs (${observedAtMs}) is after the barrier evaluation instant (${evaluatedAtMs})`;
  }
  const holdDeadlineAtMs = safeStamp(facts?.pending?.holdDeadlineAtMs);
  if (observedAtMs !== null && holdDeadlineAtMs !== null && holdDeadlineAtMs !== observedAtMs + holdDurationMs) {
    return `holdDeadlineAtMs (${holdDeadlineAtMs}) does not equal observedAtMs (${observedAtMs}) + ${holdDurationMs}`;
  }
  if (holdDeadlineAtMs !== null && holdDeadlineAtMs <= evaluatedAtMs) {
    return `holdDeadlineAtMs (${holdDeadlineAtMs}) is not after the barrier evaluation instant (${evaluatedAtMs})`;
  }
  const caseDeadline = safeStamp(caseDeadlineAtMs);
  if (holdDeadlineAtMs !== null && caseDeadline !== null && holdDeadlineAtMs > caseDeadline) {
    return `holdDeadlineAtMs (${holdDeadlineAtMs}) exceeds the case deadline (${caseDeadline})`;
  }
  const resolvedAtMs = safeStamp(facts?.pending?.resolvedAtMs);
  if (facts?.pending?.resolved === true && observedAtMs !== null && resolvedAtMs !== null
    && (resolvedAtMs < observedAtMs || resolvedAtMs > evaluatedAtMs)) {
    return `resolvedAtMs (${resolvedAtMs}) is outside the observedAtMs..evaluation interval (${observedAtMs}..${evaluatedAtMs})`;
  }
  const freshAtMs = safeStamp(facts?.control?.freshAtMs);
  if (freshAtMs !== null && evaluatedAtMs < freshAtMs) {
    return `control freshAtMs (${freshAtMs}) is after the barrier evaluation instant (${evaluatedAtMs})`;
  }
  const declaredLifetimeMs = safeStamp(facts?.control?.declaredLifetimeMs);
  if (declaredLifetimeMs !== null && declaredLifetimeMs > CONFIRMED_WINDOW_CASE_DEADLINE_MS) {
    return `control declaredLifetimeMs (${declaredLifetimeMs}) exceeds the ${CONFIRMED_WINDOW_CASE_DEADLINE_MS} ms case ceiling`;
  }
  return null;
}

/**
 * The §41.5.2 settlement-stage refusal (bound (f) + the raw duty-domain tag),
 * computed BEFORE the existing projection/consumer block so it can never
 * grant credit. An ABSENT duty adjudication is not a bounds violation — the
 * consumer's own `duty-adjudication-unestablished` keeps its semantics; an
 * absent cleanup fence is not a bounds violation either (the consumer's
 * `cleanup-fence-unproven` still applies).
 * @param {any} dutyAdjudication the RAW injected duty adjudication
 * @param {unknown} caseDeadlineAtMs
 * @returns {'clock-domain-mismatch' | 'clock-bounds-violation' | null}
 */
function settlementClockRefusal(dutyAdjudication, caseDeadlineAtMs) {
  if (dutyAdjudication === null || typeof dutyAdjudication !== 'object') return null;
  if (dutyAdjudication.clockDomain !== CONFIRMED_WINDOW_CLOCK_DOMAIN) return 'clock-domain-mismatch';
  const fence = dutyAdjudication.cleanupFenceAtMs;
  const caseDeadline = safeStamp(caseDeadlineAtMs);
  if (typeof fence === 'number' && Number.isFinite(fence) && Math.abs(fence) <= Number.MAX_SAFE_INTEGER
    && (fence < 0 || (caseDeadline !== null && fence > caseDeadline))) {
    return 'clock-bounds-violation';
  }
  return null;
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
 * The §41.5.1 hold producer's owned 0700 gate directory: a SIBLING of the
 * private case output (never inside it — the fixture `--output` must stay
 * empty at creation), holding the completion gate file (`hold`, later
 * `release`), the fake CLI's `_REACHED` completion-blocked sentinel and the
 * verified-process marker path/nonce. The marker is deliberately NOT
 * pre-created: its absence before fake ZCode launches is a confirmed
 * no-worker outcome, never marker corruption. Exported as the offline
 * research seam the boundary rows drive directly.
 * @param {string} output the private case output directory
 * @param {() => number} now the controller clock
 */
export async function createConfirmedWindowHoldGate(output, now) {
  if (typeof output !== 'string' || output.length === 0) return null;
  const resolvedOutput = resolve(output);
  const outputStats = await stat(resolvedOutput).catch(() => null);
  if (outputStats === null || outputStats.isDirectory() !== true) return null;
  const directory = `${resolvedOutput}.hold-gate`;
  // The gate root is ALWAYS a sibling: refuse to touch anything inside the
  // output (or an unrelated path predating this case).
  if (directory === resolvedOutput || directory.startsWith(`${resolvedOutput}${resolve('/')}`)) return null;
  // (P1-1, 2026-11-19 codex review) the gate directory is created
  // EXCLUSIVELY (recursive: false): a pre-existing path is NEVER deleted —
  // the fixture validation reserves only the output directory itself, so a
  // sibling holding another run's artifacts or unrelated files is refused by
  // name instead of silently erased and recreated. Only a directory THIS
  // call created is ever removed on a later failure.
  let createdHere = false;
  try {
    try {
      await mkdir(directory, { recursive: false, mode: 0o700 });
      createdHere = true;
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'EEXIST') {
        // (P2, round-17 re-review) the collision message carries NO path: the
        // output directory may sit OUTSIDE the fixture tree, and the
        // choreography's redaction boundary covers only fixture paths — the
        // private absolute path would survive into the persisted refusal.
        // The EEXIST classification is kept; only the path is omitted.
        throw new Error('the sibling hold-gate path already exists; refusing to delete it (a pre-existing path is never owned by this case)');
      }
      // (P2-5, round-18 re-review) EVERY gate-creation failure maps to a
      // PATH-FREE diagnostic (the round-17 EEXIST fix generalized): a
      // writable output directory whose sibling gate creation fails with any
      // other code (EACCES on a read-only output, EPERM, ENOTDIR) used to
      // rethrow the ORIGINAL error with the full private absolute sibling
      // path — a path outside the fixture tree that redactPrivatePaths never
      // scrubs. The refusing error CODE is kept for diagnosis; the path is
      // never carried.
      const creationCode = typeof /** @type {any} */ (error)?.code === 'string' && /** @type {any} */ (error).code.length > 0
        ? /** @type {any} */ (error).code
        : 'unknown';
      throw new Error(`the hold-gate directory could not be created (the creation refused with code ${creationCode}; the path is never carried)`);
    }
    const gatePath = join(directory, 'completion.gate');
    const gateReachedPath = join(directory, 'completion.reached');
    const processPath = join(directory, 'process.json');
    const processNonce = randomBytes(32).toString('hex');
    await Promise.all([
      writeFile(gatePath, 'hold', { mode: 0o600 }),
      writeFile(gateReachedPath, '', { mode: 0o600 }),
    ]);
    return {
      directory,
      gatePath,
      gateReachedPath,
      processPath,
      processNonce,
      createdAtMs: now(),
      releasedAtMs: /** @type {number | null} */ (null),
      releaseBasis: /** @type {'normal-deadline' | 'cleanup' | null} */ (null),
      releaseContent: /** @type {string | null} */ (null),
    };
  } catch (error) {
    // A partially created OWNED gate root is removed before the failure
    // propagates: the controller's finalize cannot clean a handle it never
    // received. A refused pre-existing path is left exactly as found.
    if (createdHere) await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Write `release` to the gate and record the controller-clock release instant
 * and basis. The write is VERIFIED by reading the file back: a failed write
 * OR a read-back that does not read `release` THROWS to the caller (which
 * records the cleanup failure) — a release whose own read-back contradicts it
 * is never recorded as a verified release.
 * @param {any} gate @param {() => number} now @param {'normal-deadline' | 'cleanup'} basis
 * @param {typeof import('node:fs/promises').readFile} [readBack] the read-back seam (the real file read; injectable for the offline boundary rows)
 */
export async function releaseConfirmedWindowHoldGate(gate, now, basis, readBack = readFile) {
  if (gate === null || gate.releasedAtMs !== null) return;
  await writeFile(gate.gatePath, 'release', { mode: 0o600 });
  gate.releasedAtMs = now();
  gate.releaseBasis = basis;
  gate.releaseContent = (await readBack(gate.gatePath, 'utf8').catch(() => '')).trim();
  if (gate.releaseContent !== 'release') {
    throw new Error(`the completion gate release read-back does not read release (actual content: ${JSON.stringify(gate.releaseContent)})`);
  }
}

/**
 * Terminate the verified fake-ZCode process through the marker/nonce identity
 * (the existing §41.5.1 machinery). A confirmed absence (marker never appeared
 * / process already exited) is the named no-worker outcome; a surviving
 * blocked worker is recorded as a cleanup failure and never a silent success.
 * @param {any} gate @param {any} holdFacts
 */
async function terminateConfirmedWindowHoldWorker(gate, holdFacts) {
  const processFacts = holdFacts.process;
  try {
    const identity = await captureVerifiedProcessIdentity(gate.processPath, gate.processNonce);
    processFacts.identityEstablished = true;
    const outcome = await terminateVerifiedProcess(identity);
    processFacts.verifiedProcessTerminated = outcome?.exited === true && !outcome?.failure;
    if (outcome?.failure) processFacts.errorText = boundedErrorText(outcome.failure);
  } catch (error) {
    const code = /** @type {any} */ (error)?.code;
    if (code === 'ZCODE_SHELL_WAIT_MARKER_ABSENT') {
      processFacts.identityEstablished = false;
      processFacts.noWorkerBasis = 'marker-absent';
    } else if (code === 'ZCODE_SHELL_WAIT_PROCESS_EXITED') {
      processFacts.identityEstablished = true;
      processFacts.noWorkerBasis = 'process-exited';
    } else {
      processFacts.identityEstablished = false;
      processFacts.errorText = boundedErrorText(error);
    }
  }
  processFacts.workerAbsent = processFacts.noWorkerBasis !== null;
  processFacts.blockedWorkerSurvives = processFacts.verifiedProcessTerminated !== true && processFacts.workerAbsent !== true;
}

/**
 * (round-19 re-review) the LIVE LAUNCH CONTEXT: the mutable record the
 * choreography populates as its OWN launch establishes each fact — the
 * controller-computed case deadline, the §41.5.1 marker pair the launch env
 * carries, the controller's OWN Root/Child identities, the first real
 * cleanup action instant, and the bounded evidence-checkpoint writer. The
 * standard entry hands this object to the live collectors' late-bound
 * premises, so they read the identities the controller OBSERVED (never the
 * fake peer's internal ids, never the raw budget duration) and the marker
 * the controller actually generated for THIS launch.
 * @returns {any} the live launch context record
 */
export function createConfirmedWindowLiveLaunchContext() {
  return {
    /** the controller-computed absolute case deadline (start + capped budget, the controller's own clock origin) */
    caseDeadlineAtMs: /** @type {number | null} */ (null),
    /** the §41.5.1 process-marker pair the ONE launch env carries */
    processMarkerPath: /** @type {string | null} */ (null),
    processMarkerNonce: /** @type {string | null} */ (null),
    /** (P2-1, round-21 codex review) the §41.5.1 producer's OWN normalized gate paths — the completion gate and its completion-blocked sentinel the live collector reads (the same sibling paths the producer created, never a template derived from the raw --output string) */
    completionGatePath: /** @type {string | null} */ (null),
    completionGateReachedPath: /** @type {string | null} */ (null),
    /** the controller's OWN observed identities (never the fake peer's session ids) */
    rootThreadId: /** @type {string | null} */ (null),
    childThreadId: /** @type {string | null} */ (null),
    /** the controller's executor premise for the durable reader */
    expectedExecutorAgentId: /** @type {string | null} */ (null),
    /** (P1-4, round-19) the earliest REAL cleanup action instant on the controller clock */
    firstCleanupActionAtMs: /** @type {number | null} */ (null),
    /** (P2-7, round-19) the bounded on-disk evidence-checkpoint writer (BEFORE teardown) */
    persistEvidenceCheckpoint: /** @type {(() => Promise<void>) | null} */ (null),
    /** (P2-6, round-19) the shared durable-read attempt counter (staging + collection + horizon) */
    durableReadAttempts: 0,
  };
}

/**
 * The staged §39.9 choreography. ALL dependencies are injectable so the
 * whole lifecycle is deterministic offline; the default (no injected host
 * launcher / observers) refuses fail-closed rather than inventing one.
 * @param {any} session the validated route session (case input + fixture + composed prompts)
 * @param {{ now?: () => number, wallClockNow?: () => number, sleep?: (ms: number) => Promise<void>, waitUntil?: (targetAbsMs: number) => Promise<void>, launchConfirmedWindowHost?: (launch: any) => Promise<any>, observers?: any, dutyAdjudication?: any, redact?: (error: unknown) => string, liveLaunchContext?: any }} [dependencies]
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
  // (round-19) the live launch context: the driver's late-bound premises
  // read the facts THIS choreography establishes. ABSENT → null (the direct
  // research seams keep their existing behavior byte-identically).
  const liveLaunchContext = dependencies.liveLaunchContext ?? null;
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
  // The §41.5.1 registered hold duration: the validated session's
  // `workerDurationMs` (the CLI's frozen 420000) with the constant as the
  // default. The admission barrier enforces the observedAtMs + duration
  // derivation; the hold producer releases the completion gate exactly there.
  const holdDurationMs = Number.isSafeInteger(session.workerDurationMs) && session.workerDurationMs > 0
    ? session.workerDurationMs
    : CONFIRMED_WINDOW_HOLD_DURATION_MS;
  if (launchHost === null) {
    throw invalidControllerInput('the confirmed-window choreography requires an injected host launcher (the default real launcher composes one); an unlaunched run must never pretend to host contact.');
  }

  /** The runtime session facts; built ONLY from whitelisted-shaped fields (an untyped accumulator — the whitelisted projection is the typed boundary). */
  const facts = /** @type {any} */ ({
    source: 'same-host-rpc',
    host: { pid: null, argvDigest: null, startedAtMs: null, launchCount: 0 },
    rootInputs: [],
    identity: { parentThreadId: null, childThreadId: null, childTurnId: null, joinBasis: null, joinObservedAtMs: null, modelObserved: null, wrongJoins: [], joinHolds: false, childTurnActive: false },
    staging: { startedAtMs: null, descriptorPublicationObserved: null, liveReceiptObserved: null, spawnActivityObserved: null, childTerminalPreAdmission: null, continuationUsed: null, sendBoundaryControlExpired: null, sendBoundaryWindowClosed: null },
    window: {},
    nativeRequest: { threadId: null, turnId: null, sentAtMs: null, repliedAtMs: null, outcome: null, errorText: null, attemptCount: 0, responseWithinBound: null },
    receipt: {},
    fences: {},
    disposal: { connectionClosed: null, hostDisposed: null, teardownLabel: null, settlementManufactured: false },
    // (§41.5.1) the hold producer's NON-PERSISTED runtime facts (the
    // whitelisted projector drops this block; only the adjudicated verdict
    // persists — no version bump).
    hold: {
      armed: false,
      reason: null,
      gateDirectory: null,
      createdAtMs: null,
      holdDeadlineAtMs: null,
      gateReleasedAtMs: null,
      releaseBasis: null,
      releaseContent: null,
      completionGateReached: null,
      process: { identityEstablished: null, verifiedProcessTerminated: null, noWorkerBasis: null, workerAbsent: null, blockedWorkerSurvives: null, errorText: null },
      gateDirectoryRemoved: false,
      cleanupFailures: [],
      // (P2-1, 2026-11-19 codex re-review) the controller-clock instant the
      // NORMAL-path release was INITIATED (before the async gate write and
      // its read-back) — runtime-only, never projected: the write's async
      // completion can outlast the initiation instant, and the deadline the
      // release keeps is the initiation's.
      gateReleaseInitiatedAtMs: null,
    },
    // (P1-4, 2026-11-19 codex review) the §16.4 unrelated control's
    // POST-INTERRUPT survival adjudication — NON-PERSISTED runtime facts: the
    // verdict itself persists through the bounded duty adjudication (the
    // 'control-survival' additional name the §41.5.2 projection rule allows),
    // never as a raw field. `attempted` requires a CONSUMED post-delivery
    // collector result; `established` requires an active control with fresh
    // evidence at a post-delivery controller-clock read — merely invoking the
    // collector establishes nothing.
    controlSurvival: {
      attempted: false,
      established: false,
      readAtMs: /** @type {number | null} */ (null),
      refusedReason: /** @type {string | null} */ (null),
    },
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

  // (§41.5.1) the owned completion-gate producer. The gate directory is a
  // SIBLING of the private case output; its absence (no output dir) leaves
  // the producer unarmed and the route still runs (the offline seam).
  let holdGate = /** @type {any} */ (null);
  const safeReleaseHoldGate = async (/** @type {'normal-deadline' | 'cleanup'} */ basis) => {
    if (holdGate === null) return;
    try {
      await releaseConfirmedWindowHoldGate(holdGate, now, basis);
      facts.hold.gateReleasedAtMs = holdGate.releasedAtMs;
      facts.hold.releaseBasis = holdGate.releaseBasis;
      facts.hold.releaseContent = holdGate.releaseContent;
    } catch (error) {
      facts.hold.cleanupFailures.push(`the completion gate release failed (${basis}): ${redact(error)}`);
    }
  };
  // The NORMAL path releases EXACTLY at the registered hold deadline (never at
  // launch, never earlier). Cleanup releases immediately through
  // {@link finalizeSession} regardless of the deadline.
  const releaseHoldGateAtDeadline = async () => {
    if (holdGate === null || holdGate.releasedAtMs !== null) return;
    const deadline = safeStamp(facts.hold.holdDeadlineAtMs);
    if (deadline === null || now() < deadline) return;
    if (facts.hold.gateReleaseInitiatedAtMs === null) facts.hold.gateReleaseInitiatedAtMs = now();
    await safeReleaseHoldGate('normal-deadline');
  };

  const startedAtMs = now();
  const caseDeadlineAtMs = startedAtMs + Math.min(Number(session.budgetMs) || CONFIRMED_WINDOW_CASE_DEADLINE_MS, CONFIRMED_WINDOW_CASE_DEADLINE_MS);
  facts.fences.caseDeadlineAtMs = caseDeadlineAtMs;
  if (liveLaunchContext !== null) liveLaunchContext.caseDeadlineAtMs = caseDeadlineAtMs;

  let host = null;
  let connection = /** @type {any} */ (null);
  try {
    // §39.9 step 1: ONE owned host instance, ONE deadline, ONE connection.
    const composedArguments = composeConfirmedWindowHostArguments(session.fixture, session);
    facts.host.argvDigest = sha256Digest(JSON.stringify(composedArguments));
    // §41.5.1: create the owned gate BEFORE the ONE host launch and compose
    // its env into that launch. The gate file starts at `hold`; the fake
    // ZCode completion cannot arrive before the normal-path release at
    // observedAtMs + 420000 ms.
    holdGate = await createConfirmedWindowHoldGate(session.output, now);
    if (holdGate !== null) {
      facts.hold.armed = true;
      facts.hold.gateDirectory = holdGate.directory;
      facts.hold.createdAtMs = holdGate.createdAtMs;
    } else {
      facts.hold.reason = 'the private case output directory is not present; the hold producer is not armed';
    }
    if (liveLaunchContext !== null) {
      // (P1-2, round-19) the marker pair THIS launch env carries: both the
      // host AND the live collectors read it from the same owned context.
      liveLaunchContext.processMarkerPath = holdGate === null ? null : holdGate.processPath;
      liveLaunchContext.processMarkerNonce = holdGate === null ? null : holdGate.processNonce;
      // (P2-1, round-21 codex review) the PRODUCER'S OWN normalized gate
      // paths: the live collector reads the completion gate and its
      // completion-blocked sentinel from the same owned context — the actual
      // sibling paths THIS producer created, never a template derived from
      // the raw --output string (a valid trailing-slash output must never
      // point the collector inside the output directory).
      liveLaunchContext.completionGatePath = holdGate === null ? null : holdGate.gatePath;
      liveLaunchContext.completionGateReachedPath = holdGate === null ? null : holdGate.gateReachedPath;
    }
    const launchEnv = holdGate === null
      ? session.fixture.env
      : {
        ...session.fixture.env,
        FAKE_ZCODE_COMPLETION_GATE: holdGate.gatePath,
        FAKE_ZCODE_COMPLETION_GATE_REACHED: holdGate.gateReachedPath,
        FAKE_ZCODE_PROCESS_FILE: holdGate.processPath,
        FAKE_ZCODE_PROCESS_NONCE: holdGate.processNonce,
      };
    // (P2-7, round-23 codex review) the case deadline is RECHECKED at the
    // launch boundary itself: the clock started before the ASYNCHRONOUS gate
    // creation, and setup that consumes the remaining budget must not start
    // the host anyway (the expiry used to be noticed only before
    // `initialize`, after the counted case had already spent its launch).
    // An expired clock throws into the pre-launch cleanup path — the
    // deterministic disposal of the armed hold producer — and the ONE host
    // launch never happens on an expired clock.
    if (now() >= caseDeadlineAtMs) {
      throw new Error('the case deadline elapsed before the owned host launch (the pre-launch setup consumed the remaining budget; no host launches on an expired clock)');
    }
    host = await launchHost({
      codexBinary: session.codexBinary,
      codexHome: session.fixture.codexHome,
      workspace: session.fixture.workspace,
      env: launchEnv,
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
      // (P1-1, 2026-11-19 codex re-review) the fixture-only SANDBOX and
      // APPROVAL bypass rides the SAME boundary — the config spelling of the
      // exec route's `--dangerously-bypass-approvals-and-sandbox`
      // (CODEX_EXEC_COMMON_ARGUMENTS): `sandbox_mode: "danger-full-access"`
      // and `approval_policy: "never"`. Verified against the PINNED 0.163.0
      // binary itself (present at
      // /Users/zhangzikai/Workspace/Codes/tmp/rescue-settlement-trial/
      // codex-0.163.0/bin/codex, sha256
      // 8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31,
      // re-measured 2026-11-19: `codex exec --help` carries the combined
      // bypass flag and the sandbox values read-only | workspace-write |
      // danger-full-access) and against the codex-rs source
      // (`protocol/src/config_types.rs` SandboxMode serde values;
      // `protocol/src/protocol.rs` AskForApproval (kebab-case) includes
      // "never"; `config/src/config_toml.rs` keys `sandbox_mode` (:224) and
      // `approval_policy` (:195); `app-server/src/config_manager.rs`
      // `load_with_cli_overrides` chains every non-bypass request-override
      // key into the standard CLI-override (−c) path, so these ride exactly
      // as `-c sandbox_mode=danger-full-access -c approval_policy=never`).
      // Without them the fresh fixture home has no trusted-project override
      // and preparation/launcher writes can demand approvals this protocol
      // client never answers.
      // (Record correction, 2026-11-19, root-verified: an earlier draft of
      // this comment claimed the 0.163.0 pin was no longer on disk — FALSE;
      // the trial copy above is present and hash-verified. The one
      // supplementary exec-help reading taken from the 0.167.0 release
      // binary during that draft is superseded by the pinned-binary
      // verification recorded here.)
      config: {
        bypass_hook_trust: true,
        sandbox_mode: 'danger-full-access',
        approval_policy: 'never',
      },
      ...(session.model !== null && session.model !== undefined ? { model: session.model } : {}),
    });
    const parentThreadId = boundedThreadId(threadStart?.result?.thread?.id) ?? boundedThreadId(threadStart?.result?.threadId);
    if (parentThreadId === null) throw new Error('the owned host reply carried no bounded parent thread identity');
    facts.identity.parentThreadId = parentThreadId;
    // (P1-3, round-19) the controller's OWN Root identity — the live
    // collectors' owner/durable premises read it from the launch context,
    // never the fake Companion peer's internal session id.
    if (liveLaunchContext !== null) liveLaunchContext.rootThreadId = parentThreadId;
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
    // (P2-2, round-20 codex re-review) the TORN-ROW signature: a Root or
    // Child rollout caught MID-APPEND rejects through the qualification
    // reader's CodexRescueEvidenceMismatchError with code 'rollout-json-invalid'
    // (parseCodexRolloutJsonl's `A rollout record is not valid JSON.` — the
    // exact class and code loadShellWaitRollouts rejects with, so the retry
    // distinguishes a mid-append partial row from genuine corruption by the
    // error's own typed signature, never free-form message matching).
    const isTransientRolloutParseRejection = (/** @type {any} */ error) => error !== null && typeof error === 'object'
      && error.name === 'CodexRescueEvidenceMismatchError' && error.code === 'rollout-json-invalid';
    // (P2-2, round-20) the persistent-corruption cap: the SAME corrupt
    // content across this many consecutive reads never healed — the named
    // refusal fails the counted case closed.
    const STAGING_TORN_READ_MAX_CONSECUTIVE = 3;
    /** @type {WeakMap<any, number>} */
    const tornRolloutReadCounts = new WeakMap();
    /** @param {any} collector @param {() => any} missingShape @param {string} timeoutReason @param {number} boundAtMs @returns {Promise<any>} */
    const boundedObserver = async (collector, missingShape, timeoutReason, boundAtMs) => {
      if (typeof collector !== 'function') {
        // The controller's own placeholder for an unarmed collector is NOT a
        // collector fact: it carries no clock tag and no stamps (§41.5.2's
        // tag contract applies to actual collector returns only).
        const shape = missingShape();
        shape.controllerPlaceholder = true;
        return shape;
      }
      const bound = Math.min(boundAtMs, caseDeadlineAtMs);
      for (;;) {
        const guarded = Promise.resolve().then(collector);
        guarded.catch(() => { /* the race owns the outcome */ });
        let value;
        try {
          value = await Promise.race([guarded, waitUntil(bound).then(() => OBSERVER_TIMEOUT)]);
        } catch (collectorError) {
          // (P2-2, round-20 codex re-review) a TRANSIENT partial read is an
          // UNCONFIRMED barrier sample — the counted case does NOT end here:
          // the collector is retried at the passive-read cadence (a healing
          // append resolves on a later read). Only the pinned torn-row
          // signature retries; every OTHER rejection keeps escaping to the
          // redact seam exactly as before.
          if (isTransientRolloutParseRejection(collectorError) !== true) throw collectorError;
          const consecutive = (tornRolloutReadCounts.get(collector) ?? 0) + 1;
          tornRolloutReadCounts.set(collector, consecutive);
          // PERSISTENT corruption — the same corrupt content across the
          // bounded consecutive reads, or the staging deadline passing with
          // the corruption unresolved — fails closed with the NAMED
          // refusal (never a silent hang, never a guessed conjunct).
          if (consecutive >= STAGING_TORN_READ_MAX_CONSECUTIVE || now() >= bound) {
            throw new Error(`the staging rollout read stayed corrupt across ${String(consecutive)} consecutive reads${now() >= bound ? ' past the staging deadline' : ''} (persistent rollout corruption — a torn JSONL row that never healed; the counted case refuses)`);
          }
          await sleep(CONFIRMED_WINDOW_PASSIVE_READ_FLOOR_MS);
          continue;
        }
        // A resolving read resets the consecutive-corruption count (the
        // append healed); the sample is the confirmed collector fact.
        tornRolloutReadCounts.delete(collector);
        if (value === OBSERVER_TIMEOUT) {
          const shape = missingShape();
          shape.timedOut = true;
          shape.reason = timeoutReason;
          shape.controllerPlaceholder = true;
          return shape;
        }
        return value;
      }
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
    // (P1-4, 2026-11-19 codex review) the §16.4 post-interrupt survival
    // adjudication: every CONSUMED control read made AFTER the single
    // delivery was initiated adjudicates the unrelated control's survival.
    // Establishing requires an ACTIVE control with fresh evidence (freshAtMs
    // and a declared lifetime) at that post-delivery read — a timed-out,
    // placeholder, inactive or dead read establishes NOTHING, and the first
    // non-establishing read names its reason. Merely invoking the collector
    // is never survival (§16.4: buffered output is not survival).
    // (P1-4, 2026-11-19 codex re-review) the fresh evidence must also be
    // CAUSALLY POST-delivery: (a) the read instant may not predate the
    // delivery's initiation, and (b) the fresh stamp must POSTDATE the
    // delivery initiation (post-interrupt progress) AND sit within the
    // passive-read cadence of the read (fresh AT the read, §41.5.2 bound
    // (b)-style). Rereading buffered PRE-delivery evidence — a collector
    // retaining its last pre-interrupt line — establishes NOTHING.
    let deliveryInitiatedAtMs = /** @type {number | null} */ (null);
    // (P1-1, round-22 codex review) the SETTLED-DELIVERY bound the survival
    // gate anchors on: the LATER of the Child's resolution and the original
    // observation's resolution — BOTH legs must settle (a missing leg or a
    // missing leg stamp leaves the bound UNESTABLISHED, fail closed). The
    // legs are declared later in this scope; every call of the survival
    // adjudication happens after those declarations execute (the collection
    // loops), so reading them through this lazily-evaluated helper is safe.
    // The bound is recomputed at EVERY consumed control read — a leg landing
    // mid-phase updates the bound the very next read sees, never a stale one.
    const settledDeliveryBoundAtMs = () => {
      if (childResolution === null || observationResolved !== true) return null;
      const childAtMs = safeStamp(childResolution.atMs);
      const observationAtMs = safeStamp(observationResolvedAtMs);
      if (childAtMs === null || observationAtMs === null) return null;
      return Math.max(childAtMs, observationAtMs);
    };
    const adjudicateControlSurvivalRead = (/** @type {any} */ readResult) => {
      if (readResult === null || readResult === undefined) return;
      if (readResult.controllerPlaceholder === true || readResult.timedOut === true) {
        if (facts.controlSurvival.refusedReason === null) {
          facts.controlSurvival.refusedReason = readResult.timedOut === true
            ? 'the post-delivery control read did not answer before its bound (survival is never established from an unanswered read)'
            : 'the control collector is not armed post-delivery (the no-collateral duty is mandatory)';
        }
        return;
      }
      facts.controlSurvival.attempted = true;
      // (P1-3, round-21 codex review) the OVERLAPPING SAME-TARGET model-tool
      // interrupt: the post-delivery control read carries the collector's
      // competing-delivery fact — an interrupt-shaped model-tool call on the
      // SAME joined Child (or a target that cannot be proven different)
      // that was not affirmatively rejected. The receipt LATCHES it before
      // any stamp validation (the fact is a source-class attribution, not a
      // stamp): the Child's interrupted terminal event is then not
      // attributable to the controller's RPC ALONE, and the replay names
      // the ambiguity — same-host-rpc settlement is never silently credited.
      if (readResult.sameTargetModelToolInterrupt === true) {
        facts.receipt.sameTargetModelToolInterrupt = true;
      }
      // (P2, round-9 re-review) the post-delivery read is validated on the
      // controller clock BEFORE any survival credit — the barrier's own
      // §41.5.2 admission rule applies to EVERY consumed collector read,
      // never only the pre-delivery one: a collector fact that declares a
      // FOREIGN clock domain is refused before any stamp arithmetic (the
      // domain tag must be `controller-monotonic`), and a PRESENT stamp that
      // exceeds the read instant (a future freshAtMs or a future emission
      // stamp) is a clock-bounds violation — neither shape ever adds
      // survival credit.
      if (hasForeignClockDomain(readResult)) {
        if (facts.controlSurvival.established !== true && facts.controlSurvival.refusedReason === null) {
          facts.controlSurvival.refusedReason = 'the post-delivery control read carries a foreign clock domain (clock-domain-mismatch): every collector-visible stamp must be produced on the controller-monotonic clock, and the fact is refused BEFORE any stamp arithmetic';
        }
        return;
      }
      const freshAtMs = safeStamp(readResult.freshAtMs);
      const readAtMs = now();
      const emittedAtControllerMs = safeStamp(readResult.emittedAtControllerMs);
      const futureStampViolation = (freshAtMs !== null && freshAtMs > readAtMs)
        || (emittedAtControllerMs !== null && emittedAtControllerMs > readAtMs);
      if (futureStampViolation === true) {
        if (facts.controlSurvival.established !== true && facts.controlSurvival.refusedReason === null) {
          facts.controlSurvival.refusedReason = `the post-delivery control read carries a stamp that exceeds the read instant (clock-bounds-violation): fresh at ${String(freshAtMs)} and emitted at ${String(emittedAtControllerMs)} vs the read instant ${String(readAtMs)} — a future stamp is never fresh post-delivery evidence`;
        }
        return;
      }
      const freshAtRead = freshAtMs !== null && readAtMs - freshAtMs <= CONFIRMED_WINDOW_PASSIVE_READ_FLOOR_MS;
      // (P1-1, 2026-11-19 codex re-review) the causal gate is the EMISSION
      // instant, never the collection stamp: the live collector exposes the
      // newest line's emission on the controller clock
      // (emittedAtControllerMs = the collection instant minus the
      // launch-epoch-anchored age), and survival requires an emission
      // STRICTLY after the delivery initiation — a line EMITTED before the
      // interrupt and COLLECTED after it proves nothing about
      // post-interruption survival (the old freshAtMs-based gate credited
      // exactly that shape).
      const emittedAfterDelivery = emittedAtControllerMs !== null && deliveryInitiatedAtMs !== null
        && emittedAtControllerMs > deliveryInitiatedAtMs;
      // (P1-1, round-22 codex review) the registered control contract anchors
      // the survival emission on the SETTLED-DELIVERY bound — the LATER of
      // the Child's resolution and the original observation's resolution —
      // never the dispatch instant alone: a line emitted after the send but
      // before EITHER leg resolved proves nothing about the control's
      // survival of the SETTLED interruption, and the bound stays
      // unestablished (fail closed) until BOTH legs settle with their own
      // stamps. The send timestamp KEEPS its role for the pending-window
      // admission and the record's request bounds — only the survival
      // emission gate moves to the settled bound.
      const settledBoundAtMs = settledDeliveryBoundAtMs();
      const emittedAfterSettledDelivery = settledBoundAtMs !== null && emittedAtControllerMs !== null
        && emittedAtControllerMs > settledBoundAtMs;
      const established = readResult.active === true && freshAtMs !== null && safeStamp(readResult.declaredLifetimeMs) !== null
        && freshAtRead === true && emittedAfterDelivery === true && emittedAfterSettledDelivery === true;
      if (established === true) {
        if (facts.controlSurvival.established !== true) {
          facts.controlSurvival.established = true;
          facts.controlSurvival.readAtMs = readAtMs;
          facts.controlSurvival.refusedReason = null;
        }
        return;
      }
      // (P1-1, 2026-11-19 codex re-review) survival credit is a CONJUNCTION
      // over the whole post-delivery window, never a one-shot latch: a
      // post-establishment read that observes the control's PREMATURE/
      // ABNORMAL exit (an inactive read whose structured end is anything but
      // the designed natural completion) REVOKES the verdict — the
      // no-collateral credit cannot stand over a window in which the control
      // demonstrably died. The DESIGNED natural completion (line 60) ends
      // the lifecycle as designed and preserves the credit.
      if (facts.controlSurvival.established === true && readResult.active !== true && readResult.ended !== 'designed-end') {
        facts.controlSurvival.established = false;
        facts.controlSurvival.readAtMs = null;
        facts.controlSurvival.refusedReason = `the control exited PREMATURELY after the interrupt (the observed end is not the designed completion): the no-collateral credit is REVOKED — ${boundedErrorText(readResult.reason ?? 'an abnormal control exit was observed inside the post-delivery window')}`;
        return;
      }
      if (facts.controlSurvival.established !== true && facts.controlSurvival.refusedReason === null) {
        // An INACTIVE read keeps the collector's own named reason (the
        // observed death) — the emission analysis below applies to ACTIVE
        // reads whose survival credit is in question.
        facts.controlSurvival.refusedReason = readResult.active !== true
          ? boundedErrorText(readResult.reason ?? 'the post-delivery control read did not observe an active control')
          : settledBoundAtMs !== null && emittedAfterSettledDelivery === false
            ? `the control's fresh evidence was EMITTED before the SETTLED delivery (emitted at ${String(emittedAtControllerMs)} vs the settled-delivery bound ${String(settledBoundAtMs)}, the later of the Child's resolution and the observation's resolution): survival requires an emission after BOTH resolution legs settled, never merely after the dispatch`
            : settledBoundAtMs === null
              ? 'the settled-delivery bound is not established (BOTH resolution legs — the Child\'s resolution and the observation\'s resolution — must settle before any survival credit): an emission after the dispatch alone proves nothing about the settled interruption'
              : emittedAtControllerMs !== null && emittedAfterDelivery === false
                ? `the control's fresh evidence was EMITTED before the delivery (emitted at ${String(emittedAtControllerMs)} vs delivery initiated at ${String(deliveryInitiatedAtMs)}): a line collected after the interrupt but emitted before it never establishes post-interrupt survival`
                : emittedAtControllerMs === null
                  ? 'the control emission instant is unprovable at the read (no launch-epoch-anchored emission evidence): post-interruption survival is never credited from a collection stamp alone'
                  : freshAtMs !== null && freshAtRead === false
                    ? `the control's fresh evidence is stale at the read (fresh at ${String(freshAtMs)}, read at ${String(readAtMs)}): survival requires fresh evidence within the passive-read cadence`
                    : boundedErrorText(readResult.reason ?? 'the post-delivery control read did not establish an active control with fresh evidence');
      }
    };
    // (P2-1 + P2-2, 2026-11-19 codex re-reviews) the COLLECTION READ bound:
    // the caller's deadline (cutoff/horizon), but WOKEN EARLIER at the
    // unreleased hold deadline — EVERY blocking collection read (pending,
    // duty, control) carries it, because the release wakeup cannot preempt
    // an awaited collector: a read that stalls across the registered release
    // time yields its slot at that deadline (the read result is never
    // abandoned: the collector keeps running and the next floor tick
    // re-reads it), so the deadline-driven gate release never waits behind a
    // stalled collector of ANY kind.
    const collectionReadBoundAtMs = (/** @type {number} */ boundAtMs) => {
      if (holdGate === null || holdGate.releasedAtMs !== null) return boundAtMs;
      const holdDeadline = safeStamp(facts.hold.holdDeadlineAtMs);
      return holdDeadline === null ? boundAtMs : Math.min(boundAtMs, holdDeadline);
    };
    /** One bounded post-delivery control read + its survival adjudication. */
    const readControlForSurvival = async (/** @type {number} */ boundAtMs) => {
      if (typeof observers.controlFacts !== 'function') return;
      try {
        const control = await boundedCollectionRead(observers.controlFacts, boundAtMs);
        adjudicateControlSurvivalRead(control);
      } catch (collectorError) {
        // (round-2 P2) the SAME redaction boundary as every other persisted
        // failure text; the survival verdict stays unestablished.
        if (facts.controlSurvival.refusedReason === null && facts.controlSurvival.established !== true) {
          facts.controlSurvival.refusedReason = `the post-delivery control read failed: ${redact(collectorError)}`;
        }
      }
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
      // (P2-6, round-19) the barrier's duty read counts toward the SAME
      // shared durable-read cap (one counter, every phase).
      if (liveLaunchContext !== null && liveLaunchContext.durableReadAttempts < CONFIRMED_WINDOW_DUTY_READ_MAX_ATTEMPTS) {
        liveLaunchContext.durableReadAttempts += 1;
      }
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
      // (§41.5.2, frozen enforcement order) the closed domain tag is checked
      // FIRST — before the freshness/lifetime arithmetic below and before the
      // numeric admission bounds: a fact carrying a foreign clock base is
      // refused by name, never compared.
      const clockDomainMismatch = [pending, ancestry, duties, control].some(hasForeignClockDomain);
      const controlFresh = clockDomainMismatch === true ? false
        : safeStamp(control?.freshAtMs) !== null
          && evaluatedAtMs - (/** @type {number} */ (safeStamp(control?.freshAtMs))) <= CONFIRMED_WINDOW_PASSIVE_READ_FLOOR_MS;
      const controlLifetimeSufficient = clockDomainMismatch === true ? false
        : safeStamp(control?.freshAtMs) !== null && safeStamp(control?.declaredLifetimeMs) !== null
          && (/** @type {number} */ (safeStamp(control?.freshAtMs))) + (/** @type {number} */ (safeStamp(control?.declaredLifetimeMs))) > evaluatedAtMs;
      // (§41.5.2) the numeric admission bounds (a)–(e), AFTER the existing
      // freshness/lifetime predicates so the frozen `/fresh/`/`/lifetime/`
      // negatives keep their semantics.
      const clockBoundsViolation = clockDomainMismatch === true
        ? null
        : admissionClockBoundsViolation({ pending, control }, evaluatedAtMs, caseDeadlineAtMs, holdDurationMs);
      const clockRefusal = clockDomainMismatch === true || clockBoundsViolation !== null;
      // (P1-2, 2026-11-20 round-21 codex review) the REGISTERED PRE-DELIVERY
      // CONTROL READS: the frozen §41 schedule's two-read sequence the prompt
      // tells the Root to perform — a read REACHING LINE 40 (the readiness
      // floor) in an EARLIER read, and a SEPARATE FRESH post-floor read at
      // the send boundary. The controller verifies BOTH ordered reads from
      // the collector's own read-event extraction: a fresh early line below
      // the floor, or a single floor read with no separate fresh read after
      // it, never spends the only turn/interrupt attempt.
      const controlLineIndex = safeStamp(control?.lineIndex);
      const controlPreDeliveryReadsObserved = controlLineIndex !== null
        && controlLineIndex >= SURVIVAL_CONTROL_READINESS_FLOOR_LINE_INDEX
        && control?.preDeliveryReadSequence?.floorReachedInEarlierRead === true
        && control?.preDeliveryReadSequence?.separatePostFloorFreshRead === true;
      // (P2-2, 2026-11-19 codex review) the MANDATORY baseline check: every
      // registered applicable duty slot (the frozen seven-slot set) must be
      // present in the collector's named baselines BEFORE any delivery — a
      // boolean `observable` beside a partial name list can never consume
      // the bounded case.
      const dutyBaselinesComplete = clockDomainMismatch === false
        && Array.isArray(duties?.duties)
        && REQUIRED_CONFIRMED_WINDOW_DUTY_SLOTS.every((slot) => duties.duties.includes(slot));
      return {
        pending, ancestry, duties, control,
        // The barrier's own evaluation instant — the freshness/lifetime
        // arithmetic below (and the named miss reasons) anchor on the
        // POST-COLLECTION time, not the pre-read stamp.
        atMs: evaluatedAtMs,
        clockDomainMismatch,
        clockBoundsViolation,
        dutyBaselinesComplete,
        // (round-3 P2-1) the operative window requires an observation that is
        // STILL pending: an already-resolved observation is history, never
        // the pending ORIGINAL observation the conjunct requires.
        operativeWindow: clockRefusal === false && safeStamp(pending?.holdDeadlineAtMs) !== null && pending.confirmed === true && pending.resolved !== true,
        // (P2-4, 2026-11-18 codex gate round) the control conjunct carries its
        // REQUIRED evidence: fresh data (no older than the passive-read
        // cadence — the §3 Task-3 schedule constant) AND a declared lifetime
        // that is still sufficient AT REQUEST. An observer returning only
        // `{active: true}` never satisfied the §40.4 admission predicate.
        controlFresh,
        controlLifetimeSufficient,
        // (P1-2, round-21 codex review) the registered two-read pre-delivery
        // sequence — the send gate's own conjunct.
        controlPreDeliveryReadsObserved,
        // The §39.9 step 6 conjunct order: real Child/turn authority is the
        // join (checked before the barrier runs); the barrier itself requires
        // the pending ORIGINAL observation (confirmed and NOT already
        // resolved), the ancestry baseline, the observable duties with ALL
        // mandatory baseline slots present, the active control with fresh
        // evidence and a sufficient declared lifetime AND a hold deadline
        // that is present and still in the future (the operative measurement
        // window).
        holds: clockRefusal === false && pending.confirmed === true && pending.resolved !== true && ancestry.established === true && duties.observable === true && dutyBaselinesComplete === true && control.active === true
          && controlFresh === true && controlLifetimeSufficient === true && controlPreDeliveryReadsObserved === true
          && safeStamp(pending?.holdDeadlineAtMs) !== null
          && (/** @type {number} */ (safeStamp(pending?.holdDeadlineAtMs))) > now(),
      };
    };
    const barrierMissReason = (/** @type {any} */ evaluation) => {
      if (!evaluation) return 'the positive barrier was never evaluated';
      // (§41.5.2) the frozen order: the domain tag first ...
      if (evaluation.clockDomainMismatch === true) return `a collector fact carries a foreign clock domain (clock-domain-mismatch): every collector-visible stamp must be produced on the controller-monotonic clock, and the fact is refused BEFORE any stamp arithmetic`;
      if (evaluation.pending.confirmed !== true) return `the pending ORIGINAL observation never confirmed (${boundedErrorText(evaluation.pending.reason ?? 'collector reported unconfirmed')})`;
      if (evaluation.ancestry.established !== true) return `the generation/ancestry baseline never held (${boundedErrorText(evaluation.ancestry.reason ?? 'collector reported unestablished')})`;
      if (evaluation.duties.observable !== true) return `the applicable duties were never observable (${boundedErrorText(evaluation.duties.reason ?? 'collector reported unobservable')})`;
      // (P2-2, 2026-11-19 codex review) the mandatory baseline completeness —
      // a boolean observable beside a partial name list never admits.
      if (evaluation.dutyBaselinesComplete !== true) {
        const missingSlots = REQUIRED_CONFIRMED_WINDOW_DUTY_SLOTS.filter((slot) => !Array.isArray(evaluation.duties?.duties) || !evaluation.duties.duties.includes(slot));
        return `the mandatory duty baselines were incomplete (missing: ${missingSlots.join(', ')}) — incomplete instrumentation can never consume the bounded case`;
      }
      if (evaluation.control.active !== true) return `the unrelated control was never active with fresh data (${boundedErrorText(evaluation.control.reason ?? 'collector reported inactive')})`;
      if (evaluation.controlFresh !== true) return `the unrelated control had no fresh evidence at admission (freshness within the ${String(CONFIRMED_WINDOW_PASSIVE_READ_FLOOR_MS)} ms passive-read cadence is required; actual ${boundedErrorText(evaluation.control.reason ?? 'no freshness stamp rode the control facts')})`;
      if (evaluation.controlLifetimeSufficient !== true) return `the unrelated control's declared lifetime was absent or exhausted at request (a lifetime covering the admission instant is required)`;
      // (P1-2, round-21 codex review) the registered TWO-READ sequence is its
      // own named miss: the control may be active and fresh, but a line index
      // still below the readiness floor — or a floor reached only in the
      // send-boundary read with no separate fresh read after it — never
      // spends the only turn/interrupt attempt.
      if (evaluation.controlPreDeliveryReadsObserved !== true) {
        const actualLineIndex = safeStamp(evaluation.control?.lineIndex);
        return `the registered pre-delivery control reads were never observed (the frozen §41 schedule requires the control's line index to reach ${String(SURVIVAL_CONTROL_READINESS_FLOOR_LINE_INDEX)} in an EARLIER read and a SEPARATE fresh post-floor read at the send boundary; actual line index ${actualLineIndex === null ? 'unobserved' : String(actualLineIndex)}, floor reached in an earlier read: ${String(evaluation.control?.preDeliveryReadSequence?.floorReachedInEarlierRead === true)}, separate fresh post-floor read: ${String(evaluation.control?.preDeliveryReadSequence?.separatePostFloorFreshRead === true)}) — a fresh early line below the floor never spends the only interrupt attempt`;
      }
      // ... then the new numeric bounds ...
      if (evaluation.clockBoundsViolation !== null) return `the admission clock bounds were violated (clock-bounds-violation): ${boundedErrorText(evaluation.clockBoundsViolation)}`;
      // ... then the existing late conjuncts.
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
    /** @type {any} */
    let evaluation = null;
    // (F2) Child turn/started events that arrived before their parent's
    // SubAgentActivity: buffered by thread id so the order-free §39.3 join
    // completes whenever the matching side arrives. Each buffered entry also
    // tracks the turn's own completion (P2-3): an unmatched start whose
    // completion arrived before the activity side is TERMINAL — the join
    // completes the identity but never resurrects a stale target.
    /** @type {{ threadId: string, turnId: string | null, turnStartedAtMs: number | null, atMs: number | null, completedAtMs: number | null, terminalStatus: string | null }[]} */
    const unmatchedChildTurnStarts = [];
    // (P2-3, 2026-11-19 codex review) the staging event handler, extracted
    // verbatim from the loop body so the PRE-ADMISSION DRAIN processes
    // available queued lifecycle notifications with the EXACT same
    // semantics as the main loop (no drained event is ever lost or
    // differently interpreted). Directives: 'processed' (ordinary state
    // accumulation), 'child-terminal' (the target turn reached terminal —
    // admission must be vetoed), 'parent-completed' (the staging parent turn
    // ended — the loop runs the §40.4 final-evaluation/continuation block).
    /** @returns {'processed' | 'child-terminal' | 'parent-completed'} */
    const handleStagingEvent = (/** @type {any} */ event) => {
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
        return 'processed';
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
          return 'processed';
        }
        // (round-2 P2) the parent side of the join requires the EXACT
        // observed parent identity: a missing or malformed threadId is never
        // accepted (null never bypasses the parent match) — a parentless
        // started activity is a named wrong join, never the join side and
        // never spawn evidence.
        if (eventThreadId !== facts.identity.parentThreadId) {
          facts.identity.wrongJoins.push({ kind: eventThreadId === null ? 'unidentified-parent-thread' : 'wrong-parent-thread', atMs: safeStamp(event.receivedAtMs) });
          return 'processed';
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
            // (P1-3, round-19) the controller's own EXACT joined Child id —
            // the live collectors' observation premise reads it from the
            // launch context (never a guessed or peer-internal id).
            if (liveLaunchContext !== null) {
              liveLaunchContext.childThreadId = agentThreadId;
              liveLaunchContext.expectedExecutorAgentId = agentThreadId;
            }
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
                return 'child-terminal';
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
        return 'processed';
      } else if (type === 'turn/started') {
        const turnId = boundedThreadId(params.turn?.id) ?? boundedThreadId(params.turnId);
        if (eventThreadId !== null && eventThreadId === facts.identity.parentThreadId) {
          return 'processed'; // the parent's own staging turn opening
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
          return 'processed';
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
          return 'processed';
        } else if (eventThreadId !== null && eventThreadId !== facts.identity.childThreadId) {
          facts.identity.wrongJoins.push({ kind: 'wrong-child-thread', atMs: safeStamp(event.receivedAtMs) });
        }
        return 'processed';
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
          return 'child-terminal';
        }
        if (eventThreadId !== null && eventThreadId === facts.identity.parentThreadId) {
          // The staging turn ended: the §40.4 final-evaluation/continuation
          // block runs in the LOOP (it escalates — evaluation, admission,
          // continuation — and owns the loop control flow).
          return 'parent-completed';
        }
        return 'processed';
      }
      return 'processed';
    };
    // (P2-3) the bounded NON-BLOCKING drain of AVAILABLE queued lifecycle
    // notifications: a terminal that arrived behind the last consumed event
    // (accumulated during setup or async collector reads) is processed
    // through the SAME handler and revalidates the exact active turn BEFORE
    // the single attempt is ever sent.
    const MAX_ADMISSION_DRAIN_EVENTS = 64;
    // (P2-1, 2026-11-19 codex re-review) the drain CONTINUES past a parent
    // completion: the parent's own event is recorded (the §40.4 held-window
    // admission note rides the evaluation this site ran) but the drain keeps
    // going so a Child terminal or a conflicting started activity QUEUED
    // BEHIND the parent completion still vetoes the delivery — a partially
    // drained queue is never treated as acceptable.
    /** @returns {Promise<{ directive: 'clear' | 'child-terminal' | 'incomplete', parentCompleted: boolean }>} */
    const drainQueuedLifecycleEvents = async () => {
      let parentCompleted = false;
      for (let drained = 0; drained < MAX_ADMISSION_DRAIN_EVENTS; drained += 1) {
        const queued = await connection.nextNotification(now());
        if (queued === null) return { directive: 'clear', parentCompleted };
        const directive = handleStagingEvent(queued);
        if (directive === 'parent-completed') {
          parentCompleted = true;
          continue;
        }
        if (directive !== 'processed') return { directive, parentCompleted };
      }
      // (P2-3, 2026-11-19 codex re-review) reaching the event cap is the
      // named INCOMPLETE-drain fact — the queued lifecycle evidence behind
      // the cap was never examined and is NEVER certified clear.
      return { directive: 'incomplete', parentCompleted };
    };
    // (P2-3) the pre-admission revalidation shared by EVERY admission site:
    // the deadline recheck (round-2 P1), then the queued-event drain. A
    // queued child terminal vetoes the admission BY NAME without consuming
    // the attempt; an INCOMPLETE drain (the event cap reached) vetoes the
    // same way — queued lifecycle evidence is never certified clear; a
    // queued parent completion admits the held window on the evaluation this
    // site just ran (§40.4: the window does not end with the parent's turn —
    // its final evaluation is the one this site ran).
    // (P2-2, 2026-11-19 codex re-review) after the drain, the COMPLETE
    // identity/active-turn predicate is RECHECKED before any delivery: the
    // drain's own event processing may have set joinAmbiguous (a conflicting
    // started activity arriving during the collector reads) or ended the
    // active turn — a barrier evaluation that predates the drain can never
    // admit on stale identity evidence.
    /** @returns {Promise<'admitted' | 'closed'>} */
    const admitAfterDrainRevalidation = async (/** @type {number} */ deadline) => {
      // (P1-2, round-18 re-review) the diagnostic sentinel read moved BEFORE
      // the final revalidation: the read's result must never sit between the
      // last admission checks and the send — a Child completion that queues,
      // or a staging-deadline or control-freshness expiry that lands while
      // the read is pending, is seen by the checks that follow it, so the
      // positive barrier still holds AT delivery.
      if (holdGate !== null) {
        const reached = await readFile(holdGate.gateReachedPath, 'utf8').catch(() => '');
        facts.hold.completionGateReached = reached.trim() === 'blocked';
      }
      if (now() >= deadline) {
        return 'closed';
      }
      const drained = await drainQueuedLifecycleEvents();
      if (drained.directive === 'child-terminal') {
        facts.staging.childTerminalPreAdmission = true;
        facts.identity.childTurnActive = false;
        facts.staging.preAdmissionDrainVeto = true;
        return 'closed';
      }
      if (drained.directive === 'incomplete') {
        facts.staging.preAdmissionDrainIncomplete = true;
        return 'closed';
      }
      if (facts.identity.joinHolds !== true || facts.identity.joinAmbiguous === true || facts.identity.childTurnActive !== true) {
        return 'closed';
      }
      // (P1-5, round-19 re-review) the TIME-SENSITIVE conjuncts are RECHECKED
      // here — AT the send boundary: the barrier evaluated control freshness
      // and remaining lifetime BEFORE the sentinel read and the drain, and a
      // control sample at the 1000-ms freshness limit can expire during that
      // read. The send-boundary instant is the controller's own clock, and
      // the latest control facts the barrier collected are re-validated
      // against it — an expired or exhausted control refuses the delivery
      // (closed), never sends on stale bounds.
      if (evaluation !== null && typeof evaluation === 'object') {
        const sendBoundaryAtMs = now();
        const controlFreshAtMs = safeStamp(evaluation.control?.freshAtMs);
        const controlLifetimeMs = safeStamp(evaluation.control?.declaredLifetimeMs);
        if (controlFreshAtMs !== null && sendBoundaryAtMs - controlFreshAtMs > CONFIRMED_WINDOW_PASSIVE_READ_FLOOR_MS) {
          facts.staging.sendBoundaryControlExpired = true;
          return 'closed';
        }
        if (controlFreshAtMs !== null && controlLifetimeMs !== null && controlFreshAtMs + controlLifetimeMs <= sendBoundaryAtMs) {
          facts.staging.sendBoundaryControlExpired = true;
          return 'closed';
        }
        const holdDeadlineAtMs = safeStamp(evaluation.pending?.holdDeadlineAtMs);
        if (holdDeadlineAtMs !== null && holdDeadlineAtMs <= sendBoundaryAtMs) {
          facts.staging.sendBoundaryWindowClosed = true;
          return 'closed';
        }
      }
      // A parent completion found by the drain admits the held window on the
      // evaluation this site just ran (§40.4: the window does not end with
      // the parent's turn) — AFTER the full drain, so queued terminals or
      // conflicts behind it have already had their veto.
      return 'admitted';
    };
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
            // (round-2 P1 + P2-3) the deadline recheck AND the queued-event
            // drain run before any delivery.
            if (await admitAfterDrainRevalidation(deadline) === 'admitted') {
              admitted = true;
              break;
            }
            stagingClosed = true;
            break;
          }
        }
        continue;
      }
      const directive = handleStagingEvent(event);
      if (directive === 'child-terminal') {
        stagingClosed = true;
        break;
      }
      if (directive === 'parent-completed') {
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
            // (round-2 P1 + P2-3) the same post-observer deadline recheck
            // and queued-event drain before any delivery.
            if (await admitAfterDrainRevalidation(deadline) === 'admitted') {
              admitted = true;
              break;
            }
            stagingClosed = true;
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
        // (P1-3, round-20 codex re-review) the lifecycle queue is drained and
        // the identity RECHECKED BEFORE the no-spawn decision: a Root
        // completion dequeued ahead of an ALREADY-QUEUED started activity
        // leaves childThreadId still null at this point — an UNDRAINED queue
        // is never proof of Child absence, and firing the continuation's
        // second spawn instruction with the first Child already queued
        // would create a second Child and pollute the identity. The
        // continuation fires only when the drained queue shows NO Child
        // evidence; a child-terminal or an INCOMPLETE drain (the event cap
        // reached — the queued lifecycle evidence behind the cap was never
        // examined) closes staging honestly instead.
        const drainedNoSpawn = await drainQueuedLifecycleEvents();
        if (drainedNoSpawn.directive === 'child-terminal' || drainedNoSpawn.directive === 'incomplete') {
          stagingClosed = true;
          break;
        }
        // (P2, round-11 re-review) the no-spawn correction continuation is
        // authorized ONLY when NO Child has been observed (§39.9: the ONE
        // changed continuation corrects a turn that produced NO qualifying
        // Child). With a KNOWN childThreadId the Child EXISTS — whether it
        // was bound before this completion or REVEALED by the drain above,
        // the join is merely incomplete (e.g. the Child's own turn/started
        // still queued behind the parent's completion): if the drain
        // completed the join, run the §40.4-style final positive-barrier
        // evaluation; otherwise staging keeps waiting within its deadline
        // for the Child's own evidence. Requesting ANOTHER spawn with a
        // Child already known would create a second Child and make the
        // identity ambiguous — it is never sent.
        if (facts.identity.childThreadId !== null) {
          if (facts.identity.joinHolds === true && facts.identity.joinAmbiguous !== true && facts.identity.childTurnActive === true) {
            const readyAtMs = lastBarrierEvaluationAtMs + CONFIRMED_WINDOW_PASSIVE_READ_FLOOR_MS;
            if (now() < readyAtMs && readyAtMs < deadline) {
              await sleep(readyAtMs - now());
            }
            evaluation = await barrier();
            if (evaluation?.holds === true) {
              if (await admitAfterDrainRevalidation(deadline) === 'admitted') {
                admitted = true;
                break;
              }
            }
            stagingClosed = true;
            break;
          }
          continue;
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
      // The positive barrier: evaluated only with the join holding (and NOT
      // ambiguous) and the Child turn active, rate-limited to the passive
      // read floor.
      if (facts.identity.joinHolds === true && facts.identity.joinAmbiguous !== true && facts.identity.childTurnActive === true) {
        evaluation = await barrier();
        if (evaluation?.holds === true) {
          // (round-2 P1 + P2-3) the same post-observer deadline recheck
          // and queued-event drain before any delivery.
          if (await admitAfterDrainRevalidation(deadline) === 'admitted') {
            admitted = true;
            break;
          }
          stagingClosed = true;
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
      refuse(facts.staging.preAdmissionDrainIncomplete === true
        ? 'the pre-admission lifecycle drain reached its bounded event cap before the queue was exhausted (the incomplete drain — queued lifecycle evidence is never certified clear, and the single attempt was never consumed)'
        : facts.staging.childTerminalPreAdmission === true
          ? (facts.staging.preAdmissionDrainVeto === true
            ? 'a QUEUED lifecycle event showed the target turn already terminal before the window was confirmed (the pre-admission drain veto — the exact active turn was revalidated and the single attempt was never consumed)'
            : 'the Child turn reached terminal before the pending window was confirmed (the stale-id refusal)')
          : facts.identity.joinAmbiguous === true
          ? 'the identity join is ambiguous: two different started SubAgentActivity items named two different Children (§39.9 step 3: the identity stays named-unestablished and is never resolved by picking one)'
          : facts.identity.joinHolds === true
            ? barrierMissReason(evaluation)
            : `the identity join never held (parent SubAgentActivity.agentThreadId x Child turn/started.threadId; thread/started is never required): ${facts.staging.descriptorPublicationObserved === true ? 'the setup descriptor publication is not a live receipt' : 'no parent-bound spawn activity was observed'}; ${facts.identity.childThreadId === null ? (unmatchedChildTurnStarts.length > 0 ? 'a Child turn/started was observed but its parent SubAgentActivity side never arrived (the join stays open)' : 'no Child was spawned through the real parent') : 'the Child turn/started was never observed on the Child stream'}`);
      return finalizeSession(facts, connection, host, now, dutyAdjudication, redact, holdGate, null, liveLaunchContext);
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
    // (§41.5.1 step 3) the detection instant is the collector's
    // controller-clock `observedAtMs`; the gate release deadline is that
    // instant + the registered hold duration — the SAME fact the admission
    // barrier validated. (P1-2, round-18) the `_REACHED` sentinel read is
    // NOT taken here — it runs inside the admission revalidation, before the
    // final checks, so its result never sits between the checks and the
    // send (never persisted either way).
    facts.hold.holdDeadlineAtMs = safeStamp(holdDeadlineAtMs);

    // §39.9 step 7: exactly ONE native delivery — the empty-turn-id
    // startup-interrupt form is FORBIDDEN for this case (pre-send refusal).
    if (facts.identity.childTurnId === null || facts.identity.childTurnId === '') {
      facts.nativeRequest.outcome = 'forbidden-empty-turn-id';
      refuse('the empty-turn-id startup-interrupt form is forbidden for this case (it is not an exact active-turn target)');
      return finalizeSession(facts, connection, host, now, dutyAdjudication, redact, holdGate, null, liveLaunchContext);
    }
    facts.nativeRequest.threadId = facts.identity.childThreadId;
    facts.nativeRequest.turnId = facts.identity.childTurnId;
    facts.nativeRequest.attemptCount = 1;
    let transportReplyAtMs = /** @type {number | null} */ (null);
    // (P1-5, 2026-11-19 codex review) the ONE interrupt request is tracked
    // CONCURRENTLY with the deadline-driven gate release and the notification
    // collection — awaiting the reply used to block every loop, so a reply
    // after the hold deadline kept the worker held past its registered
    // release time and a reply after the measurement cutoff caused
    // already-buffered terminal evidence to be skipped entirely. The request
    // promise resolves INDEPENDENTLY: the loops keep their deadlines, a late
    // reply is a TYPED LATE-REPLY FACT (never a lost terminal, never a
    // truncated collection), and the reply's outcome still feeds the receipt
    // typing whenever it arrives within the case deadline.
    let deliveryFailureRefusal = /** @type {string | null} */ (null);
    const deliveryState = { done: false };
    // (P1-1, 2026-11-19 codex re-review) the credited duty snapshot —
    // declared here so the delivery block can SEED it (see below) before any
    // post-delivery collection read can mutate the adjudication.
    let creditedDutiesSnapshot = /** @type {any} */ (null);
    const consumeDeliveryReply = (/** @type {any} */ reply) => {
      deliveryState.done = true;
      // The attributable request bounds are recorded BEFORE anything else
      // consumes them (§39.9 step 7).
      facts.nativeRequest.sentAtMs = safeStamp(reply?.sentAtMs);
      facts.nativeRequest.repliedAtMs = safeStamp(reply?.repliedAtMs);
      transportReplyAtMs = facts.nativeRequest.repliedAtMs;
      facts.nativeRequest.outcome = 'sent';
      facts.nativeRequest.responseWithinBound = transportReplyAtMs !== null
        && transportReplyAtMs - facts.nativeRequest.sentAtMs <= CONFIRMED_WINDOW_NATIVE_RESPONSE_BOUND_MS;
      facts.receipt.transportReplyAtMs = transportReplyAtMs;
      // The typed LATE-REPLY fact: a reply arriving after the measurement
      // cutoff never erases the collected terminal evidence (the loops kept
      // their deadlines) — it is recorded as late, beside it.
      const cutoffAtMs = safeStamp(facts.window.measurementCutoffAtMs);
      if (cutoffAtMs !== null && transportReplyAtMs !== null && transportReplyAtMs > cutoffAtMs) {
        facts.receipt.transportReplyLateAtMs = transportReplyAtMs;
      }
    };
    const consumeDeliveryError = (/** @type {any} */ deliveryError) => {
      deliveryState.done = true;
      // A failed/unsent request is recorded typed and NEVER invisibly
      // retried. The server's own active-turn rejection is the named
      // wrong/stale-target outcome and fails closed.
      // (round-3 P2-5) the attributable INITIATION bounds ride the launcher's
      // error path (`initiatedAtMs`); the REJECTION time is never substituted
      // as the send stamp — a genuinely unattributable initiation stays
      // explicitly unsent (null), never fabricated from now().
      const text = redact(deliveryError);
      facts.nativeRequest.sentAtMs = safeStamp(deliveryError?.initiatedAtMs);
      facts.nativeRequest.repliedAtMs = safeStamp(deliveryError?.repliedAtMs);
      facts.nativeRequest.outcome = /expected active turn id|no active turn to interrupt|thread not found/u.test(text)
        ? 'stale-turn-target'
        : 'rejected';
      facts.nativeRequest.errorText = text;
      facts.nativeRequest.responseWithinBound = null;
      facts.receipt.transportReplyAtMs = null;
      deliveryFailureRefusal = `the native request was not delivered (${facts.nativeRequest.outcome}): ${text}`;
    };
    const deliveryRequest = connection.request('turn/interrupt', { threadId: facts.nativeRequest.threadId, turnId: facts.nativeRequest.turnId }).then(
      (/** @type {any} */ reply) => consumeDeliveryReply(reply),
      (/** @type {any} */ deliveryError) => consumeDeliveryError(deliveryError),
    );
    deliveryRequest.catch(() => { /* the typed consumers own the outcome */ });
    // (P1-4) the causal anchor for the survival verdict: the delivery's
    // INITIATION instant on the controller clock — post-delivery progress is
    // measured from here, never from the reply bounds.
    deliveryInitiatedAtMs = now();
    // (P1-1, 2026-11-19 codex re-review) the credited duty snapshot is SEEDED
    // here — from the adjudication as it stands BEFORE any post-delivery
    // collection read can mutate it (pre-cutoff by construction: the
    // initiation precedes the hold deadline, which precedes the cutoff).
    creditedDutiesSnapshot = projectConfirmedWindowDutyAdjudication(dutyAdjudication);
    // The request WAS initiated: the sent state is recorded at initiation,
    // and the reply/refinement lands whenever the transport delivers it.
    reach('native-request-sent');
    facts.finalState = 'native-request-sent';

    // §39.9 step 8: resolution collection until the measurement cutoff. The
    // transport reply is NEVER itself the settlement; a reply riding a
    // natural completion is the named response-at-unrelated-completion
    // failure; parent-only cancellation is typed separately and never
    // stands in for the Child's resolution.
    const collectionDeadlineAtMs = Math.min(facts.window.measurementCutoffAtMs ?? caseDeadlineAtMs, caseDeadlineAtMs);
    // (P1-5 + P1-4 + P1-1, 2026-11-19 codex reviews) the CREDITED duty
    // adjudication: SEEDED from the pre-delivery adjudication (pre-cutoff by
    // construction — the delivery initiation precedes the hold deadline,
    // which precedes the cutoff), then refreshed ONLY by duty reads that
    // COMPLETE before the measurement cutoff. There is NO fallback that
    // populates it from mutable evidence after the cutoff: a horizon read
    // spanning the cutoff (started pre-cutoff, completed post-cutoff with a
    // post-cutoff mutation) is rejected by the completion check, and the
    // post-cutoff diagnostics never reach the credited snapshot.
    const cutoffAtMsForCredit = () => safeStamp(facts.window.measurementCutoffAtMs);
    const refreshCreditedAdjudication = () => {
      const cutoff = cutoffAtMsForCredit();
      if (cutoff === null) return;
      if (now() < cutoff) creditedDutiesSnapshot = projectConfirmedWindowDutyAdjudication(dutyAdjudication);
    };
    let childResolution = /** @type {{ atMs: number | null, status: string | null, basis: string } | null} */ (null);
    let observationResolved = false;
    // (round-4 P2) the instrument's own resolution timestamp, captured when
    // first reported (never the later polling/loop-completion time).
    let observationResolvedAtMs = /** @type {number | null} */ (null);
    // (P2-1, round-10 re-review) a pendingObservation RESOLUTION fact is
    // validated on the controller clock BEFORE it is ever recorded — the
    // same §41.5.2 discipline the control reads carry (round 9): the domain
    // tag must be `controller-monotonic` (a foreign domain is refused before
    // any stamp arithmetic) and a PRESENT resolvedAtMs must NOT exceed the
    // read instant. A resolution fact that is missing its timestamp or fails
    // either validation leaves the leg UNESTABLISHED — resolvedAtMs is
    // never fabricated from now() (a missing resolution timestamp is missing
    // evidence, not the polling time).
    /** @returns {string | null} the named violation, or null when the fact is valid */
    const pendingResolutionFactViolation = (/** @type {any} */ pending, /** @type {number} */ readAtMs) => {
      if (hasForeignClockDomain(pending)) return 'clock-domain-mismatch';
      const resolvedAtMs = safeStamp(pending?.resolvedAtMs);
      if (resolvedAtMs !== null && resolvedAtMs > readAtMs) return 'clock-bounds-violation';
      return null;
    };
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
      // tick so a resolution is never missed for lack of host events. The
      // §41.5.1 gate release wakes the loop EXACTLY at the hold deadline.
      const releaseWakeAtMs = holdGate !== null && holdGate.releasedAtMs === null ? safeStamp(facts.hold.holdDeadlineAtMs) : null;
      const wakeAtMs = Math.min(
        collectionDeadlineAtMs,
        lastObservationEvaluationAtMs + CONFIRMED_WINDOW_PASSIVE_READ_FLOOR_MS,
        releaseWakeAtMs ?? collectionDeadlineAtMs,
      );
      const event = await connection.nextNotification(Math.min(wakeAtMs, caseDeadlineAtMs));
      await releaseHoldGateAtDeadline();
      // (P1-5) a delivery rejection that landed DURING collection stops the
      // escalation honestly — the already-consumed terminal facts stand.
      if (deliveryFailureRefusal !== null) break;
      if (typeof observers.pendingObservation === 'function' && now() - lastObservationEvaluationAtMs >= CONFIRMED_WINDOW_PASSIVE_READ_FLOOR_MS) {
        lastObservationEvaluationAtMs = now();
        // (round-4 P2) an independent collector failure is recorded as
        // inconclusive — it never escapes to the outer catch, which would
        // finalize before the already-observed terminal facts were persisted.
        const pending = await boundedCollectionRead(observers.pendingObservation, collectionReadBoundAtMs(collectionDeadlineAtMs))
          .catch((collectorError) => {
            facts.inconclusive = facts.inconclusive ?? { reason: `the collection instrument read failed (the retained terminal evidence stands): ${redact(collectorError)}` };
            return null;
          });
        if (pending?.resolved === true && observationResolved !== true) {
          // (round-4 P2) the instrument's OWN resolution timestamp is
          // preserved when first reported — never the later polling time.
          // (P2-1, round-10) the fact is VALIDATED first: a foreign clock
          // domain or a stamp beyond the read instant leaves the leg
          // unestablished, and a missing timestamp is never replaced with
          // now().
          const resolutionViolation = pendingResolutionFactViolation(pending, now());
          const resolvedAtMs = safeStamp(pending.resolvedAtMs);
          if (resolutionViolation === null && resolvedAtMs !== null) {
            observationResolved = true;
            observationResolvedAtMs = resolvedAtMs;
          }
        }
        // (P1-4) the delivery was initiated: this floor-cadence read is
        // post-delivery — its control facts adjudicate the §16.4 survival.
        await readControlForSurvival(collectionReadBoundAtMs(collectionDeadlineAtMs));
        // (P2-1, 2026-11-19 codex re-review) duty sampling CONTINUES at the
        // registered cadence in this phase too: while the Child terminal is
        // awaited, this loop sampled only pending/control facts and deferred
        // every duty read past the terminal — a terminal arriving just
        // before the cutoff lost the pre-cutoff refresh (the first
        // post-terminal duty read completed past the cutoff and the credited
        // snapshot kept its seeded state, refusing a settlement the window
        // had already earned). Timely exit evidence and the live collector's
        // cleanup-fence observation keep their cadence here.
        try {
          if (liveLaunchContext === null || liveLaunchContext.durableReadAttempts < CONFIRMED_WINDOW_DUTY_READ_MAX_ATTEMPTS) {
            if (liveLaunchContext !== null) liveLaunchContext.durableReadAttempts += 1;
            await boundedCollectionRead(observers.dutyFacts, collectionReadBoundAtMs(collectionDeadlineAtMs));
          }
        } catch (collectorError) {
          facts.inconclusive = facts.inconclusive ?? { reason: `the duty collection read failed while the Child terminal was awaited (the retained terminal evidence stands): ${redact(collectorError)}` };
        }
        refreshCreditedAdjudication();
        // (P2-2) the release runs microtask-adjacent after the reads: a
        // timed-out (hold-woken) read hands the deadline back here, before
        // any abandoned collector's next scheduling step can advance the
        // shared clock past the registered release instant.
        await releaseHoldGateAtDeadline();
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
        // (P2-4, round-23 codex review) the terminal leg matches BOTH the
        // thread id AND the REQUESTED turn id: a completion for ANOTHER turn
        // on the joined Child (or one whose turn id cannot be positively
        // bound) is its own diagnostic and never the childResolution leg —
        // the loop keeps looking for the exact requested receipt.
        if (completedTurnId !== facts.nativeRequest.turnId) {
          if (facts.receipt.childForeignTurnCompletionAtMs == null) {
            facts.receipt.childForeignTurnCompletionAtMs = safeStamp(event.receivedAtMs);
            facts.receipt.childForeignTurnCompletionTurnId = completedTurnId;
          }
        } else {
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
        }
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
      const releaseWakeAtMs = holdGate !== null && holdGate.releasedAtMs === null ? safeStamp(facts.hold.holdDeadlineAtMs) : null;
      const readyAtMs = Math.min(
        lastObservationEvaluationAtMs + CONFIRMED_WINDOW_PASSIVE_READ_FLOOR_MS,
        releaseWakeAtMs ?? collectionDeadlineAtMs,
      );
      if (readyAtMs >= collectionDeadlineAtMs) break;
      if (now() < readyAtMs) await sleep(readyAtMs - now());
      await releaseHoldGateAtDeadline();
      lastObservationEvaluationAtMs = now();
      const pending = await boundedCollectionRead(observers.pendingObservation, collectionReadBoundAtMs(collectionDeadlineAtMs))
        .catch((collectorError) => {
          facts.inconclusive = facts.inconclusive ?? { reason: `the collection instrument read failed (the retained terminal evidence stands): ${redact(collectorError)}` };
          return null;
        });
      if (pending?.resolved === true) {
        // (P2-1, round-10) the SAME validation on this loop's resolution
        // reads: a foreign clock domain or a stamp beyond the read instant
        // leaves the leg unestablished, and a missing timestamp is never
        // replaced with now(). (This loop's while condition already holds
        // the leg unresolved here.)
        const resolutionViolation = pendingResolutionFactViolation(pending, now());
        const resolvedAtMs = safeStamp(pending.resolvedAtMs);
        if (resolutionViolation === null && resolvedAtMs !== null) {
          observationResolved = true;
          observationResolvedAtMs = resolvedAtMs;
        }
      }
      // (P1-3, 2026-11-19 codex re-review) the observation wait is NOT a
      // pending-only wait: the independent control and duty collection
      // continues at the SAME floor cadence while either resolution leg is
      // awaited — a short-lived control (the ~120000-ms design) must be
      // sampled while it is alive, and the local duties must keep their
      // cadence; deferring them to the horizon phase starves exactly the
      // evidence that phase can no longer observe.
      await readControlForSurvival(collectionReadBoundAtMs(collectionDeadlineAtMs));
      try {
        if (liveLaunchContext === null || liveLaunchContext.durableReadAttempts < CONFIRMED_WINDOW_DUTY_READ_MAX_ATTEMPTS) {
          if (liveLaunchContext !== null) liveLaunchContext.durableReadAttempts += 1;
          await boundedCollectionRead(observers.dutyFacts, collectionReadBoundAtMs(collectionDeadlineAtMs));
        }
      } catch (collectorError) {
        facts.inconclusive = facts.inconclusive ?? { reason: `the duty collection read failed during the observation wait (the retained resolution evidence stands): ${redact(collectorError)}` };
      }
      refreshCreditedAdjudication();
      // (P2-2) the microtask-adjacent release (see the step-8 loop).
      await releaseHoldGateAtDeadline();
      // (P1-5) a delivery rejection that landed during the resolution
      // collection stops the escalation honestly.
      if (deliveryFailureRefusal !== null) break;
    }
    // (P1-5) the delivery failure is consumed AFTER the loops so the already
    // collected terminal evidence stands in the record beside the typed
    // rejection; the escalation then stops with the named refusal.
    if (deliveryFailureRefusal !== null) {
      facts.receipt.childResolutionAtMs = childResolution?.atMs ?? null;
      facts.receipt.childTerminalStatus = childResolution?.status ?? null;
      facts.receipt.childResolutionBasis = childResolution?.basis ?? null;
      facts.receipt.observationResolvedAtMs = observationResolvedAtMs;
      facts.receipt.parentCancellationAtMs = parentCancellationAtMs;
      refuse(deliveryFailureRefusal);
      return finalizeSession(facts, connection, host, now, dutyAdjudication, redact, holdGate, creditedDutiesSnapshot, liveLaunchContext);
    }
    // (P2-2, 2026-11-19 codex re-review) drain and adjudicate BUFFERED
    // lifecycle events using their RETAINED ARRIVAL TIMESTAMPS before the
    // missing-resolution verdict: a Child terminal queued behind a
    // cutoff-crossing collector read (the loop exited on now() before
    // consuming it) counts as observed at its arrival instant — the horizon's
    // later consumption never interprets it, so the verdict is finalized only
    // after every already-queued lifecycle notification has been adjudicated.
    // (P2, round-9 re-review) the drain CYCLES bounded batches: a queue that
    // holds MORE than the 64-event batch cap of buffered notifications
    // before the Child terminal must not strand the terminal behind the
    // cap — each batch keeps the SAME bounded shape (a flooded or poisoned
    // stream still hits the case deadline, never an unbounded loop), and
    // the cycle continues until the queue is EMPTY or the case deadline
    // expires, whichever comes first.
    const drainBufferedResolutionEvidence = async () => {
      for (;;) {
        // (P2, round-9) the case deadline bounds the CYCLE, not just one
        // batch: the drain never runs past the case's own fence.
        if (now() >= caseDeadlineAtMs) break;
        let batchReachedCap = true;
        for (let drained = 0; drained < MAX_ADMISSION_DRAIN_EVENTS; drained += 1) {
          let queued = null;
          try {
            queued = await connection.nextNotification(now());
          } catch (drainError) {
            facts.inconclusive = facts.inconclusive ?? { reason: `the buffered lifecycle drain failed (the retained resolution evidence stands): ${redact(drainError)}` };
            return;
          }
          if (queued === null) {
            batchReachedCap = false;
            break;
          }
          const drainParams = queued?.params ?? {};
          const drainType = typeof drainParams.type === 'string' && drainParams.type.length > 0
            ? drainParams.type
            : (typeof queued?.method === 'string' ? queued.method : '');
          const drainThreadId = boundedThreadId(drainParams.threadId);
          if (drainType === 'turn/completed' && drainThreadId === facts.nativeRequest.threadId) {
            const drainCompletedTurnId = boundedThreadId(drainParams.turn?.id) ?? boundedThreadId(drainParams.turnId);
            // (P2-4, round-23 codex review) the drain matches BOTH the thread
            // id AND the requested turn id — a foreign/unbindable completion
            // is its own diagnostic, never the terminal leg.
            if (drainCompletedTurnId !== facts.nativeRequest.turnId) {
              if (facts.receipt.childForeignTurnCompletionAtMs == null) {
                facts.receipt.childForeignTurnCompletionAtMs = safeStamp(queued.receivedAtMs);
                facts.receipt.childForeignTurnCompletionTurnId = drainCompletedTurnId;
              }
            } else if (childResolution === null) {
              const drainStatus = typeof drainParams.turn?.status === 'string' ? drainParams.turn.status : null;
              // (P2-5, round-23 codex review) the queued event is classified
              // by its RETAINED ARRIVAL STAMP, so the cutoff fence applies
              // regardless of which loop consumes it: a terminal that
              // ARRIVED at/after the measurement cutoff rides the
              // late-resolution fields — never childResolutionAtMs, never
              // the credited leg.
              const drainArrivalAtMs = safeStamp(queued.receivedAtMs);
              const drainCutoffAtMs = safeStamp(facts.window.measurementCutoffAtMs);
              if (drainCutoffAtMs !== null && drainArrivalAtMs !== null && drainArrivalAtMs >= drainCutoffAtMs) {
                if (facts.receipt.childResolutionLateAtMs == null) {
                  facts.receipt.childResolutionLateAtMs = drainArrivalAtMs;
                }
              } else {
                facts.receipt.completedTurnId = drainCompletedTurnId;
                if (drainStatus === 'interrupted') {
                  childResolution = { atMs: drainArrivalAtMs, status: drainStatus, basis: 'child-terminal-event' };
                } else {
                  childResolution = { atMs: drainArrivalAtMs, status: drainStatus, basis: 'natural-completion' };
                  facts.receipt.unrelatedCompletionReply = transportReplyAtMs !== null;
                }
                facts.receipt.childResolutionAtMs = childResolution.atMs;
                facts.receipt.childTerminalStatus = childResolution.status;
                facts.receipt.childResolutionBasis = childResolution.basis;
              }
            }
            continue;
          }
          if (drainType === 'turn/completed' && drainThreadId === facts.identity.parentThreadId && childResolution === null) {
            const drainParentStatus = typeof drainParams.turn?.status === 'string' ? drainParams.turn.status : null;
            if (drainParentStatus === 'interrupted') parentCancellationAtMs = safeStamp(queued.receivedAtMs);
            else parentTerminalStatusObserved = drainParentStatus;
          }
        }
        // (P2, round-9) a batch that emptied the queue (or hit a transport
        // failure) ends the cycle; a batch that reached the 64-event cap
        // CYCLES once more — the deadline recheck at the cycle top bounds
        // the whole drain to the case's own fence.
        if (batchReachedCap !== true) break;
      }
    };
    await drainBufferedResolutionEvidence();
    // (P1-5) the single request promise resolves INDEPENDENTLY of the loops:
    // the reply's outcome feeds the receipt typing whenever it arrives within
    // the case deadline. (P1-3, 2026-11-19 codex re-review) the HORIZON
    // PHASE below stays ALIVE while the reply is outstanding — the former
    // sleep-only wait blocked the deadline-driven gate release, the drain and
    // every floor-cadence read once the fence had passed. The phase now runs
    // until the reply arrives or the case deadline expires, whichever the
    // phase's own fences bound first.
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
    // (P1-3) the ALIVE horizon phase: the phase end is the observation
    // teardown fence, EXTENDED to the case deadline while the single reply
    // remains outstanding — release, drain and the floor-cadence reads keep
    // their deadlines and never stall behind a late reply.
    while (now() < Math.min(caseDeadlineAtMs, deliveryState.done === true ? collectionHorizonAtMs : caseDeadlineAtMs)) {
      const phaseEndAtMs = Math.min(caseDeadlineAtMs, deliveryState.done === true ? collectionHorizonAtMs : caseDeadlineAtMs);
      const releaseWakeAtMs = holdGate !== null && holdGate.releasedAtMs === null ? safeStamp(facts.hold.holdDeadlineAtMs) : null;
      const horizonWakeAtMs = Math.min(
        phaseEndAtMs,
        lastObservationEvaluationAtMs + CONFIRMED_WINDOW_PASSIVE_READ_FLOOR_MS,
        releaseWakeAtMs ?? phaseEndAtMs,
      );
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
      await releaseHoldGateAtDeadline();
      // (P2-4, round-22 codex review) the horizon RETAINS late resolutions:
      // the exact Child terminal notification that first arrives during the
      // teardown horizon is recorded with its RETAINED arrival timestamp as
      // the named late-resolution diagnostic — the credited leg stays
      // refused (the round-19 P1-5 freeze: late facts never grant cutoff
      // credit and childResolution is NOT set here), but the retained record
      // now DISTINGUISHES an unresponsive Child from a resolution outside
      // the window. The earliest observed arrival wins; later duplicates
      // never move it.
      if (horizonEvent !== null && facts.receipt.childResolutionLateAtMs == null && childResolution === null) {
        const horizonParams = horizonEvent?.params ?? {};
        const horizonType = typeof horizonParams.type === 'string' && horizonParams.type.length > 0
          ? horizonParams.type
          : (typeof horizonEvent?.method === 'string' ? horizonEvent.method : '');
        const horizonThreadId = boundedThreadId(horizonParams.threadId);
        if (horizonType === 'turn/completed' && horizonThreadId === facts.nativeRequest.threadId) {
          // (P2-4, round-23 codex review) the late retention matches the
          // REQUESTED turn too: a completion for another turn on the joined
          // Child is its own diagnostic, never the late-resolution stamp.
          const horizonTurnId = boundedThreadId(horizonParams.turn?.id) ?? boundedThreadId(horizonParams.turnId);
          if (horizonTurnId !== facts.nativeRequest.turnId) {
            if (facts.receipt.childForeignTurnCompletionAtMs == null) {
              facts.receipt.childForeignTurnCompletionAtMs = safeStamp(horizonEvent.receivedAtMs);
              facts.receipt.childForeignTurnCompletionTurnId = horizonTurnId;
            }
          } else {
            facts.receipt.childResolutionLateAtMs = safeStamp(horizonEvent.receivedAtMs);
          }
        }
      }
      if (typeof observers.pendingObservation === 'function' && now() - lastObservationEvaluationAtMs >= CONFIRMED_WINDOW_PASSIVE_READ_FLOOR_MS) {
        lastObservationEvaluationAtMs = now();
        try {
          const horizonPending = await boundedCollectionRead(observers.pendingObservation, collectionReadBoundAtMs(collectionHorizonAtMs));
          // (P2-4, round-22 codex review) the LATE observation resolution:
          // the original poll's resolution first reported during the
          // teardown horizon is retained with its OWN validated timestamp —
          // a named late diagnostic, never cutoff credit (observationResolved
          // is NOT set here; the round-19 P1-5 freeze stands). The earliest
          // observed resolution wins; a foreign clock domain or a future
          // stamp never lands (the same §41.5.2 validation the credited leg
          // applies).
          if (horizonPending?.resolved === true && observationResolved !== true && facts.receipt.observationResolvedLateAtMs == null) {
            const horizonResolutionViolation = pendingResolutionFactViolation(horizonPending, now());
            const horizonResolvedAtMs = safeStamp(horizonPending.resolvedAtMs);
            if (horizonResolutionViolation === null && horizonResolvedAtMs !== null) {
              facts.receipt.observationResolvedLateAtMs = horizonResolvedAtMs;
            }
          }
          if (liveLaunchContext === null || liveLaunchContext.durableReadAttempts < CONFIRMED_WINDOW_DUTY_READ_MAX_ATTEMPTS) {
            if (liveLaunchContext !== null) liveLaunchContext.durableReadAttempts += 1;
            await boundedCollectionRead(observers.dutyFacts, collectionReadBoundAtMs(collectionHorizonAtMs));
          }
          refreshCreditedAdjudication();
          // (P1-4) the horizon's control read is CONSUMED: its facts
          // adjudicate the post-interrupt survival (never discarded).
          const horizonControl = await boundedCollectionRead(observers.controlFacts, collectionReadBoundAtMs(collectionHorizonAtMs));
          adjudicateControlSurvivalRead(horizonControl);
          // (P2-2) the microtask-adjacent release (see the step-8 loop).
          await releaseHoldGateAtDeadline();
        } catch (horizonReadError) {
          // (round-2 P2) the SAME redaction boundary as the staging and
          // delivery failures: a collector error can carry fixture-private
          // absolute paths, and the inconclusive facts are persisted.
          facts.inconclusive = { reason: `the post-resolution independent collection read failed (the observed resolution stands): ${redact(horizonReadError)}` };
          if (facts.controlSurvival.established !== true && facts.controlSurvival.refusedReason === null) {
            facts.controlSurvival.refusedReason = `the post-resolution control read failed: ${redact(horizonReadError)}`;
          }
          break;
        }
      }
      if (horizonEvent === null && now() >= phaseEndAtMs) break;
    }
    // A hold deadline that landed exactly on the horizon/teardown boundary
    // still gets its NORMAL-path release (never deferred to cleanup when the
    // registered deadline was actually reached).
    await releaseHoldGateAtDeadline();
    return finalizeSession(facts, connection, host, now, dutyAdjudication, redact, holdGate, creditedDutiesSnapshot, liveLaunchContext);
  } catch (error) {
    facts.finalState = facts.finalState ?? 'staging-not-ready';
    if (facts.states.length === 0) reach('staging-not-ready');
    refuse(`the choreography failed before escalation completed: ${redact(error)}`);
    return finalizeSession(facts, connection, host, now, dutyAdjudication, redact, holdGate, null, liveLaunchContext);
  }
}

/**
 * Deterministic disposal (§39.9 step 9): the bounded facts are projected
 * BEFORE disposal, the ONE connection closes bounded, the ONE host is
 * disposed, and teardown is labelled for what it is — never settlement.
 * @param {any} facts @param {any} connection @param {any} host @param {() => number} now @param {any} dutyAdjudication
 * @param {any} [holdGate] the §41.5.1 hold producer (null when unarmed)
 */
/** @param {any} liveLaunchContext @param {any} facts @param {any} connection @param {any} host @param {() => number} now @param {any} dutyAdjudication @param {(error: unknown) => string} redact @param {any} [holdGate] @param {any} [creditedDuties] */
async function finalizeSession(facts, connection, host, now, dutyAdjudication, redact = boundedErrorText, holdGate = null, creditedDuties = null, liveLaunchContext = null) {
  // (§41.5.2, frozen) the settlement-stage clock gate: the RAW duty
  // adjudication's domain tag and bound (f) are validated BEFORE the existing
  // projection/consumer block — a foreign tag refuses with
  // `clock-domain-mismatch`, an out-of-bounds cleanup fence with
  // `clock-bounds-violation`, and both refuse CREDIT only (the delivery, if
  // sent, stays recorded). The projection drops the tag (§41.5.2's rule), so
  // this is the only place the raw tag can be enforced.
  // (P2-3, round-22 codex review) the gate and the projection adjustments are
  // computed BEFORE the checkpoint write below, so the checkpoint carries
  // the SAME pre-teardown duty projection the final record uses: the
  // controller's ADJUDICATED control-survival result (added when the
  // establishing read completed before the measurement cutoff, stripped
  // when unestablished) and the controller-encoded settlement clock refusal
  // ride the checkpoint — if teardown prevents the final record, the
  // measured no-collateral verdict stays recoverable from the retained
  // evidence alone.
  const clockRefusal = settlementClockRefusal(dutyAdjudication, facts.fences.caseDeadlineAtMs);
  /**
   * The credited (cutoff-qualified) duty projection with the controller's own
   * adjudications applied — the cutoff-frozen `control-survival` name and the
   * controller-encoded settlement clock refusal. The checkpoint AND the final
   * record consume this one projection (the direct research seam without a
   * credited snapshot falls back to the live projection — exactly the
   * record's own fallback).
   * @returns {any}
   */
  const creditedProjectedDuties = () => {
    let projectedDuties = creditedDuties ?? projectConfirmedWindowDutyAdjudication(dutyAdjudication);
    if (projectedDuties === null) return null;
    // (P1-2, 2026-11-19 codex re-review) the survival credit is FROZEN at the
    // measurement cutoff: the `control-survival` name applies only when the
    // ESTABLISHING read completed BEFORE the cutoff. A survival first
    // observed after the cutoff (a horizon read landing past the fence) is
    // diagnostic-only — late reads never feed the credited snapshot.
    const survivalCutoffAtMs = safeStamp(facts.window.measurementCutoffAtMs);
    const survivalEstablished = facts.controlSurvival.established === true
      && facts.controlSurvival.readAtMs !== null
      && survivalCutoffAtMs !== null
      && (/** @type {number} */ (facts.controlSurvival.readAtMs)) < survivalCutoffAtMs;
    let baseNames = Array.isArray(projectedDuties.names) ? [...projectedDuties.names] : null;
    // (P2-2, 2026-11-19 codex re-review) the settlement clock refusal is
    // ENCODED in the retained evidence: the projected adjudication's bounded
    // name list carries the refusal name (`clock-domain-mismatch` /
    // `clock-bounds-violation`) — the same additive-name mechanism the
    // §41.5.2 projection rule allows for `control-survival`. The projection
    // drops the raw clock tag, so without this name the persisted inputs
    // would replay to an upgraded acceptance.
    if (clockRefusal !== null && baseNames !== null && !baseNames.includes(clockRefusal)) {
      baseNames = [...baseNames, clockRefusal];
    }
    if (baseNames !== null && baseNames.includes('control-survival') && !survivalEstablished) {
      baseNames = baseNames.filter((name) => name !== 'control-survival');
    }
    return {
      ...projectedDuties,
      names: baseNames !== null && survivalEstablished && !baseNames.includes('control-survival') ? [...baseNames, 'control-survival'] : baseNames,
    };
  };
  // (P1-4, round-19 re-review) the FIRST REAL CLEANUP ACTION on the
  // controller clock — the controller's own teardown initiation (the gate
  // release / worker termination / host disposal that actually begins
  // cleanup): the earliest genuine cleanup boundary is recorded into the
  // frozen duty snapshot (cleanupFenceAtMs), never the time of a terminal
  // snapshot read.
  // (P2-6, round-23 codex review) the witness is recorded BEFORE the
  // checkpoint write: with no observed SessionEnd cleanup the adjudication's
  // fence is UNPROVEN (null) until THIS boundary, and a checkpoint written
  // before the fill replayed to `cleanup-fence-unproven` although the final
  // record (written after the fill) settled — a disposal casualty between
  // the two writes lost the settlement the controller had already witnessed.
  // The controller's own pre-teardown teardown-initiation instant is the
  // conservative WITNESSED boundary both retained shapes share: it precedes
  // every actual cleanup action, so a resolution inside the measurement
  // window stays provably pre-fence and settlement is recoverable from the
  // checkpoint alone.
  if (facts.hold.gateReleaseInitiatedAtMs === null) facts.hold.gateReleaseInitiatedAtMs = now();
  const firstCleanupActionAtMs = now();
  if (liveLaunchContext !== null && liveLaunchContext.firstCleanupActionAtMs === null) {
    liveLaunchContext.firstCleanupActionAtMs = firstCleanupActionAtMs;
  }
  if (dutyAdjudication !== null && typeof dutyAdjudication === 'object' && (dutyAdjudication.cleanupFenceAtMs === null || dutyAdjudication.cleanupFenceAtMs === undefined)) {
    dutyAdjudication.cleanupFenceAtMs = firstCleanupActionAtMs;
  }
  if (creditedDuties !== null && typeof creditedDuties === 'object' && (creditedDuties.cleanupFenceAtMs === null || creditedDuties.cleanupFenceAtMs === undefined)) {
    creditedDuties.cleanupFenceAtMs = firstCleanupActionAtMs;
  }
  // (P2-7, round-19 re-review) the bounded on-disk EVIDENCE CHECKPOINT is
  // written BEFORE any teardown step: the frozen measurement evidence (the
  // measured facts, the projected duty adjudication, the evidence verdict)
  // reaches disk while every measured process is still intact — if teardown
  // hangs or the process stops during it, the counted run keeps its only
  // evidence. persistedBeforeDisposal is set ONLY when this write lands.
  // (P2-1, round-20 codex re-review) the checkpoint receives the bounded
  // MEASUREMENT SNAPSHOT, not fixed labels: the whitelisted projected
  // evidence — identity, request bounds, resolution, duties — projected
  // through the SAME bounded projectors the persisted record uses, at the
  // pre-teardown instant. A teardown hang or a process exit during cleanup
  // can no longer lose the measured facts: the bounded evidence is
  // recoverable from the checkpoint WITHOUT the final record.
  if (liveLaunchContext !== null && typeof liveLaunchContext.persistEvidenceCheckpoint === 'function') {
    try {
      const checkpointEvidence = projectConfirmedWindowBlock(facts);
      // (P2-3, round-21 codex review) the checkpoint's duty projection is the
      // SAME CUTOFF-QUALIFIED one the final record uses — the credited
      // snapshot (seeded pre-delivery and refreshed only by pre-cutoff duty
      // reads), never the LIVE adjudication a post-cutoff horizon settlement
      // may have mutated: if teardown prevents the final record, the only
      // retained evidence must not OVERSTATE which duties settled on time.
      // (The direct research seam without a credited snapshot falls back to
      // the live projection — exactly the record's own fallback.)
      // (P2-3, round-22 codex review) the projection is also the one with the
      // controller's own adjudications APPLIED — the adjudicated survival
      // name and the encoded clock refusal — so the checkpoint never loses
      // the measured no-collateral result the final record would carry.
      const checkpointDuties = creditedProjectedDuties();
      await liveLaunchContext.persistEvidenceCheckpoint({ evidence: checkpointEvidence, duties: checkpointDuties });
      facts.fences.persistedBeforeDisposal = true;
    } catch (checkpointError) {
      facts.fences.persistedBeforeDisposal = false;
      facts.inconclusive = facts.inconclusive
        ? { reason: `${facts.inconclusive.reason}; the pre-teardown evidence checkpoint could not be written: ${redact(checkpointError)}` }
        : { reason: `the pre-teardown evidence checkpoint could not be written: ${redact(checkpointError)}` };
    }
  } else {
    // No checkpoint writer (the direct research seam): the field keeps its
    // honest absent value — never a true claim without a write.
    facts.fences.persistedBeforeDisposal = null;
  }
  // (§41.5.1) cleanup on EVERY refusal/failure path, BEFORE or AFTER
  // detection: RELEASE the gate immediately (a cleanup release is not the
  // normal-path release and may occur before the deadline), then terminate
  // the VERIFIED fake-ZCode process through the marker/nonce identity. A
  // surviving blocked worker is a NAMED cleanup failure, never a silent
  // disposal. The gate directory is removed after the host disposal below.
  if (holdGate !== null) {
    if (holdGate.releasedAtMs === null) {
      if (facts.hold.gateReleaseInitiatedAtMs === null) facts.hold.gateReleaseInitiatedAtMs = now();
      try {
        await releaseConfirmedWindowHoldGate(holdGate, now, 'cleanup');
      } catch (error) {
        facts.hold.cleanupFailures.push(`the completion gate cleanup release failed: ${redact(error)}`);
      }
    }
    facts.hold.gateReleasedAtMs = holdGate.releasedAtMs;
    facts.hold.releaseBasis = holdGate.releaseBasis;
    facts.hold.releaseContent = holdGate.releaseContent;
    await terminateConfirmedWindowHoldWorker(holdGate, facts.hold);
    if (facts.hold.process.blockedWorkerSurvives === true) {
      facts.hold.cleanupFailures.push('a blocked fake-ZCode worker survived cleanup (verifiedProcessTerminated is not true and no confirmed-absence basis exists)');
    }
  }
  facts.hold.holdDeadlineAtMs = safeStamp(facts.hold.holdDeadlineAtMs) ?? safeStamp(facts.window.holdDeadlineAtMs);
  // §39.9 steps 8/9: the final reload-side consumer runs over the PERSISTED
  // bytes (a JSON round trip — exactly what an offline reader reloads). The
  // `all-duties-adjudicated` state is reached ONLY on an admitted delivery
  // whose settlement the consumer accepts over the retained record; every
  // other outcome keeps its named refusal and rides the verdict honestly.
  // (round-4 P2) the duty adjudication rides the bounded whitelisted
  // projection: the verdict consumes the SAME projected representation the
  // record persists (never the raw injected object).
  // (P1-4, 2026-11-19 codex review) the §16.4 post-interrupt survival verdict
  // is adjudicated by THIS choreography's own post-delivery reads and rides
  // the projected shape: an established survival adds the 'control-survival'
  // additional name (the §41.5.2 projection rule); an unestablished one
  // STRIPS any claimed survival name — a stale adjudication can never
  // certify a survival this run did not observe, and the consumer's
  // mandatory check refuses by name.
  // (P1-5) the settlement consumes the adjudication AS FROZEN AT THE
  // MEASUREMENT CUTOFF when the choreography captured it — never the live
  // mutable object the post-cutoff horizon reads may have settled.
  // (P2-3, round-22 codex review) the projected duties are the checkpoint's
  // OWN shared projection — computed once above (the survival freeze and the
  // encoded clock refusal applied) so the retained checkpoint and the final
  // record can never disagree on the adjudicated verdict.
  const projectedDuties = creditedProjectedDuties();
  const evidenceVerdict = admitConfirmedWindowNativeEvidence(
    JSON.parse(JSON.stringify(projectConfirmedWindowBlock(facts))),
    projectedDuties,
  );
  if (evidenceVerdict.delivery.status === 'admitted' && facts.controlSurvival.established !== true
    && !evidenceVerdict.settlement.reasons.includes('control-survival-unproven')) {
    evidenceVerdict.settlement = {
      ...evidenceVerdict.settlement,
      settled: false,
      basis: null,
      reasons: [...evidenceVerdict.settlement.reasons, 'control-survival-unproven'],
    };
  }
  // (P3-1, round-22 codex review) the controller-encoded clock refusal is
  // APPENDED only when missing — never a replacement: a run whose replay
  // already included the encoded clock name (and any OTHER failure — a
  // missing Child resolution, a required duty, a missing baseline) keeps
  // every other named refusal, so the stored verdict matches the verdict
  // recomputed from its retained inputs.
  if (clockRefusal !== null) {
    evidenceVerdict.settlement = {
      ...evidenceVerdict.settlement,
      settled: false,
      basis: null,
      reasons: Array.isArray(evidenceVerdict.settlement.reasons)
        ? (evidenceVerdict.settlement.reasons.includes(clockRefusal)
          ? evidenceVerdict.settlement.reasons
          : [...evidenceVerdict.settlement.reasons, clockRefusal])
        : [clockRefusal],
    };
  }
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
  // (P2-5, round-21 codex review) the POST-SHUTDOWN WORKER RECHECK: the
  // launch activity has stopped (the ONE host disposal above is awaited),
  // and a late worker launched by the detached broker can have appeared
  // DURING that shutdown — its marker was absent at the first check and
  // may exist now. The gate directory is still available at this point;
  // the worker absence is verified AGAIN through the existing marker/nonce
  // path BEFORE the gate directory is removed: a worker that appeared late
  // is terminated (never a false clean teardown), and one that survives
  // the recheck's termination is a named cleanup failure.
  if (holdGate !== null) {
    await terminateConfirmedWindowHoldWorker(holdGate, facts.hold);
    if (facts.hold.process.blockedWorkerSurvives === true) {
      facts.hold.cleanupFailures.push('a late fake-ZCode worker appeared during the host shutdown and survived the post-shutdown termination recheck (the gate directory was removed only after the recheck)');
    }
  }
  facts.disposal.teardownLabel = 'planned-observation-teardown';
  if (holdGate !== null) {
    // §41.5.1 step 5: the gate directory is THIS route's added cleanup step
    // (the legacy fixture root disposal removed its own gates/ dir). A
    // removal failure is recorded, never hidden.
    try {
      await rm(holdGate.directory, { recursive: true, force: true });
      facts.hold.gateDirectoryRemoved = true;
    } catch (error) {
      facts.hold.cleanupFailures.push(`the gate directory removal failed: ${redact(error)}`);
    }
  }
  facts.hold.armed = holdGate !== null;
  // (P2-3, round-18 re-review + P2-2, round-19) the route's OWN cleanup
  // verdict: the gate removal (when armed), the protocol connection close,
  // and the host disposal — AND every NAMED cleanup failure (a surviving
  // worker, a failed gate release, a failed gate-directory removal) keeps
  // the verdict FALSE: a surviving worker can never coexist with
  // cleanupComplete:true because the gate directory was removed. The
  // executor's exit check reads it from the returned facts
  // (held.cleanupComplete), so a route cleanup failure is DETECTABLE.
  facts.hold.cleanupComplete = (holdGate === null || facts.hold.gateDirectoryRemoved === true)
    && facts.disposal.connectionClosed === true
    && facts.disposal.hostDisposed === true
    && facts.hold.cleanupFailures.length === 0
    && facts.hold.process.blockedWorkerSurvives !== true;
  if (facts.hold.cleanupFailures.length > 0) {
    const cleanupText = `the hold-producer cleanup recorded ${String(facts.hold.cleanupFailures.length)} failure(s)`;
    facts.inconclusive = facts.inconclusive
      ? { reason: `${facts.inconclusive.reason}; ${cleanupText}` }
      : { reason: cleanupText };
  }
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
    hold: facts.hold,
    // (P1-4) the §16.4 post-interrupt survival runtime facts and the
    // ADJUDICATED duty projection (the names the verdict actually consumed,
    // with the survival verdict applied) — in-memory executor facts like
    // `hold`; the persisted record carries them through the bounded duty
    // adjudication's names, never as raw fields.
    controlSurvival: facts.controlSurvival,
    adjudicatedDuties: projectedDuties,
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
    // (P2-3, round-18 re-review) the measurement evidence was frozen BEFORE
    // cleanup (the projection above); the persisted block carries the
    // VERIFIED teardown outcomes attached separately — the real
    // connection/host/gate cleanup results, never the pre-cleanup nulls.
    block: {
      ...projected,
      disposal: {
        ...projected.disposal,
        connectionClosed: facts.disposal.connectionClosed === true,
        hostDisposed: facts.disposal.hostDisposed === true,
        teardownLabel: typeof facts.disposal.teardownLabel === 'string' ? facts.disposal.teardownLabel : null,
      },
    },
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
  // (P2-2, round-23 codex review) the bounded frame-class diagnostics: the
  // server's own REQUESTS (method + id — never client-call resolutions,
  // never notifications) and the MALFORMED responses (both or neither of
  // result/error — never clearing the pending call). Bounded in-memory
  // diagnostics only, never projected into a record.
  const MAX_SERVER_REQUEST_DIAGNOSTIC_ENTRIES = 16;
  /** @type {{ method: string, receivedAtMs: number }[]} */
  const serverRequests = [];
  let malformedResponseCount = 0;
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
      // (P2-2, round-23 codex review) the SERVER-INITIATED REQUEST is its own
      // frame class: a JSON-RPC request carries the server's OWN id, which
      // can numerically collide with an outstanding client call id. It is
      // handled SEPARATELY — bounded diagnostics, never the notification
      // queue (a request is not a notification) — and NEVER resolves the
      // client call: matching a numeric id alone does not identify a
      // response, and the real reply that follows must still land.
      if (typeof frame.method === 'string' && frame.id !== undefined && frame.id !== null) {
        if (serverRequests.length < MAX_SERVER_REQUEST_DIAGNOSTIC_ENTRIES) {
          serverRequests.push({ method: frame.method, receivedAtMs: now() });
        }
        continue;
      }
      // A RESPONSE carries no method and EXACTLY ONE of `result` or `error`:
      // a frame with both (or neither) is malformed and leaves the client
      // call outstanding for its genuine reply or its typed deadline
      // failure — it never resolves or rejects it.
      const hasResultMember = frame.result !== undefined;
      const hasErrorMember = frame.error !== undefined && frame.error !== null;
      const isWellFormedResponse = typeof frame.method !== 'string' && hasResultMember !== hasErrorMember;
      if (pending !== null && frame.id === pending.id) {
        if (isWellFormedResponse !== true) {
          malformedResponseCount += 1;
          continue;
        }
        const current = pending;
        pending = null;
        current.entry.repliedAtMs = now();
        if (hasErrorMember) {
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
    // (P2-2, round-23 codex review) bounded in-memory frame-class
    // diagnostics (never persisted): the server's own requests, handled
    // separately from client-call responses and from notifications, and the
    // count of malformed response frames that were refused.
    protocolDiagnostics: () => ({
      serverRequests: serverRequests.map((entry) => ({ ...entry })),
      serverRequestsTruncated: serverRequests.length >= MAX_SERVER_REQUEST_DIAGNOSTIC_ENTRIES,
      malformedResponses: malformedResponseCount,
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
        // (P2-1, round-19 re-review) the host exit is CONFIRMED before
        // dispose reports success: the SIGKILL escalation is followed by a
        // BOUNDED exit wait — a host that ignores both signals is a named
        // disposal failure, never a silent hostDisposed:true while the
        // process still runs.
        let killFailed = false;
        try {
          child.kill('SIGKILL');
        } catch {
          killFailed = true;
        }
        if (!killFailed) {
          await new Promise((/** @type {(value: void) => void} */ resolve) => {
            const confirmTimer = setTimeout(resolve, killGraceMs);
            confirmTimer.unref?.();
            child.once('exit', () => {
              clearTimeout(confirmTimer);
              resolve();
            });
          });
        }
        if (child.exitCode === null && child.signalCode === null) {
          throw new Error('the owned host did not confirm its exit within the bounded disposal window (the SIGTERM/SIGKILL escalation did not end the process)');
        }
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
 * @param {{ launchConfirmedWindowHost?: any, observers?: any, dutyAdjudication?: any, stagingPrompt?: string, continuationPrompt?: string, now?: (() => number) | undefined, wallClockNow?: (() => number) | undefined, sleep?: ((ms: number) => Promise<void>) | undefined, waitUntil?: ((targetAbsMs: number) => Promise<void>) | undefined, redact?: (error: unknown) => string, hostLaunchDependencies?: any, liveLaunchContext?: any, preflight?: () => Promise<{ ok: boolean, reason: string | null } | { ok: boolean, reason: string }> }} [injected]
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
    liveLaunchContext: injected.liveLaunchContext ?? null,
  });
  const confirmedWindow = {
    controllerVersion: CONFIRMED_WINDOW_CONTROLLER_VERSION,
    block: result.block,
    // (round-4 P2) the persisted duty adjudication is the BOUNDED
    // WHITELISTED projection — extra diagnostics, private paths, credentials
    // and oversized names never ride the case record. (P1-4) the ADJUDICATED
    // projection (the choreography's own verdict applied, including the
    // §16.4 survival name) is what persists — never the raw injected object.
    duties: result.adjudicatedDuties ?? projectConfirmedWindowDutyAdjudication(injected.dutyAdjudication),
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
      held: { endedBeforeGate: null, cleanupLabel: 'confirmed-window-observation', gateReleased: null, cleanupComplete: result.hold?.cleanupComplete === true ? true : (result.hold?.cleanupComplete === false ? false : null), cleanupErrors: { count: (Array.isArray(result.hold?.cleanupFailures) ? result.hold.cleanupFailures.length : 0), reasons: [...(Array.isArray(result.hold?.cleanupFailures) ? result.hold.cleanupFailures : [])] } },
      excerpts: [],
      confirmedWindow,
      // The §41.5.1 hold-producer facts ride the in-memory executor result
      // only (the record projection never persists them — no version bump).
      hold: result.hold ?? null,
      // (P1-4) the §16.4 post-interrupt survival runtime facts ride the
      // in-memory executor result the same way (the verdict itself persists
      // through the adjudicated duty names).
      controlSurvival: result.controlSurvival ?? null,
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
    held: { endedBeforeGate: null, cleanupLabel: 'confirmed-window-observation', gateReleased: null, cleanupComplete: result.hold?.cleanupComplete === true ? true : (result.hold?.cleanupComplete === false ? false : null), cleanupErrors: { count: (Array.isArray(result.hold?.cleanupFailures) ? result.hold.cleanupFailures.length : 0), reasons: [...(Array.isArray(result.hold?.cleanupFailures) ? result.hold.cleanupFailures : [])] } },
    excerpts: [],
    confirmedWindow,
    hold: result.hold ?? null,
    controlSurvival: result.controlSurvival ?? null,
    inconclusive: result.inconclusive,
  };
}
