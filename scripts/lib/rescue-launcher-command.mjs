import process from 'node:process';
import { isAbsolute, win32 } from 'node:path';

import { PluginError } from './errors.mjs';

const MAX_PATH_BYTES = 2048;
const POSIX_SUFFIX = '/skills/rescue/launcher.mjs';
const WINDOWS_SUFFIX = '\\skills\\rescue\\launcher.mjs';

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
  const absolute = windows ? win32.isAbsolute(launcherPath) : isAbsolute(launcherPath);
  const correctLeaf = windows
    ? launcherPath.toLowerCase().endsWith(WINDOWS_SUFFIX)
    : launcherPath.endsWith(POSIX_SUFFIX);
  const unsafe = windows
    ? /["'`$%!^&|<>]/u.test(launcherPath) || /\\{2,}|[\\/]$/u.test(launcherPath) || hasControlCharacter(launcherPath)
    : /[\\"'`$]/u.test(launcherPath) || hasControlCharacter(launcherPath);
  if (!absolute || !correctLeaf || Buffer.byteLength(launcherPath) > MAX_PATH_BYTES || unsafe) throw unsafePath();
  return `node "${launcherPath}"`;
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
