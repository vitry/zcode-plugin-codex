import { spawn, spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';

import { PluginError, wrapError } from './errors.mjs';

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const POST_EXIT_DRAIN_MS = 50;
// Windows process operations are one to two orders of magnitude slower than
// their POSIX counterparts on loaded machines: one bounded process-table
// snapshot spawns powershell.exe and queries the FULL Win32_Process table
// (typically 0.5-3s on a cold CI runner), and every taskkill dispatch is a
// process launch (0.1-1s). A sub-second shared deadline therefore can never
// fit an enumeration-based termination there — and worse, a snapshot that
// consumes the ENTIRE deadline leaves the kill itself with no budget, so
// NOTHING is ever dispatched and the recorded runner is never even signalled.
// Two Windows-only constants fix the arithmetic WITHOUT touching POSIX
// budgets (whose group kill is a single in-process dispatch):
// - WINDOWS_TREE_TERMINATION_BUDGET_MS is the DEFAULT total shared budget for
//   one Windows termination/sweep when the caller proves no deadline of its
//   own (POSIX stays 1_000ms). Callers that pass an explicit deadlineMs or
//   timeoutMs are still bounded by exactly what they pass.
// - WINDOWS_SNAPSHOT_KILL_RESERVE_MS is the minimal budget the kill sequence
//   keeps for itself: each process-table snapshot is bounded by the remaining
//   budget MINUS this reserve, and when that slice is non-positive the
//   snapshot is SKIPPED entirely (the documented fail-closed pid-only
//   degradation) instead of being launched into a budget it cannot fit — so
//   the recorded pid is at minimum force-killed inside the caller's deadline
//   and the descendant sweep honestly defers to the next bounded pass.
export const WINDOWS_TREE_TERMINATION_BUDGET_MS = 8_000;
export const WINDOWS_SNAPSHOT_KILL_RESERVE_MS = 1_500;

/** @param {string} path @param {string} [execPath] @param {string} [platform] @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env] */
export function launchForPath(path, execPath = process.execPath, platform = process.platform, env = process.env) {
  if (typeof path !== 'string' || path.length === 0) throw processInputError();
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (platform === 'win32' && ['.cmd', '.bat'].includes(extension)) return { command: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c'], target: path, windowsShim: true };
  return JS_EXTENSIONS.has(extension)
    ? { command: execPath, args: [path], target: path }
    : { command: path, args: [], target: path };
}

/** @param {{ command: string, args: string[], target?: string }} launch */
export async function assertLaunchTarget(launch) {
  validateLaunch(launch);
  if (!launch.target) return;
  try {
    await access(launch.target);
  } catch (error) {
    throw new PluginError('ZCODE_LAUNCH_TARGET_MISSING', 'The resolved ZCode launch target no longer exists.', {
      category: 'runtime', remedy: 'Run $zcode:setup to rediscover the installed ZCode CLI.', cause: error,
      details: { target: launch.target },
    });
  }
}

/**
 * @param {{ command: string, args: string[], target?: string, windowsShim?: boolean }} launch
 * @param {{ args?: string[], cwd?: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal }} [options]
 */
export async function spawnProcess(launch, options = {}) {
  validateLaunch(launch);
  await assertLaunchTarget(launch);
  try {
    const extraArgs = options.args ?? [];
    const argv = launch.windowsShim ? [...launch.args, windowsShimCommand(/** @type {string} */ (launch.target), extraArgs)] : [...launch.args, ...extraArgs];
    const child = spawn(launch.command, argv, {
      cwd: options.cwd, env: options.env, signal: options.signal,
      detached: process.platform !== 'win32', shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    return child;
  } catch (error) {
    throw wrapError(error, 'ZCODE_SPAWN_FAILED', 'Could not start ZCode.', {
      category: 'runtime', remedy: 'Verify the ZCode installation and run $zcode:setup.',
    });
  }
}

/** @param {{command:string,args:string[],target?:string}} launch @param {{args?:string[],cwd?:string,env?:NodeJS.ProcessEnv}} [options] */
export async function spawnDaemon(launch, options = {}) {
  validateLaunch(launch); await assertLaunchTarget(launch);
  try {
    const child = spawn(launch.command, [...launch.args, ...(options.args ?? [])], { cwd: options.cwd, env: options.env, detached: true, shell: false, windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref(); return child;
  } catch (error) { throw wrapError(error, 'ZCODE_DAEMON_SPAWN_FAILED', 'Could not start the ZCode broker process.', { category: 'runtime', remedy: 'Verify the Node and ZCode installations.' }); }
}

/** @param {{command:string,args:string[],target?:string,windowsShim?:boolean}} launch @param {{args?:string[],cwd?:string,env?:NodeJS.ProcessEnv,timeoutMs?:number,maxOutputBytes?:number,signal?:AbortSignal}} [options] */
export async function runProcess(launch, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000; const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw processInputError();
  if (options.signal?.aborted) throw new PluginError('ZCODE_PROCESS_ABORTED', 'The ZCode process was aborted.', { category: 'state', remedy: 'Retry when the operation should continue.' });
  const { signal, ...spawnOptions } = options; const child = await spawnProcess(launch, spawnOptions); let stdout = ''; let stderr = ''; let capturedOutputBytes = 0; let overflow = false;
  child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
  const capture = (/** @type {'stdout'|'stderr'} */ kind, /** @type {string} */ chunk) => {
    if (overflow) return;
    const chunkBytes = Buffer.byteLength(chunk);
    if (capturedOutputBytes + chunkBytes > maxOutputBytes) {
      overflow = true;
      child.stdout?.destroy(); child.stderr?.destroy();
      void terminateProcess(child).catch(() => {});
      return;
    }
    capturedOutputBytes += chunkBytes;
    if (kind === 'stdout') stdout += chunk; else stderr += chunk;
  };
  child.stdout?.on('data', (chunk) => capture('stdout', chunk)); child.stderr?.on('data', (chunk) => capture('stderr', chunk));
  let timer; const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
  let resolveAbort = () => {}; const abort = new Promise((resolve) => { resolveAbort = () => resolve('aborted'); }); signal?.addEventListener('abort', resolveAbort, { once: true });
  let outcome;
  try { outcome = await Promise.race([new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, childSignal) => { void drainExitedProcessStreams([child.stdout, child.stderr], POST_EXIT_DRAIN_MS).then(() => resolve({ code, signal: childSignal }), reject); }); }), timeout, abort]); }
  catch (error) { await terminateProcess(child).catch(() => {}); throw wrapError(error, 'ZCODE_PROCESS_FAILED', 'The ZCode process failed.', { category: 'runtime', remedy: 'Verify the installation and retry.' }); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', resolveAbort); }
  if (outcome === 'aborted') { await terminateProcess(child); throw new PluginError('ZCODE_PROCESS_ABORTED', 'The ZCode process was aborted.', { category: 'state', remedy: 'Retry when the operation should continue.' }); }
  if (outcome === 'timeout' || overflow) { await terminateProcess(child); throw new PluginError(outcome === 'timeout' ? 'ZCODE_PROCESS_TIMEOUT' : 'ZCODE_PROCESS_OUTPUT_LIMIT', outcome === 'timeout' ? 'The ZCode process timed out.' : 'The ZCode process exceeded its output limit.', { category: outcome === 'timeout' ? 'timeout' : 'runtime', remedy: 'Inspect the ZCode installation and retry.', details: { timeoutMs, maxOutputBytes, capturedOutputBytes } }); }
  return { ...outcome, stdout, stderr };
}

/**
 * Drain bytes already owned by an exited child without allowing a descendant
 * that inherited the pipe to retain the caller indefinitely.
 * @param {Array<import('node:stream').Readable|null|undefined>} streams
 * @param {number} [timeoutMs]
 */
export async function drainExitedProcessStreams(streams, timeoutMs = POST_EXIT_DRAIN_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw processInputError();
  const pending = /** @type {import('node:stream').Readable[]} */ (streams.filter((stream) => stream && !stream.destroyed && !stream.readableEnded));
  if (pending.length === 0) return;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  /** @type {Array<() => void>} */
  const removeListeners = [];
  const completed = new Promise((resolve) => {
    let remaining = pending.length;
    for (const stream of pending) {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        remaining -= 1;
        if (remaining === 0) resolve('completed');
      };
      stream.once('end', finish); stream.once('close', finish); stream.once('error', finish);
      removeListeners.push(() => { stream.removeListener('end', finish); stream.removeListener('close', finish); stream.removeListener('error', finish); });
    }
  });
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve('deadline'), timeoutMs); });
  const result = await Promise.race([completed, deadline]);
  clearTimeout(timer);
  for (const remove of removeListeners) remove();
  if (result === 'deadline') for (const stream of pending) stream.destroy();
}

