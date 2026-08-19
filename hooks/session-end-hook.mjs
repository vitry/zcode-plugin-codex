#!/usr/bin/env node
// @ts-nocheck
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createIdentityStore } from '../scripts/lib/identity.mjs';
import { createRescuePreparationStore } from '../scripts/lib/rescue-preparation.mjs';
import { ownerIdForSession } from '../scripts/lib/job-control.mjs';
import { resolvePluginDataRoot } from '../scripts/lib/plugin-data.mjs';
import { settleEndedOwnerWritableJob } from '../scripts/lib/recovery.mjs';
import { createStateStore } from '../scripts/lib/state.mjs';
import { createExistingManagedZCodeClient, releaseManagedZCodeOwner } from '../scripts/lib/zcode-client.mjs';
import { cleanupSession } from './lib/hook-state.mjs';
import { readHookInput } from './lib/hook-input.mjs';

const existingBrokerRequestTimeoutMs = process.platform === 'win32' ? 500 : 250;
const ownerReleaseRequestTimeoutMs = process.platform === 'win32' ? 1_000 : 500;
const ownerReleaseMaximumBudgetMs = 1_800;
// Reserve at least one Windows request timeout plus local cleanup time before
// the native hook's three-second hard deadline.
const sessionEndRemoteBudgetMs = 1_750;

try {
  const input = await readHookInput('SessionEnd');
  const dataRoot = resolvePluginDataRoot({ env: process.env, pluginRoot: resolve(fileURLToPath(new URL('../', import.meta.url))) });
  const ownerSessionId = input.session_id;
  const ownerId = ownerIdForSession(ownerSessionId);
  const store = createStateStore({ dataRoot });
  const remoteDeadline = Date.now() + sessionEndRemoteBudgetMs;
  const remoteController = new AbortController();
  const remoteTimer = setTimeout(() => remoteController.abort(new Error('SessionEnd remote cleanup reached its deadline.')), sessionEndRemoteBudgetMs);
  remoteTimer.unref?.();
  try {
    let ownerReleaseSafe = false;
    let ownerCleanupStage = 'settlement';
    try {
      await settleEndedOwnerWritableJob({
        store,
        dataRoot,
        workspace: input.cwd,
        ownerSessionId,
        requestTimeoutMs: existingBrokerRequestTimeoutMs,
        lockTimeoutMs: 0,
        signal: remoteController.signal,
        createClient: (job, derivedOwnerId) => createExistingManagedZCodeClient({
          dataRoot,
          workspace: input.cwd,
          ownerId: derivedOwnerId,
          requestTimeoutMs: existingBrokerRequestTimeoutMs,
        }),
      });
      if (remoteController.signal.aborted) throw remoteController.signal.reason;
      ownerCleanupStage = 'retained-writable-guard';
      const ownedJobs = await store.listOwnedJobs(input.cwd, ownerSessionId);
      const retainedJobs = ownedJobs.filter((job) => job.command === 'rescue'
        && job.readOnly === false && !['succeeded', 'failed', 'cancelled'].includes(job.status));
      const retainedWritableGuard = retainedJobs.length > 0;
      if (retainedWritableGuard) process.stderr.write(`ZCode SessionEnd retained writable guard: ${retainedJobs.map((job) => `${job.status}:${typeof job.workerLeaseId === 'string'}`).join(',')}\n`);
      ownerReleaseSafe = !retainedWritableGuard;
    } catch (error) {
      // SessionEnd is advisory, but a sanitized stage/code is essential for
      // distinguishing a durable guard from an unavailable broker cleanup.
      process.stderr.write(`ZCode SessionEnd owner cleanup deferred: ${ownerCleanupStage}:${error?.code ?? 'UNKNOWN'}\n`);
      /* retain broker ownership unless durable state proves release safe */
    }
    const remainingRemoteBudgetMs = remoteDeadline - Date.now();
    if (ownerReleaseSafe && remainingRemoteBudgetMs > 0) {
      try {
        await releaseManagedZCodeOwner({
          dataRoot,
          workspace: input.cwd,
          ownerId,
          requestTimeoutMs: Math.min(ownerReleaseRequestTimeoutMs, remainingRemoteBudgetMs),
          cleanupBudgetMs: Math.min(ownerReleaseMaximumBudgetMs, remainingRemoteBudgetMs),
        });
      } catch (error) {
        const statusCounts = error?.details?.identityStatusCounts; const reasonCounts = error?.details?.identityReasonCounts;
        process.stderr.write(`ZCode SessionEnd broker owner release deferred: ${error?.code ?? 'UNKNOWN'}:${JSON.stringify({ statusCounts: statusCounts ?? {}, reasonCounts: reasonCounts ?? {} })}\n`);
      }
    }
  } finally { clearTimeout(remoteTimer); }
  await Promise.allSettled([
    store.closeRescueBindingsForSession({ workspace: input.cwd, parentSessionId: ownerSessionId, reason: 'session-ended' }),
    cleanupSession(dataRoot, input.cwd, ownerSessionId),
    createIdentityStore({ dataRoot }).cleanupSession(input.cwd, ownerSessionId),
    createRescuePreparationStore({ dataRoot }).cleanupSession({ sessionId: ownerSessionId, workspace: input.cwd }),
  ]);
} catch (error) {
  process.stderr.write(`ZCode session cleanup advisory failed: ${error?.code ?? 'HOOK_FAILED'}\n`);
  process.exitCode = 1;
}
