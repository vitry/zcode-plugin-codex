// @ts-check
/**
 * Research-only LOCAL PROCESS observation helper for the local-settlement
 * campaign (plan Task 2; report §25.4/§25.8 frozen contract — implemented
 * WITHOUT re-deciding any frozen parameter).
 *
 * This module is the focused fixture observer for the REAL Companion
 * invocation identity and exit. It owns three strictly separated concerns:
 *
 * 1. The read-side admission of the fixture-generated STARTUP IDENTITY
 *    RECORD (`admitStartupIdentityRecord`): the nonce-keyed record the
 *    extended capture preload writes at install time (before the entry body,
 *    closure-observation.mjs). Per-evidence-class integrity: a missing,
 *    non-regular, oversize, unreadable, torn, shape-invalid, foreign-nonce or
 *    entry-mismatched record is a NAMED fact that exposes no identity and is
 *    NEVER "never launched", never launch readiness, and never death.
 *
 * 2. The OS-side verified live observation and the exit/absence adjudication
 *    (`observeLocalProcess`, `adjudicateLocalExit`): the race-safe double
 *    read (PID + OS start identity + environment-nonce verification) reused
 *    from the fixture identity helpers, bound to the CAPTURE nonce variable,
 *    plus the conservative disappearance join — verified presence of the
 *    established generation EARLIER plus verified absence of the SAME pid and
 *    start identity LATER. A normal-exit meta record corroborates a lawful
 *    exit only; it never covers uncatchable termination and never proves
 *    death by itself. A reused PID (different start identity), a changed or
 *    reparented ancestor, a failed liveness read, or a missing/absent
 *    baseline stays NAMED-unestablished.
 *
 * 3. The bounded local-duty verdict (`joinAncestryHops`,
 *    `adjudicateLocalDuties`): per-duty facts for the applicable local
 *    identities of report §25.5 (the invocation process, the broker daemon
 *    as the mediation hop, the declared transport descendant, and positively
 *    identified descendants only). The two-hop ancestry join is a
 *    CAPTURE-TIME fact with both endpoints positively captured; a marker
 *    written by one process never attests another merely because they
 *    inherited a nonce; the Companion↔transport attribution never crosses an
 *    unestablished hop by inference.
 *
 * NON-INTERFERENCE (plan Task 2): this module is a passive read-side
 * observer. It performs NO writes outside the caller's fixture capture
 * directory (and even those are performed by the fixture-generated preload,
 * never here), acquires NO lock, changes NO mode, registers NO signal
 * handler, spawns NO child process, keeps NO timer alive, and carries NO
 * stop authority — it never signals, never terminates, and never replaces a
 * business result. Observer failure is a named missing-observation fact.
 *
 * Provenance follows the module convention: `EXECUTING_..._SOURCE` is the
 * module-init snapshot; `localProcessObserverProvenance` binds it together
 * with the executing closure-observation bytes and the generated capture
 * source; the record-time working-tree re-read detects source drift.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  BROKER_IDENTITY_SUFFIX,
  CAPTURE_NONCE_VARIABLE,
  EXECUTING_CLOSURE_PRELOAD_SOURCE,
  IDENTITY_RECORD_MAX_BYTES,
  IDENTITY_RECORD_VERSION,
  INVOCATION_IDENTITY_SUFFIX,
  TERMINAL_ARGV_SELECTOR,
  closurePreloadSource,
} from './closure-preload.mjs';

export { EXECUTING_CLOSURE_PRELOAD_SOURCE } from './closure-preload.mjs';

/**
 * The closed version carried by every verdict of this module. v2
 * (evidence-completion Task 3, §26.6/§26.7): an ancestry-join verdict that
 * may rest on the preregistered route-(b) spawn-boundary causal witness is
 * composed, and the established hop verdict carries the additive
 * `witnessClass` member — old v1 verdicts replay byte-identically because
 * the witness rules only ever apply when a witness admission rides the join
 * input, which no v1 record carries. v3 (codex-review round 5, 2026-11-04):
 * the spawn-witness record gains the additive `childOsStartInstantMs`
 * persisted member (the witnessed child's numeric OS start instant, derived
 * from the SAME captured boundary start identity — no new OS query), the
 * positive marker-to-generation binding the transport hop's establishment
 * consumes; old v1 witness records replay under their recorded version and
 * never upgrade the marker path (the record without the member cannot bind
 * the marker's generation), which is the honest replay outcome — new runs
 * never fall back to the permissive old contract because every new record
 * carries the member (number or named-absent null).
 */
export const LOCAL_PROCESS_OBSERVATION_VERSION = 3;

/**
 * Version tag of the local-observer provenance construction: bump when the
 * hashed input combination changes so old records stay interpretable. v1
 * bound THIS module's bytes, the closure-observation helper's bytes and the
 * generated capture source. v2 (codex review round: the five-P2 fix round)
 * additionally binds the fixture helper's module-init bytes (fixture.mjs
 * implements the actual OS inspection the verdicts trust) and the
 * identity-record integrity helper's bytes (scripts/lib/fs.mjs implements
 * the bounded private-file read every admission trusts). v3 (review round 3,
 * provenance-closure sweep) completes the transitive evidence-deciding
 * closure: scripts/lib/process.mjs (every OS identity read and absence
 * confirmation runs through it) and scripts/lib/errors.mjs (the unsafe-path
 * rejections the integrity read raises). v4 (review round 8) replaces the
 * disk-snapshot helper inputs with the MATERIALIZED EXECUTING COPY bytes
 * (executing == hashed by construction, covering non-exported code) and the
 * identity machinery moved INTO this module (fixture.mjs no longer executes
 * in the evidence path) — copying an earlier digest onto these bytes would
 * misattribute the evidence-deciding helpers.
 */
export const LOCAL_OBSERVER_DIGEST_TAG = 'zcode-shell-wait-local-observer-v4';

// Module-INIT snapshot of THIS module's executing source (the same
// provenance discipline as evidence.mjs/shape-diagnostic.mjs): read
// synchronously at initialization so the digest binds the bytes Node
// actually loaded; the record-time working-tree re-read detects any later
// on-disk edit as source drift without relabelling loaded code.
export const EXECUTING_LOCAL_PROCESS_OBSERVATION_SOURCE = readFileSync(fileURLToPath(import.meta.url));