/**
 * One live process as observed by a bounded Windows process-table snapshot:
 * its recorded parent pid (null when CIM reported no parent) and its
 * creation-fixed launch command line (null when CIM could not read it).
 * @typedef {{ ppid: number|null, commandLine: string|null }} WindowsProcessIdentity
 */

/** One bounded snapshot of every live process, keyed by pid.
 * @typedef {Map<number, WindowsProcessIdentity>} WindowsProcessSnapshot
 */

/**
 * One identity-matched broker exclusion candidate: the recorded broker pid
 * PLUS the recorded launch signature that a snapshotted process's command line
 * must still match before that pid may be spared as the separately managed
 * broker.
 * @typedef {{ pid: number, command: string, args: string[] }} WindowsBrokerExclusion
 */

/**
 * Terminate a RECORDED detached worker process tree by its group-leader pid.
 * Detached workers are their own process group, so the group is signalled first
 * and the bare pid is the fallback. A missing or already-exited tree — leader
 * or group — is a no-op. This is only local process cleanup — it is NOT remote
 * terminal proof, so callers must re-read durable state to elect a winner.
 * Bounded by `graceMs` and per-invocation `timeoutMs`; the optional `signal`
 * only accelerates the POSIX grace wait into an immediate group SIGKILL and
 * never gates the kill itself.
 *
 * Windows has no process-group addressing, so cleanup walks the recorded
 * runner's PPID descendant tree. The broker exclusion is THREE-VALUED and
 * fails closed:
 * - `excludeBrokers` names the separately managed broker identities the
 *   settlement caller resolved from the workspace's durable broker identities.
 *   Each entry pairs the recorded broker pid with the broker's RECORDED LAUNCH
 *   SIGNATURE (its creation-fixed command and arguments, published by the
 *   broker itself into its identity file). A snapshotted descendant is
 *   EXCLUDED only when it both holds a recorded broker pid AND its snapshotted
 *   command line matches that pid's recorded signature — a live broker spawned
 *   by this plugin always exposes its command line to the same-user snapshot,
 *   so a mismatching or unreadable command line proves the recorded instance
 *   no longer owns the pid, and a pid is never excluded on its number alone.
 *   Each identity-matched pid AND its descendant subtree is pruned from the
 *   kill plan (the broker and its engine must survive as runner-descendants),
 *   every remaining descendant plus the runner itself is force-killed, and the
 *   walk shares the single bounded deadline below. Before the kill sequence is
 *   dispatched, a SECOND fresh process-table snapshot is taken inside the same
 *   deadline and the plan is INTERSECTED with it: only targets present in BOTH
 *   snapshots with an unchanged parent pid AND an unchanged command line are
 *   signalled — a descendant that exited and had its pid reused between the
 *   snapshots shows a different parent or creation command line (or is gone)
 *   and is skipped instead of being force-killed as an unrelated replacement
 *   process. This is the same double-probe best-effort identity policy as the
 *   runner's worker-lease probes (the spec's PID-safety section): two identity
 *   probes shrink the stale-PID window but do not create an atomic OS process
 *   handle, a snapshot-to-signal race remains, and no absolute PID-reuse
 *   immunity is claimed. The verified kill sequence is ALL-OR-REPORTED, never
 *   silently partial: if the shared deadline is spent mid-sequence (typically
 *   by the runner's own kill) or a kill dispatch fails, the walk stops there
 *   and the outcome is the INCOMPLETE report below naming every verified
 *   target that was NOT dispatched — a runner whose lease frees while its
 *   descendants survive must never let a caller settle the cleanup duty as
 *   performed. When the second snapshot cannot be taken (its budget
 *   already spent, or the enumeration fails), or any exclusion entry is
 *   malformed, the plan fails CLOSED to the recorded pid alone — unverified
 *   descendants are never risked, and the runner-at-minimum kill keeps the
 *   durable cleanup-pending evidence authoritative. That fallback is honest
 *   about its own budget too: when no kill budget remains (typically because a
 *   snapshot consumed the deadline) NOTHING is dispatched — never a
 *   zero-timeout taskkill its own bound kills before it can signal — and the
 *   outcome is the INCOMPLETE report with the recorded pid pending; with
 *   budget, the fallback completes only on evidence (the pid provably gone,
 *   or a forced dispatch with delivery evidence) and reports INCOMPLETE
 *   otherwise.
 * - `excludeUnknown: true` reports that the caller attempted the broker lookup
 *   but could not prove the complete exclusion list (missing, corrupt,
 *   unreadable, or timed-out identity, a partial scan, or no identity recorded
 *   yet): cleanup fails CLOSED to the recorded pid alone (forced-only, NEVER
 *   /T) because any descendant could be the separately managed broker, and no
 *   process-table snapshot is even taken — with an unprovable
 *   exclusion the walk has nothing safe to plan. The same pid-only degradation
 *   applies when an exclusion-aware walk cannot obtain its process-table
 *   snapshots (timeout, tool failure, unparsable output): a runner descendant
 *   that cannot be proven non-broker is never risked, and the
 *   runner-at-minimum kill keeps the durable cleanup-pending evidence
 *   authoritative.
 * - NEITHER option means the caller asserts no broker concept at all, and the
 *   full recorded tree terminates through `taskkill /T` exactly as before.
 * @param {number} pid @param {{
 *   graceMs?: number, signal?: AbortSignal, timeoutMs?: number,
 *   excludeBrokers?: readonly WindowsBrokerExclusion[], excludeUnknown?: boolean,
 *   enumerateProcessTable?: (timeoutMs: number) => Promise<WindowsProcessSnapshot|null>,
 *   runProcessKill?: (command: string, args: readonly string[], options?: { timeoutMs?: number }) => Promise<BoundedProcessKillOutcome|void>,
 * }} [options]
 * @returns {Promise<boolean|{completed: false, dispatched: number, pending: number[]}>} `true` when
 *   EVERY verified kill target was dispatched inside the shared budget (and `false` when the tree
 *   is absent); the INCOMPLETE report otherwise — `dispatched` counts only the verified targets
 *   whose kill carries evidence of delivery (a clean taskkill exit or the already-gone 128
 *   convention) before the budget expired or a dispatch failed, and `pending` names the verified
 *   targets (runner or descendants) that were never signalled — including the recorded pid itself
 *   when the pid-only fail-closed fallback inherits an exhausted budget or its own kills never
 *   land. The POSIX branch keeps plain boolean semantics: its group-addressed kill is a single
 *   dispatch with no partial sequence.
 */
