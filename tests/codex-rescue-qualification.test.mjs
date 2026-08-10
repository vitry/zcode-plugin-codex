// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createIdentityStore } from '../scripts/lib/identity.mjs';

import {
  CodexRescueEvidenceMismatchError,
  CodexRescueUnqualifiedError,
  parseCodexRolloutJsonl,
  qualifyCodexRescueBackgroundEvidence,
  qualifyCodexRescueChoiceEvidence,
  qualifyCodexRescueEvidence,
} from './helpers/codex-rescue-qualification.mjs';

const parentId = '019fe6df-faa2-7851-8edb-55f1be7d5489';
const childId = '019fe6e0-4764-7192-83ba-0b0cc2c48660';
const agentPath = '/root/zcode_rescue';
const expectedWorkspace = '/repo';
const expectedCommand = 'node "/installed/zcode/scripts/zcode-companion.mjs" invoke rescue';
const expectedPreflightCommand = 'node "/installed/zcode/scripts/zcode-companion.mjs" role-status rescue';
const expectedPublicOutput = 'done';
const backgroundJobId = 'b'.repeat(64);
const backgroundPublicOutput = `Reserved background job ${backgroundJobId}.`;
const executionCapability = 'qualification-capability-sentinel-private';

test('qualifies named Rescue from linked parent and child rollout metadata', () => {
  const evidence = qualifyCodexRescueEvidence(fixture(), options());
  assert.deepEqual(evidence, {
    parentThreadId: parentId,
    childThreadId: childId,
    agentPath,
    taskName: 'zcode_rescue',
    agentType: 'zcode-rescue',
    route: 'named',
    publicOutput: expectedPublicOutput,
  });
});