// EXECUTING-COPY MATERIALIZATION (review round 8): the three production
// helpers whose code executes in the evidence path are copied BYTE-IDENTICAL
// into a private cache layout INSIDE the repo's node_modules scope (their
// relative './errors.mjs' imports and the copies' createRequire anchors
// resolve the repo's native packages exactly like the production files) at
// observer init, and the copies are the modules this observer actually
// loads — so the hashed bytes ARE the executing bytes by construction,
// covering non-exported code (a private-constant edit) that exported-string
// comparisons cannot see. scripts/lib/*.mjs stay unmodified; the cache is
// disposable and removed when this process exits.
// EXECUTING-COPY MATERIALIZATION (review round 8): the three production
// helpers whose code executes in the evidence path are copied BYTE-IDENTICAL
// into a private cache layout INSIDE the repo's node_modules scope (their
// relative './errors.mjs' imports and the copies' createRequire anchors
// resolve the repo's native packages exactly like the production files) at
// observer init, and the copies are the modules this observer actually
// loads — so the hashed bytes ARE the executing bytes by construction,
// covering non-exported code (a private-constant edit) that exported-string
// comparisons cannot see. scripts/lib/*.mjs stay unmodified; the cache is
// disposable and removed when this process exits.
export const EXECUTING_HELPER_MATERIALIZATION = (() => {
  let dir = null;
  /** @type {{ [relativeName: string]: string }} */
  const bytes = {};
  try {
    const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
    dir = join(repositoryRoot, 'node_modules', `.local-observer-materialization-${process.pid}`);
    for (const relative of ['scripts/lib/fs.mjs', 'scripts/lib/process.mjs', 'scripts/lib/errors.mjs']) {
      const source = fileURLToPath(new URL(`../../${relative}`, import.meta.url));
      const target = join(dir, relative);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      bytes[relative] = createHash('sha256').update(readFileSync(target)).digest('hex');
    }
  } catch {
    dir = null;
  }
  if (dir !== null) {
    process.once('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  }
  return Object.freeze({ dir, bytes: Object.freeze(bytes) });
})();

/** @type {Promise<{ readBoundedJsonFile: any, runProcess: any }> | null} */
let materializedHelperModulesPromise = null;

/**
 * Load the MATERIALIZED executing helper modules (the byte-identical copies
 * materialized at observer init under the repo's node_modules scope) —
 * memoized so every evidence path in this process runs through the same
 * hashed copies. When materialization is unavailable (no writable
 * node_modules scope), this falls back to the CACHED production modules and
 * the materialization verifier reports the named-unavailable state — the
 * observation path keeps working while the provenance stops claiming
 * byte-verified helper execution.
 * @returns {Promise<{ readBoundedJsonFile: any, runProcess: any }>}
 */
function loadMaterializedHelperModules() {
  if (materializedHelperModulesPromise === null) {
    materializedHelperModulesPromise = (async () => {
      if (EXECUTING_HELPER_MATERIALIZATION.dir === null) {
        const [fsModuleFallback, processModuleFallback] = await Promise.all([
          import('../../scripts/lib/fs.mjs'),
          import('../../scripts/lib/process.mjs'),
        ]);
        return { readBoundedJsonFile: fsModuleFallback.readBoundedJsonFile, runProcess: processModuleFallback.runProcess, fallback: true };
      }
      const [fsModule, processModule] = await Promise.all([
        import(pathToFileURL(join(EXECUTING_HELPER_MATERIALIZATION.dir, 'scripts/lib/fs.mjs')).href),
        import(pathToFileURL(join(EXECUTING_HELPER_MATERIALIZATION.dir, 'scripts/lib/process.mjs')).href),
      ]);
      return { readBoundedJsonFile: fsModule.readBoundedJsonFile, runProcess: processModule.runProcess };
    })();
  }
  return materializedHelperModulesPromise;
}

/**
 * Exact process-identity discipline reused by the driver's bounded host
 * lifecycle: a process is signalled only after its PID, parent PID, start
 * identity, and fake-ZCode nonce environment marker were all re-verified. A
 * stale, reparented, restarted, or nonce-mismatched PID is never signalled.
 */
export const FAKE_ZCODE_NONCE_VARIABLE = 'FAKE_ZCODE_PROCESS_NONCE';

/** @param {string} nonce */
export function validateProcessNonce(nonce) {
  if (typeof nonce !== 'string' || !/^[a-f0-9]{64}$/u.test(nonce)) throw new Error('the exact fake-ZCode process nonce mismatch');
}

/**
 * Validate one fake-ZCode process marker file record.
 * @param {unknown} marker @param {string} expectedNonce
 * @returns {{ pid: number, ppid: number, nonce: string }}
 */
export function validateProcessMarker(marker, expectedNonce) {
  validateProcessNonce(expectedNonce);
  if (!marker || typeof marker !== 'object'
    || !Number.isSafeInteger(/** @type {any} */ (marker).pid) || /** @type {any} */ (marker).pid <= 0
    || !Number.isSafeInteger(/** @type {any} */ (marker).ppid) || /** @type {any} */ (marker).ppid <= 0
    || /** @type {any} */ (marker).nonce !== expectedNonce) {
    // Marker CORRUPTION (malformed PID or mismatched nonce) is distinct from a
    // confirmed absence: corruption is recorded as incomplete cleanup and the
    // unverified PID is never signalled.
    /** @type {any} */ const corruption = new Error('the exact fake-ZCode process marker identity is invalid');
    corruption.code = 'ZCODE_SHELL_WAIT_MARKER_INVALID';
    throw corruption;
  }
  return { pid: /** @type {any} */ (marker).pid, ppid: /** @type {any} */ (marker).ppid, nonce: expectedNonce };
}

/** @param {number} pid */
/**
 * The injected runner shape for ps identity queries (the round-32 seam).
 * @typedef {(launch: { command: string, args: string[] }, options?: { timeoutMs?: number, maxOutputBytes?: number, env?: Record<string, string | undefined> }) => Promise<{ code: number | null, stdout: string, stderr: string }>} osSeamsRunProcess
 */

/**
 * The pinned spawn environment for EVERY `ps` identity query (review round
 * 32): TZ=UTC pins the lstart rendering to UTC (the parse is field-explicit
 * UTC), and LC_ALL=C pins the C-locale date formatting — a localized locale
 * (e.g. LC_ALL=fr_FR.UTF-8) renders localized month/day names and ordering
 * that the strict UTC field parse would reject, leaving darwin duties
 * unable to establish on that host. TZ alone does not pin formatting.
 * @returns {Record<string, string | undefined>}
 */
function psIdentitySpawnEnv() {
  return { ...process.env, TZ: 'UTC', LC_ALL: 'C' };
}

/**
 * The default ps run through the materialized executing helpers, with the
 * osSeams override (review round 32) so tests can drive the REAL reader's
 * invocation and parse on any host.
 * @param {osSeamsRunProcess | undefined} seam
 * @returns {osSeamsRunProcess}
 */
function psRunner(seam) {
  return seam ?? (async (launch, options) => (await loadMaterializedHelperModules()).runProcess(launch, options));
}

/** @param {number} pid @param {{ runProcess?: osSeamsRunProcess }} [osSeams] */
async function readMacProcessStart(pid, osSeams = {}) {
  // ROUND-31/32: lstart is requested in EXPLICIT UTC with the C locale
  // (`TZ=UTC LC_ALL=C ps`) — the local rendering carries no offset and is
  // AMBIGUOUS during a DST fall-back hour, and a localized locale renders
  // month/day names the strict field parse cannot read.
  const run = psRunner(osSeams.runProcess);
  const result = await run({ command: 'ps', args: ['-o', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-p', String(pid)] }, { timeoutMs: 2_000, maxOutputBytes: 4 * 1024, env: psIdentitySpawnEnv() });
  if (result.code !== 0 || !result.stdout.trim()) return undefined;
  const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(result.stdout);
  if (!match || Number(match[1]) !== pid || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= 0) {
    throw new Error('the exact fake-ZCode process identity could not be parsed');
  }
  return { pid, ppid: Number(match[2]), startIdentity: match[3] };
}

/** @param {number} pid */
async function readLinuxProcessStart(pid) {
  const { readFile: read } = await import('node:fs/promises');
  let statText;
  try { statText = await read(`/proc/${pid}/stat`, 'utf8'); } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined;
    throw error;
  }
  const close = statText.lastIndexOf(')');
  const fields = close < 0 ? [] : statText.slice(close + 2).trim().split(/\s+/u);
  const observedPid = Number(statText.slice(0, statText.indexOf(' ')));
  const ppid = Number(fields[1]);
  const startTicks = fields[19];
  if (observedPid !== pid || !Number.isSafeInteger(ppid) || ppid <= 0 || !/^\d+$/u.test(startTicks ?? '')) {
    throw new Error('the exact fake-ZCode process identity could not be parsed');
  }
  return { pid: observedPid, ppid, startIdentity: `proc:${startTicks}` };
}

/**
 * Read one process environment marker. Returns 'gone' when the process no
 * longer exists, 'mismatch' when a live process does not carry the expected
 * nonce (an identity change, never silently accepted), and 'present' on an
 * exact nonce match.
 * @param {number} pid @param {string} expectedNonce @param {string} nonceVariable @param {{ runProcess?: osSeamsRunProcess }} [osSeams]
 * @returns {Promise<'present' | 'mismatch' | 'gone'>}
 */
async function readProcessEnvironmentMarker(pid, expectedNonce, nonceVariable, osSeams = {}) {
  if (process.platform === 'linux') {
    const { readFile: read } = await import('node:fs/promises');
    let environ;
    try { environ = await read(`/proc/${pid}/environ`, 'utf8'); } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return 'gone';
      throw error;
    }
    return environ.split('\0').includes(`${nonceVariable}=${expectedNonce}`) ? 'present' : 'mismatch';
  }
  // ROUND-32: the ps invocation carries the same PINNED UTC C-locale env —
  // the rendered command column is byte-token content, but no identity
  // query is left to the ambient locale.
  const run = psRunner(osSeams.runProcess);
  const command = await run({ command: 'ps', args: ['eww', '-o', 'command=', '-p', String(pid)] }, { timeoutMs: 2_000, maxOutputBytes: 64 * 1024, env: psIdentitySpawnEnv() });
  if (command.code !== 0 || !command.stdout.trim()) return 'gone';
  return command.stdout.split(/\s+/u).includes(`${nonceVariable}=${expectedNonce}`) ? 'present' : 'mismatch';
}

/**
 * The self-describing "observed then gone" failure (review round 28): the
 * FIRST read verified an occupant start identity and the pid vanished before
 * the read completed. The observed identity rides the error so the
 * observation layer (and the exit adjudicator, which knows the bound
 * generation) can classify it — a demonstrably different occupant is
 * positive replacement evidence, never the bound generation's lawful
 * absence. The message carries no 'identity changed' (that phrase stays the
 * mid-double-read reuse class) and no 'ppid changed' (the reparenting class).
 * @param {string} observedStartIdentity @param {number} observedTakenEpochMs @param {number} observedResolvedEpochMs @returns {Error}
 */
function observedThenGoneError(observedStartIdentity, observedTakenEpochMs, observedResolvedEpochMs) {
  const error = new Error('the exact fake-ZCode process disappeared after its start identity was observed');
  /** @type {any} */ (error).observedThenGone = true;
  // (codex round 13) the identity and its OBSERVATION instant travel as a
  // unit — the failure completion never dates the carried evidence.
  /** @type {any} */ (error).observedStartIdentity = observedStartIdentity;
  /** @type {any} */ (error).observedIdentityTakenEpochMs = observedTakenEpochMs;
  /** @type {any} */ (error).observedIdentityCompletedEpochMs = observedResolvedEpochMs;
  return error;
}

/**
 * Inspect one exact process identity (double-read so a racing exit or restart
 * is detected, never silently accepted). The returned shape carries the nonce
 * under the single canonical `nonce` field shared by capture, re-verification,
 * and termination.
 * @param {number} pid @param {string} expectedNonce @param {string} [nonceVariable]
 * @param {{ platform?: string, ps?: (pid: number) => Promise<{ pid: number, ppid: number, lstart: string }>, environ?: 'present' | 'mismatch' | 'gone', runProcess?: osSeamsRunProcess }} [osSeams]
 * @returns {Promise<{ pid: number, ppid: number, startIdentity: string, nonce: string, takenEpochMs: number } | undefined>}
 */
export async function inspectVerifiedProcessIdentity(pid, expectedNonce, nonceVariable = FAKE_ZCODE_NONCE_VARIABLE, osSeams = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('the exact fake-ZCode PID is invalid');
  validateProcessNonce(expectedNonce);
  if (typeof nonceVariable !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(nonceVariable)) {
    throw new Error('the exact fake-ZCode process nonce marker is invalid');
  }
  // ROUND-24 OS SEAMS: tests drive the REAL double-read through injected
  // platform/ps/environ seams — never a fabricated error string — so the
  // inspector's actual error paths are exercised on every host.
  const platform = osSeams.platform ?? process.platform;
  // (Review round 6, Finding 3) the observation window: a caller-supplied
  // abort signal honored BETWEEN the inspector's reads — no read may START
  // after the window closed (a started read keeps its own semantics; only
  // the NEXT one is prevented). The named error rides the caller's existing
  // inspection-failure path.
  const inspectorWindowClosed = () => (/** @type {any} */ (osSeams)).abortSignal?.aborted === true;
  const windowClosedError = () => Object.assign(new Error('the observation window closed over the in-flight inspection'), { observationWindowClosed: true });
  // The seam path applies the SAME derivation as the real darwin reader
  // (startIdentity = the lstart text), so a supplied ps seam returns the
  // exact shape the real double-read produces.
  const readStart = osSeams.ps
    ? (async (/** @type {number} */ observedPid) => {
        const psResult = /** @type {any} */ (await osSeams.ps?.(observedPid));
        return psResult === undefined ? undefined
          : { ...psResult, startIdentity: psResult.lstart };
      })
    : (platform === 'linux' ? readLinuxProcessStart : (/** @type {number} */ observedPid) => readMacProcessStart(observedPid, osSeams));
  // (codex round 13 — EVIDENCE TIMING) the FIRST identity read's TAKEN
  // instant is sampled before the read is dispatched: the ride below
  // carries it as a UNIT with the observed start identity, so a failure
  // that completes arbitrarily later (a delayed response, a slow OS query)
  // can never misdate the carried evidence at the failure's completion
  // time. Consumers date the carried identity at this instant — the
  // presence/recency comparisons compare what was OBSERVED and WHEN it was
  // observed, never when the failure happened to finish.
  const beforeTakenEpochMs = Date.now();
  const before = await readStart(pid);
  if (!before) return undefined;
  // (codex round 14 — the COLLECTION INTERVAL) the taken instant is only a
  // collection LOWER bound: a ps request dispatched before a concurrent
  // presence baseline can COLLECT a successor's identity after it (the
  // kernel table read lands whenever the response says it does). The ride
  // therefore carries the whole collection INTERVAL as a unit with the
  // observed identity — the taken/dispatch lower bound and the read's
  // RESOLUTION upper bound — so consumers treat an interval OVERLAPPING a
  // presence baseline as AMBIGUOUS evidence instead of definitively dating
  // it at either bound.
  const beforeResolvedEpochMs = Date.now();
  // (codex round 5) UNIFORM IDENTITY RIDE: every failure thrown AFTER the
  // first read verified an occupant carries that observed start identity on
  // the error (`observedStartIdentity`) — an ORDINARY I/O error (the
  // environment query or the second identity read failing) is still an
  // attempt that OBSERVED V1, and discarding the observation there let the
  // next attempt verify a same-pid REPLACEMENT occupant and witness it as
  // the originally spawned child. The ride is evidence preservation, not
  // error reclassification: each failure keeps its own message class, the
  // observation layer compares the carried identity against the bound
  // generation exactly as it already does for the nonce-mismatch and
  // observed-then-gone classes, and an identity-consistent failure stays
  // non-deciding.
  const rideObservedIdentity = (/** @type {Error} */ error) => {
    /** @type {any} */ (error).observedStartIdentity = before.startIdentity;
    /** @type {any} */ (error).observedIdentityTakenEpochMs = beforeTakenEpochMs;
    /** @type {any} */ (error).observedIdentityCompletedEpochMs = beforeResolvedEpochMs;
    return error;
  };
  if (inspectorWindowClosed()) throw rideObservedIdentity(windowClosedError());
  let markerState;
  try {
    markerState = osSeams.environ !== undefined ? osSeams.environ : await readProcessEnvironmentMarker(pid, expectedNonce, nonceVariable, osSeams);
  } catch (markerError) {
    throw rideObservedIdentity(/** @type {Error} */ (markerError));
  }
  if (inspectorWindowClosed()) throw rideObservedIdentity(windowClosedError());
  // ROUND-25: a NONCE-VERIFICATION failure is NOT an observed start-identity
  // change — its message deliberately does NOT carry 'identity changed', so
  // it maps to the named non-reuse torn class (never latched as reuse). Only
  // the double-read's OBSERVED start-identity change is generation-change
  // evidence.
  if (markerState === 'mismatch') {
    // ROUND-26: the OBSERVED start identity rides the failure (a PID reused
    // by a nonce-less process still exposes the replacement's OS start
    // identity here). observeLocalProcess compares it with the expected
    // generation: demonstrably different -> the reuse class; same-generation
    // -> the named nonce failure.
    const nonceFailure = new Error('the exact fake-ZCode process nonce identity verification failed');
    if (before && typeof before.startIdentity === 'string') {
      /** @type {any} */ (nonceFailure).observedStartIdentity = before.startIdentity;
      /** @type {any} */ (nonceFailure).observedIdentityTakenEpochMs = beforeTakenEpochMs;
      /** @type {any} */ (nonceFailure).observedIdentityCompletedEpochMs = beforeResolvedEpochMs;
    }
    throw nonceFailure;
  }
  if (markerState === 'gone') {
    // ROUND-28: the FIRST read VERIFIED this occupant's start identity and
    // the pid vanished before the marker read — a bare undefined here would
    // DISCARD that evidence and let a mid-read successor's absence be
    // credited to the caller's bound generation. The observed identity RIDES
    // the failure (the same shape as the nonce-mismatch ride); the message
    // deliberately carries no 'identity changed' (that phrase stays the
    // mid-double-read reuse class).
    throw observedThenGoneError(before.startIdentity, beforeTakenEpochMs, beforeResolvedEpochMs);
  }
  if (inspectorWindowClosed()) throw rideObservedIdentity(windowClosedError());
  // (codex round 11 — TIMESTAMP PROVENANCE for the boundary capture) The
  // FINAL identity read's TAKEN instant is sampled BEFORE the read is
  // dispatched and SURFACED on the returned identity: the read's response
  // can arrive arbitrarily later than its snapshot (a seam that resolves
  // late, a slow OS query, scheduler delay), and a capture instant sampled
  // at RESPONSE ARRIVAL would fabricate survival the snapshot never
  // witnessed — a same-second pid replacement born after the snapshots and
  // dead before the response could ride it into an established ancestry
  // verdict. The taken instant is the conservative collection bound (the
  // snapshot was taken at or after it); consumers anchor survival claims on
  // it, never on response completion.
  const takenEpochMs = Date.now();
  let after;
  try {
    after = await readStart(pid);
  } catch (secondReadError) {
    throw rideObservedIdentity(/** @type {Error} */ (secondReadError));
  }
  if (!after) {
    // ROUND-28: the same ride when the pid vanished before the SECOND
    // start-identity read (the marker nonce's presence is scope-only
    // evidence — it never attests the generation).
    throw observedThenGoneError(before.startIdentity, beforeTakenEpochMs, beforeResolvedEpochMs);
  }
  // SELF-DESCRIBING ERRORS (review round 24): a changed START IDENTITY
  // between the double reads is POSITIVE replacement evidence (a PID reused
  // between the two reads) and its message carries 'identity changed' — the
  // reuse latch consumes it. A PPID-ONLY change is ordinary REPARENTING
  // (the daemon whose Companion dies) and its message carries 'ppid
  // changed' — the generic torn class, NEVER the reuse class. Both carry the
  // first-read identity on the error (the uniform round-5 ride: a
  // within-call contradiction is two observations, and the ppid-only class's
  // consistent identity is retained evidence — never discarded).
  if (before.startIdentity !== after.startIdentity) {
    throw rideObservedIdentity(new Error('the exact fake-ZCode process identity changed'));
  }
  if (before.ppid !== after.ppid) {
    throw rideObservedIdentity(new Error('the exact fake-ZCode process ppid changed between reads'));
  }
  return { ...after, nonce: expectedNonce, takenEpochMs };
}

/**
 * Capture one exact process identity from a fake-ZCode process marker file:
 * the single shared entry point for the held-run lifecycle so capture,
 * re-verification, and termination all speak the same nonce-bearing shape.
 * @param {string} processPath @param {string} processNonce
 * @returns {Promise<{ pid: number, ppid: number, startIdentity: string, nonce: string }>}
 */
export async function captureVerifiedProcessIdentity(processPath, processNonce) {
  const { readFile: read } = await import('node:fs/promises');
  /** @param {string} code @param {string} message @returns {Error} */
  const coded = (code, message) => /** @type {any} */ (Object.assign(new Error(message), { code }));
  let markerBytes;
  try {
    markerBytes = await read(processPath, 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      throw coded('ZCODE_SHELL_WAIT_MARKER_ABSENT', 'the exact fake-ZCode process marker never appeared (confirmed absence; nothing to signal)');
    }
    throw coded('ZCODE_SHELL_WAIT_MARKER_INVALID', `the exact fake-ZCode process marker could not be read: ${/** @type {Error} */ (error).message}`);
  }
  // The marker invariant: the file exists WITH its JSON payload only after fake
  // ZCode actually launched. A zero-byte marker (e.g. pre-created empty by the
  // harness before the host launched, then the host exited early) is a
  // CONFIRMED ABSENCE — no fake process ever wrote its identity — never
  // marker corruption.
  if (markerBytes.trim() === '') {
    throw coded('ZCODE_SHELL_WAIT_MARKER_ABSENT', 'the exact fake-ZCode process marker is empty: no fake process ever launched (confirmed absence; nothing to signal)');
  }
  let marker;
  try {
    marker = validateProcessMarker(JSON.parse(markerBytes), processNonce);
  } catch (error) {
    throw /** @type {any} */ (error)?.code === 'ZCODE_SHELL_WAIT_MARKER_INVALID'
      ? error
      : coded('ZCODE_SHELL_WAIT_MARKER_INVALID', `the exact fake-ZCode process marker is corrupt: ${error instanceof Error ? error.message : String(error)}`);
  }
  let observed;
  try {
    observed = await inspectVerifiedProcessIdentity(marker.pid, processNonce);
  } catch (error) {
    // ROUND-28: a mid-read disappearance at CAPTURE time is the capture-time
    // confirmed-exit shape (no bound generation exists yet to latch for) —
    // the same named failure the !observed path below throws.
    if (/** @type {any} */ (error)?.observedThenGone === true) {
      throw coded('ZCODE_SHELL_WAIT_PROCESS_EXITED', 'the exact fake-ZCode process exited before identity capture');
    }
    throw error;
  }
  // Codex gate round-7 finding 1: an EXISTING, nonce-valid marker whose
  // process has exited is a CONFIRMED PERMANENT DISAPPEARANCE — never launch
  // readiness that might still arrive. It carries its own code so the
  // driver's identity retry loop can stop retrying (and name the failure)
  // instead of treating the disappearance as an absent marker and burning
  // the experiment budget on a process that can never be captured.
  if (!observed) throw coded('ZCODE_SHELL_WAIT_PROCESS_EXITED', 'the exact fake-ZCode process exited before identity capture');
  if (observed.ppid !== marker.ppid) throw coded('ZCODE_SHELL_WAIT_MARKER_INVALID', 'the exact fake-ZCode parent identity mismatch');
  return observed;
}

/**
 * Terminate one exact process after re-verifying its identity; escalate to
 * SIGKILL only while the identity still matches, verify exit after every
 * signal within a bounded deadline, and return an explicit outcome: a thrown
 * signal is never a success while the process is still live, and a process
 * that survives SIGKILL verification is reported as a failure for the caller
 * to record.
 * @param {{ pid: number, ppid: number, nonce: string, startIdentity: string }} identity
 * @param {{ readIdentity?: (expected: unknown) => Promise<unknown>, kill?: (pid: number, signal: NodeJS.Signals) => boolean, waitForExit?: (identity: unknown, phase: 'terminate' | 'kill') => Promise<void> }} [dependencies]
 * @returns {Promise<TerminationOutcome>}
 */
export async function terminateVerifiedProcess(identity, dependencies = {}) {
  const readIdentity = dependencies.readIdentity ?? (async (expected) => {
    try {
      return await inspectVerifiedProcessIdentity(/** @type {any} */ (expected).pid, /** @type {any} */ (expected).nonce);
    } catch (error) {
      // ROUND-28: a mid-read disappearance during termination verification
      // is the exited shape (the pid is gone; termination gates signalling
      // and has no adjudication to latch for).
      if (/** @type {any} */ (error)?.observedThenGone === true) return undefined;
      throw error;
    }
  });
  const kill = dependencies.kill ?? ((pid, signal) => process.kill(pid, signal));
  const waitForExit = dependencies.waitForExit ?? (async (expected, phase) => {
    const deadline = Date.now() + (phase === 'kill' ? 5_000 : 2_000);
    while (Date.now() < deadline) {
      if (await readIdentity(expected) === undefined) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`the exact verified process remained alive during ${phase}`);
  });
  /** @type {TerminationOutcome} */
  const outcome = { attempted: false, signalled: null, exited: false, failure: null };
  // A disappeared target needs no signal and counts as exited; a live target
  // whose identity changed is never signalled and is reported as a failure.
  if (await readIdentity(identity) === undefined) {
    outcome.exited = true;
    return outcome;
  }
  if (!await verifyUnchanged(identity, readIdentity)) {
    outcome.failure = 'the exact fake-ZCode process identity changed before signalling';
    return outcome;
  }
  outcome.attempted = true;
  try {
    kill(identity.pid, 'SIGTERM');
    outcome.signalled = 'SIGTERM';
  } catch (error) {
    // A thrown signal is not a success while the process is still live.
    if (await readIdentity(identity) === undefined) {
      outcome.exited = true;
      return outcome;
    }
    outcome.failure = `SIGTERM could not be signalled (${error instanceof Error ? error.message : String(error)}) and the exact fake-ZCode process remains live`;
    return outcome;
  }
  try {
    await waitForExit(identity, 'terminate');
    outcome.exited = true;
    return outcome;
  } catch { /* escalate only the still-matching PID */ }
  if (!await verifyUnchanged(identity, readIdentity)) {
    const gone = await readIdentity(identity) === undefined;
    outcome.exited = gone;
    if (!gone) outcome.failure = 'the exact fake-ZCode process identity changed during termination';
    return outcome;
  }
  try {
    kill(identity.pid, 'SIGKILL');
    outcome.signalled = 'SIGKILL';
  } catch (error) {
    if (await readIdentity(identity) === undefined) {
      outcome.exited = true;
      return outcome;
    }
    outcome.failure = `SIGKILL could not be signalled (${error instanceof Error ? error.message : String(error)}) and the exact fake-ZCode process remains live`;
    return outcome;
  }
  try {
    await waitForExit(identity, 'kill');
    outcome.exited = true;
    return outcome;
  } catch {
    outcome.failure = 'the exact fake-ZCode process remained alive after SIGKILL exit verification';
    return outcome;
  }
}

/**
 * Re-verify one captured identity before any signal. Even when the injected
 * reader does not throw, a returned observation that differs in any field
 * (reparented, restarted, nonce changed) blocks the signal.
 * @param {{ pid: number, ppid: number, nonce: string, startIdentity: string }} identity
 * @param {(expected: unknown) => Promise<unknown>} readIdentity
 * @returns {Promise<boolean>} true only when the exact identity is still live
 */
async function verifyUnchanged(identity, readIdentity) {
  const observed = await readIdentity(identity);
  if (observed === undefined || observed === null) return false;
  const record = /** @type {any} */ (observed);
  if (record.pid !== identity.pid || record.ppid !== identity.ppid) return false;
  if (record.startIdentity !== identity.startIdentity) return false;
  if (record.nonce !== identity.nonce) return false;
  return true;
}

/**
 * Explicit termination outcome returned by terminateVerifiedProcess so the
 * caller can record exactly which cleanup obligation failed.
 * @typedef {{
 *   attempted: boolean,
 *   signalled: 'SIGTERM' | 'SIGKILL' | null,
 *   exited: boolean,
 *   failure: string | null,
 * }} TerminationOutcome
 */


/**
 * Byte-drift check: compare each materialized EXECUTING helper copy's hash
 * (what this process actually runs — covering non-exported code) against the
 * CURRENT disk bytes of the production helper. Any difference is named: the
 * executing copies and the production files have diverged.
 * @param {{
 *   diskBytes?: (relativeName: string) => Promise<Buffer>,
 * }} [deps]
 * @returns {Promise<{ consistent: boolean, mismatches: string[], unavailable?: boolean }>}
 */
export async function verifyLocalObserverHelperMaterialization(deps = {}) {
  if (EXECUTING_HELPER_MATERIALIZATION.dir === null) {
    return { consistent: false, mismatches: ['materialization-unavailable'], unavailable: true };
  }
  const mismatches = [];
  for (const [relativeName, executingDigest] of Object.entries(EXECUTING_HELPER_MATERIALIZATION.bytes)) {
    const current = deps.diskBytes ? await deps.diskBytes(relativeName) : await readFile(fileURLToPath(new URL(`../../${relativeName}`, import.meta.url)));
    const currentDigest = createHash('sha256').update(current).digest('hex');
    if (currentDigest !== executingDigest) mismatches.push(relativeName);
  }
  return { consistent: mismatches.length === 0, mismatches };
}

const HEX_64 = /^[a-f0-9]{64}$/u;

/** The closed role set (§25.4 item 4: the argv shape selects the role). */
const IDENTITY_ROLES = Object.freeze(['invocation', 'broker-daemon']);

/** @param {string} message @returns {TypeError} */
function invalidLocalProcessInput(message) {
  return new TypeError(`Invalid local process observation input: ${message}`);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} nonce @param {string} label */
function validateCaptureNonce(nonce, label) {
  if (typeof nonce !== 'string' || !HEX_64.test(nonce)) {
    throw invalidLocalProcessInput(`the ${label} nonce must be a 64-hex digest.`);
  }
}

/**
 * The caller-supplied stamp clock: a FIXED epoch (number — every sample
 * returns it, the pre-review contract) or a THUNK whose every call stamps
 * ONE sample (the runtime's per-path completion discipline — a completion
 * sampled after awaited work reflects the work's actual completion, never
 * the dispatch instant). Undefined → Date.now(). Every sample is validated
 * like the old fixed read start (fail-closed, never a guessed stamp).
 * @param {number | (() => number) | undefined} clock
 * @returns {() => number}
 */
function completionClock(clock) {
  return () => {
    const sampled = typeof clock === 'function' ? clock() : clock;
    const value = sampled ?? Date.now();
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw invalidLocalProcessInput('the read epoch must be a positive integer.');
    }
    return value;
  };
}

/** @typedef {'invocation' | 'broker-daemon'} IdentityRole */

/**
 * The admitted startup identity projection (the closed record facts only —
 * no raw capture bytes, no private paths beyond the entry realpath the exit
 * meta already carries).
 * @typedef {{
 *   role: IdentityRole,
 *   nonce: string,
 *   entryRealpath: string,
 *   argv?: string[],
 *   configRealpathSha256?: string,
 *   pid: number,
 *   ppid: number,
 *   firstWriteEpochMs: number,
 *   startOriginMs: number | null,
 *   firstWritePreciseMs: number | null,
 * }} StartupIdentity
 */

/**
 * One startup-identity admission verdict. `established` exposes the bound
 * identity; every other status is a NAMED observer fact with a null identity
 * (missing/invalid are never conflated and never folded into a launch or
 * death claim).
 * @typedef {{
 *   localProcessObservationVersion: number,
 *   class: 'startup-identity',
 *   status: 'established' | 'missing' | 'invalid',
 *   reason: string | null,
 *   identity: StartupIdentity | null,
 *   readStartedEpochMs: number,
 *   readEpochMs: number,
 * }} StartupIdentityAdmission
 */

/** @param {StartupIdentityAdmission['status']} status @param {string | null} reason @param {number} readEpochMs @param {number} readStartedEpochMs @returns {StartupIdentityAdmission} */
function identityAdmissionVerdict(status, reason, readEpochMs, readStartedEpochMs) {
  return {
    localProcessObservationVersion: LOCAL_PROCESS_OBSERVATION_VERSION,
    class: 'startup-identity',
    status,
    reason,
    identity: null,
    // The honest admission interval: started before any I/O, `readEpochMs`
    // sampled only after the admission's reads complete — a record created
    // during the awaits can never be reported as observed before its own
    // creation, and a read completing after a cutoff carries a post-cutoff
    // timestamp.
    readStartedEpochMs,
    readEpochMs,
  };
}

/**
 * Validate the closed identity-record contract for one role. Returns the
 * typed identity or the named shape-violation reason.
 * @param {unknown} record @param {IdentityRole} role
 * @returns {{ ok: true, identity: StartupIdentity } | { ok: false, reason: string }}
 */
function validateIdentityRecord(record, role) {
  if (!isPlainObject(record)) return { ok: false, reason: 'identity-record-shape-invalid' };
  const keys = Object.keys(record).sort();
  // Per-role closed field sets: the invocation record carries the terminal
  // argv selector; the broker-daemon record carries ONLY a digest of the
  // broker config realpath (the raw private config path is never persisted).
  const required = role === 'invocation'
    ? ['argv', 'entryRealpath', 'firstWriteEpochMs', 'firstWritePreciseMs', 'nonce', 'pid', 'ppid', 'role', 'startOriginMs', 'version']
    : ['configRealpathSha256', 'entryRealpath', 'firstWriteEpochMs', 'firstWritePreciseMs', 'nonce', 'pid', 'ppid', 'role', 'startOriginMs', 'version'];
  if (keys.join(',') !== required.join(',')) return { ok: false, reason: 'identity-record-shape-invalid' };
  if (record.version !== IDENTITY_RECORD_VERSION) return { ok: false, reason: 'identity-record-shape-invalid' };
  if (record.role !== role) return { ok: false, reason: 'identity-record-role-mismatch' };
  if (typeof record.nonce !== 'string' || !HEX_64.test(record.nonce)) return { ok: false, reason: 'identity-record-shape-invalid' };
  if (typeof record.entryRealpath !== 'string' || record.entryRealpath.length === 0 || !isAbsolute(record.entryRealpath)) {
    return { ok: false, reason: 'identity-record-shape-invalid' };
  }
  if (!Number.isSafeInteger(record.pid) || /** @type {number} */ (record.pid) <= 0) return { ok: false, reason: 'identity-record-shape-invalid' };
  if (!Number.isSafeInteger(record.ppid) || /** @type {number} */ (record.ppid) <= 0) return { ok: false, reason: 'identity-record-shape-invalid' };
  if (!Number.isSafeInteger(record.firstWriteEpochMs) || /** @type {number} */ (record.firstWriteEpochMs) <= 0) {
    return { ok: false, reason: 'identity-record-shape-invalid' };
  }
  // The PRECISE generation instants (record v2): the process's own
  // sub-millisecond start and its precise write instant. A null pair (an
  // embedder without performance.timeOrigin) is admitted but the duty join
  // names the generation binding unavailable — never guessed.
  for (const field of ['startOriginMs', 'firstWritePreciseMs']) {
    const value = /** @type {any} */ (record)[field];
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
      return { ok: false, reason: 'identity-record-shape-invalid' };
    }
  }
  if (record.startOriginMs !== null && record.firstWritePreciseMs !== null
    && /** @type {number} */ (record.firstWritePreciseMs) < /** @type {number} */ (record.startOriginMs)) {
    return { ok: false, reason: 'identity-record-shape-invalid' };
  }
  if (role === 'invocation') {
    if (!Array.isArray(record.argv) || record.argv.length !== TERMINAL_ARGV_SELECTOR.length
      || TERMINAL_ARGV_SELECTOR.some((segment, index) => /** @type {unknown[]} */ (record.argv)[index] !== segment)) {
      return { ok: false, reason: 'identity-record-shape-invalid' };
    }
  } else if (typeof record.configRealpathSha256 !== 'string' || !HEX_64.test(record.configRealpathSha256)) {
    return { ok: false, reason: 'identity-record-shape-invalid' };
  }
  return {
    ok: true,
    identity: {
      role,
      nonce: /** @type {string} */ (record.nonce),
      entryRealpath: /** @type {string} */ (record.entryRealpath),
      ...(role === 'invocation'
        ? { argv: /** @type {string[]} */ (record.argv) }
        : { configRealpathSha256: /** @type {string} */ (record.configRealpathSha256) }),
      pid: /** @type {number} */ (record.pid),
      ppid: /** @type {number} */ (record.ppid),
      firstWriteEpochMs: /** @type {number} */ (record.firstWriteEpochMs),
      startOriginMs: /** @type {number | null} */ (record.startOriginMs),
      firstWritePreciseMs: /** @type {number | null} */ (record.firstWritePreciseMs),
    },
  };
}

/**
 * Admit one startup identity record from a fixture-owned capture directory,
 * bound to the fixture nonce and role. Purely offline; performs NO writes.
 * The admission is its OWN evidence class (§25.4 item 8): it never routes
 * through the stdout-capture admission, and a missing exit meta never blocks
 * it. A missing record is the named missing fact — never "never launched",
 * never launch readiness, never death.
 * @param {{
 *   captureDirectory: string,
 *   nonce: string,
 *   role?: IdentityRole,
 *   expectedEntryRealpath?: string,
 *   nowEpochMs?: number | (() => number),
 *   readRecordFile?: (root: string, path: string, maximumBytes: number) => Promise<unknown>,
 * }} input
 * @returns {Promise<StartupIdentityAdmission>}
 */
export async function admitStartupIdentityRecord(input) {
  if (!isPlainObject(input)) throw invalidLocalProcessInput('the startup identity admission input must be an object.');
  const { captureDirectory, nonce } = input;
  if (typeof captureDirectory !== 'string' || captureDirectory.length === 0 || !isAbsolute(captureDirectory)) {
    throw invalidLocalProcessInput('the capture directory must be an absolute path.');
  }
  validateCaptureNonce(nonce, 'capture');
  const role = input.role ?? 'invocation';
  if (!IDENTITY_ROLES.includes(role)) throw invalidLocalProcessInput('the identity role must be invocation or broker-daemon.');
  const expectedEntry = input.expectedEntryRealpath;
  if (expectedEntry !== undefined && (typeof expectedEntry !== 'string' || expectedEntry.length === 0 || !isAbsolute(expectedEntry))) {
    throw invalidLocalProcessInput('the expected entry realpath must be an absolute path.');
  }
  const sampleStampMs = completionClock(input.nowEpochMs);
  const readStartedEpochMs = sampleStampMs();
  if (input.readRecordFile !== undefined && typeof input.readRecordFile !== 'function') {
    throw invalidLocalProcessInput('the record read seam must be a function.');
  }
  const suffix = role === 'broker-daemon' ? BROKER_IDENTITY_SUFFIX : INVOCATION_IDENTITY_SUFFIX;
  const recordPath = join(captureDirectory, `${nonce}${suffix}`);
  const recordStats = await lstat(recordPath).catch((error) => {
    // ENOENT is the named missing fact; every OTHER inspection failure (an
    // unsearchable ancestor's EACCES/EPERM, I/O errors) converts into the
    // named unreadable verdict — the observation operation NEVER rejects,
    // and never fabricates an identity from a failed inspection.
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') return null;
    return 'unreadable';
  });
  // The COMPLETION instant is sampled per path, only after ALL awaited
  // evidence work on that path has finished — the lstat-only paths after the
  // lstat, every READ path only after the bounded record read and its
  // integrity checks. A record created during the awaits can never be
  // reported as observed before its own creation, and a read completing
  // after a cutoff carries a post-cutoff timestamp.
  const sampleCompletion = () => sampleStampMs();
  if (recordStats === 'unreadable') {
    return identityAdmissionVerdict('invalid', 'identity-record-unreadable', sampleCompletion(), readStartedEpochMs);
  }
  if (recordStats === null) return identityAdmissionVerdict('missing', 'identity-record-missing', sampleCompletion(), readStartedEpochMs);
  if (recordStats.isSymbolicLink() || !recordStats.isFile()) {
    return identityAdmissionVerdict('invalid', 'identity-record-not-regular', sampleCompletion(), readStartedEpochMs);
  }
  if (recordStats.size > IDENTITY_RECORD_MAX_BYTES) {
    return identityAdmissionVerdict('invalid', 'identity-record-oversize', sampleCompletion(), readStartedEpochMs);
  }
  const readRecordFile = input.readRecordFile
    ?? (async (root, path, maximumBytes) => (await loadMaterializedHelperModules()).readBoundedJsonFile(root, path, maximumBytes, { requirePrivatePermissions: true }));
  /** @param {unknown} error @returns {boolean} */
  const isTornJson = (error) => error instanceof SyntaxError;
  let record;
  let readError = null;
  try {
    record = await readRecordFile(captureDirectory, recordPath, IDENTITY_RECORD_MAX_BYTES);
  } catch (error) {
    readError = error;
  }
  const readEpochMs = sampleCompletion();
  if (readError !== null) {
    return identityAdmissionVerdict('invalid', isTornJson(readError) ? 'identity-record-torn' : 'identity-record-unreadable', readEpochMs, readStartedEpochMs);
  }
  const shape = validateIdentityRecord(record, role);
  if (!shape.ok) return identityAdmissionVerdict('invalid', shape.reason, readEpochMs, readStartedEpochMs);
  // The record is bound to the QUERIED fixture nonce (a foreign scope's
  // record never attests this scope — the nonce binds scope, not identity).
  if (shape.identity.nonce !== nonce) {
    return identityAdmissionVerdict('invalid', 'identity-record-nonce-mismatch', readEpochMs, readStartedEpochMs);
  }
  if (expectedEntry !== undefined && shape.identity.entryRealpath !== expectedEntry) {
    return identityAdmissionVerdict('invalid', 'entry-realpath-mismatch', readEpochMs, readStartedEpochMs);
  }
  return {
    localProcessObservationVersion: LOCAL_PROCESS_OBSERVATION_VERSION,
    class: 'startup-identity',
    status: 'established',
    reason: null,
    identity: shape.identity,
    readStartedEpochMs,
    readEpochMs,
  };
}

// ---------------------------------------------------------------------------
// The preregistered route-(b) SAME-SECOND ANCESTRY WITNESS (evidence-completion
// Task 3; report §26.6/§26.7): the CAPTURE-TIME causal record the fixture-owned
// PARENT writes at ITS OWN spawn boundary — the ingress double-read of the
// spawned child plus the writer's own OS-verified self-identity, both sampled
// inside the writer's live presence — and its read-side admission. The record
// binds kernel-assigned facts only (pid/ppid, ps start identities, env-verified
// nonces, the writer's own instants); it never attests another process or
// scope, and a revived record can never be "played back" by a hand-edited
// boolean: the join recomputes every binding from the positively captured
// endpoints, and OS coarse intervals stay coarse (a precise write is never
// relabeled a precise birth instant).
// ---------------------------------------------------------------------------

/** Role-selected spawn-witness file suffixes (exactly the identity-record pattern). */
export const SPAWN_ANCESTRY_WITNESS_SUFFIXES = Object.freeze({
  invocation: '.spawn-witness.json',
  'broker-daemon': '.spawn-witness-broker.json',
});

/** The closed version of the spawn-witness record. v2 (codex-review round 5,
 * 2026-11-04) adds the `childOsStartInstantMs` member — the witnessed child's
 * numeric OS start instant derived from the SAME captured boundary start
 * identity (the owning persisted-shape version event, §26.7 item 2); retained
 * v1 records replay under their recorded version and never upgrade the marker
 * path (a record without the member cannot bind the marker's generation). */
export const SPAWN_ANCESTRY_WITNESS_VERSION = 2;

/** The witness record's closed bounded size (like every fixture-owned JSON). */
export const SPAWN_ANCESTRY_WITNESS_MAX_BYTES = 4 * 1024;

/**
 * The closed spawn-witness record facts (file identity, writer identity and
 * capture identities in one bounded shape). v2 adds `childOsStartInstantMs`:
 * the witnessed child's numeric OS start instant, derived at capture from the
 * SAME start identity the boundary double read verified (darwin: the
 * field-explicit UTC parse of the captured lstart text — no new OS query;
 * Linux: the module's existing cached boot-clock resolution). Null is the
 * named-absent fact (an unresolvable parse never guesses), and the join's
 * marker binding consumes it so the transport hop's marker upgrade carries
 * positive generation evidence.
 * @typedef {{
 *   version: number,
 *   class: 'spawn-ancestry-witness',
 *   role: IdentityRole,
 *   nonce: string,
 *   writerPid: number,
 *   writerStartIdentity: string,
 *   childPid: number,
 *   childPpid: number,
 *   childStartIdentity: string,
 *   childNonce: string,
 *   boundaryEpochMs: number,
 *   firstWriteEpochMs: number,
 *   startOriginMs: number | null,
 *   firstWritePreciseMs: number | null,
 *   childOsStartInstantMs?: number | null,
 * }} SpawnAncestryWitnessIdentity
 */

/** One spawn-witness admission/emit verdict (the same verdict categories as every other fixture-owned file). @typedef {{
 *   localProcessObservationVersion: number,
 *   class: 'spawn-ancestry-witness',
 *   status: 'established' | 'missing' | 'invalid' | 'unestablished',
 *   reason: string | null,
 *   identity: SpawnAncestryWitnessIdentity | null,
 *   readStartedEpochMs?: number,
 *   readEpochMs?: number,
 * }} SpawnAncestryWitnessVerdict
 */

/** @param {SpawnAncestryWitnessVerdict['status']} status @param {string | null} reason @param {{ identity?: SpawnAncestryWitnessIdentity | null, readStartedEpochMs?: number, readEpochMs?: number }} [extra] @returns {SpawnAncestryWitnessVerdict} */
function spawnWitnessVerdict(status, reason, extra = {}) {
  return {
    localProcessObservationVersion: LOCAL_PROCESS_OBSERVATION_VERSION,
    class: 'spawn-ancestry-witness',
    status,
    reason,
    identity: extra.identity ?? null,
    ...(extra.readStartedEpochMs === undefined ? {} : { readStartedEpochMs: extra.readStartedEpochMs }),
    ...(extra.readEpochMs === undefined ? {} : { readEpochMs: extra.readEpochMs }),
  };
}

/**
 * Validate the closed spawn-witness record contract. Returns the typed
 * identity or the named shape-violation reason.
 * @param {unknown} record @returns {{ ok: true, identity: SpawnAncestryWitnessIdentity } | { ok: false, reason: string }}
 */
function validateSpawnWitnessRecord(record) {
  if (!isPlainObject(record)) return { ok: false, reason: 'spawn-witness-shape-invalid' };
  const keys = Object.keys(record).sort();
  // Versioned replay (§26.7 item 2): each record replays under its RECORDED
  // closed shape. v1 records (without the numeric child OS start instant)
  // keep their recorded semantics; the join consumes the member's ABSENCE as
  // a named-unbound marker generation (never an upgrade). v2 records carry
  // the member (number or named-absent null). Any other version is foreign.
  const v1Required = ['boundaryEpochMs', 'childNonce', 'childPid', 'childPpid', 'childStartIdentity', 'class', 'firstWriteEpochMs', 'firstWritePreciseMs', 'nonce', 'role', 'startOriginMs', 'version', 'writerPid', 'writerStartIdentity'];
  const v2Required = ['boundaryEpochMs', 'childNonce', 'childOsStartInstantMs', 'childPid', 'childPpid', 'childStartIdentity', 'class', 'firstWriteEpochMs', 'firstWritePreciseMs', 'nonce', 'role', 'startOriginMs', 'version', 'writerPid', 'writerStartIdentity'];
  const required = record.version === 1 ? v1Required : record.version === SPAWN_ANCESTRY_WITNESS_VERSION ? v2Required : null;
  if (required === null || keys.join(',') !== required.join(',')) return { ok: false, reason: 'spawn-witness-shape-invalid' };
  if (record.class !== 'spawn-ancestry-witness') return { ok: false, reason: 'spawn-witness-shape-invalid' };
  if (record.version !== 1 && record.version !== SPAWN_ANCESTRY_WITNESS_VERSION) return { ok: false, reason: 'spawn-witness-shape-invalid' };
  // The v2 numeric child OS start instant: a positive epoch millisecond, or
  // the named-absent null (an unresolvable parse is recorded AS absent — the
  // join's marker binding refuses rather than guessing, §26.7 item 3/5).
  if (record.version === SPAWN_ANCESTRY_WITNESS_VERSION
    && record.childOsStartInstantMs !== null
    && (!Number.isSafeInteger(record.childOsStartInstantMs) || /** @type {number} */ (record.childOsStartInstantMs) <= 0)) {
    return { ok: false, reason: 'spawn-witness-shape-invalid' };
  }
  // (codex round 25 — RECORD SELF-CONSISTENCY) the child cannot have been
  // OBSERVED (the boundary capture) before its earliest possible creation:
  // a childOsStartInstantMs STRICTLY postdating the record's own
  // boundaryEpochMs is a physically contradictory record. Equality stays
  // allowed (a child born in the same millisecond as its capture is fine —
  // the module's tie convention). The admission label follows the
  // established self-contradiction style (spawn-witness-write-before-
  // capture — the writer-side sibling): spawn-witness-child-start-after-
  // capture, never folded into the shape label.
  if (record.version === SPAWN_ANCESTRY_WITNESS_VERSION
    && record.childOsStartInstantMs !== null
    && Number.isSafeInteger(record.childOsStartInstantMs)
    && Number.isSafeInteger(record.boundaryEpochMs)
    && /** @type {number} */ (record.childOsStartInstantMs) > /** @type {number} */ (record.boundaryEpochMs)) {
    return { ok: false, reason: 'spawn-witness-child-start-after-capture' };
  }
  if (!IDENTITY_ROLES.includes(/** @type {any} */ (record).role)) return { ok: false, reason: 'spawn-witness-role-invalid' };
  if (typeof record.nonce !== 'string' || !HEX_64.test(record.nonce)) return { ok: false, reason: 'spawn-witness-shape-invalid' };
  if (typeof record.childNonce !== 'string' || !HEX_64.test(record.childNonce)) return { ok: false, reason: 'spawn-witness-shape-invalid' };
  for (const field of ['writerStartIdentity', 'childStartIdentity']) {
    const value = /** @type {any} */ (record)[field];
    if (typeof value !== 'string' || value.length === 0 || value.length > 256) return { ok: false, reason: 'spawn-witness-shape-invalid' };
  }
  for (const field of ['writerPid', 'childPid', 'childPpid', 'boundaryEpochMs', 'firstWriteEpochMs']) {
    const value = /** @type {any} */ (record)[field];
    if (!Number.isSafeInteger(value) || /** @type {number} */ (value) <= 0) return { ok: false, reason: 'spawn-witness-shape-invalid' };
  }
  // The writer's own orderings: the boundary stamp follows the verified reads
  // and the write follows the boundary stamp (the writer's own synchronous
  // order); the precise instants keep the identity-record discipline (a null
  // pair is admitted and named unavailable downstream; write >= start).
  if (!Number.isSafeInteger(record.boundaryEpochMs)) return { ok: false, reason: 'spawn-witness-shape-invalid' };
  if (/** @type {number} */ (record.firstWriteEpochMs) < /** @type {number} */ (record.boundaryEpochMs)) {
    return { ok: false, reason: 'spawn-witness-write-before-capture' };
  }
  for (const field of ['startOriginMs', 'firstWritePreciseMs']) {
    const value = /** @type {any} */ (record)[field];
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
      return { ok: false, reason: 'spawn-witness-shape-invalid' };
    }
  }
  if (record.startOriginMs !== null && record.firstWritePreciseMs !== null
    && /** @type {number} */ (record.firstWritePreciseMs) < /** @type {number} */ (record.startOriginMs)) {
    return { ok: false, reason: 'spawn-witness-write-before-capture' };
  }
  return {
    ok: true,
    identity: {
      version: /** @type {number} */ (record.version),
      class: 'spawn-ancestry-witness',
      role: /** @type {IdentityRole} */ (record.role),
      nonce: /** @type {string} */ (record.nonce),
      writerPid: /** @type {number} */ (record.writerPid),
      writerStartIdentity: /** @type {string} */ (record.writerStartIdentity),
      childPid: /** @type {number} */ (record.childPid),
      childPpid: /** @type {number} */ (record.childPpid),
      childStartIdentity: /** @type {string} */ (record.childStartIdentity),
      childNonce: /** @type {string} */ (record.childNonce),
      boundaryEpochMs: /** @type {number} */ (record.boundaryEpochMs),
      firstWriteEpochMs: /** @type {number} */ (record.firstWriteEpochMs),
      startOriginMs: /** @type {number | null} */ (record.startOriginMs),
      firstWritePreciseMs: /** @type {number | null} */ (record.firstWritePreciseMs),
      // v1 replay records keep the member genuinely ABSENT (the join's marker
      // binding reads the absence as a named-unbound generation); v2 records
      // carry the number or the named-absent null.
      ...(record.childOsStartInstantMs === undefined ? {} : { childOsStartInstantMs: /** @type {number | null} */ (record.childOsStartInstantMs) }),
    },
  };
}

