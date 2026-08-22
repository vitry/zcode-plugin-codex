#!/usr/bin/env node
// @ts-nocheck
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { resolvePluginDataRoot } from '../scripts/lib/plugin-data.mjs';
import { createIdentityStore } from '../scripts/lib/identity.mjs';
import { readHookInput } from './lib/hook-input.mjs';
import { markForwarding } from './lib/hook-state.mjs';

try { const input = await readHookInput(['SubagentStart', 'SubagentStop']); const rawEvent = input.hook_event_name; const dataRoot = resolvePluginDataRoot({ env: process.env, pluginRoot: resolve(fileURLToPath(new URL('../', import.meta.url))) }); const parentCaller = rawEvent === 'SubagentStart' ? await createIdentityStore({ dataRoot }).resolveActiveTurn({ sessionId: input.session_id, workspace: input.cwd, workspaceBinding: 'execution' }) : undefined; await markForwarding(dataRoot, input, parentCaller); process.stdout.write(rawEvent === 'SubagentStart' ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: 'This is a forwarding subagent. Do not run the parent Stop review gate or mint a parent caller capability.' } }) : '{}'); }
catch (error) { process.stderr.write(`ZCode subagent hook failed safely: ${error?.code ?? 'HOOK_FAILED'}\n`); process.exitCode = 1; }
