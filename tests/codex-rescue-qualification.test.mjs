// @ts-nocheck
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createIdentityStore } from '../scripts/lib/identity.mjs';
import { createRescueBinding, createRescueBindingAuthority, createRescueBindingPartition } from '../scripts/lib/rescue-binding.mjs';
import { createRescuePreparationStore } from '../scripts/lib/rescue-preparation.mjs';

import {
  assertCodexRescueDisplayName,
  CodexRescueEvidenceMismatchError,
  CodexRescueUnqualifiedError,
  parseCodexRolloutJsonl,
  qualifyCodexRescueBackgroundEvidence,
  qualifyCodexRescueChoiceEvidence,
  qualifyCodexRescuePreparedContinuationEvidence,
  qualifyCodexRescueRestoredChildEvidence,
  qualifyCodexRescueEvidence,
} from './helpers/codex-rescue-qualification.mjs';
import { expectedGenericRescueMessage, expectedNamedRescueMessage } from './helpers/rescue-skill-contract.mjs';

const parentId = '019fe6df-faa2-7851-8edb-55f1be7d5489';
const childId = '019fe6e0-4764-7192-83ba-0b0cc2c48660';
const taskName = 'zcode_rescue_fix_progress';
const agentPath = `/root/${taskName}`;
const expectedWorkspace = process.cwd();
const expectedCommand = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-prepared rescue';
const expectedPreflightCommand = 'node "/installed/zcode/skills/rescue/launcher.mjs" role-status rescue';
const expectedPreparationCommand = 'node "/installed/zcode/skills/rescue/launcher.mjs" prepare rescue';
const expectedPreparationEnvelope = Object.freeze({ version: 1, source: 'explicit', task: 'repair the qualification fixture', options: { execution: 'foreground', resume: 'fresh' } });
const expectedPreparationPayload = JSON.stringify(expectedPreparationEnvelope);
const expectedStatusCommand = 'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-status rescue';
const expectedPublicOutput = 'done';
const expectedSemanticProgress = Object.freeze({
  start: '[zcode] Running command: npm test.',
  terminal: '[zcode] Command completed: npm test (25ms).',
  snapshotFallback: '[zcode] ZCode conversation frames were unavailable; using bounded session progress.',
  lifecycleOnly: '[zcode] ZCode semantic progress is unavailable; lifecycle updates will continue.',
});
const backgroundJobId = 'b'.repeat(64);
const backgroundPublicOutput = `Reserved background job ${backgroundJobId}.`;
const executionCapability = 'qualification-capability-sentinel-private';

test('legacy adoption qualification cannot mint retired preparation authority', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'zcode-legacy-adoption-rejected-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const workspace = join(temporary, 'workspace'); await mkdir(workspace);
  await assert.rejects(createRescuePreparationStore({ dataRoot: join(temporary, 'data') }).save({
    sessionId: parentId, turnId: 'legacy-adoption-turn', workspace, permissionMode: 'acceptEdits',
    recordedPrompt: '$zcode:rescue rejected legacy adoption',
    envelope: { version: 1, source: 'explicit', task: 'rejected legacy adoption', options: { execution: 'foreground', resume: 'resume' } },
    activation: { kind: 'legacy-adopt', childThreadId: childId, agentPathDigest: createHash('sha256').update(agentPath).digest('hex') },
  }), { code: 'RESCUE_PREPARATION_INVALID' });
});

test('qualifies a resumed parent reactivating one initially unloaded original child in its linked worktree', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'zcode-restored-child-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const originDirectory = join(temporary, 'origin'); const targetDirectory = join(temporary, 'target');
  await mkdir(originDirectory); await runGit(['init', '-q'], originDirectory); await writeFile(join(originDirectory, 'fixture.txt'), 'base\n');
  await runGit(['add', 'fixture.txt'], originDirectory); await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], originDirectory);
  await runGit(['worktree', 'add', '-qb', 'restored-target', targetDirectory], originDirectory);
  const originWorkspace = await realpath(originDirectory); const executionWorkspace = await realpath(targetDirectory);
  const restoredPath = '/root/zcode_rescue_task_2'; const launcherCommand = 'node "/installed/zcode/skills/rescue/launcher.mjs"';
  const input = restoredChildFixture({ originWorkspace, executionWorkspace, agentPath: restoredPath, launcherCommand });
  const evidence = await qualifyCodexRescueRestoredChildEvidence(input);
  assert.deepEqual(evidence, { route: 'named', parentSessionId: parentId, childThreadId: childId, agentPath: restoredPath,
    originalParentTurnId: 'turn-original', resumedParentTurnId: 'turn-resumed', originWorkspace, executionWorkspace,
    followupCount: 1, spawnCount: 0, childInvocationCount: 1, restoredInitiallyUnloaded: true, collisionCount: 0 });
  const mutableHostState = structuredClone(input); const mutableFrames = JSON.parse(mutableHostState.appServerTranscriptJson);
  Object.assign(mutableFrames[3].result.thread, { updatedAt: 99, recencyAt: 99, preview: 'resumed child', path: '/persisted/child.jsonl',
    status: { type: 'active', activeFlags: ['waitingOnApproval'] }, turns: [{ id: 'resumed-turn' }] });
  mutableHostState.appServerTranscriptJson = JSON.stringify(mutableFrames);
  assert.equal((await qualifyCodexRescueRestoredChildEvidence(mutableHostState)).route, 'named');
  // Both observations are persisted with Date#toISOString millisecond precision,
  // so equality can represent a response followed by consumption in one millisecond.
  const sameMillisecondConsume = structuredClone(input); const sameMillisecondRecord = JSON.parse(sameMillisecondConsume.preparationRecordBytes);
  sameMillisecondRecord.consumedAt = '2026-08-10T01:00:00.920Z'; sameMillisecondConsume.preparationRecordBytes = `${JSON.stringify(sameMillisecondRecord)}\n`;
  assert.equal((await qualifyCodexRescueRestoredChildEvidence(sameMillisecondConsume)).route, 'named');
  const consumeBeforeReadProof = structuredClone(input); const prematureRecord = JSON.parse(consumeBeforeReadProof.preparationRecordBytes);
  prematureRecord.consumedAt = '2026-08-10T01:00:00.919Z'; consumeBeforeReadProof.preparationRecordBytes = `${JSON.stringify(prematureRecord)}\n`;
  await assert.rejects(qualifyCodexRescueRestoredChildEvidence(consumeBeforeReadProof),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'restored-child-invocation');
  const executorBeforeStarted = structuredClone(input); const earlierExecutor = JSON.parse(executorBeforeStarted.executorRecordBytes);
  earlierExecutor.createdAt = '2026-08-10T00:00:00.250Z'; executorBeforeStarted.executorRecordBytes = `${JSON.stringify(earlierExecutor)}\n`;
  assert.equal((await qualifyCodexRescueRestoredChildEvidence(executorBeforeStarted)).route, 'named');
  const startBeforeOutput = structuredClone(input); const interleaved = JSON.parse(startBeforeOutput.parentRolloutJson);
  const spawnOutputIndex = interleaved.findIndex((event) => event?.payload?.call_id === 'spawn-original' && event.payload.type === 'function_call_output');
  const startIndex = interleaved.findIndex((event) => event?.payload?.type === 'sub_agent_activity' && event.payload.kind === 'started');
  interleaved[startIndex].timestamp = '2026-08-10T00:00:00.150Z';
  [interleaved[spawnOutputIndex], interleaved[startIndex]] = [interleaved[startIndex], interleaved[spawnOutputIndex]];
  startBeforeOutput.parentRolloutJson = JSON.stringify(interleaved);
  assert.equal((await qualifyCodexRescueRestoredChildEvidence(startBeforeOutput)).route, 'named');
  const siblingFirst = structuredClone(input); const siblingFrames = JSON.parse(siblingFirst.appServerTranscriptJson);
  siblingFrames[1].result.data.unshift(restoredRawCodexChild({ originWorkspace, restoredPath: '/root/zcode_rescue_task', agentRole: 'zcode-rescue', id: 'sibling-child' }));
  siblingFirst.appServerTranscriptJson = JSON.stringify(siblingFrames);
  assert.equal((await qualifyCodexRescueRestoredChildEvidence(siblingFirst)).agentPath, restoredPath);

  for (const mutate of [
    (envelope) => { envelope.continuationTarget.childId = 'sibling-child'; },
    (envelope) => { envelope.continuationTarget.agentPath = '/root/sibling'; },
  ]) {
    const changed = structuredClone(input); const rows = JSON.parse(changed.parentRolloutJson);
    const write = rows.find((event) => event?.payload?.call_id === 'prepare-write-restored' && event.payload.type === 'custom_tool_call');
    const host = parseFixturePollInput(write.payload.input); const envelope = JSON.parse(host.chars.trim()); mutate(envelope);
    write.payload.input = structuredPoll(host.session_id, 'prepare-write-restored', `${JSON.stringify(envelope)}\n`).payload.input;
    const record = JSON.parse(changed.preparationRecordBytes); record.envelope = envelope;
    changed.parentRolloutJson = JSON.stringify(rows); changed.preparationRecordBytes = `${JSON.stringify(record)}\n`;
    await assert.rejects(qualifyCodexRescueRestoredChildEvidence(changed),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'restored-child-target');
  }

  for (const mutate of [
    (rows) => { rows.find((event) => event?.payload?.name === 'spawn_agent').timestamp = '2026-08-10T00:00:00.350Z'; },
    (rows) => { rows.find((event) => event?.payload?.call_id === 'spawn-original' && event.payload.type === 'function_call_output').timestamp = '2026-08-10T00:11:00.000Z'; },
  ]) {
    const changed = structuredClone(input); const rows = JSON.parse(changed.parentRolloutJson); mutate(rows); changed.parentRolloutJson = JSON.stringify(rows);
    await assert.rejects(qualifyCodexRescueRestoredChildEvidence(changed),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'restored-child-history');
  }
  for (const [code, mutate, explicitField] of [
    ['restored-child-current-events', (value) => JSON.parse(value.parentRolloutJson).concat({ type: 'response_item', turn_id: 'turn-resumed', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'spawn-current', arguments: '{}' } })],
    ['restored-child-host', (value) => { const rows = JSON.parse(value.appServerTranscriptJson); rows[1].result.data[0].source.subAgent.thread_spawn.agent_path = '/root/sibling'; return rows; }],
    ['restored-child-host', (value) => { const rows = JSON.parse(value.appServerTranscriptJson); rows[3].result.thread.cwd = `${originWorkspace}-drift`; return rows; }],
    ['restored-child-app-server', (value) => JSON.parse(value.appServerTranscriptJson).slice(2)],
    ['restored-child-app-server', (value) => JSON.parse(value.appServerTranscriptJson).filter((frame) => frame.method !== 'thread/read')],
    ['restored-child-app-server', (value) => { const rows = JSON.parse(value.appServerTranscriptJson); rows[3].observedAt = '2026-08-10T01:00:00.920000001Z'; return rows; }],
    ['restored-child-invocation', (value) => { const rows = JSON.parse(value.appServerTranscriptJson); rows[2].observedAt = '2026-08-10T01:00:00.750Z'; return rows; }, 'appServerTranscriptJson'],
    ['restored-child-invocation', (value) => { const rows = JSON.parse(value.appServerTranscriptJson); rows[2].observedAt = '2026-08-10T01:00:00.890Z'; return rows; }, 'appServerTranscriptJson'],
    ['restored-child-invocation', (value) => { const rows = JSON.parse(value.appServerTranscriptJson); rows[3].observedAt = '2026-08-10T01:00:01.010Z'; return rows; }, 'appServerTranscriptJson'],
    ['restored-child-directive', (value) => { const rows = JSON.parse(value.parentRolloutJson); rows.find((event) => event?.payload?.call_id === 'prepare-write-restored' && event.payload.type === 'custom_tool_call_output').payload.output = capturedResult({ output: preparedAck({ version: 1, action: 'followup', target: '/root/sibling' }), exit_code: 0 }); return rows; }],
    ['restored-child-current-events', (value) => JSON.parse(value.parentRolloutJson).filter((event) => !(event?.payload?.call_id === 'prepare-write-restored' && event.payload.type === 'custom_tool_call_output'))],
    ['restored-child-activation', (value) => { const record = JSON.parse(value.preparationRecordBytes); record.activation.executorAgentId = 'sibling'; return record; }],
  ]) {
    const changed = structuredClone(input); const field = explicitField ?? (code === 'restored-child-current-events' ? 'parentRolloutJson'
      : ['restored-child-host', 'restored-child-app-server'].includes(code) ? 'appServerTranscriptJson'
        : code === 'restored-child-directive' ? 'parentRolloutJson' : 'preparationRecordBytes');
    const mutated = mutate(changed); changed[field] = `${JSON.stringify(mutated)}${field === 'preparationRecordBytes' ? '\n' : ''}`;
    await assert.rejects(qualifyCodexRescueRestoredChildEvidence(changed), (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === code);
  }
  const fabricatedHostArray = structuredClone(input); fabricatedHostArray.hostChildrenJson = JSON.stringify([{ id: childId, agentPath: restoredPath }]);
  await assert.rejects(qualifyCodexRescueRestoredChildEvidence(fabricatedHostArray),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'restored-child-contract');

  for (const mutate of [
    (raw) => { raw.id = 'sibling-child'; },
    (raw) => { raw.parentThreadId = 'sibling-parent'; raw.source.subAgent.thread_spawn.parent_thread_id = 'sibling-parent'; },
    (raw) => { raw.source.subAgent.thread_spawn.agent_path = '/root/sibling'; },
    (raw) => { raw.agentRole = 'default'; raw.source.subAgent.thread_spawn.agent_role = 'default'; },
    (raw) => { raw.cwd = `${originWorkspace}-sibling`; },
    (raw) => { raw.createdAt = 99; },
    (raw) => { raw.source.subAgent.thread_spawn.depth = 2; },
  ]) {
    const changed = structuredClone(input); const frames = JSON.parse(changed.appServerTranscriptJson); mutate(frames[3].result.thread);
    changed.appServerTranscriptJson = JSON.stringify(frames);
    await assert.rejects(qualifyCodexRescueRestoredChildEvidence(changed),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'restored-child-host');
  }

  for (const kind of ['started', 'stopped']) {
    const changed = structuredClone(input); const rows = JSON.parse(changed.parentRolloutJson);
    changed.parentRolloutJson = JSON.stringify(rows.filter((event) => !(event?.payload?.type === 'sub_agent_activity' && event.payload.kind === kind)));
    await assert.rejects(qualifyCodexRescueRestoredChildEvidence(changed),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'restored-child-history');
  }
  for (const mutate of [
    (rows) => rows.push({ type: 'response_item', turn_id: 'turn-resumed', timestamp: '2026-08-10T01:00:00.850Z', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'extra', input: fixtureExecInput({ cmd: 'pwd', workdir: executionWorkspace }) } }),
    (rows) => rows.push({ type: 'response_item', turn_id: 'turn-resumed', timestamp: '2026-08-10T01:00:00.850Z', payload: { type: 'custom_tool_call_output', call_id: 'extra', output: capturedResult({ output: 'extra', exit_code: 0 }) } }),
  ]) {
    const changed = structuredClone(input); const rows = JSON.parse(changed.parentRolloutJson); mutate(rows); changed.parentRolloutJson = JSON.stringify(rows);
    await assert.rejects(qualifyCodexRescueRestoredChildEvidence(changed),
      (error) => error instanceof CodexRescueEvidenceMismatchError && ['restored-child-current-events', 'restored-child-call-linkage'].includes(error.code));
  }
  for (const mutate of [
    (rows) => rows.splice(rows.findIndex((event) => event?.payload?.call_id === 'followup-restored' && event.payload.type === 'function_call_output'), 1),
    (rows) => { rows.find((event) => event?.payload?.call_id === 'followup-restored' && event.payload.type === 'function_call_output').payload.call_id = 'sibling-output'; },
    (rows) => { rows.find((event) => event?.payload?.call_id === 'followup-restored' && event.payload.type === 'function_call_output').payload.output = JSON.stringify({ accepted: false, target: restoredPath }); },
    (rows) => { rows.find((event) => event?.payload?.call_id === 'followup-restored' && event.payload.type === 'function_call').timestamp = '2026-08-10T01:00:00.550Z'; },
  ]) {
    const changed = structuredClone(input); const rows = JSON.parse(changed.parentRolloutJson); mutate(rows); changed.parentRolloutJson = JSON.stringify(rows);
    await assert.rejects(qualifyCodexRescueRestoredChildEvidence(changed), (error) => error instanceof CodexRescueEvidenceMismatchError);
  }

  for (const field of ['kind', 'agentId', 'agentType', 'parentSessionId', 'parentGenerationId', 'parentTurnId', 'parentPermissionMode', 'childTurnId', 'originWorkspace', 'workspace', 'active', 'createdAt']) {
    const changed = structuredClone(input); const record = JSON.parse(changed.executorRecordBytes); record[field] = field === 'active' ? true : 'mismatch'; changed.executorRecordBytes = `${JSON.stringify(record)}\n`;
    await assert.rejects(qualifyCodexRescueRestoredChildEvidence(changed),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'restored-child-executor', field);
  }
  for (const mutate of [
    (hooks) => { hooks[0].turn_id = 'sibling-child-turn'; },
    (hooks) => hooks.pop(),
    (hooks) => hooks.push({ ...hooks[0], hook_event_name: 'SubagentStart' }),
  ]) {
    const changed = structuredClone(input); const hooks = JSON.parse(changed.hookLifecycleJson); mutate(hooks); changed.hookLifecycleJson = JSON.stringify(hooks);
    await assert.rejects(qualifyCodexRescueRestoredChildEvidence(changed),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'restored-child-hooks');
  }
  for (const createdAt of ['2026-08-10T00:00:00.050Z', '2026-08-10T00:10:00.001Z']) {
    const changed = structuredClone(input); const record = JSON.parse(changed.executorRecordBytes); record.createdAt = createdAt; changed.executorRecordBytes = `${JSON.stringify(record)}\n`;
    await assert.rejects(qualifyCodexRescueRestoredChildEvidence(changed),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'restored-child-executor');
  }
  for (const mutate of [(record) => { delete record.childTurnId; return record; }, (record) => { record.extra = true; return record; }, () => ({ agentId: childId })]) {
    const changed = structuredClone(input); const record = mutate(JSON.parse(changed.executorRecordBytes)); changed.executorRecordBytes = `${JSON.stringify(record)}\n`;
    await assert.rejects(qualifyCodexRescueRestoredChildEvidence(changed),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'restored-child-executor');
  }

  const preparationMutations = {
    activation: (record) => { record.activation.executorAgentId = 'sibling'; }, consumedAt: (record) => { record.consumedAt = '2026-08-10T00:59:59.000Z'; },
    createdAt: (record) => { record.createdAt = 'invalid'; }, envelope: (record) => { record.envelope.options.resume = 'fresh'; },
    executorAgentId: (record) => { record.executorAgentId = 'sibling'; }, expiresAt: (record) => { record.expiresAt = record.createdAt; },
    generation: (record) => { record.generation = 2; }, key: (record) => { record.key = '0'.repeat(64); },
    permissionMode: (record) => { record.permissionMode = 'deny'; }, requiredExecutorAgentId: (record) => { record.requiredExecutorAgentId = childId; },
    sessionId: (record) => { record.sessionId = 'sibling'; }, source: (record) => { record.source = 'explicit'; },
    turnId: (record) => { record.turnId = 'turn-original'; }, version: (record) => { record.version = 2; }, workspace: (record) => { record.workspace = originWorkspace; },
  };
  for (const mutate of Object.values(preparationMutations)) {
    const changed = structuredClone(input); const record = JSON.parse(changed.preparationRecordBytes); mutate(record); changed.preparationRecordBytes = `${JSON.stringify(record)}\n`;
    await assert.rejects(qualifyCodexRescueRestoredChildEvidence(changed),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'restored-child-activation');
  }
  for (const mutate of [(record) => { delete record.key; }, (record) => { record.extra = true; }]) {
    const changed = structuredClone(input); const record = JSON.parse(changed.preparationRecordBytes); mutate(record); changed.preparationRecordBytes = `${JSON.stringify(record)}\n`;
    await assert.rejects(qualifyCodexRescueRestoredChildEvidence(changed),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'restored-child-activation');
  }
  for (const [code, text] of [['restored-child-private-task', 'diagnose the agent path collision without any fallback']]) {
    const changed = structuredClone(input); const rows = JSON.parse(changed.appServerTranscriptJson);
    rows[1].result.data[0].preview = text; rows[3].result.thread.preview = text; changed.appServerTranscriptJson = JSON.stringify(rows);
    await assert.rejects(qualifyCodexRescueRestoredChildEvidence(changed),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === code);
  }
  const structuredCollisionFallback = structuredClone(input); const collisionEvents = JSON.parse(structuredCollisionFallback.parentRolloutJson);
  collisionEvents.push(
    { type: 'response_item', turn_id: 'turn-resumed', timestamp: '2026-08-10T01:00:00.850Z', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'collision-fallback', arguments: JSON.stringify({ task_name: 'zcode_rescue_task_2', fork_turns: 'none', message: 'collision retry' }) } },
    { type: 'response_item', turn_id: 'turn-resumed', timestamp: '2026-08-10T01:00:00.860Z', payload: { type: 'function_call_output', call_id: 'collision-fallback', output: JSON.stringify({ error: 'agent path collision' }) } },
  );
  structuredCollisionFallback.parentRolloutJson = JSON.stringify(collisionEvents);
  await assert.rejects(qualifyCodexRescueRestoredChildEvidence(structuredCollisionFallback),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'restored-child-current-events');
});

test('qualifies a restored generic child only with its exact historical generic assignment', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'zcode-restored-generic-')); t.after(() => rm(temporary, { recursive: true, force: true }));
  const originDirectory = join(temporary, 'origin'); const targetDirectory = join(temporary, 'target');
  await mkdir(originDirectory); await runGit(['init', '-q'], originDirectory); await writeFile(join(originDirectory, 'fixture.txt'), 'base\n');
  await runGit(['add', 'fixture.txt'], originDirectory); await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], originDirectory);
  await runGit(['worktree', 'add', '-qb', 'restored-generic-target', targetDirectory], originDirectory);
  const input = restoredChildFixture({ originWorkspace: await realpath(originDirectory), executionWorkspace: await realpath(targetDirectory),
    agentPath: '/root/zcode_rescue_task', launcherCommand: 'node "/installed/zcode/skills/rescue/launcher.mjs"', route: 'generic' });
  const evidence = await qualifyCodexRescueRestoredChildEvidence(input);
  assert.equal(evidence.route, 'generic'); assert.equal(evidence.followupCount, 1); assert.equal(evidence.spawnCount, 0);
  const wrong = structuredClone(input); const rows = JSON.parse(wrong.parentRolloutJson);
  rows.find((event) => event?.payload?.name === 'spawn_agent').payload.arguments = JSON.stringify({ fork_turns: 'none', task_name: 'zcode_rescue_task', message: expectedNamedRescueMessage }); wrong.parentRolloutJson = JSON.stringify(rows);
  await assert.rejects(qualifyCodexRescueRestoredChildEvidence(wrong), (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'restored-child-history');
});

test('qualifies named and generic foreground/background continuation in one active parent turn on one stopped child and exact peer session', async () => {
  for (const route of ['named', 'generic']) for (const execution of ['foreground', 'background']) {
    const evidence = await qualifyCodexRescuePreparedContinuationEvidence(
      preparedContinuationFixture(route, execution),
      { requireLongLifecycle: true },
    );
    assert.deepEqual(evidence, {
      route,
      parentSessionId: parentId,
      childThreadId: childId,
      agentPath,
      originalParentTurnId: 'turn-original',
      continuationParentTurnId: 'turn-original',
      spawnCount: 1,
      startCount: 1,
      stopCount: 1,
      followupCount: 1,
      continuationSpawnCount: 0,
      childInvocationCount: 2,
      peerResumeChecked: true,
      activeTurnLifecycleChecked: true,
      longLifecycleChecked: true,
      execution,
    });
  }
});

test('prepared continuation qualifies the exact v2 lifecycle pair and route path in either linked event order', async () => {
  for (const reverseLifecycleOrder of [false, true]) {
    const input = preparedContinuationFixture('named');
    const parent = JSON.parse(input.parentRolloutJson);
    if (reverseLifecycleOrder) {
      const startedIndex = parent.findIndex((event) => event?.payload?.kind === 'started');
      const outputIndex = parent.findIndex((event) => event?.payload?.type === 'function_call_output' && event.payload.call_id === 'spawn-1');
      [parent[startedIndex], parent[outputIndex]] = [parent[outputIndex], parent[startedIndex]];
    }
    input.parentRolloutJson = JSON.stringify(parent);
    const evidence = await qualifyCodexRescuePreparedContinuationEvidence(input);
    assert.equal(evidence.agentPath, agentPath);

    const calls = JSON.parse(input.parentRolloutJson);
    const writes = calls.filter((event) => event?.payload?.type === 'custom_tool_call' && event.payload.call_id?.startsWith('prepare-write-'));
    const fresh = JSON.parse(parseFixturePollInput(writes[0].payload.input).chars.trim());
    const resume = JSON.parse(parseFixturePollInput(writes[1].payload.input).chars.trim());
    assert.deepEqual(fresh, { version: 2, source: 'explicit', task: 'repair fixture', options: { execution: 'foreground', resume: 'fresh' }, continuationTarget: null });
    assert.deepEqual(resume.continuationTarget, { childId, agentPath });
    const followup = calls.find((event) => event?.payload?.name === 'followup_task');
    assert.equal(JSON.parse(followup.payload.arguments).target, agentPath);
  }
});

test('prepared continuation rejects each cross-pair and post-planning target mutation without sibling acceptance', async () => {
  const mutations = [
    ['continuation-target-lifecycle', (input) => {
      const rows = JSON.parse(input.parentRolloutJson);
      const output = rows.find((event) => event?.payload?.type === 'function_call_output' && event.payload.call_id === 'spawn-1');
      output.payload.output = JSON.stringify({ agent_id: 'sibling-child' });
      input.parentRolloutJson = JSON.stringify(rows);
    }],
    ['continuation-target-preparation', (input) => {
      const rows = JSON.parse(input.parentRolloutJson);
      const write = rows.find((event) => event?.payload?.call_id === 'prepare-write-2' && event.payload.type === 'custom_tool_call');
      const host = parseFixturePollInput(write.payload.input); const envelope = JSON.parse(host.chars.trim());
      envelope.continuationTarget.agentPath = '/root/sibling'; write.payload.input = structuredPoll(host.session_id, 'prepare-write-2', `${JSON.stringify(envelope)}\n`).payload.input;
      input.parentRolloutJson = JSON.stringify(rows);
      const records = JSON.parse(input.preparationRecordBytesJson); const record = JSON.parse(records[1]); record.envelope = envelope; records[1] = `${JSON.stringify(record)}\n`; input.preparationRecordBytesJson = JSON.stringify(records);
    }],
    ['continuation-target-activation', (input) => {
      const records = JSON.parse(input.preparationRecordBytesJson); const record = JSON.parse(records[1]);
      record.activation.agentPathDigest = createHash('sha256').update('/root/sibling').digest('hex'); records[1] = `${JSON.stringify(record)}\n`; input.preparationRecordBytesJson = JSON.stringify(records);
    }],
    ['continuation-followup-target', (input) => {
      const rows = JSON.parse(input.parentRolloutJson); const call = rows.find((event) => event?.payload?.name === 'followup_task');
      const args = JSON.parse(call.payload.arguments); args.target = '/root/sibling'; call.payload.arguments = JSON.stringify(args); input.parentRolloutJson = JSON.stringify(rows);
    }],
  ];
  for (const [code, mutate] of mutations) {
    const input = preparedContinuationFixture('named'); mutate(input);
    await assert.rejects(qualifyCodexRescuePreparedContinuationEvidence(input),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === code, code);
  }
});

