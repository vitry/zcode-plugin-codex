// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createConversationProgressDescriber, normalizePreview } from '../scripts/lib/conversation-progress.mjs';
import { conversationFrame, toolRow, turnRow } from './fixtures/conversation-progress-frames.mjs';

const observedAt = '2026-08-09T00:00:01.000Z';

test('normalizes previews by removing controls, collapsing whitespace, and truncating by Unicode code point', () => {
  assert.equal(normalizePreview(' a\r\n\tb\u0000\u0085  c ', 96), 'a b c');
  const value = `${'😀'.repeat(95)}界尾`;
  const result = normalizePreview(value, 96);
  assert.equal([...result].length, 96);
  assert.equal(result, `${'😀'.repeat(95)}…`);
  assert.equal(normalizePreview('x'.repeat(1_000_000), 96), `${'x'.repeat(95)}…`);
});

test('describes only allowlisted online tool and turn lifecycle fields', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  await mkdir(join(workspace, 'src')); await writeFile(join(workspace, 'src', 'a.js'), 'x');
  const describer = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  const cases = [
    ['Bash', { command: 'npm\ttest' }, 'Running command: npm test.'],
    ['Read', { file_path: join(workspace, 'src', 'a.js') }, 'Reading: src/a.js.'],
    ['Edit', { file_path: join(workspace, 'src', 'a.js'), old_string: 'SECRET_OLD', new_string: 'SECRET_NEW' }, 'Editing: src/a.js.'],
    ['Write', { file_path: join(workspace, 'new.js'), content: 'SECRET_CONTENT' }, 'Writing: new.js.'],
    ['Grep', { pattern: 'needle' }, 'Searching files: needle.'],
    ['Glob', { pattern: '**/*.mjs' }, 'Finding files: **/*.mjs.'],
    ['WebSearch', { query: 'safe query' }, 'Searching the web: safe query.'],
    ['Unknown\u0007Tool', { command: 'SECRET_COMMAND' }, 'Running a ZCode tool.'],
  ];
  let ordinal = 1;
  for (const [toolName, input, message] of cases) {
    const events = await describer.observe(conversationFrame({ ordinal, deltas: [toolRow({ rowId: ordinal, toolName, input, status: 'inputStreaming' })] }), observedAt);
    assert.equal(events[0].message, message); ordinal += 1;
  }
  const turnStart = await describer.observe(conversationFrame({ ordinal, deltas: [turnRow({ state: 'running' })] }), observedAt);
  assert.equal(turnStart[0].message, 'ZCode turn started.'); ordinal += 1;
  const turnEnd = await describer.observe(conversationFrame({ ordinal, deltas: [turnRow({ state: 'completedSuccess' })] }), observedAt);
  assert.equal(turnEnd[0].message, 'ZCode turn completed.');
});

test('emits at most one meaningful start and terminal per tool and rejects stale foreign snapshot and post-terminal frames', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const describer = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  const start = toolRow({ status: 'inputStreaming', input: { command: 'echo ok' } });
  assert.equal((await describer.observe(conversationFrame({ ordinal: 2, deltas: [start] }), observedAt)).length, 1);
  assert.equal((await describer.observe(conversationFrame({ ordinal: 3, deltas: [toolRow({ status: 'pendingApproval', input: { command: 'echo ok' } })] }), observedAt)).length, 0);
  const terminal = await describer.observe(conversationFrame({ ordinal: 4, deltas: [toolRow({ status: 'success', input: { command: 'echo ok' }, endedAt: '2026-08-09T00:00:00.125Z' })] }), observedAt);
  assert.equal(terminal[0].message, 'Command completed: echo ok (125ms).');
  assert.equal((await describer.observe(conversationFrame({ ordinal: 4, deltas: [start] }), observedAt)).length, 0);
  assert.equal((await describer.observe(conversationFrame({ ordinal: 5, subscriptionId: 'foreign', deltas: [start] }), observedAt)).length, 0);
  assert.equal((await describer.observe(conversationFrame({ ordinal: 6, sessionId: 'foreign', deltas: [start] }), observedAt)).length, 0);
  assert.equal((await describer.observe(conversationFrame({ ordinal: 7, deliveryKind: 'initial', deltas: [start] }), observedAt)).length, 0);
  describer.markTerminal();
  assert.equal((await describer.observe(conversationFrame({ ordinal: 8, deltas: [toolRow({ rowId: 2 })] }), observedAt)).length, 0);
});

test('serializes concurrent frames and latches a turn terminal state', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const describer = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  const [started, completed] = await Promise.all([
    describer.observe(conversationFrame({ ordinal: 1, deltas: [toolRow({ status: 'inputStreaming', input: { command: 'echo ordered' } })] }), observedAt),
    describer.observe(conversationFrame({ ordinal: 2, deltas: [toolRow({ status: 'success', input: { command: 'echo ordered' }, endedAt: '2026-08-09T00:00:00.010Z' })] }), observedAt),
  ]);
  assert.equal(started[0].message, 'Running command: echo ordered.');
  assert.equal(completed[0].message, 'Command completed: echo ordered (10ms).');
  assert.equal((await describer.observe(conversationFrame({ ordinal: 3, deltas: [turnRow({ state: 'completedSuccess' })] }), observedAt))[0].message, 'ZCode turn completed.');
  assert.deepEqual(await describer.observe(conversationFrame({ ordinal: 4, deltas: [turnRow({ state: 'failed' }), toolRow({ rowId: 2 })] }), observedAt), []);
});

test('requires captured wire version 3 and keeps every emitted message within the public byte bound', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const describer = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  const incompatible = conversationFrame({ ordinal: 1, deltas: [toolRow()] }); incompatible.params.wireVersion = 4;
  assert.deepEqual(await describer.observe(incompatible, observedAt), []);
  const events = await describer.observe(conversationFrame({ ordinal: 2, deltas: [toolRow({ input: { command: '😀'.repeat(96) } })] }), observedAt);
  assert.equal(events.length, 1); assert.ok(Buffer.byteLength(events[0].message) <= 256); assert.match(events[0].message, /^Running command:/);
});

test('markTerminal fences an in-flight asynchronous path description', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-')); await writeFile(join(workspace, 'a.txt'), 'x');
  const describer = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  const observation = describer.observe(conversationFrame({ ordinal: 1, deltas: [toolRow({ toolName: 'Read', input: { file_path: join(workspace, 'a.txt') } })] }), observedAt);
  await new Promise((resolve) => setImmediate(resolve)); describer.markTerminal();
  assert.deepEqual(await observation, []);
});

test('canonical path containment rejects traversal outside paths and symlink escapes without leaking sensitive fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zcode-progress-')); const workspace = join(root, 'repo'); const outside = join(root, 'outside');
  await mkdir(workspace); await mkdir(outside); await writeFile(join(outside, 'secret.txt'), 'secret'); await symlink(outside, join(workspace, 'link'));
  const describer = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  const forbidden = ['../outside/secret.txt', join(outside, 'secret.txt'), join(workspace, 'link', 'secret.txt')];
  let ordinal = 1;
  for (const file_path of forbidden) {
    const frame = conversationFrame({ ordinal, deltas: [toolRow({ rowId: ordinal, toolName: 'Read', input: { file_path, reasoning: 'CHAIN', brokerToken: 'CAPABILITY' } })] });
    const events = await describer.observe(frame, observedAt);
    assert.equal(events[0].message, 'Running tool: Read.');
    assert.doesNotMatch(JSON.stringify(events), /outside|secret|CHAIN|CAPABILITY|brokerToken/); ordinal += 1;
  }
});
