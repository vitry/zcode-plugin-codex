// @ts-nocheck
/**
 * Bounded direct `mcpServer/tool/call` reachability driver (plan Task 3).
 * One responsibility: the isolated Host/marketplace lifecycle, binary and
 * version pinning, readiness, the reachability schedule, deadlines, and
 * cleanup for the G1 handler-reachability case. The durable evidence
 * vocabulary, the writer partition, and the authenticated reduction live in
 * `observer.mjs`/`probe-log.mjs` and are only consumed here; the disposable
 * server lives in `server.mjs`. No production plugin descriptor is installed
 * by this driver: the only descriptor it ever writes is the disposable probe
 * marketplace generated at run time inside the private run directory.
 *
 * The reachability schedule: pin the canonical binary by device/inode and
 * version before every spawn; create a mode-0700 temporary home and
 * workspace; copy only the auth bytes with mode 0600; install the disposable
 * marketplace/server; initialize the app-server; start a thread; call
 * `mcpServerStatus/list` for that thread; then send
 * `{server, threadId, tool: 'capture_direct', arguments: {probeLabel}}` on
 * the SAME connection, snapshotting the durable event position before and
 * after the request. Every response is reduced — through the authenticated
 * durable handler-entry join — into one closed classification:
 * `rpc-rejected`, `error-result-handler-entered`, `error-result-unknown-
 * origin`, `success-handler-entered` (plus `success-unknown-origin` and
 * `not-observed`), with independent evidence references. A prior
 * `server-started` event never implies handler entry. The CLI prints ONLY
 * redacted phase/outcome counters; raw IDs, paths, prompts, credentials,
 * response bodies, and host error text never reach stdout or any committed
 * artifact.
 *
 * Bounded-process discipline follows the existing mcp-context-probe driver:
 * a per-stream 4 MiB output bound with termination on overflow, a bounded
 * notification cap (streamed deltas counted redacted, never retained),
 * per-request deadlines, and stable-PID/start-identity cleanup that signals
 * only probe-owned processes whose captured start identity still matches.
 * The bounded JSON-RPC client and the direct-call deadline are public seams:
 * the suite drives the timeout and overflow-termination paths of THIS client
 * through them (the old suite's overflow tests cover only the old client).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { resolveProcessInspectionExecutable } from '../mcp-context-probe/qualify.mjs';

import {
  DIRECT_PROBE_PHASES,
  appendDirectProbeEvent,
  hashProbeValue,
  readDirectProbeEvents,
  reduceDirectProbeLog,
} from './observer.mjs';
import { directProbeSealHead } from './probe-log.mjs';
import { classifyDirectIdentitySample } from './identity.mjs';
import {
  DIRECT_LIFECYCLE_TRIGGERS,
  assessDirectReconciliationStrategy,
  classifyDirectLifecycleCase,
  directLifecycleExpectation,
} from './lifecycle.mjs';

/** The disposable probe's MCP server identity inside the generated descriptor. */
export const DIRECT_PROBE_SERVER_NAME = 'zcode-direct-mcp-probe';
/** The disposable probe tool the reachability schedule dispatches. */
export const DIRECT_PROBE_TOOL_NAME = 'capture_direct';

const PROBE_NAME = 'zcode-direct-mcp-probe';
const DIRECT_PLUGIN_NAME = 'zcode-direct-mcp-probe';
const DIRECT_MARKETPLACE_NAME = 'zcode-direct-mcp-probe-mp';
const DIRECT_PLUGIN_SELECTOR = `${DIRECT_PLUGIN_NAME}@${DIRECT_MARKETPLACE_NAME}`;
const DIRECT_PROBE_PHASE = 'reachability';
// Per-stream output bound (the runBounded discipline): a chatty stream is
// terminated, never allowed to grow the driver's memory.
const MAXIMUM_OUTPUT_BYTES = 4 * 1024 * 1024;
// Bounded notifications for the app-server JSON-RPC client: past this cap
// frames are counted (redacted) and the bounded session is terminated
// instead of silently degrading the run.
const MAXIMUM_APP_SERVER_NOTIFICATIONS = 512;
// Streaming-turn delta notifications are counted redacted and never retained.
const APP_SERVER_DELTA_NOTIFICATION = /delta/i;
// Bounded hold queue for server->client requests the identity schedule keeps
// pending (the controlled active-turn hold is an unanswered approval request).
const MAXIMUM_HELD_SERVER_REQUESTS = 8;
// Bounded ring of retained turn-lifecycle notifications for the identity
// schedule; past the cap notifications are counted redacted, never kept.
const MAXIMUM_RETAINED_NOTIFICATIONS = 64;
const SUBPROCESS_DEADLINE_MS = 120_000;
const APP_SERVER_REQUEST_DEADLINE_MS = 60_000;
// The G1 case budget is at most 120 seconds after readiness; the direct call
// deadline sits well inside it, and ONE post-readiness deadline bounds the
// direct call, the disposal waits, and the bounded cleanup commands together.
const DIRECT_CALL_DEADLINE_MS = 60_000;
const DIRECT_CASE_BUDGET_MS = 120_000;
// Below this much ceiling, a bounded cleanup CLI command is skipped instead
// of started: the marketplace registration lives entirely inside the
// isolated CODEX_HOME that the verified deletion removes anyway.
const CLEANUP_COMMAND_FLOOR_MS = 5_000;
// Upper bound for one process-table inspection; every call site further
// bounds it by the remaining post-readiness case time.
const PS_INSPECTION_MS = 5_000;
// Bounded window for the durable handler-entry join after the response: the
// handler appends entry BEFORE returning its result, so the join normally
// succeeds on the first read; the retries only bound a slow durable read.
const DIRECT_ENTRY_JOIN_ATTEMPTS = 4;
const DIRECT_ENTRY_JOIN_POLL_MS = 400;
// At or above the disposable server's disposal grace, so a lingering server
// gets a natural exit window before cleanup signals anything.
const SERVER_DISPOSAL_WAIT_MS = 8_000;
const SERVER_KILL_GRACE_MS = 5_000;
/** The descriptor env vars forwarded from the host env to the spawned server. */
const DIRECT_SERVER_ENV_VARS = Object.freeze([
  'ZCODE_DIRECT_MCP_PROBE_RUN',
  'ZCODE_DIRECT_MCP_PROBE_NONCE',
  'ZCODE_DIRECT_MCP_PROBE_PHASE',
  'DIRECT_PROBE_OWNER_SECRET',
]);

/** @param {string} code @param {string} message */
function directError(code, message) {
  // The code is embedded in the message (the probe convention) so closed-code
  // assertions can match failures textually as well as via .code.
  const error = /** @type {Error & {code:string}} */ (new Error(`${code}: ${message}`));
  error.code = code;
  return error;
}

/** @param {unknown} error */
function errorCode(error) {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
}

const moduleEntry = fileURLToPath(import.meta.url);

/** @param {string} left @param {string} right */
function sameEntryPath(left, right) {
  return left === right || `${left}/` === right || `${left}\\` === right;
}

const runningAsMain = Boolean(process.argv[1]) && sameEntryPath(moduleEntry, resolve(process.argv[1]));

/** Redacted transcript sink on stderr: identifiers and raw values never reach it. */
function transcript(message) {
  if (runningAsMain) process.stderr.write(`[direct-mcp-probe] ${message}\n`);
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** @param {number} pid */
function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

/** @param {number} pid @param {number} graceMs */
async function waitForExit(pid, graceMs) {
  const deadline = Date.now() + graceMs;
  while (isProcessAlive(pid)) {
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
  return true;
}

/** @returns {NodeJS.ProcessEnv} */
function minimalEnv() {
  return { PATH: process.env.PATH ?? '', TMPDIR: process.env.TMPDIR ?? '/tmp' };
}

/**
 * Budget-bounded identity capture: the same collision-resistant start
 * identity (kernel start time, parent pid, command name) the existing driver
 * uses, but the inspection cannot block past the remaining case time.
 * Returns null when inspection is unavailable or the deadline is exhausted —
 * the caller must then fail closed rather than signal an unverified pid.
 * @param {number|undefined} pid @param {number} remainingMs
 * @returns {string|null}
 */
function boundedCaptureIdentity(pid, remainingMs) {
  if (!pid || pid <= 0 || remainingMs <= 0) return null;
  const executable = resolveProcessInspectionExecutable();
  if (!executable) return null;
  const listed = spawnSync(executable, ['-p', String(pid), '-o', 'lstart=,ppid=,comm='], { encoding: 'utf8', timeout: Math.max(1, Math.min(PS_INSPECTION_MS, remainingMs)) });
  if (listed.status !== 0 || typeof listed.stdout !== 'string') return null;
  const tokens = listed.stdout.trim().split(/\s+/);
  if (tokens.length < 3) return null;
  const comm = tokens.at(-1);
  const parentPid = tokens.at(-2);
  const lstart = tokens.slice(0, -2).join(' ');
  if (!lstart || !parentPid || !comm) return null;
  return `${lstart}|ppid=${parentPid}|comm=${comm}`;
}

/**
 * Budget-bounded start-identity match: a pid may be signalled only when it is
 * alive and its current start identity still equals the spawn-time identity,
 * with the verification bounded by the remaining case time. An exhausted
 * deadline cannot verify and returns false.
 * @param {number} pid @param {string|null} identity @param {number} remainingMs
 */
function boundedIdentityMatches(pid, identity, remainingMs) {
  if (!isProcessAlive(pid) || !identity || remainingMs <= 0) return false;
  return boundedCaptureIdentity(pid, remainingMs) === identity;
}

/**
 * SHA-256 of a file's bytes, streamed, bounded by a deadline. The binary
 * pin's content identity: a device/inode match alone cannot see an in-place
 * rewrite, so every pin recheck also compares this digest. The deadline
 * keeps a slow or stalled filesystem from running the post-readiness case
 * past its ceiling; an exceeded deadline rejects with the closed
 * `PROBE_HASH_TIMEOUT` code (never raw diagnostics). Exported as a seam so
 * the suite can drive the stalled-hash path directly.
 * @param {string} path @param {number} [deadlineMs]
 * @returns {Promise<string>}
 */
export function sha256File(path, deadlineMs = PS_INSPECTION_MS) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    const bound = Math.max(1, Math.min(PS_INSPECTION_MS, deadlineMs));
    const timer = setTimeout(() => {
      stream.destroy();
      rejectHash(directError('PROBE_HASH_TIMEOUT', 'Hashing the pinned binary exceeded its bounded time; the pin cannot be re-verified within the case budget.'));
    }, bound);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (error) => {
      clearTimeout(timer);
      rejectHash(error);
    });
    stream.on('end', () => {
      clearTimeout(timer);
      resolveHash(hash.digest('hex'));
    });
  });
}

const CLOSED_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Maps any failure to a closed error token for the CLI boundary. Raw error
 * messages (filesystem errors embed absolute source-home and run-directory
 * paths) never cross it; only the closed probe/system code is printed, and
 * unrecognizable failures collapse to a generic internal code. Detailed
 * diagnostics are retained nowhere.
 * @param {unknown} error
 */
function closedErrorCode(error) {
  const code = errorCode(error);
  return CLOSED_ERROR_CODE_PATTERN.test(code) ? code : 'DIRECT_DRIVER_INTERNAL_ERROR';
}

/**
 * Bounded, deadline-bounded process capture (the runBounded discipline):
 * strict output caps with SIGKILL on overflow, a hard deadline, and captured
 * stdout/stderr that stays in memory only for the caller's redacted use.
 * @param {string} command @param {string[]} args
 * @param {{cwd?: string, env: NodeJS.ProcessEnv, deadlineMs?: number}} options
 */
function runBounded(command, args, options) {
  const deadlineMs = options.deadlineMs ?? SUBPROCESS_DEADLINE_MS;
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const startedAt = Date.now();
  let capturedBytes = 0;
  let overflow = false;
  let timedOut = false;
  /** @type {string[]} */
  const stdoutParts = [];
  /** @type {string[]} */
  const stderrParts = [];
  const deadlineTimer = setTimeout(() => {
    timedOut = true;
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }, deadlineMs);
  const promise = new Promise((resolvePromise, rejectPromise) => {
    child.once('error', (error) => {
      clearTimeout(deadlineTimer);
      rejectPromise(error);
    });
    child.once('close', (code, signalName) => {
      clearTimeout(deadlineTimer);
      resolvePromise({
        code, signal: signalName, timedOut, overflow,
        stdout: stdoutParts.join('\n'), stderr: stderrParts.join(''),
        durationMs: Date.now() - startedAt,
        pid: child.pid ?? -1,
      });
    });
  });
  const drain = (stream, parts) => {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk) => {
      if (overflow) return;
      capturedBytes += Buffer.byteLength(chunk);
      if (capturedBytes > MAXIMUM_OUTPUT_BYTES) {
        overflow = true;
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        return;
      }
      parts.push(chunk);
    });
  };
  drain(child.stdout, stdoutParts);
  drain(child.stderr, stderrParts);
  return {
    pid: child.pid ?? -1,
    promise: /** @type {Promise<{code: number|null, signal: string|null, timedOut: boolean, overflow: boolean, stdout: string, stderr: string, durationMs: number, pid: number}>} */ (promise),
  };
}

/**
 * Minimal bounded JSON-RPC client for the long-lived app-server session,
 * following the existing driver's discipline: per-stream 4 MiB bounds with
 * termination on overflow, a bounded notification cap (streamed deltas
 * counted redacted, never retained), benign bounded answers to
 * server-to-client requests, per-request deadlines, and pending requests
 * rejected when the session exits. Exported as a public seam so the suite
 * drives THIS client's timeout and overflow-termination paths directly.
 * @param {{command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string}} options
 */