test('prepared continuation selects the exact target with two complete bindings regardless of partition order', async () => {
  for (const siblingFirst of [false, true]) {
    const input = preparedContinuationFixture('named');
    const siblingAnchor = 'e'.repeat(64); const siblingCurrent = 'f'.repeat(64);
    const sibling = createRescueBinding({ parentSessionId: parentId, executorAgentId: 'sibling-child', executorAgentType: 'zcode-rescue',
      executorParentTurnId: 'turn-original', executorParentPermissionMode: 'acceptEdits', workspace: expectedWorkspace,
      permissionMode: 'acceptEdits', anchorJobId: siblingAnchor, currentJobId: siblingCurrent,
      operationId: '1'.repeat(64), now: '2026-08-10T02:00:00.000Z' });
    const siblingPre = { ...sibling, currentJobId: siblingAnchor, updatedAt: '2026-08-10T02:00:00.000Z' };
    const pre = JSON.parse(input.bindingPreReservationBytes); const current = JSON.parse(input.bindingPartitionBytes);
    const preRecords = siblingFirst ? [siblingPre, ...pre.records] : [...pre.records, siblingPre];
    const currentRecords = siblingFirst ? [sibling, ...current.records] : [...current.records, sibling];
    input.bindingPreReservationBytes = `${JSON.stringify(createRescueBindingPartition({ parentSessionId: parentId, workspace: expectedWorkspace, records: preRecords }))}\n`;
    input.bindingPartitionBytes = `${JSON.stringify(createRescueBindingPartition({ parentSessionId: parentId, workspace: expectedWorkspace, records: currentRecords }))}\n`;
    const jobs = JSON.parse(input.jobRecordBytesJson);
    jobs.push(`${JSON.stringify(rawJob(siblingAnchor, 'turn-original', 'succeeded', { zcodeSessionId: 'sibling-session' }))}\n`);
    jobs.push(`${JSON.stringify(rawJob(siblingCurrent, 'turn-original', 'succeeded', { zcodeSessionId: 'sibling-session' }))}\n`);
    input.jobRecordBytesJson = JSON.stringify(jobs);
    const evidence = await qualifyCodexRescuePreparedContinuationEvidence(input);
    assert.equal(evidence.childThreadId, childId); assert.equal(evidence.agentPath, agentPath);
  }
});

test('qualifies raw v3 origin-to-execution workspace authority and immutable generation routing', async () => {
  const input = preparedContinuationFixture('named');
  const generationId = '9'.repeat(64);
  const globalKey = createHash('sha256').update(JSON.stringify([parentId])).digest('hex');
  const unbound = {
    version: 3, kind: 'active-turn', key: globalKey, sessionId: parentId, generationId,
    turnId: 'turn-original', originWorkspace: expectedWorkspace, executionWorkspace: null,
    permissionMode: 'acceptEdits', prompt: '$zcode:rescue repair fixture',
    createdAt: '2026-08-09T23:59:59.000Z', status: 'active',
  };
  const pending = { ...unbound, status: 'pending' };
  const bound = { ...unbound, executionWorkspace: expectedWorkspace };
  input.expected.originWorkspace = expectedWorkspace;
  input.expected.executionWorkspace = expectedWorkspace;
  input.activeTurnRecordBytes = `${JSON.stringify(bound)}\n`;
  input.authorityTransitionBytesJson = JSON.stringify([
    `${JSON.stringify(pending)}\n`, `${JSON.stringify(unbound)}\n`, `${JSON.stringify(unbound)}\n`, `${JSON.stringify(bound)}\n`,
  ]);
  input.roleStatusEvidenceJson = JSON.stringify({ command: 'role-status rescue', workspace: expectedWorkspace,
    activeBytesBefore: `${JSON.stringify(unbound)}\n`, activeBytesAfter: `${JSON.stringify(unbound)}\n`, mtimeBefore: 1, mtimeAfter: 1,
    result: { type: 'role-status', role: 'zcode-rescue', status: 'ready' } });
  input.originIndexRecordBytes = `${JSON.stringify({
    version: 1, kind: 'active-turn-index', key: createHash('sha256').update(JSON.stringify([parentId, expectedWorkspace])).digest('hex'),
    sessionId: parentId, generationId, globalKey, originWorkspace: expectedWorkspace,
  })}\n`;
  input.executorRouteRecordBytes = `${JSON.stringify({
    version: 1, kind: 'executor-route', agentId: childId, agentType: 'zcode-rescue', parentSessionId: parentId,
    parentGenerationId: generationId, parentTurnId: 'turn-original', parentPermissionMode: 'acceptEdits',
    childTurnId: 'child-turn', originWorkspace: expectedWorkspace, targetWorkspace: expectedWorkspace,
    state: 'stopped', createdAt: '2026-08-10T00:00:02.000Z', updatedAt: '2026-08-10T00:00:05.000Z',
  })}\n`;
  input.executorRecordBytes = `${JSON.stringify({
    kind: 'subagent-executor', agentId: childId, agentType: 'zcode-rescue', parentSessionId: parentId,
    parentGenerationId: generationId, parentTurnId: 'turn-original', parentPermissionMode: 'acceptEdits', childTurnId: 'child-turn',
    originWorkspace: expectedWorkspace, workspace: expectedWorkspace, active: false, createdAt: '2026-08-10T00:00:02.000Z',
  })}\n`;
  input.authorityLifecycleJson = JSON.stringify([
    { phase: 'session-start', workspace: expectedWorkspace, at: '2026-08-09T23:59:58.000Z' },
    { phase: 'user-prompt', workspace: expectedWorkspace, at: '2026-08-09T23:59:59.000Z' },
    { phase: 'pending', workspace: expectedWorkspace, generationId, at: '2026-08-09T23:59:59.100Z' },
    { phase: 'active-unbound', workspace: expectedWorkspace, generationId, at: '2026-08-09T23:59:59.200Z' },
    { phase: 'role-preview', workspace: expectedWorkspace, generationId, at: '2026-08-10T00:00:00.100Z' },
    { phase: 'prepare', workspace: expectedWorkspace, generationId, at: '2026-08-10T00:00:00.250Z' },
    { phase: 'active-bound', workspace: expectedWorkspace, generationId, at: '2026-08-10T00:00:00.300Z' },
    { phase: 'subagent-start', workspace: expectedWorkspace, generationId, at: '2026-08-10T00:00:02.000Z' },
    { phase: 'peer-create', workspace: expectedWorkspace, generationId, at: '2026-08-10T00:00:02.500Z' },
    { phase: 'authority-revoked', workspace: expectedWorkspace, generationId, at: '2026-08-10T01:02:00.000Z' },
    { phase: 'target-cleanup', workspace: expectedWorkspace, generationId, at: '2026-08-10T01:02:00.100Z' },
  ]);
  attachWorkspaceArtifactLocations(input, expectedWorkspace, expectedWorkspace, generationId);

  const evidence = await qualifyCodexRescuePreparedContinuationEvidence(input);
  assert.equal(evidence.originWorkspace, expectedWorkspace);
  assert.equal(evidence.executionWorkspace, expectedWorkspace);
  assert.equal(evidence.generationId, generationId);
  assert.equal(evidence.workspaceBindingChecked, true);
});

test('qualifies distinct canonical linked worktree execution while hooks remain at the origin', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'zcode-worktree-qualification-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const originDirectory = join(temporary, 'origin'); const executionDirectory = join(temporary, 'execution');
  await mkdir(originDirectory);
  await runGit(['init', '-q'], originDirectory);
  await writeFile(join(originDirectory, 'fixture.txt'), 'base\n');
  await runGit(['add', 'fixture.txt'], originDirectory);
  await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], originDirectory);
  await runGit(['worktree', 'add', '-qb', 'qualification-target', executionDirectory], originDirectory);
  const originWorkspace = await realpath(originDirectory); const executionWorkspace = await realpath(executionDirectory);
  const input = workspaceBoundContinuationFixture(originWorkspace, executionWorkspace);
  const evidence = await qualifyCodexRescuePreparedContinuationEvidence(input);
  assert.equal(evidence.originWorkspace, originWorkspace);
  assert.equal(evidence.executionWorkspace, executionWorkspace);
  assert.notEqual(evidence.originWorkspace, evidence.executionWorkspace);
  assert.equal(evidence.workspaceBindingChecked, true);

  const childAtTarget = workspaceBoundContinuationFixture(originWorkspace, executionWorkspace);
  const childRows = JSON.parse(childAtTarget.childRolloutJson);
  for (const row of childRows.filter((event) => event?.payload?.type === 'custom_tool_call')) {
    const host = parseFixtureHostInput(row.payload.input);
    if (host.cmd === expectedCommand) host.workdir = executionWorkspace;
    row.payload.input = fixtureExecInput(host);
  }
  childAtTarget.childRolloutJson = JSON.stringify(childRows);
  await assert.rejects(qualifyCodexRescuePreparedContinuationEvidence(childAtTarget),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'continuation-child-exec-envelope-mismatch');

  const misplacedRoute = workspaceBoundContinuationFixture(originWorkspace, executionWorkspace);
  const locations = JSON.parse(misplacedRoute.artifactLocationsJson);
  const routeLocation = locations.find((artifact) => artifact.role === 'executor-route');
  routeLocation.path = routeLocation.path.replace(
    createHash('sha256').update(originWorkspace).digest('hex'),
    createHash('sha256').update(executionWorkspace).digest('hex'),
  );
  misplacedRoute.artifactLocationsJson = JSON.stringify(locations);
  await assert.rejects(qualifyCodexRescuePreparedContinuationEvidence(misplacedRoute),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'continuation-artifact-location');

  const readOnlyDataRoot = join(temporary, 'readonly-data-root'); await mkdir(readOnlyDataRoot, { mode: 0o700 });
  const beforeEntries = await readdir(readOnlyDataRoot); const beforeStat = await stat(readOnlyDataRoot);
  const missingStorage = workspaceBoundContinuationFixture(originWorkspace, executionWorkspace); missingStorage.installedDataRoot = readOnlyDataRoot;
  await assert.rejects(qualifyCodexRescuePreparedContinuationEvidence(missingStorage), CodexRescueEvidenceMismatchError);
  const afterEntries = await readdir(readOnlyDataRoot); const afterStat = await stat(readOnlyDataRoot);
  assert.deepEqual(afterEntries, beforeEntries);
  assert.deepEqual({ mode: afterStat.mode, mtimeMs: afterStat.mtimeMs, ctimeMs: afterStat.ctimeMs },
    { mode: beforeStat.mode, mtimeMs: beforeStat.mtimeMs, ctimeMs: beforeStat.ctimeMs });

  const windowsDataRoot = join(temporary, 'windows-data-root');
  const originKey = createHash('sha256').update(originWorkspace).digest('hex');
  const executionKey = createHash('sha256').update(executionWorkspace).digest('hex');
  const windowsDirectories = [windowsDataRoot, join(windowsDataRoot, 'workspaces'),
    join(windowsDataRoot, 'workspaces', originKey), join(windowsDataRoot, 'workspaces', executionKey),
    join(windowsDataRoot, 'workspaces', executionKey, 'jobs')];
  await mkdir(windowsDirectories.at(-1), { recursive: true });
  await mkdir(windowsDirectories[2], { recursive: true });
  await Promise.all(windowsDirectories.map((path) => chmod(path, 0o755)));
  const installedInput = workspaceBoundContinuationFixture(originWorkspace, executionWorkspace); installedInput.installedDataRoot = windowsDataRoot;
  for (const bytes of JSON.parse(installedInput.jobRecordBytesJson)) {
    const job = JSON.parse(bytes); await writeFile(join(windowsDirectories.at(-1), `${job.id}.json`), bytes);
  }
  const snapshotStorage = async () => Promise.all(windowsDirectories.map(async (path) => {
    const metadata = await stat(path); return { path, entries: (await readdir(path)).sort(), mode: metadata.mode, mtimeMs: metadata.mtimeMs, ctimeMs: metadata.ctimeMs };
  }));
  const windowsBefore = await snapshotStorage(); const platformBefore = process.platform;
  if (process.platform === 'win32') await qualifyCodexRescuePreparedContinuationEvidence(installedInput);
  else await assert.rejects(qualifyCodexRescuePreparedContinuationEvidence(installedInput), CodexRescueEvidenceMismatchError);
  assert.equal(process.platform, platformBefore);
  assert.deepEqual(await snapshotStorage(), windowsBefore);

  const swapped = workspaceBoundContinuationFixture(originWorkspace, executionWorkspace);
  const swappedActive = JSON.parse(swapped.activeTurnRecordBytes);
  [swappedActive.originWorkspace, swappedActive.executionWorkspace] = [swappedActive.executionWorkspace, swappedActive.originWorkspace];
  swapped.activeTurnRecordBytes = `${JSON.stringify(swappedActive)}\n`;
  await assert.rejects(qualifyCodexRescuePreparedContinuationEvidence(swapped),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'continuation-active-turn');

  const unrelatedDirectory = join(temporary, 'unrelated');
  await mkdir(unrelatedDirectory);
  await runGit(['init', '-q'], unrelatedDirectory);
  await writeFile(join(unrelatedDirectory, 'fixture.txt'), 'unrelated\n');
  await runGit(['add', 'fixture.txt'], unrelatedDirectory);
  await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'unrelated'], unrelatedDirectory);
  const unrelated = workspaceBoundContinuationFixture(originWorkspace, await realpath(unrelatedDirectory));
  await assert.rejects(qualifyCodexRescuePreparedContinuationEvidence(unrelated),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'continuation-workspace-lineage');
});

test('workspace-binding qualification rejects authority, route, peer, and cleanup mutations with stable codes', async () => {
  const mutations = [
    ['continuation-workspace-claim', (input) => { const rows = JSON.parse(input.authorityTransitionBytesJson); const bound = JSON.parse(rows[3]); bound.executionWorkspace = null; rows[3] = `${JSON.stringify(bound)}\n`; input.authorityTransitionBytesJson = JSON.stringify(rows); }],
    ['continuation-second-target', (input) => { const rows = JSON.parse(input.authorityTransitionBytesJson); const bound = JSON.parse(rows[3]); bound.executionWorkspace = '/second-target'; rows[3] = `${JSON.stringify(bound)}\n`; input.authorityTransitionBytesJson = JSON.stringify(rows); }],
    ['continuation-authority-transition', (input) => { const rows = JSON.parse(input.authorityTransitionBytesJson); const unbound = JSON.parse(rows[1]); unbound.generationId = '8'.repeat(64); rows[1] = `${JSON.stringify(unbound)}\n`; input.authorityTransitionBytesJson = JSON.stringify(rows); }],
    ['continuation-authority-transition', (input) => { const rows = JSON.parse(input.authorityTransitionBytesJson); const unbound = JSON.parse(rows[1]); unbound.turnId = 'wrong-turn'; rows[1] = `${JSON.stringify(unbound)}\n`; input.authorityTransitionBytesJson = JSON.stringify(rows); }],
    ['continuation-authority-transition', (input) => { const rows = JSON.parse(input.authorityTransitionBytesJson); const unbound = JSON.parse(rows[1]); unbound.permissionMode = 'read-only'; rows[1] = `${JSON.stringify(unbound)}\n`; input.authorityTransitionBytesJson = JSON.stringify(rows); }],
    ['continuation-authority-transition', (input) => { const rows = JSON.parse(input.authorityTransitionBytesJson); const unbound = JSON.parse(rows[1]); unbound.sessionId = 'sibling-session'; rows[1] = `${JSON.stringify(unbound)}\n`; input.authorityTransitionBytesJson = JSON.stringify(rows); }],
    ['continuation-authority-order', (input) => { const rows = JSON.parse(input.authorityTransitionBytesJson); const pending = JSON.parse(rows[0]); pending.executionWorkspace = expectedWorkspace; rows[0] = `${JSON.stringify(pending)}\n`; input.authorityTransitionBytesJson = JSON.stringify(rows); }],
    ['continuation-role-mutation', (input) => { const rows = JSON.parse(input.authorityTransitionBytesJson); const preview = JSON.parse(rows[2]); preview.prompt = 'mutated by role'; rows[2] = `${JSON.stringify(preview)}\n`; input.authorityTransitionBytesJson = JSON.stringify(rows); }],
    ['continuation-role-preview', (input) => { const role = JSON.parse(input.roleStatusEvidenceJson); role.mtimeAfter += 1; input.roleStatusEvidenceJson = JSON.stringify(role); }],
    ['continuation-origin-index', (input) => { const index = JSON.parse(input.originIndexRecordBytes); index.generationId = '8'.repeat(64); input.originIndexRecordBytes = `${JSON.stringify(index)}\n`; }],
    ['continuation-origin-index', (input) => { delete input.originIndexRecordBytes; }],
    ['continuation-executor-route', (input) => { const route = JSON.parse(input.executorRouteRecordBytes); route.parentGenerationId = '8'.repeat(64); input.executorRouteRecordBytes = `${JSON.stringify(route)}\n`; }],
    ['continuation-executor-route', (input) => { const route = JSON.parse(input.executorRouteRecordBytes); route.agentType = 'default'; input.executorRouteRecordBytes = `${JSON.stringify(route)}\n`; }],
    ['continuation-executor-route', (input) => { const route = JSON.parse(input.executorRouteRecordBytes); route.childTurnId = 'wrong-child-turn'; input.executorRouteRecordBytes = `${JSON.stringify(route)}\n`; }],
    ['continuation-executor-route', (input) => { const route = JSON.parse(input.executorRouteRecordBytes); route.createdAt = 'invalid'; input.executorRouteRecordBytes = `${JSON.stringify(route)}\n`; }],
    ['continuation-executor-route', (input) => { const route = JSON.parse(input.executorRouteRecordBytes); route.updatedAt = '2026-08-10T00:00:01.000Z'; input.executorRouteRecordBytes = `${JSON.stringify(route)}\n`; }],
    ['continuation-executor-route', (input) => { const route = JSON.parse(input.executorRouteRecordBytes); route.state = 'active'; input.executorRouteRecordBytes = `${JSON.stringify(route)}\n`; }],
    ['continuation-executor-provenance', (input) => { const executor = JSON.parse(input.executorRecordBytes); executor.parentGenerationId = '8'.repeat(64); input.executorRecordBytes = `${JSON.stringify(executor)}\n`; }],
    ['continuation-peer-method', (input) => { const peer = JSON.parse(input.fakePeerJson); peer[0].params.workspace.workspacePath = '/origin-instead-of-target'; input.fakePeerJson = JSON.stringify(peer); }],
    ['continuation-authority-order', (input) => { const lifecycle = JSON.parse(input.authorityLifecycleJson); [lifecycle[9], lifecycle[10]] = [lifecycle[10], lifecycle[9]]; input.authorityLifecycleJson = JSON.stringify(lifecycle); }],
    ['continuation-private-leak', (input) => { const rows = JSON.parse(input.parentRolloutJson); const call = rows.find((row) => row?.payload?.call_id === 'prepare-1'); const host = parseFixtureHostInput(call.payload.input); host.env.GENERATION_LEAK = JSON.parse(input.activeTurnRecordBytes).generationId; call.payload.input = fixtureExecInput(host); input.parentRolloutJson = JSON.stringify(rows); }],
  ];
  for (const [code, mutate] of mutations) {
    const input = workspaceBoundContinuationFixture(expectedWorkspace, expectedWorkspace); mutate(input);
    await assert.rejects(qualifyCodexRescuePreparedContinuationEvidence(input),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === code, code);
  }
});

test('live-duration continuation evidence stays valid without claiming deterministic long-lifecycle coverage', async () => {
  const input = preparedContinuationFixture('named');
  const records = JSON.parse(input.preparationRecordBytesJson);
  const first = JSON.parse(records[0]); first.consumedAt = '2026-08-10T00:20:00.000Z'; records[0] = `${JSON.stringify(first)}\n`;
  input.preparationRecordBytesJson = JSON.stringify(records);
  const evidence = await qualifyCodexRescuePreparedContinuationEvidence(input);
  assert.equal(evidence.activeTurnLifecycleChecked, true);
  assert.equal(evidence.longLifecycleChecked, false);
  await assert.rejects(
    qualifyCodexRescuePreparedContinuationEvidence(input, { requireLongLifecycle: true }),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'continuation-active-turn',
  );
  await assert.rejects(
    qualifyCodexRescuePreparedContinuationEvidence(input, { requireLongLifecycle: 'yes' }),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'continuation-raw-contract',
  );
});

test('same-turn qualification rejects generation, required executor, turn identity, and exact binding CAS mutations', async () => {
  const mutations = [
    ['continuation-preparation-records', (input) => { const records = JSON.parse(input.preparationRecordBytesJson); const second = JSON.parse(records[1]); second.generation = 3; records[1] = `${JSON.stringify(second)}\n`; input.preparationRecordBytesJson = JSON.stringify(records); }],
    ['continuation-preparation-records', (input) => { const records = JSON.parse(input.preparationRecordBytesJson); const second = JSON.parse(records[1]); second.requiredExecutorAgentId = 'sibling'; records[1] = `${JSON.stringify(second)}\n`; input.preparationRecordBytesJson = JSON.stringify(records); }],
    ['continuation-parent-turns', (input) => { const rows = JSON.parse(input.parentRolloutJson); rows.find((row) => row?.payload?.name === 'followup_task').turn_id = 'turn-replaced'; input.parentRolloutJson = JSON.stringify(rows); }],
    ['continuation-binding-identity', (input) => { const partition = JSON.parse(input.bindingPartitionBytes); partition.records[0].operationId = 'e'.repeat(64); input.bindingPartitionBytes = `${JSON.stringify(partition)}\n`; }],
    ['continuation-current-job-stale', (input) => { const partition = JSON.parse(input.bindingPartitionBytes); partition.records[0].currentJobId = 'f'.repeat(64); input.bindingPartitionBytes = `${JSON.stringify(partition)}\n`; }],
    ['continuation-active-turn', (input) => { const active = JSON.parse(input.activeTurnRecordBytes); active.expiresAt = '2026-08-10T00:30:00.000Z'; input.activeTurnRecordBytes = `${JSON.stringify(active)}\n`; }],
    ['continuation-active-turn', (input) => { const records = JSON.parse(input.preparationRecordBytesJson); const second = JSON.parse(records[1]); second.createdAt = '2026-08-10T00:59:00.600Z'; second.expiresAt = '2026-08-10T01:29:00.600Z'; records[1] = `${JSON.stringify(second)}\n`; input.preparationRecordBytesJson = JSON.stringify(records); }, true],
    ['continuation-binding-identity', (input) => { const pre = JSON.parse(input.bindingPreReservationBytes); pre.records[0].operationId = 'e'.repeat(64); input.bindingPreReservationBytes = `${JSON.stringify(pre)}\n`; }],
    ['continuation-current-job-stale', (input) => { const pre = JSON.parse(input.bindingPreReservationBytes); pre.records[0].currentJobId = 'f'.repeat(64); input.bindingPreReservationBytes = `${JSON.stringify(pre)}\n`; }],
  ];
  for (const [code, mutate, requireLongLifecycle = false] of mutations) {
    const input = preparedContinuationFixture('named'); mutate(input);
    await assert.rejects(qualifyCodexRescuePreparedContinuationEvidence(input, { requireLongLifecycle }),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === code, code);
  }
});

test('prepared continuation qualification rejects normalized claims and fails closed on raw artifact mutations', async () => {
  await assert.rejects(qualifyCodexRescuePreparedContinuationEvidence({ valid: true, peerResumeChecked: true }),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'continuation-raw-contract');
  const mutations = [
    ['continuation-start-count', (input) => { const rows = JSON.parse(input.parentRolloutJson); rows.push(rows.find((row) => row?.payload?.kind === 'started')); input.parentRolloutJson = JSON.stringify(rows); }],
    ['continuation-event-order', (input) => { const rows = JSON.parse(input.parentRolloutJson); rows.find((row) => row?.payload?.kind === 'stopped').timestamp = '2026-08-10T00:00:01.500Z'; input.parentRolloutJson = JSON.stringify(rows); }],
    ['continuation-call-linkage', (input) => { const rows = JSON.parse(input.parentRolloutJson).filter((row) => !(row?.payload?.type === 'function_call_output' && row.payload.call_id === 'spawn-1')); input.parentRolloutJson = JSON.stringify(rows); }],
    ['continuation-followup-target', (input) => { const rows = JSON.parse(input.parentRolloutJson); const call = rows.find((row) => row?.payload?.name === 'followup_task'); const args = JSON.parse(call.payload.arguments); args.target = 'sibling'; call.payload.arguments = JSON.stringify(args); input.parentRolloutJson = JSON.stringify(rows); }],
    ['continuation-parent-turns', (input) => { const rows = JSON.parse(input.parentRolloutJson); rows.find((row) => row?.payload?.name === 'followup_task').turn_id = 'turn-replaced'; input.parentRolloutJson = JSON.stringify(rows); }],
    ['continuation-presentation', (input) => { const rows = JSON.parse(input.parentRolloutJson); const call = rows.find((row) => row?.payload?.name === 'spawn_agent'); const args = JSON.parse(call.payload.arguments); args.task_name = 'sibling_task'; call.payload.arguments = JSON.stringify(args); input.parentRolloutJson = JSON.stringify(rows); }],
    ['continuation-presentation', (input) => { const rows = JSON.parse(input.parentRolloutJson); rows.find((row) => row?.payload?.kind === 'started').payload.agent_path = '/root/sibling_task'; input.parentRolloutJson = JSON.stringify(rows); }],
    ['continuation-child-turns', (input) => { const rows = JSON.parse(input.childRolloutJson); for (const row of rows.filter((item) => item?.payload?.type === 'custom_tool_call')) row.turn_id = 'one-turn'; for (const row of rows.filter((item) => item?.payload?.type === 'custom_tool_call_output')) row.turn_id = 'one-turn'; input.childRolloutJson = JSON.stringify(rows); }],
    ['continuation-session-mismatch', (input) => { const rows = JSON.parse(input.fakePeerJson); rows.find((row) => row.method === 'session/resume').params.sessionId = 'latest-wrong-session'; input.fakePeerJson = JSON.stringify(rows); }],
    ['continuation-peer-method', (input) => { const rows = JSON.parse(input.fakePeerJson); rows[3].id = rows[2].id; input.fakePeerJson = JSON.stringify(rows); }],
    ['continuation-peer-method', (input) => { const rows = JSON.parse(input.fakePeerJson); rows[0].params.workspace.workspacePath = '/foreign'; input.fakePeerJson = JSON.stringify(rows); }],
    ['continuation-peer-method', (input) => { const rows = JSON.parse(input.fakePeerJson); rows[1].params.extra = true; input.fakePeerJson = JSON.stringify(rows); }],
    ['continuation-peer-method', (input) => { const rows = JSON.parse(input.fakePeerJson); delete rows[0].params.workspace.workspaceKey; input.fakePeerJson = JSON.stringify(rows); }],
    ['continuation-peer-method', (input) => { const rows = JSON.parse(input.fakePeerJson); rows[1].params.queryId = 'another-input'; input.fakePeerJson = JSON.stringify(rows); }],
    ['continuation-peer-method', (input) => { const rows = JSON.parse(input.fakePeerJson); rows[3].params.content = ''; input.fakePeerJson = JSON.stringify(rows); }],
    ['continuation-peer-order', (input) => { const rows = JSON.parse(input.fakePeerJson); input.fakePeerJson = JSON.stringify([rows[2], rows[1], rows[0], rows[3]]); }],
    ['continuation-private-leak', (input) => { const rows = JSON.parse(input.parentRolloutJson); const call = rows.find((row) => row?.payload?.call_id === 'prepare-1'); const host = parseFixtureHostInput(call.payload.input); host.env.LEAK = JSON.parse(input.fakePeerJson)[1].params.sessionId; call.payload.input = fixtureExecInput(host); input.parentRolloutJson = JSON.stringify(rows); }],
    ['continuation-binding-invalid', (input) => { input.bindingPartitionBytes = `${input.bindingPartitionBytes.slice(0, -2)},"valid":true}\n`; }],
    ['continuation-job-identity', (input) => { const jobs = rawJobs(input); jobs.splice(1, 1); setRawJobs(input, jobs); }],
    ['continuation-job-identity', (input) => { const jobs = rawJobs(input); jobs.push({ ...jobs[1] }); setRawJobs(input, jobs); }],
    ['continuation-hook-lifecycle', (input) => { const hooks = JSON.parse(input.hookLifecycleJson); hooks[1].agent_type = 'default'; input.hookLifecycleJson = JSON.stringify(hooks); }],
    ['continuation-hook-lifecycle', (input) => { const hooks = JSON.parse(input.hookLifecycleJson); hooks[2].session_id = 'sibling'; input.hookLifecycleJson = JSON.stringify(hooks); }],
    ['continuation-hook-lifecycle', (input) => { const hooks = JSON.parse(input.hookLifecycleJson); hooks[0].turn_id = 'wrong-child-turn'; input.hookLifecycleJson = JSON.stringify(hooks); }],
    ['continuation-hook-lifecycle', (input) => { const hooks = JSON.parse(input.hookLifecycleJson); input.hookLifecycleJson = JSON.stringify([hooks[1], hooks[0], hooks[2]]); }],
    ['continuation-anchor-invalid', (input) => { const jobs = rawJobs(input); delete jobs[0].zcodeSessionId; setRawJobs(input, jobs); }],
    ['continuation-anchor-invalid', (input) => { const jobs = rawJobs(input); jobs[0].status = 'cancelled'; setRawJobs(input, jobs); }],
  ];
  for (const [code, mutate] of mutations) {
    const input = preparedContinuationFixture('named'); mutate(input);
    await assert.rejects(
      qualifyCodexRescuePreparedContinuationEvidence(input),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === code,
      code,
    );
  }
});

