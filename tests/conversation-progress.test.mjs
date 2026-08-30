// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createConversationProgressDescriber as createStructuralDescriber, createDeferredConversationProgressObserver as createStructuralDeferredObserver, normalizePreview } from '../scripts/lib/conversation-progress.mjs';
import { boundedSnapshotFixture, conversationFrame, toolRow, turnRow } from './fixtures/conversation-progress-frames.mjs';

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
    ['envelope-shape', (frame) => { delete frame.params.frame; }],
    ['sequence', (frame) => { frame.params.frame.fromSeq = -1; }],
    ['topic', (frame) => { frame.params.topic = 'conversation/TOPIC_SECRET'; }],
    ['row-shape', (frame) => { frame.params.frame.payload.deltas[0].row.status = 'STATUS_SECRET'; }],
  ];
  for (const [reason, mutate] of cases) {
    const frame = conversationFrame({ deltas: [toolRow({ input: { command: 'COMMAND_SECRET' } })] }); mutate(frame);
    const result = await (await fresh()).observe(frame, observedAt);
    assert.deepEqual(result, { disposition: 'rejected', reason, events: [] });
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
});

test('accepts additive upstream fields without exposing their values', async () => {
  // The base frame is the captured wire-v3 shape; every `future*` member below
  // is a synthetic unit-only projection probe, not a claimed 0.16.5 capture.
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const describer = await createStructuralDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  const frame = conversationFrame({ deltas: [toolRow({ toolName: 'Read', status: 'running' })] });
  frame.futureNotification = 'NOTIFICATION_SECRET';
  frame.params.futureParams = { value: 'PARAMS_SECRET' };
  frame.params.frame.futureFrame = { value: 'FRAME_SECRET' };
  frame.params.frame.payload.futurePayload = { value: 'PAYLOAD_SECRET' };
  frame.params.frame.payload.deltas[0].futureDelta = { value: 'DELTA_SECRET' };
  frame.params.frame.payload.deltas[0].row.futureRow = { value: 'ROW_SECRET' };
  const result = await describer.observe(frame, observedAt);
  assert.deepEqual(result, {
    disposition: 'accepted', phase: 'online',
    events: [{ phase: 'running', message: 'Running tool: Read.', observedAt }],
  });
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test('bounds ignored additive fields across the complete upstream notification', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  for (const mutate of [
    (frame) => { frame.futureNotification = { nested: { value: undefined } }; },
    (frame) => { let value = {}; frame.params.futureParams = value; for (let depth = 0; depth < 65; depth += 1) { value.next = {}; value = value.next; } },
    (frame) => { frame.params.frame.futureFrame = { huge: 'X'.repeat(1_048_577) }; },
  ]) {
    const describer = await createStructuralDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
    const frame = conversationFrame({ deltas: [] }); mutate(frame);
    assert.deepEqual(await describer.observe(frame, observedAt), { disposition: 'rejected', reason: 'envelope-shape', events: [] });
  }
});

test('ignores future shapes for known row fields the progress projection does not consume', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const toolDescriber = await createStructuralDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  const tool = toolRow({ rowId: 1, toolName: 'Read', status: 'running' });
  Object.assign(tool.row, {
    createdAt: { future: 'TOOL_CREATED_SECRET' }, createdAtSeq: 'TOOL_SEQ_SECRET',
    visibility: { future: 'VISIBILITY_SECRET' }, entityId: { future: 'ENTITY_SECRET' },
    productTurnId: ['PRODUCT_SECRET'], actions: { canFork: false, future: 'ACTIONS_SECRET' },
    inputText: { future: 'INPUT_TEXT_SECRET' }, approvalInteractionId: { future: 'APPROVAL_SECRET' },
    backgrounded: 'BACKGROUND_SECRET', workId: { future: 'WORK_SECRET' },
    output: 'OUTPUT_SECRET', error: ['ERROR_SECRET'], progress: 'PROGRESS_SECRET', display: 'DISPLAY_SECRET',
  });
  const toolResult = await toolDescriber.observe(conversationFrame({ deltas: [tool] }), observedAt);
  assert.deepEqual(toolResult.events.map((event) => event.message), ['Running tool: Read.']);
  assert.doesNotMatch(JSON.stringify(toolResult), /SECRET/);

  const turnDescriber = await createStructuralDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  const turn = turnRow({ rowId: 2, state: 'running' });
  Object.assign(turn.row, {
    createdAt: { future: 'TURN_CREATED_SECRET' }, createdAtSeq: 'TURN_SEQ_SECRET',
    visibility: 'VISIBILITY_SECRET', entityId: ['ENTITY_SECRET'], productTurnId: { future: 'PRODUCT_SECRET' },
    actions: { canFork: false, future: 'ACTIONS_SECRET' }, origin: { future: 'ORIGIN_SECRET' },
    startedAt: 'START_SECRET', endedAt: { future: 'END_SECRET' }, executionKind: 'EXECUTION_SECRET',
    sourceCommandId: { future: 'COMMAND_SECRET' }, historyRoundCount: 'HISTORY_SECRET', activeMs: 'ACTIVE_SECRET',
    workSegments: 'SEGMENTS_SECRET', originMeta: ['ORIGIN_META_SECRET'], fileChanges: 'FILES_SECRET',
  });
  const turnResult = await turnDescriber.observe(conversationFrame({ deltas: [turn] }), observedAt);
  assert.deepEqual(turnResult.events.map((event) => event.message), ['ZCode turn started.']);
  assert.doesNotMatch(JSON.stringify(turnResult), /SECRET/);
});

