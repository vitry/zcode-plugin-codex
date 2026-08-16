// @ts-nocheck
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { buildMarketplaceSnapshot } from '../../scripts/build-marketplace-snapshot.mjs';
import { runProcess } from '../../scripts/lib/process.mjs';
import { withWorkerLease } from '../../scripts/lib/recovery.mjs';
import { codexLaunch, npmLaunch } from '../../scripts/lib/tool-launch.mjs';
import { resolveWorkspaceStorage } from '../../scripts/lib/workspace.mjs';
import {
  assertCodexRescueDisplayName,
  CodexRescueEvidenceMismatchError,
  CodexRescueUnqualifiedError,
  parseCodexRolloutJsonl,
  qualifyCodexRescueBackgroundEvidence,
  qualifyCodexRescueChoiceEvidence,
  qualifyCodexRescueEvidence,
} from '../helpers/codex-rescue-qualification.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fakeZCode = fileURLToPath(new URL('../fixtures/fake-zcode-cli.mjs', import.meta.url));
const TEST_PROCESS_NONCE = 'a'.repeat(64);
const STALE_PROCESS_NONCE = 'b'.repeat(64);
const SUPPORTED_CODEX_LINES = Object.freeze(['0.147']);
const RESCUE_DISPLAY_PRIVATE_SENTINELS = Object.freeze([
  'repaircanary', 'privpromptcanary', 'privpathcanary', 'privworkcanary',
  'privsesscanary', 'privjobcanary', 'privcapcanary', 'privargcanary',
]);
const qualificationRequired = process.env.ZCODE_REQUIRE_QUALIFIED === '1';
const optInSkip = process.env.ZCODE_CODEX_SKILLS_E2E === '1' || qualificationRequired ? false : unqualified('opt-in-required', 'Set ZCODE_CODEX_SKILLS_E2E=1 to spend authenticated Codex credits.');
const rescueOptInSkip = process.env.ZCODE_CODEX_RESCUE_E2E === '1' || qualificationRequired ? false : unqualified('opt-in-required', 'Set ZCODE_CODEX_RESCUE_E2E=1 to qualify the runtime-observed native Rescue route.');

function assertRescueDisplayOmitsPrivateSentinels(display) {
  const displayIdentity = `${display.taskName}\n${display.agentPath}`.toLowerCase();
  for (const sentinel of RESCUE_DISPLAY_PRIVATE_SENTINELS) {
    assert.equal(displayIdentity.includes(sentinel.toLowerCase()), false, `Rescue display identity copied private installed sentinel: ${sentinel}`);
  }
}

function assertInstalledRescueDisplay(evidence) {
  const display = assertCodexRescueDisplayName(evidence);
  assert.equal(display.displayNameConforms, true);
  assertRescueDisplayOmitsPrivateSentinels(display);
  return display;
}

function installedRescueChoiceFacts(rollouts, parentThreadId, requireFollowup) {
  assert.ok(Array.isArray(rollouts), 'choice linkage requires rollout evidence');
  assert.ok(typeof parentThreadId === 'string' && parentThreadId.length > 0, 'choice linkage requires the exact parent thread ID');
  const parentCandidates = rollouts.filter((events) => Array.isArray(events)
    && events.some((event) => event?.type === 'session_meta' && event.payload?.id === parentThreadId));
  assert.equal(parentCandidates.length, 1, 'choice linkage must expose exactly one parent rollout');
  const parent = parentCandidates[0];
  const calls = (name) => parent.filter((event) => event?.type === 'response_item' && event.payload?.type === 'function_call' && event.payload.name === name);
  const spawns = calls('spawn_agent'); const followups = calls('followup_task');
  const starts = parent.filter((event) => event?.type === 'event_msg' && event.payload?.type === 'sub_agent_activity' && event.payload.kind === 'started');
  assert.equal(spawns.length, 1, 'choice linkage must expose exactly one original spawn');
  assert.equal(starts.length, 1, 'choice linkage must expose exactly one original child start');
  assert.equal(followups.length, requireFollowup ? 1 : 0, `choice linkage must expose ${requireFollowup ? 'one continuation follow-up' : 'no follow-up before resume'}`);
  const spawnArgs = JSON.parse(spawns[0].payload.arguments);
  const taskName = spawnArgs.task_name; const agentPath = starts[0].payload.agent_path; const childThreadId = starts[0].payload.agent_thread_id;
  assert.ok(typeof taskName === 'string' && typeof agentPath === 'string' && typeof childThreadId === 'string', 'choice linkage rollout must expose all original child identity fields');
  const childCandidates = rollouts.filter((events) => Array.isArray(events)
    && events.some((event) => event?.type === 'session_meta' && event.payload?.id === childThreadId));
  assert.equal(childCandidates.length, 1, 'choice linkage must expose exactly one retained child rollout');
  const childMetas = childCandidates[0].filter((event) => event?.type === 'session_meta');
  assert.equal(childMetas.length, 1, 'choice linkage retained child must expose one metadata record');
  assert.equal(childMetas[0].payload.id, childThreadId, 'choice child metadata must retain the original child ID');
  assert.equal(childMetas[0].payload.parent_thread_id, parentThreadId, 'choice child metadata must retain the original parent ID');
  assert.equal(childMetas[0].payload.source?.subagent?.thread_spawn?.agent_path, agentPath, 'choice child metadata path must retain the original agent path');
  return { taskName, agentPath, childThreadId, followupTarget: requireFollowup ? JSON.parse(followups[0].payload.arguments).target : undefined };
}

function captureInstalledRescueChoiceIdentity(rollouts, parentThreadId) {
  const { taskName, agentPath, childThreadId } = installedRescueChoiceFacts(rollouts, parentThreadId, false);
  return Object.freeze({ taskName, agentPath, childThreadId });
}

function assertInstalledRescueChoiceIdentityLinkage(postRollouts, parentThreadId, evidence, pendingIdentity) {
  assert.ok(evidence && typeof evidence === 'object', 'choice linkage requires qualified evidence');
  assert.ok(pendingIdentity && typeof pendingIdentity === 'object', 'choice linkage requires the independent pending snapshot');
  for (const field of ['taskName', 'agentPath', 'childThreadId']) {
    assert.ok(typeof pendingIdentity[field] === 'string' && pendingIdentity[field].length > 0, `pending snapshot must expose ${field}`);
    assert.equal(evidence[field], pendingIdentity[field], `choice evidence ${field} must match the pending snapshot`);
  }
  const post = installedRescueChoiceFacts(postRollouts, parentThreadId, true);
  for (const field of ['taskName', 'agentPath', 'childThreadId']) {
    assert.equal(post[field], pendingIdentity[field], `post-continuation ${field} must match the pending snapshot`);
  }
  assert.equal(post.followupTarget, pendingIdentity.childThreadId, 'post-continuation follow-up target must match the pending snapshot child ID');
}

function installedRescueQualificationBody(source) {
  const startName = ['installed Rescue uses one isolated native child', 'for initial and choice continuations'].join(' ');
  const endName = ['installed Rescue display privacy rejects case-insensitive private substrings', 'without generic-word collisions'].join(' ');
  const startMarker = `test('${startName}'`;
  const endMarker = `test('${endName}'`;
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  assert.notEqual(start, -1, 'installed Rescue qualification start marker must exist');
  assert.notEqual(end, -1, 'installed Rescue qualification end marker must exist');
  assert.ok(start < end, 'installed Rescue qualification markers must be ordered');
  return source.slice(start, end);
}

function assertInstalledRescueQualificationSource(source) {
  const installedQualification = installedRescueQualificationBody(source);
  assert.doesNotMatch(installedQualification, /expected(?:TaskName|AgentPath)\s*:/u, 'installed qualification must not pin model-selected display identity');
  const foreground = exactSourceRegion(installedQualification,
    '  try {\n    const evidence = qualifyCodexRescueEvidence(', '\n\n  for (const choice', 'foreground qualifier');
  const choice = exactSourceRegion(installedQualification,
    '    try {\n      const evidence = qualifyCodexRescueChoiceEvidence(', '\n    const choiceCalls', 'choice qualifier');
  const background = exactSourceRegion(installedQualification,
    '    try {\n      const evidence = qualifyCodexRescueBackgroundEvidence(', '\n    await writeFile(backgroundGate', 'background qualifier');
  assert.equal(installedQualification.match(/\bqualifyCodexRescueEvidence\(/gu)?.length, 1, 'foreground qualifier must have one installed call site');
  assert.equal(installedQualification.match(/\bqualifyCodexRescueChoiceEvidence\(/gu)?.length, 1, 'choice qualifier must have one installed call site');
  assert.equal(installedQualification.match(/\bqualifyCodexRescueBackgroundEvidence\(/gu)?.length, 1, 'background qualifier must have one installed call site');
  assertInstalledSourceBranch(foreground, 'foreground', false);
  assertInstalledSourceBranch(choice, 'choice', true);
  assertInstalledSourceBranch(background, 'background', false);
  assertSourceOrder(installedQualification, [
    'const pendingFrames =',
    'const pendingIdentity = captureInstalledRescueChoiceIdentity(pendingRollouts, parentIds[0]);',
    'const answer = await codex([',
    'qualifyCodexRescueChoiceEvidence(',
  ], 'choice pending snapshot');
}

function exactSourceRegion(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker); const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `${label} start marker must exist`);
  assert.notEqual(end, -1, `${label} end marker must exist`);
  assert.ok(start < end, `${label} markers must be ordered`);
  return source.slice(start, end);
}

function assertInstalledSourceBranch(region, label, requireChoiceLinkage) {
  const catchMarker = '} catch (error) {';
  const catchIndex = region.indexOf(catchMarker);
  assert.ok(catchIndex > 0, `${label} qualifier catch must exist`);
  const success = region.slice(0, catchIndex); const encrypted = region.slice(catchIndex);
  assertSourceOrder(success, [
    `qualifyCodexRescue${label === 'foreground' ? '' : label === 'choice' ? 'Choice' : 'Background'}Evidence(`,
    'assertInstalledRescueDisplay(evidence);',
    ...(requireChoiceLinkage ? ['assertInstalledRescueChoiceLinkage(choiceRollouts, parentIds[0], evidence, pendingIdentity);'] : []),
  ], `${label} display${requireChoiceLinkage ? ' and linkage' : ''}`);
  const guardMarker = label === 'choice'
    ? "if (error instanceof CodexRescueUnqualifiedError && ['choice-followup-encrypted', 'choice-spawn-encrypted'].includes(error.code)) {"
    : "if (error instanceof CodexRescueUnqualifiedError && error.code === 'spawn-message-encrypted') {";
  assert.equal(encrypted.split(guardMarker).length - 1, 1, `${label} encrypted guard predicate must occur exactly once`);
  const guardStart = encrypted.indexOf(guardMarker);
  const guardCloseMarker = label === 'foreground' ? '\n    }' : '\n      }';
  const guardEnd = encrypted.indexOf(guardCloseMarker, guardStart + guardMarker.length);
  assert.ok(guardEnd > guardStart, `${label} encrypted guard closing brace must exist`);
  const guarded = encrypted.slice(guardStart, guardEnd);
  assertSourceOrder(guarded, [
    guardMarker,
    'assertInstalledRescueDisplay(error.evidence);',
    ...(requireChoiceLinkage ? ['assertInstalledRescueChoiceLinkage(choiceRollouts, parentIds[0], error.evidence, pendingIdentity);'] : []),
    'markUnqualified(',
    'return;',
  ], `${label} encrypted guard display${requireChoiceLinkage ? ' and linkage' : ''}`);
}

function assertSourceOrder(source, markers, label) {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker, previous + 1);
    assert.ok(index > previous, `${label} assertion must remain in its branch and before any early return: ${marker}`);
    previous = index;
  }
}

test('foreground Rescue gate lifecycle releases and cleans exact processes on gate discovery timeout', async () => {
  const events = []; let rejectCodex; let alive = true;
  const result = new Promise((_, reject) => { rejectCodex = reject; });
  await assert.rejects(runHeldForegroundRescue({
    gatePath: '/exact/gate', processPath: '/exact/process.json', processNonce: TEST_PROCESS_NONCE,
    launch: () => ({ result, terminate: async () => { events.push('terminate-codex'); rejectCodex(new Error('terminated exact Codex')); throw new Error('Codex termination reported failure'); } }),
    waitForGate: async () => { throw new Error('gate discovery timeout'); },
    readProcessMarker: async () => ({ pid: 48123, ppid: 71, nonce: TEST_PROCESS_NONCE }), inspectProcessIdentity: async () => alive ? ({ pid: 48123, ppid: 71, startIdentity: 'start-a', processNonce: TEST_PROCESS_NONCE }) : undefined,
    releaseGate: async (path) => { events.push(`release:${path}`); }, terminateExactProcess: async (identity) => { events.push(`terminate-pid:${identity.pid}`); alive = false; },
    waitForProcessExit: async (identity) => { events.push(`wait-pid:${identity.pid}`); }, holdMs: 0,
  }), /gate discovery timeout/);
  assert.deepEqual(events, ['release:/exact/gate', 'terminate-pid:48123', 'wait-pid:48123', 'terminate-codex']);
});

