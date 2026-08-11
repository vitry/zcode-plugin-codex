import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { atomicWritePrivateFile, replaceFileAtomically } from '../scripts/lib/fs.mjs';

const fsModule = new URL('../scripts/lib/fs.mjs', import.meta.url).href;
const reviewModule = new URL('../scripts/lib/review.mjs', import.meta.url).href;

test('diagnostic: Windows path and handle identities', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-win-identity-diagnostic-'));
  const target = join(directory, 'record.json');
  try {
    await writeFile(target, '{"ok":true}');
    const snapshot = async () => {
      const handle = await open(target, 'r');
      try {
      const [pathLstat, pathStat, handleStat] = await Promise.all([
        lstat(target, { bigint: true }),
        stat(target, { bigint: true }),
        handle.stat({ bigint: true }),
      ]);
      /** @param {import('node:fs').BigIntStats} value */
      const identity = (value) => ({ dev: String(value.dev), ino: String(value.ino), size: String(value.size) });
        return { lstat: identity(pathLstat), stat: identity(pathStat), fstat: identity(handleStat) };
      } finally { await handle.close(); }
    };
    const fresh = await snapshot();
    const temporary = join(directory, 'record.tmp');
    await writeFile(temporary, '{"ok":false}');
    await rename(temporary, target);
    const replaced = await snapshot();
    assert.fail(`WINDOWS_IDENTITY_DIAGNOSTIC ${JSON.stringify({ fresh, replaced })}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

/** @param {'all-handles'|'handle-after'|'reopened-path'} mode */
function boundedReadIdentityProbe(mode) {
  return `
    import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { readBoundedJsonFile } from ${JSON.stringify(fsModule)};
    const directory = await mkdtemp(join(tmpdir(), 'zcode-bounded-identity-'));
    const target = join(directory, 'record.json');
    await writeFile(target, '{"ok":true}');
    const probe = await open(join(directory, 'probe'), 'a+');
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const originalStat = prototype.stat;
    let statCalls = 0;
    prototype.stat = async function patchedStat(...args) {
      const stats = await originalStat.call(this, ...args);
      statCalls += 1;
      if (${JSON.stringify(mode)} === 'all-handles' || ${JSON.stringify(mode)} === 'handle-after' && statCalls === 2 || ${JSON.stringify(mode)} === 'reopened-path' && statCalls === 3) return new Proxy(stats, { get(target, property) {
        if (property === 'dev') return target.dev + 1;
        if (property === 'ino') return target.ino + 1;
        return Reflect.get(target, property);
      } });
      return stats;
    };
    try {
      if (${JSON.stringify(mode)} === 'all-handles') {
        const value = await readBoundedJsonFile(directory, target, 1024);
        if (value.ok !== true || statCalls !== 3) throw new Error('bounded JSON did not compare three handle-bound identities');
      } else {
        try {
          await readBoundedJsonFile(directory, target, 1024);
          throw new Error('bounded JSON accepted a changed handle-bound identity');
        } catch (error) {
          if (error?.code !== 'PRIVATE_PATH_UNSAFE') throw error;
        }
      }
    } finally {
      prototype.stat = originalStat;
      await rm(directory, { recursive: true, force: true });
    }
  `;
}

test('bounded JSON identity checks do not mix handle and path stat implementations', async () => {
  const result = await runNode(boundedReadIdentityProbe('all-handles'));
  assert.equal(result.code, 0, result.stderr || result.stdout);
});

test('bounded JSON reads reject a changed identity on the opened handle', async () => {
  const result = await runNode(boundedReadIdentityProbe('handle-after'));
  assert.equal(result.code, 0, result.stderr || result.stdout);
});

test('bounded JSON reads reject a changed reopened current-path handle identity', async () => {
  const result = await runNode(boundedReadIdentityProbe('reopened-path'));
  assert.equal(result.code, 0, result.stderr || result.stdout);
});

test('Windows atomic replacement retries only transient EPERM without exposing an unlink window', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-win-replace-'));
  const temporaryPath = join(directory, 'record.tmp'); const targetPath = join(directory, 'record.json');
  await writeFile(temporaryPath, 'new'); await writeFile(targetPath, 'old');
  /** @type {Array<[string,string]>} */
  const calls = []; let attempts = 0;
  try {
    await replaceFileAtomically(temporaryPath, targetPath, {
      platform: 'win32', maximumAttempts: 3,
      renameFn: async (from, to) => {
        calls.push([from, to]); attempts += 1;
        if (attempts < 3) {
          assert.equal(await readFile(targetPath, 'utf8'), 'old');
          assert.equal(await readFile(temporaryPath, 'utf8'), 'new');
          throw Object.assign(new Error('destination temporarily locked'), { code: 'EPERM' });
        }
        const { rename } = await import('node:fs/promises'); await rename(from, to);
      },
      retryDelayFn: async () => {},
    });
    assert.equal(await readFile(targetPath, 'utf8'), 'new');
    assert.deepEqual(calls, Array(3).fill([temporaryPath, targetPath]));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Windows atomic replacement bounds persistent EPERM and preserves both files for fail-closed cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-win-replace-fail-'));
  const temporaryPath = join(directory, 'record.tmp'); const targetPath = join(directory, 'record.json');
  await writeFile(temporaryPath, 'new'); await writeFile(targetPath, 'old'); let attempts = 0; let delays = 0;
  try {
    await assert.rejects(replaceFileAtomically(temporaryPath, targetPath, {
      platform: 'win32', maximumAttempts: 3,
      renameFn: async () => { attempts += 1; throw Object.assign(new Error('still locked'), { code: 'EPERM' }); },
      retryDelayFn: async () => { delays += 1; },
    }), { code: 'EPERM' });
    assert.equal(attempts, 3); assert.equal(delays, 2);
    assert.equal(await readFile(targetPath, 'utf8'), 'old');
    assert.equal(await readFile(temporaryPath, 'utf8'), 'new');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('atomic private write removes its temporary file after persistent Windows EPERM', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-win-write-fail-')); const targetPath = join(directory, 'record.json');
  await writeFile(targetPath, 'old'); let temporaryPath;
  try {
    await assert.rejects(atomicWritePrivateFile(targetPath, 'new', {
      platform: 'win32', maximumAttempts: 2,
      renameFn: async (from) => {
        temporaryPath = from;
        throw Object.assign(new Error('still locked'), { code: 'EPERM' });
      },
      retryDelayFn: async () => {},
    }), { code: 'ATOMIC_WRITE_FAILED' });
    assert.equal(await readFile(targetPath, 'utf8'), 'old');
    assert.ok(temporaryPath);
    await assert.rejects(readFile(temporaryPath), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('atomic replacement does not retry non-Windows or non-EPERM failures', async () => {
  /** @type {Array<[NodeJS.Platform,string]>} */
  const failures = [['linux', 'EPERM'], ['win32', 'EACCES']];
  for (const [platform, code] of failures) {
    let attempts = 0;
    await assert.rejects(replaceFileAtomically('temporary', 'target', {
      platform, maximumAttempts: 3,
      renameFn: async () => { attempts += 1; throw Object.assign(new Error(code), { code }); },
      retryDelayFn: async () => assert.fail('an ineligible error must not wait'),
    }), { code });
    assert.equal(attempts, 1);
  }
});

/** @param {string} source @returns {Promise<{code:number|null,signal:NodeJS.Signals|null,stdout:string,stderr:string}>} */
function runNode(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Windows compatibility probe exceeded its timeout')); }, 5_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

/** @param {string} moduleUrl @param {'atomicWriteJson'|'atomicWritePrivateFile'|'writeResultArtifact'} operation @returns {string} */
function syncFailureProbe(moduleUrl, operation) {
  return `
    import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { ${operation} } from ${JSON.stringify(moduleUrl)};
    const directory = await mkdtemp(join(tmpdir(), 'zcode-windows-sync-'));
    const target = join(directory, 'record.json');
    const probe = await open(target, 'a+');
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const originalSync = prototype.sync;
    let syncCalls = 0;
    prototype.sync = async function patchedSync(...args) {
      syncCalls += 1;
      if (syncCalls === 2) {
        const error = new Error('simulated Windows directory fsync failure');
        error.code = 'EPERM';
        throw error;
      }
      return originalSync.call(this, ...args);
    };
    try {
      ${operation === 'atomicWriteJson' ? "await atomicWriteJson(target, { ok: true }); if (!JSON.parse(await readFile(target, 'utf8')).ok) throw new Error('atomic write did not persist');" : operation === 'atomicWritePrivateFile' ? "await atomicWritePrivateFile(target, Buffer.from('role-bytes\\n')); if ((await readFile(target, 'utf8')) !== 'role-bytes\\n') throw new Error('atomic private write did not persist');" : "const relative = await writeResultArtifact({ dataRoot: directory, workspace: directory, jobId: 'a'.repeat(64), contents: 'done' }); if (relative !== 'results/' + 'a'.repeat(64) + '.md') throw new Error('artifact path did not persist');"}
    } finally {
      prototype.sync = originalSync;
      await rm(directory, { recursive: true, force: true });
    }
  `;
}

test('atomic JSON writes tolerate an unsupported Windows directory fsync', async () => {
  const result = await runNode(syncFailureProbe(fsModule, 'atomicWriteJson'));
  assert.equal(result.code, 0, result.stderr || result.stdout);
});

test('atomic private file writes tolerate an unsupported Windows directory fsync', async () => {
  const result = await runNode(syncFailureProbe(fsModule, 'atomicWritePrivateFile'));
  assert.equal(result.code, 0, result.stderr || result.stdout);
});

test('artifact writes tolerate an unsupported Windows directory fsync', async () => {
  const result = await runNode(syncFailureProbe(reviewModule, 'writeResultArtifact'));
  assert.equal(result.code, 0, result.stderr || result.stdout);
});

test('artifact identity checks do not mix handle and path stat implementations', async () => {
  const source = `
    import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { readResultArtifact, writeResultArtifact } from ${JSON.stringify(reviewModule)};
    const directory = await mkdtemp(join(tmpdir(), 'zcode-stat-'));
    const probe = await open(join(directory, 'probe'), 'a+');
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const originalStat = prototype.stat;
    prototype.stat = async function patchedStat(...args) {
      const stats = await originalStat.call(this, ...args);
      return new Proxy(stats, { get(target, property) {
        if (property === 'dev') return target.dev + 1;
        if (property === 'ino') return target.ino + 1;
        return Reflect.get(target, property);
      } });
    };
    try {
      const artifact = await writeResultArtifact({ dataRoot: directory, workspace: directory, jobId: 'b'.repeat(64), contents: 'done' });
      if (artifact !== 'results/' + 'b'.repeat(64) + '.md') throw new Error('artifact path did not persist');
      const contents = await readResultArtifact({ dataRoot: directory, workspace: directory, artifact });
      if (contents !== 'done') throw new Error('artifact contents did not read');
    } finally {
      prototype.stat = originalStat;
      await rm(directory, { recursive: true, force: true });
    }
  `;
  const result = await runNode(source);
  assert.equal(result.code, 0, result.stderr || result.stdout);
});

test('artifact writes retain handle-bound identity checks', async () => {
  const source = `
    import { mkdtemp, open, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { writeResultArtifact } from ${JSON.stringify(reviewModule)};
    const directory = await mkdtemp(join(tmpdir(), 'zcode-write-identity-'));
    const probe = await open(join(directory, 'probe'), 'a+');
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const originalStat = prototype.stat;
    let statCalls = 0;
    prototype.stat = async function patchedStat(...args) {
      const stats = await originalStat.call(this, ...args);
      statCalls += 1;
      if (statCalls !== 2) return stats;
      return new Proxy(stats, { get(target, property) {
        if (property === 'dev') return target.dev + 1;
        if (property === 'ino') return target.ino + 1;
        return Reflect.get(target, property);
      } });
    };
    try {
      await writeResultArtifact({ dataRoot: directory, workspace: directory, jobId: 'c'.repeat(64), contents: 'done' });
      throw new Error('artifact write unexpectedly accepted a destination identity mismatch');
    } catch (error) {
      if (error?.code !== 'ARTIFACT_WRITE_FAILED') throw error;
    } finally {
      prototype.stat = originalStat;
      await rm(directory, { recursive: true, force: true });
    }
  `;
  const result = await runNode(source);
  assert.equal(result.code, 0, result.stderr || result.stdout);
});

test('artifact reads retain handle-bound identity checks', async () => {
  const source = `
    import { mkdtemp, open, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { readResultArtifact, writeResultArtifact } from ${JSON.stringify(reviewModule)};
    const directory = await mkdtemp(join(tmpdir(), 'zcode-read-identity-'));
    const probe = await open(join(directory, 'probe'), 'a+');
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const artifact = await writeResultArtifact({ dataRoot: directory, workspace: directory, jobId: 'd'.repeat(64), contents: 'done' });
    const originalStat = prototype.stat;
    let statCalls = 0;
    prototype.stat = async function patchedStat(...args) {
      const stats = await originalStat.call(this, ...args);
      statCalls += 1;
      if (statCalls !== 2) return stats;
      return new Proxy(stats, { get(target, property) {
        if (property === 'dev') return target.dev + 1;
        if (property === 'ino') return target.ino + 1;
        return Reflect.get(target, property);
      } });
    };
    try {
      await readResultArtifact({ dataRoot: directory, workspace: directory, artifact });
      throw new Error('artifact read unexpectedly accepted a path identity mismatch');
    } catch (error) {
      if (error?.code !== 'RESULT_READ_FAILED') throw error;
    } finally {
      prototype.stat = originalStat;
      await rm(directory, { recursive: true, force: true });
    }
  `;
  const result = await runNode(source);
  assert.equal(result.code, 0, result.stderr || result.stdout);
});
