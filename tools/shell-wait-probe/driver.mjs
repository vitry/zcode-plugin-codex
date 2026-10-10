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
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { mkdir, readdir, readFile, lstat, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PUBLIC_RESULT_SENTINEL, captureVerifiedProcessIdentity, createShellWaitFixture, inspectVerifiedProcessIdentity, releaseCompletionGate, terminateVerifiedProcess } from './fixture.mjs';
import { renderRescueLauncherCommand } from '../../scripts/lib/rescue-launcher-command.mjs';
import { runProcess } from '../../scripts/lib/process.mjs';
import { codexLaunch } from '../../scripts/lib/tool-launch.mjs';
import { parseCodexRolloutJsonl } from '../../tests/helpers/codex-rescue-qualification.mjs';
import { EXECUTING_EVIDENCE_SOURCE, extractInterruptInteraction, inspectShellWaitEvidence, parseCallStatements, parseToolOutput, precedingStatementsCompleted, statementOutputAt } from './evidence.mjs';


const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const MAX_CASE_EXCERPTS = 64;
// Version tag of the observer-digest construction: bump when the hashed input
// combination changes so old records stay interpretable.
const OBSERVER_DIGEST_TAG = 'zcode-shell-wait-observer-v1';

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
    .update(EXECUTING_DRIVER_SOURCE)
    .digest('hex'),
  digestInput: `${OBSERVER_DIGEST_TAG} || evidence.mjs || driver.mjs (executing module-init snapshot, NUL-separated)`,
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
  const [evidenceSource, driverSource] = await Promise.all([
    readFile(fileURLToPath(new URL('./evidence.mjs', import.meta.url))),
    readFile(fileURLToPath(new URL('./driver.mjs', import.meta.url))),
  ]);
  const digest = createHash('sha256')
    .update(`${OBSERVER_DIGEST_TAG}\0`)
    .update(evidenceSource)
    .update('\0')
    .update(driverSource)
    .digest('hex');
  return {
    revision: 'working-tree-uncommitted',
    digest,
    digestInput: `${OBSERVER_DIGEST_TAG} || evidence.mjs || driver.mjs (working-tree bytes, NUL-separated)`,
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

/** @param {readonly string[]} argv @returns {ShellWaitCaseInput | { help: true }} */
export function parseShellWaitArguments(argv) {
  if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== 'string')) {
    throw invalidCaseInput('arguments must be an array of strings.');
  }
  if (argv.includes('--help')) return { help: true };
  /** @type {Record<string, string>} */
  const values = {};
  const known = ['--case', '--codex', '--source-sha', '--output', '--worker-duration-ms', '--cap-ms', '--poll-ms', '--budget-ms', '--status-query-timeout-ms'];
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
  const defaults = shellWaitCaseDefaults(/** @type {string} */ (values['--case']));
  const capMs = values['--cap-ms'] !== undefined ? Number(values['--cap-ms']) : defaults.capMs;
  const pollMs = values['--poll-ms'] !== undefined ? Number(values['--poll-ms']) : defaults.pollMs;
  if (values['--case'] === 'rescue-baseline' && pollMs !== 60_000) {
    throw invalidCaseInput('rescue-baseline preserves the plain 60000 observation; --poll-ms cannot change it.');
  }
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
  // P2-1 round-8: the provenance read is injectable (and failure-tolerant
  // below) so a mid-trial unreadable observer source can never bypass the
  // disposal guarantees.
  const provenanceReader = dependencies.observerProvenance ?? observerProvenance;
  const fixture = await createFixture({
    sourceRoot: repositoryRoot,
    sourceSha: caseInput.sourceSha,
    codexBinary: caseInput.codexBinary,
    output: caseInput.output,
    variant: caseVariant(caseInput.case),
    commandSkillVariant: commandSkillVariantFor(caseInput.case),
    capMs: caseInput.capMs,
    pollMs: caseInput.pollMs,
    // R3: the live status-wait case NEVER uses the fixture's owning-session
    // reservation — production selects explicit Status targets OWNER-SCOPED,
    // so the job must be created inside the live host session itself (the
    // case's turn-1 recorded launch). The fixture seam is instrument-level
    // test setup only; the explicit query timeout stays a driver-level fact
    // (the rendered turn-2 invocation), never a fixture reservation input.
  });
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
      const record = buildCaseRecord(caseInput, fixture, liveFactsFromFailure, /** @type {'failed'} */ ('failed'), provenance);
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
  const record = buildCaseRecord(caseInput, fixture, liveFacts, 'executed', provenance);
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
 * The root-family instruction-delivery seam: the candidate waiting paragraph
 * is delivered to the isolated installed command Skills exactly when the case
 * is root-family AND the variant is candidate. Rescue cases never touch the
 * command Skills — their delivery surface is the Role/skill assignment.
 * @param {ShellWaitCaseLabel} label */
