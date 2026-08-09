// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createConversationProgressDescriber } from '../scripts/lib/conversation-progress.mjs';
import * as progressModule from '../scripts/lib/progress.mjs';
import {
  MAX_PROGRESS_MESSAGE_BYTES,
  MAX_PROGRESS_PREVIEW_ENTRIES,
  PROGRESS_HEARTBEAT_MS,
  PROGRESS_PHASES,
  normalizeZCodeProgress,
} from '../scripts/lib/progress.mjs';
import { conversationFrame, toolRow } from './fixtures/conversation-progress-frames.mjs';

const observedAt = '2026-08-08T00:00:00.000Z';

function notification(reason, patch = {}, overrides = {}) {
  return {
    method: 'state.updated',
    params: {
      type: 'state.updated',
      scope: 'session',
      sessionId: 'session-a',
      revision: 2,
      reason,
      patch,
      ...overrides,
    },
  };
}

test('exports fixed progress bounds and phases', () => {
  assert.deepEqual(PROGRESS_PHASES, ['starting', 'running', 'waiting', 'finalizing']);
  assert.equal(MAX_PROGRESS_PREVIEW_ENTRIES, 4);
  assert.equal(progressModule.MAX_PROGRESS_PENDING_EVENTS, 4);
  assert.equal(MAX_PROGRESS_MESSAGE_BYTES, 256);
  assert.equal(PROGRESS_HEARTBEAT_MS, 20_000);
  assert.equal(progressModule.MAX_PROGRESS_DIAGNOSTIC_KINDS, 8);
});

test('normalizes known same-session activity to fixed public messages', () => {
  const cases = [
    ['prompt_started', 'starting', 'ZCode started the delegated turn.'],
    ['model_streaming', 'running', 'ZCode is generating a response.'],
    ['tool_call_started', 'running', 'ZCode started a tool call.'],
    ['tool_call_progress', 'running', 'ZCode tool work is still running.'],
    ['tool_call_result', 'running', 'ZCode completed a tool call.'],
    ['api_retry', 'waiting', 'ZCode is retrying the model request.'],
    ['prompt_completed', 'finalizing', 'ZCode completed the delegated turn.'],
    ['prompt_failed', 'finalizing', 'ZCode reported a failed delegated turn.'],
  ];
  for (const [reason, phase, message] of cases) {
    assert.deepEqual(normalizeZCodeProgress(notification(reason), 'session-a', observedAt), { phase, message, observedAt });
  }
});

test('uses a generic message for bounded unknown reasons without exposing patches', () => {
  const event = normalizeZCodeProgress(notification('future_secret_reason', {
    apiKey: 'never-render-this',
    command: 'curl -H Authorization:secret',
    reasoning: 'private chain of thought',
  }), 'session-a', observedAt);
  assert.deepEqual(event, { phase: 'running', message: 'ZCode reported activity.', observedAt });
  assert.doesNotMatch(JSON.stringify(event), /future_secret_reason|never-render-this|Authorization|chain of thought/);
});

test('rejects notifications outside the safe same-session boundary', () => {
  const cases = [
    null,
    [],
    'frame',
    {},
    { method: 'session.updated', params: notification('tool_call_started').params },
    notification('tool_call_started', {}, { scope: 'workspace' }),
    notification('tool_call_started', {}, { sessionId: 'session-b' }),
    notification(''),
    notification('tool\u0007call'),
    notification('tool\u0085call'),
    notification('x'.repeat(257)),
  ];
  for (const frame of cases) assert.equal(normalizeZCodeProgress(frame, 'session-a', observedAt), null);
});

test('enforces the reason limit in UTF-8 bytes at a multibyte boundary', () => {
  const reason256 = `${'é'.repeat(127)}ab`;
  const reason257 = `${'é'.repeat(127)}abc`;
  assert.equal(Buffer.byteLength(reason256), 256);
  assert.equal(Buffer.byteLength(reason257), 257);
  assert.deepEqual(normalizeZCodeProgress(notification(reason256), 'session-a', observedAt), {
    phase: 'running',
    message: 'ZCode reported activity.',
    observedAt,
  });
  assert.equal(normalizeZCodeProgress(notification(reason257), 'session-a', observedAt), null);
});

test('rejects invalid observation timestamps', () => {
  for (const timestamp of [undefined, null, '', 'not-a-date', 0, '2026-02-30T00:00:00.000Z']) {
    assert.equal(normalizeZCodeProgress(notification('tool_call_started'), 'session-a', timestamp), null);
  }
});

