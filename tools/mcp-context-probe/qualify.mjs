// @ts-nocheck
/**
 * Disposable real-Host qualification driver for the Codex MCP invocation
 * context. It canonicalizes and pins an externally supplied Codex binary,
 * copies only auth.json into an isolated home, installs probe-only
 * marketplaces, drives the exact scripted matrix against real `codex exec`
 * conversations, and finally reduces the durable event log into
 * `<run>/result.json`. It never touches the real Codex home beyond reading
 * auth.json, never logs credentials or identity values, and never resolves
 * the binary through PATH.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, rm, stat, realpath, chmod, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildProbeMarketplace } from './build-fixture.mjs';
import {
  appendProbeEvent,
  probeEventPaths,
  readProbeEvents,
  reduceProbeResult,
} from './observer.mjs';

const CODEX_PLUGIN_SELECTOR = 'zcode-mcp-context-probe@zcode-mcp-probe';
const CODEX_MARKETPLACE_NAME = 'zcode-mcp-probe';
const SUBPROCESS_DEADLINE_MS = 180_000;
// Host conversations are long, multi-turn scripted model sessions: on the
// real 0.154.0 host the scripted matrix's first durable capture alone landed
// ~140s into the conversation, so the CLI-command outer deadline cannot bound
// a Host spawn without killing a healthy conversation. Host spawns get their
// own explicit outer deadline; the signal/timeout ceilings (10s/30s) and the
// output bound remain the protocol assertions.
const HOST_CONVERSATION_DEADLINE_MS = 600_000;
const MAXIMUM_OUTPUT_BYTES = 4 * 1024 * 1024;
const SIGNAL_GRACE_MS = 10_000;
const HOST_TIMEOUT_GRACE_MS = 30_000;
// The fast fixture configures a two-second tool timeout; the durable gap
// between the held call's start and its settlement must be attributable to
// that configured timeout — within only a bounded scheduling tolerance for
// when the Host started its timer relative to the server handler — so an
// unrelated abort at any other moment can never qualify.
const FAST_TOOL_TIMEOUT_MS = 2_000;
const TOOL_TIMEOUT_SCHEDULING_TOLERANCE_MS = 250;
// At or above the probe server's disposal grace, so lingering servers get a
// natural exit window before cleanup signals anything.
const SERVER_DISPOSAL_WAIT_MS = 8_000;
// The scripted matrix conversation produces five captures; the state-machine
// step-2 Root resume adds the sixth (same thread, new turn).
const MATRIX_CAPTURES_EXPECTED = 5;
// Bounded, in-memory excerpts of error/item frames used solely to verify that
// a negative-control transcript references the probe tool or server; they are
// never printed, persisted, or included in error messages.
const FRAME_EXCERPT_MAX_CHARS = 200;
const FRAME_EXCERPTS_MAX = 32;
const PROBE_TOOL_REFERENCE = /capture_context|zcode-mcp-context-probe/i;

const MATRIX_PROMPT = 'Use $zcode-mcp-context-probe:context. Call capture_context once in Root. Spawn one Child, have it call capture_context, wait for it, then follow up that exact Child and have it call capture_context again. Then spawn two new Children concurrently and have each call capture_context once. Wait for both. Do not call any other MCP tool.';
const NEGATIVE_CONTROL_PROMPT = 'Use $zcode-mcp-context-probe:context and call capture_context exactly once in Root. Do not spawn a Child.';
const ROOT_RESUME_PROMPT = 'Use $zcode-mcp-context-probe:context and call capture_context exactly once in Root. Do not spawn a Child.';
const HOLD_PROMPT = 'Use $zcode-mcp-context-probe:context and call hold_until_cancelled exactly once. Wait for that tool and do nothing else.';

/** @param {string} code @param {string} message */
function probeError(code, message) {
  const error = /** @type {Error & {code:string}} */ (new Error(message));
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

/** Redacted transcript sink: identifiers and prompts never reach it. */
function transcript(message) {
  if (runningAsMain) process.stdout.write(`[mcp-context-probe] ${message}\n`);
}

/**
 * Waits until predicate() resolves truthy, polling at 250 ms.
 * @param {() => Promise<boolean|undefined>} predicate
 * @param {number} deadlineMs @param {string} timeoutMessage
 */
async function waitUntil(predicate, deadlineMs, timeoutMessage) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw probeError('PROBE_WAIT_TIMEOUT', timeoutMessage);
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
}

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
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return true;
}

/**
 * Signals a recorded process only when its captured start identity still
 * matches; a recycled or unverifiable PID is left alone (redacted skip).
 * @param {number} pid @param {string} signalName @param {number} graceMs @param {string|null} identity
 */
async function stopProcess(pid, signalName, graceMs, identity = null) {
  if (!isProcessAlive(pid)) return true;
  if (!cleanupTargetMatchesIdentity(pid, identity)) {
    transcript(`cleanup: skipping a recorded pid whose start identity changed or is unverifiable`);
    return true;
  }
  try { process.kill(pid, /** @type {any} */ (signalName)); } catch (error) {
    // Only ESRCH means the process is already gone; a refusal such as EPERM
    // must fail cleanup instead of silently leaving the process alive.
    if (error && /** @type {any} */ (error).code === 'ESRCH') return true;
    transcript('cleanup: signalling a verified tracked process failed');
    return false;
  }
  return waitForExit(pid, graceMs);
}

/**
 * Resolves the process-inspection executable from a fixed absolute candidate
 * list, never through PATH: a caller's PATH without `ps`, or with a shadowing
 * executable, must not change identity capture behavior. Returns the first
 * candidate that is a regular executable file, or null when none qualifies.
 */
const PROCESS_INSPECTION_CANDIDATES = ['/bin/ps', '/usr/bin/ps'];

export function resolveProcessInspectionExecutable() {
  for (const candidate of PROCESS_INSPECTION_CANDIDATES) {
    try {
      const stats = lstatSync(candidate);
      if (stats.isFile() && (stats.mode & 0o111) !== 0) return candidate;
    } catch { /* try the next candidate */ }
  }
  return null;
}

/**
 * Captures a collision-resistant process identity: start time alone has only
 * one-second resolution, so a PID reused within the same second would
 * compare equal. The identity therefore combines the kernel-provided start
 * time, parent pid, and command name — a recycled PID must match all three
 * to ever be signalled.
 * @param {number|undefined} pid
 */