export async function terminateRecordedProcessTree(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const graceMs = Number.isSafeInteger(options.graceMs) && /** @type {number} */ (options.graceMs) >= 0 ? /** @type {number} */ (options.graceMs) : 200;
  const alive = () => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'; }
  };
  // The recorded tree survives its leader when a descendant ignored the signal:
  // the group must be probed too, or such a tree would be declared gone here.
  const groupAlive = () => {
    try { process.kill(-pid, 0); return true; }
    catch (error) { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'; }
  };
  if (!alive() && !groupAlive()) return false;
  // Windows has no process-group negative-pid addressing, so the termination
  // scope must be built explicitly from the PPID tree: the runner's descendants
  // belong to the recorded tree, EXCEPT the separately managed broker (and its
  // engine) when the caller can name it — the broker-survival invariant
  // outranks descendant coverage, and an unnamable descendant fails closed to
  // the recorded pid alone rather than risking a broker with /T. (Spec-conflict
  // resolution: the design's "Windows taskkill /T" wording is implemented as
  // this exclusion-aware PPID walk for writable Rescue, satisfying its
  // stronger, twice-stated rule that the separately managed broker must not be
  // killed as a runner descendant.) `enumerateProcessTable` and
  // `runProcessKill` default to the production implementations and exist as
  // test seams so the Windows branch is unit-drivable on any host platform,
  // mirroring the injectable terminateProcessTree convention.
  if (process.platform === 'win32') {
    // ONE shared local deadline spans the process-table snapshot, every
    // taskkill invocation and the grace interval: whichever stage stalls, the
    // whole sequence stays inside its own budget and can never push a
    // SessionEnd hook past the native deadline. The default matches the
    // Windows process-operation reality (see WINDOWS_TREE_TERMINATION_BUDGET_MS):
    // a caller that proves no deadline of its own still gets a budget one real
    // PowerShell snapshot plus the kill dispatch can actually fit inside.
    const totalMs = Number.isSafeInteger(options.timeoutMs) && /** @type {number} */ (options.timeoutMs) >= 0 ? /** @type {number} */ (options.timeoutMs) : WINDOWS_TREE_TERMINATION_BUDGET_MS;
    const deadline = Date.now() + totalMs;
    const remaining = () => Math.max(0, deadline - Date.now());
    // Each snapshot is bounded by the remaining budget MINUS the minimal slice
    // the kill keeps for itself (see WINDOWS_SNAPSHOT_KILL_RESERVE_MS, scaled
    // down for small explicit budgets so the reserve can never exceed half the
    // caller's own bound): a snapshot that cannot fit is SKIPPED — never
    // launched — and the plan fails closed to the recorded pid alone, which
    // keeps the whole remaining budget for the runner kill instead of being
    // starved by a doomed enumeration.
    const snapshotReserveMs = Math.min(WINDOWS_SNAPSHOT_KILL_RESERVE_MS, Math.floor(totalMs / 2));
    const snapshotBudget = () => Math.max(0, remaining() - snapshotReserveMs);
    const takeSnapshot = async () => snapshotBudget() > 0 ? enumerateProcessTable(snapshotBudget()) : null;
    const runKill = typeof options.runProcessKill === 'function' ? options.runProcessKill : boundedProcessKill;
    const enumerateProcessTable = typeof options.enumerateProcessTable === 'function' ? options.enumerateProcessTable : readWindowsProcessTable;
    // Kill ONLY the recorded pid — one forced taskkill inside the shared
    // budget, never a descendant walk. This is the fail-closed
    // primitive for every path where a descendant cannot be proven non-broker:
    // a failed broker-exclusion lookup, an unprovable exclusion list, an
    // exclusion-aware termination whose plan snapshot is unavailable, and an
    // exclusion-aware plan whose revalidation snapshot is unavailable or whose
    // budget was spent before it could be taken. The outcome is HONEST: an
    // exhausted budget cannot give even the forced dispatch a non-trivial
    // bound — a zero-timeout taskkill is killed by its own bound before it can
    // signal anything — so nothing is dispatched and the recorded pid is
    // reported pending; with budget, the duty is complete only on EVIDENCE
    // (the pid provably gone, or a forced dispatch with delivery evidence),
    // and every other resolution — a forced kill killed at its bound, a live
    // pid with nothing left to escalate with — is the INCOMPLETE report, never
    // a `true` that would settle a cleanup duty whose runner may still live.
    //
    // FORCED-ONLY, no grace phase: the fail-closed target is a DETACHED
    // runner (spawned detached with `windowsHide`, never a windowed child),
    // and a graceful `taskkill` without /F can only POST a WM_CLOSE that such
    // a process never answers — a guaranteed-no-op process launch (0.1-1s on
    // a loaded Windows runner) whose only real effect is to starve the one
    // primitive that works. Dispatching the forced kill FIRST spends the
    // whole remaining budget on the dispatch that can actually close the
    // recorded pid, which is what keeps a Windows SessionEnd pass (native 3s
    // limit, ~1.5s local slice) able to land the kill at all.
    /** @returns {{completed: false, dispatched: number, pending: number[]}} */
    const pidOnlyIncomplete = () => ({ completed: false, dispatched: 0, pending: [pid] });
    const killRecordedPidOnly = async () => {
      if (remaining() <= 0) return pidOnlyIncomplete();
      // Forced-first (see the rationale above): a windowless detached runner
      // never answers a graceful WM_CLOSE, so there is no graceful dispatch
      // and no grace wait to short-circuit — the forced kill runs immediately
      // with the WHOLE remaining budget.
      const forced = await runKill('taskkill', ['/PID', String(pid), '/F'], { timeoutMs: remaining() });
      if (killDispatchSucceeded(forced)) return true;
      // The forced dispatch carried no delivery evidence (it was killed at
      // its own bound, or exited nonzero such as access-denied): the signal
      // may still have landed, so only the pid's proven absence completes the
      // duty — every other resolution is the INCOMPLETE report.
      return !alive() ? true : pidOnlyIncomplete();
    };
    // Identity-matched broker exclusions: a recorded pid PLUS its recorded
    // launch signature must both prove a snapshotted descendant before it is
    // spared. Any malformed entry (or one naming the runner itself) makes the
    // whole list unprovable — `windowsExcludedBrokers` rejects it with null
    // and cleanup degrades to the recorded pid alone without a snapshot.
    const excludeBrokers = windowsExcludedBrokers(options.excludeBrokers, pid);
    if (excludeBrokers === null || excludeBrokers.length > 0) {
      if (excludeBrokers !== null) {
        // Snapshot one (the PLAN), inside the shared budget minus the kill's
        // own reserve: the identity-bearing table maps each pid to its
        // recorded parent and launch command line so the descendant tree can
        // be walked and every exclusion proven without further process
        // launches. A snapshot that cannot fit is skipped (null) and the
        // pid-only fallback keeps the whole remaining budget for the runner.
        const planSnapshot = await takeSnapshot();
        if (planSnapshot) {
          const planned = windowsDescendantKillTargets(pid, planSnapshot, excludeBrokers);
          // Snapshot two (the REVALIDATION), immediately before the kill
          // sequence and inside the SAME shared budget: the plan is
          // intersected with the fresh table so a descendant that exited and
          // had its pid reused after the plan snapshot is skipped instead of
          // being force-killed as an unrelated replacement process. This is
          // the double-probe best-effort identity policy — the residual
          // snapshot-to-signal race is documented on
          // `windowsProcessIdentityUnchanged`, never claimed away. With no
          // budget left for this second probe (or an unusable snapshot) the
          // plan below fails closed to the recorded pid alone: descendants
          // that cannot be re-verified are never killed.
          if (remaining() > 0) {
            const verifySnapshot = await takeSnapshot();
            if (verifySnapshot) {
              const verified = planned.filter((target) => windowsProcessIdentityUnchanged(target, planSnapshot, verifySnapshot));
              // Kill ONLY the verified plan — the runner FIRST (a live runner
              // can still spawn new descendants), then every verified
              // non-broker descendant, each force-killed inside the shared
              // budget. Graceful taskkill is skipped here: excluded-tree kills
              // must converge inside one budget and /F is the only bounded
              // primitive. The sequence is ALL-OR-REPORTED: a budget spent
              // mid-sequence (typically by the runner's own kill) or a failed
              // dispatch stops the walk, and the INCOMPLETE outcome names
              // every verified target that was never signalled — returning
              // `true` here would let a guarded caller settle a cleanup duty
              // whose surviving descendants have no retry path.
              /** @type {number[]} */
              const dispatched = [];
              for (const target of verified) {
                if (remaining() <= 0) break;
                /** @type {BoundedProcessKillOutcome|void} */
                let dispatch;
                try {
                  dispatch = await runKill('taskkill', ['/PID', String(target), '/F'], { timeoutMs: remaining() });
                } catch { break; }
                // Inspect the dispatch: the production boundedProcessKill
                // RESOLVES on failure (a spawn error, a stall killed at its
                // bound, or a nonzero taskkill exit such as access-denied), so
                // only a resolution with delivery evidence — or the
                // already-gone convention — may count this target as
                // signalled; anything else stops the walk with this target
                // and everything after it pending.
                if (!killDispatchSucceeded(dispatch)) break;
                dispatched.push(target);
              }
              if (dispatched.length === verified.length) return true;
              return { completed: false, dispatched: dispatched.length, pending: verified.slice(dispatched.length) };
            }
          }
        }
      }
      // The exclusion-aware plan could not be verified — its exclusion list is
      // unprovable, its plan snapshot is unavailable, or its revalidation
      // snapshot is unavailable or no longer fits the shared budget: fail
      // CLOSED to the recorded pid alone. A descendant that cannot be proven
      // non-broker is never force-killed, and the broker-survival invariant
      // outranks the orphaned-descendant cleanup this forgoes. The fallback's
      // own outcome is reported verbatim: an exhausted budget or failed
      // dispatches surface as the INCOMPLETE report, not a settled duty.
      return await killRecordedPidOnly();
    }
    // The caller attempted the broker-exclusion lookup but its result is
    // UNPROVEN (failed, timed out, corrupt, partial, or no identity recorded):
    // any descendant could be the separately managed broker, so cleanup fails
    // CLOSED to the recorded pid alone and never walks the tree. No snapshot
    // is taken — with an unprovable exclusion the walk has nothing safe to
    // plan, and a lookup-failed marker must never weaken into a /T walk.
    if (options.excludeUnknown === true) {
      return await killRecordedPidOnly();
    }
    // No exclusions requested: no broker is known on this path, so the full
    // recorded tree (runner plus every PPID descendant) terminates through
    // taskkill /T, the faithful Windows equivalent of the POSIX group kill.
    await runKill('taskkill', ['/PID', String(pid), '/T'], { timeoutMs: remaining() });
    // The grace timer stays REFERENCED: with no other referenced handles an
    // unref'ed timer lets Node exit before the forced-kill fallback runs.
    if (graceMs > 0 && remaining() > 0) await new Promise((resolve) => { setTimeout(resolve, Math.min(graceMs, remaining())); });
    if (alive() && remaining() > 0) await runKill('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: remaining() });
    return true;
  }
  const signalGroup = (/** @type {NodeJS.Signals} */ signal) => {
    for (const target of [-pid, pid]) { try { process.kill(target, signal); return; } catch { /* try next, then gone */ } }
  };
  signalGroup('SIGTERM');
  // The POSIX grace wait shares the caller's termination budget with the rest
  // of the sequence (mirroring the Windows branch): a SessionEnd passing its
  // remaining deadline never waits longer than that budget before escalating.
  const totalMs = Number.isSafeInteger(options.timeoutMs) && /** @type {number} */ (options.timeoutMs) >= 0 ? /** @type {number} */ (options.timeoutMs) : 1_000;
  const deadline = Date.now() + totalMs;
  const remainingGrace = Math.min(graceMs, Math.max(0, deadline - Date.now()));
  if (remainingGrace > 0) {
    let timer;
    const wait = new Promise((resolve) => { timer = setTimeout(() => resolve(false), remainingGrace); });
    const abortSignal = options.signal;
    const aborted = abortSignal ? new Promise((resolve) => { if (abortSignal.aborted) resolve('aborted'); else abortSignal.addEventListener('abort', () => resolve('aborted'), { once: true }); }) : new Promise(() => {});
    const raced = await Promise.race([wait, aborted]);
    clearTimeout(timer);
    if (raced === 'aborted') { signalGroup('SIGKILL'); return true; }
  }
  if (alive() || groupAlive()) signalGroup('SIGKILL');
  return true;
}

/** Bounded launch-signature shape limits shared with the broker identity
 * writer/lookup: a signature longer than this is not a provable launch
 * record. */
export const MAX_BROKER_LAUNCH_COMMAND_CHARS = 1_024;
export const MAX_BROKER_LAUNCH_ARGS = 8;
export const MAX_BROKER_LAUNCH_ARG_CHARS = 1_024;

/**
 * Validate one recorded broker launch signature — the creation-fixed command
 * and arguments the broker publishes into its identity file so a snapshotted
 * process can be proven to still be that broker instance before its pid is
 * trusted as a termination exclusion. Exported for the identity writer/lookup;
 * kept next to the matcher so the write-side and match-side shape rules cannot
 * drift.
 * @param {unknown} launch
 * @returns {boolean}
 */
export function isValidBrokerLaunchSignature(launch) {
  const entry = /** @type {any} */ (launch);
  return Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
    && typeof entry.command === 'string' && entry.command.length > 0 && entry.command.length <= MAX_BROKER_LAUNCH_COMMAND_CHARS
    && Array.isArray(entry.args) && entry.args.length <= MAX_BROKER_LAUNCH_ARGS
    && entry.args.every((/** @type {unknown} */ arg) => typeof arg === 'string' && arg.length <= MAX_BROKER_LAUNCH_ARG_CHARS);
}

/**
 * Sanitize the caller-supplied identity-matched broker exclusion list. EVERY
 * entry must be provable — a positive safe-integer pid distinct from the
 * recorded runner, plus a bounded launch signature — because a single
 * unprovable entry means the list cannot be trusted as a complete exclusion
 * set: any malformed entry, or one naming the runner itself (that would prune
 * the tree root the caller asked to terminate), rejects the WHOLE list with
 * null, the caller's pid-only fail-closed signal.
 * @param {readonly unknown[]|undefined} excludeBrokers @param {number} pid
 * @returns {Array<{pid:number, command:string, args:string[]}>|null}
 */
function windowsExcludedBrokers(excludeBrokers, pid) {
  if (!Array.isArray(excludeBrokers)) return [];
  /** @type {Array<{pid:number, command:string, args:string[]}>} */
  const brokers = [];
  const seen = new Set();
  for (const candidate of excludeBrokers) {
    const entry = /** @type {any} */ (candidate);
    if (!entry || typeof entry !== 'object' || !Number.isSafeInteger(entry.pid) || entry.pid <= 0 || entry.pid === pid
      || !isValidBrokerLaunchSignature(entry)) return null;
    if (seen.has(entry.pid)) continue;
    seen.add(entry.pid);
    brokers.push({ pid: entry.pid, command: entry.command, args: [...entry.args] });
  }
  return brokers;
}

/** A snapshotted command line beyond this bound is never matched: the matcher
 * stays bounded no matter what the process table reports. */
const MAX_MATCHED_COMMAND_LINE_CHARS = 8_192;

/**
 * Split a Windows process command line into its argv tokens under the MSVCRT
 * quoting rules (2n backslashes before a double quote emit n backslashes and
 * toggle quoting; 2n+1 emit n backslashes plus a literal quote).
 * @param {string} commandLine
 * @returns {string[]}
 */
function windowsCommandLineTokens(commandLine) {
  /** @type {string[]} */
  const tokens = [];
  let current = '';
  let started = false;
  let inQuotes = false;
  let index = 0;
  while (index < commandLine.length) {
    const character = commandLine[index];
    if (character === '\\') {
      let backslashes = 0;
      while (index < commandLine.length && commandLine[index] === '\\') { backslashes += 1; index += 1; }
      if (index < commandLine.length && commandLine[index] === '"') {
        current += '\\'.repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) { current += '"'; index += 1; } else inQuotes = !inQuotes;
      } else {
        current += '\\'.repeat(backslashes);
      }
      started = true;
      continue;
    }
    if (character === '"') { inQuotes = !inQuotes; started = true; index += 1; continue; }
    if (!inQuotes && (character === ' ' || character === '\t')) {
      if (started) { tokens.push(current); current = ''; started = false; }
      index += 1;
      continue;
    }
    current += character;
    started = true;
    index += 1;
  }
  if (started) tokens.push(current);
  return tokens;
}