/**
 * Emit the spawn-boundary causal witness FROM INSIDE the fixture-owned parent:
 * at its own real spawn boundary the parent OS-verifies the spawned child (the
 * race-safe environment-nonce double read, with a bounded visibility poll for
 * the kernel's fork/exposure window) and verifies its own live identity, then
 * writes ONE private identity-scoped record. No startup choreography changes,
 * no added delay beyond the child's own kernel exposure, no stop authority.
 * @param {{
 *   captureDirectory: string,
 *   nonce: string,
 *   role: IdentityRole,
 *   childPid: number,
 *   childNonce: string,
 *   childNonceVariable?: string,
 *   nowEpochMs?: number,
 *   osSeams?: { platform?: string, ps?: (pid: number) => Promise<{ pid: number, ppid: number, lstart: string }>, environ?: 'present' | 'mismatch' | 'gone', runProcess?: osSeamsRunProcess },
 *   linuxClock?: { statText?: string, clkTick?: string, clock?: { btimeMs: number, hz: number } },
 * }} input
 * @returns {Promise<SpawnAncestryWitnessVerdict>}
 */
export async function emitSpawnAncestryWitness(input) {
  if (!isPlainObject(input)) throw invalidLocalProcessInput('the spawn witness emit input must be an object.');
  const { captureDirectory, nonce, childPid, childNonce } = input;
  if (typeof captureDirectory !== 'string' || captureDirectory.length === 0 || !isAbsolute(captureDirectory)) {
    throw invalidLocalProcessInput('the capture directory must be an absolute path.');
  }
  validateCaptureNonce(nonce, 'capture');
  const role = input.role ?? 'invocation';
  if (!IDENTITY_ROLES.includes(role)) throw invalidLocalProcessInput('the identity role must be invocation or broker-daemon.');
  if (!Number.isSafeInteger(childPid) || /** @type {number} */ (childPid) <= 0) {
    throw invalidLocalProcessInput('the spawned child pid must be a positive integer.');
  }
  validateCaptureNonce(childNonce, 'child');
  // The writer's own OS-verified identity at the boundary (the creator):
  // the same double-read the capture machinery trusts, addressed at the
  // WRITER'S own pid. A failed writer verification (this process does not
  // carry the capture env) is a NAMED unestablished fact — never a thrown
  // error and never a fabricated witness (§26.7 item 5's no-fold rule).
  let writerVerified;
  try {
    writerVerified = await inspectVerifiedProcessIdentity(process.pid, nonce, CAPTURE_NONCE_VARIABLE, input.osSeams);
  } catch {
    return spawnWitnessVerdict('unestablished', 'spawn-witness-writer-unverifiable');
  }
  if (writerVerified === undefined) {
    return spawnWitnessVerdict('unestablished', 'spawn-witness-writer-unverifiable');
  }
  // The child's ingress observation at the boundary: the kernel's own
  // fork/exposure window means the child may not be visible to `ps` for its
  // first instants, so the read polls under a BOUNDED budget (never a delay
  // added solely to cross a second boundary — typical children appear within
  // milliseconds and return immediately). A VISIBLE child that does not
  // carry the declared child nonce is a live contradiction of the declared
  // scope; because the same window may briefly expose the child before its
  // exec/export completes, the contradiction is retried inside the SAME
  // bounded poll and only the budget-expired outcome names it
  // ('spawn-witness-child-nonce-mismatch') — the §26.7 item-5 fresh label,
  // never folded into the plain unverifiable class.
  const readStartedEpochMs = Date.now();
  /** @type {Awaited<ReturnType<typeof inspectVerifiedProcessIdentity>> | undefined} */
  let childVerified = undefined;
  let childNonceContradiction = false;
  // (codex rounds 4–5 — the §26.6 generation invariant, RETAIN-AND-COMPARE
  // over a POLL-SCOPED retained-observation set that NEVER resets between
  // attempts) EVERY observation of the child's start identity is RETAINED for
  // the whole poll lifetime — successful inspections AND every post-observation
  // failure's error-carried `observedStartIdentity` (the inspector's uniform
  // ride: the observed-then-gone, nonce-verification, mid-double-read,
  // ppid-reparenting, window-closed AND ordinary-I/O classes all carry the
  // first-read identity after a read verified an occupant) — and ANY later
  // observation contradicting ANY retained observation latches the terminal
  // refusal, regardless of which error class carried the earlier observation:
  // an attempt that OBSERVED V1 and then errored is positive identity
  // evidence, never a torn read, and retrying after it would let a subsequent
  // successful read of the REPLACEMENT occupant (same pid, new start
  // identity, same scope nonce) witness the successor as the originally
  // spawned child (§26.6: changing a generation refuses; a replaced process
  // is never credited by later evidence). Only attempts that never saw an
  // identity (the benign not-yet-visible undefined return — which retains
  // nothing and resets NOTHING) stay benign-retriable inside the SAME bounded
  // poll, and the pre-exec nonce-exposure window (a visible child briefly
  // lacking the declared nonce) stays named only at budget expiry. A
  // WITHIN-attempt disagreement (the inspector's own mid-double-read identity
  // change, its message carrying 'identity changed') is already two
  // observations contradicting each other and latches immediately.
  const retainedChildIdentities = new Set();
  let childGenerationChanged = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      childVerified = await inspectVerifiedProcessIdentity(/** @type {number} */ (childPid), childNonce, input.childNonceVariable ?? CAPTURE_NONCE_VARIABLE, input.osSeams);
    } catch (inspectionError) {
      if (inspectionError instanceof Error && /identity changed/u.test(inspectionError.message)) {
        childGenerationChanged = true;
        break;
      }
      const observedIdentity = inspectionError instanceof Error ? (/** @type {any} */ (inspectionError)).observedStartIdentity : undefined;
      if (typeof observedIdentity === 'string' && observedIdentity.length > 0) {
        if (retainedChildIdentities.size > 0 && !retainedChildIdentities.has(observedIdentity)) {
          childGenerationChanged = true;
          break;
        }
        retainedChildIdentities.add(observedIdentity);
      }
      // (codex round 19) the contradiction flag ONLY for an actual nonce
      // VERIFICATION failure — a seen child whose nonce contradicted the
      // expectation (the inspector's own canonical failure class). Ordinary
      // OS-query errors and torn reads never inspected the environment:
      // budget expiry with only such failures keeps the honest
      // `spawn-witness-child-unverifiable` label rather than asserting
      // unsupported scope-mismatch evidence. A mixed history (one real
      // nonce-verification failure among failures) still sets the flag —
      // the real contradiction is never downgraded.
      if (inspectionError instanceof Error
        && /nonce identity verification failed/u.test(inspectionError.message)) {
        childNonceContradiction = true;
      }
    }
    if (childVerified !== undefined) {
      if (retainedChildIdentities.size > 0 && !retainedChildIdentities.has(childVerified.startIdentity)) {
        childGenerationChanged = true;
        break;
      }
      retainedChildIdentities.add(childVerified.startIdentity);
      break;
    }
    // The poll timer is INTENTIONALLY ref'd: the poll is the emitter's own
    // awaited work (bounded at 12 attempts), and an unref'd timer would let
    // an otherwise-idle writer loop drain before the next attempt — leaving
    // the caller's await unsettled. The bound (never a delay added solely to
    // cross a second boundary) is the attempt budget, not the timer state.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (childGenerationChanged) {
    // The latched terminal refusal (the §26.7 item-5 fresh-label discipline):
    // never folded into the budget-expiry classes, never followed by a write.
    return spawnWitnessVerdict('unestablished', 'spawn-witness-child-generation-changed', { readStartedEpochMs, readEpochMs: Date.now() });
  }
  if (childVerified === undefined) {
    return spawnWitnessVerdict('unestablished', childNonceContradiction ? 'spawn-witness-child-nonce-mismatch' : 'spawn-witness-child-unverifiable', { readStartedEpochMs, readEpochMs: Date.now() });
  }
  // (codex rounds 5–6 — the CAPTURE-AND-BIND design with the GUARDED
  // RESOLVER) The witnessed child's NUMERIC OS start instant, derived from
  // the SAME start identity the boundary double read just verified — never a
  // new OS query pattern: darwin resolves the captured lstart text with the
  // module's field-explicit UTC parse (a pure derivation of the
  // already-captured evidence), Linux resolves the captured proc ticks
  // against the module's existing cached boot-clock seam (the same resolution
  // observeLocalProcess performs — and GUARDS the same way: a resolution
  // FAILURE, e.g. a masked or unreadable /proc/stat on Linux arriving AFTER
  // the identity verified, is caught here and preserved as the documented
  // nullable named-absent null, never an escaped exception; the caller
  // receives the established witness verdict with its other positive
  // bindings intact, and the join's marker binding treats the absence as an
  // unbindable marker generation and refuses — absent facts stay absent,
  // §26.7 item 3/5).
  // (codex round 9 — TIMESTAMP PROVENANCE) The child-alive instant is
  // sampled IMMEDIATELY when the ingress double read completes — BEFORE the
  // boot-clock resolution await — and IS the record's boundary capture
  // instant. A stalling resolution (a masked or slow /proc/stat on Linux)
  // must never advance the capture instant: the continuity proof is
  // "the witnessed child was alive at the boundary", and a boundary sampled
  // AFTER an unrelated clock-resolution await would claim survival the
  // child observation never witnessed (a same-tick pid replacement sharing
  // the proc: start identity could ride that fabricated survival into an
  // established verdict). The WRITE instants below stay sampled at the
  // actual write (the writer's own act, provably after the capture).
  // (codex round 11, the completion of this provenance rule) the capture
  // instant is the FINAL OS INSPECTION'S OWN TAKEN instant — surfaced by
  // the inspector from before its last identity read was dispatched —
  // never a Date.now() sampled at the inspection's response arrival: the
  // reviewer's sequence (both snapshots observe the original at 1100, the
  // original dies at 1200, a same-second reuse is born at 1400, the
  // response arrives 2100) would otherwise record a boundary (2100) that
  // "proves" survival the child observation never witnessed. Defensive
  // fallback only for a legacy seam that surfaces no taken instant.
  const childCaptureEpochMs = Number.isSafeInteger(childVerified.takenEpochMs)
    ? /** @type {number} */ (childVerified.takenEpochMs)
    : Date.now();
  let childOsStartInstantMs = null;
  try {
    childOsStartInstantMs = await resolveObservationStartInstantMs(childVerified.startIdentity, {
      linuxClock: input.linuxClock,
      osSeams: { platform: input.osSeams?.platform },
    });
  } catch {
    childOsStartInstantMs = null;
  }
  const boundaryEpochMs = childCaptureEpochMs;
  const startOriginMs = (typeof performance === 'object' && performance !== null
    && typeof performance.timeOrigin === 'number' && Number.isFinite(performance.timeOrigin))
    ? performance.timeOrigin
    : null;
  const firstWritePreciseMs = startOriginMs === null ? null : startOriginMs + performance.now();
  const firstWriteEpochMs = Date.now();
  /** @type {SpawnAncestryWitnessIdentity} */
  const payload = {
    version: SPAWN_ANCESTRY_WITNESS_VERSION,
    class: 'spawn-ancestry-witness',
    role,
    nonce,
    writerPid: process.pid,
    writerStartIdentity: writerVerified.startIdentity,
    childPid: childVerified.pid,
    childPpid: childVerified.ppid,
    childStartIdentity: childVerified.startIdentity,
    childNonce,
    boundaryEpochMs,
    firstWriteEpochMs,
    startOriginMs,
    firstWritePreciseMs,
    childOsStartInstantMs,
  };
  // One witness per scope and boundary role: created exclusively (wx); a
  // failed write is a NAMED fact, never a fabricated witness.
  try {
    writeFileSync(join(captureDirectory, `${nonce}${SPAWN_ANCESTRY_WITNESS_SUFFIXES[/** @type {IdentityRole} */ (role)]}`), `${JSON.stringify(payload)}\n`, { mode: 0o600, flag: 'wx' });
  } catch {
    return spawnWitnessVerdict('unestablished', 'spawn-witness-write-failed');
  }
  return spawnWitnessVerdict('established', null, { identity: payload, readStartedEpochMs, readEpochMs: Date.now() });
}

/**
 * Admit one spawned-boundary witness record from a fixture-owned capture
 * directory, bound to the fixture nonce and boundary role. Purely offline;
 * performs NO writes. The admission is its OWN evidence class: a missing,
 * non-regular, oversize, unreadable, torn, shape-invalid, foreign-nonce or
 * role-mismatched record is a NAMED fact that exposes no identity and is
 * never folded into a launch/liveness/absent claim.
 * @param {{
 *   captureDirectory: string,
 *   nonce: string,
 *   role?: IdentityRole,
 *   nowEpochMs?: number | (() => number),
 *   readRecordFile?: (root: string, path: string, maximumBytes: number) => Promise<unknown>,
 * }} input
 * @returns {Promise<SpawnAncestryWitnessVerdict>}
 */
export async function admitSpawnAncestryWitness(input) {
  if (!isPlainObject(input)) throw invalidLocalProcessInput('the spawn witness admission input must be an object.');
  const { captureDirectory, nonce } = input;
  if (typeof captureDirectory !== 'string' || captureDirectory.length === 0 || !isAbsolute(captureDirectory)) {
    throw invalidLocalProcessInput('the capture directory must be an absolute path.');
  }
  validateCaptureNonce(nonce, 'capture');
  const role = input.role ?? 'invocation';
  if (!IDENTITY_ROLES.includes(role)) throw invalidLocalProcessInput('the identity role must be invocation or broker-daemon.');
  const stampMs = completionClock(input.nowEpochMs);
  const readStartedEpochMs = stampMs();
  if (input.readRecordFile !== undefined && typeof input.readRecordFile !== 'function') {
    throw invalidLocalProcessInput('the record read seam must be a function.');
  }
  const recordPath = join(captureDirectory, `${nonce}${SPAWN_ANCESTRY_WITNESS_SUFFIXES[/** @type {IdentityRole} */ (role)]}`);
  const recordStats = await lstat(recordPath).catch((error) => {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') return null;
    return 'unreadable';
  });
  const sampleCompletion = () => stampMs();
  if (recordStats === 'unreadable') {
    return spawnWitnessVerdict('invalid', 'spawn-witness-unreadable', { readStartedEpochMs, readEpochMs: sampleCompletion() });
  }
  if (recordStats === null) {
    return spawnWitnessVerdict('missing', 'spawn-witness-missing', { readStartedEpochMs, readEpochMs: sampleCompletion() });
  }
  if (recordStats.isSymbolicLink() || !recordStats.isFile()) {
    return spawnWitnessVerdict('invalid', 'spawn-witness-not-regular', { readStartedEpochMs, readEpochMs: sampleCompletion() });
  }
  if (recordStats.size > SPAWN_ANCESTRY_WITNESS_MAX_BYTES) {
    return spawnWitnessVerdict('invalid', 'spawn-witness-oversize', { readStartedEpochMs, readEpochMs: sampleCompletion() });
  }
  const readRecordFile = input.readRecordFile
    ?? (async (root, path, maximumBytes) => (await loadMaterializedHelperModules()).readBoundedJsonFile(root, path, maximumBytes, { requirePrivatePermissions: true }));
  /** @param {unknown} error @returns {boolean} */
  const isTornJson = (error) => error instanceof SyntaxError;
  let record;
  let readError = null;
  try {
    record = await readRecordFile(captureDirectory, recordPath, SPAWN_ANCESTRY_WITNESS_MAX_BYTES);
  } catch (error) {
    readError = error;
  }
  const readEpochMs = sampleCompletion();
  if (readError !== null) {
    return spawnWitnessVerdict('invalid', isTornJson(readError) ? 'spawn-witness-torn' : 'spawn-witness-unreadable', { readStartedEpochMs, readEpochMs });
  }
  const shape = validateSpawnWitnessRecord(record);
  if (!shape.ok) return spawnWitnessVerdict('invalid', shape.reason, { readStartedEpochMs, readEpochMs });
  // The witness is bound to the QUERIED fixture scope nonce (a foreign
  // scope's witness never attests this scope), and to the QUERIED boundary
  // role (a daemon-boundary record can never ride the invocation hop).
  if (shape.identity.nonce !== nonce) {
    return spawnWitnessVerdict('invalid', 'spawn-witness-nonce-mismatch', { readStartedEpochMs, readEpochMs });
  }
  if (shape.identity.role !== role) {
    return spawnWitnessVerdict('invalid', 'spawn-witness-role-mismatch', { readStartedEpochMs, readEpochMs });
  }
  return spawnWitnessVerdict('established', null, { identity: shape.identity, readStartedEpochMs, readEpochMs });
}

// ---------------------------------------------------------------------------
// OS-verified live observation and the exit/absence adjudication (§25.4
// items 4/5/6). The reads reuse the fixture's race-safe double-read (PID +
// OS start identity + environment-nonce verification) bound to the CAPTURE
// nonce variable; every read failure is a NAMED unestablished fact.
// ---------------------------------------------------------------------------

/**
 * One OS-side observation verdict. `established` exposes the verified
 * process facts; `absent` is the positive OS absence fact (the process does
 * not exist); `unestablished` is a named observation failure that is never
 * folded into either. An established verdict also carries
 * `identityReadEpochMs` — the instant the IDENTITY reads (the double-read
 * and its nonce verification) completed, sampled BEFORE the awaited
 * start-instant resolution: the identity evidence's own validity horizon.
 * A nonce-failure verdict whose first read OBSERVED a start identity
 * carries it as `observedStartIdentity` for the exit adjudicator.
 * @typedef {{
 *   localProcessObservationVersion: number,
 *   class: 'os-live-observation',
 *   status: 'established' | 'absent' | 'unestablished',
 *   reason: string | null,
 *   observation: { pid: number, ppid: number, startIdentity: string, nonce: string, startInstantEpochMs: number | null, ppidChangedFromCapture: boolean | null } | null,
 *   queried: { pid: number, nonce: string },
 *   readStartedEpochMs: number,
 *   identityReadEpochMs?: number,
 *   observedStartIdentity?: string,
 *   observedIdentityReadEpochMs?: number,
 *   observedIdentityCompletedEpochMs?: number,
 *   readEpochMs: number,
 *   absenceConfirmed: boolean | null,
 * }} LocalProcessObservation
 */

