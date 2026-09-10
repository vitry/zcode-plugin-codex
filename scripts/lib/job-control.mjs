import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { createCancelAttemptStore } from './cancel-attempt.mjs';
import { PluginError } from './errors.mjs';
import { withFileLock } from './fs.mjs';
import { sweepDeadRootDescendantTree, terminateRecordedProcessTree } from './process.mjs';
import { waitForCompletionOrAbort } from './progress.mjs';
import { recordedWorkspaceBrokerPids, scanBrokerIdentityDirectory } from '../zcode-broker.mjs';
import { hostOwnedCancelledPatch, hostOwnedStopIntentPatch, STOP_CAUSES, validHostLifecycleRecord, validStopIntent } from './rescue-binding.mjs';
import { readQueuedRescueMigrationRollback } from './rescue-migration.mjs';
import { RESCUE_RUNNER_VERSION } from './rescue-execution-input.mjs';
import { classifyCurrentTurnSnapshot, hasCurrentTurnActivity, persistedTurnBoundary } from './turn-terminal.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
// The broker-identity lookup's own documented default bound (see
// recordedWorkspaceBrokerPids): the lookup may never claim MORE than this from
// the shared duty budget, and it always leaves the minimal termination slice
// below untouched so the guarded kill keeps a non-zero budget. Exported so the
// SessionEnd terminal-obligation sweep (see recovery.mjs) shares one accounting.
// The bound is pure filesystem I/O (no process launch), so one value serves
// both platforms.
export const BROKER_LOOKUP_MAX_BUDGET_MS = 250;
// The minimal non-zero budget the guarded kill keeps for itself when the
// broker lookup (or identity revalidation) has consumed most of the shared
// duty budget; below this slice the lookup is skipped entirely so the kill
// runs pid-only with the whole remaining budget instead of being starved.
// POSIX values are in-process dispatches (a group signal), so 50ms suffices.
// WINDOWS: the kill sequence is real process launches (graceful + forced
// taskkill, each 0.1-1s on a loaded machine) and one Windows process-table
// snapshot costs 0.5-3s (see process.mjs WINDOWS_SNAPSHOT_KILL_RESERVE_MS), so
// a 50ms reserve would let the lookup start a walk that starves the kill into
// a no-op — the runner would never even be signalled. The Windows reserve
// keeps the pid-only kill dispatchable and skips the lookup instead.
export const MIN_RUNNER_TERMINATION_BUDGET_MS = 50;
export const WINDOWS_MIN_RUNNER_TERMINATION_BUDGET_MS = 1_500;
// The absolute cap of one guarded runner termination inside a shared duty
// deadline (see terminateLeasedProcessTree): POSIX caps at the historical
// 750ms group-kill bound; Windows caps at one exclusion-aware walk (two
// bounded snapshots) plus the kill dispatch — still bounded by the caller's
// remaining deadline through the min() below.
export const WINDOWS_RUNNER_TERMINATION_BUDGET_MS = 6_000;
// The duty fallback when a caller (management reconciliation, cancellation
// election) proves NEITHER an absolute deadline nor a relative budget: POSIX
// keeps the historical 1_000ms; Windows needs a budget one kill plus one
// completed same-pass sweep can actually converge inside (two to four
// process-table snapshots plus taskkill dispatches). This fallback IS the
// Windows convergence budget for the NON-HOOK reconcile entry points —
// `status` / `status --wait` (the companion's management reconciler and
// owner-recovery passes) and the cancellation election carry no native hook
// limit, so 30s lets one pass fit even a cold CI sweep (each PowerShell
// snapshot alone costs 1.5-5s cold, and the pass also pays the identity
// revalidation, the broker lookup, and the guarded kill). The HOOK passes
// deliberately do NOT get this budget: a UserPromptSubmit reconciliation is
// capped near the native ten-second prompt limit (8s budget in
// hooks/lib/hook-state.mjs) and the SessionEnd pass at 2.75s, so on a slow
// machine those passes fail fast and defer — the durable stop intent plus the
// pending receipt re-arm the duty, and `status --wait` (THIS budget) is the
// Windows convergence driver that finishes what a deferred hook pass retained.
export const WINDOWS_RUNNER_DUTY_FALLBACK_MS = 30_000;

/** @param {string} [platform] @returns {number} the platform's lookup-skip threshold below which the kill runs pid-only. */
export function minRunnerTerminationBudgetMs(platform = process.platform) {
  return platform === 'win32' ? WINDOWS_MIN_RUNNER_TERMINATION_BUDGET_MS : MIN_RUNNER_TERMINATION_BUDGET_MS;
}

/** @param {string} [platform] @returns {number} the platform's absolute cap for one guarded runner termination. */
export function runnerTerminationBudgetCapMs(platform = process.platform) {
  return platform === 'win32' ? WINDOWS_RUNNER_TERMINATION_BUDGET_MS : 750;
}

/**
 * Read the one Rescue job bound to a trusted forwarding executor without
 * exposing any durable identity or execution metadata.
 * @param {{store:any,workspace:string,executor:{parentSessionId:string,agentId:string}}} input
 */
export async function readBoundRescueStatus(input) {
  if (!input?.store || typeof input.store.readBoundRescueCurrentJob !== 'function'
    || typeof input.workspace !== 'string' || input.workspace.length === 0
    || typeof input.executor?.parentSessionId !== 'string' || input.executor.parentSessionId.length === 0
    || typeof input.executor?.agentId !== 'string' || input.executor.agentId.length === 0) {
    throw new PluginError('BOUND_RESCUE_STATUS_INPUT_INVALID', 'The bound Rescue status input is invalid.', {
      category: 'authorization', remedy: 'Invoke status only from the active Rescue child.',
    });
  }
  let job;
  try { job = await input.store.readBoundRescueCurrentJob({ workspace: input.workspace, parentSessionId: input.executor.parentSessionId, executorAgentId: input.executor.agentId }); }
  catch (error) {
    if (error instanceof PluginError && error.code === 'RESCUE_BINDING_CLOSED') throw new PluginError('BOUND_RESCUE_STATUS_NOT_FOUND', 'No exact bound Rescue status is available.', { category: 'authorization', remedy: 'Continue waiting on the original Rescue foreground execution.' });
    throw boundRescueStatusUnavailable();
  }
  const progressPreview = Array.isArray(job.progressPreview)
    ? job.progressPreview.filter((/** @type {unknown} */ value) => typeof value === 'string').slice(-4)
    : [];
  return {
    type: 'rescue-status',
    status: job.status,
    phase: job.phase ?? null,
    lastActivityAt: job.lastActivityAt ?? job.updatedAt ?? null,
    progressPreview: [...progressPreview],
    terminal: TERMINAL.has(job.status),
  };
}

function boundRescueStatusUnavailable() {
  return new PluginError('BOUND_RESCUE_STATUS_UNAVAILABLE', 'Bound Rescue status is unavailable.', {
    category: 'state', remedy: 'Continue waiting on the original Rescue foreground execution.',
  });
}

/**
 * Serialize executor finalization with cancellation, using the same durable workspace lock.
 * @param {{dataRoot:string,workspace:string,jobId:string,storage?:any,timeoutMs?:number}} input
 * @param {()=>Promise<any>} operation
 */
export async function withJobCancellationLock(input, operation) {
  const storage = input.storage ?? await resolveWorkspaceStorage({ dataRoot: input.dataRoot, workspace: input.workspace });
  return withFileLock(join(storage.directory, 'cancel-locks', `${input.jobId}.lock`), operation, { timeoutMs: input.timeoutMs ?? 30_000 });
}

/** @param {string} sessionId */
export function ownerIdForSession(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) throw new PluginError('OWNER_ID_INVALID', 'Owner session is invalid.', { category: 'authorization', remedy: 'Use a validated caller context.' });
  return createHash('sha256').update(JSON.stringify(['zcode-owner-v1', sessionId])).digest('hex');
}

/** Hold the exact production worker identity for its full lifetime. @param {{dataRoot:string,workspace:string,jobId:string,workerLeaseId:string,timeoutMs?:number}} input @param {()=>Promise<any>} operation */
export async function withWorkerLease(input, operation) {
  if (!isDigestValue(input.jobId) || !isDigestValue(input.workerLeaseId)) {
    throw new PluginError('WORKER_LEASE_INVALID', 'Worker lease identity is invalid.', {
      category: 'state', remedy: 'Hold one 64-character lease digest for one canonical job ID.',
    });
  }
  const storage = await resolveWorkspaceStorage({ dataRoot: input.dataRoot, workspace: input.workspace });
  return withFileLock(joinWorkerLease(storage.directory, input.jobId, input.workerLeaseId), operation, { timeoutMs: input.timeoutMs ?? 30_000 });
}

/** @param {string} directory @param {string} jobId @param {string} workerLeaseId */
function joinWorkerLease(directory, jobId, workerLeaseId) { return `${directory}/worker-leases/${jobId}-${workerLeaseId}.lock`; }

/** @param {unknown} value */
function isDigestValue(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }

/**
 * Terminate the exact recorded worker tree ONLY while its worker lease is still
 * HELD: an acquirable (free) lease means the worker already exited and released,
 * and the OS may have reused its pid — signaling it could kill an unrelated
 * process group. A LOCK_TIMEOUT proves a live holder still owns the lease, so
 * the recorded pid is still that worker. Records without a digest lease never
 * signal. The broker exclusion is forwarded in exactly ONE of three states:
 * `input.excludeBrokers` (resolved by the writable-Rescue caller, see
 * terminateMarkedRunnerTree) names the COMPLETE, proven separately managed
 * broker identities — each a pid PLUS its recorded launch signature — the
 * Windows branch must spare, so it walks the runner's PPID descendant tree
 * excluding only identity-matched broker subtrees (a reused pid whose command
 * line no longer matches the recorded signature is never excluded);
 * `input.excludeUnknown` (the lookup failed, timed out, or proved nothing)
 * makes the Windows branch fail closed to the recorded pid alone (never /T)
 * because any descendant could be the broker; NEITHER state means the caller
 * has no broker concept at all and keeps the full `taskkill /T` tree cleanup.
 * The POSIX group kill cannot reach the detached broker (its own group at
 * spawn) and ignores both states. The outcome is reported so the guarded
 * caller can keep its accounting honest: `released` (nothing to signal — the
 * lease was free), `no-claim` (the record carries no signalable claim),
 * `budget-expired` (the deadline was spent before a proven kill could be
 * dispatched — the caller must NOT report the duty as performed), `incomplete`
 * (the Windows verified kill sequence stopped early — the shared budget was
 * spent or a dispatch failed after only some verified targets were signalled —
 * so verified descendants survive and the caller must NOT report the duty as
 * performed either), and `signaled` (the proven tree termination ran to its
 * complete verified plan).
 * @param {any} input @param {any} job @param {(pid:number,options:{signal?:AbortSignal,timeoutMs?:number,excludeBrokers?:readonly {pid:number,command:string,args:string[]}[],excludeUnknown?:boolean})=>Promise<unknown>} terminateProcessTree
 * @returns {Promise<{signaled:boolean, reason:'released'|'no-claim'|'budget-expired'|'incomplete'|'signaled', pending?:number[]}>}
 */
