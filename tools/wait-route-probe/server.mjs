// @ts-check
/**
 * Disposable stdio MCP probe server for the source-guided foreground-wait
 * investigation. It exposes exactly three tools and records a private bounded
 * JSONL trace:
 *
 * - `capture_entry`: captures `handler-entered` BEFORE inspecting identity,
 *   then hold/completion events (the short hold is fixture-only).
 * - `hold_open`: a bounded hold used by later lifecycle cases.
 * - `prepare_dependency`: records a synthetic invocation dependency for a
 *   later viable hook candidate.
 *
 * Raw identifiers are salted with the per-run nonce and never retained; no
 * user paths, prompts, or credentials reach the trace. The executable exits
 * within a bounded grace after its transport closes so the host never leaks a
 * server process.
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { appendFile, mkdir, open } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { CAPTURE_HOLD_MS, DEPENDENCY_TOOL_NAME, HOLD_TOOL_NAME, CAPTURE_TOOL_NAME, MAXIMUM_PROMPT_HOLD_MS, PROMPT_HOLD_TOOL_NAME, SERVER_NAME, fixtureError, errorCode, parseProcessIdentityLine } from './fixture.mjs';

/** The closed trace vocabulary; unknown kinds are instrument failures. */
export const TRACE_EVENT_KINDS = new Set(Object.freeze([
  'server-started',
  'handler-entered',
  'handler-identity',
  'handler-completed',
  'hold-started',
  'hold-settled',
  'prompt-hold-started',
  'prompt-hold-settled',
  'dependency-prepared',
  'case-started',
  'case-finished',
]));
export const TRACE_MAX_EVENT_BYTES = 8 * 1024;
export const TRACE_MAX_RECORDS = 4096;
export const TRACE_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
export const MAXIMUM_HOLD_MS = 30_000;
export const MAXIMUM_DEPENDENCY_LABEL_BYTES = 256;
/**
 * Bounded grace before the disposable server force-exits after transport
 * close, long enough for in-flight trace appends to land.
 */
export const SERVER_EXIT_GRACE_MS = 6_000;

const TRACE_FILE_NAME = 'events.jsonl';
const MAXIMUM_META_FIELD_NAMES = 32;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Salts one raw identifier under the per-run nonce. Only the digest is ever
 * retained; raw values never reach the trace.
 * @param {string} nonce @param {string} value
 */
export function hashTraceValue(nonce, value) {
  return createHash('sha256').update(`${nonce}:${value}`).digest('hex');
}

/**
 * The fixed absolute process-inspection candidates, following the established
 * pattern of tools/mcp-context-probe/qualify.mjs: the inspection executable
 * is resolved from this list only, never through the caller's PATH, so a
 * shadowing or missing `ps` cannot change identity capture behavior.
 */
export const PROCESS_INSPECTION_CANDIDATES = Object.freeze(['/bin/ps', '/usr/bin/ps']);

/**
 * Returns the first fixed candidate that is a regular executable file, or
 * null when none qualifies.
 * @returns {string|null}
 */
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
 * Captures a collision-resistant process identity, matching the established
 * pattern of tools/mcp-context-probe/qualify.mjs: start time alone has
 * one-second resolution, so the identity combines the kernel-provided start
 * time, parent pid, and command name — a recycled pid must match all three
 * to ever be signalled. Returns null when identity capture is unavailable
 * (win32, no inspection executable, or an unparseable listing).
 * @param {number} pid
 * @returns {string|null}
 */
export function captureProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || process.platform === 'win32') return null;
  const executable = resolveProcessInspectionExecutable();
  if (executable === null) return null;
  const listed = spawnSync(executable, ['-p', String(pid), '-o', 'lstart=,ppid=,comm='], { encoding: 'utf8', timeout: 5_000 });
  if (listed.status !== 0 || typeof listed.stdout !== 'string') return null;
  // ps prints `lstart ppid comm` on one line; comm may be the executable
  // PATH and contain spaces (macOS ps returns the pathname there), so the
  // line is split at the year/parent-pid boundary and the WHOLE remainder
  // is kept as comm.
  const parsed = parseProcessIdentityLine(listed.stdout);
  if (parsed === null) return null;
  return `${parsed.lstart}|ppid=${parsed.ppid}|comm=${parsed.comm}`;
}

