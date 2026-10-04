// @ts-check
/**
 * Small case runner for the disposable wait-route probe. One selected case
 * per invocation against an exact Codex binary, inside a private output
 * directory, under a bounded observation/cleanup budget (`--budget-ms` is the
 * probe's own observation and cleanup bound — NEVER a production job
 * timeout). It never substitutes a second app-server process for the session
 * under test and never launches real ZCode provider tasks.
 *
 * Every host command runs under a hard deadline, and cleanup never signals a
 * process whose identity it could not verify. The printed summary is a
 * bounded, redacted JSON object: private paths, prompts, and host error text
 * never reach stdout.
 */
import { spawn, spawnSync } from 'node:child_process';
import { constants as fsConstants, open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, opendir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMPLETION_MARKER,
  MARKETPLACE_NAME,
  PLUGIN_SELECTOR,
  SYNTHETIC_ROLE_NAME,
  WORKER_FILE_NAME,
  buildWaitRouteFixture,
  buildWaitRouteSyntheticRole,
  errorCode,
  fixtureError,
  readFixtureWorker,
  writeFixtureConfig,
} from './fixture.mjs';
import {
  appendTraceEvent,
  captureProcessIdentity,
  fingerprintProcessIdentity,
  readTraceEvents,
  resolveProcessInspectionExecutable,
} from './server.mjs';

/** The documented case labels; the runner accepts exactly these. */
export const CASE_LABELS = Object.freeze(['shell-window', 'hook-entry', 'authority', 'lifecycle', 'role-control', 'hook-hold']);
/** The hook-hold case shapes (Task 4): the trusted hold, its controls, the ordering probe, and the timeout probe. */
export const HOOK_SHAPES = Object.freeze(['hold', 'untrusted', 'disabled', 'unavailable', 'ordering', 'timeout']);
/** The custom-tool wrappers whose DSL input is EXECUTED as code (the observed installed shapes); other custom tools' input is data. */
export const WRAPPER_TOOL_NAMES = Object.freeze(['exec', 'shell']);
export const BUDGET_MIN_MS = 1_000;
export const BUDGET_MAX_MS = 3_600_000;
/** Cleanup always keeps at least this floor so a case never leaks owned state. */
export const CLEANUP_FLOOR_MS = 5_000;
/**
 * Task 3 shell-profile bounds. The yield ranges mirror the source-pinned
 * runtime clamps (initial exec [250, 30000]; empty polls [5000, configured
 * cap]) — a requested yield OUTSIDE the runtime clamp is exactly what the
 * requested-versus-actual comparison observes, so the ranges here only guard
 * instrument sanity up to the demonstrated 3600000 ceiling.
 */
export const PROFILE_WORKER_DURATION_MAX_MS = 3_600_000;
export const PROFILE_NOISE_INTERVAL_MAX_MS = 60_000;
export const PROFILE_EXEC_YIELD_MIN_MS = 250;
export const PROFILE_POLL_YIELD_MIN_MS = 5_000;
export const PROFILE_CAP_MIN_MS = 5_000;
export const PROFILE_CAP_MAX_MS = 3_600_000;
/** Session-rollout summarizer bounds (bounded counting, never full retention). */
export const SESSION_MAX_FILES = 16;
export const SESSION_MAX_RECORDS_PER_FILE = 20_000;
export const SESSION_MAX_LINE_BYTES = 1024 * 1024;
export const SESSION_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const SESSION_MAX_YIELD_SAMPLES = 64;
/** Discovery-entry cap for the model-writable sessions tree (files+dirs the walk may inspect). */
export const SESSION_MAX_DISCOVERY_ENTRIES = 512;
/** Per-call operation-site cap: hostile scripts with thousands of awaited polls would make per-pair serialization scans quadratic; beyond the cap the scan reports truncation (fail closed). */
export const SESSION_MAX_SITES_PER_CALL = 512;
const SUBPROCESS_DEADLINE_MS = 15_000;
/** Bounded grace for verifying and settling recorded shell workers. */
const WORKER_EXIT_GRACE_MS = 2_000;
/** Bounded drain: resolve a finished subprocess at most this long after its deadline even if inherited pipes stay open. */
const SUBPROCESS_DRAIN_GRACE_MS = 4_000;
const HOST_STDOUT_MAX_BYTES = 4 * 1024 * 1024;
const HOST_STDERR_MAX_BYTES = 256 * 1024;
const SERVER_EXIT_VERIFY_GRACE_MS = 3_000;
const SERVER_EXIT_POLL_MS = 200;
const MAXIMUM_WORKER_LAUNCH_RECORDS = 64;
/** Per-record byte bound for the worker launch log (same discipline as the trace reader). */
const WORKER_LAUNCH_MAX_RECORD_BYTES = 64 * 1024;
/** Total byte budget for one launch-log read. */
const WORKER_LAUNCH_MAX_TOTAL_BYTES = 1024 * 1024;
const EXEC_BASE_FLAGS = Object.freeze(['exec', '--json', '--color', 'never', '--skip-git-repo-check']);
const EPHEMERAL_FLAG = Object.freeze(['--ephemeral']);
const HOOK_ONLY_FLAGS = Object.freeze(['--dangerously-bypass-hook-trust']);
/**
 * Per-case sandbox/approval flag selections, exported as a pinned seam.
 *
 * The shell cases (`shell-window`, `role-control`) run with
 * `--dangerously-bypass-approvals-and-sandbox` INSTEAD of
 * `-s workspace-write`: the installed 0.160.0 workspace-write sandbox denies
 * `/bin/ps` (exit 126), which structurally removes the fixture worker's
 * process-identity evidence and therefore the instrument's owned-cleanup
 * guarantee. The measured variable is the host's configured observation
 * window (a process-manager clamp), which does not depend on the sandbox.
 * This choice is recorded in the qualification report as a provenance note.
 * The hook-entry case keeps its exact Task 2 flag set.
 */
export const EXEC_FLAG_SELECTIONS = Object.freeze({
  shell: Object.freeze(['--dangerously-bypass-approvals-and-sandbox']),
  hookEntry: Object.freeze(['-s', 'workspace-write']),
});
const HOOK_ENTRY_PROMPT = 'Reply with exactly: ok';

/**
 * @typedef {Object} WaitRouteSummary
 * @property {string} probe
 * @property {string} caseLabel
 * @property {string|null} codexVersion
 * @property {string} outcome
 * @property {string} reason
 * @property {string} stage
 * @property {{state: string, code: number|null}} hostExit
 * @property {string[]} hostFlags
 * @property {{serverStarted: boolean, handlerEntered: boolean, handlerCompleted: boolean, handlerCompletedAtMs: number|null, markerObserved: boolean|null, workerLaunches: number|null, possibleDuplicateLaunch: boolean|null, workerLaunchAtMs: number|null, events: number, truncated: boolean, serverParentOfHost: string|null}} trace
 * @property {{backgroundTerminalMaxTimeoutMs: number|null, multiAgentFeature: boolean, agentRoles: string[]}} fixture
 * @property {{workerDurationMs: number, workerNoiseIntervalMs: number, execYieldMs: number, pollYieldMs: number}} requestedProfile
 * @property {SessionSummary|null} session
 * @property {{shape: string, holdMs: number, hookTimeoutSec: number, toolTimeoutSec: number, dispatches: number, enteredAtMs: number|null, settledAtMs: number|null, settlement: string|null, effectiveHoldMs: number|null, effectiveBoundMs: number|null, interruptedAfterMs: number|null, interruptSignalAtMs: number|null, decisionsDuringHold: number|null, firstDecisionAtMs: number|null, overlappingDispatches: boolean|null}|undefined} [hook]
 * @property {{marketplaceRemoved: boolean, isolatedHomeRemoved: boolean, serverExit: string, workerExit: string, failures: string[]}} cleanup
 * @property {number} budgetMs
 */

/** @param {string} code @param {string} message */
function driverError(code, message) {
  return fixtureError(code, message);
}

/** @param {string} message */
function usageError(message) {
  return driverError('WAIT_ROUTE_DRIVER_USAGE_INVALID', message);
}

/**
 * Validates the Task 3 shell-profile inputs (worker duration/noise, requested
 * shell-tool yields, fixture-only cap) with closed codes. Absent flags stay 0
 * (= the current behavior); the case labels that cannot carry a profile
 * reject any nonzero profile value.
 * @param {{workerDurationMs?: number, workerNoiseIntervalMs?: number, execYieldMs?: number, pollYieldMs?: number, backgroundTerminalMaxTimeoutMs?: number}} profile
 * @param {string} caseLabel
 * @returns {{workerDurationMs: number, workerNoiseIntervalMs: number, execYieldMs: number, pollYieldMs: number, backgroundTerminalMaxTimeoutMs: number}}
 */
export function validateShellProfile(profile, caseLabel) {
  /** @param {number|undefined} value @param {number} minimum @param {number} maximum @param {string} name */
  const bounded = (value, minimum, maximum, name) => {
    const raw = value ?? 0;
    if (!Number.isSafeInteger(raw) || raw < minimum || raw > maximum) {
      throw driverError('WAIT_ROUTE_DRIVER_PROFILE_INVALID', `${name} must be an integer of ${minimum} to ${maximum} ms.`);
    }
    return raw;
  };
  const normalized = {
    workerDurationMs: bounded(profile.workerDurationMs, 0, PROFILE_WORKER_DURATION_MAX_MS, '--worker-duration-ms'),
    workerNoiseIntervalMs: bounded(profile.workerNoiseIntervalMs, 0, PROFILE_NOISE_INTERVAL_MAX_MS, '--worker-noise-interval-ms'),
    execYieldMs: bounded(profile.execYieldMs, 0, PROFILE_CAP_MAX_MS, '--exec-yield-ms'),
    pollYieldMs: bounded(profile.pollYieldMs, 0, PROFILE_CAP_MAX_MS, '--poll-yield-ms'),
    backgroundTerminalMaxTimeoutMs: bounded(profile.backgroundTerminalMaxTimeoutMs, 0, PROFILE_CAP_MAX_MS, '--background-terminal-max-timeout-ms'),
  };
  if (normalized.execYieldMs !== 0 && normalized.execYieldMs < PROFILE_EXEC_YIELD_MIN_MS) {
    throw driverError('WAIT_ROUTE_DRIVER_PROFILE_INVALID', `--exec-yield-ms must be 0 or at least ${PROFILE_EXEC_YIELD_MIN_MS} ms.`);
  }
  if (normalized.pollYieldMs !== 0 && normalized.pollYieldMs < PROFILE_POLL_YIELD_MIN_MS) {
    throw driverError('WAIT_ROUTE_DRIVER_PROFILE_INVALID', `--poll-yield-ms must be 0 or at least ${PROFILE_POLL_YIELD_MIN_MS} ms.`);
  }
  if (normalized.backgroundTerminalMaxTimeoutMs !== 0 && normalized.backgroundTerminalMaxTimeoutMs < PROFILE_CAP_MIN_MS) {
    throw driverError('WAIT_ROUTE_DRIVER_PROFILE_INVALID', `--background-terminal-max-timeout-ms must be 0 or at least ${PROFILE_CAP_MIN_MS} ms.`);
  }
  if (normalized.workerNoiseIntervalMs > 0 && normalized.workerDurationMs === 0) {
    throw driverError('WAIT_ROUTE_DRIVER_PROFILE_INVALID', '--worker-noise-interval-ms requires a positive --worker-duration-ms.');
  }
  if ((normalized.workerDurationMs !== 0 || normalized.workerNoiseIntervalMs !== 0 || normalized.execYieldMs !== 0 || normalized.pollYieldMs !== 0 || normalized.backgroundTerminalMaxTimeoutMs !== 0)
    && caseLabel !== 'shell-window' && caseLabel !== 'role-control') {
    throw driverError('WAIT_ROUTE_DRIVER_PROFILE_INVALID', 'profile flags apply only to the shell-window and role-control cases.');
  }
  return normalized;
}

/**
 * Parses the driver arguments. The four documented flags are required; the
 * Task 3 profile flags are optional and validated with closed codes.
 * @param {string[]} argv
 * @returns {{caseLabel: string, codexPath: string, outputDir: string, budgetMs: number, workerDurationMs: number, workerNoiseIntervalMs: number, execYieldMs: number, pollYieldMs: number, backgroundTerminalMaxTimeoutMs: number, hookShape: string, hookHoldMs: number, hookTimeoutSec: number, hookToolTimeoutSec: number, interruptAfterMs: number}}
 */
export function parseDriverArguments(argv) {
  /** @type {Record<string, string>} */
  const parsed = {};
  const valueFlags = new Set([
    '--case', '--codex', '--output-dir', '--budget-ms',
    '--worker-duration-ms', '--worker-noise-interval-ms', '--exec-yield-ms', '--poll-yield-ms', '--background-terminal-max-timeout-ms',
    '--hook-shape', '--hook-hold-ms', '--hook-timeout-sec', '--hook-tool-timeout-sec', '--interrupt-after-ms',
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !flag.startsWith('--') || !value || value.startsWith('--')) {
      throw usageError('usage: driver.mjs --case <shell-window|hook-entry|authority|lifecycle|role-control> --codex <path> --output-dir <dir> --budget-ms <ms> [--worker-duration-ms ms] [--worker-noise-interval-ms ms] [--exec-yield-ms ms] [--poll-yield-ms ms] [--background-terminal-max-timeout-ms ms]');
    }
    if (flag in parsed) throw usageError(`duplicate ${flag}`);
    if (!valueFlags.has(flag)) throw usageError(`unknown ${flag}`);
    parsed[flag] = value;
  }
  if (!parsed['--case'] || !parsed['--codex'] || !parsed['--output-dir'] || !parsed['--budget-ms']) {
    throw usageError('usage: driver.mjs --case <shell-window|hook-entry|authority|lifecycle|role-control> --codex <path> --output-dir <dir> --budget-ms <ms>');
  }
  if (!CASE_LABELS.includes(parsed['--case'])) throw usageError(`--case must be one of: ${CASE_LABELS.join(', ')}`);
  if (!isAbsolute(parsed['--codex'])) throw driverError('WAIT_ROUTE_DRIVER_CODEX_RELATIVE', '--codex must be an absolute path.');
  if (!isAbsolute(parsed['--output-dir'])) throw driverError('WAIT_ROUTE_DRIVER_OUTPUT_RELATIVE', '--output-dir must be an absolute path.');
  const budgetMs = Number(parsed['--budget-ms']);
  if (!Number.isSafeInteger(budgetMs) || budgetMs < BUDGET_MIN_MS || budgetMs > BUDGET_MAX_MS) {
    throw driverError('WAIT_ROUTE_DRIVER_BUDGET_INVALID', `--budget-ms must be an integer of ${BUDGET_MIN_MS} to ${BUDGET_MAX_MS}.`);
  }
  const profile = validateShellProfile({
    workerDurationMs: parsed['--worker-duration-ms'] === undefined ? 0 : Number(parsed['--worker-duration-ms']),
    workerNoiseIntervalMs: parsed['--worker-noise-interval-ms'] === undefined ? 0 : Number(parsed['--worker-noise-interval-ms']),
    execYieldMs: parsed['--exec-yield-ms'] === undefined ? 0 : Number(parsed['--exec-yield-ms']),
    pollYieldMs: parsed['--poll-yield-ms'] === undefined ? 0 : Number(parsed['--poll-yield-ms']),
    backgroundTerminalMaxTimeoutMs: parsed['--background-terminal-max-timeout-ms'] === undefined ? 0 : Number(parsed['--background-terminal-max-timeout-ms']),
  }, parsed['--case']);
  // Task 4 hook-hold shape options (defaults keep the single-flag shape).
  const hookShape = parsed['--hook-shape'] ?? 'hold';
  if (!HOOK_SHAPES.includes(hookShape)) throw driverError('WAIT_ROUTE_DRIVER_HOOK_SHAPE_INVALID', `--hook-shape must be one of: ${HOOK_SHAPES.join(', ')}.`);
  const hookHoldMs = parsed['--hook-hold-ms'] === undefined ? 2_000 : Number(parsed['--hook-hold-ms']);
  if (!Number.isSafeInteger(hookHoldMs) || hookHoldMs < 1_000 || hookHoldMs > 180_000) {
    throw driverError('WAIT_ROUTE_DRIVER_HOOK_HOLD_INVALID', '--hook-hold-ms must be an integer of 1000 to 180000.');
  }
  const hookTimeoutSec = parsed['--hook-timeout-sec'] === undefined ? 15 : Number(parsed['--hook-timeout-sec']);
  if (!Number.isSafeInteger(hookTimeoutSec) || hookTimeoutSec < 1 || hookTimeoutSec > 600) {
    throw driverError('WAIT_ROUTE_DRIVER_HOOK_TIMEOUT_INVALID', '--hook-timeout-sec must be an integer of 1 to 600.');
  }
  const hookToolTimeoutSec = parsed['--hook-tool-timeout-sec'] === undefined ? 30 : Number(parsed['--hook-tool-timeout-sec']);
  if (!Number.isSafeInteger(hookToolTimeoutSec) || hookToolTimeoutSec < 2 || hookToolTimeoutSec > 300) {
    throw driverError('WAIT_ROUTE_DRIVER_HOOK_TOOL_TIMEOUT_INVALID', '--hook-tool-timeout-sec must be an integer of 2 to 300.');
  }
  const interruptAfterMs = parsed['--interrupt-after-ms'] === undefined ? 0 : Number(parsed['--interrupt-after-ms']);
  if (!Number.isSafeInteger(interruptAfterMs) || interruptAfterMs < 0 || interruptAfterMs > 600_000) {
    throw driverError('WAIT_ROUTE_DRIVER_INTERRUPT_INVALID', '--interrupt-after-ms must be an integer of 0 to 600000.');
  }
  return { caseLabel: parsed['--case'], codexPath: parsed['--codex'], outputDir: parsed['--output-dir'], budgetMs, ...profile, hookShape, hookHoldMs, hookTimeoutSec, hookToolTimeoutSec, interruptAfterMs };
}

/**
 * Bounded sleep. The timer is intentionally ref'ed: during cleanup these
 * waits are often the only pending work, and an unref'ed timer would let the
 * event loop drain and kill the driver before cleanup completes.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, Math.max(1, ms));
  });
}

/**
 * Signals the child's WHOLE process group on POSIX: the host session owns
 * descendants (an MCP server, a shell-launched worker), and killing only the
 * direct child would orphan them. The child is spawned detached, so its pid
 * is its own process group id; on win32 only the direct child is signaled.
 * @param {import('node:child_process').ChildProcess} child @param {NodeJS.Signals} signalName
 */
function signalOwnedGroup(child, signalName) {
  if (child.pid && child.pid > 0 && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signalName);
      return;
    } catch { /* the group is already gone */ }
  }
  try { child.kill(signalName); } catch { /* already gone */ }
}

/**
 * ONE-CASE-PER-PROCESS INVARIANT: every registry below — ownedGroups,
 * groupDeadlineFires, ownedGroupTimers, ownedGroupEvidence,
 * ownedChildHandles, and the attestedWorkerPids set declared beside
 * settleOwnedGroups — is process-global and deliberately has NO per-case
 * reset. The driver's contract is exactly one case per process: the CLI
 * entry runs a single selected case and exits, so accumulated ownership
 * state always belongs to that one case. Nothing may run a second case in
 * the same process.
 */

/**
 * The process groups this driver process spawned and still owns (positive
 * group ids; the signal target is the negative pid). An entry survives the
 * group LEADER's exit: a shell-launched descendant may still be running, and
 * the interrupt path and case cleanup settle survivors through this registry.
 * @type {Set<number>}
 */
const ownedGroups = new Set();

/**
 * How many deadline kills have actually been delivered. Bounded observability
 * for the stale-timer guarantee: a late timer fire over a settled or
 * forgotten group is observation bookkeeping only and must never deliver a
 * signal — so a settled group id can never be signaled by a stale timer.
 * @type {number}
 */
let groupDeadlineFires = 0;

/** @returns {number} how many group-deadline timers have fired so far. */
export function groupDeadlineFireCount() {
  return groupDeadlineFires;
}

/**
 * Whether any process may still be running inside a tracked group.
 * @param {number} groupPid
 */
function isGroupAlive(groupPid) {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-groupPid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === 'EPERM') return true;
    return false;
  }
}

/**
 * Signals one tracked group; returns whether a kill was delivered. The
 * negative-pid target reaches survivors even after the leader exited; a
 * positive-pid fallback only applies when the group exists but the caller
 * may not signal it as a group.
 * @param {number} groupPid @param {NodeJS.Signals} signalName
 */
function signalGroup(groupPid, signalName) {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-groupPid, signalName);
    return true;
  } catch (error) {
    if (errorCode(error) === 'EPERM') {
      try {
        process.kill(groupPid, signalName);
        return true;
      } catch { /* gone */ }
    }
    return false;
  }
}

/**
 * The armed deadline timers of owned groups, each carrying a probe for
 * whether that subprocess's observation has already completed. A group's
 * timer is retained with its ownership entry; forgetting an entry whose
 * observation has COMPLETED clears the timer (nothing left to record), while
 * an entry with an OPEN observation keeps its timer armed as a pure
 * observation timer — its fire records the expired observation honestly and
 * the kill decision stays evidence-gated, so a settled group id can never be
 * SIGNALed by a stale timer.
 * @type {Map<number, {timer: NodeJS.Timeout, observationComplete: () => boolean}>}
 */
const ownedGroupTimers = new Map();

/**
 * @typedef {Object} WorkerGroupEvidence
 * @property {'worker'} kind
 * @property {Record<string, unknown>} record
 * @typedef {Object} LeaderGroupEvidence
 * @property {'leader'} kind
 * @property {number} processId
 * @property {string} token
 * @typedef {Object} MemberStartToken
 * @property {number} processId
 * @property {string} startTime
 * @typedef {Object} MembersGroupEvidence
 * @property {'members'} kind
 * @property {MemberStartToken[]} members
 */

/**
 * Retained ownership EVIDENCE for registered groups, revalidated at the
 * signaling boundary so a group whose evidence no longer validates is never
 * signaled:
 *
 * - `{kind: 'worker'}` — the launch record whose validation created a
 *   worker-group entry (a group the driver never spawned a leader into).
 * - `{kind: 'leader'}` — the spawned host leader's start token, captured at
 *   spawn (the driver owns that child directly).
 * - `{kind: 'members'}` — the surviving members of a spawned-host group,
 *   enumerated and token-captured once at the leader's exit, so original
 *   descendants stay settleable while a group id that was fully recycled to
 *   unrelated processes is refused.
 *
 * Spawned-host ownership is INDEPENDENT of worker evidence: a worker record
 * sharing the host's group id never overwrites or drops the host entry.
 * @type {Map<number, (WorkerGroupEvidence|LeaderGroupEvidence|MembersGroupEvidence)>}
 */
const ownedGroupEvidence = new Map();

/**
 * Forgets one owned group, its retained child handle, its ownership
 * evidence, and its armed deadline.
 * @param {number} groupPid
 */
function forgetGroup(groupPid) {
  ownedGroups.delete(groupPid);
  ownedChildHandles.delete(groupPid);
  ownedGroupEvidence.delete(groupPid);
  const timerEntry = ownedGroupTimers.get(groupPid);
  if (timerEntry) {
    ownedGroupTimers.delete(groupPid);
    // A completed observation has nothing left to record: clear the timer.
    // An OPEN observation keeps it armed — its fire records the expired
    // observation (timedOut) while the signal itself stays evidence-gated.
    if (timerEntry.observationComplete()) clearTimeout(timerEntry.timer);
  }
  ownedGroupExtraMembersMap.delete(groupPid);
}

/**
 * Registers one owned process group.
 * @param {number} groupPid
 */
function registerOwnedGroup(groupPid) {
  if (Number.isSafeInteger(groupPid) && groupPid > 0) ownedGroups.add(groupPid);
}

/**
 * Retained handles of the driver's own spawned children, by their group id.
 * Process groups do not exist on win32 (isGroupAlive is always false there),
 * so the interrupt/cleanup path can only settle an owned child through its
 * retained direct-child handle. Entries are dropped by the same forget that
 * drops the group's ownership, keeping the map bounded.
 * @type {Map<number, import('node:child_process').ChildProcess>}
 */
const ownedChildHandles = new Map();

/**
 * Settles one owned target: the whole process group on POSIX, or — where
 * process groups do not exist (win32) — the retained direct-child handle,
 * exactly the fallback the subprocess deadline path uses. Exported as the
 * bounded seam so the win32 branch stays testable off-Windows; the real
 * win32 process behavior itself cannot be exercised on a POSIX host.
 * @param {number} groupPid @param {import('node:child_process').ChildProcess|null} child @param {NodeJS.Platform} [platform]
 * @returns {boolean} whether a kill was delivered
 */
export function settleOwnedTarget(groupPid, child, platform = process.platform) {
  if (platform === 'win32') {
    if (!child || child.exitCode !== null || child.signalCode !== null) return false;
    try {
      return child.kill('SIGKILL');
    } catch {
      return false;
    }
  }
  return isGroupAlive(groupPid) && signalGroup(groupPid, 'SIGKILL');
}

/**
 * Enumerates the surviving members of one process group (POSIX) via one full
 * process listing filtered on pgid membership.
 * @param {number} groupPid
 * @returns {number[]}
 */
function listGroupMembers(groupPid) {
  if (process.platform === 'win32') return [];
  if (inspectionBudgetExpired()) return [];
  const executable = resolveProcessInspectionExecutable();
  if (executable === null) return [];
  const listed = spawnSync(executable, ['-eo', 'pid=,pgid='], { encoding: 'utf8', timeout: psTimeoutMs() });
  if (listed.status !== 0 || typeof listed.stdout !== 'string') return [];
  const members = [];
  for (const line of listed.stdout.split('\n')) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 2) continue;
    const pid = Number(tokens[0]);
    const pgid = Number(tokens[1]);
    if (Number.isSafeInteger(pid) && pid > 0 && pgid === groupPid) members.push(pid);
  }
  return members;
}

/**
 * Re-anchors one spawned-host group's ownership evidence at its leader's
 * exit: the SURVIVING members are enumerated once and recorded with their
 * EXEC-STABLE start identity (pid + process start time — NOT the command
 * name, which changes when a surviving shell execs the real CLI). The
 * boundary can then still settle ORIGINAL descendants (round-3 semantics)
 * while refusing a group whose every recorded member vanished — the
 * observable state of a fully recycled group id, where the only remaining
 * members are unrelated processes the driver never recorded. A group with
 * no surviving member at all is forgotten here. Exported as the bounded
 * re-anchor seam: ONE snapshot per exited leader — callers may invoke it to
 * play additional exit paths in tests, and it refuses to refresh
 * already-stored members evidence.
 * @param {number} groupPid
 */
export function reAnchorHostGroupEvidence(groupPid) {
  // ONE exit-time snapshot per group: once members evidence exists it is
  // the only signal authority and is VALIDATED at the boundary — never
  // refreshed with a new process-table snapshot, which could promote an
  // unrecorded replacement whose predecessor left the group.
  if (ownedGroupEvidence.get(groupPid)?.kind === 'members') return;
  // The exit-time snapshot is SYNCHRONOUS process inspection: bound it by
  // the active observation deadline (or a short cap when none is armed) so
  // many surviving members with slow lookups can neither delay the
  // deadline kill and forced-drain timers nor starve SIGINT handling. An
  // expired budget fails closed: no verifiable members means the group is
  // forgotten (never signaled on unverifiable evidence).
  inspectionBudget.deadline = Math.min(
    remainingInspectionMs() === null ? Date.now() + 1_000 : /** @type {number} */ (inspectionBudget.deadline),
    Date.now() + 1_000,
  );
  const members = [];
  for (const memberPid of listGroupMembers(groupPid)) {
    if (inspectionBudgetExpired()) break;
    const startTime = captureProcessStartTime(memberPid);
    if (startTime !== null) members.push({ processId: memberPid, startTime });
  }
  inspectionBudget.deadline = null;
  if (members.length === 0) {
    forgetGroup(groupPid);
    return;
  }
  ownedGroupEvidence.set(groupPid, { kind: 'members', members });
}

/**
 * Whether one live process still BELONGS to the tracked group: a survivor
 * can move into another process group (setpgid/setsid) without changing its
 * start token, so membership must be re-checked from the process table, not
 * assumed from the moment of registration. Fail closed on any unavailable
 * field.
 * @param {number} processId @param {number} groupId
 * @returns {boolean}
 */
/**
 * The synchronous inspection budget: an optional ABSOLUTE deadline that
 * every process-inspection lookup consults before each ps call. Discovery
 * and cleanup set it around a batch so cumulative synchronous inspection
 * can never outlast the observation budget (a single record's walks are
 * clamped per call and fail closed once the budget is gone), leaving the
 * event loop free for deadline kills and SIGINT handling.
 */
/** @type {{deadline: number|null}} */

const inspectionBudget = { deadline: null };

/** Additional VERIFIED member pids of an owned worker group (provenance only; no independent signal authority). @type {Map<number, Set<number>>} */
const ownedGroupExtraMembersMap = new Map();

/**
 * Remaining inspection milliseconds under the active budget, or null when
 * no budget is set.
 * @returns {number|null}
 */
function remainingInspectionMs() {
  return inspectionBudget.deadline === null ? null : Math.max(0, inspectionBudget.deadline - Date.now());
}

/**
 * The ps timeout for ONE lookup: clamped to the remaining inspection
 * budget when one is active.
 * @returns {number}
 */
function psTimeoutMs() {
  const remaining = remainingInspectionMs();
  return remaining === null ? 2_000 : Math.max(1, Math.min(2_000, remaining));
}

function inspectionBudgetExpired() {
  const remaining = remainingInspectionMs();
  return remaining !== null && remaining <= 0;
}

/**
 * Whether one live process BELONGS to the tracked group (its ps pgid
 * equals the tracked group id). Fails closed on any unavailable field.
 * @param {number} processId @param {number} groupId
 * @returns {boolean}
 */
function isProcessInGroup(processId, groupId) {
  if (process.platform === 'win32') return false;
  if (inspectionBudgetExpired()) return false;
  const executable = resolveProcessInspectionExecutable();
  if (executable === null) return false;
  const listed = spawnSync(executable, ['-p', String(processId), '-o', 'pgid='], { encoding: 'utf8', timeout: psTimeoutMs() });
  if (listed.status !== 0 || typeof listed.stdout !== 'string') return false;
  const observedPgid = Number(listed.stdout.trim());
  return Number.isSafeInteger(observedPgid) && observedPgid === groupId;
}

/**
 * Whether one post-exit member snapshot still validates. Members evidence is
 * judged on the EXEC-STABLE identity — process start time plus CONTINUING
 * membership in the tracked group: a surviving shell that later `exec`s the
 * real CLI keeps its pid, start time, and group while changing its command
 * name, so the command-name comparison used for worker records must never
 * gate member evidence. The start-time comparison still rules out a recycled
 * pid, and the membership check still rules out a departed survivor.
 * Residual (documented, bounded): on non-Linux platforms the start time has
 * one-second precision, so a pid recycled within the same second by an
 * unrelated process that joins the same group id between the snapshot and
 * this check would still validate — the same residual the worker-record
 * token carries, bounded to the observation window.
 * @param {{processId: number, startTime: string}} member @param {number} groupPid @returns {boolean}
 */
function isMemberStillValid(member, groupPid) {
  if (inspectionBudgetExpired()) return false;
  try {
    process.kill(member.processId, 0);
  } catch {
    return false;
  }
  const startTime = captureProcessStartTime(member.processId);
  if (startTime === null || startTime !== member.startTime) return false;
  // A departed survivor (setpgid/setsid) keeps its start identity but is no
  // longer evidence FOR the tracked group: revalidate membership too.
  return isProcessInGroup(member.processId, groupPid);
}

/**
 * Whether one owned group may STILL be signaled, judged on its retained
 * evidence at the signaling boundary:
 *
 * - A group holding the driver's own spawned child is HOST-owned: its
 *   registration, deadline, and handle are independent of any worker record
 *   sharing its id. While the captured leader start token still validates,
 *   the group is settled directly; after the leader's exit the enumerated
 *   surviving members gate the signal; with no capturable evidence the
 *   spawned child handle alone identifies the group while it lives, and the
 *   group fails closed once that leader is gone.
 * - A worker-group entry settles only while its recorded worker still
 *   validates; anything evidence-less fails closed.
 * @param {number} groupPid
 * @returns {boolean}
 */