export async function terminateLeasedProcessTree(input, job, terminateProcessTree) {
  if (!isDigestValue(job.workerLeaseId) || !Number.isSafeInteger(job.childPid) || job.childPid <= 0) return { signaled: false, reason: 'no-claim' };
  try {
    await withWorkerLease({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: job.id, workerLeaseId: job.workerLeaseId, timeoutMs: 0 }, async () => {
      // The lease was FREE — the recorded worker already released it, so the
      // recorded pid is no longer proven to be that worker. Never signal it.
      return undefined;
    });
    return { signaled: false, reason: 'released' };
  } catch (error) {
    if (error instanceof PluginError && error.code === 'LOCK_TIMEOUT') {
      // A live holder still owns the lease: the recorded pid is still that
      // worker's group leader — the exact recorded tree, safe to terminate.
      // Local termination runs inside the caller's ABSOLUTE deadline when one
      // is proven (the stale initial remote timeout would grant a fresh budget
      // after the shared budget is already spent), capped by the platform's
      // termination bound; when the deadline is already spent, the kill is
      // skipped and the pending receipt remains the compensation authority.
      // The remote-control signal never gates this local kill.
      const absoluteDeadlineMs = typeof input.deadlineMs === 'number' && Number.isFinite(input.deadlineMs)
        ? input.deadlineMs - Date.now()
        : (typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) ? input.timeoutMs : runnerTerminationBudgetCapMs());
      const terminationBudgetMs = Math.min(absoluteDeadlineMs, runnerTerminationBudgetCapMs());
      if (terminationBudgetMs <= 0) return { signaled: false, reason: 'budget-expired' };
      // Re-probe once immediately before signaling: the first LOCK_TIMEOUT may
      // predate a scheduling gap in which the worker released its lease, exited,
      // and its pid was reused — signaling then could hit an unrelated process.
      // A second zero-timeout contention observation keeps the identity proof as
      // close to the kill as the lease protocol allows. This two-probe window is
      // the existing BEST-EFFORT identity policy, not an atomic OS process handle:
      // a probe-to-signal race remains by design, and a free lease is never
      // signaled.
      try {
        await withWorkerLease({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: job.id, workerLeaseId: job.workerLeaseId, timeoutMs: 0 }, async () => undefined);
        return { signaled: false, reason: 'released' };
      } catch (reprobeError) {
        if (!(reprobeError instanceof PluginError && reprobeError.code === 'LOCK_TIMEOUT')) throw reprobeError;
      }
      const termination = await terminateProcessTree(job.childPid, {
        timeoutMs: terminationBudgetMs,
        ...(Array.isArray(input.excludeBrokers) && input.excludeBrokers.length > 0
          ? { excludeBrokers: input.excludeBrokers }
          : input.excludeUnknown === true ? { excludeUnknown: true } : {}),
      });
      // The Windows verified kill sequence reports INCOMPLETE when it stopped
      // early — the shared budget was spent (typically by the runner's own
      // kill) or a dispatch failed — with verified descendants still alive.
      // Reporting `signaled` would let the settlement discharge a cleanup
      // obligation whose surviving descendants have no retry path, so the
      // outcome stays honest: non-signaled, with the pending pids preserved
      // as evidence for the duty that must re-arm. The post-kill lease
      // convergence below still runs first — the runner itself is the FIRST
      // verified target and is usually already signalled — only the reported
      // outcome differs.
      // The lease is process-lifetime: it frees when the terminated executor is
      // reaped. Wait (bounded by the same absolute deadline, polling ONLY the
      // lease lock — never a state or cancellation lock) so a lease-acquiring
      // settlement in the same pass converges instead of deferring to a retry.
      const releaseDeadlineMs = typeof input.deadlineMs === 'number' && Number.isFinite(input.deadlineMs)
        ? input.deadlineMs - Date.now()
        : (process.platform === 'win32' ? 1_000 : 300);
      await waitForWorkerLeaseRelease(input, job, releaseDeadlineMs);
      const incompleteOutcome = /** @type {any} */ (termination);
      if (incompleteOutcome !== null && typeof incompleteOutcome === 'object' && incompleteOutcome.completed === false) {
        return { signaled: false, reason: 'incomplete', pending: Array.isArray(incompleteOutcome.pending) ? [...incompleteOutcome.pending] : [] };
      }
      return { signaled: true, reason: 'signaled' };
    }
    throw error;
  }
}

/**
 * Poll the exact worker lease (zero-timeout acquisitions) until it releases or
 * the bounded local budget expires. Each acquisition is immediately released,
 * so this never blocks a live holder beyond one probe and never waits on
 * anything but the lease lock. The poll delay honors the controller's
 * injectable `setTimeout`/`clearTimeout` (falling back to the globals) so
 * tests drive it deterministically like every other wait loop.
 * @param {any} input @param {any} job @param {number} budgetMs
 */
async function waitForWorkerLeaseRelease(input, job, budgetMs) {
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) return;
  const scheduleTimeout = input.setTimeout ?? globalThis.setTimeout;
  const cancelTimeout = input.clearTimeout ?? globalThis.clearTimeout;
  const deadline = Date.now() + Math.min(budgetMs, process.platform === 'win32' ? 1_000 : 750);
  for (;;) {
    let held = true;
    try {
      await withWorkerLease({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: job.id, workerLeaseId: job.workerLeaseId, timeoutMs: 0 }, async () => { held = false; });
    } catch (error) {
      if (!(error instanceof PluginError && error.code === 'LOCK_TIMEOUT')) throw error;
    }
    if (!held) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await new Promise((resolve) => {
      /** @type {any} */ let pollTimer;
      pollTimer = scheduleTimeout(() => { cancelTimeout(pollTimer); resolve(undefined); }, Math.min(25, remaining));
    });
  }
}

/**
 * Guarded local termination of one MARKED detached Rescue runner, CLOSED by
 * the same-pass descendant sweep — the structural settlement invariant: a
 * marked claim is `settled` ONLY when this pass ran the guarded kill decision
 * AND a COMPLETED dead-root descendant sweep that found nothing left to kill.
 * The cleanup selection's exact identity must survive revalidation: the
 * runner-format marker, this owner's writable Rescue job, the owner/epoch the
 * caller settled for, and the unchanged executor PID + worker-lease claim —
 * plus (inside the shared lease primitive) two nonblocking held-lease probes
 * immediately around the signal. A free lease is never signaled, and an
 * unmarked attached companion is NEVER targeted with detached process-group
 * termination. The bounded local budget derives from the absolute `deadlineMs`
 * only: a remote abort spends neither this duty nor the caller's locks. Every
 * failure mode (unreadable record, identity mismatch, contended read) fails
 * closed as non-termination; the durable cancelling/queued-stop evidence
 * re-arms the duty for the next bounded pass (discovery of terminal marked
 * claims never depends on the lease state, so every later pass retries the
 * SAME sweep — the sweep itself is the retry authority; no cleanup ledger
 * exists). This mutates no job state: the marker/PID/lease stay preserved
 * until the executor itself releases them.
 *
 * WINDOWS PASS-BUDGET SPLIT (convergence): a caller that proves no deadline
 * gets the platform fallback (`WINDOWS_RUNNER_DUTY_FALLBACK_MS`) — the NON-HOOK
 * reconcile entry points (`status` / `status --wait`, the owner-recovery pass,
 * the cancellation election) carry no native hook limit, so on Windows their
 * budget is the realistic multi-second convergence window. HOOK passes
 * deliberately do NOT converge on Windows: a UserPromptSubmit reconciliation
 * is capped near the native ten-second prompt limit and the SessionEnd pass at
 * ~2.75s, and a cold process-table sweep alone can exceed either on a loaded
 * machine — those passes fail fast, retain the durable stop evidence, and
 * defer; `status --wait` (this fallback budget) is the Windows convergence
 * driver that finishes what a deferred hook pass retained.
 *
 * OUTCOME CONTRACT (marked claims):
 * - `settled` — the kill ran (or the runner had already exited and released)
 *   AND the same-pass sweep COMPLETED CLEAN: the tree is proven gone.
 * - `pending` — the kill decision ran but the sweep did not come back clean
 *   (`sweep` names the evidence: `swept` survivors were signalled,
 *   `incomplete` the sweep could not run or prove — spent budget, an unproven
 *   Windows broker exclusion lookup (`failed`; POSIX never consults one, see
 *   sweepDeadRootForDuty), a dead-root proof failure
 *   (`root-alive` residual)). The caller must retain: no terminal
 *   publication, no exclusion release, no receipt discharge.
 * - `budget-expired` — the shared deadline was spent before a proven kill
 *   could be dispatched, or the verified kill sequence stopped early. Same
 *   retention obligation as `pending`.
 * - `unmarked` — no marked claim: no local duty exists and the caller's
 *   settlement is not gated.
 * - `unproven` / `not-proven` — the claim identity is unprovable: retention.
 * @param {{store:any,dataRoot:string,workspace:string,ownerSessionId:string,epoch?:string|null,deadlineMs?:number,timeoutMs?:number,platform?:string,setTimeout?:(callback:()=>void,ms:number)=>any,clearTimeout?:(timer:any)=>void,sweepDeadRootDescendants?:(pid:number,options:{timeoutMs?:number,excludeBrokers?:readonly {pid:number,command:string,args:string[]}[]})=>Promise<{kind:'root-alive'}|{kind:'clean'}|{kind:'swept',killed:number[],pending:number[]}|{kind:'incomplete',pending:number[]}>,scanBrokerIdentities?:(brokerDirectory:string,options:{timeoutMs?:number})=>Promise<{status:'resolved'|'absent'|'failed',pids:number[],brokers:{pid:number,command:string,args:string[]}[]}>}} input
 * @param {any} selection the durable record this cleanup was selected for
 * @param {(pid:number,options:{timeoutMs?:number,excludeBrokers?:readonly {pid:number,command:string,args:string[]}[],excludeUnknown?:boolean})=>Promise<unknown>} [terminateProcessTree]
 * @returns {Promise<{kind:'unmarked'|'unproven'|'budget-expired'|'not-proven'|'settled'|'pending',sweep?:('swept'|'incomplete'|'root-alive'),pending?:number[]}>}
 */
export async function terminateMarkedRunnerTree(input, selection, terminateProcessTree = terminateRecordedProcessTree) {
  // The per-pass duty diagnostic is Windows-only, unconditional, and permanent
  // (the repo's stderr convention for bounded-pass evidence — the same
  // one-line discipline as the SessionEnd hook's `deferred:` diagnostics): one
  // stderr line per pass naming the outcome (`settled` / `pending` /
  // `budget-expired` / …), the sweep verdict (`swept` / `incomplete` /
  // `root-alive`), the guarded-kill reason, each stage's elapsed share of the
  // duty budget, and the total elapsed ms — so a slow CI machine shows WHICH
  // stage consumed the budget when a pass fails to converge, with no debug
  // flag required. Real Windows hosts only: a unit test pinning
  // `platform: 'win32'` on a POSIX host stays silent, and POSIX production
  // never emits (its group dispatch never budget-starves a pass).
  if (process.platform !== 'win32') return runMarkedRunnerDuty(input, selection, terminateProcessTree);
  const startedAtMs = Date.now();
  /** @type {Record<string, number|string>} */
  const stageTimings = {};
  try {
    const outcome = await runMarkedRunnerDuty({ ...input, dutyStageTimings: stageTimings }, selection, terminateProcessTree);
    emitWindowsDutyDiagnostic(outcome, stageTimings, startedAtMs);
    return outcome;
  } catch (error) {
    emitWindowsDutyDiagnostic({ kind: 'not-proven', thrown: error instanceof PluginError ? error.code : 'throw' }, stageTimings, startedAtMs);
    throw error;
  }
}

/** Emit the Windows duty diagnostic line (see terminateMarkedRunnerTree).
 * Never throws: a diagnostic failure must never mask the duty outcome it
 * reports. @param {any} outcome @param {Record<string, number|string>} stageTimings @param {number} startedAtMs */
function emitWindowsDutyDiagnostic(outcome, stageTimings, startedAtMs) {
  try {
    const { budgetMs = 0, revalidateMs = 0, lookupMs = 0, killMs = 0, sweepMs = 0, killReason = '' } = stageTimings;
    const accounting = {
      outcome: outcome?.kind, ...(outcome?.sweep ? { sweep: outcome.sweep } : {}),
      ...(Array.isArray(outcome?.pending) && outcome.pending.length > 0 ? { pending: outcome.pending.length } : {}),
      ...(outcome?.thrown ? { thrown: outcome.thrown } : {}),
      ...(killReason ? { killReason } : {}),
      budgetMs, elapsedMs: Date.now() - startedAtMs,
      stageMs: { revalidate: revalidateMs, lookup: lookupMs, kill: killMs, sweep: sweepMs },
    };
    process.stderr.write(`ZCode marked-runner duty pass (windows): ${JSON.stringify(accounting)}\n`);
  } catch { /* diagnostics never mask the duty outcome */ }
}

/** The marked-runner cleanup duty itself (see terminateMarkedRunnerTree for
 * the contract). The optional `input.dutyStageTimings` record accumulates the
 * per-stage elapsed-ms accounting the Windows diagnostic surfaces.
 * @param {{store:any,dataRoot:string,workspace:string,ownerSessionId:string,epoch?:string|null,deadlineMs?:number,timeoutMs?:number,platform?:string,dutyStageTimings?:Record<string,number|string>,setTimeout?:(callback:()=>void,ms:number)=>any,clearTimeout?:(timer:any)=>void,sweepDeadRootDescendants?:(pid:number,options:{timeoutMs?:number,excludeBrokers?:readonly {pid:number,command:string,args:string[]}[]})=>Promise<{kind:'root-alive'}|{kind:'clean'}|{kind:'swept',killed:number[],pending:number[]}|{kind:'incomplete',pending:number[]}>,scanBrokerIdentities?:(brokerDirectory:string,options:{timeoutMs?:number})=>Promise<{status:'resolved'|'absent'|'failed',pids:number[],brokers:{pid:number,command:string,args:string[]}[]}>}} input
 * @param {any} selection the durable record this cleanup was selected for
 * @param {(pid:number,options:{timeoutMs?:number,excludeBrokers?:readonly {pid:number,command:string,args:string[]}[],excludeUnknown?:boolean})=>Promise<unknown>} [terminateProcessTree]
 * @returns {Promise<{kind:'unmarked'|'unproven'|'budget-expired'|'not-proven'|'settled'|'pending',sweep?:('swept'|'incomplete'|'root-alive'),pending?:number[]}>}
 */