test('ignores future shapes for known envelope snapshot and delta fields it does not consume', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const initialDescriber = await createStructuralDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  const initial = conversationFrame({ deliveryKind: 'initial', fromSeq: 0, toSeq: 1, snapshot: boundedSnapshotFixture({ seq: 1 }) });
  initial.params.logicalFrameId = { future: 'FRAME_ID_SECRET' };
  initial.params.frame.sentAt = { future: 'SENT_AT_SECRET' };
  Object.assign(initial.params.frame.payload.snapshot, {
    availability: 'AVAILABILITY_SECRET', rows: 'ROWS_SECRET', revision: 'REVISION_SECRET',
    logEpoch: { future: 'EPOCH_SECRET' }, usage: ['USAGE_SECRET'],
  });
  const initialResult = await initialDescriber.observe(initial, observedAt);
  assert.deepEqual(initialResult, { disposition: 'accepted', phase: 'initial', events: [] });
  assert.doesNotMatch(JSON.stringify(initialResult), /SECRET/);

  const deltaDescriber = await createStructuralDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  const deltaResult = await deltaDescriber.observe(conversationFrame({ deltas: [
    { op: 'row.delta', rowId: 'ROW_SECRET', path: { future: 'PATH_SECRET' }, append: ['APPEND_SECRET'] },
    { op: 'state.updated', patch: 'PATCH_SECRET' },
  ] }), observedAt);
  assert.deepEqual(deltaResult, { disposition: 'accepted', phase: 'online', events: [] });
  assert.doesNotMatch(JSON.stringify(deltaResult), /SECRET/);
});