function isOwnedGroupSignalingAllowed(groupPid) {
  const child = ownedChildHandles.get(groupPid) ?? null;
  const evidence = ownedGroupEvidence.get(groupPid) ?? null;
  if (child !== null) {
    if (evidence !== null && evidence.kind === 'leader') {
      // The retained live child handle is the signal authority by itself:
      // the driver spawned this exact pid into this exact group, and a
      // launcher that execs the real CLI changes its command name without
      // changing pid or start time — the token's comm comparison must never
      // invalidate a live retained handle. The handle's own exit state
      // (not a bare pid liveness probe) is what rules out a recycled pid.
      if (child.exitCode !== null || child.signalCode !== null) return false;
      try {
        process.kill(evidence.processId, 0);
      } catch {
        return false;
      }
      return true;
    }
    if (evidence !== null && evidence.kind === 'members') {
      // Bounded scan: many snapshotted members with slow lookups must not
      // block the signaling caller (deadline kill, interrupt, cleanup) —
      // arm a short budget for THIS scan; expired members fail closed
      // (invalid) via isMemberStillValid's own expiry check.
      const previousDeadline = inspectionBudget.deadline;
      const localBound = Date.now() + 1_000;
      inspectionBudget.deadline = previousDeadline === null ? localBound : Math.min(previousDeadline, localBound);
      try {
        return evidence.members.some((member) => isMemberStillValid(member, groupPid));
      } finally {
        inspectionBudget.deadline = previousDeadline;
      }
    }
    return child.exitCode === null && child.signalCode === null;
  }
  if (evidence !== null && evidence.kind === 'worker') {
    const pid = evidence.record.pid;
    return Number.isSafeInteger(pid) && /** @type {number} */ (pid) > 0
      && isRecordedWorkerOwnable(evidence.record, /** @type {number} */ (pid), groupPid);
  }
  return false;
}

/**
 * Captures one live process's platform start token: the best available
 * combination of immutable start identity fields. On Linux that is
 * /proc/<pid>/stat field 22 (starttime, jiffies precision — finer than one
 * second) together with the kernel comm; elsewhere it is `ps -o lstart=`
 * (one-second precision) combined with `ps -o comm=`. The comm field is what
 * rejects a pid+pgid recycled within the same second by a DIFFERENT
 * executable; both fields must be available or the token is null (fail
 * closed).
 *
 * Residual, documented honestly: on non-Linux platforms a replacement process
 * started within the SAME second, with the SAME truncated comm, inside the
 * same pgid would still produce an identical token. On Linux the jiffy
 * starttime makes that residual unreachable in practice.
 * @param {number} processId
 * @returns {string|null}
 */
function captureProcessStartTime(processId) {
  if (process.platform === 'win32') return null;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${processId}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      if (close < 0) return null;
      // /proc/<pid>/stat fields: 1 pid, 2 (comm), 3 state, ... 22 starttime.
      // fields[0] below is field 3, so starttime sits at index 22 - 3.
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      const starttime = fields[22 - 3];
      if (starttime === undefined || !/^\d+$/.test(starttime)) return null;
      return `starttime=${Number(starttime)}`;
    } catch {
      return null;
    }
  }
  const executable = resolveProcessInspectionExecutable();
  if (executable === null) return null;
  if (inspectionBudgetExpired()) return null;
  const startListed = spawnSync(executable, ['-p', String(processId), '-o', 'lstart='], { encoding: 'utf8', timeout: psTimeoutMs() });
  if (startListed.status !== 0 || typeof startListed.stdout !== 'string') return null;
  const lstart = startListed.stdout.trim().replace(/\s+/g, ' ');
  if (lstart.length === 0) return null;
  return `lstart=${lstart}`;
}

/**
 * The full platform start token for one live process: start identity AND
 * command name (the worker-record comparison needs the command name — a
 * same-second recycled record naming a DIFFERENT executable is never
 * owned). Post-exit member evidence uses the exec-stable
 * {@link captureProcessStartTime} instead.
 * @param {number} processId
 * @returns {string|null}
 */
function captureProcessStartToken(processId) {
  if (process.platform === 'win32') return null;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${processId}/stat`, 'utf8');
      const open = stat.indexOf('(');
      const close = stat.lastIndexOf(')');
      if (open < 0 || close <= open) return null;
      const comm = stat.slice(open + 1, close);
      const startTime = captureProcessStartTime(processId);
      if (comm.length === 0 || startTime === null) return null;
      return `${startTime}|comm=${comm}`;
    } catch {
      return null;
    }
  }
  const executable = resolveProcessInspectionExecutable();
  if (executable === null) return null;
  const startTime = captureProcessStartTime(processId);
  if (startTime === null) return null;
  if (inspectionBudgetExpired()) return null;
  const commListed = spawnSync(executable, ['-p', String(processId), '-o', 'comm='], { encoding: 'utf8', timeout: psTimeoutMs() });
  if (commListed.status !== 0 || typeof commListed.stdout !== 'string') return null;
  const comm = commListed.stdout.trim();
  if (comm.length === 0) return null;
  return `${startTime}|comm=${comm}`;
}

/**
 * Extracts the recorded side of the platform start token from a launch
 * record: the lstart and comm portions of the worker's captured identity
 * (`lstart|ppid=…|comm=…`), plus — on Linux, where the finer jiffy starttime
 * is the platform token — the record's `starttime` field (recorded by the
 * fixture from /proc). The ppid portion is deliberately NOT compared: the
 * host's death re-parents the surviving worker and changes its ppid. A
 * record missing any field the current platform's token requires is never
 * ownable (fail closed).
 * @param {Record<string, unknown>} record
 * @returns {string|null}
 */
function recordedWorkerStartToken(record) {
  const identity = typeof record.identity === 'string' ? record.identity : '';
  const lstart = identity.split('|ppid=')[0].trim().replace(/\s+/g, ' ');
  const commIndex = identity.indexOf('|comm=');
  const comm = commIndex >= 0 ? identity.slice(commIndex + '|comm='.length).trim() : '';
  if (lstart.length === 0 || comm.length === 0) return null;
  if (process.platform === 'linux') {
    const starttime = record.starttime;
    if (!Number.isSafeInteger(starttime) || /** @type {number} */ (starttime) <= 0) return null;
    return `starttime=${/** @type {number} */ (starttime)}|comm=${comm}`;
  }
  return `lstart=${lstart}|comm=${comm}`;
}

/**
 * Whether one recorded worker is STILL verifiably the process its record
 * describes, inside its recorded group. A launch record is historical
 * evidence of a launch, not continuing authority to signal a group: once the
 * recorded worker has exited, its pid can be reused, a detached leader's pgid
 * IS its pid, so pid and pgid can be recycled TOGETHER by an unrelated
 * process — membership alone does not establish ownership. Every registration
 * therefore re-checks that the recorded member pid still exists, still
 * belongs to that group, AND still carries the recorded platform start token
 * (Linux: jiffy starttime + comm; elsewhere lstart + comm); a record without
 * the token fields is never owned.
 * @param {Record<string, unknown>} record @param {number} processId @param {number} groupId
 * @returns {boolean}
 */
function isRecordedWorkerOwnable(record, processId, groupId) {
  if (process.platform === 'win32') return false;
  try {
    process.kill(processId, 0);
  } catch {
    return false;
  }
  const recordedToken = recordedWorkerStartToken(record);
  if (recordedToken === null) return false;
  const currentToken = captureProcessStartToken(processId);
  if (currentToken === null || currentToken !== recordedToken) return false;
  return isProcessInGroup(processId, groupId);
}

/**
 * The parent pid CLAIMED by a launch record's captured identity (the
 * `ppid=` field the fixture worker records at its launch). Null when the
 * record carries no parseable claim.
 * @param {Record<string, unknown>} record @returns {number|null}
 */
function recordedClaimedPpid(record) {
  const identity = typeof record.identity === 'string' ? record.identity : '';
  const match = identity.match(/(?:^|\|)ppid=(\d+)(?:\||$)/);
  return match ? Number(match[1]) : null;
}

/**
 * The TRUSTED LAUNCH BOUNDARY for one recorded worker: the record's claimed
 * parent must be this run's spawned host AND the live parent must still be
 * that host — or pid 1, after the host's death reparented the real worker.
 * A model-writable record can name an unrelated process with its REAL start
 * identity, but its live ppid is its real parent (not the host, not 1), so
 * the forgery is rejected. Documented residual: an unrelated ORPHANED
 * process (live ppid 1) named with a forged host-ppid claim is
 * indistinguishable from a reparented real worker in a same-user
 * model-writable log — bounded to this disposable probe. Fails closed on
 * any unavailable field.
 * @param {Record<string, unknown>} record @param {number} processId @param {number} hostPid @returns {boolean}
 */
function isTrustedWorkerLaunch(record, processId, hostPid) {
  if (process.platform === 'win32') return false;
  const executable = resolveProcessInspectionExecutable();
  if (executable === null) return false;
  // LIVE ANCESTRY CHAIN: walk the ppid chain from the worker toward the
  // spawned host. A launcher (`--codex` pointing at the npm launcher, which
  // spawns the native CLI) inserts intermediaries, so the worker's DIRECT
  // parent is not always the host pid — only a verified chain to the owned,
  // still-living host establishes "this run launched it".
  let current = processId;
  for (let hops = 0; hops < 6; hops += 1) {
    if (inspectionBudgetExpired()) return false;
    const listed = spawnSync(executable, ['-p', String(current), '-o', 'ppid='], { encoding: 'utf8', timeout: psTimeoutMs() });
    if (listed.status !== 0 || typeof listed.stdout !== 'string') break;
    const ppid = Number(listed.stdout.trim());
    if (!Number.isSafeInteger(ppid) || ppid <= 0) break;
    if (ppid === hostPid) {
      // The chain reaches the host: it only means "this run" while the host
      // is verifiably still alive.
      const hostHandle = ownedChildHandles.get(hostPid);
      if (hostHandle !== undefined && hostHandle.exitCode === null && hostHandle.signalCode === null) return true;
      break;
    }
    current = ppid;
  }
  // Reparented real worker: the host died before the poll, the worker's
  // live ppid is now 1, and the record claims the host as its parent.
  // Documented residual: an unrelated ORPHANED process (live ppid 1) named
  // with a forged host-ppid claim is indistinguishable from a reparented
  // real worker in a same-user model-writable log — bounded to this
  // disposable probe.
  const claimed = recordedClaimedPpid(record);
  if (claimed !== hostPid) return false;
  if (inspectionBudgetExpired()) return false;
  const listed = spawnSync(executable, ['-p', String(processId), '-o', 'ppid='], { encoding: 'utf8', timeout: psTimeoutMs() });
  if (listed.status !== 0 || typeof listed.stdout !== 'string') return false;
  const livePpid = Number(listed.stdout.trim());
  return Number.isSafeInteger(livePpid) && livePpid === 1;
}

/**
 * Owns every recorded shell worker's SEPARATE process group the moment the
 * fixture's launch log names it AND the record still verifies against the
 * live process table (recorded pid alive, platform start token matching, and
 * still in that group): the real macOS shell runs the command in its own
 * group/session, so budget expiry, the interrupt path, and cleanup must all
 * be able to settle that group independently of the host group. The
 * validating record is retained as the entry's ownership EVIDENCE. A record
 * that no longer validates — the worker exited, its start token no longer
 * matches, or its recorded group no longer contains the recorded pid — never
 * creates ownership, and a REGISTERED entry whose evidence stopped
 * validating is dropped instead of being retained while the group still
 * looks alive: an unrelated replacement may be holding the recycled id. A
 * group that holds a spawned host leader is HOST-owned: its registration,
 * deadline, and leader evidence are independent of any worker record sharing
 * that group id, so expired worker evidence never drops the host.
 *
 * NEW ownership is only created from a TRUSTED LAUNCH BOUNDARY: the caller
 * supplies the spawned host's pid while that host is verifiably alive, and
 * the recorded worker's ancestry must reach it — a model-writable record can
 * name an unrelated live process with its real identity, so identity
 * matching alone is never launch authority. Post-execution callers (facts
 * reads, cleanup) omit the host context: they MAINTAIN existing entries
 * (drop invalidated or dead groups) but never create new ownership from the
 * model-writable log.
 * @param {Record<string, unknown>[]} records @param {{trustedHostPid?: number|null, attestOnly?: boolean, inspectionDeadline?: number|null}} [launchBoundary]
 */
export function ownRecordedWorkerGroups(records, launchBoundary) {
  const trustedHostPid = launchBoundary?.trustedHostPid ?? null;
  const attestOnly = launchBoundary?.attestOnly ?? false;
  const inspectionDeadline = launchBoundary?.inspectionDeadline ?? null;
  inspectionBudget.deadline = inspectionDeadline;
  try {
    for (const record of records) {
    // Budget-bounded discovery: each record's verification performs
    // multiple synchronous ps calls; once the observation deadline has
    // passed, STOP the batch (fail closed — unprocessed records simply
    // carry no ownership/attestation) so the synchronous inspection can
    // never outlast the observation budget or starve the interrupt path.
    if (inspectionDeadline !== null && Date.now() >= inspectionDeadline) break;
    const pid = record.pid;
    const pgid = record.pgid;
    if (!Number.isSafeInteger(pid) || /** @type {number} */ (pid) <= 0) continue;
    // WIN32 attest-only runs BEFORE the POSIX pgid requirement: native
    // Windows records carry pgid/identity null (no POSIX inspection), and
    // a poll-discovered record while the host lived is that platform's
    // launch attestation (documented residual).
    if (process.platform === 'win32') {
      if (trustedHostPid !== null) attestedWorkerPids.add(pid);
      continue;
    }
    if (!Number.isSafeInteger(pgid) || /** @type {number} */ (pgid) <= 0) continue;
    const processId = /** @type {number} */ (pid);
    const groupId = /** @type {number} */ (pgid);
    // HISTORICAL ATTESTATION on a coherent claim — runs for EVERY record,
    // before any ownership logic, and does NOT require the worker to
    // survive until a polling tick (a worker that writes its record and
    // exits between polls must still carry launch provenance). The claim is
    // coherent when BOTH the record's parent claim AND its group are this
    // run's spawned host. Attestation is launch provenance only — it never
    // authorizes signaling (settleWorkerExits splits the two authorities).
    // Documented residual: a forgery with a coherent host claim for an
    // unrelated real (or phantom) process is indistinguishable in a
    // same-user model-writable log — bounded to this disposable probe;
    // incoherent claims (e.g. a ppid of 1) are refused outright.
    if (trustedHostPid !== null
      && recordedClaimedPpid(record) === trustedHostPid) {
      // The record claims THIS run's host as its parent: that coherent
      // claim is the deterministic provenance handoff for short-lived
      // workers (separately grouped OR sharing the host group) that exit
      // between polls. Documented residual: a forgery with a coherent
      // host-parent claim for an unrelated real (or phantom) process is
      // indistinguishable in a same-user model-writable log — bounded to
      // this disposable probe; incoherent claims (e.g. a ppid of 1) are
      // refused outright.
      attestedWorkerPids.add(processId);
    }
    // The claimed-parent handoff runs in BOTH contexts and is performed
    // (and retained) at the EARLIEST opportunity: during polls, while the
    // claimed parent is still live and its ancestry verifiable, and in the
    // post-execution attest-only read for records whose direct coherent
    // claim names the host itself. Attestation-only — neither context
    // creates ownership (the boundary above stays poll-gated).
    // Refusals: a claimed parent of 1/unresolvable, or a claimed parent
    // outside the host's tree.
    const caseHostPid = Number.isSafeInteger(trustedHostPid) ? /** @type {number} */ (trustedHostPid) : null;
    if (caseHostPid !== null
      && (recordedClaimedPpid(record) === caseHostPid
        || claimedParentDescendsFromHost(record, caseHostPid))) {
      attestedWorkerPids.add(processId);
    }
    const hostOwned = ownedChildHandles.has(groupId);
    const evidence = ownedGroupEvidence.get(groupId) ?? null;
    if (hostOwned) {
      // HOST-owned group: worker records never touch its registration or
      // evidence; only the dead-group maintenance applies.
      if (ownedGroups.has(groupId) && !isGroupAlive(groupId)) forgetGroup(groupId);
      else if (trustedHostPid !== null
        && (isTrustedWorkerLaunch(record, processId, trustedHostPid)
          || (recordedClaimedPpid(record) === trustedHostPid
            && isRecordedWorkerOwnable(record, processId, groupId)
            && isProcessInGroup(processId, groupId)))) {
        // A shared-group worker attests through EITHER verified ancestry
        // (its recorded parent is an intermediary whose chain reaches the
        // owned, still-living host) OR the direct coherent claim (recorded
        // parent AND group both the host, corroborated by the live process
        // table — the real fixture smoke shape). Provenance only; the host
        // group's own settlement covers signaling.
        attestedWorkerPids.add(processId);
      }
      continue;
    }
    if (evidence?.kind === 'worker') {
      // MAINTAIN ONLY: the entry's RETAINED evidence is the ownership
      // authority, validated against ITS OWN recorded pid. Incoming
      // records — including a rewritten log naming a replacement — can
      // never replace it or revoke it: a DIFFERENT valid worker sharing
      // the same group (two workers in one shell group) must not undo
      // otherwise-valid ownership, because the retained worker's
      // settlement covers the whole group. That second worker is recorded
      // as an ADDITIONAL VERIFIED MEMBER of the owned group so cleanup can
      // verify its settlement after the group signal — WITHOUT granting it
      // independent signaling authority.
      const retainedPid = Number(evidence.record.pid);
      const retainedValid = Number.isSafeInteger(retainedPid) && retainedPid > 0
        && isRecordedWorkerOwnable(evidence.record, retainedPid, groupId);
      if (retainedValid) {
        registerOwnedGroup(groupId);
        if (processId !== retainedPid && ownedWorkerAttestationsSnapshot().has(processId)) {
          let extras = ownedGroupExtraMembersMap.get(groupId);
          if (!extras) { extras = new Set(); ownedGroupExtraMembersMap.set(groupId, extras); }
          extras.add(processId);
        }
      } else {
        forgetGroup(groupId);
      }
      continue;
    }
    if (!ownedGroups.has(groupId)) {
      // WIN32 attest-only path: native Windows captures neither POSIX
      // identity nor groups, so there is nothing to verify beyond the
      // NEW ownership requires BOTH the record to verify against the live
      // process table AND the trusted launch boundary (ancestry chain to
      // the spawned, still-living host — or the documented reparented
      // residual). A record alone is never launch authority.
      if (isRecordedWorkerOwnable(record, processId, groupId)
        && trustedHostPid !== null
        && !attestOnly
        && isTrustedWorkerLaunch(record, processId, trustedHostPid)) {
        registerOwnedGroup(groupId);
        ownedGroupEvidence.set(groupId, { kind: 'worker', record });
        attestedWorkerPids.add(processId);
      }
      continue;
    }
    if (!isGroupAlive(groupId)) {
      // The group has no member left: forget it now so a later settle can
      // never signal the id after an unrelated group reused it.
      forgetGroup(groupId);
    }
    }
  } finally {
    inspectionBudget.deadline = null;
  }
}

/**
 * Read-only snapshot of the currently owned group ids (test seam).
 * @returns {Set<number>}
 */
export function ownedGroupsSnapshot() {
  return new Set(ownedGroups);
}

/** Read-only snapshot of the attested worker pids (test seam).
 * @returns {Set<number>}
 */
export function ownedWorkerAttestationsSnapshot() {
  return new Set(attestedWorkerPids);
}

/**
 * Registers a spawned child's group as owned so an interrupt or cleanup can
 * signal it even after the child itself exited. Exported as the bounded
 * ownership seam: tests and future long-profile drivers register the groups
 * they own.
 * @param {import('node:child_process').ChildProcess} child
 */
export function registerOwnedChild(child) {
  if (child.pid && child.pid > 0) {
    registerOwnedGroup(child.pid);
    ownedChildHandles.set(child.pid, child);
    // The spawned leader's start token is the group's ownership evidence
    // while it lives; at its exit the evidence re-anchors to the surviving
    // members (or the entry is forgotten), so the signaling boundary can
    // always tell original survivors from a recycled group id.
    const leaderPid = child.pid;
    const token = captureProcessStartToken(leaderPid);
    if (token !== null) ownedGroupEvidence.set(leaderPid, { kind: 'leader', processId: leaderPid, token });
    child.once('exit', () => {
      reAnchorHostGroupEvidence(leaderPid);
    });
  }
}

/**
 * Kills every still-alive owned target whose retained ownership evidence
 * still validates, and forgets the rest; returns the number of kills that
 * were delivered. Group ownership survives the leader's exit, so surviving
 * shell descendants — including separately grouped shell workers the
 * fixture recorded — are settled here. On win32 there are no process groups,
 * so the retained direct-child handle is the settlement target (an interrupt
 * must never abandon a running host just because the group inspection is
 * unavailable). Every group's evidence — worker records, spawned-host leader
 * tokens, and re-anchored member lists — is revalidated at this signaling
 * boundary: a group whose evidence no longer validates is forgotten WITHOUT
 * a signal. Every forget cancels the group's deadline: no stale timer may
 * signal a settled group id afterwards.
 * @returns {number}
 */
/** HISTORICAL LAUNCH ATTESTATION: worker pids this run established through
 * the trusted launch boundary (a poll-verified record while the spawned
 * host lived — the POSIX chain/claim checks, or the win32 live-host poll
 * discovery). Attestation is deliberately SEPARATE from live signaling
 * authority: it survives the worker's natural exit and the entry's
 * settlement, so a later cleanup read can tell an owned-and-settled (or
 * naturally completed) worker from a fabricated record naming a pid that
 * never existed. Only the trusted boundary ever writes it. */
const attestedWorkerPids = new Set();

export function settleOwnedGroups() {
  let killed = 0;
  // The signaling boundary performs per-member process inspection (start
  // tokens + membership): arm a SHORT bounded budget (1 s) so a large
  // retained set with slow lookups can never block SIGINT/deadline
  // handling for minutes. Expired members fail closed (dropped without a
  // signal) via the normal boundary checks.
  inspectionBudget.deadline = Date.now() + 1_000;
  try {
    for (const groupPid of [...ownedGroups]) {
    if (!isOwnedGroupSignalingAllowed(groupPid)) {
      forgetGroup(groupPid);
      continue;
    }
    const child = ownedChildHandles.get(groupPid) ?? null;
    forgetGroup(groupPid);
    if (settleOwnedTarget(groupPid, child)) killed += 1;
  }
  } finally {
    inspectionBudget.deadline = null;
  }
  return killed;
}

/**
 * The driver's bounded interrupt path. A detached host no longer shares the
 * terminal's foreground group, so an interactive Ctrl-C (or a terminal close)
 * would otherwise orphan the live host with its model turn and no cleanup.
 * This handler signals every still-running owned process group, writes one
 * bounded redacted notice, and exits. Naturally idempotent: already-settled
 * groups are never signaled twice.
 * @param {NodeJS.Signals} signalName @param {{exitImpl?: (code: number) => void, writeImpl?: (line: string) => void}} [options]
 * @returns {string} the bounded notice line that was written
 */
export function handleDriverSignal(signalName, options = {}) {
  const exitImpl = options.exitImpl ?? ((code) => process.exit(code));
  const writeImpl = options.writeImpl ?? ((line) => process.stderr.write(line));
  const signaled = settleOwnedGroups();
  const exitCode = 128 + (signalName === 'SIGINT' ? 2 : signalName === 'SIGTERM' ? 15 : 0);
  const notice = `wait-route driver: received ${signalName}; signaled ${signaled} owned process group(s); run state remains in the private output directory\n`;
  writeImpl(notice);
  exitImpl(exitCode);
  return notice;
}

let signalHandlersInstalled = false;

/**
 * Installs the SIGINT/SIGTERM interrupt handlers once per process. Called by
 * the CLI entry so an interactive abort during a case reaches every owned
 * process group before exit.
 * @param {{exitImpl?: (code: number) => void, writeImpl?: (line: string) => void}} [options]
 */
export function installDriverSignalHandlers(options = {}) {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  process.once('SIGINT', () => { handleDriverSignal('SIGINT', options); });
  process.once('SIGTERM', () => { handleDriverSignal('SIGTERM', options); });
}

/**
 * Spawns one bounded subprocess with byte-bounded stdout, stderr kept as a
 * count only (never retained), and a deadline that kills the child's whole
 * process group. A spawn failure rejects with a closed instrument code so
 * every caller's cleanup path still runs. An optional poll hook lets the
 * caller track state (e.g. recorded shell worker groups) while the child
 * runs. Exported as the bounded subprocess seam so research harnesses and
 * tests can drive it directly.
 * @param {string} command @param {string[]} args @param {{cwd: string, env: NodeJS.ProcessEnv, deadlineMs: number, stdoutMaxBytes?: number, markerText?: string, setupDelayMs?: number, pollMs?: number, onPoll?: () => Promise<void>|void, onSpawn?: (child: import('node:child_process').ChildProcess) => void, onSettled?: () => void}} options
 * @returns {Promise<{code: number|null, timedOut: boolean, overflow: boolean, stdout: string, stderrBytes: number, durationMs: number, lastOutputAtMs: number|null, markerAtMs: number|null, deadlineAtMs: number, child: import('node:child_process').ChildProcess}>}
 */
export async function runBoundedSubprocess(command, args, options) {
  const startedAt = Date.now();
  // The observation deadline is ABSOLUTE: computed before any synchronous
  // setup (spawn, ownership registration and its process-inspection ps
  // calls) so slow setup can never extend the observation window. The
  // timer handle starts null and is initialized only when the timer is
  // ARMED (after the optional slow-setup delay): child callbacks (close,
  // exit, error) can fire during that delay, so every cancellation guards
  // on null until then — an early exit or spawn error during setup takes
  // the normal bounded result path, never an uncaught exception.
  const deadlineAtMs = Date.now() + Math.max(1, options.deadlineMs);
  /** @type {NodeJS.Timeout|null} */
  let deadline = null;
  /** @type {import('node:child_process').ChildProcess} */
  let child;
  try {
    child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Own process group on POSIX: the deadline and overflow kills below
      // signal the group so host descendants are never orphaned.
      detached: process.platform !== 'win32',
    });
  } catch {
    // Some spawn failures (an invalid program image under a detached spawn)
    // throw synchronously instead of emitting an async 'error' event; the
    // closed instrument code must be the only thing that crosses the seam.
    throw driverError('WAIT_ROUTE_DRIVER_SPAWN_FAILED', 'A spawned host command failed to start.');
  }
  registerOwnedChild(child);
  options.onSpawn?.(child);
  const groupPid = child.pid ?? 0;
  const stdoutMaxBytes = options.stdoutMaxBytes ?? 64 * 1024;
  /** @type {string[]} */
  const stdoutChunks = [];
  let stdoutBytes = 0;
  let overflow = false;
  let stderrBytes = 0;
  let timedOut = false;
  let lastOutputAtMs = null;
  /** @type {number|null} */
  let markerAtMs = null;
  let observationComplete = false;
  /** Bounded periodic caller hook while the child runs (cleared on settle). */
  /** @type {NodeJS.Timeout|null} */
  let pollTimer = null;
  /** @type {(() => void) | null} */
  let stopEarlyDiscovery = null;
  if (options.pollMs && options.onPoll) {
    // Discovery runs in TWO phases: an immediate first poll plus a 50 ms
    // early burst for the first second (short-lived hosts — the real
    // fixture smoke completes in ~200 ms — can exit before a slower tick,
    // and their workers' records must still be attested while the host
    // context is verifiable), then the caller's poll interval.
    const pollOnce = () => {
      try {
        const polled = options.onPoll?.();
        if (polled && typeof /** @type {any} */ (polled).catch === 'function') /** @type {any} */ (polled).catch(() => {});
      } catch { /* a poll failure never breaks the case */ }
    };
    /** @type {NodeJS.Timeout|null} */
    let earlyPollTimer = null;
    /** @type {NodeJS.Timeout|null} */
    let earlySwitchTimer = null;
    pollOnce();
    earlyPollTimer = setInterval(pollOnce, 20);
    earlyPollTimer.unref?.();
    earlySwitchTimer = setTimeout(() => {
      if (earlyPollTimer !== null) clearInterval(earlyPollTimer);
      earlyPollTimer = null;
      pollTimer = setInterval(pollOnce, Math.max(50, options.pollMs ?? 250));
      pollTimer.unref?.();
    }, 500);
    earlySwitchTimer.unref?.();
    stopEarlyDiscovery = () => {
      if (earlyPollTimer !== null) clearInterval(earlyPollTimer);
      if (earlySwitchTimer !== null) clearTimeout(earlySwitchTimer);
      if (pollTimer) clearInterval(pollTimer);
    };
  }
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    stdoutBytes += Buffer.byteLength(String(chunk));
    lastOutputAtMs = Date.now();
    if (stdoutBytes > stdoutMaxBytes) {
      overflow = true;
      // The same ownership revalidation the deadline and interrupt paths
      // use, PLUS the identity guard: stale output arriving through a pipe
      // held by a descendant is only authority while the ORIGINAL child
      // registration still holds the group id — a replacement registration
      // (even a valid one) over a recycled id is not authority for this
      // output's overflow kill.
      if (ownedChildHandles.get(groupPid) === child && ownedGroups.has(groupPid) && isOwnedGroupSignalingAllowed(groupPid)) {
        signalOwnedGroup(child, 'SIGKILL');
      }
      return;
    }
    stdoutChunks.push(String(chunk));
    // The marker's own arrival is timestamped at match time so later
    // unrelated stdout can never retroactively invalidate an in-budget
    // marker observation.
    if (options.markerText !== undefined && markerAtMs === null && stdoutChunks.join('').includes(options.markerText)) {
      markerAtMs = Date.now();
    }
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    stderrBytes += Buffer.byteLength(String(chunk));
    if (process.env.WAIT_ROUTE_DEBUG_STDERR) process.stderr.write(String(chunk));
    if (stderrBytes > HOST_STDERR_MAX_BYTES) {
      overflow = true;
      // Same identity guard and ownership revalidation as the stdout
      // overflow above.
      if (ownedChildHandles.get(groupPid) === child && ownedGroups.has(groupPid) && isOwnedGroupSignalingAllowed(groupPid)) {
        signalOwnedGroup(child, 'SIGKILL');
      }
    }
    // Stderr content is never retained — only prevented from blocking the pipe.
  });

  // The result is resolved on 'close' semantics — process exit AND both
  // stdio streams closed. A child's exit event can precede the final stdout
  // flush (a descendant inheriting the pipe), and an exit-time snapshot
  // would drop buffered version text or completion markers. The bounded
  // drain force-resolves after the deadline if inherited pipes are still
  // held open past it, so the driver can never hang on a stream.
  // The result promise is created (and every child listener attached)
  // BEFORE the simulated slow setup (e.g. process inspection): the child's
  // exit and stream events can never be missed, and the absolute deadline
  // still governs the observation.
  // The rejection is observed immediately at creation: a spawn error
  // during the slow-setup delay would otherwise surface as an unhandled
  // rejection and terminate the process. The awaited rejection below still
  // flows through the normal bounded-failure and caller-cleanup path.
  const exitPromise = /** @type {Promise<{code: number|null, signal: string|null}>} */ (new Promise((resolveExit, rejectExit) => {
    /** @type {{code: number|null, signal: string|null}|null} */
    let exitOutcome = null;
    let stdoutClosed = false;
    let stderrClosed = false;
    let exitSettled = false;
    /** @type {NodeJS.Timeout|null} */
    let drainForceTimer = null;
    const settleExit = () => {
      if (exitSettled || exitOutcome === null) return;
      if (!stdoutClosed || !stderrClosed) return;
      exitSettled = true;
      observationComplete = true;
      // Worker discovery keeps polling until the observation settles: an
      // early-exiting host never stops discovery while the observation is
      // open (a late launch record is still discovered and owned). A
      // PENDING read continuation is also invalidated: its then-handler
      // checks discoveryClosed and never re-creates ownership after the
      // observation (or a later settleOwnedGroups) has run.
      options.onSettled?.();
      stopEarlyDiscovery?.();
      if (pollTimer) clearInterval(pollTimer);
      // Settle-time expiry, independent of the deadline callback: when the
      // observation completes AFTER the absolute deadline (output and
      // closure delayed past it, e.g. by the slow setup), the expiry is
      // recorded here even though the timer never fired in the open.
      if (Date.now() > deadlineAtMs) timedOut = true;
      // An orphaned observation timer — its registration was already
      // forgotten — must not outlive the observation it was armed for.
      // (Null until armed: an early exit during the slow setup has nothing
      // to clear.)
      if (deadline !== null && ownedChildHandles.get(groupPid) !== child) {
        clearTimeout(deadline);
        deadline = null;
      }
      if (drainForceTimer !== null) clearTimeout(drainForceTimer);
      resolveExit(exitOutcome);
    };
    child.stdout?.once('close', () => {
      stdoutClosed = true;
      settleExit();
    });
    child.stderr?.once('close', () => {
      stderrClosed = true;
      settleExit();
    });
    child.once('exit', (code, signal) => {
      exitOutcome = { code: code ?? null, signal: signal ?? null };
      settleExit();
    });
    drainForceTimer = setTimeout(() => {
      if (exitSettled) return;
      exitSettled = true;
      // The forced drain resolves PAST the absolute deadline: expiry is
      // recorded here so an exhausted budget is never misclassified as a
      // clean exit or execution failure.
      if (Date.now() >= deadlineAtMs) timedOut = true;
      observationComplete = true;
      // Worker discovery stops with the observation settlement (the drain
      // is the last chance to discover a late launch record). Pending read
      // continuations are invalidated as above.
      options.onSettled?.();
      stopEarlyDiscovery?.();
      if (pollTimer) clearInterval(pollTimer);
      // Release the driver's own pipe handles: an unowned descendant may
      // hold the inherited fds far past the deadline, and leaving the
      // streams open and referenced would keep the run alive after the
      // bounded drain resolves. The driver cannot kill that descendant, but
      // it must not wait for it either.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolveExit(exitOutcome ?? { code: null, signal: null });
    }, Math.max(1, deadlineAtMs + SUBPROCESS_DRAIN_GRACE_MS - Date.now()));
    drainForceTimer.unref?.();
    // Without this listener a spawn failure (an EACCES race, a deleted cwd,
    // an invalid program image) would be an uncaught exception: the pending
    // await would never unwind and the caller's cleanup would be skipped.
    child.once('error', () => {
      if (drainForceTimer !== null) clearTimeout(drainForceTimer);
      forgetGroup(groupPid);
      if (deadline !== null) clearTimeout(deadline);
      // Discovery polling belongs to the OPEN observation: a spawn failure
      // rejects the case, so the poller must stop here — an interval left
      // running after the rejection keeps invoking discovery into the
      // caller's cleanup.
      stopEarlyDiscovery?.();
      if (pollTimer) clearInterval(pollTimer);
      observationComplete = true;
      rejectExit(driverError('WAIT_ROUTE_DRIVER_SPAWN_FAILED', 'A spawned host command failed to start.'));
    });
  }));
  exitPromise.catch(() => {});
  // The simulated slow lookup (e.g. process inspection) runs AFTER every
  // child listener is attached and BEFORE the deadline timer is armed:
  // the timer then receives only the REMAINING observation window, so
  // slow setup can never extend it.
  if (options.setupDelayMs !== undefined && options.setupDelayMs > 0) {
    await sleep(options.setupDelayMs);
  }
  deadline = setTimeout(() => {
    ownedGroupTimers.delete(groupPid);
    // Observation expiry is tracked INDEPENDENTLY of the permission to
    // signal: a group entry forgotten as empty (a host group whose leader
    // exited and left no recorded members) must not hide an expired
    // observation, while the kill decision itself stays evidence-gated —
    // an expired observation over an unowned group still refuses to signal.
    if (!observationComplete) timedOut = true;
    // The kill decision validates the ORIGINAL registration captured at arm
    // time: a timer whose registration was forgotten — or replaced by a
    // later subprocess reusing the pid — records expiry only and never
    // signals; a live later registration with the same pid is not authority
    // for the old timer.
    if (ownedChildHandles.get(groupPid) !== child) return;
    // The same evidence revalidation the interrupt and cleanup use: an
    // expired-budget kill must never land on a group whose recorded members
    // no longer validate.
    if (!isOwnedGroupSignalingAllowed(groupPid)) {
      forgetGroup(groupPid);
      return;
    }
    // The deadline fires against the whole group even after the leader
    // exited: surviving descendants are settled with it. Only a DELIVERED
    // deadline kill counts as a deadline fire — late fires over settled or
    // forgotten groups are pure observation bookkeeping.
    groupDeadlineFires += 1;
    signalOwnedGroup(child, 'SIGKILL');
    forgetGroup(groupPid);
  }, Math.max(1, deadlineAtMs - Date.now()));
  deadline.unref?.();
  if (groupPid > 0 && !observationComplete) {
    // Arm the deadline timer only while the observation is still open: an
    // observation that completed during the slow setup already recorded its
    // (non-)expiry at settle time, and a timer armed now could only fire
    // after completion — structurally unable to misclassify or signal.
    ownedGroupTimers.set(groupPid, { timer: deadline, observationComplete: () => observationComplete });
  }

  const exit = await exitPromise;
  // The deadline is deliberately NOT cleared here: if descendants survived
  // the leader's exit, it stays armed against them until the group is
  // settled (by this timer, the interrupt path, or case cleanup).
  return {
    code: exit.code,
    timedOut,
    overflow,
    stdout: stdoutChunks.join(''),
    stderrBytes,
    durationMs: Date.now() - startedAt,
    lastOutputAtMs,
    markerAtMs,
    deadlineAtMs,
    child,
  };
}

/**
 * The driver's cleanup-ownership seam: reads the private trace for the last
 * server-started event and settles the recorded server exit. A live process
 * is signaled ONLY after the startup identity it recorded (kernel start time,
 * parent pid, and command name, captured by the server itself at startup)
 * still matches the running pid — a recycled pid can never reproduce all
 * three. A missing or unverifiable identity is reported as `unresolved` and
 * never signaled.
 * @param {{runDirectory: string, runNonce?: string, graceMs?: number}} input
 * @returns {Promise<'not-started'|'verified-exited'|'terminated'|'unresolved'>}
 */
export async function ensureServerExitByTrace(input) {
  const { runDirectory, graceMs = SERVER_EXIT_VERIFY_GRACE_MS } = input;
  const { records } = await readTraceEvents({ runDirectory, runNonce: input.runNonce });
  /** @type {number|null} */
  let serverPid = null;
  /** @type {string|null} */
  let recordedIdentityHash = null;
  for (const record of records) {
    if (record.kind === 'server-started' && Number.isSafeInteger(record.serverPid) && /** @type {number} */ (record.serverPid) > 0) {
      serverPid = /** @type {number} */ (record.serverPid);
      recordedIdentityHash = typeof record.identityHash === 'string' && record.identityHash.length > 0 ? record.identityHash : null;
    }
  }
  if (serverPid === null) return 'not-started';
  return settleRecordedProcess(serverPid, recordedIdentityHash, input.runNonce, graceMs);
}

/**
 * A process counts as settled when it can no longer execute code: either the
 * pid is gone (ESRCH) or it is a zombie awaiting reap by its own parent. A
 * zombie can never run again and its pid cannot be recycled while un-reaped,
 * so treating it as settled is the honest ownership observation.
 * @param {number} pid
 * @returns {Promise<boolean>}
 */
/**
 * Whether one process has settled: gone (kill(0) fails) or in the zombie
 * state (ps stat begins with Z). A live process is NOT settled.
 * @param {number} pid
 * @returns {Promise<boolean>}
 */
async function isProcessSettled(pid) {
  if (inspectionBudgetExpired()) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (errorCode(error) === 'EPERM') return false;
    return true;
  }
  if (process.platform === 'win32') return false;
  const executable = resolveProcessInspectionExecutable();
  if (executable === null) return false;
  const state = spawnSync(executable, ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', timeout: psTimeoutMs() });
  return state.status === 0 && typeof state.stdout === 'string' && state.stdout.trim().startsWith('Z');
}

/**
 * Builds the isolated host environment: no user HOME and no user CODEX_HOME
 * reaches the host process.
 * @param {string} tmp @param {string} home @param {string} codexHome
 * @returns {NodeJS.ProcessEnv}
 */
function hostEnvironment(tmp, home, codexHome) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    PATH: process.env.PATH ?? '',
    TMPDIR: tmp,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codexHome,
  };
  if (process.platform === 'win32') {
    env.SystemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    env.COMSPEC = process.env.COMSPEC ?? 'cmd.exe';
  }
  return env;
}

/**
 * Resolves and pins the codex binary: an absolute path to a regular
 * executable file (symlinks resolve once). A missing binary is an INSTRUMENT
 * failure, never a host outcome.
 * @param {string} codexPath
 * @returns {Promise<string>}
 */
async function resolveCodexBinary(codexPath) {
  if (!isAbsolute(codexPath)) throw driverError('WAIT_ROUTE_DRIVER_CODEX_RELATIVE', 'The codex path must be absolute.');
  const stats = await lstat(codexPath).catch((error) => {
    if (errorCode(error) === 'ENOENT') throw driverError('WAIT_ROUTE_DRIVER_CODEX_MISSING', 'The supplied codex binary must exist.');
    throw error;
  });
  if (stats.isSymbolicLink()) return realpath(codexPath);
  if (!stats.isFile()) throw driverError('WAIT_ROUTE_DRIVER_CODEX_NOT_FILE', 'The supplied codex path must be a regular file.');
  if (process.platform !== 'win32' && (stats.mode & 0o111) === 0) {
    throw driverError('WAIT_ROUTE_DRIVER_CODEX_NOT_EXECUTABLE', 'The supplied codex binary must be executable.');
  }
  return codexPath;
}

/** The source Codex home for the read-only auth copy: probe env, then default. */
function resolveSourceCodexHome() {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

/**
 * Copies the source auth.json read-only into the isolated home. Never
 * modifies anything in the source home. Returns false when the prerequisite
 * is missing — an explicit inconclusive, not an error.
 * @param {string} sourceCodexHome @param {string} codexHome
 * @returns {Promise<boolean>}
 */
async function copySourceAuth(sourceCodexHome, codexHome) {
  const authPath = join(sourceCodexHome, 'auth.json');
  const stats = await lstat(authPath).catch((error) => {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  });
  if (stats === null || stats.isSymbolicLink() || !stats.isFile()) return false;
  const destination = join(codexHome, 'auth.json');
  await copyFile(authPath, destination);
  if (process.platform !== 'win32') await chmod(destination, 0o600);
  return true;
}

/**
 * Whether the launch record's CLAIMED parent (its recorded `ppid=`) is
 * itself a live process whose ancestry reaches the spawned host: the
 * deterministic post-exit handoff for launcher-mediated workers, whose
 * direct parent is the native CLI (or an intervening shell) rather than
 * the launcher pid the driver spawned. Fails closed on any unavailable
 * field.
 * @param {Record<string, unknown>} record @param {number} hostPid @returns {boolean}
 */
function claimedParentDescendsFromHost(record, hostPid) {
  const claimed = recordedClaimedPpid(record);
  if (claimed === null || claimed === hostPid) return false;
  if (process.platform === 'win32') return false;
  const executable = resolveProcessInspectionExecutable();
  if (executable === null) return false;
  let current = claimed;
  for (let hops = 0; hops < 6; hops += 1) {
    if (inspectionBudgetExpired()) return false;
    const listed = spawnSync(executable, ['-p', String(current), '-o', 'ppid='], { encoding: 'utf8', timeout: psTimeoutMs() });
    if (listed.status !== 0 || typeof listed.stdout !== 'string') return false;
    const ppid = Number(listed.stdout.trim());
    if (!Number.isSafeInteger(ppid) || ppid <= 0) return false;
    if (ppid === hostPid) return true;
    current = ppid;
  }
  return false;
}

/**
 * Read flags for the launch log: read-only AND non-blocking, so opening a
 * FIFO (the stat/open TOCTOU shape) fails or returns immediately instead of
 * waiting for a writer. Regular files ignore the non-blocking flag.
 * @returns {number}
 */
function openNonBlockingFlags() {
  return fsConstants.O_RDONLY | fsConstants.O_NONBLOCK;
}

/**
 * @typedef {Object} SessionSummary
 * @property {boolean} present
 * @property {number} files
 * @property {boolean} truncated
 * @property {number} assistantMessages
 * @property {number} reasoningItems
 * @property {number} functionCalls
 * @property {number} functionCallOutputs
 * @property {number} initialExecCalls
 * @property {number} emptyPolls
 * @property {number} otherFunctionCalls
 * @property {Record<string, number>} toolNames
 * @property {number[]} requestedYieldsMs
 * @property {number} requestedYieldCount
 * @property {number} parallelToolCallViolations
 * @property {number|null} firstFunctionCallAtMs
 * @property {number|null} firstEmptyPollAtMs
 * @property {number|null} lastFunctionCallOutputAtMs
 * @property {{atMs: number|null, kind: 'initial-exec'|'empty-poll'|'other', name: string, yieldTimeMs: number|null, }[]} calls
 * @property {boolean} callsTruncated
 * @property {{records: number, functionCalls: number, initialExecCalls: number, emptyPolls: number}[]} perFile
 */

/**
 * Whether a role-control summary CORROBORATES the managed-child lifecycle.
 * Every fact is bounded and content-free; ALL are required:
 * - EXACTLY ONE spawn_agent call (a second spawn makes the executed
 *   child's identity ambiguous — fail closed);
 * - the spawn ARGUMENTS name the synthetic role (the `spawnedSyntheticRole`
 *   fact — role fields only, never other argument content);
 * - the synthetic spawn's own OUTPUT was observed
 *   (`syntheticSpawnAnswered` — a spawn attempt without an output proves
 *   no successful child);
 * - the initial-exec evidence comes from a NON-Root rollout PARENT-LINKED
 *   to the Root session (`linkedChildExecSeen` — the child rollout's
 *   session_meta parent_thread_id equals the Root rollout's session_meta
 *   id, the source-pinned spawn edge; an unlinked or unrelated child exec
 *   proves nothing).
 * The facts are attached non-enumerably by summarizeCodexSessions so they
 * never reach the printed summary.
 * @param {WaitRouteSummary} summary
 * @returns {boolean}
 */
export function roleChildProven(summary) {
  if (summary.session === null || !summary.session.present) return false;
  // An incomplete SCAN cannot establish the spawn count or any other fact:
  // fail closed on scan truncation. The `calls` array is a bounded
  // DIAGNOSTIC sample — its truncation hides nothing the grant relies on
  // (the spawn count is a full-scan counter; the linked-exec facts are
  // per-file), so a long run with repeated waits is not rejected for it.
  if (summary.session.truncated === true) return false;
  const sessionRecord = /** @type {{spawnedSyntheticRole?: boolean, syntheticSpawnAnswered?: boolean, linkedChildExecSeen?: boolean, spawnAgentCallCount?: number}} */ (summary.session);
  // The FULL-scan count (not the sampled calls array) must establish
  // exactly one spawn_agent call.
  if (sessionRecord.spawnAgentCallCount !== 1) return false;
  return sessionRecord.spawnedSyntheticRole === true
    && sessionRecord.syntheticSpawnAnswered === true
    && sessionRecord.linkedChildExecSeen === true;
}

/**
 * The STRING-STRIPPED scanning view of a call text: quoted string VALUES
 * (and template-literal contents) are collapsed to empty quotes so
 * parameter-position scans cannot match their contents, while QUOTED
 * PROPERTY KEYS (a quoted string whose next non-whitespace character is
 * `:`) keep their names. Ordinary comments are EXCLUDED — a commented
 * `{yield_time_ms: N}` is an example, not a request — with ONE exception:
 * the documented wrapper directive `// @exec: {...}` is itself a comment,
 * so its directive head is kept (and its quoted key with it); erasing it
 * would silently drop the wrapper bound from the requested-versus-observed
 * analysis.
 * @param {string} text
 * @returns {string}
 */
function stripStringValuesKeepKeys(text) {
  let out = '';
  let inQuote = null;
  let start = -1;
  for (let pos = 0; pos < text.length; pos += 1) {
    const ch = text[pos];
    if (inQuote !== null) {
      if (ch === '\\') pos += 1;
      else if (ch === inQuote) {
        let probe = pos + 1;
        while (probe < text.length && /\s/.test(text[probe])) probe += 1;
        if (text[probe] === ':') out += text.slice(start, pos + 1);
        else out += inQuote === '`' ? '``' : `${inQuote}${inQuote}`;
        inQuote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inQuote = ch;
      start = pos;
      continue;
    }
    if (ch === '/' && text[pos + 1] === '*') {
      // Block-comment contents are examples, not requests: excluded like
      // ordinary line comments (the documented directive is `//`-form).
      const end = text.indexOf('*/', pos + 2);
      if (end === -1) break;
      pos = end + 1;
      continue;
    }
    if (ch === '/' && text[pos + 1] === '/') {
      const newline = text.indexOf('\n', pos);
      const lineEnd = newline === -1 ? text.length : newline;
      const directive = /^\/\/\s*@exec\s*:/.exec(text.slice(pos, lineEnd));
      if (directive !== null) {
        // The documented directive form: keep the directive head (its
        // payload — including the quoted key — is scanned normally).
        out += '@exec:';
        pos += directive[0].length - 1;
      } else {
        pos = lineEnd - 1;
        if (newline === -1) break;
      }
      continue;
    }
    out += ch;
  }
  // An unterminated quoted tail is kept raw: the caller's scans treat the
  // unmatched tail conservatively (no boundary, no classification).
  if (inQuote !== null) out += text.slice(start);
  return out;
}

/**
 * Whether the `/` at `pos` STARTS a regex literal (value position: not
 * preceded by an identifier, `)`, `]`, or quote — otherwise it is division),
 * and is not a comment opener.
 * @param {string} text
 * @param {number} pos
 * @returns {boolean}
 */
function isRegexLiteralStart(text, pos) {
  if (text[pos] !== '/') return false;
  if (text[pos + 1] === '/' || text[pos + 1] === '*') return false;
  let i = pos - 1;
  while (i >= 0 && /\s/.test(text[i])) i -= 1;
  if (i < 0) return true;
  return !/[\w$)\]]/.test(text[i]);
}

