// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';

import * as progressModule from '../scripts/lib/progress.mjs';
import {
  MAX_PROGRESS_MESSAGE_BYTES,
  MAX_PROGRESS_PREVIEW_ENTRIES,
  PROGRESS_HEARTBEAT_MS,
  PROGRESS_PHASES,
  normalizeZCodeProgress,
} from '../scripts/lib/progress.mjs';

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
  assert.equal(MAX_PROGRESS_MESSAGE_BYTES, 256);
  assert.equal(PROGRESS_HEARTBEAT_MS, 20_000);
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

test('rejects invalid observation timestamps', () => {
  for (const timestamp of [undefined, null, '', 'not-a-date', 0, '2026-02-30T00:00:00.000Z']) {
    assert.equal(normalizeZCodeProgress(notification('tool_call_started'), 'session-a', timestamp), null);
  }
});

test('reports immediately, suppresses consecutive duplicates, and serializes persistence', async () => {
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

  assert.deepEqual(lines, [
    '[zcode] ZCode started a tool call.\n',
    '[zcode] ZCode is retrying the model request.\n',
  ]);
  await Promise.resolve();
  assert.deepEqual(persistenceStarted, ['ZCode started a tool call.']);
  releases.shift()();
  await secondStarted;
  assert.deepEqual(persistenceStarted, ['ZCode started a tool call.', 'ZCode is retrying the model request.']);
  releases.shift()();
  await reporter.flush();
  assert.deepEqual(persisted, [
    { phase: 'running', message: 'ZCode started a tool call.', observedAt },
    { phase: 'waiting', message: 'ZCode is retrying the model request.', observedAt: currentTime },
  ]);
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
