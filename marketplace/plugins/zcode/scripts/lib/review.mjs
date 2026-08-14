import { constants } from 'node:fs';
import { open, rename, chmod, lstat, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import { PluginError } from './errors.mjs';
import { resolveModel } from './args.mjs';
import { ensurePrivateDirectory, withFileLock } from './fs.mjs';
import { collectGitFacts } from './git.mjs';
import { createJobController, withJobCancellationLock } from './job-control.mjs';
import { createProgressReporter, waitForCompletionOrAbort } from './progress.mjs';
import { createDeferredConversationProgressObserver } from './conversation-progress.mjs';
import { buildPrompt } from './prompts.mjs';
import { loadReviewOutputSchema, validateJsonSchema } from './review-schema.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';

const READ_TOOLS = /^(read|inspect|search|list|find|glob|grep|git(?:[-_ ]?(?:status|diff|log|show))?)$/i;
const MUTATING_TOOLS = /(write|edit|patch|delete|remove|create|exec|shell|command|install|move|rename|commit|push)/i;
const OPTIONAL_PROGRESS_FENCE_MS = 250;
const REVIEW_OUTPUT_SCHEMA = await loadReviewOutputSchema();

/** @param {any} request @param {any} permissionSnapshot @param {string} command */
export function decidePermission(request, permissionSnapshot, command) {
  const offered = Array.isArray(request?.options) ? request.options.map((/** @type {any} */ option) => option?.response).filter(validResponse) : [];
  const allow = offered.find((/** @type {any} */ response) => response.decision === 'allow');
  const deny = offered.find((/** @type {any} */ response) => response.decision === 'deny');
  const risk = typeof request?.riskLevel === 'string' ? request.riskLevel.toLowerCase() : 'unknown';
  let permitted = false;
  if (command === 'review' || command === 'adversarial-review') permitted = risk === 'low' && READ_TOOLS.test(request?.toolName ?? '') && !MUTATING_TOOLS.test(request?.toolName ?? '');
  else if (command === 'rescue') permitted = ['low', 'medium'].includes(risk) || ['high', 'critical'].includes(risk) && permissionSnapshot?.permissionMode === 'bypassPermissions';
  if (permitted && allow) return allow;
  if (deny) return deny;
  throw new PluginError('PERMISSION_DENY_UNAVAILABLE', 'ZCode did not offer a deny response for a request that cannot be allowed.', { category: 'authorization', remedy: 'Reject the incompatible permission request and upgrade or restart ZCode.' });
}

/**
 * @param {{job:any,workspace:string,dataRoot:string,store:any,client:any,scope?:string,base?:string,focus?:string,task?:string,model?:any,modelRequest?:string,modelAliases?:Record<string,unknown>,effort?:string,resumeSessionId?:string,onBeforeResume?:(job:any)=>Promise<void>,childPid?:number,workerLeaseId?:string,onBoundaryPersisted?:(job:any)=>Promise<void>,syncDirectory?:(path:string)=>Promise<void>,progressWriter?:(line:string)=>void,progressDependencies?:{now?:()=>string,setInterval?:(callback:()=>void,milliseconds:number)=>any,clearInterval?:(timer:any)=>void},signal?:AbortSignal}} input
 */
export async function executeJob(input) {
  const { job, client, workspace, dataRoot } = input;
  let running = job;
  /** @type {string|undefined} */
  let sessionId;
  let sendAttempted = false; let remoteTerminalProven = false;
  /** @type {any} */
  let reporter;
  /** @type {any} */ let conversationObserver;
  let unsubscribeNotifications = () => {}; let unsubscribeConversation = async () => {};
  /** @type {unknown} */
  let primaryError;
  /** @type {any} */
  let output;
  let progressCleaned = false;
  const cleanupProgress = async () => {
    if (progressCleaned) return;
    progressCleaned = true;
    try { reporter?.stopAccepting(); } catch { /* progress-only */ }
    try { unsubscribeNotifications(); } catch { reporter?.diagnose('conversation-unsubscribe-failed'); }
    let remoteCleanup = Promise.resolve();
    try { remoteCleanup = Promise.resolve(unsubscribeConversation()).catch(() => { reporter?.diagnose('conversation-unsubscribe-failed'); }); }
    catch { reporter?.diagnose('conversation-unsubscribe-failed'); }
    const deadline = Date.now() + OPTIONAL_PROGRESS_FENCE_MS;
    const initialDrain = Promise.resolve().then(() => reporter?.flush(deadline)).catch(() => {});
    const remoteDrain = remoteCleanup.then(() => Promise.resolve()).then(() => reporter?.flush(deadline)).catch(() => {});
    const aggregateSettled = await waitForOptionalProgress(Promise.all([initialDrain, remoteDrain]), deadline);
    if (!aggregateSettled) {
      reporter?.diagnose('progress-flush-timeout');
      const timeoutDrain = Promise.resolve().then(() => reporter?.flush(deadline)).catch(() => {});
      await waitForOptionalProgress(timeoutDrain, deadline);
    }
    try { conversationObserver?.markTerminal(); } catch { /* progress-only */ }
    try { reporter?.close(); } catch { /* progress-only */ }
  };
  try {
    let prompt;
    if (job.command === 'review' || job.command === 'adversarial-review') {
      const gitFacts = await collectGitFacts({ workspace, scope: input.scope, base: input.base });
      prompt = await buildPrompt({ command: job.command, focus: input.focus, gitFacts });
    } else prompt = await buildPrompt({ command: 'rescue', task: input.task });
    const promptArtifact = await writeArtifact({ dataRoot, workspace, directory: 'prompts', jobId: job.id, contents: prompt }, { syncDirectory: input.syncDirectory });
    let snapshot;
    input.signal?.throwIfAborted();
    if (input.resumeSessionId) {
      await input.onBeforeResume?.(job);
      input.signal?.throwIfAborted();
      sessionId = input.resumeSessionId;
      snapshot = await boundedStep(() => client.resumeSession(input.resumeSessionId), input.signal);
    } else snapshot = await boundedStep(async () => {
      const created = await client.createSession({ workspace, ...(input.model ? { model: input.model } : {}) });
      sessionId = created?.session?.sessionId;
      return created;
    }, input.signal);
    const activeSessionId = /** @type {string} */ (sessionId ?? snapshot.session.sessionId);
    sessionId = activeSessionId;
    conversationObserver = createDeferredConversationProgressObserver({ sessionId: activeSessionId, workspace });
    reporter = createProgressReporter({
      sessionId: activeSessionId,
      deferred: true,
      ...(input.progressWriter ? { write: input.progressWriter } : {}),
      persist: (event) => input.store.updateJobProgress(workspace, job.id, event),
      describeNotification: conversationObserver.observe,
      onDescriptorOverflow: conversationObserver.markGap,
      ...input.progressDependencies,
    });
    try { unsubscribeNotifications = client.subscribe(reporter.observe); } catch { unsubscribeNotifications = () => {}; }
    if (typeof client.subscribeConversation === 'function') {
      try {
        const conversationSubscription = await client.subscribeConversation(activeSessionId, { connectionId: `companion-${randomBytes(12).toString('hex')}`, clientMode: 'desktop-continuous' });
        // Register cleanup before binding can perform any asynchronous work.
        unsubscribeConversation = conversationSubscription.unsubscribe;
        await conversationObserver.bind(conversationSubscription.subscriptionId);
      } catch { conversationObserver.fail(); reporter.diagnose('conversation-subscribe-failed'); }
    } else conversationObserver.fail();
    const selectedModel = input.modelRequest ? resolveModel(input.modelRequest, input.modelAliases, snapshot.settings.model.available) : input.model;
    if (selectedModel && !sameModel(snapshot.settings.model.current, selectedModel)) snapshot = await boundedStep(() => client.setModel(activeSessionId, selectedModel), input.signal);
    if (input.effort) snapshot = await boundedStep(() => client.setThoughtLevel(activeSessionId, input.effort), input.signal);
    client.setPermissionHandler((/** @type {any} */ request) => decidePermission(request, job.permissionSnapshot, job.command));
    const now = new Date().toISOString();
    running = await input.store.transitionJob(workspace, job.id, ['queued'], 'running', {
      startedAt: now, zcodeSessionId: activeSessionId, promptArtifact,
      ...(input.childPid ? { childPid: input.childPid } : {}),
      ...(input.workerLeaseId ? { workerLeaseId: input.workerLeaseId } : {}),
      ...(selectedModel ? { model: selectedModel } : {}), ...(input.effort ? { effort: input.effort } : {}),
    });
    input.signal?.throwIfAborted();
    const beforeMessageIds = [...snapshotMessageIds(snapshot)]; sendAttempted = true; const sent = await boundedStep(() => client.send(activeSessionId, prompt), input.signal);
    reporter.activate({ method: 'state.updated', params: { scope: 'session', sessionId: activeSessionId, reason: 'prompt_started' } });
    running = await input.store.transitionJob(workspace, job.id, ['running'], 'running', { inputId: sent.inputId, startRevision: sent.stateRevision, beforeMessageIds });
    await input.onBoundaryPersisted?.(running);
    const turnBoundary = { beforeMessageIds: new Set(beforeMessageIds), ...sent };
    await waitForCompletionOrAbort(client.waitForCompletion(activeSessionId), input.signal);
    await cleanupProgress();
    const finalSnapshot = await client.readSession(activeSessionId);
    remoteTerminalProven = true;
    const result = extractFinalResult(finalSnapshot, job.command, turnBoundary);
    output = await publishSuccessfulResult({ input, job, workspace, dataRoot, result });
  } catch (error) {
    primaryError = error instanceof SuccessfulResultFinalizationError ? error.cause : error;
    const current = await input.store.readJob(workspace, job.id).catch(() => running);
    if (error instanceof SuccessfulResultFinalizationError) {
      if (current?.status === 'succeeded' && current.resultArtifact === error.resultArtifact) {
        try { output = { job: current, result: await readResultArtifact({ dataRoot, workspace, artifact: error.resultArtifact }) }; primaryError = undefined; }
        catch (artifactError) { primaryError = artifactError; }
      }
      else if (current && ['failed', 'cancelled', 'succeeded'].includes(current.status) && current.resultArtifact !== error.resultArtifact) await removeResultArtifact({ dataRoot, workspace, jobId: job.id, artifact: error.resultArtifact }).catch(() => {});
      /* Otherwise recovery owns the durable running job and retained result artifact. */
    }
    else if (isInterruption(error) && current && !['failed', 'succeeded', 'cancelled'].includes(current.status)) {
      if (current.status === 'queued' && sessionId) {
        let stopped = false;
        try { await client.stopSession(sessionId); stopped = true; } catch { /* retain the writable guard when remote stop is unacknowledged */ }
        if (stopped) try { await input.store.finishJob(workspace, job.id, ['queued'], 'cancelled', { exitCode: null }); } catch (finalizeError) { primaryError = finalizeError; }
      } else {
        const cancellation = createJobController({ store: input.store, dataRoot, stopSession: (id) => client.stopSession(id) });
        await cancellation.cancel(workspace, job.id, job.ownerSessionId).catch(() => {});
      }
    } else if (current && !['failed', 'succeeded', 'cancelled', 'cancelling'].includes(current.status)) {
      let canFail = true;
      if (current.status === 'running' && sendAttempted && sessionId && !remoteTerminalProven) {
        try { await client.stopSession(sessionId); }
        catch (stopError) {
          await input.store.transitionJob(workspace, job.id, ['running'], 'running', { lastCancelError: safeError(stopError).message }).catch(() => {});
          canFail = false;
        }
      }
      if (canFail) try { await input.store.finishJob(workspace, job.id, [current.status], 'failed', { error: safeError(error), exitCode: 1 }); } catch (finalizeError) { primaryError = finalizeError; }
    }
  }
  // Cleanup order is part of the progress lifecycle contract.
  await cleanupProgress();
  await client.close().catch(() => {});
  if (primaryError) throw primaryError;
  return output;
}

/** @param {Promise<unknown>} operation @param {number} deadline */
async function waitForOptionalProgress(operation, deadline) {
  let completed = false;
  const tracked = operation.then(() => { completed = true; }).catch(() => { completed = true; });
  /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
  try {
    const timeoutMs = Math.max(0, deadline - Date.now());
    if (timeoutMs > 0) await Promise.race([tracked, new Promise((resolvePromise) => { timer = setTimeout(resolvePromise, timeoutMs); })]);
    for (let phase = 0; phase < 2 && !completed; phase += 1) {
      await new Promise((resolvePromise) => setImmediate(resolvePromise)); await Promise.resolve();
    }
  }
  catch { /* optional progress cleanup */ }
  finally { if (timer !== undefined) clearTimeout(timer); }
  return completed;
}

/** Serialize executor terminal publication with cancellation and lifecycle maintenance. @param {{input:any,job:any,workspace:string,dataRoot:string,result:string}} publication */
async function publishSuccessfulResult({ input, job, workspace, dataRoot, result }) {
  return withJobCancellationLock({ dataRoot, workspace, jobId: job.id }, async () => {
    const current = await input.store.readJob(workspace, job.id);
    if (current.status === 'succeeded') return { job: current, result: await readResultArtifact({ dataRoot, workspace, artifact: current.resultArtifact }) };
    if (['failed', 'cancelled'].includes(current.status)) throw terminalPublicationError(job.id, current.status);
    if (current.status !== 'running') throw statusPublicationError(job.id, current.status);
    const resultArtifact = await writeResultArtifact({ dataRoot, workspace, jobId: job.id, contents: result }, { syncDirectory: input.syncDirectory });
    try {
      const succeeded = await input.store.finishJob(workspace, job.id, ['running'], 'succeeded', { resultArtifact, exitCode: 0 });
      return { job: succeeded, result };
    } catch (error) {
      const winner = await input.store.readJob(workspace, job.id).catch(() => null);
      if (winner?.status === 'succeeded' && winner.resultArtifact === resultArtifact) return { job: winner, result: await readResultArtifact({ dataRoot, workspace, artifact: resultArtifact }) };
      if (winner?.status === 'running') throw new SuccessfulResultFinalizationError(error, resultArtifact);
      if (!winner) throw new SuccessfulResultFinalizationError(error, resultArtifact);
      if (winner.resultArtifact !== resultArtifact) await removeResultArtifact({ dataRoot, workspace, jobId: job.id, artifact: resultArtifact }).catch(() => {});
      throw error;
    }
  });
}

export class SuccessfulResultFinalizationError extends Error {
  /** @param {unknown} cause @param {string} resultArtifact */
  constructor(cause, resultArtifact) { super('Successful result could not be finalized.', { cause }); this.name = 'SuccessfulResultFinalizationError'; this.resultArtifact = resultArtifact; }
}

/** @param {string} jobId @param {string} status */
function terminalPublicationError(jobId, status) {
  return new PluginError('JOB_TERMINAL', `Job ${jobId} is already terminal.`, { category: 'state', remedy: 'Create a new job instead of changing a terminal job.', details: { jobId, status } });
}

/** @param {string} jobId @param {string} status */
function statusPublicationError(jobId, status) {
  return new PluginError('JOB_STATUS_CONFLICT', `Job ${jobId} changed status unexpectedly.`, { category: 'state', remedy: 'Reload the job and retry from its current status.', details: { actualStatus: status, expectedStatuses: ['running'], jobId } });
}

/** @template T @param {()=>Promise<T>} operation @param {AbortSignal|undefined} signal */
async function boundedStep(operation, signal) {
  signal?.throwIfAborted();
  try { const value = await operation(); signal?.throwIfAborted(); return value; }
  catch (error) { signal?.throwIfAborted(); throw error; }
}

/** @param {{dataRoot:string,workspace:string,artifact:string}} input */
export async function readResultArtifact({ dataRoot, workspace, artifact }) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const pieces = artifact.split(/[\\/]/); if (pieces.length !== 2 || pieces[0] !== 'results' || !pieces[1]) throw artifactError();
  try {
    return await withFileLock(join(storage.directory, '.artifacts.lock'), async () => {
      const root = await secureArtifactRoot(storage.directory, 'results', false); const path = join(root, pieces[1]);
      const pathInfo = await lstat(path); if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) throw artifactError();
      if (await realpath(dirname(path)) !== root) throw artifactError();
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await handle.stat(); const contents = await handle.readFile('utf8'); const handleAfter = await handle.stat();
        const after = await lstat(path); if (after.isSymbolicLink() || !after.isFile() || await realpath(dirname(path)) !== root) throw artifactError();
        const pathHandle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const pathAfter = await pathHandle.stat();
          if (!sameFileIdentity(before, handleAfter) || !sameFileIdentity(before, pathAfter)) throw artifactError();
        }
        finally { await pathHandle.close(); }
        return contents;
      }
      finally { await handle.close(); }
    });
  } catch (error) { throw new PluginError('RESULT_READ_FAILED', 'Could not safely read the result artifact.', { category: 'storage', remedy: 'Inspect the private workspace result store.', cause: error }); }
}

