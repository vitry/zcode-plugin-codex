import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { startBackgroundWorker } from '../scripts/lib/background-worker.mjs';
import { terminateProcess } from '../scripts/lib/process.mjs';
import { scaleTestTimeout } from './helpers/test-timeouts.mjs';

test('background startup timeout terminates and reaps the unacknowledged worker', { timeout: scaleTestTimeout(5_000) }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-background-worker-'));
  const worker = join(directory, 'worker.mjs');
  /** @type {import('node:child_process').ChildProcess|undefined} */ let child;
  t.after(async () => {
    let terminationError;
    try {
      if (child && child.exitCode === null && child.signalCode === null) await terminateProcess(child, { graceMs: scaleTestTimeout(250) });
    } catch (error) { terminationError = error; }
    try { await rm(directory, { force: true, recursive: true }); }
    catch (error) { if (terminationError) throw new AggregateError([terminationError, error], 'background worker test cleanup failed'); throw error; }
    if (terminationError) throw terminationError;
  });
  await writeFile(worker, 'setInterval(() => {}, 1000);\n');
  let triggerDeadline = () => {}; let scheduled; let exitObserved = false;
  let markSpawned = () => {}; let rejectSpawn = () => {}; let markExited = () => {};
  const spawned = new Promise((resolve, reject) => { markSpawned = () => resolve(undefined); rejectSpawn = reject; });
  const exited = new Promise((resolve) => { markExited = () => resolve(undefined); });
  const spawnWorker = /** @type {any} */ ((/** @type {string} */ command, /** @type {string[]} */ args, /** @type {any} */ options) => {
    const exactChild = spawn(command, args, options); child = exactChild;
    exactChild.once('spawn', markSpawned);
    exactChild.once('error', rejectSpawn);
    exactChild.once('exit', () => { exitObserved = true; markExited(); });
    return exactChild;
  });

  const pending = startBackgroundWorker({
    companionPath: worker, jobId: 'a'.repeat(64), executionCapability: 'private-capability', cwd: directory,
    env: process.env, timeoutMs: 100,
    dependencies: {
      spawn: spawnWorker,
      setTimeout: (callback, milliseconds) => { triggerDeadline = callback; scheduled = milliseconds; return callback; },
      clearTimeout: () => {},
    },
  });
  const outcome = pending.then(
    (value) => ({ kind: 'fulfilled', value }),
    (error) => ({ kind: 'rejected', error }),
  );
  await spawned; assert.equal(scheduled, 100); triggerDeadline();
  await assert.rejects(pending, { code: 'BACKGROUND_WORKER_START_TIMEOUT' });
  assert.equal((await outcome).kind, 'rejected');
  assert.equal(exitObserved, true);
  await exited;
  assert.ok(child && (child.exitCode !== null || child.signalCode !== null));
});

test('background startup schedules the production acknowledgement deadline at 30 seconds', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-background-worker-default-'));
  const worker = join(directory, 'worker.mjs'); let scheduled;
  t.after(async () => { await new Promise((resolvePromise) => setTimeout(resolvePromise, 80)); await rm(directory, { force: true, recursive: true }); });
  await writeFile(worker, "import { writeSync } from 'node:fs'; writeSync(4, 'ready\\n'); setTimeout(() => {}, 20);\n");
  const result = await startBackgroundWorker({ companionPath: worker, jobId: 'b'.repeat(64), executionCapability: 'private-capability', cwd: directory, env: process.env,
    dependencies: { setTimeout: (callback, milliseconds) => { scheduled = milliseconds; return globalThis.setTimeout(callback, milliseconds); }, clearTimeout: (timer) => globalThis.clearTimeout(timer) } });
  assert.equal(scheduled, 30_000); assert.ok(typeof result.pid === 'number' && result.pid > 0);
});

test('background production launch confines capability transport to fd3 and acknowledgement to fd4', async () => {
  const executionCapability = 'capability-sentinel-only-fd3'; const jobId = 'd'.repeat(64);
  const authorization = new PassThrough(); const acknowledgements = new PassThrough(); const child = /** @type {any} */ (new EventEmitter());
  let invocation; let envelope = ''; let unrefCount = 0;
  authorization.setEncoding('utf8'); authorization.on('data', (chunk) => { envelope += chunk; });
  Object.assign(child, { stdio: [null, null, null, authorization, acknowledgements], pid: 4242, exitCode: null, signalCode: null,
    kill: () => true, unref: () => { unrefCount += 1; } });
  const spawnWorker = /** @type {any} */ ((/** @type {any} */ command, /** @type {any} */ args, /** @type {any} */ options) => { invocation = { command, args, options }; queueMicrotask(() => acknowledgements.end('ready\n')); return child; });

  const started = startBackgroundWorker({ companionPath: '/plugin/zcode-companion.mjs', jobId, executionCapability, cwd: '/workspace', env: { PUBLIC_SETTING: 'visible' },
    dependencies: { spawn: spawnWorker } });
  assert.deepEqual(await started, { pid: 4242 });

  assert.deepEqual(invocation, {
    command: process.execPath,
    args: ['/plugin/zcode-companion.mjs', 'run-reserved-job', jobId],
    options: { cwd: '/workspace', env: { PUBLIC_SETTING: 'visible', ZCODE_BACKGROUND_WORKER: '1' }, detached: true, windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  });
  assert.equal(envelope, `${JSON.stringify({ executionCapability, jobId })}\n`);
  assert.doesNotMatch(JSON.stringify(invocation), new RegExp(executionCapability));
  assert.equal(unrefCount, 1, 'the acknowledged worker must detach from the short-lived native child');
});

test('background timeout consumes pipe resets during worker termination without replacing the timeout error', async () => {
  const authorization = new PassThrough(); const acknowledgements = new PassThrough(); const child = /** @type {any} */ (new EventEmitter());
  Object.assign(child, { stdio: [null, null, null, authorization, acknowledgements], exitCode: null, signalCode: null,
    kill: () => { queueMicrotask(() => { const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); acknowledgements.emit('error', reset); authorization.emit('error', reset); child.exitCode = 0; child.emit('exit', 0, null); }); return true; }, unref: () => {} });

  await assert.rejects(startBackgroundWorker({ companionPath: '/unused/worker.mjs', jobId: 'c'.repeat(64), executionCapability: 'private-capability', cwd: '/unused', timeoutMs: 10,
    dependencies: { spawn: () => child } }), { code: 'BACKGROUND_WORKER_START_TIMEOUT' });
});