test('raw prepared continuation keeps queued failed and cancelled current jobs reportable while requiring a resumable anchor', async () => {
  for (const status of ['queued', 'failed', 'cancelled']) {
    const input = preparedContinuationFixture('named'); const jobs = rawJobs(input); jobs[1].status = status; setRawJobs(input, jobs);
    assert.equal((await qualifyCodexRescuePreparedContinuationEvidence(input)).peerResumeChecked, true, status);
  }
  const missing = preparedContinuationFixture('named'); missing.bindingPartitionBytes = '';
  await assert.rejects(qualifyCodexRescuePreparedContinuationEvidence(missing),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'continuation-binding-invalid');
  const background = preparedContinuationFixture('generic', 'background'); const observer = JSON.parse(background.backgroundObserverJson); delete observer.executionCapability; background.backgroundObserverJson = JSON.stringify(observer);
  await assert.rejects(qualifyCodexRescuePreparedContinuationEvidence(background),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'continuation-background-evidence');
  const unrelated = preparedContinuationFixture('generic', 'background'); const unrelatedObserver = JSON.parse(unrelated.backgroundObserverJson); unrelatedObserver.jobId = 'f'.repeat(64); unrelated.backgroundObserverJson = JSON.stringify(unrelatedObserver);
  await assert.rejects(qualifyCodexRescuePreparedContinuationEvidence(unrelated),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'continuation-background-evidence');
});

test('exact bound stopped provenance survives thirty minutes while an unbound legacy executor cannot auto-latest', async () => {
  const bound = preparedContinuationFixture('named'); const executor = JSON.parse(bound.executorRecordBytes); executor.createdAt = '2026-08-01T00:00:00.000Z'; bound.executorRecordBytes = `${JSON.stringify(executor)}\n`;
  assert.equal((await qualifyCodexRescuePreparedContinuationEvidence(bound)).peerResumeChecked, true);
  const unbound = structuredClone(bound); unbound.bindingAuthorityBytes = ''; unbound.bindingPartitionBytes = '';
  await assert.rejects(qualifyCodexRescuePreparedContinuationEvidence(unbound),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'continuation-binding-invalid');
});

test('active v2 authority survives 24 hours while caller and preparation artifacts stay bounded', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'zcode-lifecycle-qualification-')); t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const identity = createIdentityStore({ dataRoot }); const prepared = createRescuePreparationStore({ dataRoot });
  const createdAt = new Date('2026-08-10T00:00:00.000Z');
  const callerToken = await identity.beginCallerTurn({ sessionId: parentId, turnId: 'turn-original', workspace: expectedWorkspace,
    permissionMode: 'acceptEdits', prompt: '$zcode:rescue repair fixture', now: createdAt });
  await prepared.save({ sessionId: parentId, turnId: 'turn-original', workspace: expectedWorkspace, permissionMode: 'acceptEdits',
    envelope: preparationEnvelope('explicit', 'fresh', 'foreground'), recordedPrompt: '$zcode:rescue repair fixture', now: createdAt });
  const after24Hours = new Date(createdAt.getTime() + 24 * 60 * 60_000);
  const active = await identity.resolveActiveTurn({ sessionId: parentId, workspace: expectedWorkspace, now: after24Hours });
  assert.equal(active.version, 2); assert.equal(active.kind, 'active-turn'); assert.equal(active.turnId, 'turn-original');
  await assert.rejects(identity.consumeCallerContext(callerToken, { workspace: expectedWorkspace, now: after24Hours }), { code: 'CALLER_CONTEXT_EXPIRED' });
  await assert.rejects(prepared.consume({ sessionId: parentId, turnId: 'turn-original', workspace: expectedWorkspace,
    permissionMode: 'acceptEdits', executorAgentId: childId, now: after24Hours }), { code: 'RESCUE_PREPARATION_EXPIRED' });
});

test('raw prepared continuation scans every declared public and host surface for derived private identifiers', async () => {
  const mutations = [
    (input, id) => { const rows = JSON.parse(input.parentRolloutJson); const call = rows.find((row) => row?.payload?.call_id === 'prepare-1'); const host = parseFixtureHostInput(call.payload.input); host.env.LEAK = id; call.payload.input = fixtureExecInput(host); input.parentRolloutJson = JSON.stringify(rows); },
    (input, id) => { const rows = JSON.parse(input.childRolloutJson); const output = rows.find((row) => row?.payload?.call_id === 'invoke-1' && row.payload.type === 'custom_tool_call_output'); const value = JSON.parse(output.payload.output[1].text); value.output += id; output.payload.output = capturedResult(value); input.childRolloutJson = JSON.stringify(rows); },
    (input, id) => { const rows = JSON.parse(input.childRolloutJson); rows.find((row) => row?.payload?.type === 'agent_message').payload.message = id; input.childRolloutJson = JSON.stringify(rows); },
    (input, id) => { const rows = JSON.parse(input.parentRolloutJson); const call = rows.find((row) => row?.payload?.call_id === 'followup-1'); const output = rows.find((row) => row?.payload?.type === 'function_call_output' && row.payload.call_id === 'followup-1'); call.payload.call_id = id; output.payload.call_id = id; input.parentRolloutJson = JSON.stringify(rows); },
    (input, id) => { const rows = JSON.parse(input.parentRolloutJson); rows.push({ type: 'event_msg', payload: { type: 'agent_message', message: `commentary ${id}` } }); input.parentRolloutJson = JSON.stringify(rows); },
    (input, id) => { const rows = JSON.parse(input.parentRolloutJson); rows.find((row) => row?.payload?.call_id === 'followup-1' && row.payload.type === 'function_call_output').payload.extra = id; input.parentRolloutJson = JSON.stringify(rows); },
    (input, id) => { const rows = JSON.parse(input.childRolloutJson); rows[0].payload.extra = id; input.childRolloutJson = JSON.stringify(rows); },
    (input, id) => { const frames = JSON.parse(input.execFramesJson); frames[1].item.extra = id; input.execFramesJson = JSON.stringify(frames); },
  ];
  for (const mutate of mutations) {
    const input = preparedContinuationFixture('named'); const privateId = JSON.parse(input.fakePeerJson)[1].params.sessionId;
    mutate(input, privateId);
    await assert.rejects(qualifyCodexRescuePreparedContinuationEvidence(input),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'continuation-private-leak');
  }
});

test('raw prepared continuation confines the serialized selector and child ID to authorized lifecycle boundaries', async () => {
  for (const leaked of [
    JSON.stringify({ continuationTarget: { childId, agentPath } }),
    childId,
  ]) {
    const input = preparedContinuationFixture('named'); const frames = JSON.parse(input.execFramesJson);
    frames[1].item.extra = leaked; input.execFramesJson = JSON.stringify(frames);
    await assert.rejects(qualifyCodexRescuePreparedContinuationEvidence(input),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'continuation-private-leak');
  }
});

test('raw prepared continuation treats display metadata as non-authoritative while binding remains mandatory', async () => {
  const renamed = preparedContinuationFixture('named');
  renamed.expected.agentPath = '/root/ordinary_helper';
  const parent = JSON.parse(renamed.parentRolloutJson); const child = JSON.parse(renamed.childRolloutJson);
  const spawn = parent.find((row) => row?.payload?.name === 'spawn_agent'); const args = JSON.parse(spawn.payload.arguments);
  args.task_name = 'ordinary_helper'; spawn.payload.arguments = JSON.stringify(args);
  for (const row of parent.filter((item) => item?.payload?.agent_path)) row.payload.agent_path = '/root/ordinary_helper';
  const resumeWrite = parent.find((row) => row?.payload?.call_id === 'prepare-write-2' && row.payload.type === 'custom_tool_call');
  const resumeHost = parseFixturePollInput(resumeWrite.payload.input); const resumeEnvelope = JSON.parse(resumeHost.chars.trim());
  resumeEnvelope.continuationTarget.agentPath = '/root/ordinary_helper'; resumeWrite.payload.input = structuredPoll(resumeHost.session_id, 'prepare-write-2', `${JSON.stringify(resumeEnvelope)}\n`).payload.input;
  const preparedOutput = parent.find((row) => row?.payload?.call_id === 'prepare-write-2' && row.payload.type === 'custom_tool_call_output');
  preparedOutput.payload.output = capturedResult({ output: preparedAck({ version: 2, action: 'followup', target: '/root/ordinary_helper', assignment: 'zcode-rescue' }), exit_code: 0 });
  parent.find((row) => row?.payload?.call_id === 'prepare-write-1' && row.payload.type === 'custom_tool_call_output').payload.output = capturedResult({ output: preparedAck({ version: 1, action: 'spawn', taskName: 'ordinary_helper' }), exit_code: 0 });
  const followup = parent.find((row) => row?.payload?.name === 'followup_task'); const followupArgs = JSON.parse(followup.payload.arguments); followupArgs.target = '/root/ordinary_helper'; followup.payload.arguments = JSON.stringify(followupArgs);
  parent.find((row) => row?.payload?.call_id === 'followup-1' && row.payload.type === 'function_call_output').payload.output = JSON.stringify({ accepted: true, target: '/root/ordinary_helper' });
  child[0].payload.source.subagent.thread_spawn.agent_path = '/root/ordinary_helper';
  const records = JSON.parse(renamed.preparationRecordBytesJson); const initial = JSON.parse(records[0]);
  initial.activation.taskName = 'ordinary_helper'; initial.activation.agentPathDigest = createHash('sha256').update('/root/ordinary_helper').digest('hex'); records[0] = `${JSON.stringify(initial)}\n`;
  const continuation = JSON.parse(records[1]); continuation.envelope = resumeEnvelope;
  continuation.activation.agentPathDigest = createHash('sha256').update('/root/ordinary_helper').digest('hex'); records[1] = `${JSON.stringify(continuation)}\n`; renamed.preparationRecordBytesJson = JSON.stringify(records);
  renamed.parentRolloutJson = JSON.stringify(parent); renamed.childRolloutJson = JSON.stringify(child);
  assert.equal((await qualifyCodexRescuePreparedContinuationEvidence(renamed)).agentPath, '/root/ordinary_helper');
  renamed.bindingPartitionBytes = '';
  await assert.rejects(qualifyCodexRescuePreparedContinuationEvidence(renamed),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'continuation-binding-invalid');
});

test('raw prepared continuation rejects metadata and job authority substitutions', async () => {
  const mutations = [
    ['continuation-parent-metadata', (input) => { const rows = JSON.parse(input.parentRolloutJson); rows[0].payload.source = 'subagent'; input.parentRolloutJson = JSON.stringify(rows); }],
    ['continuation-parent-metadata', (input) => { const rows = JSON.parse(input.parentRolloutJson); rows.shift(); input.parentRolloutJson = JSON.stringify(rows); }],
    ['continuation-spawn-contract', (input) => { const rows = JSON.parse(input.parentRolloutJson); const spawn = rows.find((row) => row?.payload?.name === 'spawn_agent'); const args = JSON.parse(spawn.payload.arguments); delete args.agent_type; spawn.payload.arguments = JSON.stringify(args); input.parentRolloutJson = JSON.stringify(rows); }],
    ['continuation-child-metadata', (input) => { const rows = JSON.parse(input.childRolloutJson); rows[0].payload.source.subagent.thread_spawn.agent_role = 'default'; input.childRolloutJson = JSON.stringify(rows); }],
    ['continuation-child-metadata', (input) => { const rows = JSON.parse(input.childRolloutJson); rows[0].payload.source.subagent.thread_spawn.agent_path = '/root/sibling'; input.childRolloutJson = JSON.stringify(rows); }],
    ['continuation-target-lifecycle', (input) => { const rows = JSON.parse(input.parentRolloutJson); rows.find((row) => row?.payload?.call_id === 'spawn-1' && row.payload.type === 'function_call_output').payload.output = JSON.stringify({ agent_id: 'sibling' }); input.parentRolloutJson = JSON.stringify(rows); }],
    ['continuation-followup-target', (input) => { const rows = JSON.parse(input.parentRolloutJson); rows.find((row) => row?.payload?.call_id === 'followup-1' && row.payload.type === 'function_call_output').payload.output = JSON.stringify({ accepted: false, target: agentPath }); input.parentRolloutJson = JSON.stringify(rows); }],
    ['continuation-job-record', (input) => { const jobs = rawJobs(input); jobs[0].ownerSessionId = 'foreign'; setRawJobs(input, jobs); }],
    ['continuation-job-record', (input) => { const jobs = rawJobs(input); jobs[0].ownerTurnId = 'foreign-turn'; setRawJobs(input, jobs); }],
    ['continuation-job-record', (input) => { const jobs = rawJobs(input); jobs[0].createdAt = 'not-a-date'; setRawJobs(input, jobs); }],
  ];
  for (const [code, mutate] of mutations) {
    const input = preparedContinuationFixture('named'); mutate(input);
    await assert.rejects(qualifyCodexRescuePreparedContinuationEvidence(input),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === code, code);
  }
  const generic = preparedContinuationFixture('generic'); const genericRows = JSON.parse(generic.parentRolloutJson); const genericSpawn = genericRows.find((row) => row?.payload?.name === 'spawn_agent'); const genericArgs = JSON.parse(genericSpawn.payload.arguments); genericArgs.agent_type = 'zcode-rescue'; genericSpawn.payload.arguments = JSON.stringify(genericArgs); generic.parentRolloutJson = JSON.stringify(genericRows);
  await assert.rejects(qualifyCodexRescuePreparedContinuationEvidence(generic),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'continuation-spawn-contract');
});

test('raw prepared continuation requires both exact TTY preparation handshakes and consumed records', async () => {
  const missing = preparedContinuationFixture('named'); delete missing.preparationRecordBytesJson;
  await assert.rejects(qualifyCodexRescuePreparedContinuationEvidence(missing),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'continuation-preparation-records');
  const badWrite = preparedContinuationFixture('named'); const rows = JSON.parse(badWrite.parentRolloutJson);
  const write = rows.find((row) => row?.payload?.call_id === 'prepare-write-2'); write.payload.input = structuredPoll(72, 'prepare-write-2', `${JSON.stringify({ version: 1, source: 'proactive', task: 'continue', options: { execution: 'foreground', resume: 'fresh' } })}\n`).payload.input;
  badWrite.parentRolloutJson = JSON.stringify(rows);
  await assert.rejects(qualifyCodexRescuePreparedContinuationEvidence(badWrite),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'continuation-preparation-route');
  const duplicate = preparedContinuationFixture('named'); const duplicateRows = JSON.parse(duplicate.parentRolloutJson); const duplicateWrite = duplicateRows.find((row) => row?.payload?.call_id === 'prepare-write-1'); const valid = JSON.stringify(preparationEnvelope('explicit', 'fresh', 'foreground')); duplicateWrite.payload.input = structuredPoll(71, 'prepare-write-1', `${valid.slice(0, -1)},"source":"explicit"}\n`).payload.input; duplicate.parentRolloutJson = JSON.stringify(duplicateRows);
  await assert.rejects(qualifyCodexRescuePreparedContinuationEvidence(duplicate),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'continuation-preparation-route');
});

test('raw prepared continuation accounts for every event and preserves captured order', async () => {
  const mutations = [
    ['continuation-call-linkage', (input) => { const rows = JSON.parse(input.parentRolloutJson); rows.push({ type: 'response_item', turn_id: 'turn-fresh', payload: { type: 'function_call_output', call_id: 'orphan', output: '{}' } }); input.parentRolloutJson = JSON.stringify(rows); }],
    ['continuation-call-linkage', (input) => { const rows = JSON.parse(input.childRolloutJson); rows.find((row) => row?.payload?.call_id === 'invoke-1').type = 'event_msg'; input.childRolloutJson = JSON.stringify(rows); }],
    ['continuation-parent-events', (input) => { const rows = JSON.parse(input.parentRolloutJson); rows.push({ type: 'response_item', turn_id: 'turn-fresh', payload: { type: 'function_call', name: 'wait_agent', call_id: 'sibling-call', arguments: '{}' } }, { type: 'response_item', turn_id: 'turn-fresh', payload: { type: 'function_call_output', call_id: 'sibling-call', output: '{}' } }); input.parentRolloutJson = JSON.stringify(rows); }],
    ['continuation-job-identity', (input) => { const jobs = rawJobs(input); jobs.push(rawJob('f'.repeat(64), 'foreign-turn', 'failed')); setRawJobs(input, jobs); }],
    ['continuation-peer-method', (input) => { const rows = JSON.parse(input.fakePeerJson); rows.push({ method: 'session/list', result: [] }); input.fakePeerJson = JSON.stringify(rows); }],
    ['continuation-peer-method', (input) => { const rows = JSON.parse(input.fakePeerJson); rows[0].error = { code: -1 }; input.fakePeerJson = JSON.stringify(rows); }],
    ['continuation-event-order', (input) => { const rows = JSON.parse(input.parentRolloutJson); const start = rows.findIndex((row) => row?.payload?.kind === 'started'); const stop = rows.findIndex((row) => row?.payload?.kind === 'stopped'); [rows[start], rows[stop]] = [rows[stop], rows[start]]; input.parentRolloutJson = JSON.stringify(rows); }],
    ['continuation-child-order', (input) => { const rows = JSON.parse(input.childRolloutJson); rows[1].timestamp = '2026-08-10T00:00:11.500Z'; input.childRolloutJson = JSON.stringify(rows); }],
  ];
  for (const [code, mutate] of mutations) { const input = preparedContinuationFixture('named'); mutate(input);
    await assert.rejects(qualifyCodexRescuePreparedContinuationEvidence(input),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === code, code); }
});

test('qualifies named Rescue from linked parent and child rollout metadata', () => {
  const evidence = qualifyCodexRescueEvidence(fixture(), options());
  assert.deepEqual(evidence, {
    parentThreadId: parentId,
    childThreadId: childId,
    agentPath,
    taskName,
    agentType: 'zcode-rescue',
    route: 'named',
    publicOutput: expectedPublicOutput,
    semanticProgressChecked: true,
  });
});

test('trusted named Rescue identity does not depend on display-name conformance', () => {
  const input = fixture();
  setPresentation(input, 'ordinary_child', '/root/ordinary_child');
  const evidence = qualifyCodexRescueEvidence(input, options());
  assert.equal(evidence.taskName, 'ordinary_child');
  assert.equal(evidence.agentPath, '/root/ordinary_child');
  assert.throws(
    () => assertCodexRescueDisplayName(evidence),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'display-task-name-contract',
  );
});

test('matching Rescue presentation is not sufficient named Role evidence', () => {
  const input = fixture();
  childMeta(input).payload.source.subagent.thread_spawn.agent_role = 'default';
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options()),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'agent-role-mismatch',
  );
});

test('valid dynamic Rescue evidence has a conforming display name', () => {
  const evidence = qualifyCodexRescueEvidence(fixture(), options());
  assert.deepEqual(assertCodexRescueDisplayName(evidence), { taskName, agentPath, displayNameConforms: true });
});

test('identity accepts a consistently observed opaque host path before display assertion rejects it', () => {
  const input = fixture();
  setPresentation(input, taskName, '/root/host_selected_label');
  const evidence = qualifyCodexRescueEvidence(input, options());
  assert.equal(evidence.agentPath, '/root/host_selected_label');
  assert.throws(
    () => assertCodexRescueDisplayName(evidence),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'display-agent-path-contract',
  );
});

test('display-name grammar accepts one to three semantic words and supported ordinals', () => {
  const sixtyFourByteTaskName = `zcode_rescue_${'a'.repeat(16)}_${'b'.repeat(16)}_${'c'.repeat(14)}_10`;
  assert.equal(Buffer.byteLength(sixtyFourByteTaskName, 'utf8'), 64);
  for (const validTaskName of [
    'zcode_rescue_task',
    'zcode_rescue_fix_progress',
    'zcode_rescue_fix_progress_now',
    'zcode_rescue_task_2',
    'zcode_rescue_fix_progress_9999',
    sixtyFourByteTaskName,
  ]) {
    assert.deepEqual(assertCodexRescueDisplayName({ taskName: validTaskName, agentPath: `/root/${validTaskName}` }), {
      taskName: validTaskName,
      agentPath: `/root/${validTaskName}`,
      displayNameConforms: true,
    }, validTaskName);
  }
});

test('display-name grammar rejects invalid syntax, word count, byte length, and ordinals', () => {
  const sixtyFiveByteTaskName = `zcode_rescue_${'a'.repeat(16)}_${'b'.repeat(16)}_${'c'.repeat(16)}_2`;
  assert.equal(Buffer.byteLength(sixtyFiveByteTaskName, 'utf8'), 65);
  for (const invalidTaskName of [
    'zcode_rescue_bad-name',
    'zcode_rescue_one_two_three_four',
    sixtyFiveByteTaskName,
    'zcode_rescue_task_01',
    'zcode_rescue_task_1',
  ]) {
    assert.throws(
      () => assertCodexRescueDisplayName({ taskName: invalidTaskName, agentPath: `/root/${invalidTaskName}` }),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'display-task-name-contract',
      invalidTaskName,
    );
  }
});

test('presentation updates only the linked child records and matching registry entry', () => {
  const input = timeoutFixture();
  const siblingPath = '/root/unrelated_sibling';
  const siblingEnvelope = `Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${siblingPath}\nPayload:\nsibling`;
  const siblingReturn = { type: 'response_item', payload: { type: 'agent_message', author: siblingPath, recipient: '/root', content: [{ type: 'input_text', text: siblingEnvelope }] } };
  input.rollouts[0].push(siblingReturn);
  const stateOutput = waitResult(input, 'list-after-timeout');
  const state = JSON.parse(stateOutput.payload.output);
  state.agents.push({ agent_name: siblingPath, agent_status: 'running' });
  stateOutput.payload.output = JSON.stringify(state);

  setPresentation(input, 'ordinary_child', '/root/ordinary_child');

  assert.equal(siblingReturn.payload.author, siblingPath);
  assert.equal(siblingReturn.payload.content[0].text, siblingEnvelope);
  assert.deepEqual(JSON.parse(stateOutput.payload.output).agents, [
    { agent_name: '/root/ordinary_child', agent_status: 'running' },
    { agent_name: siblingPath, agent_status: 'running' },
  ]);
  input.rollouts[0].pop();
  const linkedOnlyState = JSON.parse(stateOutput.payload.output);
  linkedOnlyState.agents.pop();
  stateOutput.payload.output = JSON.stringify(linkedOnlyState);
  assert.equal(qualifyCodexRescueChoiceEvidence(input, choiceOptions('resume')).taskName, 'ordinary_child');
});

test('background Rescue identity accepts nonconforming presentation and rejects only broken route linkage', () => {
  const input = backgroundFixture();
  setPresentation(input, 'ordinary_child', '/root/ordinary_child');
  const evidence = qualifyCodexRescueBackgroundEvidence(input, backgroundOptions());
  assert.equal(evidence.taskName, 'ordinary_child');
  assert.equal(evidence.agentPath, '/root/ordinary_child');
  assert.throws(
    () => assertCodexRescueDisplayName(evidence),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'display-task-name-contract',
  );

  const mismatched = backgroundFixture();
  setPresentation(mismatched, 'ordinary_child', '/root/ordinary_child');
  childMeta(mismatched).payload.source.subagent.thread_spawn.agent_path = agentPath;
  assert.throws(
    () => qualifyCodexRescueBackgroundEvidence(mismatched, backgroundOptions()),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'child-link-mismatch',
  );
});

test('choice Rescue identity accepts nonconforming presentation and rejects only broken route linkage', () => {
  const input = choiceFixture('resume');
  setPresentation(input, 'ordinary_child', '/root/ordinary_child');
  const evidence = qualifyCodexRescueChoiceEvidence(input, choiceOptions('resume'));
  assert.equal(evidence.taskName, 'ordinary_child');
  assert.equal(evidence.agentPath, '/root/ordinary_child');
  assert.throws(
    () => assertCodexRescueDisplayName(evidence),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'display-task-name-contract',
  );

  const mismatched = choiceFixture('resume');
  setPresentation(mismatched, 'ordinary_child', '/root/ordinary_child');
  childMeta(mismatched).payload.source.subagent.thread_spawn.agent_path = agentPath;
  assert.throws(
    () => qualifyCodexRescueChoiceEvidence(mismatched, choiceOptions('resume')),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'choice-child-link',
  );
});

test('qualifies named and generic Rescue only after the original yielded execution exits', () => {
  for (const route of ['named', 'generic']) {
    const input = yieldedFixture();
    if (route === 'generic') {
      const args = JSON.parse(spawnEvent(input).payload.arguments); delete args.agent_type; args.message = 'fixed generic forwarder';
      spawnEvent(input).payload.arguments = JSON.stringify(args);
      childMeta(input).payload.source.subagent.thread_spawn.agent_role = null;
    }
    assert.equal(qualifyCodexRescueEvidence(input, options()).route, route === 'named' ? 'named' : 'generic-schema-hidden');
  }
});

test('required yielded qualification exposes only non-sensitive execution facts', () => {
  const input = yieldedFixture(); setYieldedHandle(input, 987654321);
  const evidence = qualifyCodexRescueEvidence(input, options({ requireYieldedExecution: true }));
  assert.deepEqual(evidence.yieldedExecution, {
    execCommandCount: 1,
    pollCount: 2,
    sameHandleChecked: true,
    terminalExitCode: 0,
  });
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes('987654321'), false);
  assert.equal(serialized.includes('qualification-capability-sentinel-private'), false);

  const encrypted = yieldedFixture();
  setYieldedHandle(encrypted, 987654321);
  const args = JSON.parse(spawnEvent(encrypted).payload.arguments); args.message = `gAAAA${'A'.repeat(64)}`; spawnEvent(encrypted).payload.arguments = JSON.stringify(args);
  assert.throws(
    () => qualifyCodexRescueEvidence(encrypted, options({ requireYieldedExecution: true })),
    (error) => error instanceof CodexRescueUnqualifiedError
      && !JSON.stringify(error.evidence).includes('987654321')
      && !JSON.stringify(error.evidence).includes('qualification-capability-sentinel-private'),
  );
});

test('qualifies validated preterminal Rescue relays and an observational bound status sidecar', () => {
  const input = relayedYieldedFixture({ withStatus: true });
  const evidence = qualifyCodexRescueEvidence(input, options({
    requireYieldedExecution: true,
    requireProgressRelay: true,
    requireStatusSidecar: true,
    expectedStatusCommand,
  }));
  assert.equal(evidence.progressRelayChecked, true);
  assert.equal(evidence.statusSidecarChecked, true);
  assert.equal(evidence.yieldedExecution.sameHandleChecked, true);
  assert.equal(evidence.yieldedExecution.terminalExitCode, 0);
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE|\/repo|invoke-status|session_id/);
});

