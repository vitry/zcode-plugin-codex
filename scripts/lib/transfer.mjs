import { randomBytes } from 'node:crypto';

import { PluginError } from './errors.mjs';
import { hasControl, isSafeIdentifier } from './identifier.mjs';
import { withJobCancellationLock } from './job-control.mjs';
import { removeResultArtifact, writeResultArtifact } from './review.mjs';
import { withWorkerLease } from './recovery.mjs';
import { IMPORTED_HISTORY_SOURCE } from './zcode-client.mjs';

export const TRANSFER_LIMITS = Object.freeze({
  maxThreadIdBytes: 512,
  maxMessages: 10_000,
  maxMessageBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
});
export const TRANSFER_WIRE_LIMITS = Object.freeze({
  maxEncodedHistoryBytes: 15 * 1024 * 1024,
  maxFrameBytes: 16 * 1024 * 1024,
  maxOutboundBytes: 16 * 1024 * 1024,
  drainTimeoutMs: 5_000,
});

/** @param {{source?:string}} options @param {{sessionId?:string,[key:string]:unknown}} caller */
export function resolveTransferSource(options, caller) {
  const source = options?.source ?? caller?.sessionId;
  if (typeof source !== 'string' || !boundedText(source, TRANSFER_LIMITS.maxThreadIdBytes) || hasControl(source)) throw new PluginError('TRANSFER_SOURCE_INVALID', 'A valid persisted Codex thread ID is required.', { category: 'validation', remedy: 'Invoke Transfer from a persisted Codex thread or pass --source with an accessible thread ID.' });
  return source;
}

/** @param {unknown} thread @param {string} expectedThreadId */
export function extractImportedHistory(thread, expectedThreadId) {
  if (!plainObject(thread) || thread.id !== expectedThreadId || typeof thread.ephemeral !== 'boolean' || !Array.isArray(thread.turns)) throw invalidThread();
  if (thread.ephemeral) throw new PluginError('CODEX_THREAD_EPHEMERAL', 'Ephemeral Codex threads cannot be transferred.', { category: 'configuration', remedy: 'Persist the Codex thread, then retry Transfer.' });
  const record = thread;
  /** @type {Array<{role:'user'|'assistant',content:string,timestamp?:number}>} */ const messages = []; let totalBytes = 0;
  for (const turn of record.turns) {
    if (!plainObject(turn) || !Array.isArray(turn.items) || turn.startedAt !== undefined && turn.startedAt !== null && (!Number.isSafeInteger(turn.startedAt) || turn.startedAt < 0)) throw invalidThread();
    const timestamp = turn.startedAt === undefined || turn.startedAt === null ? undefined : turn.startedAt * 1000;
    if (timestamp !== undefined && !Number.isSafeInteger(timestamp)) throw invalidThread();
    for (const item of turn.items) {
      if (!plainObject(item) || typeof item.type !== 'string') throw invalidThread();
      if (item.type === 'userMessage') {
        if (!Array.isArray(item.content) || item.content.some((/** @type {unknown} */ part) => !plainObject(part) || typeof part.type !== 'string')) throw invalidThread();
        /** @type {string[]} */ const textParts = [];
        for (const part of item.content) {
          if (part.type !== 'text') continue;
          if (typeof part.text !== 'string') throw invalidThread();
          if (part.text.trim()) textParts.push(part.text);
        }
        if (textParts.length) addMessage(messages, { role: 'user', content: textParts.join('\n'), ...(timestamp === undefined ? {} : { timestamp }) }, () => totalBytes, (value) => { totalBytes = value; });
      } else if (item.type === 'agentMessage') {
        if (typeof item.text !== 'string') throw invalidThread();
        if (item.text.trim()) addMessage(messages, { role: 'assistant', content: item.text, ...(timestamp === undefined ? {} : { timestamp }) }, () => totalBytes, (value) => { totalBytes = value; });
      }
    }
  }
  if (!messages.length) throw new PluginError('TRANSFER_HISTORY_EMPTY', 'The Codex thread has no transferable visible text.', { category: 'validation', remedy: 'Choose a thread containing user or assistant text.' });
  const history = { messages };
  if (Buffer.byteLength(JSON.stringify({ source: IMPORTED_HISTORY_SOURCE, ...history })) > TRANSFER_WIRE_LIMITS.maxEncodedHistoryBytes) throw historyTooLarge();
  return history;
}

