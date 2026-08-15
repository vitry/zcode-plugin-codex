// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

test('tracks bounded structural compatibility and activates fallback only at an explicit boundary', async () => {
  const probes = []; const diagnostics = []; const lines = []; let heartbeat;
  const results = [
    { disposition: 'accepted', phase: 'initial', events: [] },
    { disposition: 'rejected', reason: 'row-shape', events: [] },
    { disposition: 'accepted', phase: 'online', events: [] },
  ];
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a', write: (line) => lines.push(line),
    describeNotification: async () => results.shift(),
    persistProbe: async (probe) => probes.push(probe),
    activateSnapshotFallback: () => true,
    onDiagnostic: ({ kind }) => diagnostics.push(kind),
    now: () => observedAt,
    setInterval: (callback) => { heartbeat = callback; return { unref() {} }; }, clearInterval: () => {},
  });
  reporter.markConversationSubscribed();
  reporter.observe(conversationFrame({ deliveryKind: 'initial', deltas: [] }));
  await reporter.flush();
  assert.equal(probes.at(-1).state, 'probing');
  assert.equal(probes.at(-1).acceptedInitial, 1);
  assert.equal(probes.at(-1).subscriptionAcknowledged, true);
  heartbeat(); await reporter.flush();
  assert.equal(probes.at(-1).state, 'snapshot-fallback');
  assert.equal(probes.at(-1).snapshotFallbackActive, true);
  assert.deepEqual(diagnostics, ['conversation-snapshot-fallback']);
  assert.deepEqual(lines, ['[zcode] ZCode conversation frames were unavailable; using bounded session progress.\n']);
  reporter.observe(conversationFrame({ deltas: [toolRow()] }));
  reporter.observe(conversationFrame({ ordinal: 2, deltas: [] }));
  await reporter.flush();
  assert.equal(probes.at(-1).rejected['row-shape'], 1);
  assert.equal(probes.at(-1).acceptedOnline, 1);
  assert.equal(probes.at(-1).state, 'online');
  assert.equal(probes.at(-1).snapshotFallbackActive, false);
  assert.equal(reporter.activateCompatibilityBoundary(), false);
  assert.deepEqual(diagnostics, ['conversation-snapshot-fallback']);
  reporter.close();
});

test('an accepted zero-event online frame recovers lifecycle-only without reactivating fallback', async () => {
  const diagnostics = [];
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a', describeNotification: async () => ({ disposition: 'accepted', phase: 'online', events: [] }),
    onDiagnostic: ({ kind }) => diagnostics.push(kind), now: () => observedAt,
  });
  assert.equal(reporter.activateCompatibilityBoundary(), true);
  assert.equal(reporter.probeSnapshot().state, 'lifecycle-only');
  reporter.observe(conversationFrame({ deltas: [] })); await reporter.flush();
  assert.equal(reporter.probeSnapshot().state, 'online');
  assert.equal(reporter.probeSnapshot().snapshotFallbackUnavailable, false);
  assert.equal(reporter.activateCompatibilityBoundary(), false);
  assert.deepEqual(diagnostics, ['conversation-lifecycle-only']);
  reporter.close();
});

test('accepted online recovery invokes an activated snapshot fallback cleanup once', async () => {
  let cleanupCalls = 0;
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a',
    activateSnapshotFallback: () => () => { cleanupCalls += 1; },
    describeNotification: async () => ({ disposition: 'accepted', phase: 'online', events: [] }),
    now: () => observedAt,
  });
  assert.equal(reporter.activateCompatibilityBoundary(), true);
  assert.equal(reporter.probeSnapshot().state, 'snapshot-fallback');
  reporter.observe(conversationFrame({ deltas: [] })); await reporter.flush();
  assert.equal(reporter.probeSnapshot().state, 'online'); assert.equal(cleanupCalls, 1);
  reporter.close(); assert.equal(cleanupCalls, 1);
});