/**
 * Appends one bounded trace event to the private per-run JSONL trace. The
 * kind must be in the closed vocabulary and the serialized event must stay
 * within the byte bound; violations are instrument failures. Every event is
 * stamped with `at` (epoch milliseconds) so classification can distinguish
 * evidence that arrived within the observation budget from late arrivals.
 * @param {{runDirectory: string, runNonce: string, event: Record<string, unknown>}} input
 */
export async function appendTraceEvent(input) {
  const { runDirectory, runNonce, event } = input;
  if (!isAbsolute(runDirectory)) throw fixtureError('WAIT_ROUTE_TRACE_DIR_RELATIVE', 'The trace directory must be an absolute path.');
  if (!/^[0-9a-f]{64}$/.test(runNonce)) throw fixtureError('WAIT_ROUTE_TRACE_NONCE_INVALID', 'The trace nonce must be 64 lowercase hexadecimal characters.');
  if (!isPlainObject(event)) throw fixtureError('WAIT_ROUTE_TRACE_EVENT_INVALID', 'A trace event must be a JSON object.');
  if (typeof event.kind !== 'string' || !TRACE_EVENT_KINDS.has(event.kind)) {
    throw fixtureError('WAIT_ROUTE_TRACE_KIND_UNKNOWN', `The trace kind must be one of the closed vocabulary: ${[...TRACE_EVENT_KINDS].join(', ')}.`);
  }
  const stamped = { at: Date.now(), ...event };
  const line = `${JSON.stringify(stamped)}\n`;
  if (Buffer.byteLength(line, 'utf8') > TRACE_MAX_EVENT_BYTES) {
    throw fixtureError('WAIT_ROUTE_TRACE_EVENT_TOO_LARGE', 'A trace event exceeded its byte bound.');
  }
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await appendFile(join(runDirectory, TRACE_FILE_NAME), line, { encoding: 'utf8', mode: 0o600 });
}

/**
 * Reads the bounded trace through a bounded incremental buffer: consumption
 * STOPS as soon as the record or byte cap is reached, so an oversize trace
 * is reported as truncated without ever being fully loaded into memory.
 * Never returns more than the record cap and reports truncation honestly
 * instead of silently dropping evidence.
 * @param {{runDirectory: string, runNonce?: string}} input
 * @returns {Promise<{records: Record<string, unknown>[], truncated: boolean}>}
 */
