// @ts-check
/**
 * Opt-in closed-case CLI for the native shell long-wait qualification
 * (research-only). One selected case per invocation against the exact absolute
 * Codex executable recorded by the caller, inside a private output directory,
 * under a bounded observation/cleanup budget. `--budget-ms` is the probe's own
 * observation and cleanup bound — NEVER a production job timeout, and budget
 * cleanup is always labelled as budget cleanup, never as native interruption.
 *
 * Importing this module launches nothing: every host launch happens inside
 * {@link runShellWaitCase}, whose live path additionally requires
 * `ZCODE_SHELL_WAIT_E2E=1`. The printed case record is a bounded redacted JSON
 * object: private absolute paths, prompts, and raw host error text never enter
 * it; unclassifiable call bodies and assistant-message text are suppressed to
 * structural markers (they may carry private preparation/task content or echo
 * the private task prompt). Unknown facts are `null`, never `false` or zero.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { mkdir, readdir, readFile, lstat, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PUBLIC_RESULT_SENTINEL, SURVIVAL_CONTROL_LINE_COUNT, captureVerifiedProcessIdentity, createShellWaitFixture, inspectVerifiedProcessIdentity, releaseCompletionGate, survivalControlPromptDirective, terminateVerifiedProcess } from './fixture.mjs';
import { renderRescueLauncherCommand } from '../../scripts/lib/rescue-launcher-command.mjs';
import { runProcess } from '../../scripts/lib/process.mjs';
import { codexLaunch } from '../../scripts/lib/tool-launch.mjs';
import { parseCodexRolloutJsonl } from '../../tests/helpers/codex-rescue-qualification.mjs';
import { EXECUTING_EVIDENCE_SOURCE, interruptDeliveryAttributionGuard, admitInterruptHostDelivery, extractInterruptInteraction, INTERRUPT_TARGET_HEX_SHAPE, extractSurvivalControlFacts, inspectShellWaitEvidence, observeSpawnAcknowledgementIdentity, parseCallStatements, parseToolOutput, precedingStatementsCompleted, statementOutputAt, TERMINAL_INTERRUPT_PREVIOUS_STATUSES } from './evidence.mjs';
import { EXECUTING_CLOSURE_OBSERVATION_SOURCE, admitStdoutCapture, readDurableObligationSnapshot } from './closure-observation.mjs';
import { EXECUTING_RELEASE_QUALIFICATION_SOURCE, evaluateSurvivalControl, exactRescueForegroundRenderedExpectation } from './release-qualification.mjs';
import { EXECUTING_SHAPE_DIAGNOSTIC_SOURCE } from './shape-diagnostic.mjs';


const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const MAX_CASE_EXCERPTS = 64;
// Version tag of the observer-digest construction: bump when the hashed input
// combination changes so old records stay interpretable. v2 adds the
// controlled shape-diagnosis helper's module-init bytes (plan Task 2) —
// copying the v1 two-file hash would misattribute the new classifier. v3
// (codex review, release-qualification round) adds the release-qualification
// verdict helper's module-init bytes: with an exact terminal expectation the
// evidence adjudication EXECUTES that helper, so changing it alone must
// change the digest (and flip sourcesChangedDuringRun), never preserve them.
// v4 (2026-10-21 evidence-closure Task 2) adds the closure-observation
// helper's module-init bytes: the capture admission and read-side linkage
// EXECUTE during live observation (the default executor admits the §19.3
// stdout capture before the evidence adjudication), so every helper
// executing during observation enters the observer digest (plan §3).
// v5 (2026-10-21 evidence-closure Task 3) documents the construction change
// mandated by the same plan §3 duty: the §19.4 host-delivery admission, the
// spawn-acknowledgement identity selector, the interrupt-case durable
// settlement reader (the closure-observation owner-index resolution mode)
// and the live-launch preflight now EXECUTE during observation too — copying
// the v4 digest onto these bytes would misattribute the new observers.
const OBSERVER_DIGEST_TAG = 'zcode-shell-wait-observer-v5';

// P2 round-29: module-INIT snapshot of the EXECUTING observer source — the
// driver module body runs only after evidence.mjs has fully loaded, so this
// synchronous read (evidence's own init snapshot + this module's bytes)
// captures the code Node is actually executing. The awaited fixture
// build/install/setup that follows can edit the files on disk without
// changing this snapshot: the provenance digest always describes the code
// that actually adjudicates, and the record-time re-read detects any later
// edit (sourcesChangedDuringRun).
const EXECUTING_DRIVER_SOURCE = readFileSync(fileURLToPath(import.meta.url));
const EXECUTING_OBSERVER_PROVENANCE = Object.freeze({
  revision: 'working-tree-uncommitted',
  digest: createHash('sha256')
    .update(`${OBSERVER_DIGEST_TAG}\0`)
    .update(EXECUTING_EVIDENCE_SOURCE)
    .update('\0')
    .update(EXECUTING_SHAPE_DIAGNOSTIC_SOURCE)
    .update('\0')
    .update(EXECUTING_RELEASE_QUALIFICATION_SOURCE)
    .update('\0')
    .update(EXECUTING_CLOSURE_OBSERVATION_SOURCE)
    .update('\0')
    .update(EXECUTING_DRIVER_SOURCE)
    .digest('hex'),
  digestInput: `${OBSERVER_DIGEST_TAG} || evidence.mjs || shape-diagnostic.mjs || release-qualification.mjs || closure-observation.mjs || driver.mjs (executing module-init snapshot, NUL-separated)`,
  model: null,
  reachableToolFamily: null,
});
export { EXECUTING_OBSERVER_PROVENANCE };

/**
 * Provenance of the EXECUTING observer, computed from the ACTUAL instrument:
 * a stable sha256 over the module-INIT snapshot of the executing source (the
 * two instrument modules, evidence.mjs then driver.mjs, NUL-separated under
 * a version tag). Round-28: runShellWaitCase captures this digest at CASE
 * START and re-reads it at record time — a mid-run source change is recorded
 * as an explicit fact (sourcesChangedDuringRun + recordTimeDigest) and the
 * record stays attributed to the executing revision, never to newer bytes. This is deliberately SEPARATE from the fixture's committed
 * `sourceSha`: the fixture installs committed source, while the observer that
 * adjudicates the run may carry uncommitted corrections — exactly the
 * difference this digest must expose (plan R1/R5). Runtime facts the
 * instrument cannot actually observe (the executing model, the host's
 * runtime-reachable tool family) stay `null`, never inferred from hashes.
 * @returns {Promise<ShellWaitObserverProvenance>}
 */
export async function observerProvenance() {
  const [evidenceSource, shapeSource, releaseQualificationSource, closureObservationSource, driverSource] = await Promise.all([
    readFile(fileURLToPath(new URL('./evidence.mjs', import.meta.url))),
    readFile(fileURLToPath(new URL('./shape-diagnostic.mjs', import.meta.url))),
    readFile(fileURLToPath(new URL('./release-qualification.mjs', import.meta.url))),
    readFile(fileURLToPath(new URL('./closure-observation.mjs', import.meta.url))),
    readFile(fileURLToPath(new URL('./driver.mjs', import.meta.url))),
  ]);
  const digest = createHash('sha256')
    .update(`${OBSERVER_DIGEST_TAG}\0`)
    .update(evidenceSource)
    .update('\0')
    .update(shapeSource)
    .update('\0')
    .update(releaseQualificationSource)
    .update('\0')
    .update(closureObservationSource)
    .update('\0')
    .update(driverSource)
    .digest('hex');
  return {
    revision: 'working-tree-uncommitted',
    digest,
    digestInput: `${OBSERVER_DIGEST_TAG} || evidence.mjs || shape-diagnostic.mjs || release-qualification.mjs || closure-observation.mjs || driver.mjs (working-tree bytes, NUL-separated)`,
    model: null,
    reachableToolFamily: null,
  };
}

/**
 * Collect the observer provenance WITHOUT ever rejecting (P2-1 round-8): a
 * mid-trial read failure of an observer source yields an explicit
 * collection-failed provenance record (null digest, never a fabricated
 * value) plus the redacted failure message, so the caller's guaranteed
 * disposal path always runs.
 * @param {() => Promise<ShellWaitObserverProvenance>} provenanceReader
 * @param {ShellWaitFixtureHandle} fixture
 * @returns {Promise<{ provenance: ShellWaitObserverProvenance, failure: string | null }>}
 */
async function collectObserverProvenance(provenanceReader, fixture) {
  try {
    return { provenance: await provenanceReader(), failure: null };
  } catch (provenanceError) {
    const failure = redactPrivatePaths(provenanceError, fixture);
    return {
      provenance: {
        revision: 'collection-failed',
        digest: null,
        digestInput: null,
        model: null,
        reachableToolFamily: null,
        error: failure,
      },
      failure,
    };
  }
}

/**
 * Merge a provenance collection failure into a record's inconclusive reason
 * (kept null-safe: a clean record gains the reason; an already-inconclusive
 * record keeps both).
 * @param {{ reason: string } | null} inconclusive
 * @param {string} failure
 * @returns {{ reason: string }}
 */
function mergeProvenanceFailure(inconclusive, failure) {
  const detail = `the observer provenance could not be collected: ${failure}`;
  return inconclusive?.reason ? { reason: `${inconclusive.reason}; ${detail}` } : { reason: detail };
}

/**
 * Reconcile the CASE-START provenance with the record-time read (P2 round-28):
 * the record attributes the run to the revision that was on disk when the
 * observer initialized (the executing modules), and a mid-run source change
 * is RECORDED as an explicit fact (sourcesChangedDuringRun + the record-time
 * digest) instead of silently attributing the run to newer bytes. The R8
 * rules hold on every path: any read failure keeps a null digest, an
 * explicit collection-failed revision, and the redacted failure message.
 * @param {{ provenance: ShellWaitObserverProvenance, failure: string | null }} initial
 * @param {{ provenance: ShellWaitObserverProvenance, failure: string | null }} recordTime
 * @returns {{ provenance: ShellWaitObserverProvenance, failure: string | null, sourcesChangedDuringRun: boolean | null }}
 */
function reconcileObserverProvenance(initial, recordTime) {
  if (initial.failure !== null || recordTime.failure !== null) {
    const failure = initial.failure ?? recordTime.failure ?? 'the observer provenance could not be collected';
    return {
      provenance: {
        revision: 'collection-failed',
        digest: null,
        digestInput: null,
        model: null,
        reachableToolFamily: null,
        error: failure,
      },
      failure,
      sourcesChangedDuringRun: null,
    };
  }
  const sourcesChangedDuringRun = recordTime.provenance.digest !== initial.provenance.digest;
  /** @type {ShellWaitObserverProvenance} */
  const provenance = { ...initial.provenance, sourcesChangedDuringRun };
  if (sourcesChangedDuringRun) provenance.recordTimeDigest = /** @type {string} */ (recordTime.provenance.digest);
  return { provenance, failure: null, sourcesChangedDuringRun };
}

/** The documented closed case labels; the runner accepts exactly these. */
export const SHELL_WAIT_CASES = Object.freeze([
  'rescue-baseline', 'rescue-long', 'rescue-repeat', 'rescue-noise', 'rescue-interrupt',
  'review-wait', 'adversarial-review-wait', 'status-wait', 'background',
]);

/**
 * The frozen case/policy matrix (report §16.6 — the release-qualification
 * Task 2 implementation input): the config-default pair is valid for every
 * registered case, each with exactly one declared paragraph treatment.
 * `candidate-paragraph` cases apply the fixture's config-default waiting
 * paragraph to the named Role template and generic assignment skill;
 * `canonical-host-config` cases keep the installed canonical waiting
 * paragraph byte-identical and apply ONLY the host config (the fixture-home
 * cap key plus the driver's `-c` exec-default argv override), recording
 * canonical hash provenance. A future case label without a declared
 * combination stays unsupported and fails closed.
 */
export const SHELL_WAIT_WAIT_POLICY_CASES = Object.freeze({
  'rescue-baseline': 'canonical-host-config',
  'rescue-long': 'candidate-paragraph',
  'rescue-repeat': 'candidate-paragraph',
  'rescue-noise': 'candidate-paragraph',
  'rescue-interrupt': 'candidate-paragraph',
  'review-wait': 'canonical-host-config',
  'adversarial-review-wait': 'canonical-host-config',
  'status-wait': 'canonical-host-config',
  'background': 'candidate-paragraph',
});

/**
 * The I0 native short-window baseline selector (report §16.5/§16.6): ONE
 * closed value, valid ONLY for `rescue-interrupt` at the declared 60000
 * requested window with the config-default pair — the measured-baseline run
 * the interrupt responsiveness comparison may consume.
 */
export const INTERRUPT_BASELINE_SELECTOR_VALUE = 'short-window-60000';

/**
 * The I1 survival-control selector (report §16.4): ONE closed value, valid
 * ONLY for `rescue-interrupt` at the candidate 3600000 window with the
 * config-default pair. The command bytes of the declared unrelated control
 * are fixture-owned; the caller never supplies them.
 */
export const SURVIVAL_CONTROL_SELECTOR_VALUE = 'progress-terminal';

/** The I0 selector's declared requested window. */
const INTERRUPT_BASELINE_POLL_MS = 60_000;

/** The I1 selector's declared candidate observation window. */
const SURVIVAL_CONTROL_POLL_MS = 3_600_000;

/** @param {string} message @returns {TypeError} */
function invalidCaseInput(message) {
  return new TypeError(`Invalid shell wait case input: ${message}`);
}

/**
 * Per-case defaults for the shared duration arguments. `capMs: null` keeps the
 * fixture configuration unraised (the unraised-cap control shape), and Task 4's
 * cap-matched cases pass `--cap-ms 3600000` explicitly. `rescue-baseline`
 * preserves the 30000/60000 plain observation; every other foreground case
 * requests the candidate outer/inner policy with the documented 3600000 ms
 * request.
 * @param {string} label
 */
export function shellWaitCaseDefaults(label) {
  switch (label) {
    case 'rescue-baseline': return { workerDurationMs: 420_000, capMs: null, pollMs: 60_000, budgetMs: 720_000 };
    case 'rescue-long':
    case 'rescue-repeat':
    case 'rescue-interrupt': return { workerDurationMs: 420_000, capMs: null, pollMs: 3_600_000, budgetMs: 720_000 };
    case 'rescue-noise': return { workerDurationMs: 130_000, capMs: null, pollMs: 3_600_000, budgetMs: 360_000 };
    case 'review-wait':
    case 'adversarial-review-wait': return { workerDurationMs: 130_000, capMs: null, pollMs: 3_600_000, budgetMs: 360_000 };
    // The explicit Status query deadline is a status-wait-only fact: review and
    // adversarial-review default to NO statusQueryTimeoutMs, because fail-closed
    // validation refuses the field on every non-status case.
    case 'status-wait': return { workerDurationMs: 130_000, capMs: null, pollMs: 3_600_000, budgetMs: 360_000, statusQueryTimeoutMs: 240_000 };
    case 'background': return { workerDurationMs: 120_000, capMs: null, pollMs: 3_600_000, budgetMs: 300_000 };
    default: throw invalidCaseInput(`Unknown shell wait case: ${label}`);
  }
}

/** @param {string} value */
function hasControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

/** @param {string} value */
function assertAbsoluteNativeExecutable(value) {
  if (typeof value !== 'string' || value.length === 0 || hasControlCharacter(value)
    || !isAbsolute(value) || /\.(?:cmd|bat)$/i.test(value)) {
    throw invalidCaseInput('the exact Codex executable must be an absolute native executable path.');
  }
}

/** @param {string} value @param {string} option */
function assertAbsolutePath(value, option) {
  if (typeof value !== 'string' || value.length === 0 || hasControlCharacter(value) || !isAbsolute(value)) {
    throw invalidCaseInput(`the ${option} value must be an absolute path.`);
  }
}

/** @param {string} value @param {string} option */
function assertPositiveInteger(value, option) {
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    throw invalidCaseInput(`the ${option} value must be a positive integer number of milliseconds.`);
  }
}

/**
 * A positive integer bounded by the documented 3600000 maximum (plan Task 4):
 * the exec-default override's only permitted shape, matching the host's own
 * supported finite numeric transport.
 * @param {string} value @param {string} option
 */
function assertBoundedPositiveInteger(value, option) {
  assertPositiveInteger(value, option);
  if (Number(value) > 3_600_000) {
    throw invalidCaseInput(`the ${option} value must be a positive integer number of milliseconds no greater than 3600000.`);
  }
}

/** @param {string} label */
function assertKnownCase(label) {
  if (typeof label !== 'string' || !SHELL_WAIT_CASES.includes(label)) {
    throw invalidCaseInput(`unknown case ${JSON.stringify(label)}. Known cases: ${SHELL_WAIT_CASES.join(', ')}.`);
  }
}

/** @param {string} sourceSha */
function assertSourceSha(sourceSha) {
  if (typeof sourceSha !== 'string' || !/^[a-f0-9]{40}$/u.test(sourceSha)) {
    throw invalidCaseInput('the source SHA must be a 40-character lowercase hexadecimal commit SHA.');
  }
}

// The explicit model-selection seam (plan Task 2): a bounded safe identifier —
// alphanumeric first character, then name characters, dots, dashes and
// slashes, at most 64 characters. Shell metacharacters, whitespace, empty and
// overlength values are refused; the requested id is never interpolated into
// a shell and is forwarded only as its own `-m <id>` argv items.
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/u;

/** @param {unknown} model */
function assertModelIdentifier(model) {
  if (typeof model !== 'string' || !MODEL_ID_PATTERN.test(model)) {
    throw invalidCaseInput('the requested model must be a bounded safe identifier (alphanumeric first character; then letters, digits, dots, dashes, slashes; at most 64 characters).');
  }
}

/**
 * One closed-literal selector gate (report §16.4/§16.6): an absent selector
 * keeps legacy behavior byte-for-byte; a present one must be the exact
 * declared value.
 * @param {string | undefined} value @param {string} option @param {string} literal
 */
function assertSelectorLiteral(value, option, literal) {
  if (value !== undefined && value !== literal) {
    throw invalidCaseInput(`${option} only accepts the literal value ${literal}.`);
  }
}

/**
 * The §16.6 per-case policy combination and closed interrupt-selector gates,
 * shared verbatim by the CLI and programmatic boundaries. Runs AFTER the
 * individual field validations with the case-defaulted poll window, so the
 * declared per-selector windows are enforced on the effective value.
 * @param {{ case: string, pollMs: number, waitPolicy: string | null, interruptBaselineSelector: string | null, survivalControlSelector: string | null }} input
 */
function assertWaitPolicyCombination(input) {
  if (input.interruptBaselineSelector !== null && input.survivalControlSelector !== null) {
    throw invalidCaseInput('--interrupt-baseline-selector and --survival-control-selector are mutually exclusive: one run is either the I0 baseline or the I1 survival-control case, never both.');
  }
  if (input.waitPolicy !== null && !(input.case in SHELL_WAIT_WAIT_POLICY_CASES)) {
    throw invalidCaseInput(`--wait-policy config-default is not registered for the ${input.case} case: the closed §16.6 matrix declares every supported combination.`);
  }
  if (input.interruptBaselineSelector !== null) {
    if (input.waitPolicy !== 'config-default') {
      throw invalidCaseInput('--interrupt-baseline-selector requires the --wait-policy config-default --exec-default-ms pair.');
    }
    if (input.case !== 'rescue-interrupt') {
      throw invalidCaseInput('--interrupt-baseline-selector is only valid for the rescue-interrupt case.');
    }
    if (input.pollMs !== INTERRUPT_BASELINE_POLL_MS) {
      throw invalidCaseInput(`--interrupt-baseline-selector requires the declared ${String(INTERRUPT_BASELINE_POLL_MS)} requested window (pass --poll-ms ${String(INTERRUPT_BASELINE_POLL_MS)}): the I0 baseline is the native short-window shape, never a long-window run.`);
    }
  }
  if (input.survivalControlSelector !== null) {
    if (input.waitPolicy !== 'config-default') {
      throw invalidCaseInput('--survival-control-selector requires the --wait-policy config-default --exec-default-ms pair.');
    }
    if (input.case !== 'rescue-interrupt') {
      throw invalidCaseInput('--survival-control-selector is only valid for the rescue-interrupt case.');
    }
    if (input.pollMs !== SURVIVAL_CONTROL_POLL_MS) {
      throw invalidCaseInput(`--survival-control-selector requires the candidate ${String(SURVIVAL_CONTROL_POLL_MS)} observation window (rescue-interrupt default; pass --poll-ms ${String(SURVIVAL_CONTROL_POLL_MS)}).`);
    }
  }
}

/** @param {readonly string[]} argv @returns {ShellWaitCaseInput | { help: true }} */
export function parseShellWaitArguments(argv) {
  if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== 'string')) {
    throw invalidCaseInput('arguments must be an array of strings.');
  }
  if (argv.includes('--help')) return { help: true };
  /** @type {Record<string, string>} */
  const values = {};
  const known = ['--case', '--codex', '--source-sha', '--output', '--worker-duration-ms', '--cap-ms', '--poll-ms', '--budget-ms', '--status-query-timeout-ms', '--unclassified-structural-diagnostic', '--unclassified-shape-diagnostic', '--model', '--wait-policy', '--exec-default-ms', '--interrupt-baseline-selector', '--survival-control-selector'];
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === undefined || !known.includes(option) || value === undefined) {
      throw invalidCaseInput(`unknown option or missing value at argument ${index}: ${JSON.stringify(option)}. Known options: ${known.join(', ')}.`);
    }
    if (Object.hasOwn(values, option)) throw invalidCaseInput(`duplicate option: ${option}.`);
    values[option] = value;
  }
  for (const required of ['--case', '--codex', '--source-sha', '--output']) {
    if (values[required] === undefined) throw invalidCaseInput(`the ${required} argument is required.`);
  }
  assertKnownCase(/** @type {string} */ (values['--case']));
  assertAbsoluteNativeExecutable(/** @type {string} */ (values['--codex']));
  assertSourceSha(/** @type {string} */ (values['--source-sha']));
  assertAbsolutePath(/** @type {string} */ (values['--output']), '--output');
  for (const option of ['--worker-duration-ms', '--cap-ms', '--poll-ms', '--budget-ms', '--status-query-timeout-ms']) {
    if (values[option] !== undefined) assertPositiveInteger(values[option], option);
  }
  // The explicit Status query deadline is a status-wait-only fact (the real
  // command contract: --timeout-ms requires --wait on the explicitly owned
  // job); every other case refuses it fail-closed.
  if (values['--status-query-timeout-ms'] !== undefined && values['--case'] !== 'status-wait') {
    throw invalidCaseInput('--status-query-timeout-ms is only valid for the status-wait case.');
  }
  // The bounded-diagnostic research gate (follow-up plan Task 4): a marker
  // value, not a duration — only the literal `1` enables it, so the single
  // changed variable of a diagnostic run is unambiguous in the invocation.
  if (values['--unclassified-structural-diagnostic'] !== undefined
    && values['--unclassified-structural-diagnostic'] !== '1') {
    throw invalidCaseInput('--unclassified-structural-diagnostic only accepts the literal value 1.');
  }
  // The controlled shape-diagnosis gate (plan Task 2): the same literal-`1`
  // marker discipline, and it strictly REQUIRES the structural diagnostic —
  // the shape facts ride the same gated excerpt, never a separate channel.
  if (values['--unclassified-shape-diagnostic'] !== undefined
    && values['--unclassified-shape-diagnostic'] !== '1') {
    throw invalidCaseInput('--unclassified-shape-diagnostic only accepts the literal value 1.');
  }
  if (values['--unclassified-shape-diagnostic'] === '1' && values['--unclassified-structural-diagnostic'] !== '1') {
    throw invalidCaseInput('--unclassified-shape-diagnostic requires --unclassified-structural-diagnostic 1.');
  }
  // The explicit model-selection seam (plan Task 2 / report §15.1): a bounded
  // safe identifier, forwarded as a separate `-m <id>` argv item — never
  // arbitrary argv, never a silent default change. Absent → legacy behavior
  // (no `-m`, `model: null`) stays byte-for-byte unchanged.
  if (values['--model'] !== undefined) assertModelIdentifier(values['--model']);
  // The Task 4 config-default transport (plan Task 4 bullet 1): the pair is
  // valid ONLY together and ONLY for the rescue-long case. The policy value is
  // a closed literal (the literal-gate discipline), and the exec default is a
  // bounded positive integer — the supported finite numeric host override's
  // only permitted shape. Absent → legacy behavior byte-for-byte.
  if (values['--wait-policy'] !== undefined && values['--wait-policy'] !== 'config-default') {
    throw invalidCaseInput('--wait-policy only accepts the literal value config-default.');
  }
  if (values['--exec-default-ms'] !== undefined) {
    assertBoundedPositiveInteger(values['--exec-default-ms'], '--exec-default-ms');
  }
  if (values['--wait-policy'] !== undefined && values['--exec-default-ms'] === undefined) {
    throw invalidCaseInput('--wait-policy config-default requires --exec-default-ms.');
  }
  if (values['--exec-default-ms'] !== undefined && values['--wait-policy'] === undefined) {
    throw invalidCaseInput('--exec-default-ms requires --wait-policy config-default.');
  }
  // The closed interrupt selectors (report §16.4/§16.6): single literal
  // values, validated before the per-case combination gate below.
  assertSelectorLiteral(values['--interrupt-baseline-selector'], '--interrupt-baseline-selector', INTERRUPT_BASELINE_SELECTOR_VALUE);
  assertSelectorLiteral(values['--survival-control-selector'], '--survival-control-selector', SURVIVAL_CONTROL_SELECTOR_VALUE);
  const defaults = shellWaitCaseDefaults(/** @type {string} */ (values['--case']));
  const capMs = values['--cap-ms'] !== undefined ? Number(values['--cap-ms']) : defaults.capMs;
  const pollMs = values['--poll-ms'] !== undefined ? Number(values['--poll-ms']) : defaults.pollMs;
  if (values['--case'] === 'rescue-baseline' && pollMs !== 60_000) {
    throw invalidCaseInput('rescue-baseline preserves the plain 60000 observation; --poll-ms cannot change it.');
  }
  // The §16.6 per-case policy matrix: every registered case carries exactly
  // one declared combination (candidate paragraph vs canonical paragraph with
  // host-config-only application), and the closed interrupt selectors are
  // bound to their declared case and window — enforced on the EFFECTIVE poll
  // window (defaults applied), never on the raw argv.
  assertWaitPolicyCombination({
    case: /** @type {string} */ (values['--case']),
    pollMs,
    waitPolicy: values['--wait-policy'] ?? null,
    interruptBaselineSelector: values['--interrupt-baseline-selector'] ?? null,
    survivalControlSelector: values['--survival-control-selector'] ?? null,
  });
  return {
    case: /** @type {ShellWaitCaseLabel} */ (values['--case']),
    codexBinary: /** @type {string} */ (values['--codex']),
    sourceSha: /** @type {string} */ (values['--source-sha']),
    output: /** @type {string} */ (values['--output']),
    workerDurationMs: values['--worker-duration-ms'] !== undefined
      ? Number(values['--worker-duration-ms'])
      : defaults.workerDurationMs,
    capMs,
    pollMs,
    statusQueryTimeoutMs: values['--status-query-timeout-ms'] !== undefined
      ? Number(values['--status-query-timeout-ms'])
      : defaults.statusQueryTimeoutMs,
    budgetMs: values['--budget-ms'] !== undefined ? Number(values['--budget-ms']) : defaults.budgetMs,
    unclassifiedStructuralDiagnostic: values['--unclassified-structural-diagnostic'] === '1',
    unclassifiedShapeDiagnostic: values['--unclassified-shape-diagnostic'] === '1',
    model: values['--model'] ?? null,
    waitPolicy: values['--wait-policy'] ?? null,
    execDefaultMs: values['--exec-default-ms'] !== undefined ? Number(values['--exec-default-ms']) : null,
    interruptBaselineSelector: values['--interrupt-baseline-selector'] ?? null,
    survivalControlSelector: values['--survival-control-selector'] ?? null,
  };
}

/**
 * Run one closed shell wait case and return a bounded redacted case record.
 * The live path is opt-in: without `ZCODE_SHELL_WAIT_E2E=1` and without an
 * injected {@link ShellWaitDependencies.executeLiveCase} the function refuses
 * fail-closed and creates no fixture. Unknown facts in the record are `null`.
 * @param {ShellWaitCaseInput} input
 * @param {Partial<ShellWaitDependencies>} [dependencies]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runShellWaitCase(input, dependencies = {}) {
  const caseInput = validateCaseInput(input);
  const executeLiveCase = dependencies.executeLiveCase;
  if (!executeLiveCase && process.env.ZCODE_SHELL_WAIT_E2E !== '1') {
    return {
      status: 'refused',
      case: caseInput.case,
      reason: 'Live shell wait qualification requires ZCODE_SHELL_WAIT_E2E=1; no fixture was created and no host was launched.',
      executedAt: null,
    };
  }
  await assertCodexBinaryExists(caseInput.codexBinary);
  await assertOutputDirectoryExists(caseInput.output);
  const createFixture = dependencies.createFixture ?? createShellWaitFixture;
  const executeCase = executeLiveCase ?? defaultLiveExecutor;
  // The launched native executable's SHA-256 (codex gate round 5): pinned
  // for WAIT-POLICY runs only — legacy records keep their pinned provenance
  // schema (disclosed: no digest added there). A hashing failure resolves to
  // a null digest with the error recorded honestly; the comparison
  // adjudicator refuses a missing digest as missing identity evidence.
  const binaryDigest = caseInput.waitPolicy !== null ? await hashNativeExecutable(caseInput.codexBinary) : null;
  // P2-1 round-8: the provenance read is injectable (and failure-tolerant
  // below) so a mid-trial unreadable observer source can never bypass the
  // disposal guarantees.
  const provenanceReader = dependencies.observerProvenance ?? observerProvenance;
  const fixture = await createFixture({
    sourceRoot: repositoryRoot,
    sourceSha: caseInput.sourceSha,
    codexBinary: caseInput.codexBinary,
    output: caseInput.output,
    variant: caseVariantForRun(caseInput),
    commandSkillVariant: commandSkillVariantFor(caseInput.case, caseVariantForRun(caseInput)),
    capMs: caseInput.capMs,
    pollMs: caseInput.pollMs,
    // The Task 4 config-default transport: the fixture receives the closed
    // policy LABEL only — never the exec-default number, which reaches the
    // host exclusively as the composed `-c` argv override. Absent → the
    // legacy fixture input stays byte-for-byte unchanged.
    ...(caseInput.waitPolicy !== null ? { waitPolicy: caseInput.waitPolicy } : {}),
    // The §16.4 I1 survival-control support: the selector reaches the fixture
    // as the closed boolean flag only — the selector literal itself and every
    // command byte stay driver/fixture-owned. The fixture writes its OWN
    // bounded control script and records its closed facts.
    ...(caseInput.survivalControlSelector !== null ? { survivalControl: true } : {}),
    // Codex round 2: the registered stdout-capture requirement
    // (STDOUT_CAPTURE_REQUIRED_CASES — the §19.3(e) O1/I duty) ARMS the seam
    // at fixture preparation, so a required case can actually reach the host
    // instead of being refused by its own preflight. Task 4's ledger freeze
    // extends the closed set at the STDOUT_CAPTURE_REQUIRED_CASES definition;
    // this threading site needs no further edit.
    ...(STDOUT_CAPTURE_REQUIRED_CASES.has(caseInput.case) ? { stdoutCapture: true } : {}),
    // R3: the live status-wait case NEVER uses the fixture's owning-session
    // reservation — production selects explicit Status targets OWNER-SCOPED,
    // so the job must be created inside the live host session itself (the
    // case's turn-1 recorded launch). The fixture seam is instrument-level
    // test setup only; the explicit query timeout stays a driver-level fact
    // (the rendered turn-2 invocation), never a fixture reservation input.
  });
  // Codex self-review round 18: a DECLARED survival-control run whose
  // fixture handle lacks the control path must refuse BEFORE the launch —
  // the registered selector label is never silently spent without its §16.4
  // control (the directive would silently not ride the prompt and the
  // record would carry survivalControl: null). The disposal guarantee holds
  // on EVERY path after creation: the refusal rethrows only after the
  // fixture's own cleanup ran (a cleanup failure aggregates, mirroring the
  // executor-failure path below).
  try {
    if (caseInput.survivalControlSelector !== null
      && typeof /** @type {any} */ (fixture)?.survivalControlPath !== 'string') {
      throw invalidCaseInput('a declared survival-control run requires the fixture handle to expose a bounded survivalControlPath before launch.');
    }
  } catch (refusal) {
    try {
      await disposeFixture(fixture);
    } catch (disposalFailure) {
      throw new AggregateError([refusal, disposalFailure], `the shell wait case was refused and its fixture cleanup also failed: ${refusal instanceof Error ? refusal.message : String(refusal)}`);
    }
    throw refusal;
  }
  // P2 round-28: the observer digest is captured at CASE START — before any
  // observation runs — so the record attributes the run to the revision that
  // was on disk when the observer initialized. The record-time read then
  // DETECTS mid-run source changes (recorded as an explicit fact via
  // reconcileObserverProvenance) instead of silently attributing the run to
  // newer bytes.
  // P2 round-29: with the DEFAULT reader the case-start capture IS the
  // module-init snapshot (the executing source — the awaited fixture build
  // can no longer alter the attribution); an INJECTED reader is still read
  // at case start (the instrument-test seam).
  const initialProvenance = dependencies.observerProvenance === undefined
    ? { provenance: { ...EXECUTING_OBSERVER_PROVENANCE }, failure: null }
    : await collectObserverProvenance(provenanceReader, fixture);
  let liveFacts;
  try {
    liveFacts = await executeCase({ input: caseInput, fixture });
  } catch (error) {
    // A failed observation must not erase its evidence: when the executor
    // carries mapped live facts (cleanup errors, termination outcomes), the
    // redacted record is persisted BEFORE disposal and the error rethrown so
    // the CLI exits nonzero. Provenance collection is failure-tolerant (P2-1
    // round-8): a rejection is recorded as a null digest plus an inconclusive
    // reason and NEVER bypasses the disposal guarantee below.
    const liveFactsFromFailure = /** @type {any} */ (error)?.liveFacts;
    if (liveFactsFromFailure) {
      const recordTime = await collectObserverProvenance(provenanceReader, fixture);
      const { provenance, failure: provenanceFailure } = reconcileObserverProvenance(initialProvenance, recordTime);
      const record = buildCaseRecord(caseInput, fixture, liveFactsFromFailure, /** @type {'failed'} */ ('failed'), provenance, binaryDigest);
      if (provenanceFailure !== null) record.inconclusive = mergeProvenanceFailure(record.inconclusive, provenanceFailure);
      try {
        await disposeFixture(fixture);
        record.cleanup.fixtureDisposed = true;
      } catch (disposalFailure) {
        record.cleanup.fixtureDisposed = false;
        record.cleanup.disposalError = redactPrivatePaths(disposalFailure, fixture);
      }
      try {
        await writeCaseRecord(caseInput, fixture, record);
      } catch (writeFailure) {
        throw new AggregateError([error, writeFailure], `the shell wait case failed and its redacted record could not be written: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      // The fixture owns copied credentials and a detached worktree registration:
      // dispose runs on every path after creation, even when the case fails.
      try {
        await disposeFixture(fixture);
      } catch (disposalFailure) {
        throw new AggregateError([error, disposalFailure], `the shell wait case failed and its fixture cleanup also failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw error;
  }
  const recordTime = await collectObserverProvenance(provenanceReader, fixture);
  const { provenance, failure: provenanceFailure } = reconcileObserverProvenance(initialProvenance, recordTime);
  const record = buildCaseRecord(caseInput, fixture, liveFacts, 'executed', provenance, binaryDigest);
  if (provenanceFailure !== null) record.inconclusive = mergeProvenanceFailure(record.inconclusive, provenanceFailure);
  // Disposal completes before the record is persisted so the record carries the
  // ACTUAL disposal outcome; a failure is recorded fail-closed, never claimed.
  try {
    await disposeFixture(fixture);
    record.cleanup.fixtureDisposed = true;
  } catch (error) {
    record.cleanup.fixtureDisposed = false;
    record.cleanup.disposalError = redactPrivatePaths(error, fixture);
  }
  await writeCaseRecord(caseInput, fixture, record);
  return record;
}

/**
 * Scrub fixture-private absolute paths out of a failure message so the redacted
 * record can carry the outcome without leaking paths. Exported as an instrument
 * seam because every free-text reason that may embed a raw error (disposal
 * failures, rollout-collection failures) must pass through it.
 * @param {unknown} textOrError
 * @param {ShellWaitFixtureHandle} fixture
 */
export function redactPrivatePaths(textOrError, fixture) {
  const raw = textOrError instanceof Error ? textOrError.message : String(textOrError);
  const privates = [
    fixture.codexHome, fixture.workspace, fixture.installedRoot,
    join(fixture.codexHome, '..'), /** @type {string} */ (fixture.env?.HOME ?? ''),
  ].filter((value) => typeof value === 'string' && value.length > 0);
  let redacted = raw;
  for (const secret of privates) redacted = redacted.split(secret).join('<redacted>');
  return redacted.length > 512 ? `${redacted.slice(0, 512)}<truncated>` : redacted;
}

/**
 * The launched native executable's SHA-256 (codex gate round 5): a streamed
 * read of the caller-pinned absolute file — `--version` output reduces to
 * major.minor.patch and cannot establish native-executable equality. A read
 * failure resolves to a null digest with the failure recorded; the post-run
 * comparison treats a missing digest as missing identity evidence, never a
 * guess.
 * @param {string} absolutePath
 * @returns {Promise<{ digest: string | null, error: string | null }>}
 */
async function hashNativeExecutable(absolutePath) {
  try {
    const hash = createHash('sha256');
    const stream = createReadStream(absolutePath);
    for await (const chunk of stream) hash.update(chunk);
    return { digest: hash.digest('hex'), error: null };
  } catch (error) {
    return { digest: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** @param {ShellWaitCaseInput} input @returns {ValidatedShellWaitCase} */
function validateCaseInput(input) {
  if (!input || typeof input !== 'object') throw invalidCaseInput('the case input must be an object.');
  assertKnownCase(String(input.case));
  assertAbsoluteNativeExecutable(String(input.codexBinary));
  assertSourceSha(String(input.sourceSha));
  assertAbsolutePath(String(input.output), '--output');
  for (const [name, value] of [['workerDurationMs', input.workerDurationMs], ['budgetMs', input.budgetMs]]) {
    if (!Number.isSafeInteger(value) || /** @type {number} */ (value) <= 0) throw invalidCaseInput(`${name} must be a positive integer.`);
  }
  if (input.capMs !== null && (!Number.isSafeInteger(input.capMs) || /** @type {number} */ (input.capMs) <= 0)) {
    throw invalidCaseInput('capMs must be a positive integer or null (unraised).');
  }
  if (!Number.isSafeInteger(input.pollMs) || /** @type {number} */ (input.pollMs) <= 0) throw invalidCaseInput('pollMs must be a positive integer.');
  if (input.statusQueryTimeoutMs !== undefined
    && (!Number.isSafeInteger(input.statusQueryTimeoutMs) || /** @type {number} */ (input.statusQueryTimeoutMs) <= 0)) {
    throw invalidCaseInput('statusQueryTimeoutMs must be a positive integer.');
  }
  if (input.statusQueryTimeoutMs !== undefined && input.case !== 'status-wait') {
    throw invalidCaseInput('statusQueryTimeoutMs is only valid for the status-wait case.');
  }
  if (input.unclassifiedStructuralDiagnostic !== undefined
    && typeof input.unclassifiedStructuralDiagnostic !== 'boolean') {
    throw invalidCaseInput('unclassifiedStructuralDiagnostic must be a boolean when present.');
  }
  if (input.unclassifiedShapeDiagnostic !== undefined
    && typeof input.unclassifiedShapeDiagnostic !== 'boolean') {
    throw invalidCaseInput('unclassifiedShapeDiagnostic must be a boolean when present.');
  }
  if (input.unclassifiedShapeDiagnostic === true && input.unclassifiedStructuralDiagnostic !== true) {
    throw invalidCaseInput('unclassifiedShapeDiagnostic requires unclassifiedStructuralDiagnostic.');
  }
  if (input.model !== undefined && input.model !== null) assertModelIdentifier(input.model);
  // The Task 4 config-default transport (plan Task 4 bullet 1): the same
  // closed literal, bounded integer, pair and case gates as the CLI boundary,
  // enforced BEFORE any side effect (the caller's fixture creation).
  if (input.waitPolicy !== undefined && input.waitPolicy !== null && input.waitPolicy !== 'config-default') {
    throw invalidCaseInput('waitPolicy must be exactly "config-default" when present.');
  }
  if (input.execDefaultMs !== undefined && input.execDefaultMs !== null
    && (!Number.isSafeInteger(input.execDefaultMs) || /** @type {number} */ (input.execDefaultMs) <= 0 || /** @type {number} */ (input.execDefaultMs) > 3_600_000)) {
    throw invalidCaseInput('execDefaultMs must be a positive integer no greater than 3600000 when present.');
  }
  if ((input.waitPolicy ?? null) === 'config-default' && (input.execDefaultMs ?? null) === null) {
    throw invalidCaseInput('waitPolicy config-default requires execDefaultMs.');
  }
  if ((input.execDefaultMs ?? null) !== null && (input.waitPolicy ?? null) !== 'config-default') {
    throw invalidCaseInput('execDefaultMs requires waitPolicy "config-default".');
  }
  // The closed interrupt selectors (report §16.4/§16.6): programmatic mirror
  // of the CLI literal gate.
  if (input.interruptBaselineSelector !== undefined && input.interruptBaselineSelector !== null
    && input.interruptBaselineSelector !== INTERRUPT_BASELINE_SELECTOR_VALUE) {
    throw invalidCaseInput(`interruptBaselineSelector must be exactly "${INTERRUPT_BASELINE_SELECTOR_VALUE}" when present.`);
  }
  if (input.survivalControlSelector !== undefined && input.survivalControlSelector !== null
    && input.survivalControlSelector !== SURVIVAL_CONTROL_SELECTOR_VALUE) {
    throw invalidCaseInput(`survivalControlSelector must be exactly "${SURVIVAL_CONTROL_SELECTOR_VALUE}" when present.`);
  }
  // The §16.6 per-case policy matrix and selector windows: the same shared
  // combination gate as the CLI, enforced BEFORE any side effect.
  assertWaitPolicyCombination({
    case: /** @type {string} */ (input.case),
    pollMs: /** @type {number} */ (input.pollMs),
    waitPolicy: input.waitPolicy ?? null,
    interruptBaselineSelector: input.interruptBaselineSelector ?? null,
    survivalControlSelector: input.survivalControlSelector ?? null,
  });
  return {
    case: /** @type {ShellWaitCaseLabel} */ (input.case),
    codexBinary: /** @type {string} */ (input.codexBinary),
    sourceSha: /** @type {string} */ (input.sourceSha),
    output: /** @type {string} */ (input.output),
    workerDurationMs: /** @type {number} */ (input.workerDurationMs),
    capMs: /** @type {number | null} */ (input.capMs),
    pollMs: /** @type {number} */ (input.pollMs),
    statusQueryTimeoutMs: input.statusQueryTimeoutMs,
    budgetMs: /** @type {number} */ (input.budgetMs),
    unclassifiedStructuralDiagnostic: input.unclassifiedStructuralDiagnostic === true,
    unclassifiedShapeDiagnostic: input.unclassifiedShapeDiagnostic === true,
    model: input.model ?? null,
    waitPolicy: input.waitPolicy ?? null,
    execDefaultMs: input.execDefaultMs ?? null,
    interruptBaselineSelector: input.interruptBaselineSelector ?? null,
    survivalControlSelector: input.survivalControlSelector ?? null,
  };
}

/** @param {string} codexBinary */
async function assertCodexBinaryExists(codexBinary) {
  let metadata;
  try {
    metadata = await lstat(codexBinary);
  } catch (error) {
    throw invalidCaseInput(`the exact Codex executable recorded by the caller does not exist (${/** @type {NodeJS.ErrnoException} */ (error).code}).`);
  }
  if (!metadata.isFile()) throw invalidCaseInput('the exact Codex executable must be a regular file.');
}

/** @param {string} output */
async function assertOutputDirectoryExists(output) {
  const metadata = await lstat(output).catch((error) => {
    throw invalidCaseInput(`the output directory does not exist (${/** @type {NodeJS.ErrnoException} */ (error).code}).`);
  });
  if (!metadata.isDirectory()) throw invalidCaseInput('the output path must be a directory.');
}

/**
 * The fixture variant for a case: `rescue-baseline` keeps the unmodified
 * installed instructions (the cap-matched current-instruction control); every
 * other case requests the candidate waiting policy.
 * @param {ShellWaitCaseLabel} label */
function caseVariant(label) {
  return label === 'rescue-baseline' ? 'baseline' : 'candidate';
}

/**
 * The EFFECTIVE fixture variant for one run (release-qualification §16.6):
 * the canonical-host-config policy combinations (B/RV/AR/ST) keep the
 * canonical paragraph, so their variant stays `baseline` even for the
 * root-family labels whose LEGACY (no-policy) runs deliver the candidate
 * command-Skill paragraphs — a policy run must never install the candidate
 * paragraph or record its hash.
 * @param {ValidatedShellWaitCase} caseInput */
function caseVariantForRun(caseInput) {
  if (caseInput.waitPolicy !== null && SHELL_WAIT_WAIT_POLICY_CASES[caseInput.case] === 'canonical-host-config') {
    return /** @type {const} */ ('baseline');
  }
  return caseVariant(caseInput.case);
}

/**
 * The root-family instruction-delivery seam: the candidate waiting paragraph
 * is delivered to the isolated installed command Skills exactly when the case
 * is root-family AND the EFFECTIVE variant is candidate. Rescue cases never
 * touch the command Skills — their delivery surface is the Role/skill
 * assignment.
 * @param {ShellWaitCaseLabel} label @param {'baseline' | 'candidate'} variant */
function commandSkillVariantFor(label, variant) {
  return SHELL_WAIT_CASE_SPECS[label]?.family === 'root' && variant === 'candidate'
    ? /** @type {const} */ ('candidate')
    : /** @type {const} */ ('baseline');
}

/**
 * Compose the bounded redacted case record. Only whitelisted facts are copied;
 * fixture-private absolute paths can never enter the record, and unknown facts
 * stay `null`.
 * @param {ValidatedShellWaitCase} caseInput
 * @param {ShellWaitFixtureHandle} fixture
 * @param {ShellWaitLiveFacts} liveFacts
 * @param {'executed' | 'failed'} status
 * @param {ShellWaitObserverProvenance | null} observer the executing observer's
 *   own provenance, computed from the actual instrument at record-build time
 * @param {{ digest: string | null, error: string | null } | null} [binaryDigest]
 *   the launched native executable's SHA-256 (wait-policy runs only)
 * @returns {ShellWaitCaseRecord}
 */
function buildCaseRecord(caseInput, fixture, liveFacts, /** @type {'executed' | 'failed'} */ status = 'executed', observer = null, binaryDigest = null) {
  const fixtureRecord = /** @type {any} */ (fixture).record ?? {};
  const appliedArtifacts = Array.isArray(fixtureRecord.appliedArtifacts) ? fixtureRecord.appliedArtifacts : [];
  return {
    status,
    case: caseInput.case,
    executedAt: new Date().toISOString(),
    // The bounded-diagnostic research gate (follow-up plan Task 4): recorded
    // ONLY when enabled, so the single changed variable of a diagnostic run is
    // visible in the persisted record and default records keep the pinned schema.
    // The controlled shape-diagnosis gate (plan Task 2) rides the same record;
    // the shape facts' own schema version (SHAPE_DIAGNOSTIC_SCHEMA_VERSION = 1)
    // is the closed version marker inside the projected `shape` fact block.
    ...(caseInput.unclassifiedStructuralDiagnostic === true ? { unclassifiedStructuralDiagnostic: true } : {}),
    ...(caseInput.unclassifiedShapeDiagnostic === true ? { unclassifiedShapeDiagnostic: true } : {}),
    provenance: {
      sourceSha: caseInput.sourceSha,
      sourceWorktreeOwnedByFixture: true,
      // The executing observer's revision/digest is a SEPARATE fact from the
      // fixture sourceSha: the fixture installs committed source while the
      // observer may carry uncommitted corrections. Missing runtime facts
      // (model, reachable tool family) stay null, never inferred.
      observer: observer ?? null,
      codexVersion: liveFacts.codexVersion ?? null,
      plugin: { identity: 'zcode@vitry', version: fixtureRecord.pluginVersion ?? null },
      fixtureVariant: /** @type {any} */ (fixtureRecord.variant) ?? caseVariant(caseInput.case),
      requestedCapMs: caseInput.capMs ?? null,
      requestedPollMs: caseInput.pollMs ?? null,
      requestedWorkerDurationMs: caseInput.workerDurationMs ?? null,
      requestedBudgetMs: caseInput.budgetMs ?? null,
      // The REQUESTED model selection (plan Task 2): recorded separately from
      // every effective host/Child model metadata, which stays unknown/null
      // (never inferred). Omitted entirely when the flag is absent so legacy
      // records stay byte-for-byte unchanged.
      ...(caseInput.model ? { requestedModel: caseInput.model } : {}),
      // The Task 4 config-default transport (plan Task 4 bullet 1): recorded
      // ONLY when the pair is active — the closed policy literal plus the
      // validated host-override number and the fixture's path-normalized
      // instruction hashes (absent → legacy records stay byte-for-byte
      // unchanged). The effective host-side settlement stays unknown here:
      // this block records the REQUESTED transport, never an observed effect.
      ...(caseInput.waitPolicy !== null ? {
        waitPolicy: {
          policy: caseInput.waitPolicy,
          execDefaultMs: caseInput.execDefaultMs ?? null,
          // The §16.6 paragraph-treatment provenance (which paragraph the
          // instruction hashes describe): mirrored from the fixture block
          // when the fixture recorded it — candidate-paragraph vs
          // canonical-host-config. A fixture block without the field (legacy
          // shapes) keeps this record schema unchanged.
          ...(typeof /** @type {any} */ (fixtureRecord).waitPolicy?.paragraphTreatment === 'string'
            ? { paragraphTreatment: /** @type {any} */ (fixtureRecord).waitPolicy.paragraphTreatment }
            : {}),
          instructions: /** @type {any} */ (fixtureRecord).waitPolicy ?? null,
        },
      } : {}),
      // The launched native executable's SHA-256 (codex gate round 5):
      // `--version`-derived versions cannot establish native-executable
      // equality, so the wait-policy record pins the binary digest the same
      // way the Task 1 pin procedure hashed it. A hashing failure is null
      // WITH the error recorded — the comparison refuses a missing digest as
      // missing identity evidence. Absent entirely for legacy runs.
      ...(caseInput.waitPolicy !== null ? {
        codexBinarySha256: binaryDigest?.digest ?? null,
        codexBinarySha256Error: binaryDigest?.error ?? null,
      } : {}),
      // R3 status-wait setup: the RESERVED owned job (returned by the
      // production command path) and the explicit Status query deadline the
      // rendered invocation carries. A non-status case records nulls.
      requestedStatusQueryTimeoutMs: caseInput.statusQueryTimeoutMs ?? null,
      statusJob: fixtureRecord.ownedStatusJob ?? null,
      sandbox: 'dangerously-bypassed (fixture control, not persisted production trust)',
      hooksTrust: 'bypassed (fixture control, not persisted production trust)',
      isolatedSetup: fixtureRecord.isolatedSetup ?? null,
      instructionVariants: {
        appliedArtifacts,
        namedRoleSha256: fixtureRecord.renderedNamedRoleSha256 ?? fixtureRecord.namedRoleSha256 ?? null,
        genericMessageSha256: fixtureRecord.genericMessageSha256 ?? null,
        // The root-family delivery seam (R2): the isolated installed command
        // Skills' variant hashes/diffs. Delivered Skill text is the Root
        // instruction-delivery proof — never the requested cap/poll values.
        commandSkillVariants: fixtureRecord.commandSkillVariants ?? null,
      },
    },
    route: { requested: liveFacts.route?.requested ?? caseRoute(caseInput.case), actual: liveFacts.route?.actual ?? null },
    linkage: {
      childLinkageChecked: liveFacts.linkage?.checked ?? null,
      mode: liveFacts.linkage?.mode ?? null,
      rootThreadId: liveFacts.linkage?.rootThreadId ?? null,
      childThreadId: liveFacts.linkage?.childThreadId ?? null,
      parentThreadId: liveFacts.linkage?.parentThreadId ?? null,
      companionLaunchCount: liveFacts.linkage?.companionLaunchCount ?? null,
      companionSendCount: liveFacts.linkage?.companionSendCount ?? null,
      originalHandleChecked: liveFacts.linkage?.originalHandleChecked ?? null,
    },
    observations: {
      outerReturns: liveFacts.observations?.outerReturns ?? null,
      modelCalls: liveFacts.observations?.modelCalls ?? null,
      rootJoins: liveFacts.observations?.rootJoins ?? null,
      decisiveWallMs: liveFacts.observations?.decisiveWallMs ?? null,
      // Per-poll wall times (P2-1 review fix): retained so a cap-limited
      // return's duration is separately measurable in every future trial.
      pollWallTimesMs: liveFacts.observations?.pollWallTimesMs ?? null,
      pollStartedAtElapsedMs: liveFacts.observations?.pollStartedAtElapsedMs ?? null,
      holdDeadlineElapsedMs: liveFacts.observations?.holdDeadlineElapsedMs ?? null,
      remainingLifetimeMs: liveFacts.observations?.remainingLifetimeMs ?? null,
      remainingLifetimeBasis: liveFacts.observations?.remainingLifetimeBasis ?? null,
      pendingInnerAtEnd: liveFacts.observations?.pendingInnerAtEnd ?? null,
    },
    result: {
      processExit: liveFacts.hostResult?.companionProcessExit ?? null,
      hostExit: liveFacts.hostResult?.exitCode ?? null,
      publicResultMatchedSentinel: liveFacts.hostResult?.sentinelMatched ?? null,
      terminalStdoutChecked: liveFacts.hostResult?.terminalStdoutChecked ?? null,
      resultCheck: liveFacts.hostResult?.resultCheck ?? null,
      resultCheckLabel: liveFacts.hostResult?.resultCheckLabel ?? null,
      // The byte-exact terminal/exit linkage verdict (release-qualification
      // Task 2): persisted only when the live facts carried one, so legacy
      // records keep their pinned schema.
      ...(liveFacts.hostResult?.exactTerminalMatch !== undefined
        ? { exactTerminalMatch: liveFacts.hostResult.exactTerminalMatch }
        : {}),
      // 2026-10-21 evidence-closure Task 2: the bounded stdout-capture
      // admission provenance (statuses/digests only — never paths, never
      // bytes), persisted only when the fixture carried the capture seam.
      ...(/** @type {any} */ (liveFacts.hostResult)?.stdoutCapture !== undefined
        ? { stdoutCapture: /** @type {any} */ (liveFacts.hostResult).stdoutCapture }
        : {}),
    },
    // R4: the interrupt block carries either measured interaction facts or an
    // explicit investigated reason. Unknown optional facts stay null — never
    // a fabricated delivery — and the cleanup contract keeps its explicit
    // nativeInterruptionClaimed:false marker.
    interrupt: {
      requested: liveFacts.interrupt?.requested ?? caseInput.case === 'rescue-interrupt',
      attempted: liveFacts.interrupt?.attempted ?? null,
      family: liveFacts.interrupt?.family ?? null,
      delivered: liveFacts.interrupt?.delivered ?? null,
      rejection: liveFacts.interrupt?.rejection ?? null,
      previousStatus: liveFacts.interrupt?.previousStatus ?? null,
      callCount: liveFacts.interrupt?.callCount ?? null,
      orderingBound: liveFacts.interrupt?.orderingBound ?? null,
      target: liveFacts.interrupt?.target ?? null,
      exactTargetMatch: liveFacts.interrupt?.exactTargetMatch ?? null,
      ...(liveFacts.interrupt?.exactTargetMatchBasis != null ? { exactTargetMatchBasis: liveFacts.interrupt.exactTargetMatchBasis } : {}),
      settled: liveFacts.interrupt?.settled ?? null,
      settledBasis: liveFacts.interrupt?.settledBasis ?? null,
      pendingIntervalMs: liveFacts.interrupt?.pendingIntervalMs ?? null,
      deliveryToSettlementMs: liveFacts.interrupt?.deliveryToSettlementMs ?? null,
      timingBasis: liveFacts.interrupt?.timingBasis ?? null,
      missingPrerequisite: liveFacts.interrupt?.missingPrerequisite ?? null,
      // Codex overall review fix 3: the cleanup boundary and cancellation
      // timestamp behind the settlement attribution persist ONLY when the
      // live facts carried them — legacy records stay byte-identical — so
      // the boundary-vs-marker comparison is re-verifiable offline.
      // 2026-10-21 evidence-closure Task 3 (schema-additive, attempted
      // interrupt runs only): the closed pending-window / ordering /
      // cleanup-attribution facts and the §19.4 host-delivery admission
      // block (bounded closed facts, never call text or aliases) so the
      // offline Gate D join re-verifies every layer after fixture disposal.
      ...(liveFacts.interrupt?.attempted === true && liveFacts.interrupt?.pendingWindowObserved !== undefined
        ? { pendingWindowObserved: liveFacts.interrupt.pendingWindowObserved === true }
        : {}),
      // Codex round 2: the unreadable-continuation fact the Gate D join
      // consumes persists beside the record (schema-additive, attempted
      // runs only) — the offline join keeps the rejection after fixture
      // disposal instead of reporting a hand-supplied false.
      ...(liveFacts.interrupt?.attempted === true && liveFacts.interrupt?.unreadableContinuationObserved !== undefined
        ? { unreadableContinuationObserved: liveFacts.interrupt.unreadableContinuationObserved === true }
        : {}),
      ...(liveFacts.interrupt?.attempted === true && liveFacts.interrupt?.settlementCleanupGenerated !== undefined
        ? { settlementCleanupGenerated: liveFacts.interrupt.settlementCleanupGenerated === true }
        : {}),
      ...(liveFacts.interrupt?.attempted === true && liveFacts.interrupt?.hostDelivery !== undefined
        ? { hostDelivery: liveFacts.interrupt.hostDelivery }
        : {}),
      // 2026-10-23 interrupt-closure Task 2 (schema-additive, abort-case runs
      // only): the §23.4 versioned partial-facts block — the spawn
      // acknowledgement identity, the capture-vs-admission distinction and
      // the source-rollout digest under the NEW adjudicator version, never
      // the live observer's stamp — so offline readers keep the layer facts
      // that survive an aborted evidence adjudication.
      ...(liveFacts.interrupt?.partialFacts !== undefined && liveFacts.interrupt?.partialFacts !== null
        ? { partialFacts: liveFacts.interrupt.partialFacts }
        : {}),
      ...(typeof liveFacts.interrupt?.cleanupBoundaryAtMs === 'number' ? { cleanupBoundaryAtMs: liveFacts.interrupt.cleanupBoundaryAtMs } : {}),
      ...(typeof liveFacts.interrupt?.cancelledAtMs === 'number' ? { cancelledAtMs: liveFacts.interrupt.cancelledAtMs } : {}),
      ...(typeof liveFacts.interrupt?.completedBeforeCallMs === 'number' ? { completedBeforeCallMs: liveFacts.interrupt.completedBeforeCallMs } : {}),
      ...(typeof liveFacts.interrupt?.completedAfterCallMs === 'number' ? { completedAfterCallMs: liveFacts.interrupt.completedAfterCallMs } : {}),
    },
    // The §16.4 I1 survival-control provenance: the record carries the closed
    // selector ONLY when it was requested, the projected §16.4 whitelist
    // facts ONLY when an executor supplied them (an offline/unobserved run
    // records null, never a fabricated control outcome), and the fixture's
    // DECLARATION block (script digest, line count, cadence, tag clock) when
    // the fixture recorded one — the fixture root is disposed after the run,
    // so the binding to the exact control-script bytes must outlive it.
    ...(caseInput.survivalControlSelector !== null ? {
      survivalControlSelector: caseInput.survivalControlSelector,
      survivalControl: /** @type {any} */ (liveFacts).survivalControl ?? null,
      // Codex review round 12: the bounded whitelisted oracle inputs persist
      // beside the versioned verdict for offline re-adjudication.
      ...(Array.isArray(/** @type {any} */ (liveFacts).survivalControlInputs) || (typeof /** @type {any} */ (liveFacts).survivalControlInputs === 'object' && /** @type {any} */ (liveFacts).survivalControlInputs !== null)
        ? { survivalControlInputs: /** @type {any} */ (liveFacts).survivalControlInputs }
        : {}),
      ...(fixtureRecord.survivalControl ? { survivalControlDeclaration: fixtureRecord.survivalControl } : {}),
    } : {}),
    // Codex overall review round 2 (finding 2): the capture-enabled fixture's
    // BOUNDED tap declaration (preload name + SHA-256, maxBytes, the
    // invocation gate selector, the nonce-binding environment-variable seams
    // — digests and closed configuration, never the private fixture paths)
    // persists beside the capture provenance, mirroring the
    // survivalControlDeclaration pattern: fixture disposal deletes the
    // preload, and the retained record must keep the separately recorded tap
    // provenance (the admission projection carries only the captured-output
    // digest). A capture-less fixture records no declaration key (schema
    // stability).
    ...(fixtureRecord.closureStdoutCapture ? { stdoutCaptureDeclaration: fixtureRecord.closureStdoutCapture } : {}),
    held: {
      endedBeforeGate: liveFacts.held?.endedBeforeGate ?? null,
      cleanupLabel: liveFacts.held?.cleanupLabel ?? null,
      gateReleased: liveFacts.held?.gateReleased ?? null,
      timeline: /** @type {any} */ (liveFacts.held)?.timeline ?? null,
      cleanupErrors: {
        count: typeof liveFacts.held?.cleanupErrors?.count === 'number' ? liveFacts.held.cleanupErrors.count : 0,
        reasons: Array.isArray(liveFacts.held?.cleanupErrors?.reasons) ? liveFacts.held.cleanupErrors.reasons : [],
      },
      processTermination: {
        verifiedTerminated: typeof liveFacts.held?.processTermination?.verifiedTerminated === 'boolean' ? liveFacts.held.processTermination.verifiedTerminated : null,
        codexTerminated: typeof liveFacts.held?.processTermination?.codexTerminated === 'boolean' ? liveFacts.held.processTermination.codexTerminated : null,
      },
    },
    // R3 background lifecycle: the measured Child-side settlement facts behind
    // the Root acknowledgement (the launched-Child acknowledgement is never
    // confused with the Child's terminal completion). Release-qualification
    // Task 2: the three-way settlement layer split (remote terminal / local
    // process reaping / durable obligations) is mirrored ONLY when the live
    // facts carried it — held records without layers keep the persisted
    // schema unchanged.
    child: {
      settlement: /** @type {any} */ (liveFacts.child)?.settlement ?? null,
      rootAcknowledgementAtElapsedMs: /** @type {any} */ (liveFacts.child)?.rootAcknowledgementAtElapsedMs ?? null,
      settlementDetectedAtElapsedMs: /** @type {any} */ (liveFacts.child)?.settlementDetectedAtElapsedMs ?? null,
      ...(/** @type {any} */ (liveFacts.child)?.settlementLayers !== undefined
        ? { settlementLayers: /** @type {any} */ (liveFacts.child).settlementLayers }
        : {}),
      // 2026-10-21 evidence-closure Task 2: the typed passive durable
      // snapshot (per-layer facts and named reasons) persists beside the
      // settlement layers ONLY when the live facts carried it — held records
      // without a supplier keep the persisted schema unchanged.
      ...(/** @type {any} */ (liveFacts.child)?.durableSnapshot !== undefined
        ? { durableSnapshot: redactDurableSnapshotForRecord(/** @type {any} */ (liveFacts.child).durableSnapshot, fixture) }
        : {}),
      // 2026-10-23 interrupt-closure Task 3 (report §23.5): the pre-cleanup
      // sampling block persists beside the snapshot (same bounded redaction —
      // the summaries' reason texts and duty layers can embed private paths)
      // ONLY when the live facts carried it.
      ...(/** @type {any} */ (liveFacts.child)?.durableSamples !== undefined
        ? { durableSamples: redactDurableSnapshotForRecord(/** @type {any} */ (liveFacts.child).durableSamples, fixture) }
        : {}),
    },
    // R3 status-wait live flow: the observed launch acknowledgement and the
    // Status query bound together (same session, exact ID match, explicit
    // timeout), with the fail-closed validation verdict. Job IDs are public
    // rendered surfaces (the acknowledgement and renderJob print them).
    statusQuery: /** @type {any} */ (liveFacts).statusQuery ?? null,
    // The Task 4 comparison marker (plan Task 4 bullet 3): the closed
    // decisive-poll pragma fact rides ONLY waitPolicy records — a marker
    // arriving without the validated pair is dropped fail-closed, and legacy
    // records keep their pinned schema.
    ...(caseInput.waitPolicy !== null && /** @type {any} */ (liveFacts).waitPolicyObservation
      ? { waitPolicyObservation: /** @type {any} */ (liveFacts).waitPolicyObservation }
      : {}),
    cleanup: {
      label: liveFacts.held?.cleanupLabel ?? null,
      nativeInterruptionClaimed: false,
      fixtureDisposed: null,
      disposalError: null,
      cleanupComplete: typeof liveFacts.held?.cleanupComplete === 'boolean' ? liveFacts.held.cleanupComplete : null,
      cleanupErrorCount: Array.isArray(liveFacts.held?.cleanupErrors?.reasons) ? liveFacts.held.cleanupErrors.reasons.length : 0,
    },
    evidence: {
      ...evidenceExcerpts(liveFacts.excerpts),
      // Excerpt count and collection count answer different questions.
      rolloutCount: liveFacts.collection?.rolloutCount ?? null,
      childToolCallCount: liveFacts.collection?.childToolCallCount ?? null,
      truncated: evidenceExcerpts(liveFacts.excerpts).truncated || liveFacts.collection?.truncated === true,
    },
    inconclusive: liveFacts.inconclusive ?? null,
  };
}

/** @param {unknown} excerpts @returns {{ count: number, truncated: boolean, excerpts: unknown[] }} */
function evidenceExcerpts(excerpts) {
  if (!Array.isArray(excerpts)) return { count: 0, truncated: false, excerpts: [] };
  const bounded = excerpts.slice(0, MAX_CASE_EXCERPTS);
  return { count: bounded.length, truncated: excerpts.length > bounded.length, excerpts: bounded };
}

/**
 * Write the redacted record into the caller's private output directory, which
 * must stay outside every fixture credential home.
 * @param {ValidatedShellWaitCase} caseInput
 * @param {ShellWaitFixtureHandle} fixture
 * @param {Record<string, unknown>} record
 */
async function writeCaseRecord(caseInput, fixture, record) {
  const codexHome = String(/** @type {any} */ (fixture).codexHome ?? '');
  const workspace = String(/** @type {any} */ (fixture).workspace ?? '');
  for (const home of [codexHome, workspace]) {
    if (home && pathWithin(home, caseInput.output)) {
      throw invalidCaseInput('the output directory must stay outside the fixture credential homes.');
    }
  }
  const recordPath = join(caseInput.output, `${caseInput.case}.record.json`);
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/**
 * The persisted shape of the typed durable snapshot (codex round 1): a
 * bounded deep clone whose string values are redacted through
 * {@link redactPrivatePaths} — the reader's raw projection carries absolute
 * private paths (job.projection.workspace, reason texts embedding fs error
 * paths) which never persist. Depth and fan-out are bounded; non-serializable
 * values are dropped fail-closed.
 * @param {unknown} value @param {ShellWaitFixtureHandle} fixture
 * @param {number} [depth]
 * @returns {unknown}
 */
function redactDurableSnapshotForRecord(value, fixture, depth = 0) {
  if (typeof value === 'string') return redactPrivatePaths(value, fixture);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (depth >= 8) return null;
  if (Array.isArray(value)) return value.slice(0, 64).map((entry) => redactDurableSnapshotForRecord(entry, fixture, depth + 1));
  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const redacted = {};
    for (const [key, entry] of Object.entries(value).slice(0, 64)) {
      redacted[key] = redactDurableSnapshotForRecord(entry, fixture, depth + 1);
    }
    return redacted;
  }
  return null;
}

/** @param {ShellWaitFixtureHandle} fixture */
async function disposeFixture(fixture) {
  const dispose = /** @type {any} */ (fixture).dispose;
  if (typeof dispose !== 'function') throw new Error('the fixture handle must expose dispose()');
  await dispose();
}

/**
 * Whether the case's held turn stays open for the bounded Child-settlement
 * watch (release-qualification Task 2): the rescue-foreground cases extend
 * their observation ONLY as needed to capture the exact Child/Companion
 * settlement after Root's join, within the same declared budget;
 * `background` already watches (the Root acknowledgement ends its turn
 * early). `rescue-interrupt` is excluded — its post-delivery settlement
 * evidence comes from the interrupt machinery, and a completion-shaped watch
 * could only burn budget waiting for an exit code an interrupted turn never
 * produces. Status runs its own deadline-only flow; root-family commands
 * keep their renderer contracts.
 * @param {ShellWaitCaseLabel} caseLabel
 */
export function runsChildSettlementWatch(caseLabel) {
  const spec = SHELL_WAIT_CASE_SPECS[caseLabel];
  if (!spec) throw invalidCaseInput(`unknown shell wait case: ${String(caseLabel)}`);
  if (spec.backgroundFlow === true) return true;
  return spec.family === 'rescue' && spec.rootJoinsChild === true && caseLabel !== 'rescue-interrupt';
}

/**
 * The Root route a case requests from its prompt shape; the actual route stays
 * unknown until the live run observes it.
 * @param {ShellWaitCaseLabel} label */
function caseRoute(label) {
  switch (label) {
    case 'review-wait': return 'review-wait';
    case 'adversarial-review-wait': return 'adversarial-review-wait';
    case 'status-wait': return 'status-wait';
    case 'background': return 'rescue-background';
    default: return 'rescue-foreground';
  }
}

/** @param {string} root @param {string} path */
function pathWithin(root, path) {
  const descendant = relative(root, path);
  return descendant === '' || (descendant !== '..' && !descendant.startsWith(`..${sep}`) && !isAbsolute(descendant));
}


/**
 * Bounded host/gate lifecycle for one held observation turn. The completion
 * gate is released by this instrument (experiment control) — never a production
 * timeout. Cleanup always releases the gate, terminates only the exact verified
 * fake-ZCode process, and terminates the controlled host; every cleanup is
 * labelled and budget expiry is never labelled native interruption.
 * @param {HeldTurnInput} input
 * @returns {Promise<HeldTurnRecord>}
 */
export async function runHeldHostTurn(input) {
  const sleep = input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // The default clock is Node's MONOTONIC performance.now() (never the
  // wall-clock Date.now(), which can step under NTP/clock changes): every
  // timeline value and budget comparison is a difference on this one clock.
  // Instrument tests can inject a deterministic `now` instead.
  const now = input.now ?? (() => performance.now());
  const releaseGate = input.releaseGate ?? releaseCompletionGate;
  const captureProcessIdentity = input.captureProcessIdentity ?? (async () => {
    return captureVerifiedProcessIdentity(/** @type {string} */ (input.processPath), /** @type {string} */ (input.processNonce));
  });
  const readProcessIdentity = input.readProcessIdentity ?? (async (expected) => {
    const observed = await inspectVerifiedProcessIdentity(/** @type {any} */ (expected).pid, /** @type {any} */ (expected).nonce);
    if (!observed) return undefined;
    if (observed.ppid !== /** @type {any} */ (expected).ppid || observed.startIdentity !== /** @type {any} */ (expected).startIdentity) {
      throw new Error('the exact fake-ZCode process identity changed');
    }
    return observed;
  });
  const waitForProcessExit = input.waitForProcessExit ?? (async (expected, phase) => {
    const deadline = now() + (phase === 'natural' ? 10_000 : 5_000);
    while (now() < deadline) {
      if (await readProcessIdentity(expected) === undefined) return;
      await sleep(50);
    }
    throw new Error(`the exact fake-ZCode process remained alive during ${phase}`);
  });
  const terminateProcessIdentity = input.terminateProcessIdentity ?? (async (expected) => {
    return terminateVerifiedProcess(/** @type {any} */ (expected), { readIdentity: readProcessIdentity, waitForExit: (expectedIdentity, phase) => waitForProcessExit(expectedIdentity, phase) });
  });

  const startMs = now();
  const budgetDeadlineMs = startMs + input.budgetMs;
  // The held-phase timeline on ONE documented comparable clock: elapsed
  // milliseconds measured from the held turn's start (`now() - startMs`), so
  // every value below is directly comparable. This is the only sanctioned
  // source of poll-start remaining lifetime — the retired
  // `workerDurationMs - decisiveWallMs` arithmetic measured observation
  // duration, not poll-start lifetime (R1 correction).
  /** @type {HeldTurnTimeline} */
  const timeline = {
    clock: 'held-turn-monotonic-elapsed-ms',
    launchedAtElapsedMs: null,
    observationDetectedAtElapsedMs: null,
    pollStartedAtElapsedMs: null,
    holdDeadlineElapsedMs: null,
    rootAcknowledgementAtElapsedMs: null,
    childSettlementDetectedAtElapsedMs: null,
    endedAtElapsedMs: null,
  };
  /** @type {number | null} */
  let holdDeadlineMs = null;
  const budgetController = new AbortController();
  let budgetExpired = false;
  /** @type {HeldTurnRecord['cleanup']} */
  const cleanup = {
    label: 'observation',
    releasedGate: false,
    verifiedProcessTerminated: false,
    codexTerminated: false,
    nativeInterruptionClaimed: false,
    errors: /** @type {unknown[]} */ ([]),
    // Codex overall review fix: the WALL-CLOCK epoch-ms timestamp captured when
    // the driver INITIATES the budget cleanup (below), null until then. This —
    // not the coarse `budgetExpired` boolean — is the pre-cleanup attribution
    // boundary: it uses Date.now() (never the injectable monotonic `now()`)
    // precisely so it is comparable to the rollout event timestamps the
    // interrupt interaction's cancellation/settlement facts carry.
    cleanupBoundaryAtMs: null,
  };
  // Codex round-4/round-5 review fixes: the boundary records the EARLIEST
  // termination initiation across every site — the wrapper's cleanup
  // sequence, the process runner's own timeout path (through the launch
  // budget context's `recordCleanupBoundary`), and the shared-budget abort
  // source itself (this function scope, so the budget timer below can stamp
  // BEFORE the abort whose forwarded kills follow). Min-semantics keep the
  // earliest initiation when several sites record.
  // Codex overall review round 3: the normal-completion `finally` abort is
  // pure WATCHER TEARDOWN — by then the host process has already exited,
  // nothing is terminated, and the launch closures' shared-signal forwarders
  // firing on that abort must not stamp a cleanup boundary (a boundary
  // manufactured there over-rejected naturally completing durable reads in
  // the pre-boundary fence: the reviewer's 20/20 reproduction). The recorder
  // is INERT while the teardown flag is set; every REAL initiation keeps its
  // own source stamp — the budget timer records AT THE ABORT SOURCE before
  // aborting, the runner deadline watcher records before its abort, and the
  // controlled-termination cleanup sequence records at its initiation (none
  // of which runs during teardown).
  let budgetAbortIsTeardown = false;
  // The §23.5 pre-cleanup sampling loop (2026-10-23 interrupt-closure
  // Task 3), started after launch when the case's registered schedule is
  // enabled and a durable supplier exists. Declared here so the termination
  // -initiation recorder below can stop it AT the earliest boundary (clause
  // 3/4: reads in flight at the boundary are abandoned there, named —
  // sampling never observes past the boundary and never delays cleanup).
  /** @type {ReturnType<typeof startDurableSampling> | null} */
  let durableSampling = null;
  const recordTerminationInitiation = () => {
    if (budgetAbortIsTeardown) return;
    const initiatedAtMs = Date.now();
    if (cleanup.cleanupBoundaryAtMs === null || initiatedAtMs < cleanup.cleanupBoundaryAtMs) {
      cleanup.cleanupBoundaryAtMs = initiatedAtMs;
    }
    if (durableSampling !== null) durableSampling.stopAtTerminationBoundary();
  };
  // The budget is polled against the injectable clock: in production this is
  // the monotonic performance.now(), and instrument tests can drive it
  // deterministically instead of waiting real wall-clock time.
  const budgetTimer = setInterval(() => {
    if (now() < budgetDeadlineMs) return;
    budgetExpired = true;
    // Codex round-5 review fix: the shared-budget abort is FORWARDED to the
    // turn controller and to every runner listening on this signal, and the
    // forwarded aborts initiate their kills immediately — potentially long
    // before the wrapper's cleanup sequence reaches its own stamp. Record the
    // boundary at the abort SOURCE, before aborting (the same
    // min-semantics path), so any kill the abort triggers is already bounded.
    recordTerminationInitiation();
    budgetController.abort();
    clearInterval(budgetTimer);
  }, 50);
  /** @param {number} ms */
  const abortableSleep = async (ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    budgetController.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('held turn aborted')); }, { once: true });
  });
  // Hoisted so the exit `finally` can attach the §23.5 sampling block to the
  // answer's childSettlement on EVERY exit path (the finally runs after the
  // abort that stops the sampler).
  /** @type {HeldTurnRecord | undefined} */
  let answer;
  try {

  /** @type {{ result: Promise<{ code: number | null, stdout: string, stderr: string }>, terminate?: () => Promise<void> }} */
  let control;
  /** @type {unknown} */
  let identity;
  const safeReleaseGate = async () => {
    if (cleanup.releasedGate) return;
    try {
      await releaseGate(input.gatePath);
      cleanup.releasedGate = true;
    } catch (error) { cleanup.errors.push(error); }
  };
  const safeTerminateCodex = async () => {
    if (cleanup.codexTerminated || typeof control?.terminate !== 'function') return;
    try {
      await control.terminate();
      cleanup.codexTerminated = true;
    } catch (error) { cleanup.errors.push(error); }
  };
  const safeTerminateExactProcess = async () => {
    if (cleanup.verifiedProcessTerminated) return;
    if (identity === undefined) {
      try {
        identity = await captureProcessIdentity();
      } catch (error) {
        // Confirmed absence (marker never appeared, process already gone)
        // means there is nothing to signal. Marker CORRUPTION — a malformed
        // PID or mismatched nonce — is recorded as incomplete cleanup and the
        // unverified PID is never signalled.
        if (/** @type {any} */ (error)?.code !== 'ZCODE_SHELL_WAIT_MARKER_ABSENT') cleanup.errors.push(error);
        return;
      }
    }
    try {
      if (await readProcessIdentity(identity) === undefined) return;
      const outcome = await terminateProcessIdentity(identity);
      if (outcome && typeof outcome === 'object' && 'exited' in outcome) {
        // Explicit outcome: a failed signal with a surviving process is a
        // cleanup error, never a completed termination.
        if (outcome.failure) cleanup.errors.push(new Error(outcome.failure));
        cleanup.verifiedProcessTerminated = outcome.exited === true && !outcome.failure;
      } else {
        cleanup.verifiedProcessTerminated = true;
      }
    } catch (error) { cleanup.errors.push(error); }
  };
  // Codex overall review fix 2: EVERY controlled-process termination path —
  // early exits, Status-deadline ends, failures and budget expiry alike —
  // records the SAME wall-clock cleanup boundary at its INITIATION, before
  // the first cleanup action. The boundary uses Date.now() (never the
  // injectable monotonic `now()`) precisely so it is comparable to the
  // rollout event timestamps the interrupt interaction's cancellation facts
  // carry: a settlement marker whose rollout event time falls strictly
  // before this instant cannot have been generated by the cleanup, and a
  // marker at/after it is the kill's resolution — on every path, not only
  // budget expiry.
  const runTerminationCleanup = async () => {
    recordTerminationInitiation();
    await safeReleaseGate();
    await safeTerminateExactProcess();
    await safeTerminateCodex();
  };

  try {
    // Everything from here to the return is inside the cancellation finally, so
    // a thrown failure (including a rejecting host result) also aborts the
    // budget signal, stops the interval, and settles every cancellable wait.
    // P2-3 round-15 fix: the budget-abort listener is installed BEFORE the
    // launch closure runs — a budget that fires during the awaited launch
    // (or a signal that is already aborted by then) must win the boundary
    // race, never be missed. The launch closure receives the SHARED
    // experiment cancellation signal and the REMAINING deadline so both
    // Status turns (and their rollout loading) run on one budget — and the
    // termination-initiation recorder (round-4 review fix) so a runner-side
    // timeout kill stamps the cleanup boundary at its own initiation.
    const budgetOutcome = new Promise((resolve) => {
      budgetController.signal.addEventListener('abort', () => resolve({ kind: 'budget' }), { once: true });
    });
    control = await input.launch({
      signal: budgetController.signal,
      remainingMs: () => Math.max(0, Math.round(budgetDeadlineMs - now())),
      recordCleanupBoundary: recordTerminationInitiation,
    });
    // 2026-10-23 interrupt-closure Task 3 (report §23.5): the pre-cleanup
    // sampling schedule runs CONCURRENTLY with the held turn for the
    // registered case(s) — the baseline starts as soon as the exact identity
    // is established, never at the hold's end and never after a termination
    // branch has started. Options are bounded: only smaller caps are
    // injectable; the interval floor and both ceilings are frozen constants.
    if (input.sampleDurableSnapshots && typeof input.readDurableSnapshot === 'function') {
      const requested = input.sampleDurableSnapshots === true ? {} : input.sampleDurableSnapshots;
      /** @param {unknown} value */
      const finiteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
      durableSampling = startDurableSampling({
        supplier: /** @type {() => Promise<Record<string, unknown>>} */ (input.readDurableSnapshot),
        signal: budgetController.signal,
        sleep,
        // Codex backfill review: a boundary recorded while launch was pending
        // (the recorder ran before this sampler existed) must fence the
        // sampler at start — checked again inside via `signal.aborted`.
        terminatedAlready: cleanup.cleanupBoundaryAtMs !== null,
        intervalMs: Math.max(DURABLE_SAMPLING_MIN_INTERVAL_MS, finiteNumber(/** @type {any} */ (requested).intervalMs) ? /** @type {any} */ (requested).intervalMs : DURABLE_SAMPLING_MIN_INTERVAL_MS),
        maxAttempts: Math.max(1, Math.min(DURABLE_SAMPLING_MAX_ATTEMPTS, finiteNumber(/** @type {any} */ (requested).maxAttempts) ? Math.floor(/** @type {any} */ (requested).maxAttempts) : DURABLE_SAMPLING_MAX_ATTEMPTS)),
        maxSummaries: Math.max(1, Math.min(DURABLE_SAMPLING_MAX_SUMMARIES, finiteNumber(/** @type {any} */ (requested).maxSummaries) ? Math.floor(/** @type {any} */ (requested).maxSummaries) : DURABLE_SAMPLING_MAX_SUMMARIES)),
      });
    }
    timeline.launchedAtElapsedMs = Math.round(now() - startMs);
    /** @type {Promise<{ kind: 'result', value: { code: number | null, stdout: string, stderr: string } } | { kind: 'error', error: unknown }>} */
    const resultOutcome = Promise.resolve(control.result).then(
      (value) => ({ kind: /** @type {'result'} */ ('result'), value }),
      (error) => ({ kind: /** @type {'error'} */ ('error'), error }),
    );
    // P2-3 round-18 fix: the Root acknowledgement timestamp is captured when
    // the Root result RESOLVES — independently of the hold ordering. When the
    // worker gate wins the boundary race, Root can acknowledge DURING the
    // hold; stamping only after hold + gate release + natural worker exit
    // conflated the Root acknowledgement with the Child completion in the
    // lifecycle evidence.
    resultOutcome.then(
      (outcome) => {
        if (outcome.kind === 'result' && timeline.rootAcknowledgementAtElapsedMs === null) {
          timeline.rootAcknowledgementAtElapsedMs = Math.round(now() - startMs);
        }
      },
      () => { /* a rejecting host result carries no acknowledgement */ },
    );
    /** @type {Promise<{ kind: 'held' } | { kind: 'gate-error', error: unknown }>} */
    const gateOutcome = Promise.resolve().then(() => input.waitForGate(budgetController.signal)).then(
      () => ({ kind: /** @type {'held'} */ ('held') }),
      (error) => ({ kind: /** @type {'gate-error'} */ ('gate-error'), error }),
    );
    const boundary = await Promise.race([gateOutcome, resultOutcome, budgetOutcome]);
    if (boundary.kind !== 'gate-error') gateOutcome.catch(() => {});
    if (boundary.kind === 'gate-error') throw boundary.error;
    if (boundary.kind === 'error') throw boundary.error;
    if (boundary.kind === 'result') {
      if (typeof input.waitForChildSettlement === 'function') {
        // R3 background lifecycle: a Root acknowledgement is NOT the Child's
        // terminal completion. The held turn stays open for the CHILD's own
        // attached-Companion observation: it first opens the Child's
        // completion path (the experiment-control gate release — the gate
        // race is already settled by the 'result' boundary), then watches for
        // the Child-side settlement facts within the remaining budget, and
        // only then runs the settlement cleanup. The exact fake process is
        // never terminated merely because Root acknowledged.
        if (timeline.rootAcknowledgementAtElapsedMs === null) timeline.rootAcknowledgementAtElapsedMs = Math.round(now() - startMs);
        // P2-2 round-15 fix: worker READINESS precedes the hold. The Root
        // acknowledgement can win the boundary race long before the fake
        // worker reaches its gate; starting the hold at the acknowledgement
        // would give a delayed worker less than the requested hold (and could
        // even open the completion gate before the worker started). Await the
        // worker's gate-reached marker first — under the same budget race, so
        // budget expiry during the wait stays budget cleanup — and only then
        // run the full hold and release the gate.
        const readiness = await Promise.race([gateOutcome, budgetOutcome]);
        if (readiness.kind === 'budget') throw new Error('the held observation reached the experiment budget before the fake worker reached its gate');
        if (readiness.kind === 'gate-error') throw readiness.error;
        // P2-2 round-14 fix: the gate/hold lifecycle continues INDEPENDENTLY
        // of which boundary won the race. A winning acknowledgement no longer
        // releases the completion gate immediately — the fake worker's
        // completion depends on that gate, so an immediate release could end
        // a background trial before the intended long observation elapsed,
        // making the experiment scheduling-dependent. The gate releases only
        // after the requested holdMs (exactly like the gate-first ordering's
        // held phase); budget expiry during the hold is budget cleanup, and
        // the Child-settlement watch then runs as usual within the remaining
        // budget.
        const holdDeadline = now() + input.holdMs;
        holdDeadlineMs = holdDeadline;
        timeline.holdDeadlineElapsedMs = Math.round(holdDeadline - startMs);
        while (now() < holdDeadline && !budgetExpired) await abortableSleep(Math.min(100, Math.max(1, holdDeadline - now())));
        if (budgetExpired) throw new Error('the held observation reached the experiment budget before gate release');
        await safeReleaseGate();
        // 2026-10-21 evidence-closure Task 2: the passive durable snapshot
        // read STARTS before the watch (the observation is sampled as early
        // as possible) and its layer is finished below, always before the
        // settlement cleanup.
        const durableRead = startDurableSnapshotRead(input);
        /** @type {{ observed: boolean, basis: string | null } | null} */
        let childSettlement = null;
        // Codex round 5 (finding 2): a REJECTED watch is its own named fact —
        // it never discards the independently obtained durable facts.
        let childSettlementWatchFailed = false;
        try {
          childSettlement = await input.waitForChildSettlement(budgetController.signal);
        } catch {
          childSettlementWatchFailed = true;
          childSettlement = null;
        }
        if (budgetExpired) {
          // Codex round 6 (finding 2): budget expiry while the watch pends
          // never discards the independently completed durable facts — the
          // layers are joined FIRST (the fence decides credit from the read's
          // OWN completion instant: a read completed before the
          // expiry-initiated boundary keeps credit, otherwise the named
          // after-budget block) and the joined record rides the budget error
          // into the catch, which persists it instead of the bare failure
          // shape. Every field below keeps the pre-existing budget-record
          // semantics — the joined childSettlement block is the only
          // addition.
          const { settlementLayers, durableSnapshot } = await buildDurableSettlementLayer(childSettlement, durableRead, budgetExpired, budgetController.signal, cleanup);
          const budgetError = new Error('the held observation reached the experiment budget before the Child-side settlement');
          /** @type {any} */ (budgetError).heldTurn = {
            endedBeforeGate: false,
            budgetExpired,
            identity,
            processAliveWhileHeld: null,
            result: undefined,
            cleanup,
            timeline,
            failure: budgetError,
            childSettlement: joinChildSettlementRecord(childSettlementWatchFailed, childSettlement, settlementLayers, durableSnapshot),
          };
          throw budgetError;
        }
        cleanup.label = childSettlement?.observed === true ? 'child-settlement-observed' : 'child-settlement-unobserved';
        timeline.childSettlementDetectedAtElapsedMs = childSettlement?.observed === true ? Math.round(now() - startMs) : null;
        timeline.endedAtElapsedMs = Math.round(now() - startMs);
        // Release-qualification Task 2: the three settlement layers are
        // tracked SEPARATELY and never collapsed. In this ordering (Root
        // acknowledged first) the local process has not been reaped yet —
        // cleanup terminates it later and that fact stays a cleanup fact —
        // so the local-reaping layer stays unestablished (null), and the
        // durable obligations are never probed at held-turn scope.
        // Codex review round 8: the settlement watch is the LOCAL exit-code
        // watch (a linked poll returned an exit code for the local launcher
        // handle — including nonzero) and never establishes the REMOTE
        // terminal layer; the watch fact keeps its own observed/basis name
        // and the remote layer joins from REMOTE outcome evidence in the
        // mapper.
        // Codex review round 16: the watch's OBSERVED exact-Companion exit
        // grounds the local-reaping layer in BOTH orderings, exactly like
        // the gate-first branch — acknowledgement timing never discards
        // successful settlement evidence; an unobserved watch stays null.
        const { settlementLayers, durableSnapshot } = await buildDurableSettlementLayer(childSettlement, durableRead, budgetExpired, budgetController.signal, cleanup);
        answer = {
          endedBeforeGate: true,
          rootAcknowledged: true,
          budgetExpired,
          childSettlement: joinChildSettlementRecord(childSettlementWatchFailed, childSettlement, settlementLayers, durableSnapshot),
          identity: undefined,
          processAliveWhileHeld: null,
          result: boundary.value,
          cleanup,
          timeline,
        };
      } else if (input.statusDeadlineFlow === true) {
        // P2-1 round-7 fix: the Status query deadline IS the expected
        // observation outcome. The background launch only RESERVES a queued
        // job and neither it nor the Status query starts the fake peer, so
        // the completion gate is never part of this contract: the host
        // ending at the query deadline (the production JOB_WAIT_TIMEOUT
        // expiry) is the measured terminal fact, labelled as its own
        // lifecycle outcome — never the generic early exit. The result
        // contract itself is adjudicated by the observer, which accepts the
        // CONFIRMED production timeout framing as an alternative to the
        // rendered success markers and fails closed otherwise.
        // P2-2 round-11 fix: the lifecycle outcome derives from the VERIFIED
        // result. A 'result' boundary in this flow may also be an EARLY host
        // exit (an immediate command failure) — recording
        // statusDeadlineReached / cleanup 'status-query-deadline' there
        // would persist false lifecycle facts. Only a result whose stdout
        // carries the CONFIRMED production JOB_WAIT_TIMEOUT framing (exit 0,
        // every pinned marker present) marks the deadline reached; any other
        // outcome keeps the honest early-exit/failure classification, and
        // later adjudication still fails the case closed when the framing
        // cannot be confirmed.
        const boundaryResult = /** @type {{ code: number | null, stdout: string, stderr: string }} */ (boundary.value);
        // P2-1 round-12: the evidence is validated against the DECODED linked
        // tool output (the --json transport escapes the markers inside JSON
        // string fields); the bare-stdout path still verifies directly.
        const statusDeadlineVerified = extractDeadlineEvidenceFromHostOutput(boundaryResult);
        if (statusDeadlineVerified) {
          cleanup.label = 'status-query-deadline';
          timeline.endedAtElapsedMs = Math.round(now() - startMs);
          // Codex round 1: the durable snapshot is SAMPLED HERE — at the
          // verified deadline, BEFORE the Status cleanup — when a reader is
          // supplied; its aggregate grounds the durable settlement layer
          // exactly like the other orderings.
          const durableRead = startDurableSnapshotRead(input);
          const { settlementLayers, durableSnapshot } = await buildDurableSettlementLayer(null, durableRead, budgetExpired, budgetController.signal, cleanup);
          answer = {
            endedBeforeGate: false,
            statusDeadlineReached: true,
            budgetExpired,
            identity: undefined,
            processAliveWhileHeld: null,
            result: boundary.value,
            cleanup,
            timeline,
            ...(typeof input.readDurableSnapshot === 'function'
              ? { childSettlement: { observed: false, basis: null, layers: settlementLayers, ...(durableSnapshot === undefined ? {} : { durableSnapshot }) } }
              : {}),
          };
          await runTerminationCleanup();
        } else {
          cleanup.label = 'early-exit';
          timeline.endedAtElapsedMs = Math.round(now() - startMs);
          answer = {
            endedBeforeGate: true,
            budgetExpired,
            identity: undefined,
            processAliveWhileHeld: null,
            result: boundary.value,
            cleanup,
            timeline,
          };
          await runTerminationCleanup();
        }
      } else {
        cleanup.label = 'early-exit';
        timeline.endedAtElapsedMs = Math.round(now() - startMs);
        // Codex overall review round 4: the RESULT-FIRST, watcher-less branch
        // — exactly the rescue-interrupt shape (no settlement watcher, no
        // statusDeadlineFlow) — previously went straight to early-exit
        // cleanup without sampling the durable reader, losing the outstanding
        // job/guard obligations observation before cleanup changes them. When
        // a reader is supplied, START it here and JOIN it before the
        // early-exit cleanup (which runs after this answer, at the wrapper's
        // ended-before-gate termination cleanup) under the SAME fence
        // contract as every other join site: buildDurableSettlementLayer
        // stamps the read's OWN completion instant and applies the
        // budget/cleanup-boundary fence. The early-exit classification itself
        // is unchanged; no reader supplied → the named null-supplier contract
        // (no childSettlement block, exactly like the other gating sites).
        const durableRead = typeof input.readDurableSnapshot === 'function' ? startDurableSnapshotRead(input) : null;
        const joined = durableRead !== null
          ? await buildDurableSettlementLayer(null, durableRead, budgetExpired, budgetController.signal, cleanup)
          : null;
        answer = {
          endedBeforeGate: true, budgetExpired, identity: undefined, processAliveWhileHeld: null, result: boundary.value, cleanup, timeline,
          ...(joined !== null
            ? { childSettlement: { observed: false, basis: null, layers: joined.settlementLayers, ...(joined.durableSnapshot === undefined ? {} : { durableSnapshot: joined.durableSnapshot }) } }
            : {}),
        };
      }
    } else {
      identity = await captureProcessIdentity();
      if (input.waitForObservation) {
        await input.waitForObservation(budgetController.signal);
        timeline.observationDetectedAtElapsedMs = Math.round(now() - startMs);
      }
      const holdDeadline = now() + input.holdMs;
      holdDeadlineMs = holdDeadline;
      timeline.holdDeadlineElapsedMs = Math.round(holdDeadline - startMs);
      if (input.waitForPollStart) {
        // The decisive poll's first observation is watched CONCURRENTLY with
        // the hold: detection never delays or shortens the hold, the budget
        // signal settles the watch, and only an observation inside the held
        // phase (at or before the hold deadline) is recorded.
        input.waitForPollStart(budgetController.signal).then(
          () => {
            // P2-6 round-3 fix: `elapsed` is RELATIVE to the turn origin
            // while holdDeadlineMs is ABSOLUTE monotonic — the old
            // `elapsed <= holdDeadlineMs` comparison was always true for a
            // nonzero clock origin, so a watch resolving after the gate
            // release still fabricated a poll start. Compare on ONE clock:
            // only a detection at or before the absolute hold deadline
            // records the poll start; anything later leaves the fact
            // unknown.
            if (holdDeadlineMs === null || now() > holdDeadlineMs) return;
            timeline.pollStartedAtElapsedMs = Math.round(now() - startMs);
          },
          () => { /* a cancelled or failing watch leaves the poll start unknown (null) */ },
        );
      }
      // P2-1 round-17 fix: a Status-flow worker CAN reach its gate before the
      // query turn finishes (production `invoke review --background` starts a
      // real background worker via autoLaunchBackground), so the deadline
      // result must be handled INDEPENDENTLY of which boundary won the race:
      // the held phase races the query result, and a VERIFIED production
      // JOB_WAIT_TIMEOUT framing ends the turn at the query deadline exactly
      // like the acknowledgement-first ordering. An unverified early result
      // leaves the held lifecycle unchanged (the settled result is re-awaitable
      // at the post-hold join, so no outcome is lost).
      let statusDeadlineOutcome = null;
      // P2-1 round-18 fix: once the result has settled and been consumed
      // (unverified), it would win EVERY subsequent race instantly — a
      // microtask busy loop that starves the budget timer and accumulates a
      // pending sleep per iteration. After the first consumption the loop
      // awaits only real ticks, so budget cancellation stays effective.
      let earlyResultConsumed = false;
      while (now() < holdDeadline && !budgetExpired) {
        const tick = abortableSleep(Math.min(100, Math.max(1, holdDeadline - now()))).then(() => null, () => null);
        if (input.statusDeadlineFlow === true && !earlyResultConsumed) {
          const winner = await Promise.race([
            tick,
            resultOutcome.then((outcome) => outcome, (error) => ({ kind: /** @type {'error'} */ ('error'), error })),
          ]);
          if (winner !== null) {
            if (winner.kind === 'error') { statusDeadlineOutcome = winner; break; }
            if (extractDeadlineEvidenceFromHostOutput(winner.value)) { statusDeadlineOutcome = winner; break; }
            // an early UNVERIFIED result never shortens the hold — and is
            // never raced again
            earlyResultConsumed = true;
          }
        } else {
          await tick;
        }
      }
      if (statusDeadlineOutcome !== null && statusDeadlineOutcome.kind === 'result'
        && extractDeadlineEvidenceFromHostOutput(statusDeadlineOutcome.value)) {
        cleanup.label = 'status-query-deadline';
        timeline.endedAtElapsedMs = Math.round(now() - startMs);
        // Codex round 1: the durable snapshot is SAMPLED HERE — at the
        // verified deadline, BEFORE the Status cleanup — when a reader is
        // supplied (the same before-cleanup ordering as every other path).
        const durableRead = startDurableSnapshotRead(input);
        const { settlementLayers, durableSnapshot } = await buildDurableSettlementLayer(null, durableRead, budgetExpired, budgetController.signal, cleanup);
        answer = {
          endedBeforeGate: false,
          statusDeadlineReached: true,
          budgetExpired,
          identity: undefined,
          processAliveWhileHeld: null,
          result: statusDeadlineOutcome.value,
          cleanup,
          timeline,
          ...(typeof input.readDurableSnapshot === 'function'
            ? { childSettlement: { observed: false, basis: null, layers: settlementLayers, ...(durableSnapshot === undefined ? {} : { durableSnapshot }) } }
            : {}),
        };
        await runTerminationCleanup();
      } else {
        if (statusDeadlineOutcome !== null && statusDeadlineOutcome.kind === 'error') throw statusDeadlineOutcome.error;
        if (budgetExpired) throw new Error('the held observation reached the experiment budget before gate release');
      const processAliveWhileHeld = await readProcessIdentity(identity) !== undefined;
      await safeReleaseGate();
      const outcome = await resultOutcome;
      if (outcome.kind === 'error') throw outcome.error;
      await waitForProcessExit(identity, 'natural');
      // Release-qualification Task 2 (foreground settlement extension): the
      // AFTER-JOIN watch. The foreground extension runs ONLY here — after the
      // gate release and the natural exit — because a foreground Root that
      // ends BEFORE the gate is an early host exit with no joined Child to
      // settle (the pinned early-exit classification below stays untouched).
      // The background flow keeps its own acknowledgement-first watch input.
      // Codex review round 9: the preceding waitForProcessExit watches the
      // fake-ZCode peer (the host process), never the attached Companion, so
      // it cannot ground the local-reaping layer. The layer is positive
      // ('natural-exit-observed') ONLY when the settlement watch OBSERVED
      // the exact Companion's exit; an unobserved watch keeps it null —
      // never a fabricated positive lifecycle fact.
      const afterJoinSettlementWatch = typeof input.waitForChildSettlement === 'function'
        ? input.waitForChildSettlement
        : typeof input.waitForChildSettlementAfterJoin === 'function'
          ? input.waitForChildSettlementAfterJoin
          : null;
      // 2026-10-21 evidence-closure Task 2: the passive durable snapshot read
      // starts before the after-join watch and its layer is finished below,
      // always before the settlement cleanup.
      const durableRead = startDurableSnapshotRead(input);
      if (afterJoinSettlementWatch !== null) {
        // P2-2 round-5 fix: background settlement for EITHER ordering. The
        // gate won the race — the fake peer reached its gate before Root
        // returned its acknowledgement — but Root has now returned, and the
        // held turn STILL stays open for the CHILD's own settlement
        // observation (the same lifecycle the acknowledgement-first ordering
        // runs): whichever boundary wins, the Child-settlement watch runs
        // before any cleanup or disposal, so the fixture is never disposed
        // while the Child is still consuming its terminal observation.
        if (timeline.rootAcknowledgementAtElapsedMs === null) timeline.rootAcknowledgementAtElapsedMs = Math.round(now() - startMs);
        /** @type {{ observed: boolean, basis: string | null } | null} */
        let childSettlement = null;
        // Codex round 5 (finding 2): a REJECTED watch is its own named fact —
        // it never discards the independently obtained durable facts (the
        // same contract as the acknowledgement-first ordering).
        let childSettlementWatchFailed = false;
        try {
          childSettlement = await afterJoinSettlementWatch(budgetController.signal);
        } catch {
          childSettlementWatchFailed = true;
          childSettlement = null;
        }
        if (budgetExpired) {
          // Codex round 6 (finding 2): the same retention contract as the
          // acknowledgement-first ordering — join the layers first (the read
          // completed before the expiry-initiated boundary keeps credit), then
          // throw the budget error carrying the joined record.
          const { settlementLayers, durableSnapshot } = await buildDurableSettlementLayer(childSettlement, durableRead, budgetExpired, budgetController.signal, cleanup);
          const budgetError = new Error('the held observation reached the experiment budget before the Child-side settlement');
          /** @type {any} */ (budgetError).heldTurn = {
            endedBeforeGate: false,
            budgetExpired,
            identity,
            processAliveWhileHeld: null,
            result: undefined,
            cleanup,
            timeline,
            failure: budgetError,
            childSettlement: joinChildSettlementRecord(childSettlementWatchFailed, childSettlement, settlementLayers, durableSnapshot),
          };
          throw budgetError;
        }
        cleanup.label = childSettlement?.observed === true ? 'child-settlement-observed' : 'child-settlement-unobserved';
        timeline.childSettlementDetectedAtElapsedMs = childSettlement?.observed === true ? Math.round(now() - startMs) : null;
        timeline.endedAtElapsedMs = Math.round(now() - startMs);
        // Release-qualification Task 2 (foreground settlement extension): the
        // natural-exit wait before this watch covered the fake-ZCode peer —
        // round 9: the local-reaping layer is positive ONLY from the watch's
        // OBSERVED exact-Companion exit; an unobserved watch keeps the layer
        // unestablished (null). The remote terminal and durable layers stay
        // independent facts (round 8: the watch is the LOCAL exit-code watch
        // and never establishes the remote layer — the mapper joins it from
        // REMOTE outcome evidence).
        const { settlementLayers, durableSnapshot } = await buildDurableSettlementLayer(childSettlement, durableRead, budgetExpired, budgetController.signal, cleanup);
        answer = {
          endedBeforeGate: false,
          rootAcknowledged: true,
          budgetExpired,
          childSettlement: joinChildSettlementRecord(childSettlementWatchFailed, childSettlement, settlementLayers, durableSnapshot),
          identity,
          processAliveWhileHeld,
          result: outcome.value,
          cleanup,
          timeline,
        };
      } else {
        timeline.endedAtElapsedMs = Math.round(now() - startMs);
        // Codex round 10 (finding 2): EVERY path that starts a durable read
        // joins and persists it, regardless of watcher presence — the
        // gate-first no-watcher completion (status-wait finishing before its
        // deadline) previously dropped the independently obtained durable
        // facts. The fence contract applies unchanged.
        let noWatcherLayers = null;
        let noWatcherSnapshot;
        if (durableRead !== undefined) {
          const joined = await buildDurableSettlementLayer(null, durableRead, budgetExpired, budgetController.signal, cleanup);
          noWatcherLayers = joined.settlementLayers;
          noWatcherSnapshot = joined.durableSnapshot;
        }
        answer = {
          endedBeforeGate: false,
          budgetExpired,
          identity,
          processAliveWhileHeld,
          result: outcome.value,
          cleanup,
          timeline,
          ...(durableRead !== undefined
            ? { childSettlement: { observed: false, basis: null, layers: /** @type {any} */ (noWatcherLayers), ...(noWatcherSnapshot === undefined ? {} : { durableSnapshot: noWatcherSnapshot }) } }
            : {}),
        };
      }
      }
    }
  } catch (error) {
    cleanup.label = budgetExpired ? 'budget-cleanup' : cleanup.label === 'early-exit' ? 'early-exit' : 'failure';
    timeline.endedAtElapsedMs = Math.round(now() - startMs);
    // Codex round 6 (finding 2): a budget-expiry throw that already carries a
    // fully joined held record (the durable facts were joined BEFORE the
    // throw) keeps that record — the bare failure shape must not overwrite
    // it. Only the budget path above attaches `heldTurn`; every other error
    // keeps the exact pre-existing failure shape.
    const carriedHeldTurn = /** @type {any} */ (error)?.heldTurn;
    answer = budgetExpired && carriedHeldTurn !== null && typeof carriedHeldTurn === 'object'
      ? carriedHeldTurn
      : {
          endedBeforeGate: false,
          budgetExpired,
          identity,
          processAliveWhileHeld: null,
          result: undefined,
          cleanup,
          timeline,
          failure: error,
        };
    if (!budgetExpired) {
      // Failures other than budget expiry propagate after cleanup, like the
      // installed E2E discipline.
      await runTerminationCleanup();
      const cleanupFailure = cleanup.errors.length > 0
        ? new AggregateError([error, ...cleanup.errors], `held shell wait turn failed with cleanup errors: ${error instanceof Error ? error.message : String(error)}`)
        : error;
      // Carry the structured held-turn record so the executor (and the
      // persisted case record) can keep the cleanup facts — termination
      // outcomes, cleanup errors — alive past fixture deletion.
      /** @type {any} */ (cleanupFailure).heldTurn = answer;
      throw cleanupFailure;
    }
  }
  if (budgetExpired) {
    cleanup.label = 'budget-cleanup';
    await runTerminationCleanup();
  } else if (answer !== undefined && answer.endedBeforeGate) {
    await runTerminationCleanup();
  }
  return /** @type {HeldTurnRecord} */ (answer);
  } finally {
    // Cancel and settle every outstanding gate/observation wait on EVERY exit
    // path (early exit, completion, failure, budget expiry), so no losing poll
    // keeps reading and sleeping — including after fixture deletion — and the
    // CLI can always terminate after completed cleanup. A thrown failure (for
    // example a rejecting host result) passes through this finally too.
    // The teardown flag goes up BEFORE the abort so the launch closures'
    // forwarders firing on it cannot stamp a boundary (see the recorder gate
    // above): every real initiation has already stamped at its own source.
    budgetAbortIsTeardown = true;
    budgetController.abort();
    clearInterval(budgetTimer);
    // 2026-10-23 interrupt-closure Task 3 (report §23.5): the abort above
    // stopped the sampler (the shared-signal stop — a teardown-only abort
    // names the signal, never a termination boundary); the FINAL sampling
    // state — attempts, baseline, summaries, omissions — rides the held
    // record's childSettlement block on EVERY exit path. The failure-shaped
    // answer (a rejecting gate/host result) carries no settlement block — the
    // sampler's facts still ride on a minimal unobserved-settlement carrier
    // (self-review round 1): the mapper projects
    // childSettlement.durableSamples onto that record and the settlement
    // observation itself stays honestly unobserved (the turn failed).
    if (durableSampling !== null && answer !== undefined) {
      const samples = durableSampling.stateSnapshot();
      if (answer.childSettlement && typeof answer.childSettlement === 'object') {
        /** @type {any} */ (answer.childSettlement).durableSamples = samples;
      } else {
        /** @type {any} */ (answer).childSettlement = {
          observed: false,
          basis: answer.failure !== undefined ? 'held-turn-failed-before-settlement-observation' : null,
          durableSamples: samples,
        };
      }
    }
  }
}

/**
 * Start the passive durable snapshot read at settlement time (BEFORE the
 * Child-settlement watch, so the observation is sampled as early as possible
 * and always completes before any cleanup boundary). A reader failure is
 * converted into a NAMED unestablished snapshot — never a business failure.
 *
 * Codex round 5 (finding 4): the read promise is wrapped AT START — the
 * completion instant (`completedAtMs`, Date.now, the same wall clock as the
 * held cleanup boundary) is stamped when the read ITSELF resolves, in a
 * carrier independent of any consumer await. A read that resolves long
 * before its consumer joins keeps its true completion instant, so the
 * settlement fence can distinguish "completed before the boundary" from
 * "joined after the boundary".
 * @param {{ readDurableSnapshot?: () => Promise<Record<string, unknown>> }} input
 * @returns {{ promise: Promise<{ snapshot: Record<string, unknown>, completedAtMs: number }>, state: { settled: boolean, carrier: { snapshot: Record<string, unknown>, completedAtMs: number } | null } } | undefined}
 */
function startDurableSnapshotRead(input) {
  if (typeof input.readDurableSnapshot !== 'function') return undefined;
  // Codex round 6 (finding 2): the completion state is queryable
  // SYNCHRONOUSLY once the read settles. When the budget has already fired
  // at join time, the fence must decide from the completion instant without
  // racing — an already-settled read and an already-resolved race loser
  // cannot be ordered by Promise.race (the loser's single reaction hop
  // always beats the read's derived-promise chain), so the race tie-break is
  // not a deterministic primitive here.
  /** @type {{ settled: boolean, carrier: { snapshot: Record<string, unknown>, completedAtMs: number } | null }} */
  const state = { settled: false, carrier: null };
  // Codex round 10 (finding 3): a supplier that throws BEFORE returning its
  // promise receives the SAME named unestablished-snapshot treatment as a
  // rejected promise — the exception never escapes into the held-turn
  // failure path, never skips the settlement watch, never fails the case.
  const supplier = /** @type {() => Promise<Record<string, unknown>>} */ (input.readDurableSnapshot);
  /** @type {Promise<{ snapshot: Record<string, unknown>, completedAtMs: number }>} */
  const promise = new Promise((resolve) => { resolve(supplier()); }).then(
    (snapshot) => { state.settled = true; state.carrier = { snapshot, completedAtMs: Date.now() }; return state.carrier; },
    (error) => {
      state.settled = true;
      state.carrier = {
        snapshot: {
          aggregate: 'unestablished',
          reasons: [error instanceof Error ? error.message : String(error)],
        },
        completedAtMs: Date.now(),
      };
      return state.carrier;
    },
  );
  return { promise, state };
}

/**
 * Finish the three-way settlement layers once the Child-settlement watch has
 * returned. The durable layer (2026-10-21 evidence-closure Task 2) comes
 * ONLY from the passive durable reader's typed aggregate — 'settled'
 * requires every applicable duty positively established and the reader's own
 * before/after partition fingerprint equal; 'unresolved' marks positively
 * observed retained duties; anything else (including a reader failure, a
 * torn snapshot, or no supplier at all) stays null — never zero, never
 * inferred from terminal stdout, process exit, or cleanup. Without a
 * supplier the pre-Task-2 schema is preserved byte-for-byte (no durable
 * block).
 * @param {{ observed: boolean, basis: string | null } | null} childSettlement
 * @param {{ promise: Promise<{ snapshot: Record<string, unknown>, completedAtMs: number }>, state: { settled: boolean, carrier: { snapshot: Record<string, unknown>, completedAtMs: number } | null } } | undefined} durableRead
 * @param {boolean} budgetExpired @param {AbortSignal | null} budgetSignal
 * @param {Record<string, any> | null} cleanup the held cleanup record whose
 *   `cleanupBoundaryAtMs` is the EARLIEST termination-initiation instant
 * @returns {Promise<{ settlementLayers: { remoteTerminal: boolean | null, localProcessReaping: 'natural-exit-observed' | 'cleanup-terminated' | null, durableObligations: 'settled' | 'unresolved' | null }, durableSnapshot?: Record<string, unknown> }>}
 */
async function buildDurableSettlementLayer(childSettlement, durableRead, budgetExpired, budgetSignal, cleanup) {
  /** @type {{ remoteTerminal: boolean | null, localProcessReaping: 'natural-exit-observed' | 'cleanup-terminated' | null, durableObligations: 'settled' | 'unresolved' | null }} */
  const settlementLayers = {
    remoteTerminal: null,
    localProcessReaping: childSettlement?.observed === true ? 'natural-exit-observed' : null,
    durableObligations: null,
  };
  if (durableRead === undefined) return { settlementLayers };
  // Codex round 5 (ONE complete fence): settlement credit requires the read
  // completed (its at-start carrier stamp) BEFORE the earliest cleanup
  // boundary and before budget expiry. The comparison uses the read's OWN
  // completion instant — never the join instant, which is necessarily after
  // any boundary recorded while the consumer was still awaiting (finding 4):
  // a read completed pre-boundary but joined post-boundary keeps FULL credit.
  // The earliest boundary is the min-maintained `cleanupBoundaryAtMs` on the
  // held cleanup record, re-read at the final join.
  /** @type {Record<string, any> | null} */
  let sampled = null;
  /** @type {number | null} */
  let completionAtMs = null;
  /** @type {null | 'durable-observation-after-budget-expiry' | 'durable-observation-after-cleanup-boundary'} */
  let fenceReason = null;
  // Codex round 6 (finding 2): when the budget has ALREADY fired at join
  // time, the read's SYNCHRONOUS settlement state decides — an
  // already-completed read is evaluated from its own completion instant (the
  // expiry records its boundary at the abort source BEFORE aborting, so
  // `completedAtMs < earliestBoundary` is completion before expiry and keeps
  // credit, the read-completed-before-expiry arm of the contract), while a
  // still-pending read lost the budget race by definition and gets the named
  // after-budget block without ever being awaited (the round-3 discipline).
  const budgetFired = budgetExpired === true || (budgetSignal !== null && budgetSignal.aborted);
  if (!budgetFired) {
    const budgetAborted = budgetSignal !== null
      ? new Promise((resolve) => { budgetSignal.addEventListener('abort', () => resolve(false), { once: true }); })
      : null;
    const raced = budgetAborted !== null
      ? await Promise.race([durableRead.promise.then(() => true, () => true), budgetAborted])
      : await durableRead.promise.then(() => true, () => true);
    if (raced === false) {
      // The budget expired while the read was pending: the named block is
      // returned IMMEDIATELY — the losing read is NEVER awaited (round 3).
      fenceReason = 'durable-observation-after-budget-expiry';
    }
  } else if (!durableRead.state.settled) {
    fenceReason = 'durable-observation-after-budget-expiry';
  }
  if (fenceReason === null) {
    // The read completed (it won the budget race, or it had already settled
    // when the budget fired): credit is decided from its OWN completion
    // instant against the earliest cleanup boundary, re-read at the final
    // join.
    sampled = durableRead.state.carrier?.snapshot ?? null;
    completionAtMs = durableRead.state.carrier?.completedAtMs ?? null;
    const boundaryValue = /** @type {any} */ (cleanup)?.cleanupBoundaryAtMs;
    const earliestBoundaryMs = typeof boundaryValue === 'number' && Number.isFinite(boundaryValue) ? boundaryValue : null;
    if (earliestBoundaryMs !== null && (completionAtMs === null || completionAtMs >= earliestBoundaryMs)) {
      // The read completed at/after the earliest cleanup boundary (or its
      // completion instant is unprovable): a cleanup-generated observation.
      // The budget reason wins when both fences fire (the earliest boundary
      // is the expiry instant itself when the budget initiated cleanup).
      fenceReason = budgetFired
        ? 'durable-observation-after-budget-expiry'
        : 'durable-observation-after-cleanup-boundary';
    }
  }
  if (fenceReason !== null) {
    /** @type {Record<string, any>} */
    const durableSnapshot = {
      aggregate: 'unestablished',
      reasons: [fenceReason],
      sampledAggregate: null,
    };
    // Codex round 3: the losing read is NEVER awaited — cleanup must never
    // block behind a stalled reader. A no-op rejection handler keeps the
    // losing promise from becoming an unhandled rejection; a late RESOLUTION
    // may update only the non-authoritative `sampledAggregate` field (and the
    // late completion instant) on the already-returned block, never the
    // recorded observation status.
    durableRead.promise.then(
      (late) => {
        if (late !== null && typeof late === 'object') {
          durableSnapshot.sampledAggregate = late.snapshot !== null && typeof late.snapshot === 'object' && late.snapshot.aggregate !== undefined ? late.snapshot.aggregate : null;
          if (typeof late.completedAtMs === 'number' && durableSnapshot.completedAtMs === undefined) durableSnapshot.completedAtMs = late.completedAtMs;
        }
      },
      () => { durableSnapshot.sampledAggregate = 'read-failed'; },
    );
    return { settlementLayers, durableSnapshot };
  }
  const durableSnapshot = sampled;
  // The read's own completion instant rides the credited typed snapshot (the
  // §19.6 sample-time discipline); a frozen supplier object keeps the carrier
  // instant authoritative — the fence never depends on this attachment.
  if (durableSnapshot !== null && typeof durableSnapshot === 'object' && completionAtMs !== null) {
    try {
      /** @type {any} */ (durableSnapshot).completedAtMs = completionAtMs;
    } catch {
      // Assignment refused (frozen object): the carrier instant above remains
      // the fence input; the persisted snapshot simply omits the field.
    }
  }
  const aggregate = durableSnapshot !== null && typeof durableSnapshot === 'object' ? durableSnapshot.aggregate : null;
  settlementLayers.durableObligations = aggregate === 'settled' ? 'settled' : aggregate === 'unresolved' ? 'unresolved' : null;
  return { settlementLayers, durableSnapshot: durableSnapshot ?? undefined };
}

/**
 * The §23.5 frozen pre-cleanup passive sampling schedule's schema version
 * (2026-10-23 interrupt-closure Task 3). The sampling block is a LIVE
 * observation block of the held record — this version stamps its own schema
 * so it can never be mistaken for the live observer's adjudication stamp or
 * for an offline-facts adjudicator version.
 */
export const DURABLE_SAMPLING_VERSION = 1;

/**
 * The §23.5 clause 2 registered interval floor: ≥1000 ms between durable
 * read STARTS (clause 2's post-delivery cadence, applied conservatively to
 * every consecutive attempt start, identity probes included). Frozen — a
 * caller-requested smaller interval is clamped, never honored.
 */
export const DURABLE_SAMPLING_MIN_INTERVAL_MS = 1000;

/**
 * The §23.5 clause 4 registered read-attempt ceiling: maximum 600 read
 * attempts total, all inside the existing experiment budget. Frozen — a
 * larger caller request is clamped; only a smaller cap can be injected
 * (bounded instrument tests).
 */
export const DURABLE_SAMPLING_MAX_ATTEMPTS = 600;

/**
 * The §23.5 clause 4 registered retention ceiling: at most 32
 * transition/sample summaries retained per case. Frozen — a larger caller
 * request is clamped; only a smaller cap can be injected.
 */
export const DURABLE_SAMPLING_MAX_SUMMARIES = 32;

/**
 * The closed map of cases whose registered design runs the §23.5 pre-cleanup
 * sampling schedule (the §20.8 producer-map precedent: the map is the ONE
 * definition site; the live executor consults it when wiring
 * {@link runHeldHostTurn}). The §23.5 schedule is the INTERRUPT case's
 * registered schedule; status-wait and every other case keep their exact
 * prior durable-read behavior.
 */
export const DURABLE_SAMPLING_ENABLED_CASES = Object.freeze(new Set(['rescue-interrupt']));

/**
 * The sampling omission ledger's retention bound (self-review round 1,
 * 2026-10-23): at most 16 named omission entries are retained on the block.
 * This is an ACCOUNTING bound (§23.5 freezes the 32-summary retention, not an
 * omission count — under the frozen default schedule the summary-cap
 * omissions alone can exceed it), not a lifecycle bound: drops at this bound
 * are themselves named on the block (`omissionsTruncated` +
 * `omissionsDroppedCount`), never silent.
 */
const DURABLE_SAMPLING_OMISSION_RETENTION = 16;

/**
 * Whether a supplier result is the established named identity-unobserved
 * block (the live supplier's contract: an unresolvable spawn-acknowledgement
 * identity yields `{ aggregate: 'unestablished', reasons:
 * ['durable-identity-unobserved'…] }`). Identity probes are establishment
 * attempts — counted, never sample summaries, never guessed at another job.
 * @param {unknown} result
 * @returns {boolean}
 */
function isDurableIdentityUnobservedResult(result) {
  return result !== null && typeof result === 'object'
    && /** @type {any} */ (result).aggregate === 'unestablished'
    && Array.isArray(/** @type {any} */ (result).reasons)
    && /** @type {unknown[]} */ (/** @type {any} */ (result).reasons).some((reason) => String(reason).startsWith('durable-identity-unobserved'));
}

/**
 * The §23.5 pre-cleanup passive sampling loop (2026-10-23 interrupt-closure
 * Task 3): bounded baseline + interval reads of the EXISTING passive durable
 * reader through the case's existing supplier seam, run CONCURRENTLY with
 * the held turn — never at the hold's end and never after a termination
 * branch has started (the recorded I case's cleanup-time-only snapshot was
 * the defect this schedule fixes, report §21.2.3 item 8 / §23.5).
 *
 * Frozen contract clauses (report §23.5; no new lifecycle behavior):
 * 1. Baseline — the first attempt whose result is NOT the named
 *    identity-unobserved block; establishment probes before it are counted
 *    attempts, never summaries; identity that never establishes omits the
 *    baseline with the registered `durable-identity-unobserved` reason.
 * 2. Interval — every consecutive pair of read starts keeps the registered
 *    ≥1000-ms floor (`DURABLE_SAMPLING_MIN_INTERVAL_MS`, clamped).
 * 3. Fence cooperation — the loop STOPs at the earliest termination-initiation
 *    boundary (the held turn's recorder hook) and at the shared budget
 *    signal's abort (teardown included, which is NOT a boundary): a read
 *    still in flight is abandoned AT the stop with its named omission, so
 *    sampling never delays cleanup and never observes past the boundary. A
 *    completed read keeps its own started/completed instants — the offline
 *    strict fence decides credit per read.
 * 4. Bounds — max 600 attempts (clamped), ≤32 retained summaries (clamped);
 *    cap exhaustion and dropped summaries are named omissions. An
 *    unreadable supplier is a named observer reason on the attempt's
 *    summary; a never-resolving supplier is abandoned at the stop — neither
 *    is ever a business failure, and neither can delay cleanup (the loop is
 *    detached; no path awaits it).
 * 5. Read-only-ness — the loop only CALLS the supplier and derives bounded
 *    closed-fact summaries from its results (§19.8's fingerprint-sweep
 *    precedent: the reader itself proves passivity; the loop adds no I/O,
 *    settles nothing, stops nothing, repairs nothing, authorizes nothing).
 * @param {{
 *   supplier: () => Promise<Record<string, unknown>>,
 *   signal: AbortSignal,
 *   sleep: (ms: number) => Promise<void>,
 *   intervalMs: number,
 *   maxAttempts: number,
 *   maxSummaries: number,
 *   terminatedAlready?: boolean,
 * }} input
 *   `terminatedAlready` (codex backfill review): the held turn's earliest
 *   termination-initiation boundary was recorded BEFORE the sampler could
 *   start (the shared budget can expire while `input.launch()` is pending).
 *   No attempt may run past it — the skipped start is the named
 *   `durable-sampling-skipped-termination-already-recorded` omission.
 * @returns {{ state: Record<string, any>, stopAtTerminationBoundary: () => void, stateSnapshot: () => Record<string, any> }}
 */
function startDurableSampling({ supplier, signal, sleep, intervalMs, maxAttempts, maxSummaries, terminatedAlready = false }) {
  /** @type {Record<string, any>} */
  const state = {
    version: DURABLE_SAMPLING_VERSION,
    intervalMs,
    attemptCap: maxAttempts,
    summaryCap: maxSummaries,
    attemptCount: 0,
    identityEstablishedAtAttempt: null,
    baseline: null,
    baselineOmittedReason: null,
    stoppedReason: null,
    summaries: [],
    omissions: [],
    // Self-review round 1 (2026-10-23): omissions dropped at the ledger bound
    // are themselves a named fact — never a silent cut (§23.5 clause 4's
    // every-omission-named discipline extends to the dropped ones).
    omissionsTruncated: false,
    omissionsDroppedCount: 0,
    // Self-review round 1 (2026-10-23): the clause-2 floor is re-checked
    // against the ACTUAL start spacing; an interval that still started short
    // (a scheduler resolving earlier than requested) is named here — never a
    // silent compression.
    intervalShortfalls: 0,
    // Codex backfill review (2026-10-23): the ledger ROLLS at the frozen cap
    // (baseline and transitions pinned, the oldest superseded summary evicted)
    // so post-delivery observations always survive — every rolled-off summary
    // is a named count on the block, never a silent drop.
    summariesRolledOff: 0,
  };
  let stopped = false;
  /** @type {number | null} */
  let inFlightAttemptIndex = null;
  /** @type {(value?: unknown) => void} */
  let resolveStopped = () => {};
  const stoppedPromise = new Promise((resolve) => { resolveStopped = resolve; });
  /** @param {Record<string, unknown>} omission */
  const namedOmission = (omission) => {
    if (state.omissions.length < DURABLE_SAMPLING_OMISSION_RETENTION) {
      state.omissions.push(omission);
      return;
    }
    state.omissionsTruncated = true;
    state.omissionsDroppedCount += 1;
  };
  const omitBaseline = () => {
    if (state.baseline !== null || state.baselineOmittedReason !== null) return;
    // §23.5 clause 1: the baseline's omission names the identity. The
    // baseline is null ONLY while identity never established (it is set at
    // the establishing read), so this is always the registered reason — the
    // former established-but-cap-dead arm was unreachable (self-review
    // round 1) and is removed.
    state.baselineOmittedReason = 'durable-identity-unobserved';
  };
  /** @param {'durable-sampling-stopped-at-termination-boundary' | 'durable-sampling-stopped-at-shared-signal'} reason */
  const stop = (reason) => {
    if (stopped) return;
    stopped = true;
    state.stoppedReason = reason;
    // A read still in flight is abandoned AT the stop, named with its
    // attempt (clause 4) — synchronously, so the held record's final
    // snapshot always carries the abandonment.
    if (inFlightAttemptIndex !== null) {
      namedOmission({
        attemptIndex: inFlightAttemptIndex,
        reason: reason === 'durable-sampling-stopped-at-termination-boundary'
          ? 'durable-read-abandoned-in-flight-at-termination-boundary'
          : 'durable-read-abandoned-at-shared-signal',
      });
      inFlightAttemptIndex = null;
    }
    omitBaseline();
    resolveStopped();
  };
  signal.addEventListener('abort', () => { stop('durable-sampling-stopped-at-shared-signal'); }, { once: true });
  // Codex backfill review (2026-10-23): the shared budget can expire while
  // `input.launch()` is still pending — the termination recorder fired before
  // this sampler existed and an abort listener attached now would never fire.
  // No attempt may run past the already-recorded termination: the skipped
  // start is a named omission (the offline fence then sees no post-boundary
  // sample), and the frozen bounds stay intact.
  if (terminatedAlready === true || signal.aborted) {
    namedOmission({
      attemptIndex: 0,
      reason: terminatedAlready === true
        ? 'durable-sampling-skipped-termination-already-recorded'
        : 'durable-sampling-skipped-shared-signal-already-aborted',
    });
    stop(terminatedAlready === true
      ? 'durable-sampling-stopped-at-termination-boundary'
      : 'durable-sampling-stopped-at-shared-signal');
  }
  /** @type {(snapshot: Record<string, unknown> | null, attemptIndex: number, startedAtMs: number, completedAtMs: number, isBaseline: boolean, isTransition: boolean) => Record<string, unknown>} */
  const summarize = (snapshot, attemptIndex, startedAtMs, completedAtMs, isBaseline, isTransition) => {
    const source = snapshot !== null && typeof snapshot === 'object' ? snapshot : {};
    const passive = /** @type {any} */ (source).passive !== null && typeof /** @type {any} */ (source).passive === 'object' ? /** @type {any} */ (source).passive : {};
    const partition = /** @type {any} */ (source).partition !== null && typeof /** @type {any} */ (source).partition === 'object' ? /** @type {any} */ (source).partition : {};
    const job = /** @type {any} */ (source).job !== null && typeof /** @type {any} */ (source).job === 'object' ? /** @type {any} */ (source).job : {};
    // The reader's job projection is the VALIDATED production record — the
    // summaries retain only the whitelisted cancellation-provenance fields
    // (codex backfill review): the published winner status, the confirmed
    // stop cause and the stop intent's cause/request timestamp (a bounded
    // enum + canonical ISO timestamp), never the whole record body. These
    // are the fields a retained pre-cleanup sample needs to distinguish a
    // genuine SessionEnd from any other cancellation when the final snapshot
    // is unavailable or fenced out — the reader's `layers.stopIntent` block
    // carries only applicability/presence/validity, not the cause.
    const jobProjection = job.projection !== null && typeof job.projection === 'object' ? job.projection : {};
    const stopIntent = jobProjection.stopIntent !== null && typeof jobProjection.stopIntent === 'object' ? jobProjection.stopIntent : {};
    return {
      attemptIndex,
      baseline: isBaseline === true,
      // §23.5 clause 4 names these "transition/sample summaries": a summary
      // whose aggregate differs from the previous sample's observed aggregate
      // is a TRANSITION — pinned by the retention mechanism below.
      transition: isTransition === true,
      startedAtMs,
      completedAtMs,
      aggregate: /** @type {any} */ (source).aggregate ?? null,
      executorLinkage: /** @type {any} */ (source).executorLinkage ?? null,
      jobPresence: job.presence ?? null,
      jobStatus: jobProjection.status ?? null,
      stopCause: typeof jobProjection.stopCause === 'string' ? jobProjection.stopCause : null,
      stopIntentCause: typeof stopIntent.cause === 'string' ? stopIntent.cause : null,
      stopIntentRequestedAt: typeof stopIntent.requestedAt === 'string' ? stopIntent.requestedAt : null,
      snapshotEqual: passive.snapshotEqual ?? null,
      lockState: passive.lockState ?? null,
      partitionStatus: partition.status ?? null,
      // The per-layer §19.5 duty states ride verbatim (bounded closed facts
      // — the record serializer re-bounds and redacts on persistence).
      layers: /** @type {any} */ (source).layers ?? null,
      reasons: Array.isArray(/** @type {any} */ (source).reasons)
        ? /** @type {unknown[]} */ (/** @type {any} */ (source).reasons).slice(0, 8).map((reason) => String(reason))
        : [],
    };
  };
  (async () => {
    let lastStartAtMs = null;
    // The aggregate of the most recent non-probe read — the transition key
    // for the retention mechanism below (a summary whose aggregate differs
    // from this is a state TRANSITION, pinned by the ledger).
    let lastAggregate = null;
    while (!stopped && state.attemptCount < maxAttempts) {
      if (lastStartAtMs !== null) {
        // Clause 2: the next read starts no earlier than the previous start
        // plus the registered floor. The scheduled wait races the stop so a
        // boundary or teardown during the interval is honored immediately —
        // and the floor is RE-CHECKED against the actual clock (self-review
        // round 1): a scheduler that resolved earlier than requested gets the
        // remainder once more, and a still-short start is the named
        // `intervalShortfalls` fact on the block — never a silent compression
        // and never a busy wait (cleanup is never delayed). With the
        // production default scheduler (a real setTimeout) the re-check finds
        // the floor already honored and re-waits nothing.
        let waitMs = Math.max(0, lastStartAtMs + intervalMs - Date.now());
        if (waitMs > 0) {
          await Promise.race([
            Promise.resolve(sleep(waitMs)).then(() => {}, () => {}),
            stoppedPromise,
          ]);
        }
        waitMs = Math.max(0, lastStartAtMs + intervalMs - Date.now());
        if (waitMs > 0) {
          await Promise.race([
            Promise.resolve(sleep(waitMs)).then(() => {}, () => {}),
            stoppedPromise,
          ]);
          waitMs = Math.max(0, lastStartAtMs + intervalMs - Date.now());
          if (waitMs > 0) state.intervalShortfalls += 1;
        }
      }
      if (stopped) break;
      const attemptIndex = state.attemptCount + 1;
      state.attemptCount = attemptIndex;
      const startedAtMs = Date.now();
      lastStartAtMs = startedAtMs;
      inFlightAttemptIndex = attemptIndex;
      let result;
      try {
        result = await supplier();
      } catch (error) {
        // Clause 4: an unreadable supplier is a named observer reason on the
        // attempt's summary — never a business failure.
        result = { aggregate: 'unestablished', reasons: [error instanceof Error ? error.message : String(error)] };
      }
      inFlightAttemptIndex = null;
      if (stopped) break; // the stop already recorded the abandonment; the late result is discarded
      const completedAtMs = Date.now();
      if (isDurableIdentityUnobservedResult(result)) {
        // BEFORE identity: an establishment probe — counted, named through the
        // registered baseline omission, never a sample summary (clause 1).
        // AFTER the baseline the read observed NO durable state (a mid-run
        // rollout-load failure yields the same block): a named omission on
        // the attempt (clause 4) — never an anonymous count bump (self-review
        // round 1).
        if (state.baseline !== null) {
          namedOmission({ attemptIndex, reason: 'durable-read-identity-unobserved' });
        }
        continue;
      }
      const incomingAggregate = /** @type {any} */ (result)?.aggregate ?? null;
      const isTransition = lastAggregate !== null && incomingAggregate !== lastAggregate;
      if (state.baseline === null) {
        state.baseline = { attemptIndex, startedAtMs, completedAtMs };
        state.identityEstablishedAtAttempt = attemptIndex;
        state.baselineOmittedReason = null;
      }
      if (state.summaries.length >= maxSummaries) {
        // §23.5 clause 4: at most 32 summaries are retained — but the ledger
        // must not evict the observations the schedule exists to capture
        // (codex backfill review: identity establishes promptly while the
        // §16.4 control clock schedules the interruption at ~80 s, so a flat
        // drop-at-the-cap ledger would discard every post-delivery
        // observation unrecoverably). The ledger ROLLS: the baseline and
        // every state-transition summary are PINNED, and a new summary at
        // the cap rolls off the oldest non-baseline non-transition summary
        // (preferring one whose aggregate matches the incoming sample — a
        // superseded run member), recording the roll-off as a named count.
        // Only when every slot is baseline-or-transition does the
        // summary-cap omission fire. The retained set is therefore baseline +
        // transitions + the newest observations, always ≤ the frozen bound.
        let victimIndex = -1;
        for (let index = 0; index < state.summaries.length; index += 1) {
          const candidate = state.summaries[index];
          if (candidate.baseline === true || candidate.transition === true) continue;
          if (candidate.aggregate === incomingAggregate) { victimIndex = index; break; }
        }
        if (victimIndex === -1) {
          for (let index = 0; index < state.summaries.length; index += 1) {
            const candidate = state.summaries[index];
            if (candidate.baseline === true || candidate.transition === true) continue;
            victimIndex = index;
            break;
          }
        }
        if (victimIndex === -1) {
          namedOmission({ attemptIndex, reason: 'durable-sampling-summary-cap-reached' });
          lastAggregate = incomingAggregate;
          continue;
        }
        state.summaries.splice(victimIndex, 1);
        state.summariesRolledOff += 1;
      }
      state.summaries.push(summarize(result, attemptIndex, startedAtMs, completedAtMs, state.baseline.attemptIndex === attemptIndex, isTransition));
      lastAggregate = incomingAggregate;
    }
    if (!stopped && state.attemptCount >= maxAttempts) {
      // Clause 4: reads beyond the attempt cap are omitted by name.
      namedOmission({ reason: 'durable-sampling-attempt-cap-reached' });
      omitBaseline();
    }
  })().catch(() => { /* the detached sampler never fails the held turn */ });
  return {
    state,
    stopAtTerminationBoundary: () => { stop('durable-sampling-stopped-at-termination-boundary'); },
    stateSnapshot: () => ({ ...state, summaries: state.summaries.slice(), omissions: state.omissions.slice() }),
  };
}

/**
 * Join the settlement layers and the typed durable snapshot into the
 * persisted watch outcome (2026-10-21 evidence-closure Task 2; codex round 5
 * finding 2 named the failed watch; codex round 6 finding 2 extended its use
 * to the budget-expiry path so the independently completed durable facts are
 * never dropped there either).
 * @param {boolean} watchFailed @param {{ observed: boolean, basis: string | null } | null} childSettlement
 * @param {{ remoteTerminal: boolean | null, localProcessReaping: 'natural-exit-observed' | 'cleanup-terminated' | null, durableObligations: 'settled' | 'unresolved' | null }} settlementLayers
 * @param {Record<string, unknown> | undefined} durableSnapshot
 * @returns {{ observed: boolean, basis: string | null, layers?: { remoteTerminal: boolean | null, localProcessReaping: 'natural-exit-observed' | 'cleanup-terminated' | null, durableObligations: 'settled' | 'unresolved' | null }, durableSnapshot?: Record<string, unknown>, durableSamples?: Record<string, unknown> } | null}
 */
function joinChildSettlementRecord(watchFailed, childSettlement, settlementLayers, durableSnapshot) {
  if (watchFailed && childSettlement === null) {
    return {
      observed: false,
      basis: 'child-settlement-watch-failed',
      layers: settlementLayers,
      ...(durableSnapshot === undefined ? {} : { durableSnapshot }),
    };
  }
  return childSettlement === null
    ? null
    : { ...childSettlement, layers: settlementLayers, ...(durableSnapshot === undefined ? {} : { durableSnapshot }) };
}

/**
 * The default executor's durable supplier: ONLY the status-wait fixture has
 * a pre-known exact bound job identity (the production-reserved owned job
 * with its recorded owner session). Every other case's job is created inside
 * the live host session and is not addressable pre-run — that not-applicable
 * branch is this named source contract (null supplier), never a silent null
 * layer. The supplier is fully passive: readDurableObligationSnapshot never
 * creates, chmods, locks, or updates anything (§19.5).
 * @param {ShellWaitFixtureHandle | null} fixture
 * @param {{ jobId: string, ownerSessionId: string } | null} [observedIdentity]
 * @returns {(() => Promise<Record<string, unknown>>) | null}
 */
export function statusWaitDurableSnapshotSupplier(fixture, observedIdentity = null) {
  const dataRoot = /** @type {any} */ (fixture)?.env?.ZCODE_DATA_ROOT;
  const workspace = /** @type {any} */ (fixture)?.workspace;
  if (typeof dataRoot !== 'string' || typeof workspace !== 'string') return null;
  // The OBSERVED identity (the launch acknowledgement's reserved job id and
  // owning session) is the live binding — established from the observed
  // rollout, never guessed. The fixture-owned reserved job remains the
  // instrument-level fallback. Neither source present: null supplier (the
  // executor records the NAMED reason), never a fabricated identity.
  const observedJobId = observedIdentity !== null && typeof /** @type {any} */ (observedIdentity).jobId === 'string'
    ? /** @type {any} */ (observedIdentity).jobId : null;
  const observedOwnerSessionId = observedIdentity !== null && typeof /** @type {any} */ (observedIdentity).ownerSessionId === 'string'
    ? /** @type {any} */ (observedIdentity).ownerSessionId : null;
  const statusJob = /** @type {any} */ (fixture)?.statusJob;
  const jobId = observedJobId ?? (statusJob && typeof statusJob.jobId === 'string' ? statusJob.jobId : null);
  const ownerSessionId = observedOwnerSessionId ?? /** @type {any} */ (fixture)?.owningSessionId;
  if (typeof jobId !== 'string' || typeof ownerSessionId !== 'string') return null;
  return () => readDurableObligationSnapshot({ dataRoot, workspace, ownerSessionId, jobId });
}

/**
 * The rescue-interrupt case's durable settlement reader (2026-10-21
 * evidence-closure Task 3; ownership corrected by codex round 1): the §16.2
 * trace froze that a native Child interruption settles the turn and its
 * active cells but does NOT terminate the worker/Companion process and does
 * NOT cancel the plugin's durable job — so the completion-shaped
 * child-settlement watch can never settle this path, and the durable
 * obligation snapshot is THE settlement reader for the Companion outcome and
 * the durable winner/duties.
 *
 * OWNERSHIP (the production contract, verified by reading
 * scripts/zcode-companion.mjs: the caller resolves through the executor's
 * PARENT session (:862 `sessionId: executor?.parentSessionId ?? …`) and the
 * reservation is `ownerSessionId: caller.sessionId` (:1464, reserved :1530))
 * — the durable job belongs to the ROOT, never to the Child running the
 * launcher. The reader therefore binds ownership to the OBSERVED PARENT
 * identity and VERIFIES the job's executor binding against the OBSERVED
 * CHILD identity (`expectedExecutorAgentId` — a binding whose `childAgentId`
 * disagrees is the named `binding-executor-mismatch` unknown state, never
 * settled). The exact job resolves through the owner-index join
 * (`resolveJobFromOwnerIndex`): the job is created inside the live session
 * and is never addressable pre-run, and a partition with multiple valid
 * owned jobs stays named-unestablished (never latest-job guessing, §19.5).
 * No observable identity — either one missing, or an inexact join — means NO
 * supplier: the executor records the NAMED reason, never a silent null
 * layer.
 * @param {ShellWaitFixtureHandle} fixture
 * @param {{ exact?: boolean, childThreadId?: unknown, parentThreadId?: unknown } | null} observedIdentity
 *   the {@link observeSpawnAcknowledgementIdentity} projection for the run's
 *   own rollouts (the exact spawn-acknowledgement join: BOTH the Root parent
 *   and the Child)
 * @returns {(() => Promise<Record<string, unknown>>) | null}
 */
export function interruptDurableSnapshotSupplier(fixture, observedIdentity = null) {
  const dataRoot = /** @type {any} */ (fixture)?.env?.ZCODE_DATA_ROOT;
  const workspace = /** @type {any} */ (fixture)?.workspace;
  if (typeof dataRoot !== 'string' || typeof workspace !== 'string') return null;
  const childThreadId = observedIdentity !== null && typeof /** @type {any} */ (observedIdentity).childThreadId === 'string'
    && /** @type {any} */ (observedIdentity).childThreadId.length > 0
    ? /** @type {any} */ (observedIdentity).childThreadId : null;
  const parentThreadId = observedIdentity !== null && typeof /** @type {any} */ (observedIdentity).parentThreadId === 'string'
    && /** @type {any} */ (observedIdentity).parentThreadId.length > 0
    ? /** @type {any} */ (observedIdentity).parentThreadId : null;
  // Only the EXACT spawn-acknowledgement join carrying BOTH identities may
  // bind the reader: the owner is the observed PARENT (Root) session and the
  // executor claim is verified against the observed Child. An inexact or
  // half-observed identity never grounds the reader — the supplier stays
  // null with the named executor reason.
  if (observedIdentity === null || observedIdentity.exact !== true || childThreadId === null || parentThreadId === null) return null;
  return () => readDurableObligationSnapshot({
    dataRoot,
    workspace,
    ownerSessionId: parentThreadId,
    expectedExecutorAgentId: childThreadId,
    resolveJobFromOwnerIndex: true,
  });
}

/**
 * The interrupt partial-facts adjudicator's OWN version (2026-10-23
 * interrupt-closure Task 2, report §23.4): the offline-recoverable layer
 * facts that survive an aborted whole-case evidence adjudication — the
 * raw-rollout interrupt call facts, the spawn-acknowledgement identity, the
 * capture-vs-admission distinction and the source-rollout digest — are
 * stamped with THIS new identifier so they can never be mistaken for the
 * live observer's own adjudication (the provenance.observer digest) or for a
 * fresh installed-trial claim. v1 introduces the block.
 */
export const INTERRUPT_PARTIAL_FACTS_VERSION = 1;

/**
 * The offline Gate-D join's OWN version (2026-10-23 post-review fix, PR #72
 * review finding 2; the §19.9 v1/v2 precedent mechanism): v1 was the
 * unversioned original join whose recorded outputs (report §23.10.6/§23.11.3)
 * stand as history; v2 wires the recovered spawn identity into the join's
 * identity gates (the exact-target gate accepts the persisted
 * `interrupt.partialFacts.spawnIdentity` block; the durable owning-Root
 * binding is proven by exact observed identity) and admits PRE-BOUNDARY
 * per-sample facts from the persisted `child.durableSamples` block when the
 * final snapshot is fenced out (the §23.5 fence, each sample independently).
 * v3 (2026-10-26 native-acceptance Task 2, report §24.4) is the relocated
 * causal-contract input growth: the persisted admission block now carries the
 * typed `acknowledgementAtResolution` fact (the §24.4 f2 submission-result
 * shape) beside the REQUEST-side window conjunct, and the join exposes it
 * additively in the delivery block — never a verdict change on any recorded
 * input (the F/I replay proves the recorded verdicts byte-identical).
 * Every join output embeds this version (`gateDJoinVersion`) so a v2/v3
 * adjudication can never be mistaken for a recorded v1 verdict or re-stamped
 * over one — old verdicts are preserved verbatim, and a record without
 * samples reproduces its recorded v1 verdict fields exactly.
 */
export const NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION = 3;

/**
 * The whitelisted per-sample projection consumed by the offline Gate-D join
 * (2026-10-23 post-review fix, PR #72 review finding 2): bounded closed
 * facts only — counts, instants, aggregate/layer labels and the cause
 * provenance the Task-3 sampling fix already whitelisted on every summary
 * (`jobStatus`/`stopCause`/`stopIntentCause`/`stopIntentRequestedAt`). Never
 * a record body, never a private path, never an inferred value.
 * @param {any} summary a persisted §23.5 sampling summary
 * @param {number | null} attemptIndex the summary's safe-integer attempt index
 * @param {number} completedAtMs the summary's own proven finite completion instant
 * @param {'pre-boundary' | 'boundary-unrecorded'} timingState the §23.5 fence state
 * @param {boolean} creditEligible whether the strict pre-boundary fence admits it
 * @returns {{ attemptIndex: number | null, baseline: boolean, transition: boolean, startedAtMs: number | null, completedAtMs: number, aggregate: string | null, jobPresence: string | null, jobStatus: string | null, stopCause: string | null, stopIntentCause: string | null, stopIntentRequestedAt: string | null, executorLinkage: 'verified' | null, snapshotEqual: boolean | null, lockState: string | null, partitionStatus: string | null, timingState: 'pre-boundary' | 'boundary-unrecorded', creditEligible: boolean }}
 */
function buildAdmittedSample(summary, attemptIndex, completedAtMs, timingState, creditEligible) {
  return {
    attemptIndex,
    baseline: summary.baseline === true,
    transition: summary.transition === true,
    startedAtMs: typeof summary.startedAtMs === 'number' && Number.isSafeInteger(summary.startedAtMs) ? summary.startedAtMs : null,
    completedAtMs,
    aggregate: typeof summary.aggregate === 'string' ? summary.aggregate : null,
    jobPresence: typeof summary.jobPresence === 'string' ? summary.jobPresence : null,
    jobStatus: typeof summary.jobStatus === 'string' ? summary.jobStatus : null,
    stopCause: typeof summary.stopCause === 'string' ? summary.stopCause : null,
    stopIntentCause: typeof summary.stopIntentCause === 'string' ? summary.stopIntentCause : null,
    stopIntentRequestedAt: typeof summary.stopIntentRequestedAt === 'string' ? summary.stopIntentRequestedAt : null,
    executorLinkage: summary.executorLinkage === 'verified' ? 'verified' : null,
    // The RAW tri-state — never coerced: `true` is the positive proof,
    // `false` is the torn record, and `null`/missing is the unproven
    // fingerprint (a real named reader state) — so an admitted
    // observation fact can never be mistaken for a torn one.
    snapshotEqual: summary.snapshotEqual === true ? true : summary.snapshotEqual === false ? false : null,
    lockState: typeof summary.lockState === 'string' ? summary.lockState : null,
    partitionStatus: typeof summary.partitionStatus === 'string' ? summary.partitionStatus : null,
    timingState,
    creditEligible,
  };
}

/**
 * The offline Gate D join (2026-10-21 evidence-closure Task 3): ONE place
 * maps a persisted case record into the frozen native-interruption oracle's
 * input (release-qualification.mjs evaluateNativeInterruptionSettlement), wiring EVERY layer through the exact observed identity. The
 * mappings follow the §19.2 offline re-adjudication conventions (record
 * facts only, null stays unestablished) extended with the Task 3 facts:
 * the §19.4 host-activity admission (a record without the block — a legacy
 * shape — fails closed `host-activity-unadmitted`), the closed
 * pending-window / pre-call-completion / cleanup-generated facts, and the
 * settlement readers' outputs (the child settlement layers + the typed
 * durable snapshot) joined to the Companion/durable/terminal layers. The
 * join authorizes nothing by itself: the frozen oracle remains the sole
 * adjudicator.
 * @param {Record<string, any>} record the persisted case record
 * @returns {{ delivery: { delivered: boolean | null, exactTargetMatch: boolean | null, aliasResolved: boolean | null,
 *   terminalBeforeInterruptBasis: string, terminalBeforeInterrupt: boolean | null, deliverySent: boolean | null, previousStatusOnly: boolean, unreadableContinuation: boolean, pendingWindowConfirmed: boolean | null, hostActivityAdmitted: boolean | null, acknowledgementAtResolution: string | null }, turnSettled: boolean | null, deliveryToSettlementMs: number | null, companionOutcome: 'ceased' | 'terminal-result' | 'survived-unsettled' | null, durableObligations: 'settled' | 'unresolved' | null, cleanupKill: boolean, survivalControl: Record<string, unknown> | null, terminalWinner: 'succeeded' | 'failed' | 'cancelled' | null, naturalCompletionObserved: boolean, statusObservationTimeoutOnly: boolean, durableReadPostCleanupBoundary: boolean, durableReadBoundaryBasis: string | null, gateDJoinVersion: number, spawnIdentityJoin: { exact: boolean, owningRootBound: boolean | null, executorVerified: boolean | null } | null, durableSamplesJoin: { considered: boolean, boundaryRecorded: boolean, settlementFallback: { used: boolean, basis: string, sample: Record<string, unknown> | null }, admitted: Record<string, unknown>[], refused: { attemptIndex: number | null, reason: string }[] } }}
 */
export function nativeInterruptionGateDInput(record) {
  if (!record || typeof record !== 'object') throw invalidCaseInput('the Gate D join needs the persisted case record.');
  const interrupt = /** @type {any} */ (record).interrupt ?? {};
  const observations = /** @type {any} */ (record).observations ?? {};
  const child = /** @type {any} */ (record).child ?? {};
  const settlementLayers = child.settlementLayers ?? null;
  const durableSnapshot = child.durableSnapshot ?? null;
  // POST-REVIEW FIX (2026-10-23, PR #72 review finding 2, join v2): the
  // persisted §23.4 partial-facts block carries the INDEPENDENTLY recovered
  // spawn-acknowledgement identity (exact `observeSpawnAcknowledgementIdentity`
  // join over the captured rollouts, digest-cited). The join consumes it —
  // EXACT identity only: the block must be the versioned partial-facts
  // adjudicator's and must carry both ids; a missing block (legacy records)
  // or an inexact recovery keeps every identity gate unestablished (never
  // inferred), and any durable-side disagreement is the named-unestablished
  // mismatch.
  const spawnIdentityBlock = interrupt.partialFacts && typeof interrupt.partialFacts === 'object'
    && interrupt.partialFacts.adjudicator === 'interrupt-partial-facts'
    && interrupt.partialFacts.spawnIdentity && typeof interrupt.partialFacts.spawnIdentity === 'object'
    ? interrupt.partialFacts.spawnIdentity
    : null;
  const spawnIdentityExact = spawnIdentityBlock?.checked === true && spawnIdentityBlock.exact === true
    && typeof spawnIdentityBlock.childThreadId === 'string' && spawnIdentityBlock.childThreadId.length > 0
    && typeof spawnIdentityBlock.parentThreadId === 'string' && spawnIdentityBlock.parentThreadId.length > 0;
  // The exact identity join: the delivery facts are only as good as the
  // observed linkage. A record that lost its Child id keeps the target
  // attribution unestablished (the admission block still rides — it was
  // established during the run) — the frozen oracle refuses the layer.
  // Join v2: the persisted exact spawn identity is an ALTERNATIVE proof of
  // the same linkage (a supported-case analysis that aborted never erases a
  // recoverable exact identity; the §19.9-consistent old-record behavior is
  // unchanged — a v1 record with `exactTargetMatch: true` always rode a
  // supported linkage, so the additional disjunct never flips an old
  // verdict).
  const exactTargetEstablished = interrupt.exactTargetMatch === true
    && (typeof (/** @type {any} */ (record).linkage)?.childThreadId === 'string' || spawnIdentityExact === true);
  // POST-REVIEW FIX 3 (2026-10-26, the user-review round-3 finding): the
  // SUPPORTED-CASE linkage (`record.linkage` — the Root/Child identity the
  // successful whole-case analysis establishes, exact when both ids ride
  // non-empty) is THE SAME identity evidence as the recovered spawn
  // acknowledgement: both are exact Root/Child joins over the same run. The
  // exact-identity gate below therefore consumes the UNION of the two
  // registered sources — the §23.4 partial-facts recovery AND the
  // supported-case linkage — so a normally-analyzed record can never bypass
  // the durable-owner conflict check (the round-2 gate's scope was
  // spawn-recovery-only; the reproduced shape — linkage Root A, durable
  // owner B — rode `spawnIdentityJoin: null` beside `qualified: true`).
  const linkageIdentityExact = typeof (/** @type {any} */ (record).linkage)?.childThreadId === 'string'
    && (/** @type {any} */ (record).linkage).childThreadId.length > 0
    && typeof (/** @type {any} */ (record).linkage)?.parentThreadId === 'string'
    && (/** @type {any} */ (record).linkage).parentThreadId.length > 0;
  // The durable owning-Root binding, proven at record level by EXACT
  // observed identity (join v2): the snapshot's owner session must equal the
  // spawn acknowledgement's Root id. Either side absent → unestablished
  // (null); a disagreement → false (the named mismatch — never resolved).
  const durableJobProjection = durableSnapshot?.job?.presence === 'found'
    && durableSnapshot?.job?.projection && typeof durableSnapshot.job.projection === 'object'
    ? durableSnapshot.job.projection
    : null;
  // The owner id must be NONEMPTY to be resolvable (self-review P3, the
  // sibling guard style: the spawn ids require length > 0, the sample anchor
  // is bounded 1–128) — an empty-string owner id is UNRESOLVABLE (null, the
  // named-unestablished path), never a resolvable side of a conflict.
  const durableOwnerSessionId = typeof durableJobProjection?.ownerSessionId === 'string' && durableJobProjection.ownerSessionId.length > 0
    ? durableJobProjection.ownerSessionId
    : null;
  const durableExecutorVerified = durableSnapshot && typeof durableSnapshot === 'object'
    ? durableSnapshot.executorLinkage === 'verified'
    : false;
  // The exact Root identities the record carries, from BOTH registered
  // sources (the round-3 union): the §23.4 spawn-recovery block and the
  // supported-case linkage. An inexact or missing side is UNRESOLVABLE
  // (null) — never a conflict side.
  const spawnRecoveryRootThreadId = spawnIdentityExact ? spawnIdentityBlock.parentThreadId : null;
  const linkageRootThreadId = linkageIdentityExact ? (/** @type {any} */ (record).linkage).parentThreadId : null;
  // Cross-source agreement (the round-3 registration): when BOTH exact Root
  // sources ride the record and DISAGREE, the identity evidence itself is
  // contradictory — the same conflict state as an owner disagreement, even
  // before the durable side is compared (a durable owner could match at most
  // one of them, so the durable chain's provenance is undecidable). The
  // mapper-surveyed reachability: a mapper-produced record NEVER carries
  // both sources (the abort path persists the partial-facts block beside an
  // all-null linkage; the supported path persists the linkage with no block;
  // the mapper's own resolveInterruptIdentity guard additionally nulls a
  // disagreeing pair for the ADMISSION binding only — the record-level
  // cross-check here is the authoritative one for any record that does
  // carry both, and it fails closed).
  const rootSourcesDisagree = spawnRecoveryRootThreadId !== null && linkageRootThreadId !== null
    && spawnRecoveryRootThreadId !== linkageRootThreadId;
  const owningRootBound = rootSourcesDisagree
    ? false
    : durableOwnerSessionId === null || !(spawnIdentityExact || linkageIdentityExact)
      ? null
      : durableOwnerSessionId === (spawnRecoveryRootThreadId ?? linkageRootThreadId);
  const spawnIdentityJoin = spawnIdentityBlock === null && !spawnIdentityExact && !linkageIdentityExact
    ? null
    : {
      exact: spawnIdentityExact || linkageIdentityExact,
      owningRootBound,
      executorVerified: durableSnapshot && typeof durableSnapshot === 'object'
        ? durableExecutorVerified
        : null,
    };
  // POST-REVIEW FIX 2 (2026-10-25, the user-review round-2 finding): the
  // CONFLICT shape — a Root identity and the durable job's owner BOTH exact
  // and resolvable and DISAGREEING (the computed `owningRootBound ===
  // false`) — is contradictory identity evidence: the durable-side chain is
  // not provably THE interrupted child's job. POST-REVIEW FIX 3
  // (2026-10-26, the user-review round-3 finding): the Root side is the
  // UNION of the registered sources — the recovered spawn acknowledgement
  // AND the verified supported-case linkage (`record.linkage`) — so the
  // normally-analyzed records enter the SAME conflict gate (either source's
  // disagreement refuses; the two sources must also agree with each other).
  // The conflict gates EVERY durable-side credit consumer below
  // (`durableEstablished`, the obligations snapshot branch and the
  // pre-boundary sample settlement fallback) and rides the join output for
  // the oracle's NAMED refusal (`owning-root-identity-conflict` — ONE
  // reason whatever the source; the conflict's source distinction is
  // registered here, not as a second reason or a new output field, keeping
  // the oracle input contract and every retained-record replay
  // byte-identical). One side unresolvable (null) stays the
  // named-unestablished path — never conflated with the conflict; the
  // exact-match keeper is unchanged.
  const durableOwnerIdentityConflict = spawnIdentityJoin?.owningRootBound === false;
  // SIBLING-SWEEP NOTE (codex round-2 fix, §23.14): the fenced-out final read
  // (the unestablished placeholder with no job projection) leaves
  // `spawnIdentityJoin.owningRootBound` null by the same discarded-projection
  // dependence — and STAYS null by design: the sample summaries carry no
  // owner-session fact, so the FINAL read's owning-Root binding is
  // unestablishable once that read is discarded (named-unestablished, never
  // re-derived). The SAMPLES' own identity is what the gate below re-grounds.
  // The persisted exact spawn-identity binding — the record-level anchor that
  // SURVIVES the fenced placeholder (either the §23.4 partial-facts block or
  // the supported-case linkage): both ids present, exact.
  const persistedSpawnIdentityBound = spawnIdentityExact === true || linkageIdentityExact;
  const durableAggregate = durableSnapshot && typeof durableSnapshot === 'object' ? durableSnapshot.aggregate ?? null : null;
  const rawJobStatus = durableSnapshot?.job?.presence === 'found'
    && durableSnapshot?.job?.projection && typeof durableSnapshot.job.projection === 'object'
    ? durableSnapshot.job.projection.status ?? null
    : null;
  // Only a production-TERMINAL status is an observed winner (the §19.5
  // TERMINAL set); anything else stays null, never a positive fact.
  const jobStatus = rawJobStatus === 'succeeded' || rawJobStatus === 'failed' || rawJobStatus === 'cancelled' ? rawJobStatus : null;
  // Codex overall review (2026-10-22, the strict PRE-boundary fence): the
  // durable read's OWN completion timestamp is compared against the FINAL
  // recorded cleanup boundary (`interrupt.cleanupBoundaryAtMs`) — a read
  // completing AT or AFTER the boundary is a CLEANUP-TIME observation (the
  // §20.5-item-5 semantics the recorded I case's manual overlay applied,
  // report §21.2.3 — now code-enforced) and grounds NO qualification credit:
  // the Companion outcome, the terminal winner and the obligations aggregate
  // stay UNPUBLISHED below, with the established round-19
  // cleanup-attribution basis riding the join (never silently dropped). The
  // fence is established only when BOTH endpoints exist; a read with no
  // comparable boundary keeps the prior behavior.
  // 2026-10-23 interrupt-closure Task 3 (report §23.5 strict fence, offline
  // replay arm): when a boundary IS recorded, the snapshot must PROVE a
  // finite completion instant strictly before it. A missing or non-finite
  // instant (including a foreign clock representation — never parsed) leaves
  // the fence's timing endpoint unestablishable: the credit is withheld with
  // the named `durable-read-timing-unestablished` basis (the ONLINE fence
  // already refuses an unstamped completion via buildDurableSettlementLayer's
  // `completionAtMs === null` arm — this closes the replay gap). A snapshot
  // whose own fingerprint inequality rode the record is torn (§19.5): its
  // layers stay unknown, so a settled aggregate label beside
  // `passive.snapshotEqual === false` is never trusted.
  const durableCompletedAtMs = durableSnapshot && typeof durableSnapshot === 'object'
    ? /** @type {any} */ (durableSnapshot).completedAtMs ?? null
    : null;
  const cleanupBoundaryAtMs = typeof interrupt.cleanupBoundaryAtMs === 'number'
    ? interrupt.cleanupBoundaryAtMs
    : null;
  const durableTimingEstablished = typeof durableCompletedAtMs === 'number' && Number.isFinite(durableCompletedAtMs);
  const durableReadAtOrAfterBoundary = cleanupBoundaryAtMs !== null
    && durableTimingEstablished
    && /** @type {number} */ (durableCompletedAtMs) >= cleanupBoundaryAtMs;
  const durableReadTimingUnestablished = cleanupBoundaryAtMs !== null && !durableTimingEstablished;
  const durableSnapshotTorn = durableSnapshot && typeof durableSnapshot === 'object'
    && /** @type {any} */ (durableSnapshot).passive !== null && typeof /** @type {any} */ (durableSnapshot).passive === 'object'
    ? /** @type {any} */ (durableSnapshot).passive.snapshotEqual === false
    : false;
  // The credit-withholding state (the fence plus the snapshot-integrity
  // guard): a withheld read publishes no Companion/winner/obligations credit,
  // and the named basis says which withholding fired (at/after boundary →
  // the established round-19 cleanup attribution; unprovable timing → the
  // §23.5 strict-fence timing basis; a torn snapshot is refused through the
  // durableEstablished gate below — the snapshot's own `snapshot-unequal`
  // reason rides the record).
  const durableCreditWithheld = durableReadAtOrAfterBoundary || durableReadTimingUnestablished;
  // POST-REVIEW FIX (2026-10-23, PR #72 review finding 2, join v2): the
  // persisted pre-cleanup samples (`child.durableSamples`, report §23.5)
  // enter adjudication — previously the join consumed ONLY the final
  // snapshot, so a valid job-state sample captured well before the
  // teardown-time final read was excluded wholesale (the §23.10.5 recorded
  // timeline). Each sample is admitted INDEPENDENTLY:
  //   identity — the reader's POSITIVELY verified executor linkage AND the
  //     sample's anchored job id equal to the join's own job identity (the
  //     §23.5 supplier binding; never latest-job guessing);
  //   integrity — a POSITIVELY equal partition fingerprint (a torn sample —
  //     `snapshotEqual === false` — is refused by name; an UNPROVEN
  //     fingerprint — `null`/missing, the real named reader state
  //     `pre-read-fingerprint-unavailable`/`post-read-fingerprint-unavailable`
  //     — can never credit: the self-review finding-1 registration ADMITS it
  //     as a named observation fact with `creditEligible: false` and the raw
  //     tri-state `snapshotEqual` preserved, because its identity/cause/
  //     timing facts are real observations unlike a torn sample's
  //     contradictory aggregate; it never becomes the settlement fallback
  //     and never grounds a positive settlement-layer fact);
  //   fence — the sample's OWN completion instant strictly BEFORE the
  //     recorded cleanup boundary (the §23.5 fence: equality/later are
  //     refused by name; a missing or foreign-clock instant is
  //     named-unestablished, never parsed; with NO recorded boundary the
  //     fence is unestablishable and the samples stay OBSERVATION FACTS
  //     with their `boundary-unrecorded` fence state named).
  // When the FINAL snapshot is fenced out (withheld), the LATEST admissible
  // pre-boundary sample grounds the settlement LAYER facts (the obligations
  // aggregate and the Companion remote outcome) — the fenced snapshot itself
  // never regains credit. CAUSE DISCIPLINE (absolute): the four causes stay
  // distinct — the whitelisted cause provenance
  // (jobStatus/stopCause/stopIntentCause/stopIntentRequestedAt) rides the
  // output verbatim; the Gate-D "real terminal winner" conjunct is NEVER
  // flipped by sample facts (a stop-cause-carrying sample winner — session
  // -end or any non-interrupt cause — yields OBSERVED LAYER FACTS ONLY,
  // never native-interrupt settlement credit); and samples never touch
  // turnSettled/cleanupKill/naturalCompletionObserved.
  const durableSamplesBlock = child.durableSamples && typeof child.durableSamples === 'object'
    && Array.isArray(child.durableSamples.summaries)
    ? child.durableSamples
    : null;
  /** @type {{ attemptIndex: number | null, baseline: boolean, transition: boolean, startedAtMs: number | null, completedAtMs: number, aggregate: string | null, jobPresence: string | null, jobStatus: string | null, stopCause: string | null, stopIntentCause: string | null, stopIntentRequestedAt: string | null, executorLinkage: 'verified' | null, snapshotEqual: boolean | null, lockState: string | null, partitionStatus: string | null, timingState: 'pre-boundary' | 'boundary-unrecorded', creditEligible: boolean }[]} */
  const sampleAdmissions = [];
  /** @type {{ attemptIndex: number | null, reason: string }[]} */
  const sampleRefusals = [];
  if (durableSamplesBlock !== null) {
    for (const summary of durableSamplesBlock.summaries) {
      if (!summary || typeof summary !== 'object') {
        sampleRefusals.push({ attemptIndex: null, reason: 'sample-shape-unestablished' });
        continue;
      }
      const attemptIndex = Number.isSafeInteger(summary.attemptIndex) ? summary.attemptIndex : null;
      // Integrity first: a torn sample is refused before anything else.
      if (summary.snapshotEqual === false) {
        sampleRefusals.push({ attemptIndex, reason: 'sample-torn' });
        continue;
      }
      // The exact identity binding: the sample must provably read THE job
      // identity the join requires. TWO arms (codex round-2 fix, §23.14):
      //   final projection present — the sample's anchored job id must EQUAL
      //     the final read's job id (the strongest cross-check: sample and
      //     final read proven to read the same job);
      //   final read FENCED OUT — the online builder replaced it with the
      //     unestablished placeholder carrying NO job projection, so the
      //     cross-check anchor does not exist. The identity then binds from
      //     what survives exact: the reader's POSITIVELY verified executor
      //     linkage, the sample's OWN anchored job id (the reader's
      //     bindingCurrency contract anchor — a bounded exact id, never an
      //     alias), and the PERSISTED exact spawn-identity binding (the
      //     §23.4 partial-facts block or the supported-case linkage). The
      //     discarded final projection never orphans the pre-boundary
      //     samples — and no gate is relaxed: proven integrity, the
      //     pre-boundary fence and the cause discipline apply unchanged.
      const anchorsJob = summary.layers && typeof summary.layers === 'object'
        && summary.layers.bindingCurrency && typeof summary.layers.bindingCurrency === 'object'
        ? summary.layers.bindingCurrency.anchorsJob
        : null;
      const durableJobId = typeof durableJobProjection?.id === 'string' ? durableJobProjection.id : null;
      const anchorsJobExact = typeof anchorsJob === 'string' && anchorsJob.length > 0 && anchorsJob.length <= 128;
      const identityBound = durableJobId !== null
        ? summary.executorLinkage === 'verified' && anchorsJobExact && anchorsJob === durableJobId
        : summary.executorLinkage === 'verified' && anchorsJobExact && persistedSpawnIdentityBound;
      if (!identityBound) {
        sampleRefusals.push({ attemptIndex, reason: 'sample-identity-unbound' });
        continue;
      }
      const completedAtMs = summary.completedAtMs;
      if (typeof completedAtMs !== 'number' || !Number.isFinite(completedAtMs) || !Number.isSafeInteger(completedAtMs)) {
        sampleRefusals.push({ attemptIndex, reason: 'sample-timing-unestablished' });
        continue;
      }
      if (cleanupBoundaryAtMs === null) {
        // No recorded boundary: the fence is unestablishable — the sample
        // rides as an observation fact with its fence state named, never as
        // substitute credit.
        sampleAdmissions.push(buildAdmittedSample(summary, attemptIndex, completedAtMs, 'boundary-unrecorded', false));
        continue;
      }
      if (/** @type {number} */ (completedAtMs) >= cleanupBoundaryAtMs) {
        sampleRefusals.push({ attemptIndex, reason: 'sample-at-or-after-boundary' });
        continue;
      }
      // The integrity gate is a POSITIVE proof (self-review finding 1): only
      // a POSITIVELY equal fingerprint is credit-eligible — an unproven one
      // (null/missing) is admitted as a named observation fact
      // (`creditEligible: false`) and can never become the settlement
      // fallback nor ground a positive settlement-layer fact.
      if (summary.snapshotEqual !== true) {
        sampleAdmissions.push(buildAdmittedSample(summary, attemptIndex, completedAtMs, 'pre-boundary', false));
        continue;
      }
      sampleAdmissions.push(buildAdmittedSample(summary, attemptIndex, completedAtMs, 'pre-boundary', true));
    }
  }
  const creditSamples = sampleAdmissions.filter((sample) => sample.creditEligible);
  const fallbackSample = creditSamples.length > 0
    ? creditSamples.reduce((latest, sample) => (sample.completedAtMs > latest.completedAtMs ? sample : latest), creditSamples[0])
    : null;
  const settlementFallback = durableSamplesBlock === null
    ? { used: false, basis: 'no-samples-persisted', sample: null }
    // POST-REVIEW FIX 2: under the durable-owner identity conflict the
    // pre-boundary samples (anchored to the conflict's own job id) are
    // foreign-owner observations — the settlement fallback never fires on
    // them, with the named basis riding the provenance block.
    : durableOwnerIdentityConflict
      ? { used: false, basis: 'durable-owner-identity-conflict', sample: null }
      : durableCreditWithheld && fallbackSample !== null
        ? { used: true, basis: 'final-snapshot-fenced-pre-boundary-sample', sample: fallbackSample }
        : durableCreditWithheld
          ? { used: false, basis: 'no-admissible-pre-boundary-sample', sample: null }
          : { used: false, basis: 'final-snapshot-not-fenced', sample: null };
  // Codex round 2: the job's winner/executor evidence is consumable ONLY
  // from a POSITIVELY observed durable snapshot — an unestablished or torn
  // snapshot (e.g. the executor linkage unverified) is never consumed as
  // Companion/terminal evidence by the Gate D join.
  // Codex round 3: the durable obligations layer's own aggregate is never
  // enough for the CHILD-ATTRIBUTED outcomes — the reader's EXPORTED
  // executor-linkage fact must be POSITIVELY 'verified' (an `unresolved`
  // aggregate — terminal + marked claim — can coexist with a mismatched or
  // unverified executor; the named cause then rides the record and the
  // obligations layer keeps reporting its own per-fact state).
  // POST-REVIEW FIX 2: a durable-owner identity conflict (the spawn
  // acknowledgement's Root and the job's owner both resolvable and
  // disagreeing) equally refuses the Child-attributed consumption — the
  // snapshot is never established as THIS child's durable job under it.
  const durableEstablished = (durableAggregate === 'settled' || durableAggregate === 'unresolved')
    && (durableSnapshot && typeof durableSnapshot === 'object'
      ? /** @type {any} */ (durableSnapshot).executorLinkage === 'verified'
      : false)
    && !durableSnapshotTorn
    && !durableOwnerIdentityConflict;
  // The Companion outcome layer (codex round 1 — the cancelled-poll path):
  // the completion-shaped watch is frozen out of the interrupt case, so the
  // CompanIONS's REMOTE outcome is observed through the durable job's
  // PRODUCTION-published terminal winner (§16.2: the worker publishes
  // succeeded/failed through the natural-terminal branch) — joined as this
  // layer's own named derivation, never null-by-omission when positively
  // observed. The LOCAL reaping layer stays null on this path (registered
  // §19.9 limitation: no post-abort poll exists to decode a Companion exit).
  /** @type {'ceased' | 'terminal-result' | 'survived-unsettled' | null} */
  let companionOutcome = null;
  // The overall-review fence applies to the DURABLE-derived branches only:
  // an at/after-boundary durable read publishes no Companion evidence (the
  // independently observed watch/reaping branches keep their own mapper-level
  // cleanup attribution).
  if (settlementLayers?.remoteTerminal === true) companionOutcome = 'terminal-result';
  else if (jobStatus !== null && durableEstablished && !durableCreditWithheld) companionOutcome = 'terminal-result';
  else if (settlementLayers?.localProcessReaping === 'natural-exit-observed') companionOutcome = 'ceased';
  // Codex round 3: the survived-unsettled classification is equally
  // CHILD-attributed (the durable work observed alive-unsettled) — it is
  // published only on a POSITIVELY verified executor linkage.
  else if (durableAggregate === 'unresolved' && durableEstablished && !durableCreditWithheld) companionOutcome = 'survived-unsettled';
  // POST-REVIEW FIX (join v2): a fenced-out final snapshot does not orphan
  // the pre-boundary observations — the latest admissible pre-boundary
  // sample grounds the Companion remote-outcome LAYER fact (never the
  // fenced snapshot's own value). The winner conjunct is deliberately NOT
  // fed from the sample (the cause discipline above).
  else if (settlementFallback.used === true && settlementFallback.sample !== null) {
    const sample = settlementFallback.sample;
    const sampleJobStatus = sample.jobStatus === 'succeeded' || sample.jobStatus === 'failed' || sample.jobStatus === 'cancelled'
      ? sample.jobStatus
      : null;
    if (sampleJobStatus !== null) companionOutcome = 'terminal-result';
    else if (sample.aggregate === 'unresolved') companionOutcome = 'survived-unsettled';
  }
  const completedBeforeCall = typeof interrupt.completedBeforeCallMs === 'number';
  const settledBasis = typeof interrupt.settledBasis === 'string' ? interrupt.settledBasis : null;
  // Codex round 5: the ADMITTED delivery inside a CONFIRMED window is the
  // authoritative host-delivery evidence — the admitted §19.4 item proves
  // the dispatch was received (host-resolved identity) and the confirmed
  // window proves the observation was pending at that dispatch. Missing or
  // unavailable settlement NEVER downgrades a proven delivery to a
  // previous-status-only snapshot. Settlement unavailability then rejects
  // ONLY the settlement layer (the named turn-settlement reason), never the
  // delivery layer's earned facts.
  const provenDelivery = interrupt.hostDelivery?.admitted === true
    && interrupt.pendingWindowObserved === true;
  // Codex round 6 — the ROOT-SPECIFIED three-valued terminalBeforeInterrupt
  // (never a boolean guess):
  //   true   ONLY on positive terminal evidence — the persisted terminal
  //          previous-status fact (the pinned AgentStatus labels, incl. a
  //          prior 'interrupted') or a demonstrably pre-call completion;
  //   false  ONLY on positive open-window evidence — an ADMITTED host item
  //          inside a confirmed pending window — with NO contradicting
  //          terminal evidence;
  //   null   on contradiction (both positive evidences coexist — NAMED, the
  //          basis records the why) or on NO evidence (named
  //          nothing-to-conclude): missing identity evidence is never a
  //          completion diagnosis, and the settlement basis is settlement
  //          evidence, not terminal-state evidence (an item-absent record
  //          with a cancellation settlement keeps the value unknown).
  const terminalPreviousStatusEvidence = typeof interrupt.previousStatus === 'string'
    && TERMINAL_INTERRUPT_PREVIOUS_STATUSES.has(interrupt.previousStatus);
  const preCallCompletionEvidence = completedBeforeCall || settledBasis === 'post-completion-delivery-not-attributed';
  const terminalStateEvidence = terminalPreviousStatusEvidence || preCallCompletionEvidence;
  /** @type {boolean | null} */
  let terminalBeforeInterrupt = null;
  /** @type {string} */
  let terminalBeforeInterruptBasis;
  if (provenDelivery === true && terminalStateEvidence) {
    terminalBeforeInterrupt = null;
    terminalBeforeInterruptBasis = 'contradiction-terminal-status-vs-open-window';
  } else if (terminalPreviousStatusEvidence) {
    terminalBeforeInterrupt = true;
    terminalBeforeInterruptBasis = 'terminal-previous-status-evidence';
  } else if (preCallCompletionEvidence) {
    terminalBeforeInterrupt = true;
    terminalBeforeInterruptBasis = 'pre-call-completion-evidence';
  } else if (provenDelivery === true) {
    terminalBeforeInterrupt = false;
    terminalBeforeInterruptBasis = 'admitted-open-pending-window';
  } else {
    terminalBeforeInterrupt = null;
    terminalBeforeInterruptBasis = 'no-terminal-state-evidence';
  }
  return {
    delivery: {
      delivered: typeof interrupt.delivered === 'boolean' ? interrupt.delivered : null,
      exactTargetMatch: exactTargetEstablished === true ? true : interrupt.exactTargetMatch === false ? false : null,
      aliasResolved: exactTargetEstablished === true ? true : null,
      terminalBeforeInterrupt,
      // Codex round 6: the NAMED basis for the three-valued fact (the
      // contradiction/no-evidence causes ride the record; the frozen oracle
      // rejects the delivery layer on null via its existing strict conjunct).
      terminalBeforeInterruptBasis,
      // A delivery with an observed outcome demonstrably dispatched; an
      // unobserved outcome keeps the dispatch unestablished (§19.2).
      deliverySent: interrupt.attempted === true ? (interrupt.delivered === null ? null : true) : interrupt.attempted === false ? false : null,
      // The §19.2 convention, REVISED by codex round 5: a PREVIOUS status is
      // the ONLY delivery evidence when no admitted host item corroborates a
      // confirmed pending window — a proven delivery (admitted item +
      // confirmed window) is never downgraded to a snapshot-only fact by an
      // unobserved settlement.
      previousStatusOnly: interrupt.previousStatus != null && interrupt.settled == null && provenDelivery !== true,
      unreadableContinuation: interrupt.unreadableContinuationObserved === true,
      // The Task 3 closed fact decides when PRESENT — true AND false alike
      // (codex round 5: an explicit false is a real negative observation —
      // the poll may have resolved before the interrupt; a historical poll
      // start never establishes pending-at-delivery). The legacy §19.2
      // fallback (the attributable poll start + bound ordering) applies ONLY
      // when the explicit field is ABSENT (legacy records).
      pendingWindowConfirmed: 'pendingWindowObserved' in interrupt
        ? interrupt.pendingWindowObserved === true
        : (observations.pollStartedAtElapsedMs != null && interrupt.orderingBound === true),
      // The §19.4 admission: a record without the block fails closed.
      hostActivityAdmitted: interrupt.hostDelivery && typeof interrupt.hostDelivery === 'object'
        ? interrupt.hostDelivery.admitted === true
        : null,
      // Join v3 (report §24.4, native-acceptance Task 2): the persisted typed
      // acknowledgement shape rides the delivery block additively — a
      // host-side SUBMISSION-RESULT fact (f2) that never by itself claims
      // Child receipt or processing and never flips a conjunct here. A record
      // without the fact (every retained I/F-era block) stays null.
      acknowledgementAtResolution: interrupt.hostDelivery && typeof interrupt.hostDelivery === 'object'
        ? (typeof interrupt.hostDelivery.acknowledgementAtResolution === 'string'
          ? interrupt.hostDelivery.acknowledgementAtResolution
          : null)
        : null,
    },
    turnSettled: typeof interrupt.settled === 'boolean' ? interrupt.settled : null,
    deliveryToSettlementMs: typeof interrupt.deliveryToSettlementMs === 'number' ? interrupt.deliveryToSettlementMs : null,
    companionOutcome,
    // Layer separation (codex round 3): the obligations layer reports its own
  // aggregate per-fact even when the Child-attributed outcomes are refused
  // for an unverified executor — or withheld by the overall-review
  // pre-boundary fence (an at/after-boundary durable read is cleanup-time
  // evidence, never qualification credit). Join v2: when the final snapshot
  // is fenced out, the LATEST admissible pre-boundary sample grounds the
  // aggregate (the fenced snapshot's own value never leaks).
  durableObligations: !durableCreditWithheld && !durableSnapshotTorn && !durableOwnerIdentityConflict && (durableAggregate === 'settled' || durableAggregate === 'unresolved')
    ? durableAggregate
    : settlementFallback.used === true && settlementFallback.sample !== null
      && (settlementFallback.sample.aggregate === 'settled' || settlementFallback.sample.aggregate === 'unresolved')
      ? settlementFallback.sample.aggregate
      : null,
    // The cleanup boundary is a mapper-level fact (the settled resolution's
    // own timestamp at/after the earliest recorded boundary): the join never
    // re-derives it from coarse kill flags.
    cleanupKill: interrupt.settlementCleanupGenerated === true,
    survivalControl: /** @type {any} */ (record).survivalControl ?? null,
    // CAUSE DISCIPLINE (join v2): the terminal winner is consumed ONLY from
    // the final durable snapshot — never from a sample (a session-end or
    // otherwise non-interrupt-caused sample winner stays an OBSERVED fact in
    // the durableSamplesJoin provenance block, and this conjunct is never
    // flipped by it).
    terminalWinner: durableEstablished && !durableCreditWithheld ? jobStatus : null,
    // Join v2 provenance (schema-additive): the join's own version, the
    // record-level spawn-identity join proof, and the per-sample admission
    // evaluation (admitted observation blocks with their fence state and
    // preserved cause provenance, plus named refusals).
    gateDJoinVersion: NATIVE_INTERRUPTION_GATE_D_JOIN_VERSION,
    spawnIdentityJoin,
    durableSamplesJoin: {
      considered: durableSamplesBlock !== null,
      boundaryRecorded: cleanupBoundaryAtMs !== null,
      settlementFallback,
      admitted: sampleAdmissions,
      refused: sampleRefusals,
    },
    // The overall-review fence's NAMED facts (schema-additive): whether the
    // durable read completed at/after the final recorded cleanup boundary,
    // and under which established cleanup-attribution basis the
    // Companion/winner/obligations credit was withheld (at/after boundary →
    // the round-19 basis; a boundary-recorded snapshot that cannot prove a
    // finite pre-boundary completion instant → the §23.5 timing basis).
    // Absent comparable endpoints → false/null (the fence is established
    // only when the boundary exists and the timing is proven).
    durableReadPostCleanupBoundary: durableReadAtOrAfterBoundary,
    durableReadBoundaryBasis: durableReadAtOrAfterBoundary
      ? 'budget-cleanup-termination-not-attributed'
      : durableReadTimingUnestablished ? 'durable-read-timing-unestablished' : null,
    // The natural-completion guard: a natural completion basis whose winner
    // was recorded `cancelled` is the misclassification the oracle blocks.
    naturalCompletionObserved: settledBasis === 'terminal-observation-after-delivery',
    // The interrupt case has no Status-deadline flow: the guard stays false.
    statusObservationTimeoutOnly: false,
  };
}

/**
 * The registered per-case stdout-capture requirement (2026-10-21
 * evidence-closure Task 3, the self-review round-1 producer wiring): the
 * §19.3(e) O1/I capture-preflight duty — the FIRST registered O1/I case must
 * verify the seam in-fixture — covers the interrupt case, so its live launch
 * REQUIRES the fixture-prepared stdout-capture seam. The set is CLOSED and
 * this export is its PRODUCER: Task 4's ledger freeze extends it to the
 * exact O1/O2 command case(s); a case not listed carries NO registered
 * capture requirement and is never blocked by the check (surveyed: before
 * this wiring the requirement had no producer — only hand-built test
 * fixtures set `stdoutCaptureRequired`, so a required-but-unprepared seam
 * passed the preflight silently).
 *
 * 2026-10-21 evidence-closure Task 4 ledger freeze (report §20.1/§20.8):
 * the O1 (`rescue-long`) and O2 (`rescue-repeat`) case designs REQUIRE the
 * attributable stdout/exit observer — O1's purpose is attributable full
 * stdout/exit with exact job linkage, and O2's is fresh matching
 * corroboration of O1's exact output — so membership arms the fixture's
 * capture seam at preparation (the {@link runShellWaitCase} threading) for
 * exactly the I/O1/O2 case designs. Enforcement layers, recorded not
 * re-decided: the named preflight rejection arm is exercised for the
 * interrupt case ({@link evaluateLiveLaunchPreflight}'s registered
 * interrupt-case observer checks); the O1/O2 requirement is enforced by this
 * arming plus the fail-closed capture admission (a capture-less run can
 * never produce a passing exact-output verdict — the named admission failure
 * rides the record).
 */
export const STDOUT_CAPTURE_REQUIRED_CASES = Object.freeze(new Set(['rescue-interrupt', 'rescue-long', 'rescue-repeat']));

/**
 * The registered wrapped-interrupt reliance (codex round 4 — the
 * supported-path limitation's preflight arm): a rescue-interrupt design that
 * RELIES on the code-mode-wrapped delivery path is rejected BEFORE any host
 * launch, because the wrapped path is NOT exact-target attributable on this
 * pin (the delegate-allocated nested exec id never persists — see the
 * evidence.mjs registration). The set is CLOSED and EMPTY: the registered I
 * design is the DIRECT (top-level interrupt_agent) invocation, the only
 * qualified interruption path. Task 4's ledger freeze extends the set at
 * this definition if a future design ever relies on the wrapped path; the
 * injectable dependency keeps the mechanism pipeline-testable.
 */
export const WRAPPED_INTERRUPT_REQUIRED_CASES = Object.freeze(new Set());

/**
 * The live-launch preflight (2026-10-21 evidence-closure Task 3, the Exit
 * clause): BEFORE any host launch, verify that every observer the
 * registered case design REQUIRES is actually armed on the fixture. A known
 * absent observer rejects the launch with its named reason — the case fails
 * closed at zero model turns instead of burning a registered live case on
 * an observation that could never be made. Checks (rescue-interrupt, the
 * Task 3 registered case):
 *   - the declared survival control's fixture-owned script file exists;
 *   - the durable settlement reader's partition basis (the fixture data
 *     roots) exists — the durable/Companion layers must be observable;
 *   - the registered stdout-capture requirement
 *     ({@link STDOUT_CAPTURE_REQUIRED_CASES}) is met by the fixture's
 *     ACTUAL prepared seam (the fixture-generated handle present and its
 *     preload file on disk).
 * Cases without registered Task-3 observers are not blocked by them.
 * @param {{ case: string, survivalControlSelector: string | null, fixture: any }} input
 * @param {{ lstat?: typeof import('node:fs/promises').lstat, wrappedInterruptRequiredCases?: readonly string[] }} [dependencies]
 * @returns {Promise<{ ok: boolean, reason: string | null }>}
 */
export async function evaluateLiveLaunchPreflight(input, dependencies = {}) {
  const lstat = dependencies.lstat ?? (await import('node:fs/promises')).lstat;
  const wrappedRequired = dependencies.wrappedInterruptRequiredCases ?? WRAPPED_INTERRUPT_REQUIRED_CASES;
  // (0) The wrapped-path reliance gate (codex round 4): a case whose
  // registered design relies on the code-mode-wrapped interrupt is refused
  // pre-launch — that path cannot establish the exact-target layer on this
  // pin (the registered limitation).
  if (input.case !== null && input.case !== undefined
    && Array.isArray(/** @type {readonly string[]} */ (wrappedRequired))
    && /** @type {readonly string[]} */ (wrappedRequired).includes(input.case)) {
    return { ok: false, reason: 'the registered design relies on the code-mode-wrapped interrupt path, which is not exact-target attributable on this pin (the wrapped-interrupt limitation)' };
  }
  const fixture = /** @type {any} */ (input)?.fixture;
  if (!input || typeof input !== 'object' || !fixture || typeof fixture !== 'object') {
    throw invalidCaseInput('the live-launch preflight needs the validated case input and the fixture handle.');
  }
  if (input.case !== 'rescue-interrupt') return { ok: true, reason: null };
  // (1) The declared survival control must exist on disk (the fixture-owned
  // script bytes the directive references).
  if (input.survivalControlSelector !== null && input.survivalControlSelector !== undefined) {
    const controlPath = fixture.survivalControlPath;
    if (typeof controlPath !== 'string' || controlPath.length === 0) {
      return { ok: false, reason: 'the declared survival-control selector has no fixture-owned control script (the control observer is known absent)' };
    }
    const stats = await lstat(controlPath).catch(() => null);
    if (stats === null || !stats.isFile()) {
      return { ok: false, reason: 'the declared survival-control script file is absent (the control observer is known absent)' };
    }
  }
  // (2) The durable settlement reader's partition basis must exist: the
  // reader observes the fixture-owned partition under the fixture data root.
  const dataRoot = fixture.env?.ZCODE_DATA_ROOT;
  const workspace = fixture.workspace;
  if (typeof dataRoot !== 'string' || dataRoot.length === 0 || typeof workspace !== 'string' || workspace.length === 0
    || await lstat(dataRoot).then((stats) => !stats.isDirectory(), () => true)) {
    return { ok: false, reason: 'the durable settlement reader has no observable partition basis (the fixture data roots are absent)' };
  }
  // (3) The registered stdout-capture requirement comes from the CLOSED
  // driver-level case map (the producer), and the fixture's ACTUAL prepared
  // seam must satisfy it: the fixture-generated handle present with its
  // preload file on disk.
  if (STDOUT_CAPTURE_REQUIRED_CASES.has(input.case)) {
    const capture = fixture.stdoutCapture;
    if (!capture || typeof capture !== 'object' || typeof capture.preloadPath !== 'string') {
      return { ok: false, reason: 'the registered stdout capture seam is not armed (the exact-output observer is known absent: the fixture was not prepared with the capture seam this case requires)' };
    }
    const preloadStats = await lstat(capture.preloadPath).catch(() => null);
    if (preloadStats === null || !preloadStats.isFile()) {
      return { ok: false, reason: 'the registered stdout capture preload is absent (the exact-output observer is known absent)' };
    }
  }
  return { ok: true, reason: null };
}

/**
 * The held-turn input. `readDurableSnapshot` (2026-10-21 evidence-closure
 * Task 2) runs the passive durable obligation reader at settlement-layer
 * construction time — started BEFORE the Child-settlement watch and always
 * finished before any cleanup — and its typed aggregate grounds the
 * `durableObligations` layer. A reader failure is a NAMED observer failure
 * on the held record, never a replaced business result; without a supplier
 * the layers keep the pre-Task-2 schema (durableObligations null, no durable
 * block). `sampleDurableSnapshots` (2026-10-23 interrupt-closure Task 3,
 * report §23.5) additionally runs the pre-cleanup passive sampling schedule
 * concurrently with the held turn through the SAME supplier — baseline at
 * identity establishment, the registered ≥1000-ms interval, the frozen
 * 600-attempt/32-summary ceilings, reads stopped (never credited past) at
 * the earliest termination boundary and abandoned by name at the shared
 * signal. Only the registered case(s) wire it
 * ({@link DURABLE_SAMPLING_ENABLED_CASES}); the injected options can only
 * SHRINK the bounds, never weaken them.
 * @typedef {{
 *   launch: (budgetContext?: { signal: AbortSignal, remainingMs: () => number, recordCleanupBoundary?: () => void }) => Promise<{ result: Promise<{ code: number | null, stdout: string, stderr: string }>, terminate?: () => Promise<void> }>,
 *   gatePath: string,
 *   gateReachedPath?: string,
 *   processPath?: string,
 *   processNonce?: string,
 *   holdMs: number,
 *   budgetMs: number,
 *   waitForGate: (signal: AbortSignal) => Promise<void>,
 *   waitForObservation?: (signal: AbortSignal) => Promise<void>,
 *   waitForPollStart?: (signal: AbortSignal) => Promise<void>,
 *   waitForChildSettlement?: (signal: AbortSignal) => Promise<{ observed: boolean, basis: string | null }>,
 *   waitForChildSettlementAfterJoin?: (signal: AbortSignal) => Promise<{ observed: boolean, basis: string | null }>,
 *   readDurableSnapshot?: () => Promise<Record<string, unknown>>,
 *   sampleDurableSnapshots?: boolean | { intervalMs?: number, maxAttempts?: number, maxSummaries?: number },
 *   statusDeadlineFlow?: boolean,
 *   captureProcessIdentity?: () => Promise<unknown>,
 *   readProcessIdentity?: (identity: unknown) => Promise<unknown>,
 *   terminateProcessIdentity?: (identity: unknown) => Promise<void>,
 *   waitForProcessExit?: (identity: unknown, phase: string) => Promise<void>,
 *   releaseGate?: (gatePath: string) => Promise<void>,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 * }} HeldTurnInput
 * @typedef {{
 *   clock: 'held-turn-monotonic-elapsed-ms',
 *   launchedAtElapsedMs: number | null,
 *   observationDetectedAtElapsedMs: number | null,
 *   pollStartedAtElapsedMs: number | null,
 *   holdDeadlineElapsedMs: number | null,
 *   rootAcknowledgementAtElapsedMs: number | null,
 *   childSettlementDetectedAtElapsedMs: number | null,
 *   endedAtElapsedMs: number | null,
 * }} HeldTurnTimeline
 * @typedef {{
 *   endedBeforeGate: boolean,
 *   rootAcknowledged?: boolean,
 *   statusDeadlineReached?: boolean,
 *   childSettlement?: { observed: boolean, basis: string | null, layers?: { remoteTerminal: boolean | null, localProcessReaping: 'natural-exit-observed' | 'cleanup-terminated' | null, durableObligations: 'settled' | 'unresolved' | null }, durableSnapshot?: Record<string, unknown>, durableSamples?: Record<string, unknown> } | null,
 *   budgetExpired: boolean,
 *   identity: unknown,
 *   processAliveWhileHeld: boolean | null,
 *   result: { code: number | null, stdout: string, stderr: string } | undefined,
 *   cleanup: {
 *     label: 'observation' | 'budget-cleanup' | 'early-exit' | 'status-query-deadline' | 'child-settlement-observed' | 'child-settlement-unobserved' | 'failure',
 *     releasedGate: boolean,
 *     verifiedProcessTerminated: boolean,
 *     codexTerminated: boolean,
 *     nativeInterruptionClaimed: false,
 *     errors: unknown[],
 *     cleanupBoundaryAtMs: number | null,
 *   },
 *   timeline: HeldTurnTimeline,
 *   failure?: unknown,
 * }} HeldTurnRecord
 */


/**
 * Per-case live configuration: the Root prompt shape, the exact expected
 * companion command, and any case-specific fake-ZCode controls. Task 4-6 run
 * these cases live; this task only wires them.
 *
 * Root-family entries (R2) additionally carry the command-specific
 * rendered-result contract: `resultMarkers` (every marker must appear in the
 * linked terminal output) and `resultCheckLabel` (the narrower-basis label
 * persisted with the verdict — the observer checks marker presence in the
 * rendered output, never full stdout equality).
 *
 * R3 placement facts: `rootJoinsChild` (true = the Host-foreground Root joins
 * the exact Child; false = the explicit `--background` Root acknowledges the
 * launched Child WITHOUT joining; absent = not a Rescue-Root fact) and
 * `backgroundFlow` (true ONLY on the explicit `--background` case: the Root
 * acknowledgement ends the Root turn early, so the held turn stays open for
 * the CHILD's own attached-Companion observation to terminal — the probe's
 * settlement watch — before any cleanup or disposal).
 * @typedef {{ family: 'rescue'|'root', prompt: string, companionCommand?: string, noise?: boolean, rootJoinsChild?: boolean, backgroundFlow?: boolean, resultMarkers?: string[], deadlineMarkers?: string[], resultCheckLabel?: string }} ShellWaitCaseSpec */
/** @type {Record<ShellWaitCaseLabel, ShellWaitCaseSpec>} */
export const SHELL_WAIT_CASE_SPECS = Object.freeze({
  'rescue-baseline': {
    family: 'rescue',
    rootJoinsChild: true,
    prompt: 'Use the installed $zcode:rescue --fresh --wait skill exactly once now for shell-wait-probe-fixture-task. '
      + 'Require ZCode to run exactly `npm test` as the safe deterministic fixture action, then return only its final public result.',
  },
  'rescue-long': {
    family: 'rescue',
    rootJoinsChild: true,
    prompt: 'Use the installed $zcode:rescue --fresh --wait skill exactly once now for shell-wait-probe-fixture-task. '
      + 'Require ZCode to run exactly `npm test` as the safe deterministic fixture action, then return only its final public result.',
  },
  'rescue-repeat': {
    family: 'rescue',
    rootJoinsChild: true,
    prompt: 'Use the installed $zcode:rescue --fresh --wait skill exactly once now for shell-wait-probe-fixture-task. '
      + 'Require ZCode to run exactly `npm test` as the safe deterministic fixture action, then return only its final public result.',
  },
  'rescue-noise': {
    family: 'rescue',
    noise: true,
    rootJoinsChild: true,
    prompt: 'Use the installed $zcode:rescue --fresh --wait skill exactly once now for shell-wait-probe-fixture-task. '
      + 'Require ZCode to run exactly `npm test` as the safe deterministic fixture action, then return only its final public result.',
  },
  'rescue-interrupt': {
    family: 'rescue',
    rootJoinsChild: true,
    // R4 wiring: the owning Root session delivers the native exact-Child
    // interrupt ITSELF through the model-facing V2 interrupt_agent tool (the
    // installed live surface; see the report's R4 investigation). The
    // directive is bounded to ONE delivery against the exact spawn
    // acknowledgement id, only while the observation is pending, with
    // collateral interruption explicitly forbidden.
    prompt: 'Use the installed $zcode:rescue --fresh --wait skill exactly once now for shell-wait-probe-fixture-task. '
      + 'Require ZCode to run exactly `npm test` as the safe deterministic fixture action, then return only its final public result. '
      + 'While the spawned agent is still running and its observation is pending (before any result), deliver exactly one '
      + 'interrupt_agent call to the exact agent id the spawn acknowledgement returned, then report the interrupt tool result. '
      + 'Do not interrupt any other agent, and do not spawn a replacement agent.',
  },
  'background': {
    family: 'rescue',
    rootJoinsChild: false,
    backgroundFlow: true,
    prompt: 'Use the installed $zcode:rescue --background --fresh skill exactly once now for shell-wait-probe-fixture-task. '
      + 'Do not wait for or join the Rescue child, and perform no wait_agent. Return only the exact acknowledgement that the Host child was launched, '
      + 'claiming nothing about Companion work being queued, accepted, started, or completed. The Rescue child itself must observe its foreground '
      + 'Companion process until terminal.',
  },
  'review-wait': {
    family: 'root',
    companionCommand: 'invoke review',
    prompt: 'Use the installed $zcode:review --wait skill exactly once now. Wait for the review to complete and return only its final public output.',
    // The production review contract renders the SCHEMA-VALIDATED structured
    // findings document (scripts/lib/review.mjs extractFinalResult →
    // JSON.stringify(structured, null, 2); render.mjs renderOutput prints
    // `${result}\n` for the `{ job, result }` invoke output) — never the raw
    // fake-peer text, so the Rescue sentinel is unsatisfiable here (the R5
    // rendered-marker miss was this instrument/dependency mismatch). The
    // marker below is the rendered empty-findings document line, derived from
    // the real production modules applied to the fake peer's structured
    // payload (pinned by the root-family observer-contract regression).
    resultMarkers: ['"findings": []'],
    resultCheckLabel: 'narrower check: the rendered review output presents the production review contract\'s result — the schema-validated structured findings document extracted by the companion review pipeline (the raw peer text is never the rendered review result) — and the linked terminal output carries that rendered document; full rendered-output equality is not claimed',
  },
  'adversarial-review-wait': {
    family: 'root',
    companionCommand: 'invoke adversarial-review',
    prompt: 'Use the installed $zcode:adversarial-review --wait skill exactly once now. Wait for the review to complete and return only its final public output.',
    // The SAME production contract as review (the adversarial-review command
    // shares the findings-schema extraction branch); the same correction and
    // its regression apply verbatim.
    resultMarkers: ['"findings": []'],
    resultCheckLabel: 'narrower check: the rendered adversarial-review output presents the production review contract\'s result — the schema-validated structured findings document extracted by the companion review pipeline (the raw peer text is never the rendered review result) — and the linked terminal output carries that rendered document; full rendered-output equality is not claimed',
  },
  'status-wait': {
    family: 'root',
    companionCommand: 'invoke status',
    // TURN 1 of the live flow (constant): the job is created INSIDE the live
    // host session through its own recorded production command — the
    // documented enqueue-only background creator whose acknowledgement carries
    // the reserved job ID (`Reserved background job <id>.`). A
    // fixture-reserved job could never work live: production selects explicit
    // Status targets OWNER-SCOPED, and the fixture-setup session is not the
    // live session. The query prompt is built at runtime ONLY from the
    // observed acknowledgement ID (`statusWaitInvocation`); this prompt
    // deliberately carries no job ID and no Status request.
    // P2-1 round-17 fix: the PRODUCTION argument parser tokenizes everything
    // AFTER the skill marker (parseRecordedInvocation), so every word of
    // explanatory prose must precede the invocation — the marker line ends
    // the prompt and carries ONLY the real arguments (here exactly
    // `--background`; review accepts no focus text).
    prompt: 'Use the installed skill exactly once now for shell-wait-probe-fixture-task. '
      + 'Do not wait for the review. Return only the exact acknowledgement that the background job was reserved, verbatim. '
      + 'The skill invocation is: $zcode:review --background',
    resultMarkers: ['Job: ', 'Command: ', 'Status: ', 'Progress:'],
    // P2-1 round-7 fix: the deadline-measurement trial's EXPECTED outcome is
    // the query deadline expiring while the job stays queued — the production
    // JOB_WAIT_TIMEOUT framing (scripts/lib/job-control.mjs waitTimeout →
    // PluginError, rendered through errorEnvelope as JSON). The observer
    // accepts EITHER the rendered success markers OR this confirmed framing;
    // anything else fails closed.
    deadlineMarkers: ['"code":"JOB_WAIT_TIMEOUT"', '"category":"timeout"', 'Timed out waiting for job '],
    resultCheckLabel: 'narrower check: the linked terminal output carries either the stable rendered job-status field lines (render.mjs renderJob) or the confirmed production JOB_WAIT_TIMEOUT deadline framing — the query deadline expiry is the expected observation outcome of the deadline-measurement trial; full rendered-output equality is not claimed',
  },
});

/**
 * Render the SECOND live turn's Status invocation from the OBSERVED launch
 * acknowledgement: the invocation embeds the extracted reserved job ID and an
 * EXPLICIT query timeout (the real command contract's `--timeout-ms`, which
 * requires `--wait`). Guessed, missing, or malformed targets are refused
 * fail-closed — the query is never rendered from a pre-known or guessed ID.
 * The query deadline is the Status command's own observation deadline only:
 * the prompt keeps the observation-only semantics (ending the wait never
 * cancels the job).
 * @param {{ jobId: string, queryTimeoutMs: number }} owned
 * @returns {{ prompt: string }}
 */
export function statusWaitInvocation(owned) {
  /** @param {string} message @returns {TypeError} */
  const invalid = (message) => new TypeError(`Invalid status-wait invocation input: ${message}`);
  if (!owned || typeof owned !== 'object') throw invalid('the reserved owned job is required.');
  if (typeof owned.jobId !== 'string' || !/^[a-f0-9]{64}$/u.test(owned.jobId)) {
    throw invalid('the owned job ID must be the reserved 64-hex production identifier (a guessed or missing target is refused).');
  }
  if (!Number.isSafeInteger(owned.queryTimeoutMs) || owned.queryTimeoutMs <= 0) {
    throw invalid('the explicit query timeout must be a positive integer number of milliseconds.');
  }
  return {
    // P2-1 round-17 fix: the PRODUCTION argument parser tokenizes everything
    // AFTER the skill marker — prose naming `--timeout-ms` after the
    // invocation produced `ARGUMENT_INVALID: Duplicate flag: --timeout-ms`.
    // Every word of explanation precedes the invocation; the marker line ends
    // the prompt and carries ONLY the real arguments.
    prompt: `The --timeout-ms value in this invocation is the Status query deadline only: if it expires, `
      + `present the timeout output verbatim and end the wait without cancelling, stopping, or re-preparing the job. `
      + `Use the installed skill exactly once now and return only its final public output for the explicitly owned job `
      + `identified in this invocation: $zcode:status ${owned.jobId} --wait --timeout-ms ${owned.queryTimeoutMs}`,
  };
}

/**
 * The Root prompt shape for one case. The status-wait prompt is the constant
 * TURN-1 launch instruction (the in-session background creator); the Status
 * query prompt is built at runtime ONLY from the observed acknowledgement via
 * {@link statusWaitInvocation}.
 * @param {ShellWaitCaseLabel} label
 */
export function shellWaitCasePrompt(label) {
  const spec = SHELL_WAIT_CASE_SPECS[label];
  if (!spec) throw new Error(`unknown shell wait case: ${label}`);
  return spec.prompt;
}

/** The production acknowledgement render shapes that carry a reserved job ID (render.mjs renderOutput). */
const LAUNCH_ACKNOWLEDGEMENT_PATTERNS = Object.freeze([
  /^Reserved background job ([a-f0-9]{64})\./mu,
  /^Rescue job ([a-f0-9]{64}) queued for background execution\./mu,
]);
/** renderJob's stable first field line (the queried-job fact in Status terminal output). */
const QUERIED_JOB_PATTERN = /^Job: ([a-f0-9]{64})$/mu;
/** The confirmed production query-deadline framing (job-control.mjs waitTimeout → errorEnvelope): the timeout message names the awaited job. */
const STATUS_QUERY_DEADLINE_JOB_PATTERN = /Timed out waiting for job ([a-f0-9]{64})\./u;

/**
 * Collect the OBSERVED command stdout texts of one rollout's completed tool
 * outputs. Assistant message text is never read (R0: it may echo the private
 * prompt and is suppressed everywhere); only tool outputs are evidence.
 * @param {any[]} events @returns {string[]}
 */
function collectObservedOutputTexts(events) {
  const texts = [];
  for (const event of /** @type {any[]} */ (events)) {
    const payload = event?.payload;
    if (payload?.type !== 'function_call_output' && payload?.type !== 'custom_tool_call_output') continue;
    const output = parseToolOutput(payload.output);
    if (output?.state !== 'completed') continue;
    if (typeof output.result?.output === 'string' && output.result.output.length > 0) texts.push(output.result.output);
  }
  return texts;
}

/**
 * Verify the CONFIRMED production JOB_WAIT_TIMEOUT deadline framing against a
 * host result (P2-1 round-12): the live executor launches `codex exec --json`,
 * so the Companion output arrives inside JSON string fields with ESCAPED
 * quotes — a raw-stdout marker search can never match it. Every JSONL line of
 * the host stdout is decoded and the observed tool-output bodies
 * (function_call/custom_tool_call output, via the R0 parseToolOutput
 * machinery's own item shapes) are collected; the framing is verified against
 * THOSE decoded texts. A bare (non---json) Companion stdout still verifies
 * through the same marker check applied to the raw body, preserving the
 * non-json path.
 * @param {{ code: number | null, stdout: string, stderr: string }} result
 * @param {readonly string[]} deadlineMarkers
 * @returns {boolean}
 */
export function extractDeadlineEvidenceFromHostOutput(result, deadlineMarkers = SHELL_WAIT_CASE_SPECS['status-wait'].deadlineMarkers ?? []) {
  if (result?.code !== 0 || typeof result.stdout !== 'string' || result.stdout.length === 0) return false;
  /** @param {unknown} text */
  const markersMatch = (text) => typeof text === 'string' && deadlineMarkers.every((marker) => text.includes(marker));
  let hostTransportObserved = false;
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    let decoded;
    try { decoded = JSON.parse(trimmed); } catch { continue; }
    if (typeof decoded?.type !== 'string') continue;
    hostTransportObserved = true;
    // P2-1 round-13 fix: decode the REAL `codex exec --json` item schema —
    // item.completed envelopes carry a ThreadItem whose command results are
    // `command_execution` items with the command's output in
    // `aggregated_output` (67727e7c, exec_events.rs CommandExecutionItem,
    // snake_case). The Companion error envelope travels inside that
    // aggregated output. Persisted-rollout output shapes (function_call /
    // custom_tool_call output payloads) remain supported beside it.
    const decodedItems = [];
    if (decoded.type === 'item.completed' || decoded.type === 'item.started') {
      const item = decoded.item ?? {};
      if (item?.type === 'command_execution') {
        decodedItems.push({ kind: 'command-execution', text: typeof item.aggregated_output === 'string' ? item.aggregated_output : '' });
      }
      if (item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output') {
        const output = parseToolOutput(item.output);
        if (output?.state === 'completed') {
          decodedItems.push({ kind: 'tool-output', text: typeof output.result.output === 'string' ? output.result.output : JSON.stringify(output.result) });
        }
      }
    } else {
      const payload = decoded?.payload ?? decoded;
      if (payload?.type === 'function_call_output' || payload?.type === 'custom_tool_call_output') {
        const output = parseToolOutput(payload.output);
        if (output?.state === 'completed') {
          decodedItems.push({ kind: 'tool-output', text: typeof output.result.output === 'string' ? output.result.output : JSON.stringify(output.result) });
        }
      }
    }
    for (const decodedItem of decodedItems) {
      if (markersMatch(decodedItem.text)) return true;
    }
  }
  return !hostTransportObserved && markersMatch(result.stdout);
}

/** @param {any[]} events @returns {string | null} the rollout's session metadata id, or null */
function extractRolloutSessionId(events) {
  for (const event of /** @type {any[]} */ (events)) {
    const id = event?.type === 'session_meta' ? event.payload?.id : undefined;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}

/**
 * Extract the launch acknowledgement's reserved job ID from the observed
 * rollout tool outputs as a validated fact. A single distinct ID resolves;
 * multiple distinct IDs are AMBIGUOUS (never resolved by picking one); the
 * acknowledged ID inside assistant message text is never evidence. The
 * acknowledgement-bearing rollout's session metadata id is the LAUNCH session.
 * @param {unknown} rollouts
 * @returns {{ jobId: string | null, distinctJobIdCount: number, launchSessionId: string | null }}
 */
export function extractStatusLaunchAcknowledgement(rollouts) {
  /** @type {Set<string>} */
  const distinct = new Set();
  let launchSessionId = null;
  for (const events of Array.isArray(rollouts) ? rollouts : []) {
    if (!Array.isArray(events)) continue;
    let rolloutMatched = false;
    for (const text of collectObservedOutputTexts(events)) {
      for (const pattern of LAUNCH_ACKNOWLEDGEMENT_PATTERNS) {
        const match = pattern.exec(text);
        if (match) { distinct.add(match[1]); rolloutMatched = true; }
      }
    }
    if (rolloutMatched && launchSessionId === null) launchSessionId = extractRolloutSessionId(events);
  }
  return {
    jobId: distinct.size === 1 ? /** @type {string} */ (distinct.values().next().value) : null,
    distinctJobIdCount: distinct.size,
    launchSessionId,
  };
}

/**
 * Extract the queried job ID from the observed Status terminal output
 * (renderJob's `Job: <id>` field line) as a validated fact. A single distinct
 * ID resolves; multiple distinct IDs are ambiguous. The query rollout's
 * session metadata id is the QUERY session.
 * @param {unknown} rollouts
 * @returns {{ jobId: string | null, distinctJobIdCount: number, querySessionId: string | null }}
 */
export function extractStatusQueryJobId(rollouts) {
  /** @type {Set<string>} */
  const distinct = new Set();
  let querySessionId = null;
  for (const events of Array.isArray(rollouts) ? rollouts : []) {
    if (!Array.isArray(events)) continue;
    let rolloutMatched = false;
    for (const text of collectObservedOutputTexts(events)) {
      const match = QUERIED_JOB_PATTERN.exec(text);
      if (match) { distinct.add(match[1]); rolloutMatched = true; continue; }
      // P2-1 round-7: the deadline trial's expected outcome is the CONFIRMED
      // production query-deadline framing, whose message names the awaited
      // job — the queried-job fact reads from it identically (same 64-hex
      // shape, same single-distinct rule).
      const deadlineMatch = STATUS_QUERY_DEADLINE_JOB_PATTERN.exec(text);
      if (deadlineMatch) { distinct.add(deadlineMatch[1]); rolloutMatched = true; }
    }
    if (rolloutMatched && querySessionId === null) querySessionId = extractRolloutSessionId(events);
  }
  return {
    jobId: distinct.size === 1 ? /** @type {string} */ (distinct.values().next().value) : null,
    distinctJobIdCount: distinct.size,
    querySessionId,
  };
}

/**
 * Bind the observed Status query to the observed in-session launch: the query
 * must run in the SAME session that created the job (ownership is then
 * inherently correct), the queried job must EXACTLY match the launch
 * acknowledgement's ID, and the explicit query timeout must be present. Every
 * unmet condition is a fail-closed rejection with its specific reason — never
 * resolved by picking a value.
 * @param {{ launchSessionId: string | null, querySessionId: string | null, acknowledgementJobId: string | null, acknowledgementDistinctJobIdCount: number, queriedJobId: string | null, queriedDistinctJobIdCount: number, queryTimeoutMs: number | undefined }} observed
 * @returns {{ valid: boolean, reason: string | null }}
 */
export function validateStatusWaitFlow(observed) {
  if (typeof observed.acknowledgementJobId !== 'string' || observed.acknowledgementJobId.length === 0) {
    return { valid: false, reason: 'no launch acknowledgement with a reserved job ID was observed in the live session rollout' };
  }
  if (observed.acknowledgementDistinctJobIdCount !== 1) {
    return { valid: false, reason: 'the launch acknowledgement is ambiguous (multiple distinct reserved job IDs were observed)' };
  }
  if (typeof observed.queriedJobId !== 'string' || observed.queriedJobId.length === 0) {
    return { valid: false, reason: 'no queried job ID was observed in the Status terminal output' };
  }
  if (observed.queriedDistinctJobIdCount !== 1) {
    return { valid: false, reason: 'the queried job is ambiguous (multiple distinct job IDs were observed in the Status output)' };
  }
  if (typeof observed.launchSessionId !== 'string' || observed.launchSessionId.length === 0) {
    return { valid: false, reason: 'the launch session id is unavailable in the acknowledgement-bearing rollout' };
  }
  if (typeof observed.querySessionId !== 'string' || observed.querySessionId.length === 0) {
    return { valid: false, reason: 'the query session id is unavailable in the Status-bearing rollout' };
  }
  if (observed.launchSessionId !== observed.querySessionId) {
    return { valid: false, reason: 'the Status query ran in a different session than the job launch: ownership is unproven (production selects explicit Status targets owner-scoped)' };
  }
  if (observed.acknowledgementJobId !== observed.queriedJobId) {
    return { valid: false, reason: 'the queried job is a different job than the launched acknowledgement (exact ID match required)' };
  }
  if (!Number.isSafeInteger(observed.queryTimeoutMs) || /** @type {number} */ (observed.queryTimeoutMs) <= 0) {
    return { valid: false, reason: 'the explicit Status query timeout is missing or invalid' };
  }
  return { valid: true, reason: null };
}

/**
 * The SECOND live turn's prompt arguments: the observed installed host exec
 * resumed INTO the launch session (`codex exec resume <SESSION_ID>
 * <PROMPT>`, exec CLI subcommand — source-pinned), carrying the validated
 * Status invocation as the recorded prompt. These are ONLY the subcommand
 * tokens — the common exec argv is supplied ONCE by the turn launcher
 * ({@link composeHostLaunchArguments}); duplicating it here would produce
 * `codex exec … exec … resume …`, the second literal `exec` would consume the
 * PROMPT positional, and the resume subcommand could never parse. R5 pins the
 * exact installed surface; this helper only assembles and validates the argv
 * shape.
 * @param {string} launchSessionId
 * @param {string} queryPrompt
 * @returns {{ args: string[] }}
 */
export function renderExecResumeLaunch(launchSessionId, queryPrompt) {
  if (typeof launchSessionId !== 'string' || launchSessionId.length === 0 || Buffer.byteLength(launchSessionId) > 512) {
    throw invalidCaseInput('the observed launch session id is missing or invalid.');
  }
  if (typeof queryPrompt !== 'string' || queryPrompt.length === 0) {
    throw invalidCaseInput('the Status query invocation prompt is missing.');
  }
  return { args: ['resume', launchSessionId, queryPrompt] };
}

/**
 * The full host launch argv for one held turn: the common exec arguments, the
 * OPTIONAL requested model as its own `-m <id>` argv items (only when an
 * explicit selection was made; absent → byte-for-byte legacy argv), the
 * OPTIONAL Task 4 config-default host override as its own `-c
 * features.code_mode.default_exec_yield_time_ms=<n>` argv items (only when the
 * validated pair is active; the value is the validated integer only — never an
 * arbitrary config bag), the workspace, then the turn's own prompt arguments —
 * a plain prompt for every case except status-wait turn 2, whose prompt
 * arguments are the `resume <SESSION_ID> <PROMPT>` subcommand tokens from
 * {@link renderExecResumeLaunch} (which deliberately carries no common argv
 * of its own, so the subcommand parses exactly once).
 * @param {unknown} promptArguments
 * @param {unknown} workspace
 * @param {string | null} [model] the validated requested model identifier (null → no `-m`)
 * @param {number | null} [execDefaultMs] the validated config-default exec
 *   override in milliseconds (null → no `-c` override)
 * @returns {string[]}
 */
export function composeHostLaunchArguments(promptArguments, workspace, model = null, execDefaultMs = null) {
  if (!Array.isArray(promptArguments) || promptArguments.length === 0 || promptArguments.some((value) => typeof value !== 'string')) {
    throw invalidCaseInput('the turn prompt arguments must be a non-empty array of strings.');
  }
  if (typeof workspace !== 'string' || workspace.length === 0) {
    throw invalidCaseInput('the workspace must be a non-empty string.');
  }
  if (model !== null) assertModelIdentifier(model);
  if (execDefaultMs !== null
    && (!Number.isSafeInteger(execDefaultMs) || execDefaultMs <= 0 || execDefaultMs > 3_600_000)) {
    throw invalidCaseInput('the exec default override must be a positive integer number of milliseconds no greater than 3600000.');
  }
  return [
    ...CODEX_EXEC_COMMON_ARGUMENTS,
    ...(model !== null ? ['-m', model] : []),
    ...(execDefaultMs !== null ? ['-c', `features.code_mode.default_exec_yield_time_ms=${String(execDefaultMs)}`] : []),
    '-C', workspace, ...promptArguments,
  ];
}

/**
 * Build the evidence request the live executor adjudicates: the observer
 * contract is SELECTED BY THE CASE FAMILY here. Root-family cases run the
 * Root-mode adjudication (`mode: 'root'`) against the command-specific
 * rendered-result markers; Rescue cases keep the pre-R2 Rescue contract with
 * the byte-exact public sentinel. Exported as the testable seam between the
 * case specs and `inspectShellWaitEvidence`.
 * `observedTerminalStdout` (2026-10-21 evidence-closure Task 2) is the
 * VALIDATED stdout-only capture admitted through the frozen §19.3 read side —
 * the one stream-attributed source the exact-linkage oracle accepts. It is
 * validated here exactly like the evidence boundary (bounded string or null)
 * and threaded only when supplied, so legacy requests stay byte-identical.
 * @param {{ case: ShellWaitCaseLabel, command: string, rollouts: unknown, zcodeCalls: unknown, workerDurationMs: number, pollMs: number, workerStillAliveAfterObservation: boolean | null, queryTurn?: { sessionId: string, setupEventCount: number } | null, exactExpectedTerminal?: { output: string, exitCode: number } | null, observedTerminalStdout?: string | null }} request
 * @returns {import('./evidence.mjs').ShellWaitEvidenceInput}
 */
export function shellWaitEvidenceRequest(request) {
  const spec = SHELL_WAIT_CASE_SPECS[request.case];
  if (!spec) throw invalidCaseInput(`unknown shell wait case: ${String(request.case)}`);
  // Codex review round 8: the byte-exact terminal expectation is DERIVED
  // OFFLINE from the deterministic production renderer plus the case's
  // DECLARED harmless output profile. Task-5 instrument correction
  // (2026-10-22, RESCUE_EXPECTATION_DERIVATION_VERSION 2, report §21.2.1):
  // the expectation is derived per the INVOKED path's production contract —
  // every rescue-family case delivers through the `invoke-prepared rescue`
  // FOREGROUND chain, which returns the RAW durable job (review.mjs:421 →
  // the store.finishJob winner, review.mjs:743-761) and NEVER applies
  // `terminalResultJob` (the only job-view `resumable` producer, applied
  // solely by the `result` management command), so the complete foreground
  // contract output is the result line plus its LF. The v1 derivation (the
  // terminal-MANAGEMENT view from the declared resumability fact —
  // `exactRescueRenderedExpectation`, retained UNCHANGED for genuine
  // management/status results) was the demonstrated input defect behind the
  // O1/O2 comparator mismatches. The derivation inputs are case constants
  // computed once here, so the default live executor threads the expectation
  // through THIS validated seam and every real policy run carries the
  // exact-byte check in its evidence facts; no free-text expected-output flag
  // exists. Root-family cases keep their own declared result-marker layer and
  // derive no rescue expectation (explicitly absent, never silently skipped).
  // A supplied expectation is validated at THIS boundary exactly like the
  // evidence boundary.
  const exactExpectedTerminal = request.exactExpectedTerminal !== undefined && request.exactExpectedTerminal !== null
    ? request.exactExpectedTerminal
    : spec.family === 'rescue'
      ? exactRescueForegroundRenderedExpectation({ result: PUBLIC_RESULT_SENTINEL })
      : null;
  if (exactExpectedTerminal !== null
    && (!exactExpectedTerminal || typeof exactExpectedTerminal !== 'object'
      || typeof exactExpectedTerminal.output !== 'string' || exactExpectedTerminal.output.length === 0
      || !Number.isSafeInteger(exactExpectedTerminal.exitCode) || exactExpectedTerminal.exitCode < 0)) {
    throw invalidCaseInput('the exactExpectedTerminal expectation must carry a nonempty output string and a nonnegative integer exit code.');
  }
  if (request.observedTerminalStdout !== undefined && request.observedTerminalStdout !== null
    && (typeof request.observedTerminalStdout !== 'string' || request.observedTerminalStdout.length > 65536)) {
    throw invalidCaseInput('the observed terminal stdout must be a bounded string (the validated stdout capture) or null.');
  }
  return {
    rollouts: request.rollouts,
    zcodeCalls: request.zcodeCalls,
    command: request.command,
    ...(request.observedTerminalStdout !== undefined ? { observedTerminalStdout: request.observedTerminalStdout } : {}),
    ...(spec.family === 'root'
      ? {
        mode: /** @type {const} */ ('root'),
        publicResultMarkers: spec.resultMarkers ?? null,
        // The Status deadline framing (P2-1 round-7): the ALTERNATIVE
        // accepted result set — the confirmed production JOB_WAIT_TIMEOUT
        // framing — for the deadline-measurement trial.
        ...(spec.family === 'root' && request.case === 'status-wait' && Array.isArray(spec.deadlineMarkers) && spec.deadlineMarkers.length > 0
          ? { publicResultAlternativeMarkers: spec.deadlineMarkers }
          : {}),
        // The Status query-turn boundary (P2-2 round-4 fix): carried ONLY for
        // the two-turn Status flow — a boundary is a Status-flow concept, and
        // single-turn root cases never have a setup turn.
        ...(spec.family === 'root' && request.case === 'status-wait' && request.queryTurn !== undefined && request.queryTurn !== null
          ? { rootQueryTurn: request.queryTurn }
          : {}),
      }
      : { publicResult: PUBLIC_RESULT_SENTINEL }),
    requestedPollMs: request.pollMs,
    workerDurationMs: request.workerDurationMs,
    workerStillAliveAfterObservation: request.workerStillAliveAfterObservation,
    // The byte-exact terminal/exit expectation (release-qualification Task 2;
    // round-8 live wiring): the DERIVED case-constant expectation rides every
    // rescue-family request, so the default live executor persists the
    // exact-byte verdict without any manual injection; absent (root family)
    // → the evidence facts stay byte-identical.
    ...(exactExpectedTerminal !== null ? { exactExpectedTerminal } : {}),
  };
}

/**
 * Derive the Status query-turn boundary from the OBSERVED rollouts (P2-2
 * round-4 fix): the two-turn Status flow resumes the SAME session, so the
 * resumed rollout retains the turn-1 setup observations. The boundary is the
 * launch session's rollout event count at the post-turn-1 load — the setup
 * prefix is append-stable, so slicing the collected rollout at that count
 * yields the measured query turn. `null` when the launch session's rollout
 * cannot be identified: the caller then runs the fail-closed whole-rollout
 * analysis instead of guessing a boundary.
 * @param {unknown} launchRollouts the rollouts as loaded AFTER the setup turn
 * @param {string | null} launchSessionId the observed launch session id
 * @returns {{ sessionId: string, setupEventCount: number } | null}
 */
export function findStatusSetupTurnBoundary(launchRollouts, launchSessionId) {
  if (typeof launchSessionId !== 'string' || launchSessionId.length === 0 || launchSessionId.length > 128) return null;
  if (!Array.isArray(launchRollouts)) return null;
  for (const events of launchRollouts) {
    if (!Array.isArray(events)) continue;
    if (events.some((event) => event?.type === 'session_meta' && event?.payload?.id === launchSessionId)) {
      return { sessionId: launchSessionId, setupEventCount: events.length };
    }
  }
  return null;
}

/** The common exec arguments every held-turn host launch composes exactly once (exported for the composition-level argv test). */
export const CODEX_EXEC_COMMON_ARGUMENTS = Object.freeze([
  'exec', '--json', '--skip-git-repo-check',
  '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust',
  '--enable', 'hooks', '-c', 'shell_environment_policy.inherit=all',
]);

/**
 * Bounded rollout loader for the isolated home: bounded depth, file count, and
 * file size, parsed with the shared bounded JSONL parser.
 * @param {string} codexHome
 */
export async function loadShellWaitRollouts(codexHome) {
  const sessionsRoot = join(codexHome, 'sessions');
  const pending = [{ path: sessionsRoot, depth: 0 }];
  const files = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    let entries;
    try { entries = await readdir(current.path, { withFileTypes: true }); }
    catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const path = join(current.path, entry.name);
      if (entry.isDirectory() && current.depth < 6) pending.push({ path, depth: current.depth + 1 });
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
      if (files.length > 64 || pending.length > 256) throw new Error('the shell wait rollout discovery exceeded its bound.');
    }
  }
  if (files.length === 0) return [];
  return Promise.all(files.map(async (path) => {
    const metadata = await stat(path);
    if (metadata.size > 16 * 1024 * 1024) throw new Error('a Codex rollout exceeds the shell wait observer bound.');
    return parseCodexRolloutJsonl(await readFile(path, 'utf8'));
  }));
}

/** @param {string} recordPath */
async function readFakeZCodeCalls(recordPath) {
  const contents = await readFile(recordPath, 'utf8').catch(() => '');
  return contents.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

/**
 * Wait until the fake-ZCode completion boundary is observably held, or the
 * budget signal aborts.
 * @param {string} gateReachedPath @param {AbortSignal} signal
 */
async function waitForCompletionGateReached(gateReachedPath, signal) {
  for (;;) {
    if (signal.aborted) throw new Error('the held shell wait gate wait was aborted');
    const value = await readFile(gateReachedPath, 'utf8').catch(() => '');
    if (value === 'blocked') return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Close the held host's stdin before the host reads it. The installed
 * `codex exec` (0.160.1, observed live 2026-10-06) resolves the root prompt by
 * reading stdin to EOF — it prints "Reading additional input from stdin..."
 * and blocks forever in `codex_exec::resolve_root_prompt` while stdin is the
 * shared runner's never-ending pipe (`stdio: ['pipe','pipe','pipe']`), so the
 * held host must be spawned with stdin already at end-of-file. The `/bin/sh`
 * wrapper `exec`s the host, replacing the shell process, so the spawned PID,
 * termination, abort, and output capture stay on the exact host process.
 * POSIX-only by construction: the instrument's process identity and cleanup
 * discipline is POSIX-scoped.
 * @param {{ command: string, args: string[] }} launch
 * @returns {{ command: string, args: string[] }}
 */
export function closeStdinLaunch(launch) {
  return { command: '/bin/sh', args: ['-c', 'exec "$0" "$@" </dev/null', launch.command, ...launch.args] };
}

/**
 * Render the constant Companion command for root-family cases (review,
 * adversarial-review, status). The installed companion script is not the
 * Rescue launcher, so the production renderer's launcher-leaf check does not
 * apply; every other safety property is validated the same way here —
 * absolute path with the exact companion leaf, no shell-active or control
 * characters, bounded bytes, and exact `node "…"` quoting. The path is
 * rejected instead of escaped so the rendered command never depends on
 * quoting rules.
 * @param {string} companionPath
 * @returns {string}
 */
export function renderCompanionCommand(companionPath) {
  const unsafePathError = () => new Error('the Companion script path cannot be rendered safely.');
  if (typeof companionPath !== 'string' || companionPath.length === 0) throw unsafePathError();
  const hasControlCharacter = [...companionPath].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
  const unsafe = /[\\"`$]/u.test(companionPath) || hasControlCharacter;
  if (!companionPath.startsWith('/')
    || !companionPath.endsWith('/scripts/zcode-companion.mjs')
    || Buffer.byteLength(companionPath) > 2048
    || unsafe) throw unsafePathError();
  return `node "${companionPath}"`;
}

/**
 * Wait until the exact launcher command appears in a collected rollout.
 * Transient read/parse failures of an actively appended rollout are retried a
 * bounded number of consecutive times instead of aborting the held turn; the
 * post-run load keeps its distinguished error.
 * @param {string} codexHome @param {string} command @param {AbortSignal} signal
 * @param {{ loadRollouts?: (codexHome: string) => Promise<any[][]>, sleep?: (ms: number) => Promise<void>, maxConsecutiveFailures?: number }} [dependencies]
 * @returns {Promise<void>}
 */
export async function waitForLauncherObservation(codexHome, command, signal, dependencies = {}) {
  const loadRollouts = dependencies.loadRollouts ?? loadShellWaitRollouts;
  const sleep = dependencies.sleep ?? ((/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxConsecutiveFailures = dependencies.maxConsecutiveFailures ?? 3;
  let consecutiveFailures = 0;
  for (;;) {
    if (signal.aborted) throw new Error('the held shell wait observation wait was aborted');
    let observed = false;
    try {
      const rollouts = await loadRollouts(codexHome);
      consecutiveFailures = 0;
      observed = rollouts.some((events) => events.some((/** @type {any} */ event) => {
        const statements = parseCallStatements(event);
        return statements?.some((call) => call.kind === 'exec_command' && call.value.cmd === command) ?? false;
      }));
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= maxConsecutiveFailures) throw error;
    }
    if (observed) return;
    await sleep(1);
  }
}

/**
 * Wait until the first EMPTY-input terminal observation (a `write_stdin`
 * statement carrying empty `chars`) appears IN THE SELECTED ROLLOUT and ON
 * THE EXACT LAUNCH'S ORIGINAL HANDLE (P2-4 round-3 fix): the selected rollout
 * is the one exposing the exact launcher/companion command, the handle is the
 * session id that launch's own output returned, and only an empty-input
 * `write_stdin` to THAT handle is the measured poll start. A preflight or
 * diagnostic empty poll in another rollout, before the launch, or to a
 * foreign handle never triggers this gate. The validated preparation write is
 * never empty, so it cannot trigger this gate either; the observer's sequence
 * analysis still adjudicates handle discipline afterwards.
 * P2-1 round-14 fix: a later statement of a shared cell is only detected once
 * the cell's own response evidences the preceding awaited statements'
 * COMPLETED results — the cell submission dates the whole cell, never the
 * later statement, so a preparation-plus-poll cell cannot record the poll
 * start while the preparation still runs. Transient read/parse failures of an
 * actively appended rollout are retried until the budget signal cancels the
 * watch — a failing watch leaves the poll start unknown (null) instead of
 * disturbing the held turn.
 * @param {string} codexHome @param {string} command @param {AbortSignal} signal
 * @param {{ loadRollouts?: (codexHome: string) => Promise<any[][]>, sleep?: (ms: number) => Promise<void> }} [dependencies]
 * @returns {Promise<void>}
 */
export async function waitForPollObservation(codexHome, command, signal, dependencies = {}) {
  const loadRollouts = dependencies.loadRollouts ?? loadShellWaitRollouts;
  const sleep = dependencies.sleep ?? ((/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    if (signal.aborted) throw new Error('the held shell wait poll-start wait was aborted');
    let observed = false;
    try {
      const rollouts = await loadRollouts(codexHome);
      observed = rollouts.some((events) => {
        // P2-1 round-29 fix: GROUND first, then scan — the exact launch's own
        // result is decoded through its STATEMENT position (a supported
        // launch+poll cell's statements share one response, and the
        // whole-body decode selects the LAST JSON, so the launch handshake
        // and the poll's completion were misattributed and both watches
        // waited until cancellation while the observer qualified the
        // rollout). With the handle grounded, the second pass applies the
        // unchanged poll-start rules per statement.
        let launchCallId = null;
        let launchPosition = null;
        /** @type {Map<string, unknown>} */
        const responseOutputs = new Map();
        for (const event of /** @type {any[]} */ (events)) {
          const payload = event?.payload;
          const statements = parseCallStatements(event);
          if (statements) {
            for (const [statementIndex, call] of statements.entries()) {
              if (call.kind === 'exec_command' && call.value?.cmd === command && launchCallId === null) {
                launchCallId = payload.call_id;
                launchPosition = { statementIndex, statementCount: statements.length };
              }
            }
          }
          if (payload?.type === 'function_call_output' || payload?.type === 'custom_tool_call_output') {
            responseOutputs.set(payload.call_id, payload.output);
          }
        }
        if (launchCallId === null || launchPosition === null) return false;
        const launchResponseOutput = responseOutputs.get(launchCallId);
        const launchOwn = launchPosition.statementCount > 1
          ? statementOutputAt(launchResponseOutput, launchPosition.statementIndex, launchPosition.statementCount)
          : parseToolOutput(launchResponseOutput);
        if (!(launchOwn?.state === 'completed' && Number.isSafeInteger(launchOwn.result?.session_id) && /** @type {any} */ (launchOwn.result).session_id > 0)) return false;
        const originalHandleId = /** @type {any} */ (launchOwn.result).session_id;
        let observed = false;
        /** Shared cells whose later empty-input poll statement awaits its
         * completion evidence: call id -> { pollIndex, statementCount }. */
        /** @type {Map<string, { pollIndex: number, statementCount: number }>} */
        const awaitingCells = new Map();
        for (const event of /** @type {any[]} */ (events)) {
          const payload = event?.payload;
          const statements = parseCallStatements(event);
          if (statements) {
            for (const [statementIndex, call] of statements.entries()) {
              if (call.kind === 'write_stdin' && call.value?.session_id === originalHandleId && call.value?.chars === '') {
                if (statementIndex === 0) { observed = true; }
                // P2-1 round-14 fix: a later statement of a shared cell has
                // not started until the preceding awaited statements finish —
                // wait for the cell's own response to evidence their
                // completed results before recording the poll start.
                else awaitingCells.set(payload.call_id, { pollIndex: statementIndex, statementCount: statements.length });
              }
            }
          }
          if (!observed && (payload?.type === 'function_call_output' || payload?.type === 'custom_tool_call_output')) {
            const awaiting = awaitingCells.get(payload.call_id);
            if (awaiting !== undefined && precedingStatementsCompleted(payload.output, awaiting.pollIndex, awaiting.statementCount)) observed = true;
          }
        }
        return observed;
      });
    } catch { /* transient reads are retried; the post-run load keeps its own error */ }
    if (observed) return;
    await sleep(1);
  }
}

/**
 * Wait until the CHILD-side settlement facts appear in a collected rollout,
 * BOUND TO THE EXACT LAUNCH'S ORIGINAL HANDLE (P2-3 round-3 fix): the launch
 * of the exact Rescue child companion command grounds the original handle
 * through its own output's session id, and ONLY a completed exit-code output
 * belonging to that handle's OWN polls or their linked continuations settles
 * the watch. The launch output itself is the handshake, never the settlement;
 * an unrelated later command's exit-code output or a foreign-handle poll
 * never counts. This is the settlement WATCH's structural basis (labelled as
 * such in the returned facts); the strict observation adjudication stays
 * with the post-run observer. The budget signal cancels the watch — an
 * unobserved settlement stays unobserved, never fabricated.
 * @param {string} codexHome @param {string} command @param {AbortSignal} signal
 * @param {{ loadRollouts?: (codexHome: string) => Promise<any[][]>, sleep?: (ms: number) => Promise<void> }} [dependencies]
 * @returns {Promise<{ observed: boolean, basis: string | null }>}
 */
export async function waitForChildSettlementObservation(codexHome, command, signal, dependencies = {}) {
  const loadRollouts = dependencies.loadRollouts ?? loadShellWaitRollouts;
  const sleep = dependencies.sleep ?? ((/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const SETTLEMENT_BASIS = 'exact-launch-handle-linked-completed-exit-code-output';
  for (;;) {
    if (signal.aborted) throw new Error('the held shell wait child-settlement watch was aborted');
    let settled = false;
    try {
      const rollouts = await loadRollouts(codexHome);
      settled = rollouts.some((events) => {
        // P2-1 round-29 fix: GROUND first, then scan — the exact launch's own
        // result is decoded through its STATEMENT position, so a supported
        // launch+poll cell (both statements share one response) grounds the
        // handle AND its poll's own completed result settles the watch —
        // agreeing with what the observer adjudicates instead of waiting
        // until cancellation.
        let launchCallId = null;
        let launchPosition = null;
        /** @type {Map<string, unknown>} */
        const responseOutputs = new Map();
        for (const event of /** @type {any[]} */ (events)) {
          const payload = event?.payload;
          const statements = parseCallStatements(event);
          if (statements) {
            for (const [statementIndex, call] of statements.entries()) {
              if (call.kind === 'exec_command' && call.value?.cmd === command && launchCallId === null) {
                launchCallId = payload.call_id;
                launchPosition = { statementIndex, statementCount: statements.length };
              }
            }
          }
          if (payload?.type === 'function_call_output' || payload?.type === 'custom_tool_call_output') {
            responseOutputs.set(payload.call_id, payload.output);
          }
        }
        if (launchCallId === null || launchPosition === null) return false;
        const launchResponseOutput = responseOutputs.get(launchCallId);
        const launchOwn = launchPosition.statementCount > 1
          ? statementOutputAt(launchResponseOutput, launchPosition.statementIndex, launchPosition.statementCount)
          : parseToolOutput(launchResponseOutput);
        if (!(launchOwn?.state === 'completed' && Number.isSafeInteger(launchOwn.result?.session_id) && /** @type {any} */ (launchOwn.result).session_id > 0)) return false;
        const originalHandleId = /** @type {any} */ (launchOwn.result).session_id;
        // PASS 2: with the handle grounded, the linked polls and continuations
        // decode their OWN results (P2-2 round-19): a pending result keeps the
        // cell pending; a completed exit-code result settles the Child.
        /** @type {string[]} */
        const pendingCells = [];
        /** @type {Map<string, { statementIndex: number, statementCount: number }>} */
        const linkedStatements = new Map();
        for (const event of /** @type {any[]} */ (events)) {
          const payload = event?.payload;
          const statements = parseCallStatements(event);
          if (statements) {
            for (const [statementIndex, call] of statements.entries()) {
              if (call.kind === 'exec_command' && call.value?.cmd === command) continue;
              if (call.kind === 'write_stdin' && call.value?.session_id === originalHandleId) {
                linkedStatements.set(payload.call_id, { statementIndex, statementCount: statements.length });
              } else if (call.kind === 'wait' && typeof call.value?.cell_id === 'string' && pendingCells.includes(call.value.cell_id)) {
                linkedStatements.set(payload.call_id, { statementIndex, statementCount: statements.length });
              }
            }
          }
          if (payload?.type === 'function_call_output' || payload?.type === 'custom_tool_call_output') {
            const linked = linkedStatements.get(payload.call_id);
            if (linked === undefined) continue;
            // The LINKED statement's OWN result position is the only
            // settlement evidence: another statement's exit code never
            // settles the Child observation.
            const output = statementOutputAt(payload.output, linked.statementIndex, linked.statementCount);
            if (output?.state === 'pending' && typeof output.cellId === 'string') pendingCells.push(output.cellId);
            else if (output?.state === 'completed' && Number.isSafeInteger(output.result?.exit_code)) return true;
          }
        }
        return false;
      });
    } catch { /* transient reads are retried; the budget signal bounds the watch */ }
    if (settled) return { observed: true, basis: SETTLEMENT_BASIS };
    await sleep(1);
  }
}

/**
 * The default live executor: one opt-in bounded held observation against the
 * fixture, mapped into redacted live facts. Never launched by imports or tests;
 * runShellWaitCase invokes it only when ZCODE_SHELL_WAIT_E2E=1.
 * @param {{ input: ValidatedShellWaitCase, fixture: ShellWaitFixtureHandle }} context
 */
async function executeDefaultLiveCase({ input, fixture }) {
  try {
    return await executeDefaultLiveCaseBody({ input, fixture });
  } catch (error) {
    // A failed observation must still persist its cleanup facts: map whatever
    // held-turn record survived (attached by runHeldHostTurn) into redacted
    // live facts and rethrow with them attached for the caller to persist.
    const held = /** @type {any} */ (error)?.heldTurn ?? null;
    const redactedMessage = redactPrivatePaths(error, fixture);
    const evidenceStub = /** @type {any} */ ({ status: 'inconclusive', inconclusive: { reason: 'the held observation failed before evidence collection', detail: redactedMessage }, facts: null });
    const liveFacts = mapShellWaitLiveFacts(input, held, evidenceStub, null, null, fixture);
    liveFacts.inconclusive = liveFacts.inconclusive?.reason
      ? liveFacts.inconclusive
      : { reason: `the held observation failed: ${redactedMessage}` };
    throw Object.assign(new Error(redactedMessage), { liveFacts });
  }
}

/**
 * The default live executor body (see {@link executeDefaultLiveCase}).
 * @param {{ input: ValidatedShellWaitCase, fixture: ShellWaitFixtureHandle }} context
 */
async function executeDefaultLiveCaseBody({ input, fixture }) {
  const spec = SHELL_WAIT_CASE_SPECS[input.case];
  const temporaryRoot = join(fixture.codexHome, '..');
  const gatesDirectory = join(temporaryRoot, 'gates');
  await mkdir(gatesDirectory, { recursive: true });
  const gatePath = join(gatesDirectory, `${input.case}.completion.gate`);
  const gateReachedPath = join(gatesDirectory, `${input.case}.completion.reached`);
  const processPath = join(gatesDirectory, `${input.case}.process.json`);
  const processNonce = randomBytes(32).toString('hex');
  // The process marker is deliberately NOT pre-created: the file exists with
  // its JSON payload only after fake ZCode actually launches, so an early host
  // exit classifies as MARKER_ABSENT (confirmed absence, complete cleanup)
  // rather than marker corruption.
  await Promise.all([
    writeFile(gatePath, 'hold', 'utf8'),
    writeFile(gateReachedPath, '', 'utf8'),
  ]);
  const runEnv = {
    ...fixture.env,
    FAKE_ZCODE_COMPLETION_GATE: gatePath,
    FAKE_ZCODE_COMPLETION_GATE_REACHED: gateReachedPath,
    FAKE_ZCODE_PROCESS_FILE: processPath,
    FAKE_ZCODE_PROCESS_NONCE: processNonce,
    ...(spec.noise === true ? { FAKE_ZCODE_STDERR_BYTES: '4096', FAKE_ZCODE_SESSION_PROGRESS: 'terminal' } : {}),
  };
  // 2026-10-21 evidence-closure Task 3 (the Exit clause): the live-launch
  // preflight runs BEFORE any host launch — a registered required observer
  // that is known absent rejects the case at zero model turns with its named
  // reason, never a burned live label on an unobservable run.
  const preflight = await evaluateLiveLaunchPreflight({ case: input.case, survivalControlSelector: input.survivalControlSelector, fixture });
  if (preflight.ok !== true) {
    throw invalidCaseInput(`shell-wait live-launch preflight rejected the case before launch: ${preflight.reason}`);
  }
  const versionRun = await runProcess(codexLaunch(['--version'], { env: runEnv }), { cwd: fixture.workspace, env: runEnv, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
  const codexVersion = /\b(\d+\.\d+\.\d+)\b/u.exec(`${versionRun.stdout}${versionRun.stderr}`)?.[1] ?? null;
  const expectedCommand = spec.family === /** @type {'rescue'} */ ('rescue')
    ? `${renderRescueLauncherCommand(join(fixture.installedRoot, 'skills', 'rescue', 'launcher.mjs'))} invoke-prepared rescue`
    : `${renderCompanionCommand(join(fixture.installedRoot, 'scripts', 'zcode-companion.mjs'))} ${spec.companionCommand}`;
  // The status-wait case is a TWO-TURN SAME-SESSION live flow: turn 1 (the
  // constant launch prompt) creates the held job INSIDE the live host session
  // and its observed acknowledgement carries the reserved job ID; turn 2
  // resumes THAT session with the explicit Status invocation built from the
  // observed ID. A fixture-reserved target could never work live: production
  // selects explicit Status targets OWNER-SCOPED, and the fixture-setup
  // session is not the live session.
  // The §16.4 I1 wiring (release-qualification review round): with the
  // survival-control selector the SAME declared Root turn also launches the
  // fixture-owned progress control on its own exec_command handle and
  // performs the bounded before/after reads — the directive rides the Root
  // prompt, never a separate launch or an extra model turn. The path is
  // fixture-owned and never recorded.
  const casePrompt = input.survivalControlSelector !== null && typeof fixture.survivalControlPath === 'string'
    ? `${shellWaitCasePrompt(input.case)} ${survivalControlPromptDirective(fixture.survivalControlPath)}`
    : shellWaitCasePrompt(input.case);
  // The Status query-turn boundary (P2-2 round-4 fix): established inside the
  // launch closure from the OBSERVED post-turn-1 rollout state; null (the
  // fail-closed whole-rollout analysis) for every other case or when the
  // launch session's rollout cannot be identified.
  /** @type {any} */
  let statusQueryTurn = null;
  // Codex round 1: the OBSERVED durable identity for the live status-wait
  // path (set inside the launch closure once the acknowledgement validates).
  const observedDurableIdentity = { jobId: /** @type {string | null} */ (null), ownerSessionId: /** @type {string | null} */ (null) };

  const held = await runHeldHostTurn({
    gatePath,
    gateReachedPath,
    processPath,
    processNonce,
    holdMs: input.workerDurationMs,
    budgetMs: input.budgetMs,
    launch: async (budgetContext) => {
      // P2-3 round-15 fix: both Status turns share the experiment's
      // cancellation signal and run on the REMAINING experiment deadline —
      // never a fresh full budget per turn.
      const budgetSignal = budgetContext?.signal ?? null;
      const remainingDeadlineMs = typeof budgetContext?.remainingMs === 'function' ? budgetContext.remainingMs : null;
      /** @type {AbortController[]} */
      const controllers = [];
      /** @param {string[]} promptArguments @returns {Promise<{ code: number | null, stdout: string, stderr: string }>} */
      const runTurn = (promptArguments) => {
        const controller = new AbortController();
        controllers.push(controller);
        // The turn shares the experiment cancellation: a budget abort
        // propagates to the turn immediately. Codex round-5 review fix: the
        // forwarded abort is itself a termination initiation (the runner's
        // abort path kills the child), so the boundary is recorded BEFORE
        // forwarding — even when the abort beats this turn's deadline timer
        // (min-semantics; the budget source stamps first, this keeps the
        // listener self-contained for every shared-signal abort).
        if (budgetSignal !== null) budgetSignal.addEventListener('abort', () => {
          if (typeof budgetContext?.recordCleanupBoundary === 'function') budgetContext.recordCleanupBoundary();
          controller.abort();
        }, { once: true });
        // The turn's timeout is the REMAINING experiment deadline on the
        // shared clock, never a fresh full budgetMs.
        const remaining = remainingDeadlineMs !== null ? remainingDeadlineMs() : input.budgetMs;
        // Codex round-4 review fix: the runner enforces its OWN timeout inside
        // runProcess and terminates the child from there — potentially BEFORE
        // the held turn's 50-ms budget poll notices expiry, and always before
        // the wrapper's cleanup sequence would stamp the boundary. This
        // watcher owns the same deadline: it records the cleanup boundary at
        // the runner's termination initiation and THEN aborts the turn, so
        // the runner's abort path performs the kill with the boundary already
        // recorded (min-semantics keep the earliest initiation). The watcher
        // is registered BEFORE the runner spawns, so at one expiry it fires
        // first (Node timers with one expiry run in insertion order); the
        // runner's internal timeout stays as the same-bound backstop.
        const runnerDeadlineTimer = setTimeout(() => {
          if (typeof budgetContext?.recordCleanupBoundary === 'function') budgetContext.recordCleanupBoundary();
          controller.abort();
        }, Math.max(0, remaining));
        // composeHostLaunchArguments supplies the common exec argv EXACTLY
        // once: the status-wait resume turn passes ONLY the `resume
        // <SESSION_ID> <PROMPT>` subcommand tokens (renderExecResumeLaunch),
        // so the subcommand parses instead of a second literal `exec`
        // consuming the PROMPT positional.
        return /** @type {Promise<{ code: number | null, stdout: string, stderr: string }>} */ (runProcess(
          closeStdinLaunch(codexLaunch(composeHostLaunchArguments(promptArguments, fixture.workspace, input.model ?? null, input.execDefaultMs ?? null), { env: runEnv })),
          { cwd: fixture.workspace, env: runEnv, timeoutMs: remaining > 0 ? remaining : 1, maxOutputBytes: 16 * 1024 * 1024, signal: controller.signal },
        ).finally(() => clearTimeout(runnerDeadlineTimer)));
      };
      if (input.case !== 'status-wait') {
        const result = runTurn([casePrompt]);
        return { result, terminate: async () => { for (const controller of controllers) controller.abort(); await result.catch(() => {}); } };
      }
      // TURN 1: the in-session background launch. Its terminal output is the
      // production acknowledgement naming the reserved job. A NONZERO exit
      // fails closed with STRUCTURAL output facts only (P2-2 round-10): the
      // raw stderr/stdout of a failed turn can carry echoed private task,
      // preparation, or assistant content, so neither is ever copied into
      // the failure message — the record keeps the exit code, which stream
      // carried output, and its byte size (the same R0 suppression standard
      // as every other excerpt path).
      const launchTurn = await runTurn([casePrompt]);
      if (launchTurn.code !== 0) {
        const errorStream = launchTurn.stderr && launchTurn.stderr.length > 0 ? "stderr" : "stdout";
        const errorBytes = Buffer.byteLength((errorStream === "stderr" ? launchTurn.stderr : launchTurn.stdout) ?? "", "utf8");
        throw new Error(`the live session's background job launch failed: exit code ${String(launchTurn.code)}, ${errorStream} ${String(errorBytes)} bytes (content withheld)`);
      }
      // The acknowledgement ID is extracted from the OBSERVED rollout as a
      // validated fact — never guessed, never pre-known. The SAME load
      // grounds the query-turn boundary (P2-2 round-4 fix): the resumed
      // session's rollout retains the turn-1 setup observations, and the
      // launch session's rollout event count is the append-stable setup
      // prefix the query-turn analysis slices off.
      const launchRollouts = await loadShellWaitRollouts(fixture.codexHome);
      const acknowledgement = extractStatusLaunchAcknowledgement(launchRollouts);
      if (acknowledgement.jobId === null || acknowledgement.launchSessionId === null) {
        throw new Error('the live session produced no unambiguous reserved-job acknowledgement; the Status query has no in-session target (the case fails closed instead of guessing)');
      }
      statusQueryTurn = findStatusSetupTurnBoundary(launchRollouts, acknowledgement.launchSessionId);
      // Codex round 1: the OBSERVED durable identity — the validated launch
      // acknowledgement's reserved job id and owning (launch) session —
      // grounds the passive durable reader on the live path.
      observedDurableIdentity.jobId = acknowledgement.jobId;
      observedDurableIdentity.ownerSessionId = acknowledgement.launchSessionId;
      // P2-3 round-15 fix: never resume after expiry — a budget that expired
      // during the awaited setup turn or rollout loading refuses the query
      // turn (fail closed) instead of launching it with borrowed time.
      if ((budgetSignal !== null && budgetSignal.aborted) || (remainingDeadlineMs !== null && remainingDeadlineMs() <= 0)) {
        throw new Error('the experiment budget expired before the Status query turn; the query is never resumed after expiry');
      }
      // TURN 2: resume the SAME launch session with the explicit Status
      // query built from the observed acknowledgement ID.
      const queryPrompt = statusWaitInvocation({
        jobId: acknowledgement.jobId,
        queryTimeoutMs: input.statusQueryTimeoutMs ?? 0,
      }).prompt;
      const result = runTurn(renderExecResumeLaunch(acknowledgement.launchSessionId, queryPrompt).args);
      return { result, terminate: async () => { for (const controller of controllers) controller.abort(); await result.catch(() => {}); } };
    },
    waitForGate: (signal) => waitForCompletionGateReached(gateReachedPath, signal),
    waitForObservation: (signal) => waitForLauncherObservation(fixture.codexHome, expectedCommand, signal),
    // The decisive poll's first observation is measured on the held turn's own
    // monotonic clock while the hold runs, so the record can carry an actual
    // poll-start remaining lifetime instead of the retired wall-time arithmetic.
    waitForPollStart: (signal) => waitForPollObservation(fixture.codexHome, expectedCommand, signal),
    // R3 background lifecycle + release-qualification Task 2 foreground
    // extension: the held turn stays open for the bounded Child-settlement
    // watch (the Child's own attached-Companion observation to terminal)
    // before any cleanup or disposal. The explicit background flow keeps its
    // acknowledgement-first watch; the rescue-foreground cases watch ONLY
    // AFTER THE JOIN (the gate-wins ordering) — a foreground host that ends
    // before the gate is a pinned early exit with no joined Child to settle.
    ...(spec.backgroundFlow === true
      ? { waitForChildSettlement: (signal) => waitForChildSettlementObservation(fixture.codexHome, expectedCommand, signal) }
      : runsChildSettlementWatch(input.case)
        ? { waitForChildSettlementAfterJoin: (signal) => waitForChildSettlementObservation(fixture.codexHome, expectedCommand, signal) }
        : {}),
    // 2026-10-21 evidence-closure Task 2: the passive durable snapshot runs at
    // settlement-layer construction (before cleanup) for the ONE case with a
    // pre-known exact bound job identity (status-wait's production-reserved
    // owned job). Other cases keep the named null-supplier contract above.
    ...(input.case === 'status-wait' ? {
      // Codex round 1: the LIVE status-wait identity is the OBSERVED launch
      // acknowledgement (job id + owning session), captured inside the launch
      // closure below; the fixture-owned reservation stays the fallback. A
      // missing identity at settlement time is a NAMED unestablished
      // observation on the held record, never a silent absent layer.
      readDurableSnapshot: () => {
        const observed = observedDurableIdentity.jobId !== null && observedDurableIdentity.ownerSessionId !== null
          ? { jobId: observedDurableIdentity.jobId, ownerSessionId: observedDurableIdentity.ownerSessionId } : null;
        const durableSupplier = statusWaitDurableSnapshotSupplier(fixture, observed);
        return durableSupplier === null
          ? Promise.resolve({ aggregate: 'unestablished', reasons: ['durable-identity-unobserved'] })
          : durableSupplier();
      },
    } : {}),
    ...(input.case === 'rescue-interrupt' ? {
      // 2026-10-21 evidence-closure Task 3: the interrupt case's settlement
      // reader (§16.2 froze that the interruption never terminates the
      // worker/Companion nor cancels the durable job, so the completion-shaped
      // watch can never settle this path — the durable obligation snapshot is
      // THE companion/durable observable). The identity is the OBSERVED
      // exact spawn acknowledgement, resolved from the live rollouts at
      // settlement time; the exact job resolves through the owner-index join
      // (never latest-job guessing). An unresolvable identity is the NAMED
      // unestablished observation, never a silent absent layer.
      readDurableSnapshot: async () => {
        let observedIdentity = null;
        try {
          observedIdentity = observeSpawnAcknowledgementIdentity(await loadShellWaitRollouts(fixture.codexHome));
        } catch (error) {
          return { aggregate: 'unestablished', reasons: [`durable-identity-unobserved: ${String(error instanceof Error ? error.message : error)}`] };
        }
        const durableSupplier = interruptDurableSnapshotSupplier(fixture, observedIdentity);
        return durableSupplier === null
          ? Promise.resolve({ aggregate: 'unestablished', reasons: ['durable-identity-unobserved'] })
          : durableSupplier();
      },
      // 2026-10-23 interrupt-closure Task 3 (report §23.5): the registered
      // pre-cleanup sampling schedule runs for the interrupt case — the
      // closed map is the ONE definition site (the §20.8 producer-map
      // precedent); the frozen defaults (1000-ms floor, 600 attempts, 32
      // summaries) need no override here.
      ...(DURABLE_SAMPLING_ENABLED_CASES.has(input.case) ? { sampleDurableSnapshots: {} } : {}),
    } : {}),
    // P2-1 round-7 fix: the Status deadline flow is OBSERVATION-ONLY — the
    // background launch reserves a queued job and the Status query measures
    // its own deadline, so the fake-peer completion gate is never part of the
    // contract and the query deadline expiry is the expected terminal.
    ...(input.case === 'status-wait' ? { statusDeadlineFlow: true } : {}),
  });

  let rollouts;
  let rolloutsError = null;
  try {
    rollouts = await loadShellWaitRollouts(fixture.codexHome);
  } catch (error) {
    rollouts = [];
    rolloutsError = error;
  }
  // 2026-10-21 evidence-closure Task 2: the attributable stdout capture is
  // admitted through the frozen §19.3 read side BEFORE the evidence
  // adjudication (an observation that must finish before cleanup). A complete
  // admission is threaded as the validated stdout-only capture source; every
  // other admission state is a NAMED observer failure persisted beside the
  // result — never a replaced business result and never transcript-derived.
  const captureHandle = /** @type {any} */ (fixture).stdoutCapture ?? null;
  /** @type {any} */
  let captureAdmission = null;
  let captureAdmissionError = null;
  const zcodeCalls = await readFakeZCodeCalls(fixture.env.FAKE_ZCODE_RECORD ?? '').catch(() => null);
  // Codex round 10 (corrected exit-authority contract): the handle-linked
  // launcher exit is a completion fact OF the evidence — so the evidence
  // pass runs FIRST (without the capture), the admission cross-checks the
  // meta against the selector's handle-linked exit, and a COMPLETE capture
  // is threaded into a SECOND evidence pass whose exact-terminal verdict is
  // then consistent.
  const redactions = [temporaryRoot, fixture.workspace, fixture.codexHome, fixture.installedRoot, fixture.env.HOME]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .map((value) => /** @type {string} */ (value));
  /** @param {boolean} withCapture */
  const buildEvidenceRequest = (withCapture) => ({
    ...shellWaitEvidenceRequest({
      case: input.case,
      command: expectedCommand,
      rollouts,
      zcodeCalls,
      workerDurationMs: input.workerDurationMs,
      pollMs: input.pollMs,
      workerStillAliveAfterObservation: held.endedBeforeGate === false && held.processAliveWhileHeld === true,
      queryTurn: statusQueryTurn,
      ...(withCapture && captureAdmission !== null && captureAdmission.status === 'complete' ? { observedTerminalStdout: captureAdmission.stdout } : {}),
    }),
    // The bounded-diagnostic research gate (follow-up plan Task 4): threaded
    // ONLY when the validated case input enables it, so the default evidence
    // input — and default retention — stay unchanged. The controlled
    // shape-diagnosis gate (plan Task 2) threads identically.
    ...(input.unclassifiedStructuralDiagnostic === true ? { unclassifiedStructuralDiagnostic: true } : {}),
    ...(input.unclassifiedShapeDiagnostic === true ? { unclassifiedShapeDiagnostic: true } : {}),
    // The Task 4 comparison gate: the decisive-poll comparison facts are
    // derived ONLY for the waitPolicy transport (default evidence input
    // unchanged).
    ...(input.waitPolicy !== null ? { waitPolicyComparisonFacts: true } : {}),
    redactions,
  });
  let evidence = inspectShellWaitEvidence(buildEvidenceRequest(false));
  const handleLinkedExitCode = /** @type {any} */ (evidence.facts)?.completion?.processExit ?? null;
  const captureExitAuthority = captureExpectedExitCode({ heldResultCode: typeof held.result?.code === 'number' ? held.result.code : null, handleLinkedExitCode });
  if (captureHandle !== null) {
    try {
      captureAdmission = await admitStdoutCapture({
        captureDirectory: captureHandle.captureDirectory,
        nonce: captureHandle.nonce,
        expectedEntryRealpath: captureHandle.entryRealpath,
        // Codex round 10: the exit-code authority is the HANDLE-LINKED
        // launcher exit (the evidence's original-handle observation) — never
        // the outer `codex exec` code. An unjoinable exit passes NO
        // cross-check (exit attribution unestablished; the live oracle stays
        // missing-evidence on a null exit).
        ...(captureExitAuthority !== undefined ? { expectedExitCode: captureExitAuthority } : {}),
      });
    } catch (error) {
      captureAdmission = null;
      captureAdmissionError = error;
    }
  }
  if (captureAdmission !== null && captureAdmission.status === 'complete') {
    evidence = inspectShellWaitEvidence(buildEvidenceRequest(true));
  }
  const rolloutsFailureReason = rolloutsError === null ? null : redactPrivatePaths(rolloutsError, fixture);
  const liveFacts = mapShellWaitLiveFacts(input, held, evidence, codexVersion, rolloutsFailureReason, fixture, rollouts, redactions, expectedCommand);
  if (captureHandle !== null) {
    // Bounded capture provenance beside the result (see
    // stdoutCaptureProvenance): an admission failure's reason is
    // private-path-redacted, never persisted verbatim.
    const stdoutCapture = stdoutCaptureProvenance(captureAdmission, captureAdmissionError, fixture);
    liveFacts.hostResult = { ...(/** @type {any} */ (liveFacts).hostResult ?? {}), stdoutCapture };
  }
  return liveFacts;
}

/**
 * The bounded stdout-capture provenance block persisted beside the result
 * (2026-10-21 evidence-closure Task 2; review fix): statuses and digests only
 * — never the capture paths and never the captured bytes. A failed
 * admission's reason is routed through {@link redactPrivatePaths} (the same
 * treatment as the rollouts failure): a raw fs error message may embed the
 * private capture path, which never persists.
 * @param {{ status: string, reason: string | null, byteCount: number | null, captureSha256: string | null, exitCode: number | null, exitAttribution?: 'verified' | 'unknown', closureObservationVersion: number | null } | null} admission
 * @param {unknown} admissionError
 * @param {ShellWaitFixtureHandle} fixture
 * @returns {{ status: string, reason: string | null, byteCount: number | null, captureSha256: string | null, exitCode: number | null, exitAttribution: 'verified' | 'unknown' | null, closureObservationVersion: number | null }}
 */
export function stdoutCaptureProvenance(admission, admissionError, fixture) {
  if (admissionError !== null && admissionError !== undefined) {
    return {
      status: 'admission-failed',
      reason: redactPrivatePaths(/** @type {Error} */ (admissionError), fixture),
      byteCount: null,
      captureSha256: null,
      exitCode: null,
      // Codex overall review: the exit-attribution fact rides the persisted
      // block schema-additively (null when no admission exists to attribute).
      exitAttribution: null,
      closureObservationVersion: null,
    };
  }
  if (admission === null || admission === undefined) {
    return { status: 'admission-failed', reason: 'admission-unavailable', byteCount: null, captureSha256: null, exitCode: null, exitAttribution: null, closureObservationVersion: null };
  }
  return {
    status: admission.status,
    reason: admission.reason,
    byteCount: admission.byteCount,
    captureSha256: admission.captureSha256,
    exitCode: admission.exitCode,
    exitAttribution: admission.exitAttribution ?? null,
    closureObservationVersion: admission.closureObservationVersion,
  };
}

/**
 * Codex round 10 (corrected exit-authority contract): the capture's exit
 * authority is the HOST-OBSERVED exit of the EXACT launcher invocation — the
 * original-handle tool result retained in the Child's rollout (the same
 * handle-linked `processExit` the evidence oracle consumes). The outer
 * `codex exec` process code (`heldResultCode`) is a DIFFERENT fact: a
 * launcher may exit 1 with a valid error envelope while the host finishes 0,
 * and conflating the two rejected intact captures as
 * `capture-exit-code-mismatch`. An unjoinable handle exit keeps exit
 * attribution unestablished (no expectedExitCode cross-check at all — the
 * live evidence oracle already stays `missing-evidence` on a null exit).
 * @param {{ heldResultCode: number | null, handleLinkedExitCode: number | null }} input
 * @returns {number | undefined}
 */
export function captureExpectedExitCode(input) {
  const handleLinkedExitCode = /** @type {any} */ (input)?.handleLinkedExitCode;
  return Number.isSafeInteger(handleLinkedExitCode) && handleLinkedExitCode >= 0 ? handleLinkedExitCode : undefined;
}

/**
 * Extract the final assistant message text from collected rollouts (bounded;
 * supports the two observed event shapes) so an early host exit can be
 * adjudicated. Invocation is never inferred from it. The returned text stays
 * in memory: the mapping suppresses its content and persists only a structural
 * marker, because assistant text may echo the private task prompt.
 * @param {unknown} rollouts
 * @returns {string | null}
 */
export function extractFinalAgentMessage(rollouts) {
  let last = null;
  for (const events of Array.isArray(rollouts) ? rollouts : []) {
    if (!Array.isArray(events)) continue;
    for (const event of events) {
      const payload = event?.payload;
      if (payload?.type === 'agent_message' && typeof payload.message === 'string' && payload.message.trim().length > 0) last = payload.message;
      if (payload?.type === 'message' && payload.role === 'assistant' && Array.isArray(payload.content)) {
        const text = payload.content.map((/** @type {any} */ item) => (item && typeof item === 'object' && typeof item.text === 'string' ? item.text : '')).join('');
        if (text.trim().length > 0) last = text;
      }
    }
  }
  return last;
}

// P2-2 round-20 fix: the TERMINAL variants of the pinned AgentStatus enum
// (67727e7c, protocol.rs — payload `completed`, unit `shutdown`, unit
// `not_found`). A delivery whose observed previous status is terminal landed
// on an already-terminal Child: interrupt_spawned_agent explicitly succeeds
// for dead/unloaded runtimes, and a previously yielded cell can remain
// pending after its Child turn ends — tool success never establishes
// interruption of an active turn.
// P2-2 round-21 fix: `errored` (the payload variant) is terminal too — the
// pinned agent/status.rs::is_final() includes Errored, so an already-FAILED
// Child is exactly as non-interruptible as a completed one.
// P2-1 round-22 fix: `interrupted` (the unit variant) is an ALREADY-
// INTERRUPTED turn — another interrupt_agent call can succeed for it without
// interrupting an active turn, and its resumability does not establish
// active execution. V2 interruption qualification requires an ACTIVE
// previous status; every non-active variant is excluded here.

/**
 * Whether a settlement resolution's rollout event time STRICTLY precedes the
 * recorded cleanup boundary. Codex overall review fix (the boundary refinement
 * of round 19), generalized by the round-9 review fix to ANY settlement
 * resolution timestamp — cancellation markers AND exit-code completions
 * alike. The coarse `budgetExpired` boolean discarded genuine pre-cleanup
 * settlements — the observation can resolve BEFORE the budget deadline while
 * the held turn is still waiting (Root still reporting or the fixed hold
 * still running) — and, conversely, credited resolutions produced by the
 * early-exit/failure cleanup kills solely because the budget had not expired.
 * The driver records the WALL-CLOCK epoch-ms initiation boundary
 * (`held.cleanup.cleanupBoundaryAtMs`, on the same clock as the rollout event
 * timestamps) on EVERY controlled-process termination path. Credit holds
 * only when NO cleanup kill was initiated (no boundary recorded and none
 * demonstrable) or the resolution's rollout event time STRICTLY precedes the
 * recorded boundary; a resolution at or after the boundary — or a kill
 * demonstrably initiated without a recorded boundary — fails closed to the
 * unattributed semantics.
 * @param {number} resolvedAtMs the settlement resolution's rollout event time
 * @param {HeldTurnRecord | null | undefined} held
 * @returns {boolean}
 */
function settlementPrecedesCleanupBoundary(resolvedAtMs, held) {
  if (!Number.isFinite(resolvedAtMs)) return false;
  const cleanup = /** @type {any} */ (held)?.cleanup;
  const boundaryAtMs = cleanup?.cleanupBoundaryAtMs;
  if (typeof boundaryAtMs === 'number' && Number.isFinite(boundaryAtMs)) {
    // A termination was INITIATED (the boundary is its initiation record):
    // only a strictly-earlier resolution can be genuine settlement.
    return resolvedAtMs < boundaryAtMs;
  }
  // No recorded boundary: credit only when NO cleanup kill was demonstrably
  // initiated (older records where a kill demonstrably occurred fail closed).
  return held?.budgetExpired !== true
    && cleanup?.verifiedProcessTerminated !== true
    && cleanup?.codexTerminated !== true;
}

/**
 * Map the held outcome and evidence into the redacted live-facts shape.
 * @param {ValidatedShellWaitCase} input
 * @param {HeldTurnRecord} held
 * @param {ReturnType<typeof inspectShellWaitEvidence>} evidence
 * @param {string | null} codexVersion
 * @param {string | null} rolloutsFailureReason
 * @param {ShellWaitFixtureHandle} [fixture]
 * @param {unknown} [rollouts]
 * @param {string[]} [redactions]
 * @param {string | null} [companionCommand] the exact launcher/companion command the observer keyed
 *   the original handle to; the interrupt ordering binding reuses it (P2-3 review fix)
 * @returns {ShellWaitLiveFacts}
 */
export function mapShellWaitLiveFacts(input, held, evidence, codexVersion, rolloutsFailureReason = null, fixture = /** @type {any} */ (null), rollouts = [], redactions = [], companionCommand = null) {
  // `companionCommand` (P2-3 review fix) is the exact launcher/companion
  // command the observer keyed the original handle to: the interrupt
  // ordering binding reuses it to bind pending/terminal events to the EXACT
  // Child observation. Absent command → the ordering facts fail closed.
  // The observer contract family is a case fact (R2): root-family cases map
  // the Root observation linkage (the identified Root host turn) and carry no
  // named/generic agent route; Rescue cases keep the child-linkage mapping.
  const caseSpec = SHELL_WAIT_CASE_SPECS[input.case];
  const family = caseSpec?.family ?? 'rescue';
  const completionFacts = /** @type {any} */ (evidence?.status === 'supported' ? /** @type {any} */ (evidence.facts)?.completion : null);
  const resultCheck = family === 'root' ? completionFacts?.resultCheck ?? null : null;
  const resultCheckLabel = family === 'root' ? caseSpec.resultCheckLabel ?? null : null;
  // The held-run cleanup outcome must survive into the persisted facts on BOTH
  // mapping branches: redacted cleanup errors, the exact process/host
  // termination outcomes, and an explicit completeness verdict. An incomplete
  // cleanup is a cleanup failure — never silently dropped while the CLI exits 0.
  const cleanupErrors = Array.isArray(held?.cleanup?.errors) && fixture
    ? /** @type {unknown[]} */ (held.cleanup.errors).map((error) => redactPrivatePaths(error, fixture))
    : (Array.isArray(held?.cleanup?.errors) ? /** @type {unknown[]} */ (held.cleanup.errors).map((error) => (error instanceof Error ? error.message : String(error))) : []);
  const cleanupSummary = {
    count: cleanupErrors.length,
    reasons: cleanupErrors,
  };
  const processTermination = {
    verifiedTerminated: typeof held?.cleanup?.verifiedProcessTerminated === 'boolean' ? held.cleanup.verifiedProcessTerminated : null,
    codexTerminated: typeof held?.cleanup?.codexTerminated === 'boolean' ? held.cleanup.codexTerminated : null,
  };
  const cleanupComplete = held ? cleanupErrors.length === 0 : null;
  const cleanupFailureReason = cleanupErrors.length > 0
    ? `the held cleanup reported ${String(cleanupErrors.length)} error(s) after observation: ${cleanupErrors.join('; ')}`
    : null;
  // The Task 4 comparison marker (plan Task 4 bullet 3): the waitPolicy
  // run's closed facts about the DECISIVE outer cell — its explicit
  // pragma/yield state ('present' makes default-causality INCONCLUSIVE in
  // the post-run pair adjudication), its admitted call surface (a direct
  // native call is a different surface), its ACTUAL requested inner window
  // (the comparability fact that differing inner requests already explain
  // any contrast), and its FIRST RETURN duration from the rollout event
  // timestamps (measured for pending yields exactly like completed
  // observations). Every unestablishable state stays 'unknown'/null — never
  // a clean absence, never zero. Computed on BOTH mapping branches from the
  // evidence's gated facts (absent facts → unknown), and persisted by
  // buildCaseRecord ONLY for waitPolicy records, so legacy live facts stay
  // byte-for-byte unchanged.
  const waitPolicyComparisonFact = /** @type {any} */ (evidence?.facts)?.waitPolicyComparisonFact ?? null;
  const knownInnerNonterminality = ['inner-cap-live-handle', 'inner-process-exited', 'outer-yield-inner-unresolved'];
  const waitPolicyObservation = input.waitPolicy === 'config-default'
    ? {
      decisivePollExplicitYield: waitPolicyComparisonFact?.decisivePollExplicitYield ?? 'unknown',
      decisiveCallSurface: waitPolicyComparisonFact?.decisiveCallSurface ?? 'unknown',
      // The INNER-vs-OUTER fact (codex review): 'inner-cap-live-handle' is
      // the real M evidence — the inner call reached its cap and returned a
      // live handle — while 'outer-yield-inner-unresolved' is the outer
      // cell's yield and never grounds M. Unknown stays unknown.
      decisiveInnerNonterminality: knownInnerNonterminality.includes(waitPolicyComparisonFact?.decisiveInnerNonterminality)
        ? waitPolicyComparisonFact.decisiveInnerNonterminality
        : 'unknown',
      decisiveInnerYieldMs: typeof waitPolicyComparisonFact?.decisiveInnerYieldMs === 'number' && Number.isFinite(waitPolicyComparisonFact.decisiveInnerYieldMs)
        ? waitPolicyComparisonFact.decisiveInnerYieldMs
        : null,
      decisiveFirstReturnWallMs: typeof waitPolicyComparisonFact?.decisiveFirstReturnWallMs === 'number' && Number.isFinite(waitPolicyComparisonFact.decisiveFirstReturnWallMs)
        ? waitPolicyComparisonFact.decisiveFirstReturnWallMs
        : null,
      decisiveFirstReturnState: waitPolicyComparisonFact?.decisiveFirstReturnState === 'yielded-pending'
        || waitPolicyComparisonFact?.decisiveFirstReturnState === 'completed'
        ? waitPolicyComparisonFact.decisiveFirstReturnState
        : 'unknown',
      decisiveFirstReturnBasis: typeof waitPolicyComparisonFact?.decisiveFirstReturnBasis === 'string' ? waitPolicyComparisonFact.decisiveFirstReturnBasis : null,
    }
    : null;
  // R1 timing provenance: the held turn's MEASURED timeline is the only
  // sanctioned source of poll-start remaining lifetime — remaining hold time
  // at the observed poll start, on the held turn's documented monotonic
  // clock. `pollStartedAtElapsedMs` is the WATCH'S DETECTION time: it lags
  // the actual poll start by the rollout-append plus scan latency, so the
  // computed remaining lifetime is a conservative LOWER bound — it can only
  // understate the true remaining lifetime, never overstate it (the safe
  // direction for the "at least M + 30000 remaining" discriminator). Where
  // the actual timing cannot be established the value stays
  // null with an explicit basis, never the retired
  // `workerDurationMs - decisiveWallMs` arithmetic (which measured observation
  // duration, not poll-start lifetime, and overstated it under a delayed
  // model start).
  const timeline = /** @type {any} */ (held)?.timeline ?? null;
  const pollStartedAtElapsedMs = typeof timeline?.pollStartedAtElapsedMs === 'number' ? timeline.pollStartedAtElapsedMs : null;
  const holdDeadlineElapsedMs = typeof timeline?.holdDeadlineElapsedMs === 'number' ? timeline.holdDeadlineElapsedMs : null;
  const rootAcknowledgementAtElapsedMs = typeof timeline?.rootAcknowledgementAtElapsedMs === 'number' ? timeline.rootAcknowledgementAtElapsedMs : null;
  const childSettlementDetectedAtElapsedMs = typeof timeline?.childSettlementDetectedAtElapsedMs === 'number' ? timeline.childSettlementDetectedAtElapsedMs : null;
  const remainingLifetimeMs = pollStartedAtElapsedMs !== null && holdDeadlineElapsedMs !== null && holdDeadlineElapsedMs >= pollStartedAtElapsedMs
    ? holdDeadlineElapsedMs - pollStartedAtElapsedMs
    : null;
  /** @type {'hold-deadline-at-poll-start' | 'unavailable' | null} */
  const remainingLifetimeBasis = remainingLifetimeMs !== null ? 'hold-deadline-at-poll-start' : timeline !== null ? 'unavailable' : null;
  const heldTimeline = timeline === null ? null : {
    clock: typeof timeline.clock === 'string' ? timeline.clock : null,
    launchedAtElapsedMs: typeof timeline.launchedAtElapsedMs === 'number' ? timeline.launchedAtElapsedMs : null,
    observationDetectedAtElapsedMs: typeof timeline.observationDetectedAtElapsedMs === 'number' ? timeline.observationDetectedAtElapsedMs : null,
    pollStartedAtElapsedMs,
    holdDeadlineElapsedMs,
    rootAcknowledgementAtElapsedMs,
    childSettlementDetectedAtElapsedMs,
    endedAtElapsedMs: typeof timeline.endedAtElapsedMs === 'number' ? timeline.endedAtElapsedMs : null,
  };
  // R3 background lifecycle facts: the Root acknowledgement is NOT the Child's
  // terminal completion. The recorded child facts carry the settlement watch's
  // measured outcome (observed basis, or unobserved/null — never fabricated),
  // and ONLY a declared background case with an OBSERVED settlement may drop
  // the generic early-exit inconclusive; every other case keeps it.
  const backgroundFlow = caseSpec?.backgroundFlow === true;
  const childSettlementFacts = {
    settlement: held?.childSettlement && typeof held.childSettlement === 'object'
      ? {
        observed: held.childSettlement.observed === true,
        basis: typeof held.childSettlement.basis === 'string' ? held.childSettlement.basis : null,
      }
      : { observed: false, basis: null },
    rootAcknowledgementAtElapsedMs,
    settlementDetectedAtElapsedMs: childSettlementDetectedAtElapsedMs,
    // Release-qualification Task 2: the three-way settlement layer split is
    // projected ONLY when the held record carries it — held records without
    // layers keep the mapping schema byte-identical.
    // Codex review round 8: the remote-terminal layer joins from REMOTE
    // outcome evidence — the observer's remote completion facts attributable
    // to the exact Child — NEVER from the held local exit-code watch (a
    // linked poll's exit code, including nonzero, is a local Companion
    // fact). Without remote outcome evidence the layer stays null.
    ...(held?.childSettlement && typeof held.childSettlement === 'object' && held.childSettlement.layers !== undefined
      ? {
        settlementLayers: {
          ...held.childSettlement.layers,
          remoteTerminal: evidence?.status === 'supported' && /** @type {any} */ (evidence.facts)?.completion?.qualified === true
            ? true
            : null,
        },
      }
      : {}),
    // 2026-10-21 evidence-closure Task 2: the typed passive durable snapshot
    // mirrors ONLY when the held record carried it (supplier wired) — held
    // records without it keep the mapping schema byte-identical.
    ...(held?.childSettlement && typeof held.childSettlement === 'object' && held.childSettlement.durableSnapshot !== undefined
      ? { durableSnapshot: held.childSettlement.durableSnapshot }
      : {}),
    // 2026-10-23 interrupt-closure Task 3 (report §23.5): the pre-cleanup
    // sampling block (attempts, baseline, ≤32 per-read summaries with their
    // own started/completed instants, named omissions) mirrors ONLY when the
    // held record carried it — records from runs without the schedule keep
    // the mapping schema byte-identical. The summaries are independent
    // transition/timestamp facts: they never settle, stop, repair or
    // authorize anything, and the offline strict fence judges each read's
    // own completion instant against the recorded cleanup boundary.
    ...(held?.childSettlement && typeof held.childSettlement === 'object' && held.childSettlement.durableSamples !== undefined
      ? { durableSamples: held.childSettlement.durableSamples }
      : {}),
  };
  // P2-1 round-6 fix: the settled-background exemption enforces the
  // background NO-JOIN contract — the background prompt explicitly forbids
  // Root joins, so an observed ZERO wait_agent count in the identified parent
  // rollout is required before a settled acknowledgement may drop the
  // early-exit inconclusive. A join (rootJoins >= 1) is a placement
  // regression and can never qualify; an unestablishable join count (null —
  // the parent linkage is unavailable) fails closed the same way.
  const rootJoinsObserved = evidence?.status === 'supported'
    ? /** @type {any} */ (evidence.facts)?.observations?.rootJoins
    : null;
  // P2-1 round-19 fix: a compliant Host-background Root acknowledges ONLY
  // that the Host child was LAUNCHED — skills/rescue/SKILL.md's background
  // branch: "a bounded acknowledgement claiming only that the Host child was
  // launched — never that Companion work was queued, accepted, started, or
  // completed". The job-reservation wording belongs ONLY to the R3 status
  // flow (a different case): requiring it here rejected valid runs whose
  // Child settlement and zero Root joins were established, while accepting
  // the WRONG acknowledgement contract.
  // P2-1 round-20 fix: the contract is validated against the DECODED FINAL
  // Root reply — never raw stdout occurrences. With `codex exec --json` the
  // stream interleaves command telemetry with the final reply, so a substring
  // search accepted `echo launched` telemetry as well as "The child was NOT
  // launched." The final agent message (the observer's own
  // final-agent-message machinery) is the acknowledgement surface, and a
  // negated launch claim is not a launch claim.
  // P2-1 round-21 fix: the acknowledgement surface is the PARENT rollout's
  // final reply — extractFinalAgentMessage over ALL rollouts returns the LAST
  // message, so a parent rollout collected BEFORE the Child rollout yielded
  // the Child's sentinel instead of Root's launch acknowledgement (the
  // verdict depended on rollout array order). The linkage facts already
  // carry the parent thread id: select that rollout FIRST; an
  // unidentifiable parent rollout fails closed (no acknowledgement).
  const linkageFacts = evidence?.status === 'supported' ? /** @type {any} */ (evidence.facts)?.linkage : null;
  const acknowledgementParentThreadId = typeof linkageFacts?.parentThreadId === 'string' && linkageFacts.parentThreadId.length > 0
    ? linkageFacts.parentThreadId
    : null;
  const parentRolloutEvents = acknowledgementParentThreadId !== null && Array.isArray(rollouts)
    ? rollouts.find((events) => Array.isArray(events)
      && events.some((event) => /** @type {any} */ (event)?.type === 'session_meta'
        && /** @type {any} */ (event)?.payload?.id === acknowledgementParentThreadId)) ?? null
    : null;
  const finalRootReply = parentRolloutEvents !== null ? extractFinalAgentMessage([parentRolloutEvents]) : null;
  // P2-2 round-22 fix: the contract is POSITIVE and LAUNCH-ONLY — the reply
  // must affirmatively claim the launch AND must not contain work-status
  // claims (queued/accepted/started/completed, per the SKILL.md contract
  // wording) nor negations ("never launched"). Unsupported or contradictory
  // replies stay inconclusive.
  // P2-1 round-23 fix: the affirmative claim must match a SUPPORTED launch
  // statement shape — the SKILL.md background branch's own affirmative
  // production phrasing ("the Host child was launched", "the Host Rescue
  // child was launched"). A bare word search accepted contraction negations
  // ("wasn't launched"), hypotheticals ("should be launched"), and any other
  // launch-adjacent phrasing; everything not matching the supported
  // affirmative shapes fails closed, alongside the explicit negation,
  // contraction, hypothetical, and work-status rejections.
  // P2-1 round-23 fix: the affirmative claim must match a SUPPORTED launch
  // statement shape — the SKILL.md background branch's own affirmative
  // production phrasing ("the Host child was launched", "the Host Rescue
  // child was launched"). A bare word search accepted contraction negations
  // ("wasn't launched"), hypotheticals ("should be launched"), and any other
  // launch-adjacent phrasing; everything not matching the supported
  // affirmative shapes fails closed, alongside the explicit negation,
  // contraction, hypothetical, and work-status rejections.
  // P2-1 round-25 fix: the shapes anchor to STATEMENT START — an uncertain
  // reply embedding the phrase ("I cannot confirm that the Host Rescue child
  // was launched.") is not an acknowledgement.
  const supportedLaunchStatementShapes = [
    /^the\s+host\s+(?:rescue\s+)?child\s+(?:was|is|has\s+been)\s+launched\b/iu,
    /^the\s+rescue\s+child\s+(?:was|is|has\s+been)\s+launched\b/iu,
  ];
  const launchStatementAffirmed = typeof finalRootReply === 'string'
    && supportedLaunchStatementShapes.some((shape) => shape.test(finalRootReply));
  const backgroundRootAcknowledged = backgroundFlow
    && /** @type {any} */ (held)?.result?.code === 0
    && launchStatementAffirmed
    && !/\b(?:not|never)\s+(?:been\s+)?launched\b/iu.test(finalRootReply ?? '')
    && !/\bn't\b[^.\n]*\blaunched\b/iu.test(finalRootReply ?? '')
    && !/\b(?:should|would|could|must|shall|may|might|will)\s+(?:be\s+)?launched\b/iu.test(finalRootReply ?? '')
    && !/\b(?:queued|accepted|started|completed)\b/iu.test(finalRootReply ?? '');
  const settledBackgroundAcknowledgement = backgroundFlow
    && backgroundRootAcknowledged
    && childSettlementFacts.settlement.observed === true
    && rootJoinsObserved === 0;
  // R3 status-wait live flow: the observed launch acknowledgement and Status
  // query are extracted from the rollouts as validated facts and bound
  // together (same session, exact ID match, explicit timeout). The facts and
  // the fail-closed validation verdict are recorded; an invalid flow is
  // inconclusive, never silently accepted.
  const statusQueryFacts = input.case === 'status-wait'
    ? (() => {
      const acknowledgement = extractStatusLaunchAcknowledgement(rollouts);
      const query = extractStatusQueryJobId(rollouts);
      const validation = validateStatusWaitFlow({
        launchSessionId: acknowledgement.launchSessionId,
        querySessionId: query.querySessionId,
        acknowledgementJobId: acknowledgement.jobId,
        acknowledgementDistinctJobIdCount: acknowledgement.distinctJobIdCount,
        queriedJobId: query.jobId,
        queriedDistinctJobIdCount: query.distinctJobIdCount,
        queryTimeoutMs: input.statusQueryTimeoutMs,
      });
      return {
        launchSessionId: acknowledgement.launchSessionId,
        querySessionId: query.querySessionId,
        acknowledgementJobId: acknowledgement.jobId,
        acknowledgementDistinctJobIdCount: acknowledgement.distinctJobIdCount,
        queriedJobId: query.jobId,
        queriedDistinctJobIdCount: query.distinctJobIdCount,
        queryTimeoutMs: input.statusQueryTimeoutMs ?? null,
        validation,
      };
    })()
    : null;
  /** @type {null | { reason: string }} */
  let inconclusive = null;
  /** @type {unknown[]} */
  let excerpts = [];
  // R4: the owning session's native interrupt interaction, parsed from the
  // collected rollouts and bound to the case's evidence. Every field carries
  // either a measured fact or an explicit investigated reason — a
  // permanently-null delivery placeholder is never used in place of an
  // attempted interaction, and an external budget kill is never labeled as
  // native interruption. The ordering/timing events are bound to the EXACT
  // Child's original handle and its linked continuations (P2-3 review fix):
  // the binding is derived from the supported evidence's exact child thread
  // id plus the exact launcher command; without both, ordering fails closed.
  // POST-REVIEW FIX (2026-10-23, PR #72 independent user review, finding 1):
  // the interrupt attribution consumes the INDEPENDENTLY recovered
  // spawn-acknowledgement identity. The ids below previously derived ONLY
  // from the supported-case analysis, so one unclassified cell aborting that
  // analysis (evidence.status !== 'supported') left every admission conjunct
  // unestablishable (`host-activity-owning-root-unestablished`) while the
  // exact identity sat recovered in `interrupt.partialFacts.spawnIdentity` —
  // the recorded §23.10.4 outcome. The wiring: the exact
  // {@link observeSpawnAcknowledgementIdentity} join over the SAME captured
  // rollouts grounds the binding whenever the supported analysis did not
  // establish an id. STRICT VALIDATION: exact identity only (the join's own
  // `exact` flag; ids stay null when inexact — no alias text, no
  // outer-call-id guessing, no wrapped mapping: the admission's wrapped
  // fail-closed rule stands unchanged); a supported id and an independent id
  // that DISAGREE are the named-unestablished mismatch (both nulled — the
  // admission then re-derives its `host-activity-owning-root-unestablished`
  // classification, never a guessed resolution; the two sources run the same
  // deterministic linkage join over the same rollouts, so the guard is a
  // structural safety net, not a reachable path); the §23.2 frozen grammar is
  // untouched (the unclassified cell stays unclassified — this is the
  // identity join, not shape admission); and the settlement attribution
  // guards apply unchanged (the wiring never manufactures a settlement).
  const interruptSpawnIdentity = input.case === 'rescue-interrupt' && Array.isArray(rollouts) && rollouts.length > 0
    ? observeSpawnAcknowledgementIdentity(rollouts)
    : null;
  /** @param {string | null} supported @param {string | null} independent @returns {string | null} */
  const resolveInterruptIdentity = (supported, independent) => {
    if (supported !== null && independent !== null) return supported === independent ? supported : null;
    return supported ?? independent;
  };
  const interruptChildThreadId = resolveInterruptIdentity(
    evidence?.status === 'supported' ? /** @type {any} */ (evidence.facts)?.linkage?.childThreadId ?? null : null,
    interruptSpawnIdentity?.childThreadId ?? null,
  );
  const interruptRootThreadId = resolveInterruptIdentity(
    evidence?.status === 'supported' ? /** @type {any} */ (evidence.facts)?.linkage?.parentThreadId ?? null : null,
    interruptSpawnIdentity?.parentThreadId ?? null,
  );
  const interruptBindingOptions = interruptChildThreadId !== null && typeof companionCommand === 'string' && companionCommand.length > 0
    ? { childThreadId: interruptChildThreadId, command: companionCommand }
    : null;
  const interruptInteraction = extractInterruptInteraction(rollouts ?? [], redactions ?? [], interruptBindingOptions);
  const evidenceChildThreadId = interruptChildThreadId;
  // CODEX ROUND-3 FIX (2026-10-25, report §23.15): when the whole-case
  // evidence adjudication REJECTS call/response ownership or scan
  // completeness while RECOGNIZED interrupt calls exist, the exact-scan
  // -completeness premise FAILS — the recognized `callCount: 1` is only the
  // RECOGNIZED count and the decoded response is only the first-seen one,
  // never a completeness or authority claim. The contract distinction:
  // identity recovery resolves WHO, never WHICH response is authoritative
  // nor HOW-MANY — recovering the spawn ids does not establish call-scan
  // completeness or response ownership. The covered
  // `inspectShellWaitEvidence` abort-reason family (every reason that
  // rejects ownership or completeness; surveyed exhaustively — these are
  // the ONLY fail-closed scan reasons the observer emits):
  //   'unsupported-call-shape' — an unclassifiable cell body (the scan
  //     cannot know what the cell holds: another interrupt or an explicit
  //     stop could live inside it);
  //   'ambiguous-call-linkage' — conflicting call/response ownership (the
  //     rejected response's authority is unestablishable — codex round-4
  //     reproduction);
  //   'rollouts-overflow' — a rollout beyond the observer event bound (a
  //     TRUNCATED scan — another interrupt could live past the bound).
  // ('rollouts-unavailable' is deliberately NOT in the family: no scan ran
  // at all, so there are no observed facts to preserve and nothing to gate —
  // the existing no-rollout paths keep their behavior.) The pure
  // unsupported-cell case (no recognized call — the round-2 keeper) and the
  // all-classified cases (status 'supported') are untouched by this
  // predicate.
  const interruptScanCompletenessUnestablished = input.case === 'rescue-interrupt'
    && evidence?.status !== 'supported'
    && (evidence?.inconclusive?.reason === 'unsupported-call-shape'
      || evidence?.inconclusive?.reason === 'ambiguous-call-linkage'
      || evidence?.inconclusive?.reason === 'rollouts-overflow')
    && interruptInteraction.attempted === true;
  // The §19.4 host-activity admission (2026-10-21 evidence-closure Task 3):
  // the host-emitted SubAgentActivity(kind=interrupted) item joined to the
  // ONE interrupt call through the registered admission set (every conjunct;
  // counterexamples fail closed with their named reasons). Non-interrupt
  // cases never run the admission (no registered delivery to admit).
  // CODEX ROUND-3 FIX (§23.15): under scan incompleteness the admission
  // set's exactly-one conjunct is UNESTABLISHABLE — the set fails with the
  // named scan reason while the per-conjunct OBSERVED facts (the item join,
  // the identity/window/timing facts) ride verbatim: they are real
  // observations, never erased and never a qualification claim.
  const hostDeliveryAdmissionRaw = input.case === 'rescue-interrupt' && interruptInteraction.attempted
    ? admitInterruptHostDelivery(rollouts ?? [], interruptInteraction, { childThreadId: interruptChildThreadId, rootThreadId: interruptRootThreadId })
    : null;
  const hostDeliveryAdmission = hostDeliveryAdmissionRaw !== null && interruptScanCompletenessUnestablished
    ? { ...hostDeliveryAdmissionRaw, admitted: false, reasons: [...hostDeliveryAdmissionRaw.reasons, 'host-activity-call-scan-incomplete'] }
    : hostDeliveryAdmissionRaw;
  // The exact-target attribution: the id comparison first (the caller
  // supplied an id-shaped target); otherwise the HOST-resolved identity —
  // the host resolved any alias itself and emitted the exact resolved agent
  // id (§19.4 conjunct 3), so an ADMITTED item establishes the exact target
  // even when the caller-supplied alias text stays suppressed. Caller text
  // is never relabeled authoritative: the suppressed target projection is
  // byte-unchanged.
  // Codex round 7: production accepts the uuid crate's parse forms for
  // ThreadId targets (protocol/src/thread_id.rs `ThreadId::from_string` =
  // `Uuid::parse_str`: CASE-INSENSITIVE; hyphenated, simple/unhyphenated,
  // URN and braced forms parse; `Display` emits the canonical
  // lowercase-hyphenated form). The comparison therefore normalizes both
  // sides to the canonical hex form before failing lexical equality; the
  // normalization basis is recorded on the facts, and a genuinely different
  // uuid stays rejected.
  /** @param {string} value */
  const canonicalUuidHex = (value) => value.replace(/[-{}]/g, '').replace(/^urn:uuid:/iu, '').toLowerCase();
  const targetValue = interruptInteraction.target.value;
  const lexicalOrNormalized = targetValue !== null && evidenceChildThreadId !== null
    ? (targetValue === evidenceChildThreadId
      ? true
      : (INTERRUPT_TARGET_HEX_SHAPE.test(canonicalUuidHex(targetValue))
        && INTERRUPT_TARGET_HEX_SHAPE.test(canonicalUuidHex(evidenceChildThreadId))
        && canonicalUuidHex(targetValue) === canonicalUuidHex(evidenceChildThreadId)))
    : null;
  const interruptExactTargetMatch = lexicalOrNormalized !== null
    ? lexicalOrNormalized
    : hostDeliveryAdmission?.admitted === true
      ? true
      : null;
  /** @type {'lexical' | 'uuid-normalized' | 'host-admitted-identity' | null} */
  const interruptExactTargetMatchBasis = interruptExactTargetMatch !== true
    ? null
    : lexicalOrNormalized !== null
      ? (targetValue === evidenceChildThreadId ? 'lexical' : 'uuid-normalized')
      : 'host-admitted-identity';
  // Codex round-6 review fix; generalized by the round-9 review fix: the
  // survival delivery bound consumes the SAME cleanup-aware settlement
  // attribution the mapper's settlement branches apply — for EVERY response
  // kind. When a cleanup boundary is RECORDED, the settled delivery is
  // CLEANUP-GENERATED exactly when its resolution timestamp (the earliest
  // attributable settlement after the delivery: a cancellation marker OR an
  // exit-code completion) is at/after that boundary — the reader then leaves
  // the bound unestablished (fail closed), even when qualifying control reads
  // and later emissions would otherwise qualify. Without a recorded boundary
  // the PRIOR per-kind semantics stand: only a demonstrable cleanup kill
  // excludes, and only the cancellation kind (an exit-code completion in a
  // no-boundary run is a genuine native settlement — the legacy fixture
  // contract). A resolution strictly before the boundary, or in a run with
  // no cleanup kill, keeps the existing bound semantics.
  const cleanupBoundaryAtMs = typeof held?.cleanup?.cleanupBoundaryAtMs === 'number' && Number.isFinite(held.cleanup.cleanupBoundaryAtMs)
    ? held.cleanup.cleanupBoundaryAtMs
    : null;
  const settledDeliveryCleanupGenerated = interruptInteraction.settledAfterCall.atMs !== null && (
    cleanupBoundaryAtMs !== null
      ? interruptInteraction.settledAfterCall.atMs >= cleanupBoundaryAtMs
      : ((held?.budgetExpired === true
        || held?.cleanup?.verifiedProcessTerminated === true
        || held?.cleanup?.codexTerminated === true) === true
        && interruptInteraction.cancelledAfterCall.atMs === interruptInteraction.settledAfterCall.atMs)
  );
  // The §16.4 survival-control verdict (release-qualification review round):
  // decoded from the SAME collected rollouts through the evidence reader —
  // the control's grounded handle, its bounded pre/post-delivery reads, and
  // its EMISSION tags — and qualified by the offline oracle. Emission-time
  // semantics per §16.4 as amended: liveness/completion bind to a tag
  // strictly after the delivery bound, never to observation time. Selector
  // runs without an observable control fail closed to null; non-selector
  // runs gain nothing.
  const survivalControlFacts = input.case === 'rescue-interrupt'
    && input.survivalControlSelector === SURVIVAL_CONTROL_SELECTOR_VALUE
    && /** @type {any} */ (fixture)?.survivalControlPath != null
    && Array.isArray(rollouts) && rollouts.length > 0
    ? extractSurvivalControlFacts(rollouts, /** @type {any} */ (fixture).survivalControlPath, { lineCount: SURVIVAL_CONTROL_LINE_COUNT, interruptInteraction, exactTargetMatch: interruptExactTargetMatch, settledDeliveryCleanupGenerated, childThreadId: interruptChildThreadId, scanCompletenessUnestablished: interruptScanCompletenessUnestablished })
    : null;
  // Codex review round 12: the BOUNDED, WHITELISTED oracle inputs persist
  // beside the versioned verdict (offline re-adjudication of the recorded
  // post-delivery tag against its bound). Closed integers, booleans, the
  // ownership/identity classification, and the bound's derivation anchors —
  // never private paths or raw rollouts.
  const survivalControlInputs = survivalControlFacts?.launched === true && survivalControlFacts.handleGrounded === true
    ? {
      deliveryBoundTag: survivalControlFacts.deliveryBoundTag,
      settledDeliveryAtMs: survivalControlFacts.settledDeliveryAtMs ?? null,
      launchAtMs: survivalControlFacts.launchAtMs ?? null,
      emittedLines: survivalControlFacts.emittedLines,
      completionMarker: survivalControlFacts.completionMarker,
      postDeliveryRead: survivalControlFacts.postDeliveryRead,
      beforeDeliveryRead: survivalControlFacts.beforeDeliveryRead,
      ownership: survivalControlFacts.ownership,
      owningRootSessionId: survivalControlFacts.owningRootSessionId ?? null,
      controlExitObserved: survivalControlFacts.controlExitObserved ?? null,
      controlExitPremature: survivalControlFacts.controlExitPremature ?? null,
      controlExitCode: survivalControlFacts.controlExitCode ?? null,
      completionBeforeDeliveryObserved: survivalControlFacts.completionBeforeDeliveryObserved ?? null,
      // CODEX ROUND-4 FIX (§23.15): the persisted inputs carry the
      // scan/ownership rejection state — an offline reader can see the bound
      // was withheld because the interaction's ownership/completeness was
      // REJECTED, not because the control was unobserved.
      ...(interruptScanCompletenessUnestablished ? { scanCompletenessUnestablished: true } : {}),
    }
    : null;
  const survivalControlVerdict = survivalControlFacts?.launched === true && survivalControlFacts.handleGrounded === true
    ? evaluateSurvivalControl({
      deliveryBoundTag: survivalControlFacts.deliveryBoundTag,
      lineCount: SURVIVAL_CONTROL_LINE_COUNT,
      emittedLines: survivalControlFacts.emittedLines,
      completionMarker: survivalControlFacts.completionMarker,
      postDeliveryRead: survivalControlFacts.postDeliveryRead,
      ownership: survivalControlFacts.ownership,
      // Codex review round 8: the post-settlement read's own observed
      // control exit — the INDEPENDENT loss evidence a 'lost' verdict
      // requires; without it a readable empty read stays unknown.
      controlExitObserved: survivalControlFacts.controlExitObserved ?? null,
      // Codex review round 11: whether that exit preceded the designed
      // completion — a premature/mid-run exit rejects liveness outright.
      controlExitPremature: survivalControlFacts.controlExitPremature ?? null,
      // Codex review round 13: the OBSERVED exit code — natural-completion
      // credit requires the designed exit code; an abnormal code is a named
      // rejection.
      controlExitCode: survivalControlFacts.controlExitCode ?? null,
      // Codex review round 14: the independently established pre-delivery
      // completion evidence (the marker-returning read completed before the
      // request) — B bounds lateness, never earliness.
      completionBeforeDeliveryObserved: survivalControlFacts.completionBeforeDeliveryObserved ?? null,
      // §16.4's positive-activity clause REQUIRES the bounded pre-delivery
      // read (a fresh mid-run line, ordered before the interrupt call).
      beforeDeliveryReadObserved: survivalControlFacts.beforeDeliveryRead.observed === true
        && survivalControlFacts.beforeDeliveryRead.orderedBeforeInterrupt === true,
    })
    : null;
  // CODEX ROUND-4 FIX (§23.15) — the DOWNSTREAM-CONSUMER SWEEP (the exhaustive
  // one-pass pass over every interaction/hostDelivery consumer that can grant
  // any positive qualification or credit; the full table lives in the report's
  // §23.15 annotation): (1) the §19.4 admission set → Gate-D
  // `hostActivityAdmitted` — GATED (admitted false + the named scan reason);
  // (2) native settlement (`settled`/`settledBasis`/`turnSettled`) — GATED
  // (the named scan basis); (3) the settlement latency — GATED (null under
  // the guard); (4) the survival/no-collateral verdict — GATED HERE (the
  // delivery bound unestablished via the extraction option above; the
  // oracle's named `delivery-bound-unestablished` arm refuses, observed
  // emissions retained); (5) the persisted survival inputs — carry the guard
  // state. PROVEN observation-only or refusal-facts under the guard (cannot
  // grant a positive): the lexical/host exact-target facts (the Gate-D
  // delivery layer is already refused via `host-activity-unadmitted`);
  // `pendingWindowConfirmed`/`pendingIntervalMs`/`timingBasis` (same refused
  // layer); `terminalBeforeInterrupt` (its FALSE branch requires a proven
  // delivery — unobtainable under the guard; TRUE is a refusal); the
  // completion/cancellation timestamps and `settledDeliveryCleanupGenerated`
  // (cleanup-ATTRIBUTION facts — refusals, never credit);
  // `naturalCompletionObserved` (reads `settledBasis` — the scan basis never
  // matches); `cleanupKill`/`unreadableContinuation`/`previousStatusTerminal`
  // (refusal facts); the durable-side join blocks (samples/identity — not
  // interaction-derived, gated in their own fixes); `statusObservationTimeoutOnly`
  // (constant false). No ungated positive-granting consumer remains.
  const interruptCompletionQualified = evidence?.status === 'supported' && /** @type {any} */ (evidence.facts)?.completion?.qualified === true;
  const interruptPendingInnerAtEnd = /** @type {any} */ (evidence?.facts)?.observations?.pendingInnerAtEnd === true;
  // Post-completion classification: a delivery observed AFTER the inner
  // terminal (same-rollout event order, a bound completed event at/before the
  // call, or a qualified completion with no pending observation before the
  // call) is recorded but NEVER attributed as the interrupt's settlement.
  const interruptPostCompletion = interruptInteraction.sameRolloutCompletedBeforeCall === true
    || (interruptInteraction.orderingBound === true && interruptInteraction.completedBeforeCall.atMs !== null)
    || (interruptCompletionQualified && interruptInteraction.pendingBeforeCall.observed === false);
  // P2-2 round-20 fix: the observed previous status of the delivered
  // interrupt — terminal statuses mean the interrupt landed on an
  // already-terminal Child.
  const interruptPreviousStatusTerminal = typeof interruptInteraction.previousStatus === 'string'
    && TERMINAL_INTERRUPT_PREVIOUS_STATUSES.has(interruptInteraction.previousStatus);
  // P2 round-27 fix: an OBSERVED unreadable continuation response (a linked
  // wait whose response arrived but fails its own statement decode) is
  // BLOCKING evidence for the interruption exemption — that response could
  // itself represent completion or termination, so survival is UNKNOWN and
  // the trial stays inconclusive.
  const interruptUnreadableContinuationObserved = (interruptInteraction.unparseableBoundResponses ?? 0) > 0;
  let interruptSettled = null;
  let interruptSettledBasis = null;
  if (interruptInteraction.attempted) {
    // Exactly-one-delivery contract (P2-2 round-2 fix): the extractor counts
    // EVERY interrupt-shaped call; with more than one attempt the retained
    // facts describe only the LAST call and any collateral interruption would
    // be hidden — settlement is never attributed and the reason records the
    // ambiguity.
    // Codex review round 14: the interaction-local attribution guards come
    // from the ONE shared predicate (also consumed by the survival reader's
    // delivery-bound contract) — the guard keys map to the pinned basis
    // strings, never diverging from the reader's exclusions.
    const deliveryAttributionGuard = interruptDeliveryAttributionGuard(interruptInteraction);
    if (deliveryAttributionGuard === 'multiple-delivery-attempts') interruptSettledBasis = 'multiple-delivery-attempts-not-attributed';
    else if (deliveryAttributionGuard === 'delivery-rejected') interruptSettledBasis = 'delivery-rejected-no-settlement-claim';
    else if (deliveryAttributionGuard === 'delivery-outcome-unobserved') interruptSettledBasis = 'delivery-outcome-unobserved';
    else if (deliveryAttributionGuard === 'ordering-unbound') interruptSettledBasis = 'ordering-unbound-not-attributed';
    // CODEX ROUND-3 FIX (§23.15): the recovered-identity binding removed the
    // ordering-unbound refusal on the abort path — but identity recovery
    // resolves WHO, never HOW-MANY. When an unclassified cell coexists with
    // the recognized call, the scan cannot prove exactly-one delivery or
    // rule out a second interruption / explicit stop inside it, so native
    // SETTLEMENT attribution is refused with the named basis regardless of
    // the recovered identity (the observed delivery facts keep riding).
    else if (interruptScanCompletenessUnestablished) interruptSettledBasis = 'ambiguous-cell-scan-incomplete-not-attributed';
    else if (interruptPostCompletion) interruptSettledBasis = 'post-completion-delivery-not-attributed';
    // P2-2 round-20 fix: a terminal observed previous status is never an
    // interrupted-turn outcome — the interrupt landed on an already-terminal
    // Child, so neither settlement nor a surviving-turn claim is attributed.
    // §24.4 family (10) (native-acceptance Task 2): the TOLERATED
    // already-dead labels (`not_found`/`shutdown` — the pinned wrapper's
    // ThreadNotFound/InternalAgentDied tolerance returns SUCCESS for them,
    // report §24.2) are named separately: the tolerated send is a host-side
    // submission result, never a Child resolution
    // (`already-dead-tolerance-not-a-resolution`); the other terminal labels
    // keep the round-20 basis.
    else if (deliveryAttributionGuard === 'previous-status-terminal') {
      interruptSettledBasis = interruptInteraction.previousStatus === 'not_found' || interruptInteraction.previousStatus === 'shutdown'
        ? 'already-dead-tolerance-not-a-resolution'
        : 'previous-status-terminal-no-interruption-claim';
    }
    // Exact-target requirement (P2-1 round-2 fix): chronological ordering
    // alone never establishes interruption. A successful delivery to ANOTHER
    // agent while the observed Child is pending — even when that Child later
    // completes normally — is not a settlement of THIS Child, and the
    // surviving pending observation is not a claim that THIS Child's turn was
    // interrupted.
    else if (interruptExactTargetMatch !== true) interruptSettledBasis = 'delivery-target-unmatched-no-settlement-claim';
    // Codex round 7 (the §19.4 conjunct-1 contract): the interrupt CALL must
    // live in the OWNING ROOT's rollout — a sibling session's call never
    // settles the Root item, however well the target identity matches.
    else if (hostDeliveryAdmission !== null
      && (hostDeliveryAdmission.reasons.includes('host-activity-foreign-call-rollout')
        || hostDeliveryAdmission.reasons.includes('host-activity-call-rollout-unestablished'))) {
      interruptSettledBasis = 'foreign-call-rollout-no-settlement-claim';
    }
    // P2 round-27 fix: an unreadable continuation response leaves the
    // settlement outcome UNKNOWN — it could represent completion or
    // termination, so neither settlement nor a surviving-turn claim is
    // attributed.
    else if (interruptUnreadableContinuationObserved) interruptSettledBasis = 'unparseable-continuation-settlement-unknown';
    // Codex round-9 review fix: the cleanup boundary applies to EXIT-CODE
    // settlements too — an exit-code completion resolved by the cleanup kill
    // (its event time at/after a RECORDED cleanup boundary) is the cleanup's
    // resolution, never the delivery's native settlement. Without a recorded
    // boundary an exit-code completion keeps the legacy credit (a completion
    // is excluded only by the boundary evidence, never by the kill flags
    // alone — those only bound the cancellation kind).
    else if (interruptCompletionQualified
      && interruptInteraction.completedAfterCall.atMs !== null
      && cleanupBoundaryAtMs !== null
      && interruptInteraction.completedAfterCall.atMs >= cleanupBoundaryAtMs) {
      interruptSettledBasis = 'budget-cleanup-termination-not-attributed';
    }
    else if (interruptCompletionQualified) {
      interruptSettled = true;
      interruptSettledBasis = 'terminal-observation-after-delivery';
    }
    // Codex review round 7: a NATIVE CANCELLATION resolution of the
    // interrupted observation (`Script terminated` / `aborted by user` — the
    // §16.3 stage-4 terminate-response / cancelled-future settlement) settles
    // the interrupted turn too, projected under the SAME attribution guards
    // as exit-code settlement: every earlier branch in this chain (exactly
    // one delivery, delivered, bound ordering, not post-completion,
    // nonterminal previous status, readable continuations, EXACT target)
    // held to reach this point.
    // Codex review round 8: the CONFIRMED pending-window predicate is part
    // of those guards — a cancellation resolving a poll that STARTED after
    // the interrupt (the poll did not exist at the interruption moment) is
    // never this delivery's settlement; without the confirmed window the
    // layer stays unattributed with the unavailable reason and no latency.
    // The branch precedes the surviving-pending classification because a
    // cancellation resolution contradicts a survived poll; an exit-code
    // settlement above keeps byte-identical facts.
    // Codex review round 19: the PRE-CLEANUP attribution boundary. A run
    // that reached the experiment budget (`budgetExpired`) had its
    // observation STILL UNSETTLED at expiry — the held phase waits for
    // exactly that settlement — so a `Script terminated` marker collected
    // after the budget cleanup is PRESUMED to be the kill's resolution, never
    // this delivery's native cancellation (a budget kill/released completion
    // gate is cleanup, never native cancellation).
    // Codex overall review fix, extended to EVERY termination path by the
    // second overall review fix: the presumption is bounded by the RECORDED
    // cleanup boundary instead of the coarse boolean, on EVERY controlled-
    // process termination path (early exit, Status-deadline end, failure,
    // budget expiry). The held timeline runs on the held turn's own monotonic
    // elapsed clock, which is NOT comparable to rollout event times, so the
    // driver records each cleanup kill's initiation as a WALL-CLOCK epoch-ms
    // timestamp (`held.cleanup.cleanupBoundaryAtMs`): a cancellation
    // resolution whose rollout event time is STRICTLY BEFORE that boundary is
    // a genuine pre-cleanup settlement and is credited below with its
    // measured latency (the held turn does not finish when the Child's
    // cancellation arrives — Root may still be reporting or the fixed hold
    // still running — so `budgetExpired` can be true anyway); a marker at or
    // after any initiated boundary — or a kill demonstrably initiated without
    // a recorded boundary — stays the kill's resolution, unattributed, no
    // latency (the round-19 semantics). A genuinely native cancellation in a
    // run with NO cleanup kill keeps full credit. The overall budget-expired
    // inconclusive verdict below is unchanged.
    else if (interruptInteraction.pendingBeforeCall.observed === true
      && interruptInteraction.cancelledAfterCall.atMs !== null
      && settlementPrecedesCleanupBoundary(interruptInteraction.cancelledAfterCall.atMs, held)) {
      interruptSettled = true;
      interruptSettledBasis = 'native-cancellation-settlement-after-delivery';
    }
    // The same marker shape with a cleanup kill initiated at/after the
    // marker (or demonstrably initiated without a recordable boundary):
    // `settled` stays null with the named not-attributed basis and no
    // delivery-to-settlement latency; the budget-cleanup inconclusive
    // verdict below is unchanged.
    else if (interruptInteraction.pendingBeforeCall.observed === true
      && interruptInteraction.cancelledAfterCall.atMs !== null) {
      interruptSettledBasis = 'budget-cleanup-termination-not-attributed';
    }
    // Codex review round 10: an EXPLICIT `wait({…, terminate: true})` marker
    // is an ALTERNATE ENDER — that call's own stop, separately classified —
    // and is never attributed as interrupt settlement: `settled` stays null
    // with the named basis and no latency.
    else if (interruptInteraction.explicitTerminateAfterCall.atMs !== null) {
      interruptSettledBasis = 'explicit-cell-termination-not-attributed';
    }
    // P2-2 round-25 fix: the surviving-turn outcome requires a CONFIRMED
    // pending window — an exact-target interrupt that PRECEDED the first poll
    // leaves a subsequently yielded poll unattributed (that observation never
    // existed at interruption time, and the overall inconclusive verdict does
    // not correct false outcome facts). Without the confirmed window the
    // settlement outcome stays UNKNOWN.
    else if (interruptPendingInnerAtEnd && interruptInteraction.pendingBeforeCall.observed === true) {
      // Turn interruption WITHOUT inner-poll settlement: the yielded cell
      // survived the abort, so settlement is not established — recorded
      // precisely, never treated as proof of observation cancellation.
      interruptSettled = false;
      interruptSettledBasis = 'turn-interrupted-pending-observation-survives';
    }
    // §24.4 family (10) (native-acceptance Task 2): the ADMITTED host-side
    // submission (f2 — the send returned after the enqueue, the item joined)
    // with NO f4 Child resolution of ANY class ever joining is the
    // registered enqueued-but-unresolved shape: it never credits, and the
    // basis names exactly that (an enqueue fact is never a Child
    // receipt/processing claim — §24.2). Codex P2 review fix on this
    // fallback: every RESOLUTION class is checked first — settlement,
    // exit-code completion, cancellation, NONTERMINAL resolution and
    // explicit terminate. When any of them joined, the observation resolved
    // and the shape is NOT an unresolved submission: the plain
    // unavailable-settlement basis stands while the resolution facts ride
    // the record (the acknowledgement is measured against the joined closing
    // stamp), and the admission/attribution chain classifies them per §24.4.
    else if (hostDeliveryAdmission?.admitted === true
      && interruptInteraction.settledAfterCall.atMs === null
      && interruptInteraction.cancelledAfterCall.atMs === null
      && interruptInteraction.completedAfterCall.atMs === null
      && interruptInteraction.resolvedNonterminalAfterCall.atMs === null
      && interruptInteraction.resolvedExplicitStopAfterCall.atMs === null) {
      interruptSettledBasis = 'submission-enqueued-unresolved';
    } else interruptSettledBasis = 'settlement-unavailable';
  }
  const interruptPendingIntervalMs = interruptInteraction.attempted
    && interruptInteraction.pendingBeforeCall.atMs !== null && interruptInteraction.callAtMs !== null
    && interruptInteraction.callAtMs >= interruptInteraction.pendingBeforeCall.atMs
    ? interruptInteraction.callAtMs - interruptInteraction.pendingBeforeCall.atMs
    : null;
  // The delivery-to-settlement latency is attributed ONLY to an EXACT-target
  // delivery (P2-1 round-2 fix): an unrelated agent's completion that happens
  // to follow a foreign delivery supplies no settlement timing.
  // P2-2 round-8 fix: the responsiveness measurement carries the SAME
  // attribution guards as settlement — the latency is recorded only when the
  // delivery is actually ATTRIBUTED as this Child's interruption
  // (`interruptSettled === true`). An ambiguous delivery (multiple attempts,
  // unbound ordering, post-completion, foreign target) produces no
  // delivery-to-settlement measurement even when the last attempt was
  // delivered to the exact target and a terminal output follows it.
  // Codex review round 7: the measured settlement timestamp follows the
  // established basis — the exit-code terminal for the completion basis
  // (byte-identical to the prior behavior) and the NATIVE CANCELLATION
  // resolution for the cancellation basis, so a cancellation-settled case
  // record retains the §16.5 delivery-to-settlement evidence.
  const interruptSettlementAtMs = interruptSettledBasis === 'native-cancellation-settlement-after-delivery'
    ? interruptInteraction.cancelledAfterCall.atMs
    : interruptInteraction.completedAfterCall.atMs;
  const interruptDeliveryToSettlementMs = interruptSettled === true
    && interruptInteraction.delivered === true
    && interruptExactTargetMatch === true
    && interruptInteraction.callAtMs !== null && interruptSettlementAtMs !== null
    && interruptSettlementAtMs >= interruptInteraction.callAtMs
    ? interruptSettlementAtMs - interruptInteraction.callAtMs
    : null;
  /** @type {'rollout-event-timestamps' | 'unavailable' | null} */
  const interruptTimingBasis = !interruptInteraction.attempted
    ? null
    : interruptPendingIntervalMs !== null || interruptDeliveryToSettlementMs !== null ? 'rollout-event-timestamps' : 'unavailable';
  const interruptMissingPrerequisite = input.case !== 'rescue-interrupt' || interruptInteraction.attempted
    ? null
    : 'delivery was not attempted: no interrupt-shaped tool call was observed in the owning session rollouts '
      + '(investigated owning-session surface: interrupt_agent (V2, enabled by the live features.multi_agent_v2 configuration) '
      + 'and legacy send_input {interrupt:true} (V1); the app-server turn/interrupt RPC is not reachable from the exec session process)'
      + (held?.budgetExpired === true ? '; the probe budget expired before delivery (budget cleanup is never native interruption)' : '');
  // Codex overall review fix 3: the cleanup boundary and the cancellation
  // timestamp behind the settlement attribution persist through BOTH
  // projections (the typed live facts and the retained record) so offline
  // adjudication can independently re-verify the verdict after fixture
  // disposal. Schema-additive: each key rides ONLY when its fact exists —
  // legacy records stay byte-identical.
  const interruptCleanupBoundaryAtMs = typeof held?.cleanup?.cleanupBoundaryAtMs === 'number' && Number.isFinite(held.cleanup.cleanupBoundaryAtMs)
    ? held.cleanup.cleanupBoundaryAtMs
    : null;
  const interruptCancelledAtMs = interruptInteraction.cancelledAfterCall.atMs;
  const interruptFacts = {
    requested: input.case === 'rescue-interrupt',
    attempted: interruptInteraction.attempted,
    family: interruptInteraction.family,
    // Codex round 4's wrapped/direct classification (2026-10-23
    // interrupt-closure Task 2: projected beside the family so a wrapped
    // (code-mode-cell) interrupt keeps its named unjoinable limitation
    // visible at the layer-fact level, never folded into the family label).
    wrappedInterrupt: interruptInteraction.wrappedInterrupt,
    delivered: interruptInteraction.delivered,
    rejection: interruptInteraction.rejection,
    previousStatus: interruptInteraction.previousStatus,
    previousStatusTerminal: interruptPreviousStatusTerminal,
    unreadableContinuationObserved: interruptUnreadableContinuationObserved,
    // Exactly-one-delivery contract (P2-2 round-2 fix): every interrupt-shaped
    // call is counted and the count is persisted; count !== 1 fails closed.
    callCount: interruptInteraction.callCount,
    orderingBound: interruptInteraction.orderingBound,
    target: interruptInteraction.target,
    exactTargetMatch: interruptExactTargetMatch,
    // Codex round 7: HOW the exact target was established — the caller
    // text is never relabeled; the basis records the comparison form
    // (lexical / uuid-normalized / host-admitted-identity) or null.
    exactTargetMatchBasis: interruptExactTargetMatchBasis,
    settled: interruptSettled,
    settledBasis: interruptSettledBasis,
    pendingIntervalMs: interruptPendingIntervalMs,
    deliveryToSettlementMs: interruptDeliveryToSettlementMs,
    timingBasis: interruptTimingBasis,
    missingPrerequisite: interruptMissingPrerequisite,
    // 2026-10-21 evidence-closure Task 3 (schema-additive, attempted runs
    // only — legacy records stay byte-identical): the closed pending-window
    // and ordering facts the offline Gate D join consumes, the
    // cleanup-generated settlement attribution (the survival reader's single
    // source of truth, persisted verbatim), and the §19.4 host-delivery
    // admission block (bounded closed facts — booleans, counts, the emission
    // timestamp, named reasons; never the call text, never the alias).
    ...(interruptInteraction.attempted ? {
      pendingWindowObserved: interruptInteraction.pendingBeforeCall.observed === true,
      settlementCleanupGenerated: settledDeliveryCleanupGenerated === true,
      ...(hostDeliveryAdmission !== null ? { hostDelivery: hostDeliveryAdmission } : {}),
    } : {}),
    ...(interruptInteraction.completedBeforeCall.atMs !== null ? { completedBeforeCallMs: interruptInteraction.completedBeforeCall.atMs } : {}),
    ...(interruptInteraction.completedAfterCall.atMs !== null ? { completedAfterCallMs: interruptInteraction.completedAfterCall.atMs } : {}),
    ...(interruptCleanupBoundaryAtMs !== null ? { cleanupBoundaryAtMs: interruptCleanupBoundaryAtMs } : {}),
    ...(interruptCancelledAtMs !== null ? { cancelledAtMs: interruptCancelledAtMs } : {}),
  };
  // The §23.4 abort-case layer exposure (2026-10-23 interrupt-closure Task
  // 2): when the evidence COLLECTION completed (real rollouts are in hand)
  // but the whole-case ADJUDICATION aborted fail-closed (e.g. one unknown
  // call shape), the raw-rollout layer facts stay recoverable and ride the
  // mapping instead of being erased by the bare overall failure — while the
  // overall case keeps its inconclusive verdict and every delivery-layer
  // positive stays unestablished. The block is stamped with the NEW partial
  // -facts adjudicator version and the source-rollout digest so offline
  // readers can always tell these fixture-proof layer facts from the live
  // observer's own supported-case analysis and from any installed-trial
  // stamp (the plan's provenance-separation rule). A pre-turn failure or a
  // rollout-collection failure exposes nothing: there are no raw rollouts to
  // derive the facts from, and the historical collection-incompleteness
  // behavior stays byte-identical there.
  const interruptAbortLayerExposure = input.case === 'rescue-interrupt'
    && rolloutsFailureReason === null
    && evidence.status === 'inconclusive'
    && Array.isArray(rollouts) && rollouts.length > 0;
  const interruptPartialFacts = interruptAbortLayerExposure
    ? {
      adjudicator: 'interrupt-partial-facts',
      version: INTERRUPT_PARTIAL_FACTS_VERSION,
      // The provenance CLASS, not a stamp: these facts are derived from the
      // run's own collected raw rollouts (fixture proof), never from the
      // live observer's supported-case analysis and never presented as a
      // fresh installed observation.
      basis: 'raw-rollout-fixture-proof',
      sourceRolloutsSha256: createHash('sha256').update(JSON.stringify(rollouts)).digest('hex'),
      capture: { rolloutsCaptured: true, rolloutCount: rollouts.length, rolloutsFailureReason: null },
      adjudication: evidence.inconclusive?.reason ?? null,
      // The SAME hoisted projection the attribution wiring consumed above —
      // one deterministic join over the captured rollouts, never a divergent
      // recomputation.
      spawnIdentity: interruptSpawnIdentity ?? observeSpawnAcknowledgementIdentity(rollouts),
    }
    : null;
  if (rolloutsFailureReason !== null) {
    inconclusive = { reason: `rollouts-unavailable: rollout collection failed (${rolloutsFailureReason}); the case is inconclusive rather than zero.` };
  } else if (evidence.status === 'inconclusive' && evidence.inconclusive !== null) {
    inconclusive = { reason: `${evidence.inconclusive.reason}: ${evidence.inconclusive.detail}` };
    if (evidence.inconclusive.excerpt) excerpts.push({ kind: 'unsupported-call-shape', ...evidence.inconclusive.excerpt });
  } else {
    const completion = /** @type {any} */ (evidence.facts).completion;
    const linkage = /** @type {any} */ (evidence.facts).linkage;
    const collection = /** @type {any} */ (evidence.facts).collection;
    const companionFacts = /** @type {any} */ (evidence.facts).companion;
    const handleFacts = /** @type {any} */ (evidence.facts).handle;
    // Retain the mismatch first so excerpt capping cannot hide the decisive
    // diagnostic. Copy only the observer's bounded, already scrubbed excerpts.
    if (completion?.terminalStdoutExcerpt) excerpts.push(completion.terminalStdoutExcerpt);
    excerpts.push(...(companionFacts?.preLaunchDiagnostics?.excerpts ?? []));
    excerpts.push(...(collection?.excerpts ?? []));
    // P2-2 review fix: the interrupt exemption is the interrupt case's OWN
    // contract ONLY when the delivery is EXACT, landed inside the CONFIRMED
    // pending window (bound ordering, never post-completion), EXACTLY ONE
    // interrupt delivery was observed (collateral interruption — a foreign
    // attempt before the exact one — fails the contract), and every
    // STRUCTURAL completion check held — exact linkage, exactly one launch,
    // exactly one observed send, and the observation discipline. The ONLY
    // excused failures are the interruption-specific terminal ones (the
    // missing exit code / result markers after a delivered interrupt, and the
    // surviving pending observation): the Child was interrupted before
    // completing, so those are the measured shape, not a failure. A synthetic
    // rollout with two launches, two sends, two interrupt attempts, or broken
    // linkage stays unqualified with its reasons, however clean the delivery
    // looks. The exemption is scoped to the INTERRUPT CASE (P2-1 round-3
    // fix): an unexpected interrupt during rescue-long/repeat never excuses
    // that case's own terminal-completion failures.
    const interruptExemptCompletion = input.case === 'rescue-interrupt'
      && interruptFacts.delivered === true
      && interruptFacts.exactTargetMatch === true
      && interruptFacts.callCount === 1
      && interruptFacts.orderingBound === true
      && interruptInteraction.pendingBeforeCall.observed === true
      && !interruptPostCompletion
      && !interruptPreviousStatusTerminal
      && !interruptUnreadableContinuationObserved
      && linkage?.exact === true
      && companionFacts?.launchCount === 1
      && companionFacts?.sendCountKnown === true
      && companionFacts?.sendCount === 1
      && handleFacts?.originalHandleChecked === true
      && completion?.structuralViolationCount === 0;
    // P2-3 round-7 fix: the interrupt DELIVERY contract (the interrupt-side
    // predicate of the exemption above). Qualifying the interrupt case
    // requires this even when ordinary terminal completion succeeds — the
    // model ignoring the interrupt instruction must keep the trial
    // inconclusive with its recorded reason.
    // 2026-10-21 evidence-closure Task 3 SCOPE NOTE: the §19.4 host-activity
    // admission deliberately does NOT re-decide this frozen §16.3 case
    // contract (nor the settlement chain below) — it is the Gate D
    // DELIVERY-IDENTITY layer, enforced by the versioned oracle through the
    // offline join ('host-activity-unadmitted'), with the admission's closed
    // facts persisted beside the record for that adjudication.
    const interruptDeliveryContractMet = interruptFacts.delivered === true
      && interruptFacts.exactTargetMatch === true
      && interruptFacts.callCount === 1
      && interruptFacts.orderingBound === true
      && interruptInteraction.pendingBeforeCall.observed === true
      && !interruptPostCompletion
      && !interruptPreviousStatusTerminal
      && !interruptUnreadableContinuationObserved;
    const interruptDeliveryContractFailureReason = !interruptFacts.attempted
      ? interruptFacts.missingPrerequisite ?? 'no interrupt delivery was observed'
      : interruptFacts.delivered === false
        ? `the delivery was rejected (${interruptFacts.rejection ?? 'unknown rejection'})`
        : interruptFacts.delivered === null
          ? 'the delivery outcome was unobserved'
          : interruptFacts.orderingBound !== true
            ? 'the ordering could not be bound to the exact Child observation'
            : interruptPostCompletion
              ? 'the delivery followed the Child completion'
              : interruptPreviousStatusTerminal
                ? 'the interrupt landed on a Child whose observed previous status is not an active turn (terminal or already interrupted)'
                : interruptUnreadableContinuationObserved
                  ? 'an unreadable continuation response left the settlement outcome unknown'
                  : interruptFacts.exactTargetMatch !== true
                ? 'the delivery targeted another agent'
                : interruptFacts.callCount !== 1
                  ? 'multiple delivery attempts were recorded'
                  : interruptInteraction.pendingBeforeCall.observed !== true
                    ? 'no confirmed pending observation preceded the delivery'
                    : 'the delivery followed the Child completion';
    if (held.endedBeforeGate && !settledBackgroundAcknowledgement && !interruptExemptCompletion) inconclusive = { reason: 'the host ended before the held completion boundary; the pending-observation claim is inconclusive for this run' };
    if (inconclusive === null) {
      if (held.budgetExpired) inconclusive = { reason: 'the probe budget expired (budget cleanup; never native interruption)' };
      else if (completion?.qualified !== true && !interruptExemptCompletion) inconclusive = { reason: completion?.reason ?? 'completion could not be qualified' };
      else if (statusQueryFacts?.validation.valid === false) inconclusive = { reason: `the observed status-wait flow failed its live-session validation: ${statusQueryFacts.validation.reason}` };
      // P2-2 round-7 fix: the background placement contract holds for EVERY
      // boundary ordering — zero Root joins AND an observed Child settlement
      // are required regardless of which boundary (acknowledgement or gate)
      // won the race. The endedBeforeGate-only check above never runs in the
      // gate-wins ordering, so a joined background trial with observed Child
      // completion would otherwise adjudicate inconclusive:null.
      // P2-2 round-18 fix: a SUCCESSFUL observed Root acknowledgement (exit 0
      // + the acknowledgement output) is part of the same contract on BOTH
      // orderings — Child completion alone never establishes it.
      else if (backgroundFlow && (rootJoinsObserved !== 0 || childSettlementFacts.settlement.observed !== true || backgroundRootAcknowledged !== true)) {
        const placementCause = rootJoinsObserved !== 0
          ? rootJoinsObserved === null
            ? 'the Root-join count was unestablishable'
            : `Root joined the Child (${String(rootJoinsObserved)} wait_agent observation(s) despite the no-join prompt)`
          : childSettlementFacts.settlement.observed !== true
            ? 'the Child settlement was not observed'
            : 'the Root acknowledgement was not a successful observed background acknowledgement (exit 0 with the reserved-job acknowledgement output)';
        inconclusive = { reason: `the background placement contract failed: ${placementCause}.` };
      }
      // P2-3 round-7 fix: qualifying the INTERRUPT case requires ONE observed
      // exact-target delivery during the confirmed pending window — ordinary
      // terminal completion (the model ignoring the interrupt instruction)
      // never qualifies, and rejected/wrong-target/late deliveries keep the
      // trial inconclusive with their recorded reason.
      else if (input.case === 'rescue-interrupt' && !interruptDeliveryContractMet) {
        inconclusive = { reason: `the interrupt case requires one observed exact-target delivery during the confirmed pending window: ${interruptDeliveryContractFailureReason}.` };
      }
    }
    // A root-family case has no named/generic agent route to resolve: the
    // Root turn runs the command itself, so the actual route stays null there.
    const route = family === 'root'
      ? null
      : linkage?.exact === true
        ? (linkage.agentType === 'zcode-rescue' ? 'named' : linkage.agentType === null ? 'generic' : 'unknown')
        : null;
    const liveFacts = {
      codexVersion,
      collection: {
        rolloutCount: collection?.rolloutCount ?? null,
        childToolCallCount: collection?.childToolCallCount ?? null,
        truncated: collection?.truncated === true || /** @type {any} */ (evidence.facts).companion?.preLaunchDiagnostics?.truncated === true,
      },
      route: { requested: caseRoute(input.case), actual: route },
      hostResult: {
        exitCode: held.result?.code ?? null,
        // The OBSERVED companion's exit (from the evidence) is the contract's
        // "original process exit"; the CODEX HOST exit is a separate fact.
        companionProcessExit: completion?.processExit ?? null,
        sentinelMatched: completion?.publicResultMatched ?? null,
        terminalStdoutChecked: held.endedBeforeGate === false && held.cleanup.releasedGate === true ? true : null,
        // Root-family cases only: labels the narrower command-specific
        // rendered-result contract the verdict used. Rescue-family cases keep
        // both null — the Rescue sentinel contract lives in
        // publicResultMatchedSentinel above.
        resultCheck: resultCheck,
        resultCheckLabel: resultCheckLabel,
        // The byte-exact terminal/exit linkage verdict (release-qualification
        // Task 2): projected ONLY for waitPolicy runs whose evidence carried
        // an exact expectation — legacy live facts gain no key.
        ...(input.waitPolicy === 'config-default' && completion?.exactTerminalMatch !== undefined && completion?.exactTerminalMatch !== null
          ? { exactTerminalMatch: completion.exactTerminalMatch }
          : {}),
      },
      linkage: {
        checked: linkage?.checked ?? null,
        mode: family,
        rootThreadId: family === 'root' ? linkage?.rootThreadId ?? null : null,
        childThreadId: family === 'root' ? null : linkage?.childThreadId ?? null,
        parentThreadId: linkage?.parentThreadId ?? null,
        companionLaunchCount: /** @type {any} */ (evidence.facts)?.companion?.launchCount ?? null,
        companionSendCount: /** @type {any} */ (evidence.facts)?.companion?.sendCount ?? null,
        originalHandleChecked: /** @type {any} */ (evidence.facts)?.handle?.originalHandleChecked ?? null,
      },
      observations: {
        outerReturns: /** @type {any} */ (evidence.facts)?.observations?.outerReturns ?? null,
        modelCalls: /** @type {any} */ (evidence.facts)?.observations?.modelCalls ?? null,
        rootJoins: /** @type {any} */ (evidence.facts)?.observations?.rootJoins ?? null,
        decisiveWallMs: /** @type {any} */ (evidence.facts)?.observations?.decisiveWallMs ?? null,
        // Per-poll wall times (P2-1 review fix): each completed
        // original-handle observation's own tool-reported wall time, in event
        // order — the fact a future M trial needs to measure the cap return
        // directly instead of conflating it with the terminal observation.
        pollWallTimesMs: /** @type {any} */ (evidence.facts)?.observations?.pollWallTimesMs ?? null,
        pollStartedAtElapsedMs,
        holdDeadlineElapsedMs,
        remainingLifetimeMs,
        remainingLifetimeBasis,
        pendingInnerAtEnd: /** @type {any} */ (evidence.facts)?.observations?.pendingInnerAtEnd ?? null,
      },
      interrupt: interruptFacts,
      held: {
        endedBeforeGate: held.endedBeforeGate,
        // P2-1 round-7: the Status deadline flow's confirmed terminal.
        statusDeadlineReached: held.statusDeadlineReached === true,
        cleanupLabel: held.cleanup.label,
        gateReleased: held.cleanup.releasedGate,
        cleanupErrors: cleanupSummary,
        processTermination,
        cleanupComplete,
        timeline: heldTimeline,
      },
      child: childSettlementFacts,
      ...(waitPolicyObservation !== null ? { waitPolicyObservation } : {}),
      // The §16.4 survival verdict rides EVERY selector run — null when the
      // control could not be observed (fail closed, never fabricated).
      ...((input.survivalControlSelector ?? null) !== null ? { survivalControl: survivalControlVerdict, survivalControlInputs } : {}),
      statusQuery: statusQueryFacts,
      excerpts,
      inconclusive: cleanupFailureReason !== null
        ? { reason: inconclusive?.reason ? `${inconclusive.reason}; ${cleanupFailureReason}` : cleanupFailureReason }
        : inconclusive,
    };
    if (held.endedBeforeGate === true) {
      const message = extractFinalAgentMessage(rollouts);
      if (message !== null) {
        // Assistant text may echo the private task prompt, so its content is
        // withheld on EVERY path (the same fail-closed rule as unclassifiable
        // call bodies — path-only scrubbing cannot certify it clean). The
        // early-exit adjudication keeps only the structural marker: presence,
        // length, and whether fixture-path scrubbing was in effect.
        liveFacts.excerpts.push({
          kind: 'final-agent-message',
          suppressed: true,
          messageChars: message.length,
          pathRedactionsApplied: redactions.length > 0,
          detail: 'the final assistant message is withheld: it may echo the private task prompt; only its presence and length are recorded',
        });
      }
    }
    return liveFacts;
  }
  return {
    codexVersion,
    collection: {
      // §23.4 capture-vs-admission: when the collection completed but the
      // adjudication aborted, the rollout count is a captured fact and only
      // the supported-case call analysis stays unestablished. Every other
      // fall-through path keeps the historical nulls.
      rolloutCount: interruptAbortLayerExposure ? rollouts.length : null,
      childToolCallCount: null,
      truncated: false,
    },
    route: { requested: caseRoute(input.case), actual: null },
    // A PRE-TURN failure (gate setup, version probe) never reached the held
    // lifecycle: every held fact stays unknown (null) instead of dereferencing
    // the absent record and masking the original error.
    hostResult: { exitCode: held?.result?.code ?? null, companionProcessExit: null, sentinelMatched: null, terminalStdoutChecked: null, resultCheck: resultCheck, resultCheckLabel: resultCheckLabel },
    linkage: { checked: null, mode: family, rootThreadId: null, childThreadId: null, parentThreadId: null, companionLaunchCount: null, companionSendCount: null, originalHandleChecked: null },
    observations: {
      outerReturns: null, modelCalls: null, rootJoins: null, decisiveWallMs: null, pollWallTimesMs: null,
      pollStartedAtElapsedMs: null, holdDeadlineElapsedMs: null,
      remainingLifetimeMs: null, remainingLifetimeBasis: heldTimeline === null ? null : 'unavailable',
      pendingInnerAtEnd: null,
    },
    // The pre-turn failure branch cannot observe the rollouts, so the
    // interaction facts stay unknown (null) with the explicit
    // could-not-observe reason — never the old permanently-null placeholder.
    // §23.4 EXCEPTION (2026-10-23 interrupt-closure Task 2): when the
    // collection COMPLETED and only the whole-case adjudication aborted, the
    // raw-rollout call facts survive exactly as extracted (attempted, count,
    // family, previous status, target, ordering bound — with the delivery
    // OUTCOME facts staying unestablished), the §19.4 admission block rides
    // with its per-conjunct named reasons, and the versioned partial-facts
    // block carries the spawn identity and the source-rollout digest. The
    // whole case keeps its inconclusive verdict; a survivor fact earns no
    // qualification credit by itself.
    interrupt: input.case === 'rescue-interrupt'
      ? (interruptAbortLayerExposure
        ? (interruptInteraction.attempted
          ? (interruptChildThreadId !== null && interruptRootThreadId !== null
            ? {
              // POST-REVIEW FIX (2026-10-23, PR #72 review finding 1): the
              // exact Child/Root identity IS established — recovered
              // independently from the captured rollouts
              // (interrupt.partialFacts.spawnIdentity) and wired into the
              // attribution above — so the delivery OUTCOME facts ride the
              // SAME bound attribution the supported path records, instead of
              // staying unestablished while the identity sat unused. The
              // whole case keeps its inconclusive verdict and the unknown
              // cell stays unclassified; these layer facts are never a
              // qualification claim by themselves.
              ...interruptFacts,
              missingPrerequisite: `the case's evidence collection completed (${String(rollouts.length)} rollout(s) captured) but the whole-case evidence adjudication aborted before the supported-case analysis (${evidence.inconclusive?.reason ?? 'unknown reason'}): the delivery-layer facts ride the independently recovered spawn-acknowledgement identity (interrupt.partialFacts.spawnIdentity) and the §19.4 admission block (interrupt.hostDelivery) — the identity recovery resolves WHO, never WHICH response is authoritative nor HOW-MANY, so with the scan/ownership rejection coexisting the exactly-one delivery conjunct stays unestablished (interrupt.hostDelivery.reasons) and native settlement attribution is refused (interrupt.settledBasis) — the whole case keeps its inconclusive verdict, and no survivor fact is a qualification claim by itself`,
              ...(interruptPartialFacts !== null ? { partialFacts: interruptPartialFacts } : {}),
            }
            : {
              // The identity stayed unestablishable even with the
              // independent recovery (an inexact spawn acknowledgement): the
              // §23.4 delivery-outcome nulling stands (fail closed, named).
              ...interruptFacts,
              delivered: null,
              rejection: null,
              missingPrerequisite: `the case's evidence collection completed (${String(rollouts.length)} rollout(s) captured) but the whole-case evidence adjudication aborted before the supported-case analysis (${evidence.inconclusive?.reason ?? 'unknown reason'}): the exact Child/Root identity join is unestablished, so every delivery-layer positive stays unestablished (the raw-rollout layer facts ride interrupt.partialFacts and interrupt.hostDelivery, never a qualification claim)`,
              ...(interruptPartialFacts !== null ? { partialFacts: interruptPartialFacts } : {}),
            })
          : {
            // Codex round-2 review fix (report §23.8): the extractor SKIPPED
            // the unclassified cell, so "no recognized interrupt call" is
            // PARSER UNCERTAINTY — the skipped cell could hold the interrupt
            // — never negative evidence. Absence stays unknown: the
            // call-shape facts stay null (never false/0, never
            // absent-as-negative) and the message names the uncertainty
            // instead of the definitive delivery-not-attempted claim. A
            // RECOGNIZED attempt keeps the keeper branch above unchanged.
            // (family/previousStatus/target/exactTargetMatch/settled are
            // already null — unknown — without a recognized call.)
            ...interruptFacts,
            attempted: null,
            callCount: null,
            wrappedInterrupt: null,
            previousStatusTerminal: null,
            delivered: null,
            rejection: null,
            missingPrerequisite: `the case's evidence collection completed (${String(rollouts.length)} rollout(s) captured) but the whole-case evidence adjudication aborted on an unsupported call shape (${evidence.inconclusive?.reason ?? 'unknown reason'}): whether an owning-session interrupt was attempted stays unknown — the unclassified cell could hold the interrupt call, so the absence of a recognized interrupt is parser uncertainty, never negative evidence (the raw-rollout layer facts ride interrupt.partialFacts, never a qualification claim)`,
            ...(interruptPartialFacts !== null ? { partialFacts: interruptPartialFacts } : {}),
          })
        : {
          ...interruptFacts,
          attempted: null,
          delivered: null,
          missingPrerequisite: 'the owning-session interrupt delivery could not be observed in this run: the evidence collection did not complete '
            + '(rollouts unavailable or the held observation failed before evidence collection)',
        })
      : interruptFacts,
    held: {
      endedBeforeGate: held?.endedBeforeGate ?? null,
      cleanupLabel: held?.cleanup?.label ?? null,
      gateReleased: held?.cleanup?.releasedGate ?? null,
      cleanupErrors: cleanupSummary,
      processTermination,
      cleanupComplete,
      timeline: heldTimeline,
    },
    child: childSettlementFacts,
    ...(waitPolicyObservation !== null ? { waitPolicyObservation } : {}),
    ...((input.survivalControlSelector ?? null) !== null ? { survivalControl: survivalControlVerdict, survivalControlInputs } : {}),
    statusQuery: statusQueryFacts,
    excerpts,
    inconclusive: cleanupFailureReason !== null
      ? { reason: inconclusive?.reason ? `${inconclusive.reason}; ${cleanupFailureReason}` : cleanupFailureReason }
      : inconclusive,
  };
}

// The default live executor is wired behind the opt-in gate in runShellWaitCase.
/** @type {NonNullable<ShellWaitDependencies['executeLiveCase']>} */
const defaultLiveExecutor = /** @type {any} */ (executeDefaultLiveCase);

/**
 * @typedef {{
 *   status: 'executed' | 'failed',
 *   case: ShellWaitCaseLabel,
 *   executedAt: string,
 *   provenance: Record<string, unknown>,
 *   route: Record<string, unknown>,
 *   linkage: Record<string, unknown>,
 *   observations: Record<string, unknown>,
 *   result: Record<string, unknown>,
 *   interrupt: Record<string, unknown>,
 *   held: Record<string, unknown>,
 *   child: Record<string, unknown>,
 *   statusQuery: Record<string, unknown> | null,
 *   cleanup: { label: string | null, nativeInterruptionClaimed: false, fixtureDisposed: boolean | null, disposalError: string | null, cleanupComplete: boolean | null, cleanupErrorCount: number },
 *   evidence: { count: number, truncated: boolean, excerpts: unknown[], rolloutCount: number | null, childToolCallCount: number | null },
 *   inconclusive: { reason: string } | null,
 *   unclassifiedStructuralDiagnostic?: true,
 * }} ShellWaitCaseRecord
 * @typedef {{
 *   case: ShellWaitCaseLabel,
 *   codexBinary: string,
 *   sourceSha: string,
 *   output: string,
 *   workerDurationMs: number,
 *   capMs: number | null,
 *   pollMs: number,
 *   statusQueryTimeoutMs?: number,
 *   budgetMs: number,
 *   unclassifiedStructuralDiagnostic: boolean,
 *   unclassifiedShapeDiagnostic: boolean,
 *   model: string | null,
 *   waitPolicy: string | null,
 *   execDefaultMs: number | null,
 *   interruptBaselineSelector: string | null,
 *   survivalControlSelector: string | null,
 * }} ValidatedShellWaitCase
 * @typedef {'rescue-baseline'|'rescue-long'|'rescue-repeat'|'rescue-noise'|'rescue-interrupt'|'review-wait'|'adversarial-review-wait'|'status-wait'|'background'} ShellWaitCaseLabel
 * @typedef {{
 *   help?: true,
 *   case?: ShellWaitCaseLabel,
 *   codexBinary?: string,
 *   sourceSha?: string,
 *   output?: string,
 *   workerDurationMs?: number,
 *   capMs?: number | null,
 *   pollMs?: number,
 *   statusQueryTimeoutMs?: number,
 *   budgetMs?: number,
 *   unclassifiedStructuralDiagnostic?: boolean,
 *   unclassifiedShapeDiagnostic?: boolean,
 *   model?: string | null,
 *   waitPolicy?: string | null,
 *   execDefaultMs?: number | null,
 *   interruptBaselineSelector?: string | null,
 *   survivalControlSelector?: string | null,
 * }} ShellWaitCaseInput
 * @typedef {import('./fixture.mjs').ShellWaitFixtureHandle} ShellWaitFixtureHandle
 * @typedef {{
 *   revision: 'working-tree-uncommitted' | 'collection-failed',
 *   digest: string | null,
 *   digestInput: string | null,
 *   model: null,
 *   reachableToolFamily: null,
 *   error?: string,
 *   sourcesChangedDuringRun?: boolean | null,
 *   recordTimeDigest?: string,
 * }} ShellWaitObserverProvenance
 * @typedef {{
 *   codexVersion?: string | null,
 *   route?: { requested?: string, actual?: string | null },
 *   hostResult?: { exitCode?: number | null, companionProcessExit?: number | null, sentinelMatched?: boolean | null, terminalStdoutChecked?: boolean | null, resultCheck?: string | null, resultCheckLabel?: string | null, exactTerminalMatch?: { matched: boolean | null, reason: string | null }, stdoutCapture?: { status: string, reason: string | null, byteCount: number | null, captureSha256: string | null, exitCode: number | null, closureObservationVersion: number | null } },
 *   linkage?: { checked?: boolean | null, mode?: 'rescue' | 'root' | null, rootThreadId?: string | null, childThreadId?: string | null, parentThreadId?: string | null, companionLaunchCount?: number | null, companionSendCount?: number | null, originalHandleChecked?: boolean | null },
 *   observations?: { outerReturns?: number | null, modelCalls?: number | null, rootJoins?: number | null, decisiveWallMs?: number | null, pollWallTimesMs?: (number | null)[] | null, pollStartedAtElapsedMs?: number | null, holdDeadlineElapsedMs?: number | null, remainingLifetimeMs?: number | null, remainingLifetimeBasis?: 'hold-deadline-at-poll-start' | 'unavailable' | null, pendingInnerAtEnd?: boolean | null },
 *   interrupt?: { requested?: boolean, attempted?: boolean | null, family?: 'v2' | 'v1' | null, wrappedInterrupt?: boolean | null, delivered?: boolean | null, rejection?: string | null, previousStatus?: string | null, previousStatusTerminal?: boolean | null, callCount?: number | null, orderingBound?: boolean, target?: { kind: 'agent-id' | 'task-name' | 'unknown' | null, value: string | null, suppressed: boolean, chars: number | null } | null, exactTargetMatch?: boolean | null, exactTargetMatchBasis?: string | null, settled?: boolean | null, settledBasis?: string | null, pendingIntervalMs?: number | null, deliveryToSettlementMs?: number | null, timingBasis?: 'rollout-event-timestamps' | 'unavailable' | null, missingPrerequisite?: string | null, pendingWindowObserved?: boolean, settlementCleanupGenerated?: boolean, unreadableContinuationObserved?: boolean, hostDelivery?: Record<string, unknown>, partialFacts?: Record<string, unknown>, cleanupBoundaryAtMs?: number, cancelledAtMs?: number, completedBeforeCallMs?: number, completedAfterCallMs?: number },
 *   held?: {
 *     endedBeforeGate?: boolean | null,
 *     statusDeadlineReached?: boolean,
 *     cleanupLabel?: string | null,
 *     gateReleased?: boolean | null,
 *     timeline?: HeldTurnTimeline | null,
 *     cleanupErrors?: { count: number, reasons: string[] },
 *     processTermination?: { verifiedTerminated?: boolean | null, codexTerminated?: boolean | null },
 *     cleanupComplete?: boolean | null,
 *   },
 *   child?: {
 *     settlement?: { observed: boolean, basis: string | null } | null,
 *     rootAcknowledgementAtElapsedMs?: number | null,
 *     settlementDetectedAtElapsedMs?: number | null,
 *     settlementLayers?: { remoteTerminal: boolean | null, localProcessReaping: 'natural-exit-observed' | 'cleanup-terminated' | null, durableObligations: 'settled' | 'unresolved' | null },
 *     durableSnapshot?: Record<string, unknown>,
 *   },
 *   statusQuery?: Record<string, unknown> | null,
 *   collection?: { rolloutCount?: number | null, childToolCallCount?: number | null, truncated?: boolean },
 *   excerpts?: unknown[],
 *   inconclusive?: { reason: string } | null,
 * }} ShellWaitLiveFacts
 * @typedef {{
 *   createFixture?: typeof createShellWaitFixture,
 *   executeLiveCase?: (context: { input: ShellWaitCaseInput, fixture: ShellWaitFixtureHandle }) => Promise<ShellWaitLiveFacts>,
 *   observerProvenance?: typeof observerProvenance,
 * }} ShellWaitDependencies
 */

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && pathToFileURL(process.argv[1]).href === pathToFileURL(modulePath).href) {
  const usage = 'usage: node tools/shell-wait-probe/driver.mjs --case <case> --codex <absolute executable> '
    + `--source-sha <40-hex> --output <private empty directory> [--worker-duration-ms ms] [--cap-ms ms] `
    + `[--poll-ms ms] [--budget-ms ms] [--status-query-timeout-ms ms] `
    + `[--unclassified-structural-diagnostic 1] [--unclassified-shape-diagnostic 1] [--model <id>] `
    + `[--wait-policy config-default --exec-default-ms ms] `
    + `[--interrupt-baseline-selector ${INTERRUPT_BASELINE_SELECTOR_VALUE} | --survival-control-selector ${SURVIVAL_CONTROL_SELECTOR_VALUE}] `
    + `(the wait policy is valid for every registered case with its declared §16.6 combination; `
    + `the interrupt selectors are valid only for rescue-interrupt at their declared windows)\n`
    + `cases: ${SHELL_WAIT_CASES.join(', ')}`;
  try {
    const parsed = parseShellWaitArguments(process.argv.slice(2));
    if ('help' in parsed) {
      process.stdout.write(`${usage}\n`);
      process.exitCode = 0;
    } else {
      /** @type {any} */ const record = await runShellWaitCase(parsed);
      process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
      process.exitCode = record.status === 'executed'
        && record.cleanup?.fixtureDisposed !== false
        && record.cleanup?.cleanupComplete !== false ? 0 : 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage}\n`);
    process.exitCode = 1;
  }
}