/**
 * Whether one snapshotted command line still IS the recorded broker launch:
 * the tokenized command line must equal the recorded command and arguments
 * exactly — same token count, exact argv-level match (Windows paths are
 * case-insensitive). The broker's identity records its full launch argv, so an
 * exact match is the conservative choice: it can never over-exclude a
 * process that merely starts like the broker. `null` or unreadable command
 * lines never match — a live broker spawned by this plugin always exposes its
 * command line to the same-user snapshot, so an unreadable command line proves
 * the recorded instance no longer owns the pid.
 * @param {string|null} commandLine @param {{command:string, args:readonly string[]}} launch
 * @returns {boolean}
 */
function commandLineMatchesBrokerLaunch(commandLine, launch) {
  if (typeof commandLine !== 'string' || commandLine.length === 0 || commandLine.length > MAX_MATCHED_COMMAND_LINE_CHARS) return false;
  const tokens = windowsCommandLineTokens(commandLine);
  if (tokens.length !== 1 + launch.args.length) return false;
  if (tokens[0].toLowerCase() !== launch.command.toLowerCase()) return false;
  for (let index = 0; index < launch.args.length; index += 1) {
    if (tokens[index + 1].toLowerCase() !== launch.args[index].toLowerCase()) return false;
  }
  return true;
}

