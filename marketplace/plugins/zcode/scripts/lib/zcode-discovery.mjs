import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';

import { PluginError } from './errors.mjs';
import { launchForPath, runProcess } from './process.mjs';

const MINIMUM_VERSION = [0, 16, 1];
const PLATFORMS = new Set(['darwin', 'linux', 'win32']);

/** @param {'darwin'|'linux'|'win32'} platform @param {NodeJS.ProcessEnv|Record<string,string|undefined>} env */
export function getPlatformCandidates(platform, env) {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  const candidates = platform === 'darwin' ? [
    join(home, '.local', 'bin', 'zcode'),
    '/usr/local/bin/zcode', '/opt/homebrew/bin/zcode',
    '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
  ] : platform === 'win32' ? [
    join(local, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
    join(local, 'ZCode', 'resources', 'glm', 'zcode.cjs'),
  ] : [join(home, '.local', 'bin', 'zcode'), '/usr/local/bin/zcode', '/usr/bin/zcode', '/opt/zcode/zcode'];
  return [...new Set(candidates)];
}

/**
 * @param {{ explicitPath?: string, platform?: string, env?: NodeJS.ProcessEnv|Record<string,string|undefined>, which?: (name:string, env:object)=>Promise<string|null>, exists?: (path:string)=>Promise<boolean>, runVersion?: (launch:{command:string,args:string[],target?:string})=>Promise<string>, execPath?: string }} [options]
 */
export async function discoverZCode(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (!PLATFORMS.has(platform) || !env || typeof env !== 'object'
    || options.explicitPath !== undefined && (typeof options.explicitPath !== 'string' || options.explicitPath.length === 0)) {
    throw discoveryInputError();
  }
  const exists = options.exists ?? fileExists;
  const which = options.which ?? ((name, whichEnv) => findOnPath(name, whichEnv, platform, exists));
  const runVersion = options.runVersion ?? defaultRunVersion;
  if (typeof exists !== 'function' || typeof which !== 'function' || typeof runVersion !== 'function') throw discoveryInputError();
  /** @type {string[]} */
  const candidates = [];
  if (options.explicitPath) candidates.push(options.explicitPath);
  const pathCandidate = await which('zcode', env);
  if (pathCandidate !== null && typeof pathCandidate !== 'string') throw discoveryInputError();
  if (pathCandidate) candidates.push(pathCandidate);
  candidates.push(...getPlatformCandidates(/** @type {'darwin'|'linux'|'win32'} */ (platform), env));
  for (const path of new Set(candidates)) {
    if (!await exists(path)) continue;
    const launch = launchForPath(path, options.execPath, platform, env);
    const rawVersion = await runVersion(launch);
    if (typeof rawVersion !== 'string') throw versionInvalid(rawVersion);
    const version = parseVersion(rawVersion);
    if (!version) throw versionInvalid(rawVersion);
    if (compareVersion(version.parts, MINIMUM_VERSION) < 0
      || compareVersion(version.parts, MINIMUM_VERSION) === 0 && version.prerelease) {
      throw new PluginError('ZCODE_VERSION_UNSUPPORTED', `ZCode ${version.value} is unsupported; 0.16.1 or newer is required.`, {
        category: 'configuration', remedy: 'Upgrade ZCode, then run $zcode:setup again.', details: { version: version.value },
      });
    }
    return { path, version: version.value, launch };
  }
  throw new PluginError('ZCODE_NOT_FOUND', 'A supported ZCode installation was not found.', {
    category: 'configuration', remedy: 'Install ZCode 0.16.1 or newer, then run $zcode:setup.',
  });
}

/** @param {string} path */
async function fileExists(path) { try { await access(path); return true; } catch { return false; } }

/** @param {string} name @param {any} env @param {string} platform */
export async function findOnPath(name, env, platform, exists = fileExists) {
  for (const directory of String(env.PATH ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    const configured = String(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean);
    const suffixes = platform === 'win32' ? [...new Set(['', ...configured, '.cjs', '.js'])] : [''];
    for (const suffix of suffixes) { const path = (platform === 'win32' ? win32 : { join }).join(directory, `${name}${suffix}`); if (await exists(path)) return path; }
  }
  return null;
}

/** @param {{command:string,args:string[],target?:string}} launch */
async function defaultRunVersion(launch) {
  const result = await runProcess(launch, { args: ['--version'], timeoutMs: 5_000, maxOutputBytes: 64 * 1024 });
  if (result.code !== 0) throw new PluginError('ZCODE_VERSION_CHECK_FAILED', 'ZCode version check failed.', { category: 'runtime', remedy: 'Run $zcode:setup and inspect the installation.' });
  return result.stdout;
}

/** @param {string} value */
function parseVersion(value) {
  const token = value.match(/(?:^|\s)v?(\d[^\s]*)(?:\s|$)/)?.[1];
  if (!token) return null;
  const match = token.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/);
  if (!match || match[4]?.split('.').some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return null;
  return { value: token, parts: match.slice(1, 4).map(Number), prerelease: Boolean(match[4]) };
}
/** @param {number[]} left @param {number[]} right */
function compareVersion(left, right) { for (let index = 0; index < 3; index += 1) { if (left[index] !== right[index]) return /** @type {number} */ (left[index]) - /** @type {number} */ (right[index]); } return 0; }
function discoveryInputError() { return new PluginError('ZCODE_DISCOVERY_INPUT_INVALID', 'ZCode discovery input is invalid.', { category: 'validation', remedy: 'Provide a supported platform and valid dependency functions.' }); }
/** @param {unknown} value */
function versionInvalid(value) { return new PluginError('ZCODE_VERSION_INVALID', 'ZCode returned an invalid version.', { category: 'protocol', remedy: 'Run $zcode:setup against a supported ZCode install.', details: { valueType: typeof value } }); }