test('close invokes an activated snapshot fallback cleanup once', () => {
  let cleanupCalls = 0;
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a', activateSnapshotFallback: () => () => { cleanupCalls += 1; }, now: () => observedAt,
  });
  assert.equal(reporter.activateCompatibilityBoundary(), true);
  reporter.close(); reporter.close();
  assert.equal(cleanupCalls, 1);
});

test('throwing and non-settling fallback cleanup stay observational and bounded', async () => {
  let throwingCalls = 0;
  const throwing = progressModule.createProgressReporter({
    sessionId: 'session-a',
    activateSnapshotFallback: () => () => { throwingCalls += 1; throw new Error('private fallback cleanup failure'); },
    describeNotification: async () => ({ disposition: 'accepted', phase: 'online', events: [] }), now: () => observedAt,
  });
  throwing.activateCompatibilityBoundary(); throwing.observe(conversationFrame({ deltas: [] }));
  await throwing.flush();
  assert.equal(throwing.probeSnapshot().state, 'online'); assert.equal(throwingCalls, 1);
  throwing.close();

  let nonSettlingCalls = 0;
  const nonSettling = progressModule.createProgressReporter({
    sessionId: 'session-a',
    activateSnapshotFallback: () => () => { nonSettlingCalls += 1; return new Promise(() => {}); },
    now: () => observedAt,
  });
  nonSettling.activateCompatibilityBoundary();
  const started = Date.now(); nonSettling.close();
  assert.ok(Date.now() - started < 100); assert.equal(nonSettlingCalls, 1);
});

test('an accepted zero-event online frame marks the probe online and blocks fallback', async () => {
  const diagnostics = [];
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a', describeNotification: async () => ({ disposition: 'accepted', phase: 'online', events: [] }),
    onDiagnostic: ({ kind }) => diagnostics.push(kind), now: () => observedAt,
  });
  reporter.observe(conversationFrame({ deltas: [] })); await reporter.flush();
  assert.deepEqual(reporter.probeSnapshot(), {
    state: 'online', subscriptionAcknowledged: false, framesReceived: 1,
    acceptedInitial: 0, acceptedOnline: 1, acceptedRecovery: 0,
    rejected: { 'wire-version': 0, 'envelope-shape': 0, sequence: 0, topic: 0, 'row-kind': 0, 'row-shape': 0 },
    snapshotFallbackActive: false, snapshotFallbackUnavailable: false,
  });
  assert.equal(reporter.activateCompatibilityBoundary(), false);
  assert.deepEqual(diagnostics, []);
  reporter.close();
});

test('the fixed fourth structural rejection activates lifecycle-only exactly once', async () => {
  const diagnostics = [];
  const reasons = ['wire-version', 'envelope-shape', 'sequence', 'topic'];
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a', describeNotification: async () => ({ disposition: 'rejected', reason: reasons.shift(), events: [] }),
    onDiagnostic: ({ kind }) => diagnostics.push(kind), now: () => observedAt,
  });
  for (let index = 0; index < 4; index += 1) reporter.observe({ method: 'v4/conversation/frame', index });
  await reporter.flush();
  assert.equal(reporter.probeSnapshot().state, 'lifecycle-only');
  assert.deepEqual(diagnostics, ['conversation-lifecycle-only']);
  reporter.close();
});

test('falls back to lifecycle-only with one fixed diagnostic when no snapshot capability exists', async () => {
  const probes = []; const diagnostics = [];
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a', describeNotification: async () => ({ disposition: 'rejected', reason: 'topic', events: [] }),
    persistProbe: (probe) => probes.push(probe), onDiagnostic: ({ kind }) => diagnostics.push(kind), now: () => observedAt,
  });
  reporter.markConversationSubscribed();
  reporter.activateCompatibilityBoundary(); reporter.activateCompatibilityBoundary();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes.at(-1).state, 'lifecycle-only');
  assert.equal(probes.at(-1).snapshotFallbackUnavailable, true);
  assert.deepEqual(diagnostics, ['conversation-lifecycle-only']);
  reporter.close();
});