test('foreground Rescue gate lifecycle consumes Codex failure and releases the exact gate', async () => {
  const events = []; let alive = true;
  await assert.rejects(runHeldForegroundRescue({
    gatePath: '/exact/gate', processPath: '/exact/process.json', processNonce: TEST_PROCESS_NONCE,
    launch: () => ({ result: Promise.reject(new Error('Codex failed')), terminate: async () => { events.push('terminate-codex'); } }),
    waitForGate: (signal) => new Promise((resolvePromise) => signal.addEventListener('abort', resolvePromise, { once: true })),
    readProcessMarker: async () => ({ pid: 59123, ppid: 72, nonce: TEST_PROCESS_NONCE }), inspectProcessIdentity: async () => alive ? ({ pid: 59123, ppid: 72, startIdentity: 'start-a', processNonce: TEST_PROCESS_NONCE }) : undefined,
    releaseGate: async (path) => { events.push(`release:${path}`); }, terminateExactProcess: async (identity) => { events.push(`terminate-pid:${identity.pid}`); alive = false; },
    waitForProcessExit: async (identity) => { events.push(`wait-pid:${identity.pid}`); }, holdMs: 0,
  }), /Codex failed/);
  assert.deepEqual(events, ['release:/exact/gate', 'terminate-pid:59123', 'wait-pid:59123', 'terminate-codex']);
});

test('foreground Rescue gate lifecycle cleans an exact fake child that does not exit naturally', async () => {
  const events = []; let gateReleased = false; let alive = true; let resolveCodex;
  const result = new Promise((resolvePromise) => { resolveCodex = resolvePromise; });
  await assert.rejects(runHeldForegroundRescue({
    gatePath: '/exact/gate', processPath: '/exact/process.json', processNonce: TEST_PROCESS_NONCE, launch: () => ({ result }),
    waitForGate: async () => {}, readProcessMarker: async () => ({ pid: 60123, ppid: 73, nonce: TEST_PROCESS_NONCE }), inspectProcessIdentity: async () => alive ? ({ pid: 60123, ppid: 73, startIdentity: 'start-a', processNonce: TEST_PROCESS_NONCE }) : undefined,
    releaseGate: async () => { gateReleased = true; events.push('release'); resolveCodex({ code: 0, stdout: '', stderr: '' }); }, sleep: async () => {},
    waitForProcessExit: async (identity, phase) => { events.push(`wait-${phase}:${identity.pid}`); if (phase === 'natural') throw new Error('fake child did not exit'); },
    terminateExactProcess: async (identity) => { assert.equal(gateReleased, true); events.push(`terminate-pid:${identity.pid}`); alive = false; }, holdMs: 0,
  }), /fake child did not exit/);
  assert.deepEqual(events, ['release', 'wait-natural:60123', 'terminate-pid:60123', 'wait-cleanup:60123']);
});

test('foreground Rescue gate lifecycle releases the exact gate when launch throws synchronously', async () => {
  const released = [];
  await assert.rejects(runHeldForegroundRescue({
    gatePath: '/exact/gate', processPath: '/exact/process.json', processNonce: TEST_PROCESS_NONCE,
    launch: () => { throw new Error('synchronous launch failure'); },
    waitForGate: async () => { assert.fail('gate wait must not start before launch succeeds'); },
    releaseGate: async (path) => { released.push(path); }, holdMs: 0,
  }), /synchronous launch failure/);
  assert.deepEqual(released, ['/exact/gate']);
});

test('foreground Rescue early Codex result aborts and awaits the losing gate wait', async () => {
  let aborted = false; let awaited = false; const events = [];
  const foreground = await runHeldForegroundRescue({
    gatePath: '/exact/gate', processPath: '/exact/process.json', processNonce: TEST_PROCESS_NONCE,
    launch: () => ({ result: Promise.resolve({ code: 0, stdout: '', stderr: '' }), terminate: async () => { events.push('terminate'); } }),
    waitForGate: (signal) => new Promise((resolvePromise) => signal.addEventListener('abort', () => {
      aborted = true; queueMicrotask(() => { awaited = true; resolvePromise(); });
    }, { once: true })),
    readProcessMarker: async () => { const error = new Error('marker absent'); error.code = 'ENOENT'; throw error; }, releaseGate: async () => { events.push('release'); }, holdMs: 0,
  });
  assert.equal(foreground.endedBeforeGate, true);
  assert.equal(aborted, true); assert.equal(awaited, true);
  assert.deepEqual(events, ['release', 'terminate']);
});

test('foreground Rescue refuses to signal stale, nonce-mismatched, or reparented process identities', async (t) => {
  const cases = [
    {
      name: 'stale marker nonce', marker: { pid: 61123, ppid: 71, nonce: STALE_PROCESS_NONCE },
      inspect: async () => ({ pid: 61123, ppid: 71, startIdentity: 'start-a', processNonce: TEST_PROCESS_NONCE }), pattern: /nonce changed|nonce mismatch/i,
    },
    {
      name: 'reparented process', marker: { pid: 61124, ppid: 72, nonce: TEST_PROCESS_NONCE },
      inspect: async () => ({ pid: 61124, ppid: 73, startIdentity: 'start-a', processNonce: TEST_PROCESS_NONCE }), pattern: /parent identity changed|parent.*mismatch/i,
    },
    {
      name: 'same-second PID reuse', marker: { pid: 61125, ppid: 74, nonce: TEST_PROCESS_NONCE },
      inspect: (() => { let reads = 0; return async () => ({ pid: 61125, ppid: 74, startIdentity: 'same-second', processNonce: reads++ === 0 ? TEST_PROCESS_NONCE : STALE_PROCESS_NONCE }); })(),
      failAfterCapture: true, pattern: /process identity changed/i,
    },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    let terminated = false; let codexTerminated = false; let rejectCodex;
    const result = new Promise((_, reject) => { rejectCodex = reject; });
    await assert.rejects(runHeldForegroundRescue({
      gatePath: '/exact/gate', processPath: '/exact/process.json', processNonce: TEST_PROCESS_NONCE,
      launch: () => ({ result, terminate: async () => { codexTerminated = true; rejectCodex(new Error('terminated exact Codex')); } }), waitForGate: async () => {},
      readProcessMarker: async () => scenario.marker, inspectProcessIdentity: scenario.inspect,
      releaseGate: async () => {}, sleep: async () => { if (scenario.failAfterCapture) throw new Error('verify cleanup identity'); },
      terminateExactProcess: async () => { terminated = true; }, waitForProcessExit: async () => {}, holdMs: 0,
    }), scenario.pattern);
    assert.equal(terminated, false, 'identity mismatch must never signal an unrelated PID');
    assert.equal(codexTerminated, true, 'identity mismatch must not prevent exact Codex termination');
  });
});

test('foreground Rescue reports cleanup identity change without signaling the reused PID', async () => {
  let reads = 0; let terminated = false; let rejectCodex;
  const result = new Promise((_, reject) => { rejectCodex = reject; });
  await assert.rejects(runHeldForegroundRescue({
    gatePath: '/exact/gate', processPath: '/exact/process.json', processNonce: TEST_PROCESS_NONCE,
    launch: () => ({ result, terminate: async () => { rejectCodex(new Error('terminated exact Codex')); } }), waitForGate: async () => {},
    readProcessMarker: async () => ({ pid: 62123, ppid: 81, nonce: TEST_PROCESS_NONCE }),
    inspectProcessIdentity: async () => ({ pid: 62123, ppid: 81, startIdentity: reads++ === 0 ? 'start-a' : 'start-b', processNonce: TEST_PROCESS_NONCE }),
    releaseGate: async () => {}, sleep: async () => { throw new Error('held verification failed'); },
    terminateExactProcess: async () => { terminated = true; }, holdMs: 0,
  }), /process identity changed during cleanup/i);
  assert.equal(terminated, false);
});

test('foreground Rescue cleans the exact fake child before Codex termination can reparent it', async () => {
  const events = []; let alive = true; let reparented = false; let rejectCodex;
  const result = new Promise((_, reject) => { rejectCodex = reject; });
  await assert.rejects(runHeldForegroundRescue({
    gatePath: '/exact/gate', processPath: '/exact/process.json', processNonce: TEST_PROCESS_NONCE,
    launch: () => ({ result, terminate: async () => { events.push('terminate-codex'); reparented = true; rejectCodex(new Error('terminated exact Codex')); } }),
    waitForGate: async () => {},
    readProcessMarker: async () => ({ pid: 63123, ppid: 91, nonce: TEST_PROCESS_NONCE }),
    inspectProcessIdentity: async () => alive ? ({ pid: 63123, ppid: reparented ? 1 : 91, startIdentity: 'start-a', processNonce: TEST_PROCESS_NONCE }) : undefined,
    releaseGate: async () => { events.push('release'); },
    terminateExactProcess: async () => { events.push('terminate-child'); alive = false; },
    waitForProcessExit: async (_identity, phase) => { events.push(`wait-child:${phase}`); assert.equal(alive, false); },
    sleep: async () => { throw new Error('held verification failed'); }, holdMs: 0,
  }), /held verification failed/);
  assert.deepEqual(events, ['release', 'terminate-child', 'wait-child:cleanup', 'terminate-codex']);
  assert.equal(alive, false);
});

test('foreground Rescue still terminates Codex after exact child cleanup fails', async () => {
  const events = []; let rejectCodex;
  const result = new Promise((_, reject) => { rejectCodex = reject; });
  await assert.rejects(runHeldForegroundRescue({
    gatePath: '/exact/gate', processPath: '/exact/process.json', processNonce: TEST_PROCESS_NONCE,
    launch: () => ({ result, terminate: async () => { events.push('terminate-codex'); rejectCodex(new Error('terminated exact Codex')); } }),
    waitForGate: async () => {},
    readProcessMarker: async () => ({ pid: 63124, ppid: 92, nonce: TEST_PROCESS_NONCE }),
    inspectProcessIdentity: async () => ({ pid: 63124, ppid: 92, startIdentity: 'start-a', processNonce: TEST_PROCESS_NONCE }), releaseGate: async () => { events.push('release'); },
    terminateExactProcess: async () => { events.push('terminate-child'); throw new Error('exact child cleanup failed'); },
    waitForProcessExit: async () => { events.push('wait-child'); throw new Error('exact child remained alive'); },
    sleep: async () => { throw new Error('held verification failed'); }, holdMs: 0,
  }), /held verification failed/);
  assert.deepEqual(events, ['release', 'terminate-child', 'wait-child', 'terminate-codex']);
});

test('preserved installed evidence scrubs isolated credential copies on normal, thrown, and timed-out cleanup', async (t) => {
  for (const mode of ['normal', 'sync-throw', 'timeout']) await t.test(mode, async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'zcode-installed-evidence-cleanup-')); t.after(() => rm(temporary, { recursive: true, force: true }));
    const codexHome = join(temporary, 'codex-home'); const evidence = join(temporary, 'evidence.jsonl'); const auth = join(codexHome, 'auth.json'); const copied = join(codexHome, 'auth-copy.json');
    const outside = join(dirname(temporary), `${basename(temporary)}-real-auth.json`); const linked = join(codexHome, 'linked-auth.json'); const secret = `credential-${mode}-must-not-enter-diagnostics`;
    await mkdir(codexHome, { recursive: true, mode: 0o700 }); await Promise.all([writeFile(auth, secret, { mode: 0o600 }), writeFile(copied, secret, { mode: 0o600 }), writeFile(outside, secret, { mode: 0o600 }), writeFile(evidence, 'preserved failure evidence')]); await symlink(outside, linked);
    t.after(() => rm(outside, { force: true })); const diagnostics = []; const deadlineStages = []; let stalledRemovals = 0;
    const removeCredential = mode === 'sync-throw' ? () => { throw new Error(secret); }
      : mode === 'timeout' ? () => { stalledRemovals += 1; return new Promise(() => {}); } : undefined;
    const runCleanupDeadline = mode === 'timeout' ? async (operation, _timeoutMs, stage) => {
      deadlineStages.push(stage); const pending = Promise.resolve().then(operation); await Promise.resolve();
      if (stage === 'credential') throw new Error('installed evidence cleanup timed out');
      return pending;
    } : undefined;
    await cleanupInstalledEvidence({
      credentialPaths: [auth, copied, linked],
      diagnostic: (message) => diagnostics.push(message),
      preserve: true,
      removeCredential,
      runCleanupDeadline,
      temporary,
    });
    assert.equal(await readFile(evidence, 'utf8'), 'preserved failure evidence');
    for (const credential of [auth, copied, linked]) await assert.rejects(stat(credential), { code: 'ENOENT' });
    assert.equal(await readFile(outside, 'utf8'), secret, 'cleanup must unlink only the isolated symlink, never the external auth target');
    assert.doesNotMatch(diagnostics.join('\n'), new RegExp(secret)); assert.match(diagnostics.join('\n'), /preserved installed evidence/);
    if (mode === 'timeout') { assert.equal(stalledRemovals, 3); assert.deepEqual(deadlineStages, ['credential', 'fallback', 'credential', 'fallback', 'credential', 'fallback']); }
  });
  await t.test('outside exact path is rejected without deleting user auth', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'zcode-installed-evidence-outside-')); const evidence = join(temporary, 'evidence.jsonl'); const outside = join(dirname(temporary), `${basename(temporary)}-user-auth.json`); const secret = 'outside-user-auth-secret';
    await Promise.all([writeFile(evidence, 'failure evidence'), writeFile(outside, secret, { mode: 0o600 })]); t.after(() => Promise.all([rm(temporary, { recursive: true, force: true }), rm(outside, { force: true })]));
    await assert.rejects(cleanupInstalledEvidence({ credentialPaths: [outside], preserve: true, temporary }), /could not be scrubbed safely/);
    assert.equal(await readFile(outside, 'utf8'), secret);
  });
});