export function captureProcessIdentity(pid) {
  if (!pid || pid <= 0 || process.platform === 'win32') return null;
  const executable = resolveProcessInspectionExecutable();
  if (!executable) return null;
  const listed = spawnSync(executable, ['-p', String(pid), '-o', 'lstart=,ppid=,comm='], { encoding: 'utf8', timeout: 5_000 });
  if (listed.status !== 0) return null;
  // ps prints the requested fields on one whitespace-separated line; the
  // command name and parent pid are the final two tokens and the start time
  // (which itself contains spaces) is everything before them.
  const tokens = listed.stdout.trim().split(/\s+/);
  if (tokens.length < 3) return null;
  const comm = tokens.at(-1);
  const ppid = tokens.at(-2);
  const lstart = tokens.slice(0, -2).join(' ');
  if (!lstart || !ppid || !comm) return null;
  return `${lstart}|ppid=${ppid}|comm=${comm}`;
}

/**
 * Decides whether a recorded PID may still be signalled during cleanup: the
 * process must be alive AND its current start identity must equal the one
 * captured at spawn. Any mismatch or unverifiable identity fails closed so a
 * recycled PID is never signalled.
 * @param {number|undefined} pid @param {string|null} identity
 */
export function cleanupTargetMatchesIdentity(pid, identity) {
  if (!isProcessAlive(pid)) return false;
  if (!identity) return false;
  return captureProcessIdentity(pid) === identity;
}

/**
 * Requires a live, non-null, currently-verifiable identity before any signal:
 * a platform or host without identity capture fails closed instead of
 * signalling an unverified PID.
 * @param {number} pid @param {string|null} identity
 */
export function assertProcessIdentity(pid, identity) {
  const current = captureProcessIdentity(pid);
  if (!identity || !current || current !== identity) {
    throw probeError('PROBE_PROCESS_IDENTITY', `Recorded process ${pid} no longer matches its start identity; refusing to signal.`);
  }
}

/**
 * Correlates the durable captures with the authoritative Host facts the
 * driver observed itself: the matrix phase must carry the full capture set
 * (the five conversation captures plus the state-machine step-2 Root-resume
 * capture), the Root-resume capture must sit on the Root capture's trusted
 * thread, and its turn must be new. The driver resumed the exact Root
 * conversation it parsed from stdout and observed exit 0. Recorded 0.154.0
 * fact: the stdout `thread.started` id (the id `exec resume` consumes) and
 * the trusted `_meta` turn-metadata thread id are distinct namespaces, so
 * the same-thread proof is hash-based between durable captures and no
 * cross-namespace value equality is ever assumed.
 * @param {{event:object}[]} records
 */
export function assertAuthoritativeIdentityCorrelation(records) {
  let phase = null;
  /** @type {object[]} */
  const matrix = [];
  for (const record of records) {
    const event = record.event;
    if (event.kind === 'phase-observed' && event.observed) phase = event.phase;
    else if (event.kind === 'capture-started' && phase === 'matrix') matrix.push(event);
  }
  if (matrix.length !== MATRIX_CAPTURES_EXPECTED + 1
    || matrix[0].threadHash !== matrix[MATRIX_CAPTURES_EXPECTED].threadHash
    || matrix[0].turnHash === matrix[MATRIX_CAPTURES_EXPECTED].turnHash) {
    throw probeError('PROBE_CONTEXT_MISMATCH', 'The durable captures do not correlate with the authoritative Root thread identity.');
  }
}

/**
 * Requires the negative-control transcript to show the recorded tool-
 * unavailable shape: zero nested `mcp_tool_call` items and at least one
 * bounded excerpt that references the probe tool or server AND comes from a
 * genuine failure surface. The failure surfaces are exactly: a top-level
 * `error` frame; an `item.*` frame whose nested `item.type` is `error`; or
 * an `item.*` frame whose nested `item.status` is `failed` or `error`. A
 * successful or neutral `item.*` frame never satisfies the gate on its own,
 * and a transient model or network error never mentions the probe tool, so
 * the control must prove the model actually attempted the unavailable tool
 * rather than failing for an unrelated reason — or that an MCP call was
 * misclassified. Excerpts and their source tags live in memory only — never
 * printed, persisted, or included in error messages — so nothing identifying
 * is retained.
 * @param {{frameTypes: Map<string, number>, nestedItemTypes?: Map<string, number>, excerpts?: {frameType:string, nestedItemType:string|null, itemStatus:string|null, excerpt:string}[]}} account @param {string} label
 */
export function assertToolUnavailableTranscript(account, label) {
  const mcpToolCallItems = account.nestedItemTypes?.get('mcp_tool_call') ?? 0;
  const errorFrames = account.frameTypes.get('error') ?? 0;
  const matchedFailureExcerpts = (account.excerpts ?? []).filter((entry) => {
    const failureSource = entry.frameType === 'error'
      || entry.nestedItemType === 'error'
      || entry.itemStatus === 'failed'
      || entry.itemStatus === 'error';
    return failureSource && PROBE_TOOL_REFERENCE.test(entry.excerpt);
  }).length;
  if (mcpToolCallItems !== 0 || matchedFailureExcerpts < 1) {
    throw probeError(
      'PROBE_NEGATIVE_CONTROL_SHAPE',
      `${label}: the transcript does not show the tool-unavailable shape (zero mcp_tool_call items and a failing error/item excerpt referencing the probe tool or server); observed mcp_tool_call items=${mcpToolCallItems}, error=${errorFrames}, matching failure excerpts=${matchedFailureExcerpts}.`,
    );
  }
}

/**
 * Requires the resume Host's stdout to re-emit exactly one `thread.started`
 * frame whose thread id equals the id the driver parsed from the original
 * conversation and resumed with — the CLI-level same-thread evidence, taken
 * entirely within the stdout namespace. (The recorded namespace fact only
 * separates stdout ids from the trusted `_meta` ids; it never says the
 * resume's stdout id differs from the original stdout id.) Without this
 * check a continuation with a missing, duplicated, or changed stdout id
 * could pass solely on `_meta` hash equality. Messages carry counts and
 * equality only — never the id values.
 * @param {{threadIds: string[]}} account @param {string} rootThreadId
 */
export function assertResumeThreadIdentity(account, rootThreadId) {
  if (account.threadIds.length !== 1) {
    throw probeError('PROBE_HOST_FRAMES', `phase-matrix-resume: expected exactly one thread.started, observed ${account.threadIds.length}.`);
  }
  if (account.threadIds[0] !== rootThreadId) {
    throw probeError('PROBE_HOST_FRAMES', 'phase-matrix-resume: the resume thread.started does not match the parsed Root thread id.');
  }
}