test('coalesces probe persistence to one bounded pending snapshot under a frame flood', async () => {
  const probes = []; let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a', describeNotification: () => new Promise(() => {}),
    persistProbe: (probe) => { probes.push(probe); return probes.length === 1 ? first : undefined; },
    now: () => observedAt, setInterval: () => ({ unref() {} }), clearInterval: () => {},
  });
  reporter.markConversationSubscribed();
  for (let index = 0; index < 20; index += 1) reporter.observe({ method: 'v4/conversation/frame', index });
  assert.equal(probes.length, 1);
  releaseFirst(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes.length, 2);
  assert.equal(probes[1].framesReceived, 20);
  reporter.close();
});

test('reporter saturates received accepted and every structural rejection counter', async () => {
  let result = { disposition: 'accepted', phase: 'initial', events: [] };
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a', describeNotification: async () => result, now: () => observedAt,
  });
  const observeUntilSaturated = async (nextResult) => {
    result = nextResult;
    for (let index = 0; index <= progressModule.MAX_PROGRESS_PROBE_COUNT; index += 1) {
      reporter.observe({ method: 'v4/conversation/frame' });
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  for (const phase of ['initial', 'online', 'recovery']) {
    await observeUntilSaturated({ disposition: 'accepted', phase, events: [] });
  }
  for (const reason of ['wire-version', 'envelope-shape', 'sequence', 'topic', 'row-kind', 'row-shape']) {
    await observeUntilSaturated({ disposition: 'rejected', reason, events: [] });
  }
  await reporter.flush();
  assert.deepEqual(reporter.probeSnapshot(), {
    state: 'online', subscriptionAcknowledged: false, framesReceived: progressModule.MAX_PROGRESS_PROBE_COUNT,
    acceptedInitial: progressModule.MAX_PROGRESS_PROBE_COUNT,
    acceptedOnline: progressModule.MAX_PROGRESS_PROBE_COUNT,
    acceptedRecovery: progressModule.MAX_PROGRESS_PROBE_COUNT,
    rejected: Object.fromEntries(['wire-version', 'envelope-shape', 'sequence', 'topic', 'row-kind', 'row-shape'].map((reason) => [reason, progressModule.MAX_PROGRESS_PROBE_COUNT])),
    snapshotFallbackActive: false, snapshotFallbackUnavailable: false,
  });
  reporter.close();
});