test('installed Rescue qualification declares its supported Codex line and a scoped TUI observation', async (t) => {
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.devDependencies?.['@openai/codex'], '0.147.0');
  assert.deepEqual(SUPPORTED_CODEX_LINES, ['0.147']);
  const diagnostic = observation(
    'tui-evidence-not-exposed',
    'tui',
    'The exec/app-server harness exposes no interactive /agent, /subagents, or current-thread /ps events; those UI observations are not qualification evidence.',
  );
  const payload = JSON.parse(diagnostic.slice('codex-skills-observation '.length));
  assert.deepEqual(payload, { observed: false, code: 'tui-evidence-not-exposed', qualificationScope: 'tui', detail: payload.detail });
  assert.equal(Object.hasOwn(payload, 'qualified'), false, 'a harness-scoped TUI observation must not claim qualification success or failure');
  t.diagnostic(diagnostic);
});

test('installed Rescue qualification source checks every dynamic display identity independently', async () => {
  const source = await readFile(fileURLToPath(import.meta.url), 'utf8');
  assertInstalledRescueQualificationSource(source);
});

test('installed Rescue source contract rejects moved, unreachable, and missing branch checks', async () => {
  const source = await readFile(fileURLToPath(import.meta.url), 'utf8');
  const foregroundDisplay = '    assertInstalledRescueDisplay(evidence);\n';
  const choiceDisplayAnchor = '      assertInstalledRescueDisplay(evidence);\n';
  const movedToWrongBranch = source.replace(foregroundDisplay, '').replace(choiceDisplayAnchor, `${foregroundDisplay}${choiceDisplayAnchor}`);
  assert.throws(() => assertInstalledRescueQualificationSource(movedToWrongBranch), /foreground display/u);

  const encryptedDisplay = '      assertInstalledRescueDisplay(error.evidence);\n';
  const foregroundMark = '      markUnqualified(t, unqualified(error.code, detail)); return;';
  const movedAfterReturn = source.replace(encryptedDisplay, '').replace(foregroundMark, `${foregroundMark}\n${encryptedDisplay}`);
  assert.throws(() => assertInstalledRescueQualificationSource(movedAfterReturn), /foreground encrypted guard display/u);

  const missingChoiceLinkage = source.replace('        assertInstalledRescueChoiceLinkage(choiceRollouts, parentIds[0], error.evidence, pendingIdentity);\n', '');
  assert.throws(() => assertInstalledRescueQualificationSource(missingChoiceLinkage), /choice encrypted guard display and linkage/u);

  const foregroundCatch = '  } catch (error) {\n';
  const foregroundPredicate = "    if (error instanceof CodexRescueUnqualifiedError && error.code === 'spawn-message-encrypted') {\n";
  const movedDisplayAboveGuard = source.replace(encryptedDisplay, '').replace(foregroundCatch + foregroundPredicate, foregroundCatch + encryptedDisplay + foregroundPredicate);
  assert.throws(() => assertInstalledRescueQualificationSource(movedDisplayAboveGuard), /foreground encrypted guard/u);

  const choiceEncryptedChecks = '        assertInstalledRescueDisplay(error.evidence);\n        assertInstalledRescueChoiceLinkage(choiceRollouts, parentIds[0], error.evidence, pendingIdentity);\n';
  const choiceCatch = '    } catch (error) {\n';
  const choicePredicate = "      if (error instanceof CodexRescueUnqualifiedError && ['choice-followup-encrypted', 'choice-spawn-encrypted'].includes(error.code)) {\n";
  const movedChoiceChecksAboveGuard = source.replace(choiceEncryptedChecks, '').replace(choiceCatch + choicePredicate, choiceCatch + choiceEncryptedChecks + choicePredicate);
  assert.throws(() => assertInstalledRescueQualificationSource(movedChoiceChecksAboveGuard), /choice encrypted guard/u);
});

test('installed marketplace skill crosses a real ephemeral Codex turn into ZCode', { skip: optInSkip, timeout: 240_000 }, async (t) => {
  if (process.env.ZCODE_CODEX_SKILLS_E2E !== '1') assert.fail(unqualified('opt-in-required', 'Required qualification needs ZCODE_CODEX_SKILLS_E2E=1.'));
  const temporary = await mkdtemp(join(tmpdir(), 'zcode-codex-skills-e2e-'));
  const codexHome = join(temporary, 'codex-home'); const home = join(temporary, 'home'); const marketplace = join(temporary, 'marketplace'); const workspace = join(temporary, 'workspace'); const zcodeRecord = join(temporary, 'zcode.jsonl');
  const isolatedAuthPath = join(codexHome, 'auth.json'); t.after(() => cleanupInstalledEvidence({ credentialPaths: [isolatedAuthPath], preserve: false, temporary }));
  await Promise.all([mkdir(codexHome, { recursive: true, mode: 0o700 }), mkdir(home, { recursive: true, mode: 0o700 }), mkdir(workspace, { recursive: true }), writeFile(zcodeRecord, '')]);
  const sourceCodexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  try { await stat(join(sourceCodexHome, 'auth.json')); await cp(join(sourceCodexHome, 'auth.json'), isolatedAuthPath); await chmod(isolatedAuthPath, 0o600); }
  catch { markUnqualified(t, unqualified('auth-required', 'No transferable Codex auth.json was found.')); return; }
  const env = { ...process.env, CODEX_HOME: codexHome, HOME: home, USERPROFILE: home, ZCODE_PATH: fakeZCode, FAKE_ZCODE_RECORD: zcodeRecord, PATH: process.env.PATH ?? '' };
  if (!await requireSupportedCodexLine(t, temporary, env)) return;
  const auth = await codex(['login', 'status'], temporary, env, 30_000); if (auth.code !== 0) { markUnqualified(t, unqualified('auth-required', 'The isolated Codex home is not authenticated.')); return; }
  const sourceSha = (await git(['rev-parse', 'HEAD'], root)).stdout.trim();
  await buildMarketplaceSnapshot({ root, output: marketplace, sourceRef: sourceSha, sourceSha, npmExecPath: process.env.NPM_CLI_JS ?? npmLaunch([]).args[0], env });
  for (const args of [['plugin', 'marketplace', 'add', marketplace, '--json'], ['plugin', 'add', 'zcode@vitry', '--json']]) { const result = await codex(args, temporary, env); assert.equal(result.code, 0, result.stderr || result.stdout); }
  await git(['init', '-q'], workspace); await writeFile(join(workspace, 'tracked.txt'), 'base\n'); await git(['add', 'tracked.txt'], workspace); await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], workspace); await writeFile(join(workspace, 'tracked.txt'), 'changed\n');
  const prompt = 'Use the installed $zcode:review --wait skill exactly once now. Return only its final result.';
  const result = await codex(['exec', '--ephemeral', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--enable', 'hooks', '-c', 'shell_environment_policy.inherit=all', '-C', workspace, prompt], workspace, env, 180_000);
  const failureOutput = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0 && /unauthorized|authentication|not logged in|login required|\b401\b/i.test(failureOutput)) { markUnqualified(t, unqualified('auth-required', 'Codex authentication expired or was rejected after preflight.')); return; }
  if (result.code !== 0 && /credit|usage limit|quota|rate.?limit|insufficient/i.test(failureOutput)) { markUnqualified(t, unqualified('credits-unavailable', 'The authenticated account has no credits available for this qualification run.')); return; }
  assert.equal(result.code, 0, `codex exec failed\n${result.stdout}\n${result.stderr}`);
  const frames = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); assert.ok(frames.length > 0, 'codex exec --json must emit events');
  const zcodeCalls = (await readFile(zcodeRecord, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(zcodeCalls.some((call) => call.method === 'session/send'), 'installed hook plus direct companion must reach ZCode');
});

