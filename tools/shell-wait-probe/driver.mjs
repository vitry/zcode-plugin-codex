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
 * it. Unknown facts are `null`, never `false` or zero.
 */
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { mkdir, readdir, readFile, lstat, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PUBLIC_RESULT_SENTINEL, captureVerifiedProcessIdentity, createShellWaitFixture, inspectVerifiedProcessIdentity, releaseCompletionGate, terminateVerifiedProcess } from './fixture.mjs';
import { renderRescueLauncherCommand } from '../../scripts/lib/rescue-launcher-command.mjs';
import { runProcess } from '../../scripts/lib/process.mjs';
import { codexLaunch } from '../../scripts/lib/tool-launch.mjs';
import { parseCodexRolloutJsonl } from '../../tests/helpers/codex-rescue-qualification.mjs';
import { inspectShellWaitEvidence, parseCallEvent } from './evidence.mjs';


const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const MAX_CASE_EXCERPTS = 64;

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
    case 'adversarial-review-wait':
    case 'status-wait': return { workerDurationMs: 130_000, capMs: null, pollMs: 3_600_000, budgetMs: 360_000 };
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
  const known = ['--case', '--codex', '--source-sha', '--output', '--worker-duration-ms', '--cap-ms', '--poll-ms', '--budget-ms'];
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
  for (const option of ['--worker-duration-ms', '--cap-ms', '--poll-ms', '--budget-ms']) {
    if (values[option] !== undefined) assertPositiveInteger(values[option], option);
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
  const fixture = await createFixture({
    sourceRoot: repositoryRoot,
    sourceSha: caseInput.sourceSha,
    codexBinary: caseInput.codexBinary,
    output: caseInput.output,
    variant: caseVariant(caseInput.case),
    capMs: caseInput.capMs,
    pollMs: caseInput.pollMs,
  });
  let liveFacts;
  try {
    liveFacts = await executeCase({ input: caseInput, fixture });
  } catch (error) {
    // A failed observation must not erase its evidence: when the executor
    // carries mapped live facts (cleanup errors, termination outcomes), the
    // redacted record is persisted BEFORE disposal and the error rethrown so
    // the CLI exits nonzero.
    const liveFactsFromFailure = /** @type {any} */ (error)?.liveFacts;
    if (liveFactsFromFailure) {
      const record = buildCaseRecord(caseInput, fixture, liveFactsFromFailure, /** @type {'failed'} */ ('failed'));
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
  const record = buildCaseRecord(caseInput, fixture, liveFacts);
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
  return {
    case: /** @type {ShellWaitCaseLabel} */ (input.case),
    codexBinary: /** @type {string} */ (input.codexBinary),
    sourceSha: /** @type {string} */ (input.sourceSha),
    output: /** @type {string} */ (input.output),
    workerDurationMs: /** @type {number} */ (input.workerDurationMs),
    capMs: /** @type {number | null} */ (input.capMs),
    pollMs: /** @type {number} */ (input.pollMs),
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
 * Compose the bounded redacted case record. Only whitelisted facts are copied;
 * fixture-private absolute paths can never enter the record, and unknown facts
 * stay `null`.
 * @param {ValidatedShellWaitCase} caseInput
 * @param {ShellWaitFixtureHandle} fixture
 * @param {ShellWaitLiveFacts} liveFacts
 * @returns {ShellWaitCaseRecord}
 */
function buildCaseRecord(caseInput, fixture, liveFacts, /** @type {'executed' | 'failed'} */ status = 'executed') {
  const fixtureRecord = /** @type {any} */ (fixture).record ?? {};
  const appliedArtifacts = Array.isArray(fixtureRecord.appliedArtifacts) ? fixtureRecord.appliedArtifacts : [];
  return {
    status,
    case: caseInput.case,
    executedAt: new Date().toISOString(),
    provenance: {
      sourceSha: caseInput.sourceSha,
      sourceWorktreeOwnedByFixture: true,
      codexVersion: liveFacts.codexVersion ?? null,
      plugin: { identity: 'zcode@vitry', version: fixtureRecord.pluginVersion ?? null },
      fixtureVariant: /** @type {any} */ (fixtureRecord.variant) ?? caseVariant(caseInput.case),
      requestedCapMs: caseInput.capMs ?? null,
      requestedPollMs: caseInput.pollMs ?? null,
      requestedWorkerDurationMs: caseInput.workerDurationMs ?? null,
      requestedBudgetMs: caseInput.budgetMs ?? null,
      sandbox: 'dangerously-bypassed (fixture control, not persisted production trust)',
      hooksTrust: 'bypassed (fixture control, not persisted production trust)',
      isolatedSetup: fixtureRecord.isolatedSetup ?? null,
      instructionVariants: {
        appliedArtifacts,
        namedRoleSha256: fixtureRecord.renderedNamedRoleSha256 ?? fixtureRecord.namedRoleSha256 ?? null,
        genericMessageSha256: fixtureRecord.genericMessageSha256 ?? null,
      },
    },
    route: { requested: liveFacts.route?.requested ?? caseRoute(caseInput.case), actual: liveFacts.route?.actual ?? null },
    linkage: {
      childLinkageChecked: liveFacts.linkage?.checked ?? null,
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
      remainingLifetimeMs: liveFacts.observations?.remainingLifetimeMs ?? null,
      pendingInnerAtEnd: liveFacts.observations?.pendingInnerAtEnd ?? null,
    },
    result: {
      processExit: liveFacts.hostResult?.companionProcessExit ?? null,
      hostExit: liveFacts.hostResult?.exitCode ?? null,
      publicResultMatchedSentinel: liveFacts.hostResult?.sentinelMatched ?? null,
      terminalStdoutChecked: liveFacts.hostResult?.terminalStdoutChecked ?? null,
    },
    interrupt: {
      requested: liveFacts.interrupt?.requested ?? caseInput.case === 'rescue-interrupt',
      delivered: liveFacts.interrupt?.delivered ?? null,
      settled: liveFacts.interrupt?.settled ?? null,
      missingPrerequisite: liveFacts.interrupt?.missingPrerequisite ?? null,
    },
    held: {
      endedBeforeGate: liveFacts.held?.endedBeforeGate ?? null,
      cleanupLabel: liveFacts.held?.cleanupLabel ?? null,
      gateReleased: liveFacts.held?.gateReleased ?? null,
      cleanupErrors: {
        count: typeof liveFacts.held?.cleanupErrors?.count === 'number' ? liveFacts.held.cleanupErrors.count : 0,
        reasons: Array.isArray(liveFacts.held?.cleanupErrors?.reasons) ? liveFacts.held.cleanupErrors.reasons : [],
      },
      processTermination: {
        verifiedTerminated: typeof liveFacts.held?.processTermination?.verifiedTerminated === 'boolean' ? liveFacts.held.processTermination.verifiedTerminated : null,
        codexTerminated: typeof liveFacts.held?.processTermination?.codexTerminated === 'boolean' ? liveFacts.held.processTermination.codexTerminated : null,
      },
    },
    cleanup: {
      label: liveFacts.held?.cleanupLabel ?? null,
      nativeInterruptionClaimed: false,
      fixtureDisposed: null,
      disposalError: null,
      cleanupComplete: typeof liveFacts.held?.cleanupComplete === 'boolean' ? liveFacts.held.cleanupComplete : null,
      cleanupErrorCount: Array.isArray(liveFacts.held?.cleanupErrors?.reasons) ? liveFacts.held.cleanupErrors.reasons.length : 0,
    },
    evidence: evidenceExcerpts(liveFacts.excerpts),
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
  const now = input.now ?? (() => Date.now());
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
  const budgetController = new AbortController();
  let budgetExpired = false;
  // The budget is polled against the injectable clock: in production this is
  // Date.now(), and instrument tests can drive it deterministically instead of
  // waiting real wall-clock time.
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
    control = await input.launch();
    /** @type {Promise<{ kind: 'result', value: { code: number | null, stdout: string, stderr: string } } | { kind: 'error', error: unknown }>} */
    const resultOutcome = Promise.resolve(control.result).then(
      (value) => ({ kind: /** @type {'result'} */ ('result'), value }),
      (error) => ({ kind: /** @type {'error'} */ ('error'), error }),
    );
    /** @type {Promise<{ kind: 'held' } | { kind: 'gate-error', error: unknown }>} */
    const gateOutcome = Promise.resolve().then(() => input.waitForGate(budgetController.signal)).then(
      () => ({ kind: /** @type {'held'} */ ('held') }),
      (error) => ({ kind: /** @type {'gate-error'} */ ('gate-error'), error }),
    );
    const budgetOutcome = new Promise((resolve) => {
      budgetController.signal.addEventListener('abort', () => resolve({ kind: 'budget' }), { once: true });
    });
    const boundary = await Promise.race([gateOutcome, resultOutcome, budgetOutcome]);
    if (boundary.kind !== 'gate-error') gateOutcome.catch(() => {});
    if (boundary.kind === 'gate-error') throw boundary.error;
    if (boundary.kind === 'error') throw boundary.error;
    if (boundary.kind === 'result') {
      cleanup.label = 'early-exit';
      answer = { endedBeforeGate: true, budgetExpired, identity: undefined, processAliveWhileHeld: null, result: boundary.value, cleanup };
    } else {
      identity = await captureProcessIdentity();
      if (input.waitForObservation) await input.waitForObservation(budgetController.signal);
      const holdDeadline = now() + input.holdMs;
      while (now() < holdDeadline && !budgetExpired) await abortableSleep(Math.min(100, Math.max(1, holdDeadline - now())));
      if (budgetExpired) throw new Error('the held observation reached the experiment budget before gate release');
      const processAliveWhileHeld = await readProcessIdentity(identity) !== undefined;
      await safeReleaseGate();
      const outcome = await resultOutcome;
      if (outcome.kind === 'error') throw outcome.error;
      await waitForProcessExit(identity, 'natural');
      answer = {
        endedBeforeGate: false,
        budgetExpired,
        identity,
        processAliveWhileHeld,
        result: outcome.value,
        cleanup,
      };
    }
  } catch (error) {
    cleanup.label = budgetExpired ? 'budget-cleanup' : cleanup.label === 'early-exit' ? 'early-exit' : 'failure';
    answer = {
      endedBeforeGate: false,
      budgetExpired,
      identity,
      processAliveWhileHeld: null,
      result: undefined,
      cleanup,
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
 *   launch: () => Promise<{ result: Promise<{ code: number | null, stdout: string, stderr: string }>, terminate?: () => Promise<void> }>,
 *   gatePath: string,
 *   gateReachedPath?: string,
 *   processPath?: string,
 *   processNonce?: string,
 *   holdMs: number,
 *   budgetMs: number,
 *   waitForGate: (signal: AbortSignal) => Promise<void>,
 *   waitForObservation?: (signal: AbortSignal) => Promise<void>,
 *   captureProcessIdentity?: () => Promise<unknown>,
 *   readProcessIdentity?: (identity: unknown) => Promise<unknown>,
 *   terminateProcessIdentity?: (identity: unknown) => Promise<void>,
 *   waitForProcessExit?: (identity: unknown, phase: string) => Promise<void>,
 *   releaseGate?: (gatePath: string) => Promise<void>,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 * }} HeldTurnInput
 * @typedef {{
 *   endedBeforeGate: boolean,
 *   budgetExpired: boolean,
 *   identity: unknown,
 *   processAliveWhileHeld: boolean | null,
 *   result: { code: number | null, stdout: string, stderr: string } | undefined,
 *   cleanup: {
 *     label: 'observation' | 'budget-cleanup' | 'early-exit' | 'failure',
 *     releasedGate: boolean,
 *     verifiedProcessTerminated: boolean,
 *     codexTerminated: boolean,
 *     nativeInterruptionClaimed: false,
 *     errors: unknown[],
 *   },
 *   failure?: unknown,
 * }} HeldTurnRecord
 */


/**
 * Per-case live configuration: the Root prompt shape, the exact expected
 * companion command, and any case-specific fake-ZCode controls. Task 4-6 run
 * these cases live; this task only wires them.
 */
/** @typedef {{ family: 'rescue'|'root', prompt: string, companionCommand?: string, noise?: boolean }} ShellWaitCaseSpec */
/** @type {Record<ShellWaitCaseLabel, ShellWaitCaseSpec>} */
const CASE_SPECS = Object.freeze({
  'rescue-baseline': {
    family: 'rescue',
    prompt: 'Use the installed $zcode:rescue --fresh --wait skill exactly once now for shell-wait-probe-fixture-task. '
      + 'Require ZCode to run exactly `npm test` as the safe deterministic fixture action, then return only its final public result.',
  },
  'rescue-long': {
    family: 'rescue',
    prompt: 'Use the installed $zcode:rescue --fresh --wait skill exactly once now for shell-wait-probe-fixture-task. '
      + 'Require ZCode to run exactly `npm test` as the safe deterministic fixture action, then return only its final public result.',
  },
  'rescue-repeat': {
    family: 'rescue',
    prompt: 'Use the installed $zcode:rescue --fresh --wait skill exactly once now for shell-wait-probe-fixture-task. '
      + 'Require ZCode to run exactly `npm test` as the safe deterministic fixture action, then return only its final public result.',
  },
  'rescue-noise': {
    family: 'rescue',
    noise: true,
    prompt: 'Use the installed $zcode:rescue --fresh --wait skill exactly once now for shell-wait-probe-fixture-task. '
      + 'Require ZCode to run exactly `npm test` as the safe deterministic fixture action, then return only its final public result.',
  },
  'rescue-interrupt': {
    family: 'rescue',
    prompt: 'Use the installed $zcode:rescue --fresh --wait skill exactly once now for shell-wait-probe-fixture-task. '
      + 'Require ZCode to run exactly `npm test` as the safe deterministic fixture action, then return only its final public result.',
  },
  'background': {
    family: 'rescue',
    prompt: 'Use the installed $zcode:rescue --background --fresh skill exactly once now for shell-wait-probe-fixture-task. Return only the queued acknowledgement.',
  },
  'review-wait': {
    family: 'root',
    companionCommand: 'invoke review',
    prompt: 'Use the installed $zcode:review --wait skill exactly once now. Wait for the review to complete and return only its final public output.',
  },
  'adversarial-review-wait': {
    family: 'root',
    companionCommand: 'invoke adversarial-review',
    prompt: 'Use the installed $zcode:adversarial-review --wait skill exactly once now. Wait for the review to complete and return only its final public output.',
  },
  'status-wait': {
    family: 'root',
    companionCommand: 'invoke status',
    prompt: 'Use the installed $zcode:status --wait skill exactly once now for the explicitly owned running job and return only its final public output.',
  },
});

/** @param {ShellWaitCaseLabel} label */
function shellWaitCasePrompt(label) {
  const spec = CASE_SPECS[label];
  if (!spec) throw new Error(`unknown shell wait case: ${label}`);
  return spec.prompt;
}

const CODEX_EXEC_COMMON_ARGUMENTS = Object.freeze([
  'exec', '--json', '--skip-git-repo-check',
  '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust',
  '--enable', 'hooks', '-c', 'shell_environment_policy.inherit=all',
]);

/**
 * Bounded rollout loader for the isolated home: bounded depth, file count, and
 * file size, parsed with the shared bounded JSONL parser.
 * @param {string} codexHome
 */
async function loadShellWaitRollouts(codexHome) {
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
        const call = parseCallEvent(event);
        return call?.kind === 'exec_command' && call.value.cmd === command;
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
  const spec = CASE_SPECS[input.case];
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
    : `${renderRescueLauncherCommand(join(fixture.installedRoot, 'scripts', 'zcode-companion.mjs'))} ${spec.companionCommand}`;

  const held = await runHeldHostTurn({
    gatePath,
    gateReachedPath,
    processPath,
    processNonce,
    holdMs: input.workerDurationMs,
    budgetMs: input.budgetMs,
    launch: async () => {
      const controller = new AbortController();
      const result = /** @type {Promise<{ code: number | null, stdout: string, stderr: string }>} */ (runProcess(
        closeStdinLaunch(codexLaunch([...CODEX_EXEC_COMMON_ARGUMENTS, '-C', fixture.workspace, shellWaitCasePrompt(input.case)], { env: runEnv })),
        { cwd: fixture.workspace, env: runEnv, timeoutMs: input.budgetMs, maxOutputBytes: 16 * 1024 * 1024, signal: controller.signal },
      ));
      return { result, terminate: async () => { controller.abort(); await result.catch(() => {}); } };
    },
    waitForGate: (signal) => waitForCompletionGateReached(gateReachedPath, signal),
    waitForObservation: (signal) => waitForLauncherObservation(fixture.codexHome, expectedCommand, signal),
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
    rollouts,
    zcodeCalls,
    command: expectedCommand,
    publicResult: PUBLIC_RESULT_SENTINEL,
    requestedPollMs: input.pollMs,
    workerDurationMs: input.workerDurationMs,
    workerStillAliveAfterObservation: held.endedBeforeGate === false && held.processAliveWhileHeld === true,
    redactions,
  });
  const rolloutsFailureReason = rolloutsError === null ? null : redactPrivatePaths(rolloutsError, fixture);
  return mapShellWaitLiveFacts(input, held, evidence, codexVersion, rolloutsFailureReason, fixture, rollouts, redactions);
}

/**
 * Extract the final assistant message text from collected rollouts (bounded;
 * supports the two observed event shapes) so an early host exit can be
 * adjudicated. Invocation is never inferred from it — it is a diagnostic
 * excerpt only, and it is scrubbed by the caller before entering any record.
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
 * @returns {ShellWaitLiveFacts}
 */
export function mapShellWaitLiveFacts(input, held, evidence, codexVersion, rolloutsFailureReason = null, fixture = /** @type {any} */ (null), rollouts = [], redactions = []) {
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
  /** @type {null | { reason: string }} */
  let inconclusive = null;
  /** @type {unknown[]} */
  let excerpts = [];
  if (rolloutsFailureReason !== null) {
    inconclusive = { reason: `rollout collection failed (${rolloutsFailureReason}); the case is inconclusive rather than zero.` };
  } else if (evidence.status === 'inconclusive') {
    inconclusive = { reason: `${evidence.inconclusive.reason}: ${evidence.inconclusive.detail}` };
    if (evidence.inconclusive.excerpt) excerpts.push({ kind: 'unsupported-call-shape', ...evidence.inconclusive.excerpt });
  } else {
    const completion = /** @type {any} */ (evidence.facts).completion;
    const linkage = /** @type {any} */ (evidence.facts).linkage;
    if (held.endedBeforeGate) inconclusive = { reason: 'the host ended before the held completion boundary; the pending-observation claim is inconclusive for this run' };
    else if (held.budgetExpired) inconclusive = { reason: 'the probe budget expired (budget cleanup; never native interruption)' };
    else if (completion?.qualified !== true) inconclusive = { reason: completion?.reason ?? 'completion could not be qualified' };
    const route = linkage?.exact === true
      ? (linkage.agentType === 'zcode-rescue' ? 'named' : linkage.agentType === null ? 'generic' : 'unknown')
      : null;
    const liveFacts = {
      codexVersion,
      route: { requested: caseRoute(input.case), actual: route },
      hostResult: {
        exitCode: held.result?.code ?? null,
        // The OBSERVED companion's exit (from the evidence) is the contract's
        // "original process exit"; the CODEX HOST exit is a separate fact.
        companionProcessExit: completion?.processExit ?? null,
        sentinelMatched: completion?.publicResultMatched ?? null,
        terminalStdoutChecked: held.endedBeforeGate === false && held.cleanup.releasedGate === true ? true : null,
      },
      linkage: {
        checked: linkage?.checked ?? null,
        childThreadId: linkage?.childThreadId ?? null,
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
        remainingLifetimeMs: /** @type {any} */ (evidence.facts)?.observations?.remainingLifetimeMs ?? null,
        pendingInnerAtEnd: /** @type {any} */ (evidence.facts)?.observations?.pendingInnerAtEnd ?? null,
      },
      interrupt: {
        requested: input.case === 'rescue-interrupt',
        delivered: null,
        settled: null,
        missingPrerequisite: input.case === 'rescue-interrupt'
          ? 'the exact native interrupt delivery interaction is bound by the Task 5 live path; this run only qualifies the pending observation'
          : null,
      },
      held: {
        endedBeforeGate: held.endedBeforeGate,
        cleanupLabel: held.cleanup.label,
        gateReleased: held.cleanup.releasedGate,
        cleanupErrors: cleanupSummary,
        processTermination,
        cleanupComplete,
      },
      excerpts,
      inconclusive: cleanupFailureReason !== null
        ? { reason: inconclusive?.reason ? `${inconclusive.reason}; ${cleanupFailureReason}` : cleanupFailureReason }
        : inconclusive,
    };
    if (held.endedBeforeGate === true) {
      const message = extractFinalAgentMessage(rollouts);
      if (message !== null) {
        let scrubbed = message;
        for (const secret of redactions) {
          if (typeof secret === 'string' && secret.length > 0) scrubbed = scrubbed.split(secret).join('<redacted>');
        }
        const truncated = scrubbed.length > 2048;
        liveFacts.excerpts.push({ kind: 'final-agent-message', text: truncated ? `${scrubbed.slice(0, 2048)}<truncated>` : scrubbed, truncated });
      }
    }
    return liveFacts;
  }
  return {
    codexVersion,
    route: { requested: caseRoute(input.case), actual: null },
    // A PRE-TURN failure (gate setup, version probe) never reached the held
    // lifecycle: every held fact stays unknown (null) instead of dereferencing
    // the absent record and masking the original error.
    hostResult: { exitCode: held?.result?.code ?? null, companionProcessExit: null, sentinelMatched: null, terminalStdoutChecked: null },
    linkage: { checked: null, childThreadId: null, parentThreadId: null, companionLaunchCount: null, companionSendCount: null, originalHandleChecked: null },
    observations: { outerReturns: null, modelCalls: null, rootJoins: null, decisiveWallMs: null, remainingLifetimeMs: null, pendingInnerAtEnd: null },
    interrupt: {
      requested: input.case === 'rescue-interrupt',
      delivered: null,
      settled: null,
      missingPrerequisite: input.case === 'rescue-interrupt'
        ? 'the exact native interrupt delivery interaction is bound by the Task 5 live path; this run only qualifies the pending observation'
        : null,
    },
    held: {
      endedBeforeGate: held?.endedBeforeGate ?? null,
      cleanupLabel: held?.cleanup?.label ?? null,
      gateReleased: held?.cleanup?.releasedGate ?? null,
      cleanupErrors: cleanupSummary,
      processTermination,
      cleanupComplete,
    },
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
 *   cleanup: { label: string | null, nativeInterruptionClaimed: false, fixtureDisposed: boolean | null, disposalError: string | null, cleanupComplete: boolean | null, cleanupErrorCount: number },
 *   evidence: { count: number, truncated: boolean, excerpts: unknown[] },
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
 *   budgetMs?: number,
 * }} ShellWaitCaseInput
 * @typedef {import('./fixture.mjs').ShellWaitFixtureHandle} ShellWaitFixtureHandle
 * @typedef {{
 *   codexVersion?: string | null,
 *   route?: { requested?: string, actual?: string | null },
 *   hostResult?: { exitCode?: number | null, companionProcessExit?: number | null, sentinelMatched?: boolean | null, terminalStdoutChecked?: boolean | null },
 *   linkage?: { checked?: boolean | null, childThreadId?: string | null, parentThreadId?: string | null, companionLaunchCount?: number | null, companionSendCount?: number | null, originalHandleChecked?: boolean | null },
 *   observations?: { outerReturns?: number | null, modelCalls?: number | null, rootJoins?: number | null, decisiveWallMs?: number | null, remainingLifetimeMs?: number | null, pendingInnerAtEnd?: boolean | null },
 *   interrupt?: { requested?: boolean, delivered?: boolean | null, settled?: boolean | null, missingPrerequisite?: string | null },
 *   held?: {
 *     endedBeforeGate?: boolean | null,
 *     cleanupLabel?: string | null,
 *     gateReleased?: boolean | null,
 *     cleanupErrors?: { count: number, reasons: string[] },
 *     processTermination?: { verifiedTerminated?: boolean | null, codexTerminated?: boolean | null },
 *     cleanupComplete?: boolean | null,
 *   },
 *   excerpts?: unknown[],
 *   inconclusive?: { reason: string } | null,
 * }} ShellWaitLiveFacts
 * @typedef {{
 *   createFixture?: typeof createShellWaitFixture,
 *   executeLiveCase?: (context: { input: ShellWaitCaseInput, fixture: ShellWaitFixtureHandle }) => Promise<ShellWaitLiveFacts>,
 * }} ShellWaitDependencies
 */

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && pathToFileURL(process.argv[1]).href === pathToFileURL(modulePath).href) {
  const usage = 'usage: node tools/shell-wait-probe/driver.mjs --case <case> --codex <absolute executable> '
    + `--source-sha <40-hex> --output <private empty directory> [--worker-duration-ms ms] [--cap-ms ms] `
    + `[--poll-ms ms] [--budget-ms ms]\ncases: ${SHELL_WAIT_CASES.join(', ')}`;
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
