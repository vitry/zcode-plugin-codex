// @ts-nocheck
/**
 * Task 8 qualification: real-process handoff and crash races for the
 * session-bound true background Rescue.
 *
 * Every scenario runs REAL processes end to end — the probe fixture
 * (tests/fixtures/host-rescue-runner-probe.mjs) is a real Rescue Child parent
 * that performs the exact hook -> prepare -> invoke-prepared flow, the detached
 * runner is the real installed companion `run-host-rescue-job` child, the fake
 * ZCode broker is a real descendant process, and stop boundaries run through
 * real spawned cancel/SessionEnd processes. Durable records are polled with
 * bounded deadlines; no scenario infers detachment from a mocked `unref()`.
 *
 * Cleanup ownership: the tests capture only the child handles/PIDs and
 * temporary paths they created, and route every teardown step through ONE
 * ordered per-test hook that releases captured fake brokers, then terminates
 * captured runner/probe trees and awaits their exits, and only then removes
 * the fixture directory. No signal is ever sent to a production plugin
 * process or to an arbitrary recorded PID.
 *
 * Qualification scope (recorded honestly): by production design the runner's
 * termination scope contains ONLY the runner itself. The runner is spawned
 * detached and therefore leads its own POSIX process group, the managed
 * broker is spawned detached in its own group (scripts/lib/process.mjs) with
 * the engine as the broker's child, and no other long-lived children exist on
 * the runner path — so group-kill ≡ runner-kill plus any future in-group
 * descendants, and the broker/engine exclusion is structural, not incidental.
 * The group-kill semantics when an in-group descendant DOES survive are
 * unit-covered in tests/process-zcode.test.mjs. Node exposes no cross-process
 * setpgid, and production spawns no long-lived child on the runner path, so a
 * POSIX in-group runner descendant cannot exist without a test-only
 * production hook — the POSIX evidence chain is therefore: structural
 * group-leader assertions (runner/broker/engine each their own group) +
 * unit-level descendant group-kill coverage (tests/process-zcode.test.mjs).
 * On Windows there are no POSIX process groups: production
 * terminateRecordedProcessTree walks the recorded runner's PPID descendant
 * tree there and force-kills the runner plus every descendant EXCEPT the
 * separately managed broker subtree — the writable-Rescue settlement resolves
 * the broker identity pids from the workspace's durable broker identities and
 * forwards them as the termination exclusion (scripts/lib/process.mjs,
 * scripts/lib/job-control.mjs). A bounded process-table snapshot builds the
 * walk; when it is unavailable the branch fails closed to the recorded pid
 * alone so an unproven descendant is never risked as a broker. The runner has
 * no other long-lived children by design, and the broker-survives verdicts in
 * tests 6-8 are cross-platform production guarantees, not POSIX-only ones.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { createHostLifecycleStore, hostLifecycleEpoch } from '../../scripts/lib/host-lifecycle.mjs';
import { withFileLock } from '../../scripts/lib/fs.mjs';
import { createStateStore } from '../../scripts/lib/state.mjs';
import { resolveWorkspaceStorage } from '../../scripts/lib/workspace.mjs';
import { createIdentityStore } from '../../scripts/lib/identity.mjs';
import { resolveRecordedSessionStart } from '../../hooks/lib/hook-state.mjs';
import { runChild } from '../helpers/run-child.mjs';
import { scaleTestTimeout } from '../helpers/test-timeouts.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(root, 'scripts', 'zcode-companion.mjs');
const fakeZCode = join(root, 'tests', 'fixtures', 'fake-zcode-cli.mjs');
const fakeCodex = join(root, 'tests', 'fixtures', 'fake-codex-app-server.mjs');
const probeFixture = join(root, 'tests', 'fixtures', 'host-rescue-runner-probe.mjs');
const OWNER_SESSION = 'true-background-owner';
const OWNER_CHILD = 'true-background-child';
const TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled'];
const BOUNDARYLESS_DELAY_MS = 1_500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const execFile = promisify(execFileCallback);

/**
 * Control-flow signal for `until`: a predicate has PROVEN a fatal outcome —
 * the probe published a setup or hook failure report — so the wait must end
 * immediately instead of retrying to the deadline. Absent, partially
 * written, or corrupt files remain transient read failures and stay retried.
 */
class FatalReportError extends Error {}

/** Bounded deadline poll: every wait fails the test instead of hanging. An
 * optional `act` runs one bounded convergence action after every unsuccessful
 * predicate attempt (a real retry pass), so deferred-semantics waits drive
 * their own next pass instead of relying on wall-clock luck. */
async function until(predicate, message, timeoutMs = 20_000, intervalMs = 25, act = null) {
  const scaled = scaleTestTimeout(timeoutMs);
  const deadline = Date.now() + scaled;
  let lastError;
  for (;;) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      // A fatal report is a proven outcome, never a transient read failure:
      // propagate it immediately instead of stalling to the deadline.
      if (error instanceof FatalReportError) throw error;
      lastError = error;
    }
    if (Date.now() > deadline) {
      assert.fail(`${message} (waited ${scaled}ms)${lastError === undefined ? '' : `; last error: ${String(lastError).slice(0, 300)}`}`);
    }
    if (act) await act().catch(() => {});
    await sleep(intervalMs);
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/** Bounded wait for one captured process to exit. */
async function waitForExit(pid, message, timeoutMs = 10_000) {
  await until(() => !pidAlive(pid), message, timeoutMs, 50);
}

/** Best-effort termination of one captured detached process tree (test-created only). */
async function terminateCapturedTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !pidAlive(pid)) return;
  const kill = async () => {
    if (process.platform === 'win32') {
      try { process.kill(pid); } catch { /* already exited */ }
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
  };
  await kill();
  // A Windows TerminateProcess can be delivered lazily on a loaded runner, and
  // the killed process keeps the repo's fs-native-extensions .node loaded
  // until it really exits — so the bounded wait RE-ISSUES the kill every pass
  // (the `act` convergence hook) and only gives up after the full bound, never
  // after the first dispatch.
  await until(() => !pidAlive(pid), `captured process ${pid} must exit after termination`, 5_000, 50, kill).catch(() => {});
}

