import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs, resolveModel } from '../scripts/lib/args.mjs';
import { PluginError } from '../scripts/lib/errors.mjs';

/** @param {string[]} argv @param {string} [code] */
function rejects(argv, code = 'ARGUMENT_INVALID') {
  assert.throws(() => parseArgs(argv), (error) => error instanceof PluginError && error.code === code);
}

test('review and adversarial-review parse their exact public contracts', () => {
  assert.deepEqual(parseArgs(['review', '--wait', '--base', 'main', '--scope', 'branch']), {
    command: 'review', options: { execution: 'wait', base: 'main', scope: 'branch' }, positionals: [],
  });
  assert.deepEqual(parseArgs(['adversarial-review', '--background', 'focus', 'on', 'auth']), {
    command: 'adversarial-review', options: { execution: 'background', scope: 'auto' }, positionals: ['focus', 'on', 'auth'],
  });
});

test('rescue defaults to foreground and enforces task, mode, model and effort contracts', () => {
  assert.deepEqual(parseArgs(['rescue', '--fresh', '--model', 'openai/gpt-5', '--effort', 'xhigh', 'repair', 'tests']), {
    command: 'rescue', options: { execution: 'foreground', resume: 'fresh', model: 'openai/gpt-5', effort: 'xhigh' }, positionals: ['repair', 'tests'],
  });
  rejects(['rescue']);
  rejects(['rescue', '--wait', '--background', 'task']);
  rejects(['rescue', '--resume', '--fresh', 'task']);
  rejects(['rescue', '--effort', 'ultra', 'task']);
  rejects(['rescue', '--model', 'spark', 'task'], 'MODEL_SPARK_FORBIDDEN');
  assert.equal(parseArgs(['rescue', '--effort', 'HIGH', 'task']).options.effort, 'high');
});

test('status timeout and ownership selection flags fail closed', () => {
  assert.deepEqual(parseArgs(['status', 'a'.repeat(64), '--wait']), {
    command: 'status', options: { wait: true, timeoutMs: 240000, all: false }, positionals: ['a'.repeat(64)],
  });
  rejects(['status', '--wait']);
  rejects(['status', '--timeout-ms', '10']);
  rejects(['status', 'a'.repeat(64), '--all']);
  rejects(['status', 'a'.repeat(64), '--wait', '--timeout-ms', '-1']);
  rejects(['status', 'a'.repeat(64), '--wait', '--timeout-ms', '9007199254740992']);
});

test('result/cancel and private entry point have narrow identities', () => {
  assert.equal(parseArgs(['result']).command, 'result');
  assert.deepEqual(parseArgs(['run-reserved-job', 'a'.repeat(64)]), {
    command: 'run-reserved-job', options: {}, positionals: ['a'.repeat(64)],
  });
  rejects(['run-reserved-job', 'a'.repeat(64), '--execution-capability', 'cap']);
  rejects(['review', '--caller-context', 'ctx']);
});

test('unknown commands, flags, duplicate scalars and removed surfaces are rejected', () => {
  for (const argv of [
    ['spark'], ['transfer'], ['setup'], ['review', '--force'], ['review', '--prompt-file', 'x'],
    ['review', '--write'], ['review', '--wat'], ['review', '--base', 'a', '--base', 'b'],
    ['review', '--base', '--force'], ['rescue', '--model', '--write', 'task'],
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
