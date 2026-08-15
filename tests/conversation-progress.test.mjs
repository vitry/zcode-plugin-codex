// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createConversationProgressDescriber as createStructuralDescriber, createDeferredConversationProgressObserver as createStructuralDeferredObserver, normalizePreview } from '../scripts/lib/conversation-progress.mjs';
import { conversationFrame, toolRow, turnRow } from './fixtures/conversation-progress-frames.mjs';

const observedAt = '2026-08-09T00:00:01.000Z';

async function createConversationProgressDescriber(...args) {
  const describer = await createStructuralDescriber(...args);
  return { ...describer, observe: async (...observeArgs) => (await describer.observe(...observeArgs)).events };
}

function createDeferredConversationProgressObserver(...args) {
  const observer = createStructuralDeferredObserver(...args);
  return { ...observer, observe: async (...observeArgs) => (await observer.observe(...observeArgs)).events };
}

test('returns fixed structural compatibility outcomes without retaining rejected frame data', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const fresh = () => createStructuralDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  const acceptedInitial = await (await fresh()).observe(conversationFrame({ deliveryKind: 'initial', deltas: [] }), observedAt);
  assert.deepEqual(acceptedInitial, { disposition: 'accepted', phase: 'initial', events: [] });
  const acceptedOnline = await (await fresh()).observe(conversationFrame({ deliveryKind: 'online', deltas: [] }), observedAt);
  assert.deepEqual(acceptedOnline, { disposition: 'accepted', phase: 'online', events: [] });
  const recoveryDescriber = await fresh(); recoveryDescriber.markGap();
  const acceptedRecovery = await recoveryDescriber.observe(conversationFrame({ deliveryKind: 'recovery', deltas: [] }), observedAt);
  assert.deepEqual(acceptedRecovery, { disposition: 'accepted', phase: 'recovery', events: [] });

  const cases = [
    ['wire-version', (frame) => { frame.params.wireVersion = 99; }],
    ['envelope-shape', (frame) => { frame.params.hostile = 'ENVELOPE_SECRET'; }],
    ['sequence', (frame) => { frame.params.frame.fromSeq = -1; }],
    ['topic', (frame) => { frame.params.topic = 'conversation/TOPIC_SECRET'; }],
    ['row-kind', (frame) => { frame.params.frame.payload.deltas[0].row.kind = 'SECRET_KIND'; }],
    ['row-shape', (frame) => { frame.params.frame.payload.deltas[0].row.hostile = 'ROW_SECRET'; }],
  ];
  for (const [reason, mutate] of cases) {
    const frame = conversationFrame({ deltas: [toolRow({ input: { command: 'COMMAND_SECRET' } })] }); mutate(frame);
    const result = await (await fresh()).observe(frame, observedAt);
    assert.deepEqual(result, { disposition: 'rejected', reason, events: [] });
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
});

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
    ['UnknownTool', { command: 'SECRET_COMMAND' }, 'Running tool: UnknownTool.'],
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
  const terminal = await describer.observe(conversationFrame({ ordinal: 4, deltas: [toolRow({ status: 'success', input: { command: 'echo ok' }, endedAt: 1_786_233_600_125 })] }), observedAt);
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
    describer.observe(conversationFrame({ ordinal: 2, deltas: [toolRow({ status: 'success', input: { command: 'echo ordered' }, endedAt: 1_786_233_600_010 })] }), observedAt),
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

test('accepts a new file only when its symlink ancestor canonically stays inside the workspace', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-')); await mkdir(join(workspace, 'real')); await symlink(join(workspace, 'real'), join(workspace, 'alias'));
  const describer = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  const events = await describer.observe(conversationFrame({ deltas: [toolRow({ toolName: 'Write', input: { file_path: join(workspace, 'alias', 'new.txt') } })] }), observedAt);
  assert.equal(events[0].message, 'Writing: real/new.txt.');
});