/**
 * The last index of the regex literal starting at the `/` in `pos`
 * (including flags), or -1 when unterminated on the same line.
 * @param {string} text
 * @param {number} pos
 * @returns {number}
 */
function regexLiteralEnd(text, pos) {
  // Inside a character class `[...]` neither `/` nor `"` ends the literal —
  // the class closes at `]` and the literal at the following `/`.
  let inClass = false;
  for (let i = pos + 1; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1;
      continue;
    }
    if (text[i] === '\n') return -1;
    if (inClass) {
      if (text[i] === ']') inClass = false;
      continue;
    }
    if (text[i] === '[') {
      inClass = true;
      continue;
    }
    if (text[i] === '/') {
      let j = i + 1;
      while (j < text.length && /[a-z]/i.test(text[j])) j += 1;
      return j - 1;
    }
  }
  return -1;
}

/**
 * Lexical call-site scan of a custom tool-DSL script: the open-paren indexes
 * of every REAL call position for `callName` — occurrences outside quoted
 * strings, outside template-literal TEXT, and outside `#`/`//` line or
 * `/*` block comments. Template INTERPOLATIONS (`${...}`) are executable
 * code: operations inside them ARE detected (only the literal text is
 * skipped). A script that merely PRINTS or comments a shell operation
 * mention must not be classified as that operation and must never supply
 * child-execution evidence.
 * @param {string} text
 * @param {string} callName
 * @returns {number[]}
 */
function callSitesForOperation(text, callName) {
  const sites = [];
  let inQuote = null;
  let interpDepth = 0;
  for (let pos = 0; pos < text.length; pos += 1) {
    const ch = text[pos];
    if (inQuote !== null) {
      if (ch === '\\') pos += 1;
      else if (inQuote === '`' && ch === '$' && text[pos + 1] === '{') {
        // Template interpolation: the enclosed expression is CODE — leave
        // the literal-text mode (the matching `}` re-enters it).
        interpDepth += 1;
        inQuote = null;
        pos += 1;
      } else if (ch === inQuote) inQuote = null;
      continue;
    }
    if (interpDepth > 0) {
      // Interpolation code still has STRINGS: a printed string inside an
      // interpolation (`${"exec_command({})"}`) stays opaque.
      if (ch === '"' || ch === "'" || ch === '`') {
        inQuote = ch;
        continue;
      }
      if (ch === '{') interpDepth += 1;
      else if (ch === '}') {
        interpDepth -= 1;
        if (interpDepth === 0) {
          inQuote = '`';
          continue;
        }
      }
    } else if (ch === '"' || ch === "'" || ch === '`') {
      inQuote = ch;
      continue;
    }
    if (ch === '/' && text[pos + 1] === '*') {
      const end = text.indexOf('*/', pos + 2);
      if (end === -1) break;
      pos = end + 1;
      continue;
    }
    if (ch === '#' || (ch === '/' && text[pos + 1] === '/')) {
      const newline = text.indexOf('\n', pos);
      if (newline === -1) break;
      pos = newline;
      continue;
    }
    if (ch === '/' && isRegexLiteralStart(text, pos)) {
      const regexEnd = regexLiteralEnd(text, pos);
      if (regexEnd === -1) break;
      pos = regexEnd;
      continue;
    }
    if (text.startsWith(callName, pos)) {
      // IDENTIFIER BOUNDARY: a helper named `my_exec_command` contains the
      // operation name as a suffix — only a name NOT preceded by an
      // identifier character is the host operation.
      const boundaryOk = pos === 0 || !/[\w$]/.test(text[pos - 1]);
      let probe = pos + callName.length;
      while (probe < text.length && /\s/.test(text[probe])) probe += 1;
      if (boundaryOk && text[probe] === '(') {
        sites.push(probe);
        pos = probe;
      }
    }
  }
  return sites;
}

/**
 * The index where the call NAME that directly precedes an open paren at
 * `openParenIndex` STARTS (whitespace between name and paren is allowed —
 * the start index accounts for it, so a name lookup at that index is the
 * name itself).
 * @param {string} text
 * @param {number} openParenIndex
 * @returns {number}
 */
function callNameStartBefore(text, openParenIndex) {
  let pos = openParenIndex - 1;
  while (pos >= 0 && /\s/.test(text[pos])) pos -= 1;
  while (pos >= 0 && /[\w$]/.test(text[pos])) pos -= 1;
  return pos + 1;
}

/**
 * Strips block and line comments from a text segment with the standard
 * lexical model (strings survive intact; comment contents are removed), so
 * a property regex cannot read a commented-out property as the effective
 * one.
 * @param {string} text
 * @returns {string}
 */
