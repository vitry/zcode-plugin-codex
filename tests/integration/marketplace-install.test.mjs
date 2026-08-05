// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { buildMarketplaceSnapshot } from '../../scripts/build-marketplace-snapshot.mjs';
import { runProcess, terminateProcess } from '../../scripts/lib/process.mjs';
import { codexLaunch, npmLaunch } from '../../scripts/lib/tool-launch.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const expectedSkills = ['adversarial-review', 'cancel', 'rescue', 'result', 'review', 'setup', 'status', 'transfer'];

async function run(args, cwd, env) {
  const launch = codexLaunch(args, { root, env });
  return runProcess(launch, { cwd, env, timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024 });
}

function listSkills(cwd, env) {
  return new Promise((resolvePromise, reject) => {
    const launch = codexLaunch(['app-server'], { root, env });
    const child = spawn(launch.command, launch.args, { ...launch.options, cwd, env, detached: process.platform !== 'win32', windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let bytes = 0; let settled = false;
    const timer = setTimeout(() => { void finish(new Error(`skills/list timed out: ${stderr}`)); }, 30_000);
    const finish = async (error, value) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      child.stdin.end();
      await terminateProcess(child, { graceMs: 250 }).catch(() => {});
      error ? reject(error) : resolvePromise(value);
    };
    child.once('error', (error) => { void finish(error); });
    child.once('exit', (code, signal) => { if (!settled) void finish(new Error(`Codex app-server exited before skills/list: ${code ?? signal}`)); });
    child.stderr.on('data', (chunk) => { bytes += chunk.length; stderr = `${stderr}${chunk}`.slice(-8192); if (bytes > 8 * 1024 * 1024) void finish(new Error('skills/list exceeded its output limit')); });
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { void finish(new Error('skills/list exceeded its output limit')); return; }
      stdout += chunk;
      for (;;) {
        const newline = stdout.indexOf('\n');
        if (newline < 0) return;
        const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        if (frame.id === 1 && frame.result) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'skills/list', params: { cwds: [cwd], forceReload: true } })}\n`);
        } else if (frame.id === 2) {
          if (frame.error) void finish(new Error(`skills/list failed: ${JSON.stringify(frame.error)} ${stderr}`));
          else void finish(null, frame.result);
        }
      }
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'zcode-marketplace-test', version: '1.0.0' }, capabilities: { experimentalApi: true } } })}\n`);
  });
}

async function findPluginRoots(directory, found = []) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return found; }
  if (entries.some((entry) => entry.name === '.codex-plugin' && entry.isDirectory())) found.push(directory);
  for (const entry of entries) if (entry.isDirectory()) await findPluginRoots(join(directory, entry.name), found);
  return found;
}

test('isolated Codex marketplace lists and installs the eight-skill snapshot', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'zcode-marketplace-install-'));
  t.after(() => rm(temporary, { force: true, recursive: true }));
  const marketplace = process.env.MARKETPLACE_SNAPSHOT
    ? await realpath(process.env.MARKETPLACE_SNAPSHOT)
    : join(temporary, 'marketplace');
  const codexHome = join(temporary, 'codex-home');
  const isolatedHome = join(temporary, 'home');
  await Promise.all([mkdir(codexHome, { recursive: true }), mkdir(isolatedHome, { recursive: true })]);
  if (!process.env.MARKETPLACE_SNAPSHOT) await buildMarketplaceSnapshot({
    root,
    output: marketplace,
    sourceRef: 'test',
    sourceSha: '0'.repeat(40),
    npmExecPath: process.env.NPM_CLI_JS ?? npmLaunch([]).args[0],
    env: process.env,
  });
  const provenance = JSON.parse(await readFile(join(marketplace, '.agents', 'plugins', 'provenance.json'), 'utf8'));
  assert.equal(provenance.packageVersion, JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version);
  assert.equal(provenance.pluginVersion, provenance.packageVersion);
  assert.equal(provenance.sourceRef, process.env.MARKETPLACE_SOURCE_REF ?? 'test');
  assert.equal(provenance.sourceSha, process.env.MARKETPLACE_SOURCE_SHA ?? '0'.repeat(40));
  await assert.rejects(readFile(join(marketplace, 'plugins', 'zcode', 'node_modules', '@openai', 'codex', 'package.json'), 'utf8'), { code: 'ENOENT' });
  await assert.rejects(readFile(join(marketplace, 'plugins', 'zcode', 'tests', 'integration', 'marketplace-install.test.mjs'), 'utf8'), { code: 'ENOENT' });
  const env = { ...process.env, CODEX_HOME: codexHome, HOME: isolatedHome, USERPROFILE: isolatedHome };

  const added = await run(['plugin', 'marketplace', 'add', marketplace, '--json'], temporary, env);
  assert.equal(added.code, 0, added.stderr || added.stdout);
  const addJson = JSON.parse(added.stdout);
  assert.equal(addJson.marketplaceName, 'vitry');

  const listed = await run(['plugin', 'list', '--marketplace', 'vitry', '--available', '--json'], temporary, env);
  assert.equal(listed.code, 0, listed.stderr || listed.stdout);
  assert.deepEqual(JSON.parse(listed.stdout).available.map((entry) => entry.pluginId), ['zcode@vitry']);

  const installed = await run(['plugin', 'add', 'zcode@vitry', '--json'], temporary, env);
  assert.equal(installed.code, 0, installed.stderr || installed.stdout);
  const roots = await findPluginRoots(codexHome);
  const installedRoot = roots.find((path) => basename(join(path, '..', '..')) === 'zcode')
    ?? roots.find((path) => path.includes(`${join('cache', 'vitry', 'zcode')}`));
  assert.ok(installedRoot, `installed plugin root missing under ${codexHome}: ${roots.join(', ')}`);
  assert.deepEqual((await readdir(join(installedRoot, 'skills'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(), expectedSkills);
  assert.equal(JSON.parse(await readFile(join(installedRoot, '.codex-plugin', 'plugin.json'), 'utf8')).name, 'zcode');
  const listedSkills = await listSkills(temporary, env);
  const installedSkills = listedSkills.data.flatMap((entry) => entry.skills)
    .filter((skill) => /^(?:zcode|zcode-plugin-codex):/.test(skill.name));
  assert.deepEqual(installedSkills.map((skill) => skill.name).sort(), expectedSkills.map((name) => `zcode:${name}`).sort());
  assert.ok(installedSkills.every((skill) => skill.enabled === true));
  const nativeBinding = await realpath(join(installedRoot, 'node_modules', 'fs-native-extensions'));
  assert.ok(nativeBinding.startsWith(`${await realpath(installedRoot)}/`));
  const { withFileLock } = await import(pathToFileURL(join(installedRoot, 'scripts', 'lib', 'fs.mjs')).href);
  assert.equal(await withFileLock(join(temporary, 'snapshot-native.lock'), async () => 'locked'), 'locked');
});
