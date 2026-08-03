// @ts-nocheck
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runProcess, spawnProcess, terminateProcess } from '../scripts/lib/process.mjs';

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