test('accepts the 0.16.3 initial snapshot as an opaque baseline then keeps production delta operations contiguous', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const describer = await createStructuralDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  const historical = toolRow({ rowId: 40, toolCallId: 'historical', input: { command: 'DO_NOT_REPLAY' } }).row;
  const initial = await describer.observe(conversationFrame({
    deliveryKind: 'initial', ordinal: 1, fromSeq: 0, toSeq: 484,
    snapshot: boundedSnapshotFixture({ rows: { firstRowId: 1, totalCount: 60, window: [historical] } }),
  }), observedAt);
  const state = await describer.observe(conversationFrame({
    ordinal: 2, fromSeq: 484, toSeq: 485,
    deltas: [{ op: 'state.updated', patch: { usage: { privateCounter: 1 } } }],
  }), observedAt);
  const text = await describer.observe(conversationFrame({
    ordinal: 3, fromSeq: 485, toSeq: 486,
    deltas: [{ op: 'row.delta', rowId: 41, path: 'text', append: 'PRIVATE_REASONING' }],
  }), observedAt);
  const removed = await describer.observe(conversationFrame({
    ordinal: 4, fromSeq: 486, toSeq: 487,
    deltas: [{ op: 'row.removed', fromRowId: 39 }],
  }), observedAt);
  const appended = await describer.observe(conversationFrame({
    ordinal: 5, fromSeq: 487, toSeq: 488,
    deltas: [{ ...toolRow({ rowId: 42, toolCallId: 'current', toolName: 'Write', status: 'running' }), op: 'row.appended' }],
  }), observedAt);
  const upserted = await describer.observe(conversationFrame({
    ordinal: 6, fromSeq: 488, toSeq: 489,
    deltas: [toolRow({ rowId: 42, toolCallId: 'current', toolName: 'Write', status: 'success' })],
  }), observedAt);

  assert.deepEqual(initial, { disposition: 'accepted', phase: 'initial', events: [] });
  assert.deepEqual(state, { disposition: 'accepted', phase: 'online', events: [] });
  assert.deepEqual(text, { disposition: 'accepted', phase: 'online', events: [] });
  assert.deepEqual(removed, { disposition: 'accepted', phase: 'online', events: [] });
  assert.deepEqual(appended.events.map((event) => event.message), ['Running tool: Write.']);
  assert.deepEqual(upserted.events.map((event) => event.message), ['Write completed.']);
  assert.doesNotMatch(JSON.stringify([initial, state, text, removed, appended, upserted]), /DO_NOT_REPLAY|PRIVATE_/);

  const overflowSnapshot = await describer.observe(conversationFrame({
    deliveryKind: 'online', ordinal: 7, fromSeq: 0, toSeq: 500,
    snapshot: boundedSnapshotFixture({ seq: 500, rows: { firstRowId: 1, totalCount: 60, window: [historical] } }),
  }), observedAt);
  const afterOverflow = await describer.observe(conversationFrame({
    ordinal: 8, fromSeq: 500, toSeq: 501,
    deltas: [toolRow({ rowId: 42, toolCallId: 'current', toolName: 'Write', status: 'running' })],
  }), observedAt);
  assert.deepEqual(overflowSnapshot, { disposition: 'accepted', phase: 'online', events: [] });
  assert.deepEqual(afterOverflow.events.map((event) => event.message), ['Running tool: Write.']);

  const removal = await describer.observe(conversationFrame({
    ordinal: 9, fromSeq: 501, toSeq: 502, deltas: [{ op: 'row.removed', fromRowId: 42 }],
  }), observedAt);
  const afterRemoval = await describer.observe(conversationFrame({
    ordinal: 10, fromSeq: 502, toSeq: 503,
    deltas: [toolRow({ rowId: 42, toolCallId: 'current', toolName: 'Write', status: 'running' })],
  }), observedAt);
  assert.deepEqual(removal, { disposition: 'accepted', phase: 'online', events: [] });
  assert.deepEqual(afterRemoval.events.map((event) => event.message), ['Running tool: Write.']);

  describer.markGap();
  assert.deepEqual(await describer.observe(conversationFrame({
    deliveryKind: 'recovery', ordinal: 11, fromSeq: 503, toSeq: 503, deltas: [],
  }), observedAt), { disposition: 'accepted', phase: 'recovery', events: [] });

  const gapDescriber = await createStructuralDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  await gapDescriber.observe(conversationFrame({ deliveryKind: 'initial', ordinal: 1, fromSeq: 0, toSeq: 484, snapshot: boundedSnapshotFixture() }), observedAt);
  assert.deepEqual(await gapDescriber.observe(conversationFrame({ ordinal: 2, fromSeq: 485, toSeq: 486, deltas: [] }), observedAt), {
    disposition: 'rejected', reason: 'sequence', events: [],
  });
});

test('rejects malformed oversized or identity-conflicting snapshots and unsafe delta envelopes without leaking content', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const cases = [
    (frame) => { frame.params.frame.payload.snapshot = ['NOT_AN_OBJECT']; },
    (frame) => { frame.params.frame.payload.snapshot = { huge: 'S'.repeat(1_048_577) }; },
    (frame) => { frame.params.frame.payload = { kind: 'snapshot', snapshot: { nested: { value: undefined } } }; },
    (frame) => { frame.params.frame.payload.snapshot.protocolVersion = 2; },
    (frame) => { frame.params.frame.payload.snapshot.sessionId = 'foreign'; },
    (frame) => { frame.params.frame.payload.snapshot.seq = 2; },
    (frame) => { frame.params.frame.fromSeq = 1; },
  ];
  for (const mutate of cases) {
    const describer = await createStructuralDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
    const frame = conversationFrame({ deliveryKind: 'initial', fromSeq: 0, toSeq: 1, snapshot: boundedSnapshotFixture() });
    mutate(frame);
    assert.deepEqual(await describer.observe(frame, observedAt), { disposition: 'rejected', reason: 'envelope-shape', events: [] });
  }

  const deltaCases = [
    [{ op: 'row.removed', fromRowId: '1' }, 'row-shape'],
    [{ op: 'row.delta', rowId: 1, path: 'text', append: 'X'.repeat(1_048_577) }, 'envelope-shape'],
    [{ op: 'state.updated', patch: { nested: { value: undefined } } }, 'envelope-shape'],
  ];
  for (const [delta, reason] of deltaCases) {
    const describer = await createStructuralDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
    const result = await describer.observe(conversationFrame({ deltas: [delta] }), observedAt);
    assert.deepEqual(result, { disposition: 'rejected', reason, events: [] });
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
});

