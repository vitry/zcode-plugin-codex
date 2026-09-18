// @ts-check
/**
 * Builds a complete installable probe-only marketplace (never a bare plugin
 * directory, never the production root) from the checked-in template assets.
 * The generated descriptor references the validated absolute probe server
 * path so the MCP SDK resolves from this worktree.
 */
import { cp, lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT = fileURLToPath(new URL('.', import.meta.url));
const PLUGIN_NAME = 'zcode-mcp-context-probe';
const MARKETPLACE_NAME = 'zcode-mcp-probe';
const TOOL_TIMEOUT_SECONDS = Object.freeze([2, 30]);

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
 *     <output>/plugins/zcode-mcp-context-probe/.mcp.json
 *     <output>/plugins/zcode-mcp-context-probe/skills/context/{SKILL.md,agents/openai.yaml}
 *
 * @param {{output:string, server:string, toolTimeoutSec:number}} input
 */
export async function buildProbeMarketplace(input) {
  const { output, server, toolTimeoutSec } = input;
  if (!TOOL_TIMEOUT_SECONDS.includes(toolTimeoutSec)) {
    throw fixtureError('PROBE_TOOL_TIMEOUT_INVALID', 'toolTimeoutSec must be exactly 2 or 30.');
  }
  await validateServerPath(server);
  await validateOutputDirectory(output);
  const descriptorTemplate = await readFile(join(MODULE_ROOT, '.mcp.json'), 'utf8');
  const descriptor = descriptorTemplate
    .replace('@SERVER_PATH@', JSON.stringify(server).slice(1, -1))
    .replace('@TOOL_TIMEOUT_SEC@', String(toolTimeoutSec));
  JSON.parse(descriptor);
  const pluginRoot = join(output, 'plugins', PLUGIN_NAME);
  await mkdir(join(output, '.agents', 'plugins'), { recursive: true, mode: 0o700 });
  await mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true, mode: 0o700 });
  await mkdir(join(pluginRoot, 'skills', 'context', 'agents'), { recursive: true, mode: 0o700 });
  await writeFile(join(output, '.agents', 'plugins', 'marketplace.json'), `${JSON.stringify(JSON.parse(await readFile(join(MODULE_ROOT, '.agents', 'plugins', 'marketplace.json.template'), 'utf8')), null, 2)}\n`, { encoding: 'utf8' });
  await cp(join(MODULE_ROOT, '.codex-plugin', 'plugin.json'), join(pluginRoot, '.codex-plugin', 'plugin.json'));
  await writeFile(join(pluginRoot, '.mcp.json'), descriptor, { encoding: 'utf8' });
  await cp(join(MODULE_ROOT, 'skills', 'context', 'SKILL.md'), join(pluginRoot, 'skills', 'context', 'SKILL.md'));
  await cp(join(MODULE_ROOT, 'skills', 'context', 'agents', 'openai.yaml'), join(pluginRoot, 'skills', 'context', 'agents', 'openai.yaml'));
  const generatedMarketplace = JSON.parse(await readFile(join(output, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  if (generatedMarketplace.name !== MARKETPLACE_NAME || generatedMarketplace.plugins[0]?.name !== PLUGIN_NAME) {
    throw fixtureError('PROBE_FIXTURE_INVALID', 'The generated marketplace descriptor does not match the probe identity.');
  }
}