export function startAppServerSession(options) {
  // Optional identity-schedule seams: a pattern of server->client request
  // methods to HOLD pending (answered explicitly by the schedule), and a
  // pattern of notification methods to retain in a bounded ring. Both default
  // to null, which preserves the plain reachability behavior unchanged.
  const holdServerRequestPattern = options.holdServerRequestPattern ?? null;
  const retainNotificationPattern = options.retainNotificationPattern ?? null;
  const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  // Spawn-time identity capture; the case budget has not started yet, so
  // only the inspection tool's own cap bounds it.
  const identity = boundedCaptureIdentity(child.pid, Number.MAX_SAFE_INTEGER);
  let nextId = 1;
  /** @type {Map<number, {resolve: (value: any) => void, reject: (error: Error) => void, timer: NodeJS.Timeout, method: string}>} */
  const pending = new Map();
  /** @type {{id: number, method: string, params: object}[]} */
  const heldServerRequests = [];
  /** @type {{method: string, params: object}[]} */
  const retainedNotifications = [];
  let retainedOverflowCount = 0;
  let notificationsOverflow = 0;
  let notificationsDeltaCount = 0;
  let stdoutState = { buffer: '', totalBytes: 0, overflow: false };
  let stderrBytes = 0;
  const terminateOnOverflow = (stream) => {
    transcript(`app-server session: ${stream} exceeded its ${MAXIMUM_OUTPUT_BYTES}-byte bound; the bounded session is terminated`);
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  };
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    // Fold newline-delimited frames under the same byte bound; a partial
    // trailing buffer is carried over, overflow terminates the session.
    stdoutState.buffer += chunk;
    stdoutState.totalBytes += Buffer.byteLength(chunk);
    if (stdoutState.totalBytes > MAXIMUM_OUTPUT_BYTES) {
      stdoutState.overflow = true;
    } else {
      let newline = stdoutState.buffer.indexOf('\n');
      for (; newline >= 0; newline = stdoutState.buffer.indexOf('\n')) {
        const line = stdoutState.buffer.slice(0, newline);
        stdoutState.buffer = stdoutState.buffer.slice(newline + 1);
        handleFrame(line);
      }
    }
    if (stdoutState.overflow) terminateOnOverflow('stdout');
  });
  const handleFrame = (line) => {
    if (!line.trim()) return;
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame && typeof frame === 'object' && Number.isInteger(frame.id) && !('method' in frame)) {
      const entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      clearTimeout(entry.timer);
      if (frame.error) {
        const rejection = directError('PROBE_APP_SERVER_REQUEST_FAILED', `The app-server rejected ${entry.method}.`);
        // PRIVATE ephemeral diagnostics only (read under DEBUG_DIRECT_PROBE);
        // never logged by default and never persisted or committed.
        rejection.hostMessage = frame.error.message;
        entry.reject(rejection);
      }
      else entry.resolve(frame.result ?? {});
    } else if (frame && typeof frame === 'object' && typeof frame.method === 'string' && frame.id !== undefined) {
      // Server-to-client request. The identity schedule may HOLD matching
      // requests pending — an unanswered approval request is the controlled
      // active-turn hold — and answer them explicitly. The hold queue is
      // bounded; past the cap the benign answer applies instead.
      if (holdServerRequestPattern !== null && holdServerRequestPattern.test(frame.method)
        && heldServerRequests.length < MAXIMUM_HELD_SERVER_REQUESTS) {
        heldServerRequests.push({ id: frame.id, method: frame.method, params: frame.params ?? {} });
      } else {
        const result = /elicitation/i.test(frame.method) ? { action: 'cancel' } : {};
        try { child.stdin?.write(`${JSON.stringify({ id: frame.id, result })}\n`); } catch { /* session is ending */ }
      }
    } else if (frame && typeof frame === 'object' && typeof frame.method === 'string') {
      if (APP_SERVER_DELTA_NOTIFICATION.test(frame.method)) {
        notificationsDeltaCount += 1;
        return;
      }
      // The identity schedule retains a bounded ring of turn-lifecycle
      // notifications (its only window on the host's turn states); anything
      // past the retained cap is counted redacted and kept nowhere.
      if (retainNotificationPattern !== null && retainNotificationPattern.test(frame.method)) {
        if (retainedNotifications.length < MAXIMUM_RETAINED_NOTIFICATIONS) {
          retainedNotifications.push({ method: frame.method, params: frame.params ?? {} });
        } else {
          retainedOverflowCount += 1;
        }
        return;
      }
      if (notificationsOverflow === 0 && countNotifications() >= MAXIMUM_APP_SERVER_NOTIFICATIONS) {
        notificationsOverflow += 1;
        terminateOnOverflow('notifications');
        return;
      }
      if (notificationsOverflow === 0) rememberNotification(frame.method);
    }
  };
  // Retained notifications are not needed by the reachability schedule; only
  // the bounded count is kept, so the driver's memory cannot grow with the
  // host's frame volume.
  let retainedNotificationCount = 0;
  const countNotifications = () => retainedNotificationCount;
  const rememberNotification = () => { retainedNotificationCount += 1; };
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > MAXIMUM_OUTPUT_BYTES) terminateOnOverflow('stderr');
    // Drained continuously and discarded after counting: stderr content is
    // never retained, only prevented from blocking the pipe.
  });
  child.once('exit', () => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(directError('PROBE_APP_SERVER_DISCONNECTED', 'The app-server exited before answering every request.'));
    }
    pending.clear();
  });
  const writeFrame = (value) => {
    if (!child.stdin?.writable) throw directError('PROBE_APP_SERVER_WRITE_FAILED', 'The app-server stdin is unavailable.');
    child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  return {
    pid: child.pid ?? -1,
    identity,
    /** Redacted count of notifications discarded past the bounded cap. */
    get notificationsOverflow() { return notificationsOverflow; },
    /** Redacted count of streamed delta notifications (never retained). */
    get notificationsDeltaCount() { return notificationsDeltaCount; },
    /** Snapshot of the bounded held server->client requests (identity hold seam). */
    heldServerRequests: () => [...heldServerRequests],
    /** Returns the first held request matching the predicate WITHOUT removing it. */
    findHeldServerRequest: (predicate) => heldServerRequests.find((entry) => predicate(entry)) ?? null,
    /** Removes one held request (after it has been answered). */
    dropHeldServerRequest: (id) => {
      const index = heldServerRequests.findIndex((entry) => entry.id === id);
      if (index >= 0) heldServerRequests.splice(index, 1);
    },
    /** Answers one held server->client request explicitly (identity hold seam). */
    respondToServerRequest: (id, result) => { writeFrame({ id, result }); },
    /** Drains and returns the bounded retained notification ring. */
    drainRetainedNotifications: () => {
      const drained = [...retainedNotifications];
      retainedNotifications.length = 0;
      return drained;
    },
    /** Redacted count of notifications dropped past the retained ring cap. */
    get retainedOverflowCount() { return retainedOverflowCount; },
    /** @param {string} method @param {Record<string, unknown>} params @param {number} [timeoutMs] */
    request(method, params, timeoutMs = APP_SERVER_REQUEST_DEADLINE_MS) {
      const id = nextId++;
      const promise = new Promise((resolveRequest, rejectRequest) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectRequest(directError('PROBE_APP_SERVER_TIMEOUT', `The app-server did not answer ${method} in time.`));
        }, timeoutMs);
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer, method });
        try { writeFrame({ id, method, params }); } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          rejectRequest(/** @type {Error} */ (error));
        }
      });
      // Synchronous access to the JSON-RPC id: the driver-ordered sentinel
      // release cancels THIS exact outstanding request.
      promise.requestId = id;
      return promise;
    },
    /** @param {{method: string, params: Record<string, unknown>}} value */
    notify(value) {
      try { writeFrame(value); } catch { /* session is ending */ }
    },
    /**
     * Sends notifications/cancelled for the driver's EXACT outstanding
     * request id (the JSON-RPC cancellation route): the explicit
     * driver-controlled release of the held sentinel call. Returns true only
     * when that exact id was verifiably outstanding and the cancellation
     * frame was written; false otherwise — the caller must then treat the
     * release as unverified.
     * @param {number} requestId
     * @returns {boolean}
     */
    cancelRequestById(requestId) {
      if (!pending.has(requestId)) return false;
      try { writeFrame({ method: 'notifications/cancelled', params: { requestId } }); } catch { return false; }
      return true;
    },
    /**
     * Terminates the bounded session (stdin end, SIGTERM, then SIGKILL).
     * The SIGTERM grace may be tightened by the post-readiness ceiling.
     * @param {number} [graceMs]
     */
    async terminate(graceMs = 5_000) {
      child.stdin?.end();
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        const exited = await waitForExit(child.pid ?? -1, Math.max(1, graceMs));
        if (!exited && isProcessAlive(child.pid ?? -1)) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
      }
    },
    /**
     * Closes ONLY the client connection (the JSON-RPC stdin) without
     * signalling the process: the host is expected to survive. The lifecycle
     * connection-close case uses this to separate connection loss from
     * process loss.
     */
    endInput() {
      try { child.stdin?.end(); } catch { /* session is ending */ }
    },
    /**
     * Signals the host process AFTER re-verifying its spawn-time start
     * identity (the same discipline as cleanup); returns false — without
     * signalling — when the identity cannot be verified or the process is
     * already gone.
     * @param {string} signal @param {number} [verifyMs]
     * @returns {Promise<boolean>}
     */
    async signal(signal, verifyMs = 1_000) {
      const pid = child.pid ?? -1;
      if (!boundedIdentityMatches(pid, identity, verifyMs)) return false;
      try { child.kill(signal); } catch { return false; }
      return true;
    },
  };
}

/**
 * The closed reduction of one reachability run: consumes the raw event
 * records and the AUTHENTICATED reduction (`reduceDirectProbeLog` output) and
 * returns the case's classification with independent evidence references.
 * The attribution itself is never re-derived here — the durable entry join
 * behind `reduced.calls`/`reduced.unjoined` is the authenticated reducer's
 * decision; this seam only surfaces it with `kind@sequence` references.
 * A prior `server-started` record is cited as honest supporting context and
 * never as entry: without a joined `handler-entered` the origin stays
 * unknown.
 * @param {{records: object[], reduced: {calls: object[], unjoined: object[]}, probeLabel: string, phase?: string}} input
 */
export function directReachabilityCase({ records, reduced, probeLabel, phase = DIRECT_PROBE_PHASE }) {
  if (!Array.isArray(records)) throw directError('DIRECT_CASE_INVALID', 'The reachability case requires the validated event records.');
  if (!reduced || !Array.isArray(reduced.calls) || !Array.isArray(reduced.unjoined)) {
    throw directError('DIRECT_CASE_INVALID', 'The reachability case requires the authenticated reduction.');
  }
  if (typeof probeLabel !== 'string' || !/^[0-9a-f]{32}$/.test(probeLabel)) {
    throw directError('DIRECT_CASE_INVALID', 'The reachability case requires a valid probeLabel.');
  }
  if (typeof phase !== 'string' || !DIRECT_PROBE_PHASES.includes(phase)) {
    throw directError('DIRECT_CASE_INVALID', 'The reachability case requires a closed probe phase.');
  }
  const joined = reduced.calls.find((call) => call.phase === phase && call.probeLabel === probeLabel) ?? null;
  const unjoinedEntry = reduced.unjoined.find((entry) => entry.phase === phase && entry.probeLabel === probeLabel) ?? null;
  const classification = joined?.rpc[0] ?? unjoinedEntry?.rpc[0] ?? 'not-observed';
  const request = records.find((record) => record.kind === 'request-sent' && record.phase === phase && record.probeLabel === probeLabel) ?? null;
  const readinessRecord = records.find((record) => record.kind === 'readiness-observed' && record.phase === phase) ?? null;
  const evidenceRefs = [];
  for (const record of records) {
    if (record.phase !== phase) continue;
    const citesRequest = record.kind === 'request-sent' && record.probeLabel === probeLabel && record.state === 'sent';
    const citesReadiness = record.kind === 'readiness-observed';
    const citesServerStart = record.kind === 'server-started';
    const citesEntry = record.kind === 'handler-entered' && record.probeLabel === probeLabel && joined !== null;
    const citesRpc = record.kind === 'rpc-observed' && record.probeLabel === probeLabel;
    if (citesRequest || citesReadiness || citesServerStart || citesEntry || citesRpc) {
      evidenceRefs.push(`${record.kind}@${record.sequence}`);
    }
  }
  return {
    classification,
    readiness: readinessRecord ? readinessRecord.state : 'not-observed',
    requestState: request ? request.state : null,
    handlerEntryObserved: joined !== null,
    evidenceRefs,
  };
}

/**
 * The G1 gate decision for one reachability case: `proven` only when the
 * classification carries an independently persisted handler-entry event
 * attributable to the exact probe request (`success-handler-entered` or
 * `error-result-handler-entered`). Every other classification is
 * `not-proven` with a bounded reason code; missing evidence is never
 * promoted.
 * @param {{classification: string, evidenceRefs: string[]}} reachability
 */
export function classifyDirectGateG1(reachability) {
  switch (reachability.classification) {
    case 'success-handler-entered':
    case 'error-result-handler-entered':
      return { status: 'proven', reasonCode: 'handler-entry-observed', evidenceRefs: [...reachability.evidenceRefs] };
    case 'rpc-rejected':
      return { status: 'not-proven', reasonCode: 'rpc-rejected', evidenceRefs: [...reachability.evidenceRefs] };
    case 'error-result-unknown-origin':
      return { status: 'not-proven', reasonCode: 'error-origin-unknown', evidenceRefs: [...reachability.evidenceRefs] };
    case 'success-unknown-origin':
      return { status: 'not-proven', reasonCode: 'success-origin-unknown', evidenceRefs: [...reachability.evidenceRefs] };
    case 'not-observed':
      return { status: 'not-proven', reasonCode: 'call-not-observed', evidenceRefs: [] };
    default:
      throw directError('DIRECT_CASE_INVALID', 'Unknown reachability classification.');
  }
}

/**
 * The identity seam for ONE bounded identity case (plan Task 4): consumes the
 * durable records, the AUTHENTICATED reduction, and the driver's INDEPENDENT
 * host-identity knowledge (per-run salted hashes computed in memory from the
 * host-issued IDs the driver learned on its own connection — never from the
 * request metadata), and classifies the sample through the ordered-turn
 * rules of `identity.mjs`. The pre/post turn observations come from the
 * durable `turn-state-observed` records around the joined handler-entry
 * sequence; a matching diagnostic label is correlation input only and never
 * upgrades the sample.
 * @param {{records: object[], reduced: {calls: object[], unjoined: object[]}, probeLabel: string, phase?: string, expectedThreadHash?: string|null, expectedTurnHash?: string|null}} input
 */
export function directIdentityCase({
  records,
  reduced,
  probeLabel,
  phase = 'identity',
  expectedThreadHash = null,
  expectedTurnHash = null,
}) {
  if (!Array.isArray(records)) throw directError('DIRECT_CASE_INVALID', 'The identity case requires the validated event records.');
  if (!reduced || !Array.isArray(reduced.calls) || !Array.isArray(reduced.unjoined)) {
    throw directError('DIRECT_CASE_INVALID', 'The identity case requires the authenticated reduction.');
  }
  if (typeof probeLabel !== 'string' || !/^[0-9a-f]{32}$/.test(probeLabel)) {
    throw directError('DIRECT_CASE_INVALID', 'The identity case requires a valid probeLabel.');
  }
  if (typeof phase !== 'string' || !DIRECT_PROBE_PHASES.includes(phase)) {
    throw directError('DIRECT_CASE_INVALID', 'The identity case requires a closed probe phase.');
  }
  const joined = reduced.calls.find((call) => call.phase === phase && call.probeLabel === probeLabel) ?? null;
  const request = records.find((record) => record.kind === 'request-sent' && record.phase === phase && record.probeLabel === probeLabel) ?? null;
  const readinessRecord = records.find((record) => record.kind === 'readiness-observed' && record.phase === phase) ?? null;
  if (!joined) {
    return {
      classification: 'not-observed',
      entryJoined: false,
      entrySequence: null,
      preTurn: null,
      postTurn: null,
      candidateState: 'not-observed',
      requestState: request ? request.state : null,
      readiness: readinessRecord ? readinessRecord.state : 'not-observed',
      evidenceRefs: request && request.state === 'sent' ? [`request-sent@${request.sequence}`] : [],
    };
  }
  const entrySequence = joined.entrySequence;
  const metadataRecord = records.find((record) => record.kind === 'metadata-observed' && record.phase === phase && record.callNonce === joined.callNonce) ?? null;
  const candidates = metadataRecord?.candidateHashes
    ?? { envelopeThreadId: null, innerSessionId: null, innerThreadId: null, innerTurnId: null };
  // Ordered host turn observations for THIS thread: records that carry a
  // thread hash (an actually observed turn) — when the driver knows the
  // expected thread hash, only that thread's records may attribute the
  // sample. The pre-read is the last observation before and the post-read the
  // first observation after the durable entry sequence.
  const turnObservations = records.filter((record) => record.kind === 'turn-state-observed'
    && record.phase === phase
    && typeof record.threadHash === 'string'
    && (expectedThreadHash === null || record.threadHash === expectedThreadHash));
  const preTurnRecord = [...turnObservations].filter((record) => record.sequence < entrySequence).pop() ?? null;
  const postTurnRecord = turnObservations.find((record) => record.sequence > entrySequence) ?? null;
  const classification = classifyDirectIdentitySample({
    entryJoined: true,
    entrySequence,
    metadataCandidates: candidates,
    expectedThreadHash,
    expectedTurnHash,
    preTurn: preTurnRecord,
    postTurn: postTurnRecord,
  });
  const evidenceRefs = [];
  for (const record of records) {
    if (record.phase !== phase) continue;
    const citesRequest = record.kind === 'request-sent' && record.probeLabel === probeLabel && record.state === 'sent';
    const citesReadiness = record.kind === 'readiness-observed';
    const citesServerStart = record.kind === 'server-started';
    const citesEntry = record.kind === 'handler-entered' && record.probeLabel === probeLabel;
    const citesMetadata = record.kind === 'metadata-observed' && record.callNonce === joined.callNonce;
    const citesTurn = record.kind === 'turn-state-observed'
      && typeof record.threadHash === 'string'
      && (expectedThreadHash === null || record.threadHash === expectedThreadHash);
    const citesRpc = record.kind === 'rpc-observed' && record.probeLabel === probeLabel;
    if (citesRequest || citesReadiness || citesServerStart || citesEntry || citesMetadata || citesTurn || citesRpc) {
      evidenceRefs.push(`${record.kind}@${record.sequence}`);
    }
  }
  return {
    classification,
    entryJoined: true,
    entrySequence,
    preTurn: preTurnRecord,
    postTurn: postTurnRecord,
    candidateState: metadataRecord ? metadataRecord.state : 'not-observed',
    requestState: request ? request.state : null,
    readiness: readinessRecord ? readinessRecord.state : 'not-observed',
    evidenceRefs,
  };
}

/**
 * The G2 gate decision for the identity campaign. `proven` requires ALL
 * three demonstrated facts: (1) a live-turn identity binding from the
 * ordered-turn rules, (2) a controlled active-turn hold observed on the
 * tested host, and (3) a demonstrated trusted-caller authorization chain on
 * that host. The synthetic authorization-bridge candidate can never satisfy
 * (3): it proves the admission MECHANISM locally, not host authority — so a
 * run whose metadata hashes all match still reports `not-proven` with
 * `no-trusted-caller-path`. Missing prerequisites are never promoted, and
 * reason precedence follows the deepest missing link (authorization, then
 * the hold, then the identity binding).
 * @param {{identity: string, activeTurnHold: {status: string, reasonCode: ?string}, authorization: {status: string, reasonCode: ?string}}} input
 */
export function classifyDirectGateG2({ identity, activeTurnHold, authorization }) {
  if (!authorization || authorization.status !== 'demonstrated') {
    return { status: 'not-proven', reasonCode: authorization?.reasonCode ?? 'no-trusted-caller-path', evidenceRefs: [] };
  }
  if (!activeTurnHold || activeTurnHold.status !== 'observed') {
    return { status: 'not-proven', reasonCode: 'active-turn-not-proven', evidenceRefs: [] };
  }
  if (identity === 'binding-observed') {
    return { status: 'proven', reasonCode: 'identity-binding-observed', evidenceRefs: [] };
  }
  return { status: 'not-proven', reasonCode: 'identity-not-authoritative', evidenceRefs: [] };
}

