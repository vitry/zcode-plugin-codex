#!/usr/bin/env node
// @ts-nocheck
import process from 'node:process';
import { readHookInput } from './lib/hook-input.mjs';
import { markForwarding } from './lib/hook-state.mjs';

try { const input = await readHookInput(['SubagentStart', 'SubagentStop']); const rawEvent = input.hook_event_name; if (!process.env.PLUGIN_DATA) throw new Error('PLUGIN_DATA required'); await markForwarding(process.env.PLUGIN_DATA, input); process.stdout.write(rawEvent === 'SubagentStart' ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: 'This is a forwarding subagent. Do not run the parent Stop review gate or mint a parent caller capability.' } }) : '{}'); }
catch (error) { process.stderr.write(`ZCode subagent hook failed safely: ${error?.code ?? 'HOOK_FAILED'}\n`); process.exitCode = 1; }