/**
 * @param {string} text
 * @returns {unknown|null} the last JSON value parseable from the output
 */
function parseLastJsonValue(text) {
  try { return JSON.parse(text); } catch { /* fall through to a reverse line scan */ }
  for (const line of text.split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
    try { return JSON.parse(trimmed); } catch { /* keep scanning */ }
  }
  return null;
}

/**
 * Bounded, deadline-bounded process capture with strict stdout-line handling.
 * @param {string} command @param {string[]} args
 * @param {{cwd?:string, env:NodeJS.ProcessEnv, deadlineMs?:number, onStdoutLine?:(line:string)=>void}} options
 */
function runBounded(command, args, options) {
  const deadlineMs = options.deadlineMs ?? SUBPROCESS_DEADLINE_MS;
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const startedAt = Date.now();
  let capturedBytes = 0;
  let overflow = false;
  let timedOut = false;
  let lineBuffer = '';
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
      if (lineBuffer.length > 0 && !overflow) {
        options.onStdoutLine?.(lineBuffer);
        lineBuffer = '';
      }
      resolvePromise({
        code, signal: signalName, timedOut, overflow,
        stdout: stdoutParts.join('\n'), stderr: stderrParts.join(''),
        durationMs: Date.now() - startedAt,
        pid: child.pid ?? -1,
      });
    });
  });
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    if (overflow) return;
    capturedBytes += Buffer.byteLength(chunk);
    if (capturedBytes > MAXIMUM_OUTPUT_BYTES) {
      overflow = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      return;
    }
    lineBuffer += chunk;
    let newline = lineBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = lineBuffer.slice(0, newline);
      lineBuffer = lineBuffer.slice(newline + 1);
      stdoutParts.push(line);
      options.onStdoutLine?.(line);
      newline = lineBuffer.indexOf('\n');
    }
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    if (overflow) return;
    capturedBytes += Buffer.byteLength(chunk);
    if (capturedBytes > MAXIMUM_OUTPUT_BYTES) {
      overflow = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      return;
    }
    stderrParts.push(chunk);
  });
  const identity = captureProcessIdentity(child.pid);
  return {
    pid: child.pid ?? -1,
    identity,
    promise: /** @type {Promise<{code:number|null, signal:string|null, timedOut:boolean, overflow:boolean, stdout:string, stderr:string, durationMs:number, pid:number}>} */ (promise),
  };
}

/**
 * The exact qualification matrix. Hard failures throw; soft assertion
 * failures stay in the durable log so the final reduced result carries them.
 * @param {{codexPath:string, sourceCodexHome:string, runDirectory:string}} input
 */
