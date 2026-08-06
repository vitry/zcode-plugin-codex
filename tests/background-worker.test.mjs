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
