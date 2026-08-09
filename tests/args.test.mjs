import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs, resolveModel } from '../scripts/lib/args.mjs';
import { PluginError } from '../scripts/lib/errors.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';
import { readWorkspaceModelConfig, writeWorkspaceModelConfig } from '../scripts/lib/workspace-config.mjs';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('role-status accepts only the constant Rescue readiness query', () => {
  assert.deepEqual(parseArgs(['role-status', 'rescue']), {
    command: 'role-status', options: {}, positionals: ['rescue'],
  });
  for (const argv of [['role-status'], ['role-status', 'review'], ['role-status', 'rescue', 'extra'], ['role-status', '--json', 'rescue']]) rejects(argv);
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

test('transfer accepts only one bounded explicit source', () => {
  assert.deepEqual(parseArgs(['transfer']), { command: 'transfer', options: {}, positionals: [] });
  assert.deepEqual(parseArgs(['transfer', '--source', 'thread-1']), { command: 'transfer', options: { source: 'thread-1' }, positionals: [] });
  for (const argv of [['transfer', '--source'], ['transfer', '--source', 'a', '--source', 'b'], ['transfer', '--unknown'], ['transfer', 'extra'], ['transfer', '--source', 'x'.repeat(513)]]) rejects(argv);
});

test('unknown commands, flags, duplicate scalars and removed surfaces are rejected', () => {
  for (const argv of [
    ['spark'], ['review', '--force'], ['review', '--prompt-file', 'x'],
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

test('workspace model configuration is exact, bounded, private, and canonical-workspace scoped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zcode-model-config-')); const dataRoot = join(root, 'data'); const first = join(root, 'first'); const second = join(root, 'second'); await mkdir(first); await mkdir(second);
  const configured = { version: 1, defaultModel: 'fast', models: { fast: { providerId: 'p', modelId: 'm', variant: 'v' } } };
  await writeWorkspaceModelConfig({ dataRoot, workspace: first, config: configured });
  assert.deepEqual(await readWorkspaceModelConfig({ dataRoot, workspace: first }), configured);
  assert.deepEqual(await readWorkspaceModelConfig({ dataRoot, workspace: second }), { version: 1, models: {} });
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace: first });
  const configDirectory = await stat(join(storage.directory, 'config')); const modelFile = await stat(join(storage.directory, 'config', 'models.json'));
  if (process.platform === 'win32') { assert.equal(configDirectory.isDirectory(), true); assert.equal(modelFile.isFile(), true); }
  else { assert.equal(configDirectory.mode & 0o777, 0o700); assert.equal(modelFile.mode & 0o777, 0o600); }
  for (const config of [
    { ...configured, extra: true },
    { ...configured, version: 2 },
    { ...configured, defaultModel: 'x'.repeat(513) },
    { version: 1, models: { ['__proto__']: { providerId: 'p', modelId: 'm' } } },
    { version: 1, models: { bad: { providerId: 'p', modelId: 'm', extra: true } } },
    { version: 1, models: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`alias-${index}`, { providerId: 'p', modelId: 'm' }])) },
  ]) await assert.rejects(writeWorkspaceModelConfig({ dataRoot, workspace: first, config }), { code: 'WORKSPACE_MODEL_CONFIG_INVALID' });
  await writeFile(join(storage.directory, 'config', 'models.json'), `{"version":1,"models":{},"padding":"${'x'.repeat(1024 * 1024)}"}`);
  await assert.rejects(readWorkspaceModelConfig({ dataRoot, workspace: first }), { code: 'WORKSPACE_MODEL_CONFIG_INVALID' });
});