/**
 * Whether a planned kill target is still the SAME process at revalidation
 * time: the pid must be present in BOTH snapshots with an unchanged parent pid
 * AND an unchanged command line. Windows records a process's creator pid and
 * fixes its command line at creation, so an unchanged (pid, parent, command
 * line) triple across two fresh snapshots is strong evidence the target never
 * exited-and-got-reused; a descendant that exited and had its pid reused in
 * the window shows a different parent or a different creation command line (or
 * is gone entirely) and is skipped instead of being signalled. This is the
 * double-probe best-effort identity policy, not an atomic OS process handle: a
 * probe-to-signal race remains, and no absolute PID-reuse immunity is claimed.
 * @param {number} pid @param {WindowsProcessSnapshot} planSnapshot @param {WindowsProcessSnapshot} verifySnapshot
 * @returns {boolean}
 */
function windowsProcessIdentityUnchanged(pid, planSnapshot, verifySnapshot) {
  const planned = planSnapshot.get(pid);
  const verified = verifySnapshot.get(pid);
  if (!planned || !verified) return false;
  return planned.ppid === verified.ppid && planned.commandLine === verified.commandLine;
}

/**
 * Build the Windows kill plan for one recorded runner from an identity-bearing
 * process-table snapshot: the runner FIRST, then its whole `ppid` descendant
 * tree, minus every identity-matched broker pid and its descendant subtree
 * (the separately managed broker and its engine must survive as runner
 * descendants). A snapshotted process is excluded only when it holds a
 * recorded broker pid AND its snapshot command line matches that pid's
 * recorded launch signature; a reused pid holding a recorded broker number
 * with a foreign or unreadable command line is NEVER excluded. A malformed
 * exclusion entry (including one naming the runner itself) fails closed: only
 * the runner is planned, because an unprovable exclusion list proves no
 * descendant non-broker. The `excludeUnknown` marker reports a failed broker
 * lookup and fails closed the same way. Cycles in the snapshot (reused pids
 * recorded as their own ancestors) are safe: a visited set stops the walk.
 * Exported for contract tests; production callers reach it through
 * terminateRecordedProcessTree.
 * @param {number} pid @param {WindowsProcessSnapshot} snapshot @param {readonly WindowsBrokerExclusion[]} excludeBrokers @param {{excludeUnknown?: boolean}} [options]
 * @returns {number[]} kill targets in kill order, runner first.
 */
export function windowsDescendantKillTargets(pid, snapshot, excludeBrokers, options = {}) {
  // A lookup-failed marker selects the recorded pid alone even when the
  // exclusion list is empty: without a proven exclusion list no descendant can
  // be proven non-broker, so the walk is never planned.
  if (options.excludeUnknown === true) return [pid];
  const brokers = windowsExcludedBrokers(excludeBrokers, pid);
  if (brokers === null) return [pid];
  // Invert the identity records into parent→children adjacency for the walk.
  /** @type {Map<number, number[]>} */
  const children = new Map();
  for (const [current, identity] of snapshot) {
    if (identity.ppid === null) continue;
    const siblings = children.get(identity.ppid);
    if (siblings) siblings.push(current);
    else children.set(identity.ppid, [current]);
  }
  const pruned = new Set();
  const markPrunedSubtree = (/** @type {number} */ root) => {
    if (pruned.has(root)) return;
    pruned.add(root);
    for (const child of children.get(root) ?? []) markPrunedSubtree(child);
  };
  for (const broker of brokers) {
    const identity = snapshot.get(broker.pid);
    // An unproven or vanished pid excludes nothing: a mismatching or
    // unreadable command line proves the recorded instance no longer owns the
    // pid, and an absent pid is not alive in this snapshot at all.
    if (!identity || !commandLineMatchesBrokerLaunch(identity.commandLine, broker)) continue;
    markPrunedSubtree(broker.pid);
  }
  const targets = [pid];
  const seen = new Set([pid]);
  const walk = (/** @type {number} */ current) => {
    for (const child of children.get(current) ?? []) {
      if (seen.has(child) || pruned.has(child)) continue;
      seen.add(child);
      targets.push(child);
      walk(child);
    }
  };
  walk(pid);
  return targets;
}

