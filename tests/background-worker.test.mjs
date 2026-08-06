import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { startBackgroundWorker } from '../scripts/lib/background-worker.mjs';

test('background startup timeout terminates and reaps the unacknowledged worker', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-background-worker-'));
  const worker = join(directory, 'worker.mjs'); const pidFile = join(directory, 'pid');
  t.after(() => rm(directory, { force: true, recursive: true }));
  await writeFile(worker, "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.PID_FILE, String(process.pid)); setInterval(() => {}, 1000);\n");

  await assert.rejects(startBackgroundWorker({
    companionPath: worker, jobId: 'a'.repeat(64), executionCapability: 'private-capability', cwd: directory,
    env: { ...process.env, PID_FILE: pidFile }, timeoutMs: 100,
  }), { code: 'BACKGROUND_WORKER_START_TIMEOUT' });

  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('background startup schedules the production acknowledgement deadline at 30 seconds', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-background-worker-default-'));
  const worker = join(directory, 'worker.mjs'); let scheduled;
  t.after(() => rm(directory, { force: true, recursive: true }));
  await writeFile(worker, "import { writeSync } from 'node:fs'; writeSync(4, 'ready\\n'); setTimeout(() => {}, 20);\n");
  const result = await startBackgroundWorker({ companionPath: worker, jobId: 'b'.repeat(64), executionCapability: 'private-capability', cwd: directory, env: process.env,
    dependencies: { setTimeout: (callback, milliseconds) => { scheduled = milliseconds; return globalThis.setTimeout(callback, milliseconds); }, clearTimeout: (timer) => globalThis.clearTimeout(timer) } });
  assert.equal(scheduled, 30_000); assert.ok(typeof result.pid === 'number' && result.pid > 0);
});

test('background timeout consumes pipe resets during worker termination without replacing the timeout error', async () => {
  const authorization = new PassThrough(); const acknowledgements = new PassThrough(); const child = /** @type {any} */ (new EventEmitter());
  Object.assign(child, { stdio: [null, null, null, authorization, acknowledgements], exitCode: null, signalCode: null,
    kill: () => { queueMicrotask(() => { const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); acknowledgements.emit('error', reset); authorization.emit('error', reset); child.exitCode = 0; child.emit('exit', 0, null); }); return true; }, unref: () => {} });

  await assert.rejects(startBackgroundWorker({ companionPath: '/unused/worker.mjs', jobId: 'c'.repeat(64), executionCapability: 'private-capability', cwd: '/unused', timeoutMs: 10,
    dependencies: { spawn: () => child } }), { code: 'BACKGROUND_WORKER_START_TIMEOUT' });
});