test('accepts the 0.16.3 subscriber operation limit while enforcing the complete-frame byte bound', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const fresh = () => createStructuralDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  const bounded = Array.from({ length: 500 }, (_, index) => ({ op: 'state.updated', patch: { revision: index } }));
  assert.deepEqual(await (await fresh()).observe(conversationFrame({ deltas: bounded }), observedAt), {
    disposition: 'accepted', phase: 'online', events: [],
  });
  assert.deepEqual(await (await fresh()).observe(conversationFrame({ deltas: [...bounded, bounded[0]] }), observedAt), {
    disposition: 'rejected', reason: 'envelope-shape', events: [],
  });
  const oversized = Array.from({ length: 500 }, (_, index) => ({
    op: 'row.delta', rowId: index, path: 'text', append: 'PRIVATE'.repeat(500),
  }));
  assert.deepEqual(await (await fresh()).observe(conversationFrame({ deltas: oversized }), observedAt), {
    disposition: 'rejected', reason: 'envelope-shape', events: [],
  });
});

test('observed unknown rows stay private while a sequence gap requires recovery before later progress', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const describer = await createStructuralDescriber({
    sessionId: 'session-observed',
    subscriptionId: 'subscription-observed',
    workspace,
  });
  const frame = (options) => conversationFrame({
    sessionId: 'session-observed', subscriptionId: 'subscription-observed', ...options,
  });
  const unknownRow = (rowId, marker) => ({
    op: 'row.upserted',
    row: {
      rowId, turnId: 'turn-observed', createdAt: 1_786_233_600_000,
      createdAtSeq: rowId, kind: 'assistantDraft', content: marker,
    },
  });

  const first = await describer.observe(frame({
    ordinal: 1, fromSeq: 0, toSeq: 1,
    deltas: [turnRow({ rowId: 1, state: 'running' }), unknownRow(2, 'PRIVATE_UNKNOWN_ROW')],
  }), observedAt);
  const duplicate = await describer.observe(frame({
    ordinal: 1, fromSeq: 0, toSeq: 1,
    deltas: [unknownRow(3, 'PRIVATE_STALE_ROW')],
  }), observedAt);
  const gap = await describer.observe(frame({
    ordinal: 4, fromSeq: 1, toSeq: 4,
    deltas: [toolRow({ rowId: 4, toolCallId: 'tool-safe', toolName: 'Read', status: 'running' })],
  }), observedAt);
  const fenced = await describer.observe(frame({
    ordinal: 2, fromSeq: 1, toSeq: 2,
    deltas: [unknownRow(5, 'PRIVATE_INTERLEAVED_ROW'), toolRow({ rowId: 6, toolCallId: 'tool-safe', toolName: 'Read', status: 'success' })],
  }), observedAt);
  const recovery = await describer.observe(frame({ ordinal: 4, fromSeq: 1, toSeq: 4, deliveryKind: 'recovery', deltas: [] }), observedAt);
  const later = await describer.observe(frame({
    ordinal: 5, fromSeq: 4, toSeq: 5,
    deltas: [unknownRow(5, 'PRIVATE_INTERLEAVED_ROW'), toolRow({ rowId: 6, toolCallId: 'tool-safe', toolName: 'Read', status: 'success' })],
  }), observedAt);

  assert.deepEqual(first.events.map((event) => event.message), ['ZCode turn started.']);
  assert.deepEqual(duplicate, { disposition: 'ignored', reason: 'stale', events: [] });
  assert.deepEqual(gap, { disposition: 'rejected', reason: 'sequence', events: [] });
  assert.deepEqual(fenced, { disposition: 'ignored', reason: 'recovery-required', events: [] });
  assert.deepEqual(recovery, { disposition: 'accepted', phase: 'recovery', events: [] });
  assert.deepEqual(later.events.map((event) => event.message), ['Read completed.']);
  assert.doesNotMatch(JSON.stringify([first, duplicate, gap, fenced, recovery, later]), /PRIVATE_(?:UNKNOWN|STALE|INTERLEAVED)_ROW/);

  {
    const strict = await createStructuralDescriber({ sessionId: 'session-observed', subscriptionId: 'subscription-observed', workspace });
    const delta = unknownRow(1, 'PRIVATE_INVALID_UNKNOWN'); delta.row.turnId = 'ignored\nfuture-shape';
    const result = await strict.observe(frame({ ordinal: 1, deltas: [delta] }), observedAt);
    assert.deepEqual(result, { disposition: 'accepted', phase: 'online', events: [] });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_INVALID_UNKNOWN/);
  }
  {
    const strict = await createStructuralDescriber({ sessionId: 'session-observed', subscriptionId: 'subscription-observed', workspace });
    const delta = unknownRow(1, 'x'.repeat(1_048_577));
    const result = await strict.observe(frame({ ordinal: 1, deltas: [delta] }), observedAt);
    assert.deepEqual(result, { disposition: 'rejected', reason: 'envelope-shape', events: [] });
  }
});

