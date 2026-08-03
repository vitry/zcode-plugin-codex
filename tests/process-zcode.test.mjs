// @ts-nocheck
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { runProcess, spawnProcess, terminateProcess } from '../scripts/lib/process.mjs';
import { BoundedWriter, RedactedTail, ZCodeProtocolClient } from '../scripts/lib/zcode-protocol.mjs';

test('grace timer does not retain the caller after the child exits', async () => {
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
  await assert.rejects(runProcess({ command: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(4096))'], target: process.execPath }, { maxOutputBytes: 128 }), { code: 'ZCODE_PROCESS_OUTPUT_LIMIT' });
});

test('termination kills the spawned process group including descendants', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-tree-')); const pidFile = join(directory, 'pid');
  const source = `const {spawn}=require('node:child_process'),fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},10000);`;
  const child = await spawnProcess({ command: process.execPath, args: ['-e', source], target: process.execPath });
  let grandchildPid;
  for (let index = 0; index < 100; index += 1) { try { grandchildPid = Number(await readFile(pidFile, 'utf8')); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); } }
  assert.ok(Number.isSafeInteger(grandchildPid)); await terminateProcess(child, { graceMs: 100 });
  assert.throws(() => process.kill(grandchildPid, 0), (error) => error.code === 'ESRCH');
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
  controller.abort(); await assert.rejects(running, { code: 'ZCODE_PROCESS_ABORTED' }); assert.throws(() => process.kill(grandchildPid, 0), (error) => error.code === 'ESRCH'); await rm(directory, { recursive: true, force: true });
});

test('bounded writer queues on backpressure, flushes on drain, and fails at its byte cap', () => {
  class FakeWritable extends EventEmitter { constructor() { super(); this.writable = true; this.writes = []; this.block = true; } write(value) { this.writes.push(value); return !this.block; } }
  const stream = new FakeWritable(); let failure; const writer = new BoundedWriter(stream, { maxQueuedBytes: 8, drainTimeoutMs: 10_000, onFailure: (error) => { failure = error; } });
  writer.write('1234'); writer.write('56'); assert.deepEqual(stream.writes, ['1234']); stream.block = false; stream.emit('drain'); assert.deepEqual(stream.writes, ['1234', '56']); writer.close();
  const blocked = new FakeWritable(); const capped = new BoundedWriter(blocked, { maxQueuedBytes: 5, onFailure: (error) => { failure = error; } }); capped.write('1234'); assert.throws(() => capped.write('56'), { code: 'ZCODE_WRITE_OVERFLOW' }); assert.equal(failure.code, 'ZCODE_WRITE_OVERFLOW');
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

test('stderr tail redacts a secret before truncating a single oversized line', () => {
  const tail = new RedactedTail(128); tail.append(`authorization=${'super-secret'.repeat(1000)}`); assert.ok(Buffer.byteLength(tail.value()) <= 128); assert.ok(!tail.value().includes('super-secret'));
});
