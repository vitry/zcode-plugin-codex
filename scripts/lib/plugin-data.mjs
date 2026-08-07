import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { PluginError } from './errors.mjs';

/**
 * Resolve the one writable root shared by skills and hooks.  Installed
 * plugins are namespaced by marketplace; source checkouts retain the legacy
 * unqualified development namespace so local development can inject a root.
 *
 * @param {{env?:NodeJS.ProcessEnv,pluginRoot?:string}} input
 */
export function resolvePluginDataRoot({ env = process.env, pluginRoot } = {}) {
  const explicit = nonEmpty(env.ZCODE_DATA_ROOT);
  if (explicit) return canonicalPath(explicit);
  const codexHome = canonicalPath(nonEmpty(env.CODEX_HOME) ?? join(homedir(), '.codex'));
  const installed = installedIdentity(pluginRoot, codexHome);
  if (installed) {
    const expected = join(codexHome, 'plugins', 'data', `zcode-${installed.marketplace}`);
    for (const injected of [nonEmpty(env.PLUGIN_DATA), nonEmpty(env.CLAUDE_PLUGIN_DATA)]) {
      if (injected && canonicalPath(injected) === canonicalPath(expected)) return canonicalPath(injected);
    }
    return expected;
  }
  return canonicalPath(nonEmpty(env.PLUGIN_DATA) ?? nonEmpty(env.CLAUDE_PLUGIN_DATA) ?? join(codexHome, 'plugins', 'data', 'zcode'));
}

/** @param {string|undefined} pluginRoot @param {string} codexHome */
function installedIdentity(pluginRoot, codexHome) {
  if (!pluginRoot) return null;
  if (hasControl(pluginRoot)) throw invalidRoot();
  const cache = join(codexHome, 'plugins', 'cache');
  const canonical = canonicalPath(pluginRoot);
  const rawRelative = relative(cache, canonical);
  const looksInstalled = rawRelative === '' || (!rawRelative.startsWith('..') && !isAbsolute(rawRelative));
  const separator = process.platform === 'win32' ? /\\/g : /\//g;
  const rawSegments = pluginRoot.replace(separator, '/').split('/');
  const looksLikeCachePath = rawSegments.some((segment, index) => segment === 'cache' && rawSegments[index - 1] === 'plugins');
  if (looksLikeCachePath && pluginRoot.split(/[\\/]/).includes('..')) throw invalidRoot();
  if (looksLikeCachePath && !looksInstalled) throw invalidRoot();
  if (!looksInstalled) return null;
  const segments = relative(cache, canonical).split(sep);
  if (segments.length !== 3 || segments.some((segment) => !segment || segment === '.' || segment === '..' || hasControl(segment))) throw invalidRoot();
  const [marketplace, plugin, version] = segments;
  if (!/^[A-Za-z0-9_-]+$/.test(marketplace) || plugin !== 'zcode' || !/^[A-Za-z0-9._-]+$/.test(version)) throw invalidRoot();
  return { marketplace };
}

/** @param {unknown} value */
function nonEmpty(value) { return typeof value === 'string' && value ? value : undefined; }
/** @param {string} value */
function canonicalPath(value) {
  if (hasControl(value)) throw invalidRoot();
  const absolute = resolve(value);
  try { return realpathSync.native(absolute); } catch { return absolute; }
}
/** @param {string} value */
function hasControl(value) { return [...value].some((character) => { const code = character.codePointAt(0) ?? 0; return code < 32 || code === 127; }); }
function invalidRoot() { return new PluginError('PLUGIN_DATA_ROOT_INVALID', 'Plugin data root identity is invalid.', { category: 'configuration', remedy: 'Restart Codex from the installed ZCode plugin.' }); }