test('Rescue relay qualification rejects untrusted routing, content, ordering, and terminal substitution', () => {
  const cases = [
    { code: 'progress-relay-target', mutate: ({ child }) => { relayCalls(child)[0].payload.arguments = JSON.stringify({ target: '/root/sibling', message: relayMessage('started') }); } },
    { code: 'progress-relay-content', mutate: ({ child }) => { relayCalls(child)[0].payload.arguments = JSON.stringify({ target: '/root', message: 'PRIVATE raw stderr' }); } },
    { code: 'progress-relay-sequence', mutate: ({ child }) => { setCapturedOutput(child, 'poll-1', `${relayLine(1, 'investigating', 'tool-active')}\n`, 41); } },
    { code: 'progress-relay-order', mutate: ({ child }) => { const relay = relayCalls(child)[0]; child.splice(child.indexOf(relay), 1); child.splice(1, 0, relay); } },
    { code: 'progress-relay-after-terminal', mutate: ({ child }) => { const relay = relayCalls(child).at(-1); const output = relayOutputs(child).at(-1); child.splice(child.indexOf(relay), 1); child.splice(child.indexOf(output), 1); child.splice(-1, 0, relay, output); } },
    { code: 'progress-relay-author', mutate: ({ parent }) => { parentRelayMessages(parent)[0].payload.author = '/root/sibling'; } },
    { code: 'progress-relay-envelope', mutate: ({ parent }) => { parentRelayMessages(parent)[0].payload.content[0].text = parentRelayMessages(parent)[0].payload.content[0].text.replace('Task name: /root\n', 'Task name: /root/sibling\n'); } },
    { code: 'progress-relay-encrypted', mutate: ({ parent }) => { parentRelayMessages(parent)[0].payload.content.pop(); } },
    { code: 'progress-relay-encrypted', mutate: ({ parent }) => { parentRelayMessages(parent)[0].payload.content[1].encrypted_content = 'short'; } },
    { code: 'progress-relay-parent-content', mutate: ({ parent }) => { parentRelayMessages(parent)[0].payload.content.push({ type: 'input_text', text: 'PRIVATE extra plaintext' }); } },
    { code: 'progress-relay-call-id', mutate: ({ child }) => { relayOutputs(child)[0].payload.type = 'custom_tool_call_output'; } },
    { code: 'progress-relay-call-id', mutate: ({ child }) => { child.splice(child.indexOf(relayCalls(child)[0]), 1); } },
    { code: 'progress-relay-call-id', mutate: ({ parent }) => { const messages = parentRelayMessages(parent); messages[1].payload.id = messages[0].payload.id; } },
    { code: 'progress-relay-turn-association', mutate: ({ parent }) => { parentRelayMessages(parent)[1].payload.internal_chat_message_metadata_passthrough.turn_id = relayTurnId('b'); } },
    { code: 'progress-relay-turn-association', mutate: ({ parent }) => { parentRelayMessages(parent)[0].payload.internal_chat_message_metadata_passthrough.turn_id = 'malformed'; } },
    { code: 'progress-relay-output', mutate: ({ child }) => { relayOutputs(child)[0].payload.output = 'not empty'; } },
    { code: 'progress-relay-call-id', mutate: ({ child }) => { const call = relayCalls(child)[0]; const output = relayOutputs(child)[0]; call.payload.call_id = 'poll-1'; output.payload.call_id = 'poll-1'; } },
    { code: 'progress-relay-parent-wait', mutate: ({ parent }) => { const call = parent.find((event) => event?.payload?.name === 'wait_agent' && event.payload.call_id === 'relay-wait-1'); const output = parent.find((event) => event?.payload?.type === 'function_call_output' && event.payload.call_id === 'relay-wait-1'); parent.splice(parent.indexOf(call), 1); parent.splice(parent.indexOf(output), 1); } },
    { code: 'public-output-mismatch', mutate: ({ child }) => { child.find((event) => event?.payload?.phase === 'final_answer').payload.message = JSON.stringify({ type: 'bound-status', status: 'running' }); } },
  ];
  for (const { code, mutate } of cases) {
    const input = relayedYieldedFixture(); mutate({ child: input.rollouts[1], parent: input.rollouts[0] });
    assert.throws(
      () => qualifyCodexRescueEvidence(input, options({ requireYieldedExecution: true, requireProgressRelay: true })),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === code,
      code,
    );
  }
});

test('Rescue bound status qualification rejects arguments, sibling ownership, and handle substitution', () => {
  const cases = [
    { code: 'status-sidecar-command', mutate: (child) => { statusCall(child).payload.input = structuredExecResult(`${expectedStatusCommand} extra`, 'status-1').payload.input; } },
    { code: 'status-sidecar-call-id', mutate: (child) => { statusCall(child).payload.call_id = 'poll-1'; } },
    { code: 'status-sidecar-order', mutate: (child) => { const call = statusCall(child); const output = statusOutput(child); child.splice(child.indexOf(call), 1); child.splice(child.indexOf(output), 1); child.splice(1, 0, call, output); } },
    { code: 'status-sidecar-output', mutate: (child) => { statusOutput(child).payload.output = capturedResult({ output: `${expectedPublicOutput}\n`, exit_code: 0 }); } },
    { code: 'status-sidecar-output', mutate: (child) => mutateStatusSnapshot(child, (value) => { value.status = 'unknown'; }) },
    { code: 'status-sidecar-output', mutate: (child) => mutateStatusSnapshot(child, (value) => { value.phase = 'editing'; }) },
    { code: 'status-sidecar-output', mutate: (child) => mutateStatusSnapshot(child, (value) => { value.status = 'succeeded'; value.terminal = false; }) },
    { code: 'status-sidecar-output', mutate: (child) => mutateStatusSnapshot(child, (value) => { value.progressPreview = ['1', '2', '3', '4', '5']; }) },
    { code: 'status-sidecar-output', mutate: (child) => mutateStatusSnapshot(child, (value) => { value.progressPreview = ['PRIVATE raw status']; }) },
    { code: 'status-sidecar-output', mutate: (child) => mutateStatusSnapshot(child, (value) => { value.progressPreview = ['bad\ncontrol']; }) },
    { code: 'status-sidecar-output', mutate: (child) => mutateStatusSnapshot(child, (value) => { value.progressPreview = ['x'.repeat(257)]; }) },
  ];
  for (const { code, mutate } of cases) {
    const input = relayedYieldedFixture({ withStatus: true }); mutate(input.rollouts[1]);
    assert.throws(
      () => qualifyCodexRescueEvidence(input, options({ requireYieldedExecution: true, requireProgressRelay: true, requireStatusSidecar: true, expectedStatusCommand })),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === code,
      code,
    );
  }
});

test('yielded Rescue qualification rejects process replacement, handle drift, input, missing exit, and terminal-order violations', () => {
  const cases = [
    { code: 'child-command-count', mutate: (input) => input.rollouts[1].splice(3, 0, structuredExecResult(expectedCommand, 'exec-2'), capturedResultEvent('exec-2', { output: '', session_id: 42 })) },
    { code: 'child-handle-mismatch', mutate: (input) => { childPolls(input)[0].payload.input = structuredPoll(42, 'poll-1', '').payload.input; } },
    { code: 'child-poll-input', mutate: (input) => { childPolls(input)[0].payload.input = structuredPoll(41, 'poll-1', 'x').payload.input; } },
    { code: 'child-terminal-exit-missing', mutate: (input) => { childPollOutputs(input).at(-1).payload.output = capturedResult({ output: `${expectedPublicOutput}\n`, session_id: 41 }); } },
    { code: 'child-terminal-order', mutate: (input) => { const final = input.rollouts[1].pop(); input.rollouts[1].splice(4, 0, final); } },
    { code: 'parent-terminal-order', mutate: (input) => { const final = input.rollouts[0].pop(); input.rollouts[0].splice(5, 0, final); } },
    { code: 'child-poll-after-terminal', mutate: (input) => input.rollouts[1].splice(-1, 0, structuredPoll(41, 'poll-3'), capturedResultEvent('poll-3', { output: '', exit_code: 0 })) },
  ];
  for (const { code, mutate } of cases) {
    const input = yieldedFixture(); mutate(input);
    assert.throws(
      () => qualifyCodexRescueEvidence(input, options()),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === code,
      code,
    );
  }
});