async function runMarkedRunnerDuty(input, selection, terminateProcessTree = terminateRecordedProcessTree) {
  // Marker requirement FIRST: absence means an attached/legacy record, whose
  // process group may be the caller's own — never a termination target here.
  if (!isPlainRecord(selection) || selection.rescueRunnerVersion !== RESCUE_RUNNER_VERSION
    || selection.command !== 'rescue' || selection.readOnly !== false) return { kind: 'unmarked' };
  if (!isDigestValue(selection.workerLeaseId) || !Number.isSafeInteger(selection.childPid) || selection.childPid <= 0) return { kind: 'unproven' };
  // One platform resolution drives every budget split below (the caller may
  // pin a foreign platform for contract tests, exactly like the sweep split).
  const platform = typeof input.platform === 'string' && input.platform.length > 0 ? input.platform : process.platform;
  const remainingMs = Number.isSafeInteger(input.deadlineMs) && Number.isFinite(input.deadlineMs)
    ? Math.max(0, /** @type {number} */ (input.deadlineMs) - Date.now())
    : (Number.isSafeInteger(input.timeoutMs) && /** @type {number} */ (input.timeoutMs) >= 0 ? /** @type {number} */ (input.timeoutMs) : platform === 'win32' ? WINDOWS_RUNNER_DUTY_FALLBACK_MS : 1_000);
  if (remainingMs <= 0) return { kind: 'budget-expired' };
  // ONE absolute local bound spans the whole duty (identity revalidation →
  // broker lookup → guarded kill): the caller's proven absolute deadline, or
  // the relative fallback budget anchored here when no deadline was proven.
  const dutyDeadlineMs = Number.isSafeInteger(input.deadlineMs) && Number.isFinite(input.deadlineMs)
    ? /** @type {number} */ (input.deadlineMs)
    : Date.now() + remainingMs;
  // Per-stage elapsed-ms accounting for the Windows duty diagnostic (see
  // terminateMarkedRunnerTree); a plain object noop when the diagnostic is off.
  const stageTimings = input.dutyStageTimings;
  const dutyStartedAtMs = Date.now();
  if (stageTimings) stageTimings.budgetMs = Math.max(0, dutyDeadlineMs - dutyStartedAtMs);
  const markStage = (/** @type {string} */ name, /** @type {number} */ sinceMs) => { if (stageTimings) stageTimings[name] = Date.now() - sinceMs; };
  // Identity revalidation reads the LATEST durable record under a bounded lock
  // budget but never under the (possibly expired) remote-control signal: an
  // unreadable or contended read fails closed without signaling.
  let current = null;
  const revalidateStartedAtMs = Date.now();
  try { current = await input.store.readJob(input.workspace, selection.id, { timeoutMs: Math.min(remainingMs, 500) }); }
  catch { markStage('revalidateMs', revalidateStartedAtMs); return { kind: 'not-proven' }; }
  markStage('revalidateMs', revalidateStartedAtMs);
  if (!isPlainRecord(current) || current.id !== selection.id
    || current.ownerSessionId !== input.ownerSessionId
    || current.command !== 'rescue' || current.readOnly !== false
    || current.rescueRunnerVersion !== RESCUE_RUNNER_VERSION
    // Exact claim: the recorded executor PID + lease pair must be unchanged.
    || current.childPid !== selection.childPid || current.workerLeaseId !== selection.workerLeaseId
    || (typeof input.epoch === 'string' && current.ownerLifecycleEpoch !== input.epoch)
    || (typeof selection.ownerLifecycleEpoch === 'string' && current.ownerLifecycleEpoch !== selection.ownerLifecycleEpoch)) {
    return { kind: 'not-proven' };
  }
  // Broker exclusion resolution (writable-Rescue runner-termination path):
  // the durable workspace broker identities name the separately managed
  // brokers — each a recorded pid PLUS its recorded launch signature (how the
  // broker was launched) — that the Windows PPID-tree walk must spare, so
  // descendant cleanup stays EXACT: runner-owned descendants die, the broker
  // subtree survives, and a stale identity whose pid was reused by a
  // non-broker descendant is UNMASKED by the signature match instead of being
  // trusted as an exclusion. The lookup is THREE-VALUED and fails closed:
  // only a COMPLETE, proven identity-matched list forwards `excludeBrokers`;
  // a failed, timed-out, corrupt, partial, signature-less, or absent lookup
  // forwards the explicit `excludeUnknown` state instead, and the Windows
  // branch then kills ONLY the recorded pid (forced-only, never /T)
  // rather than risking a broker it cannot name — including a workspace that
  // legitimately records no broker yet, where pid-only stays the safe choice
  // because a broker could still exist (or start) unrecorded below the runner.
  // The POSIX group kill ignores both states.
  //
  // STARTUP SYNCHRONIZATION (why the resolved snapshot holds the lock): the
  // lookup runs under the `broker/.lock` startup lock `ensureZCodeBroker`
  // holds across daemon spawn + identity publication, and for a `resolved`
  // outcome it keeps that lock HELD past its return (the `release()` handle
  // below) until termination has been planned AND dispatched. Serialization
  // alone makes the snapshot authoritative: released early, a wire profile
  // starting in the lookup-return → kill gap would publish a broker pid
  // absent from the exclusion, and the descendant walk would force-kill that
  // managed broker as a "runner descendant" — violating the broker-survival
  // invariant (ADR 0021). `absent`/`failed` hold NO lock and need none: they
  // degrade to the pid-only kill, which never walks the descendant tree, so
  // a startup racing the kill (`absent` observed, broker spawns right after)
  // spawns outside the kill's reach entirely — the pid-only kill cannot touch
  // what it cannot walk.
  //
  // LOCK-ORDER SAFETY of the held span: the broker lock stays strictly BELOW
  // the cancellation lock this duty already runs under in production (the
  // settlement path takes broker AFTER cancellation, and no path holding
  // `broker/.lock` — ensureZCodeBroker, dead-identity retirement, the
  // broker's own owner-store locks — ever takes a cancellation lock), and the
  // span never WAITS on another lock: the worker-lease contacts inside
  // terminateLeasedProcessTree are zero-timeout probes (they report a held
  // lease instead of waiting), and the only blocking wait under the held
  // broker lock is the kill itself, bounded by this duty's absolute deadline
  // (the bounded release wait that follows it shares that same remaining
  // deadline: at expiry the release abandons its wait — the underlying unlock
  // proceeds in the background and self-heals free — so a wedged close can
  // never extend the caller's lifecycle deadline).
  // A runner blocked mid-startup on the broker lock we hold is exactly the
  // runner this duty kills — the kill and release unblock it; they cannot
  // deadlock on it.
  //
  // DEADLINE ACCOUNTING: the revalidation read above may have consumed an
  // unbounded share of the duty budget, so the lookup's budget is recomputed
  // FRESHLY here as the remaining time to `dutyDeadlineMs` (capped at the
  // lookup's own documented bound) minus a minimal non-zero slice the kill
  // keeps for itself — lookup and termination together can never exceed the
  // shared absolute deadline. When less than the minimal slice remains, the
  // lookup is skipped entirely and the kill runs pid-only (`excludeUnknown`)
  // with the whole remaining budget. If the lookup still spends its budget
  // past the deadline, the duty degrades to the established `budget-expired`
  // convention instead of dispatching a kill past the deadline or reporting
  // a false `settled` — the durable evidence re-arms the duty next pass.
  const remainingBeforeLookupMs = Math.max(0, dutyDeadlineMs - Date.now());
  if (remainingBeforeLookupMs <= 0) return { kind: 'budget-expired' };
  const lookupBudgetMs = Math.min(BROKER_LOOKUP_MAX_BUDGET_MS, remainingBeforeLookupMs - minRunnerTerminationBudgetMs(platform));
  /** @type {{status:'resolved'|'absent'|'failed',pids:number[],brokers:{pid:number,command:string,args:string[]}[],release?:(releaseBudgetMs?:number)=>Promise<void>}} */
  let exclusions = { status: 'failed', pids: [], brokers: [] };
  /** @type {{signaled:boolean, reason:'released'|'no-claim'|'budget-expired'|'incomplete'|'signaled', pending?:number[]}|undefined} */
  let termination = undefined;
  const lookupStartedAtMs = Date.now();
  try {
    if (lookupBudgetMs >= 1) {
      // The `resolved` outcome keeps the startup lock held past this call (see
      // STARTUP SYNCHRONIZATION above); the finally releases it. Below the
      // minimal slice, the lookup is skipped and the default fail-closed state
      // lets the guarded kill keep the entire remaining budget pid-only.
      try { exclusions = await recordedWorkspaceBrokerPids({ dataRoot: input.dataRoot, workspace: input.workspace, timeoutMs: lookupBudgetMs, holdResolvedLock: true }); }
      catch { exclusions = { status: 'failed', pids: [], brokers: [] }; }
    }
    markStage('lookupMs', lookupStartedAtMs);
    const remainingBeforeKillMs = Math.max(0, dutyDeadlineMs - Date.now());
    if (remainingBeforeKillMs <= 0) return { kind: 'budget-expired' };
    // The DERIVED absolute duty deadline is forwarded even when the caller
    // supplied only `timeoutMs`: lookup, guarded kill, AND the post-kill
    // lease-release poll below must share ONE absolute bound, or the release
    // poll would mint a fresh 300ms budget of its own and push the whole
    // cleanup past the caller's overall timeout.
    const killStartedAtMs = Date.now();
    termination = await terminateLeasedProcessTree({
      ...input,
      ...(exclusions.status === 'resolved' && exclusions.brokers.length > 0
        ? { excludeBrokers: exclusions.brokers }
        : { excludeUnknown: true }),
      deadlineMs: dutyDeadlineMs, timeoutMs: remainingBeforeKillMs,
    }, current, terminateProcessTree);
    markStage('killMs', killStartedAtMs);
  } finally {
    // Release the held broker startup lock — always AFTER termination returned
    // or the duty was abandoned, so the snapshot stays synchronized until
    // dispatch. The kill above is authoritative FIRST: the release wait can
    // never skip or reorder it. The release WAIT honors the duty's remaining
    // deadline (the lookup/kill shared the same absolute bound): a slow or
    // wedged data volume can stall the underlying unlock's asynchronous
    // file-handle close past any deadline, so at expiry the release abandons
    // the wait (the unlock proceeds in the background and self-heals free) and
    // resolves a bounded diagnostic instead of throwing from this `finally` or
    // extending the caller's lifecycle deadline. A release failure never masks
    // the duty's outcome, and the lock file itself stays consistent.
    if (typeof exclusions?.release === 'function') {
      await exclusions.release(Math.max(0, dutyDeadlineMs - Date.now())).catch(() => {});
    }
  }
  // Honest accounting: a deadline that expired between the lookup and the
  // dispatch surfaces as `budget-expired`, never as a kill that was silently
  // skipped — and so does an INCOMPLETE verified kill sequence: a Windows
  // walk whose shared budget expired (or a dispatch failed) after signalling
  // only part of the verified plan leaves verified descendants alive with no
  // other retry path, so the same durable budget-expired convention keeps
  // the job/stop-intent/lease evidence authoritative and re-arms the duty
  // next pass (where the sweep still discovers the survivors: Windows keeps
  // the original PPID, POSIX the process group).
  if (termination?.reason === 'budget-expired' || termination?.reason === 'incomplete') {
    // The kill reason rides the diagnostic outcome only (the public duty
    // contract stays the established budget-expired convention).
    if (stageTimings) stageTimings.killReason = termination.reason;
    return { kind: 'budget-expired' };
  }
  // THE SETTLEMENT INVARIANT (same-pass sweep): the kill decision proved —
  // at very best — the RUNNER gone; a released lease proves even less. Only
  // a COMPLETED dead-root descendant sweep that finds nothing left to kill
  // proves the TREE gone, and it must run in THIS pass: a `settled` outcome
  // is issued exclusively behind a `clean` sweep, so every caller can map
  // `settled` to terminal settlement and everything else to retention
  // (pending guard, no terminal publication, no exclusion release). The sweep
  // runs strictly AFTER the `finally` above released the kill's held broker
  // startup lock — on Windows the sweep resolves its OWN lock-held exclusions
  // (see sweepDeadRootForDuty), so a broker startup in between either fully
  // publishes (and is excluded by identity) or stays serialized outside the
  // walk's reach entirely; on POSIX the sweep is group-addressed and never
  // consults any broker identity at all.
  const sweepStartedAtMs = Date.now();
  const sweep = await sweepDeadRootForDuty(input, current, dutyDeadlineMs);
  markStage('sweepMs', sweepStartedAtMs);
  if (sweep.kind === 'clean') return { kind: 'settled' };
  return { kind: 'pending', sweep: sweep.kind, ...('pending' in sweep && Array.isArray(sweep.pending) && sweep.pending.length > 0 ? { pending: [...sweep.pending] } : {}) };
}

