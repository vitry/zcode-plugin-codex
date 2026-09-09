// @ts-nocheck
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { drainExitedProcessStreams, runProcess, spawnProcess, terminateProcess } from '../scripts/lib/process.mjs';
import { ZCodeClient } from '../scripts/lib/zcode-client.mjs';
import { BoundedWriter, RedactedTail, ZCodeProtocolClient } from '../scripts/lib/zcode-protocol.mjs';

const fakeFixture = fileURLToPath(new URL('./fixtures/fake-zcode-cli.mjs', import.meta.url));

async function assertProcessGone(pid) {
  for (let index = 0; index < 100; index += 1) {
    try { process.kill(pid, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); return; }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`process ${pid} remained observable after termination`);
}

function ownedPidPublicationSource(pidFile, options = {}) {
  const temporaryPidFile = `${pidFile}.tmp`;
  return `const ownedPidTemporary=${JSON.stringify(temporaryPidFile)};fs.writeFileSync(ownedPidTemporary,String(process.pid));${options.readyFile ? `fs.writeFileSync(${JSON.stringify(options.readyFile)},'ready');` : ''}${options.delayMs ? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${options.delayMs});` : ''}fs.renameSync(ownedPidTemporary,${JSON.stringify(pidFile)});`;
}

async function cleanupOwnedDescendant(directory, pidFile, options = {}) {
  const killFn = options.killFn ?? ((pid, signal) => process.kill(pid, signal));
  const waitGoneFn = options.waitGoneFn ?? assertProcessGone;
  try {
    const pidDeadline = Date.now() + 1_000; let rawPid;
    while (rawPid === undefined && Date.now() < pidDeadline) {
      rawPid = await readFile(pidFile, 'utf8').catch((error) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (rawPid === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const pid = typeof rawPid === 'string' && /^[1-9]\d*$/.test(rawPid) ? Number(rawPid) : Number.NaN;
    assert.ok(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid, 'owned descendant PID must be a safe non-self process identifier');
    const signal = (value) => {
      try { killFn(pid, value); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    };
    if (!signal('SIGTERM')) return;
    try { await waitGoneFn(pid); }
    catch {
      if (!signal('SIGKILL')) return;
      await waitGoneFn(pid);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('grace timer does not retain the caller after the child exits', async () => {
  // Windows taskkill waits for its platform-specific graceful termination
  // window, so elapsed wall time cannot distinguish an unref'ed timer from
  // the runner's process-tree teardown. Other process tests still exercise
  // the Windows termination path directly.
  if (process.platform === 'win32') return;
  const moduleUrl = new URL('../scripts/lib/process.mjs', import.meta.url).href;
  const source = `import { spawn } from 'node:child_process'; import { terminateProcess } from ${JSON.stringify(moduleUrl)}; const child=spawn(process.execPath,['-e','setInterval(()=>{},10000)']); await terminateProcess(child,{graceMs:1000});`;
  const started = Date.now();
  const runner = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: 'ignore' });
  const code = await new Promise((resolve) => runner.once('exit', resolve));
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 700, 'the cancelled grace timer must not keep the event loop alive');
});

test('runProcess fails closed on timeout and bounded output', async () => {
  await assert.rejects(runProcess({ command: process.execPath, args: ['-e', 'setInterval(()=>{},10000)'], target: process.execPath }, { timeoutMs: 20 }), { code: 'ZCODE_PROCESS_TIMEOUT' });
  await assert.rejects(
    runProcess({ command: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(4096))'], target: process.execPath }, { maxOutputBytes: 128 }),
    (error) => error.code === 'ZCODE_PROCESS_OUTPUT_LIMIT' && error.details.capturedOutputBytes <= 128,
  );
});

test('owned descendant cleanup rejects unsafe PIDs before signaling and still removes its directory', async () => {
  for (const value of ['0', '-1', '1.5', String(process.pid)]) {
    const directory = await mkdtemp(join(tmpdir(), 'zcode-process-invalid-pid-')); const pidFile = join(directory, 'descendant.pid'); const signals = [];
    await writeFile(pidFile, value);
    await assert.rejects(cleanupOwnedDescendant(directory, pidFile, { killFn: (...args) => signals.push(args) }), /owned descendant PID/);
    assert.deepEqual(signals, []);
    await assert.rejects(access(directory), { code: 'ENOENT' });
  }
});

test('owned descendant cleanup escalates a TERM-stubborn process to KILL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-process-stubborn-pid-')); const pidFile = join(directory, 'descendant.pid'); const signals = []; let waits = 0;
  await writeFile(pidFile, '424242');
  await cleanupOwnedDescendant(directory, pidFile, {
    killFn: (pid, signal) => signals.push([pid, signal]),
    waitGoneFn: async () => { waits += 1; if (waits === 1) throw new Error('still alive after TERM'); },
  });
  assert.deepEqual(signals, [[424242, 'SIGTERM'], [424242, 'SIGKILL']]);
  await assert.rejects(access(directory), { code: 'ENOENT' });
});

test('owned descendant cleanup removes its directory even when KILL cannot prove reap', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-process-failed-reap-')); const pidFile = join(directory, 'descendant.pid'); const signals = [];
  await writeFile(pidFile, '424243');
  await assert.rejects(cleanupOwnedDescendant(directory, pidFile, {
    killFn: (pid, signal) => signals.push([pid, signal]),
    waitGoneFn: async () => { throw new Error('still alive'); },
  }), /still alive/);
  assert.deepEqual(signals, [[424243, 'SIGTERM'], [424243, 'SIGKILL']]);
  await assert.rejects(access(directory), { code: 'ENOENT' });
});

test('owned descendant PID publication hides a partial temporary file until atomic rename', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-process-atomic-pid-')); const pidFile = join(directory, 'descendant.pid'); const readyFile = join(directory, 'publisher.ready');
  const source = `const fs=require('node:fs');${ownedPidPublicationSource(pidFile, { readyFile, delayMs: 75 })}setInterval(()=>{},10000);`;
  const child = spawn(process.execPath, ['-e', source], { stdio: 'ignore' });
  try {
    while (await access(readyFile).then(() => false, () => true)) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(access(pidFile), { code: 'ENOENT' });
    await cleanupOwnedDescendant(directory, pidFile);
    await assertProcessGone(child.pid);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});

test('post-exit drain waits for direct-child stream completion beyond one check turn', async () => {
  const stream = new PassThrough(); let output = '';
  stream.setEncoding('utf8'); stream.on('data', (chunk) => { output += chunk; });
  const draining = drainExitedProcessStreams([stream], 100);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  stream.end('direct-tail');
  await draining;
  assert.equal(output, 'direct-tail');
  assert.equal(stream.readableEnded, true);
});

test('runProcess captures a backpressured direct-child tail before natural exit', async () => {
  const bytes = 512 * 1024; const source = `process.stdout.write('x'.repeat(${bytes}))`;
  const result = await runProcess({ command: process.execPath, args: ['-e', source], target: process.execPath }, { timeoutMs: 2_000, maxOutputBytes: bytes + 1 });
  assert.equal(Buffer.byteLength(result.stdout), bytes);
  assert.equal(result.stdout.at(-1), 'x');
});

const INHERITED_DESCENDANT_PROCESS_TIMEOUT_MS = 2_000;
const INHERITED_DESCENDANT_TEST_TIMEOUT_MS = INHERITED_DESCENDANT_PROCESS_TIMEOUT_MS * 3;

test('runProcess flushes direct-child output without waiting for an inherited descendant pipe', { timeout: INHERITED_DESCENDANT_TEST_TIMEOUT_MS }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-process-pipe-')); const pidFile = join(directory, 'descendant.pid'); const readyFile = join(directory, 'descendant.ready');
  const descendant = `const fs=require('node:fs');${ownedPidPublicationSource(pidFile, { readyFile })}setTimeout(()=>process.stdout.write('late-descendant\\n'),100);setInterval(()=>{},10000);`;
  const source = `const {spawn}=require('node:child_process'),fs=require('node:fs');process.stdout.write('direct-child\\n');spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']}).unref();const awaitReady=()=>fs.access(${JSON.stringify(readyFile)},fs.constants.F_OK,(error)=>{if(error)setImmediate(awaitReady);});awaitReady();`;
  try {
    const result = await runProcess({ command: process.execPath, args: ['-e', source], target: process.execPath }, { timeoutMs: INHERITED_DESCENDANT_PROCESS_TIMEOUT_MS });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'direct-child\n');
  } finally { await cleanupOwnedDescendant(directory, pidFile); }
});

test('post-exit descendant overflow stops capture at the configured byte cap', { timeout: 2_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-process-overflow-')); const pidFile = join(directory, 'descendant.pid'); const readyFile = join(directory, 'descendant.ready'); const maxOutputBytes = 1_024;
  // The startup stall is longer than the production post-exit drain. Removing
  // the ready handshake therefore makes this test deterministically miss the
  // overflow, while stdin EOF proves the flood starts only after parent exit.
  const descendant = `const fs=require('node:fs');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,75);${ownedPidPublicationSource(pidFile)}fs.writeFileSync(${JSON.stringify(readyFile)},'ready');const input=Buffer.alloc(1);while(fs.readSync(0,input,0,1,null)>0){};try{fs.writeSync(1,'x'.repeat(4096));}catch{};setInterval(()=>{},10000);`;
  const source = `const {spawn}=require('node:child_process'),fs=require('node:fs');const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['pipe','inherit','inherit']});child.unref();child.stdin.unref();const awaitReady=()=>fs.access(${JSON.stringify(readyFile)},fs.constants.F_OK,(error)=>{if(error)setImmediate(awaitReady);});awaitReady();`;
  try {
    await assert.rejects(
      runProcess({ command: process.execPath, args: ['-e', source], target: process.execPath }, { timeoutMs: 500, maxOutputBytes }),
      (error) => error.code === 'ZCODE_PROCESS_OUTPUT_LIMIT' && error.details.capturedOutputBytes <= maxOutputBytes,
    );
  } finally { await cleanupOwnedDescendant(directory, pidFile); }
});

test('termination kills the spawned process group including descendants', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-tree-')); const pidFile = join(directory, 'pid');
  const source = `const {spawn}=require('node:child_process'),fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},10000);`;
  const child = await spawnProcess({ command: process.execPath, args: ['-e', source], target: process.execPath });
  let grandchildPid;
  for (let index = 0; index < 100; index += 1) { try { grandchildPid = Number(await readFile(pidFile, 'utf8')); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); } }
  assert.ok(Number.isSafeInteger(grandchildPid)); await terminateProcess(child, { graceMs: 100 });
  await assertProcessGone(grandchildPid);
  await rm(directory, { recursive: true, force: true });
});

