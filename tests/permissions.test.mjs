import assert from 'node:assert/strict';
import test from 'node:test';

import { decidePermission } from '../scripts/lib/review.mjs';

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