/** Await exits, then remove only this test's own fixture directory. */
async function cleanupFixture(directory) {
  const delays = process.platform === 'win32' ? [100, 250, 500, 1_000] : [0];
  let lastError;
  for (const delay of delays) {
    if (delay) await sleep(delay);
    try {
      await rm(directory, { force: true, recursive: true });
      return;
    } catch (error) {
      if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * The ONE ordered teardown hook per test. Node runs `t.after()` hooks in
 * registration order, so a directly registered fixture-directory removal
 * would run before the later process-cleanup hooks and race processes whose
 * cwd IS that directory (EBUSY/EPERM on Windows, live-state removal on
 * POSIX). Every cleanup step a test captures is routed here instead and runs
 * in the fixed cleanup-contract order: (a) release captured fake brokers,
 * (b) terminate captured runner/probe trees and await their exits, and only
 * then (c) remove the fixture directory.
 */
function createOrderedTeardown(t, directory) {
  /** @type {Array<() => Promise<void>>} */
  const releaseBrokers = [];
  /** @type {Array<() => Promise<void>>} */
  const terminateTrees = [];
  t.after(async () => {
    for (const release of releaseBrokers) await release();
    for (const terminate of terminateTrees) await terminate();
    await cleanupFixture(directory);
  });
  return {
    /** Release a captured fake broker FIRST; pass a getter for one assigned later in the test. */
    broker(getBroker) { releaseBrokers.push(() => releaseCapturedBroker(typeof getBroker === 'function' ? getBroker() : getBroker)); },
    /** Terminate one captured process tree (probe, runner, bystander) and await its exit BEFORE the directory removal. */
    tree(terminate) { terminateTrees.push(terminate); },
  };
}

/** Isolated workspace + plugin data root fixture. Its directory is removed by the test's single ordered teardown hook, after all captured processes have exited. */
async function fixture(t, extraEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-true-background-'));
  const teardown = createOrderedTeardown(t, directory);
  const workspace = join(directory, 'repo');
  const dataRoot = join(directory, 'data');
  await mkdir(workspace, { recursive: true });
  const canonicalWorkspace = realpathSync.native(workspace);
  const env = {
    ...process.env,
    ZCODE_DATA_ROOT: dataRoot,
    PLUGIN_DATA: dataRoot,
    PLUGIN_ROOT: root,
    ZCODE_PATH: fakeZCode,
    CODEX_APP_SERVER_PATH: process.execPath,
    CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([fakeCodex]),
    ...extraEnv,
  };
  return { directory, dataRoot, env, canonicalWorkspace, store: createStateStore({ dataRoot }), teardown };
}

/**
 * The fake-engine completion gate: block the turn's completion notification at
 * the engine while the runner stays alive mid-turn, and release it later.
 */
function completionGate(ctx) {
  const gatePath = join(ctx.directory, 'completion-gate.txt');
  const reachedPath = join(ctx.directory, 'completion-gate-reached.txt');
  ctx.env.FAKE_ZCODE_COMPLETION_GATE = gatePath;
  ctx.env.FAKE_ZCODE_COMPLETION_GATE_REACHED = reachedPath;
  return {
    async block() { await writeFile(gatePath, 'block'); },
    async release() { await writeFile(gatePath, 'release'); },
  };
}

/**
 * The fake-engine session/create gate: hold the broker's create response
 * while the runner stays claimed-and-queued, and release it only when the
 * test writes `release` (a killed runner's gate simply never releases; the
 * captured broker is torn down by the ordered cleanup). `reached()` proves
 * the held state: once it resolves, the create request has arrived at the
 * engine and is PROVABLY unanswered, so a claimed-queued kill window is an
 * explicit barrier instead of a wall-clock delay that a slow CI worker can
 * outrun.
 */
function sessionCreateGate(ctx) {
  const gatePath = join(ctx.directory, 'create-gate.txt');
  const reachedPath = join(ctx.directory, 'create-gate-reached.txt');
  ctx.env.FAKE_ZCODE_CREATE_GATE = gatePath;
  ctx.env.FAKE_ZCODE_CREATE_GATE_REACHED = reachedPath;
  return {
    reached: () => until(async () => (await readFile(reachedPath, 'utf8').catch(() => '')) === 'held', 'the fake engine must be holding the session/create response'),
  };
}

/**
 * Spawn the real Rescue Child probe. Returns the live child handle, its exit
 * promise, and a bounded promise for the probe's JSON handle report. The
 * report promise rejects EARLY — at the first published failure, not at the
 * deadline — when the probe publishes an error and errors are not expected;
 * absent, partially written, or corrupt files stay transient and retried.
 *
 * `options.preClaimBarrier` ({ lock, release, released }) arms a deterministic
 * pre-claim barrier: the probe holds the workspace job-state lock from
 * strictly BEFORE the runner exists until the test writes `release`, so the
 * runner cannot read or claim the job while the fence is held.
 */
function spawnProbe(t, ctx, options) {
  const reportPath = join(ctx.directory, `probe-${options.reportName ?? Math.random().toString(36).slice(2)}.json`);
  const ackPath = options.ackReport ? join(ctx.directory, `probe-ack-${options.reportName ?? Math.random().toString(36).slice(2)}.json`) : null;
  const probeArgs = [
    probeFixture,
    '--workspace', ctx.canonicalWorkspace,
    '--session-id', options.sessionId ?? OWNER_SESSION,
    '--child-id', options.childId ?? OWNER_CHILD,
    '--turn-id', options.turnId,
    '--task', options.task,
    '--placement', options.placement,
    '--resume', options.resume,
    '--permission-mode', options.permissionMode ?? 'acceptEdits',
    '--report', reportPath,
    ...(ackPath ? ['--ack-report', ackPath] : []),
    ...(options.sessionSource === undefined ? [] : ['--session-source', options.sessionSource]),
    ...(options.hold ? ['--hold', 'true'] : []),
    ...(options.preClaimBarrier === undefined ? [] : [
      '--barrier-lock', options.preClaimBarrier.lock,
      '--barrier-release', options.preClaimBarrier.release,
      '--barrier-released', options.preClaimBarrier.released,
    ]),
  ];
  const probe = spawn(process.execPath, probeArgs, {
    cwd: ctx.canonicalWorkspace, env: ctx.env, stdio: ['ignore', 'ignore', 'pipe'], shell: false,
  });
  let stderr = '';
  probe.stderr?.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => probe.once('exit', (code, signal) => resolve({ code, signal })));
  // Ordered teardown, phase (b): the probe's cwd is the fixture workspace, so
  // it must be terminated and awaited BEFORE the fixture directory is removed.
  ctx.teardown.tree(async () => {
    if (pidAlive(probe.pid)) try { probe.kill('SIGKILL'); } catch { /* exited */ }
    await Promise.race([exited, sleep(2_000)]);
  });
  const readReport = () => readFile(reportPath, 'utf8').then(JSON.parse);
  /** A published probe error is FATAL (setup or hook failure): raise it out of `until` immediately. */
  const fatalReport = async () => {
    const value = await readReport().catch(() => null);
    if (value?.error && options.allowError !== true) throw new FatalReportError(`probe failed: ${JSON.stringify(value.error)}`);
    return value;
  };
  const report = until(fatalReport, `the probe never published its ${options.reportName ?? 'default'} report; stderr: ${stderr.slice(0, 400)}`, 60_000, 10);
  // The parent's own receipt of the prepared invocation: for a background
  // placement this is the real queued acknowledgement, published the moment
  // invoke-prepared returned it to the still-live Rescue Child parent. A fatal
  // probe report ends this wait immediately too: the acknowledgement can never
  // arrive once the parent has failed.
  const ack = ackPath === null ? null : until(async () => {
    await fatalReport();
    const value = await readFile(ackPath, 'utf8').then(JSON.parse).catch(() => null);
    return value?.type === 'background' && value?.job?.status === 'queued' ? value : null;
  }, 'the probe parent never published its queued acknowledgement', 60_000, 10);
  return { probe, exited, report, readReport, reportPath, ack, ackPath, stderrText: () => stderr };
}

/** Spawn the probe and wait only for the synchronous runner spawn-seam report. */
async function spawnProbeUntilRunner(t, ctx, options) {
  const spawned = spawnProbe(t, ctx, options);
  const early = await spawned.report;
  assert.ok(Number.isSafeInteger(early.runnerPid) && early.runnerPid > 0, 'the probe must publish the detached runner pid from the spawn seam');
  assert.ok(/^[a-f0-9]{64}$/u.test(early.jobId ?? ''), 'the spawn seam must publish the exact job id');
  return { ...spawned, runnerPid: early.runnerPid, jobId: early.jobId };
}

/** A real management-command companion process (protected fd3 caller, fd4 JSON response). */
function companionChild(ctx, argv, caller) {
  return runChild(process.execPath, [cli, ...argv], {
    cwd: ctx.canonicalWorkspace, env: ctx.env,
    input: { callerContext: caller }, protectedInput: true,
    timeoutMs: scaleTestTimeout(90_000),
  }).then((result) => {
    let json = null;
    try { json = JSON.parse(result.internal); } catch { try { json = JSON.parse(result.stdout); } catch { /* non-JSON output */ } }
    return { ...result, json };
  });
}

/** A real hook process. */
function hookChild(ctx, script, input) {
  return runChild(process.execPath, [join(root, 'hooks', script)], {
    cwd: ctx.canonicalWorkspace, env: ctx.env, ordinaryInput: true, input,
    timeoutMs: scaleTestTimeout(30_000),
  });
}

/** The owner session's recorded lifecycle epoch (proven by the real SessionStart hook). */
async function recordedEpoch(ctx, sessionId = OWNER_SESSION) {
  const startedAt = (await resolveRecordedSessionStart(ctx.dataRoot, ctx.canonicalWorkspace, sessionId)).startedAt;
  return hostLifecycleEpoch(sessionId, startedAt);
}

/** The caller-context token for real management commands against the owner session's active turn. */
async function ownerCaller(ctx, turnId, permissionMode = 'acceptEdits') {
  return createIdentityStore({ dataRoot: ctx.dataRoot }).createCallerContext({
    sessionId: OWNER_SESSION, turnId, workspace: ctx.canonicalWorkspace, permissionMode,
  });
}

/**
 * Hold the workspace job-state lock from the test process until released.
 * The helper returns only AFTER the advisory lock is provably held:
 * `withFileLock` performs several asynchronous filesystem operations before
 * acquiring the lock and runs its callback only once acquisition succeeded,
 * so the acquisition handshake resolves as the FIRST statement of that
 * callback (the same deferred gate as the probe fixture's pre-claim barrier)
 * and is awaited before the helper returns. Racing `done` only converts a
 * pre-acquisition lock failure into a thrown error instead of a hang; the
 * callback stays pending on `released`, so `release()` lets `withFileLock`
 * unlock and exit cleanly and `done` confirms that release.
 */
async function holdStateLock(ctx) {
  const storage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.canonicalWorkspace });
  let signalAcquired;
  const acquired = new Promise((resolve) => { signalAcquired = resolve; });
  let releaseLock;
  const released = new Promise((resolve) => { releaseLock = resolve; });
  const done = withFileLock(join(storage.directory, '.state.lock'), async () => {
    signalAcquired();
    await released;
  });
  done.catch(() => {});
  await Promise.race([acquired, done]);
  return { release: () => releaseLock(), done };
}

/** The durable job record for one exact job id. */
function readJob(ctx, jobId) {
  return ctx.store.readJob(ctx.canonicalWorkspace, jobId);
}

/**
 * The durable job record read WITHOUT the workspace state lock, for
 * observations made while that lock is held by a fixture (the pre-claim
 * barrier holds it in the probe process; the store's own read would contend
 * with any held lock).
 */
async function readJobRaw(ctx, jobId) {
  const storage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.canonicalWorkspace });
  return JSON.parse(await readFile(join(storage.directory, 'jobs', `${jobId}.json`), 'utf8'));
}

/**
 * A captured broker process must not live in the runner's POSIX process group:
 * that is the direct identity proof that the runner-tree termination cannot
 * kill the separately managed broker as a descendant. Windows has no POSIX
 * process groups; the cross-platform aliveness checks still apply there.
 */
async function assertNotInRunnerProcessGroup(pid, runnerPid) {
  if (process.platform === 'win32') return;
  const { stdout } = await execFile('ps', ['-o', 'pgid=', '-p', String(pid)]);
  const pgid = Number.parseInt(stdout.trim(), 10);
  assert.ok(Number.isSafeInteger(pgid) && pgid > 0, `ps must report a process group for captured pid ${pid}`);
  assert.notEqual(pgid, runnerPid, `the captured pid ${pid} must not be in the runner ${runnerPid}'s process group`);
}

/**
 * Structural identity of the runner's termination scope: the runner IS its own
 * POSIX process-group leader (pgid === pid), so the tree kill targets exactly
 * the runner plus any future in-group descendants — by construction, not by
 * incidental exclusion. Production design keeps that group to the runner
 * alone: the managed broker is spawned detached in its own group
 * (scripts/lib/process.mjs) and the engine lives under the broker, so the
 * broker/engine exclusion is structurally guaranteed; group-kill semantics
 * with a surviving in-group descendant are unit-covered in
 * tests/process-zcode.test.mjs.
 */
async function assertRunnerLeadsOwnProcessGroup(runnerPid) {
  if (process.platform === 'win32') return;
  assert.equal(pidAlive(runnerPid), true, `the runner ${runnerPid} must be alive for its group-leader identity check`);
  const { stdout } = await execFile('ps', ['-o', 'pgid=', '-p', String(runnerPid)]);
  const pgid = Number.parseInt(stdout.trim(), 10);
  assert.ok(Number.isSafeInteger(pgid) && pgid > 0, `ps must report a process group for the runner pid ${runnerPid}`);
  assert.equal(pgid, runnerPid, `the runner ${runnerPid} must lead its own process group (termination group == runner by construction)`);
}

