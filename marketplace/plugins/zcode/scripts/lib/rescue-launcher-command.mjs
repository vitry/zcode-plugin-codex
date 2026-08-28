import process from 'node:process';
import { posix, win32 } from 'node:path';

import { PluginError } from './errors.mjs';

const MAX_PATH_BYTES = 2048;
const POSIX_SUFFIX = '/skills/rescue/launcher.mjs';
const WINDOWS_SUFFIX = '\\skills\\rescue\\launcher.mjs';
const LAUNCHER_DESCRIPTOR_PREFIX = '[zcode-rescue-launcher] ';
const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

export const USER_PROMPT_ADDITIONAL_CONTEXT_LIMIT = 1800;
export const SESSION_START_ADDITIONAL_CONTEXT_LIMIT = 1200;
export const RESCUE_UNREAD_JOB_LIMIT = 5;
export const RESCUE_LAUNCHER_ERROR_CONTEXT = '[zcode-rescue-launcher-error] {"version":1,"code":"RESCUE_LAUNCHER_PATH_UNSAFE","remedy":"Reinstall the ZCode plugin and retry from a new owned parent turn."}';

const MAX_JOB_NOTICE = jobNotice(Array.from({ length: RESCUE_UNREAD_JOB_LIMIT }, () => ({ id: 'f'.repeat(64), status: 'cancelled' })));
const MAX_LAUNCHER_DESCRIPTOR_BYTES = USER_PROMPT_ADDITIONAL_CONTEXT_LIMIT - Buffer.byteLength(`\n${MAX_JOB_NOTICE}`);

/**
 * Render the only shell command prefix that Rescue instructions may reuse.
 * The path is rejected instead of shell-escaped so Root never interprets or
 * reconstructs quoting rules.
 * @param {string} launcherPath
 * @param {{platform?:NodeJS.Platform|'win32'}} [options]
 */
export function renderRescueLauncherCommand(launcherPath, { platform = process.platform } = {}) {
  if (typeof launcherPath !== 'string' || !launcherPath) throw unsafePath();
  const windows = platform === 'win32';
  const absolute = windows ? win32.isAbsolute(launcherPath) : posix.isAbsolute(launcherPath);
  const correctLeaf = windows
    ? launcherPath.toLowerCase().endsWith(WINDOWS_SUFFIX)
    : launcherPath.endsWith(POSIX_SUFFIX);
  const unsafe = windows
    ? /["`$%!^&|<>]/u.test(launcherPath) || /\\{2,}|[\\/]$/u.test(launcherPath) || hasControlCharacter(launcherPath)
    : /[\\"`$]/u.test(launcherPath) || hasControlCharacter(launcherPath);
  if (!absolute || !correctLeaf || Buffer.byteLength(launcherPath) > MAX_PATH_BYTES || unsafe) throw unsafePath();
  const command = `node "${launcherPath}"`;
  if (Buffer.byteLength(launcherDescriptor(command)) > MAX_LAUNCHER_DESCRIPTOR_BYTES) throw unsafePath();
  return command;
}

/** Render the bounded owned-parent lifecycle context. @param {string} launcherCommand @param {{id:string,status:string}[]} jobs */
export function renderRescueUserPromptContext(launcherCommand, jobs = []) {
  return renderRescueUserPromptContextWithinLimit(launcherCommand, jobs, USER_PROMPT_ADDITIONAL_CONTEXT_LIMIT);
}

/** Render lifecycle context within one explicit hook-event byte budget. @param {string} launcherCommand @param {{id:string,status:string}[]} jobs @param {number} additionalContextLimit */
export function renderRescueUserPromptContextWithinLimit(launcherCommand, jobs, additionalContextLimit) {
  if (typeof launcherCommand !== 'string' || !Array.isArray(jobs) || jobs.length > RESCUE_UNREAD_JOB_LIMIT
    || jobs.some((job) => !job || typeof job !== 'object' || !/^[a-f0-9]{64}$/u.test(job.id) || !TERMINAL_JOB_STATUSES.has(job.status))
    || !Number.isSafeInteger(additionalContextLimit) || additionalContextLimit < 1 || additionalContextLimit > USER_PROMPT_ADDITIONAL_CONTEXT_LIMIT) {
    throw contextError();
  }
  const descriptor = launcherDescriptor(launcherCommand);
  const context = jobs.length ? `${descriptor}\n${jobNotice(jobs)}` : descriptor;
  if (Buffer.byteLength(context) > additionalContextLimit) throw contextError();
  return context;
}

/** @param {string} command */
function launcherDescriptor(command) {
  return `${LAUNCHER_DESCRIPTOR_PREFIX}${JSON.stringify({ version: 1, launcherCommand: command })}`;
}

/** @param {{id:string,status:string}[]} jobs */
function jobNotice(jobs) {
  return `Completed ZCode jobs are waiting: ${jobs.map((job) => `${job.id} (${job.status})`).join(', ')}. Mention only these job IDs and suggest $zcode:status / $zcode:result when relevant.`;
}

/** @param {string} value */
function hasControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code >= 127 && code <= 159;
  });
}

function unsafePath() {
  return new PluginError('RESCUE_LAUNCHER_PATH_UNSAFE', 'The Rescue launcher path cannot be rendered safely.', {
    category: 'configuration', remedy: 'Reinstall the plugin under a shell-safe absolute path and retry from a new owned parent turn.',
  });
}

function contextError() {
  return new PluginError('RESCUE_LAUNCHER_CONTEXT_INVALID', 'The Rescue launcher context exceeds its fixed safe boundary.', {
    category: 'configuration', remedy: 'Reinstall the ZCode plugin and retry from a new owned parent turn.',
  });
}

/**
 * Escape a validated rendered command for a TOML multiline basic string.
 * @param {string} command
 * @param {{platform?:NodeJS.Platform|'win32'}} [options]
 */
export function escapeRescueLauncherCommandForToml(command, { platform = process.platform } = {}) {
  const match = typeof command === 'string' ? /^node "(.+)"$/u.exec(command) : null;
  const launcherPath = match?.[1];
  let canonicalCommand;
  try {
    canonicalCommand = launcherPath ? renderRescueLauncherCommand(launcherPath, { platform }) : null;
  } catch {
    canonicalCommand = null;
  }
  if (canonicalCommand !== command) {
    throw new PluginError('RESCUE_LAUNCHER_COMMAND_INVALID', 'The Rescue launcher command is invalid.', {
      category: 'configuration', remedy: 'Reinstall the plugin and rerun $zcode:setup.',
    });
  }
  return JSON.stringify(command).slice(1, -1);
}