test('fails closed on every missing extra mistyped controlled or unverified captured field before rendering', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const mutations = [
    (frame) => { delete frame.params.logicalFrameId; },
    (frame) => { frame.params.hostile = 'SECRET_EXTRA'; },
    (frame) => { frame.params.logicalFrameOrdinal = '1'; },
    (frame) => { frame.params.logicalFrameId = 'bad\u0000frame'; },
    (frame) => { frame.params.frame.sentAt = '2026-08-09T00:00:00.000Z'; },
    (frame) => { frame.params.frame.hostile = 'SECRET_EXTRA'; },
    (frame) => { frame.params.frame.payload.hostile = 'SECRET_EXTRA'; },
    (frame) => { frame.params.frame.payload.deltas[0].hostile = 'SECRET_EXTRA'; },
    (frame) => { delete frame.params.frame.payload.deltas[0].row.createdAtSeq; },
    (frame) => { frame.params.frame.payload.deltas[0].row.hostile = 'SECRET_EXTRA'; },
    (frame) => { frame.params.frame.payload.deltas[0].row.toolName = 'Bash\u0085SECRET'; },
    (frame) => { frame.params.frame.payload.deltas[0].row.createdAt = Number.NaN; },
    (frame) => { frame.params.frame.payload.deltas[0].row.display = { kind: 'mcp_tool', serverName: 'server', toolName: 'tool', hostile: 'SECRET_EXTRA' }; },
    (frame) => { frame.params.frame.payload.deltas[0].row.status = 'completed'; },
    (frame) => { frame.params.frame.payload.deltas[0].row.status = 'failed'; },
    (frame) => { frame.params.frame.payload.deltas[0].row.status = 'denied'; },
  ];
  for (const mutate of mutations) {
    const describer = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
    const frame = conversationFrame({ deltas: [toolRow({ input: { command: 'DO_NOT_LEAK' } })] }); mutate(frame);
    const events = await describer.observe(frame, observedAt);
    assert.deepEqual(events, []); assert.doesNotMatch(JSON.stringify(events), /DO_NOT_LEAK|SECRET_EXTRA/);
  }
  for (const key of ['wireVersion', 'kind', 'deliveryKind', 'logicalFrameId', 'logicalFrameOrdinal', 'topic', 'subscriptionId', 'frame']) {
    const describer = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
    const frame = conversationFrame({ deltas: [toolRow()] }); delete frame.params[key];
    assert.deepEqual(await describer.observe(frame, observedAt), [], `missing params.${key}`);
  }
  for (const key of ['topic', 'subscriptionId', 'fromSeq', 'toSeq', 'sentAt', 'payload']) {
    const describer = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
    const frame = conversationFrame({ deltas: [toolRow()] }); delete frame.params.frame[key];
    assert.deepEqual(await describer.observe(frame, observedAt), [], `missing frame.${key}`);
  }
  for (const key of ['op', 'row']) {
    const describer = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
    const frame = conversationFrame({ deltas: [toolRow()] }); delete frame.params.frame.payload.deltas[0][key];
    assert.deepEqual(await describer.observe(frame, observedAt), [], `missing delta.${key}`);
  }
  for (const key of ['rowId', 'turnId', 'createdAt', 'createdAtSeq', 'kind', 'toolCallId', 'toolName', 'status', 'inputText']) {
    const describer = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
    const frame = conversationFrame({ deltas: [toolRow()] }); delete frame.params.frame.payload.deltas[0].row[key];
    assert.deepEqual(await describer.observe(frame, observedAt), [], `missing tool row.${key}`);
  }
  const hostileTurn = conversationFrame({ deltas: [turnRow()] }); hostileTurn.params.frame.payload.deltas[0].row.originMeta = { backgroundSource: 'bash', workId: 'work', title: 'title', hostile: 'SECRET_EXTRA' };
  const turnDescriber = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  assert.deepEqual(await turnDescriber.observe(hostileTurn, observedAt), []);
});

test('uses continuous captured sequence and ordinal watermarks without invalid frames poisoning them', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const describer = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  const frame = (ordinal, fromSeq, toSeq, rowId) => conversationFrame({ ordinal, fromSeq, toSeq, deltas: [toolRow({ rowId, input: { command: `echo ${rowId}` } })] });
  assert.equal((await describer.observe(frame(7, 10, 10, 1), observedAt)).length, 1);
  assert.deepEqual(await describer.observe(frame(8, 1, 11, 2), observedAt), []);
  assert.deepEqual(await describer.observe(frame(8, 12, 12, 2), observedAt), []);
  assert.deepEqual(await describer.observe(frame(8, 11, 10, 2), observedAt), []);
  const invalid = frame(8, 11, 11, 2); invalid.params.frame.payload.deltas[0].row.extra = true;
  assert.deepEqual(await describer.observe(invalid, observedAt), []);
  assert.equal((await describer.observe(frame(8, 11, 11, 2), observedAt)).length, 1);
  assert.deepEqual(await describer.observe(frame(8, 11, 11, 3), observedAt), []);
  assert.deepEqual(await describer.observe(frame(10, 12, 12, 3), observedAt), []);
  assert.equal((await describer.observe(frame(9, 12, 12, 3), observedAt)).length, 1);
});

