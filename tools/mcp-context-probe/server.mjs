// @ts-nocheck
/**
 * Disposable stdio MCP probe server for the real-Host Codex invocation-context
 * qualification. It exposes exactly three tools, reads identity only from the
 * host-supplied per-call `_meta`, hashes raw values immediately under the
 * per-run nonce, and records durable evidence through the observer. It never
 * accepts identity arguments and never writes `result.json`.
 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import {
  appendProbeEvent,
  canonicalJson,
  hashProbeValue,
  probeEventPaths,
  readProbeEvents,
  reduceProbeEvents,
} from './observer.mjs';

const TURN_METADATA_KEY = 'x-codex-turn-metadata';
const MAXIMUM_META_FIELD_ENTRIES = 32;

const TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: 'capture_context',
    description: 'Records the hashed per-call Codex invocation metadata as durable probe evidence.',
    inputSchema: Object.freeze({ type: 'object', properties: Object.freeze({}), additionalProperties: false }),
  }),
  Object.freeze({
    name: 'hold_until_cancelled',
    description: 'Holds the call open until the host aborts it; records the durable settlement.',
    inputSchema: Object.freeze({ type: 'object', properties: Object.freeze({}), additionalProperties: false }),
  }),
  Object.freeze({
    name: 'read_assertions',
    description: 'Returns an in-memory preview of the reduced probe assertions; never writes result.json.',
    inputSchema: Object.freeze({ type: 'object', properties: Object.freeze({}), additionalProperties: false }),
  }),
]);

/** @param {string} code @param {string} message */
function probeError(code, message) {
  const error = /** @type {Error & {code:string}} */ (new Error(message));
  error.code = code;
  return error;
}

/**
 * Builds the [name, JSON type name] schema fingerprint of a metadata object,
 * bounded and sorted so no values are ever retained.
 * @param {Record<string, unknown>|undefined} value
 */
function metadataFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.entries(value)
    .slice(0, MAXIMUM_META_FIELD_ENTRIES)
    .map(([name, entry]) => [name, Array.isArray(entry) ? 'array' : entry === null ? 'null' : typeof entry])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Extracts the trusted per-call identity from the observed host metadata.
 * Only the host-supplied turn-metadata thread/turn fields are read; the
 * qualified Host exposes no per-call workspace, so none is extracted, and
 * any unrelated fields only feed the bounded schema fingerprint.
 * @param {any} meta
 */
function extractObservedIdentity(meta) {
  const envelope = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : null;
  const turnMetadata = envelope && envelope[TURN_METADATA_KEY];
  const turn = turnMetadata && typeof turnMetadata === 'object' && !Array.isArray(turnMetadata) ? turnMetadata : null;
  const threadId = turn && typeof turn.thread_id === 'string' && turn.thread_id.length > 0 ? turn.thread_id : null;
  const turnId = turn && typeof turn.turn_id === 'string' && turn.turn_id.length > 0 ? turn.turn_id : null;
  return { envelope, turn, threadId, turnId };
}

/**
 * @param {{runDirectory:string, runNonce:string, eventsPath?:string, lockPath?:string}} observer
 * @param {(options: {runDirectory:string, runNonce:string, event:object}) => Promise<void>} [appendImpl]
 *   Injectable durable append for tests; defaults to the real module append.
 */