test('qualifies named and generic background Rescue with one linked queued output and no capability leak', () => {
  const named = backgroundFixture();
  assert.deepEqual(qualifyCodexRescueBackgroundEvidence(named, backgroundOptions()), {
    parentThreadId: parentId, childThreadId: childId, agentPath, taskName: 'zcode_rescue', agentType: 'zcode-rescue', route: 'named',
    publicOutput: backgroundPublicOutput, jobId: backgroundJobId, capabilityChecked: true,
  });
  const generic = backgroundFixture(); const args = JSON.parse(spawnEvent(generic).payload.arguments); delete args.agent_type; args.message = 'fixed generic forwarder'; spawnEvent(generic).payload.arguments = JSON.stringify(args); childMeta(generic).payload.source.subagent.thread_spawn.agent_role = null;
  assert.equal(qualifyCodexRescueBackgroundEvidence(generic, backgroundOptions()).route, 'generic-schema-hidden');
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
    { code: 'child-output-link', mutate: (input) => { childOutput(input).payload.call_id = 'unlinked-output'; } },
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
    jobId: backgroundJobId, ownerSessionId: 'qualification-owner', workspace: directory, operation: 'run-reserved-job', specDigest: 'c'.repeat(64), permissionSnapshot: { permissionMode: 'workspace-write' },
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

test('qualifies exact resume and fresh follow-ups against one existing child ID', () => {
  for (const choice of ['resume', 'fresh']) {
    const input = choiceFixture(choice);
    assert.deepEqual(qualifyCodexRescueChoiceEvidence(input, choiceOptions(choice)), {
      parentThreadId: parentId,
      childThreadId: childId,
      agentPath,
      choice,
    });
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
    { code: 'choice-followup-count', mutate: (input) => input.rollouts[0].splice(-1, 0, structuredFollowup('followup-2', 'resume')) },
    { code: 'choice-followup-target', mutate: (input) => { choiceFollowup(input).payload.arguments = JSON.stringify({ target: 'sibling-child', message: choiceOptions('resume').expectedFollowupMessage }); } },
    { code: 'choice-followup-message', mutate: (input) => { choiceFollowup(input).payload.arguments = JSON.stringify({ target: childId, message: `${choiceOptions('resume').expectedFollowupMessage} task text` }); } },
    { code: 'choice-followup-output-link', mutate: (input) => { followupResult(input).payload.call_id = 'foreign'; } },
    { code: 'choice-followup-output-order', mutate: (input) => { const output = input.rollouts[0].splice(input.rollouts[0].indexOf(followupResult(input)), 1)[0]; input.rollouts[0].splice(input.rollouts[0].indexOf(choiceFollowup(input)), 0, output); } },
    { code: 'choice-wait-count', mutate: (input) => { input.rollouts[0] = input.rollouts[0].filter((event) => event?.payload?.name !== 'wait_agent'); } },
    { code: 'choice-wait-output-link', mutate: (input) => { input.rollouts[0] = input.rollouts[0].filter((event) => event?.payload?.call_id !== 'wait-1' || event?.payload?.type !== 'function_call_output'); } },
    { code: 'choice-wait-output-shape', mutate: (input) => { waitResult(input, 'wait-1').payload.output = JSON.stringify({ message: 'Wait completed.', timed_out: true }); } },
    { code: 'choice-wait-return-order', mutate: (input) => { const output = waitResult(input, 'wait-2'); input.rollouts[0].splice(input.rollouts[0].indexOf(output), 1); input.rollouts[0].push(output); } },
    { code: 'choice-command-count', mutate: (input) => input.rollouts[1].splice(-1, 0, structuredExec(expectedCommand, 'exec-3')) },
    { code: 'choice-command-mismatch', mutate: (input) => { choiceExec(input).payload.input = structuredExec('node "/installed/zcode/scripts/zcode-companion.mjs" invoke-choice rescue fresh', 'exec-2').payload.input; } },
    { code: 'choice-child-terminal-sequence', mutate: (input) => { input.rollouts[1][3].payload.message = 'tampered'; } },
    { code: 'choice-terminal-timeline', mutate: (input) => { choiceExec(input).timestamp = input.rollouts[0].find((event) => event?.payload?.phase === 'final_answer').timestamp; } },
    { code: 'choice-followup-order', mutate: (input) => { const ask = input.rollouts[0].splice(input.rollouts[0].findIndex((event) => event?.payload?.phase === 'final_answer'), 1)[0]; input.rollouts[0].splice(input.rollouts[0].findIndex((event) => event?.payload?.name === 'followup_task') + 1, 0, ask); } },
  ];
  for (const { code, mutate } of cases) {
    const input = choiceFixture('resume'); mutate(input);
    assert.throws(
      () => qualifyCodexRescueChoiceEvidence(input, choiceOptions('resume')),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === code,
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
    parentThreadId: parentId, childThreadId: childId, agentPath, choice: 'resume',
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
  assert.throws(() => qualifyCodexRescueChoiceEvidence(observableMismatch, choiceOptions('resume')), (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'choice-wait-output-link');
  const missing = choiceFixture('resume'); missing.rollouts[0] = missing.rollouts[0].filter((event) => event !== choiceFollowup(missing));
  assert.throws(
    () => qualifyCodexRescueChoiceEvidence(missing, choiceOptions('resume')),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'choice-followup-count',
  );
});

test('qualifies the verified 0.147 generic route from its complete fixed assignment and child chain', () => {
  const input = fixture();
  spawnEvent(input).payload.arguments = JSON.stringify({ fork_turns: 'none', message: 'fixed generic forwarder', task_name: 'zcode_rescue' });
  childMeta(input).payload.source.subagent.thread_spawn.agent_role = null;
  assert.deepEqual(qualifyCodexRescueEvidence(input, options()), {
    parentThreadId: parentId, childThreadId: childId, agentPath, taskName: 'zcode_rescue', agentType: 'default',
    route: 'generic-schema-hidden', publicOutput: expectedPublicOutput,
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

test('requires one exact ready parent preflight before spawn', () => {
  const cases = [
    { code: 'preflight-count', mutate: (input) => input.rollouts[0].splice(1, 1) },
    { code: 'preflight-count', mutate: (input) => input.rollouts[0].splice(2, 0, structuredExec(expectedPreflightCommand, 'preflight-2')) },
    { code: 'preflight-command-mismatch', mutate: (input) => { preflightEvent(input).payload.input = structuredExec(`${expectedPreflightCommand} && true`, 'preflight-1').payload.input; } },
    { code: 'preflight-output-link', mutate: (input) => { preflightOutput(input).payload.call_id = 'wrong-call'; } },
    { code: 'preflight-output-link', mutate: (input) => input.rollouts[0].splice(2, 1) },
    { code: 'preflight-output-link', mutate: (input) => input.rollouts[0].splice(3, 0, toolOutput('preflight-1', '{"type":"role-status","role":"zcode-rescue","status":"ready"}\n')) },
    { code: 'preflight-status-mismatch', mutate: (input) => { preflightOutput(input).payload.output = toolOutput('preflight-1', `${JSON.stringify({ type: 'role-status', role: 'zcode-rescue', status: 'drift' })}\n`).payload.output; } },
    { code: 'preflight-order', mutate: (input) => { const spawn = input.rollouts[0].splice(3, 1)[0]; input.rollouts[0].splice(2, 0, spawn); } },
  ];
  for (const { code, mutate } of cases) {
    const input = fixture(); mutate(input);
    assert.throws(() => qualifyCodexRescueEvidence(input, options()), (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === code);
  }
});

test('binds child stdout to the unique exec call and terminal sentinel', () => {
  const cases = [
    { code: 'child-output-count', mutate: (input) => input.rollouts[1].splice(2, 1) },
    { code: 'child-output-count', mutate: (input) => input.rollouts[1].splice(3, 0, toolOutput('exec-1', `${expectedPublicOutput}\n`)) },
    { code: 'child-output-link', mutate: (input) => { childOutput(input).payload.call_id = 'wrong-call'; } },
    { code: 'child-output-mismatch', mutate: (input) => { childOutput(input).payload.output = toolOutput('exec-1', 'not-done\n').payload.output; } },
    { code: 'child-output-mismatch', mutate: (input) => { childOutput(input).payload.output = toolOutput('exec-1', `${expectedPublicOutput}\nprogress-after\n`).payload.output; } },
    { code: 'child-output-mismatch', mutate: (input) => { childOutput(input).payload.output = toolOutput('exec-1', `${expectedPublicOutput}\n${expectedPublicOutput}\n`).payload.output; } },
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
    'node "/installed/zcode/scripts/zcode-companion.mjs" invoke-choice rescue fresh',
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

test('fails when task name and linked agent path do not select zcode_rescue', () => {
  const input = fixture();
  const returned = childReturnEvent(input);
  startEvent(input).payload.agent_path = '/root/not_rescue';
  childMeta(input).payload.source.subagent.thread_spawn.agent_path = '/root/not_rescue';
  returned.payload.author = '/root/not_rescue';
  returned.payload.content[0].text = returned.payload.content[0].text.replace(agentPath, '/root/not_rescue');
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options()),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'agent-path-mismatch',
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

test('fails when child-only stderr or raw progress enters a parent public event', () => {
  const input = fixture();
  input.rollouts[0].splice(-2, 0, { type: 'event_msg', payload: { type: 'agent_message', message: 'raw output must stay private', phase: 'commentary' } });
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options()),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'parent-isolation-breach',
  );
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
    expectedTaskName: 'zcode_rescue',
    expectedAgentPath: agentPath,
    expectedAgentType: 'zcode-rescue',
    expectedWorkspace,
    expectedCommand,
    expectedPreflightCommand,
    expectedPublicOutput,
    expectedNamedSpawnMessage: 'fixed named forwarder',
    expectedGenericSpawnMessage: 'fixed generic forwarder',
    forbiddenParentText: ['Running command: npm test', 'raw output must stay private', 'reasoning must stay private'],
    ...overrides,
  };
  return value;
}

function backgroundOptions(overrides = {}) {
  return options({ expectedJobId: backgroundJobId, expectedPublicOutput: undefined, privateExecutionCapability: executionCapability, publicLogs: ['bounded public log without private material'], ...overrides });
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
      structuredExec(expectedPreflightCommand, 'preflight-1'),
      toolOutput('preflight-1', `${JSON.stringify({ type: 'role-status', role: 'zcode-rescue', status: 'ready' })}\n`),
      { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'spawn-1', arguments: JSON.stringify({ agent_type: 'zcode-rescue', fork_turns: 'none', message: 'fixed named forwarder', task_name: 'zcode_rescue' }) } },
      { type: 'event_msg', payload: { type: 'sub_agent_activity', event_id: 'spawn-1', agent_thread_id: childId, agent_path: agentPath, kind: 'started' } },
      { type: 'response_item', payload: { type: 'agent_message', author: agentPath, recipient: '/root', content: [{ type: 'input_text', text: childEnvelope }] } },
      { type: 'event_msg', payload: { type: 'agent_message', message: publicOutput, phase: 'final_answer' } },
    ];
  const child = [
      { type: 'session_meta', payload: { session_id: parentId, id: childId, parent_thread_id: parentId, thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1, agent_path: agentPath, agent_nickname: 'Ada', agent_role: 'zcode-rescue' } } } } },
      structuredExec(expectedCommand),
      toolOutput('exec-1', `Running command: npm test.\n${publicOutput}\n`),
      { type: 'event_msg', payload: { type: 'agent_message', message: publicOutput, phase: 'final_answer' } },
    ];
  return { execFrames, rollouts: [parent, child] };
}

function backgroundFixture() { const input = fixture(backgroundPublicOutput); childOutput(input).payload.output = [{ type: 'input_text', text: `${backgroundPublicOutput}\n` }]; return input; }

function choiceOptions(choice) {
  return {
    expectedChoice: choice,
    expectedParentThreadId: parentId,
    expectedAgentPath: agentPath,
    expectedAgentType: 'zcode-rescue',
    expectedWorkspace,
    expectedInitialCommand: expectedCommand,
    expectedNamedSpawnMessage: 'fixed named forwarder',
    expectedGenericSpawnMessage: 'fixed generic forwarder',
    expectedTaskName: 'zcode_rescue',
    expectedPreflightCommand,
    expectedChoiceCommand: `node "/installed/zcode/scripts/zcode-companion.mjs" invoke-choice rescue ${choice}`,
    expectedFollowupMessage: `Continue the pending ZCode Rescue with ${choice}. Run only the installed ${choice} forwarder command and return its public stdout verbatim.`,
    expectedPublicOutput,
  };
}

function choiceFixture(choice) {
  const needsChoice = `${JSON.stringify({ type: 'needs-choice', candidate: { sessionId: 'resumable-session' }, choices: ['--resume', '--fresh'] })}\n`;
  const firstEnvelope = `Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${agentPath}\nPayload:\n${needsChoice}`;
  const secondEnvelope = `Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${agentPath}\nPayload:\n${expectedPublicOutput}`;
  const parent = [
    { type: 'session_meta', payload: { session_id: parentId, id: parentId, cli_version: '0.147.0', thread_source: 'user', source: 'exec' } },
    structuredExec(expectedPreflightCommand, 'preflight-1'),
    toolOutput('preflight-1', `${JSON.stringify({ type: 'role-status', role: 'zcode-rescue', status: 'ready' })}\n`),
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
    structuredExec(expectedCommand, 'exec-1'),
    toolOutput('exec-1', needsChoice),
    { type: 'event_msg', payload: { type: 'agent_message', message: needsChoice, phase: 'final_answer' } },
    structuredExec(choiceOptions(choice).expectedChoiceCommand, 'exec-2'),
    toolOutput('exec-2', `${expectedPublicOutput}\n`),
    { type: 'event_msg', payload: { type: 'agent_message', message: expectedPublicOutput, phase: 'final_answer' } },
  ];
  const at = (event, offset) => { event.timestamp = new Date(Date.parse('2026-08-10T00:00:00.000Z') + offset).toISOString(); };
  at(child[1], 4); at(child[2], 5); at(child[3], 6); at(parent[7], 7); at(parent[8], 8);
  at(parent[9], 9); at(parent[10], 10); at(child[4], 11); at(child[5], 12); at(child[6], 13); at(parent[13], 14); at(parent[14], 15);
  return { rollouts: [parent, child] };
}

function timeoutFixture() {
  const input = choiceFixture('resume'); const firstReturn = input.rollouts[0].findIndex((event) => event?.payload?.author === agentPath);
  input.rollouts[0].splice(firstReturn, 0, structuredWait('wait-timeout'), waitOutput('wait-timeout', true), structuredList('list-after-timeout'), listOutput('list-after-timeout'), { type: 'event_msg', payload: { type: 'user_message', message: 'status?' } }, structuredWait('wait-after-steering'), waitOutput('wait-after-steering', false)); return input;
}

function structuredSpawn(callId) {
  return { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: callId, arguments: JSON.stringify({ agent_type: 'zcode-rescue', fork_turns: 'none', message: 'fixed named forwarder', task_name: 'zcode_rescue' }) } };
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

function structuredExecUnquoted(command) {
  return { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'exec-1', input: `const r = await tools.exec_command({cmd:${JSON.stringify(command)},workdir:"/repo"});\ntext(r.output);\n` } };
}

function structuredExecUnquotedInline(command) {
  return { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'exec-1', input: `const r = await tools.exec_command({cmd:${JSON.stringify(command)},workdir:"/repo"}); text(r.output);\n` } };
}

function toolOutput(callId, terminalText) {
  return { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }, { type: 'input_text', text: terminalText }] } };
}

function spawnEvent(input) { return input.rollouts[0].find((event) => event.payload?.name === 'spawn_agent'); }
function startEvent(input) { return input.rollouts[0].find((event) => event.payload?.type === 'sub_agent_activity'); }
function childReturnEvent(input) { return input.rollouts[0].find((event) => event.payload?.type === 'agent_message' && event.payload.author === agentPath); }
function childMeta(input) { return input.rollouts[1][0]; }
function parentMeta(input) { return input.rollouts[0][0]; }
function preflightEvent(input) { return input.rollouts[0].find((event) => event.payload?.type === 'custom_tool_call' && event.payload.call_id === 'preflight-1'); }
function preflightOutput(input) { return input.rollouts[0].find((event) => event.payload?.type === 'custom_tool_call_output' && event.payload.call_id === 'preflight-1'); }
function childExec(input) { return input.rollouts[1].find((event) => event.payload?.type === 'custom_tool_call'); }
function childOutput(input) { return input.rollouts[1].find((event) => event.payload?.type === 'custom_tool_call_output'); }
function choiceFollowup(input) { return input.rollouts[0].find((event) => event.payload?.name === 'followup_task'); }
function followupResult(input) { const call = choiceFollowup(input); return input.rollouts[0].find((event) => event.payload?.type === 'function_call_output' && event.payload.call_id === call.payload.call_id); }
function choiceExec(input) { return input.rollouts[1].filter((event) => event.payload?.type === 'custom_tool_call')[1]; }
function waitResult(input, callId) { return input.rollouts[0].find((event) => event.payload?.type === 'function_call_output' && event.payload.call_id === callId); }
function execAgentMessage(text, id = 'item-1') { return { type: 'item.completed', item: { id, type: 'agent_message', text } }; }
function finalExecAgentMessage(input) { return input.execFrames.findLast((frame) => frame.type === 'item.completed' && frame.item?.type === 'agent_message'); }
