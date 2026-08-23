// @ts-nocheck
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildMarketplaceSnapshot, createMarketplaceContentManifest } from '../../scripts/build-marketplace-snapshot.mjs';
import { runProcess } from '../../scripts/lib/process.mjs';
import { npmLaunch } from '../../scripts/lib/tool-launch.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const lockedRuntimePackages = Object.freeze([
  'fs-native-extensions',
  'require-addon',
  'which-runtime',
  'bare-addon-resolve',
  'bare-module-resolve',
  'bare-semver',
]);

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

  const poison = 'throw new Error("ignored current dependency poison");\n';
  const ignoredDependency = join(fixture.root, 'node_modules', 'fs-native-extensions');
  await mkdir(ignoredDependency, { recursive: true });
  await writeFile(join(ignoredDependency, 'index.js'), poison);
  await writeFile(join(ignoredDependency, 'ignored-current-payload.mjs'), poison);
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

function npmCli() { return npmLaunch([]).args[0]; }

async function cleanRepositoryClone(t) {
  const directory = await mkdtemp(join(tmpdir(), 'zcode marketplace clone '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'source tree'); const output = join(directory, 'snapshot output');
  await git(['clone', '--no-local', '--quiet', repositoryRoot, root], directory);
  const base = (await git(['rev-parse', 'HEAD'], root)).stdout.trim();
  await git(['checkout', '--detach', '--quiet', base], root);
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '--quiet', '-m', 'detached merge side'], root);
  const side = (await git(['rev-parse', 'HEAD'], root)).stdout.trim();
  await git(['checkout', '--detach', '--quiet', base], root);
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'merge', '--no-ff', '--quiet', '-m', 'detached merge checkout', side], root);
  const sha = (await git(['rev-parse', 'HEAD'], root)).stdout.trim();
  assert.equal((await git(['rev-parse', '--verify', 'HEAD^2'], root)).stdout.trim(), side);
  const symbolicHead = await runProcess({ command: 'git', args: [] }, { cwd: root, args: ['symbolic-ref', '--quiet', 'HEAD'], timeoutMs: 10_000 });
  assert.notEqual(symbolicHead.code, 0, 'fixture must model a detached pull-request merge checkout');
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
  assert.deepEqual(provenance.content, await createMarketplaceContentManifest(snapshot));
}

async function git(args, cwd) {
  const result = await runProcess({ command: 'git', args: [] }, { cwd, args, timeoutMs: 10_000 });
  assert.equal(result.code, 0, result.stderr); return result;
}