export function createProbeServer({ observer, appendImpl = appendProbeEvent }) {
  if (!observer || typeof observer.runDirectory !== 'string' || !isAbsolute(observer.runDirectory)) {
    throw probeError('PROBE_OBSERVER_INVALID', 'The probe observer requires an absolute run directory.');
  }
  const runNonce = observer.runNonce;
  if (!/^[0-9a-f]{64}$/.test(runNonce)) throw probeError('PROBE_NONCE_INVALID', 'The probe run nonce must be 64 lowercase hexadecimal characters.');

  const server = new Server({ name: 'zcode-mcp-context-probe', version: '0.1.0' }, { capabilities: { tools: {} } });

  /**
   * Pending held calls. Entries carry their own finish() so either the SDK
   * abort signal or a detected transport disconnect can settle them exactly
   * once, with the settlement written by the handler before returning.
   * @type {Set<{callNonce:string, finish:(settlement:string)=>void}>}
   */
  const pendingHolds = new Set();

  /**
   * Settles every pending held call durably as a transport close. The MCP
   * SDK's stdio server transport listens only for stdin 'data'/'error', so
   * an abrupt client death never fires transport onclose and never aborts
   * in-flight handlers; the executable wires its own stdin EOF watchers to
   * this seam so settlements land before the process exits.
   */
  const settlePendingHoldsOnDisconnect = () => {
    for (const entry of [...pendingHolds]) entry.finish('transport-close');
  };
  server.probeDisconnect = { settlePendingHoldsOnDisconnect };

  const noArguments = (request) => !request.params || typeof request.params !== 'object'
    || !request.params.arguments || typeof request.params.arguments !== 'object'
    || Array.isArray(request.params.arguments)
    || Object.keys(request.params.arguments).length === 0;

  const errorResult = (message) => ({
    content: [{ type: 'text', text: message }],
    isError: true,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS.map((tool) => ({ ...tool })) }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (typeof request.params?.name !== 'string' || !TOOL_DEFINITIONS.some((tool) => tool.name === request.params.name)) {
      return errorResult('Unknown probe tool.');
    }
    if (!noArguments(request)) return errorResult('Probe tools accept no arguments.');
    try {
      if (request.params.name === 'capture_context') return await captureContext(request);
      if (request.params.name === 'hold_until_cancelled') return await holdUntilCancelled(extra);
      return await readAssertions();
    } catch (error) {
      return errorResult(`Probe tool failed: ${error && typeof error === 'object' && 'code' in error ? /** @type {any} */ (error).code : 'error'}`);
    }
  });

  async function captureContext(request) {
    const meta = request.params._meta;
    const { envelope, turn, threadId, turnId } = extractObservedIdentity(meta);
    const callNonce = randomBytes(16).toString('hex');
    const event = {
      kind: 'capture-started',
      callNonce,
      identityComplete: Boolean(threadId && turnId),
      threadHash: threadId ? hashProbeValue(runNonce, threadId) : null,
      turnHash: turnId ? hashProbeValue(runNonce, turnId) : null,
      // The event schema keeps its exact key set; the qualified Host exposes
      // no per-call workspace, so this hash is always null.
      workspaceHash: null,
      metaHash: turn ? hashProbeValue(runNonce, canonicalJson(turn)) : null,
      metaFields: metadataFields(turn),
      envelopeFields: metadataFields(envelope),
    };
    await appendImpl({ runDirectory: observer.runDirectory, runNonce, event });
    await appendImpl({
      runDirectory: observer.runDirectory,
      runNonce,
      event: { kind: 'capture-settled', callNonce },
    });
    return { content: [{ type: 'text', text: 'captured' }], structuredContent: { identityComplete: event.identityComplete } };
  }

  async function holdUntilCancelled(extra) {
    const callNonce = randomBytes(16).toString('hex');
    /** @type {(value:string) => void} */
    let resolveSettlement = () => {};
    /** @type {{callNonce:string, finish:(value:string)=>void}} */
    const entry = {
      callNonce,
      finish: (value) => {
        if (!pendingHolds.has(entry)) return;
        pendingHolds.delete(entry);
        resolveSettlement(value);
      },
    };
    // Registration is atomic with the durable start: the entry joins the
    // registry synchronously BEFORE the hold-started append is awaited. The
    // SDK stdio transport never aborts in-flight handlers on disconnect, so
    // the stdin watcher is the only settlement path — and it may observe the
    // durable hold-started and fire while the start append is still in
    // flight. Registering only after the append would leave the hold
    // stranded here until the forced exit with no settlement.
    const settlementPromise = new Promise((resolve) => { resolveSettlement = resolve; });
    pendingHolds.add(entry);
    if (extra.signal?.aborted) entry.finish('signal-abort');
    else extra.signal?.addEventListener('abort', () => entry.finish('signal-abort'), { once: true });
    try {
      await appendImpl({
        runDirectory: observer.runDirectory,
        runNonce,
        event: { kind: 'hold-started', callNonce },
      });
    } catch (error) {
      // The hold-started event never became durable: drop the registration
      // before propagating so the entry can never be settled or counted.
      pendingHolds.delete(entry);
      throw error;
    }
    // Resolves immediately when the disconnect watcher finished the hold
    // while the start append was in flight; the settlement below is still
    // appended after the start, keeping the log order start→settled.
    const settlement = await settlementPromise;
    await appendImpl({
      runDirectory: observer.runDirectory,
      runNonce,
      event: { kind: 'hold-settled', callNonce, settlement },
    });
    return { content: [{ type: 'text', text: 'held' }] };
  }

  async function readAssertions() {
    const records = await readProbeEvents({ runDirectory: observer.runDirectory, runNonce });
    const preview = reduceProbeEvents(records, { runNonce });
    return { content: [{ type: 'text', text: 'assertions' }], structuredContent: preview };
  }

  return server;
}

/**
 * Reads the three probe environment variables into an observer description.
 * @returns {{runDirectory:string, runNonce:string, eventsPath:string, lockPath:string}}
 */
export function probeObserverFromEnv() {
  const eventsPath = process.env.ZCODE_MCP_PROBE_EVENTS;
  const lockPath = process.env.ZCODE_MCP_PROBE_LOCK;
  const runNonce = process.env.ZCODE_MCP_PROBE_NONCE;
  if (!eventsPath || !lockPath || !runNonce) {
    throw probeError('PROBE_ENV_MISSING', 'ZCODE_MCP_PROBE_EVENTS, ZCODE_MCP_PROBE_LOCK, and ZCODE_MCP_PROBE_NONCE are required.');
  }
  if (!isAbsolute(eventsPath) || !eventsPath.endsWith('events.jsonl')) {
    throw probeError('PROBE_ENV_INVALID', 'ZCODE_MCP_PROBE_EVENTS must be the canonical absolute events.jsonl path.');
  }
  if (!isAbsolute(lockPath) || !lockPath.endsWith('events.lock')) {
    throw probeError('PROBE_ENV_INVALID', 'ZCODE_MCP_PROBE_LOCK must be the canonical absolute events.lock path.');
  }
  if (!/^[0-9a-f]{64}$/.test(runNonce)) {
    throw probeError('PROBE_NONCE_INVALID', 'ZCODE_MCP_PROBE_NONCE must be 64 lowercase hexadecimal characters.');
  }
  const runDirectory = join(eventsPath, '..');
  if (probeEventPaths(runDirectory).lockPath !== lockPath) {
    throw probeError('PROBE_ENV_INVALID', 'ZCODE_MCP_PROBE_LOCK must live beside ZCODE_MCP_PROBE_EVENTS.');
  }
  return { runDirectory, runNonce, eventsPath, lockPath };
}

