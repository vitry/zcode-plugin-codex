import { PluginError } from './errors.mjs';
import { ownerIdForSession, withJobCancellationLock } from './job-control.mjs';
import { extractFinalResult, writeResultArtifact } from './review.mjs';
import { withFileLock } from './fs.mjs';
import { resolveWorkspaceStorage } from './workspace.mjs';
import { reconcileBrokerOwnership } from '../zcode-broker.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const REMOTE_ACTIVE = new Set(['running', 'waiting']);
export const LEGACY_QUEUED_STALE_MS = 5 * 60_000;

/** Hold the exact production worker identity for its full lifetime. @param {{dataRoot:string,workspace:string,jobId:string,workerLeaseId:string,timeoutMs?:number}} input @param {()=>Promise<any>} operation */
export async function withWorkerLease(input, operation) {
  if (!isDigest(input.jobId) || !isDigest(input.workerLeaseId)) throw recoveryError('Worker lease identity is invalid.');
  const storage = await resolveWorkspaceStorage({ dataRoot: input.dataRoot, workspace: input.workspace });
  return withFileLock(joinWorkerLease(storage.directory, input.jobId, input.workerLeaseId), operation, { timeoutMs: input.timeoutMs ?? 30_000 });
}

/** Reconcile only provably orphaned jobs owned by one exact Codex session. @param {{store:any,dataRoot:string,workspace:string,ownerSessionId:string,createClient:(job:any,ownerId:string)=>Promise<any>,reconcileOwnership?:(input:any)=>Promise<any>,now?:()=>number}} input */
export async function reconcileOwnedJobs(input) {
  const reconcileOwnership = input.reconcileOwnership ?? reconcileBrokerOwnership;
  const jobs = (await input.store.listJobs(input.workspace)).filter((/** @type {any} */ job) => job.ownerSessionId === input.ownerSessionId && !TERMINAL.has(job.status));
  const outcomes = [];
  for (const job of jobs) {
    try {
      outcomes.push(await withJobCancellationLock({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: job.id }, async () => {
        const current = await input.store.readJob(input.workspace, job.id);
        if (current.ownerSessionId !== input.ownerSessionId || TERMINAL.has(current.status)) return current;
        if (current.status === 'queued' && !isDigest(current.workerLeaseId)) {
          return (input.now ?? Date.now)() - Date.parse(current.updatedAt) >= LEGACY_QUEUED_STALE_MS
            ? failJob(input, current, recoveryError('Legacy queued reservation exceeded the conservative worker-claim grace period.'))
            : current;
        }
        if (!isDigest(current.workerLeaseId) && legacyWorkerAlive(current)) return current;
        if (!isDigest(current.workerLeaseId)) return reconcileOrphan(input, current, reconcileOwnership);
        try {
          return await withWorkerLease({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: current.id, workerLeaseId: current.workerLeaseId, timeoutMs: 0 }, () => current.status === 'queued'
            ? failJob(input, current, recoveryError('Claimed queued worker exited before execution started.'))
            : reconcileOrphan(input, current, reconcileOwnership));
        } catch (error) {
          if (error instanceof PluginError && error.code === 'LOCK_TIMEOUT') return current;
          throw error;
        }
      }));
    } catch { outcomes.push(job); }
  }
  return outcomes;
}

/** @param {any} input @param {any} job @param {(input:any)=>Promise<any>} reconcileOwnership */
async function reconcileOrphan(input, job, reconcileOwnership) {
  let client;
  try {
    if (job.status === 'queued') return failJob(input, job, recoveryError('Queued worker reservation is orphaned.'));
    if (typeof job.zcodeSessionId !== 'string') return failJob(input, job, recoveryError('Worker exited before a remote session was accepted.'));
    const ownerId = ownerIdForSession(job.ownerSessionId);
    await reconcileOwnership({ dataRoot: input.dataRoot, workspace: input.workspace, ownerId, ownedSessionIds: [job.zcodeSessionId] });
    client = await input.createClient(job, ownerId);
    let listed;
    try { listed = await client.listSessions(); }
    catch (error) { return settleAmbiguity(input, job, client, error); }
    if (!Array.isArray(listed?.sessions)) return settleAmbiguity(input, job, client, recoveryError('ZCode session listing is malformed during recovery.'));
    if (!listed.sessions.some((/** @type {any} */ session) => session.sessionId === job.zcodeSessionId)) return failJob(input, job, recoveryError('ZCode session is missing during recovery.'));
    if (job.command === 'transfer') return stopThenFail(input, job, client, recoveryError('Transfer worker exited before local finalization.'));
    if (!hasBoundary(job)) return stopThenFail(input, job, client, recoveryError('The durable turn boundary is incomplete.'));
    let snapshot;
    try { snapshot = await client.readSession(job.zcodeSessionId); }
    catch (error) { return settleAmbiguity(input, job, client, error); }
    if (!Number.isSafeInteger(snapshot?.runtime?.stateRevision) || snapshot.runtime.stateRevision < job.startRevision) return settleAmbiguity(input, job, client, recoveryError('ZCode recovery state is older than the accepted turn boundary.'));
    const remoteStatus = snapshot?.projection?.status;
    if (REMOTE_ACTIVE.has(remoteStatus)) {
      return job.status === 'cancelling' ? stopThenCancel(input, job, client) : job;
    }
    if (remoteStatus === 'paused') return cancelJob(input, job);
    if (remoteStatus === 'error') return failJob(input, job, recoveryError(snapshot?.projection?.lastError?.message ?? 'ZCode reported a terminal error during recovery.'));
    if (!['completed', 'idle'].includes(remoteStatus)) return settleAmbiguity(input, job, client, recoveryError('ZCode recovery state is ambiguous.'));
    try {
      const result = extractFinalResult(snapshot, job.command, { inputId: job.inputId, stateRevision: job.startRevision, beforeMessageIds: new Set(job.beforeMessageIds) });
      const resultArtifact = await writeResultArtifact({ dataRoot: input.dataRoot, workspace: input.workspace, jobId: job.id, contents: result });
      return await input.store.transitionJob(input.workspace, job.id, ['running', 'cancelling'], 'succeeded', { resultArtifact, finishedAt: new Date().toISOString(), exitCode: 0 });
    } catch (error) { return failJob(input, job, error); }
  } catch (error) {
    const current = await input.store.readJob(input.workspace, job.id);
    if (TERMINAL.has(current.status)) return current;
    return client ? settleAmbiguity(input, current, client, error) : retainAfterStopFailure(input, current, error);
  } finally { await client?.close().catch(() => {}); }
}

