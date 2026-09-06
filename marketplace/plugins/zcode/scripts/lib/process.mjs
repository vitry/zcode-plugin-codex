import { spawn, spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';

import { PluginError, wrapError } from './errors.mjs';

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const POST_EXIT_DRAIN_MS = 50;

/** @param {string} path @param {string} [execPath] @param {string} [platform] @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env] */
export function launchForPath(path, execPath = process.execPath, platform = process.platform, env = process.env) {
  if (typeof path !== 'string' || path.length === 0) throw processInputError();
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (platform === 'win32' && ['.cmd', '.bat'].includes(extension)) return { command: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c'], target: path, windowsShim: true };
  return JS_EXTENSIONS.has(extension)
    ? { command: execPath, args: [path], target: path }
    : { command: path, args: [], target: path };
}

/** @param {{ command: string, args: string[], target?: string }} launch */
export async function assertLaunchTarget(launch) {
  validateLaunch(launch);
  if (!launch.target) return;
  try {
    await access(launch.target);
  } catch (error) {
    throw new PluginError('ZCODE_LAUNCH_TARGET_MISSING', 'The resolved ZCode launch target no longer exists.', {
      category: 'runtime', remedy: 'Run $zcode:setup to rediscover the installed ZCode CLI.', cause: error,
      details: { target: launch.target },
    });
  }
}

/**
 * @param {{ command: string, args: string[], target?: string, windowsShim?: boolean }} launch
 * @param {{ args?: string[], cwd?: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal }} [options]
 */
export async function spawnProcess(launch, options = {}) {
  validateLaunch(launch);
  await assertLaunchTarget(launch);
  try {
    const extraArgs = options.args ?? [];
    const argv = launch.windowsShim ? [...launch.args, windowsShimCommand(/** @type {string} */ (launch.target), extraArgs)] : [...launch.args, ...extraArgs];
    const child = spawn(launch.command, argv, {
      cwd: options.cwd, env: options.env, signal: options.signal,
      detached: process.platform !== 'win32', shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    return child;
  } catch (error) {
    throw wrapError(error, 'ZCODE_SPAWN_FAILED', 'Could not start ZCode.', {
      category: 'runtime', remedy: 'Verify the ZCode installation and run $zcode:setup.',
    });
  }
}

/** @param {{command:string,args:string[],target?:string}} launch @param {{args?:string[],cwd?:string,env?:NodeJS.ProcessEnv}} [options] */
export async function spawnDaemon(launch, options = {}) {
  validateLaunch(launch); await assertLaunchTarget(launch);
  try {
    const child = spawn(launch.command, [...launch.args, ...(options.args ?? [])], { cwd: options.cwd, env: options.env, detached: true, shell: false, windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref(); return child;
  } catch (error) { throw wrapError(error, 'ZCODE_DAEMON_SPAWN_FAILED', 'Could not start the ZCode broker process.', { category: 'runtime', remedy: 'Verify the Node and ZCode installations.' }); }
}

/** @param {{command:string,args:string[],target?:string,windowsShim?:boolean}} launch @param {{args?:string[],cwd?:string,env?:NodeJS.ProcessEnv,timeoutMs?:number,maxOutputBytes?:number,signal?:AbortSignal}} [options] */
export async function runProcess(launch, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000; const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw processInputError();
  if (options.signal?.aborted) throw new PluginError('ZCODE_PROCESS_ABORTED', 'The ZCode process was aborted.', { category: 'state', remedy: 'Retry when the operation should continue.' });
  const { signal, ...spawnOptions } = options; const child = await spawnProcess(launch, spawnOptions); let stdout = ''; let stderr = ''; let capturedOutputBytes = 0; let overflow = false;
  child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
  const capture = (/** @type {'stdout'|'stderr'} */ kind, /** @type {string} */ chunk) => {
    if (overflow) return;
    const chunkBytes = Buffer.byteLength(chunk);
    if (capturedOutputBytes + chunkBytes > maxOutputBytes) {
      overflow = true;
      child.stdout?.destroy(); child.stderr?.destroy();
      void terminateProcess(child).catch(() => {});
      return;
    }
    capturedOutputBytes += chunkBytes;
    if (kind === 'stdout') stdout += chunk; else stderr += chunk;
  };
  child.stdout?.on('data', (chunk) => capture('stdout', chunk)); child.stderr?.on('data', (chunk) => capture('stderr', chunk));
  let timer; const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
  let resolveAbort = () => {}; const abort = new Promise((resolve) => { resolveAbort = () => resolve('aborted'); }); signal?.addEventListener('abort', resolveAbort, { once: true });
  let outcome;
  try { outcome = await Promise.race([new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, childSignal) => { void drainExitedProcessStreams([child.stdout, child.stderr], POST_EXIT_DRAIN_MS).then(() => resolve({ code, signal: childSignal }), reject); }); }), timeout, abort]); }
  catch (error) { await terminateProcess(child).catch(() => {}); throw wrapError(error, 'ZCODE_PROCESS_FAILED', 'The ZCode process failed.', { category: 'runtime', remedy: 'Verify the installation and retry.' }); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', resolveAbort); }
  if (outcome === 'aborted') { await terminateProcess(child); throw new PluginError('ZCODE_PROCESS_ABORTED', 'The ZCode process was aborted.', { category: 'state', remedy: 'Retry when the operation should continue.' }); }
  if (outcome === 'timeout' || overflow) { await terminateProcess(child); throw new PluginError(outcome === 'timeout' ? 'ZCODE_PROCESS_TIMEOUT' : 'ZCODE_PROCESS_OUTPUT_LIMIT', outcome === 'timeout' ? 'The ZCode process timed out.' : 'The ZCode process exceeded its output limit.', { category: outcome === 'timeout' ? 'timeout' : 'runtime', remedy: 'Inspect the ZCode installation and retry.', details: { timeoutMs, maxOutputBytes, capturedOutputBytes } }); }
  return { ...outcome, stdout, stderr };
}

/**
 * Drain bytes already owned by an exited child without allowing a descendant
 * that inherited the pipe to retain the caller indefinitely.
 * @param {Array<import('node:stream').Readable|null|undefined>} streams
 * @param {number} [timeoutMs]
 */
export async function drainExitedProcessStreams(streams, timeoutMs = POST_EXIT_DRAIN_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw processInputError();
  const pending = /** @type {import('node:stream').Readable[]} */ (streams.filter((stream) => stream && !stream.destroyed && !stream.readableEnded));
  if (pending.length === 0) return;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  /** @type {Array<() => void>} */
  const removeListeners = [];
  const completed = new Promise((resolve) => {
    let remaining = pending.length;
    for (const stream of pending) {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        remaining -= 1;
        if (remaining === 0) resolve('completed');
      };
      stream.once('end', finish); stream.once('close', finish); stream.once('error', finish);
      removeListeners.push(() => { stream.removeListener('end', finish); stream.removeListener('close', finish); stream.removeListener('error', finish); });
    }
  });
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve('deadline'), timeoutMs); });
  const result = await Promise.race([completed, deadline]);
  clearTimeout(timer);
  for (const remove of removeListeners) remove();
  if (result === 'deadline') for (const stream of pending) stream.destroy();
}

