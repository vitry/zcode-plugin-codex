// @ts-nocheck
/**
 * Disposable real-Host qualification and characterization driver for the
 * Codex MCP invocation context. It canonicalizes and pins an externally
 * supplied Codex binary, copies only auth.json into isolated homes, installs
 * probe-only marketplaces, drives the amended state machine — negative
 * control, the scripted identity matrix, CLI SIGINT/SIGKILL observation, the
 * app-server characterization (bounded `skills/list` Skill resolution, a
 * structured-Skill treatment capture turn, a text-only control capture
 * turn, a diagnostic-only `mcpServer/tool/call` transport control, and the
 * durable-hold-gated `turn/interrupt` characterization), and the
 * plugin/direct-config timeout differential — and finally reduces the
 * durable event log into `<run>/result.json` with the six context assertions
 * and five honest lifecycle observations. It never touches the real Codex
 * home beyond reading auth.json, never logs credentials or identity values,
 * and never resolves the binary through PATH.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, rm, stat, realpath, chmod, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listCodexThreadSpawnChildren, readCodexThread } from '../../scripts/lib/codex-app-server.mjs';

import { buildProbeMarketplace } from './build-fixture.mjs';
import {
  appendProbeEvent,
  hashProbeValue,
  probeEventPaths,
  PROBE_LIFECYCLE_CASES,
  readProbeEvents,
  reduceProbeResult,
} from './observer.mjs';

const CODEX_PLUGIN_SELECTOR = 'zcode-mcp-context-probe@zcode-mcp-probe';
const CODEX_MARKETPLACE_NAME = 'zcode-mcp-probe';
const SUBPROCESS_DEADLINE_MS = 180_000;
// Host conversations are long, multi-turn scripted model sessions: on the
// real 0.154.0 host the scripted matrix's first durable capture alone landed
// ~140s into the conversation, so the CLI-command outer deadline cannot bound
// a Host spawn without killing a healthy conversation. On the 0.155.1 host
// the same matrix conversation is slower still — the first two captures
// landed by ~390s and the conversation was still progressing (hooks firing,
// zero malformed frames) when a 600-second bound killed it — so the outer
// deadline gives the conversation 900 seconds while remaining an explicit,
// bounded instrument contract. The signal/timeout ceilings (10s/30s) and the
// output bound remain the protocol assertions.
const HOST_CONVERSATION_DEADLINE_MS = 900_000;
const MAXIMUM_OUTPUT_BYTES = 4 * 1024 * 1024;
// Bounded notifications for the app-server JSON-RPC client: the
// characterization reads a handful of frames, so past this cap frames are
// counted (redacted) and discarded instead of growing the driver's memory.
const MAXIMUM_APP_SERVER_NOTIFICATIONS = 512;
// 0.155.1 model turns stream high-volume delta notifications
// (`item/agentMessage/delta`, `item/*/outputDelta`, and friends). They are
// counted redacted and never retained — no reducer consumes them (the
// terminal wait reads only `turn/completed`) — so a streaming turn cannot
// terminate the bounded session before the characterization observes the
// held call. Retained (non-delta) notifications still obey the bounded cap.
const APP_SERVER_DELTA_NOTIFICATION = /delta/i;
const SIGNAL_GRACE_MS = 10_000;
const HOST_TIMEOUT_GRACE_MS = 30_000;
const APP_SERVER_OBSERVATION_CEILING_MS = 30_000;
// Bounded wait for the app-server held call's durable start: on this host
// the app-server model may omit the tool call entirely, so the wait cannot
// be unbounded and the interrupt observation must still run.
const APP_SERVER_HOLD_START_WAIT_MS = 300_000;
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
const FRAME_EXCERPT_MAX_CHARS = 400;
const FRAME_EXCERPTS_MAX = 32;
const PROBE_TOOL_REFERENCE = /capture_context|zcode-mcp-context-probe/i;
// The recorded tool-unavailable statement shape: on 0.154.0 the negative-
// control model reports the unavailable probe tool in its agent message
// (the top-level error frames are transient transport noise), so a genuine
// unavailability statement in the message is a failure surface too. On
// 0.155.1 the same negative-control conversation is healthy but phrases the
// unavailability with negative-copula forms the original vocabulary missed
// ("isn't exposed", "isn't available", "not exposed" — the host's apostrophe
// is the Unicode right single quote), so the vocabulary covers both the
// plain and negated forms. The DURABLE WINDOW remains the hard proof that
// the server never loaded; this statement match only recognizes genuine
// engagement.
const PROBE_UNAVAILABLE_STATEMENT = /unavailable|not\s+available|isn[’']t\s+(?:available|exposed|callable|accessible|present)|are\s+(?:unavailable|not\s+(?:available|exposed|callable|accessible|present))|not\s+(?:exposed|callable|accessible|present)|cannot\s+be|unable\s+to|does\s+not\s+exist|no\s+such\s+(?:tool|skill|command)/i;
// The spawn_agent child handle is a Codex thread identifier (UUID format).
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pure classification key for one nested `mcp_tool_call` item: whether the
 * item references the probe tool or server, and its bounded status class
 * (`successful` for completed/ok, `failed` for failed/error, else
 * `unclassified`). PRECEDENCE: when the item carries a `tool` name, that
 * name decides the probe reference EXCLUSIVELY — a foreign introspection
 * call whose arguments or output merely mention the probe (e.g. the host
 * enumerating the probe's resources) must stay foreign; the whole-frame
 * fallback exists only for payloads that omit the tool name (an empty
 * string counts as omitted). The key feeds the driver's uncapped identity
 * tally (`mcpCallIdentityCounts`), so every call is counted regardless of
 * the 32-entry diagnostic excerpt cap; the key set is bounded by the tiny
 * host status vocabulary. Returns null for a malformed payload.
 * @param {{tool?:unknown, status?:unknown}|null} nestedItem @param {string} line
 * @returns {(string|null)} 'probe:successful' | 'probe:failed' | 'probe:unclassified' | 'foreign:successful' | 'foreign:failed' | 'foreign:unclassified' | null
 */
export function mcpToolCallIdentityKey(nestedItem, line) {
  if (!nestedItem || typeof nestedItem !== 'object') return null;
  const toolName = typeof nestedItem.tool === 'string' ? nestedItem.tool : '';
  const referencing = toolName.length > 0 ? PROBE_TOOL_REFERENCE.test(toolName) : PROBE_TOOL_REFERENCE.test(line);
  const status = typeof nestedItem.status === 'string' ? nestedItem.status : '';
  const statusClass = status === 'completed' || status === 'ok' ? 'successful'
    : status === 'failed' || status === 'error' ? 'failed' : 'unclassified';
  return `${referencing ? 'probe' : 'foreign'}:${statusClass}`;
}
// The one host version this amended characterization is schema-pinned to:
// `skills/list`, the structured `{type:'skill'}` turn input item, and
// `mcpServer/tool/call` are 0.155.1 app-server schema (the locally generated
// schema and the official docs confirm them there). The driver fails closed
// on any other version BEFORE any app-server request is issued, so an older
// or newer binary can never degrade those requests into ordinary resolution
// failures and emit mislabeled observations.
const REQUALIFIED_CODEX_VERSION = 'codex-cli 0.155.1';

const MATRIX_PROMPT = 'Use $zcode-mcp-context-probe:context. Call capture_context once in Root. Spawn one Child, have it call capture_context, wait for it, then follow up that exact Child and have it call capture_context again. Then spawn two new Children concurrently and have each call capture_context once. Wait for both. Do not call any other MCP tool.';
const NEGATIVE_CONTROL_PROMPT = 'Use $zcode-mcp-context-probe:context and call capture_context exactly once in Root. Do not spawn a Child.';
const ROOT_RESUME_PROMPT = 'Use $zcode-mcp-context-probe:context and call capture_context exactly once in Root. Do not spawn a Child.';
/** The exec hold voice: names the tool, exact count, nothing else. Shared by the exec hold phases and the app-server held turn. */
export const HOLD_PROMPT = 'Use $zcode-mcp-context-probe:context and call hold_for_lifecycle exactly once. Wait for that tool and do nothing else.';
/**
 * The app-server capture turn text, mirroring the exec prompts' compliance
 * profile: it names the Skill and the probe tool, demands the exact call
 * counts (exactly one Root capture, exactly one spawned Child with one
 * capture), requires the wait, and forbids every other MCP tool — the voice
 * that achieved full exec-path compliance. The structured treatment turn
 * pairs this text with the resolved Skill input item
 * (`{type:'skill', name, path}`) appended by `appServerTurnStartParams`; the
 * text-only control turn sends this text alone (marker-only resolution).
 * Identity-free: the driver injects thread ids only into the JSON-RPC
 * params, never into this text.
 */
export const APP_SERVER_CAPTURE_PROMPT = 'Use $zcode-mcp-context-probe:context. Call capture_context exactly once in Root. Spawn exactly one Child, have it call capture_context once, and wait for it. Do not call any other MCP tool.';

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
 * the trusted `_meta` turn-metadata thread id are distinct namespaces, so the
 * same-thread proof is hash-based between durable captures and no
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
 * Requires the negative-control transcript to show genuine model engagement
 * with the unavailable probe tool, in any of the three shapes this host
 * exhibits (the shape is bimodal model behavior, version-dependent):
 *
 * (a) the recorded "names the tool unavailable" shape: zero nested
 *     `mcp_tool_call` items and at least one bounded excerpt that references
 *     the probe tool or server AND comes from a genuine failure surface — a
 *     top-level `error` frame; an `item.*` frame whose nested `item.type` is
 *     `error`; an `item.*` frame whose nested `item.status` is `failed` or
 *     `error`; or an `agent_message` item whose excerpt both references the
 *     probe tool and states its unavailability (the host's own top-level
 *     errors there are transient transport noise, and the model's explicit
 *     unavailable statement is the bounded tool-unavailable outcome).
 *
 * (b) the failed-attempt engagement shape: at least one nested
 *     `mcp_tool_call` item whose status is `failed` or `error` AND at least
 *     one matching failure excerpt — attempted, errored, never executed.
 *     The failed call items' own excerpts satisfy the matching-excerpt
 *     requirement when they reference the tool.
 *
 * (c) the 0.155.1 introspective-engagement shape: successful nested
 *     `mcp_tool_call` items whose tool names are FOREIGN to the probe (the
 *     host's built-in `list_mcp_resources` / `list_mcp_resource_templates`
 *     introspection completes regardless of the plugin) AND at least one
 *     matching failure excerpt naming the probe tool's unavailability — the
 *     model consulted the MCP catalog, found the probe absent, and said so.
 *
 * The gate always fails closed (PROBE_NEGATIVE_CONTROL_SHAPE) on successful
 * `mcp_tool_call` evidence that REFERENCES the probe tool or server (a
 * completed `capture_context` or `mcp__zcode-mcp-context-probe__*` call) —
 * a real probe-server interaction is never unavailability proof — and on
 * transcripts with no engagement evidence of any shape (a transient model
 * or network error never references the probe tool, so the control must
 * prove the model actually engaged the unavailable tool rather than failing
 * for an unrelated reason, or that an MCP call was misclassified).
 *
 * Division of labor: this assert proves engagement only. The DURABLE WINDOW
 * — zero `server-started` and zero `capture-started` events across the
 * negative-control phase window, checked separately by the caller — remains
 * the hard proof that the server never loaded; engagement evidence can
 * never qualify the control without that clean window. The zero-tolerance
 * rule for successful probe calls derives from the UNCAPPED identity tally
 * (`mcpCallIdentityCounts`, fed by `mcpToolCallIdentityKey` for every
 * nested `mcp_tool_call` item), never from the 32-entry diagnostic excerpt
 * cap — a call beyond the cap has no excerpt but must still reject. When
 * the tally is present it is AUTHORITATIVE and EXCLUSIVE for every
 * call-class decision (a foreign call whose frame merely mentions the probe
 * must never read as a probe call); the excerpt derivation runs only for
 * hand-built fixtures without a tally, and a successful/neutral non-call
 * item never satisfies the gate on its own. Excerpts and their source tags
 * live in memory only — never printed, persisted, or included in error
 * messages — so nothing identifying is retained.
 * @param {{frameTypes: Map<string, number>, nestedItemTypes?: Map<string, number>, excerpts?: {frameType:string, nestedItemType:string|null, itemStatus:string|null, excerpt:string}[], mcpCallIdentityCounts?: Map<string, number>}} account @param {string} label
 */
export function assertToolUnavailableTranscript(account, label) {
  const mcpToolCallItems = account.nestedItemTypes?.get('mcp_tool_call') ?? 0;
  const errorFrames = account.frameTypes.get('error') ?? 0;
  const callExcerptEntries = (account.excerpts ?? []).filter((entry) => entry.nestedItemType === 'mcp_tool_call');
  // The uncapped identity tally counts EVERY nested mcp_tool_call item
  // (mirroring mcpCallStatusCounts), independent of the 32-entry diagnostic
  // excerpt cap: a successful probe call that arrives after the cap filled
  // has no excerpt but must still reject the control. When the tally is
  // present (the real frame parser always supplies it) it is AUTHORITATIVE
  // and EXCLUSIVE for every call-class decision — the whole-frame excerpt
  // scan cannot distinguish a foreign call whose arguments/output merely
  // mention the probe from a real probe call, so OR-ing it in would falsely
  // reject a valid negative control. The excerpt derivation runs ONLY when
  // the tally is absent (hand-built fixtures without a tally).
  const identityCounts = account.mcpCallIdentityCounts ?? null;
  const identityCount = (key) => (identityCounts ? identityCounts.get(key) ?? 0 : 0);
  const successfulProbeCallEvidence = identityCounts
    ? identityCount('probe:successful') > 0
    : callExcerptEntries.some((entry) => (entry.itemStatus === 'completed' || entry.itemStatus === 'ok') && PROBE_TOOL_REFERENCE.test(entry.excerpt));
  const foreignSuccessfulIntrospection = identityCounts
    ? identityCount('foreign:successful') > 0
    : callExcerptEntries.some((entry) => (entry.itemStatus === 'completed' || entry.itemStatus === 'ok') && !PROBE_TOOL_REFERENCE.test(entry.excerpt));
  const failedCallAttempts = identityCounts
    ? identityCount('probe:failed') + identityCount('foreign:failed')
    : callExcerptEntries.filter((entry) => entry.itemStatus === 'failed' || entry.itemStatus === 'error').length;
  const matchedFailureExcerpts = (account.excerpts ?? []).filter((entry) => {
    const unavailableStatement = entry.nestedItemType === 'agent_message'
      && PROBE_TOOL_REFERENCE.test(entry.excerpt)
      && PROBE_UNAVAILABLE_STATEMENT.test(entry.excerpt);
    const failureSource = entry.frameType === 'error'
      || entry.nestedItemType === 'error'
      || entry.itemStatus === 'failed'
      || entry.itemStatus === 'error'
      || unavailableStatement;
    return failureSource && PROBE_TOOL_REFERENCE.test(entry.excerpt);
  }).length;
  const namesTheToolUnavailable = mcpToolCallItems === 0 && matchedFailureExcerpts >= 1;
  const failedAttemptEngagement = failedCallAttempts >= 1 && matchedFailureExcerpts >= 1;
  const introspectiveEngagement = foreignSuccessfulIntrospection && matchedFailureExcerpts >= 1;
  if (successfulProbeCallEvidence || (!namesTheToolUnavailable && !failedAttemptEngagement && !introspectiveEngagement)) {
    throw probeError(
      'PROBE_NEGATIVE_CONTROL_SHAPE',
      `${label}: the transcript does not show the tool-unavailable shape (zero mcp_tool_call items with a matching failure excerpt, or failed-attempt engagement with a matching failure excerpt, or foreign successful MCP introspection beside a matching failure excerpt naming the tool — always with zero successful probe-referencing calls); observed mcp_tool_call items=${mcpToolCallItems}, failed call attempts=${failedCallAttempts}, successful probe call evidence=${successfulProbeCallEvidence ? 'yes' : 'no'}, foreign successful introspection=${foreignSuccessfulIntrospection ? 'yes' : 'no'}, error=${errorFrames}, matching failure excerpts=${matchedFailureExcerpts}.`,
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
 * Derives the closed candidate-strategy table from the measured lifecycle
 * observations (plan Step 7). Multiple matching candidates are retained for
 * Task 6; Task 2 never claims feasibility and `selectedStrategies` stays
 * null.
 * @param {Record<string, {hostProcess?:string, turnTerminalStatus?:string, toolCallOutcome?:string, handlerSettlement?:string, transportState?:string, hookEvent?:string, unknownReason?:string}>} cases
 */
export function deriveCandidateStrategies(cases) {
  // Explicit interruption (plan rows 1-3): the rows are independently
  // additive and deduplicated — row 1 (durable signal-abort settlement)
  // contributes direct-abort, row 2 (interrupted turn plus Stop hook)
  // contributes durable-stop-intent AND release-blocked, row 3 (neither
  // shape observed) contributes release-blocked alone — so a case matching
  // several rows retains every matching candidate for Task 6.
  const interrupt = cases.appServerTurnInterrupt ?? {};
  const abortObserved = interrupt.handlerSettlement === 'signal-abort';
  const interruptedWithStopHook = interrupt.turnTerminalStatus === 'interrupted' && interrupt.hookEvent === 'stop';
  const explicitInterrupt = new Set();
  if (abortObserved) {
    // Row 1: the observed abort settlement is the strongest evidence.
    explicitInterrupt.add('direct-abort');
  }
  if (interruptedWithStopHook) {
    // Row 2: interrupted turn plus a Stop hook keeps both durable candidates.
    explicitInterrupt.add('durable-stop-intent');
    explicitInterrupt.add('release-blocked');
  }
  if (!abortObserved && !interruptedWithStopHook) {
    // Row 3: neither abort nor interrupted-turn-with-Stop-hook observed.
    explicitInterrupt.add('release-blocked');
  }
  // Host loss (plan row: "any tested Host/process loss after durable call
  // start"): not restricted to the SIGKILL case. Every lifecycle case drives
  // the hold tool, so an exited-* hostProcess recorded by ANY tested case is
  // host-loss evidence — the recorded run qualifies via cliSigint
  // (exited-clean), cliSigkill (exited-signal), and both timeout phases
  // (exited-clean). Only when no tested case observed any host exit does the
  // dimension fall back to release-blocked alone: with no host-loss evidence
  // anywhere, durable supervision stays unproven, and release-blocked is the
  // unproven marker every dimension carries.
  const hostLoss = [];
  for (const lifecycleCase of PROBE_LIFECYCLE_CASES) {
    const hostProcess = cases[lifecycleCase]?.hostProcess;
    if (typeof hostProcess === 'string' && hostProcess.startsWith('exited-')) {
      hostLoss.push('durable-supervision', 'release-blocked');
      break;
    }
  }
  if (hostLoss.length === 0) hostLoss.push('release-blocked');
  const hostTimeout = [];
  for (const key of ['pluginToolTimeout', 'directConfigToolTimeout']) {
    const observation = cases[key] ?? {};
    if (observation.handlerSettlement === 'signal-abort' && observation.toolCallOutcome === 'timed-out') {
      if (!hostTimeout.includes('host-abort')) hostTimeout.push('host-abort');
    } else {
      for (const candidate of ['server-deadline', 'durable-supervision', 'release-blocked']) {
        if (!hostTimeout.includes(candidate)) hostTimeout.push(candidate);
      }
    }
  }
  return { explicitInterrupt: [...explicitInterrupt], hostLoss, hostTimeout };
}

/**
 * Pure fail-closed gate for the qualification target: the amended
 * characterization issues 0.155.1-specific app-server requests
 * (`skills/list`, the structured `{type:'skill'}` turn input item,
 * `mcpServer/tool/call`), so ONLY the requalified `codex-cli 0.155.1` may
 * run it. Any other parsed version string — older, newer, truncated, or
 * malformed — throws `PROBE_CODEX_UNSUPPORTED` before any app-server
 * request is issued. The message names the required version and nothing
 * else; the observed version stays in the redacted transcript only.
 * @param {string} versionString the `codex-cli <version>` token the driver parsed from `--version`
 * @returns {string} the validated version string
 */
export function requireRequalifiedCodexVersion(versionString) {
  if (versionString !== REQUALIFIED_CODEX_VERSION) {
    throw probeError('PROBE_CODEX_UNSUPPORTED', 'The supplied codex host is not the requalified codex-cli 0.155.1; the 0.155.1-specific app-server characterization cannot run on it.');
  }
  return versionString;
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
 * Minimal bounded JSON-RPC client for the long-lived `codex app-server`
 * session. Message shapes mirror scripts/lib/codex-app-server.mjs
 * (`initialize`, `initialized`, `thread/start`, `turn/start`,
 * `turn/interrupt`) with `thread/read` and `thread/list` reused directly
 * from that module. Server-to-client requests (elicitation and similar) are
 * answered with a benign result so the characterized conversation never
 * stalls on the driver.
 * @param {{command:string, args:string[], env:NodeJS.ProcessEnv, cwd:string}} options
 */
export function startAppServerSession({ command, args, env, cwd }) {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const identity = captureProcessIdentity(child.pid);
  let nextId = 1;
  let fatalError = null;
  /** @type {Map<number, {resolve:(value:Record<string, any>) => void, reject:(error:Error) => void, timer:NodeJS.Timeout}>} */
  const pending = new Map();
  /** @type {{method:string, params:any}[]} */
  const notifications = [];
  // Redacted overflow counter: frames past the cap are counted, never retained.
  let notificationsOverflow = 0;
  // Redacted delta counter: 0.155.1 streaming-turn deltas are counted and
  // discarded without ever being retained.
  let notificationsDeltaCount = 0;
  // Bounded stdout/stderr accounting (the runBounded discipline — 4 MiB per
  // stream, then the bounded session is terminated). stderr is drained
  // continuously and discarded after counting so a chatty server can neither
  // fill the pipe nor grow the driver's memory.
  let stdoutState = { buffer: '', totalBytes: 0, overflow: false };
  let stderrBytes = 0;
  const terminateOnOverflow = (stream) => {
    transcript(`app-server session: ${stream} exceeded its ${MAXIMUM_OUTPUT_BYTES}-byte bound; the bounded session is terminated`);
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  };
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    const folded = boundedStdoutLines(stdoutState, chunk, MAXIMUM_OUTPUT_BYTES);
    stdoutState = folded.state;
    if (stdoutState.overflow) {
      terminateOnOverflow('stdout');
      return;
    }
    for (const line of folded.lines) {
      if (!line.trim()) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame && typeof frame === 'object' && Number.isInteger(frame.id) && !('method' in frame)) {
        const entry = pending.get(frame.id);
        if (!entry) continue;
        pending.delete(frame.id);
        clearTimeout(entry.timer);
        if (frame.error) entry.reject(probeError('PROBE_APP_SERVER_REQUEST_FAILED', `The app-server rejected ${entry.method ?? 'the request'}.`));
        else entry.resolve(frame.result ?? {});
      } else if (frame && typeof frame === 'object' && typeof frame.method === 'string' && frame.id !== undefined) {
        // Server-to-client request: benign bounded response.
        const result = /elicitation/i.test(frame.method) ? { action: 'cancel' } : {};
        try { child.stdin?.write(`${JSON.stringify({ id: frame.id, result })}\n`); } catch { /* session is ending */ }
      } else if (frame && typeof frame === 'object' && typeof frame.method === 'string') {
        if (APP_SERVER_DELTA_NOTIFICATION.test(frame.method)) {
          // Counted redacted, never retained, never terminating: a delta
          // stream is normal 0.155.1 turn volume, and `continue` keeps the
          // remaining lines of this chunk flowing.
          notificationsDeltaCount += 1;
          continue;
        }
        if (notifications.length < MAXIMUM_APP_SERVER_NOTIFICATIONS) notifications.push({ method: frame.method, params: frame.params });
        else {
          // A discarded frame could be the turn/completed the settled wait
          // depends on: overflow fails the bounded session closed — the same
          // discipline as the 4 MiB bound, settling pending requests through
          // the disconnect path — instead of silently degrading the
          // characterization into a false pending. The redacted counter
          // stays for the transcript.
          notificationsOverflow += 1;
          terminateOnOverflow('notifications');
          return;
        }
      }
    }
  });
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
      entry.reject(probeError('PROBE_APP_SERVER_DISCONNECTED', 'The app-server exited before answering every request.'));
    }
    pending.clear();
  });
  const writeFrame = (value) => {
    if (!child.stdin?.writable) throw probeError('PROBE_APP_SERVER_WRITE_FAILED', 'The app-server stdin is unavailable.');
    child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  return {
    pid: child.pid ?? -1,
    identity,
    /** @type {{method:string, params:any}[]} */
    notifications,
    /** Redacted count of notifications discarded past the bounded cap. */
    get notificationsOverflow() { return notificationsOverflow; },
    /** Redacted count of streamed delta notifications (never retained). */
    get notificationsDeltaCount() { return notificationsDeltaCount; },
    /** @param {string} method @param {Record<string, unknown>} params @param {number} [timeoutMs] */
    request(method, params, timeoutMs = 60_000) {
      if (fatalError) return Promise.reject(fatalError);
      const id = nextId++;
      return new Promise((resolveRequest, rejectRequest) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectRequest(probeError('PROBE_APP_SERVER_TIMEOUT', `The app-server did not answer ${method} in time.`));
        }, timeoutMs);
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer, method });
        try { writeFrame({ id, method, params }); } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          rejectRequest(/** @type {Error} */ (error));
        }
      });
    },
    /** @param {{method:string, params:Record<string, unknown>}} value */
    notify(value) {
      try { writeFrame(value); } catch { /* session is ending */ }
    },
    /** Terminates the bounded session (SIGTERM, then SIGKILL). */
    async terminate() {
      child.stdin?.end();
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        const deadline = Date.now() + 5_000;
        while (isProcessAlive(child.pid ?? -1) && Date.now() < deadline) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
        if (isProcessAlive(child.pid ?? -1)) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
      }
    },
  };
}

/**
 * The exact qualification matrix. Hard failures throw; lifecycle behavior is
 * recorded as honest observations, and soft context assertions stay in the
 * durable log so the final reduced result carries them.
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
  // Fail closed on any host other than the requalified codex-cli 0.155.1,
  // BEFORE fixtures are built or any app-server request is issued: the
  // skills/list, structured-Skill-input, and mcpServer/tool/call requests
  // are 0.155.1 schema, and on another version they would degrade into
  // ordinary resolution failures (the structured treatment would silently
  // disappear) while the run kept emitting mislabeled observations. The
  // existing pinning (realpath + device/inode + the --version recheck
  // before every spawn) is untouched.
  requireRequalifiedCodexVersion(codexVersion);

  // Fail-closed acceptance pre-check for --ignore-rules: the Host argv below
  // depends on the flag, so the parser must accept it before any phase runs.
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
  const marketplaceDirect = join(runDirectory, 'marketplace-skill-only');
  const directCodexHome = join(runDirectory, 'codex-home-direct');
  for (const directory of [isolatedCodexHome, isolatedHome, isolatedTmp, workspaceA, directCodexHome]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(directory, 0o700);
  }
  const isolatedAuthPath = join(isolatedCodexHome, 'auth.json');
  const directAuthPath = join(directCodexHome, 'auth.json');

  const runNonce = randomBytes(32).toString('hex');
  const observer = probeEventPaths(runDirectory);
  const salt = (value) => hashProbeValue(runNonce, value);
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
  /** @type {NodeJS.ProcessEnv} */
  const directHostEnv = { ...hostEnv, CODEX_HOME: directCodexHome };

  /** @type {number[]} */
  /** Recorded as pid → captured start identity so cleanup never signals a recycled PID. */
  const trackedProcesses = new Map();
  /** @type {{root:string, label:string, env:NodeJS.ProcessEnv}[]} */
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
   * Runs one bounded codex CLI command under an isolated env.
   * @param {string[]} args @param {{label:string}} options @param {NodeJS.ProcessEnv} [env]
   */
  const runCodexCommand = async (args, options, env = hostEnv) => {
    const target = await recheckCodex();
    transcript(`${options.label}: exit pending`);
    const run = runBounded(target, args, { cwd: runDirectory, env });
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
   * JSONL accounting (frame types, nested item types, tagged excerpts,
   * thread ids, and bounded spawn handles). Does not await it.
   * @param {string[]} args @param {{cwd:string, label:string, env?:NodeJS.ProcessEnv}} options
   */
  const startHost = async (args, options) => {
    const target = await recheckCodex();
    /** @type {{malformed:number, frameTypes:Map<string, number>, nestedItemTypes:Map<string, number>, mcpCallStatusCounts:Map<string, number>, mcpCallIdentityCounts:Map<string, number>, threadIds:string[], excerpts:{frameType:string, nestedItemType:string|null, itemStatus:string|null, excerpt:string}[], spawnHandles:string[]}} */
    const account = { malformed: 0, frameTypes: new Map(), nestedItemTypes: new Map(), mcpCallStatusCounts: new Map(), mcpCallIdentityCounts: new Map(), threadIds: [], excerpts: [], spawnHandles: [] };
    const run = runBounded(target, args, {
      cwd: options.cwd,
      env: options.env ?? hostEnv,
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
          // Dedicated mcp_tool_call status tally: a count map bounded by the
          // tiny status vocabulary, never by the 32-entry diagnostic excerpt
          // cap — outcome derivation must see every call's status even when
          // the excerpts have overflowed.
          if (nestedItemType === 'mcp_tool_call' && itemStatus !== null) {
            account.mcpCallStatusCounts.set(itemStatus, (account.mcpCallStatusCounts.get(itemStatus) ?? 0) + 1);
          }
          // Uncapped probe/foreign identity tally for every mcp_tool_call
          // item (the negative-control gate's zero-tolerance rule for
          // successful probe calls derives from this, never from the
          // excerpt cap: a call beyond the 32-entry cap has no excerpt but
          // must still reject the control).
          if (nestedItemType === 'mcp_tool_call') {
            const identityKey = mcpToolCallIdentityKey(nestedItem, line);
            if (identityKey !== null) {
              account.mcpCallIdentityCounts.set(identityKey, (account.mcpCallIdentityCounts.get(identityKey) ?? 0) + 1);
            }
          }
          // Excerpts stay bounded and in memory only; each carries its source
          // (top-level frame type plus nested item type/status) so the
          // negative-control gate can demand a genuine failure surface.
          if ((kind === 'error' || kind.startsWith('item.')) && account.excerpts.length < FRAME_EXCERPTS_MAX) {
            account.excerpts.push({ frameType: kind, nestedItemType, itemStatus, excerpt: line.slice(0, FRAME_EXCERPT_MAX_CHARS) });
          }
          // The exact Child handle returned by spawn_agent travels through
          // the collab tool call items; collect the thread-identifier-shaped
          // values they carry (bounded, in memory only).
          if (nestedItemType === 'collab_tool_call' && kind === 'item.completed' && account.spawnHandles.length < 8) {
            // Validate the documented spawn result field — never sweep the
            // frame for UUID-shaped values (parent/call identifiers would
            // otherwise be recorded as child handles).
            const handle = spawnAgentHandleFromFrame(frame);
            if (handle && !account.spawnHandles.includes(handle)) account.spawnHandles.push(handle);
          }
        } catch { account.malformed += 1; }
      },
    });
    trackedProcesses.set(run.pid, run.identity);
    transcript(`${options.label}: host pid tracked`);
    return { ...run, account };
  };

  const durableEvents = () => readProbeEvents({ runDirectory, runNonce });
  /**
   * The server process whose durable startup is recorded latest: each phase
   * starts a fresh probe server, so at observation time the latest
   * server-started event is the phase's own server. Returns null when no
   * server startup is durably recorded (nothing has been observed about any
   * server).
   */
  const latestRecordedServerPid = async () => {
    const starts = (await durableEvents()).filter((record) => record.event.kind === 'server-started');
    const last = starts.at(-1);
    return last && Number.isSafeInteger(last.event.serverPid) && last.event.serverPid > 0 ? last.event.serverPid : null;
  };
  const countKind = async (kind) => (await durableEvents()).filter((record) => record.event.kind === kind).length;
  /** Snapshot of the durable capture-started event bodies, for window attribution. */
  const durableCaptureEvents = async () => (await durableEvents())
    .filter((record) => record.event.kind === 'capture-started')
    .map((record) => record.event);
  /**
   * Bounded wait (see captureCensusSettled) for the durable capture census
   * to stop growing: gives a late Child capture a chance to enter the
   * refreshed post-turn window. The stability clock resets on every census
   * growth (lastChangeMs tracks the elapsed time of the most recent
   * change), so a capture arriving near the wait's start cannot let the
   * next unchanged poll settle the window prematurely. Returns the settled
   * census count.
   * @param {number} baselineCount
   */
  const waitForCaptureCensusSettled = async (baselineCount) => {
    const startedAt = Date.now();
    let previousCount = baselineCount;
    let lastChangeMs = 0;
    for (;;) {
      await new Promise((resolveWait) => setTimeout(resolveWait, CAPTURE_SETTLE_POLL_MS));
      const currentCount = await countKind('capture-started');
      const elapsedMs = Date.now() - startedAt;
      if (currentCount > previousCount) lastChangeMs = elapsedMs;
      if (captureCensusSettled({ previousCount, currentCount, elapsedMs, lastChangeMs })) return currentCount;
      if (currentCount > previousCount) previousCount = currentCount;
    }
  };
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
   * Requires exactly one fresh durable hold-started event (one more than the
   * current census) so the held call's settlement is attributable.
   * @param {number} previousCount @param {string} label @param {number} [deadlineMs]
   */
  const requireFreshHoldStarted = async (previousCount, label, deadlineMs = SUBPROCESS_DEADLINE_MS) => {
    await waitUntil(async () => (await countKind('hold-started')) >= previousCount + 1,
      deadlineMs, `${label}: hold-started never became durable`);
    return latestHoldCallNonce(await durableEvents());
  };

  /**
   * Enables the fixture hooks in the target isolated Codex home: the hooks
   * feature flag plus per-hook trust entries read from that home's
   * app-server hooks/list. Without trust the Host silently skips plugin
   * hooks, so the lifecycle hookEvent observations and the hook equality
   * columns would never see any evidence. Every home whose observations must
   * be comparable — the plugin home and the direct-config home alike — runs
   * this before its phases. The trust data comes from the same pinned binary
   * via a short-lived bounded session that is terminated immediately.
   * @param {NodeJS.ProcessEnv} [env] defaults to the plugin-phase host env
   */
  const enableProbeHooks = async (env = hostEnv) => {
    const trustSession = startAppServerSession({ command: await recheckCodex(), args: ['app-server'], env, cwd: runDirectory });
    trackedProcesses.set(trustSession.pid, trustSession.identity);
    try {
      await trustSession.request('initialize', appServerInitializeParams(), 60_000);
      trustSession.notify({ method: 'initialized', params: {} });
      const list = await trustSession.request('hooks/list', {}, 60_000);
      const configPath = join(env.CODEX_HOME, 'config.toml');
      const existing = await readFile(configPath, 'utf8').catch(() => '');
      // Ensure the feature flag is actually on (patch, never assume) — a
      // pre-existing [features] table omitting or disabling hooks would
      // otherwise leave the trusted hooks unexecuted and the required Hook
      // authority facts uncollectable.
      let patched = ensureHooksFeatureFlag(existing);
      for (const entry of list?.data ?? []) {
        for (const hook of entry.hooks ?? []) {
          patched += `\n[hooks.state."${hook.key}"]\ntrusted_hash = "${hook.currentHash}"\n`;
        }
      }
      if (patched !== existing) await writeFile(configPath, patched, { encoding: 'utf8' });
      transcript('hooks: fixture hooks enabled and trusted in the isolated codex home');
    } finally {
      await trustSession.terminate();
    }
  };

  /**
   * Waits for one fresh durable hold-started event and returns its nonce, or
   * null when the bounded wait expires (the characterization continues).
   * @param {number} previousCount @param {number} deadlineMs
   */
  const waitForFreshHoldStartedOrNull = async (previousCount, deadlineMs) => {
    try {
      await waitUntil(async () => (await countKind('hold-started')) >= previousCount + 1, deadlineMs, '');
      return latestHoldCallNonce(await durableEvents());
    } catch {
      return null;
    }
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

  /**
   * Resumes argv, launched with process cwd equal to the target workspace.
   * @param {string} workspace @param {string} rootThreadId @param {string} prompt
   */
  const resumeArgs = (workspace, rootThreadId, prompt) => [
    'exec', 'resume', '--json', '--all', '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox', '--ignore-rules', rootThreadId, prompt,
  ];

  /**
   * Counts hook-observed events of one hook name inside a durable window.
   * @param {number} windowStartIndex @param {string} hookName
   */
  const hookEventsFrom = async (windowStartIndex, hookName) => {
    const hooks = (await durableEvents()).filter((record) => record.event.kind === 'hook-observed');
    return hooks.slice(windowStartIndex).filter((record) => record.event.hook === hookName);
  };

  /** Snapshot of the hook-event census used to bound observation windows. */
  const hookCensus = async () => (await durableEvents()).filter((record) => record.event.kind === 'hook-observed').length;

  /**
   * The closed hookEvent observation for a window: a Stop hook outranks a
   * SessionEnd hook; silence is `not-observed`.
   * @param {number} windowStartIndex
   */
  const hookEventInWindow = async (windowStartIndex) => {
    if ((await hookEventsFrom(windowStartIndex, 'stop')).length > 0) return 'stop';
    if ((await hookEventsFrom(windowStartIndex, 'session-end')).length > 0) return 'session-end';
    return 'not-observed';
  };

  /** Computes the salted equality facts between a capture and an authority. */
  /** Records one equality-fact event. */
  const recordEqualityFact = async (fact) => {
    await appendProbeEvent({
      runDirectory,
      runNonce,
      event: { kind: 'equality-fact', scope: fact.scope, candidate: fact.candidate, authority: fact.authority, equal: fact.equal },
    });
  };

  /** Records one authority-hash event. */
  const recordAuthorityHash = async (authority, scope, hash) => {
    await appendProbeEvent({ runDirectory, runNonce, event: { kind: 'authority-hash', authority, scope, hash } });
  };

  /** Records one closed lifecycle observation. */
  const recordLifecycleObservation = async (lifecycleCase, observation) => {
    await appendProbeEvent({ runDirectory, runNonce, event: { kind: 'lifecycle-observed', lifecycleCase, ...observation } });
  };

  /** @type {{failed:true, error:unknown}|{failed:false, value:Record<string, boolean>}} */
  let qualificationOutcome;
  try {
    // The credential copies live inside the protected scope so any failure
    // after them always reaches the verified-deletion cleanup.
    await copyFile(join(sourceCodexHomeRoot, 'auth.json'), isolatedAuthPath);
    if (process.platform !== 'win32') await chmod(isolatedAuthPath, 0o600);
    await copyFile(join(sourceCodexHomeRoot, 'auth.json'), directAuthPath);
    if (process.platform !== 'win32') await chmod(directAuthPath, 0o600);
    await mkdir(marketplaceSlow, { recursive: true, mode: 0o700 });
    await mkdir(marketplaceFast, { recursive: true, mode: 0o700 });
    await mkdir(marketplaceDirect, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      await chmod(marketplaceSlow, 0o700);
      await chmod(marketplaceFast, 0o700);
      await chmod(marketplaceDirect, 0o700);
    }
    await buildProbeMarketplace({ output: marketplaceSlow, server: moduleServerPath(), toolTimeoutSec: 30, mode: 'plugin-server' });
    await buildProbeMarketplace({ output: marketplaceFast, server: moduleServerPath(), toolTimeoutSec: 2, mode: 'plugin-server' });
    await buildProbeMarketplace({ output: marketplaceDirect, server: moduleServerPath(), toolTimeoutSec: 2, mode: 'skill-only' });
    transcript('fixtures: probe marketplaces built (30s and 2s plugin-server, 2s skill-only)');

    const loginStatus = await runCodexCommand(['login', 'status'], { label: 'login-status' });
    if (loginStatus.code !== 0) {
      throw probeError('PROBE_QUALIFICATION_UNAVAILABLE', 'qualification-unavailable: the isolated Codex home failed `codex login status`.');
    }
    await installMarketplace(marketplaceSlow, 'slow');
    await enableProbeHooks();

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
      throw probeError('PROBE_NEGATIVE_CONTROL_FAILED', 'The negative-control Host durably loaded or called the probe server under --ignore-user-config.');
    }
    await observePhase('negative-control');
    transcript('phase-negative-control: window free of server/capture events; marker recorded');

    // Phase 1: the scripted matrix conversation in workspace A.
    await observePhase('matrix');
    const matrixHooksBefore = await hookCensus();
    const matrixHost = await startHost(newConversationArgs(workspaceA, MATRIX_PROMPT), { cwd: workspaceA, label: 'phase-matrix' });
    const matrixResult = await matrixHost.promise;
    assertConversationRan(matrixResult, matrixHost.account, 'phase-matrix');
    if (matrixHost.account.threadIds.length !== 1) {
      throw probeError('PROBE_HOST_FRAMES', `phase-matrix: expected exactly one thread.started, observed ${matrixHost.account.threadIds.length}.`);
    }
    const rootThreadId = matrixHost.account.threadIds[0];
    transcript(`phase-matrix: thread started ([redacted-thread]) frames=${frameSummary(matrixHost.account)}`);
    await requireExactCaptureCount(MATRIX_CAPTURES_EXPECTED, 'phase-matrix');
    // The exact Child handle returned by spawn_agent, hashed as durable
    // authority evidence for the child equality column.
    for (const handle of matrixHost.account.spawnHandles.slice(0, 4)) {
      await recordAuthorityHash('returnedChildHandle', 'child', salt(handle));
    }
    if (matrixHost.account.spawnHandles.length > 0) {
      transcript(`phase-matrix: ${matrixHost.account.spawnHandles.length} returned child handles hashed`);
    }
    // Hook observations in the matrix window (exec conversations may not fire
    // plugin hooks; silence is recorded honestly, never fabricated).
    const matrixSessionStart = (await hookEventsFrom(matrixHooksBefore, 'session-start'))[0] ?? null;
    const matrixPromptSubmit = (await hookEventsFrom(matrixHooksBefore, 'user-prompt-submit'))[0] ?? null;
    const matrixSubagentStarts = await hookEventsFrom(matrixHooksBefore, 'subagent-start');

    // Phase 2: state-machine step 2 — the Root resume in workspace A via
    // exec resume --all. Requires exit 0, the same stdout thread.started
    // thread id, a different observed turn, and its durable event, proven
    // hash-based between the durable captures below. Recorded 0.154.0 fact:
    // the stdout `thread.started` id (the id this driver resumes with) and
    // the trusted `_meta` turn-metadata thread id are distinct namespaces, so
    // the same-thread proof is never taken against the stdout id.
    const resumeHost = await startHost(resumeArgs(workspaceA, rootThreadId, ROOT_RESUME_PROMPT), { cwd: workspaceA, label: 'phase-matrix-resume' });
    const resumeResult = await resumeHost.promise;
    assertConversationRan(resumeResult, resumeHost.account, 'phase-matrix-resume');
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
    await recordAuthorityHash('stdoutThreadId', 'root', salt(rootThreadId));

    // Phase 3: CLI SIGINT delivery to a held call. One 10-second window
    // covers BOTH the exit and the settlement; cleanup-killing leftovers is
    // never converted into a cancellation observation.
    await observePhase('cli-sigint');
    const sigintHooksBefore = await hookCensus();
    const holdsBeforeSigint = await countKind('hold-started');
    const sigintHost = await startHost(newConversationArgs(workspaceA, HOLD_PROMPT), { cwd: workspaceA, label: 'phase-sigint' });
    const sigintCallNonce = await requireFreshHoldStarted(holdsBeforeSigint, 'phase-sigint');
    assertProcessIdentity(sigintHost.pid, sigintHost.identity);
    transcript('phase-sigint: SIGINT sent to recorded host pid');
    try { process.kill(sigintHost.pid, 'SIGINT'); } catch (error) {
      throw probeError('PROBE_SIGNAL_FAILED', `phase-sigint: SIGINT could not be delivered (${errorCode(error)}).`);
    }
    const sigintDeadline = Date.now() + SIGNAL_GRACE_MS;
    let sigintHostExit = null;
    try {
      sigintHostExit = await Promise.race([
        sigintHost.promise,
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), Math.max(1, sigintDeadline - Date.now()));
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
    } catch { /* the bounded Host spawn rejected: recorded as unknown below */ }
    const sigintSettlement = await settlementArrived(sigintCallNonce, Math.max(0, sigintDeadline - Date.now()), durableEvents);
    // The server's transport state is observed from the server itself (its
    // durable settlement and its durably recorded pid) — never inferred from
    // the Host's exit: the server's pending handler may outlive the Host.
    const sigintServerPid = await latestRecordedServerPid();
    const sigintServerAlive = sigintServerPid === null ? null : isProcessAlive(sigintServerPid);
    await recordLifecycleObservation('cliSigint', {
      hostProcess: sigintHostExit === null ? (isProcessAlive(sigintHost.pid) ? 'running' : 'unknown')
        : sigintHostExit.signal !== null ? 'exited-signal' : 'exited-clean',
      turnTerminalStatus: 'not-observed',
      toolCallOutcome: 'pending',
      handlerSettlement: sigintSettlement ?? 'not-observed',
      transportState: deriveTransportState({ settlement: sigintSettlement, serverAlive: sigintServerAlive }),
      hookEvent: await hookEventInWindow(sigintHooksBefore),
      unknownReason: sigintSettlement !== null ? 'none' : (sigintHostExit !== null ? 'process-exited-first' : 'ceiling-reached'),
    });
    transcript(`phase-sigint: cancellation observation recorded (handlerSettlement=${sigintSettlement ?? 'not-observed'})`);
    if (sigintHostExit === null && isProcessAlive(sigintHost.pid)) {
      // Cleanup only: the Host ignored SIGINT, so it is stopped and the
      // observation above stays untouched.
      await stopProcess(sigintHost.pid, 'SIGKILL', 5_000, sigintHost.identity);
      transcript('phase-sigint: host ignored SIGINT; exact pid SIGKILLed during cleanup');
    }
    await trackServerProcesses(true);

    // Phase 4: SIGKILL disconnect observation. One 10-second window covers
    // the exit, the stdin-EOF settlement, and the server exit.
    await observePhase('cli-sigkill');
    const holdsBeforeSigkill = await countKind('hold-started');
    const sigkillHost = await startHost(newConversationArgs(workspaceA, HOLD_PROMPT), { cwd: workspaceA, label: 'phase-sigkill' });
    const sigkillCallNonce = await requireFreshHoldStarted(holdsBeforeSigkill, 'phase-sigkill');
    assertProcessIdentity(sigkillHost.pid, sigkillHost.identity);
    try { process.kill(sigkillHost.pid, 'SIGKILL'); } catch (error) {
      throw probeError('PROBE_SIGNAL_FAILED', `phase-sigkill: SIGKILL could not be delivered (${errorCode(error)}).`);
    }
    const sigkillDeadline = Date.now() + SIGNAL_GRACE_MS;
    let sigkillHostExit = null;
    try {
      sigkillHostExit = await Promise.race([
        sigkillHost.promise,
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), Math.max(1, sigkillDeadline - Date.now()));
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
    } catch { /* recorded as unknown below */ }
    const sigkillSettlement = await settlementArrived(sigkillCallNonce, Math.max(0, sigkillDeadline - Date.now()), durableEvents);
    // Server-side observation, as in the SIGINT phase: the Host's exit never
    // implies the server's.
    const sigkillServerPid = await latestRecordedServerPid();
    const sigkillServerAlive = sigkillServerPid === null ? null : isProcessAlive(sigkillServerPid);
    await recordLifecycleObservation('cliSigkill', {
      hostProcess: sigkillHostExit === null ? (isProcessAlive(sigkillHost.pid) ? 'running' : 'unknown')
        : sigkillHostExit.signal !== null ? 'exited-signal' : 'exited-clean',
      turnTerminalStatus: 'not-observed',
      toolCallOutcome: 'pending',
      handlerSettlement: sigkillSettlement ?? 'not-observed',
      transportState: deriveTransportState({ settlement: sigkillSettlement, serverAlive: sigkillServerAlive }),
      hookEvent: 'not-observed',
      unknownReason: sigkillSettlement !== null ? 'none' : (sigkillHostExit !== null ? 'process-exited-first' : 'ceiling-reached'),
    });
    if (sigkillHostExit === null && isProcessAlive(sigkillHost.pid)) {
      await stopProcess(sigkillHost.pid, 'SIGKILL', 5_000, sigkillHost.identity);
    }
    transcript(`phase-sigkill: disconnect observation recorded (handlerSettlement=${sigkillSettlement ?? 'not-observed'})`);
    await trackServerProcesses(true);

    // Phase 5: app-server characterization — bounded `skills/list` Skill
    // resolution, a structured-Skill treatment capture turn, a text-only
    // control capture turn (marker-only resolution), a diagnostic-only
    // `mcpServer/tool/call` transport control, and the durable-hold-gated
    // `turn/interrupt` characterization. The app-server runs in the same
    // isolated home so the probe plugin, its MCP server, and the fixture
    // hooks all participate; plugin hooks fire on the exec path too once
    // enabled and trusted (the recorded run observed SessionEnd and Stop
    // there).
    await observePhase('app-server-interrupt');
    const appServerHooksBefore = await hookCensus();
    const appServerTarget = await recheckCodex();
    const appServerSession = startAppServerSession({ command: appServerTarget, args: ['app-server'], env: hostEnv, cwd: runDirectory });
    trackedProcesses.set(appServerSession.pid, appServerSession.identity);
    transcript('phase-app-server: session started and tracked');
    const appServerReadOptions = {
      executable: appServerTarget,
      args: ['app-server'],
      env: hostEnv,
      cwd: runDirectory,
      timeoutMs: 60_000,
    };
    /**
     * Reads a thread's persisted spawn children; a failed read returns an
     * empty list (capture attribution stays closed) and is transcribed.
     * @param {string|null} threadId
     */
    const readThreadChildren = async (threadId) => {
      if (threadId === null) return [];
      return listCodexThreadSpawnChildren(threadId, appServerReadOptions).catch(() => {
        transcript('phase-app-server: the app-server Root spawn-children read failed; capture attribution stays closed');
        return [];
      });
    };
    const startAppServerThread = async (label) => {
      const started = await appServerSession.request('thread/start', appServerThreadStartParams(workspaceA), HOST_CONVERSATION_DEADLINE_MS);
      const threadId = started?.thread?.id;
      if (typeof threadId !== 'string' || !threadId) {
        throw probeError('PROBE_APP_SERVER_THREAD_START_FAILED', `${label}: the app-server thread/start response omitted its thread id.`);
      }
      return threadId;
    };
    /**
     * Runs one bounded turn on a thread and waits for its terminal status.
     * @param {string} threadId @param {string} text @param {{name:string, path:string}|null} skill @param {string} label
     * @returns {Promise<{turnId:string, status:'completed'|'failed'|'interrupted'|null}>}
     */
    const runBoundedTurn = async (threadId, text, skill, label) => {
      const turn = await appServerSession.request('turn/start', appServerTurnStartParams(threadId, text, skill), HOST_CONVERSATION_DEADLINE_MS);
      const turnId = turn?.turn?.id;
      if (typeof turnId !== 'string') {
        throw probeError('PROBE_APP_SERVER_TURN_START_FAILED', `${label}: the app-server turn/start response omitted its turn id.`);
      }
      const status = await appServerTurnSettled(appServerSession, threadId, turnId, HOST_CONVERSATION_DEADLINE_MS);
      transcript(`phase-app-server: ${label} turn ${status === 'completed' ? 'completed' : status === null ? 'hit its outer ceiling' : `ended (${status})`}`);
      return { turnId, status };
    };
    await (async () => {
      const initialize = await appServerSession.request('initialize', appServerInitializeParams());
      if (!initialize || typeof initialize !== 'object') {
        throw probeError('PROBE_APP_SERVER_INITIALIZE_FAILED', 'The app-server initialize handshake returned no result.');
      }
    })();
    appServerSession.notify({ method: 'initialized', params: {} });
    // Skill resolution — the first of the two previously confounded
    // variables. The installed probe Skill is resolved by the app-server
    // itself via a bounded `skills/list` request over the probe workspace
    // with a forced reload; the exact host-reported name/path feed the
    // structured Skill input item. A failed resolution is recorded honestly:
    // the structured treatment turn cannot run and the authority gate stays
    // closed on the structured path.
    let probeSkillEntry = null;
    let skillsListFailed = false;
    try {
      const skillsList = await appServerSession.request('skills/list', appServerSkillsListParams([workspaceA]), 60_000);
      probeSkillEntry = resolveProbeSkillEntry(skillsList?.data ?? null, { pluginName: PROBE_PLUGIN_NAME, skillName: PROBE_SKILL_NAME });
    } catch (resolveError) {
      skillsListFailed = true;
      transcript(`phase-app-server: skills/list failed (${resolveError && typeof resolveError === 'object' && 'code' in resolveError ? /** @type {any} */ (resolveError).code : 'error'})`);
    }
    transcript(probeSkillEntry
      ? 'phase-app-server: probe skill resolved via skills/list ([redacted-path])'
      : 'phase-app-server: probe skill NOT resolved; the structured Skill input cannot be sent');
    // The control outcomes are durable evidence, not transcript chatter: the
    // reduction (and therefore any committed artifact) requires exactly one
    // validated app-server-control event per control, so a run where the
    // structured injection or the transport control never ran can never be
    // confused with one where it did.
    await appendProbeEvent({
      runDirectory,
      runNonce,
      event: { kind: 'app-server-control', control: 'skill-resolution', outcome: probeSkillEntry !== null ? 'resolved' : skillsListFailed ? 'failed' : 'unresolved', captures: 0 },
    });

    // (a) Treatment turn: the structured Skill input (text item first, then
    // `{type:'skill', name, path}`) so app-server injects the full Skill
    // instructions instead of relying on model-side marker resolution. The
    // prompt keeps the exec-compliance voice (one Root capture, one spawned
    // Child capture). The authority gate may open ONLY on captures
    // attributable to this turn's threads.
    const capturesBeforeTreatmentEvents = await durableCaptureEvents();
    let treatmentThreadId = null;
    let treatmentTurnId = null;
    let treatmentStatus = null;
    if (probeSkillEntry !== null) {
      treatmentThreadId = await startAppServerThread('structured treatment');
      const treatment = await runBoundedTurn(treatmentThreadId, APP_SERVER_CAPTURE_PROMPT, probeSkillEntry, 'structured-Skill capture');
      treatmentTurnId = treatment.turnId;
      treatmentStatus = treatment.status;
    } else {
      transcript('phase-app-server: structured-Skill capture turn skipped (no resolved skill entry)');
    }
    const capturesAfterTurnEvents = await durableCaptureEvents();
    // Children are read from persisted state AFTER the turn: the list covers
    // every Child spawned within the turn's window, including one whose own
    // capture lands after the turn went terminal. Turn windows are therefore
    // attributed by identity set — the turn's own thread plus its spawned
    // children's salted ids — never by a global census: a late
    // child-of-treatment capture landing inside the control window belongs
    // to the treatment turn, not to the text-only control.
    const treatmentChildren = await readThreadChildren(treatmentThreadId);
    // Bounded settle, strictly after child discovery: a late child capture
    // gets a bounded chance to land, and the post-turn window snapshot is
    // REFRESHED from the durable log afterwards — so the late capture is
    // inside the refreshed window for BOTH the attributed delta and the
    // authority gate's Root/Child pairing slice. The control turn's BEFORE
    // baseline is this same refreshed snapshot, so the late capture remains
    // excluded there.
    await waitForCaptureCensusSettled(capturesAfterTurnEvents.length);
    const capturesAfterTreatmentEvents = await durableCaptureEvents();
    const treatmentThreadHashes = [
      ...(treatmentThreadId === null ? [] : [salt(treatmentThreadId)]),
      ...treatmentChildren.map((child) => typeof child.id === 'string' ? salt(child.id) : null),
    ];
    const treatmentCaptureDelta = attributableCaptureCount(capturesBeforeTreatmentEvents, capturesAfterTreatmentEvents, treatmentThreadHashes);
    transcript(`phase-app-server: structured-Skill turn produced ${treatmentCaptureDelta} attributable durable capture(s)`);
    if (capturesAfterTreatmentEvents.length > capturesAfterTurnEvents.length) {
      transcript(`phase-app-server: ${capturesAfterTreatmentEvents.length - capturesAfterTurnEvents.length} late capture(s) entered the treatment window during settle`);
    }
    await appendProbeEvent({
      runDirectory,
      runNonce,
      event: {
        kind: 'app-server-control',
        control: 'structured-treatment-turn',
        outcome: probeSkillEntry === null ? 'skipped'
          : treatmentStatus === 'completed' ? 'completed'
            : treatmentStatus === 'failed' ? 'failed'
              : treatmentStatus === 'interrupted' ? 'interrupted' : 'ceiling',
        captures: treatmentCaptureDelta,
      },
    });

    // (b) Control turn: the historical text-only shape (the Skill marker in
    // the prompt text only — marker-only resolution). Its captures are
    // recorded as observations but NEVER feed the authority gate; its window
    // is attributed to its own thread and children exactly like the
    // treatment turn's.
    const controlThreadId = await startAppServerThread('text-only control');
    const controlTurn = await runBoundedTurn(controlThreadId, APP_SERVER_CAPTURE_PROMPT, null, 'text-only control capture');
    // Mirror of the treatment path: children first, then the bounded
    // settle, then the REFRESHED window snapshot — a control Child whose
    // capture lands after turn/completed is admitted to the control's
    // durable count instead of being omitted (which would invalidate the
    // treatment/control comparison). The BEFORE baseline stays the
    // refreshed post-treatment snapshot, so late child-of-treatment
    // captures remain excluded here.
    const controlChildren = await readThreadChildren(controlThreadId);
    await waitForCaptureCensusSettled(capturesAfterTreatmentEvents.length);
    const capturesAfterControlEvents = await durableCaptureEvents();
    const controlThreadHashes = [
      salt(controlThreadId),
      ...controlChildren.map((child) => typeof child.id === 'string' ? salt(child.id) : null),
    ];
    const controlCaptureDelta = attributableCaptureCount(capturesAfterTreatmentEvents, capturesAfterControlEvents, controlThreadHashes);
    transcript(`phase-app-server: text-only control turn produced ${controlCaptureDelta} attributable durable capture(s)`);
    await appendProbeEvent({
      runDirectory,
      runNonce,
      event: {
        kind: 'app-server-control',
        control: 'text-only-control-turn',
        outcome: controlTurn.status === 'completed' ? 'completed'
          : controlTurn.status === 'failed' ? 'failed'
            : controlTurn.status === 'interrupted' ? 'interrupted' : 'ceiling',
        captures: controlCaptureDelta,
      },
    });
    // Salted equality facts: the app-server reads the exact exec Root/Child
    // thread records (thread/read + thread/list) and the driver compares
    // their salted hashes against the durable MCP capture candidates. The
    // facts are structurally gated on the structured-Skill treatment path's
    // own MCP observation (appServerCaptureEvidenceGate): without a completed
    // structured treatment turn producing Root/Child captures attributable to
    // that turn's threads, NO app-server-path equality facts are recorded
    // (the text-only control turn's captures never feed the gate), so the
    // reducer's appServerThreadId cells stay fact-less and
    // identityNamespaceQualified cannot qualify from them. Hook columns are
    // recorded only when hook evidence exists.
    // The gate consumes the structured turn's window captures (the snapshot
    // delta) and the children already read for that turn's attribution: a
    // capture outside the treatment window (the text-only control turn's
    // window, the transport-control diagnostic) is never authority evidence.
    const treatmentCaptureEvents = capturesAfterTreatmentEvents.slice(capturesBeforeTreatmentEvents.length);
    const appServerSpawnChildren = treatmentChildren;
    // Capture attribution is by ANY candidate hash (discovery, not
    // preselection): the gate identifies which treatment-window captures
    // belong to the structured turn's Root and to one of its persisted
    // children without assuming which _meta field carries the identity.
    const captureGate = appServerCaptureEvidenceGate({
      turnStatus: treatmentStatus,
      freshCaptures: treatmentCaptureEvents.map((capture) => ({
        envelopeThreadIdHash: capture.envelopeThreadIdHash ?? null,
        innerSessionIdHash: capture.innerSessionIdHash ?? null,
        threadHash: capture.threadHash ?? null,
      })),
      rootThreadCandidateHashes: treatmentThreadId === null ? [] : [salt(treatmentThreadId)],
      childThreadCandidateHashes: appServerSpawnChildren.map((child) => typeof child.id === 'string' ? [salt(child.id)] : []),
    });
    if (!captureGate.collected) {
      transcript('phase-app-server: app-server capture evidence not collected (no completed turn or no Root/Child captures attributable to the app-server-created threads); app-server-path equality facts stay unrecorded');
    }
    const childTurnsOf = async (childRecord) => {
      try {
        const childThread = await readCodexThread(childRecord.id, appServerReadOptions);
        return Array.isArray(childThread?.turns) ? childThread.turns : [];
      } catch (readError) {
        transcript(`phase-app-server: a child thread read failed (${readError && typeof readError === 'object' && 'code' in readError ? /** @type {any} */ (readError).code : 'error'})`);
        return [];
      }
    };
    if (captureGate.collected) {
      // The fresh app-server-path captures join the namespace cells
      // themselves: the qualification rests on MCP metadata actually
      // observed on the app-server Root/Child path, not only on the exec
      // captures read back through the app-server.
      const freshRootCapture = captureGate.rootCaptureIndex === null ? null : treatmentCaptureEvents[captureGate.rootCaptureIndex] ?? null;
      const freshChildCapture = captureGate.childCaptureIndex === null ? null : treatmentCaptureEvents[captureGate.childCaptureIndex] ?? null;
      const freshChildRecord = captureGate.childRecordIndex === null ? null : appServerSpawnChildren[captureGate.childRecordIndex] ?? null;
      if (freshRootCapture) {
        await recordAuthorityHash('appServerThreadId', 'root', salt(treatmentThreadId));
        // The structured capture turn's id is driver-known (the turn/start
        // response): recorded as the appServerTurnId authority and joined to
        // the fresh Root capture's turn, so the root turn cell carries the
        // app-server-path turn evidence and not just the exec path's.
        await recordAuthorityHash('appServerTurnId', 'root', salt(treatmentTurnId));
        for (const fact of freshCaptureJoinFacts(freshRootCapture, { scope: 'root', threadHash: salt(treatmentThreadId), turnHash: salt(treatmentTurnId) })) await recordEqualityFact(fact);
      }
      if (freshChildCapture && freshChildRecord) {
        // The spawn is model-driven, so no driver-known turn/start id exists
        // for the Child: its first turn id is only learnable from thread/read.
        // Emit what is known — the thread join always, the turn join when the
        // read supplied the child's first turn id.
        const freshChildTurns = await childTurnsOf(freshChildRecord);
        // The fresh Child carries exactly one turn (its capture turn); a
        // read returning anything else is not a joinable single identity.
        const freshChildTurnHash = freshChildTurns.length === 1 && freshChildTurns[0] && typeof freshChildTurns[0].id === 'string'
          ? salt(freshChildTurns[0].id)
          : null;
        await recordAuthorityHash('appServerThreadId', 'child', salt(freshChildRecord.id));
        if (freshChildTurnHash) await recordAuthorityHash('appServerTurnId', 'child', freshChildTurnHash);
        for (const fact of freshCaptureJoinFacts(freshChildCapture, { scope: 'child', threadHash: salt(freshChildRecord.id), turnHash: freshChildTurnHash })) await recordEqualityFact(fact);
      }
      const execRootThread = await readCodexThread(rootThreadId, appServerReadOptions);
      if (execRootThread && typeof execRootThread.id === 'string') {
        await recordAuthorityHash('appServerThreadId', 'root', salt(execRootThread.id));
        // Turn correlation is identity-based: thread/read's turn ordering is
        // non-contractual (scripts/lib/codex-app-server.mjs), so the two Root
        // captures correlate with the persisted Root turns by multiset
        // equality over the salted turn-id hashes — never by array position;
        // newest-first and oldest-first reads produce the same fact.
        const rootTurns = correlateTurnSet(
          [captureEvents[0], captureEvents[MATRIX_CAPTURES_EXPECTED]],
          Array.isArray(execRootThread.turns) ? execRootThread.turns : [],
          salt,
        );
        for (const turnHash of rootTurns.saltedTurnIdHashes) {
          await recordAuthorityHash('appServerTurnId', 'root', turnHash);
        }
        for (const fact of captureAuthorityFacts(captureEvents[0], 'root', 'appServerThreadId', salt(execRootThread.id))) {
          await recordEqualityFact(fact);
        }
        await recordEqualityFact({ scope: 'root', candidate: 'innerTurnId', authority: 'appServerTurnId', equal: rootTurns.equal });
      }
    }
    if (captureGate.collected) {
      const execChildren = await listCodexThreadSpawnChildren(rootThreadId, appServerReadOptions);
      const orderedChildren = [...execChildren].sort((left, right) => Number(left.createdAt ?? 0) - Number(right.createdAt ?? 0));
      transcript(`phase-app-server: ${orderedChildren.length} persisted child threads read from the exec Root`);
      // Child equality evidence. The initial Child was created and captured
      // before the concurrent pair was spawned, so its persisted record is
      // positionally unambiguous by creation order and pairs per-capture. The
      // two CONCURRENT-Child captures are correlated as a set instead: their
      // durable capture order is completion-dependent, so positional pairing
      // could compare each capture with the wrong Child and emit false
      // equality facts that fail a valid namespace. saltedHashSetsEqual proves
      // the group bijection — the multiset of capture hashes equals the
      // multiset of persisted child hashes — with no positional assumption,
      // keeping the cell semantics: a matrix cell is true only when every
      // recorded fact (the initial per-pair fact and the concurrent set fact)
      // is true.
      const initialCapture = captureEvents[1];
      const followupCapture = captureEvents[2];
      const initialRecord = orderedChildren[0];
      if (initialCapture && initialRecord && typeof initialRecord.id === 'string') {
        await recordAuthorityHash('appServerThreadId', 'child', salt(initialRecord.id));
        // The matrix creates TWO turns on the initial Child (the original
        // call and the followup), and thread/read's turn ordering is
        // non-contractual: BOTH Child captures correlate with the persisted
        // turn set by multiset equality over the salted turn-id hashes —
        // never by array position — so the follow-up capture is joined too.
        const childTurns = correlateTurnSet([initialCapture, followupCapture], await childTurnsOf(initialRecord), salt);
        for (const turnHash of childTurns.saltedTurnIdHashes) {
          await recordAuthorityHash('appServerTurnId', 'child', turnHash);
        }
        for (const fact of captureAuthorityFacts(initialCapture, 'child', 'appServerThreadId', salt(initialRecord.id))) await recordEqualityFact(fact);
        await recordEqualityFact({ scope: 'child', candidate: 'innerTurnId', authority: 'appServerTurnId', equal: childTurns.equal });
      }
      const concurrentCaptures = [captureEvents[3], captureEvents[4]];
      const concurrentRecords = orderedChildren.slice(1, 3);
      const concurrentTurnHashes = [];
      for (const childRecord of concurrentRecords) {
        if (!childRecord || typeof childRecord.id !== 'string') { concurrentTurnHashes.push(null); continue; }
        await recordAuthorityHash('appServerThreadId', 'child', salt(childRecord.id));
        // A concurrent Child carries exactly one capture and one turn; a
        // read returning anything else is not a joinable single identity.
        const turns = await childTurnsOf(childRecord);
        const turnHash = turns.length === 1 && turns[0] && typeof turns[0].id === 'string' ? salt(turns[0].id) : null;
        concurrentTurnHashes.push(turnHash);
        if (turnHash) await recordAuthorityHash('appServerTurnId', 'child', turnHash);
      }
      // Thread set fact: always emitted — a missing persisted child makes the
      // sets unequal, which is an honest namespace failure, not missing
      // evidence.
      await recordEqualityFact({
        scope: 'child',
        candidate: 'innerThreadId',
        authority: 'appServerThreadId',
        equal: saltedHashSetsEqual(
          concurrentCaptures.map((capture) => capture?.threadHash ?? null),
          concurrentRecords.map((childRecord) => childRecord && typeof childRecord.id === 'string' ? salt(childRecord.id) : null),
        ),
      });
      // Turn set fact: emitted only when both concurrent first-turn reads
      // succeeded — a failed read is missing evidence (the cell may still hold
      // through the initial Child's per-pair fact), not a namespace
      // contradiction.
      if (concurrentTurnHashes.length === 2 && concurrentTurnHashes.every((turnHash) => turnHash !== null)) {
        await recordEqualityFact({
          scope: 'child',
          candidate: 'innerTurnId',
          authority: 'appServerTurnId',
          equal: saltedHashSetsEqual(
            concurrentCaptures.map((capture) => capture?.turnHash ?? null),
            concurrentTurnHashes,
          ),
        });
      }
      // returnedChildHandle facts come only from the handles parsed
      // independently from the spawn_agent transcript (hashed in the matrix
      // phase); the persisted app-server child ids stay under their own
      // appServerThreadId authority. The first parsed handle is the initial
      // Child's; the two concurrent handles correlate by set equality. If
      // handle parsing was absent, the authority is honestly missing and no
      // facts are fabricated.
      for (const fact of returnedChildHandleFacts(
        initialCapture ?? null,
        concurrentCaptures,
        matrixHost.account.spawnHandles.slice(0, 3).map((handle) => salt(handle)),
      )) {
        await recordEqualityFact(fact);
      }
    }
    // Hook columns: pair app-server-phase captures with that phase's hook
    // observations (the recorded run also observed hooks on the exec path:
    // SessionEnd in the cliSigint window and Stop in the plugin-timeout
    // window). Like every app-server-path fact, the pairing is gated on the
    // capture evidence and uses the gate-ATTRIBUTED captures — the fresh
    // Root/Child captures identified by their thread hashes — so no
    // positional assumption about completion-dependent capture order exists.
    const appsrvSessionStart = (await hookEventsFrom(appServerHooksBefore, 'session-start'))[0] ?? null;
    const appsrvPromptSubmit = (await hookEventsFrom(appServerHooksBefore, 'user-prompt-submit'))[0] ?? null;
    const appsrvSubagentStart = (await hookEventsFrom(appServerHooksBefore, 'subagent-start'))[0] ?? null;
    if (captureGate.collected) {
      const appsrvRootCapture = captureGate.rootCaptureIndex === null ? null : treatmentCaptureEvents[captureGate.rootCaptureIndex] ?? null;
      const appsrvChildCapture = captureGate.childCaptureIndex === null ? null : treatmentCaptureEvents[captureGate.childCaptureIndex] ?? null;
      for (const [capture, hook, authority] of [
        [appsrvRootCapture, appsrvSessionStart, 'hookSessionId'],
        [appsrvRootCapture, appsrvPromptSubmit, 'hookSessionId'],
        [appsrvRootCapture, appsrvPromptSubmit, 'hookTurnId'],
        [appsrvChildCapture, appsrvSubagentStart, 'hookSessionId'],
        [appsrvChildCapture, appsrvSubagentStart, 'hookTurnId'],
        [appsrvChildCapture, appsrvSubagentStart, 'hookAgentId'],
      ]) {
        if (!capture || !hook) continue;
        const authorityHash = authority === 'hookSessionId' ? hook.event.sessionHash
          : authority === 'hookTurnId' ? hook.event.turnHash
            : hook.event.agentHash;
        if (!authorityHash) continue;
        for (const fact of captureAuthorityFacts(capture, capture === appsrvChildCapture ? 'child' : 'root', authority, authorityHash)) {
          await recordEqualityFact(fact);
        }
      }
    }
    // Matrix-window hook facts when the host does fire hooks during exec.
    for (const [capture, hook] of [[captureEvents[0], matrixSessionStart], [captureEvents[0], matrixPromptSubmit]]) {
      if (!capture || !hook) continue;
      for (const [authority, hash] of [['hookSessionId', hook.event.sessionHash], ['hookTurnId', hook.event.turnHash]]) {
        if (!hash) continue;
        for (const fact of captureAuthorityFacts(capture, 'root', authority, hash)) await recordEqualityFact(fact);
      }
    }
    // Matrix-window SubagentStart hook facts. The initial Child pairs
    // per-capture: its SubagentStart fired before the concurrent pair was
    // spawned, so hook order is unambiguous there. The two CONCURRENT-Child
    // captures correlate by multiset equality over the salted hashes —
    // capture order is completion-dependent and SubagentStart order is
    // creation-dependent, so positional pairing could compare each capture
    // with the wrong hook and emit false equality facts.
    const initialChildHook = matrixSubagentStarts[0] ?? null;
    if (captureEvents[1] && initialChildHook) {
      for (const [authority, hash] of [['hookSessionId', initialChildHook.event.sessionHash], ['hookTurnId', initialChildHook.event.turnHash], ['hookAgentId', initialChildHook.event.agentHash]]) {
        if (!hash) continue;
        for (const fact of captureAuthorityFacts(captureEvents[1], 'child', authority, hash)) await recordEqualityFact(fact);
      }
    }
    const concurrentChildHooks = matrixSubagentStarts.slice(1, 3);
    if (concurrentChildHooks.length === 2) {
      for (const fact of concurrentChildHookFacts([captureEvents[3], captureEvents[4]], concurrentChildHooks.map((hook) => hook.event))) {
        await recordEqualityFact(fact);
      }
    }
    // The Host/Hook join is part of the required authority chain: when the
    // matrix's SessionStart/SubagentStart evidence (with the id fields the
    // pairing needs) is absent or malformed, record that structurally — the
    // reducer cannot set identityNamespaceQualified without hook-column
    // facts for the winning candidates. The observation path stays honest:
    // whatever hook evidence exists is still paired and recorded above.
    const requiredHookEvidencePresent = Boolean(
      matrixSessionStart?.event.sessionHash
      && matrixPromptSubmit?.event.turnHash
      && matrixSubagentStarts[0]?.event.sessionHash
      && matrixSubagentStarts[0]?.event.agentHash
      && matrixSubagentStarts[0]?.event.turnHash,
    );
    if (!requiredHookEvidencePresent) {
      transcript('phase-app-server: required matrix hook evidence absent or malformed; the reducer cannot qualify the namespace without the hook-column facts for the winning candidates');
    }
    transcript('phase-app-server: salted equality facts recorded');
    // Transport control (DIAGNOSTIC ONLY): one bounded direct tool call
    // through app-server for the configured probe server, on a dedicated
    // thread. What is recorded is exactly the JSON-RPC outcome plus the
    // durable capture delta: an error result with zero captures is an
    // error result of UNDETERMINED ORIGIN (the response content is not
    // retained, so a handler-generated error is indistinguishable from a
    // host-generated refusal wrapped in a success frame), and handler
    // reachability is never claimed from it. This is NOT a model turn, its
    // metadata is never treated as an active model turn, it cannot feed the
    // authority gate (the gate above consumed only the treatment window),
    // and it satisfies no lifecycle case. Whatever per-call metadata the
    // Host attaches to the direct call is the Host's own fact; the driver
    // injects no `_meta`.
    const capturesBeforeDiagnostic = await durableCaptureEvents();
    let transportControlOutcome = 'unobserved';
    let transportControlCaptures = 0;
    try {
      const diagnosticThreadId = await startAppServerThread('transport-control');
      let requestFailed = false;
      let responseIsError = null;
      try {
        const response = await appServerSession.request('mcpServer/tool/call', appServerToolCallParams(PROBE_MCP_SERVER_NAME, diagnosticThreadId, 'capture_context'), 60_000);
        responseIsError = response?.isError === true;
      } catch (callError) {
        requestFailed = true;
        transcript(`phase-app-server: transport control call rejected (${callError && typeof callError === 'object' && 'code' in callError ? /** @type {any} */ (callError).code : 'error'})`);
      }
      // The capture delta is per-thread, never global: a late capture-started
      // from a Child spawned by either preceding capture turn can land inside
      // this window, so only NEW captures whose candidate thread hashes match
      // the diagnostic thread's salted id (any candidate) may classify the
      // direct call as capture-recorded. The window is QUIET for null-hash
      // captures: the driver starts no other conversation inside it, and a
      // capture with all-null candidate hashes cannot be a late Child capture
      // (children always carry their own thread ids), so such a capture —
      // when one exists at all — is the direct call's own handler-side
      // record and preserves the handler-reachability fact.
      const captureDelta = diagnosticCaptureAttribution(
        capturesBeforeDiagnostic,
        await durableCaptureEvents(),
        salt(diagnosticThreadId),
        { quietWindow: true },
      );
      transportControlCaptures = captureDelta;
      transportControlOutcome = classifyTransportControlOutcome({ requestFailed, responseIsError, captureDelta });
    } catch (diagnosticError) {
      transcript(`phase-app-server: transport control thread unavailable (${diagnosticError && typeof diagnosticError === 'object' && 'code' in diagnosticError ? /** @type {any} */ (diagnosticError).code : 'error'})`);
    }
    transcript(`phase-app-server: transport control outcome=${transportControlOutcome} (diagnostic only)`);
    await appendProbeEvent({
      runDirectory,
      runNonce,
      event: { kind: 'app-server-control', control: 'transport-control', outcome: transportControlOutcome, captures: transportControlCaptures },
    });

    // The held turn receives the same structured Skill treatment alongside
    // its text (text-only fallback when no skill entry resolved), and runs
    // on the structured conversation when one exists so the explicit
    // interruption shares the treatment path.
    const heldThreadId = treatmentThreadId ?? controlThreadId;
    const holdStartedCount = await countKind('hold-started');
    const heldHooksBefore = await hookCensus();
    const heldTurn = await appServerSession.request('turn/start', appServerTurnStartParams(heldThreadId, HOLD_PROMPT, probeSkillEntry), HOST_CONVERSATION_DEADLINE_MS);
    const heldTurnId = heldTurn?.turn?.id;
    if (typeof heldTurnId !== 'string') {
      throw probeError('PROBE_APP_SERVER_TURN_START_FAILED', 'The app-server held turn/start response omitted its turn id.');
    }
    const heldCallNonce = await waitForFreshHoldStartedOrNull(holdStartedCount, APP_SERVER_HOLD_START_WAIT_MS);
    // The explicit user-cancellation entry point, disciplined:
    // `turn/interrupt` is sent ONLY after the held call durably entered the
    // handler (the durable hold-started wait above). If the hold never
    // became durable the interrupt is NOT sent and the honest reason is
    // recorded — the turn itself is still observed to its own terminal
    // state, and an already-terminal turn's rejection is never converted
    // into a cancellation observation.
    const interruptPlan = planTurnInterrupt({ heldCallObserved: heldCallNonce !== null });
    let interruptDelivered = false;
    // The delivery outcome is durable evidence, not transcript chatter: a
    // lifecycle record without it would be indistinguishable from a
    // delivered interrupt with no handler notification.
    let interruptDelivery = 'not-sent';
    if (interruptPlan.send && heldCallNonce !== null) {
      try {
        await appServerSession.request('turn/interrupt', appServerTurnInterruptParams(heldThreadId, heldTurnId), 60_000);
        interruptDelivered = true;
        interruptDelivery = 'delivered';
        transcript('phase-app-server: turn/interrupt delivered for the exact held thread/turn with its durable held call');
      } catch (interruptError) {
        interruptDelivered = false;
        const interruptCode = errorCode(interruptError);
        // An answered rejection (e.g. an already-terminal turn) is
        // 'rejected'; a request that never received an answer (timeout,
        // disconnect) is 'failed'.
        interruptDelivery = interruptCode === 'PROBE_APP_SERVER_TIMEOUT' || interruptCode === 'PROBE_APP_SERVER_DISCONNECTED' ? 'failed' : 'rejected';
        transcript('phase-app-server: turn/interrupt rejected (the turn had already reached a terminal state)');
      }
    } else {
      transcript('phase-app-server: held call never became durable; turn/interrupt NOT sent (no-durable-hold)');
    }
    await appendProbeEvent({
      runDirectory,
      runNonce,
      event: { kind: 'app-server-control', control: 'held-turn-interrupt', outcome: interruptDelivery, captures: 0 },
    });
    const interruptDeadline = Date.now() + APP_SERVER_OBSERVATION_CEILING_MS;
    const interruptStatus = await appServerTurnSettled(appServerSession, heldThreadId, heldTurnId, APP_SERVER_OBSERVATION_CEILING_MS);
    const interruptSettlement = heldCallNonce
      ? await settlementArrived(heldCallNonce, Math.max(0, interruptDeadline - Date.now()), durableEvents)
      : null;
    await recordLifecycleObservation('appServerTurnInterrupt', assembleAppServerTurnInterruptObservation({
      appServerAlive: isProcessAlive(appServerSession.pid),
      turnStatus: interruptStatus,
      heldCallObserved: heldCallNonce !== null,
      interruptSettlement,
      hookEvent: await hookEventInWindow(heldHooksBefore),
    }));
    transcript(`phase-app-server: interrupt observation recorded (interruptDelivered=${interruptDelivered}, turnTerminalStatus=${interruptStatus ?? 'pending'}, handlerSettlement=${interruptSettlement ?? 'not-observed'})`);
    await appServerSession.terminate();


    // Phase 6 boundary: stop every 30-second-phase process, then remove its
    // plugin and marketplace before the 2-second fixture exists.
    await stopTrackedProcesses();
    await removeMarketplace('slow');

    // Phase 6: plugin tool-timeout characterization — observe 30 seconds
    // after the durable start and record whatever actually happens.
    await installMarketplace(marketplaceFast, 'fast');
    await trackServerProcesses(true);
    await observePhase('plugin-tool-timeout');
    const pluginTimeoutObservation = await observeToolTimeoutPhase('pluginToolTimeout', hostEnv, 'phase-plugin-timeout');
    transcript(`phase-plugin-timeout: observation recorded (unknownReason=${pluginTimeoutObservation === null ? 'n/a' : 'recorded'})`);

    // Phase 7: direct-config timeout differential — a fresh isolated Codex
    // home with the same copied authentication, the skill-only fixture (no
    // .mcp.json), the fixture hooks enabled and trusted exactly like the
    // plugin home (so the hookEvent columns stay comparable), and the
    // identical server configured directly under
    // [mcp_servers.zcode-mcp-context-probe] with tool_timeout_sec = 2.
    await removeMarketplace('fast');
    const directLoginStatus = await runCodexCommand(['login', 'status'], { label: 'direct-login-status' }, directHostEnv);
    if (directLoginStatus.code !== 0) {
      throw probeError('PROBE_QUALIFICATION_UNAVAILABLE', 'qualification-unavailable: the direct-config Codex home failed `codex login status`.');
    }
    await installMarketplace(marketplaceDirect, 'direct', directHostEnv);
    await enableProbeHooks(directHostEnv);
    // Append — never replace — the direct MCP stanza: the skill-only plugin's
    // registration (features, plugin, marketplace, hooks) was just written
    // into this config and must survive, or the differential would no longer
    // prove the Skill-driven path.
    const directConfigStanza = [
      '[mcp_servers.zcode-mcp-context-probe]',
      'command = "node"',
      `args = [${JSON.stringify(moduleServerPath())}]`,
      'enabled = true',
      'env_vars = ["ZCODE_MCP_PROBE_EVENTS", "ZCODE_MCP_PROBE_LOCK", "ZCODE_MCP_PROBE_NONCE"]',
      'tool_timeout_sec = 2',
      '',
    ].join('\n');
    const directConfigPath = join(directCodexHome, 'config.toml');
    const existingDirectConfig = await readFile(directConfigPath, 'utf8').catch((readError) => {
      if (errorCode(readError) !== 'ENOENT') throw readError;
      return '';
    });
    await writeFile(directConfigPath, appendMcpServerConfig(existingDirectConfig, directConfigStanza), { encoding: 'utf8' });
    await trackServerProcesses(true);
    await observePhase('direct-config-timeout');
    await observeToolTimeoutPhase('directConfigToolTimeout', directHostEnv, 'phase-direct-config-timeout');
    transcript('phase-direct-config: timeout observation recorded');

    await stopTrackedProcesses();
    await removeMarketplace('direct');

    for (const pid of [sigintHost.pid, sigkillHost.pid]) {
      if (cleanupTargetMatchesIdentity(pid, trackedProcesses.get(pid) ?? null)) {
        throw probeError('PROBE_CLEANUP_FAILED', 'A recorded host process survived qualification.');
      }
    }
    await unlink(isolatedAuthPath);
    await unlink(directAuthPath);
    for (const authPath of [isolatedAuthPath, directAuthPath]) {
      if (await lstat(authPath).then(() => true, () => false)) {
        throw probeError('PROBE_CLEANUP_FAILED', 'The isolated auth.json copy could not be deleted.');
      }
    }
    const result = await reduceProbeResult({ runDirectory, runNonce });
    transcript('result: reduced and written to result.json');
    qualificationOutcome = { failed: false, value: result };
  } catch (qualificationError) {
    qualificationOutcome = { failed: true, error: qualificationError };
  }

  // Ordered cleanup runs after every exit path: stop processes, remove the
  // plugin and marketplaces, delete the isolated auth copies, and remove the
  // temporary isolated homes. A cleanup failure fails the qualification
  // redactedly, but never masks the original outcome.
  const cleanupFailures = [];
  try {
    await stopTrackedProcesses();
  } catch (cleanupError) {
    cleanupFailures.push(cleanupError);
  }
  while (installedMarketplaces.length > 0) {
    const entry = installedMarketplaces.at(-1);
    try { await removeMarketplace(entry.label, entry.env); } catch (cleanupError) { cleanupFailures.push(cleanupError); break; }
  }
  // Deletion of the copied credentials is verified: an I/O or permission
  // failure must surface as a cleanup failure, never silently keep them.
  for (const authPath of [isolatedAuthPath, directAuthPath]) {
    try {
      await unlink(authPath);
    } catch (cleanupError) {
      if (errorCode(cleanupError) !== 'ENOENT') {
        cleanupFailures.push(probeError('PROBE_CLEANUP_FAILED', 'The isolated auth.json copy could not be deleted.'));
      }
    }
    if (await lstat(authPath).then(() => true, () => false)) {
      cleanupFailures.push(probeError('PROBE_CLEANUP_FAILED', 'The isolated auth.json copy could not be deleted.'));
    }
  }
  for (const directory of [isolatedCodexHome, directCodexHome, isolatedHome, isolatedTmp]) {
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

  /** @param {{code:number|null, timedOut:boolean, overflow:boolean}} result @param {{malformed:number, frameTypes:Map<string, number>, nestedItemTypes:Map<string, number>}} account @param {string} label */
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

  /**
   * Runs one held-call timeout phase (plugin fixture or direct config) and
   * records the honest observation. The 30-second ceiling starts only once
   * the held call is durable and covers exit AND settlement together: both
   * are observed concurrently so a handler settlement that lands while the
   * host stays alive — the normal timeout shape, where the host aborts the
   * tool and continues the turn — is recorded, and the settlement wait spends
   * only the ceiling budget remaining at its start.
   * @param {string} lifecycleCase @param {NodeJS.ProcessEnv} env @param {string} label
   */
  async function observeToolTimeoutPhase(lifecycleCase, env, label) {
    const hooksBefore = await hookCensus();
    const holdsBefore = await countKind('hold-started');
    const timeoutHost = await startHost(newConversationArgs(workspaceA, HOLD_PROMPT), { cwd: workspaceA, env, label });
    const callNonce = await requireFreshHoldStarted(holdsBefore, label, SUBPROCESS_DEADLINE_MS);
    // The ceiling measures timeout settlement, so it starts only once the
    // held call is durable — model startup time must not consume it.
    const heldCallStartedAt = Date.now();
    const ceilingDeadlineMs = heldCallStartedAt + HOST_TIMEOUT_GRACE_MS;
    const remainingCeilingMs = Math.max(1, ceilingDeadlineMs - Date.now());
    // Host exit and durable settlement share one ceiling and are observed
    // concurrently: neither observation is conditional on the other.
    const [hostExit, settlement] = await Promise.all([
      Promise.race([
        timeoutHost.promise,
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), remainingCeilingMs);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]).catch(() => null),
      timeoutSettlementArrived(callNonce, Math.max(0, ceilingDeadlineMs - Date.now()), durableEvents),
    ]);
    // The Host transcript can carry the tool call's fate directly: a nested
    // mcp_tool_call item whose status completed or failed names the outcome
    // even when no durable settlement landed. Statuses come from the
    // dedicated tally (never the excerpt cap), so a call status beyond 32
    // diagnostic excerpts still reaches the outcome derivation.
    const mcpCallStatuses = mcpCallStatusesFromCounts(timeoutHost.account.mcpCallStatusCounts);
    // The server's transport state is observed from the server itself — the
    // Host's exit never implies it (the pending handler may outlive the
    // Host, which is exactly what this phase characterizes).
    const timeoutServerPid = await latestRecordedServerPid();
    let timeoutServerAlive = null;
    if (timeoutServerPid !== null) {
      timeoutServerAlive = isProcessAlive(timeoutServerPid);
      if (timeoutServerAlive && !trackedProcesses.has(timeoutServerPid)) {
        // A server still alive at observation time — the explicitly
        // supported "handler pending / server alive" outcome — is a
        // legitimate live observation by the driver: capture its start
        // identity immediately (same as the phase-boundary
        // trackServerProcesses(true), not after-the-fact authentication) so
        // cleanup can verify and signal it normally instead of failing on an
        // unverifiable pid.
        trackedProcesses.set(timeoutServerPid, captureProcessIdentity(timeoutServerPid));
      }
    }
    const observation = {
      hostProcess: hostExit === null ? (isProcessAlive(timeoutHost.pid) ? 'running' : 'unknown')
        : hostExit.signal !== null ? 'exited-signal' : 'exited-clean',
      turnTerminalStatus: hostExit !== null ? 'not-observed' : 'pending',
      toolCallOutcome: deriveTimeoutToolCallOutcome({
        settlement,
        mcpCallStatuses,
        hostExitObserved: hostExit !== null,
      }),
      handlerSettlement: settlement ?? 'not-observed',
      transportState: deriveTransportState({ settlement, serverAlive: timeoutServerAlive }),
      hookEvent: await hookEventInWindow(hooksBefore),
      unknownReason: settlement !== null ? 'none' : (hostExit !== null ? 'process-exited-first' : 'ceiling-reached'),
    };
    await recordLifecycleObservation(lifecycleCase, observation);
    transcript(`${label}: timeout observation recorded (handlerSettlement=${observation.handlerSettlement}, unknownReason=${observation.unknownReason})`);
    if (hostExit === null && isProcessAlive(timeoutHost.pid)) {
      // Stop tracked processes only after recording the observation.
      await stopProcess(timeoutHost.pid, 'SIGKILL', 5_000, timeoutHost.identity);
    }
    return observation;
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
   * @param {string} marketplaceRoot @param {string} label @param {NodeJS.ProcessEnv} [env]
   */
  async function installMarketplace(marketplaceRoot, label, env = hostEnv) {
    const added = await runCodexCommand(['plugin', 'marketplace', 'add', marketplaceRoot, '--json'], { label: `${label} marketplace-add` }, env);
    if (added.code !== 0) throw probeError('PROBE_INSTALL_FAILED', `${label} marketplace add failed: exit ${added.code}`);
    // Record the marketplace and ITS home for cleanup as soon as it is
    // registered so a failed `plugin add` still removes it in `finally`.
    installedMarketplaces.push({ root: marketplaceRoot, label, env });
    const installed = await runCodexCommand(['plugin', 'add', CODEX_PLUGIN_SELECTOR, '--json'], { label: `${label} plugin-add` }, env);
    if (installed.code !== 0) throw probeError('PROBE_INSTALL_FAILED', `${label} plugin add failed: exit ${installed.code}`);
    transcript(`${label}: marketplace and probe plugin installed`);
  }

  /**
   * Removes the newest installed marketplace registration from the home it
   * was installed into. Both removal commands always run, even after the
   * other one fails; the failures are aggregated so the registration cannot
   * survive cleanup.
   * @param {string} label @param {NodeJS.ProcessEnv} [env]
   */
  async function removeMarketplace(label, env) {
    const recorded = [...installedMarketplaces].reverse().find((entry) => entry.label === label);
    const homeEnv = env ?? recorded?.env ?? hostEnv;
    const failures = [];
    const pluginRemoved = await runCodexCommand(['plugin', 'remove', CODEX_PLUGIN_SELECTOR, '--json'], { label: `${label} plugin-remove` }, homeEnv);
    if (pluginRemoved.code !== 0) failures.push(`plugin remove exit ${pluginRemoved.code}`);
    const marketplaceRemoved = await runCodexCommand(['plugin', 'marketplace', 'remove', CODEX_MARKETPLACE_NAME, '--json'], { label: `${label} marketplace-remove` }, homeEnv);
    if (marketplaceRemoved.code !== 0) failures.push(`marketplace remove exit ${marketplaceRemoved.code}`);
    if (failures.length > 0) throw probeError('PROBE_CLEANUP_FAILED', `${label} cleanup failed (${failures.join('; ')})`);
    const index = installedMarketplaces.findIndex((entry) => entry.label === label);
    if (index >= 0) installedMarketplaces.splice(index, 1);
    transcript(`${label}: probe plugin and marketplace removed`);
  }
}

/**
 * The exact app-server JSON-RPC request shapes the driver sends, exported so
 * the characterization payloads are pinned by unit tests at the same source
 * the real run path uses. `turn/interrupt` is the explicit user-cancellation
 * entry point and carries exactly the interrupted thread and turn ids.
 */
export function appServerInitializeParams() {
  return {
    clientInfo: { name: 'zcode-mcp-context-probe', title: 'ZCode MCP Context Probe', version: '0.1.0' },
    capabilities: null,
  };
}

/** @param {string} cwd */
export function appServerThreadStartParams(cwd) {
  return { cwd };
}

/** The probe plugin identity the fixture installs in the isolated home. */
export const PROBE_PLUGIN_NAME = 'zcode-mcp-context-probe';
/** The probe Skill's frontmatter name inside the fixture plugin. */
export const PROBE_SKILL_NAME = 'context';
/** The MCP server name the fixture's descriptor declares. */
export const PROBE_MCP_SERVER_NAME = 'zcode-mcp-context-probe';

/**
 * The exact `skills/list` request shape used for Skill resolution: the probe
 * workspace (so the freshly installed plugin skill is scanned there) and a
 * forced reload (so the scan bypasses the host's skills cache). Verified
 * against the pinned 0.155.1 binary's generated schema (SkillsListParams:
 * optional `cwds`, optional `forceReload`).
 * @param {string[]} cwds
 */
export function appServerSkillsListParams(cwds) {
  if (!Array.isArray(cwds)) throw probeError('PROBE_SKILL_LIST_INVALID', 'The skills/list cwds must be an array of workspace paths.');
  return { cwds: [...cwds], forceReload: true };
}

/**
 * Pure resolver over a `skills/list` response (`{data:[{cwd, errors,
 * skills:[SkillMetadata]}]}`): finds the installed probe Skill entry and
 * returns its EXACT host-reported name and path for the structured Skill
 * input item. Matching is by the qualified `plugin:skill` name, or by the
 * bare skill name owned by the probe plugin (pluginId `plugin` or
 * `plugin@marketplace`); the entry must be enabled and carry a nonempty
 * string path. Multiple cwd entries carrying the same agreeing entry resolve
 * once; disagreeing duplicates are ambiguous and resolve to null, as does
 * every absent/malformed/disabled shape — the driver records the honest
 * absence instead of guessing name or path.
 * @param {unknown} listData @param {{pluginName:string, skillName:string}} probe
 * @returns {{name:string, path:string}|null}
 */
export function resolveProbeSkillEntry(listData, { pluginName, skillName }) {
  if (!Array.isArray(listData) || typeof pluginName !== 'string' || !pluginName || typeof skillName !== 'string' || !skillName) return null;
  const qualifiedName = `${pluginName}:${skillName}`;
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {{name:string, path:string}|null} */
  let resolved = null;
  for (const entry of listData) {
    const skills = entry && typeof entry === 'object' && !Array.isArray(entry) && Array.isArray(/** @type {any} */ (entry).skills)
      ? /** @type {any} */ (entry).skills
      : [];
    for (const skill of skills) {
      if (!skill || typeof skill !== 'object' || Array.isArray(skill)) continue;
      const { name, path, enabled, pluginId } = /** @type {any} */ (skill);
      if (typeof name !== 'string' || typeof path !== 'string' || path.length === 0 || enabled !== true) continue;
      const nameMatches = name === qualifiedName;
      const ownedBareNameMatches = name === skillName
        && typeof pluginId === 'string'
        && (pluginId === pluginName || pluginId.startsWith(`${pluginName}@`));
      if (!nameMatches && !ownedBareNameMatches) continue;
      const key = `${name}\u0000${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (resolved !== null) return null;
      resolved = { name, path };
    }
  }
  return resolved;
}