test('flush boundedly drains the latest coalesced probe snapshot before cleanup', async () => {
  const probes = []; let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a', persistProbe: (probe) => { probes.push(probe); return probes.length === 1 ? first : undefined; },
    now: () => observedAt, setInterval: () => ({ unref() {} }), clearInterval: () => {},
  });
  reporter.markConversationSubscribed(); reporter.activateCompatibilityBoundary();
  let flushed = false; const flushing = reporter.flush().then(() => { flushed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(flushed, false);
  releaseFirst(); await flushing;
  assert.equal(probes.length, 2);
  assert.equal(probes[1].state, 'lifecycle-only');
  reporter.close();
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

  assert.deepEqual(lines, [
    '[zcode] ZCode tool work is still running.\n',
    '[zcode] ZCode semantic progress is unavailable; lifecycle updates will continue.\n',
  ]);
  assert.deepEqual(persisted, [
    { phase: 'running', message: 'ZCode tool work is still running.', observedAt },
    { phase: 'waiting', message: 'ZCode semantic progress is unavailable; lifecycle updates will continue.', observedAt: currentTime },
  ]);
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

test('deferred semantic work cannot dispatch timestamps behind activation or later activity', async () => {
  const persisted = []; const diagnostics = []; const descriptions = [];
  let currentTime = observedAt;
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a', deferred: true,
    persist: async (event) => {
      const previous = persisted.at(-1);
      if (previous && Date.parse(event.observedAt) < Date.parse(previous.observedAt)) throw new Error('state rejected a regressing observation');
      persisted.push(event);
    },
    describeNotification: (frame, frameObservedAt) => new Promise((resolve) => descriptions.push({ frame, frameObservedAt, resolve })),
    onDiagnostic: ({ kind }) => diagnostics.push(kind),
    now: () => currentTime, setInterval: () => ({ unref() {} }), clearInterval: () => {},
  });

  reporter.observe({ method: 'v4/conversation/frame', label: 'pre-activation-1' });
  currentTime = '2026-08-08T00:00:01.000Z';
  reporter.observe({ method: 'v4/conversation/frame', label: 'pre-activation-2' });
  currentTime = '2026-08-08T00:00:10.000Z';
  reporter.activate(notification('prompt_started'));
  currentTime = '2026-08-08T00:00:30.000Z';
  reporter.observe({ method: 'v4/conversation/frame', label: 'post-activation' });

  descriptions[0].resolve([
    { phase: 'running', message: 'First delayed event.', observedAt: descriptions[0].frameObservedAt },
    { phase: 'running', message: 'Same-frame delayed event.', observedAt: descriptions[0].frameObservedAt },
  ]);
  await waitUntil(() => descriptions.length === 2);
  descriptions[1].resolve([{ phase: 'waiting', message: 'Second delayed event.', observedAt: descriptions[1].frameObservedAt }]);
  await waitUntil(() => descriptions.length === 3);
  descriptions[2].resolve([{ phase: 'running', message: 'Late post-activation event.', observedAt: descriptions[2].frameObservedAt }]);
  await reporter.flush();
  currentTime = '2026-08-08T00:00:40.000Z';
  reporter.observe(notification('prompt_completed'));
  await reporter.flush();

  assert.deepEqual(diagnostics, []);
  assert.deepEqual(persisted.map(({ message, observedAt: at }) => [message, at]), [
    ['ZCode started the delegated turn.', '2026-08-08T00:00:10.000Z'],
    ['First delayed event.', '2026-08-08T00:00:10.000Z'],
    ['Same-frame delayed event.', '2026-08-08T00:00:10.000Z'],
    ['Second delayed event.', '2026-08-08T00:00:10.000Z'],
    ['Late post-activation event.', '2026-08-08T00:00:30.000Z'],
    ['ZCode completed the delegated turn.', '2026-08-08T00:00:40.000Z'],
  ]);
  reporter.close();
});

test('persistence normalizes timestamps only when receive-sequenced entries dequeue', async () => {
  const persisted = []; const lines = []; const diagnostics = []; const descriptions = [];
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  let lastPersistedAt = null; let currentTime = observedAt; let calls = 0;
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a', write: (line) => lines.push(line),
    persist: async (event) => {
      calls += 1; if (calls === 1) await firstBlocked;
      if (lastPersistedAt && Date.parse(event.observedAt) < Date.parse(lastPersistedAt)) throw new Error('state rejected regressing persistence');
      lastPersistedAt = event.observedAt; persisted.push(event);
    },
    describeNotification: (_frame, frameObservedAt) => new Promise((resolve) => descriptions.push({ frameObservedAt, resolve })),
    onDiagnostic: ({ kind }) => diagnostics.push(kind),
    now: () => currentTime, setInterval: () => ({ unref() {} }), clearInterval: () => {},
  });

  reporter.observe(notification('tool_call_started'));
  currentTime = '2026-08-08T00:00:01.000Z'; reporter.observe({ method: 'v4/conversation/frame' });
  currentTime = '2026-08-08T00:00:02.000Z'; reporter.observe(notification('api_retry'));
  currentTime = '2026-08-08T00:00:03.000Z'; reporter.observe(notification('tool_call_result'));
  descriptions[0].resolve([{ phase: 'running', message: 'Sequence one semantic event.', observedAt: descriptions[0].frameObservedAt }]);
  releaseFirst(); await reporter.flush();

  assert.deepEqual(diagnostics, []);
  assert.deepEqual(persisted.map(({ message, observedAt: at }) => [message, at]), [
    ['ZCode started a tool call.', observedAt],
    ['Sequence one semantic event.', '2026-08-08T00:00:01.000Z'],
    ['ZCode is retrying the model request.', '2026-08-08T00:00:02.000Z'],
    ['ZCode completed a tool call.', '2026-08-08T00:00:03.000Z'],
  ]);
  assert.deepEqual(lines, persisted.map((event) => `[zcode] ${event.message}\n`));
  reporter.close();
});