export async function readTraceEvents(input) {
  const { runDirectory } = input;
  const handle = await open(join(runDirectory, TRACE_FILE_NAME), 'r').catch((error) => {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  });
  if (handle === null) return { records: [], truncated: false };
  // 64 KiB reads with a UTF-8 decoder for chunk boundaries: bounded memory
  // regardless of the file size, and no O(n) full-file string allocation.
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  /** @type {Record<string, unknown>[]} */
  const records = [];
  let bytes = 0;
  let totalBytes = 0;
  let truncated = false;
  let carry = '';

  /** Parses one complete line under the caps; returns true when reading must stop.
   * @param {string} line */
  const consumeLine = (line) => {
    if (line.trim().length === 0) return false;
    bytes += Buffer.byteLength(line, 'utf8');
    if (records.length >= TRACE_MAX_RECORDS || bytes > TRACE_MAX_TOTAL_BYTES) {
      truncated = true;
      return true;
    }
    // The per-event cap holds regardless of line termination: a complete
    // (newline-terminated) line larger than one maximal event is
    // out-of-bound trace evidence, reported as truncation exactly like an
    // oversized unterminated line — never parsed or returned.
    if (Buffer.byteLength(line, 'utf8') > TRACE_MAX_EVENT_BYTES) {
      truncated = true;
      return true;
    }
    try {
      const parsed = JSON.parse(line);
      if (isPlainObject(parsed)) records.push(parsed);
    } catch {
      // A torn line is reported as truncation, never silently dropped.
      truncated = true;
    }
    return false;
  };

  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        // End of file: the final unterminated line still counts.
        carry += decoder.end();
        if (carry.length > 0) consumeLine(carry);
        break;
      }
      // Raw bytes are counted AS READ (including newlines), so a blank-line
      // flood — whose lines carry no bytes under per-line accounting — is
      // still bounded by the total cap.
      totalBytes += bytesRead;
      carry += decoder.write(buffer.subarray(0, bytesRead));
      let newline = carry.indexOf('\n');
      while (newline >= 0) {
        const line = carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        if (consumeLine(line)) return { records, truncated };
        newline = carry.indexOf('\n');
      }
      // Bounds are re-checked BEFORE the next accumulation, on the PENDING
      // line buffer: an unterminated line longer than one maximal event can
      // never become a valid bounded record, so reading stops here and
      // reports truncation instead of accumulating the carry until EOF.
      if (totalBytes > TRACE_MAX_TOTAL_BYTES || Buffer.byteLength(carry, 'utf8') > TRACE_MAX_EVENT_BYTES) {
        return { records, truncated: true };
      }
    }
  } finally {
    await handle.close().catch(() => {});
  }
  return { records, truncated };
}

/**
 * Extracts bounded identity fingerprints from the host-supplied call
 * metadata. Only salted hashes and field NAMES are retained; raw values are
 * dropped immediately. The hook executor injects the owning thread id, and
 * turn metadata may carry thread/turn fields; nothing is required here.
 * @param {unknown} meta @param {string} nonce
 */
function identityFingerprints(meta, nonce) {
  if (!isPlainObject(meta)) return { threadHash: null, turnHash: null, metaFieldNames: [] };
  const envelope = meta;
  const turnMetadata = isPlainObject(envelope['x-codex-turn-metadata']) ? envelope['x-codex-turn-metadata'] : {};
  const threadId = typeof envelope.threadId === 'string' && envelope.threadId.length > 0 ? envelope.threadId
    : typeof turnMetadata.thread_id === 'string' && turnMetadata.thread_id.length > 0 ? turnMetadata.thread_id : null;
  const turnId = typeof turnMetadata.turn_id === 'string' && turnMetadata.turn_id.length > 0 ? turnMetadata.turn_id : null;
  const metaFieldNames = Object.keys(envelope)
    .slice(0, MAXIMUM_META_FIELD_NAMES)
    .sort();
  return {
    threadHash: threadId === null ? null : hashTraceValue(nonce, threadId),
    turnHash: turnId === null ? null : hashTraceValue(nonce, turnId),
    metaFieldNames,
  };
}

/** @param {string} message */
function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Builds the probe server. The trace directory and nonce are required at
 * construction so the executable and the in-process test seam share one
 * behavior.
 * @param {{runDirectory: string, runNonce: string, holdMs?: number, appendImpl?: typeof appendTraceEvent}} input
 */
