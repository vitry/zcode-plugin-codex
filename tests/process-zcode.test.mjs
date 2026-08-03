// @ts-nocheck
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

test('grace timer does not retain the caller after the child exits', async () => {
  const moduleUrl = new URL('../scripts/lib/process.mjs', import.meta.url).href;
  const source = `import { spawn } from 'node:child_process'; import { terminateProcess } from ${JSON.stringify(moduleUrl)}; const child=spawn(process.execPath,['-e','setInterval(()=>{},10000)']); await terminateProcess(child,{graceMs:1000});`;
  const started = Date.now();
  const runner = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: 'ignore' });
  const code = await new Promise((resolve) => runner.once('exit', resolve));
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 700, 'the cancelled grace timer must not keep the event loop alive');
});