test('recognizes only captured tool failure statuses and turn failure terminal states', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const toolDescriber = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  const failed = await toolDescriber.observe(conversationFrame({ deltas: [toolRow({ status: 'error', input: { command: 'false' }, endedAt: 1_786_233_600_010 })] }), observedAt);
  assert.equal(failed[0].message, 'Command failed: false (10ms).');
  const turnDescriber = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  const turnFailed = await turnDescriber.observe(conversationFrame({ deltas: [turnRow({ state: 'failed' })] }), observedAt);
  assert.equal(turnFailed[0].message, 'ZCode turn ended without success.');
  assert.deepEqual(await turnDescriber.observe(conversationFrame({ ordinal: 2, deltas: [toolRow()] }), observedAt), []);
});

test('bounds direct concurrent observations, path stalls, frame fanout, and tracked tool cardinality', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  let pathCalls = 0;
  const stalled = await createConversationProgressDescriber(
    { sessionId: 'session-1', subscriptionId: 'sub-1', workspace },
    { pathTimeoutMs: 20, resolvePath: async () => { pathCalls += 1; return new Promise(() => {}); } },
  );
  const observations = Array.from({ length: 40 }, (_, index) => stalled.observe(conversationFrame({ ordinal: index + 1, deltas: [toolRow({ rowId: index + 1, toolName: 'Read', input: { file_path: 'x' } })] }), observedAt));
  const settled = await Promise.all(observations);
  assert.ok(pathCalls <= 5); assert.equal(settled.flat().length, 0);

  const bounded = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  const huge = conversationFrame({ ordinal: 1, deltas: Array.from({ length: 65 }, (_, rowId) => toolRow({ rowId: rowId + 1 })) });
  assert.deepEqual(await bounded.observe(huge, observedAt), []);
  assert.equal((await bounded.observe(conversationFrame({ ordinal: 1, deltas: [toolRow()] }), observedAt)).length, 1);

  const cardinality = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  for (let index = 1; index <= 256; index += 1) assert.equal((await cardinality.observe(conversationFrame({ ordinal: index, deltas: [toolRow({ rowId: index })] }), observedAt)).length, 1);
  assert.deepEqual(await cardinality.observe(conversationFrame({ ordinal: 257, deltas: [toolRow({ rowId: 257 })] }), observedAt), []);
});

test('queue overflow requires an exact newer recovery baseline before continuous online progress resumes', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const describer = await createConversationProgressDescriber(
    { sessionId: 'session-1', subscriptionId: 'sub-1', workspace },
    { pathTimeoutMs: 20, resolvePath: async () => new Promise(() => {}) },
  );
  assert.equal((await describer.observe(conversationFrame({ ordinal: 1, deltas: [toolRow()] }), observedAt)).length, 1);
  const active = describer.observe(conversationFrame({ ordinal: 2, deltas: [
    toolRow({ rowId: 2, input: { command: 'STAGED_SECRET' } }),
    toolRow({ rowId: 20, toolName: 'Read', input: { file_path: 'stalled' } }),
  ] }), observedAt);
  await new Promise((resolve) => setImmediate(resolve));
  const burst = [active, ...Array.from({ length: 6 }, (_, index) => describer.observe(conversationFrame({ ordinal: index + 3, deltas: [toolRow({ rowId: index + 3, toolName: 'Read', input: { file_path: 'stalled' } })] }), observedAt))];
  assert.equal((await Promise.all(burst)).flat().length, 0);
  assert.deepEqual(await describer.observe(conversationFrame({ ordinal: 9, deltas: [toolRow({ rowId: 9 })] }), observedAt), []);
  const foreignRecovery = conversationFrame({ ordinal: 10, deliveryKind: 'recovery', subscriptionId: 'foreign', deltas: [] });
  assert.deepEqual(await describer.observe(foreignRecovery, observedAt), []);
  const staleRecovery = conversationFrame({ ordinal: 1, fromSeq: 1, toSeq: 1, deliveryKind: 'recovery', deltas: [] });
  assert.deepEqual(await describer.observe(staleRecovery, observedAt), []);
  assert.deepEqual(await describer.observe(conversationFrame({ ordinal: 10, fromSeq: 10, toSeq: 10, deliveryKind: 'recovery', deltas: [] }), observedAt), []);
  const resumed = await describer.observe(conversationFrame({ ordinal: 11, fromSeq: 11, toSeq: 11, deltas: [toolRow({ rowId: 11, input: { command: 'echo recovered' } })] }), observedAt);
  assert.equal(resumed[0].message, 'Running command: echo recovered.');
  describer.markTerminal();
  assert.deepEqual(await describer.observe(conversationFrame({ ordinal: 12, deliveryKind: 'recovery', deltas: [] }), observedAt), []);
  assert.deepEqual(await describer.observe(conversationFrame({ ordinal: 13, deltas: [toolRow({ rowId: 13 })] }), observedAt), []);
});

