import { PluginError } from './errors.mjs';
import { ownerIdForSession, withJobCancellationLock } from './job-control.mjs';
import { extractFinalResult, writeResultArtifact } from './review.mjs';
import { withFileLock } from './fs.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';
import { reconcileBrokerOwnership } from '../zcode-broker.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const REMOTE_ACTIVE = new Set(['running', 'waiting']);

/** Hold the exact production worker identity for its full lifetime. @param {{dataRoot:string,workspace:string,jobId:string,workerLeaseId:string,timeoutMs?:number}} input @param {()=>Promise<any>} operation */
export async function withWorkerLease(input, operation) {
  if (!isDigest(input.jobId) || !isDigest(input.workerLeaseId)) throw recoveryError('Worker lease identity is invalid.');
  const storage = await resolveWorkspaceStorage({ dataRoot: input.dataRoot, workspace: input.workspace });
  return withFileLock(joinWorkerLease(storage.directory, input.jobId, input.workerLeaseId), operation, { timeoutMs: input.timeoutMs ?? 30_000 });
}

/** Reconcile only provably orphaned jobs owned by one exact Codex session. @param {{store:any,dataRoot:string,workspace:string,ownerSessionId:string,createClient:(job:any,ownerId:string)=>Promise<any>,reconcileOwnership?:(input:any)=>Promise<any>}} input */
export async function reconcileOwnedJobs(input) {
  const reconcileOwnership = input.reconcileOwnership ?? reconcileBrokerOwnership;
  const jobs = (await input.store.listJobs(input.workspace)).filter((/** @type {any} */ job) => job.ownerSessionId === input.ownerSessionId && !TERMINAL.has(job.status));
  const outcomes = [];
  for (const job of jobs) {
    if (!isDigest(job.workerLeaseId)) continue;
    outcomes.push(await withJobCancellationLock({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: job.id }, async () => {
      const current = await input.store.readJob(input.workspace, job.id);
      if (current.ownerSessionId !== input.ownerSessionId || TERMINAL.has(current.status) || !isDigest(current.workerLeaseId)) return current;
      if (!['running', 'cancelling'].includes(current.status)) return current;
      try {
        return await withWorkerLease({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: current.id, workerLeaseId: current.workerLeaseId, timeoutMs: 0 }, () => reconcileOrphan(input, current, reconcileOwnership));
      } catch (error) {
        if (error instanceof PluginError && error.code === 'LOCK_TIMEOUT') return current;
        throw error;
      }
    }));
  }
  return outcomes;
}

/** @param {any} input @param {any} job @param {(input:any)=>Promise<any>} reconcileOwnership */
async function reconcileOrphan(input, job, reconcileOwnership) {
  let client;
  try {
    requireBoundary(job);
    const ownerId = ownerIdForSession(job.ownerSessionId);
    await reconcileOwnership({ dataRoot: input.dataRoot, workspace: input.workspace, ownerId, ownedSessionIds: [job.zcodeSessionId] });
    client = await input.createClient(job, ownerId);
    const listed = await client.listSessions();
    if (!listed.sessions.some((/** @type {any} */ session) => session.sessionId === job.zcodeSessionId)) throw recoveryError('ZCode session is missing during recovery.');
    const snapshot = await client.readSession(job.zcodeSessionId);
    if (!Number.isSafeInteger(snapshot?.runtime?.stateRevision) || snapshot.runtime.stateRevision < job.startRevision) throw recoveryError('ZCode recovery state is older than the accepted turn boundary.');
    const remoteStatus = snapshot?.projection?.status;
    if (REMOTE_ACTIVE.has(remoteStatus)) return job;
    if (job.status === 'cancelling' || remoteStatus === 'paused') {
      const cancelling = job.status === 'running' ? await input.store.transitionJob(input.workspace, job.id, ['running'], 'cancelling') : job;
      return await input.store.transitionJob(input.workspace, job.id, [cancelling.status], 'cancelled', { finishedAt: new Date().toISOString(), exitCode: null });
    }
    if (remoteStatus === 'error') throw recoveryError(snapshot?.projection?.lastError?.message ?? 'ZCode reported a terminal error during recovery.');
    if (!['completed', 'idle'].includes(remoteStatus)) throw recoveryError('ZCode recovery state is ambiguous.');
    const result = extractFinalResult(snapshot, job.command, { inputId: job.inputId, stateRevision: job.startRevision, beforeMessageIds: new Set(job.beforeMessageIds) });
    const resultArtifact = await writeResultArtifact({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: job.id, contents: result });
    return await input.store.transitionJob(input.workspace, job.id, ['running'], 'succeeded', { resultArtifact, finishedAt: new Date().toISOString(), exitCode: 0 });
  } catch (error) {
    const current = await input.store.readJob(input.workspace, job.id);
    if (TERMINAL.has(current.status)) return current;
    return await input.store.transitionJob(input.workspace, job.id, [current.status], 'failed', { error: { message: recoveryMessage(error) }, finishedAt: new Date().toISOString(), exitCode: 1 });
  } finally { await client?.close().catch(() => {}); }
}

/** @param {any} job */
function requireBoundary(job) {
  if (typeof job.zcodeSessionId !== 'string' || typeof job.inputId !== 'string' || !Number.isSafeInteger(job.startRevision) || !Array.isArray(job.beforeMessageIds)) throw recoveryError('The durable turn boundary is incomplete.');
}
/** @param {unknown} error */
function recoveryMessage(error) { return (error instanceof Error ? error.message : 'Unknown recovery failure').slice(0, 2_048); }
/** @param {string} message */
function recoveryError(message) { return new PluginError('JOB_RECOVERY_FAILED', message, { category: 'state', remedy: 'Inspect the durable job and its ZCode session.' }); }
/** @param {string} directory @param {string} jobId @param {string} workerLeaseId */
function joinWorkerLease(directory, jobId, workerLeaseId) { return `${directory}/worker-leases/${jobId}-${workerLeaseId}.lock`; }
/** @param {unknown} value */
function isDigest(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
