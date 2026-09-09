// @ts-nocheck
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { atomicWriteJson, withFileLock } from '../scripts/lib/fs.mjs';
import { isValidBrokerLaunchSignature } from '../scripts/lib/process.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';
import { ensureZCodeBroker, recordedWorkspaceBrokerPids, writeBrokerIdentity } from '../scripts/zcode-broker.mjs';

const fakeZCode = fileURLToPath(new URL('./fixtures/fake-zcode-cli.mjs', import.meta.url));

function processAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

async function waitForProcessExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  if (processAlive(pid)) assert.fail(`broker process ${pid} did not exit within ${timeoutMs}ms`);
}

/** A workspace fixture with real on-disk storage but no broker identity yet. */
async function emptyBrokerWorkspace(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, 'data'));
  await mkdir(join(root, 'workspace'));
  const workspace = await realpath(join(root, 'workspace'));
  const dataRoot = join(root, 'data');
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  return { root, dataRoot, workspace, storage };
}

/** Rewrites one durable identity as the previous plugin version published it:
 * the same healthy broker, but WITHOUT a recorded launch signature. */
async function rewriteIdentityAsLegacy(identityPath, record) {
  await writeBrokerIdentity(identityPath, { endpoint: record.endpoint, pid: record.pid, instanceId: record.instanceId, brokerToken: record.brokerToken });
}

/** The recorded broker launch signature the fixtures write into every durable
 * broker identity: the Windows termination funnel matches a snapshotted
 * process's command line against this signature before trusting its pid as a
 * broker exclusion. */
const FIXTURE_BROKER_LAUNCH = { command: 'C:\\Tools\\node.exe', args: ['C:\\ws\\broker\\zcode-broker.mjs', 'C:\\ws\\broker\\config-fixture.json'] };

/** A workspace fixture with one durable broker identity recorded, so the
 * broker-pid lookup has a complete, readable identity set to resolve. */
async function workspaceWithBrokerIdentity(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const dataRoot = join(root, 'data');
  await mkdir(join(root, 'workspace'));
  const workspace = await realpath(join(root, 'workspace'));
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const identity = await writeBrokerIdentity(join(storage.directory, 'broker', 'identity.json'), { endpoint: 'bounded-lookup-fixture-endpoint', launch: FIXTURE_BROKER_LAUNCH });
  return { root, dataRoot, workspace, identity, storage };
}