export function createWaitRouteServer(input) {
  const { runDirectory, runNonce } = input;
  if (!isAbsolute(runDirectory)) throw fixtureError('WAIT_ROUTE_TRACE_DIR_RELATIVE', 'The trace directory must be an absolute path.');
  if (!/^[0-9a-f]{64}$/.test(runNonce)) throw fixtureError('WAIT_ROUTE_TRACE_NONCE_INVALID', 'The trace nonce must be 64 lowercase hexadecimal characters.');
  const holdMs = input.holdMs ?? CAPTURE_HOLD_MS;
  const appendImpl = input.appendImpl ?? appendTraceEvent;

  const server = new Server({ name: SERVER_NAME, version: '0.1.0' }, { capabilities: { tools: {} } });

  /**
   * Settles every pending held call exactly once. Entries register before the
   * durable start append so a transport close during the append still settles.
   * @type {Set<{callNonce: string, finish: (settlement: string) => void}>}
   */
  const pendingHolds = new Set();
  const settlePendingHoldsOnDisconnect = () => {
    for (const entry of [...pendingHolds]) entry.finish('transport-close');
  };
  const extendedServer = /** @type {typeof server & {waitRouteDisconnect: {settlePendingHoldsOnDisconnect: () => void}}} */ (/** @type {unknown} */ (server));
  extendedServer.waitRouteDisconnect = { settlePendingHoldsOnDisconnect };

  // Every probe tool is DRIVER- and HOOK-facing only: an empty visibility
  // list (the shape the official model-hidden hook fixture supplies,
  // rmcp-client/src/bin/test_stdio_server.rs: `_meta.ui.visibility: []`)
  // keeps the tools out of the model's tool list. Without it, a model that
  // called capture_entry directly could be mistaken for hook dispatch.
  const MODEL_HIDDEN_META = Object.freeze({ ui: Object.freeze({ visibility: Object.freeze([]) }) });

  const toolDefinitions = Object.freeze([
    Object.freeze({
      name: CAPTURE_TOOL_NAME,
      description: `Fixture-only capture: records handler entry before identity, holds ${holdMs} ms (fixture-only), then records completion.`,
      inputSchema: Object.freeze({ type: 'object', properties: Object.freeze({}), additionalProperties: false }),
      _meta: MODEL_HIDDEN_META,
    }),
    Object.freeze({
      name: HOLD_TOOL_NAME,
      description: `Fixture-only bounded hold of 1 to ${MAXIMUM_HOLD_MS} ms so a later case can observe whichever settlement actually occurs.`,
      inputSchema: Object.freeze({
        type: 'object',
        properties: Object.freeze({ ms: Object.freeze({ type: 'integer', minimum: 1, maximum: MAXIMUM_HOLD_MS }) }),
        additionalProperties: false,
      }),
      _meta: MODEL_HIDDEN_META,
    }),
    Object.freeze({
      name: PROMPT_HOLD_TOOL_NAME,
      description: `Fixture-only bounded UserPromptSubmit hold of 1 to ${MAXIMUM_PROMPT_HOLD_MS} ms; settles exactly once through a durable event.`,
      inputSchema: Object.freeze({
        type: 'object',
        properties: Object.freeze({ ms: Object.freeze({ type: 'integer', minimum: 1, maximum: MAXIMUM_PROMPT_HOLD_MS }) }),
        additionalProperties: false,
      }),
      _meta: MODEL_HIDDEN_META,
    }),
    Object.freeze({
      name: DEPENDENCY_TOOL_NAME,
      description: 'Fixture-only: records a synthetic bounded invocation dependency for a later viable hook candidate.',
      inputSchema: Object.freeze({
        type: 'object',
        properties: Object.freeze({ label: Object.freeze({ type: 'string', minLength: 1, maxLength: MAXIMUM_DEPENDENCY_LABEL_BYTES }) }),
        required: Object.freeze(['label']),
        additionalProperties: false,
      }),
      _meta: MODEL_HIDDEN_META,
    }),
  ]);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions.map((tool) => ({ ...tool })) }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params?.name;
    if (typeof name !== 'string' || !toolDefinitions.some((tool) => tool.name === name)) {
      return errorResult('Unknown wait-route probe tool.');
    }
    const args = request.params?.arguments;
    if (!isPlainObject(args)) return errorResult('Probe tools require an arguments object.');
    try {
      if (name === CAPTURE_TOOL_NAME) return await captureEntry(request.params?._meta, extra);
      if (name === HOLD_TOOL_NAME) return await holdOpen(args, extra);
      if (name === PROMPT_HOLD_TOOL_NAME) return await promptHold(args, extra);
      return await prepareDependency(args);
    } catch (error) {
      return errorResult(`Probe tool failed: ${errorCode(error) || 'error'}`);
    }
  });

  /**
   * The two-second capture tool: handler entry is durable BEFORE identity is
   * inspected, then the fixture-only hold, then completion.
   * @param {unknown} meta @param {{signal?: AbortSignal}} extra
   */
  async function captureEntry(meta, extra) {
    const callNonce = randomBytes(16).toString('hex');
    // ENTRY FIRST: the durable handler-entered event is written before any
    // identity inspection, so even a malformed host payload proves entry.
    await appendImpl({ runDirectory, runNonce, event: { kind: 'handler-entered', callNonce } });
    const fingerprints = identityFingerprints(meta, runNonce);
    await appendImpl({
      runDirectory,
      runNonce,
      event: { kind: 'handler-identity', callNonce, ...fingerprints },
    });
    await new Promise((resolveHold) => setTimeout(resolveHold, holdMs));
    if (extra.signal?.aborted) {
      await appendImpl({ runDirectory, runNonce, event: { kind: 'handler-completed', callNonce, settlement: 'signal-abort' } });
    } else {
      await appendImpl({ runDirectory, runNonce, event: { kind: 'handler-completed', callNonce, settlement: 'completed' } });
    }
    return { content: [{ type: 'text', text: 'wait-route-probe fixture-only: entry captured' }] };
  }

  /**
   * Bounded hold; settles on the caller's abort signal, the declared deadline,
   * or a transport close, exactly once.
   * @param {Record<string, unknown>} args @param {{signal?: AbortSignal}} extra
   */
  async function holdOpen(args, extra) {
    // The MCP layer does not enforce the advertised input schema: the default
    // applies ONLY when ms is omitted; every other nonconforming value is a
    // tool error, never a silently different hold.
    let requestedMs;
    if (args.ms === undefined) requestedMs = 1_000;
    else if (typeof args.ms !== 'number') throw fixtureError('WAIT_ROUTE_PROBE_HOLD_INVALID', 'ms must be a number of milliseconds.');
    else requestedMs = args.ms;
    if (!Number.isSafeInteger(requestedMs) || requestedMs < 1 || requestedMs > MAXIMUM_HOLD_MS) {
      throw fixtureError('WAIT_ROUTE_PROBE_HOLD_INVALID', `ms must be an integer of 1 to ${MAXIMUM_HOLD_MS}.`);
    }
    const callNonce = randomBytes(16).toString('hex');
    /** @type {(value: string) => void} */
    let resolveSettlement = () => {};
    /** @type {{callNonce: string, finish: (settlement: string) => void}} */
    const entry = {
      callNonce,
      finish: (settlement) => {
        if (!pendingHolds.has(entry)) return;
        pendingHolds.delete(entry);
        resolveSettlement(settlement);
      },
    };
    const settlementPromise = new Promise((resolve) => { resolveSettlement = resolve; });
    pendingHolds.add(entry);
    if (extra.signal?.aborted) entry.finish('signal-abort');
    else extra.signal?.addEventListener('abort', () => entry.finish('signal-abort'), { once: true });
    const deadline = setTimeout(() => entry.finish('deadline'), requestedMs);
    deadline.unref?.();
    try {
      await appendImpl({ runDirectory, runNonce, event: { kind: 'hold-started', callNonce, holdMs: requestedMs } });
    } catch (error) {
      pendingHolds.delete(entry);
      throw error;
    }
    const settlement = await settlementPromise;
    clearTimeout(deadline);
    await appendImpl({ runDirectory, runNonce, event: { kind: 'hold-settled', callNonce, settlement } });
    return { content: [{ type: 'text', text: 'wait-route-probe fixture-only: held' }] };
  }

  /**
   * The Task 4 UserPromptSubmit hold: a bounded hold far above the capture
   * hold, recorded through its own durable events so the driver can measure
   * the exact pending interval and whichever settlement actually occurred.
   * Settles on the caller's abort signal, the declared deadline, or a
   * transport close, exactly once (the same pendingHolds machinery).
   * @param {Record<string, unknown>} args @param {{signal?: AbortSignal}} extra
   */
  async function promptHold(args, extra) {
    const callNonce = randomBytes(16).toString('hex');
    let requestedMs;
    if (args.ms === undefined) requestedMs = 1_000;
    else if (typeof args.ms !== 'number') throw fixtureError('WAIT_ROUTE_PROBE_PROMPT_HOLD_INVALID', 'ms must be a number of milliseconds.');
    else requestedMs = args.ms;
    if (!Number.isSafeInteger(requestedMs) || requestedMs < 1 || requestedMs > MAXIMUM_PROMPT_HOLD_MS) {
      throw fixtureError('WAIT_ROUTE_PROBE_PROMPT_HOLD_INVALID', `ms must be an integer of 1 to ${MAXIMUM_PROMPT_HOLD_MS}.`);
    }
    // ENTRY FIRST, then the hold interval, then the settlement — the durable
    // handler-entered/handler-completed pair keeps the Task 2 entry semantics
    // while the prompt-hold events carry the interval bounds.
    await appendImpl({ runDirectory, runNonce, event: { kind: 'handler-entered', callNonce } });
    /** @type {(value: string) => void} */
    let resolveSettlement = () => {};
    /** @type {{callNonce: string, finish: (settlement: string) => void}} */
    const entry = {
      callNonce,
      finish: (settlement) => {
        if (!pendingHolds.has(entry)) return;
        pendingHolds.delete(entry);
        resolveSettlement(settlement);
      },
    };
    const settlementPromise = new Promise((resolve) => { resolveSettlement = resolve; });
    pendingHolds.add(entry);
    if (extra.signal?.aborted) entry.finish('signal-abort');
    else extra.signal?.addEventListener('abort', () => entry.finish('signal-abort'), { once: true });
    const deadline = setTimeout(() => entry.finish('deadline'), requestedMs);
    deadline.unref?.();
    try {
      await appendImpl({ runDirectory, runNonce, event: { kind: 'prompt-hold-started', callNonce, ms: requestedMs } });
    } catch (error) {
      pendingHolds.delete(entry);
      throw error;
    }
    const settlement = await settlementPromise;
    clearTimeout(deadline);
    await appendImpl({ runDirectory, runNonce, event: { kind: 'prompt-hold-settled', callNonce, settlement } });
    await appendImpl({ runDirectory, runNonce, event: { kind: 'handler-completed', callNonce, settlement: settlement === 'deadline' ? 'completed' : settlement } });
    return { content: [{ type: 'text', text: 'WAIT_ROUTE_PROBE_HOOK_HOLD_SETTLED' }] };
  }

  /**
   * Records one synthetic bounded invocation dependency; the label is
   * retained only as a salted hash.
   * @param {Record<string, unknown>} args
   */
  async function prepareDependency(args) {
    const label = args.label;
    if (typeof label !== 'string' || label.length === 0 || Buffer.byteLength(label, 'utf8') > MAXIMUM_DEPENDENCY_LABEL_BYTES) {
      throw fixtureError('WAIT_ROUTE_PROBE_LABEL_INVALID', `label must be a nonempty string of at most ${MAXIMUM_DEPENDENCY_LABEL_BYTES} bytes.`);
    }
    const labelHash = hashTraceValue(runNonce, label);
    await appendImpl({ runDirectory, runNonce, event: { kind: 'dependency-prepared', labelHash } });
    return { content: [{ type: 'text', text: 'wait-route-probe fixture-only: dependency prepared' }] };
  }

  return extendedServer;
}

