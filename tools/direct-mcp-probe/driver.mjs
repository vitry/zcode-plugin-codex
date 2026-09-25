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
  readDirectProbeEvents,
  reduceDirectProbeLog,
} from './observer.mjs';

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
  const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  // Spawn-time identity capture; the case budget has not started yet, so
  // only the inspection tool's own cap bounds it.
  const identity = boundedCaptureIdentity(child.pid, Number.MAX_SAFE_INTEGER);
  let nextId = 1;
  /** @type {Map<number, {resolve: (value: any) => void, reject: (error: Error) => void, timer: NodeJS.Timeout, method: string}>} */
  const pending = new Map();
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
      if (frame.error) entry.reject(directError('PROBE_APP_SERVER_REQUEST_FAILED', `The app-server rejected ${entry.method}.`));
      else entry.resolve(frame.result ?? {});
    } else if (frame && typeof frame === 'object' && typeof frame.method === 'string' && frame.id !== undefined) {
      // Server-to-client request: benign bounded response.
      const result = /elicitation/i.test(frame.method) ? { action: 'cancel' } : {};
      try { child.stdin?.write(`${JSON.stringify({ id: frame.id, result })}\n`); } catch { /* session is ending */ }
    } else if (frame && typeof frame === 'object' && typeof frame.method === 'string') {
      if (APP_SERVER_DELTA_NOTIFICATION.test(frame.method)) {
        notificationsDeltaCount += 1;
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
    /** @param {string} method @param {Record<string, unknown>} params @param {number} [timeoutMs] */
    request(method, params, timeoutMs = APP_SERVER_REQUEST_DEADLINE_MS) {
      const id = nextId++;
      return new Promise((resolveRequest, rejectRequest) => {
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
    },
    /** @param {{method: string, params: Record<string, unknown>}} value */
    notify(value) {
      try { writeFrame(value); } catch { /* session is ending */ }
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
 * server reads. This is the probe's OWN disposable descriptor — never a
 * production plugin descriptor.
 * @param {string} output @param {string} serverPath
 */
async function buildDirectProbeMarketplace(output, serverPath) {
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
        env_vars: [...DIRECT_SERVER_ENV_VARS],
        startup_timeout_sec: 10,
        tool_timeout_sec: 30,
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
      throw directError('DIRECT_DRIVER_USAGE_INVALID', 'usage: driver.mjs --mode reachability --codex <path> --run-directory <dir> [--source-codex-home <dir>]');
    }
    if (flag === '--mode') parsed.mode = value;
    else if (flag === '--codex') parsed.codex = value;
    else if (flag === '--run-directory') parsed.runDirectory = value;
    else if (flag === '--source-codex-home') parsed.sourceCodexHome = value;
    else throw directError('DIRECT_DRIVER_USAGE_INVALID', `usage: driver.mjs --mode reachability --codex <path> --run-directory <dir> (unknown ${flag})`);
  }
  return parsed;
}

/**
 * The bounded reachability schedule. Hard failures throw; the honest
 * classification is derived only from the authenticated reduction of the
 * durable log. Every spawn re-pins the canonical binary (path, device/inode,
 * and content digest); cleanup never signals a process whose captured start
 * identity changed. The direct-call deadline and the single post-readiness
 * case ceiling default to the plan's bounded values and may be tightened by
 * the caller (injected-clock seams the suite uses to test the unanswered-call
 * and ceiling paths without waiting out the real budgets).
 * @param {{codexPath: string, sourceCodexHome: string, runDirectory: string, directCallDeadlineMs?: number, caseBudgetMs?: number}} input
 * @returns {Promise<object>} the redacted phase/outcome counters
 */
export async function runDirectReachabilityProbe(input) {
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
    mode: 'reachability',
    codexVersion,
    phases: {
      [DIRECT_PROBE_PHASE]: {
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
      },
    },
  };
  const phaseCounters = counters.phases[DIRECT_PROBE_PHASE];
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

    await buildDirectProbeMarketplace(marketplaceRoot, serverModulePath);
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
      ZCODE_DIRECT_MCP_PROBE_PHASE: DIRECT_PROBE_PHASE,
      DIRECT_PROBE_OWNER_SECRET: ownerSecret,
    };

    session = startAppServerSession({ command: await recheckCodex(), args: ['app-server'], env: probeEnv, cwd: runDirectory });
    trackedProcesses.set(session.pid, session.identity);
    transcript('phase-reachability: app-server session started and tracked');
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
      transcript(`phase-reachability: mcpServerStatus/list ${readinessState === 'discovered' ? 'discovered the probe server' : 'did not list the probe server'}`);
    } catch (statusError) {
      readinessState = 'failed';
      transcript(`phase-reachability: mcpServerStatus/list failed (${errorCode(statusError) || 'error'})`);
    }
    phaseCounters.readiness = readinessState;
    await appendDirectProbeEvent({
      runDirectory, runNonce, phase: DIRECT_PROBE_PHASE, ownerSecret,
      event: { kind: 'readiness-observed', state: readinessState, source: 'host' },
    });
    // The post-readiness ceiling starts here: everything observation-bearing
    // after this point — the direct call, the durable join, the disposal
    // waits, and the bounded cleanup commands — shares this one deadline.
    postReadinessDeadline = Date.now() + caseBudgetMs;

    // The direct call on the SAME connection, with the durable event position
    // snapshotted before and after the request.
    const probeLabel = randomBytes(16).toString('hex');
    if (budgetRemainingMs() <= 0) {
      // The ceiling expired before dispatch: the request is recorded honestly
      // as not-sent and the observation as not-observed — never a pass. The
      // durable log is still read so any observed server startup reaches the
      // cleanup verification.
      await appendDirectProbeEvent({
        runDirectory, runNonce, phase: DIRECT_PROBE_PHASE, ownerSecret,
        event: { kind: 'request-sent', probeLabel, tool: DIRECT_PROBE_TOOL_NAME, state: 'not-sent' },
      });
      await appendDirectProbeEvent({
        runDirectory, runNonce, phase: DIRECT_PROBE_PHASE, ownerSecret,
        event: { kind: 'rpc-observed', probeLabel, outcome: 'not-observed' },
      });
      phaseCounters.rpcObservations = 1;
      const records = await readDirectProbeEvents({ runDirectory, runNonce });
      phaseCounters.handlerEntries = records.filter((record) => record.kind === 'handler-entered').length;
      phaseCounters.serverStarts = records.filter((record) => record.kind === 'server-started').length;
      phaseCounters.eventsAfter = records.length;
      noteBudgetExhausted();
      transcript('phase-reachability: the post-readiness ceiling expired before dispatch; the call is recorded not-sent');
    } else {
      await appendDirectProbeEvent({
        runDirectory, runNonce, phase: DIRECT_PROBE_PHASE, ownerSecret,
        event: { kind: 'request-sent', probeLabel, tool: DIRECT_PROBE_TOOL_NAME, state: 'sent' },
      });
      phaseCounters.requestsSent = 1;
      phaseCounters.eventsBefore = (await readDirectProbeEvents({ runDirectory, runNonce })).length;

      const callDeadlineMs = Math.max(1, Math.min(directCallDeadlineMs, budgetRemainingMs()));
      let rpcOutcome = 'not-observed';
      try {
        const response = await session.request('mcpServer/tool/call', {
          server: DIRECT_PROBE_SERVER_NAME,
          threadId,
          tool: DIRECT_PROBE_TOOL_NAME,
          arguments: { probeLabel },
        }, callDeadlineMs);
        rpcOutcome = response?.isError === true ? 'error-result' : 'success-result';
        transcript(`phase-reachability: the direct call answered (${rpcOutcome})`);
      } catch (callError) {
        const code = errorCode(callError);
        // An answered JSON-RPC rejection is an observation; a request that never
        // received an answer stays honestly not-observed.
        rpcOutcome = code === 'PROBE_APP_SERVER_REQUEST_FAILED' ? 'rpc-rejected' : 'not-observed';
        transcript(`phase-reachability: the direct call did not answer successfully (${code || 'error'})`);
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
        if (budgetRemainingMs() <= 0) {
          noteBudgetExhausted();
          break;
        }
        await sleep(Math.min(DIRECT_ENTRY_JOIN_POLL_MS, budgetRemainingMs()));
      }
      await appendDirectProbeEvent({
        runDirectory, runNonce, phase: DIRECT_PROBE_PHASE, ownerSecret,
        event: callNonce === undefined
          ? { kind: 'rpc-observed', probeLabel, outcome: rpcOutcome }
          : { kind: 'rpc-observed', probeLabel, callNonce, outcome: rpcOutcome },
      });
      phaseCounters.rpcObservations = 1;
    }

    // Server process discovery (while the host is alive): the spawned server
    // is the host's child, so exactly one process-table entry whose parent is
    // the tracked host pid is this run's server. Its captured start identity
    // gates any cleanup signal. The inspection is bounded by the remaining
    // post-readiness case time and is skipped as unobserved when that ceiling
    // is exhausted (cleanup then fails closed on any durable server start).
    if (budgetRemainingMs() <= 0) {
      noteBudgetExhausted();
      transcript('phase-reachability: the case ceiling is exhausted; server process discovery is skipped as unobserved');
    } else {
      const matches = listProbeServerProcesses(serverModulePath, Math.min(PS_INSPECTION_MS, budgetRemainingMs()));
      if (matches === null) {
        transcript('phase-reachability: process inspection unavailable; the server pid stays unresolved');
      } else {
        const mine = matches.filter((entry) => entry.ppid === session.pid);
        if (mine.length > 1) throw directError('PROBE_SERVER_PID_AMBIGUOUS', 'More than one probe server process belongs to this run; refusing to guess.');
        if (mine.length === 1) {
          serverPid = mine[0].pid;
          serverIdentity = boundedCaptureIdentity(serverPid, budgetRemainingMs());
        }
      }
    }
    transcript(`phase-reachability: server process ${serverPid === null ? 'not identified at discovery' : 'identified and tracked'}`);
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
        runDirectory, runNonce, ownerSecret, ownerPid: serverPid, expectedFinalState: finalAppend.commit,
      });
      const records = await readDirectProbeEvents({ runDirectory, runNonce });
      const probeLabelRecord = records.find((record) => record.kind === 'request-sent' && record.state === 'sent') ?? null;
      if (probeLabelRecord) {
        const reachability = directReachabilityCase({ records, reduced, probeLabel: probeLabelRecord.probeLabel });
        phaseCounters.classification = reachability.classification;
        phaseCounters.gateG1 = classifyDirectGateG1(reachability);
      }
      phaseCounters.eventRecords = records.length;
      phaseCounters.uncommittedCount = reduced.uncommittedCount;
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

if (runningAsMain) {
  const args = parseArguments(process.argv.slice(2));
  if (args.mode !== 'reachability') {
    process.stderr.write('direct driver failed: DIRECT_DRIVER_USAGE_INVALID: usage: driver.mjs --mode reachability --codex <path> --run-directory <dir> [--source-codex-home <dir>]\n');
    process.exit(1);
  }
  try {
    const counters = await runDirectReachabilityProbe({
      codexPath: args.codex,
      sourceCodexHome: args.sourceCodexHome ?? join(homedir(), '.codex'),
      runDirectory: args.runDirectory,
    });
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