/**
 * The `turn/start` input builder. With a resolved Skill entry the input
 * carries the existing compliance-voice text item FIRST and the structured
 * Skill input item `{type:'skill', name, path}` second (the 0.155.1
 * TurnStartParams.UserInput SkillUserInput shape) — this is what makes
 * app-server inject the full Skill instructions instead of relying on
 * model-side marker resolution. Without one the input stays exactly the
 * historical text-only shape, which is the marker-only control turn.
 * @param {string} threadId @param {string} text @param {{name:string, path:string}|null} [skill]
 */
export function appServerTurnStartParams(threadId, text, skill = null) {
  if (skill === null || skill === undefined) return { threadId, input: [{ type: 'text', text }] };
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)
    || typeof skill.name !== 'string' || skill.name.length === 0
    || typeof skill.path !== 'string' || skill.path.length === 0) {
    throw probeError('PROBE_SKILL_INPUT_INVALID', 'The structured Skill input item requires nonempty name and path strings.');
  }
  return { threadId, input: [{ type: 'text', text }, { type: 'skill', name: skill.name, path: skill.path }] };
}

/**
 * The exact `mcpServer/tool/call` transport-control request shape (0.155.1
 * McpServerToolCallParams: server, threadId, and tool are required;
 * arguments is optional). The probe sends the empty arguments object its
 * tools require and never injects `_meta`: whatever per-call metadata the
 * Host attaches to a direct call is the Host's own fact.
 * @param {string} server @param {string} threadId @param {string} tool
 */
