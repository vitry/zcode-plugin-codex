#!/usr/bin/env node
import process from 'node:process';
import { createHash } from 'node:crypto';
import { createReadStream, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';

import { parseArgs, resolveModel } from './lib/args.mjs';
import { PluginError } from './lib/errors.mjs';
import { atomicWriteJson, readJsonFile } from './lib/fs.mjs';
import { createIdentityStore } from './lib/identity.mjs';
import { createJobController, ownerIdForSession } from './lib/job-control.mjs';
import { discoverZCode } from './lib/zcode-discovery.mjs';
import { createManagedZCodeClient } from './lib/zcode-client.mjs';
import { executeJob, readResultArtifact } from './lib/review.mjs';
import { errorEnvelope, renderOutput } from './lib/render.mjs';
import { createStateStore } from './lib/state.mjs';
import { resolveWorkspaceStorage } from './lib/workspace.mjs';
import { reconcileBrokerOwnership } from './zcode-broker.mjs';

/** @param {string[]} argv @param {{cwd?:string,env?:NodeJS.ProcessEnv,authorization?:Record<string,unknown>}} [runtime] */
export async function runCompanion(argv, runtime = {}) {
  const cwd = runtime.cwd ?? process.cwd(); const env = runtime.env ?? process.env;
  const dataRoot = env.ZCODE_DATA_ROOT;
  if (!dataRoot) throw new PluginError('DATA_ROOT_REQUIRED', 'Plugin data root is not configured.', { category: 'configuration', remedy: 'Run $zcode:setup.' });
  const parsed = parseArgs(argv); const identity = createIdentityStore({ dataRoot }); const store = createStateStore({ dataRoot });
  if (parsed.command === 'run-reserved-job') return runReserved({ parsed, cwd, env, dataRoot, identity, store, authorization: requireAuthorization(runtime.authorization, ['executionCapability', 'jobId']) });
  const authorization = requireAuthorization(runtime.authorization, ['callerContext']);
  const caller = await identity.consumeCallerContext(authorization.callerContext, { workspace: cwd });
  const controller = createJobController({ store });
  if (parsed.command === 'status') {
    if (parsed.options.all) return { jobs: (await store.listJobs(cwd)).map((job) => publicJob(job, caller.sessionId)) };
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
  const spec = normalizeSpec({ command: parsed.command, scope: parsed.options.scope, base: parsed.options.base, focus: parsed.positionals.join(' '), task: parsed.positionals.join(' '), model: parsed.options.model, effort: parsed.options.effort, resumeSessionId: parsed.options.resume === 'resume' ? candidate?.zcodeSessionId : undefined, candidateJobId: parsed.options.resume === 'resume' ? candidate?.id : undefined });
  if (parsed.options.execution === 'background') {
    const specDigest = digestSpec(spec);
    await writeJobSpec(dataRoot, cwd, job, spec, specDigest);
    const capability = await identity.createExecutionCapability({ jobId: job.id, ownerSessionId: caller.sessionId, workspace: cwd, operation: 'run-reserved-job', permissionSnapshot, specDigest });
    return { type: 'background', job, privateInvocation: ['run-reserved-job', job.id], executionCapability: capability };
  }
  return executeReserved({ ...context, job, spec });
}

/** @param {any} input */
async function runReserved({ parsed, cwd, env, dataRoot, identity, store, authorization }) {
  const jobId = parsed.positionals[0]; const job = await store.readJob(cwd, jobId);
  if (authorization.jobId !== jobId) throw authorizationInputError();
  const record = await readJobSpec(dataRoot, cwd, jobId);
  const spec = normalizeSpec(record.spec);
  const recomputed = digestSpec(spec);
  if (record.digest !== recomputed || record.jobId !== job.id || record.ownerSessionId !== job.ownerSessionId || record.workspace !== job.workspace) throw new PluginError('JOB_SPEC_TAMPERED', 'Reserved job specification failed its immutable binding.', { category: 'authorization', remedy: 'Reserve a new background job.' });
  const consumed = await identity.consumeExecutionCapability(authorization.executionCapability, { jobId, ownerSessionId: job.ownerSessionId, workspace: cwd, operation: 'run-reserved-job', specDigest: recomputed });
  if (!sameJson(consumed.permissionSnapshot, job.permissionSnapshot)) throw new PluginError('EXECUTION_SNAPSHOT_MISMATCH', 'Execution capability permission snapshot does not match the reserved job.', { category: 'authorization', remedy: 'Issue a new capability from the exact reserved job.' });
  if (job.status !== 'queued') throw new PluginError('RESERVED_JOB_NOT_QUEUED', `Reserved job ${jobId} is ${job.status}.`, { category: 'state', remedy: 'Generate a new execution capability only for a queued job.' });
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
    const preResolvedModel = spec.model && (spec.model.includes('/') || Object.hasOwn(modelAliases, spec.model)) ? resolveModel(spec.model, modelAliases, []) : undefined;
    return await executeJob({ job, workspace: cwd, dataRoot, store, client, scope: spec.scope, base: spec.base, focus: spec.focus, task: spec.task, model: preResolvedModel, modelRequest: preResolvedModel ? undefined : spec.model, modelAliases, effort: spec.effort, resumeSessionId: spec.resumeSessionId, onBeforeResume: async () => { await validateResumeCandidate(store, cwd, job.ownerSessionId, spec); await reconcileBrokerOwnership({ dataRoot, workspace: cwd, ownerId, ownedSessionIds: [spec.resumeSessionId] }); } });
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
/** @param {string|undefined} raw */
function parseAliases(raw) {
  if (!raw) return {};
  try { const value = JSON.parse(raw); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch { throw new PluginError('MODEL_ALIASES_INVALID', 'Configured model aliases are invalid JSON.', { category: 'configuration', remedy: 'Run $zcode:setup and repair model aliases.' }); }
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
/** @param {unknown} value @param {number} [fd] */
function writeInternalResponse(value, fd = 4) { const data = `${JSON.stringify(value)}\n`; if (Buffer.byteLength(data) > 1024 * 1024) throw new PluginError('INTERNAL_RESPONSE_TOO_LARGE', 'Internal response exceeded its limit.', { category: 'runtime', remedy: 'Inspect the job through status/result.' }); writeFileSync(fd, data); }

async function main() {
  try {
    const authorization = await readInternalEnvelope();
    /** @type {any} */
    const output = await runCompanion(process.argv.slice(2), { authorization });
    writeInternalResponse(output); process.stdout.write(renderOutput(output)); if (output?.type === 'needs-choice') process.exitCode = 3;
  }
  catch (error) { const envelope = errorEnvelope(error); try { writeInternalResponse(envelope); } catch { /* no trusted response channel */ } process.stdout.write(renderOutput(envelope, { json: true })); if (process.env.ZCODE_DEBUG === '1') process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = error instanceof PluginError && error.category === 'validation' ? 2 : 1; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
