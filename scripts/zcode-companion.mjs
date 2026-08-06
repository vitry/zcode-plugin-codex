#!/usr/bin/env node
import process from 'node:process';
import { createHash, randomBytes } from 'node:crypto';
import { close as closeFd, createReadStream, realpathSync, write as writeFd } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';

import { parseArgs, resolveModel } from './lib/args.mjs';
import { readCodexThread } from './lib/codex-app-server.mjs';
import { runSetup } from './lib/codex-config.mjs';
import { PluginError } from './lib/errors.mjs';
import { atomicWriteJson, readJsonFile } from './lib/fs.mjs';
import { createIdentityStore } from './lib/identity.mjs';
import { createJobController, ownerIdForSession } from './lib/job-control.mjs';
import { discoverZCode } from './lib/zcode-discovery.mjs';
import { createManagedZCodeClient } from './lib/zcode-client.mjs';
import { acknowledgeBackgroundStartup, startBackgroundWorker } from './lib/background-worker.mjs';
import { createInvocationStore, parseRecordedInvocation, requiresExecutionChoice } from './lib/invocation.mjs';
import { executeJob, readResultArtifact } from './lib/review.mjs';
import { reconcileOwnedJobs, withWorkerLease } from './lib/recovery.mjs';
import { errorEnvelope, renderOutput } from './lib/render.mjs';
import { createStateStore } from './lib/state.mjs';
import { resolveWorkspaceStorage } from './lib/workspace.mjs';
import { readWorkspaceModelConfig, summarizeWorkspaceModelConfig } from './lib/workspace-config.mjs';
import { executeTransfer, resolveTransferSource, TRANSFER_WIRE_LIMITS } from './lib/transfer.mjs';
import { reconcileBrokerOwnership } from './zcode-broker.mjs';

const backgroundBindings = new WeakMap();

/** @param {string[]} argv @param {{cwd?:string,env?:NodeJS.ProcessEnv,authorization?:Record<string,unknown>,dependencies?:any,caller?:any,startupAck?:()=>Promise<void>,originalPrompt?:string,autoLaunchBackground?:boolean}} [runtime] */
export async function runCompanion(argv, runtime = {}) {
  const cwd = runtime.cwd ?? process.cwd(); const env = runtime.env ?? process.env;
  const parsed = parseArgs(argv); const dataRoot = env.ZCODE_DATA_ROOT ?? env.PLUGIN_DATA;
  if (!dataRoot) throw new PluginError('DATA_ROOT_REQUIRED', 'Plugin data root is not configured.', { category: 'configuration', remedy: 'Run $zcode:setup.' });
  if (parsed.command === 'setup') return runSetup({ pluginRoot: env.PLUGIN_ROOT, dataRoot, cwd, reviewGate: parsed.options.reviewGate, env, codex: codexAppServerOptions(env, cwd), dependencies: runtime.dependencies });
  const identity = createIdentityStore({ dataRoot }); const store = createStateStore({ dataRoot });
  if (parsed.command === 'run-reserved-job') return runReserved({ parsed, cwd, env, dataRoot, identity, store, authorization: requireAuthorization(runtime.authorization, ['executionCapability', 'jobId']), startupAck: runtime.startupAck, dependencies: runtime.dependencies });
  const caller = runtime.caller ?? await identity.consumeCallerContext(requireAuthorization(runtime.authorization, ['callerContext']).callerContext, { workspace: cwd });
  const reconcile = () => reconcileOwnedJobs({ store, dataRoot, workspace: cwd, ownerSessionId: caller.sessionId, createClient: async (job, ownerId) => {
    const launch = await discoverLaunch(env);
    return (runtime.dependencies?.createManagedZCodeClient ?? createManagedZCodeClient)({ dataRoot, workspace: cwd, launch, ownerId, env, ...managedWireOptionsForJob(job) });
  } });
  const controller = createJobController({ store, dataRoot, beforeWaitPoll: reconcile });
  await reconcile();
  if (parsed.command === 'status') {
    const modelPolicy = summarizeWorkspaceModelConfig(await readWorkspaceModelConfig({ dataRoot, workspace: cwd }));
    if (parsed.options.all) return { jobs: (await store.listJobs(cwd)).map((job) => publicJob(job, caller.sessionId)), modelPolicy };
    let job = await controller.selectOwned(cwd, caller.sessionId, parsed.positionals[0]);
    if (parsed.options.wait) job = await controller.wait(cwd, job.id, parsed.options.timeoutMs);
    return { job, modelPolicy };
  }
  if (parsed.command === 'result') {
    const job = await controller.selectOwned(cwd, caller.sessionId, parsed.positionals[0], 'result');
    if (job.status !== 'succeeded' || !job.resultArtifact) throw new PluginError('JOB_RESULT_UNFINISHED', `Job ${job.id} is ${job.status}.`, { category: 'state', remedy: `Run $zcode:status ${job.id} --wait.`, details: { jobId: job.id, status: job.status } });
    return { job, result: await readResultArtifact({ dataRoot, workspace: cwd, artifact: job.resultArtifact }) };
  }
  if (parsed.command === 'cancel') {
    const selected = await controller.selectOwned(cwd, caller.sessionId, parsed.positionals[0], 'cancel');
    if (!['running', 'cancelling'].includes(selected.status)) return { job: await controller.cancel(cwd, selected.id, caller.sessionId) };
    const launch = await discoverLaunch(env);
    const client = await createManagedZCodeClient({ dataRoot, workspace: cwd, launch, ownerId: ownerIdForSession(caller.sessionId), env, ...managedWireOptionsForJob(selected) });
    const cancelling = createJobController({ store, dataRoot, stopSession: (sessionId) => client.stopSession(sessionId) });
    try { return { job: await cancelling.cancel(cwd, selected.id, caller.sessionId) }; }
    finally { await client.close().catch(() => {}); }
  }
  return startPublic({ parsed, caller, cwd, env, dataRoot, identity, store, controller, dependencies: runtime.dependencies, originalPrompt: runtime.originalPrompt, autoLaunchBackground: runtime.autoLaunchBackground });
}

