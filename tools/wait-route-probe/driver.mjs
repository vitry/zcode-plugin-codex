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
import { chmod, copyFile, lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMPLETION_MARKER,
  MARKETPLACE_NAME,
  PLUGIN_SELECTOR,
  WORKER_FILE_NAME,
  buildWaitRouteFixture,
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
export const CASE_LABELS = Object.freeze(['shell-window', 'hook-entry', 'authority', 'lifecycle']);
export const BUDGET_MIN_MS = 1_000;
export const BUDGET_MAX_MS = 3_600_000;
/** Cleanup always keeps at least this floor so a case never leaks owned state. */
export const CLEANUP_FLOOR_MS = 5_000;
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
const EXEC_BASE_FLAGS = Object.freeze(['exec', '--json', '--color', 'never', '-s', 'workspace-write', '--skip-git-repo-check', '--ephemeral']);
const HOOK_ONLY_FLAGS = Object.freeze(['--dangerously-bypass-hook-trust']);
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
 * @property {{serverStarted: boolean, handlerEntered: boolean, handlerCompleted: boolean, handlerCompletedAtMs: number|null, markerObserved: boolean|null, workerLaunches: number|null, possibleDuplicateLaunch: boolean|null, events: number, truncated: boolean}} trace
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
 * Parses the driver arguments. Exactly the four documented flags are
 * accepted, all required, with closed validation codes.
 * @param {string[]} argv
 * @returns {{caseLabel: string, codexPath: string, outputDir: string, budgetMs: number}}
 */
export function parseDriverArguments(argv) {
  /** @type {Record<string, string>} */
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !flag.startsWith('--') || !value || value.startsWith('--')) {
      throw usageError('usage: driver.mjs --case <shell-window|hook-entry|authority|lifecycle> --codex <path> --output-dir <dir> --budget-ms <ms>');
    }
    if (flag in parsed) throw usageError(`duplicate ${flag}`);
    if (flag === '--case' || flag === '--codex' || flag === '--output-dir' || flag === '--budget-ms') parsed[flag] = value;
    else throw usageError(`unknown ${flag}`);
  }
  if (!parsed['--case'] || !parsed['--codex'] || !parsed['--output-dir'] || !parsed['--budget-ms']) {
    throw usageError('usage: driver.mjs --case <shell-window|hook-entry|authority|lifecycle> --codex <path> --output-dir <dir> --budget-ms <ms>');
  }
  if (!CASE_LABELS.includes(parsed['--case'])) throw usageError(`--case must be one of: ${CASE_LABELS.join(', ')}`);
  if (!isAbsolute(parsed['--codex'])) throw driverError('WAIT_ROUTE_DRIVER_CODEX_RELATIVE', '--codex must be an absolute path.');
  if (!isAbsolute(parsed['--output-dir'])) throw driverError('WAIT_ROUTE_DRIVER_OUTPUT_RELATIVE', '--output-dir must be an absolute path.');
  const budgetMs = Number(parsed['--budget-ms']);
  if (!Number.isSafeInteger(budgetMs) || budgetMs < BUDGET_MIN_MS || budgetMs > BUDGET_MAX_MS) {
    throw driverError('WAIT_ROUTE_DRIVER_BUDGET_INVALID', `--budget-ms must be an integer of ${BUDGET_MIN_MS} to ${BUDGET_MAX_MS}.`);
  }
  return { caseLabel: parsed['--case'], codexPath: parsed['--codex'], outputDir: parsed['--output-dir'], budgetMs };
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
 * @param {{caseLabel: string, codexPath: string, fixture: {workerPath: string}, workspace: string, isolatedTmp: string, isolatedHome: string, codexHome: string, traceDirectory: string, runNonce: string, deadline: number}} input
 */
