// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CodexRescueEvidenceMismatchError,
  CodexRescueUnqualifiedError,
  parseCodexRolloutJsonl,
  qualifyCodexRescueEvidence,
} from './helpers/codex-rescue-qualification.mjs';

const parentId = '019fe6df-faa2-7851-8edb-55f1be7d5489';
const childId = '019fe6e0-4764-7192-83ba-0b0cc2c48660';
const agentPath = '/root/zcode_rescue';
const expectedCommand = 'node "/installed/zcode/scripts/zcode-companion.mjs" invoke rescue';
const expectedPublicOutput = 'done';

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

test('qualifies generic Rescue only when schema-hidden mode is explicit', () => {
  const input = fixture();
  input.rollouts[0][1].payload.arguments = JSON.stringify({ fork_turns: 'none', message: 'fixed generic forwarder', task_name: 'zcode_rescue' });
  input.rollouts[1][0].payload.source.subagent.thread_spawn.agent_role = null;
  const evidence = qualifyCodexRescueEvidence(input, options({ schemaMode: 'generic-hidden' }));
  assert.equal(evidence.route, 'generic-schema-hidden');
  assert.equal(evidence.agentType, null);
});

test('requires the exact fixed spawn message for named and generic routes', () => {
  for (const schemaMode of ['named', 'generic-hidden']) {
    const input = fixture();
    const args = JSON.parse(input.rollouts[0][1].payload.arguments);
    if (schemaMode === 'generic-hidden') {
      delete args.agent_type;
      input.rollouts[1][0].payload.source.subagent.thread_spawn.agent_role = null;
    }
    args.message = 'almost the fixed forwarder';
    input.rollouts[0][1].payload.arguments = JSON.stringify(args);
    assert.throws(
      () => qualifyCodexRescueEvidence(input, options({ schemaMode })),
      (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'spawn-message-mismatch',
    );
  }
});

test('reports encrypted spawn message unqualified only after observable mismatches are checked', () => {
  const input = fixture();
  const args = JSON.parse(input.rollouts[0][1].payload.arguments);
  args.message = `gAAAA${'A'.repeat(80)}=`;
  input.rollouts[0][1].payload.arguments = JSON.stringify(args);
  input.execFrames.at(-1).item.text = 'wrong final';
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options()),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'public-output-mismatch',
  );
  input.execFrames.at(-1).item.text = expectedPublicOutput;
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options()),
    (error) => error instanceof CodexRescueUnqualifiedError
      && error.code === 'spawn-message-encrypted'
      && error.evidence?.route === 'named'
      && error.evidence?.childThreadId === childId,
  );
});

test('reports missing core structure as unqualified before behavior assertions', () => {
  const input = fixture();
  input.execFrames = [];
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options()),
    (error) => error instanceof CodexRescueUnqualifiedError && error.code === 'parent-thread-unavailable',
  );
});

test('fails instead of skipping when linked child metadata has the wrong named Role', () => {
  const input = fixture();
  input.rollouts[1][0].payload.source.subagent.thread_spawn.agent_role = null;
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options()),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'agent-role-mismatch',
  );
});

test('fails instead of skipping when observed child ID conflicts with an existing linked rollout', () => {
  const input = fixture();
  input.rollouts[0][2].payload.agent_thread_id = '019fe6e0-ffff-7192-83ba-0b0cc2c48660';
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options()),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'child-rollout-id-mismatch',
  );
});

test('fails when task name and linked agent path do not select zcode_rescue', () => {
  const input = fixture();
  input.rollouts[0][2].payload.agent_path = '/root/not_rescue';
  input.rollouts[1][0].payload.source.subagent.thread_spawn.agent_path = '/root/not_rescue';
  input.rollouts[0][3].payload.author = '/root/not_rescue';
  input.rollouts[0][3].payload.content[0].text = input.rollouts[0][3].payload.content[0].text.replace(agentPath, '/root/not_rescue');
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
    { source: `const r = await tools.exec_command({"metadata":{"cmd":${JSON.stringify(expectedCommand)}},"cmd":"evil"});\ntext(r.output);\n`, code: 'child-command-mismatch' },
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
  input.execFrames.at(-1).item.text = 'prefix done suffix';
  assert.throws(
    () => qualifyCodexRescueEvidence(input, options()),
    (error) => error instanceof CodexRescueEvidenceMismatchError && error.code === 'public-output-mismatch',
  );
});