test('foreground structured execution requires an exact zero exit code', () => {
  for (const exitCode of [1, 130]) {
    const input = yieldedFixture(); childPollOutputs(input).at(-1).payload.output = capturedResult({ output: `${expectedSemanticProgress.terminal}\n${expectedPublicOutput}\n`, exit_code: exitCode });
    assert.throws(() => qualifyCodexRescueEvidence(input, options()), (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'child-terminal-exit-invalid', String(exitCode));
  }
});

test('child host evidence requires exact exec tool names and one-to-one unique call IDs', () => {
  const cases = [
    { code: 'child-tool-name', mutate: (input) => { childExec(input).payload.name = 'other'; } },
    { code: 'child-call-id', mutate: (input) => { delete childExec(input).payload.call_id; } },
    { code: 'child-call-id', mutate: (input) => { childPolls(input)[1].payload.call_id = 'poll-1'; } },
    { code: 'child-call-id', mutate: (input) => { delete childPollOutputs(input)[0].payload.call_id; } },
    { code: 'child-call-id', mutate: (input) => { childPollOutputs(input)[1].payload.call_id = 'poll-1'; } },
    { code: 'child-call-id', mutate: (input) => { childPollOutputs(input)[1].payload.call_id = 'orphan-output'; } },
  ];
  for (const { code, mutate } of cases) {
    const input = yieldedFixture(); mutate(input);
    assert.throws(() => qualifyCodexRescueEvidence(input, options()), (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === code, code);
  }
});

test('forwarder child rollout rejects every unaccounted response and non-allowlisted function call', () => {
  const cases = [
    (input) => input.rollouts[1].splice(-1, 0, { type: 'response_item', payload: { type: 'reasoning', summary: 'unaccounted' } }),
    (input) => input.rollouts[1].splice(-1, 0, { type: 'response_item', payload: { type: 'function_call', name: 'web_search', call_id: 'unknown-child-call', arguments: '{}' } }),
  ];
  for (const mutate of cases) {
    const input = fixture(); mutate(input);
    assert.throws(
      () => qualifyCodexRescueEvidence(input, options()),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'child-event-accounting',
    );
  }
});

test('forwarder child rejects function-call exec shapes even beside one valid custom exec', () => {
  for (const name of ['exec', 'exec_command']) {
    const input = fixture();
    input.rollouts[1].splice(-1, 0, {
      type: 'response_item', payload: { type: 'function_call', name, call_id: `extra-${name}`, arguments: JSON.stringify({ cmd: expectedCommand }) },
    });
    assert.throws(
      () => qualifyCodexRescueEvidence(input, options()),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'child-command-shape-mismatch',
      name,
    );
  }
});

test('foreground qualification fails closed unless child transcript contains exact semantic start and terminal progress', () => {
  for (const missing of ['start', 'terminal']) {
    const input = fixture();
    childOutput(input).payload.output[1].text = childOutput(input).payload.output[1].text
      .split('\n').filter((line) => line !== expectedSemanticProgress[missing]).join('\n');
    assert.throws(
      () => qualifyCodexRescueEvidence(input, options()),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'semantic-progress-missing',
      missing,
    );
  }
});

test('foreground qualification accepts either exact compatibility diagnostic while retaining yielded child exit proof', () => {
  for (const diagnostic of ['snapshotFallback', 'lifecycleOnly']) {
    const input = yieldedFixture();
    childPollOutputs(input).at(-1).payload.output = capturedResult({
      output: `${expectedSemanticProgress[diagnostic]}\n${expectedPublicOutput}\n`, exit_code: 0,
    });
    const evidence = qualifyCodexRescueEvidence(input, options({ requireYieldedExecution: true }));
    assert.equal(evidence.semanticProgressChecked, true, diagnostic);
    assert.equal(evidence.yieldedExecution.terminalExitCode, 0, diagnostic);
  }

  const startupOnly = yieldedFixture();
  childPollOutputs(startupOnly).at(-1).payload.output = capturedResult({ output: `[zcode] ZCode started the delegated turn.\n${expectedPublicOutput}\n`, exit_code: 0 });
  assert.throws(
    () => qualifyCodexRescueEvidence(startupOnly, options({ requireYieldedExecution: true })),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'semantic-progress-missing',
  );
});

test('qualifies named and generic background Rescue with one linked queued output and no capability leak', () => {
  const named = backgroundFixture();
  assert.deepEqual(qualifyCodexRescueBackgroundEvidence(named, backgroundOptions()), {
    parentThreadId: parentId, childThreadId: childId, agentPath, taskName, agentType: 'zcode-rescue', route: 'named',
    publicOutput: backgroundPublicOutput, jobId: backgroundJobId, capabilityChecked: true,
  });
  const generic = backgroundFixture(); const args = JSON.parse(spawnEvent(generic).payload.arguments); delete args.agent_type; args.message = 'fixed generic forwarder'; spawnEvent(generic).payload.arguments = JSON.stringify(args); childMeta(generic).payload.source.subagent.thread_spawn.agent_role = null;
  assert.equal(qualifyCodexRescueBackgroundEvidence(generic, backgroundOptions()).route, 'generic-schema-hidden');
});

test('background qualification fails closed without private production capability evidence', () => {
  assert.throws(
    () => qualifyCodexRescueBackgroundEvidence(backgroundFixture(), backgroundOptions({ privateExecutionCapability: undefined })),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'background-capability-evidence',
  );
});

test('background qualification fails closed on inline, self-printed, wrong-child, duplicate, unlinked, and token-leak evidence', () => {
  const cases = [
    { code: 'parent-inline-command', mutate: (input) => input.rollouts[0].splice(3, 0, structuredExec(expectedCommand, 'parent-inline')) },
    { code: 'parent-terminal-order', mutate: (input) => { input.rollouts[0] = input.rollouts[0].filter((event) => event !== childReturnEvent(input)); } },
    { code: 'background-child-stdout', mutate: (input) => { childOutput(input).payload.output = toolOutput('exec-1', `self-printed\n${backgroundPublicOutput}\n`).payload.output; } },
    { code: 'background-child-stdout', mutate: (input) => { childOutput(input).payload.output.unshift({ type: 'input_text', text: 'private prelude\n' }); } },
    { code: 'background-child-stdout', mutate: (input) => { childOutput(input).payload.output.unshift({ type: 'input_text', text: 'noisy progress\n' }); } },
    { code: 'child-rollout-id-mismatch', mutate: (input) => { startEvent(input).payload.agent_thread_id = 'wrong-child'; } },
    { code: 'spawn-count', mutate: (input) => input.rollouts[0].splice(4, 0, structuredSpawn('spawn-2')) },
    { code: 'child-call-id', mutate: (input) => { childOutput(input).payload.call_id = 'unlinked-output'; } },
    { code: 'background-capability-leak', mutate: (input) => { const args = JSON.parse(spawnEvent(input).payload.arguments); args.message = `${args.message} ${executionCapability}`; spawnEvent(input).payload.arguments = JSON.stringify(args); } },
    { code: 'background-capability-leak', mutate: (input) => { input.rollouts[0].splice(-1, 0, { type: 'event_msg', payload: { type: 'agent_message', message: executionCapability, phase: 'commentary' } }); } },
    { code: 'background-capability-leak', mutate: (input) => { childOutput(input).payload.output[0].text += executionCapability; } },
    { code: 'background-capability-leak', mutate: (input) => { input.execFrames.splice(2, 0, execAgentMessage(executionCapability, 'leak')); } },
  ];
  for (const { code, mutate } of cases) {
    const input = backgroundFixture(); mutate(input);
    assert.throws(() => qualifyCodexRescueBackgroundEvidence(input, backgroundOptions()), (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === code, code);
  }
});

test('background qualification checks all core evidence before treating only spawn ciphertext as unqualified', () => {
  const encrypted = backgroundFixture(); const args = JSON.parse(spawnEvent(encrypted).payload.arguments); args.message = `gAAAA${'A'.repeat(64)}`; spawnEvent(encrypted).payload.arguments = JSON.stringify(args);
  assert.throws(() => qualifyCodexRescueBackgroundEvidence(encrypted, backgroundOptions()), (error) => error instanceof CodexRescueUnqualifiedError && error.code === 'spawn-message-encrypted');
  startEvent(encrypted).payload.agent_thread_id = 'wrong-child';
  assert.throws(() => qualifyCodexRescueBackgroundEvidence(encrypted, backgroundOptions()), (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'child-rollout-id-mismatch');
  const badStdout = backgroundFixture(); const badArgs = JSON.parse(spawnEvent(badStdout).payload.arguments); badArgs.message = `gAAAA${'A'.repeat(64)}`; spawnEvent(badStdout).payload.arguments = JSON.stringify(badArgs); childOutput(badStdout).payload.output = toolOutput('exec-1', `self-printed\n${backgroundPublicOutput}\n`).payload.output;
  assert.throws(() => qualifyCodexRescueBackgroundEvidence(badStdout, backgroundOptions()), (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'background-child-stdout');
});

test('background qualification rejects a production-minted capability across every visible evidence surface', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-background-qualification-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const token = await createIdentityStore({ dataRoot: join(directory, 'data') }).createExecutionCapability({
    jobId: backgroundJobId, ownerSessionId: 'qualification-owner', workspace: directory, operation: 'run-reserved-job', jobSpecFormat: 'sealed-v2', permissionSnapshot: { permissionMode: 'workspace-write' },
  });
  assert.equal(qualifyCodexRescueBackgroundEvidence(backgroundFixture(), backgroundOptions({ privateExecutionCapability: token })).capabilityChecked, true);
  const cases = [
    { mutate: (input) => { const args = JSON.parse(spawnEvent(input).payload.arguments); args.message += token; spawnEvent(input).payload.arguments = JSON.stringify(args); }, options: {} },
    { mutate: (input) => { childOutput(input).payload.output[0].text += token; }, options: {} },
    { mutate: (input) => { input.execFrames.splice(2, 0, execAgentMessage(token, 'production-token-leak')); }, options: {} },
    { mutate: () => {}, options: { publicLogs: [`public log ${token}`] } },
  ];
  for (const { mutate, options: overrides } of cases) {
    const input = backgroundFixture(); mutate(input);
    assert.throws(() => qualifyCodexRescueBackgroundEvidence(input, backgroundOptions({ privateExecutionCapability: token, ...overrides })), (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'background-capability-leak');
  }
});

test('qualifies exact resume against one existing child ID and rejects same-child fresh', () => {
  assert.deepEqual(qualifyCodexRescueChoiceEvidence(choiceFixture('resume'), choiceOptions('resume')), {
    parentThreadId: parentId, childThreadId: childId, agentPath, taskName, choice: 'resume',
  });
  assert.throws(() => qualifyCodexRescueChoiceEvidence(choiceFixture('fresh'), choiceOptions('fresh')),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'choice-fresh-requires-parent-replan');
});

test('choice qualification permits yielded polling in the initial turn, continuation turn, or both', () => {
  for (const turns of [['initial'], ['continuation'], ['initial', 'continuation']]) {
    const input = choiceFixture('resume');
    for (const turn of turns) yieldChoiceTurn(input, turn);
    retimestampChoice(input);
    assert.equal(qualifyCodexRescueChoiceEvidence(input, choiceOptions('resume')).choice, 'resume', turns.join('+'));
  }
});

test('choice qualification validates relay and optional status within both original-handle segments', () => {
  const input = relayedChoiceFixture({ withStatus: true });
  const evidence = qualifyCodexRescueChoiceEvidence(input, choiceOptions('resume', {
    requireProgressRelay: true,
    requireStatusSidecar: true,
    expectedStatusCommand,
    includeExecutionFacts: true,
  }));
  assert.equal(evidence.progressRelayChecked, true);
  assert.equal(evidence.statusSidecarChecked, true);
  assert.deepEqual(evidence.executions, {
    initial: { execCommandCount: 1 }, continuation: { execCommandCount: 1 },
  });
});

test('choice qualification rejects relay/status ownership drift across logical segments before encrypted unqualification', () => {
  const cases = [
    { code: 'choice-initial-progress-relay-target', mutate: (input) => { relayCalls(input.rollouts[1])[0].payload.arguments = JSON.stringify({ target: '/root/sibling', message: relayMessage('started') }); } },
    { code: 'choice-continuation-progress-relay-call-id', mutate: (input) => { const calls = relayCalls(input.rollouts[1]); const outputs = relayOutputs(input.rollouts[1]); calls[1].payload.call_id = calls[0].payload.call_id; outputs[1].payload.call_id = calls[0].payload.call_id; } },
    { code: 'choice-initial-status-sidecar-command', mutate: (input) => { statusCall(input.rollouts[1]).payload.input = structuredExecResult(`${expectedStatusCommand} --all`, 'status-1').payload.input; } },
    { code: 'choice-continuation-progress-relay-call-id', mutate: (input) => { relayOutputs(input.rollouts[1])[1].payload.type = 'custom_tool_call_output'; } },
    { code: 'choice-initial-progress-relay-call-id', mutate: (input) => { const child = input.rollouts[1]; child.splice(child.indexOf(relayCalls(child)[0]), 1); } },
    { code: 'choice-continuation-progress-relay-call-id', mutate: (input) => { const messages = parentRelayMessages(input.rollouts[0]); messages[1].payload.id = messages[0].payload.id; messages[1].payload.internal_chat_message_metadata_passthrough.turn_id = messages[0].payload.internal_chat_message_metadata_passthrough.turn_id; } },
    { code: 'choice-continuation-progress-relay-turn-association', mutate: (input) => { const messages = parentRelayMessages(input.rollouts[0]); messages[1].payload.internal_chat_message_metadata_passthrough.turn_id = messages[0].payload.internal_chat_message_metadata_passthrough.turn_id; } },
    { code: 'choice-child-execution-boundary', mutate: (input) => { const child = input.rollouts[1]; const relay = relayCalls(child)[0]; const output = relayOutputs(child)[0]; child.splice(child.indexOf(relay), 1); child.splice(child.indexOf(output), 1); child.splice(child.indexOf(child.filter((event) => event?.payload?.phase === 'final_answer')[0]) + 1, 0, relay, output); } },
    { code: 'choice-continuation-progress-relay-target', encrypted: true, mutate: (input) => { relayCalls(input.rollouts[1])[1].payload.arguments = JSON.stringify({ target: '/root/sibling', message: relayMessage('model-active') }); } },
  ];
  for (const { code, encrypted: encryptedPath, mutate } of cases) {
    const input = relayedChoiceFixture({ withStatus: true });
    if (encryptedPath) {
      const spawn = spawnEvent(input); const args = JSON.parse(spawn.payload.arguments); args.message = `gAAAA${'A'.repeat(64)}`; spawn.payload.arguments = JSON.stringify(args);
      const followup = choiceFollowup(input); const followupArgs = JSON.parse(followup.payload.arguments); followupArgs.message = `gAAAA${'B'.repeat(64)}`; followup.payload.arguments = JSON.stringify(followupArgs);
    }
    mutate(input); retimestampChoice(input);
    assert.throws(
      () => qualifyCodexRescueChoiceEvidence(input, choiceOptions('resume', { requireProgressRelay: true, requireStatusSidecar: true, expectedStatusCommand })),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === code,
      code,
    );
  }
});

test('choice child rollout accounts for every host event and exact exec tool name', () => {
  const extraCall = () => structuredPoll(77, 'outside'); const extraOutput = () => capturedResultEvent('outside', { output: '', exit_code: 0 });
  const cases = [
    { mutate: (input) => input.rollouts[1].unshift(extraCall(), extraOutput()) },
    { mutate: (input) => input.rollouts[1].push(extraCall(), extraOutput()) },
    { mutate: (input) => input.rollouts[1].push(extraOutput()) },
    { code: 'choice-initial-tool-name', mutate: (input) => { input.rollouts[1][1].payload.name = 'other'; } },
    { code: 'choice-continuation-tool-name', mutate: (input) => { input.rollouts[1][4].payload.name = 'other'; } },
  ];
  for (const { code = 'choice-child-execution-boundary', mutate } of cases) {
    const input = choiceFixture('resume'); mutate(input); retimestampChoice(input);
    assert.throws(() => qualifyCodexRescueChoiceEvidence(input, choiceOptions('resume')), (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === code, code);
  }
});

test('choice host and parent evidence has globally unique one-to-one call IDs', () => {
  const cases = [
    { code: 'choice-initial-call-id', mutate: (input) => { delete input.rollouts[1][1].payload.call_id; } },
    { code: 'choice-continuation-call-id', mutate: (input) => { delete input.rollouts[1][5].payload.call_id; } },
    { code: 'choice-child-call-id-reused', mutate: (input) => { input.rollouts[1][4].payload.call_id = 'exec-1'; input.rollouts[1][5].payload.call_id = 'exec-1'; } },
    { code: 'choice-parent-call-id', mutate: (input) => { delete choiceFollowup(input).payload.call_id; } },
    { code: 'choice-parent-call-id', mutate: (input) => { const waits = input.rollouts[0].filter((event) => event.payload?.name === 'wait_agent'); waits[1].payload.call_id = 'wait-1'; input.rollouts[0].findLast((event) => event.payload?.type === 'function_call_output').payload.call_id = 'wait-1'; } },
    { code: 'choice-parent-call-id', mutate: (input) => input.rollouts[0].push(followupOutput('orphan-parent')) },
  ];
  for (const { code, mutate } of cases) {
    const input = choiceFixture('resume'); mutate(input);
    assert.throws(() => qualifyCodexRescueChoiceEvidence(input, choiceOptions('resume')), (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === code, code);
  }
});

test('choice parent call IDs are globally owned across custom preflight and function tools', () => {
  const cases = [
    { mutate: (input) => { delete preflightEvent(input).payload.call_id; } },
    { mutate: (input) => { delete preflightOutput(input).payload.call_id; } },
    { mutate: (input) => { preflightEvent(input).payload.call_id = 'spawn-1'; preflightOutput(input).payload.call_id = 'spawn-1'; } },
    { mutate: (input) => { preflightEvent(input).payload.call_id = 'wait-1'; preflightOutput(input).payload.call_id = 'wait-1'; } },
    { mutate: (input) => { preflightEvent(input).payload.call_id = 'followup-1'; preflightOutput(input).payload.call_id = 'followup-1'; } },
    { mutate: (input) => { const wait = waitResult(input, 'wait-1'); [preflightOutput(input).payload.call_id, wait.payload.call_id] = [wait.payload.call_id, preflightOutput(input).payload.call_id]; } },
    { mutate: (input) => { input.rollouts[0].push(toolOutput('orphan-preflight', 'orphan')); } },
  ];
  for (const { mutate } of cases) {
    const input = choiceFixture('resume'); mutate(input);
    assert.throws(
      () => qualifyCodexRescueChoiceEvidence(input, choiceOptions('resume')),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'choice-parent-call-id',
    );
  }
});

test('choice yielded executions reject changed handles, nonempty input, missing exit, and polling after terminal', () => {
  const cases = [
    { code: 'choice-initial-handle-mismatch', turn: 'initial', mutate: (events) => { events.poll.payload.input = structuredPoll(52, events.poll.payload.call_id).payload.input; } },
    { code: 'choice-initial-poll-input', turn: 'initial', mutate: (events) => { events.poll.payload.input = structuredPoll(51, events.poll.payload.call_id, 'x').payload.input; } },
    { code: 'choice-initial-terminal-exit-missing', turn: 'initial', mutate: (events) => { events.terminal.payload.output = capturedResult({ output: events.terminalText, session_id: 51 }); } },
    { code: 'choice-initial-poll-after-terminal', turn: 'initial', mutate: (events, input) => { input.rollouts[1].splice(input.rollouts[1].indexOf(events.final), 0, structuredPoll(51, 'choice-initial-late-poll'), capturedResultEvent('choice-initial-late-poll', { output: '', exit_code: 0 })); } },
    { code: 'choice-continuation-handle-mismatch', turn: 'continuation', mutate: (events) => { events.poll.payload.input = structuredPoll(62, events.poll.payload.call_id).payload.input; } },
    { code: 'choice-continuation-poll-input', turn: 'continuation', mutate: (events) => { events.poll.payload.input = structuredPoll(61, events.poll.payload.call_id, 'x').payload.input; } },
    { code: 'choice-continuation-terminal-exit-missing', turn: 'continuation', mutate: (events) => { events.terminal.payload.output = capturedResult({ output: events.terminalText, session_id: 61 }); } },
    { code: 'choice-continuation-poll-after-terminal', turn: 'continuation', mutate: (events, input) => { input.rollouts[1].splice(input.rollouts[1].indexOf(events.final), 0, structuredPoll(61, 'choice-late-poll'), capturedResultEvent('choice-late-poll', { output: '', exit_code: 0 })); } },
  ];
  for (const { code, turn, mutate } of cases) {
    const input = choiceFixture('resume'); const events = yieldChoiceTurn(input, turn); mutate(events, input); retimestampChoice(input);
    assert.throws(() => qualifyCodexRescueChoiceEvidence(input, choiceOptions('resume')), (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === code, code);
  }
});

test('needs-choice is terminal only with exit code 3 before same-child continuation', () => {
  const valid = choiceFixture('resume');
  assert.equal(qualifyCodexRescueChoiceEvidence(valid, choiceOptions('resume')).choice, 'resume');
  const wrong = choiceFixture('resume');
  wrong.rollouts[1][2].payload.output = capturedResult({ output: `${JSON.stringify({ type: 'needs-choice', candidate: { sessionId: 'resumable-session' }, choices: ['--resume', '--fresh'] })}\n`, exit_code: 0 });
  assert.throws(
    () => qualifyCodexRescueChoiceEvidence(wrong, choiceOptions('resume')),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'choice-needs-choice-exit',
  );
});

test('selected choice continuation requires an exact zero exit code', () => {
  for (const exitCode of [1, 130]) {
    const input = choiceFixture('resume'); input.rollouts[1][5].payload.output = capturedResult({ output: `${expectedPublicOutput}\n`, exit_code: exitCode });
    assert.throws(() => qualifyCodexRescueChoiceEvidence(input, choiceOptions('resume')), (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'choice-continuation-terminal-exit-invalid', String(exitCode));
  }
});

test('shared parent-child route validation fails every trusted metadata field closed', () => {
  const cases = [
    (input) => { parentMeta(input).payload.session_id = 'wrong'; },
    (input) => { parentMeta(input).payload.id = 'wrong'; },
    (input) => { parentMeta(input).payload.parent_thread_id = 'invented'; },
    (input) => { parentMeta(input).payload.thread_source = 'subagent'; },
    (input) => { parentMeta(input).payload.source = 'other'; },
    (input) => { startEvent(input).payload.agent_thread_id = 'wrong'; },
    (input) => { startEvent(input).payload.agent_path = '/root/wrong'; },
    (input) => { childMeta(input).payload.id = 'wrong'; },
    (input) => { childMeta(input).payload.session_id = 'wrong'; },
    (input) => { childMeta(input).payload.parent_thread_id = 'wrong'; },
    (input) => { childMeta(input).payload.thread_source = 'user'; },
    (input) => { childMeta(input).payload.source.subagent.thread_spawn.parent_thread_id = 'wrong'; },
    (input) => { childMeta(input).payload.source.subagent.thread_spawn.depth = 2; },
    (input) => { childMeta(input).payload.source.subagent.thread_spawn.agent_path = '/root/wrong'; },
  ];
  for (const mutate of cases) {
    const input = fixture(); mutate(input);
    assert.throws(() => qualifyCodexRescueEvidence(input, options()), CodexRescueEvidenceMismatchError);
  }
});

test('wait timeout, early return, and ordinary steering retain one spawn and one child', () => {
  const input = timeoutFixture();
  const evidence = qualifyCodexRescueChoiceEvidence(input, choiceOptions('resume'));
  assert.equal(evidence.childThreadId, childId);
  assert.equal(input.rollouts[0].filter((event) => event?.payload?.name === 'spawn_agent').length, 1);
  for (const mutate of [
    (value) => { value.rollouts[0].find((event) => event?.payload?.call_id === 'list-after-timeout' && event.payload.type === 'function_call_output').payload.call_id = 'foreign'; },
    (value) => { const parent = value.rollouts[0]; const output = parent.splice(parent.findIndex((event) => event?.payload?.call_id === 'list-after-timeout' && event.payload.type === 'function_call_output'), 1)[0]; parent.splice(parent.findIndex((event) => event?.payload?.name === 'list_agents'), 0, output); },
    (value) => { const parent = value.rollouts[0]; const wait = parent.splice(parent.findIndex((event) => event?.payload?.call_id === 'wait-after-steering' && event.payload.type === 'function_call'), 1)[0]; parent.splice(parent.findIndex((event) => event?.payload?.call_id === 'list-after-timeout' && event.payload.type === 'function_call_output'), 0, wait); },
  ]) { const invalid = timeoutFixture(); mutate(invalid); assert.throws(() => qualifyCodexRescueChoiceEvidence(invalid, choiceOptions('resume')), CodexRescueEvidenceMismatchError); }
});

test('choice qualification fails closed on duplicate execution, identity drift, replay, and weak wait evidence', () => {
  const cases = [
    { code: 'choice-spawn-count', mutate: (input) => input.rollouts[0].splice(4, 0, structuredSpawn('spawn-2')) },
    { code: 'choice-spawn-keys', mutate: (input) => { const args = JSON.parse(spawnEvent(input).payload.arguments); args.task = 'leak'; spawnEvent(input).payload.arguments = JSON.stringify(args); } },
    { code: 'choice-agent-role', mutate: (input) => { childMeta(input).payload.source.subagent.thread_spawn.agent_role = null; } },
    { code: 'choice-followup-count', mutate: (input) => input.rollouts[0].splice(-1, 0, structuredFollowup('followup-2', 'resume'), followupOutput('followup-2')) },
    { code: 'choice-followup-target', mutate: (input) => { choiceFollowup(input).payload.arguments = JSON.stringify({ target: 'sibling-child', message: choiceOptions('resume').expectedFollowupMessage }); } },
    { code: 'choice-followup-message', mutate: (input) => { choiceFollowup(input).payload.arguments = JSON.stringify({ target: childId, message: `${choiceOptions('resume').expectedFollowupMessage} task text` }); } },
    { code: 'choice-parent-call-id', mutate: (input) => { followupResult(input).payload.call_id = 'foreign'; } },
    { code: 'choice-followup-output-order', mutate: (input) => { const output = input.rollouts[0].splice(input.rollouts[0].indexOf(followupResult(input)), 1)[0]; input.rollouts[0].splice(input.rollouts[0].indexOf(choiceFollowup(input)), 0, output); } },
    { code: 'choice-wait-count', mutate: (input) => { const waitIds = new Set(input.rollouts[0].filter((event) => event?.payload?.name === 'wait_agent').map((event) => event.payload.call_id)); input.rollouts[0] = input.rollouts[0].filter((event) => !waitIds.has(event?.payload?.call_id)); } },
    { code: 'choice-parent-call-id', mutate: (input) => { input.rollouts[0] = input.rollouts[0].filter((event) => event?.payload?.call_id !== 'wait-1' || event?.payload?.type !== 'function_call_output'); } },
    { code: 'choice-wait-output-shape', mutate: (input) => { waitResult(input, 'wait-1').payload.output = JSON.stringify({ message: 'Wait completed.', timed_out: true }); } },
    { code: 'choice-wait-return-order', mutate: (input) => { const output = waitResult(input, 'wait-2'); input.rollouts[0].splice(input.rollouts[0].indexOf(output), 1); input.rollouts[0].push(output); } },
    { code: 'choice-command-count', mutate: (input) => input.rollouts[1].splice(-1, 0, structuredExec(expectedCommand, 'exec-3')) },
    { code: 'choice-command-mismatch', mutate: (input) => { choiceExec(input).payload.input = structuredExec('node "/installed/zcode/skills/rescue/launcher.mjs" invoke-choice rescue fresh', 'exec-2').payload.input; } },
    { code: 'choice-child-terminal-sequence', mutate: (input) => { input.rollouts[1][3].payload.message = 'tampered'; } },
    { code: 'choice-terminal-timeline', mutate: (input) => { choiceExec(input).timestamp = input.rollouts[0].find((event) => event?.payload?.phase === 'final_answer').timestamp; } },
    { code: 'choice-followup-order', mutate: (input) => { const ask = input.rollouts[0].splice(input.rollouts[0].findIndex((event) => event?.payload?.phase === 'final_answer'), 1)[0]; input.rollouts[0].splice(input.rollouts[0].findIndex((event) => event?.payload?.name === 'followup_task') + 1, 0, ask); } },
  ];
  for (const { code, mutate } of cases) {
    const input = choiceFixture('resume'); mutate(input);
    assert.throws(
      () => qualifyCodexRescueChoiceEvidence(input, choiceOptions('resume')),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === code,
      code,
    );
  }
});

test('choice timeline preserves RFC3339 nanosecond ordering without Date precision loss', () => {
  const input = choiceFixture('resume'); const first = input.rollouts[1][1]; const second = input.rollouts[1][2];
  first.timestamp = '2026-08-10T00:00:00.000001Z'; second.timestamp = '2026-08-10T00:00:00.000999Z';
  assert.equal(qualifyCodexRescueChoiceEvidence(input, choiceOptions('resume')).choice, 'resume');
  [first.timestamp, second.timestamp] = [second.timestamp, first.timestamp];
  assert.throws(() => qualifyCodexRescueChoiceEvidence(input, choiceOptions('resume')), (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'choice-terminal-timeline');
});

test('qualifies the complete 0.147 generic default same-child choice continuation', () => {
  const input = choiceFixture('resume');
  const args = JSON.parse(spawnEvent(input).payload.arguments); delete args.agent_type; args.message = choiceOptions('resume').expectedGenericSpawnMessage; spawnEvent(input).payload.arguments = JSON.stringify(args);
  childMeta(input).payload.source.subagent.thread_spawn.agent_role = null;
  assert.deepEqual(qualifyCodexRescueChoiceEvidence(input, choiceOptions('resume')), {
    parentThreadId: parentId, childThreadId: childId, agentPath, taskName, choice: 'resume',
  });
});

test('choice qualification marks only explicitly encrypted continuation arguments unqualified', () => {
  const encrypted = choiceFixture('resume');
  choiceFollowup(encrypted).payload.arguments = JSON.stringify({ target: childId, message: `gAAAA${'A'.repeat(80)}=` });
  assert.throws(
    () => qualifyCodexRescueChoiceEvidence(encrypted, choiceOptions('resume')),
    (error) => error instanceof CodexRescueUnqualifiedError && error.code === 'choice-followup-encrypted',
  );
  const wholeArguments = choiceFixture('resume'); choiceFollowup(wholeArguments).payload.arguments = `gAAAA${'A'.repeat(80)}=`;
  assert.throws(() => qualifyCodexRescueChoiceEvidence(wholeArguments, choiceOptions('resume')), (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'choice-followup-arguments');
  const observableMismatch = choiceFixture('resume');
  choiceFollowup(observableMismatch).payload.arguments = JSON.stringify({ target: childId, message: `gAAAA${'A'.repeat(80)}=` });
  waitResult(observableMismatch, 'wait-1').payload.call_id = 'wrong';
  assert.throws(() => qualifyCodexRescueChoiceEvidence(observableMismatch, choiceOptions('resume')), (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'choice-parent-call-id');
  const missing = choiceFixture('resume'); const missingCall = choiceFollowup(missing); const missingOutput = followupResult(missing); missing.rollouts[0] = missing.rollouts[0].filter((event) => event !== missingCall && event !== missingOutput);
  assert.throws(
    () => qualifyCodexRescueChoiceEvidence(missing, choiceOptions('resume')),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'choice-followup-count',
  );
});

test('qualifies the verified 0.147 generic route from its complete fixed assignment and child chain', () => {
  const input = fixture();
  spawnEvent(input).payload.arguments = JSON.stringify({ fork_turns: 'none', message: 'fixed generic forwarder', task_name: taskName });
  childMeta(input).payload.source.subagent.thread_spawn.agent_role = null;
  assert.deepEqual(qualifyCodexRescueEvidence(input, options()), {
    parentThreadId: parentId, childThreadId: childId, agentPath, taskName, agentType: 'default',
    route: 'generic-schema-hidden', publicOutput: expectedPublicOutput, semanticProgressChecked: true,
  });
});

test('does not self-report generic compatibility and lets named metadata work on another version', () => {
  const generic = fixture();
  parentMeta(generic).payload.cli_version = '0.148.0';
  const genericArgs = JSON.parse(spawnEvent(generic).payload.arguments); delete genericArgs.agent_type;
  spawnEvent(generic).payload.arguments = JSON.stringify(genericArgs);
  childMeta(generic).payload.source.subagent.thread_spawn.agent_role = null;
  assert.throws(
    () => qualifyCodexRescueEvidence(generic, options()),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'generic-schema-version-unqualified',
  );
  const named = fixture(); parentMeta(named).payload.cli_version = '0.148.0';
  assert.equal(qualifyCodexRescueEvidence(named, options()).route, 'named');
});

test('requires exact Role readiness and one private same-handle preparation before spawn', () => {
  const cases = [
    { code: 'preflight-count', mutate: (input) => { removeParentCall(input, 'preflight-1'); } },
    { code: 'preflight-count', mutate: (input) => input.rollouts[0].splice(1, 0, ...parentPreparationEvents('duplicate-').slice(0, 2)) },
    { code: 'preflight-command-mismatch', mutate: (input) => { preflightEvent(input).payload.input = structuredExecResult(`${expectedPreflightCommand} && true`, 'preflight-1').payload.input; } },
    { code: 'preflight-output-link', mutate: (input) => { preflightOutput(input).payload.call_id = 'wrong-call'; } },
    { code: 'preflight-status-mismatch', mutate: (input) => { preflightOutput(input).payload.output = capturedResult({ output: `${JSON.stringify({ type: 'role-status', role: 'zcode-rescue', status: 'drift' })}\n`, exit_code: 0 }); } },
    { code: 'preflight-status-mismatch', mutate: (input) => { preflightOutput(input).payload.output = capturedResult({ output: `${JSON.stringify({ type: 'role-status', role: 'zcode-rescue', status: 'ready' })}\n`, exit_code: 1 }); } },
    { code: 'preparation-count', mutate: (input) => { removeParentCall(input, 'prepare-1'); } },
    { code: 'preparation-count', mutate: (input) => input.rollouts[0].splice(3, 0, structuredExecResult(expectedPreparationCommand, 'prepare-2', { tty: true })) },
    { code: 'preparation-ready-count', mutate: (input) => { removeParentOutput(input, 'prepare-1'); } },
    { code: 'preparation-ready-count', mutate: (input) => input.rollouts[0].splice(5, 0, capturedResultEvent('prepare-1', { output: `${JSON.stringify({ type: 'preparation-input-ready', command: 'rescue' })}\n`, session_id: 44 })) },
    { code: 'preparation-order', mutate: (input) => { const write = parentCall(input, 'prepare-write-1'); input.rollouts[0].splice(input.rollouts[0].indexOf(write), 1); input.rollouts[0].splice(input.rollouts[0].indexOf(parentOutput(input, 'prepare-1')), 0, write); } },
    { code: 'preparation-write-handle', mutate: (input) => { parentCall(input, 'prepare-write-1').payload.input = structuredPoll(999, 'prepare-write-1', `${expectedPreparationPayload}\n`).payload.input; } },
    { code: 'preparation-write-count', mutate: (input) => input.rollouts[0].splice(7, 0, structuredPoll(44, 'prepare-write-2', `${expectedPreparationPayload}\n`), capturedResultEvent('prepare-write-2', { output: `${JSON.stringify({ type: 'prepared', command: 'rescue' })}\n`, exit_code: 0 })) },
    { code: 'preparation-write-frame', mutate: (input) => { parentCall(input, 'prepare-write-1').payload.input = structuredPoll(44, 'prepare-write-1', `${expectedPreparationPayload}\n\u0004`).payload.input; } },
    { code: 'preparation-payload-echo', mutate: (input) => { parentOutput(input, 'prepare-1').payload.output = capturedResult({ output: `${JSON.stringify({ type: 'preparation-input-ready', command: 'rescue' })}\n${expectedPreparationPayload}`, session_id: 44 }); } },
    { code: 'preparation-order', mutate: (input) => { const prepare = parentCall(input, 'prepare-1'); const ready = parentOutput(input, 'prepare-1'); input.rollouts[0].splice(input.rollouts[0].indexOf(ready), 1); input.rollouts[0].splice(input.rollouts[0].indexOf(prepare), 1); const spawn = spawnEvent(input); input.rollouts[0].splice(input.rollouts[0].indexOf(spawn) + 1, 0, prepare, ready); } },
    { code: 'preparation-write-frame', mutate: (input) => { const changed = { ...expectedPreparationEnvelope, source: 'proactive' }; parentCall(input, 'prepare-write-1').payload.input = structuredPoll(44, 'prepare-write-1', `${JSON.stringify(changed)}\n`).payload.input; } },
    { code: 'child-command-mismatch', mutate: (input) => { childExec(input).payload.input = structuredExec('node "/installed/zcode/scripts/zcode-companion.mjs" invoke rescue').payload.input; } },
  ];
  for (const { code, mutate } of cases) {
    const input = fixture(); mutate(input);
    assert.throws(() => qualifyCodexRescueEvidence(input, options()), (error) => {
      assert.doesNotMatch(error.message, new RegExp(expectedPreparationEnvelope.task, 'u'));
      return error instanceof CodexRescueEvidenceMismatchError && error.code === code;
    });
  }
});

test('foreground and background parent calls own globally unique one-to-one call IDs', () => {
  for (const callId of ['preflight-1', 'prepare-1', 'prepare-write-1']) {
    for (const background of [false, true]) {
      const input = background ? backgroundFixture() : fixture();
      spawnEvent(input).payload.call_id = callId;
      startEvent(input).payload.event_id = callId;
      const qualify = background
        ? () => qualifyCodexRescueBackgroundEvidence(input, backgroundOptions())
        : () => qualifyCodexRescueEvidence(input, options());
      assert.throws(
        qualify,
        (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'parent-call-id',
        `${background ? 'background' : 'foreground'} spawn reused ${callId}`,
      );
    }
  }
});

test('preparation qualification independently validates task and every bounded option value', () => {
  const invalidEnvelopes = [
    { ...expectedPreparationEnvelope, task: ' ' },
    { ...expectedPreparationEnvelope, task: 't'.repeat(64 * 1024 + 1) },
    { ...expectedPreparationEnvelope, options: { ...expectedPreparationEnvelope.options, unknown: true } },
    { ...expectedPreparationEnvelope, options: { ...expectedPreparationEnvelope.options, execution: null } },
    { ...expectedPreparationEnvelope, options: { ...expectedPreparationEnvelope.options, execution: 'detached' } },
    { ...expectedPreparationEnvelope, options: { ...expectedPreparationEnvelope.options, resume: 'maybe' } },
    { ...expectedPreparationEnvelope, options: { ...expectedPreparationEnvelope.options, effort: 'extreme' } },
    { ...expectedPreparationEnvelope, options: { ...expectedPreparationEnvelope.options, model: '' } },
    { ...expectedPreparationEnvelope, options: { ...expectedPreparationEnvelope.options, model: 'm'.repeat(513) } },
    { ...expectedPreparationEnvelope, options: { ...expectedPreparationEnvelope.options, model: 'provider/model\nsecret' } },
  ];
  for (const envelope of invalidEnvelopes) {
    const preparationPayload = JSON.stringify(envelope);
    const input = fixture();
    parentCall(input, 'prepare-write-1').payload.input = structuredPoll(44, 'prepare-write-1', `${preparationPayload}\n`).payload.input;
    assert.throws(
      () => qualifyCodexRescueEvidence(input, options({ expectedPreparationPayload: preparationPayload })),
      (error) => error instanceof CodexRescueEvidenceMismatchError
        && error.code === 'preparation-payload-contract'
        && (envelope.task.trim().length === 0 || !error.message.includes(envelope.task)),
    );
  }
  const valid = { ...expectedPreparationEnvelope, options: { execution: 'background', resume: 'resume', effort: 'xhigh', model: 'provider/model' } };
  const preparationPayload = JSON.stringify(valid); const input = fixture();
  parentCall(input, 'prepare-write-1').payload.input = structuredPoll(44, 'prepare-write-1', `${preparationPayload}\n`).payload.input;
  assert.equal(qualifyCodexRescueEvidence(input, options({ expectedPreparationPayload: preparationPayload })).publicOutput, expectedPublicOutput);
});

test('preparation qualification rejects duplicate raw keys and an oversized escaped frame', () => {
  const optionsJson = JSON.stringify(expectedPreparationEnvelope.options);
  const cases = [
    `{"version":1,"source":"explicit","task":"decoy","task":${JSON.stringify(expectedPreparationEnvelope.task)},"options":${optionsJson}}`,
    `{"version":1,"source":"explicit","task":${JSON.stringify(expectedPreparationEnvelope.task)},"options":{"execution":"background","execution":"foreground","resume":"fresh"}}`,
    JSON.stringify({ ...expectedPreparationEnvelope, task: `objective:${'\u0000'.repeat(12_000)}` }),
  ];
  assert.ok(Buffer.byteLength(cases[2], 'utf8') + 1 > 64 * 1024 + 4096);
  for (const preparationPayload of cases) {
    const input = fixture();
    parentCall(input, 'prepare-write-1').payload.input = structuredPoll(44, 'prepare-write-1', `${preparationPayload}\n`).payload.input;
    assert.throws(
      () => qualifyCodexRescueEvidence(input, options({ expectedPreparationPayload: preparationPayload })),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'preparation-payload-contract'
        && !error.message.includes(expectedPreparationEnvelope.task) && !error.message.includes('execution'),
    );
  }
});

test('preparation qualification rejects a raw LF before the frame terminator', () => {
  const preparationPayload = JSON.stringify(expectedPreparationEnvelope, null, 2);
  const input = fixture();
  parentCall(input, 'prepare-write-1').payload.input = structuredPoll(44, 'prepare-write-1', `${preparationPayload}\n`).payload.input;
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options({ expectedPreparationPayload: preparationPayload })),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'preparation-write-frame'
      && !error.message.includes(expectedPreparationEnvelope.task),
  );
});

test('confines the exact preparation task to the one same-handle parent write chars field', () => {
  const task = expectedPreparationEnvelope.task;
  const cases = [
    ['parent commentary', (input) => input.rollouts[0].splice(-2, 0, { type: 'event_msg', payload: { type: 'agent_message', message: task, phase: 'commentary' } })],
    ['unrelated exec argv', (input) => input.rollouts[0].splice(7, 0, structuredExec(`printf %s ${JSON.stringify(task)}`, 'unrelated-task-argv'), toolOutput('unrelated-task-argv', ''))],
    ['unrelated exec env', (input) => input.rollouts[0].splice(7, 0, structuredExec('true', 'unrelated-task-env', { env: { PRIVATE_TASK: task } }), toolOutput('unrelated-task-env', ''))],
    ['unrelated tool output', (input) => input.rollouts[0].splice(7, 0, structuredExec('true', 'unrelated-task-output'), toolOutput('unrelated-task-output', task))],
    ['write event metadata', (input) => { parentCall(input, 'prepare-write-1').payload.private_task = task; }],
    ['prepared ack task echo', (input) => { parentOutput(input, 'prepare-write-1').payload.output = capturedResult({ output: `${JSON.stringify({ type: 'prepared', command: 'rescue', task })}\n`, exit_code: 0 }); }],
    ['spawn message', (input) => { const args = JSON.parse(spawnEvent(input).payload.arguments); args.message = `${args.message} ${task}`; spawnEvent(input).payload.arguments = JSON.stringify(args); }],
    ['parent relay', (input) => input.rollouts[0].splice(-2, 0, { type: 'response_item', payload: { type: 'agent_message', author: agentPath, recipient: '/root', content: [{ type: 'input_text', text: task }] } })],
    ['parent status output', (input) => input.rollouts[0].splice(-2, 0, structuredExec(expectedStatusCommand, 'parent-status-task'), toolOutput('parent-status-task', task))],
  ];
  for (const [name, mutate] of cases) {
    const input = fixture(); mutate(input);
    assert.throws(() => qualifyCodexRescueEvidence(input, options()), (error) => {
      assert.doesNotMatch(error.message, new RegExp(task, 'u'), name);
      return error instanceof CodexRescueEvidenceMismatchError && error.code === 'preparation-task-exclusivity';
    }, name);
  }
  assert.equal(qualifyCodexRescueEvidence(fixture(), options()).publicOutput, expectedPublicOutput);
  const recordedUserInput = fixture();
  recordedUserInput.rollouts[0].splice(1, 0, { type: 'event_msg', payload: { type: 'user_message', message: task } });
  assert.equal(qualifyCodexRescueEvidence(recordedUserInput, options()).publicOutput, expectedPublicOutput);
});

test('detects escaped private task text in parent commentary and decoded tool envelopes', () => {
  const cases = [
    ['repair the "quoted" route', (input, task) => input.rollouts[0].splice(-2, 0, { type: 'event_msg', payload: { type: 'agent_message', message: `leaked: ${task}`, phase: 'commentary' } })],
    ['repair the \\backslash route', (input, task) => input.rollouts[0].splice(7, 0, structuredExec('true', 'escaped-task-env', { env: { PRIVATE_TASK: task } }), toolOutput('escaped-task-env', ''))],
    ['repair the\nmultiline route', (input, task) => { parentOutput(input, 'prepare-write-1').payload.output = capturedResult({ output: `${JSON.stringify({ type: 'prepared', command: 'rescue', task })}\n`, exit_code: 0 }); }],
  ];
  for (const [task, leak] of cases) {
    const envelope = { ...expectedPreparationEnvelope, task };
    const preparationPayload = JSON.stringify(envelope);
    const input = fixture();
    parentCall(input, 'prepare-write-1').payload.input = structuredPoll(44, 'prepare-write-1', `${preparationPayload}\n`).payload.input;
    leak(input, task);
    assert.throws(
      () => qualifyCodexRescueEvidence(input, options({ expectedPreparationPayload: preparationPayload })),
      (error) => {
        assert.doesNotMatch(error.message, new RegExp(task.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
        return error instanceof CodexRescueEvidenceMismatchError && error.code === 'preparation-task-exclusivity';
      },
    );
  }
});

test('detects escaped private task text inside unrelated legacy host output', () => {
  for (const task of ['repair the "quoted" route', 'repair the \\backslash route', 'repair the\nmultiline route']) {
    const preparationPayload = JSON.stringify({ ...expectedPreparationEnvelope, task });
    const input = fixture();
    parentCall(input, 'prepare-write-1').payload.input = structuredPoll(44, 'prepare-write-1', `${preparationPayload}\n`).payload.input;
    input.rollouts[0].splice(7, 0,
      structuredExec('true', 'escaped-legacy-output'),
      toolOutput('escaped-legacy-output', JSON.stringify({ diagnostic: task })));
    assert.throws(
      () => qualifyCodexRescueEvidence(input, options({ expectedPreparationPayload: preparationPayload })),
      (error) => error instanceof CodexRescueEvidenceMismatchError
        && error.code === 'preparation-task-exclusivity' && !error.message.includes(task),
    );
  }
});

test('bounded legacy output decoding detects prefixed JSON, JSONL, and nested JSON strings', () => {
  const cases = [
    ['repair the "quoted" route', (task) => `legacy prefix: ${JSON.stringify({ diagnostic: task })}`],
    ['repair the \\backslash route', (task) => `${JSON.stringify({ type: 'diagnostic' })}\n${JSON.stringify({ diagnostic: task })}\n`],
    ['repair the\nmultiline route', (task) => JSON.stringify(JSON.stringify(JSON.stringify({ diagnostic: task })))],
    ['repair bounded "depth" route', (task) => { let value = JSON.stringify({ diagnostic: task }); for (let depth = 0; depth < 10; depth += 1) value = JSON.stringify(value); return value; }],
  ];
  for (const [task, legacyOutput] of cases) {
    const preparationPayload = JSON.stringify({ ...expectedPreparationEnvelope, task });
    const input = fixture();
    parentCall(input, 'prepare-write-1').payload.input = structuredPoll(44, 'prepare-write-1', `${preparationPayload}\n`).payload.input;
    input.rollouts[0].splice(7, 0,
      structuredExec('true', 'encoded-legacy-output'),
      toolOutput('encoded-legacy-output', legacyOutput(task)));
    assert.throws(
      () => qualifyCodexRescueEvidence(input, options({ expectedPreparationPayload: preparationPayload })),
      (error) => error instanceof CodexRescueEvidenceMismatchError
        && error.code === 'preparation-task-exclusivity' && !error.message.includes(task),
    );
  }
});

test('bounded task scanning covers balanced JSON tokens in legacy and structured captured output', () => {
  const task = 'repair the "quoted" \\route\nnow';
  const preparationPayload = JSON.stringify({ ...expectedPreparationEnvelope, task });
  const cases = [
    ['legacy prefix and suffix', false, `prefix ${JSON.stringify({ diagnostic: task })} suffix`],
    ['legacy sibling tokens', false, `context={} payload=${JSON.stringify(task)}`],
    ['structured prefix', true, `prefix ${JSON.stringify({ diagnostic: task })}`],
    ['structured JSONL', true, `${JSON.stringify({ context: {} })}\n${JSON.stringify({ diagnostic: task })}\n`],
    ['structured multilayer', true, JSON.stringify(JSON.stringify(JSON.stringify({ diagnostic: task })))],
    ['structured prefix and suffix', true, `before ${JSON.stringify({ diagnostic: task })} after`],
  ];
  for (const [name, structured, output] of cases) {
    const input = fixture();
    parentCall(input, 'prepare-write-1').payload.input = structuredPoll(44, 'prepare-write-1', `${preparationPayload}\n`).payload.input;
    input.rollouts[0].splice(7, 0,
      structured ? structuredExecResult('true', `balanced-${name}`) : structuredExec('true', `balanced-${name}`),
      structured ? capturedResultEvent(`balanced-${name}`, { output, exit_code: 0 }) : toolOutput(`balanced-${name}`, output));
    assert.throws(
      () => qualifyCodexRescueEvidence(input, options({ expectedPreparationPayload: preparationPayload })),
      (error) => error instanceof CodexRescueEvidenceMismatchError
        && error.code === 'preparation-task-exclusivity' && !error.message.includes(task),
      name,
    );
  }
});

test('fails closed within the candidate budget on a flood of unmatched JSON delimiters', () => {
  const task = 'repair the bounded delimiter scanner';
  const preparationPayload = JSON.stringify({ ...expectedPreparationEnvelope, task });
  const input = fixture();
  parentCall(input, 'prepare-write-1').payload.input = structuredPoll(44, 'prepare-write-1', `${preparationPayload}\n`).payload.input;
  input.rollouts[0].splice(7, 0,
    structuredExec('true', 'unmatched-delimiter-flood'),
    toolOutput('unmatched-delimiter-flood', '{'.repeat(4_096)));
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options({ expectedPreparationPayload: preparationPayload })),
    (error) => error instanceof CodexRescueEvidenceMismatchError
      && error.code === 'preparation-task-exclusivity' && !error.message.includes(task),
  );
});

test('structured task scanning retains parsed non-output result fields', () => {
  const task = 'repair the "quoted" \\route\nnow';
  const preparationPayload = JSON.stringify({ ...expectedPreparationEnvelope, task });
  const input = fixture();
  parentCall(input, 'prepare-write-1').payload.input = structuredPoll(44, 'prepare-write-1', `${preparationPayload}\n`).payload.input;
  input.rollouts[0].splice(7, 0,
    structuredExecResult('true', 'structured-result-field'),
    capturedResultEvent('structured-result-field', { output: '', exit_code: 0, chunk_id: task }));
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options({ expectedPreparationPayload: preparationPayload })),
    (error) => error instanceof CodexRescueEvidenceMismatchError
      && error.code === 'preparation-task-exclusivity' && !error.message.includes(task),
  );
});

test('structured task scanning recursively decodes every non-output string leaf', () => {
  const task = 'repair the "quoted" \\route\nnow';
  const preparationPayload = JSON.stringify({ ...expectedPreparationEnvelope, task });
  const input = fixture();
  parentCall(input, 'prepare-write-1').payload.input = structuredPoll(44, 'prepare-write-1', `${preparationPayload}\n`).payload.input;
  input.rollouts[0].splice(7, 0,
    structuredExecResult('true', 'structured-encoded-result-field'),
    capturedResultEvent('structured-encoded-result-field', { output: '', exit_code: 0, chunk_id: JSON.stringify(task) }));
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options({ expectedPreparationPayload: preparationPayload })),
    (error) => error instanceof CodexRescueEvidenceMismatchError
      && error.code === 'preparation-task-exclusivity' && !error.message.includes(task),
  );
});

for (const [name, structured, output, chunkId] of [
  ['legacy item text', false, `legacy prefix {"diagnostic":${JSON.stringify('repair the "quoted" \\route\nnow').slice(0, -1)}`],
  ['structured result output', true, `structured prefix [${JSON.stringify('repair the "quoted" \\route\nnow').slice(0, -1)}`],
  ['structured non-output leaf', true, '', `metadata=${JSON.stringify('repair the "quoted" \\route\nnow').slice(0, -1)}`],
]) {
  test(`task scanning detects a truncated JSON-escaped task string in ${name}`, () => {
    const task = 'repair the "quoted" \\route\nnow';
    const preparationPayload = JSON.stringify({ ...expectedPreparationEnvelope, task });
    const input = fixture();
    parentCall(input, 'prepare-write-1').payload.input = structuredPoll(44, 'prepare-write-1', `${preparationPayload}\n`).payload.input;
    input.rollouts[0].splice(7, 0,
      structured ? structuredExecResult('true', `truncated-${name}`) : structuredExec('true', `truncated-${name}`),
      structured
        ? capturedResultEvent(`truncated-${name}`, { output, exit_code: 0, ...(chunkId === undefined ? {} : { chunk_id: chunkId }) })
        : toolOutput(`truncated-${name}`, output));
    assert.throws(
      () => qualifyCodexRescueEvidence(input, options({ expectedPreparationPayload: preparationPayload })),
      (error) => error instanceof CodexRescueEvidenceMismatchError
        && error.code === 'preparation-task-exclusivity' && !error.message.includes(task),
      name,
    );
  });
}

for (const [name, structured, output, chunkId] of (() => {
  const task = 'repair the "quoted" \\route\nnow';
  const unicodeEscaped = unicodeEscapeEveryChar(task);
  return [
    ['legacy item text', false, `legacy unicode=${unicodeEscaped}`],
    ['structured result output', true, `structured unicode=${unicodeEscaped}`],
    ['structured non-output leaf', true, '', `metadata=${unicodeEscaped}`],
  ];
})()) {
  test(`task scanning decodes a truncated per-character Unicode JSON string in ${name}`, () => {
    const task = 'repair the "quoted" \\route\nnow';
    const preparationPayload = JSON.stringify({ ...expectedPreparationEnvelope, task });
    const input = fixture();
    parentCall(input, 'prepare-write-1').payload.input = structuredPoll(44, 'prepare-write-1', `${preparationPayload}\n`).payload.input;
    input.rollouts[0].splice(7, 0,
      structured ? structuredExecResult('true', `unicode-${name}`) : structuredExec('true', `unicode-${name}`),
      structured
        ? capturedResultEvent(`unicode-${name}`, { output, exit_code: 0, ...(chunkId === undefined ? {} : { chunk_id: chunkId }) })
        : toolOutput(`unicode-${name}`, output));
    assert.throws(
      () => qualifyCodexRescueEvidence(input, options({ expectedPreparationPayload: preparationPayload })),
      (error) => error instanceof CodexRescueEvidenceMismatchError
        && error.code === 'preparation-task-exclusivity' && !error.message.includes(task),
      name,
    );
  });
}

test('task scanning recursively decodes a truncated outer JSON string around an escaped task string', () => {
  const task = 'repair the "quoted" \\route\nnow';
  const preparationPayload = JSON.stringify({ ...expectedPreparationEnvelope, task });
  const input = fixture();
  parentCall(input, 'prepare-write-1').payload.input = structuredPoll(44, 'prepare-write-1', `${preparationPayload}\n`).payload.input;
  input.rollouts[0].splice(7, 0,
    structuredExecResult('true', 'truncated-double-escaped'),
    capturedResultEvent('truncated-double-escaped', {
      output: `nested=${JSON.stringify(JSON.stringify(task)).slice(0, -1)}`,
      exit_code: 0,
    }));
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options({ expectedPreparationPayload: preparationPayload })),
    (error) => error instanceof CodexRescueEvidenceMismatchError
      && error.code === 'preparation-task-exclusivity' && !error.message.includes(task),
  );
});

for (const [suffixName, suffix] of [['trailing backslash', '\\'], ['partial Unicode escape', '\\u12'], ['invalid escape', '\\q']]) {
  for (const [surface, structured] of [['legacy item text', false], ['structured result output', true], ['structured non-output leaf', true]]) {
    test(`task scanning retains a fully decoded Unicode task prefix before ${suffixName} in ${surface}`, () => {
      const task = 'repair the "quoted" \\route\nnow';
      const preparationPayload = JSON.stringify({ ...expectedPreparationEnvelope, task });
      const encoded = `${unicodeEscapeEveryChar(task)}${suffix}`;
      const output = surface === 'structured non-output leaf' ? '' : `${surface}=${encoded}`;
      const input = fixture();
      parentCall(input, 'prepare-write-1').payload.input = structuredPoll(44, 'prepare-write-1', `${preparationPayload}\n`).payload.input;
      input.rollouts[0].splice(7, 0,
        structured ? structuredExecResult('true', `malformed-${suffixName}-${surface}`) : structuredExec('true', `malformed-${suffixName}-${surface}`),
        structured
          ? capturedResultEvent(`malformed-${suffixName}-${surface}`, {
            output,
            exit_code: 0,
            ...(surface === 'structured non-output leaf' ? { chunk_id: `metadata=${encoded}` } : {}),
          })
          : toolOutput(`malformed-${suffixName}-${surface}`, output));
      assert.throws(
        () => qualifyCodexRescueEvidence(input, options({ expectedPreparationPayload: preparationPayload })),
        (error) => error instanceof CodexRescueEvidenceMismatchError
          && error.code === 'preparation-task-exclusivity' && !error.message.includes(task),
      );
    });
  }
}

for (const [suffixName, suffix] of [['trailing backslash', '\\'], ['partial Unicode escape', '\\u12'], ['invalid escape', '\\q']]) {
  test(`task scanning retains a decoded inner task before a malformed outer ${suffixName}`, () => {
    const task = 'repair the "quoted" \\route\nnow';
    const preparationPayload = JSON.stringify({ ...expectedPreparationEnvelope, task });
    const malformedOuter = `${JSON.stringify(JSON.stringify(task)).slice(0, -1)}${suffix}`;
    const input = fixture();
    parentCall(input, 'prepare-write-1').payload.input = structuredPoll(44, 'prepare-write-1', `${preparationPayload}\n`).payload.input;
    input.rollouts[0].splice(7, 0,
      structuredExecResult('true', `malformed-outer-${suffixName}`),
      capturedResultEvent(`malformed-outer-${suffixName}`, { output: `nested=${malformedOuter}`, exit_code: 0 }));
    assert.throws(
      () => qualifyCodexRescueEvidence(input, options({ expectedPreparationPayload: preparationPayload })),
      (error) => error instanceof CodexRescueEvidenceMismatchError
        && error.code === 'preparation-task-exclusivity' && !error.message.includes(task),
    );
  });
}

test('task scanning preserves a Unicode surrogate pair before a malformed JSON string suffix', () => {
  const task = 'repair the 😀 route';
  const preparationPayload = JSON.stringify({ ...expectedPreparationEnvelope, task });
  const input = fixture();
  parentCall(input, 'prepare-write-1').payload.input = structuredPoll(44, 'prepare-write-1', `${preparationPayload}\n`).payload.input;
  input.rollouts[0].splice(7, 0,
    structuredExec('true', 'malformed-surrogate-prefix'),
    toolOutput('malformed-surrogate-prefix', `unicode=${unicodeEscapeEveryChar(task)}\\q`));
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options({ expectedPreparationPayload: preparationPayload })),
    (error) => error instanceof CodexRescueEvidenceMismatchError
      && error.code === 'preparation-task-exclusivity' && !error.message.includes(task),
  );
});

test('ordinary malformed unterminated JSON string prefixes remain non-sensitive evidence', () => {
  for (const [name, output] of [['trailing backslash', 'log="ordinary\\'], ['partial Unicode escape', 'log="ordinary\\u12'], ['invalid escape', 'log="ordinary\\q']]) {
    const input = fixture();
    input.rollouts[0].splice(7, 0, structuredExec('true', `ordinary-${name}`), toolOutput(`ordinary-${name}`, output));
    assert.equal(qualifyCodexRescueEvidence(input, options()).publicOutput, expectedPublicOutput, name);
  }
});

test('binds child stdout to the unique exec call and terminal sentinel', () => {
  const cases = [
    { code: 'child-output-count', mutate: (input) => input.rollouts[1].splice(2, 1) },
    { code: 'child-output-count', mutate: (input) => input.rollouts[1].splice(3, 0, toolOutput('exec-1', `${expectedPublicOutput}\n`)) },
    { code: 'child-call-id', mutate: (input) => { childOutput(input).payload.call_id = 'wrong-call'; } },
    { code: 'child-output-mismatch', mutate: (input) => { childOutput(input).payload.output = toolOutput('exec-1', semanticText('not-done\n')).payload.output; } },
    { code: 'child-output-mismatch', mutate: (input) => { childOutput(input).payload.output = toolOutput('exec-1', semanticText(`${expectedPublicOutput}\nprogress-after\n`)).payload.output; } },
    { code: 'child-output-mismatch', mutate: (input) => { childOutput(input).payload.output = toolOutput('exec-1', semanticText(`${expectedPublicOutput}\n${expectedPublicOutput}\n`)).payload.output; } },
    { code: 'child-output-mismatch', mutate: (input) => { childOutput(input).payload.output[0].text += `${expectedPublicOutput}\n`; } },
    { code: 'child-output-order', mutate: (input) => { const output = input.rollouts[1].splice(2, 1)[0]; input.rollouts[1].splice(1, 0, output); } },
    { code: 'child-terminal-order', mutate: (input) => { const final = input.rollouts[1].pop(); input.rollouts[1].splice(2, 0, final); } },
  ];
  for (const { code, mutate } of cases) {
    const input = fixture(); mutate(input);
    assert.throws(() => qualifyCodexRescueEvidence(input, options()), (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === code);
  }
});

test('rejects every parent companion command except the exact readiness preflight', () => {
  const commands = [
    `${expectedCommand} && true`,
    'node "/installed/zcode/skills/rescue/launcher.mjs" invoke-choice rescue fresh',
    `sh -c ${JSON.stringify(expectedCommand)}`,
  ];
  for (const command of commands) {
    const input = fixture(); input.rollouts[0].splice(-2, 0, structuredExec(command, `inline-${commands.indexOf(command)}`));
    assert.throws(() => qualifyCodexRescueEvidence(input, options()), (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'parent-inline-command');
  }
  const readOnly = fixture();
  readOnly.rollouts[0].splice(3, 0, structuredExec('sed -n \'1,80p\' skills/rescue/SKILL.md', 'skill-read'), toolOutput('skill-read', 'skill text\n'));
  assert.equal(qualifyCodexRescueEvidence(readOnly, options()).publicOutput, expectedPublicOutput);
});

test('treats every missing core runtime observation as a qualification failure', () => {
  const cases = [
    (input) => { input.rollouts = input.rollouts.slice(1); },
    (input) => { input.rollouts[0] = input.rollouts[0].filter((event) => event !== spawnEvent(input)); },
    (input) => { input.rollouts[0] = input.rollouts[0].filter((event) => event !== startEvent(input)); },
    (input) => { input.rollouts = input.rollouts.slice(0, 1); },
    (input) => { input.rollouts[1].splice(1, 1); },
    (input) => { input.rollouts[1].splice(2, 1); },
    (input) => { input.rollouts[1].pop(); },
    (input) => { input.rollouts[0].pop(); },
    (input) => { input.execFrames.pop(); },
  ];
  for (const mutate of cases) {
    const input = fixture(); mutate(input);
    assert.throws(() => qualifyCodexRescueEvidence(input, options()), (error) => error instanceof CodexRescueEvidenceMismatchError);
  }
});

test('requires exact spawn keys and safe exec envelopes in the canonical workspace', () => {
  const forbiddenKeys = ['shell', 'login', 'tty', 'sandbox_permissions', 'justification', 'prefix_rule', 'unknown'];
  const cases = [
    { mutate: (input) => { const args = JSON.parse(spawnEvent(input).payload.arguments); args.extra = true; spawnEvent(input).payload.arguments = JSON.stringify(args); }, code: 'spawn-keys-mismatch' },
    { mutate: (input) => { childExec(input).payload.input = structuredExec(expectedCommand, 'exec-1', { workdir: '/wrong' }).payload.input; }, code: 'child-exec-envelope-mismatch' },
    { mutate: (input) => { preflightEvent(input).payload.input = structuredExec(expectedPreflightCommand, 'preflight-1', { login: true }).payload.input; }, code: 'preflight-envelope-mismatch' },
    ...forbiddenKeys.map((key) => ({ mutate: (input) => { childExec(input).payload.input = structuredExec(expectedCommand, 'exec-1', { [key]: true }).payload.input; }, code: 'child-exec-envelope-mismatch' })),
    { mutate: (input) => { childExec(input).payload.input = structuredExec(expectedCommand, 'exec-1', { yield_time_ms: 31_000 }).payload.input; }, code: 'child-exec-envelope-mismatch' },
    { mutate: (input) => { childExec(input).payload.input = structuredExec(expectedCommand, 'exec-1', { max_output_tokens: 0 }).payload.input; }, code: 'child-exec-envelope-mismatch' },
  ];
  for (const { mutate, code } of cases) {
    const input = fixture(); mutate(input);
    assert.throws(() => qualifyCodexRescueEvidence(input, options()), (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === code);
  }
  const bounded = fixture(); childExec(bounded).payload.input = structuredExec(expectedCommand, 'exec-1', { yield_time_ms: 10_000, max_output_tokens: 100 }).payload.input;
  assert.equal(qualifyCodexRescueEvidence(bounded, options()).publicOutput, expectedPublicOutput);
  const privateKey = 'private_task_key'; const keyed = fixture();
  childExec(keyed).payload.input = structuredExec(expectedCommand, 'exec-1', { [privateKey]: true }).payload.input;
  assert.throws(
    () => qualifyCodexRescueEvidence(keyed, options()),
    (error) => error instanceof CodexRescueEvidenceMismatchError
      && error.code === 'child-exec-envelope-mismatch' && !error.message.includes(privateKey),
  );
});

test('requires the exact fixed spawn message for named and generic routes', () => {
  for (const route of ['named', 'generic-hidden']) {
    const input = fixture();
    const args = JSON.parse(spawnEvent(input).payload.arguments);
    if (route === 'generic-hidden') {
      delete args.agent_type;
      childMeta(input).payload.source.subagent.thread_spawn.agent_role = null;
    }
    args.message = 'almost the fixed forwarder';
    spawnEvent(input).payload.arguments = JSON.stringify(args);
    assert.throws(
      () => qualifyCodexRescueEvidence(input, options()),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'spawn-message-mismatch',
    );
  }
});

test('reports encrypted spawn message unqualified only after observable mismatches are checked', () => {
  const input = fixture();
  const args = JSON.parse(spawnEvent(input).payload.arguments);
  args.message = `gAAAA${'A'.repeat(80)}=`;
  spawnEvent(input).payload.arguments = JSON.stringify(args);
  finalExecAgentMessage(input).item.text = 'wrong final';
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options()),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'exec-public-output-mismatch',
  );
  finalExecAgentMessage(input).item.text = expectedPublicOutput;
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options()),
    (error) => error instanceof CodexRescueUnqualifiedError
      && error.code === 'spawn-message-encrypted'
      && error.evidence?.route === 'named'
      && error.evidence?.childThreadId === childId,
  );
});

test('fails missing parent thread evidence after exec was attempted', () => {
  const input = fixture();
  input.execFrames = [];
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options()),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'parent-thread-unavailable',
  );
});

