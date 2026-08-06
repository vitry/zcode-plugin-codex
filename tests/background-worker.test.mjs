import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
