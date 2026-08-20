import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRecordedInvocation } from '../scripts/lib/invocation.mjs';

const JOB_ID = 'a'.repeat(64);

test('embedded result marker in prose does not consume prose as arguments', () => {
  assert.deepEqual(parseRecordedInvocation('result', '通过 $zcode:result 可以查到结果吗'), {
    argv: ['result'],
    explicit: true,
  });
});

test('embedded result marker extracts only an immediately following exact job ID', () => {
  assert.deepEqual(parseRecordedInvocation('result', `please use $zcode:result ${JOB_ID} when ready`), {
    argv: ['result', JOB_ID],
    explicit: true,
  });
});

test('embedded cancel marker accepts an exact ID and otherwise ignores prose', () => {
  assert.deepEqual(parseRecordedInvocation('cancel', 'can $zcode:cancel stop the job'), {
    argv: ['cancel'],
    explicit: true,
  });
  assert.deepEqual(parseRecordedInvocation('cancel', `please $zcode:cancel ${JOB_ID} now`), {
    argv: ['cancel', JOB_ID],
    explicit: true,
  });
});

test('command-form result invocation retains strict tokenization', () => {
  assert.deepEqual(parseRecordedInvocation('result', '$zcode:result not-an-id'), {
    argv: ['result', 'not-an-id'],
    explicit: true,
  });
  assert.deepEqual(parseRecordedInvocation('result', `  $zcode:result ${JOB_ID}  `), {
    argv: ['result', JOB_ID],
    explicit: true,
  });
});

test('status invocation retains its current option grammar', () => {
  assert.deepEqual(parseRecordedInvocation('status', `$zcode:status ${JOB_ID} --wait --timeout-ms 1000`), {
    argv: ['status', JOB_ID, '--wait', '--timeout-ms', '1000'],
    explicit: true,
  });
});

test('ambiguous embedded result syntax remains strict for downstream validation', () => {
  assert.deepEqual(parseRecordedInvocation('result', 'please $zcode:result --wait for it'), {
    argv: ['result', '--wait', 'for', 'it'],
    explicit: true,
  });
  assert.deepEqual(parseRecordedInvocation('result', `please $zcode:result $zcode:cancel ${JOB_ID}`), {
    argv: ['result', '$zcode:cancel', JOB_ID],
    explicit: true,
  });
});

test('embedded result marker rejects ID-looking tokens that are not exact lowercase digests', () => {
  for (const token of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
    assert.deepEqual(parseRecordedInvocation('result', `please $zcode:result ${token} afterward`), {
      argv: ['result'],
      explicit: true,
    });
  }
});
