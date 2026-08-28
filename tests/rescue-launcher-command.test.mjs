// @ts-nocheck
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  RESCUE_LAUNCHER_ERROR_CONTEXT,
  SESSION_START_ADDITIONAL_CONTEXT_LIMIT,
  USER_PROMPT_ADDITIONAL_CONTEXT_LIMIT,
  escapeRescueLauncherCommandForToml,
  renderRescueLauncherCommand,
  renderRescueUserPromptContext,
  renderRescueUserPromptContextWithinLimit,
} from '../scripts/lib/rescue-launcher-command.mjs';

function shell(command, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('machine-rendered launcher command preserves ordinary spaces through a real shell', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zcode launcher safe '));
  const directory = join(root, 'skills', 'rescue'); await mkdir(directory, { recursive: true });
  const launcher = join(directory, 'launcher.mjs');
  await writeFile(launcher, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n');
  const command = renderRescueLauncherCommand(launcher);
  assert.equal(command, `node "${launcher}"`);
  const result = await shell(`${command} role-status rescue`, root);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['role-status', 'rescue']);
});

test('machine-rendered launcher command preserves a POSIX apostrophe through a real shell', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode O'Connor launcher "));
  const directory = join(root, 'skills', 'rescue'); await mkdir(directory, { recursive: true });
  const launcher = join(directory, 'launcher.mjs');
  await writeFile(launcher, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n');
  const command = renderRescueLauncherCommand(launcher, { platform: 'linux' });
  const result = await shell(`${command} role-status rescue`, root);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['role-status', 'rescue']);
});

test('launcher renderer fails closed on shell expansion and quoting characters', () => {
  const root = '/tmp/zcode';
  for (const suffix of ['quote"', '$(touch PWNED)', '`touch PWNED`', 'slash\\']) {
    assert.throws(() => renderRescueLauncherCommand(`${root}/${suffix}/skills/rescue/launcher.mjs`), { code: 'RESCUE_LAUNCHER_PATH_UNSAFE' }, suffix);
  }
  for (const suffix of ['percent%TEMP%', 'bang!VAR!', 'caret^', 'trailing\\']) {
    assert.throws(() => renderRescueLauncherCommand(`C:\\zcode\\${suffix}\\skills\\rescue\\launcher.mjs`, { platform: 'win32' }), { code: 'RESCUE_LAUNCHER_PATH_UNSAFE' }, suffix);
  }
});

test('launcher descriptor and five maximum notices remain inside the hook context budget', () => {
  const command = renderRescueLauncherCommand(`/opt/${'x'.repeat(900)}/skills/rescue/launcher.mjs`, { platform: 'linux' });
  const jobs = Array.from({ length: 5 }, (_, index) => ({ id: `${index}`.repeat(64), status: 'cancelled' }));
  const context = renderRescueUserPromptContext(command, jobs);
  assert.ok(Buffer.byteLength(context) <= USER_PROMPT_ADDITIONAL_CONTEXT_LIMIT);
  assert.equal(context.match(/[0-4]{64}/gu)?.length, 5);
});

test('explicit lifecycle context budgets accept 1200 bytes and reject 1201 without changing UserPromptSubmit semantics', () => {
  assert.equal(SESSION_START_ADDITIONAL_CONTEXT_LIMIT, 1200);
  const contextAt = (bytes) => {
    for (let length = 1; length < 2_000; length += 1) {
      const command = renderRescueLauncherCommand(`/opt/${'x'.repeat(length)}/skills/rescue/launcher.mjs`, { platform: 'linux' });
      const context = renderRescueUserPromptContext(command, []);
      if (Buffer.byteLength(context) === bytes) return { command, context };
    }
    throw new Error(`could not render a ${bytes}-byte launcher fixture`);
  };
  const atLimit = contextAt(SESSION_START_ADDITIONAL_CONTEXT_LIMIT);
  const overLimit = contextAt(SESSION_START_ADDITIONAL_CONTEXT_LIMIT + 1);
  assert.equal(renderRescueUserPromptContextWithinLimit(atLimit.command, [], SESSION_START_ADDITIONAL_CONTEXT_LIMIT), atLimit.context);
  assert.throws(
    () => renderRescueUserPromptContextWithinLimit(overLimit.command, [], SESSION_START_ADDITIONAL_CONTEXT_LIMIT),
    { code: 'RESCUE_LAUNCHER_CONTEXT_INVALID' },
  );
  assert.equal(renderRescueUserPromptContext(overLimit.command, []), overLimit.context, 'the 1800-byte UserPromptSubmit renderer must remain unchanged');
  assert.ok(Buffer.byteLength(RESCUE_LAUNCHER_ERROR_CONTEXT) <= SESSION_START_ADDITIONAL_CONTEXT_LIMIT);
});

test('launcher renderer rejects relative, wrong-leaf, control, and oversized paths', () => {
  for (const value of ['skills/rescue/launcher.mjs', '/tmp/launcher.mjs', '/tmp/zcode\n/skills/rescue/launcher.mjs', `/tmp/${'x'.repeat(2100)}/skills/rescue/launcher.mjs`]) {
    assert.throws(() => renderRescueLauncherCommand(value), { code: 'RESCUE_LAUNCHER_PATH_UNSAFE' });
  }
});

test('TOML renderer accepts only canonical machine-rendered launcher commands', () => {
  const safe = renderRescueLauncherCommand('/opt/ZCode active/skills/rescue/launcher.mjs', { platform: 'darwin' });
  assert.equal(escapeRescueLauncherCommandForToml(safe, { platform: 'darwin' }), 'node \\"/opt/ZCode active/skills/rescue/launcher.mjs\\"');
  const windows = renderRescueLauncherCommand('C:\\Users\\me\\ZCode Active\\skills\\rescue\\launcher.mjs', { platform: 'win32' });
  assert.equal(escapeRescueLauncherCommandForToml(windows, { platform: 'win32' }), 'node \\"C:\\\\Users\\\\me\\\\ZCode Active\\\\skills\\\\rescue\\\\launcher.mjs\\"');
  for (const command of [
    'node "/opt/$(touch PWNED)/skills/rescue/launcher.mjs"',
    'node "/opt/zcode/skills/rescue/launcher.mjs" trailing',
    'node scripts/zcode-companion.mjs',
  ]) {
    assert.throws(() => escapeRescueLauncherCommandForToml(command), { code: 'RESCUE_LAUNCHER_COMMAND_INVALID' });
  }
});
