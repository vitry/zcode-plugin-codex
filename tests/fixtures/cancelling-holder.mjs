#!/usr/bin/env node
// @ts-nocheck
import { join } from 'node:path';

import { withFileLock } from '../../scripts/lib/fs.mjs';
import { createStateStore } from '../../scripts/lib/state.mjs';
import { resolveWorkspaceStorage } from '../../scripts/lib/workspace.mjs';

const [dataRoot, workspace, jobId] = process.argv.slice(2);
const store = createStateStore({ dataRoot }); const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
await withFileLock(join(storage.directory, 'cancel-locks', `${jobId}.lock`), async () => {
  await store.transitionJob(workspace, jobId, ['running'], 'cancelling');
  process.stdout.write('ready\n');
  await new Promise(() => {});
});