/** The fake ZCode request lines recorded for one fixture. */
async function recordedRequests(recordPath) {
  const contents = await readFile(recordPath, 'utf8').catch(() => '');
  return contents.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function countRequests(recordPath, method) {
  return (await recordedRequests(recordPath)).filter((request) => request.method === method).length;
}

/** The fake engine publishes its real pid at startup — the managed broker identity. */
async function readBrokerIdentity(ctx, timeoutMs = 30_000) {
  const processFile = ctx.env.FAKE_ZCODE_PROCESS_FILE;
  const identity = await until(async () => {
    const value = await readFile(processFile, 'utf8').then(JSON.parse).catch(() => null);
    return Number.isSafeInteger(value?.pid) && Number.isSafeInteger(value?.ppid) ? value : null;
  }, 'the fake ZCode broker must publish its real process identity', timeoutMs, 25);
  return { processFile, fakePid: identity.pid, daemonPid: identity.ppid };
}

/** The captured broker (daemon + engine) must still be alive. */
function assertBrokerAlive(broker) {
  assert.equal(pidAlive(broker.fakePid), true, `the managed broker engine ${broker.fakePid} must not be killed`);
  assert.equal(pidAlive(broker.daemonPid), true, `the managed broker daemon ${broker.daemonPid} must not be killed`);
}

/** Release a captured fake broker and await its exit (test-created process only). */
async function releaseCapturedBroker(broker) {
  for (const pid of [broker?.daemonPid, broker?.fakePid]) {
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    const kill = async () => {
      if (process.platform === 'win32') { try { process.kill(pid); } catch { /* gone */ } return; }
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    };
    if (!pidAlive(pid)) continue;
    await kill();
    // Same Windows discipline as terminateCapturedTree: the bounded wait
    // re-issues the kill each pass until the captured pair PROVABLY exits, so
    // a lazily delivered termination cannot leave the native module loaded
    // past the teardown bound.
    await until(() => !pidAlive(pid), `captured broker process ${pid} must exit`, 5_000, 50, kill).catch(() => {});
  }
}

/** The default background probe options for the owner session. */
function backgroundProbe(options = {}) {
  return {
    turnId: 'turn-background', task: 'true background rescue private task',
    placement: 'background', resume: 'fresh', ...options,
  };
}

test('a hard Rescue Child parent death after queued leaves the detached runner publishing progress and terminal output', {
  timeout: scaleTestTimeout(240_000),
}, async (t) => {
  // The engine delays every request, so the runner's turn stays pre-boundary
  // until well after the parent death below: the accepted boundary, the durable
  // progress, and the terminal result all require delayed engine responses and
  // are therefore provably published after the parent was killed.
  const ctx = await fixture(t, { FAKE_ZCODE_DELAY_MS: '2000' });
  const gate = completionGate(ctx);
  await gate.block();
  ctx.env.FAKE_ZCODE_PROGRESS = '1';
  ctx.env.FAKE_ZCODE_PROCESS_FILE = join(ctx.directory, 'fake-zcode-process.json');
  const recordPath = join(ctx.directory, 'fake-zcode-requests.jsonl');
  ctx.env.FAKE_ZCODE_RECORD = recordPath;
  await writeFile(recordPath, '');

  // The runner's PARENT is the probe process itself. It first RECEIVES the real
  // queued acknowledgement — invoke-prepared returns the bounded background
  // receipt to the live Rescue Child parent — and only then is the parent
  // killed for real, long before the gated runner can complete.
  const { probe, exited, runnerPid, jobId, ack } = await spawnProbeUntilRunner(t, ctx, { ...backgroundProbe(), hold: true, reportName: 'spawn', ackReport: true });
  ctx.teardown.tree(() => terminateCapturedTree(runnerPid));
  // The runner spawns its separately managed broker pair before any engine
  // request, and neither the parent death nor the runner-tree kill below can
  // release it — this test captures it as soon as its identity is published
  // and owns its release before the fixture directory is removed.
  const broker = await readBrokerIdentity(ctx);
  ctx.teardown.broker(() => broker);
  const queuedAck = await ack;
  assert.equal(queuedAck.job?.id, jobId, 'the queued acknowledgement names the exact reserved job');
  const parentKilledAt = Date.now();
  probe.kill('SIGKILL');
  const exit = await Promise.race([exited, sleep(5_000).then(() => null)]);
  assert.ok(exit, 'the probe parent must actually die');
  assert.equal(pidAlive(probe.pid), false, 'the test parent (Rescue Child) is terminated for real');
  const atParentDeath = await readJob(ctx, jobId);
  assert.equal(atParentDeath.status, 'queued', 'the engine delay holds the runner pre-boundary through the parent death');

  // The detached runner survives its parent's death and publishes its claim,
  // the accepted boundary, durable progress, and (after the test releases the
  // gated completion) the exact job's terminal result — all observed from this
  // process through the durable records only.
  const claimed = await until(async () => {
    const job = await readJob(ctx, jobId);
    return job.status === 'queued' && job.childPid === runnerPid && job.workerLeaseId ? job : null;
  }, 'the surviving detached runner must claim the job after its parent died');
  assert.equal(claimed.rescueRunnerVersion, 1, 'the marker rides with the claimed job');
  const boundary = await until(async () => {
    const job = await readJob(ctx, jobId);
    return job.status === 'running' && job.inputId ? job : null;
  }, 'the surviving runner must publish running plus the accepted-turn boundary');
  const progress = await until(async () => {
    const job = await readJob(ctx, jobId);
    return Array.isArray(job.progressPreview) && job.progressPreview.length > 0 ? job.progressPreview : null;
  }, 'the surviving runner must publish durable progress after the parent died');
  assert.equal(boundary.id, jobId);
  assert.ok(progress.length > 0);
  assert.ok(Date.now() > parentKilledAt, 'all runner publications happen after the parent death');
  assert.equal(await countRequests(recordPath, 'session/send'), 1, 'exactly one send runs for the orphaned job');

  await gate.release();
  const terminal = await until(async () => {
    const job = await readJob(ctx, jobId);
    return TERMINAL_STATUSES.includes(job.status) ? job : null;
  }, 'the surviving runner must publish the terminal winner on its own');
  assert.equal(terminal.status, 'succeeded', `the runner must complete the task; error: ${JSON.stringify(terminal.error ?? null)}`);
  assert.equal(terminal.rescueExecutionInput, undefined, 'the private input is removed on running');
  assert.equal(terminal.rescueRunnerVersion, 1, 'the marker persists through the terminal record');
  assert.equal(terminal.childPid, runnerPid);
  const caller = await ownerCaller(ctx, 'turn-background');
  const result = await companionChild(ctx, ['result', jobId], caller);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json?.job?.id, jobId);
  assert.match(String(result.json?.result ?? ''), /done/u);
  await waitForExit(runnerPid, 'the runner must exit by itself after terminal publication', 15_000);
});

test('killing the runner before its claim retains the queued job with no send and no automatic relaunch', {
  timeout: scaleTestTimeout(120_000),
}, async (t) => {
  const ctx = await fixture(t);
  const recordPath = join(ctx.directory, 'fake-zcode-requests.jsonl');
  ctx.env.FAKE_ZCODE_RECORD = recordPath;
  await writeFile(recordPath, '');

  // Deterministic pre-claim barrier (the contract promises no ordering between
  // acknowledgement and claim without one): the probe acquires the workspace
  // job-state lock strictly BEFORE the runner exists — the reservation is
  // already published at that point, so the fence needs no state writes — and
  // holds it until this test writes the release file. The freshly spawned
  // runner therefore cannot even read the job, let alone claim it, while the
  // fence is held.
  const storage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.canonicalWorkspace });
  const barrier = {
    lock: join(storage.directory, '.state.lock'),
    release: join(ctx.directory, 'pre-claim-barrier.release'),
    released: join(ctx.directory, 'pre-claim-barrier.released'),
  };
  const { runnerPid, jobId } = await spawnProbeUntilRunner(t, ctx, backgroundProbe({ reportName: 'spawn', preClaimBarrier: barrier }));
  ctx.teardown.tree(() => terminateCapturedTree(runnerPid));
  try {
    // The fence is held: a claim is impossible, so this observation is not a
    // race — the runner never had a window in which to publish one.
    const preClaim = await readJobRaw(ctx, jobId);
    assert.equal(preClaim.status, 'queued');
    assert.equal(preClaim.childPid, undefined, 'the pre-claim runner must not have published its claim yet');
  } finally {
    try { process.kill(runnerPid, 'SIGKILL'); } catch { /* already gone */ }
    await waitForExit(runnerPid, 'the pre-claim runner must die from the test kill', 10_000);
    await writeFile(barrier.release, 'release');
    await until(() => readFile(barrier.released, 'utf8').then((value) => value === 'released' || null).catch(() => null),
      'the pre-claim barrier must be released after the runner died', 10_000, 10);
  }

  // No conclusive evidence exists: the job stays queued, unclaimed, and nothing
  // may relaunch or send for it — including a real recovery command.
  const status = await companionChild(ctx, ['status', jobId], await ownerCaller(ctx, 'turn-background'));
  assert.equal(status.code, 0, status.stderr);
  const retained = await readJob(ctx, jobId);
  assert.equal(retained.status, 'queued', 'hard pre-claim death retains the queued reservation');
  assert.equal(retained.childPid, undefined);
  assert.equal(retained.workerLeaseId === undefined || retained.workerLeaseId === null, true);
  assert.equal(retained.rescueExecutionInput === undefined, false, 'the private input stays for the still-runnable queued job');
  assert.equal(retained.rescueRunnerVersion, 1);
  assert.equal(await countRequests(recordPath, 'session/create'), 0);
  assert.equal(await countRequests(recordPath, 'session/send'), 0);
  await sleep(scaleTestTimeout(1_500));
  const stillRetained = await readJob(ctx, jobId);
  assert.equal(stillRetained.status, 'queued', 'the job is never automatically relaunched or age-failed');
  assert.equal(await countRequests(recordPath, 'session/send'), 0);
});

test('killing a claimed runner before its running publication leaves a recovery-eligible orphan', {
  timeout: scaleTestTimeout(120_000),
}, async (t) => {
  const ctx = await fixture(t);
  const createGate = sessionCreateGate(ctx);
  ctx.env.FAKE_ZCODE_PROCESS_FILE = join(ctx.directory, 'fake-zcode-process.json');
  const recordPath = join(ctx.directory, 'fake-zcode-requests.jsonl');
  ctx.env.FAKE_ZCODE_RECORD = recordPath;
  await writeFile(recordPath, '');

  const { runnerPid, jobId } = await spawnProbeUntilRunner(t, ctx, backgroundProbe({ reportName: 'spawn' }));
  ctx.teardown.tree(() => terminateCapturedTree(runnerPid));
  // The runner's separately managed broker pair must be captured for release:
  // the tree kill below cannot touch it, so this test owns its teardown.
  const broker = await readBrokerIdentity(ctx);
  ctx.teardown.broker(() => broker);
  // Deterministic claim window: the fake engine holds the session/create
  // response, so the claimed job PROVABLY cannot reach its running publication
  // before the kill — an explicit barrier, not a wall-clock delay a slow CI
  // worker could outrun.
  await until(async () => {
    const job = await readJob(ctx, jobId);
    return job.status === 'queued' && job.workerLeaseId ? job : null;
  }, 'the runner must publish its exact claim first');
  await createGate.reached();
  process.kill(runnerPid, 'SIGKILL');
  await waitForExit(runnerPid, 'the claimed runner must die before running', 10_000);
  const orphan = await readJob(ctx, jobId);
  assert.equal(orphan.status, 'queued');
  assert.ok(orphan.workerLeaseId, 'the claim stays published');
  assert.equal(orphan.childPid, runnerPid);

  // A real management command drives the existing generic recovery: the dead
  // claimant's lease is free, so the orphan is recovery-eligible pre-start
  // failure settlement for a fresh job.
  const status = await companionChild(ctx, ['status', jobId], await ownerCaller(ctx, 'turn-background'));
  assert.equal(status.code, 0, status.stderr);
  const settled = await until(async () => {
    const job = await readJob(ctx, jobId);
    return TERMINAL_STATUSES.includes(job.status) ? job : null;
  }, 'the proven orphan claim must be settled by the real recovery path');
  assert.equal(settled.status, 'failed', 'a fresh claimed orphan fails through the pre-start failure policy');
  assert.equal(settled.rescueExecutionInput, undefined, 'the private input is removed with the terminal publication');
  assert.equal(settled.rescueRunnerVersion, 1, 'the marker is retained');
  assert.equal(settled.zcodeSessionId, undefined, 'the job never reached a remote session');
  assert.equal(settled.startedAt, undefined, 'the job never began execution');
  assert.equal(await countRequests(recordPath, 'session/send'), 0, 'no send ever runs for the orphan');
});