/**
 * Terminate a RECORDED detached worker process tree by its group-leader pid.
 * Detached workers are their own process group, so the group is signalled first
 * and the bare pid is the fallback. A missing or already-exited tree — leader
 * or group — is a no-op. This is only local process cleanup — it is NOT remote
 * terminal proof, so callers must re-read durable state to elect a winner.
 * Bounded by `graceMs` and per-invocation `timeoutMs`; the optional `signal`
 * only accelerates the POSIX grace wait into an immediate group SIGKILL and
 * never gates the kill itself.
 * @param {number} pid @param {{ graceMs?: number, signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<boolean>} true when a live tree was signalled, false when absent.
 */
export async function terminateRecordedProcessTree(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const graceMs = Number.isSafeInteger(options.graceMs) && /** @type {number} */ (options.graceMs) >= 0 ? /** @type {number} */ (options.graceMs) : 200;
  const alive = () => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'; }
  };
  // The recorded tree survives its leader when a descendant ignored the signal:
  // the group must be probed too, or such a tree would be declared gone here.
  const groupAlive = () => {
    try { process.kill(-pid, 0); return true; }
    catch (error) { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'; }
  };
  if (!alive() && !groupAlive()) return false;
  // Windows has no process-group negative-pid addressing: the full recorded
  // tree (worker plus descendants) terminates through taskkill /T (ADR 0007).
  // Each taskkill invocation is hard-bounded by timeoutMs alone — the caller's
  // remote-control signal must never gate LOCAL cleanup, or an expired remote
  // budget would abort the kill and leave the detached worker running.
  if (process.platform === 'win32') {
    // ONE shared local deadline spans both taskkill invocations and the grace
    // interval: whichever stage stalls, the whole sequence stays inside its own
    // budget and can never push a SessionEnd hook past the native deadline.
    const totalMs = Number.isSafeInteger(options.timeoutMs) && /** @type {number} */ (options.timeoutMs) >= 0 ? /** @type {number} */ (options.timeoutMs) : 1_000;
    const deadline = Date.now() + totalMs;
    const remaining = () => Math.max(0, deadline - Date.now());
    await boundedProcessKill('taskkill', ['/PID', String(pid), '/T'], { timeoutMs: remaining() });
    // The grace timer stays REFERENCED: with no other referenced handles an
    // unref'ed timer lets Node exit before the forced-kill fallback runs.
    if (graceMs > 0 && remaining() > 0) await new Promise((resolve) => { setTimeout(resolve, Math.min(graceMs, remaining())); });
    if (alive() && remaining() > 0) await boundedProcessKill('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: remaining() });
    return true;
  }
  const signalGroup = (/** @type {NodeJS.Signals} */ signal) => {
    for (const target of [-pid, pid]) { try { process.kill(target, signal); return; } catch { /* try next, then gone */ } }
  };
  signalGroup('SIGTERM');
  // The POSIX grace wait shares the caller's termination budget with the rest
  // of the sequence (mirroring the Windows branch): a SessionEnd passing its
  // remaining deadline never waits longer than that budget before escalating.
  const totalMs = Number.isSafeInteger(options.timeoutMs) && /** @type {number} */ (options.timeoutMs) >= 0 ? /** @type {number} */ (options.timeoutMs) : 1_000;
  const deadline = Date.now() + totalMs;
  const remainingGrace = Math.min(graceMs, Math.max(0, deadline - Date.now()));
  if (remainingGrace > 0) {
    let timer;
    const wait = new Promise((resolve) => { timer = setTimeout(() => resolve(false), remainingGrace); });
    const abortSignal = options.signal;
    const aborted = abortSignal ? new Promise((resolve) => { if (abortSignal.aborted) resolve('aborted'); else abortSignal.addEventListener('abort', () => resolve('aborted'), { once: true }); }) : new Promise(() => {});
    const raced = await Promise.race([wait, aborted]);
    clearTimeout(timer);
    if (raced === 'aborted') { signalGroup('SIGKILL'); return true; }
  }
  if (alive() || groupAlive()) signalGroup('SIGKILL');
  return true;
}

/** Run one external termination command hard-bounded by `timeoutMs` (default
 * 1000ms): a stalled tool is killed and abandoned instead of being awaited
 * indefinitely. The command is deliberately NOT bound to any caller abort
 * signal — local process cleanup must complete even when the remote-control
 * budget that triggered it is already spent. Exported for contract tests;
 * production callers reach it through terminateRecordedProcessTree.
 * @param {string} command @param {readonly string[]} args @param {{timeoutMs?:number}} [options]
 * @returns {Promise<void>} */
export async function boundedProcessKill(command, args, options = {}) {
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && /** @type {number} */ (options.timeoutMs) >= 0 ? /** @type {number} */ (options.timeoutMs) : 1_000;
  const child = spawn(command, args, { shell: false, windowsHide: true, stdio: 'ignore' });
  // The killed-on-timeout tool must never hold this process's event loop open:
  // unref it so a hung taskkill cannot extend a SessionEnd hook's lifetime.
  child.unref?.();
  await new Promise((/** @type {(value?:undefined)=>void} */ resolve) => {
    /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
    const finish = () => { clearTimeout(timer); resolve(); };
    timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish(); }, timeoutMs);
    child.once('exit', finish);
    child.once('error', finish);
  });
}