function commandSkillVariantFor(label) {
  return SHELL_WAIT_CASE_SPECS[label]?.family === 'root' && caseVariant(label) === 'candidate'
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
 * @returns {ShellWaitCaseRecord}
 */
function buildCaseRecord(caseInput, fixture, liveFacts, /** @type {'executed' | 'failed'} */ status = 'executed', observer = null) {
  const fixtureRecord = /** @type {any} */ (fixture).record ?? {};
  const appliedArtifacts = Array.isArray(fixtureRecord.appliedArtifacts) ? fixtureRecord.appliedArtifacts : [];
  return {
    status,
    case: caseInput.case,
    executedAt: new Date().toISOString(),
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
      settled: liveFacts.interrupt?.settled ?? null,
      settledBasis: liveFacts.interrupt?.settledBasis ?? null,
      pendingIntervalMs: liveFacts.interrupt?.pendingIntervalMs ?? null,
      deliveryToSettlementMs: liveFacts.interrupt?.deliveryToSettlementMs ?? null,
      timingBasis: liveFacts.interrupt?.timingBasis ?? null,
      missingPrerequisite: liveFacts.interrupt?.missingPrerequisite ?? null,
    },
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
    // confused with the Child's terminal completion).
    child: {
      settlement: /** @type {any} */ (liveFacts.child)?.settlement ?? null,
      rootAcknowledgementAtElapsedMs: /** @type {any} */ (liveFacts.child)?.rootAcknowledgementAtElapsedMs ?? null,
      settlementDetectedAtElapsedMs: /** @type {any} */ (liveFacts.child)?.settlementDetectedAtElapsedMs ?? null,
    },
    // R3 status-wait live flow: the observed launch acknowledgement and the
    // Status query bound together (same session, exact ID match, explicit
    // timeout), with the fail-closed validation verdict. Job IDs are public
    // rendered surfaces (the acknowledgement and renderJob print them).
    statusQuery: /** @type {any} */ (liveFacts).statusQuery ?? null,
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

/** @param {ShellWaitFixtureHandle} fixture */
async function disposeFixture(fixture) {
  const dispose = /** @type {any} */ (fixture).dispose;
  if (typeof dispose !== 'function') throw new Error('the fixture handle must expose dispose()');
  await dispose();
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
  // The budget is polled against the injectable clock: in production this is
  // the monotonic performance.now(), and instrument tests can drive it
  // deterministically instead of waiting real wall-clock time.
  const budgetTimer = setInterval(() => {
    if (now() < budgetDeadlineMs) return;
    budgetExpired = true;
    budgetController.abort();
    clearInterval(budgetTimer);
  }, 50);
  /** @param {number} ms */
  const abortableSleep = async (ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    budgetController.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('held turn aborted')); }, { once: true });
  });
  try {

  /** @type {HeldTurnRecord['cleanup']} */
  const cleanup = {
    label: 'observation',
    releasedGate: false,
    verifiedProcessTerminated: false,
    codexTerminated: false,
    nativeInterruptionClaimed: false,
    errors: /** @type {unknown[]} */ ([]),
  };
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

  /** @type {HeldTurnRecord} */
  let answer;
  try {
    // Everything from here to the return is inside the cancellation finally, so
    // a thrown failure (including a rejecting host result) also aborts the
    // budget signal, stops the interval, and settles every cancellable wait.
    // P2-3 round-15 fix: the budget-abort listener is installed BEFORE the
    // launch closure runs — a budget that fires during the awaited launch
    // (or a signal that is already aborted by then) must win the boundary
    // race, never be missed. The launch closure receives the SHARED
    // experiment cancellation signal and the REMAINING deadline so both
    // Status turns (and their rollout loading) run on one budget.
    const budgetOutcome = new Promise((resolve) => {
      budgetController.signal.addEventListener('abort', () => resolve({ kind: 'budget' }), { once: true });
    });
    control = await input.launch({
      signal: budgetController.signal,
      remainingMs: () => Math.max(0, Math.round(budgetDeadlineMs - now())),
    });
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
        /** @type {{ observed: boolean, basis: string | null } | null} */
        let childSettlement = null;
        try {
          childSettlement = await input.waitForChildSettlement(budgetController.signal);
        } catch { childSettlement = null; }
        if (budgetExpired) throw new Error('the held observation reached the experiment budget before the Child-side settlement');
        cleanup.label = childSettlement?.observed === true ? 'child-settlement-observed' : 'child-settlement-unobserved';
        timeline.childSettlementDetectedAtElapsedMs = childSettlement?.observed === true ? Math.round(now() - startMs) : null;
        timeline.endedAtElapsedMs = Math.round(now() - startMs);
        answer = {
          endedBeforeGate: true,
          rootAcknowledged: true,
          budgetExpired,
          childSettlement,
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
          answer = {
            endedBeforeGate: false,
            statusDeadlineReached: true,
            budgetExpired,
            identity: undefined,
            processAliveWhileHeld: null,
            result: boundary.value,
            cleanup,
            timeline,
          };
          await safeReleaseGate();
          await safeTerminateExactProcess();
          await safeTerminateCodex();
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
          await safeReleaseGate();
          await safeTerminateExactProcess();
          await safeTerminateCodex();
        }
      } else {
        cleanup.label = 'early-exit';
        timeline.endedAtElapsedMs = Math.round(now() - startMs);
        answer = { endedBeforeGate: true, budgetExpired, identity: undefined, processAliveWhileHeld: null, result: boundary.value, cleanup, timeline };
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
        answer = {
          endedBeforeGate: false,
          statusDeadlineReached: true,
          budgetExpired,
          identity: undefined,
          processAliveWhileHeld: null,
          result: statusDeadlineOutcome.value,
          cleanup,
          timeline,
        };
        await safeReleaseGate();
        await safeTerminateExactProcess();
        await safeTerminateCodex();
      } else {
        if (statusDeadlineOutcome !== null && statusDeadlineOutcome.kind === 'error') throw statusDeadlineOutcome.error;
        if (budgetExpired) throw new Error('the held observation reached the experiment budget before gate release');
      const processAliveWhileHeld = await readProcessIdentity(identity) !== undefined;
      await safeReleaseGate();
      const outcome = await resultOutcome;
      if (outcome.kind === 'error') throw outcome.error;
      await waitForProcessExit(identity, 'natural');
      if (typeof input.waitForChildSettlement === 'function') {
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
        try {
          childSettlement = await input.waitForChildSettlement(budgetController.signal);
        } catch { childSettlement = null; }
        if (budgetExpired) throw new Error('the held observation reached the experiment budget before the Child-side settlement');
        cleanup.label = childSettlement?.observed === true ? 'child-settlement-observed' : 'child-settlement-unobserved';
        timeline.childSettlementDetectedAtElapsedMs = childSettlement?.observed === true ? Math.round(now() - startMs) : null;
        timeline.endedAtElapsedMs = Math.round(now() - startMs);
        answer = {
          endedBeforeGate: false,
          rootAcknowledged: true,
          budgetExpired,
          childSettlement,
          identity,
          processAliveWhileHeld,
          result: outcome.value,
          cleanup,
          timeline,
        };
      } else {
        timeline.endedAtElapsedMs = Math.round(now() - startMs);
        answer = {
          endedBeforeGate: false,
          budgetExpired,
          identity,
          processAliveWhileHeld,
          result: outcome.value,
          cleanup,
          timeline,
        };
      }
      }
    }
  } catch (error) {
    cleanup.label = budgetExpired ? 'budget-cleanup' : cleanup.label === 'early-exit' ? 'early-exit' : 'failure';
    timeline.endedAtElapsedMs = Math.round(now() - startMs);
    answer = {
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
      await safeReleaseGate();
      await safeTerminateExactProcess();
      await safeTerminateCodex();
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
    await safeReleaseGate();
    await safeTerminateExactProcess();
    await safeTerminateCodex();
  } else if (answer.endedBeforeGate) {
    await safeReleaseGate();
    await safeTerminateExactProcess();
    await safeTerminateCodex();
  }
  return answer;
  } finally {
    // Cancel and settle every outstanding gate/observation wait on EVERY exit
    // path (early exit, completion, failure, budget expiry), so no losing poll
    // keeps reading and sleeping — including after fixture deletion — and the
    // CLI can always terminate after completed cleanup. A thrown failure (for
    // example a rejecting host result) passes through this finally too.
    budgetController.abort();
    clearInterval(budgetTimer);
  }
}

