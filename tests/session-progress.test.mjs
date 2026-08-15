// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createSessionProgressDescriber } from '../scripts/lib/session-progress.mjs';

const observedAt = '2026-08-15T00:00:00.000Z';

function userMessage(messageId, overrides = {}) {
  return { info: { role: 'user', messageId, ...overrides }, parts: [] };
}

function assistantMessage(messageId, parentMessageId, parts, overrides = {}) {
  return { info: { role: 'assistant', messageId, parentMessageId, ...overrides }, parts };
}

function toolPart(callId, tool, status, input = {}, state = {}) {
  return { type: 'tool', callId, tool, state: { status, input, ...state } };
}

function snapshot(messages, stateRevision = 8) {
  return { runtime: { stateRevision }, messages };
}

test('describes one safe start from a direct current-turn assistant tool part', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-session-progress-'));
  const describer = await createSessionProgressDescriber({
    workspace,
    turnBoundary: { inputId: 'accepted-input', stateRevision: 7, beforeMessageIds: new Set(['old-user', 'old-assistant']) },
  });

  const events = await describer.observe(snapshot([
    userMessage('old-user'),
    assistantMessage('old-assistant', 'old-user', [toolPart('old-call', 'Bash', 'running', { command: 'PRIVATE_OLD' })]),
    userMessage('accepted-input'),
    assistantMessage('current-assistant', 'accepted-input', [toolPart('current-call', 'Bash', 'running', { command: 'npm test' })]),
  ]), observedAt);

  assert.deepEqual(events, [{ phase: 'running', message: 'Running tool: Bash.', observedAt }]);
});

test('never renders assistant prose, reasoning, commands, tool results, errors, metadata, or ids', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-session-progress-'));
  const describer = await createSessionProgressDescriber({
    workspace,
    turnBoundary: { inputId: 'accepted-input', stateRevision: 7, beforeMessageIds: new Set() },
  });
  const privateValues = ['ASSISTANT_PRIVATE', 'REASONING_PRIVATE', 'COMMAND_PRIVATE', 'OUTPUT_PRIVATE', 'ERROR_PRIVATE', 'METADATA_PRIVATE', 'CALL_PRIVATE'];
  const events = await describer.observe(snapshot([
    userMessage('accepted-input'),
    assistantMessage('assistant-private', 'accepted-input', [
      { type: 'text', text: privateValues[0] },
      { type: 'reasoning', text: privateValues[1] },
      {
        ...toolPart(privateValues[6], 'Bash', 'completed', { command: privateValues[2], arbitrary: 'INPUT_PRIVATE' }, {
          output: privateValues[3], error: privateValues[4], metadata: { secret: privateValues[5] }, startedAt: 10, completedAt: 20,
        }),
        metadata: { secret: privateValues[5] },
      },
    ]),
  ]), observedAt);

  assert.deepEqual(events, [{ phase: 'running', message: 'Bash completed (10ms).', observedAt }]);
  assert.doesNotMatch(JSON.stringify(events), new RegExp(privateValues.join('|')));
});

test('fails closed for malformed duplicate message relationships instead of broadening the scan', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-session-progress-'));
  const describer = await createSessionProgressDescriber({
    workspace,
    turnBoundary: { inputId: 'accepted-input', stateRevision: 7, beforeMessageIds: new Set() },
  });
  const events = await describer.observe(snapshot([
    userMessage('accepted-input'),
    assistantMessage('duplicate-assistant', 'accepted-input', [toolPart('first', 'Read', 'running', { file_path: 'first.txt' })]),
    assistantMessage('duplicate-assistant', 'accepted-input', [toolPart('second', 'Write', 'running', { file_path: 'second.txt' })]),
  ]), observedAt);

  assert.deepEqual(events, []);
});

test('does not render unallowlisted tool or capability names from a session snapshot', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-session-progress-'));
  const describer = await createSessionProgressDescriber({
    workspace,
    turnBoundary: { inputId: 'accepted-input', stateRevision: 7, beforeMessageIds: new Set() },
  });
  const events = await describer.observe(snapshot([
    userMessage('accepted-input'),
    assistantMessage('current-assistant', 'accepted-input', [toolPart('private-call', 'PRIVATE_CAPABILITY', 'completed', {}, { startedAt: 10, completedAt: 20 })]),
  ]), observedAt);

  assert.deepEqual(events, [{ phase: 'running', message: 'Tool completed (10ms).', observedAt }]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_CAPABILITY|private-call/);
});

test('uses exactly one visible non-synthetic current user root only when the accepted input root is absent', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-session-progress-'));
  const boundary = { inputId: 'accepted-input', stateRevision: 7, beforeMessageIds: new Set(['old-user']) };
  const describer = await createSessionProgressDescriber({ workspace, turnBoundary: boundary });
  const safe = await describer.observe(snapshot([
    userMessage('old-user'),
    userMessage('current-user', { semantics: { origin: 'real_user', kind: 'user_prompt', uiVisibility: 'visible' } }),
    assistantMessage('hidden', 'current-user', [toolPart('hidden-call', 'Bash', 'running')], { semantics: { origin: 'agent_runtime', kind: 'assistant_response', uiVisibility: 'hidden' } }),
    assistantMessage('sibling', 'different-user', [toolPart('sibling-call', 'Bash', 'running')]),
    assistantMessage('linked', 'current-user', [toolPart('safe-call', 'Read', 'running', { file_path: 'safe.txt' })]),
  ]), observedAt);
  assert.deepEqual(safe, [{ phase: 'running', message: 'Reading: safe.txt.', observedAt }]);

  const ambiguous = await createSessionProgressDescriber({ workspace, turnBoundary: boundary });
  assert.deepEqual(await ambiguous.observe(snapshot([
    userMessage('first-current'), userMessage('second-current'),
    assistantMessage('assistant', 'first-current', [toolPart('call', 'Bash', 'running')]),
  ]), observedAt), []);
});