test('overlapping online deltas cannot clear deduplication or replay tool activity before recovery', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const describer = await createStructuralDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  const running = toolRow({ rowId: 10, toolCallId: 'tool-current', toolName: 'Read', status: 'running' });
  assert.deepEqual(await describer.observe(conversationFrame({
    deliveryKind: 'initial', ordinal: 1, fromSeq: 0, toSeq: 10,
    snapshot: boundedSnapshotFixture({ seq: 10 }),
  }), observedAt), { disposition: 'accepted', phase: 'initial', events: [] });
  assert.deepEqual((await describer.observe(conversationFrame({ ordinal: 2, fromSeq: 10, toSeq: 11, deltas: [running] }), observedAt)).events.map((event) => event.message), ['Running tool: Read.']);
  assert.deepEqual(await describer.observe(conversationFrame({
    ordinal: 3, fromSeq: 0, toSeq: 12,
    deltas: [{ op: 'row.removed', fromRowId: 10 }, running],
  }), observedAt), { disposition: 'rejected', reason: 'sequence', events: [] });
  assert.deepEqual(await describer.observe(conversationFrame({ ordinal: 3, fromSeq: 11, toSeq: 12, deltas: [running] }), observedAt), {
    disposition: 'ignored', reason: 'recovery-required', events: [],
  });
  assert.deepEqual(await describer.observe(conversationFrame({
    deliveryKind: 'recovery', ordinal: 3, fromSeq: 11, toSeq: 12, deltas: [running],
  }), observedAt), { disposition: 'accepted', phase: 'recovery', events: [] });
  const completed = await describer.observe(conversationFrame({
    ordinal: 4, fromSeq: 12, toSeq: 13,
    deltas: [toolRow({ rowId: 10, toolCallId: 'tool-current', toolName: 'Read', status: 'success' })],
  }), observedAt);
  assert.deepEqual(completed.events.map((event) => event.message), ['Read completed.']);
});

