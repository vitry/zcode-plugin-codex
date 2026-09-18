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
 * Workspace is accepted only from an observed per-call turn-metadata field
 * (`workspace` string, or a single-entry `workspaces` array normalized to
 * its path so the value matches the driver's authoritative path); any other
 * shape is recorded as null and marks the capture incomplete.
 * @param {any} meta
 */
function extractObservedIdentity(meta) {
  const envelope = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : null;
  const turnMetadata = envelope && envelope[TURN_METADATA_KEY];
  const turn = turnMetadata && typeof turnMetadata === 'object' && !Array.isArray(turnMetadata) ? turnMetadata : null;
  const threadId = turn && typeof turn.thread_id === 'string' && turn.thread_id.length > 0 ? turn.thread_id : null;
  const turnId = turn && typeof turn.turn_id === 'string' && turn.turn_id.length > 0 ? turn.turn_id : null;
  let workspace = null;
  if (turn && typeof turn.workspace === 'string' && turn.workspace.length > 0) workspace = turn.workspace;
  else if (turn && Array.isArray(turn.workspaces) && turn.workspaces.length === 1
    && typeof turn.workspaces[0] === 'string' && turn.workspaces[0].length > 0) workspace = turn.workspaces[0];
  return { envelope, turn, threadId, turnId, workspace };
}

/**
 * @param {{runDirectory:string, runNonce:string, eventsPath?:string, lockPath?:string}} observer
 */
export function createProbeServer({ observer }) {
  if (!observer || typeof observer.runDirectory !== 'string' || !isAbsolute(observer.runDirectory)) {
    throw probeError('PROBE_OBSERVER_INVALID', 'The probe observer requires an absolute run directory.');
  }
  const runNonce = observer.runNonce;
  if (!/^[0-9a-f]{64}$/.test(runNonce)) throw probeError('PROBE_NONCE_INVALID', 'The probe run nonce must be 64 lowercase hexadecimal characters.');

  const server = new Server({ name: 'zcode-mcp-context-probe', version: '0.1.0' }, { capabilities: { tools: {} } });

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
    const { envelope, turn, threadId, turnId, workspace } = extractObservedIdentity(meta);
    const callNonce = randomBytes(16).toString('hex');
    const event = {
      kind: 'capture-started',
      callNonce,
      identityComplete: Boolean(threadId && turnId && workspace && turn),
      threadHash: threadId ? hashProbeValue(runNonce, threadId) : null,
      turnHash: turnId ? hashProbeValue(runNonce, turnId) : null,
      workspaceHash: workspace ? hashProbeValue(runNonce, workspace) : null,
      metaHash: turn ? hashProbeValue(runNonce, canonicalJson(turn)) : null,
      metaFields: metadataFields(turn),
      envelopeFields: metadataFields(envelope),
    };
    await appendProbeEvent({ runDirectory: observer.runDirectory, runNonce, event });
    await appendProbeEvent({
      runDirectory: observer.runDirectory,
      runNonce,
      event: { kind: 'capture-settled', callNonce },
    });
    return { content: [{ type: 'text', text: 'captured' }], structuredContent: { identityComplete: event.identityComplete } };
  }

  async function holdUntilCancelled(extra) {
    const callNonce = randomBytes(16).toString('hex');
    await appendProbeEvent({
      runDirectory: observer.runDirectory,
      runNonce,
      event: { kind: 'hold-started', callNonce },
    });
    await new Promise((resolve) => {
      if (extra.signal?.aborted) resolve(undefined);
      else extra.signal?.addEventListener('abort', () => resolve(undefined), { once: true });
    });
    await appendProbeEvent({
      runDirectory: observer.runDirectory,
      runNonce,
      event: { kind: 'hold-settled', callNonce, settlement: 'signal-abort' },
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
  await server.connect(new StdioServerTransport());
}

/** @param {string} left @param {string} right */
function sameEntryPath(left, right) {
  return left === right || `${left}${sep}` === right;
}

if (process.argv[1] && sameEntryPath(fileURLToPath(import.meta.url), resolve(process.argv[1]))) {
  await runAsExecutable();
}
