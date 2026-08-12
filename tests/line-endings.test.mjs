// @ts-nocheck
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizeTrackedPath } from '../scripts/check-line-endings.mjs';

const root = new URL('../', import.meta.url);
const checker = new URL('../scripts/check-line-endings.mjs', import.meta.url);

const runChecker = (repositoryRoot) => spawnSync(
  process.execPath,
  [fileURLToPath(checker), '--root', repositoryRoot instanceof URL ? fileURLToPath(repositoryRoot) : repositoryRoot],
  { encoding: 'utf8', shell: false },
);

const runGit = (repositoryRoot, args) => {
  const result = spawnSync('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr);
};

const createRepository = async (t) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'zcode-line-endings-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  runGit(repositoryRoot, ['init', '-q']);
  await writeFile(join(repositoryRoot, '.gitattributes'), '* text=auto eol=lf\n');
  runGit(repositoryRoot, ['add', '.gitattributes']);
  return repositoryRoot;
};

test('line-ending checker accepts the current tracked repository', () => {
  const result = runChecker(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LF line endings verified/);
});

test('line-ending checker rejects a tracked CRLF marketplace payload by relative path', async (t) => {
  const repositoryRoot = await createRepository(t);
  await mkdir(join(repositoryRoot, 'marketplace'), { recursive: true });
  await writeFile(join(repositoryRoot, 'marketplace', 'payload.md'), Buffer.from('first\r\nsecond\r\n'));
  runGit(repositoryRoot, ['add', '.']);

  const result = runChecker(repositoryRoot);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CRLF is forbidden/);
  assert.match(result.stderr, /marketplace\/payload\.md/);
  assert.doesNotMatch(result.stderr, new RegExp(repositoryRoot.replaceAll('\\', '\\\\')));
});

test('line-ending checker ignores untracked, ignored, and binary CRLF data', async (t) => {
  const repositoryRoot = await createRepository(t);
  await writeFile(join(repositoryRoot, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(repositoryRoot, 'tracked.txt'), 'tracked\n');
  await writeFile(join(repositoryRoot, 'untracked.txt'), 'untracked\r\n');
  await writeFile(join(repositoryRoot, 'ignored.txt'), 'ignored\r\n');
  await writeFile(join(repositoryRoot, 'binary.dat'), Buffer.from([0x00, 0x0d, 0x0a]));
  runGit(repositoryRoot, ['add', '.gitattributes', '.gitignore', 'tracked.txt', 'binary.dat']);

  const result = runChecker(repositoryRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LF line endings verified/);
});

test('line-ending diagnostics normalize Git paths to portable separators', () => {
  assert.equal(normalizeTrackedPath('marketplace\\plugins\\zcode\\README.md'), 'marketplace/plugins/zcode/README.md');
});