test('accepts bounded captured multiline tool output without rendering any raw output', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const describer = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  const delta = toolRow({ status: 'success', input: { command: 'safe command' }, endedAt: 1_786_233_600_010 });
  delta.row.output = { text: 'SECRET first line\nsecond\tline\u0000' };
  const events = await describer.observe(conversationFrame({ deltas: [delta] }), observedAt);
  assert.equal(events[0].message, 'Command completed: safe command (10ms).');
  assert.doesNotMatch(JSON.stringify(events), /SECRET|first line|second/);
  const huge = toolRow({ rowId: 2, status: 'success' }); huge.row.output = { text: 'x'.repeat(1_048_577) };
  assert.deepEqual(await describer.observe(conversationFrame({ ordinal: 2, deltas: [huge] }), observedAt), []);
});

test('recovery silently folds terminal turn states and permanently fences later frames', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  for (const state of ['completedSuccess', 'failed', 'completedInterrupted']) {
    const describer = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
    assert.equal((await describer.observe(conversationFrame({ ordinal: 1, deltas: [toolRow()] }), observedAt)).length, 1);
    describer.markGap();
    const recovery = describer.observe(conversationFrame({ ordinal: 2, deliveryKind: 'recovery', deltas: [turnRow({ state })] }), observedAt);
    const pendingLate = describer.observe(conversationFrame({ ordinal: 3, deltas: [toolRow({ rowId: 3, input: { command: 'MUST_NOT_LEAK_AFTER_RECOVERY_TERMINAL' } })] }), observedAt);
    assert.deepEqual(await Promise.all([recovery, pendingLate]), [[], []]);
    assert.deepEqual(await describer.observe(conversationFrame({ ordinal: 4, deliveryKind: 'recovery', deltas: [] }), observedAt), []);
  }
});

test('turn terminal latching is not weakened when bounded row tracking is full', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const describer = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  for (let ordinal = 1; ordinal <= 256; ordinal += 1) {
    assert.equal((await describer.observe(conversationFrame({ ordinal, deltas: [turnRow({ rowId: ordinal, state: 'running' })] }), observedAt)).length, 1);
  }
  const terminal = await describer.observe(conversationFrame({ ordinal: 257, deltas: [turnRow({ rowId: 257, state: 'completedSuccess' })] }), observedAt);
  assert.equal(terminal[0].message, 'ZCode turn completed.');
  assert.deepEqual(await describer.observe(conversationFrame({ ordinal: 258, deltas: [toolRow()] }), observedAt), []);
});