export function appServerToolCallParams(server, threadId, tool) {
  if (typeof server !== 'string' || !server) throw probeError('PROBE_TOOL_CALL_INVALID', 'The mcpServer/tool/call server must be a nonempty string.');
  if (typeof threadId !== 'string' || !threadId) throw probeError('PROBE_TOOL_CALL_INVALID', 'The mcpServer/tool/call threadId must be a nonempty string.');
  if (typeof tool !== 'string' || !tool) throw probeError('PROBE_TOOL_CALL_INVALID', 'The mcpServer/tool/call tool must be a nonempty string.');
  return { server, threadId, tool, arguments: {} };
}

/**
 * Pure classifier of the transport-control observation. Exactly three facts
 * are recorded per run: the JSON-RPC outcome (request rejected vs a success
 * frame carrying `isError`), and the durable capture delta ATTRIBUTED to
 * the diagnostic thread (diagnosticCaptureAttribution — never the global
 * capture count). A durable capture attributable to the diagnostic thread
 * is the strongest proof (the direct call was durably recorded by the
 * configured handler). An error result with zero attributable captures is
 * recorded as `error-result-undetermined-origin`: the driver retains no
 * response content, so a handler-generated error is indistinguishable from
 * a host-generated refusal wrapped in a success frame — the ORIGIN of the
 * error result is undetermined, and handler reachability is NOT claimed. A
 * rejected request proves only that the call never completed. Anything else
 * is unobserved. This control is diagnostic only: no outcome here feeds the
 * authority gate or any lifecycle case.
 * @param {{requestFailed:boolean, responseIsError:(boolean|null), captureDelta:number}} input
 * @returns {'capture-recorded'|'call-failed'|'error-result-undetermined-origin'|'unobserved'}
 */
