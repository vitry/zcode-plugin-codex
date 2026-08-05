import assert from 'node:assert/strict';
import test from 'node:test';

import { decidePermission, extractFinalResult } from '../scripts/lib/review.mjs';

const options = [
  { optionId: 'allow', kind: 'allow', name: 'Allow', response: { decision: 'allow' } },
  { optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny' } },
];

/** @param {string} riskLevel @param {string} [toolName] */
function request(riskLevel, toolName = 'write') {
  return { requestId: 'r', sessionId: 's', toolCallId: 't', toolName, reason: 'test', riskLevel, input: { secret: 'never' }, options };
}

test('reviews deny mutations and all medium/high/critical/unknown requests', () => {
  assert.deepEqual(decidePermission(request('low', 'read'), { permissionMode: 'bypassPermissions' }, 'review'), { decision: 'allow' });
  for (const risk of ['low', 'medium', 'high', 'critical', 'future-risk']) {
    assert.deepEqual(decidePermission(request(risk, 'write'), { permissionMode: 'bypassPermissions' }, 'adversarial-review'), { decision: 'deny' });
  }
});

test('rescue allows low/medium, gates high/critical on exact bypass mode, and denies unknown', () => {
  for (const risk of ['low', 'medium']) assert.deepEqual(decidePermission(request(risk), { permissionMode: 'workspace-write' }, 'rescue'), { decision: 'allow' });
  for (const risk of ['high', 'critical']) {
    assert.deepEqual(decidePermission(request(risk), { permissionMode: 'bypassPermissions' }, 'rescue'), { decision: 'allow' });
    assert.deepEqual(decidePermission(request(risk), { permissionMode: 'workspace-write' }, 'rescue'), { decision: 'deny' });
  }
  assert.deepEqual(decidePermission(request('novel'), { permissionMode: 'bypassPermissions' }, 'rescue'), { decision: 'deny' });
});

test('permission decisions choose only a response actually offered by ZCode', () => {
  const denyOnly = { ...request('low'), options: [options[1]] };
  assert.deepEqual(decidePermission(denyOnly, { permissionMode: 'workspace-write' }, 'rescue'), { decision: 'deny' });
  assert.throws(() => decidePermission({ ...request('low'), options: [] }, { permissionMode: 'workspace-write' }, 'rescue'), { code: 'PERMISSION_DENY_UNAVAILABLE' });
  assert.throws(() => decidePermission({ ...request('low'), options: [{ response: { decision: 'mystery' } }] }, { permissionMode: 'workspace-write' }, 'rescue'), { code: 'PERMISSION_DENY_UNAVAILABLE' });
});

/** @param {any[]} parts @param {unknown} [structured] @param {unknown} [semantics] @param {string} [messageId] @param {string} [parentMessageId] */
function assistant(parts, structured, semantics, messageId = 'assistant-current', parentMessageId = 'input-current') {
  return { info: { role: 'assistant', messageId, parentMessageId, ...(structured === undefined ? {} : { structured }), ...(semantics === undefined ? {} : { semantics }) }, parts };
}

test('review result prefers valid structured findings anchored by visible final text', () => {
  const structured = { findings: [{ severity: 'high', file: 'src/a.js', line: 7, evidence: 'boom', fix: 'repair' }] };
  const snapshot = { messages: [assistant([
    { type: 'reasoning', text: 'secret chain' },
    { type: 'text', text: 'ignored', ignored: true },
    { type: 'text', text: '{"findings":[]}' },
  ], structured)] };
  assert.equal(extractFinalResult(snapshot, 'review'), `${JSON.stringify(structured, null, 2)}\n`);
});

test('review falls back to schema-valid visible JSON text and line is optional', () => {
  const value = { findings: [{ severity: 'low', file: 'a.js', evidence: 'e', fix: 'f' }] };
  assert.equal(extractFinalResult({ messages: [assistant([{ type: 'text', text: JSON.stringify(value) }])] }, 'adversarial-review'), `${JSON.stringify(value, null, 2)}\n`);
});

test('reasoning-only, hidden and invalid structured results fail closed', () => {
  assert.throws(() => extractFinalResult({ messages: [assistant([{ type: 'reasoning', text: 'done' }])] }, 'rescue'), { code: 'ZCODE_RESULT_MISSING' });
  assert.throws(() => extractFinalResult({ messages: [assistant([{ type: 'text', text: 'done' }], undefined, { uiVisibility: 'hidden' })] }, 'rescue'), { code: 'ZCODE_RESULT_MISSING' });
  assert.throws(() => extractFinalResult({ messages: [assistant([{ type: 'text', text: '{"findings":[]}' }], { findings: [{ severity: 'bogus' }] })] }, 'review'), { code: 'REVIEW_RESULT_INVALID' });
});

test('current-turn result never falls back to a visible historical assistant message', () => {
  const snapshot = { messages: [assistant([{ type: 'text', text: 'historical' }], undefined, undefined, 'assistant-old'), assistant([{ type: 'text', text: 'hidden current' }], undefined, { uiVisibility: 'hidden' }, 'assistant-new')] };
  assert.throws(() => extractFinalResult(snapshot, 'rescue', { beforeMessageIds: new Set(['assistant-old']), inputId: 'input-current' }), { code: 'ZCODE_RESULT_MISSING' });
});

test('current-turn result rejects an empty new assistant instead of using historical text', () => {
  const snapshot = { messages: [assistant([{ type: 'text', text: 'historical' }], undefined, undefined, 'assistant-old'), assistant([{ type: 'text', text: '' }], undefined, undefined, 'assistant-new')] };
  assert.throws(() => extractFinalResult(snapshot, 'rescue', { beforeMessageIds: new Set(['assistant-old']), inputId: 'input-current' }), { code: 'ZCODE_RESULT_MISSING' });
});

test('current-turn result accepts a newly added visible structured assistant message', () => {
  const structured = { findings: [] }; const snapshot = { messages: [assistant([{ type: 'text', text: 'historical' }], undefined, undefined, 'assistant-old'), assistant([{ type: 'text', text: '{}'}], structured, undefined, 'assistant-new')] };
  assert.equal(extractFinalResult(snapshot, 'review', { beforeMessageIds: new Set(['assistant-old']), inputId: 'input-current' }), `${JSON.stringify(structured, null, 2)}\n`);
});

test('current-turn result prefers assistant messages linked to the send input over unrelated new messages', () => {
  const snapshot = { messages: [assistant([{ type: 'text', text: 'current' }], undefined, undefined, 'assistant-current', 'input-current'), assistant([{ type: 'text', text: 'unrelated' }], undefined, undefined, 'assistant-other', 'input-other')] };
  assert.equal(extractFinalResult(snapshot, 'rescue', { beforeMessageIds: new Set(), inputId: 'input-current' }), 'current');
});

test('current-turn result rejects unrelated new assistants when input linkage is available', () => {
  const snapshot = { messages: [assistant([{ type: 'text', text: 'unrelated' }], undefined, undefined, 'assistant-other', 'input-other')] };
  assert.throws(() => extractFinalResult(snapshot, 'rescue', { beforeMessageIds: new Set(), inputId: 'input-current' }), { code: 'ZCODE_RESULT_MISSING' });
});

test('rescue returns only nonignored visible text and never reasoning', () => {
  const snapshot = { messages: [assistant([{ type: 'reasoning', text: 'private' }, { type: 'text', text: 'old', ignored: true }, { type: 'text', text: 'final' }])] };
  assert.equal(extractFinalResult(snapshot, 'rescue'), 'final');
});
