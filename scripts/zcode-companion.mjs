#!/usr/bin/env node
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';

import { parseArgs } from './lib/args.mjs';
import { PluginError } from './lib/errors.mjs';
import { atomicWriteJson, readJsonFile } from './lib/fs.mjs';
import { createIdentityStore } from './lib/identity.mjs';
import { createJobController, ownerIdForSession } from './lib/job-control.mjs';
import { discoverZCode } from './lib/zcode-discovery.mjs';
import { createManagedZCodeClient } from './lib/zcode-client.mjs';
import { executeJob, readResultArtifact } from './lib/review.mjs';
import { errorEnvelope, renderInternalOutput, renderOutput } from './lib/render.mjs';
import { createStateStore } from './lib/state.mjs';
import { resolveWorkspaceStorage } from './lib/workspace.mjs';
import { reconcileBrokerOwnership } from './zcode-broker.mjs';

/** @param {string[]} argv @param {{cwd?:string,env?:NodeJS.ProcessEnv}} [runtime] */
export async function runCompanion(argv, runtime = {}) {
  const cwd = runtime.cwd ?? process.cwd(); const env = runtime.env ?? process.env;
  const dataRoot = env.ZCODE_DATA_ROOT;
  if (!dataRoot) throw new PluginError('DATA_ROOT_REQUIRED', 'Plugin data root is not configured.', { category: 'configuration', remedy: 'Run $zcode:setup.' });
  const parsed = parseArgs(argv); const identity = createIdentityStore({ dataRoot }); const store = createStateStore({ dataRoot });
  if (parsed.command === 'run-reserved-job') return runReserved({ parsed, cwd, env, dataRoot, identity, store });
  const caller = await identity.consumeCallerContext(parsed.options.callerContext, { workspace: cwd });
  const controller = createJobController({ store });
  if (parsed.command === 'status') {
    if (parsed.options.all) return { jobs: await controller.listOwned(cwd, caller.sessionId) };
    let job = await controller.selectOwned(cwd, caller.sessionId, parsed.positionals[0]);
    if (parsed.options.wait) job = await controller.wait(cwd, job.id, parsed.options.timeoutMs);
    return { job };
  }
  if (parsed.command === 'result') {
    const job = await controller.selectOwned(cwd, caller.sessionId, parsed.positionals[0]);
    if (job.status !== 'succeeded' || !job.resultArtifact) throw new PluginError('JOB_RESULT_UNFINISHED', `Job ${job.id} is ${job.status}.`, { category: 'state', remedy: `Run $zcode:status ${job.id} --wait.`, details: { jobId: job.id, status: job.status } });
    return { job, result: await readResultArtifact({ dataRoot, workspace: cwd, artifact: job.resultArtifact }) };
  }
  if (parsed.command === 'cancel') {
    const selected = await controller.selectOwned(cwd, caller.sessionId, parsed.positionals[0]);
    if (selected.status !== 'running') return { job: await controller.cancel(cwd, selected.id, caller.sessionId) };
    const launch = await discoverLaunch(env);
    const client = await createManagedZCodeClient({ dataRoot, workspace: cwd, launch, ownerId: ownerIdForSession(caller.sessionId), env });
    const cancelling = createJobController({ store, stopSession: (sessionId) => client.stopSession(sessionId) });
    try { return { job: await cancelling.cancel(cwd, selected.id, caller.sessionId) }; }
    finally { await client.close().catch(() => {}); }
  }
  return startPublic({ parsed, caller, cwd, env, dataRoot, identity, store, controller });
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
  const job = await store.reserveJob({ workspace: cwd, ownerSessionId: caller.sessionId, ownerTurnId: caller.turnId, command: parsed.command, readOnly: parsed.command !== 'rescue', permissionSnapshot });
  const spec = { command: parsed.command, scope: parsed.options.scope, base: parsed.options.base, focus: parsed.positionals.join(' '), task: parsed.positionals.join(' '), model: parsed.options.model, effort: parsed.options.effort, resumeSessionId: parsed.options.resume === 'resume' ? candidate?.zcodeSessionId : undefined };
  if (parsed.options.execution === 'background') {
    await writeJobSpec(dataRoot, cwd, job.id, spec);
    const capability = await identity.createExecutionCapability({ jobId: job.id, ownerSessionId: caller.sessionId, workspace: cwd, operation: 'run-reserved-job', permissionSnapshot });
    return { type: 'background', job, privateInvocation: ['run-reserved-job', job.id, '--execution-capability', capability] };
  }
  return executeReserved({ ...context, job, spec });
}

