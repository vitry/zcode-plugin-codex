// @ts-nocheck
import process from 'node:process';
import { readHookInput } from '../../hooks/lib/hook-input.mjs';
import { runStopReviewGate } from '../../hooks/stop-review-gate-hook.mjs';

const input = await readHookInput('Stop');
const dataRoot = process.env.PLUGIN_DATA;
if (!dataRoot) throw new Error('PLUGIN_DATA required');
process.stdout.write(JSON.stringify(await runStopReviewGate(input, { dataRoot, env: process.env, timeoutMs: 100 })));