/** @param {LocalProcessObservation['status']} status @param {string | null} reason @param {number} readEpochMs @param {{ pid: number, nonce: string }} queried @param {number} readStartedEpochMs @param {boolean | null} [absenceConfirmed] @returns {LocalProcessObservation} */
function observationVerdict(status, reason, readEpochMs, queried, readStartedEpochMs, absenceConfirmed) {
  return {
    localProcessObservationVersion: LOCAL_PROCESS_OBSERVATION_VERSION,
    class: 'os-live-observation',
    status,
    reason,
    observation: null,
    // WHO was queried rides EVERY verdict: an absence or failure verdict is
    // evidence about exactly this queried identity and nothing else.
    queried,
    // The honest observation interval: started when the read begins,
    // `readEpochMs` sampled only AFTER the whole asynchronous inspection
    // (the fixture double-read performs several OS reads) — a disappearance
    // timestamp can never predate the read that produced it.
    readStartedEpochMs,
    readEpochMs,
    // Positive absence rides its confirmation basis: `true` only when the OS
    // confirmed no such process; `null` when an injected seam owns the
    // absence semantics or the verdict is not an absence at all.
    absenceConfirmed: absenceConfirmed ?? null,
  };
}

/** @param {unknown} value @returns {value is (pid: number, nonce: string) => Promise<any>} */
function isInspectFunction(value) {
  return typeof value === 'function';
}

/**
 * The DEFAULT OS absence confirmation: an inspection that returned no
 * process is positively CONFIRMED only when the OS itself reports an
 * error-free no-match — on macOS exit 1 with empty stdout AND empty stderr
 * (a failed query carries stderr diagnostics); on Linux the exact ENOENT.
 * Any OTHER outcome (a usage/permission/limit diagnostic, an unexpected exit
 * code, a process that appeared mid-confirmation) is `unconfirmed` — the caller
 * names the read unestablished instead of manufacturing disappearance.
 * Injected inspection seams never run this (their absence semantics are
 * their own).
 * @param {number} pid
 * @param {(launch: { command: string, args: string[] }, options?: { timeoutMs?: number, maxOutputBytes?: number, env?: Record<string, string | undefined> }) => Promise<{ code: number | null, stdout: string, stderr: string }>} [runProcessSeam]
 * @param {{ platform?: string, readFile?: (path: string, encoding: string) => Promise<string> }} [seams]
 * @returns {Promise<'absent' | 'unconfirmed'>}
 */
export async function confirmProcessAbsenceWithOs(pid, runProcessSeam, seams = {}) {
  // The platform and filesystem seams are INJECTABLE so every test exercises
  // its pinned branch independently of the host OS — a Linux CI runner runs
  // the registered suite through exactly the same code paths.
  const platform = seams.platform ?? process.platform;
  const readFileSeam = seams.readFile ?? readFile;
  const run = runProcessSeam ?? (async (launch, options) => (await loadMaterializedHelperModules()).runProcess(launch, options));
  if (platform === 'linux') {
    try {
      await readFileSeam(`/proc/${pid}/stat`, 'utf8');
      return 'unconfirmed';
    } catch (error) {
      return /** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT' ? 'absent' : 'unconfirmed';
    }
  }
  let result;
  try {
    // ROUND-32: pinned env — no identity query is left to the ambient locale.
    result = await run({ command: 'ps', args: ['-o', 'pid=', '-p', String(pid)] }, { timeoutMs: 2_000, maxOutputBytes: 4 * 1024, env: psIdentitySpawnEnv() });
  } catch {
    return 'unconfirmed';
  }
  if (result.code === 0 && result.stdout.trim()) return 'unconfirmed';
  // The error-free no-match on this platform: exit 1 with EMPTY stdout AND
  // empty stderr — a failed query (unknown option, oversized pid, permission
  // diagnostic) carries stderr text and is never a confirmation.
  if (result.code === 1 && !result.stdout.trim() && !result.stderr.trim()) return 'absent';
  return 'unconfirmed';
}

/**
 * The documented Linux generation window: the record's precise start
 * (performance.timeOrigin) must lie within this distance of the resolved
 * /proc creation instant (btime + starttime ticks / CLK_TCK, ~10ms
 * precision). The window covers the fork→Node-initialization delay (small
 * on idle hosts, bounded on loaded runners) and is a NAMED residual — a
 * successor whose creation falls outside the window is refused, and the
 * window itself is never guessed away.
 */
/**
 * The WHOLE-SECOND btime uncertainty (review round 12): /proc/stat btime has
 * second granularity, so the boot's fractional-second offset is lost and the
 * TRUE creation instant of a proc-ticks identity lies in
 * [computed, computed + 1000 ms) — this subsumes the old fork-to-init
 * window: a candidate whose whole uncertainty window precedes the write
 * binds, and the uncertainty itself names same-second writes ambiguous. The
 * documented /proc resolution bound for same-instant comparisons is
 * `LINUX_PROC_RESOLUTION_MS`.
 */
export const LINUX_BTIME_UNCERTAINTY_MS = 1000;

/**
 * The documented /proc creation-instant resolution bound (~10ms: starttime
 * ticks at CLK_TCK granularity): a creation instant only this far after the
 * record's write cannot be distinguished from the writer's own — named
 * `generation-start-ambiguous`, never established-by-default.
 */
export const LINUX_PROC_RESOLUTION_MS = 10;

/** The cached Linux boot clock ({ btimeMs, hz }); resolved once per process. @type {{ btimeMs: number, hz: number } | null} */
let linuxBootClockCache = null;

/**
 * Resolve the Linux boot clock: btime (epoch seconds of boot) from
 * /proc/stat and the kernel CLK_TCK via `getconf` (defaulting to 100).
 * @param {{ statText?: string, clkTick?: string, clock?: { btimeMs: number, hz: number } }} [deps]
 * @returns {Promise<{ btimeMs: number, hz: number } | null>}
 */
async function resolveLinuxBootClock(deps = {}) {
  if (deps.clock !== undefined) return await deps.clock;
  if (linuxBootClockCache) return linuxBootClockCache;
  const statText = deps.statText !== undefined ? deps.statText : await readFile('/proc/stat', 'utf8');
  const btimeMatch = /^btime (\d+)$/mu.exec(statText);
  if (!btimeMatch) return null;
  let hz = 100;
  try {
    const clkTick = deps.clkTick !== undefined
      ? deps.clkTick
      : (await (await loadMaterializedHelperModules()).runProcess({ command: 'getconf', args: ['CLK_TCK'] }, { timeoutMs: 2_000, maxOutputBytes: 1_024 })).stdout.trim();
    if (/^\d+$/u.test(clkTick) && Number(clkTick) > 0) hz = Number(clkTick);
  } catch {
    // The documented default kernel userspace HZ.
    hz = 100;
  }
  linuxBootClockCache = { btimeMs: Number(btimeMatch[1]) * 1000, hz };
  return linuxBootClockCache;
}

/** The ps lstart month abbreviations, rendered in the C locale by `ps`. */
const LSTART_MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/**
 * Parse one `ps lstart` timestamp as UTC (review round 31): the real reader
 * requests `TZ=UTC ps` so the rendered fields are UTC, and this parse is
 * FIELD-EXPLICIT UTC — never the host-local Date.parse interpretation,
 * which during a DST fall-back hour picks the earlier occurrence of the
 * repeated local hour and skews a genuine process by one hour. Shape:
 * 'Www Mmm dd hh:mm:ss yyyy' (whitespace-collapsed); any other shape is a
 * named-null start instant (never a guessed value).
 * @param {string} startIdentity @returns {number | null}
 */
function parseLstartAsUtc(startIdentity) {
  // The global collapse matters: single-digit days render with a DOUBLE
  // space ('Sun Nov  2 ...') and a first-match-only replace left it in.
  // Groups: 1 month, 2 day, 3 hh, 4 mm, 5 ss, 6 year (the weekday is not
  // captured).
  const match = /^\w{3} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/u.exec(startIdentity.replace(/\s+/gu, ' ').trim());
  if (!match) return null;
  const instant = Date.UTC(Number(match[6]), LSTART_MONTHS[/** @type {keyof typeof LSTART_MONTHS} */ (match[1])], Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]));
  return Number.isSafeInteger(instant) ? instant : null;
}

/**
 * Resolve the OS start identity to a wall-clock creation instant for the
 * generation binding: a startup record can only have been written by a
 * process that ALREADY existed, so an observed process whose creation is
 * AFTER the record's write instant is a PID-reusing successor, never the
 * writer. Darwin: the fixture's pinned ctime-form `lstart` (whole-second,
 * rendered in UTC by the reader and parsed field-explicit UTC). Linux: the
 * proc starttime ticks resolved against the boot clock (btime + ticks /
 * CLK_TCK, ~10ms precision — a REAL creation binding, not a null
 * placeholder).
 * @param {string} startIdentity
 * @param {{ linuxClock?: { statText?: string, clkTick?: string, clock?: { btimeMs: number, hz: number } }, osSeams?: { platform?: string } }} [deps]
 * @returns {Promise<number | null>}
 */
async function resolveObservationStartInstantMs(startIdentity, deps = {}) {
  const linuxTicks = /^proc:(\d+)$/u.exec(startIdentity);
  if (linuxTicks) {
    const bootClock = await resolveLinuxBootClock(deps?.linuxClock ?? {});
    if (!bootClock) return null;
    return bootClock.btimeMs + Math.round((Number(linuxTicks[1]) / bootClock.hz) * 1000);
  }
  // ROUND-32: the platform is the INJECTED seam platform when present (the
  // observation's own platform identity — consistent with the inspector's
  // seam discipline), never silently the host: a darwin-seamed observation
  // resolves its lstart on any host, and the registered suite cannot break
  // on a Linux runner.
  if ((deps.osSeams?.platform ?? process.platform) === 'linux') return null;
  // ROUND-31: field-explicit UTC (see parseLstartAsUtc) — never the
  // host-local Date.parse interpretation.
  return parseLstartAsUtc(startIdentity);
}

/**
 * One OS-side verified liveness read of a captured identity. The default
 * inspection seam is the fixture's race-safe double-read
 * (`inspectVerifiedProcessIdentity`) bound to the CAPTURE nonce variable;
 * synthetic identities MUST inject a fake `inspect` (this function is the
 * only OS touchpoint). A read that returns no process is the positive
 * `absent` fact; a thrown read is the named unestablished fact (the fixture
 * helper throws on nonce mismatch and on a mid-double-read identity change,
 * classified here as `identity-changed-during-read`; every other throw is a
 * `liveness-read-failed`). A changed parent never invalidates the
 * observation — reparenting is recorded, never treated as death.
 * @param {{
 *   pid: number,
 *   nonce: string,
 *   expectedStartIdentity?: string,
 *   capturedPpid?: number,
 *   nowEpochMs?: number | (() => number),
 *   nonceVariable?: string,
 *   abortSignal?: AbortSignal,
 *   inspect?: (pid: number, nonce: string) => Promise<{ pid: number, ppid: number, startIdentity: string, nonce: string } | undefined>,
 *   absenceConfirmation?: (pid: number) => Promise<'absent' | 'unconfirmed'>,
 *   linuxClock?: { statText?: string, clkTick?: string, clock?: { btimeMs: number, hz: number } },
 *   osSeams?: { platform?: string, ps?: (pid: number) => Promise<{ pid: number, ppid: number, lstart: string }>, environ?: 'present' | 'mismatch' | 'gone', runProcess?: osSeamsRunProcess },
 * }} input
 * @returns {Promise<LocalProcessObservation>}
 */
export async function observeLocalProcess(input) {
  if (!isPlainObject(input)) throw invalidLocalProcessInput('the live observation input must be an object.');
  const { pid, nonce } = input;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw invalidLocalProcessInput('the observed pid must be a positive safe integer.');
  validateCaptureNonce(nonce, 'capture');
  if (input.expectedStartIdentity !== undefined && (typeof input.expectedStartIdentity !== 'string' || input.expectedStartIdentity.length === 0)) {
    throw invalidLocalProcessInput('the expected start identity must be a nonempty string.');
  }
  if (input.capturedPpid !== undefined && (!Number.isSafeInteger(input.capturedPpid) || input.capturedPpid <= 0)) {
    throw invalidLocalProcessInput('the captured ppid must be a positive safe integer.');
  }
  const sampleStampMs = completionClock(input.nowEpochMs);
  const readStartedEpochMs = sampleStampMs();
  // Review round 3 (Finding 1): the nonce VARIABLE the default inspector
  // verifies is a caller option — the transport's marker machinery lives in
  // FAKE_ZCODE_PROCESS_NONCE (its independently generated nonce, never the
  // capture scope's variable its inherited environment also carries), while
  // the invocation/broker records verify the capture scope variable.
  if (input.nonceVariable !== undefined && (typeof input.nonceVariable !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(input.nonceVariable))) {
    throw invalidLocalProcessInput('the nonce variable must be an environment variable name.');
  }
  const nonceVariable = input.nonceVariable ?? CAPTURE_NONCE_VARIABLE;
  // (Review round 6, Finding 3) the caller's abort signal is honored
  // BETWEEN reads — here (entry, post-inspection, pre-confirmation,
  // pre-boot-clock) and inside the default inspector (threaded through the
  // osSeams so its double-read never starts a read after the window closed).
  // A started read keeps its own semantics; only the NEXT one is prevented —
  // observation work must not outlive the turn's teardown.
  if (input.abortSignal !== undefined && (typeof input.abortSignal !== 'object' || typeof input.abortSignal.addEventListener !== 'function' || typeof input.abortSignal.aborted !== 'boolean')) {
    throw invalidLocalProcessInput('the abort signal must be an AbortSignal-shaped object.');
  }
  const windowClosed = () => input.abortSignal?.aborted === true;
  const inspectSeams = input.osSeams || input.abortSignal
    ? { ...(input.osSeams ?? {}), ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}) }
    : input.osSeams;
  const inspect = input.inspect ?? ((observedPid, observedNonce) => inspectVerifiedProcessIdentity(observedPid, observedNonce, nonceVariable, inspectSeams));
  if (!isInspectFunction(inspect)) throw invalidLocalProcessInput('the inspection seam must be a function.');
  if (input.absenceConfirmation !== undefined && typeof input.absenceConfirmation !== 'function') {
    throw invalidLocalProcessInput('the absence confirmation seam must be a function.');
  }
  // The real OS inspection requires CONFIRMED absence; an injected seam
  // without an injected confirmation owns its absence semantics (synthetic
  // identities never touch the real OS).
  const confirmAbsence = input.absenceConfirmation ?? (input.inspect === undefined ? confirmProcessAbsenceWithOs : null);
  const queried = { pid, nonce };
  /**
   * The absence outcome for one read that found no process: injected seams
   * own their absence semantics (no OS confirmation); the default path
   * requires the OS confirmation. A REJECTING confirmation seam is a named
   * failure verdict (the completed read interval rides the verdict) —
   * consistent with the inspection-failure handling; the observation never
   * rejects on a supplied-seam failure (class sweep: every supplied seam
   * call site — inspect, confirmAbsence, the boot-clock resolution, the
   * record read — catches its own failures).
   * @returns {Promise<LocalProcessObservation>}
   */
  const absenceOutcome = async () => {
    if (windowClosed()) {
      return observationVerdict('unestablished', 'observation-window-closed', sampleCompletion(), queried, readStartedEpochMs);
    }
    if (confirmAbsence === null) {
      return observationVerdict('absent', 'process-absent', sampleCompletion(), queried, readStartedEpochMs, null);
    }
    let confirmation;
    let confirmationError = null;
    try {
      confirmation = await confirmAbsence(pid);
    } catch (error) {
      confirmationError = error;
    }
    const completedEpochMs = sampleCompletion();
    if (confirmationError !== null) {
      return observationVerdict('unestablished', 'absence-confirmation-failed', completedEpochMs, queried, readStartedEpochMs);
    }
    if (confirmation !== 'absent') {
      return observationVerdict('unestablished', 'absence-unconfirmed', completedEpochMs, queried, readStartedEpochMs);
    }
    return observationVerdict('absent', 'process-absent', completedEpochMs, queried, readStartedEpochMs, true);
  };
  if (windowClosed()) {
    return observationVerdict('unestablished', 'observation-window-closed', sampleStampMs(), queried, readStartedEpochMs);
  }
  let observed;
  let inspectionError = null;
  try {
    observed = await inspect(pid, nonce);
  } catch (error) {
    inspectionError = error;
  }
  // The window closed over the in-flight inspection: the read is torn by
  // the shared window — the NAMED unfinished fact, never the inspection's
  // own classification.
  if (windowClosed()) {
    return observationVerdict('unestablished', 'observation-window-closed', sampleStampMs(), queried, readStartedEpochMs);
  }
  // The COMPLETION instant is sampled per path, only after ALL awaited
  // evidence work on that path has finished (the inspection, and on absence
  // paths the whole OS confirmation) — never a pre-await sample, so no
  // verdict timestamp can predate the work that produced it.
  const sampleCompletion = () => sampleStampMs();
  if (inspectionError !== null) {
    const readEpochMs = sampleCompletion();
    // ROUND-23: an inspector-detected IDENTITY change (a PID reused between
    // the double-read's two start-identity reads) is POSITIVE replacement
    // evidence and keeps its OWN class — the reuse latch consumes it; a
    // reparenting alone (ppid-only divergence) is NOT reuse and stays in the
    // generic torn class (the round-1 rule).
    const identityChanged = inspectionError instanceof Error && /identity changed/u.test(inspectionError.message);
    if (identityChanged) {
      return observationVerdict('unestablished', 'start-identity-generation-changed', readEpochMs, queried, readStartedEpochMs);
    }
    // ROUND-28: the inspector VERIFIED an occupant start identity and the
    // pid vanished before the read completed (marker-gone / absent second
    // read). The observed identity RIDES the failure: a demonstrably
    // different occupant is POSITIVE replacement evidence (the reuse class
    // — the successor's mid-read absence is never the bound generation's
    // disappearance); the verified generation's own mid-read disappearance
    // (or an uncomparable one) keeps the LAWFUL absence flow, with the
    // observed identity attached so the exit adjudicator can still classify
    // it against the bound generation.
    if (inspectionError instanceof Error
      && /** @type {any} */ (inspectionError).observedThenGone === true
      && typeof /** @type {any} */ (inspectionError).observedStartIdentity === 'string') {
      const goneAfterIdentity = /** @type {any} */ (inspectionError).observedStartIdentity;
      if (input.expectedStartIdentity !== undefined && goneAfterIdentity !== input.expectedStartIdentity) {
        return observationVerdict('unestablished', 'start-identity-generation-changed', sampleCompletion(), queried, readStartedEpochMs);
      }
      const absenceVerdict = await absenceOutcome();
      /** @type {any} */ (absenceVerdict).observedStartIdentity = goneAfterIdentity;
      // ROUND-31: the carried identity's evidence instant is the INSPECTION
      // instant — never the later absence-confirmation completion the
      // verdict's readEpochMs carries: an old generation read BEFORE the
      // bound generation's presence must never latch it, and a replacement
      // genuinely read after it still latches (the adjudicator compares this
      // instant). (codex round 13) the inspector now surfaces the identity's
      // OWN taken instant on the error — the failure's completion sample is
      // the fallback only for a legacy error that carries no timing.
      /** @type {any} */ (absenceVerdict).observedIdentityReadEpochMs = Number.isSafeInteger(/** @type {any} */ (inspectionError).observedIdentityTakenEpochMs)
        ? /** @type {any} */ (inspectionError).observedIdentityTakenEpochMs
        : readEpochMs;
      // (codex round 14) the identity's COLLECTION INTERVAL travels as a
      // unit: the upper bound (the first read's resolution) lets the
      // adjudicator distinguish a definitively pre-baseline observation from
      // one whose collection window merely OVERLAPS the baseline.
      if (Number.isSafeInteger(/** @type {any} */ (inspectionError).observedIdentityCompletedEpochMs)) {
        /** @type {any} */ (absenceVerdict).observedIdentityCompletedEpochMs = /** @type {any} */ (inspectionError).observedIdentityCompletedEpochMs;
      }
      return absenceVerdict;
    }
    // ROUND-26: a nonce-verification failure that still exposes an OBSERVED
    // start identity is compared with the expected generation — demonstrably
    // different is POSITIVE replacement evidence (the reuse class, latched
    // downstream); same-generation or unverifiable stays the named nonce
    // failure.
    const observedStartIdentity = /** @type {any} */ (/** @type {any} */ (inspectionError)).observedStartIdentity;
    if (typeof observedStartIdentity === 'string' && input.expectedStartIdentity !== undefined
      && observedStartIdentity !== input.expectedStartIdentity) {
      // (codex round 14) the IDENTITY-MISMATCH promotion consumes the
      // carried observation timing exactly like the generic path (the
      // round-13 rule): the generation-changed evidence is dated at its
      // carried observation interval — lower and upper bounds — never at
      // the failure completion, so a predecessor sampled before the
      // presence baseline whose failure finishes afterward is adjudicated
      // by the interval rule (ambiguous when overlapping; the lawful
      // disappeared outcome when definitively pre-baseline), not promoted
      // into apparent replacement evidence by its late completion.
      const promotedVerdict = observationVerdict('unestablished', 'start-identity-generation-changed', readEpochMs, queried, readStartedEpochMs);
      if (Number.isSafeInteger(/** @type {any} */ (inspectionError).observedIdentityTakenEpochMs)) {
        /** @type {any} */ (promotedVerdict).observedIdentityReadEpochMs = /** @type {any} */ (inspectionError).observedIdentityTakenEpochMs;
        if (Number.isSafeInteger(/** @type {any} */ (inspectionError).observedIdentityCompletedEpochMs)) {
          /** @type {any} */ (promotedVerdict).observedIdentityCompletedEpochMs = /** @type {any} */ (inspectionError).observedIdentityCompletedEpochMs;
        }
      }
      return promotedVerdict;
    }
    // ROUND-27: with the OPTIONAL expectedStartIdentity omitted (or a
    // same-generation identity) the read stays the named nonce failure, but
    // the OBSERVED start identity RIDES the verdict: the exit adjudicator
    // knows the BOUND generation and classifies a demonstrably different
    // carried identity as positive replacement evidence — a nonce-less
    // replacement can never be discarded back into a plain read failure
    // that a later absence converts into the original generation's
    // disappearance.
    const nonceFailureVerdict = observationVerdict('unestablished', 'liveness-read-failed', readEpochMs, queried, readStartedEpochMs);
    if (typeof observedStartIdentity === 'string') {
      /** @type {any} */ (nonceFailureVerdict).observedStartIdentity = observedStartIdentity;
      // (codex round 13 — EVIDENCE TIMING) the carried identity is dated at
      // its OBSERVATION instant (the inspector's first-read taken bound,
      // carried as a unit on the error), never at the failure's completion:
      // a delayed failure carrying a stale identity must not become
      // post-baseline replacement evidence — the adjudicator's
      // presence/recency comparisons consume this instant.
      if (Number.isSafeInteger(/** @type {any} */ (inspectionError).observedIdentityTakenEpochMs)) {
        /** @type {any} */ (nonceFailureVerdict).observedIdentityReadEpochMs = /** @type {any} */ (inspectionError).observedIdentityTakenEpochMs;
        // (codex round 14) the interval's upper bound rides with it.
        if (Number.isSafeInteger(/** @type {any} */ (inspectionError).observedIdentityCompletedEpochMs)) {
          /** @type {any} */ (nonceFailureVerdict).observedIdentityCompletedEpochMs = /** @type {any} */ (inspectionError).observedIdentityCompletedEpochMs;
        }
      }
    }
    return nonceFailureVerdict;
  }
  if (observed === undefined || observed === null) {
    return absenceOutcome();
  }
  if (!isPlainObject(observed) || /** @type {any} */ (observed).pid !== pid
    || !Number.isSafeInteger(/** @type {any} */ (observed).ppid) || /** @type {any} */ (observed).ppid <= 0
    || typeof /** @type {any} */ (observed).startIdentity !== 'string' || /** @type {any} */ (observed).startIdentity.length === 0) {
    return observationVerdict('unestablished', 'liveness-read-failed', sampleCompletion(), queried, readStartedEpochMs);
  }
  // A reused start identity is a DIFFERENT process: never accepted as the
  // captured generation, and its facts are never exposed as ours.
  if (input.expectedStartIdentity !== undefined && /** @type {any} */ (observed).startIdentity !== input.expectedStartIdentity) {
    return observationVerdict('unestablished', 'start-identity-generation-changed', sampleCompletion(), queried, readStartedEpochMs);
  }
  // The inspect seam owns its result: a returned observation carrying a
  // DIFFERENT nonce is foreign-scope evidence and is never relabeled to the
  // requested scope (review round 15).
  if (typeof /** @type {any} */ (observed).nonce !== 'string' || /** @type {any} */ (observed).nonce !== nonce) {
    return observationVerdict('unestablished', 'observation-nonce-mismatch', sampleCompletion(), queried, readStartedEpochMs);
  }
  // The Linux start-instant resolution (boot-clock reads, getconf) is
  // awaited BEFORE the completion sample: the verdict completion covers ALL
  // asynchronous evidence collection, so a verdict completing after a cutoff
  // can never carry a pre-cutoff timestamp (review round 9). A boot-clock
  // read failure is caught into a named null start instant — the observation
  // never rejects on this path, and the duty join names the generation
  // binding unavailable.
  // ROUND-27: the IDENTITY evidence's own completion instant is sampled
  // BEFORE that await — everything the observation later awaits (the
  // boot-clock resolution) contributes NO identity evidence, and a pid+nonce
  // reuser starting DURING those awaits is not observed by them. The
  // generation-continuity gate therefore anchors on THIS instant (the
  // identity reads' validity horizon), never on the whole-observation
  // completion.
  const identityReadEpochMs = sampleCompletion();
  if (windowClosed()) {
    return observationVerdict('unestablished', 'observation-window-closed', sampleCompletion(), queried, readStartedEpochMs);
  }
  let startInstantEpochMs = null;
  try {
    startInstantEpochMs = await resolveObservationStartInstantMs(/** @type {any} */ (observed).startIdentity, input);
  } catch {
    startInstantEpochMs = null;
  }
  const readEpochMs = sampleCompletion();
  return {
    localProcessObservationVersion: LOCAL_PROCESS_OBSERVATION_VERSION,
    class: 'os-live-observation',
    status: 'established',
    reason: null,
    observation: {
      pid,
      ppid: /** @type {any} */ (observed).ppid,
      startIdentity: /** @type {any} */ (observed).startIdentity,
      nonce,
      startInstantEpochMs,
      ppidChangedFromCapture: input.capturedPpid === undefined ? null : /** @type {any} */ (observed).ppid !== input.capturedPpid,
    },
    queried,
    readStartedEpochMs,
    identityReadEpochMs,
    readEpochMs,
    absenceConfirmed: null,
  };
}

