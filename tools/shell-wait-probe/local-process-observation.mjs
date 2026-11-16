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
export const LOCAL_PROCESS_OBSERVATION_VERSION = 4;

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

/**
 * Parse one closed EXACT start-identity form (`kinfo:<sec>:<usec>`).
 * Exported for the replay mirror (driver.mjs's admission-start containment
 * consumes the same form discrimination) and the representation-aware
 * consumers (§32.12 Finding 2).
 * @param {unknown} startIdentity
 * @returns {{ sec: number, usec: number, ms: number } | null}
 */
export function parseExactStartIdentity(startIdentity) {
  if (typeof startIdentity !== 'string') return null;
  const match = /^kinfo:(\d+):(\d+)$/u.exec(startIdentity);
  if (match === null) return null;
  const sec = Number(match[1]);
  const usec = Number(match[2]);
  if (!Number.isSafeInteger(sec) || sec <= 0 || !Number.isInteger(usec) || usec < 0 || usec >= 1_000_000) return null;
  // The module's exact-millisecond convention: the microsecond field rounds
  // to the nearest millisecond (never floored — a floor would reintroduce
  // the whole-second uncertainty exact mode exists to remove).
  return { sec, usec, ms: sec * 1000 + Math.round(usec / 1000) };
}

/**
 * The CLOCK-DOMAIN GUARD (route (c) negative family): a kernel start instant
 * lives in the same wall-clock epoch as Date.now() (the join's capture
 * instants and the marker mtime). A "start" in the future (beyond the
 * sub-second read/skew tolerance) is not a plausible creation instant —
 * the answer is fail-closed to the ps path, NEVER emitted as exact evidence.
 * A start older than the epoch is legitimate (long-lived processes).
 * @param {number} ms @param {number} nowMs @returns {boolean}
 */
function isPlausibleExactStartMs(ms, nowMs) {
  return Number.isSafeInteger(ms) && ms > 0 && ms <= nowMs + 1_000;
}

/**
 * @param {{ sec: number, usec: number } | { malformed: number } | null | undefined} answer
 * @param {number} nowMs
 * @returns {{ state: 'exact', sec: number, usec: number, ms: number } | { state: 'gone' } | { state: 'malformed' }}
 */
function classifyKinfoAnswer(answer, nowMs) {
  // (§32.10 Finding 3) the bridge's FAILED marker (`{"failed": true}` — a
  // sysctl rc != 0, e.g. the measured undersized-struct ENOMEM) is a failed
  // READ, never a gone answer: it classifies malformed so the reader
  // DEGRADES to ps. Only `null` (the bridge's rc == 0 && len == 0 answer) is
  // gone — a live process whose exact read failed must never read as exited.
  if (answer === null || answer === undefined) return { state: 'gone' };
  if (typeof answer !== 'object' || 'malformed' in answer || 'failed' in answer) return { state: 'malformed' };
  const sec = answer.sec;
  const usec = answer.usec;
  if (!Number.isSafeInteger(sec) || sec <= 0 || !Number.isInteger(usec) || usec < 0 || usec >= 1_000_000) return { state: 'malformed' };
  const ms = sec * 1000 + Math.round(usec / 1000);
  if (!isPlausibleExactStartMs(ms, nowMs)) return { state: 'malformed' };
  return { state: 'exact', sec, usec, ms };
}

/**
 * The darwin EXACT-generation mechanism (route (c), user-directed landing;
 * §32): sysctl(3) MIB {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid} into a
 * fixed 648-byte kinfo_proc, the start time read as tv_sec (int64 LE,
 * offset 0) + tv_usec (int32 LE, offset 8) through an inline ctypes bridge
 * on /usr/bin/python3. Measured (2026-11-05, /tmp/pipm-probe): same clock
 * domain as `ps -o lstart=` (tv_sec equals the wall second exactly) and
 * tracks Date.now() within ~1 ms; two kernel paths agree exactly;
 * same-second back-to-back spawn pairs distinguish at microsecond
 * granularity (10/10 pairs, 484–1427 µs in the re-measurement); a dead pid
 * maps to rc == 0 with len 0 (gone); a sysctl FAILURE (rc != 0 — the
 * measured undersized-struct case returns -1/ENOMEM errno 12 atomically,
 * never torn) maps to the bridge's `{"failed": true}` marker, which the
 * reader classifies malformed → DEGRADES to ps (§32.10 Finding 3: rc != 0
 * is NEVER mapped to gone — only rc == 0 && len == 0 is gone); the
 * NULL-buffer size query is UNSTABLE (648/3888/3240
 * observed), so the buffer discipline is the FIXED 648-byte read with
 * len==648 accepted and 0<len<648 malformed (fail-closed) — the size query
 * is never used to size the read.
 *
 * DEGRADE DISCIPLINE: any unavailability (no python3/CLT shim, bridge
 * failure, malformed/undersized/torn answer, implausible clock domain) keeps
 * the existing ps whole-second path — the exact route is an ENHANCEMENT,
 * never a duty-establishing precondition and never a fallback to a weaker
 * contract.
 * @param {number} pid
 * @param {{ kinfoExact?: (pid: number) => Promise<{ sec: number, usec: number } | { malformed: number } | null>, exactReaderOptIn?: boolean }} [osSeams]
 * @returns {Promise<{ state: 'exact', sec: number, usec: number, ms: number } | { state: 'gone' } | { state: 'malformed' } | { state: 'unavailable' }>}
 */
async function readDarwinKinfoExact(pid, osSeams = {}) {
  // The seam (the deterministic test surface) parallels the runProcess ps
  // seam: injected, it fully owns the read (the real bridge never runs).
  if (typeof osSeams.kinfoExact === 'function') {
    try {
      const answer = await osSeams.kinfoExact(pid);
      return classifyKinfoAnswer(answer, Date.now());
    } catch {
      return { state: 'unavailable' };
    }
  }
  // The real bridge runs ONLY under the registered env opt-in
  // (`ZCODE_SHELL_WAIT_KINFO_EXACT=1`) or its closed osSeam equivalent
  // (`exactReaderOptIn: true` — §33.7 finding 1: the driver-side observation
  // setup threads the ARMED declaration's exact-reader fact through this
  // member, so the driver's own reads resolve identities at the SAME
  // resolution the armed chain's emitters capture, without any process
  // environment mutation): plain unit/real-chain runs keep the ps
  // byte-identical path, and enabling the exact route on a production
  // installed host remains the live-trial wiring question (§32; no
  // production call site sets the variable today). The degrading discipline:
  // hosts without developer tools keep the existing ps whole-second
  // behavior, never a duty-establishing precondition.
  if (process.env.ZCODE_SHELL_WAIT_KINFO_EXACT !== '1' && osSeams.exactReaderOptIn !== true) return { state: 'unavailable' };
  const bridge = [
    'import ctypes, json, sys',
    'class TV(ctypes.Structure):',
    "    _fields_ = [('tv_sec', ctypes.c_long), ('tv_usec', ctypes.c_int32)]",
    'class EP(ctypes.Structure):',
    "    _fields_ = [('p_un', TV), ('pad', ctypes.c_byte * 48)]",
    'class KP(ctypes.Structure):',
    "    _fields_ = [('kp_proc', EP), ('kp_eproc', ctypes.c_byte * 584)]",
    'def read(pid):',
    '    mib = (ctypes.c_int * 4)(1, 14, 1, pid)',
    '    kp = KP(); size = ctypes.c_size_t(648)',
    '    rc = ctypes.CDLL(None).sysctl(mib, 4, ctypes.byref(kp), ctypes.byref(size), None, 0)',
    '    if rc != 0: return {"failed": True}',
    '    if size.value == 0: return None',
    '    if size.value < 648: return {"malformed": size.value}',
    "    return {'sec': kp.kp_proc.p_un.tv_sec, 'usec': kp.kp_proc.p_un.tv_usec}",
    'print(json.dumps(read(int(sys.argv[1]))))',
  ].join('\n');
  try {
    const stdout = await new Promise((resolve, reject) => {
      (async () => {
        const helpers = await loadMaterializedHelperModules();
        return helpers.runProcess(
          { command: '/usr/bin/python3', args: ['-S', '-c', bridge, String(pid)] },
          { timeoutMs: 5_000, maxOutputBytes: 4 * 1024, env: { ...process.env } },
        );
      })().then((/** @type {{ code: number | null, stdout: string, stderr: string }} */ r) => resolve(r.stdout)).catch(reject);
    });
    const answer = JSON.parse(stdout);
    return classifyKinfoAnswer(answer, Date.now());
  } catch {
    return { state: 'unavailable' };
  }
}

/**
 * The closed EXACT start-identity form (route (c)): `kinfo:<sec>:<usec>`.
 * @param {string} startIdentity @returns {boolean}
 */
function isExactStartIdentity(startIdentity) {
  return parseExactStartIdentity(startIdentity) !== null;
}

/** @param {number} pid @param {{ runProcess?: osSeamsRunProcess, kinfoExact?: (pid: number) => Promise<{ sec: number, usec: number } | { malformed: number } | null> }} [osSeams] */
async function readMacProcessStart(pid, osSeams = {}) {
  // ROUND-31/32: lstart is requested in EXPLICIT UTC with the C locale
  // (`TZ=UTC LC_ALL=C ps`) — the local rendering carries no offset and is
  // AMBIGUOUS during a DST fall-back hour, and a localized locale renders
  // month/day names the strict field parse cannot read.
  // The EFFECTIVE platform (the injected seam overrides the host) mirrors
  // the caller's dispatch: a darwin-configured deterministic test on any
  // host reaches the exact seam; a real host uses its own platform.
  if ((/** @type {any} */ (osSeams).platform ?? process.platform) === 'darwin') {
    // (codex gate round 9, Finding 2 — the FIRST-READ bounds carry) the
    // exact query's dispatch and completion bounds are captured around the
    // query itself, so the cancellation error below carries the same
    // {identity, taken, completed} unit the second read's errors receive
    // from the inspector's catch: a first query overlapping a newer presence
    // baseline was previously dated at the cancellation's completion and
    // incorrectly produced pid-start-identity-reused; with the true query
    // window the interval classification yields the lawful ambiguous fact.
    const kinfoTakenEpochMs = Date.now();
    const exact = await readDarwinKinfoExact(pid, osSeams);
    const kinfoCompletedEpochMs = Date.now();
    if (exact.state === 'gone') return undefined;
    // (§32.12 Finding 3) the observation's cancellation is RECHECKED between
    // the exact query and the ps query: the inspector's window checks
    // surround the COMBINED readStart operation and cannot prevent this
    // inner subprocess, whose two-second timeout could extend teardown after
    // the window closed. The thrown shape is the inspector's own
    // window-closed error carrying the observed identity (the exact read DID
    // observe it — evidence preservation, the uniform ride discipline), so
    // the aborted read is an unestablished fact — never 'gone', never a
    // fabricated identity.
    if (/** @type {any} */ (osSeams).abortSignal?.aborted === true) {
      throw Object.assign(new Error('the observation window closed over the in-flight identity read'), {
        observationWindowClosed: true,
        ...(exact.state === 'exact' ? {
          observedStartIdentity: `kinfo:${exact.sec}:${exact.usec}`,
          observedIdentityTakenEpochMs: kinfoTakenEpochMs,
          observedIdentityCompletedEpochMs: kinfoCompletedEpochMs,
        } : {}),
      });
    }
    if (exact.state === 'exact') {
      // (codex gate round 33 follow-up, Finding 2 — the LATER PS WINDOW) the
      // ps read's own dispatch/completion bounds are captured around the
      // query: a disagreement's refusal carries the LATER ps observation with
      // THIS window (the round-25/27 later-read carry protocol), never the
      // kinfo window.
      const psTakenEpochMs = Date.now();
      let ps;
      try {
        ps = await psIdentityRead(pid, osSeams);
      } catch {
        // (codex gate round 9, Finding 1 — the ps-FAILURE carry; codex gate
        // round 11, Finding 1 — the ERROR-VS-ABSENCE DISTINCTION) ps
        // EXECUTION and PARSING failures lose the observed exact identity
        // just like the empty-result branch below: the ordinary error would
        // fall to the inspector's uniform ride and attach the FIRST read's
        // original identity, so a subsequent confirmed absence reported
        // disappeared despite the observed PID reuse. The carry preserves
        // the successor's exact identity and its collection bounds on every
        // ps-failure shape — but the THROWN shape is an ERROR, never an
        // observed absence: it carries the distinct observedThenQueryFailed
        // marker and NO observedThenGone flag (only the EMPTY-ps result
        // below — where absence WAS observed — may drive the default
        // readers' exit conversions). The carried identity and bounds flow
        // through the consumers as error evidence (an unchanged-process
        // classification stays non-exit).
        // (codex gate round 10, Finding 2 — the KINFO-BOUNDS DATING rule)
        // the carried identity was observed by the KINFO query — it is dated
        // with the kinfo query's own window (already captured for the
        // cancellation recheck), never with the later ps query's window:
        // dating a predecessor collected during [1000,1100] with a ps
        // failure at 3000 produced [1100,3000] and misclassified stale
        // predecessors as ambiguous against a newer baseline.
        throw Object.assign(
          new Error('the exact fake-ZCode process identity query failed after its start identity was observed'),
          {
            observedThenQueryFailed: true,
            observedStartIdentity: `kinfo:${exact.sec}:${exact.usec}`,
            observedIdentityTakenEpochMs: kinfoTakenEpochMs,
            observedIdentityCompletedEpochMs: kinfoCompletedEpochMs,
          },
        );
      }
      // (codex gate round 33 follow-up, Finding 2) the completion bound is
      // sampled only after the query RETURNED (the ps-failure branch above
      // keeps its kinfo-dated carry) — the disagreement refusal below dates
      // the carried ps observation with this window.
      const psCompletedEpochMs = Date.now();
      if (ps === undefined) {
        // (codex gate round 8, Finding 1 — the EXACT OBSERVED-THEN-GONE
        // carry) the exact read observed THIS pid's live occupant (on a
        // reused PID: the successor) and the subsequent ps query found the
        // pid gone — the observed-then-gone shape. Returning undefined would
        // DISCARD the observed exact identity, let the inspector's plain
        // absence flow credit the ORIGINAL generation's disappearance, and
        // erase the replacement evidence. The coarse path's own
        // observed-then-gone error carries the observed identity instead —
        // (codex gate round 10, Finding 2) dated with the KINFO query's own
        // window (see the ps-failure branch above), never the later ps
        // query's: the observation layer classifies a demonstrably different
        // carried identity as the generation change and the exit adjudicator
        // latches the reuse; an equal carried identity keeps the lawful
        // absence.
        throw observedThenGoneError(`kinfo:${exact.sec}:${exact.usec}`, kinfoTakenEpochMs, kinfoCompletedEpochMs);
      }
      // (codex gate round 5, Finding 2 — the GENERATION-AGREEMENT rule; the
      // round 11 Finding 2 SHARED COMPOSITION) the kinfo query and the
      // subsequent ps query are two SEPARATE snapshots, and this combination
      // must not pair contradictory ones — the agreement check lives in the
      // SHARED composedExactStartIdentity helper BOTH composition sites call
      // (the real path here and the injected osSeams.ps + kinfoExact seam),
      // so the deterministic seam tests the real protocol and can never
      // certify contradictory generations. Agreeing seconds keep the
      // §32.11 Finding-3 representation-stable combination unchanged.
      // (codex gate round 33 follow-up, Finding 2 — the LATER PS CARRY) on
      // THIS path the kinfo read comes FIRST, so a disagreement's proven
      // later observation is the ps read: the refusal carries the ps
      // identity with its own collection window (the round-25/27 later-read
      // carry protocol), never the first read's kinfo identity the
      // adjudicator would discard as the bound generation's own arrival.
      const composedIdentity = composedExactStartIdentity(exact, ps.startIdentity, {
        identity: ps.startIdentity,
        takenEpochMs: psTakenEpochMs,
        completedEpochMs: psCompletedEpochMs,
      }, {
        takenEpochMs: kinfoTakenEpochMs,
        completedEpochMs: kinfoCompletedEpochMs,
      });
      // (§32.11 Finding 3) the ps-text representation of the SAME read rides
      // the result (`coarseStartIdentity`): the ps read already runs for the
      // kernel parent link, so the coarse form is always derivable alongside
      // the kinfo form at zero extra cost — the double-read generation
      // comparison is representation-stable.
      // (codex gate round 12, Finding 2 — the KERNEL-BOUNDS CARRIAGE) the
      // successful composition carries the kernel query's own bounds on the
      // result, so the inspector's subsequent error rides date the carried
      // exact identity with the KERNEL window — never the entire combined
      // read (a slow ps query used to stretch the carried window across a
      // concurrent baseline and misclassify stale predecessors as
      // ambiguous).
      return {
        pid, ppid: ps.ppid, startIdentity: composedIdentity, startInstantEpochMs: exact.ms, coarseStartIdentity: ps.startIdentity,
        observedIdentityTakenEpochMs: kinfoTakenEpochMs,
        observedIdentityCompletedEpochMs: kinfoCompletedEpochMs,
      };
    }
    // malformed/unavailable → DEGRADE to the ps whole-second path. The
    // degradation path rechecks the cancellation too (§32.12 Finding 3).
    if (/** @type {any} */ (osSeams).abortSignal?.aborted === true) {
      throw Object.assign(new Error('the observation window closed over the in-flight identity read'), { observationWindowClosed: true });
    }
  }
  return psIdentityRead(pid, osSeams);
}

