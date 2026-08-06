import { spawn } from 'node:child_process';
import { write } from 'node:fs';

import { PluginError } from './errors.mjs';
import { terminateProcess } from './process.mjs';

const ACK = 'ready\n';
export const BACKGROUND_WORKER_START_TIMEOUT_MS = 30_000;

/** Start the private worker, deliver its capability internally, and detach only after a bounded acknowledgement. @param {{companionPath:string,jobId:string,executionCapability:string,cwd:string,env?:NodeJS.ProcessEnv,timeoutMs?:number,dependencies?:{setTimeout?:(callback:()=>void,ms:number)=>any,clearTimeout?:(timer:any)=>void}}} input */
export async function startBackgroundWorker({ companionPath, jobId, executionCapability, cwd, env, timeoutMs = BACKGROUND_WORKER_START_TIMEOUT_MS, dependencies = {} }) {
  if (![companionPath, jobId, executionCapability, cwd].every((value) => typeof value === 'string' && value) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) throw workerError('BACKGROUND_WORKER_INPUT_INVALID', 'Background worker input is invalid.');
  const child = spawn(process.execPath, [companionPath, 'run-reserved-job', jobId], { cwd, env: { ...env, ZCODE_BACKGROUND_WORKER: '1' }, detached: process.platform !== 'win32', windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const authorization = /** @type {import('node:stream').Writable} */ (child.stdio[3]); const acknowledgements = /** @type {import('node:stream').Readable} */ (child.stdio[4]);
  authorization.end(`${JSON.stringify({ executionCapability, jobId })}\n`);
  let timer; let ack = '';
  const scheduleTimeout = dependencies.setTimeout ?? setTimeout; const cancelTimeout = dependencies.clearTimeout ?? clearTimeout;
  try {
    await new Promise((resolve, reject) => {
      timer = scheduleTimeout(() => reject(workerError('BACKGROUND_WORKER_START_TIMEOUT', 'Background worker did not acknowledge startup.')), timeoutMs);
      acknowledgements.setEncoding('utf8');
      acknowledgements.on('data', (chunk) => { ack += chunk; if (Buffer.byteLength(ack) > 32) reject(workerError('BACKGROUND_WORKER_ACK_INVALID', 'Background worker returned an invalid startup acknowledgement.')); else if (ack.includes('\n')) ack === ACK ? resolve(undefined) : reject(workerError('BACKGROUND_WORKER_ACK_INVALID', 'Background worker returned an invalid startup acknowledgement.')); });
      child.once('error', (cause) => reject(workerError('BACKGROUND_WORKER_START_FAILED', 'Background worker could not start.', cause)));
      child.once('exit', (code, signal) => reject(workerError('BACKGROUND_WORKER_START_FAILED', `Background worker exited before startup acknowledgement (${code ?? signal}).`)));
    });
    acknowledgements.destroy(); child.unref(); return { pid: child.pid };
  } catch (error) {
    await terminateProcess(child, { graceMs: 500 }).catch(() => {}); throw error;
  } finally { cancelTimeout(timer); }
}

/** @param {number} [fd] */
export function acknowledgeBackgroundStartup(fd = 4) {
  return new Promise((resolve, reject) => write(fd, Buffer.from(ACK), (error, bytesWritten) => error || bytesWritten !== Buffer.byteLength(ACK) ? reject(workerError('BACKGROUND_WORKER_ACK_FAILED', 'Background worker could not acknowledge startup.', error)) : resolve(undefined)));
}

/** @param {string} code @param {string} message @param {unknown} [cause] */
function workerError(code, message, cause) { return new PluginError(code, message, { category: 'runtime', remedy: 'Retry the background invocation from the active Codex turn.', cause }); }
