// @ts-check
/**
 * Builds a complete installable probe-only marketplace (never a bare plugin
 * directory, never the production root) from the checked-in template assets.
 * The generated descriptor references the validated absolute probe server
 * path so the MCP SDK resolves from this worktree. `mode:'plugin-server'`
 * additionally emits the plugin-root `.mcp.json`; `mode:'skill-only'` emits
 * the Skill, hooks, and hook observer but no descriptor, which is required
 * for the direct-config timeout differential.
 *
 * Hook command timeout budget (hooks.json): every hook sets `"timeout": 15`
 * — bounded, and well above the observer's complete worst-case append
 * budget of 2s durable-input read + 5s advisory-lock acquisition + node
 * startup + fsync margin — so event-lock contention can never let the Host
 * kill the observer mid-append and silently drop hook evidence.
 */
import { cp, lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE_ROOT = fileURLToPath(new URL('.', import.meta.url));
const PLUGIN_NAME = 'zcode-mcp-context-probe';
const MARKETPLACE_NAME = 'zcode-mcp-probe';
const TOOL_TIMEOUT_SECONDS = Object.freeze([2, 30]);
const MODES = Object.freeze(['plugin-server', 'skill-only']);

/** @param {string} code @param {string} message */
function fixtureError(code, message) {
  const error = /** @type {Error & {code:string}} */ (new Error(message));
  error.code = code;
  return error;
}

/** @param {unknown} error */
function errorCode(error) {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
}

/**
 * Validates the requested output directory: absolute, existing, a real
 * non-symlink directory, private (0700), and empty.
 * @param {string} output
 */
async function validateOutputDirectory(output) {
  if (!isAbsolute(output)) throw fixtureError('PROBE_OUTPUT_RELATIVE', 'The fixture output directory must be an absolute path.');
  const stats = await lstat(output).catch((error) => {
    if (errorCode(error) === 'ENOENT') throw fixtureError('PROBE_OUTPUT_MISSING', 'The fixture output directory must already exist.');
    throw error;
  });
  if (stats.isSymbolicLink()) throw fixtureError('PROBE_OUTPUT_SYMLINK', 'The fixture output directory must not be a symlink.');
  if (!stats.isDirectory()) throw fixtureError('PROBE_OUTPUT_NOT_DIRECTORY', 'The fixture output must be a directory.');
  if (process.platform !== 'win32' && (stats.mode & 0o777) !== 0o700) {
    throw fixtureError('PROBE_OUTPUT_MODE', 'The fixture output directory must be mode 0700.');
  }
  const entries = await readdir(output);
  if (entries.length > 0) throw fixtureError('PROBE_OUTPUT_NOT_EMPTY', 'The fixture output directory must be empty.');
}

/**
 * Validates the probe server source: an absolute path to a regular
 * non-symlink readable file.
 * @param {string} server
 */
async function validateServerPath(server) {
  if (!isAbsolute(server)) throw fixtureError('PROBE_SERVER_RELATIVE', 'The probe server must be an absolute path.');
  const stats = await lstat(server).catch((error) => {
    if (errorCode(error) === 'ENOENT') throw fixtureError('PROBE_SERVER_MISSING', 'The probe server file must exist.');
    throw error;
  });
  if (stats.isSymbolicLink()) throw fixtureError('PROBE_SERVER_SYMLINK', 'The probe server must not be a symlink.');
  if (!stats.isFile()) throw fixtureError('PROBE_SERVER_NOT_FILE', 'The probe server must be a regular file.');
  await stat(server);
}

/**
 * Builds the complete local probe marketplace:
 *
 *     <output>/.agents/plugins/marketplace.json
 *     <output>/plugins/zcode-mcp-context-probe/.codex-plugin/plugin.json
 *     <output>/plugins/zcode-mcp-context-probe/.mcp.json            (plugin-server mode only)
 *     <output>/plugins/zcode-mcp-context-probe/skills/context/{SKILL.md,agents/openai.yaml}
 *     <output>/plugins/zcode-mcp-context-probe/hooks/hooks.json
 *     <output>/plugins/zcode-mcp-context-probe/hook-observer.mjs
 *
 * The emitted hook observer is a thin wrapper importing the checked-in source
 * by absolute file URL, so all fixture logic stays in this worktree.
 *
 * @param {{output:string, server:string, toolTimeoutSec:number, mode:'plugin-server'|'skill-only'}} input
 */
export async function buildProbeMarketplace(input) {
  const { output, server, toolTimeoutSec, mode } = input;
  if (!TOOL_TIMEOUT_SECONDS.includes(toolTimeoutSec)) {
    throw fixtureError('PROBE_TOOL_TIMEOUT_INVALID', 'toolTimeoutSec must be exactly 2 or 30.');
  }
  if (!MODES.includes(mode)) {
    throw fixtureError('PROBE_MODE_INVALID', "mode must be exactly 'plugin-server' or 'skill-only'.");
  }
  await validateServerPath(server);
  await validateOutputDirectory(output);
  const pluginRoot = join(output, 'plugins', PLUGIN_NAME);
  await mkdir(join(output, '.agents', 'plugins'), { recursive: true, mode: 0o700 });
  await mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true, mode: 0o700 });
  await mkdir(join(pluginRoot, 'skills', 'context', 'agents'), { recursive: true, mode: 0o700 });
  await mkdir(join(pluginRoot, 'hooks'), { recursive: true, mode: 0o700 });
  await writeFile(join(output, '.agents', 'plugins', 'marketplace.json'), `${JSON.stringify(JSON.parse(await readFile(join(MODULE_ROOT, '.agents', 'plugins', 'marketplace.json.template'), 'utf8')), null, 2)}\n`, { encoding: 'utf8' });
  await cp(join(MODULE_ROOT, '.codex-plugin', 'plugin.json'), join(pluginRoot, '.codex-plugin', 'plugin.json'));
  if (mode === 'plugin-server') {
    const descriptorTemplate = await readFile(join(MODULE_ROOT, '.mcp.json'), 'utf8');
    const descriptor = descriptorTemplate
      .replace('@SERVER_PATH@', JSON.stringify(server).slice(1, -1))
      .replace('@TOOL_TIMEOUT_SEC@', String(toolTimeoutSec));
    JSON.parse(descriptor);
    await writeFile(join(pluginRoot, '.mcp.json'), descriptor, { encoding: 'utf8' });
  }
  await cp(join(MODULE_ROOT, 'skills', 'context', 'SKILL.md'), join(pluginRoot, 'skills', 'context', 'SKILL.md'));
  await cp(join(MODULE_ROOT, 'skills', 'context', 'agents', 'openai.yaml'), join(pluginRoot, 'skills', 'context', 'agents', 'openai.yaml'));
  await cp(join(MODULE_ROOT, 'hooks', 'hooks.json'), join(pluginRoot, 'hooks', 'hooks.json'));
  // The plugin-local hook observer delegates to the checked-in source so the
  // fixture logic is maintained in exactly one place.
  const wrapper = [
    '// Generated by tools/mcp-context-probe/build-fixture.mjs — do not edit.',
    '// Source of truth: tools/mcp-context-probe/hook-observer.mjs',
    `import { runHookObserver } from ${JSON.stringify(pathToFileURL(hookObserverSourcePath()).href)};`,
    'await runHookObserver();',
    '',
  ].join('\n');
  await writeFile(join(pluginRoot, 'hook-observer.mjs'), wrapper, { encoding: 'utf8' });
  const generatedMarketplace = JSON.parse(await readFile(join(output, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  if (generatedMarketplace.name !== MARKETPLACE_NAME || generatedMarketplace.plugins[0]?.name !== PLUGIN_NAME) {
    throw fixtureError('PROBE_FIXTURE_INVALID', 'The generated marketplace descriptor does not match the probe identity.');
  }
}

/** The absolute path of the checked-in hook observer source this build uses. */
function hookObserverSourcePath() {
  return join(MODULE_ROOT, 'hook-observer.mjs');
}