/** @param {number} pid @param {{ runProcess?: osSeamsRunProcess }} [osSeams] The ps whole-second identity read (the DEGRADE path; unchanged). */
async function psIdentityRead(pid, osSeams = {}) {
  const run = psRunner(osSeams.runProcess);
  const result = await run({ command: 'ps', args: ['-o', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-p', String(pid)] }, { timeoutMs: 2_000, maxOutputBytes: 4 * 1024, env: psIdentitySpawnEnv() });
  if (result.code !== 0 || !result.stdout.trim()) return undefined;
  const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(result.stdout);
  if (!match || Number(match[1]) !== pid || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= 0) {
    throw new Error('the exact fake-ZCode process identity could not be parsed');
  }
  return { pid, ppid: Number(match[2]), startIdentity: match[3], coarseStartIdentity: match[3] };
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
 * @param {{ platform?: string, ps?: (pid: number) => Promise<{ pid: number, ppid: number, lstart: string }>, kinfoExact?: (pid: number) => Promise<{ sec: number, usec: number } | { malformed: number } | null>, exactReaderOptIn?: boolean, environ?: 'present' | 'mismatch' | 'gone', runProcess?: osSeamsRunProcess }} [osSeams]
 * @returns {Promise<{ pid: number, ppid: number, startIdentity: string, nonce: string, takenEpochMs: number,
 *       observedStartIdentity?: string, observedIdentityTakenEpochMs?: number, observedIdentityCompletedEpochMs?: number }
 *   | { pid: number, ppid: number, startIdentity: string, coarseStartIdentity: string, nonce: string, takenEpochMs: number,
 *       observedStartIdentity?: string, observedIdentityTakenEpochMs?: number, observedIdentityCompletedEpochMs?: number }
 *   | undefined>}
 *   (§32.14 Finding 1) the second arm is the JOINTLY VERIFIED mixed-resolution
 *   return: when the double reads' resolutions mix, the coarse form both reads
 *   verified returns (never an exact identity only one read saw) — the ps
 *   path's own shape.
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
        if (psResult === undefined) return undefined;
        const base = { ...psResult, startIdentity: psResult.lstart, coarseStartIdentity: psResult.lstart };
        // (route (c), §32) the injected kinfo seam COMPOSES with the ps
        // seam (ps owns pid/ppid; the exact reader owns the identity form
        // and the exact ms): the EXACT identity wins over the lstart text.
        // Unavailable/malformed → the ps identity; gone → the process left.
        if (typeof /** @type {any} */ (osSeams).kinfoExact === 'function') {
          const exact = await readDarwinKinfoExact(observedPid, { kinfoExact: /** @type {any} */ (osSeams).kinfoExact });
          if (exact.state === 'gone') return undefined;
          if (exact.state === 'exact') {
            // (codex gate round 11, Finding 2 — the SHARED COMPOSITION) the
            // injected composition runs the SAME creation-second agreement
            // helper as the real path: a kinfo identity and a ps identity
            // from different seconds refuse identically (carrying the exact
            // identity), never returning successfully.
            return { ...base, startIdentity: composedExactStartIdentity(exact, base.startIdentity), startInstantEpochMs: exact.ms };
          }
        }
        return base;
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
  const beforeResolvedEpochMs = Date.now();
  if (!before) return undefined;
  // (codex gate round 13, Finding 5 — the KERNEL-BOUND RESOLUTION) a
  // successful exact composition carries the kinfo query's own bounds —
  // EVERY first-read failure carry (the nonce-mismatch, the marker-gone and
  // the missing-second-read shapes) dates the observed identity with them,
  // never with the entire combined read's window. A kinfo window collected
  // during [20000,20100] followed by a ps completion at 23000 produced
  // [20000,23000] and misclassified stale predecessors as ambiguous against
  // a newer presence at [22000,22100]; the kernel bounds classify them
  // stale (the lawful outcome).
  const carriedTakenEpochMs = Number.isSafeInteger((/** @type {any} */ (before)).observedIdentityTakenEpochMs)
    ? (/** @type {any} */ (before)).observedIdentityTakenEpochMs
    : beforeTakenEpochMs;
  const carriedCompletedEpochMs = Number.isSafeInteger((/** @type {any} */ (before)).observedIdentityCompletedEpochMs)
    ? (/** @type {any} */ (before)).observedIdentityCompletedEpochMs
    : beforeResolvedEpochMs;
  // (codex round 14 — the COLLECTION INTERVAL) the taken instant is only a
  // collection LOWER bound: a ps request dispatched before a concurrent
  // presence baseline can COLLECT a successor's identity after it (the
  // kernel table read lands whenever the response says it does). The ride
  // therefore carries the whole collection INTERVAL as a unit with the
  // observed identity — the taken/dispatch lower bound and the read's
  // RESOLUTION upper bound — so consumers treat an interval OVERLAPPING a
  // presence baseline as AMBIGUOUS evidence instead of definitively dating
  // it at either bound.
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
    // (codex gate round 12, Finding 2) a successful composition carries the
    // KERNEL query's own bounds — the ride dates the carried identity with
    // them (never the entire combined read's window).
    /** @type {any} */ (error).observedIdentityTakenEpochMs = Number.isSafeInteger((/** @type {any} */ (before)).observedIdentityTakenEpochMs)
      ? (/** @type {any} */ (before)).observedIdentityTakenEpochMs
      : beforeTakenEpochMs;
    /** @type {any} */ (error).observedIdentityCompletedEpochMs = Number.isSafeInteger((/** @type {any} */ (before)).observedIdentityCompletedEpochMs)
      ? (/** @type {any} */ (before)).observedIdentityCompletedEpochMs
      : beforeResolvedEpochMs;
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
      // (codex gate round 13, Finding 5) the kernel-bound resolution (see
      // the hoist above) — never the entire combined read's window.
      /** @type {any} */ (nonceFailure).observedIdentityTakenEpochMs = carriedTakenEpochMs;
      /** @type {any} */ (nonceFailure).observedIdentityCompletedEpochMs = carriedCompletedEpochMs;
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
    throw observedThenGoneError(before.startIdentity, carriedTakenEpochMs, carriedCompletedEpochMs);
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
    // (§32.14 Finding 2) when the SECOND read's failure CARRIES an observed
    // identity of its own (e.g. the window closed over it after a
    // successor's exact identity was read), that SECOND observation and its
    // dispatch bound are the truthful evidence — the uniform ride's
    // first-read overwrite would erase positive replacement evidence. Only
    // errors that observed nothing inherit the first read's ride.
    if (secondReadError instanceof Error && (/** @type {any} */ (secondReadError)).observedStartIdentity !== undefined) {
      // (codex gate round 10, Finding 1 — the GENERATION-COMPARISON-BEFORE-
      // RETHROW rule) the OBSERVED-THEN-GONE carries (the ps-throw and
      // empty-result shapes) preserve the SECOND read's identity — but that
      // identity is first COMPARED with the first read's through the
      // generation relation: a definitively different successor is the
      // generation change and the refusal fires BEFORE the rethrow (the
      // witness poll's retained history would otherwise ground on the
      // uncompared V2 and a later same-successor retry would certify the
      // replacement); same/uncertain keeps the round-9 carry. The
      // window-closed carries keep their established classification (their
      // carried bounds feed the adjudicator's interval rules — the
      // round-8-finding-2 semantics are untouched).
      if (((/** @type {any} */ (secondReadError)).observedThenGone === true
        || (/** @type {any} */ (secondReadError)).observedThenQueryFailed === true)
        && startIdentitiesDefinitivelyDiffer((/** @type {any} */ (secondReadError)).observedStartIdentity, before.startIdentity)) {
        // (codex gate round 27, Finding 1 — the LATER-READ CARRY ON
        // SECOND-READ FAILURES) the SECOND read observed the successor and
        // only its FOLLOWING ps query failed (or found the pid gone): that
        // later observation is the replacement evidence, and the refusal
        // carries the SECOND read's identity with its own collection bounds
        // — the same {identity, taken, completed} unit the non-failure
        // mismatch path below preserves (codex gate round 25, Finding 1) —
        // never rideObservedIdentity's first-read copy. The uniform ride's
        // first-read overwrite let the termination tracker compare its
        // retained A against the SAME carried A and never latch the
        // same-second successor B the second read had proven; a later
        // degraded-to-matching-ps verification then authorized signalling
        // the replacement. The message keeps its established 'identity
        // changed' class.
        throw Object.assign(new Error('the exact fake-ZCode process identity changed'), {
          observedStartIdentity: (/** @type {any} */ (secondReadError)).observedStartIdentity,
          observedIdentityTakenEpochMs: Number.isSafeInteger((/** @type {any} */ (secondReadError)).observedIdentityTakenEpochMs)
            ? (/** @type {any} */ (secondReadError)).observedIdentityTakenEpochMs
            : takenEpochMs,
          observedIdentityCompletedEpochMs: Number.isSafeInteger((/** @type {any} */ (secondReadError)).observedIdentityCompletedEpochMs)
            ? (/** @type {any} */ (secondReadError)).observedIdentityCompletedEpochMs
            : Date.now(),
        });
      }
      // (codex gate round 10, Finding 2 — the KINFO-BOUNDS PRESERVATION) the
      // carry's own bounds (the kinfo query's true window, taken/completed)
      // take precedence over the catch-level stamps: dating a kinfo-observed
      // identity with the later ps query's window misdated stale
      // predecessors into ambiguous replacement evidence. The dispatch bound
      // falls back to the inspector's taken instant only for errors that
      // carry no window of their own; the completion bound is filled only
      // when missing.
      /** @type {any} */ (secondReadError).observedIdentityReadEpochMs = Number.isSafeInteger((/** @type {any} */ (secondReadError)).observedIdentityTakenEpochMs)
        ? (/** @type {any} */ (secondReadError)).observedIdentityTakenEpochMs
        : takenEpochMs;
      if (!Number.isSafeInteger((/** @type {any} */ (secondReadError)).observedIdentityCompletedEpochMs)) {
        /** @type {any} */ (secondReadError).observedIdentityCompletedEpochMs = Date.now();
      }
      throw secondReadError;
    }
    throw rideObservedIdentity(/** @type {Error} */ (secondReadError));
  }
  if (!after) {
    // ROUND-28: the same ride when the pid vanished before the SECOND
    // start-identity read (the marker nonce's presence is scope-only
    // evidence — it never attests the generation).
    throw observedThenGoneError(before.startIdentity, carriedTakenEpochMs, carriedCompletedEpochMs);
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
  // (§32.11 Finding 3 — REPRESENTATION-STABLE comparison, design (a)):
  // every read carries the ps-text representation of the SAME read
  // (`coarseStartIdentity` — the exact path already runs the ps read for the
  // kernel parent link, so the coarse form is always derivable alongside the
  // kinfo form at zero extra cost). When BOTH reads carry the exact form,
  // the exact strings decide (the microsecond discrimination is retained —
  // a same-second successor is still caught); otherwise the COARSE
  // representations decide — a form-only difference (kinfo ↔ ps text, e.g.
  // a transient bridge failure degrading the second read) with equal coarse
  // representations is the SAME generation at this comparison's resolution,
  // never positive change evidence. This matches the all-coarse path's
  // pre-existing discrimination exactly: no resolution is claimed beyond
  // what the degraded read proves.
  /** @param {any} r @returns {boolean} */
  const readsAreExactForm = (r) => typeof r?.startIdentity === 'string' && r.startIdentity.startsWith('kinfo:');
  const bothReadsExact = readsAreExactForm(before) && readsAreExactForm(after);
  /** @param {any} r @returns {string} */
  const comparableGenerationIdentity = (r) => (bothReadsExact
    ? r.startIdentity
    : (typeof r.coarseStartIdentity === 'string' ? r.coarseStartIdentity : r.startIdentity));
  if (comparableGenerationIdentity(before) !== comparableGenerationIdentity(after)) {
    // (codex gate round 25, Finding 1 — the LATER-READ CARRY) the
    // double-read MISMATCH is positive replacement evidence about the SECOND
    // read's occupant: the refusal carries the SECOND (later) read's
    // identity with its own collection bounds — the same {identity, taken,
    // completed} unit the ppid-failure path below preserves — never
    // rideObservedIdentity's first-read copy. The uniform ride's first-read
    // overwrite let the SIGTERM exit polling's tracker compare its retained
    // first-read A against the SAME carried A and never latch the
    // same-second successor B the second read had proven; a later
    // degraded-to-matching-ps verification then authorized signalling the
    // replacement. The later observation is the replacement evidence; the
    // message keeps its established 'identity changed' class.
    throw Object.assign(new Error('the exact fake-ZCode process identity changed'), {
      observedStartIdentity: after.startIdentity,
      observedIdentityTakenEpochMs: Number.isSafeInteger((/** @type {any} */ (after)).observedIdentityTakenEpochMs)
        ? (/** @type {any} */ (after)).observedIdentityTakenEpochMs
        : takenEpochMs,
      observedIdentityCompletedEpochMs: Number.isSafeInteger((/** @type {any} */ (after)).observedIdentityCompletedEpochMs)
        ? (/** @type {any} */ (after)).observedIdentityCompletedEpochMs
        : Date.now(),
    });
  }
  if (before.ppid !== after.ppid) {
    // (codex gate round 15, Finding 2 — the PPID-FAILURE EXACT CARRY) when
    // the second read observed an EXACT identity (the mixed downgrade
    // shape), the reparenting failure preserves the SECOND read's exact
    // identity and its collection bounds — the same {identity, taken,
    // completed} unit the successful mixed-read path preserves — never
    // rideObservedIdentity's first-read coarse form (which discarded the
    // successor and let a confirmed absence credit the original
    // generation's disappearance). The message stays the ppid-changed torn
    // class (the round-1 rule — a ppid-only change is never the reuse
    // class); the carried exact evidence classifies per the carried rules
    // downstream.
    if (readsAreExactForm(after)) {
      throw Object.assign(new Error('the exact fake-ZCode process ppid changed between reads'), {
        observedStartIdentity: after.startIdentity,
        observedIdentityTakenEpochMs: Number.isSafeInteger(after.observedIdentityTakenEpochMs)
          ? after.observedIdentityTakenEpochMs
          : takenEpochMs,
        observedIdentityCompletedEpochMs: Number.isSafeInteger(after.observedIdentityCompletedEpochMs)
          ? after.observedIdentityCompletedEpochMs
          : Date.now(),
      });
    }
    throw rideObservedIdentity(new Error('the exact fake-ZCode process ppid changed between reads'));
  }
  // (§32.14 Finding 1) the returned resolution is the JOINTLY VERIFIED one:
  // when the two reads' resolutions MIX (one exact, one degraded), the exact
  // identity was seen by only ONE read — a same-second PID replacement
  // between the reads would otherwise return the successor's exact identity
  // with the predecessor's verified nonce. The mixed-resolution return is
  // the COARSE form (the representation both reads verified, the second
  // read's own ps shape), matching the ps path's shape exactly.
  if (!bothReadsExact) {
    const coarseIdentity = comparableGenerationIdentity(after);
    // (codex gate round 12, Finding 1 — the EXACT-EVIDENCE CARRY) the
    // jointly verified coarse identity is the RETURNED identity, but when
    // the second read observed an EXACT identity it is separately preserved
    // (with its bounds) as an internal carry for replacement detection —
    // the same pattern as the carried-identity ride; the whitelisted
    // verdict fields carry it without a persisted-shape change. A later
    // confirmed absence then triggers the replacement detection instead of
    // crediting the original generation's disappearance.
    const result = { pid: after.pid, ppid: after.ppid, startIdentity: coarseIdentity, coarseStartIdentity: coarseIdentity, nonce: expectedNonce, takenEpochMs };
    // (codex gate round 13, Finding 2 — READ-ORDER-AGNOSTIC preservation)
    // whichever read supplied the exact identity, that observation and its
    // bounds are preserved as the replacement-detection carry — the
    // first-exact/second-degrades shape carries the FIRST read's exact
    // evidence exactly as the second-exact shape carries the second's.
    const exactSource = readsAreExactForm(after) ? after : before;
    if (readsAreExactForm(exactSource)) {
      (/** @type {any} */ (result)).observedStartIdentity = exactSource.startIdentity;
      (/** @type {any} */ (result)).observedIdentityTakenEpochMs = Number.isSafeInteger((/** @type {any} */ (exactSource)).observedIdentityTakenEpochMs)
        ? (/** @type {any} */ (exactSource)).observedIdentityTakenEpochMs
        : takenEpochMs;
      (/** @type {any} */ (result)).observedIdentityCompletedEpochMs = Number.isSafeInteger((/** @type {any} */ (exactSource)).observedIdentityCompletedEpochMs)
        ? (/** @type {any} */ (exactSource)).observedIdentityCompletedEpochMs
        : Date.now();
    }
    return result;
  }
  return { ...after, nonce: expectedNonce, takenEpochMs };
}

/**
 * Capture one exact process identity from a fake-ZCode process marker file:
 * the single shared entry point for the held-run lifecycle so capture,
 * re-verification, and termination all speak the same nonce-bearing shape.
 * The optional osSeams ride the marker's own OS re-verification (the same
 * closed surface the observation layer honors) — §33.7 finding 1 threads the
 * armed declaration's exact-reader opt-in through it, so a driver-side
 * capture resolves the marker generation at the SAME resolution the armed
 * chain's emitters capture, without any process environment mutation.
 * @param {string} processPath @param {string} processNonce
 * @param {{ kinfoExact?: (pid: number) => Promise<{ sec: number, usec: number } | { malformed: number } | null>, exactReaderOptIn?: boolean }} [osSeams]
 * @returns {Promise<{ pid: number, ppid: number, startIdentity: string, nonce: string }>}
 */
export async function captureVerifiedProcessIdentity(processPath, processNonce, osSeams = {}) {
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
    observed = await inspectVerifiedProcessIdentity(marker.pid, processNonce, FAKE_ZCODE_NONCE_VARIABLE, osSeams);
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
 * The observer seam options the DEFAULT termination reader honors (codex gate
 * round 27, Finding 2): the same closed shape the inspection layer accepts —
 * the deterministic test surface reaches the default reader's actual protocol.
 * @typedef {{
 *   platform?: string,
 *   ps?: (pid: number) => Promise<{ pid: number, ppid: number, lstart: string }>,
 *   environ?: 'present' | 'mismatch' | 'gone',
 *   runProcess?: osSeamsRunProcess,
 *   kinfoExact?: (pid: number) => Promise<{ sec: number, usec: number } | { malformed: number } | null>,
 *   exactReaderOptIn?: boolean,
 *   abortSignal?: { aborted: boolean },
 * }} TerminationInspectOsSeams
 */

/**
 * Terminate one exact process after re-verifying its identity; escalate to
 * SIGKILL only while the identity still matches, verify exit after every
 * signal within a bounded deadline, and return an explicit outcome: a thrown
 * signal is never a success while the process is still live, and a process
 * that survives SIGKILL verification is reported as a failure for the caller
 * to record.
 * @param {{ pid: number, ppid: number, nonce: string, startIdentity: string, observedStartIdentity?: string }} identity
 * @param {{ readIdentity?: (expected: unknown) => Promise<unknown>, kill?: (pid: number, signal: NodeJS.Signals) => boolean, waitForExit?: (identity: unknown, phase: 'terminate' | 'kill', trackedRead?: (expected: unknown) => Promise<unknown>) => Promise<void>, learnedExactReference?: string, generationChanged?: boolean, inspectOsSeams?: TerminationInspectOsSeams }} [dependencies]
 * @returns {Promise<TerminationOutcome>}
 */
export async function terminateVerifiedProcess(identity, dependencies = {}) {
  // (codex gate round 20, Finding 1 — the TERMINATION LEARNED-REFERENCE
  // RETENTION) with a coarse captured identity, each termination read
  // INDEPENDENTLY accepts any exact generation from that second — cleanup
  // could observe exact generation A, send it SIGTERM, then observe the
  // same-second successor B and send B SIGKILL. The termination sequence
  // RETAINS the exact identities learned across its reads (the established
  // learned-reference pattern) and cross-checks every subsequent read
  // against them: the FIRST exact identity observed during termination —
  // the read's carried identity first (it was observed during the read),
  // then the read's own (the runtime's learning order) — becomes the
  // reference, and a later exact identity definitively differing from it is
  // the generation-changed fact (the reuse evidence preserved per the
  // round-14/28 carried rules). The flag fires at the read that observed
  // the successor: the escalation must not signal it.
  // (codex gate round 27, Finding 2 — HOISTED above the default reader) the
  // tracker state now precedes the default readIdentity definition so the
  // default reader's observed-then-gone conversion can forward the carried
  // identity through the tracker BEFORE converting the error to absence.
  let terminationLearnedExactReference = /** @type {string | null} */ (null);
  // (codex gate round 25, Finding 2 — the PRE-PROVEN LATCH) a caller whose
  // lifetime reads already proved a generation change this turn (the
  // driver's terminal-turn latch) initializes the tracker with the change
  // LATCHED: every established gate (the pre-signal verdict gate, the
  // post-SIGTERM latch check, the escalation gate) refuses, so a
  // degraded-to-MATCHING-coarse-ps cleanup read can never re-authorize a
  // signal against the proven replacement, and the replacement's own
  // disappearance is never credited as the target's exit (the round-20/21
  // standing rule, applied to the pre-proven fact).
  let terminationGenerationChanged = dependencies.generationChanged === true;
  const readIdentity = dependencies.readIdentity ?? (async (expected) => {
    try {
      // (codex gate round 27, Finding 2 — the OBSERVER SEAM SURFACE) the
      // default reader honors the SAME observer seam options the inspection
      // layer honors (the round-14 Finding-1 discipline the driver's default
      // reader already applies): the deterministic test surface reaches the
      // default reader's actual protocol.
      return await inspectVerifiedProcessIdentity(/** @type {any} */ (expected).pid, /** @type {any} */ (expected).nonce, FAKE_ZCODE_NONCE_VARIABLE, dependencies.inspectOsSeams ?? {});
    } catch (error) {
      // (codex gate round 27, Finding 2 — the CONSUME-BEFORE-ABSENCE rule,
      // mirroring the driver's separate reader) the round-28 observed-then-gone
      // conversion now CROSS-CHECKS the error's carried identity FIRST: the
      // inspector's observed-then-gone error carries the exact identity it
      // observed before the pid vanished. A carried identity that definitively
      // differs from the learned reference is the generation-change evidence —
      // the latch sets through the SAME tracker state every read consumes — so
      // the gone-check's post-read gate never credits the replacement's absence
      // as the target's lawful exit (the capture seeded with exact A then
      // reading the observed-then-gone successor B returns the named
      // identity-change failure, never the clean exited outcome). A matching
      // carry (the genuinely-gone original), a non-exact carry, or no carry
      // keeps the round-28 exited shape unchanged. A carry observed with NO
      // reference yet seeds it (the round-25 Finding-3 learning order), so a
      // later read cross-checks against it.
      if (/** @type {any} */ (error)?.observedThenGone === true) {
        const carriedGoneIdentity = typeof (/** @type {any} */ (error))?.observedStartIdentity === 'string'
          ? (/** @type {any} */ (error)).observedStartIdentity
          : null;
        if (carriedGoneIdentity !== null) {
          // (codex gate round 30, Finding 1 — the COARSE-CARRY COMPARISON)
          // the exact-form guard previously required the CARRIED identity to
          // be exact, so when the exact bridge became unavailable and the
          // degraded ps read observed a coarse identity from a demonstrably
          // DIFFERENT second before the environment read found the pid gone,
          // the replacement evidence was discarded and the absence was
          // credited as the target's clean exit. Every carried identity is
          // now compared against the retained EXACT reference with the
          // established representation-aware startIdentitiesDefinitivelyDiffer
          // rule (an exact reference side; the carry — exact or coarse —
          // compared at the exact side's second resolution, the same rule a
          // live double-read applies): a definitive difference latches and
          // the gone-check's post-read gate returns the named
          // identity-change failure. A coarse carry in the reference's own
          // second (the non-definitive 'same' relation) and a non-exact
          // reference prove no difference and keep the round-28 exited shape
          // unchanged. Only an EXACT carry initializes the retained
          // reference (the existing exact-retention contract).
          // (codex gate round 37 review-mwc4sfh6-fx3ggt, Finding 3 — the
          // CAPTURE COMPARISON) the carried identity is ALSO compared against
          // the CAPTURE's own start identity before it is learned or the
          // error is converted to absence: a COARSE capture (a whole-second ps
          // text) with no learned exact reference previously bypassed every
          // comparison, so the exact bridge recovering on the first
          // termination read could observe a DIFFERENT-second successor, the
          // conversion learned that successor as the initial reference, and
          // the turn returned a clean exit despite proving a different
          // generation. The representation-aware relation applies (an exact
          // side against the coarse second: a different second is definitively
          // different; the capture's own second and an unresolvable pair stay
          // non-definitive), and an exact capture's own evidence is already
          // part of the retained reference through the capture seeding above.
          const captureGenerationChanged = typeof /** @type {any} */ (expected).startIdentity === 'string'
            && startIdentitiesDefinitivelyDiffer(carriedGoneIdentity, /** @type {any} */ (expected).startIdentity);
          if (captureGenerationChanged
            || (typeof terminationLearnedExactReference === 'string'
              && parseExactStartIdentity(terminationLearnedExactReference) !== null
              && startIdentitiesDefinitivelyDiffer(carriedGoneIdentity, terminationLearnedExactReference))) {
            terminationGenerationChanged = true;
          }
          if (parseExactStartIdentity(carriedGoneIdentity) !== null && terminationLearnedExactReference === null) {
            terminationLearnedExactReference = carriedGoneIdentity;
          }
        }
        // ROUND-28: a mid-read disappearance during termination verification
        // is the exited shape (the pid is gone; termination gates signalling
        // and has no adjudication to latch for).
        return undefined;
      }
      throw error;
    }
  });
  const kill = dependencies.kill ?? ((pid, signal) => process.kill(pid, signal));
  // (codex gate round 22, Finding 1 — the SHARED LIFETIME SEED) the caller's
  // held-turn lifetime reference (the exact generation the reader learned
  // BEFORE termination began — the held-phase verification's exact A) seeds
  // the tracker FIRST: the termination tracker never learns as an initial
  // reference a generation the lifetime already retained. The capture's own
  // exact identity and carry (the round-21 seeding below) are cross-checked
  // against this seed exactly like subsequent reads.
  if (typeof dependencies.learnedExactReference === 'string'
    && parseExactStartIdentity(dependencies.learnedExactReference) !== null) {
    terminationLearnedExactReference = dependencies.learnedExactReference;
  }
  const trackTerminationRead = async (/** @type {any} */ expected) => {
    let record;
    try {
      record = await readIdentity(expected);
    } catch (error) {
      // (codex gate round 23, Finding 1 — the ERROR-CARRIED IDENTITY
      // CONSUMPTION) when a read's inspector THROWS while carrying the
      // observed identity (`observedStartIdentity` — the mid-read
      // identity-change shape), the throw must never bypass the tracker: the
      // error-carried identity is CONSUMED here — compared against the
      // learned reference exactly like a returned record (definitively
      // different latches the generation change) — BEFORE the error
      // propagates. Without this, an exit-polling inspector error carrying a
      // same-second successor escaped the tracker entirely: the surrounding
      // waitForExit catch permitted escalation, a degraded-to-matching-ps
      // pre-kill verification passed, and SIGKILL reached the successor
      // despite the intervening exact replacement evidence.
      const carriedIdentity = typeof /** @type {any} */ (error)?.observedStartIdentity === 'string'
        ? /** @type {any} */ (error).observedStartIdentity : null;
      if (carriedIdentity !== null && parseExactStartIdentity(carriedIdentity) !== null) {
        // (codex gate round 34 review-mwbhnnxl-21lsyh, Finding 1 — the
        // WITHIN-READ TRANSITION LATCH) an error of the inspector's OWN
        // identity-change class ('identity changed' — the double-read
        // mismatch, the second-read failure comparison, and the composition
        // disagreement alike) carries a PROVEN within-read A→B transition:
        // the read itself positively compared two generations and refused.
        // When NO reference has been learned yet (the coarse capture + coarse
        // early cleanup reads shape), that transition is the replacement
        // evidence and LATCHES here — it is never treated as an initial
        // unchanged observation seeding the reference. The former seeding let
        // a subsequent same-nonce verification of the successor B pass
        // against the coarse capture and authorize SIGKILL against the
        // proven replacement (both signals fired). A non-transition error's
        // exact carry keeps the existing seeding and comparison behavior
        // byte-unchanged (the lawful first-exact learning), and a
        // with-reference transition consumption keeps the round-23
        // comparison (a carried SAME-generation identity never latches).
        if (terminationLearnedExactReference === null) {
          if (/identity changed/u.test(/** @type {Error} */ (error).message)) {
            terminationGenerationChanged = true;
          } else {
            // (codex gate round 39 review-mwcrgo5m-8t4hr1, Finding 1 — the
            // CAPTURE COMPARISON before the error-carry seeding) a FAILED
            // inspection's exact carry (the ps-failure observedThenQueryFailed
            // shape among them) is compared against the CAPTURED generation —
            // its own start identity and its exact carry — BEFORE the carry
            // initializes the learned reference: a coarse capture with no
            // learned reference previously let a different-second successor
            // exposed by the failed inspection be LEARNED as the initial
            // generation, and the following absence returned
            // `exited: true, failure: null` despite the proven replacement.
            // The representation-aware relation applies (an exact side
            // against the coarse second: a different second is definitively
            // different; the capture's own second and an unresolvable pair
            // stay non-definitive). Same-generation carries keep the lawful
            // seeding; this mirrors the observed-then-gone and held-turn
            // capture comparisons (round 37 Finding 3 / round 38 Finding 1).
            const carryCaptureForeign = [
              /** @type {any} */ (identity).observedStartIdentity,
              /** @type {any} */ (identity).startIdentity,
            ].some((captureIdentity) => typeof captureIdentity === 'string'
              && startIdentitiesDefinitivelyDiffer(carriedIdentity, captureIdentity));
            if (carryCaptureForeign) {
              terminationGenerationChanged = true;
            } else {
              terminationLearnedExactReference = carriedIdentity;
            }
          }
        } else if (startIdentitiesDefinitivelyDiffer(carriedIdentity, terminationLearnedExactReference)) {
          terminationGenerationChanged = true;
        }
      } else if (carriedIdentity !== null) {
        // (codex gate round 45 review-mwdm7a6g-7jhabk, Finding 1 — the
        // COARSE-CAPTURE COMPARISON) with a COARSE capture and coarse
        // pre-signal reads there is no retained reference; the bridge
        // recovering during the SIGTERM polling can then observe the
        // ORIGINAL generation in kinfo while the subsequent ps query observes
        // a DIFFERENT-second successor, and the composition refusal carries
        // that successor's COARSE identity. The coarse branch previously
        // required a non-null reference, so the evidence was ignored and the
        // following absence returned `exited: true, failure: null` despite
        // the proven replacement. A coarse carry with NO retained reference
        // is now compared against the CAPTURED identity and its exact carry
        // (representation-aware: coarse-vs-coarse different text, or
        // exact-vs-coarse different second, is definitively different; the
        // capture's own second and an unresolvable pair stay non-definitive)
        // — the same protocol family as the round-39/44 capture comparisons.
        // The with-reference consumption keeps its existing comparison.
        const coarseCarryCaptureChanged = [
          /** @type {any} */ (identity).observedStartIdentity,
          /** @type {any} */ (identity).startIdentity,
        ].some((captureIdentity) => typeof captureIdentity === 'string'
          && startIdentitiesDefinitivelyDiffer(carriedIdentity, captureIdentity));
        if (coarseCarryCaptureChanged
          || (terminationLearnedExactReference !== null
            && startIdentitiesDefinitivelyDiffer(carriedIdentity, terminationLearnedExactReference))) {
          // (codex gate round 36 review-mwbzhfmk-bxkb77, Finding 1 — the
        // COARSE-CARRY COMPARISON) a kinfo/ps generation disagreement's
        // refusal carries the LATER, COARSE ps identity (the round-33-
        // followup later-read carry). The exact-only guard above ignored that
        // evidence and left the replacement latch unset: with an exact
        // `kinfo:1:100000` target and a ps observation from a DIFFERENT
        // second during the exit polling, the subsequent absence was credited
        // as the target's lawful exit (`exited: true, failure: null`) despite
        // the positively observed replacement. A COARSE carry is now compared
        // against the retained exact reference with the SAME
        // representation-aware relation (exact side against the coarse
        // second: a different second is definitively different; the
        // reference's own second or an unresolvable carry is never positive
        // evidence). Only REFERENCE INITIALIZATION remains exact-only; the
        // no-reference case is covered by the round-45 capture comparison
        // above (compared against the captured identity, never seeded).
        terminationGenerationChanged = true;
        }
      }
      throw error;
    }
    if (record !== null && typeof record === 'object') {
      for (const candidate of [/** @type {any} */ (record).observedStartIdentity, /** @type {any} */ (record).startIdentity]) {
        if (typeof candidate !== 'string') continue;
        if (parseExactStartIdentity(candidate) !== null) {
          // (codex gate round 44 review-mwdihq4h-ej561x, Finding 1 — the
          // CAPTURE COMPARISON BEFORE THE SUCCESS CANDIDATE SEEDING) with a
          // coarse capture and coarse pre-signal reads, the exact reader can
          // recover during the SIGTERM polling and observe a different-second
          // successor: this success-return loop previously seeded it as the
          // initial reference without comparing it against the CAPTURED
          // generation, so a second-1 capture followed by an exact second-2
          // observation and absence returned `exited: true, failure: null`.
          // The candidate is compared against the capture's own identity and
          // its exact carry with the representation-aware relation (an exact
          // side against the coarse second: a different second is
          // definitively different) BEFORE initializing the reference — the
          // same protocol the round-43 error-carry path and the round-39/42
          // termination comparisons apply. Same-generation or unresolvable
          // candidates keep the lawful seeding.
          const candidateCaptureChanged = [
            /** @type {any} */ (identity).observedStartIdentity,
            /** @type {any} */ (identity).startIdentity,
          ].some((captureIdentity) => typeof captureIdentity === 'string'
            && startIdentitiesDefinitivelyDiffer(candidate, captureIdentity));
          if (candidateCaptureChanged) {
            terminationGenerationChanged = true;
            continue;
          }
          if (terminationLearnedExactReference === null) {
            terminationLearnedExactReference = candidate;
            continue;
          }
          if (startIdentitiesDefinitivelyDiffer(candidate, terminationLearnedExactReference)) {
            terminationGenerationChanged = true;
          }
          continue;
        }
        // (codex gate round 42 review-mwdbbf0x-xry6ea, Finding 1 — the
        // RETURNED COARSE COMPARISON) a SUCCESSFUL inspection's returned
        // coarse identity (the exact bridge unavailable during the exit
        // polling, the degraded ps text) is replacement evidence when it
        // definitively differs from the retained exact reference — the
        // exact-only guard above discarded it, so a double-verified ps
        // identity from a DIFFERENT second followed by absence reported
        // `exited: true, failure: null` despite the observed PID reuse. The
        // returned coarse candidate is compared with the SAME
        // representation-aware relation (an exact reference side: a
        // different second is definitively different; the reference's own
        // second or an unresolvable pair is never positive evidence) and
        // latches on a definitive difference. Only REFERENCE
        // INITIALIZATION remains exact-only — a coarse candidate with no
        // retained reference still seeds nothing.
        if (terminationLearnedExactReference !== null
          && startIdentitiesDefinitivelyDiffer(candidate, terminationLearnedExactReference)) {
          terminationGenerationChanged = true;
        }
      }
    }
    return record;
  };
  // (codex gate round 21, Finding 1 — the CAPTURE SEEDING) the tracker is
  // SEEDED from the capture's own exact identity AND exact carry (the
  // {identity, bounds} unit the capture preserved) BEFORE the first
  // termination read: every subsequent observation — the initial gone-check
  // included — is COMPARED against the seed, never learned as the first.
  // Without the seed, a capture identifying exact generation A let a
  // same-second successor B observed by the gone-check initialize the
  // reference to B, and a verification that degraded to the matching coarse
  // ps text then authorized SIGTERM against B. The seeding order mirrors
  // the runtime's learning order (the carried identity first — the
  // preserved exact evidence — then the capture's own); a capture whose own
  // exact identity and carry definitively differ is self-contradictory and
  // flags the generation change fail-closed.
  if (typeof /** @type {any} */ (identity).observedStartIdentity === 'string'
    && parseExactStartIdentity(/** @type {any} */ (identity).observedStartIdentity) !== null) {
    if (terminationLearnedExactReference === null) {
      terminationLearnedExactReference = /** @type {any} */ (identity).observedStartIdentity;
    } else if (startIdentitiesDefinitivelyDiffer(/** @type {any} */ (identity).observedStartIdentity, /** @type {any} */ (terminationLearnedExactReference))) {
      terminationGenerationChanged = true;
    }
  }
  if (typeof /** @type {any} */ (identity).startIdentity === 'string'
    && parseExactStartIdentity(/** @type {any} */ (identity).startIdentity) !== null) {
    if (terminationLearnedExactReference === null) {
      terminationLearnedExactReference = /** @type {any} */ (identity).startIdentity;
    } else if (startIdentitiesDefinitivelyDiffer(/** @type {any} */ (identity).startIdentity, /** @type {any} */ (terminationLearnedExactReference))) {
      terminationGenerationChanged = true;
    }
  }
  const waitForExit = dependencies.waitForExit ?? (async (expected, phase) => {
    const deadline = Date.now() + (phase === 'kill' ? 5_000 : 2_000);
    while (Date.now() < deadline) {
      if (await trackTerminationRead(expected) === undefined) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`the exact verified process remained alive during ${phase}`);
  });
  /** @type {TerminationOutcome} */
  const outcome = { attempted: false, signalled: null, exited: false, failure: null };
  // A disappeared target needs no signal and counts as exited; a live target
  // whose identity changed is never signalled and is reported as a failure.
  if (await trackTerminationRead(identity) === undefined) {
    // (codex gate round 25, Finding 2 — the PRE-PROVEN LATCH) a latched
    // generation change is terminal: the vanished pid is the PROVEN
    // replacement's absence, never the target's exit (the round-20/21
    // standing rule — the same gate the escalation arm applies below).
    if (terminationGenerationChanged) {
      outcome.failure = 'the exact fake-ZCode process identity changed during termination';
      return outcome;
    }
    outcome.exited = true;
    return outcome;
  }
  // (codex gate round 5, Finding 1) the verdict is CLASSIFIED: an
  // unresolvable verification ('unverifiable') is reported honestly — it is
  // not an observed identity change — while a demonstrably different
  // generation (or a vanished target) keeps the identity-change failure.
  // (codex gate round 20, Finding 1) the learned-reference cross-check
  // participates in the same gate: a mid-sequence read that definitively
  // differed from the reference generation is the identity-change fact —
  // the signal never fires.
  const preSignalVerdict = await verifyUnchanged(identity, trackTerminationRead);
  if (preSignalVerdict !== 'unchanged' || terminationGenerationChanged) {
    outcome.failure = preSignalVerdict === 'unverifiable' && !terminationGenerationChanged
      ? 'the exact fake-ZCode process identity could not be verified before signalling'
      : 'the exact fake-ZCode process identity changed before signalling';
    return outcome;
  }
  outcome.attempted = true;
  try {
    kill(identity.pid, 'SIGTERM');
    outcome.signalled = 'SIGTERM';
  } catch (error) {
    // A thrown signal is not a success while the process is still live.
    // (codex gate round 29, Finding 1 — the POST-READ LATCH RECHECK AT THE
    // SIGNAL-THROW ABSENCE CONVERSION) the awaited tracked read can observe
    // an exact successor and set the termination latch DURING the await (the
    // default reader's observed-then-gone conversion). The latch is rechecked
    // AFTER the absence is collected and BEFORE the exit is credited: a
    // latched change is the proven replacement, never the target's exit (the
    // same rule the escalation absence conversion applies).
    if (await trackTerminationRead(identity) === undefined) {
      if (terminationGenerationChanged) {
        outcome.failure = 'the exact fake-ZCode process identity changed during termination';
        return outcome;
      }
      outcome.exited = true;
      return outcome;
    }
    outcome.failure = `SIGTERM could not be signalled (${error instanceof Error ? error.message : String(error)}) and the exact fake-ZCode process remains live`;
    return outcome;
  }
  try {
    // (codex gate round 21, Finding 2 — the SUPPLIED POLLING FEEDS THE
    // TRACKER) the supplied waitForExit RECEIVES the tracking reader as its
    // third argument: a caller whose polling reads identities directly (the
    // driver's waitForProcessExit) polls THROUGH the same retained-generation
    // tracker, so the polling evidence participates in the reference
    // cross-check instead of bypassing it. The default waitForExit already
    // closes over the tracker (the argument is uniform for both shapes).
    // (codex gate round 21, Finding 3 — the LATCH IS TERMINAL FOR EXIT
    // VERIFICATION) a latched generation change is terminal for the WHOLE
    // termination: an exit verification that resolves after the latch (the
    // successor observed, then the pid gone) never returns the clean
    // exited:true/failure:null — the proven replacement is the outcome per
    // the standing changed-during-termination classification.
    await waitForExit(identity, 'terminate', trackTerminationRead);
    if (terminationGenerationChanged) {
      outcome.failure = 'the exact fake-ZCode process identity changed during termination';
      return outcome;
    }
    outcome.exited = true;
    return outcome;
  } catch { /* escalate only the still-matching PID */ }
  // (codex gate round 20, Finding 1 — the ESCALATION GATE) the pre-kill
  // verification consults the learned reference too: a same-second successor
  // observed mid-sequence (during the exit polling or this verification) is
  // the generation-changed fact — the escalation must not signal it, and the
  // pid's disappearance after a proven replacement is never credited as the
  // target's exit (the changed-during-termination classification).
  const preKillVerdict = await verifyUnchanged(identity, trackTerminationRead);
  if (preKillVerdict !== 'unchanged' || terminationGenerationChanged) {
    // (codex gate round 28, Finding 1 — the POST-READ LATCH RECHECK) this
    // absence conversion AWAITS a tracked read, and the default reader's
    // observed-then-gone conversion can detect an exact successor, set the
    // termination latch, and return undefined DURING that await (the round-27
    // consume-before-absence rule). The latch check therefore belongs AFTER
    // the absence result is collected and BEFORE the exit is credited: a
    // latched generation change is the proven replacement, never the target's
    // exit. (The pre-await shape returned exited:true/failure:null after an
    // unverifiable pre-kill read followed by an observed-then-gone
    // successor.)
    let gone = false;
    if (!terminationGenerationChanged) {
      if (preKillVerdict === 'gone') {
        gone = true;
      } else if (await trackTerminationRead(identity) === undefined) {
        gone = !terminationGenerationChanged;
      }
    }
    outcome.exited = gone;
    if (!gone) {
      outcome.failure = preKillVerdict === 'unverifiable' && !terminationGenerationChanged
        ? 'the exact fake-ZCode process identity could not be verified during termination'
        : 'the exact fake-ZCode process identity changed during termination';
    }
    return outcome;
  }
  try {
    kill(identity.pid, 'SIGKILL');
    outcome.signalled = 'SIGKILL';
  } catch (error) {
    // (codex gate round 29, Finding 1 — the POST-READ LATCH RECHECK AT THE
    // SIGNAL-THROW ABSENCE CONVERSION) the same post-read recheck as the
    // SIGTERM catch: a successor latched during the awaited absence read is
    // the proven replacement, never the target's exit.
    if (await trackTerminationRead(identity) === undefined) {
      if (terminationGenerationChanged) {
        outcome.failure = 'the exact fake-ZCode process identity changed during termination';
        return outcome;
      }
      outcome.exited = true;
      return outcome;
    }
    outcome.failure = `SIGKILL could not be signalled (${error instanceof Error ? error.message : String(error)}) and the exact fake-ZCode process remains live`;
    return outcome;
  }
  try {
    await waitForExit(identity, 'kill', trackTerminationRead);
    if (terminationGenerationChanged) {
      outcome.failure = 'the exact fake-ZCode process identity changed during termination';
      return outcome;
    }
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
 * @param {{ pid: number, ppid: number, nonce: string, startIdentity: string, observedStartIdentity?: string }} identity
 * @param {(expected: unknown) => Promise<unknown>} readIdentity
 * @returns {Promise<'unchanged' | 'changed' | 'unverifiable' | 'gone'>}
 *   'unchanged' only when the target is live and POSITIVELY verified as the
 *   same generation; 'changed' on a demonstrably different generation (or a
 *   pid/ppid/nonce divergence); 'unverifiable' when the read cannot resolve
 *   the generation comparison at any resolution; 'gone' when the read
 *   observed no live process.
 */
async function verifyUnchanged(identity, readIdentity) {
  const observed = await readIdentity(identity);
  if (observed === undefined || observed === null) return 'gone';
  const record = /** @type {any} */ (observed);
  if (record.pid !== identity.pid || record.ppid !== identity.ppid) return 'changed';
  // (§32.14 Finding 3) the REPRESENTATION-AWARE generation comparison: a
  // kinfo-captured identity vs a degraded-to-MATCHING-ps verification is the
  // SAME generation — the raw-string comparison failed verification and
  // blocked cleanup of a still-live target (attempted: false, no signal).
  // (codex gate round 5, Finding 1 — the FAIL-CLOSED POSITIVE-SAME rule)
  // the guard requires the relation POSITIVELY 'same' before any signal: an
  // unresolvable pair (the UNCERTAIN relation — e.g. an exact kinfo-bound
  // target whose termination reader returns an unparseable identity) cannot
  // verify the termination's target and leaves it UNSIGNALLED — uncertainty
  // never permits signalling, it is reported as the honest unverifiable
  // classification. A demonstrably different generation still fails
  // fail-closed as before.
  if (typeof record.startIdentity !== 'string') return 'unverifiable';
  const generationRelation = startIdentityGenerationRelation(record.startIdentity, identity.startIdentity);
  if (generationRelation === 'different') return 'changed';
  if (generationRelation !== 'same') return 'unverifiable';
  // (codex gate round 13, Finding 1 — the CARRIED-SUCCESSOR GUARD) a
  // mixed-resolution verification can return matching ps text alongside a
  // SEPARATELY PRESERVED exact identity that proves PID replacement — the
  // coarse second matching never authorizes signalling a carried successor.
  // The carried exact identity is checked before authorizing either signal.
  if (typeof record.observedStartIdentity === 'string'
    && startIdentitiesDefinitivelyDiffer(record.observedStartIdentity, identity.startIdentity)) return 'changed';
  // (codex gate round 18, Finding 1 — the CAPTURE'S CARRIED EXACT IDENTITY)
  // a mixed-resolution CAPTURE preserves its exact generation A in
  // identity.observedStartIdentity while identity.startIdentity stays
  // coarse: the verification evidence (the returned startIdentity and its
  // own carried identity, either) is compared against that carried exact
  // generation — a later exact generation B from the same second compares
  // as same against the coarse capture but definitively differs from A.
  if (typeof identity.observedStartIdentity === 'string'
    && parseExactStartIdentity(identity.observedStartIdentity) !== null) {
    if (typeof record.startIdentity === 'string'
      && startIdentitiesDefinitivelyDiffer(record.startIdentity, identity.observedStartIdentity)) return 'changed';
    if (typeof record.observedStartIdentity === 'string'
      && startIdentitiesDefinitivelyDiffer(record.observedStartIdentity, identity.observedStartIdentity)) return 'changed';
  }
  if (record.nonce !== identity.nonce) return 'changed';
  return 'unchanged';
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
 * path (a record without the member cannot bind the marker's generation).
 * v3 (route (c), §32, 2026-11-05) adds the additive `startIdentityExact`
 * member: a STRICT boolean declaring whether the record's captured start
 * identities and `childOsStartInstantMs` are the EXACT kinfo form (true) or
 * the coarse whole-second form (false). v1/v2 records replay coarse-only —
 * exact mode is never inferred for a record that did not declare it. */
export const SPAWN_ANCESTRY_WITNESS_VERSION = 3;

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
 *   startIdentityExact?: boolean,
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
  // (route (c), §32) v3 = v2 + the additive EXACT-members flag: the
  // record's childStartIdentity and childOsStartInstantMs are the EXACT
  // kinfo identity/instant. v2 records replay coarse-only.
  const v3Required = ['boundaryEpochMs', 'childNonce', 'childOsStartInstantMs', 'childPid', 'childPpid', 'childStartIdentity', 'class', 'firstWriteEpochMs', 'firstWritePreciseMs', 'nonce', 'role', 'startIdentityExact', 'startOriginMs', 'version', 'writerPid', 'writerStartIdentity'];
  const required = record.version === 1 ? v1Required : record.version === 2 ? v2Required : record.version === SPAWN_ANCESTRY_WITNESS_VERSION ? v3Required : null;
  if (required === null || keys.join(',') !== required.join(',')) return { ok: false, reason: 'spawn-witness-shape-invalid' };
  if (record.class !== 'spawn-ancestry-witness') return { ok: false, reason: 'spawn-witness-shape-invalid' };
  if (record.version !== 1 && record.version !== 2 && record.version !== SPAWN_ANCESTRY_WITNESS_VERSION) return { ok: false, reason: 'spawn-witness-shape-invalid' };
  // (route (c)) the v3 EXACT-members flag: a STRICT BOOLEAN (true = the
  // exact kinfo identity/instant; false = the coarse capture — the flag
  // DECLARES the exactness either way, so a coarse v3 record replays
  // honestly). v2 records replay coarse-only.
  if (record.version === SPAWN_ANCESTRY_WITNESS_VERSION && record.startIdentityExact !== true && record.startIdentityExact !== false) return { ok: false, reason: 'spawn-witness-shape-invalid' };
  // The v2 numeric child OS start instant: a positive epoch millisecond, or
  // the named-absent null (an unresolvable parse is recorded AS absent — the
  // join's marker binding refuses rather than guessing, §26.7 item 3/5).
  // (§32.11 Finding 1) VERSION-UNGATED across v2 and v3: the version bump
  // (2 → 3) must never loosen v2's existing validation — a retained v2
  // record with a non-numeric instant refused exactly as the base commit
  // refused it (the version-gated form let 'garbage' ride admission and
  // establish hop 1 with the later numeric checks silently skipping it).
  if ((record.version === 2 || record.version === SPAWN_ANCESTRY_WITNESS_VERSION)
    && record.childOsStartInstantMs !== null
    && (!Number.isSafeInteger(record.childOsStartInstantMs) || /** @type {number} */ (record.childOsStartInstantMs) <= 0)) {
    return { ok: false, reason: 'spawn-witness-shape-invalid' };
  }
  // (route (c) — EXACT-vs-RAW SELF-CONSISTENCY) a v3 record declaring
  // `startIdentityExact: true` must actually carry the exact evidence it
  // declares: BOTH captured start identities are the closed
  // `kinfo:<sec>:<usec>` form, and the numeric child OS start instant is
  // non-null and EQUALS the instant derived from the child identity (the
  // emitter derives both from the same boundary read). A lying flag, a
  // coarse identity, or a raw numeric disagreeing with the exact identity is
  // the record's own contradiction — refused at admission rather than
  // silently demoted (exact evidence never rides an inconsistent record).
  if (record.version === SPAWN_ANCESTRY_WITNESS_VERSION && record.startIdentityExact === true) {
    const writerExact = parseExactStartIdentity(record.writerStartIdentity);
    const childExact = parseExactStartIdentity(record.childStartIdentity);
    if (writerExact === null || childExact === null
      || !Number.isSafeInteger(record.childOsStartInstantMs)
      || /** @type {number} */ (record.childOsStartInstantMs) !== childExact.ms) {
      return { ok: false, reason: 'spawn-witness-shape-invalid' };
    }
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
  // (the round-25 self-consistency, version-ungated) the contradiction is
  // in the MEMBER: any record carrying childOsStartInstantMs refuses when
  // its child creation postdates its own capture boundary.
  if (record.childOsStartInstantMs !== null
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
      ...(record.startIdentityExact === undefined ? {} : { startIdentityExact: /** @type {boolean} */ (record.startIdentityExact) }),
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
 *   osSeams?: { platform?: string, ps?: (pid: number) => Promise<{ pid: number, ppid: number, lstart: string }>, environ?: 'present' | 'mismatch' | 'gone', runProcess?: osSeamsRunProcess, exactReaderOptIn?: boolean },
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
  // (§32.13 Finding 3) the RETAINED-SET comparison is the REPRESENTATION-
  // AWARE generation relation, not a spelling set: for a candidate identity,
  // ANY retained prior that DEFINITIVELY differs latches the terminal
  // refusal; ANY retained prior that is the SAME generation retains (the
  // candidate joins the retained spellings — a degraded-to-matching-ps read
  // of an unchanged child is the same generation, never a contradiction);
  // ONLY-UNCERTAIN candidates (an exact form against an unresolvable
  // string) are NON-DECIDING — neither latch nor retain (the spelling
  // proves nothing and must not poison later comparisons). Genuine
  // replacement latching is preserved: a different exact instant or a
  // different-second ps text definitively differs.
  /** @param {Set<string>} retained @param {string} identity @returns {'retained' | 'changed' | 'uncertain'} */
  const retainedIdentityVerdict = (retained, identity) => {
    let sawSame = false;
    for (const prior of retained) {
      const relation = startIdentityGenerationRelation(identity, prior);
      if (relation === 'different') return 'changed';
      if (relation === 'same') sawSame = true;
      // 'uncertain' against one prior proves nothing by itself — the
      // aggregate below decides (any 'same' retains; all-'uncertain' is the
      // non-deciding verdict).
    }
    return sawSame ? 'retained' : 'uncertain';
  };
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
        // (codex gate round 7, Finding 3 — the RETAINED-SET MEMBERSHIP rule)
        // the verdict governs BOTH decisions: 'changed' latches the terminal
        // refusal; an ONLY-UNCERTAIN candidate (a nonempty history whose
        // every relation is uncertain) is NON-DECIDING and must NOT join the
        // retained set — an unparseable ride retained beside an exact
        // generation made every later candidate 'different' by the raw
        // spelling comparison and poisoned the history (the final
        // matching-ps retry refused against the unparseable string even
        // though it matched the original exact generation). The set holds
        // only decision-grade observations; the FIRST observation grounds
        // the history (an empty set retains — the §26.6 grounding the
        // successor latch depends on).
        const retainedVerdict = retainedChildIdentities.size > 0 ? retainedIdentityVerdict(retainedChildIdentities, observedIdentity) : 'first';
        if (retainedVerdict === 'changed') {
          childGenerationChanged = true;
          break;
        }
        if (retainedVerdict !== 'uncertain') retainedChildIdentities.add(observedIdentity);
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
      // (codex gate round 7, Finding 3) the same membership rule on the
      // success path — an only-uncertain verified identity does not join
      // (inert here: the loop breaks below and the poll-scoped set is never
      // consulted again, but the rule is uniform).
      const retainedVerdict = retainedChildIdentities.size > 0 ? retainedIdentityVerdict(retainedChildIdentities, childVerified.startIdentity) : 'first';
      if (retainedVerdict === 'changed') {
        childGenerationChanged = true;
        break;
      }
      // (codex gate round 13, Finding 4 — the SUCCESS-PATH EXACT CARRY) a
      // successful mixed-read downgrade returns the coarse identity but
      // CARRIES the observed exact evidence separately — it is compared
      // against the retained history too: definitively different from a
      // retained exact generation fires the generation-change refusal (the
      // replacement child is never certified through the downgrade's coarse
      // acceptance); same ⇒ accept.
      if (typeof /** @type {any} */ (childVerified).observedStartIdentity === 'string'
        && retainedChildIdentities.size > 0
        && retainedIdentityVerdict(retainedChildIdentities, /** @type {any} */ (childVerified).observedStartIdentity) === 'changed') {
        childGenerationChanged = true;
        break;
      }
      if (retainedVerdict !== 'uncertain') retainedChildIdentities.add(childVerified.startIdentity);
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
    startIdentityExact: isExactStartIdentity(childVerified.startIdentity)
      && isExactStartIdentity(writerVerified.startIdentity),
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
export function parseLstartAsUtc(startIdentity) {
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
 * The production EXACT COMPOSITION agreement (shared by BOTH composition
 * sites — the real readMacProcessStart path and the injected osSeams.ps +
 * kinfoExact seam — codex gate round 11, Finding 2: the deterministic seam
 * tests the real protocol and cannot certify contradictory generations):
 * pair one exact kinfo answer with one ps text ONLY when the ps text's
 * field-explicit UTC second agrees with the exact read's parsed sec field
 * (the round-5-Finding-2 generation-agreement rule). A disagreement (or an
 * unparseable ps text — the exact path's ps read is a pinned C-locale
 * lstart, so garbage is torn evidence) throws the mid-read identity-change
 * error carrying the exact observation as `observedStartIdentity` (the
 * reuse latch's own class).
 * (codex gate round 33 follow-up review-mwbdjsb7-nnobtl, Finding 2 — the
 * LATER PS CARRY) the composition order is site-owned: on the REAL
 * readMacProcessStart path the kinfo read comes FIRST, so a disagreement's
 * proven later observation is the PS read — the caller may pass its identity
 * and collection window as `laterPsCarry` and the refusal carries THAT
 * (the round-25/27 later-read carry protocol: the later observation is the
 * replacement evidence; carrying the first read's kinfo identity let the
 * adjudicator discard the transition as the bound generation's own arrival
 * and credit a following absence to it). An UNPARSEABLE ps text proven
 * nothing — the exact kinfo carry stands there (uncertainty is never
 * positive evidence), and the seam path (ps FIRST, kinfo second) keeps its
 * existing kinfo carry unchanged: there the exact read IS the later one.
 * (codex gate round 52 review-mwej5iux-tehmck, Finding 1 — the
 * ERROR-VS-EVIDENCE rule for the UNPARSEABLE ps text) an unparseable ps
 * timestamp is TORN evidence that proves no replacement: it is an ORDINARY
 * query/parsing failure — its message deliberately carries no 'identity
 * changed' (that phrase stays the mid-double-read reuse class the retry
 * paths latch on) — riding the exact kinfo identity and, when the caller
 * supplies them, the kinfo read's own collection bounds (`kinfoCarry`), so
 * the bounded retry paths can recover; the generation-change classification
 * is reserved for a SUCCESSFULLY PARSED ps identity that disagrees with the
 * exact read's second (byte-identical throws below).
 * @param {{ sec: number, usec: number }} exact
 * @param {string} psStartIdentity
 * @param {{ identity: string, takenEpochMs: number, completedEpochMs: number } | null} [laterPsCarry]
 * @param {{ takenEpochMs: number, completedEpochMs: number } | null} [kinfoCarry]
 * @returns {string} the composed exact identity (`kinfo:<sec>:<usec>`)
 */
function composedExactStartIdentity(exact, psStartIdentity, laterPsCarry = null, kinfoCarry = null) {
  const psLstartMs = parseLstartAsUtc(psStartIdentity);
  if (psLstartMs === null) {
    // (codex gate round 52 review-mwej5iux-tehmck, Finding 1) torn ps
    // evidence: the ordinary parsing failure rides the kinfo identity and
    // its collection bounds — never the identity-change class.
    throw Object.assign(new Error('the exact fake-ZCode process identity read failed to parse its ps lstart timestamp'), {
      observedStartIdentity: `kinfo:${exact.sec}:${exact.usec}`,
      ...(kinfoCarry !== null ? {
        observedIdentityTakenEpochMs: kinfoCarry.takenEpochMs,
        observedIdentityCompletedEpochMs: kinfoCarry.completedEpochMs,
      } : {}),
    });
  }
  if (Math.floor(psLstartMs / 1000) !== exact.sec) {
    if (laterPsCarry !== null) {
      throw Object.assign(new Error('the exact fake-ZCode process identity changed'), {
        observedStartIdentity: laterPsCarry.identity,
        observedIdentityTakenEpochMs: laterPsCarry.takenEpochMs,
        observedIdentityCompletedEpochMs: laterPsCarry.completedEpochMs,
      });
    }
    throw Object.assign(new Error('the exact fake-ZCode process identity changed'), {
      observedStartIdentity: `kinfo:${exact.sec}:${exact.usec}`,
    });
  }
  return `kinfo:${exact.sec}:${exact.usec}`;
}


/**
 * The representation-aware GENERATION comparison (§32.12 Finding 2): do two
 * start identities describe the SAME generation? When NEITHER side carries
 * the exact kinfo form, the pre-existing raw-string semantics hold exactly
 * (equal = same, unequal = different — every coarse/synthetic/Linux pair).
 * When at least one side is the exact form, the comparison is
 * representation-aware: both exact sides decide by their exact strings; an
 * exact side and a ps-text side compare at the ps text's resolution (the
 * exact side's own creation second against the parsed lstart second — the
 * coarse representation is always derivable from the exact ms), so a
 * degraded-to-MATCHING-ps observation is the SAME generation (never
 * positive replacement evidence), a different-second ps text is DIFFERENT,
 * and a pair whose forms cannot be resolved at any resolution is UNCERTAIN
 * — never positive replacement evidence.
 * @param {string} observedIdentity @param {string} boundIdentity
 * @returns {'same' | 'different' | 'uncertain'}
 */
export function startIdentityGenerationRelation(observedIdentity, boundIdentity) {
  if (observedIdentity === boundIdentity) return 'same';
  const observedExact = parseExactStartIdentity(observedIdentity);
  const boundExact = parseExactStartIdentity(boundIdentity);
  // No exact form on either side: the raw-string semantics are the
  // pre-existing contract (coarse, synthetic and Linux identities alike).
  if (observedExact === null && boundExact === null) return 'different';
  // BOTH sides exact: the EXACT STRINGS decide — the registered route-(c)
  // semantic (distinct exact instants are DIFFERENT generations, the
  // slice-2/round-27 resolution): the microsecond discrimination is never
  // collapsed to the shared second, so a same-second successor stays
  // demonstrably different at every consumer of this relation.
  if (observedExact !== null && boundExact !== null) return 'different';
  // Exactly ONE exact side: compare at the ps text's resolution (the exact
  // side's own creation second — the coarse representation is always
  // derivable from the exact ms), so a degraded-to-MATCHING-ps observation
  // is the SAME generation (never positive replacement evidence), a
  // different-second ps text is DIFFERENT.
  const observedMs = observedExact !== null ? observedExact.ms : parseLstartAsUtc(observedIdentity);
  const boundMs = boundExact !== null ? boundExact.ms : parseLstartAsUtc(boundIdentity);
  // A recognized exact form against an unresolvable string is not
  // comparable at any resolution — uncertainty, never positive evidence.
  if (observedMs === null || boundMs === null) return 'uncertain';
  // (§32.13 Finding 4) the exact side's SECOND is its PARSED sec FIELD —
  // never floor(the rounded ms): the µs→ms rounding rounds UP into the next
  // second for usec ≥ 999500, and flooring that value reports the process's
  // ACTUAL creation second as a different generation (the reviewer's
  // example: kinfo:1793855520:999500 vs the ps text of second 1793855520).
  // The ps side's ms is itself whole-second, so flooring it is exact.
  const observedSecond = observedExact !== null ? observedExact.sec : Math.floor(observedMs / 1000);
  const boundSecond = boundExact !== null ? boundExact.sec : Math.floor(boundMs / 1000);
  return observedSecond === boundSecond ? 'same' : 'different';
}

/**
 * The positive-evidence gate over {@link startIdentityGenerationRelation}:
 * the two identities are demonstrably DIFFERENT generations. Uncertainty is
 * never positive replacement evidence — consumers treat it as the honest
 * unverified/degradation class, never latching.
 * @param {string} observedIdentity @param {string} boundIdentity
 * @returns {boolean}
 */
export function startIdentitiesDefinitivelyDiffer(observedIdentity, boundIdentity) {
  return startIdentityGenerationRelation(observedIdentity, boundIdentity) === 'different';
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
  // (route (c)) the EXACT identity form resolves to the EXACT ms (no floor).
  const kinfo = parseExactStartIdentity(startIdentity);
  if (kinfo !== null) return kinfo.ms;
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
 *   osSeams?: { platform?: string, ps?: (pid: number) => Promise<{ pid: number, ppid: number, lstart: string }>, kinfoExact?: (pid: number) => Promise<{ sec: number, usec: number } | { malformed: number } | null>, exactReaderOptIn?: boolean, environ?: 'present' | 'mismatch' | 'gone', runProcess?: osSeamsRunProcess },
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
  /** The narrowed seam object (the kinfoExact member is the route-(c)
   * exact-generation reader surface — see readDarwinKinfoExact). */
  const inspectSeams = input.osSeams || input.abortSignal
    ? { ...(input.osSeams ?? {}), ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}) }
    : input.osSeams;
  const inspect = input.inspect ?? ((observedPid, observedNonce) => inspectVerifiedProcessIdentity(observedPid, observedNonce, nonceVariable, /** @type {any} */ (inspectSeams)));
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
    const windowClosedVerdict = observationVerdict('unestablished', 'observation-window-closed', sampleStampMs(), queried, readStartedEpochMs);
    // (§32.12 Finding 3) the inner exact-read recheck throws the inspector's
    // own window-closed error CARRYING the identity its exact read observed
    // before the window closed: the read DID observe it, so the evidence
    // rides the verdict (the uniform ride discipline — the same carriage the
    // round-26/27 rides give a nonce failure's observed identity) and the
    // exit adjudicator can still classify it against the bound generation
    // (an equal carried identity stays non-deciding; a demonstrably
    // different one still latches).
    const carriedWindowError = /** @type {any} */ (inspectionError);
    if (carriedWindowError !== null && typeof carriedWindowError.observedStartIdentity === 'string') {
      /** @type {any} */ (windowClosedVerdict).observedStartIdentity = carriedWindowError.observedStartIdentity;
      // (§32.14 Finding 2) the carried identity's OWN timing rides too — the
      // SECOND read's dispatch bound is the truthful observation instant of
      // the identity the error carries (the pre-fix flow lost the successor
      // here: the plain window-closed verdict let a subsequent confirmed
      // absence adjudicate the ORIGINAL generation's disappearance instead
      // of latching the successor's reuse).
      if (Number.isSafeInteger(carriedWindowError.observedIdentityReadEpochMs)) {
        /** @type {any} */ (windowClosedVerdict).observedIdentityReadEpochMs = carriedWindowError.observedIdentityReadEpochMs;
      }
      // (codex gate round 7, Finding 1 — the INTERVAL-CARRIAGE rule) the
      // uniform ride carries the FIRST read's true observation WINDOW
      // (taken/completed) — the branch previously copied neither bound, so a
      // carried predecessor was dated at the verdict's later completion and
      // an old observation could latch against a newer presence baseline.
      // The taken bound rides as observedIdentityReadEpochMs (the explicit
      // §32.14-Finding-2 second-read dispatch bound takes precedence when
      // present — the two shapes never co-occur on one error) and the
      // completed bound rides as observedIdentityCompletedEpochMs: the
      // round-14/17 interval classification then dates the carried evidence
      // at its true window (stale or overlapping — never latched by the
      // completion-sample accident).
      if (!Number.isSafeInteger(windowClosedVerdict.observedIdentityReadEpochMs)
        && Number.isSafeInteger(carriedWindowError.observedIdentityTakenEpochMs)) {
        /** @type {any} */ (windowClosedVerdict).observedIdentityReadEpochMs = carriedWindowError.observedIdentityTakenEpochMs;
      }
      if (Number.isSafeInteger(carriedWindowError.observedIdentityCompletedEpochMs)) {
        /** @type {any} */ (windowClosedVerdict).observedIdentityCompletedEpochMs = carriedWindowError.observedIdentityCompletedEpochMs;
      }
    } else if (inspectionError === null && observed !== null && typeof observed === 'object') {
      // (codex gate round 31, Finding 2 — the SUCCESSFUL-RESULT EVIDENCE
      // PRESERVATION; codex gate round 32, Finding 1 — the EXACT-IDENTITY
      // FALLBACK) cancellation can arrive during the final ps query while
      // that query SUCCEEDS, and the inspector then returns normally with
      // whatever identity evidence it collected. The round-31 carriage
      // required the SEPARATE `observedStartIdentity` carry (the
      // mixed-resolution return), so a BOTH-EXACT inspection — whose exact
      // identity IS the returned `startIdentity`, with no separate carry —
      // was still discarded into an identity-free cancellation verdict, and
      // a subsequent confirmed absence adjudicated the ORIGINAL generation's
      // disappearance instead of the observed successor's reuse. The carried
      // evidence is now resolved CARRY-FIRST: the separate
      // `observedStartIdentity` carry when present, otherwise the successful
      // result's OWN EXACT `startIdentity` (an exact form only — a degraded
      // coarse result has no exact identity to preserve) — with the same
      // collection bounds, the same fields and the same uniform ride
      // discipline, so the exit adjudicator can classify the observed
      // evidence against the bound generation.
      const successfulResult = /** @type {any} */ (observed);
      const carriedEvidence = typeof successfulResult.observedStartIdentity === 'string'
        ? { identity: successfulResult.observedStartIdentity }
        : (typeof successfulResult.startIdentity === 'string'
          && parseExactStartIdentity(successfulResult.startIdentity) !== null)
          ? { identity: successfulResult.startIdentity }
          : null;
      if (carriedEvidence !== null) {
        /** @type {any} */ (windowClosedVerdict).observedStartIdentity = carriedEvidence.identity;
        if (Number.isSafeInteger(successfulResult.observedIdentityTakenEpochMs)) {
          /** @type {any} */ (windowClosedVerdict).observedIdentityReadEpochMs = successfulResult.observedIdentityTakenEpochMs;
        }
        if (Number.isSafeInteger(successfulResult.observedIdentityCompletedEpochMs)) {
          /** @type {any} */ (windowClosedVerdict).observedIdentityCompletedEpochMs = successfulResult.observedIdentityCompletedEpochMs;
        }
      }
    }
    return windowClosedVerdict;
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
      const transitionVerdict = observationVerdict('unestablished', 'start-identity-generation-changed', readEpochMs, queried, readStartedEpochMs);
      // (codex gate round 33, Finding 2 — the TRANSITION EVIDENCE RIDE) the
      // A→B transition refusal carries its evidence (the SECOND read's exact
      // identity and its collection bounds — the round-25 later-read carry
      // the inspector already rides), so the exit adjudicator can bind the
      // transition to the adjudicated generation instead of discarding it
      // into a bare verdict.
      const carriedTransitionIdentity = /** @type {any} */ (inspectionError).observedStartIdentity;
      if (typeof carriedTransitionIdentity === 'string') {
        /** @type {any} */ (transitionVerdict).observedStartIdentity = carriedTransitionIdentity;
        if (Number.isSafeInteger(/** @type {any} */ (inspectionError).observedIdentityTakenEpochMs)) {
          /** @type {any} */ (transitionVerdict).observedIdentityReadEpochMs = /** @type {any} */ (inspectionError).observedIdentityTakenEpochMs;
        }
        if (Number.isSafeInteger(/** @type {any} */ (inspectionError).observedIdentityCompletedEpochMs)) {
          /** @type {any} */ (transitionVerdict).observedIdentityCompletedEpochMs = /** @type {any} */ (inspectionError).observedIdentityCompletedEpochMs;
        }
      }
      return transitionVerdict;
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
      if (input.expectedStartIdentity !== undefined && startIdentitiesDefinitivelyDiffer(goneAfterIdentity, input.expectedStartIdentity)) {
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
      && startIdentitiesDefinitivelyDiffer(observedStartIdentity, input.expectedStartIdentity)) {
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
      // (codex gate round 15, Finding 2) the carried identity RIDES the
      // promoted verdict — the adjudicator's carried rules consume it.
      /** @type {any} */ (promotedVerdict).observedStartIdentity = observedStartIdentity;
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
  // (codex gate round 31, Finding 1 — the MIXED-READ CARRY GUARD) the
  // jointly verified coarse identity is not the only generation evidence a
  // mixed-resolution inspection returns: its separately preserved exact
  // carry is compared against the expected generation too. A carry that
  // definitively differs from the expected generation (a same-second
  // successor's exact instant against an exact bound — the both-exact
  // relation) is explicit successor evidence, and accepting the read as
  // `established` let the runtime bind the ancestry/duty hops across
  // generations on the matching coarse text alone. The carry refusal walks
  // the existing named class and RIDES the carried evidence + bounds (the
  // uniform ride discipline — the same carriage the round-26 promotion
  // uses) so the exit adjudicator can still classify it; a carry in the
  // expected generation (an exact match, or a coarse same-second carry
  // against an exact bound) keeps the lawful established classification.
  if (input.expectedStartIdentity !== undefined && startIdentitiesDefinitivelyDiffer(/** @type {any} */ (observed).startIdentity, input.expectedStartIdentity)) {
    // (codex gate round 46 review-mwdq8hy0-vxnoc5, Finding 1 — the PRIMARY
    // MISMATCH RIDE) the rejection preserves the observed identity and its
    // COLLECTION bounds (the kernel window — `observedIdentityTaken/Completed`
    // mapped to the read/completed verdict fields), exactly like the adjacent
    // carried-identity refusal: without the ride, an exact read whose kernel
    // collection predates a newer verified presence but whose trailing ps
    // query completes afterward dated the mismatch at the DELAYED completion
    // (`identityReadEpochMs` fallback) and adjudicateLocalExit latched
    // `pid-start-identity-reused` with `expectedStartIdentity` supplied
    // versus the lawful `disappeared` for identical evidence without it.
    const primaryMismatchVerdict = observationVerdict('unestablished', 'start-identity-generation-changed', sampleCompletion(), queried, readStartedEpochMs);
    /** @type {any} */ (primaryMismatchVerdict).observedStartIdentity = /** @type {any} */ (observed).startIdentity;
    if (Number.isSafeInteger(/** @type {any} */ (observed).observedIdentityTakenEpochMs)) {
      /** @type {any} */ (primaryMismatchVerdict).observedIdentityReadEpochMs = /** @type {any} */ (observed).observedIdentityTakenEpochMs;
    }
    if (Number.isSafeInteger(/** @type {any} */ (observed).observedIdentityCompletedEpochMs)) {
      /** @type {any} */ (primaryMismatchVerdict).observedIdentityCompletedEpochMs = /** @type {any} */ (observed).observedIdentityCompletedEpochMs;
    }
    return primaryMismatchVerdict;
  }
  if (input.expectedStartIdentity !== undefined && typeof /** @type {any} */ (observed).observedStartIdentity === 'string'
    && startIdentitiesDefinitivelyDiffer(/** @type {any} */ (observed).observedStartIdentity, input.expectedStartIdentity)) {
    const carriedGenerationVerdict = observationVerdict('unestablished', 'start-identity-generation-changed', sampleCompletion(), queried, readStartedEpochMs);
    /** @type {any} */ (carriedGenerationVerdict).observedStartIdentity = /** @type {any} */ (observed).observedStartIdentity;
    if (Number.isSafeInteger(/** @type {any} */ (observed).observedIdentityTakenEpochMs)) {
      /** @type {any} */ (carriedGenerationVerdict).observedIdentityReadEpochMs = /** @type {any} */ (observed).observedIdentityTakenEpochMs;
    }
    if (Number.isSafeInteger(/** @type {any} */ (observed).observedIdentityCompletedEpochMs)) {
      /** @type {any} */ (carriedGenerationVerdict).observedIdentityCompletedEpochMs = /** @type {any} */ (observed).observedIdentityCompletedEpochMs;
    }
    return carriedGenerationVerdict;
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
    // (codex gate round 12, Finding 1 — the EXACT-EVIDENCE CARRY) the
    // mixed-read downgrade's separately preserved exact observation rides
    // the ESTABLISHED verdict through the whitelisted carried-identity
    // fields: the jointly verified coarse identity remains the returned
    // observation, and the adjudicator consumes the carried exact evidence
    // for replacement detection. No new persisted shape — the same fields
    // the carried-identity rides use.
    ...(typeof /** @type {any} */ (observed).observedStartIdentity === 'string'
      ? { observedStartIdentity: /** @type {any} */ (observed).observedStartIdentity } : {}),
    ...(Number.isSafeInteger(/** @type {any} */ (observed).observedIdentityTakenEpochMs)
      ? { observedIdentityReadEpochMs: /** @type {any} */ (observed).observedIdentityTakenEpochMs } : {}),
    ...(Number.isSafeInteger(/** @type {any} */ (observed).observedIdentityCompletedEpochMs)
      ? { observedIdentityCompletedEpochMs: /** @type {any} */ (observed).observedIdentityCompletedEpochMs } : {}),
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
  // (codex gate round 16, Finding 4) the horizon the classification
  // compares against is PARAMETERIZED (defaulting to the current closure
  // values) — the learned cross-comparison classifies against the horizon
  // AS IT STOOD before the read advanced it.
  const carriedIdentityIntervalClass = (/** @type {any} */ read, /** @type {number} */ horizonEpochMs = lastPresenceEpochMs, /** @type {number | null} */ horizonStartedEpochMs = lastPresenceStartedEpochMs) => {
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
    if (horizonStartedEpochMs === null) {
      return upper < horizonEpochMs ? 'stale' : 'post';
    }
    if (upper < horizonStartedEpochMs) return 'stale';
    if (lower >= horizonEpochMs) return 'post';
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
  // (codex gate round 15, Finding 1 — the LEARNED EXACT GENERATION) a
  // coarse bound cannot discriminate same-second exact successors:
  // successive exact observations both compare 'same' against it while
  // their exact strings prove PID reuse. The FIRST exact observation
  // learned during the sequence becomes the carried exact reference;
  // subsequent exact observations are checked against IT (equal exact
  // instants stay the same generation — the tie convention).
  let learnedExactReference = /** @type {string | null} */ (null);
  // (codex gate round 17, Finding 2 — the BASELINE SEEDING) a
  // mixed-resolution baseline can already carry an exact identity in
  // observedStartIdentity while its observation.startIdentity remains
  // coarse: the reference is SEEDED from that admissible carry, so a later
  // same-second exact successor is compared against the BASELINE's
  // generation, never learned as the first.
  if (typeof /** @type {any} */ (presence).observedStartIdentity === 'string'
    && parseExactStartIdentity(/** @type {any} */ (presence).observedStartIdentity) !== null) {
    learnedExactReference = /** @type {any} */ (presence).observedStartIdentity;
  } else if (isPlainObject(/** @type {any} */ (presence).observation)
    && typeof /** @type {any} */ (presence).observation.startIdentity === 'string'
    && parseExactStartIdentity(/** @type {any} */ (presence).observation.startIdentity) !== null) {
    // (codex gate round 25, Finding 4 — the OWN-IDENTITY SEEDING) a FULLY
    // EXACT baseline supplies generation A in presence.observation.startId-
    // entity without a separate carry: the reference seeds from the
    // baseline's OWN exact identity too (the carry keeps its precedence when
    // both exist — the runtime's carried-first learning order). Without the
    // seed an established mixed-resolution read TIED with the baseline's
    // identity timestamp returned matching coarse text while carrying
    // successor B; its pre-filter comparison found no learned reference and
    // the tie branch LEARNED B, letting a subsequent confirmed absence
    // credit the original generation's disappearance. With the seed the
    // tied carry latches against A before the tie skip. A coarse-only
    // baseline keeps the current learning order (nothing seeds).
    learnedExactReference = /** @type {any} */ (presence).observation.startIdentity;
  }
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
    // (codex gate round 33, Finding 2 — the TRANSITION GENERATION BINDING) a
    // named read CARRYING its transition's later identity is replacement
    // evidence only when that carried identity definitively differs from the
    // bound generation: a carried identity in the bound generation itself
    // describes the A→B transition whose B is bound (the read spanned B's
    // baseline) — the bound generation's own arrival, never its replacement.
    const earlyCarriedForeign = typeof /** @type {any} */ (read).observedStartIdentity === 'string'
      && startIdentitiesDefinitivelyDiffer(/** @type {any} */ (read).observedStartIdentity, bound.startIdentity);
    const earlyIsCarriedReplacement = earlySameScope && read.status === 'unestablished'
      && (earlyCarriedForeign
        || (read.reason === 'start-identity-generation-changed'
          && typeof /** @type {any} */ (read).observedStartIdentity !== 'string'));
    const earlyIsIdentityBearingAbsence = earlySameScope && read.status === 'absent'
      && typeof /** @type {any} */ (read).observedStartIdentity === 'string'
      && startIdentitiesDefinitivelyDiffer(/** @type {any} */ (read).observedStartIdentity, bound.startIdentity);
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
          && startIdentitiesDefinitivelyDiffer(/** @type {string} */ (candidate.startIdentity), bound.startIdentity)) {
          // (codex gate round 39 review-mwcrgo5m-8t4hr1, Finding 2 — the
          // COLLECTION-BOUNDS CLASSIFICATION BEFORE THE RAW-RELATION LATCH) a
          // successful exact inspection can finish its KERNEL reads before
          // the presence baseline while its final ps query completes later —
          // the observer then returns the EARLIER exact identity with its
          // kernel bounds and a LATER identityReadEpochMs, and the gate's
          // evidence premise (the read instant at/after the horizon) fired
          // on the DELAYED completion. The raw different-generation latch
          // previously fired without any interval check, turning the
          // subprocess latency into a false replacement refusal. The read's
          // COLLECTION interval (the kernel bounds — the same resolution
          // every carried classification uses) now classifies against the
          // presence horizon BEFORE the latch: definitively stale
          // (completed strictly before the horizon's collection start) is
          // old-era evidence that never latches; an overlapping window is
          // the named ambiguous fact; a malformed window refuses by name;
          // every other class (post, legacy) keeps the raw latch.
          const rawRelationClass = carriedIdentityIntervalClass(read, lastPresenceEpochMs, lastPresenceStartedEpochMs);
          if (rawRelationClass === 'stale') {
            // old evidence — the raw-relation latch never fires on it.
          } else if (rawRelationClass === 'overlap') {
            replacementAmbiguous = true;
          } else if (rawRelationClass === 'inconsistent') {
            return { ...unestablished('pid-start-identity-interval-inconsistent'), boundIdentity, lastVerifiedPresenceEpochMs: lastPresenceEpochMs };
          } else {
            replacementDetected = true;
          }
        }
        // (codex gate round 21, Finding 4 — the LEARNED-GENERATION CHECK
        // BEFORE THE TIE FILTER) a coarse bound cannot discriminate
        // same-second exact successors: an established read whose OWN exact
        // identity definitively differs from the LEARNED reference is
        // generation-changed evidence even when the strict recency filter is
        // about to skip it — exact reads A and B sharing the identity-read
        // millisecond both match the baseline's second, the first read
        // advances the horizon, and the second TIED with it (previously
        // skipped before the learned-reference comparison could execute, so
        // a subsequent confirmed absence returned disappeared despite the
        // distinct exact generations). The check runs HERE — before the
        // recency filter — with the applicable interval classification (the
        // in-branch learned-cross-comparison's own rules): an overlapping
        // window is the ambiguous fact, a malformed window refuses by name,
        // a definitively stale window is old evidence (the recency filter
        // still governs), every other class latches the reuse.
        if (!replacementDetected && !replacementAmbiguous) {
          const tieOwnExact = isPlainObject(candidate) && candidate.pid === bound.pid
            && typeof /** @type {any} */ (candidate).startIdentity === 'string'
            && parseExactStartIdentity(/** @type {any} */ (candidate).startIdentity) !== null
            ? /** @type {any} */ (candidate).startIdentity : null;
          if (tieOwnExact !== null && learnedExactReference !== null
            && startIdentitiesDefinitivelyDiffer(tieOwnExact, learnedExactReference)) {
            const tieIntervalClass = carriedIdentityIntervalClass(read, lastPresenceEpochMs, lastPresenceStartedEpochMs);
            if (tieIntervalClass === 'overlap') {
              replacementAmbiguous = true;
            } else if (tieIntervalClass === 'inconsistent') {
              return { ...unestablished('pid-start-identity-interval-inconsistent'), boundIdentity, lastVerifiedPresenceEpochMs: lastPresenceEpochMs };
            } else if (tieIntervalClass !== 'stale') {
              replacementDetected = true;
            }
          }
        }
      } else if (sameScope && read.status === 'unestablished'
        && read.reason === 'start-identity-generation-changed') {
        // (codex gate round 33, Finding 2 — the TRANSITION GENERATION
        // BINDING) a named read CARRYING its transition's later identity that
        // does NOT definitively differ from the bound generation describes
        // the A→B transition whose B is bound — the bound generation's own
        // arrival (the read spanned B's baseline), never its replacement.
        // The transition is non-deciding old-era evidence: skipped, and the
        // bound generation's lawful confirmed absence governs below. A bare
        // named read and a foreign-carried named read keep their existing
        // interval rules unchanged.
        // (codex gate round 33 follow-up review-mwbdjsb7-nnobtl, Finding 1 —
        // the RETAINED EXACT REFERENCE BEFORE THE SKIP) a MIXED-RESOLUTION
        // baseline carries its exact generation alongside the coarse start
        // identity, so a same-second exact transition carry passes the
        // coarse-resolution comparison above while its exact string proves
        // the PID reuse: the skip now fires only when the carry is
        // same-generation at EVERY retained resolution — an exact carry that
        // definitively differs from the LEARNED exact reference is NOT
        // skipped and falls through to the named-read interval rules below
        // (the existing foreign-carry path). A coarse carry and an exact
        // carry equal to the learned reference keep the skip unchanged.
        if (typeof /** @type {any} */ (read).observedStartIdentity === 'string'
          && !startIdentitiesDefinitivelyDiffer(/** @type {any} */ (read).observedStartIdentity, bound.startIdentity)) {
          const skipExactCarry = parseExactStartIdentity(/** @type {any} */ (read).observedStartIdentity) !== null
            ? /** @type {any} */ (read).observedStartIdentity : null;
          if (!(skipExactCarry !== null && learnedExactReference !== null
            && startIdentitiesDefinitivelyDiffer(skipExactCarry, learnedExactReference))) {
            // (codex gate round 34 review-mwbhnnxl-21lsyh, Finding 2 — the
            // ARRIVAL-WINDOW EVIDENCE) the arrival reading carries its own
            // window requirement: a transition whose carried interval
            // classifies POST against the presence horizon (tie-inclusive —
            // the collection started at/after the horizon's completion) lies
            // ENTIRELY after the baseline and cannot describe the bound
            // generation's earlier arrival — the existing replacement
            // classification governs below (post latches, overlap is the
            // ambiguous fact, stale is old evidence). Every other class
            // (overlap, stale, legacy, malformed) keeps the
            // transition-generation-binding exemption unchanged.
            if (carriedIdentityIntervalClass(read) !== 'post') {
              sawUnestablished = true;
              continue;
            }
          }
        }
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
        && startIdentitiesDefinitivelyDiffer(/** @type {any} */ (read).observedStartIdentity, bound.startIdentity)) {
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
      // (codex gate round 22, Finding 2 — the CARRIED IDENTITY IN THE
      // PRE-FILTER CHECK) the learned-reference comparison above considers
      // only the observation's OWN identity: a tied MIXED-resolution read
      // can return matching coarse startIdentity while CARRYING a different
      // exact generation in observedStartIdentity — the tied read was
      // skipped by the recency filter before its carry was checked, and a
      // subsequent confirmed absence returned disappeared despite the
      // distinct exact generations. The pre-filter learned-reference
      // comparison applies to the CARRIED identity too — established carries
      // AND failed-read carries alike (the round-16 F1 mirror's pre-filter
      // version) — with the applicable interval classification (the same
      // rules the in-branch carried comparisons apply): an overlapping
      // window is the ambiguous fact, a malformed window refuses by name, a
      // definitively stale window is old evidence (the recency filter still
      // governs), every other class latches the reuse.
      if (sameScope && !replacementDetected && !replacementAmbiguous) {
        const tieCarriedExact = typeof /** @type {any} */ (read).observedStartIdentity === 'string'
          && parseExactStartIdentity(/** @type {any} */ (read).observedStartIdentity) !== null
          ? /** @type {any} */ (read).observedStartIdentity : null;
        if (tieCarriedExact !== null && learnedExactReference !== null
          && startIdentitiesDefinitivelyDiffer(tieCarriedExact, learnedExactReference)) {
          const tieCarriedClass = carriedIdentityIntervalClass(read, lastPresenceEpochMs, lastPresenceStartedEpochMs);
          if (tieCarriedClass === 'overlap') {
            replacementAmbiguous = true;
          } else if (tieCarriedClass === 'inconsistent') {
            return { ...unestablished('pid-start-identity-interval-inconsistent'), boundIdentity, lastVerifiedPresenceEpochMs: lastPresenceEpochMs };
          } else if (tieCarriedClass !== 'stale') {
            replacementDetected = true;
          }
        }
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
    if (evidenceEpochMs <= lastPresenceEpochMs) {
      // (codex gate round 23, Finding 2 — the TIED EXACT OBSERVATION
      // RETENTION) an established same-scope read whose identity evidence
      // TIES the presence horizon still carries decisive exact EVIDENCE even
      // though it never decides: with a coarse baseline the first exact read
      // tied with the baseline's identity-read millisecond was skipped here
      // WITHOUT initializing the learned reference, so a subsequent
      // same-second exact successor was learned as the original generation
      // and a confirmed absence returned disappeared despite the distinct
      // exact identities. The tied read's exact evidence is PRESERVED — the
      // carried identity first (the runtime's learning order, with the same
      // stale-carry learning exclusion), then the observation's own — while
      // the horizon ADVANCE and the recency SKIP remain byte-identically
      // (only the evidence is retained; the skip itself never admits the
      // read).
      if (read.status === 'established' && evidenceEpochMs === lastPresenceEpochMs) {
        const tiedQueried = /** @type {any} */ (read).queried;
        const tiedSameScope = isPlainObject(tiedQueried) && tiedQueried.pid === bound.pid && tiedQueried.nonce === bound.nonce;
        const tiedObservation = /** @type {any} */ (read).observation;
        if (tiedSameScope && isPlainObject(tiedObservation) && tiedObservation.pid === bound.pid) {
          const tiedCarriedExact = typeof /** @type {any} */ (read).observedStartIdentity === 'string'
            && parseExactStartIdentity(/** @type {any} */ (read).observedStartIdentity) !== null
            ? /** @type {any} */ (read).observedStartIdentity : null;
          if (tiedCarriedExact !== null && learnedExactReference === null) {
            const tiedCarryClass = carriedIdentityIntervalClass(read);
            if (tiedCarryClass !== 'stale') {
              learnedExactReference = tiedCarriedExact;
            }
          }
          const tiedOwnExact = typeof tiedObservation.startIdentity === 'string'
            && parseExactStartIdentity(tiedObservation.startIdentity) !== null
            ? tiedObservation.startIdentity : null;
          if (tiedOwnExact !== null && learnedExactReference === null) {
            // (codex gate round 41 review-mwd6thjb-oppqxc, Finding 2 — the
            // TIED OWN-IDENTITY STALE EXCLUSION) the fallback takes the SAME
            // stale-window exclusion its adjacent carried-identity branch
            // above applies: a tied read whose kernel window completed
            // strictly before the horizon's dispatch is old-era evidence and
            // never initializes the reference — the delayed final-ps
            // completion that produced the tie (identityReadEpochMs equal to
            // the baseline's identity-read instant) must not let discarded
            // predecessor evidence cause a later false replacement refusal.
            // Non-stale and legacy windows keep the existing learning.
            const tiedOwnClass = carriedIdentityIntervalClass(read);
            if (tiedOwnClass !== 'stale') {
              learnedExactReference = tiedOwnExact;
            }
          }
        }
      }
      // (codex gate round 37 review-mwc4sfh6-fx3ggt, Finding 1 — the
      // PRE-SKIP EXACT-EVIDENCE COMPARISON) OVERLAPPING observations can
      // retain an exact generation A (collected in an earlier window) while
      // a mixed-resolution read advances the COARSE presence horizon past a
      // separate exact observation of successor B: the strict recency skip
      // discarded B without ever comparing its exact evidence against the
      // retained exact reference, and a confirmed absence returned
      // disappeared despite both exact generations being observed. Before a
      // STRICTLY-BEFORE read is discarded, its exact evidence (its own exact
      // observation identity and its exact carried identity) is compared
      // against the retained exact reference with the established
      // representation-aware relation: a definitive difference does NOT skip
      // — the read falls through to the existing branch/interval paths
      // (post latches, overlap is the named ambiguous fact, stale stays old
      // evidence). Same-generation exact evidence, coarse evidence, ties (the
      // round-23 tie retention above), absent reads and reads without a
      // reference keep the existing skip byte-identically.
      const skipQueried = /** @type {any} */ (read).queried;
      const skipReference = learnedExactReference;
      if (evidenceEpochMs < lastPresenceEpochMs
        && read.status !== 'absent'
        && skipReference !== null
        && isPlainObject(skipQueried) && skipQueried.pid === bound.pid && skipQueried.nonce === bound.nonce) {
        const skipExactCandidates = [];
        if (typeof /** @type {any} */ (read).observedStartIdentity === 'string'
          && parseExactStartIdentity(/** @type {any} */ (read).observedStartIdentity) !== null) {
          skipExactCandidates.push(/** @type {any} */ (read).observedStartIdentity);
        }
        const skipObservation = /** @type {any} */ (read).observation;
        if (isPlainObject(skipObservation) && typeof skipObservation.startIdentity === 'string'
          && parseExactStartIdentity(skipObservation.startIdentity) !== null) {
          skipExactCandidates.push(skipObservation.startIdentity);
        }
        if (skipExactCandidates.some((candidate) => startIdentitiesDefinitivelyDiffer(candidate, skipReference))) {
          // (codex gate round 38 review-mwc95z19-zdq893, Finding 2 — the
          // STALE-READ EXCLUSION BEFORE THE BYPASS) definitively STALE
          // evidence keeps its exclusion: a read whose collection interval
          // completed entirely before the presence horizon's own collection
          // start (the established stale classification) is old-era evidence
          // the raw-relation branch would otherwise latch without any
          // interval check — an exact baseline plus an established
          // PREDECESSOR collected in an earlier window (completing before the
          // baseline's dispatch) must never manufacture reuse. Non-stale
          // windows (overlap, post, legacy) keep the round-37 bypass and its
          // branch/interval semantics.
          const skipIntervalClass = carriedIdentityIntervalClass(read);
          if (skipIntervalClass === 'stale') {
            continue;
          }
          // The retained exact evidence proves a different generation — the
          // coarse horizon never discards it. Fall through to the branches
          // below.
        } else {
          continue;
        }
      } else {
        continue;
      }
    }
    // A read is evidence about the identity it QUERIED, nothing else: a read
    // that queried another PID or another scope nonce is foreign evidence and
    // never decides this generation's fate (no absence, no reuse, no failure).
    const queried = /** @type {any} */ (read).queried;
    if (queried.pid !== bound.pid || queried.nonce !== bound.nonce) continue;
    if (reuseLatched) continue;
    if (read.status === 'established') {
      const observation = /** @type {any} */ (read).observation;
      if (!isPlainObject(observation) || observation.pid !== bound.pid) continue;
      // (§32.12 Finding 2) the representation-aware relation: same → the
      // presence horizon advances; demonstrably different → the reuse latch;
      // UNCERTAIN (an exact form against an unresolvable string) is
      // non-deciding — the read neither advances the horizon nor latches,
      // because uncertainty is never positive replacement evidence.
      // (codex gate round 12, Finding 1 — the EXACT-EVIDENCE REPLACEMENT
      // DETECTION; codex gate round 14, Finding 2 — the INTERVAL
      // CLASSIFICATION) an established read whose SEPARATELY PRESERVED exact
      // carry definitively differs from the bound is replacement evidence
      // ONLY through the interval classification computed below: the jointly
      // verified coarse identity is same-generation at its resolution, but
      // the preserved exact observation proves the PID was reused only when
      // its window is genuinely post-baseline — the later confirmed absence
      // is never credited as the original generation's disappearance.
      // (codex gate round 14, Finding 2 — the CARRIED-INTERVAL
      // CLASSIFICATION on established carries) the separately preserved
      // exact carry was observed DURING this read — the comparison baseline
      // is the horizon AS IT STOOD before this read advances it: a stale
      // carried window (completed strictly before the presence's own
      // collection start) is old evidence that never latches, an overlapping
      // window is the lawful ambiguous fact, and only a genuinely
      // post-baseline window is replacement evidence.
      let carriedReplacement = false;
      let carriedAmbiguous = false;
      let carriedInconsistent = false;
      const carriedExact = typeof /** @type {any} */ (read).observedStartIdentity === 'string'
        && parseExactStartIdentity(/** @type {any} */ (read).observedStartIdentity) !== null
        ? /** @type {any} */ (read).observedStartIdentity
        : null;
      if (carriedExact !== null
        && ((learnedExactReference !== null && startIdentitiesDefinitivelyDiffer(carriedExact, learnedExactReference))
          || startIdentitiesDefinitivelyDiffer(carriedExact, bound.startIdentity))) {
        const carriedIntervalClass = carriedIdentityIntervalClass(read);
        if (carriedIntervalClass === 'overlap') {
          carriedAmbiguous = true;
        } else if (carriedIntervalClass === 'inconsistent') {
          carriedInconsistent = true;
        } else if (carriedIntervalClass === 'post'
          || (carriedIntervalClass === 'legacy' && carriedIdentityEpochMs(read) >= lastPresenceEpochMs)) {
          carriedReplacement = true;
        }
        // stale: old evidence — never latching.
      }
      if (carriedExact !== null && learnedExactReference === null) {
        // (codex gate round 17, Finding 5 — the STALE-CARRY LEARNING
        // EXCLUSION) the carry's own collection interval is checked against
        // the PRE-READ presence horizon BEFORE learning it: an established
        // mixed read can finish after the baseline while carrying an exact
        // identity collected entirely before the baseline window — that
        // stale identity is never the reference (the check runs regardless
        // of whether the carry appears foreign).
        const carryLearnClass = carriedIdentityIntervalClass(read);
        if (carryLearnClass !== 'stale') {
          learnedExactReference = carriedExact;
        }
      }
      // (codex gate round 16, Finding 4 — the PREVIOUS-HORIZON capture) the
      // learned cross-comparison classifies against the horizon AS IT STOOD
      // before this read advances it — captured here, never after.
      const previousHorizonEpochMs = lastPresenceEpochMs;
      const previousHorizonStartedEpochMs = lastPresenceStartedEpochMs;
      const presenceRelation = startIdentityGenerationRelation(/** @type {string} */ (observation.startIdentity), bound.startIdentity);
      if (presenceRelation === 'same') {
        // (codex gate round 41 review-mwd6thjb-oppqxc, Finding 1 — the
        // STALE-WINDOW EXCLUSION BEFORE ADVANCING THE HORIZON) the read's
        // KERNEL collection window is classified before the presence state
        // or horizon updates (the previous-horizon capture above, the
        // round-40 pattern): a read whose window completed strictly before
        // the presence horizon's dispatch is definitively STALE old-era
        // evidence — the delayed final-ps completion that carried it past
        // the evidence premise never turns it into FRESH presence. Without
        // the exclusion a stale predecessor advanced the horizon to its
        // delayed completion instant, and a confirmed absence collected
        // after the BASELINE (but before that fabricated horizon) was
        // rejected as overlapping, returning `live` despite the proven
        // disappearance. Non-stale windows keep the advance byte-identically.
        const sameArmClass = carriedIdentityIntervalClass(read, previousHorizonEpochMs, previousHorizonStartedEpochMs);
        // (codex gate round 64 review-mwg28yk8-ds4mtv, Finding 1 — the
        // MONOTONIC HORIZON FOR OLDER CONFLICTING EVIDENCE) the round-37
        // pre-skip exact-evidence bypass routes OLDER conflicting reads —
        // their identity evidence is strictly below the horizon the bypass
        // compared against (the bypass's own premise at the recency filter) —
        // into the branch paths, and this same-generation arm then ASSIGNED
        // the horizon backward: with the coarse baseline carrying exact
        // identity B at 6250, the older mixed-resolution presence carrying
        // exact A at 6200 with an absent carried completion bound moved the
        // verified presence horizon to 6200, and a confirmed absence
        // collected over [6200, 6300] — overlapping the ACTUAL baseline — was
        // credited as `disappeared` instead of the ROUND-36 unestablished
        // rejection (6200 < 6250). Older conflicting evidence takes the stale
        // arm's treatment: non-advancing, never an advancing presence — the
        // horizon pair keeps its previous values. The normal advance is
        // byte-identical for reads whose evidence is at/after the horizon
        // (they never pass through the bypass), and tied reads never reach
        // this arm at all (the recency filter skips them; the
        // latch-before-skip pre-filter owns their conflicts), so the guard's
        // "older" key is exactly the runtime's `evidenceEpochMs` source
        // (`identityReadEpochMs ?? readEpochMs`) compared against the
        // PRE-READ horizon.
        const sameArmEvidenceEpochMs = identityEvidenceEpochMs(read);
        if (sameArmClass === 'stale'
          || sameArmEvidenceEpochMs < previousHorizonEpochMs) {
          sawUnestablished = true;
        } else {
          state = 'live';
          lastPresenceEpochMs = sameArmEvidenceEpochMs;
          // (codex round 17) the horizon's collection start advances with it.
          if (Number.isSafeInteger(read.readStartedEpochMs)) {
            lastPresenceStartedEpochMs = read.readStartedEpochMs;
          }
        }
      } else if (presenceRelation === 'different') {
        // (codex gate round 39 review-mwcrgo5m-8t4hr1, Finding 2 — the
        // relation arm's own STALE exclusion) the raw different-generation
        // latch takes the SAME collection-bounds classification the gate arm
        // now applies: a read whose kernel window completed strictly before
        // the presence horizon's collection start is old-era evidence — the
        // delayed final-ps completion that carried it past the gate never
        // turns it into a replacement. Non-stale classes keep the raw latch
        // (the gate already routed overlapping windows to the ambiguous
        // fact; post/legacy windows latch as before).
        const relationArmClass = carriedIdentityIntervalClass(read, previousHorizonEpochMs, previousHorizonStartedEpochMs);
        if (relationArmClass === 'stale') {
          sawUnestablished = true;
        } else {
          state = 'reused';
          reuseLatched = true;
        }
      } else {
        sawUnestablished = true;
      }
      // (codex gate round 15, Finding 1 — the LEARNED EXACT GENERATION
      // cross-comparison; codex gate round 16, Finding 4 — classified
      // against the PREVIOUS horizon) the read's OWN exact identity is
      // checked against the learned reference: two exact observations in
      // the same second with different usec are definitively different
      // generations — the reuse latch (classified by the read's own
      // collection window against the previous horizon); identical exact
      // instants keep the same-generation path (the tie convention).
      const observationExact = typeof observation.startIdentity === 'string' && parseExactStartIdentity(observation.startIdentity) !== null ? observation.startIdentity : null;
      if (observationExact !== null) {
        if (learnedExactReference === null) {
          // (codex gate round 40 review-mwcuom0y-o3kamz, Finding 1 — the
          // STALE-WINDOW EXCLUSION BEFORE THE OWN-IDENTITY SEEDING) the
          // read's COLLECTION window is classified BEFORE its own exact
          // identity initializes the learned reference (the same
          // established rule the carry learning applies — round 17, Finding
          // 5): a read whose kernel window completed strictly before the
          // presence horizon's dispatch is definitively STALE old-era
          // evidence and never becomes the reference. Without the exclusion
          // a coarse baseline plus a stale predecessor (collected in an
          // earlier window, its final ps query completing later so the read
          // still passed the gate) initialized the reference to the
          // predecessor's generation, and a later current same-second
          // observation was detected as its replacement — a false
          // `pid-start-identity-reused` refusal built from discarded
          // predecessor evidence. Non-stale classes (overlap, post, legacy)
          // keep the existing seeding byte-identically. The classification
          // runs against the PREVIOUS horizon — the same-generation relation
          // arm above already advanced the horizon with THIS read, and the
          // stale question is about the window as it stood when the read
          // arrived.
          const ownLearnClass = carriedIdentityIntervalClass(read, previousHorizonEpochMs, previousHorizonStartedEpochMs);
          if (ownLearnClass !== 'stale') {
            learnedExactReference = observationExact;
          }
        } else if (startIdentitiesDefinitivelyDiffer(observationExact, learnedExactReference) && !reuseLatched) {
          const ownIntervalClass = carriedIdentityIntervalClass(read, previousHorizonEpochMs, previousHorizonStartedEpochMs);
          if (ownIntervalClass === 'overlap') {
            return { ...unestablished('pid-start-identity-ambiguous'), boundIdentity, lastVerifiedPresenceEpochMs: lastPresenceEpochMs };
          }
          if (ownIntervalClass === 'inconsistent') {
            return { ...unestablished('pid-start-identity-interval-inconsistent'), boundIdentity, lastVerifiedPresenceEpochMs: lastPresenceEpochMs };
          }
          if (ownIntervalClass === 'stale') {
            // old evidence — never latching.
          } else {
            state = 'reused';
            reuseLatched = true;
          }
        }
      }
      // (codex gate round 12, Finding 1 — the EXACT-EVIDENCE REPLACEMENT
      // DETECTION; codex gate round 14, Finding 2 — the INTERVAL
      // CLASSIFICATION) an established read whose SEPARATELY PRESERVED exact
      // carry definitively differs from the bound is replacement evidence
      // ONLY through the interval classification computed above: the jointly
      // verified coarse identity is same-generation at its resolution, but
      // the preserved exact observation proves the PID was reused only when
      // its window is genuinely post-baseline — the later confirmed absence
      // is never credited as the original generation's disappearance.
      if (!reuseLatched && carriedInconsistent) {
        return { ...unestablished('pid-start-identity-interval-inconsistent'), boundIdentity, lastVerifiedPresenceEpochMs: lastPresenceEpochMs };
      }
      if (!reuseLatched && carriedAmbiguous) {
        return { ...unestablished('pid-start-identity-ambiguous'), boundIdentity, lastVerifiedPresenceEpochMs: lastPresenceEpochMs };
      }
      if (!reuseLatched && carriedReplacement) {
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
      if (typeof carriedIdentity === 'string'
        && (startIdentitiesDefinitivelyDiffer(carriedIdentity, bound.startIdentity)
          // (codex gate round 16, Finding 1 — the ABSENT-CARRY LEARNED
          // REFERENCE) the carried exact identity is also compared against
          // the LEARNED exact reference (the interval classification below
          // is preserved identically).
          || (learnedExactReference !== null
            && parseExactStartIdentity(carriedIdentity) !== null
            && startIdentitiesDefinitivelyDiffer(carriedIdentity, learnedExactReference)))) {
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
      // (codex gate round 18, Finding 2 — the ABSENT-CARRY RETENTION) an
      // identity-bearing absent read RETAINS its admissible exact carry
      // into the learned reference (the established and failed-read
      // branches already do): with a coarse baseline, an absent read
      // carrying exact generation A followed by an established read of
      // same-second generation B proves the reuse — B is compared against
      // the retained A. A carry inadmissible by the recency rules (stale —
      // collected strictly before the horizon's collection start) is not
      // retained.
      if (learnedExactReference === null
        && typeof carriedIdentity === 'string'
        && parseExactStartIdentity(carriedIdentity) !== null) {
        const absentCarryLearnClass = carriedIdentityIntervalClass(read);
        if (absentCarryLearnClass !== 'stale') {
          learnedExactReference = carriedIdentity;
        }
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
      && (startIdentitiesDefinitivelyDiffer(/** @type {any} */ (read).observedStartIdentity, bound.startIdentity)
        // (codex gate round 16, Finding 1 — the FAILED-CARRY LEARNED
        // REFERENCE) the carried exact identity is also compared against
        // the LEARNED exact reference: a coarse bound cannot discriminate
        // same-second exact successors, so a carried identity matching the
        // bound at coarse resolution may still definitively differ from the
        // generation the sequence learned. The interval classification below
        // is preserved identically.
        || (learnedExactReference !== null
          && parseExactStartIdentity(/** @type {any} */ (read).observedStartIdentity) !== null
          && startIdentitiesDefinitivelyDiffer(/** @type {any} */ (read).observedStartIdentity, learnedExactReference)))) {
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
    // (codex gate round 17, Finding 3 — the FAILED-CARRY RETENTION) an
    // ADMISSIBLE first exact carry from a failed read is RETAINED as the
    // learned reference (not only checked): a later established exact
    // generation in the same second is then compared against it. A carry
    // inadmissible by the recency rules (stale — collected strictly before
    // the horizon's collection start) is not retained (the Finding-3-style
    // discipline). The learning sits at the UNESTABLISHED-BRANCH level: a
    // coarse bound cannot discriminate same-second exact successors, so the
    // differ-vs-bound gate must never gate the retention.
    if (learnedExactReference === null
      && typeof /** @type {any} */ (read).observedStartIdentity === 'string'
      && parseExactStartIdentity(/** @type {any} */ (read).observedStartIdentity) !== null) {
      const failedCarryClass = carriedIdentityIntervalClass(read);
      if (failedCarryClass !== 'stale') {
        learnedExactReference = /** @type {any} */ (read).observedStartIdentity;
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
 * The EXACT-MODE predicate of the witness establishment (§32 two-mode
 * discipline; §32.10 Findings 1–2): true only when EVERY side the comparison
 * consumes is exact. The record must DECLARE exactness (v3
 * `startIdentityExact: true`), carry the closed kinfo form for BOTH its
 * captured identities, and carry a numeric child instant that resolves from
 * that child identity; the read-time writer endpoint's identity and numeric
 * instant must agree on the same exact form; and, when the hop also binds a
 * read-time CHILD endpoint (hop 1: `childOsStartInstant` supplied), that
 * identity and numeric instant must be exact too. When the hop binds the
 * marker's CAPTURED start identity instead (hop 2: `childStartIdentity` is
 * the marker's captured identity, no endpoint numeric), that identity must
 * be the exact form — its GENERATION binding is the child-foreign equality
 * conjunct. EstablishThroughSpawnWitness additionally refuses exact mode
 * when a marker binding is consumed without any captured child identity
 * (the tuple is INCOMPLETE — exact mode never credits an unbound marker).
 * Mixed exactness (either side coarse, a lying declaration, or a
 * numeric/identity disagreement) falls back to the registered coarse
 * windows — it never borrows resolution it does not have.
 * @param {SpawnAncestryWitnessIdentity} facts
 * @param {{ childStartIdentity: string | null, childOsStartInstant?: number, writerStartIdentity: string, writerOsStartInstant?: number }} expected
 * @returns {boolean}
 */
function spawnWitnessExactMode(facts, expected) {
  if (facts.startIdentityExact !== true) return false;
  const childExact = parseExactStartIdentity(facts.childStartIdentity);
  const writerExact = parseExactStartIdentity(facts.writerStartIdentity);
  const endpointWriterExact = parseExactStartIdentity(expected.writerStartIdentity);
  if (childExact === null || writerExact === null || endpointWriterExact === null) return false;
  if (!Number.isSafeInteger(facts.childOsStartInstantMs)
    || /** @type {number} */ (facts.childOsStartInstantMs) !== childExact.ms) return false;
  if (!Number.isSafeInteger(expected.writerOsStartInstant)
    || /** @type {number} */ (expected.writerOsStartInstant) !== endpointWriterExact.ms) return false;
  if (expected.childStartIdentity !== null && expected.childStartIdentity !== undefined) {
    const endpointChildExact = parseExactStartIdentity(expected.childStartIdentity);
    if (endpointChildExact === null) return false;
    if (Number.isSafeInteger(expected.childOsStartInstant)) {
      // Hop 1's read-time child endpoint: the endpoint's numeric instant
      // must agree with its own exact identity.
      if (/** @type {number} */ (expected.childOsStartInstant) !== endpointChildExact.ms) return false;
    }
    // (§32.10 Finding 1) Hop 2's CAPTURED marker identity: the exact FORM is
    // required here; the GENERATION binding itself is the child-foreign
    // equality conjunct in establishThroughSpawnWitness (a different exact
    // identity is a different generation — refused there, never silently
    // demoted to coarse mode).
  }
  return true;
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
 * @returns {{ status: 'established', reason: null, witnessClass: 'spawn-boundary-capture', exact: boolean } | { status: 'unestablished', reason: string, detail?: string | null }}
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
  // (route (c), §32.10 Finding 2) the EXACT-MODE tuple is computed FIRST so
  // the identity binding and the round-4 proximity conjunct can be gated on
  // it (pure function of the record + the hop's expected facts — hoisting it
  // changes nothing else).
  // (§32.10 Finding 1) an exact tuple WITHOUT the marker's captured start
  // identity is INCOMPLETE: whenever a marker generation binding is consumed
  // (childMarkerEpochMs present) on a hop with no read-time child identity,
  // the marker's captured identity is the required exact child side. Without
  // it exact mode must not engage — the coarse adjudication applies (which on
  // the bound-window route refuses with the registered labels and can never
  // credit). Hops with a read-time child identity (hop 1: childOsStartInstant
  // supplied) are unaffected.
  const exactMode = spawnWitnessExactMode(facts, expected)
    && (typeof expected.childStartIdentity === 'string'
      || Number.isSafeInteger(expected.childOsStartInstant)
      || !Number.isSafeInteger(expected.childMarkerEpochMs));
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
  // hop's refreshed daemon read — childOsStartInstant supplied; or the
  // daemon→transport hop's marker CAPTURED start identity in exact mode,
  // §32.10 Finding 1), it must EQUAL the witnessed one. When the caller has
  // NO external child start identity (the coarse daemon→transport hop: the
  // marker carries kernel pid/ppid facts only), the witness's OWN captured
  // childStartIdentity — validated non-empty from the writer's OS-verified
  // boundary double read — is the positively captured generation binding
  // (the §26.6 anti-reuse argument: the witness binds the child's own start
  // identity and the parent's capture-time presence interval; a reused PID
  // cannot forge a parent relationship it never observed). The gate keeps
  // the coarse marker path byte-identical: a captured marker identity is
  // consumed only in exact mode or on a read-time-child hop.
  if (expected.childPid === null) return mismatch('spawn-witness-child-foreign');
  if (facts.childPid !== expected.childPid) return mismatch('spawn-witness-child-foreign');
  if (typeof expected.childStartIdentity === 'string'
    && (exactMode || Number.isSafeInteger(expected.childOsStartInstant))
    && facts.childStartIdentity !== expected.childStartIdentity) {
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
  // (codex gate round 48 review-mwe17z6i-3cs22y, Finding 2 — the
  // child/parent UNROUNDED creation order) in exact mode the inversion
  // compares the kernel's UNROUNDED creations (`sec * 1000 + usec / 1000`),
  // never the rounded persisted instants: a child `kinfo:1:200` (created
  // 1000.2) and a writer `kinfo:1:300` (created 1000.3) both round to 1000,
  // so the rounded comparison credited an inverted spawn order — the
  // kernel's own fork order contradicted by the exact identities. The
  // rounded values remain only the persisted representation (the exact-mode
  // tuple's agreement gates above); the coarse comparison below is
  // byte-identical.
  if (exactMode) {
    const exactChildCreation = parseExactStartIdentity(facts.childStartIdentity);
    const exactWriterCreation = parseExactStartIdentity(/** @type {string} */ (expected.writerStartIdentity));
    if (exactChildCreation !== null && exactWriterCreation !== null
      && exactChildCreation.sec * 1000 + exactChildCreation.usec / 1000
        < exactWriterCreation.sec * 1000 + exactWriterCreation.usec / 1000) {
      return mismatch('spawn-witness-creation-order-inverted');
    }
  }
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
  // a new precision claim. (§32.10 Finding 2: the conjunct is a COARSE
  // conjunct — gated on !exactMode. In exact mode the marker's generation
  // is bound by the captured start identity plus the exact ordering below,
  // and a capture window more than a second after the marker never refuses.)
  if (!exactMode && Number.isSafeInteger(expected.childMarkerEpochMs)
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
  // (route (c), §32 — the EXACT MODE) when the record's captured start
  // identities and the endpoint's start identities are BOTH the exact
  // kinfo form, the numeric instants are EXACT (same clock domain as the
  // wall clock) and the ±1000 uncertainty windows collapse to exact
  // orderings: the marker must simply POSTDATE the witnessed child's
  // creation (markerTime ≥ childExactStart) — no window, no ambiguity
  // band. The exact mode never changes coarse outcomes: coarse records/
  // endpoints keep the registered windows byte-identically. The BOTH-SIDES
  // discipline (the §32 two-mode rule): exact mode requires the RECORD's
  // declared flag, the record's own two identities and numeric instant to
  // agree with the closed exact form, AND every PRESENT endpoint identity
  // (writer always; the read-time child on hop 1; the marker's CAPTURED
  // start identity on hop 2 — §32.10 Finding 1, bound by the child-foreign
  // conjunct) to be exact. A marker without a captured identity leaves the
  // exact tuple INCOMPLETE (§32.10 Finding 1: exact mode never engages; the
  // coarse adjudication applies). Mixed exactness falls back to the coarse
  // windows; it never borrows exactness it does not have.
  // (exactMode itself is hoisted to the top of this function — §32.10
  // Finding 2 — so the proximity conjunct above could be gated on it.)
  if (Number.isSafeInteger(expected.childMarkerEpochMs)) {
    if (!Number.isSafeInteger(facts.childOsStartInstantMs)
      || /** @type {number} */ (expected.childMarkerEpochMs) < /** @type {number} */ (facts.childOsStartInstantMs)) {
      return mismatch('spawn-witness-marker-generation-unbound');
    }
    // (codex gate round 50 review-mwe9xpn0-7mhztk, Finding 1 — the
    // OVERLAPPING QUANTIZED TIE; corrected by codex gate round 51
    // review-mwed42xp-tf84jm, Finding 1 — the TRUE ROUNDING INTERVAL;
    // completed by codex gate round 63 review-mwfxlzpe-0fve20, Finding 1 —
    // the ALIGNED-CHILD TIE) the marker producer persists
    // `Math.round(markerStats.mtimeMs)`, so a persisted marker time M
    // represents the true write window [M - 0.5, M + 0.5) — not [M, M + 1).
    // The child's TRUE creation is C = sec * 1000 + usec / 1000 (the exact
    // identity's unrounded instant; its persisted R = round(C) is only the
    // representation). A marker TIED with R carries the true write window
    // [R - 0.5, R + 0.5), so the tie is exact evidence ONLY when the whole
    // window lies at/after C — window lower bound R - 0.5 >= C, left edge
    // INCLUDED. The exact HALF (usec % 1000 === 500, C = R - 0.5 exactly) is
    // the one establishing tie: every true write is at/after the creation
    // (the demonstrable-ordering convention). EVERY other tie — the
    // quantize-down and quantize-up fractions AND the millisecond-ALIGNED
    // child (C = R, so R - 0.5 < C) — has possible writes strictly before
    // the child existed: ambiguous, never resolved as true (the module's
    // convention; the coarse band below refuses the same overlap as
    // ambiguous). A marker strictly AFTER R has its whole window at/after C
    // under every quantization direction (unchanged). The aligned exemption
    // the round-50/51 rule carried is RETIRED: the persisted marker time is
    // rounded even when the child's creation is millisecond-aligned.
    const markerExactChild = exactMode ? parseExactStartIdentity(facts.childStartIdentity) : null;
    if (exactMode && markerExactChild !== null
      && /** @type {number} */ (expected.childMarkerEpochMs) === /** @type {number} */ (facts.childOsStartInstantMs)) {
      const markerExactChildCreationMs = markerExactChild.sec * 1000 + markerExactChild.usec / 1000;
      if (/** @type {number} */ (expected.childMarkerEpochMs) - 0.5 < markerExactChildCreationMs) {
        return mismatch('spawn-witness-marker-generation-ambiguous');
      }
    }
    if (!exactMode && /** @type {number} */ (expected.childMarkerEpochMs) < /** @type {number} */ (facts.childOsStartInstantMs) + LINUX_BTIME_UNCERTAINTY_MS) {
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
  // facts prove; route (c)'s higher-resolution generation evidence RESOLVES
  // this ambiguity in the exact mode below, §32, and the coarse windows
  // apply only to coarse data).
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
  // (route (c) exact mode) the writer continuity exact ordering: the write
  // must postdate the writer's EXACT creation (no +1000 window).
  // (codex gate round 48 review-mwe17z6i-3cs22y, Finding 2 — the UNROUNDED
  // CREATION vs the PRECISE WRITE) the ordering consumes the kernel's
  // UNROUNDED creation (`sec * 1000 + usec / 1000`) against the witness's
  // PRECISE write (`firstWritePreciseMs` when carried, the rounded
  // `firstWriteEpochMs` otherwise), never the ROUNDED pair: a writer
  // identity `kinfo:1:300` (creation 1000.3) rounds to 1000, so a witness
  // written at 1000.2 passed the rounded comparison although the writer did
  // not exist when the witness was written — the Companion→daemon hop
  // established on contradictory evidence. The rounded values remain only
  // the persisted representation (the exact-mode tuple's agreement gates
  // above); the coarse arm below is byte-identical.
  const exactWriterCreation = exactMode
    ? parseExactStartIdentity(/** @type {string} */ (expected.writerStartIdentity)) : null;
  const witnessWritePreciseMs = typeof facts.firstWritePreciseMs === 'number'
    ? facts.firstWritePreciseMs : facts.firstWriteEpochMs;
  if (exactMode && exactWriterCreation !== null
    && /** @type {number} */ (witnessWritePreciseMs) < exactWriterCreation.sec * 1000 + exactWriterCreation.usec / 1000) {
    return mismatch('spawn-witness-parent-generation-ambiguous');
  }
  if (!exactMode && /** @type {number} */ (facts.firstWriteEpochMs) < /** @type {number} */ (expected.writerOsStartInstant) + LINUX_BTIME_UNCERTAINTY_MS) {
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
  // (codex gate round 58 review-mwfb8x00-exyttv, Finding 1 — the EXACT
  // CHILD-CREATION ORDERING INDEPENDENT OF THE OPTIONAL ENDPOINT INSTANT)
  // the exact child-continuity write ordering below was nested under the
  // read-time-child endpoint conjunct (`Number.isSafeInteger(
  // expected.childOsStartInstant)`), but the daemon→transport hop supplies
  // NO endpoint numeric — its child side is the marker's CAPTURED exact
  // identity and the record's own `childStartIdentity`. The unrounded
  // creation vs precise write comparison therefore consumed only the record
  // and the optional endpoint instant is NOT part of it: a writer
  // `kinfo:1:100` (1000.1), child `kinfo:1:300` (1000.3), boundary/write
  // 1000, precise write 1000.2 and marker 1001 established the hop although
  // the child did not exist when the witness was written. The comparison is
  // hoisted here, identical in both hops: the kernel's UNROUNDED creation
  // (from the record's captured exact child identity) against the PRECISE
  // write (the R57/R48 convention — `firstWritePreciseMs` when carried, the
  // rounded `firstWriteEpochMs` otherwise); a strictly earlier write
  // refuses the existing child-continuity label, a same-instant tie keeps
  // the tie convention, and the coarse arm never engages (exactMode only).
  const exactWitnessedChildCreation = exactMode
    ? parseExactStartIdentity(facts.childStartIdentity) : null;
  if (exactWitnessedChildCreation !== null
    && /** @type {number} */ (witnessWritePreciseMs) < exactWitnessedChildCreation.sec * 1000 + exactWitnessedChildCreation.usec / 1000) {
    return mismatch('spawn-witness-child-generation-ambiguous');
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
  // prove; route (c)'s higher-resolution generation evidence RESOLVES this
  // ambiguity in the exact mode below, §32). Only hops that bind a
  // READ-TIME child endpoint
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
    // (route (c) exact mode) the child continuity exact ordering: the
    // boundary must postdate the child's EXACT creation (no +1000 window)
    // and the child endpoint read must follow the boundary.
    if (!exactMode && /** @type {number} */ (facts.boundaryEpochMs) < /** @type {number} */ (expected.childOsStartInstant) + LINUX_BTIME_UNCERTAINTY_MS) {
      return mismatch('spawn-witness-child-generation-ambiguous');
    }
    if (exactMode && /** @type {number} */ (facts.boundaryEpochMs) < /** @type {number} */ (expected.childOsStartInstant)) {
      return mismatch('spawn-witness-child-generation-ambiguous');
    }
    // (codex gate round 57 review-mwf7zc16-j6y8je, Finding 1 — the CHILD
    // CONTINUITY'S UNROUNDED CREATION vs the PRECISE WRITE, the child-side
    // sibling of the round-48 writer ordering above) in exact mode the
    // witnessed child must have existed when the witness was WRITTEN: a
    // child `kinfo:1:300` (true creation 1000.3) rounds to 1000, so a
    // witness with `boundaryEpochMs`/`firstWriteEpochMs` 1000 and
    // `firstWritePreciseMs` 1000.2 passed the rounded boundary comparison
    // although the child did not exist at the write — the Companion→daemon
    // hop established on contradictory evidence. The exact ordering consumes
    // the kernel's UNROUNDED creation (`sec * 1000 + usec / 1000`) against
    // the PRECISE write (`firstWritePreciseMs` when carried, the rounded
    // `firstWriteEpochMs` otherwise): a strictly earlier write refuses the
    // existing child-continuity label; the same-instant tie keeps the
    // module's convention (ties establish) and the coarse arm is
    // byte-identical.
    // (codex gate round 58 review-mwfb8x00-exyttv, Finding 1) the check is
    // HOISTED above this block — it consumes the record's captured exact
    // child identity, never the optional endpoint instant — so it applies
    // identically to this read-time-child hop and the marker-only
    // daemon→transport hop.
    if (!Number.isSafeInteger(expected.childReadStartedEpochMs)
      || /** @type {number} */ (expected.childReadStartedEpochMs) < /** @type {number} */ (facts.boundaryEpochMs)) {
      return mismatch('spawn-witness-child-generation-ambiguous');
    }
  }
  return ({ status: 'established', reason: null, witnessClass: 'spawn-boundary-capture', exact: exactMode });
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
 *   transportMarker: { pid: number, ppid: number, nonce: string, startIdentity?: string },
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
    // (§32.10 Finding 1) the marker's CAPTURED start identity rides the
    // transportMarker (schema-additive; the runtime composes it from the
    // captured transport identity). In exact mode it is BOUND to the
    // record's childStartIdentity via the child-foreign conjunct — a
    // same-pid successor's marker (its own captured identity) can never
    // ride the witnessed child's generation. A marker WITHOUT the captured
    // identity leaves the exact tuple INCOMPLETE: exact mode never engages
    // (the hoisted predicate requires the string whenever a marker binding
    // is consumed on this hop) and the coarse adjudication applies. The
    // coarse path is byte-identical: without exactMode the identity
    // conjunct's gate stays closed.
    const markerCapturedIdentity = typeof marker.startIdentity === 'string' && marker.startIdentity.length > 0
      ? marker.startIdentity : null;
    const witnessOutcome = daemonSpawnWitness === undefined || !boundWindowRefused ? null : establishThroughSpawnWitness(daemonSpawnWitness, {
      writerPid: daemonFacts.pid,
      writerStartIdentity: daemonFacts.startIdentity,
      childPid: marker.pid,
      childStartIdentity: markerCapturedIdentity,
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
      // (codex round 16 — EXPLICIT UNSATISFIABILITY, §28.22 — SUPERSEDED FOR
      // EXACT DATA, §32) The COARSE route is unreachable by construction:
      // it is entered only when `markerTime < daemonStart +
      // LINUX_BTIME_UNCERTAINTY_MS` (the bound window above), while the
      // coarse establishment predicate requires `markerTime >=
      // childOsStartInstantMs + LINUX_BTIME_UNCERTAINTY_MS` (the positive
      // marker-to-generation binding) under `childOsStartInstantMs >=
      // daemonStart` (the creation-order binding) — jointly `markerTime >=
      // daemonStart + LINUX_BTIME_UNCERTAINTY_MS`, contradicting the entry
      // condition. That classification is UNCHANGED for coarse records/
      // endpoints: if a coarse establishment ever reached this branch the hop
      // REFUSES with `spawn-witness-route-unsatisfiable` instead of crediting
      // a witnessClass establishment (fail-closed).
      // (route (c), §32) The EXACT-MODE outcome is the registered bounded
      // repair §28.22 itself proposed: when the record and the daemon
      // endpoint carry the closed exact forms, the marker binding collapses
      // to `markerTime >= childExactStart` (no +1000 window), so the
      // contradiction genuinely disappears and the witness establishes the
      // same-second daemon→transport hop with its named witnessClass. The
      // coarse refusals below stay byte-identical; only an outcome whose
      // `exact` flag proves every consumed side exact may credit.
      daemonToTransport = witnessOutcome.exact === true
        ? { status: 'established', reason: null, witnessClass: /** @type {const} */ ('spawn-boundary-capture') }
        : hopVerdict('unestablished', 'spawn-witness-route-unsatisfiable', null);
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
      } else if (parseExactStartIdentity(observation.startIdentity) !== null) {
        // (§32.12 Finding 1) Route (c) exact darwin: the kinfo identity
        // carries its own EXACT ms creation — compared against the
        // write-time expectation by EXACT arithmetic, never floor-to-second
        // equality (a valid NON-second-aligned start such as 1793855520123
        // must settle, never trip the coarse second-equality).
        // (§32.13 Finding 1) the UPPER bound derives from the record's OWN
        // write evidence, never a blanket +1000 over recordStart: a creation
        // after the record's write (firstWritePreciseMs) did not exist when
        // the record was written — a PROVABLE successor the round-2 bound
        // admitted (the reviewer's schedule: startOriginMs 1900, write 1920,
        // creation 2100 settled). Ties establish (the module's convention —
        // the round-6-era positive: a write just after the child's exact
        // start); the lower arm keeps the fork-before-boundary tolerance.
        // (codex gate round 47 review-mwdue8eb-56vwlf, Finding 1 — the
        // UNROUNDED KERNEL CREATION) the upper comparison uses the kernel's
        // UNROUNDED creation (sec/usec against the precise write), never the
        // ROUNDED `startInstant`: a sub-millisecond window (`usec` under 500)
        // collapses to the write's whole millisecond under rounding, and a
        // record written AFTER the true creation but BEFORE the next whole
        // millisecond established successfully. The lower arm keeps the
        // rounded `startInstant` — the fork-before-boundary tolerance is a
        // whole-second comparison by its own documented semantics.
        const exactCreation = parseExactStartIdentity(/** @type {string} */ (observation.startIdentity));
        // (the branch condition above proved the identity exact — the null
        // fallback is unreachable and falls back to the prior rounded upper
        // arm byte-identically)
        const kernelCreationPreciseMs = exactCreation !== null
          ? exactCreation.sec * 1000 + exactCreation.usec / 1000
          : startInstant;
        if (kernelCreationPreciseMs > recordWrite
          || startInstant < Math.floor(recordStart / 1000) * 1000 - LINUX_BTIME_UNCERTAINTY_MS) {
          reasons.push('generation-start-second-mismatch');
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
      // (codex gate round 20, Finding 3 — the CARRIED EXACT CREATION CHECK)
      // for a MIXED-resolution observation the exact creation evidence
      // resides in os.observedStartIdentity while observation.startIdentity
      // stayed coarse: the branch chain above consumed only the coarse
      // second and a broker startup written inside that second accepted a
      // carried occupant created AFTER the startup record. The exact
      // creation-versus-write check applies to the admissible carried
      // identity too (the same two-sided rule the exact branch applies to
      // its own identity — the upper bound derives from the record's OWN
      // write evidence, ties establish, the lower arm keeps the
      // fork-before-boundary tolerance): a carried occupant created after
      // the write (or before the record's start tolerance) is the same
      // named mismatch, never credited.
      const carriedExactCreation = typeof /** @type {any} */ (os).observedStartIdentity === 'string'
        ? parseExactStartIdentity(/** @type {any} */ (os).observedStartIdentity) : null;
      // (codex gate round 47 review-mwdue8eb-56vwlf, Finding 1 — the
      // CARRIED-EXACT CHECK'S UNROUNDED CREATION) the carried exact identity
      // takes the SAME unrounded upper comparison as the exact branch above:
      // its kernel seconds/microseconds are compared against the precise
      // write, never the rounded `ms`. The lower arm keeps the rounded
      // second-boundary tolerance (the two-second fork window).
      const carriedExactCreationPreciseMs = carriedExactCreation !== null
        ? carriedExactCreation.sec * 1000 + carriedExactCreation.usec / 1000
        : null;
      if (reasons.length === 0 && carriedExactCreation !== null && carriedExactCreationPreciseMs !== null
        && (carriedExactCreationPreciseMs > recordWrite
          || carriedExactCreation.ms < Math.floor(recordStart / 1000) * 1000 - LINUX_BTIME_UNCERTAINTY_MS)) {
        reasons.push('generation-start-second-mismatch');
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
