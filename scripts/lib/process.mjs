import { spawn, spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';

import { PluginError, wrapError } from './errors.mjs';

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

/** @param {string} path @param {string} [execPath] */
export function launchForPath(path, execPath = process.execPath) {
  if (typeof path !== 'string' || path.length === 0) throw processInputError();
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
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
 * @param {{ command: string, args: string[], target?: string }} launch
 * @param {{ args?: string[], cwd?: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal }} [options]
 */
export async function spawnProcess(launch, options = {}) {
  validateLaunch(launch);
  await assertLaunchTarget(launch);
  try {
    return spawn(launch.command, [...launch.args, ...(options.args ?? [])], {
      cwd: options.cwd, env: options.env, signal: options.signal,
      detached: process.platform !== 'win32', shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw wrapError(error, 'ZCODE_SPAWN_FAILED', 'Could not start ZCode.', {
      category: 'runtime', remedy: 'Verify the ZCode installation and run $zcode:setup.',
    });
  }
}

/** @param {{command:string,args:string[],target?:string}} launch @param {{args?:string[],cwd?:string,env?:NodeJS.ProcessEnv}} [options] */
export async function spawnDaemon(launch, options = {}) {
  validateLaunch(launch); await assertLaunchTarget(launch);
  const child = spawn(launch.command, [...launch.args, ...(options.args ?? [])], { cwd: options.cwd, env: options.env, detached: true, shell: false, windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref(); return child;
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
    || value.target !== undefined && typeof value.target !== 'string') throw processInputError();
}

function processInputError() {
  return new PluginError('PROCESS_INPUT_INVALID', 'Process launch input is invalid.', {
    category: 'validation', remedy: 'Provide a command and an array of literal argv strings.',
  });
}
