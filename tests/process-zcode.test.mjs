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
