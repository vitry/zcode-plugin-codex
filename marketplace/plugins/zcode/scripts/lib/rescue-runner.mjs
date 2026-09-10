import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

import { PluginError, wrapError } from './errors.mjs';
import { isSafeIdentifier } from './identifier.mjs';

/**
 * Private Host-runner subcommand. The same installed Node companion entry
 * resolves this selector into the shared Host-owned rescue execution path; it
 * is the only launch argument besides the canonical workspace/job selector.
 */
export const RESCUE_RUNNER_SUBCOMMAND = 'run-host-rescue-job';

/**
 * Spawn one detached Rescue runner for an already-reserved Host-owned
 * background Rescue job. This is the OS spawn adapter only: it launches the
 * same installed Node entry with the private Host-runner subcommand and the
 * canonical workspace/job selector, awaits only the operating system's
 * successful-spawn event, then detaches. The spawn event catches deterministic
 * OS creation errors and is not a runner-readiness handshake — there is no fd
 * capability transport, no acknowledgement pipe, no readiness timer, and no
 * legacy worker environment selector on this path. `env` is passed through
 * exactly as given because the caller owns the bounded runtime environment.
 * Reservation, settlement, and every lifecycle decision stay in the existing
 * modules; this adapter never terminalizes anything parent-side.
 * @param {{
 *   companionPath: string,
 *   workspace: string,
 *   jobId: string,
 *   env: NodeJS.ProcessEnv,
 *   spawnChild?: typeof spawn,
 * }} input
 * @returns {Promise<{pid: number | undefined}>}
 */
export async function spawnRescueRunner({ companionPath, workspace, jobId, env, spawnChild = spawn }) {
  const invalidFields = [];
  if (!isAbsoluteEntry(companionPath)) invalidFields.push('companionPath');
  if (!isAbsoluteEntry(workspace)) invalidFields.push('workspace');
  if (!isDigest(jobId)) invalidFields.push('jobId');
  if (!isBoundedEnvironment(env)) invalidFields.push('env');
  if (spawnChild !== undefined && typeof spawnChild !== 'function') invalidFields.push('spawnChild');
  if (invalidFields.length > 0) throw invalidRunnerInput(invalidFields);
  let child;
  try {
    child = spawnChild(process.execPath,
      [companionPath, RESCUE_RUNNER_SUBCOMMAND, jobId], {
        cwd: workspace, env, detached: true, windowsHide: true,
        shell: false, stdio: 'ignore',
      });
  } catch (error) {
    throw runnerSpawnError(error);
  }
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });
  } catch (error) {
    keepLateChildErrorListener(child);
    throw runnerSpawnError(error);
  }
  // The launch promise is settled, but a detached runner can still report a
  // late spawn-path error; keep an error listener so it can never become an
  // unhandled parent exception. A later exit is equally ignored: runner
  // terminalization belongs to the lifecycle modules, never to this adapter.
  keepLateChildErrorListener(child);
  child.unref();
  return { pid: child.pid };
}

/** An entry and a workspace must be absolute paths; resolution stays with the caller. @param {unknown} value */
function isAbsoluteEntry(value) {
  return typeof value === 'string' && isAbsolute(value);
}

/** Job identifiers are the existing 64-character lowercase hex digests. @param {unknown} value @returns {value is string} */
function isDigest(value) {
  return typeof value === 'string' && isSafeIdentifier(value) && /^[a-f0-9]{64}$/.test(value);
}

/**
 * The caller must hand over a bounded environment object explicitly; an absent
 * environment would silently inherit the parent process environment instead.
 * @param {unknown} value
 */
function isBoundedEnvironment(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keep one listener so any late child error stays swallowed. @param {import('node:child_process').ChildProcess} child */
function keepLateChildErrorListener(child) {
  child.on('error', () => {});
}

/** @param {unknown} error */
function runnerSpawnError(error) {
  return wrapError(error, 'RESCUE_RUNNER_SPAWN_FAILED', 'Could not start the detached Rescue runner process.', {
    category: 'runtime',
    remedy: 'Retry the background Rescue invocation from the active Codex turn.',
  });
}

/** @param {string[]} invalidFields */
function invalidRunnerInput(invalidFields) {
  return new PluginError('RESCUE_RUNNER_INPUT_INVALID', 'The detached Rescue runner launch input is invalid.', {
    category: 'runtime',
    remedy: 'Provide an absolute companion entry, an absolute workspace, a digest job id, and a bounded runtime environment.',
    details: { invalidFields },
  });
}