async function runHostExec(input) {
  const { caseLabel, codexPath, fixture, workspace, isolatedTmp, isolatedHome, codexHome, traceDirectory, runNonce, deadline } = input;
  /** @type {string[]} */
  let args;
  if (caseLabel === 'hook-entry') {
    // Positive fixture runs MUST NOT skip the fixture config: isolation comes
    // from the fixture-local CODEX_HOME, and the fixture hooks run under the
    // fixture-local trust bypass for this one synthetic prompt.
    args = [...EXEC_BASE_FLAGS, ...HOOK_ONLY_FLAGS, '-C', workspace, HOOK_ENTRY_PROMPT];
  } else {
    const workerPath = join(workspace, WORKER_FILE_NAME);
    await writeFile(workerPath, await readFixtureWorker(fixture), { encoding: 'utf8', mode: 0o755 });
    if (process.platform !== 'win32') await chmod(workerPath, 0o755);
    const command = buildShellWorkerCommand(process.execPath, workerPath);
    const prompt = `Run exactly one command with the shell tool: ${command}\nThen reply with the final output line of that command, verbatim. Do not run any other command.`;
    args = [...EXEC_BASE_FLAGS, '-C', workspace, prompt];
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return { exitCode: 0, stdout: '', timedOut: true, overflow: false, hostExit: { state: 'killed', code: null }, hostFlags: flagsOf(args), lastOutputAtMs: null, markerAtMs: null, deadlineAtMs: deadline };
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
  const onPoll = caseLabel === 'shell-window'
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
  const result = await runBoundedSubprocess(codexPath, args, {
    cwd: workspace,
    env: { ...hostEnvironment(isolatedTmp, isolatedHome, codexHome), WAIT_ROUTE_PROBE_TRACE: join(traceDirectory, 'events.jsonl'), WAIT_ROUTE_PROBE_NONCE: runNonce },
    deadlineMs: remaining,
    stdoutMaxBytes: HOST_STDOUT_MAX_BYTES,
    markerText: COMPLETION_MARKER,
    ...(onPoll ? { pollMs: 250, onPoll, onSpawn: (child) => { trustedHostPid = child.pid ?? null; }, onSettled: () => { discoveryClosed = true; } } : {}),
  });
  const hostExit = result.timedOut ? { state: 'killed', code: null } : { state: result.code === 0 ? 'exit-0' : 'exit-nonzero', code: result.code };
  return { exitCode: result.code ?? -1, stdout: result.stdout, timedOut: result.timedOut, overflow: result.overflow, hostExit, hostFlags: flagsOf(args), lastOutputAtMs: result.lastOutputAtMs, markerAtMs: result.markerAtMs, deadlineAtMs: result.deadlineAtMs, hostPid: result.child?.pid ?? null };
}

/**
 * Runs one selected wait-route probe case to a bounded, redacted summary.
 * Instrument failures throw closed codes; every bounded conclusion (including
 * inconclusive ones naming the missing prerequisite) returns a summary.
 * @param {{caseLabel: string, codexPath: string, outputDir: string, budgetMs: number, sourceCodexHome?: string}} input
 * @returns {Promise<WaitRouteSummary>}
 */
export async function runWaitRouteCase(input) {
  const { caseLabel, outputDir, budgetMs } = input;
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
      markerObserved: null, workerLaunches: null, possibleDuplicateLaunch: null,
      events: 0, truncated: false,
    },
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
    await writeFixtureConfig({ codexHome });

    const serverModulePath = join(dirname(fileURLToPath(import.meta.url)), 'server.mjs');
    const fixture = await buildWaitRouteFixture({ outputDir: marketplaceDirectory, serverPath: serverModulePath });

    summary.stage = 'install';
    const hostEnv = hostEnvironment(isolatedTmp, isolatedHome, codexHome);
    if (caseLabel === 'hook-entry') {
      const installed = await installProbePlugin(codexPath, marketplaceDirectory, installState, hostEnv, stageDeadline);
      if (!installed) {
        summary.outcome = 'inconclusive';
        summary.reason = 'install-failed';
        return summary;
      }
    }

    summary.stage = 'exec';
    const exec = await runHostExec({ caseLabel, codexPath, fixture, workspace, isolatedTmp, isolatedHome, codexHome, traceDirectory, runNonce, deadline: stageDeadline });
    summary.hostExit = exec.hostExit;
    summary.hostFlags = exec.hostFlags;
    // The durable trace facts are read on EVERY post-exec path: observed
    // entry is never suppressed by a host failure, an output overflow, or an
    // expired budget.
    const facts = await readTraceFacts(caseLabel, traceDirectory, workspace, runNonce, exec.hostPid ?? null);
    summary.trace = { ...summary.trace, ...facts, markerObserved: caseLabel === 'shell-window' ? exec.stdout.includes(COMPLETION_MARKER) : null };
    // The shell worker's exit is verified and settled separately from the
    // host on every post-exec path, and the summary reflects it.
    if (caseLabel === 'shell-window') {
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
      } else if (caseLabel === 'shell-window' && summary.trace.markerObserved && facts.workerLaunches === 1 && markerWithinBudget && !facts.workerLaunchesTruncated && !facts.workerLaunchesIncomplete && summary.cleanup.workerExit !== 'unresolved') {
        // workerExit 'unresolved' means the recorded launch was never owned
        // through the trusted boundary — the model-writable log alone is
        // not execution evidence, so the smoke grant refuses it.
        summary.outcome = 'shell-smoke-completed';
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
    if (exec.exitCode !== 0) {
      // A host failure after a completed handler is an honest combination:
      // the outcome stays host-error while the trace facts above keep the
      // observed entry visible.
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
    // shell-window: the fixed marker AND the worker's own launch log must
    // both corroborate the run — the marker alone can come from a model
    // response or another command, and a second launch is flagged, never
    // silently accepted.
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
    } else {
      summary.outcome = 'shell-smoke-completed';
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
          if (summary.outcome === 'shell-smoke-completed') {
            summary.outcome = 'inconclusive';
            summary.reason = 'covered-settlement-unresolved';
          }
        } else if (summary.cleanup.workerExit === 'not-started') {
          summary.cleanup.workerExit = 'terminated';
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
 * @param {string} caseLabel @param {string} traceDirectory @param {string} workspace @param {string} runNonce @param {number|null} caseHostPid
 * @returns {Promise<{serverStarted: boolean, handlerEntered: boolean, handlerCompleted: boolean, handlerCompletedAtMs: number|null, workerLaunches: number|null, workerLaunchesTruncated: boolean, workerLaunchesIncomplete: boolean, possibleDuplicateLaunch: boolean|null, events: number, truncated: boolean}>}
 */
async function readTraceFacts(caseLabel, traceDirectory, workspace, runNonce, caseHostPid) {
  const { records, truncated } = await readTraceEvents({ runDirectory: traceDirectory, runNonce });
  let handlerCompletedAtMs = null;
  for (const record of records) {
    if (record.kind === 'handler-completed' && typeof record.at === 'number') handlerCompletedAtMs = record.at;
  }
  /** @type {{serverStarted: boolean, handlerEntered: boolean, handlerCompleted: boolean, handlerCompletedAtMs: number|null, workerLaunches: number|null, workerLaunchesTruncated: boolean, workerLaunchesIncomplete: boolean, possibleDuplicateLaunch: boolean|null, events: number, truncated: boolean}} */
  const facts = {
    serverStarted: records.some((record) => record.kind === 'server-started'),
    handlerEntered: records.some((record) => record.kind === 'handler-entered'),
    handlerCompleted: records.some((record) => record.kind === 'handler-completed'),
    handlerCompletedAtMs,
    workerLaunches: null,
    workerLaunchesTruncated: false,
    workerLaunchesIncomplete: false,
    possibleDuplicateLaunch: null,
    events: records.length,
    truncated,
  };
  if (caseLabel === 'shell-window') {
    const { records: launchRecords, truncated: workerLaunchesTruncated, incomplete: workerLaunchesIncomplete } = await readWorkerLaunchRecords(join(workspace, 'worker-launches.jsonl'));
    // Own each recorded worker's separate group from the moment it is known,
    // so the deadline, the interrupt path, and cleanup can settle it.
    ownRecordedWorkerGroups(launchRecords, { trustedHostPid: caseHostPid, attestOnly: true, inspectionDeadline: Date.now() + 1_000 });
    facts.workerLaunches = launchRecords.length;
    facts.possibleDuplicateLaunch = launchRecords.length > 1;
    // A truncated log is a bounded PREFIX, and an incomplete log (a torn or
    // malformed record) cannot prove how many launches happened: the smoke
    // grants below refuse both.
    facts.workerLaunchesTruncated = workerLaunchesTruncated;
    facts.workerLaunchesIncomplete = workerLaunchesIncomplete;
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
