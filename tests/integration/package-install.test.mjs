import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { runProcess } from '../../scripts/lib/process.mjs';
import { npmLaunch, npxLaunch } from '../../scripts/lib/tool-launch.mjs';

const rootPath = fileURLToPath(new URL('../../', import.meta.url));

/** @param {{ command: string, args: string[], options: object }} launch @param {string} cwd */
async function run(launch, cwd) {
  return runProcess(launch, { cwd, timeoutMs: 120_000, maxOutputBytes: 4 * 1024 * 1024 });
}

/** @param {string[]} args */
function node22Launch(args) {
  const configured = process.env.NODE22_BINARY;
  if (configured) return { command: configured, args, options: { shell: false } };
  return npxLaunch(['--yes', 'node@22.13.0', ...args]);
}

test('packed production install loads and locks on Node 22.13', async (t) => {
  const probe = await run(node22Launch(['--version']), rootPath);
  if (probe.code !== 0) {
    if (process.env.CI) assert.fail(`Node 22.13 is mandatory in CI: ${probe.stderr || probe.stdout}`);
    t.skip('Node 22.13 is unavailable; CI must set NODE22_BINARY or allow npx download');
    return;
  }

  const temporary = await mkdtemp(join(tmpdir(), 'zcode-packed-install-'));
  t.after(() => rm(temporary, { force: true, recursive: true }));
  const packageDirectory = join(temporary, 'package');
  const consumerDirectory = join(temporary, 'consumer');
  await Promise.all([mkdir(packageDirectory), mkdir(consumerDirectory)]);
  const packed = await run(npmLaunch(['pack', '--json', '--pack-destination', packageDirectory]), rootPath);
  assert.equal(packed.code, 0, packed.stderr);
  const [{ filename }] = JSON.parse(packed.stdout);
  await writeFile(join(consumerDirectory, 'package.json'), JSON.stringify({
    name: 'packed-consumer',
    private: true,
    dependencies: { 'zcode-plugin-codex': `file:${join(packageDirectory, filename)}` },
  }));
  const locked = await run(npmLaunch(['install', '--package-lock-only', '--omit=dev', '--ignore-scripts']), consumerDirectory);
  assert.equal(locked.code, 0, locked.stderr);
  await rm(join(consumerDirectory, 'node_modules'), { force: true, recursive: true });
  const installed = await run(npmLaunch(['ci', '--omit=dev', '--ignore-scripts']), consumerDirectory);
  assert.equal(installed.code, 0, installed.stderr);

  const pluginRoot = join(consumerDirectory, 'node_modules', 'zcode-plugin-codex');
  for (const path of [
    'agents/zcode-rescue.toml.template',
    'skills/rescue/launcher.mjs',
    'scripts/lib/conversation-progress.mjs',
    'scripts/lib/managed-agent-role.mjs',
    'scripts/lib/plugin-data.mjs',
    'scripts/lib/progress.mjs',
    'scripts/lib/rescue-launcher-command.mjs',
  ]) await access(join(pluginRoot, path));
  assert.match(await readFile(join(pluginRoot, 'agents', 'zcode-rescue.toml.template'), 'utf8'), /^developer_instructions = """/);
  await assert.rejects(access(join(pluginRoot, 'agents', 'zcode-rescue.md')), { code: 'ENOENT' });
  await assert.rejects(access(join(pluginRoot, 'tools', 'repair-rescue-continuation-binding.mjs')), { code: 'ENOENT' });

  const smoke = `
    const fs = require('node:fs');
    const path = require('node:path');
    const pluginRoot = path.join(process.cwd(), 'node_modules/zcode-plugin-codex');
    const requireAddon = require.resolve('require-addon', { paths: [pluginRoot] });
    const nativeBinding = require.resolve('fs-native-extensions', { paths: [pluginRoot] });
    const bundledRoot = path.join(pluginRoot, 'node_modules') + path.sep;
    if (!requireAddon.startsWith(bundledRoot)) throw new Error('external require-addon=' + requireAddon);
    if (!nativeBinding.startsWith(bundledRoot)) throw new Error('external native binding=' + nativeBinding);
    const resolverMain = require.resolve('bare-addon-resolve', {
      paths: [path.dirname(requireAddon)]
    });
    if (!resolverMain.startsWith(bundledRoot)) throw new Error('external resolver=' + resolverMain);
    const resolver = require(path.join(path.dirname(resolverMain), 'package.json'));
    if (resolver.version !== '1.10.1') throw new Error('resolver=' + resolver.version);
    Promise.all([
      import(path.join(pluginRoot, 'scripts/lib/conversation-progress.mjs')),
      import(path.join(pluginRoot, 'scripts/lib/managed-agent-role.mjs')),
      import(path.join(pluginRoot, 'scripts/lib/progress.mjs')),
      import(path.join(pluginRoot, 'scripts/lib/fs.mjs')),
    ]).then(async ([conversationProgress, managedRole, progress, { withFileLock }]) => {
      if (typeof conversationProgress.createConversationProgressDescriber !== 'function') throw new Error('conversation progress module missing');
      if (typeof managedRole.inspectManagedRescueRole !== 'function') throw new Error('managed role module missing');
      if (typeof progress.createProgressReporter !== 'function') throw new Error('progress module missing');
      const lockPath = path.join(process.cwd(), 'smoke.lock');
      const result = await withFileLock(lockPath, async () => 'locked');
      if (result !== 'locked') throw new Error('lock failed');
    });
  `;
  const result = await run(node22Launch(['--eval', smoke]), consumerDirectory);
  assert.equal(result.code, 0, result.stderr || result.stdout);
});