/**
 * The lifecycle-trigger coverage G3's proven branch requires: every separate
 * case the spec names must be durably observed, and the explicit
 * interruption must have actually been sent (its exact-turn prerequisite
 * demonstrated) — a `not-sent` interruption is a missing prerequisite, never
 * a pass.
 */
const DIRECT_LIFECYCLE_REQUIRED_TRIGGERS = Object.freeze([
  'turn-interrupt', 'connection-close', 'host-stop', 'host-kill',
  'config-timeout', 'safety-deadline', 'completion', 'cancel-race',
]);

/**
 * The G3 gate decision for the lifecycle campaign (plan Task 5). The rule
 * pinned by the synthetic worker tests: an interrupted turn with a
 * still-running worker FAILS G3 — it takes precedence over every other
 * reason. `proven` further requires (1) the reconciliation strategy assessed
 * under demonstrated exact ownership and bounded settlement, (2) no
 * expectation mismatch anywhere (a reducer that kills the status target or
 * cancels a sentinel is a contradiction), (3) no settlement-unproven case,
 * and (4) every required trigger observed with its case actually sent.
 * `not-sent` cases are missing prerequisites; they keep the gate down and
 * name the deepest missing link.
 * @param {{cases: {trigger: string, command: string, classification: string, workerOutcome: ?string, workerOwned: boolean, sent: boolean, reasonCode: ?string}[], reconciliation: {status: string, reasonCode: ?string}}} input
 */
export function classifyDirectGateG3({ cases, reconciliation }) {
  if (!Array.isArray(cases)) throw directError('DIRECT_CASE_INVALID', 'The G3 gate requires the lifecycle case list.');
  if (!reconciliation || typeof reconciliation.status !== 'string') {
    throw directError('DIRECT_CASE_INVALID', 'The G3 gate requires the reconciliation assessment.');
  }
  // (1) The interrupted-turn rule, first regardless of everything else.
  const interruptedUnsettled = cases.some((entry) => entry.trigger === 'turn-interrupt' && entry.sent === true
    && (entry.workerOutcome === null || entry.workerOwned !== true));
  if (interruptedUnsettled) return { status: 'not-proven', reasonCode: 'interrupted-worker-unsettled', evidenceRefs: [] };
  // (2) The reconciliation candidate: accepted only under its demonstrated
  // conditions. `demonstrated-with-limits` stays acceptable when the cases
  // themselves demonstrate the settlement (checked below); a rejected
  // strategy names its own reason.
  if (reconciliation.status === 'rejected') {
    return { status: 'not-proven', reasonCode: reconciliation.reasonCode ?? 'reconciliation-not-demonstrated', evidenceRefs: [] };
  }
  if (reconciliation.status !== 'demonstrated' && reconciliation.status !== 'demonstrated-with-limits') {
    return { status: 'not-proven', reasonCode: 'reconciliation-not-demonstrated', evidenceRefs: [] };
  }
  // (3) Contradictions fail the gate.
  const mismatch = cases.find((entry) => entry.classification === 'expectation-mismatch');
  if (mismatch) return { status: 'not-proven', reasonCode: 'expectation-mismatch-observed', evidenceRefs: [] };
  // (4) A demanded settlement that was never durably observed.
  const unproven = cases.find((entry) => entry.classification === 'settlement-unproven');
  if (unproven) return { status: 'not-proven', reasonCode: 'settlement-unproven', evidenceRefs: [] };
  // (5) The explicit interruption must have actually been sent. A present
  // but not-sent interrupt case is the deepest specific missing link — it
  // takes precedence over the generic coverage reason.
  const interrupt = cases.find((entry) => entry.trigger === 'turn-interrupt');
  if (interrupt && interrupt.sent !== true) {
    return { status: 'not-proven', reasonCode: 'interrupt-case-not-sent', evidenceRefs: [] };
  }
  // (5b) A host signal that could not be verified as delivered is the same
  // class of missing prerequisite for the destructive cases.
  const unverifiedSignal = cases.find((entry) => entry.classification === 'not-sent' && entry.reasonCode === 'signal-unverified');
  if (unverifiedSignal) {
    return { status: 'not-proven', reasonCode: 'host-signal-unverified', evidenceRefs: [] };
  }
  // (6) Every required trigger must have a case at all.
  const covered = new Set(cases.map((entry) => entry.trigger));
  const missing = DIRECT_LIFECYCLE_REQUIRED_TRIGGERS.find((trigger) => !covered.has(trigger));
  if (missing) return { status: 'not-proven', reasonCode: 'case-coverage-missing', evidenceRefs: [] };
  const allObserved = cases.every((entry) => ['settlement-observed', 'behavior-confirmed'].includes(entry.classification));
  if (allObserved) return { status: 'proven', reasonCode: 'lifecycle-settlement-durably-observed', evidenceRefs: [] };
  return { status: 'not-proven', reasonCode: 'cases-missing-classification', evidenceRefs: [] };
}

/**
 * Validates the requested marketplace output directory: absolute, existing,
 * a real non-symlink directory, private (0700), and empty.
 * @param {string} output
 */
async function validateMarketplaceOutput(output) {
  if (!isAbsolute(output)) throw directError('PROBE_OUTPUT_RELATIVE', 'The marketplace output directory must be an absolute path.');
  const stats = await lstat(output).catch((error) => {
    if (errorCode(error) === 'ENOENT') throw directError('PROBE_OUTPUT_MISSING', 'The marketplace output directory must already exist.');
    throw error;
  });
  if (stats.isSymbolicLink()) throw directError('PROBE_OUTPUT_SYMLINK', 'The marketplace output directory must not be a symlink.');
  if (!stats.isDirectory()) throw directError('PROBE_OUTPUT_NOT_DIRECTORY', 'The marketplace output must be a directory.');
  if (process.platform !== 'win32' && (stats.mode & 0o777) !== 0o700) {
    throw directError('PROBE_OUTPUT_MODE', 'The marketplace output directory must be mode 0700.');
  }
  if ((await readdir(output)).length > 0) throw directError('PROBE_OUTPUT_NOT_EMPTY', 'The marketplace output directory must be empty.');
}

/**
 * Builds the disposable direct-probe marketplace inside the private run
 * directory: the marketplace descriptor, the plugin manifest, and the
 * plugin-root `.mcp.json` whose descriptor references the validated absolute
 * probe server path and forwards exactly the probe env vars the spawned
 * server reads. `toolTimeoutSec` is the documented per-server tool timeout
 * the host enforces; the lifecycle mode tightens it (bounded campaign) while
 * every other mode keeps the default. This is the probe's OWN disposable
 * descriptor — never a production plugin descriptor.
 * @param {string} output @param {string} serverPath @param {number} [toolTimeoutSec]
 */
