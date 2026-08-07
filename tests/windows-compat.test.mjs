import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

const fsModule = new URL('../scripts/lib/fs.mjs', import.meta.url).href;
const reviewModule = new URL('../scripts/lib/review.mjs', import.meta.url).href;

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

/** @param {string} moduleUrl @param {'atomicWriteJson'|'writeResultArtifact'} operation @returns {string} */
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
      ${operation === 'atomicWriteJson' ? "await atomicWriteJson(target, { ok: true }); if (!JSON.parse(await readFile(target, 'utf8')).ok) throw new Error('atomic write did not persist');" : "const relative = await writeResultArtifact({ dataRoot: directory, workspace: directory, jobId: 'a'.repeat(64), contents: 'done' }); if (relative !== 'results/' + 'a'.repeat(64) + '.md') throw new Error('artifact path did not persist');"}
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