test('a runner killed after its accepted boundary recovers the exact result through real Status without a second send', {
  timeout: scaleTestTimeout(240_000),
}, async (t) => {
  const ctx = await fixture(t);
  const gate = completionGate(ctx);
  await gate.block();
  ctx.env.FAKE_ZCODE_PROCESS_FILE = join(ctx.directory, 'fake-zcode-process.json');
  const recordPath = join(ctx.directory, 'fake-zcode-requests.jsonl');
  ctx.env.FAKE_ZCODE_RECORD = recordPath;
  await writeFile(recordPath, '');

  const { runnerPid, jobId } = await spawnProbeUntilRunner(t, ctx, backgroundProbe({ reportName: 'spawn' }));
  ctx.teardown.tree(() => terminateCapturedTree(runnerPid));
  const broker = await readBrokerIdentity(ctx);
  ctx.teardown.broker(() => broker);
  const boundary = await until(async () => {
    const job = await readJob(ctx, jobId);
    return job.status === 'running' && job.inputId && job.zcodeSessionId ? job : null;
  }, 'the runner must publish the durable accepted boundary first');
  const boundarySession = boundary.zcodeSessionId;
  assert.equal(await countRequests(recordPath, 'session/send'), 1);
  // Kill the worker after the exact boundary is durable while the remote turn
  // is still active (the completion gate holds the fake).
  process.kill(runnerPid, 'SIGKILL');
  await waitForExit(runnerPid, 'the runner must die after its boundary', 10_000);

  // Release the gate so the REMOTE turn completes; the orphaned job must then
  // recover the same job's exact terminal result through a real Status
  // observation, with no second send and no new session.
  await gate.release();
  const caller = await ownerCaller(ctx, 'turn-background');
  const status = await companionChild(ctx, ['status', jobId, '--wait', '--timeout-ms', '20000'], caller);
  assert.equal(status.code, 0, status.stderr);
  const recovered = await readJob(ctx, jobId);
  assert.equal(recovered.status, 'succeeded', `Status recovery must publish the exact result; error: ${JSON.stringify(recovered.error ?? null)}`);
  assert.equal(recovered.id, jobId, 'the recovery publishes the same job');
  assert.equal(recovered.zcodeSessionId, boundarySession, 'the recovery keeps the exact accepted session');
  const result = await companionChild(ctx, ['result', jobId], caller);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json?.job?.id, jobId);
  assert.match(String(result.json?.result ?? ''), /done/u);
  const requests = await recordedRequests(recordPath);
  assert.equal(requests.filter((request) => request.method === 'session/send').length, 1, 'never a second send');
  assert.equal(requests.filter((request) => request.method === 'session/create').length, 1, 'never a second session');
});

test('an accepted send whose boundary publication was interrupted retains the writable exclusion and never resends', {
  timeout: scaleTestTimeout(240_000),
}, async (t) => {
  const ctx = await fixture(t, { FAKE_ZCODE_DELAY_MS: String(BOUNDARYLESS_DELAY_MS) });
  const gate = completionGate(ctx);
  await gate.block();
  ctx.env.FAKE_ZCODE_PROCESS_FILE = join(ctx.directory, 'fake-zcode-process.json');
  const recordPath = join(ctx.directory, 'fake-zcode-requests.jsonl');
  ctx.env.FAKE_ZCODE_RECORD = recordPath;
  await writeFile(recordPath, '');

  const { runnerPid, jobId } = await spawnProbeUntilRunner(t, ctx, backgroundProbe({ reportName: 'spawn' }));
  ctx.teardown.tree(() => terminateCapturedTree(runnerPid));
  const broker = await readBrokerIdentity(ctx);
  ctx.teardown.broker(() => broker);
  await until(async () => {
    const job = await readJob(ctx, jobId);
    return job.status === 'running' && !job.inputId && job.zcodeSessionId ? job : null;
  }, 'the runner must publish running before its send');
  // Deterministic interruption point: the engine records the send request on
  // arrival and only then delays its acceptance, so once the send is recorded
  // the test holds the job-state lock; the runner's accepted-boundary
  // persistence blocks on that lock forever and dies before it can publish.
  await until(() => countRequests(recordPath, 'session/send').then((count) => count >= 1),
    'the send must reach the engine', 30_000, 10);
  // holdStateLock resolves only once the advisory lock is provably held, so
  // the runner's accepted-boundary persistence is deterministically blocked
  // on this lock from here on.
  const lock = await holdStateLock(ctx);
  try {
    // Outlive the engine's delayed acceptance: the runner is now blocked on
    // the held state lock with its send accepted but its boundary unpublished.
    await sleep(scaleTestTimeout(BOUNDARYLESS_DELAY_MS + 1_000));
  } finally {
    try { process.kill(runnerPid, 'SIGKILL'); } catch { /* already gone */ }
    await waitForExit(runnerPid, 'the runner must die with an accepted but unboundaried send', 10_000);
    lock.release();
  }
  await lock.done;
  const interrupted = await readJob(ctx, jobId);
  assert.equal(interrupted.status, 'running');
  assert.equal(interrupted.inputId, undefined, 'no durable turn boundary exists');
  assert.ok(interrupted.zcodeSessionId, 'the accepted session stays published');
  assert.equal(await countRequests(recordPath, 'session/send'), 1);

  // Real recovery must best-effort stop the unattributable turn and retain the
  // writable exclusion — never resend, never adopt, never terminalize as success.
  const status = await companionChild(ctx, ['status', jobId], await ownerCaller(ctx, 'turn-background'));
  assert.equal(status.code, 0, status.stderr);
  const guarded = await readJob(ctx, jobId);
  assert.equal(guarded.status, 'running', 'a boundaryless accepted send retains the writable guard');
  assert.equal(await countRequests(recordPath, 'session/send'), 1, 'recovery never resends');
  // Best-effort remote stop: either the exact stop was requested on a live
  // control channel, or the durable record carries why the stop could not be
  // proven — the uncertainty always stays retained, never guessed away.
  const stopRequested = await countRequests(recordPath, 'session/stop') >= 1;
  const stopUnavailable = typeof guarded.lastCancelError === 'string';
  assert.ok(stopRequested || stopUnavailable, 'recovery must best-effort stop the unattributable turn or durably record the retained uncertainty');
  await assert.rejects(createStateStore({ dataRoot: ctx.dataRoot }).reserveJob({
    workspace: ctx.canonicalWorkspace, ownerSessionId: OWNER_SESSION, ownerTurnId: 'turn-later',
    command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'acceptEdits' },
  }), { code: 'WRITABLE_JOB_EXISTS' }, 'the retained writable exclusion blocks new writable work');
});

test('a real user cancel stops a gated running runner tree and leaves the managed broker alive', {
  timeout: scaleTestTimeout(240_000),
}, async (t) => {
  const ctx = await fixture(t);
  const gate = completionGate(ctx);
  await gate.block();
  ctx.env.FAKE_ZCODE_PROCESS_FILE = join(ctx.directory, 'fake-zcode-process.json');
  const recordPath = join(ctx.directory, 'fake-zcode-requests.jsonl');
  ctx.env.FAKE_ZCODE_RECORD = recordPath;
  await writeFile(recordPath, '');

  const { runnerPid, jobId } = await spawnProbeUntilRunner(t, ctx, backgroundProbe({ reportName: 'spawn' }));
  ctx.teardown.tree(() => terminateCapturedTree(runnerPid));
  const broker = await readBrokerIdentity(ctx);
  ctx.teardown.broker(() => broker);
  await until(async () => {
    const job = await readJob(ctx, jobId);
    return job.status === 'running' && job.inputId ? job : null;
  }, 'the runner must be mid-turn at its gated boundary');
  assert.equal(pidAlive(runnerPid), true);
  assertBrokerAlive(broker);
  // Identity proof that the managed broker is not a runner-tree descendant:
  // it lives outside the runner's POSIX process group.
  await assertNotInRunnerProcessGroup(broker.daemonPid, runnerPid);
  await assertNotInRunnerProcessGroup(broker.fakePid, runnerPid);
  // Structural identity: the runner leads its own process group, so the
  // termination group contains exactly the runner by construction. The broker
  // is detached in its own group by scripts/lib/process.mjs (engine under the
  // broker), and descendant-kill semantics are unit-covered in
  // tests/process-zcode.test.mjs.
  await assertRunnerLeadsOwnProcessGroup(runnerPid);

  const caller = await ownerCaller(ctx, 'turn-background');
  const started = Date.now();
  const cancelled = await companionChild(ctx, ['cancel', jobId], caller);
  const elapsed = Date.now() - started;
  const cancelEvidence = JSON.stringify({ code: cancelled.code, stdout: cancelled.stdout, stderr: cancelled.stderr, internal: cancelled.internal, json: cancelled.json });
  assert.ok(elapsed < scaleTestTimeout(20_000), `the bounded cancel must return promptly (took ${elapsed}ms)`);
  let acknowledged;
  if (cancelled.code === 0) {
    acknowledged = cancelled.json?.job;
  } else {
    // A DEFERRED cancel is a legitimate bounded outcome on a loaded CI runner
    // (macos-22.13 run 34364385782): the POSIX cancel duty runs a 1s same-pass
    // budget, and its dead-root sweep settles only on the LATER gone-group
    // evidence — an un-reaped zombie leader keeps the group probe alive
    // (process.mjs reports `swept`), so job-control retains the durable
    // `cancelling` guard plus stop intent and rejects with the bounded
    // JOB_CANCEL_FAILED whose own remedy names the exact reconciliation
    // command. Follow that remedy verbatim — the same pattern as the skills
    // integration suite — a real `status --wait` drives the non-hook reconcile
    // passes (the convergence driver; each pass retries the SAME sweep with a
    // fresh budget) until the durable stop settles, then assert the converged
    // END contract instead of demanding in-pass settlement.
    assert.equal(cancelled.json?.error?.code, 'JOB_CANCEL_FAILED', cancelEvidence);
    const storedRetained = await readJob(ctx, jobId);
    assert.equal(storedRetained.status, 'cancelling', `the deferred cancel must retain the durable stop authority; was ${storedRetained.status}`);
    // The remedy wait needs a child window larger than the CLI wait itself
    // (a multi-pass reconciliation must not be killed mid-convergence).
    const waited = await runChild(process.execPath, [cli, 'status', jobId, '--wait', '--timeout-ms', process.platform === 'win32' ? '90000' : '30000'], {
      cwd: ctx.canonicalWorkspace, env: ctx.env, input: { callerContext: caller }, protectedInput: true, timeoutMs: scaleTestTimeout(120_000),
    }).then((result) => ({ ...result, json: result.internal ? JSON.parse(result.internal) : null }));
    assert.equal(waited.code, 0, `${waited.stderr}${waited.stdout}${waited.internal}`);
    acknowledged = waited.json?.job;
  }
  assert.equal(acknowledged?.id, jobId, cancelEvidence);
  const stored = await readJob(ctx, jobId);
  assert.equal(stored.status, 'cancelled', `an acknowledged remote stop settles cancelled; was ${stored.status}`);
  // An in-pass cancel runs exactly one remote stop; the deferred path's
  // reconciliation may retry the stop while converging the retained intent,
  // so only the never-resend invariant stays exact there.
  if (cancelled.code === 0) assert.equal(await countRequests(recordPath, 'session/stop'), 1, 'exactly one remote stop runs');
  else assert.ok((await countRequests(recordPath, 'session/stop')) >= 1, cancelEvidence);
  assert.equal(await countRequests(recordPath, 'session/send'), 1, 'the cancel never resends');
  await waitForExit(runnerPid, 'the authorized user cancel must terminate the exact runner tree', 15_000);
  assertBrokerAlive(broker);
});