/** Resolve a hook-recorded active turn and invoke through ordinary stdio without caller-supplied authorization. @param {string[]} argv @param {{cwd?:string,env?:NodeJS.ProcessEnv,dependencies?:any}} [runtime] */
export async function runDirectInvocation(argv, runtime = {}) {
  const cwd = runtime.cwd ?? process.cwd(); const env = runtime.env ?? process.env; const dataRoot = env.ZCODE_DATA_ROOT ?? env.PLUGIN_DATA;
  if (!dataRoot) throw new PluginError('DATA_ROOT_REQUIRED', 'Plugin data root is not configured.', { category: 'configuration', remedy: 'Run $zcode:setup.' });
  const sessionId = env.CODEX_THREAD_ID; if (typeof sessionId !== 'string' || !sessionId) throw new PluginError('THREAD_ID_REQUIRED', 'The active Codex thread identity is unavailable.', { category: 'authorization', remedy: 'Invoke this installed skill from an active Codex turn.' });
  const [entry, command, choice, ...extra] = argv; if (!['invoke', 'invoke-choice'].includes(entry) || typeof command !== 'string' || extra.length) throw new PluginError('INVOCATION_COMMAND_INVALID', 'The direct companion command is invalid.', { category: 'validation', remedy: 'Use the constant command documented by the installed skill.' });
  const identity = createIdentityStore({ dataRoot }); const caller = await identity.resolveActiveTurn({ sessionId, workspace: cwd }); const invocations = createInvocationStore({ dataRoot });
  /** @type {any} */ let invocation; let executionCaller = caller;
  if (entry === 'invoke-choice') { invocation = await invocations.consumePending({ sessionId, workspace: cwd, command, choice }); executionCaller = invocation.caller; }
  else {
    if (choice !== undefined) throw new PluginError('INVOCATION_COMMAND_INVALID', 'The direct companion command is invalid.', { category: 'validation', remedy: 'Use the constant command documented by the installed skill.' });
    invocation = parseRecordedInvocation(command, caller.prompt);
    if (requiresExecutionChoice(command, invocation.argv)) {
      await invocations.savePending({ sessionId, turnId: caller.turnId, workspace: cwd, permissionMode: caller.permissionMode, command, spec: { argv: invocation.argv } });
      return { type: 'needs-choice', choices: ['wait', 'background'] };
    }
  }
  const output = await runCompanion(invocation.argv, { cwd, env, caller: executionCaller, originalPrompt: invocation.implicitText, autoLaunchBackground: true, dependencies: runtime.dependencies });
  if (output?.type === 'needs-choice') await invocations.savePending({ sessionId, turnId: executionCaller.turnId, workspace: cwd, permissionMode: executionCaller.permissionMode, command, spec: { argv: invocation.argv } });
  return output;
}

