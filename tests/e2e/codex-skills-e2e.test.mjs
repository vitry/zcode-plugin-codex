// @ts-nocheck
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { buildMarketplaceSnapshot } from '../../scripts/build-marketplace-snapshot.mjs';
import { runProcess } from '../../scripts/lib/process.mjs';
import { withWorkerLease } from '../../scripts/lib/recovery.mjs';
import { parseRescueProgressRelay, RESCUE_RELAY_MESSAGES, RESCUE_RELAY_PREFIX } from '../../scripts/lib/rescue-progress-relay.mjs';
import { codexLaunch, npmLaunch } from '../../scripts/lib/tool-launch.mjs';
import { resolveWorkspaceStorage } from '../../scripts/lib/workspace.mjs';
import { createRescueBinding, createRescueBindingAuthority, createRescueBindingPartition } from '../../scripts/lib/rescue-binding.mjs';
import {
  assertCodexRescueDisplayName,
  CodexRescueEvidenceMismatchError,
  CodexRescueUnqualifiedError,
  parseCodexRolloutJsonl,
  qualifyCodexRescueBackgroundEvidence,
  qualifyCodexRescueChoiceEvidence,
  qualifyCodexRescueEvidence,
} from '../helpers/codex-rescue-qualification.mjs';
import {
  assertRescueRouteContract,
  expectedGenericRescueMessage,
  expectedNamedRescueMessage,
} from '../helpers/rescue-skill-contract.mjs';
import {
  assertInstalledForwarderLifecycleContract,
  assertInstalledPreparedContinuationContract,
  extractInstalledRoleInstructions,
  installedCanonicalContradictionMutations,
  installedCommandPathMutations,
  installedLifecycleContractMutations,
} from '../helpers/installed-rescue-lifecycle-contract.mjs';
import { runChild } from '../helpers/run-child.mjs';

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
  const choiceLinkage = exactSourceRegion(installedQualification,
    '  function assertInstalledRescueChoiceLinkage(', '\n\n  if (process.env.ZCODE_CODEX_RESCUE_E2E', 'choice yielded linkage');
  assertSourceOrder(choiceLinkage, [
    'installedChoiceYieldFacts(rollouts, evidence.childThreadId, commands);',
    'assert.deepEqual(yielded, {',
    'initial: { execCommandCount: 1, pollCount: yielded.initial.pollCount, sameHandleChecked: true, terminalExitCode: 3 }',
    'continuation: { execCommandCount: 1, pollCount: yielded.continuation.pollCount, sameHandleChecked: true, terminalExitCode: 0 }',
  ], 'choice yielded linkage');
  assert.match(installedQualification, /const pendingSegment = await runHeldChoiceSegment\(`\$\{choice\}-initial`, expectedCommand,/u,
    'choice initial segment must use the held yielded-process gate');
  assert.match(installedQualification, /const answerSegment = await runHeldChoiceSegment\(`\$\{choice\}-continuation`, choiceCommand,/u,
    'choice continuation segment must use the held yielded-process gate');
  assertSourceOrder(installedQualification, [
    'const pendingFrames =',
    'const pendingIdentity = captureInstalledRescueChoiceIdentity(pendingRollouts, parentIds[0]);',
    'const answerSegment = await runHeldChoiceSegment(',
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
    ...(requireChoiceLinkage ? ['assertInstalledRescueChoiceLinkage(choiceRollouts, parentIds[0], evidence, pendingIdentity, { initial: expectedCommand, continuation: choiceCommand, status: expectedStatusCommand });'] : []),
  ], `${label} display${requireChoiceLinkage ? ' and linkage' : ''}`);
  if (label !== 'background') {
    const callEnd = success.indexOf(label === 'choice' ? '\n      );' : '\n    );');
    assert.ok(callEnd > 0, `${label} qualification call must have an exact bounded region`);
    const qualifierCall = success.slice(0, callEnd);
    assert.match(qualifierCall, /requireProgressRelay:\s*true/u, `${label} qualification must require a fixed parent relay`);
    assert.match(qualifierCall, /expectedStatusCommand/u, `${label} qualification must validate any optional bound status sidecar`);
    assert.match(success, /progressRelayChecked/u, `${label} qualification must assert the fixed parent relay result`);
  }
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
    ...(requireChoiceLinkage ? ['assertInstalledRescueChoiceLinkage(choiceRollouts, parentIds[0], error.evidence, pendingIdentity, { initial: expectedCommand, continuation: choiceCommand, status: expectedStatusCommand });'] : []),
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

test('foreground Rescue waits for relay observation before releasing the exact completion gate', async () => {
  const events = []; let alive = true; let resolveResult;
  const result = new Promise((resolvePromise) => { resolveResult = resolvePromise; });
  const foreground = await runHeldForegroundRescue({
    gatePath: '/exact/gate', processPath: '/exact/process.json', processNonce: TEST_PROCESS_NONCE,
    launch: () => ({ result }),
    waitForGate: async () => { events.push('completion-held'); },
    waitForObservation: async () => { events.push('relay-observed'); },
    readProcessMarker: async () => ({ pid: 59623, ppid: 72, nonce: TEST_PROCESS_NONCE }),
    inspectProcessIdentity: async () => alive ? ({ pid: 59623, ppid: 72, startIdentity: 'start-a', processNonce: TEST_PROCESS_NONCE }) : undefined,
    releaseGate: async () => { events.push('release'); alive = false; resolveResult({ code: 0, stdout: '', stderr: '' }); },
    waitForProcessExit: async () => {},
    sleep: async () => { events.push('yield-proved'); }, holdMs: 0,
  });
  assert.equal(foreground.endedBeforeGate, false);
  assert.deepEqual(events, ['completion-held', 'relay-observed', 'yield-proved', 'release']);
});

test('installed relay gate accepts only a strict fixed record paired with its root message', () => {
  const relay = '[zcode-relay] {"version":1,"sequence":1,"phase":"starting","code":"started","observedAt":"2026-08-17T00:00:00.000Z"}\n';
  const result = (output) => ({ payload: { type: 'custom_tool_call_output', output: JSON.stringify({ output }) } });
  const send = (target, message) => ({ payload: { type: 'function_call', name: 'send_message', arguments: JSON.stringify({ target, message }) } });
  assert.equal(installedRelayObserved([[result(`[zcode] PRIVATE detail\n${relay}`), send('/root', 'ZCode Rescue started.')]]), true);
  assert.equal(installedRelayObserved([[result('[zcode] PRIVATE detail\n'), send('/root', 'ZCode Rescue started.')]]), false);
  assert.equal(installedRelayObserved([[result(relay), send('/root/sibling', 'ZCode Rescue started.')]]), false);
  assert.equal(installedRelayObserved([[result(relay), send('/root', '[zcode] PRIVATE detail')]]), false);
  assert.equal(installedRelayObserved([[result(relay.replace('"sequence":1', '"sequence":0')), send('/root', 'ZCode Rescue started.')]]), false);
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

  const missingChoiceLinkage = source.replace('        assertInstalledRescueChoiceLinkage(choiceRollouts, parentIds[0], error.evidence, pendingIdentity, { initial: expectedCommand, continuation: choiceCommand, status: expectedStatusCommand });\n', '');
  assert.throws(() => assertInstalledRescueQualificationSource(missingChoiceLinkage), /choice encrypted guard display and linkage/u);

  const foregroundCatch = '  } catch (error) {\n';
  const foregroundPredicate = "    if (error instanceof CodexRescueUnqualifiedError && error.code === 'spawn-message-encrypted') {\n";
  const movedDisplayAboveGuard = source.replace(encryptedDisplay, '').replace(foregroundCatch + foregroundPredicate, foregroundCatch + encryptedDisplay + foregroundPredicate);
  assert.throws(() => assertInstalledRescueQualificationSource(movedDisplayAboveGuard), /foreground encrypted guard/u);

  const choiceEncryptedChecks = '        assertInstalledRescueDisplay(error.evidence);\n        assert.equal(error.evidence.progressRelayChecked, true);\n        assertInstalledRescueChoiceLinkage(choiceRollouts, parentIds[0], error.evidence, pendingIdentity, { initial: expectedCommand, continuation: choiceCommand, status: expectedStatusCommand });\n';
  const choiceCatch = '    } catch (error) {\n';
  const choicePredicate = "      if (error instanceof CodexRescueUnqualifiedError && ['choice-followup-encrypted', 'choice-spawn-encrypted'].includes(error.code)) {\n";
  const movedChoiceChecksAboveGuard = source.replace(choiceEncryptedChecks, '').replace(choiceCatch + choicePredicate, choiceCatch + choiceEncryptedChecks + choicePredicate);
  assert.throws(() => assertInstalledRescueQualificationSource(movedChoiceChecksAboveGuard), /choice encrypted guard/u);

  const missingForegroundRelayRequirement = source.replace('        requireProgressRelay: true,\n', '');
  assert.throws(() => assertInstalledRescueQualificationSource(missingForegroundRelayRequirement), /foreground qualification must require a fixed parent relay/u);
  const missingChoiceStatusContract = source.replace('          expectedStatusCommand,\n', '');
  assert.throws(() => assertInstalledRescueQualificationSource(missingChoiceStatusContract), /choice qualification must validate any optional bound status sidecar/u);
  const missingChoiceYieldedEvidence = source.replace('    const yielded = installedChoiceYieldFacts(rollouts, evidence.childThreadId, commands);\n', '');
  assert.throws(() => assertInstalledRescueQualificationSource(missingChoiceYieldedEvidence), /choice yielded linkage/u);
  const missingInitialHeldGate = source.replace('\n    const pendingSegment = await runHeldChoiceSegment(', '\n    const pendingSegment = await unheldChoiceSegment(');
  assert.throws(() => assertInstalledRescueQualificationSource(missingInitialHeldGate), /choice initial segment must use the held yielded-process gate/u);
  const missingContinuationHeldGate = source.replace('\n    const answerSegment = await runHeldChoiceSegment(', '\n    const answerSegment = await unheldChoiceSegment(');
  assert.throws(() => assertInstalledRescueQualificationSource(missingContinuationHeldGate), /choice continuation segment must use the held yielded-process gate/u);
});

test('installed named and generic foreground and choice policies independently bind relay status and terminal order', async () => {
  const role = extractInstalledRoleInstructions(await readFile(join(root, 'agents', 'zcode-rescue.toml.template'), 'utf8'));
  const skill = await readFile(join(root, 'skills', 'rescue', 'SKILL.md'), 'utf8');
  const generic = assertRescueRouteContract(skill).genericMessage.text;
  for (const [route, source] of [['named', role], ['generic', generic]]) {
    const expectedRoot = route === 'named' ? '{{PLUGIN_ROOT}}' : '<canonical-plugin-root>';
    assertInstalledForwarderLifecycleContract(source, route, { expectedRoot });
    for (const [mutation, mutated] of installedLifecycleContractMutations(source, route, expectedRoot)) {
      assert.throws(() => assertInstalledForwarderLifecycleContract(mutated, route, { expectedRoot }), /unique operative lifecycle region/u, `${route}: ${mutation}`);
    }
    for (const [mutation, mutated] of installedCanonicalContradictionMutations(source, route)) {
      assert.throws(() => assertInstalledForwarderLifecycleContract(mutated, route, { expectedRoot }), /exact canonical operative route/u, `${route}: ${mutation}`);
    }
    for (const [mutation, mutated] of installedCommandPathMutations(source)) {
      assert.throws(() => assertInstalledForwarderLifecycleContract(mutated, route, { expectedRoot }), /trusted expected root and exact argv/u, `${route}: ${mutation}`);
    }
  }
});

test('synthetic captured qualification fixtures cover named and generic Codex 0.147 foreground rollouts', async () => {
  const routes = await installedCapturedRescueRoutes();
  for (const route of routes) {
    const evidence = qualifyInstalledCapturedForeground(route);
    assert.equal(evidence.route, route.expectedEvidenceRoute);
    assert.equal(evidence.progressRelayChecked, true);
    assert.equal(evidence.statusSidecarChecked, true);
    assert.deepEqual(evidence.yieldedExecution, {
      execCommandCount: 1,
      pollCount: 2,
      sameHandleChecked: true,
      terminalExitCode: 0,
    });
    assert.equal(route.fixture.rollouts.length, 2, `${route.name} must retain exactly one parent and one child rollout`);
    assert.equal(installedCapturedRunningHandles(route.fixture).size, 0, `${route.name} must leave no nonterminal handle orphaned`);
  }
});

test('synthetic captured qualification fixtures keep proactive clear fresh and resume routes one-shot', async () => {
  for (const resume of ['fresh', 'resume']) {
    const routes = await installedCapturedRescueRoutes({ source: 'proactive', options: { execution: 'foreground', resume } });
    for (const route of routes) {
      assert.equal(qualifyInstalledCapturedForeground(route).route, route.expectedEvidenceRoute);
      assert.deepEqual(JSON.parse(route.preparationPayload), {
        version: 1,
        source: 'proactive',
        task: `repair captured ${route.name} route`,
        options: { execution: 'foreground', resume },
      });
      const emittedNeedsChoice = route.fixture.rollouts.flat().some((event) => event?.payload?.type === 'custom_tool_call_output'
        && JSON.stringify(event.payload.output).includes('"type":"needs-choice"'));
      assert.equal(emittedNeedsChoice, false);
      assert.equal(route.fixture.rollouts[0].some((event) => event?.payload?.name === 'followup_task'), false);
    }
  }
});

test('synthetic captured qualification fixtures cover named and generic background routes', async () => {
  const routes = await installedCapturedRescueRoutes({ options: { execution: 'background', resume: 'fresh' } });
  for (const route of routes) {
    const background = installedCapturedBackgroundRoute(route);
    const evidence = qualifyInstalledCapturedBackground(background);
    assert.equal(evidence.route, route.expectedEvidenceRoute);
    assert.equal(evidence.jobId, background.jobId);
    assert.equal(evidence.capabilityChecked, true);
    assert.equal(installedCapturedRunningHandles(background.fixture).size, 0);
  }
});

test('synthetic captured qualification wiring mutations fail only the mutated foreground route', async () => {
  const routes = await installedCapturedRescueRoutes();
  for (const route of routes) {
    const other = routes.find((candidate) => candidate !== route);
    assert.equal(qualifyInstalledCapturedForeground(other).route, other.expectedEvidenceRoute, `${other.name} control route must remain qualified`);
    const mutated = { ...route, fixture: structuredClone(route.fixture) };
    const spawn = mutated.fixture.rollouts[0].find((event) => event?.payload?.name === 'spawn_agent');
    const args = JSON.parse(spawn.payload.arguments);
    if (route.name === 'named') delete args.agent_type;
    else args.agent_type = 'zcode-rescue';
    spawn.payload.arguments = JSON.stringify(args);
    assert.throws(() => qualifyInstalledCapturedForeground(mutated), CodexRescueEvidenceMismatchError, `${route.name} route wiring mutation`);
  }
});

test('synthetic captured qualification fixtures cover both named and generic choice segments', async () => {
  const routes = await installedCapturedRescueRoutes();
  for (const route of routes) {
    for (const requested of ['resume', 'fresh']) {
      const choice = installedCapturedChoiceRoute(route, requested);
      const evidence = qualifyInstalledCapturedChoice(choice);
      assert.equal(evidence.progressRelayChecked, true);
      assert.equal(evidence.statusSidecarChecked, true);
      assert.deepEqual(evidence.executions, { initial: { execCommandCount: 1 }, continuation: { execCommandCount: 1 } });
      assert.deepEqual(installedChoiceYieldFacts(choice.fixture.rollouts, choice.childThreadId, choice.commands), {
        initial: { execCommandCount: 1, pollCount: 2, sameHandleChecked: true, terminalExitCode: 3 },
        continuation: { execCommandCount: 1, pollCount: 2, sameHandleChecked: true, terminalExitCode: 0 },
      });
      assert.equal(installedCapturedRunningHandles(choice.fixture).size, 0, `${route.name} ${requested} choice must leave no nonterminal handle orphaned`);
    }
  }
});

test('synthetic continuation capture incorporates raw installed-hook Start/Stop artifacts', async (t) => {
  const skill = await readFile(join(root, 'skills', 'rescue', 'SKILL.md'), 'utf8');
  const genericSource = expectedGenericRescueMessage;
  const namedTemplate = await readFile(join(root, 'agents', 'zcode-rescue.toml.template'), 'utf8');
  const namedSource = extractInstalledRoleInstructions(namedTemplate);
  for (const [route, source, expectedRoot] of [
    ['named', namedSource, '{{PLUGIN_ROOT}}'],
    ['generic', genericSource, '<canonical-plugin-root>'],
  ]) {
    const temporary = await mkdtemp(join(tmpdir(), 'zcode-raw-continuation-')); t.after(() => rm(temporary, { recursive: true, force: true }));
    const workspaceDirectory = join(temporary, 'workspace'); const dataRoot = join(temporary, 'data'); await Promise.all([mkdir(workspaceDirectory), mkdir(dataRoot)]); const workspace = await realpath(workspaceDirectory);
    const installedHooks = join(root, 'marketplace', 'plugins', 'zcode', 'hooks'); const hookEnv = { ...process.env, ZCODE_DATA_ROOT: dataRoot };
    const hook = async (script, input) => runChild(process.execPath, [join(installedHooks, script)], { cwd: workspace, env: hookEnv, ordinaryInput: true, input });
    assert.equal((await hook('session-lifecycle-hook.mjs', { session_id: '019fe6df-faa2-7851-8edb-55f1be7d5489', cwd: workspace, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', source: 'startup' })).code, 0);
    assert.equal((await hook('user-prompt-hook.mjs', { session_id: '019fe6df-faa2-7851-8edb-55f1be7d5489', turn_id: 'turn-original', cwd: workspace, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', prompt: '$zcode:rescue --fresh repair' })).code, 0);
    const agentType = route === 'named' ? 'zcode-rescue' : 'default';
    const lifecycle = (event) => ({ session_id: '019fe6df-faa2-7851-8edb-55f1be7d5489', turn_id: 'child-turn', cwd: workspace, hook_event_name: event, transcript_path: null, model: 'gpt', permission_mode: 'acceptEdits', agent_id: '019fe6e0-4764-7192-83ba-0b0cc2c48660', agent_type: agentType, ...(event === 'SubagentStop' ? { agent_transcript_path: null, stop_hook_active: false, last_assistant_message: null } : {}) });
    assert.equal((await hook('subagent-hook.mjs', lifecycle('SubagentStart'))).code, 0);
    assert.equal((await hook('subagent-hook.mjs', lifecycle('SubagentStop'))).code, 0);
    const executorPath = (await recursiveFiles(dataRoot)).find((path) => basename(path).startsWith('executor-'));
    assert.ok(executorPath, 'installed hooks must persist the exact stopped executor record');
    assert.match(skill, /stopped exact same-operation child/i);
    const evidence = await assertInstalledPreparedContinuationContract(source, installedPreparedContinuationCapture(route, {
      workspace, executorRecordBytes: await readFile(executorPath, 'utf8'),
      hookLifecycleJson: JSON.stringify([{ ...lifecycle('SubagentStart'), parent_turn_id: 'turn-original' }, { ...lifecycle('SubagentStop'), parent_turn_id: 'turn-original' }, { hook_event_name: 'UserPromptSubmit', session_id: '019fe6df-faa2-7851-8edb-55f1be7d5489', turn_id: 'turn-fresh', cwd: workspace, permission_mode: 'acceptEdits' }]),
    }), { expectedRoot });
    assert.equal(evidence.continuationSpawnCount, 0);
    assert.equal(evidence.peerResumeChecked, true);
  }
});

test('installed choice qualification requires yielded same-handle terminal evidence in both logical segments', () => {
  const fixture = installedChoiceYieldFixture();
  assert.deepEqual(installedChoiceYieldFacts(fixture.rollouts, fixture.childThreadId, fixture.commands), {
    initial: { execCommandCount: 1, pollCount: 2, sameHandleChecked: true, terminalExitCode: 3 },
    continuation: { execCommandCount: 1, pollCount: 2, sameHandleChecked: true, terminalExitCode: 0 },
  });
  for (const [label, mutate] of [
    ['initial missing yield', (input) => {
      input.rollouts[0].find((event) => event?.payload?.call_id === 'initial-exec' && event.payload.type === 'custom_tool_call_output').payload.output = installedHostOutput({ output: 'needs choice\n', exit_code: 3 });
      input.rollouts[0] = input.rollouts[0].filter((event) => !['initial-poll', 'initial-terminal'].includes(event?.payload?.call_id));
    }],
    ['initial handle drift', (input) => { input.rollouts[0].find((event) => event?.payload?.call_id === 'initial-terminal').payload.input = installedPollInput(999); }],
    ['continuation missing terminal exit', (input) => { input.rollouts[0].find((event) => event?.payload?.call_id === 'continuation-terminal' && event.payload.type === 'custom_tool_call_output').payload.output = installedHostOutput({ output: '', session_id: 61 }); }],
    ['status command substitution', (input) => { input.rollouts[0].find((event) => event?.payload?.call_id === 'initial-status').payload.input = installedExecInput('node "/installed/zcode/scripts/zcode-companion.mjs" invoke-status review'); }],
    ['status arguments', (input) => { input.rollouts[0].find((event) => event?.payload?.call_id === 'initial-status').payload.input = installedExecInput(`${input.commands.status} --detail`); }],
  ]) {
    const input = installedChoiceYieldFixture(); mutate(input);
    assert.throws(() => installedChoiceYieldFacts(input.rollouts, input.childThreadId, input.commands), /yielded same-handle terminal evidence/u, label);
  }
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
  function assertInstalledRescueChoiceLinkage(rollouts, parentThreadId, evidence, pendingIdentity, commands) {
    const yielded = installedChoiceYieldFacts(rollouts, evidence.childThreadId, commands);
    assert.equal(evidence.executions.initial.execCommandCount, 1);
    assert.equal(evidence.executions.continuation.execCommandCount, 1);
    assert.deepEqual(yielded, {
      initial: { execCommandCount: 1, pollCount: yielded.initial.pollCount, sameHandleChecked: true, terminalExitCode: 3 },
      continuation: { execCommandCount: 1, pollCount: yielded.continuation.pollCount, sameHandleChecked: true, terminalExitCode: 0 },
    });
    assert.ok(yielded.initial.pollCount >= 1, 'choice initial turn must survive an initial yield and poll its original handle');
    assert.ok(yielded.continuation.pollCount >= 1, 'choice continuation must survive an initial yield and poll its original handle');
    assertInstalledRescueChoiceIdentityLinkage(rollouts, parentThreadId, evidence, pendingIdentity);
  }

  async function runHeldChoiceSegment(label, command, launch) {
    const gatePath = join(temporary, `${label}.completion.gate`);
    const gateReachedPath = join(temporary, `${label}.completion.reached`);
    const processPath = join(temporary, `${label}.process.json`);
    const processNonce = randomBytes(32).toString('hex');
    const observedBefore = installedYieldedCommandPairs(await loadCodexRollouts(codexHome).catch(() => []), command);
    await Promise.all([writeFile(gatePath, 'hold'), writeFile(gateReachedPath, ''), writeFile(processPath, '')]);
    const held = await runHeldForegroundRescue({
      gatePath, processPath, processNonce,
      launch: () => launch({ ...env, FAKE_ZCODE_COMPLETION_GATE: gatePath, FAKE_ZCODE_COMPLETION_GATE_REACHED: gateReachedPath, FAKE_ZCODE_PROCESS_FILE: processPath, FAKE_ZCODE_PROCESS_NONCE: processNonce }),
      waitForGate: (signal) => waitUntil(async () => await readFile(gateReachedPath, 'utf8').catch(() => '') === 'blocked', 60_000, `${label} never reached the held fake-ZCode completion boundary`, signal),
      waitForObservation: (signal) => waitUntil(async () => {
        const observed = installedYieldedCommandPairs(await loadCodexRollouts(codexHome).catch(() => []), command);
        return [...observed].some((pair) => !observedBefore.has(pair));
      }, 60_000, `${label} never polled its original yielded handle`, signal),
      holdMs: 0,
    });
    return held;
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
    waitForObservation: (signal) => waitUntil(async () => installedRelayObserved(await loadCodexRollouts(codexHome).catch(() => [])), 60_000, 'installed foreground Rescue never emitted a strict fixed relay before completion', signal),
    holdMs: 0,
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
  const expectedCommand = `node "${installedPluginRoot}/scripts/zcode-companion.mjs" invoke-prepared rescue`;
  const expectedPreflightCommand = `node "${installedPluginRoot}/scripts/zcode-companion.mjs" role-status rescue`;
  const expectedPreparationCommand = `node "${installedPluginRoot}/scripts/zcode-companion.mjs" prepare rescue`;
  const expectedPreparationPayload = JSON.stringify({ version: 1, source: 'explicit', task: 'repaircanary', options: { execution: 'foreground', resume: 'fresh' } });
  const expectedStatusCommand = `node "${installedPluginRoot}/scripts/zcode-companion.mjs" invoke-status rescue`;
  const expectedNamedSpawnMessage = expectedNamedRescueMessage;
  const expectedGenericSpawnMessage = expectedGenericRescueMessage.replaceAll('<canonical-plugin-root>', installedPluginRoot);
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
        expectedPreparationCommand,
        expectedPreparationPayload,
        expectedNamedSpawnMessage,
        expectedGenericSpawnMessage,
        expectedPublicOutput: 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C',
        requireYieldedExecution: true,
        requireProgressRelay: true,
        expectedStatusCommand,
        statusPrivacyCanaries: RESCUE_DISPLAY_PRIVATE_SENTINELS,
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
    assert.equal(evidence.progressRelayChecked, true);
    assert.equal(evidence.yieldedExecution.execCommandCount, 1);
    assert.ok(evidence.yieldedExecution.pollCount >= 1);
    assert.equal(evidence.yieldedExecution.sameHandleChecked, true);
    assert.equal(evidence.yieldedExecution.terminalExitCode, 0);
    t.diagnostic(`qualified native Rescue route: ${evidence.route}`);
  } catch (error) {
    if (error instanceof CodexRescueUnqualifiedError && error.code === 'spawn-message-encrypted') {
      assertInstalledRescueDisplay(error.evidence);
      assert.ok(['named', 'generic-schema-hidden'].includes(error.evidence?.route), 'encrypted-message evidence must record the automatically observed native route');
      assert.equal(error.evidence.progressRelayChecked, true);
      assert.equal(error.evidence.yieldedExecution.execCommandCount, 1);
      assert.ok(error.evidence.yieldedExecution.pollCount >= 1);
      assert.equal(error.evidence.yieldedExecution.sameHandleChecked, true);
      assert.equal(error.evidence.yieldedExecution.terminalExitCode, 0);
      const detail = `Observed route ${error.evidence.route}. ${error.message}`;
      markUnqualified(t, unqualified(error.code, detail)); return;
    }
    throw error;
  }

  const initialParentIds = [...new Set(frames.filter((frame) => frame?.type === 'thread.started').map((frame) => frame.thread_id))];
  assert.equal(initialParentIds.length, 1, 'initial installed Rescue must expose one resumable parent thread');
  const originalSessionId = zcodeCalls.find((call) => call.method === 'session/create')?.result?.session?.sessionId;
  assert.ok(originalSessionId, 'initial installed Rescue must capture its exact fake-peer session');
  await writeFile(zcodeRecord, '');
  const proactive = await runHeldChoiceSegment('proactive-bound-continuation', expectedCommand,
    (segmentEnv) => controlledCodex([
      'exec', 'resume', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
      '--dangerously-bypass-hook-trust', '--enable', 'hooks', '-c', 'shell_environment_policy.inherit=all',
      initialParentIds[0], 'Continue the exact same stopped Rescue child and its existing ZCode operation proactively. This is a clear continuation, not fresh work.',
    ], workspace, segmentEnv, 240_000));
  if (skipExternalFailure(t, proactive.rescue)) return;
  assert.equal(proactive.rescue.code, 0, `proactive bound continuation failed\n${proactive.rescue.stdout}\n${proactive.rescue.stderr}`);
  assert.equal(proactive.endedBeforeGate, false, 'proactive continuation must poll its exact yielded invoke-prepared process');
  const proactiveRollouts = await loadCodexRollouts(codexHome);
  const proactiveParent = proactiveRollouts.find((events) => events.some((event) => event?.type === 'session_meta' && event.payload?.id === initialParentIds[0]));
  assert.ok(proactiveParent, 'proactive continuation parent rollout is missing');
  assert.equal(proactiveParent.filter((event) => event?.payload?.name === 'spawn_agent').length, 1, 'proactive continuation must retain only the original spawn');
  assert.equal(proactiveParent.filter((event) => event?.payload?.type === 'sub_agent_activity' && event.payload.kind === 'started').length, 1, 'proactive continuation must expose no second SubagentStart');
  assert.equal(proactiveParent.filter((event) => event?.payload?.name === 'followup_task').length, 1, 'proactive continuation must follow up the exact stopped child once');
  const proactivePeer = (await readFile(zcodeRecord, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const resumed = proactivePeer.filter((call) => call.method === 'session/resume');
  assert.equal(resumed.length, 1, 'proactive continuation must resume exactly one fake-peer session');
  assert.equal(resumed[0].params?.sessionId, originalSessionId, 'proactive continuation must resume the original exact fake-peer session');
  assert.equal(proactivePeer.filter((call) => call.method === 'session/send').length, 1, 'proactive continuation must send exactly one new ZCode turn');
  if (process.env.ZCODE_CONTINUATION_RAW_ARTIFACTS !== '1') {
    markUnqualified(t, unqualified('continuation-artifacts-not-captured',
      'The credentialed harness captured the real peer and Codex rollouts, but not every raw hook/preparation/state/public artifact required by the continuation oracle.'));
    return;
  }

  for (const choice of ['resume', 'fresh']) {
    await writeFile(zcodeRecord, '');
    const pendingSegment = await runHeldChoiceSegment(`${choice}-initial`, expectedCommand,
      (segmentEnv) => controlledCodex([...commonArgs, 'Use the installed $zcode:rescue --wait continue repairing the fixture skill exactly once now. If its child returns needs-choice, follow the installed skill, ask once, and stop without choosing.'], workspace, segmentEnv, 240_000));
    const pending = pendingSegment.rescue;
    if (skipExternalFailure(t, pending)) return;
    assert.equal(pendingSegment.endedBeforeGate, false, `choice ${choice} initial segment ended before its held completion boundary`);
    assert.equal(pendingSegment.processAliveWhileHeld, true, `choice ${choice} initial exact process must remain alive through the observed same-handle poll`);
    assert.equal(pending.code, 0, `codex pending Rescue failed\n${pending.stdout}\n${pending.stderr}`);
    const pendingFrames = pending.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const parentIds = [...new Set(pendingFrames.filter((frame) => frame?.type === 'thread.started').map((frame) => frame.thread_id))];
    assert.equal(parentIds.length, 1, 'pending Rescue must expose exactly one resumable parent thread ID');
    const pendingRollouts = await loadCodexRollouts(codexHome);
    const pendingIdentity = captureInstalledRescueChoiceIdentity(pendingRollouts, parentIds[0]);
    const choiceCommand = `node "${installedPluginRoot}/scripts/zcode-companion.mjs" invoke-choice rescue ${choice}`;
    const answerSegment = await runHeldChoiceSegment(`${choice}-continuation`, choiceCommand,
      (segmentEnv) => controlledCodex([
        'exec', 'resume', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
        '--dangerously-bypass-hook-trust', '--enable', 'hooks', '-c', 'shell_environment_policy.inherit=all',
        parentIds[0], choice,
      ], workspace, segmentEnv, 240_000));
    const answer = answerSegment.rescue;
    if (skipExternalFailure(t, answer)) return;
    assert.equal(answerSegment.endedBeforeGate, false, `choice ${choice} continuation ended before its held completion boundary`);
    assert.equal(answerSegment.processAliveWhileHeld, true, `choice ${choice} continuation exact process must remain alive through the observed same-handle poll`);
    assert.equal(answer.code, 0, `codex ${choice} continuation failed\n${answer.stdout}\n${answer.stderr}`);
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
          expectedPreparationCommand,
          expectedPreparationPayload,
          expectedPublicOutput: 'ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C',
          includeExecutionFacts: true,
          requireProgressRelay: true,
          expectedStatusCommand,
          statusPrivacyCanaries: RESCUE_DISPLAY_PRIVATE_SENTINELS,
          forbiddenParentText: [
            'Running command: npm test.', 'Command completed: npm test (25ms).', 'raw output must stay private',
            'ZCode conversation frames were unavailable; using bounded session progress.',
            'ZCode semantic progress is unavailable; lifecycle updates will continue.',
            'reasoning must stay private', 'capability must stay private', 'v4/conversation/frame',
          ],
        },
      );
      assertInstalledRescueDisplay(evidence);
      assertInstalledRescueChoiceLinkage(choiceRollouts, parentIds[0], evidence, pendingIdentity, { initial: expectedCommand, continuation: choiceCommand, status: expectedStatusCommand });
      assert.equal(evidence.choice, choice);
      assert.equal(evidence.progressRelayChecked, true);
      t.diagnostic(`qualified same-child Rescue ${choice}: ${evidence.childThreadId}`);
    } catch (error) {
      if (error instanceof CodexRescueUnqualifiedError && ['choice-followup-encrypted', 'choice-spawn-encrypted'].includes(error.code)) {
        assertInstalledRescueDisplay(error.evidence);
        assert.equal(error.evidence.progressRelayChecked, true);
        assertInstalledRescueChoiceLinkage(choiceRollouts, parentIds[0], error.evidence, pendingIdentity, { initial: expectedCommand, continuation: choiceCommand, status: expectedStatusCommand });
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
      if (input.waitForObservation) await input.waitForObservation(gateController.signal);
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

async function recursiveFiles(directory, found = []) {
  let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await recursiveFiles(path, found);
    else if (entry.isFile()) found.push(path);
  }
  return found;
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

function installedRelayObserved(rollouts) {
  const observedMessages = new Set();
  const sentMessages = new Set();
  for (const events of rollouts) {
    for (const event of events) {
      if (event?.payload?.type === 'custom_tool_call_output' && typeof event.payload.output === 'string') {
        let result;
        try { result = JSON.parse(event.payload.output); } catch { continue; }
        if (typeof result?.output !== 'string') continue;
        for (const line of result.output.match(/[^\n]*\n/gu) ?? []) {
          if (!line.startsWith(RESCUE_RELAY_PREFIX)) continue;
          try { observedMessages.add(RESCUE_RELAY_MESSAGES[parseRescueProgressRelay(line).code]); } catch { /* final qualification reports malformed evidence */ }
        }
      } else if (event?.payload?.type === 'function_call' && event.payload.name === 'send_message') {
        let args;
        try { args = JSON.parse(event.payload.arguments); } catch { continue; }
        if (args?.target === '/root' && typeof args.message === 'string') sentMessages.add(args.message);
      }
    }
  }
  return [...observedMessages].some((message) => sentMessages.has(message));
}

function installedYieldedCommandPairs(rollouts, command) {
  const pairs = new Set();
  for (const events of rollouts) {
    const threadId = events?.[0]?.payload?.id;
    if (typeof threadId !== 'string') continue;
    const outputs = new Map(events.filter((event) => event?.payload?.type === 'custom_tool_call_output')
      .map((event) => [event.payload.call_id, event.payload.output]));
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event?.payload?.type !== 'custom_tool_call') continue;
      try {
        const call = parseInstalledToolInput(event.payload.input);
        if (call.kind !== 'exec_command' || call.value.cmd !== command) continue;
        const result = parseInstalledHostOutput(outputs.get(event.payload.call_id));
        if (!Number.isSafeInteger(result.session_id) || result.session_id <= 0) continue;
        for (const later of events.slice(index + 1)) {
          if (later?.payload?.type !== 'custom_tool_call') continue;
          const poll = parseInstalledToolInput(later.payload.input);
          if (poll.kind === 'write_stdin' && poll.value.session_id === result.session_id && poll.value.chars === '') {
            pairs.add(`${threadId}:${event.payload.call_id}:${later.payload.call_id}`);
          }
        }
      } catch { /* ignore unrelated or partially persisted calls */ }
    }
  }
  return pairs;
}

function installedChoiceYieldFixture() {
  const childThreadId = 'installed-choice-child';
  const commands = { initial: 'node "/installed/zcode/scripts/zcode-companion.mjs" invoke-prepared rescue', continuation: 'node "/installed/zcode/scripts/zcode-companion.mjs" invoke-choice rescue resume', status: 'node "/installed/zcode/scripts/zcode-companion.mjs" invoke-status rescue' };
  const segment = (name, command, handle, exitCode) => [
    installedToolCall(`${name}-exec`, installedExecInput(command)), installedToolOutput(`${name}-exec`, { output: 'partial\n', session_id: handle }),
    ...(name === 'initial' ? [installedToolCall('initial-status', installedExecInput(commands.status)), installedToolOutput('initial-status', { output: '{"type":"rescue-status"}\n', exit_code: 0 })] : []),
    installedToolCall(`${name}-poll`, installedPollInput(handle)), installedToolOutput(`${name}-poll`, { output: 'heartbeat\n', session_id: handle }),
    installedToolCall(`${name}-terminal`, installedPollInput(handle)), installedToolOutput(`${name}-terminal`, { output: 'terminal\n', exit_code: exitCode }),
    { type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: 'terminal' } },
  ];
  return { childThreadId, commands, rollouts: [[
    { type: 'session_meta', payload: { id: childThreadId } },
    ...segment('initial', commands.initial, 51, 3),
    ...segment('continuation', commands.continuation, 61, 0),
  ]] };
}

function installedPreparedContinuationCapture(route, overrides = {}) {
  const childThreadId = '019fe6e0-4764-7192-83ba-0b0cc2c48660';
  const parentSessionId = '019fe6df-faa2-7851-8edb-55f1be7d5489';
  const message = route === 'named' ? expectedNamedRescueMessage : expectedGenericRescueMessage;
  const workspace = overrides.workspace ?? '/repo'; const anchorJobId = 'a'.repeat(64); const currentJobId = 'c'.repeat(64);
  const binding = createRescueBinding({ parentSessionId, executorAgentId: childThreadId, executorAgentType: route === 'named' ? 'zcode-rescue' : 'default',
    executorParentTurnId: 'turn-original', executorParentPermissionMode: 'acceptEdits', workspace, permissionMode: 'acceptEdits',
    anchorJobId, currentJobId, operationId: 'd'.repeat(64), now: '2026-08-10T00:00:00.000Z' });
  const parent = [
    { type: 'session_meta', payload: { id: parentSessionId, session_id: parentSessionId, thread_source: 'user', source: 'exec' } },
    { ...installedToolCall('prepare-1', installedExecInput('node "/installed/zcode/scripts/zcode-companion.mjs" prepare rescue', { tty: true, workdir: workspace, env: { PATH: '/usr/bin' } })), timestamp: '2026-08-10T00:00:00.250Z' },
    { ...installedToolOutput('prepare-1', { output: `${JSON.stringify({ type: 'preparation-input-ready', command: 'rescue' })}\n`, session_id: 71 }), timestamp: '2026-08-10T00:00:00.400Z' },
    { ...installedToolCall('prepare-write-1', installedPreparationInput(71, `${JSON.stringify(installedContinuationEnvelope('explicit', 'fresh'))}\n`)), timestamp: '2026-08-10T00:00:00.500Z' },
    { ...installedToolOutput('prepare-write-1', { output: `${JSON.stringify({ type: 'prepared', command: 'rescue' })}\n`, exit_code: 0 }), timestamp: '2026-08-10T00:00:00.750Z' },
    { type: 'response_item', timestamp: '2026-08-10T00:00:01.000Z', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'spawn-1', arguments: JSON.stringify({ task_name: 'zcode_rescue_continue', message, fork_turns: 'none', ...(route === 'named' ? { agent_type: 'zcode-rescue' } : {}) }) } },
    { type: 'event_msg', timestamp: '2026-08-10T00:00:02.000Z', payload: { type: 'sub_agent_activity', kind: 'started', event_id: 'spawn-1', agent_thread_id: childThreadId, agent_path: '/root/zcode_rescue_continue', parent_turn_id: 'turn-original' } },
    { type: 'response_item', timestamp: '2026-08-10T00:00:02.250Z', payload: { type: 'function_call_output', call_id: 'spawn-1', output: JSON.stringify({ agent_id: childThreadId }) } },
    { type: 'event_msg', timestamp: '2026-08-10T00:00:05.000Z', payload: { type: 'sub_agent_activity', kind: 'stopped', agent_thread_id: childThreadId, agent_path: '/root/zcode_rescue_continue', parent_turn_id: 'turn-original' } },
    { ...installedToolCall('prepare-2', installedExecInput('node "/installed/zcode/scripts/zcode-companion.mjs" prepare rescue', { tty: true, workdir: workspace })), timestamp: '2026-08-10T00:00:06.000Z' },
    { ...installedToolOutput('prepare-2', { output: `${JSON.stringify({ type: 'preparation-input-ready', command: 'rescue' })}\n`, session_id: 72 }), timestamp: '2026-08-10T00:00:06.250Z' },
    { ...installedToolCall('prepare-write-2', installedPreparationInput(72, `${JSON.stringify(installedContinuationEnvelope('proactive', 'resume'))}\n`)), timestamp: '2026-08-10T00:00:06.500Z' },
    { ...installedToolOutput('prepare-write-2', { output: `${JSON.stringify({ type: 'prepared', command: 'rescue' })}\n`, exit_code: 0 }), timestamp: '2026-08-10T00:00:07.000Z' },
    { type: 'response_item', timestamp: '2026-08-10T00:00:08.000Z', payload: { type: 'function_call', name: 'followup_task', call_id: 'followup-1', arguments: JSON.stringify({ target: childThreadId, message }) } },
    { type: 'response_item', timestamp: '2026-08-10T00:00:09.000Z', payload: { type: 'function_call_output', call_id: 'followup-1', output: JSON.stringify({ accepted: true, target: childThreadId }) } },
  ];
  for (const event of parent.slice(1)) event.turn_id = Date.parse(event.timestamp) < Date.parse('2026-08-10T00:00:06.000Z') ? 'turn-original' : 'turn-fresh';
  const command = 'node "/installed/zcode/scripts/zcode-companion.mjs" invoke-prepared rescue';
  const child = [
    { type: 'session_meta', payload: { id: childThreadId, session_id: parentSessionId, parent_thread_id: parentSessionId, thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: parentSessionId, agent_path: '/root/zcode_rescue_continue', agent_role: route === 'named' ? 'zcode-rescue' : null } } } } },
    installedToolCall('invoke-1', installedExecInput(command)), installedToolOutput('invoke-1', { output: 'initial done\n', exit_code: 0 }),
    { type: 'event_msg', payload: { type: 'agent_message', message: 'initial done' } },
    installedToolCall('invoke-2', installedExecInput(command)), installedToolOutput('invoke-2', { output: 'continued\n', exit_code: 0 }),
    { type: 'event_msg', payload: { type: 'agent_message', message: 'continued' } },
  ];
  child[1].timestamp = '2026-08-10T00:00:03.000Z'; child[2].timestamp = '2026-08-10T00:00:04.000Z'; child[4].timestamp = '2026-08-10T00:00:10.000Z'; child[5].timestamp = '2026-08-10T00:00:11.000Z';
  child[1].turn_id = child[2].turn_id = 'invoke-original'; child[4].turn_id = child[5].turn_id = 'invoke-continuation';
  return {
    route, execution: 'foreground', expected: { parentSessionId, childThreadId, agentPath: '/root/zcode_rescue_continue', workspace,
      permissionMode: 'acceptEdits', originalParentTurnId: 'turn-original', continuationParentTurnId: 'turn-fresh' },
    parentRolloutJson: JSON.stringify(parent), childRolloutJson: JSON.stringify(child),
    hookLifecycleJson: overrides.hookLifecycleJson ?? JSON.stringify([
      { hook_event_name: 'SubagentStart', session_id: parentSessionId, turn_id: 'child-turn', parent_turn_id: 'turn-original', cwd: workspace, permission_mode: 'acceptEdits', agent_id: childThreadId, agent_type: route === 'named' ? 'zcode-rescue' : 'default' },
      { hook_event_name: 'SubagentStop', session_id: parentSessionId, turn_id: 'child-turn', parent_turn_id: 'turn-original', cwd: workspace, permission_mode: 'acceptEdits', agent_id: childThreadId, agent_type: route === 'named' ? 'zcode-rescue' : 'default' },
      { hook_event_name: 'UserPromptSubmit', session_id: parentSessionId, turn_id: 'turn-fresh', cwd: workspace, permission_mode: 'acceptEdits' },
    ]),
    executorRecordBytes: overrides.executorRecordBytes ?? `${JSON.stringify({ kind: 'subagent-executor', agentId: childThreadId, agentType: route === 'named' ? 'zcode-rescue' : 'default', parentSessionId, parentTurnId: 'turn-original', parentPermissionMode: 'acceptEdits', childTurnId: 'child-turn', workspace, active: false, createdAt: '2026-08-08T00:00:00.000Z' })}\n`,
    bindingAuthorityBytes: `${JSON.stringify(createRescueBindingAuthority({ parentSessionId, workspace, createdAt: '2026-08-10T00:00:00.000Z' }))}\n`,
    bindingPartitionBytes: `${JSON.stringify(createRescueBindingPartition({ parentSessionId, workspace, records: [binding] }))}\n`,
    preparationRecordBytesJson: JSON.stringify([
      `${JSON.stringify(installedContinuationPreparationRecord(parentSessionId, workspace, childThreadId, 'turn-original', 'explicit', 'fresh', '1'.repeat(64)))}\n`,
      `${JSON.stringify(installedContinuationPreparationRecord(parentSessionId, workspace, childThreadId, 'turn-fresh', 'proactive', 'resume', '2'.repeat(64)))}\n`,
    ]),
    jobRecordBytesJson: JSON.stringify([
      `${JSON.stringify(installedRawJob(anchorJobId, parentSessionId, workspace, 'turn-original', 'succeeded', { zcodeSessionId: 'zcode-session-original' }))}\n`,
      `${JSON.stringify(installedRawJob(currentJobId, parentSessionId, workspace, 'turn-fresh', 'succeeded'))}\n`,
    ]),
    fakePeerJson: JSON.stringify([{ id: 1, method: 'session/create', params: { workspace: { workspacePath: workspace } } }, { id: 2, method: 'session/send', params: { sessionId: 'zcode-session-original' } }, { id: 3, method: 'session/resume', params: { sessionId: 'zcode-session-original' } }, { id: 4, method: 'session/send', params: { sessionId: 'zcode-session-original' } }]),
  };
}

function installedRawJob(id, ownerSessionId, workspace, ownerTurnId, status, extra = {}) {
  return { id, workspace, ownerSessionId, ownerTurnId, command: 'rescue', readOnly: false,
    permissionSnapshot: { permissionMode: 'acceptEdits' }, status, createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:01:00.000Z', ...extra };
}
function installedContinuationEnvelope(source, resume) { return { version: 1, source, task: source === 'explicit' ? 'repair fixture' : 'continue fixture', options: { execution: 'foreground', resume } }; }
function installedContinuationPreparationRecord(sessionId, workspace, executorAgentId, turnId, source, resume, key) {
  key = createHash('sha256').update(JSON.stringify([sessionId, turnId, workspace, 'rescue'])).digest('hex');
  return { version: 1, key, sessionId, turnId, workspace, permissionMode: 'acceptEdits', source, envelope: installedContinuationEnvelope(source, resume),
    createdAt: '2026-08-10T00:00:00.000Z', expiresAt: '2026-08-10T00:30:00.000Z', consumedAt: '2026-08-10T00:00:01.000Z', executorAgentId };
}

async function installedCapturedRescueRoutes(config = {}) {
  const installedRoot = '/captured/installed/zcode';
  const installedSnapshot = join(root, 'marketplace', 'plugins', 'zcode');
  const namedTemplate = extractInstalledRoleInstructions(await readFile(join(installedSnapshot, 'agents', 'zcode-rescue.toml.template'), 'utf8'));
  const genericTemplate = assertRescueRouteContract(await readFile(join(installedSnapshot, 'skills', 'rescue', 'SKILL.md'), 'utf8')).genericMessage.text;
  assertInstalledForwarderLifecycleContract(namedTemplate, 'named', { expectedRoot: '{{PLUGIN_ROOT}}' });
  assertInstalledForwarderLifecycleContract(genericTemplate, 'generic', { expectedRoot: '<canonical-plugin-root>' });
  const namedPolicy = namedTemplate.replaceAll('{{PLUGIN_ROOT}}', installedRoot);
  const genericPolicy = genericTemplate.replaceAll('<canonical-plugin-root>', installedRoot);
  assertInstalledForwarderLifecycleContract(namedPolicy, 'named', { expectedRoot: installedRoot });
  // The generic template itself is the spawn assignment; rendering is verified by
  // the fixed command evidence and exact expected spawn message below.
  return [
    installedCapturedRescueRoute('named', namedPolicy, expectedNamedRescueMessage, installedRoot, config),
    installedCapturedRescueRoute('generic', genericPolicy, genericPolicy, installedRoot, config),
  ];
}

function installedCapturedRescueRoute(name, renderedPolicy, spawnMessage, installedRoot, config = {}) {
  const parentThreadId = name === 'named' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222';
  const childThreadId = name === 'named' ? '33333333-3333-4333-8333-333333333333' : '44444444-4444-4444-8444-444444444444';
  const taskName = `zcode_rescue_captured_${name}`; const agentPath = `/root/${taskName}`;
  const command = `node "${installedRoot}/scripts/zcode-companion.mjs" invoke-prepared rescue`;
  const preflightCommand = `node "${installedRoot}/scripts/zcode-companion.mjs" role-status rescue`;
  const preparationCommand = `node "${installedRoot}/scripts/zcode-companion.mjs" prepare rescue`;
  const preparationPayload = JSON.stringify({ version: 1, source: config.source ?? 'explicit', task: config.task ?? `repair captured ${name} route`, options: config.options ?? { execution: 'foreground', resume: 'fresh' } });
  const statusCommand = `node "${installedRoot}/scripts/zcode-companion.mjs" invoke-status rescue`;
  for (const expected of [command, statusCommand,
    `node "${installedRoot}/scripts/zcode-companion.mjs" invoke-choice rescue resume`,
    `node "${installedRoot}/scripts/zcode-companion.mjs" invoke-choice rescue fresh`]) {
    assert.ok(renderedPolicy.includes(expected), `${name} rendered installed policy must own ${expected}`);
  }
  const publicOutput = `captured-${name}-done`; const handle = name === 'named' ? 71 : 81;
  const semantic = {
    start: '[zcode] Running command: npm test.',
    terminal: '[zcode] Command completed: npm test (25ms).',
    snapshotFallback: '[zcode] ZCode conversation frames were unavailable; using bounded session progress.',
    lifecycleOnly: '[zcode] ZCode semantic progress is unavailable; lifecycle updates will continue.',
  };
  const spawnArgs = { fork_turns: 'none', message: spawnMessage, task_name: taskName };
  if (name === 'named') spawnArgs.agent_type = 'zcode-rescue';
  const childEnvelope = `Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${agentPath}\nPayload:\n${publicOutput}`;
  const child = [
    { type: 'session_meta', payload: { session_id: parentThreadId, id: childThreadId, parent_thread_id: parentThreadId, cli_version: '0.147.0', thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: parentThreadId, depth: 1, agent_path: agentPath, agent_nickname: 'Ada', agent_role: name === 'named' ? 'zcode-rescue' : null } } } } },
    installedToolCall(`${name}-exec`, installedExecInput(command)),
    installedToolOutput(`${name}-exec`, { output: `${semantic.start}\n${installedCapturedRelayLine(1, 'starting', 'started')}\n`, session_id: handle }),
    installedCapturedRelayCall(`${name}-relay-1`, 'started'), installedCapturedFunctionOutput(`${name}-relay-1`),
    installedToolCall(`${name}-poll-1`, installedPollInput(handle)),
    installedToolOutput(`${name}-poll-1`, { output: `${installedCapturedRelayLine(2, 'investigating', 'tool-active')}\n`, session_id: handle }),
    installedCapturedRelayCall(`${name}-relay-2`, 'tool-active'), installedCapturedFunctionOutput(`${name}-relay-2`),
    installedToolCall(`${name}-status`, installedExecInput(statusCommand)),
    installedToolOutput(`${name}-status`, { output: `${JSON.stringify({ type: 'rescue-status', status: 'running', phase: 'running', lastActivityAt: '2026-08-17T00:00:02.000Z', progressPreview: ['ZCode is working.'], terminal: false })}\n`, exit_code: 0 }),
    installedToolCall(`${name}-poll-2`, installedPollInput(handle)),
    installedToolOutput(`${name}-poll-2`, { output: `${semantic.terminal}\n${publicOutput}\n`, exit_code: 0 }),
    { type: 'event_msg', payload: { type: 'agent_message', message: publicOutput, phase: 'final_answer' } },
  ];
  const parent = [
    { type: 'session_meta', payload: { session_id: parentThreadId, id: parentThreadId, cli_version: '0.147.0', thread_source: 'user', source: 'exec' } },
    installedToolCall(`${name}-preflight`, installedExecInput(preflightCommand)),
    installedToolOutput(`${name}-preflight`, { output: `${JSON.stringify({ type: 'role-status', role: 'zcode-rescue', status: 'ready' })}\n`, exit_code: 0 }),
    installedToolCall(`${name}-prepare`, installedExecInput(preparationCommand, { tty: true })),
    installedToolOutput(`${name}-prepare`, { output: `${JSON.stringify({ type: 'preparation-input-ready', command: 'rescue' })}\n`, session_id: name === 'named' ? 171 : 181 }),
    installedToolCall(`${name}-prepare-write`, installedPreparationInput(name === 'named' ? 171 : 181, `${preparationPayload}\n`)),
    installedToolOutput(`${name}-prepare-write`, { output: `${JSON.stringify({ type: 'prepared', command: 'rescue' })}\n`, exit_code: 0 }),
    { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: `${name}-spawn`, arguments: JSON.stringify(spawnArgs) } },
    { type: 'event_msg', payload: { type: 'sub_agent_activity', event_id: `${name}-spawn`, agent_thread_id: childThreadId, agent_path: agentPath, kind: 'started' } },
    installedCapturedParentRelay(agentPath, 'started', name === 'named' ? 'a' : 'c', name === 'named' ? 'a' : 'c'),
    ...installedCapturedWait(`${name}-wait-1`, true),
    installedCapturedParentRelay(agentPath, 'tool-active', name === 'named' ? 'b' : 'd', name === 'named' ? 'a' : 'c'),
    ...installedCapturedWait(`${name}-wait-2`, false),
    { type: 'response_item', payload: { type: 'agent_message', author: agentPath, recipient: '/root', content: [{ type: 'input_text', text: childEnvelope }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: publicOutput, phase: 'final_answer' } },
  ];
  let offset = 1; const stamp = (event) => { event.timestamp = `2026-08-17T00:00:${String(offset++).padStart(2, '0')}.000Z`; };
  for (const event of child.slice(1, 5)) stamp(event);
  for (const event of parent.slice(5, 8)) stamp(event);
  for (const event of child.slice(5, 9)) stamp(event);
  for (const event of parent.slice(8, 11)) stamp(event);
  for (const event of child.slice(9)) stamp(event);
  for (const event of parent.slice(11)) stamp(event);
  const fixture = { execFrames: [
    { type: 'thread.started', thread_id: parentThreadId }, { type: 'turn.started' },
    { type: 'item.completed', item: { id: `${name}-final`, type: 'agent_message', text: publicOutput } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5 } },
  ], rollouts: [parent, child] };
  return { name, fixture, expectedEvidenceRoute: name === 'named' ? 'named' : 'generic-schema-hidden', installedRoot, renderedPolicy, command, preflightCommand, preparationCommand, preparationPayload, statusCommand, spawnMessage, publicOutput, semantic };
}

function qualifyInstalledCapturedForeground(route) {
  return qualifyCodexRescueEvidence(route.fixture, {
    expectedAgentType: 'zcode-rescue', expectedWorkspace: '/installed/workspace', expectedCommand: route.command,
    expectedPreflightCommand: route.preflightCommand, expectedNamedSpawnMessage: expectedNamedRescueMessage,
    expectedPreparationCommand: route.preparationCommand, expectedPreparationPayload: route.preparationPayload,
    expectedGenericSpawnMessage: route.name === 'generic' ? route.spawnMessage : expectedGenericRescueMessage.replaceAll('<canonical-plugin-root>', route.installedRoot),
    expectedPublicOutput: route.publicOutput, expectedSemanticProgress: route.semantic,
    requireYieldedExecution: true, requireProgressRelay: true, requireStatusSidecar: true, expectedStatusCommand: route.statusCommand,
    statusPrivacyCanaries: ['PRIVATE', 'raw output must stay private', 'reasoning must stay private'],
    forbiddenParentText: [route.semantic.start, route.semantic.terminal, 'raw output must stay private', 'reasoning must stay private'],
  });
}

function installedCapturedBackgroundRoute(route) {
  const jobId = (route.name === 'named' ? 'a' : 'b').repeat(64);
  const publicOutput = `Reserved background job ${jobId}.`;
  const fixture = JSON.parse(JSON.stringify(route.fixture).replaceAll(route.publicOutput, publicOutput));
  const child = fixture.rollouts[1];
  const commandCall = child.find((event) => event?.payload?.type === 'custom_tool_call'
    && event.payload.call_id === `${route.name}-exec`);
  commandCall.payload.input = `const r = await tools.exec_command({cmd:${JSON.stringify(route.command)},workdir:"/installed/workspace"});\ntext(r.output);\n`;
  const commandOutput = child.find((event) => event?.payload?.type === 'custom_tool_call_output'
    && event.payload.call_id === `${route.name}-exec`);
  commandOutput.payload.output = [{ type: 'input_text', text: `${publicOutput}\n` }];
  fixture.rollouts[1] = [child[0], commandCall, commandOutput, child.at(-1)];
  return {
    ...route,
    fixture,
    jobId,
    privateExecutionCapability: `private-background-capability-${route.name}`,
    publicOutput,
  };
}

function qualifyInstalledCapturedBackground(route) {
  return qualifyCodexRescueBackgroundEvidence(route.fixture, {
    expectedJobId: route.jobId,
    privateExecutionCapability: route.privateExecutionCapability,
    publicLogs: ['captured public background log'],
    expectedAgentType: 'zcode-rescue', expectedWorkspace: '/installed/workspace', expectedCommand: route.command,
    expectedPreflightCommand: route.preflightCommand, expectedNamedSpawnMessage: expectedNamedRescueMessage,
    expectedPreparationCommand: route.preparationCommand, expectedPreparationPayload: route.preparationPayload,
    expectedGenericSpawnMessage: route.name === 'generic' ? route.spawnMessage : expectedGenericRescueMessage.replaceAll('<canonical-plugin-root>', route.installedRoot),
    expectedSemanticProgress: undefined,
    statusPrivacyCanaries: ['PRIVATE', 'raw output must stay private', 'reasoning must stay private'],
    forbiddenParentText: ['raw output must stay private', 'reasoning must stay private'],
  });
}

function installedCapturedChoiceRoute(route, choice) {
  const parentThreadId = route.fixture.rollouts[0][0].payload.id;
  const childThreadId = route.fixture.rollouts[1][0].payload.id;
  const childMeta = structuredClone(route.fixture.rollouts[1][0]);
  const spawn = structuredClone(route.fixture.rollouts[0].find((event) => event?.payload?.name === 'spawn_agent'));
  const start = structuredClone(route.fixture.rollouts[0].find((event) => event?.payload?.type === 'sub_agent_activity'));
  const agentPath = start.payload.agent_path;
  const choiceCommand = `node "${route.installedRoot}/scripts/zcode-companion.mjs" invoke-choice rescue ${choice}`;
  const followupMessage = `Continue the pending ZCode Rescue with ${choice}. Run only the installed ${choice} forwarder command and return its public stdout verbatim.`;
  const needsChoice = `${JSON.stringify({ type: 'needs-choice', candidate: { sessionId: `captured-${route.name}-session` }, choices: ['--resume', '--fresh'] })}\n`;
  const handles = route.name === 'named' ? [91, 92] : [93, 94];
  const initial = [
    installedToolCall(`${route.name}-initial-exec`, installedExecInput(route.command)),
    installedToolOutput(`${route.name}-initial-exec`, { output: `partial\n${installedCapturedRelayLine(1, 'starting', 'started')}\n`, session_id: handles[0] }),
    installedCapturedRelayCall(`${route.name}-initial-relay`, 'started'), installedCapturedFunctionOutput(`${route.name}-initial-relay`),
    installedToolCall(`${route.name}-initial-status`, installedExecInput(route.statusCommand)),
    installedToolOutput(`${route.name}-initial-status`, { output: `${JSON.stringify({ type: 'rescue-status', status: 'running', phase: 'running', lastActivityAt: '2026-08-17T00:00:02.000Z', progressPreview: ['ZCode is working.'], terminal: false })}\n`, exit_code: 0 }),
    installedToolCall(`${route.name}-initial-poll`, installedPollInput(handles[0])), installedToolOutput(`${route.name}-initial-poll`, { output: 'heartbeat\n', session_id: handles[0] }),
    installedToolCall(`${route.name}-initial-terminal`, installedPollInput(handles[0])), installedToolOutput(`${route.name}-initial-terminal`, { output: needsChoice, exit_code: 3 }),
    { type: 'event_msg', payload: { type: 'agent_message', message: needsChoice, phase: 'final_answer' } },
  ];
  const continuation = [
    installedToolCall(`${route.name}-continuation-exec`, installedExecInput(choiceCommand)),
    installedToolOutput(`${route.name}-continuation-exec`, { output: `partial\n${installedCapturedRelayLine(1, 'running', 'model-active')}\n`, session_id: handles[1] }),
    installedCapturedRelayCall(`${route.name}-continuation-relay`, 'model-active'), installedCapturedFunctionOutput(`${route.name}-continuation-relay`),
    installedToolCall(`${route.name}-continuation-poll`, installedPollInput(handles[1])), installedToolOutput(`${route.name}-continuation-poll`, { output: 'heartbeat\n', session_id: handles[1] }),
    installedToolCall(`${route.name}-continuation-terminal`, installedPollInput(handles[1])), installedToolOutput(`${route.name}-continuation-terminal`, { output: `${route.publicOutput}\n`, exit_code: 0 }),
    { type: 'event_msg', payload: { type: 'agent_message', message: route.publicOutput, phase: 'final_answer' } },
  ];
  const firstEnvelope = `Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${agentPath}\nPayload:\n${needsChoice}`;
  const secondEnvelope = `Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${agentPath}\nPayload:\n${route.publicOutput}`;
  const parent = [
    structuredClone(route.fixture.rollouts[0][0]),
    installedToolCall(`${route.name}-choice-preflight`, installedExecInput(route.preflightCommand)),
    installedToolOutput(`${route.name}-choice-preflight`, { output: `${JSON.stringify({ type: 'role-status', role: 'zcode-rescue', status: 'ready' })}\n`, exit_code: 0 }),
    installedToolCall(`${route.name}-choice-prepare`, installedExecInput(route.preparationCommand, { tty: true })),
    installedToolOutput(`${route.name}-choice-prepare`, { output: `${JSON.stringify({ type: 'preparation-input-ready', command: 'rescue' })}\n`, session_id: route.name === 'named' ? 191 : 192 }),
    installedToolCall(`${route.name}-choice-prepare-write`, installedPreparationInput(route.name === 'named' ? 191 : 192, `${route.preparationPayload}\n`)),
    installedToolOutput(`${route.name}-choice-prepare-write`, { output: `${JSON.stringify({ type: 'prepared', command: 'rescue' })}\n`, exit_code: 0 }),
    spawn, start,
    installedCapturedParentRelay(agentPath, 'started', route.name === 'named' ? 'e' : '1', route.name === 'named' ? 'e' : '1'),
    ...installedCapturedWait(`${route.name}-initial-wait`, false),
    { type: 'response_item', payload: { type: 'agent_message', author: agentPath, recipient: '/root', content: [{ type: 'input_text', text: firstEnvelope }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: `${needsChoice}Choose resume or fresh.`, phase: 'final_answer' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'followup_task', call_id: `${route.name}-followup`, arguments: JSON.stringify({ target: childThreadId, message: followupMessage }) } },
    installedCapturedFunctionOutput(`${route.name}-followup`),
    installedCapturedParentRelay(agentPath, 'model-active', route.name === 'named' ? 'f' : '2', route.name === 'named' ? 'f' : '2'),
    ...installedCapturedWait(`${route.name}-continuation-wait`, false),
    { type: 'response_item', payload: { type: 'agent_message', author: agentPath, recipient: '/root', content: [{ type: 'input_text', text: secondEnvelope }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: route.publicOutput, phase: 'final_answer' } },
  ];
  const child = [childMeta, ...initial, ...continuation];
  const parentReturns = parent.filter((event) => event?.payload?.author === agentPath
    && event.payload.content?.[0]?.type === 'input_text'
    && event.payload.content[0].text.startsWith('Message Type: FINAL_ANSWER\n'));
  const parentFinals = parent.filter((event) => event?.payload?.phase === 'final_answer');
  const followup = parent.find((event) => event?.payload?.name === 'followup_task');
  const followupOutput = parent.find((event) => event?.payload?.type === 'function_call_output' && event.payload.call_id === followup.payload.call_id);
  const timeline = [
    initial[0], initial.at(-2), initial.at(-1), parentReturns[0], parentFinals[0], followup, followupOutput,
    continuation[0], continuation.at(-2), continuation.at(-1), parentReturns[1], parentFinals[1],
  ];
  timeline.forEach((event, index) => { event.timestamp = `2026-08-17T01:00:${String(index + 1).padStart(2, '0')}.000Z`; });
  const parentRelays = parent.filter((event) => event?.payload?.content?.some((item) => item?.type === 'encrypted_content'));
  initial[2].timestamp = '2026-08-17T01:00:01.100Z';
  parentRelays[0].timestamp = '2026-08-17T01:00:01.200Z';
  continuation[2].timestamp = '2026-08-17T01:00:08.100Z';
  parentRelays[1].timestamp = '2026-08-17T01:00:08.200Z';
  return { ...route, fixture: { rollouts: [parent, child] }, parentThreadId, childThreadId, choice, choiceCommand, followupMessage,
    commands: { initial: route.command, continuation: choiceCommand, status: route.statusCommand } };
}

function qualifyInstalledCapturedChoice(route) {
  return qualifyCodexRescueChoiceEvidence(route.fixture, {
    expectedChoice: route.choice, expectedParentThreadId: route.parentThreadId, expectedAgentType: 'zcode-rescue',
    expectedWorkspace: '/installed/workspace', expectedInitialCommand: route.command, expectedChoiceCommand: route.choiceCommand,
    expectedNamedSpawnMessage: expectedNamedRescueMessage,
    expectedGenericSpawnMessage: route.name === 'generic' ? route.spawnMessage : expectedGenericRescueMessage.replaceAll('<canonical-plugin-root>', route.installedRoot),
    expectedPreflightCommand: route.preflightCommand, expectedFollowupMessage: route.followupMessage,
    expectedPreparationCommand: route.preparationCommand, expectedPreparationPayload: route.preparationPayload,
    expectedPublicOutput: route.publicOutput, requireProgressRelay: true, requireStatusSidecar: true,
    expectedStatusCommand: route.statusCommand, includeExecutionFacts: true,
    statusPrivacyCanaries: ['PRIVATE', 'raw output must stay private', 'reasoning must stay private'],
    forbiddenParentText: ['partial', 'heartbeat', 'raw output must stay private', 'reasoning must stay private'],
  });
}

function installedCapturedRunningHandles(fixture) {
  const active = new Set();
  for (const events of fixture.rollouts) {
    const outputs = new Map(events.filter((event) => event?.payload?.type === 'custom_tool_call_output').map((event) => [event.payload.call_id, event.payload.output]));
    for (const event of events.filter((candidate) => candidate?.payload?.type === 'custom_tool_call')) {
      let call; let result;
      try { call = parseInstalledToolInput(event.payload.input); result = parseInstalledHostOutput(outputs.get(event.payload.call_id)); } catch { continue; }
      if (call.kind === 'exec_command' && / invoke-prepared rescue$/u.test(call.value.cmd) && Number.isSafeInteger(result.session_id)) active.add(result.session_id);
      if (call.kind === 'write_stdin' && Object.hasOwn(result, 'exit_code')) active.delete(call.value.session_id);
    }
  }
  return active;
}

function installedCapturedRelayLine(sequence, phase, code) { return `[zcode-relay] ${JSON.stringify({ version: 1, sequence, phase, code, observedAt: `2026-08-17T00:00:0${sequence}.000Z` })}`; }
function installedCapturedRelayMessage(code) { return ({ started: 'ZCode Rescue started.', 'model-active': 'ZCode is generating a response.', 'tool-active': 'ZCode is working with a tool.' })[code]; }
function installedCapturedRelayCall(callId, code) { return { type: 'response_item', payload: { type: 'function_call', name: 'send_message', call_id: callId, arguments: JSON.stringify({ target: '/root', message: installedCapturedRelayMessage(code) }) } }; }
function installedCapturedFunctionOutput(callId) { return { type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: '' } }; }
function installedCapturedParentRelay(author, code, idMarker, turnMarker) { return { type: 'response_item', payload: { type: 'agent_message', id: `amsg_${idMarker.repeat(36)}`, author, recipient: '/root', content: [{ type: 'input_text', text: `Message Type: MESSAGE\nTask name: /root\nSender: ${author}\nPayload:\n` }, { type: 'encrypted_content', encrypted_content: `gAAAA${'A'.repeat(64)}` }], internal_chat_message_metadata_passthrough: { turn_id: `${turnMarker.repeat(8)}-${turnMarker.repeat(4)}-4${turnMarker.repeat(3)}-8${turnMarker.repeat(3)}-${turnMarker.repeat(12)}` } } }; }
function installedCapturedWait(callId, timedOut) { return [
  { type: 'response_item', payload: { type: 'function_call', name: 'wait_agent', call_id: callId, arguments: JSON.stringify({ timeout_ms: 30000 }) } },
  { type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ message: timedOut ? 'Wait timed out.' : 'Wait completed.', timed_out: timedOut }) } },
]; }
function installedChoiceYieldFacts(rollouts, childThreadId, commands) {
  try {
    const child = rollouts.filter((events) => events?.[0]?.payload?.id === childThreadId);
    if (child.length !== 1) throw new Error('child');
    const events = child[0]; const finals = events.filter((event) => event?.payload?.phase === 'final_answer');
    if (finals.length !== 2) throw new Error('finals');
    const firstFinal = events.indexOf(finals[0]); const secondFinal = events.indexOf(finals[1]);
    return {
      initial: installedYieldSegmentFacts(events.slice(1, firstFinal), commands.initial, commands.status, 3),
      continuation: installedYieldSegmentFacts(events.slice(firstFinal + 1, secondFinal), commands.continuation, commands.status, 0),
    };
  } catch { throw new Error('Installed choice qualification requires yielded same-handle terminal evidence in both logical segments.'); }
}

function installedYieldSegmentFacts(events, expectedCommand, statusCommand, expectedExitCode) {
  const calls = events.filter((event) => event?.payload?.type === 'custom_tool_call');
  const outputs = events.filter((event) => event?.payload?.type === 'custom_tool_call_output');
  const decoded = calls.map((event) => ({ event, call: parseInstalledToolInput(event.payload.input) }));
  const status = decoded.filter(({ call }) => call.kind === 'exec_command' && call.value.cmd === statusCommand);
  if (status.length > 1) throw new Error('status');
  const foreground = decoded.filter(({ event }) => !status.some((entry) => entry.event === event));
  if (foreground.length < 2 || foreground[0].call.kind !== 'exec_command' || foreground[0].call.value.cmd !== expectedCommand
    || foreground.slice(1).some(({ call }) => call.kind !== 'write_stdin')) throw new Error('calls');
  let handle; let terminalCount = 0; let terminalExitCode; let pollCount = 0;
  for (const { event, call } of foreground) {
    const linked = outputs.filter((output) => output.payload.call_id === event.payload.call_id);
    if (linked.length !== 1) throw new Error('link');
    const result = parseInstalledHostOutput(linked[0].payload.output);
    if (call.kind === 'write_stdin') {
      pollCount += 1;
      if (handle === undefined || call.value.session_id !== handle || call.value.chars !== '') throw new Error('handle');
    }
    if (Object.hasOwn(result, 'session_id')) {
      if (!Number.isSafeInteger(result.session_id) || result.session_id <= 0 || handle !== undefined && result.session_id !== handle) throw new Error('handle');
      handle ??= result.session_id;
    } else if (Object.hasOwn(result, 'exit_code')) {
      terminalCount += 1; terminalExitCode = result.exit_code;
      if (event !== foreground.at(-1).event) throw new Error('terminal');
    } else throw new Error('result');
  }
  if (handle === undefined || pollCount < 1 || terminalCount !== 1 || terminalExitCode !== expectedExitCode) throw new Error('terminal');
  return { execCommandCount: 1, pollCount, sameHandleChecked: true, terminalExitCode };
}

function installedToolCall(callId, input) { return { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input } }; }
function installedToolOutput(callId, result) { return { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output: installedHostOutput(result) } }; }
function installedExecInput(cmd, fields = {}) { return `const r = await tools.exec_command(${JSON.stringify({ cmd, workdir: '/installed/workspace', ...fields })}); text(JSON.stringify(r))\n`; }
function installedPollInput(sessionId) { return `const r = await tools.write_stdin(${JSON.stringify({ session_id: sessionId, chars: '', yield_time_ms: 30000 })}); text(JSON.stringify(r))\n`; }
function installedPreparationInput(sessionId, chars) { return `const r = await tools.write_stdin(${JSON.stringify({ session_id: sessionId, chars })}); text(JSON.stringify(r))\n`; }
function installedHostOutput(result) { return [{ type: 'input_text', text: 'Script completed\n' }, { type: 'input_text', text: JSON.stringify(result) }]; }
function parseInstalledToolInput(source) {
  for (const [kind, prefix] of [['exec_command', 'const r = await tools.exec_command('], ['write_stdin', 'const r = await tools.write_stdin(']]) {
    const suffix = '); text(JSON.stringify(r))\n';
    if (typeof source === 'string' && source.startsWith(prefix) && source.endsWith(suffix)) return { kind, value: JSON.parse(source.slice(prefix.length, -suffix.length)) };
  }
  throw new Error('tool input');
}
function parseInstalledHostOutput(output) {
  if (!Array.isArray(output) || output.length !== 2 || !output[0]?.text?.startsWith('Script completed\n') || typeof output[1]?.text !== 'string') throw new Error('tool output');
  const result = JSON.parse(output[1].text);
  if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.output !== 'string') throw new Error('tool output');
  return result;
}
