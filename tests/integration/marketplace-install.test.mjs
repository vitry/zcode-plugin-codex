// @ts-nocheck
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../..', import.meta.url));
const expectedSkills = ['adversarial-review', 'cancel', 'rescue', 'result', 'review', 'setup', 'status', 'transfer'];

function executable(name) {
  const configured = process.env.CODEX_BINARY;
  if (name === 'codex' && configured) return configured;
  const local = join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
  return local;
}

function run(name, args, cwd, env) {
  return spawnSync(executable(name), args, { cwd, env, encoding: 'utf8', timeout: 30_000 });
}

function listSkills(cwd, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable('codex'), ['app-server'], { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => finish(new Error(`skills/list timed out: ${stderr}`)), 30_000);
    const finish = (error, value) => {
      clearTimeout(timer);
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      error ? reject(error) : resolvePromise(value);
    };
    child.once('error', finish);
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
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
          if (frame.error) finish(new Error(`skills/list failed: ${JSON.stringify(frame.error)} ${stderr}`));
          else finish(null, frame.result);
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
  const marketplace = join(temporary, 'marketplace');
  const plugin = join(marketplace, 'plugins', 'zcode');
  const codexHome = join(temporary, 'codex-home');
  const isolatedHome = join(temporary, 'home');
  await Promise.all([mkdir(plugin, { recursive: true }), mkdir(codexHome, { recursive: true }), mkdir(isolatedHome, { recursive: true })]);
  await mkdir(join(marketplace, '.agents', 'plugins'), { recursive: true });
  await cp(join(root, 'marketplace', '.agents', 'plugins', 'marketplace.json'), join(marketplace, '.agents', 'plugins', 'marketplace.json'));
  for (const name of ['.codex-plugin', 'agents', 'hooks', 'prompts', 'schemas', 'scripts', 'skills']) {
    await cp(join(root, name), join(plugin, name), { recursive: true });
  }
  for (const name of ['LICENSE', 'NOTICE', 'README.md', 'package.json', 'npm-shrinkwrap.json']) {
    await cp(join(root, name), join(plugin, name));
  }
  const env = { ...process.env, CODEX_HOME: codexHome, HOME: isolatedHome, USERPROFILE: isolatedHome };

  const added = run('codex', ['plugin', 'marketplace', 'add', marketplace, '--json'], temporary, env);
  assert.equal(added.status, 0, added.stderr || added.stdout);
  const addJson = JSON.parse(added.stdout);
  assert.equal(addJson.marketplaceName, 'vitry');

  const listed = run('codex', ['plugin', 'list', '--marketplace', 'vitry', '--available', '--json'], temporary, env);
  assert.equal(listed.status, 0, listed.stderr || listed.stdout);
  assert.deepEqual(JSON.parse(listed.stdout).available.map((entry) => entry.pluginId), ['zcode@vitry']);

  const installed = run('codex', ['plugin', 'add', 'zcode@vitry', '--json'], temporary, env);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
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
});