/**
 * Sweep the SURVIVING descendants of one DEAD recorded runner root — the
 * terminal-obligation cleanup for a runner whose process-lifetime lease has
 * already RELEASED (the runner exited, possibly killed by an earlier pass that
 * then failed or timed out on a later descendant). A free lease means the
 * recorded pid is no longer proven to be the runner, so the root is NEVER a
 * sweep target; the sweep exists because Windows termination kills the runner
 * FIRST and its verified descendants after, so a budget spent or a dispatch
 * failed mid-sequence leaves verified non-broker descendants alive with no
 * live-lease duty left to re-arm them.
 *
 * ROOT SAFETY: the recorded pid must be proven NOT alive before anything is
 * walked — a dead root cannot have been reused by a live process. A recorded
 * pid that is STILL ALIVE under a released lease is indistinguishable from a
 * pid reused by an unrelated live process: that accepted residual reuse risk
 * (the same policy that forbids signalling a free lease) is reported as
 * `root-alive` and the caller settles per the pre-sweep convention — such a
 * pid is never signalled and never enumerated.
 *
 * Windows (the platform whose descendant enumeration survives a parent's
 * death): Win32_Process retains the ORIGINAL parent pid after a process dies —
 * no re-parenting — so the same identity-bearing snapshot walk used by
 * terminateRecordedProcessTree still finds the orphans. The sweep reuses
 * `windowsDescendantKillTargets` (identity-matched broker subtrees are pruned —
 * the separately managed broker and its engine must survive as runner
 * descendants) and the SAME double-snapshot identity policy: the plan is
 * intersected with a fresh revalidation snapshot inside one shared deadline,
 * and only targets present in BOTH snapshots with an unchanged parent pid and
 * command line are force-killed. One shared local deadline spans both
 * snapshots and every kill, mirroring terminateRecordedProcessTree. With a
 * DEAD root there is no runner-at-minimum fallback kill, so an unprovable
 * broker exclusion list (or the explicit lookup-failed marker) has nothing
 * safe to plan: the outcome is the INCOMPLETE report and the caller keeps its
 * cleanup duty pending instead of settling.
 *
 * POSIX: descendants of the detached runner stay addressable as its process
 * group after the leader's death, but POSIX cannot enumerate group members,
 * so the evidence is group-liveness only. A live group IS the surviving tree:
 * one group-addressed SIGKILL — the same single-dispatch, no-partial-sequence
 * primitive the POSIX branch of terminateRecordedProcessTree documents —
 * covers every member, and that dispatch is reported as `swept` (killed stays
 * empty: there are no per-target pids) with the duty PENDING. Only a later
 * pass whose group probe finds the group gone reports `clean` — the gone
 * group is the POSIX completed-clean evidence that discharges the cleanup
 * obligation. Coverage is identical to the Windows walk, only the reporting
 * granularity and the settle-on-next-pass honesty differ.
 *
 * `enumerateProcessTable` and `runProcessKill` default to the production
 * implementations and exist as test seams, mirroring the injectable
 * terminateRecordedProcessTree convention.
 * @param {number} pid @param {{
 *   timeoutMs?: number,
 *   excludeBrokers?: readonly WindowsBrokerExclusion[], excludeUnknown?: boolean,
 *   enumerateProcessTable?: (timeoutMs: number) => Promise<WindowsProcessSnapshot|null>,
 *   runProcessKill?: (command: string, args: readonly string[], options?: { timeoutMs?: number }) => Promise<BoundedProcessKillOutcome|void>,
 * }} [options]
 * @returns {Promise<{kind:'root-alive'}|{kind:'clean'}|{kind:'swept',killed:number[],pending:number[]}|{kind:'incomplete',pending:number[]}>}
 *   `root-alive` — the recorded pid is still alive under its released lease
 *   (accepted residual reuse risk; the sweep never walks it, and the caller
 *   keeps its duty pending). `clean` — a completed sweep found nothing to kill
 *   (Windows: the walk found no verified survivors; POSIX: the recorded
 *   process group is gone, the only completed-clean evidence that platform
 *   can express). `swept` — verified survivors were found and EVERY one was
 *   dispatched with delivery evidence (POSIX: the one group SIGKILL dispatch,
 *   with no per-target pids to report); the caller keeps its duty pending
 *   until a later `clean` pass proves the tree is gone. `incomplete` — a
 *   stage failed or the shared budget expired mid-sweep; `pending` names the
 *   verified survivors that were never signalled, and the caller keeps its
 *   duty pending.
 */