export function classifyTransportControlOutcome({ requestFailed, responseIsError, captureDelta }) {
  if (Number.isSafeInteger(captureDelta) && captureDelta > 0) return 'capture-recorded';
  if (requestFailed === true) return 'call-failed';
  if (responseIsError === true) return 'error-result-undetermined-origin';
  return 'unobserved';
}

/**
 * Pure turn-scoped attribution of a capture window: counts the durable
 * captures that are NEW since the pre-window snapshot AND attributable to
 * the window's own identity set — a capture is attributable when ANY of its
 * salted candidate thread hashes (envelope threadId, inner session_id,
 * inner thread_id) equals one of the supplied hashes (the turn's own thread
 * plus, when known, the salted ids of children spawned within the window's
 * conversation). The GLOBAL count is never used: a late capture from
 * another conversation's Child — e.g. a Child of the structured treatment
 * recording its capture after the treatment turn went terminal, landing
 * inside the text-only control's window — carries only its own threads'
 * hashes and is never attributed to the wrong window.
 *
 * With `quietWindow`, a NEW capture whose candidate hashes are ALL null also
 * attributes: in a window the driver keeps quiet (a dedicated thread, both
 * capture turns already terminal, the held turn not yet started — no other
 * conversation is started inside the window) such a capture can only be the
 * direct call's own handler-side record, preserving the handler-reachability
 * fact for an identity-less call; a late Child capture always carries
 * non-null thread hashes and is excluded, so the clause cannot misattribute.
 * (The current observer schema rejects all-null candidate captures at append
 * time, so this clause is a policy guard for the handler-reached-but-
 * identity-less shape, never a live misattribution channel.) A capture with
 * only SOME null candidates never matches the null clause; an empty hash set
 * attributes nothing.
 * @param {{callNonce?:string, envelopeThreadIdHash:(string|null), innerSessionIdHash:(string|null), threadHash:(string|null)}[]} beforeEvents @param {{callNonce?:string, envelopeThreadIdHash:(string|null), innerSessionIdHash:(string|null), threadHash:(string|null)}[]} afterEvents @param {(string|null|undefined)[]} threadHashes @param {{quietWindow?:boolean}} [options]
 * @returns {number}
 */