/** @param {any} context */
async function startPublic(context) {
  const { parsed, caller, cwd, dataRoot, identity, store, controller } = context;
  let candidate = null;
  if (parsed.command === 'rescue') {
    candidate = await controller.resumeCandidate(cwd, caller.sessionId);
    if (!parsed.options.resume && candidate) return { type: 'needs-choice', candidate, choices: ['--resume', '--fresh'] };
    if (parsed.options.resume === 'resume' && !candidate) throw new PluginError('RESUME_CANDIDATE_NOT_FOUND', 'No eligible rescue session can be resumed.', { category: 'state', remedy: 'Use --fresh to start a new ZCode session.' });
  }
  const permissionSnapshot = Object.freeze({ permissionMode: caller.permissionMode });
  const transferSource = parsed.command === 'transfer' ? resolveTransferSource(parsed.options, caller) : undefined;
  const job = await store.reserveJob({ workspace: cwd, ownerSessionId: caller.sessionId, ownerTurnId: caller.turnId, command: parsed.command, readOnly: parsed.command !== 'rescue', permissionSnapshot, ...(transferSource ? { codexThreadId: transferSource } : {}) });
  if (parsed.command === 'transfer') {
    return executeTransfer({ job, workspace: job.workspace, dataRoot, store, sourceThreadId: /** @type {string} */ (transferSource), resolveLaunch: () => discoverLaunch(context.env),
      readThread: () => (context.dependencies?.readCodexThread ?? readCodexThread)(transferSource, codexAppServerOptions(context.env, job.workspace)),
      createClient: (launch) => (context.dependencies?.createManagedZCodeClient ?? createManagedZCodeClient)({ dataRoot, workspace: job.workspace, launch, ownerId: ownerIdForSession(caller.sessionId), env: context.env, ...managedWireOptionsForJob(job) }),
    });
  }
  const spec = normalizeSpec({ command: parsed.command, scope: parsed.options.scope, base: parsed.options.base, focus: parsed.positionals.join(' ') || context.originalPrompt, task: parsed.positionals.join(' ') || context.originalPrompt, model: parsed.options.model, effort: parsed.options.effort, resumeSessionId: parsed.options.resume === 'resume' ? candidate?.zcodeSessionId : undefined, candidateJobId: parsed.options.resume === 'resume' ? candidate?.id : undefined });
  if (parsed.options.execution === 'background') {
    const specDigest = digestSpec(spec);
    const binding = { jobId: job.id, ownerSessionId: caller.sessionId, workspace: cwd, operation: 'run-reserved-job', specDigest };
    let capability;
    try {
      await (context.dependencies?.writeJobSpec ?? writeJobSpec)(dataRoot, cwd, job, spec, specDigest);
      capability = await (context.dependencies?.createExecutionCapability ?? ((/** @type {any} */ input) => identity.createExecutionCapability(input)))({ ...binding, permissionSnapshot });
      if (context.autoLaunchBackground) {
        await (context.dependencies?.startBackgroundWorker ?? startBackgroundWorker)({ companionPath: fileURLToPath(import.meta.url), jobId: job.id, executionCapability: capability, cwd, env: context.env });
        return { type: 'background', job };
      }
      const output = (context.dependencies?.buildBackgroundOutput ?? ((/** @type {any} */ value) => value))({ type: 'background', job, privateInvocation: ['run-reserved-job', job.id], executionCapability: capability });
      backgroundBindings.set(output, { identity, store, capability, binding });
      return output;
    } catch (error) {
      if (capability) await identity.revokeExecutionCapability(capability, binding).catch(() => {});
      await failQueuedJob(store, cwd, job.id, error);
      throw error;
    }
  }
  return executeWithWorkerLease({ ...context, job, spec });
}

