#!/usr/bin/env node
// @ts-nocheck
import { join } from 'node:path';
import process from 'node:process';

import { withFileLock } from '../../scripts/lib/fs.mjs';
import { resolveWorkspaceStorage } from '../../scripts/lib/workspace.mjs';

const [dataRoot, workspace, identityName] = process.argv.slice(2); const storage = await resolveWorkspaceStorage({ dataRoot, workspace }); const ownershipName = identityName.replace(/^identity/, 'session-owners'); const lockPath = join(storage.directory, 'broker', `${ownershipName}.lock`);
process.stdout.write(`armed:${lockPath}\n`);
await new Promise((resolve) => process.stdin.once('data', resolve));
await withFileLock(lockPath, async () => { process.stdout.write(`ready:${lockPath}\n`); await new Promise((resolve) => process.stdin.once('data', resolve)); });