test('a received terminal survives a full persistence queue and delayed pre-terminal descriptions', async () => {
  const persisted = []; const descriptions = [];
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  let currentTime = observedAt;
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a',
    persist: async (event) => { if (persisted.length === 0) await firstBlocked; persisted.push(event); },
    describeNotification: (_frame, frameObservedAt) => new Promise((resolve) => descriptions.push({ frameObservedAt, resolve })),
    now: () => currentTime, setInterval: () => ({ unref() {} }), clearInterval: () => {},
  });

  reporter.observe(notification('tool_call_started'));
  currentTime = '2026-08-08T00:00:01.000Z';
  reporter.observe({ method: 'v4/conversation/frame', label: 'older-frame' });
  for (const [seconds, reason] of [[2, 'api_retry'], [3, 'tool_call_result'], [4, 'model_streaming']]) {
    currentTime = `2026-08-08T00:00:0${seconds}.000Z`; reporter.observe(notification(reason));
  }
  currentTime = '2026-08-08T00:00:05.000Z';
  reporter.observe(notification('prompt_completed'));
  descriptions[0].resolve([
    { phase: 'running', message: 'Delayed one.', observedAt: descriptions[0].frameObservedAt },
    { phase: 'running', message: 'Delayed two.', observedAt: descriptions[0].frameObservedAt },
  ]);
  releaseFirst(); await reporter.flush();

  assert.ok(persisted.length <= 1 + progressModule.MAX_PROGRESS_PENDING_EVENTS);
  assert.equal(persisted.at(-1).message, 'ZCode completed the delegated turn.');
  assert.equal(persisted.at(-1).observedAt, '2026-08-08T00:00:05.000Z');
  assert.equal(persisted.filter((event) => event.phase === 'finalizing').length, 1);
  reporter.close();
});

test('descriptor overflow cannot dispatch late frames after a received terminal', async () => {
  const persisted = []; const descriptions = []; const diagnostics = [];
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  let currentTime = observedAt;
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a',
    persist: async (event) => { if (persisted.length === 0) await firstBlocked; persisted.push(event); },
    describeNotification: (frame, frameObservedAt) => new Promise((resolve) => descriptions.push({ frame, frameObservedAt, resolve })),
    onDiagnostic: ({ kind }) => diagnostics.push(kind),
    now: () => currentTime, setInterval: () => ({ unref() {} }), clearInterval: () => {},
  });

  reporter.observe(notification('tool_call_started'));
  for (let index = 1; index <= 7; index += 1) {
    currentTime = `2026-08-08T00:00:0${index}.000Z`;
    reporter.observe({ method: 'v4/conversation/frame', index });
  }
  currentTime = '2026-08-08T00:00:08.000Z'; reporter.observe(notification('prompt_completed'));
  descriptions[0].resolve([{ phase: 'running', message: 'Old retained frame.', observedAt: descriptions[0].frameObservedAt }]);
  await waitUntil(() => descriptions.length === 2);
  descriptions[1].resolve([{ phase: 'running', message: 'Overflow survivor frame.', observedAt: descriptions[1].frameObservedAt }]);
  await waitUntil(() => descriptions.length === 3);
  descriptions[2].resolve([{ phase: 'running', message: 'Newest overflow frame.', observedAt: descriptions[2].frameObservedAt }]);
  releaseFirst(); await reporter.flush();

  assert.deepEqual(diagnostics, ['conversation-frame-overflow']);
  const terminalIndex = persisted.findIndex((event) => event.phase === 'finalizing');
  assert.notEqual(terminalIndex, -1);
  assert.doesNotMatch(persisted.slice(terminalIndex + 1).map((event) => event.message).join(' '), /frame/i);
  assert.ok(persisted.length <= 1 + progressModule.MAX_PROGRESS_PENDING_EVENTS);
  reporter.close();
});