export function attributableCaptureCount(beforeEvents, afterEvents, threadHashes, { quietWindow = false } = {}) {
  const hashes = (threadHashes ?? []).filter((hash) => typeof hash === 'string' && hash.length > 0);
  if (hashes.length === 0) return 0;
  const beforeNonces = new Set((beforeEvents ?? []).map((event) => event?.callNonce));
  return (afterEvents ?? []).filter((event) => {
    if (!event || beforeNonces.has(event.callNonce)) return false;
    const candidates = [event.envelopeThreadIdHash ?? null, event.innerSessionIdHash ?? null, event.threadHash ?? null];
    if (candidates.some((hash) => hash !== null && hashes.includes(hash))) return true;
    return quietWindow === true && candidates.every((hash) => hash === null);
  }).length;
}

/**
 * The transport-control window's attribution: the diagnostic thread's own
 * salted id, plus the quiet-window null-hash clause (see
 * attributableCaptureCount for the window discipline).
 * @param {{callNonce?:string, envelopeThreadIdHash:(string|null), innerSessionIdHash:(string|null), threadHash:(string|null)}[]} beforeEvents @param {{callNonce?:string, envelopeThreadIdHash:(string|null), innerSessionIdHash:(string|null), threadHash:(string|null)}[]} afterEvents @param {string} diagnosticThreadHash @param {{quietWindow?:boolean}} [options]
 * @returns {number}
 */
