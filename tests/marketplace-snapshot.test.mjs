// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  REQUIRED_RESCUE_PAYLOAD,
  buildMarketplaceSnapshot,
  validateReleaseIdentity,
  validateResolvedSource,
} from '../scripts/build-marketplace-snapshot.mjs';
import { runProcess } from '../scripts/lib/process.mjs';
import { npmLaunch } from '../scripts/lib/tool-launch.mjs';

test('marketplace builder requires the complete isolated Rescue payload', () => {
  assert.deepEqual(REQUIRED_RESCUE_PAYLOAD, [
    'agents/zcode-rescue.toml.template',
    'skills/rescue/SKILL.md',
    'scripts/zcode-companion.mjs',
    'scripts/lib/rescue-preparation.mjs',
    'scripts/lib/conversation-progress.mjs',
    'scripts/lib/managed-agent-role.mjs',
    'scripts/lib/progress.mjs',
    'hooks/user-prompt-hook.mjs',
    'hooks/session-end-hook.mjs',
    'hooks/stop-review-gate-hook.mjs',
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
    mkdir(join(root, 'skills', 'rescue'), { recursive: true }),
    mkdir(join(root, 'hooks'), { recursive: true }),
    mkdir(join(root, 'marketplace', '.agents', 'plugins'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, 'package.json'), JSON.stringify({ name: 'zcode-plugin-codex', version: '1.2.3', files: ['.codex-plugin', 'agents', 'skills', 'scripts', 'hooks'] })),
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
