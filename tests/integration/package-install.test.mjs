import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { npmLaunch, npxLaunch } from '../../scripts/lib/tool-launch.mjs';

const rootPath = fileURLToPath(new URL('../../', import.meta.url));

/** @param {{ command: string, args: string[], options: object }} launch @param {string} cwd */
function run(launch, cwd) {
  return spawnSync(launch.command, launch.args, {
    ...launch.options, cwd, encoding: 'utf8', timeout: 30_000, shell: false,
  });
}

/** @param {string[]} args */
function node18Launch(args) {
  const configured = process.env.NODE18_BINARY;
  if (configured) return { command: configured, args, options: { shell: false } };
  return npxLaunch(['--yes', 'node@18.18.0', ...args]);
}

test('packed production install loads and locks on Node 18 with pinned resolver', async (t) => {
  const probe = run(node18Launch(['--version']), rootPath);
  if (probe.status !== 0) {
    if (process.env.CI) assert.fail(`Node 18.18 is mandatory in CI: ${probe.stderr || probe.stdout}`);
    t.skip('Node 18.18 is unavailable; CI must set NODE18_BINARY or allow npx download');
    return;
  }

  const temporary = await mkdtemp(join(tmpdir(), 'zcode-packed-install-'));
  t.after(() => rm(temporary, { force: true, recursive: true }));
  const packageDirectory = join(temporary, 'package');
  const consumerDirectory = join(temporary, 'consumer');
  await Promise.all([mkdir(packageDirectory), mkdir(consumerDirectory)]);
  const packed = run(npmLaunch(['pack', '--json', '--pack-destination', packageDirectory]), rootPath);
  assert.equal(packed.status, 0, packed.stderr);
  const [{ filename }] = JSON.parse(packed.stdout);
  await writeFile(join(consumerDirectory, 'package.json'), JSON.stringify({
    name: 'packed-consumer',
    private: true,
    dependencies: { 'zcode-plugin-codex': `file:${join(packageDirectory, filename)}` },
  }));
  const locked = run(npmLaunch(['install', '--package-lock-only', '--omit=dev', '--ignore-scripts']), consumerDirectory);
  assert.equal(locked.status, 0, locked.stderr);
  await rm(join(consumerDirectory, 'node_modules'), { force: true, recursive: true });
  const installed = run(npmLaunch(['ci', '--omit=dev', '--ignore-scripts']), consumerDirectory);
  assert.equal(installed.status, 0, installed.stderr);

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
    if (resolver.version !== '1.9.4') throw new Error('resolver=' + resolver.version);
    import(path.join(pluginRoot, 'scripts/lib/fs.mjs')).then(async ({ withFileLock }) => {
      const lockPath = path.join(process.cwd(), 'smoke.lock');
      const result = await withFileLock(lockPath, async () => 'locked');
      if (result !== 'locked') throw new Error('lock failed');
    });
  `;
  const result = run(node18Launch(['--eval', smoke]), consumerDirectory);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