// ---------------------------------------------------------------------------
// The exit/absence adjudication (§25.4 item 6): termination of the
// previously established generation = verified presence EARLIER + verified
// absence of the SAME pid and start identity LATER. A reused PID, a failed
// read, a changed parent, and a later same-generation re-observation are
// each their own named fact. The exit meta corroborates a lawful exit ONLY
// on an established disappearance — it never proves death and never covers
// uncatchable termination.
// ---------------------------------------------------------------------------

/**
 * One exit/absence verdict for the bound generation.
 * @typedef {{
 *   localProcessObservationVersion: number,
 *   class: 'exit-absence',
 *   status: 'disappeared' | 'live' | 'unestablished',
 *   reason: string | null,
 *   boundIdentity: { pid: number, startIdentity: string, nonce: string } | null,
 *   lastVerifiedPresenceEpochMs: number | null,
 *   firstVerifiedAbsenceEpochMs: number | null,
 *   exitCorroboratedByMeta: boolean,
 * }} LocalExitAdjudication
 */

/**
 * Adjudicate the exit of the previously established generation from its
 * verified-presence verdict, later same-pid observation reads (ordered by
 * their read instants regardless of list order), and the optional stdout
 * exit-meta admission. Purely offline; performs NO reads or writes itself.
 * @param {{
 *   presence: LocalProcessObservation,
 *   absenceReads: LocalProcessObservation[],
 *   exitMetaAdmission?: { status: string, nonce?: string, role?: string, invocationIdentity?: { pid: number, startIdentity: string, nonce: string } },
 * }} input
 * @returns {LocalExitAdjudication}
 */
export function adjudicateLocalExit(input) {
  if (!isPlainObject(input)) throw invalidLocalProcessInput('the exit adjudication input must be an object.');
  if (!Array.isArray(input.absenceReads)) throw invalidLocalProcessInput('the absence reads must be a list of os-live-observation verdicts.');
  const { presence } = input;
  if (!isPlainObject(presence) || /** @type {any} */ (presence).class !== 'os-live-observation') {
    throw invalidLocalProcessInput('the presence must be an os-live-observation verdict.');
  }
  for (const read of input.absenceReads) {
    const queried = isPlainObject(read) ? /** @type {any} */ (read).queried : undefined;
    if (!isPlainObject(read) || /** @type {any} */ (read).class !== 'os-live-observation'
      || !Number.isSafeInteger(/** @type {any} */ (read).readEpochMs) || /** @type {any} */ (read).readEpochMs <= 0
      || !isPlainObject(queried) || !Number.isSafeInteger(/** @type {any} */ (queried).pid) || /** @type {any} */ (queried).pid <= 0
      || typeof /** @type {any} */ (queried).nonce !== 'string' || !HEX_64.test(/** @type {any} */ (queried).nonce)) {
      throw invalidLocalProcessInput('each absence read must be an os-live-observation verdict with its queried identity and a positive read epoch.');
    }
  }
  const exitMetaAdmission = input.exitMetaAdmission;
  const metaIdentity = isPlainObject(exitMetaAdmission) ? exitMetaAdmission.invocationIdentity : undefined;
  if (exitMetaAdmission !== undefined && (!isPlainObject(exitMetaAdmission) || typeof exitMetaAdmission.status !== 'string'
    || (exitMetaAdmission.nonce !== undefined && (typeof exitMetaAdmission.nonce !== 'string' || !HEX_64.test(exitMetaAdmission.nonce)))
    || (metaIdentity !== undefined && (!isPlainObject(metaIdentity) || !Number.isSafeInteger(metaIdentity.pid) || metaIdentity.pid <= 0
      || typeof metaIdentity.startIdentity !== 'string' || metaIdentity.startIdentity.length === 0
      || typeof metaIdentity.nonce !== 'string' || !HEX_64.test(metaIdentity.nonce))))) {
    throw invalidLocalProcessInput('the exit meta admission must carry a closed status, a 64-hex scope binding and a well-formed invocation identity.');
  }
  /**
   * @param {string} reason
   * @returns {LocalExitAdjudication}
   */
  function unestablished(reason) {
    return {
      localProcessObservationVersion: LOCAL_PROCESS_OBSERVATION_VERSION,
      class: 'exit-absence',
      status: 'unestablished',
      reason,
      boundIdentity: null,
      lastVerifiedPresenceEpochMs: null,
      firstVerifiedAbsenceEpochMs: null,
      exitCorroboratedByMeta: false,
    };
  }
  if (presence.status !== 'established' || !isPlainObject(presence.observation)) {
    return unestablished('presence-unestablished');
  }
  const bound = presence.observation;
  // BASELINE VALIDATION (review round 21): disappearance requires a VERIFIED
  // presence instant and a BOUND generation. An established-tagged baseline
  // without a real read instant (recency comparisons against undefined never
  // reject) or without an OS start identity (no generation to bind) is
  // named-unestablished before boundIdentity exists.
  if (!Number.isSafeInteger(bound.pid) || bound.pid <= 0
    || typeof bound.startIdentity !== 'string' || bound.startIdentity.length === 0
    || typeof bound.nonce !== 'string' || !HEX_64.test(bound.nonce)
    || !Number.isSafeInteger(presence.readEpochMs)) {
    return unestablished(!Number.isSafeInteger(presence.readEpochMs)
      ? 'presence-instant-unverified'
      : 'presence-generation-unverified');
  }
  const boundIdentity = { pid: bound.pid, startIdentity: bound.startIdentity, nonce: bound.nonce };
  // The last decisive same-pid read in epoch order decides; unestablished
  // reads never decide anything (they only name the layer unestablished).
  // Millisecond ties are legitimate: at one instant an ABSENT read is
  // ordered BEFORE a verified live read, so a tie resolves conservatively —
  // live survives, and mere rearrangement of the same evidence can never
  // manufacture disappearance.
  const decisionRank = (/** @type {any} */ read) => (read.status === 'established' ? 1 : read.status === 'absent' ? 0 : 2);
  // ROUND-28: IDENTITY evidence (verified presence and replacement
  // detection) orders by the IDENTITY-READ instant — the whole-observation
  // completion can be pushed later by asynchronous work that contributes no
  // identity evidence (the Linux boot-clock resolution), and ordering by it
  // discards a replacement observed inside that window. Absence evidence
  // keeps the whole-observation completion: an absence is proven at its
  // confirmation, the collection-cutoff instant. Reads without the carried
  // instant (pre-round-28 hand-built facts) fall back to their completion.
  const identityEvidenceEpochMs = (/** @type {any} */ read) => (Number.isSafeInteger(read.identityReadEpochMs) ? read.identityReadEpochMs : read.readEpochMs);
  // ROUND-31: the carried identity's own evidence instant — when that
  // identity was actually READ (the inspection), never the later
  // absence-confirmation completion the verdict's completion may carry.
  // Reads without the carried instant fall back to their identity evidence
  // instant (the nonce-mismatch rides complete at their own readEpochMs).
  const carriedIdentityEpochMs = (/** @type {any} */ read) => (Number.isSafeInteger(read.observedIdentityReadEpochMs)
    ? read.observedIdentityReadEpochMs
    : identityEvidenceEpochMs(read));
  // (codex round 14 — the COLLECTION-INTERVAL rule) a carried identity whose
  // collection INTERVAL straddles the presence baseline is AMBIGUOUS
  // evidence: the snapshot may show the predecessor (collected before the
  // baseline) or a replacement (collected after it), and neither reading is
  // provable. Only a collection that COMPLETED at or before the baseline is
  // definitively stale (old evidence, never latching), and only a collection
  // that STARTED at or after the baseline is definitively post-baseline
  // (positive replacement evidence). Reads without an explicit interval are
  // definitive instants (the legacy fixtures' recorded read instants) — the
  // legacy behavior is preserved exactly.
  // (codex round 17 — INTERVAL-TO-INTERVAL) the replacement's collection
  // interval classifies against the PRESENCE HORIZON'S OWN collection
  // interval — the dispatch lower bound (`readStartedEpochMs`) and the
  // identity-read completion upper bound (`lastPresenceEpochMs`, the same
  // unit the ride carries) — never against either side's completion alone:
  // a completion instant cannot prove that the presence was COLLECTED after
  // the replacement. Stale requires the replacement's collection to have
  // completed STRICTLY BEFORE the presence's dispatch (the presence provably
  // cannot have seen it); post-baseline requires the replacement's
  // collection to have started at/after the presence's completion
  // (tie-inclusive — the presence provably finished first); everything else
  // OVERLAPS the presence's collection window and is the ambiguous fact.
  // Reads without an interval upper bound stay LEGACY (the round-15/16
  // carried-instant recency guard applies); a presence without a dispatch
  // bound keeps the round-16 instant rules.
  const carriedIdentityIntervalClass = (/** @type {any} */ read) => {
    // (codex round 23 — THREE-STATE BOUND RESOLUTION) the bounds resolve
    // into THREE states, never two: ABSENT (undefined/null — the genuine
    // legacy shape; the round-15/16 instant rules apply unchanged),
    // SUPPLIED VALID (a positive safe integer — the interval classification
    // applies), and SUPPLIED INVALID (present but not a positive safe
    // integer — a string, a float, NaN, a non-positive value: an epoch-ms
    // collection instant is positive by definition) — MALFORMED EVIDENCE
    // that refuses pid-start-identity-interval-inconsistent, never silently
    // downgraded to absent, never stale-discarded. Positive plausibility is
    // part of supplied-valid (an epoch instant is positive; 0/negative is
    // garbage). Runtime and replay resolve identically (the frozen
    // replay-agreement clause).
    const boundAbsent = (/** @type {any} */ v) => v === undefined || v === null;
    const boundSuppliedValid = (/** @type {any} */ v) => Number.isSafeInteger(v) && /** @type {number} */ (v) > 0;
    const readBound = read.observedIdentityReadEpochMs;
    const completedBound = read.observedIdentityCompletedEpochMs;
    if (!boundAbsent(readBound) && !boundSuppliedValid(readBound)) return 'inconsistent';
    if (boundAbsent(completedBound)) return 'legacy';
    if (!boundSuppliedValid(completedBound)) return 'inconsistent';
    const lower = carriedIdentityEpochMs(read);
    const upper = /** @type {number} */ (completedBound);
    // (codex round 20 — INPUT VALIDATION) the interval must be WELL-FORMED
    // before any classification may DISCARD evidence: ORDERED — the carried
    // identity's taken instant must not follow its completion (a
    // backwards-moving or garbage clock yields an inverted interval). An
    // interval failing the check is INCONSISTENT EVIDENCE: the stale/discard
    // path is FORBIDDEN for malformed input — the consumers refuse by name
    // (`pid-start-identity-interval-inconsistent`), never disappeared,
    // never reused. Well-formed intervals classify exactly as the
    // round-17→19 rules already do. (Adjudicated: the PLAUSIBLE containment
    // check — the interval within the carrying verdict's
    // [readStartedEpochMs, readEpochMs] window — is REJECTED as unsound:
    // the inspector's taken/resolved instants ride the inspector's own real
    // clock while the verdict's read stamps can ride a synthetic
    // `nowEpochMs` clock, so a cross-domain containment comparison is an
    // implicit clock join (§26.7 item 4 forbids) and falsely condemns real
    // evidence in the synthetic-clock fixtures — demonstrated by the
    // standing nonce-mismatch pins failing under it. The order check is
    // same-domain (both bounds sampled by the inspector's own clock) and
    // sound; the reviewer's inverted schedule [3500, 500] is caught by it.)
    const ordered = Number.isSafeInteger(lower) && lower <= upper;
    if (!ordered) return 'inconsistent';
    if (lastPresenceStartedEpochMs === null) {
      return upper < lastPresenceEpochMs ? 'stale' : 'post';
    }
    if (upper < lastPresenceStartedEpochMs) return 'stale';
    if (lower >= lastPresenceEpochMs) return 'post';
    return 'overlap';
  };
  // ROUND-29: reads order by their DECISION instant — identity-bearing reads
  // by the identity-READ instant, absences by their confirmation completion —
  // the same instants the recency checks below consume. Sorting by the
  // whole-observation completion let a stale-presence completion (identity
  // reads long finished, the clock resolution still running) outrank a later
  // confirmed absence.
  // ROUND-33: a read CARRYING an observed identity (observedIdentityRead-
  // EpochMs) is IDENTITY-BEARING for ordering — its decision instant is the
  // carried identity's own read instant, never the later confirmation
  // completion that a delayed absence confirmation puts on readEpochMs.
  // Completion-order processing let a later-arriving same-generation read
  // advance the presence horizon past an earlier-READ replacement, erasing
  // it as old evidence; the decision sequence must order by decision
  // instant so evidence ORDER never decides.
  const orderingEpochMs = (/** @type {any} */ read) => (Number.isSafeInteger(read.observedIdentityReadEpochMs)
    ? read.observedIdentityReadEpochMs
    : read.status === 'absent'
      ? read.readEpochMs
      : identityEvidenceEpochMs(read));
  const ordered = [...input.absenceReads].sort((left, right) =>
    orderingEpochMs(left) - orderingEpochMs(right)
    || decisionRank(left) - decisionRank(right));
  let state = 'unknown';
  let finalAbsenceRunStart = null;
  let sawUnestablished = false;
  // The LATEST verified same-generation survival instant: later verified
  // live reads move it forward, so both live and disappeared verdicts report
  // when this generation was LAST seen, never just its first capture.
  let lastPresenceEpochMs = identityEvidenceEpochMs(presence);
  // (codex round 17) the horizon's collection START (the dispatch bound):
  // the interval-to-interval staleness comparison consumes BOTH bounds of
  // the presence's collection window, never the completion alone. Null when
  // the presence read carries no dispatch bound (legacy — the round-16
  // instant rules apply).
  let lastPresenceStartedEpochMs = Number.isSafeInteger(presence.readStartedEpochMs)
    ? presence.readStartedEpochMs
    : null;
  // ROUND-20 LATCH: once a generation change is detected in the read
  // sequence (an established read with a different start identity, or a
  // named start-identity-generation-changed read), the refusal is TERMINAL —
  // later reads of the REPLACEMENT generation (its presence or absence) must
  // never convert it into the original generation's disappearance or credit
  // the successor's absence to the original duties.
  let reuseLatched = false;
  for (const read of ordered) {
    const readEpochMs = /** @type {any} */ (read).readEpochMs;
    // (codex round 18 — CLASSIFY FIRST) the interval classification runs
    // BEFORE any completion-instant guard or recency filter: a carried
    // evidence failure's completion instant is metadata about the ERROR,
    // never a filter on the identity's collection interval — query latency
    // must never determine whether replacement evidence is credited,
    // discarded as stale, or named ambiguous. When BOTH sides carry
    // collection bounds, the round-17 interval-to-interval classification
    // EXCLUSIVELY governs (stale / post-baseline latch / overlap-ambiguous);
    // only legacy reads without bounds fall through to the completion-based
    // rules below. The in-loop interval arms further down are retained as
    // unreachable defensive fallbacks for these shapes.
    const earlyQueried = /** @type {any} */ (read).queried;
    const earlySameScope = isPlainObject(earlyQueried) && earlyQueried.pid === bound.pid && earlyQueried.nonce === bound.nonce;
    const earlyIsCarriedReplacement = earlySameScope && read.status === 'unestablished'
      && ((typeof /** @type {any} */ (read).observedStartIdentity === 'string'
        && /** @type {any} */ (read).observedStartIdentity !== bound.startIdentity)
        || read.reason === 'start-identity-generation-changed');
    const earlyIsIdentityBearingAbsence = earlySameScope && read.status === 'absent'
      && typeof /** @type {any} */ (read).observedStartIdentity === 'string'
      && /** @type {any} */ (read).observedStartIdentity !== bound.startIdentity;
    // (codex round 24 — VALIDATE-FIRST extended to the three-state
    // validator) the hoist fires whenever ANY bound is SUPPLIED (present,
    // non-null) — not only when the upper bound is a safe integer: a
    // SUPPLIED-INVALID bound (a string, a float, garbage) must receive the
    // inconsistent refusal BEFORE the completion-time gate and the recency
    // filter can pre-empt it (the reviewer's schedule: a carried failure
    // completing 2000 before the horizon 2100 bypassed the validator and
    // was discarded into a disappeared verdict). A read with NO supplied
    // bound at all (the genuine legacy shape) falls through to the legacy
    // pipeline unchanged.
    const earlyCompletedBound = /** @type {any} */ (read).observedIdentityCompletedEpochMs;
    const earlyReadBound = /** @type {any} */ (read).observedIdentityReadEpochMs;
    const earlyBoundSupplied = (earlyCompletedBound !== undefined && earlyCompletedBound !== null)
      || (earlyReadBound !== undefined && earlyReadBound !== null);
    if ((earlyIsCarriedReplacement || earlyIsIdentityBearingAbsence) && earlyBoundSupplied) {
      const intervalClass = carriedIdentityIntervalClass(read);
      if (intervalClass === 'legacy') {
        // completed ABSENT (the genuine legacy shape — only the lower bound
        // supplied): the completion-based legacy pipeline below governs
        // unchanged (the hoist never touches legacy classification).
      } else if (intervalClass === 'overlap') {
        return { ...unestablished('pid-start-identity-ambiguous'), boundIdentity, lastVerifiedPresenceEpochMs: lastPresenceEpochMs };
      } else if (intervalClass === 'inconsistent') {
        // (codex rounds 20+24) malformed intervals are inconsistent
        // evidence — never classified stale, never discarded, never
        // latched, never pre-empted by a completion guard or the recency
        // filter.
        return { ...unestablished('pid-start-identity-interval-inconsistent'), boundIdentity, lastVerifiedPresenceEpochMs: lastPresenceEpochMs };
      } else if (intervalClass === 'post') {
        state = 'reused';
        reuseLatched = true;
        continue;
      } else {
        // stale: the replacement's collection completed strictly before the
        // presence's own collection started — the presence provably cannot
        // have seen it. Old evidence, non-deciding: the identity-bearing
        // ABSENCE it rides may still admit below (its own collection bounds
        // govern), and a carried-failure read is skipped as old evidence.
        if (earlyIsCarriedReplacement) {
          sawUnestablished = true;
          continue;
        }
        // stale ABSENT-carrying (interval-bearing) evidence falls through
        // to the absence admission below (its own bounds govern).
      }
    }
    // STRICT recency over ALL prior same-generation presence, including the
    // baseline itself (lastPresenceEpochMs starts at the baseline): an
    // absence at or before the last verified presence is a tie with that
    // presence, and a tie can never manufacture disappearance.
    // ROUND-21/22: a generation-change read at the same millisecond as (or
    // after) a same-generation presence read LATCHES the reuse refusal
    // BEFORE the absence-recency filtering — evidence ordering must never
    // decide between the named reuse refusal and A's disappearance. The
    // latch covers BOTH replacement shapes: an ESTABLISHED observation with
    // a different start identity, and a NAMED start-identity-generation-
    // changed verdict (the expectedStartIdentity seam's replacement shape —
    // an established-tagged observation without the expected identity, which
    // sorts by the same epoch and was previously discarded by the recency
    // filter). Replacement evidence BEFORE the presence baseline is an OLD
    // generation: it never latches (round 22).
    if (!reuseLatched && Number.isSafeInteger(readEpochMs) && identityEvidenceEpochMs(read) >= lastPresenceEpochMs) {
      const readQueried = /** @type {any} */ (read).queried;
      const sameScope = isPlainObject(readQueried) && readQueried.pid === bound.pid && readQueried.nonce === bound.nonce;
      let replacementDetected = false;
      let replacementAmbiguous = false;
      if (sameScope && read.status === 'established') {
        const candidate = /** @type {any} */ (read).observation;
        if (isPlainObject(candidate) && candidate.pid === bound.pid
          && candidate.startIdentity !== bound.startIdentity) {
          replacementDetected = true;
        }
      } else if (sameScope && read.status === 'unestablished'
        && read.reason === 'start-identity-generation-changed') {
        // (codex round 14) the promotion's carried interval governs: an
        // interval overlapping the presence baseline is AMBIGUOUS evidence
        // (never definitive replacement), an interval that completed at or
        // before the baseline is definitively stale (old evidence, never
        // latching), and a collection that started at or after the baseline
        // is definitively post-baseline (replacement).
        const intervalClass = carriedIdentityIntervalClass(read);
        if (intervalClass === 'overlap') {
          replacementAmbiguous = true;
        } else if (intervalClass === 'inconsistent') {
          // (codex round 20) malformed intervals refuse by name — never
          // classified stale, never discarded.
          return { ...unestablished('pid-start-identity-interval-inconsistent'), boundIdentity, lastVerifiedPresenceEpochMs: lastPresenceEpochMs };
        } else if (intervalClass === 'post') {
          // (codex rounds 16–17) TIE-INCLUSIVE at the post-baseline edge:
          // an interval starting at/after the presence horizon's completion
          // (equality included) is definitively post-baseline.
          replacementDetected = true;
        } else if (intervalClass === 'legacy'
          && carriedIdentityEpochMs(read) >= lastPresenceEpochMs) {
          replacementDetected = true;
        }
        // stale (completed strictly before the presence's collection start)
        // is old evidence — never latching.
      } else if (sameScope && read.status === 'unestablished'
        && typeof /** @type {any} */ (read).observedStartIdentity === 'string'
        && /** @type {any} */ (read).observedStartIdentity !== bound.startIdentity) {
        // ROUND-27/30/31 (codex round 14 interval-aware): a read CARRYING an
        // observed start identity that differs from the BOUND generation is
        // positive replacement evidence INDEPENDENTLY of its named failure
        // class (the nonce-failure ride and the observed-then-gone
        // confirmation failures alike), evaluated at the CARRIED identity's
        // own collection interval: definitively post-baseline latches, an
        // interval overlapping the presence baseline is the AMBIGUOUS fact,
        // and a definitively stale interval (collection completed at or
        // before the baseline) is old evidence that never latches.
        const intervalClass = carriedIdentityIntervalClass(read);
        if (intervalClass === 'overlap') {
          replacementAmbiguous = true;
        } else if (intervalClass === 'inconsistent') {
          // (codex round 20) malformed intervals refuse by name — never
          // classified stale, never discarded.
          return { ...unestablished('pid-start-identity-interval-inconsistent'), boundIdentity, lastVerifiedPresenceEpochMs: lastPresenceEpochMs };
        } else if (intervalClass === 'post') {
          // (codex rounds 16–17) TIE-INCLUSIVE at the post-baseline edge: a
          // collection starting at/after the presence horizon's completion
          // (equality included) is definitively post-baseline — the latch
          // fires here, so the later recency filter never discards it into
          // a disappearance.
          replacementDetected = true;
        } else if (intervalClass === 'legacy'
          && carriedIdentityEpochMs(read) >= lastPresenceEpochMs) {
          // (codex round 15) the LEGACY arm keeps its carried-instant recency
          // guard: without an interval upper bound the carried instant is a
          // definitive read instant, so only a definitively POST-baseline
          // carried identity latches — a stale identity observed before the
          // baseline never does.
          replacementDetected = true;
        }
        // stale (completed strictly before the presence's collection start)
        // is old evidence — never latching.
      }
      if (replacementDetected) {
        state = 'reused';
        reuseLatched = true;
        continue;
      }
      if (replacementAmbiguous) {
        // (codex round 14) an overlapping collection interval is never
        // resolved into either definitive reading: the pid's occupant
        // generation at the baseline is not provable, so the lawful
        // outcome is the named ambiguous fact — never `disappeared` (a
        // replacement may have held the pid) and never
        // `pid-start-identity-reused` (the predecessor may never have
        // left).
        return { ...unestablished('pid-start-identity-ambiguous'), boundIdentity, lastVerifiedPresenceEpochMs: lastPresenceEpochMs };
      }
    }
    // Recency filter (round-28 instants): ABSENCE evidence is the
    // whole-observation completion; every identity-bearing read (established
    // or unestablished) is evidence at its identity-READ instant — a read
    // whose identity evidence is not after the last verified presence never
    // decides.
    const evidenceEpochMs = read.status === 'absent' ? readEpochMs : identityEvidenceEpochMs(read);
    if (evidenceEpochMs <= lastPresenceEpochMs) continue;
    // A read is evidence about the identity it QUERIED, nothing else: a read
    // that queried another PID or another scope nonce is foreign evidence and
    // never decides this generation's fate (no absence, no reuse, no failure).
    const queried = /** @type {any} */ (read).queried;
    if (queried.pid !== bound.pid || queried.nonce !== bound.nonce) continue;
    if (reuseLatched) continue;
    if (read.status === 'established') {
      const observation = /** @type {any} */ (read).observation;
      if (!isPlainObject(observation) || observation.pid !== bound.pid) continue;
      if (observation.startIdentity === bound.startIdentity) {
        state = 'live';
        lastPresenceEpochMs = identityEvidenceEpochMs(read);
        // (codex round 17) the horizon's collection start advances with it.
        if (Number.isSafeInteger(read.readStartedEpochMs)) {
          lastPresenceStartedEpochMs = read.readStartedEpochMs;
        }
      } else {
        state = 'reused';
        reuseLatched = true;
      }
      continue;
    }
    if (read.status === 'absent') {
      // ROUND-29/31: an absent verdict CARRYING an observed start identity
      // (the round-28 observed-then-gone ride) is absence evidence about
      // whoever the first read VERIFIED: a demonstrably different carried
      // identity is positive replacement evidence — the successor's mid-read
      // absence is never the bound generation's death, and the reuse refusal
      // latches BEFORE any absence is admitted — evaluated at the CARRIED
      // identity's own inspection instant, never the later confirmation
      // completion: an old generation read before the baseline's presence
      // never latches it, and the (later-confirmed) absence admits as the
      // baseline's lawful disappearance. Carried-equal (or no carried
      // identity) admits the absence normally.
      const carriedIdentity = /** @type {any} */ (read).observedStartIdentity;
      if (typeof carriedIdentity === 'string' && carriedIdentity !== bound.startIdentity) {
        // (codex rounds 15+17) the interval classification applies to
        // IDENTITY-BEARING ABSENT verdicts exactly like the unestablished
        // ones, INTERVAL-TO-INTERVAL: a collection window OVERLAPPING the
        // presence horizon's own collection window is the ambiguous fact —
        // the occupant generation at the horizon is not provable, so
        // disappearance never establishes on ambiguous generation evidence;
        // a collection that completed STRICTLY before the horizon's
        // collection start is definitively stale (the absence admits
        // normally); a collection that started at or after the horizon's
        // completion (tie-inclusive) latches the reuse (the successor's
        // mid-read absence is never the bound generation's death).
        const absentIntervalClass = carriedIdentityIntervalClass(read);
        if (absentIntervalClass === 'overlap') {
          return { ...unestablished('pid-start-identity-ambiguous'), boundIdentity, lastVerifiedPresenceEpochMs: lastPresenceEpochMs };
        }
        if (absentIntervalClass === 'inconsistent') {
          return { ...unestablished('pid-start-identity-interval-inconsistent'), boundIdentity, lastVerifiedPresenceEpochMs: lastPresenceEpochMs };
        }
        if (absentIntervalClass === 'post'
          || (absentIntervalClass === 'legacy' && carriedIdentityEpochMs(read) >= lastPresenceEpochMs)) {
          state = 'reused';
          reuseLatched = true;
          continue;
        }
        // definitively stale: the absence admits normally below.
      }
      // ROUND-36: an absence whose COLLECTION overlaps the presence
      // evidence (its read START predates the presence evidence's
      // identity-read instant) proves nothing about the state after the
      // presence — completion timestamps bound collection latency, not
      // snapshot ordering. Named-unconfirmed for the decision: never
      // admitted as disappearance, never deciding (reads without a sampled
      // start — pre-round-3 hand-built facts — keep the legacy
      // completion-only semantics).
      if (Number.isSafeInteger(read.readStartedEpochMs) && read.readStartedEpochMs < lastPresenceEpochMs) {
        sawUnestablished = true;
        continue;
      }
      // ROUND-34: overlapping same-generation disappearance reads can
      // confirm OUT of completion order — identity-time ordering sorts the
      // carried instants while the confirmations complete independently —
      // so the first verified absence instant of the run is the EARLIEST
      // confirmed completion, never whichever admission happened to arrive
      // first in decision order (a pre-cutoff absence must never be
      // reported post-cutoff).
      if (state !== 'absent' || finalAbsenceRunStart === null) finalAbsenceRunStart = readEpochMs;
      else finalAbsenceRunStart = Math.min(finalAbsenceRunStart, readEpochMs);
      state = 'absent';
      continue;
    }
    // A named generation-changed read IS positive reuse evidence: the OS
    // read SUCCEEDED and positively found a live process with a different
    // start identity holding this pid — a DIFFERENT process, never our
    // generation's death. Every other unestablished read never decides.
    if (read.reason === 'start-identity-generation-changed') {
      // (codex round 14) interval-aware: a promoted generation-changed read
      // whose collection interval overlaps the presence horizon is the
      // ambiguous fact, never definitive reuse; one whose collection
      // completed at or before the horizon is definitively stale and never
      // decides. Without an interval the legacy behavior stands.
      if (Number.isSafeInteger(read.observedIdentityCompletedEpochMs)) {
        const intervalClass = carriedIdentityIntervalClass(read);
        if (intervalClass === 'overlap') {
          return { ...unestablished('pid-start-identity-ambiguous'), boundIdentity, lastVerifiedPresenceEpochMs: lastPresenceEpochMs };
        }
        if (intervalClass === 'inconsistent') {
          return { ...unestablished('pid-start-identity-interval-inconsistent'), boundIdentity, lastVerifiedPresenceEpochMs: lastPresenceEpochMs };
        }
        // (codex rounds 16–17) only a collection completing STRICTLY before
        // the presence horizon's own collection START is definitively stale
        // (the presence provably cannot have seen it); ties and any overlap
        // classify above.
        if (intervalClass === 'stale') continue;
      }
      state = 'reused';
      reuseLatched = true;
      continue;
    }
    // ROUND-27/30/31: a read CARRYING an observed start identity demonstrably
    // different from the BOUND generation is positive replacement evidence
    // INDEPENDENTLY of its named failure class (the optional-expectedStart-
    // Identity nonce-failure shape and the observed-then-gone confirmation
    // failures alike — the observation layer could not compare, the bound
    // generation can), evaluated at the CARRIED identity's own inspection
    // instant: an old generation read before the baseline's presence never
    // latches it. A carried identity EQUAL to the bound one is the
    // same-generation failure and stays a non-deciding unestablished fact.
    if (typeof /** @type {any} */ (read).observedStartIdentity === 'string'
      && /** @type {any} */ (read).observedStartIdentity !== bound.startIdentity) {
      // (codex round 14) interval-aware: overlapping collection intervals
      // are the ambiguous fact; definitively stale intervals never decide;
      // definitively post-baseline collections latch.
      if (Number.isSafeInteger(read.observedIdentityCompletedEpochMs)) {
        const intervalClass = carriedIdentityIntervalClass(read);
        if (intervalClass === 'overlap') {
          return { ...unestablished('pid-start-identity-ambiguous'), boundIdentity, lastVerifiedPresenceEpochMs: lastPresenceEpochMs };
        }
        if (intervalClass === 'inconsistent') {
          return { ...unestablished('pid-start-identity-interval-inconsistent'), boundIdentity, lastVerifiedPresenceEpochMs: lastPresenceEpochMs };
        }
        // (codex rounds 16–17) only a collection completing STRICTLY before
        // the presence horizon's own collection START is definitively stale
        // (the presence provably cannot have seen it) — completion alone
        // never proves ordering; ties and any overlap classify above.
        if (intervalClass === 'stale') {
          sawUnestablished = true;
          continue;
        }
      }
      if (carriedIdentityEpochMs(read) >= lastPresenceEpochMs) {
        state = 'reused';
        reuseLatched = true;
        continue;
      }
    }
    sawUnestablished = true;
  }
  if (state === 'reused') return { ...unestablished('pid-start-identity-reused'), boundIdentity, lastVerifiedPresenceEpochMs: lastPresenceEpochMs };
  // ROUND-35/36: the FINAL live/absent decision is CONFIRMATION-time — the
  // round-33 identity-time ordering governs replacement detection only. An
  // absence whose confirmation completes AFTER the last same-generation
  // presence evidence is never overwritten by an earlier-read presence (the
  // round-33 carried-instant sort places such a verdict early), and the
  // reported instant is the EARLIEST post-horizon completion (the round-34
  // rule, re-derived over all admitted absences). ROUND-36: completion
  // timestamps bound collection latency, not snapshot ordering — a credited
  // absence must ALSO have a demonstrably post-presence COLLECTION (its
  // read START at or after the final presence horizon; an overlapping
  // collection interval proves nothing about the state after the presence).
  // A presence whose identity read postdates every credited absence leaves
  // this block untouched and adjudicates live.
  if (state === 'live' || state === 'absent') {
    let earliestPostHorizonAbsence = null;
    for (const read of input.absenceReads) {
      const queried = /** @type {any} */ (read).queried;
      if (read.status !== 'absent' || !isPlainObject(queried)
        || queried.pid !== bound.pid || queried.nonce !== bound.nonce) continue;
      if (Number.isSafeInteger(read.readStartedEpochMs) && read.readStartedEpochMs < lastPresenceEpochMs) continue;
      const completedAt = /** @type {any} */ (read).readEpochMs;
      if (completedAt > lastPresenceEpochMs
        && (earliestPostHorizonAbsence === null || completedAt < earliestPostHorizonAbsence)) {
        earliestPostHorizonAbsence = completedAt;
      }
    }
    if (earliestPostHorizonAbsence !== null) {
      state = 'absent';
      finalAbsenceRunStart = earliestPostHorizonAbsence;
    }
  }
  if (state === 'live') {
    return {
      localProcessObservationVersion: LOCAL_PROCESS_OBSERVATION_VERSION,
      class: 'exit-absence',
      status: 'live',
      reason: null,
      boundIdentity,
      lastVerifiedPresenceEpochMs: lastPresenceEpochMs,
      firstVerifiedAbsenceEpochMs: null,
      exitCorroboratedByMeta: false,
    };
  }
  if (state === 'absent') {
    return {
      localProcessObservationVersion: LOCAL_PROCESS_OBSERVATION_VERSION,
      class: 'exit-absence',
      status: 'disappeared',
      reason: null,
      boundIdentity,
      lastVerifiedPresenceEpochMs: lastPresenceEpochMs,
      firstVerifiedAbsenceEpochMs: finalAbsenceRunStart,
      // The meta corroborates the lawful exit ONLY on an established
      // disappearance — never instead of one — and only when the admission
      // binds the INVOCATION process's own admitted identity: the stdout
      // capture exists exclusively for the gated invocation (the broker gate
      // writes no stdout pair), and the shared capture nonce can never tell
      // whose exit the metadata describes. Foreign-scope, unbound, or
      // another process's binding is NEVER credited (named uncredited,
      // never false corroboration).
      exitCorroboratedByMeta: exitMetaAdmission !== undefined
        && exitMetaAdmission.status === 'complete'
        && exitMetaAdmission.nonce === bound.nonce
        && exitMetaAdmission.role === 'invocation'
        && isPlainObject(exitMetaAdmission.invocationIdentity)
        && /** @type {any} */ (exitMetaAdmission.invocationIdentity).pid === bound.pid
        && /** @type {any} */ (exitMetaAdmission.invocationIdentity).startIdentity === bound.startIdentity
        && /** @type {any} */ (exitMetaAdmission.invocationIdentity).nonce === bound.nonce,
    };
  }
  return unestablished(sawUnestablished ? 'absence-unestablished' : 'no-absence-read-after-presence');
}

