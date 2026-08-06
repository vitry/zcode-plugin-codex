#!/usr/bin/env node
// @ts-nocheck
import process from 'node:process';
import { createIdentityStore } from '../scripts/lib/identity.mjs';
import { fingerprintWorkspace, isOwnedSession, unreadJobs } from './lib/hook-state.mjs';
import { readHookInput } from './lib/hook-input.mjs';

try {
  const input = await readHookInput('UserPromptSubmit'); const dataRoot = process.env.PLUGIN_DATA; if (!dataRoot) throw new Error('PLUGIN_DATA required');
  if (!await isOwnedSession(dataRoot, input)) { process.stdout.write('{}'); process.exit(0); }
  const identity = createIdentityStore({ dataRoot }); await identity.beginCallerTurn({ sessionId: input.session_id, turnId: input.turn_id, workspace: input.cwd, permissionMode: input.permission_mode, prompt: input.prompt });
  try { const fingerprint = await fingerprintWorkspace(input.cwd); await identity.recordGateBaseline({ sessionId: input.session_id, turnId: input.turn_id, workspace: input.cwd, fingerprint, permissionSnapshot: { permissionMode: input.permission_mode } }); } catch (error) { if (error?.code === 'GATE_BASELINE_EXISTS') { /* another exact hook invocation already recorded it */ } else { /* review gating is optional; caller authorization is not */ } }
  const unread = await unreadJobs(dataRoot, input.cwd, input.session_id);
  const context = [];
  if (unread.length) context.push(`Completed ZCode jobs are waiting: ${unread.map((job) => `${job.id} (${job.status})`).join(', ')}. Mention only these job IDs and suggest $zcode:status / $zcode:result when relevant.`);
  process.stdout.write(JSON.stringify(context.length ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context.join('\n') } } : {}));
} catch (error) { process.stderr.write(`ZCode prompt hook failed safely: ${error?.code ?? 'HOOK_FAILED'}\n`); process.exitCode = 1; }