test('reports the in-flight event immediately, suppresses duplicates, and serializes pending output with persistence', async () => {
  const lines = [];
  const persistenceStarted = [];
  const persisted = [];
  const releases = [];
  let signalSecondStarted;
  const secondStarted = new Promise((resolve) => { signalSecondStarted = resolve; });
  let currentTime = observedAt;
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a',
    write: (line) => lines.push(line),
    persist: async (event) => {
      persistenceStarted.push(event.message);
      if (persistenceStarted.length === 2) signalSecondStarted();
      await new Promise((resolve) => releases.push(resolve));
      persisted.push(event);
    },
    now: () => currentTime,
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
  });

  reporter.observe(notification('tool_call_started'));
  reporter.observe(notification('tool_call_started', { secret: 'duplicate must stay private' }));
  currentTime = '2026-08-08T00:00:01.000Z';
  reporter.observe(notification('api_retry'));

  assert.deepEqual(lines, ['[zcode] ZCode started a tool call.\n']);
  await Promise.resolve();
  assert.deepEqual(persistenceStarted, ['ZCode started a tool call.']);
  releases.shift()();
  await secondStarted;
  assert.deepEqual(persistenceStarted, ['ZCode started a tool call.', 'ZCode is retrying the model request.']);
  assert.deepEqual(lines, [
    '[zcode] ZCode started a tool call.\n',
    '[zcode] ZCode is retrying the model request.\n',
  ]);
  releases.shift()();
  await reporter.flush();
  assert.deepEqual(persisted, [
    { phase: 'running', message: 'ZCode started a tool call.', observedAt },
    { phase: 'waiting', message: 'ZCode is retrying the model request.', observedAt: currentTime },
  ]);
});

test('bounds pending persistence and output while retaining the latest event under flood', async () => {
  const calls = []; const persisted = []; const lines = [];
  let releaseFirst = () => {};
  const firstBlocked = new Promise((resolve) => { releaseFirst = () => resolve(undefined); });
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a', write: (line) => lines.push(line),
    persist: async (event) => { calls.push(event); if (calls.length === 1) await firstBlocked; persisted.push(event); },
    now: () => observedAt, setInterval: () => ({ unref() {} }), clearInterval: () => {},
  });
  for (let index = 0; index < 100_000; index += 1) reporter.observe(notification(index % 2 === 0 ? 'tool_call_started' : 'api_retry'));
  reporter.observe(notification('prompt_completed'));
  await Promise.resolve();
  const callsWhileBlocked = calls.length; const linesWhileBlocked = lines.length;
  releaseFirst(); await reporter.flush();
  assert.equal(callsWhileBlocked, 1);
  assert.ok(calls.length <= 1 + progressModule.MAX_PROGRESS_PENDING_EVENTS, calls.length);
  assert.ok(linesWhileBlocked <= 1 + progressModule.MAX_PROGRESS_PENDING_EVENTS, linesWhileBlocked);
  assert.equal(calls.at(-1).phase, 'finalizing');
  assert.equal(calls.at(-1).message, 'ZCode completed the delegated turn.');
  assert.equal(persisted.at(-1).phase, 'finalizing');
  assert.equal(lines.length, calls.length);
  assert.ok(lines.length <= 1 + progressModule.MAX_PROGRESS_PENDING_EVENTS, lines.length);
  assert.equal(lines.at(-1), '[zcode] ZCode completed the delegated turn.\n');
  reporter.close();
});

test('emits an unpersisted 20-second heartbeat and closes idempotently', async () => {
  const lines = [];
  const persisted = [];
  const cleared = [];
  let intervalCallback;
  let intervalMs;
  let unrefCount = 0;
  let currentTime = observedAt;
  const timer = { unref: () => { unrefCount += 1; } };
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a',
    write: (line) => lines.push(line),
    persist: async (event) => persisted.push(event),
    now: () => currentTime,
    setInterval: (callback, milliseconds) => { intervalCallback = callback; intervalMs = milliseconds; return timer; },
    clearInterval: (value) => cleared.push(value),
  });

  reporter.observe(notification('model_streaming'));
  await reporter.flush();
  currentTime = '2026-08-08T00:00:10.000Z';
  intervalCallback();
  assert.deepEqual(lines, ['[zcode] ZCode is generating a response.\n']);
  currentTime = '2026-08-08T00:00:42.000Z';
  intervalCallback();

  assert.equal(intervalMs, PROGRESS_HEARTBEAT_MS);
  assert.equal(unrefCount, 1);
  assert.deepEqual(lines, [
    '[zcode] ZCode is generating a response.\n',
    '[zcode] Still waiting for ZCode; last activity 42s ago.\n',
  ]);
  assert.deepEqual(persisted, [{ phase: 'running', message: 'ZCode is generating a response.', observedAt }]);

  reporter.close();
  reporter.close();
  assert.deepEqual(cleared, [timer]);
});