/** @param {any} job */
function managedWireOptionsForJob(job) { return job?.command === 'transfer' ? { maxFrameBytes: TRANSFER_WIRE_LIMITS.maxFrameBytes, maxOutboundBytes: TRANSFER_WIRE_LIMITS.maxOutboundBytes } : {}; }

/** @param {NodeJS.ProcessEnv} env @param {string} cwd */
function codexAppServerOptions(env, cwd) {
  let args;
  if (env.CODEX_APP_SERVER_ARGS_JSON !== undefined) {
    try { args = JSON.parse(env.CODEX_APP_SERVER_ARGS_JSON); } catch (cause) { throw new PluginError('CODEX_APP_SERVER_CONFIG_INVALID', 'Codex app-server arguments are invalid.', { category: 'configuration', remedy: 'Run $zcode:setup and repair the Codex app-server launcher.', cause }); }
    if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) throw new PluginError('CODEX_APP_SERVER_CONFIG_INVALID', 'Codex app-server arguments are invalid.', { category: 'configuration', remedy: 'Run $zcode:setup and repair the Codex app-server launcher.' });
  }
  return { ...(env.CODEX_APP_SERVER_PATH ? { executable: env.CODEX_APP_SERVER_PATH } : {}), ...(args ? { args } : {}), cwd, env };
}

/** @param {any} input */
async function runReserved({ parsed, cwd, env, dataRoot, identity, store, authorization, startupAck, dependencies }) {
  const jobId = parsed.positionals[0]; const job = await store.readJob(cwd, jobId);
  if (authorization.jobId !== jobId) throw authorizationInputError();
  const record = await readJobSpec(dataRoot, cwd, jobId);
  const spec = normalizeSpec(record.spec);
  const recomputed = digestSpec(spec);
  if (record.digest !== recomputed || record.jobId !== job.id || record.ownerSessionId !== job.ownerSessionId || record.workspace !== job.workspace) throw new PluginError('JOB_SPEC_TAMPERED', 'Reserved job specification failed its immutable binding.', { category: 'authorization', remedy: 'Reserve a new background job.' });
  const consumed = await identity.consumeExecutionCapability(authorization.executionCapability, { jobId, ownerSessionId: job.ownerSessionId, workspace: cwd, operation: 'run-reserved-job', specDigest: recomputed });
  if (!sameJson(consumed.permissionSnapshot, job.permissionSnapshot)) throw new PluginError('EXECUTION_SNAPSHOT_MISMATCH', 'Execution capability permission snapshot does not match the reserved job.', { category: 'authorization', remedy: 'Issue a new capability from the exact reserved job.' });
  if (job.status !== 'queued') throw new PluginError('RESERVED_JOB_NOT_QUEUED', `Reserved job ${jobId} is ${job.status}.`, { category: 'state', remedy: 'Generate a new execution capability only for a queued job.' });
  return executeWithWorkerLease({ parsed, cwd, env, dataRoot, identity, store, job, spec, caller: { sessionId: job.ownerSessionId }, dependencies, ...(startupAck ? { onBoundaryPersisted: async () => startupAck() } : {}) });
}

/** @param {any} context */
async function executeWithWorkerLease(context) {
  const workerLeaseId = randomBytes(32).toString('hex');
  return withWorkerLease({ dataRoot: context.dataRoot, workspace: context.cwd, jobId: context.job.id, workerLeaseId }, async () => {
    const job = await context.store.claimJobWorker(context.cwd, context.job.id, { childPid: process.pid, workerLeaseId });
    return executeReserved({ ...context, job, childPid: process.pid, workerLeaseId });
  });
}