test('recordedWorkspaceBrokerPids resolves the durable broker identity pids and their launch signatures', async () => {
  const fixture = await workspaceWithBrokerIdentity('zcode-broker-lookup-resolved-');
  try {
    const outcome = await recordedWorkspaceBrokerPids({ dataRoot: fixture.dataRoot, workspace: fixture.workspace, timeoutMs: 1_000 });
    assert.deepEqual(outcome, {
      status: 'resolved',
      pids: [fixture.identity.pid],
      brokers: [{ pid: fixture.identity.pid, command: FIXTURE_BROKER_LAUNCH.command, args: FIXTURE_BROKER_LAUNCH.args }],
    }, 'the resolved exclusion carries each recorded broker pid WITH its recorded launch signature');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('recordedWorkspaceBrokerPids fails closed when a durable identity records no launch signature', async () => {
  const fixture = await workspaceWithBrokerIdentity('zcode-broker-lookup-launchless-');
  try {
    // A second identity entry WITHOUT a launch signature: the pid number alone
    // can never be proven to still be that broker instance, so the complete
    // identity-matched exclusion list is unprovable and the lookup must fail
    // closed (pid-only-kill territory) instead of forwarding a partial proof.
    await writeBrokerIdentity(join(fixture.storage.directory, 'broker', 'identity-1111111111111111.json'), { endpoint: 'launchless-profile-endpoint', pid: 111_000_004 });
    const outcome = await recordedWorkspaceBrokerPids({ dataRoot: fixture.dataRoot, workspace: fixture.workspace, timeoutMs: 1_000 });
    assert.deepEqual(outcome, { status: 'failed', pids: [], brokers: [] }, 'an identity without a provable launch signature makes the whole exclusion list unprovable');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('writeBrokerIdentity rejects an unbounded or malformed launch signature', async () => {
  const fixture = await workspaceWithBrokerIdentity('zcode-broker-identity-launch-shape-');
  try {
    await assert.rejects(
      writeBrokerIdentity(join(fixture.storage.directory, 'broker', 'identity-2222222222222222.json'), { endpoint: 'shape-endpoint', launch: { command: '', args: [] } }),
      { code: 'ZCODE_BROKER_INPUT_INVALID' },
      'an empty launch command is not a provable signature',
    );
    await assert.rejects(
      writeBrokerIdentity(join(fixture.storage.directory, 'broker', 'identity-3333333333333333.json'), { endpoint: 'shape-endpoint', launch: { command: 'node.exe', args: 'not-an-array' } }),
      { code: 'ZCODE_BROKER_INPUT_INVALID' },
      'launch arguments must be an array of strings',
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('recordedWorkspaceBrokerPids races the entire broker-lock acquisition against the caller budget', { timeout: 2_000 }, async () => {
  const fixture = await workspaceWithBrokerIdentity('zcode-broker-lookup-lock-stall-');
  try {
    const started = Date.now();
    const outcome = await recordedWorkspaceBrokerPids({
      dataRoot: fixture.dataRoot, workspace: fixture.workspace, timeoutMs: 100,
      // A wedged or heavily delayed data volume: the lock helper's internal
      // open/stat/layout I/O never settles, so its own polling timeout can
      // never fire — the whole acquisition must be raced against the budget.
      withFileLockFn: () => new Promise(() => {}),
    });
    const elapsedMs = Date.now() - started;
    assert.deepEqual(outcome, { status: 'failed', pids: [], brokers: [] }, 'a never-settling broker-lock acquisition fails closed at the budget');
    assert.ok(elapsedMs < 1_500, `the lookup returned at ${elapsedMs}ms instead of riding past its 100ms budget`);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('recordedWorkspaceBrokerPids bounds a stalled broker-directory scan at the caller budget', { timeout: 2_000 }, async () => {
  const fixture = await workspaceWithBrokerIdentity('zcode-broker-lookup-readdir-');
  try {
    const started = Date.now();
    const outcome = await recordedWorkspaceBrokerPids({
      dataRoot: fixture.dataRoot, workspace: fixture.workspace, timeoutMs: 100,
      readdirFn: () => new Promise(() => {}), // a slow or wedged plugin data directory
    });
    const elapsedMs = Date.now() - started;
    assert.deepEqual(outcome, { status: 'failed', pids: [], brokers: [] }, 'a stalled directory scan fails closed at the budget, pid-only-kill territory');
    assert.ok(elapsedMs < 1_500, `the lookup returned at ${elapsedMs}ms instead of riding past its 100ms budget`);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('holdResolvedLock release honors its bounded release budget on a never-settling lock handle', { timeout: 5_000 }, async () => {
  const fixture = await workspaceWithBrokerIdentity('zcode-broker-release-budget-');
  try {
    const lookup = await recordedWorkspaceBrokerPids({
      dataRoot: fixture.dataRoot, workspace: fixture.workspace, timeoutMs: 1_000, holdResolvedLock: true,
      // A wedged data volume: the scan operation completes (publishing the
      // release handle) but the withFileLock promise — its asynchronous
      // file-handle close included — never settles.
      withFileLockFn: (/** @type {string} */ lockPath, /** @type {() => Promise<any>} */ operation) => {
        operation().catch(() => {});
        return new Promise(() => {});
      },
    });
    assert.equal(lookup.status, 'resolved', 'sanity: the hold-resolved-lock lookup published the exclusion');
    assert.equal(typeof lookup.release, 'function');
    const started = Date.now();
    const outcome = await lookup.release(100);
    const elapsedMs = Date.now() - started;
    assert.ok(elapsedMs < 1_500, `release resolved at ${elapsedMs}ms instead of abandoning at its 100ms budget`);
    assert.deepEqual(
      { ...outcome, message: outcome.message === undefined ? undefined : 'diagnostic' },
      { released: false, reason: 'budget-expired', budgetMs: 100, message: 'diagnostic' },
      'an abandoned release surfaces a bounded diagnostic instead of blocking the lifecycle deadline');
    // Idempotent: a second release resolves bounded too, never re-blocking.
    const againStarted = Date.now();
    assert.equal((await lookup.release(50))?.budgetMs, 50);
    assert.ok(Date.now() - againStarted < 1_500, 'a repeated release stays bounded');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('holdResolvedLock release without an explicit budget defaults to a small bounded constant', { timeout: 5_000 }, async () => {
  const fixture = await workspaceWithBrokerIdentity('zcode-broker-release-default-');
  try {
    const lookup = await recordedWorkspaceBrokerPids({
      dataRoot: fixture.dataRoot, workspace: fixture.workspace, timeoutMs: 1_000, holdResolvedLock: true,
      withFileLockFn: (/** @type {string} */ lockPath, /** @type {() => Promise<any>} */ operation) => {
        operation().catch(() => {});
        return new Promise(() => {});
      },
    });
    assert.equal(lookup.status, 'resolved');
    const started = Date.now();
    const outcome = await lookup.release();
    const elapsedMs = Date.now() - started;
    assert.ok(elapsedMs < 1_500, `the default release wait resolved at ${elapsedMs}ms instead of staying bounded`);
    assert.deepEqual(
      { ...outcome, message: outcome.message === undefined ? undefined : 'diagnostic' },
      { released: false, reason: 'budget-expired', budgetMs: 250, message: 'diagnostic' },
      'the default release budget is the small bounded constant shared with the lookup bound');
    assert.match(String(outcome?.message), /self-heals/, 'the diagnostic documents the self-healing abandoned release');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('holdResolvedLock release resolves only once the lock is fully released and stays idempotent', { timeout: 5_000 }, async () => {
  const fixture = await workspaceWithBrokerIdentity('zcode-broker-release-full-');
  try {
    const lockPath = join(fixture.storage.directory, 'broker', '.lock');
    const lookup = await recordedWorkspaceBrokerPids({
      dataRoot: fixture.dataRoot, workspace: fixture.workspace, timeoutMs: 5_000, holdResolvedLock: true,
    });
    assert.equal(lookup.status, 'resolved');
    assert.equal(typeof lookup.release, 'function');
    // While the handle holds the startup lock, a plain acquisition cannot slip in.
    await assert.rejects(withFileLock(lockPath, async () => undefined, { timeoutMs: 0 }), { code: 'LOCK_TIMEOUT' },
      'the held lock must stay held until release() resolves');
    assert.equal(await lookup.release(), undefined, 'a fully-released release resolves without a diagnostic');
    // Full release: the very next plain acquisition succeeds inside the budget.
    await withFileLock(lockPath, async () => undefined, { timeoutMs: 2_000 });
    // Idempotent: a repeated release resolves without error and without blocking.
    assert.equal(await lookup.release(), undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('recordedWorkspaceBrokerPids bounds a stalled identity read at the caller budget', { timeout: 2_000 }, async () => {
  const fixture = await workspaceWithBrokerIdentity('zcode-broker-lookup-readfile-');
  try {
    const started = Date.now();
    const outcome = await recordedWorkspaceBrokerPids({
      dataRoot: fixture.dataRoot, workspace: fixture.workspace, timeoutMs: 100,
      inspectIdentityFn: () => new Promise(() => {}), // an identity read that never settles
    });
    const elapsedMs = Date.now() - started;
    assert.deepEqual(outcome, { status: 'failed', pids: [], brokers: [] }, 'a stalled identity read fails closed at the budget, pid-only-kill territory');
    assert.ok(elapsedMs < 1_500, `the lookup returned at ${elapsedMs}ms instead of riding past its 100ms budget`);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('recordedWorkspaceBrokerPids scans broker identities only while holding the broker startup lock', { timeout: 10_000 }, async () => {
  const fixture = await workspaceWithBrokerIdentity('zcode-broker-lookup-lock-order-');
  // The SAME advisory lock ensureZCodeBroker holds across broker spawn and
  // identity publication, held here by a simulated in-flight broker startup.
  const lockPath = join(fixture.storage.directory, 'broker', '.lock');
  let holderReleased = false;
  let releaseHolder = () => {};
  let holderAcquired = () => {};
  const holderAcquiredPromise = new Promise((resolve) => { holderAcquired = () => resolve(undefined); });
  const holder = withFileLock(lockPath, async () => {
    holderAcquired();
    await new Promise((resolve) => { releaseHolder = () => resolve(undefined); });
  });
  await holderAcquiredPromise;
  const scanObservations = [];
  try {
    const lookup = recordedWorkspaceBrokerPids({
      dataRoot: fixture.dataRoot, workspace: fixture.workspace, timeoutMs: 5_000,
      readdirFn: async (...args) => {
        scanObservations.push({ whileStartupLockHeld: !holderReleased });
        return readdir(...args);
      },
    });
    // Give an UNLOCKED scan ample time to wrongly read the identities while the
    // simulated startup still holds the lock; the serialized scan cannot run yet.
    await new Promise((resolve) => setTimeout(resolve, 200));
    holderReleased = true;
    releaseHolder();
    await holder;
    const outcome = await lookup;
    assert.deepEqual(outcome, {
      status: 'resolved',
      pids: [fixture.identity.pid],
      brokers: [{ pid: fixture.identity.pid, command: FIXTURE_BROKER_LAUNCH.command, args: FIXTURE_BROKER_LAUNCH.args }],
    });
    assert.equal(scanObservations.length, 1, 'the identity scan runs exactly once');
    assert.equal(scanObservations[0].whileStartupLockHeld, false,
      'the broker scan must wait for the broker startup lock instead of reading over a starting broker');
  } finally {
    releaseHolder();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('recordedWorkspaceBrokerPids reports a broker identity published under the startup lock as a complete list', { timeout: 10_000 }, async () => {
  const fixture = await workspaceWithBrokerIdentity('zcode-broker-lookup-publish-race-');
  const brokerDirectory = join(fixture.storage.directory, 'broker');
  const lockPath = join(brokerDirectory, '.lock');
  // A second identity exists BEFORE the scan, and a simulated starting profile
  // publishes its own identity WHILE HOLDING the startup lock — the exact
  // publish window an unlocked scan used to read over, returning a supposedly
  // complete list that is silently missing the starting broker. Distinct pids
  // keep the completeness assertion exact despite the pid dedupe.
  const starting = await writeBrokerIdentity(join(brokerDirectory, 'identity-1111111111111111.json'), { endpoint: 'starting-profile-endpoint', pid: 111_000_002, launch: FIXTURE_BROKER_LAUNCH });
  let releasePublisher = () => {};
  let publisherAcquired = () => {};
  const publisherAcquiredPromise = new Promise((resolve) => { publisherAcquired = () => resolve(undefined); });
  let publishNow = () => {};
  const publisher = withFileLock(lockPath, async () => {
    publisherAcquired();
    // Hold the startup lock until the lookup had its (unlocked) chance, then
    // publish INSIDE the lock and release — the ensureZCodeBroker critical section.
    await new Promise((resolve) => { publishNow = () => resolve(undefined); });
    await writeBrokerIdentity(join(brokerDirectory, 'identity-2222222222222222.json'), { endpoint: 'later-profile-endpoint', pid: 111_000_003, launch: FIXTURE_BROKER_LAUNCH });
    releasePublisher();
  });
  await publisherAcquiredPromise;
  try {
    const lookup = recordedWorkspaceBrokerPids({ dataRoot: fixture.dataRoot, workspace: fixture.workspace, timeoutMs: 5_000 });
    // An unlocked scan runs over the held startup lock and reads the
    // pre-publish identity set; the serialized scan is still waiting here.
    await new Promise((resolve) => setTimeout(resolve, 150));
    publishNow();
    await publisher;
    const outcome = await lookup;
    assert.deepEqual(
      [outcome.status, [...outcome.pids].sort((left, right) => left - right)],
      ['resolved', [fixture.identity.pid, starting.pid, 111_000_003].sort((left, right) => left - right)],
      'a broker published under the startup lock must be IN the exclusion list (or the lookup fails closed) — never a partial list',
    );
    assert.deepEqual(
      outcome.brokers.map((broker) => broker.pid).sort((left, right) => left - right),
      [...outcome.pids].sort((left, right) => left - right),
      'every resolved pid carries its identity-matching launch signature',
    );
    assert.ok(outcome.brokers.every((broker) => broker.command === FIXTURE_BROKER_LAUNCH.command && broker.args[1] === FIXTURE_BROKER_LAUNCH.args[1]), 'the recorded launch signature is forwarded per broker pid');
  } finally {
    releasePublisher();
    await publisher;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('recordedWorkspaceBrokerPids fails closed when a broker startup holds the lock past the lookup budget', { timeout: 10_000 }, async () => {
  const fixture = await workspaceWithBrokerIdentity('zcode-broker-lookup-lock-contended-');
  const lockPath = join(fixture.storage.directory, 'broker', '.lock');
  let releaseHolder = () => {};
  let holderAcquired = () => {};
  const holderAcquiredPromise = new Promise((resolve) => { holderAcquired = () => resolve(undefined); });
  const holder = withFileLock(lockPath, async () => {
    holderAcquired();
    await new Promise((resolve) => { releaseHolder = () => resolve(undefined); });
  });
  await holderAcquiredPromise;
  setTimeout(() => releaseHolder(), 400);
  try {
    const started = Date.now();
    const outcome = await recordedWorkspaceBrokerPids({ dataRoot: fixture.dataRoot, workspace: fixture.workspace, timeoutMs: 100 });
    const elapsedMs = Date.now() - started;
    assert.deepEqual(outcome, { status: 'failed', pids: [], brokers: [] },
      'a broker startup holding the lock past the budget fails closed to the pid-only kill instead of scanning over it');
    assert.ok(elapsedMs < 1_500, `the contended lookup returned at ${elapsedMs}ms instead of honoring its 100ms budget`);
  } finally {
    releaseHolder();
    await holder;
    await rm(fixture.root, { recursive: true, force: true });
  }
});


// LEGACY UPGRADE MIGRATION IS PASSIVE: a healthy launchless identity (a
// pre-launch-signature plugin version's broker, still serving after an
// in-place upgrade) is REUSED by every ensure — never signaled, never
// replaced. A legacy broker has no IPC to prove its transient admissions
// idle (a session/create is durably persisted only after the upstream
// request returns, so the owner registry can still be empty mid-create),
// so an active retirement could interrupt a live create and strand the
// remote session. Migration happens only when the legacy broker exits ON
// ITS OWN (its scheduleIdleShutdown window — ~30s by default — or a host
// shutdown) and its close removes its own identity; the next ensure then
// spawns the launch-signature replacement.

test('ensureZCodeBroker reuses a healthy launchless legacy identity in place — no signal, no replacement', { timeout: 30_000 }, async () => {
  const fixture = await emptyBrokerWorkspace('zcode-broker-legacy-reuse-');
  const brokerDirectory = join(fixture.storage.directory, 'broker');
  const identityPath = join(brokerDirectory, 'identity.json');
  const options = { dataRoot: fixture.dataRoot, workspace: fixture.workspace, launch: { command: process.execPath, args: [fakeZCode], target: fakeZCode }, idleTimeoutMs: 3_600_000 };
  let legacy = null;
  try {
    // The in-place-upgrade state: a healthy real broker started by the current
    // version, whose durable identity (rewritten the way the previous version
    // published it) carries no launch signature. The long idle timeout keeps
    // the legacy instance alive — only its own idle window, never an ensure,
    // may end it.
    legacy = await ensureZCodeBroker(options);
    assert.equal(isValidBrokerLaunchSignature(JSON.parse(await readFile(identityPath, 'utf8')).launch), true,
      'sanity: a broker started by the current version publishes a launch signature');
    await rewriteIdentityAsLegacy(identityPath, legacy);
    assert.equal(isValidBrokerLaunchSignature(JSON.parse(await readFile(identityPath, 'utf8')).launch), false, 'sanity: the rewritten identity is legacy');
    assert.deepEqual(await recordedWorkspaceBrokerPids({ dataRoot: fixture.dataRoot, workspace: fixture.workspace, timeoutMs: 1_000 }),
      { status: 'failed', pids: [], brokers: [] },
      'sanity: the strict lookup keeps failing closed on the legacy identity instead of trusting a bare pid');

    // The exact review finding: a session/create is durably persisted only
    // after the upstream request returns, so the durable owner registry can
    // still be MISSING while another client's create is in flight. The
    // passive migration never consults the registry: the healthy legacy
    // identity is reused unconditionally.
    const reused = await ensureZCodeBroker(options);
    assert.deepEqual(
      { pid: reused.pid, instanceId: reused.instanceId, brokerToken: reused.brokerToken, endpoint: reused.endpoint },
      { pid: legacy.pid, instanceId: legacy.instanceId, brokerToken: legacy.brokerToken, endpoint: legacy.endpoint },
      'the healthy legacy broker instance is reused as-is — no retire-and-restart that could interrupt an in-flight create',
    );
    assert.equal(JSON.parse(await readFile(identityPath, 'utf8')).instanceId, legacy.instanceId, 'no replacement identity is published over the legacy instance');
    assert.equal(processAlive(legacy.pid), true, 'the legacy broker receives no signal and keeps serving');
    assert.equal((await readdir(brokerDirectory)).some((name) => name.startsWith('config-')), false, 'the passive migration spawns nothing');

    // The same reuse with LIVE OWNED WORK: the durable owner registry records
    // one owned session — the shape of an already-running Rescue or Review
    // through the legacy broker.
    await atomicWriteJson(join(brokerDirectory, 'session-owners.json'), { version: 1, sessions: { 'zs-legacy-owned-session': 'c'.repeat(64) } });
    const reusedAgain = await ensureZCodeBroker(options);
    assert.equal(reusedAgain.pid, legacy.pid, 'a legacy broker that owns active sessions is equally reused, never retired');
    assert.equal(processAlive(legacy.pid), true, 'the owned-work legacy broker still receives no signal');

    assert.equal((await recordedWorkspaceBrokerPids({ dataRoot: fixture.dataRoot, workspace: fixture.workspace, timeoutMs: 1_000 })).status, 'failed',
      'the strict workspace lookup stays fail-closed for the whole passive legacy window (pid-only cleanup plus the pending sweep)');
    assert.equal((await readdir(brokerDirectory)).filter((name) => /^identity(?:-[0-9a-f]{16})?\.json$/u.test(name)).length, 1,
      'exactly the legacy identity remains — no second broker was started for the workspace');
  } finally {
    if (legacy?.pid && processAlive(legacy.pid)) try { process.kill(legacy.pid, 'SIGTERM'); } catch { /* already exited */ }
    if (legacy?.pid) await waitForProcessExit(legacy.pid, 2_000).catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});

/** Opens one unauthenticated connection to the broker and releases it: the
 * socket-close path schedules the broker's own idle shutdown (with no other
 * client or work), which is how a legacy broker exits on its own without any
 * signal. Used here to arm the SHORTEST practical window (3s) so the natural
 * exit is observable quickly; the production default window is ~30s. */
function armIdleShutdown(endpoint) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = net.createConnection(endpoint);
    socket.once('error', rejectPromise);
    socket.once('connect', () => socket.destroy());
    socket.once('close', () => resolvePromise(undefined));
  });
}

test('a legacy broker that exits on its own converges the workspace to a launch-signature broker', { timeout: 30_000 }, async () => {
  const fixture = await emptyBrokerWorkspace('zcode-broker-legacy-natural-exit-');
  const brokerDirectory = join(fixture.storage.directory, 'broker');
  const identityPath = join(brokerDirectory, 'identity.json');
  let legacy = null;
  let fresh = null;
  try {
    legacy = await ensureZCodeBroker({ dataRoot: fixture.dataRoot, workspace: fixture.workspace, launch: { command: process.execPath, args: [fakeZCode], target: fakeZCode }, idleTimeoutMs: 3_000 });
    await rewriteIdentityAsLegacy(identityPath, legacy);
    assert.equal((await recordedWorkspaceBrokerPids({ dataRoot: fixture.dataRoot, workspace: fixture.workspace, timeoutMs: 1_000 })).status, 'failed',
      'sanity: the launchless window keeps the lookup fail-closed');
    // Arm the idle window; the broker then exhausts it with no client left and
    // its graceful close removes its own identity — no signal is delivered.
    await armIdleShutdown(legacy.endpoint);
    await waitForProcessExit(legacy.pid, 15_000);
    await assert.rejects(readFile(identityPath, 'utf8'), { code: 'ENOENT' }, 'the natural close removed the legacy identity itself');
    assert.equal((await recordedWorkspaceBrokerPids({ dataRoot: fixture.dataRoot, workspace: fixture.workspace, timeoutMs: 1_000 })).status, 'absent',
      'after the natural exit the lookup is absent, so the sweep paths run per the platform rules');

    // The next ensure finds no healthy identity and spawns the launch-signature
    // replacement — the convergence the passive migration defers to. The same
    // absent-outcome convergence is exercised for the termination funnel by
    // the Windows absent-sweep tests in tests/job-control.test.mjs (proven-empty
    // exclusion set, identity rescan under the reacquired lock) and the
    // pid-only degradation in tests/process-zcode.test.mjs.
    fresh = await ensureZCodeBroker({ dataRoot: fixture.dataRoot, workspace: fixture.workspace, launch: { command: process.execPath, args: [fakeZCode], target: fakeZCode }, idleTimeoutMs: 3_600_000 });
    assert.notEqual(fresh.pid, legacy.pid, 'the replacement is a fresh instance, not the exited legacy one');
    const published = JSON.parse(await readFile(identityPath, 'utf8'));
    assert.equal(published.pid, fresh.pid, 'the replacement identity is the fresh instance');
    assert.equal(isValidBrokerLaunchSignature(published.launch), true, 'the replacement identity carries a provable launch signature');
    const outcome = await recordedWorkspaceBrokerPids({ dataRoot: fixture.dataRoot, workspace: fixture.workspace, timeoutMs: 1_000 });
    assert.equal(outcome.status, 'resolved', 'the workspace lookup resolves again once no launchless identity remains');
    assert.deepEqual(outcome.pids, [fresh.pid]);
    assert.equal(outcome.brokers[0].command, published.launch.command, 'the resolved exclusion carries the recorded launch signature');
  } finally {
    for (const record of [legacy, fresh]) {
      if (record?.pid && processAlive(record.pid)) try { process.kill(record.pid, 'SIGTERM'); } catch { /* already exited */ }
      if (record?.pid) await waitForProcessExit(record.pid, 2_000).catch(() => {});
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});