/** @param {any} job */
function hasBoundary(job) { return typeof job.inputId === 'string' && Number.isSafeInteger(job.startRevision) && Array.isArray(job.beforeMessageIds); }
/** @param {any} input @param {any} job @param {unknown} error */
async function failJob(input, job, error) {
  const current = await input.store.readJob(input.workspace, job.id);
  if (TERMINAL.has(current.status)) return current;
  return input.store.transitionJob(input.workspace, job.id, [current.status], 'failed', { error: { message: recoveryMessage(error) }, finishedAt: new Date().toISOString(), exitCode: 1 });
}
/** @param {any} input @param {any} job */
async function cancelJob(input, job) {
  const current = await input.store.readJob(input.workspace, job.id);
  if (TERMINAL.has(current.status)) return current;
  if (current.status === 'running') await input.store.transitionJob(input.workspace, job.id, ['running'], 'cancelling');
  return input.store.transitionJob(input.workspace, job.id, ['cancelling'], 'cancelled', { finishedAt: new Date().toISOString(), exitCode: null });
}
/** @param {any} input @param {any} job @param {any} client @param {unknown} error */
async function settleAmbiguity(input, job, client, error) { return stopThenFail(input, job, client, error); }
/** @param {any} input @param {any} job @param {any} client @param {unknown} error */
async function stopThenFail(input, job, client, error) {
  const stopped = await stopRemote(job, client);
  return stopped.ok ? failJob(input, job, error) : retainAfterStopFailure(input, job, stopped.error);
}
/** @param {any} input @param {any} job @param {any} client */
async function stopThenCancel(input, job, client) {
  const stopped = await stopRemote(job, client);
  return stopped.ok ? cancelJob(input, job) : retainAfterStopFailure(input, job, stopped.error);
}
/** @param {any} job @param {any} client */
async function stopRemote(job, client) {
  try { await client.stopSession(job.zcodeSessionId); return { ok: true }; }
  catch (error) { return { ok: false, error }; }
}
/** @param {any} input @param {any} job @param {unknown} error */
async function retainAfterStopFailure(input, job, error) {
  const current = await input.store.readJob(input.workspace, job.id);
  if (TERMINAL.has(current.status)) return current;
  const message = recoveryMessage(error);
  return input.store.transitionJob(input.workspace, job.id, [current.status], 'running', { lastCancelError: message });
}
/** @param {unknown} error */
function recoveryMessage(error) { return (error instanceof Error ? error.message : 'Unknown recovery failure').slice(0, 2_048); }
/** @param {string} message */
function recoveryError(message) { return new PluginError('JOB_RECOVERY_FAILED', message, { category: 'state', remedy: 'Inspect the durable job and its ZCode session.' }); }
/** @param {string} directory @param {string} jobId @param {string} workerLeaseId */
function joinWorkerLease(directory, jobId, workerLeaseId) { return `${directory}/worker-leases/${jobId}-${workerLeaseId}.lock`; }
/** @param {unknown} value */
function isDigest(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
/** @param {any} job */
function legacyWorkerAlive(job) {
  if (!Number.isSafeInteger(job.childPid) || job.childPid <= 0) return false;
  try { process.kill(job.childPid, 0); return true; }
  catch (error) { return error && typeof error === 'object' && 'code' in error && error.code === 'EPERM'; }
}