/** @param {{dataRoot:string,workspace:string,jobId:string,contents:string}} input @param {{syncDirectory?:(path:string)=>Promise<void>}} [dependencies] */
export function writeResultArtifact(input, dependencies = {}) { return writeArtifact({ ...input, directory: 'results' }, dependencies); }

/** @param {{dataRoot:string,workspace:string,jobId:string,artifact:string}} input */
export async function removeResultArtifact(input) {
  const storage = await resolveWorkspaceStorage(input); const expected = `results/${input.jobId}.md`;
  if (input.artifact !== expected) throw artifactError();
  await withFileLock(join(storage.directory, '.artifacts.lock'), async () => {
    const root = await secureArtifactRoot(storage.directory, 'results', false); const path = join(root, `${input.jobId}.md`);
    const info = await lstat(path); if (info.isSymbolicLink() || !info.isFile() || await realpath(dirname(path)) !== root) throw artifactError();
    await unlink(path); await defaultSyncDirectory(root);
  });
}

/** @param {{dataRoot:string,workspace:string,directory:string,jobId:string,contents:string}} input @param {{syncDirectory?:(path:string)=>Promise<void>}} [dependencies] */
async function writeArtifact({ dataRoot, workspace, directory, jobId, contents }, dependencies = {}) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const syncDirectory = dependencies.syncDirectory ?? defaultSyncDirectory;
  const relative = `${directory}/${jobId}.md`; let temporary; /** @type {import('node:fs/promises').FileHandle|undefined} */ let handle;
  try {
    return await withFileLock(join(storage.directory, '.artifacts.lock'), async () => {
      const targetDirectory = await secureArtifactRoot(storage.directory, directory, true); const path = join(targetDirectory, `${jobId}.md`);
      try { if ((await lstat(path)).isSymbolicLink()) throw artifactError(); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
      temporary = join(targetDirectory, `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`);
      handle = await open(temporary, 'wx', 0o600); await handle.writeFile(contents, 'utf8'); await handle.sync();
      // Compare the temporary and final files through FileHandle.stat on both
      // sides. Node 22.13 Windows uses different libuv stat paths for lstat
      // and fstat, so a path-stat comparison rejects a valid rename. Keeping
      // both identities handle-bound preserves the replacement check.
      const sourceInfo = await handle.stat(); await handle.close(); handle = undefined;
      if (await realpath(targetDirectory) !== targetDirectory) throw artifactError();
      await rename(temporary, path); temporary = undefined; const finalInfo = await lstat(path);
      if (finalInfo.isSymbolicLink() || !finalInfo.isFile() || await realpath(dirname(path)) !== targetDirectory) throw artifactError();
      const finalHandle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { if (!sameFileIdentity(sourceInfo, await finalHandle.stat())) throw artifactError(); }
      finally { await finalHandle.close(); }
      await chmod(path, 0o600); await syncDirectory(targetDirectory); return relative;
    });
  } catch (error) { await closeFileHandle(handle); if (temporary) await unlink(temporary).catch(() => {}); throw new PluginError('ARTIFACT_WRITE_FAILED', 'Could not durably write the private artifact.', { category: 'storage', remedy: 'Check plugin data storage and retry.', cause: error }); }
}