test('recovery silently folds bounded tool states without path resolution and deduplicates later updates', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-')); let pathCalls = 0;
  const describer = await createConversationProgressDescriber(
    { sessionId: 'session-1', subscriptionId: 'sub-1', workspace },
    { resolvePath: async () => { pathCalls += 1; throw new Error('recovery must not resolve paths'); } },
  );
  assert.equal((await describer.observe(conversationFrame({ ordinal: 1, deltas: [toolRow({ toolCallId: 'tool-done' })] }), observedAt)).length, 1);
  describer.markGap();
  assert.deepEqual(await describer.observe(conversationFrame({ ordinal: 2, deliveryKind: 'recovery', deltas: [
    toolRow({ rowId: 1, toolCallId: 'tool-done', status: 'success', toolName: 'Read', input: { file_path: 'RECOVERY_PATH_SECRET' } }),
    toolRow({ rowId: 2, toolCallId: 'tool-running', status: 'running', toolName: 'Read', input: { file_path: 'RECOVERY_PATH_SECRET' } }),
  ] }), observedAt), []);
  assert.equal(pathCalls, 0);
  assert.deepEqual(await describer.observe(conversationFrame({ ordinal: 3, deltas: [toolRow({ rowId: 1, toolCallId: 'tool-done', status: 'success' })] }), observedAt), []);
  assert.deepEqual(await describer.observe(conversationFrame({ ordinal: 4, deltas: [toolRow({ rowId: 2, toolCallId: 'tool-running', status: 'running' })] }), observedAt), []);
  const terminal = await describer.observe(conversationFrame({ ordinal: 5, deltas: [toolRow({ rowId: 2, toolCallId: 'tool-running', status: 'error', input: { command: 'safe terminal' } })] }), observedAt);
  assert.equal(terminal.length, 1); assert.doesNotMatch(JSON.stringify(terminal), /RECOVERY_PATH_SECRET/);
});

test('accepts bounded captured multiline tool errors without rendering raw error content', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const describer = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  const failed = toolRow({ status: 'error', input: { command: 'safe failure' }, endedAt: 1_786_233_600_010 });
  failed.row.error = { code: 'TOOL_FAILED', message: 'ERROR_SECRET first\nsecond\t\u0000\u0085' };
  const events = await describer.observe(conversationFrame({ deltas: [failed] }), observedAt);
  assert.equal(events[0].message, 'Command failed: safe failure (10ms).');
  assert.doesNotMatch(JSON.stringify(events), /ERROR_SECRET|first|second|TOOL_FAILED/);
  const huge = toolRow({ rowId: 2, status: 'error' }); huge.row.error = { code: 'TOOL_FAILED', message: '😀'.repeat(300_000) };
  assert.deepEqual(await describer.observe(conversationFrame({ ordinal: 2, deltas: [huge] }), observedAt), []);
  const badCode = toolRow({ rowId: 3, status: 'error' }); badCode.row.error = { code: 'BAD\nCODE', message: 'allowed opaque message' };
  assert.deepEqual(await describer.observe(conversationFrame({ ordinal: 2, deltas: [badCode] }), observedAt), []);
});

test('bounds the prebind subscribe-response buffer to four notifications and drains it in order', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const deferred = createDeferredConversationProgressObserver({ sessionId: 'session-1', workspace });
  const observations = Array.from({ length: 5 }, (_, index) => deferred.observe(conversationFrame({ ordinal: index + 1, deltas: [toolRow({ rowId: index + 1 })] }), observedAt));
  assert.deepEqual(await observations[4], []);
  await deferred.bind('sub-1');
  const drained = await Promise.all(observations.slice(0, 4));
  assert.equal(drained.flat().length, 4);
  deferred.markTerminal();
  assert.deepEqual(await deferred.observe(conversationFrame({ ordinal: 5, deltas: [toolRow({ rowId: 5 })] }), observedAt), []);
});

test('prebind overflow requires and accepts a newer recovery baseline', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const deferred = createStructuralDeferredObserver({ sessionId: 'session-1', workspace });
  const buffered = Array.from({ length: 4 }, (_, index) => deferred.observe(conversationFrame({ ordinal: index + 1, deltas: [toolRow({ rowId: index + 1 })] }), observedAt));
  assert.deepEqual(await deferred.observe(conversationFrame({ ordinal: 5, deltas: [toolRow({ rowId: 5 })] }), observedAt), { disposition: 'ignored', reason: 'overflow', events: [] });
  await deferred.bind('sub-1'); await Promise.all(buffered);
  assert.deepEqual(await deferred.observe(conversationFrame({ ordinal: 6, deltas: [toolRow({ rowId: 6 })] }), observedAt), { disposition: 'ignored', reason: 'recovery-required', events: [] });
  assert.deepEqual(await deferred.observe(conversationFrame({ ordinal: 7, deliveryKind: 'recovery', deltas: [] }), observedAt), { disposition: 'accepted', phase: 'recovery', events: [] });
  const resumed = await deferred.observe(conversationFrame({ ordinal: 8, deltas: [toolRow({ rowId: 8 })] }), observedAt);
  assert.equal(resumed.disposition, 'accepted'); assert.equal(resumed.phase, 'online'); assert.equal(resumed.events.length, 1);
});

