// @ts-nocheck
/**
 * Disposable stdio MCP probe server for the direct `mcpServer/tool/call`
 * feasibility probe. It exposes exactly two tools, `capture_direct` and
 * `hold_direct`. Each handler's FIRST awaited action is a durable append of
 * `handler-entered` with a fresh call nonce and the driver-supplied
 * diagnostic `probeLabel`; only afterward is the host-supplied `extra?._meta`
 * inspected, reduced to bounded name/type pairs and per-run salted hash
 * candidates, and recorded as `metadata-observed` (state reports
 * missing/malformed/complete). The label is probe-only correlation input and
 * never participates in any authority check. Results are fixed; raw metadata
 * values never enter the evidence.
 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { constants as fsConstants, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { hashProbeValue } from '../mcp-context-probe/observer.mjs';
import { appendDirectProbeLogRecord, hasCommittedDirectProbeEvent, readEvidenceFileSync, syncRunDirectory, verifyDirectProbeSealChain } from './probe-log.mjs';

/**
 * PROCESS-WIDE HANDLER COMMIT STATE, keyed by run nonce: the highest commit
 * {recordCount, eventsDigest} this process's server instances have observed
 * for the run. A new instance inherits it (never the current head), so a
 * rolled back or diverged log+journal pair cannot be laundered by
 * re-instantiating the server; it advances monotonically as instances append.
 */
const runHandlerCommitStates = new Map();
import {
  DIRECT_HANDLER_EVENT_KINDS,
  DIRECT_PROBE_LABEL_PATTERN,
  DIRECT_PROBE_PHASES,
} from './observer.mjs';

const MAXIMUM_META_FIELD_ENTRIES = 32;
const RUN_NONCE_PATTERN = /^[0-9a-f]{64}$/;

/** The allowlisted metadata candidate paths hashed per call (never stored raw). */
const DIRECT_CANDIDATE_PATHS = Object.freeze({
  envelopeThreadId: Object.freeze(['threadId']),
  innerSessionId: Object.freeze(['x-codex-turn-metadata', 'session_id']),
  innerThreadId: Object.freeze(['x-codex-turn-metadata', 'thread_id']),
  innerTurnId: Object.freeze(['x-codex-turn-metadata', 'turn_id']),
});

const TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: 'capture_direct',
    description: 'Records durable handler entry before inspecting host metadata, then returns a fixed result.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ probeLabel: Object.freeze({ type: 'string' }) }),
      required: Object.freeze(['probeLabel']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'hold_direct',
    description: 'Records durable handler entry, starts a probe-owned synthetic worker, holds until settlement, and records the exact settlement.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        probeLabel: Object.freeze({ type: 'string' }),
        // The probe-owned synthetic worker's completion duration: the worker
        // emulates a command that finishes on its own. Optional; when absent
        // the hold runs until a trigger or the injected safety ceiling.
        holdMs: Object.freeze({ type: 'integer', minimum: 1, maximum: 120000 }),
      }),
      required: Object.freeze(['probeLabel']),
      additionalProperties: false,
    }),
  }),
]);

/** Upper bound for one synthetic worker's completion duration. */
const MAXIMUM_HOLD_MS = 120_000;

/** @param {string} code @param {string} message */
function directError(code, message) {
  // The code is embedded in the message (the entry-inventory convention) so
  // closed-code assertions can match failures textually as well as via .code.
  const error = /** @type {Error & {code:string}} */ (new Error(`${code}: ${message}`));
  error.code = code;
  return error;
}

/**
 * The transient handler-owner registration file, inside the private run
 * directory. The filename is the fixed contract between this module's
 * module-private writer and probe-log.mjs's reader.
 */
const HANDLER_OWNER_FILENAME = 'handler-owner.json';
const HANDLER_OWNER_PID_BOUND = 2 ** 31;

/** @param {number} pid @returns {boolean} true when the pid is currently alive */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {any} */ (error).code === 'EPERM';
  }
}

/**
 * MODULE-PRIVATE writer for the transient handler-owner registration — the
 * only code in the probe that can claim handler ownership, reachable solely
 * as a side effect of genuinely starting a server (the factory below, and
 * therefore the env executable before its transport starts). It writes the
 * DIGEST of the run capability secret (never the secret itself) in the same
 * {version, runNonce, pid, secretDigest} shape probe-log.mjs's reader and
 * verifier expect, with mode 0600 and O_EXCL|O_NOFOLLOW: first registration
 * wins, the same process re-registers idempotently with the same digest, and
 * a different process or a different capability fails loudly with
 * PROBE_OWNER_CONFLICT instead of silently taking over.
 *
 * DEAD-OWNER ADOPTION: a respawned instance holding the SAME run capability
 * (same runNonce and secret digest) adopts the registration when the
 * registered owner pid is no longer alive — the host disconnects its startup
 * client and later respawns the server per call, and a stale first-wins
 * registration would otherwise crash every respawn during its initialize
 * handshake. The file is left untouched (it still names the run capability,
 * not a live claim), the run capability secret remains the write authority,
 * and a LIVE owner is never adopted over. ACCEPTED INVARIANT, stated and
 * recorded: in the real campaign the server is a spawned separate
 * process holding the spawn-time secret in memory, so driver-process code
 * physically cannot write handler evidence; file-based provenance is
 * tamper-evident (non-reducible under the driver expected secret) rather
 * than tamper-proof — a driver process that itself fabricates evidence is
 * out of scope (its artifacts are the evidence) — an instrument limitation,
 * recorded, not hidden.
 * @param {{runDirectory: string, runNonce: string, pid: number, secretDigest: string}} input
 * @returns {string} the registration path
 */