/**
 * @typedef {{
 *   launch: (budgetContext?: { signal: AbortSignal, remainingMs: () => number }) => Promise<{ result: Promise<{ code: number | null, stdout: string, stderr: string }>, terminate?: () => Promise<void> }>,
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
 *   childSettlement?: { observed: boolean, basis: string | null } | null,
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
    resultMarkers: [PUBLIC_RESULT_SENTINEL],
    resultCheckLabel: 'narrower check: the rendered review output presents the companion result verbatim, and the linked terminal output carries the fake peer\'s final public result sentinel; full rendered-output equality is not claimed',
  },
  'adversarial-review-wait': {
    family: 'root',
    companionCommand: 'invoke adversarial-review',
    prompt: 'Use the installed $zcode:adversarial-review --wait skill exactly once now. Wait for the review to complete and return only its final public output.',
    resultMarkers: [PUBLIC_RESULT_SENTINEL],
    resultCheckLabel: 'narrower check: the rendered adversarial-review output presents the companion result verbatim, and the linked terminal output carries the fake peer\'s final public result sentinel; full rendered-output equality is not claimed',
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
 * workspace, then the turn's own prompt arguments — a plain prompt for every
 * case except status-wait turn 2, whose prompt arguments are the `resume
 * <SESSION_ID> <PROMPT>` subcommand tokens from
 * {@link renderExecResumeLaunch} (which deliberately carries no common argv
 * of its own, so the subcommand parses exactly once).
 * @param {unknown} promptArguments
 * @param {unknown} workspace
 * @returns {string[]}
 */