/**
 * Reads the probe trace environment into a trace description.
 * @returns {{runDirectory: string, runNonce: string, eventsPath: string}}
 */
export function waitRouteTraceFromEnv() {
  const eventsPath = process.env.WAIT_ROUTE_PROBE_TRACE;
  const runNonce = process.env.WAIT_ROUTE_PROBE_NONCE;
  if (!eventsPath || !runNonce) {
    throw fixtureError('WAIT_ROUTE_ENV_MISSING', 'WAIT_ROUTE_PROBE_TRACE and WAIT_ROUTE_PROBE_NONCE are required.');
  }
  // The BASENAME must be exactly events.jsonl: a suffix match would accept
  // e.g. not-events.jsonl while the server writes join(runDirectory,
  // 'events.jsonl') — silently reading a different file than supplied.
  if (!isAbsolute(eventsPath) || basename(eventsPath) !== TRACE_FILE_NAME) {
    throw fixtureError('WAIT_ROUTE_ENV_INVALID', 'WAIT_ROUTE_PROBE_TRACE must be the canonical absolute events.jsonl path.');
  }
  if (!/^[0-9a-f]{64}$/.test(runNonce)) {
    throw fixtureError('WAIT_ROUTE_TRACE_NONCE_INVALID', 'The trace nonce must be 64 lowercase hexadecimal characters.');
  }
  return { runDirectory: dirname(eventsPath), runNonce, eventsPath };
}