export function diagnosticCaptureAttribution(beforeEvents, afterEvents, diagnosticThreadHash, options = {}) {
  return attributableCaptureCount(beforeEvents, afterEvents, [diagnosticThreadHash], options);
}

/** Poll interval for the treatment window's bounded capture-census settle. */
export const CAPTURE_SETTLE_POLL_MS = 250;
/**
 * Minimum observation window for the capture-census settle: stability alone
 * may not settle before this much of the wait has elapsed, so a FIRST late
 * Child capture arriving more than the stability budget after
 * turn/completed still enters the refreshed window (a false-negative
 * authority qualification is worse than a bounded extra wait).
 */
export const CAPTURE_SETTLE_MIN_OBSERVATION_MS = 3_000;

/**
 * Pure settle decision for the treatment window's bounded capture-census
 * wait. A Child spawned by the structured treatment turn may record its
 * capture AFTER the turn went terminal; the post-turn window snapshot is
 * therefore refreshed only once the durable capture census has stopped
 * growing for the stability budget AND the minimum observation window has
 * elapsed — so the late capture is inside the refreshed window for BOTH the
 * attributed delta and the authority gate's Root/Child pairing slice — or
 * once the total budget is exhausted, so the common no-late-capture case
 * does not stall the run. `lastChangeMs` is the elapsed time of the MOST
 * RECENT count change: the stability clock RESETS on every growth, so a
 * capture arriving near the wait's start cannot let the next unchanged poll
 * settle the window after only a fraction of the stability budget (that
 * would close the window before a Child's capture and falsely fail the
 * authority gate). The durable log is append-only: a shrinking census is a
 * contract violation and fails closed.
 * @param {{previousCount:number, currentCount:number, elapsedMs:number, lastChangeMs:number, minObservationMs?:number, stabilityMs?:number, budgetMs?:number}} input
 * @returns {boolean}
 */
