import assert from 'node:assert/strict';
import test from 'node:test';

import { awaitCurrentTurnTerminal, classifyCurrentTurnSnapshot } from '../scripts/lib/turn-terminal.mjs';

const boundary = { beforeMessageIds: new Set(['historical-user', 'historical-assistant']), inputId: 'input-current', stateRevision: 7 };

function user(messageId = 'input-current', extra = {}) {
  return { info: { role: 'user', messageId, semantics: { origin: 'real_user', kind: 'user_prompt', uiVisibility: 'visible' }, ...extra }, parts: [{ type: 'text', text: 'prompt' }] };
}

function assistant(extra = {}, parentMessageId = 'input-current') {
  return { info: { role: 'assistant', messageId: 'assistant-current', parentMessageId, semantics: { origin: 'agent_runtime', kind: 'assistant_response', uiVisibility: 'visible' }, ...extra }, parts: [{ type: 'text', text: 'answer' }] };
}

/** @param {string} status @param {any[]} messages @param {number} revision @param {Record<string,any>} extraProjection */
function snapshot(status, messages = [], revision = 7, extraProjection = {}) {
  return { projection: { status, ...extraProjection, futureProjectionField: true }, runtime: { stateRevision: revision, futureRuntimeField: true }, messages, futureSnapshotField: true };
}

test('current-turn classifier keeps initial-invalid, empty idle, user-only, unfinished assistant, and active snapshots pending', () => {
  const cases = [
    undefined,
    {},
    snapshot('idle'),
    snapshot('idle', [user()]),
    snapshot('idle', [user(), assistant()]),
    snapshot('idle', [user(), assistant({ finish: '' })]),
    snapshot('idle', [assistant({ finish: 'stop', time: { completed: 3 } })]),
    snapshot('error', [], 7, { lastError: { message: 'unattributed error' } }),
    snapshot('running', [user(), assistant({ finish: 'stop', time: { completed: 3 } })]),
    snapshot('idle', [user(), assistant({ finish: 'stop', time: { completed: 3 } })], 6),
  ];
  for (const candidate of cases) assert.deepEqual(classifyCurrentTurnSnapshot(candidate, boundary), { kind: 'pending' });
});

test('current-turn classifier succeeds only for a completed visible linked assistant on a non-active projection', () => {
  for (const completion of [{ time: { completed: 3 } }, { finish: 'stop' }]) {
    const candidate = snapshot('idle', [user(), assistant(completion)]);
    assert.deepEqual(classifyCurrentTurnSnapshot(candidate, boundary), { kind: 'succeeded' });
  }
});

test('current-turn classifier recognizes explicit current-boundary failure and interruption', () => {
  assert.deepEqual(classifyCurrentTurnSnapshot(snapshot('error', [user()], 8, { lastError: { message: 'provider failed' } }), boundary), { kind: 'failed' });
  assert.deepEqual(classifyCurrentTurnSnapshot(snapshot('idle', [user(), assistant({ finish: 'cancelled', time: { completed: 3 } })]), boundary), { kind: 'interrupted' });
  assert.deepEqual(classifyCurrentTurnSnapshot(snapshot('idle', [user(), assistant({ error: { message: 'tool failed' }, time: { completed: 3 } })]), boundary), { kind: 'failed' });
});

test('current-turn classifier rejects hidden, unrelated, and historical assistant evidence', () => {
  const historical = assistant({ messageId: 'historical-assistant', finish: 'stop' }, 'historical-user');
  const unrelated = assistant({ messageId: 'assistant-other', finish: 'stop' }, 'input-other');
  const hidden = assistant({ finish: 'stop', semantics: { origin: 'agent_runtime', kind: 'assistant_response', uiVisibility: 'hidden' } });
  for (const messages of [[historical], [user(), unrelated], [user(), hidden]]) {
    assert.deepEqual(classifyCurrentTurnSnapshot(snapshot('idle', messages), boundary), { kind: 'pending' });
  }
});

test('current-turn classifier uses the sole new real-user root when ZCode remaps the accepted input id', () => {
  const messages = [user('persisted-input'), assistant({ finish: 'stop' }, 'persisted-input')];
  assert.deepEqual(classifyCurrentTurnSnapshot(snapshot('completed', messages), boundary), { kind: 'succeeded' });
  assert.deepEqual(classifyCurrentTurnSnapshot(snapshot('completed', [user('one'), user('two'), ...messages.slice(1)]), boundary), { kind: 'pending' });
});

test('coordinator preserves an authoritative interrupted or failed lifecycle after a coherent read', async () => {
  for (const kind of ['interrupted', 'failed']) {
    const coherent = snapshot('idle', [user(), assistant({ finish: 'stop', time: { completed: 3 } })]);
    const result = await awaitCurrentTurnTerminal({
      legacyWake: new Promise(() => {}),
      conversationObserver: { waitForTurnTerminal: async () => ({ kind, turnId: `turn-${kind}` }) },
      readSnapshot: async () => coherent,
      turnBoundary: boundary,
      reconcileIntervalMs: 0,
    });
    assert.deepEqual(result, { kind, snapshot: coherent });
  }
});

test('authoritative failed and interrupted lifecycles retain their exact kind across conflicting snapshots', async () => {
  const conflicts = [
    ['failed', snapshot('idle', [user(), assistant({ finish: 'cancelled', time: { completed: 3 } })])],
    ['interrupted', snapshot('error', [user()], 8, { lastError: { message: 'snapshot error' } })],
  ];
  for (const [kind, coherent] of conflicts) {
    const result = await awaitCurrentTurnTerminal({
      legacyWake: new Promise(() => {}),
      conversationObserver: { waitForTurnTerminal: async () => ({ kind, turnId: `turn-${kind}` }) },
      readSnapshot: async () => coherent,
      turnBoundary: boundary,
      reconcileIntervalMs: 0,
    });
    assert.equal(result.kind, kind);
  }
});