/**
 * @param {{job:any,workspace:string,dataRoot:string,store:any,sourceThreadId:string,launch?:{command:string,args:string[]},resolveLaunch?:()=>Promise<{command:string,args:string[]}>,readThread:()=>Promise<unknown>,createClient:(launch:{command:string,args:string[]})=>Promise<any>,writeResult?:(input:any)=>Promise<string>,removeResult?:(input:any)=>Promise<void>}} input
 */
export async function executeTransfer(input) {
  validateExecution(input);
  const workerLeaseId = randomBytes(32).toString('hex');
  return withWorkerLease({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: input.job.id, workerLeaseId }, async () => {
    const job = await input.store.claimJobWorker(input.workspace, input.job.id, { childPid: process.pid, workerLeaseId });
    return executeClaimedTransfer({ ...input, job });
  });
}

/** @param {any} input */
async function executeClaimedTransfer(input) {
  const { job, workspace, dataRoot, store, sourceThreadId } = input;
  let client; let running = job;
  try {
    validateExecution(input);
    running = await store.transitionJob(workspace, job.id, ['queued'], 'running', { startedAt: new Date().toISOString() });
    const importedHistory = extractImportedHistory(await input.readThread(), sourceThreadId);
    const launch = input.launch ?? await /** @type {()=>Promise<{command:string,args:string[]}>} */ (input.resolveLaunch)();
    validateLaunch(launch);
    client = await input.createClient(launch);
    const snapshot = await client.createSession({ workspace, importedHistory });
    const sessionId = snapshot?.session?.sessionId;
    if (!isSafeIdentifier(sessionId)) throw new PluginError('ZCODE_OUTPUT_INVALID', 'ZCode returned an invalid imported session.', { category: 'protocol', remedy: 'Upgrade or restart ZCode and retry.' });
    running = await store.transitionJob(workspace, job.id, ['running'], 'running', { zcodeSessionId: sessionId });
    const resumeCommand = buildResumeCommand(launch, sessionId);
    const result = `Imported from Codex\nZCode session ID: ${sessionId}\nResume in ZCode: ${resumeCommand}\n`;
    const resultArtifact = await (input.writeResult ?? writeResultArtifact)({ dataRoot, workspace, jobId: job.id, contents: result });
    const succeeded = await withJobCancellationLock({ dataRoot, workspace, jobId: job.id }, async () => {
      const current = await store.readJob(workspace, job.id);
      if (current.status === 'cancelled') return current;
      if (current.status !== 'running') throw new PluginError('TRANSFER_FINALIZE_CONFLICT', `Transfer job ${job.id} cannot finalize from ${current.status}.`, { category: 'state', remedy: 'Inspect the job status and retry with a new Transfer.' });
      return store.transitionJob(workspace, job.id, ['running'], 'succeeded', { resultArtifact, finishedAt: new Date().toISOString(), exitCode: 0 });
    });
    if (succeeded.status === 'cancelled') {
      await (input.removeResult ?? removeResultArtifact)({ dataRoot, workspace, jobId: job.id, artifact: resultArtifact });
      throw new PluginError('TRANSFER_CANCELLED', `Transfer job ${job.id} was cancelled.`, { category: 'state', remedy: 'Run Transfer again if the imported session is still needed.' });
    }
    return { type: 'transfer', job: succeeded, result, zcodeSessionId: sessionId, resumeCommand };
  } catch (error) {
    await withJobCancellationLock({ dataRoot, workspace, jobId: job.id }, async () => {
      const current = await store?.readJob(workspace, job?.id).catch(() => running);
      if (['queued', 'running'].includes(current?.status)) await store.transitionJob(workspace, job.id, [current.status], 'failed', { error: { message: error instanceof Error ? error.message.slice(0, 2048) : 'Transfer failed' }, finishedAt: new Date().toISOString(), exitCode: 1 });
    }).catch(() => {});
    throw error;
  } finally { await client?.close().catch(() => {}); }
}