export async function qualifyMcpContext(input) {
  const { codexPath, runDirectory } = input;
  if (!isAbsolute(codexPath)) throw probeError('PROBE_CODEX_PATH_RELATIVE', 'codexPath must be an absolute path.');
  const runStats = await lstat(runDirectory).catch((error) => {
    if (errorCode(error) === 'ENOENT') throw probeError('PROBE_RUN_DIRECTORY_MISSING', 'The probe run directory must exist and be a private mode-0700 directory.');
    throw error;
  });
  if (!runStats.isDirectory()) throw probeError('PROBE_RUN_DIRECTORY_MISSING', 'The probe run directory must exist and be a private mode-0700 directory.');
  if (process.platform !== 'win32' && (runStats.mode & 0o777) !== 0o700) {
    throw probeError('PROBE_RUN_DIRECTORY_MODE', 'The probe run directory must be mode 0700.');
  }
  // Probe state reuses fixed child-directory names and final cleanup removes
  // them recursively, so a nonempty caller-supplied directory would both
  // alias pre-existing state and have its contents destroyed.
  if ((await readdir(runDirectory)).length > 0) {
    throw probeError('PROBE_RUN_DIRECTORY_NOT_EMPTY', 'The probe run directory must be empty before qualification state is created.');
  }

  const sourceCodexHomeRoot = await realpath(input.sourceCodexHome).catch(() => {
    throw probeError('PROBE_QUALIFICATION_UNAVAILABLE', 'qualification-unavailable: the source Codex home must be a real directory.');
  });
  const sourceAuthStats = await lstat(join(sourceCodexHomeRoot, 'auth.json')).catch(() => {
    throw probeError('PROBE_QUALIFICATION_UNAVAILABLE', 'qualification-unavailable: a regular auth.json must exist in the source Codex home.');
  });
  if (sourceAuthStats.isSymbolicLink() || !sourceAuthStats.isFile()) {
    throw probeError('PROBE_QUALIFICATION_UNAVAILABLE', 'qualification-unavailable: the source auth.json must be a regular non-symlink file.');
  }

  const canonicalCodexPath = await realpath(codexPath).catch(() => {
    throw probeError('PROBE_CODEX_MISSING', 'The supplied codex path must resolve to an existing launcher target.');
  });
  let codexIdentity = await stat(canonicalCodexPath);
  if (!codexIdentity.isFile() || (codexIdentity.mode & 0o111) === 0) {
    throw probeError('PROBE_CODEX_NOT_EXECUTABLE', 'The canonical codex target must be a regular executable file.');
  }

  const versionRun = runBounded(canonicalCodexPath, ['--version'], { cwd: runDirectory, env: minimalEnv() });
  const version = await versionRun.promise;
  if (version.code !== 0 || !/codex-cli \d/.test(version.stdout)) {
    throw probeError('PROBE_CODEX_VERSION', `codex --version failed: exit ${version.code}`);
  }
  const codexVersion = /** @type {RegExpMatchArray} */ (version.stdout.match(/codex-cli \S+/))?.[0] ?? 'codex-cli unknown';
  transcript(`qualify: canonical codex target pinned (${basename(canonicalCodexPath)}), ${codexVersion}`);

  // Fail-closed acceptance pre-check for --ignore-rules: the Host argv below
  // depends on the flag, so the parser must accept it before any phase runs.
  // A rejection here fails the gate instead of misattributing the failure.
  const flagCheck = runBounded(canonicalCodexPath, ['exec', '--ignore-rules', '--help'], { cwd: runDirectory, env: minimalEnv() });
  const flagResult = await flagCheck.promise;
  if (flagResult.code !== 0) {
    throw probeError('PROBE_CODEX_FLAGS', `codex exec rejected --ignore-rules (exit ${flagResult.code}); the qualification fails closed.`);
  }

  const isolatedCodexHome = join(runDirectory, 'codex-home');
  const isolatedHome = join(runDirectory, 'home');
  const isolatedTmp = join(runDirectory, 'tmp');
  const workspaceA = join(runDirectory, 'workspace-a');
  const marketplaceSlow = join(runDirectory, 'marketplace-tool-timeout-30');
  const marketplaceFast = join(runDirectory, 'marketplace-tool-timeout-2');
  for (const directory of [isolatedCodexHome, isolatedHome, isolatedTmp, workspaceA]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(directory, 0o700);
  }
  const isolatedAuthPath = join(isolatedCodexHome, 'auth.json');

  const runNonce = randomBytes(32).toString('hex');
  const observer = probeEventPaths(runDirectory);
  /** @type {NodeJS.ProcessEnv} */
  const hostEnv = {
    PATH: process.env.PATH ?? '',
    TMPDIR: isolatedTmp,
    CODEX_HOME: isolatedCodexHome,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    ZCODE_MCP_PROBE_EVENTS: observer.eventsPath,
    ZCODE_MCP_PROBE_LOCK: observer.lockPath,
    ZCODE_MCP_PROBE_NONCE: runNonce,
  };

  /** @type {number[]} */
  /** Recorded as pid → captured start identity so cleanup never signals a recycled PID. */
  const trackedProcesses = new Map();
  /** @type {string[]} */
  const installedMarketplaces = [];
  let canonicalTarget = canonicalCodexPath;

  const recheckCodex = async () => {
    const currentPath = await realpath(canonicalCodexPath);
    const currentIdentity = await stat(currentPath);
    if (currentPath !== canonicalTarget || currentIdentity.dev !== codexIdentity.dev || currentIdentity.ino !== codexIdentity.ino
      || !currentIdentity.isFile() || (currentIdentity.mode & 0o111) === 0) {
      throw probeError('PROBE_CODEX_REPLACED', 'The pinned codex binary changed during qualification.');
    }
    canonicalTarget = currentPath;
    codexIdentity = currentIdentity;
    return currentPath;
  };

  /**
   * Runs one bounded codex CLI command under the isolated env.
   * @param {string[]} args @param {{label:string}} options
   */
  const runCodexCommand = async (args, options) => {
    const target = await recheckCodex();
    transcript(`${options.label}: exit pending`);
    const run = runBounded(target, args, { cwd: runDirectory, env: hostEnv });
    trackedProcesses.set(run.pid, run.identity);
    const result = await run.promise;
    transcript(`${options.label}: exit=${result.code} durationMs=${result.durationMs}${result.timedOut ? ' timedOut' : ''}${result.overflow ? ' overflow' : ''}`);
    if (result.code !== 0) {
      transcript(`${options.label}: ${parseLastJsonValue(result.stdout) ? 'json diagnostic available' : 'no json diagnostic'}`);
    }
    return result;
  };

  /**
   * Spawns one real Host conversation with the fixed argv shapes and strict
   * JSONL accounting. Does not await it.
   * @param {string[]} args @param {{cwd:string, label:string}} options
   */
  const startHost = async (args, options) => {
    const target = await recheckCodex();
    /** @type {{malformed:number, frameTypes:Map<string, number>, nestedItemTypes:Map<string, number>, threadIds:string[], excerpts:{frameType:string, nestedItemType:string|null, itemStatus:string|null, excerpt:string}[]}} */
    const account = { malformed: 0, frameTypes: new Map(), nestedItemTypes: new Map(), threadIds: [], excerpts: [] };
    const run = runBounded(target, args, {
      cwd: options.cwd,
      env: hostEnv,
      deadlineMs: HOST_CONVERSATION_DEADLINE_MS,
      onStdoutLine: (line) => {
        try {
          const frame = JSON.parse(line);
          const kind = typeof frame?.type === 'string' ? frame.type : 'unknown';
          account.frameTypes.set(kind, (account.frameTypes.get(kind) ?? 0) + 1);
          if (kind === 'thread.started' && typeof frame.thread_id === 'string') account.threadIds.push(frame.thread_id);
          // Codex JSONL reports MCP calls as item.* frames whose nested
          // item.type is mcp_tool_call, so the nested vocabulary — not the
          // top-level frame type — is what proves whether an MCP tool call
          // existed. Nested types and statuses are bounded like excerpts and
          // live in memory only.
          const nestedItem = kind.startsWith('item.') && frame?.item && typeof frame.item === 'object' ? frame.item : null;
          const nestedItemType = nestedItem && typeof nestedItem.type === 'string' ? nestedItem.type.slice(0, FRAME_EXCERPT_MAX_CHARS) : null;
          const itemStatus = nestedItem && typeof nestedItem.status === 'string' ? nestedItem.status.slice(0, FRAME_EXCERPT_MAX_CHARS) : null;
          if (nestedItemType !== null) {
            account.nestedItemTypes.set(nestedItemType, (account.nestedItemTypes.get(nestedItemType) ?? 0) + 1);
          }
          // Excerpts stay bounded and in memory only; each carries its source
          // (top-level frame type plus nested item type/status) so the
          // negative-control gate can demand a genuine failure surface.
          if ((kind === 'error' || kind.startsWith('item.')) && account.excerpts.length < FRAME_EXCERPTS_MAX) {
            account.excerpts.push({ frameType: kind, nestedItemType, itemStatus, excerpt: line.slice(0, FRAME_EXCERPT_MAX_CHARS) });
          }
        } catch { account.malformed += 1; }
      },
    });
    trackedProcesses.set(run.pid, run.identity);
    transcript(`${options.label}: host pid tracked`);
    return { ...run, account };
  };

  const durableEvents = () => readProbeEvents({ runDirectory, runNonce });
  const countKind = async (kind) => (await durableEvents()).filter((record) => record.event.kind === kind).length;
  const observePhase = async (phaseName) => {
    await appendProbeEvent({ runDirectory, runNonce, event: { kind: 'phase-observed', phase: phaseName, observed: true } });
  };

  /**
   * Requires exactly `expected` durable captures so a non-conforming
   * conversation hard-fails instead of misattributing evidence.
   * @param {number} expected @param {string} label
   */
  const requireExactCaptureCount = async (expected, label) => {
    await waitUntil(async () => (await countKind('capture-started')) >= expected,
      SUBPROCESS_DEADLINE_MS, `${label}: expected ${expected} durable capture events, none arrived`);
    const captures = (await durableEvents()).filter((record) => record.event.kind === 'capture-started');
    if (captures.length !== expected) {
      throw probeError('PROBE_MATRIX_MISMATCH', `${label}: expected exactly ${expected} durable capture events, observed ${captures.length}.`);
    }
    transcript(`${label}: ${expected} durable captures observed`);
  };

  /**
   * Fixed base argv for new conversations (amended positive shape: no
   * --ignore-user-config, which skips the plugin configuration; --ignore-rules
   * keeps rule isolation).
   * @param {string} workspace @param {string} prompt
   */
  const newConversationArgs = (workspace, prompt) => [
    'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
    '--ignore-rules', '-C', workspace, prompt,
  ];

  /**
   * Negative-control argv: the same isolated marketplace and plugin, with
   * --ignore-user-config added so the plugin configuration is provably
   * skipped and the probe server cannot load.
   * @param {string} workspace @param {string} prompt
   */
  const negativeControlArgs = (workspace, prompt) => [
    'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
    '--ignore-rules', '--ignore-user-config', '-C', workspace, prompt,
  ];

  /** @type {{failed:true, error:unknown}|{failed:false, value:Record<string, boolean>}} */
  let qualificationOutcome;
  try {
    // The credential copy lives inside the protected scope so any failure
    // after it always reaches the verified-deletion cleanup.
    await copyFile(join(sourceCodexHomeRoot, 'auth.json'), isolatedAuthPath);
    if (process.platform !== 'win32') await chmod(isolatedAuthPath, 0o600);
    await mkdir(marketplaceSlow, { recursive: true, mode: 0o700 });
    await mkdir(marketplaceFast, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      await chmod(marketplaceSlow, 0o700);
      await chmod(marketplaceFast, 0o700);
    }
    await buildProbeMarketplace({ output: marketplaceSlow, server: moduleServerPath(), toolTimeoutSec: 30 });
    await buildProbeMarketplace({ output: marketplaceFast, server: moduleServerPath(), toolTimeoutSec: 2 });
    transcript('fixtures: probe marketplaces built (30s and 2s tool timeouts)');

    const loginStatus = await runCodexCommand(['login', 'status'], { label: 'login-status' });
    if (loginStatus.code !== 0) {
      throw probeError('PROBE_QUALIFICATION_UNAVAILABLE', 'qualification-unavailable: the isolated Codex home failed `codex login status`.');
    }
    await installMarketplace(runCodexCommand, marketplaceSlow, 'slow');

    // Phase 0: negative control — the same isolated marketplace and plugin,
    // but --ignore-user-config skips the plugin configuration. Durable
    // absence is exact: the driver snapshots the durable event log before
    // and after this Host completes and requires zero `server-started` and
    // zero `capture-started` events across that window before recording the
    // `negative-control` phase marker (recorded by the driver alone).
    const durableServerAndCaptureCounts = async () => {
      const records = await durableEvents();
      return {
        serverStarted: records.filter((record) => record.event.kind === 'server-started').length,
        captureStarted: records.filter((record) => record.event.kind === 'capture-started').length,
      };
    };
    const windowBefore = await durableServerAndCaptureCounts();
    const negativeHost = await startHost(negativeControlArgs(workspaceA, NEGATIVE_CONTROL_PROMPT), { cwd: workspaceA, label: 'phase-negative-control' });
    const negativeResult = await negativeHost.promise;
    assertConversationRan(negativeResult, negativeHost.account, 'phase-negative-control');
    // The clean durable window alone cannot distinguish "config skipped" from
    // "model never attempted the tool"; the transcript must show the recorded
    // tool-unavailable shape (attempted, errored, never executed).
    assertToolUnavailableTranscript(negativeHost.account, 'phase-negative-control');
    if (negativeHost.account.threadIds.length !== 1) {
      throw probeError('PROBE_HOST_FRAMES', `phase-negative-control: expected exactly one thread.started, observed ${negativeHost.account.threadIds.length}.`);
    }
    transcript(`phase-negative-control: completed frames=${frameSummary(negativeHost.account)}`);
    const windowAfter = await durableServerAndCaptureCounts();
    if (windowAfter.serverStarted !== windowBefore.serverStarted || windowAfter.captureStarted !== windowBefore.captureStarted) {
      await markPhaseFailed('negative-control');
      throw probeError('PROBE_NEGATIVE_CONTROL_FAILED', 'The negative-control Host durably loaded or called the probe server under --ignore-user-config.');
    }
    await observePhase('negative-control');
    transcript('phase-negative-control: window free of server/capture events; marker recorded');

    // Phase 1: the scripted matrix conversation in workspace A.
    await observePhase('matrix');
    const matrixHost = await startHost(newConversationArgs(workspaceA, MATRIX_PROMPT), { cwd: workspaceA, label: 'phase-matrix' });
    const matrixResult = await matrixHost.promise;
    assertConversationRan(matrixResult, matrixHost.account, 'phase-matrix');
    if (matrixHost.account.threadIds.length !== 1) {
      throw probeError('PROBE_HOST_FRAMES', `phase-matrix: expected exactly one thread.started, observed ${matrixHost.account.threadIds.length}.`);
    }
    const rootThreadId = matrixHost.account.threadIds[0];
    transcript(`phase-matrix: thread started ([redacted-thread]) frames=${frameSummary(matrixHost.account)}`);
    await requireExactCaptureCount(MATRIX_CAPTURES_EXPECTED, 'phase-matrix');
    await trackServerProcesses(true);

    // Phase 2: state-machine step 2 — the Root resume in workspace A via
    // exec resume --all. Requires exit 0, the same trusted thread_id, a
    // different turn_id, and its durable event, proven hash-based between
    // the durable captures below. Recorded 0.154.0 fact: the stdout
    // `thread.started` id (the id this driver resumes with) and the trusted
    // `_meta` turn-metadata thread id are distinct namespaces, so the
    // same-thread proof is never taken against the stdout id.
    const resumeArgs = [
      'exec', 'resume', '--json', '--all', '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox', '--ignore-rules', rootThreadId, ROOT_RESUME_PROMPT,
    ];
    const resumeHost = await startHost(resumeArgs, { cwd: workspaceA, label: 'phase-matrix-resume' });
    const resumeResult = await resumeHost.promise;
    assertConversationRan(resumeResult, resumeHost.account, 'phase-matrix-resume');
    // CLI-level same-thread evidence before the hash-based correlation: the
    // resume stdout must re-emit exactly the id this driver resumed with.
    assertResumeThreadIdentity(resumeHost.account, rootThreadId);
    await requireExactCaptureCount(MATRIX_CAPTURES_EXPECTED + 1, 'phase-matrix-resume');
    // durableEvents() returns full records; the hash checks below compare
    // the capture event bodies themselves.
    const captureEvents = (await durableEvents())
      .filter((record) => record.event.kind === 'capture-started')
      .map((record) => record.event);
    if (captureEvents[MATRIX_CAPTURES_EXPECTED].threadHash !== captureEvents[0].threadHash) {
      throw probeError('PROBE_CONTEXT_MISMATCH', 'phase-matrix-resume: the resume capture does not sit on the trusted Root thread.');
    }
    if (captureEvents[MATRIX_CAPTURES_EXPECTED].turnHash === captureEvents[0].turnHash) {
      throw probeError('PROBE_CONTEXT_MISMATCH', 'phase-matrix-resume: the resume turn identity did not change from the Root capture.');
    }
    transcript('phase-matrix-resume: same-thread/different-turn verified by durable hash');
    // The captured metadata must be the metadata of the Host fact this run
    // actually produced, not merely complete, stable, and distinct values.
    await assertAuthoritativeIdentityCorrelation(await durableEvents());
    await trackServerProcesses(true);

    // Phase 3: SIGINT delivery to a held call.
    await observePhase('sigint-cancel');
    const sigintHost = await startHost(newConversationArgs(workspaceA, HOLD_PROMPT), { cwd: workspaceA, label: 'phase-sigint' });
    await waitUntil(async () => (await countKind('hold-started')) >= 1,
      SUBPROCESS_DEADLINE_MS, 'phase-sigint: hold-started never became durable');
    const sigintCallNonce = latestHoldCallNonce(await durableEvents());
    assertProcessIdentity(sigintHost.pid, sigintHost.identity);
    transcript('phase-sigint: SIGINT sent to recorded host pid');
    try { process.kill(sigintHost.pid, 'SIGINT'); } catch (error) {
      throw probeError('PROBE_SIGNAL_FAILED', `phase-sigint: SIGINT could not be delivered (${errorCode(error)}).`);
    }
    // One 10-second window covers BOTH the exit and the settlement (plan
    // phases 3-4): the deadline is captured at signal delivery, and the
    // settlement wait receives only the budget the exit wait did not
    // consume, so cancellation can never be accepted far outside the window.
    const sigintDeadline = Date.now() + SIGNAL_GRACE_MS;
    let cancelDelivered = await waitForExit(sigintHost.pid, SIGNAL_GRACE_MS);
    if (cancelDelivered) {
      cancelDelivered = await settlementArrived(sigintCallNonce, Math.max(0, sigintDeadline - Date.now()), durableEvents);
    } else {
      await stopProcess(sigintHost.pid, 'SIGKILL', 5_000, sigintHost.identity);
      transcript('phase-sigint: host ignored SIGINT; exact pid SIGKILLed and cancel assertion failed');
    }
    transcript(`phase-sigint: cancelDelivered=${cancelDelivered}`);
    if (!cancelDelivered) await markPhaseFailed('sigint-cancel');
    await trackServerProcesses(true);

    // Phase 4: SIGKILL disconnect settlement.
    await observePhase('sigkill-disconnect');
    const holdsBeforeSigkill = await countKind('hold-started');
    const sigkillHost = await startHost(newConversationArgs(workspaceA, HOLD_PROMPT), { cwd: workspaceA, label: 'phase-sigkill' });
    await waitUntil(async () => (await countKind('hold-started')) >= holdsBeforeSigkill + 1,
      SUBPROCESS_DEADLINE_MS, 'phase-sigkill: hold-started never became durable');
    const sigkillCallNonce = latestHoldCallNonce(await durableEvents());
    assertProcessIdentity(sigkillHost.pid, sigkillHost.identity);
    try { process.kill(sigkillHost.pid, 'SIGKILL'); } catch (error) {
      throw probeError('PROBE_SIGNAL_FAILED', `phase-sigkill: SIGKILL could not be delivered (${errorCode(error)}).`);
    }
    // One 10-second window covers BOTH the exit and the settlement (plan
    // phase 4): the settlement wait receives only the budget the exit wait
    // did not consume, so connection loss can never be accepted far outside
    // the window.
    const sigkillDeadline = Date.now() + SIGNAL_GRACE_MS;
    let connectionLossDelivered = await waitForExit(sigkillHost.pid, SIGNAL_GRACE_MS)
      && await settlementArrived(sigkillCallNonce, Math.max(0, sigkillDeadline - Date.now()), durableEvents);
    if (isProcessAlive(sigkillHost.pid)) {
      await stopProcess(sigkillHost.pid, 'SIGKILL', 5_000, sigkillHost.identity);
      connectionLossDelivered = false;
    }
    transcript(`phase-sigkill: connectionLossDelivered=${connectionLossDelivered}`);
    if (!connectionLossDelivered) await markPhaseFailed('sigkill-disconnect');
    await trackServerProcesses(true);

    // Phase 5 boundary: stop every 30-second-phase process, then remove its
    // plugin and marketplace before the 2-second fixture exists.
    await stopTrackedProcesses();
    await removeMarketplace('slow');

    // Phase 6: 2-second host tool timeout settlement.
    await installMarketplace(runCodexCommand, marketplaceFast, 'fast');
    await trackServerProcesses(true);
    await observePhase('short-timeout');
    const holdsBeforeTimeout = await countKind('hold-started');
    const timeoutHost = await startHost(newConversationArgs(workspaceA, HOLD_PROMPT), { cwd: workspaceA, label: 'phase-short-timeout' });
    await waitUntil(async () => (await countKind('hold-started')) >= holdsBeforeTimeout + 1,
      SUBPROCESS_DEADLINE_MS, 'phase-short-timeout: hold-started never became durable');
    const timeoutCallNonce = latestHoldCallNonce(await durableEvents());
    let shortTimeoutSettled = true;
    // The ceiling measures timeout settlement, so it starts only once the
    // held call is durable — model startup time must not consume it.
    const heldCallStartedAt = Date.now();
    // The exit must be awaited and attributable to the configured tool
    // timeout: exit inside the ceiling, then the durable abort settlement
    // (the Host may report the tool error and still complete with exit 0).
    const remainingCeilingMs = Math.max(1, heldCallStartedAt + HOST_TIMEOUT_GRACE_MS - Date.now());
    const hostExit = await Promise.race([
      timeoutHost.promise,
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), remainingCeilingMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
    const elapsedMs = Date.now() - heldCallStartedAt;
    if (!hostExit || hostExit.timedOut || elapsedMs > HOST_TIMEOUT_GRACE_MS) {
      await stopProcess(timeoutHost.pid, 'SIGKILL', 5_000, timeoutHost.identity);
      shortTimeoutSettled = false;
    } else {
      // The 30-second gate covers exit AND settlement (plan phase 6): the
      // settlement check receives only the ceiling budget the exit race did
      // not consume, so a late settlement can never be accepted outside it.
      shortTimeoutSettled = await timeoutSettlementArrived(
        timeoutCallNonce,
        Math.max(0, heldCallStartedAt + HOST_TIMEOUT_GRACE_MS - Date.now()),
        durableEvents,
      );
    }
    transcript(`phase-short-timeout: shortTimeoutSettled=${shortTimeoutSettled}`);
    if (!shortTimeoutSettled) await markPhaseFailed('short-timeout');

    await stopTrackedProcesses();
    await removeMarketplace('fast');

    for (const pid of [sigintHost.pid, sigkillHost.pid, timeoutHost.pid]) {
      if (cleanupTargetMatchesIdentity(pid, trackedProcesses.get(pid) ?? null)) {
        throw probeError('PROBE_CLEANUP_FAILED', 'A recorded host process survived qualification.');
      }
    }
    await unlink(isolatedAuthPath);
    if (await lstat(isolatedAuthPath).then(() => true, () => false)) {
      throw probeError('PROBE_CLEANUP_FAILED', 'The isolated auth.json copy could not be deleted.');
    }
    const result = await reduceProbeResult({ runDirectory, runNonce });
    transcript('result: reduced and written to result.json');
    qualificationOutcome = { failed: false, value: result };
  } catch (qualificationError) {
    qualificationOutcome = { failed: true, error: qualificationError };
  }

  // Ordered cleanup runs after every exit path (plan lines 256, 258-263):
  // stop processes, remove plugin and marketplace, delete the isolated auth
  // copy, and remove the temporary isolated homes. A cleanup failure fails
  // the qualification redactedly, but never masks the original outcome.
  const cleanupFailures = [];
  try {
    await stopTrackedProcesses();
  } catch (cleanupError) {
    cleanupFailures.push(cleanupError);
  }
  while (installedMarketplaces.length > 0) {
    try { await removeMarketplace('cleanup'); } catch (cleanupError) { cleanupFailures.push(cleanupError); break; }
  }
  // Deletion of the copied credential is verified: an I/O or permission
  // failure must surface as a cleanup failure, never silently keep it.
  try {
    await unlink(isolatedAuthPath);
  } catch (cleanupError) {
    if (errorCode(cleanupError) !== 'ENOENT') {
      cleanupFailures.push(probeError('PROBE_CLEANUP_FAILED', 'The isolated auth.json copy could not be deleted.'));
    }
  }
  if (await lstat(isolatedAuthPath).then(() => true, () => false)) {
    cleanupFailures.push(probeError('PROBE_CLEANUP_FAILED', 'The isolated auth.json copy could not be deleted.'));
  }
  for (const directory of [isolatedCodexHome, isolatedHome, isolatedTmp]) {
    try {
      await rm(directory, { recursive: true });
      if (await lstat(directory).then(() => true, () => false)) {
        cleanupFailures.push(probeError('PROBE_CLEANUP_FAILED', 'A temporary isolated home directory could not be removed.'));
      }
    } catch (cleanupError) {
      if (errorCode(cleanupError) !== 'ENOENT') {
        cleanupFailures.push(probeError('PROBE_CLEANUP_FAILED', 'A temporary isolated home directory could not be removed.'));
      }
    }
  }
  if (cleanupFailures.length > 0) {
    transcript(`cleanup: ${cleanupFailures.length} redacted cleanup failure(s) recorded`);
    if (qualificationOutcome.failed) {
      // Preserve both: the caller must learn that resources or credentials
      // may remain, so the redacted cleanup failure is what surfaces while
      // the original phase error stays in the redacted transcript.
      const original = qualificationOutcome.error;
      transcript(`qualification: the run already failed with ${original && typeof original === 'object' && 'code' in original ? /** @type {any} */ (original).code : 'an unspecified error'}`);
    }
    throw cleanupFailures[0];
  }
  if (qualificationOutcome.failed) throw qualificationOutcome.error;
  return qualificationOutcome.value;

  /** @param {{code:number|null, timedOut:boolean, overflow:boolean}} result @param {{malformed:number, frameTypes:Map<string, number>}} account @param {string} label */
  function assertConversationRan(result, account, label) {
    if (result.timedOut || result.overflow) {
      transcript(`${label}: host exceeded its deadline or output bound; frames=${frameSummary(account)}`);
      throw probeError('PROBE_HOST_FAILED', `${label}: host exceeded its deadline or output bound.`);
    }
    if (result.code !== 0) {
      transcript(`${label}: host exit ${result.code}; frames=${frameSummary(account)}`);
      throw probeError('PROBE_HOST_FAILED', `${label}: host exit ${result.code}.`);
    }
    if (account.malformed !== 0) throw probeError('PROBE_HOST_FRAMES', `${label}: ${account.malformed} malformed stdout frames.`);
  }

  /** @param {string} phaseName */
  async function markPhaseFailed(phaseName) {
    await appendProbeEvent({ runDirectory, runNonce, event: { kind: 'phase-observed', phase: phaseName, observed: false } });
  }

  /**
   * Records every server pid observed in the durable log. When a server was
   * observed alive by this driver (a phase boundary), its start identity is
   * captured immediately; pids discovered only at cleanup time were never
   * observed alive, so their identity stays uncaptured and they can never be
   * signalled — a recycled pid must not be authenticated after the fact.
   * @param {boolean} captureIdentity
   */
  async function trackServerProcesses(captureIdentity) {
    for (const record of await durableEvents()) {
      const event = record.event;
      if (event.kind === 'server-started' && Number.isSafeInteger(event.serverPid) && event.serverPid > 0
        && !trackedProcesses.has(event.serverPid)) {
        trackedProcesses.set(event.serverPid, captureIdentity ? captureProcessIdentity(event.serverPid) : null);
      }
    }
  }

  async function stopTrackedProcesses() {
    await trackServerProcesses(false);
    for (const [pid, identity] of trackedProcesses) {
      if (!isProcessAlive(pid)) continue;
      // Give disposal-grace exits a natural window before signalling.
      if (await waitForExit(pid, SERVER_DISPOSAL_WAIT_MS)) continue;
      if (!cleanupTargetMatchesIdentity(pid, identity)) {
        // Refusing to signal an unverifiable PID is mandatory, but cleanup
        // only succeeds when no tracked probe process is left running.
        throw probeError('PROBE_CLEANUP_FAILED', 'A tracked probe process is still running and its start identity could not be verified for cleanup.');
      }
      if (!(await stopProcess(pid, 'SIGKILL', 5_000, identity))) {
        throw probeError('PROBE_CLEANUP_FAILED', 'A tracked probe process survived cleanup.');
      }
    }
  }

  /**
   * @param {(args:string[], options:{label:string}) => Promise<{code:number|null}>} runCommand
   * @param {string} marketplaceRoot @param {string} label
   */
  async function installMarketplace(runCommand, marketplaceRoot, label) {
    const added = await runCommand(['plugin', 'marketplace', 'add', marketplaceRoot, '--json'], { label: `${label} marketplace-add` });
    if (added.code !== 0) throw probeError('PROBE_INSTALL_FAILED', `${label} marketplace add failed: exit ${added.code}`);
    // Record the marketplace for cleanup as soon as it is registered so a
    // failed or timed-out `plugin add` still removes both in `finally`.
    installedMarketplaces.push(marketplaceRoot);
    const installed = await runCommand(['plugin', 'add', CODEX_PLUGIN_SELECTOR, '--json'], { label: `${label} plugin-add` });
    if (installed.code !== 0) throw probeError('PROBE_INSTALL_FAILED', `${label} plugin add failed: exit ${installed.code}`);
    transcript(`${label}: marketplace and probe plugin installed`);
  }

  /** @param {string} label */
  async function removeMarketplace(label) {
    // Both removal commands always run, even after the other one fails; the
    // failures are aggregated so the registration cannot survive cleanup.
    const failures = [];
    const pluginRemoved = await runCodexCommand(['plugin', 'remove', CODEX_PLUGIN_SELECTOR, '--json'], { label: `${label} plugin-remove` });
    if (pluginRemoved.code !== 0) failures.push(`plugin remove exit ${pluginRemoved.code}`);
    const marketplaceRemoved = await runCodexCommand(['plugin', 'marketplace', 'remove', CODEX_MARKETPLACE_NAME, '--json'], { label: `${label} marketplace-remove` });
    if (marketplaceRemoved.code !== 0) failures.push(`marketplace remove exit ${marketplaceRemoved.code}`);
    if (failures.length > 0) throw probeError('PROBE_CLEANUP_FAILED', `${label} cleanup failed (${failures.join('; ')})`);
    installedMarketplaces.pop();
    transcript(`${label}: probe plugin and marketplace removed`);
  }
}

/**
 * @param {{event:{kind:string, callNonce?:string}}[]} records
 */
function latestHoldCallNonce(records) {
  const holds = records.filter((record) => record.event.kind === 'hold-started');
  const last = holds.at(-1);
  const nonce = last && typeof last.event.callNonce === 'string' ? last.event.callNonce : null;
  if (!nonce) throw probeError('PROBE_LOG_INCOMPLETE', 'The latest hold-started event is missing its call nonce.');
  return nonce;
}

/**
 * @param {string} callNonce @param {number} graceMs
 * @param {() => Promise<{event:{kind:string, callNonce?:string, settlement?:string}}[]>} durableEvents
 */
async function settlementArrived(callNonce, graceMs, durableEvents) {
  try {
    await waitUntil(async () => (await durableEvents()).some((record) => record.event.kind === 'hold-settled' && record.event.callNonce === callNonce), graceMs, '');
    return true;
  } catch {
    return false;
  }
}

/**
 * Like settlementArrived, but additionally requires the settlement to be
 * attributable to the configured tool timeout: the durable gap between the
 * held call's start and its settlement must reach the timeout floor, so an
 * abort delivered near-instantly for any other reason never qualifies. The
 * caller supplies the remaining ceiling budget so exit and settlement share
 * one 30-second window instead of stacked fresh waits.
 * @param {string} callNonce
 * @param {number} graceMs
 * @param {() => Promise<{event:{kind:string, callNonce?:string, settlement?:string}, timestamp:string}[]>} durableEvents
 */
async function timeoutSettlementArrived(callNonce, graceMs, durableEvents) {
  try {
    await waitUntil(async () => {
      const records = await durableEvents();
      const started = records.find((record) => record.event.kind === 'hold-started' && record.event.callNonce === callNonce);
      const settled = records.find((record) => record.event.kind === 'hold-settled' && record.event.callNonce === callNonce);
      if (!started || !settled) return false;
      const gapMs = Date.parse(settled.timestamp) - Date.parse(started.timestamp);
      return gapMs >= FAST_TOOL_TIMEOUT_MS - TOOL_TIMEOUT_SCHEDULING_TOLERANCE_MS;
    }, graceMs, '');
    return true;
  } catch {
    return false;
  }
}

/** @param {{malformed:number, frameTypes:Map<string, number>}} account */
function frameSummary(account) {
  return [...account.frameTypes.entries()].map(([kind, count]) => `${kind}:${count}`).join(',');
}

/** Resolves this module's server.mjs sibling for the generated descriptors. */
function moduleServerPath() {
  return join(dirname(moduleEntry), 'server.mjs');
}

/** @returns {NodeJS.ProcessEnv} */
function minimalEnv() {
  return { PATH: process.env.PATH ?? '', TMPDIR: process.env.TMPDIR ?? '/tmp' };
}

/** @param {string[]} argv */
function parseArguments(argv) {
  const parsed = /** @type {Record<string, string>} */ ({});
  if (argv.length !== 6) {
    throw probeError('PROBE_USAGE_INVALID', 'usage: qualify.mjs --codex <path> --source-codex-home <dir> --run-directory <dir>');
  }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw probeError('PROBE_USAGE_INVALID', `usage: qualify.mjs --codex <path> --source-codex-home <dir> --run-directory <dir> (bad ${flag})`);
    }
    if (flag === '--codex') parsed.codex = value;
    else if (flag === '--source-codex-home') parsed.sourceCodexHome = value;
    else if (flag === '--run-directory') parsed.runDirectory = value;
    else throw probeError('PROBE_USAGE_INVALID', `usage: qualify.mjs --codex <path> --source-codex-home <dir> --run-directory <dir> (unknown ${flag})`);
  }
  return parsed;
}

if (runningAsMain) {
  const args = parseArguments(process.argv.slice(2));
  await mkdir(args.runDirectory, { recursive: true, mode: 0o700 });
  const runDirectory = await realpath(args.runDirectory);
  try {
    const result = await qualifyMcpContext({
      codexPath: args.codex,
      sourceCodexHome: args.sourceCodexHome,
      runDirectory,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = Object.values(result).every((value) => value === true) ? 0 : 1;
  } catch (error) {
    process.stderr.write(`qualification failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
