#!/usr/bin/env node
// @ts-nocheck
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { resolvePluginDataRoot } from '../scripts/lib/plugin-data.mjs';
import { readHookInput } from './lib/hook-input.mjs';
import { recordSession } from './lib/hook-state.mjs';

try { const input = await readHookInput('SessionStart'); const dataRoot = resolvePluginDataRoot({ env: process.env, pluginRoot: resolve(fileURLToPath(new URL('../', import.meta.url))) }); await recordSession(dataRoot, input); process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ZCode companion lifecycle is active for this parent session.' } })); }
catch (error) { process.stderr.write(`ZCode lifecycle hook failed safely: ${error?.code ?? 'HOOK_FAILED'}\n`); process.exitCode = 1; }