export async function sweepDeadRootDescendantTree(pid, options = {}) {
  // An unaddressable root has nothing to sweep: no pid, no descendants.
  if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: 'clean' };
  const alive = () => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'; }
  };
  // The dead-root proof FIRST: an alive pid under a released lease is the
  // accepted residual pid-reuse risk — never signalled, never walked.
  if (alive()) return { kind: 'root-alive' };
  if (process.platform === 'win32') {
    // ONE shared local deadline spans both process-table snapshots and every
    // taskkill invocation (mirroring terminateRecordedProcessTree): whichever
    // stage stalls, the sweep stays inside its own budget and reports honestly.
    // The default is the Windows tree budget, and each snapshot is bounded by
    // the remaining budget minus the kill reserve (see
    // WINDOWS_SNAPSHOT_KILL_RESERVE_MS, scaled down for small explicit budgets)
    // so a snapshot that cannot fit is skipped and the sweep reports
    // `incomplete` instead of burning the whole budget on one doomed
    // enumeration.
    const totalMs = Number.isSafeInteger(options.timeoutMs) && /** @type {number} */ (options.timeoutMs) >= 0 ? /** @type {number} */ (options.timeoutMs) : WINDOWS_TREE_TERMINATION_BUDGET_MS;
    const deadline = Date.now() + totalMs;
    const remaining = () => Math.max(0, deadline - Date.now());
    const snapshotReserveMs = Math.min(WINDOWS_SNAPSHOT_KILL_RESERVE_MS, Math.floor(totalMs / 2));
    const snapshotBudget = () => Math.max(0, remaining() - snapshotReserveMs);
    const takeSnapshot = async () => snapshotBudget() > 0 ? enumerateProcessTable(snapshotBudget()) : null;
    const runKill = typeof options.runProcessKill === 'function' ? options.runProcessKill : boundedProcessKill;
    const enumerateProcessTable = typeof options.enumerateProcessTable === 'function' ? options.enumerateProcessTable : readWindowsProcessTable;
    // Fail closed on an unprovable exclusion list BEFORE any snapshot: with a
    // dead root there is no pid-only fallback kill to degrade to, so a failed
    // broker lookup, a malformed entry, or an entry naming the (dead) root
    // leaves every descendant unproven and the walk unplanned — the caller's
    // duty stays pending rather than risking a broker or settling unproven.
    const excludeBrokers = windowsExcludedBrokers(options.excludeBrokers, pid);
    if (options.excludeUnknown === true || excludeBrokers === null) return { kind: 'incomplete', pending: [] };
    if (remaining() <= 0) return { kind: 'incomplete', pending: [] };
    // Snapshot one (the PLAN) inside the shared budget minus the kill reserve;
    // a snapshot that cannot fit is skipped (null → incomplete, honestly).
    const planSnapshot = await takeSnapshot();
    if (!planSnapshot) return { kind: 'incomplete', pending: [] };
    // The root is proven dead above and is never a sweep target: only its
    // surviving PPID descendants are planned.
    const planned = windowsDescendantKillTargets(pid, planSnapshot, excludeBrokers).filter((target) => target !== pid);
    if (planned.length === 0) return { kind: 'clean' };
    if (remaining() <= 0) return { kind: 'incomplete', pending: planned };
    // Snapshot two (the REVALIDATION), immediately before the kill sequence,
    // intersected under the same double-probe identity policy as
    // terminateRecordedProcessTree (see windowsProcessIdentityUnchanged) and
    // bounded by the same kill reserve.
    const verifySnapshot = await takeSnapshot();
    if (!verifySnapshot) return { kind: 'incomplete', pending: planned };
    const verified = planned.filter((target) => windowsProcessIdentityUnchanged(target, planSnapshot, verifySnapshot));
    if (verified.length === 0) return { kind: 'clean' };
    /** @type {number[]} */
    const killed = [];
    for (const target of verified) {
      if (remaining() <= 0) break;
      /** @type {BoundedProcessKillOutcome|void} */
      let dispatch;
      try {
        dispatch = await runKill('taskkill', ['/PID', String(target), '/F'], { timeoutMs: remaining() });
      } catch { break; }
      // Only a resolution with delivery evidence — or the already-gone
      // convention — counts as signalled (see killDispatchSucceeded).
      if (!killDispatchSucceeded(dispatch)) break;
      killed.push(target);
    }
    if (killed.length === verified.length) return { kind: 'swept', killed, pending: [] };
    return { kind: 'incomplete', pending: verified.slice(killed.length) };
  }
  // POSIX: the orphaned tree stays addressable as the runner's process group.
  // POSIX cannot ENUMERATE group members, so the honest evidence statement is
  // narrower than the Windows walk: a live group under this recorded identity
  // IS the surviving tree (at minimum an un-reaped zombie, at worst live
  // descendants), and a gone group proves nothing survives. Settlement is
  // tied to the GONE evidence: a pass whose group-addressed dispatch ran has
  // NOT proven the tree absent — it reports `swept` and the duty stays
  // pending; only a LATER pass whose group probe finds nothing alive reports
  // `clean`, which is what discharges the cleanup obligation.
  const groupAlive = () => {
    try { process.kill(-pid, 0); return true; }
    catch (error) { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'; }
  };
  if (groupAlive()) {
    // One group SIGKILL is the documented POSIX single-dispatch primitive: it
    // either kills every live member or they were already dead (a zombie holds
    // nothing and cannot keep the group alive past its reap). No partial
    // sequence is expressible, so — unlike the Windows per-target walk — there
    // are no per-target delivery pids to report: `killed` stays empty and the
    // not-throwing dispatch itself is the delivery evidence. The caller keeps
    // its duty pending; the next pass's gone-group probe is the settlement
    // evidence.
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* group gone */ } }
    return { kind: 'swept', killed: [], pending: [] };
  }
  return { kind: 'clean' };
}

// The snapshot is IDENTITY-BEARING: every row carries the pid, its recorded
// parent pid, and its creation-fixed CommandLine, emitted as ONE
// `ConvertTo-Json -Compress` object per line. JSON is delimiter-safe against
// command lines full of spaces and quotes (PowerShell escapes them into the
// string). ENCODING: `ConvertTo-Json` does not guarantee ASCII-only output on
// Windows PowerShell 5.1, and a `-Command` script's redirected stdout decodes
// through the ACTIVE CONSOLE CODE PAGE while this reader always decodes UTF-8
// — so the script's FIRST statement forces `[Console]::OutputEncoding` to
// UTF-8, before `Get-CimInstance` queries or `ConvertTo-Json` emits anything.
// Without it, a Node executable, plugin, or config path containing non-ASCII
// characters is garbled in flight, the broker's snapshotted command line no
// longer matches its recorded launch signature, and the managed broker lands
// in the force-kill plan instead of being spared — violating the
// broker-survival invariant (ADR 0021). A malformed or truncated row fails
// the ENTIRE snapshot closed (see the parser below).
const WINDOWS_PROCESS_TABLE_SCRIPT = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ErrorActionPreference = \'Stop\'; Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CommandLine | ForEach-Object { [pscustomobject]@{ ppid = [string]$_.ParentProcessId; pid = [string]$_.ProcessId; commandLine = $_.CommandLine } | ConvertTo-Json -Compress }';
const MAX_WINDOWS_PROCESS_TABLE_BYTES = 1024 * 1024;

/**
 * One bounded Windows process-table snapshot: every live process as an
 * identity record (recorded parent pid plus creation-fixed command line),
 * read through PowerShell Get-CimInstance. The identity columns are what let
 * the exclusion walk prove a snapshotted pid is still the recorded broker and
 * let the pre-kill revalidation prove a planned target never
 * exited-and-got-reused. The lightest reliable introspection available under
 * this repo's constraints (no native modules; wmic is deprecated off current
 * Windows). The table is parsed only after the child's piped stdout reaches
 * `close`: on Windows an `exit` event can fire before piped output has fully
 * drained, and a snapshot built from a partially drained stream would
 * silently omit live runner descendants from the kill plan. Any failure —
 * spawn error, non-zero exit, any single non-empty unparsable row (the ENTIRE
 * snapshot is rejected rather than returning a partial table with silently
 * omitted edges), a duplicated pid row, output overflow, or the bound
 * expiring — resolves NULL,
 * the caller's fail-closed signal: the kill plan degrades to the recorded pid
 * alone instead of guessing at the tree. `spawnProcessTableTool` defaults to
 * the production spawn and exists as a test seam so the drain ordering is
 * unit-drivable on any host platform, mirroring the injectable
 * enumerateProcessTable convention.
 * Exported for contract tests; production callers reach it through
 * terminateRecordedProcessTree.
 * @param {number} timeoutMs
 * @param {{ spawnProcessTableTool?: typeof spawn }} [options]
 * @returns {Promise<WindowsProcessSnapshot|null>}
 */
