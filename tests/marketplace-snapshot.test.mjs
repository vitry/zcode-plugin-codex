// @ts-nocheck
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  REQUIRED_RESCUE_PAYLOAD,
  buildMarketplaceSnapshot,
  validateReleaseIdentity,
  validateResolvedSource,
} from '../scripts/build-marketplace-snapshot.mjs';
import { runProcess } from '../scripts/lib/process.mjs';
import { npmLaunch } from '../scripts/lib/tool-launch.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const lockedRuntimePackages = Object.freeze([
  'fs-native-extensions',
  'require-addon',
  'which-runtime',
  'bare-addon-resolve',
  'bare-module-resolve',
  'bare-semver',
]);

test('marketplace builder requires the complete isolated Rescue payload', () => {
  assert.deepEqual(REQUIRED_RESCUE_PAYLOAD, [
    'agents/zcode-rescue.toml.template',
    'scripts/lib/conversation-progress.mjs',
    'scripts/lib/managed-agent-role.mjs',
    'scripts/lib/progress.mjs',
  ]);
});

test('release identity binds package, plugin, source ref, SHA, and exact version tag', () => {
  const sha = 'a'.repeat(40);
  const dependencyLock = { file: 'npm-shrinkwrap.json', sha256: 'b'.repeat(64) };
  assert.deepEqual(validateReleaseIdentity({ packageVersion: '1.2.3', pluginVersion: '1.2.3', sourceRef: 'v1.2.3', sourceSha: sha, releaseTag: 'v1.2.3', dependencyLock }), {
    packageVersion: '1.2.3', pluginVersion: '1.2.3', sourceRef: 'v1.2.3', sourceSha: sha, releaseTag: 'v1.2.3', dependencyLock,
  });
  for (const input of [
    { packageVersion: '1.2.3', pluginVersion: '1.2.4', sourceRef: 'main', sourceSha: sha, dependencyLock },
    { packageVersion: '1.2.3', pluginVersion: '1.2.3', sourceRef: 'v1.2.4', sourceSha: sha, releaseTag: 'v1.2.4', dependencyLock },
    { packageVersion: '1.2.3', pluginVersion: '1.2.3', sourceRef: '', sourceSha: sha, dependencyLock },
    { packageVersion: '1.2.3', pluginVersion: '1.2.3', sourceRef: 'main', sourceSha: 'not-a-sha', dependencyLock },
    { packageVersion: '1.2.3', pluginVersion: '1.2.3', sourceRef: 'main', sourceSha: sha },
    { packageVersion: '1.2.3', pluginVersion: '1.2.3', sourceRef: 'main', sourceSha: sha, dependencyLock: { file: '../lock', sha256: 'b'.repeat(64) } },
  ]) assert.throws(() => validateReleaseIdentity(input), /release identity/i);
});

test('marketplace build is isolated from ignored current files and installs the exact locked runtime in fresh and concurrent space-containing clones', { timeout: 360_000 }, async (t) => {
  const fixture = await cleanRepositoryClone(t);
  await assert.rejects(access(join(fixture.root, 'node_modules')), { code: 'ENOENT' });
  const registrations = await worktreeRegistrations(fixture.root);
  const freshOutput = join(fixture.directory, 'fresh snapshot');
  await buildMarketplaceSnapshot({
    root: fixture.root, output: freshOutput, sourceRef: fixture.sha, sourceSha: fixture.sha, npmExecPath: npmCli(),
  });
  await assertExactLockedRuntime(freshOutput, fixture.root);
  assert.equal(await worktreeRegistrations(fixture.root), registrations);

  await npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], fixture.root);
  const poison = 'throw new Error("ignored current dependency poison");\n';
  await writeFile(join(fixture.root, 'node_modules', 'fs-native-extensions', 'index.js'), poison);
  await writeFile(join(fixture.root, 'node_modules', 'fs-native-extensions', 'ignored-current-payload.mjs'), poison);
  await writeFile(join(fixture.root, 'scripts', 'ignored-current-payload.mjs'), poison);
  await writeFile(join(fixture.root, '.git', 'info', 'exclude'), 'scripts/ignored-current-payload.mjs\n');
  assert.equal((await git(['status', '--porcelain=v1', '--untracked-files=all'], fixture.root)).stdout, '');

  const outputs = [join(fixture.directory, 'concurrent snapshot one'), join(fixture.directory, 'concurrent snapshot two')];
  await Promise.all(outputs.map((output) => buildMarketplaceSnapshot({
    root: fixture.root, output, sourceRef: fixture.sha, sourceSha: fixture.sha, npmExecPath: npmCli(),
  })));
  for (const output of outputs) {
    await assertExactLockedRuntime(output, fixture.root);
    assert.notEqual(await readFile(join(output, 'plugins', 'zcode', 'node_modules', 'fs-native-extensions', 'index.js'), 'utf8'), poison);
    await assert.rejects(access(join(output, 'plugins', 'zcode', 'node_modules', 'fs-native-extensions', 'ignored-current-payload.mjs')), { code: 'ENOENT' });
    await assert.rejects(access(join(output, 'plugins', 'zcode', 'scripts', 'ignored-current-payload.mjs')), { code: 'ENOENT' });
  }
  assert.equal(await worktreeRegistrations(fixture.root), registrations);
});