test('flush fences a never-settling descriptor but still delivers its held terminal and timeout diagnostic', async () => {
  const persisted = []; const lines = []; const diagnostics = []; let resolveLate;
  let currentTime = observedAt;
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a', write: (line) => lines.push(line), persist: async (event) => persisted.push(event),
    describeNotification: () => new Promise((resolve) => { resolveLate = resolve; }),
    onDiagnostic: ({ kind }) => diagnostics.push(kind),
    now: () => currentTime, setInterval: () => ({ unref() {} }), clearInterval: () => {},
  });
  reporter.observe({ method: 'v4/conversation/frame', label: 'never-settling' });
  currentTime = '2026-08-08T00:00:02.000Z'; reporter.observe(notification('prompt_completed'));

  const started = Date.now(); await reporter.flush(); const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_000, elapsed);
  assert.deepEqual(diagnostics, ['progress-flush-timeout']);
  assert.equal(persisted.filter((event) => event.phase === 'finalizing').length, 1);
  assert.match(lines.join(''), /ZCode completed the delegated turn\./);
  assert.match(lines.join(''), /progress cleanup reached its time limit\./);

  resolveLate([{ phase: 'running', message: 'MUST NOT CROSS FLUSH FENCE.', observedAt }]);
  await new Promise((resolve) => setImmediate(resolve)); await reporter.flush();
  assert.doesNotMatch(`${lines.join('')} ${JSON.stringify(persisted)}`, /MUST NOT CROSS/);
  assert.equal(persisted.filter((event) => event.phase === 'finalizing').length, 1);
  reporter.close();
});

test('flush drains a manually resolved descriptor within semantic grace', async () => {
  const persisted = []; const diagnostics = []; let resolveDescription;
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a', persist: async (event) => persisted.push(event),
    describeNotification: () => new Promise((resolve) => { resolveDescription = resolve; }),
    onDiagnostic: ({ kind }) => diagnostics.push(kind),
    now: () => observedAt, setInterval: () => ({ unref() {} }), clearInterval: () => {},
  });
  reporter.observe({ method: 'v4/conversation/frame' });
  globalThis.setTimeout(() => resolveDescription([{ phase: 'running', message: 'Resolved inside grace.', observedAt }]), 20);
  await reporter.flush();
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(persisted.map((event) => event.message), ['Resolved inside grace.']);
  reporter.close();
});

test('flush yields after its grace timer so ready I/O semantics are not fenced', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-progress-ready-io-'));
  const path = join(directory, 'semantic.txt'); await writeFile(path, 'ready semantic');
  const readyRead = readFile(path, 'utf8'); await readyRead;
  const lines = []; const diagnostics = []; let descriptorReadReady = false; let graceTimerRegistered = false; let releaseSemantic;
  const semanticGate = new Promise((resolve) => { releaseSemantic = resolve; });
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a', write: (line) => lines.push(line),
    describeNotification: async (_frame, frameObservedAt) => {
      const message = await readyRead; descriptorReadReady = true; await semanticGate;
      return [{ phase: 'running', message, observedAt: frameObservedAt }];
    },
    onDiagnostic: ({ kind }) => diagnostics.push(kind),
    now: () => observedAt, setInterval: () => ({ unref() {} }), clearInterval: () => {},
  });
  reporter.observe({ method: 'v4/conversation/frame' });
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, milliseconds, ...args) => {
    if (milliseconds !== 125) return originalSetTimeout(callback, milliseconds, ...args);
    graceTimerRegistered = true;
    return originalSetTimeout(() => {
      callback(...args);
      // Register first in check so waitWithin's post-timer recheck runs after
      // the already-ready descriptor is released. Without that yield it fences.
      setImmediate(releaseSemantic);
    }, milliseconds);
  };
  try {
    const flushing = reporter.flush();
    // flush() first yields one microtask, then synchronously registers its grace
    // timer inside waitWithin(). Resume before the event loop enters timers.
    await Promise.resolve();
    assert.equal(descriptorReadReady, true); assert.equal(graceTimerRegistered, true);
    const stalledAt = Date.now(); while (Date.now() - stalledAt < 150) { /* make the registered grace timer ready */ }
    await flushing;
  } finally { globalThis.setTimeout = originalSetTimeout; }
  assert.deepEqual(diagnostics, []);
  assert.match(lines.join(''), /ready semantic/);
  reporter.close();
});