// ---------------------------------------------------------------------------
// The two-hop ancestry join and the bounded local-duty verdict (§25.4 item 4
// / §25.5). Both are pure adjudications of CAPTURE-TIME facts: every hop's
// endpoints must be positively captured and the ppid equalities checked at
// capture time; the nonce binds the SCOPE (several same-scope processes can
// carry it), the entry/argv shape selects the role, and a marker never
// attests another process merely because they inherited a nonce. There is NO
// stop authority anywhere in this module.
// ---------------------------------------------------------------------------

/**
 * One ancestry-hop verdict. `detail` names the capture-time-only character
 * of a ppid equality (a later mismatch proves reparenting, never death).
 * `witnessClass` (additive member; the §26.6 route-(b) registration) rides
 * ONLY an established hop whose lifetime refusal was resolved by the
 * positively captured spawn-boundary causal witness — old verdicts carry no
 * member and stay byte-stable.
 * @typedef {{
 *   hop: 'companion-to-daemon' | 'daemon-to-transport',
 *   status: 'established' | 'unestablished',
 *   reason: string | null,
 *   detail?: string,
 *   witnessClass?: 'spawn-boundary-capture',
 * }} AncestryHop
 */

/**
 * Route-(b) validation: the join accepts ONLY an admitted spawn-witness
 * verdict (the {@link admitSpawnAncestryWitness} shape). Any other value is
 * an input-contract error, never a silent ignore.
 * @param {unknown} verdict @param {string} label @returns {any}
 */
function validatedSpawnWitnessInput(verdict, label) {
  if (verdict === undefined) return undefined;
  if (!isPlainObject(verdict) || verdict.class !== 'spawn-ancestry-witness'
    || (verdict.status !== 'established' && verdict.status !== 'invalid' && verdict.status !== 'missing' && verdict.status !== 'unestablished')
    || (verdict.status === 'established' && !isPlainObject(verdict.identity))) {
    throw invalidLocalProcessInput(`the ${label} spawn witness must be an admitted spawn-ancestry-witness verdict.`);
  }
  if (verdict.status === 'established' && validateSpawnWitnessRecord(verdict.identity).ok !== true) {
    throw invalidLocalProcessInput(`the ${label} spawn witness identity is shape-invalid.`);
  }
  return verdict;
}

/**
 * Route-(b) application (the §26.6 freeze; §26.7 item 3 witnesses): a
 * positively captured spawn-boundary witness ESTABLISHES the hop only when
 * it binds the writer's established generation, the child's capture-time
 * generation, the kernel parent link at the boundary, the child's own
 * verified nonce and a capture window inside the parent's verified presence
 * interval. Every divergence is a NEW named refusal (never folded into the
 * old labels); the witness never fabricates or relabels an OS birth instant.
 * @param {SpawnAncestryWitnessVerdict | undefined} witness
 * @param {{
 *   writerPid: number, writerStartIdentity: string,
 *   childPid: number, childStartIdentity: string | null,
 *   childPpid: number, childNonce: string,
 *   writerReadEpochMs: number | null, childOsStartInstant?: number,
 *   writerOsStartInstant?: number, childMarkerEpochMs?: number,
 *   childReadStartedEpochMs?: number, writerReadStartedEpochMs?: number,
 *   scopeNonce?: string, expectedRole?: IdentityRole,
 * }} expected
 * @returns {{ status: 'established', reason: null, witnessClass: 'spawn-boundary-capture' } | { status: 'unestablished', reason: string, detail?: string | null }}
 */
function establishThroughSpawnWitness(witness, expected) {
  if (witness === undefined) return { status: 'unestablished', reason: 'spawn-witness-absent' };
  if (witness.status !== 'established' || !isPlainObject(witness.identity)) {
    return {
      status: 'unestablished',
      reason: 'spawn-witness-unadmitted',
      detail: typeof witness.reason === 'string' ? witness.reason : null,
    };
  }
  const facts = /** @type {SpawnAncestryWitnessIdentity} */ (witness.identity);
  /** @param {string} reason @returns {{ status: 'unestablished', reason: string, detail: null }} */
  const mismatch = (reason) => ({ status: 'unestablished', reason, detail: null });
  // The PARENT presence interval: the witness capture window must ride
  // inside the parent's verified presence — the establishing read of the
  // writer's own generation must POSTDATE the boundary and the write.
  if (!Number.isSafeInteger(expected.writerReadEpochMs)) return mismatch('spawn-witness-capture-unbounded');
  // The witness binds the JOIN's declared scope (defense in depth — the
  // admission already refused a foreign file) and the boundary role that
  // matches this hop: an inherited witness in a wrong role never bridges.
  if (expected.scopeNonce !== undefined && facts.nonce !== expected.scopeNonce) return mismatch('spawn-witness-nonce-mismatch');
  if (expected.expectedRole !== undefined && facts.role !== expected.expectedRole) return mismatch('spawn-witness-role-mismatch');
  // The WRITER identity: the witness's creator must BE the established
  // parent generation (pid + OS-verified start identity at the boundary).
  if (facts.writerPid !== expected.writerPid || facts.writerStartIdentity !== expected.writerStartIdentity) {
    return mismatch('spawn-witness-writer-foreign');
  }
  // The CHILD capture identity: the child generation the writer positively
  // observed at the boundary must be the child generation this hop binds —
  // a same-pid reused successor can never ride the witness. When the hop
  // binds an externally observed child start identity (the Companion→daemon
  // hop's refreshed daemon read), it must EQUAL the witnessed one. When the
  // caller has NO external child start identity (the daemon→transport hop:
  // the marker carries kernel pid/ppid facts only), the witness's OWN
  // captured childStartIdentity — validated non-empty from the writer's
  // OS-verified boundary double read — is the positively captured generation
  // binding (the §26.6 anti-reuse argument: the witness binds the child's
  // own start identity and the parent's capture-time presence interval; a
  // reused PID cannot forge a parent relationship it never observed).
  if (expected.childPid === null) return mismatch('spawn-witness-child-foreign');
  if (facts.childPid !== expected.childPid) return mismatch('spawn-witness-child-foreign');
  if (typeof expected.childStartIdentity === 'string' && facts.childStartIdentity !== expected.childStartIdentity) {
    return mismatch('spawn-witness-child-foreign');
  }
  // The CAPTURE-TIME kernel parent link: the child's OS ppid observed at the
  // boundary was the writer's pid (the actual spawn relationship).
  if (facts.childPpid !== expected.childPpid) return mismatch('spawn-witness-parent-foreign');
  // The CHILD's own verified nonce (its scope/transport expectation) at the
  // boundary: an env-inherited nonce in a wrong role never bridges.
  if (facts.childNonce !== expected.childNonce) return mismatch('spawn-witness-nonce-mismatch');
  // The window bounds: the boundary observation and the witness write both
  // completed before the parent's establishing read; the boundary can never
  // precede the WRITER'S OWN OS creation second (the codex round-2 review's
  // anti-reuse hole: the daemon→transport branch supplied no child bound and
  // the writer's start was never checked, so a witness stamped before its
  // writer existed could establish); and the boundary can never precede the
  // child's OS creation second. Every bound is a coarse-vs-coarse
  // contradiction refusal (whole-second lower bound vs the writer's own
  // coarse stamp) — never resolved by arithmetic, never a new precision
  // claim; the writer-side contradiction carries its own named label.
  if (Number.isSafeInteger(expected.writerOsStartInstant) && facts.boundaryEpochMs < /** @type {number} */ (expected.writerOsStartInstant)) {
    return mismatch('spawn-witness-capture-before-writer');
  }
  if (facts.boundaryEpochMs > /** @type {number} */ (expected.writerReadEpochMs) || facts.firstWriteEpochMs > /** @type {number} */ (expected.writerReadEpochMs)) {
    return mismatch('spawn-witness-capture-unbounded');
  }
  if (Number.isSafeInteger(expected.childOsStartInstant) && facts.boundaryEpochMs < /** @type {number} */ (expected.childOsStartInstant)) {
    return mismatch('spawn-witness-capture-unbounded');
  }
  // The CREATION-ORDER binding (codex round 10 — the last conjunct of the
  // generation-continuity invariant): the witnessed child's OS creation must
  // not demonstrably PRECEDE the writer's. The broker-boundary path never
  // compared the record's `childOsStartInstantMs` with the writer's OS
  // creation lower bound, so contradictory generation evidence — a witnessed
  // child whose ENTIRE possible creation window [floor, floor + 1000) lies
  // before the writer's OS creation floor — could establish ancestry the
  // no-witness arithmetic refuses (the reviewer's schedule: writer start
  // 3000, child start 2000, marker 3100, boundary/write 4050/4060, writer
  // read 4100). The kernel's own spawn order is inverted in that case: the
  // writer did not exist when the witnessed child's window closed, so it
  // cannot have spawned that child — a coarse-vs-coarse demonstrable
  // contradiction, symmetric to the marker/parent rules, never a new
  // precision claim. Fresh label per the §26.7 item-5 no-fold discipline:
  // §28.8's `spawn-witness-capture-before-writer` is specifically the
  // writer-vs-CAPTURE precedence (a witness stamped before its writer
  // existed); this is the CHILD-vs-WRITER creation precedence — a different
  // contradiction between two generations. Consumed whenever both instants
  // are carried (hop 1: the endpoint's daemon floor vs the record's
  // witnessed daemon floor; hop 2: the daemon's floor vs the witnessed
  // transport floor); an absent member stays absent (the v1-replay/named-
  // absent conjuncts upstream).
  if (Number.isSafeInteger(expected.writerOsStartInstant)
    && Number.isSafeInteger(facts.childOsStartInstantMs)
    && /** @type {number} */ (facts.childOsStartInstantMs) < /** @type {number} */ (expected.writerOsStartInstant)) {
    return mismatch('spawn-witness-creation-order-inverted');
  }
  // (the overall review — CROSS-RECORD CONSISTENCY) the record's numeric
  // child OS start instant and the child ENDPOINT's numeric start instant
  // describe the SAME captured start identity (the childStartIdentity
  // equality binds the generations above), and BOTH derive from the same
  // source (the same captured start identity text — the darwin lstart parse
  // or the Linux proc-ticks arithmetic), so their NUMERIC instants must
  // AGREE: a disagreement is a mixed/corrupted record that would borrow the
  // endpoint's creation window to bypass the record's own generation
  // ambiguity. Same-domain same-source numerics require EQUALITY — no
  // tolerance. Absent on either side stays absent (never credited as
  // agreement). The label follows the no-fold discipline: a cross-record
  // numeric contradiction is distinct from the creation-order inversion and
  // from the boundary contradiction — spawn-witness-child-start-
  // contradicted. The replay mirrors the same label and comparison.
  if (Number.isSafeInteger(expected.childOsStartInstant)
    && Number.isSafeInteger(facts.childOsStartInstantMs)
    && /** @type {number} */ (facts.childOsStartInstantMs) !== /** @type {number} */ (expected.childOsStartInstant)) {
    return mismatch('spawn-witness-child-start-contradicted');
  }
  // The MARKER-GENERATION binding (codex round 4): when the hop's child
  // evidence is an ARTIFACT the child generation itself writes (the
  // daemon→transport hop's marker, whose write instant the caller supplies
  // here), the §26.7 record's only child-generation time evidence is its
  // own capture window — the boundary is when the writer positively
  // observed THIS child generation alive. A marker write instant more than
  // one uniform uncertainty OLDER than the witnessed capture demonstrably
  // belongs to a predecessor occupant of the same pid (the emitter's
  // bounded ingress observation completes within ~1.2 s of the very spawn
  // attempt it witnesses), so the marker's generation is NOT bound to the
  // witnessed child and the upgrade refuses. Coarse-vs-coarse: the
  // uniform whole-second bound is the join's registered uncertainty, never
  // a new precision claim.
  if (Number.isSafeInteger(expected.childMarkerEpochMs)
    && facts.boundaryEpochMs - /** @type {number} */ (expected.childMarkerEpochMs) > LINUX_BTIME_UNCERTAINTY_MS) {
    return mismatch('spawn-witness-marker-generation-unbound');
  }
  // The POSITIVE marker-to-generation binding (codex rounds 5–6, the ROOT
  // adjudication): with a whole-second creation floor, temporal
  // compatibility (marker ≥ floor) proves NOTHING about generation identity —
  // when a predecessor and its same-pid replacements all report the SAME
  // creation floor T, a predecessor marker anywhere in [T, T+1000) is
  // temporally compatible with a replacement that did not exist when the
  // marker was written (the reviewer's schedule: marker T+100, replacements
  // T+200/T+400, witness capture T+500, parent read T+700). The only sound
  // positive binding under the registered coarseness: the marker must
  // POSTDATE the witnessed child's ENTIRE possible creation window —
  // markerTime ≥ childOsStartInstantMs + LINUX_BTIME_UNCERTAINTY_MS (the
  // window is [floor, floor + the uniform uncertainty); the marker's mtime is
  // the same kernel epoch wall clock, the upper endpoint (marker ≤ the
  // daemon's identity read) stays the hop-level terminal later-than-read
  // refusal, and the round-4 proximity conjunct above is retained as one
  // refusal conjunct among several — never alone sufficient). The two
  // negative bands each carry their OWN named label (§26.7 item 5 no-fold):
  // a marker BELOW the witnessed floor demonstrably precedes the child's
  // earliest possible existence (`spawn-witness-marker-generation-unbound`,
  // the round-5 pin); a marker INSIDE the possible creation window is
  // generation-AMBIGUOUS — a same-second predecessor's write is
  // indistinguishable from the witnessed child's own — and refuses
  // (`spawn-witness-marker-generation-ambiguous`, the fresh round-6 label).
  // Coarse-vs-coarse honest: the ambiguity is refused, never resolved as
  // true. Records that cannot supply the binding — a retained v1 replay
  // record (the member genuinely absent under its recorded version, §26.7
  // item 2) or a v2 record whose parse resolved to the named-absent null —
  // never upgrade the marker path either. Honest real-chain consequence: the
  // transport hop's marker is typically written within the child's creation
  // second, so the marker upgrade requires a POST-CREATION-SECOND marker;
  // same-second chains keep the carried refusal (the witness's OTHER
  // positive bindings — parent generation, role, argv/scope, nonce, capture
  // relationship — are unaffected).
  if (Number.isSafeInteger(expected.childMarkerEpochMs)) {
    if (!Number.isSafeInteger(facts.childOsStartInstantMs)
      || /** @type {number} */ (expected.childMarkerEpochMs) < /** @type {number} */ (facts.childOsStartInstantMs)) {
      return mismatch('spawn-witness-marker-generation-unbound');
    }
    if (/** @type {number} */ (expected.childMarkerEpochMs) < /** @type {number} */ (facts.childOsStartInstantMs) + LINUX_BTIME_UNCERTAINTY_MS) {
      return mismatch('spawn-witness-marker-generation-ambiguous');
    }
  }
  // The WRITER-GENERATION continuity binding (codex round 7 — the
  // parent-side sibling of the round-6 marker adjudication): on darwin the
  // start identity is the whole-second ps lstart floor, so the equality
  // conjunct above (record writerPid/writerStartIdentity vs the READ-TIME
  // parent endpoint) is compatible with same-generation AND same-second
  // reuse — a same-scope P1 taking the Companion's pid inside the shared
  // lstart second passes it without having written the witness (P0 spawns D
  // and writes at T+100, exits; P1 takes the pid at T+400; the endpoint read
  // at T+700 observes P1). Capture-before-read bounds never establish
  // generation continuity. The DISAMBIGUATING evidence is the witness's own
  // write instant against the read-time parent's ENTIRE possible creation
  // window: with the writer provably alive at firstWriteEpochMs, a
  // same-floor reuse would have to be born after the writer's death — which
  // postdates the write — so a write POSTDATING the whole window
  // (firstWriteEpochMs ≥ writerOsStartInstant + LINUX_BTIME_UNCERTAINTY_MS)
  // PROVES the read-time occupant is the writer's generation (any same-floor
  // reuse would carry a LATER floor, contradicting the equality conjunct),
  // while a write INSIDE [floor, floor+1000) leaves the reuse compatible and
  // refuses `spawn-witness-parent-generation-ambiguous` (the §26.7 item-5
  // fresh-label discipline; the marker family's round-6 rule applied
  // symmetrically — no establishment conclusion may exceed what the coarse
  // facts prove; route (c)'s higher-resolution generation evidence stays
  // NAMED UNAVAILABLE, §28.1, so the ambiguity cannot be resolved).
  // Demonstrably-different identities keep `spawn-witness-writer-foreign`
  // above. Honest consequence: a witness written inside the parent's first
  // possible second — the real chain's typical shape — cannot establish the
  // parent-continuity conclusion; the ambiguity is refused, never resolved
  // as true.
  if (!Number.isSafeInteger(expected.writerOsStartInstant)) {
    // Without the read-time parent's creation floor the writer's generation
    // window is unbounded and the continuity conclusion cannot be drawn at
    // all (absent facts stay absent, §26.7 item 3/5).
    return mismatch('spawn-witness-capture-unbounded');
  }
  if (/** @type {number} */ (facts.firstWriteEpochMs) < /** @type {number} */ (expected.writerOsStartInstant) + LINUX_BTIME_UNCERTAINTY_MS) {
    return mismatch('spawn-witness-parent-generation-ambiguous');
  }
  // (codex round 12 — the parent-side mirror of the round-11 collection
  // rule) The writer-continuity proof ALSO requires the writer endpoint's
  // identity to be provably COLLECTED after the witness write: the
  // comparison is witness-write-vs-READ-TIME parent occupant, and an
  // endpoint inspection that SAMPLED the predecessor before the witness was
  // written but COMPLETED afterward describes the predecessor regardless of
  // its late completion (the reviewer's schedule: the Companion query
  // samples P0 at 1100 and completes at 2500; P0 exits at 1200; a
  // same-scope P1 reuses the pid at 1400 with the same floor 1000 and
  // writes the witness at 2110 — the late completion accepted P0's presence
  // bound as continuity evidence for P1's witness). The conjunct consumes
  // the writer endpoint's COLLECTION bound (the observeLocalProcess
  // read-start): establishment requires the parent identity provably
  // COLLECTED after the witness write (`writerReadStartedEpochMs ≥
  // firstWriteEpochMs`, aligned with the creation-window conjunct above —
  // with BOTH, the snapshot instant sits at or after the write, so any
  // same-floor reuse would be born after the writer's death (≥ the write ≥
  // floor + 1000) and carry a LATER floor, contradicting the equality
  // conjunct); an overlapping collection window (read-start before the
  // write) or an absent/unknown bound refuses the same
  // `spawn-witness-parent-generation-ambiguous` label (the trigger widened,
  // the label kept — the §28.10-line precedent). Carried by BOTH call sites
  // (the Companion endpoint on hop 1, the daemon endpoint on hop 2 — the
  // read-time writer occupant must be the witnessed writer generation on
  // either boundary).
  if (!Number.isSafeInteger(expected.writerReadStartedEpochMs)
    || /** @type {number} */ (expected.writerReadStartedEpochMs) < /** @type {number} */ (facts.firstWriteEpochMs)) {
    return mismatch('spawn-witness-parent-generation-ambiguous');
  }
  // The CHILD-GENERATION continuity binding (codex round 8 — the child-side
  // sibling of the rounds 6–7 adjudications): the identity-equality conjunct
  // above (witness childStartIdentity vs the READ-TIME child endpoint) is
  // equally ambiguous within the shared lstart second — a same-scope
  // replacement reusing the daemon pid inside that second passes it without
  // having been the witnessed generation (a nonce comparison is NOT a sound
  // disambiguator here: §26.6 freezes the nonce as a SCOPE binding, never a
  // generation authority — every same-scope replacement carries the same
  // nonce by construction, so a match proves scope, not generation, and a
  // mismatch is already refused by the scope bindings above). The
  // disambiguating evidence mirrors the parent fix: the witnessed child is
  // provably alive at the boundary (the writer's OS-verified ingress double
  // read), so a boundary POSTDATING the read-time child's ENTIRE possible
  // creation window (boundaryEpochMs ≥ childOsStartInstant +
  // LINUX_BTIME_UNCERTAINTY_MS) PROVES the read-time occupant is the
  // witnessed generation (any same-floor reuse would be born after the
  // witnessed child's death — which postdates the boundary — and would
  // carry a LATER floor, contradicting the equality conjunct), while a
  // boundary INSIDE the window refuses
  // `spawn-witness-child-generation-ambiguous` (the §26.7 item-5 fresh-label
  // discipline; no establishment conclusion beyond what the coarse facts
  // prove; route (c)'s higher-resolution generation evidence stays NAMED
  // UNAVAILABLE, §28.1). Only hops that bind a READ-TIME child endpoint
  // (childOsStartInstant supplied — the Companion→daemon hop) consume this;
  // the daemon→transport hop binds the witness record's own captured child
  // generation and has no read-time comparison to contradict.
  // (codex rounds 9+11 — the INTERVAL-vs-COMPLETION rule) The continuity
  // proof ALSO requires the child endpoint's identity to be provably
  // COLLECTED after the boundary capture: the comparison is
  // witness-capture-vs-READ-TIME occupant, so an endpoint whose collection
  // window STARTED before the capture may describe a PREDECESSOR — a
  // same-floor occupant snapshotted before the witnessed replacement was
  // captured — regardless of when the inspection's response completed
  // (completion instants prove neither presence nor ordering; collection
  // bounds prove ordering; observation instants prove presence). The
  // ordering conjunct therefore consumes the endpoint's COLLECTION bound
  // (`childReadStartedEpochMs ≥ boundaryEpochMs`, the observeLocalProcess
  // read-start bound): a collection window that overlaps the capture
  // (started before the boundary) refuses, and an ABSENT bound is an
  // unknown ordering, never credited — both refuse the same named label
  // (the trigger widened, the label kept — the §28.10 precedent; the
  // reviewer's schedule: endpoint collected 1200, completed 2200,
  // replacement born 1400 with the same coarse identity, witnessed 2100).
  // A hop whose contract binds an EARLIER endpoint has none of the required
  // structure and stays refused (the collection bound is always supplied by
  // the Companion→daemon call site).
  if (Number.isSafeInteger(expected.childOsStartInstant)) {
    if (/** @type {number} */ (facts.boundaryEpochMs) < /** @type {number} */ (expected.childOsStartInstant) + LINUX_BTIME_UNCERTAINTY_MS
      || !Number.isSafeInteger(expected.childReadStartedEpochMs)
      || /** @type {number} */ (expected.childReadStartedEpochMs) < /** @type {number} */ (facts.boundaryEpochMs)) {
      return mismatch('spawn-witness-child-generation-ambiguous');
    }
  }
  return ({ status: 'established', reason: null, witnessClass: 'spawn-boundary-capture' });
}

