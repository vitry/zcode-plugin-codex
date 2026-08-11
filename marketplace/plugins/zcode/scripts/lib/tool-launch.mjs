import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * @typedef {object} ToolLaunchOptions
 * @property {NodeJS.Platform} [platform]
 * @property {string} [execPath]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string} [root]
 * @property {string} [codexEntryPoint]
 */

/** @param {ToolLaunchOptions} [options] */
function settings(options = {}) {
  const platform = options.platform ?? process.platform;
  return {
    env: options.env ?? process.env,
    execPath: options.execPath ?? process.execPath,
    path: platform === 'win32' ? win32 : posix,
    platform,
    root: options.root ?? defaultRoot,
  };
}

/** @param {string} entryPoint @param {string[]} args @param {string} execPath */
function descriptor(entryPoint, args, execPath) {
  return {
    command: execPath,
    args: [entryPoint, ...args],
    options: { shell: false },
  };
}

/** @param {string} value @param {ReturnType<typeof settings>} resolved */
function safeAbsolute(value, resolved) {
  return typeof value === 'string' && value.length > 0 && resolved.path.isAbsolute(value) && ![...value].some((character) => { const code = character.codePointAt(0) ?? 0; return code <= 31 || code === 127; });
}

/** @param {'npm' | 'npx'} tool @param {ToolLaunchOptions} options */
function npmEntryPoint(tool, options) {
  const resolved = settings(options);
  const configured = resolved.env.npm_execpath;
  if (configured && /(?:^|[\\/])(?:npm|npx)-cli\.m?js$/i.test(configured)) {
    return { ...resolved, entryPoint: resolved.path.join(resolved.path.dirname(configured), `${tool}-cli.js`) };
  }
  const nodeDirectory = resolved.path.dirname(resolved.execPath);
  const npmBin = resolved.platform === 'win32'
    ? resolved.path.join(nodeDirectory, 'node_modules', 'npm', 'bin')
    : resolved.path.join(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin');
  return { ...resolved, entryPoint: resolved.path.join(npmBin, `${tool}-cli.js`) };
}

/** @param {string[]} args @param {ToolLaunchOptions} [options] */
export function codexLaunch(args, options = {}) {
  const resolved = settings(options);
  const external = resolved.env.CODEX_BINARY;
  if (external !== undefined) {
    if (!safeAbsolute(external, resolved) || /\.(?:cmd|bat)$/i.test(external)) throw new TypeError('CODEX_BINARY must be an absolute native executable or JavaScript entry point.');
    if (/\.(?:mjs|cjs|js)$/i.test(external)) return descriptor(external, args, resolved.execPath);
    return { command: external, args: [...args], options: { shell: false } };
  }
  const entryPoint = options.codexEntryPoint
    ?? resolved.path.join(resolved.root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  return descriptor(entryPoint, args, resolved.execPath);
}

/** @param {string[]} args @param {ToolLaunchOptions} [options] */
export function npmLaunch(args, options = {}) {
  const resolved = npmEntryPoint('npm', options);
  return descriptor(resolved.entryPoint, args, resolved.execPath);
}

/** @param {string[]} args @param {ToolLaunchOptions} [options] */
export function npxLaunch(args, options = {}) {
  const resolved = npmEntryPoint('npx', options);
  return descriptor(resolved.entryPoint, args, resolved.execPath);
}