test('slow persistence cannot withhold logical writer progress or its timeout diagnostic', async () => {
  const lines = []; const persisted = []; const diagnostics = []; let resolvePersist;
  const stalledPersist = new Promise((resolve) => { resolvePersist = resolve; });
  let currentTime = observedAt;
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a', write: (line) => lines.push(line),
    persist: async (event) => { persisted.push(event); await stalledPersist; },
    describeNotification: async (_frame, frameObservedAt) => [{ phase: 'running', message: 'Independent semantic.', observedAt: frameObservedAt }],
    onDiagnostic: ({ kind }) => diagnostics.push(kind),
    now: () => currentTime, setInterval: () => ({ unref() {} }), clearInterval: () => {},
  });
  reporter.observe(notification('prompt_started'));
  currentTime = '2026-08-08T00:00:01.000Z'; reporter.observe({ method: 'v4/conversation/frame' });
  currentTime = '2026-08-08T00:00:02.000Z'; reporter.observe(notification('prompt_completed'));
  const started = Date.now(); await reporter.flush();
  assert.ok(Date.now() - started < 1_000);
  assert.deepEqual(diagnostics, ['progress-flush-timeout']);
  assert.deepEqual(lines, [
    '[zcode] ZCode started the delegated turn.\n',
    '[zcode] Independent semantic.\n',
    '[zcode] ZCode completed the delegated turn.\n',
    '[zcode] ZCode progress cleanup reached its time limit.\n',
  ]);
  assert.equal(persisted.length, 1);
  resolvePersist(); await new Promise((resolve) => setImmediate(resolve)); await reporter.flush();
  assert.equal(persisted.length, 1); assert.equal(lines.filter((line) => /completed the delegated turn/.test(line)).length, 1);
  reporter.close();
});

test('stalled writer timeout disables only writer while persistence drains and receives the diagnostic', async () => {
  const lines = []; const persisted = []; const diagnostics = []; let resolveWriter;
  const stalledWriter = new Promise((resolve) => { resolveWriter = resolve; });
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a',
    write: (line) => { lines.push(line); return stalledWriter; },
    persist: async (event) => persisted.push(event),
    onDiagnostic: ({ kind }) => diagnostics.push(kind),
    now: () => observedAt, setInterval: () => ({ unref() {} }), clearInterval: () => {},
  });
  reporter.observe(notification('prompt_started')); reporter.observe(notification('prompt_completed'));
  await reporter.flush();
  assert.deepEqual(lines, ['[zcode] ZCode started the delegated turn.\n']);
  assert.deepEqual(diagnostics, ['progress-flush-timeout']);
  assert.deepEqual(persisted.map((event) => event.message), [
    'ZCode started the delegated turn.',
    'ZCode completed the delegated turn.',
    'ZCode progress cleanup reached its time limit.',
  ]);
  resolveWriter(); await new Promise((resolve) => setImmediate(resolve)); await reporter.flush();
  assert.equal(lines.length, 1); assert.equal(persisted.filter((event) => event.phase === 'finalizing').length, 1);
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

test('persistence-only probes reach the first-heartbeat compatibility boundary', async () => {
  const probes = []; const diagnostics = []; let heartbeat; let intervalCalls = 0;
  const reporter = progressModule.createProgressReporter({
    sessionId: 'session-a', persistProbe: (probe) => probes.push(probe),
    onDiagnostic: ({ kind }) => diagnostics.push(kind), now: () => observedAt,
    setInterval: (callback) => { intervalCalls += 1; heartbeat = callback; return { unref() {} }; },
    clearInterval: () => {},
  });
  assert.equal(intervalCalls, 1);
  heartbeat(); await Promise.resolve();
  assert.equal(probes.at(-1).state, 'lifecycle-only');
  assert.deepEqual(diagnostics, ['conversation-lifecycle-only']);
  reporter.close();
});

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition was not reached');
}
