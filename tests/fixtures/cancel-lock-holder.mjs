#!/usr/bin/env node
import { join } from 'node:path';

import { atomicWriteJson, withFileLock } from '../../scripts/lib/fs.mjs';
import { createStateStore } from '../../scripts/lib/state.mjs';
import { resolveWorkspaceStorage } from '../../scripts/lib/workspace.mjs';

const [dataRoot, workspace, jobId, mode = 'before-active', attemptId = 'a'.repeat(64)] = process.argv.slice(2); const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
await withFileLock(join(storage.directory, 'cancel-locks', `${jobId}.lock`), async () => {
  if (mode === 'after-active' || mode === 'failed-pending') {
    const now = new Date().toISOString();
    if (mode === 'failed-pending') {
      const store = createStateStore({ dataRoot }); await store.transitionJob(workspace, jobId, ['running'], 'cancelling');
      await store.transitionJob(workspace, jobId, ['cancelling'], 'running', { lastCancelError: 'refused' });
    }
    await atomicWriteJson(join(storage.directory, 'cancel-attempts', `${jobId}.json`), { jobId, ownerSessionId: 'owner', attemptId, status: mode === 'after-active' ? 'active' : 'failed-pending-release', startedAt: now, updatedAt: now, ...(mode === 'failed-pending' ? { error: { message: 'refused' } } : {}) });
  }
  process.stdout.write('ready\n'); await new Promise((resolve) => setTimeout(resolve, 60_000));
});