/** @param {any} context */
async function executeReserved(context) {
  const { cwd, env, dataRoot, store, job, spec } = context;
  let client;
  try {
    const launch = await discoverLaunch(env, context.dependencies); const ownerId = ownerIdForSession(job.ownerSessionId);
    client = await createManagedZCodeClient({ dataRoot, workspace: cwd, launch, ownerId, env });
    const modelConfig = await readWorkspaceModelConfig({ dataRoot, workspace: cwd }); const modelRequest = spec.model ?? modelConfig.defaultModel;
    const preResolvedModel = modelRequest && (modelRequest.includes('/') || Object.hasOwn(modelConfig.models, modelRequest)) ? resolveModel(modelRequest, modelConfig.models, []) : undefined;
    return await executeJob({ job, workspace: cwd, dataRoot, store, client, scope: spec.scope, base: spec.base, focus: spec.focus, task: spec.task, model: preResolvedModel, modelRequest: preResolvedModel ? undefined : modelRequest, modelAliases: modelConfig.models, effort: spec.effort, resumeSessionId: spec.resumeSessionId, childPid: context.childPid, workerLeaseId: context.workerLeaseId, onBoundaryPersisted: context.onBoundaryPersisted, onBeforeResume: async () => { await validateResumeCandidate(store, cwd, job.ownerSessionId, spec); await reconcileBrokerOwnership({ dataRoot, workspace: cwd, ownerId, ownedSessionIds: [spec.resumeSessionId] }); } });
  } catch (error) {
    await client?.close().catch(() => {});
    const current = await store.readJob(cwd, job.id).catch(() => null);
    if (current?.status === 'queued') {
      await store.transitionJob(cwd, job.id, ['queued'], 'failed', { error: { message: error instanceof Error ? error.message.slice(0, 2048) : 'Execution failed' }, finishedAt: new Date().toISOString(), exitCode: 1 }).catch(() => {});
    }
    throw error;
  }
}

/** @param {NodeJS.ProcessEnv} env */
/** @param {NodeJS.ProcessEnv} env @param {any} [dependencies] */
async function discoverLaunch(env, dependencies = {}) {
  if (dependencies?.discoverLaunch) return dependencies.discoverLaunch(env);
  return (await discoverZCode({ explicitPath: env.ZCODE_PATH, env })).launch;
}

/** @param {string} dataRoot @param {string} workspace @param {any} job @param {any} spec @param {string} digest */
async function writeJobSpec(dataRoot, workspace, job, spec, digest) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); await atomicWriteJson(join(storage.directory, 'job-specs', `${job.id}.json`), { version: 1, jobId: job.id, ownerSessionId: job.ownerSessionId, workspace: job.workspace, digest, spec });
}
/** @param {string} dataRoot @param {string} workspace @param {string} jobId */
async function readJobSpec(dataRoot, workspace, jobId) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const root = resolve(storage.directory, 'job-specs'); const path = resolve(root, `${jobId}.json`);
  if (!path.startsWith(`${root}${sep}`)) throw new PluginError('JOB_SPEC_INVALID', 'Job specification path is invalid.', { category: 'storage', remedy: 'Reserve a new background job.' });
  return readJsonFile(path);
}
/** @param {unknown} left @param {unknown} right */
function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

