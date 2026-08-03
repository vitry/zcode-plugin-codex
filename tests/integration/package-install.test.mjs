import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const rootPath = fileURLToPath(new URL('../../', import.meta.url));

/** @param {string} command @param {string[]} args @param {string} cwd */
function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 30_000 });
}

test('packed production install loads and locks on Node 18 with pinned resolver', async (t) => {
  const node18 = process.env.NODE18_BINARY;
  const nodeCommand = node18 ?? 'npx';
  const nodePrefix = node18 ? [] : ['--yes', 'node@18.18.0'];
  const probe = run(nodeCommand, [...nodePrefix, '--version'], rootPath);
  if (probe.status !== 0) {
    t.skip('Node 18.18 is unavailable; CI must set NODE18_BINARY or allow npx download');
    return;
  }

  const temporary = await mkdtemp(join(tmpdir(), 'zcode-packed-install-'));
  t.after(() => rm(temporary, { force: true, recursive: true }));
  const packageDirectory = join(temporary, 'package');
  const consumerDirectory = join(temporary, 'consumer');
  await Promise.all([mkdir(packageDirectory), mkdir(consumerDirectory)]);
  const packed = run('npm', ['pack', '--json', '--pack-destination', packageDirectory], rootPath);
  assert.equal(packed.status, 0, packed.stderr);
  const [{ filename }] = JSON.parse(packed.stdout);
  await writeFile(join(consumerDirectory, 'package.json'), JSON.stringify({
    name: 'packed-consumer',
    private: true,
    dependencies: { 'zcode-plugin-codex': `file:${join(packageDirectory, filename)}` },
  }));
  const installed = run('npm', ['install', '--omit=dev', '--ignore-scripts'], consumerDirectory);
  assert.equal(installed.status, 0, installed.stderr);

  const smoke = `
    const fs = require('node:fs');
    const path = require('node:path');
    const pluginRoot = path.join(process.cwd(), 'node_modules/zcode-plugin-codex');
    const requireAddon = require.resolve('require-addon', { paths: [pluginRoot] });
    const resolverMain = require.resolve('bare-addon-resolve', {
      paths: [path.dirname(requireAddon)]
    });
    const resolver = require(path.join(path.dirname(resolverMain), 'package.json'));
    if (resolver.version !== '1.9.4') throw new Error('resolver=' + resolver.version);
    import(path.join(pluginRoot, 'scripts/lib/fs.mjs')).then(async ({ withFileLock }) => {
      const lockPath = path.join(process.cwd(), 'smoke.lock');
      const result = await withFileLock(lockPath, async () => 'locked');
      if (result !== 'locked') throw new Error('lock failed');
    });
  `;
  const result = run(nodeCommand, [...nodePrefix, '--eval', smoke], consumerDirectory);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