test('npm ci failure leaves neither partial publication nor detached worktree registration', { timeout: 120_000 }, async (t) => {
  const fixture = await cleanRepositoryClone(t);
  const packagePath = join(fixture.root, 'package.json');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  packageJson.dependencies['fs-native-extensions'] = '9.9.9';
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  await git(['add', 'package.json'], fixture.root);
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'break dependency lock'], fixture.root);
  fixture.sha = (await git(['rev-parse', 'HEAD'], fixture.root)).stdout.trim();
  const registrations = await worktreeRegistrations(fixture.root);
  await assert.rejects(buildMarketplaceSnapshot({
    root: fixture.root, output: fixture.output, sourceRef: fixture.sha, sourceSha: fixture.sha, npmExecPath: npmCli(),
  }), /npm ci failed/i);
  await assert.rejects(access(fixture.output), { code: 'ENOENT' });
  assert.equal(await worktreeRegistrations(fixture.root), registrations);
});

test('resolved source validation rejects a ref or checkout resolving to another SHA', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(validateResolvedSource({ sourceRef: 'main', sourceSha: sha, headSha: sha, refSha: sha }), { sourceRef: 'main', sourceSha: sha });
  assert.throws(() => validateResolvedSource({ sourceRef: 'main', sourceSha: sha, headSha: 'b'.repeat(40), refSha: sha }), /resolved marketplace source/i);
  assert.throws(() => validateResolvedSource({ sourceRef: 'wrong-ref', sourceSha: sha, headSha: sha, refSha: 'c'.repeat(40) }), /resolved marketplace source/i);
});

test('verified marketplace builds reject tracked and untracked dirty source trees before npm pack', async (t) => {
  for (const dirty of ['tracked', 'untracked']) await t.test(dirty, async (t) => {
    const fixture = await sourceFixture(t, { git: true });
    const head = (await git(['rev-parse', 'HEAD'], fixture.root)).stdout.trim();
    if (dirty === 'tracked') await writeFile(join(fixture.root, 'package.json'), `${await readFile(join(fixture.root, 'package.json'), 'utf8')}\n`);
    else await writeFile(join(fixture.root, 'untracked.txt'), 'dirty\n');
    await assert.rejects(
      buildMarketplaceSnapshot({ root: fixture.root, output: fixture.output, sourceRef: head, sourceSha: head, npmExecPath: npmCli() }),
      /source tree must be clean/i,
    );
    await assert.rejects(readFile(fixture.output), { code: 'ENOENT' });
  });
});

test('marketplace output rejects an ancestor symlink that canonically re-enters the source tree', async (t) => {
  const fixture = await sourceFixture(t);
  const alias = join(dirname(fixture.root), 'output-alias');
  await symlink(fixture.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    buildMarketplaceSnapshot({ root: fixture.root, output: join(alias, 'snapshot'), sourceRef: 'test', sourceSha: '0'.repeat(40), npmExecPath: npmCli() }),
    /outside the source root/i,
  );
  await assert.rejects(readFile(join(fixture.root, 'snapshot')), { code: 'ENOENT' });
});