test('a recovery delta must cover the trusted sequence before it can unlock online progress', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const describer = await createStructuralDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  assert.deepEqual(await describer.observe(conversationFrame({
    deliveryKind: 'initial', ordinal: 1, fromSeq: 0, toSeq: 10,
    snapshot: boundedSnapshotFixture({ seq: 10 }),
  }), observedAt), { disposition: 'accepted', phase: 'initial', events: [] });
  assert.equal((await describer.observe(conversationFrame({
    ordinal: 2, fromSeq: 10, toSeq: 11, deltas: [toolRow({ rowId: 10, toolCallId: 'trusted', status: 'running' })],
  }), observedAt)).events.length, 1);
  assert.deepEqual(await describer.observe(conversationFrame({ ordinal: 4, fromSeq: 11, toSeq: 12, deltas: [] }), observedAt), {
    disposition: 'rejected', reason: 'sequence', events: [],
  });
  assert.deepEqual(await describer.observe(conversationFrame({
    deliveryKind: 'recovery', ordinal: 4, fromSeq: 20, toSeq: 21, deltas: [],
  }), observedAt), { disposition: 'rejected', reason: 'sequence', events: [] });
  assert.deepEqual(await describer.observe(conversationFrame({ ordinal: 3, fromSeq: 11, toSeq: 12, deltas: [] }), observedAt), {
    disposition: 'ignored', reason: 'recovery-required', events: [],
  });
  assert.deepEqual(await describer.observe(conversationFrame({
    deliveryKind: 'recovery', ordinal: 4, fromSeq: 11, toSeq: 21, deltas: [],
  }), observedAt), { disposition: 'accepted', phase: 'recovery', events: [] });
  const resumed = await describer.observe(conversationFrame({
    ordinal: 5, fromSeq: 21, toSeq: 22, deltas: [toolRow({ rowId: 11, toolCallId: 'resumed', status: 'running' })],
  }), observedAt);
  assert.deepEqual(resumed.events.map((event) => event.message), ['Running tool: Bash.']);
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

test('fails closed on every missing mistyped controlled or unverified consumed field before rendering', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const mutations = [
    (frame) => { frame.params.logicalFrameOrdinal = '1'; },
    (frame) => { frame.params.frame.payload.deltas[0].row.toolName = 'Bash\u0085SECRET'; },
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
  for (const key of ['wireVersion', 'kind', 'deliveryKind', 'logicalFrameOrdinal', 'topic', 'subscriptionId', 'frame']) {
    const describer = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
    const frame = conversationFrame({ deltas: [toolRow()] }); delete frame.params[key];
    assert.deepEqual(await describer.observe(frame, observedAt), [], `missing params.${key}`);
  }
  for (const key of ['topic', 'subscriptionId', 'fromSeq', 'toSeq', 'payload']) {
    const describer = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
    const frame = conversationFrame({ deltas: [toolRow()] }); delete frame.params.frame[key];
    assert.deepEqual(await describer.observe(frame, observedAt), [], `missing frame.${key}`);
  }
  for (const key of ['op', 'row']) {
    const describer = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
    const frame = conversationFrame({ deltas: [toolRow()] }); delete frame.params.frame.payload.deltas[0][key];
    assert.deepEqual(await describer.observe(frame, observedAt), [], `missing delta.${key}`);
  }
  for (const key of ['rowId', 'kind', 'toolCallId', 'toolName', 'status']) {
    const describer = await createConversationProgressDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
    const frame = conversationFrame({ deltas: [toolRow()] }); delete frame.params.frame.payload.deltas[0].row[key];
    assert.deepEqual(await describer.observe(frame, observedAt), [], `missing tool row.${key}`);
  }
});

test('rejects discontinuities without trusting their watermark and accepts an authoritative snapshot reset', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const describer = await createStructuralDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  const frame = (ordinal, fromSeq, toSeq, rowId) => conversationFrame({ ordinal, fromSeq, toSeq, deltas: [toolRow({ rowId, input: { command: `echo ${rowId}` } })] });
  assert.equal((await describer.observe(frame(7, 10, 10, 1), observedAt)).events.length, 1);
  assert.deepEqual(await describer.observe(frame(8, 12, 12, 2), observedAt), { disposition: 'rejected', reason: 'sequence', events: [] });
  assert.deepEqual(await describer.observe(frame(8, 10, 11, 2), observedAt), { disposition: 'ignored', reason: 'recovery-required', events: [] });
  assert.deepEqual(await describer.observe(conversationFrame({
    ordinal: 8, fromSeq: 0, toSeq: 12, deliveryKind: 'online', snapshot: boundedSnapshotFixture({ seq: 12 }),
  }), observedAt), { disposition: 'accepted', phase: 'online', events: [] });
  assert.equal((await describer.observe(frame(9, 12, 13, 3), observedAt)).events.length, 1);
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
  const huge = conversationFrame({ ordinal: 1, deltas: Array.from({ length: 500 }, (_, rowId) => toolRow({ rowId: rowId + 1 })) });
  assert.equal((await bounded.observe(huge, observedAt)).length, 64);
  assert.equal((await bounded.observe(conversationFrame({ ordinal: 2, deltas: [toolRow({ rowId: 501 })] }), observedAt)).length, 0);

  let fanoutPathCalls = 0;
  const boundedPathWork = await createConversationProgressDescriber(
    { sessionId: 'session-1', subscriptionId: 'sub-1', workspace },
    { resolvePath: async () => { fanoutPathCalls += 1; return null; } },
  );
  const readFanout = Array.from({ length: 500 }, (_, rowId) => toolRow({ rowId: rowId + 1, toolName: 'Read', input: { file_path: 'private' } }));
  assert.equal((await boundedPathWork.observe(conversationFrame({ deltas: readFanout }), observedAt)).length, 64);
  assert.equal(fanoutPathCalls, 64);

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
  assert.deepEqual(await describer.observe(conversationFrame({ ordinal: 10, fromSeq: 1, toSeq: 10, deliveryKind: 'recovery', deltas: [] }), observedAt), []);
  const resumed = await describer.observe(conversationFrame({ ordinal: 11, fromSeq: 10, toSeq: 11, deltas: [toolRow({ rowId: 11, input: { command: 'echo recovered' } })] }), observedAt);
  assert.equal(resumed[0].message, 'Running command: echo recovered.');
  describer.markTerminal();
  assert.deepEqual(await describer.observe(conversationFrame({ ordinal: 12, deliveryKind: 'recovery', deltas: [] }), observedAt), []);
  assert.deepEqual(await describer.observe(conversationFrame({ ordinal: 13, deltas: [toolRow({ rowId: 13 })] }), observedAt), []);
});

