import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { PluginError } from './errors.mjs';

const TRUSTED_RUNTIME_ENTRIES = [
  ['hooks', 'user-prompt-hook.mjs'],
  ['skills', 'rescue', 'launcher.mjs'],
  ['scripts', 'zcode-companion.mjs'],
];

/**
 * Resolve the one writable root shared by skills and hooks.  Installed
 * plugins are namespaced by marketplace; source checkouts retain the legacy
 * unqualified development namespace so local development can inject a root.
 *
 * @param {{env?:NodeJS.ProcessEnv,pluginRoot?:string,entryPath?:string}} input
 */
export function resolvePluginDataRoot({ env = process.env, pluginRoot, entryPath } = {}) {
  const explicit = nonEmpty(env.ZCODE_DATA_ROOT);
  if (explicit && entryPath === undefined) return canonicalPath(explicit);
  return resolvePluginDataContext({ env, pluginRoot, entryPath }).dataRoot;
}

/**
 * Resolve the writable data root together with provenance derived only from
 * the executing plugin location. Explicit data roots select storage, not the
 * plugin installation identity.
 *
 * @param {{env?:NodeJS.ProcessEnv,pluginRoot?:string,entryPath?:string}} input
 * @returns {{dataRoot:string,provenance:'marketplace'|'source',runtimePluginRoot:string}}
 */
export function resolvePluginDataContext({ env = process.env, pluginRoot, entryPath } = {}) {
  const explicit = nonEmpty(env.ZCODE_DATA_ROOT);
  const codexHome = canonicalPath(nonEmpty(env.CODEX_HOME) ?? join(homedir(), '.codex'));
  const installed = installedIdentity(pluginRoot, codexHome, entryPath);
  const provenance = installed ? 'marketplace' : 'source';
  const runtimePluginRoot = installed?.runtimePluginRoot ?? canonicalPath(pluginRoot ?? process.cwd());
  if (explicit) return { dataRoot: canonicalPath(explicit), provenance, runtimePluginRoot };
  if (installed) {
    const expected = join(codexHome, 'plugins', 'data', `zcode-${installed.marketplace}`);
    for (const injected of [nonEmpty(env.PLUGIN_DATA), nonEmpty(env.CLAUDE_PLUGIN_DATA)]) {
      if (injected && canonicalPath(injected) === canonicalPath(expected)) return { dataRoot: canonicalPath(injected), provenance, runtimePluginRoot };
    }
    return { dataRoot: expected, provenance, runtimePluginRoot };
  }
  return {
    dataRoot: canonicalPath(nonEmpty(env.PLUGIN_DATA) ?? nonEmpty(env.CLAUDE_PLUGIN_DATA) ?? join(codexHome, 'plugins', 'data', 'zcode')),
    provenance, runtimePluginRoot,
  };
}

/** @param {string|undefined} pluginRoot @param {string} codexHome @param {string|undefined} entryPath */
function installedIdentity(pluginRoot, codexHome, entryPath) {
  if (!pluginRoot) return null;
  if (hasControl(pluginRoot)) throw invalidRoot();
  if (entryPath !== undefined) return runtimeEntryIdentity(pluginRoot, codexHome, entryPath);
  const cache = canonicalPath(join(codexHome, 'plugins', 'cache'));
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
  if (!/^[A-Za-z0-9_-]+$/.test(marketplace) || plugin !== 'zcode'
    || !/^[A-Za-z0-9._-]+(?:\+[A-Za-z0-9._-]+)?$/.test(version)) throw invalidRoot();
  return { marketplace, runtimePluginRoot: canonical };
}

/** Accept only an allowlisted runtime entry whose exact canonical target belongs to pluginRoot. @param {string} pluginRoot @param {string} codexHome @param {string} entryPath */
function runtimeEntryIdentity(pluginRoot, codexHome, entryPath) {
  if (typeof entryPath !== 'string' || !entryPath || hasControl(entryPath) || !isAbsolute(entryPath)) throw invalidRoot();
  const separator = process.platform === 'win32' ? /\\/g : /\//g;
  if (entryPath.replace(separator, '/').split('/').includes('..')) throw invalidRoot();
  const rawEntry = resolve(entryPath); const ownedRoot = canonicalPath(pluginRoot);
  const relativeEntry = TRUSTED_RUNTIME_ENTRIES.find((segments) => canonicalPath(rawEntry) === canonicalPath(join(ownedRoot, ...segments)));
  if (!relativeEntry) throw invalidRoot();
  let rawRoot = rawEntry;
  for (let index = 0; index < relativeEntry.length; index += 1) rawRoot = dirname(rawRoot);
  if (canonicalPath(rawRoot) !== ownedRoot) throw invalidRoot();
  const lexicalRoot = join(canonicalPath(dirname(rawRoot)), basename(rawRoot));
  const cache = canonicalPath(join(codexHome, 'plugins', 'cache'));
  const rawRelative = relative(cache, lexicalRoot);
  if (!rawRelative || rawRelative.startsWith('..') || isAbsolute(rawRelative)) {
    if (lexicalRoot === ownedRoot) return null;
    throw invalidRoot();
  }
  const segments = rawRelative.split(sep);
  if (segments.length !== 3 || segments.some((segment) => !segment || segment === '.' || segment === '..' || hasControl(segment))) throw invalidRoot();
  const [marketplace, plugin, version] = segments;
  if (!/^[A-Za-z0-9_-]+$/.test(marketplace) || plugin !== 'zcode'
    || !/^[A-Za-z0-9._-]+(?:\+[A-Za-z0-9._-]+)?$/.test(version)) throw invalidRoot();
  return { marketplace, runtimePluginRoot: rawRoot };
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