/**
 * Resolve one join endpoint. Absent (not supplied) and VALID negative
 * verdicts (an os-live-observation verdict whose status is `absent` or
 * `unestablished`) are both UNAVAILABLE ENDPOINTS: the hop is named
 * unestablished while every other hop stays independently adjudicated.
 * Only a malformed input (not a verdict object, or a foreign class) throws.
 * @param {LocalProcessObservation | null} observation @param {string} label @returns {any | null}
 */
function joinEndpointFacts(observation, label) {
  if (observation === null || observation === undefined) return null;
  if (!isPlainObject(observation) || /** @type {any} */ (observation).class !== 'os-live-observation') {
    throw invalidLocalProcessInput(`the ${label} observation must be an os-live-observation verdict.`);
  }
  if (/** @type {any} */ (observation).status !== 'established' || !isPlainObject(/** @type {any} */ (observation).observation)) {
    return null;
  }
  const facts = /** @type {any} */ (observation).observation;
  // ROUND-23 ENDPOINT COMPLETENESS (the round-15/16 bar): an ancestry
  // endpoint must carry a VERIFIED OS generation — a positive pid and a
  // nonempty start identity. An established-tagged endpoint without them is
  // named-unavailable (never joined on compatible pid/ppid/nonce/instants).
  if (!Number.isSafeInteger(facts.pid) || facts.pid <= 0
    || typeof facts.startIdentity !== 'string' || facts.startIdentity.length === 0) {
    return null;
  }
  return facts;
}

/**
 * Adjudicate the §25.4 two-hop ancestry join from positively captured facts:
 * (a) the transport marker's ppid equals the captured broker-daemon PID, and
 * (b) the broker daemon's ppid equals the captured Companion PID — both at
 * capture time only. An unestablished endpoint names the hop unestablished;
 * the Companion↔transport attribution never crosses an unestablished hop.
 * Purely offline; performs NO reads or writes.
 *
 * Evidence-completion Task 3 (§26.6 route (b) / §26.7 freeze): when a hop's
 * other frozen witnesses all hold and its ONLY refusal is the same-second
 * lifetime arithmetic, a positively captured SPAWN-BOUNDARY CAUSAL WITNESS
 * — the fixture-owned parent's capture-time ingress observation of the
 * spawned child, admitted through {@link admitSpawnAncestryWitness} — may
 * establish the hop. The witness is bound to the two endpoint generations,
 * the capture-time kernel parent link, the child's own scope/transport
 * nonce, and the captured window rides inside ONE verified parent presence
 * interval; OS coarse instants stay coarse; the route NEVER reopens another
 * refusal, never bridges a missing endpoint, and a fresh
 * `witnessClass: 'spawn-boundary-capture'` member rides the established hop
 * (additive enum member; old verdicts byte-stable).
 * @param {{
 *   nonce: string,
 *   companionObservation: LocalProcessObservation | null,
 *   daemonObservation: LocalProcessObservation | null,
 *   transportMarker: { pid: number, ppid: number, nonce: string },
 *   expectedTransportNonce?: string,
 *   markerEpochMs?: number,
 *   daemonCaptureParentPid?: number,
 *   companionSpawnWitness?: SpawnAncestryWitnessVerdict,
 *   daemonSpawnWitness?: SpawnAncestryWitnessVerdict,
 * }} input
 * @returns {{ localProcessObservationVersion: number, class: 'ancestry-join', nonce: string, hops: AncestryHop[], companionToTransportAttributed: boolean }}
 */
export function joinAncestryHops(input) {
  if (!isPlainObject(input)) throw invalidLocalProcessInput('the ancestry join input must be an object.');
  const { nonce } = input;
  validateCaptureNonce(nonce, 'scope');
  const companionFacts = joinEndpointFacts(input.companionObservation, 'companion');
  const daemonFacts = joinEndpointFacts(input.daemonObservation, 'daemon');
  const marker = input.transportMarker;
  if (!isPlainObject(marker) || !Number.isSafeInteger(marker.pid) || marker.pid <= 0
    || !Number.isSafeInteger(marker.ppid) || marker.ppid <= 0
    || typeof marker.nonce !== 'string' || !HEX_64.test(marker.nonce)) {
    throw invalidLocalProcessInput('the transport marker must carry a positive pid, a positive ppid and a 64-hex nonce.');
  }
  // The transport's OWN declared nonce (the driver's
  // FAKE_ZCODE_PROCESS_NONCE): generated independently of the capture scope,
  // so the daemon→transport hop verifies the marker against THIS expectation
  // — never against the capture nonce. When it is not declared, the hop is
  // bound by ancestry alone and the marker nonce rides as its own fact.
  const expectedTransportNonce = input.expectedTransportNonce;
  if (expectedTransportNonce !== undefined) validateCaptureNonce(expectedTransportNonce, 'expected transport');
  // (Review round 7, Finding 2) the CAPTURE-TIME parent of the daemon: when
  // supplied (a positive pid), hop 1 verifies the ppid chain against THIS
  // link — the same daemon generation observed LATER under a changed parent
  // (the Companion exited; the detached broker reparented) demonstrates
  // reparenting, never a generation change, and its LATER read provides the
  // lifetime bound.
  const daemonCaptureParentPid = input.daemonCaptureParentPid;
  if (daemonCaptureParentPid !== undefined && (!Number.isSafeInteger(daemonCaptureParentPid) || daemonCaptureParentPid <= 0)) {
    throw invalidLocalProcessInput('the daemon capture-time parent pid must be a positive integer.');
  }
  // Evidence-completion Task 3 (route (b)): the optional preregistered
  // spawn-boundary witnesses. Malformed inputs are input-contract errors —
  // the witness route never silently declines (~a hand-fabricated verdict is
  // never mistaken for an admitted one).
  const companionSpawnWitness = validatedSpawnWitnessInput(input.companionSpawnWitness, 'companion');
  const daemonSpawnWitness = validatedSpawnWitnessInput(input.daemonSpawnWitness, 'daemon');
  // The marker's OWN time evidence (review round 17): when supplied, the
  // daemon→transport hop verifies generation-compatible lifetimes; when
  // absent, the hop is named-unestablished (never bridged).
  const markerEpochMs = input.markerEpochMs;
  if (markerEpochMs !== undefined && !Number.isSafeInteger(markerEpochMs)) {
    throw invalidLocalProcessInput('the transport marker epoch must be a safe integer.');
  }
  /**
   * @param {AncestryHop['status']} status
   * @param {string | null} reason
   * @param {string | null} detail
   * @returns {Omit<AncestryHop, 'hop'>}
   */
  /** @type {(status: 'established' | 'unestablished', reason: string | null, detail?: string | null) => Omit<AncestryHop, 'hop'>} */
  const hopVerdict = (status, reason, detail) => ({
    status,
    reason,
    ...(detail === null || detail === undefined ? {} : { detail }),
  });
  // GENERATION-COMPATIBLE LIFETIMES (review round 17): PPID + nonce equality
  // is not ancestry under PID reuse. A hop is credited only when each
  // endpoint's OS start instant precedes the other endpoint's capture/read
  // instant — the child existed when the parent link was read, and the
  // parent existed when the child started. Missing lifetime evidence keeps
  // the hop NAMED-unestablished, never bridged.
  /**
   * @param {number} parentStart
   * @param {number} childStart
   * @param {number} parentReadEpochMs
   * @param {number} childReadEpochMs
   * @returns {string | null}
   */
  const lifetimeCompatible = (parentStart, childStart, parentReadEpochMs, childReadEpochMs) => {
    if (!Number.isSafeInteger(parentStart) || !Number.isSafeInteger(childStart)
      || !Number.isSafeInteger(parentReadEpochMs) || !Number.isSafeInteger(childReadEpochMs)) {
      return 'generation-lifetime-unverifiable';
    }
    // Each endpoint's OS start instant must precede the other endpoint's
    // capture/read instant (the child existed when the parent link was read,
    // the parent existed when the child was created), and the child must
    // still be within its own capture read.
    if (childStart > parentReadEpochMs || parentStart > childReadEpochMs || parentStart > childStart) {
      return 'generation-lifetime-unverifiable';
    }
    return null;
  };
  // ROUND-28: the endpoint lifetime horizon is the IDENTITY-READ instant —
  // asynchronous work after the identity reads (the boot-clock resolution)
  // contributes no identity evidence and must never extend a captured
  // generation's verified lifetime across a pid reuse. Observations without
  // the carried instant (pre-round-28 hand-built facts) keep the
  // whole-observation completion.
  /** @type {(observation: any) => number | null} */
  const endpointReadEpochMs = (/** @type {any} */ observation) => {
    if (!isPlainObject(observation)) return null;
    return /** @type {number | null} */ (Number.isSafeInteger(observation.identityReadEpochMs) ? observation.identityReadEpochMs : observation.readEpochMs);
  };
  const companionReadEpochMs = endpointReadEpochMs(input.companionObservation);
  const daemonReadEpochMs = endpointReadEpochMs(input.daemonObservation);
  // ROUND-18 UNCERTAINTY PROPAGATION: a Linux proc-ticks start instant is a
  // LOWER BOUND (whole-second btime; true creation in [computed, computed +
  // 1000)). A lifetime ordering that holds merely via that uncertainty (the
  // true instant could violate it) is named-unestablished; only orderings
  // that hold even at the UNCERTAINTY BOUND are demonstrable and may credit.
  // Darwin lstart instants are not lower bounds in this sense (the duty join
  // handles their second-containment separately).
  /**
   * @param {{ startIdentity: string } | null} facts
   * @returns {number}
   */
  // ROUND-19: the rounding uncertainty is UNIFORM — darwin `ps lstart` is
  // whole-second (true creation in [T, T+1000)) exactly like Linux btime, so
  // every OS start instant carries the same 1000-ms lower-bound uncertainty
  // in the hop lifetime checks. (The duty join's darwin second-CONTAINMENT
  // rule is unchanged: this is only about never treating a rounded start as
  // an exact instant when ordering ancestry lifetimes.)
  const startBoundMs = (facts) => (facts !== null ? LINUX_BTIME_UNCERTAINTY_MS : 0);
  const companionBoundMs = startBoundMs(companionFacts);
  const daemonBoundMs = startBoundMs(daemonFacts);
  // Hop (b of the contract's mapping, first in the chain): Companion → daemon.
  /** @type {Omit<AncestryHop, 'hop'>} */
  let companionToDaemon;
  if (companionFacts === null || daemonFacts === null) {
    companionToDaemon = hopVerdict('unestablished', 'hop-endpoint-unestablished', null);
  } else if (daemonFacts.nonce !== nonce || companionFacts.nonce !== nonce) {
    companionToDaemon = hopVerdict('unestablished', 'scope-nonce-mismatch', null);
  } else if ((Number.isSafeInteger(daemonCaptureParentPid) ? daemonCaptureParentPid : daemonFacts.ppid) !== companionFacts.pid) {
    // A changed parent NEVER proves death: the equality is a CAPTURE-TIME
    // fact — verified against the capture-time parent link when the caller
    // supplies one (the observed endpoint may be a LATER same-generation
    // read under a changed parent), else against the observation's own
    // capture-time ppid. Reparenting after the Companion's exit is the
    // expected shape.
    companionToDaemon = hopVerdict('unestablished', 'daemon-ppid-mismatch-at-capture', 'capture-time-only');
  } else if (companionFacts.startInstantEpochMs === undefined || daemonFacts.startInstantEpochMs === undefined
    || !Number.isSafeInteger(companionReadEpochMs) || !Number.isSafeInteger(daemonReadEpochMs)
    || lifetimeCompatible(companionFacts.startInstantEpochMs, daemonFacts.startInstantEpochMs,
      /** @type {number} */ (companionReadEpochMs), /** @type {number} */ (daemonReadEpochMs)) !== null) {
    // Demonstrably violated (or lifetime evidence missing) — refused. The
    // Demonstrably-ORDERED refusal is a real contradiction (an OS ordering
    // that inverts the kernel's own spawn order) and the witness route never
    // reopens it; the witness route applies only to the BOUND WINDOW below.
    companionToDaemon = hopVerdict('unestablished', 'generation-lifetime-unverifiable', null);
  } else {
    // Holds only via the uncertainty window (the true instant could violate
    // it) — named ambiguity, never credited — UNLESS the preregistered
    // route-(b) witness binds the actual capture-time causality (the §26.6
    // freeze): the witness must cover BOTH bound-window refusals this branch
    // would carry, and its orderings stay nameable without relabeling any
    // OS instant as precise.
    const boundWindowRefused = daemonFacts.startInstantEpochMs + daemonBoundMs > /** @type {number} */ (companionReadEpochMs)
      || companionFacts.startInstantEpochMs + companionBoundMs > /** @type {number} */ (daemonReadEpochMs)
      || companionFacts.startInstantEpochMs + companionBoundMs > daemonFacts.startInstantEpochMs;
    const witnessOutcome = companionSpawnWitness === undefined || !boundWindowRefused ? null : establishThroughSpawnWitness(companionSpawnWitness, {
      writerPid: companionFacts.pid,
      writerStartIdentity: companionFacts.startIdentity,
      childPid: daemonFacts.pid,
      childStartIdentity: daemonFacts.startIdentity,
      childPpid: companionFacts.pid,
      childNonce: daemonFacts.nonce,
      writerReadEpochMs: companionReadEpochMs,
      // (codex round 12) the writer endpoint's COLLECTION bound: the
      // parent-continuity proof consumes the read-start, never the
      // completion (the companion-side mirror of the child-side rule).
      writerReadStartedEpochMs: /** @type {number} */ (input.companionObservation?.readStartedEpochMs),
      scopeNonce: nonce,
      expectedRole: 'invocation',
      childOsStartInstant: daemonFacts.startInstantEpochMs,
      writerOsStartInstant: companionFacts.startInstantEpochMs,
      // (codex rounds 9+11) the child endpoint's OWN read collection START:
      // the child-continuity proof compares the witnessed generation against
      // the READ-TIME occupant, so the endpoint's identity must be provably
      // COLLECTED after the boundary capture — the collection START (the
      // observeLocalProcess read bound), never the completion instant: an
      // inspection can sample a predecessor before the witness capture and
      // finish afterward, so completion-after-capture is not proof of
      // collection-after-capture.
      childReadStartedEpochMs: /** @type {number} */ (input.daemonObservation?.readStartedEpochMs),
    });
    if (boundWindowRefused && witnessOutcome === null) {
      companionToDaemon = hopVerdict('unestablished', 'generation-lifetime-unverifiable', null);
    } else if (witnessOutcome !== null && witnessOutcome.status === 'established') {
      companionToDaemon = { status: 'established', reason: null, witnessClass: /** @type {const} */ ('spawn-boundary-capture') };
    } else if (witnessOutcome !== null) {
      companionToDaemon = hopVerdict('unestablished', witnessOutcome.reason, witnessOutcome.detail ?? null);
    } else {
      companionToDaemon = hopVerdict('established', null, null);
    }
  }
  // Hop (a): daemon → transport marker. The DAEMON endpoint's own scope is
  // verified INDEPENDENTLY of hop 1 (class sweep, review round 10): every
  // hop carrying the requested scope label verifies the scope of BOTH its
  // endpoints — a foreign-scope daemon must never host in-scope transport
  // evidence, whatever the Companion endpoint's state.
  /** @type {Omit<AncestryHop, 'hop'>} */
  let daemonToTransport;
  if (daemonFacts === null) {
    daemonToTransport = hopVerdict('unestablished', 'hop-endpoint-unestablished', null);
  } else if (daemonFacts.nonce !== nonce) {
    daemonToTransport = hopVerdict('unestablished', 'scope-nonce-mismatch', null);
  } else if (expectedTransportNonce !== undefined && marker.nonce !== expectedTransportNonce) {
    daemonToTransport = hopVerdict('unestablished', 'transport-nonce-mismatch', null);
  } else if (marker.ppid !== daemonFacts.pid) {
    daemonToTransport = hopVerdict('unestablished', 'marker-ppid-mismatch-at-capture', null);
  } else {
    // The transport marker's OWN time must be generation-compatible with the
    // daemon: the daemon's OS creation must precede the marker time and the
    // marker time must precede the daemon's capture read. Missing or
    // out-of-order time evidence keeps the hop named-unestablished — never
    // credited by PPID equality alone. The route-(b) daemon-boundary witness
    // (when supplied) may resolve ONLY the uncertainty-window refusals below
    // — the coarse violation (the marker predating the daemon's own creation
    // second) and a MISSING marker epoch stay refused with the daemon
    // endpoint's establishing read bounding the capture window instead.
    const markerTime = markerEpochMs;
    const daemonStart = daemonFacts.startInstantEpochMs;
    const daemonRead = daemonReadEpochMs;
    const markerTimeOk = typeof markerTime === 'number' && Number.isSafeInteger(markerTime)
      && typeof daemonStart === 'number' && Number.isSafeInteger(daemonStart)
      && typeof daemonRead === 'number' && Number.isSafeInteger(daemonRead);
    const markerDemonstrablyAfterDaemon = markerTimeOk && daemonStart + daemonBoundMs <= markerTime;
    const markerDemonstrablyBeforeRead = markerTimeOk && markerTime <= daemonRead;
    const markerDemonstrablyViolated = markerTimeOk && daemonStart > markerTime;
    // (codex round 3) The marker's verified-lifetime UPPER bound is TERMINAL:
    // a marker timestamp AFTER the daemon's identity read lies outside the
    // read-bounded window, and the §26.7 frozen witness record carries no
    // fact that binds a marker's TIMESTAMP to the witnessed generation (it
    // binds pids/identities/nonce and its own capture window only), so the
    // witness route must never resolve this contradiction — the original
    // later-than-read refusal stands (not rounding uncertainty: no captured
    // fact re-attaches a later marker to the witnessed child generation).
    // Only the creation-second UNCERTAINTY window (a marker the daemon's
    // creation lower bound cannot demonstrably precede, still inside the
    // read window) stays witness-resolvable.
    const markerDemonstrablyAfterRead = markerTimeOk && !markerDemonstrablyBeforeRead;
    const boundWindowRefused = markerTimeOk && !markerDemonstrablyAfterRead && !markerDemonstrablyAfterDaemon;
    const witnessOutcome = daemonSpawnWitness === undefined || !boundWindowRefused ? null : establishThroughSpawnWitness(daemonSpawnWitness, {
      writerPid: daemonFacts.pid,
      writerStartIdentity: daemonFacts.startIdentity,
      childPid: marker.pid,
      childStartIdentity: null,
      childPpid: marker.ppid,
      childNonce: expectedTransportNonce ?? marker.nonce,
      writerReadEpochMs: daemonRead,
      // (codex round 12) the writer endpoint's COLLECTION bound: the
      // parent-continuity proof consumes the read-start, never the
      // completion (the daemon-side mirror of the child-side rule).
      writerReadStartedEpochMs: /** @type {number} */ (input.daemonObservation?.readStartedEpochMs),
      writerOsStartInstant: daemonFacts.startInstantEpochMs,
      // The marker's own write instant bound to the WITNESSED child
      // generation (codex round 4): a stale marker predating the witnessed
      // capture window never upgrades this hop. Reachable only when
      // markerTimeOk holds, so the instant is a safe integer here.
      childMarkerEpochMs: markerTime,
      scopeNonce: nonce,
      expectedRole: 'broker-daemon',
    });
    if (!markerTimeOk || markerDemonstrablyViolated || markerDemonstrablyAfterRead) {
      daemonToTransport = hopVerdict('unestablished', 'generation-lifetime-unverifiable', null);
    } else if (boundWindowRefused && witnessOutcome === null) {
      // Holds only via the daemon's btime uncertainty — named ambiguity.
      daemonToTransport = hopVerdict('unestablished', 'generation-lifetime-unverifiable', null);
    } else if (witnessOutcome !== null && witnessOutcome.status === 'established') {
      // (codex round 16 — EXPLICIT UNSATISFIABILITY, §28.22) This branch is
      // UNREACHABLE by construction: the route is entered only when
      // `markerTime < daemonStart + LINUX_BTIME_UNCERTAINTY_MS` (the bound
      // window above), while the establishment predicate requires
      // `markerTime >= childOsStartInstantMs + LINUX_BTIME_UNCERTAINTY_MS`
      // (the positive marker-to-generation binding) under
      // `childOsStartInstantMs >= daemonStart` (the creation-order binding)
      // — jointly `markerTime >= daemonStart + LINUX_BTIME_UNCERTAINTY_MS`,
      // contradicting the entry condition. With a marker epoch present
      // (guaranteed on this route), EVERY witness outcome here is one of the
      // named refusals below; establishment can never occur, and no bound
      // may be weakened to make it satisfiable (the §26.7 freeze). The
      // branch is therefore the NAMED unavailable classification — fail-
      // closed: if a future change ever made it reachable, the hop refuses
      // with `spawn-witness-route-unsatisfiable` instead of crediting a
      // witnessClass establishment. The route's sound contributions remain
      // its REFUSAL evidence (the labels below), and the hop's positives
      // stay ARITHMETIC-only.
      daemonToTransport = hopVerdict('unestablished', 'spawn-witness-route-unsatisfiable', null);
    } else if (witnessOutcome !== null) {
      daemonToTransport = hopVerdict('unestablished', witnessOutcome.reason, witnessOutcome.detail ?? null);
    } else {
      daemonToTransport = hopVerdict('established', null, null);
    }
  }
  const hops = [
    { hop: /** @type {const} */ ('companion-to-daemon'), ...companionToDaemon },
    { hop: /** @type {const} */ ('daemon-to-transport'), ...daemonToTransport },
  ];
  return {
    localProcessObservationVersion: LOCAL_PROCESS_OBSERVATION_VERSION,
    class: 'ancestry-join',
    nonce,
    hops,
    companionToTransportAttributed: hops.every((hop) => hop.status === 'established'),
  };
}