test('a real SessionEnd stops a gated running runner tree, settles its receipt, and leaves the managed broker alive', {
  timeout: scaleTestTimeout(240_000),
}, async (t) => {
  const ctx = await fixture(t);
  const gate = completionGate(ctx);
  await gate.block();
  ctx.env.FAKE_ZCODE_PROCESS_FILE = join(ctx.directory, 'fake-zcode-process.json');
  const recordPath = join(ctx.directory, 'fake-zcode-requests.jsonl');
  ctx.env.FAKE_ZCODE_RECORD = recordPath;
  await writeFile(recordPath, '');

  const { runnerPid, jobId } = await spawnProbeUntilRunner(t, ctx, backgroundProbe({ reportName: 'spawn' }));
  ctx.teardown.tree(() => terminateCapturedTree(runnerPid));
  const broker = await readBrokerIdentity(ctx);
  ctx.teardown.broker(() => broker);
  await until(async () => {
    const job = await readJob(ctx, jobId);
    return job.status === 'running' && job.inputId ? job : null;
  }, 'the runner must be mid-turn at its gated boundary');
  const epoch = await recordedEpoch(ctx);
  assertBrokerAlive(broker);
  // Identity proof that the separately managed broker is not a runner-tree
  // termination target: it lives outside the runner's POSIX process group.
  await assertNotInRunnerProcessGroup(broker.daemonPid, runnerPid);
  await assertNotInRunnerProcessGroup(broker.fakePid, runnerPid);
  // Structural identity: the runner leads its own process group, so the
  // termination group contains exactly the runner by construction. The broker
  // is detached in its own group by scripts/lib/process.mjs (engine under the
  // broker), and descendant-kill semantics are unit-covered in
  // tests/process-zcode.test.mjs.
  await assertRunnerLeadsOwnProcessGroup(runnerPid);

  const started = Date.now();
  const endHookDone = hookChild(ctx, 'session-end-hook.mjs', {
    session_id: OWNER_SESSION, cwd: ctx.canonicalWorkspace, hook_event_name: 'SessionEnd',
    transcript_path: null, reason: 'other',
  });
  // The exact runner tree must be terminated by the SessionEnd reconciliation;
  // at that moment the managed broker is still alive — the tree kill did not
  // take it as a descendant. (Afterwards the hook's own owner-release protocol
  // may schedule the broker's fast idle shutdown; that is the broker's
  // owner/session protocol, not a descendant kill.)
  await waitForExit(runnerPid, 'the SessionEnd reconciliation must terminate the exact runner tree', 15_000);
  assert.equal(pidAlive(runnerPid), false);
  assertBrokerAlive(broker);
  const ended = await endHookDone;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < scaleTestTimeout(6_000), `the bounded SessionEnd must stay within its native budget (took ${elapsed}ms)`);
  assert.equal(ended.code, 0, ended.stderr);
  if (process.platform === 'win32') {
    // WINDOWS DEFERRED SETTLEMENT, DIRECT CONVERGENCE ACCEPTED: one hook pass
    // (native 3s limit) fits the fail-fast recorded-pid kill — proven above by
    // the exited runner — but USUALLY cannot also run the completed-clean
    // descendant sweep (two bounded process-table snapshots), so the pass
    // retains the durable session-end stop authority honestly and defers the
    // sweep; the pending receipt stays the compensation authority. A warm or
    // fast machine may settle the same pass directly — both outcomes satisfy
    // the END contract — so the retained-state assertions run only while the
    // record is still unconverged. Convergence then drives the DESIGNED
    // post-SessionEnd compensation path: a same-ID resume re-records the
    // session (new epoch), and each retry joins a real UserPromptSubmit pass
    // (fail-fast at its native budget; it defers when the cold sweep cannot
    // fit) with the NON-HOOK reconcile path — a real `status --wait` whose
    // marked-runner duty runs at the Windows convergence budget with no
    // native hook limit — until the sweep completes clean and discharges.
    const retained = await readJob(ctx, jobId);
    if (retained.status !== 'cancelled') {
      assert.equal(retained.status, 'cancelling', `the Windows hook pass retains the durable stop authority; was ${retained.status}`);
      assert.equal(retained.stopIntent?.cause, 'session-end', 'the retained stop intent is the retry authority');
      const pendingReceipt = await createHostLifecycleStore({ dataRoot: ctx.dataRoot }).readReceipt(epoch);
      assert.equal(pendingReceipt?.state, 'pending', 'the unproven sweep keeps the receipt pending after the first Windows pass');
    }
    await hookChild(ctx, 'session-lifecycle-hook.mjs', {
      session_id: OWNER_SESSION, cwd: ctx.canonicalWorkspace, hook_event_name: 'SessionStart',
      transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', source: 'resume',
    });
    // The convergence driver's caller context must match a REAL active turn.
    // The probe's flow left this session's identity state on disk (a ledger
    // the SessionEnd cleanup and the resume retry have since tombstoned), and
    // createCallerContext validates against that global state exactly — a
    // brand-new turn id without a begun turn is CALLER_CONTEXT_INVALID, the
    // mint can never succeed. So the resumed session's FIRST real
    // UserPromptSubmit pass establishes the new-epoch caller turn here (the
    // same production path every post-resume management command rides), and
    // only then is the proved context minted. Every retry pass below reuses
    // the exact same turn: beginCallerTurn treats the identical submit as an
    // idempotent duplicate, and each pass also runs the designed prompt-time
    // prior-epoch reconciliation.
    await hookChild(ctx, 'user-prompt-hook.mjs', {
      session_id: OWNER_SESSION, turn_id: 'turn-session-end-converge', cwd: ctx.canonicalWorkspace, hook_event_name: 'UserPromptSubmit',
      transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', prompt: 'retry',
    });
    const convergeCaller = await ownerCaller(ctx, 'turn-session-end-converge');
    let receipt;
    await until(async () => {
      receipt = await createHostLifecycleStore({ dataRoot: ctx.dataRoot }).readReceipt(epoch);
      return receipt?.state === 'settled' ? receipt : null;
    }, 'the retained stop must settle and discharge the receipt through bounded Windows passes (fail-fast prompt deferral plus the non-hook status driver)', 90_000, 500, async () => {
      await hookChild(ctx, 'user-prompt-hook.mjs', {
        session_id: OWNER_SESSION, turn_id: 'turn-session-end-converge', cwd: ctx.canonicalWorkspace, hook_event_name: 'UserPromptSubmit',
        transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', prompt: 'retry',
      });
      // The non-hook convergence driver: a real management `status --wait`
      // whose reconcile passes carry the Windows duty budget. Its result is
      // evidence, not an assertion — the until predicate decides convergence.
      await companionChild(ctx, ['status', jobId, '--wait', '--timeout-ms', '60000'], convergeCaller).catch(() => {});
    });
  }
  const stored = await readJob(ctx, jobId);
  assert.equal(stored.status, 'cancelled', `the session-end stop settles the running runner; was ${stored.status}`);
  assert.equal(stored.stopCause, 'session-end');
  const receipt = await createHostLifecycleStore({ dataRoot: ctx.dataRoot }).readReceipt(epoch);
  assert.equal(receipt?.state, 'settled', 'the settled terminal obligation discharges the exact-epoch receipt');
});

test('a real user cancel of a claimed queued runner persists the stop intent, kills the exact tree, and cancels', {
  timeout: scaleTestTimeout(240_000),
}, async (t) => {
  const ctx = await fixture(t);
  const createGate = sessionCreateGate(ctx);
  ctx.env.FAKE_ZCODE_PROCESS_FILE = join(ctx.directory, 'fake-zcode-process.json');
  const recordPath = join(ctx.directory, 'fake-zcode-requests.jsonl');
  ctx.env.FAKE_ZCODE_RECORD = recordPath;
  await writeFile(recordPath, '');

  const { runnerPid, jobId } = await spawnProbeUntilRunner(t, ctx, backgroundProbe({ reportName: 'spawn' }));
  ctx.teardown.tree(() => terminateCapturedTree(runnerPid));
  // The claimed runner's separately managed broker pair survives the exact-tree
  // kill below, so it is captured here and released by this test's cleanup.
  const broker = await readBrokerIdentity(ctx);
  ctx.teardown.broker(() => broker);
  // Deterministic claimed-queued barrier: the fake engine holds the
  // session/create response, so the running publication provably cannot have
  // happened while the gate stays held — the kill window is bounded by
  // observation, not by a wall-clock delay a slow CI worker could outrun.
  await until(async () => {
    const job = await readJob(ctx, jobId);
    return job.status === 'queued' && job.workerLeaseId && job.childPid === runnerPid ? job : null;
  }, 'the runner must be claimed and still queued');
  await createGate.reached();
  assert.equal(pidAlive(runnerPid), true);
  // Structural identity: the runner leads its own process group, so the
  // termination group contains exactly the runner by construction. The broker
  // is detached in its own group by scripts/lib/process.mjs (engine under the
  // broker), and descendant-kill semantics are unit-covered in
  // tests/process-zcode.test.mjs.
  await assertRunnerLeadsOwnProcessGroup(runnerPid);

  const cancelled = await companionChild(ctx, ['cancel', jobId], await ownerCaller(ctx, 'turn-background'));
  assert.equal(cancelled.code, 0, cancelled.stderr);
  assert.equal(cancelled.json?.job?.id, jobId);
  const stored = await readJob(ctx, jobId);
  assert.equal(stored.status, 'cancelled', 'queued live claim -> stop intent -> kill -> acquire lease -> cancelled');
  assert.equal(stored.stopCause, 'user');
  assert.equal('rescueExecutionInput' in stored, false, 'the queued terminal removes the private input');
  assert.equal(stored.rescueRunnerVersion, 1, 'the marker persists on the terminal record');
  await waitForExit(runnerPid, 'the queued-stop reconciliation must terminate the exact claimed runner tree', 15_000);
  // The advertised claimed-queued safety case: cancellation must leave the
  // separately managed broker alive — on every platform, including Windows
  // where the broker/engine are PPID descendants of the runner and production
  // termination spares exactly that broker subtree through the exclusion
  // resolved from the durable broker identities.
  assertBrokerAlive(broker);
  assert.equal(await countRequests(recordPath, 'session/send'), 0, 'no send ever runs for the cancelled queued job');
});

