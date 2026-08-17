// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createIdentityStore } from '../scripts/lib/identity.mjs';

import {
  assertCodexRescueDisplayName,
  CodexRescueEvidenceMismatchError,
  CodexRescueUnqualifiedError,
  parseCodexRolloutJsonl,
  qualifyCodexRescueBackgroundEvidence,
  qualifyCodexRescueChoiceEvidence,
  qualifyCodexRescueEvidence,
} from './helpers/codex-rescue-qualification.mjs';

const parentId = '019fe6df-faa2-7851-8edb-55f1be7d5489';
const childId = '019fe6e0-4764-7192-83ba-0b0cc2c48660';
const taskName = 'zcode_rescue_fix_progress';
const agentPath = `/root/${taskName}`;
const expectedWorkspace = '/repo';
const expectedCommand = 'node "/installed/zcode/scripts/zcode-companion.mjs" invoke-prepared rescue';
const expectedPreflightCommand = 'node "/installed/zcode/scripts/zcode-companion.mjs" role-status rescue';
const expectedPreparationCommand = 'node "/installed/zcode/scripts/zcode-companion.mjs" prepare rescue';
const expectedPreparationEnvelope = Object.freeze({ version: 1, source: 'explicit', task: 'repair the qualification fixture', options: { execution: 'foreground', resume: 'fresh' } });
const expectedPreparationPayload = JSON.stringify(expectedPreparationEnvelope);
const expectedStatusCommand = 'node "/installed/zcode/scripts/zcode-companion.mjs" invoke-status rescue';
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
      taskName,
      choice,
    });
  }
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
    expectedChoiceCommand: `node "/installed/zcode/scripts/zcode-companion.mjs" invoke-choice rescue ${choice}`,
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
    capturedResultEvent(`${prefix}prepare-write-1`, { output: `${JSON.stringify({ type: 'prepared', command: 'rescue' })}\n`, exit_code: 0 }),
  ];
}

function childPolls(input) { return input.rollouts[1].filter((event) => event.payload?.type === 'custom_tool_call').slice(1); }
function childPollOutputs(input) { return input.rollouts[1].filter((event) => event.payload?.type === 'custom_tool_call_output').slice(1); }

function structuredExecUnquoted(command) {
  return { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'exec-1', input: `const r = await tools.exec_command({cmd:${JSON.stringify(command)},workdir:"/repo"});\ntext(r.output);\n` } };
}

function structuredExecUnquotedInline(command) {
  return { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'exec-1', input: `const r = await tools.exec_command({cmd:${JSON.stringify(command)},workdir:"/repo"}); text(r.output);\n` } };
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
