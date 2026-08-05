// @ts-nocheck
import { spawn } from 'node:child_process';

import { terminateProcess } from '../../scripts/lib/process.mjs';

/**
 * Bounded, shell-free child runner for integration tests.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?:string,env?:NodeJS.ProcessEnv,input?:unknown,protectedInput?:boolean,ordinaryInput?:boolean,timeoutMs?:number,maxOutputBytes?:number,graceMs?:number}} [options]
 */
export function runChild(command, args, options = {}) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new TypeError('Invalid test child launch.');
  const timeoutMs = options.timeoutMs ?? 30_000; const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
  const protectedInput = options.protectedInput === true;
  const stdio = protectedInput ? ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] : [options.ordinaryInput ? 'pipe' : 'ignore', 'pipe', 'pipe'];
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: process.platform !== 'win32', windowsHide: true, shell: false, stdio });
  return new Promise((resolvePromise, reject) => {
    let stdout = ''; let stderr = ''; let internal = ''; let bytes = 0; let settled = false; let terminating = false;
    const capture = (kind, chunk) => {
      bytes += chunk.length;
      if (kind === 'stdout') stdout += chunk; else if (kind === 'stderr') stderr += chunk; else internal += chunk;
      if (bytes > maxOutputBytes) void abort('TEST_CHILD_OUTPUT_LIMIT', 'Test child exceeded its output limit.');
    };
    child.stdout?.on('data', (chunk) => capture('stdout', chunk));
    child.stderr?.on('data', (chunk) => capture('stderr', chunk));
    if (protectedInput) {
      child.stdio[4]?.on('data', (chunk) => capture('internal', chunk));
      child.stdio[3]?.end(`${JSON.stringify(options.input ?? {})}\n`);
    } else if (options.ordinaryInput) child.stdin?.end(JSON.stringify(options.input));
    const timer = setTimeout(() => { void abort('TEST_CHILD_TIMEOUT', 'Test child timed out.'); }, timeoutMs);
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolvePromise(value); };
    async function abort(code, message) {
      if (settled || terminating) return; terminating = true;
      await terminateProcess(child, { graceMs: options.graceMs ?? 250 }).catch(() => {});
      const error = Object.assign(new Error(message), { code, pid: child.pid }); finish(error);
    }
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => { if (!terminating) finish(null, { code, signal, stdout, stderr, internal, spawnargs: child.spawnargs, pid: child.pid }); });
  });
}