test('a free lease with a live unrelated recorded pid is never signaled by a real SessionEnd', {
  timeout: scaleTestTimeout(120_000),
}, async (t) => {
  const ctx = await fixture(t);
  const recordPath = join(ctx.directory, 'fake-zcode-requests.jsonl');
  ctx.env.FAKE_ZCODE_RECORD = recordPath;
  await writeFile(recordPath, '');
  // A real unrelated live process recorded as the executor pid while the exact
  // worker lease is FREE (the runner already exited; the pid was reused).
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000);'], { stdio: 'ignore', shell: false });
  ctx.teardown.tree(async () => { try { process.kill(bystander.pid, 'SIGKILL'); } catch { /* gone */ } await sleep(100); });
  await until(() => pidAlive(bystander.pid), 'the unrelated bystander process must start');
  await hookChild(ctx, 'session-lifecycle-hook.mjs', {
    session_id: OWNER_SESSION, cwd: ctx.canonicalWorkspace, hook_event_name: 'SessionStart',
    transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', source: 'startup',
  });
  const epoch = await recordedEpoch(ctx);

  const reserved = await ctx.store.reserveFreshRescueJob({
    workspace: ctx.canonicalWorkspace,
    reservation: {
      workspace: ctx.canonicalWorkspace, ownerSessionId: OWNER_SESSION, ownerTurnId: 'turn-free-lease',
      command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'acceptEdits' },
    },
    executor: {
      parentSessionId: OWNER_SESSION, parentTurnId: 'turn-free-lease', agentId: 'free-lease-child',
      agentType: 'zcode-rescue', agentPath: '/root/zcode_rescue_task', workspace: ctx.canonicalWorkspace,
      parentPermissionMode: 'acceptEdits',
    },
    lifecycle: { ownerLifecycleEpoch: epoch, executionOwner: 'host-child', hostPlacement: 'background' },
    executionInput: { version: 1, task: 'free lease pid safety task' },
  });
  const jobId = reserved.job.id;
  await ctx.store.claimJobWorkerForExecution(ctx.canonicalWorkspace, jobId, { childPid: bystander.pid, workerLeaseId: 'a'.repeat(64) });
  // Prove the lease is really free (no process holds it) before the boundary.
  const { withWorkerLease } = await import('../../scripts/lib/recovery.mjs');
  await withWorkerLease({ dataRoot: ctx.dataRoot, workspace: ctx.canonicalWorkspace, jobId, workerLeaseId: 'a'.repeat(64), timeoutMs: 0 }, () => undefined);

  // The settlement invariant's sweep is platform-split: the POSIX group probe
  // NEVER consults the broker identity lookup, so this workspace deliberately
  // records NO identity (the absent-equivalent) — the duty must still converge
  // purely on the recorded group evidence. (On Windows the absent lookup would
  // walk under the held startup lock with the proven-empty exclusion set.)

  const ended = await hookChild(ctx, 'session-end-hook.mjs', {
    session_id: OWNER_SESSION, cwd: ctx.canonicalWorkspace, hook_event_name: 'SessionEnd',
    transcript_path: null, reason: 'other',
  });
  assert.equal(ended.code, 0, ended.stderr);
  assert.equal(pidAlive(bystander.pid), true, 'a free lease never authorizes signaling the recorded pid');
  const stored = await readJob(ctx, jobId);
  // THE SETTLEMENT INVARIANT: an alive recorded pid under a FREE lease is the
  // accepted residual pid-reuse risk — the dead-root proof fails (`root-alive`),
  // so the pass could not run a completed-clean descendant sweep and the
  // claimed queued orphan is RETAINED exactly as-is (claim, status, and the
  // durable session-end stop intent that re-arms the duty on the next pass)
  // instead of terminalized over an unproven tree.
  assert.equal(stored.status, 'queued', 'the alive-root residual keeps the claimed queued record retained');
  assert.equal(stored.workerLeaseId, 'a'.repeat(64), 'the exact claim survives the retained stop');
  assert.equal(stored.stopIntent?.cause, 'session-end', 'the durable stop decision is the retry authority');
  const receipt = await createHostLifecycleStore({ dataRoot: ctx.dataRoot }).readReceipt(epoch);
  assert.equal(receipt?.state, 'pending', 'the receipt stays the compensation authority while the duty is unproven');
  assert.equal(await countRequests(recordPath, 'session/send'), 0);
  // Convergence: once the recorded pid is really gone, a later bounded pass's
  // completed-clean dead-root sweep discharges the retained stop authority. The
  // first hook's generic cleanup removed the session record, so POSIX runs the
  // legacy no-receipt settle path against the same claim through a second real
  // SessionEnd. WINDOWS converges through the DESIGNED post-SessionEnd
  // compensation path instead — a same-ID resume re-records the session and
  // the retry loop below joins each real UserPromptSubmit pass (fail-fast at
  // its native budget) with the non-hook `status --wait` reconcile path (the
  // marked-runner duty at the Windows convergence budget) — because one hook
  // pass can never also fit the completed-clean sweep inside the native
  // three-second limit, and a cold sweep can exceed even the native
  // ten-second prompt limit on a loaded runner. The retained session-end stop
  // intent keeps labelling the converged winner either way.
  process.kill(bystander.pid, 'SIGKILL');
  await until(async () => !pidAlive(bystander.pid), 'the bystander must exit');
  if (process.platform === 'win32') {
    await hookChild(ctx, 'session-lifecycle-hook.mjs', {
      session_id: OWNER_SESSION, cwd: ctx.canonicalWorkspace, hook_event_name: 'SessionStart',
      transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', source: 'resume',
    });
    // Each convergence retry joins the DESIGNED fail-fast prompt pass (its
    // ~8s native-window budget defers when the cold Windows sweep cannot fit)
    // with the NON-HOOK reconcile path — a real `status --wait` whose
    // marked-runner duty runs at the Windows convergence budget (no native
    // hook limit). Prompt passes alone cannot be the convergence driver on a
    // loaded runner: a cold process-table sweep alone can exceed the native
    // prompt limit, so every pass would defer forever; the status-driven duty
    // is what makes convergence REACHABLE, and its result is evidence only —
    // the until predicate decides convergence.
    const convergeCaller = await ownerCaller(ctx, 'turn-free-lease-converge');
    await until(async () => (await readJob(ctx, jobId)).status === 'cancelled', 'the retained stop authority must converge cancelled through bounded Windows passes (fail-fast prompt deferral plus the non-hook status driver)', 90_000, 500, async () => {
      await hookChild(ctx, 'user-prompt-hook.mjs', {
        session_id: OWNER_SESSION, cwd: ctx.canonicalWorkspace, hook_event_name: 'UserPromptSubmit',
        transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', prompt: 'retry',
      });
      await companionChild(ctx, ['status', jobId, '--wait', '--timeout-ms', '60000'], convergeCaller).catch(() => {});
    });
  } else {
    const retry = await hookChild(ctx, 'session-end-hook.mjs', {
      session_id: OWNER_SESSION, cwd: ctx.canonicalWorkspace, hook_event_name: 'SessionEnd',
      transcript_path: null, reason: 'other',
    });
    assert.equal(retry.code, 0, retry.stderr);
  }
  const settled = await readJob(ctx, jobId);
  assert.equal(settled.status, 'cancelled', 'the completed-clean sweep settles the retained stop authority');
  assert.equal(settled.stopCause, 'session-end');
  assert.equal(await countRequests(recordPath, 'session/send'), 0, 'a queued orphan is never sent');
});

// ---------------------------------------------------------------------------
// SessionEnd's final obligation-discovery fence: a FAILED final scan (lock
// contention, corruption, or the fence slice's timeout) cannot name the
// affected workspace, so the whole pass must defer EVERY workspace's broker
// owner release — while a clean EMPTY scan (no obligations) settles and
// releases exactly as before.
// ---------------------------------------------------------------------------

/** Widen a session's identity ledger to a linked workspace the way a forwarded
 * / linked-Worktree execution would, so SessionEnd's known scope spans both. */
async function extendSessionLedger(dataRootPath, sessionId, extraWorkspaces) {
  const key = createHash('sha256').update(JSON.stringify([sessionId])).digest('hex');
  const path = join(dataRootPath, 'identity-lifecycle', 'sessions', `${key}.json`);
  const ledger = JSON.parse(await readFile(path, 'utf8'));
  ledger.knownWorkspaces = [...new Set([...ledger.knownWorkspaces, ...extraWorkspaces])].sort();
  await writeFile(path, `${JSON.stringify(ledger)}\n`);
}

test('a failed final obligation scan defers every workspace owner release for the pass', {
  timeout: scaleTestTimeout(120_000),
}, async (t) => {
  if (process.platform === 'win32') {
    t.skip('the POSIX sweep settles the obligations without consulting the broker identity the stale release fixture leaves behind; a native Windows run needs a healthy recorded broker');
    return;
  }
  const ctx = await fixture(t);
  await hookChild(ctx, 'session-lifecycle-hook.mjs', {
    session_id: OWNER_SESSION, cwd: ctx.canonicalWorkspace, hook_event_name: 'SessionStart',
    transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', source: 'startup',
  });
  const epoch = await recordedEpoch(ctx);
  const dataRootPath = realpathSync.native(ctx.dataRoot);
  // One caller turn installs the session's identity ledger; two linked
  // workspaces then widen the session scope exactly like a forwarded /
  // linked-Worktree execution would. The VANISHING workspace (zz-deferred) is
  // deleted between the two scans below, so the final obligation scan fails on
  // it exactly like a deleted/moved linked worktree would in production; the
  // WATCH workspace (zzz-watch) sorts strictly LAST, so its job storage
  // appearing proves the stage-(4) discovery listing already finished — the
  // deletion marker.
  const { startedAt } = await resolveRecordedSessionStart(ctx.dataRoot, ctx.canonicalWorkspace, OWNER_SESSION);
  await createIdentityStore({ dataRoot: ctx.dataRoot }).beginCallerTurn({
    sessionId: OWNER_SESSION, turnId: 'turn-fence', workspace: ctx.canonicalWorkspace,
    permissionMode: 'acceptEdits', sessionStartedAt: startedAt, sessionSource: 'startup',
  });
  await mkdir(join(ctx.directory, 'zz-deferred'), { recursive: true });
  await mkdir(join(ctx.directory, 'zzz-watch'), { recursive: true });
  const linkedWorkspace = realpathSync.native(join(ctx.directory, 'zz-deferred'));
  const watchWorkspace = realpathSync.native(join(ctx.directory, 'zzz-watch'));
  await extendSessionLedger(dataRootPath, OWNER_SESSION, [linkedWorkspace, watchWorkspace]);
  // The watch storage's jobs directory — created only when a scan actually
  // lists that workspace — without resolving (and thereby creating) it here.
  const watchJobsDirectory = join(dataRootPath, 'workspaces',
    createHash('sha256').update(watchWorkspace).digest('hex'), 'jobs');
  // A stale broker identity (endpoint mismatch for this workspace): any owner
  // release ATTEMPT against the ambient workspace observably defers with
  // ZCODE_OWNER_RELEASE_INCOMPLETE, so the hook's stderr proves whether the
  // release stage ran at all.
  const { writeBrokerIdentity } = await import('../../scripts/zcode-broker.mjs');
  const ambientStorage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.canonicalWorkspace });
  await writeBrokerIdentity(join(ambientStorage.directory, 'broker', 'identity.json'), {
    endpoint: 'stale-fence-fixture-endpoint', pid: 111_000_005,
    launch: { command: '/tools/node', args: ['broker.mjs', 'config.json'] },
  });
  // A real, provably dead executor pid for the terminal marked-claim
  // obligations below (no live process may be recorded).
  const deadWorker = spawn(process.execPath, ['-e', 'process.exit(0);'], { stdio: 'ignore', shell: false });
  if (deadWorker.exitCode === null && deadWorker.signalCode === null) await new Promise((resolve) => deadWorker.once('exit', resolve));
  const deadPid = deadWorker.pid;
  // ONE terminal marked-claim obligation settles cleanly through the local
  // duty in stage (5) (free lease, POSIX group probe on the dead pid): it
  // keeps allDelegated true so the final scan runs, and its bounded settlement
  // keeps the discovery -> fence window wide open for the lock takeover below.
  for (let index = 0; index < 1; index += 1) {
    const reserved = await ctx.store.reserveFreshRescueJob({
      workspace: ctx.canonicalWorkspace,
      reservation: {
        workspace: ctx.canonicalWorkspace, ownerSessionId: OWNER_SESSION, ownerTurnId: `turn-fence-${index}`,
        command: 'rescue', readOnly: false, permissionSnapshot: { permissionMode: 'acceptEdits' },
      },
      executor: {
        parentSessionId: OWNER_SESSION, parentTurnId: `turn-fence-${index}`, agentId: `fence-child-${index}`,
        agentType: 'zcode-rescue', agentPath: '/root/zcode_rescue_task', workspace: ctx.canonicalWorkspace,
        parentPermissionMode: 'acceptEdits',
      },
      lifecycle: { ownerLifecycleEpoch: epoch, executionOwner: 'host-child', hostPlacement: 'background' },
      executionInput: { version: 1, task: `fence scan task ${index}` },
    });
    const jobId = reserved.job.id;
    await ctx.store.claimJobWorkerForExecution(ctx.canonicalWorkspace, jobId, { childPid: deadPid, workerLeaseId: 'a'.repeat(64) });
    await ctx.store.transitionJob(ctx.canonicalWorkspace, jobId, ['queued'], 'running', {
      startedAt: new Date().toISOString(), zcodeSessionId: `zs-fence-${index}`, childPid: deadPid, workerLeaseId: 'a'.repeat(64),
    });
    await ctx.store.finishJob(ctx.canonicalWorkspace, jobId, ['running'], 'succeeded', { resultArtifact: `results/${jobId}.md`, exitCode: 0 });
  }
  // Run the hook; when the WATCH workspace's storage appears (the last
  // stage-(4) listing), delete the VANISHING workspace's directory: the final
  // obligation scan — which re-lists every known workspace — then fails on the
  // vanished worktree exactly like a deleted or moved linked worktree would.
  const hookRun = hookChild(ctx, 'session-end-hook.mjs', {
    session_id: OWNER_SESSION, cwd: ctx.canonicalWorkspace, hook_event_name: 'SessionEnd',
    transcript_path: null, reason: 'other',
  });
  let markerSeen = false;
  const markerDeadline = Date.now() + 20_000;
  while (!markerSeen && Date.now() < markerDeadline) {
    markerSeen = await stat(watchJobsDirectory).then(() => true, () => false);
    if (!markerSeen) await sleep(2);
  }
  assert.ok(markerSeen, 'the stage-(4) discovery must have listed the whole workspace scope (the watch storage is the deletion marker)');
  await rm(join(ctx.directory, 'zz-deferred'), { force: true, recursive: true });
  const ended = await hookRun;
  assert.equal(ended.code, 0, ended.stderr);
  assert.match(ended.stderr, /settlement fence deferred/, 'the failed final scan surfaces its bounded diagnostic');
  // THE FIX: a failed final scan cannot name the affected workspace, so
  // EVERY known workspace is release-unsafe for this pass and no owner
  // release is even attempted. RED before the fix: the ambient workspace's
  // release ran into the stale identity and logged the deferral.
  assert.doesNotMatch(ended.stderr, /owner release deferred/,
    'a failed final scan defers every owner release: none is attempted this pass');
  const receipt = await createHostLifecycleStore({ dataRoot: ctx.dataRoot }).readReceipt(epoch);
  assert.equal(receipt?.state, 'pending', 'the receipt stays the compensation authority; the next pass retries discovery and release');
});