test('installed Rescue uses one isolated native child for initial and choice continuations', { skip: rescueOptInSkip, timeout: 1_200_000 }, async (t) => {
  function assertInstalledRescueChoiceLinkage(rollouts, parentThreadId, evidence, pendingIdentity) {
    assert.equal(evidence.executions.initial.execCommandCount, 1, 'choice initial turn must execute exactly once');
    assert.equal(evidence.executions.continuation.execCommandCount, 1, 'choice continuation must execute exactly once');
    assertInstalledRescueChoiceIdentityLinkage(rollouts, parentThreadId, evidence, pendingIdentity);
  }

  if (process.env.ZCODE_CODEX_RESCUE_E2E !== '1') assert.fail(unqualified('opt-in-required', 'Required qualification needs ZCODE_CODEX_RESCUE_E2E=1.'));
  const temporary = await mkdtemp(join(tmpdir(), 'zcode-codex-rescue-e2e-')); let preserveTemporary = false;
  const codexHome = join(temporary, 'codex-home'); const home = join(temporary, 'home'); const marketplace = join(temporary, 'marketplace'); const workspace = join(temporary, 'privpathcanary'); const zcodeRecord = join(temporary, 'zcode.jsonl'); const recoveryControl = join(temporary, 'zcode-recovery.json');
  const isolatedAuthPath = join(codexHome, 'auth.json'); t.after(() => cleanupInstalledEvidence({ credentialPaths: [isolatedAuthPath], diagnostic: (message) => t.diagnostic(message), preserve: preserveTemporary, temporary }));
  await Promise.all([mkdir(codexHome, { recursive: true, mode: 0o700 }), mkdir(home, { recursive: true, mode: 0o700 }), mkdir(workspace, { recursive: true }), writeFile(zcodeRecord, ''), writeFile(recoveryControl, JSON.stringify({ mode: 'completed' }))]);
  const sourceCodexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  try { await stat(join(sourceCodexHome, 'auth.json')); await cp(join(sourceCodexHome, 'auth.json'), isolatedAuthPath); await chmod(isolatedAuthPath, 0o600); }
  catch { markUnqualified(t, unqualified('auth-required', 'No transferable Codex auth.json was found.')); return; }
  const env = { ...process.env, CODEX_HOME: codexHome, HOME: home, USERPROFILE: home, ZCODE_PATH: fakeZCode, FAKE_ZCODE_RECORD: zcodeRecord, FAKE_ZCODE_RECOVERY_CONTROL: recoveryControl, FAKE_ZCODE_CONVERSATION_PROGRESS: '1', FAKE_ZCODE_GATE_RESULT: 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C', PATH: process.env.PATH ?? '' };
  if (!await requireSupportedCodexLine(t, temporary, env)) return;
  const auth = await codex(['login', 'status'], temporary, env, 30_000); if (auth.code !== 0) { markUnqualified(t, unqualified('auth-required', 'The isolated Codex home is not authenticated.')); return; }
  const sourceSha = (await git(['rev-parse', 'HEAD'], root)).stdout.trim();
  await buildMarketplaceSnapshot({ root, output: marketplace, sourceRef: sourceSha, sourceSha, npmExecPath: process.env.NPM_CLI_JS ?? npmLaunch([]).args[0], env });
  for (const args of [['plugin', 'marketplace', 'add', marketplace, '--json'], ['plugin', 'add', 'zcode@vitry', '--json']]) { const result = await codex(args, temporary, env); assert.equal(result.code, 0, result.stderr || result.stdout); }
  const installedPluginRoot = await findInstalledPluginRoot(codexHome);
  await git(['init', '-q'], workspace); await writeFile(join(workspace, 'tracked.txt'), 'base\n'); await git(['add', 'tracked.txt'], workspace); await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], workspace); await writeFile(join(workspace, 'tracked.txt'), 'changed\n');
  const commonArgs = ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--enable', 'hooks', '-c', 'shell_environment_policy.inherit=all', '-C', workspace];
  let setupReady = false;
  for (let attempt = 0; attempt < 4 && !setupReady; attempt += 1) {
    const setup = await codex([...commonArgs, 'Use the installed $zcode:setup skill exactly once now. Return only its public output.'], workspace, env, 180_000);
    if (skipExternalFailure(t, setup)) return;
    assert.equal(setup.code, 0, `codex setup failed\n${setup.stdout}\n${setup.stderr}`);
    setupReady = /status\\?"?\s*:\s*\\?"ready\\?"/.test(setup.stdout);
  }
  assert.equal(setupReady, true, 'four successful setup turns did not establish a fresh-session ready Rescue Role');
  await qualifyInstalledIdentityFailures({ installedPluginRoot, installedDataRoot: join(codexHome, 'plugins', 'data', 'zcode-vitry'), temporary, env, zcodeRecord });
  const foregroundGate = join(temporary, 'foreground-long-completion.gate'); const foregroundGateReached = join(temporary, 'foreground-long-completion.reached'); const foregroundProcess = join(temporary, 'foreground-long-process.json'); const foregroundNonce = randomBytes(32).toString('hex');
  await Promise.all([writeFile(zcodeRecord, ''), writeFile(foregroundGate, 'hold'), writeFile(foregroundGateReached, ''), writeFile(foregroundProcess, '')]);
  const longEnv = { ...env, FAKE_ZCODE_COMPLETION_GATE: foregroundGate, FAKE_ZCODE_COMPLETION_GATE_REACHED: foregroundGateReached, FAKE_ZCODE_PROCESS_FILE: foregroundProcess, FAKE_ZCODE_PROCESS_NONCE: foregroundNonce };
  const foreground = await runHeldForegroundRescue({
    gatePath: foregroundGate, processPath: foregroundProcess, processNonce: foregroundNonce,
    launch: () => controlledCodex([...commonArgs, 'Use the installed $zcode:rescue --fresh --wait skill exactly once now for repaircanary. Require ZCode to run exactly `npm test` as the safe deterministic fixture action, then return only its final public result. Keep these private fixture labels out of the display name: privpromptcanary, privpathcanary, privworkcanary, privsesscanary, privjobcanary, privcapcanary. Also keep the independent command argument/option canary `--privargcanary` out of the display name.'], workspace, longEnv, 300_000),
    waitForGate: (signal) => waitUntil(async () => await readFile(foregroundGateReached, 'utf8').catch(() => '') === 'blocked', 60_000, 'installed foreground Rescue never reached the held fake-ZCode completion boundary', signal),
    holdMs: 35_000,
  });
  if (foreground.endedBeforeGate) {
    if (skipExternalFailure(t, foreground.rescue)) return;
    assert.fail(`installed foreground Rescue ended before the long completion boundary\n${foreground.rescue.stdout}\n${foreground.rescue.stderr}`);
  }
  const { rescue, processAliveWhileHeld } = foreground;
  if (skipExternalFailure(t, rescue)) return;
  assert.equal(rescue.code, 0, `codex Rescue failed\n${rescue.stdout}\n${rescue.stderr}`);
  assert.equal(processAliveWhileHeld, true, 'the exact fake-ZCode process must remain alive beyond the maximum initial host yield');
  const frames = rescue.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const expectedCommand = `node "${installedPluginRoot}/scripts/zcode-companion.mjs" invoke rescue`;
  const expectedPreflightCommand = `node "${installedPluginRoot}/scripts/zcode-companion.mjs" role-status rescue`;
  const expectedNamedSpawnMessage = 'Run the installed ZCode Rescue forwarder now. Return its public stdout verbatim.';
  const expectedGenericSpawnMessage = `Act only as the installed ZCode Rescue forwarder. In the current workspace run exactly:\n${expectedCommand}\nPreserve stderr and return public stdout verbatim. Do not inspect or modify code independently, interpret results, retry, cancel, choose a pending branch, or request/print/persist authorization material.\nHere exactly one command means exactly one \`exec_command\` companion process; continuation calls only observe its original running handle. Never start a second \`exec_command\`. A companion result containing an exit code is terminal. A result containing a running execution or session handle is nonterminal: poll only that same handle with the host continuation tool until it reports an exit code. Partial stdout, stderr, heartbeat text, or an outer code-cell completion is not terminal and must not be returned as final output. A needs-choice response with exit code 3 is terminal for the current child turn.\nIf that command returned a needs-choice response, stop. Only after the parent sends exactly \`Continue the pending ZCode Rescue with resume. Run only the installed resume forwarder command and return its public stdout verbatim.\` run exactly:\nnode "${installedPluginRoot}/scripts/zcode-companion.mjs" invoke-choice rescue resume\nOnly after the parent sends exactly \`Continue the pending ZCode Rescue with fresh. Run only the installed fresh forwarder command and return its public stdout verbatim.\` run exactly:\nnode "${installedPluginRoot}/scripts/zcode-companion.mjs" invoke-choice rescue fresh`;
  const canonicalWorkspace = await realpath(workspace);
  const zcodeCalls = (await readFile(zcodeRecord, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(zcodeCalls.filter((call) => call.method === 'session/send').length, 1, 'one ZCode send after one native child spawn');
  try {
    const evidence = qualifyCodexRescueEvidence(
      { execFrames: frames, rollouts: await loadCodexRollouts(codexHome) },
      {
        expectedAgentType: 'zcode-rescue',
        expectedWorkspace: canonicalWorkspace,
        expectedCommand,
        expectedPreflightCommand,
        expectedNamedSpawnMessage,
        expectedGenericSpawnMessage,
        expectedPublicOutput: 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C',
        requireYieldedExecution: true,
        expectedSemanticProgress: {
          start: '[zcode] Running command: npm test.',
          terminal: '[zcode] Command completed: npm test (25ms).',
          snapshotFallback: '[zcode] ZCode conversation frames were unavailable; using bounded session progress.',
          lifecycleOnly: '[zcode] ZCode semantic progress is unavailable; lifecycle updates will continue.',
        },
        forbiddenParentText: [
          'Running command: npm test.',
          'Command completed: npm test (25ms).',
          'ZCode conversation frames were unavailable; using bounded session progress.',
          'ZCode semantic progress is unavailable; lifecycle updates will continue.',
          'raw output must stay private',
          'reasoning must stay private',
          'capability must stay private',
          'v4/conversation/frame',
        ],
      },
    );
    assertInstalledRescueDisplay(evidence);
    assert.ok(['named', 'generic-schema-hidden'].includes(evidence.route), 'qualification must record an automatically observed native route');
    assert.equal(evidence.semanticProgressChecked, true);
    assert.equal(evidence.yieldedExecution.execCommandCount, 1);
    assert.ok(evidence.yieldedExecution.pollCount >= 1);
    assert.equal(evidence.yieldedExecution.sameHandleChecked, true);
    assert.equal(evidence.yieldedExecution.terminalExitCode, 0);
    t.diagnostic(`qualified native Rescue route: ${evidence.route}`);
  } catch (error) {
    if (error instanceof CodexRescueUnqualifiedError && error.code === 'spawn-message-encrypted') {
      assertInstalledRescueDisplay(error.evidence);
      assert.ok(['named', 'generic-schema-hidden'].includes(error.evidence?.route), 'encrypted-message evidence must record the automatically observed native route');
      assert.equal(error.evidence.yieldedExecution.execCommandCount, 1);
      assert.ok(error.evidence.yieldedExecution.pollCount >= 1);
      assert.equal(error.evidence.yieldedExecution.sameHandleChecked, true);
      assert.equal(error.evidence.yieldedExecution.terminalExitCode, 0);
      const detail = `Observed route ${error.evidence.route}. ${error.message}`;
      markUnqualified(t, unqualified(error.code, detail)); return;
    }
    throw error;
  }

  for (const choice of ['resume', 'fresh']) {
    await writeFile(zcodeRecord, '');
    const pending = await codex([...commonArgs, 'Use the installed $zcode:rescue --wait continue repairing the fixture skill exactly once now. If its child returns needs-choice, follow the installed skill, ask once, and stop without choosing.'], workspace, env, 240_000);
    if (skipExternalFailure(t, pending)) return;
    assert.equal(pending.code, 0, `codex pending Rescue failed\n${pending.stdout}\n${pending.stderr}`);
    const pendingFrames = pending.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const parentIds = [...new Set(pendingFrames.filter((frame) => frame?.type === 'thread.started').map((frame) => frame.thread_id))];
    assert.equal(parentIds.length, 1, 'pending Rescue must expose exactly one resumable parent thread ID');
    const pendingRollouts = await loadCodexRollouts(codexHome);
    const pendingIdentity = captureInstalledRescueChoiceIdentity(pendingRollouts, parentIds[0]);
    const answer = await codex([
      'exec', 'resume', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
      '--dangerously-bypass-hook-trust', '--enable', 'hooks', '-c', 'shell_environment_policy.inherit=all',
      parentIds[0], choice,
    ], workspace, env, 240_000);
    if (skipExternalFailure(t, answer)) return;
    assert.equal(answer.code, 0, `codex ${choice} continuation failed\n${answer.stdout}\n${answer.stderr}`);
    const choiceCommand = `node "${installedPluginRoot}/scripts/zcode-companion.mjs" invoke-choice rescue ${choice}`;
    const followupMessage = `Continue the pending ZCode Rescue with ${choice}. Run only the installed ${choice} forwarder command and return its public stdout verbatim.`;
    const choiceRollouts = await loadCodexRollouts(codexHome);
    try {
      const evidence = qualifyCodexRescueChoiceEvidence(
        { rollouts: choiceRollouts },
        {
          expectedChoice: choice,
          expectedParentThreadId: parentIds[0],
          expectedAgentType: 'zcode-rescue',
          expectedWorkspace: canonicalWorkspace,
          expectedInitialCommand: expectedCommand,
          expectedNamedSpawnMessage,
          expectedGenericSpawnMessage,
          expectedChoiceCommand: choiceCommand,
          expectedFollowupMessage: followupMessage,
          expectedPreflightCommand,
          expectedPublicOutput: 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C',
          includeExecutionFacts: true,
          forbiddenParentText: [
            'Running command: npm test.', 'Command completed: npm test (25ms).', 'raw output must stay private',
            'ZCode conversation frames were unavailable; using bounded session progress.',
            'ZCode semantic progress is unavailable; lifecycle updates will continue.',
            'reasoning must stay private', 'capability must stay private', 'v4/conversation/frame',
          ],
        },
      );
      assertInstalledRescueDisplay(evidence);
      assertInstalledRescueChoiceLinkage(choiceRollouts, parentIds[0], evidence, pendingIdentity);
      assert.equal(evidence.choice, choice);
      t.diagnostic(`qualified same-child Rescue ${choice}: ${evidence.childThreadId}`);
    } catch (error) {
      if (error instanceof CodexRescueUnqualifiedError && ['choice-followup-encrypted', 'choice-spawn-encrypted'].includes(error.code)) {
        assertInstalledRescueDisplay(error.evidence);
        assertInstalledRescueChoiceLinkage(choiceRollouts, parentIds[0], error.evidence, pendingIdentity);
        markUnqualified(t, unqualified(error.code, error.message)); return;
      }
      throw error;
    }
    const choiceCalls = (await readFile(zcodeRecord, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(choiceCalls.filter((call) => call.method === 'session/send').length, 1, `${choice} choice must execute exactly one ZCode turn`);
  }

  await writeFile(zcodeRecord, '');
  const installedDataRoot = join(codexHome, 'plugins', 'data', 'zcode-vitry');
  const backgroundWorkspace = join(temporary, 'privworkcanary'); await initializeGitWorkspace(backgroundWorkspace); const backgroundCanonicalWorkspace = await realpath(backgroundWorkspace);
  const privateCapabilityEvidence = await installPrivateCapabilityObserver(installedPluginRoot, temporary);
  const backgroundGate = join(temporary, 'background-completion.gate'); const backgroundGateReached = join(temporary, 'background-completion.reached');
  const backgroundStorage = await resolveWorkspaceStorage({ dataRoot: installedDataRoot, workspace: backgroundCanonicalWorkspace }); const backgroundJobsDirectory = join(backgroundStorage.directory, 'jobs');
  const backgroundBaseline = await canonicalJobIds(backgroundJobsDirectory); let backgroundJobId; let backgroundIdentity; let backgroundVerified = false;
  await Promise.all([writeFile(backgroundGate, 'hold'), writeFile(recoveryControl, JSON.stringify({ mode: 'active' }))]); preserveTemporary = true;
  try {
    const background = await codex([
      ...commonArgs.slice(0, -1), backgroundWorkspace,
      'Use the installed $zcode:rescue --fresh --background repair the background fixture skill exactly once now. Return only its public queued result.',
    ], backgroundWorkspace, { ...env, ZCODE_TEST_PRIVATE_CAPABILITY_EVIDENCE: privateCapabilityEvidence, FAKE_ZCODE_COMPLETION_GATE: backgroundGate, FAKE_ZCODE_COMPLETION_GATE_REACHED: backgroundGateReached, FAKE_ZCODE_COMPLETION_GATE_REACHED_DELAY_MS: '100' }, 240_000);
    backgroundJobId = /Reserved background job ([a-f0-9]{64})\./.exec(background.stdout)?.[1];
    if (skipExternalFailure(t, background)) return;
    assert.equal(background.code, 0, `codex background Rescue failed\n${background.stdout}\n${background.stderr}`);
    assert.ok(backgroundJobId && !backgroundBaseline.has(backgroundJobId), 'native Rescue child must identify exactly one new canonical background job');
    const backgroundJobPath = join(backgroundJobsDirectory, `${backgroundJobId}.json`); let job = await waitForValue(() => readExactJob(backgroundJobPath, backgroundJobId), 30_000, 'exact installed background job record was not found');
    backgroundIdentity = exactWorkerIdentity(job);
    await waitUntil(async () => await readFile(backgroundGateReached, 'utf8').catch(() => '') === 'blocked', 5_000, 'background worker did not reach the explicit post-ack completion gate');
    assert.equal(job.status, 'running'); assert.equal(await exactWorkerLeaseAvailable(installedDataRoot, backgroundCanonicalWorkspace, backgroundJobId, backgroundIdentity.workerLeaseId), false);
    const privateCapability = await waitForValue(async () => {
      const observed = await readFile(privateCapabilityEvidence, 'utf8').then(JSON.parse).catch(() => null);
      return observed?.jobId === backgroundJobId && typeof observed?.executionCapability === 'string' ? observed.executionCapability : undefined;
    }, 5_000, 'private observer did not capture the production FD3 capability');
    const backgroundFrames = background.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    try {
      const evidence = qualifyCodexRescueBackgroundEvidence(
        { execFrames: backgroundFrames, rollouts: await loadCodexRollouts(codexHome) },
        {
          expectedJobId: backgroundJobId,
          expectedAgentType: 'zcode-rescue', expectedWorkspace: backgroundCanonicalWorkspace,
          expectedCommand, expectedPreflightCommand, expectedNamedSpawnMessage, expectedGenericSpawnMessage,
          privateExecutionCapability: privateCapability,
          publicLogs: [background.stdout, background.stderr],
          forbiddenParentText: ['Running command: npm test.', 'Command completed: npm test (25ms).', 'ZCode conversation frames were unavailable; using bounded session progress.', 'ZCode semantic progress is unavailable; lifecycle updates will continue.', 'raw output must stay private', 'reasoning must stay private', 'capability must stay private', 'v4/conversation/frame'],
        },
      );
      assertInstalledRescueDisplay(evidence);
      assert.equal(evidence.jobId, backgroundJobId); assert.equal(evidence.capabilityChecked, true); assert.ok(['named', 'generic-schema-hidden'].includes(evidence.route));
      if (`${background.stdout}${background.stderr}${JSON.stringify(job)}`.includes(privateCapability)) assert.fail('production capability entered public background diagnostics');
    } catch (error) {
      if (error instanceof CodexRescueUnqualifiedError && error.code === 'spawn-message-encrypted') {
        assertInstalledRescueDisplay(error.evidence);
        assert.equal(error.evidence.jobId, backgroundJobId);
        assert.equal(error.evidence.capabilityChecked, true);
        assert.ok(['named', 'generic-schema-hidden'].includes(error.evidence.route));
        markUnqualified(t, unqualified(error.code, error.message)); return;
      }
      throw error;
    }
    await writeFile(backgroundGate, 'release');
    await waitUntil(async () => { job = await readExactJob(backgroundJobPath, backgroundJobId); return job?.status === 'succeeded' && await exactWorkerLeaseAvailable(installedDataRoot, backgroundCanonicalWorkspace, backgroundJobId, backgroundIdentity.workerLeaseId); }, 30_000, 'qualified installed background job did not finish naturally');
    const backgroundCalls = await readZCodeCalls(zcodeRecord);
    assert.equal(backgroundCalls.filter((call) => call.method === 'session/send').length, 1); assert.equal(backgroundCalls.filter((call) => call.method === 'session/stop').length, 0);
    backgroundVerified = true;
  } finally {
    await writeFile(backgroundGate, 'release').catch(() => {});
    const discovered = await discoverNewJobIds(backgroundJobsDirectory, backgroundBaseline, 2_000);
    for (const jobId of discovered) await cleanupExactJobNaturally(installedDataRoot, backgroundCanonicalWorkspace, join(backgroundJobsDirectory, `${jobId}.json`), jobId, jobId === backgroundJobId ? backgroundIdentity : undefined);
    assert.ok(discovered.length <= 1, `background qualification created ${discovered.length} jobs instead of at most one`);
    if (backgroundJobId) assert.deepEqual(discovered, [backgroundJobId]);
    if (backgroundVerified && backgroundJobId && discovered.length === 1) preserveTemporary = false;
  }

  await writeFile(zcodeRecord, '');
  const steeringWorkspace = join(temporary, 'steering-workspace'); await initializeGitWorkspace(steeringWorkspace); const steeringCanonicalWorkspace = await realpath(steeringWorkspace);
  const steeringGate = join(temporary, 'steering-completion.gate'); const steeringGateReached = join(temporary, 'steering-completion.reached');
  await writeFile(steeringGate, 'hold');
  const steeringStorage = await resolveWorkspaceStorage({ dataRoot: installedDataRoot, workspace: steeringCanonicalWorkspace });
  const steeringJobsDirectory = join(steeringStorage.directory, 'jobs'); const steeringBaseline = await canonicalJobIds(steeringJobsDirectory);
  const steeringApp = await createInstalledCodexAppServer(steeringWorkspace, {
    ...env,
    FAKE_ZCODE_COMPLETION_GATE: steeringGate,
    FAKE_ZCODE_COMPLETION_GATE_REACHED: steeringGateReached,
    FAKE_ZCODE_COMPLETION_GATE_REACHED_DELAY_MS: '100',
  });
  let steeringJobId;
  try {
    const thread = await steeringApp.request('thread/start', { approvalPolicy: 'never', cwd: steeringCanonicalWorkspace, ephemeral: false, sandbox: 'danger-full-access' }, 30_000);
    const steeringThreadId = thread.thread?.id; assert.ok(steeringThreadId, 'installed steering thread/start omitted its durable parent ID');
    const started = await steeringApp.request('turn/start', {
      approvalPolicy: 'never', input: [{ type: 'text', text: 'Use the installed $zcode:rescue --fresh --wait repair the steering fixture skill exactly once now. Return only its final public result.' }],
      sandboxPolicy: { type: 'dangerFullAccess' }, threadId: steeringThreadId,
    }, 30_000);
    const steeringTurnId = started.turn?.id; assert.ok(steeringTurnId, 'installed steering turn/start omitted its active turn ID');
    [steeringJobId] = await waitForValue(async () => {
      const ids = await discoverNewJobIds(steeringJobsDirectory, steeringBaseline, 0); return ids.length === 1 ? ids : undefined;
    }, 30_000, 'installed steering did not create exactly one durable job');
    const steeringJobPath = join(steeringJobsDirectory, `${steeringJobId}.json`);
    await waitUntil(async () => {
      const job = await readExactJob(steeringJobPath, steeringJobId);
      return job?.status === 'running' && typeof job.inputId === 'string'
        && await readFile(steeringGateReached, 'utf8').catch(() => '') === 'blocked';
    }, 30_000, 'installed steering job did not reach its accepted remote wait boundary');
    const beforeSteer = await waitForValue(async () => {
      const rollouts = await loadCodexRollouts(codexHome).catch(() => []);
      const evidence = nativeRouteEvidence(rollouts, steeringThreadId);
      return evidence?.pendingWait ? evidence : undefined;
    }, 30_000, 'installed parent never exposed a pending wait on its native Rescue child');
    await steeringApp.request('turn/steer', {
      expectedTurnId: steeringTurnId,
      input: [{ type: 'text', text: 'Keep waiting on the existing Rescue child and job; do not cancel, respawn, or execute Rescue again.' }],
      threadId: steeringThreadId,
    }, 30_000);
    await writeFile(steeringGate, 'release');
    await waitForCodexTurn(steeringApp, steeringThreadId, steeringTurnId, 240_000);
    const steeringJob = await readExactJob(steeringJobPath, steeringJobId);
    assert.equal(steeringJob.status, 'succeeded'); assert.equal(steeringJob.ownerSessionId, steeringThreadId);
    const afterSteer = nativeRouteEvidence(await loadCodexRollouts(codexHome), steeringThreadId);
    assert.ok(afterSteer); assert.equal(afterSteer.childThreadId, beforeSteer.childThreadId, 'steering must retain the exact native child ID');
    assert.equal(afterSteer.spawnCount, 1); assert.equal(afterSteer.startCount, 1);
    assert.deepEqual(await discoverNewJobIds(steeringJobsDirectory, steeringBaseline, 0), [steeringJobId], 'steering must retain exactly one durable job');
    const steeringCalls = await readZCodeCalls(zcodeRecord);
    assert.equal(steeringCalls.filter((call) => call.method === 'session/send').length, 1, 'steering must not execute a second ZCode turn');
    assert.equal(steeringCalls.filter((call) => call.method === 'session/stop').length, 0, 'ordinary steering must not cancel the accepted turn');
  } finally {
    await writeFile(steeringGate, 'release').catch(() => {}); await steeringApp.close();
    if (steeringJobId) await cleanupExactJobNaturally(installedDataRoot, steeringCanonicalWorkspace, join(steeringJobsDirectory, `${steeringJobId}.json`), steeringJobId);
  }

  await writeFile(zcodeRecord, '');
  const cancelWorkspace = join(temporary, 'cancel-workspace'); await initializeGitWorkspace(cancelWorkspace); const cancelCanonicalWorkspace = await realpath(cancelWorkspace);
  const cancelGate = join(temporary, 'cancel-completion.gate'); const cancelGateReached = join(temporary, 'cancel-completion.reached');
  const stopGate = join(temporary, 'cancel-stop.gate'); const stopGateReached = join(temporary, 'cancel-stop.reached');
  await Promise.all([writeFile(cancelGate, 'hold'), writeFile(stopGate, 'hold')]);
  const cancelStorage = await resolveWorkspaceStorage({ dataRoot: installedDataRoot, workspace: cancelCanonicalWorkspace }); const cancelJobsDirectory = join(cancelStorage.directory, 'jobs');
  const cancelBaseline = await canonicalJobIds(cancelJobsDirectory);
  const cancelApp = await createInstalledCodexAppServer(cancelWorkspace, {
    ...env,
    FAKE_ZCODE_COMPLETION_GATE: cancelGate,
    FAKE_ZCODE_COMPLETION_GATE_REACHED: cancelGateReached,
    FAKE_ZCODE_COMPLETION_GATE_REACHED_DELAY_MS: '100',
    FAKE_ZCODE_STOP_GATE: stopGate,
    FAKE_ZCODE_STOP_GATE_REACHED: stopGateReached,
  });
  try {
    const thread = await cancelApp.request('thread/start', { approvalPolicy: 'never', cwd: cancelCanonicalWorkspace, ephemeral: false, sandbox: 'danger-full-access' }, 30_000);
    const cancelThreadId = thread.thread?.id; assert.ok(cancelThreadId, 'installed cancellation thread/start omitted its durable parent ID');
    const reviewTurn = await startInstalledTurn(cancelApp, cancelThreadId, 'Use the installed $zcode:review --background skill exactly once now. Return only its public queued result.');
    await waitForCodexTurn(cancelApp, cancelThreadId, reviewTurn, 240_000);
    const afterReview = await waitForValue(async () => {
      const ids = await discoverNewJobIds(cancelJobsDirectory, cancelBaseline, 0); return ids.length === 1 ? ids : undefined;
    }, 30_000, 'installed cancellation sibling was not durably reserved');
    const [siblingJobId] = afterReview;
    const rescueTurn = await startInstalledTurn(cancelApp, cancelThreadId, 'Use the installed $zcode:rescue --fresh --background repair the cancellation fixture skill exactly once now. Return only its public queued result.');
    await waitForCodexTurn(cancelApp, cancelThreadId, rescueTurn, 240_000);
    const afterRescue = await waitForValue(async () => {
      const ids = await discoverNewJobIds(cancelJobsDirectory, cancelBaseline, 0); return ids.length === 2 ? ids : undefined;
    }, 30_000, 'installed exact cancellation target was not durably reserved');
    const targetJobId = afterRescue.find((id) => id !== siblingJobId); assert.ok(targetJobId);
    const siblingPath = join(cancelJobsDirectory, `${siblingJobId}.json`); const targetPath = join(cancelJobsDirectory, `${targetJobId}.json`);
    await waitUntil(async () => {
      const sibling = await readExactJob(siblingPath, siblingJobId); const target = await readExactJob(targetPath, targetJobId);
      return sibling?.status === 'running' && target?.status === 'running' && typeof target.zcodeSessionId === 'string';
    }, 30_000, 'installed cancellation jobs did not both reach running state');
    const acceptedTarget = await readExactJob(targetPath, targetJobId);
    assert.equal(acceptedTarget.ownerSessionId, cancelThreadId); assert.equal((await readExactJob(siblingPath, siblingJobId)).ownerSessionId, cancelThreadId);
    const cancelTurn = await startInstalledTurn(cancelApp, cancelThreadId, `Use the installed $zcode:cancel ${targetJobId} skill exactly once now. Return only its public output.`);
    await waitUntil(async () => await readFile(stopGateReached, 'utf8').catch(() => '') === 'blocked', 30_000, 'installed exact cancellation never reached its remote stop acknowledgement gate');
    assert.equal((await readExactJob(targetPath, targetJobId)).status, 'cancelling', 'target must remain nonterminal before stop acknowledgement');
    assert.equal((await readExactJob(siblingPath, siblingJobId)).status, 'running', 'exact cancellation must not settle its owned sibling');
    await writeFile(stopGate, 'release');
    await waitForCodexTurn(cancelApp, cancelThreadId, cancelTurn, 240_000);
    assert.equal((await readExactJob(targetPath, targetJobId)).status, 'cancelled', 'acknowledged exact stop must terminalize only its target');
    assert.equal((await readExactJob(siblingPath, siblingJobId)).status, 'running');
    const cancelCalls = await readZCodeCalls(zcodeRecord); const stops = cancelCalls.filter((call) => call.method === 'session/stop');
    assert.equal(stops.length, 1); assert.equal(stops[0].params?.sessionId, acceptedTarget.zcodeSessionId, 'installed cancel must stop the exact durable remote session');
    await writeFile(cancelGate, 'release');
    await waitUntil(async () => (await readExactJob(siblingPath, siblingJobId))?.status === 'succeeded', 30_000, 'uncancelled installed sibling did not finish naturally');
    assert.equal((await readExactJob(targetPath, targetJobId)).status, 'cancelled');
  } finally {
    await Promise.all([writeFile(cancelGate, 'release').catch(() => {}), writeFile(stopGate, 'release').catch(() => {})]); await cancelApp.close();
    const discovered = await discoverNewJobIds(cancelJobsDirectory, cancelBaseline, 2_000);
    for (const jobId of discovered) await cleanupExactJobNaturally(installedDataRoot, cancelCanonicalWorkspace, join(cancelJobsDirectory, `${jobId}.json`), jobId);
    assert.ok(discovered.length <= 2, `installed exact-cancel scenario created ${discovered.length} jobs instead of at most two`);
  }

  await writeFile(zcodeRecord, '');
  const lossWorkspace = join(temporary, 'loss-workspace'); await initializeGitWorkspace(lossWorkspace); const lossCanonicalWorkspace = await realpath(lossWorkspace);
  const lossGate = join(temporary, 'loss-completion.gate'); const lossGateReached = join(temporary, 'loss-completion.reached');
  const lossProcessNonce = randomBytes(32).toString('hex');
  const lossStorage = await resolveWorkspaceStorage({ dataRoot: installedDataRoot, workspace: lossCanonicalWorkspace }); const lossJobsDirectory = join(lossStorage.directory, 'jobs');
  const lossBaseline = await canonicalJobIds(lossJobsDirectory);
  await Promise.all([writeFile(lossGate, 'hold'), writeFile(recoveryControl, JSON.stringify({ mode: 'active' }))]); let lossIdentity; let lossJobId; let lossJobPath; let lossThreadId; let lossVerified = false;
  const lossApp = await createInstalledCodexAppServer(lossWorkspace, {
    ...env,
    ZCODE_E2E_PROCESS_NONCE: lossProcessNonce,
    FAKE_ZCODE_COMPLETION_GATE: lossGate,
    FAKE_ZCODE_COMPLETION_GATE_REACHED: lossGateReached,
    FAKE_ZCODE_COMPLETION_GATE_REACHED_DELAY_MS: '100',
  });
  preserveTemporary = true;
  try {
    const thread = await lossApp.request('thread/start', { approvalPolicy: 'never', cwd: lossCanonicalWorkspace, ephemeral: false, sandbox: 'danger-full-access' }, 30_000);
    lossThreadId = thread.thread?.id; assert.ok(lossThreadId, 'installed loss thread/start omitted its durable parent ID');
    await startInstalledTurn(lossApp, lossThreadId, 'Use the installed $zcode:rescue --fresh --wait repair the loss fixture skill exactly once now. Return only its final public result.');
    [lossJobId] = await waitForValue(async () => {
      const ids = await discoverNewJobIds(lossJobsDirectory, lossBaseline, 0); return ids.length === 1 ? ids : undefined;
    }, 30_000, 'installed foreground loss did not create exactly one durable job');
    lossJobPath = join(lossJobsDirectory, `${lossJobId}.json`);
    let job = await waitForValue(async () => {
      const value = await readExactJob(lossJobPath, lossJobId);
      return value?.status === 'running' && typeof value.inputId === 'string'
        && await readFile(lossGateReached, 'utf8').catch(() => '') === 'blocked' ? value : undefined;
    }, 30_000, 'installed foreground loss never reached its accepted remote boundary');
    lossIdentity = exactWorkerIdentity(job); assert.equal(job.ownerSessionId, lossThreadId);
    assert.equal(await exactWorkerLeaseAvailable(installedDataRoot, lossCanonicalWorkspace, lossJobId, lossIdentity.workerLeaseId), false);
    const lossRoute = await waitForValue(async () => nativeRouteEvidence(await loadCodexRollouts(codexHome).catch(() => []), lossThreadId), 30_000, 'installed loss turn exposed no native child identity');
    assert.equal(lossRoute.spawnCount, 1); assert.equal(lossRoute.startCount, 1);

    const lossWorkerProcess = await captureExactPidIdentity(lossIdentity.pid, lossProcessNonce, 'ZCODE_E2E_PROCESS_NONCE');
    await signalExactProcess(lossWorkerProcess, (expected) => readExactPidIdentity(expected), 'SIGKILL');
    await waitUntil(() => !processAlive(lossIdentity.pid), 5_000, 'the exact accepted foreground worker survived simulated native child loss');
    const lostCodexPid = lossApp.pid;
    await lossApp.close('SIGKILL');
    assert.equal(processAlive(lostCodexPid), false, 'the exact installed Codex parent process must be gone before recovery');
    await writeFile(recoveryControl, JSON.stringify({ mode: 'completed' }));
    await writeFile(lossGate, 'release');
    const recovered = await codex([
      'exec', 'resume', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
      '--dangerously-bypass-hook-trust', '--enable', 'hooks', '-c', 'shell_environment_policy.inherit=all',
      lossThreadId, `Use the installed $zcode:status ${lossJobId} --wait skill exactly once now. Do not run Rescue again. Return only its public status.`,
    ], lossWorkspace, env, 240_000);
    if (skipExternalFailure(t, recovered)) return;
    assert.equal(recovered.code, 0, `installed recovery failed\n${recovered.stdout}\n${recovered.stderr}`);
    await waitUntil(async () => { job = await readExactJob(lossJobPath, lossJobId); return job?.status === 'succeeded' && await exactWorkerLeaseAvailable(installedDataRoot, lossCanonicalWorkspace, lossJobId, lossIdentity.workerLeaseId); }, 30_000, 'exact foreground job was not recovered after Codex/native child loss');
    assert.ok(typeof job.resultArtifact === 'string' && job.resultArtifact.length > 0, 'terminal recovered job must retain its result artifact');
    const result = await readFile(join(dirname(dirname(lossJobPath)), job.resultArtifact), 'utf8');
    assert.equal(result, 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C'); assert.doesNotMatch(result, new RegExp(`${escapeRegExp(lossGate)}|${escapeRegExp(lossGateReached)}`));
    const lossCalls = await readZCodeCalls(zcodeRecord);
    assert.equal(lossCalls.filter((call) => call.method === 'session/send').length, 1, 'installed Codex/native child loss and recovery must not execute another ZCode turn');
    assert.equal(lossCalls.filter((call) => call.method === 'session/stop').length, 0, 'completed remote recovery must not cancel the accepted turn');
    const recoveredRoute = nativeRouteEvidence(await loadCodexRollouts(codexHome), lossThreadId);
    assert.equal(recoveredRoute.childThreadId, lossRoute.childThreadId); assert.equal(recoveredRoute.spawnCount, 1); assert.equal(recoveredRoute.startCount, 1);
    lossVerified = true;
  } finally {
    await writeFile(lossGate, 'release').catch(() => {}); await lossApp.close().catch(() => {});
    const discovered = await discoverNewJobIds(lossJobsDirectory, lossBaseline, 2_000);
    for (const jobId of discovered) await cleanupExactJobNaturally(installedDataRoot, lossCanonicalWorkspace, join(lossJobsDirectory, `${jobId}.json`), jobId, jobId === lossJobId ? lossIdentity : undefined);
    assert.ok(discovered.length <= 1, `foreground loss invocation created ${discovered.length} jobs instead of at most one`);
    if (lossJobId) assert.deepEqual(discovered, [lossJobId], 'loss recovery must settle the exact initially accepted durable job');
    if (lossVerified && lossJobId && discovered.length === 1) preserveTemporary = false;
  }
});

test('installed Rescue display privacy rejects case-insensitive private substrings without generic-word collisions', () => {
  for (const taskName of ['zcode_rescue_contest', 'zcode_rescue_awaiting']) {
    assert.doesNotThrow(() => assertRescueDisplayOmitsPrivateSentinels({ taskName, agentPath: `/root/${taskName}` }));
  }
  for (const sentinel of ['repaircanary', 'privpromptcanary', 'privpathcanary', 'privworkcanary', 'privsesscanary', 'privjobcanary', 'privcapcanary']) {
    const display = { taskName: `zcode_rescue_${sentinel}`, agentPath: `/root/zcode_rescue_${sentinel}` };
    assert.throws(() => assertRescueDisplayOmitsPrivateSentinels(display), new RegExp(sentinel));
  }
  const embeddedCommandArgument = { taskName: 'zcode_rescue_xprivargcanary', agentPath: '/root/zcode_rescue_xprivargcanary' };
  assert.throws(() => assertRescueDisplayOmitsPrivateSentinels(embeddedCommandArgument), /privargcanary/u);
  assert.throws(
    () => assertRescueDisplayOmitsPrivateSentinels({ taskName: 'zcode_rescue_xPrIvArGcAnArY', agentPath: '/root/zcode_rescue_xPrIvArGcAnArY' }),
    /privargcanary/u,
  );
});

test('installed Rescue choice linkage rejects post-continuation identity drift from the pending snapshot', () => {
  const parentThreadId = 'parent-thread';
  const pendingIdentity = { taskName: 'zcode_rescue_fix_progress', agentPath: '/root/zcode_rescue_fix_progress', childThreadId: 'child-thread' };
  const evidence = { ...pendingIdentity };
  const postRollouts = [
    [
      { type: 'session_meta', payload: { id: parentThreadId } },
      { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', arguments: JSON.stringify({ task_name: pendingIdentity.taskName }) } },
      { type: 'event_msg', payload: { type: 'sub_agent_activity', kind: 'started', agent_path: '/root/zcode_rescue_drifted', agent_thread_id: pendingIdentity.childThreadId } },
      { type: 'response_item', payload: { type: 'function_call', name: 'followup_task', arguments: JSON.stringify({ target: pendingIdentity.childThreadId }) } },
    ],
    [{ type: 'session_meta', payload: { id: pendingIdentity.childThreadId, parent_thread_id: parentThreadId, source: { subagent: { thread_spawn: { agent_path: '/root/zcode_rescue_drifted' } } } } }],
  ];
  assert.throws(
    () => assertInstalledRescueChoiceIdentityLinkage(postRollouts, parentThreadId, evidence, pendingIdentity),
    /pending snapshot/u,
  );
});

async function qualifyInstalledIdentityFailures({ installedPluginRoot, installedDataRoot, temporary, env, zcodeRecord }) {
  const companionPath = join(installedPluginRoot, 'scripts', 'zcode-companion.mjs');
  const { createIdentityStore: createInstalledIdentityStore } = await import(pathToFileURL(join(installedPluginRoot, 'scripts', 'lib', 'identity.mjs')).href);
  const { markForwarding: markInstalledForwarding } = await import(pathToFileURL(join(installedPluginRoot, 'hooks', 'lib', 'hook-state.mjs')).href);
  for (const scenario of [
    { name: 'missing-thread', expectedCode: 'THREAD_ID_REQUIRED' },
    { name: 'sibling-thread', expectedCode: 'EXECUTOR_IDENTITY_NOT_FOUND' },
    { name: 'stale-executor', expectedCode: 'EXECUTOR_IDENTITY_EXPIRED' },
    { name: 'mismatched-parent-turn', expectedCode: 'EXECUTOR_PARENT_TURN_MISMATCH' },
  ]) {
    const scenarioWorkspace = join(temporary, `identity-${scenario.name}`); await initializeGitWorkspace(scenarioWorkspace); const canonicalWorkspace = await realpath(scenarioWorkspace);
    const identity = createInstalledIdentityStore({ dataRoot: installedDataRoot });
    const parentSessionId = `parent-${scenario.name}`; const parentTurnId = `turn-${scenario.name}`; const approvedChildId = `child-${scenario.name}`;
    const parentSecret = `PARENT_PRIVATE_IDENTITY_${scenario.name}_MUST_NOT_RENDER`;
    await identity.beginCallerTurn({ sessionId: parentSessionId, turnId: parentTurnId, workspace: canonicalWorkspace, permissionMode: 'workspace-write', prompt: `Use $zcode:rescue --fresh --wait ${parentSecret}` });
    const active = await identity.resolveActiveTurn({ sessionId: parentSessionId, workspace: canonicalWorkspace });
    await markInstalledForwarding(installedDataRoot, {
      session_id: parentSessionId, turn_id: `child-turn-${scenario.name}`, cwd: canonicalWorkspace,
      hook_event_name: 'SubagentStart', agent_id: approvedChildId, agent_type: 'zcode-rescue',
    }, active);
    const storage = await resolveWorkspaceStorage({ dataRoot: installedDataRoot, workspace: canonicalWorkspace });
    if (scenario.name === 'stale-executor') {
      const executorNames = (await readdir(join(storage.directory, 'hook-state'))).filter((name) => name.startsWith('executor-') && name.endsWith('.json'));
      assert.equal(executorNames.length, 1); const executorPath = join(storage.directory, 'hook-state', executorNames[0]);
      const record = JSON.parse(await readFile(executorPath, 'utf8')); record.createdAt = new Date(Date.now() - 31 * 60_000).toISOString(); await writeFile(executorPath, JSON.stringify(record));
    }
    if (scenario.name === 'mismatched-parent-turn') {
      await identity.beginCallerTurn({ sessionId: parentSessionId, turnId: `replacement-${parentTurnId}`, workspace: canonicalWorkspace, permissionMode: 'workspace-write', prompt: `Use $zcode:rescue --fresh --wait ${parentSecret}` });
    }
    await writeFile(zcodeRecord, '');
    const directEnv = { ...env, ZCODE_DATA_ROOT: installedDataRoot, FAKE_ZCODE_RECORD: zcodeRecord, ZCODE_DEBUG: '0' };
    if (scenario.name !== 'missing-thread') directEnv.CODEX_THREAD_ID = scenario.name === 'sibling-thread' ? `sibling-${approvedChildId}` : approvedChildId;
    else delete directEnv.CODEX_THREAD_ID;
    const result = await runProcess({ command: process.execPath, args: [companionPath, 'invoke', 'rescue'], target: process.execPath }, { cwd: canonicalWorkspace, env: directEnv, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });
    assert.notEqual(result.code, 0, `${scenario.name} unexpectedly executed installed Rescue`);
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(scenario.expectedCode));
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(parentSecret));
    const calls = await readZCodeCalls(zcodeRecord); assert.equal(calls.filter((call) => call.method === 'session/send').length, 0, `${scenario.name} reached ZCode`);
    assert.equal((await canonicalJobIds(join(storage.directory, 'jobs'))).size, 0, `${scenario.name} reserved a job before Role identity failed closed`);
  }
}

async function installPrivateCapabilityObserver(installedPluginRoot, temporary) {
  const worker = join(installedPluginRoot, 'scripts', 'lib', 'background-worker.mjs');
  const productionWorker = join(installedPluginRoot, 'scripts', 'lib', 'background-worker-production.mjs');
  const evidencePath = join(temporary, 'private-production-capability.json');
  await rename(worker, productionWorker);
  await writeFile(worker, [
    "import { writeFile } from 'node:fs/promises';",
    "import { startBackgroundWorker as productionStartBackgroundWorker } from './background-worker-production.mjs';",
    "export * from './background-worker-production.mjs';",
    'export async function startBackgroundWorker(input) {',
    '  const evidencePath = process.env.ZCODE_TEST_PRIVATE_CAPABILITY_EVIDENCE;',
    "  if (evidencePath) await writeFile(evidencePath, JSON.stringify({ jobId: input.jobId, executionCapability: input.executionCapability }), { mode: 0o600, flag: 'wx' });",
    '  return productionStartBackgroundWorker(input);',
    '}',
    '',
  ].join('\n'), { mode: 0o600 });
  return evidencePath;
}

async function codex(args, cwd, env, timeoutMs = 60_000) { return runProcess(codexLaunch(args, { root, env }), { cwd, env, timeoutMs, maxOutputBytes: 16 * 1024 * 1024 }); }
function controlledCodex(args, cwd, env, timeoutMs = 60_000) {
  const controller = new AbortController();
  const result = runProcess(codexLaunch(args, { root, env }), { cwd, env, timeoutMs, maxOutputBytes: 16 * 1024 * 1024, signal: controller.signal });
  return { result, terminate: async () => { controller.abort(); await result.catch(() => {}); } };
}

async function runHeldForegroundRescue(input) {
  const releaseGate = input.releaseGate ?? ((path) => writeFile(path, 'release'));
  const sleep = input.sleep ?? ((duration) => new Promise((resolvePromise) => setTimeout(resolvePromise, duration)));
  const readProcessMarker = input.readProcessMarker ?? (async () => JSON.parse(await readFile(input.processPath, 'utf8')));
  const inspectProcessIdentity = input.inspectProcessIdentity ?? inspectExactProcessIdentity;
  const captureProcessIdentity = input.captureProcessIdentity ?? (async () => captureExactProcessIdentity(await readProcessMarker(), input.processNonce, inspectProcessIdentity));
  const readProcessIdentity = input.readProcessIdentity ?? ((expected) => readExactProcessIdentity(expected, readProcessMarker, inspectProcessIdentity));
  const waitForProcessExit = input.waitForProcessExit ?? ((expected, phase) => waitForExactProcessExit(expected, readProcessIdentity, phase));
  const terminateExactProcess = input.terminateExactProcess ?? ((expected) => terminateVerifiedProcess(expected, readProcessIdentity));
  const gateController = new AbortController();
  let control; let resultOutcome; let gateOutcome; let identity; let gateReleased = false; let completed = false; let answer; let failure;
  try {
    control = await input.launch();
    resultOutcome = Promise.resolve(control.result).then(
      (value) => ({ kind: 'result', value }),
      (error) => ({ kind: 'error', error }),
    );
    gateOutcome = Promise.resolve().then(() => input.waitForGate(gateController.signal)).then(
      () => ({ kind: 'held' }),
      (error) => ({ kind: 'gate-error', error }),
    );
    const boundary = await Promise.race([gateOutcome, resultOutcome]);
    if (boundary.kind === 'gate-error') throw boundary.error;
    if (boundary.kind === 'error') throw boundary.error;
    if (boundary.kind === 'result') {
      gateController.abort(); await gateOutcome;
      answer = { endedBeforeGate: true, rescue: boundary.value };
    } else {
      identity = await captureProcessIdentity();
      await sleep(input.holdMs ?? 35_000);
      const processAliveWhileHeld = await readProcessIdentity(identity) !== undefined;
      await releaseGate(input.gatePath); gateReleased = true;
      const outcome = await resultOutcome;
      if (outcome.kind === 'error') throw outcome.error;
      await waitForProcessExit(identity, 'natural');
      answer = { endedBeforeGate: false, identity, processAliveWhileHeld, rescue: outcome.value };
      completed = true;
    }
  } catch (error) { failure = error; }
  const cleanupErrors = [];
  gateController.abort();
  if (gateOutcome) { try { await gateOutcome; } catch (error) { cleanupErrors.push(error); } }
  if (!gateReleased) {
    try { await releaseGate(input.gatePath); gateReleased = true; } catch (error) { cleanupErrors.push(error); }
  }
  if (!completed) {
    if (!identity) {
      try { identity = await captureProcessIdentity(); }
      catch (error) { if (!processMarkerUnavailable(error)) cleanupErrors.push(error); }
    }
    if (identity) {
      let current;
      try { current = await readProcessIdentity(identity); } catch (error) { cleanupErrors.push(error); }
      if (current) {
        try { await terminateExactProcess(identity); } catch (error) { cleanupErrors.push(error); }
        try { await waitForProcessExit(identity, 'cleanup'); } catch (error) { cleanupErrors.push(error); }
      }
    }
    if (typeof control?.terminate === 'function') { try { await control.terminate(); } catch (error) { cleanupErrors.push(error); } }
  }
  if (cleanupErrors.length > 0) {
    if (!failure) failure = cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, 'foreground Rescue cleanup failed');
    else {
      const identityChanged = cleanupErrors.some((error) => /exact fake-ZCode process identity changed/iu.test(error?.message ?? ''));
      failure = new AggregateError([failure, ...cleanupErrors], identityChanged ? `${failure.message}; exact fake-ZCode process identity changed during cleanup` : failure.message);
    }
  }
  if (failure) throw failure;
  return answer;
}

async function captureExactProcessIdentity(marker, expectedNonce, inspect) {
  validateProcessNonce(expectedNonce); validateProcessMarker(marker, expectedNonce);
  const observed = await inspect(marker.pid, expectedNonce, 'FAKE_ZCODE_PROCESS_NONCE');
  if (!observed) throw new Error('exact fake-ZCode process exited before identity capture');
  validateObservedProcess(observed, marker.pid, expectedNonce);
  if (observed.ppid !== marker.ppid) throw new Error('exact fake-ZCode parent identity mismatch');
  return { pid: marker.pid, ppid: marker.ppid, nonce: expectedNonce, nonceVariable: 'FAKE_ZCODE_PROCESS_NONCE', startIdentity: observed.startIdentity };
}

async function captureExactPidIdentity(pid, expectedNonce, nonceVariable) {
  validateProcessNonce(expectedNonce);
  const observed = await inspectExactProcessIdentity(pid, expectedNonce, nonceVariable);
  if (!observed) throw new Error('exact installed process exited before identity capture');
  validateObservedProcess(observed, pid, expectedNonce);
  return { pid, ppid: observed.ppid, nonce: expectedNonce, nonceVariable, startIdentity: observed.startIdentity };
}

function processMarkerUnavailable(error) { return error?.code === 'ENOENT' || error instanceof SyntaxError; }

async function readExactProcessIdentity(expected, readMarker, inspect) {
  const marker = await readMarker(); validateProcessMarker(marker, expected.nonce);
  if (marker.pid !== expected.pid || marker.ppid !== expected.ppid) throw new Error('exact fake-ZCode process identity changed');
  const observed = await inspect(expected.pid, expected.nonce, expected.nonceVariable);
  if (!observed) return undefined;
  validateObservedProcess(observed, expected.pid, expected.nonce);
  if (observed.ppid !== expected.ppid || observed.startIdentity !== expected.startIdentity) throw new Error('exact fake-ZCode process identity changed');
  return observed;
}

async function readExactPidIdentity(expected) {
  const observed = await inspectExactProcessIdentity(expected.pid, expected.nonce, expected.nonceVariable);
  if (!observed) return undefined;
  validateObservedProcess(observed, expected.pid, expected.nonce);
  if (observed.ppid !== expected.ppid || observed.startIdentity !== expected.startIdentity) throw new Error('exact installed process identity changed');
  return observed;
}

function validateProcessNonce(nonce) {
  if (typeof nonce !== 'string' || !/^[a-f0-9]{64}$/u.test(nonce)) throw new Error('exact fake-ZCode process nonce mismatch');
}

function validateProcessMarker(marker, expectedNonce) {
  validateProcessNonce(expectedNonce);
  if (!marker || !Number.isSafeInteger(marker.pid) || marker.pid <= 0 || !Number.isSafeInteger(marker.ppid) || marker.ppid <= 0) throw new Error('exact fake-ZCode process marker identity is invalid');
  if (marker.nonce !== expectedNonce) throw new Error('exact fake-ZCode process nonce mismatch');
}

function validateObservedProcess(observed, expectedPid, expectedNonce) {
  if (observed.pid !== expectedPid || !Number.isSafeInteger(observed.ppid) || observed.ppid <= 0) throw new Error('exact fake-ZCode process identity changed');
  if (typeof observed.startIdentity !== 'string' || observed.startIdentity.length === 0 || observed.startIdentity.length > 256) throw new Error('exact fake-ZCode process start identity is unavailable');
  if (observed.processNonce !== expectedNonce) throw new Error('exact fake-ZCode process identity changed');
}

async function inspectExactProcessIdentity(pid, expectedNonce, nonceVariable = 'FAKE_ZCODE_PROCESS_NONCE') {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('exact fake-ZCode PID is invalid');
  validateProcessNonce(expectedNonce);
  if (typeof nonceVariable !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(nonceVariable)) throw new Error('exact fake-ZCode process nonce marker is invalid');
  if (process.platform === 'win32') throw new Error('stable fake-ZCode process identity is unavailable on this platform');
  if (process.platform === 'linux') {
    const before = await readLinuxProcessStart(pid); if (!before) return undefined;
    let environ;
    try { environ = await readFile(`/proc/${pid}/environ`, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
    const after = await readLinuxProcessStart(pid); if (!after) return undefined;
    if (before.ppid !== after.ppid || before.startIdentity !== after.startIdentity) throw new Error('exact fake-ZCode process identity changed');
    if (!environ.split('\0').includes(`${nonceVariable}=${expectedNonce}`)) throw new Error('exact fake-ZCode process identity changed');
    return { ...after, processNonce: expectedNonce };
  }
  const before = await readPsProcessStart(pid); if (!before) return undefined;
  const command = await runProcess({ command: 'ps', args: ['eww', '-o', 'command=', '-p', String(pid)] }, { timeoutMs: 2_000, maxOutputBytes: 64 * 1024 });
  if (command.code !== 0 || !command.stdout.trim()) return undefined;
  const after = await readPsProcessStart(pid); if (!after) return undefined;
  if (before.ppid !== after.ppid || before.startIdentity !== after.startIdentity) throw new Error('exact fake-ZCode process identity changed');
  const nonceMarker = `${nonceVariable}=${expectedNonce}`;
  if (!command.stdout.split(/\s+/u).includes(nonceMarker)) throw new Error('exact fake-ZCode process identity changed');
  return { ...after, processNonce: expectedNonce };
}

async function readLinuxProcessStart(pid) {
  let statText;
  try { statText = await readFile(`/proc/${pid}/stat`, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
  const close = statText.lastIndexOf(')'); const fields = close < 0 ? [] : statText.slice(close + 2).trim().split(/\s+/u);
  const observedPid = Number(statText.slice(0, statText.indexOf(' '))); const ppid = Number(fields[1]); const startTicks = fields[19];
  if (observedPid !== pid || !Number.isSafeInteger(ppid) || ppid <= 0 || !/^\d+$/u.test(startTicks ?? '')) throw new Error('stable fake-ZCode process identity could not be parsed');
  return { pid: observedPid, ppid, startIdentity: `proc:${startTicks}` };
}

async function readPsProcessStart(pid) {
  const result = await runProcess({ command: 'ps', args: ['-o', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-p', String(pid)] }, { timeoutMs: 2_000, maxOutputBytes: 4 * 1024 });
  if (result.code !== 0 || !result.stdout.trim()) return undefined;
  const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(result.stdout);
  if (!match || Number(match[1]) !== pid || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= 0) throw new Error('stable fake-ZCode process identity could not be parsed');
  return { pid, ppid: Number(match[2]), startIdentity: match[3] };
}

async function terminateVerifiedProcess(expected, readIdentity) {
  if (!await readIdentity(expected)) return;
  try { process.kill(expected.pid, 'SIGTERM'); } catch { return; }
  try { await waitForExactProcessExit(expected, readIdentity, 'terminate'); return; } catch { /* escalate only the still-matching PID */ }
  if (!await readIdentity(expected)) return;
  try { process.kill(expected.pid, 'SIGKILL'); } catch { /* already exited */ }
}

async function signalExactProcess(expected, readIdentity, signal) {
  if (!['SIGTERM', 'SIGKILL'].includes(signal)) throw new Error('exact installed process signal is invalid');
  if (!await readIdentity(expected)) return false;
  try { process.kill(expected.pid, signal); return true; } catch { return false; }
}

async function waitForExactProcessExit(expected, readIdentity, phase) {
  const timeoutMs = phase === 'natural' ? 10_000 : phase === 'terminate' ? 1_000 : 5_000;
  await waitUntil(async () => await readIdentity(expected) === undefined, timeoutMs, `the exact fake-ZCode process remained alive during ${phase}`);
}
async function git(args, cwd) { const result = await runProcess({ command: 'git', args, options: { shell: false } }, { cwd, timeoutMs: 30_000 }); assert.equal(result.code, 0, result.stderr); return result; }
async function initializeGitWorkspace(workspace) { await mkdir(workspace, { recursive: true }); await git(['init', '-q'], workspace); await writeFile(join(workspace, 'tracked.txt'), 'base\n'); await git(['add', 'tracked.txt'], workspace); await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], workspace); }
async function waitUntil(predicate, timeoutMs, message, signal) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (signal?.aborted) throw abortError(); if (await predicate()) return; await abortableDelay(50, signal); } assert.fail(message); }
function abortableDelay(timeoutMs, signal) { return new Promise((resolvePromise, reject) => { if (signal?.aborted) { reject(abortError()); return; } const timer = setTimeout(finish, timeoutMs); const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(abortError()); }; function finish() { signal?.removeEventListener('abort', cancel); resolvePromise(); } signal?.addEventListener('abort', cancel, { once: true }); }); }
function abortError() { const error = new Error('foreground gate wait aborted'); error.name = 'AbortError'; return error; }
async function waitForValue(read, timeoutMs, message) { let value; await waitUntil(async () => { value = await read(); return value !== undefined; }, timeoutMs, message); return value; }
async function startInstalledTurn(app, threadId, text) { const result = await app.request('turn/start', { approvalPolicy: 'never', input: [{ type: 'text', text }], sandboxPolicy: { type: 'dangerFullAccess' }, threadId }, 30_000); assert.ok(result.turn?.id, 'installed turn/start omitted its turn ID'); return result.turn.id; }
async function waitForCodexTurn(app, threadId, turnId, timeoutMs) {
  const completed = await waitForValue(() => app.frames.find((frame) => frame?.method === 'turn/completed'
    && frame.params?.threadId === threadId && frame.params?.turn?.id === turnId), timeoutMs, `installed Codex turn ${turnId} did not complete`);
  assert.equal(completed.params.turn.status, 'completed', `installed Codex turn failed: ${JSON.stringify(completed.params.turn.error ?? completed.params.turn.status)}\n${app.stderr()}`);
  return completed.params.turn;
}
async function canonicalJobIds(jobsDirectory) { try { return new Set((await readdir(jobsDirectory, { withFileTypes: true })).filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name)).map((entry) => entry.name.slice(0, -5))); } catch (error) { if (error?.code === 'ENOENT') return new Set(); throw error; } }
async function discoverNewJobIds(jobsDirectory, baselineJobIds, timeoutMs) { const deadline = Date.now() + timeoutMs; let discovered = []; do { discovered = [...await canonicalJobIds(jobsDirectory)].filter((jobId) => !baselineJobIds.has(jobId)); if (discovered.length > 0) break; await new Promise((resolve) => setTimeout(resolve, 50)); } while (Date.now() < deadline); return discovered.sort(); }
async function readExactJob(jobPath, jobId) { try { const job = JSON.parse(await readFile(jobPath, 'utf8')); return job?.id === jobId ? job : undefined; } catch { return undefined; } }
function exactWorkerIdentity(job) { assert.ok(Number.isSafeInteger(job?.childPid) && job.childPid > 0); assert.ok(typeof job.workerLeaseId === 'string' && /^[a-f0-9]{64}$/u.test(job.workerLeaseId)); return { pid: job.childPid, workerLeaseId: job.workerLeaseId }; }
function processAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function exactWorkerLeaseAvailable(dataRoot, workspace, jobId, workerLeaseId) { try { await withWorkerLease({ dataRoot, workspace, jobId, workerLeaseId, timeoutMs: 0 }, async () => {}); return true; } catch (error) { if (error?.code === 'LOCK_TIMEOUT') return false; throw error; } }
async function cleanupExactJobNaturally(dataRoot, workspace, jobPath, jobId, identity) { let job = await waitForValue(() => readExactJob(jobPath, jobId), 2_000, 'exact background job was not persisted before teardown'); const exact = identity ?? (job.workerLeaseId ? exactWorkerIdentity(job) : null); await waitUntil(async () => { job = await readExactJob(jobPath, jobId); return job && ['succeeded', 'failed', 'cancelled'].includes(job.status) && (!exact || job.workerLeaseId === exact.workerLeaseId && await exactWorkerLeaseAvailable(dataRoot, workspace, jobId, exact.workerLeaseId)); }, 30_000, `exact background job ${jobId} did not naturally reach terminal state and release its worker lease`); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
async function readZCodeCalls(path) { const value = await readFile(path, 'utf8'); return value.trim().split('\n').filter(Boolean).map(JSON.parse); }

function nativeRouteEvidence(rollouts, parentThreadId) {
  const parent = rollouts.find((events) => events.find((event) => event?.type === 'session_meta')?.payload?.id === parentThreadId);
  if (!parent) return undefined;
  const spawns = parent.filter((event) => event?.type === 'response_item' && event.payload?.type === 'function_call' && event.payload.name === 'spawn_agent');
  const starts = parent.filter((event) => event?.type === 'event_msg' && event.payload?.type === 'sub_agent_activity' && event.payload.kind === 'started');
  if (spawns.length === 0 || starts.length === 0) return undefined;
  const waitCalls = parent.filter((event) => event?.type === 'response_item' && event.payload?.type === 'function_call' && event.payload.name === 'wait_agent');
  const completedCallIds = new Set(parent.filter((event) => event?.type === 'response_item' && event.payload?.type === 'function_call_output').map((event) => event.payload.call_id));
  return {
    childThreadId: starts.length === 1 ? starts[0].payload.agent_thread_id : undefined,
    pendingWait: waitCalls.some((event) => !completedCallIds.has(event.payload.call_id)),
    spawnCount: spawns.length,
    startCount: starts.length,
  };
}

async function createInstalledCodexAppServer(cwd, env) {
  const launch = codexLaunch(['app-server', '--enable', 'hooks', '-c', 'shell_environment_policy.inherit=all', '-c', 'bypass_hook_trust=true'], { root, env });
  const child = spawn(launch.command, launch.args, { ...launch.options, cwd, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const frames = []; const pending = new Map(); let nextId = 1; let buffer = ''; let stderr = ''; let outputBytes = 0; let closed = false;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16 * 1024); });
  child.stdout.on('data', (chunk) => {
    if (closed) return;
    outputBytes += Buffer.byteLength(chunk); if (outputBytes > 32 * 1024 * 1024) { failAll(new Error('installed Codex app-server exceeded its output bound')); return; }
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf('\n'); if (newline < 0) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line) continue;
      let frame; try { frame = JSON.parse(line); } catch (error) { failAll(error); continue; }
      frames.push(frame);
      if (Object.hasOwn(frame, 'method') || !Object.hasOwn(frame, 'id')) continue;
      const item = pending.get(frame.id); if (!item) continue;
      pending.delete(frame.id); clearTimeout(item.timer);
      if (frame.error) item.reject(new Error(`installed Codex app-server ${item.method} failed: ${JSON.stringify(frame.error)}`));
      else item.resolve(frame.result);
    }
  });
  child.once('exit', (code, signal) => { if (!closed) failAll(new Error(`installed Codex app-server exited early: ${code ?? signal}\n${stderr}`)); });
  child.once('error', failAll);
  const request = (method, params, timeoutMs = 30_000) => new Promise((resolve, reject) => {
    const id = nextId++; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`installed Codex app-server timed out during ${method}\n${stderr}`)); }, timeoutMs);
    pending.set(id, { method, resolve, reject, timer }); child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const close = async (signal = 'SIGTERM') => {
    if (closed) return; closed = true; failAll(new Error('installed Codex app-server closed'));
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); } catch { /* already exited */ }
    }
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (child.exitCode === null && child.signalCode === null) {
      try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
  };
  function failAll(error) { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); }
  await request('initialize', { clientInfo: { name: 'zcode-installed-e2e', title: 'ZCode installed E2E', version: '1.0.0' }, capabilities: { experimentalApi: true } }, 30_000);
  child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  return { close, frames, pid: child.pid, request, stderr: () => stderr };
}

