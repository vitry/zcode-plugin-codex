// @ts-nocheck
import process from 'node:process';
import { readHookInput } from '../../hooks/lib/hook-input.mjs';
import { runStopReviewGate } from '../../hooks/stop-review-gate-hook.mjs';

const input = await readHookInput('Stop');
const dataRoot = process.env.PLUGIN_DATA;
if (!dataRoot) throw new Error('PLUGIN_DATA required');
const discoveryCode = process.env.FAKE_GATE_DISCOVERY_ERROR;
const discoverZCode = discoveryCode ? async () => { throw Object.assign(new Error('fixture discovery failure'), { code: discoveryCode }); } : undefined;
// Windows child startup can consume most of a 100 ms budget under CI. Keep
// the deliberately suppressed completion as the timeout trigger while leaving
// enough time for the fake protocol process to create its session.
const timeoutMs = process.platform === 'win32' ? 2_000 : 100;
process.stdout.write(JSON.stringify(await runStopReviewGate(input, { dataRoot, env: process.env, timeoutMs, ...(discoverZCode ? { discoverZCode } : {}) })));