/**
 * The SAME-PASS dead-root descendant sweep behind the settlement invariant
 * (see terminateMarkedRunnerTree). The production sweep is
 * `sweepDeadRootDescendantTree` (process.mjs): it first proves the recorded
 * pid NOT alive — a dead root cannot have been reused by a live process —
 * then enumerates the surviving PPID descendants (Windows retains the original
 * PPID after parent death; POSIX addresses the survivors as the recorded
 * process group), revalidates them with the same double-snapshot identity
 * policy, prunes the identity-matched broker subtree, and force-kills the
 * verified survivors inside ONE shared absolute deadline.
 *
 * BROKER-EXCLUSION RESOLUTION IS SPLIT BY PLATFORM (ADR 0021 limits
 * broker-subtree exclusion to the Windows descendant walk):
 *
 * POSIX never consults the broker lookup at all. The sweep is group-addressed
 * — it signals the recorded leader's process GROUP, and the separately
 * managed broker is spawned detached in its OWN group — so no exclusion set
 * exists to prove: `absent`, `failed`, and lookup errors are irrelevant to a
 * walk that cannot reach the broker, and refusing to probe even the group (the
 * previous platform-blind rule) stranded every `absent`-lookup duty — a
 * runner that exited before creating a broker identity, or whose broker
 * already retired — pending forever, so cancellation and SessionEnd receipts
 * could never converge. The sweep runs on the recorded group/leader evidence
 * exactly as before.
 *
 * Windows (the PPID descendant walk) keeps the three-valued lookup:
 * - `resolved` — unchanged: the complete identity-matched exclusion set,
 *   serialized against startup by the startup lock the lookup keeps held
 *   (`holdResolvedLock`) across sweep planning AND dispatch, so an in-flight
 *   broker startup can neither publish its identity into an already-planned
 *   walk nor spawn below it; the lock is released only after the sweep
 *   returned. (The lookup's own convention makes a complete-but-empty scan
 *   `absent`, never `resolved`; an empty broker list here therefore walks
 *   with the equally-proven empty exclusion set.)
 * - `absent` — the walk RUNS with the proven-EMPTY exclusion set under the
 *   same `broker/.lock` startup lock, held by THIS duty for the sweep's whole
 *   duration (created via withFileLock when no broker layout exists yet).
 *   The lookup's `absent` observation is STALE by the time that lock is
 *   reacquired (the lookup released it at its return), so the empty set is
 *   RE-PROVEN inside the held lock: the identity scan re-runs there (the
 *   same scan internals the lookup ran under its own hold — the shared
 *   `scanBrokerIdentityDirectory` helper, which never takes a lock itself),
 *   and only a rescan that still finds NOTHING legitimizes walking with the
 *   empty exclusion set. A rescan that now finds identities — an orphan
 *   daemon the dead runner spawned publishing in the lookup-release →
 *   lock-reacquisition gap, a record another client could discover and ADOPT
 *   before this lock was reacquired — resolves through the SAME rules as the
 *   `resolved` path (exclude the proven launch-signature brokers) or fails
 *   the walk closed (`incomplete`) when the set is unprovable. The safety
 *   this proves: (1) the dead-root walk only ever reaches PPID-descendants
 *   of the recorded runner, which is proven DEAD first — a dead root cannot
 *   spawn, so every walk target was spawned by the runner itself before it
 *   died; (2) every live broker startup (ensureZCodeBroker) holds this
 *   exact lock across BOTH daemon spawn and identity publication, so while
 *   the duty holds it no live startup can exist mid-window — one that
 *   starts later blocks until release and then spawns parented by its own
 *   live starter, never below the dead root; (3) the one residual
 *   publisher is a daemon the dead runner already spawned whose identity
 *   lands AFTER the rescan, mid-walk: identity PUBLICATION deliberately does
 *   NOT take this lock — ensureZCodeBroker holds it across daemon spawn AND
 *   the publication-wait health probe, so a daemon publishing under the same
 *   lock would self-deadlock every normal startup (the parent waits for a
 *   publication its child cannot make), and restructuring the parent to
 *   release before publication would forfeit the single-flight spawn
 *   guarantee (concurrent ensures would double-spawn and spuriously fail).
 *   That residual daemon is an orphan of the exact dead-root tree this duty
 *   must clean — its only supervisor is dead, its startup can never be
 *   health-confirmed, and no client could have discovered it before the
 *   walk's snapshot read identity.json — so killing it is runner cleanup,
 *   not broker collateral, and the exposure window is the post-rescan walk
 *   alone instead of the entire pre-reacquisition gap the rescan closed.
 *   Stranding the duty instead (the previous rule) blocked every
 *   already-retired or never-created broker identity from EVER settling.
 * - `failed` (unreadable, corrupt, partial, contended, or an over-budget or
 *   skipped lookup) — STILL fails closed: the sweep reports `incomplete` and
 *   the duty stays PENDING for the next bounded pass. An unprovable
 *   exclusion set must never silently become an empty one: `absent` proves
 *   the complete scan found NOTHING; `failed` proves nothing at all.
 * No durable data scope (no dataRoot) is equally unproven — the exclusion
 * lookup and every lock live under it — so absence of proof never plans a
 * walk on either platform.
 * @param {any} input the duty input (see terminateMarkedRunnerTree); an
 *   injectable `sweepDeadRootDescendants` seam overrides the production sweep
 *   for tests, mirroring the `terminateProcessTree` convention, an injectable
 *   `scanBrokerIdentities` seam overrides the absent path's under-lock rescan
 *   the same way, and an optional `platform` pins the platform split the same
 *   way
 * @param {any} job the revalidated durable record carrying the marked claim
 * @param {number} dutyDeadlineMs the duty's ONE shared absolute bound
 * @returns {Promise<{kind:'root-alive'}|{kind:'clean'}|{kind:'swept',killed:number[],pending:number[]}|{kind:'incomplete',pending:number[]}>}
 */
async function sweepDeadRootForDuty(input, job, dutyDeadlineMs) {
  const sweep = typeof input.sweepDeadRootDescendants === 'function' ? input.sweepDeadRootDescendants : sweepDeadRootDescendantTree;
  if (typeof input.dataRoot !== 'string' || input.dataRoot.length === 0) return { kind: 'incomplete', pending: [] };
  const remainingMs = Math.max(0, dutyDeadlineMs - Date.now());
  if (remainingMs <= 0) return { kind: 'incomplete', pending: [] };
  // POSIX: the group-addressed sweep needs no exclusions (ADR 0021) — never
  // consult the lookup, never gate the walk on its outcome.
  if ((typeof input.platform === 'string' && input.platform.length > 0 ? input.platform : process.platform) !== 'win32') {
    return await sweep(job.childPid, { timeoutMs: Math.max(0, dutyDeadlineMs - Date.now()) });
  }
  const lookupBudgetMs = Math.min(BROKER_LOOKUP_MAX_BUDGET_MS, remainingMs - minRunnerTerminationBudgetMs(
    typeof input.platform === 'string' && input.platform.length > 0 ? input.platform : process.platform));
  /** @type {{status:'resolved'|'absent'|'failed',pids:number[],brokers:{pid:number,command:string,args:string[]}[],release?:(releaseBudgetMs?:number)=>Promise<void>}|null} */
  let exclusions = null;
  if (lookupBudgetMs >= 1) {
    try { exclusions = await recordedWorkspaceBrokerPids({ dataRoot: input.dataRoot, workspace: input.workspace, timeoutMs: lookupBudgetMs, holdResolvedLock: true }); }
    catch { exclusions = null; }
  }
  // Fail closed on every unproven exclusion state (see the docblock): only a
  // lookup that PROVED its outcome — `resolved` (any broker count, lock held
  // by the lookup) or `absent` (proven-empty, lock taken below) — plans a
  // walk; `failed`, a thrown lookup, or a skipped/over-budget lookup never
  // does.
  if (!exclusions || exclusions.status === 'failed') return { kind: 'incomplete', pending: [] };
  if (exclusions.status === 'absent') {
    // Hold the SAME startup lock path across the whole sweep (creating the
    // lock layout via withFileLock when no broker exists yet): that
    // serialization is what makes the empty exclusion set PROVEN rather than
    // assumed (see the docblock). The lookup's `absent` observation is STALE
    // here — it released this lock at its return — so the exclusion set is
    // RE-PROVEN inside the reacquired hold: the identity scan re-runs
    // (scanBrokerIdentityDirectory, the lookup's own scan internals — the
    // helper takes no lock itself, so it cannot self-deadlock against this
    // hold), and only a rescan that still finds NOTHING walks with the empty
    // exclusion set. A rescan that now finds identities — an orphan daemon
    // the dead runner spawned publishing in the release→reacquisition gap,
    // discoverable and ADOPTABLE by another client before this lock was
    // reacquired — resolves through the resolved-path rules (exclude the
    // proven launch-signature brokers); an unprovable rescan fails the walk
    // closed. The rescan shares the duty's remaining deadline (minus the
    // minimal termination slice the walk keeps for itself), so a stalled or
    // wedged scan can never ride past the caller's lifecycle bound. A
    // contended lock acquisition — a live startup holds it — equally fails
    // closed to `incomplete`; the next bounded pass retries.
    const sweepBudgetMs = Math.max(0, dutyDeadlineMs - Date.now());
    const scanIdentities = typeof input.scanBrokerIdentities === 'function' ? input.scanBrokerIdentities : scanBrokerIdentityDirectory;
    try {
      const storage = await resolveWorkspaceStorage({ dataRoot: input.dataRoot, workspace: input.workspace });
      return await withFileLock(join(storage.directory, 'broker', '.lock'), async () => {
        const rescan = await scanIdentities(join(storage.directory, 'broker'), {
          timeoutMs: Math.max(0, Math.min(BROKER_LOOKUP_MAX_BUDGET_MS, dutyDeadlineMs - Date.now() - minRunnerTerminationBudgetMs(
            typeof input.platform === 'string' && input.platform.length > 0 ? input.platform : process.platform))),
        });
        if (rescan.status === 'failed') return { kind: 'incomplete', pending: [] };
        return await sweep(job.childPid, { timeoutMs: Math.max(0, dutyDeadlineMs - Date.now()), excludeBrokers: rescan.brokers });
      }, {
        timeoutMs: Math.min(BROKER_LOOKUP_MAX_BUDGET_MS, Math.max(1, sweepBudgetMs)),
        signal: AbortSignal.timeout(Math.max(1, sweepBudgetMs)),
      });
    } catch { return { kind: 'incomplete', pending: [] }; }
  }
  try {
    return await sweep(job.childPid, {
      timeoutMs: Math.max(0, dutyDeadlineMs - Date.now()),
      excludeBrokers: exclusions.brokers,
    });
  } finally {
    // Release the held broker startup lock — always AFTER the sweep returned
    // or was abandoned, so an in-flight startup stays serialized until the
    // sweep's kill plan is spent (a startup blocked on this lock spawns only
    // after release, outside the sweep's reach).
    if (typeof exclusions.release === 'function') {
      await exclusions.release(Math.max(0, dutyDeadlineMs - Date.now())).catch(() => {});
    }
  }
}

/** @param {unknown} value */
function isPlainRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }

/** @param {{store:any,dataRoot?:string,reconcile?:(request:{intent:{kind:'observe'}|{kind:'wait'}|{kind:'stop',cause:string},authority:{ownerSessionId:string},workspace:string,selector:{jobId:string},signal?:AbortSignal})=>Promise<any>,stopSession?:(sessionId:string)=>Promise<unknown>,readSession?:(sessionId:string)=>Promise<any>,publishSucceededSnapshot?:(input:{workspace:string,job:any,snapshot:any,turnBoundary:any})=>Promise<any>,terminateProcessTree?:(pid:number,options:{timeoutMs?:number})=>Promise<unknown>,sweepDeadRootDescendants?:(pid:number,options:{timeoutMs?:number,excludeBrokers?:readonly {pid:number,command:string,args:string[]}[]})=>Promise<{kind:'root-alive'}|{kind:'clean'}|{kind:'swept',killed:number[],pending:number[]}|{kind:'incomplete',pending:number[]}>,cancellationObservationMs?:number,cancellationObservationIntervalMs?:number,pollIntervalMs?:number,clock?:()=>number,delay?:(ms:number)=>Promise<void>,setTimeout?:(callback:()=>void,ms:number)=>any,clearTimeout?:(timer:any)=>void,beforeWaitPoll?:()=>Promise<unknown>,afterRollbackBeforeSettle?:()=>Promise<void>,afterFollowerSelected?:()=>Promise<void>,afterObservationBeforeLock?:()=>Promise<void>}} options */
export function createJobController(options) {
  if (!options?.store) throw new PluginError('JOB_CONTROLLER_INPUT_INVALID', 'A state store is required.', { category: 'validation', remedy: 'Provide the Task 2 state store.' });
  if (options.reconcile !== undefined && typeof options.reconcile !== 'function') throw new PluginError('JOB_CONTROLLER_INPUT_INVALID', 'The lifecycle reconciliation seam must be a function.', { category: 'validation', remedy: 'Provide the Rescue Lifecycle Reconciler bound to one exact workspace owner.' });
  const reconcile = options.reconcile ?? (async () => null);
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const clock = options.clock ?? Date.now;
  const scheduleTimeout = options.setTimeout ?? globalThis.setTimeout;
  const cancelTimeout = options.clearTimeout ?? globalThis.clearTimeout;
  /** Join the exact lifecycle selection before every management mutation or projection; the default seam is a no-op so legacy callers keep bare store semantics. @param {{kind:'observe'|'wait'}|{kind:'stop',cause:string}} intent @param {string} workspace @param {string} ownerSessionId @param {string} jobId @param {AbortSignal} [signal] */
  const reconcileLifecycle = (intent, workspace, ownerSessionId, jobId, signal) => reconcile({ intent, authority: { ownerSessionId }, workspace, selector: { jobId }, ...(signal ? { signal } : {}) });
  /** @type {Map<string,Promise<any>>} */
  const inFlight = new Map();
  return {
    /** @param {string} workspace @param {string} ownerSessionId */
    async listOwned(workspace, ownerSessionId) {
      return options.store.listOwnedJobs(workspace, ownerSessionId);
    },
    /** @param {string} workspace @param {string} ownerSessionId @param {string} [jobId] @param {'status'|'result'|'cancel'} [eligibility] @param {{signal?:AbortSignal}} [selection] */
    async selectOwned(workspace, ownerSessionId, jobId, eligibility = 'status', selection = {}) {
      // Status and Result reconcile the exact owned selection before projection.
      // An explicit job ID reconciles before selection; an implicit selection
      // reconciles the exact latest owned job it selected and rereads it, so a
      // view never projects a stale pre-reconciliation record (ADR 0019). The
      // remaining implicit divergence is eligibility only: implicit Result
      // stays terminal-only while implicit Status accepts any status.
      if (typeof jobId === 'string' && (eligibility === 'status' || eligibility === 'result')) {
        // The bounded caller signal keeps a stalled remote observation from
        // outliving the command (SIGINT or the management budget).
        await reconcileLifecycle({ kind: 'observe' }, workspace, ownerSessionId, jobId, selection.signal);
      }
      const jobs = (await options.store.listOwnedJobs(workspace, ownerSessionId))
        .filter((/** @type {any} */ job) => jobId ? job.id === jobId : eligibleImplicit(job, eligibility));
      const selected = jobs.at(-1);
      if (!selected) throw new PluginError('OWNED_JOB_NOT_FOUND', 'No matching owned job was found.', { category: 'authorization', remedy: 'Check the job ID and invoke the command from its owning Codex session.' });
      if (jobId === undefined && (eligibility === 'status' || eligibility === 'result')) {
        await reconcileLifecycle({ kind: 'observe' }, workspace, ownerSessionId, selected.id, selection.signal);
        return options.store.readJob(workspace, selected.id);
      }
      return selected;
    },
    /**
     * Wait for one job's durable terminal winner. The legacy form polls the bare
     * store; the managed owner form additionally repeats the Rescue Lifecycle
     * Reconciler every poll, so a persisted unresolved stop is retried until it
     * settles or the bounded wait timeout expires — a timeout stays observational
     * and never authorizes a stop or a guard release.
     * @param {string} workspace @param {string} jobId @param {string|number} ownerOrTimeoutMs @param {AbortSignal|{reconciler?:{reconcile:(request:any)=>Promise<any>},timeoutMs:number,signal?:AbortSignal}} [signalOrOptions]
     */
    async wait(workspace, jobId, ownerOrTimeoutMs, signalOrOptions) {
      const managed = typeof ownerOrTimeoutMs === 'string';
      const managedOptions = managed ? /** @type {any} */ (signalOrOptions) : undefined;
      const ownerSessionId = managed ? ownerOrTimeoutMs : undefined;
      const timeoutMs = managed ? managedOptions?.timeoutMs : ownerOrTimeoutMs;
      const signal = managed ? managedOptions?.signal : signalOrOptions;
      const pollReconcile = managed ? managedOptions?.reconciler?.reconcile ?? reconcile : undefined;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new PluginError('JOB_WAIT_INPUT_INVALID', 'The wait timeout must be a bounded non-negative duration.', { category: 'validation', remedy: `Retry $zcode:status ${jobId} --wait with a bounded timeout.`, details: { jobId, timeoutMs } });
      const started = clock();
      while (true) {
        signal?.throwIfAborted();
        await abortable(() => options.beforeWaitPoll?.(), signal);
        // The durable winner is read before expiration so a zero-length wait
        // still returns an already-terminal job instead of timing out.
        const job = await abortable(() => options.store.readJob(workspace, jobId), signal);
        if (TERMINAL.has(job.status)) return job;
        if (clock() - started >= timeoutMs) throw waitTimeout(jobId, job.status, timeoutMs);
        if (pollReconcile !== undefined) {
          // One hung reconciliation poll is bounded by both the wait deadline
          // and the caller's abort signal, and never starts once no budget
          // remains — a stuck adapter call can neither outlive the advertised
          // timeout nor block an interrupting SIGINT.
          const remaining = timeoutMs - (clock() - started);
          // The deadline aborts the poll's own signal so an expired wait also
          // cuts off any control client the slow reconciliation still holds.
          const deadlineAbort = new AbortController();
          const pollSignal = signal === undefined ? deadlineAbort.signal : AbortSignal.any([signal, deadlineAbort.signal]);
          const poll = pollReconcile({ intent: { kind: 'wait' }, authority: { ownerSessionId: /** @type {string} */ (ownerSessionId) }, workspace, selector: { jobId }, signal: pollSignal });
          poll.catch(() => {});
          await new Promise((resolvePoll, rejectPoll) => {
            const timer = scheduleTimeout(() => { const timeout = waitTimeout(jobId, job.status, timeoutMs); deadlineAbort.abort(timeout); rejectPoll(timeout); }, remaining);
            const onAbort = () => { cancelTimeout(timer); rejectPoll(signal?.reason ?? waitTimeout(jobId, job.status, timeoutMs)); };
            if (signal) {
              if (signal.aborted) { deadlineAbort.abort(signal.reason); onAbort(); return; }
              signal.addEventListener('abort', onAbort, { once: true });
            }
            poll.then((/** @type {any} */ value) => { cancelTimeout(timer); signal?.removeEventListener('abort', onAbort); resolvePoll(value); }, (/** @type {any} */ error) => { cancelTimeout(timer); signal?.removeEventListener('abort', onAbort); rejectPoll(error); });
          });
        }
        const waitMs = Math.min(pollIntervalMs, Math.max(0, timeoutMs - (clock() - started)));
        const customDelay = options.delay;
        if (customDelay) await abortable(() => customDelay(waitMs), signal);
        else await pollDelay(waitMs, signal, scheduleTimeout, cancelTimeout);
      }
    },
    /** @param {string} workspace @param {string} jobId @param {string} ownerSessionId @param {string} [stopCause] The bounded durable stop cause; explicit user cancellation is the default and lifecycle callers supply their own. */
    cancel(workspace, jobId, ownerSessionId, stopCause = 'user') {
      if (!STOP_CAUSES.has(stopCause)) {
        throw new PluginError('JOB_CANCEL_INPUT_INVALID', 'The cancellation stop cause is invalid.', {
          category: 'validation', remedy: `Pass one of the bounded stop causes: ${[...STOP_CAUSES].sort().join(', ')}.`,
          details: { stopCause },
        });
      }
      return reconcileThenElectCancel({ options, reconcileLifecycle, workspace, jobId, ownerSessionId, stopCause, inFlight });
    },
    /**
     * Select the latest owned Rescue job an explicit --resume may target. A
     * cancelled candidate qualifies only through the full durable predicate —
     * the Host-owned trio, an accepted session, its confirmed stop cause, the
     * viewing turn's permission mode equaling the binding snapshot, and the
     * active binding still anchoring that exact job — so historical
     * closed/cancel records, superseded winners, and permission changes stay
     * excluded (a permission change requires fresh).
     * @param {string} workspace @param {string} ownerSessionId @param {string} [permissionMode] The viewing turn's permission mode; a cancelled candidate is eligible only under its exact binding snapshot.
     */
    async resumeCandidate(workspace, ownerSessionId, permissionMode) {
      const owned = (await options.store.listOwnedJobs(workspace, ownerSessionId))
        .filter((/** @type {any} */ job) => job.command === 'rescue' && typeof job.zcodeSessionId === 'string');
      // The newest owned Rescue record is a barrier while its stop is
      // unresolved: selection must never fall back to an older session behind
      // an in-flight cancellation.
      if (owned.at(-1)?.status === 'cancelling') return null;
      const candidates = owned.filter((/** @type {any} */ job) => ['running', 'succeeded', 'failed', 'cancelled'].includes(job.status));
      /** @type {{job:any, operationId:string}|null} */
      let selected = null;
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const job = candidates[index];
        // Full eligibility applies to EVERY candidate: the viewing turn's
        // permission mode must equal the candidate's binding snapshot. The
        // newest candidate failing it terminates selection — resuming an
        // older, superseded session is never a fallback; below an eligible
        // selection, ineligible jobs are simply that operation's superseded
        // history.
        if (permissionMode === undefined || job.permissionSnapshot?.permissionMode !== permissionMode) {
          if (selected !== null) continue;
          return null;
        }
        // Unbound (legacy) candidates keep their recency semantics: a
        // historical unbound cancelled record stays ineligible before
        // selection, and other children's bindings never supersede an unbound
        // job (ADR 0018 preserves legacy resume semantics).
        if (job.rescueReservationKind !== 'bound') {
          if (job.status === 'cancelled') return null;
          // An eligible bound candidate newer than this unbound job already
          // owns the selection (recency within one lineage); older unbound
          // history never supersedes it and never disambiguates it.
          if (selected !== null) break;
          return job;
        }
        // A bound candidate requires PROOF that the active binding still
        // anchors it — an absent anchor (active elsewhere, ambiguous, closed
        // history, or removed by binding GC) is unproven and fails closed.
        if (typeof options.store.rescueBindingPointsAtJob !== 'function') return null;
        const anchored = await options.store.rescueBindingPointsAtJob({ workspace, ownerSessionId: job.ownerSessionId, jobId: job.id }).catch(() => false);
        if (!anchored) {
          // The newest candidate losing its anchor fails closed; below an
          // eligible selection an unanchored job is just that operation's
          // superseded history.
          if (selected !== null) continue;
          return null;
        }
        if (job.status !== 'cancelled') {
          // Every eligible bound candidate anchors its own retained operation:
          // a second candidate under a DIFFERENT operation makes the selection
          // ambiguous — the Host must ask once for the logical operation
          // instead of guessing by recency (ADR 0018 line 25).
          const prior = await options.store.rescueBindingForJob?.({ workspace, ownerSessionId: job.ownerSessionId, jobId: job.id }).catch(() => null);
          if (prior === null || prior === undefined) return null;
          if (selected !== null && selected.operationId !== prior.operationId) {
            throw new PluginError('RESUME_AMBIGUOUS', 'More than one retained Rescue operation is eligible for resume.', {
              category: 'authorization',
              remedy: 'Resume from the active parent turn (the Host asks once for the logical operation), or start a fresh operation.',
            });
          }
          selected = { job, operationId: prior.operationId };
          continue;
        }
        // Cancelled candidates qualify only through the full durable
        // predicate — the Host-owned trio with an accepted session, its
        // confirmed stop cause, and the active binding still anchoring that
        // exact job.
        if (!(await resumableCancelledCandidate(options.store, workspace, job, permissionMode))) return null;
        const prior = await options.store.rescueBindingForJob?.({ workspace, ownerSessionId: job.ownerSessionId, jobId: job.id }).catch(() => null);
        if (prior === null || prior === undefined) {
          if (selected !== null) continue;
          return null;
        }
        if (selected !== null && selected.operationId !== prior.operationId) {
          throw new PluginError('RESUME_AMBIGUOUS', 'More than one retained Rescue operation is eligible for resume.', {
            category: 'authorization',
            remedy: 'Resume from the active parent turn (the Host asks once for the logical operation), or start a fresh operation.',
          });
        }
        selected = { job, operationId: prior.operationId };
      }
      return selected?.job ?? null;
    },
  };
}