test('fails instead of skipping when linked child metadata has the wrong named Role', () => {
  const input = fixture();
  childMeta(input).payload.source.subagent.thread_spawn.agent_role = null;
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options()),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'agent-role-mismatch',
  );
});

test('fails instead of skipping when observed child ID conflicts with an existing linked rollout', () => {
  const input = fixture();
  startEvent(input).payload.agent_thread_id = '019fe6e0-ffff-7192-83ba-0b0cc2c48660';
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options()),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'child-rollout-id-mismatch',
  );
});

test('accepts any bounded task name and consistently linked opaque agent path as presentation metadata', () => {
  const input = fixture();
  setPresentation(input, 'not_rescue', '/root/not_rescue');
  assert.deepEqual(
    (({ taskName: actualTaskName, agentPath: actualAgentPath }) => ({ taskName: actualTaskName, agentPath: actualAgentPath }))(qualifyCodexRescueEvidence(input, options())),
    { taskName: 'not_rescue', agentPath: '/root/not_rescue' },
  );
});

test('fails linked evidence with a second child command', () => {
  const input = fixture();
  input.rollouts[1].splice(2, 0, structuredExec(expectedCommand));
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options()),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'child-command-count',
  );
});

test('accepts the captured unquoted-key 0.147 exec wrapper as an explicit legacy variant', () => {
  const input = fixture();
  input.rollouts[1][1] = structuredExecUnquoted(expectedCommand);
  assert.equal(qualifyCodexRescueEvidence(input, options()).publicOutput, expectedPublicOutput);
  input.rollouts[1][1] = structuredExecUnquotedInline(expectedCommand);
  assert.equal(qualifyCodexRescueEvidence(input, options()).publicOutput, expectedPublicOutput);
});

test('rejects duplicate malformed nested and repeated exec command evidence', () => {
  const cases = [
    { source: `const r = await tools.exec_command({"cmd":${JSON.stringify(expectedCommand)},"cmd":"evil"});\ntext(r.output);\n`, code: 'child-command-encoding' },
    { source: `const r = await tools.exec_command({"cmd":${JSON.stringify(expectedCommand)},});\ntext(r.output);\n`, code: 'child-command-encoding' },
    { source: `const r = await tools.exec_command({"\\x":"bad","cmd":${JSON.stringify(expectedCommand)}});\ntext(r.output);\n`, code: 'child-command-encoding' },
    { source: `const r = await tools.exec_command({"metadata":{"cmd":${JSON.stringify(expectedCommand)}},"cmd":"evil"});\ntext(r.output);\n`, code: 'child-exec-envelope-mismatch' },
    { source: `const a = await tools.exec_command({"cmd":${JSON.stringify(expectedCommand)}});\nconst r = await tools.exec_command({"cmd":${JSON.stringify(expectedCommand)}});\ntext(r.output);\n`, code: 'child-command-encoding' },
  ];
  for (const { source, code } of cases) {
    const input = fixture();
    input.rollouts[1][1].payload.input = source;
    assert.throws(
      () => qualifyCodexRescueEvidence(input, options()),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === code,
    );
  }
});

test('fails an observed but unsupported function_call exec_command shape', () => {
  const input = fixture();
  input.rollouts[1][1] = { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: expectedCommand }) } };
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options()),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'child-command-shape-mismatch',
  );
});

test('fails when child-only stderr or either compatibility diagnostic enters a parent public event', () => {
  for (const forbidden of ['raw output must stay private', expectedSemanticProgress.snapshotFallback, expectedSemanticProgress.lifecycleOnly]) {
    const input = fixture();
    input.rollouts[0].splice(-2, 0, { type: 'event_msg', payload: { type: 'agent_message', message: forbidden, phase: 'commentary' } });
    assert.throws(
      () => qualifyCodexRescueEvidence(input, options()),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'parent-isolation-breach',
      forbidden,
    );
  }
});

test('fails when the parent executes the constant Rescue command inline', () => {
  const input = fixture();
  input.rollouts[0].splice(-2, 0, structuredExec(expectedCommand));
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options()),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'parent-inline-command',
  );
});

test('requires exact child, parent rollout, and exec terminal public output', () => {
  const input = fixture();
  finalExecAgentMessage(input).item.text = 'prefix done suffix';
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options()),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'exec-public-output-mismatch',
  );
});

test('rejects parent child-return and final timestamps that precede the child terminal exit', () => {
  const input = fixture();
  childReturnEvent(input).timestamp = '2026-08-10T00:00:00.000004Z';
  input.rollouts[0].find((event) => event?.payload?.phase === 'final_answer').timestamp = '2026-08-10T00:00:00.000005Z';
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options()),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'parent-terminal-timeline',
  );
});

test('fails closed when cross-rollout terminal causality lacks a trusted timestamp', () => {
  const input = fixture(); delete childReturnEvent(input).timestamp;
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options()),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'parent-terminal-timeline',
  );
});

test('terminal causality rejects impossible RFC3339 calendar, clock, and offset fields', () => {
  for (const timestamp of [
    '2025-02-29T00:00:00Z', '2024-02-30T00:00:00Z', '2024-04-31T00:00:00Z', '2024-13-01T00:00:00Z',
    '2024-01-01T24:00:00Z', '2024-01-01T00:60:00Z', '2024-01-01T00:00:60Z',
    '2024-01-01T00:00:00+24:00', '2024-01-01T00:00:00+00:60',
  ]) {
    const input = fixture(); childOutput(input).timestamp = timestamp;
    assert.throws(() => qualifyCodexRescueEvidence(input, options()), (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'parent-terminal-timeline', timestamp);
  }
});

test('terminal causality accepts valid leap day, timezone offsets, and exact nanoseconds', () => {
  const input = fixture();
  childOutput(input).timestamp = '2024-02-29T23:59:59.123456786+00:00';
  input.rollouts[1].find((event) => event?.payload?.phase === 'final_answer').timestamp = '2024-02-29T23:59:59.123456787Z';
  childReturnEvent(input).timestamp = '2024-03-01T07:59:59.123456788+08:00';
  input.rollouts[0].find((event) => event?.payload?.phase === 'final_answer').timestamp = '2024-03-01T00:00:00.000000000Z';
  assert.equal(qualifyCodexRescueEvidence(input, options()).publicOutput, expectedPublicOutput);
});

test('accepts bounded commentary agent messages before one exact final sentinel and terminal turn', () => {
  const input = fixture();
  input.execFrames.splice(-2, 0,
    execAgentMessage('working through the evidence', 'commentary-1'),
    execAgentMessage('still checking structure', 'commentary-2'));
  assert.equal(qualifyCodexRescueEvidence(input, options()).publicOutput, expectedPublicOutput);
});

test('rejects commentary before turn.started even when the final sentinel is inside the turn', () => {
  const input = fixture();
  input.execFrames.splice(1, 0, execAgentMessage('commentary before the turn', 'pre-turn-commentary'));
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options()),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'exec-terminal-order',
  );
});

test('fails ambiguous or nonterminal exec agent-message evidence', () => {
  const cases = [
    { code: 'exec-public-output-mismatch', mutate: (input) => input.execFrames.splice(-1, 0, execAgentMessage('after sentinel', 'late-message')) },
    { code: 'exec-public-output-count', mutate: (input) => input.execFrames.splice(-2, 0, execAgentMessage(expectedPublicOutput, 'duplicate-sentinel')) },
    { code: 'exec-terminal-unavailable', mutate: (input) => input.execFrames.pop() },
    { code: 'exec-turn-failed', mutate: (input) => { input.execFrames[input.execFrames.length - 1] = { type: 'turn.failed', error: { message: 'failed' } }; } },
    { code: 'exec-terminal-order', mutate: (input) => input.execFrames.push(execAgentMessage('message after terminal', 'post-terminal')) },
    { code: 'exec-turn-order', mutate: (input) => { [input.execFrames[0], input.execFrames[1]] = [input.execFrames[1], input.execFrames[0]]; } },
    { code: 'exec-terminal-shape-mismatch', mutate: (input) => { input.execFrames.at(-1).usage.extra = 1; } },
  ];
  for (const { code, mutate } of cases) {
    const input = fixture(); mutate(input);
    assert.throws(
      () => qualifyCodexRescueEvidence(input, options()),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === code,
    );
  }
});

test('rollout JSONL parser is bounded and fails closed on malformed records', () => {
  assert.deepEqual(parseCodexRolloutJsonl('{"type":"session_meta","payload":{}}\n'), [{ type: 'session_meta', payload: {} }]);
  assert.throws(
    () => parseCodexRolloutJsonl('{not-json}\n'),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'rollout-json-invalid',
  );
  assert.throws(
    () => parseCodexRolloutJsonl(`${'x'.repeat(1024 * 1024 + 1)}\n`),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'rollout-line-oversize',
  );
});

function options(overrides = {}) {
  const value = {
    expectedAgentType: 'zcode-rescue',
    expectedWorkspace,
    expectedCommand,
    expectedPreflightCommand,
    expectedPreparationCommand,
    expectedPreparationPayload,
    expectedPublicOutput,
    expectedSemanticProgress,
    expectedNamedSpawnMessage: 'fixed named forwarder',
    expectedGenericSpawnMessage: 'fixed generic forwarder',
    statusPrivacyCanaries: ['PRIVATE', 'raw output must stay private', 'reasoning must stay private'],
    forbiddenParentText: [
      'Running command: npm test', expectedSemanticProgress.snapshotFallback, expectedSemanticProgress.lifecycleOnly,
      'raw output must stay private', 'reasoning must stay private',
    ],
    ...overrides,
  };
  return value;
}

function backgroundOptions(overrides = {}) {
  return options({ expectedJobId: backgroundJobId, expectedPublicOutput: undefined, expectedSemanticProgress: undefined, privateExecutionCapability: executionCapability, publicLogs: ['bounded public log without private material'], ...overrides });
}

function fixture(publicOutput = expectedPublicOutput) {
  const childEnvelope = `Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${agentPath}\nPayload:\n${publicOutput}`;
  const execFrames = [
      { type: 'thread.started', thread_id: parentId },
      { type: 'turn.started' },
      execAgentMessage(publicOutput),
      { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5 } },
    ];
  const parent = [
      { type: 'session_meta', payload: { session_id: parentId, id: parentId, cli_version: '0.147.0', thread_source: 'user', source: 'exec' } },
      ...parentPreparationEvents(),
      { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'spawn-1', arguments: JSON.stringify({ agent_type: 'zcode-rescue', fork_turns: 'none', message: 'fixed named forwarder', task_name: taskName }) } },
      { type: 'event_msg', payload: { type: 'sub_agent_activity', event_id: 'spawn-1', agent_thread_id: childId, agent_path: agentPath, kind: 'started' } },
      { type: 'response_item', payload: { type: 'agent_message', author: agentPath, recipient: '/root', content: [{ type: 'input_text', text: childEnvelope }] } },
      { type: 'event_msg', payload: { type: 'agent_message', message: publicOutput, phase: 'final_answer' } },
    ];
  const child = [
      { type: 'session_meta', payload: { session_id: parentId, id: childId, parent_thread_id: parentId, thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1, agent_path: agentPath, agent_nickname: 'Ada', agent_role: 'zcode-rescue' } } } } },
      structuredExec(expectedCommand),
      toolOutput('exec-1', `${expectedSemanticProgress.start}\n${expectedSemanticProgress.terminal}\n${publicOutput}\n`),
      { type: 'event_msg', payload: { type: 'agent_message', message: publicOutput, phase: 'final_answer' } },
  ];
  child[2].timestamp = '2026-08-10T00:00:00.000006Z'; child[3].timestamp = '2026-08-10T00:00:00.000007Z';
  parent.find((event) => event?.payload?.author === agentPath).timestamp = '2026-08-10T00:00:00.000008Z';
  parent.find((event) => event?.payload?.phase === 'final_answer').timestamp = '2026-08-10T00:00:00.000009Z';
  return { execFrames, rollouts: [parent, child] };
}

