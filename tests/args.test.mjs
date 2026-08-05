import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs, resolveModel } from '../scripts/lib/args.mjs';
import { PluginError } from '../scripts/lib/errors.mjs';

/** @param {string[]} argv @param {string} [code] */
function rejects(argv, code = 'ARGUMENT_INVALID') {
  assert.throws(() => parseArgs(argv), (error) => error instanceof PluginError && error.code === code);
}

test('review and adversarial-review parse their exact public contracts', () => {
  assert.deepEqual(parseArgs(['review', '--wait', '--base', 'main', '--scope', 'branch', '--caller-context', 'ctx']), {
    command: 'review', options: { execution: 'wait', base: 'main', scope: 'branch', callerContext: 'ctx' }, positionals: [],
  });
  assert.deepEqual(parseArgs(['adversarial-review', '--background', 'focus', 'on', 'auth', '--caller-context', 'ctx']), {
    command: 'adversarial-review', options: { execution: 'background', scope: 'auto', callerContext: 'ctx' }, positionals: ['focus', 'on', 'auth'],
  });
});

test('rescue defaults to foreground and enforces task, mode, model and effort contracts', () => {
  assert.deepEqual(parseArgs(['rescue', '--fresh', '--model', 'openai/gpt-5', '--effort', 'xhigh', '--caller-context', 'ctx', 'repair', 'tests']), {
    command: 'rescue', options: { execution: 'foreground', resume: 'fresh', model: 'openai/gpt-5', effort: 'xhigh', callerContext: 'ctx' }, positionals: ['repair', 'tests'],
  });
  rejects(['rescue', '--caller-context', 'ctx']);
  rejects(['rescue', '--wait', '--background', '--caller-context', 'ctx', 'task']);
  rejects(['rescue', '--resume', '--fresh', '--caller-context', 'ctx', 'task']);
  rejects(['rescue', '--effort', 'ultra', '--caller-context', 'ctx', 'task']);
  rejects(['rescue', '--model', 'spark', '--caller-context', 'ctx', 'task'], 'MODEL_SPARK_FORBIDDEN');
  assert.equal(parseArgs(['rescue', '--effort', 'HIGH', '--caller-context', '-opaque', 'task']).options.effort, 'high');
});

test('status timeout and ownership selection flags fail closed', () => {
  assert.deepEqual(parseArgs(['status', 'a'.repeat(64), '--wait', '--caller-context', 'ctx']), {
    command: 'status', options: { wait: true, timeoutMs: 240000, all: false, callerContext: 'ctx' }, positionals: ['a'.repeat(64)],
  });
  rejects(['status', '--wait', '--caller-context', 'ctx']);
  rejects(['status', '--timeout-ms', '10', '--caller-context', 'ctx']);
  rejects(['status', 'a'.repeat(64), '--all', '--caller-context', 'ctx']);
  rejects(['status', 'a'.repeat(64), '--wait', '--timeout-ms', '-1', '--caller-context', 'ctx']);
  rejects(['status', 'a'.repeat(64), '--wait', '--timeout-ms', '9007199254740992', '--caller-context', 'ctx']);
});

test('result/cancel and private entry point have narrow identities', () => {
  assert.equal(parseArgs(['result', '--caller-context', 'ctx']).command, 'result');
  assert.deepEqual(parseArgs(['run-reserved-job', 'a'.repeat(64), '--execution-capability', 'cap']), {
    command: 'run-reserved-job', options: { executionCapability: 'cap' }, positionals: ['a'.repeat(64)],
  });
  rejects(['run-reserved-job', 'a'.repeat(64), '--execution-capability', 'cap', '--caller-context', 'ctx']);
});

test('unknown commands, flags, duplicate scalars and removed surfaces are rejected', () => {
  for (const argv of [
    ['spark'], ['transfer'], ['setup'], ['review', '--force'], ['review', '--prompt-file', 'x'],
    ['review', '--write'], ['review', '--wat'], ['review', '--base', 'a', '--base', 'b'],
  ]) rejects(argv);
});

test('model resolution uses provider/model, configured aliases, or exact catalog models', () => {
  assert.deepEqual(resolveModel('p/m', {}, []), { providerId: 'p', modelId: 'm' });
  assert.deepEqual(resolveModel('p/family/model', {}, []), { providerId: 'p', modelId: 'family/model' });
  assert.deepEqual(resolveModel('fast', { fast: { providerId: 'p', modelId: 'm', variant: 'v' } }, []), { providerId: 'p', modelId: 'm', variant: 'v' });
  assert.deepEqual(resolveModel('model', {}, [{ ref: { providerId: 'p', modelId: 'model' } }]), { providerId: 'p', modelId: 'model' });
  assert.throws(() => resolveModel('bad', { bad: { providerId: 'p', modelId: 'm', extra: true } }, []), { code: 'MODEL_NOT_FOUND' });
  assert.throws(() => resolveModel('missing', {}, []), { code: 'MODEL_NOT_FOUND' });
  assert.throws(() => resolveModel('spark', {}, []), { code: 'MODEL_SPARK_FORBIDDEN' });
});