/** @param {import('node:child_process').ChildProcess} child @param {{ graceMs?: number }} [options] */
export async function terminateProcess(child, options = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const graceMs = options.graceMs ?? 1_000;
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T'], { shell: false, windowsHide: true, stdio: 'ignore' });
  } else if (child.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  } else child.kill('SIGTERM');
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), graceMs);
    timer.unref?.();
  });
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))), timeout,
  ]);
  clearTimeout(timer);
  if (!exited && child.exitCode === null) {
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    else child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

/** @param {unknown} launch */
function validateLaunch(launch) {
  /** @type {any} */
  const value = launch;
  if (!value || typeof value !== 'object' || typeof value.command !== 'string'
    || value.command.length === 0 || !Array.isArray(value.args)
    || !value.args.every((/** @type {unknown} */ arg) => typeof arg === 'string')
    || value.target !== undefined && typeof value.target !== 'string'
    || value.windowsShim !== undefined && typeof value.windowsShim !== 'boolean') throw processInputError();
}

/** @param {string} target @param {string[]} args */
function windowsShimCommand(target, args) { if (/["\r\n]/.test(target) || !args.every((arg) => /^[A-Za-z0-9._:/=-]+$/.test(arg))) throw processInputError(); return `"${target}"${args.map((arg) => ` "${arg}"`).join('')}`; }

function processInputError() {
  return new PluginError('PROCESS_INPUT_INVALID', 'Process launch input is invalid.', {
    category: 'validation', remedy: 'Provide a command and an array of literal argv strings.',
  });
}
