#!/usr/bin/env node
// @ts-nocheck
import { access, writeFile } from 'node:fs/promises';

import { createJobController } from '../../scripts/lib/job-control.mjs';
import { createStateStore } from '../../scripts/lib/state.mjs';

const [mode, dataRoot, workspace, jobId, readyPath, releasePath, stopMarker] = process.argv.slice(2);
const waitForFile = async (path) => { while (true) { try { await access(path); return; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); } } };
const store = createStateStore({ dataRoot });
const controller = createJobController({
  store,
  dataRoot,
  afterFollowerSelected: mode === 'follower' ? async () => { await writeFile(readyPath, 'follower'); } : undefined,
  stopSession: async () => {
    if (mode === 'leader') { await writeFile(readyPath, 'leader'); await waitForFile(releasePath); throw new Error('refused'); }
    await writeFile(stopMarker, 'unexpected second stop'); throw new Error('unexpected second stop');
  },
});
try { const job = await controller.cancel(workspace, jobId, 'owner'); process.stdout.write(`${JSON.stringify({ job })}\n`); }
catch (error) { const job = await store.readJob(workspace, jobId); process.stdout.write(`${JSON.stringify({ error: { code: error.code, message: error.message }, job })}\n`); }
