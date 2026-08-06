import { constants } from 'node:fs';
import { open, rename, chmod, lstat, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import { PluginError } from './errors.mjs';
import { resolveModel } from './args.mjs';
import { ensurePrivateDirectory, withFileLock } from './fs.mjs';
import { collectGitFacts } from './git.mjs';
import { buildPrompt } from './prompts.mjs';
import { loadReviewOutputSchema, validateJsonSchema } from './review-schema.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';

const READ_TOOLS = /^(read|inspect|search|list|find|glob|grep|git(?:[-_ ]?(?:status|diff|log|show))?)$/i;
const MUTATING_TOOLS = /(write|edit|patch|delete|remove|create|exec|shell|command|install|move|rename|commit|push)/i;
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
 * @param {{job:any,workspace:string,dataRoot:string,store:any,client:any,scope?:string,base?:string,focus?:string,task?:string,model?:any,modelRequest?:string,modelAliases?:Record<string,unknown>,effort?:string,resumeSessionId?:string,onBeforeResume?:(job:any)=>Promise<void>,childPid?:number,workerLeaseId?:string,onBoundaryPersisted?:(job:any)=>Promise<void>,syncDirectory?:(path:string)=>Promise<void>}} input
 */
export async function executeJob(input) {
  const { job, client, workspace, dataRoot } = input;
  let running = job; let sessionId; let sendAttempted = false; let remoteTerminalProven = false;
  try {
    let prompt;
    if (job.command === 'review' || job.command === 'adversarial-review') {
      const gitFacts = await collectGitFacts({ workspace, scope: input.scope, base: input.base });
      prompt = await buildPrompt({ command: job.command, focus: input.focus, gitFacts });
    } else prompt = await buildPrompt({ command: 'rescue', task: input.task });
    const promptArtifact = await writeArtifact({ dataRoot, workspace, directory: 'prompts', jobId: job.id, contents: prompt }, { syncDirectory: input.syncDirectory });
    let snapshot;
    if (input.resumeSessionId) {
      await input.onBeforeResume?.(job);
      snapshot = await client.resumeSession(input.resumeSessionId);
    } else snapshot = await client.createSession({ workspace, ...(input.model ? { model: input.model } : {}) });
    sessionId = snapshot.session.sessionId;
    const selectedModel = input.modelRequest ? resolveModel(input.modelRequest, input.modelAliases, snapshot.settings.model.available) : input.model;
    if (selectedModel && !sameModel(snapshot.settings.model.current, selectedModel)) snapshot = await client.setModel(sessionId, selectedModel);
    if (input.effort) snapshot = await client.setThoughtLevel(sessionId, input.effort);
    client.setPermissionHandler((/** @type {any} */ request) => decidePermission(request, job.permissionSnapshot, job.command));
    const now = new Date().toISOString();
    running = await input.store.transitionJob(workspace, job.id, ['queued'], 'running', {
      startedAt: now, zcodeSessionId: sessionId, promptArtifact,
      ...(input.childPid ? { childPid: input.childPid } : {}),
      ...(input.workerLeaseId ? { workerLeaseId: input.workerLeaseId } : {}),
      ...(selectedModel ? { model: selectedModel } : {}), ...(input.effort ? { effort: input.effort } : {}),
    });
    const beforeMessageIds = [...snapshotMessageIds(snapshot)]; sendAttempted = true; const sent = await client.send(sessionId, prompt);
    running = await input.store.transitionJob(workspace, job.id, ['running'], 'running', { inputId: sent.inputId, startRevision: sent.stateRevision, beforeMessageIds });
    await input.onBoundaryPersisted?.(running);
    const turnBoundary = { beforeMessageIds: new Set(beforeMessageIds), ...sent };
    await client.waitForCompletion(sessionId);
    const finalSnapshot = await client.readSession(sessionId);
    remoteTerminalProven = true;
    const result = extractFinalResult(finalSnapshot, job.command, turnBoundary);
    const resultArtifact = await writeArtifact({ dataRoot, workspace, directory: 'results', jobId: job.id, contents: result }, { syncDirectory: input.syncDirectory });
    const succeeded = await input.store.transitionJob(workspace, job.id, ['running'], 'succeeded', { resultArtifact, finishedAt: new Date().toISOString(), exitCode: 0 });
    return { job: succeeded, result };
  } catch (error) {
    const current = await input.store.readJob(workspace, job.id).catch(() => running);
    if (current && !['failed', 'succeeded', 'cancelled', 'cancelling'].includes(current.status)) {
      if (current.status === 'running' && sendAttempted && sessionId && !remoteTerminalProven) {
        try { await client.stopSession(sessionId); }
        catch (stopError) {
          await input.store.transitionJob(workspace, job.id, ['running'], 'running', { lastCancelError: safeError(stopError).message }).catch(() => {});
          throw error;
        }
      }
      await input.store.transitionJob(workspace, job.id, [current.status], 'failed', { error: safeError(error), finishedAt: new Date().toISOString(), exitCode: 1 }).catch(() => {});
    }
    throw error;
  } finally { await client.close().catch(() => {}); }
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
  const newAssistants = messages.filter((/** @type {any} */ message) => message?.info?.role === 'assistant' && typeof message.info.messageId === 'string' && !beforeMessageIds.has(message.info.messageId));
  const linkedAssistants = turnBoundary.inputId ? newAssistants.filter((/** @type {any} */ message) => message.info.parentMessageId === turnBoundary.inputId) : [];
  const assistant = (turnBoundary.inputId ? linkedAssistants : newAssistants).at(-1);
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
function errorCode(error) { return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined; }
/** @param {any} left @param {any} right */
function sameModel(left, right) { return left?.providerId === right?.providerId && left?.modelId === right?.modelId && (left?.variant ?? '') === (right?.variant ?? ''); }
function artifactError() { return new PluginError('RESULT_ARTIFACT_INVALID', 'Result artifact path is outside the private result store.', { category: 'storage', remedy: 'Restore the job record with a scoped result artifact.' }); }