async function cleanupInstalledEvidence(input) {
  const cleanupTimeoutMs = input.cleanupTimeoutMs ?? 2_000;
  const runCleanupDeadline = input.runCleanupDeadline ?? cleanupDeadline;
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1
    || !Array.isArray(input.credentialPaths) || input.credentialPaths.length > 16
    || typeof runCleanupDeadline !== 'function') throw new Error('installed evidence cleanup input is invalid');
  const temporary = resolve(input.temporary); const rootStats = await lstat(temporary); const canonicalRoot = await realpath(temporary);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new Error('installed evidence root is unsafe');
  let scrubFailed = false;
  for (const credentialPath of input.credentialPaths) {
    try {
      const exactPath = resolve(credentialPath);
      if (!pathWithin(temporary, exactPath)) throw new Error('isolated credential path is outside evidence root');
      const canonicalParent = await realpath(dirname(exactPath));
      if (!pathWithin(canonicalRoot, canonicalParent)) throw new Error('isolated credential parent escapes evidence root');
      await removeCredentialWithFallback(exactPath, input.removeCredential, cleanupTimeoutMs, runCleanupDeadline);
    } catch { scrubFailed = true; }
  }
  if (scrubFailed) {
    await runCleanupDeadline(() => rm(temporary, { recursive: true, force: true }), cleanupTimeoutMs, 'temporary').catch(() => {});
    throw new Error('isolated installed credentials could not be scrubbed safely');
  }
  if (input.preserve) input.diagnostic?.(`preserved installed evidence at ${temporary} after isolated credential scrub`);
  else await runCleanupDeadline(() => rm(temporary, { recursive: true, force: true }), cleanupTimeoutMs, 'temporary');
}