/** @param {{command:string,args:string[]}} launch @param {string} sessionId */
export function buildResumeCommand(launch, sessionId) { return [launch.command, ...launch.args, '--resume', sessionId].map(shellQuote).join(' '); }

/** @param {Array<{role:'user'|'assistant',content:string,timestamp?:number}>} messages @param {{role:'user'|'assistant',content:string,timestamp?:number}} message @param {()=>number} readTotal @param {(value:number)=>void} writeTotal */
function addMessage(messages, message, readTotal, writeTotal) {
  const bytes = Buffer.byteLength(message.content); const total = readTotal() + bytes;
  if (bytes > TRANSFER_LIMITS.maxMessageBytes || messages.length >= TRANSFER_LIMITS.maxMessages || total > TRANSFER_LIMITS.maxTotalBytes) throw historyTooLarge();
  messages.push(message); writeTotal(total);
}
/** @param {any} input */
function validateExecution(input) {
  if (!plainObject(input) || !plainObject(input.job) || input.job.command !== 'transfer' || input.job.codexThreadId !== input.sourceThreadId || input.job.readOnly !== true || typeof input.workspace !== 'string' || !input.workspace || typeof input.dataRoot !== 'string' || !input.dataRoot || input.launch === undefined && typeof input.resolveLaunch !== 'function' || input.launch !== undefined && !validLaunch(input.launch) || typeof input.readThread !== 'function' || typeof input.createClient !== 'function') throw new PluginError('TRANSFER_INPUT_INVALID', 'Transfer execution input is invalid.', { category: 'validation', remedy: 'Reserve a read-only Transfer job bound to the exact Codex source.' });
}
/** @param {unknown} launch @returns {launch is {command:string,args:string[]}} */
function validLaunch(launch) { return plainObject(launch) && typeof launch.command === 'string' && launch.command.length > 0 && !hasControl(launch.command) && Array.isArray(launch.args) && launch.args.every((/** @type {unknown} */ arg) => typeof arg === 'string' && !hasControl(arg)); }
/** @param {unknown} launch */
function validateLaunch(launch) { if (!validLaunch(launch)) throw new PluginError('TRANSFER_INPUT_INVALID', 'Resolved ZCode launcher is invalid.', { category: 'configuration', remedy: 'Run $zcode:setup and repair the ZCode launcher.' }); }
/** @param {unknown} value @param {number} maximum */
function boundedText(value, maximum) { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maximum; }
/** @param {unknown} value @returns {value is Record<string,any>} */
function plainObject(value) { if (value === null || typeof value !== 'object' || Array.isArray(value)) return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
/** @param {string} value */
function shellQuote(value) { return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`; }
function invalidThread() { return new PluginError('CODEX_THREAD_INVALID', 'Codex returned an invalid or mismatched thread.', { category: 'protocol', remedy: 'Upgrade or restart Codex, then retry Transfer.' }); }
function historyTooLarge() { return new PluginError('TRANSFER_HISTORY_TOO_LARGE', 'The Codex thread exceeds Transfer history limits.', { category: 'validation', remedy: `Choose a smaller thread (at most ${TRANSFER_LIMITS.maxMessages} messages, ${TRANSFER_LIMITS.maxMessageBytes} bytes each, and ${TRANSFER_LIMITS.maxTotalBytes} bytes total).` }); }