test('a clean empty final obligation scan settles the receipt and defers no owner release', {
  timeout: scaleTestTimeout(60_000),
}, async (t) => {
  const ctx = await fixture(t);
  await hookChild(ctx, 'session-lifecycle-hook.mjs', {
    session_id: OWNER_SESSION, cwd: ctx.canonicalWorkspace, hook_event_name: 'SessionStart',
    transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', source: 'startup',
  });
  const epoch = await recordedEpoch(ctx);
  // No obligations exist: the final scan's EMPTY result is a SUCCESS, not a
  // failure — the releases proceed and the receipt settles (the distinction
  // the failed-scan deferral must not collapse).
  const ended = await hookChild(ctx, 'session-end-hook.mjs', {
    session_id: OWNER_SESSION, cwd: ctx.canonicalWorkspace, hook_event_name: 'SessionEnd',
    transcript_path: null, reason: 'other',
  });
  assert.equal(ended.code, 0, ended.stderr);
  assert.doesNotMatch(ended.stderr, /settlement fence deferred/, 'a clean empty scan is a success, never a deferral');
  assert.doesNotMatch(ended.stderr, /owner release deferred/, 'the clean pass releases owners without diagnostics');
  const receipt = await createHostLifecycleStore({ dataRoot: ctx.dataRoot }).readReceipt(epoch);
  assert.equal(receipt?.state, 'settled', 'a clean empty final scan settles the receipt and keeps releases proceeding');
});

test('exact continuation crosses stop/resume and placement changes with unchanged permission, and a permission mismatch rejects', {
  timeout: scaleTestTimeout(300_000),
}, async (t) => {
  const ctx = await fixture(t);
  const recordPath = join(ctx.directory, 'fake-zcode-requests.jsonl');
  ctx.env.FAKE_ZCODE_RECORD = recordPath;
  ctx.env.FAKE_ZCODE_PROCESS_FILE = join(ctx.directory, 'fake-zcode-process.json');
  await writeFile(recordPath, '');
  let broker = null;
  ctx.teardown.broker(() => broker);

  // (1) Attached foreground anchor in epoch 1 (real parent process, real wait).
  const anchor = await spawnProbe(t, ctx, {
    turnId: 'turn-anchor', task: 'anchor task', placement: 'foreground', resume: 'fresh', reportName: 'anchor',
  });
  const anchorReport = await anchor.report;
  assert.equal(anchorReport.done, true, `the foreground anchor must complete: ${JSON.stringify(anchorReport.error ?? null)}`);
  assert.equal(anchorReport.job?.status, 'succeeded');
  assert.equal(anchorReport.result, 'done');
  const anchorSession = (await readJob(ctx, anchorReport.jobId)).zcodeSessionId;
  assert.ok(anchorSession, 'the anchor owns an exact ZCode session');
  broker = await readBrokerIdentity(ctx);

  // (2) Background continuation in the SAME epoch: placement change (attached
  // foreground -> detached background) with the unchanged permission snapshot.
  const firstContinuation = await spawnProbeUntilRunner(t, ctx, backgroundProbe({
    turnId: 'turn-continuation-1', task: 'continuation one', resume: 'resume', sessionSource: 'skip', reportName: 'spawn-1',
  }));
  ctx.teardown.tree(() => terminateCapturedTree(firstContinuation.runnerPid));
  assert.notEqual(firstContinuation.jobId, anchorReport.jobId, 'the continuation reserves its own job');
  const firstContinued = await until(async () => {
    const job = await readJob(ctx, firstContinuation.jobId);
    return TERMINAL_STATUSES.includes(job.status) ? job : null;
  }, 'the background continuation runner must execute its job');
  assert.equal(firstContinued.status, 'succeeded', `the continuation must execute; error: ${JSON.stringify(firstContinued.error ?? null)}`);
  assert.equal(firstContinued.zcodeSessionId, anchorSession, 'the continuation resumes the exact bound session');

  // (3) A real SessionEnd closes epoch 1 with no active obligations, then a
  // real same-ID resume opens epoch 2; the continuation crosses the boundary.
  const ended = await hookChild(ctx, 'session-end-hook.mjs', {
    session_id: OWNER_SESSION, cwd: ctx.canonicalWorkspace, hook_event_name: 'SessionEnd',
    transcript_path: null, reason: 'other',
  });
  assert.equal(ended.code, 0, ended.stderr);

  // (4) Background continuation in the NEW epoch after the stop/resume.
  const secondContinuation = await spawnProbeUntilRunner(t, ctx, backgroundProbe({
    turnId: 'turn-continuation-2', task: 'continuation two', resume: 'resume',
    sessionSource: 'resume', reportName: 'spawn-2',
  }));
  ctx.teardown.tree(() => terminateCapturedTree(secondContinuation.runnerPid));
  const secondContinued = await until(async () => {
    const job = await readJob(ctx, secondContinuation.jobId);
    return TERMINAL_STATUSES.includes(job.status) ? job : null;
  }, 'the post-resume background continuation must execute');
  assert.equal(secondContinued.status, 'succeeded', `the post-resume continuation must execute; error: ${JSON.stringify(secondContinued.error ?? null)}`);
  assert.equal(secondContinued.zcodeSessionId, anchorSession, 'the post-resume continuation still resumes the exact bound session');
  assert.notEqual(secondContinuation.jobId, firstContinuation.jobId);

  // Exactness: one create (the anchor), every resume targets the anchor
  // session exactly once per continuation, and one send per job.
  const requests = await recordedRequests(recordPath);
  assert.equal(requests.filter((request) => request.method === 'session/create').length, 1);
  const resumes = requests.filter((request) => request.method === 'session/resume');
  assert.equal(resumes.length, 2);
  assert.deepEqual(resumes.map((resume) => resume.params?.sessionId), [anchorSession, anchorSession]);
  assert.equal(requests.filter((request) => request.method === 'session/send').length, 3);

  // (5) A permission mismatch rejects the continuation reservation before any
  // runner exists, with a stable bounded authorization error.
  const mismatched = await spawnProbe(t, ctx, backgroundProbe({
    turnId: 'turn-continuation-3', task: 'mismatched continuation', resume: 'resume',
    permissionMode: 'plan', sessionSource: 'resume', reportName: 'mismatch', allowError: true,
  }));
  const mismatchReport = await mismatched.report;
  assert.equal(mismatchReport.done, undefined, 'the mismatched continuation must not enqueue');
  assert.equal(mismatchReport.error?.code, 'RESCUE_BINDING_INVALID', `expected the stable binding rejection; got ${JSON.stringify(mismatchReport.error ?? null)}`);
  assert.equal(await countRequests(recordPath, 'session/send'), 3, 'the mismatched attempt never sends');
});