function yieldedFixture() {
  const input = fixture();
  input.rollouts[1].splice(1, 2,
    structuredExecResult(expectedCommand, 'exec-1'),
    capturedResultEvent('exec-1', { output: `${expectedSemanticProgress.start}\n`, session_id: 41 }),
    structuredPoll(41, 'poll-1'),
    capturedResultEvent('poll-1', { output: 'still running\n', session_id: 41 }),
    structuredPoll(41, 'poll-2'),
    capturedResultEvent('poll-2', { output: `${expectedSemanticProgress.terminal}\n${expectedPublicOutput}\n`, exit_code: 0 }));
  const child = input.rollouts[1]; const parent = input.rollouts[0];
  child.find((event) => event?.payload?.call_id === 'poll-2' && event.payload.type === 'custom_tool_call_output').timestamp = '2026-08-10T00:00:00.000006Z';
  child.find((event) => event?.payload?.phase === 'final_answer').timestamp = '2026-08-10T00:00:00.000007Z';
  parent.find((event) => event?.payload?.author === agentPath).timestamp = '2026-08-10T00:00:00.000008Z';
  parent.find((event) => event?.payload?.phase === 'final_answer').timestamp = '2026-08-10T00:00:00.000009Z';
  return input;
}

function relayedYieldedFixture({ withStatus = false } = {}) {
  const input = yieldedFixture(); const child = input.rollouts[1]; const parent = input.rollouts[0];
  setCapturedOutput(child, 'exec-1', `${expectedSemanticProgress.start}\n${relayLine(1, 'starting', 'started')}\n`, 41);
  setCapturedOutput(child, 'poll-1', `${relayLine(2, 'investigating', 'tool-active')}\n`, 41);
  const firstOutput = child.find((event) => event?.payload?.call_id === 'exec-1' && event.payload.type === 'custom_tool_call_output');
  child.splice(child.indexOf(firstOutput) + 1, 0, relayCall('relay-1', 'started'), relayOutput('relay-1'));
  const firstPollOutput = child.find((event) => event?.payload?.call_id === 'poll-1' && event.payload.type === 'custom_tool_call_output');
  const additions = [relayCall('relay-2', 'tool-active'), relayOutput('relay-2')];
  if (withStatus) additions.push(structuredExecResult(expectedStatusCommand, 'status-1'), capturedResultEvent('status-1', {
    output: `${JSON.stringify({ type: 'rescue-status', status: 'running', phase: 'running', lastActivityAt: '2026-08-17T00:00:02.000Z', progressPreview: ['ZCode is working.'], terminal: false })}\n`,
    exit_code: 0,
  }));
  child.splice(child.indexOf(firstPollOutput) + 1, 0, ...additions);
  const childReturn = parent.find((event) => event?.payload?.author === agentPath);
  parent.splice(parent.indexOf(childReturn), 0,
    parentRelay(agentPath, relayMessage('started')),
    structuredWait('relay-wait-1'), waitOutput('relay-wait-1', true),
    parentRelay(agentPath, relayMessage('tool-active')),
    structuredWait('relay-wait-2'), waitOutput('relay-wait-2', false));
  return input;
}

function relayLine(sequence, phase, code) {
  return `[zcode-relay] ${JSON.stringify({ version: 1, sequence, phase, code, observedAt: `2026-08-17T00:00:0${sequence}.000Z` })}`;
}
function relayMessage(code) { return ({ started: 'ZCode Rescue started.', 'model-active': 'ZCode is generating a response.', 'tool-active': 'ZCode is working with a tool.' })[code]; }
function relayCall(callId, code) { return { type: 'response_item', payload: { type: 'function_call', name: 'send_message', call_id: callId, arguments: JSON.stringify({ target: '/root', message: relayMessage(code) }) } }; }
function relayOutput(callId) { return { type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: '' } }; }
function parentRelay(author, message, turnMarker = 'a') {
  const marker = message === relayMessage('started') ? 'a' : 'b';
  return { type: 'response_item', payload: {
    type: 'agent_message', id: `amsg_${marker.repeat(36)}`, author, recipient: '/root',
    content: [
      { type: 'input_text', text: `Message Type: MESSAGE\nTask name: /root\nSender: ${author}\nPayload:\n` },
      { type: 'encrypted_content', encrypted_content: `gAAAA${'A'.repeat(64)}` },
    ],
    internal_chat_message_metadata_passthrough: { turn_id: relayTurnId(turnMarker) },
  } };
}
function relayTurnId(marker) { return `${marker.repeat(8)}-${marker.repeat(4)}-4${marker.repeat(3)}-8${marker.repeat(3)}-${marker.repeat(12)}`; }
function relayCalls(child) { return child.filter((event) => event?.payload?.type === 'function_call' && event.payload.name === 'send_message'); }
function relayOutputs(child) { const ids = new Set(relayCalls(child).map((event) => event.payload.call_id)); return child.filter((event) => event?.payload?.type === 'function_call_output' && ids.has(event.payload.call_id)); }
function parentRelayMessages(parent) { return parent.filter((event) => event?.payload?.type === 'agent_message' && event.payload.author === agentPath && !event.payload.content?.[0]?.text?.startsWith('Message Type: FINAL_ANSWER')); }
function setCapturedOutput(child, callId, outputText, sessionId) {
  const output = child.find((event) => event?.payload?.type === 'custom_tool_call_output' && event.payload.call_id === callId);
  output.payload.output = capturedResult({ output: outputText, session_id: sessionId });
}
function statusCall(child) { return child.find((event) => event?.payload?.type === 'custom_tool_call' && event.payload.call_id === 'status-1'); }
function statusOutput(child) { return child.find((event) => event?.payload?.type === 'custom_tool_call_output' && event.payload.call_id === 'status-1'); }
function mutateStatusSnapshot(child, mutate) {
  const event = statusOutput(child); const captured = JSON.parse(event.payload.output[1].text); const value = JSON.parse(captured.output);
  mutate(value); captured.output = `${JSON.stringify(value)}\n`; event.payload.output = capturedResult(captured);
}

function setYieldedHandle(input, handle) {
  const calls = childPolls(input); const outputs = input.rollouts[1].filter((event) => event.payload?.type === 'custom_tool_call_output');
  outputs[0].payload.output = capturedResult({ output: `${expectedSemanticProgress.start}\n`, session_id: handle });
  outputs[1].payload.output = capturedResult({ output: 'still running\n', session_id: handle });
  calls[0].payload.input = structuredPoll(handle, calls[0].payload.call_id).payload.input;
  calls[1].payload.input = structuredPoll(handle, calls[1].payload.call_id).payload.input;
}

function backgroundFixture() { const input = fixture(backgroundPublicOutput); childOutput(input).payload.output = [{ type: 'input_text', text: `${backgroundPublicOutput}\n` }]; return input; }

function setPresentation(input, nextTaskName, nextAgentPath) {
  const spawn = spawnEvent(input);
  const args = JSON.parse(spawn.payload.arguments);
  args.task_name = nextTaskName;
  spawn.payload.arguments = JSON.stringify(args);
  const acknowledgement = parentOutput(input, 'prepare-write-1');
  acknowledgement.payload.output = capturedResult({ output: preparedAck({ version: 1, action: 'spawn', taskName: nextTaskName }), exit_code: 0 });
  const previousAgentPath = startEvent(input).payload.agent_path;
  startEvent(input).payload.agent_path = nextAgentPath;
  childMeta(input).payload.source.subagent.thread_spawn.agent_path = nextAgentPath;
  for (const event of input.rollouts[0].filter((candidate) => candidate?.payload?.type === 'agent_message'
    && candidate.payload.recipient === '/root' && candidate.payload.author === previousAgentPath)) {
    event.payload.author = nextAgentPath;
    for (const content of event.payload.content ?? []) {
      if (content?.type === 'input_text') content.text = content.text.replace(`Sender: ${previousAgentPath}\n`, `Sender: ${nextAgentPath}\n`);
    }
  }
  const listCallIds = new Set(input.rollouts[0]
    .filter((event) => event?.payload?.type === 'function_call' && event.payload.name === 'list_agents')
    .map((event) => event.payload.call_id));
  for (const output of input.rollouts[0].filter((event) => event?.payload?.type === 'function_call_output'
    && listCallIds.has(event.payload.call_id))) {
    const state = JSON.parse(output.payload.output);
    for (const entry of state.agents ?? []) {
      if (entry?.agent_name === previousAgentPath) entry.agent_name = nextAgentPath;
    }
    output.payload.output = JSON.stringify(state);
  }
  return input;
}

function choiceOptions(choice, overrides = {}) {
  return {
    expectedChoice: choice,
    expectedParentThreadId: parentId,
    expectedAgentType: 'zcode-rescue',
    expectedWorkspace,
    expectedInitialCommand: expectedCommand,
    expectedNamedSpawnMessage: 'fixed named forwarder',
    expectedGenericSpawnMessage: 'fixed generic forwarder',
    expectedPreflightCommand,
    expectedPreparationCommand,
    expectedPreparationPayload,
    expectedChoiceCommand: `node "/installed/zcode/skills/rescue/launcher.mjs" invoke-choice rescue ${choice}`,
    expectedFollowupMessage: `Continue the pending ZCode Rescue with ${choice}. Run only the installed ${choice} forwarder command and return its public stdout verbatim.`,
    expectedPublicOutput,
    statusPrivacyCanaries: ['PRIVATE', 'raw output must stay private', 'reasoning must stay private'],
    ...overrides,
  };
}

function choiceFixture(choice) {
  const needsChoice = `${JSON.stringify({ type: 'needs-choice', candidate: { sessionId: 'resumable-session' }, choices: ['--resume', '--fresh'] })}\n`;
  const firstEnvelope = `Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${agentPath}\nPayload:\n${needsChoice}`;
  const secondEnvelope = `Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${agentPath}\nPayload:\n${expectedPublicOutput}`;
  const parent = [
    { type: 'session_meta', payload: { session_id: parentId, id: parentId, cli_version: '0.147.0', thread_source: 'user', source: 'exec' } },
    ...parentPreparationEvents(),
    structuredSpawn('spawn-1'),
    { type: 'event_msg', payload: { type: 'sub_agent_activity', event_id: 'spawn-1', agent_thread_id: childId, agent_path: agentPath, kind: 'started' } },
    structuredWait('wait-1'),
    waitOutput('wait-1', false),
    { type: 'response_item', payload: { type: 'agent_message', author: agentPath, recipient: '/root', content: [{ type: 'input_text', text: firstEnvelope }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: `${needsChoice}Choose resume or fresh.`, phase: 'final_answer' } },
    structuredFollowup('followup-1', choice),
    followupOutput('followup-1'),
    structuredWait('wait-2'),
    waitOutput('wait-2', false),
    { type: 'response_item', payload: { type: 'agent_message', author: agentPath, recipient: '/root', content: [{ type: 'input_text', text: secondEnvelope }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: expectedPublicOutput, phase: 'final_answer' } },
  ];
  const child = [
    { type: 'session_meta', payload: { session_id: parentId, id: childId, parent_thread_id: parentId, thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1, agent_path: agentPath, agent_nickname: 'Ada', agent_role: 'zcode-rescue' } } } } },
    structuredExecResult(expectedCommand, 'exec-1'),
    capturedResultEvent('exec-1', { output: needsChoice, exit_code: 3 }),
    { type: 'event_msg', payload: { type: 'agent_message', message: needsChoice, phase: 'final_answer' } },
    structuredExecResult(choiceOptions(choice).expectedChoiceCommand, 'exec-2'),
    capturedResultEvent('exec-2', { output: `${expectedPublicOutput}\n`, exit_code: 0 }),
    { type: 'event_msg', payload: { type: 'agent_message', message: expectedPublicOutput, phase: 'final_answer' } },
  ];
  const at = (event, offset) => { event.timestamp = new Date(Date.parse('2026-08-10T00:00:00.000Z') + offset).toISOString(); };
  const childFinals = child.filter((event) => event?.payload?.phase === 'final_answer');
  const parentReturns = parent.filter((event) => event?.payload?.author === agentPath);
  const parentFinals = parent.filter((event) => event?.payload?.phase === 'final_answer');
  at(child[1], 4); at(child[2], 5); at(childFinals[0], 6); at(parentReturns[0], 7); at(parentFinals[0], 8);
  at(choiceFollowup({ rollouts: [parent, child] }), 9); at(followupResult({ rollouts: [parent, child] }), 10);
  at(child.find((event) => event?.payload?.call_id === 'exec-2' && event.payload.type === 'custom_tool_call'), 11);
  at(child.find((event) => event?.payload?.call_id === 'exec-2' && event.payload.type === 'custom_tool_call_output'), 12);
  at(childFinals[1], 13); at(parentReturns[1], 14); at(parentFinals[1], 15);
  return { rollouts: [parent, child] };
}

function preparedContinuationFixture(route, execution = 'foreground') {
  const message = route === 'named' ? expectedNamedRescueMessage : expectedGenericRescueMessage;
  const anchorJobId = 'a'.repeat(64); const currentJobId = 'c'.repeat(64); const operationId = 'd'.repeat(64);
  const binding = createRescueBinding({ parentSessionId: parentId, executorAgentId: childId,
    executorAgentType: route === 'named' ? 'zcode-rescue' : 'default', executorParentTurnId: 'turn-original',
    executorParentPermissionMode: 'acceptEdits', workspace: expectedWorkspace, permissionMode: 'acceptEdits',
    anchorJobId, currentJobId, operationId, now: '2026-08-10T00:00:00.000Z' });
  binding.updatedAt = '2026-08-10T01:01:03.000Z';
  const preReservationBinding = { ...binding, currentJobId: anchorJobId, updatedAt: '2026-08-10T00:00:05.000Z' };
  const parent = [
    { type: 'session_meta', payload: { id: parentId, session_id: parentId, thread_source: 'user', source: 'exec' } },
    { ...structuredExecResult(expectedPreparationCommand, 'prepare-1', { tty: true, env: { PATH: '/usr/bin' } }), timestamp: '2026-08-10T00:00:00.250Z' },
    { ...capturedResultEvent('prepare-1', { output: PREPARATION_READY, session_id: 71 }), timestamp: '2026-08-10T00:00:00.400Z' },
    { ...structuredPoll(71, 'prepare-write-1', `${JSON.stringify(preparationEnvelope('explicit', 'fresh', execution))}\n`), timestamp: '2026-08-10T00:00:00.500Z' },
    { ...capturedResultEvent('prepare-write-1', { output: preparedAck({ version: 1, action: 'spawn', taskName }), exit_code: 0 }), timestamp: '2026-08-10T00:00:00.750Z' },
    { type: 'response_item', timestamp: '2026-08-10T00:00:01.000Z', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'spawn-1', arguments: JSON.stringify({ task_name: taskName, message, fork_turns: 'none', ...(route === 'named' ? { agent_type: 'zcode-rescue' } : {}) }) } },
    { type: 'event_msg', timestamp: '2026-08-10T00:00:02.000Z', payload: { type: 'sub_agent_activity', kind: 'started', event_id: 'spawn-1', agent_thread_id: childId, agent_path: agentPath, parent_turn_id: 'turn-original' } },
    { type: 'response_item', timestamp: '2026-08-10T00:00:02.250Z', payload: { type: 'function_call_output', call_id: 'spawn-1', output: JSON.stringify({ agent_id: childId }) } },
    { type: 'event_msg', timestamp: '2026-08-10T00:00:05.000Z', payload: { type: 'sub_agent_activity', kind: 'stopped', agent_thread_id: childId, agent_path: agentPath, parent_turn_id: 'turn-original' } },
    { ...structuredExecResult(expectedPreparationCommand, 'prepare-2', { tty: true }), timestamp: '2026-08-10T01:01:00.000Z' },
    { ...capturedResultEvent('prepare-2', { output: PREPARATION_READY, session_id: 72 }), timestamp: '2026-08-10T01:01:00.250Z' },
    { ...structuredPoll(72, 'prepare-write-2', `${JSON.stringify(preparationEnvelope('proactive', 'resume', execution))}\n`), timestamp: '2026-08-10T01:01:00.500Z' },
    { ...capturedResultEvent('prepare-write-2', { output: preparedAck({ version: 2, action: 'followup', target: agentPath, assignment: route === 'named' ? 'zcode-rescue' : 'default' }), exit_code: 0 }), timestamp: '2026-08-10T01:01:01.000Z' },
    { type: 'response_item', timestamp: '2026-08-10T01:01:02.000Z', payload: { type: 'function_call', name: 'followup_task', call_id: 'followup-1', arguments: JSON.stringify({ target: agentPath, message }) } },
    { type: 'response_item', timestamp: '2026-08-10T01:01:03.000Z', payload: { type: 'function_call_output', call_id: 'followup-1', output: JSON.stringify({ accepted: true, target: agentPath }) } },
  ];
  for (const event of parent.slice(1)) event.turn_id = 'turn-original';
  const child = [
    { type: 'session_meta', payload: { id: childId, session_id: parentId, parent_thread_id: parentId, thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: parentId, agent_path: agentPath, agent_role: route === 'named' ? 'zcode-rescue' : null } } } } },
    structuredExecResult(expectedCommand, 'invoke-1'), capturedResultEvent('invoke-1', { output: 'initial done\n', exit_code: 0 }),
    { type: 'event_msg', timestamp: '2026-08-10T00:00:04.000Z', payload: { type: 'agent_message', phase: 'final_answer', message: 'initial done' } },
    structuredExecResult(expectedCommand, 'invoke-2'), capturedResultEvent('invoke-2', { output: 'continued\n', exit_code: 0 }),
    { type: 'event_msg', timestamp: '2026-08-10T01:01:06.000Z', payload: { type: 'agent_message', phase: 'final_answer', message: 'continued' } },
  ];
  child[1].timestamp = '2026-08-10T00:00:03.000Z'; child[2].timestamp = '2026-08-10T00:00:03.500Z'; child[4].timestamp = '2026-08-10T01:01:04.000Z'; child[5].timestamp = '2026-08-10T01:01:05.000Z';
  child[1].turn_id = child[2].turn_id = 'invoke-original'; child[4].turn_id = child[5].turn_id = 'invoke-continuation';
  return {
    route, execution, expected: { parentSessionId: parentId, childThreadId: childId, agentPath, workspace: expectedWorkspace,
      permissionMode: 'acceptEdits', originalParentTurnId: 'turn-original', continuationParentTurnId: 'turn-original' },
    parentRolloutJson: JSON.stringify(parent), childRolloutJson: JSON.stringify(child),
    execFramesJson: JSON.stringify([
      { type: 'thread.started', thread_id: parentId },
      { type: 'item.completed', item: { type: 'agent_message', text: 'continuation complete' } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } },
    ]),
    hookLifecycleJson: JSON.stringify([
      { hook_event_name: 'UserPromptSubmit', session_id: parentId, turn_id: 'turn-original', cwd: expectedWorkspace, permission_mode: 'acceptEdits' },
      { hook_event_name: 'SubagentStart', session_id: parentId, turn_id: 'child-turn', parent_turn_id: 'turn-original', cwd: expectedWorkspace, permission_mode: 'acceptEdits', agent_id: childId, agent_type: route === 'named' ? 'zcode-rescue' : 'default' },
      { hook_event_name: 'SubagentStop', session_id: parentId, turn_id: 'child-turn', parent_turn_id: 'turn-original', cwd: expectedWorkspace, permission_mode: 'acceptEdits', agent_id: childId, agent_type: route === 'named' ? 'zcode-rescue' : 'default' },
    ]),
    executorRecordBytes: `${JSON.stringify({ kind: 'subagent-executor', agentId: childId, agentType: route === 'named' ? 'zcode-rescue' : 'default', parentSessionId: parentId, parentTurnId: 'turn-original', parentPermissionMode: 'acceptEdits', childTurnId: 'child-turn', workspace: expectedWorkspace, active: false, createdAt: '2026-08-08T00:00:00.000Z' })}\n`,
    activeTurnRecordBytes: `${JSON.stringify(activeTurnRecord(parentId, 'turn-original', expectedWorkspace))}\n`,
    bindingAuthorityBytes: `${JSON.stringify(createRescueBindingAuthority({ parentSessionId: parentId, workspace: expectedWorkspace, createdAt: '2026-08-10T00:00:00.000Z' }))}\n`,
    bindingPreReservationBytes: `${JSON.stringify(createRescueBindingPartition({ parentSessionId: parentId, workspace: expectedWorkspace, records: [preReservationBinding] }))}\n`,
    bindingPartitionBytes: `${JSON.stringify(createRescueBindingPartition({ parentSessionId: parentId, workspace: expectedWorkspace, records: [binding] }))}\n`,
    preparationRecordBytesJson: JSON.stringify([
      `${JSON.stringify(preparationRecord('turn-original', 1, 'explicit', 'fresh', execution, null, childId))}\n`,
      `${JSON.stringify(preparationRecord('turn-original', 2, 'proactive', 'resume', execution, childId, childId, {
        kind: 'reactivate', executorAgentId: childId, agentPathDigest: createHash('sha256').update(agentPath).digest('hex'),
        bindingKey: binding.key, operationId: binding.operationId, anchorJobId: binding.anchorJobId, currentJobId: preReservationBinding.currentJobId,
        bindingUpdatedAt: preReservationBinding.updatedAt, zcodeSessionId: 'zcode-session-original',
      }))}\n`,
    ]),
    jobRecordBytesJson: JSON.stringify([
      `${JSON.stringify(rawJob(anchorJobId, 'turn-original', 'succeeded', { zcodeSessionId: 'zcode-session-original', updatedAt: '2026-08-10T00:00:05.000Z' }))}\n`,
      `${JSON.stringify(rawJob(currentJobId, 'turn-original', execution === 'background' ? 'queued' : 'succeeded', { createdAt: '2026-08-10T01:01:03.000Z', updatedAt: '2026-08-10T01:01:06.000Z', ...(execution === 'background' ? { childPid: 12345, workerLeaseId: 'e'.repeat(64) } : {}) }))}\n`,
    ]),
    fakePeerJson: JSON.stringify([{ id: 1, method: 'session/create', params: { workspace: { workspacePath: expectedWorkspace, workspaceKey: expectedWorkspace } } }, { id: 2, method: 'session/send', params: { sessionId: 'zcode-session-original', inputId: 'input-original', queryId: 'input-original', content: 'initial objective' } }, { id: 3, method: 'session/resume', params: { sessionId: 'zcode-session-original' } }, { id: 4, method: 'session/send', params: { sessionId: 'zcode-session-original', inputId: 'input-continuation', queryId: 'input-continuation', content: 'continuation objective' } }]),
    ...(execution === 'background' ? { backgroundObserverJson: JSON.stringify({ executionCapability: 'capability-private', jobId: currentJobId }) } : {}),
  };
}

function restoredChildFixture({ originWorkspace, executionWorkspace, agentPath: restoredPath, launcherCommand, route = 'named' }) {
  const activation = { kind: 'reactivate', executorAgentId: childId, agentPathDigest: createHash('sha256').update(restoredPath).digest('hex') };
  const agentRole = route === 'named' ? 'zcode-rescue' : null; const agentType = route === 'named' ? 'zcode-rescue' : 'default';
  const assignment = route === 'named' ? expectedNamedRescueMessage : expectedGenericRescueMessage.replaceAll('<rescue-launcher-command>', launcherCommand);
  const thread = restoredRawCodexChild({ originWorkspace, restoredPath, agentRole });
  const preparedRoute = { version: 2, action: 'followup', target: restoredPath, assignment: agentType };
  const generationId = '9'.repeat(64); const childTurnId = 'qualification-child-turn-7'; const privateTask = 'diagnose the agent path collision without any fallback';
  const preparationEnvelope = { version: 2, source: 'proactive', task: privateTask, options: { execution: 'foreground', resume: 'resume' },
    continuationTarget: { childId, agentPath: restoredPath } };
  const preparationCreatedAt = '2026-08-10T01:00:00.550Z'; const preparationConsumedAt = '2026-08-10T01:00:00.950Z';
  const preparationRecord = { version: 3, key: createHash('sha256').update(JSON.stringify([parentId, 'turn-resumed', executionWorkspace, 'rescue'])).digest('hex'),
    sessionId: parentId, turnId: 'turn-resumed', workspace: executionWorkspace, permissionMode: 'acceptEdits', source: 'proactive', envelope: preparationEnvelope,
    generation: 1, requiredExecutorAgentId: null, activation, createdAt: preparationCreatedAt, expiresAt: '2026-08-10T01:30:00.550Z',
    consumedAt: preparationConsumedAt, executorAgentId: childId };
  const spawnArguments = { fork_turns: 'none', task_name: restoredPath.slice('/root/'.length), message: assignment, ...(route === 'named' ? { agent_type: 'zcode-rescue' } : {}) };
  const roleCommand = `${launcherCommand} role-status rescue`; const prepareCommand = `${launcherCommand} prepare rescue`; const invokeCommand = `${launcherCommand} invoke-prepared rescue`;
  return {
    expected: { parentSessionId: parentId, childThreadId: childId, agentPath: restoredPath, originalParentTurnId: 'turn-original',
      resumedParentTurnId: 'turn-resumed', originWorkspace, executionWorkspace, permissionMode: 'acceptEdits', launcherCommand,
      publicOutput: 'fake restored response: agent path collision diagnosed', zcodeSessionId: 'exact-task-2-session' },
    parentRolloutJson: JSON.stringify([
      { type: 'session_meta', payload: { id: parentId, session_id: parentId, thread_source: 'user' } },
      { type: 'response_item', turn_id: 'turn-original', timestamp: '2026-08-10T00:00:00.100Z', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'spawn-original', arguments: JSON.stringify(spawnArguments) } },
      { type: 'response_item', turn_id: 'turn-original', timestamp: '2026-08-10T00:00:00.200Z', payload: { type: 'function_call_output', call_id: 'spawn-original', output: JSON.stringify({ agent_id: childId }) } },
      { type: 'response_item', turn_id: 'turn-original', timestamp: '2026-08-10T00:00:00.300Z', payload: { type: 'sub_agent_activity', kind: 'started', event_id: 'spawn-original', agent_thread_id: childId, agent_path: restoredPath, parent_turn_id: 'turn-original' } },
      { type: 'response_item', turn_id: 'turn-original', timestamp: '2026-08-10T00:10:00.000Z', payload: { type: 'sub_agent_activity', kind: 'stopped', agent_thread_id: childId, agent_path: restoredPath, parent_turn_id: 'turn-original' } },
      { ...structuredExecResult(roleCommand, 'role-restored', { workdir: executionWorkspace }), turn_id: 'turn-resumed', timestamp: '2026-08-10T01:00:00.100Z' },
      { ...capturedResultEvent('role-restored', { output: `${JSON.stringify({ type: 'role-status', role: 'zcode-rescue', status: 'ready' })}\n`, exit_code: 0 }), turn_id: 'turn-resumed', timestamp: '2026-08-10T01:00:00.200Z' },
      { ...structuredExecResult(prepareCommand, 'prepare-restored', { workdir: executionWorkspace, tty: true }), turn_id: 'turn-resumed', timestamp: '2026-08-10T01:00:00.300Z' },
      { ...capturedResultEvent('prepare-restored', { output: PREPARATION_READY, session_id: 91 }), turn_id: 'turn-resumed', timestamp: '2026-08-10T01:00:00.400Z' },
      { ...structuredPoll(91, 'prepare-write-restored', `${JSON.stringify(preparationEnvelope)}\n`), turn_id: 'turn-resumed', timestamp: '2026-08-10T01:00:00.500Z' },
      { ...capturedResultEvent('prepare-write-restored', { output: preparedAck(preparedRoute), exit_code: 0 }), turn_id: 'turn-resumed', timestamp: '2026-08-10T01:00:00.600Z' },
      { type: 'response_item', turn_id: 'turn-resumed', timestamp: '2026-08-10T01:00:00.700Z', payload: { type: 'function_call', name: 'followup_task', call_id: 'followup-restored', arguments: JSON.stringify({ target: restoredPath, message: assignment }) } },
      { type: 'response_item', turn_id: 'turn-resumed', timestamp: '2026-08-10T01:00:00.800Z', payload: { type: 'function_call_output', call_id: 'followup-restored', output: JSON.stringify({ accepted: true, target: restoredPath }) } },
    ]),
    appServerTranscriptJson: JSON.stringify(restoredAppServerTranscript(thread)),
    hookLifecycleJson: JSON.stringify([
      { hook_event_name: 'SubagentStart', session_id: parentId, turn_id: childTurnId, parent_turn_id: 'turn-original', cwd: originWorkspace, permission_mode: 'acceptEdits', agent_id: childId, agent_type: agentType },
      { hook_event_name: 'SubagentStop', session_id: parentId, turn_id: childTurnId, parent_turn_id: 'turn-original', cwd: originWorkspace, permission_mode: 'acceptEdits', agent_id: childId, agent_type: agentType },
    ]),
    executorRecordBytes: `${JSON.stringify({ kind: 'subagent-executor', agentId: childId, agentType, parentSessionId: parentId, parentGenerationId: generationId,
      parentTurnId: 'turn-original', parentPermissionMode: 'acceptEdits', childTurnId, originWorkspace, workspace: executionWorkspace, active: false, createdAt: '2026-08-10T00:00:00.350Z' })}\n`,
    preparationRecordBytes: `${JSON.stringify(preparationRecord)}\n`,
    childRolloutJson: JSON.stringify([
      { ...structuredExecResult(invokeCommand, 'invoke-restored', { workdir: originWorkspace }), turn_id: 'child-turn-resumed', timestamp: '2026-08-10T01:00:00.900Z', thread_id: childId },
      { ...capturedResultEvent('invoke-restored', { output: 'fake restored response: agent path collision diagnosed', exit_code: 0 }), turn_id: 'child-turn-resumed', timestamp: '2026-08-10T01:00:01.000Z', thread_id: childId },
    ]),
    fakePeerJson: JSON.stringify([
      { method: 'session/resume', params: { sessionId: 'exact-task-2-session', workspace: { workspacePath: executionWorkspace } } },
      { method: 'session/send', params: { sessionId: 'exact-task-2-session', response: 'fake restored response: agent path collision diagnosed' } },
    ]),
  };
}