/** @param {any} input */
async function runReserved({ parsed, cwd, env, dataRoot, identity, store }) {
  const jobId = parsed.positionals[0]; const job = await store.readJob(cwd, jobId);
  const authorization = await identity.consumeExecutionCapability(parsed.options.executionCapability, { jobId, ownerSessionId: job.ownerSessionId, workspace: cwd, operation: 'run-reserved-job' });
  if (!sameJson(authorization.permissionSnapshot, job.permissionSnapshot)) throw new PluginError('EXECUTION_SNAPSHOT_MISMATCH', 'Execution capability permission snapshot does not match the reserved job.', { category: 'authorization', remedy: 'Issue a new capability from the exact reserved job.' });
  if (job.status !== 'queued') throw new PluginError('RESERVED_JOB_NOT_QUEUED', `Reserved job ${jobId} is ${job.status}.`, { category: 'state', remedy: 'Generate a new execution capability only for a queued job.' });
  const spec = await readJobSpec(dataRoot, cwd, jobId);
  return executeReserved({ parsed, cwd, env, dataRoot, identity, store, job, spec, caller: { sessionId: job.ownerSessionId } });
}

/** @param {any} context */
async function executeReserved(context) {
  const { cwd, env, dataRoot, store, job, spec } = context;
  let client;
  try {
    const launch = await discoverLaunch(env); const ownerId = ownerIdForSession(job.ownerSessionId);
    client = await createManagedZCodeClient({ dataRoot, workspace: cwd, launch, ownerId, env });
    const modelAliases = parseAliases(env.ZCODE_MODEL_ALIASES);
    return await executeJob({ job, workspace: cwd, dataRoot, store, client, scope: spec.scope, base: spec.base, focus: spec.focus, task: spec.task, modelRequest: spec.model, modelAliases, effort: spec.effort, resumeSessionId: spec.resumeSessionId, onBeforeResume: async () => reconcileBrokerOwnership({ dataRoot, workspace: cwd, ownerId, ownedSessionIds: [spec.resumeSessionId] }) });
  } catch (error) {
    await client?.close().catch(() => {});
    const current = await store.readJob(cwd, job.id).catch(() => null);
    if (current && !['failed', 'succeeded', 'cancelled', 'cancelling'].includes(current.status)) {
      await store.transitionJob(cwd, job.id, [current.status], 'failed', { error: { message: error instanceof Error ? error.message.slice(0, 2048) : 'Execution failed' }, finishedAt: new Date().toISOString(), exitCode: 1 }).catch(() => {});
    }
    throw error;
  }
}

/** @param {NodeJS.ProcessEnv} env */
async function discoverLaunch(env) {
  return (await discoverZCode({ explicitPath: env.ZCODE_PATH, env })).launch;
}

/** @param {string} dataRoot @param {string} workspace @param {string} jobId @param {any} spec */
async function writeJobSpec(dataRoot, workspace, jobId, spec) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); await atomicWriteJson(join(storage.directory, 'job-specs', `${jobId}.json`), spec);
}
/** @param {string} dataRoot @param {string} workspace @param {string} jobId */
async function readJobSpec(dataRoot, workspace, jobId) {
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const root = resolve(storage.directory, 'job-specs'); const path = resolve(root, `${jobId}.json`);
  if (!path.startsWith(`${root}${sep}`)) throw new PluginError('JOB_SPEC_INVALID', 'Job specification path is invalid.', { category: 'storage', remedy: 'Reserve a new background job.' });
  return readJsonFile(path);
}
/** @param {string|undefined} raw */
function parseAliases(raw) {
  if (!raw) return {};
  try { const value = JSON.parse(raw); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch { throw new PluginError('MODEL_ALIASES_INVALID', 'Configured model aliases are invalid JSON.', { category: 'configuration', remedy: 'Run $zcode:setup and repair model aliases.' }); }
}
/** @param {unknown} left @param {unknown} right */
function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

async function main() {
  const internalTransport = process.env.ZCODE_INTERNAL_TRANSPORT === 'json';
  try {
    /** @type {any} */
    const output = await runCompanion(process.argv.slice(2));
    process.stdout.write(internalTransport ? renderInternalOutput(output) : renderOutput(output)); if (output?.type === 'needs-choice') process.exitCode = 3;
  }
  catch (error) { process.stdout.write(internalTransport ? renderInternalOutput(errorEnvelope(error)) : renderOutput(errorEnvelope(error), { json: true })); if (process.env.ZCODE_DEBUG === '1') process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = error instanceof PluginError && error.category === 'validation' ? 2 : 1; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