test('a late old-epoch runner after compensation and a new reservation never becomes a second driver', {
  timeout: scaleTestTimeout(300_000),
}, async (t) => {
  const ctx = await fixture(t);
  ctx.env.FAKE_ZCODE_PROCESS_FILE = join(ctx.directory, 'fake-zcode-process.json');
  const recordPath = join(ctx.directory, 'fake-zcode-requests.jsonl');
  ctx.env.FAKE_ZCODE_RECORD = recordPath;
  await writeFile(recordPath, '');
  // Share the fake engine's session records across engine generations: the
  // old-epoch continuation below runs on a FRESH broker + engine pair (the
  // anchor's pair is retired before it), and that fresh engine must resume
  // the anchor session the ORIGINAL engine created — reporting the workspace
  // the anchor session was CREATED with, never the fresh engine's own launch
  // cwd (on Windows the broker launches its engine with a tmpdir cwd, so a
  // cwd-invented workspace would fail production's exact session/workspace
  // validation; on POSIX the launch cwd IS the workspace, which is why this
  // leg only ever broke on Windows).
  ctx.env.FAKE_ZCODE_SESSION_REGISTRY = join(ctx.directory, 'fake-zcode-session-registry.jsonl');
  let broker = null;
  ctx.teardown.broker(() => broker);

  // Foreground anchor (epoch 1) runs BEFORE the completion gate is armed: the
  // attached anchor must observe its natural completion.
  const anchor = await spawnProbe(t, ctx, {
    turnId: 'turn-anchor', task: 'anchor task', placement: 'foreground', resume: 'fresh', reportName: 'anchor',
  });
  const anchorReport = await anchor.report;
  assert.equal(anchorReport.job?.status, 'succeeded');
  const anchorSession = (await readJob(ctx, anchorReport.jobId)).zcodeSessionId;
  const epoch = await recordedEpoch(ctx);
  const anchorBroker = await readBrokerIdentity(ctx);
  // Retire the anchor's broker so the old-epoch continuation's runner spawns a
  // fresh broker that inherits the armed completion gate (the separately
  // managed broker always carries the engine environment it was born with).
  await releaseCapturedBroker(anchorBroker);
  // Retire the anchor's durable identity RECORD too, completing the retirement
  // the broker's own graceful close would have performed. Killing the pair
  // alone leaves a dead identity on disk whose recorded daemon pid a busy
  // Windows CI box (hundreds of suite process spawns churning the small
  // multiple-of-4 pid space) reuses within seconds — the runner's
  // ensureZCodeBroker then inspects the reused pid as live-but-unprovable
  // ('unhealthy') and fails its fresh-broker chain before the gated engine
  // ever exists, so the accepted boundary never publishes. The clean
  // identity-absent workspace is exactly the fresh-broker state test 815's
  // runner already proves on Windows; the dead-identity retire machinery
  // itself stays unit-covered in tests/zcode-client.test.mjs.
  const anchorStorage = await resolveWorkspaceStorage({ dataRoot: ctx.dataRoot, workspace: ctx.canonicalWorkspace });
  await rm(join(anchorStorage.directory, 'broker', 'identity.json'), { force: true });

  // Arm the engine completion gate: the old-epoch continuation will be gated
  // mid-turn at its accepted boundary.
  const gate = completionGate(ctx);
  await gate.block();

  const firstContinuation = await spawnProbeUntilRunner(t, ctx, backgroundProbe({
    turnId: 'turn-old-continuation', task: 'old epoch continuation', resume: 'resume', sessionSource: 'skip', reportName: 'spawn-held',
  }));
  const oldRunnerPid = firstContinuation.runnerPid;
  const oldJobId = firstContinuation.jobId;
  ctx.teardown.tree(() => terminateCapturedTree(oldRunnerPid));
  // The boundary chain here is the full cold Windows startup path — detached
  // runner spawn, a FRESH broker spawn (the anchor broker was retired), the
  // first gated engine round trip, and the running publication — each stage
  // seconds-scale on a loaded Windows CI runner, so the accepted-boundary and
  // fresh-broker waits get a Windows-sized window (still scaled by the CI
  // multiplier like every other wait). A shared 2-core Windows runner under a
  // parallel suite load has been observed to exceed a 40s raw window here
  // without anything being wrong, so the Windows window is 90s raw.
  const windowsColdStartWaitMs = process.platform === 'win32' ? 90_000 : 20_000;
  // Fail fast on a dead runner instead of polling the whole window: the
  // detached runner's stdio is ignored by design, so its durable record is
  // the ONLY place an early failure (for example a fresh-broker startup
  // rejection) is visible — surface it the moment it happens.
  const gated = await until(async () => {
    const job = await readJob(ctx, oldJobId);
    if (TERMINAL_STATUSES.includes(job.status)) {
      throw new FatalReportError(`the old-epoch continuation settled ${job.status} before its gated boundary: ${JSON.stringify(job.error ?? null)}`);
    }
    if (!pidAlive(oldRunnerPid)) throw new FatalReportError('the old-epoch runner exited before publishing its gated accepted boundary');
    return job.status === 'running' && job.inputId && job.zcodeSessionId === anchorSession ? job : null;
  }, 'the old-epoch continuation must reach its gated accepted boundary', windowsColdStartWaitMs);
  assert.equal(gated.zcodeSessionId, anchorSession);
  assert.equal(await countRequests(recordPath, 'session/send'), 2, 'the anchor and the old continuation have sent once each');
  // The new broker must be a live descendant carrying the gated engine env.
  broker = await until(async () => {
    if (!pidAlive(oldRunnerPid)) throw new FatalReportError('the old-epoch runner exited before its fresh gated broker was identified');
    const identity = await readBrokerIdentity(ctx, 5_000).catch(() => null);
    return identity && identity.fakePid !== anchorBroker.fakePid && pidAlive(identity.fakePid) ? identity : null;
  }, 'the gated continuation must be served by a fresh broker process', windowsColdStartWaitMs);

  // The real SessionEnd for epoch 1 stops the running old-epoch continuation
  // (remote stop, exact runner-tree termination, cancelled terminal).
  const ended = await hookChild(ctx, 'session-end-hook.mjs', {
    session_id: OWNER_SESSION, cwd: ctx.canonicalWorkspace, hook_event_name: 'SessionEnd',
    transcript_path: null, reason: 'other',
  });
  assert.equal(ended.code, 0, ended.stderr);
  if (process.platform === 'win32') {
    // WINDOWS DEFERRED SETTLEMENT, DIRECT CONVERGENCE ACCEPTED: one hook pass
    // (native 3s limit) fits the fail-fast recorded-pid kill — the runner exit
    // is proven below — but USUALLY cannot also run the completed-clean
    // descendant sweep (two bounded process-table snapshots), so the pass
    // retains the durable session-end stop authority honestly and defers the
    // sweep; the pending epoch-1 receipt stays the compensation authority. A
    // warm or fast machine may settle the same pass directly — both outcomes
    // satisfy the END contract — so the retained-state assertions run only
    // while the record is still unconverged. Convergence then drives the
    // DESIGNED post-SessionEnd compensation path (the same one test 'a real
    // SessionEnd stops a gated running runner tree' proves): a same-ID resume
    // re-records the session, and each retry joins a real UserPromptSubmit
    // pass (fail-fast at its native budget; it defers when the cold sweep
    // cannot fit) with the NON-HOOK reconcile path — a real `status --wait`
    // whose marked-runner duty runs at the Windows convergence budget
    // (WINDOWS_RUNNER_DUTY_FALLBACK_MS, threaded to the status path) with no
    // native hook limit — until the sweep completes clean and the old-epoch
    // record settles cancelled with its receipt discharged. The successor
    // below resumes whatever epoch the convergence leaves recorded, so its
    // compensation boundary is unchanged by these extra passes.
    const retained = await readJob(ctx, oldJobId);
    if (retained.status !== 'cancelled') {
      assert.equal(retained.status, 'cancelling', `the Windows hook pass retains the durable stop authority; was ${retained.status}`);
      assert.equal(retained.stopIntent?.cause, 'session-end', 'the retained stop intent is the retry authority');
      const pendingReceipt = await createHostLifecycleStore({ dataRoot: ctx.dataRoot }).readReceipt(epoch);
      assert.equal(pendingReceipt?.state, 'pending', 'the unproven sweep keeps the receipt pending after the first Windows pass');
    }
    await hookChild(ctx, 'session-lifecycle-hook.mjs', {
      session_id: OWNER_SESSION, cwd: ctx.canonicalWorkspace, hook_event_name: 'SessionStart',
      transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', source: 'resume',
    });
    // The convergence driver's caller context must match a REAL active turn:
    // the SessionEnd cleanup tombstoned this session's identity ledger, and
    // createCallerContext validates against that global state exactly — a
    // brand-new turn id without a begun turn is CALLER_CONTEXT_INVALID. The
    // resumed session's FIRST real UserPromptSubmit pass establishes the
    // new-epoch caller turn here, and only then is the proved context minted;
    // every retry pass below reuses the exact same turn idempotently.
    await hookChild(ctx, 'user-prompt-hook.mjs', {
      session_id: OWNER_SESSION, turn_id: 'turn-old-epoch-converge', cwd: ctx.canonicalWorkspace, hook_event_name: 'UserPromptSubmit',
      transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', prompt: 'retry',
    });
    const convergeCaller = await ownerCaller(ctx, 'turn-old-epoch-converge');
    await until(async () => {
      const job = await readJob(ctx, oldJobId);
      if (job.status !== 'cancelled') return null;
      const settledReceipt = await createHostLifecycleStore({ dataRoot: ctx.dataRoot }).readReceipt(epoch);
      return settledReceipt?.state === 'settled' ? job : null;
    }, 'the retained stop must converge cancelled and settle the old-epoch receipt through bounded Windows passes (fail-fast prompt deferral plus the non-hook status driver)', 90_000, 500, async () => {
      await hookChild(ctx, 'user-prompt-hook.mjs', {
        session_id: OWNER_SESSION, turn_id: 'turn-old-epoch-converge', cwd: ctx.canonicalWorkspace, hook_event_name: 'UserPromptSubmit',
        transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', prompt: 'retry',
      });
      // The non-hook convergence driver: a real management `status --wait`
      // whose reconcile passes carry the Windows duty budget. Its result is
      // evidence, not an assertion — the until predicate decides convergence.
      await companionChild(ctx, ['status', oldJobId, '--wait', '--timeout-ms', '60000'], convergeCaller).catch(() => {});
    });
  }
  const cancelledOld = await readJob(ctx, oldJobId);
  assert.equal(cancelledOld.status, 'cancelled', 'the SessionEnd cancels the running old-epoch continuation');
  assert.equal(cancelledOld.stopCause, 'session-end');
  await waitForExit(oldRunnerPid, 'the SessionEnd must terminate the old-epoch runner tree', 15_000);
  const receipt = await createHostLifecycleStore({ dataRoot: ctx.dataRoot }).readReceipt(epoch);
  assert.equal(receipt?.state, 'settled', 'the old-epoch receipt settles with its obligation');
  // Release the gated engine so the successor's turn can complete naturally.
  await gate.release();

  // A real same-ID resume compensates the recorded epoch and opens the next
  // one; a NEW background continuation reservation is the only new driver.
  const successor = await spawnProbeUntilRunner(t, ctx, backgroundProbe({
    turnId: 'turn-new-continuation', task: 'new epoch continuation', resume: 'resume',
    sessionSource: 'resume', reportName: 'spawn-successor',
  }));
  ctx.teardown.tree(() => terminateCapturedTree(successor.runnerPid));
  assert.notEqual(successor.jobId, oldJobId, 'the successor reserves a new job in the new epoch');
  const succeeded = await until(async () => {
    const job = await readJob(ctx, successor.jobId);
    return TERMINAL_STATUSES.includes(job.status) ? job : null;
  }, 'the new epoch continuation must execute');
  assert.equal(succeeded.status, 'succeeded', `the successor must execute; error: ${JSON.stringify(succeeded.error ?? null)}`);
  assert.equal(succeeded.zcodeSessionId, anchorSession, 'the successor resumes the exact bound session');

  // THE late old-epoch runner: the real detached runner entry for the OLD job
  // arrives after the compensation and the new reservation. It must reject
  // admission and exit without any remote call — never a second driver.
  const lateRunner = runChild(process.execPath, [cli, 'run-host-rescue-job', oldJobId], {
    cwd: ctx.canonicalWorkspace, env: ctx.env, timeoutMs: scaleTestTimeout(60_000),
  });
  const lateExit = await lateRunner;
  assert.notEqual(lateExit.code, 0, 'the late old-epoch runner must exit nonzero without dispatching');
  const requests = await recordedRequests(recordPath);
  assert.equal(requests.filter((request) => request.method === 'session/send').length, 3, 'the late old-epoch runner is never a second driver');
  assert.equal(requests.filter((request) => request.method === 'session/create').length, 1);
  const resumes = requests.filter((request) => request.method === 'session/resume');
  assert.equal(resumes.length, 2);
  assert.deepEqual(resumes.map((resume) => resume.params?.sessionId), [anchorSession, anchorSession]);
});