test('rejects snapshots older than the accepted revision and emits terminal-first without a synthetic start', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-session-progress-'));
  const describer = await createSessionProgressDescriber({
    workspace,
    turnBoundary: { inputId: 'accepted-input', stateRevision: 7, beforeMessageIds: new Set() },
  });
  const messages = [
    userMessage('accepted-input'),
    assistantMessage('assistant', 'accepted-input', [toolPart('terminal-call', 'Bash', 'error', { command: 'PRIVATE' }, { error: 'PRIVATE_ERROR', startedAt: 10, completedAt: 15 })]),
  ];
  assert.deepEqual(await describer.observe(snapshot(messages, 6), observedAt), []);
  assert.deepEqual(await describer.observe(snapshot(messages, 7), observedAt), [
    { phase: 'running', message: 'Bash failed (5ms).', observedAt },
  ]);
  assert.deepEqual(await describer.observe(snapshot(messages, 8), observedAt), []);
});

test('deduplicates starts and terminals by call id and caps tracked identities at 256', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-session-progress-'));
  const describer = await createSessionProgressDescriber({
    workspace,
    turnBoundary: { inputId: 'accepted-input', stateRevision: 7, beforeMessageIds: new Set() },
  });
  const starts = Array.from({ length: 257 }, (_, index) => toolPart(`call-${index}`, 'Bash', 'running', { command: `PRIVATE-${index}` }));
  const first = await describer.observe(snapshot([
    userMessage('accepted-input'), assistantMessage('assistant', 'accepted-input', starts),
  ]), observedAt);
  assert.equal(first.length, 256);
  assert.deepEqual(new Set(first.map((event) => event.message)), new Set(['Running tool: Bash.']));

  const terminals = starts.map((part, index) => toolPart(part.callId, 'Bash', 'completed', {}, { startedAt: index, completedAt: index + 1 }));
  const second = await describer.observe(snapshot([
    userMessage('accepted-input'), assistantMessage('assistant', 'accepted-input', terminals),
  ], 9), observedAt);
  assert.equal(second.length, 256);
  assert.deepEqual(await describer.observe(snapshot([
    userMessage('accepted-input'), assistantMessage('assistant', 'accepted-input', terminals),
  ], 10), observedAt), []);
});

test('ignores an oversized multibyte call id without consuming bounded dedupe capacity', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-session-progress-'));
  const describer = await createSessionProgressDescriber({
    workspace,
    turnBoundary: { inputId: 'accepted-input', stateRevision: 7, beforeMessageIds: new Set() },
  });
  const oversizedCallId = '界'.repeat(700_000);
  const safeParts = Array.from({ length: 256 }, (_, index) => toolPart(`safe-call-${index}`, 'Bash', 'running'));
  const events = await describer.observe(snapshot([
    userMessage('accepted-input'),
    assistantMessage('assistant', 'accepted-input', [toolPart(oversizedCallId, 'PRIVATE_TOOL', 'running'), ...safeParts]),
  ]), observedAt);

  assert.equal(events.length, 256);
  assert.deepEqual(new Set(events.map((event) => event.message)), new Set(['Running tool: Bash.']));
});

test('fails closed on oversized snapshot message relationship ids', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-session-progress-'));
  const oversizedMessageId = '界'.repeat(700_000);
  const direct = await createSessionProgressDescriber({
    workspace,
    turnBoundary: { inputId: 'accepted-input', stateRevision: 7, beforeMessageIds: new Set() },
  });
  assert.deepEqual(await direct.observe(snapshot([
    userMessage('accepted-input'),
    assistantMessage(oversizedMessageId, 'accepted-input', [toolPart('safe-call', 'Bash', 'running')]),
  ]), observedAt), []);

  const indirect = await createSessionProgressDescriber({
    workspace,
    turnBoundary: { inputId: 'accepted-input', stateRevision: 7, beforeMessageIds: new Set() },
  });
  assert.deepEqual(await indirect.observe(snapshot([
    userMessage(oversizedMessageId),
    assistantMessage('assistant', oversizedMessageId, [toolPart('safe-call', 'Bash', 'running')]),
  ]), observedAt), []);

  const malformedSibling = await createSessionProgressDescriber({
    workspace,
    turnBoundary: { inputId: 'accepted-input', stateRevision: 7, beforeMessageIds: new Set() },
  });
  assert.deepEqual(await malformedSibling.observe(snapshot([
    userMessage('accepted-input'),
    assistantMessage('malformed-sibling', oversizedMessageId, []),
    assistantMessage('linked-assistant', 'accepted-input', [toolPart('safe-call', 'Bash', 'running')]),
  ]), observedAt), []);
});