test('overflow during bind latches recovery before a newly buffered recovery frame drains', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const deferred = createStructuralDeferredObserver({ sessionId: 'session-1', workspace });
  const buffered = Array.from({ length: 4 }, (_, index) => deferred.observe(conversationFrame({ ordinal: index + 1, deltas: [toolRow({ rowId: index + 1 })] }), observedAt));
  let overflow; let recovery;
  const injectOverflow = buffered[0].then(() => {
    const capacityGate = deferred.observe(conversationFrame({ ordinal: 5, deltas: [toolRow({ rowId: 5 })] }), observedAt);
    deferred.observe(conversationFrame({ ordinal: 6, deltas: [toolRow({ rowId: 6 })] }), observedAt);
    overflow = deferred.observe(conversationFrame({ ordinal: 7, deltas: [toolRow({ rowId: 7, input: { command: 'PRIVATE_BIND_OVERFLOW' } })] }), observedAt);
    return capacityGate.then(() => { recovery = deferred.observe(conversationFrame({ ordinal: 8, deliveryKind: 'recovery', deltas: [] }), observedAt); });
  });
  await deferred.bind('sub-1'); await injectOverflow;
  const overflowResult = await overflow;
  assert.deepEqual(overflowResult, { disposition: 'ignored', reason: 'overflow', events: [] });
  assert.doesNotMatch(JSON.stringify(overflowResult), /PRIVATE_BIND_OVERFLOW/);
  assert.deepEqual(await recovery, { disposition: 'accepted', phase: 'recovery', events: [] });
  const resumed = await deferred.observe(conversationFrame({ ordinal: 9, deltas: [toolRow({ rowId: 9 })] }), observedAt);
  assert.equal(resumed.disposition, 'accepted'); assert.equal(resumed.phase, 'online'); assert.equal(resumed.events.length, 1);
});

test('prebind markGap resolves buffered observations as recovery-required', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const deferred = createStructuralDeferredObserver({ sessionId: 'session-1', workspace });
  const buffered = deferred.observe(conversationFrame({ deltas: [toolRow()] }), observedAt);
  deferred.markGap();
  assert.deepEqual(await buffered, { disposition: 'ignored', reason: 'recovery-required', events: [] });
  await deferred.bind('sub-1');
  assert.deepEqual(await deferred.observe(conversationFrame({ ordinal: 2, deliveryKind: 'recovery', deltas: [] }), observedAt), { disposition: 'accepted', phase: 'recovery', events: [] });
});

test('deferred observer can fence and recover more than one post-bind overflow episode', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const deferred = createDeferredConversationProgressObserver({ sessionId: 'session-1', workspace }); await deferred.bind('sub-1');
  assert.equal((await deferred.observe(conversationFrame({ ordinal: 1, deltas: [toolRow()] }), observedAt)).length, 1);
  deferred.markGap();
  assert.deepEqual(await deferred.observe(conversationFrame({ ordinal: 2, deliveryKind: 'recovery', deltas: [] }), observedAt), []);
  assert.equal((await deferred.observe(conversationFrame({ ordinal: 3, deltas: [toolRow({ rowId: 3 })] }), observedAt)).length, 1);
  deferred.markGap();
  assert.deepEqual(await deferred.observe(conversationFrame({ ordinal: 4, deltas: [toolRow({ rowId: 4 })] }), observedAt), []);
  assert.deepEqual(await deferred.observe(conversationFrame({ ordinal: 5, deliveryKind: 'recovery', deltas: [] }), observedAt), []);
  assert.equal((await deferred.observe(conversationFrame({ ordinal: 6, deltas: [toolRow({ rowId: 6 })] }), observedAt)).length, 1);
});
