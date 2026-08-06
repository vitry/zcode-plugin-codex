#!/usr/bin/env node
// @ts-nocheck
import process from 'node:process';
import { readHookInput } from './lib/hook-input.mjs';
import { recordSession } from './lib/hook-state.mjs';

try { const input = await readHookInput('SessionStart'); if (!process.env.PLUGIN_DATA) throw new Error('PLUGIN_DATA required'); await recordSession(process.env.PLUGIN_DATA, input); process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ZCode companion lifecycle is active for this parent session.' } })); }
catch (error) { process.stderr.write(`ZCode lifecycle hook failed safely: ${error?.code ?? 'HOOK_FAILED'}\n`); process.exitCode = 1; }