/**
 * The full durable predicate one cancelled candidate must pass before an
 * explicit resume may target it: the indivisible Host-owned trio with an
 * accepted session (state.mjs's resumableHostOwnedCancellation predicate), its
 * confirmed durable stop cause, the viewing turn's permission mode equaling
 * the binding snapshot, and the active binding partition still anchoring this
 * exact job. Anything unproven excludes the candidate.
 * @param {any} store @param {string} workspace @param {any} job @param {string} [permissionMode]
 */
async function resumableCancelledCandidate(store, workspace, job, permissionMode) {
  if (!validHostLifecycleRecord(job) || typeof job.zcodeSessionId !== 'string' || !STOP_CAUSES.has(job.stopCause)) return false;
  if (permissionMode === undefined || job.permissionSnapshot?.permissionMode !== permissionMode) return false;
  if (typeof store.rescueBindingPointsAtJob !== 'function') return false;
  try { return await store.rescueBindingPointsAtJob({ workspace, ownerSessionId: job.ownerSessionId, jobId: job.id }); }
  catch { return false; }
}

/** @param {string} jobId @param {string} status @param {number} timeoutMs */
function waitTimeout(jobId, status, timeoutMs) {
  return new PluginError('JOB_WAIT_TIMEOUT', `Timed out waiting for job ${jobId}.`, { category: 'timeout', remedy: `Retry $zcode:status ${jobId} --wait.`, details: { jobId, status, timeoutMs } });
}

/**
 * Route one cancellation through the Rescue Lifecycle Reconciler before the
 * existing cancellation election: the reconciler owns the durable stop intent
 * (persist-before-control) and may already hold a terminal winner; every other
 * bounded outcome defers remote control and settlement to the election.
 * @param {{options:any,reconcileLifecycle:(intent:any,workspace:string,ownerSessionId:string,jobId:string,signal?:AbortSignal)=>Promise<any>,workspace:string,jobId:string,ownerSessionId:string,stopCause:string,inFlight:Map<string,Promise<any>>}} input
 */
async function reconcileThenElectCancel(input) {
  const { options, reconcileLifecycle, workspace, jobId, ownerSessionId, stopCause, inFlight } = input;
  const dataRoot = options.dataRoot ?? options.store.dataRoot;
  if (!dataRoot) throw cancelError(jobId, 'Cancellation lock storage is unavailable.');
  // Reconciliation is serialized inside the deduplicated, cross-process locked
  // cancellation attempt (performCancellation invokes it under the lock): two
  // concurrent cancels cannot both persist intents and issue remote stops
  // around the election.
  const elect = (/** @type {any} */ storage, /** @type {string} */ canonicalWorkspace) => cancelWithElection({ options, storage, workspace: canonicalWorkspace, jobId, ownerSessionId, stopCause, reconcileLifecycle, reconcileWorkspace: workspace });
  let canonicalWorkspace;
  try { canonicalWorkspace = realpathSync(resolve(workspace)); }
  catch { const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); return elect(storage, storage.workspacePath); }
  const key = `${canonicalWorkspace}:${jobId}`; const existing = inFlight.get(key); if (existing) return existing;
  const attempt = resolveWorkspaceStorage({ dataRoot, workspace: canonicalWorkspace }).then((storage) => elect(storage, canonicalWorkspace));
  inFlight.set(key, attempt); const cleanup = () => { if (inFlight.get(key) === attempt) inFlight.delete(key); }; attempt.then(cleanup, cleanup); return attempt;
}

/**
 * Derive the public Resumability Indicator for one terminal management view
 * from the exact durable record: the exact Host-owned binding preserved by the
 * Task 2 cancellation semantics, an accepted ZCode session, terminal
 * settlement, the viewing turn's permission mode equaling the binding
 * snapshot, the exact binding still anchoring this job, and — for a cancelled
 * winner — its confirmed durable Stop Cause. `null` marks a view the indicator
 * does not apply to; the value is never persisted and never exposes the
 * internal ZCode session ID.
 * @param {any} job
 * @param {string} [viewingPermissionMode] The current caller turn's permission mode; only an explicitly supplied mode equaling the binding snapshot proves the permission dimension, because a permission change requires fresh and an absent mode is unproven.
 * @param {boolean} [bindingCurrent] Binding-currency evidence — the caller's active binding partition lookup proving the exact binding still anchors this job; only an explicitly supplied `true` proves it, because an advanced or unreadable binding is unproven.
 * @returns {boolean|null}
 */
export function resumableJobIndicator(job, viewingPermissionMode, bindingCurrent) {
  if (!job || job.command !== 'rescue' || job.readOnly !== false) return null;
  if (!TERMINAL.has(job.status)) return null;
  const acceptedSession = typeof job.zcodeSessionId === 'string';
  const permissionMatch = viewingPermissionMode !== undefined && job.permissionSnapshot?.permissionMode === viewingPermissionMode;
  if (job.status === 'cancelled') {
    // Historical cancels closed their binding; only the indivisible Host-owned
    // trio with an accepted session preserves the exact binding for a later
    // authorized turn, and only with its confirmed stop cause AND the exact
    // binding still anchoring this job — once a continuation advances the
    // binding, this cancelled job is history. The authorized resume path
    // revalidates the real binding before starting any new turn.
    return validHostLifecycleRecord(job) && acceptedSession && permissionMatch && STOP_CAUSES.has(job.stopCause) && bindingCurrent === true;
  }
  // A succeeded or failed accepted turn keeps its preserved session resumable
  // only while its exact binding is still current — proven by the caller's
  // partition lookup showing the active binding still anchors this exact job;
  // once a continuation advances the binding, this job is history. The
  // authorized resume path revalidates the binding again.
  return acceptedSession && permissionMatch && bindingCurrent === true;
}

/** @param {{options:any,storage:any,workspace:string,jobId:string,ownerSessionId:string,stopCause?:string,reconcileLifecycle?:(intent:any,workspace:string,ownerSessionId:string,jobId:string)=>Promise<any>,reconcileWorkspace?:string}} input */
async function cancelWithElection(input) {
  if (!/^[a-f0-9]{64}$/.test(input.jobId)) throw new PluginError('JOB_ID_INVALID', 'Job identifier has an invalid format.', { category: 'validation', remedy: 'Use a job ID returned by the state store.', details: { jobId: input.jobId } });
  const attempts = createCancelAttemptStore(input.storage); let operationStarted = false;
  let observed = null; let observedError = null;
  try { observed = await attempts.read(input.jobId, input.ownerSessionId); } catch (attemptError) { observedError = attemptError; }
  await input.options.afterObservationBeforeLock?.();
  try {
    const outcome = await withJobCancellationLock({ ...input, dataRoot: input.options.dataRoot ?? input.options.store.dataRoot, timeoutMs: 0 }, () => { operationStarted = true; return performCancellation(input, attempts, { observed, observedError }); });
    return await settleCancellationOutcome(input, attempts, outcome);
  }
  catch (error) {
    if (operationStarted || !(error instanceof PluginError) || error.code !== 'LOCK_TIMEOUT') throw error;
    await input.options.afterFollowerSelected?.();
    const outcome = await withJobCancellationLock({ ...input, dataRoot: input.options.dataRoot ?? input.options.store.dataRoot, timeoutMs: 30_000 }, () => performCancellation(input, attempts, { observed, observedError }));
    return settleCancellationOutcome(input, attempts, outcome);
  }
}

/** Resolve the exact claimed queued worker lease from either durable location — the raw execution
 * claim or the private execution fence published by fenceJobWorkerExecution — mirroring the
 * effective-lease expression state.mjs's recovery CAS compares. A non-digest reservation lease is
 * returned as-is so settlement fails closed instead of classifying corrupt authority as unclaimed.
 * @param {any} job */
function effectiveQueuedWorkerLeaseId(job) { return job.workerLeaseId ?? job.rescueExecutionReservation?.workerLeaseId ?? null; }

