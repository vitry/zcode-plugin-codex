#!/usr/bin/env node
// @ts-nocheck
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createIdentityStore } from '../scripts/lib/identity.mjs';
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
      const retainedWritableGuard = (await store.listOwnedJobs(input.cwd, ownerSessionId)).some((job) => job.command === 'rescue'
        && job.readOnly === false && !['succeeded', 'failed', 'cancelled'].includes(job.status));
      ownerReleaseSafe = !retainedWritableGuard;
    } catch { /* retain broker ownership unless durable state proves release safe */ }
    const remainingRemoteBudgetMs = remoteDeadline - Date.now();
    if (ownerReleaseSafe && remainingRemoteBudgetMs > 0) await releaseManagedZCodeOwner({
      dataRoot,
      workspace: input.cwd,
      ownerId,
      requestTimeoutMs: Math.min(ownerReleaseRequestTimeoutMs, remainingRemoteBudgetMs),
      cleanupBudgetMs: Math.min(ownerReleaseMaximumBudgetMs, remainingRemoteBudgetMs),
    }).catch(() => null);
  } finally { clearTimeout(remoteTimer); }
  await Promise.allSettled([
    cleanupSession(dataRoot, input.cwd, ownerSessionId),
    createIdentityStore({ dataRoot }).cleanupSession(input.cwd, ownerSessionId),
  ]);
} catch (error) {
  process.stderr.write(`ZCode session cleanup advisory failed: ${error?.code ?? 'HOOK_FAILED'}\n`);
  process.exitCode = 1;
}
