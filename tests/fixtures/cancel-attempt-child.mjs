#!/usr/bin/env node
// @ts-nocheck
import { createJobController } from '../../scripts/lib/job-control.mjs';
import { createStateStore } from '../../scripts/lib/state.mjs';

const [mode, dataRoot, workspace, jobId] = process.argv.slice(2);
const ipcBarrier = (type) => new Promise((resolve) => { process.once('message', resolve); process.send({ type }); });
const store = createStateStore({ dataRoot });
const controller = createJobController({
  store,
  dataRoot,
  afterFollowerSelected: mode === 'follower-ipc' ? async () => { process.send({ type: 'follower-selected' }); } : undefined,
  stopSession: async () => {
    if (mode === 'leader-success-ipc') { await ipcBarrier('stop-entered'); return; }
    if (mode === 'leader-failure-ipc') { await ipcBarrier('stop-entered'); throw new Error('refused'); }
    throw new Error('unexpected second stop');
  },
});
try { const job = await controller.cancel(workspace, jobId, 'owner'); process.stdout.write(`${JSON.stringify({ job })}\n`); }
catch (error) { const job = await store.readJob(workspace, jobId); process.stdout.write(`${JSON.stringify({ error: { code: error.code, message: error.message }, job })}\n`); }