export async function readWindowsProcessTable(timeoutMs, options = {}) {
  if (!Number.isSafeInteger(timeoutMs) || /** @type {number} */ (timeoutMs) <= 0) return null;
  const spawnProcessTableTool = typeof options.spawnProcessTableTool === 'function' ? options.spawnProcessTableTool : spawn;
  const child = spawnProcessTableTool('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_TABLE_SCRIPT], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  // Like boundedProcessKill: the enumeration tool must never hold this
  // process's event loop open past its bound.
  child.unref?.();
  return await new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    /** @type {number|null} */
    let exitCode = null;
    let stdoutDrained = false;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    const finish = (/** @type {WindowsProcessSnapshot|null} */ value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      resolve(value);
    };
    timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish(null); }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (/** @type {string} */ chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_WINDOWS_PROCESS_TABLE_BYTES) { try { child.kill(); } catch { /* already gone */ } finish(null); }
    });
    const finishFromDrainedStdout = () => {
      if (settled || !stdoutDrained || exitCode !== 0) return;
      /** @type {WindowsProcessSnapshot} */
      const processTable = new Map();
      for (const line of stdout.split(/\r?\n/)) {
        // Only genuinely empty or whitespace-only lines are skippable. The
        // row format emits one JSON identity object per data row with no
        // header, so any NON-EMPTY row that fails to parse — or parses outside
        // the documented identity shape (digit-string pid/ppid, string-or-null
        // command line), or repeats a pid — is truncated or corrupt output:
        // skipping it would publish a PARTIAL table whose missing parent-child
        // edge strands a runner-owned descendant alive after cancellation.
        // Instead the ENTIRE snapshot is rejected — the documented fail-closed
        // null that callers degrade to the recorded pid-only kill on.
        if (line.trim().length === 0) continue;
        /** @type {unknown} */
        let row;
        try { row = JSON.parse(line); } catch { finish(null); return; }
        const record = /** @type {any} */ (row);
        if (!record || typeof record !== 'object' || Array.isArray(record)
          || typeof record.pid !== 'string' || !/^\d+$/u.test(record.pid)
          || typeof record.ppid !== 'string' || !/^\d+$/u.test(record.ppid)
          || record.commandLine !== null && typeof record.commandLine !== 'string') { finish(null); return; }
        const childPid = Number(record.pid);
        if (processTable.has(childPid)) { finish(null); return; }
        processTable.set(childPid, { ppid: Number(record.ppid), commandLine: /** @type {string|null} */ (record.commandLine) });
      }
      // A live Windows system always reports processes: empty output means
      // the snapshot is unusable, not that the OS has no processes.
      finish(processTable.size > 0 ? processTable : null);
    };
    // The piped stdout is fully drained only at `close` — the terminal stream
    // signal for this wiring (stderr is `ignore`, so no other piped stream can
    // hold the child open): the parse NEVER runs off the child's `exit` alone,
    // which Windows can deliver ahead of the flush, and it does not run off
    // the earlier readable `end` either. Whichever of `exit` and `close`
    // arrives first waits for the other; the overall bound above still
    // terminates a child that never drains.
    child.stdout?.once('close', () => { stdoutDrained = true; finishFromDrainedStdout(); });
    child.once('error', () => finish(null));
    child.once('exit', (/** @type {number|null} */ code) => {
      exitCode = code;
      if (code !== 0) return finish(null);
      finishFromDrainedStdout();
    });
  });
}

/**
 * One structured termination-tool dispatch outcome. `ok` is true only when the
 * dispatch carries EVIDENCE that the target needs no further signal — a clean
 * exit (0), or taskkill's already-gone convention (128: "the process not
 * found" — the target was already dead). Every other resolution FAILS the
 * dispatch with a `reason`: 'spawn-error' (the tool never launched),
 * 'timeout' (the tool was killed at its bound — whether the signal landed is
 * unknowable), or 'exit-code' (any other nonzero exit, such as taskkill's
 * access-denied, where the target may survive). `exitCode` carries the child's
 * exit code when one existed. Production dispatches only ever run `taskkill`
 * through this seam, so the exit-code conventions are taskkill's.
 * @typedef {{ ok: boolean, reason?: 'already-gone'|'spawn-error'|'timeout'|'exit-code', exitCode: number|null }} BoundedProcessKillOutcome
 */

/** Interpret one termination-tool exit code under taskkill's conventions:
 * 0 terminated the target; 128 reports the target NOT FOUND — already dead,
 * which still proves the pid gone and counts as dispatch success; ANY other
 * nonzero exit (typically 1, access denied) leaves the target's survival
 * unknown and fails the dispatch.
 * @param {number|null} code @returns {BoundedProcessKillOutcome} */
function killExitOutcome(code) {
  if (code === 0) return { ok: true, exitCode: 0 };
  if (code === 128) return { ok: true, reason: 'already-gone', exitCode: 128 };
  return { ok: false, reason: 'exit-code', exitCode: code };
}

/** Whether one kill-seam resolution carries evidence that the target needs no
 * further signal: the production `boundedProcessKill` resolves a structured
 * outcome (see BoundedProcessKillOutcome), while a VOID resolution — an
 * injectable seam stub of the legacy `Promise<void>` shape — keeps its
 * presumed-dispatched semantics. A REJECTING dispatch is handled separately by
 * the caller.
 * @param {BoundedProcessKillOutcome|void} result @returns {boolean} */
function killDispatchSucceeded(result) {
  if (result === undefined || result === null) return true;
  return result.ok === true;
}

/** Run one external termination command hard-bounded by `timeoutMs` (default
 * 1000ms): a stalled tool is killed and abandoned instead of being awaited
 * indefinitely. The command is deliberately NOT bound to any caller abort
 * signal — local process cleanup must complete even when the remote-control
 * budget that triggered it is already spent. The dispatch NEVER rejects and
 * never reports blind success: it resolves a structured outcome that
 * distinguishes a delivered kill (or an already-dead target) from a spawn
 * error, a stall killed at its bound, and any other nonzero exit, so callers
 * can count a target as signalled only on evidence. Exported for contract
 * tests; production callers reach it through terminateRecordedProcessTree.
 * @param {string} command @param {readonly string[]} args @param {{timeoutMs?:number}} [options]
 * @returns {Promise<BoundedProcessKillOutcome>} */
export async function boundedProcessKill(command, args, options = {}) {
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && /** @type {number} */ (options.timeoutMs) >= 0 ? /** @type {number} */ (options.timeoutMs) : 1_000;
  const child = spawn(command, args, { shell: false, windowsHide: true, stdio: 'ignore' });
  // The killed-on-timeout tool must never hold this process's event loop open:
  // unref it so a hung taskkill cannot extend a SessionEnd hook's lifetime.
  child.unref?.();
  return await new Promise((/** @type {(outcome: BoundedProcessKillOutcome) => void} */ resolve) => {
    /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
    const finish = (/** @type {BoundedProcessKillOutcome} */ outcome) => { clearTimeout(timer); resolve(outcome); };
    timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish({ ok: false, reason: 'timeout', exitCode: null }); }, timeoutMs);
    child.once('exit', (/** @type {number|null} */ code) => finish(killExitOutcome(code)));
    child.once('error', () => finish({ ok: false, reason: 'spawn-error', exitCode: null }));
  });
}

/** @param {import('node:child_process').ChildProcess} child @param {{ graceMs?: number }} [options] */
export async function terminateProcess(child, options = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const graceMs = options.graceMs ?? 1_000;
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T'], { shell: false, windowsHide: true, stdio: 'ignore' });
  } else if (child.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  } else child.kill('SIGTERM');
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), graceMs);
    timer.unref?.();
  });
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))), timeout,
  ]);
  clearTimeout(timer);
  if (!exited && child.exitCode === null) {
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    else child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

/** @param {unknown} launch */
function validateLaunch(launch) {
  /** @type {any} */
  const value = launch;
  if (!value || typeof value !== 'object' || typeof value.command !== 'string'
    || value.command.length === 0 || !Array.isArray(value.args)
    || !value.args.every((/** @type {unknown} */ arg) => typeof arg === 'string')
    || value.target !== undefined && typeof value.target !== 'string'
    || value.windowsShim !== undefined && typeof value.windowsShim !== 'boolean') throw processInputError();
}

/** @param {string} target @param {string[]} args */
function windowsShimCommand(target, args) { if (/["\r\n]/.test(target) || !args.every((arg) => /^[A-Za-z0-9._:/=-]+$/.test(arg))) throw processInputError(); return `"${target}"${args.map((arg) => ` "${arg}"`).join('')}`; }

function processInputError() {
  return new PluginError('PROCESS_INPUT_INVALID', 'Process launch input is invalid.', {
    category: 'validation', remedy: 'Provide a command and an array of literal argv strings.',
  });
}
