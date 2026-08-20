#!/usr/bin/env node
// @ts-nocheck
import process from 'node:process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createIdentityStore } from '../scripts/lib/identity.mjs';
import { createRescuePreparationStore } from '../scripts/lib/rescue-preparation.mjs';
import { resolvePluginDataRoot } from '../scripts/lib/plugin-data.mjs';
import { RESCUE_LAUNCHER_ERROR_CONTEXT, renderRescueLauncherCommand, renderRescueUserPromptContext } from '../scripts/lib/rescue-launcher-command.mjs';
import { fingerprintWorkspace, isOwnedSession, unreadJobs } from './lib/hook-state.mjs';
import { readHookInput } from './lib/hook-input.mjs';

try {
  const input = await readHookInput('UserPromptSubmit');
  if (input.agent_id !== undefined) { process.stdout.write('{}'); process.exit(0); }
  const dataRoot = resolvePluginDataRoot({ env: process.env, pluginRoot: resolve(fileURLToPath(new URL('../', import.meta.url))) });
  if (!await isOwnedSession(dataRoot, input)) { process.stdout.write('{}'); process.exit(0); }
  let rescueLauncherCommand;
  try { rescueLauncherCommand = renderRescueLauncherCommand(realpathSync(fileURLToPath(new URL('../skills/rescue/launcher.mjs', import.meta.url)))); }
  catch { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: RESCUE_LAUNCHER_ERROR_CONTEXT } })); process.exit(0); }
  const identity = createIdentityStore({ dataRoot });
  await createRescuePreparationStore({ dataRoot }).cleanupOlderTurns({ sessionId: input.session_id, turnId: input.turn_id, workspace: input.cwd });
  await identity.beginCallerTurn({ sessionId: input.session_id, turnId: input.turn_id, workspace: input.cwd, permissionMode: input.permission_mode, prompt: input.prompt });
  try { const fingerprint = await fingerprintWorkspace(input.cwd); await identity.recordGateBaseline({ sessionId: input.session_id, turnId: input.turn_id, workspace: input.cwd, fingerprint, permissionSnapshot: { permissionMode: input.permission_mode } }); } catch (error) { if (error?.code === 'GATE_BASELINE_EXISTS') { /* another exact hook invocation already recorded it */ } else { /* review gating is optional; caller authorization is not */ } }
  const unread = await unreadJobs(dataRoot, input.cwd, input.session_id);
  const context = renderRescueUserPromptContext(rescueLauncherCommand, unread);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }));
} catch (error) { process.stderr.write(`ZCode prompt hook failed safely: ${error?.code ?? 'HOOK_FAILED'}\n`); process.exitCode = 1; }