async function removeCredentialWithFallback(path, removeCredential, cleanupTimeoutMs, runCleanupDeadline) {
  const remove = removeCredential ?? unlink;
  try { await runCleanupDeadline(() => remove(path), cleanupTimeoutMs, 'credential'); }
  catch {
    try { await runCleanupDeadline(() => unlink(path), cleanupTimeoutMs, 'fallback'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  try { await lstat(path); throw new Error('isolated credential still exists after cleanup'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

async function cleanupDeadline(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('installed evidence cleanup timed out')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

function pathWithin(root, path) {
  const descendant = relative(root, path);
  return descendant === '' || descendant !== '..' && !descendant.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(descendant);
}

function unqualified(code, detail) { return `codex-skills-unqualified ${JSON.stringify({ qualified: false, code, detail })}`; }
function observation(code, qualificationScope, detail) { return `codex-skills-observation ${JSON.stringify({ observed: false, code, qualificationScope, detail })}`; }
function markUnqualified(t, message) { if (qualificationRequired) assert.fail(message); t.skip(message); }
async function requireSupportedCodexLine(t, cwd, env) {
  const result = await codex(['--version'], cwd, env, 30_000);
  const match = /\b(\d+\.\d+)\.\d+(?:\b|$)/u.exec(`${result.stdout}\n${result.stderr}`);
  if (result.code === 0 && match && SUPPORTED_CODEX_LINES.includes(match[1])) return true;
  markUnqualified(t, unqualified('codex-version-unsupported', `Installed Codex did not report a supported line (${SUPPORTED_CODEX_LINES.join(', ')}).`));
  return false;
}
function skipExternalFailure(t, result) {
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0 && /unauthorized|authentication|not logged in|login required|\b401\b/i.test(output)) { markUnqualified(t, unqualified('auth-required', 'Codex authentication expired or was rejected.')); return true; }
  if (result.code !== 0 && /credit|usage limit|quota|rate.?limit|insufficient/i.test(output)) { markUnqualified(t, unqualified('credits-unavailable', 'The authenticated account has no credits available for qualification.')); return true; }
  return false;
}

async function findInstalledPluginRoot(codexHome) {
  const cacheRoot = join(codexHome, 'plugins', 'cache', 'vitry', 'zcode');
  const entries = await readdir(cacheRoot, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(cacheRoot, entry.name);
    try { await stat(join(candidate, 'skills', 'rescue', 'SKILL.md')); candidates.push(await realpath(candidate)); } catch { continue; }
  }
  assert.equal(candidates.length, 1, 'isolated Codex home must contain exactly one installed ZCode plugin root');
  return candidates[0];
}

async function loadCodexRollouts(codexHome) {
  const pending = [{ path: join(codexHome, 'sessions'), depth: 0 }];
  const files = [];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try { entries = await readdir(current.path, { withFileTypes: true }); }
    catch (error) { throw new CodexRescueEvidenceMismatchError('rollouts-unavailable', `Codex session rollouts are unavailable: ${error.code ?? 'read-failed'}.`); }
    for (const entry of entries) {
      const path = join(current.path, entry.name);
      if (entry.isDirectory() && current.depth < 6) pending.push({ path, depth: current.depth + 1 });
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
      if (files.length > 64 || pending.length > 256) throw new CodexRescueEvidenceMismatchError('rollouts-overflow', 'Codex rollout discovery exceeded its qualification bound.');
    }
  }
  if (files.length === 0) throw new CodexRescueEvidenceMismatchError('rollouts-unavailable', 'Codex produced no persisted rollout files.');
  return Promise.all(files.map(async (path) => {
    const metadata = await stat(path);
    if (metadata.size > 16 * 1024 * 1024) throw new CodexRescueEvidenceMismatchError('rollout-file-oversize', 'A Codex rollout exceeds the qualification bound.');
    return parseCodexRolloutJsonl(await readFile(path, 'utf8'));
  }));
}
