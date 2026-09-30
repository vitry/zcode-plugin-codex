// @ts-check
/**
 * Disposable fixture for the source-guided foreground-wait investigation: an
 * isolated installable marketplace (never a bare plugin directory, never the
 * production root) plus the fixture-only config, hooks, skill, and harmless
 * worker process. The generated descriptor launches the probe server through
 * the DIRECT Node binary (`process.execPath`), never through an `env` lookup,
 * because a `#!/usr/bin/env node` script has a transient `comm=env` identity
 * phase that races spawn-time process captures under load.
 *
 * Everything this module writes is synthetic and bounded. It must never be
 * installed outside a private probe run directory, and the fixture-only holds
 * it configures are labeled as such.
 */
import { chmod, lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export const MARKETPLACE_NAME = 'zcode-wait-route-probe-mp';
export const PLUGIN_NAME = 'zcode-wait-route-probe';
export const PLUGIN_SELECTOR = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
export const SERVER_NAME = 'zcode-wait-route-probe';
export const CAPTURE_TOOL_NAME = 'capture_entry';
export const HOLD_TOOL_NAME = 'hold_open';
export const DEPENDENCY_TOOL_NAME = 'prepare_dependency';
/** The fixed completion marker printed by the harmless fixture worker. */
export const COMPLETION_MARKER = 'WAIT_ROUTE_PROBE_WORKER_DONE';
export const WORKER_FILE_NAME = 'wait-route-worker.mjs';
/** The short injected hold inside capture_entry; fixture-only, never a timeout policy. */
export const CAPTURE_HOLD_MS = 2_000;
export const HOOK_TIMEOUT_SEC = 15;
/** Environment variable names the host must forward to the probe server. */
export const TRACE_ENV_NAMES = Object.freeze(['WAIT_ROUTE_PROBE_TRACE', 'WAIT_ROUTE_PROBE_NONCE']);

/** @param {string} code @param {string} message */
export function fixtureError(code, message) {
  const error = /** @type {Error & {code: string}} */ (new Error(message));
  error.code = code;
  return error;
}

/**
 * Parses one `ps -o lstart=,ppid=,comm=` line into its three fields.
 * `comm` may be the executable PATH and contain spaces (macOS ps returns
 * the pathname there), so the line is split at the lstart/parent-pid
 * boundary — the 4-digit year followed by the purely numeric parent pid —
 * and the WHOLE remainder is kept as comm. Returns null for an
 * unparseable line.
 * @param {string} line
 * @returns {{lstart: string, ppid: string, comm: string}|null}
 */
export function parseProcessIdentityLine(line) {
  // Token walk WITH character spans: the comm is the RAW remainder of the
  // line after the year/parent-pid boundary. ps separates columns with one
  // space, but comm (the executable PATH) may contain CONSECUTIVE spaces or
  // tabs — split-and-rejoin would collapse them and the recorded identity
  // would never match the live capture. The lstart portion is normalized
  // (both identity sides normalize it identically); comm is preserved
  // verbatim.
  const spans = [];
  for (const match of line.matchAll(/\S+/g)) {
    spans.push({ token: match[0], end: match.index + match[0].length });
  }
  if (spans.length < 3) return null;
  for (let index = 0; index <= spans.length - 3; index += 1) {
    if (!/^\d{4}$/.test(spans[index].token)) continue;
    if (!/^\d+$/.test(spans[index + 1].token)) continue;
    const lstart = line.slice(0, spans[index].end).trim().replace(/\s+/g, ' ');
    const ppid = spans[index + 1].token;
    const comm = line.slice(spans[index + 1].end + 1).replace(/\s+$/, '');
    if (lstart.length === 0 || ppid.length === 0 || comm.length === 0) return null;
    return { lstart, ppid, comm };
  }
  return null;
}

/** @param {unknown} error */
export function errorCode(error) {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
}

/**
 * Validates the requested fixture output directory: absolute, existing, a
 * real non-symlink directory, private (0700), and empty.
 * @param {string} output
 */
async function validateOutputDirectory(output) {
  if (!isAbsolute(output)) throw fixtureError('WAIT_ROUTE_FIXTURE_OUTPUT_RELATIVE', 'The fixture output directory must be an absolute path.');
  const stats = await lstat(output).catch((error) => {
    if (errorCode(error) === 'ENOENT') throw fixtureError('WAIT_ROUTE_FIXTURE_OUTPUT_MISSING', 'The fixture output directory must already exist.');
    throw error;
  });
  if (stats.isSymbolicLink()) throw fixtureError('WAIT_ROUTE_FIXTURE_OUTPUT_SYMLINK', 'The fixture output directory must not be a symlink.');
  if (!stats.isDirectory()) throw fixtureError('WAIT_ROUTE_FIXTURE_OUTPUT_NOT_DIRECTORY', 'The fixture output must be a directory.');
  if (process.platform !== 'win32' && (stats.mode & 0o777) !== 0o700) {
    throw fixtureError('WAIT_ROUTE_FIXTURE_OUTPUT_MODE', 'The fixture output directory must be mode 0700.');
  }
  const entries = await readdir(output);
  if (entries.length > 0) throw fixtureError('WAIT_ROUTE_FIXTURE_OUTPUT_NOT_EMPTY', 'The fixture output directory must be empty.');
}

/**
 * Validates the probe server source: an absolute path to a regular
 * non-symlink readable file. A missing server module is an INSTRUMENT
 * failure of the fixture build, never a host rejection.
 * @param {string} server
 */
async function validateServerPath(server) {
  if (!isAbsolute(server)) throw fixtureError('WAIT_ROUTE_FIXTURE_SERVER_RELATIVE', 'The probe server must be an absolute path.');
  const stats = await lstat(server).catch((error) => {
    if (errorCode(error) === 'ENOENT') throw fixtureError('WAIT_ROUTE_FIXTURE_SERVER_MISSING', 'The probe server file must exist.');
    throw error;
  });
  if (stats.isSymbolicLink()) throw fixtureError('WAIT_ROUTE_FIXTURE_SERVER_SYMLINK', 'The probe server must not be a symlink.');
  if (!stats.isFile()) throw fixtureError('WAIT_ROUTE_FIXTURE_SERVER_NOT_FILE', 'The probe server must be a regular file.');
  await stat(server);
}

/**
 * Builds the complete isolated fixture marketplace:
 *
 *     <outputDir>/.agents/plugins/marketplace.json
 *     <outputDir>/plugins/<PLUGIN_NAME>/.codex-plugin/plugin.json
 *     <outputDir>/plugins/<PLUGIN_NAME>/.mcp.json
 *     <outputDir>/plugins/<PLUGIN_NAME>/hooks/hooks.json
 *     <outputDir>/plugins/<PLUGIN_NAME>/skills/wait-route/{SKILL.md,agents/openai.yaml}
 *     <outputDir>/plugins/<PLUGIN_NAME>/workers/<WORKER_FILE_NAME>
 *
 * @param {{outputDir: string, serverPath: string, toolTimeoutSec?: number}} input
 * @returns {Promise<{outputDir: string, pluginRoot: string, marketplacePath: string, pluginDescriptorPath: string, mcpDescriptorPath: string, hooksPath: string, skillPath: string, workerPath: string}>}
 */
export async function buildWaitRouteFixture(input) {
  const { outputDir, serverPath } = input;
  const toolTimeoutSec = input.toolTimeoutSec ?? 30;
  if (!Number.isSafeInteger(toolTimeoutSec) || toolTimeoutSec < 2 || toolTimeoutSec > 300) {
    throw fixtureError('WAIT_ROUTE_FIXTURE_TOOL_TIMEOUT_INVALID', 'toolTimeoutSec must be an integer of 2 to 300 seconds.');
  }
  await validateServerPath(serverPath);
  await validateOutputDirectory(outputDir);
  const pluginRoot = join(outputDir, 'plugins', PLUGIN_NAME);
  await mkdir(join(outputDir, '.agents', 'plugins'), { recursive: true, mode: 0o700 });
  await mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true, mode: 0o700 });
  await mkdir(join(pluginRoot, 'skills', 'wait-route', 'agents'), { recursive: true, mode: 0o700 });
  await mkdir(join(pluginRoot, 'hooks'), { recursive: true, mode: 0o700 });
  await mkdir(join(pluginRoot, 'workers'), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(outputDir, 0o700);

  /** Serializes, re-validates, and writes one generated JSON descriptor. @param {string} path @param {unknown} body */
  const writeDescriptor = async (path, body) => {
    const serialized = `${JSON.stringify(body, null, 2)}\n`;
    JSON.parse(serialized);
    await writeFile(path, serialized, { encoding: 'utf8', mode: 0o600 });
  };

  const marketplace = {
    name: MARKETPLACE_NAME,
    interface: { displayName: 'ZCode Wait Route Probe Plugins' },
    plugins: [{
      name: PLUGIN_NAME,
      source: { source: 'local', path: `./plugins/${PLUGIN_NAME}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Developer Tools',
    }],
  };
  const plugin = {
    name: PLUGIN_NAME,
    version: '0.1.0',
    description: 'Disposable source-guided foreground-wait probe plugin. Never installed in production.',
    interface: {
      displayName: 'ZCode Wait Route Probe',
      shortDescription: 'Disposable foreground-wait probe fixture.',
      longDescription: 'Disposable probe-only plugin whose MCP server records bounded handler-entry evidence for host hook entry qualification. It must never be installed outside a temporary probe marketplace.',
      category: 'Developer Tools',
      capabilities: ['Interactive'],
    },
    skills: './skills/',
  };
  // The server launches through the direct Node binary: no PATH dependence
  // and no env-to-node identity race at spawn time.
  const descriptor = {
    mcpServers: {
      [SERVER_NAME]: {
        command: process.execPath,
        args: [serverPath],
        cwd: '.',
        enabled: true,
        env_vars: [...TRACE_ENV_NAMES],
        startup_timeout_sec: 10,
        tool_timeout_sec: toolTimeoutSec,
      },
    },
  };
  const hooks = {
    description: 'Disposable fixture-only wait-route probe hook. Never installed outside the private probe marketplace.',
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'mcp_tool', server: SERVER_NAME, tool: CAPTURE_TOOL_NAME, input: {}, timeout: HOOK_TIMEOUT_SEC }] },
      ],
    },
  };
  const marketplacePath = join(outputDir, '.agents', 'plugins', 'marketplace.json');
  const pluginDescriptorPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
  const mcpDescriptorPath = join(pluginRoot, '.mcp.json');
  const hooksPath = join(pluginRoot, 'hooks', 'hooks.json');
  await writeDescriptor(marketplacePath, marketplace);
  await writeDescriptor(pluginDescriptorPath, plugin);
  await writeDescriptor(mcpDescriptorPath, descriptor);
  await writeDescriptor(hooksPath, hooks);

  const skillPath = join(pluginRoot, 'skills', 'wait-route', 'SKILL.md');
  const skill = [
    '---',
    'name: wait-route-probe',
    'description: Fixture-only probe skill for the disposable wait-route marketplace; never used in production.',
    '---',
    '',
    '# ZCode Wait Route Probe',
    '',
    'This skill exists only inside the disposable wait-route probe fixture. It holds no production behavior and carries no instructions beyond this synthetic marker text.',
    '',
  ].join('\n');
  await writeFile(skillPath, skill, { encoding: 'utf8', mode: 0o600 });
  const skillInterfacePath = join(pluginRoot, 'skills', 'wait-route', 'agents', 'openai.yaml');
  const skillInterface = [
    'interface:',
    `  display_name: "ZCode Wait Route Probe"`,
    '  short_description: "Disposable foreground-wait probe fixture"',
    `  default_prompt: "Use $${PLUGIN_NAME}:wait-route-probe for the fixture conversation."`,
    '',
  ].join('\n');
  await writeFile(skillInterfacePath, skillInterface, { encoding: 'utf8', mode: 0o600 });

  // The harmless worker: a direct-Node script (execPath shebang) that prints
  // one fixed completion marker and exits successfully. It never reads stdin,
  // never writes outside its own directory, and never starts other processes.
  // Its launch record carries its pid, process group, session, and captured
  // startup identity (the real macOS shell runs the command in its OWN
  // group/session), so the driver can own and settle that separate group.
  const workerPath = join(pluginRoot, 'workers', WORKER_FILE_NAME);
  const worker = [
    `#!${process.execPath}`,
    '// Generated by tools/wait-route-probe/fixture.mjs — disposable fixture-only worker.',
    '// Prints the fixed completion marker and exits 0. Never a production artifact.',
    "import { appendFile } from 'node:fs/promises';",
    "import { spawnSync } from 'node:child_process';",
    "import { lstatSync, readFileSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    '',
    `const MARKER = ${JSON.stringify(COMPLETION_MARKER)};`,
    'const here = dirname(fileURLToPath(import.meta.url));',
    '// Parses one `ps -o lstart=,ppid=,comm=` line into its three fields:',
    '// comm may be the executable PATH and contain spaces, so the line is',
    '// split at the year/parent-pid boundary and the WHOLE remainder is kept',
    '// as comm.',
    'function parseIdentityLine(line) {',
    '  const spans = [];',
    '  for (const match of line.matchAll(/\\S+/g)) {',
    '    spans.push({ token: match[0], end: match.index + match[0].length });',
    '  }',
    '  if (spans.length < 3) return null;',
    '  for (let index = 0; index <= spans.length - 3; index += 1) {',
    "    if (!/^\\d{4}$/.test(spans[index].token)) continue;",
    "    if (!/^\\d+$/.test(spans[index + 1].token)) continue;",
    "    const lstart = line.slice(0, spans[index].end).trim().replace(/\\s+/g, ' ');",
    '    const ppid = spans[index + 1].token;',
    '    const comm = line.slice(spans[index + 1].end + 1).replace(/\\s+$/, "");',
    '    if (lstart.length === 0 || ppid.length === 0 || comm.length === 0) return null;',
    '    return { lstart, ppid, comm };',
    '  }',
    '  return null;',
    '}',
    '// Resolves process fields from fixed absolute candidates, never PATH.',
    '// Identity uses EXACTLY the lstart/ppid/comm field set of the driver\'s',
    '// verification, parsed so spaces inside the comm PATH survive; pgid and',
    "// session come from a separate call.",
    'function psFields() {',
    "  for (const ps of ['/bin/ps', '/usr/bin/ps']) {",
    '    try {',
    '      if (!lstatSync(ps).isFile()) continue;',
    "      const identityRun = spawnSync(ps, ['-p', String(process.pid), '-o', 'lstart=,ppid=,comm='], { encoding: 'utf8', timeout: 2000 });",
    "      const groupRun = spawnSync(ps, ['-p', String(process.pid), '-o', 'pgid=,sess='], { encoding: 'utf8', timeout: 2000 });",
    "      if (identityRun.status === 0 && groupRun.status === 0 && typeof identityRun.stdout === 'string' && typeof groupRun.stdout === 'string') {",
    '        const parsed = parseIdentityLine(identityRun.stdout);',
    '        const groupTokens = groupRun.stdout.trim().split(/\\s+/);',
    '        if (parsed !== null && groupTokens.length >= 2) {',
    '          return { identity: `${parsed.lstart}|ppid=${parsed.ppid}|comm=${parsed.comm}`, pgid: Number(groupTokens[0]), sid: Number(groupTokens[1]) };',
    '        }',
    '      }',
    '    } catch { /* try the next candidate */ }',
    '  }',
    '  return { identity: null, pgid: null, sid: null };',
    '}',
    '// Linux start time at jiffy precision (field 22 of /proc/self/stat):',
    '// finer than one second, so a pid recycled within the same second cannot',
    '// reproduce it. Null off-Linux; the driver compares it only there.',
    'function linuxStarttime() {',
    "  if (process.platform !== 'linux') return null;",
    '  try {',
    "    const stat = readFileSync('/proc/self/stat', 'utf8');",
    "    const close = stat.lastIndexOf(')');",
    "    if (stat.indexOf('(') < 0 || close < 0) return null;",
    "    const fields = stat.slice(close + 2).trim().split(/\\s+/);",
    '    const starttime = Number(fields[22 - 3]);',
    '    return Number.isSafeInteger(starttime) && starttime > 0 ? starttime : null;',
    '  } catch {',
    '    return null;',
    '  }',
    '}',
    'try {',
    '  const fields = psFields();',
    "  await appendFile(join(here, 'worker-launches.jsonl'), JSON.stringify({ event: 'worker-launched', pid: process.pid, pgid: fields.pgid, sid: fields.sid, identity: fields.identity, starttime: linuxStarttime() }) + '\\n', { encoding: 'utf8', mode: 0o600 });",
    '} catch {',
    '  // A missing launch record must never fail the harmless worker.',
    '}',
    'process.stdout.write(`${MARKER}\\n`);',
    '',
  ].join('\n');
  await writeFile(workerPath, worker, { encoding: 'utf8', mode: 0o755 });

  return {
    outputDir,
    pluginRoot,
    marketplacePath,
    pluginDescriptorPath,
    mcpDescriptorPath,
    hooksPath,
    skillPath,
    workerPath,
  };
}

/**
 * Writes the fixture-only config.toml into an isolated Codex home. It enables
 * the hooks feature (the fixture-local equivalent of the host's plugin-hook
 * discovery switch) and carries nothing else: no user projects, providers, or
 * servers. Refuses to overwrite an existing config so a real user config can
 * never be touched through this seam.
 * @param {{codexHome: string}} input
 * @returns {Promise<{configPath: string}>}
 */
export async function writeFixtureConfig(input) {
  const { codexHome } = input;
  if (!isAbsolute(codexHome)) throw fixtureError('WAIT_ROUTE_FIXTURE_CONFIG_RELATIVE', 'The fixture Codex home must be an absolute path.');
  const configPath = join(codexHome, 'config.toml');
  const existing = await lstat(configPath).catch((error) => {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  });
  if (existing !== null) throw fixtureError('WAIT_ROUTE_FIXTURE_CONFIG_EXISTS', 'The fixture Codex home already has a config.toml.');
  const body = [
    '# Fixture-only configuration for the disposable wait-route probe marketplace.',
    '# Written inside the private probe run directory; never merged into any user',
    '# configuration. This enables the host feature that discovers plugin hooks.',
    '[features]',
    'hooks = true',
    '',
  ].join('\n');
  await writeFile(configPath, body, { encoding: 'utf8', mode: 0o600 });
  return { configPath };
}

/**
 * Reads the fixture worker script source and returns it. The driver copies it
 * into the private fixture workspace before the shell smoke.
 * @param {{workerPath: string}} fixture
 * @returns {Promise<string>}
 */
export async function readFixtureWorker(fixture) {
  const worker = await readFile(fixture.workerPath, 'utf8');
  if (!worker.startsWith(`#!${process.execPath}`)) {
    throw fixtureError('WAIT_ROUTE_FIXTURE_WORKER_INVALID', 'The fixture worker must keep its direct-Node shebang.');
  }
  if (!worker.includes(COMPLETION_MARKER)) {
    throw fixtureError('WAIT_ROUTE_FIXTURE_WORKER_INVALID', 'The fixture worker must keep its fixed completion marker.');
  }
  return worker;
}