/** Prints a bounded, redacted startup line for the driver transcript. */
function reportStartup(observer) {
  const line = JSON.stringify({
    probe: 'zcode-mcp-context-probe',
    serverPid: process.pid,
    runNonce: '[redacted-nonce]',
    eventsPath: observer.eventsPath,
    lockPath: observer.lockPath,
  });
  process.stderr.write(`${line}\n`);
}

/**
 * Bounded grace before the disposable server force-exits after transport
 * close. It must exceed the observer's advisory-lock acquisition budget
 * (5 s) plus an fsync margin so an in-flight abort/disconnect settlement is
 * never truncated mid-append.
 */
export const SERVER_EXIT_GRACE_MS = 6_000;

/**
 * Installs the transport-close disposal handler: one bounded, unref'ed timer
 * long enough for pending settlement writes to acquire the event lock and
 * fsync, while guaranteeing the process cannot hang forever.
 * @param {{onclose: (() => void) | null}} server
 * @param {{scheduleTimeout?: (fn: () => void, ms: number) => {unref?: () => void}, exitImpl?: (code: number) => void}} [options]
 */
export function scheduleDisposalExit(server, options = {}) {
  const scheduleTimeout = options.scheduleTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const exitImpl = options.exitImpl ?? ((code) => process.exit(code));
  server.onclose = () => {
    const timer = scheduleTimeout(() => exitImpl(0), SERVER_EXIT_GRACE_MS);
    // Unref'ed: if every append drains earlier, the process exits naturally;
    // if a settlement write is still pending, the grace timer fires.
    timer?.unref?.();
  };
  return server;
}

/**
 * Bounded grace between a detected stdin disconnect and the forced exit. It
 * is sized exactly like SERVER_EXIT_GRACE_MS: a disconnect settlement whose
 * durable append waits on a contended advisory lock needs the observer's
 * full 5 s lock-acquisition budget plus an fsync margin, so the settlement
 * is never lost to process.exit.
 */
export const DISCONNECT_EXIT_GRACE_MS = SERVER_EXIT_GRACE_MS;

/**
 * Watches the process's own stdin for end/close and invokes onDisconnect
 * exactly once. The MCP SDK's stdio server transport listens only for
 * 'data'/'error', so an abrupt client death (Host SIGKILL, crashed Host)
 * never fires transport onclose and never aborts in-flight handlers; this
 * watcher is the only way a stdio probe server can observe the disconnect.
 * Returns a disposer.
 * @param {{onDisconnect: () => void}} options
 */
export function installStdinDisconnectWatcher({ onDisconnect }) {
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    onDisconnect();
  };
  process.stdin.on('end', fire);
  process.stdin.on('close', fire);
  return () => {
    process.stdin.off('end', fire);
    process.stdin.off('close', fire);
  };
}

async function runAsExecutable() {
  const observer = probeObserverFromEnv();
  reportStartup(observer);
  await appendProbeEvent({
    runDirectory: observer.runDirectory,
    runNonce: observer.runNonce,
    event: {
      kind: 'server-started',
      serverPid: process.pid,
      eventsPath: observer.eventsPath,
      lockPath: observer.lockPath,
    },
  });
  const server = createProbeServer({ observer });
  // The server is disposable: after transport close, in-flight settlement
  // appends get the full lock budget plus fsync margin to land, then the
  // process must exit instead of lingering.
  scheduleDisposalExit(server);
  // The SDK never fires transport onclose on an abrupt client death (stdio
  // watches only 'data'/'error'), so the executable detects the disconnect
  // itself, settles every pending held call durably, and force-exits within
  // a bounded grace instead of lingering behind a dead stdin pipe.
  installStdinDisconnectWatcher({
    onDisconnect: () => {
      server.probeDisconnect.settlePendingHoldsOnDisconnect();
      const timer = setTimeout(() => process.exit(0), DISCONNECT_EXIT_GRACE_MS);
      timer?.unref?.();
    },
  });
  await server.connect(new StdioServerTransport());
}

/** @param {string} left @param {string} right */
function sameEntryPath(left, right) {
  return left === right || `${left}${sep}` === right;
}

if (process.argv[1] && sameEntryPath(fileURLToPath(import.meta.url), resolve(process.argv[1]))) {
  await runAsExecutable();
}