/** @param {{options:any,workspace:string,jobId:string,ownerSessionId:string,stopCause?:string,reconcileLifecycle?:(intent:any,workspace:string,ownerSessionId:string,jobId:string)=>Promise<any>,reconcileWorkspace?:string}} input @param {ReturnType<typeof createCancelAttemptStore>} attempts @param {{observed:any,observedError:unknown}} election */
async function performCancellation(input, attempts, election) {
  const stopCause = input.stopCause ?? 'user';
  let job = await input.options.store.readJob(input.workspace, input.jobId);
  if (job.ownerSessionId !== input.ownerSessionId) throw new PluginError('OWNED_JOB_NOT_FOUND', 'No matching owned job was found.', { category: 'authorization', remedy: 'Check the job ID and invoke the command from its owning Codex session.' });
  if (TERMINAL.has(job.status)) return job;
  // Fail closed on a corrupt or mismatched cancellation journal BEFORE any
  // mutating reconciliation: a corrupt journal must never be bypassed by a
  // stop-intent persistence or a remote stop.
  if (election.observedError) throw election.observedError;
  if (typeof input.reconcileLifecycle === 'function') {
    // Serialized under the cancellation lock: the Reconciler persists the
    // durable stop intent (persist-before-control) and may already hold a
    // terminal winner; a settled winner is authoritative and skips the
    // election's own transitions. The record is re-read afterwards because
    // reconciliation may have persisted the intent this election must replay.
    const outcome = await input.reconcileLifecycle({ kind: 'stop', cause: stopCause }, input.reconcileWorkspace ?? input.workspace, input.ownerSessionId, input.jobId);
    if (outcome?.kind === 'settled-terminal') {
      const settled = await input.options.store.readJob(input.workspace, input.jobId).catch(() => null);
      if (settled && TERMINAL.has(settled.status)) return settled;
    }
    if (outcome !== null && outcome !== undefined) {
      job = await input.options.store.readJob(input.workspace, input.jobId);
      if (TERMINAL.has(job.status)) return job;
    }
  }
  const current = await attempts.read(job.id, input.ownerSessionId); let attempt;
  if (current?.status === 'failed-pending-release') return failedOutcome(current);
  if (current?.status === 'failed' && completedDuringAcquisition(election.observed, current)) return failedOutcome(current);
  if (current?.status === 'active' || current?.status === 'finalize-pending') attempt = current;
  else attempt = await attempts.start(job.id, input.ownerSessionId);
  if (job.status === 'queued') {
    // Persist the durable stop decision BEFORE any settlement work: a claimed
    // queued stop must survive controller death, a timed-out queued cancel can
    // never be forgotten, and every later claim, dispatch, and failure-rollback
    // transition must respect it. Legacy records carry no intent schema.
    const intentPatch = hostOwnedStopIntentPatch(job, stopCause);
    if ('stopIntent' in intentPatch && !validStopIntent(job.stopIntent)) {
      try { job = await input.options.store.transitionJob(input.workspace, job.id, ['queued'], 'queued', intentPatch); }
      catch (error) {
        // A delegated different-cause intent that landed between this election's
        // pre-lock read and the state lock owns the stop decision: a minted
        // intent is never a replacement, so adopt the authoritative record
        // (bounded convergence) instead of escaping with the raw patch
        // rejection. Any other conflict still defers to the durable winner.
        if (error instanceof PluginError && error.code === 'JOB_PATCH_INVALID') {
          job = await input.options.store.readJob(input.workspace, job.id);
          if (TERMINAL.has(job.status)) return job;
        } else {
          job = await durableCancelledWinner(cancelledWinnerInput(input), error);
        }
      }
    }
    // Claimed is decided by the EFFECTIVE lease — the exact expression state.mjs's
    // recovery CAS compares — never the raw job.workerLeaseId alone: during the
    // fence gap after fenceJobWorkerExecution stores
    // rescueExecutionReservation.workerLeaseId and before claimJobWorkerForExecution
    // copies it, a queued runner is CLAIMED (its executor is alive holding that
    // exact lease), so the settlement must probe the reservation lease instead of
    // falling through to the unclaimed direct finalization.
    if (effectiveQueuedWorkerLeaseId(job) !== null) {
      // A legacy claimed worker may still be alive without holding any lease
      // file, so only a modern execution claim or private execution fence
      // (whose runner holds its exact process-lifetime lease) admits a
      // lease-probed settlement.
      if (job.workerLeaseId !== undefined && job.rescueExecutionClaim === undefined) {
        throw cancelError(job.id, 'The claimed worker is still starting; retry after it advances or recovery proves it orphaned.');
      }
      const settled = await settleClaimedQueuedCancellation(input, job, stopCause);
      if (settled.status !== 'queued') return recordCancelledAttempt(input, attempts, attempt, settled);
      throw cancelError(job.id, 'The claimed worker is still starting; retry after it advances or recovery proves it orphaned.');
    }
    const rollback = await readQueuedRescueMigrationRollback({ dataRoot: input.options.dataRoot ?? input.options.store.dataRoot,
      workspace: input.workspace, job, store: input.options.store,
      invalid: () => cancelError(job.id, 'Queued migration specification is invalid.') });
    let cancelled;
    try { cancelled = rollback
      ? await input.options.store.finishSessionEndedRescueContinuation(input.workspace, job.id, rollback, 'cancelled', { exitCode: null, ...hostOwnedCancelledPatch(job, stopCause) })
      : await finishJob(input.options.store, input.workspace, job.id, ['queued'], 'cancelled', { exitCode: null, ...hostOwnedCancelledPatch(job, stopCause) }); }
    catch (error) { cancelled = await durableCancelledWinner(cancelledWinnerInput(input), error); }
    return recordCancelledAttempt(input, attempts, attempt, cancelled);
  }
  if (!['running', 'cancelling'].includes(job.status)) throw cancelError(job.id, 'Job is not cancellable.');
  if (job.status === 'cancelling' && attempt.status === 'finalize-pending' && persistedTurnBoundary(job)) {
    let cancelled;
    try {
      cancelled = await finishJob(input.options.store, input.workspace, job.id, ['cancelling'], 'cancelled', { exitCode: null, ...hostOwnedCancelledPatch(job, stopCause) });
    } catch (error) {
      try { cancelled = await durableCancelledWinner(cancelledWinnerInput(input), error); }
      catch (finalizeFailure) { throw finalizeError(job.id, finalizeFailure); }
    }
    return recordCancelledAttempt(input, attempts, attempt, cancelled);
  }
  const cancelling = job.status === 'running' ? await input.options.store.transitionJob(input.workspace, job.id, ['running'], 'cancelling', { ...(job.lastCancelError ? { lastCancelError: null } : {}), ...hostOwnedStopIntentPatch(job, stopCause) }) : job;
  const observedStop = await revalidateBoundRescueStop(input.options.store, input.workspace, cancelling);
  if (observedStop?.kind === 'stale') return observedStop.job;
  // Pre-stop read (retry passes only): when this election did NOT just
  // transition the job — it was already cancelling with a persisted stop
  // intent from an earlier reconciliation pass — a turn that already reached
  // a terminal outcome BEFORE this stop keeps its own semantics instead of
  // being misclassified as caused by the stop. An unreadable or expired read
  // never blocks the exact stop.
  const retainedRetryStop = job.status === 'cancelling' && validStopIntent(cancelling.stopIntent);
  if (retainedRetryStop && cancelling.zcodeSessionId && input.options.readSession) {
    try {
      // Bounded: a stalled or gate-held read must never block the exact stop,
      // and the timer is cleared as soon as the read settles so a fast read
      // never keeps the process alive for the full second.
      const preStopSchedule = input.options.setTimeout ?? globalThis.setTimeout;
      const preStopCancel = input.options.clearTimeout ?? globalThis.clearTimeout;
      const preStopSnapshot = await new Promise((resolvePre) => {
        const preStopTimeout = preStopSchedule(() => resolvePre(undefined), 1_000);
        Promise.resolve().then(() => input.options.readSession(cancelling.zcodeSessionId)).then(resolvePre, () => resolvePre(undefined)).finally(() => preStopCancel(preStopTimeout));
      });
      const preStopBoundary = persistedTurnBoundary(cancelling);
      const preStopClassification = preStopBoundary ? classifyCurrentTurnSnapshot(preStopSnapshot, preStopBoundary) : null;
      // Only a PRE-EXISTING engine failure diverts: natural success keeps the
      // existing stop-then-observe path (a stop on a completed turn is a no-op
      // and the observation publishes the authoritative result).
      if (preStopClassification?.kind === 'failed') {
        return recordCancelledAttempt(input, attempts, attempt, await input.options.store.finishJob(input.workspace, job.id, ['cancelling'], 'failed', {
          error: { message: 'ZCode reported a terminal error before the stop could be attempted.' }, exitCode: 1 }));
      }
    } catch { /* an unreadable pre-stop read never blocks the exact stop */ }
  }
  try {
    if (!cancelling.zcodeSessionId || !input.options.stopSession) throw new Error('No live ZCode session stop handler is available.');
    const revalidated = await revalidateBoundRescueStop(input.options.store, input.workspace, cancelling, observedStop?.guard);
    if (revalidated?.kind === 'stale') return revalidated.job;
    await input.options.stopSession(cancelling.zcodeSessionId);
  } catch (error) {
    // A failed remote stop never skips the marked-runner local termination duty;
    // the retained cancelling guard below keeps the remote uncertainty durable
    // for the next bounded pass (local death never upgrades remote state).
    await terminateCancellationRunner(input, cancelling);
    const message = boundedCancelMessage(error instanceof Error ? error.message : 'ZCode stop failed');
    // An unresolved Host-owned stop keeps its cancelling status and persisted
    // stop intent — the same retainUnresolvedEndedStop discipline as the
    // SessionEnd settlement — so the reconciler and owner recovery retry the
    // durable intent instead of observing a running record forever. Only
    // legacy records without a persisted intent roll back to running to record
    // lastCancelError as their bounded retry evidence.
    const retainedCancelling = validStopIntent(cancelling.stopIntent);
    if (retainedCancelling) {
      // The retained cancelling record keeps its persisted stop intent AND
      // gains the bounded public retry diagnostic — Status surfaces why the
      // stop is unresolved without rolling the intent back to running. A
      // concurrent terminalization wins: the raced durable winner is
      // authoritative over this stale cancelling snapshot.
      const diagnostic = await input.options.store.transitionJob(input.workspace, job.id, ['cancelling'], 'cancelling', { lastCancelError: message })
        .catch(async (/** @type {any} */ transitionError) => {
          if (transitionError instanceof PluginError && ['JOB_TERMINAL', 'JOB_STATUS_CONFLICT', 'JOB_INVALID_TRANSITION'].includes(transitionError.code)) {
            return await input.options.store.readJob(input.workspace, job.id);
          }
          throw transitionError;
        })
        .catch(() => undefined);
      if (diagnostic !== undefined && TERMINAL.has(diagnostic.status)) return diagnostic;
    } else {
      await input.options.store.transitionJob(input.workspace, job.id, ['cancelling'], 'running', { lastCancelError: message });
    }
    await attempts.update(job.id, input.ownerSessionId, attempt.attemptId, 'failed-pending-release', message);
    await input.options.afterRollbackBeforeSettle?.();
    return retainedCancelling
      ? { failedAttempt: attempt.attemptId, message, cause: error, retainedCancelling: true }
      : { failedAttempt: attempt.attemptId, message, cause: error };
  }
  // Remote stop acknowledged: the marked detached runner cleanup runs now that
  // the exact remote-control exit is durable, before the settlement re-read
  // elects the winner. The helper is a guarded no-op for unmarked records and
  // never signals a free-lease pid. Its outcome GATES the terminal election:
  // only a settled duty (kill decision plus a completed-clean same-pass sweep)
  // or an unmarked record may terminalize — a budget-expired, pending-sweep,
  // or unproven outcome retains the durable cancelling guard (below) so a
  // surviving verified descendant always has the next bounded pass as its
  // retry authority.
  const runnerCleanupOutcome = await terminateCancellationRunner(input, cancelling);
  if (runnerCleanupOutcome.kind !== 'settled' && runnerCleanupOutcome.kind !== 'unmarked') {
    return cancellationUncertain(input, attempts, attempt, cancelling,
      new Error('The marked detached-runner cleanup did not complete a proven descendant sweep.'));
  }
  const boundary = persistedTurnBoundary(cancelling);
  if (!boundary && job.command === 'rescue' && job.readOnly === false) return cancellationUncertain(input, attempts, attempt, cancelling,
    new Error('ZCode cancellation cannot be proven before the accepted turn boundary is durable.'));
  if (input.options.readSession && boundary) {
    const settlement = await observeCancellationSettlement(input, cancelling, observedStop?.guard);
    if (settlement.kind === 'stale') return settlement.job;
    if (settlement.kind === 'succeeded') {
      if (!input.options.publishSucceededSnapshot) return cancellationUncertain(input, attempts, attempt, cancelling,
        new Error('ZCode completed during cancellation but no result publisher is available.'));
      const winner = await input.options.publishSucceededSnapshot({ workspace: input.workspace, job: cancelling,
        snapshot: /** @type {any} */ (settlement).snapshot, turnBoundary: boundary });
      return recordCancelledAttempt(input, attempts, attempt, winner);
    }
    if (!['interrupted', 'failed'].includes(settlement.kind)) {
      return cancellationUncertain(input, attempts, attempt, cancelling,
        settlement.error ?? new Error('ZCode cancellation observation expired while the current turn remained unresolved.'));
    }
  }
  let cancelled;
  try { cancelled = await finishJob(input.options.store, input.workspace, job.id, ['cancelling'], 'cancelled', { exitCode: null, ...hostOwnedCancelledPatch(cancelling, stopCause) }); }
  catch (error) {
    try { cancelled = await durableCancelledWinner(cancelledWinnerInput(input), error); }
    catch (finalizeFailure) {
      await attempts.update(job.id, input.ownerSessionId, attempt.attemptId, 'finalize-pending'); throw finalizeError(job.id, finalizeFailure);
    }
  }
  return recordCancelledAttempt(input, attempts, attempt, cancelled);
}

/** Settle one claimed queued cancellation only after acquiring its exact recorded claim lease free:
 * a held lease defers to the starting runner (the persisted stop intent above keeps the durable
 * decision pending for recovery or a retry), while a free lease proves the local orphan and
 * publishes the cancelled winner through the recovery lease-CAS terminalization. The probed lease
 * is the EFFECTIVE lease, so a fenced not-yet-claimed runner is settled against its reservation
 * lease exactly as state.mjs's recovery CAS compares it.
 * @param {any} input @param {any} job @param {string} stopCause */
async function settleClaimedQueuedCancellation(input, job, stopCause) {
  const current = await input.options.store.readJob(input.workspace, job.id);
  if (current.status !== 'queued') return current;
  const workerLeaseId = effectiveQueuedWorkerLeaseId(current);
  if (!isDigestValue(workerLeaseId)) return current;
  const dataRoot = input.options.dataRoot ?? input.options.store.dataRoot;
  // A claimed queued MARKED runner may be wedged before it ever observes the
  // durable stop decision: terminate the identity-proven tree first (marker +
  // exact owner/epoch/job/claim + two nonblocking held-lease probes; a free
  // lease is never signaled and the unmarked attached companion is never a
  // process-group target), so the lease-acquiring settlement below can win the
  // released claim as cancelled — queued stopIntent -> kill -> acquire lease ->
  // cancelled. An unmarked legacy claim keeps the existing defer-to-starting-
  // worker behavior exactly.
  if (current.rescueRunnerVersion === RESCUE_RUNNER_VERSION) {
    // THE SETTLEMENT INVARIANT: the lease-acquiring cancelled publication below
    // happens only behind a duty that ran the kill decision AND a completed-
    // clean same-pass sweep. Every other outcome (budget-expired, pending
    // sweep, a thrown duty) retains the claimed queued record exactly as-is —
    // its durable stop intent is the retry evidence that re-arms the duty on
    // the next bounded pass (discovery of marked claims never depends on the
    // lease state, so the retry is guaranteed to re-run the sweep). `unproven`
    // is the fence-gap convention (see settleSelectedJob in recovery.mjs): the
    // marker without a provable claim (no recorded pid/lease pair) names NO
    // signalable process, and the exact-lease CAS publication below is itself
    // the identity gate there — exactly as before this invariant.
    const runnerCleanup = await terminateMarkedRunnerTree({ store: input.options.store, dataRoot, workspace: input.workspace,
      ownerSessionId: input.ownerSessionId, epoch: current.ownerLifecycleEpoch,
      ...(typeof input.options.sweepDeadRootDescendants === 'function'
        ? { sweepDeadRootDescendants: input.options.sweepDeadRootDescendants } : {}) },
    current, input.options.terminateProcessTree).catch(() => undefined);
    if (runnerCleanup?.kind !== 'settled' && runnerCleanup?.kind !== 'unproven') return current;
  }
  const rollback = await readQueuedRescueMigrationRollback({ dataRoot, workspace: input.workspace,
    job: current, store: input.options.store,
    invalid: () => cancelError(job.id, 'Queued migration specification is invalid.') });
  const cause = validStopIntent(current.stopIntent) ? current.stopIntent.cause : stopCause;
  const finish = () => input.options.store.finishQueuedJobAfterRecoveryLease(input.workspace, current.id,
    workerLeaseId, rollback, 'cancelled',
    { exitCode: null, ...(validStopIntent(current.stopIntent) ? { stopCause: current.stopIntent.cause } : hostOwnedCancelledPatch(current, cause)) });
  try {
    return await withWorkerLease({ dataRoot, workspace: input.workspace, jobId: current.id, workerLeaseId, timeoutMs: 0 }, finish);
  } catch (error) {
    // JOB_PATCH_INVALID is the minted-patch losing a persistence race against a
    // delegated durable intent between the pre-lock read and the state lock:
    // bounded convergence re-reads the authoritative record instead of letting
    // the internal code escape the cancel surface.
    if (error instanceof PluginError && ['LOCK_TIMEOUT', 'WORKER_LEASE_CONFLICT', 'JOB_TERMINAL', 'JOB_PATCH_INVALID'].includes(error.code)) {
      return input.options.store.readJob(input.workspace, current.id);
    }
    throw error;
  }
}