function writeHandlerOwnerRegistration({ runDirectory, runNonce, pid, secretDigest }) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > HANDLER_OWNER_PID_BOUND) {
    throw directError('PROBE_EVENT_INVALID', 'The handler-owner pid must be a positive integer.');
  }
  if (typeof secretDigest !== 'string' || !/^[0-9a-f]{64}$/.test(secretDigest)) {
    throw directError('PROBE_EVENT_INVALID', 'The handler-owner registration requires the capability secret digest.');
  }
  const ownerPath = join(runDirectory, HANDLER_OWNER_FILENAME);
  const payload = `${JSON.stringify({ version: 1, runNonce, pid, secretDigest })}\n`;
  try {
    writeFileSync(ownerPath, payload, {
      flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let existing;
    try { existing = JSON.parse(readEvidenceFileSync(ownerPath, 'utf8')); } catch (error) {
      if (error && typeof error === 'object' && /** @type {any} */ (error).code === 'PROBE_LOG_SYMLINK') throw error;
      throw directError('PROBE_OWNER_CONFLICT', 'The handler-owner registration exists but cannot be read.');
    }
    const sameCapability = existing && typeof existing === 'object'
      && existing.runNonce === runNonce && existing.secretDigest === secretDigest;
    if (!sameCapability) {
      throw directError('PROBE_OWNER_CONFLICT', 'Another process or capability is already registered as this run handler owner.');
    }
    const sameProcess = existing.pid === pid;
    const deadOwner = !sameProcess
      && Number.isSafeInteger(existing.pid) && existing.pid > 0
      && !isProcessAlive(existing.pid);
    if (!sameProcess && !deadOwner) {
      throw directError('PROBE_OWNER_CONFLICT', 'A live handler owner is already registered for this run capability.');
    }
    // Same capability and (dead-or-same) owner: adopt idempotently. The
    // registration keeps naming the run's first owner; the capability secret
    // held by THIS instance is the write authority.
  }
  return ownerPath;
}

/** @param {unknown} value */
function emptyCandidateHashes() {
  return { envelopeThreadId: null, innerSessionId: null, innerThreadId: null, innerTurnId: null };
}

/**
 * Inspects the host-supplied per-call metadata and reduces it to bounded,
 * value-free evidence: `[name, type]` pairs and per-run salted hash
 * candidates. `missing` records an absent `_meta`; `malformed` records
 * metadata with no usable allowlisted candidate; `complete` records at
 * least one usable candidate. Raw values are hashed immediately and never
 * retained.
 * @param {string} runNonce
 * @param {unknown} meta
 */
export function inspectDirectMetadata(runNonce, meta) {
  const envelope = meta !== undefined && meta !== null && typeof meta === 'object' && !Array.isArray(meta) ? meta : null;
  if (!envelope) {
    return { state: meta === undefined ? 'missing' : 'malformed', fields: [], fieldsTruncated: false, candidateHashes: emptyCandidateHashes() };
  }
  const entries = /** @type {Record<string, unknown>} */ (envelope);
  // Closed JSON type names only; anything non-JSON collapses to 'unknown'.
  const jsonType = (value) => {
    if (Array.isArray(value)) return 'array';
    if (value === null) return 'null';
    return ['string', 'number', 'boolean', 'object'].includes(typeof value) ? typeof value : 'unknown';
  };
  const turn = entries['x-codex-turn-metadata'] !== null && typeof entries['x-codex-turn-metadata'] === 'object' && !Array.isArray(entries['x-codex-turn-metadata'])
    ? /** @type {Record<string, unknown>} */ (entries['x-codex-turn-metadata'])
    : null;
  // The fingerprint records ONLY allowlisted field paths; every unknown
  // top-level name collapses to the closed '[redacted]' token, so a metadata
  // key containing a path, credential, or raw identifier can never reach the
  // evidence. Unknown nested names are not recorded at all.
  const redacted = [];
  for (const [name, value] of Object.entries(entries)) {
    if (name === 'threadId' || name === 'x-codex-turn-metadata') continue;
    redacted.push(['[redacted]', jsonType(value)]);
  }
  // Observed allowlisted identity-candidate paths are reserved FIRST: they
  // are the required presence/type observations and are never dropped.
  // Redacted pairs fill the remaining capacity, and fieldsTruncated records
  // exactly when redacted pairs had to be dropped.
  const allowlisted = [];
  if ('threadId' in entries) allowlisted.push(['threadId', jsonType(entries.threadId)]);
  if ('x-codex-turn-metadata' in entries) allowlisted.push(['x-codex-turn-metadata', jsonType(entries['x-codex-turn-metadata'])]);
  if (turn) {
    for (const leaf of ['session_id', 'thread_id', 'turn_id']) {
      if (leaf in turn) allowlisted.push([`x-codex-turn-metadata.${leaf}`, jsonType(turn[leaf])]);
    }
  }
  const redactedCapacity = Math.max(0, MAXIMUM_META_FIELD_ENTRIES - allowlisted.length);
  const fieldsTruncated = redacted.length > redactedCapacity;
  const fields = [...allowlisted, ...redacted.slice(0, redactedCapacity)]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const candidateHashes = emptyCandidateHashes();
  let usable = false;
  for (const [candidate, path] of Object.entries(DIRECT_CANDIDATE_PATHS)) {
    let cursor = entries;
    for (const segment of path) {
      cursor = cursor && typeof cursor === 'object' && !Array.isArray(cursor) ? cursor[segment] : undefined;
    }
    if (typeof cursor === 'string' && cursor.length > 0) {
      candidateHashes[candidate] = hashProbeValue(runNonce, cursor);
      usable = true;
    }
  }
  return { state: usable ? 'complete' : 'malformed', fields, fieldsTruncated, candidateHashes };
}

/**
 * Builds the disposable direct probe server. The observer carries the run
 * directory, run nonce, and the current bounded phase (the durable join
 * requires the server and driver to record the same phase), plus optionally
 * the run capability secret (the executable reads it from spawn-time env).
 * `holdSafetyDeadlineMs` is the MECHANISM-ONLY injected safety ceiling: a
 * hold still undecided when it fires is force-settled with the
 * `safety-deadline` outcome — the same forced-settlement mechanism as the
 * production 100-hour ceiling, exercised at a test-scale duration. It is
 * never evidence that a tested host supports a 100-hour tool call.
 * @param {{observer: {runDirectory: string, runNonce: string, phase: string, ownerSecret?: string}, ownerSecret?: string, holdSafetyDeadlineMs?: number, appendImpl?: (options: {runDirectory: string, runNonce: string, phase: string, event: object}) => Promise<unknown>}} options
 */
export function createDirectProbeServer({ observer, ownerSecret, holdSafetyDeadlineMs, appendImpl }) {
  if (!observer || typeof observer.runDirectory !== 'string' || !isAbsolute(observer.runDirectory)) {
    throw directError('DIRECT_PROBE_OBSERVER_INVALID', 'The direct probe server requires an absolute run directory.');
  }
  if (!RUN_NONCE_PATTERN.test(observer.runNonce)) {
    throw directError('PROBE_NONCE_INVALID', 'The probe run nonce must be 64 lowercase hexadecimal characters.');
  }
  if (typeof observer.phase !== 'string' || !DIRECT_PROBE_PHASES.includes(observer.phase)) {
    throw directError('DIRECT_PROBE_OBSERVER_INVALID', 'The direct probe server requires a closed probe phase.');
  }
  if (holdSafetyDeadlineMs !== undefined
    && (!Number.isSafeInteger(holdSafetyDeadlineMs) || holdSafetyDeadlineMs <= 0 || holdSafetyDeadlineMs > MAXIMUM_HOLD_MS)) {
    throw directError('DIRECT_PROBE_OBSERVER_INVALID', `The injected hold safety deadline must be a positive integer of at most ${MAXIMUM_HOLD_MS} milliseconds.`);
  }
  const { runDirectory, runNonce, phase } = observer;

  // The run capability secret: a per-run random 256-bit value the driver
  // generates and passes to the spawned server through spawn-time env (or
  // supplies when instantiating in-process). The server holds it in memory
  // only — it never writes the secret itself to any file, only its salted
  // digest in the owner registration.
  const capabilitySecret = ownerSecret ?? observer.ownerSecret ?? randomBytes(32).toString('hex');
  if (!RUN_NONCE_PATTERN.test(capabilitySecret)) {
    throw directError('DIRECT_PROBE_OBSERVER_INVALID', 'The run capability secret must be 64 lowercase hexadecimal characters.');
  }

  // PROCESS-IDENTITY BOUNDARY: genuinely starting a server registers THIS
  // process as the run's handler owner through the module-private writer —
  // a transient, runNonce-bound, mode-0600 file inside the private run
  // directory, removed together with the run, carrying only the DIGEST of
  // the capability secret. The shared log primitive accepts handler-side
  // kinds only from this registered pid presenting the capability secret,
  // so driver-process imports of any module physically cannot append handler
  // evidence. A second, different process or capability claiming the handler
  // side fails loudly instead of silently taking over.
  const ownerPath = writeHandlerOwnerRegistration({
    runDirectory,
    runNonce,
    pid: process.pid,
    secretDigest: hashProbeValue(runNonce, capabilitySecret),
  });

  // OWNER DURABILITY BOUNDARY: before THIS instance can append anything at
  // all — the executable's `server-started`, a tool call's `handler-entered`,
  // or any later record — the owner registration is fsynced: first the file
  // bytes, then (through syncRunDirectory) its directory entry. A power loss
  // can therefore never leave a missing or partial registration behind
  // committed handler evidence: reduction would reject that otherwise
  // durable evidence with PROBE_OWNER_INVALID. The gate re-arms if a crash
  // interrupts it, and is idempotent (repeat fsyncs are harmless).
  let ownerDurabilityComplete = false;
  const ensureOwnerDurability = async () => {
    if (ownerDurabilityComplete) return;
    const ownerHandle = await open(ownerPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try { await ownerHandle.sync(); } finally { await ownerHandle.close(); }
    // FAIL-CLOSED: the directory fsync must actually have completed. A
    // soft-failed sync (EPERM/EACCES/EINVAL/ENOTSUP) leaves the
    // registration's directory entry non-durable, so the gate refuses and
    // re-arms instead of committing handler evidence that a power loss
    // could orphan from its owner file.
    if (!await syncRunDirectory(runDirectory)) {
      throw directError('PROBE_OWNER_INVALID', 'The handler-owner registration could not be made durable: the run directory cannot be fsynced.');
    }
    ownerDurabilityComplete = true;
  };

  // PROCESS-WIDE HANDLER COMMIT, keyed by run nonce: the highest commit this
  // process's server instances have observed for the run. A new instance
  // inherits it (never the current head), so a rolled back or diverged
  // log+journal pair cannot be laundered by re-instantiating the server;
  // it advances monotonically as instances append.
  const processHeld = runHandlerCommitStates.get(runNonce) ?? null;
  // FACTORY ADOPTION: the journal chain must reach the process-held count
  // AND digest before the process-held state may advance to the current
  // head — a longer but divergent journal is refused (PROBE_STATE_DIVERGED),
  // and on ANY failure this factory throws before touching the map, so the
  // held state stays exactly what this process last held and no later
  // factory can inherit a divergent head. The instance's first append
  // re-verifies the same held commit under the advisory event lock.
  const sealHead = verifyDirectProbeSealChain({ runDirectory, runNonce, ownerSecret: capabilitySecret, heldCommit: processHeld });
  runHandlerCommitStates.set(runNonce, sealHead);

  // Per-instance HANDLER-scoped writer capability: minted by this factory,
  // held in this closure and on the instance — never a module export. It is
  // the only path that can append handler-side kinds (and it rejects driver
  // kinds), so driver-side code cannot fabricate durable handler evidence
  // without instantiating a server, which is the server's role.
  // WRITER-HELD COMMIT: the instance's held commit initializes from the
  // current journal head (its own first write / registration state) and
  // advances with every append, so each server write verifies that the
  // journal still chains from what this instance last committed.
  let heldCommit = processHeld ?? sealHead;
  const trackedAppend = async (event) => {
    await ensureOwnerDurability();
    return appendDirectProbeLogRecord({ runDirectory, runNonce, phase, event, ownerSecret: capabilitySecret, heldCommit })
      .then((result) => {
        heldCommit = result.commit;
        const prev = runHandlerCommitStates.get(runNonce);
        if (!prev || result.commit.recordCount > prev.recordCount) {
          runHandlerCommitStates.set(runNonce, result.commit);
        }
        return result;
      })
      .catch(async (error) => {
        // ROUND 54: an ambiguous failure can reject AFTER the commit line is
        // durable (the trailing intent unlinks / directory fsyncs). The
        // landed commit is still the process-held witness — adopt it so the
        // reconciliations can detect rollbacks of it.
        const ambiguousCommit = error && typeof error === 'object' ? error.commit : undefined;
        if (ambiguousCommit) {
          heldCommit = ambiguousCommit;
          const prev = runHandlerCommitStates.get(runNonce);
          if (!prev || ambiguousCommit.recordCount > prev.recordCount) {
            runHandlerCommitStates.set(runNonce, ambiguousCommit);
          }
        }
        throw error;
      });
  };
  const appendHandlerEvent = (event) => {
    if (!event || typeof event !== 'object' || Array.isArray(event) || !DIRECT_HANDLER_EVENT_KINDS.includes(event.kind)) {
      throw directError('PROBE_EVENT_FORBIDDEN', 'The server writer appends handler-side kinds only; driver-side events belong to the driver appender.');
    }
    return trackedAppend(event);
  };

  // Probe-owned server instance identity: a per-process secret hashed under
  // the run nonce. It joins server-started and handler-entered without ever
  // persisting a raw PID or path.
  const serverInstanceHash = hashProbeValue(runNonce, `direct-probe-server-instance:${randomBytes(16).toString('hex')}`);

  const server = new Server({ name: 'zcode-direct-mcp-probe', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.probeDirectOwnerSecret = capabilitySecret;
  server.probeDirectAppend = appendHandlerEvent;

  // The injectable append seam defaults to this instance's own handler
  // writer; the run configuration comes from the closure, never the caller.
  const append = appendImpl ?? (({ event }) => trackedAppend(event));

  /** Labels already consumed by this server instance; one label enters once. */
  const usedLabels = new Set();

  /**
   * ROUND 44: bounded retry budget for the settlement reconciliation task
   * that holdDirect keeps active for every decided, registered hold — the
   * same deadline discipline as the disconnect pass, and equal to the
   * disposable server's bounded exit grace.
   * @type {number}
   */
  const SETTLEMENT_RETRY_BUDGET_MS = 6_000;

  /**
   * Pending held calls. Entries register BEFORE the durable hold-started
   * append so a disconnect observed mid-append can still settle them exactly
   * once (the same lesson as the original probe server). ROUND 43: the
   * registration is decoupled from the in-memory entry lifetime — it is
   * removed ONLY by the settlement reconciliation, after both terminal
   * records are confirmed committed by durable reads, so every failure path
   * leaves a registered hold with a live settlement path.
   * @type {Set<{callNonce: string, workerHash: string, outcome: string|null, lock: Promise<void>, finish: (outcome: string) => void}>}
   */
  const pendingHolds = new Set();

  /**
   * ROUND 53/54: the process-held commit for the run — {recordCount,
   * eventsDigest} once this process has ever OBSERVED a commit, null for a
   * fresh run. It is the process-held witness for the settlement and label
   * reconciliations: a missing or empty journal after this is UNKNOWN, and
   * the verified chain must REACH the held commit.
   */
  const processHeldCommitForRun = () => runHandlerCommitStates.get(runNonce) ?? null;

  /**
   * ROUND 43: reads the durable committed state of one record kind for a
   * hold: 'committed', 'absent', or 'unknown' (the read itself failed —
   * never treated as proof of commitment or of absence).
   * @param {string} callNonce
   * @param {string} kind
   * @returns {Promise<'committed'|'absent'|'unknown'>}
   */
  const readHoldRecordState = async (callNonce, kind) => {
    try {
      return (await hasCommittedDirectProbeEvent({
        runDirectory,
        runNonce,
        ownerSecret: capabilitySecret,
        kind,
        callNonce,
        heldCommit: processHeldCommitForRun(),
      })) ? 'committed' : 'absent';
    } catch { return 'unknown'; }
  };

  /**
   * ROUND 43: THE settlement task for ONE registered hold, driven entirely
   * by durable reads. (1) The hold-started must be durably committed before
   * any terminal record is attempted — unknown keeps the registration for a
   * later pass, absent proves the hold never began and drops the
   * registration cleanly. (2) Each terminal record in order: check the
   * durable committed state, append only when absent, and after ANY append
   * outcome re-reconcile through the durable read — an ambiguous failure
   * where the record actually committed is commitment evidence, never a
   * swallowed error. (3) The registration is removed only when BOTH terminal
   * records are confirmed committed by durable reads. Serialized per entry
   * so concurrent passes can never duplicate a terminal record.
   * @param {{callNonce: string, workerHash: string, outcome: string|null, lock: Promise<void>}} entry
   * @returns {Promise<boolean>} true when the hold is fully settled and deregistered
   */
  const reconcileHoldSettlement = (entry) => {
    const run = async () => {
      if (entry.outcome === null) return false;
      const started = await readHoldRecordState(entry.callNonce, 'hold-started');
      if (started === 'unknown') return false;
      if (started === 'absent') {
        // The hold-started never committed: there is nothing to settle and
        // the registration drops cleanly.
        pendingHolds.delete(entry);
        return true;
      }
      const terminals = [
        { kind: 'handler-settled', event: { kind: 'handler-settled', callNonce: entry.callNonce, outcome: entry.outcome } },
        { kind: 'worker-settled', event: { kind: 'worker-settled', callNonce: entry.callNonce, workerHash: entry.workerHash, outcome: entry.outcome } },
      ];
      for (const terminal of terminals) {
        let state = await readHoldRecordState(entry.callNonce, terminal.kind);
        if (state === 'absent') {
          try {
            await append({ event: terminal.event });
          } catch { /* ambiguous: only the durable read adjudicates */ }
          state = await readHoldRecordState(entry.callNonce, terminal.kind);
        }
        if (state !== 'committed') return false;
      }
      pendingHolds.delete(entry);
      return true;
    };
    const next = entry.lock.then(run, run);
    entry.lock = next.then(() => undefined, () => undefined);
    return next;
  };

  /**
   * ROUND 43: the settlement reconciliation over every registered hold —
   * the single settlement task shared by the holdDirect failure path and the
   * disconnect seam. Runs one pass, retrying (bounded by `deadlineMs`) while
   * holds stay registered, so a transient failure inside the bounded exit
   * grace still converges.
   * @param {{deadlineMs?: number}} [options]
   * @returns {Promise<boolean>} true when no holds remain registered
   */
  const reconcileSettlements = async ({ deadlineMs = 0 } = {}) => {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      for (const entry of [...pendingHolds]) {
        await reconcileHoldSettlement(entry);
      }
      if (pendingHolds.size === 0) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  /**
   * Settles every pending held call durably as a connection close: decides
   * the terminal outcome for still-undecided holds and delegates to the
   * durable-read-driven reconciliation, bounded by the same grace the
   * disposable server allows before force-exit.
   */
  const settlePendingHoldsOnDisconnect = () => {
    for (const entry of [...pendingHolds]) {
      if (entry.outcome === null) entry.finish('connection-closed');
    }
    void reconcileSettlements({ deadlineMs: SETTLEMENT_RETRY_BUDGET_MS }).catch(() => {});
  };
  server.probeDirectDisconnect = { settlePendingHoldsOnDisconnect };
  server.probeDirectInstanceHash = serverInstanceHash;

  const errorResult = (message) => ({
    content: [{ type: 'text', text: message }],
    isError: true,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS.map((tool) => ({ ...tool })) }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (typeof request.params?.name !== 'string' || !TOOL_DEFINITIONS.some((tool) => tool.name === request.params.name)) {
      return errorResult('Unknown direct probe tool.');
    }
    const probeLabel = request.params.arguments?.probeLabel;
    // The label is a probe-only diagnostic argument; it correlates evidence
    // and never participates in any authority check.
    if (typeof probeLabel !== 'string' || !DIRECT_PROBE_LABEL_PATTERN.test(probeLabel)) {
      return errorResult('The direct probe requires a valid probeLabel argument.');
    }
    if (usedLabels.has(probeLabel)) return errorResult('The probe label was already used in this server run.');
    usedLabels.add(probeLabel);
    // The optional synthetic worker duration: absent, or a bounded positive
    // integer. Anything else fails closed before any durable work.
    const rawHoldMs = request.params.arguments?.holdMs;
    let holdMs;
    if (rawHoldMs !== undefined) {
      if (!Number.isSafeInteger(rawHoldMs) || rawHoldMs < 1 || rawHoldMs > MAXIMUM_HOLD_MS) {
        return errorResult(`The direct probe requires holdMs to be an integer of 1 to ${MAXIMUM_HOLD_MS} milliseconds.`);
      }
      holdMs = rawHoldMs;
    }
    let entryDurable = false;
    try {
      const result = request.params.name === 'capture_direct'
        ? await captureDirect(probeLabel, extra, () => { entryDurable = true; })
        : await holdDirect(probeLabel, extra, () => { entryDurable = true; }, holdMs);
      return result;
    } catch (error) {
      // Before entry the label is unused, so a retry may try again; after the
      // durable entry the label stays consumed forever. ROUND 50: the entry
      // can COMMIT before a trailing recovery/repair-intent unlink or
      // directory fsync fails — an ambiguous failure leaves the entry
      // durable without entryDurable having been set. Reconcile the
      // committed state BY LABEL before releasing: a committed entry retains
      // the label forever (a same-label retry fails closed as already used
      // at this server, or as a duplicate at append time on a fresh
      // instance — either way the reduction stays clean); the label is
      // released only when the entry is proven absent.
      if (!entryDurable) {
        // ROUND 51: the reconciliation is three-valued — committed, absent,
        // or UNKNOWN (the committed-state read itself failed). The label is
        // released ONLY when a successful read proves the entry absent;
        // unknown keeps the label reserved, so a same-label retry fails
        // closed as already used in this server run and the reduction stays
        // clean.
        let reconciliation;
        try {
          reconciliation = (await hasCommittedDirectProbeEvent({
            runDirectory,
            runNonce,
            ownerSecret: capabilitySecret,
            kind: 'handler-entered',
            label: probeLabel,
            heldCommit: processHeldCommitForRun(),
          })) ? 'committed' : 'absent';
        } catch { reconciliation = 'unknown'; }
        if (reconciliation === 'committed') {
          entryDurable = true;
        } else if (reconciliation === 'absent') {
          usedLabels.delete(probeLabel);
        }
        // reconciliation === 'unknown': the label STAYS reserved — no
        // release without proof of absence.
      }
      const code = error && typeof error === 'object' && 'code' in error ? /** @type {any} */ (error).code : 'error';
      // PRIVATE ephemeral diagnostics: with DEBUG_DIRECT_PROBE set this path
      // prints ONLY the closed probe error code — never a raw stack, error
      // string, or path (filesystem errors can embed probe paths, and
      // stderr is commonly retained by the caller).
      if (process.env.DEBUG_DIRECT_PROBE) {
        const debugCode = typeof code === 'string' && /^(PROBE|DIRECT)_/.test(code) ? code : 'error';
        console.error(`DEBUG-TOOL-ERR ${debugCode}`);
      }
      return errorResult(`Direct probe tool failed: ${code}`);
    }
  });

  /**
   * The FIRST awaited action of every handler: the durable handler-entered
   * append with a fresh call nonce and the diagnostic label. Metadata is
   * inspected only afterward, so entry survives absent/malformed metadata.
   */
  async function appendHandlerEntry(probeLabel, onEntered) {
    const callNonce = randomBytes(16).toString('hex');
    await append({
      event: { kind: 'handler-entered', probeLabel, callNonce, serverInstanceHash },
    });
    onEntered();
    return callNonce;
  }

  async function captureDirect(probeLabel, extra, onEntered) {
    const callNonce = await appendHandlerEntry(probeLabel, onEntered);
    const observation = inspectDirectMetadata(runNonce, extra?._meta);
    await append({
      event: {
        kind: 'metadata-observed',
        callNonce,
        fields: observation.fields,
        fieldsTruncated: observation.fieldsTruncated,
        candidateHashes: observation.candidateHashes,
        state: observation.state,
      },
    });
    return { content: [{ type: 'text', text: 'captured' }], structuredContent: { entered: true, metadataState: observation.state } };
  }

  async function holdDirect(probeLabel, extra, onEntered, holdMs = undefined) {
    const callNonce = await appendHandlerEntry(probeLabel, onEntered);
    // Probe-owned synthetic worker identity; identifies the probe worker,
    // never a real job.
    const workerHash = hashProbeValue(runNonce, `direct-probe-worker:${randomBytes(16).toString('hex')}`);
    // The two settlement timers: the synthetic worker's own completion
    // duration and the injected safety ceiling. Whichever decision lands
    // first wins once — the decided outcome is never overwritten, and both
    // timers are cleared on every decision path.
    let completionTimer = null;
    let safetyTimer = null;
    const clearHoldTimers = () => {
      if (completionTimer !== null) clearTimeout(completionTimer);
      if (safetyTimer !== null) clearTimeout(safetyTimer);
      completionTimer = null;
      safetyTimer = null;
    };
    if (holdMs !== undefined) {
      completionTimer = setTimeout(() => entry.finish('completed'), holdMs);
      completionTimer?.unref?.();
    }
    if (holdSafetyDeadlineMs !== undefined) {
      safetyTimer = setTimeout(() => entry.finish('safety-deadline'), holdSafetyDeadlineMs);
      safetyTimer?.unref?.();
    }
    /** @type {(outcome: string) => void} */
    let resolveSettlement = () => {};
    /** @type {{callNonce: string, workerHash: string, outcome: string|null, lock: Promise<void>, finish: (outcome: string) => void}} */
    const entry = {
      callNonce,
      workerHash,
      outcome: null,
      lock: Promise.resolve(),
      finish: (outcome) => {
        // ROUND 43: the outcome is decided once; the registration itself is
        // removed only by the settlement reconciliation, after both terminal
        // records are confirmed committed by durable reads.
        if (entry.outcome === null) entry.outcome = outcome;
        clearHoldTimers();
        resolveSettlement(entry.outcome);
      },
    };
    const settlementPromise = new Promise((resolve) => { resolveSettlement = resolve; });
    pendingHolds.add(entry);
    if (extra?.signal?.aborted) entry.finish('cancelled');
    else extra?.signal?.addEventListener('abort', () => entry.finish('cancelled'), { once: true });
    try {
      await append({
        event: { kind: 'hold-started', callNonce, workerHash },
      });
    } catch (error) {
      // ROUND 43/44: a rejected append does NOT prove the hold-started never
      // became durable — the append commits the record and its journal line
      // BEFORE its trailing steps (intent unlinks, the run-directory fsync)
      // can still fail. The registration is RETAINED and settlement is
      // delegated to the durable-read-driven reconciliation, which now keeps
      // a bounded retry task ACTIVE here (not just on disconnect): transient
      // faults converge while the connection is open, and a budget expiry
      // surfaces the unsettled outcome — the hold stays registered for the
      // disconnect pass — instead of reporting only the raw append failure.
      entry.finish('connection-closed');
      try { await reconcileSettlements({ deadlineMs: SETTLEMENT_RETRY_BUDGET_MS }); } catch { /* retained for the disconnect pass */ }
      if (pendingHolds.has(entry)) {
        const appendCode = error && typeof error === 'object' && 'code' in error ? String(/** @type {any} */ (error).code) : 'error';
        throw directError('PROBE_SETTLEMENT_UNSETTLED', `The hold settlement did not durably complete within the retry budget (append failure: ${appendCode}); the hold stays registered for reconciliation.`);
      }
      throw error;
    }
    // Resolves immediately when a disconnect finished the hold while the
    // start append was in flight; the reconciliation below still appends
    // after the start, keeping the log order entry → hold → settled.
    await settlementPromise;
    if (!(await reconcileHoldSettlement(entry))) {
      // ROUND 44: keep a bounded retry task active for the decided hold —
      // transient faults converge while the connection stays open, and a
      // budget expiry surfaces an unsettled result instead of a clean held
      // result while terminals remain unconfirmed.
      await reconcileSettlements({ deadlineMs: SETTLEMENT_RETRY_BUDGET_MS });
      if (pendingHolds.has(entry)) {
        throw directError('PROBE_SETTLEMENT_UNSETTLED', 'The hold settlement did not durably complete within the retry budget; the hold stays registered for reconciliation.');
      }
    }
    return { content: [{ type: 'text', text: 'held' }] };
  }

  return server;
}

/**
 * Reads the direct-probe environment variables into an observer description
 * for the disposable executable. DIRECT_PROBE_OWNER_SECRET carries the
 * driver-generated per-run capability secret through spawn-time env; the
 * executable holds it in memory only and never writes it to any file.
 * @returns {{runDirectory: string, runNonce: string, phase: string, ownerSecret: string}}
 */
export function directProbeObserverFromEnv() {
  const runDirectory = process.env.ZCODE_DIRECT_MCP_PROBE_RUN;
  const runNonce = process.env.ZCODE_DIRECT_MCP_PROBE_NONCE;
  const phase = process.env.ZCODE_DIRECT_MCP_PROBE_PHASE;
  const ownerSecret = process.env.DIRECT_PROBE_OWNER_SECRET;
  if (!runDirectory || !runNonce || !phase || !ownerSecret) {
    throw directError('DIRECT_PROBE_ENV_MISSING', 'ZCODE_DIRECT_MCP_PROBE_RUN, ZCODE_DIRECT_MCP_PROBE_NONCE, ZCODE_DIRECT_MCP_PROBE_PHASE, and DIRECT_PROBE_OWNER_SECRET are required.');
  }
  if (!isAbsolute(runDirectory)) throw directError('DIRECT_PROBE_ENV_INVALID', 'ZCODE_DIRECT_MCP_PROBE_RUN must be an absolute run directory.');
  if (!RUN_NONCE_PATTERN.test(runNonce)) throw directError('PROBE_NONCE_INVALID', 'The probe run nonce must be 64 lowercase hexadecimal characters.');
  if (!DIRECT_PROBE_PHASES.includes(phase)) throw directError('DIRECT_PROBE_ENV_INVALID', 'ZCODE_DIRECT_MCP_PROBE_PHASE must be a closed probe phase.');
  if (!RUN_NONCE_PATTERN.test(ownerSecret)) throw directError('DIRECT_PROBE_ENV_INVALID', 'DIRECT_PROBE_OWNER_SECRET must be 64 lowercase hexadecimal characters.');
  return { runDirectory, runNonce, phase, ownerSecret };
}

/**
 * Bounded grace before the disposable server force-exits after transport
 * close, sized like the original probe so an in-flight settlement append can
 * acquire the advisory lock and fsync before exit.
 */
export const DIRECT_SERVER_EXIT_GRACE_MS = 6_000;

/** Prints a bounded, redacted startup line for the driver transcript. */
function reportStartup() {
  const line = JSON.stringify({ probe: 'zcode-direct-mcp-probe', serverPid: process.pid, runNonce: '[redacted-nonce]' });
  process.stderr.write(`${line}\n`);
}

/** @param {string} left @param {string} right */
function sameEntryPath(left, right) {
  return left === right || `${left}${sep}` === right;
}

async function runAsDirectProbeExecutable() {
  const observer = directProbeObserverFromEnv();
  reportStartup();
  // The mechanism-only injected safety ceiling arrives through spawn-time
  // env (forwarded only when a lifecycle case needs it); absent means no
  // ceiling, which is the honest default for every other mode.
  let holdSafetyDeadlineMs;
  if (process.env.DIRECT_PROBE_HOLD_SAFETY_DEADLINE_MS !== undefined) {
    const raw = Number(process.env.DIRECT_PROBE_HOLD_SAFETY_DEADLINE_MS);
    if (!Number.isSafeInteger(raw) || raw <= 0) {
      throw directError('DIRECT_PROBE_ENV_INVALID', 'DIRECT_PROBE_HOLD_SAFETY_DEADLINE_MS must be a positive integer of milliseconds.');
    }
    holdSafetyDeadlineMs = raw;
  }
  const server = createDirectProbeServer({ observer, holdSafetyDeadlineMs });
  // server-started is a handler-side kind: it goes through this instance's
  // own handler writer capability.
  await server.probeDirectAppend({ kind: 'server-started', serverInstanceHash: server.probeDirectInstanceHash });
  // The server is disposable: after transport close, in-flight settlement
  // appends get a bounded grace to land, then the process must exit instead
  // of lingering.
  server.onclose = () => {
    const timer = setTimeout(() => process.exit(0), DIRECT_SERVER_EXIT_GRACE_MS);
    timer?.unref?.();
  };
  // The MCP SDK's stdio transport watches only 'data'/'error', so an abrupt
  // client death (SIGKILL, crashed Host) never fires transport onclose and
  // never aborts in-flight handlers. Like the original probe, the executable
  // watches its own stdin for end/close, settles every pending held call
  // durably, and force-exits within a bounded grace instead of lingering
  // behind a dead stdin pipe.
  let disconnectHandled = false;
  const onDisconnect = () => {
    if (disconnectHandled) return;
    disconnectHandled = true;
    server.probeDirectDisconnect.settlePendingHoldsOnDisconnect();
    const timer = setTimeout(() => process.exit(0), DIRECT_SERVER_EXIT_GRACE_MS);
    timer?.unref?.();
  };
  process.stdin.on('end', onDisconnect);
  process.stdin.on('close', onDisconnect);
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && sameEntryPath(fileURLToPath(import.meta.url), resolve(process.argv[1]))) {
  await runAsDirectProbeExecutable();
}