test('rollout JSONL parser is bounded and fails closed on malformed records', () => {
  assert.deepEqual(parseCodexRolloutJsonl('{"type":"session_meta","payload":{}}\n'), [{ type: 'session_meta', payload: {} }]);
  assert.throws(
    () => parseCodexRolloutJsonl('{not-json}\n'),
    (error) => error instanceof CodexRescueUnqualifiedError && error.code === 'rollout-json-invalid',
  );
  assert.throws(
    () => parseCodexRolloutJsonl(`${'x'.repeat(1024 * 1024 + 1)}\n`),
    (error) => error instanceof CodexRescueUnqualifiedError && error.code === 'rollout-line-oversize',
  );
});

function options(overrides = {}) {
  const value = {
    schemaMode: 'named',
    expectedTaskName: 'zcode_rescue',
    expectedAgentPath: agentPath,
    expectedAgentType: 'zcode-rescue',
    expectedCommand,
    expectedPublicOutput,
    forbiddenParentText: ['Running command: npm test', 'raw output must stay private', 'reasoning must stay private'],
    ...overrides,
  };
  value.expectedSpawnMessage = value.schemaMode === 'named' ? 'fixed named forwarder' : 'fixed generic forwarder';
  return value;
}

function fixture() {
  const childEnvelope = `Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${agentPath}\nPayload:\n${expectedPublicOutput}`;
  const execFrames = [
      { type: 'thread.started', thread_id: parentId },
      { type: 'item.completed', item: { id: 'item-1', type: 'agent_message', text: expectedPublicOutput } },
    ];
  const parent = [
      { type: 'session_meta', payload: { session_id: parentId, id: parentId, thread_source: 'user', source: 'exec' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'spawn-1', arguments: JSON.stringify({ agent_type: 'zcode-rescue', fork_turns: 'none', message: 'fixed named forwarder', task_name: 'zcode_rescue' }) } },
      { type: 'event_msg', payload: { type: 'sub_agent_activity', event_id: 'spawn-1', agent_thread_id: childId, agent_path: agentPath, kind: 'started' } },
      { type: 'response_item', payload: { type: 'agent_message', author: agentPath, recipient: '/root', content: [{ type: 'input_text', text: childEnvelope }] } },
      { type: 'event_msg', payload: { type: 'agent_message', message: expectedPublicOutput, phase: 'final_answer' } },
    ];
  const child = [
      { type: 'session_meta', payload: { session_id: parentId, id: childId, parent_thread_id: parentId, thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1, agent_path: agentPath, agent_nickname: 'Ada', agent_role: 'zcode-rescue' } } } } },
      structuredExec(expectedCommand),
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'exec-1', output: [{ type: 'input_text', text: 'Running command: npm test\nraw output must stay private\nreasoning must stay private' }] } },
      { type: 'event_msg', payload: { type: 'agent_message', message: expectedPublicOutput, phase: 'final_answer' } },
    ];
  return { execFrames, rollouts: [parent, child] };
}

function structuredExec(command) {
  return { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'exec-1', input: `const r = await tools.exec_command(${JSON.stringify({ cmd: command, workdir: '/repo' })});\ntext(r.output);\n` } };
}

function structuredExecUnquoted(command) {
  return { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'exec-1', input: `const r = await tools.exec_command({cmd:${JSON.stringify(command)},workdir:"/repo"});\ntext(r.output);\n` } };
}

function structuredExecUnquotedInline(command) {
  return { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'exec-1', input: `const r = await tools.exec_command({cmd:${JSON.stringify(command)},workdir:"/repo"}); text(r.output);\n` } };
}