test('marketplace output rejects traversal and a symlink leaf without touching its target', async (t) => {
  const fixture = await sourceFixture(t); const outside = join(dirname(fixture.root), 'outside');
  await mkdir(outside); const target = join(outside, 'target'); await mkdir(target);
  const leaf = join(outside, 'snapshot'); await symlink(target, leaf, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    buildMarketplaceSnapshot({ root: fixture.root, output: leaf, sourceRef: 'test', sourceSha: '0'.repeat(40), npmExecPath: npmCli() }),
    /symlink|must not already exist/i,
  );
  assert.equal((await readFile(join(target, 'sentinel'), 'utf8').catch(() => 'untouched')), 'untouched');
  await assert.rejects(
    buildMarketplaceSnapshot({ root: fixture.root, output: join(outside, '..', 'source', 'nested'), sourceRef: 'test', sourceSha: '0'.repeat(40), npmExecPath: npmCli() }),
    /outside the source root/i,
  );
});

test('a failed marketplace build never publishes a partial output directory', async (t) => {
  const fixture = await sourceFixture(t, { omitCatalog: true });
  await assert.rejects(
    buildMarketplaceSnapshot({ root: fixture.root, output: fixture.output, sourceRef: 'test', sourceSha: '0'.repeat(40), npmExecPath: npmCli() }),
  );
  await assert.rejects(readFile(fixture.output), { code: 'ENOENT' });
});

async function sourceFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-marketplace-source-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'source'); const output = join(directory, 'output');
  await Promise.all([
    mkdir(join(root, '.codex-plugin'), { recursive: true }),
    mkdir(join(root, 'agents'), { recursive: true }),
    mkdir(join(root, 'scripts', 'lib'), { recursive: true }),
    mkdir(join(root, 'marketplace', '.agents', 'plugins'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, 'package.json'), JSON.stringify({ name: 'zcode-plugin-codex', version: '1.2.3', files: ['.codex-plugin', 'agents', 'scripts'] })),
    writeFile(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'zcode', version: '1.2.3' })),
    writeFile(join(root, 'agents', 'zcode-rescue.toml.template'), 'developer_instructions = """fixture"""\n'),
    ...REQUIRED_RESCUE_PAYLOAD.slice(1).map((path) => writeFile(join(root, path), 'export {};\n')),
    ...(options.omitCatalog ? [] : [writeFile(join(root, 'marketplace', '.agents', 'plugins', 'marketplace.json'), '{}\n')]),
  ]);
  if (options.git) {
    await git(['init', '-q'], root); await git(['add', '.'], root);
    await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'], root);
  }
  return { root, output };
}

function npmCli() { return npmLaunch([]).args[0]; }
async function git(args, cwd) { const result = await runProcess({ command: 'git', args: [] }, { cwd, args, timeoutMs: 10_000 }); assert.equal(result.code, 0, result.stderr); return result; }

async function npm(args, cwd) {
  const descriptor = npmLaunch([], { env: { npm_execpath: npmCli() } });
  const result = await runProcess({ command: descriptor.command, args: descriptor.args, target: npmCli() }, { cwd, args, timeoutMs: 120_000, maxOutputBytes: 2 * 1024 * 1024 });
  assert.equal(result.code, 0, result.stderr); return result;
}

async function cleanRepositoryClone(t) {
  const directory = await mkdtemp(join(tmpdir(), 'zcode marketplace clone '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'source tree'); const output = join(directory, 'snapshot output');
  await git(['clone', '--no-local', '--quiet', repositoryRoot, root], directory);
  const sha = (await git(['rev-parse', 'HEAD'], root)).stdout.trim();
  return { directory, root, output, sha };
}

async function worktreeRegistrations(root) {
  return (await git(['worktree', 'list', '--porcelain'], root)).stdout;
}

async function assertExactLockedRuntime(snapshot, sourceRoot) {
  const lockBytes = await readFile(join(sourceRoot, 'npm-shrinkwrap.json'));
  const lock = JSON.parse(lockBytes.toString('utf8'));
  for (const name of lockedRuntimePackages) {
    const locked = lock.packages[`node_modules/${name}`];
    assert.ok(locked?.version, `${name} must have an exact shrinkwrap entry`);
    const installed = JSON.parse(await readFile(join(snapshot, 'plugins', 'zcode', 'node_modules', name, 'package.json'), 'utf8'));
    assert.equal(installed.name, name); assert.equal(installed.version, locked.version);
  }
  const provenance = JSON.parse(await readFile(join(snapshot, '.agents', 'plugins', 'provenance.json'), 'utf8'));
  assert.deepEqual(provenance.dependencyLock, {
    file: 'npm-shrinkwrap.json', sha256: createHash('sha256').update(lockBytes).digest('hex'),
  });
}