/**
 * Compose the RUNTIME ancestry join: the frozen {@link joinAncestryHops}
 * verdict, or — when the available facts cannot compose a join at all (a
 * missing transport marker, an unvalidated scope) — the NAMED uncomposable
 * verdict with BOTH hops explicitly unestablished. The validation failure's
 * free text is NEVER carried (it may embed private paths). The runtime
 * composition always persists a verdict, so the offline join's gate can
 * require it fail-closed.
 * @param {{
 *   nonce: string,
 *   companionObservation?: any | null,
 *   daemonObservation?: any | null,
 *   transportMarker?: { pid: number, ppid: number, nonce: string } | null,
 *   expectedTransportNonce?: string,
 *   markerEpochMs?: number,
 *   companionSpawnWitness?: SpawnAncestryWitnessVerdict,
 *   daemonSpawnWitness?: SpawnAncestryWitnessVerdict,
 * }} input
 * @returns {Record<string, any>}
 */
export function composeAncestryJoinForRuntime(input) {
  /** @param {string} reason @param {string=} nonce */
  const uncomposable = (reason, nonce) => ({
    localProcessObservationVersion: LOCAL_PROCESS_OBSERVATION_VERSION,
    class: 'ancestry-join',
    ...(nonce !== undefined ? { nonce } : {}),
    hops: [
      { hop: 'companion-to-daemon', status: 'unestablished', reason },
      { hop: 'daemon-to-transport', status: 'unestablished', reason },
    ],
    companionToTransportAttributed: false,
  });
  if (!isPlainObject(input)) return uncomposable('ancestry-uncomposable');
  try {
    validateCaptureNonce(input.nonce, 'scope');
  } catch {
    return uncomposable('ancestry-uncomposable');
  }
  try {
    return joinAncestryHops(/** @type {any} */ (input));
  } catch {
    return uncomposable('ancestry-uncomposable', input.nonce);
  }
}

/**
 * One per-duty fact inside the bounded local-duty verdict. `exitStatus` is
 * present ONLY on identified-descendant duties whose caller supplied an
 * exit adjudication.
 * @typedef {{
 *   duty: 'invocation-process' | 'broker-daemon' | 'transport-descendant' | 'identified-descendant',
 *   label?: string,
 *   status: 'established' | 'unestablished',
 *   reasons: string[],
 *   identity: { pid: number, startIdentity: string, nonce: string } | null,
 *   exitStatus?: string,
 * }} LocalDutyFact
 */

/**
 * @param {any} fact @returns {fact is Record<string, any>}
 */
function validDutyFactShape(fact) {
  if (fact === null || fact === undefined) return true;
  if (!isPlainObject(fact)) return false;
  const startup = fact.startupRecord;
  if (startup !== null && startup !== undefined
    && (!isPlainObject(startup) || typeof startup.status !== 'string'
      || (startup.status === 'established' && !isPlainObject(startup.identity)))) return false;
  const os = fact.osObservation;
  if (os !== null && os !== undefined
    && (!isPlainObject(os) || os.class !== 'os-live-observation' || typeof os.status !== 'string')) return false;
  return true;
}

/**
 * Join one duty's startup record and OS observation into its per-duty fact.
 * The invocation and broker duties require BOTH positively captured sides
 * joined on pid and nonce; the transport (marker-captured through the
 * existing fixture machinery) and identified descendants ride the OS
 * observation alone.
 * @param {LocalDutyFact['duty']} duty @param {any} fact @param {boolean} requireStartupRecord @param {string | null} label @param {IdentityRole | null} requiredStartupRole @param {string} scopeNonce
 * @returns {LocalDutyFact}
 */
function joinLocalDuty(duty, fact, requireStartupRecord, label, requiredStartupRole, scopeNonce) {
  if (fact === null || fact === undefined) {
    return { duty, ...(label === null ? {} : { label }), status: 'unestablished', reasons: ['no-fact-supplied'], identity: null };
  }
  const reasons = [];
  const startup = fact.startupRecord ?? null;
  const os = fact.osObservation ?? null;
  if (requireStartupRecord && (startup === null || startup.status !== 'established' || !isPlainObject(startup.identity))) {
    reasons.push('startup-record-unestablished');
  }
  if (os === null || os.status !== 'established' || !isPlainObject(os.observation)) {
    reasons.push('os-observation-unestablished');
  }
  if (reasons.length === 0 && requireStartupRecord) {
    const observation = /** @type {any} */ (os).observation;
    // ONE completeness gate for EVERY duty-establishing branch (review
    // round 16): verified generation evidence requires a positive pid AND a
    // nonempty OS start identity — a bare {pid, ppid, nonce} marker is
    // incomplete and can never substitute, not even on startup-backed duties.
    if (!Number.isSafeInteger(observation.pid) || observation.pid <= 0
      || typeof observation.startIdentity !== 'string' || observation.startIdentity.length === 0) {
      reasons.push('os-observation-incomplete');
    }
    const startupIdentity = /** @type {any} */ (startup).identity;
    // Role binding (§25.4 item 1/4): the nonce binds the SCOPE and the
    // argv/entry shape selects the role — one process must never attest
    // another duty's role, even with a perfectly joining pid and nonce.
    if (startupIdentity.role !== requiredStartupRole) reasons.push('startup-role-mismatch');
    if (observation.pid !== startupIdentity.pid) reasons.push('pid-join-mismatch');
    if (observation.nonce !== startupIdentity.nonce) reasons.push('nonce-join-mismatch');
    // Generation binding (§25.4 item 4), PRECISE rule (review round 7):
    // PID+nonce cannot distinguish a same-nonce successor that reused the
    // PID, and whole-second lstart arithmetic cannot exclude a same-second
    // one. The preload therefore embeds the process's OWN sub-millisecond
    // start instant and its precise write instant; the binding requires (a)
    // the OS lstart second to CONTAIN the record's precise start instant and
    // (b) the precise write to postdate the precise start. What still
    // genuinely cannot be excluded (a successor starting inside the writer's
    // own start second, after the write) is a DOCUMENTED residual bound of
    // this rule — recorded in §25.10, never guessed away.
    if (reasons.length === 0) {
      const startInstant = observation.startInstantEpochMs;
      const recordStart = startupIdentity.startOriginMs;
      const recordWrite = startupIdentity.firstWritePreciseMs;
      if (!Number.isSafeInteger(startInstant) || typeof recordStart !== 'number' || typeof recordWrite !== 'number') {
        reasons.push('generation-binding-unavailable');
      } else if (recordStart > recordWrite) {
        reasons.push('generation-start-after-record');
      } else if (/^proc:\d+$/u.test(observation.startIdentity)) {
        // Linux: the resolved creation instant is precise (~10ms). The
        // startup-delay tolerance is ASYMMETRIC (review round 10): creation
        // may precede the record's precise WRITE by up to the documented
        // fork-to-initialization window; creation KNOWN LATER than the write
        // by more than the documented /proc resolution bound is
        // DEMONSTRABLY a successor; creation only resolution-close to the
        // write stays named-ambiguous (never established-by-default).
        if (startInstant > recordWrite + LINUX_PROC_RESOLUTION_MS) {
          reasons.push('generation-start-after-write');
        } else if (recordWrite < startInstant + LINUX_BTIME_UNCERTAINTY_MS) {
          reasons.push('generation-start-ambiguous');
        }
      } else {
        // Darwin: whole-second lstart. The OS creation second must contain
        // the record's precise start OR be the immediately preceding second
        // (a process forked just before a boundary whose Node initializes
        // just after — ordinary startup timing, not PID reuse). The residual
        // window (a successor forked within that two-second span after the
        // write) is the documented named bound of this mechanism.
        const startSecond = Math.floor(recordStart / 1000) * 1000;
        if (startInstant !== startSecond && startInstant !== startSecond - 1000) {
          reasons.push('generation-start-second-mismatch');
        }
      }
      // GENERATION CONTINUITY (review rounds 26/27): the observation's
      // IDENTITY-READ completion must POSTDATE the record writer's startup.
      // An observation whose identity reads completed before the writer's
      // own precise start is evidence about an EARLIER generation (a
      // pid+nonce reuser can never be excluded from it), and a reuser
      // starting DURING the observation's later asynchronous work (the
      // boot-clock resolution) makes the whole-observation completion LIE
      // about that freshness — so the gate anchors on the identity-read
      // instant the verdict carries (falling back to the whole-observation
      // completion for facts without it), and an observation with NO
      // verifiable instant is named stale the same way (fail-closed, never
      // established-by-default). This final gate cannot mask the more
      // specific labels above.
      const evidenceEpochMs = Number.isSafeInteger(os.identityReadEpochMs) ? os.identityReadEpochMs : os.readEpochMs;
      if (reasons.length === 0 && (!Number.isSafeInteger(evidenceEpochMs) || evidenceEpochMs < recordStart)) {
        reasons.push('os-observation-stale');
      }
    }
    // One SHARED invocation scope binds every duty (§25.4 item 2): facts
    // carried over from a concurrent fixture invocation are a named refusal,
    // never settled evidence.
    if (reasons.length === 0 && observation.nonce !== scopeNonce) reasons.push('scope-nonce-mismatch');
  } else if (reasons.length === 0) {
    const observation = /** @type {any} */ (os).observation;
    // Generation evidence requires a positive pid AND a nonempty OS start
    // identity: a bare {pid, ppid, nonce} marker is incomplete evidence and
    // can never substitute for verified generation (review round 15).
    if (!isPlainObject(observation) || !Number.isSafeInteger(/** @type {any} */ (observation).pid) || /** @type {any} */ (observation).pid <= 0
      || typeof /** @type {any} */ (observation).startIdentity !== 'string' || /** @type {any} */ (observation).startIdentity.length === 0) {
      reasons.push('os-observation-incomplete');
    } else if (observation.nonce !== scopeNonce) {
      reasons.push('scope-nonce-mismatch');
    }
  }
  const established = reasons.length === 0;
  const observation = established ? /** @type {any} */ (os).observation : null;
  return {
    duty,
    ...(label === null ? {} : { label }),
    status: established ? 'established' : 'unestablished',
    reasons,
    identity: established ? { pid: observation.pid, startIdentity: observation.startIdentity, nonce: observation.nonce } : null,
  };
}

/**
 * The bounded local-duty verdict over the §25.5 applicable local identities:
 * the invocation process (the real Companion), the broker daemon (the
 * mediation hop), the declared transport descendant (marker-captured), and
 * ONLY the positively identified descendants the caller supplies. Each
 * duty's status is the positive identity establishment; the aggregate adds
 * the conservative descendant rule — a positively identified SURVIVING
 * descendant is itself an outstanding local duty, so `settled` is true ONLY
 * when every applicable duty is established AND every supplied identified
 * descendant carries an exit adjudication of `disappeared`. The verdict
 * NEVER claims not-applicable (that requires demonstrated production-path
 * evidence recorded by the caller) and NEVER carries stop authority; the
 * per-identity exit facts of the main duties ride `adjudicateLocalExit`
 * separately (§25.4 items 6/8) and are composed by the caller.
 *
 * Local-settlement Task 3 (the round-6 transport-scope rule carried to the
 * duty aggregate): the transport descendant is scoped by its OWN declared
 * nonce — the driver's `FAKE_ZCODE_PROCESS_NONCE`, generated independently
 * of the capture scope — exactly like `joinAncestryHops`'
 * `expectedTransportNonce`. When the caller declares it, the transport
 * duty's scope check accepts that nonce INSTEAD of the capture scope nonce
 * (the startup-backed duties keep the capture-scope rule unchanged); when
 * it is not declared, the transport duty keeps the capture-scope check.
 * @param {{
 *   nonce: string,
 *   invocation?: any,
 *   broker?: any,
 *   transport?: any,
 *   expectedTransportNonce?: string,
 *   identifiedDescendants?: { label?: string, startupRecord?: any, osObservation?: any, exit?: any }[],
 *   ancestryEstablished?: boolean,
 * }} input
 * @returns {{ localProcessObservationVersion: number, class: 'local-duty-verdict', settled: boolean, duties: LocalDutyFact[], ancestryRefusal?: string }}
 */
export function adjudicateLocalDuties(input) {
  if (!isPlainObject(input)) throw invalidLocalProcessInput('the local-duty adjudication input must be an object.');
  const { nonce } = input;
  // The EXPECTED invocation scope: every duty identity in the aggregate must
  // carry it before the verdict may settle (one shared scope binding — facts
  // from concurrent fixture invocations are a named refusal).
  validateCaptureNonce(nonce, 'scope');
  // The declared transport scope (see the JSDoc): validated like every
  // nonce, and consumed ONLY by the transport slot below.
  const expectedTransportNonce = input.expectedTransportNonce;
  if (expectedTransportNonce !== undefined) validateCaptureNonce(expectedTransportNonce, 'expected transport');
  // (Review round 7, Finding 2) the CAPTURE-TIME parent of the daemon: when
  // supplied (a positive pid), hop 1 verifies the ppid chain against THIS
  // link — the same daemon generation observed LATER under a changed parent
  // (the Companion exited; the detached broker reparented) demonstrates
  // reparenting, never a generation change, and its LATER read provides the
  // lifetime bound.
  const descendants = input.identifiedDescendants ?? [];
  if (!Array.isArray(descendants)) throw invalidLocalProcessInput('the identified descendants must be a list of duty facts.');
  for (const descendant of descendants) {
    if (!isPlainObject(descendant) || (descendant.label !== undefined && typeof descendant.label !== 'string')
      || !validDutyFactShape(descendant)) {
      throw invalidLocalProcessInput('each identified descendant must be a duty fact with an optional label.');
    }
    if (descendant.osObservation !== null && descendant.osObservation !== undefined
      && (!isPlainObject(descendant.osObservation) || descendant.osObservation.class !== 'os-live-observation')) {
      throw invalidLocalProcessInput('each identified descendant observation must be an os-live-observation verdict.');
    }
    if (descendant.exit !== null && descendant.exit !== undefined
      && (!isPlainObject(descendant.exit) || descendant.exit.class !== 'exit-absence' || typeof descendant.exit.status !== 'string')) {
      throw invalidLocalProcessInput('each identified descendant exit must be an exit-absence adjudication.');
    }
  }
  for (const fact of [input.invocation, input.broker, input.transport]) {
    if (!validDutyFactShape(fact)) throw invalidLocalProcessInput('each duty fact must carry a startup record and an os-live-observation verdict.');
    if (fact !== null && fact !== undefined && fact.osObservation !== null && fact.osObservation !== undefined
      && (!isPlainObject(fact.osObservation) || fact.osObservation.class !== 'os-live-observation')) {
      throw invalidLocalProcessInput('each duty observation must be an os-live-observation verdict.');
    }
  }
  const duties = [
    joinLocalDuty('invocation-process', input.invocation ?? null, true, null, 'invocation', nonce),
    joinLocalDuty('broker-daemon', input.broker ?? null, true, null, 'broker-daemon', nonce),
    joinLocalDuty('transport-descendant', input.transport ?? null, false, null, null, expectedTransportNonce ?? nonce),
    ...descendants.map((descendant) => ({
      ...joinLocalDuty('identified-descendant', descendant, false, descendant.label ?? null, null, nonce),
      ...(descendant.exit === null || descendant.exit === undefined ? {} : { exitStatus: descendant.exit.status }),
    })),
  ];
  // A positively identified descendant without a positively adjudicated
  // disappearance stays an OUTSTANDING local duty (never silently ignored).
  // The credited exit must be THIS descendant's own: its bound identity
  // (pid, start identity, nonce) must equal the descendant's OS observation.
  const descendantsSettled = descendants.every((descendant) => {
    const exit = descendant.exit;
    if (exit === null || exit === undefined || exit.status !== 'disappeared' || !isPlainObject(exit.boundIdentity)) return false;
    const observation = isPlainObject(descendant.osObservation) ? descendant.osObservation.observation : null;
    if (!isPlainObject(observation)) return false;
    // The credited exit must carry THIS invocation's scope nonce.
    if (exit.boundIdentity.nonce !== nonce) return false;
    // Class sweep (ordering): the credited absence must be STRICTLY after
    // the descendant's own observed presence — an absence at or before that
    // instant is ordering-impossible evidence and never completes the duty.
    // ROUND-30: the presence horizon anchors on the IDENTITY-READ instant
    // (falling back to the whole-observation completion for pre-round-27
    // facts) — consistently with the exit adjudicator: delayed asynchronous
    // work after the identity reads (the boot-clock resolution) never
    // extends the horizon, so an absence confirmed inside that window is
    // lawful.
    const descendantPresenceEpochMs = Number.isSafeInteger(descendant.osObservation.identityReadEpochMs)
      ? descendant.osObservation.identityReadEpochMs
      : descendant.osObservation.readEpochMs;
    if (!Number.isSafeInteger(exit.firstVerifiedAbsenceEpochMs)
      || !Number.isSafeInteger(descendantPresenceEpochMs)
      || /** @type {number} */ (exit.firstVerifiedAbsenceEpochMs) <= /** @type {number} */ (descendantPresenceEpochMs)) {
      return false;
    }
    return exit.boundIdentity.pid === observation.pid
      && exit.boundIdentity.startIdentity === observation.startIdentity
      && exit.boundIdentity.nonce === observation.nonce;
  });
  const settled = duties.every((duty) => duty.status === 'established') && descendantsSettled;
  // The ancestry gate (review round 2, plan Task 3 / §25.4 item 4): when the
  // caller composed the runtime ancestry join and it did NOT attribute the
  // Companion→broker→transport chain, the local layer may NEVER settle — a
  // failed or unestablished hop is a NAMED aggregate-level refusal, never
  // silently dropped. Undefined keeps the legacy behavior byte-identical.
  if (input.ancestryEstablished === false) {
    return {
      localProcessObservationVersion: LOCAL_PROCESS_OBSERVATION_VERSION,
      class: 'local-duty-verdict',
      settled: false,
      duties,
      ancestryRefusal: 'ancestry-hops-unattributed',
    };
  }
  return {
    localProcessObservationVersion: LOCAL_PROCESS_OBSERVATION_VERSION,
    class: 'local-duty-verdict',
    settled,
    duties,
  };
}

// ---------------------------------------------------------------------------
// Observer provenance (the evidence.mjs/shape-diagnostic.mjs discipline):
// the executing provenance binds THIS module's module-init bytes, the
// closure-observation helper's module-init bytes (the preload generator),
// and the generated capture source bytes under the versioned tag; the
// record-time working-tree re-read uses the same construction over the
// on-disk bytes, so a mid-run source edit is DETECTED (drift) without ever
// relabelling the code that actually executed. Every executing
// helper/generated-preload byte enters the digest; the generated preload's
// actual source hash is recorded beside it.
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   revision: string,
 *   tag: string,
 *   digest: string | null,
 *   digestInput: string | null,
 *   generatedPreloadSha256: string,
 *   model: null,
 *   helperCache?: { consistent: boolean, mismatches: string[] },
 *   helperCacheMismatches?: string[],
 * }} LocalObserverProvenance
 */

/**
 * The v4 construction: tag ‖ THIS module's bytes (the identity machinery and
 * every admission/adjudication lives here since round 8) ‖ the closure
 * preload generator's executing bytes ‖ the three MATERIALIZED executing
 * helper copy digests (fs integrity, process runs, unsafe-path rejections —
 * executing == hashed by construction) ‖ the generated capture source bytes.
 * @param {Buffer} localSource @param {Buffer} closurePreloadModuleSource @param {{ fs: string, process: string, errors: string }} helperCopyDigests @param {Buffer} generatedSource @returns {LocalObserverProvenance}
 */
/**
 * @param {Buffer} localSource
 * @param {Buffer} closurePreloadModuleSource
 * @param {{ [relativeName: string]: string }} helperCopyDigests
 * @param {Buffer} generatedSource
 * @returns {LocalObserverProvenance}
 */
function buildLocalObserverProvenance(localSource, closurePreloadModuleSource, helperCopyDigests, generatedSource) {
  return {
    revision: 'working-tree-uncommitted',
    tag: LOCAL_OBSERVER_DIGEST_TAG,
    digest: createHash('sha256')
      .update(`${LOCAL_OBSERVER_DIGEST_TAG}\0`)
      .update(localSource)
      .update('\0')
      .update(closurePreloadModuleSource)
      .update('\0')
      .update(`${helperCopyDigests['scripts/lib/fs.mjs']}\0${helperCopyDigests['scripts/lib/process.mjs']}\0${helperCopyDigests['scripts/lib/errors.mjs']}`)
      .update('\0')
      .update(generatedSource)
      .digest('hex'),
    digestInput: `${LOCAL_OBSERVER_DIGEST_TAG} || local-process-observation.mjs || closure-preload.mjs (the generated preload seam) || scripts/lib/{fs,process,errors}.mjs MATERIALIZED EXECUTING COPY DIGESTS || closurePreloadSource() (the generated capture source bytes)`,
    generatedPreloadSha256: createHash('sha256').update(generatedSource).digest('hex'),
    model: null,
  };
}

/**
 * The EXECUTING observer provenance: computed from the module-init
 * snapshots and the generated capture source the observed children actually
 * ran. The runtime-executing model stays null — never inferred from hashes.
 * When materialization is UNAVAILABLE (e.g. a read-only checkout failing
 * cache initialization — observation then falls back to the cached
 * production modules), the provenance goes NAMED-UNAVAILABLE with a null
 * digest, mirroring the record-time reader: a digest with literal
 * `undefined` helper-copy interpolation would bind nothing.
 * @param {{ materialization?: { dir: string | null, bytes: Record<string, string> }}} [seams]
 * @returns {LocalObserverProvenance}
 */
export function localProcessObserverProvenance(seams = {}) {
  const materialization = seams.materialization ?? EXECUTING_HELPER_MATERIALIZATION;
  if (materialization.dir === null) {
    return {
      revision: 'helper-materialization-unavailable',
      tag: LOCAL_OBSERVER_DIGEST_TAG,
      digest: null,
      digestInput: 'helper-materialization-unavailable: the executing helper copies could not be materialized (read-only checkout); the observation fell back to the cached production modules',
      generatedPreloadSha256: createHash('sha256').update(Buffer.from(closurePreloadSource(), 'utf8')).digest('hex'),
      model: null,
    };
  }
  return buildLocalObserverProvenance(
    EXECUTING_LOCAL_PROCESS_OBSERVATION_SOURCE,
    EXECUTING_CLOSURE_PRELOAD_SOURCE,
    materialization.bytes,
    Buffer.from(closurePreloadSource(), 'utf8'),
  );
}

/**
 * The record-time working-tree provenance: the same construction over the
 * CURRENT on-disk module bytes (the preload source is regenerated by the
 * executing closure helper). A digest differing from
 * `localProcessObserverProvenance()` is the explicit source-drift fact; any
 * read failure propagates to the caller, who records a named collection
 * failure — never a fabricated value.
 * @param {{
 *   diskBytes?: (relativeName: string) => Promise<Buffer>,
 * }} [deps]
 * @returns {Promise<LocalObserverProvenance>}
 */
export async function readLocalObserverWorkingTreeProvenance(deps = {}) {
  const materialization = await verifyLocalObserverHelperMaterialization(deps);
  if (!materialization.consistent) {
    // The executing materialized copies and the production helper files have
    // diverged (or materialization was unavailable): the provenance goes
    // NAMED-UNAVAILABLE (null digest) instead of attributing evidence across
    // the divergence.
    return {
      revision: materialization.unavailable === true ? 'helper-materialization-unavailable' : 'helper-materialization-drift',
      tag: LOCAL_OBSERVER_DIGEST_TAG,
      digest: null,
      digestInput: `helper-materialization-drift: the executing helper copies differ from the on-disk bytes (${materialization.mismatches.join('; ')})`,
      generatedPreloadSha256: createHash('sha256').update(Buffer.from(closurePreloadSource(), 'utf8')).digest('hex'),
      model: null,
      helperCacheMismatches: materialization.mismatches,
    };
  }
  const [localSource, closurePreloadModuleSource] = await Promise.all([
    readFileSync(fileURLToPath(import.meta.url)),
    readFileSync(fileURLToPath(new URL('./closure-preload.mjs', import.meta.url))),
  ]);
  const provenance = buildLocalObserverProvenance(
    localSource,
    closurePreloadModuleSource,
    EXECUTING_HELPER_MATERIALIZATION.bytes,
    Buffer.from(closurePreloadSource(), 'utf8'),
  );
  return {
    ...provenance,
    helperCache: materialization,
    digestInput: `${provenance.digestInput} (working-tree bytes; helper-copy digests drift-checked against the on-disk helpers)`,
  };
}