async function buildDirectProbeMarketplace(output, serverPath, toolTimeoutSec = 30) {
  if (!Number.isSafeInteger(toolTimeoutSec) || toolTimeoutSec < 1 || toolTimeoutSec > 300) {
    throw directError('DIRECT_DRIVER_USAGE_INVALID', 'toolTimeoutSec must be an integer of 1 to 300 seconds.');
  }
  await validateMarketplaceOutput(output);
  const stats = await lstat(serverPath).catch(() => null);
  if (!stats || stats.isSymbolicLink() || !stats.isFile()) {
    throw directError('DIRECT_PROBE_SERVER_MISSING', 'The direct probe server must be a regular non-symlink file.');
  }
  const pluginRoot = join(output, 'plugins', DIRECT_PLUGIN_NAME);
  await mkdir(join(output, '.agents', 'plugins'), { recursive: true, mode: 0o700 });
  await mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await chmod(join(output, '.agents', 'plugins'), 0o700);
    await chmod(join(pluginRoot, '.codex-plugin'), 0o700);
  }
  const marketplace = {
    name: DIRECT_MARKETPLACE_NAME,
    interface: { displayName: 'ZCode Direct MCP Probe' },
    plugins: [{
      name: DIRECT_PLUGIN_NAME,
      source: { source: 'local', path: `./plugins/${DIRECT_PLUGIN_NAME}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Developer Tools',
    }],
  };
  const plugin = {
    name: DIRECT_PLUGIN_NAME,
    version: '0.1.0',
    description: 'Disposable direct mcpServer/tool/call reachability probe. Never installed in production.',
    interface: {
      displayName: 'ZCode Direct MCP Probe',
      shortDescription: 'Disposable direct-call reachability probe.',
      longDescription: 'Disposable probe-only plugin whose MCP server records durable handler-entry evidence for direct mcpServer/tool/call feasibility qualification. It must never be installed outside a temporary probe marketplace.',
      category: 'Developer Tools',
      capabilities: ['Interactive'],
    },
  };
  const descriptor = {
    mcpServers: {
      [DIRECT_PROBE_SERVER_NAME]: {
        command: 'node',
        args: [serverPath],
        cwd: '.',
        enabled: true,
        env_vars: [...DIRECT_SERVER_ENV_VARS, 'DIRECT_PROBE_HOLD_SAFETY_DEADLINE_MS'],
        startup_timeout_sec: 10,
        tool_timeout_sec: toolTimeoutSec,
      },
    },
  };
  for (const [path, body] of [
    [join(output, '.agents', 'plugins', 'marketplace.json'), marketplace],
    [join(pluginRoot, '.codex-plugin', 'plugin.json'), plugin],
    [join(pluginRoot, '.mcp.json'), descriptor],
  ]) {
    // Serialize-validate every generated descriptor: a malformed fixture can
    // never reach an install command.
    const serialized = `${JSON.stringify(body, null, 2)}\n`;
    JSON.parse(serialized);
    await writeFile(path, serialized, { encoding: 'utf8', mode: 0o600 });
  }
}

/**
 * Lists the process table entries whose command line contains the exact
 * probe server module path, or null when process inspection is unavailable.
 * The entries' parent pids bind a discovered server to THIS run's host. The
 * inspection is bounded by the caller's remaining case time.
 * @param {string} serverModulePath @param {number} [timeoutMs]
 * @returns {{pid: number, ppid: number}[]|null}
 */
function listProbeServerProcesses(serverModulePath, timeoutMs = PS_INSPECTION_MS) {
  const executable = resolveProcessInspectionExecutable();
  if (!executable) return null;
  const listed = spawnSync(executable, ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: Math.max(1, timeoutMs) });
  if (listed.status !== 0 || typeof listed.stdout !== 'string') return null;
  const entries = [];
  for (const line of listed.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    const pid = Number(tokens[0]);
    const ppid = Number(tokens[1]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
    const command = tokens.slice(2).join(' ');
    if (command.includes(serverModulePath)) entries.push({ pid, ppid });
  }
  return entries;
}

/**
 * Reads the pid the disposable server registered as this run's handler owner
 * (a mode-0600 file inside the private run directory), or null when no
 * registration exists or cannot be parsed. It is a cross-check for late
 * server adoption — the registration's pid and the discovered process must
 * agree before the driver adopts and signals a late-found server.
 * @param {string} runDirectory
 * @returns {number|null}
 */
function registeredOwnerPid(runDirectory) {
  try {
    const owner = JSON.parse(readFileSync(join(runDirectory, 'handler-owner.json'), 'utf8'));
    return owner && typeof owner === 'object' && Number.isSafeInteger(owner.pid) && owner.pid > 0 ? owner.pid : null;
  } catch {
    return null;
  }
}

/** @param {string[]} argv */
function parseArguments(argv) {
  const parsed = /** @type {Record<string, string>} */ ({});
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag.startsWith('--') || !value || value.startsWith('--')) {
      throw directError('DIRECT_DRIVER_USAGE_INVALID', 'usage: driver.mjs --mode reachability|identity|lifecycle --codex <path> --run-directory <dir> [--source-codex-home <dir>] [--cases <trigger>]');
    }
    if (flag === '--mode') parsed.mode = value;
    else if (flag === '--codex') parsed.codex = value;
    else if (flag === '--run-directory') parsed.runDirectory = value;
    else if (flag === '--source-codex-home') parsed.sourceCodexHome = value;
    else if (flag === '--cases') parsed.cases = value;
    else throw directError('DIRECT_DRIVER_USAGE_INVALID', `usage: driver.mjs --mode reachability|identity|lifecycle --codex <path> --run-directory <dir> (unknown ${flag})`);
  }
  return parsed;
}

/**
 * ONE bounded direct `mcpServer/tool/call` with its durable event-position
 * snapshots, the direct-call deadline, the durable handler-entry join, and
 * the RPC observation (the shared observation primitive of every schedule).
 * An expired case ceiling records the request as not-sent and the call as
 * not-observed — never a pass. Returns whether the call was dispatched and
 * the joined call nonce, if any.
 * @param {object} ctx @param {string} probeLabel @param {string} toolName @param {string} [threadId] @param {object} [extraArguments] @param {{requestId?: number}} [requestMeta]
 * @returns {Promise<{sent: boolean, callNonce: string|undefined}>}
 */
async function runDirectCallOnce(ctx, probeLabel, toolName, threadId = ctx.threadId, extraArguments = {}, requestMeta = null) {
  const { runDirectory, runNonce, phaseCounters, session } = ctx;
  if (ctx.budgetRemainingMs() <= 0) {
    // The ceiling expired before dispatch: the request is recorded honestly
    // as not-sent and the observation as not-observed — never a pass. The
    // durable log is still read so any observed server startup reaches the
    // cleanup verification.
    await ctx.appendDriverEvent({ kind: 'request-sent', probeLabel, tool: toolName, state: 'not-sent' });
    await ctx.appendDriverEvent({ kind: 'rpc-observed', probeLabel, outcome: 'not-observed' });
    phaseCounters.rpcObservations += 1;
    const records = await readDirectProbeEvents({ runDirectory, runNonce });
    phaseCounters.handlerEntries = records.filter((record) => record.kind === 'handler-entered').length;
    phaseCounters.serverStarts = records.filter((record) => record.kind === 'server-started').length;
    phaseCounters.eventsAfter = records.length;
    ctx.noteBudgetExhausted();
    transcript(`phase-${ctx.phase}: the case ceiling expired before dispatch; the call is recorded not-sent`);
    return { sent: false, callNonce: undefined };
  }
  await ctx.appendDriverEvent({ kind: 'request-sent', probeLabel, tool: toolName, state: 'sent' });
  phaseCounters.requestsSent += 1;
  phaseCounters.eventsBefore = (await readDirectProbeEvents({ runDirectory, runNonce })).length;

  const callDeadlineMs = Math.max(1, Math.min(ctx.directCallDeadlineMs, ctx.budgetRemainingMs()));
  let rpcOutcome = 'not-observed';
  const responsePromise = session.request('mcpServer/tool/call', {
    server: DIRECT_PROBE_SERVER_NAME,
    threadId,
    tool: toolName,
    arguments: { probeLabel, ...extraArguments },
  }, callDeadlineMs);
  if (requestMeta !== null) requestMeta.requestId = responsePromise.requestId;
  try {
    const response = await responsePromise;
    rpcOutcome = response?.isError === true ? 'error-result' : 'success-result';
    transcript(`phase-${ctx.phase}: the direct call answered (${rpcOutcome})`);
  } catch (callError) {
    const code = errorCode(callError);
    // An answered JSON-RPC rejection is an observation; a request that never
    // received an answer stays honestly not-observed.
    rpcOutcome = code === 'PROBE_APP_SERVER_REQUEST_FAILED' ? 'rpc-rejected' : 'not-observed';
    transcript(`phase-${ctx.phase}: the direct call did not answer successfully (${code || 'error'})`);
    // PRIVATE ephemeral diagnostics: with DEBUG_DIRECT_PROBE set this path
    // prints ONLY the closed error code. The raw stack and the host's
    // rejection message (which can embed paths or other sensitive values)
    // are never printed: stderr is commonly retained by the caller, and the
    // CLI boundary — closed codes only — holds even under the debug flag.
    if (process.env.DEBUG_DIRECT_PROBE) {
      console.error(`DEBUG-CALL-ERR ${code || 'error'}`);
    }
  }

  // Durable handler-entry join: the driver may name a callNonce in its RPC
  // observation only after the unique-label join against the durable log.
  let callNonce;
  for (let attempt = 0; attempt < DIRECT_ENTRY_JOIN_ATTEMPTS; attempt += 1) {
    const records = await readDirectProbeEvents({ runDirectory, runNonce });
    phaseCounters.handlerEntries = records.filter((record) => record.kind === 'handler-entered').length;
    phaseCounters.serverStarts = records.filter((record) => record.kind === 'server-started').length;
    const entry = records.find((record) => record.kind === 'handler-entered' && record.probeLabel === probeLabel) ?? null;
    phaseCounters.eventsAfter = records.length;
    if (entry || attempt === DIRECT_ENTRY_JOIN_ATTEMPTS - 1) {
      callNonce = entry?.callNonce;
      break;
    }
    if (ctx.budgetRemainingMs() <= 0) {
      ctx.noteBudgetExhausted();
      break;
    }
    await sleep(Math.min(DIRECT_ENTRY_JOIN_POLL_MS, ctx.budgetRemainingMs()));
  }
  await ctx.appendDriverEvent(callNonce === undefined
    ? { kind: 'rpc-observed', probeLabel, outcome: rpcOutcome }
    : { kind: 'rpc-observed', probeLabel, callNonce, outcome: rpcOutcome });
  phaseCounters.rpcObservations += 1;
  return { sent: true, callNonce };
}

/**
 * The bounded direct-call case runner shared by every probe mode. Hard
 * failures throw; the honest classification is derived only from the
 * authenticated reduction of the durable log. Every spawn re-pins the
 * canonical binary (path, device/inode, and content digest); cleanup never
 * signals a process whose captured start identity changed. The direct-call
 * deadline and the case ceiling default to the plan's bounded values and may
 * be tightened by the caller (injected-clock seams the suite uses to test
 * the unanswered-call and ceiling paths without waiting out the real
 * budgets). The mode hooks own everything observation-bearing: the schedule
 * after readiness, the per-case budget windows, and the final gate
 * classification. `runDirectReachabilityProbe` and `runDirectIdentityProbe`
 * are the two thin mode wrappers below.
 * @param {{codexPath: string, sourceCodexHome: string, runDirectory: string, directCallDeadlineMs?: number, caseBudgetMs?: number}} input
 * @param {{mode: string, phase: string, createPhaseCounters: () => object, discoverServerBeforeSchedule: boolean, sessionOptions?: object, turnSetupBudgetMs?: number, toolTimeoutSec?: number, serverEnv?: object, lifecycleCases?: string[], lifecycleObserveWindowMs?: number, runSchedule: (ctx: object) => Promise<void>, classify: (ctx: object, records: object[], reduced: object) => Promise<void>}} hooks
 * @returns {Promise<object>} the redacted phase/outcome counters
 */
async function runDirectProbeCase(input, hooks) {
  const codexPath = input.codexPath;
  const runDirectoryInput = input.runDirectory;
  const directCallDeadlineMs = input.directCallDeadlineMs ?? DIRECT_CALL_DEADLINE_MS;
  if (!Number.isSafeInteger(directCallDeadlineMs) || directCallDeadlineMs <= 0) {
    throw directError('DIRECT_DRIVER_USAGE_INVALID', 'directCallDeadlineMs must be a positive integer of milliseconds.');
  }
  const caseBudgetMs = input.caseBudgetMs ?? DIRECT_CASE_BUDGET_MS;
  if (!Number.isSafeInteger(caseBudgetMs) || caseBudgetMs <= 0) {
    throw directError('DIRECT_DRIVER_USAGE_INVALID', 'caseBudgetMs must be a positive integer of milliseconds.');
  }
  if (typeof codexPath !== 'string' || !isAbsolute(codexPath)) {
    throw directError('PROBE_CODEX_PATH_RELATIVE', 'codexPath must be an absolute path.');
  }
  const runStats = await lstat(runDirectoryInput).catch((error) => {
    if (errorCode(error) === 'ENOENT') throw directError('PROBE_RUN_DIRECTORY_MISSING', 'The probe run directory must exist and be a private mode-0700 directory.');
    throw error;
  });
  if (!runStats.isDirectory()) throw directError('PROBE_RUN_DIRECTORY_MISSING', 'The probe run directory must exist and be a private mode-0700 directory.');
  if (process.platform !== 'win32' && (runStats.mode & 0o777) !== 0o700) {
    throw directError('PROBE_RUN_DIRECTORY_MODE', 'The probe run directory must be mode 0700.');
  }
  if ((await readdir(runDirectoryInput)).length > 0) {
    throw directError('PROBE_RUN_DIRECTORY_NOT_EMPTY', 'The probe run directory must be empty before probe state is created.');
  }
  const runDirectory = await realpath(runDirectoryInput);

  // PIN: canonicalize once, then re-verify path, device/inode, AND content
  // digest before EVERY spawn (including each cleanup command). The exact
  // version is recorded as provenance; it is never hard-coded as the only
  // allowable version (a version change starts a new evidence set at the
  // campaign level instead of failing this driver).
  const canonicalCodexPath = await realpath(codexPath).catch(() => {
    throw directError('PROBE_CODEX_MISSING', 'The supplied codex path must resolve to an existing launcher target.');
  });
  let codexIdentity = await stat(canonicalCodexPath);
  if (!codexIdentity.isFile() || (codexIdentity.mode & 0o111) === 0) {
    throw directError('PROBE_CODEX_NOT_EXECUTABLE', 'The canonical codex target must be a regular executable file.');
  }
  let codexContentDigest = await sha256File(canonicalCodexPath);
  let canonicalTarget = canonicalCodexPath;
  /**
   * Verifies one resolved path against the pin: same path, same
   * device/inode, same bytes. The content digest subsumes version identity —
   * an in-place rewrite that keeps the device and inode still fails closed.
   * The hash deadline defaults to the inspection cap; post-readiness callers
   * pass the remaining case time so a stalled filesystem cannot run the case
   * past its ceiling.
   * @param {string} currentPath @param {number} [hashDeadlineMs]
   */
  const verifyPinnedIdentity = async (currentPath, hashDeadlineMs = PS_INSPECTION_MS) => {
    const currentIdentity = await stat(currentPath);
    if (currentPath !== canonicalTarget || currentIdentity.dev !== codexIdentity.dev || currentIdentity.ino !== codexIdentity.ino
      || !currentIdentity.isFile() || (currentIdentity.mode & 0o111) === 0) {
      throw directError('PROBE_CODEX_REPLACED', 'The pinned codex binary changed during the probe run.');
    }
    const currentDigest = await sha256File(currentPath, hashDeadlineMs);
    if (currentDigest !== codexContentDigest) {
      throw directError('PROBE_CODEX_REPLACED', 'The pinned codex binary content changed during the probe run (same inode, different bytes).');
    }
    return currentIdentity;
  };
  /**
   * Re-verifies the pin and returns the canonical path. The hash deadline
   * defaults to the inspection cap; post-readiness callers pass the
   * remaining case time.
   * @param {number} [hashDeadlineMs]
   */
  const recheckCodex = async (hashDeadlineMs = PS_INSPECTION_MS) => {
    const currentPath = await realpath(canonicalCodexPath);
    const currentIdentity = await verifyPinnedIdentity(currentPath, hashDeadlineMs);
    canonicalTarget = currentPath;
    codexIdentity = currentIdentity;
    return currentPath;
  };
  // Calibration spawn: identity and digest are captured immediately before
  // it and re-verified immediately after, so the recorded version provenance
  // is bound to the exact bytes that ran.
  const versionRun = runBounded(canonicalCodexPath, ['--version'], { cwd: runDirectory, env: minimalEnv() });
  const version = await versionRun.promise;
  if (version.code !== 0 || !/codex-cli \d/.test(version.stdout)) {
    throw directError('PROBE_CODEX_VERSION', `codex --version failed: exit ${version.code}`);
  }
  const codexVersion = /** @type {RegExpMatchArray} */ (version.stdout.match(/codex-cli \S+/))?.[0] ?? 'codex-cli unknown';
  await verifyPinnedIdentity(await realpath(canonicalCodexPath));
  transcript(`driver: canonical codex target pinned (${basename(canonicalCodexPath)}), ${codexVersion}`);

  // SOURCE AUTH: only the auth bytes are read from the source Codex home,
  // copied once into the isolated home with mode 0600. The real home is
  // never touched beyond this read.
  const sourceCodexHome = await realpath(input.sourceCodexHome).catch(() => {
    throw directError('PROBE_QUALIFICATION_UNAVAILABLE', 'qualification-unavailable: the source Codex home must be a real directory.');
  });
  const sourceAuthStats = await lstat(join(sourceCodexHome, 'auth.json')).catch(() => {
    throw directError('PROBE_QUALIFICATION_UNAVAILABLE', 'qualification-unavailable: a regular auth.json must exist in the source Codex home.');
  });
  if (sourceAuthStats.isSymbolicLink() || !sourceAuthStats.isFile()) {
    throw directError('PROBE_QUALIFICATION_UNAVAILABLE', 'qualification-unavailable: the source auth.json must be a regular non-symlink file.');
  }

  const isolatedCodexHome = join(runDirectory, 'codex-home');
  const isolatedHome = join(runDirectory, 'home');
  const isolatedTmp = join(runDirectory, 'tmp');
  const workspace = join(runDirectory, 'workspace');
  const marketplaceRoot = join(runDirectory, 'marketplace-direct');
  const isolatedAuthPath = join(isolatedCodexHome, 'auth.json');

  const hostEnv = {
    PATH: process.env.PATH ?? '',
    TMPDIR: isolatedTmp,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    CODEX_HOME: isolatedCodexHome,
  };

  /** Recorded as pid → captured start identity so cleanup never signals a recycled PID. */
  const trackedProcesses = new Map();
  let installedMarketplace = false;
  let session = null;
  let serverPid = null;
  let serverIdentity = null;
  let processCleanup = 'not-observed';
  // The run capability pair: generated only once the install steps succeeded,
  // so a failure before the app-server phase leaves no run state behind.
  let runNonce = null;
  let ownerSecret = null;

  const counters = {
    probe: PROBE_NAME,
    mode: hooks.mode,
    codexVersion,
    phases: { [hooks.phase]: hooks.createPhaseCounters() },
  };
  const phaseCounters = counters.phases[hooks.phase];
  // The disposable server executable this run installs and the host spawns:
  // its exact module path is the process-table signature for discovery and
  // for the cleanup-time verification.
  const serverModulePath = join(dirname(moduleEntry), 'server.mjs');

  /** @type {{failed: boolean, error: unknown}} */
  let outcome = { failed: false, error: null };

  // ONE post-readiness ceiling (the plan's 120-second G1 budget) bounds the
  // direct call, the disposal waits, and the cleanup commands together. It
  // starts when readiness is recorded; local durable-log work is not
  // host observation and is not budgeted.
  let postReadinessDeadline = null;
  const budgetRemainingMs = () => (postReadinessDeadline === null
    ? Number.MAX_SAFE_INTEGER
    : Math.max(0, postReadinessDeadline - Date.now()));
  const noteBudgetExhausted = () => { phaseCounters.postReadinessBudget = 'exhausted'; };

  const runCodexCommand = async (args, label) => {
    const target = await recheckCodex();
    const run = runBounded(target, args, { cwd: runDirectory, env: { ...hostEnv } });
    trackedProcesses.set(run.pid, boundedCaptureIdentity(run.pid, Number.MAX_SAFE_INTEGER));
    const result = await run.promise;
    transcript(`${label}: exit=${result.code} durationMs=${result.durationMs}${result.timedOut ? ' timedOut' : ''}${result.overflow ? ' overflow' : ''}`);
    return result;
  };

  const removalCommands = [
    { args: ['plugin', 'remove', DIRECT_PLUGIN_SELECTOR, '--json'], label: 'plugin remove' },
    { args: ['plugin', 'marketplace', 'remove', DIRECT_MARKETPLACE_NAME, '--json'], label: 'marketplace remove' },
  ];

  const removeMarketplace = async () => {
    if (!installedMarketplace) return;
    const failures = [];
    for (const command of removalCommands) {
      // The remaining case budget is checked BEFORE the pin recheck: the
      // recheck hashes the binary, so at an exhausted ceiling the removal is
      // skipped (the registration is removed with its isolated home) instead
      // of running unbounded work past the ceiling.
      if (budgetRemainingMs() < CLEANUP_COMMAND_FLOOR_MS) {
        noteBudgetExhausted();
        transcript('cleanup: the post-readiness ceiling is exhausted; the marketplace registration is removed with its isolated home');
        installedMarketplace = false;
        return;
      }
      let target;
      try {
        // Fresh pin verification before EACH cleanup command, with the hash
        // bounded by the remaining case time.
        target = await recheckCodex(Math.min(PS_INSPECTION_MS, budgetRemainingMs()));
      } catch (error) {
        if (errorCode(error) === 'PROBE_CODEX_REPLACED' && outcome.failed && errorCode(outcome.error) === 'PROBE_CODEX_REPLACED') {
          // The replacement already failed the run; the registration lives
          // entirely inside the isolated CODEX_HOME that the verified
          // deletion below removes, so cleanup refuses to spawn the changed
          // binary without masking the original failure.
          transcript('cleanup: the pinned binary already failed the run; the marketplace registration is removed with its isolated home');
          return;
        }
        throw error;
      }
      // RE-CHECK after the recheck hash: hashing may have consumed the
      // remaining case time, so the command must not spawn on a depleted
      // budget (one-millisecond deadlines are not honest bounds).
      if (budgetRemainingMs() < CLEANUP_COMMAND_FLOOR_MS) {
        noteBudgetExhausted();
        transcript('cleanup: the post-readiness ceiling was exhausted by the pin recheck; the removal command is skipped and the registration is removed with its isolated home');
        installedMarketplace = false;
        return;
      }
      const run = runBounded(target, command.args, {
        cwd: runDirectory,
        env: { ...hostEnv },
        deadlineMs: Math.max(1, Math.min(SUBPROCESS_DEADLINE_MS, budgetRemainingMs())),
      });
      trackedProcesses.set(run.pid, run.identity);
      const result = await run.promise;
      if (result.code !== 0) failures.push(`${command.label} exit ${result.code}`);
    }
    installedMarketplace = false;
    if (failures.length > 0) throw directError('PROBE_CLEANUP_FAILED', `cleanup failed (${failures.join('; ')})`);
    transcript('cleanup: probe plugin and marketplace removed');
  };

  try {
    // Credential setup sits INSIDE the cleanup-protected scope: directory
    // creation, the auth copy, and the private mode can fail only through the
    // guarded path below, so every setup failure still reaches the verified
    // deletion of the credential copy and isolated homes.
    for (const directory of [isolatedCodexHome, isolatedHome, isolatedTmp, workspace, marketplaceRoot]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') await chmod(directory, 0o700);
    }
    try {
      await copyFile(join(sourceCodexHome, 'auth.json'), isolatedAuthPath);
      if (process.platform !== 'win32') await chmod(isolatedAuthPath, 0o600);
    } catch {
      // The raw error (which embeds absolute paths) is deliberately dropped
      // for the closed code; nothing path-bearing propagates from setup.
      throw directError('PROBE_QUALIFICATION_UNAVAILABLE', 'qualification-unavailable: the source auth.json could not be copied into the isolated home.');
    }

    const loginStatus = await runCodexCommand(['login', 'status'], 'login-status');
    if (loginStatus.code !== 0) {
      throw directError('PROBE_QUALIFICATION_UNAVAILABLE', 'qualification-unavailable: the isolated Codex home failed `codex login status`.');
    }

    await buildDirectProbeMarketplace(marketplaceRoot, serverModulePath, hooks.toolTimeoutSec);
    transcript('fixtures: direct probe marketplace built');
    const added = await runCodexCommand(['plugin', 'marketplace', 'add', marketplaceRoot, '--json'], 'marketplace-add');
    if (added.code !== 0) throw directError('PROBE_INSTALL_FAILED', `marketplace add failed: exit ${added.code}`);
    installedMarketplace = true;
    const installed = await runCodexCommand(['plugin', 'add', DIRECT_PLUGIN_SELECTOR, '--json'], 'plugin-add');
    if (installed.code !== 0) throw directError('PROBE_INSTALL_FAILED', `plugin add failed: exit ${installed.code}`);
    transcript('install: disposable marketplace and probe plugin installed');

    // The run capability pair: the driver holds both; the server receives the
    // secret through spawn-time env and holds it in memory only.
    runNonce = randomBytes(32).toString('hex');
    ownerSecret = randomBytes(32).toString('hex');
    const probeEnv = {
      ...hostEnv,
      ZCODE_DIRECT_MCP_PROBE_RUN: runDirectory,
      ZCODE_DIRECT_MCP_PROBE_NONCE: runNonce,
      ZCODE_DIRECT_MCP_PROBE_PHASE: hooks.phase,
      DIRECT_PROBE_OWNER_SECRET: ownerSecret,
      ...(hooks.serverEnv ?? {}),
    };

    session = startAppServerSession({ command: await recheckCodex(), args: ['app-server'], env: probeEnv, cwd: runDirectory, ...(hooks.sessionOptions ?? {}) });
    trackedProcesses.set(session.pid, session.identity);
    transcript(`phase-${hooks.phase}: app-server session started and tracked`);
    const initialize = await session.request('initialize', {
      clientInfo: { name: 'zcode-direct-mcp-probe-driver', title: 'ZCode Direct MCP Probe Driver', version: '0.1.0' },
      capabilities: null,
    });
    if (!initialize || typeof initialize !== 'object') {
      throw directError('PROBE_APP_SERVER_INITIALIZE_FAILED', 'The app-server initialize handshake returned no result.');
    }
    session.notify({ method: 'initialized', params: {} });

    const started = await session.request('thread/start', { cwd: workspace });
    const threadId = started?.thread?.id;
    if (typeof threadId !== 'string' || !threadId) {
      throw directError('PROBE_APP_SERVER_THREAD_START_FAILED', 'The app-server thread/start response omitted its thread id.');
    }

    // Readiness: server/tool discovery for THIS thread, recorded honestly
    // (discovered / missing / failed) before any direct call.
    let readinessState = 'failed';
    try {
      const status = await session.request('mcpServerStatus/list', { threadId, detail: 'full' });
      const entries = Array.isArray(status?.data) ? status.data : [];
      const entry = entries.find((candidate) => candidate && typeof candidate === 'object' && candidate.name === DIRECT_PROBE_SERVER_NAME) ?? null;
      readinessState = entry ? 'discovered' : 'missing';
      transcript(`phase-${hooks.phase}: mcpServerStatus/list ${readinessState === 'discovered' ? 'discovered the probe server' : 'did not list the probe server'}`);
    } catch (statusError) {
      readinessState = 'failed';
      transcript(`phase-${hooks.phase}: mcpServerStatus/list failed (${errorCode(statusError) || 'error'})`);
    }
    phaseCounters.readiness = readinessState;
    await appendDirectProbeEvent({
      runDirectory, runNonce, phase: DIRECT_PROBE_PHASE, ownerSecret,
      event: { kind: 'readiness-observed', state: readinessState, source: 'host' },
    });
    // The schedule context: everything observation-bearing the mode's
    // schedule needs, with the durable appends tracked so a mid-run
    // authenticated reduction can anchor on the current journal head.
    const scheduleContext = {
      session,
      threadId,
      workspace,
      runDirectory,
      runNonce,
      ownerSecret,
      phase: hooks.phase,
      phaseCounters,
      directCallDeadlineMs,
      caseBudgetMs,
      turnSetupBudgetMs: hooks.turnSetupBudgetMs ?? null,
      lifecycleCases: hooks.lifecycleCases ?? [],
      lifecycleObserveWindowMs: hooks.lifecycleObserveWindowMs ?? 120_000,
      budgetRemainingMs,
      beginCaseBudget: () => { postReadinessDeadline = Date.now() + caseBudgetMs; },
      noteBudgetExhausted,
      lastCommit: null,
      appendDriverEvent: async (event) => {
        const result = await appendDirectProbeEvent({ runDirectory, runNonce, phase: hooks.phase, ownerSecret, event });
        scheduleContext.lastCommit = result.commit;
        return result;
      },
      readEvents: () => readDirectProbeEvents({ runDirectory, runNonce }),
      // Mid-run authenticated reduction: anchor on the CURRENT journal head
      // (the disposable server commits between the driver's appends) and
      // retry when the head moves between the head read and the reduction.
      reduceNow: async () => {
        // The expected owner pid: the discovered server process, or — when
        // the process scan missed it — the pid the durable registration
        // names. A scan miss must never masquerade as a forged owner.
        const expectedOwnerPid = serverPid ?? registeredOwnerPid(runDirectory);
        let head = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          head = directProbeSealHead({ runDirectory, runNonce, ownerSecret });
          try {
            return await reduceDirectProbeLog({ runDirectory, runNonce, ownerSecret, ownerPid: expectedOwnerPid, expectedFinalState: head });
          } catch (error) {
            const nextHead = directProbeSealHead({ runDirectory, runNonce, ownerSecret });
            if (attempt < 2 && nextHead !== null && head !== null
              && (nextHead.recordCount !== head.recordCount || nextHead.eventsDigest !== head.eventsDigest)) {
              continue;
            }
            throw error;
          }
        }
        throw directError('DIRECT_CASE_INVALID', 'The mid-run reduction could not anchor on a stable journal head.');
      },
    };

    // Server process discovery (while the host is alive): the spawned server
    // is the host's child, so exactly one process-table entry whose parent is
    // the tracked host pid is this run's server. Its captured start identity
    // gates any cleanup signal. The inspection is bounded by the remaining
    // post-readiness case time and is skipped as unobserved when that ceiling
    // is exhausted (cleanup then fails closed on any durable server start).
    const discoverServerProcess = async () => {
      if (budgetRemainingMs() <= 0) {
        noteBudgetExhausted();
        transcript(`phase-${hooks.phase}: the case ceiling is exhausted; server process discovery is skipped as unobserved`);
        return;
      }
      const matches = listProbeServerProcesses(serverModulePath, Math.min(PS_INSPECTION_MS, budgetRemainingMs()));
      if (matches === null) {
        transcript(`phase-${hooks.phase}: process inspection unavailable; the server pid stays unresolved`);
        return;
      }
      const mine = matches.filter((entry) => entry.ppid === session.pid);
      if (mine.length > 1) throw directError('PROBE_SERVER_PID_AMBIGUOUS', 'More than one probe server process belongs to this run; refusing to guess.');
      if (mine.length === 1) {
        serverPid = mine[0].pid;
        serverIdentity = boundedCaptureIdentity(serverPid, budgetRemainingMs());
      }
      // Redacted diagnostic: distinguishes a dead server (no match at all)
      // from a live server whose parent is not the tracked host process
      // (present but reparented or spawned through an intermediate).
      transcript(`phase-${hooks.phase}: server process ${serverPid === null ? 'not identified at discovery' : 'identified and tracked'} (matching processes: ${matches.length}, direct children: ${mine.length})`);
    };
    // The identity schedule reduces mid-run, which requires the expected
    // server pid: discover the disposable server BEFORE the schedule when the
    // mode asks for it (the host starts the server during tool discovery).
    if (hooks.discoverServerBeforeSchedule) await discoverServerProcess();

    await hooks.runSchedule(scheduleContext);

    await discoverServerProcess();
  } catch (error) {
    outcome = { failed: true, error };
  }

  // Process cleanup runs on every exit path: terminate the bounded session,
  // wait the server's natural disposal grace, and only then signal an
  // identity-verified survivor. Every wait and inspection is bounded by the
  // same post-readiness ceiling as the direct call.
  const cleanupFailures = [];
  /**
   * Verifies the identified server's exit within the remaining case time,
   * signalling it only after its captured start identity still matches.
   * @returns {Promise<boolean>} true when the server is verified gone
   */
  const verifyServerExit = async () => {
    const disposalMs = Math.min(SERVER_DISPOSAL_WAIT_MS, budgetRemainingMs());
    if (disposalMs < SERVER_DISPOSAL_WAIT_MS) noteBudgetExhausted();
    const exited = await waitForExit(serverPid, Math.max(1, disposalMs));
    if (exited) return true;
    if (boundedIdentityMatches(serverPid, serverIdentity, budgetRemainingMs())) {
      try { process.kill(serverPid, 'SIGKILL'); } catch { /* already gone */ }
      const killGraceMs = Math.min(SERVER_KILL_GRACE_MS, budgetRemainingMs());
      if (killGraceMs < SERVER_KILL_GRACE_MS) noteBudgetExhausted();
      return waitForExit(serverPid, Math.max(1, killGraceMs));
    }
    // Refusing to signal an unverifiable pid is mandatory.
    return false;
  };
  try {
    if (session !== null) {
      const terminateGraceMs = Math.min(5_000, budgetRemainingMs());
      if (terminateGraceMs < 5_000) noteBudgetExhausted();
      await session.terminate(Math.max(1, terminateGraceMs));
    }
    session = null;
    // FRESH durable evidence: cleanup re-reads the log instead of trusting
    // the counters from earlier reads — a server that started after the last
    // read, or an earlier read that failed before counting, must not let
    // cleanup skip verification. An unreadable log is itself unresolved: an
    // observed server start can no longer be ruled out.
    let durableServerStarts = 0;
    let logReadable = true;
    if (runNonce !== null) {
      try {
        const records = await readDirectProbeEvents({ runDirectory, runNonce });
        // Each durable start carries its own instance hash: every DISTINCT
        // hash is a separate server process that must be accounted for
        // before any release verdict.
        const startInstanceHashes = new Set(
          records
            .filter((record) => record.kind === 'server-started')
            .map((record) => record.serverInstanceHash),
        );
        durableServerStarts = startInstanceHashes.size;
        phaseCounters.serverStarts = durableServerStarts;
        phaseCounters.handlerEntries = records.filter((record) => record.kind === 'handler-entered').length;
      } catch {
        logReadable = false;
      }
    }
    let serverExitVerified = true;
    if (serverPid !== null) {
      // Hygiene: verify (or identity-verified kill) the captured server's
      // exit whatever the log says.
      serverExitVerified = await verifyServerExit();
    } else if (logReadable && durableServerStarts > 0) {
      // Durable server startup was observed (a MAC-authenticated handler-side
      // record) but no process was identified at discovery: re-inspect once,
      // bounded by the remaining case time. The re-inspection drops the
      // parent filter (a host that spawns through an intermediate, or a host
      // that already exited, leaves the server reparented) and adopts the
      // entry whose pid the handler-owner registration names — the process
      // table and the registration must agree exactly. When the server's exit
      // still cannot be verified, cleanup FAILS as unresolved — a server that
      // outlives its host is never reported as released.
      const remainingMs = budgetRemainingMs();
      if (remainingMs <= 0) {
        noteBudgetExhausted();
        serverExitVerified = false;
        cleanupFailures.push(directError('PROBE_SERVER_PID_UNRESOLVED', 'Server startup was observed but the case ceiling was exhausted before its exit could be verified.'));
      } else {
        const late = listProbeServerProcesses(serverModulePath, Math.min(PS_INSPECTION_MS, remainingMs));
        const ownerPid = registeredOwnerPid(runDirectory);
        const candidate = late !== null && ownerPid !== null
          ? late.find((entry) => entry.pid === ownerPid) ?? null
          : null;
        if (candidate === null) {
          serverExitVerified = false;
          cleanupFailures.push(directError('PROBE_SERVER_PID_UNRESOLVED', 'Server startup was observed but the server owner process could not be identified; its exit cannot be verified.'));
        } else {
          serverPid = candidate.pid;
          serverIdentity = boundedCaptureIdentity(serverPid, budgetRemainingMs());
          transcript('cleanup: the server process was identified late; verifying its exit');
          serverExitVerified = await verifyServerExit();
        }
      }
    }
    let released;
    if (!logReadable) {
      // THE VERDICT: an unreadable durable log forces release-failed
      // REGARDLESS of whether a pid was captured and its exit verified — the
      // evidence can no longer rule out an additional observed start.
      released = false;
      cleanupFailures.push(directError('PROBE_SERVER_PID_UNRESOLVED', 'The durable event log could not be read during cleanup; an observed server start cannot be ruled out, so its exit cannot be verified.'));
    } else if (durableServerStarts > 1) {
      // More than one distinct durable start and only one owner
      // registration: the additional starts cannot be bound to process
      // identities, so they cannot be accounted for — release fails closed.
      released = false;
      cleanupFailures.push(directError('PROBE_SERVER_PID_UNRESOLVED', 'Multiple durable server starts cannot be fully accounted for; their exits cannot be verified.'));
    } else {
      released = serverExitVerified;
    }
    processCleanup = released ? 'released' : 'release-failed';
    phaseCounters.cleanup = processCleanup;
    if (!released && cleanupFailures.length === 0) {
      cleanupFailures.push(directError('PROBE_CLEANUP_FAILED', 'The disposable probe server survived cleanup or its identity could not be verified.'));
    }
  } catch (cleanupError) {
    processCleanup = 'release-failed';
    phaseCounters.cleanup = processCleanup;
    cleanupFailures.push(cleanupError);
  }

  // The durable cleanup record is the driver's final append: its commit is
  // the reduction anchor. Reduction then authenticates the whole transcript
  // (seal chain, owner registration, per-record Macs) before any
  // classification is derived.
  if (runNonce !== null && ownerSecret !== null) {
    try {
      const finalAppend = await appendDirectProbeEvent({
        runDirectory, runNonce, phase: DIRECT_PROBE_PHASE, ownerSecret,
        event: { kind: 'cleanup-observed', outcome: processCleanup === 'released' ? 'released' : 'release-failed', source: 'driver' },
      });
      const reduced = await reduceDirectProbeLog({
        runDirectory, runNonce, ownerSecret,
        ownerPid: serverPid ?? registeredOwnerPid(runDirectory),
        expectedFinalState: finalAppend.commit,
      });
      const records = await readDirectProbeEvents({ runDirectory, runNonce });
      phaseCounters.eventRecords = records.length;
      phaseCounters.uncommittedCount = reduced.uncommittedCount;
      await hooks.classify({
        phaseCounters, phase: hooks.phase, runNonce, runDirectory, ownerSecret,
      }, records, reduced);
    } catch (reduceError) {
      outcome = outcome.failed ? outcome : { failed: true, error: reduceError };
    }
  }

  // Ordered unconditional cleanup: stop leftovers, remove the registration,
  // then verify the deletion of the credential copy and every isolated home.
  for (const [pid, identity] of trackedProcesses) {
    if (!isProcessAlive(pid)) continue;
    if (boundedIdentityMatches(pid, identity, budgetRemainingMs())) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      const graceMs = Math.min(SERVER_KILL_GRACE_MS, budgetRemainingMs());
      if (graceMs < SERVER_KILL_GRACE_MS) noteBudgetExhausted();
      if (!(await waitForExit(pid, Math.max(1, graceMs)))) {
        cleanupFailures.push(directError('PROBE_CLEANUP_FAILED', 'A tracked probe process survived cleanup.'));
      }
    } else {
      cleanupFailures.push(directError('PROBE_CLEANUP_FAILED', 'A tracked probe process is still running and its start identity could not be verified for cleanup.'));
    }
  }
  try {
    await removeMarketplace();
  } catch (cleanupError) {
    cleanupFailures.push(cleanupError);
  }
  const deletionTargets = [
    isolatedAuthPath,
    isolatedCodexHome, isolatedHome, isolatedTmp, workspace, marketplaceRoot,
  ];
  for (const target of deletionTargets) {
    try {
      await rm(target, { recursive: true, force: true });
      if (await lstat(target).then(() => true, () => false)) {
        throw directError('PROBE_CLEANUP_FAILED', 'A probe-owned file or directory could not be removed.');
      }
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
  }
  if (cleanupFailures.length > 0) {
    transcript(`cleanup: ${cleanupFailures.length} redacted cleanup failure(s) recorded`);
    if (outcome.failed) {
      transcript(`driver: the run already failed with ${errorCode(outcome.error) || 'an unspecified error'}`);
    }
    throw cleanupFailures[0];
  }
  if (outcome.failed) throw outcome.error;
  return counters;
}

// ---------------------------------------------------------------------------
// Mode wrappers and the identity schedule (plan Task 4). Reachability keeps
// its exact schedule and counters; identity runs the bounded identity-matrix
// cells over the same pin/auth/install/readiness/cleanup machinery.
// ---------------------------------------------------------------------------

/** The reachability mode's phase counters (unchanged Task 3 shape). */
function createReachabilityPhaseCounters() {
  return {
    readiness: 'not-observed',
    requestsSent: 0,
    rpcObservations: 0,
    handlerEntries: 0,
    serverStarts: 0,
    classification: 'not-observed',
    eventsBefore: 0,
    eventsAfter: 0,
    eventRecords: 0,
    uncommittedCount: 0,
    cleanup: 'not-observed',
    postReadinessBudget: 'within-budget',
  };
}

/** The reachability schedule: one post-readiness ceiling, one direct call. */
async function runReachabilitySchedule(ctx) {
  // The post-readiness ceiling starts here: everything observation-bearing
  // after this point — the direct call, the durable join, the disposal
  // waits, and the bounded cleanup commands — shares this one deadline.
  ctx.beginCaseBudget();
  const probeLabel = randomBytes(16).toString('hex');
  await runDirectCallOnce(ctx, probeLabel, DIRECT_PROBE_TOOL_NAME);
}

/** The reachability classification: the single label's case and the G1 gate. */
async function classifyReachability(ctx, records, reduced) {
  const probeLabelRecord = records.find((record) => record.kind === 'request-sent' && record.state === 'sent') ?? null;
  if (probeLabelRecord) {
    const reachability = directReachabilityCase({ records, reduced, probeLabel: probeLabelRecord.probeLabel });
    ctx.phaseCounters.classification = reachability.classification;
    ctx.phaseCounters.gateG1 = classifyDirectGateG1(reachability);
  }
}

/**
 * The bounded reachability probe (plan Task 3, unchanged behavior): pin,
 * isolated homes, disposable marketplace, readiness, ONE direct call on the
 * SAME connection, durable entry join, and fail-closed cleanup.
 * @param {{codexPath: string, sourceCodexHome: string, runDirectory: string, directCallDeadlineMs?: number, caseBudgetMs?: number}} input
 * @returns {Promise<object>} the redacted phase/outcome counters
 */
export async function runDirectReachabilityProbe(input) {
  return runDirectProbeCase(input, {
    mode: 'reachability',
    phase: DIRECT_PROBE_PHASE,
    createPhaseCounters: createReachabilityPhaseCounters,
    discoverServerBeforeSchedule: false,
    runSchedule: runReachabilitySchedule,
    classify: classifyReachability,
  });
}

const DIRECT_IDENTITY_PHASE = 'identity';
// The model-turn setup budget: the plan bounds each model-turn setup to at
// most 300 seconds; the hold attempt (turn/start to approval request or
// observed turn end) shares this ceiling.
const IDENTITY_TURN_SETUP_BUDGET_MS = 300_000;
// The instruction driving the hold attempt: the model must attempt a command
// execution so the untrusted approval policy routes an approval request —
// the documented server->client request that carries the exact thread/turn
// ids and keeps the turn in progress while unanswered. A model asked to
// sleep is NOT accepted as proof of an active turn.
const IDENTITY_HOLD_INSTRUCTION = 'Use the shell to run exactly this command: sleep 45. Do not do anything else.';
// The controlled hold: a server->client approval request naming the turn.
const IDENTITY_APPROVAL_REQUEST_PATTERN = /CommandExecutionRequestApproval/;
// Retained notification ring: turn-lifecycle notifications only.
const IDENTITY_TURN_NOTIFICATION_PATTERN = /(^|\W)turn(\W|$)/i;
// Bounded wait for the turn's terminal notification after the hold is denied.
const IDENTITY_SETTLE_WAIT_MS = 30_000;
// Host TurnStatus values (generated schema) mapped to the closed evidence states.
const IDENTITY_TURN_STATE_BY_HOST_STATUS = Object.freeze({
  inProgress: 'active', completed: 'completed', interrupted: 'interrupted', failed: 'failed',
});

/** The identity mode's phase counters. */
function createIdentityPhaseCounters() {
  return {
    readiness: 'not-observed',
    requestsSent: 0,
    rpcObservations: 0,
    handlerEntries: 0,
    serverStarts: 0,
    cells: { idle: 'not-run', twoThreads: 'not-run', activeHold: 'not-run', completed: 'not-run' },
    isolation: {
      threads: { status: 'not-proven', reasonCode: 'not-run' },
      children: { status: 'not-proven', reasonCode: 'child-identity-unestablishable' },
    },
    activeTurnHold: { status: 'not-proven', reasonCode: 'not-run' },
    classification: 'not-observed',
    gateG2: { status: 'not-proven', reasonCode: 'no-trusted-caller-path', evidenceRefs: [] },
    eventsBefore: 0,
    eventsAfter: 0,
    eventRecords: 0,
    uncommittedCount: 0,
    cleanup: 'not-observed',
    postReadinessBudget: 'within-budget',
  };
}

/** The strongest recorded cell classification (closed precedence). */
const IDENTITY_CELL_PRECEDENCE = Object.freeze([
  'binding-observed', 'mismatch-observed', 'inconclusive', 'correlation-only',
  'no-candidate-observed', 'not-observed', 'not-proven', 'not-run',
]);

/**
 * Reduces one retained host notification to a closed turn-state fact with
 * per-run salted hashes. Raw host ids are reduced here and never retained;
 * an unparseable notification records no turn at all.
 * @param {{method: string, params: object}} notification
 * @param {string} runNonce
 */
function reduceTurnNotification(notification, runNonce) {
  const params = notification.params && typeof notification.params === 'object' && !Array.isArray(notification.params)
    ? notification.params
    : {};
  const turn = params.turn && typeof params.turn === 'object' && !Array.isArray(params.turn) ? params.turn : {};
  const turnId = typeof turn.id === 'string' ? turn.id : (typeof params.turnId === 'string' ? params.turnId : null);
  const threadId = typeof params.threadId === 'string' ? params.threadId : null;
  const status = typeof turn.status === 'string' ? turn.status : (typeof params.status === 'string' ? params.status : null);
  const state = status !== null ? IDENTITY_TURN_STATE_BY_HOST_STATUS[status] ?? 'unknown' : 'unknown';
  return {
    state,
    threadHash: typeof threadId === 'string' && threadId ? hashProbeValue(runNonce, threadId) : null,
    turnHash: typeof turnId === 'string' && turnId ? hashProbeValue(runNonce, turnId) : null,
  };
}

/**
 * Builds the closed turn-state-observed event for a driver-side observation.
 * Per the frozen contract, 'not-observed' and 'unknown' record NO hashes
 * (absence, never null); every observed state carries both salted hashes.
 * @param {string} state @param {string|null} turnId @param {string} threadHash @param {string} runNonce
 */
function identityTurnStateEvent(state, turnId, threadHash, runNonce) {
  if (state === 'not-observed' || state === 'unknown' || typeof turnId !== 'string' || !turnId) {
    return { kind: 'turn-state-observed', state, source: 'host' };
  }
  return { kind: 'turn-state-observed', threadHash, turnHash: hashProbeValue(runNonce, turnId), state, source: 'host' };
}

/** Finds the completion of the exact turn among drained notifications. */
function findTurnCompletion(drainedNotifications, runNonce, turnHash) {
  return drainedNotifications
    .map((notification) => reduceTurnNotification(notification, runNonce))
    .find((turn) => turn.turnHash === turnHash && turn.state !== 'active' && turn.state !== 'unknown') ?? null;
}

/**
 * The controlled active-turn hold attempt: turn/start under the untrusted
 * approval policy with a read-only sandbox, then a bounded wait for the
 * host's CommandExecutionRequestApproval naming the exact turn — the
 * documented server->client request that keeps the turn in progress while
 * unanswered. Every outcome is recorded honestly; a turn that ends on its
 * own, a turn/start failure, or a budget expiry is `not-proven`, never
 * inferred past.
 * @param {object} ctx @param {string} threadHash @param {string} runNonce
 */
async function attemptIdentityHold(ctx, threadHash, runNonce) {
  const { session } = ctx;
  const setupDeadline = Date.now() + (ctx.turnSetupBudgetMs ?? IDENTITY_TURN_SETUP_BUDGET_MS);
  let turnId = null;
  try {
    const turn = await session.request('turn/start', {
      threadId: ctx.threadId,
      input: [{ type: 'text', text: IDENTITY_HOLD_INSTRUCTION }],
      approvalPolicy: 'untrusted',
      sandboxPolicy: { type: 'readOnly' },
    }, Math.max(1, Math.min(60_000, setupDeadline - Date.now())));
    turnId = turn && typeof turn === 'object' && turn.turn && typeof turn.turn === 'object' && typeof turn.turn.id === 'string'
      ? turn.turn.id
      : null;
  } catch (error) {
    transcript(`phase-identity: turn/start failed (${errorCode(error) || 'error'}); no controlled hold exists`);
    return { status: 'not-proven', reasonCode: 'turn-start-unavailable', turnId: null, turnHash: null, terminalState: 'unknown', terminalObserved: false };
  }
  if (turnId === null) {
    transcript('phase-identity: turn/start returned no turn id; no controlled hold exists');
    return { status: 'not-proven', reasonCode: 'turn-start-unavailable', turnId: null, turnHash: null, terminalState: 'unknown', terminalObserved: false };
  }
  const turnHash = hashProbeValue(runNonce, turnId);
  while (Date.now() < setupDeadline) {
    // PEEK, never remove: the held request stays in the outstanding queue so
    // the active cell's pre/post reads can re-verify, at each moment, that
    // the host-issued hold for the exact turn is still unanswered.
    const approval = session.findHeldServerRequest((entry) => IDENTITY_APPROVAL_REQUEST_PATTERN.test(entry.method));
    if (approval !== null) {
      const approvalTurnId = approval.params && typeof approval.params.turnId === 'string' ? approval.params.turnId : null;
      if (approvalTurnId === null || hashProbeValue(runNonce, approvalTurnId) !== turnHash) {
        // An approval naming a different turn cannot hold ours: decline it
        // (the turn continues) and record the hold as not established.
        session.respondToServerRequest(approval.id, { decision: 'decline' });
        session.dropHeldServerRequest(approval.id);
        transcript('phase-identity: the approval request named a different turn; no controlled hold');
        return { status: 'not-proven', reasonCode: 'no-controlled-hold', turnId, turnHash, terminalState: 'unknown', terminalObserved: false };
      }
      transcript('phase-identity: the approval request holds the exact turn; the active-turn cell proceeds');
      return { status: 'observed', reasonCode: null, turnId, turnHash, approval, terminalState: 'unknown', terminalObserved: false };
    }
    const completion = findTurnCompletion(session.drainRetainedNotifications(), runNonce, turnHash);
    if (completion !== null) {
      transcript(`phase-identity: the turn ended on its own before any approval request (${completion.state}); no controlled hold`);
      return { status: 'not-proven', reasonCode: 'no-controlled-hold', turnId, turnHash, terminalState: completion.state, terminalObserved: true };
    }
    const remaining = setupDeadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(500, remaining));
  }
  transcript('phase-identity: the model-turn setup budget expired without an approval request; no controlled hold');
  return { status: 'not-proven', reasonCode: 'no-controlled-hold', turnId, turnHash, terminalState: 'unknown', terminalObserved: false };
}

/**
 * Settles the held turn: denies the approval with 'cancel' (the host denies
 * the command AND interrupts the exact turn), records ONLY what the
 * settle window actually observed, and returns the observed terminal fact
 * (or null when nothing was observed — the caller must then treat the
 * terminal as unknown, never presume it). The wait is bounded by the settle
 * window and scales down with the injected setup budget so tests stay fast.
 */
async function settleIdentityHold(ctx, hold, threadHash) {
  const { session } = ctx;
  try { session.respondToServerRequest(hold.approval.id, { decision: 'cancel' }); } catch { /* session ending */ }
  session.dropHeldServerRequest(hold.approval.id);
  const settleWaitMs = Math.min(IDENTITY_SETTLE_WAIT_MS, Math.max(1_000, Math.floor((ctx.turnSetupBudgetMs ?? IDENTITY_TURN_SETUP_BUDGET_MS) / 10)));
  const deadline = Date.now() + settleWaitMs;
  let terminal = null;
  while (Date.now() < deadline) {
    terminal = findTurnCompletion(session.drainRetainedNotifications(), ctx.runNonce, hold.turnHash);
    if (terminal !== null) break;
    await sleep(Math.min(500, Math.max(1, deadline - Date.now())));
  }
  await ctx.appendDriverEvent(identityTurnStateEvent(terminal ? terminal.state : 'unknown', terminal ? hold.turnId : null, threadHash, ctx.runNonce));
  transcript(`phase-identity: the held turn settled (${terminal ? terminal.state : 'unobserved'})`);
  return terminal;
}

/** The identity schedule: idle cell, hold attempt, active cell, completed cell. */
async function runIdentitySchedule(ctx) {
  const threadHash = hashProbeValue(ctx.runNonce, ctx.threadId);
  const runNonce = ctx.runNonce;
  // Each cell's sample is attributed ONLY by the durable records inside its
  // own dispatch window (from the cell's first append onward): a stale turn
  // observation from an earlier cell must never relabel a later sample.
  const classifyCell = async (name, probeLabel, expectedTurnHash, startSequence, expectedThreadHash = threadHash) => {
    try {
      const reduced = await ctx.reduceNow();
      const records = (await ctx.readEvents()).slice(startSequence);
      const identity = directIdentityCase({
        records,
        reduced,
        probeLabel,
        phase: DIRECT_IDENTITY_PHASE,
        expectedThreadHash,
        expectedTurnHash,
      });
      return identity.classification;
    } catch (error) {
      transcript(`phase-identity: the ${name} cell could not be reduced (${errorCode(error) || 'error'}); the cell is recorded not-proven`);
      return 'not-proven';
    }
  };
  const runCell = async (name, { expectedTurnHash, preTurnEvent, postTurnEvent, observePostTurn, threadId }) => {
    const probeLabel = randomBytes(16).toString('hex');
    const startSequence = (await ctx.readEvents()).length;
    if (preTurnEvent) await ctx.appendDriverEvent(preTurnEvent);
    ctx.beginCaseBudget();
    await runDirectCallOnce(ctx, probeLabel, DIRECT_PROBE_TOOL_NAME, threadId);
    // The post-read event comes from the caller's OBSERVED fact when an
    // observer is supplied — never from an authored assumption.
    const postEvent = observePostTurn ? observePostTurn() : postTurnEvent;
    if (postEvent) await ctx.appendDriverEvent(postEvent);
    ctx.phaseCounters.cells[name] = await classifyCell(name, probeLabel, expectedTurnHash, startSequence);
  };

  // Cell 1 — idle: a direct call BEFORE any turn. A transport observation
  // only; it can never establish user-turn authority.
  await runCell('idle', {
    expectedTurnHash: null,
    preTurnEvent: identityTurnStateEvent('not-observed', null, threadHash, runNonce),
    postTurnEvent: identityTurnStateEvent('not-observed', null, threadHash, runNonce),
  });

  // Cell 2 — two threads: a second independently created thread on the SAME
  // owned connection, one direct call per thread. This transport-level
  // isolation observation has NO hold prerequisite; Child isolation is
  // recorded not-proven (the host exposes no independently learnable Child
  // identity, and a caller-supplied Child id is never copied).
  await runTwoThreadsCell(ctx, threadHash, runNonce);

  // The controlled active-turn hold attempt (model-turn setup budget).
  const hold = await attemptIdentityHold(ctx, threadHash, runNonce);
  ctx.phaseCounters.activeTurnHold = hold.status === 'observed'
    ? { status: 'observed', reasonCode: null }
    : { status: 'not-proven', reasonCode: hold.reasonCode };
  if (hold.status === 'observed') {
    // Cell 3 — active turn A: the pre/post turn-state events are DERIVED from
    // re-verified host evidence at each moment — the retained notification
    // stream for an observed terminal, else the still-outstanding
    // host-issued approval request naming the exact turn. No state is
    // authored: when the hold is gone and nothing was observed, 'unknown'
    // (no hashes) is what the evidence records.
    const observeHeldTurnState = () => {
      const drained = ctx.session.drainRetainedNotifications();
      const completion = findTurnCompletion(drained, runNonce, hold.turnHash);
      if (completion !== null) return completion.state;
      const outstanding = ctx.session.findHeldServerRequest((entry) => IDENTITY_APPROVAL_REQUEST_PATTERN.test(entry.method)
        && entry.params && typeof entry.params.turnId === 'string'
        && hashProbeValue(runNonce, entry.params.turnId) === hold.turnHash);
      return outstanding !== null ? 'active' : 'unknown';
    };
    await runCell('activeHold', {
      expectedTurnHash: hold.turnHash,
      preTurnEvent: identityTurnStateEvent(observeHeldTurnState(), hold.turnId, threadHash, runNonce),
      observePostTurn: () => identityTurnStateEvent(observeHeldTurnState(), hold.turnId, threadHash, runNonce),
    });
    // Settle the held turn (deny + interrupt); carry what the settle window
    // actually OBSERVED back into the hold for the completed cell.
    const terminal = await settleIdentityHold(ctx, hold, threadHash);
    hold.terminalState = terminal !== null ? terminal.state : 'unknown';
    hold.terminalObserved = terminal !== null;
  } else {
    ctx.phaseCounters.cells.activeHold = 'not-proven';
  }

  // Cell 4 — completed: a call after the confirmed settlement, using ONLY the
  // settle-OBSERVED terminal state. When the turn never became observable,
  // the cell records not-proven instead.
  if (hold.turnId === null) {
    ctx.phaseCounters.cells.completed = 'not-proven';
    transcript('phase-identity: no observable turn existed; the completed cell is recorded not-proven');
  } else {
    const terminalState = hold.terminalObserved ? hold.terminalState : 'unknown';
    await runCell('completed', {
      expectedTurnHash: hold.turnHash,
      preTurnEvent: identityTurnStateEvent(terminalState, hold.turnId, threadHash, runNonce),
      postTurnEvent: identityTurnStateEvent(terminalState, hold.turnId, threadHash, runNonce),
    });
  }
}

/**
 * Cell 2 — two threads/Children: a SECOND independently created thread on
 * the same owned connection, its own readiness observation, and a direct
 * call on it. The cell is a transport-level isolation observation and has NO
 * active-turn prerequisite. Isolation is recorded as observed only when the
 * second thread's own sample correlates with its own identity AND
 * contradicts the first thread's identity; Child isolation is never claimed
 * (no independently learnable Child identity exists, and a caller-supplied
 * Child id is never copied).
 * @param {object} ctx @param {string} threadHash1 @param {string} runNonce
 */
async function runTwoThreadsCell(ctx, threadHash1, runNonce) {
  const { session } = ctx;
  let threadId2 = null;
  try {
    const started = await session.request('thread/start', { cwd: ctx.workspace }, 30_000);
    threadId2 = started && typeof started === 'object' && started.thread && typeof started.thread === 'object' && typeof started.thread.id === 'string'
      ? started.thread.id
      : null;
  } catch (error) {
    transcript(`phase-identity: the second thread/start failed (${errorCode(error) || 'error'})`);
  }
  if (threadId2 === null || threadId2 === ctx.threadId) {
    ctx.phaseCounters.cells.twoThreads = 'not-proven';
    ctx.phaseCounters.isolation.threads = { status: 'not-proven', reasonCode: 'second-thread-unavailable' };
    transcript('phase-identity: no second thread could be established; the two-thread cell is recorded not-proven');
    return;
  }
  const threadHash2 = hashProbeValue(runNonce, threadId2);
  // Readiness for the second thread, recorded before its dispatch.
  let readiness2 = 'failed';
  try {
    const status = await session.request('mcpServerStatus/list', { threadId: threadId2, detail: 'full' }, 30_000);
    const entries = Array.isArray(status?.data) ? status.data : [];
    readiness2 = entries.some((candidate) => candidate && typeof candidate === 'object' && candidate.name === DIRECT_PROBE_SERVER_NAME)
      ? 'discovered'
      : 'missing';
  } catch {
    readiness2 = 'failed';
  }
  const startSequence = (await ctx.readEvents()).length;
  await ctx.appendDriverEvent({ kind: 'readiness-observed', state: readiness2, source: 'host' });
  const probeLabel = randomBytes(16).toString('hex');
  ctx.beginCaseBudget();
  await ctx.appendDriverEvent(identityTurnStateEvent('not-observed', null, threadHash2, runNonce));
  await runDirectCallOnce(ctx, probeLabel, DIRECT_PROBE_TOOL_NAME, threadId2);
  await ctx.appendDriverEvent(identityTurnStateEvent('not-observed', null, threadHash2, runNonce));
  let own = null;
  let cross = null;
  try {
    const reduced = await ctx.reduceNow();
    const records = (await ctx.readEvents()).slice(startSequence);
    // Own-identity sample: the thread-2 call against thread 2's learned
    // identity. Cross-identity sample: the SAME call against thread 1's
    // identity must contradict — that discrimination is the isolation fact.
    own = directIdentityCase({
      records, reduced, probeLabel, phase: DIRECT_IDENTITY_PHASE,
      expectedThreadHash: threadHash2, expectedTurnHash: null,
    });
    cross = directIdentityCase({
      records, reduced, probeLabel, phase: DIRECT_IDENTITY_PHASE,
      expectedThreadHash: threadHash1, expectedTurnHash: null,
    });
  } catch (error) {
    transcript(`phase-identity: the two-thread cell could not be reduced (${errorCode(error) || 'error'}); recorded not-proven`);
  }
  if (own === null || cross === null) {
    ctx.phaseCounters.cells.twoThreads = 'not-proven';
    ctx.phaseCounters.isolation.threads = { status: 'not-proven', reasonCode: 'own-thread-unresolved' };
    return;
  }
  ctx.phaseCounters.cells.twoThreads = own.classification;
  if (own.classification === 'correlation-only' && cross.classification === 'mismatch-observed') {
    ctx.phaseCounters.isolation.threads = { status: 'observed', reasonCode: null };
    transcript('phase-identity: the two-thread cell observed transport-level isolation');
  } else if (own.classification === 'not-observed') {
    ctx.phaseCounters.isolation.threads = { status: 'not-proven', reasonCode: 'call-not-observed' };
  } else if (cross.classification !== 'mismatch-observed') {
    ctx.phaseCounters.isolation.threads = { status: 'not-proven', reasonCode: 'cross-thread-correlation' };
  } else if (own.classification === 'mismatch-observed') {
    // The own thread WAS resolved: its sample genuinely contradicts the
    // learned identity (the candidate matches NEITHER thread). Surface the
    // contradiction instead of the generic unresolved code.
    ctx.phaseCounters.isolation.threads = { status: 'not-proven', reasonCode: 'isolation-mismatch' };
  } else {
    ctx.phaseCounters.isolation.threads = { status: 'not-proven', reasonCode: 'own-thread-unresolved' };
  }
}

/** The identity classification: strongest cell plus the G2 gate. */
async function classifyIdentity(ctx) {
  const phaseCounters = ctx.phaseCounters;
  let classification = 'not-run';
  for (const cell of Object.values(phaseCounters.cells)) {
    if (IDENTITY_CELL_PRECEDENCE.indexOf(cell) < IDENTITY_CELL_PRECEDENCE.indexOf(classification)) classification = cell;
  }
  phaseCounters.classification = classification;
  // The authorization bridge is a LOCAL candidate (identity.mjs): it
  // demonstrates the admission mechanism in fixtures only. No tested host
  // demonstrated a trusted-caller path into it, so the gate records that
  // missing link whatever the identity cells observed.
  phaseCounters.gateG2 = classifyDirectGateG2({
    identity: phaseCounters.cells.activeHold,
    activeTurnHold: phaseCounters.activeTurnHold,
    authorization: { status: 'not-demonstrated', reasonCode: 'no-trusted-caller-path' },
  });
}

/**
 * The bounded identity probe (plan Task 4): the reachability machinery with
 * the identity-matrix schedule. Per case ceiling 120s after each cell's
 * readiness; the model-turn setup budget defaults to the plan's 300s.
 * @param {{codexPath: string, sourceCodexHome: string, runDirectory: string, directCallDeadlineMs?: number, caseBudgetMs?: number, turnSetupBudgetMs?: number}} input
 * @returns {Promise<object>} the redacted phase/outcome counters
 */
export async function runDirectIdentityProbe(input) {
  const turnSetupBudgetMs = input.turnSetupBudgetMs ?? IDENTITY_TURN_SETUP_BUDGET_MS;
  if (!Number.isSafeInteger(turnSetupBudgetMs) || turnSetupBudgetMs <= 0) {
    throw directError('DIRECT_DRIVER_USAGE_INVALID', 'turnSetupBudgetMs must be a positive integer of milliseconds.');
  }
  return runDirectProbeCase(input, {
    mode: 'identity',
    phase: DIRECT_IDENTITY_PHASE,
    createPhaseCounters: createIdentityPhaseCounters,
    // The mid-run cell reductions require the expected server pid: the host
    // starts the disposable server during tool discovery, before readiness.
    discoverServerBeforeSchedule: true,
    turnSetupBudgetMs,
    sessionOptions: {
      holdServerRequestPattern: IDENTITY_APPROVAL_REQUEST_PATTERN,
      retainNotificationPattern: IDENTITY_TURN_NOTIFICATION_PATTERN,
    },
    runSchedule: runIdentitySchedule,
    classify: classifyIdentity,
  });
}

// ---------------------------------------------------------------------------
// Lifecycle mode (plan Task 5). The same pin/auth/install/readiness/cleanup
// machinery runs the SEPARATE lifecycle cases over held `hold_direct` calls:
// each case is a fresh handler whose durable `hold-started` (with the
// synthetic worker claim) is awaited BEFORE any trigger, the observation is
// bounded by the case ceiling, and the classification is derived ONLY from
// the durable settlement records inside the case's own record window —
// never from the RPC outcome or the turn status.
// ---------------------------------------------------------------------------

const DIRECT_LIFECYCLE_PHASE = 'lifecycle';
const DIRECT_LIFECYCLE_HOLD_TOOL = 'hold_direct';
// The probe-owned synthetic worker's completion duration for the completion
// case, and the tightened documented `tool_timeout_sec` the lifecycle
// descriptor uses so the config-timeout and cancel-race cases fit the
// bounded campaign budget.
const LIFECYCLE_COMPLETION_HOLD_MS = 3_000;
const LIFECYCLE_CONFIG_TIMEOUT_SEC = 8;
const LIFECYCLE_CANCEL_RACE_HOLD_MS = LIFECYCLE_CONFIG_TIMEOUT_SEC * 1_000 + 2_000;
// The MECHANISM-ONLY injected server safety ceiling (the production target is
// the 100-hour ceiling; this exercises only the forced-settlement mechanism).
const LIFECYCLE_SAFETY_DEADLINE_MS = 5_000;
const LIFECYCLE_DIRECT_CALL_DEADLINE_MS = 15_000;
/** Poll interval for durable-record observation inside a case window. */
const LIFECYCLE_OBSERVE_POLL_MS = 250;
/** The sentinel hold's own completion duration: it must remain ACTIVE past
 * the configured tool-timeout boundary (plus margin) so a completed
 * settlement postdates the durable boundary marker and genuinely proves
 * per-call isolation at that moment — while still settling inside the case
 * window. */
const LIFECYCLE_SENTINEL_HOLD_MS = LIFECYCLE_CONFIG_TIMEOUT_SEC * 1_000 + 4_000;
/**
 * The default preserving-case list: every case here keeps the host
 * connection alive until the FINAL case, which closes only the client
 * connection. The destructive and injected cases (`host-stop`, `host-kill`,
 * `safety-deadline`) each REQUIRE their own single-case invocation — a fresh
 * isolated session — and are refused inside a shared selection.
 */
const DIRECT_LIFECYCLE_DEFAULT_CASES = Object.freeze([
  'completion', 'config-timeout', 'cancel-race', 'turn-interrupt', 'connection-close',
]);
const DIRECT_LIFECYCLE_STANDALONE_CASES = Object.freeze(['host-stop', 'host-kill', 'safety-deadline']);
/** The lifecycle cases whose trigger is scoped to the one target call. */
const LIFECYCLE_PER_CALL_CASES = Object.freeze(['turn-interrupt', 'config-timeout', 'cancel-race']);

function createLifecyclePhaseCounters() {
  return {
    readiness: 'not-observed',
    requestsSent: 0,
    rpcObservations: 0,
    handlerEntries: 0,
    serverStarts: 0,
    cases: {
      'turn-interrupt': 'not-run', 'connection-close': 'not-run', 'host-stop': 'not-run', 'host-kill': 'not-run',
      'config-timeout': 'not-run', 'safety-deadline': 'not-run', completion: 'not-run', 'cancel-race': 'not-run',
    },
    caseReasons: {},
    workerOutcomes: {},
    // Per-case command expectation (the table cell the case tested) and the
    // classifier's exact-ownership verdict, so the run's output names which
    // command expectation every case tested (plan Task 5 Step 4).
    commandExpectations: {},
    workerOwned: {},
    // Per-case durable evidence that the cancellation boundary was in play
    // (race cases): the host acted on the call, or the worker settled by a
    // cancellation outcome.
    cancellationObserved: {},
    prerequisites: { holdStartedSeen: false, exactTurnConfirmed: false, hostSurvivedConnectionClose: 'not-observed' },
    activeTurnHold: { status: 'not-proven', reasonCode: 'not-run' },
    // The safety-deadline case is mechanism-only evidence, labeled as such.
    mechanismOnlySafetyDeadline: false,
    classification: 'not-observed',
    gateG3: { status: 'not-proven', reasonCode: 'not-run', evidenceRefs: [] },
    eventsBefore: 0,
    eventsAfter: 0,
    eventRecords: 0,
    uncommittedCount: 0,
    cleanup: 'not-observed',
    postReadinessBudget: 'within-budget',
  };
}

/**
 * Waits for the durable `hold-started` joined to THIS label's handler entry.
 * Returns the joined hold record, or null when the window closed first —
 * a missing prerequisite is never inferred past.
 */
async function awaitLifecycleHoldStarted(ctx, probeLabel, deadline) {
  for (;;) {
    const records = await ctx.readEvents();
    const entry = records.find((record) => record.kind === 'handler-entered' && record.phase === DIRECT_LIFECYCLE_PHASE && record.probeLabel === probeLabel) ?? null;
    if (entry) {
      const hold = records.find((record) => record.kind === 'hold-started' && record.phase === DIRECT_LIFECYCLE_PHASE && record.callNonce === entry.callNonce) ?? null;
      if (hold) return hold;
    }
    if (Date.now() >= deadline || ctx.budgetRemainingMs() <= 0) return null;
    await sleep(Math.min(LIFECYCLE_OBSERVE_POLL_MS, Math.max(1, deadline - Date.now())));
  }
}

/**
 * Observes one case's durable settlement: polls for the worker-settled
 * record joined to the call nonce until it lands or the window closes.
 */
async function observeLifecycleSettlement(ctx, callNonce, deadline) {
  for (;;) {
    const records = await ctx.readEvents();
    const worker = records.find((record) => record.kind === 'worker-settled' && record.phase === DIRECT_LIFECYCLE_PHASE && record.callNonce === callNonce) ?? null;
    if (worker) return worker;
    if (Date.now() >= deadline || ctx.budgetRemainingMs() <= 0) return null;
    await sleep(Math.min(LIFECYCLE_OBSERVE_POLL_MS, Math.max(1, deadline - Date.now())));
  }
}

/** Records one case's command expectation (the plan Task 5 Step 4 output fact). */
function recordCommandExpectation(ctx, trigger, command = 'execution-foreground') {
  const expectation = directLifecycleExpectation({ command, trigger });
  ctx.phaseCounters.commandExpectations[trigger] = expectation;
  return expectation;
}

/** Records one case's closed classification facts in the phase counters. */
function recordLifecycleCase(ctx, trigger, verdict, extras = {}) {
  const expectation = recordCommandExpectation(ctx, trigger, verdict.command);
  ctx.phaseCounters.cases[trigger] = verdict.classification;
  if (verdict.reasonCode !== null && verdict.reasonCode !== undefined) ctx.phaseCounters.caseReasons[trigger] = verdict.reasonCode;
  if (verdict.workerOutcome !== null && verdict.workerOutcome !== undefined) ctx.phaseCounters.workerOutcomes[trigger] = verdict.workerOutcome;
  ctx.phaseCounters.workerOwned[trigger] = verdict.workerOwned === true;
  Object.assign(ctx.phaseCounters, extras);
  transcript(`phase-lifecycle: the ${trigger} case is recorded ${verdict.classification}${verdict.reasonCode ? ` (${verdict.reasonCode})` : ''} — command expectation tested: ${expectation.scope} scope, worker outcomes [${expectation.workerOutcomes === null ? 'none presumed' : expectation.workerOutcomes.join(', ')}]`);
}

/** Runs ONE lifecycle case end to end and records its classification. */
async function runLifecycleCase(ctx, trigger, { holdMs = undefined, exactTurnConfirmed = false } = {}) {
  const command = 'execution-foreground';
  const probeLabel = randomBytes(16).toString('hex');
  const startSequence = (await ctx.readEvents()).length;
  ctx.beginCaseBudget();
  // The direct call runs in the background: a hold answers only at
  // settlement, and the case acts only after the DURABLE hold-started.
  // The TARGET dispatch captures no request id — the targeted release below
  // must cancel the SENTINEL's outstanding request, never the target's.
  void runDirectCallOnce(ctx, probeLabel, DIRECT_LIFECYCLE_HOLD_TOOL, ctx.threadId, holdMs !== undefined ? { holdMs } : {}).catch(() => {});
  const caseDeadline = Date.now() + Math.min(ctx.caseBudgetMs, ctx.lifecycleObserveWindowMs);
  const hold = await awaitLifecycleHoldStarted(ctx, probeLabel, caseDeadline);
  ctx.phaseCounters.prerequisites.holdStartedSeen = hold !== null;
  if (!hold) {
    // Missing prerequisite: the trigger is never sent and the case records
    // not-sent with the deepest missing link, never a settlement.
    const records = await ctx.readEvents();
    const dispatched = records.some((record) => record.kind === 'request-sent' && record.phase === DIRECT_LIFECYCLE_PHASE && record.probeLabel === probeLabel && record.state === 'sent');
    ctx.phaseCounters.cases[trigger] = 'not-sent';
    ctx.phaseCounters.caseReasons[trigger] = dispatched ? 'hold-not-started' : 'request-not-sent';
    ctx.phaseCounters.workerOwned[trigger] = false;
    const expectation = recordCommandExpectation(ctx, trigger, command);
    transcript(`phase-lifecycle: the ${trigger} case is recorded not-sent (${dispatched ? 'hold-not-started' : 'request-not-sent'}) — command expectation tested: ${expectation.scope} scope, worker outcomes [${expectation.workerOutcomes === null ? 'none presumed' : expectation.workerOutcomes.join(', ')}]`);
    return;
  }
  const endSequence = { value: (await ctx.readEvents()).length };
  // The unrelated sentinel is established BEFORE the trigger for per-call
  // cases: the hold must be ACTIVE at trigger time, or a trigger that
  // cancels every call active then would leave a later-dispatched sentinel
  // untouched and forge an isolation pass. The sentinel is a settlable
  // hold_direct whose worker writes the durable settlement the classifier
  // reads. Any failure to establish it (budget cannot cover it, dispatch
  // refused, hold never joined) leaves the case honestly unproven — never
  // settlement-observed; only a transport-level dispatch failure is flagged
  // as the 'sentinel-undispatched' contradiction.
  let sentinelLabel = null;
  let sentinelDispatchFailed = false;
  // The SENTINEL's own request-id holder: captured on the sentinel's own
  // dispatch, so the driver-ordered release cancels the sentinel's EXACT
  // outstanding JSON-RPC request id (never the target's).
  const sentinelRequest = { requestId: undefined };
  if (LIFECYCLE_PER_CALL_CASES.includes(trigger)) {
    if (ctx.budgetRemainingMs() > 5_000) {
      sentinelLabel = randomBytes(16).toString('hex');
      void runDirectCallOnce(ctx, sentinelLabel, DIRECT_LIFECYCLE_HOLD_TOOL, ctx.threadId, { holdMs: LIFECYCLE_SENTINEL_HOLD_MS }, sentinelRequest).catch(() => { sentinelDispatchFailed = true; });
      const sentinelHold = await awaitLifecycleHoldStarted(ctx, sentinelLabel, caseDeadline);
      if (sentinelHold === null) {
        transcript(`phase-lifecycle: the ${trigger} sentinel hold never joined durably; the case stays unproven`);
        sentinelLabel = null;
      } else {
        ctx.lifecycleSentinelHold = sentinelHold;
      }
    } else {
      transcript(`phase-lifecycle: the ${trigger} case budget cannot cover the sentinel; the case stays unproven`);
    }
  }
  // The trigger, per case. Infrastructure triggers record no trigger-sent
  // event: the closed trigger-sent vocabulary carries only triggers the
  // DRIVER sends toward the call, and a host signal is not one. The race
  // case's cancellation side IS the configured tool timeout, so its
  // trigger-sent outcome records the closed 'config-timeout'.
  const triggerSentOutcome = trigger === 'cancel-race' ? 'config-timeout' : trigger;
  if (trigger === 'config-timeout' || trigger === 'cancel-race' || trigger === 'safety-deadline' || trigger === 'turn-interrupt' || trigger === 'connection-close') {
    await ctx.appendDriverEvent({ kind: 'trigger-sent', callNonce: hold.callNonce, outcome: triggerSentOutcome });
  }
  if (trigger === 'turn-interrupt') {
    // The exact turn was confirmed by the controlled hold before dispatch;
    // the interrupt targets exactly that turn and its acknowledgement is
    // recorded, whatever it is.
    try {
      await ctx.session.request('turn/interrupt', { threadId: ctx.threadId, turnId: ctx.lifecycleExactTurnId }, 30_000);
      await ctx.appendDriverEvent({ kind: 'trigger-observed', callNonce: hold.callNonce, outcome: 'acknowledged', source: 'host' });
    } catch {
      await ctx.appendDriverEvent({ kind: 'trigger-observed', callNonce: hold.callNonce, outcome: 'rejected', source: 'host' });
    }
  }
  if (trigger === 'connection-close') {
    // Close ONLY the client connection; verify the host process survives.
    ctx.session.endInput();
    const hostSurvived = boundedIdentityMatches(ctx.session.pid, ctx.session.identity, Math.min(PS_INSPECTION_MS, Math.max(1, ctx.budgetRemainingMs())));
    ctx.phaseCounters.prerequisites.hostSurvivedConnectionClose = hostSurvived ? 'survived' : 'not-survived';
    // The observation outcome records what was actually observed: the host
    // acknowledged the close when it was verified alive after it; a
    // verifiably gone host observed nothing, and the closed vocabulary's
    // 'not-observed' is the accurate value.
    await ctx.appendDriverEvent({ kind: 'trigger-observed', callNonce: hold.callNonce, outcome: hostSurvived ? 'acknowledged' : 'not-observed', source: 'transport' });
    if (!hostSurvived) {
      // Host loss during the close: this observation belongs to the separate
      // host-loss case, never to client-close-with-surviving-host. The case
      // records the unproven prerequisite instead of proceeding.
      ctx.phaseCounters.cases[trigger] = 'settlement-unproven';
      ctx.phaseCounters.caseReasons[trigger] = 'host-lost-during-close';
      ctx.phaseCounters.workerOwned[trigger] = false;
      const expectation = recordCommandExpectation(ctx, trigger, command);
      transcript(`phase-lifecycle: the ${trigger} case is recorded settlement-unproven (host-lost-during-close) — command expectation tested: ${expectation.scope} scope, worker outcomes [${expectation.workerOutcomes === null ? 'none presumed' : expectation.workerOutcomes.join(', ')}]`);
      return;
    }
  }
  if (trigger === 'host-stop' || trigger === 'host-kill') {
    // The signal itself is a prerequisite: when the owning host's identity
    // cannot be verified (it is already gone or unmatchable), the trigger
    // was NOT verifiably delivered. The case records the not-sent-style
    // prerequisite — mirroring the exact-turn gate for interrupts — instead
    // of observing a window no trigger ever opened.
    const signalled = await ctx.session.signal(trigger === 'host-stop' ? 'SIGTERM' : 'SIGKILL', Math.min(PS_INSPECTION_MS, Math.max(1, ctx.budgetRemainingMs())));
    if (!signalled) {
      ctx.phaseCounters.cases[trigger] = 'not-sent';
      ctx.phaseCounters.caseReasons[trigger] = 'signal-unverified';
      ctx.phaseCounters.workerOwned[trigger] = false;
      const expectation = recordCommandExpectation(ctx, trigger, command);
      transcript(`phase-lifecycle: the ${trigger} case is recorded not-sent (signal-unverified) — command expectation tested: ${expectation.scope} scope, worker outcomes [${expectation.workerOutcomes === null ? 'none presumed' : expectation.workerOutcomes.join(', ')}]`);
      return;
    }
    transcript(`phase-lifecycle: the owning host received ${trigger === 'host-stop' ? 'SIGTERM' : 'SIGKILL'}`);
  }
  // The bounded observation window: at most the case ceiling after the
  // trigger, reading DURABLE records only. For per-call cases the window
  // also waits (bounded) for the sentinel's own settlement, so its terminal
  // is inside the case's record window before classification.
  const settled = await observeLifecycleSettlement(ctx, hold.callNonce, caseDeadline);
  transcript(`phase-lifecycle: the ${trigger} observation ${settled !== null ? `recorded the worker settlement (${settled.outcome})` : 'closed without a durable worker settlement'}`);
  // Driver-ordered sentinel release: when the target's cancellation boundary
  // is durably observed (the worker settled cancelled/timed-out), the driver
  // explicitly releases the sentinel — declaring the release (trigger-sent
  // for the sentinel's own call), marking it acknowledged (trigger-observed),
  // and sending notifications/cancelled for the sentinel's outstanding
  // request. The sentinel's settlement must then land after this marker.
  const boundaryObserved = settled !== null && (settled.outcome === 'cancelled' || settled.outcome === 'timed-out');
  if (sentinelLabel !== null && boundaryObserved && ctx.lifecycleSentinelHold) {
    // Driver-ordered sentinel release: cancel the sentinel's EXACT
    // outstanding request id. Only a VERIFIED cancellation (the targeted
    // notifications/cancelled frame was written for that exact id) is
    // recorded as the release marker — failure or absence leaves the marker
    // unwritten and the case unproven.
    const released = sentinelRequest.requestId !== undefined
      ? ctx.session.cancelRequestById(sentinelRequest.requestId)
      : false;
    if (released) {
      await ctx.appendDriverEvent({ kind: 'trigger-sent', callNonce: ctx.lifecycleSentinelHold.callNonce, outcome: 'turn-interrupt' });
      await ctx.appendDriverEvent({ kind: 'trigger-observed', callNonce: ctx.lifecycleSentinelHold.callNonce, outcome: 'acknowledged', source: 'driver' });
      transcript('phase-lifecycle: the sentinel release was verified and marked acknowledged (notifications/cancelled)');
    } else {
      transcript('phase-lifecycle: the sentinel release could not be verified; no release marker was written');
    }
  }
  if (ctx.lifecycleSentinelHold !== null && ctx.lifecycleSentinelHold !== undefined) {
    const sentinelSettled = await observeLifecycleSettlement(ctx, ctx.lifecycleSentinelHold.callNonce, caseDeadline);
    transcript(`phase-lifecycle: the sentinel observation ${sentinelSettled !== null ? `recorded the sentinel settlement (${sentinelSettled.outcome})` : 'closed without a durable sentinel settlement'}`);
    ctx.lifecycleSentinelHold = null;
  }
  endSequence.value = (await ctx.readEvents()).length;
  const reduced = await ctx.reduceNow();
  const records = await ctx.readEvents();
  // The race boundary, from durable records only: the configured
  // cancellation was in play when the worker itself settled by a
  // cancellation outcome ('cancelled' or the host timeout's 'timed-out').
  // Generic RPC errors and rejections are request failures, not
  // cancellation-specific evidence — the durable vocabulary cannot
  // distinguish them today, so only the cancellation-outcome worker
  // settlement is honest boundary proof.
  let cancellationObserved = false;
  if (trigger === 'cancel-race') {
    cancellationObserved = settled !== null && (settled.outcome === 'cancelled' || settled.outcome === 'timed-out');
    ctx.phaseCounters.cancellationObserved[trigger] = cancellationObserved;
    transcript(`phase-lifecycle: the ${trigger} cancellation boundary was ${cancellationObserved ? 'observed on the durable record' : 'never observed'}`);
  }
  const verdict = classifyDirectLifecycleCase({
    records, reduced, probeLabel, phase: DIRECT_LIFECYCLE_PHASE, command, trigger,
    exactTurnConfirmed, sentinelLabel, sentinelDispatchFailed, cancellationObserved,
    windowStart: startSequence, windowEnd: endSequence.value,
  });
  recordLifecycleCase(ctx, trigger, verdict);
}

/** The lifecycle schedule: the selected cases in dependency-safe order. */
async function runLifecycleSchedule(ctx) {
  const threadHash = hashProbeValue(ctx.runNonce, ctx.threadId);
  for (const trigger of ctx.lifecycleCases) {
    if (trigger === 'turn-interrupt') {
      // The exact-turn prerequisite: the controlled active-turn hold must be
      // observed BEFORE any hold dispatch. Missing prerequisite records the
      // case not-sent — no hold is dispatched and no trigger is sent.
      const hold = await attemptIdentityHold(ctx, threadHash, ctx.runNonce);
      ctx.phaseCounters.activeTurnHold = hold.status === 'observed'
        ? { status: 'observed', reasonCode: null }
        : { status: 'not-proven', reasonCode: hold.reasonCode };
      if (hold.status !== 'observed') {
        ctx.phaseCounters.cases['turn-interrupt'] = 'not-sent';
        ctx.phaseCounters.caseReasons['turn-interrupt'] = 'turn-not-confirmed';
        ctx.phaseCounters.workerOwned['turn-interrupt'] = false;
        const expectation = recordCommandExpectation(ctx, 'turn-interrupt');
        transcript(`phase-lifecycle: no controlled active turn exists; the turn-interrupt case is recorded not-sent — command expectation tested: ${expectation.scope} scope, worker outcomes [${expectation.workerOutcomes.join(', ')}]`);
        continue;
      }
      ctx.lifecycleExactTurnId = hold.turnId;
      await runLifecycleCase(ctx, 'turn-interrupt', { exactTurnConfirmed: true });
      // Settle the controlled turn hold so later cases start from a quiet thread.
      await settleIdentityHold(ctx, hold, threadHash);
      continue;
    }
    if (trigger === 'connection-close') {
      await runLifecycleCase(ctx, 'connection-close');
      continue;
    }
    if (trigger === 'host-stop' || trigger === 'host-kill') {
      await runLifecycleCase(ctx, trigger);
      continue;
    }
    if (trigger === 'safety-deadline') {
      ctx.phaseCounters.mechanismOnlySafetyDeadline = true;
      await runLifecycleCase(ctx, 'safety-deadline');
      continue;
    }
    await runLifecycleCase(ctx, trigger, {
      holdMs: trigger === 'completion' ? LIFECYCLE_COMPLETION_HOLD_MS
        : trigger === 'cancel-race' ? LIFECYCLE_CANCEL_RACE_HOLD_MS
          : undefined,
    });
  }
}

/** The lifecycle classification: strongest case plus the G3 gate. */
async function classifyLifecycle(ctx) {
  const phaseCounters = ctx.phaseCounters;
  let classification = 'not-run';
  for (const cell of Object.values(phaseCounters.cases)) {
    if (DIRECT_LIFECYCLE_CASE_PRECEDENCE.indexOf(cell) >= 0 && DIRECT_LIFECYCLE_CASE_PRECEDENCE.indexOf(cell) < DIRECT_LIFECYCLE_CASE_PRECEDENCE.indexOf(classification)) {
      classification = cell;
    }
  }
  phaseCounters.classification = classification;
  // The reconciliation assessment: the committed synthetic-worker tests prove
  // exact ownership and bounded settlement of the LOCAL reconciliation
  // mechanism; host loss is outside its coverage by construction (no durable
  // writer survives). Mechanism evidence with limits — it never upgrades the
  // gate by itself.
  const reconciliation = assessDirectReconciliationStrategy({
    exactOwnershipProven: true,
    boundedSettlementProven: true,
    hostLossSettlementDemonstrated: false,
  });
  phaseCounters.reconciliation = reconciliation;
  const cases = Object.entries(phaseCounters.cases)
    // A trigger this invocation never selected is an ABSENT case for the
    // gate, not a present one: coverage is judged on the cases actually run.
    .filter(([, caseClassification]) => caseClassification !== 'not-run')
    .map(([trigger, caseClassification]) => ({
      trigger,
      command: 'execution-foreground',
      classification: caseClassification,
      workerOutcome: phaseCounters.workerOutcomes[trigger] ?? null,
      // The classifier's exact-ownership verdict for the case, recorded at
      // classification time — not an inference from an outcome being present.
      workerOwned: phaseCounters.workerOwned[trigger] === true,
      sent: !['not-sent', 'not-observed', 'not-run'].includes(caseClassification),
      reasonCode: phaseCounters.caseReasons[trigger] ?? null,
    }));
  phaseCounters.gateG3 = classifyDirectGateG3({ cases, reconciliation });
}

/** The strongest recorded case classification (closed precedence). */
const DIRECT_LIFECYCLE_CASE_PRECEDENCE = Object.freeze([
  'settlement-observed', 'behavior-confirmed', 'expectation-mismatch', 'settlement-unproven',
  'not-sent', 'not-observed', 'not-run',
]);

/**
 * The bounded lifecycle probe (plan Task 5). `cases` selects the case list:
 * omitted, the default preserving set (the connection-close case runs LAST);
 * otherwise exactly one standalone case (`host-stop`, `host-kill`, or the
 * mechanism-only `safety-deadline`), which gets its own fresh isolated
 * session and, for the injected ceiling, the spawn-time safety-deadline env.
 * @param {{codexPath: string, sourceCodexHome: string, runDirectory: string, directCallDeadlineMs?: number, caseBudgetMs?: number, turnSetupBudgetMs?: number, lifecycleObserveWindowMs?: number, cases?: string[]}} input
 * @returns {Promise<object>} the redacted phase/outcome counters
 */
export async function runDirectLifecycleProbe(input) {
  const selected = input.cases ?? [...DIRECT_LIFECYCLE_DEFAULT_CASES];
  if (!Array.isArray(selected) || selected.length === 0
    || !selected.every((trigger) => DIRECT_LIFECYCLE_TRIGGERS.includes(trigger))) {
    throw directError('DIRECT_DRIVER_USAGE_INVALID', 'cases must be a non-empty list of closed lifecycle triggers.');
  }
  const standaloneSelected = selected.filter((trigger) => DIRECT_LIFECYCLE_STANDALONE_CASES.includes(trigger));
  if (standaloneSelected.length > 0 && selected.length !== 1) {
    throw directError('DIRECT_DRIVER_USAGE_INVALID', 'a destructive or injected lifecycle case requires its own single-case invocation.');
  }
  // Execution order: every connection-preserving case before the final
  // connection-close case; a single-case selection runs alone.
  const order = [...DIRECT_LIFECYCLE_DEFAULT_CASES.filter((trigger) => selected.includes(trigger)), ...standaloneSelected];
  return runDirectProbeCase(input, {
    mode: 'lifecycle',
    phase: DIRECT_LIFECYCLE_PHASE,
    createPhaseCounters: createLifecyclePhaseCounters,
    discoverServerBeforeSchedule: true,
    directCallDeadlineMs: input.directCallDeadlineMs ?? LIFECYCLE_DIRECT_CALL_DEADLINE_MS,
    turnSetupBudgetMs: input.turnSetupBudgetMs,
    lifecycleObserveWindowMs: input.lifecycleObserveWindowMs,
    sessionOptions: {
      holdServerRequestPattern: IDENTITY_APPROVAL_REQUEST_PATTERN,
      retainNotificationPattern: IDENTITY_TURN_NOTIFICATION_PATTERN,
    },
    toolTimeoutSec: LIFECYCLE_CONFIG_TIMEOUT_SEC,
    serverEnv: standaloneSelected.length === 1 && standaloneSelected[0] === 'safety-deadline'
      ? { DIRECT_PROBE_HOLD_SAFETY_DEADLINE_MS: String(LIFECYCLE_SAFETY_DEADLINE_MS) }
      : undefined,
    runSchedule: runLifecycleSchedule,
    classify: classifyLifecycle,
    lifecycleCases: order,
  });
}

if (runningAsMain) {
  const args = parseArguments(process.argv.slice(2));
  if (args.mode !== 'reachability' && args.mode !== 'identity' && args.mode !== 'lifecycle') {
    process.stderr.write('direct driver failed: DIRECT_DRIVER_USAGE_INVALID: usage: driver.mjs --mode reachability|identity|lifecycle --codex <path> --run-directory <dir> [--source-codex-home <dir>] [--cases <trigger>]\n');
    process.exit(1);
  }
  try {
    const probeInput = {
      codexPath: args.codex,
      sourceCodexHome: args.sourceCodexHome ?? join(homedir(), '.codex'),
      runDirectory: args.runDirectory,
    };
    const counters = args.mode === 'identity'
      ? await runDirectIdentityProbe(probeInput)
      : args.mode === 'lifecycle'
        ? await runDirectLifecycleProbe(args.cases !== undefined
          ? { ...probeInput, cases: args.cases.split(',').map((entry) => entry.trim()) }
          : probeInput)
        : await runDirectReachabilityProbe(probeInput);
    process.stdout.write(`${JSON.stringify(counters, null, 2)}\n`);
    process.exitCode = 0;
  } catch (error) {
    // CLI boundary: only the closed error code crosses it. Raw messages can
    // embed absolute source-home and run-directory paths, so they are dropped
    // here (retained nowhere, not even in ephemeral storage).
    process.stderr.write(`direct driver failed: ${closedErrorCode(error)}\n`);
    process.exitCode = 1;
  }
}