function restoredRawCodexChild({ originWorkspace, restoredPath, agentRole, id = childId }) {
  return { id, sessionId: parentId, parentThreadId: parentId, ephemeral: false, preview: '', projectId: null, historyMode: 'legacy',
    modelProvider: 'openai', createdAt: 1, updatedAt: 2, recencyAt: 2, status: { type: 'notLoaded' }, path: null, cwd: originWorkspace,
    source: { subAgent: { thread_spawn: { parent_thread_id: parentId, depth: 1, agent_path: restoredPath, agent_nickname: null, agent_role: agentRole } } },
    canAcceptDirectInput: null, threadSource: null, agentNickname: null, agentRole, gitInfo: null, name: null, turns: [] };
}
function restoredAppServerTranscript(thread) {
  const activated = structuredClone(thread);
  activated.updatedAt = 3; activated.recencyAt = 3; activated.status = { type: 'active', activeFlags: [] };
  return [
    { direction: 'request', observedAt: '2026-08-10T01:00:00.310Z', id: 1, method: 'thread/list', params: { sourceKinds: ['subAgentThreadSpawn'], limit: 100, sortKey: 'created_at', sortDirection: 'desc' } },
    { direction: 'response', observedAt: '2026-08-10T01:00:00.320Z', id: 1, result: { data: [thread], nextCursor: null, backwardsCursor: null } },
    { direction: 'request', observedAt: '2026-08-10T01:00:00.910Z', id: 2, method: 'thread/read', params: { threadId: childId, includeTurns: false } },
    { direction: 'response', observedAt: '2026-08-10T01:00:00.920Z', id: 2, result: { thread: activated } },
  ];
}

const PREPARATION_READY = `${JSON.stringify({ type: 'preparation-input-ready', command: 'rescue' })}\n`;
function preparedAck(route) { return `${JSON.stringify({ type: 'prepared', command: 'rescue', route })}\n`; }
function preparationEnvelope(source, resume, execution) {
  return { version: 2, source, task: source === 'explicit' ? 'repair fixture' : 'continue fixture', options: { execution, resume },
    continuationTarget: resume === 'resume' ? { childId, agentPath } : null };
}
function preparationRecord(turnId, generation, source, resume, execution, requiredExecutorAgentId, executorAgentId, reactivation = null) {
  const key = createHash('sha256').update(JSON.stringify([parentId, turnId, expectedWorkspace, 'rescue'])).digest('hex');
  const createdAt = generation === 1 ? '2026-08-10T00:00:00.600Z' : '2026-08-10T01:01:00.600Z';
  const expiresAt = generation === 1 ? '2026-08-10T00:30:00.600Z' : '2026-08-10T01:31:00.600Z';
  const consumedAt = generation === 1 ? '2026-08-10T00:00:03.000Z' : '2026-08-10T01:01:04.000Z';
  const activation = generation === 1
    ? { kind: 'spawn', taskName, agentPathDigest: createHash('sha256').update(agentPath).digest('hex') }
    : reactivation;
  return { version: 3, key, sessionId: parentId, turnId, workspace: expectedWorkspace, permissionMode: 'acceptEdits', source,
    envelope: preparationEnvelope(source, resume, execution), generation, requiredExecutorAgentId,
    activation, createdAt, expiresAt, consumedAt, executorAgentId };
}

function activeTurnRecord(sessionId, turnId, workspace) {
  return { version: 2, kind: 'active-turn', key: createHash('sha256').update(JSON.stringify([sessionId, workspace])).digest('hex'),
    sessionId, turnId, workspace, permissionMode: 'acceptEdits', prompt: '$zcode:rescue repair fixture', createdAt: '2026-08-09T23:59:59.000Z' };
}

function workspaceBoundContinuationFixture(originWorkspace, executionWorkspace) {
  const input = preparedContinuationFixture('named');
  for (const field of ['parentRolloutJson', 'childRolloutJson', 'fakePeerJson']) {
    input[field] = JSON.stringify(replaceCapturedWorkspace(JSON.parse(input[field]), expectedWorkspace, executionWorkspace));
  }
  input.expected.workspace = executionWorkspace;
  input.expected.originWorkspace = originWorkspace;
  input.expected.executionWorkspace = executionWorkspace;
  const child = JSON.parse(input.childRolloutJson);
  for (const row of child.filter((event) => event?.payload?.type === 'custom_tool_call')) {
    const host = parseFixtureHostInput(row.payload.input);
    if (host.cmd === expectedCommand) host.workdir = originWorkspace;
    row.payload.input = fixtureExecInput(host);
  }
  input.childRolloutJson = JSON.stringify(child);
  const hooks = JSON.parse(input.hookLifecycleJson);
  for (const hook of hooks) hook.cwd = originWorkspace;
  input.hookLifecycleJson = JSON.stringify(hooks);
  const preparations = JSON.parse(input.preparationRecordBytesJson).map((bytes) => {
    const record = JSON.parse(bytes); record.workspace = executionWorkspace;
    record.key = createHash('sha256').update(JSON.stringify([record.sessionId, record.turnId, executionWorkspace, 'rescue'])).digest('hex');
    return `${JSON.stringify(record)}\n`;
  });
  input.preparationRecordBytesJson = JSON.stringify(preparations);
  const jobs = JSON.parse(input.jobRecordBytesJson).map((bytes) => { const record = JSON.parse(bytes); record.workspace = executionWorkspace; return `${JSON.stringify(record)}\n`; });
  input.jobRecordBytesJson = JSON.stringify(jobs);
  const currentPartition = JSON.parse(input.bindingPartitionBytes); const current = currentPartition.records[0];
  const rebound = createRescueBinding({ parentSessionId: parentId, executorAgentId: childId, executorAgentType: 'zcode-rescue',
    executorParentTurnId: 'turn-original', executorParentPermissionMode: 'acceptEdits', workspace: executionWorkspace,
    permissionMode: 'acceptEdits', anchorJobId: current.anchorJobId, currentJobId: current.currentJobId, operationId: current.operationId,
    now: current.createdAt });
  rebound.updatedAt = current.updatedAt;
  const pre = { ...rebound, currentJobId: rebound.anchorJobId, updatedAt: '2026-08-10T00:00:05.000Z' };
  const reboundPreparations = JSON.parse(input.preparationRecordBytesJson); const reboundContinuation = JSON.parse(reboundPreparations[1]);
  reboundContinuation.activation = { ...reboundContinuation.activation, bindingKey: rebound.key, operationId: rebound.operationId,
    anchorJobId: rebound.anchorJobId, currentJobId: pre.currentJobId, bindingUpdatedAt: pre.updatedAt };
  reboundPreparations[1] = `${JSON.stringify(reboundContinuation)}\n`; input.preparationRecordBytesJson = JSON.stringify(reboundPreparations);
  input.bindingAuthorityBytes = `${JSON.stringify(createRescueBindingAuthority({ parentSessionId: parentId, workspace: executionWorkspace, createdAt: '2026-08-10T00:00:00.000Z' }))}\n`;
  input.bindingPreReservationBytes = `${JSON.stringify(createRescueBindingPartition({ parentSessionId: parentId, workspace: executionWorkspace, records: [pre] }))}\n`;
  input.bindingPartitionBytes = `${JSON.stringify(createRescueBindingPartition({ parentSessionId: parentId, workspace: executionWorkspace, records: [rebound] }))}\n`;
  const generationId = '9'.repeat(64);
  const globalKey = createHash('sha256').update(JSON.stringify([parentId])).digest('hex');
  const unbound = { version: 3, kind: 'active-turn', key: globalKey, sessionId: parentId, generationId, turnId: 'turn-original',
    originWorkspace, executionWorkspace: null, permissionMode: 'acceptEdits', prompt: '$zcode:rescue repair fixture',
    createdAt: '2026-08-09T23:59:59.000Z', status: 'active' };
  const pending = { ...unbound, status: 'pending' }; const bound = { ...unbound, executionWorkspace };
  input.activeTurnRecordBytes = `${JSON.stringify(bound)}\n`;
  input.authorityTransitionBytesJson = JSON.stringify([pending, unbound, unbound, bound].map((record) => `${JSON.stringify(record)}\n`));
  input.roleStatusEvidenceJson = JSON.stringify({ command: 'role-status rescue', workspace: executionWorkspace,
    activeBytesBefore: `${JSON.stringify(unbound)}\n`, activeBytesAfter: `${JSON.stringify(unbound)}\n`, mtimeBefore: 1, mtimeAfter: 1,
    result: { type: 'role-status', role: 'zcode-rescue', status: 'ready' } });
  input.originIndexRecordBytes = `${JSON.stringify({ version: 1, kind: 'active-turn-index',
    key: createHash('sha256').update(JSON.stringify([parentId, originWorkspace])).digest('hex'), sessionId: parentId,
    generationId, globalKey, originWorkspace })}\n`;
  input.executorRouteRecordBytes = `${JSON.stringify({ version: 1, kind: 'executor-route', agentId: childId,
    agentType: 'zcode-rescue', parentSessionId: parentId, parentGenerationId: generationId, parentTurnId: 'turn-original',
    parentPermissionMode: 'acceptEdits', childTurnId: 'child-turn', originWorkspace, targetWorkspace: executionWorkspace,
    state: 'stopped', createdAt: '2026-08-10T00:00:02.000Z', updatedAt: '2026-08-10T00:00:05.000Z' })}\n`;
  input.executorRecordBytes = `${JSON.stringify({ kind: 'subagent-executor', agentId: childId, agentType: 'zcode-rescue',
    parentSessionId: parentId, parentGenerationId: generationId, parentTurnId: 'turn-original', parentPermissionMode: 'acceptEdits',
    childTurnId: 'child-turn', originWorkspace, workspace: executionWorkspace, active: false, createdAt: '2026-08-10T00:00:02.000Z' })}\n`;
  input.authorityLifecycleJson = JSON.stringify([
    ['session-start', originWorkspace, null, '2026-08-09T23:59:58.000Z'],
    ['user-prompt', originWorkspace, null, '2026-08-09T23:59:59.000Z'],
    ['pending', originWorkspace, generationId, '2026-08-09T23:59:59.100Z'],
    ['active-unbound', originWorkspace, generationId, '2026-08-09T23:59:59.200Z'],
    ['role-preview', executionWorkspace, generationId, '2026-08-10T00:00:00.100Z'],
    ['prepare', executionWorkspace, generationId, '2026-08-10T00:00:00.250Z'],
    ['active-bound', executionWorkspace, generationId, '2026-08-10T00:00:00.300Z'],
    ['subagent-start', originWorkspace, generationId, '2026-08-10T00:00:02.000Z'],
    ['peer-create', executionWorkspace, generationId, '2026-08-10T00:00:02.500Z'],
    ['authority-revoked', originWorkspace, generationId, '2026-08-10T01:02:00.000Z'],
    ['target-cleanup', executionWorkspace, generationId, '2026-08-10T01:02:00.100Z'],
  ].map(([phase, workspace, generation, at]) => ({ phase, workspace, ...(generation === null ? {} : { generationId: generation }), at })));
  attachWorkspaceArtifactLocations(input, originWorkspace, executionWorkspace, generationId);
  return input;
}

function attachWorkspaceArtifactLocations(input, originWorkspace, executionWorkspace, generationId) {
  const originKey = createHash('sha256').update(originWorkspace).digest('hex');
  const executionKey = createHash('sha256').update(executionWorkspace).digest('hex');
  const routeKey = createHash('sha256').update(JSON.stringify(['executor-route', parentId, 'child-turn'])).digest('hex');
  const forwardKey = createHash('sha256').update(JSON.stringify(['forward', parentId, 'child-turn'])).digest('hex');
  const executorKey = createHash('sha256').update(JSON.stringify(['executor', childId])).digest('hex');
  const preparationBytes = JSON.parse(input.preparationRecordBytesJson);
  const preparationKey = JSON.parse(preparationBytes[0]).key;
  const authority = JSON.parse(input.bindingAuthorityBytes); const partitionBytes = [input.bindingPreReservationBytes, input.bindingPartitionBytes];
  const forwardBytes = `${JSON.stringify({ kind: 'forwarding', sessionId: parentId, generationId, turnId: 'child-turn', agentId: childId,
    active: false, targetWorkspace: executionWorkspace, updatedAt: '2026-08-10T00:00:05.000Z' })}\n`;
  input.artifactLocationsJson = JSON.stringify([
    { role: 'executor-route', path: `workspaces/${originKey}/hook-state/route-${routeKey}.json`, bytes: input.executorRouteRecordBytes },
    { role: 'forwarding', path: `workspaces/${originKey}/hook-state/forward-${forwardKey}.json`, bytes: forwardBytes },
    { role: 'executor', path: `workspaces/${executionKey}/hook-state/executor-${executorKey}.json`, bytes: input.executorRecordBytes },
    { role: 'binding-authority', path: `workspaces/${executionKey}/rescue-binding-authority-${authority.key}.json`, bytes: input.bindingAuthorityBytes },
    ...partitionBytes.map((bytes) => ({ role: 'binding-partition', path: `workspaces/${executionKey}/rescue-binding-session-${authority.key}.json`, bytes })),
    ...preparationBytes.map((bytes) => ({ role: 'preparation', path: `workspaces/${executionKey}/invocations/prepared/${preparationKey}.json`, bytes })),
  ]);
}

function replaceCapturedWorkspace(value, sourceWorkspace, targetWorkspace) {
  if (typeof value === 'string') {
    const escapedSource = JSON.stringify(sourceWorkspace).slice(1, -1);
    const escapedTarget = JSON.stringify(targetWorkspace).slice(1, -1);
    return value.replaceAll(escapedSource, escapedTarget).replaceAll(sourceWorkspace, targetWorkspace);
  }
  if (Array.isArray(value)) return value.map((entry) => replaceCapturedWorkspace(entry, sourceWorkspace, targetWorkspace));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, entry]) => [key, replaceCapturedWorkspace(entry, sourceWorkspace, targetWorkspace)]));
  return value;
}

function runGit(args, cwd) {
  return new Promise((resolve, reject) => execFile('git', args, { cwd, encoding: 'utf8', shell: false }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

function rawJob(id, ownerTurnId, status, extra = {}) {
  return { id, workspace: expectedWorkspace, ownerSessionId: parentId, ownerTurnId, command: 'rescue', readOnly: false,
    permissionSnapshot: { permissionMode: 'acceptEdits' }, status, createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:01:00.000Z', ...extra };
}
function rawJobs(input) { return JSON.parse(input.jobRecordBytesJson).map((bytes) => JSON.parse(bytes)); }
function setRawJobs(input, jobs) { input.jobRecordBytesJson = JSON.stringify(jobs.map((job) => `${JSON.stringify(job)}\n`)); }

function relayedChoiceFixture({ withStatus = false } = {}) {
  const input = choiceFixture('resume');
  yieldChoiceTurn(input, 'initial'); yieldChoiceTurn(input, 'continuation');
  const child = input.rollouts[1]; const parent = input.rollouts[0];
  const childFinals = child.filter((event) => event?.payload?.phase === 'final_answer');
  const initialOutput = child.find((event) => event?.payload?.call_id === 'exec-1' && event.payload.type === 'custom_tool_call_output');
  initialOutput.payload.output = capturedResult({ output: `partial\n${relayLine(1, 'starting', 'started')}\n`, session_id: 51 });
  const initialAdditions = [relayCall('choice-relay-1', 'started'), relayOutput('choice-relay-1')];
  if (withStatus) initialAdditions.push(structuredExecResult(expectedStatusCommand, 'status-1'), capturedResultEvent('status-1', {
    output: `${JSON.stringify({ type: 'rescue-status', status: 'running', phase: 'running', lastActivityAt: '2026-08-17T00:00:02.000Z', progressPreview: ['ZCode is working.'], terminal: false })}\n`, exit_code: 0,
  }));
  child.splice(child.indexOf(initialOutput) + 1, 0, ...initialAdditions);
  const continuationStart = child.indexOf(childFinals[0]) + 1;
  const continuationOutput = child.slice(continuationStart).find((event) => event?.payload?.type === 'custom_tool_call_output');
  continuationOutput.payload.output = capturedResult({ output: `partial\n${relayLine(1, 'running', 'model-active')}\n`, session_id: 61 });
  child.splice(child.indexOf(continuationOutput) + 1, 0, relayCall('choice-relay-2', 'model-active'), relayOutput('choice-relay-2'));
  const returns = parent.filter((event) => event?.payload?.author === agentPath);
  parent.splice(parent.indexOf(returns[0]), 0, parentRelay(agentPath, relayMessage('started')), structuredWait('choice-relay-wait-1'), waitOutput('choice-relay-wait-1', false));
  const secondReturn = parent.filter((event) => event?.payload?.author === agentPath).at(-1);
  parent.splice(parent.indexOf(secondReturn), 0, parentRelay(agentPath, relayMessage('model-active'), 'b'), structuredWait('choice-relay-wait-2'), waitOutput('choice-relay-wait-2', false));
  retimestampChoice(input);
  return input;
}

function yieldChoiceTurn(input, turn) {
  const child = input.rollouts[1]; const finals = child.filter((event) => event?.payload?.phase === 'final_answer');
  const final = finals[turn === 'initial' ? 0 : 1]; const start = turn === 'initial' ? 1 : child.indexOf(finals[0]) + 1;
  const call = child[start]; const output = child[start + 1]; const handle = turn === 'initial' ? 51 : 61;
  const terminalText = turn === 'initial' ? JSON.parse(output.payload.output[1].text).output : expectedPublicOutput + '\n';
  const terminalExit = turn === 'initial' ? 3 : 0; const prefix = turn === 'initial' ? 'choice-initial' : 'choice-continuation';
  call.payload.input = structuredExecResult(turn === 'initial' ? expectedCommand : choiceOptions('resume').expectedChoiceCommand, call.payload.call_id).payload.input;
  output.payload.output = capturedResult({ output: 'partial\n', session_id: handle });
  const poll = structuredPoll(handle, `${prefix}-poll`); const pollOutput = capturedResultEvent(`${prefix}-poll`, { output: 'heartbeat\n', session_id: handle });
  const terminalPoll = structuredPoll(handle, `${prefix}-terminal`); const terminal = capturedResultEvent(`${prefix}-terminal`, { output: terminalText, exit_code: terminalExit });
  child.splice(start + 2, 0, poll, pollOutput, terminalPoll, terminal);
  return { call, output, poll, pollOutput, terminalPoll, terminal, final, terminalText };
}

function retimestampChoice(input) {
  const parent = input.rollouts[0]; const child = input.rollouts[1]; const childFinals = child.filter((event) => event?.payload?.phase === 'final_answer');
  const returns = parent.filter((event) => event?.payload?.author === agentPath && event.payload.content?.[0]?.text?.startsWith('Message Type: FINAL_ANSWER\n')); const parentFinals = parent.filter((event) => event?.payload?.phase === 'final_answer');
  const followup = choiceFollowup(input); const followupResultEvent = followupResult(input); let offset = 4;
  const stamp = (event) => { event.timestamp = new Date(Date.parse('2026-08-10T00:00:00.000Z') + offset++).toISOString(); };
  for (const event of child.slice(1, child.indexOf(childFinals[0]) + 1)) stamp(event);
  stamp(returns[0]); stamp(parentFinals[0]); stamp(followup); stamp(followupResultEvent);
  for (const event of child.slice(child.indexOf(childFinals[0]) + 1, child.indexOf(childFinals[1]) + 1)) stamp(event);
  stamp(returns[1]); stamp(parentFinals[1]);
}

function timeoutFixture() {
  const input = choiceFixture('resume'); const firstReturn = input.rollouts[0].findIndex((event) => event?.payload?.author === agentPath);
  input.rollouts[0].splice(firstReturn, 0, structuredWait('wait-timeout'), waitOutput('wait-timeout', true), structuredList('list-after-timeout'), listOutput('list-after-timeout'), { type: 'event_msg', payload: { type: 'user_message', message: 'status?' } }, structuredWait('wait-after-steering'), waitOutput('wait-after-steering', false)); return input;
}

function structuredSpawn(callId) {
  return { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: callId, arguments: JSON.stringify({ agent_type: 'zcode-rescue', fork_turns: 'none', message: 'fixed named forwarder', task_name: taskName }) } };
}

function structuredFollowup(callId, choice) {
  return { type: 'response_item', payload: { type: 'function_call', name: 'followup_task', call_id: callId, arguments: JSON.stringify({ target: childId, message: choiceOptions(choice).expectedFollowupMessage }) } };
}
function followupOutput(callId) { return { type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: '' } }; }

function structuredWait(callId) {
  return { type: 'response_item', payload: { type: 'function_call', name: 'wait_agent', call_id: callId, arguments: JSON.stringify({ timeout_ms: 30000 }) } };
}

function waitOutput(callId, timedOut) {
  return { type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ message: timedOut ? 'Wait timed out.' : 'Wait completed.', timed_out: timedOut }) } };
}

function structuredList(callId) { return { type: 'response_item', payload: { type: 'function_call', name: 'list_agents', call_id: callId, arguments: '{}' } }; }
function listOutput(callId) { return { type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ agents: [{ agent_name: agentPath, agent_status: 'running' }] }) } }; }

function structuredExec(command, callId = 'exec-1', fields = {}) {
  return { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input: `const r = await tools.exec_command(${JSON.stringify({ cmd: command, workdir: expectedWorkspace, ...fields })});\ntext(r.output);\n` } };
}

function structuredExecResult(command, callId, fields = {}) {
  return { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input: `const r = await tools.exec_command(${JSON.stringify({ cmd: command, workdir: expectedWorkspace, ...fields })}); text(JSON.stringify(r))\n` } };
}

function parseFixtureHostInput(source) {
  const prefix = 'const r = await tools.exec_command('; const suffix = '); text(JSON.stringify(r))\n';
  return JSON.parse(source.slice(prefix.length, -suffix.length));
}
function parseFixturePollInput(source) {
  const prefix = 'const r = await tools.write_stdin('; const suffix = '); text(JSON.stringify(r))\n';
  return JSON.parse(source.slice(prefix.length, -suffix.length));
}
function fixtureExecInput(value) { return `const r = await tools.exec_command(${JSON.stringify(value)}); text(JSON.stringify(r))\n`; }

function structuredPoll(sessionId, callId, chars = '') {
  return { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input: `const r = await tools.write_stdin(${JSON.stringify({ session_id: sessionId, chars })}); text(JSON.stringify(r))\n` } };
}

function capturedResult(result) {
  return [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }, { type: 'input_text', text: JSON.stringify(result) }];
}

function capturedResultEvent(callId, result) {
  return { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output: capturedResult(result) } };
}

function parentPreparationEvents(prefix = '') {
  const handle = prefix ? 45 : 44;
  return [
    structuredExecResult(expectedPreflightCommand, `${prefix}preflight-1`),
    capturedResultEvent(`${prefix}preflight-1`, { output: `${JSON.stringify({ type: 'role-status', role: 'zcode-rescue', status: 'ready' })}\n`, exit_code: 0 }),
    structuredExecResult(expectedPreparationCommand, `${prefix}prepare-1`, { tty: true }),
    capturedResultEvent(`${prefix}prepare-1`, { output: `${JSON.stringify({ type: 'preparation-input-ready', command: 'rescue' })}\n`, session_id: handle }),
    structuredPoll(handle, `${prefix}prepare-write-1`, `${expectedPreparationPayload}\n`),
    capturedResultEvent(`${prefix}prepare-write-1`, { output: preparedAck({ version: 1, action: 'spawn', taskName }), exit_code: 0 }),
  ];
}

function childPolls(input) { return input.rollouts[1].filter((event) => event.payload?.type === 'custom_tool_call').slice(1); }
function childPollOutputs(input) { return input.rollouts[1].filter((event) => event.payload?.type === 'custom_tool_call_output').slice(1); }

function structuredExecUnquoted(command) {
  return { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'exec-1', input: `const r = await tools.exec_command({cmd:${JSON.stringify(command)},workdir:${JSON.stringify(expectedWorkspace)}});\ntext(r.output);\n` } };
}

function structuredExecUnquotedInline(command) {
  return { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'exec-1', input: `const r = await tools.exec_command({cmd:${JSON.stringify(command)},workdir:${JSON.stringify(expectedWorkspace)}}); text(r.output);\n` } };
}

function unicodeEscapeEveryChar(value) {
  return `"${value.split('').map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}`;
}

function toolOutput(callId, terminalText) {
  return { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }, { type: 'input_text', text: terminalText }] } };
}
function semanticText(terminalText) { return `${expectedSemanticProgress.start}\n${expectedSemanticProgress.terminal}\n${terminalText}`; }

function spawnEvent(input) { return input.rollouts[0].find((event) => event.payload?.name === 'spawn_agent'); }
function startEvent(input) { return input.rollouts[0].find((event) => event.payload?.type === 'sub_agent_activity'); }
function childReturnEvent(input) { return input.rollouts[0].find((event) => event.payload?.type === 'agent_message' && event.payload.author === agentPath); }
function childMeta(input) { return input.rollouts[1][0]; }
function parentMeta(input) { return input.rollouts[0][0]; }
function preflightEvent(input) { return input.rollouts[0].find((event) => event.payload?.type === 'custom_tool_call' && event.payload.call_id === 'preflight-1'); }
function preflightOutput(input) { return input.rollouts[0].find((event) => event.payload?.type === 'custom_tool_call_output' && event.payload.call_id === 'preflight-1'); }
function parentCall(input, callId) { return input.rollouts[0].find((event) => event.payload?.type === 'custom_tool_call' && event.payload.call_id === callId); }
function parentOutput(input, callId) { return input.rollouts[0].find((event) => event.payload?.type === 'custom_tool_call_output' && event.payload.call_id === callId); }
function removeParentCall(input, callId) { const call = parentCall(input, callId); const output = parentOutput(input, callId); input.rollouts[0] = input.rollouts[0].filter((event) => event !== call && event !== output); }
function removeParentOutput(input, callId) { const output = parentOutput(input, callId); input.rollouts[0] = input.rollouts[0].filter((event) => event !== output); }
function childExec(input) { return input.rollouts[1].find((event) => event.payload?.type === 'custom_tool_call'); }
function childOutput(input) { return input.rollouts[1].find((event) => event.payload?.type === 'custom_tool_call_output'); }
function choiceFollowup(input) { return input.rollouts[0].find((event) => event.payload?.name === 'followup_task'); }
function followupResult(input) { const call = choiceFollowup(input); return input.rollouts[0].find((event) => event.payload?.type === 'function_call_output' && event.payload.call_id === call.payload.call_id); }
function choiceExec(input) { return input.rollouts[1].filter((event) => event.payload?.type === 'custom_tool_call')[1]; }
function waitResult(input, callId) { return input.rollouts[0].find((event) => event.payload?.type === 'function_call_output' && event.payload.call_id === callId); }
function execAgentMessage(text, id = 'item-1') { return { type: 'item.completed', item: { id, type: 'agent_message', text } }; }
function finalExecAgentMessage(input) { return input.execFrames.findLast((frame) => frame.type === 'item.completed' && frame.item?.type === 'agent_message'); }