export function composeHostLaunchArguments(promptArguments, workspace) {
  if (!Array.isArray(promptArguments) || promptArguments.length === 0 || promptArguments.some((value) => typeof value !== 'string')) {
    throw invalidCaseInput('the turn prompt arguments must be a non-empty array of strings.');
  }
  if (typeof workspace !== 'string' || workspace.length === 0) {
    throw invalidCaseInput('the workspace must be a non-empty string.');
  }
  return [...CODEX_EXEC_COMMON_ARGUMENTS, '-C', workspace, ...promptArguments];
}

/**
 * Build the evidence request the live executor adjudicates: the observer
 * contract is SELECTED BY THE CASE FAMILY here. Root-family cases run the
 * Root-mode adjudication (`mode: 'root'`) against the command-specific
 * rendered-result markers; Rescue cases keep the pre-R2 Rescue contract with
 * the byte-exact public sentinel. Exported as the testable seam between the
 * case specs and `inspectShellWaitEvidence`.
 * @param {{ case: ShellWaitCaseLabel, command: string, rollouts: unknown, zcodeCalls: unknown, workerDurationMs: number, pollMs: number, workerStillAliveAfterObservation: boolean | null, queryTurn?: { sessionId: string, setupEventCount: number } | null }} request
 * @returns {import('./evidence.mjs').ShellWaitEvidenceInput}
 */