function stripSegmentComments(text) {
  let out = '';
  let inQuote = null;
  for (let pos = 0; pos < text.length; pos += 1) {
    const ch = text[pos];
    if (inQuote !== null) {
      if (ch === '\\') {
        out += ch;
        pos += 1;
        if (pos < text.length) out += text[pos];
        continue;
      }
      if (ch === inQuote) inQuote = null;
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inQuote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && text[pos + 1] === '*') {
      const end = text.indexOf('*/', pos + 2);
      if (end === -1) break;
      pos = end + 1;
      continue;
    }
    if (ch === '/' && text[pos + 1] === '/') {
      const newline = text.indexOf('\n', pos);
      if (newline === -1) break;
      pos = newline;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Decodes the EFFECTIVE `cmd` VALUE of an exec_command argument segment:
 * comments are stripped first (a commented-out cmd is not a command),
 * exactly ONE cmd property must exist (duplicates — literal or not — are
 * ambiguous and rejected), the value must be a COMPLETE double-quoted
 * literal (a concatenation like `cmd: "<x>" + suffix` has a different
 * effective command), and the literal is JSON-decoded. Anything else
 * yields null (fail closed).
 * @param {string} segment
 * @returns {string|null}
 */
function decodeDslCmdValue(segment) {
  // THREE views, each with a job: the COMMENT-STRIPPED text (strings
  // intact) is where the literal is DECODED — a commented-out cmd must not
  // satisfy correlation, and a comment between the key and its colon must
  // not break it; the STRING-STRIPPED view is where the syntax checks run —
  // `...` or `cmd:` inside the quoted command VALUE (a filesystem path can
  // contain either) is content, never executable syntax. The actual
  // property is located LEXICALLY on the depth-tracked value-stripped view
  // (string contents and nested objects cannot fake a top-level cmd key —
  // `justification: 'cmd: "..."'` is a value), and only the literal
  // following THAT key is decoded.
  const commentStripped = stripSegmentComments(segment);
  const valueStripped = stripStringValuesKeepKeys(commentStripped);
  // A spread can OVERRIDE the literal from runtime data: `{cmd: expected,
  // ...opts}` has a different effective command. Fail closed.
  if (valueStripped.includes('...')) return null;
  // A COMPUTED property (`["cmd"]: replacement`) executes with a value the
  // rollout text cannot prove — any computed property in the segment voids
  // the decode (fail closed).
  if (/(?:^|[{,])\s*\[[^\][]*\]\s*:/.test(commentStripped)) return null;
  // LINEAR key counting: a per-boundary matchAll with `\s*` rescans the
  // whole whitespace run at every boundary (quadratic on padded arguments).
  let cmdKeyCount = 0;
  for (let scanPos = 0; scanPos < valueStripped.length; scanPos += 1) {
    const boundaryChar = valueStripped[scanPos];
    if (boundaryChar !== '{' && boundaryChar !== ',') continue;
    let probe = scanPos + 1;
    while (probe < valueStripped.length && /\s/.test(valueStripped[probe])) probe += 1;
    let colon = probe;
    if (valueStripped.startsWith('cmd', probe)) colon = probe + 3;
    else if (valueStripped.startsWith('"cmd"', probe) || valueStripped.startsWith("'cmd'", probe)) colon = probe + 5;
    else continue;
    while (colon < valueStripped.length && /\s/.test(valueStripped[colon])) colon += 1;
    if (valueStripped[colon] === ':') cmdKeyCount += 1;
  }
  if (cmdKeyCount !== 1) return null;
  // Locate the top-level cmd key LEXICALLY on the COMMENT-STRIPPED text
  // itself (depth-tracked, quotes handled): a command-shaped STRING VALUE
  // (`justification: '{cmd: "expected"}'`) is skipped as content, so the
  // decode can never select a value's interior.
  let depth = 0;
  let inQuote = null;
  let topCmdColon = -1;
  for (let pos = 0; pos < commentStripped.length; pos += 1) {
    const ch = commentStripped[pos];
    if (inQuote !== null) {
      if (ch === '\\') pos += 1;
      else if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    else if (depth === 1) {
      // Quoted keys (`{"cmd": ...}`) are detected BEFORE quote handling so
      // the opening quote never swallows the key as string content.
      if (/\s/.test(ch)) {
        // Skip the whole whitespace run in one step (linear scanning —
        // testing the key regex at every space made decoding quadratic).
        let probe = pos;
        while (probe < commentStripped.length && /\s/.test(commentStripped[probe])) probe += 1;
        const keyMatch = /^["']?cmd["']?\s*:/.exec(commentStripped.slice(probe));
        const boundaryOk = pos === 1 || '[{,'.includes(commentStripped[pos - 1]);
        if (keyMatch !== null && boundaryOk) {
          topCmdColon = probe + keyMatch[0].length;
          break;
        }
        pos = probe - 1;
        continue;
      }
      // Quoted keys (`{"cmd": ...}`) are detected BEFORE quote handling so
      // the opening quote never swallows the key as string content.
      const keyMatch = /^["']?cmd["']?\s*:/.exec(commentStripped.slice(pos));
      const boundaryOk = pos === 1 || '[{,'.includes(commentStripped[pos - 1]);
      if (keyMatch !== null && boundaryOk) {
        topCmdColon = pos + keyMatch[0].length;
        break;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inQuote = ch;
        continue;
      }
    }
  }
  if (topCmdColon === -1) return null;
  // Decode the literal ANCHORED at that colon: the ENTIRE value must be the
  // supported literal —
  // an expression tail (`"other" || "<expected>"`) passes `other`, never
  // the second operand.
  const literal = /^\s*("(?:\\.|[^"\\])*")\s*(?=[,}\n]|$)/.exec(commentStripped.slice(topCmdColon));
  if (literal === null) return null;
  try {
    const decoded = JSON.parse(literal[1]);
    return typeof decoded === 'string' ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Extracts the LIVE observation handle from a running output: both the
 * human-readable shape (`Script running with cell ID 7` / `Process running
 * with session ID s1`) and the STRUCTURED JSON shape (a result object
 * carrying `session_id` / `cell_id`) are decoded; anything else yields
 * null.
 * @param {string} outputText
 * @returns {{kind: string, value: string}|null}
 */
function extractLiveHandle(outputText) {
  const human = /(cell|session) ID ([^\s\n",}]+)/.exec(outputText);
  if (human !== null) return { kind: human[1], value: human[2] };
  const structured = /["']?(session_id|cell_id)["']?\s*:\s*"?([\w.-]+)"?/.exec(outputText);
  if (structured !== null) return { kind: structured[1] === 'cell_id' ? 'cell' : 'session', value: structured[2] };
  return null;
}

/**
 * Whether an observation output describes a LIVE process: an explicit
 * `running` text, or a STRUCTURED result carrying a handle WITHOUT a
 * completed/exited/finished status (a bare structured yield return like
 * `{"session_id":17,"output":"","wall_time_seconds":30}` is a live
 * process's re-entry). The OUTER wrapper's `Script completed` header does
 * not decide inner-process liveness: the inner result after the header
 * does.
 * @param {string} outputText
 * @returns {boolean}
 */
function isLiveObservationOutput(outputText) {
  // Explicit running text is liveness wherever it appears (the human
  // `Script running with cell ID N` header is itself the liveness fact).
  if (/running/i.test(outputText)) return true;
  // A completed wrapper can still carry a LIVE inner result after its
  // completion header (`Script completed\n{"session_id":17,...}`): the
  // header is stripped before the structured test so the inner result
  // decides.
  const innerText = outputText.replace(/^\s*Script (?:completed|running)[^\n]*\n/i, '');
  const hasStructuredHandle = /["']?(?:session_id|cell_id)["']?\s*:/.test(innerText);
  return hasStructuredHandle && !/completed|exited|finished/i.test(innerText);
}

/**
 * The effective TEXT of a tool output: a string as-is, or — the pinned
 * code-mode rollout shape — an array of content items whose `text` fields
 * concatenate. Anything else is empty.
 * @param {{output?: unknown}} payload
 * @returns {string}
 */
function outputTextOf(payload) {
  if (typeof payload.output === 'string') return payload.output;
  if (Array.isArray(payload.output)) {
    return payload.output
      .map((item) => (item !== null && typeof item === 'object' && typeof item.text === 'string' ? item.text : ''))
      .join('');
  }
  return '';
}

/**
 * The EFFECTIVE `yield_time_ms` value of an argument text: only keys of the
 * OUTER argument object count (NESTED object keys —
 * `60000 + ({yield_time_ms:5000}).x` — never overwrite the measurement),
 * the LAST top-level key wins (JavaScript duplicate-key semantics), and its
 * value must be a complete numeric literal followed by a value delimiter —
 * an unsupported expression or a trailing spread leaves the request
 * unclassified (null). Quoted keys (`{"yield_time_ms": N}`) are detected
 * before quote handling so the key is never swallowed as string content.
 * @param {string} text
 * @returns {number|null}
 */
function effectiveYieldValue(text) {
  const trimmed = text.trim();
  const baseDepth = trimmed.startsWith('{') ? 1 : 0;
  let depth = 0;
  let inQuote = null;
  let lastResult = null;
  let lastKeyEnd = -1;
  // The previous NON-WHITESPACE character, tracked INCREMENTALLY: a rescan
  // of the whole prefix per character made extraction quadratic, and the
  // 1 MiB line limit permits pathological padding that delayed cleanup past
  // the observation budget. The initial `{` opens the argument object, so
  // the first property already sits at a property boundary.
  let prevNonSpace = '{';
  for (let pos = 0; pos < trimmed.length; pos += 1) {
    const ch = trimmed[pos];
    if (inQuote !== null) {
      if (ch === '\\') pos += 1;
      else if (ch === inQuote) inQuote = null;
      else if (!/\s/.test(ch)) prevNonSpace = ch;
      continue;
    }
    if (/\s/.test(ch)) continue;
    const isQuote = ch === '"' || ch === "'";
    const atPropertyStart = prevNonSpace === '{' || prevNonSpace === ',';
    // An ACCESSOR override (`get yield_time_ms(){...}`) can replace the
    // literal's value at runtime — fail closed (top-level property
    // positions only, checked against the CURRENT boundary — never a
    // suffix rescan).
    if (depth === baseDepth && atPropertyStart && /\bget\s+["']?yield_time_ms["']?/.test(trimmed.slice(pos, pos + 32))) return null;
    if (isQuote && !atPropertyStart) {
      // A string VALUE (not a quoted key): skip its contents.
      inQuote = ch;
      continue;
    }
    if (ch === '[' && atPropertyStart && depth === baseDepth) {
      // A COMPUTED key in property position: only a QUOTED string literal
      // is the supported form (`["yield_time_ms"]`); an unresolved
      // identifier can evaluate to anything — fail closed. Participates in
      // LAST-PROPERTY-WINS like a bare key.
      const closeBracket = trimmed.indexOf(']', pos + 1);
      if (closeBracket === -1) return null;
      const rawContent = trimmed.slice(pos + 1, closeBracket).trim();
      if (!/^["']/.test(rawContent)) return null;
      const content = rawContent.replaceAll(/^["']|["']$/g, '');
      if (content !== 'yield_time_ms') return null;
      let valueCursor = closeBracket + 1;
      while (valueCursor < trimmed.length && /[\s:]/.test(trimmed[valueCursor])) valueCursor += 1;
      const computedLiteral = /^([\d_]+)(?=\s*[,})]|$)/.exec(trimmed.slice(valueCursor));
      lastResult = computedLiteral === null ? null : Number(computedLiteral[1].replaceAll('_', ''));
      lastKeyEnd = valueCursor;
      pos = valueCursor;
      prevNonSpace = ')';
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      prevNonSpace = ch;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      prevNonSpace = ch;
      continue;
    }
    const bareKey = !isQuote && trimmed.startsWith('yield_time_ms', pos);
    const quotedKey = isQuote && trimmed.startsWith('yield_time_ms', pos + 1);
    // NESTED object keys never count: only the OUTER argument object's
    // properties are requests.
    if (depth !== baseDepth || !atPropertyStart || (!bareKey && !quotedKey)) {
      if (isQuote) inQuote = ch;
      else prevNonSpace = ch;
      continue;
    }
    // A COMPLETE literal followed by an actual VALUE DELIMITER: operator
    // tails (`60000 % 7000`, `60000 ? 5000 : 1000`) and expressions are
    // unsupported — unclassified.
    let cursor = pos + (quotedKey ? 'yield_time_ms'.length + 2 : 'yield_time_ms'.length);
    if (quotedKey && (trimmed[cursor] === '"' || trimmed[cursor] === "'")) cursor += 1;
    while (cursor < trimmed.length && /[\s:]/.test(trimmed[cursor])) cursor += 1;
    const literal = /^([\d_]+)(?=\s*[,})]|$)/.exec(trimmed.slice(cursor));
    lastResult = literal === null ? null : Number(literal[1].replaceAll('_', ''));
    lastKeyEnd = cursor;
    pos = cursor;
    prevNonSpace = ')';
  }
  if (lastResult === null) return null;
  if (trimmed.slice(lastKeyEnd).includes('...')) return null;
  return lastResult;
}

/**
 * The end index of the statement starting at `start`: bracket-depth aware
 * (strings skipped), terminating at the first top-level `;` or newline.
 * Used to bound an async helper's DECLARATION+BODY region so an operation
 * site in a LATER statement is never attributed to the helper.
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function statementEndIndex(text, start) {
  let depth = 0;
  let inQuote = null;
  for (let pos = start; pos < text.length; pos += 1) {
    const ch = text[pos];
    if (inQuote !== null) {
      if (ch === '\\') pos += 1;
      else if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inQuote = ch;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
    else if (depth === 0 && (ch === ';' || ch === '\n')) return pos;
  }
  return text.length;
}

/**
 * The end of a helper DECLARATION for the invocation scans: an arrow-form
 * declaration (`const f = ...`) ends at its statement end, but a
 * `function`-form declaration ENDS AT ITS BODY'S CLOSING BRACE — an
 * invocation sharing the line after the body (`function poll(){...}
 * poll();`) is NOT part of the declaration.
 * @param {string} text
 * @param {number} declarationIndex
 * @returns {number}
 */
function helperDeclarationEndIndex(text, declarationIndex) {
  const head = text.slice(declarationIndex, declarationIndex + 32);
  if (!/^\s*(?:async\s+)?function\b/.test(head)) return statementEndIndex(text, declarationIndex);
  // The body brace is the first `{` outside quotes and outside the
  // parameter list.
  let parenDepth = 0;
  let inQuote = null;
  for (let pos = declarationIndex; pos < text.length; pos += 1) {
    const ch = text[pos];
    if (inQuote !== null) {
      if (ch === '\\') pos += 1;
      else if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inQuote = ch;
      continue;
    }
    if (ch === '(' || ch === '[') parenDepth += 1;
    else if (ch === ')' || ch === ']') parenDepth -= 1;
    else if (ch === '{' && parenDepth === 0) {
      const bodyEnd = balancedBraceEnd(text, pos);
      return bodyEnd === -1 ? statementEndIndex(text, declarationIndex) : bodyEnd + 1;
    }
  }
  return statementEndIndex(text, declarationIndex);
}

/**
 * The number of INDEPENDENTLY DISPATCHED polling branches inside one
 * dispatch range: a shell operation inside a NESTED FUNCTION body of the
 * range is a callback branch (invoked with the dispatch, possibly N times
 * through .map/.forEach/.filter/.flatMap), and TWO such branches run
 * concurrently with each other. A shell operation DIRECTLY in the range
 * arguments (no nested function) executes exactly once, and multiple
 * awaited operations inside ONE callback are sequential — neither overlaps.
 * @param {string} text
 * @param {number} rangeStart
 * @param {number} rangeEnd
 * @param {number[]} siteStarts
 * @returns {number}
 */
function rangePollingBranches(text, rangeStart, rangeEnd, siteStarts) {
  const sitesInRange = siteStarts.filter((site) => site > rangeStart && site < rangeEnd);
  if (sitesInRange.length === 0) return 0;
  const bodies = [];
  const functionPattern = /=>|\bfunction\b/g;
  functionPattern.lastIndex = rangeStart;
  let match;
  while ((match = functionPattern.exec(text)) !== null && match.index < rangeEnd) {
    const bodyStart = match.index + match[0].length;
    const bodyEnd = Math.min(statementEndIndex(text, match.index), rangeEnd);
    if (sitesInRange.some((site) => site > bodyStart && site < bodyEnd)) bodies.push(bodyStart);
  }
  if (bodies.length >= 2) return bodies.length;
  if (bodies.length === 1) {
    const rangeText = text.slice(rangeStart, rangeEnd);
    const methodMatch = /\.(map|forEach|filter|flatMap)\s*\(/.exec(rangeText);
    if (methodMatch !== null) {
      // Receiver cardinality decides: one element (or none) runs the
      // callback at most once — never an overlap.
      const elements = receiverElementCount(text, rangeStart + methodMatch.index + 1);
      if (elements === null || elements >= 2) return 1;
    }
  }
  return 0;
}

/**
 * The close-paren index of the call whose `(` sits at `openParenIndex`, or
 * -1 when unbalanced (strings skipped, same lexical model).
 * @param {string} text
 * @param {number} openParenIndex
 * @returns {number}
 */
function balancedRangeEnd(text, openParenIndex) {
  let depth = 0;
  let inQuote = null;
  for (let pos = openParenIndex; pos < text.length; pos += 1) {
    const ch = text[pos];
    if (inQuote !== null) {
      if (ch === '\\') pos += 1;
      else if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inQuote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return pos;
    }
  }
  return -1;
}

/**
 * The element count of the array-literal receiver directly before an array
 * method (`[1,2].map` → 2), or null when the receiver is not a literal
 * (unproven).
 * @param {string} text
 * @param {number} methodNameStart
 * @returns {number|null}
 */
function receiverElementCount(text, methodNameStart) {
  const receiverMatch = /\[\s*([^\][]*)\]\s*\.\s*$/.exec(text.slice(0, methodNameStart));
  if (receiverMatch === null) return null;
  const inner = receiverMatch[1].trim();
  return inner.length === 0 ? 0 : inner.split(',').length;
}

/**
 * The number of polling branches launched by REPEATED callback dispatches
 * OUTSIDE Promise combinators — `[1,2].forEach(async () => await
 * tools.write_stdin(...))` runs one lexical site N times. An array-literal
 * receiver with fewer than two elements cannot overlap and is skipped; a
 * non-literal receiver's element count is unproven (flagged).
 * @param {string} text
 * @param {number[]} siteStarts
 * @param {number[][]} dispatchRanges
 * @param {string[]} pollingHelperNames
 * @returns {number}
 */
function repeatedCallbackDispatchBranches(text, siteStarts, dispatchRanges, pollingHelperNames) {
  let branches = 0;
  for (const methodName of ['forEach', 'map', 'filter', 'flatMap']) {
    for (const openParen of callSitesForOperation(text, methodName)) {
      const closeParen = balancedRangeEnd(text, openParen);
      if (closeParen === -1) continue;
      // Combinator-internal iterations are the DISPATCH RANGES' business
      // (rangePollingBranches): never double-count them here.
      if (dispatchRanges.some(([rangeStart, rangeEnd]) => openParen > rangeStart && openParen < rangeEnd)) continue;
      // A NAMED polling callback (`[1,2].forEach(poll)`) dispatches with
      // the receiver's multiplicity, exactly like an inline body.
      const namedReference = new RegExp(`(?:${methodName})\\s*\\(\\s*([\\w$]+)\\s*\\)`).exec(text.slice(openParen - methodName.length, closeParen + 1));
      if (namedReference !== null && pollingHelperNames.includes(namedReference[1])) {
        const elements = receiverElementCount(text, openParen - methodName.length);
        if (elements === null || elements >= 2) {
          branches += 2;
          break;
        }
        continue;
      }
      // The callback must contain a POLLING operation before anything is
      // flagged: an unrelated `.map(line => line.trim())` formatter near a
      // sequential poll is not a repeated dispatch.
      const functionPattern = /=>|\bfunction\b/g;
      functionPattern.lastIndex = openParen;
      let match;
      let bodyHasOperation = false;
      while ((match = functionPattern.exec(text)) !== null && match.index < closeParen) {
        const bodyStart = match.index + match[0].length;
        const bodyEnd = Math.min(statementEndIndex(text, match.index), closeParen);
        if (siteStarts.some((site) => site > bodyStart && site < bodyEnd)) {
          bodyHasOperation = true;
          break;
        }
      }
      if (!bodyHasOperation) continue;
      const elements = receiverElementCount(text, openParen - methodName.length);
      if (elements === null) return Math.max(branches, 2);
      if (elements < 2) continue;
      branches += 2;
    }
  }
  return branches;
}

/**
 * The close-brace index of the `{` at `openBraceIndex`, or -1 when
 * unbalanced (strings skipped, same lexical model).
 * @param {string} text
 * @param {number} openBraceIndex
 * @returns {number}
 */
function balancedBraceEnd(text, openBraceIndex) {
  let depth = 0;
  let inQuote = null;
  for (let pos = openBraceIndex; pos < text.length; pos += 1) {
    const ch = text[pos];
    if (inQuote !== null) {
      if (ch === '\\') pos += 1;
      else if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inQuote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return pos;
    }
  }
  return -1;
}

/**
 * Whether a `for`/`while` loop body contains a shell operation: a loop
 * re-executes its body site N times — overlapping observations.
 * @param {string} text
 * @param {number[]} siteStarts
 * @returns {boolean}
 */
function loopBodyContainsOperation(text, siteStarts) {
  for (const keyword of ['for', 'while']) {
    for (const openParen of callSitesForOperation(text, keyword)) {
      const closeParen = balancedRangeEnd(text, openParen);
      if (closeParen === -1) continue;
      let bodyStart = closeParen + 1;
      while (bodyStart < text.length && /\s/.test(text[bodyStart])) bodyStart += 1;
      let bodyEnd;
      if (text[bodyStart] === '{') {
        const closeBrace = balancedBraceEnd(text, bodyStart);
        bodyEnd = closeBrace === -1 ? text.length : closeBrace;
      } else {
        bodyEnd = statementEndIndex(text, bodyStart);
      }
      for (const site of siteStarts) {
        if (site <= bodyStart || site >= bodyEnd) continue;
        // An AWAITED body poll serializes iterations (one active
        // observation at a time) — directly, or through a stored-promise
        // variable awaited later in the same body
        // (`for (...) { const p = tools.write_stdin(...); await p; }`).
        if (isDirectlyAwaited(text, site)) continue;
        const assignMatch = new RegExp(`([\\w$]+)\\s*=\\s*(?:[\\w$]+\\s*\\.\\s*)*\\s*$`).exec(text.slice(0, site));
        if (assignMatch !== null) {
          const varName = assignMatch[1].replaceAll('$', '\\$&');
          const bodyTail = stripStringValuesKeepKeys(stripSegmentComments(text.slice(site, bodyEnd)));
          // An UNCONDITIONAL await of the stored promise settles the
          // observation: it must START A STATEMENT in the body tail — a
          // conditional await (`if (false) await p;`) settles nothing.
          if (new RegExp(`(?:^|[;}]\\s*)await\\s+${varName}\\b`).test(bodyTail)) continue;
        }
        return true;
      }
    }
  }
  return false;
}

/**
 * The number of polling-helper INVOCATIONS inside concurrent dispatches:
 * an async helper whose OWN statement contains a shell operation (`async
 * function poll() { await tools.write_stdin(...) }`) contributes one
 * observation per dispatch invocation — two or more overlap. BOTH
 * declaration forms count (variable-declared arrows and `async function`
 * declarations); the operation must sit inside the helper's statement
 * (bracket-depth bounded), so an operation in a LATER statement — or a
 * dispatched helper with no shell operation at all (`const f = async ()
 * => 1`) — is never attributed to it.
 * @param {string} callText
 * @param {number[]} siteStarts
 * @param {number[][]} dispatchRanges
 * @returns {number}
 */
function dispatchedPollingHelperInvocations(callText, siteStarts, dispatchRanges) {
  // Promise-returning helpers WITHOUT an `async` keyword (`function
  // poll() { return tools.write_stdin(...) }`) dispatch the same way —
  // all declaration forms join, deduplicated by name.
  // Ordinary promise-returning arrows (`const poll = () =>
  // tools.write_stdin(...)`) dispatch the same way — omitting the
  // `async` keyword must not bypass detection.
  const helpers = [
    ...[...callText.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\b)?\s*(?:\([^)]*\)|[\w$]+)\s*=>/g)].map((match) => ({ name: match[1], declStart: match.index })),
    ...[...callText.matchAll(/\b(?:async\s+)?function\s+([\w$]+)/g)].map((match) => ({ name: match[1], declStart: match.index })),
  ].filter((helper, index, all) => all.findIndex((other) => other.name === helper.name) === index);
  // Counts are evaluated PER DISPATCH RANGE and the maximum wins:
  // sequential awaited dispatches (`await Promise.all([poll()]);
  // await Promise.all([poll()]);`) never overlap — only two or more
  // invocations inside ONE dispatch do. Named callback references
  // (`[1,2].map(poll)`) are dispatches too, counted with their array's
  // multiplicity.
  let maxInvocations = 0;
  for (const [rangeStart, rangeEnd] of dispatchRanges) {
    const rangeText = callText.slice(rangeStart + 1, rangeEnd);
    let rangeCount = 0;
    for (const { name, declStart } of helpers) {
      const statementEnd = statementEndIndex(callText, declStart);
      const statementHasOperation = siteStarts.some((start) => start > declStart && start < statementEnd);
      if (!statementHasOperation) continue;
      rangeCount += callSitesForOperation(stripSegmentComments(rangeText), name).length;
      // A NAMED callback reference (`[1,2].map(poll)`) dispatches with the
      // RECEIVER's multiplicity — one element runs it once, none runs it
      // never; an unknown receiver is unproven (two branches).
      const methodReference = new RegExp(`\\.(?:map|forEach|filter|flatMap)\\s*\\(\\s*${name}\\s*\\)`).exec(rangeText);
      if (methodReference !== null) {
        const elements = receiverElementCount(callText, rangeStart + 1 + methodReference.index + 1);
        rangeCount += elements === null ? 2 : elements;
      } else if (new RegExp(`\\b${name}\\b(?!\\s*\\()`).test(rangeText)) {
        rangeCount += 1;
      }
    }
    maxInvocations = Math.max(maxInvocations, rangeCount);
  }
  return maxInvocations;
}

/**
 * Whether a call REFERENCES the worker chain's returned handle. The handle
 * KIND is preserved: a CELL handle (a suspended script's `cell ID N`) is
 * referenced only through `cell_id`, and a SESSION handle (a live
 * process's `session ID S`) only through `session_id`/`id` — a marker
 * from an observation of the OTHER namespace never credits. References
 * come from structured arguments or the ACTUAL argument segment of a
 * wait/write_stdin call site (comment-stripped; quoted text and comments
 * elsewhere never establish a reference). The comparison requires an
 * EXACT, COMPLETE literal value — `17 + 1` or `"s1" + suffix` poll a
 * different effective handle and never match.
 * @param {string} callText
 * @param {{cell_id?: unknown, session_id?: unknown, id?: unknown}|null} args
 * @param {{kind: string, value: string}} handle
 * @param {string} operation the observing tool name (`wait` observes CELL handles; `write_stdin` observes SESSION handles)
 * @returns {boolean}
 */
function referencesChainHandle(callText, args, handle, operation) {
  // The KIND and the OBSERVING OPERATION must agree: a CELL handle is
  // observed by a structured `wait` call or a wait(...) site; a SESSION
  // handle by a `write_stdin` — `write_stdin({session_id:999, cell_id:7})`
  // observes session 999, and its cell_id field is inert.
  // STRUCTURED calls carry the operation in their tool name: a cell handle
  // is only observed by `wait`, a session handle only by `write_stdin` —
  // `write_stdin({session_id:999, cell_id:7})` observes session 999 and its
  // cell_id field is inert. DSL scripts (no structured args) are governed
  // by the site loop below, which scopes cell handles to wait(...) sites
  // and session handles to write_stdin(...) sites.
  if (args !== null) {
    const kindMatchesOperation = handle.kind === 'cell' ? operation === 'wait' : operation === 'write_stdin';
    if (!kindMatchesOperation) return false;
    // CONFLICTING handle aliases (`{session_id:999, id:17}`) leave the
    // effective handle host-defined — unproven, never matched.
    const aliases = handle.kind === 'cell'
      ? [args.cell_id].filter((v) => v !== undefined)
      : [args.session_id, args.id].filter((v) => v !== undefined);
    const stringAliases = aliases.map((v) => String(v));
    if (new Set(stringAliases).size > 1) return false;
    return stringAliases.length === 1 && stringAliases[0] === handle.value;
  }
  const effectiveScript = stripSegmentComments(callText);
  const escaped = handle.value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyAlternation = handle.kind === 'cell' ? 'cell_id' : '(?:session_id|id)';
  // COMPLETE literal only: the value must end at a delimiter (an optional
  // closing quote for string-passed handles — `{id:"17"}` polls 17), so
  // `17 + 1` (which polls 18) and `"s1" + suffix` never match their
  // prefixes.
  const literalPattern = new RegExp(`(?:^|[{,(])\\s*["']?(?:${keyAlternation})["']?\\s*:\\s*["']?${escaped}["']?\\s*(?=[,})\\n]|$)`);
  for (const operationName of handle.kind === 'cell' ? ['wait'] : ['write_stdin']) {
    for (const site of callSitesForOperation(effectiveScript, operationName)) {
      const segment = balancedCallSegment(effectiveScript, site);
      if (segment === null) continue;
      // AMBIGUOUS handles never match: a spread or a duplicate handle key
      // (`{session_id:17,session_id:999}` polls 999) means the EFFECTIVE
      // handle differs from any literal in the text. A COMPUTED property
      // (`["session_id"]:999`) executes unresolvably — same rule.
      if (segment.includes('...')) continue;
      if (/(?:^|[{,])\s*\[[^\][]*\]\s*:/.test(stripSegmentComments(segment))) continue;
      const handleKeyCount = [...segment.matchAll(new RegExp(`["']?(?:${keyAlternation})["']?\\s*:`, 'g'))].length;
      if (handleKeyCount !== 1) continue;
      if (literalPattern.test(segment)) return true;
    }
  }
  return false;
}

/**
 * The [start, end] ranges of Promise.all/allSettled/race/any dispatches —
 * detected ONLY at executable lexical positions (quoted strings and
 * comments are skipped, so a printed or commented `Promise.all(...)` is
 * never a dispatch). Operation sites inside any range belong to a
 * CONCURRENT dispatch even when each is awaited locally — a local `await`
 * orders statements within one callback, never across independently
 * scheduled callbacks.
 * @param {string} text
 * @returns {number[][]}
 */
function concurrentDispatchRanges(text) {
  const ranges = [];
  let inQuote = null;
  for (let pos = 0; pos < text.length; pos += 1) {
    const ch = text[pos];
    if (inQuote !== null) {
      if (ch === '\\') pos += 1;
      else if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inQuote = ch;
      continue;
    }
    if (ch === '/' && text[pos + 1] === '*') {
      const end = text.indexOf('*/', pos + 2);
      if (end === -1) break;
      pos = end + 1;
      continue;
    }
    if (ch === '/' && text[pos + 1] === '/') {
      const newline = text.indexOf('\n', pos);
      if (newline === -1) break;
      pos = newline;
      continue;
    }
    if (ch === '/' && isRegexLiteralStart(text, pos)) {
      const regexEnd = regexLiteralEnd(text, pos);
      if (regexEnd === -1) break;
      pos = regexEnd;
      continue;
    }
    if (text.startsWith('Promise', pos)) {
      let probe = pos + 'Promise'.length;
      while (probe < text.length && /\s/.test(text[probe])) probe += 1;
      if (text[probe] !== '.') continue;
      probe += 1;
      while (probe < text.length && /\s/.test(text[probe])) probe += 1;
      const keyword = /^(allSettled|all|race|any)/.exec(text.slice(probe));
      if (keyword === null) continue;
      probe += keyword[1].length;
      while (probe < text.length && /\s/.test(text[probe])) probe += 1;
      if (text[probe] !== '(') continue;
      const openParen = probe;
      let depth = 0;
      let innerQuote = null;
      let closed = false;
      for (let scan = openParen; scan < text.length; scan += 1) {
        const inner = text[scan];
        if (innerQuote !== null) {
          if (inner === '\\') scan += 1;
          else if (inner === innerQuote) innerQuote = null;
          continue;
        }
        if (inner === '"' || inner === "'" || inner === '`') {
          innerQuote = inner;
          continue;
        }
        if (inner === '/' && text[scan + 1] === '*') {
          const end = text.indexOf('*/', scan + 2);
          if (end === -1) break;
          scan = end + 1;
          continue;
        }
        if (inner === '/' && text[scan + 1] === '/') {
          const newline = text.indexOf('\n', scan);
          if (newline === -1) break;
          scan = newline;
          continue;
        }
        if (inner === '(') depth += 1;
        else if (inner === ')') {
          depth -= 1;
          if (depth === 0) {
            ranges.push([openParen, scan]);
            closed = true;
            break;
          }
        }
      }
      if (closed) pos = probe;
    }
  }
  return ranges;
}

/**
 * Whether the call whose name starts at `callNameStart` is DIRECTLY
 * awaited — an `await` keyword (optionally followed by the receiver chain)
 * immediately precedes it, making it a SEQUENTIAL observation rather than
 * a concurrent dispatch.
 * @param {string} text
 * @param {number} callNameStart
 * @returns {boolean}
 */
function isDirectlyAwaited(text, callNameStart) {
  // Comments and one level of parens between `await` and the receiver are
  // valid syntax (`await /* observation */ tools.x(...)`,
  // `await (tools.x(...))`): the prefix is comment-stripped before the
  // await-tail test.
  const prefix = text.slice(0, callNameStart)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  return /\bawait\s*\(?\s*(?:[\w$]+\s*\.\s*)*$/.test(prefix);
}

/**
 * The balanced-paren argument segment of a call whose `(` sits at
 * `openParenIndex`, using the SAME lexical model as callSitesForOperation
 * (strings, template literals, and comments are skipped, so a `)` inside
 * any of them cannot terminate the segment early). Unbalanced text yields
 * null — the caller treats that as UNCLASSIFIED, never as an empty
 * observation.
 * @param {string} text
 * @param {number} openParenIndex
 * @returns {string|null}
 */
function balancedCallSegment(text, openParenIndex) {
  let depthParens = 0;
  let inQuote = null;
  for (let pos = openParenIndex; pos < text.length; pos += 1) {
    const ch = text[pos];
    if (inQuote !== null) {
      if (ch === '\\') pos += 1;
      else if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inQuote = ch;
      continue;
    }
    if (ch === '/' && text[pos + 1] === '*') {
      const end = text.indexOf('*/', pos + 2);
      if (end === -1) return null;
      pos = end + 1;
      continue;
    }
    if (ch === '#' || (ch === '/' && text[pos + 1] === '/')) {
      const newline = text.indexOf('\n', pos);
      if (newline === -1) return null;
      pos = newline;
      continue;
    }
    if (ch === '/' && isRegexLiteralStart(text, pos)) {
      const regexEnd = regexLiteralEnd(text, pos);
      if (regexEnd === -1) return null;
      pos = regexEnd;
      continue;
    }
    if (ch === '(') depthParens += 1;
    else if (ch === ')') {
      depthParens -= 1;
      if (depthParens === 0) return text.slice(openParenIndex + 1, pos);
    }
  }
  return null;
}

/**
 * Bounded model-decision summarizer over the session rollouts the host wrote
 * into the isolated Codex home. Counts only closed, non-content facts:
 * assistant-message/reasoning/function-call counts, per-tool-name counts,
 * the yields the model actually requested per call, a strict call/output
 * alternation check (a second call while the first is still pending is the
 * parallel-poll violation the plan forbids), and epoch-ms timestamps parsed
 * from the rollout `timestamp` fields. No rollout text is retained — the
 * summary contains counts, tool names, integers, and timestamps only.
 *
 * The shell-tool classification follows the source-pinned unified-exec
 * argument shapes: `cmd` = an initial exec_command call; a string `input` is
 * a write_stdin poll (empty string = the empty poll whose configured window
 * Task 3 measures). Any other tool call counts under its own name.
 *
 * @param {{sessionsDirectory: string, maxFiles?: number, maxRecordsPerFile?: number, maxLineBytes?: number, maxFileBytes?: number, workerEvidenceToken?: string}} input
 * @returns {Promise<SessionSummary>}
 */
export async function summarizeCodexSessions(input) {
  const sessionsDirectory = input.sessionsDirectory;
  if (!isAbsolute(sessionsDirectory)) throw driverError('WAIT_ROUTE_DRIVER_SESSION_RELATIVE', 'The sessions directory must be an absolute path.');
  const maxFiles = input.maxFiles ?? SESSION_MAX_FILES;
  const maxRecordsPerFile = input.maxRecordsPerFile ?? SESSION_MAX_RECORDS_PER_FILE;
  const maxLineBytes = input.maxLineBytes ?? SESSION_MAX_LINE_BYTES;
  const maxFileBytes = input.maxFileBytes ?? SESSION_MAX_FILE_BYTES;
  /** @type {{records: number, functionCalls: number, initialExecCalls: number, emptyPolls: number}[]} */
  const perFile = [];
  /** @type {Record<string, number>} */
  const toolNames = {};
  /** @type {number[]} */
  const requestedYieldsMs = [];
  /** @type {SessionSummary} */
  const summary = {
    present: false,
    files: 0,
    truncated: false,
    assistantMessages: 0,
    reasoningItems: 0,
    functionCalls: 0,
    functionCallOutputs: 0,
    initialExecCalls: 0,
    emptyPolls: 0,
    otherFunctionCalls: 0,
    toolNames,
    requestedYieldsMs,
    requestedYieldCount: 0,
    parallelToolCallViolations: 0,
    firstFunctionCallAtMs: null,
    firstEmptyPollAtMs: null,
    lastFunctionCallOutputAtMs: null,
    /** Bounded per-call samples for the report's clamp analysis (atMs from the rollout timestamp). @type {SessionSummary['calls']} */
    calls: [],
    callsTruncated: false,
    perFile,
  };
  const directoryStats = await stat(sessionsDirectory).catch((error) => {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  });
  if (directoryStats === null || !directoryStats.isDirectory()) return summary;
  summary.present = true;
  // WALL-CLOCK bound: a hostile script (thousands of awaited polls) makes
  // per-site serialization scans slow, and summarization runs BEFORE worker
  // settlement — unbounded analysis would delay cleanup and signal
  // handling. When the budget expires the scan stops and reports
  // truncation (failing the exactly-one-spawn grant closed).
  const analysisDeadline = Date.now() + 10_000;
  // DISCOVERY itself is bounded: the sessions tree is model-writable, so a
  // hostile or runaway tree (deep nesting, many files) must not let the
  // recursive walk materialize unbounded entries or stat unbounded files.
  // The walk stops at the discovery-entry cap and reports truncation —
  // an incomplete scan fails closed downstream (the role-control grant
  // requires an untruncated scan).
  const listed = [];
  /** Directories still to visit. @type {string[]} */
  const pendingDirectories = [sessionsDirectory];
  let visitedEntries = 0;
  while (pendingDirectories.length > 0 && visitedEntries <= SESSION_MAX_DISCOVERY_ENTRIES) {
    const directory = pendingDirectories.shift();
    if (directory === undefined) break;
    // INCREMENTAL enumeration: opendir/read never materializes a whole
    // directory's Dirent array, so one huge model-writable directory
    // cannot exhaust memory before the entry budget is checked. An
    // UNREADABLE directory or entry is a DISCOVERY ERROR — the scan
    // cannot claim completeness over a subtree it never saw, so it
    // reports truncation (the role-control grant fails closed on it)
    // instead of silently skipping.
    const opened = await opendir(directory).then((handle) => handle, () => null);
    if (opened === null) {
      summary.truncated = true;
      continue;
    }
    for (;;) {
      /** @type {import('node:fs').Dirent|null} */
      let entry = null;
      try {
        entry = await opened.read();
      } catch {
        summary.truncated = true;
        await opened.close().catch(() => { /* best-effort close */ });
        break;
      }
      if (entry === null) {
        await opened.close().catch(() => { /* best-effort close */ });
        break;
      }
      visitedEntries += 1;
      if (visitedEntries > SESSION_MAX_DISCOVERY_ENTRIES) {
        summary.truncated = true;
        await opened.close().catch(() => { /* best-effort close */ });
        break;
      }
      if (entry.isDirectory()) pendingDirectories.push(join(directory, entry.name));
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) listed.push(join(directory, entry.name));
    }
  }
  const rolloutFiles = listed;
  // Newest first: a kill-interrupted run may leave a partially flushed
  // rollout, and the newest files are the ones this run wrote. Metadata
  // inspection is bounded by the same cap (the entry cap bounds the file
  // count before any stat).
  /** @type {{path: string, mtimeMs: number}[]} */
  const stamped = [];
  for (const path of rolloutFiles) {
    const stats = await stat(path).catch(() => null);
    // A discovered rollout whose metadata cannot be read is a MISSING
    // observation: the scan is incomplete (the exactly-one-spawn grant
    // fails closed on it), never silently complete.
    if (stats === null) summary.truncated = true;
    else stamped.push({ path, mtimeMs: stats.mtimeMs });
  }
  stamped.sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (stamped.length > maxFiles) {
    summary.truncated = true;
    stamped.length = maxFiles;
  }
  summary.files = stamped.length;
  // Root/Child identification is CONTENT-BASED, decided DURING the bounded
  // per-line scan: a rollout containing a spawn_agent call is the Root
  // session (the host spawns the managed child from Root); every other
  // rollout is a child. No unbounded pre-read of model-writable files.
  /** @type {string|null} */
  let rootRolloutPath = null;
  let childExecSeen = false;
  // BOUNDED synthetic-role fact: whether a spawn_agent call's ARGUMENTS name
  // the synthetic role. Only the boolean survives the scan (privacy) — the
  // role-control grant requires it so a spawn for a default/other role
  // cannot corroborate the managed-child lifecycle.
  let spawnedSyntheticRole = false;
  // Bounded spawn/answer facts: how many spawn_agent calls were made IN
  // FULL (not sampled — the grant requires exactly one), the call id of
  // THE synthetic-role spawn, and whether that spawn's output was
  // observed. Only the count, the boolean, and the single call id survive
  // the scan.
  /** @type {number} */
  let spawnCallCount = 0;
  /** @type {string|null} */
  let syntheticSpawnCallId = null;
  let syntheticSpawnAnswered = false;
  /** Per-rollout initial-exec facts, resolved after Root identification. @type {Map<string, boolean>} */
  const fileHadInitialExecByPath = new Map();
  /** Per-file session-meta facts: own thread id and parent thread id. @type {Map<string, {id: unknown, parentThreadId: unknown}>} */
  const fileMetaByPath = new Map();
  /** Per-file fact: an exec there referenced the caller's worker evidence token. @type {Map<string, boolean>} */
  const fileExecMatchedWorker = new Map();
  for (const { path } of stamped) {
    // The pending-call set is PER-SESSION-ROLLOUT: call ids are only
    // unique within their owning session, and cross-session concurrency
    // would require a chronological merge of all rollouts — out of scope
    // for this bounded counter.
    const pendingCallIds = new Set();
  /** Yielded-script call ids: the outer output does not prove the inner write_stdin finished. @type {Set<string>} */
  const pendingYieldedScriptIds = new Set();
  /** The cell id being awaited across continuation calls. @type {number|null} */
  let pendingCellForAwait = null;
  /** Per-cell pending call ids: completion clears ONLY the finished cell's calls. @type {Map<number, Set<string>>} */
  const pendingCellCalls = new Map();
  /** Wrapped-wait chains: a wrapper cell settles its predecessor cell too. @type {Map<number, number>} */
  const cellPredecessorByCell = new Map();
  /** Per-call cell association: which cell EACH call yielded (call id → cell). @type {Map<string, number>} */
  const callIdToCell = new Map();
  /** Per-continuation cell association: which cell EACH wait call references. @type {Map<string, number>} */
  const waitCellByCallId = new Map();
  /** Pending worker-invocation matches: the matched exec call's id → its rollout. @type {Map<string, string>} */
  const workerExecCallOwner = new Map();
  /** Active observation chains: rollout → the matched exec returned a LIVE handle being observed through polls. @type {Map<string, boolean>} */
  const workerChainActiveByPath = new Map();
  /** The live handle (kind + id) each active chain observes: rollout → handle. @type {Map<string, {kind: string, value: string}>} */
  const workerChainHandleByPath = new Map();
  /** Chain calls (wait/write_stdin after the matched exec): call id → rollout. @type {Map<string, string>} */
  const workerChainCallOwner = new Map();
    const fileSummary = { records: 0, functionCalls: 0, initialExecCalls: 0, emptyPolls: 0 };
    perFile.push(fileSummary);
    const handle = await open(path, openNonBlockingFlags()).catch(() => {
      // A discovered rollout that cannot be OPENED — permissions OR vanished
      // between stat and open (ENOENT) — is a missing observation: the scan
      // is incomplete (the exactly-one-spawn grant fails closed on it),
      // never silently complete.
      summary.truncated = true;
      return null;
    });
    if (handle === null) continue;
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let carry = '';
    let fileBytes = 0;
    try {
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) {
          carry += decoder.end();
          if (carry.trim().length > 0) consumeRolloutLine(carry);
          break;
        }
        fileBytes += bytesRead;
        if (fileBytes > maxFileBytes) {
          summary.truncated = true;
          break;
        }
        carry += decoder.write(buffer.subarray(0, bytesRead));
        let newline = carry.indexOf('\n');
        let stopFile = false;
        while (newline >= 0) {
          const line = carry.slice(0, newline);
          carry = carry.slice(newline + 1);
          if (consumeRolloutLine(line)) { stopFile = true; break; }
          newline = carry.indexOf('\n');
        }
        if (stopFile) {
          summary.truncated = true;
          break;
        }
        if (carry.trim().length > 0 && Buffer.byteLength(carry, 'utf8') > maxLineBytes) {
          summary.truncated = true;
          break;
        }
      }
    } finally {
      await handle.close().catch(() => {});
    }

    /**
     * Consumes one rollout line against the bounds. Returns true when the
     * caller must stop reading (a bound was hit).
     * @param {string} line @returns {boolean}
     */
    function consumeRolloutLine(line) {
      if (line.trim().length === 0) return false;
      if (Date.now() > analysisDeadline) {
        summary.truncated = true;
        return true;
      }
      if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
        summary.truncated = true;
        return true;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A torn line (a killed host's last write) is a bound event, not
        // content: it reports truncation and is never parsed further.
        summary.truncated = true;
        return true;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      fileSummary.records += 1;
      if (fileSummary.records > maxRecordsPerFile) {
        summary.truncated = true;
        return true;
      }
      // The session-meta line carries the rollout's OWN thread id and (for
      // a spawned child) its PARENT thread id — the source-pinned spawn
      // edge used to correlate a child rollout with the Root session.
      // Retained only in this in-memory map; never reaches the summary.
      if (parsed.type === 'session_meta' && parsed.payload !== null && typeof parsed.payload === 'object') {
        fileMetaByPath.set(path, { id: parsed.payload.id, parentThreadId: parsed.payload.parent_thread_id });
        return false;
      }
      if (parsed.type !== 'response_item' || parsed.payload === null || typeof parsed.payload !== 'object') return false;
      const payload = parsed.payload;
      const atMs = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : Number.NaN;
      if (payload.type === 'message' && payload.role === 'assistant') summary.assistantMessages += 1;
      else if (payload.type === 'reasoning') summary.reasoningItems += 1;
      else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
        summary.functionCallOutputs += 1;
        // The synthetic spawn's output was observed: the call/output
        // alternation for THE synthetic-role spawn's call id is part of the
        // role-control grant (a spawn attempt without an output proves
        // nothing about a successful child).
        if (typeof payload.call_id === 'string' && payload.call_id === syntheticSpawnCallId) syntheticSpawnAnswered = true;
        // A matched worker invocation is credited only through ITS OWN
        // observation chain: the matched exec's result — or, while that
        // observation is still running, a wait/write_stdin poll of it —
        // carrying the worker's terminal marker. A marker in any OTHER
        // call's output (an `echo` of the marker after a failed exec) or
        // after the observation ended never credits.
        if (typeof payload.call_id === 'string') {
          const workerOutputText = outputTextOf(payload);
          if (workerExecCallOwner.get(payload.call_id) === path) {
            workerExecCallOwner.delete(payload.call_id);
            if (workerOutputText.includes(COMPLETION_MARKER)) {
              fileExecMatchedWorker.set(path, true);
              workerChainActiveByPath.set(path, false);
            } else {
              // ALL live-handle shapes keep the chain alive — the script's
              // `Script running with cell ID N`, the process handle's
              // `Process running with session ID S`, and the STRUCTURED
              // result `{"session_id":17,...}` (whose liveness comes from
              // the fields: a handle without a completed/exited status is
              // a live yield return). The chain is only trackable when the
              // output names the handle.
              const handleMatch = extractLiveHandle(workerOutputText);
              if (handleMatch !== null && isLiveObservationOutput(workerOutputText)) {
                workerChainActiveByPath.set(path, true);
                workerChainHandleByPath.set(path, handleMatch);
              } else {
                workerChainActiveByPath.set(path, false);
                workerChainHandleByPath.delete(path);
              }
            }
          } else if (workerChainCallOwner.get(payload.call_id) === path) {
            workerChainCallOwner.delete(payload.call_id);
            if (workerOutputText.includes(COMPLETION_MARKER)) {
              fileExecMatchedWorker.set(path, true);
              workerChainActiveByPath.set(path, false);
            } else if (!isLiveObservationOutput(workerOutputText)) {
              workerChainActiveByPath.set(path, false);
              workerChainHandleByPath.delete(path);
            } else {
              const handleMatch = extractLiveHandle(workerOutputText);
              if (handleMatch !== null) workerChainHandleByPath.set(path, handleMatch);
            }
          }
        }
        // A yielded script (either shape) resolves its pending state from
        // its observed OUTPUT: `Script running...` keeps the pending id (the
        // inner write_stdin is still active — a second poll is an
        // unproven-concurrency violation); `Script completed` clears it.
        if (typeof payload.call_id === 'string' && pendingYieldedScriptIds.has(payload.call_id)) {
          const outputText = outputTextOf(payload);
          if (outputText.includes('Script running')) {
            // The yielded script is running: remember its cell so the wait
            // continuation can be associated with the original pending call.
            const cellMatch = outputText.match(/cell ID (\d+)/);
            if (cellMatch !== null) {
              const yieldedCell = Number(cellMatch[1]);
              pendingCellForAwait = yieldedCell;
              callIdToCell.set(payload.call_id, yieldedCell);
              const cellCalls = pendingCellCalls.get(yieldedCell) ?? new Set();
              cellCalls.add(payload.call_id);
              pendingCellCalls.set(yieldedCell, cellCalls);
            }
          } else {
            // Completion resolves ONLY its own association: a call that
            // never yielded a cell just retires its own pending id; a call
            // that yielded cell N retires ONLY cell N — never the cell
            // another outstanding script is awaiting.
            pendingCallIds.delete(payload.call_id);
            pendingYieldedScriptIds.delete(payload.call_id);
            const ownCell = callIdToCell.get(payload.call_id);
            if (ownCell !== undefined) {
              callIdToCell.delete(payload.call_id);
              const finished = pendingCellCalls.get(ownCell) ?? new Set();
              for (const pendingId of finished) pendingCallIds.delete(pendingId);
              pendingCellCalls.delete(ownCell);
              if (pendingCellForAwait === ownCell) {
                pendingCellForAwait = null;
              }
            }
          }
        } else if (typeof payload.call_id === 'string') {
          const outputText = outputTextOf(payload);
          // ONLY a call explicitly mapped to a cell (a wait continuation
          // bound to its referenced cell at call time) may settle that
          // cell, and the mapping — NOT the latest-yield flag — decides:
          // with cells 7 and 8 outstanding, cell 8's completion clears the
          // latest-yield flag while cell 7 is still being observed, and
          // cell 7's later wait completion must still settle cell 7 here.
          // An unrelated call that happens to return `Script completed`
          // retires its own id and clears NOTHING.
          const mappedCell = waitCellByCallId.get(payload.call_id);
          if (mappedCell !== undefined) {
            // EVERY response retires THIS wait's mapping (a wait answered
            // with `Script running...` is no longer outstanding — a later
            // sequential wait for the same cell is not its overlap); the
            // CELL's pending state persists until an actual completion.
            waitCellByCallId.delete(payload.call_id);
            // The outer wrapper's `Script completed` header does not settle
            // the awaited cell when the SAME output announces a live inner
            // handle (`Script completed\nProcess running with session ID S`):
            // the inner observation is still active.
            if (outputText.includes('Script completed')) {
              // Capture the retired calls FIRST: if the same output exposes
              // a live inner cell, they are RESTORED (the original
              // observation stays pending until the inner cell completes).
              const retiredCalls = new Set(pendingCellCalls.get(mappedCell) ?? []);
              // The awaited CELL's completion settles it even when the SAME
              // output later announces a live process handle: the shell
              // observation returned; the handle is a NEW observation target
              // tracked separately (fresh polls of it start a new chain).
              const finished = pendingCellCalls.get(mappedCell) ?? new Set();
              for (const pendingId of finished) pendingCallIds.delete(pendingId);
              pendingCellCalls.delete(mappedCell);
              if (pendingCellForAwait !== null && pendingCellForAwait === mappedCell) {
                pendingCellForAwait = null;
              }
              // A WRAPPED wait's completion settles its whole chain: the
              // wrapper cell's predecessor (the original observation) is
              // retired with it.
              let chainCell = mappedCell;
              while (cellPredecessorByCell.has(chainCell)) {
                const predecessorValue = cellPredecessorByCell.get(chainCell);
                if (predecessorValue === undefined) break;
                const predecessor = predecessorValue;
                cellPredecessorByCell.delete(chainCell);
                const chained = pendingCellCalls.get(predecessor) ?? new Set();
                for (const pendingId of chained) pendingCallIds.delete(pendingId);
                pendingCellCalls.delete(predecessor);
                for (const chainedId of chained) retiredCalls.add(chainedId);
                if (pendingCellForAwait !== null && pendingCellForAwait === predecessor) {
                  pendingCellForAwait = null;
                }
                chainCell = predecessor;
              }
              const completedHandle = extractLiveHandle(outputText);
              if (completedHandle !== null && completedHandle.kind === 'cell' && /running/i.test(outputText)) {
                // The wrapper's completion header hides a LIVE INNER CELL:
                // the original observation is still active — RESTORE the
                // retired pending ids under the SURVIVING ANNOUNCED CELL
                // (never under the completed wrapper cell, whose state
                // would strand them forever) so fresh polls of it count as
                // overlaps and its own later completion settles the chain.
                workerChainActiveByPath.set(path, true);
                workerChainHandleByPath.set(path, completedHandle);
                const survivingCell = Number(completedHandle.value);
                pendingCellCalls.set(Number.isFinite(survivingCell) ? survivingCell : mappedCell, retiredCalls);
                for (const pendingId of retiredCalls) pendingCallIds.add(pendingId);
              } else if (completedHandle !== null && /running/i.test(outputText)) {
                // A live SESSION handle after completion: the shell
                // observation returned; the process continues as a new
                // chain target.
                workerChainActiveByPath.set(path, true);
                workerChainHandleByPath.set(path, completedHandle);
              }
            } else {
              // A WRAPPED wait can itself yield a new cell (`wait({cell_id:
              // 7})` returning `Script running with cell ID 10`): register
              // the wrapper cell chained to the original so resuming cell
              // 10 is a continuation and its completion settles the whole
              // chain.
              const wrappedHandle = extractLiveHandle(outputText);
              if (wrappedHandle !== null && wrappedHandle.kind === 'cell') {
                const wrapperCell = Number(wrappedHandle.value);
                if (Number.isFinite(wrapperCell) && wrapperCell !== mappedCell) {
                  cellPredecessorByCell.set(wrapperCell, mappedCell);
                  const wrapperCalls = pendingCellCalls.get(wrapperCell) ?? new Set();
                  wrapperCalls.add(payload.call_id);
                  pendingCellCalls.set(wrapperCell, wrapperCalls);
                }
              }
            }
            pendingCallIds.delete(payload.call_id);
          } else {
            // An ordinary (non-yielded) call's own output resolves it.
            pendingCallIds.delete(payload.call_id);
          }
        }
        // Chronological extrema: rollouts are scanned newest-mtime first,
        // so plain assignment would describe the last SCANNED file rather
        // than the actual latest/earliest events across Root and Child.
        if (Number.isFinite(atMs) && (summary.lastFunctionCallOutputAtMs === null || atMs > summary.lastFunctionCallOutputAtMs)) summary.lastFunctionCallOutputAtMs = atMs;
      } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        // Two installed host shapes record the same model decision: the
        // `function_call` (JSON `arguments`) shape and the newer
        // `custom_tool_call` shape whose `input` is a tool-DSL string, e.g.
        // `const r = await tools.exec_command({cmd:"...",yield_time_ms:30000});text(r.output);`.
        summary.functionCalls += 1;
        fileSummary.functionCalls += 1;
        const name = typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : 'unknown';
        // CONTENT-BASED Root identification during the bounded scan: a
        // rollout whose call NAMED spawn_agent is the Root session.
        if (name === 'spawn_agent' && rootRolloutPath === null) rootRolloutPath = path;
        if (Number.isFinite(atMs) && (summary.firstFunctionCallAtMs === null || atMs < summary.firstFunctionCallAtMs)) summary.firstFunctionCallAtMs = atMs;
        toolNames[name] = (toolNames[name] ?? 0) + 1;
        let args = null;
        let callText = '';
        if (typeof payload.arguments === 'string' && payload.arguments.length > 0) {
          callText = payload.arguments;
          try {
            const parsedArguments = JSON.parse(payload.arguments);
            if (parsedArguments !== null && typeof parsedArguments === 'object' && !Array.isArray(parsedArguments)) args = parsedArguments;
          } catch { /* an unparseable argument string stays unclassified */ }
        } else if (payload.arguments !== null && typeof payload.arguments === 'object' && !Array.isArray(payload.arguments)) {
          args = payload.arguments;
          callText = JSON.stringify(payload.arguments);
        }
        if (typeof payload.input === 'string') callText = `${callText}\n${payload.input}`;
        // BOUNDED synthetic-role match from the spawn ARGUMENTS: ONLY the
        // source-pinned effective role field (agent_type — SpawnAgentArgs
        // has no `role` property, so a `role` alias is never the host's
        // role selection) is inspected; any other argument content proves
        // nothing. Nothing but the boolean and the spawn's call id
        // survives the scan (no rollout text).
        if (name === 'spawn_agent') {
          spawnCallCount += 1;
          if (!spawnedSyntheticRole && args !== null && args.agent_type === SYNTHETIC_ROLE_NAME) {
            spawnedSyntheticRole = true;
            syntheticSpawnCallId = typeof payload.call_id === 'string' ? payload.call_id : null;
          }
        }
        // Requested yields: structured first (function_call arguments); the
        // tool-DSL form is extracted LATER, from the effective directive and
        // the actual operation argument segments (after the sites are
        // scanned).
        /** @type {number|null} the first yield this call requested (the clamp analysis key). */
        let callYieldTimeMs = null;
        if (args !== null && Number.isSafeInteger(args.yield_time_ms)) {
          summary.requestedYieldCount += 1;
          callYieldTimeMs = args.yield_time_ms;
          if (summary.requestedYieldsMs.length < SESSION_MAX_YIELD_SAMPLES) summary.requestedYieldsMs.push(args.yield_time_ms);
        }
        // Exec/poll classification: the structured shapes carry `cmd` (an
        // initial exec) and an empty-string `input` (a write_stdin poll);
        // the tool-DSL shape names the same two operations in the call text.
        /** @type {'initial-exec'|'empty-poll'|'other'} */
        let callKind = 'other';
        if (args !== null && typeof args.cmd === 'string') {
          callKind = 'initial-exec';
          summary.initialExecCalls += 1;
          fileSummary.initialExecCalls += 1;
          // Per-file exec fact: child evidence is derived AFTER the scan
          // resolves Root, never during it (a Root exec scanned before the
          // spawn marker must not become child evidence).
          fileHadInitialExecByPath.set(path, true);
          // INVOCATION evidence, not a mention: the structured cmd must BE
          // the exact built worker command (an `echo <command>` wrapper is
          // a printer, not a runner). The match is PENDING until its own
          // observation chain carries the worker's marker.
          if (input.workerEvidenceToken !== undefined && args.cmd === input.workerEvidenceToken
            && typeof payload.call_id === 'string') workerExecCallOwner.set(payload.call_id, path);
        } else if (args !== null && (typeof args.input === 'string' || args.session_id !== undefined || typeof args.chars === 'string')) {
          // The EFFECTIVE input field decides: legacy `input` vs `chars` —
          // when both are present and CONFLICT (one empty, one nonempty,
          // e.g. legacy `input:""` with a Ctrl-C `chars`), the effective
          // write is unresolved and stays UNCLASSIFIED; a nonempty field
          // is a nonempty write; both empty (or both absent with a
          // session id) is the configured empty poll.
          const hasInput = typeof args.input === 'string';
          const hasChars = typeof args.chars === 'string';
          const inputEmpty = hasInput && args.input.length === 0;
          const charsEmpty = hasChars && args.chars.length === 0;
          const isEffectiveEmpty = hasInput && hasChars
            ? (inputEmpty && charsEmpty)
            : hasInput ? inputEmpty
              : hasChars ? charsEmpty
                : true;
          if (isEffectiveEmpty) {
            callKind = 'empty-poll';
            summary.emptyPolls += 1;
            fileSummary.emptyPolls += 1;
            if (Number.isFinite(atMs) && (summary.firstEmptyPollAtMs === null || atMs < summary.firstEmptyPollAtMs)) summary.firstEmptyPollAtMs = atMs;
          } else {
            summary.otherFunctionCalls += 1;
          }
        } else if (args === null && WRAPPER_TOOL_NAMES.includes(name)) {
          // Custom tool-DSL script for a RECOGNIZED EXECUTABLE WRAPPER:
          // shell operations are detected at REAL call positions only —
          // quoted/template-literal mentions and comments never classify
          // (a script that prints or comments `write_stdin(...)` runs no
          // poll, and a commented `exec_command` is no child-execution
          // evidence). Other custom tools (apply_patch and the like) stay
          // unclassified: their input is not executed as code. Script-level
          // escapes are PRESERVED: the rollout JSON already decoded the
          // enclosing string, so a remaining `\"` is literal script text
          // whose string contents the lexical scanner skips natively —
          // normalizing it to a delimiter would turn string contents into
          // executable-looking script.
          // COOPERATIVE deadline check per call: a hostile script (tens of
          // thousands of awaited polls in one line) would otherwise hold
          // the event loop past cleanup — past the deadline the
          // classification stops and reports truncation (fail closed).
          if (Date.now() > analysisDeadline) {
            summary.truncated = true;
            summary.otherFunctionCalls += 1;
            return false;
          }
          if (process.env.WAIT_ROUTE_DBG) console.error('DBG dsl entered, callText len', callText.length);
          const execSites = callSitesForOperation(callText, 'exec_command');
          const stdinSites = callSitesForOperation(callText, 'write_stdin');
          const callNameStarts = [...execSites, ...stdinSites]
            .map((openParen) => callNameStartBefore(callText, openParen));
          // SITE CAP: beyond this the per-pair serialization scans become
          // quadratic on hostile scripts — skip the analysis and report
          // truncation (the exactly-one-spawn grant fails closed on it).
          // HELPER INVOCATIONS count toward the cap too: 30k sequential
          // `await poll()` calls enter the same serialization scans. The
          // helper scan runs when the LITERAL sites alone are within the
          // cap, the TOTAL (literal sites + helper invocations) governs,
          // and over the total cap the helper analysis is DISCARDED
          // (never fed downstream) with truncation reported.
          /** @type {string[]} */
          let pollingHelperNames = [];
          let helperCallStarts = [];
          if (execSites.length + stdinSites.length <= SESSION_MAX_SITES_PER_CALL) {
            pollingHelperNames = [...callText.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\b)?\s*(?:\([^)]*\)|[\w$]+)\s*=>/g), ...callText.matchAll(/\b(?:async\s+)?function\s+([\w$]+)/g)]
              .map((match) => ({ name: match[1], declStart: match.index }))
              .slice(0, 64)
              .filter((helper, index, all) => all.findIndex((other) => other.name === helper.name) === index)
              // Only helpers whose OWN statement contains a shell operation
              // are polling helpers: an unrelated `const f = async () => 1`
              // dispatched as auxiliary work serializes nothing.
              .filter(({ declStart }) => {
                const statementEnd = statementEndIndex(callText, declStart);
                return callNameStarts.some((start) => start > declStart && start < statementEnd);
              })
              .map((helper) => helper.name);
            for (const helperName of pollingHelperNames) {
              const declaration = [...callText.matchAll(new RegExp(`(?:const|let|var)\\s+${helperName}\\s*=|\\b(?:async\\s+)?function\\s+${helperName}\\b`, 'g'))][0];
              const declarationEnd = declaration === undefined ? -1 : helperDeclarationEndIndex(callText, declaration.index);
              for (const openParen of callSitesForOperation(stripSegmentComments(callText), helperName)) {
                // The DECLARATION's own parameter list (`function poll()`)
                // is not an invocation.
                if (openParen < declarationEnd) continue;
                helperCallStarts.push(callNameStartBefore(callText, openParen));
              }
            }
          }
          const withinSiteCap = execSites.length + stdinSites.length + helperCallStarts.length <= SESSION_MAX_SITES_PER_CALL;
          if (!withinSiteCap) {
            summary.truncated = true;
            pollingHelperNames = [];
            helperCallStarts = [];
          }
          const dispatchRanges = withinSiteCap ? concurrentDispatchRanges(callText) : [];
          const dispatchSiteStarts = [...callNameStarts, ...helperCallStarts].sort((left, right) => left - right);          // Multiple operation sites are the forbidden concurrency ONLY
          // when they are dispatched concurrently: every site directly
          // preceded by `await` is a sequential observation (compliant
          // same-handle polling), sites inside a Promise.all/race/
          // allSettled/any dispatch run concurrently, and any site that is
          // neither awaited nor collected is fire-and-forget concurrency.
          // A dispatch may also run ONE site N times concurrently
          // (`Promise.all([1,2].map(async () => await tools.write_stdin(...)))`),
          // and awaited sites inside separately defined concurrent
          // callbacks are ordered by nothing — so ANY script combining a
          // concurrent dispatch construct with an operation site is
          // treated as concurrent (never as confirmed absence of overlap).
          if (execSites.length + stdinSites.length > 0) {
            // Concurrent-dispatch violation ONLY when an operation site can
            // actually overlap: a site inside a dispatch span runs with the
            // dispatch's other callbacks (possibly N times), an ASYNC
            // HELPER whose body contains a shell operation and which is
            // dispatched inside a span runs its poll N times concurrently
            // (`async function poll() { await tools.write_stdin(...) };
            // Promise.all([poll(), poll()])`), and with multiple sites an
            // unawaited one is fire-and-forget. A dispatch of a helper with
            // NO shell operation (`const f = async () => 1`) cannot
            // overlap the polls and is never flagged. A single unawaited
            // site cannot overlap anything by itself; with multiple sites,
            // an unawaited one is fire-and-forget concurrency.
            // A site inside a dispatch range is concurrent only as an
            // INDEPENDENT branch (two polling callbacks) or a REPEATED
            // invocation (.map-style) — a single direct call or awaited
            // sites inside one callback execute sequentially.
            // Outside combinators, repeated callback dispatches
            // (`[1,2].forEach(async () => await tools.write_stdin(...))`)
            // overlap too. Storing promises and awaiting them LATER is
            // sequential only when EVERY consecutive site pair has an
            // await between them — starting both polls before awaiting
            // either (`const p = a(); const q = b(); await p; await q;`)
            // overlaps regardless of the await count.
            const orderedSites = withinSiteCap
              ? [...callNameStarts].sort((left, right) => left - right)
              : [];


            // Literal sites INSIDE declared helper bodies are the helper's
            // business (the invocation rules below govern them): exclude
            // them from the direct-site serialization pairs. The SAME
            // declaration boundary as the invocation loops applies — a
            // `function`-form declaration ends at its body's closing
            // brace, so a DIRECT poll sharing the line after the body is
            // NOT inside the helper and stays in the pairs. The NEAREST
            // declaration before the site owns it (redeclaration edge).
            const directSiteStarts = orderedSites.filter((start) => !pollingHelperNames.some((helperName) => {
              let nearest = null;
              for (const declMatch of callText.slice(0, start).matchAll(new RegExp(`(?:const|let|var)\\s+${helperName}\\s*=|\\bfunction\\s+${helperName}\\b`, 'g'))) nearest = declMatch;
              if (nearest === null) return false;
              const declarationEnd = helperDeclarationEndIndex(callText, nearest.index);
              return start > nearest.index && start < declarationEnd;
            }));
            const serialized = directSiteStarts.every((start, index) => {
              if (index === 0) return true;
              const previousStart = directSiteStarts[index - 1];
              if (isDirectlyAwaited(callText, previousStart)) return true;
              const assignMatch = new RegExp(`([\\w$]+)\\s*=\\s*(?:[\\w$]+\\s*\\.\\s*)*\\s*$`).exec(callText.slice(0, previousStart));
              if (assignMatch === null) return false;
              const varName = assignMatch[1].replaceAll('$', '\\$&');
              // The gap scan runs on the STRING-STRIPPED view: printed text
              // (`text("await p")`) is content and serializes nothing. The
              // gap is SLICED FROM THE ORIGINAL TEXT first — the stripped
              // view's offsets differ once strings collapse.
              const between = stripStringValuesKeepKeys(stripSegmentComments(callText.slice(previousStart, start)));
              // The await must START A STATEMENT in the gap: after `;`, `}`,
              // or an ASI newline — but a newline directly after a
              // conditional head (`if (false)`) is the conditional's body
              // and settles nothing. An awaited JOIN that includes the
              // stored poll (`await Promise.all([p])`) settles it too.
              const statementAwait = new RegExp(`(?:^|[;}]\\s*)await\\s+${varName}\\b`).test(between)
                || (new RegExp(`\\n\\s*await\\s+${varName}\\b`).test(between)
                  && !/\b(?:if|while|for)\s*\([^)]*\)\s*$/.test(between.slice(0, between.indexOf(`await ${varName}`))));
              const joinAwait = new RegExp(`(?:^|[;}]\\s*)await\\s+Promise\\.all\\([^)]*\\b${varName}\\b[^)]*\\)`).test(between);
              return statementAwait || joinAwait;
            });
            const concurrent = callNameStarts.filter((start) => callNameStarts.length > 1 && !serialized && !isDirectlyAwaited(callText, start));
            // HELPER INVOCATIONS are observation sites too:
            // `[1,2].map(() => poll())` runs the helper's poll N times —
            // the branch/repeated-dispatch checks must see those call
            // positions, not just literal operation sites.
            // Repeated UNAWAITED helper invocations outside combinators
            // (`const a = poll(); const b = poll(); await a; await b;`)
            // overlap: the serialization gap rule applies to helper call
            // positions with the same var-reference discipline as sites.
            // The overlap check runs across the COMBINED execution order of
            // direct sites and FREE helper invocations (dispatch-contained
            // invocations are the per-dispatch counts' business): `const p =
            // poll(); await tools.write_stdin(...); await p;` starts two
            // overlapping observations even though each list alone looks
            // serialized.
            const freeHelperStarts = helperCallStarts
              .filter((start) => !dispatchRanges.some(([rangeStart, rangeEnd]) => start > rangeStart && start < rangeEnd))
              .sort((left, right) => left - right);
            const orderedCombined = [...directSiteStarts, ...freeHelperStarts].sort((left, right) => left - right);
            const serializedCombined = orderedCombined.every((start, index) => {
              if (index === 0) return true;
              const previousStart = orderedCombined[index - 1];
              if (isDirectlyAwaited(callText, previousStart)) return true;
              const assignMatch = new RegExp(`([\\w$]+)\\s*=\\s*(?:[\\w$]+\\s*\\.\\s*)*\\s*$`).exec(callText.slice(0, previousStart));
              if (assignMatch === null) return false;
              const varName = assignMatch[1].replaceAll('$', '\\$&');
              const between = stripStringValuesKeepKeys(stripSegmentComments(callText.slice(previousStart, start)));
              // ASI newline boundaries count (`await p` on its own line); a
              // newline directly after a conditional head is that
              // conditional's body and settles nothing. An awaited JOIN that
              // includes the stored poll settles it too.
              const awaitOk = new RegExp(`(?:^|[;}]\\s*)await\\s+${varName}\\b`).test(between)
                || (new RegExp(`\\n\\s*await\\s+${varName}\\b`).test(between)
                  && !/\b(?:if|while|for)\s*\([^)]*\)\s*$/.test(between.slice(0, between.indexOf(`await ${varName}`))))
                || new RegExp(`(?:^|[;}]\\s*)await\\s+Promise\\.all\\([^)]*\\b${varName}\\b[^)]*\\)`).test(between);
              return awaitOk;
            });
            let dispatchedBranches = 0;
            for (const [rangeStart, rangeEnd] of dispatchRanges) dispatchedBranches += rangePollingBranches(callText, rangeStart, rangeEnd, dispatchSiteStarts);
            const repeatedBranches = repeatedCallbackDispatchBranches(callText, callNameStarts, dispatchRanges, pollingHelperNames);
            // One increment per script: the combined check subsumes the
            // direct-site, dispatch-branch, repeated-dispatch, loop-body,
            // and helper-invocation rules.
            if (concurrent.length > 0 || dispatchedBranches > 0 || repeatedBranches > 0
              || loopBodyContainsOperation(callText, callNameStarts)
              || dispatchedPollingHelperInvocations(callText, dispatchSiteStarts, dispatchRanges) >= 2
              || !serializedCombined) summary.parallelToolCallViolations += 1;

          }
          // DECLARED-HELPER bodies: a body site executes once per
          // ESTABLISHED invocation of the helper — never-invoked helpers
          // execute nothing, and unknown multiplicity counts once (the
          // summary reports the established minimum honestly).
          const helperMultiplicityBySite = new Map();
          for (const helperName of pollingHelperNames) {
            const declaration = [...callText.matchAll(new RegExp(`(?:const|let|var)\\s+${helperName}\\s*=|\\b(?:async\\s+)?function\\s+${helperName}\\b`, 'g'))][0];
            if (declaration === undefined) continue;
            const declarationEnd = helperDeclarationEndIndex(callText, declaration.index);
            let invocations = 0;
            for (const openParen of callSitesForOperation(stripSegmentComments(callText), helperName)) {
              if (openParen < declarationEnd) continue;
              invocations += 1;
            }
            // IMMEDIATELY INVOKED declarations (`const p = (async () =>
            // ...)();`) execute their body exactly once at the declaration
            // itself — no later `p()` call is needed. Without this, the
            // executed command and requested yield would vanish from the
            // summary.
            const statementText = callText.slice(declaration.index, declarationEnd).trim();
            if (/\)\s*\(\)\s*;?$/.test(statementText)) invocations = Math.max(invocations, 1);
            const referencePattern = new RegExp(`\\.\\s*(?:map|forEach|filter|flatMap)\\s*\\(\\s*${helperName}\\s*\\)`, 'g');
            for (const namedReference of callText.matchAll(referencePattern)) {
              // Named callback references outside dispatch ranges count too
              // (`[1,2].forEach(poll)`), with the receiver's multiplicity.
              const insideDispatch = dispatchRanges.some(([rangeStart, rangeEnd]) => namedReference.index > rangeStart && namedReference.index < rangeEnd);
              const methodStart = namedReference.index + 1;
              if (!insideDispatch) {
                const elements = receiverElementCount(callText, methodStart);
                invocations += elements === null ? 2 : elements;
                continue;
              }
              const elements = receiverElementCount(callText, methodStart);
              invocations += elements === null ? 2 : elements;
            }
            for (const openParen of [...execSites, ...stdinSites]) {
              const site = openParen;
              const siteStart = callNameStartBefore(callText, site);
              if (siteStart > declaration.index && siteStart < declarationEnd) {
                helperMultiplicityBySite.set(site, invocations);
              }
            }
          }
          const siteMultiplicity = (/** @type {number} */ site) => helperMultiplicityBySite.get(site) ?? 1;
          // Requested yields (DSL shape) come from EFFECTIVE sources only:
          // the leading @exec directive payload and the argument segments
          // of the ACTUAL operation sites — an unrelated object literal
          // (`const unused = {yield_time_ms: N}`) requests nothing. Within
          // one segment the LAST duplicate key wins (JavaScript
          // semantics). Each value must be a COMPLETE numeric literal at a
          // parameter boundary; unsupported expressions stay unclassified.
          /** @type {{position: number, value: number}[]} */
          const dslYieldCandidates = [];
          // The wrapper honors the directive ONLY as the script's LEADING
          // pragma — the first non-blank line of the raw script. An inline
          // or later-line `// @exec:` comment requests nothing.
          const firstContentLine = callText.split('\n').find((line) => line.trim().length > 0) ?? '';
          const directivePayload = /^\s*\/\/\s*@exec\s*:\s*\{([^}]*)\}\s*$/.exec(firstContentLine);
          if (directivePayload !== null) {
            const directiveValue = effectiveYieldValue(directivePayload[1]);
            if (directiveValue !== null) dslYieldCandidates.push({ position: 0, value: directiveValue });
          }
          for (const openParen of [...execSites, ...stdinSites, ...callSitesForOperation(callText, 'wait')]) {
            // COOPERATIVE deadline check per site (bounded analysis).
            if (Date.now() > analysisDeadline) {
              summary.truncated = true;
              break;
            }
            const segment = balancedCallSegment(callText, openParen);
            if (segment === null) continue;
            // Comments only — the value scanner is quote-aware and must
            // SEE quoted keys (`["yield_time_ms"]`); collapsing string
            // values here would erase them.
            const segmentValue = effectiveYieldValue(stripSegmentComments(segment));
            if (segmentValue !== null) dslYieldCandidates.push({ position: openParen, value: segmentValue });
          }
          dslYieldCandidates.sort((left, right) => left.position - right.position);
          for (const candidate of dslYieldCandidates) {
            // Each ESTABLISHED invocation of the site requests its own
            // window: multiplicity multiplies the recorded requests.
            const candidateMultiplicity = siteMultiplicity(candidate.position);
            for (let i = 0; i < candidateMultiplicity; i += 1) {
              summary.requestedYieldCount += 1;
              if (callYieldTimeMs === null) callYieldTimeMs = candidate.value;
              if (summary.requestedYieldsMs.length < SESSION_MAX_YIELD_SAMPLES) summary.requestedYieldsMs.push(candidate.value);
            }
          }
          if (execSites.length > 0) {
            callKind = 'initial-exec';
            const execMultiplicity = execSites.reduce((total, site) => total + siteMultiplicity(site), 0);
            summary.initialExecCalls += execMultiplicity;
            fileSummary.initialExecCalls += execMultiplicity;
            if (execMultiplicity > 0) fileHadInitialExecByPath.set(path, true);
            const workerToken = input.workerEvidenceToken;
            // INVOCATION evidence in the DSL shape: the DECODED cmd value
            // of an exec site must BE the exact built command (a comment
            // or concatenation mentioning it is not a runner). The script
            // must carry EXACTLY ONE exec site — a multi-exec script's
            // aggregate output cannot be attributed to the matched inner
            // invocation — and the script text itself must NOT mention the
            // completion marker: a `text("<marker>")` after the exec makes
            // the aggregate output's marker fabricated, not observed (fail
            // closed). The match is PENDING until the observation chain
            // carries the worker's marker.
            // A script mixing the exec with a POLL of another handle has an
            // aggregate output no single operation produced — ambiguous,
            // fail closed.
            if (workerToken !== undefined && execSites.length === 1 && stdinSites.length === 0 && !callText.includes(COMPLETION_MARKER)) {
              const segment = balancedCallSegment(callText, execSites[0]);
              if (segment !== null && decodeDslCmdValue(segment) === workerToken
                && typeof payload.call_id === 'string') workerExecCallOwner.set(payload.call_id, path);
            }
          }
          // Inspect the ACTUAL input of EVERY stdin site: only a
          // confirmed-empty input is an empty observation. Quoted keys with
          // escape sequences (e.g. "\u0003" — Ctrl-C) and nonliteral values
          // (e.g. chars: signal) are UNCLASSIFIED rather than assumed
          // empty: interruption/nonempty writes carry a different timeout
          // policy, so conflating them corrupts configured-window
          // measurements.
          // A write_stdin whose arguments are a SELF-CONTAINED LITERAL
          // object carrying NO chars/input key at all is an empty poll
          // (omitted input defaults to empty). A literal empty quoted value
          // is also empty — but only when NO spread and NO duplicate key
          // can override it. INDIRECT shapes (a bare identifier like
          // `tools.write_stdin(args)` or a spread `{...args}`) stay
          // UNCLASSIFIED when the key is absent: their actual arguments
          // can carry nonempty input the rollout never shows.
          // The ARGUMENT SEGMENT (balanced parens, up to the call's closing
          // paren) is inspected instead of the whole script: a naive
          // [^)]* stops at the nested `)` of e.g. Number("123") and misses
          // the later chars property, misclassifying nonempty input as an
          // empty poll.
          for (const stdinSite of stdinSites) {
            // COOPERATIVE deadline check per site (bounded analysis).
            if (Date.now() > analysisDeadline) {
              summary.truncated = true;
              break;
            }
            const wsSegment = balancedCallSegment(callText, stdinSite);
            // Comments are stripped BEFORE key detection: a key separated
            // from its colon by a comment is still the effective key, and
            // a commented-out key is not one. String contents survive.
            const effectiveSegment = wsSegment === null ? null : stripSegmentComments(wsSegment.trim());
            const trimmedSegment = effectiveSegment;
            const hasSpread = trimmedSegment !== null && trimmedSegment.includes('...');
            const keyMatches = trimmedSegment === null ? [] : [...trimmedSegment.matchAll(/["']?(?:chars|input)["']?\s*:/g)];
            const charsEmptyQuoted = trimmedSegment !== null && /["']?(?:chars|input)["']?\s*:\s*(['"])\1\s*(?=[,)}]|$)/.test(trimmedSegment);
            // OPAQUE properties make the effective input unprovable:
            // shorthand (`chars` with no colon — the variable may hold
            // nonempty input), COMPUTED keys (`["chars"]:` — the key is
            // dynamic), and a stray backslash outside strings (unparseable
            // escaped shape) all force UNCLASSIFIED — only proven omission
            // or a literal empty value may count as the empty poll.
            const strippedSegment = trimmedSegment === null ? null : stripStringValuesKeepKeys(trimmedSegment);
            const hasOpaqueProperties = strippedSegment === null
              || /\\/.test(strippedSegment)
              || /(^|[{,]\s*)(\[[^\]]*\]|[A-Za-z_$][\w$]*)\s*(?=[,}])/.test(strippedSegment)
              || /(^|[{,]\s*)\[[^\]]*\]\s*:/.test(strippedSegment)
              // ACCESSOR properties (`get chars(){...}`) compute their value
              // at read time — their missing colon-form key proves nothing.
              || /\b(?:get|set)\s+["']?[\w$]+["']?\s*\(/.test(strippedSegment);
            // OMISSION as empty requires the SELF-CONTAINED LITERAL
            // argument shape (object literal or keyword-argument list) with
            // no spread and no opaque properties; an explicit literal empty
            // is proof only when no spread, no opaque properties, and no
            // duplicate key can override it.
            const confirmedEmpty = !hasOpaqueProperties && !hasSpread
              && ((trimmedSegment !== null && keyMatches.length === 0
                && /^(\{|["']?[A-Za-z_$][\w$]*["']?\s*:)/.test(trimmedSegment))
                || (keyMatches.length === 1 && charsEmptyQuoted));
            if (confirmedEmpty) {
              if (callKind !== 'initial-exec') callKind = 'empty-poll';
              const pollMultiplicity = siteMultiplicity(stdinSite);
              summary.emptyPolls += pollMultiplicity;
              fileSummary.emptyPolls += pollMultiplicity;
              // The OUTER script-call timestamp is the poll's start only
              // when the poll is the script's single operation AND its
              // execution is IMMEDIATE — the script's only `await` is the
              // one directly preceding the poll, with no earlier
              // statement (a delayed start — a timer, preceding awaits —
              // leaves the poll's actual start unproven and the field
              // unset).
              const firstStdinStart = callNameStartBefore(callText, stdinSite);
              const pollPrefix = callText.slice(0, firstStdinStart);
              // A PROVEN immediate shape only: after stripping at most one
              // leading `const|let|var NAME =` and the `await` keyword,
              // NOTHING may remain before the poll — a semicolon-free
              // synchronous delay (`while (...) {...} text(await ...)`)
              // delays the start just as much as a statement with a
              // semicolon. The poll's ARGUMENTS may suspend too
              // (`session_id: await new Promise(...)`) — same rule.
              const immediatePrefix = pollPrefix
                // The documented directive is a leading COMMENT: it executes
                // nothing and never delays the poll.
                .replace(/^\s*\/\/\s*@exec\s*:[^\n]*\n/, '')
                .replace(/^\s*(?:const|let|var)\s+[\w$]+\s*=\s*/, '')
                // A text() WRAPPER around the awaited poll (`text(await
                // tools.write_stdin(...))` — the recorded continuation
                // shape) executes the poll immediately too.
                .replace(/^\s*[\w$]+\s*\(\s*/, '')
                .replace(/^\s*await\s*/, '');
              // The poll's ARGUMENTS may suspend or delay too (`session_id:
              // await new Promise(...)`, a busy-wait IIFE) — any call in the
              // argument segment can push the real start past the call
              // timestamp, so the start stays unproven unless the arguments
              // are pure literals.
              const argumentText = stripSegmentComments(wsSegment ?? '');
              const pollIsImmediate = isDirectlyAwaited(callText, firstStdinStart)
                && /^(?:[\w$]+\s*\(\s*)?(?:[\w$]+\s*\.\s*)*$/.test(immediatePrefix.trim())
                && !/\bawait\b/.test(argumentText)
                && !/\bnew\b|[\w$]\s*\(/.test(argumentText);
              if (execSites.length === 0 && stdinSites.length === 1 && pollIsImmediate
                && Number.isFinite(atMs) && (summary.firstEmptyPollAtMs === null || atMs < summary.firstEmptyPollAtMs)) summary.firstEmptyPollAtMs = atMs;
            } else {
              if (callKind !== 'initial-exec' && callKind !== 'empty-poll') callKind = 'other';
              summary.otherFunctionCalls += 1;
            }
          }
          if (execSites.length === 0 && stdinSites.length === 0) summary.otherFunctionCalls += 1;
        } else {
          summary.otherFunctionCalls += 1;
        }
        if (summary.calls.length < SESSION_MAX_YIELD_SAMPLES) {
          summary.calls.push({
            atMs: Number.isFinite(atMs) ? atMs : null,
            kind: callKind,
            name,
            yieldTimeMs: callYieldTimeMs,
          });
          // Child evidence is NEVER attributed here: Root may not be
          // resolved yet (a Root exec can precede the spawn marker in its
          // own rollout), and the flag would be sticky. The post-scan
          // reconciliation below derives it from the complete per-file
          // facts.
        } else {
          summary.callsTruncated = true;
        }
        // A continuation is an ACTUAL wait operation (wait_agent name, or a
        // write_stdin whose arguments reference the pending cell id). A
        // second write_stdin WITHOUT the cell reference starts another
        // observation and IS a violation.
        // The host resumes a yielded script through wait({cell_id: N}):
        // the continuation is an ACTUAL wait call whose cell_id matches.
        // Script-tool shape: an ACTUAL wait(...) call site (lexical scan —
        // quoted mentions and comments never establish continuation
        // identity) whose ARGUMENT SEGMENT carries a COMPLETE cell-id
        // literal (an expression like `3 + 1` references a different cell
        // and stays unclassified).
        let waitCellMatch = null;
        for (const waitSite of callSitesForOperation(callText, 'wait')) {
          const waitSegment = balancedCallSegment(callText, waitSite);
          if (waitSegment === null) continue;
          // EFFECTIVE-argument validation: comments are stripped, a spread
          // or a DUPLICATE cell_id key (`{cell_id:7,cell_id:999}` passes
          // 999) makes the first literal a lie — such segments stay
          // unclassified, never matched against the outstanding cell. A
          // COMPUTED cell key (`["cell_id"]:999`) executes unresolvably —
          // same rule.
          const effectiveWaitSegment = stripSegmentComments(waitSegment.trim());
          if (effectiveWaitSegment.includes('...')) continue;
          if (/(?:^|[{,])\s*\[[^\][]*\]\s*:/.test(effectiveWaitSegment)) continue;
          const cellKeyCount = [...effectiveWaitSegment.matchAll(/["']?cell_id["']?\s*:/g)].length;
          if (cellKeyCount !== 1) continue;
          const cellMatch = /cell_id["']?\s*:\s*["']?(\d+)["']?\s*(?=[,}\n]|$)/.exec(effectiveWaitSegment);
          if (cellMatch !== null) {
            waitCellMatch = cellMatch;
            break;
          }
        }
        // Structured shape: name === 'wait' with JSON args.cell_id matching
        // ANY outstanding yielded cell (the per-cell pending map, not just
        // the most recent yield — with cells 1 and 2 outstanding, a wait
        // for cell 1 is still a continuation). Script-tool shape: a
        // wait(...) call whose complete cell_id literal matches any
        // outstanding cell. Either is a CONTINUATION, not a new
        // observation; the continuation's own terminal output retires its
        // pending id.
        const continuationCellRef = args !== null && args.cell_id !== undefined ? String(args.cell_id)
          : waitCellMatch !== null ? waitCellMatch[1]
            : null;
        const structuredWait = name === 'wait' && continuationCellRef !== null
          && [...pendingCellCalls.keys()].some((cell) => String(cell) === continuationCellRef);
        const isWaitOperation = structuredWait
          || (waitCellMatch !== null && [...pendingCellCalls.keys()].includes(Number(waitCellMatch[1])));
        const isContinuation = pendingCellCalls.size > 0 && isWaitOperation;
        // Each wait call is bound to the cell IT references (from its
        // structured cell_id argument or its script text) so its terminal
        // output settles THAT cell — never whichever cell was awaited most
        // recently.
        if (typeof payload.call_id === 'string') {
          let referencedCell = null;
          if (structuredWait) referencedCell = Number(args.cell_id);
          else if (waitCellMatch !== null) referencedCell = Number(waitCellMatch[1]);
          if (referencedCell !== null && Number.isFinite(referencedCell)) {
            // The continuation exemption covers overlapping the SUSPENDED
            // script, never overlapping ANOTHER UNANSWERED wait: a second
            // wait for a cell whose first wait has not returned yet is a
            // fresh overlapping observation.
            if (isContinuation && [...waitCellByCallId.values()].some((cell) => cell === referencedCell)) {
              summary.parallelToolCallViolations += 1;
            }
            waitCellByCallId.set(payload.call_id, referencedCell);
          }
        }
        const outputText = outputTextOf(payload);
        if (isContinuation && outputText.includes('Script completed')) {
          pendingCallIds.delete(payload.call_id);
        }
        if (pendingCallIds.size > 0 && !isContinuation) summary.parallelToolCallViolations += 1;
        // The continuation exemption covers THE WAIT ITSELF, never other
        // operations sharing the script: `write_stdin(...); wait({cell_id:
        // N})` still launches a fresh poll that overlaps the outstanding
        // cell, so a continuation script carrying more than its own wait
        // site counts the violation.
        if (isContinuation && args === null
          && callSitesForOperation(callText, 'exec_command').length + callSitesForOperation(callText, 'write_stdin').length + callSitesForOperation(callText, 'wait').length > 1) summary.parallelToolCallViolations += 1;
        // A yielded script whose INNER write_stdin observation may still be
        // pending stays in the pending set: outer call/output alternation
        // does not prove the inner observation completed, so concurrency
        // through yielded scripts is reported as unproven (the pending id
        // is retained rather than deleted on the outer output).
        if (typeof payload.call_id === 'string') {
          pendingCallIds.add(payload.call_id);
          // Chain tracking: while the matched worker observation has a
          // LIVE handle in this rollout, a wait/write_stdin poll that
          // REFERENCES THAT HANDLE continues the observation (its result
          // may carry the worker's marker). The script must carry EXACTLY
          // ONE poll operation — a multi-poll script's aggregate output
          // cannot be attributed to the matched observation (a poll of an
          // unrelated handle in the same script is not the worker's
          // result). A poll of any other handle is an unrelated
          // observation, never this chain's continuation.
          const chainHandle = workerChainHandleByPath.get(path);
          const chainPollSiteCount = callSitesForOperation(callText, 'wait').length + callSitesForOperation(callText, 'write_stdin').length;
          if (typeof payload.call_id === 'string' && workerChainActiveByPath.get(path) === true && chainHandle !== undefined
            && !callText.includes(COMPLETION_MARKER)
            && (name === 'wait' || name === 'write_stdin' || chainPollSiteCount === 1)
            && chainPollSiteCount <= 1
            && referencesChainHandle(callText, args, chainHandle, name)) workerChainCallOwner.set(payload.call_id, path);
          // Both installed shapes can be yielded scripts whose inner
          // observation stays pending: the outer output does not prove the
          // inner operation finished (tracked in pendingYieldedScriptIds
          // so the output handler retains the pending id). An initial-exec
          // script registers TOO — a yielded `Script running with cell ID`
          // leaves ITS inner operation outstanding, and only the observed
          // output resolves it.
          // LEXICAL operation facts only: a comment or quoted mention of
          // `write_stdin` in a wait-continuation script must not register
          // it as a yielded script (its `Script completed` output would
          // bypass the wait-cell settlement and strand the observation).
          if (callKind === 'initial-exec' || callSitesForOperation(callText, 'write_stdin').length > 0) pendingYieldedScriptIds.add(payload.call_id);
        }
      }
      return false;
    }
  }
  // Child-exec provenance is derived AFTER Root identification and after
  // ALL rollouts are scanned: an exec in a file scanned before the
  // spawn_agent marker (same-file Root exec) cannot set the flag
  // prematurely — the flag is derived here from the COMPLETE per-file
  // facts, never during the scan. Any initial-exec in a NON-Root rollout
  // counts as child exec; it only corroborates the managed-child lifecycle
  // when the child rollout is PARENT-LINKED to the Root session (the child
  // rollout's session_meta parent_thread_id equals the Root rollout's own
  // session_meta id — the source-pinned spawn edge).
  const rootMeta = rootRolloutPath !== null ? fileMetaByPath.get(rootRolloutPath) : undefined;
  let linkedChildExecSeen = false;
  for (const [execPath, hadExec] of fileHadInitialExecByPath) {
    if (!hadExec || execPath === rootRolloutPath) continue;
    childExecSeen = true;
    // The linked child's exec must reference the PROBE WORKER when the
    // caller supplies the worker evidence token: an unrelated child
    // command (`echo hello`) must not let the Root-launched worker be
    // attributed to the child.
    const execMatchesWorker = input.workerEvidenceToken === undefined
      || fileExecMatchedWorker.get(execPath) === true;
    const childMeta = fileMetaByPath.get(execPath);
    if (execMatchesWorker && rootMeta !== undefined && childMeta !== undefined
      && rootMeta !== null && childMeta !== null
      && childMeta.parentThreadId !== undefined && childMeta.parentThreadId !== null
      && String(childMeta.parentThreadId) === String(rootMeta.id)) {
      linkedChildExecSeen = true;
    }
  }
  Object.defineProperty(summary, 'childExecSeen', { value: childExecSeen, enumerable: false });
  Object.defineProperty(summary, 'spawnedSyntheticRole', { value: spawnedSyntheticRole, enumerable: false });
  Object.defineProperty(summary, 'syntheticSpawnAnswered', { value: syntheticSpawnAnswered, enumerable: false });
  Object.defineProperty(summary, 'linkedChildExecSeen', { value: linkedChildExecSeen, enumerable: false });
  // The FULL-scan spawn count (never the sampled calls array): the grant
  // requires exactly one spawn, and a truncated scan cannot establish any
  // count — the consumer must fail closed on it.
  Object.defineProperty(summary, 'spawnAgentCallCount', { value: spawnCallCount, enumerable: false });
  return summary;
}

/**
 * Reads the worker's own bounded launch records through a byte-bounded
 * incremental read (same discipline as the trace reader): the log is a
 * model-writable workspace file, so neither an oversized single record nor
 * an oversized total log can exhaust driver memory. The bounded prefix is
 * returned with truncation REPORTED - never silently treated as complete
 * evidence. Each record carries the worker pid, its process group/session
 * (the real macOS shell shape puts the worker in its OWN group), and the
 * worker's captured startup identity, so the record count is execution
 * evidence that never depends on guessed host event schemas.
 * @param {string} launchLogPath
 * @returns {Promise<{records: Record<string, unknown>[], truncated: boolean, incomplete: boolean}>}
 */
export async function readWorkerLaunchRecords(launchLogPath) {
  // The launch log lives in the model-writable workspace: if it was replaced
  // by anything other than a regular file (a FIFO, a device), opening or
  // reading it could block forever and the case would never reach its
  // cleanup despite --budget-ms. stat() never blocks on a FIFO — validate
  // BEFORE any potentially blocking operation. A non-regular log is
  // incomplete evidence, never execution proof.
  const logStats = await stat(launchLogPath).catch((error) => {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  });
  if (logStats === null) return { records: [], truncated: false, incomplete: false };
  if (!logStats.isFile()) return { records: [], truncated: false, incomplete: true };
  // TOCTOU guard: the log can be replaced BETWEEN stat() and open(). Open
  // NONBLOCKING (a FIFO open for reading would otherwise wait for a writer)
  // and validate the OPENED descriptor with fstat before reading — a
  // non-regular descriptor is rejected as incomplete evidence.
  const handle = await open(launchLogPath, openNonBlockingFlags()).catch((error) => {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  });
  if (handle === null) return { records: [], truncated: false, incomplete: false };
  const openedStats = await handle.stat();
  if (!openedStats.isFile()) {
    await handle.close().catch(() => {});
    return { records: [], truncated: false, incomplete: true };
  }
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  /** @type {Record<string, unknown>[]} */
  const records = [];
  let truncated = false;
  let incomplete = false;
  /** Set when the RECORD cap was reached on a complete record; truncation is decided at the top of the read loop. */
  let hitRecordCap = false;
  let totalBytes = 0;
  let carry = '';
  /**
   * A VALID launch record is what the fixture worker writes: the launch
   * event, its pid, its process group, and its captured identity. Anything
   * else — malformed JSON (a torn trailing write), an empty object, or a
   * record missing its identity fields — is never execution evidence, and
   * its presence means the log cannot prove how many launches happened:
   * the result is marked incomplete so classification fails closed.
   * @param {string} line @returns {boolean}
   */
  const consumeLine = (line) => {
    if (line.trim().length === 0) return false;
    if (Buffer.byteLength(line, 'utf8') > WORKER_LAUNCH_MAX_RECORD_BYTES) {
      truncated = true;
      return true;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A torn or malformed record is never execution evidence, and its
      // presence makes the whole log incomplete.
      incomplete = true;
    }
    // Native Windows cannot capture POSIX identity/pgid fields: there the
    // launch evidence is the launch event plus the pid. POSIX requires the
    // full shape — a record missing its identity fields is never ownable.
    const validShape = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      && (parsed).event === 'worker-launched'
      && Number.isSafeInteger((parsed).pid) && ((parsed).pid > 0)
      && (process.platform === 'win32'
        || (Number.isSafeInteger((parsed).pgid) && ((parsed).pgid > 0)
          && typeof (parsed).identity === 'string' && ((parsed).identity).length > 0));
    if (parsed === null || parsed === undefined || !validShape) incomplete = true;
    if (parsed !== null && validShape) records.push(parsed);
    if (records.length >= MAXIMUM_WORKER_LAUNCH_RECORDS) {
      // The cap was reached on a COMPLETE record: whether the log is truly
      // truncated is decided at the top of the read loop, where "more
      // content follows" is knowable — a log ending exactly here is complete.
      hitRecordCap = true;
      return true;
    }
    return false;
  };
  try {
    for (;;) {
      if (hitRecordCap) {
        // The record cap was reached on complete records: truncation is
        // honest ONLY when more content actually follows. A log ending
        // exactly at the cap is complete evidence, never a false alarm;
        // any further byte may carry the next record and reports it.
        if (carry.trim().length > 0) {
          truncated = true;
          break;
        }
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead > 0) truncated = true;
        break;
      }
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        carry += decoder.end();
        if (carry.trim().length > 0) consumeLine(carry);
        break;
      }
      totalBytes += bytesRead;
      if (totalBytes > WORKER_LAUNCH_MAX_TOTAL_BYTES) {
        truncated = true;
        break;
      }
      carry += decoder.write(buffer.subarray(0, bytesRead));
      let newline = carry.indexOf('\n');
      while (newline >= 0) {
        const line = carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        // A true return already recorded WHY reading stops (an oversized
        // record set `truncated`; the record cap set `hitRecordCap`).
        if (consumeLine(line)) break;
        newline = carry.indexOf('\n');
      }
      // The PENDING record must respect the per-record cap BEFORE another
      // blocking read: an oversized unterminated record stops the reader
      // and reports truncation without waiting for EOF (the same
      // discipline the trace reader applies to its pending buffer).
      if (carry.trim().length > 0 && Buffer.byteLength(carry, 'utf8') > WORKER_LAUNCH_MAX_RECORD_BYTES) {
        truncated = true;
        break;
      }
      if (truncated) break;
    }
  } finally {
    await handle.close().catch(() => {});
  }
  return { records, truncated, incomplete };
}

/**
 * Bounded wait for one pid to stop being able to run code.
 * @param {number} processId @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForSettled(processId, timeoutMs) {
  const settleDeadline = Date.now() + Math.max(1, timeoutMs);
  for (;;) {
    if (await isProcessSettled(processId)) return true;
    if (Date.now() >= settleDeadline) return false;
    await sleep(Math.min(SERVER_EXIT_POLL_MS, Math.max(1, settleDeadline - Date.now())));
  }
}

/**
 * Settles one recorded process: a pid that is already gone is verified
 * exited; a live process is signaled ONLY after its recorded startup
 * identity — retained in the trace as a per-run-salted fingerprint — still
 * matches the fingerprinted live identity. Returns honestly for anything
 * unverifiable.
 * @param {unknown} pid @param {string|null} recordedIdentityHash @param {string|undefined} runNonce @param {number} graceMs
 * @returns {Promise<'verified-exited'|'terminated'|'unresolved'>}
 */
async function settleRecordedProcess(pid, recordedIdentityHash, runNonce, graceMs) {
  if (!Number.isSafeInteger(pid) || /** @type {number} */ (pid) <= 0) return 'unresolved';
  const processId = /** @type {number} */ (pid);
  if (await waitForSettled(processId, graceMs)) return 'verified-exited';
  if (recordedIdentityHash === null || runNonce === undefined) return 'unresolved';
  const currentIdentity = captureProcessIdentity(processId);
  if (currentIdentity === null) return 'unresolved';
  if (fingerprintProcessIdentity(runNonce, currentIdentity) !== recordedIdentityHash) return 'unresolved';
  try {
    process.kill(processId, 'SIGKILL');
  } catch {
    return 'unresolved';
  }
  return (await waitForSettled(processId, 2_000)) ? 'terminated' : 'unresolved';
}

/**
 * Verifies and settles every recorded shell worker against ONE shared
 * deadline. The macOS shell runs the command in its OWN process
 * group/session, and the fixture records that group, so each worker's
 * settlement is tracked SEPARATELY from the host group: all VALIDATED
 * workers are signaled together first (a record with a usable group settles
 * ONLY through its ownership-revalidated group signal — never through the
 * coarser per-pid fallback, which on Linux a recycled pid can satisfy with
 * the same second-resolution lstart/ppid/executable despite a different
 * /proc starttime); a record WITHOUT a usable group may fall back to the
 * per-pid kill only after BOTH the coarse identity and the platform start
 * token match. The signaled workers are then awaited against a single
 * bounded window derived from the case budget — per-record grace
 * accumulation must never extend the case past its budget. `unresolved`
 * wins over `terminated`, which wins over `verified-exited`.
 * @param {string} launchLogPath @param {number} deadline epoch ms bound for the shared settlement wait @param {number|null} hostPid this run's spawned host pid (the launch anchor) @param {number[]} [coveredWorkerPids] out-array collecting covered live worker pids
 * @returns {Promise<'not-started'|'verified-exited'|'terminated'|'unresolved'>}
 */
export async function settleWorkerExits(launchLogPath, deadline, hostPid, coveredWorkerPids) {
  const read = await readWorkerLaunchRecords(launchLogPath);
  const records = read.records;
  // An incomplete (torn) or truncated log cannot prove the complete launch
  // set — integrity failures fail closed as `unresolved`.
  const integrityFailure = read.truncated || read.incomplete;
  if (records.length === 0) return integrityFailure ? 'unresolved' : 'not-started';
  // MAINTENANCE ONLY: cleanup runs after the host has exited, so records can
  // never CREATE ownership here (the trusted launch boundary — ancestry
  // reaching the live spawned host — is only verifiable during the polls).
  // This call maintains existing entries (drops invalidated or dead groups).
  // Cleanup runs AFTER the case budget expired: the inspection budget here
  // covers the SHARED SETTLEMENT window, never less than one grace period
  // from now, so post-budget verification (including the retained-evidence
  // revalidation at the signaling boundary) is not starved.
  const cleanupBudget = Math.max(deadline, Date.now() + WORKER_EXIT_GRACE_MS);
  ownRecordedWorkerGroups(records, { inspectionDeadline: cleanupBudget });
  inspectionBudget.deadline = cleanupBudget;
  /** Records whose validated group signal was delivered. */
  const signaled = new Set();
  const tracked = new Set();
  let sawUnverifiable = false;
  try {
    // The isProcessSettled probes INSIDE the loop consult the same budget:
    // with many live workers a full scan at ~2 s per probe would otherwise
    // block signal handling for minutes past the shared window.
    for (const record of records) {
      if (inspectionBudgetExpired()) {
        sawUnverifiable = true;
        break;
      }
    const pid = record.pid;
    if (!Number.isSafeInteger(pid) || /** @type {number} */ (pid) <= 0) {
      sawUnverifiable = true;
      continue;
    }
    const pgid = record.pgid;
    // A record whose group IS this run's spawned host's own group is covered
    // by the host group's own settlement (the real fixture smoke worker
    // shares the host group) — but ONLY when the poll ATTESTED the launch
    // while the host lived: a forged record setting `pgid` to the host pid
    // (with a phantom pid) is exactly the pgid-forgery this attestation
    // refuses. The host pid is not launch authority by itself.
    if (Number.isSafeInteger(pgid) && /** @type {number} */ (pgid) > 0
      && Number.isSafeInteger(hostPid) && /** @type {number} */ (pgid) === hostPid) {
      // COHERENT-CLAIM provenance for shared-group workers: the record's
      // parent claim AND its group must both be this run's spawned host.
      // The poll attestation additionally covers live workers; this
      // post-exit check accepts the coherent claim alone because the
      // worker may have completed before any poll tick. Refusals: an
      // incoherent claim (e.g. ppid 1), and any record whose group is not
      // the host group (those need the trusted boundary's owned evidence
      // below). Documented residual: a forged record with BOTH a host-ppid
      // claim and the host pgid for a phantom pid is indistinguishable
      // post-exit in a same-user model-writable log — bounded to this
      // disposable probe.
      const claimed = recordedClaimedPpid(record);
      // A verified-ancestry ATTESTATION (the poll's chain walk covers
      // launcher/shell intermediaries whose recorded parent differs from
      // the host pid) or the direct coherent claim both carry launch
      // provenance for shared-group workers.
      if (claimed !== hostPid && !attestedWorkerPids.has(/** @type {number} */ (pid))) {
        sawUnverifiable = true;
        continue;
      }
      const settledNow = await isProcessSettled(/** @type {number} */ (pid));
      if (settledNow) continue;
      // CURRENT-MEMBERSHIP revalidation: a recorded shared-group worker
      // that has since MOVED to another group is no longer covered by the
      // host group's kill — report it unresolved instead of claiming a
      // settlement the later host-group kill cannot reach.
      if (hostPid === null || !isProcessInGroup(/** @type {number} */ (pid), hostPid)) {
        sawUnverifiable = true;
        continue;
      }
      // Still ALIVE inside the host group: the host group's own
      // deadline/interrupt/settlement (in the caller's finally) covers it —
      // never signal separately, but HAND the pid back so the caller can
      // verify the settlement after that signal and report honestly if it
      // failed.
      if (Array.isArray(coveredWorkerPids)) coveredWorkerPids.push(/** @type {number} */ (pid));
      continue;
    }
    // OWNERSHIP BEFORE EXIT: a record naming an already-exited pid must not
    // graduate to `verified-exited` unless THIS RUN owned it through the
    // trusted launch boundary — a fabricated record naming a nonexistent
    // process is exactly the forgery the boundary exists to refuse. Exit
    // status alone is not launch provenance.
    const evidence = Number.isSafeInteger(pgid) && /** @type {number} */ (pgid) > 0
      ? ownedGroupEvidence.get(/** @type {number} */ (pgid))
      : null;
    // Two SEPARATE authorities: the historical launch ATTESTATION credits
    // exit status only (a naturally exited worker is `verified-exited`);
    // SIGNALING a group requires the RETAINED, still-validating OWNED
    // entry — attestation alone must never authorize a SIGKILL, because a
    // rewritten record naming a recycled pid with its replacement's real
    // identity would otherwise pass on the attested pid alone.
    const ownedEntry = evidence?.kind === 'worker' && evidence.record.pid === pid
      && ownedGroups.has(/** @type {number} */ (pgid));
    const exitCredit = ownedEntry || attestedWorkerPids.has(/** @type {number} */ (pid));
    // An ADDITIONAL VERIFIED member of an OWNED group (a second worker in
    // the same separately-grouped shell) is covered by the retained
    // worker's group signal: hand it back for the shared post-signal
    // verification INDEPENDENTLY of exitCredit and of log ordering (the
    // extra member may be listed before or after the retained owner).
    // Provenance only — no independent signaling authority.
    const extraMemberCovered = Number.isSafeInteger(pgid)
      && ownedGroups.has(/** @type {number} */ (pgid))
      && ownedGroupExtraMembersMap.has(/** @type {number} */ (pgid))
      && (() => { const extras = ownedGroupExtraMembersMap.get(/** @type {number} */ (pgid)); return extras !== undefined && extras.has(/** @type {number} */ (pid)); })()
      && !(await isProcessSettled(/** @type {number} */ (pid)));
    if (extraMemberCovered) {
      if (Array.isArray(coveredWorkerPids)) coveredWorkerPids.push(/** @type {number} */ (pid));
      continue;
    }
    if (!exitCredit) {
      sawUnverifiable = true;
      continue;
    }
    if (await isProcessSettled(/** @type {number} */ (pid))) continue;
    if (!ownedEntry) {
      // Attested launch, live process, but no OWNED entry to signal
      // through: `settleOwnedGroups` cannot terminate it, so a LIVE
      // attested worker is honestly UNRESOLVED (its settlement would
      // otherwise be silently dropped); only a VERIFIED exit continues
      // without penalty. Attested WIN32 workers with no group semantics
      // follow the same rule.
      if (!(await isProcessSettled(/** @type {number} */ (pid)))) {
        sawUnverifiable = true;
        continue;
      }
      continue;
    }
    tracked.add(record);
    // SIGNALING requires the RETAINED, still-validating OWNED entry —
    // attestation alone must never authorize a SIGKILL, because a
    // rewritten record naming a recycled pid with its replacement's real
    // identity would otherwise pass on the attested pid alone.
    if (Number.isSafeInteger(pgid) && /** @type {number} */ (pgid) > 0) {
      // The SIGNAL validates the RETAINED evidence — the record that was
      // trusted at registration — against the live table, never the
      // incoming log record: a rewritten log naming a recycled pid with
      // its replacement's real identity must fail the retained-evidence
      // check and be refused.
      const retained = evidence?.kind === 'worker' ? evidence.record : null;
      if (retained !== null
        && Number.isSafeInteger(retained.pid) && Number(retained.pid) === pid
        && isRecordedWorkerOwnable(retained, pid, /** @type {number} */ (pgid))
        && signalGroup(/** @type {number} */ (pgid), 'SIGKILL')) {
        signaled.add(record);
      } else {
        sawUnverifiable = true;
      }
      continue;
    }
    sawUnverifiable = true;
  }
  } finally {
    inspectionBudget.deadline = null;
  }
  // ONE shared settlement window for every signaled worker — bounded by the
  // worker grace and the case's own deadline, never N accumulated graces.
  // Post-budget settlement keeps a bounded, NONZERO shared grace: a
  // correctly signaled worker may need ~100 ms to settle even when the
  // case deadline has already passed. The inspection budget stays ARMED
  // through the shared window: both the settlement scan and the final
  // verification scan honor it per probe.
  const sharedDeadline = deadline > Date.now()
    ? Math.min(Date.now() + WORKER_EXIT_GRACE_MS, deadline)
    : Date.now() + WORKER_EXIT_GRACE_MS;
  inspectionBudget.deadline = sharedDeadline;
  for (;;) {
    let allSettled = true;
    for (const record of signaled) {
      if (!(await isProcessSettled(/** @type {number} */ (record.pid)))) {
        allSettled = false;
        break;
      }
    }
    if (allSettled || Date.now() >= sharedDeadline) break;
    await sleep(Math.min(SERVER_EXIT_POLL_MS, Math.max(1, sharedDeadline - Date.now())));
  }
  let unresolved = sawUnverifiable || integrityFailure;
  let terminated = false;
  for (const record of tracked) {
    if (inspectionBudgetExpired()) {
      // The shared window expired mid-verification: the remaining tracked
      // workers cannot be verified — an alive one is unresolved, a gone
      // one still counts as settled.
      let alive = true;
      try { process.kill(/** @type {number} */ (record.pid), 0); } catch { alive = false; }
      if (alive) unresolved = true;
      else if (signaled.has(record)) terminated = true;
      continue;
    }
    if (!(await isProcessSettled(/** @type {number} */ (record.pid)))) unresolved = true;
    else if (signaled.has(record)) terminated = true;
  }
  inspectionBudget.deadline = null;
  if (unresolved) return 'unresolved';
  return terminated ? 'terminated' : 'verified-exited';
}

/** Flag NAMES only — values may carry private paths and are never retained. * @param {string[]} args */
function flagsOf(args) {
  return args.filter((token) => token.startsWith('--'));
}

/**
 * Installs the disposable marketplace and probe plugin into the isolated
 * home. Records which steps succeeded so cleanup removes exactly what was
 * installed.
 * @param {string} codexPath @param {string} marketplaceDirectory @param {{marketplace: boolean, plugin: boolean}} installState
 * @param {NodeJS.ProcessEnv} env @param {number} deadline
 */
async function installProbePlugin(codexPath, marketplaceDirectory, installState, env, deadline) {
  const remaining = () => Math.max(1, Math.min(SUBPROCESS_DEADLINE_MS, deadline - Date.now()));
  const added = await runBoundedSubprocess(codexPath, ['plugin', 'marketplace', 'add', marketplaceDirectory, '--json'], { cwd: marketplaceDirectory, env, deadlineMs: remaining() });
  if (added.code !== 0) return false;
  installState.marketplace = true;
  const plugin = await runBoundedSubprocess(codexPath, ['plugin', 'add', PLUGIN_SELECTOR, '--json'], { cwd: marketplaceDirectory, env, deadlineMs: remaining() });
  if (plugin.code !== 0) return false;
  installState.plugin = true;
  return true;
}

/**
 * One bounded cleanup command; its closed result is recorded, its stderr is
 * never retained.
 * @param {string} codexPath @param {string[]} args @param {NodeJS.ProcessEnv} env @param {string} cwd @param {number} deadline @param {WaitRouteSummary} summary
 */
async function runCleanupCommand(codexPath, args, env, cwd, deadline, summary) {
  const isMarketplace = args[1] === 'marketplace';
  try {
    const result = await runBoundedSubprocess(codexPath, args, {
      cwd,
      env,
      deadlineMs: Math.max(1, Math.min(SUBPROCESS_DEADLINE_MS, deadline - Date.now())),
    });
    if (result.code === 0 && !result.timedOut && !result.overflow) {
      if (isMarketplace) summary.cleanup.marketplaceRemoved = true;
      return;
    }
    summary.cleanup.failures.push(isMarketplace ? 'marketplace-remove-failed' : 'plugin-remove-failed');
  } catch {
    // A cleanup command that cannot even spawn (a host binary that vanished
    // mid-run) is a recorded failure, never a propagation out of the
    // finally block: state-dir removal must always run after this point.
    summary.cleanup.failures.push(isMarketplace ? 'marketplace-remove-failed' : 'plugin-remove-failed');
  }
}

/**
 * POSIX single-quoting for one absolute path: immune to spaces and to every
 * shell metacharacter. Deliberately platform-independent — the calling
 * builder decides which shell family's quoting applies.
 * @param {string} path
 */
function posixQuoteShellPath(path) {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/**
 * Builds the exact command text the smoke prompt asks the host's shell tool
 * to run, one form per shell family, chosen ONLY by the injected platform —
 * never by the host the driver happens to run on. POSIX shells get POSIX
 * single-quoting around both paths (unchanged). Windows hosts run Codex's
 * default PowerShell, where a bare QUOTED executable is a parser error — the
 * call operator `&` must precede it — so the win32 form is
 * `& 'node' 'worker'`, using PowerShell's non-expanding single quotes
 * (embedded quotes doubled). Exported with an injectable platform so both
 * branches stay testable on any host.
 * @param {string} nodePath @param {string} workerPath @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function buildShellWorkerCommand(nodePath, workerPath, platform = process.platform) {
  if (platform === 'win32') {
    /** @param {string} path */
    const psQuote = (path) => `'${path.replaceAll("'", "''")}'`;
    return `& ${psQuote(nodePath)} ${psQuote(workerPath)}`;
  }
  return `${posixQuoteShellPath(nodePath)} ${posixQuoteShellPath(workerPath)}`;
}

/**
 * Runs the host exec for the selected case. The returned stdout is bounded;
 * stderr is a count only. The observation budget kills the child on expiry.
 * @param {{caseLabel: string, codexPath: string, fixture: {workerPath: string}, workspace: string, isolatedTmp: string, isolatedHome: string, codexHome: string, traceDirectory: string, runNonce: string, deadline: number, profile: {workerDurationMs: number, workerNoiseIntervalMs: number, execYieldMs: number, pollYieldMs: number}, hookShape?: string, interruptAfterMs?: number, interruptSignalAtMs?: number}} input
 */
async function runHostExec(input) {
  const { caseLabel, codexPath, fixture, workspace, isolatedTmp, isolatedHome, codexHome, traceDirectory, runNonce, deadline, profile } = input;
  /** @type {string[]} */
  let args;
  /** The exact built worker invocation (shell cases) — the bounded evidence token for child-exec correlation. @type {string|null} */
  let workerCommand = null;
  if (caseLabel === 'hook-entry') {
    // Positive fixture runs MUST NOT skip the fixture config: isolation comes
    // from the fixture-local CODEX_HOME, and the fixture hooks run under the
    // fixture-local trust bypass for this one synthetic prompt. The hook case
    // stays --ephemeral (its Task 2 shape); the shell cases DROP --ephemeral
    // so the host persists its session rollout into the isolated home, which
    // is where the bounded model-decision counting reads from. The rollout
    // never leaves the private run directory (cleanup removes it).
    args = [...EXEC_BASE_FLAGS, ...EPHEMERAL_FLAG, ...EXEC_FLAG_SELECTIONS.hookEntry, ...HOOK_ONLY_FLAGS, '-C', workspace, HOOK_ENTRY_PROMPT];
  } else if (caseLabel === 'hook-hold') {
    // Task 4: the hook-hold case runs WITHOUT --ephemeral so the rollouts
    // persist for the bounded interval-level model-decision check. The
    // TRUSTED shape keeps the fixture-local trust bypass; the UNTRUSTED
    // control deliberately drops it (the installed discovery then lists the
    // hook as Untrusted and does NOT dispatch it).
    const hookFlags = input.hookShape === 'untrusted' ? [] : HOOK_ONLY_FLAGS;
    args = [...EXEC_BASE_FLAGS, ...EXEC_FLAG_SELECTIONS.hookEntry, ...hookFlags, '-C', workspace, HOOK_ENTRY_PROMPT];
  } else {
    const workerPath = join(workspace, WORKER_FILE_NAME);
    await writeFile(workerPath, await readFixtureWorker(fixture), { encoding: 'utf8', mode: 0o755 });
    if (process.platform !== 'win32') await chmod(workerPath, 0o755);
    /** @type {string[]} */
    const workerArguments = [];
    if (profile.workerDurationMs > 0) workerArguments.push('--duration-ms', String(profile.workerDurationMs));
    if (profile.workerNoiseIntervalMs > 0) workerArguments.push('--noise-interval-ms', String(profile.workerNoiseIntervalMs));
    const command = [buildShellWorkerCommand(process.execPath, workerPath), ...workerArguments].join(' ');
    workerCommand = command;
    /** @type {string[]} */
    const yieldSentences = [];
    if (profile.execYieldMs > 0) yieldSentences.push(`For the initial exec_command call pass yield_time_ms: ${profile.execYieldMs}.`);
    if (profile.pollYieldMs > 0) yieldSentences.push(`If it returns a live process handle, observe only that same handle with empty-input write_stdin polls passing yield_time_ms: ${profile.pollYieldMs}; send no characters and never start another process.`);
    const yieldText = yieldSentences.length > 0 ? `\n${yieldSentences.join('\n')}` : '';
    const prompt = caseLabel === 'role-control'
      ? `Spawn exactly one child agent with the spawn agent tool, passing role "${SYNTHETIC_ROLE_NAME}" (this role is declared in the session configuration). The child's assignment must be exactly: Run exactly one command with the shell tool: ${command}${yieldText}\nWhen the command finishes the child replies with its final output line, verbatim, and runs no other command. Then reply with the child's final output line, verbatim. Do not run any command yourself and do not spawn a second agent.`
      : `Run exactly one command with the shell tool: ${command}${yieldText}\nThen reply with the final output line of that command, verbatim. Do not run any other command.`;
    args = [...EXEC_BASE_FLAGS, ...EXEC_FLAG_SELECTIONS.shell, '-C', workspace, prompt];
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return { exitCode: 0, stdout: '', timedOut: true, overflow: false, hostExit: { state: 'killed', code: null }, hostFlags: flagsOf(args), lastOutputAtMs: null, markerAtMs: null, deadlineAtMs: deadline, interruptedAfterMs: null, interruptSignalAtMs: null };
  }
  // While the shell case runs, poll the fixture's launch log: each recorded
  // worker group (the real macOS shape puts the worker in its OWN group) is
  // owned the moment it is known, so budget expiry, the interrupt path, and
  // cleanup can all settle it.
  const launchLogPath = join(workspace, 'worker-launches.jsonl');
  /** The spawned host's pid: the TRUSTED LAUNCH BOUNDARY anchor (null until spawn). @type {number|null} */
  let trustedHostPid = null;
  /** Set when the observation settles: pending discovery continuations are invalidated. @type {boolean} */
  let discoveryClosed = false;
  const onPoll = caseLabel === 'shell-window' || caseLabel === 'role-control'
    ? () => {
        // While the spawned host lives, a recorded worker is owned only when
        // its ancestry reaches this run's host pid — a model-writable record
        // naming an unrelated process (even with its real identity) is never
        // owned. Once the host has exited, no new ownership can be
        // established from the log (fail closed); already-owned entries stay
        // maintained and are validated at the signaling boundary.
        return readWorkerLaunchRecords(launchLogPath).then(({ records }) => {
          // Once the observation has settled, a pending read continuation
          // is invalidated: late ownership creation after settleOwnedGroups
          // would leave a group owned with no later settlement.
          if (discoveryClosed) return;
          ownRecordedWorkerGroups(records, { trustedHostPid, inspectionDeadline: input.deadline ?? null });
        });
      }
    : undefined;
  // Task 6: an optional SCHEDULED interrupt of the host group mid-run (the
  // hook-hold cancellation probe). The timer arms at spawn; firing signals
  // the host's WHOLE owned group with SIGINT (the same boundary the
  // interactive interrupt path uses), and the scheduled fact is returned so
  // classification can distinguish a scheduled probe interrupt from budget
  // expiry. The timer never fires after the observation settles.
  /** The scheduled mid-run interrupt, armed at spawn. @type {NodeJS.Timeout|null} */
  let interruptTimer = null;
  let interruptedAfterMs = null;
  let interruptSignalAtMs = null;
  /** @type {((child: import('node:child_process').ChildProcess) => void)[]} */
  const spawnCallbacks = [];
  if (caseLabel === 'hook-hold' && (input.interruptAfterMs ?? 0) > 0) {
    spawnCallbacks.push((child) => {
      const scheduledAfterMs = input.interruptAfterMs ?? 0;
      interruptTimer = setTimeout(() => {
        interruptedAfterMs = scheduledAfterMs;
        interruptSignalAtMs = Date.now();
        signalOwnedGroup(child, 'SIGINT');
      }, scheduledAfterMs);
    });
  }
  const result = await runBoundedSubprocess(codexPath, args, {
    cwd: workspace,
    env: { ...hostEnvironment(isolatedTmp, isolatedHome, codexHome), WAIT_ROUTE_PROBE_TRACE: join(traceDirectory, 'events.jsonl'), WAIT_ROUTE_PROBE_NONCE: runNonce },
    deadlineMs: remaining,
    stdoutMaxBytes: HOST_STDOUT_MAX_BYTES,
    markerText: COMPLETION_MARKER,
    onSpawn: (child) => {
      trustedHostPid = child.pid ?? null;
      for (const callback of spawnCallbacks) callback(child);
    },
    ...(onPoll ? { pollMs: 250, onPoll, onSettled: () => { discoveryClosed = true; if (interruptTimer !== null) clearTimeout(interruptTimer); } } : {}),
  });
  if (interruptTimer !== null) clearTimeout(interruptTimer);
  const hostExit = result.timedOut ? { state: 'killed', code: null } : { state: result.code === 0 ? 'exit-0' : 'exit-nonzero', code: result.code };
  return { exitCode: result.code ?? -1, stdout: result.stdout, timedOut: result.timedOut, overflow: result.overflow, hostExit, hostFlags: flagsOf(args), lastOutputAtMs: result.lastOutputAtMs, markerAtMs: result.markerAtMs, deadlineAtMs: result.deadlineAtMs, hostPid: result.child?.pid ?? null, workerCommand, interruptedAfterMs, interruptSignalAtMs };
}

/**
 * Runs one selected wait-route probe case to a bounded, redacted summary.
 * Instrument failures throw closed codes; every bounded conclusion (including
 * inconclusive ones naming the missing prerequisite) returns a summary.
 * @param {{caseLabel: string, codexPath: string, outputDir: string, budgetMs: number, sourceCodexHome?: string, workerDurationMs?: number, workerNoiseIntervalMs?: number, execYieldMs?: number, pollYieldMs?: number, backgroundTerminalMaxTimeoutMs?: number, hookShape?: string, hookHoldMs?: number, hookTimeoutSec?: number, hookToolTimeoutSec?: number, interruptAfterMs?: number}} input
 * @returns {Promise<WaitRouteSummary>}
 */
export async function runWaitRouteCase(input) {
  const { caseLabel, outputDir, budgetMs } = input;
  /** Task 4 hook-hold shape options (programmatic defaults match the CLI defaults). */
  const hookShape = input.hookShape ?? 'hold';
  const hookHoldMs = input.hookHoldMs ?? 2_000;
  const hookTimeoutSec = input.hookTimeoutSec ?? 15;
  const hookToolTimeoutSec = input.hookToolTimeoutSec ?? 30;
  const interruptAfterMs = input.interruptAfterMs ?? 0;
  const profile = validateShellProfile({
    workerDurationMs: input.workerDurationMs,
    workerNoiseIntervalMs: input.workerNoiseIntervalMs,
    execYieldMs: input.execYieldMs,
    pollYieldMs: input.pollYieldMs,
    backgroundTerminalMaxTimeoutMs: input.backgroundTerminalMaxTimeoutMs,
  }, caseLabel);
  const stageDeadline = Date.now() + budgetMs;
  /** Shared-group worker pids covered by the host group's settlement, handed back by settleWorkerExits for post-signal verification. @type {number[]} */
  const coveredWorkerPids = [];

  const runNonce = randomBytes(32).toString('hex');
  const traceDirectory = join(outputDir, 'trace');
  const codexHome = join(outputDir, 'codex-home');
  const isolatedHome = join(outputDir, 'home');
  const isolatedTmp = join(outputDir, 'tmp');
  const workspace = join(outputDir, 'workspace');
  const marketplaceDirectory = join(outputDir, 'marketplace');
  /** Every state directory the run owns; cleanup removes exactly these. */
  const cleanupDirectories = [codexHome, isolatedHome, isolatedTmp, workspace];
  const installState = { marketplace: false, plugin: false };
  /** @type {string|null} */
  let codexPath = null;
  /** Whether this invocation validated the output directory and owns its state. */
  let ownsOutputState = false;

  /** @type {WaitRouteSummary} */
  const summary = {
    probe: 'zcode-wait-route-probe',
    caseLabel,
    codexVersion: null,
    outcome: 'inconclusive',
    reason: 'unknown',
    stage: 'validate',
    hostExit: { state: 'not-run', code: null },
    hostFlags: [],
    trace: {
      serverStarted: false, handlerEntered: false, handlerCompleted: false, handlerCompletedAtMs: null,
      markerObserved: null, workerLaunches: null, possibleDuplicateLaunch: null, workerLaunchAtMs: null,
      events: 0, truncated: false, serverParentOfHost: null,
    },
    fixture: { backgroundTerminalMaxTimeoutMs: profile.backgroundTerminalMaxTimeoutMs > 0 ? profile.backgroundTerminalMaxTimeoutMs : null, multiAgentFeature: caseLabel === 'role-control', agentRoles: [] },
    requestedProfile: { workerDurationMs: profile.workerDurationMs, workerNoiseIntervalMs: profile.workerNoiseIntervalMs, execYieldMs: profile.execYieldMs, pollYieldMs: profile.pollYieldMs },
    session: null,
    cleanup: { marketplaceRemoved: false, isolatedHomeRemoved: false, serverExit: 'not-started', workerExit: 'not-started', failures: [] },
    budgetMs,
  };

  try {
    codexPath = await resolveCodexBinary(input.codexPath);
    await validateOutputDirectory(outputDir);
    // Ownership starts HERE, only after the output directory validated as a
    // private empty directory: every state path below is created by this
    // invocation, so every exit path may remove them. A rejected (occupied
    // or invalid) directory never reaches this point — its pre-existing
    // contents, including any pre-existing trace, are never removed, read
    // for classification, or appended to.
    ownsOutputState = true;
    await mkdir(traceDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(traceDirectory, 0o700);
    for (const directory of [codexHome, isolatedHome, isolatedTmp, workspace, marketplaceDirectory]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') await chmod(directory, 0o700);
    }
    // Register the marketplace tree for cleanup BEFORE the build: a fixture
    // build that fails mid-write must still be removed with the rest of the
    // run state, leaving only the private trace behind.
    cleanupDirectories.push(marketplaceDirectory);
    await appendTraceEvent({ runDirectory: traceDirectory, runNonce, event: { kind: 'case-started', caseLabel } });

    summary.stage = 'version';
    summary.codexVersion = await resolveCodexVersion(codexPath, workspace, isolatedTmp, isolatedHome, codexHome, stageDeadline);

    if (caseLabel === 'authority' || caseLabel === 'lifecycle') {
      // These cases need the viable candidate's own MCP prerequisites from
      // later tasks; they report that honestly instead of pretending.
      summary.stage = 'validate';
      summary.outcome = 'not-instrumented';
      summary.reason = 'candidate-prerequisites-not-established';
      return summary;
    }

    summary.stage = 'auth';
    const authCopied = await copySourceAuth(input.sourceCodexHome ?? resolveSourceCodexHome(), codexHome);
    if (!authCopied) {
      summary.outcome = 'inconclusive';
      summary.reason = 'auth-unavailable';
      return summary;
    }
    // The role-control case prepares its clearly labeled SYNTHETIC role
    // control first: the role file declares the raised cap so the case can
    // measure whether a role-declared value propagates at all. The managed
    // production Role is never touched.
    /** @type {{name: string, description: string, configPath: string}[]} */
    const syntheticRoles = [];
    if (caseLabel === 'role-control') {
      // The role directory path is DETERMINISTIC (join(outputDir, 'role')):
      // register it BEFORE the builder runs so a partial build (e.g.
      // ENOSPC mid-write) is covered by cleanup too.
      cleanupDirectories.push(join(outputDir, 'role'));
      const syntheticRole = await buildWaitRouteSyntheticRole({ outputDir });
      syntheticRoles.push({ name: syntheticRole.roleName, description: syntheticRole.description, configPath: syntheticRole.rolePath });
      summary.fixture.agentRoles.push(syntheticRole.roleName);
    }
    await writeFixtureConfig({
      codexHome,
      ...(profile.backgroundTerminalMaxTimeoutMs > 0 ? { backgroundTerminalMaxTimeoutMs: profile.backgroundTerminalMaxTimeoutMs } : {}),
      ...(caseLabel === 'role-control' ? { multiAgentFeature: true, agentRoles: syntheticRoles } : {}),
      // The disabled-hook control turns the discovery feature OFF.
      ...(caseLabel === 'hook-hold' ? { hooksFeature: hookShape !== 'disabled' } : {}),
    });

    const serverModulePath = join(dirname(fileURLToPath(import.meta.url)), 'server.mjs');
    const fixture = await buildWaitRouteFixture({
      outputDir: marketplaceDirectory,
      serverPath: serverModulePath,
      ...(caseLabel === 'hook-hold' ? {
        hookTool: 'prompt_hold',
        hookTimeoutSec,
        holdMs: hookHoldMs,
        toolTimeoutSec: hookToolTimeoutSec,
        serverAvailable: hookShape !== 'unavailable',
        orderingHooks: hookShape === 'ordering',
      } : {}),
    });

    summary.stage = 'install';
    const hostEnv = hostEnvironment(isolatedTmp, isolatedHome, codexHome);
    if (caseLabel === 'hook-entry' || caseLabel === 'hook-hold') {
      const installed = await installProbePlugin(codexPath, marketplaceDirectory, installState, hostEnv, stageDeadline);
      if (!installed) {
        summary.outcome = 'inconclusive';
        summary.reason = 'install-failed';
        return summary;
      }
    }

    summary.stage = 'exec';
    const exec = await runHostExec({ caseLabel, codexPath, fixture, workspace, isolatedTmp, isolatedHome, codexHome, traceDirectory, runNonce, deadline: stageDeadline, profile, ...(caseLabel === 'hook-hold' ? { hookShape, interruptAfterMs } : {}) });
    summary.hostExit = exec.hostExit;
    summary.hostFlags = exec.hostFlags;
    // The durable trace facts are read on EVERY post-exec path: observed
    // entry is never suppressed by a host failure, an output overflow, or an
    // expired budget.
    const facts = await readTraceFacts(caseLabel, traceDirectory, workspace, runNonce, exec.hostPid ?? null, profile);
    // Local versus executor-scoped dispatch, OBSERVED: the fixture server's
    // recorded startup ppid compared against the spawned host's pid. An
    // 'in-host' relation means the server is a direct child of the host
    // process; raw pids are never retained in the summary (the relation
    // only).
    const serverParentOfHost = exec.hostPid != null && facts.serverParentPid != null
      ? (facts.serverParentPid === exec.hostPid ? 'in-host' : 'other')
      : null;
    // The summary carries the RELATION only — the raw server ppid stays in
    // the durable trace, never in the redacted summary.
    const { serverParentPid: rawServerParentPid, ...summaryFacts } = facts;
    void rawServerParentPid;
    summary.trace = { ...summary.trace, ...summaryFacts, serverParentOfHost, markerObserved: caseLabel === 'shell-window' || caseLabel === 'role-control' ? exec.stdout.includes(COMPLETION_MARKER) : null };
    // Bounded model-decision counting over the isolated home's session
    // rollouts (the shell cases run WITHOUT --ephemeral exactly so this
    // durable record exists); diagnostic only — never a classification gate.
    if (caseLabel === 'shell-window' || caseLabel === 'role-control' || caseLabel === 'hook-hold') {
      summary.session = await summarizeCodexSessions({
        sessionsDirectory: join(codexHome, 'sessions'),
        // The EXACT built worker invocation is the bounded evidence token
        // tying a child rollout's exec to THE probe command — a bare
        // basename mention (`echo wait-route-worker.mjs`) is not an
        // invocation. The token is compared, never retained (the summary
        // keeps only the boolean match fact).
        workerEvidenceToken: exec.workerCommand ?? undefined,
      });
    }
    // The shell worker's exit is verified and settled separately from the
    // host on every post-exec path, and the summary reflects it.
    if (caseLabel === 'shell-window' || caseLabel === 'role-control') {
      summary.cleanup.workerExit = await settleWorkerExits(join(workspace, 'worker-launches.jsonl'), stageDeadline, exec.hostPid ?? null, coveredWorkerPids);
      if (coveredWorkerPids.length > 0 && summary.cleanup.workerExit === 'verified-exited') {
        // Covered workers are settled by the host group's own signal in the
        // cleanup below; the post-settle verification (after
        // settleOwnedGroups) finalizes the report. If classification later
        // GRANTS a success (shell-smoke-completed), that grant stays
        // conditional until this verification finishes — a failed covered
        // settlement revokes it (the revocation lives in the finally where
        // the verification runs, using coveredSettlementRevoked).
        summary.cleanup.workerExit = 'not-started';
      }
    }
    if (exec.timedOut) {
      // The budget expired while the host was running: entry evidence that
      // already landed is reported honestly instead of being masked by the
      // budget outcome. Smoke success additionally requires the marker to
      // have ARRIVED within the budget — output written by a descendant
      // after the observation expired is evidence, never a clean success.
      // Completion evidence counts as before-budget only when its trace
      // timestamp proves it landed within the observation window; a late
      // completion (e.g. a server surviving outside the killed host group)
      // stays recorded in the trace but never yields entry-observed. The
      // smoke grant is governed by the MARKER's own arrival time — the
      // marker is timestamped at match time, so later unrelated stdout
      // never retroactively invalidates an in-budget marker.
      const completedWithinBudget = facts.handlerCompletedAtMs !== null && facts.handlerCompletedAtMs <= stageDeadline;
      const markerWithinBudget = exec.markerAtMs !== null && exec.markerAtMs <= stageDeadline;
      // An output overflow is a FAILURE even when the observation also
      // expired: the expiry branch must not grant a success that hides it.
      if (exec.overflow) {
        summary.outcome = 'host-error';
        summary.reason = 'output-overflow';
      } else if (caseLabel === 'hook-entry' && facts.handlerEntered && facts.handlerCompleted && completedWithinBudget) {
        summary.outcome = 'entry-observed';
        summary.reason = 'observed-before-budget-expiry';
      } else if ((caseLabel === 'shell-window' || caseLabel === 'role-control') && summary.trace.markerObserved && facts.workerLaunches === 1 && markerWithinBudget && !facts.workerLaunchesTruncated && !facts.workerLaunchesIncomplete && summary.cleanup.workerExit !== 'unresolved' && facts.workerProfileMatches !== false) {
        // workerExit 'unresolved' means the recorded launch was never owned
        // through the trusted boundary — the model-writable log alone is
        // not execution evidence, so the smoke grant refuses it. A
        // role-control grant additionally requires CORROBORATED managed-
        // child execution (spawn_agent for the synthetic role + exec in
        // the child rollouts): the model running the command directly in
        // Root would otherwise look identical.
        if (caseLabel === 'role-control' && !roleChildProven(summary)) {
          summary.outcome = 'inconclusive';
          summary.reason = 'role-session-evidence-missing';
          return summary;
        }
        if (profile.workerDurationMs > 0 && summary.cleanup.workerExit === 'terminated') {
          // On a PROFILED run the worker prints the marker only at its
          // natural finish: a marker arriving while the worker still runs
          // (settlement had to kill it) was not terminal evidence —
          // fabricated or premature. Successful cleanup does not prove
          // successful execution.
          summary.outcome = 'inconclusive';
          summary.reason = 'worker-still-running-at-marker';
          return summary;
        }
        summary.outcome = caseLabel === 'role-control' ? 'role-control-completed' : 'shell-smoke-completed';
        summary.reason = 'observed-before-budget-expiry';
      } else {
        summary.outcome = 'budget-exhausted';
        summary.reason = 'observation-budget-exhausted';
      }
      return summary;
    }
    if (exec.overflow) {
      summary.outcome = 'host-error';
      summary.reason = 'output-overflow';
      return summary;
    }
    if (exec.exitCode !== 0 && !(caseLabel === 'hook-hold' && exec.interruptedAfterMs !== null)) {
      // A host failure after a completed handler is an honest combination:
      // the outcome stays host-error while the trace facts above keep the
      // observed entry visible. EXCEPTION: the hook-hold SCHEDULED interrupt
      // probe — the signal-induced exit IS the observed cancellation, and
      // the hook-hold classification below builds the hook block from the
      // durable trace (the round-79 review finding: the diagnostics must be
      // preserved past the early return).
      summary.outcome = 'host-error';
      summary.reason = 'exec-failed';
      return summary;
    }

    summary.stage = 'classify';
    const cleanCompletedWithinBudget = facts.handlerCompletedAtMs !== null && facts.handlerCompletedAtMs <= exec.deadlineAtMs;
    if (caseLabel === 'hook-entry') {
      if (!summary.trace.serverStarted) {
        summary.outcome = 'server-not-started';
        summary.reason = 'probe-server-never-started';
      } else if (!summary.trace.handlerEntered || !summary.trace.handlerCompleted) {
        summary.outcome = 'entry-not-observed';
        summary.reason = 'handler-entry-incomplete';
      } else if (!cleanCompletedWithinBudget) {
        // A completion landing AFTER the observation budget (an
        // independently surviving server) stays recorded as evidence but
        // never qualifies the observation — the same rule the budget-expiry
        // branch applies.
        summary.outcome = 'budget-exhausted';
        summary.reason = 'observation-budget-exhausted';
      } else {
        summary.outcome = 'entry-observed';
        summary.reason = 'ok';
      }
      return summary;
    }
    if (caseLabel === 'hook-hold') {
      // Task 4 classification: the trusted hold, its controls, the ordering
      // probe, and the timeout probe — each judged from the DURABLE trace
      // facts and the bounded interval-level model-decision count.
      const settledWithinBudget = facts.hookSettledAtMs !== null && facts.hookSettledAtMs <= stageDeadline;
      // The hold's NATURAL completion settles at its own deadline timer
      // ('deadline'); 'signal-abort' and 'transport-close' are CUT holds.
      const holdCompletedNaturally = facts.hookSettlement === 'deadline';
      // Bounded interval-level model-decision count over the persisted
      // rollouts: decisions timestamped INSIDE the pending hold interval.
      // Absent rollouts (the fake-host harness) report null — never a
      // silent zero; present-but-unreadable rollouts downgrade to
      // inconclusive rather than granting.
      let decisionsDuringHold = null;
      let firstDecisionAtMs = null;
      let rolloutsComplete = false;
      if (summary.session !== null && summary.session.present === true) {
        // Fail closed on coverage: a TRUNCATED or sample-truncated rollout
        // cannot assert zero decisions — the interval counts only over
        // complete coverage (the round-78 review finding).
        // Usable coverage: at least one rollout file carrying at least one
        // record — an empty sessions directory or an empty rollout file is
        // present-but-unusable evidence, never a zero-decision proof (the
        // round-78 review finding).
        const rolloutRecordCount = (summary.session.perFile ?? []).reduce((total, file) => total + (typeof file.records === 'number' ? file.records : 0), 0);
        rolloutsComplete = summary.session.truncated === false && summary.session.callsTruncated === false
          && (typeof summary.session.files === 'number' ? summary.session.files >= 1 : false)
          && rolloutRecordCount >= 1;
        if (rolloutsComplete && facts.hookEnteredAtMs !== null && facts.hookSettledAtMs !== null) {
          decisionsDuringHold = 0;
          for (const call of summary.session.calls ?? []) {
            if (typeof call.atMs !== 'number' || !Number.isFinite(call.atMs)) {
              // A supported call with an UNKNOWN timestamp cannot be
              // attributed to (or excluded from) the interval — the
              // zero-decision proof refuses it (round-79 review finding).
              decisionsDuringHold = null;
              break;
            }
            if (firstDecisionAtMs === null || call.atMs < firstDecisionAtMs) firstDecisionAtMs = call.atMs;
            if (call.atMs > facts.hookEnteredAtMs && call.atMs < facts.hookSettledAtMs) decisionsDuringHold += 1;
          }
        }
      }
      const intervalMs = facts.hookEnteredAtMs !== null && facts.hookSettledAtMs !== null ? facts.hookSettledAtMs - facts.hookEnteredAtMs : null;
      summary.hook = {
        shape: hookShape,
        holdMs: hookHoldMs,
        hookTimeoutSec,
        toolTimeoutSec: hookToolTimeoutSec,
        dispatches: facts.hookDispatches,
        enteredAtMs: facts.hookEnteredAtMs,
        settledAtMs: facts.hookSettledAtMs,
        settlement: facts.hookSettlement,
        effectiveHoldMs: intervalMs,
        effectiveBoundMs: hookShape === 'timeout' ? intervalMs : null,
        interruptedAfterMs: exec.interruptedAfterMs ?? null,
        interruptSignalAtMs: exec.interruptSignalAtMs ?? null,
        decisionsDuringHold,
        firstDecisionAtMs,
        overlappingDispatches: facts.hookOverlappingDispatches,
      };
      if (exec.overflow) {
        summary.outcome = 'host-error';
        summary.reason = 'output-overflow';
      } else if (facts.truncated) {
        // A TRUNCATED hook trace cannot establish exactly-one dispatch or
        // any interval attribution: no qualification verdict from
        // incomplete hook evidence (round-81 review finding).
        summary.outcome = 'inconclusive';
        summary.reason = 'hook-trace-truncated';
      } else if (exec.interruptedAfterMs !== null && hookShape === 'hold') {
        // The SCHEDULED cancellation probe: the host group was signaled
        // mid-hold. The observation is the durable hook state — an
        // interrupted hold never reports its own deadline settlement.
        // Attribution (round-80 review finding): the hold must have been
        // PENDING at the recorded signal time — a hold that settled at its
        // own deadline BEFORE the signal is a completion, never interruption
        // credit. No settlement evidence at all (a signal-killed pending
        // hold) still attributes: the observation never ended on its own.
        // Attribution (rounds 80-82): interruption credit requires the
        // dispatch to have ENTERED before the recorded signal time, and
        // rejects EVERY natural deadline settlement (before OR after the
        // signal — a hold that completes naturally was never cancelled by
        // it) plus every settlement at or before the signal.
        const dispatchedBeforeSignal = facts.hookEnteredAtMs !== null
          && exec.interruptSignalAtMs != null
          && facts.hookEnteredAtMs < exec.interruptSignalAtMs;
        const settledBeforeSignal = facts.hookSettledAtMs !== null
          && exec.interruptSignalAtMs != null
          && facts.hookSettledAtMs <= exec.interruptSignalAtMs;
        if (facts.hookDispatches !== 1) {
          summary.outcome = 'inconclusive';
          summary.reason = 'hook-dispatch-missing';
        } else if (!dispatchedBeforeSignal) {
          summary.outcome = 'inconclusive';
          summary.reason = 'hold-dispatched-after-interrupt';
        } else if (facts.hookSettlement === 'deadline' || settledBeforeSignal) {
          summary.outcome = 'inconclusive';
          summary.reason = facts.hookSettlement === 'deadline' ? 'hold-completed-naturally' : 'hold-settled-before-interrupt';
        } else {
          summary.outcome = 'hook-interrupt-observed';
          summary.reason = 'ok';
        }
      } else if (exec.hostExit.state !== 'exit-0') {
        summary.outcome = 'host-error';
        summary.reason = 'exec-failed';
      } else if (hookShape === 'hold') {
        if (facts.hookDispatches !== 1 || !holdCompletedNaturally || !settledWithinBudget) {
          summary.outcome = 'inconclusive';
          summary.reason = facts.hookDispatches === 0 ? 'hook-dispatch-missing' : 'hook-hold-incomplete';
        } else if (decisionsDuringHold !== 0) {
          // FAIL CLOSED on every non-zero shape: absent rollouts (null),
          // present-but-unusable coverage, and observed decisions are all
          // inconclusive — the zero-decision grant exists ONLY over complete
          // coverage (the round-78 review finding).
          summary.outcome = 'inconclusive';
          summary.reason = decisionsDuringHold === null ? 'hold-interval-evidence-missing'
            : !rolloutsComplete ? 'hold-interval-evidence-missing'
              : 'model-decisions-during-hold';
        } else {
          summary.outcome = 'hook-hold-completed';
          summary.reason = 'ok';
        }
      } else if (hookShape === 'timeout') {
        // Attribution (round-80 review finding): only a CANCELLED call
        // (signal-abort) landing within the configured hook budget is
        // timeout evidence — a transport loss or missing settlement is
        // recorded as unattributed, never as timeout credit.
        const withinHookBudget = facts.hookSettledAtMs !== null && facts.hookEnteredAtMs !== null
          && (facts.hookSettledAtMs - facts.hookEnteredAtMs) <= hookTimeoutSec * 1000 + 1_000;
        if (facts.hookDispatches !== 1 || holdCompletedNaturally
          || facts.hookSettlement !== 'signal-abort' || !withinHookBudget) {
          summary.outcome = 'inconclusive';
          summary.reason = facts.hookDispatches === 0 ? 'hook-dispatch-missing'
            : holdCompletedNaturally ? 'hook-timeout-not-observed'
              : 'hook-cut-unattributed';
        } else {
          summary.outcome = 'hook-timeout-observed';
          summary.reason = 'ok';
        }
      } else if (hookShape === 'ordering') {
        if (facts.hookDispatches !== 1 || facts.hookOverlappingDispatches !== true) {
          summary.outcome = 'inconclusive';
          summary.reason = facts.hookDispatches === 0 ? 'hook-dispatch-missing' : 'same-event-dispatchs-serialized';
        } else {
          summary.outcome = 'hook-ordering-concurrent';
          summary.reason = 'ok';
        }
      } else if (facts.hookDispatches !== 0) {
        // The controls accept NO synthetic work: any dispatch is a failure
        // of the control, not a pass.
        summary.outcome = 'inconclusive';
        summary.reason = `control-dispatched-${hookShape}`;
      } else if (hookShape === 'unavailable' && facts.serverStarted) {
        summary.outcome = 'inconclusive';
        summary.reason = 'unavailable-server-started';
      } else {
        summary.outcome = hookShape === 'disabled' ? 'hook-control-disabled'
          : hookShape === 'untrusted' ? 'hook-control-untrusted'
            : 'hook-control-server-unavailable';
        summary.reason = 'ok';
      }
      return summary;
    }
    // shell-window and role-control: the fixed marker AND the worker's own
    // launch log must both corroborate the run — the marker alone can come
    // from a model response or another command, and a second launch is
    // flagged, never silently accepted.
    if (!summary.trace.markerObserved) {
      summary.outcome = 'inconclusive';
      summary.reason = 'marker-absent';
    } else if ((summary.trace.workerLaunches ?? 0) === 0 || facts.workerLaunchesTruncated || facts.workerLaunchesIncomplete) {
      summary.outcome = 'inconclusive';
      summary.reason = 'worker-launch-evidence-missing';
    } else if ((summary.trace.workerLaunches ?? 0) > 1) {
      summary.outcome = 'inconclusive';
      summary.reason = 'duplicate-launch';
    } else if (summary.cleanup.workerExit === 'unresolved') {
      // The recorded worker was never OWNED through the trusted launch
      // boundary: the model-writable log is not execution evidence, so a
      // shape-valid record + marker cannot qualify the smoke.
      summary.outcome = 'inconclusive';
      summary.reason = 'worker-launch-evidence-missing';
    } else if (caseLabel === 'role-control' && summary.session !== null && !summary.session.present) {
      // A role-control run must prove the SYNTHETIC ROLE executed the
      // command: without a session rollout there is no evidence the host
      // spawned the managed child at all (the model may have run the
      // command directly in Root) — report an inconclusive control.
      summary.outcome = 'inconclusive';
      summary.reason = 'role-session-evidence-missing';
    } else if (caseLabel === 'role-control' && !roleChildProven(summary)) {
      summary.outcome = 'inconclusive';
      summary.reason = 'role-session-evidence-missing';
    } else if (facts.workerProfileMatches === false) {
      // The launched worker's OWN record disagrees with the requested
      // profile: the remaining-lifetime math of the requested profile is
      // not evidence of what ran.
      summary.outcome = 'inconclusive';
      summary.reason = 'worker-profile-mismatch';
    } else if (profile.workerDurationMs > 0 && summary.cleanup.workerExit === 'terminated') {
      // On a PROFILED run the worker prints the marker only at its natural
      // finish: a marker arriving while the worker still runs (settlement
      // had to kill it) was not terminal evidence. The bare marker-then-
      // late-noise research shape is unaffected — its worker intentionally
      // stays alive to emit post-budget noise.
      summary.outcome = 'inconclusive';
      summary.reason = 'worker-still-running-at-marker';
    } else {
      summary.outcome = caseLabel === 'role-control' ? 'role-control-completed' : 'shell-smoke-completed';
      summary.reason = 'ok';
    }
    return summary;
  } finally {
    // The recorded stage stays the one where the outcome was concluded;
    // cleanup always runs for OWNED state and its results land in
    // cleanup.failures. Every step before state-dir removal is contained so
    // removal always runs. A rejected (occupied/invalid) output directory
    // was never owned: nothing is removed and no pre-existing trace is read
    // or appended to.
    if (ownsOutputState) {
      const cleanupDeadline = Math.max(stageDeadline, Date.now() + CLEANUP_FLOOR_MS);
      try {
        summary.cleanup.serverExit = await ensureServerExitByTrace({
          runDirectory: traceDirectory,
          runNonce,
          graceMs: Math.max(200, Math.min(SERVER_EXIT_VERIFY_GRACE_MS, cleanupDeadline - Date.now())),
        });
      } catch {
        summary.cleanup.serverExit = 'unresolved';
        summary.cleanup.failures.push('server-exit-verify-failed');
      }
      const hostEnv = hostEnvironment(isolatedTmp, isolatedHome, codexHome);
      if (installState.plugin) await runCleanupCommand(/** @type {string} */ (codexPath), ['plugin', 'remove', PLUGIN_SELECTOR, '--json'], hostEnv, workspace, cleanupDeadline, summary);
      if (installState.marketplace) await runCleanupCommand(/** @type {string} */ (codexPath), ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME, '--json'], hostEnv, workspace, cleanupDeadline, summary);
      // Settle any owned group whose leader exited early while descendants
      // survived; a still-running host is killed by the case deadline, but a
      // survivor outliving its leader is only owned through this registry.
      settleOwnedGroups();
      // Post-signal verification for covered shared-group workers: the
      // host group's signal must have settled them; a survivor is
      // honestly reported unresolved instead of a stale verified-exited.
      if (coveredWorkerPids.length > 0) {
        // SIGKILL delivery does not guarantee an exited-or-zombie state at
        // the first sample: await the covered workers against ONE bounded
        // shared grace before reporting the final cleanup result. The
        // inspection budget is ARMED BEFORE THE WAIT LOOP and stays armed
        // across both scans (each probe clamped to the remaining budget).
        const coveredDeadline = Date.now() + WORKER_EXIT_GRACE_MS;
        inspectionBudget.deadline = coveredDeadline;
        for (;;) {
          let allSettled = true;
          for (const coveredPid of coveredWorkerPids) {
            if (!(await isProcessSettled(coveredPid))) {
              allSettled = false;
              break;
            }
          }
          if (allSettled || Date.now() >= coveredDeadline) break;
          await sleep(Math.min(SERVER_EXIT_POLL_MS, Math.max(1, coveredDeadline - Date.now())));
        }
        inspectionBudget.deadline = coveredDeadline;
        let verified = true;
        let verificationExpired = false;
        for (const coveredPid of coveredWorkerPids) {
          if (inspectionBudgetExpired()) { verificationExpired = true; break; }
          if (!(await isProcessSettled(coveredPid))) verified = false;
        }
        if (!verified || verificationExpired) {
          // A surviving worker OR an expired/skipped verification must never
          // report `terminated` or retain smoke success (from EITHER grant
          // path): only a COMPLETED verification with every worker settled
          // earns `terminated`.
          summary.cleanup.workerExit = 'unresolved';
          if (summary.outcome === 'shell-smoke-completed' || summary.outcome === 'role-control-completed') {
            summary.outcome = 'inconclusive';
            summary.reason = 'covered-settlement-unresolved';
          }
        } else if (summary.cleanup.workerExit === 'not-started') {
          summary.cleanup.workerExit = 'terminated';
          // A PROFILED worker prints the marker only at its natural finish:
          // if the DEFERRED (covered) settlement had to terminate it, any
          // granted success rested on a premature marker — revoke it here,
          // after settlement finalizes.
          if (profile.workerDurationMs > 0
            && (summary.outcome === 'shell-smoke-completed' || summary.outcome === 'role-control-completed')) {
            summary.outcome = 'inconclusive';
            summary.reason = 'worker-still-running-at-marker';
          }
        }
      }
      await removeStateDirectories(cleanupDirectories, [codexHome, isolatedHome], summary);
      await appendTraceEvent({ runDirectory: traceDirectory, runNonce, event: { kind: 'case-finished', caseLabel, outcome: summary.outcome } }).catch(() => {});
    }
  }
}

/**
 * Reads the durable trace facts shared by the classify and budget-expiry
 * paths. The marker observation is the caller's (it comes from the bounded
 * host stdout, not the trace).
 * @param {string} caseLabel @param {string} traceDirectory @param {string} workspace @param {string} runNonce @param {number|null} caseHostPid @param {{workerDurationMs: number, workerNoiseIntervalMs: number}} profile
 * @returns {Promise<{serverStarted: boolean, handlerEntered: boolean, handlerCompleted: boolean, handlerCompletedAtMs: number|null, workerLaunches: number|null, workerLaunchesTruncated: boolean, workerLaunchesIncomplete: boolean, workerProfileMatches: boolean|null, possibleDuplicateLaunch: boolean|null, workerLaunchAtMs: number|null, events: number, truncated: boolean, hookDispatches: number, hookEnteredAtMs: number|null, hookSettledAtMs: number|null, hookSettlement: string|null, hookOverlappingDispatches: boolean|null, serverParentPid: number|null}>}
 */
async function readTraceFacts(caseLabel, traceDirectory, workspace, runNonce, caseHostPid, profile) {
  const { records, truncated } = await readTraceEvents({ runDirectory: traceDirectory, runNonce });
  let handlerCompletedAtMs = null;
  let serverParentPid = null;
  for (const record of records) {
    if (record.kind === 'handler-completed' && typeof record.at === 'number') handlerCompletedAtMs = record.at;
    if (record.kind === 'server-started' && typeof record.parentPid === 'number') serverParentPid = record.parentPid;
  }
  /** @type {{serverStarted: boolean, handlerEntered: boolean, handlerCompleted: boolean, handlerCompletedAtMs: number|null, workerLaunches: number|null, workerLaunchesTruncated: boolean, workerLaunchesIncomplete: boolean, workerProfileMatches: boolean|null, possibleDuplicateLaunch: boolean|null, workerLaunchAtMs: number|null, events: number, truncated: boolean, hookDispatches: number, hookEnteredAtMs: number|null, hookSettledAtMs: number|null, hookSettlement: string|null, hookOverlappingDispatches: boolean|null, serverParentPid: number|null}} */
  const facts = {
    serverStarted: records.some((record) => record.kind === 'server-started'),
    serverParentPid,
    handlerEntered: records.some((record) => record.kind === 'handler-entered'),
    handlerCompleted: records.some((record) => record.kind === 'handler-completed'),
    handlerCompletedAtMs,
    workerLaunches: null,
    workerLaunchesTruncated: false,
    workerLaunchesIncomplete: false,
    workerProfileMatches: null,
    possibleDuplicateLaunch: null,
    workerLaunchAtMs: null,
    events: records.length,
    truncated,
    hookDispatches: 0,
    hookEnteredAtMs: null,
    hookSettledAtMs: null,
    hookSettlement: null,
    hookOverlappingDispatches: null,
  };
  // Task 4 hook facts: per-call entered/completed intervals by callNonce,
  // the prompt-hold dispatch and settlement stamps, and whether two
  // same-event dispatch intervals OVERLAPPED in time (the concurrency probe).
  const enteredByNonce = new Map();
  /** @type {{enteredAtMs: number|null, completedAtMs: number|null}[]} */
  const hookIntervals = [];
  for (const record of records) {
    if (record.kind === 'handler-entered' && typeof record.callNonce === 'string') {
      enteredByNonce.set(record.callNonce, typeof record.at === 'number' ? record.at : null);
    } else if (record.kind === 'handler-completed' && typeof record.callNonce === 'string' && enteredByNonce.has(record.callNonce)) {
      hookIntervals.push({ enteredAtMs: enteredByNonce.get(record.callNonce) ?? null, completedAtMs: typeof record.at === 'number' ? record.at : null });
    } else if (record.kind === 'prompt-hold-started') {
      facts.hookDispatches += 1;
      if (facts.hookEnteredAtMs === null && typeof record.at === 'number') facts.hookEnteredAtMs = record.at;
    } else if (record.kind === 'prompt-hold-settled') {
      if (typeof record.at === 'number') facts.hookSettledAtMs = record.at;
      if (typeof record.settlement === 'string') facts.hookSettlement = record.settlement;
    }
  }
  if (hookIntervals.length >= 2) {
    facts.hookOverlappingDispatches = hookIntervals.some((left, leftIndex) => hookIntervals.some((right, rightIndex) => leftIndex !== rightIndex
      && left.enteredAtMs !== null && left.completedAtMs !== null
      && right.enteredAtMs !== null && right.completedAtMs !== null
      && right.enteredAtMs < left.completedAtMs && left.enteredAtMs < right.completedAtMs));
  }
  // The interval stamps come from the handler pair (the dispatch itself),
  // which brackets the prompt-hold events.
  if (hookIntervals.length > 0) {
    const first = hookIntervals[0];
    if (facts.hookEnteredAtMs === null) facts.hookEnteredAtMs = first.enteredAtMs;
    if (facts.hookSettledAtMs === null) facts.hookSettledAtMs = first.completedAtMs;
  }
  if (caseLabel === 'shell-window' || caseLabel === 'role-control') {
    const { records: launchRecords, truncated: workerLaunchesTruncated, incomplete: workerLaunchesIncomplete } = await readWorkerLaunchRecords(join(workspace, 'worker-launches.jsonl'));
    // Own each recorded worker's separate group from the moment it is known,
    // so the deadline, the interrupt path, and cleanup can settle it.
    ownRecordedWorkerGroups(launchRecords, { trustedHostPid: caseHostPid, attestOnly: true, inspectionDeadline: Date.now() + 1_000 });
    facts.workerLaunches = launchRecords.length;
    facts.possibleDuplicateLaunch = launchRecords.length > 1;
    // The worker's own epoch-ms launch stamp (diagnostic only): the report
    // correlates process lifetime with the host's poll timing through it.
    for (const record of launchRecords) {
      if (typeof record.at === 'number' && Number.isSafeInteger(record.at)) {
        facts.workerLaunchAtMs = record.at;
        break;
      }
    }
    // A truncated log is a bounded PREFIX, and an incomplete log (a torn or
    // malformed record) cannot prove how many launches happened: the smoke
    // grants below refuse both.
    facts.workerLaunchesTruncated = workerLaunchesTruncated;
    facts.workerLaunchesIncomplete = workerLaunchesIncomplete;
    // The LAUNCHED worker must match the REQUESTED profile: the worker
    // records its actual duration/noise flags, and a model that altered or
    // dropped them would otherwise let the requested profile (and its
    // remaining-lifetime math) stand in for what actually ran.
    if (launchRecords.length === 1) {
      const launch = launchRecords[0];
      // When a profile was REQUESTED, BOTH fields compare exactly — a
      // zero-valued request (a silent run) is as binding as a positive
      // one. A bare run (no profile requested) makes no claim to verify.
      const profileRequested = profile.workerDurationMs > 0 || profile.workerNoiseIntervalMs > 0;
      facts.workerProfileMatches = !profileRequested
        || (launch.durationMs === profile.workerDurationMs && launch.noiseIntervalMs === profile.workerNoiseIntervalMs);
    } else {
      facts.workerProfileMatches = false;
    }
  }
  return facts;
}

/**
 * Validates the private output directory under driver codes.
 * @param {string} outputDir
 */
async function validateOutputDirectory(outputDir) {
  if (!isAbsolute(outputDir)) throw driverError('WAIT_ROUTE_DRIVER_OUTPUT_RELATIVE', 'The output directory must be an absolute path.');
  const stats = await lstat(outputDir).catch((error) => {
    if (errorCode(error) === 'ENOENT') throw driverError('WAIT_ROUTE_DRIVER_OUTPUT_MISSING', 'The output directory must already exist.');
    throw error;
  });
  if (stats.isSymbolicLink()) throw driverError('WAIT_ROUTE_DRIVER_OUTPUT_SYMLINK', 'The output directory must not be a symlink.');
  if (!stats.isDirectory()) throw driverError('WAIT_ROUTE_DRIVER_OUTPUT_NOT_DIRECTORY', 'The output directory must be a directory.');
  if (process.platform !== 'win32' && (stats.mode & 0o777) !== 0o700) {
    throw driverError('WAIT_ROUTE_DRIVER_OUTPUT_MODE', 'The output directory must be mode 0700.');
  }
  const entries = await readdir(outputDir);
  if (entries.length > 0) throw driverError('WAIT_ROUTE_DRIVER_OUTPUT_NOT_EMPTY', 'The output directory must be empty.');
}

/**
 * One bounded `codex --version`; the driver pins the exact version string as
 * provenance. A non-codex binary is an instrument failure.
 * @param {string} codexPath @param {string} cwd @param {string} tmp @param {string} home @param {string} codexHome @param {number} deadline
 * @returns {Promise<string>}
 */
async function resolveCodexVersion(codexPath, cwd, tmp, home, codexHome, deadline) {
  const result = await runBoundedSubprocess(codexPath, ['--version'], {
    cwd,
    env: hostEnvironment(tmp, home, codexHome),
    deadlineMs: Math.max(1, Math.min(SUBPROCESS_DEADLINE_MS, deadline - Date.now())),
  });
  const version = result.stdout.trim();
  if (result.code !== 0 || !/^codex-cli \S+/.test(version)) {
    throw driverError('WAIT_ROUTE_DRIVER_CODEX_VERSION', 'The supplied binary did not report a codex-cli version.');
  }
  return version;
}

/**
 * Removes every owned state directory and records the isolated-home result.
 * @param {string[]} directories @param {string[]} isolatedHomes @param {WaitRouteSummary} summary
 */
async function removeStateDirectories(directories, isolatedHomes, summary) {
  /** @type {string[]} */
  const failures = [];
  for (const directory of directories) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      failures.push(`remove-${basename(directory)}-failed`);
    }
  }
  let homeRemoved = true;
  for (const directory of isolatedHomes) {
    const gone = await lstat(directory).then(() => false, (error) => (errorCode(error) === 'ENOENT' ? true : false));
    if (!gone) homeRemoved = false;
  }
  summary.cleanup.isolatedHomeRemoved = homeRemoved;
  summary.cleanup.failures.push(...failures);
}

/**
 * CLI entry: prints the bounded redacted summary JSON to stdout, or a closed
 * instrument code to stderr with exit 1.
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function runWaitRouteDriverMain(argv) {
  installDriverSignalHandlers();
  /** @type {{caseLabel: string, codexPath: string, outputDir: string, budgetMs: number}} */
  let parsed;
  try {
    parsed = parseDriverArguments(argv);
  } catch (error) {
    process.stderr.write(`wait-route driver: ${errorCode(error) || 'error'}: ${error instanceof Error ? error.message : 'invalid arguments'}\n`);
    return 1;
  }
  try {
    const summary = await runWaitRouteCase(parsed);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`wait-route driver failed: ${errorCode(error) || 'error'}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWaitRouteDriverMain(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