/** @param {unknown} value @param {string[]} keys @returns {any} */
function requireAuthorization(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw authorizationInputError();
  const record = /** @type {Record<string,unknown>} */ (value);
  if (Object.keys(record).length !== keys.length || keys.some((key) => typeof record[key] !== 'string' || !record[key])) throw authorizationInputError();
  return value;
}
function authorizationInputError() { return new PluginError('INTERNAL_AUTHORIZATION_INVALID', 'The internal authorization envelope is invalid.', { category: 'authorization', remedy: 'Invoke this command through its installed skill using the protected internal channel.' }); }
/** @param {any} job @param {string} ownerSessionId */
function publicJob(job, ownerSessionId) { const visible = { ...job }; delete visible.ownerSessionId; delete visible.ownerTurnId; delete visible.permissionSnapshot; return { ...visible, owned: job.ownerSessionId === ownerSessionId, owner: job.ownerSessionId === ownerSessionId ? 'same-owner' : 'other' }; }
/** @param {any} input */
function normalizeSpec(input) {
  const allowed = ['command', 'scope', 'base', 'focus', 'task', 'model', 'effort', 'resumeSessionId', 'candidateJobId'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key)) || typeof input.command !== 'string') throw new PluginError('JOB_SPEC_INVALID', 'Job specification is invalid.', { category: 'validation', remedy: 'Reserve a new background job.' });
  /** @type {Record<string,string>} */ const output = {};
  for (const key of allowed) if (input[key] !== undefined) { if (typeof input[key] !== 'string') throw new PluginError('JOB_SPEC_INVALID', 'Job specification is invalid.', { category: 'validation', remedy: 'Reserve a new background job.' }); output[key] = input[key]; }
  return output;
}
/** @param {any} spec */
function digestSpec(spec) { return createHash('sha256').update(JSON.stringify(spec, Object.keys(spec).sort())).digest('hex'); }
/** @param {any} store @param {string} workspace @param {string} ownerSessionId @param {Record<string,string>} spec */
async function validateResumeCandidate(store, workspace, ownerSessionId, spec) {
  if (!spec.resumeSessionId) return;
  const candidate = await store.readJob(workspace, spec.candidateJobId);
  if (candidate.ownerSessionId !== ownerSessionId || candidate.command !== 'rescue' || candidate.zcodeSessionId !== spec.resumeSessionId || !['running', 'succeeded', 'failed'].includes(candidate.status)) throw new PluginError('RESUME_CANDIDATE_INVALID', 'The bound rescue candidate is no longer eligible.', { category: 'authorization', remedy: 'Reserve a fresh rescue job.' });
}

/** @param {number} [fd] @param {{maxBytes?:number,timeoutMs?:number}} [options] */
export function readInternalEnvelope(fd = 3, options = {}) {
  const maxBytes = options.maxBytes ?? 64 * 1024; const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(fd) || fd < 3 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw authorizationInputError();
  return new Promise((resolvePromise, reject) => {
    const stream = createReadStream('', { fd, autoClose: false }); let data = ''; let bytes = 0; let settled = false;
    /** @param {()=>void} callback */
    const finish = (callback) => { if (settled) return; settled = true; clearTimeout(timer); stream.destroy(); callback(); };
    const timer = setTimeout(() => finish(() => reject(authorizationInputError())), timeoutMs);
    stream.on('data', (chunk) => { bytes += chunk.length; if (bytes > maxBytes) finish(() => reject(authorizationInputError())); else data += chunk.toString('utf8'); });
    stream.once('error', () => finish(() => reject(authorizationInputError())));
    stream.once('end', () => finish(() => { try { resolvePromise(JSON.parse(data)); } catch { reject(authorizationInputError()); } }));
  });
}
/** @param {unknown} value @param {number} [fd] @param {{maxBytes?:number,timeoutMs?:number,write?:(fd:number,buffer:Buffer,offset:number,length:number,position:null,callback:(error:NodeJS.ErrnoException|null,bytesWritten:number)=>void)=>void,close?:(fd:number,callback:(error?:NodeJS.ErrnoException|null)=>void)=>void}} [options] */
export function writeInternalResponse(value, fd = 4, options = {}) {
  const maxBytes = options.maxBytes ?? 1024 * 1024; const timeoutMs = options.timeoutMs ?? 1_000;
  if (!Number.isSafeInteger(fd) || fd < 3 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 1024 * 1024 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return Promise.reject(new PluginError('INTERNAL_RESPONSE_OPTIONS_INVALID', 'Internal response writer options are invalid.', { category: 'validation', remedy: 'Use a protected descriptor, a limit up to 1 MiB, and a positive deadline.' }));
  const data = Buffer.from(`${JSON.stringify(value)}\n`);
  if (data.length > maxBytes) return Promise.reject(new PluginError('INTERNAL_RESPONSE_TOO_LARGE', 'Internal response exceeded its limit.', { category: 'runtime', remedy: 'Inspect the job through status/result.' }));
  const write = options.write ?? writeFd; const close = options.close ?? closeFd;
  return new Promise((resolvePromise, reject) => {
    let offset = 0; let settled = false; let closing = false;
    /** @param {unknown} [error] */
    const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolvePromise(undefined); };
    /** @param {unknown} cause @param {string} [code] */
    const failure = (cause, code = 'INTERNAL_RESPONSE_WRITE_FAILED') => new PluginError(code, 'Could not deliver the protected internal response.', { category: code.endsWith('TIMEOUT') ? 'timeout' : 'runtime', remedy: 'Retry the command through its installed skill.', cause });
    const timer = setTimeout(() => {
      if (settled || closing) return; closing = true;
      try { close(fd, () => {}); } catch { /* best effort abort */ }
      finish(failure(new Error('Internal response write timed out.'), 'INTERNAL_RESPONSE_WRITE_TIMEOUT'));
    }, timeoutMs);
    const next = () => {
      if (settled) return;
      write(fd, data, offset, data.length - offset, null, (error, bytesWritten) => {
        if (settled) return;
        if (error) return finish(failure(error));
        if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) return finish(failure(new Error('Internal response writer made no progress.')));
        offset += bytesWritten;
        if (offset >= data.length) finish(); else queueMicrotask(next);
      });
    };
    next();
  });
}