export function captureCensusSettled({ previousCount, currentCount, elapsedMs, lastChangeMs, minObservationMs = CAPTURE_SETTLE_MIN_OBSERVATION_MS, stabilityMs = 2_000, budgetMs = 10_000 }) {
  for (const value of [previousCount, currentCount, elapsedMs, lastChangeMs, minObservationMs, budgetMs]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw probeError('PROBE_SETTLE_INPUT_INVALID', 'The capture settle decision requires non-negative integer inputs.');
    }
  }
  if (minObservationMs > budgetMs) {
    throw probeError('PROBE_SETTLE_INPUT_INVALID', 'The capture settle minimum observation window cannot exceed the settle budget.');
  }
  if (currentCount < previousCount) {
    throw probeError('PROBE_SETTLE_INPUT_INVALID', 'The capture settle decision requires a non-decreasing capture census.');
  }
  if (lastChangeMs > elapsedMs) {
    throw probeError('PROBE_SETTLE_INPUT_INVALID', 'The capture settle decision requires the last change to lie within the elapsed budget.');
  }
  const stable = previousCount === currentCount && elapsedMs - lastChangeMs >= stabilityMs;
  const observed = elapsedMs >= minObservationMs;
  return (stable && observed) || elapsedMs >= budgetMs;
}

/**
 * Pure gate of the explicit-interrupt discipline: `turn/interrupt` is sent
 * ONLY after `hold_for_lifecycle` has durably entered the handler (the
 * driver's durable hold-started wait). Without a durable held call the
 * interrupt is NOT sent — an already-terminal or unrelated turn would only
 * characterize an interrupt rejection — and the honest reason is recorded.
 * @param {{heldCallObserved:boolean}} input
 * @returns {{send:boolean, trigger:'durable-hold-started'|'no-durable-hold'}}
 */
export function planTurnInterrupt({ heldCallObserved }) {
  return heldCallObserved === true
    ? { send: true, trigger: 'durable-hold-started' }
    : { send: false, trigger: 'no-durable-hold' };
}

/** @param {string} threadId @param {string} turnId */
export function appServerTurnInterruptParams(threadId, turnId) {
  return { threadId, turnId };
}

/**
 * Pure seam of appServerTurnSettled: reduces the session's recorded
 * notifications to the terminal status of one exact thread/turn. Returns
 * 'completed' | 'failed' | 'interrupted' from the matched turn/completed
 * frame, 'unknown' when that frame carries a status outside the closed
 * vocabulary, and null while no matching terminal frame exists (the value
 * the driver polls on until the ceiling turns it into the null-at-ceiling
 * observation).
 * @param {{method:string, params:any}[]} notifications
 * @param {string} threadId @param {string} turnId
 * @returns {'completed'|'failed'|'interrupted'|'unknown'|null}
 */
export function appServerTurnStatusFromNotifications(notifications, threadId, turnId) {
  const completed = (notifications ?? []).find((notification) => notification?.method === 'turn/completed'
    && notification.params?.threadId === threadId && notification.params?.turn?.id === turnId);
  if (!completed) return null;
  const status = completed.params?.turn?.status;
  return ['completed', 'failed', 'interrupted'].includes(status) ? status : 'unknown';
}

/**
 * Pure seam of the appServerTurnInterrupt lifecycle observation: assembles
 * the closed observation from the facts the driver recorded, so the exact
 * recorded enum values are pinned by unit tests at the same source the real
 * run path uses.
 * @param {{appServerAlive:boolean, turnStatus:'completed'|'failed'|'interrupted'|'unknown'|null, heldCallObserved:boolean, interruptSettlement:string|null, hookEvent:string}} input
 */
export function assembleAppServerTurnInterruptObservation({ appServerAlive, turnStatus, heldCallObserved, interruptSettlement, hookEvent }) {
  return {
    hostProcess: appServerAlive ? 'running' : 'unknown',
    turnTerminalStatus: turnStatus === 'interrupted' ? 'interrupted'
      : turnStatus === 'completed' ? 'completed'
        : turnStatus === 'failed' ? 'failed'
          : turnStatus === null ? 'pending' : 'unknown',
    toolCallOutcome: heldCallObserved ? 'pending' : 'not-observed',
    handlerSettlement: interruptSettlement ?? 'not-observed',
    // The app-server session is the transport endpoint the driver spawned
    // and observes directly: its liveness IS the transport state for this
    // case — no separate Host/server inference exists here (unlike the exec
    // phases, which use deriveTransportState).
    transportState: appServerAlive ? 'open' : 'server-exited',
    hookEvent,
    unknownReason: interruptSettlement !== null ? 'none'
      : turnStatus === null ? 'ceiling-reached' : 'host-omitted-event',
  };
}

/**
 * Pure seam of the exec phases' transportState column: derives it from the
 * SERVER-side facts the driver actually observes, never from the Host's
 * exit — the MCP server is a separate process whose pending handler may
 * outlive the Host, which is exactly what the timeout phases characterize.
 * Only a 'transport-close' settlement implies 'stdin-eof' (the server's own
 * disconnect watcher observing its stdin end); any other settlement — a
 * 'signal-abort' delivered through the SDK abort while the server stays up,
 * or a host-timeout — falls through to the observed server liveness
 * (alive → 'open', exited → 'server-exited'); when no server startup is
 * durably recorded nothing is known about any server ('not-observed').
 * @param {{settlement:string|null, serverAlive:boolean|null}} input
 * @returns {'open'|'stdin-eof'|'server-exited'|'not-observed'}
 */
export function deriveTransportState({ settlement, serverAlive }) {
  if (settlement === 'transport-close') return 'stdin-eof';
  if (serverAlive === true) return 'open';
  if (serverAlive === false) return 'server-exited';
  return 'not-observed';
}

/**
 * Pure bounded stdout accounting for the app-server JSON-RPC client (the
 * runBounded discipline, adapted to a streaming frame parser): folds one
 * chunk into the line-buffer state, returning the complete lines and the
 * next state. Once the accumulated bytes exceed maximumBytes the state
 * overflows — the flag is sticky and no further lines are produced — so a
 * chatty server can neither block the pipe nor grow the driver's memory
 * without bound; the caller terminates the bounded session on overflow. The
 * retained buffer is always a suffix of the accounted bytes, so one bound
 * covers both the accumulation and the line buffer.
 * @param {{buffer:string, totalBytes:number, overflow:boolean}} state
 * @param {string} chunk
 * @param {number} maximumBytes
 * @returns {{state:{buffer:string, totalBytes:number, overflow:boolean}, lines:string[]}}
 */
export function boundedStdoutLines(state, chunk, maximumBytes) {
  const totalBytes = state.totalBytes + Buffer.byteLength(chunk);
  if (state.overflow || totalBytes > maximumBytes) {
    return { state: { buffer: '', totalBytes, overflow: true }, lines: [] };
  }
  const buffer = state.buffer + chunk;
  const lines = [];
  let rest = buffer;
  for (;;) {
    const newline = rest.indexOf('\n');
    if (newline < 0) break;
    lines.push(rest.slice(0, newline));
    rest = rest.slice(newline + 1);
  }
  return { state: { buffer: rest, totalBytes, overflow: false }, lines };
}

/**
 * Pure pairing primitive of the salted equality matrix: builds the equality
 * facts joining one capture's candidate hashes to one authority hash.
 * Thread authorities (appServerThreadId, hookSessionId, hookAgentId,
 * returnedChildHandle) pair the three thread candidates; turn authorities
 * (appServerTurnId, hookTurnId) pair only the innerTurnId candidate. The
 * matching candidate reduces true; the others reduce as honest contrasts.
 * @param {{envelopeThreadIdHash:(string|null), innerSessionIdHash:(string|null), threadHash:(string|null), turnHash:(string|null)}} capture
 * @param {'root'|'child'} scope
 * @param {string} authority
 * @param {string} authorityHash
 * @returns {{scope:string, candidate:string, authority:string, equal:boolean}[]}
 */
export function captureAuthorityFacts(capture, scope, authority, authorityHash) {
  const pairs = [
    ['envelopeThreadId', capture?.envelopeThreadIdHash ?? null],
    ['innerSessionId', capture?.innerSessionIdHash ?? null],
    ['innerThreadId', capture?.threadHash ?? null],
    ['innerTurnId', capture?.turnHash ?? null],
  ];
  return pairs
    .filter(([candidate]) => (candidate === 'innerTurnId'
      ? authority === 'appServerTurnId' || authority === 'hookTurnId'
      : authority !== 'appServerTurnId' && authority !== 'hookTurnId'))
    .map(([candidate, candidateHash]) => ({ scope, candidate, authority, equal: candidateHash !== null && candidateHash === authorityHash }));
}

/**
 * Pure seam of the fresh app-server-path capture join (the capture-gated
 * evidence): builds the equality facts one gate-attributed fresh capture
 * contributes. Thread evidence pairs all three thread candidates against
 * the salted thread id; when the driver knows the turn id — the Root
 * capture turn, from the driver's own turn/start response — the turn
 * evidence pairs only innerTurnId against it, so the turn cell carries
 * app-server-path turn evidence and not just the exec path's. When no
 * driver-known turn id exists (the spawn Child's turn is only learnable
 * from thread/read), no turn fact is fabricated.
 * @param {{envelopeThreadIdHash:(string|null), innerSessionIdHash:(string|null), threadHash:(string|null), turnHash:(string|null)}} capture
 * @param {{scope:'root'|'child', threadHash:string, turnHash:string|null}} authority
 * @returns {{scope:string, candidate:string, authority:string, equal:boolean}[]}
 */
export function freshCaptureJoinFacts(capture, authority) {
  const facts = [...captureAuthorityFacts(capture, authority.scope, 'appServerThreadId', authority.threadHash)];
  if (authority.turnHash !== null) {
    facts.push(...captureAuthorityFacts(capture, authority.scope, 'appServerTurnId', authority.turnHash));
  }
  return facts;
}

/**
 * Pure seam of the persisted-turn correlation, for both scopes. thread/read's
 * turn ordering is non-contractual (scripts/lib/codex-app-server.mjs
 * documents it as an implementation detail), so a scope's captures correlate
 * with the persisted turns by multiset equality over the salted turn-id
 * hashes — never by array position; newest-first and oldest-first turn
 * arrays produce the same fact. Root scope: the Root conversation's two
 * captures (the first Root capture and the Root resume capture). Child
 * scope: the initial Child's TWO captures (the original call and the
 * followup) — both join, so the follow-up capture is never left unjoined. A
 * group with any missing hash reduces false: the authority read did not
 * return the turns the captures require, which is an honest namespace
 * failure. The salted turn-id hashes are returned for the appServerTurnId
 * authority recording (order-independent).
 * @param {{turnHash:(string|null)}[]} captures
 * @param {{id:(string|null)}[]} turns
 * @param {(value:string) => string} salt
 * @returns {{saltedTurnIdHashes:string[], equal:boolean}}
 */
export function correlateTurnSet(captures, turns, salt) {
  const saltedTurnIdHashes = (turns ?? [])
    .map((turn) => turn && typeof turn.id === 'string' ? salt(turn.id) : null)
    .filter((hash) => typeof hash === 'string');
  return {
    saltedTurnIdHashes,
    equal: saltedHashSetsEqual((captures ?? []).map((capture) => capture?.turnHash ?? null), saltedTurnIdHashes),
  };
}

/**
 * Pure seam of the timeout phases' outcome input assembly: expands the
 * frame accounting's dedicated mcp_tool_call status tally — a count map
 * bounded by the tiny status vocabulary, which never overflows the way the
 * 32-entry diagnostic excerpt list can — into the status list
 * deriveTimeoutToolCallOutcome consumes, so every observed call status
 * reaches the outcome derivation.
 * @param {Map<string, number>|undefined} mcpCallStatusCounts
 * @returns {string[]}
 */
