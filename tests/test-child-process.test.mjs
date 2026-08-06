// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';

import { runChild } from './helpers/run-child.mjs';

test('bounded integration child runner terminates and reaps a hung child', async () => {
  const started = Date.now(); let pid;
  await assert.rejects(runChild(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { timeoutMs: 50, graceMs: 50 }), (error) => {
    pid = error.pid; return error.code === 'TEST_CHILD_TIMEOUT';
  });
  assert.ok(Date.now() - started < 3_000);
  assert.ok(pid);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});
