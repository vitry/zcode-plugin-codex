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
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
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