/** @param {import('node:fs/promises').FileHandle|undefined} handle */
async function closeFileHandle(handle) { await handle?.close().catch(() => {}); }

/** @param {any} left @param {any} right */
function sameFileIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }

/** @param {string} storageDirectory @param {string} directory @param {boolean} create */
async function secureArtifactRoot(storageDirectory, directory, create) {
  const storageRoot = await realpath(resolve(storageDirectory)); const lexicalRoot = join(storageDirectory, directory); let info;
  try { info = await lstat(lexicalRoot); } catch (error) { if (!create || errorCode(error) !== 'ENOENT') throw error; await ensurePrivateDirectory(lexicalRoot); info = await lstat(lexicalRoot); }
  if (info.isSymbolicLink() || !info.isDirectory()) throw artifactError();
  const root = await realpath(lexicalRoot); if (await realpath(dirname(root)) !== storageRoot) throw artifactError();
  return root;
}
/** @param {string} path */
async function defaultSyncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes(errorCode(error) ?? '')) throw error; }
  finally { await handle.close(); }
}

/** @param {any} snapshot @param {string} command @param {{beforeMessageIds?:Set<string>,inputId?:string,stateRevision?:number}} [turnBoundary] */
export function extractFinalResult(snapshot, command, turnBoundary = {}) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const beforeMessageIds = turnBoundary.beforeMessageIds ?? new Set();
  const newAssistants = messages.filter((/** @type {any} */ message) => isAssistantResponse(message, beforeMessageIds));
  const directAssistants = turnBoundary.inputId ? newAssistants.filter((/** @type {any} */ message) => message.info.parentMessageId === turnBoundary.inputId) : [];
  let assistant;
  if (directAssistants.length) assistant = directAssistants.at(-1);
  else if (turnBoundary.inputId) {
    const rootedResponses = messages.filter((/** @type {any} */ message) => isCurrentUserRoot(message, beforeMessageIds)).map((/** @type {any} */ root) => newAssistants.filter((/** @type {any} */ message) => message.info.parentMessageId === root.info.messageId)).filter((/** @type {any[]} */ responses) => responses.length > 0);
    if (rootedResponses.length !== 1) throw missingResult();
    assistant = rootedResponses[0].at(-1);
  } else assistant = newAssistants.at(-1);
  if (['hidden', 'debug'].includes(assistant?.info?.semantics?.uiVisibility)) throw missingResult();
  const parts = assistant?.parts?.filter((/** @type {any} */ part) => part?.type === 'text' && part.ignored !== true && typeof part.text === 'string' && part.text.length > 0).map((/** @type {any} */ part) => part.text) ?? [];
  if (!parts.length) throw missingResult();
  const text = parts.join('\n');
  if (command !== 'review' && command !== 'adversarial-review') return text;
  let structured = assistant?.info?.structured;
  if (structured === undefined) {
    try { structured = JSON.parse(text); } catch (error) { throw invalidReviewResult(error); }
  }
  if (!validateJsonSchema(structured, REVIEW_OUTPUT_SCHEMA)) throw invalidReviewResult();
  return `${JSON.stringify(structured, null, 2)}\n`;
}
/** @param {any} message @param {Set<string>} beforeMessageIds */
function isAssistantResponse(message, beforeMessageIds) {
  const semantics = message?.info?.semantics;
  return message?.info?.role === 'assistant' && typeof message.info.messageId === 'string' && !beforeMessageIds.has(message.info.messageId)
    && (semantics === undefined || semantics.origin === 'agent_runtime' && semantics.kind === 'assistant_response');
}
/** @param {any} message @param {Set<string>} beforeMessageIds */
function isCurrentUserRoot(message, beforeMessageIds) {
  const info = message?.info; const semantics = info?.semantics;
  return info?.role === 'user' && typeof info.messageId === 'string' && !beforeMessageIds.has(info.messageId) && info.synthetic !== true && info.visibility !== 'model-only'
    && (semantics === undefined || semantics.origin === 'real_user' && semantics.kind === 'user_prompt' && semantics.uiVisibility === 'visible');
}
/** @param {any} snapshot */
function snapshotMessageIds(snapshot) { return new Set((Array.isArray(snapshot?.messages) ? snapshot.messages : []).map((/** @type {any} */ message) => message?.info?.messageId).filter((/** @type {unknown} */ value) => typeof value === 'string')); }
function missingResult() { return new PluginError('ZCODE_RESULT_MISSING', 'ZCode completed without a visible result for the current turn.', { category: 'protocol', remedy: 'Inspect the ZCode session and retry.' }); }
/** @param {unknown} [cause] */
function invalidReviewResult(cause) { return new PluginError('REVIEW_RESULT_INVALID', 'ZCode review output failed the required findings schema.', { category: 'protocol', remedy: 'Retry the review with a compatible ZCode model.', ...(cause ? { cause } : {}) }); }
/** @param {any} response */
function validResponse(response) { return response && typeof response === 'object' && ['allow', 'deny'].includes(response.decision); }
/** @param {unknown} error */
function safeError(error) { return { message: error instanceof Error ? error.message.slice(0, 2048) : 'Unknown execution failure' }; }
/** @param {unknown} error */
function isInterruption(error) { return error instanceof PluginError && error.code === 'JOB_INTERRUPTED'; }
/** @param {unknown} error */
function errorCode(error) { return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined; }
/** @param {any} left @param {any} right */
function sameModel(left, right) { return left?.providerId === right?.providerId && left?.modelId === right?.modelId && (left?.variant ?? '') === (right?.variant ?? ''); }
function artifactError() { return new PluginError('RESULT_ARTIFACT_INVALID', 'Result artifact path is outside the private result store.', { category: 'storage', remedy: 'Restore the job record with a scoped result artifact.' }); }