test('async spawn errors are wrapped with the stable spawn code', async () => {
  await assert.rejects(spawnProcess({ command: '/definitely/not/a/zcode-binary', args: [] }), { code: 'ZCODE_SPAWN_FAILED' });
});

test('runProcess abort awaits termination of the entire descendant tree', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-abort-tree-')); const pidFile = join(directory, 'pid');
  const source = `const {spawn}=require('node:child_process'),fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},10000);`;
  const controller = new AbortController(); const running = runProcess({ command: process.execPath, args: ['-e', source], target: process.execPath }, { signal: controller.signal, timeoutMs: 2_000 });
  let grandchildPid; for (let index = 0; index < 100; index += 1) { try { grandchildPid = Number(await readFile(pidFile, 'utf8')); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); } }
  controller.abort(); await assert.rejects(running, { code: 'ZCODE_PROCESS_ABORTED' }); await assertProcessGone(grandchildPid); await rm(directory, { recursive: true, force: true });
});

test('bounded writer queues on backpressure, flushes on drain, and fails at its byte cap', () => {
  class FakeWritable extends EventEmitter { constructor() { super(); this.writable = true; this.writes = []; this.block = true; } write(value) { this.writes.push(value); return !this.block; } }
  const stream = new FakeWritable(); let failure; const writer = new BoundedWriter(stream, { maxQueuedBytes: 8, drainTimeoutMs: 10_000, onFailure: (error) => { failure = error; } });
  writer.write('1234'); writer.write('56'); assert.deepEqual(stream.writes, ['1234']); stream.block = false; stream.emit('drain'); assert.deepEqual(stream.writes, ['1234', '56']); writer.close();
  const blocked = new FakeWritable(); const capped = new BoundedWriter(blocked, { maxQueuedBytes: 5, onFailure: (error) => { failure = error; } }); capped.write('1234'); assert.throws(() => capped.write('56'), { code: 'ZCODE_WRITE_OVERFLOW' }); assert.equal(failure.code, 'ZCODE_WRITE_OVERFLOW');
});

test('protocol propagates a bounded write-drain window for large Transfer frames', async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = 0; child.signalCode = null;
  const protocol = new ZCodeProtocolClient(child, { drainTimeoutMs: 5_000 });
  try { assert.equal(protocol.writer.drainTimeoutMs, 5_000); } finally { await protocol.close(); }
});

test('bounded writer consumes early and late stream errors and reports failure once', () => {
  class FakeWritable extends EventEmitter { constructor() { super(); this.writable = true; } write() { return true; } }
  const stream = new FakeWritable(); const failures = [];
  const writer = new BoundedWriter(stream, { onFailure: (error) => failures.push(error) });
  stream.emit('error', Object.assign(new Error('peer closed'), { code: 'EPIPE' }));
  writer.close();
  stream.emit('error', Object.assign(new Error('late reset'), { code: 'ECONNRESET' }));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'ZCODE_DISCONNECTED');
});