/**
 * Watches the process's own stdin for end/close exactly once. The MCP SDK's
 * stdio transport never fires onclose on an abrupt client death, so this
 * watcher is what lets the disposable server exit instead of lingering.
 * @param {{onDisconnect: () => void}} options
 */
export function installStdinDisconnectWatcher(options) {
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    options.onDisconnect();
  };
  process.stdin.on('end', fire);
  process.stdin.on('close', fire);
  return () => {
    process.stdin.off('end', fire);
    process.stdin.off('close', fire);
  };
}

/**
 * Salts and truncates one process identity into a fingerprint for durable
 * retention: the raw identity string can carry the Node installation's
 * executable PATH (macOS `ps` may return the pathname in `comm`), and the
 * trace is retained — so only a per-run-salted digest may be stored. Cleanup
 * fingerprints the live identity with the same per-run nonce, keeping the
 * comparison exact while the trace never carries raw user paths.
 * @param {string} nonce @param {string} identity
 * @returns {string} truncated hex digest (32 characters)
 */
export function fingerprintProcessIdentity(nonce, identity) {
  return createHash('sha256').update(`${nonce}:${identity}`).digest('hex').slice(0, 32);
}

/** Runs the executable: bounded startup trace, then the server, then a bounded exit. */
export async function runWaitRouteServerExecutable() {
  const trace = waitRouteTraceFromEnv();
  await appendTraceEvent({
    runDirectory: trace.runDirectory,
    runNonce: trace.runNonce,
    // The startup identity lets cleanup verify the recorded pid before any
    // signal: a recycled pid can never reproduce the kernel start time,
    // parent pid, and command name together. It is retained only as a
    // per-run-salted fingerprint — the raw string can carry the Node
    // installation's user-home path, and the trace is retained.
    event: { kind: 'server-started', serverPid: process.pid, parentPid: process.ppid, identityHash: fingerprintProcessIdentity(trace.runNonce, captureProcessIdentity(process.pid) ?? '') },
  });
  const server = createWaitRouteServer({ runDirectory: trace.runDirectory, runNonce: trace.runNonce });
  installStdinDisconnectWatcher({
    onDisconnect: () => {
      server.waitRouteDisconnect.settlePendingHoldsOnDisconnect();
      const timer = setTimeout(() => process.exit(0), SERVER_EXIT_GRACE_MS);
      timer?.unref?.();
    },
  });
  await server.connect(new StdioServerTransport());
}

/** @param {string} left @param {string} right */
function sameEntryPath(left, right) {
  return left === right || `${left}${sep()}` === right;
}

/** @returns {string} */
function sep() {
  return process.platform === 'win32' ? '\\' : '/';
}

if (process.argv[1] && sameEntryPath(fileURLToPath(import.meta.url), resolve(process.argv[1]))) {
  await runWaitRouteServerExecutable();
}