/**
 * Perform the cancellation election's marked-runner cleanup duty on a remote-
 * control exit. Failures are swallowed into the `not-proven` retention
 * outcome. The duty's outcome is AUTHORITY, never a discarded diagnostic:
 * only `settled` (kill decision plus a completed-clean same-pass sweep) or
 * `unmarked` (no local duty exists) permits the caller to terminalize — every
 * other outcome maps to retention (pending guard, no terminal publication, no
 * exclusion release); the durable cancelling record (with its persisted stop
 * intent) re-arms the same duty for owner recovery, reservation scavenging,
 * and a later reconciliation pass — no separate cleanup ledger.
 * @param {any} input @param {any} cancelling
 */
async function terminateCancellationRunner(input, cancelling) {
  try {
    return await terminateMarkedRunnerTree({
      store: input.options.store,
      dataRoot: input.options.dataRoot ?? input.options.store.dataRoot,
      workspace: input.workspace,
      ownerSessionId: input.ownerSessionId,
      epoch: cancelling.ownerLifecycleEpoch,
      ...(typeof input.options.setTimeout === 'function' ? { setTimeout: input.options.setTimeout } : {}),
      ...(typeof input.options.clearTimeout === 'function' ? { clearTimeout: input.options.clearTimeout } : {}),
      ...(typeof input.options.sweepDeadRootDescendants === 'function'
        ? { sweepDeadRootDescendants: input.options.sweepDeadRootDescendants } : {}),
    }, cancelling, input.options.terminateProcessTree);
  } catch { return { kind: 'not-proven' }; }
}

/** Keep the cancellation lock and managed client alive while the admission gap converges. @param {any} input @param {any} job @param {any} guard */
async function observeCancellationSettlement(input, job, guard) {
  const duration = nonnegativeSafeInteger(input.options.cancellationObservationMs) ? input.options.cancellationObservationMs : 1_000;
  const interval = nonnegativeSafeInteger(input.options.cancellationObservationIntervalMs) ? input.options.cancellationObservationIntervalMs : 25;
  const boundary = persistedTurnBoundary(job);
  if (!boundary) return { kind: 'uncertain', error: new Error('The durable turn boundary is incomplete.') };
  const scheduleTimeout = input.options.setTimeout ?? globalThis.setTimeout;
  const cancelTimeout = input.options.clearTimeout ?? globalThis.clearTimeout;
  /** @type {()=>void} */ let expire = () => {};
  const expiry = new Promise((resolvePromise) => { expire = () => resolvePromise(undefined); });
  const timer = scheduleTimeout(expire, duration);
  let stoppedActiveTurn = false;
  /** @param {()=>Promise<any>} operation @returns {Promise<{kind:'value',value:any}|{kind:'error',error:any}|{kind:'expired'}>} */
  const bounded = async (operation) => Promise.race([
    Promise.resolve().then(operation).then((value) => ({ kind: /** @type {const} */ ('value'), value }), (error) => ({ kind: /** @type {const} */ ('error'), error })),
    expiry.then(() => ({ kind: /** @type {const} */ ('expired') })),
  ]);
  try {
    for (;;) {
      const read = await bounded(() => input.options.readSession(job.zcodeSessionId));
      if (read.kind === 'expired') return { kind: 'unresolved' };
      if (read.kind === 'error') return { kind: 'uncertain', error: read.error };
      const snapshot = read.value;
      const classification = classifyCurrentTurnSnapshot(snapshot, boundary);
      if (classification.kind !== 'pending') return { ...classification, snapshot };
      if (!stoppedActiveTurn && ['running', 'waiting', 'paused'].includes(snapshot?.projection?.status)
        && hasCurrentTurnActivity(snapshot, boundary)) {
        const validation = await bounded(() => revalidateBoundRescueStop(input.options.store, input.workspace, job, guard));
        if (validation.kind === 'expired') return { kind: 'unresolved' };
        if (validation.kind === 'error') return { kind: 'uncertain', error: validation.error };
        if (validation.value?.kind === 'stale') return { kind: 'stale', job: validation.value.job };
        const stop = await bounded(() => input.options.stopSession(job.zcodeSessionId));
        if (stop.kind === 'expired') return { kind: 'unresolved' };
        if (stop.kind === 'error') return { kind: 'uncertain', error: stop.error };
        stoppedActiveTurn = true;
      }
      const wait = await bounded(() => input.options.delay
        ? input.options.delay(interval)
        : pollDelay(interval, undefined, scheduleTimeout, cancelTimeout));
      if (wait.kind === 'expired') return { kind: 'unresolved' };
      if (wait.kind === 'error') return { kind: 'uncertain', error: wait.error };
    }
  } finally { cancelTimeout(timer); }
}

/** @param {any} input @param {any} attempts @param {any} attempt @param {any} job @param {unknown} error */
async function cancellationUncertain(input, attempts, attempt, job, error) {
  const message = boundedCancelMessage(error instanceof Error ? error.message : 'ZCode cancellation settlement is uncertain.');
  const winner = await input.options.store.readJob(input.workspace, job.id).catch(() => null);
  if (winner && TERMINAL.has(winner.status)) return winner;
  await attempts.update(job.id, input.ownerSessionId, attempt.attemptId, 'failed-pending-release', message);
  await input.options.afterRollbackBeforeSettle?.();
  // A cancelling record carrying a persisted stop intent keeps its durable
  // authorization across the uncertain settlement, so the public rejection
  // must report the retained cancelling state — never "remains running".
  return { failedAttempt: attempt.attemptId, message, cause: error,
    ...(winner?.status === 'cancelling' && validStopIntent(winner.stopIntent) ? { retainedCancelling: true } : {}) };
}

/** @param {unknown} value */
function nonnegativeSafeInteger(value) { return Number.isSafeInteger(value) && Number(value) >= 0; }

/** @param {any} store @param {string} workspace @param {any} job @param {any} [expected] @param {string} [zcodeSessionId] */
export async function revalidateBoundRescueStop(store, workspace, job, expected, zcodeSessionId = job.zcodeSessionId) {
  if (job.command !== 'rescue' || job.readOnly !== false || job.rescueReservationKind !== 'bound') return null;
  if (typeof store.revalidateBoundRescueStop !== 'function') return { kind: 'stale', job: await store.readJob(workspace, job.id) };
  return store.revalidateBoundRescueStop({ workspace, jobId: job.id, ownerSessionId: job.ownerSessionId,
    status: job.status, ...(zcodeSessionId === undefined ? {} : { zcodeSessionId }),
    ...(job.workerLeaseId === undefined ? {} : { workerLeaseId: job.workerLeaseId }),
    ...(expected === undefined ? {} : { expected }) });
}

/** Durable job terminality is authoritative; cancellation attempts remain auxiliary election evidence. @param {{options:any,workspace:string,jobId:string,ownerSessionId:string}} input @param {ReturnType<typeof createCancelAttemptStore>} attempts @param {any} attempt @param {any} cancelled */
async function recordCancelledAttempt(input, attempts, attempt, cancelled) {
  try { await attempts.update(cancelled.id, input.ownerSessionId, attempt.attemptId, 'succeeded'); return cancelled; }
  catch (error) {
    if (cancelled?.status === 'cancelled') return durableCancelledWinner(cancelledWinnerInput(input), error);
    let durable;
    try { durable = await input.options.store.readJob(input.workspace, input.jobId); } catch { throw error; }
    if (TERMINAL.has(cancelled?.status)
      && cancelled.id === input.jobId && cancelled.ownerSessionId === input.ownerSessionId
      && isDeepStrictEqual(durable, cancelled)) return durable;
    throw error;
  }
}

/** Resolve only the exact durable cancellation winner; every ambiguous read or identity mismatch preserves the initiating error. @param {{store:any,workspace:string,jobId:string,ownerSessionId:string}} input @param {unknown} error */
export async function durableCancelledWinner(input, error) {
  let winner;
  try { winner = await input.store.readJob(input.workspace, input.jobId); } catch { throw error; }
  if (winner?.id === input.jobId && winner.ownerSessionId === input.ownerSessionId && winner.status === 'cancelled') return winner;
  throw error;
}

/** @param {{options:any,workspace:string,jobId:string,ownerSessionId:string}} input */
function cancelledWinnerInput(input) {
  return { store: input.options.store, workspace: input.workspace, jobId: input.jobId, ownerSessionId: input.ownerSessionId };
}

/** @param {{options:any,workspace:string,jobId:string,ownerSessionId:string}} input @param {ReturnType<typeof createCancelAttemptStore>} attempts @param {any} outcome */
async function settleCancellationOutcome(input, attempts, outcome) {
  if (!outcome?.failedAttempt) return outcome;
  await attempts.update(input.jobId, input.ownerSessionId, outcome.failedAttempt, 'failed', outcome.message);
  if (outcome.retainedCancelling) {
    throw new PluginError('JOB_CANCEL_FAILED', `Could not cancel job ${input.jobId}: ${outcome.message}`, {
      category: 'runtime',
      remedy: `The job remains cancelling with its persisted stop intent; run $zcode:status ${input.jobId} --wait to reconcile the stop.`,
      ...(outcome.cause ? { cause: outcome.cause } : {}),
    });
  }
  throw cancelError(input.jobId, outcome.message, outcome.cause);
}

/** @param {any} record */
function failedOutcome(record) { return { failedAttempt: record.attemptId, message: record.error.message }; }
/** @param {any} observed @param {any} current */
function completedDuringAcquisition(observed, current) {
  if (!observed) return true;
  if (observed.attemptId !== current.attemptId) return true;
  if (observed.status === current.status && observed.updatedAt === current.updatedAt) return false;
  return ['active', 'failed-pending-release', 'finalize-pending'].includes(observed.status)
    && ['failed', 'succeeded', 'finalize-pending'].includes(current.status);
}

/** @param {number} milliseconds @param {AbortSignal} [signal] @param {(callback:()=>void,ms:number)=>any} [schedule] @param {(timer:any)=>void} [cancel] */
function pollDelay(milliseconds, signal, schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = /** @type {any} */ (undefined);
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => { if (settled) return; settled = true; if (timer !== undefined) cancel(timer); cleanup(); reject(signal?.reason); };
    const onTimer = () => { if (settled) return; settled = true; cleanup(); resolve(undefined); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (!settled) {
      timer = schedule(onTimer, milliseconds);
      if (settled) cancel(timer);
    }
  });
}
/** @template T @param {()=>T|Promise<T>} operation @param {AbortSignal} [signal] */
function abortable(operation, signal) {
  signal?.throwIfAborted();
  const completion = Promise.resolve().then(() => { signal?.throwIfAborted(); return operation(); });
  return waitForCompletionOrAbort(completion, signal);
}
/** @param {any} job @param {'status'|'result'|'cancel'} eligibility */
function eligibleImplicit(job, eligibility) {
  if (eligibility === 'cancel') return ['queued', 'running', 'cancelling'].includes(job.status);
  if (eligibility === 'result') return TERMINAL.has(job.status);
  return true;
}
/** @param {any} store @param {string} workspace @param {string} jobId @param {string[]} expectedStatuses @param {string} nextStatus @param {Record<string,unknown>} patch */
function finishJob(store, workspace, jobId, expectedStatuses, nextStatus, patch) {
  return store.finishJob(workspace, jobId, expectedStatuses, nextStatus, patch);
}
/** @param {string} jobId @param {unknown} cause */
function finalizeError(jobId, cause) { return new PluginError('JOB_CANCEL_FINALIZE_FAILED', `ZCode stopped, but job ${jobId} could not be finalized as cancelled.`, { category: 'storage', remedy: 'Retry cancellation to reconcile and finalize the cancelling job.', cause }); }
/** @param {string} jobId @param {string} message @param {unknown} [cause] */
function cancelError(jobId, message, cause) { return new PluginError('JOB_CANCEL_FAILED', `Could not cancel job ${jobId}: ${message}`, { category: 'runtime', remedy: 'The job remains running; retry cancellation or inspect the ZCode session.', ...(cause ? { cause } : {}) }); }
/** @param {string} message */
export function boundedCancelMessage(message) {
  let result = ''; let bytes = 0;
  for (const character of message) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > 2_048) break;
    result += character; bytes += characterBytes;
  }
  return result || 'ZCode stop failed';
}
