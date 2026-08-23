// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  REQUIRED_RESCUE_PAYLOAD,
  buildMarketplaceSnapshot,
  createMarketplaceContentManifest,
  validateReleaseIdentity,
  validateResolvedSource,
} from '../scripts/build-marketplace-snapshot.mjs';
import { runProcess } from '../scripts/lib/process.mjs';
import { npmLaunch } from '../scripts/lib/tool-launch.mjs';

test('marketplace builder requires the complete isolated Rescue payload', () => {
  assert.deepEqual(REQUIRED_RESCUE_PAYLOAD, [
    'agents/zcode-rescue.toml.template',
    'skills/rescue/SKILL.md',
    'skills/rescue/launcher.mjs',
    'scripts/zcode-companion.mjs',
    'scripts/lib/codex-app-server.mjs',
    'scripts/lib/invocation.mjs',
    'scripts/lib/job-control.mjs',
    'scripts/lib/job-log.mjs',
    'scripts/lib/job-log-runtime.mjs',
    'scripts/lib/public-text.mjs',
    'scripts/lib/rescue-binding.mjs',
    'scripts/lib/rescue-preparation.mjs',
    'scripts/lib/rescue-route-planner.mjs',
    'scripts/lib/state.mjs',
    'scripts/lib/conversation-progress.mjs',
    'scripts/lib/managed-agent-role.mjs',
    'scripts/lib/plugin-data.mjs',
    'scripts/lib/rescue-launcher-command.mjs',
    'scripts/lib/progress.mjs',
    'hooks/subagent-hook.mjs',
    'hooks/lib/hook-state.mjs',
    'hooks/session-lifecycle-hook.mjs',
    'hooks/user-prompt-hook.mjs',
    'hooks/session-end-hook.mjs',
    'hooks/stop-review-gate-hook.mjs',
    'CHANGELOG.md',
    'README.md',
    'README.zh-CN.md',
    'SECURITY.md',
    'docs/adr/0013-bind-rescue-child-to-zcode-session.md',
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

test('content manifest covers extra root and hidden metadata payload bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-marketplace-manifest-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(directory, '.agents', 'plugins'), { recursive: true }),
    mkdir(join(directory, 'plugins', 'zcode'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(directory, '.agents', 'plugins', 'marketplace.json'), '{}\n'),
    writeFile(join(directory, '.agents', 'plugins', 'provenance.json'), '{"content":"self"}\n'),
    writeFile(join(directory, '.agents', 'release-channel.json'), '{"channel":"stable"}\n'),
    writeFile(join(directory, 'plugins', 'zcode', 'package.json'), '{}\n'),
    writeFile(join(directory, 'release-notes.txt'), 'published root payload\n'),
  ]);

  const manifest = await createMarketplaceContentManifest(directory);
  assert.deepEqual(manifest.files.map(({ path }) => path), [
    '.agents/plugins/marketplace.json',
    '.agents/release-channel.json',
    'plugins/zcode/package.json',
    'release-notes.txt',
  ]);
});

test('content manifest rejects symlink roots and hidden symlink payloads', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-marketplace-manifest-links-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshot = join(directory, 'snapshot');
  await mkdir(join(snapshot, '.agents'), { recursive: true });
  await writeFile(join(directory, 'outside.json'), '{"private":true}\n');
  await symlink(join(directory, 'outside.json'), join(snapshot, '.agents', 'metadata.json'));
  await assert.rejects(createMarketplaceContentManifest(snapshot), /real directories|regular files/i);

  await rm(join(snapshot, '.agents', 'metadata.json'));
  const alias = join(directory, 'snapshot-alias');
  await symlink(snapshot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createMarketplaceContentManifest(alias), /real snapshot root/i);
});

test('content manifest rejects a non-file at its reserved provenance path', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-marketplace-manifest-provenance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, '.agents', 'plugins', 'provenance.json'), { recursive: true });

  await assert.rejects(createMarketplaceContentManifest(directory), /provenance must be a regular file/i);
});

test('content manifest path order is locale-independent', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-marketplace-manifest-order-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ['Z', '_', 'a', 'ä']) await writeFile(join(directory, name), `${name}\n`);

  const manifest = await createMarketplaceContentManifest(directory);
  assert.deepEqual(manifest.files.map(({ path }) => path), ['Z', '_', 'a', 'ä']);
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
    mkdir(join(root, 'hooks', 'lib'), { recursive: true }),
    mkdir(join(root, 'docs', 'adr'), { recursive: true }),
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