export function shellWaitEvidenceRequest(request) {
  const spec = SHELL_WAIT_CASE_SPECS[request.case];
  if (!spec) throw invalidCaseInput(`unknown shell wait case: ${String(request.case)}`);
  return {
    rollouts: request.rollouts,
    zcodeCalls: request.zcodeCalls,
    command: request.command,
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
  const casePrompt = shellWaitCasePrompt(input.case);
  // The Status query-turn boundary (P2-2 round-4 fix): established inside the
  // launch closure from the OBSERVED post-turn-1 rollout state; null (the
  // fail-closed whole-rollout analysis) for every other case or when the
  // launch session's rollout cannot be identified.
  let statusQueryTurn = null;

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
        // propagates to the turn immediately.
        if (budgetSignal !== null) budgetSignal.addEventListener('abort', () => controller.abort(), { once: true });
        // The turn's timeout is the REMAINING experiment deadline on the
        // shared clock, never a fresh full budgetMs.
        const remaining = remainingDeadlineMs !== null ? remainingDeadlineMs() : input.budgetMs;
        // composeHostLaunchArguments supplies the common exec argv EXACTLY
        // once: the status-wait resume turn passes ONLY the `resume
        // <SESSION_ID> <PROMPT>` subcommand tokens (renderExecResumeLaunch),
        // so the subcommand parses instead of a second literal `exec`
        // consuming the PROMPT positional.
        return /** @type {Promise<{ code: number | null, stdout: string, stderr: string }>} */ (runProcess(
          closeStdinLaunch(codexLaunch(composeHostLaunchArguments(promptArguments, fixture.workspace), { env: runEnv })),
          { cwd: fixture.workspace, env: runEnv, timeoutMs: remaining > 0 ? remaining : 1, maxOutputBytes: 16 * 1024 * 1024, signal: controller.signal },
        ));
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
    // R3 background lifecycle: the explicit `--background` Root turn ends at
    // its launched-Child acknowledgement, so the held turn stays open for the
    // CHILD's own attached-Companion observation to terminal (the settlement
    // watch) before any cleanup or disposal. No other case runs this watch.
    ...(spec.backgroundFlow === true
      ? { waitForChildSettlement: (signal) => waitForChildSettlementObservation(fixture.codexHome, expectedCommand, signal) }
      : {}),
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
  const zcodeCalls = await readFakeZCodeCalls(fixture.env.FAKE_ZCODE_RECORD ?? '').catch(() => null);
  const redactions = [temporaryRoot, fixture.workspace, fixture.codexHome, fixture.installedRoot, fixture.env.HOME]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .map((value) => /** @type {string} */ (value));
  const evidence = inspectShellWaitEvidence({
    ...shellWaitEvidenceRequest({
      case: input.case,
      command: expectedCommand,
      rollouts,
      zcodeCalls,
      workerDurationMs: input.workerDurationMs,
      pollMs: input.pollMs,
      workerStillAliveAfterObservation: held.endedBeforeGate === false && held.processAliveWhileHeld === true,
      queryTurn: statusQueryTurn,
    }),
    redactions,
  });
  const rolloutsFailureReason = rolloutsError === null ? null : redactPrivatePaths(rolloutsError, fixture);
  return mapShellWaitLiveFacts(input, held, evidence, codexVersion, rolloutsFailureReason, fixture, rollouts, redactions, expectedCommand);
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
const TERMINAL_INTERRUPT_PREVIOUS_STATUSES = new Set(['completed', 'errored', 'shutdown', 'not_found', 'interrupted']);

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
  const interruptChildThreadId = evidence?.status === 'supported' ? /** @type {any} */ (evidence.facts)?.linkage?.childThreadId ?? null : null;
  const interruptBindingOptions = interruptChildThreadId !== null && typeof companionCommand === 'string' && companionCommand.length > 0
    ? { childThreadId: interruptChildThreadId, command: companionCommand }
    : null;
  const interruptInteraction = extractInterruptInteraction(rollouts ?? [], redactions ?? [], interruptBindingOptions);
  const interruptCompletionQualified = evidence?.status === 'supported' && /** @type {any} */ (evidence.facts)?.completion?.qualified === true;
  const interruptPendingInnerAtEnd = /** @type {any} */ (evidence?.facts)?.observations?.pendingInnerAtEnd === true;
  const evidenceChildThreadId = interruptChildThreadId;
  const interruptExactTargetMatch = interruptInteraction.target.value !== null && evidenceChildThreadId !== null
    ? interruptInteraction.target.value === evidenceChildThreadId
    : null;
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
    if (interruptInteraction.callCount !== 1) interruptSettledBasis = 'multiple-delivery-attempts-not-attributed';
    else if (interruptInteraction.delivered === false) interruptSettledBasis = 'delivery-rejected-no-settlement-claim';
    else if (interruptInteraction.delivered === null) interruptSettledBasis = 'delivery-outcome-unobserved';
    else if (interruptInteraction.orderingBound !== true) interruptSettledBasis = 'ordering-unbound-not-attributed';
    else if (interruptPostCompletion) interruptSettledBasis = 'post-completion-delivery-not-attributed';
    // P2-2 round-20 fix: a terminal observed previous status is never an
    // interrupted-turn outcome — the interrupt landed on an already-terminal
    // Child, so neither settlement nor a surviving-turn claim is attributed.
    else if (interruptPreviousStatusTerminal) interruptSettledBasis = 'previous-status-terminal-no-interruption-claim';
    // Exact-target requirement (P2-1 round-2 fix): chronological ordering
    // alone never establishes interruption. A successful delivery to ANOTHER
    // agent while the observed Child is pending — even when that Child later
    // completes normally — is not a settlement of THIS Child, and the
    // surviving pending observation is not a claim that THIS Child's turn was
    // interrupted.
    else if (interruptExactTargetMatch !== true) interruptSettledBasis = 'delivery-target-unmatched-no-settlement-claim';
    // P2 round-27 fix: an unreadable continuation response leaves the
    // settlement outcome UNKNOWN — it could represent completion or
    // termination, so neither settlement nor a surviving-turn claim is
    // attributed.
    else if (interruptUnreadableContinuationObserved) interruptSettledBasis = 'unparseable-continuation-settlement-unknown';
    else if (interruptCompletionQualified) {
      interruptSettled = true;
      interruptSettledBasis = 'terminal-observation-after-delivery';
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
  const interruptDeliveryToSettlementMs = interruptSettled === true
    && interruptInteraction.delivered === true
    && interruptExactTargetMatch === true
    && interruptInteraction.callAtMs !== null && interruptInteraction.completedAfterCall.atMs !== null
    && interruptInteraction.completedAfterCall.atMs >= interruptInteraction.callAtMs
    ? interruptInteraction.completedAfterCall.atMs - interruptInteraction.callAtMs
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
  const interruptFacts = {
    requested: input.case === 'rescue-interrupt',
    attempted: interruptInteraction.attempted,
    family: interruptInteraction.family,
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
    settled: interruptSettled,
    settledBasis: interruptSettledBasis,
    pendingIntervalMs: interruptPendingIntervalMs,
    deliveryToSettlementMs: interruptDeliveryToSettlementMs,
    timingBasis: interruptTimingBasis,
    missingPrerequisite: interruptMissingPrerequisite,
  };
  if (rolloutsFailureReason !== null) {
    inconclusive = { reason: `rollouts-unavailable: rollout collection failed (${rolloutsFailureReason}); the case is inconclusive rather than zero.` };
  } else if (evidence.status === 'inconclusive') {
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
    collection: { rolloutCount: null, childToolCallCount: null, truncated: false },
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
    interrupt: input.case === 'rescue-interrupt'
      ? {
        ...interruptFacts,
        attempted: null,
        delivered: null,
        missingPrerequisite: 'the owning-session interrupt delivery could not be observed in this run: the evidence collection did not complete '
          + '(rollouts unavailable or the held observation failed before evidence collection)',
      }
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
 *   hostResult?: { exitCode?: number | null, companionProcessExit?: number | null, sentinelMatched?: boolean | null, terminalStdoutChecked?: boolean | null, resultCheck?: string | null, resultCheckLabel?: string | null },
 *   linkage?: { checked?: boolean | null, mode?: 'rescue' | 'root' | null, rootThreadId?: string | null, childThreadId?: string | null, parentThreadId?: string | null, companionLaunchCount?: number | null, companionSendCount?: number | null, originalHandleChecked?: boolean | null },
 *   observations?: { outerReturns?: number | null, modelCalls?: number | null, rootJoins?: number | null, decisiveWallMs?: number | null, pollWallTimesMs?: (number | null)[] | null, pollStartedAtElapsedMs?: number | null, holdDeadlineElapsedMs?: number | null, remainingLifetimeMs?: number | null, remainingLifetimeBasis?: 'hold-deadline-at-poll-start' | 'unavailable' | null, pendingInnerAtEnd?: boolean | null },
 *   interrupt?: { requested?: boolean, attempted?: boolean | null, family?: 'v2' | 'v1' | null, delivered?: boolean | null, rejection?: string | null, previousStatus?: string | null, callCount?: number | null, orderingBound?: boolean, target?: { kind: 'agent-id' | 'task-name' | 'unknown' | null, value: string | null, suppressed: boolean, chars: number | null } | null, exactTargetMatch?: boolean | null, settled?: boolean | null, settledBasis?: string | null, pendingIntervalMs?: number | null, deliveryToSettlementMs?: number | null, timingBasis?: 'rollout-event-timestamps' | 'unavailable' | null, missingPrerequisite?: string | null },
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
    + `[--poll-ms ms] [--budget-ms ms] [--status-query-timeout-ms ms]\ncases: ${SHELL_WAIT_CASES.join(', ')}`;
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