test('duplicate activity refreshes the heartbeat clock without repeating output or persistence', async () => {
  const lines = [];
  const persisted = [];
  let intervalCallback;
  let currentTime = observedAt;
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a',
    write: (line) => lines.push(line),
    persist: async (event) => persisted.push(event),
    now: () => currentTime,
    setInterval: (callback) => { intervalCallback = callback; return { unref() {} }; },
    clearInterval: () => {},
  });

  reporter.observe(notification('tool_call_progress'));
  currentTime = '2026-08-08T00:00:19.000Z';
  reporter.observe(notification('tool_call_progress'));
  currentTime = '2026-08-08T00:00:21.000Z';
  intervalCallback();
  await reporter.flush();

  assert.deepEqual(lines, ['[zcode] ZCode tool work is still running.\n']);
  assert.deepEqual(persisted, [{ phase: 'running', message: 'ZCode tool work is still running.', observedAt }]);
  reporter.close();
});

test('persistence failure disables preview while writer continues and flush stays observational', async () => {
  const firstError = new Error('first persistence failed');
  const attempts = []; const lines = [];
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a',
    write: (line) => lines.push(line),
    persist: async (event) => {
      attempts.push(event.message);
      if (attempts.length === 1) throw firstError;
    },
    now: () => observedAt,
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
  });

  try {
    reporter.observe(notification('tool_call_started'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    reporter.observe(notification('api_retry'));
    await reporter.flush();
    assert.deepEqual(attempts, ['ZCode started a tool call.']);
    assert.deepEqual(lines, ['[zcode] ZCode started a tool call.\n', '[zcode] ZCode progress preview was disabled.\n', '[zcode] ZCode is retrying the model request.\n']);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    reporter.close();
  }
});

test('writer failure permanently disables writer while persistence continues and flush resolves', async () => {
  const writerError = new Error('writer failed');
  const persisted = [];
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a',
    write: () => { throw writerError; },
    persist: async (event) => persisted.push(event),
    onDiagnostic: () => { throw new Error('diagnostic sink failed'); },
    now: () => observedAt,
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
  });
  try {
    assert.doesNotThrow(() => reporter.observe(notification('tool_call_started')));
    reporter.observe(notification('api_retry'));
    await reporter.flush();
    assert.deepEqual(persisted, [
      { phase: 'running', message: 'ZCode started a tool call.', observedAt },
      { phase: 'waiting', message: 'ZCode is retrying the model request.', observedAt },
      { phase: 'waiting', message: 'ZCode progress output was disabled.', observedAt },
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    reporter.close();
  }
});

test('render and diagnostic failures are swallowed without exposing their exceptions', async () => {
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a',
    describeNotification: async () => { throw new Error('raw secret render exception'); },
    onDiagnostic: () => { throw new Error('raw secret diagnostic exception'); },
    now: () => observedAt, setInterval: () => ({ unref() {} }), clearInterval: () => {},
  });
  reporter.observe({ method: 'v4/conversation/frame', raw: 'private frame' });
  await reporter.flush();
  reporter.close();
});

test('a conversation notification may asynchronously produce multiple bounded events', async () => {
  const lines = []; const persisted = [];
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a', write: (line) => lines.push(line), persist: async (event) => persisted.push(event),
    describeNotification: async () => [
      { phase: 'running', message: 'Reading: src/a.js.', observedAt },
      { phase: 'running', message: 'Read completed.', observedAt },
    ],
    now: () => observedAt, setInterval: () => ({ unref() {} }), clearInterval: () => {},
  });
  reporter.observe({ method: 'v4/conversation/frame' });
  await reporter.flush();
  assert.deepEqual(lines, ['[zcode] Reading: src/a.js.\n', '[zcode] Read completed.\n']);
  assert.deepEqual(persisted.map((event) => event.message), ['Reading: src/a.js.', 'Read completed.']);
  reporter.close();
});

test('bounds queued render work and flush cannot be held by a never-settling progress sink', async () => {
  let calls = 0; const diagnostics = []; let overflows = 0;
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a', describeNotification: async () => { calls += 1; return new Promise(() => {}); },
    onDescriptorOverflow: () => { overflows += 1; }, onDiagnostic: ({ kind }) => diagnostics.push(kind),
    now: () => observedAt, setInterval: () => ({ unref() {} }), clearInterval: () => {},
  });
  for (let index = 0; index < 1_000; index += 1) reporter.observe({ method: 'v4/conversation/frame', index });
  const started = Date.now(); await reporter.flush();
  assert.ok(Date.now() - started < 1_000); assert.equal(calls, 1); assert.equal(overflows, 1);
  assert.deepEqual(diagnostics, ['conversation-frame-overflow', 'progress-flush-timeout']);
  reporter.close();
});

