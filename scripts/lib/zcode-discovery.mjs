import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { PluginError } from './errors.mjs';
import { launchForPath, spawnProcess, terminateProcess } from './process.mjs';

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
  const which = options.which ?? ((name, whichEnv) => findOnPath(name, whichEnv, platform));
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
    const launch = launchForPath(path, options.execPath);
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
async function findOnPath(name, env, platform) {
  for (const directory of String(env.PATH ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    const suffixes = platform === 'win32' ? ['', '.exe', '.cjs', '.js'] : [''];
    for (const suffix of suffixes) { const path = join(directory, `${name}${suffix}`); if (await fileExists(path)) return path; }
  }
  return null;
}

/** @param {{command:string,args:string[],target?:string}} launch */
async function defaultRunVersion(launch) {
  const child = await spawnProcess(launch, { args: ['--version'] });
  let stdout = ''; let stderrBytes = 0; let oversized = false;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { stdout += chunk; if (Buffer.byteLength(stdout) > 64 * 1024) { oversized = true; void terminateProcess(child); } });
  child.stderr?.on('data', (chunk) => { stderrBytes += Buffer.byteLength(chunk); if (stderrBytes > 64 * 1024) { oversized = true; void terminateProcess(child); } });
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), 5_000); });
  const outcome = await Promise.race([new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve(code)); }), timeout]);
  clearTimeout(timer);
  await terminateProcess(child);
  if (outcome === 'timeout' || oversized || outcome !== 0) throw new PluginError('ZCODE_VERSION_CHECK_FAILED', 'ZCode version check failed or exceeded its safety bounds.', { category: outcome === 'timeout' ? 'timeout' : 'runtime', remedy: 'Run $zcode:setup and inspect the installation.' });
  return stdout;
}

/** @param {string} value */
function parseVersion(value) { const match = value.match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?:\s|$)/); return match ? { value: `${match[1]}.${match[2]}.${match[3]}${match[4] ?? ''}`, parts: match.slice(1, 4).map(Number), prerelease: Boolean(match[4]) } : null; }
/** @param {number[]} left @param {number[]} right */
function compareVersion(left, right) { for (let index = 0; index < 3; index += 1) { if (left[index] !== right[index]) return /** @type {number} */ (left[index]) - /** @type {number} */ (right[index]); } return 0; }
function discoveryInputError() { return new PluginError('ZCODE_DISCOVERY_INPUT_INVALID', 'ZCode discovery input is invalid.', { category: 'validation', remedy: 'Provide a supported platform and valid dependency functions.' }); }
/** @param {unknown} value */
function versionInvalid(value) { return new PluginError('ZCODE_VERSION_INVALID', 'ZCode returned an invalid version.', { category: 'protocol', remedy: 'Run $zcode:setup against a supported ZCode install.', details: { valueType: typeof value } }); }