export function mcpCallStatusesFromCounts(mcpCallStatusCounts) {
  return [...(mcpCallStatusCounts ?? new Map()).entries()]
    .filter(([status, count]) => typeof status === 'string' && status.length > 0 && Number.isSafeInteger(count) && count > 0)
    .flatMap(([status, count]) => Array.from({ length: count }, () => status));
}

/**
 * Pure seam of the timeout phases' toolCallOutcome (plan closed enum).
 * 'timed-out' means the call ended because of the configured timeout and
 * requires BOTH the durable settlement attributed to the timeout floor
 * (timeoutSettlementArrived returned it) AND Host-transcript evidence that
 * the MCP call itself ended abnormally (a nested mcp_tool_call item whose
 * status failed or errored): without the transcript evidence the settlement
 * alone cannot name the call's fate, and a completed call is never
 * 'timed-out'. Without a timeout-attributed settlement a transcript failure
 * stays 'failed' (a failure not attributable to the timeout), keeping the
 * original failure-over-completion precedence; with no transcript evidence
 * at all the outcome is 'pending' while a settlement landed or the host is
 * still alive, and 'not-observed' only after an observed host exit.
 * @param {{settlement:string|null, mcpCallStatuses:(string|null)[], hostExitObserved:boolean}} input
 * @returns {'completed'|'failed'|'timed-out'|'pending'|'not-observed'}
 */
export function deriveTimeoutToolCallOutcome({ settlement, mcpCallStatuses, hostExitObserved }) {
  const statuses = mcpCallStatuses ?? [];
  const callEndedAbnormally = statuses.some((status) => status === 'failed' || status === 'error');
  const callCompleted = statuses.includes('completed');
  if (settlement !== null && callEndedAbnormally) return 'timed-out';
  if (callEndedAbnormally) return 'failed';
  if (callCompleted) return 'completed';
  return settlement !== null || !hostExitObserved ? 'pending' : 'not-observed';
}

/**
 * Pure seam of the concurrent-Child correlation: multiset equality of two
 * groups of salted hashes. The two concurrent-Child captures are correlated
 * with the two remaining persisted child records as a SET — their durable
 * capture order is completion-dependent, so positional pairing could compare
 * each capture with the wrong Child and emit false equality facts that fail
 * a valid namespace. Multiset equality over the complete groups proves a
 * bijection with no positional assumption and keeps the equality-matrix cell
 * semantics (a cell is true only when every recorded fact is true).
 * @param {(string|null|undefined)[]} leftHashes
 * @param {(string|null|undefined)[]} rightHashes
 * @returns {boolean}
 */
export function saltedHashSetsEqual(leftHashes, rightHashes) {
  const normalize = (hashes) => (hashes ?? [])
    .filter((hash) => typeof hash === 'string' && hash.length > 0)
    .sort();
  const left = normalize(leftHashes);
  const right = normalize(rightHashes);
  return left.length === right.length && left.every((hash, index) => hash === right[index]);
}

/**
 * Pure seam of the direct-config differential: merges the direct
 * [mcp_servers.zcode-mcp-context-probe] stanza into the isolated home's
 * existing config.toml WITHOUT replacing it — the skill-only plugin's
 * registration (features, plugin, marketplace, and hook configuration) was
 * just written by `codex plugin add` and must survive, or the differential
 * would no longer prove the Skill-driven path. Appends the stanza after
 * exactly one blank line (never gluing onto an unterminated last line); if
 * the server table already exists the existing registration wins and the
 * TOML is returned unchanged, so the key is never duplicated.
 * @param {string} existingToml
 * @param {string} serverStanza the stanza block without a leading blank line
 * @returns {string}
 */
export function appendMcpServerConfig(existingToml, serverStanza) {
  if (/^\s*\[mcp_servers\.zcode-mcp-context-probe\]\s*$/m.test(existingToml)) return existingToml;
  if (existingToml.length === 0) return serverStanza;
  const base = existingToml.endsWith('\n') ? existingToml : `${existingToml}\n`;
  return `${base}\n${serverStanza}`;
}

/**
 * Pure seam of the hook-enable step: patches the isolated home's
 * config.toml so the trusted fixture hooks are actually enabled — ensures
 * the `[features]` table sets `hooks = true` (append the table when
 * missing, add the key when the table omits it, flip a `hooks = false`,
 * no-op only when it is already exactly true) — and fails closed on config
 * shapes this driver cannot patch safely (quoted, sub-table,
 * array-of-tables, or dotted-key variants of the features table), so the
 * qualification never silently runs with the required Hook authority
 * evidence disabled.
 * @param {string} existingToml
 * @returns {string}
 */
export function ensureHooksFeatureFlag(existingToml) {
  const lines = existingToml.split('\n');
  const headerIndex = lines.findIndex((line) => /^\s*\[features\]\s*$/.test(line));
  if (headerIndex >= 0) {
    let endIndex = lines.length;
    for (let index = headerIndex + 1; index < lines.length; index += 1) {
      if (/^\s*\[/.test(lines[index])) { endIndex = index; break; }
    }
    const hooksIndex = lines.slice(headerIndex, endIndex).findIndex((line) => /^\s*hooks\s*=/.test(line));
    if (hooksIndex < 0) {
      lines.splice(headerIndex + 1, 0, 'hooks = true');
      return lines.join('\n');
    }
    const absolute = headerIndex + hooksIndex;
    if (/^\s*hooks\s*=\s*true\s*$/.test(lines[absolute])) return existingToml;
    lines[absolute] = 'hooks = true';
    return lines.join('\n');
  }
  if (/^\s*(\[\[?["']?features|features\s*[.[])/m.test(existingToml)) {
    throw probeError('PROBE_CONFIG_PATCH', 'config.toml carries a features table this driver cannot patch safely; failing closed rather than running with the required Hook evidence disabled.');
  }
  if (existingToml.length === 0) return '[features]\nhooks = true\n';
  const base = existingToml.endsWith('\n') ? existingToml : `${existingToml}\n`;
  return `${base}\n[features]\nhooks = true\n`;
}

/**
 * Pure seam of the spawn-handle extraction: returns the child agent handle
 * from a completed collab_tool_call frame, validating the narrowest
 * documented shape — the value inside the spawn result's agent/agentId
 * field (accepting the result as a structured object or a JSON string,
 * directly on the item or inside its output) and requiring it to be a Codex
 * thread identifier (UUID format). Frames without that field yield null:
 * other UUID-shaped values in the frame (call ids, input thread handles)
 * are distractors and are never swept.
 * @param {unknown} frame
 * @returns {string|null}
 */
export function spawnAgentHandleFromFrame(frame) {
  if (!frame || typeof frame !== 'object' || frame.type !== 'item.completed') return null;
  const item = frame.item;
  if (!item || typeof item !== 'object' || item.type !== 'collab_tool_call' || item.status !== 'completed') return null;
  const candidates = [];
  for (const source of [item.output, item.result, item]) {
    if (typeof source === 'string') {
      try { candidates.push(JSON.parse(source)); } catch { /* not a JSON result payload */ }
    } else if (source && typeof source === 'object') {
      candidates.push(source);
    }
  }
  for (const object of candidates) {
    for (const key of ['agentId', 'agent_id', 'agent']) {
      const value = object?.[key];
      if (typeof value === 'string' && THREAD_ID_PATTERN.test(value)) return value;
    }
  }
  return null;
}

/** The thread-candidate fields each capture carries, with their event keys. */
const THREAD_CANDIDATE_FIELDS = Object.freeze([
  ['envelopeThreadId', 'envelopeThreadIdHash'],
  ['innerSessionId', 'innerSessionIdHash'],
  ['innerThreadId', 'threadHash'],
]);

/**
 * Pure gate for the app-server capture phase's equality evidence. The
 * app-server-path equality facts may be recorded only when the bounded
 * STRUCTURED-SKILL TREATMENT turn COMPLETED and it durably produced the
 * expected Root and Child captures attributable to that turn's threads —
 * the text-only control turn and the `mcpServer/tool/call` transport
 * control never open this gate.
 * Attribution is by ANY candidate hash: a fresh capture counts as
 * attributable to a thread when ANY of its salted candidate hashes
 * (envelopeThreadIdHash, innerSessionIdHash, innerThreadIdHash) matches ANY
 * of that thread's candidate hashes. This is DISCOVERY, not preselection —
 * which _meta field actually carries the thread identity on the app-server
 * path is exactly what the matrix exists to discover, so the gate must not
 * assume innerThreadId before the facts are recorded; the recorded facts
 * then carry the matching candidate as true and the others as honest
 * contrasts. When the gate stays closed — the model never called
 * capture_context on the app-server path, or the attribution failed — no
 * app-server-path equality facts are recorded, so the reducer's
 * appServerThreadId/appServerTurnId cells stay fact-less and
 * identityNamespaceQualified cannot qualify from them.
 * @param {{turnStatus:string|null, freshCaptures:{envelopeThreadIdHash:(string|null), innerSessionIdHash:(string|null), threadHash:(string|null)}[], rootThreadCandidateHashes:(string|null)[], childThreadCandidateHashes:(string|null)[][]}} input
 * @returns {{collected:boolean, rootCaptureIndex:number|null, childCaptureIndex:number|null, childRecordIndex:number|null}}
 */
export function appServerCaptureEvidenceGate({ turnStatus, freshCaptures, rootThreadCandidateHashes, childThreadCandidateHashes }) {
  const notCollected = { collected: false, rootCaptureIndex: null, childCaptureIndex: null, childRecordIndex: null };
  if (turnStatus !== 'completed') return notCollected;
  const captureList = freshCaptures ?? [];
  const rootHashes = (rootThreadCandidateHashes ?? []).filter((hash) => typeof hash === 'string');
  const childHashGroups = (childThreadCandidateHashes ?? [])
    .map((group) => (group ?? []).filter((hash) => typeof hash === 'string'))
    .filter((group) => group.length > 0);
  const candidateHashesOf = (capture) => [capture?.envelopeThreadIdHash ?? null, capture?.innerSessionIdHash ?? null, capture?.threadHash ?? null]
    .filter((hash) => typeof hash === 'string');
  const rootCaptureIndex = captureList.findIndex((capture) => candidateHashesOf(capture).some((hash) => rootHashes.includes(hash)));
  if (rootCaptureIndex < 0) return notCollected;
  for (let captureIndex = 0; captureIndex < captureList.length; captureIndex += 1) {
    if (captureIndex === rootCaptureIndex) continue;
    const hashes = candidateHashesOf(captureList[captureIndex]);
    for (let recordIndex = 0; recordIndex < childHashGroups.length; recordIndex += 1) {
      if (hashes.some((hash) => childHashGroups[recordIndex].includes(hash))) {
        return { collected: true, rootCaptureIndex, childCaptureIndex: captureIndex, childRecordIndex: recordIndex };
      }
    }
  }
  return notCollected;
}

/**
 * Pure seam of the concurrent-Child hook correlation: builds the
 * order-independent equality facts for the two concurrent-Child captures
 * against their two SubagentStart hooks. Capture order is
 * completion-dependent and SubagentStart order is creation-dependent, so
 * positional pairing could compare each capture with the wrong hook and
 * emit false equality facts; each fact is instead the multiset equality of
 * the two captures' candidate hashes against the two hooks' authority
 * hashes — a bijection with no positional assumption, using the same
 * candidate/authority pairs as the per-pair facts (turn authorities pair
 * only innerTurnId) so the cell semantics are kept: contrast namespaces
 * reduce false exactly as before. A pair with any missing hash is missing
 * evidence, not a contradiction, and is skipped.
 * @param {{envelopeThreadIdHash:(string|null), innerSessionIdHash:(string|null), threadHash:(string|null), turnHash:(string|null)}[]} captures
 * @param {{sessionHash:(string|null), turnHash:(string|null), agentHash:(string|null)}[]} hooks
 * @returns {{scope:string, candidate:string, authority:string, equal:boolean}[]}
 */
export function concurrentChildHookFacts(captures, hooks) {
  const captureList = captures ?? [];
  const hookList = hooks ?? [];
  const facts = [];
  const setsComplete = (left, right) => left.every((hash) => hash !== null) && right.every((hash) => hash !== null);
  for (const [authority, authorityField] of [['hookSessionId', 'sessionHash'], ['hookAgentId', 'agentHash']]) {
    for (const [candidate, candidateField] of THREAD_CANDIDATE_FIELDS) {
      const candidateHashes = captureList.map((capture) => capture?.[candidateField] ?? null);
      const authorityHashes = hookList.map((hook) => hook?.[authorityField] ?? null);
      if (!setsComplete(candidateHashes, authorityHashes)) continue;
      facts.push({ scope: 'child', candidate, authority, equal: saltedHashSetsEqual(candidateHashes, authorityHashes) });
    }
  }
  const candidateTurnHashes = captureList.map((capture) => capture?.turnHash ?? null);
  const authorityTurnHashes = hookList.map((hook) => hook?.turnHash ?? null);
  if (setsComplete(candidateTurnHashes, authorityTurnHashes)) {
    facts.push({ scope: 'child', candidate: 'innerTurnId', authority: 'hookTurnId', equal: saltedHashSetsEqual(candidateTurnHashes, authorityTurnHashes) });
  }
  return facts;
}

/**
 * Pure seam of the returnedChildHandle correlation: builds the equality
 * facts between the child captures' thread candidates and the handles
 * parsed independently from the spawn_agent transcript. The first parsed
 * handle is the initial Child's (its spawn completed before the concurrent
 * pair was started), so its facts are per-pair; the two concurrent handles
 * pair by multiset equality over the salted hashes, with no positional
 * assumption. Fewer parsed handles than children means the authority is
 * honestly missing for the missing pair: no facts are fabricated, and the
 * persisted app-server child ids stay under their own appServerThreadId
 * authority name.
 * @param {{envelopeThreadIdHash:(string|null), innerSessionIdHash:(string|null), threadHash:(string|null)}|null} initialCapture
 * @param {{threadHash:(string|null)}[]} concurrentCaptures
 * @param {string[]} saltedHandleHashes the parsed handles, salted by the caller
 * @returns {{scope:string, candidate:string, authority:string, equal:boolean}[]}
 */
export function returnedChildHandleFacts(initialCapture, concurrentCaptures, saltedHandleHashes) {
  const handles = saltedHandleHashes ?? [];
  const facts = [];
  if (initialCapture && handles.length >= 1) {
    for (const [candidate, candidateField] of THREAD_CANDIDATE_FIELDS) {
      const candidateHash = initialCapture?.[candidateField] ?? null;
      facts.push({ scope: 'child', candidate, authority: 'returnedChildHandle', equal: candidateHash !== null && candidateHash === handles[0] });
    }
  }
  if (handles.length >= 3) {
    facts.push({
      scope: 'child',
      candidate: 'innerThreadId',
      authority: 'returnedChildHandle',
      equal: saltedHashSetsEqual((concurrentCaptures ?? []).map((capture) => capture?.threadHash ?? null), [handles[1], handles[2]]),
    });
  }
  return facts;
}

/**
 * Waits for one app-server turn to reach a terminal notification.
 * @param {ReturnType<typeof startAppServerSession>} session
 * @param {string} threadId @param {string} turnId @param {number} ceilingMs
 * @returns {Promise<'completed'|'failed'|'interrupted'|null>} the terminal turn status, or null at the ceiling
 */
async function appServerTurnSettled(session, threadId, turnId, ceilingMs) {
  const deadline = Date.now() + ceilingMs;
  for (;;) {
    const status = appServerTurnStatusFromNotifications(session.notifications, threadId, turnId);
    if (status !== null) return status;
    if (Date.now() > deadline) return null;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
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
 * @returns {Promise<string|null>} the observed settlement value, or null
 */
async function settlementArrived(callNonce, graceMs, durableEvents) {
  try {
    await waitUntil(async () => (await durableEvents()).some((record) => record.event.kind === 'hold-settled' && record.event.callNonce === callNonce), graceMs, '');
    const records = await durableEvents();
    const settled = records.find((record) => record.event.kind === 'hold-settled' && record.event.callNonce === callNonce);
    return settled && typeof settled.event.settlement === 'string' ? settled.event.settlement : null;
  } catch {
    return null;
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
 * @returns {Promise<string|null>} the observed settlement value, or null
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
    const records = await durableEvents();
    const settled = records.find((record) => record.event.kind === 'hold-settled' && record.event.callNonce === callNonce);
    return settled && typeof settled.event.settlement === 'string' ? settled.event.settlement : null;
  } catch {
    return null;
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
    process.exitCode = result.context && Object.values(result.context.assertions).every((value) => value === true) ? 0 : 1;
  } catch (error) {
    process.stderr.write(`qualification failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