test('reporter burst overflow pauses exact frames until a valid recovery baseline restores continuity', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'zcode-progress-reporter-')); const lines = []; const persisted = []; const diagnostics = [];
  const describer = await createConversationProgressDescriber(
    { sessionId: 'session-1', subscriptionId: 'sub-1', workspace },
    { pathTimeoutMs: 20, resolvePath: async () => new Promise(() => {}) },
  );
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-1', write: (line) => lines.push(line), persist: async (event) => persisted.push(event),
    describeNotification: describer.observe, onDescriptorOverflow: describer.markGap, onDiagnostic: ({ kind }) => diagnostics.push(kind),
    now: () => observedAt, setInterval: () => ({ unref() {} }), clearInterval: () => {},
  });
  for (let ordinal = 1; ordinal <= 7; ordinal += 1) reporter.observe(conversationFrame({ ordinal, deltas: [toolRow({ rowId: ordinal, toolName: 'Read', input: { file_path: `stalled-${ordinal}` } })] }));
  reporter.observe(conversationFrame({ ordinal: 8, deliveryKind: 'recovery', subscriptionId: 'foreign', deltas: [] }));
  reporter.observe(conversationFrame({ ordinal: 8, deltas: [toolRow({ rowId: 8, input: { command: 'STALE_ONLINE_SECRET' } })] }));
  reporter.observe(conversationFrame({ ordinal: 8, deliveryKind: 'recovery', deltas: [] }));
  reporter.observe(conversationFrame({ ordinal: 9, deltas: [toolRow({ rowId: 9, input: { command: 'echo recovered reporter' } })] }));
  await reporter.flush(); reporter.close();
  assert.deepEqual(diagnostics, ['conversation-frame-overflow']);
  assert.match(lines.join(''), /paused after an activity burst/); assert.match(lines.join(''), /Running command: echo recovered reporter\./);
  assert.doesNotMatch(`${lines.join('')} ${JSON.stringify(persisted)}`, /STALE_ONLINE_SECRET|stalled-/);
});

test('close fences a delayed semantic description after terminal state progress', async () => {
  const lines = []; let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a', write: (line) => lines.push(line), describeNotification: () => delayed,
    now: () => observedAt, setInterval: () => ({ unref() {} }), clearInterval: () => {},
  });
  reporter.observe({ method: 'v4/conversation/frame' });
  reporter.observe(notification('prompt_completed'));
  reporter.close(); release([{ phase: 'running', message: 'Reading: a.txt.', observedAt }]); await reporter.flush();
  assert.deepEqual(lines, ['[zcode] ZCode completed the delegated turn.\n']);
});

test('deferred reporter buffers only bounded normalized events and activates starting-first', async () => {
  const lines = []; const persisted = []; let intervalCalls = 0; let currentTime = observedAt;
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a', deferred: true,
    write: (line) => lines.push(line), persist: async (event) => persisted.push(event), now: () => currentTime,
    setInterval: () => { intervalCalls += 1; return { unref() {} }; }, clearInterval: () => {},
  });
  for (const reason of ['model_streaming', 'model_streaming', 'tool_call_started', 'api_retry', 'tool_call_result', 'prompt_completed']) {
    reporter.observe(notification(reason, { secret: `raw-${reason}` }));
  }
  assert.equal(intervalCalls, 0); assert.deepEqual(lines, []); assert.deepEqual(persisted, []);
  currentTime = '2026-08-08T00:00:10.000Z';
  reporter.activate(notification('prompt_started'));
  await reporter.flush();
  assert.equal(intervalCalls, 1);
  assert.deepEqual(lines, [
    '[zcode] ZCode started the delegated turn.\n',
    '[zcode] ZCode started a tool call.\n',
    '[zcode] ZCode is retrying the model request.\n',
    '[zcode] ZCode completed a tool call.\n',
    '[zcode] ZCode completed the delegated turn.\n',
  ]);
  assert.deepEqual(persisted.map(({ phase, message, observedAt: at }) => ({ phase, message, observedAt: at })), [
    { phase: 'starting', message: 'ZCode started the delegated turn.', observedAt: currentTime },
    { phase: 'running', message: 'ZCode started a tool call.', observedAt: currentTime },
    { phase: 'waiting', message: 'ZCode is retrying the model request.', observedAt: currentTime },
    { phase: 'running', message: 'ZCode completed a tool call.', observedAt: currentTime },
    { phase: 'finalizing', message: 'ZCode completed the delegated turn.', observedAt: currentTime },
  ]);
  assert.doesNotMatch(JSON.stringify(persisted), /raw-|secret/);
  reporter.close();
});

test('does not create a heartbeat interval without a writer', () => {
  let intervalCalls = 0;
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a',
    now: () => observedAt,
    setInterval: () => { intervalCalls += 1; return { unref() {} }; },
    clearInterval: () => {},
  });
  assert.equal(intervalCalls, 0);
  reporter.close();
});