test('a gap during async projection discards staged lifecycle state and its watermark', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  let releasePath;
  let reportPathStarted;
  const pathStarted = new Promise((resolve) => { reportPathStarted = resolve; });
  const pathGate = new Promise((resolve) => { releasePath = resolve; });
  const describer = await createStructuralDescriber(
    { sessionId: 'session-1', subscriptionId: 'sub-1', workspace },
    { resolvePath: async () => { reportPathStarted(); await pathGate; return null; } },
  );

  assert.deepEqual(await describer.observe(conversationFrame({
    ordinal: 1, fromSeq: 0, toSeq: 1,
    deltas: [{ op: 'state.updated', patch: { revision: 1 } }],
  }), observedAt), { disposition: 'accepted', phase: 'online', events: [] });

  const interrupted = describer.observe(conversationFrame({
    ordinal: 2, fromSeq: 1, toSeq: 2,
    deltas: [
      toolRow({ rowId: 2, toolCallId: 'staged-tool', input: { command: 'STAGED_MARKER' } }),
      toolRow({ rowId: 3, toolCallId: 'path-tool', toolName: 'Read', input: { file_path: 'blocked' } }),
    ],
  }), observedAt);
  await pathStarted;
  describer.markGap();
  releasePath();
  assert.deepEqual(await interrupted, { disposition: 'ignored', reason: 'recovery-required', events: [] });

  assert.deepEqual(await describer.observe(conversationFrame({
    deliveryKind: 'recovery', ordinal: 2, fromSeq: 1, toSeq: 1, deltas: [],
  }), observedAt), { disposition: 'accepted', phase: 'recovery', events: [] });

  const terminal = await describer.observe(conversationFrame({
    ordinal: 3, fromSeq: 1, toSeq: 2,
    deltas: [toolRow({
      rowId: 2, toolCallId: 'staged-tool', status: 'success', input: { command: 'SAFE_TERMINAL' },
      endedAt: 1_786_233_600_010,
    })],
  }), observedAt);
  assert.deepEqual(terminal.events.map((event) => event.message), ['Command completed: SAFE_TERMINAL (10ms).']);
  assert.doesNotMatch(JSON.stringify(terminal), /STAGED_MARKER/);
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

test('accepts an equal-sequence empty recovery but ignores equal-sequence delta replay', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const describer = await createStructuralDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  assert.equal((await describer.observe(conversationFrame({ ordinal: 1, deltas: [toolRow({ status: 'running' })] }), observedAt)).events.length, 1);
  assert.deepEqual(await describer.observe(conversationFrame({
    deliveryKind: 'recovery', ordinal: 2, fromSeq: 1, toSeq: 1,
    deltas: [toolRow({ status: 'success', endedAt: 1_786_233_600_010 })],
  }), observedAt), { disposition: 'ignored', reason: 'stale', events: [] });
  const completed = await describer.observe(conversationFrame({
    ordinal: 3, fromSeq: 1, toSeq: 2,
    deltas: [toolRow({ status: 'success', endedAt: 1_786_233_600_010 })],
  }), observedAt);
  assert.deepEqual(completed.events.map((event) => event.message), ['Bash completed (10ms).']);
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

test('an ordinal gap fences online progress until a valid recovery baseline restores it', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-'));
  const describer = await createStructuralDescriber({ sessionId: 'session-1', subscriptionId: 'sub-1', workspace });
  assert.deepEqual(await describer.observe(conversationFrame({ ordinal: 1, deliveryKind: 'recovery', deltas: [] }), observedAt), {
    disposition: 'accepted', phase: 'recovery', events: [],
  });
  assert.deepEqual(await describer.observe(conversationFrame({ ordinal: 3, deltas: [] }), observedAt), {
    disposition: 'rejected', reason: 'sequence', events: [],
  });
  for (const ordinal of [4, 5, 6]) assert.deepEqual(await describer.observe(conversationFrame({ ordinal, deltas: [] }), observedAt), {
    disposition: 'ignored', reason: 'recovery-required', events: [],
  });
  assert.deepEqual(await describer.observe(conversationFrame({ ordinal: 7, fromSeq: 1, toSeq: 7, deliveryKind: 'recovery', deltas: [] }), observedAt), {
    disposition: 'accepted', phase: 'recovery', events: [],
  });
  const resumed = await describer.observe(conversationFrame({ ordinal: 8, fromSeq: 7, toSeq: 8, deltas: [toolRow({ rowId: 8 })] }), observedAt);
  assert.equal(resumed.disposition, 'accepted'); assert.equal(resumed.phase, 'online'); assert.equal(resumed.events.length, 1);
  assert.doesNotMatch(JSON.stringify(resumed), /frame-|tool-8|turn-1/);
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
  const ignoredErrorShape = toolRow({ rowId: 3, status: 'error' }); ignoredErrorShape.row.error = { code: 'BAD\nCODE', message: 'ERROR_SECRET ignored opaque message' };
  const ignoredErrorEvents = await describer.observe(conversationFrame({ ordinal: 2, deltas: [ignoredErrorShape] }), observedAt);
  assert.deepEqual(ignoredErrorEvents.map((event) => event.message), ['Bash failed.']);
  assert.doesNotMatch(JSON.stringify(ignoredErrorEvents), /ERROR_SECRET|BAD/);
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
  assert.deepEqual(await deferred.observe(conversationFrame({ ordinal: 5, deltas: [toolRow({ rowId: 5 })] }), observedAt), { disposition: 'ignored', reason: 'recovery-required', events: [] });
  assert.deepEqual(await deferred.observe(conversationFrame({ ordinal: 6, deltas: [toolRow({ rowId: 6 })] }), observedAt), { disposition: 'ignored', reason: 'recovery-required', events: [] });
  assert.deepEqual(await deferred.observe(conversationFrame({ ordinal: 7, fromSeq: 4, toSeq: 7, deliveryKind: 'recovery', deltas: [] }), observedAt), { disposition: 'accepted', phase: 'recovery', events: [] });
  const resumed = await deferred.observe(conversationFrame({ ordinal: 8, fromSeq: 7, toSeq: 8, deltas: [toolRow({ rowId: 8 })] }), observedAt);
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
    return capacityGate.then(() => { recovery = deferred.observe(conversationFrame({ ordinal: 8, fromSeq: 1, toSeq: 8, deliveryKind: 'recovery', deltas: [] }), observedAt); });
  });
  await deferred.bind('sub-1'); await injectOverflow;
  const overflowResult = await overflow;
  assert.deepEqual(overflowResult, { disposition: 'ignored', reason: 'overflow', events: [] });
  assert.doesNotMatch(JSON.stringify(overflowResult), /PRIVATE_BIND_OVERFLOW/);
  assert.deepEqual(await recovery, { disposition: 'accepted', phase: 'recovery', events: [] });
  const resumed = await deferred.observe(conversationFrame({ ordinal: 9, fromSeq: 8, toSeq: 9, deltas: [toolRow({ rowId: 9 })] }), observedAt);
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
  assert.deepEqual(await deferred.observe(conversationFrame({ ordinal: 5, fromSeq: 3, toSeq: 5, deliveryKind: 'recovery', deltas: [] }), observedAt), []);
  assert.equal((await deferred.observe(conversationFrame({ ordinal: 6, fromSeq: 5, toSeq: 6, deltas: [toolRow({ rowId: 6 })] }), observedAt)).length, 1);
});
