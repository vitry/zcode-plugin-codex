#!/usr/bin/env node
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { PluginError } from '../../scripts/lib/errors.mjs';
import { errorEnvelope, renderOutput } from '../../scripts/lib/render.mjs';
import { runCompanionCli } from '../../scripts/zcode-companion.mjs';

const ALLOWED = new Set([
  ['role-status', 'rescue'],
  ['prepare', 'rescue'],
  ['invoke-prepared', 'rescue'],
  ['invoke-status', 'rescue'],
  ['invoke-choice', 'rescue', 'resume'],
  ['invoke-choice', 'rescue', 'fresh'],
].map((argv) => JSON.stringify(argv)));

/** @param {string[]} argv @param {(argv:string[])=>Promise<unknown>} [dispatch] */
export async function runRescueLauncher(argv, dispatch = runCompanionCli) {
  if (!Array.isArray(argv) || !argv.every((value) => typeof value === 'string') || !ALLOWED.has(JSON.stringify(argv))) {
    throw new PluginError('RESCUE_LAUNCHER_ARGUMENT_INVALID', 'The Rescue launcher command is invalid.', {
      category: 'validation', remedy: 'Use only the fixed command documented by the active Rescue Skill.',
    });
  }
  return dispatch(argv);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { await runRescueLauncher(process.argv.slice(2)); }
  catch (error) {
    process.stdout.write(renderOutput(errorEnvelope(error), { json: true }));
    process.exitCode = error instanceof PluginError && error.category === 'validation' ? 2 : 1;
  }
}
