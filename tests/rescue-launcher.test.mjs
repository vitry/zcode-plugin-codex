import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { runRescueLauncher } from '../skills/rescue/launcher.mjs';

const launcher = fileURLToPath(new URL('../skills/rescue/launcher.mjs', import.meta.url));

test('Rescue launcher accepts only fixed protocol argv and dispatches them unchanged in-process', async () => {
  const allowed = [
    ['role-status', 'rescue'],
    ['prepare', 'rescue'],
    ['invoke-prepared', 'rescue'],
    ['invoke-status', 'rescue'],
    ['invoke-choice', 'rescue', 'resume'],
    ['invoke-choice', 'rescue', 'fresh'],
  ];
  for (const argv of allowed) {
    /** @type {string[][]} */
    const calls = [];
    await runRescueLauncher(argv, async (received) => { calls.push(received); });
    assert.deepEqual(calls, [argv]);
  }
  const source = await readFile(launcher, 'utf8');
  assert.match(source, /\.\.\/\.\.\/scripts\/zcode-companion\.mjs/);
  assert.doesNotMatch(source, /node:child_process|\bspawn\b|\bexec(?:File)?\b/);
});

test('Rescue launcher rejects setup, public commands, extras, and user text before dispatch', async () => {
  for (const argv of [
    [], ['setup'], ['rescue', 'task'], ['status'], ['invoke-prepared', 'rescue', 'user text'],
    ['invoke-choice', 'rescue'], ['invoke-choice', 'rescue', 'wait'], ['invoke-status', 'rescue', 'extra'],
    ['role-status\0rescue'],
  ]) {
    let called = false;
    await assert.rejects(runRescueLauncher(argv, async () => { called = true; }), { code: 'RESCUE_LAUNCHER_ARGUMENT_INVALID' });
    assert.equal(called, false);
  }
});

test('Rescue launcher CLI preserves companion stdout and validation exit semantics', async () => {
  const result = await runChild(['setup']);
  assert.equal(result.code, 2);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    error: {
      code: 'RESCUE_LAUNCHER_ARGUMENT_INVALID', category: 'validation',
      message: 'The Rescue launcher command is invalid.',
      remedy: 'Use only the fixed command documented by the active Rescue Skill.', details: {},
    },
  });
});

/** @param {string[]} argv */
function runChild(argv) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [launcher, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolvePromise({ code, stdout, stderr }));
  });
}
