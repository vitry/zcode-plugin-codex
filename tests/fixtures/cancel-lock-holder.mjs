#!/usr/bin/env node
import { join } from 'node:path';

import { withFileLock } from '../../scripts/lib/fs.mjs';
import { resolveWorkspaceStorage } from '../../scripts/lib/workspace.mjs';

const [dataRoot, workspace, jobId] = process.argv.slice(2); const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
await withFileLock(join(storage.directory, 'cancel-locks', `${jobId}.lock`), async () => { process.stdout.write('ready\n'); await new Promise((resolve) => setTimeout(resolve, 60_000)); });