test('subscriber failures are isolated and permission work cannot write after close', async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = 0; child.signalCode = null;
  const protocol = new ZCodeProtocolClient(child); const received = []; const subscriberErrors = [];
  protocol.setSubscriberErrorHandler((error) => subscriberErrors.push(error));
  protocol.subscribe(() => { throw new Error('bad subscriber'); });
  protocol.subscribe((message) => received.push(message.method));
  protocol.handleLine(JSON.stringify({ method: 'event', params: {} }));
  assert.deepEqual(received, ['event']); assert.equal(subscriberErrors.length, 1);

  protocol.beginTurn('session-1');
  let release; protocol.setPermissionHandler(() => new Promise((resolve) => { release = resolve; }));
  protocol.handleLine(JSON.stringify({ id: 99, method: 'interaction/requestPermission', params: { requestId: 'r', sessionId: 'session-1', toolCallId: 't', toolName: 'write', reason: 'test', riskLevel: 'low', input: {}, options: [{ optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny' } }] } }));
  const beforeClose = child.stdin.readableLength;
  const closing = protocol.close(); release({ decision: 'deny' }); await closing;
  assert.equal(child.stdin.readableLength, beforeClose);
});

test('observed completion leaves the turn armed and a later permission request can be allowed', async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = 0; child.signalCode = null;
  const protocol = new ZCodeProtocolClient(child);
  protocol.beginTurn('session-1'); protocol.armTurn('session-1', 1, 'input-1');
  const waiting = protocol.observeCompletion('session-1', 1_000);
  protocol.handleLine(JSON.stringify({ method: 'state.updated', params: { scope: 'session', sessionId: 'session-1', revision: 2, reason: 'prompt_completed' } }));
  assert.equal((await waiting).reason, 'prompt_completed');
  assert.equal(protocol.turnState('session-1'), 'armed');
  assert.equal(protocol.completed.get('session-1')?.length, 1, 'observation must not consume the queued completion');

  let handled = 0;
  protocol.setPermissionHandler(() => { handled += 1; return { decision: 'allow' }; });
  protocol.handleLine(JSON.stringify({ id: 99, method: 'interaction/requestPermission', params: { requestId: 'r', sessionId: 'session-1', toolCallId: 't', toolName: 'write', reason: 'test', riskLevel: 'low', input: {}, options: [{ optionId: 'allow', kind: 'allow', name: 'Allow', response: { decision: 'allow' } }, { optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny' } }] } }));
  await new Promise((resolve) => setImmediate(resolve));
  const response = JSON.parse(child.stdin.read().toString());
  assert.equal(handled, 1);
  assert.deepEqual(response, { id: 99, result: { decision: 'allow' } });
  protocol.releaseTurn('session-1');
});

test('session server-task drain waits through permission handler barriers until the response is written', async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = 0; child.signalCode = null;
  const protocol = new ZCodeProtocolClient(child);
  protocol.beginTurn('session-1'); protocol.armTurn('session-1', 1, 'input-1');
  let releaseBarrier; const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
  let enteredHandler; const handlerEntered = new Promise((resolve) => { enteredHandler = resolve; });
  protocol.setPermissionHandler(async () => { enteredHandler(); await Promise.resolve(); await barrier; await Promise.resolve(); return { decision: 'deny' }; });
  protocol.handleLine(JSON.stringify({ id: 99, method: 'interaction/requestPermission', params: { requestId: 'r', sessionId: 'session-1', toolCallId: 't', toolName: 'write', reason: 'test', riskLevel: 'low', input: {}, options: [{ optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny' } }] } }));
  await handlerEntered;
  let drained = false; const draining = protocol.drainServerTasksForSession('session-1').then(() => { drained = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  assert.equal(child.stdin.readableLength, 0);
  releaseBarrier(); await draining;
  assert.equal(drained, true);
  assert.deepEqual(JSON.parse(child.stdin.read().toString()), { id: 99, result: { decision: 'deny' } });
  protocol.releaseTurn('session-1');
});

test('session server-task drain reaches a fixed point when a second request arrives mid-drain', async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = 0; child.signalCode = null;
  const protocol = new ZCodeProtocolClient(child); protocol.beginTurn('session-1'); protocol.armTurn('session-1', 1, 'input-1');
  const barriers = []; const entered = []; let handlerCount = 0;
  protocol.setPermissionHandler(async () => { const index = handlerCount++; let release; const barrier = new Promise((resolve) => { release = resolve; }); barriers[index] = release; entered[index]?.(); await barrier; return { decision: 'deny' }; });
  const waitForEntry = (index) => new Promise((resolve) => { entered[index] = resolve; });
  const firstEntered = waitForEntry(0); protocol.handleLine(JSON.stringify({ id: 101, method: 'interaction/requestPermission', params: { requestId: 'r1', sessionId: 'session-1', toolCallId: 't1', toolName: 'write', reason: 'test', riskLevel: 'low', input: {}, options: [{ optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny' } }] } })); await firstEntered;
  let drained = false; const draining = protocol.drainServerTasksForSession('session-1').then(() => { drained = true; });
  const secondEntered = waitForEntry(1); protocol.handleLine(JSON.stringify({ id: 102, method: 'interaction/requestPermission', params: { requestId: 'r2', sessionId: 'session-1', toolCallId: 't2', toolName: 'write', reason: 'test', riskLevel: 'low', input: {}, options: [{ optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny' } }] } })); await secondEntered;
  barriers[0](); await new Promise((resolve) => setImmediate(resolve)); assert.equal(drained, false, 'a request entering during drain must join the same fixed point');
  barriers[1](); await draining; assert.equal(drained, true);
  protocol.releaseTurn('session-1');
});

test('broker terminal observer leaves no completion queue or expiry and observes early arm completion', () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = 0; child.signalCode = null;
  const protocol = new ZCodeProtocolClient(child); const observed = [];
  protocol.observeTerminalsWith((params, turn) => observed.push({ params, turn }));
  protocol.beginTurn('session-1');
  protocol.handleLine(JSON.stringify({ method: 'state.updated', params: { scope: 'session', sessionId: 'session-1', revision: 2, reason: 'prompt_completed' } }));
  protocol.armTurn('session-1', 1, 'input-1');
  assert.equal(observed.length, 1); assert.equal(observed[0].turn.inputId, 'input-1');
  assert.equal(protocol.turnState('session-1'), 'armed'); assert.equal(protocol.completed.size, 0); assert.equal(protocol.completionExpiry.size, 0); assert.equal(protocol.earlyCompletions.size, 0);
  protocol.releaseTurn('session-1');
});

test('permission request accepts the captured 0.16.5 requestedAt timestamp', async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = 0; child.signalCode = null;
  const protocol = new ZCodeProtocolClient(child); let handled = 0;
  protocol.beginTurn('session-1'); protocol.armTurn('session-1', 1, 'input-1');
  protocol.setPermissionHandler(() => { handled += 1; return { decision: 'allow' }; });
  protocol.handleLine(JSON.stringify({ id: 99, method: 'interaction/requestPermission', params: { requestId: 'permission-99', sessionId: 'session-1', toolCallId: 'tool-1', toolName: 'write', reason: 'captured 0.16.5 fixture', riskLevel: 'medium', input: { path: 'README.md' }, options: [{ optionId: 'allow', kind: 'allow', name: 'Allow', response: { decision: 'allow' } }, { optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny' } }], requestedAt: 1_786_233_601_742 } }));
  await new Promise((resolve) => setImmediate(resolve));
  const response = JSON.parse(child.stdin.read().toString());
  assert.deepEqual({ handled, response }, { handled: 1, response: { id: 99, result: { decision: 'allow' } } });
  protocol.releaseTurn('session-1');
});

test('permission request rejects malformed requestedAt without invoking the handler', async () => {
  for (const requestedAt of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1786233601742']) {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = 0; child.signalCode = null;
    const protocol = new ZCodeProtocolClient(child); let handled = 0;
    protocol.beginTurn('session-1'); protocol.armTurn('session-1', 1, 'input-1');
    protocol.setPermissionHandler(() => { handled += 1; return { decision: 'allow' }; });
    protocol.handleLine(JSON.stringify({ id: 99, method: 'interaction/requestPermission', params: { requestId: 'permission-99', sessionId: 'session-1', toolCallId: 'tool-1', toolName: 'write', reason: 'captured 0.16.5 fixture', riskLevel: 'medium', input: {}, options: [{ optionId: 'allow', kind: 'allow', name: 'Allow', response: { decision: 'allow' } }, { optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny' } }], requestedAt } }));
    await new Promise((resolve) => setImmediate(resolve));
    const response = JSON.parse(child.stdin.read().toString());
    assert.equal(handled, 0, String(requestedAt));
    assert.equal(response.id, 99);
    assert.equal(response.result, undefined);
    assert.equal(response.error?.code, -32000);
    protocol.releaseTurn('session-1');
  }
});

test('completion observer timeout unregisters without ending the active turn', async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = 0; child.signalCode = null;
  const protocol = new ZCodeProtocolClient(child);
  protocol.beginTurn('session-1'); protocol.armTurn('session-1', 1, 'input-1');
  await assert.rejects(protocol.observeCompletion('session-1', 10), { code: 'ZCODE_COMPLETION_TIMEOUT' });
  assert.equal(protocol.turnState('session-1'), 'armed');
  assert.equal(protocol.completionWaiters.size, 0);
  assert.equal(protocol.waiterSessions.size, 0);
  assert.equal(protocol.subscribers.size, 0);
  protocol.releaseTurn('session-1');
});

test('releaseTurn is local and idempotent and rejects a pending observer', async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = 0; child.signalCode = null;
  const protocol = new ZCodeProtocolClient(child); const client = new ZCodeClient(protocol, '/repo');
  protocol.beginTurn('session-1'); protocol.armTurn('session-1', 1, 'input-1');
  const waiting = client.observeCompletion('session-1');
  assert.equal(child.stdin.readableLength, 0);
  client.releaseTurn('session-1'); client.releaseTurn('session-1');
  await assert.rejects(waiting, { code: 'ZCODE_SESSION_STOPPED' });
  assert.equal(client.turnState('session-1'), null);
  assert.equal(protocol.completionWaiters.size, 0);
  assert.equal(protocol.waiterSessions.size, 0);
  assert.equal(protocol.subscribers.size, 0);
  assert.equal(child.stdin.readableLength, 0, 'local release must not send an upstream RPC');
  for (const invalid of ['', 'bad\nsession', null]) {
    await assert.rejects(client.observeCompletion(invalid), { code: 'ZCODE_PROTOCOL_INPUT_INVALID' });
    assert.throws(() => client.releaseTurn(invalid), { code: 'ZCODE_INPUT_INVALID' });
  }
});

test('releaseTurn aborts and clears permission task state without writing a stale response', async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = 0; child.signalCode = null;
  const protocol = new ZCodeProtocolClient(child);
  protocol.beginTurn('session-1'); protocol.armTurn('session-1', 1, 'input-1');
  let handlerSignal;
  protocol.setPermissionHandler((_request, signal) => {
    handlerSignal = signal;
    return new Promise(() => {});
  });
  protocol.handleLine(JSON.stringify({ id: 99, method: 'interaction/requestPermission', params: { requestId: 'r', sessionId: 'session-1', toolCallId: 't', toolName: 'write', reason: 'test', riskLevel: 'low', input: {}, options: [{ optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny' } }] } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(protocol.permissionRequestIds.size, 1);
  assert.equal(protocol.serverTaskSessions.size, 1);
  protocol.releaseTurn('session-1');
  assert.equal(handlerSignal.aborted, true);
  assert.equal(protocol.permissionRequestIds.size, 0);
  assert.equal(protocol.serverTaskSessions.size, 0);
  assert.equal(protocol.serverTaskControllers.size, 0);
  assert.equal(protocol.serverTasks.size, 0);
  assert.equal(child.stdin.readableLength, 0);
});

test('completion expiry cancels pending permission tasks before late resolution or rejection', async () => {
  for (const outcome of ['resolve', 'reject']) {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = 0; child.signalCode = null;
    const protocol = new ZCodeProtocolClient(child); const failures = [];
    protocol.setCloseHandler((error) => failures.push(error));
    protocol.beginTurn('session-1'); protocol.armTurn('session-1', 1, 'input-1');
    const observed = protocol.observeCompletion('session-1');
    const originalSetTimeout = globalThis.setTimeout; let expire;
    globalThis.setTimeout = (callback, timeoutMs, ...args) => {
      if (timeoutMs === 10 * 60_000) { expire = () => callback(...args); return { unref() {} }; }
      return originalSetTimeout(callback, timeoutMs, ...args);
    };
    try { protocol.handleLine(JSON.stringify({ method: 'state.updated', params: { scope: 'session', sessionId: 'session-1', revision: 2, reason: 'prompt_completed' } })); }
    finally { globalThis.setTimeout = originalSetTimeout; }
    await observed;
    assert.equal(typeof expire, 'function');

    let handlerSignal; let settle;
    protocol.setPermissionHandler((_request, signal) => {
      handlerSignal = signal;
      return new Promise((resolve, reject) => { settle = outcome === 'resolve' ? () => resolve({ decision: 'deny' }) : () => reject(new Error('late rejection')); });
    });
    protocol.handleLine(JSON.stringify({ id: 99, method: 'interaction/requestPermission', params: { requestId: 'r', sessionId: 'session-1', toolCallId: 't', toolName: 'write', reason: 'test', riskLevel: 'low', input: {}, options: [{ optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny' } }] } }));
    await new Promise((resolve) => setImmediate(resolve));
    expire();
    assert.equal(handlerSignal.aborted, true, outcome);
    assert.equal(protocol.turnState('session-1'), null, outcome);
    for (const collection of [protocol.serverTasks, protocol.serverTaskControllers, protocol.serverTaskSessions, protocol.serverTasksByController, protocol.permissionRequestIds]) assert.equal(collection.size, 0, outcome);
    settle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(child.stdin.readableLength, 0, outcome);
    assert.equal(protocol.closed, false, outcome);
    assert.deepEqual(failures, [], outcome);
  }
});

test('ordinary completion waiting remains destructive', async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = 0; child.signalCode = null;
  const protocol = new ZCodeProtocolClient(child);
  protocol.beginTurn('session-1'); protocol.armTurn('session-1', 1, 'input-1');
  const waiting = protocol.waitForCompletion('session-1', 1_000);
  protocol.handleLine(JSON.stringify({ method: 'state.updated', params: { scope: 'session', sessionId: 'session-1', revision: 2, reason: 'prompt_completed' } }));
  assert.equal((await waiting).reason, 'prompt_completed');
  assert.equal(protocol.turnState('session-1'), null);
  assert.equal(protocol.completed.has('session-1'), false);
});

test('close aborts and detaches a never-settling permission task under strict rejections', async () => {
  const protocolUrl = new URL('../scripts/lib/zcode-protocol.mjs', import.meta.url).href;
  const source = `
    import assert from 'node:assert/strict';
    import { spawn } from 'node:child_process';
    import { ZCodeProtocolClient } from ${JSON.stringify(protocolUrl)};
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const protocol = new ZCodeProtocolClient(child);
    protocol.beginTurn('session-1');
    const handlerSignals = [];
    protocol.setPermissionHandler((_request, signal) => {
      const index = handlerSignals.push(signal) - 1;
      if (index === 0) return new Promise(() => {});
      if (index === 1) return new Promise((resolve) => signal.addEventListener('abort', () => setImmediate(() => resolve({ decision: 'deny' })), { once: true }));
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => setImmediate(() => reject(new Error('late rejection'))), { once: true }));
    });
    const request = (id) => ({ id, method: 'interaction/requestPermission', params: { requestId: 'r-' + id, sessionId: 'session-1', toolCallId: 't-' + id, toolName: 'write', reason: 'test', riskLevel: 'low', input: {}, options: [{ optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny' } }] } });
    for (const id of [99, 100, 101]) protocol.handleLine(JSON.stringify(request(id)));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(handlerSignals.length, 3);
    assert.ok(handlerSignals.every((signal) => signal instanceof AbortSignal));
    const beforeClose = child.stdin.readableLength;
    const started = Date.now();
    const firstClose = protocol.close();
    const secondClose = protocol.close();
    assert.equal(firstClose, secondClose);
    await firstClose;
    const elapsedMs = Date.now() - started;
    assert.ok(elapsedMs <= (process.platform === 'win32' ? 2_000 : 200), 'close took ' + elapsedMs + 'ms');
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(handlerSignals.every((signal) => signal.aborted));
    assert.equal(protocol.serverTasks.size, 0);
    for (const map of [protocol.pending, protocol.completed, protocol.completionExpiry, protocol.turns, protocol.earlyCompletions, protocol.permissionRequestIds]) assert.equal(map.size, 0);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(child.stdin.readableLength, beforeClose);
  `;
  const runner = spawn(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  runner.stderr.setEncoding('utf8'); runner.stderr.on('data', (chunk) => { stderr += chunk; });
  const outcome = await Promise.race([
    new Promise((resolve) => runner.once('exit', (code, signal) => resolve({ code, signal }))),
    new Promise((resolve) => { const timer = setTimeout(() => resolve({ timeout: true }), process.platform === 'win32' ? 5_000 : 1_000); timer.unref(); }),
  ]);
  if (outcome.timeout) runner.kill('SIGKILL');
  assert.deepEqual(outcome, { code: 0, signal: null }, stderr || 'strict child did not finish');
});

test('stderr tail redacts complete cross-chunk lines and retains ordinary diagnostics', () => {
  const tail = new RedactedTail(4096);
  tail.append('ordinary diagnostic retained\n"author');
  tail.append('ization": "cross-chunk-secret"\nOPENAI_API_');
  tail.append('KEY = env-secret\n{"auth":"auth-secret","cookie":"cookie-secret","token":"token-secret","api_key":"snake-secret","apiKey":"camel-secret","SECRET":"secret-secret","password":"password-secret"}\n');
  tail.append('ZCODE_TOKEN space-secret\nCUSTOM_TOKEN=custom-secret\nCUSTOM_API_KEY: custom-api-secret\nCLIENT_SECRET=client-secret\nDATABASE_PASSWORD=correct horse battery staple\nBearer bearer-secret\nBasic basic-secret\n');
  tail.close();
  const value = tail.value();
  for (const secret of ['cross-chunk-secret', 'env-secret', 'auth-secret', 'cookie-secret', 'token-secret', 'snake-secret', 'camel-secret', 'secret-secret', 'password-secret', 'space-secret', 'custom-secret', 'custom-api-secret', 'client-secret', 'correct horse battery staple', 'bearer-secret', 'basic-secret']) assert.ok(!value.includes(secret), secret);
  assert.match(value, /ordinary diagnostic retained/);
  assert.match(value, /\[REDACTED\]/);
});

test('stderr tail omits an oversized line and flushes a safe unterminated line on close', () => {
  const tail = new RedactedTail(256, 64);
  tail.append(`ZCODE_TOKEN=${'oversized-secret'.repeat(100)}`);
  tail.append('\nordinary final diagnostic token=final-secret');
  tail.close();
  const value = tail.value();
  assert.ok(Buffer.byteLength(value) <= 256);
  assert.equal(value.match(/\[oversized stderr line omitted\]/g)?.length, 1);
  assert.ok(!value.includes('oversized-secret'));
  assert.ok(!value.includes('final-secret'));
  assert.match(value, /ordinary final diagnostic/);
});

test('fake peer stop cancels the pending completion before acknowledging stop', async () => {
  const peer = spawn(process.execPath, [fakeFixture], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  peer.stdout.setEncoding('utf8'); peer.stdout.on('data', (chunk) => { stdout += chunk; });
  peer.stderr.setEncoding('utf8'); peer.stderr.on('data', (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => { peer.once('spawn', resolve); peer.once('error', reject); });
  peer.stdin.end(`${JSON.stringify({ id: 1, method: 'session/send', params: { sessionId: 'stop-session', inputId: 'input-1' } })}\n${JSON.stringify({ id: 2, method: 'session/stop', params: { sessionId: 'stop-session' } })}\n`);
  const code = await new Promise((resolve) => peer.once('exit', resolve));
  assert.equal(code, 0, stderr);
  const frames = stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.deepEqual(frames.map((frame) => frame.id), [1, 2]);
  assert.equal(frames.some((frame) => frame.method === 'state.updated'), false);
});

test('fake peer completion waits for the exact progress-dispatch gate nonce', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-progress-dispatch-gate-'));
  const gate = join(directory, 'gate.json'); const reached = join(directory, 'reached.json');
  const nonce = 'a'.repeat(64); const staleNonce = 'b'.repeat(64);
  await writeFile(gate, JSON.stringify({ version: 1, nonce, state: 'held' }));
  const peer = spawn(process.execPath, [fakeFixture], {
    env: { ...process.env, FAKE_ZCODE_PROGRESS_DISPATCH_GATE: gate, FAKE_ZCODE_PROGRESS_DISPATCH_GATE_NONCE: nonce, FAKE_ZCODE_PROGRESS_DISPATCH_GATE_REACHED: reached, FAKE_ZCODE_COMPLETION_DELAY_MS: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  peer.stdout.setEncoding('utf8'); peer.stdout.on('data', (chunk) => { stdout += chunk; });
  peer.stderr.setEncoding('utf8'); peer.stderr.on('data', (chunk) => { stderr += chunk; });
  const waitForGateChecks = async (minimum) => {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const value = await readFile(reached, 'utf8').then(JSON.parse).catch(() => null);
      if (value?.version === 1 && value.nonce === nonce && value.checks >= minimum) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`fake progress gate did not reach check ${minimum}`);
  };
  const waitForCompletion = async () => {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (stdout.includes('"method":"state.updated"')) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail('fake progress gate never released completion');
  };
  try {
    await new Promise((resolve, reject) => { peer.once('spawn', resolve); peer.once('error', reject); });
    peer.stdin.write(`${JSON.stringify({ id: 1, method: 'session/send', params: { sessionId: 'progress-gate-session', inputId: 'input-1' } })}\n`);
    await waitForGateChecks(1); assert.equal(stdout.includes('"method":"state.updated"'), false);
    await writeFile(gate, JSON.stringify({ version: 1, nonce: staleNonce, state: 'release' }));
    await waitForGateChecks(2); assert.equal(stdout.includes('"method":"state.updated"'), false);
    await writeFile(gate, JSON.stringify({ version: 1, nonce, state: 'release' }));
    await waitForCompletion(); peer.stdin.end();
    assert.equal(await new Promise((resolve) => peer.once('exit', resolve)), 0, stderr);
  } finally {
    if (peer.exitCode === null && peer.signalCode === null) peer.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});

test('boundedProcessKill abandons a stalled termination command at its bound alone', async () => {
  const { boundedProcessKill } = await import('../scripts/lib/process.mjs');
  const sleeper = ['-e', 'setTimeout(() => {}, 30000)'];
  let started = Date.now();
  await boundedProcessKill(process.execPath, sleeper, { timeoutMs: 150 });
  assert.ok(Date.now() - started < 1_500, `a stalled command is killed at its bound instead of awaited (took ${Date.now() - started}ms)`);
  started = Date.now();
  await boundedProcessKill(process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: 2_000 });
  assert.ok(Date.now() - started < 1_500, 'an exiting command completes without waiting for its bound');
});

test('boundedProcessKill resolves a structured outcome distinguishing success, already-gone, spawn failure, nonzero exit, and timeout', async () => {
  const { boundedProcessKill } = await import('../scripts/lib/process.mjs');
  const completed = await boundedProcessKill(process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: 2_000 });
  assert.deepEqual(completed, { ok: true, exitCode: 0 }, 'a clean exit resolves a dispatched-success outcome');
  const alreadyGone = await boundedProcessKill(process.execPath, ['-e', 'process.exit(128)'], { timeoutMs: 2_000 });
  assert.deepEqual(alreadyGone, { ok: true, reason: 'already-gone', exitCode: 128 }, 'taskkill exit 128 (the process not found) is the already-dead success convention');
  const denied = await boundedProcessKill(process.execPath, ['-e', 'process.exit(1)'], { timeoutMs: 2_000 });
  assert.deepEqual(denied, { ok: false, reason: 'exit-code', exitCode: 1 }, 'a nonzero exit such as access-denied is a FAILED dispatch — the target may survive');
  const spawnError = await boundedProcessKill('zcode-missing-termination-tool', [], { timeoutMs: 2_000 });
  assert.deepEqual(spawnError, { ok: false, reason: 'spawn-error', exitCode: null }, 'a tool that never launches is a FAILED dispatch');
  const stalled = await boundedProcessKill(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 150 });
  assert.deepEqual(stalled, { ok: false, reason: 'timeout', exitCode: null }, 'a tool killed at its bound is a FAILED dispatch — whether the signal landed is unknowable');
});

test('terminateRecordedProcessTree SIGKILLs the recorded group when the leader exits but a descendant survives', { skip: process.platform === 'win32' ? 'POSIX process-group addressing only.' : false }, async () => {
  const { terminateRecordedProcessTree } = await import('../scripts/lib/process.mjs');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'tree-group-'));
  const pidFile = join(directory, 'descendant.pid');
  const script = `${process.execPath} -e "process.on('SIGTERM', () => {}); setInterval(() => {}, 250)" >/dev/null 2>&1 & echo $! > '${pidFile}'; sleep 30`;
  const leader = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('descendant pid never recorded')), 2_000);
      leader.once('exit', () => { clearTimeout(timer); resolve(); });
      const poll = setInterval(async () => {
        try { await readFile(pidFile, 'utf8'); clearInterval(poll); clearTimeout(timer); resolve(); } catch { /* not yet */ }
      }, 25);
    });
    const descendantPid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    await terminateRecordedProcessTree(leader.pid, { graceMs: 300 });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try { process.kill(descendantPid, 0); await new Promise((resolve) => setTimeout(resolve, 50)); }
      catch { await rm(directory, { recursive: true, force: true }); return; }
    }
    assert.fail('a SIGTERM-immune descendant must not survive its recorded group termination');
  } finally {
    if (leader.exitCode === null && leader.signalCode === null) { try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* gone */ } }
    await rm(directory, { recursive: true, force: true });
  }
});

/** Override the host platform for one Windows-branch unit test; the override
 * is restored in a finally-style hook on every outcome. The win32 branch stays
 * platform-gated in production, so the override is the only way to drive it on
 * a macOS/Linux test host (native Windows CI asserts the real tooling). */
function withWindowsPlatform(run) {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  return Promise.resolve().then(run).finally(() => {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  });
}

/** A real live process stands in for the recorded runner so the branch's
 * liveness probes observe a killable pid without any Windows tooling. */
async function withLiveRunnerPid(run) {
  const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30);'], { stdio: 'ignore', shell: false });
  try {
    assert.ok(Number.isSafeInteger(runner.pid) && runner.pid > 0, 'the stand-in runner must be live');
    return await run(runner.pid);
  } finally {
    try { runner.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/** A process-table snapshot in the record shape: [pid, ppid, commandLine]
 * triples — each live process's recorded parent pid and its creation-fixed
 * launch command line (null when the snapshot could not read it). */
function processSnapshot(entries) {
  return new Map(entries.map(([pid, ppid, commandLine]) => [pid, { ppid, commandLine }]));
}

const BROKER_LAUNCH = { command: 'C:\\Tools\\node.exe', args: ['C:\\ws\\broker\\zcode-broker.mjs', 'C:\\ws\\broker\\config-abc.json'] };
const BROKER_COMMAND_LINE = `${BROKER_LAUNCH.command} ${BROKER_LAUNCH.args.join(' ')}`;

test('windowsDescendantKillTargets prunes only the identity-matched broker subtree and keeps the runner first', async () => {
  const { windowsDescendantKillTargets } = await import('../scripts/lib/process.mjs');
  const table = processSnapshot([
    [100, 4, 'C:\\Tools\\node.exe runner.mjs'], // the runner
    [111, 100, BROKER_COMMAND_LINE], // the broker under the runner
    [222, 100, 'C:\\Tools\\version-check.exe --wait'], // a version-check child under the runner
    [333, 111, 'C:\\Tools\\node.exe C:\\ws\\broker\\engine.js'], // the engine lives under the broker
    [444, 333, 'C:\\Tools\\node.exe C:\\ws\\broker\\engine-worker.js'], // a grandchild under the engine
  ]);
  assert.deepEqual(windowsDescendantKillTargets(100, table, [{ pid: 111, ...BROKER_LAUNCH }]), [100, 222], 'identity-matched broker subtree pruned, runner and other descendants kept, runner first');
  assert.deepEqual(windowsDescendantKillTargets(100, table, []), [100, 111, 333, 444, 222], 'without exclusions the whole descendant tree is planned (depth-first)');

  // F2: a recorded broker pid whose live command line does NOT match the
  // recorded launch signature is never excluded, even though it holds the
  // recorded pid — the pid number alone is not broker identity evidence.
  const stale = new Map(table);
  stale.set(111, { ppid: 100, commandLine: 'C:\\Windows\\unrelated.exe --not-a-broker' });
  assert.deepEqual(windowsDescendantKillTargets(100, stale, [{ pid: 111, ...BROKER_LAUNCH }]), [100, 111, 333, 444, 222], 'a reused pid holding a recorded broker number with a foreign command line is never excluded');
  const hidden = new Map(table);
  hidden.set(111, { ppid: 100, commandLine: null });
  assert.deepEqual(windowsDescendantKillTargets(100, hidden, [{ pid: 111, ...BROKER_LAUNCH }]), [100, 111, 333, 444, 222], 'a recorded broker pid with an unreadable command line is not proven to be the broker');
  const gone = new Map(table);
  gone.delete(111);
  assert.deepEqual(windowsDescendantKillTargets(100, gone, [{ pid: 111, ...BROKER_LAUNCH }]), [100, 222], 'an absent pid excludes nothing — its subtree is not alive under this snapshot and the walk never reaches it');

  // Quoting robustness: command tokens with spaces must still match the
  // recorded launch signature at the argv level.
  const quoted = processSnapshot([
    [100, 4, 'C:\\Tools\\node.exe runner.mjs'],
    [111, 100, '"C:\\Program Files\\nodejs\\node.exe" C:\\ws\\broker\\zcode-broker.mjs C:\\ws\\broker\\config-abc.json'],
  ]);
  assert.deepEqual(
    windowsDescendantKillTargets(100, quoted, [{ pid: 111, command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\ws\\broker\\zcode-broker.mjs', 'C:\\ws\\broker\\config-abc.json'] }]),
    [100],
    'a quoted executable token with spaces matches the recorded launch signature',
  );

  const cyclic = processSnapshot([[100, 111, 'C:\\Tools\\node.exe runner.mjs'], [111, 100, BROKER_COMMAND_LINE]]); // a reused-pid cycle in the snapshot
  assert.deepEqual(windowsDescendantKillTargets(100, cyclic, []), [100, 111], 'a cyclic snapshot terminates the walk');
  assert.deepEqual(windowsDescendantKillTargets(100, cyclic, [{ pid: 111, ...BROKER_LAUNCH }]), [100], 'a cycle rooted at the identity-matched exclusion is pruned entirely');
  assert.deepEqual(windowsDescendantKillTargets(100, processSnapshot([]), []), [100], 'an empty snapshot still plans the runner');
  assert.deepEqual(windowsDescendantKillTargets(100, table, [], { excludeUnknown: true }), [100], 'a failed broker lookup plans only the recorded pid even with an empty exclusion list');
  assert.deepEqual(windowsDescendantKillTargets(100, table, [{ pid: 111, ...BROKER_LAUNCH }], { excludeUnknown: true }), [100], 'the lookup-failed marker outranks any supplied exclusion list');
  assert.deepEqual(windowsDescendantKillTargets(100, table, [{ pid: 111, command: '', args: [] }]), [100], 'a malformed exclusion entry proves nothing and plans the recorded pid alone');
  assert.deepEqual(windowsDescendantKillTargets(100, table, [{ pid: 100, command: BROKER_LAUNCH.command, args: [] }]), [100], 'an exclusion naming the runner itself fails closed to the recorded pid alone');
});

test('readWindowsProcessTable fails closed to null where no Windows tooling exists', { skip: process.platform === 'win32' ? 'real enumeration is asserted on native Windows CI.' : false }, async () => {
  const { readWindowsProcessTable } = await import('../scripts/lib/process.mjs');
  assert.equal(await readWindowsProcessTable(250), null, 'a failed spawn (no powershell on this host) resolves null, the fail-closed signal');
  assert.equal(await readWindowsProcessTable(0), null, 'a non-positive bound resolves null before spawning');
});

/** A fully scripted process-table tool child: EventEmitter stdout whose events
 * fire in exactly the order the test emits them, so the exit/drain ordering
 * can be staged deterministically on any host platform. */
function scriptedProcessTableChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.destroyed = false;
  child.stdout.setEncoding = () => child.stdout;
  child.stdout.destroy = () => { if (!child.stdout.destroyed) { child.stdout.destroyed = true; child.stdout.emit('close'); } };
  child.signals = [];
  child.kill = (signal) => { child.signals.push(signal ?? 'SIGTERM'); return true; };
  child.unref = () => {};
  return child;
}

test('readWindowsProcessTable parses only after piped stdout closes, never from an exit that beat the drain', async () => {
  const { readWindowsProcessTable } = await import('../scripts/lib/process.mjs');
  const child = scriptedProcessTableChild();
  const spawnCalls = [];
  let settled = false;
  let outcome;
  const pending = readWindowsProcessTable(5_000, {
    spawnProcessTableTool: (...arguments_) => { spawnCalls.push(arguments_); return child; },
  });
  void pending.then((value) => { settled = true; outcome = value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawnCalls.length, 1, 'the enumeration tool is spawned through the production wiring');
  // The full table bytes arrive, then the child exits BEFORE its piped stdout
  // has drained — the ordering Windows can produce and the old exit-event
  // parse raced (and lost).
  child.stdout.emit('data', '{"ppid":"4","pid":"111","commandLine":null}\n');
  child.emit('exit', 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'an exit ahead of the drain must not publish a snapshot built from a partially drained stream');
  child.stdout.emit('end');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'the readable end alone is not the drain signal — parsing waits for close');
  child.stdout.emit('close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, true, 'the stdout close is the drained signal that releases the parse');
  assert.deepEqual([...outcome.entries()], [[111, { ppid: 4, commandLine: null }]], 'the snapshot is parsed from the fully drained stdout');
  assert.deepEqual(child.signals, [], 'a cleanly drained snapshot never escalates to a kill');
  await pending;
});

test('readWindowsProcessTable forces UTF-8 stdout encoding as the first script statement, before any output emission', async () => {
  const { readWindowsProcessTable } = await import('../scripts/lib/process.mjs');
  const child = scriptedProcessTableChild();
  const spawnCalls = [];
  const pending = readWindowsProcessTable(5_000, {
    spawnProcessTableTool: (...arguments_) => { spawnCalls.push(arguments_); return child; },
  });
  child.stdout.emit('data', '{"ppid":"4","pid":"111","commandLine":null}\n');
  child.emit('exit', 0, null);
  child.stdout.emit('end');
  child.stdout.emit('close');
  await pending;
  assert.equal(spawnCalls.length, 1, 'the enumeration tool is spawned exactly once');
  assert.equal(spawnCalls[0][0], 'powershell.exe');
  assert.deepEqual(spawnCalls[0][1].slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  const script = spawnCalls[0][1][3];
  const encodingStatement = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;';
  assert.equal(script.startsWith(encodingStatement), true,
    'the UTF-8 output encoding statement is the FIRST statement: redirected PowerShell stdout decodes through the active code page on Windows PowerShell 5.1, so non-ASCII command lines (Node, plugin, or config paths) would be garbled before the UTF-8 stream decode');
  assert.ok(script.indexOf('Get-CimInstance') > script.indexOf(encodingStatement),
    'the encoding is set before the process table is even queried, let alone emitted');
  assert.ok(script.indexOf('ConvertTo-Json') > script.indexOf(encodingStatement),
    'the encoding is set before ConvertTo-Json emits any row');
});

test('readWindowsProcessTable keeps the overall bound enforced while waiting for the drained stdout', async () => {
  const { readWindowsProcessTable } = await import('../scripts/lib/process.mjs');
  const child = scriptedProcessTableChild();
  const started = Date.now();
  const processTable = await readWindowsProcessTable(75, { spawnProcessTableTool: () => child });
  const elapsedMs = Date.now() - started;
  assert.equal(processTable, null, 'a child that never drains still resolves the fail-closed null');
  assert.ok(child.signals.length >= 1, 'the stalled enumeration tool is killed at its bound');
  assert.ok(elapsedMs < 2_000, `the bound expired on time (${elapsedMs}ms) instead of awaiting the undrained stream`);
});

test('readWindowsProcessTable fails closed to null when any non-empty row fails to parse', async () => {
  const { readWindowsProcessTable } = await import('../scripts/lib/process.mjs');
  const child = scriptedProcessTableChild();
  const pending = readWindowsProcessTable(5_000, { spawnProcessTableTool: () => child });
  // One valid row plus ONE malformed non-empty row — the truncation or garbage
  // PowerShell can interleave with valid rows. Silently skipping it would
  // publish a PARTIAL table whose missing parent-child edge strands a
  // runner-owned descendant alive after cancellation.
  child.stdout.emit('data', '{"ppid":"4","pid":"111","commandLine":null}\ntruncated-row-without-pid\n');
  child.emit('exit', 0, null);
  child.stdout.emit('end');
  child.stdout.emit('close');
  const processTable = await pending;
  assert.equal(processTable, null, 'a malformed non-empty row invalidates the ENTIRE snapshot (fail-closed null), never a partial table');
});

test('readWindowsProcessTable fails closed on a well-formed JSON row with an unusable identity payload', async () => {
  const { readWindowsProcessTable } = await import('../scripts/lib/process.mjs');
  for (const row of [
    '"just a string"', // not an object
    '{"ppid":4,"pid":"111","commandLine":null}', // numeric ppid where the digit-string contract is required
    '{"ppid":"4","pid":"111","commandLine":42}', // a command line that is neither a string nor null
    '{"ppid":"4","commandLine":null}', // a row without a pid
    '{"ppid":"4","pid":"111","commandLine":null}\n{"ppid":"4","pid":"111","commandLine":"duplicate"}', // a duplicated pid row
  ]) {
    const child = scriptedProcessTableChild();
    const pending = readWindowsProcessTable(5_000, { spawnProcessTableTool: () => child });
    child.stdout.emit('data', `${row}\n`);
    child.emit('exit', 0, null);
    child.stdout.emit('end');
    child.stdout.emit('close');
    assert.equal(await pending, null, `a corrupt identity row must reject the whole snapshot: ${row}`);
  }
});

test('readWindowsProcessTable still parses all-valid rows and skips only whitespace-only lines', async () => {
  const { readWindowsProcessTable } = await import('../scripts/lib/process.mjs');
  const validChild = scriptedProcessTableChild();
  const validPending = readWindowsProcessTable(5_000, { spawnProcessTableTool: () => validChild });
  validChild.stdout.emit('data', '{"ppid":"4","pid":"100","commandLine":"C:\\\\Tools\\\\node.exe runner.mjs"}\n{"ppid":"4","pid":"200","commandLine":null}\n{"ppid":"200","pid":"222","commandLine":"C:\\\\Tools\\\\helper.exe"}\n');
  validChild.emit('exit', 0, null);
  validChild.stdout.emit('end');
  validChild.stdout.emit('close');
  const validTable = await validPending;
  assert.deepEqual(
    [...validTable.entries()].sort((left, right) => left[0] - right[0]),
    [
      [100, { ppid: 4, commandLine: 'C:\\Tools\\node.exe runner.mjs' }],
      [200, { ppid: 4, commandLine: null }],
      [222, { ppid: 200, commandLine: 'C:\\Tools\\helper.exe' }],
    ],
    'all-valid identity rows still parse into the pid-to-identity snapshot',
  );

  const blankChild = scriptedProcessTableChild();
  const blankPending = readWindowsProcessTable(5_000, { spawnProcessTableTool: () => blankChild });
  blankChild.stdout.emit('data', '{"ppid":"4","pid":"100","commandLine":"C:\\\\Tools\\\\node.exe runner.mjs"}\n\n   \n\t\n');
  blankChild.emit('exit', 0, null);
  blankChild.stdout.emit('end');
  blankChild.stdout.emit('close');
  const blankTable = await blankPending;
  assert.deepEqual([...blankTable.entries()], [[100, { ppid: 4, commandLine: 'C:\\Tools\\node.exe runner.mjs' }]], 'genuinely empty or whitespace-only lines are skipped, not treated as malformed rows');
});

const WIN_RUNNER_PARENT = 4;

test('terminateRecordedProcessTree win32 enumerates twice, spares only the identity-matched broker subtree, and force-kills the runner plus verified remaining descendants', async () => {
  const { terminateRecordedProcessTree } = await import('../scripts/lib/process.mjs');
  await withLiveRunnerPid(async (runnerPid) => withWindowsPlatform(async () => {
    const kills = [];
    const enumerations = [];
    const processTable = processSnapshot([
      [runnerPid, WIN_RUNNER_PARENT, 'C:\\Tools\\node.exe runner.mjs'],
      [111, runnerPid, BROKER_COMMAND_LINE], // the identity-matched broker under the runner
      [333, 111, 'C:\\Tools\\node.exe C:\\ws\\broker\\engine.js'], // the engine lives under the broker
      [222, runnerPid, 'C:\\Tools\\version-check.exe --wait'],
    ]);
    const result = await terminateRecordedProcessTree(runnerPid, {
      graceMs: 0, timeoutMs: 1_000, excludeBrokers: [{ pid: 111, ...BROKER_LAUNCH }],
      enumerateProcessTable: async (timeoutMs) => { enumerations.push(timeoutMs); return processTable; },
      runProcessKill: async (command, args, options) => { kills.push({ command, args, options }); },
    });
    assert.equal(result, true, 'a live tree was signalled');
    assert.equal(enumerations.length, 2, 'the plan snapshot and the pre-kill revalidation snapshot each run exactly once');
    assert.ok(enumerations.every((timeoutMs) => timeoutMs > 0 && timeoutMs <= 1_000), 'both snapshots run inside the shared deadline');
    assert.deepEqual(kills.map((kill) => kill.args), [
      ['/PID', String(runnerPid), '/F'],
      ['/PID', '222', '/F'],
    ], 'the runner is killed first, then every verified non-broker descendant, each forceful');
    assert.equal(kills.some((kill) => kill.args.includes('/T')), false, 'the excluded-tree plan never degrades into a blind /T walk');
    assert.ok(kills.every((kill) => kill.command === 'taskkill' && kill.options.timeoutMs > 0 && kill.options.timeoutMs <= 1_000), 'every kill is bounded by the shared deadline');
  }));
});

test('terminateRecordedProcessTree win32 skips a descendant whose pid was reused between the plan and revalidation snapshots', async () => {
  const { terminateRecordedProcessTree } = await import('../scripts/lib/process.mjs');
  await withLiveRunnerPid(async (runnerPid) => withWindowsPlatform(async () => {
    const kills = [];
    const enumerations = [];
    // Simulated table evolution between the two snapshots: descendant 222
    // exited after the plan snapshot and its pid was reused by an unrelated
    // process (different parent, different creation command line); descendant
    // 444 exited and its pid was NOT reused; descendant 333 is stable.
    const planSnapshot = processSnapshot([
      [runnerPid, WIN_RUNNER_PARENT, 'C:\\Tools\\node.exe runner.mjs'],
      [222, runnerPid, 'C:\\Tools\\version-check.exe --wait'],
      [444, runnerPid, 'C:\\Tools\\version-check.exe --short'],
      [333, 222, 'C:\\Tools\\helper.exe'],
    ]);
    const verifySnapshot = processSnapshot([
      [runnerPid, WIN_RUNNER_PARENT, 'C:\\Tools\\node.exe runner.mjs'],
      [222, 999_000, 'C:\\Windows\\unrelated-replacement.exe'], // reused by an unrelated process
      [333, 222, 'C:\\Tools\\helper.exe'], // stable identity, parent number unchanged
    ]);
    const result = await terminateRecordedProcessTree(runnerPid, {
      graceMs: 0, timeoutMs: 1_000, excludeBrokers: [{ pid: 111, ...BROKER_LAUNCH }],
      enumerateProcessTable: async (timeoutMs) => { enumerations.push(timeoutMs); return enumerations.length === 1 ? planSnapshot : verifySnapshot; },
      runProcessKill: async (command, args, options) => { kills.push({ command, args, options }); },
    });
    assert.equal(result, true, 'a live tree was signalled');
    assert.equal(enumerations.length, 2, 'the revalidation snapshot runs before any descendant kill');
    assert.deepEqual(kills.map((kill) => kill.args), [
      ['/PID', String(runnerPid), '/F'],
      ['/PID', '333', '/F'],
    ], 'the reused pid and the vanished pid are skipped by the intersection; the stable descendant is still killed');
  }));
});

test('terminateRecordedProcessTree win32 reports an INCOMPLETE kill sequence when killing the runner consumes the remaining deadline', async () => {
  const { terminateRecordedProcessTree } = await import('../scripts/lib/process.mjs');
  await withLiveRunnerPid(async (runnerPid) => withWindowsPlatform(async () => {
    const kills = [];
    const processTable = processSnapshot([
      [runnerPid, WIN_RUNNER_PARENT, 'C:\\Tools\\node.exe runner.mjs'],
      [222, runnerPid, 'C:\\Tools\\version-check.exe --wait'],
      [333, runnerPid, 'C:\\Tools\\version-check.exe --short'],
    ]);
    const result = await terminateRecordedProcessTree(runnerPid, {
      graceMs: 0, timeoutMs: 250, excludeBrokers: [{ pid: 111, ...BROKER_LAUNCH }],
      enumerateProcessTable: async () => processTable,
      // Killing the runner alone consumes the ENTIRE remaining shared deadline,
      // exactly the stall the bounded sequence exists to survive: the verified
      // walk must stop before 222/333 and REPORT the abandonment instead of
      // reporting a fully signalled tree whose descendants were skipped.
      runProcessKill: async (command, args, options) => {
        kills.push([...args]);
        if (args.includes(String(runnerPid))) await new Promise((resolve) => setTimeout(resolve, options.timeoutMs + 60));
      },
    });
    assert.deepEqual(kills, [['/PID', String(runnerPid), '/F']], 'only the runner kill is dispatched before the deadline is spent');
    assert.ok(result !== null && typeof result === 'object' && result.completed === false,
      `an incompletely dispatched verified sequence must be reported incomplete, got ${JSON.stringify(result)}`);
    assert.equal(result.dispatched, 1, 'exactly the runner was dispatched before the budget expired');
    assert.deepEqual(result.pending, [222, 333], 'every surviving verified descendant is named as pending');
  }));
});

test('terminateRecordedProcessTree win32 reports an INCOMPLETE kill sequence when a verified dispatch fails mid-walk', async () => {
  const { terminateRecordedProcessTree } = await import('../scripts/lib/process.mjs');
  await withLiveRunnerPid(async (runnerPid) => withWindowsPlatform(async () => {
    const kills = [];
    const processTable = processSnapshot([
      [runnerPid, WIN_RUNNER_PARENT, 'C:\\Tools\\node.exe runner.mjs'],
      [222, runnerPid, 'C:\\Tools\\version-check.exe --wait'],
      [333, runnerPid, 'C:\\Tools\\version-check.exe --short'],
    ]);
    const result = await terminateRecordedProcessTree(runnerPid, {
      graceMs: 0, timeoutMs: 1_000, excludeBrokers: [{ pid: 111, ...BROKER_LAUNCH }],
      enumerateProcessTable: async () => processTable,
      // The second verified dispatch fails: the sequence must stop there and
      // name the failed target plus everything after it as pending, never
      // report `true` as if the whole verified plan was signalled.
      runProcessKill: async (command, args) => {
        kills.push([...args]);
        if (args.includes('222')) throw new Error('taskkill dispatch failed');
      },
    });
    assert.deepEqual(kills, [
      ['/PID', String(runnerPid), '/F'],
      ['/PID', '222', '/F'],
    ], 'the walk stops at the failed dispatch');
    assert.ok(result !== null && typeof result === 'object' && result.completed === false,
      `a mid-sequence dispatch failure must be reported incomplete, got ${JSON.stringify(result)}`);
    assert.equal(result.dispatched, 1, 'only the runner was dispatched');
    assert.deepEqual(result.pending, [222, 333], 'the failed target and every unattempted target are pending');
  }));
});

test('terminateRecordedProcessTree win32 treats a production spawn-error or timeout RESOLUTION as a failed dispatch, never a signalled target', async () => {
  const { terminateRecordedProcessTree } = await import('../scripts/lib/process.mjs');
  await withLiveRunnerPid(async (runnerPid) => withWindowsPlatform(async () => {
    const processTable = processSnapshot([
      [runnerPid, WIN_RUNNER_PARENT, 'C:\\Tools\\node.exe runner.mjs'],
      [222, runnerPid, 'C:\\Tools\\version-check.exe --wait'],
      [333, runnerPid, 'C:\\Tools\\version-check.exe --short'],
    ]);
    // The production boundedProcessKill RESOLVES on a failed dispatch — a
    // spawn error, a stall killed at its bound — instead of rejecting, so a
    // sequence that only catches rejections counts the target as signalled,
    // can return `true`, and settles marked-runner cleanup while writable
    // descendants survive. The seam result must be inspected per target.
    for (const failure of [{ ok: false, reason: 'spawn-error', exitCode: null }, { ok: false, reason: 'timeout', exitCode: null }]) {
      const kills = [];
      const afterFailure = [];
      const result = await terminateRecordedProcessTree(runnerPid, {
        graceMs: 0, timeoutMs: 1_000, excludeBrokers: [{ pid: 111, ...BROKER_LAUNCH }],
        enumerateProcessTable: async () => processTable,
        runProcessKill: async (command, args) => {
          if (afterFailure.length > 0) return { ok: true, exitCode: 0 };
          if (args.includes(String(runnerPid))) { kills.push([...args]); return { ok: true, exitCode: 0 }; }
          if (args.includes('222')) { kills.push([...args]); return failure; }
          afterFailure.push([...args]);
          return { ok: true, exitCode: 0 };
        },
      });
      assert.deepEqual(kills, [['/PID', String(runnerPid), '/F'], ['/PID', '222', '/F']],
        `the ${failure.reason} resolution stops the walk at the failed dispatch`);
      assert.deepEqual(afterFailure, [], `no target after a ${failure.reason} dispatch is ever attempted`);
      assert.ok(result !== null && typeof result === 'object' && result.completed === false,
        `a ${failure.reason} dispatch resolution must be reported incomplete, got ${JSON.stringify(result)}`);
      assert.equal(result.dispatched, 1, 'only the runner carries dispatch evidence');
      assert.deepEqual(result.pending, [222, 333], `the ${failure.reason} target and every unattempted target are pending`);
    }
  }));
});

test('terminateRecordedProcessTree win32 counts a taskkill already-gone exit as a dispatched target', async () => {
  const { terminateRecordedProcessTree } = await import('../scripts/lib/process.mjs');
  await withLiveRunnerPid(async (runnerPid) => withWindowsPlatform(async () => {
    const kills = [];
    const processTable = processSnapshot([
      [runnerPid, WIN_RUNNER_PARENT, 'C:\\Tools\\node.exe runner.mjs'],
      [222, runnerPid, 'C:\\Tools\\version-check.exe --wait'],
    ]);
    const result = await terminateRecordedProcessTree(runnerPid, {
      graceMs: 0, timeoutMs: 1_000, excludeBrokers: [{ pid: 111, ...BROKER_LAUNCH }],
      enumerateProcessTable: async () => processTable,
      // taskkill exit 128 — "the process not found" — proves the target was
      // ALREADY dead: evidence of a target gone, which still completes the
      // verified plan instead of reporting forever-pending descendants.
      runProcessKill: async (command, args) => { kills.push([...args]); return { ok: true, reason: 'already-gone', exitCode: 128 }; },
    });
    assert.equal(result, true, 'an already-gone resolution is dispatched success: the verified plan completed');
    assert.deepEqual(kills.map((kill) => kill[1]), [String(runnerPid), '222'], 'every verified target was dispatched');
  }));
});

test('terminateRecordedProcessTree win32 reports an INCOMPLETE pid-only outcome when the plan snapshot consumed the whole deadline', async () => {
  const { terminateRecordedProcessTree } = await import('../scripts/lib/process.mjs');
  await withLiveRunnerPid(async (runnerPid) => withWindowsPlatform(async () => {
    const kills = [];
    const enumerations = [];
    const result = await terminateRecordedProcessTree(runnerPid, {
      graceMs: 0, timeoutMs: 60, excludeBrokers: [{ pid: 111, ...BROKER_LAUNCH }],
      // The plan snapshot alone consumes the entire shared deadline: no kill
      // can be given a non-trivial bound any more, so the pid-only fallback
      // must dispatch NOTHING (never a zero-timeout taskkill that its own
      // bound kills before it can signal anything) and report the recorded
      // pid as pending instead of settling the cleanup duty.
      enumerateProcessTable: async () => { enumerations.push(1); await new Promise((resolve) => setTimeout(resolve, 90)); return processSnapshot([[runnerPid, WIN_RUNNER_PARENT, 'C:\\Tools\\node.exe runner.mjs'], [222, runnerPid, 'C:\\Tools\\version-check.exe --wait']]); },
      runProcessKill: async (command, args, options) => { kills.push([command, ...args, options?.timeoutMs]); },
    });
    assert.equal(enumerations.length, 1, 'no budget remains for the revalidation snapshot');
    assert.deepEqual(kills, [], 'an exhausted budget dispatches no kill — never a zero-timeout taskkill');
    assert.ok(result !== null && typeof result === 'object' && result.completed === false,
      `a pid-only fallback with no kill budget must be reported incomplete, got ${JSON.stringify(result)}`);
    assert.equal(result.dispatched, 0, 'no kill carries dispatch evidence');
    assert.deepEqual(result.pending, [runnerPid], 'the recorded pid is named pending for the duty that must re-arm');
  }));
});

test('terminateRecordedProcessTree win32 reports an INCOMPLETE pid-only outcome when the revalidation snapshot consumed the whole deadline', async () => {
  const { terminateRecordedProcessTree } = await import('../scripts/lib/process.mjs');
  await withLiveRunnerPid(async (runnerPid) => withWindowsPlatform(async () => {
    const kills = [];
    const enumerations = [];
    const result = await terminateRecordedProcessTree(runnerPid, {
      graceMs: 0, timeoutMs: 60, excludeBrokers: [{ pid: 111, ...BROKER_LAUNCH }],
      // The revalidation snapshot itself stalls past the shared deadline and
      // resolves null: the fail-closed pid-only fallback inherits an EXHAUSTED
      // budget and must report the recorded pid pending instead of dispatching
      // a zero-timeout kill and settling the duty as signalled.
      enumerateProcessTable: async (timeoutMs) => {
        enumerations.push(timeoutMs);
        if (enumerations.length === 1) return processSnapshot([[runnerPid, WIN_RUNNER_PARENT, 'C:\\Tools\\node.exe runner.mjs'], [222, runnerPid, 'C:\\Tools\\version-check.exe --wait']]);
        await new Promise((resolve) => setTimeout(resolve, 90));
        return null;
      },
      runProcessKill: async (command, args, options) => { kills.push([command, ...args, options?.timeoutMs]); },
    });
    assert.equal(enumerations.length, 2, 'the revalidation snapshot is attempted before the plan is executed');
    assert.deepEqual(kills, [], 'the exhausted fallback dispatches no kill');
    assert.ok(result !== null && typeof result === 'object' && result.completed === false,
      `a pid-only fallback with no kill budget must be reported incomplete, got ${JSON.stringify(result)}`);
    assert.equal(result.dispatched, 0, 'no kill carries dispatch evidence');
    assert.deepEqual(result.pending, [runnerPid], 'the recorded pid is named pending');
  }));
});

test('terminateRecordedProcessTree win32 fails closed to the recorded pid alone when the revalidation snapshot is unavailable', async () => {
  const { terminateRecordedProcessTree } = await import('../scripts/lib/process.mjs');
  await withLiveRunnerPid(async (runnerPid) => withWindowsPlatform(async () => {
    const kills = [];
    const enumerations = [];
    const result = await terminateRecordedProcessTree(runnerPid, {
      graceMs: 0, timeoutMs: 900, excludeBrokers: [{ pid: 111, ...BROKER_LAUNCH }],
      enumerateProcessTable: async (timeoutMs) => { enumerations.push(timeoutMs); return enumerations.length === 1 ? processSnapshot([[runnerPid, WIN_RUNNER_PARENT, 'C:\\Tools\\node.exe runner.mjs'], [222, runnerPid, 'C:\\Tools\\version-check.exe --wait']]) : null; },
      runProcessKill: async (command, args) => { kills.push([command, ...args]); },
    });
    assert.equal(result, true, 'the runner kill still reports a signalled tree');
    assert.equal(enumerations.length, 2, 'the revalidation snapshot is attempted before the plan is executed');
    assert.deepEqual(kills, [
      ['taskkill', '/PID', String(runnerPid), '/F'],
    ], 'an unavailable revalidation snapshot degrades to the forced-only recorded pid, never unverified descendant kills');
  }));
});

test('terminateRecordedProcessTree win32 excludes a recorded broker pid only while its command line matches the recorded launch signature', async () => {
  const { terminateRecordedProcessTree } = await import('../scripts/lib/process.mjs');
  await withLiveRunnerPid(async (runnerPid) => withWindowsPlatform(async () => {
    // F2: a DEAD broker identity remains on disk and Windows reused its pid
    // for a non-broker descendant of the runner — the stale recorded pid must
    // NOT be excluded and dies as an ordinary descendant.
    const staleKills = [];
    const staleTable = processSnapshot([
      [runnerPid, WIN_RUNNER_PARENT, 'C:\\Tools\\node.exe runner.mjs'],
      [111, runnerPid, 'C:\\Windows\\unrelated-replacement.exe --not-a-broker'], // the reused pid
      [333, 111, 'C:\\Tools\\unrelated-child.exe'],
    ]);
    await terminateRecordedProcessTree(runnerPid, {
      graceMs: 0, timeoutMs: 900, excludeBrokers: [{ pid: 111, ...BROKER_LAUNCH }],
      enumerateProcessTable: async () => staleTable,
      runProcessKill: async (command, args) => { staleKills.push([command, ...args]); },
    });
    assert.deepEqual(staleKills.map((kill) => kill.slice(1)), [
      ['/PID', String(runnerPid), '/F'],
      ['/PID', '111', '/F'],
      ['/PID', '333', '/F'],
    ], 'a reused recorded broker pid with a foreign command line is killed as an ordinary descendant, not excluded');

    // The same recorded pid whose command line DOES match the recorded launch
    // signature is the live broker: its whole subtree is spared.
    const liveKills = [];
    const liveTable = processSnapshot([
      [runnerPid, WIN_RUNNER_PARENT, 'C:\\Tools\\node.exe runner.mjs'],
      [111, runnerPid, BROKER_COMMAND_LINE],
      [333, 111, 'C:\\Tools\\node.exe C:\\ws\\broker\\engine.js'],
      [222, runnerPid, 'C:\\Tools\\version-check.exe --wait'],
    ]);
    await terminateRecordedProcessTree(runnerPid, {
      graceMs: 0, timeoutMs: 900, excludeBrokers: [{ pid: 111, ...BROKER_LAUNCH }],
      enumerateProcessTable: async () => liveTable,
      runProcessKill: async (command, args) => { liveKills.push([command, ...args]); },
    });
    assert.deepEqual(liveKills.map((kill) => kill.slice(1)), [
      ['/PID', String(runnerPid), '/F'],
      ['/PID', '222', '/F'],
    ], 'a matching command line keeps the broker subtree excluded while the rest of the tree dies');
  }));
});

test('terminateRecordedProcessTree win32 fails closed to the recorded pid alone when an exclusion entry is malformed', async () => {
  const { terminateRecordedProcessTree } = await import('../scripts/lib/process.mjs');
  await withLiveRunnerPid(async (runnerPid) => withWindowsPlatform(async () => {
    const kills = [];
    const enumerations = [];
    const result = await terminateRecordedProcessTree(runnerPid, {
      graceMs: 0, timeoutMs: 900, excludeBrokers: [{ pid: 111 }],
      enumerateProcessTable: async () => { enumerations.push(1); return processSnapshot([[runnerPid, WIN_RUNNER_PARENT, 'C:\\Tools\\node.exe runner.mjs']]); },
      runProcessKill: async (command, args) => { kills.push([command, ...args]); },
    });
    assert.equal(result, true, 'the runner kill still reports a signalled tree');
    assert.equal(enumerations.length, 0, 'no snapshot is taken when the exclusion list itself is unprovable');
    assert.deepEqual(kills, [
      ['taskkill', '/PID', String(runnerPid), '/F'],
    ], 'a malformed exclusion list degrades to the forced-only recorded pid');
  }));
});

test('terminateRecordedProcessTree win32 fails closed to the recorded pid alone when enumeration is unavailable', async () => {
  const { terminateRecordedProcessTree } = await import('../scripts/lib/process.mjs');
  await withLiveRunnerPid(async (runnerPid) => withWindowsPlatform(async () => {
    const kills = [];
    const result = await terminateRecordedProcessTree(runnerPid, {
      graceMs: 0, timeoutMs: 900, excludeBrokers: [{ pid: 111, ...BROKER_LAUNCH }],
      enumerateProcessTable: async () => null,
      runProcessKill: async (command, args) => { kills.push([command, ...args]); },
    });
    assert.equal(result, true, 'the runner kill still reports a signalled tree');
    assert.deepEqual(kills, [
      ['taskkill', '/PID', String(runnerPid), '/F'],
    ], 'enumeration failure degrades to the forced-only recorded pid, never a guessed tree');
  }));
});

test('terminateRecordedProcessTree win32 kills only the recorded pid when the broker lookup failed', async () => {
  const { terminateRecordedProcessTree } = await import('../scripts/lib/process.mjs');
  await withLiveRunnerPid(async (runnerPid) => withWindowsPlatform(async () => {
    const kills = [];
    const enumerations = [];
    const result = await terminateRecordedProcessTree(runnerPid, {
      graceMs: 0, timeoutMs: 900, excludeUnknown: true,
      enumerateProcessTable: async (timeoutMs) => { enumerations.push(timeoutMs); return new Map([[runnerPid, [111]]]); },
      runProcessKill: async (command, args) => { kills.push([command, ...args]); },
    });
    assert.equal(result, true, 'the runner kill still reports a signalled tree');
    assert.equal(enumerations.length, 0, 'no snapshot is taken when the broker lookup failed — no descendant can be proven non-broker');
    assert.deepEqual(kills, [
      ['taskkill', '/PID', String(runnerPid), '/F'],
    ], 'a lookup-failed state degrades to the forced-only recorded pid, never a guessed tree');
    assert.equal(kills.some((kill) => kill.includes('/T')), false, 'the lookup-failed state never weakens into a blind /T walk');
  }));
});

test('terminateRecordedProcessTree win32 dispatches the forced pid-only kill first and keeps the whole budget for it', async () => {
  const { terminateRecordedProcessTree } = await import('../scripts/lib/process.mjs');
  await withLiveRunnerPid(async (runnerPid) => withWindowsPlatform(async () => {
    // The fail-closed target is a DETACHED, windowless runner: a graceful
    // `taskkill` without /F can only post a WM_CLOSE such a process never
    // answers, so the pid-only fallback dispatches the FORCED kill FIRST —
    // a wasted graceful launch (0.1-1s on a loaded Windows runner) could
    // alone consume a SessionEnd pass's ~1.5s local slice and leave the
    // runner unsignalled. The forced dispatch is bounded by the WHOLE
    // remaining budget and carries no grace wait.
    const kills = [];
    await terminateRecordedProcessTree(runnerPid, {
      graceMs: 200, timeoutMs: 700, excludeUnknown: true,
      runProcessKill: async (command, args, options) => {
        kills.push([command, ...args, options?.timeoutMs]);
        return { ok: true, exitCode: 0 };
      },
    });
    assert.deepEqual(kills.map((kill) => kill.slice(0, 4)), [
      ['taskkill', '/PID', String(runnerPid), '/F'],
    ], 'the forced kill is the FIRST and only dispatch');
    assert.ok(kills[0][4] > 0 && kills[0][4] <= 700, `the forced dispatch is bounded by the whole remaining budget (got ${kills[0][4]})`);
  }));
});

test('terminateRecordedProcessTree win32 reports the pid-only fallback honestly per its kill dispatches', async () => {
  const { terminateRecordedProcessTree } = await import('../scripts/lib/process.mjs');
  await withLiveRunnerPid(async (runnerPid) => withWindowsPlatform(async () => {
    // A forced dispatch that is DENIED (taskkill nonzero exit such as
    // access-denied) leaves the pid's survival unknown: the pid's proven
    // absence is the only fallback completion evidence.
    const deniedKills = [];
    const deniedResult = await terminateRecordedProcessTree(runnerPid, {
      graceMs: 0, timeoutMs: 900, excludeUnknown: true,
      runProcessKill: async (command, args) => {
        deniedKills.push([...args]);
        return { ok: false, reason: 'exit-code', exitCode: 1 };
      },
    });
    assert.deepEqual(deniedKills, [['/PID', String(runnerPid), '/F']], 'the denied forced kill is the only dispatch attempted');
    assert.ok(deniedResult !== null && typeof deniedResult === 'object' && deniedResult.completed === false,
      `a pid-only fallback whose dispatch was denied must be reported incomplete, got ${JSON.stringify(deniedResult)}`);
    assert.equal(deniedResult.dispatched, 0, 'no dispatch carries delivery evidence');
    assert.deepEqual(deniedResult.pending, [runnerPid], 'the recorded pid stays pending');

    // When the dispatch is killed at its own bound — whether the signal landed
    // is unknowable — the recorded pid may survive: the honest outcome is the
    // INCOMPLETE report, never a `true` that settles a cleanup duty whose
    // runner is still alive.
    const rejectedKills = [];
    const rejectedResult = await terminateRecordedProcessTree(runnerPid, {
      graceMs: 0, timeoutMs: 900, excludeUnknown: true,
      runProcessKill: async (command, args) => {
        rejectedKills.push([...args]);
        return { ok: false, reason: 'timeout', exitCode: null };
      },
    });
    assert.deepEqual(rejectedKills, [['/PID', String(runnerPid), '/F']], 'the stalled forced kill is the only dispatch attempted');
    assert.ok(rejectedResult !== null && typeof rejectedResult === 'object' && rejectedResult.completed === false,
      `a pid-only fallback whose dispatches never landed must be reported incomplete, got ${JSON.stringify(rejectedResult)}`);
    assert.equal(rejectedResult.dispatched, 0, 'no dispatch carries delivery evidence');
    assert.deepEqual(rejectedResult.pending, [runnerPid], 'the recorded pid stays pending');
  }));
});

test('terminateRecordedProcessTree win32 keeps the full /T tree cleanup when no broker exclusion is requested', async () => {
  const { terminateRecordedProcessTree } = await import('../scripts/lib/process.mjs');
  await withLiveRunnerPid(async (runnerPid) => withWindowsPlatform(async () => {
    const kills = [];
    const enumerations = [];
    const result = await terminateRecordedProcessTree(runnerPid, {
      graceMs: 0, timeoutMs: 800,
      enumerateProcessTable: async () => { enumerations.push(1); return new Map(); },
      runProcessKill: async (command, args) => { kills.push([command, ...args]); },
    });
    assert.equal(result, true, 'a live tree was signalled');
    assert.equal(enumerations.length, 0, 'no snapshot is taken on an exclusion-free path');
    assert.deepEqual(kills, [
      ['taskkill', '/PID', String(runnerPid), '/T'],
      ['taskkill', '/PID', String(runnerPid), '/T', '/F'],
    ], 'without exclusions the whole recorded tree terminates through /T');
  }));
});

test('the POSIX dead-root sweep reports the dispatched surviving group as swept and settles only when the group is gone', { skip: process.platform === 'win32' ? 'POSIX process-group semantics only.' : false }, async () => {
  const { sweepDeadRootDescendantTree } = await import('../scripts/lib/process.mjs');
  const { rm } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'zcode-posix-group-'));
  const grandchildPidFile = join(root, 'grandchild.pid');
  // The detached leader owns a fresh process group; the grandchild spawns into
  // the SAME group (no detached) and outlives the leader — the POSIX shape of a
  // runner whose descendants survive its death.
  const grandchildCode = `import { writeFile } from 'node:fs/promises';
    await writeFile(${JSON.stringify(grandchildPidFile)}, String(process.pid));
    setInterval(() => {}, 1 << 30);`;
  const leaderCode = `const { spawn } = await import('node:child_process');
    spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(grandchildCode)}], { stdio: 'ignore' });
    setInterval(() => {}, 1 << 30);`;
  const leader = spawn(process.execPath, ['--input-type=module', '-e', leaderCode], { detached: true, stdio: 'ignore' });
  leader.unref();
  try {
    let grandchildPid = 0;
    for (let index = 0; index < 200 && !grandchildPid; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const contents = await readFile(grandchildPidFile, 'utf8').catch(() => '');
      if (contents) grandchildPid = Number.parseInt(contents, 10);
    }
    assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0, 'the grandchild never published its pid');
    // Kill ONLY the leader: the group survives through the grandchild.
    process.kill(leader.pid, 'SIGKILL');
    // The `unref()`ed leader handle contributes NO event-loop reference, and a
    // bare exit promise never holds the loop (promises are loop-INVISIBLE:
    // nodejs/node#49952), so awaiting `once('exit')` here lets the loop drain
    // before libuv delivers the reaped exit event — observed as `Promise
    // resolution is still pending but the event loop has already resolved`
    // with the test cancelled by the runner (the Node 22.13 CI failure). This
    // ref'd poll is the loop keep-alive that lets the exit evidence arrive.
    while (leader.exitCode === null && leader.signalCode === null) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await assertProcessGone(leader.pid);
    // RED before the fix: the dispatch reported `clean`, settling the duty in
    // the same pass that killed verified survivors.
    const swept = await sweepDeadRootDescendantTree(leader.pid, { timeoutMs: 2_000 });
    assert.equal(swept.kind, 'swept', 'a live group IS the surviving tree: the dispatch is reported, not settled');
    await assertProcessGone(grandchildPid);
    const clean = await sweepDeadRootDescendantTree(leader.pid, { timeoutMs: 2_000 });
    assert.equal(clean.kind, 'clean', 'the gone group is the POSIX completed-clean sweep evidence');
  } finally {
    try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* already gone */ }
    await rm(root, { recursive: true, force: true });
  }
});