/** @param {any} output @param {unknown} error */
export async function failBackgroundDelivery(output, error) {
  const record = output && backgroundBindings.get(output); if (!record) return;
  backgroundBindings.delete(output);
  await record.identity.revokeExecutionCapability(record.capability, record.binding).catch(() => {});
  await failQueuedJob(record.store, record.binding.workspace, record.binding.jobId, error);
}

/** @param {any} store @param {string} workspace @param {string} jobId @param {unknown} error */
async function failQueuedJob(store, workspace, jobId, error) {
  await store.transitionJob(workspace, jobId, ['queued'], 'failed', { error: { message: error instanceof Error ? error.message.slice(0, 2048) : 'Background preparation failed' }, finishedAt: new Date().toISOString(), exitCode: 1 }).catch(() => {});
}

async function main() {
  let output;
  try {
    const entry = process.argv[2]; const setup = entry === 'setup'; const direct = entry === 'invoke' || entry === 'invoke-choice'; const worker = process.env.ZCODE_BACKGROUND_WORKER === '1'; const authorization = setup || direct ? undefined : await readInternalEnvelope();
    output = direct ? await runDirectInvocation(process.argv.slice(2)) : await runCompanion(process.argv.slice(2), { authorization, ...(worker ? { startupAck: acknowledgeBackgroundStartup } : {}) });
    if (!setup && !direct && !worker) await writeInternalResponse(output); if (!worker) process.stdout.write(renderOutput(output)); if (output?.type === 'needs-choice') process.exitCode = 3;
  }
  catch (error) { if (output?.type === 'background') await failBackgroundDelivery(output, error); const envelope = errorEnvelope(error); const entry = process.argv[2]; const protectedOutput = entry !== 'setup' && entry !== 'invoke' && entry !== 'invoke-choice' && process.env.ZCODE_BACKGROUND_WORKER !== '1'; if (protectedOutput) try { await writeInternalResponse(envelope); } catch { /* no trusted response channel */ } if (process.env.ZCODE_BACKGROUND_WORKER !== '1') process.stdout.write(renderOutput(envelope, { json: true })); if (process.env.ZCODE_DEBUG === '1') process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = error instanceof PluginError && error.category === 'validation' ? 2 : 1; }
}

if (process.argv[1] && sameEntryPath(fileURLToPath(import.meta.url), resolve(process.argv[1]))) await main();

/** Treat marketplace symlink entrypoints as the installed companion itself. @param {string} left @param {string} right */
function sameEntryPath(left, right) {
  try { return realpathSync(left) === realpathSync(right); }
  catch { return left === right; }
}
