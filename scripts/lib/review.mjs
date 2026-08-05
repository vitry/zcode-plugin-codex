import { constants } from 'node:fs';
import { open, rename, chmod, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

import { PluginError } from './errors.mjs';
import { resolveModel } from './args.mjs';
import { ensurePrivateDirectory } from './fs.mjs';
import { collectGitFacts } from './git.mjs';
import { buildPrompt } from './prompts.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';

const READ_TOOLS = /^(read|inspect|search|list|find|glob|grep|git(?:[-_ ]?(?:status|diff|log|show))?)$/i;
const MUTATING_TOOLS = /(write|edit|patch|delete|remove|create|exec|shell|command|install|move|rename|commit|push)/i;

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
 * @param {{job:any,workspace:string,dataRoot:string,store:any,client:any,scope?:string,base?:string,focus?:string,task?:string,model?:any,modelRequest?:string,modelAliases?:Record<string,unknown>,effort?:string,resumeSessionId?:string,onBeforeResume?:(job:any)=>Promise<void>}} input
 */
export async function executeJob(input) {
  const { job, client, workspace, dataRoot } = input;
  let running = job;
  try {
    let prompt;
    if (job.command === 'review' || job.command === 'adversarial-review') {
      const gitFacts = await collectGitFacts({ workspace, scope: input.scope, base: input.base });
      prompt = await buildPrompt({ command: job.command, focus: input.focus, gitFacts });
    } else prompt = await buildPrompt({ command: 'rescue', task: input.task });
    const promptArtifact = await writeArtifact({ dataRoot, workspace, directory: 'prompts', jobId: job.id, contents: prompt });
    let snapshot;
    if (input.resumeSessionId) {
      await input.onBeforeResume?.(job);
      snapshot = await client.resumeSession(input.resumeSessionId);
    } else snapshot = await client.createSession({ workspace, ...(input.model ? { model: input.model } : {}) });
    const sessionId = snapshot.session.sessionId;
    const selectedModel = input.modelRequest ? resolveModel(input.modelRequest, input.modelAliases, snapshot.settings.model.available) : input.model;
    if (selectedModel && !sameModel(snapshot.settings.model.current, selectedModel)) snapshot = await client.setModel(sessionId, selectedModel);
    if (input.effort) await client.setThoughtLevel(sessionId, input.effort);
    client.setPermissionHandler((/** @type {any} */ request) => decidePermission(request, job.permissionSnapshot, job.command));
    const now = new Date().toISOString();
    running = await input.store.transitionJob(workspace, job.id, ['queued'], 'running', {
      startedAt: now, zcodeSessionId: sessionId, promptArtifact,
      ...(selectedModel ? { model: selectedModel } : {}), ...(input.effort ? { effort: input.effort } : {}),
    });
    await client.send(sessionId, prompt);
    await client.waitForCompletion(sessionId);
    const finalSnapshot = await client.readSession(sessionId);
    const result = finalResult(finalSnapshot);
    const resultArtifact = await writeArtifact({ dataRoot, workspace, directory: 'results', jobId: job.id, contents: result });
    const succeeded = await input.store.transitionJob(workspace, job.id, ['running'], 'succeeded', { resultArtifact, finishedAt: new Date().toISOString(), exitCode: 0 });
    return { job: succeeded, result };
  } catch (error) {
    const current = await input.store.readJob(workspace, job.id).catch(() => running);
    if (current && !['failed', 'succeeded', 'cancelled', 'cancelling'].includes(current.status)) {
      await input.store.transitionJob(workspace, job.id, [current.status], 'failed', { error: safeError(error), finishedAt: new Date().toISOString(), exitCode: 1 }).catch(() => {});
    }
    throw error;
  } finally { await client.close().catch(() => {}); }
}

/** @param {{dataRoot:string,workspace:string,artifact:string}} input */
export async function readResultArtifact({ dataRoot, workspace, artifact }) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
  const root = resolve(storage.directory, 'results'); const path = resolve(storage.directory, artifact);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw artifactError();
  let handle;
  try { handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const info = await handle.stat(); if (!info.isFile()) throw artifactError(); return await handle.readFile('utf8'); }
  catch (error) { if (error instanceof PluginError) throw error; throw new PluginError('RESULT_READ_FAILED', 'Could not safely read the result artifact.', { category: 'storage', remedy: 'Inspect the private workspace result store.', cause: error }); }
  finally { await handle?.close(); }
}

/** @param {{dataRoot:string,workspace:string,directory:string,jobId:string,contents:string}} input */
async function writeArtifact({ dataRoot, workspace, directory, jobId, contents }) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const targetDirectory = join(storage.directory, directory);
  await ensurePrivateDirectory(targetDirectory);
  const relative = `${directory}/${jobId}.md`; const path = join(storage.directory, relative);
  const temporary = join(targetDirectory, `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`);
  let handle;
  try { handle = await open(temporary, 'wx', 0o600); await handle.writeFile(contents, 'utf8'); await handle.sync(); await handle.close(); handle = undefined; await rename(temporary, path); await chmod(path, 0o600); const directoryHandle = await open(dirname(path), 'r'); await directoryHandle.sync().catch(() => {}); await directoryHandle.close(); return relative; }
  catch (error) { await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw new PluginError('ARTIFACT_WRITE_FAILED', 'Could not durably write the private artifact.', { category: 'storage', remedy: 'Check plugin data storage and retry.', cause: error }); }
}

/** @param {any} snapshot */
function finalResult(snapshot) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const assistant = [...messages].reverse().find((message) => message?.info?.role === 'assistant');
  const parts = assistant?.parts?.filter((/** @type {any} */ part) => typeof part?.text === 'string').map((/** @type {any} */ part) => part.text) ?? [];
  if (!parts.length) throw new PluginError('ZCODE_RESULT_MISSING', 'ZCode completed without a final result.', { category: 'protocol', remedy: 'Inspect the ZCode session and retry.' });
  return parts.join('\n');
}
/** @param {any} response */
function validResponse(response) { return response && typeof response === 'object' && ['allow', 'deny'].includes(response.decision); }
/** @param {unknown} error */
function safeError(error) { return { message: error instanceof Error ? error.message.slice(0, 2048) : 'Unknown execution failure' }; }
/** @param {any} left @param {any} right */
function sameModel(left, right) { return left?.providerId === right?.providerId && left?.modelId === right?.modelId && (left?.variant ?? '') === (right?.variant ?? ''); }
function artifactError() { return new PluginError('RESULT_ARTIFACT_INVALID', 'Result artifact path is outside the private result store.', { category: 'storage', remedy: 'Restore the job record with a scoped result artifact.' }); }
