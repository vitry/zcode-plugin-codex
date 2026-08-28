#!/usr/bin/env node
// @ts-nocheck
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { resolvePluginDataContext } from '../scripts/lib/plugin-data.mjs';
import { RESCUE_LAUNCHER_ERROR_CONTEXT, SESSION_START_ADDITIONAL_CONTEXT_LIMIT, renderRescueLauncherCommand, renderRescueUserPromptContextWithinLimit } from '../scripts/lib/rescue-launcher-command.mjs';
import { readHookInput } from './lib/hook-input.mjs';
import { recordSession } from './lib/hook-state.mjs';

try {
  const input = await readHookInput('SessionStart');
  const pluginData = resolvePluginDataContext({ env: process.env, pluginRoot: resolve(fileURLToPath(new URL('../', import.meta.url))), entryPath: process.argv[1] });
  await recordSession(pluginData.dataRoot, input);
  let additionalContext = 'ZCode companion lifecycle is active for this parent session.';
  if (input.source === 'compact') {
    try {
      const command = renderRescueLauncherCommand(join(pluginData.runtimePluginRoot, 'skills', 'rescue', 'launcher.mjs'));
      additionalContext = renderRescueUserPromptContextWithinLimit(command, [], SESSION_START_ADDITIONAL_CONTEXT_LIMIT);
    } catch {
      additionalContext = RESCUE_LAUNCHER_ERROR_CONTEXT;
    }
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }));
}
catch (error) { process.stderr.write(`ZCode lifecycle hook failed safely: ${error?.code ?? 'HOOK_FAILED'}\n`); process.exitCode = 1; }
