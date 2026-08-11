import { spawn, spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';

import { PluginError, wrapError } from './errors.mjs';

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

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
  const { signal, ...spawnOptions } = options; const child = await spawnProcess(launch, spawnOptions); let stdout = ''; let stderr = ''; let overflow = false;
  child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
  const capture = (/** @type {'stdout'|'stderr'} */ kind, /** @type {string} */ chunk) => { if (kind === 'stdout') stdout += chunk; else stderr += chunk; if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxOutputBytes) { overflow = true; void terminateProcess(child).catch(() => {}); } };
  child.stdout?.on('data', (chunk) => capture('stdout', chunk)); child.stderr?.on('data', (chunk) => capture('stderr', chunk));
  let timer; const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
  let resolveAbort = () => {}; const abort = new Promise((resolve) => { resolveAbort = () => resolve('aborted'); }); signal?.addEventListener('abort', resolveAbort, { once: true });
  let outcome;
  try { outcome = await Promise.race([new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, childSignal) => resolve({ code, signal: childSignal })); }), timeout, abort]); }
  catch (error) { await terminateProcess(child).catch(() => {}); throw wrapError(error, 'ZCODE_PROCESS_FAILED', 'The ZCode process failed.', { category: 'runtime', remedy: 'Verify the installation and retry.' }); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', resolveAbort); }
  if (outcome === 'aborted') { await terminateProcess(child); throw new PluginError('ZCODE_PROCESS_ABORTED', 'The ZCode process was aborted.', { category: 'state', remedy: 'Retry when the operation should continue.' }); }
  if (outcome === 'timeout' || overflow) { await terminateProcess(child); throw new PluginError(outcome === 'timeout' ? 'ZCODE_PROCESS_TIMEOUT' : 'ZCODE_PROCESS_OUTPUT_LIMIT', outcome === 'timeout' ? 'The ZCode process timed out.' : 'The ZCode process exceeded its output limit.', { category: outcome === 'timeout' ? 'timeout' : 'runtime', remedy: 'Inspect the ZCode installation and retry.', details: { timeoutMs, maxOutputBytes } }); }
  return { ...outcome, stdout, stderr };
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
