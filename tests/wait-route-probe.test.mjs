// @ts-nocheck
// Instrument tests for the disposable wait-route probe fixture (research-only;
// this entry is excluded from the routine suite by tools/run-test-suite.mjs).
// These tests exercise the fixture, capture server, and driver public seams
// only. They never launch a real Codex host, model provider, or ZCode task:
// every host-side run uses a fake codex executable whose shebang is
// process.execPath directly (no /usr/bin/env node identity phase), and every
// injected hold is labeled fixture-only.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, lstatSync, readFileSync } from 'node:fs';
import { appendFile, chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  CAPTURE_HOLD_MS,
  CAPTURE_TOOL_NAME,
  COMPLETION_MARKER,
  DEPENDENCY_TOOL_NAME,
  HOLD_TOOL_NAME,
  PLUGIN_NAME,
  SERVER_NAME,
  SYNTHETIC_ROLE_NAME,
  WORKER_FILE_NAME,
  WORKER_SIGNALLED_MARKER_PREFIX,
  buildWaitRouteFixture,
  buildWaitRouteSyntheticRole,
  parseProcessIdentityLine,
  writeFixtureConfig,
} from '../tools/wait-route-probe/fixture.mjs';
import {
  appendTraceEvent,
  captureProcessIdentity,
  createWaitRouteServer,
  fingerprintProcessIdentity,
  PROCESS_INSPECTION_CANDIDATES,
  readTraceEvents,
  resolveProcessInspectionExecutable,
  TRACE_MAX_EVENT_BYTES,
  TRACE_MAX_RECORDS,
  waitRouteTraceFromEnv,
} from '../tools/wait-route-probe/server.mjs';
import {
  buildShellWorkerCommand,
  CASE_LABELS,
  ensureServerExitByTrace,
  groupDeadlineFireCount,
  handleDriverSignal,
  installDriverSignalHandlers,
  ownRecordedWorkerGroups,
  ownedWorkerAttestationsSnapshot,
  settleOwnedGroups,
  settleWorkerExits,
  parseDriverArguments,
  ownedGroupsSnapshot,
  reAnchorHostGroupEvidence,
  registerOwnedChild,
  readWorkerLaunchRecords,
  roleChildProven,
  runBoundedSubprocess,
  runWaitRouteCase,
  settleOwnedTarget,
  summarizeCodexSessions,
} from '../tools/wait-route-probe/driver.mjs';

const HEX_NONCE = 'a'.repeat(64);
const posix = process.platform !== 'win32';
const serverModulePath = fileURLToPath(new URL('../tools/wait-route-probe/server.mjs', import.meta.url));

/**
 * The Linux process start time at jiffies precision (field 22 of
 * /proc/<pid>/stat — the field the driver's Linux start token compares), or
 * null off-Linux.
 * @param {number} pid
 * @returns {number|null}
 */
function linuxStarttimeOf(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const starttime = Number(fields[22 - 3]);
    return Number.isSafeInteger(starttime) && starttime > 0 ? starttime : null;
  } catch {
    return null;
  }
}

/**
 * Skips the fake-host integration cases on win32: Windows does not interpret
 * a `#!` shebang, so the driver's spawn of the fake codex `.mjs` fails with
 * `WAIT_ROUTE_DRIVER_SPAWN_FAILED` before any assertion could run. The
 * decision is made at runtime via process.platform; the platform-independent
 * unit tests (pure seams such as `buildShellWorkerCommand`,
 * `settleOwnedTarget`, and the fixture/descriptor builders) stay unguarded.
 * @param {import('node:test').TestContext} t
 * @returns {boolean} true when the caller must return (test skipped)
 */
function skipFakeHostOnWindows(t) {
  if (process.platform === 'win32') {
    t.skip('fake codex .mjs hosts need POSIX shebang execution and POSIX process groups');
    return true;
  }
  return false;
}

async function withTempDirectory(setup) {
  const directory = process.env.WRP_KEEP
    ? await mkdtemp(join('/tmp', 'wrp-keep-'))
    : await mkdtemp(join(tmpdir(), 'wait-route-probe-test-'));
  if (posix) await chmod(directory, 0o700);
  try {
    return await setup(directory);
  } finally {
    if (!process.env.WRP_KEEP) await rm(directory, { recursive: true, force: true });
  }
}

/** A fresh empty private output directory plus a nonce, as the driver expects. */
async function newRunDirectory(parent) {
  const runDirectory = join(parent, 'run');
  await mkdir(runDirectory, { mode: 0o700 });
  return runDirectory;
}

/** Bounded poll for a process to stop being able to run code. */
async function waitUntilSettled(pid, graceMs) {
  const deadline = Date.now() + graceMs;
  for (;;) {
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (!alive) return true;
    if (Date.now() >= deadline) return false;
    await sleep(200);
  }
}

/** Bounded test sleep. @param {number} ms */
async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
}

/**
 * A minimal synthetic auth source home so fake-host tests never depend on a
 * real user auth file; the driver only copies this file, never parses it.
 */
async function newSourceHome(parent) {
  const sourceHome = join(parent, 'source-home');
  await mkdir(sourceHome, { mode: 0o700 });
  await writeFile(join(sourceHome, 'auth.json'), '{"fixture-only":true}\n', { encoding: 'utf8', mode: 0o600 });
  return sourceHome;
}

/** Writes a fake codex executable with a direct-Node shebang and one behavior mode. */
async function writeFakeCodex(directory, mode) {
  // The fake host runs from the private temp directory, outside the repo, so
  // it receives the SDK entry points as absolute file URLs resolved from this
  // repo's own dependencies.
  const require = createRequire(import.meta.url);
  const sdkClientUrl = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href;
  const sdkStdioUrl = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href;
  const fakeCodexPath = join(directory, 'fake-codex.mjs');
  const body = [
    `#!${process.execPath}`,
    'import { spawn } from "node:child_process";',
    'const args = process.argv.slice(2);',
    `const mode = ${JSON.stringify(mode)};`,
    'const rest = args.join(" ");',
    'if (args.includes("--version")) { process.stdout.write("codex-cli 0.159.2 (wait-route fixture fake)\\n"); process.exit(0); }',
    'if (rest.includes("plugin marketplace") || rest.includes("plugin remove") || rest.includes("plugin add")) {',
    '  if (mode === "install-fail" && rest.includes("plugin add") && !rest.includes("marketplace")) process.exit(1);',
    '  process.stdout.write("{}\\n"); process.exit(0);',
    '}',
    'if (args[0] === "exec") {',
    '  if (mode === "exec-fail") process.exit(3);',
    '  if (mode === "self-delete") {',
    '    // The host executable disappears before cleanup runs: the cleanup CLI',
    '    // commands then fail to spawn, which must be contained as a recorded',
    '    // failure instead of skipping state-dir removal.',
    '    const { unlink } = await import("node:fs/promises");',
    '    const { fileURLToPath } = await import("node:url");',
    '    await unlink(fileURLToPath(import.meta.url));',
    '    process.exit(0);',
    '  }',
    '  if (mode === "slow") { await new Promise((resolve) => setTimeout(resolve, 8000)); process.exit(0); }',
    '  if (mode === "slow-detached-worker") {',
    '    // The real macOS shell shape: the launched worker runs in its OWN',
    '    // process group/session. The fixture records that worker in the',
    '    // shared launch log so the driver can own its separate group, then',
    '    // the host stays alive until the budget expires.',
    '    const { writeFile } = await import("node:fs/promises");',
    '    const { dirname, join } = await import("node:path");',
    '    const { fileURLToPath } = await import("node:url");',
    '    const { spawnSync } = await import("node:child_process");',
    '    const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });',
    '    let identity = null; let pgid = null; let sid = null; let starttime = null;',
    '    for (const ps of ["/bin/ps", "/usr/bin/ps"]) {',
    "      const identityRun = spawnSync(ps, ['-p', String(descendant.pid), '-o', 'lstart=,ppid=,comm='], { encoding: 'utf8', timeout: 2000 });",
    "      const groupRun = spawnSync(ps, ['-p', String(descendant.pid), '-o', 'pgid=,sess='], { encoding: 'utf8', timeout: 2000 });",
    "      if (identityRun.status === 0 && groupRun.status === 0 && typeof identityRun.stdout === 'string' && typeof groupRun.stdout === 'string') {",
    '        const idTokens = identityRun.stdout.trim().split(/\\s+/);',
    '        const groupTokens = groupRun.stdout.trim().split(/\\s+/);',
    '        if (idTokens.length >= 3 && groupTokens.length >= 2) {',
    "          const comm = idTokens.at(-1); const ppid = idTokens.at(-2);",
    '          identity = idTokens.slice(0, -2).join(" ") + "|ppid=" + ppid + "|comm=" + comm;',
    '          pgid = Number(groupTokens[0]); sid = Number(groupTokens[1]);',
    '          break;',
    '        }',
    '      }',
    '    }',
    '    if (process.platform === "linux") {',
    '      try {',
    '        const { readFileSync } = await import("node:fs");',
    '        const stat = readFileSync("/proc/" + descendant.pid + "/stat", "utf8");',
    '        const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\\s+/);',
    '        const jiffies = Number(fields[22 - 3]);',
    '        if (Number.isSafeInteger(jiffies) && jiffies > 0) starttime = jiffies;',
    '      } catch { starttime = null; }',
    '    }',
    '    const workspace = args[args.indexOf("-C") + 1];',
    `    const record = JSON.stringify({ event: "worker-launched", pid: descendant.pid, pgid, sid, identity, starttime }) + "\\n";`,
    '    await writeFile(join(workspace, "worker-launches.jsonl"), record, "utf8");',
    `    await writeFile(join(dirname(fileURLToPath(import.meta.url)), "wait-route-descendant.pid"), String(descendant.pid), "utf8");`,
    '    await new Promise((resolve) => setTimeout(resolve, 8000));',
    '    process.exit(0);',
    '  }',
    '  if (mode === "exit-worker-then-hold") {',
    '    // Launches a worker in its OWN group, records it, KILLS it, and keeps',
    '    // running: the launch record outlives the worker, so it is historical',
    '    // evidence only. A poller that re-registers the dead worker\'s group',
    '    // would point interrupt/cleanup SIGKILLs at any later reuse of that',
    '    // group id.',
    '    const { writeFile } = await import("node:fs/promises");',
    '    const { dirname, join } = await import("node:path");',
    '    const { fileURLToPath } = await import("node:url");',
    '    const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });',
    '    const workspace = args[args.indexOf("-C") + 1];',
    '    await new Promise((resolve) => setTimeout(resolve, 300));',
    `    const record = JSON.stringify({ event: "worker-launched", pid: descendant.pid, pgid: descendant.pid, sid: null, identity: null }) + "\\n";`,
    '    await writeFile(join(workspace, "worker-launches.jsonl"), record, "utf8");',
    `    await writeFile(join(dirname(fileURLToPath(import.meta.url)), "wait-route-descendant.pid"), String(descendant.pid), "utf8");`,
    '    descendant.kill("SIGKILL");',
    '    await new Promise((resolve) => setTimeout(resolve, 8000));',
    '    process.exit(0);',
    '  }',
    '  if (mode === "exit-shared-worker-then-hold") {',
    '    // The worker SHARES the host process group (non-detached spawn, so its',
    '    // recorded pgid IS the host\'s own group) and exits mid-run while the',
    '    // host keeps sleeping. It stays alive long enough for several polls to',
    '    // validate its record, so the group entry carries worker evidence that',
    '    // then expires — expired worker evidence must never drop the spawned-',
    '    // host registration or cancel its deadline.',
    '    const { writeFile } = await import("node:fs/promises");',
    '    const { dirname, join } = await import("node:path");',
    '    const { fileURLToPath } = await import("node:url");',
    '    const { spawnSync } = await import("node:child_process");',
    '    const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });',
    '    let identity = null;',
    '    for (const ps of ["/bin/ps", "/usr/bin/ps"]) {',
    "      const identityRun = spawnSync(ps, ['-p', String(descendant.pid), '-o', 'lstart=,ppid=,comm='], { encoding: 'utf8', timeout: 2000 });",
    "      if (identityRun.status === 0 && typeof identityRun.stdout === 'string') {",
    '        const idTokens = identityRun.stdout.trim().split(/\\s+/);',
    '        if (idTokens.length >= 3) {',
    "          const comm = idTokens.at(-1); const ppid = idTokens.at(-2);",
    '          identity = idTokens.slice(0, -2).join(" ") + "|ppid=" + ppid + "|comm=" + comm;',
    '          break;',
    '        }',
    '      }',
    '    }',
    '    let starttime = null;',
    '    if (process.platform === "linux") {',
    '      try {',
    '        const { readFileSync } = await import("node:fs");',
    '        const stat = readFileSync("/proc/" + descendant.pid + "/stat", "utf8");',
    '        const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\\s+/);',
    '        const jiffies = Number(fields[22 - 3]);',
    '        if (Number.isSafeInteger(jiffies) && jiffies > 0) starttime = jiffies;',
    '      } catch { starttime = null; }',
    '    }',
    '    const workspace = args[args.indexOf("-C") + 1];',
    '    await new Promise((resolve) => setTimeout(resolve, 400));',
    `    const record = JSON.stringify({ event: "worker-launched", pid: descendant.pid, pgid: process.pid, sid: null, identity, starttime }) + "\\n";`,
    '    await writeFile(join(workspace, "worker-launches.jsonl"), record, "utf8");',
    `    await writeFile(join(dirname(fileURLToPath(import.meta.url)), "wait-route-descendant.pid"), String(descendant.pid), "utf8");`,
    `    await writeFile(join(dirname(fileURLToPath(import.meta.url)), "wait-route-hostgroup.pid"), String(process.pid), "utf8");`,
    '    // The worker stays alive past several polls, then exits mid-run.',
    '    await new Promise((resolve) => setTimeout(resolve, 800));',
    '    descendant.kill("SIGKILL");',
    '    await new Promise((resolve) => setTimeout(resolve, 6800));',
    '    process.exit(0);',
    '  }',
    '  if (mode === "exit-before-marker-flush") {',
    '    // The host process exits while its stdout pipe is still held open by a',
    '    // short-lived inheritor that prints the fixed marker AFTER the exit:',
    '    // resolving on the exit event alone would snapshot an empty stream.',
    '    const writerScript = "const marker = process.argv[1]; setTimeout(() => { process.stdout.write(JSON.stringify({ final: marker }) + String.fromCharCode(10)); }, 800); setTimeout(() => {}, 3000);";',
    '    spawn(process.execPath, ["-e", writerScript, ' + JSON.stringify(COMPLETION_MARKER) + '], { stdio: ["ignore", "inherit", "inherit"] });',
    '    process.exit(0);',
    '  }',
    '  if (mode === "overflow-after-host-exit") {',
    '    // The host exits; its in-group descendant spawns an UNRECORDED nephew',
    '    // (inheriting the driver pipes) and exits; the nephew then floods the',
    '    // stdout pipe past the byte limit. Late output must never SIGKILL a',
    '    // group whose recorded members no longer validate.',
    '    const { writeFile } = await import("node:fs/promises");',
    '    const { dirname, join } = await import("node:path");',
    '    const { fileURLToPath } = await import("node:url");',
    '    const here = dirname(fileURLToPath(import.meta.url));',
    '    const flooderRootPath = join(here, "wait-route-flooder-root.mjs");',
    '    await writeFile(flooderRootPath, [',
    '      "import { spawn } from \\"node:child_process\\";",',
    '      "import { writeFile } from \\"node:fs/promises\\";",',
    '      "const nephewPidFile = process.argv[2];",',
    '      "setTimeout(async () => {",',
    '        "const nephew = spawn(process.execPath, [\\"-e\\", \\"setTimeout(() => { const chunk = Buffer.alloc(1024 * 1024, 120); for (let i = 0; i < 5; i += 1) { process.stdout.write(chunk); } }, 1000); setTimeout(() => {}, 60000)\\"], { stdio: [\\"ignore\\", \\"inherit\\", \\"inherit\\"] });",',
    '        "await writeFile(nephewPidFile, String(nephew.pid));",',
    '        "process.exit(0);",',
    '      "}, 600);",',
    '    ].join("\\n"), "utf8");',
    '    const flooderRoot = spawn(process.execPath, [flooderRootPath, join(here, "wait-route-nephew.pid")], { stdio: ["ignore", "inherit", "inherit"] });',
    `    await writeFile(join(here, "wait-route-flooder-root.pid"), String(flooderRoot.pid), "utf8");`,
    '    await new Promise((resolve) => setTimeout(resolve, 300));',
    '    process.exit(0);',
    '  }',
    '  if (mode === "exit-then-three-detached-workers") {',
    '    // Three separately grouped workers, all recorded with valid tokens,',
    '    // all alive when the budget expires: worker cleanup must signal them',
    '    // together against ONE shared deadline — never N sequential graces.',
    '    const { writeFile, appendFile } = await import("node:fs/promises");',
    '    const workspace = args[args.indexOf("-C") + 1];',
    '    const { dirname, join } = await import("node:path");',
    '    const { fileURLToPath } = await import("node:url");',
    '    const { spawnSync } = await import("node:child_process");',
    '    for (let index = 0; index < 3; index += 1) {',
    '      const worker = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });',
    '      let identity = null;',
    '      for (const ps of ["/bin/ps", "/usr/bin/ps"]) {',
    "        const identityRun = spawnSync(ps, ['-p', String(worker.pid), '-o', 'lstart=,ppid=,comm='], { encoding: 'utf8', timeout: 2000 });",
    "        if (identityRun.status === 0 && typeof identityRun.stdout === 'string') {",
    '          const tokens = identityRun.stdout.trim().split(/\\s+/);',
    '          if (tokens.length >= 3) {',
    "            identity = tokens.slice(0, -2).join(' ') + '|ppid=' + tokens.at(-2) + '|comm=' + tokens.at(-1);",
    '            break;',
    '          }',
    '        }',
    '      }',
    '      let starttime = null;',
    '      if (process.platform === "linux") {',
    '        try {',
    '          const { readFileSync } = await import("node:fs");',
    '          const stat = readFileSync("/proc/" + worker.pid + "/stat", "utf8");',
    '          const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\\s+/);',
    '          const jiffies = Number(fields[22 - 3]);',
    '          if (Number.isSafeInteger(jiffies) && jiffies > 0) starttime = jiffies;',
    '        } catch { starttime = null; }',
    '      }',
    '      await appendFile(join(workspace, "worker-launches.jsonl"), JSON.stringify({ event: "worker-launched", pid: worker.pid, pgid: worker.pid, sid: null, identity, starttime }) + "\\n", "utf8");',
    `      await writeFile(join(dirname(fileURLToPath(import.meta.url)), "wait-route-worker-" + index + ".pid"), String(worker.pid), "utf8");`,
    '    }',
    '    await new Promise((resolve) => setTimeout(resolve, 60000));',
    '    process.exit(0);',
    '  }',
    '  if (mode === "detached-writer-after-budget") {',
    '    // The host exits 0 immediately; a DETACHED inheritor (its own group,',
    '    // so no ownership path may signal it) holds stdout and writes the',
    '    // completion marker only AFTER the observation budget has expired.',
    '    // Expiry must still be observed and reported — never as a clean smoke',
    '    // success — while the unowned group receives no signal.',
    '    const { writeFile, appendFile } = await import("node:fs/promises");',
    '    const { dirname, join } = await import("node:path");',
    '    const { fileURLToPath } = await import("node:url");',
    '    const { spawnSync } = await import("node:child_process");',
    '    const workspace = args[args.indexOf("-C") + 1];',
    '    const here = dirname(fileURLToPath(import.meta.url));',
    '    const worker = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });',
    '    let identity = null;',
    '    for (const ps of ["/bin/ps", "/usr/bin/ps"]) {',
    "      const identityRun = spawnSync(ps, ['-p', String(worker.pid), '-o', 'lstart=,ppid=,comm='], { encoding: 'utf8', timeout: 2000 });",
    "      if (identityRun.status === 0 && typeof identityRun.stdout === 'string') {",
    '        const tokens = identityRun.stdout.trim().split(/\\s+/);',
    '        if (tokens.length >= 3) {',
    "          identity = tokens.slice(0, -2).join(' ') + '|ppid=' + tokens.at(-2) + '|comm=' + tokens.at(-1);",
    '          break;',
    '        }',
    '      }',
    '    }',
    '    let starttime = null;',
    '    if (process.platform === "linux") {',
    '      try {',
    '        const { readFileSync } = await import("node:fs");',
    '        const stat = readFileSync("/proc/" + worker.pid + "/stat", "utf8");',
    '        const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\\s+/);',
    '        const jiffies = Number(fields[22 - 3]);',
    '        if (Number.isSafeInteger(jiffies) && jiffies > 0) starttime = jiffies;',
    '      } catch { starttime = null; }',
    '    }',
    '    await appendFile(join(workspace, "worker-launches.jsonl"), JSON.stringify({ event: "worker-launched", pid: worker.pid, pgid: worker.pid, sid: null, identity, starttime, durationMs: 1200, noiseIntervalMs: 0 }) + "\\n", "utf8");',
    `    await writeFile(join(here, "wait-route-descendant.pid"), String(worker.pid), "utf8");`,
    '    const writerScript = "const marker = process.argv[1]; setTimeout(() => { process.stdout.write(JSON.stringify({ final: marker }) + String.fromCharCode(10)); }, 1750); setTimeout(() => {}, 20000);";',
    '    const writer = spawn(process.execPath, ["-e", writerScript, ' + JSON.stringify(COMPLETION_MARKER) + '], { stdio: ["ignore", "inherit", "inherit"], detached: true });',
    `    await writeFile(join(here, "wait-route-writer.pid"), String(writer.pid), "utf8");`,
    '    process.exit(0);',
    '  }',
    '  if (mode === "marker-then-late-noise") {',
    '    // The recorded worker prints the completion marker WITHIN the budget',
    '    // and then emits noise AFTER the deadline from its inherited stdout:',
    '    // the marker arrival time governs the smoke grant - later unrelated',
    '    // stdout must not retroactively invalidate it.',
    '    const { dirname, join } = await import("node:path");',
    '    const { fileURLToPath } = await import("node:url");',
    '    const here = dirname(fileURLToPath(import.meta.url));',
    '    const { writeFile, appendFile } = await import("node:fs/promises");',
    '    const { spawnSync } = await import("node:child_process");',
    '    const workspace = args[args.indexOf("-C") + 1];',
    '    const workerScript = "const marker = process.argv[1]; setTimeout(() => { process.stdout.write(JSON.stringify({ final: marker }) + String.fromCharCode(10)); }, 300); setTimeout(() => { process.stdout.write(String.fromCharCode(110, 111, 105, 115, 101)); }, 1500); setTimeout(() => {}, 20000);";',
    '    const worker = spawn(process.execPath, ["-e", workerScript, "WAIT_ROUTE_PROBE_WORKER_DONE"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });',
    '    let identity = null;',
    '    for (const ps of ["/bin/ps", "/usr/bin/ps"]) {',
    "      const identityRun = spawnSync(ps, ['-p', String(worker.pid), '-o', 'lstart=,ppid=,comm='], { encoding: 'utf8', timeout: 2000 });",
    "      if (identityRun.status === 0 && typeof identityRun.stdout === 'string') {",
    '        const tokens = identityRun.stdout.trim().split(/\\s+/);',
    '        if (tokens.length >= 3) {',
    "          identity = tokens.slice(0, -2).join(' ') + '|ppid=' + tokens.at(-2) + '|comm=' + tokens.at(-1);",
    '          break;',
    '        }',
    '      }',
    '    }',
    '    const starttime = process.platform === "linux" ? await import("node:fs").then((fs) => { try { const stat = fs.readFileSync("/proc/" + worker.pid + "/stat", "utf8"); return Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\\s+/)[19]); } catch { return null; } }) : null;',
    '    await appendFile(join(workspace, "worker-launches.jsonl"), JSON.stringify({ event: "worker-launched", pid: worker.pid, pgid: worker.pid, sid: null, identity, starttime, durationMs: 1200, noiseIntervalMs: 0 }) + "\\n", "utf8");',
    `    await writeFile(join(here, "wait-route-descendant.pid"), String(worker.pid), "utf8");`,
    '    process.exit(0);',
    '  }',
    '  if (mode === "late-record-worker") {',
    '    const workspace = args[args.indexOf("-C") + 1];',
    '    const { writeFile, appendFile } = await import("node:fs/promises");',
    '    const { dirname, join } = await import("node:path");',
    '    const { fileURLToPath } = await import("node:url");',
    '    const here = dirname(fileURLToPath(import.meta.url));',
    '    // A DETACHED separately-grouped worker writes its launch record LATE',
    '    // (~600 ms, while the host is STILL ALIVE so the trusted launch',
    '    // boundary can verify ancestry) and holds. Its stdio inherits the',
    '    // driver pipe, so the observation stays open while it writes. The',
    '    // host exits at ~1400 ms; discovery polling and the owned entry',
    '    // must survive into the drain window. On Linux the record carries',
    '    // /proc starttime — the field the Linux start token compares.',
    '    const workerScript = \'const { appendFile } = await import("node:fs/promises"); const { spawnSync } = await import("node:child_process"); const { readFileSync } = await import("node:fs"); setTimeout(async () => { let identity = null; for (const ps of ["/bin/ps", "/usr/bin/ps"]) { const r = spawnSync(ps, ["-p", String(process.pid), "-o", "lstart=,ppid=,comm="], { encoding: "utf8", timeout: 2000 }); if (r.status === 0 && typeof r.stdout === "string") { const parts = r.stdout.trim().split(" ").filter((part) => part.length > 0); if (parts.length >= 3) { identity = parts.slice(0, -2).join(" ") + "|ppid=" + parts.at(-2) + "|comm=" + parts.at(-1); break; } } } let starttime = null; if (process.platform === "linux") { try { const stat = readFileSync("/proc/self/stat", "utf8"); starttime = Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\\\\s+/)[19]); } catch { starttime = null; } } await appendFile(process.argv[1], JSON.stringify({ event: "worker-launched", pid: process.pid, pgid: process.pid, sid: null, identity, starttime }) + String.fromCharCode(10), "utf8"); }, 600); setTimeout(() => {}, 20000);\';',
    '    const worker = spawn(process.execPath, ["-e", workerScript, join(workspace, "worker-launches.jsonl")], { detached: true, stdio: ["ignore", "inherit", "inherit"] });',
    `    await writeFile(join(here, "wait-route-worker.pid"), String(worker.pid), "utf8");`,
    '    await new Promise((resolve) => setTimeout(resolve, 1400));',
    '    process.exit(0);',
    '  }',
    '  if (mode === "forged-record") {',
    '    // FORGED EVIDENCE: the model-writable launch log names an UNRELATED',
    '    // live process with its REAL pid, pgid, and captured identity. The',
    '    // trusted launch boundary must refuse to own it — the victim must',
    '    // survive cleanup, whatever the record claims.',
    '    const { readFile: readForged, appendFile } = await import("node:fs/promises");',
    '    const { dirname: forgedDirname, join: forgedJoin } = await import("node:path");',
    '    const { fileURLToPath: forgedToPath } = await import("node:url");',
    '    const { spawnSync: forgedSpawnSync } = await import("node:child_process");',
    '    const here = forgedDirname(forgedToPath(import.meta.url));',
    '    const workspace = args[args.indexOf("-C") + 1];',
    '    const victimPid = Number(await readForged(forgedJoin(here, "wait-route-victim.pid"), "utf8"));',
    '    let identity = null;',
    '    let pgid = victimPid;',
    '    for (const ps of ["/bin/ps", "/usr/bin/ps"]) {',
    '      const r = forgedSpawnSync(ps, ["-p", String(victimPid), "-o", "lstart=,ppid=,comm="], { encoding: "utf8", timeout: 2000 });',
    '      if (r.status === 0 && typeof r.stdout === "string") {',
    '        const parts = r.stdout.trim().split(/\\s+/);',
    '        if (parts.length >= 3) {',
    '          identity = parts.slice(0, -2).join(" ").replace(/\\s+/g, " ") + "|ppid=" + parts.at(-2) + "|comm=" + parts.at(-1);',
    '          const g = forgedSpawnSync(ps, ["-p", String(victimPid), "-o", "pgid="], { encoding: "utf8", timeout: 2000 });',
    '          if (g.status === 0 && typeof g.stdout === "string") pgid = Number(g.stdout.trim());',
    '          break;',
    '        }',
    '      }',
    '    }',
    '    let starttime = null;',
    '    if (process.platform === "linux") { try { const fsF = await import("node:fs"); const stat = fsF.readFileSync("/proc/" + victimPid + "/stat", "utf8"); starttime = Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\\s+/)[19]); } catch { starttime = null; } }',
    '    await appendFile(forgedJoin(workspace, "worker-launches.jsonl"), JSON.stringify({ event: "worker-launched", pid: victimPid, pgid, sid: null, identity, starttime }) + "\\n", "utf8");',
    '    process.stdout.write(JSON.stringify({ final: ' + JSON.stringify(COMPLETION_MARKER) + ' }) + "\\n");',
    '    process.exit(0);',
    '  }',
    '  if (mode === "phantom-record") {',
    '    // A shape-valid record naming a pid that NEVER existed + the marker:',
    '    // exit status alone is not launch provenance — the smoke must not',
    '    // grant success from evidence the run never owned.',
    '    const { appendFile: appendPhantom } = await import("node:fs/promises");',
    '    const workspaceP = args[args.indexOf("-C") + 1];',
    '    await appendPhantom(workspaceP + "/worker-launches.jsonl", JSON.stringify({ event: "worker-launched", pid: 2147483000, pgid: 2147483000, sid: null, identity: "Thu Oct 1 00:00:00 2026|ppid=1|comm=node", starttime: null }) + "\\n", "utf8");',
    '    process.stdout.write(JSON.stringify({ final: ' + JSON.stringify(COMPLETION_MARKER) + ' }) + "\\n");',
    '    process.exit(0);',
    '  }',
    '  if (mode === "phantom-host-group-record") {',
    '    // The pgid-forgery shape: a record naming a pid that NEVER existed',
    "    // with its group CLAIMED as this host's own pid. The host pid is not",
    '    // launch authority by itself — the poll attestation must refuse it.',
    '    const { appendFile: appendPhantomGroup } = await import("node:fs/promises");',
    '    const workspacePG = args[args.indexOf("-C") + 1];',
    '    await appendPhantomGroup(workspacePG + "/worker-launches.jsonl", JSON.stringify({ event: "worker-launched", pid: 2147483001, pgid: process.pid, sid: null, identity: "Thu Oct 1 00:00:00 2026|ppid=1|comm=node", starttime: null }) + "\\n", "utf8");',
    '    process.stdout.write(JSON.stringify({ final: ' + JSON.stringify(COMPLETION_MARKER) + ' }) + "\\n");',
    '    process.exit(0);',
    '  }',
    '  if (mode === "normal-exit-worker") {',
    '    // A REAL separately-grouped worker that completes NATURALLY (records',
    '    // itself, exits in-budget); the host waits then prints the marker. The',
    '    // attestation must preserve provenance across the natural exit.',
    '    const { writeFile: wNorm, appendFile: aNorm } = await import("node:fs/promises");',
    '    const { dirname: nDirname, join: nJoin } = await import("node:path");',
    '    const { fileURLToPath: nToPath } = await import("node:url");',
    '    const { spawnSync: nSpawnSync } = await import("node:child_process");',
    '    const hereN = nDirname(nToPath(import.meta.url));',
    '    const workspaceN = args[args.indexOf("-C") + 1];',
    '    const w = spawn(process.execPath, ["-e", "setTimeout(() => {}, 400)"], { detached: true, stdio: "ignore" });',
    '    await wNorm(nJoin(hereN, "wait-route-normal-worker.pid"), String(w.pid), "utf8");',
    '    let identity = null; let pgid = w.pid;',
    '    for (const ps of ["/bin/ps", "/usr/bin/ps"]) {',
    '      const r = nSpawnSync(ps, ["-p", String(w.pid), "-o", "lstart=,ppid=,comm="], { encoding: "utf8", timeout: 2000 });',
    '      if (r.status === 0 && typeof r.stdout === "string") { const parts = r.stdout.trim().split(/\\s+/); if (parts.length >= 3) { identity = parts.slice(0, -2).join(" ").replace(/\\s+/g, " ") + "|ppid=" + parts.at(-2) + "|comm=" + parts.at(-1); const g = nSpawnSync(ps, ["-p", String(w.pid), "-o", "pgid="], { encoding: "utf8", timeout: 2000 }); if (g.status === 0 && typeof g.stdout === "string") pgid = Number(g.stdout.trim()); break; } }',
    '    }',
    '    let starttime = null;',
    '    if (process.platform === "linux") { try { const fsN = await import("node:fs"); const stat = fsN.readFileSync("/proc/" + w.pid + "/stat", "utf8"); starttime = Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\\s+/)[19]); } catch { starttime = null; } }',
    '    await aNorm(nJoin(workspaceN, "worker-launches.jsonl"), JSON.stringify({ event: "worker-launched", pid: w.pid, pgid, sid: null, identity, starttime }) + "\\n", "utf8");',
    '    await new Promise((resolve) => setTimeout(resolve, 900));',
    '    process.stdout.write(JSON.stringify({ final: ' + JSON.stringify(COMPLETION_MARKER) + ' }) + "\\n");',
    '    process.exit(0);',
    '  }',
    '  if (mode === "replace-record-worker") {',
    '    // Owns a REAL detached worker W while the host lives (trusted',
    '    // boundary), then REWRITES the model-writable log with a record',
    '    // naming an unrelated replacement R (its real identity, claimed',
    '    // parent forged to this host). The retained evidence must never be',
    '    // replaced: R must survive cleanup unresolved.',
    '    const { writeFile: wReplace, appendFile: aReplace } = await import("node:fs/promises");',
    '    const { dirname: rDirname, join: rJoin } = await import("node:path");',
    '    const { fileURLToPath: rToPath } = await import("node:url");',
    '    const { spawnSync: rSpawnSync } = await import("node:child_process");',
    '    const hereR = rDirname(rToPath(import.meta.url));',
    '    const workspaceR = args[args.indexOf("-C") + 1];',
    '    const capture = (pid) => { let identity = null; let pgid = pid; for (const ps of ["/bin/ps", "/usr/bin/ps"]) { const r = rSpawnSync(ps, ["-p", String(pid), "-o", "lstart=,ppid=,comm="], { encoding: "utf8", timeout: 2000 }); if (r.status === 0 && typeof r.stdout === "string") { const parts = r.stdout.trim().split(/\\s+/); if (parts.length >= 3) { identity = parts.slice(0, -2).join(" ").replace(/\\s+/g, " ") + "|ppid=" + parts.at(-2) + "|comm=" + parts.at(-1); const g = rSpawnSync(ps, ["-p", String(pid), "-o", "pgid="], { encoding: "utf8", timeout: 2000 }); if (g.status === 0 && typeof g.stdout === "string") pgid = Number(g.stdout.trim()); break; } } } return { identity, pgid }; };',
    '    const w = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });',
    '    await wReplace(rJoin(hereR, "wait-route-replaced-worker.pid"), String(w.pid), "utf8");',
    '    const wInfo = capture(w.pid);',
    '    await aReplace(rJoin(workspaceR, "worker-launches.jsonl"), JSON.stringify({ event: "worker-launched", pid: w.pid, pgid: wInfo.pgid, sid: null, identity: wInfo.identity, starttime: null }) + "\\n", "utf8");',
    '    await new Promise((resolve) => setTimeout(resolve, 700));',
    '    const r = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });',
    '    await new Promise((rWait) => setTimeout(rWait, 200));',
    '    await wReplace(rJoin(hereR, "wait-route-replacement.pid"), String(r.pid), "utf8");',
    '    const rInfo = capture(r.pid);',
    '    if (rInfo.identity === null) rInfo.identity = "x";',
    '    const forged = { event: "worker-launched", pid: r.pid, pgid: rInfo.pgid, sid: null, identity: rInfo.identity.replace(/\\|ppid=[0-9]+/, "|ppid=" + process.pid), starttime: null };',
    '    await wReplace(rJoin(workspaceR, "worker-launches.jsonl"), JSON.stringify(forged) + "\\n", "utf8");',
    '    process.stdout.write(JSON.stringify({ final: ' + JSON.stringify(COMPLETION_MARKER) + ' }) + "\\n");',
    '    process.exit(0);',
    '  }',
    '  if (mode === "intermediary-worker") {',
    '    // The npm launcher shape: the host spawns an INTERMEDIATE process',
    '    // (the CLI); the intermediate spawns the DETACHED separately-grouped',
    '    // worker. The worker\'s direct parent is the intermediate, not the',
    '    // host; the trusted boundary must verify the whole ancestry chain',
    '    // while the host lives so the worker is owned and settled.',
    '    const { dirname: iDirname, join: iJoin } = await import("node:path");',
    '    const { fileURLToPath: iToPath } = await import("node:url");',
    '    const { spawnSync: iSpawnSync } = await import("node:child_process");',
    '    const hereI = iDirname(iToPath(import.meta.url));',
    '    const workspaceI = args[args.indexOf("-C") + 1];',
    '    const innerScript = "const { spawn } = require(\'node:child_process\'); const w = spawn(process.execPath, [\'-e\', \'setTimeout(() => {}, 60000)\'], { detached: true, stdio: \'ignore\' }); require(\'node:fs\').writeFileSync(process.env.INTER_PID_FILE, String(w.pid)); setTimeout(() => {}, 8000);";',
    '    const intermediate = spawn(process.execPath, ["-e", innerScript], { env: { ...process.env, INTER_PID_FILE: iJoin(hereI, "wait-route-inter-worker.pid") }, stdio: "ignore" });',
    '    const capture = (pid) => { let identity = null; let pgid = pid; for (const ps of ["/bin/ps", "/usr/bin/ps"]) { const r = iSpawnSync(ps, ["-p", String(pid), "-o", "lstart=,ppid=,comm="], { encoding: "utf8", timeout: 2000 }); if (r.status === 0 && typeof r.stdout === "string") { const parts = r.stdout.trim().split(/\\s+/); if (parts.length >= 3) { identity = parts.slice(0, -2).join(" ").replace(/\\s+/g, " ") + "|ppid=" + parts.at(-2) + "|comm=" + parts.at(-1); const g = iSpawnSync(ps, ["-p", String(pid), "-o", "pgid="], { encoding: "utf8", timeout: 2000 }); if (g.status === 0 && typeof g.stdout === "string") pgid = Number(g.stdout.trim()); break; } } } return { identity, pgid }; };',
    '    let workerPid = 0;',
    '    for (let i = 0; i < 40 && workerPid === 0; i += 1) { await new Promise((r2) => setTimeout(r2, 100)); workerPid = Number(await import("node:fs/promises").then((f) => f.readFile(iJoin(hereI, "wait-route-inter-worker.pid"), "utf8").catch(() => "0"))); }',
    '    const wInfo = capture(workerPid);',
    '    let starttime = null;',
    '    if (process.platform === "linux") { try { const fsI = await import("node:fs"); const stat = fsI.readFileSync("/proc/" + workerPid + "/stat", "utf8"); starttime = Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\\s+/)[19]); } catch { starttime = null; } }',
    '    const { appendFile: aInter } = await import("node:fs/promises");',
    '    await aInter(iJoin(workspaceI, "worker-launches.jsonl"), JSON.stringify({ event: "worker-launched", pid: workerPid, pgid: wInfo.pgid, sid: null, identity: wInfo.identity, starttime }) + "\\n", "utf8");',
    '    await new Promise((resolve) => setTimeout(resolve, 1200));',
    '    process.stdout.write(JSON.stringify({ final: ' + JSON.stringify(COMPLETION_MARKER) + ' }) + "\\n");',
    '    process.exit(0);',
    '  }',
    '  if (mode === "exit-leave-descendant") {',
    '    // Spawns a long-lived group member and exits immediately: group',
    '    // ownership must survive the leader exit so cleanup settles the',
    '    // surviving descendant.',
    '    const { writeFile } = await import("node:fs/promises");',
    '    const { dirname, join } = await import("node:path");',
    '    const { fileURLToPath } = await import("node:url");',
    '    const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });',
    `    await writeFile(join(dirname(fileURLToPath(import.meta.url)), "wait-route-descendant.pid"), String(descendant.pid), "utf8");`,
    '    process.exit(0);',
    '  }',
    '  if (mode === "slow-group") {',
    '    // A long-lived descendant inside the fake host\'s own process group:',
    '    // the driver\'s group-kill semantics must settle it with the host.',
    '    const { writeFile } = await import("node:fs/promises");',
    '    const { dirname, join } = await import("node:path");',
    '    const { fileURLToPath } = await import("node:url");',
    '    const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });',
    `    await writeFile(join(dirname(fileURLToPath(import.meta.url)), "wait-route-descendant.pid"), String(descendant.pid), "utf8");`,
    '    await new Promise((resolve) => setTimeout(resolve, 8000));',
    '    process.exit(0);',
    '  }',
    `  if (mode === "shell") {`,
    `    const escaped = ${JSON.stringify(WORKER_FILE_NAME.replace('.', '\\.'))};`,
    '    const joined = args.join(" ");',
    '    // The driver quotes both paths for the shell, so the worker path may',
    '    // arrive single-quoted (spaces and metacharacters are legal directory',
    '    // names); fall back to the bare form for an unquoted prompt.',
    `    const quoted = joined.match(new RegExp("'([^']*" + escaped + ")'"));`,
    `    const bare = joined.match(new RegExp("(\\\\S+" + escaped + ")"));`,
    '    const match = quoted || bare;',
    '    const worker = match ? (match[1] ?? match[0]) : null;',
    '    if (!worker) process.exit(4);',
    '    await new Promise((resolve, reject) => {',
    '      const child = spawn(process.execPath, [worker], { stdio: "inherit" });',
    '      child.on("exit", resolve); child.on("error", reject);',
    '    });',
    '    process.stdout.write(JSON.stringify({ final: ' + JSON.stringify(COMPLETION_MARKER) + ' }) + "\\n");',
    '    process.exit(0);',
    '  }',
    '  if (mode === "shell-profile" || mode === "shell-profile-altered" || mode === "role-control") {',
    '    // Profile-mode fake host: extracts the quoted worker path AND the',
    '    // numeric profile tail (--duration-ms / --noise-interval-ms) from',
    '    // the prompt and launches the worker EXACTLY ONCE with that argv,',
    '    // then prints the fixed final marker JSON like a model final message.',
    `    const escapedProfile = ${JSON.stringify(WORKER_FILE_NAME.replace('.', '\\.'))};`,
    '    const joinedProfile = args.join(" ");',
    `    const quotedProfile = joinedProfile.match(new RegExp("'([^']*" + escapedProfile + ")'"));`,
    `    const bareProfile = joinedProfile.match(new RegExp("(\\\\S+" + escapedProfile + ")"));`,
    '    const profileMatch = quotedProfile || bareProfile;',
    '    const profileWorker = profileMatch ? (profileMatch[1] ?? profileMatch[0]) : null;',
    '    if (!profileWorker) process.exit(4);',
    '    const durationMatch = joinedProfile.match(/--duration-ms (\\d+)/);',
    '    const noiseMatch = joinedProfile.match(/--noise-interval-ms (\\d+)/);',
    '    const profileWorkerArgs = [profileWorker];',
    '    // The altered-profile mode DROPS the requested duration: the worker',
    '    // records its actual (default) duration so the driver can prove it',
    '    // refuses a mismatched profile.',
    '    if (durationMatch && mode !== "shell-profile-altered") profileWorkerArgs.push("--duration-ms", durationMatch[1]);',
    '    if (noiseMatch) profileWorkerArgs.push("--noise-interval-ms", noiseMatch[1]);',
    '    await new Promise((resolve, reject) => {',
    '      const child = spawn(process.execPath, profileWorkerArgs, { stdio: "inherit" });',
    '      child.on("exit", resolve); child.on("error", reject);',
    '    });',
    '    if (mode === "role-control") {',
    '      // The managed-child evidence: write a minimal session rollout',
    '      // proving the synthetic-role child was spawned and polled',
    '      // (spawn_agent + wait_agent calls with outputs).',
    '      const { mkdir, writeFile: wFile } = await import("node:fs/promises");',
    '      const sessionsDir = args[args.indexOf("-C") + 1].replace(/workspace$/, "codex-home") + "/sessions";',
    '      if (sessionsDir) {',
    '        await mkdir(sessionsDir, { recursive: true });',
    '        const now = Date.now();',
    '        const wrap = (payload) => JSON.stringify({ timestamp: new Date(now).toISOString(), type: "response_item", payload });',
    '        const meta = (id, parentId) => JSON.stringify({ timestamp: new Date(now).toISOString(), type: "session_meta", payload: parentId === undefined ? { id } : { id, parent_thread_id: parentId } });',
    '        // The ROOT rollout: session meta (own thread id), spawn_agent for',
    '        // the synthetic role + wait_agent (written LAST so it is the',
    '        // newest by mtime, the Root rollout).',
    '        const rootRollout = [',
    '          meta("rc-root-thread"),',
    '          wrap({ type: "function_call", call_id: "rc-spawn", name: "spawn_agent", arguments: JSON.stringify({ agent_type: "wait-probe-synthetic" }) }),',
    '          wrap({ type: "function_call_output", call_id: "rc-spawn", output: JSON.stringify({ task_name: "probe" }) }),',
    '          wrap({ type: "function_call", call_id: "rc-wait", name: "wait_agent", arguments: JSON.stringify({ child_agent_id: "rc", wait_ms: 1000 }) }),',
    '          wrap({ type: "function_call_output", call_id: "rc-wait", output: "ok" }),',
    '        ].join("\\n");',
    '        await wFile(sessionsDir + "/rollout-root.jsonl", rootRollout + "\\n", "utf8");',
    '        // The CHILD rollout: session meta linking it to the Root thread',
    '        // (the source-pinned spawn edge), then the exec_command the',
    '        // synthetic-role child ran itself — the EXACT command from the',
    '        // prompt (the invocation evidence the summarizer correlates),',
    '        // written FIRST so its mtime is older than Root\'s.',
    '        const promptText = String(args[args.length - 1] || "");',
    '        const cmdMatch = promptText.match(/shell tool: ([^\\n]+)/);',
    '        const childCmd = cmdMatch !== null ? cmdMatch[1] : "node wait-route-worker.mjs --duration-ms 1000";',
    '        const childRollout = [',
    '          meta("rc-child-thread", "rc-root-thread"),',
    `          wrap({ type: "function_call", call_id: "rc-exec", name: "exec_command", arguments: JSON.stringify({ cmd: childCmd, yield_time_ms: 30000 }) }),`,
    `          wrap({ type: "function_call_output", call_id: "rc-exec", output: ${JSON.stringify(COMPLETION_MARKER)} }),`,
    '        ].join("\\n");',
    '        await wFile(sessionsDir + "/rollout-child.jsonl", childRollout + "\\n", "utf8");',
    '      }',
    '    }',
    `    process.stdout.write(JSON.stringify({ final: ${JSON.stringify(COMPLETION_MARKER)} }) + "\\n");`,
    '    process.exit(0);',
    '  }',
    '  if (mode === "marker-only") {',
    '    // Prints the fixed completion marker WITHOUT ever launching the',
    '    // worker: the smoke must not accept this as a completed run.',
    '    process.stdout.write(JSON.stringify({ final: ' + JSON.stringify(COMPLETION_MARKER) + ' }) + "\\n");',
    '    process.exit(0);',
    '  }',
    '  if (mode === "torn-launch-log") {',
    '    // Launches the REAL worker (one valid launch record) and then appends',
    '    // a TORN trailing record: the smoke must fail closed on incomplete',
    '    // launch evidence instead of counting one valid record as complete.',
    `    const escapedTorn = ${JSON.stringify(WORKER_FILE_NAME.replace('.', '\\.'))};`,
    '    const joinedTorn = args.join(" ");',
    `    const quotedTorn = joinedTorn.match(new RegExp("'([^']*" + escapedTorn + ")'"));`,
    `    const bareTorn = joinedTorn.match(new RegExp("(\\\\S+" + escapedTorn + ")"));`,
    '    const tornMatch = quotedTorn || bareTorn;',
    '    const tornWorker = tornMatch ? (tornMatch[1] ?? tornMatch[0]) : null;',
    '    if (!tornWorker) process.exit(4);',
    '    await new Promise((resolve, reject) => {',
    '      const child = spawn(process.execPath, [tornWorker], { stdio: "inherit" });',
    '      child.on("exit", resolve); child.on("error", reject);',
    '    });',
    '    const { appendFile: appendTorn } = await import("node:fs/promises");',
    '    const { dirname: tornDirname, join: tornJoin } = await import("node:path");',
    '    const workspace = args[args.indexOf("-C") + 1];',
    '    void tornDirname;',
    '    await appendTorn(tornJoin(workspace, "worker-launches.jsonl"), \'{"event":"worker-l\', "utf8");',
    '    process.stdout.write(JSON.stringify({ final: ' + JSON.stringify(COMPLETION_MARKER) + ' }) + "\\n");',
    '    process.exit(0);',
    '  }',
    '  if (mode === "hook-hold" || mode === "hook-hold-abandon" || mode === "hook-ordering") {',
    `    const { Client } = await import(${JSON.stringify(sdkClientUrl)});`,
    `    const { StdioClientTransport } = await import(${JSON.stringify(sdkStdioUrl)});`,
    '    const transport = new StdioClientTransport({',
    '      command: process.execPath,',
    '      args: [' + JSON.stringify(serverModulePath) + '],',
    '      env: { WAIT_ROUTE_PROBE_TRACE: process.env.WAIT_ROUTE_PROBE_TRACE, WAIT_ROUTE_PROBE_NONCE: process.env.WAIT_ROUTE_PROBE_NONCE },',
    '    });',
    '    const client = new Client({ name: "wait-route-fake-host", version: "0.0.0" });',
    '    await client.connect(transport);',
    '    if (mode === "hook-hold") {',
    '      await client.callTool({ name: "prompt_hold", arguments: { ms: Number(process.env.WAIT_ROUTE_FAKE_HOLD_MS || 1500) } });',
    '    } else if (mode === "hook-hold-abandon") {',
    '      const abandoned = client.callTool({ name: "prompt_hold", arguments: { ms: 30000 } });',
    '      abandoned.catch(() => {});',
    '      await new Promise((resolve) => setTimeout(resolve, 600));',
    '      await client.close();',
    '      process.exit(0);',
    '    } else {',
    '      const delayedPublisher = client.callTool({ name: "prompt_hold", arguments: { ms: 2500 } });',
    '      delayedPublisher.catch(() => {});',
    '      await client.callTool({ name: "capture_entry", arguments: {} });',
    '      await delayedPublisher;',
    '    }',
    '    await client.close();',
    '    process.exit(0);',
    '  }',
    '  if (mode === "entry" || mode === "entry-late-completion" || mode === "entry-then-fail") {',
    `    const { Client } = await import(${JSON.stringify(sdkClientUrl)});`,
    `    const { StdioClientTransport } = await import(${JSON.stringify(sdkStdioUrl)});`,
    '    const serverModule = ' + JSON.stringify(serverModulePath) + ';',
    '    let transportCommand = process.execPath;',
    '    let transportArgs = [serverModule];',
    '    if (mode === "entry-late-completion") {',
    '      // A detached completer (outside the killed host group) records the',
    '      // handler completion during the bounded post-deadline drain, while a',
    '      // detached holder keeps the observation open past the budget.',
    '      const { appendFile, writeFile } = await import("node:fs/promises");',
    '      const { dirname, join } = await import("node:path");',
    '      const { fileURLToPath } = await import("node:url");',
    '      const here = dirname(fileURLToPath(import.meta.url));',
    '      const tracePath = process.env.WAIT_ROUTE_PROBE_TRACE;',
    '      const append = (event) => appendFile(tracePath, JSON.stringify({ at: Date.now(), ...event }) + "\\n", "utf8");',
    '      await append({ kind: "server-started", serverPid: process.pid, identityHash: null });',
    '      await append({ kind: "handler-entered", callNonce: "late-completion" });',
    '      const completerPath = join(here, "wait-route-late-completer.mjs");',
    '      await writeFile(completerPath, [',
    '      `#!${process.execPath}`,',
    '        "import { appendFile } from \'node:fs/promises\';",',
    '        "setTimeout(async () => {",',
    '        "  const event = { at: Date.now(), kind: \'handler-completed\', callNonce: \'late-completion\', settlement: \'completed\' };",',
    '        "  await appendFile(process.argv[2], JSON.stringify(event) + String.fromCharCode(10));",',
    '        "}, 1750);",',
    '        "setTimeout(() => {}, 20000);",',
    '      ].join("\\n"), { encoding: "utf8", mode: 0o755 });',
    '      const completer = spawn(completerPath, [tracePath], { detached: true, stdio: "ignore" });',
    `    await writeFile(join(here, "wait-route-completer.pid"), String(completer.pid), "utf8");`,
    '      const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });',
    `    await writeFile(join(here, "wait-route-holder.pid"), String(holder.pid), "utf8");`,
    '      await new Promise((resolve) => setTimeout(resolve, 300));',
    '      process.exit(0);',
    '    }',
    '    // The real host forwards the descriptor env_vars explicitly; the SDK',
    '    // stdio transport sanitizes by default, so mimic that forwarding.',
    '    const transport = new StdioClientTransport({',
    '      command: transportCommand,',
    '      args: transportArgs,',
    '      env: { WAIT_ROUTE_PROBE_TRACE: process.env.WAIT_ROUTE_PROBE_TRACE, WAIT_ROUTE_PROBE_NONCE: process.env.WAIT_ROUTE_PROBE_NONCE },',
    '    });',
    '    const client = new Client({ name: "wait-route-fake-host", version: "0.0.0" });',
    '    await client.connect(transport);',
    '    await client.callTool({ name: ' + JSON.stringify(CAPTURE_TOOL_NAME) + ', arguments: {} });',
    '    await client.close();',
    '    if (mode === "entry-then-fail") process.exit(3);',
    '    process.exit(0);',
    '  }',
    '  process.exit(0);',
    '}',
    'process.exit(2);',
    '',
  ].join('\n');
  await writeFile(fakeCodexPath, body, { encoding: 'utf8', mode: 0o755 });
  return fakeCodexPath;
}

/** Awaits a promise expected to reject with the exact closed error code. */
async function expectErrorCode(promise, code) {
  let error;
  try {
    error = await promise;
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error, `expected an Error, got ${typeof error}`);
  assert.equal(fixtureErrorCode(error), code);
}

function fixtureErrorCode(error) {
  return error && typeof error === 'object' && 'code' in error ? error.code : '';
}

test('the fixture worker flushes the terminal marker before exiting under a full pipe', { timeout: 30_000 }, async () => {
  await withTempDirectory(async (parent) => {
    const output = await newRunDirectory(parent);
    const fixture = await buildWaitRouteFixture({ outputDir: output, serverPath: serverModulePath });
    // Noise at 1 ms for 8 s (~220 KB) overfills the 64 KB host pipe; the
    // reader stays PAUSED for the whole hold (real backpressure — the
    // written volume far exceeds the kernel buffer). DRAINING starts
    // BEFORE awaiting exit — the worker's marker-write callback needs the
    // parent to drain — and failure cleanup kills the child so a
    // regression cannot leave it alive.
    const child = spawn(process.execPath, [fixture.workerPath, '--duration-ms', '8000', '--noise-interval-ms', '1'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.stdout.pause();
    await new Promise((resolve) => setTimeout(resolve, 9000));
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stdout.resume();
    const exitCode = await new Promise((resolve) => {
      const watchdog = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, 10_000);
      child.on('exit', (code) => {
        clearTimeout(watchdog);
        resolve(code);
      });
    });
    await new Promise((resolve) => {
      child.stdout.on('end', resolve);
      setTimeout(resolve, 3000);
    });
    const outputText = Buffer.concat(chunks).toString();
    assert.equal(exitCode, 0, 'the worker exits cleanly after flushing');
    assert.equal(outputText.includes(COMPLETION_MARKER), true, 'the completion marker survives a full pipe and a delayed reader');
    assert.equal(outputText.lastIndexOf(COMPLETION_MARKER), outputText.length - COMPLETION_MARKER.trim().length - 1, 'the marker is the final output line');
  });
});

test('the fixture worker still terminates promptly under SIGTERM with unread stdout', { timeout: 20_000 }, async () => {
  await withTempDirectory(async (parent) => {
    const output = await newRunDirectory(parent);
    const fixture = await buildWaitRouteFixture({ outputDir: output, serverPath: serverModulePath });
    // Heavy noise, stdout NEVER read (backpressure with no reader): the
    // signal line cannot flush, yet SIGTERM must still terminate the
    // worker promptly (bounded fallback exit).
    const child = spawn(process.execPath, [fixture.workerPath, '--duration-ms', '60000', '--noise-interval-ms', '1'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.stdout.pause();
    setTimeout(() => child.kill('SIGTERM'), 500);
    const startedAt = Date.now();
    const exit = await new Promise((resolve) => { child.on('exit', (code, signal) => resolve({ code, signal, at: Date.now() - startedAt })); });
    assert.ok(exit.at < 5000, `SIGTERM must terminate promptly under backpressure (took ${exit.at} ms)`);
    assert.ok(exit.code === 143 || exit.signal === 'SIGTERM', `the worker exits with the SIGTERM status (got code ${exit.code} signal ${exit.signal})`);
  });
});

test('the fixture worker honors SIGTERM while the completion flush is pending', { timeout: 30_000 }, async () => {
  await withTempDirectory(async (parent) => {
    const output = await newRunDirectory(parent);
    const fixture = await buildWaitRouteFixture({ outputDir: output, serverPath: serverModulePath });
    // finish() fires with stdout unread (its marker flush pends behind the
    // full pipe — 10 s of 1 ms noise far overfills the 64 KB pipe); a
    // SUBSEQUENT SIGTERM must still terminate the worker — pending
    // completion is not an exit.
    const child = spawn(process.execPath, [fixture.workerPath, '--duration-ms', '10000', '--noise-interval-ms', '1'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.stdout.pause();
    setTimeout(() => child.kill('SIGTERM'), 11000);
    const startedAt = Date.now();
    const exit = await new Promise((resolve) => { child.on('exit', (code, signal) => resolve({ code, signal, at: Date.now() - startedAt })); });
    assert.ok(exit.at < 15000, `SIGTERM after the pending flush must terminate promptly (took ${exit.at} ms)`);
    assert.ok(exit.code === 143 || exit.signal === 'SIGTERM', `the worker exits with the SIGTERM status (got code ${exit.code} signal ${exit.signal})`);
  });
});

test('buildWaitRouteFixture creates the complete isolated marketplace layout', async () => {
  await withTempDirectory(async (parent) => {
    const output = await newRunDirectory(parent);
    const serverPath = serverModulePath;
    const manifest = await buildWaitRouteFixture({ outputDir: output, serverPath });

    for (const relative of [
      '.agents/plugins/marketplace.json',
      `plugins/${PLUGIN_NAME}/.codex-plugin/plugin.json`,
      `plugins/${PLUGIN_NAME}/.mcp.json`,
      `plugins/${PLUGIN_NAME}/hooks/hooks.json`,
      `plugins/${PLUGIN_NAME}/skills/wait-route/SKILL.md`,
      `plugins/${PLUGIN_NAME}/workers/${WORKER_FILE_NAME}`,
    ]) {
      const stats = await lstat(join(output, relative));
      assert.ok(stats.isFile(), `${relative} must be a regular file`);
    }
    const marketplace = JSON.parse(await readFile(join(output, '.agents/plugins/marketplace.json'), 'utf8'));
    assert.equal(marketplace.plugins[0].source.path, `./plugins/${PLUGIN_NAME}`);
    const plugin = JSON.parse(await readFile(join(output, `plugins/${PLUGIN_NAME}/.codex-plugin/plugin.json`), 'utf8'));
    assert.equal(plugin.name, PLUGIN_NAME);
    // The hook is a model-hidden mcp_tool hook bound to the fixture server's
    // capture tool, with a bounded timeout well above the fixture-only hold.
    const hooks = JSON.parse(await readFile(join(output, `plugins/${PLUGIN_NAME}/hooks/hooks.json`), 'utf8'));
    const hookEntry = hooks.hooks.UserPromptSubmit[0].hooks[0];
    assert.equal(hookEntry.type, 'mcp_tool');
    assert.equal(hookEntry.server, SERVER_NAME);
    assert.equal(hookEntry.tool, CAPTURE_TOOL_NAME);
    assert.ok(hookEntry.timeout >= 15);
    // The harmless worker is a direct-Node script carrying the fixed marker.
    const worker = await readFile(join(output, `plugins/${PLUGIN_NAME}/workers/${WORKER_FILE_NAME}`), 'utf8');
    assert.ok(worker.startsWith(`#!${process.execPath}`), 'worker must use the direct Node binary');
    assert.ok(worker.includes(COMPLETION_MARKER), 'worker must print the fixed completion marker');
    assert.equal(manifest.pluginRoot, join(output, 'plugins', PLUGIN_NAME));
  });
});

test('the fixture rejects invalid outputs and a missing server module as instrument failures', async () => {
  await withTempDirectory(async (parent) => {
    const serverPath = serverModulePath;
    await expectErrorCode(buildWaitRouteFixture({ outputDir: 'relative-output', serverPath }), 'WAIT_ROUTE_FIXTURE_OUTPUT_RELATIVE');
    await expectErrorCode(buildWaitRouteFixture({ outputDir: join(parent, 'missing'), serverPath }), 'WAIT_ROUTE_FIXTURE_OUTPUT_MISSING');
    const occupied = join(parent, 'occupied');
    await mkdir(occupied, { mode: 0o700 });
    await writeFile(join(occupied, 'occupied.txt'), 'not empty', 'utf8');
    await expectErrorCode(buildWaitRouteFixture({ outputDir: occupied, serverPath }), 'WAIT_ROUTE_FIXTURE_OUTPUT_NOT_EMPTY');
    await expectErrorCode(
      buildWaitRouteFixture({ outputDir: join(parent, 'run'), serverPath: join(parent, 'no-such-server.mjs') }),
      'WAIT_ROUTE_FIXTURE_SERVER_MISSING',
    );
    if (posix) {
      const loose = join(parent, 'loose');
      await mkdir(loose, { mode: 0o755 });
      await expectErrorCode(buildWaitRouteFixture({ outputDir: loose, serverPath }), 'WAIT_ROUTE_FIXTURE_OUTPUT_MODE');
    }
  });
});

test('the fixture-only config enables the hooks feature without user configuration', async () => {
  await withTempDirectory(async (parent) => {
    const codexHome = join(parent, 'codex-home');
    await mkdir(codexHome, { mode: 0o700 });
    const { configPath } = await writeFixtureConfig({ codexHome });
    const body = await readFile(configPath, 'utf8');
    assert.match(body, /\[features\]/);
    assert.match(body, /hooks\s*=\s*true/);
    assert.doesNotMatch(body, /model_providers|projects\.|mcp_servers/);
    assert.equal(basename(configPath), 'config.toml');
    await expectErrorCode(writeFixtureConfig({ codexHome }), 'WAIT_ROUTE_FIXTURE_CONFIG_EXISTS');
  });
});

test('the MCP descriptor launches the direct Node binary, never an env lookup', async () => {
  await withTempDirectory(async (parent) => {
    const output = await newRunDirectory(parent);
    const serverPath = serverModulePath;
    await buildWaitRouteFixture({ outputDir: output, serverPath });
    const descriptor = JSON.parse(await readFile(join(output, `plugins/${PLUGIN_NAME}/.mcp.json`), 'utf8'));
    const server = descriptor.mcpServers[SERVER_NAME];
    assert.equal(server.command, process.execPath, 'the descriptor must launch the direct Node binary');
    assert.ok(isAbsolute(server.command));
    assert.deepEqual(server.args, [serverPath]);
    assert.deepEqual([...server.env_vars].sort(), ['WAIT_ROUTE_PROBE_NONCE', 'WAIT_ROUTE_PROBE_TRACE']);
  });
});

test('private traces are closed-vocabulary, bounded, and mode-0600', async () => {
  await withTempDirectory(async (parent) => {
    const traceDir = join(parent, 'trace');
    await appendTraceEvent({ runDirectory: traceDir, runNonce: HEX_NONCE, event: { kind: 'server-started', serverPid: 1 } });
    if (posix) {
      const dirStats = await lstat(traceDir);
      assert.equal(dirStats.mode & 0o777, 0o700, 'trace directory must be private');
      const fileStats = await lstat(join(traceDir, 'events.jsonl'));
      assert.equal(fileStats.mode & 0o777, 0o600, 'trace file must be private');
    }
    await expectErrorCode(
      appendTraceEvent({ runDirectory: traceDir, runNonce: HEX_NONCE, event: { kind: 'not-a-kind' } }),
      'WAIT_ROUTE_TRACE_KIND_UNKNOWN',
    );
    await expectErrorCode(
      appendTraceEvent({ runDirectory: traceDir, runNonce: HEX_NONCE, event: { kind: 'server-started', pad: 'x'.repeat(TRACE_MAX_EVENT_BYTES) } }),
      'WAIT_ROUTE_TRACE_EVENT_TOO_LARGE',
    );
    for (let index = 0; index < TRACE_MAX_RECORDS + 1; index += 1) {
      await appendTraceEvent({ runDirectory: traceDir, runNonce: HEX_NONCE, event: { kind: 'case-started', caseLabel: 'hook-entry', note: index } });
    }
    const { records, truncated } = await readTraceEvents({ runDirectory: traceDir, runNonce: HEX_NONCE });
    assert.equal(records.length, TRACE_MAX_RECORDS, 'reads must be bounded');
    assert.equal(truncated, true, 'the reader must report truncation honestly');
  });
});

test('the trace reader stops at its bounds without waiting for file end', { timeout: 45_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // A named pipe with a live writer is the discriminator: a reader that
    // loads the whole file — or accumulates an unbounded pending line —
    // would wait for EOF forever, while a bounded reader stops as soon as a
    // limit is reached. Three payloads exercise three accumulation hazards:
    // many complete lines, ONE oversized unterminated line, and a blank-line
    // flood that carries no bytes under per-line accounting.
    const scenarios = /** @type {const} */ ([
      { label: 'complete lines', payload: completeLinePayload() },
      { label: 'oversized unterminated line', payload: `${JSON.stringify({ kind: 'server-started', pad: 'x'.repeat(5 * 1024 * 1024) })}` },
      { label: 'blank-line flood', payload: '\n'.repeat(5 * 1024 * 1024) },
    ]);
    for (const scenario of scenarios) {
      const traceDir = join(parent, `trace-${scenario.label.replaceAll(' ', '-')}`);
      await mkdir(traceDir, { mode: 0o700 });
      const fifo = join(traceDir, 'events.jsonl');
      const mkfifo = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
      if (mkfifo.status !== 0) return; // no mkfifo on this platform: nothing to prove
      const readerPromise = readTraceEvents({ runDirectory: traceDir, runNonce: HEX_NONCE });
      const writer = await open(fifo, 'w'); // pairs with the reader's open
      try {
        // The payload exceeds the 4 MiB byte cap and the writer NEVER closes:
        // the reader must stop at its bound, not at end of file.
        try {
          await writer.write(scenario.payload);
        } catch (error) {
          // The bounded reader stops at the cap and closes the pipe while the
          // oversized write is still in flight: EPIPE here is the success
          // signal, not a failure.
          if (fixtureErrorCode(error) !== 'EPIPE') throw error;
        }
        let watchdogTimer;
        const watchdog = new Promise((_, rejectHung) => {
          watchdogTimer = setTimeout(() => rejectHung(new Error(`the reader waited for file end on ${scenario.label} instead of stopping at its bound`)), 10_000);
        });
        watchdogTimer.unref?.();
        let result;
        try {
          result = await Promise.race([readerPromise, watchdog]);
        } finally {
          clearTimeout(watchdogTimer);
        }
        assert.equal(result.truncated, true, `${scenario.label}: the oversize trace must be reported as truncated`);
        assert.ok(result.records.length <= TRACE_MAX_RECORDS, `${scenario.label}: the result must stay within the record bound`);
      } finally {
        await writer.close().catch(() => {});
      }
    }
  });
});

/** Roughly 600 events of ~8 KiB each (~4.8 MiB): the byte cap is reached before the writer closes. */
function completeLinePayload() {
  const pad = 'x'.repeat(8000);
  return Array.from({ length: 600 }, (_, index) => `${JSON.stringify({ kind: 'server-started', n: index, pad })}\n`).join('');
}

test('a newline-terminated oversized event is rejected like an unterminated one', async () => {
  await withTempDirectory(async (parent) => {
    // The per-event cap must hold regardless of line termination: a complete
    // (newline-terminated) event larger than TRACE_MAX_EVENT_BYTES is
    // out-of-bound trace evidence and must be reported as truncation, never
    // returned as a valid untruncated record.
    const traceDir = join(parent, 'trace');
    await appendTraceEvent({ runDirectory: traceDir, runNonce: HEX_NONCE, event: { kind: 'server-started', serverPid: 1 } });
    const oversized = JSON.stringify({ kind: 'server-started', pad: 'x'.repeat(TRACE_MAX_EVENT_BYTES + 1) });
    assert.ok(Buffer.byteLength(oversized, 'utf8') > TRACE_MAX_EVENT_BYTES, 'the staged event must exceed the per-event cap');
    await appendFile(join(traceDir, 'events.jsonl'), `${oversized}\n`, 'utf8');
    await appendTraceEvent({ runDirectory: traceDir, runNonce: HEX_NONCE, event: { kind: 'case-started', caseLabel: 'hook-entry' } });
    const { records, truncated } = await readTraceEvents({ runDirectory: traceDir, runNonce: HEX_NONCE });
    assert.equal(truncated, true, 'the oversized complete line must be reported as truncation');
    assert.equal(records.length, 1, 'only the in-bound events before the oversize line may be returned');
    assert.equal(records.some((record) => record.pad !== undefined), false,
      'the oversized event must never be returned as a valid record');
    assert.equal(records[0].kind, 'server-started');
  });
});

test('waitRouteTraceFromEnv fails closed as instrument failures on a noncanonical environment', async () => {
  await withTempDirectory(async (parent) => {
    // The executable reads its trace description from the environment; a
    // missing variable or a noncanonical trace path is an INSTRUMENT failure
    // with a closed code, never a tolerated startup.
    const originalTrace = process.env.WAIT_ROUTE_PROBE_TRACE;
    const originalNonce = process.env.WAIT_ROUTE_PROBE_NONCE;
    try {
      delete process.env.WAIT_ROUTE_PROBE_TRACE;
      delete process.env.WAIT_ROUTE_PROBE_NONCE;
      await expectErrorCode(Promise.resolve().then(() => waitRouteTraceFromEnv()), 'WAIT_ROUTE_ENV_MISSING');
      process.env.WAIT_ROUTE_PROBE_TRACE = 'relative-trace/events.jsonl';
      process.env.WAIT_ROUTE_PROBE_NONCE = HEX_NONCE;
      await expectErrorCode(Promise.resolve().then(() => waitRouteTraceFromEnv()), 'WAIT_ROUTE_ENV_INVALID');
      process.env.WAIT_ROUTE_PROBE_TRACE = join(parent, 'other-name.jsonl');
      await expectErrorCode(Promise.resolve().then(() => waitRouteTraceFromEnv()), 'WAIT_ROUTE_ENV_INVALID');
      // A SUFFIX match would accept not-events.jsonl while the server
      // writes events.jsonl — the basename must match EXACTLY.
      process.env.WAIT_ROUTE_PROBE_TRACE = join(parent, 'not-events.jsonl');
      await expectErrorCode(Promise.resolve().then(() => waitRouteTraceFromEnv()), 'WAIT_ROUTE_ENV_INVALID');
    } finally {
      if (originalTrace === undefined) delete process.env.WAIT_ROUTE_PROBE_TRACE;
      else process.env.WAIT_ROUTE_PROBE_TRACE = originalTrace;
      if (originalNonce === undefined) delete process.env.WAIT_ROUTE_PROBE_NONCE;
      else process.env.WAIT_ROUTE_PROBE_NONCE = originalNonce;
    }
  });
});

test('capture_entry enters before identity inspection and completes the fixture-only hold', async () => {
  await withTempDirectory(async (parent) => {
    const traceDir = join(parent, 'trace');
    const server = createWaitRouteServer({ runDirectory: traceDir, runNonce: HEX_NONCE });
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const client = new Client({ name: 'wait-route-probe-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const startedAt = Date.now();
    const result = await client.callTool({ name: CAPTURE_TOOL_NAME, arguments: {} });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.isError, undefined, 'a healthy capture must not be an error');
    const text = result.content[0].text;
    assert.ok(text.length > 0 && text.length <= 200, 'the normal result text must stay synthetic and bounded');
    assert.ok(elapsedMs >= CAPTURE_HOLD_MS - 250, `the capture must hold for the fixture-only ${CAPTURE_HOLD_MS} ms hold`);
    assert.ok(elapsedMs <= CAPTURE_HOLD_MS + 4000, 'the fixture-only hold must stay short');

    const { records } = await readTraceEvents({ runDirectory: traceDir, runNonce: HEX_NONCE });
    const kinds = records.map((record) => record.kind);
    const enteredAt = kinds.indexOf('handler-entered');
    const identityAt = kinds.indexOf('handler-identity');
    const completedAt = kinds.indexOf('handler-completed');
    assert.ok(enteredAt !== -1, 'handler entry must be captured');
    assert.ok(identityAt > enteredAt, 'identity inspection must happen after entry');
    assert.ok(completedAt > identityAt, 'completion must follow identity');
    await client.close();
  });
});

test('capture entry is recorded before identity even when host metadata is absent or unrecognized', async () => {
  await withTempDirectory(async (parent) => {
    const traceDir = join(parent, 'trace');
    const server = createWaitRouteServer({ runDirectory: traceDir, runNonce: HEX_NONCE });
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const client = new Client({ name: 'wait-route-probe-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    await client.callTool({ name: CAPTURE_TOOL_NAME, arguments: {} });
    // A schema-valid _meta of an unrecognized shape is a host observation the
    // handler must survive; a truly malformed transport payload would be
    // rejected by the SDK below the handler, which is a different boundary.
    const unrecognized = await client.callTool({ name: CAPTURE_TOOL_NAME, arguments: {}, _meta: { unexpected: 'shape' } });
    assert.equal(unrecognized.isError, undefined, 'unrecognized metadata is a host observation, not a handler rejection');
    const { records } = await readTraceEvents({ runDirectory: traceDir, runNonce: HEX_NONCE });
    const entered = records.filter((record) => record.kind === 'handler-entered');
    assert.equal(entered.length, 2, 'each call must enter exactly once');
    for (const record of records.filter((entry) => entry.kind === 'handler-identity')) {
      assert.equal(record.threadHash, null, 'no trusted metadata means no identity hash');
    }
    await client.close();
  });
});

test('server error outcomes are separate from handler entry', async () => {
  await withTempDirectory(async (parent) => {
    const traceDir = join(parent, 'trace');
    const server = createWaitRouteServer({ runDirectory: traceDir, runNonce: HEX_NONCE });
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const client = new Client({ name: 'wait-route-probe-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const unknown = await client.callTool({ name: 'not_a_probe_tool', arguments: {} });
    assert.equal(unknown.isError, true, 'an unknown tool must be an error result');
    const oversized = await client.callTool({ name: 'prepare_dependency', arguments: { label: 'x'.repeat(5000) } });
    assert.equal(oversized.isError, true, 'an oversized dependency label must be rejected');
    const endless = await client.callTool({ name: 'hold_open', arguments: { ms: 3_600_000 } });
    assert.equal(endless.isError, true, 'an unbounded hold request must be rejected');

    const { records } = await readTraceEvents({ runDirectory: traceDir, runNonce: HEX_NONCE });
    assert.equal(records.filter((record) => record.kind === 'handler-entered').length, 0, 'error outcomes never record handler entry');
    assert.equal(records.filter((record) => record.kind === 'dependency-prepared').length, 0, 'rejected dependencies are never prepared');
    await client.close();
  });
});

test('the probe tools are model-hidden through listTools discovery', async () => {
  await withTempDirectory(async (parent) => {
    const traceDir = join(parent, 'trace');
    const server = createWaitRouteServer({ runDirectory: traceDir, runNonce: HEX_NONCE });
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const client = new Client({ name: 'wait-route-probe-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    for (const toolName of [CAPTURE_TOOL_NAME, HOLD_TOOL_NAME, DEPENDENCY_TOOL_NAME]) {
      const tool = tools.find((entry) => entry.name === toolName);
      assert.ok(tool, `${toolName} must be listed`);
      // The official model-hidden hook fixture supplies an empty visibility
      // list (rmcp-client test_stdio_server.rs: `_meta.ui.visibility: []`);
      // without it the host treats the tool as model-visible.
      assert.deepEqual(tool._meta?.ui?.visibility, [], `${toolName} must carry the empty model visibility list`);
    }
    await client.close();
  });
});

test('hold_open rejects invalid durations instead of applying the default', async () => {
  await withTempDirectory(async (parent) => {
    const traceDir = join(parent, 'trace');
    const server = createWaitRouteServer({ runDirectory: traceDir, runNonce: HEX_NONCE });
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const client = new Client({ name: 'wait-route-probe-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    // The MCP layer does not enforce the advertised input schema, so a
    // nonnumeric ms must be rejected by the handler, never defaulted.
    const stringMs = await client.callTool({ name: HOLD_TOOL_NAME, arguments: { ms: '30000' } });
    assert.equal(stringMs.isError, true, 'a string duration must be a tool error');
    const fractionalMs = await client.callTool({ name: HOLD_TOOL_NAME, arguments: { ms: 1500.5 } });
    assert.equal(fractionalMs.isError, true, 'a non-integer duration must be a tool error');
    const nullMs = await client.callTool({ name: HOLD_TOOL_NAME, arguments: { ms: null } });
    assert.equal(nullMs.isError, true, 'a null duration must be a tool error');
    const { records } = await readTraceEvents({ runDirectory: traceDir, runNonce: HEX_NONCE });
    assert.equal(records.filter((record) => record.kind === 'hold-started').length, 0, 'no malformed hold may start');

    // Omission keeps the bounded default: a successful 1000 ms hold.
    const omitted = await client.callTool({ name: HOLD_TOOL_NAME, arguments: {} });
    assert.equal(omitted.isError, undefined, 'an omitted ms keeps the bounded default');
    const { records: after } = await readTraceEvents({ runDirectory: traceDir, runNonce: HEX_NONCE });
    const started = after.filter((record) => record.kind === 'hold-started');
    assert.equal(started.length, 1);
    assert.equal(started[0].holdMs, 1000, 'the default hold is exactly 1000 ms');
    await client.close();
  });
});

test('hold_open settles on its declared deadline exactly once', { timeout: 20_000 }, async () => {
  await withTempDirectory(async (parent) => {
    const traceDir = join(parent, 'trace');
    const server = createWaitRouteServer({ runDirectory: traceDir, runNonce: HEX_NONCE });
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const client = new Client({ name: 'wait-route-probe-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({ name: HOLD_TOOL_NAME, arguments: { ms: 50 } });
    assert.equal(result.isError, undefined, 'a bounded hold must complete normally');
    const { records } = await readTraceEvents({ runDirectory: traceDir, runNonce: HEX_NONCE });
    const started = records.filter((record) => record.kind === 'hold-started');
    const settled = records.filter((record) => record.kind === 'hold-settled');
    assert.equal(started.length, 1, 'exactly one hold started');
    assert.equal(settled.length, 1, 'the hold must settle exactly once');
    assert.equal(settled[0].settlement, 'deadline', 'a hold that runs to its declared deadline settles as deadline');
    assert.equal(settled[0].callNonce, started[0].callNonce, 'the settlement names the started hold');
    // A LATE transport-close settle over the already-settled hold is a no-op:
    // exactly-once holds even when a second settlement path fires afterwards.
    server.waitRouteDisconnect.settlePendingHoldsOnDisconnect();
    const { records: after } = await readTraceEvents({ runDirectory: traceDir, runNonce: HEX_NONCE });
    assert.equal(after.filter((record) => record.kind === 'hold-settled').length, 1,
      'a late disconnect settle must never duplicate the deadline settlement');
    await client.close();
  });
});

test('hold_open settles on the caller abort signal exactly once', { timeout: 20_000 }, async () => {
  await withTempDirectory(async (parent) => {
    const traceDir = join(parent, 'trace');
    const server = createWaitRouteServer({ runDirectory: traceDir, runNonce: HEX_NONCE });
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const client = new Client({ name: 'wait-route-probe-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    // Cancelling the in-flight request forwards the client-side abort to the
    // handler's request signal; the pending hold must settle as signal-abort.
    // The client-side promise rejects on cancellation — the trace is the
    // observation seam, so the rejection is expected and discarded.
    const controller = new AbortController();
    const pending = client.callTool({ name: HOLD_TOOL_NAME, arguments: { ms: 10_000 } }, undefined, { signal: controller.signal });
    pending.catch(() => {});
    let started = false;
    for (let waited = 0; waited < 5_000 && !started; waited += 25) {
      const { records } = await readTraceEvents({ runDirectory: traceDir, runNonce: HEX_NONCE });
      started = records.some((record) => record.kind === 'hold-started');
      if (!started) await sleep(25);
    }
    assert.ok(started, 'the hold must start durably before the abort');
    controller.abort();
    let settlement = null;
    for (let waited = 0; waited < 5_000 && settlement === null; waited += 25) {
      const { records } = await readTraceEvents({ runDirectory: traceDir, runNonce: HEX_NONCE });
      settlement = records.find((record) => record.kind === 'hold-settled') ?? null;
      if (settlement === null) await sleep(25);
    }
    assert.ok(settlement !== null, 'the aborted hold must settle');
    assert.equal(settlement.settlement, 'signal-abort', 'a caller abort settles the hold as signal-abort');
    const { records } = await readTraceEvents({ runDirectory: traceDir, runNonce: HEX_NONCE });
    assert.equal(records.filter((record) => record.kind === 'hold-settled').length, 1,
      'the aborted hold must settle exactly once');
    await client.close();
  });
});

test('a transport close settles the pending hold exactly once as transport-close', { timeout: 20_000 }, async () => {
  await withTempDirectory(async (parent) => {
    const traceDir = join(parent, 'trace');
    const server = createWaitRouteServer({ runDirectory: traceDir, runNonce: HEX_NONCE });
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const client = new Client({ name: 'wait-route-probe-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const pending = client.callTool({ name: HOLD_TOOL_NAME, arguments: { ms: 30_000 } });
    // The hold registers BEFORE its durable start append (a transport close
    // during that append must still settle it), so wait for the observable
    // start event, then fire the disconnect settle — TWICE, to prove the
    // second pass over the same hold cannot duplicate the settlement.
    let started = false;
    for (let waited = 0; waited < 5_000 && !started; waited += 25) {
      const { records } = await readTraceEvents({ runDirectory: traceDir, runNonce: HEX_NONCE });
      started = records.some((record) => record.kind === 'hold-started');
      if (!started) await sleep(25);
    }
    assert.ok(started, 'the hold must start durably before the disconnect');
    server.waitRouteDisconnect.settlePendingHoldsOnDisconnect();
    server.waitRouteDisconnect.settlePendingHoldsOnDisconnect();
    const result = await pending;
    assert.equal(result.isError, undefined, 'a transport-close settlement still completes the tool result');
    const { records } = await readTraceEvents({ runDirectory: traceDir, runNonce: HEX_NONCE });
    const settled = records.filter((record) => record.kind === 'hold-settled');
    assert.equal(settled.length, 1, 'the hold must settle exactly once');
    assert.equal(settled[0].settlement, 'transport-close', 'a transport close settles the hold as transport-close');
    await client.close();
  });
});

test('prepare_dependency records a bounded synthetic invocation dependency', async () => {
  await withTempDirectory(async (parent) => {
    const traceDir = join(parent, 'trace');
    const server = createWaitRouteServer({ runDirectory: traceDir, runNonce: HEX_NONCE });
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const client = new Client({ name: 'wait-route-probe-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({ name: 'prepare_dependency', arguments: { label: 'probe-dependency' } });
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.length <= 200, 'dependency output must stay bounded');
    const { records } = await readTraceEvents({ runDirectory: traceDir, runNonce: HEX_NONCE });
    const prepared = records.filter((record) => record.kind === 'dependency-prepared');
    assert.equal(prepared.length, 1);
    assert.match(prepared[0].labelHash, /^[0-9a-f]{64}$/, 'the label is retained only as a salted hash');
    assert.equal(prepared[0].label, undefined, 'the raw label never reaches the trace');
    await client.close();
  });
});

test('the driver accepts exactly the documented case labels and bounds', async () => {
  await withTempDirectory(async (parent) => {
    assert.deepEqual([...CASE_LABELS], ['shell-window', 'hook-entry', 'authority', 'lifecycle', 'role-control', 'hook-hold']);
    const codex = join(parent, 'codex');
    await writeFile(codex, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const output = await newRunDirectory(parent);
    const parsed = parseDriverArguments(['--case', 'hook-entry', '--codex', codex, '--output-dir', output, '--budget-ms', '60000']);
    assert.equal(parsed.caseLabel, 'hook-entry');
    assert.equal(parsed.budgetMs, 60000);
    for (const argv of [
      ['--case', 'unknown-case', '--codex', codex, '--output-dir', output, '--budget-ms', '60000'],
      ['--case', 'hook-entry', '--codex', 'relative-codex', '--output-dir', output, '--budget-ms', '60000'],
      ['--case', 'hook-entry', '--codex', codex, '--output-dir', 'relative-output', '--budget-ms', '60000'],
      ['--case', 'hook-entry', '--codex', codex, '--output-dir', output, '--budget-ms', '0'],
      ['--case', 'hook-entry', '--codex', codex, '--output-dir', output, '--budget-ms', '1500.5'],
      ['--case', 'hook-entry', '--codex', codex, '--output-dir', output, '--budget-ms', '60000', '--surprise'],
    ]) {
      try {
        parseDriverArguments(argv);
        assert.fail(`expected ${JSON.stringify(argv)} to be rejected`);
      } catch (error) {
        assert.match(String(error.code ?? error.message), /WAIT_ROUTE_DRIVER_/);
      }
    }
  });
});

test('a missing codex binary is an instrument failure, not a host outcome', async () => {
  await withTempDirectory(async (parent) => {
    const output = await newRunDirectory(parent);
    await expectErrorCode(
      runWaitRouteCase({ caseLabel: 'hook-entry', codexPath: join(parent, 'missing-codex'), outputDir: output, budgetMs: 5000 })
        ,
      'WAIT_ROUTE_DRIVER_CODEX_MISSING',
    );
  });
});

test('a binary that prints a non-codex version is an instrument failure', { timeout: 20_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The driver pins the exact --version string as provenance: an executable
    // that reports anything but a codex-cli version is the WRONG binary, an
    // instrument failure before any host stage runs.
    const bogusCodex = join(parent, 'bogus-codex.mjs');
    await writeFile(bogusCodex, [
      `#!${process.execPath}`,
      'process.stdout.write("totally-not-codex 9.9.9\\n");',
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o755 });
    const output = await newRunDirectory(parent);
    await expectErrorCode(
      runWaitRouteCase({ caseLabel: 'hook-entry', codexPath: bogusCodex, outputDir: output, budgetMs: 5_000 }),
      'WAIT_ROUTE_DRIVER_CODEX_VERSION',
    );
  });
});

test('the hook-entry case observes entry and exact owned cleanup against a fake host', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    const fakeCodex = await writeFakeCodex(parent, 'entry');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({ caseLabel: 'hook-entry', codexPath: fakeCodex, outputDir: output, budgetMs: 25_000, sourceCodexHome: sourceHome });
    assert.equal(summary.caseLabel, 'hook-entry');
    assert.equal(summary.outcome, 'entry-observed', JSON.stringify(summary));
    assert.match(summary.codexVersion, /^codex-cli /);
    assert.equal(summary.trace.serverStarted, true);
    assert.equal(summary.trace.handlerEntered, true);
    assert.equal(summary.trace.handlerCompleted, true);
    assert.equal(summary.cleanup.marketplaceRemoved, true);
    assert.equal(summary.cleanup.isolatedHomeRemoved, true);
    assert.equal(summary.cleanup.serverExit, 'verified-exited');
    assert.deepEqual(summary.cleanup.failures, []);
    assert.ok(!summary.hostFlags.includes('--ignore-user-config'), 'positive fixture runs must not skip the fixture config');
    assert.ok(summary.hostFlags.includes('--dangerously-bypass-hook-trust'), 'fixture hooks run under the fixture-local trust bypass');
    // Redaction: the redacted summary never carries the private run path.
    assert.ok(!JSON.stringify(summary).includes(output), 'the summary must be redacted of private paths');
    // Privacy: the trace is RETAINED, so the server's startup identity may
    // only appear in salted-fingerprint form — never the raw kernel string
    // (whose comm can carry the Node installation's user-home path).
    const retainedTrace = await readFile(join(output, 'trace', 'events.jsonl'), 'utf8');
    assert.ok(!retainedTrace.includes('|ppid='), 'the retained trace must never carry a raw startup identity');
    const { records: retainedRecords } = await readTraceEvents({ runDirectory: join(output, 'trace') });
    for (const record of retainedRecords.filter((entry) => entry.kind === 'server-started')) {
      assert.equal(record.identity, undefined, 'the raw startup identity must never reach the trace');
      assert.match(record.identityHash, /^[0-9a-f]{32}$/, 'the startup identity must appear only as a truncated salted fingerprint');
    }
    // The trace file remains as the private ephemeral evidence of this run.
    const traceStats = await lstat(join(output, 'trace', 'events.jsonl'));
    assert.ok(traceStats.isFile(), 'the private trace must remain for the run owner');
  });
});

test('the hook-entry case classifies a host error separately from entry', { timeout: 20_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    const fakeCodex = await writeFakeCodex(parent, 'exec-fail');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({ caseLabel: 'hook-entry', codexPath: fakeCodex, outputDir: output, budgetMs: 20_000, sourceCodexHome: sourceHome });
    assert.equal(summary.outcome, 'host-error');
    assert.equal(summary.stage, 'exec');
    assert.equal(summary.trace.handlerEntered, false, 'a failed host run never claims handler entry');
    assert.equal(summary.cleanup.marketplaceRemoved, true, 'cleanup runs on every exit path');
    assert.equal(summary.cleanup.isolatedHomeRemoved, true);
  });
});

test('a host error after a completed handler still reports the observed entry facts', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The handler completes successfully, then the model turn fails: host
    // failure stays separate from the durable entry evidence in the trace.
    const fakeCodex = await writeFakeCodex(parent, 'entry-then-fail');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({ caseLabel: 'hook-entry', codexPath: fakeCodex, outputDir: output, budgetMs: 25_000, sourceCodexHome: sourceHome });
    assert.equal(summary.outcome, 'host-error');
    assert.equal(summary.reason, 'exec-failed');
    assert.equal(summary.trace.serverStarted, true, 'the durable server start must not be suppressed');
    assert.equal(summary.trace.handlerEntered, true, 'the durable handler entry must not be suppressed');
    assert.equal(summary.trace.handlerCompleted, true, 'the durable handler completion must not be suppressed');
    assert.equal(summary.cleanup.isolatedHomeRemoved, true);
  });
});

test('the hook-hold fixture shapes write the documented hook and descriptor variants', async () => {
  await withTempDirectory(async (parent) => {
    /** A fresh empty output directory for one fixture build. */
    const newOutput = async (name) => {
      const dir = join(parent, name);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      return dir;
    };
    // The 130 s hold shape: the hook calls prompt_hold with the requested ms
    // and its own timeout; the descriptor keeps the server tool timeout.
    const hold = await buildWaitRouteFixture({ outputDir: await newOutput('hold-out'), serverPath: serverModulePath, hookTool: 'prompt_hold', hookTimeoutSec: 200, holdMs: 130_000 });
    const hooksShape = JSON.parse(await readFile(hold.hooksPath, 'utf8'));
    const holdHandler = hooksShape.hooks.UserPromptSubmit[0].hooks[0];
    assert.equal(holdHandler.type, 'mcp_tool');
    assert.equal(holdHandler.server, 'zcode-wait-route-probe');
    assert.equal(holdHandler.tool, 'prompt_hold');
    assert.equal(holdHandler.timeout, 200);
    assert.equal(holdHandler.input.ms, 130_000);
    // The ordering shape: TWO matcher groups on the same event — an instant
    // capture and a delayed publisher — whose dispatches can overlap.
    const ordering = await buildWaitRouteFixture({ outputDir: await newOutput('ordering-out'), serverPath: serverModulePath, orderingHooks: true });
    const orderingGroups = JSON.parse(await readFile(ordering.hooksPath, 'utf8')).hooks.UserPromptSubmit;
    assert.equal(orderingGroups.length, 2);
    assert.equal(orderingGroups[0].hooks[0].tool, 'capture_entry');
    assert.equal(orderingGroups[1].hooks[0].tool, 'prompt_hold');
    // The unavailable-server shape: the descriptor points at a module that
    // cannot exist, so the server never starts.
    const unavailable = await buildWaitRouteFixture({ outputDir: await newOutput('unavailable-out'), serverPath: serverModulePath, serverAvailable: false });
    const descriptor = JSON.parse(await readFile(unavailable.mcpDescriptorPath, 'utf8'));
    const serverArgs = descriptor.mcpServers['zcode-wait-route-probe'].args;
    assert.ok(serverArgs[0].endsWith('.missing'), 'the unavailable shape must reference a nonexistent module');
    // The disabled-hook control: the fixture config turns the hooks feature
    // OFF (the host then retains only builtin hooks and drops plugin hooks).
    const home = join(parent, 'home-disabled');
    await mkdir(home, { recursive: true, mode: 0o700 });
    const disabled = await writeFixtureConfig({ codexHome: home, hooksFeature: false });
    assert.match(await readFile(disabled.configPath, 'utf8'), /hooks = false/);
  });
});

test('the driver accepts the hook-hold case with its shape and bounds', async () => {
  await withTempDirectory(async (parent) => {
    assert.ok(CASE_LABELS.includes('hook-hold'), 'the hook-hold case label is documented');
    const codex = join(parent, 'codex');
    await writeFile(codex, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const output = await newRunDirectory(parent);
    const parsed = parseDriverArguments(['--case', 'hook-hold', '--codex', codex, '--output-dir', output, '--budget-ms', '200000', '--hook-shape', 'hold', '--hook-hold-ms', '130000', '--hook-timeout-sec', '200', '--hook-tool-timeout-sec', '240']);
    assert.equal(parsed.caseLabel, 'hook-hold');
    assert.equal(parsed.hookShape, 'hold');
    assert.equal(parsed.hookHoldMs, 130_000);
    assert.equal(parsed.hookTimeoutSec, 200);
    assert.equal(parsed.hookToolTimeoutSec, 240);
    for (const argv of [
      ['--case', 'hook-hold', '--codex', codex, '--output-dir', output, '--budget-ms', '60000', '--hook-shape', 'surprise'],
      ['--case', 'hook-hold', '--codex', codex, '--output-dir', output, '--budget-ms', '60000', '--hook-hold-ms', '0'],
      ['--case', 'hook-hold', '--codex', codex, '--output-dir', output, '--budget-ms', '60000', '--hook-hold-ms', '500000'],
      ['--case', 'hook-hold', '--codex', codex, '--output-dir', output, '--budget-ms', '60000', '--hook-timeout-sec', '0'],
      ['--case', 'hook-hold', '--codex', codex, '--output-dir', output, '--budget-ms', '60000', '--hook-tool-timeout-sec', '1'],
    ]) {
      try {
        parseDriverArguments(argv);
        assert.fail(`expected ${JSON.stringify(argv)} to be rejected`);
      } catch (error) {
        assert.match(String(error.code ?? error.message), /WAIT_ROUTE_DRIVER_/);
      }
    }
  });
});

test("the server's prompt_hold records bounded hold events and settles exactly once", { timeout: 20_000 }, async () => {
  const traceDirectory = await mkdtemp(join(tmpdir(), 'wrp-prompt-hold-'));
  await chmod(traceDirectory, 0o700);
  const require = createRequire(import.meta.url);
  const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
  const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverModulePath], env: { WAIT_ROUTE_PROBE_TRACE: join(traceDirectory, 'events.jsonl'), WAIT_ROUTE_PROBE_NONCE: HEX_NONCE } });
  const client = new Client({ name: 'prompt-hold-test', version: '0.0.0' });
  try {
    await client.connect(transport);
    // Tool-level failures resolve as isError results (the MCP tool-error
    // shape), never as rejections: bounds fail closed without a hold.
    for (const invalid of [0, 500_000]) {
      const bad = await client.callTool({ name: 'prompt_hold', arguments: { ms: invalid } });
      assert.equal(bad.isError, true, `ms=${invalid} must be a tool error`);
    }
    // A bounded hold settles exactly once through the durable event.
    const result = await client.callTool({ name: 'prompt_hold', arguments: { ms: 400 } });
    assert.notEqual(result.isError, true);
    assert.ok(JSON.stringify(result).includes('WAIT_ROUTE_PROBE_HOOK_HOLD_SETTLED'), 'the settled hold returns its marker');
  } finally {
    await client.close();
  }
  const { records } = await readTraceEvents({ runDirectory: traceDirectory });
  const started = records.filter((record) => record.kind === 'prompt-hold-started');
  const settled = records.filter((record) => record.kind === 'prompt-hold-settled');
  assert.equal(started.length, 1, 'exactly one prompt-hold-started for the valid call');
  assert.equal(settled.length, 1, 'exactly one prompt-hold-settled');
  assert.equal(settled[0].settlement, 'deadline');
  assert.equal(started[0].ms, 400);
  await rm(traceDirectory, { recursive: true, force: true });
});

test('the hook-hold case classifies a trusted hold against a fake host', { timeout: 40_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    const fakeCodex = await writeFakeCodex(parent, 'hook-hold');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({ caseLabel: 'hook-hold', codexPath: fakeCodex, outputDir: output, budgetMs: 35_000, sourceCodexHome: sourceHome, hookShape: 'hold', hookHoldMs: 1_500, hookTimeoutSec: 120 });
    assert.equal(summary.outcome, 'hook-hold-completed', JSON.stringify(summary));
    assert.equal(summary.hook.dispatches, 1, 'exactly one hook dispatch of the hold tool');
    assert.equal(summary.hook.settlement, 'deadline', 'the hold settled at its own declared deadline (the natural full-hold settle)');
    assert.ok(summary.hook.settledAtMs !== null && summary.hook.enteredAtMs !== null, 'both hold stamps recorded');
    assert.ok(summary.hook.effectiveHoldMs >= 1_500, 'the hold lasted at least the requested ms');
    assert.notEqual(summary.hostFlags.includes('--ephemeral'), true, 'the hold case persists rollouts (no ephemeral)');
    assert.ok(summary.hostFlags.includes('--dangerously-bypass-hook-trust'), 'the trusted shape keeps the fixture-local trust bypass');
    assert.equal(summary.cleanup.serverExit, 'verified-exited');
    assert.equal(summary.cleanup.isolatedHomeRemoved, true);
    // Local versus executor-scoped dispatch is OBSERVED, not inferred from
    // the handler label: the fixture server's recorded parent pid IS the
    // (fake) host process that spawned it.
    assert.equal(summary.trace.serverParentOfHost, 'in-host', 'the hook server runs as a direct child of the host process');
    assert.ok(!JSON.stringify(summary).includes(output), 'the summary must be redacted of private paths');
  });
});

test('the hook-hold controls classify without dispatch', { timeout: 60_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    const sourceHome = await newSourceHome(parent);
    for (const [shape, expectedOutcome] of [
      ['disabled', 'hook-control-disabled'],
      ['untrusted', 'hook-control-untrusted'],
      ['unavailable', 'hook-control-server-unavailable'],
    ]) {
      const fakeCodex = await writeFakeCodex(parent, 'hook-plain');
      const shapeParent = join(parent, `shape-${shape}`);
      await mkdir(shapeParent, { recursive: true, mode: 0o700 });
      const output = await newRunDirectory(shapeParent);
      const summary = await runWaitRouteCase({ caseLabel: 'hook-hold', codexPath: fakeCodex, outputDir: output, budgetMs: 30_000, sourceCodexHome: sourceHome, hookShape: shape, hookHoldMs: 1_000, hookTimeoutSec: 30 });
      assert.equal(summary.outcome, expectedOutcome, `${shape}: ${JSON.stringify(summary)}`);
      assert.equal(summary.hook.dispatches, 0, `${shape}: no synthetic work accepted`);
      // The FAKE host never spawns the fixture server at all (only the real
      // host loads the plugin's MCP descriptor), so serverStarted is false in
      // every fixture control; the INSTALLED runs record the real server
      // presence per shape (the report carries those observations).
      assert.equal(summary.trace.serverStarted, false, `${shape}: the fake host starts no server`);
      if (shape === 'untrusted') {
        assert.ok(!summary.hostFlags.includes('--dangerously-bypass-hook-trust'), 'the untrusted control runs WITHOUT the trust bypass');
      }
    }
  });
});

test('the hook-hold timeout shape classifies the hook-budget cut', { timeout: 40_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    const fakeCodex = await writeFakeCodex(parent, 'hook-hold-abandon');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({ caseLabel: 'hook-hold', codexPath: fakeCodex, outputDir: output, budgetMs: 35_000, sourceCodexHome: sourceHome, hookShape: 'timeout', hookHoldMs: 30_000, hookTimeoutSec: 60 });
    assert.equal(summary.outcome, 'hook-timeout-observed', JSON.stringify(summary));
    assert.equal(summary.hook.dispatches, 1, 'the hook dispatched once');
    assert.notEqual(summary.hook.settlement, 'completed', 'an abandoned hold never reports completed');
    assert.ok(summary.hook.effectiveBoundMs !== null && summary.hook.effectiveBoundMs < 30_000, 'the effective bound is recorded and far below the requested hold');
  });
});

test('the hook-hold ordering shape classifies concurrent same-event dispatch', { timeout: 40_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    const fakeCodex = await writeFakeCodex(parent, 'hook-ordering');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({ caseLabel: 'hook-hold', codexPath: fakeCodex, outputDir: output, budgetMs: 35_000, sourceCodexHome: sourceHome, hookShape: 'ordering', hookHoldMs: 2_500, hookTimeoutSec: 120 });
    assert.equal(summary.outcome, 'hook-ordering-concurrent', JSON.stringify(summary));
    assert.equal(summary.hook.dispatches, 1, 'one hold dispatch');
    assert.equal(summary.hook.overlappingDispatches, true, 'the same-event dispatches overlapped in time');
  });
});

test('an install failure is an explicit inconclusive naming the stage', { timeout: 20_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    const fakeCodex = await writeFakeCodex(parent, 'install-fail');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({ caseLabel: 'hook-entry', codexPath: fakeCodex, outputDir: output, budgetMs: 20_000, sourceCodexHome: sourceHome });
    assert.equal(summary.outcome, 'inconclusive');
    assert.equal(summary.reason, 'install-failed');
    assert.equal(summary.cleanup.marketplaceRemoved, true, 'cleanup removes exactly what the partial install added');
  });
});

test('a missing authenticated home is an explicit missing prerequisite', { timeout: 20_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    const fakeCodex = await writeFakeCodex(parent, 'entry');
    const output = await newRunDirectory(parent);
    const emptyHome = join(parent, 'empty-source-home');
    await mkdir(emptyHome, { mode: 0o700 });
    const summary = await runWaitRouteCase({
      caseLabel: 'hook-entry', codexPath: fakeCodex, outputDir: output, budgetMs: 20_000, sourceCodexHome: emptyHome,
    });
    assert.equal(summary.outcome, 'inconclusive');
    assert.equal(summary.reason, 'auth-unavailable');
    assert.equal(summary.cleanup.isolatedHomeRemoved, true, 'even the inconclusive path cleans its isolated home');
  });
});

test('the observation budget bounds the case while cleanup still completes', { timeout: 20_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    const fakeCodex = await writeFakeCodex(parent, 'slow');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({ caseLabel: 'hook-entry', codexPath: fakeCodex, outputDir: output, budgetMs: 2_500, sourceCodexHome: sourceHome });
    assert.equal(summary.outcome, 'budget-exhausted');
    assert.equal(summary.hostExit.state, 'killed');
    assert.equal(summary.cleanup.marketplaceRemoved, true, 'the bounded cleanup still runs');
    assert.equal(summary.cleanup.isolatedHomeRemoved, true);
  });
});

test('the budget kill owns the whole host process group, leaving no orphaned descendant', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    const fakeCodex = await writeFakeCodex(parent, 'slow-group');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({ caseLabel: 'hook-entry', codexPath: fakeCodex, outputDir: output, budgetMs: 2_500, sourceCodexHome: sourceHome });
    assert.equal(summary.outcome, 'budget-exhausted');
    assert.equal(summary.hostExit.state, 'killed');
    const descendantPid = Number(await readFile(join(parent, 'wait-route-descendant.pid'), 'utf8').catch(() => '0'));
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0, 'the fake host must record its descendant pid');
    try {
      assert.equal(await waitUntilSettled(descendantPid, 5_000), true,
        'the group kill must settle the host\'s descendant, not just the direct child');
    } finally {
      try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already settled */ }
    }
    assert.equal(summary.cleanup.isolatedHomeRemoved, true);
  });
});

test('group ownership survives an early host exit: descendants are settled by cleanup', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The host spawns a long-lived descendant inside its own group and exits
    // immediately: the surviving descendant must still be settled.
    const fakeCodex = await writeFakeCodex(parent, 'exit-leave-descendant');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({ caseLabel: 'hook-entry', codexPath: fakeCodex, outputDir: output, budgetMs: 20_000, sourceCodexHome: sourceHome });
    assert.equal(summary.outcome, 'server-not-started', JSON.stringify(summary));
    const descendantPid = Number(await readFile(join(parent, 'wait-route-descendant.pid'), 'utf8').catch(() => '0'));
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0, 'the fake host must record its descendant pid');
    try {
      assert.equal(await waitUntilSettled(descendantPid, 5_000), true,
        'cleanup must settle a descendant that outlived its host leader');
    } finally {
      try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already settled */ }
    }
  });
});

test('the interrupt seam still owns a group whose leader exited early', { timeout: 20_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // A detached leader spawns a descendant, then exits immediately: between
    // leader exit and descendant settlement the group must still be owned.
    const pidFile = join(parent, 'leader-descendant.pid');
    const leaderScript = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const d = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
      "writeFileSync(process.env.WAIT_ROUTE_PID_FILE, String(d.pid));",
      'process.exit(0);',
    ].join('\n');
    const leader = spawn(process.execPath, ['-e', leaderScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, WAIT_ROUTE_PID_FILE: pidFile },
    });
    try {
      registerOwnedChild(leader);
      assert.equal(await waitUntilSettled(leader.pid, 5_000), true, 'the leader must exit early');
      const descendantPid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
      assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0, 'the leader must record its descendant pid');
      let alive = true;
      try { process.kill(descendantPid, 0); } catch { alive = false; }
      assert.ok(alive, 'the descendant must still be alive after the leader exit');
      const lines = [];
      handleDriverSignal('SIGTERM', { exitImpl: () => {}, writeImpl: (line) => lines.push(line) });
      assert.match(lines.join(''), /1 owned process group/, 'the group must still be owned after the leader exit');
      assert.equal(await waitUntilSettled(descendantPid, 5_000), true, 'the interrupt must settle the surviving descendant');
    } finally {
      try { leader.kill('SIGKILL'); } catch { /* already exited */ }
      try {
        const leftoverPid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
        if (leftoverPid > 0) process.kill(leftoverPid, 'SIGKILL');
      } catch { /* already settled */ }
    }
  });
});

test('budget expiry settles the shell worker group the fixture recorded separately', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The real macOS shell shape: the worker runs in its own group/session
    // and the fixture records it. Budget expiry kills the host group; the
    // recorded worker group must be settled too, and the summary must
    // reflect the worker settlement.
    const fakeCodex = await writeFakeCodex(parent, 'slow-detached-worker');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({ caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 2_500, sourceCodexHome: sourceHome });
    assert.equal(summary.outcome, 'budget-exhausted', JSON.stringify(summary));
    const descendantPid = Number(await readFile(join(parent, 'wait-route-descendant.pid'), 'utf8').catch(() => '0'));
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0, 'the fake host must record its worker pid');
    try {
      assert.equal(await waitUntilSettled(descendantPid, 5_000), true,
        'the separately grouped shell worker must be settled with the host');
      assert.equal(summary.cleanup.workerExit, 'terminated',
        'the summary must record the identity-verified worker settlement');
    } finally {
      try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already settled */ }
    }
  });
});

test('the interrupt seam owns the host group and the recorded worker group', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // While both groups are alive — the host leader and the separately
    // grouped worker the fixture recorded — the interrupt seam must report
    // and settle BOTH.
    const fakeCodex = await writeFakeCodex(parent, 'slow-detached-worker');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const casePromise = runWaitRouteCase({ caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 20_000, sourceCodexHome: sourceHome });
    const pidFile = join(parent, 'wait-route-descendant.pid');
    // Wait until the worker is recorded and the driver's poller had time to
    // own its separate group.
    for (let waited = 0; waited < 8000; waited += 250) {
      const recorded = await readFile(pidFile, 'utf8').then(() => true, () => false);
      if (recorded) { await sleep(1500); break; }
      await sleep(250);
    }
    const lines = [];
    handleDriverSignal('SIGINT', { exitImpl: () => {}, writeImpl: (line) => lines.push(line) });
    assert.match(lines.join(''), /2 owned process group/, 'both the host group and the recorded worker group must be owned');
    const summary = await casePromise;
    const descendantPid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
    assert.equal(await waitUntilSettled(descendantPid, 5_000), true, 'the interrupt must settle the recorded worker group');
    assert.equal(summary.cleanup.workerExit, 'verified-exited', 'the worker died with its group: verified exited');
  });
});

test('settled group deadlines never fire again', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // A leader that exits early with a surviving descendant keeps its
    // deadline armed; cleanup settles the group and MUST cancel that timer,
    // because a later fire would signal a possibly recycled group id.
    const fakeCodex = await writeFakeCodex(parent, 'exit-leave-descendant');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const firesBefore = groupDeadlineFireCount();
    const summary = await runWaitRouteCase({ caseLabel: 'hook-entry', codexPath: fakeCodex, outputDir: output, budgetMs: 3_000, sourceCodexHome: sourceHome });
    assert.equal(summary.outcome, 'server-not-started', JSON.stringify(summary));
    const descendantPid = Number(await readFile(join(parent, 'wait-route-descendant.pid'), 'utf8').catch(() => '0'));
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0, 'the fake host must record its descendant pid');
    assert.equal(await waitUntilSettled(descendantPid, 5_000), true, 'cleanup settles the surviving descendant');
    // Outlive the 3-second deadline: a stale, uncancelled timer would fire
    // here and signal the settled group id.
    await sleep(4_000);
    assert.equal(groupDeadlineFireCount(), firesBefore, 'no settled group deadline may fire after cleanup settled it');
  });
});

test('a settled shell worker record never owns its historical group', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // A worker that launches in its own group and exits while the host keeps
    // running leaves a HISTORICAL launch record. That record is not
    // continuing authority to signal a group: every (re-)registration must
    // revalidate that the recorded member pid is still alive AND still
    // belongs to that group. The two appended records pin the post-reuse
    // shape: a dead worker pid naming a live unrelated group (liveness), and
    // a live pid naming a group it does not belong to (membership). Neither
    // may cause a signal; the unrelated holders must survive the interrupt.
    const unrelatedA = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: true });
    const unrelatedB = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: true });
    try {
      const fakeCodex = await writeFakeCodex(parent, 'exit-worker-then-hold');
      const sourceHome = await newSourceHome(parent);
      const output = await newRunDirectory(parent);
      const casePromise = runWaitRouteCase({ caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 20_000, sourceCodexHome: sourceHome });
      const pidFile = join(parent, 'wait-route-descendant.pid');
      for (let waited = 0; waited < 8000; waited += 250) {
        const recorded = await readFile(pidFile, 'utf8').then(() => true, () => false);
        if (recorded) break;
        await sleep(250);
      }
      const workerPid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
      assert.ok(Number.isSafeInteger(workerPid) && workerPid > 0, 'the fake host must record its worker pid');
      assert.equal(await waitUntilSettled(workerPid, 5_000), true, 'the worker must exit while the host continues');
      let aliveA = true;
      try { process.kill(unrelatedA.pid, 0); } catch { aliveA = false; }
      let aliveB = true;
      try { process.kill(unrelatedB.pid, 0); } catch { aliveB = false; }
      assert.ok(aliveA && aliveB, 'the unrelated holders must be alive before the observation');
      // The launch log is the fixture's own record channel; these appended
      // records are exactly what a recycled group id looks like afterwards.
      const launchLog = join(output, 'workspace', 'worker-launches.jsonl');
      await appendFile(launchLog, `${JSON.stringify({ event: 'worker-launched', pid: workerPid, pgid: unrelatedA.pid, sid: null, identity: null })}\n`, 'utf8');
      await appendFile(launchLog, `${JSON.stringify({ event: 'worker-launched', pid: unrelatedA.pid, pgid: unrelatedB.pid, sid: null, identity: null })}\n`, 'utf8');
      // Give the poller several passes over the settled records before the
      // ownership observation.
      await sleep(1_500);
      const lines = [];
      handleDriverSignal('SIGINT', { exitImpl: () => {}, writeImpl: (line) => lines.push(line) });
      assert.match(lines.join(''), /1 owned process group/,
        'only the still-running host group may be settled; the historical records name no live owned group');
      assert.equal(await waitUntilSettled(unrelatedA.pid, 500), false, 'the unrelated holder behind the dead worker pid must never be signaled');
      assert.equal(await waitUntilSettled(unrelatedB.pid, 500), false, 'the unrelated group named behind a non-member pid must never be signaled');
      const summary = await casePromise;
      assert.equal(summary.outcome, 'host-error', JSON.stringify(summary));
    } finally {
      try { unrelatedA.kill('SIGKILL'); } catch { /* already settled */ }
      try { unrelatedB.kill('SIGKILL'); } catch { /* already settled */ }
      await waitUntilSettled(unrelatedA.pid, 5_000);
      await waitUntilSettled(unrelatedB.pid, 5_000);
    }
  });
});

test('a recycled pid+pgid record and an identity-matching foreign record are never owned', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // A detached group leader's pid IS its pgid, so when a recorded worker
    // exits, a NEW detached leader can recycle pid and pgid TOGETHER: the
    // membership revalidation alone then passes on an unrelated process.
    // Ownership therefore requires the recorded IMMUTABLE start identity to
    // match too — AND the trusted launch boundary: the launch log is
    // model-writable, so even a record whose captured start identity matches
    // a live unrelated process (its REAL identity) names a process this run
    // never launched and must never be owned. Two live detached leaders pin
    // both sides: one named by a record whose start time differs (the stale
    // recycled shape), one named by a record whose captured start identity
    // matches the live process exactly (the foreign-but-real shape). NEITHER
    // may be owned or signaled; only the host group is.
    const stale = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: true });
    const control = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: true });
    try {
      const fakeCodex = await writeFakeCodex(parent, 'exit-worker-then-hold');
      const sourceHome = await newSourceHome(parent);
      const output = await newRunDirectory(parent);
      const casePromise = runWaitRouteCase({ caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 20_000, sourceCodexHome: sourceHome });
      const pidFile = join(parent, 'wait-route-descendant.pid');
      for (let waited = 0; waited < 8000; waited += 250) {
        const recorded = await readFile(pidFile, 'utf8').then(() => true, () => false);
        if (recorded) break;
        await sleep(250);
      }
      assert.ok(Number(await readFile(pidFile, 'utf8').catch(() => '0')) > 0, 'the fake host must record its worker pid');
      // The worker exited (the fake host kills it after recording); both
      // live leaders now embody the pid+pgid-recycled shape.
      let staleAlive = true;
      try { process.kill(stale.pid, 0); } catch { staleAlive = false; }
      let controlAlive = true;
      try { process.kill(control.pid, 0); } catch { controlAlive = false; }
      assert.ok(staleAlive && controlAlive, 'both detached leaders must be alive before the observation');
      const launchLog = join(output, 'workspace', 'worker-launches.jsonl');
      // The stale shape: pid+pgid both match the live unrelated leader, but
      // the recorded start time is from a process that no longer exists.
      await appendFile(launchLog, `${JSON.stringify({ event: 'worker-launched', pid: stale.pid, pgid: stale.pid, sid: null, identity: 'Sat Jan  1 00:00:00 2001|ppid=1|comm=node' })}\n`, 'utf8');
      // The positive control: a live leader whose captured start identity
      // matches the running process exactly (Linux records add the jiffy
      // starttime the platform token compares).
      await appendFile(launchLog, `${JSON.stringify({ event: 'worker-launched', pid: control.pid, pgid: control.pid, sid: null, identity: captureProcessIdentity(control.pid), starttime: linuxStarttimeOf(control.pid) })}\n`, 'utf8');
      // Give the poller several passes over both records before observing.
      await sleep(1_500);
      const lines = [];
      handleDriverSignal('SIGINT', { exitImpl: () => {}, writeImpl: (line) => lines.push(line) });
      assert.match(lines.join(''), /1 owned process group/,
        'only the host group may be owned: neither the stale record nor the identity-matching foreign record is launch authority');
      assert.equal(await waitUntilSettled(stale.pid, 500), false,
        'the recycled pid+pgid leader with a different start identity must never be signaled');
      assert.equal(await waitUntilSettled(control.pid, 500), false,
        'the foreign live leader whose real identity matches the record must also never be signaled');
      const summary = await casePromise;
      assert.equal(summary.outcome, 'host-error', JSON.stringify(summary));
    } finally {
      try { stale.kill('SIGKILL'); } catch { /* already settled */ }
      try { control.kill('SIGKILL'); } catch { /* already settled */ }
      await waitUntilSettled(stale.pid, 5_000);
      await waitUntilSettled(control.pid, 5_000);
    }
  });
});

test('a registered worker group is dropped when its evidence stops validating', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // This pins the case the never-registered stale records cannot cover: a
    // group entry the poller REGISTERED (its record validated while the
    // worker lived), after which the worker exits and the group stays alive
    // through an unrelated member. A retained entry whose evidence no longer
    // validates must be dropped — at the poll or at the signaling boundary —
    // so the interrupt can never SIGKILL the group that now only holds
    // unrelated processes.
    const leaderScript = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const d = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
      "writeFileSync(process.env.WAIT_ROUTE_WORKER_PID_FILE, String(d.pid));",
      'setTimeout(() => {}, 60000);',
    ].join('\n');
    const leaderPidFile = join(parent, 'leader.pid');
    const workerPidFile = join(parent, 'worker.pid');
    const leader = spawn(process.execPath, ['-e', leaderScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, WAIT_ROUTE_WORKER_PID_FILE: workerPidFile },
    });
    try {
      const fakeCodex = await writeFakeCodex(parent, 'exit-worker-then-hold');
      const sourceHome = await newSourceHome(parent);
      const output = await newRunDirectory(parent);
      const casePromise = runWaitRouteCase({ caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 20_000, sourceCodexHome: sourceHome });
      // Wait for the fake host's own record, then for the leader's worker.
      for (let waited = 0; waited < 8000; waited += 250) {
        const recorded = await readFile(join(parent, 'wait-route-descendant.pid'), 'utf8').then(() => true, () => false);
        if (recorded) break;
        await sleep(250);
      }
      for (let waited = 0; waited < 8000; waited += 250) {
        const recorded = await readFile(workerPidFile, 'utf8').then(() => true, () => false);
        if (recorded) break;
        await sleep(250);
      }
      const leaderPid = Number(await readFile(leaderPidFile, 'utf8').catch(() => String(leader.pid ?? 0)));
      const workerPid = Number(await readFile(workerPidFile, 'utf8').catch(() => '0'));
      assert.ok(Number.isSafeInteger(leaderPid) && leaderPid > 0, 'the leader must record its pid');
      assert.ok(Number.isSafeInteger(workerPid) && workerPid > 0, 'the leader must record its worker pid');
      assert.equal(await waitUntilSettled(workerPid, 5_000), false, 'the worker must be alive for its record to validate');
      // A validating record: the worker is alive, its identity is real, and
      // its pgid is the leader's group (the worker was spawned non-detached).
      const launchLog = join(output, 'workspace', 'worker-launches.jsonl');
      await appendFile(launchLog, `${JSON.stringify({ event: 'worker-launched', pid: workerPid, pgid: leaderPid, sid: null, identity: captureProcessIdentity(workerPid), starttime: linuxStarttimeOf(workerPid) })}\n`, 'utf8');
      // Let the poller validate and REGISTER the leader's group.
      await sleep(1_500);
      // The worker exits; the group stays alive through the unrelated leader.
      try { process.kill(workerPid, 'SIGKILL'); } catch { /* already gone */ }
      assert.equal(await waitUntilSettled(workerPid, 5_000), true, 'the worker must exit after registration');
      // Let a poll pass over the invalidated evidence before the interrupt.
      await sleep(400);
      const lines = [];
      handleDriverSignal('SIGINT', { exitImpl: () => {}, writeImpl: (line) => lines.push(line) });
      assert.match(lines.join(''), /1 owned process group/,
        'only the still-running host group may be settled; a group whose worker evidence stopped validating is never signaled');
      assert.equal(await waitUntilSettled(leaderPid, 500), false,
        'the unrelated group member holding the recycled-ish group must never be signaled');
      const summary = await casePromise;
      assert.equal(summary.outcome, 'host-error', JSON.stringify(summary));
    } finally {
      try { leader.kill('SIGKILL'); } catch { /* already exited */ }
      const workerPid = Number(await readFile(workerPidFile, 'utf8').catch(() => '0'));
      if (workerPid > 0) { try { process.kill(workerPid, 'SIGKILL'); } catch { /* already gone */ } }
      await waitUntilSettled(leader.pid, 5_000);
    }
  });
});

test('a same-second recycled record with a different executable is never owned', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // lstart has one-second precision: a pid+pgid recycled within the same
    // second reproduces the recorded start TIME. The recorded identity's
    // executable field is the discriminator — a different executable must
    // never be owned even when the start time matches to the second.
    const impersonated = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: true });
    try {
      const fakeCodex = await writeFakeCodex(parent, 'exit-worker-then-hold');
      const sourceHome = await newSourceHome(parent);
      const output = await newRunDirectory(parent);
      const casePromise = runWaitRouteCase({ caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 20_000, sourceCodexHome: sourceHome });
      for (let waited = 0; waited < 8000; waited += 250) {
        const recorded = await readFile(join(parent, 'wait-route-descendant.pid'), 'utf8').then(() => true, () => false);
        if (recorded) break;
        await sleep(250);
      }
      let alive = true;
      try { process.kill(impersonated.pid, 0); } catch { alive = false; }
      assert.ok(alive, 'the impersonated leader must be alive before the observation');
      // A record whose lstart is the live leader's REAL start time (to the
      // second) but whose executable is not the running one.
      const realIdentity = captureProcessIdentity(impersonated.pid);
      assert.ok(realIdentity !== null, 'the live leader identity must be capturable');
      const realLstart = realIdentity.split('|ppid=')[0];
      const launchLog = join(output, 'workspace', 'worker-launches.jsonl');
      await appendFile(launchLog, `${JSON.stringify({ event: 'worker-launched', pid: impersonated.pid, pgid: impersonated.pid, sid: null, identity: `${realLstart}|ppid=1|comm=sh`, starttime: linuxStarttimeOf(impersonated.pid) })}\n`, 'utf8');
      await sleep(1_500);
      const lines = [];
      handleDriverSignal('SIGINT', { exitImpl: () => {}, writeImpl: (line) => lines.push(line) });
      assert.match(lines.join(''), /1 owned process group/,
        'only the still-running host group may be settled; a same-second record naming a different executable is never owned');
      assert.equal(await waitUntilSettled(impersonated.pid, 500), false,
        'the differently-named executable wearing the recorded start time must never be signaled');
      const summary = await casePromise;
      assert.equal(summary.outcome, 'host-error', JSON.stringify(summary));
    } finally {
      try { impersonated.kill('SIGKILL'); } catch { /* already settled */ }
      await waitUntilSettled(impersonated.pid, 5_000);
    }
  });
});

test('expired worker evidence never drops the spawned host registration', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The worker SHARES the host group, so validating its record attaches
    // worker evidence to the already-owned host group. When that evidence
    // expires (the worker exits mid-run), the drop must never remove the
    // spawned-host registration or cancel its deadline: the observation
    // budget must still bound the case, not the worker's lifetime.
    const fakeCodex = await writeFakeCodex(parent, 'exit-shared-worker-then-hold');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({ caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 2_500, sourceCodexHome: sourceHome });
    assert.equal(summary.outcome, 'budget-exhausted', JSON.stringify(summary));
    assert.equal(summary.hostExit.state, 'killed', 'the host must be killed at the budget, not outlive it');
  });
});

test('an interrupt still settles the host after its shared worker expired', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // Same shape as the budget case, observed from the interrupt seam: after
    // the shared worker exits and its evidence expires, the spawned host
    // group must STILL be owned, and the interrupt must settle the host.
    const fakeCodex = await writeFakeCodex(parent, 'exit-shared-worker-then-hold');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const casePromise = runWaitRouteCase({ caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 20_000, sourceCodexHome: sourceHome });
    for (let waited = 0; waited < 8000; waited += 250) {
      const recorded = await readFile(join(parent, 'wait-route-descendant.pid'), 'utf8').then(() => true, () => false);
      if (recorded) break;
      await sleep(250);
    }
    const workerPid = Number(await readFile(join(parent, 'wait-route-descendant.pid'), 'utf8').catch(() => '0'));
    const hostGroupPid = Number(await readFile(join(parent, 'wait-route-hostgroup.pid'), 'utf8').catch(() => '0'));
    assert.ok(Number.isSafeInteger(workerPid) && workerPid > 0, 'the fake host must record its worker pid');
    assert.ok(Number.isSafeInteger(hostGroupPid) && hostGroupPid > 0, 'the fake host must record its own group (host) pid');
    assert.equal(await waitUntilSettled(workerPid, 5_000), true, 'the shared worker must exit mid-run');
    // Let a poll pass over the expired evidence before the interrupt.
    await sleep(400);
    const lines = [];
    handleDriverSignal('SIGINT', { exitImpl: () => {}, writeImpl: (line) => lines.push(line) });
    assert.match(lines.join(''), /1 owned process group/,
      'the spawned host group must still be owned after its attached worker evidence expired');
    assert.equal(await waitUntilSettled(hostGroupPid, 5_000), true, 'the interrupt must settle the still-running host');
    const summary = await casePromise;
    assert.equal(summary.outcome, 'host-error', JSON.stringify(summary));
  });
});

test('a recycled host group whose recorded members vanished is never signaled', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // A spawned host exits with a surviving descendant; that descendant then
    // spawns an UNRECORDED process and exits. Every member the ownership
    // evidence recorded has vanished while an unrecorded one keeps the group
    // alive — the same observable state as a fully recycled group id — so
    // the interrupt must fail closed and never signal it.
    const leaderScript = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const d = spawn(process.execPath, [process.env.WAIT_ROUTE_DESCENDANT_SCRIPT, process.env.WAIT_ROUTE_NEPHEW_FILE], { stdio: 'ignore' });",
      "writeFileSync(process.env.WAIT_ROUTE_DESCENDANT_FILE, String(d.pid));",
      'process.exit(0);',
    ].join('\n');
    const descendantScript = [
      'import { spawn } from "node:child_process";',
      'import { writeFile } from "node:fs/promises";',
      'const nephewPidFile = process.argv[2];',
      'setTimeout(async () => {',
      '  const nephew = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });',
      '  await writeFile(nephewPidFile, String(nephew.pid));',
      '  process.exit(0);',
      '}, 2500);',
    ].join('\n');
    const descendantScriptPath = join(parent, 'wait-route-descendant-script.mjs');
    await writeFile(descendantScriptPath, descendantScript, 'utf8');
    const descendantPidFile = join(parent, 'descendant.pid');
    const nephewPidFile = join(parent, 'nephew.pid');
    const leader = spawn(process.execPath, ['-e', leaderScript], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        WAIT_ROUTE_DESCENDANT_FILE: descendantPidFile,
        WAIT_ROUTE_DESCENDANT_SCRIPT: descendantScriptPath,
        WAIT_ROUTE_NEPHEW_FILE: nephewPidFile,
      },
    });
    let nephewPid = 0;
    try {
      registerOwnedChild(leader);
      for (let waited = 0; waited < 8000; waited += 250) {
        const recorded = await readFile(descendantPidFile, 'utf8').then(() => true, () => false);
        if (recorded) break;
        await sleep(250);
      }
      const descendantPid = Number(await readFile(descendantPidFile, 'utf8').catch(() => '0'));
      assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0, 'the leader must record its descendant pid');
      // The leader exits; ownership evidence re-anchors to the surviving
      // descendant (the only recorded member of the group).
      assert.equal(await waitUntilSettled(leader.pid, 5_000), true, 'the leader must exit early');
      // The descendant spawns the unrecorded nephew, then exits: after this
      // point every RECORDED member is gone while the group stays alive.
      for (let waited = 0; waited < 8000; waited += 250) {
        nephewPid = Number(await readFile(nephewPidFile, 'utf8').catch(() => '0'));
        if (nephewPid > 0) break;
        await sleep(250);
      }
      assert.ok(Number.isSafeInteger(nephewPid) && nephewPid > 0, 'the descendant must spawn the unrecorded nephew');
      assert.equal(await waitUntilSettled(descendantPid, 5_000), true, 'the last recorded member must exit');
      await sleep(400);
      const lines = [];
      handleDriverSignal('SIGINT', { exitImpl: () => {}, writeImpl: (line) => lines.push(line) });
      assert.match(lines.join(''), /0 owned process group/,
        'a group whose every recorded member vanished must fail closed');
      assert.equal(await waitUntilSettled(nephewPid, 500), false,
        'the unrecorded process keeping the group alive must never be signaled');
    } finally {
      try { leader.kill('SIGKILL'); } catch { /* already exited */ }
      const descendantPid = Number(await readFile(descendantPidFile, 'utf8').catch(() => '0'));
      if (descendantPid > 0) { try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already gone */ } }
      if (nephewPid > 0) { try { process.kill(nephewPid, 'SIGKILL'); } catch { /* already gone */ } }
      await waitUntilSettled(leader.pid, 5_000);
    }
  });
});

test('a post-exit surviving member that execs another image stays owned', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // A surviving shell descendant that later `exec`s node keeps its PID,
    // start time, and process group but CHANGES its command name. The
    // exit-time member snapshot was taken while it was still the shell, so
    // the ownership boundary must validate the EXEC-STABLE identity (start
    // time + continuing membership), not the command name — the deadline
    // and the interrupt path must not abandon the legitimate descendant.
    const descendantPidFile = join(parent, 'exec-descendant.pid');
    const leaderScript = [
      "const { spawn } = require('node:child_process');",
      'const { writeFileSync } = require("node:fs");',
      'const shellCommand = `sleep 0.6; exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => {}, 60000)")}`;',
      "const d = spawn('/bin/sh', ['-c', shellCommand], { stdio: 'ignore' });",
      'writeFileSync(process.env.WAIT_ROUTE_DESCENDANT_FILE, String(d.pid));',
      'process.exit(0);',
    ].join('\n');
    const leader = spawn(process.execPath, ['-e', leaderScript], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        WAIT_ROUTE_DESCENDANT_FILE: descendantPidFile,
      },
    });
    let execedDescendantPid = 0;
    try {
      registerOwnedChild(leader);
      for (let waited = 0; waited < 8000; waited += 250) {
        const recorded = await readFile(descendantPidFile, 'utf8').then(() => true, () => false);
        if (recorded) break;
        await sleep(250);
      }
      execedDescendantPid = Number(await readFile(descendantPidFile, 'utf8').catch(() => '0'));
      assert.ok(Number.isSafeInteger(execedDescendantPid) && execedDescendantPid > 0, 'the leader must record its descendant pid');
      // The leader exits; ownership evidence re-anchors to the surviving
      // shell descendant (the only recorded member of the group).
      assert.equal(await waitUntilSettled(leader.pid, 5_000), true, 'the leader must exit early');
      // The shell then EXECs node (~600 ms): same pid, same start time, same
      // group, different command name. Wait well past the exec before
      // exercising the ownership boundary.
      await sleep(1400);
      assert.equal(await waitUntilSettled(execedDescendantPid, 0), false, 'the execed descendant must still be alive');
      const lines = [];
      handleDriverSignal('SIGINT', { exitImpl: () => {}, writeImpl: (line) => lines.push(line) });
      assert.match(lines.join(''), /1 owned process group/,
        'the execed survivor must remain owned across the exec transition');
      assert.equal(await waitUntilSettled(execedDescendantPid, 5_000), true,
        'the interrupt must settle the legitimate execed descendant');
    } finally {
      try { leader.kill('SIGKILL'); } catch { /* already exited */ }
      if (execedDescendantPid > 0) { try { process.kill(execedDescendantPid, 'SIGKILL'); } catch { /* already gone */ } }
      await waitUntilSettled(leader.pid, 5_000);
    }
  });
});

test('the smoke observes the marker written after the host exit', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The host process exits while its stdout pipe is still held open by a
    // short-lived inheritor that prints the fixed marker afterwards. The
    // result must be resolved on exit AND stream closure ('close' semantics)
    // — never a snapshot taken at the exit event — while the deadline still
    // bounds the wait.
    const fakeCodex = await writeFakeCodex(parent, 'exit-before-marker-flush');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({ caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 25_000, sourceCodexHome: sourceHome });
    assert.equal(summary.trace.markerObserved, true, JSON.stringify(summary));
  });
});

test('late overflow output never signals a group whose members stopped validating', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The host exits; its in-group descendant spawns an UNRECORDED nephew
    // (holding the inherited driver stdout) and exits. When the nephew later
    // floods the pipe past the byte limit, the overflow kill targets the
    // host's group id — whose recorded members no longer validate — and must
    // therefore NOT fire: at the committed code the unconditional overflow
    // kill lands on the nephew (the only member of the forgotten group).
    const fakeCodex = await writeFakeCodex(parent, 'overflow-after-host-exit');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    let casePromise = null;
    let nephewPid = 0;
    try {
      casePromise = runWaitRouteCase({ caseLabel: 'hook-entry', codexPath: fakeCodex, outputDir: output, budgetMs: 5_000, sourceCodexHome: sourceHome });
      for (let waited = 0; waited < 8000; waited += 250) {
        const recorded = await readFile(join(parent, 'wait-route-flooder-root.pid'), 'utf8').then(() => true, () => false);
        if (recorded) break;
        await sleep(250);
      }
      const flooderRootPid = Number(await readFile(join(parent, 'wait-route-flooder-root.pid'), 'utf8').catch(() => '0'));
      assert.ok(Number.isSafeInteger(flooderRootPid) && flooderRootPid > 0, 'the fake host must record the flooder root pid');
      for (let waited = 0; waited < 8000; waited += 250) {
        nephewPid = Number(await readFile(join(parent, 'wait-route-nephew.pid'), 'utf8').catch(() => '0'));
        if (nephewPid > 0) break;
        await sleep(250);
      }
      assert.ok(Number.isSafeInteger(nephewPid) && nephewPid > 0, 'the flooder root must record the unrecorded nephew pid');
      // Wait past the nephew's flood (spawned at ~600 ms, flooding at ~1.6 s).
      await sleep(2_500);
      let nephewAlive = true;
      try { process.kill(nephewPid, 0); } catch { nephewAlive = false; }
      assert.equal(nephewAlive, true,
        'the unrecorded nephew holding the recycled-ish group must survive the late overflow');
      const summary = await casePromise;
      // The flood arrives after the observation budget expired: the honest
      // outcome is the OVERFLOW FAILURE — the expiry must never grant a
      // success that hides it — while the discriminator remains the
      // nephew's survival.
      assert.equal(summary.outcome, 'host-error', JSON.stringify(summary));
      assert.equal(summary.reason, 'output-overflow', JSON.stringify(summary));
    } finally {
      // Always drain the case so its cleanup cannot settle other tests'
      // registered groups after this test has finished.
      if (casePromise !== null) await casePromise.catch(() => {});
      if (nephewPid > 0) { try { process.kill(nephewPid, 'SIGKILL'); } catch { /* already gone */ } }
      await waitUntilSettled(nephewPid, 5_000);
    }
  });
});

test('a live spawned handle stays signal authority when the recorded comm changes', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async () => {
    // A launcher executable execs the real CLI: same pid, same start time,
    // DIFFERENT command name. The registered group's leader evidence was
    // captured while the comm was still the launcher's, so a comm-sensitive
    // comparison would reject the still-live owned child and the interrupt
    // would forget it without signaling. The retained live child handle is
    // the signal authority instead.
    const leader = spawn('/bin/sh', ['-c', 'sleep 0.4; exec "$NODE" -e "setTimeout(() => {}, 30000)"'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, NODE: process.execPath },
    });
    try {
      registerOwnedChild(leader);
      // Wait well past the exec: same pid, same start time, comm now the
      // exec'd CLI's instead of the launcher's.
      await sleep(900);
      let alive = true;
      try { process.kill(leader.pid, 0); } catch { alive = false; }
      assert.ok(alive, 'the execed leader must still be alive after the comm change');
      const lines = [];
      handleDriverSignal('SIGTERM', { exitImpl: () => {}, writeImpl: (line) => lines.push(line) });
      assert.match(lines.join(''), /1 owned process group/,
        'the live spawned handle must remain signal authority after the exec comm change');
      assert.equal(await waitUntilSettled(leader.pid, 5_000), true, 'the interrupt must settle the execed leader');
    } finally {
      try { leader.kill('SIGKILL'); } catch { /* already settled */ }
      await waitUntilSettled(leader.pid, 5_000);
    }
  });
});

test('the shell command builder quotes by the injected platform, never the host platform', { timeout: 20_000 }, async () => {
  // The POSIX branch must quote by the INJECTED platform: on a Windows host
  // (simulated here by overriding process.platform before the module import)
  // a 'darwin' call must still emit POSIX single quotes, not delegate to the
  // host's double-quote quoting. The win32 form keeps its call operator, and
  // the DEFAULT-parameter call proves the builder reads process.platform at
  // call time — here the overridden win32 — for its platform.
  const driverUrl = pathToFileURL(fileURLToPath(new URL('../tools/wait-route-probe/driver.mjs', import.meta.url))).href;
  const probe = [
    "Object.defineProperty(process, 'platform', { value: 'win32' });",
    `const { buildShellWorkerCommand } = await import(${JSON.stringify(driverUrl)});`,
    'process.stdout.write(JSON.stringify({',
    "  posix: buildShellWorkerCommand('/bin/Node', '/tmp/w/wait-route-worker.mjs', 'darwin'),",
    '  win32: buildShellWorkerCommand("C:\\\\n\\\\node.exe", "C:\\\\w\\\\worker.mjs", "win32"),',
    "  defaulted: buildShellWorkerCommand('/bin/Node', '/tmp/w/wait-route-worker.mjs'),",
    '}));',
  ].join('\n');
  const ran = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  const parsed = JSON.parse(ran.stdout);
  assert.equal(parsed.posix, `'/bin/Node' '/tmp/w/wait-route-worker.mjs'`,
    'the POSIX form must be quoted by the injected platform, not the host platform');
  assert.equal(parsed.win32, `& 'C:\\n\\node.exe' 'C:\\w\\worker.mjs'`,
    'the win32 form must keep the PowerShell call operator');
  assert.equal(parsed.defaulted, `& '/bin/Node' '/tmp/w/wait-route-worker.mjs'`,
    'the default-parameter path must quote by the (overridden) host platform read at call time');
});

test('an early exit during the setup delay returns a bounded result', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The child exits immediately while the simulated slow setup (300 ms)
    // is still running: the child callbacks (close/exit/error) fire BEFORE
    // the deadline timer is armed. Early exit or spawn error during setup
    // must produce the normal bounded result - never an uncaught
    // ReferenceError from a not-yet-initialized timer handle.
    const childScriptPath = join(parent, 'wait-route-early-exit-child.mjs');
    await writeFile(childScriptPath, 'process.exit(0);\n', 'utf8');
    const result = await runBoundedSubprocess(process.execPath, [childScriptPath], {
      cwd: parent,
      env: process.env,
      deadlineMs: 100,
      setupDelayMs: 300,
      stdoutMaxBytes: 64 * 1024,
    });
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.timedOut, false, JSON.stringify(result));
    assert.ok(result.deadlineAtMs <= Date.now(), 'the absolute deadline was computed before the setup');
  });
});

test('stale overflow output never signals a replacement registration', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The child exits childless (its group entry is forgotten) while a
    // DETACHED flooder keeps the retained stdout pipe and floods it past
    // the limit. A replacement registration over the recycled group id is
    // not authority for that stale output: the overflow kill must never
    // fire for it.
    const childScriptPath = join(parent, 'wait-route-stale-overflow-child.mjs');
    await writeFile(childScriptPath, [
      "import { spawn } from 'node:child_process';",
      "import { writeFile } from 'node:fs/promises';",
      "const flooder = spawn(process.execPath, ['-e', 'const chunk = Buffer.alloc(8192, 120); setTimeout(() => { for (let i = 0; i < 2; i += 1) { process.stdout.write(chunk); } }, 600); setTimeout(() => {}, 20000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
      "await writeFile(process.argv[2], String(flooder.pid));",
      "await writeFile(process.argv[3], String(process.pid));",
      'setTimeout(() => process.exit(0), 40);',
    ].join('\n'), 'utf8');
    const flooderPidFile = join(parent, 'wait-route-flooder.pid');
    const childPidFile = join(parent, 'wait-route-child.pid');
    // SANCTIONED KILL-OBSERVATION SEAM: kill delivery has no exported
    // observable (the driver signals real pids and real groups), so wrapping
    // process.kill here — strictly pass-through, recording only — is the
    // sanctioned way to observe that NO kill was delivered. It never fakes,
    // blocks, or replays a signal.
    const origKill = process.kill;
    const kills = [];
    process.kill = (pid, signal) => { kills.push([pid, signal]); return origKill(pid, signal); };
    let result = null;
    let resultPromise = null;
    let flooderPid = 0;
    try {
      resultPromise = runBoundedSubprocess(process.execPath, [childScriptPath, flooderPidFile, childPidFile], {
        cwd: parent,
        env: process.env,
        deadlineMs: 15_000,
        stdoutMaxBytes: 4 * 1024,
      });
      for (let waited = 0; waited < 8000; waited += 100) {
        const recorded = await readFile(flooderPidFile, 'utf8').then(() => true, () => false);
        if (recorded) break;
        await sleep(100);
      }
      const childPid = Number(await readFile(childPidFile, 'utf8').catch(() => '0'));
      flooderPid = Number(await readFile(flooderPidFile, 'utf8').catch(() => '0'));
      assert.ok(Number.isSafeInteger(flooderPid) && flooderPid > 0, 'the child must record the flooder pid');
      // The child exits childless (the detached flooder is not a group
      // member): the group entry is forgotten. Simulate the pid-reused-by-
      // a-later-subprocess registration over the recycled group id.
      // The replacement reuses the FORGOTTEN registration's pid (the child's).
      const replacement = { pid: childPid, exitCode: null, signalCode: null, once: () => {}, kill: () => true };
      registerOwnedChild(replacement);
      // Wait past the flood (~600 ms after the child spawned the flooder).
      await sleep(1_500);
      result = await resultPromise;
      const floodKills = kills.filter(([pid, signal]) => pid === -childPid && signal === 'SIGKILL');
      assert.equal(floodKills.length, 0,
        'stale output must never deliver a SIGKILL for a replacement registration');
      let replacementAlive = true;
      try { process.kill(flooderPid, 0); } catch { replacementAlive = false; }
      assert.equal(replacementAlive, true, 'the replacement must survive the stale overflow');
      assert.equal(result.overflow, true, 'the flood must be observed as overflow evidence');
    } finally {
      process.kill = origKill;
      if (result !== null) await resultPromise.catch(() => {});
      try { process.kill(flooderPid, 'SIGKILL'); } catch { /* already gone */ }
      await waitUntilSettled(flooderPid, 5_000);
    }
  });
});

test('the forced drain records budget expiry when setup outlasts deadline plus grace', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // Setup (4.6 s) outlasts deadline plus drain grace (0.1 s + 4 s): the
    // forced drain resolves the observation BEFORE the deadline timer is
    // armed. The drain must record the expired budget itself - the
    // sleeping child stays alive and is cleaned up by the caller.
    const childScriptPath = join(parent, 'wait-route-slow-setup-child.mjs');
    await writeFile(childScriptPath, 'setTimeout(() => {}, 20000);\n', 'utf8');
    const startedAt = Date.now();
    const result = await runBoundedSubprocess(process.execPath, [childScriptPath], {
      cwd: parent,
      env: process.env,
      deadlineMs: 100,
      setupDelayMs: 4_600,
      stdoutMaxBytes: 64 * 1024,
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(result.timedOut, true, 'the forced drain resolved past the absolute deadline: expiry recorded');
    assert.ok(elapsed >= 4_400, `the forced drain must bound the wait at deadline+grace, got ${elapsed} ms`);
    assert.equal(result.child.exitCode, null, 'the sleeping child remains alive at the forced drain');
    try { process.kill(result.child.pid, 'SIGKILL'); } catch { /* already gone */ }
    await waitUntilSettled(result.child.pid, 5_000);
  });
});

test('a completion landing after the absolute deadline is recorded as expiry at settle time', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // Output and stream closure land at ~250 ms - after the 100 ms
    // absolute deadline but BEFORE the delayed timer is armed (the
    // simulated slow setup delays arming). The settle path must compare
    // the completion time with the deadline and record expiry, even
    // though the timer never fired in the open.
    const childScriptPath = join(parent, 'wait-route-late-settle-child.mjs');
    await writeFile(childScriptPath, [
      "import { spawn } from 'node:child_process';",
      "const writer = spawn(process.execPath, ['-e', 'setTimeout(() => { process.stdout.write(JSON.stringify({ final: process.argv[1] }) + String.fromCharCode(10)); }, 200); setTimeout(() => {}, 250);', 'WAIT_ROUTE_PROBE_WORKER_DONE'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
      'setTimeout(() => process.exit(0), 20);',
    ].join('\n'), 'utf8');
    const result = await runBoundedSubprocess(process.execPath, [childScriptPath], {
      cwd: parent,
      env: process.env,
      deadlineMs: 100,
      setupDelayMs: 500,
      stdoutMaxBytes: 64 * 1024,
      markerText: COMPLETION_MARKER,
    });
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.timedOut, true,
      'the observation completed after the absolute deadline: expiry recorded at settle time');
    assert.ok(result.markerAtMs !== null && result.markerAtMs > result.deadlineAtMs,
      'the post-budget marker stays recorded as evidence');
  });
});

test('worker launch log reads are byte-bounded and report truncation', { timeout: 30_000 }, async () => {
  await withTempDirectory(async (parent) => {
    // Model-writable workspace file: an oversized single record and an
    // oversized total log must both stop the reader at its bounds, return
    // the bounded prefix and REPORT truncation - never load the whole
    // file into memory.
    const oversizedRecord = JSON.stringify({ event: 'worker-launched', pid: 1, pgid: 1, sid: null, identity: 'x'.repeat(96 * 1024) });
    await writeFile(join(parent, 'oversized-record.jsonl'), oversizedRecord + '\n', 'utf8');
    const oversizedRead = await readWorkerLaunchRecords(join(parent, 'oversized-record.jsonl'));
    assert.equal(oversizedRead.truncated, true, 'an oversized single record must be reported as truncation');
    assert.equal(oversizedRead.records.length, 0, 'an oversized record must never be returned as evidence');
    const manyLines = [];
    for (let index = 0; index < 200; index += 1) {
      manyLines.push(JSON.stringify({ event: 'worker-launched', pid: index + 1, pgid: index + 1, sid: null, identity: 'y'.repeat(12 * 1024) }));
    }
    await writeFile(join(parent, 'oversized-total.jsonl'), manyLines.join('\n') + '\n', 'utf8');
    const totalRead = await readWorkerLaunchRecords(join(parent, 'oversized-total.jsonl'));
    assert.equal(totalRead.truncated, true, 'a log beyond the total byte budget must be reported as truncation');
    assert.ok(totalRead.records.length < 200 && totalRead.records.length >= 1,
      'the bounded prefix must be returned, not the whole log');
    for (const record of totalRead.records) {
      assert.match(String(record.identity), /^y+$/, 'returned records must be complete in-bound records');
    }
  });
});

test('invalid worker launch records fail closed as incomplete evidence', async () => {
  await withTempDirectory(async (parent) => {
    // The launch log is a model-writable workspace file: malformed JSON and
    // non-launch objects must never count as complete execution evidence.
    // A torn trailing record means the log itself is incomplete, and an
    // empty object is not a launch.
    const valid = JSON.stringify({ event: 'worker-launched', pid: 42, pgid: 42, sid: 42, identity: 'lstart=x|comm=node' });
    await writeFile(join(parent, 'torn.jsonl'), `${valid}\n{"event":"worker-l`, 'utf8');
    const tornRead = await readWorkerLaunchRecords(join(parent, 'torn.jsonl'));
    assert.equal(tornRead.records.length, 1, 'the valid record must still be returned');
    assert.equal(tornRead.truncated, false, 'a torn trailing record is not a byte-bound truncation');
    assert.equal(tornRead.incomplete, true, 'a torn record must mark the log as incomplete evidence');
    await writeFile(join(parent, 'empty-object.jsonl'), '{}\n', 'utf8');
    const emptyRead = await readWorkerLaunchRecords(join(parent, 'empty-object.jsonl'));
    assert.equal(emptyRead.records.length, 0, 'a non-launch object must never be returned as evidence');
    assert.equal(emptyRead.incomplete, true, 'a non-launch object must mark the log as incomplete evidence');
    await writeFile(join(parent, 'null-record.jsonl'), `${valid}\nnull\n`, 'utf8');
    const nullRead = await readWorkerLaunchRecords(join(parent, 'null-record.jsonl'));
    assert.equal(nullRead.records.length, 1, 'the valid record must still be returned');
    assert.equal(nullRead.incomplete, true, 'a JSON null record must mark the log as incomplete evidence');
  });
});

test('a launch log ending exactly at the record cap is complete, never truncated', async () => {
  await withTempDirectory(async (parent) => {
    // 64 = the driver's MAXIMUM_WORKER_LAUNCH_RECORDS. A log that ends
    // EXACTLY at the record cap carries every record it claims: reporting
    // truncation there would be a false alarm. Truncation is honest only
    // when MORE content actually follows the capped record.
    const record = (pid) => JSON.stringify({ event: 'worker-launched', pid, pgid: pid, sid: pid, identity: 'lstart=x|comm=node' });
    const lines = Array.from({ length: 64 }, (_, index) => record(index + 1));
    await writeFile(join(parent, 'exactly-at-cap.jsonl'), `${lines.join('\n')}\n`, 'utf8');
    const atCap = await readWorkerLaunchRecords(join(parent, 'exactly-at-cap.jsonl'));
    assert.equal(atCap.records.length, 64, 'every record up to the cap must be returned');
    assert.equal(atCap.truncated, false, 'a log ending exactly at the cap must NOT be reported as truncated');
    assert.equal(atCap.incomplete, false, 'a cap-length log of valid records is complete evidence');
    // The honest positive control: a record BEYOND the cap still reports
    // truncation and keeps only the bounded prefix.
    await writeFile(join(parent, 'beyond-cap.jsonl'), `${lines.join('\n')}\n${record(65)}\n`, 'utf8');
    const beyond = await readWorkerLaunchRecords(join(parent, 'beyond-cap.jsonl'));
    assert.equal(beyond.records.length, 64, 'the bounded prefix stops at the cap');
    assert.equal(beyond.truncated, true, 'a record beyond the cap must be reported as truncation');
  });
});

test('a torn-only launch log settles as unresolved, never not-started', async () => {
  await withTempDirectory(async (parent) => {
    // A log whose ONLY content is malformed-but-nonzero cannot prove that
    // zero launches happened: the honest settlement fails closed as
    // `unresolved` instead of the clean `not-started`.
    const log = join(parent, 'worker-launches.jsonl');
    await writeFile(log, '{"event":"worker-l', 'utf8');
    const result = await settleWorkerExits(log, Date.now() + 5_000, null);
    assert.equal(result, 'unresolved', 'a torn-only log must settle as unresolved');
  });
});

test('a non-regular launch log fails closed instead of blocking', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The launch log lives in the model-writable workspace: if it is
    // replaced by a FIFO, opening or reading it could block forever and the
    // case would never reach its cleanup despite --budget-ms. The reader
    // must validate regular-file inputs BEFORE any potentially blocking
    // operation and report the hostile log as incomplete evidence. The
    // reader runs in a CHILD PROCESS because a regressed implementation
    // would block the child's event loop forever — the parent must stay
    // immune, and the child's bounded timeout IS the RED signal.
    const fifoPath = join(parent, 'worker-launches.jsonl');
    const mkfifo = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
    if (mkfifo.status !== 0) {
      t.skip('mkfifo is unavailable on this host');
      return;
    }
    const childScript = [
      'import { readWorkerLaunchRecords } from ' + JSON.stringify(pathToFileURL(join(process.cwd(), 'tools/wait-route-probe/driver.mjs')).href) + ';',
      'const result = await readWorkerLaunchRecords(process.argv[1]);',
      'process.stdout.write(JSON.stringify(result));',
      'process.exit(0);',
    ].join('\n');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', childScript, fifoPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 8_000,
      killSignal: 'SIGKILL',
    });
    assert.equal(child.signal, null,
      'the reader must not block on a FIFO launch log (child killed at the bounded timeout = RED)');
    const result = JSON.parse(child.stdout);
    assert.deepEqual(result, { records: [], truncated: false, incomplete: true },
      'a non-regular launch log is incomplete evidence, never execution proof');
  });
});

test('an async spawn error during the setup delay returns the bounded failure', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // A shebang naming a nonexistent interpreter makes the spawn emit its
    // error ASYNCHRONOUSLY (ENOENT) while the slow-setup delay is still
    // pending: the rejection must be observed at creation so the process
    // survives and the bounded failure surfaces.
    // A nonexistent binary makes child_process report the spawn failure
    // ASYNCHRONOUSLY (the 'error' event), which rejects the exit promise
    // while the slow-setup delay is still pending.
    const missingBinary = join(parent, 'wait-route-nonexistent-binary');
    await expectErrorCode(runBoundedSubprocess(missingBinary, [], {
      cwd: parent,
      env: process.env,
      deadlineMs: 5_000,
      setupDelayMs: 500,
      stdoutMaxBytes: 64 * 1024,
    }), 'WAIT_ROUTE_DRIVER_SPAWN_FAILED');
  });
});

test('worker discovery keeps polling through the drain window', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // A DETACHED separately-grouped worker writes its launch record at
    // ~600 ms while the host is STILL ALIVE (the trusted launch boundary:
    // ancestry must reach the live host pid) and the host exits at
    // ~1400 ms. Discovery polling must still be running then — a SIGINT
    // seam call in that window reports the worker as owned and settles it.
    const fakeCodex = await writeFakeCodex(parent, 'late-record-worker');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const casePromise = runWaitRouteCase({ caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 5_000, sourceCodexHome: sourceHome });
    let workerPid = 0;
    for (let waited = 0; waited < 8000 && workerPid === 0; waited += 100) {
      workerPid = Number(await readFile(join(parent, 'wait-route-worker.pid'), 'utf8').catch(() => '0'));
      if (workerPid === 0) await sleep(100);
    }
    assert.ok(Number.isSafeInteger(workerPid) && workerPid > 0, 'the fake host must record the worker pid');
    // The late record lands at ~600 ms (host alive — the trusted launch
    // boundary verifies the claimed host ancestry); the SIGINT seam call at
    // ~1.2 s is still while the host lives (it exits at ~1.4 s), so BOTH
    // owned groups settle: the host group AND the late worker's own group.
    await sleep(1_200);
    const lines = [];
    handleDriverSignal('SIGINT', { exitImpl: () => {}, writeImpl: (line) => lines.push(line) });
    assert.match(lines.join(''), /2 owned process group/,
      'discovery polling must still be running in the drain window: the late worker is owned beside the host');
    assert.equal(await waitUntilSettled(workerPid, 5_000), true, 'the SIGINT must settle the late-discovered worker');
    const summary = await casePromise;
    assert.ok(summary.trace.workerLaunches >= 1, JSON.stringify(summary));
  });
});

test('a forged launch record naming an unrelated process never grants signal authority', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The launch log is MODEL-WRITABLE: a record can name an UNRELATED live
    // process with its REAL pid, pgid, and start identity. Identity matching
    // alone only prevents stale-pid mistakes — the trusted launch boundary
    // (the recorded process's ancestry must reach the spawned host) is what
    // refuses the forgery. The unrelated victim must survive the whole case
    // including cleanup, and cleanup must report it unresolved.
    const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    let casePromise = null;
    try {
      assert.ok(victim.pid > 0, 'the unrelated victim must be spawned');
      await writeFile(join(parent, 'wait-route-victim.pid'), String(victim.pid), 'utf8');
      const fakeCodex = await writeFakeCodex(parent, 'forged-record');
      const sourceHome = await newSourceHome(parent);
      const output = await newRunDirectory(parent);
      casePromise = runWaitRouteCase({ caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 25_000, sourceCodexHome: sourceHome });
      const summary = await casePromise;
      casePromise = null;
      let victimAlive = true;
      try { process.kill(victim.pid, 0); } catch { victimAlive = false; }
      assert.equal(victimAlive, true, 'the unrelated victim must survive the forged record — cleanup must never signal it');
      assert.equal(summary.cleanup.workerExit, 'unresolved',
        'a forged record must never settle: the driver cannot own what it did not launch');
      // The smoke grant corroborates execution through OWNERSHIP, not the
      // model-writable log: an unowned shape-valid record + marker can
      // never qualify the smoke.
      assert.notEqual(summary.outcome, 'shell-smoke-completed',
        'a forged record must never qualify the smoke');
      assert.equal(summary.outcome, 'inconclusive');
      assert.equal(summary.reason, 'worker-launch-evidence-missing');
    } finally {
      if (casePromise !== null) await casePromise.catch(() => {});
      try { victim.kill('SIGKILL'); } catch { /* already gone */ }
      await waitUntilSettled(victim.pid, 5_000);
    }
  });
});

test('a rewritten launch record never replaces retained ownership evidence', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The reviewer's exact hole: a registered worker exits, its group id is
    // then held by an UNRELATED replacement, and a REWRITTEN launch-log
    // record names that replacement with its REAL current identity. Under
    // the committed code the already-owned path re-set the entry's evidence
    // from the incoming record, promoting the unrelated replacement to
    // signal authority. The retained evidence is the ONLY worker-record
    // authority: incoming records are validated against it (and the entry
    // dropped when it stopped validating), never substituted.
    const workerPidFile = join(parent, 'wait-route-unit-worker.pid');
    const hostScript = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const w = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });",
      "writeFileSync(process.env.WORKER_PID_FILE, String(w.pid));",
      'setTimeout(() => {}, 60000);',
    ].join('\n');
    const host = spawn(process.execPath, ['-e', hostScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, WORKER_PID_FILE: workerPidFile },
    });
    let worker = null;
    let replacement = null;
    try {
      registerOwnedChild(host);
      for (let waited = 0; waited < 8000; waited += 100) {
        const recorded = Number(await readFile(workerPidFile, 'utf8').catch(() => '0'));
        if (recorded > 0) { worker = { pid: recorded }; break; }
        await sleep(100);
      }
      assert.ok(worker !== null && worker.pid > 0, 'the host must spawn the worker');
      // The worker's live ppid IS the host: the chain reaches the owned,
      // still-living host, so the trusted boundary owns it.
      const workerRecord = {
        event: 'worker-launched',
        pid: worker.pid,
        pgid: worker.pid,
        sid: null,
        identity: captureProcessIdentity(worker.pid),
        starttime: linuxStarttimeOf(worker.pid),
      };
      assert.ok(typeof workerRecord.identity === 'string', 'the live worker identity must be capturable');
      ownRecordedWorkerGroups([workerRecord], { trustedHostPid: host.pid });
      assert.ok(ownedGroupsSnapshot().has(worker.pid), 'the chain-verified worker must be owned');
      // The worker exits; its group id is then held by the unrelated
      // replacement (the pid+pgid-recycle shape).
      process.kill(worker.pid, 'SIGKILL');
      await waitUntilSettled(worker.pid, 5_000);
      replacement = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
      // The rewritten log: the replacement's REAL current identity.
      const rewritten = {
        event: 'worker-launched',
        pid: replacement.pid,
        pgid: replacement.pid,
        sid: null,
        identity: String(captureProcessIdentity(replacement.pid)),
        starttime: linuxStarttimeOf(replacement.pid),
      };
      // A MAINTENANCE-ONLY read (post-exec facts/cleanup pass no boundary):
      // it must revalidate the retained evidence — which no longer
      // validates (the worker exited) — and drop the entry, never replace
      // it with the incoming record.
      ownRecordedWorkerGroups([rewritten], {});
      const summaryLines = [];
      handleDriverSignal('SIGINT', { exitImpl: () => {}, writeImpl: (line) => summaryLines.push(line) });
      const ownedCount = Number((summaryLines.join('').match(/(\d+) owned process group/) ?? [])[1] ?? '-1');
      assert.equal(ownedCount, 1,
        'only the host group remains owned: the dropped worker entry must not be resurrected by the rewritten record');
      let replacementAlive = true;
      try { process.kill(replacement.pid, 0); } catch { replacementAlive = false; }
      assert.equal(replacementAlive, true, 'the unrelated replacement must never be signaled from a rewritten record');
    } finally {
      try { host.kill('SIGKILL'); } catch { /* already gone */ }
      if (worker !== null) { try { process.kill(worker.pid, 'SIGKILL'); } catch { /* already gone */ } }
      if (replacement !== null) { try { replacement.kill('SIGKILL'); } catch { /* already gone */ } }
      await waitUntilSettled(host.pid, 5_000);
    }
  });
});

test('a forged host-group pgid with a phantom pid never qualifies the smoke', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The pgid-forgery shape: a record claiming THIS HOST's own group for a
    // pid that never existed. The host pid alone is not launch authority —
    // only the poll attestation (a live, in-group, identity-matching
    // process) corroborates a host-group worker.
    const fakeCodex = await writeFakeCodex(parent, 'phantom-host-group-record');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({ caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 25_000, sourceCodexHome: sourceHome });
    assert.notEqual(summary.outcome, 'shell-smoke-completed',
      'a forged host-group pgid must never qualify the smoke');
    assert.equal(summary.outcome, 'inconclusive');
    assert.equal(summary.reason, 'worker-launch-evidence-missing');
  });
});

test('a naturally exiting separately-grouped worker still completes the smoke', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // A REAL separately-grouped worker is owned at the poll and completes
    // NATURALLY in-budget: the launch attestation must preserve provenance
    // across the natural exit — the smoke completes with workerExit
    // verified-exited, not inconclusive/unresolved.
    const fakeCodex = await writeFakeCodex(parent, 'normal-exit-worker');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({ caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 25_000, sourceCodexHome: sourceHome });
    assert.equal(summary.trace.workerLaunches, 1, JSON.stringify(summary));
    assert.equal(summary.outcome, 'shell-smoke-completed', JSON.stringify(summary));
    assert.equal(summary.cleanup.workerExit, 'verified-exited', JSON.stringify(summary));
  });
});

test('a launcher-intermediary ancestry chain still earns the worker ownership', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The npm launcher shape: host -> intermediate (the CLI) -> detached
    // separately-grouped worker. The worker's DIRECT parent is the
    // intermediate, not the host pid; the trusted boundary must verify the
    // whole ancestry chain while the host lives, so the worker is owned,
    // interrupted, and settled like a direct child.
    const fakeCodex = await writeFakeCodex(parent, 'intermediary-worker');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    let workerPid = 0;
    const casePromise = runWaitRouteCase({ caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 25_000, sourceCodexHome: sourceHome });
    for (let waited = 0; waited < 8000 && workerPid === 0; waited += 100) {
      workerPid = Number(await readFile(join(parent, 'wait-route-inter-worker.pid'), 'utf8').catch(() => '0'));
      if (workerPid === 0) await sleep(100);
    }
    assert.ok(Number.isSafeInteger(workerPid) && workerPid > 0, 'the intermediate must record the worker pid');
    // While the host is alive (~1.2 s), the chain-verified worker is owned:
    // a SIGINT seam call settles it beside the host group.
    await sleep(900);
    const lines = [];
    handleDriverSignal('SIGINT', { exitImpl: () => {}, writeImpl: (line) => lines.push(line) });
    assert.match(lines.join(''), /2 owned process group/,
      'the chain-verified intermediary worker is owned beside the host');
    assert.equal(await waitUntilSettled(workerPid, 5_000), true, 'the SIGINT must settle the chain-verified worker');
    const summary = await casePromise;
    assert.ok(summary.trace.workerLaunches >= 1, JSON.stringify(summary));
  });
});

test('a phantom-pid launch record never qualifies the smoke', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // A shape-valid record naming a pid that NEVER existed plus the marker
    // is pure fabrication: exit status alone is not launch provenance, and
    // `verified-exited` must require trusted ownership — the smoke must
    // refuse it.
    const fakeCodex = await writeFakeCodex(parent, 'phantom-record');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({ caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 25_000, sourceCodexHome: sourceHome });
    assert.notEqual(summary.outcome, 'shell-smoke-completed',
      'a phantom-pid record must never qualify the smoke');
    assert.equal(summary.outcome, 'inconclusive');
    assert.equal(summary.reason, 'worker-launch-evidence-missing');
  });
});

test('an attested pid plus a rewritten live record never signals a recycled group', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The reviewer's P1 shape: a worker is ATTESTED through the trusted
    // boundary, exits, and its pid is recycled by an unrelated live group
    // leader; a REWRITTEN record then names that pid with the
    // replacement's real identity and group. The attestation credits exit
    // STATUS only — signaling requires the RETAINED owned entry, which the
    // rewrite can never supply. The unrelated leader must survive.
    const workerPidFile = join(parent, 'wait-route-attest-worker.pid');
    const hostScript = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const w = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });",
      "writeFileSync(process.env.WORKER_PID_FILE, String(w.pid));",
      'setTimeout(() => {}, 60000);',
    ].join('\n');
    const host = spawn(process.execPath, ['-e', hostScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, WORKER_PID_FILE: workerPidFile },
    });
    let workerPid = 0;
    let unrelated = null;
    try {
      registerOwnedChild(host);
      for (let waited = 0; waited < 8000 && workerPid === 0; waited += 100) {
        workerPid = Number(await readFile(workerPidFile, 'utf8').catch(() => '0'));
        if (workerPid === 0) await sleep(100);
      }
      assert.ok(workerPid > 0, 'the host must spawn the worker');
      const workerRecord = {
        event: 'worker-launched',
        pid: workerPid,
        pgid: workerPid,
        sid: null,
        identity: captureProcessIdentity(workerPid),
        starttime: linuxStarttimeOf(workerPid),
      };
      ownRecordedWorkerGroups([workerRecord], { trustedHostPid: host.pid });
      assert.ok(ownedGroupsSnapshot().has(workerPid), 'the worker must be owned and attested');
      // The worker exits; an unrelated live leader takes a fresh group.
      process.kill(workerPid, 'SIGKILL');
      await waitUntilSettled(workerPid, 5_000);
      unrelated = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
      await sleep(150);
      // The rewritten log: the attested pid named with the UNRELATED
      // leader's real identity and group (the recycled-pid shape).
      const rewritten = {
        event: 'worker-launched',
        pid: workerPid,
        pgid: unrelated.pid,
        sid: null,
        identity: String(captureProcessIdentity(unrelated.pid)),
        starttime: linuxStarttimeOf(unrelated.pid),
      };
      const logPath = join(parent, 'worker-launches.jsonl');
      await writeFile(logPath, `${JSON.stringify(rewritten)}\n`, 'utf8');
      const workerExit = await settleWorkerExits(logPath, Date.now() + 5_000, host.pid);
      let unrelatedAlive = true;
      try { process.kill(unrelated.pid, 0); } catch { unrelatedAlive = false; }
      assert.equal(unrelatedAlive, true,
        'the unrelated recycled-group leader must never be signaled from an attested pid alone');
      assert.equal(workerExit, 'verified-exited',
        'the attested pid is gone: exit credit applies without any signal');
    } finally {
      try { host.kill('SIGKILL'); } catch { /* already gone */ }
      if (workerPid > 0) { try { process.kill(workerPid, 'SIGKILL'); } catch { /* already gone */ } }
      if (unrelated !== null) { try { unrelated.kill('SIGKILL'); } catch { /* already gone */ } }
      await waitUntilSettled(host.pid, 5_000);
    }
  });
});

test('a claimed-parent ancestry handoff attests a completed intermediary worker', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The launcher shape with a SHORT-LIVED worker: host -> intermediate
    // (the CLI, spawned by the host) -> detached separately-grouped worker.
    // The worker records its launch (parent = the intermediate) and exits
    // BEFORE any discovery tick can verify it live. The post-execution
    // attest-only read must accept the claimed-parent ancestry handoff
    // (the intermediate's own chain reaches the spawned host) so the
    // completed worker settles as verified-exited — and the unrelated
    // process shapes stay refused.
    const workerScript = [
      "import { appendFile } from 'node:fs/promises';",
      "import { spawnSync } from 'node:child_process';",
      'let identity = null;',
      "for (const ps of ['/bin/ps', '/usr/bin/ps']) {",
      "  const r = spawnSync(ps, ['-p', String(process.pid), '-o', 'lstart=,ppid=,comm='], { encoding: 'utf8', timeout: 2000 });",
      '  if (r.status === 0 && typeof r.stdout === "string") {',
      "    const parts = r.stdout.trim().split(' ').filter((p2) => p2.length > 0);",
      '    if (parts.length >= 3) { identity = parts.slice(0, -2).join(" ") + "|ppid=" + parts.at(-2) + "|comm=" + parts.at(-1); break; }',
      '  }',
      '}',
      'await appendFile(process.argv[2], JSON.stringify({ event: "worker-launched", pid: process.pid, pgid: process.pid, sid: null, identity, starttime: null }) + String.fromCharCode(10));',
    ].join('\n');
    const middleScript = [
      "import { spawn } from 'node:child_process';",
      "import { writeFile } from 'node:fs/promises';",
      'const w = spawn(process.execPath, [process.argv[2], process.argv[3]], { detached: true, stdio: "ignore" });',
      'setTimeout(() => {}, 8000);',
    ].join('\n');
    const workerScriptPath = join(parent, 'wait-route-handoff-worker.mjs');
    const middleScriptPath = join(parent, 'wait-route-handoff-middle.mjs');
    await writeFile(workerScriptPath, workerScript, 'utf8');
    await writeFile(middleScriptPath, middleScript, 'utf8');
    const recordPath = join(parent, 'handoff-record.jsonl');
    const hostScript = [
      "const { spawn } = require('node:child_process');",
      "const w = spawn(process.execPath, [process.env.HANDOFF_MIDDLE_SCRIPT, process.env.HANDOFF_WORKER_SCRIPT, process.env.HANDOFF_RECORD], { stdio: 'ignore' });",
      'setTimeout(() => {}, 60000);',
    ].join('\n');
    const host = spawn(process.execPath, ['-e', hostScript], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        HANDOFF_MIDDLE_SCRIPT: middleScriptPath,
        HANDOFF_WORKER_SCRIPT: workerScriptPath,
        HANDOFF_RECORD: recordPath,
      },
    });
    let workerPid = 0;
    try {
      registerOwnedChild(host);
      const launchLog = recordPath;
      for (let waited = 0; waited < 8000; waited += 100) {
        const content = await readFile(launchLog, 'utf8').catch(() => '');
        if (content.includes('worker-launched')) break;
        await sleep(100);
      }
      const content = await readFile(launchLog, 'utf8').catch(() => '');
      workerPid = Number((content.match(/"pid":(\d+)/) ?? [])[1] ?? '0');
      assert.ok(workerPid > 0, 'the intermediate must launch the worker and its record must land');
      // The worker EXITS before any discovery tick (short-lived): the live
      // chain can no longer be walked through the worker itself — but the
      // claimed parent (the intermediate) is STILL LIVE here, exactly the
      // in-poll sequence the reviewer reproduced. The handoff must be
      // performed and RETAINED during polling: this call uses the POLL
      // shape (attestOnly false — no ownership may be created from a dead
      // worker's record), and the attestation must still land.
      await waitUntilSettled(workerPid, 8_000);
      const record = JSON.parse(content);
      ownRecordedWorkerGroups([record], { trustedHostPid: host.pid });
      assert.ok(ownedWorkerAttestationsSnapshot().has(workerPid),
        'the poll-context claimed-parent handoff must attest the completed worker');
      // Then the intermediate exits too (the real launcher lifecycle): the
      // post-exec attest-only read still settles the worker from the
      // retained attestation.
      ownRecordedWorkerGroups([record], { trustedHostPid: host.pid, attestOnly: true });
      const workerExit = await settleWorkerExits(launchLog, Date.now() + 5_000, host.pid);
      assert.equal(workerExit, 'verified-exited',
        'the completed intermediary worker must settle through the claimed-parent ancestry handoff');
    } finally {
      // Kill the whole host GROUP (the intermediate holds it alive for 8 s)
      // and flush this test's ownership entries so no later test's
      // interrupt counts them.
      try { process.kill(-host.pid, 'SIGKILL'); } catch { try { host.kill('SIGKILL'); } catch { /* already gone */ } }
      if (workerPid > 0) { try { process.kill(workerPid, 'SIGKILL'); } catch { /* already gone */ } }
      await waitUntilSettled(host.pid, 5_000);
      settleOwnedGroups();
    }
  });
});

test('discovery inspection is bounded by the observation deadline', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async () => {
    // Verification performs MULTIPLE synchronous ps calls per record; with
    // many records the batch must STOP at the observation deadline instead
    // of blocking the event loop (and the interrupt path) for the whole
    // cumulative inspection cost.
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    try {
      const records = [];
      for (let index = 0; index < 64; index += 1) {
        records.push({
          event: 'worker-launched',
          pid: holder.pid,
          pgid: holder.pid,
          sid: null,
          identity: String(captureProcessIdentity(holder.pid)),
          starttime: linuxStarttimeOf(holder.pid),
        });
      }
      const startedAt = Date.now();
      ownRecordedWorkerGroups(records, { trustedHostPid: process.pid, inspectionDeadline: startedAt + 400 });
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 2_000,
        `inspection must stop at the deadline (took ${elapsed} ms for 64 records)`);
      // Fail-closed: unprocessed records carry no ownership and no signal.
      let holderAlive = true;
      try { process.kill(holder.pid, 0); } catch { holderAlive = false; }
      assert.equal(holderAlive, true, 'the named process must never be signaled from unattested records');
    } finally {
      try { holder.kill('SIGKILL'); } catch { /* already gone */ }
      await waitUntilSettled(holder.pid, 5_000);
      settleOwnedGroups();
    }
  });
});

test('two workers sharing one group keep valid ownership through both records', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // Two live workers in the SAME separately-grouped shell (the real
    // shell-group shape): the first record establishes ownership, the
    // second record names a DIFFERENT pid in the same group. The second
    // record must never revoke otherwise-valid ownership — the retained
    // worker's settlement covers the whole group — and the interrupt must
    // settle both workers.
    const pairFile = join(parent, 'wait-route-shared-pids.txt');
    // The leader (detached, own group) spawns the shared-group workers via
    // a small script, so both workers' REAL group is the leader's group.
    const leaderScript = [
      "import { spawn } from 'node:child_process';",
      "import { writeFile } from 'node:fs/promises';",
      'const a = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });',
      'const b = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });',
      'await writeFile(process.argv[1], `${a.pid} ${b.pid}`);',
      'setTimeout(() => {}, 60000);',
    ].join('\n');
    const leader = spawn(process.execPath, ['-e', leaderScript, pairFile], { detached: true, stdio: 'ignore' });
    let w1 = null;
    let w2 = null;
    try {
      registerOwnedChild(leader);
      let pair = '';
      for (let waited = 0; waited < 8000; waited += 100) {
        pair = await readFile(pairFile, 'utf8').catch(() => '');
        if (pair) break;
        await sleep(100);
      }
      const [pidA, pidB] = pair.trim().split(' ').map(Number);
      assert.ok(pidA > 0 && pidB > 0, 'both shared-group workers must be spawned');
      w1 = { pid: pidA };
      w2 = { pid: pidB };
      const recordA = {
        event: 'worker-launched',
        pid: pidA,
        pgid: leader.pid,
        sid: null,
        identity: String(captureProcessIdentity(pidA)),
        starttime: linuxStarttimeOf(pidA),
      };
      const recordB = {
        event: 'worker-launched',
        pid: pidB,
        pgid: leader.pid,
        sid: null,
        identity: String(captureProcessIdentity(pidB)),
        starttime: linuxStarttimeOf(pidB),
      };
      ownRecordedWorkerGroups([recordA], { trustedHostPid: leader.pid });
      ownRecordedWorkerGroups([recordB], { trustedHostPid: leader.pid });
      const lines = [];
      handleDriverSignal('SIGINT', { exitImpl: () => {}, writeImpl: (line) => lines.push(line) });
      assert.match(lines.join(''), /1 owned process group/,
        'the shared group stays owned through the second record');
      assert.equal(await waitUntilSettled(pidA, 5_000), true, 'worker A must be settled with the group');
      assert.equal(await waitUntilSettled(pidB, 5_000), true, 'worker B must be settled with the group');
    } finally {
      try { leader.kill('SIGKILL'); } catch { /* already gone */ }
      if (w1 !== null) { try { w1.kill('SIGKILL'); } catch { /* already gone */ } }
      if (w2 !== null) { try { w2.kill('SIGKILL'); } catch { /* already gone */ } }
      await waitUntilSettled(leader.pid, 5_000);
      settleOwnedGroups();
    }
  });
});

test('a single record with a past case deadline still verifies through the settlement window', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The reviewer's single-record shape: cleanup runs AFTER the case
    // budget expired, and one record's verification (identity + group +
    // parent claim) must not be starved by the already-past case deadline
    // — the inspection budget covers the SHARED SETTLEMENT window instead.
    // The real fixture smoke shape: the host spawns the worker INTO its
    // own group (shared-group record, coherent claim).
    const holderPidFile = join(parent, 'wait-route-single-holder.pid');
    const hostScript = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      'const w = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });',
      'writeFileSync(process.env.HOLDER_PID_FILE, String(w.pid));',
      'setTimeout(() => {}, 60000);',
    ].join('\n');
    const host = spawn(process.execPath, ['-e', hostScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, HOLDER_PID_FILE: holderPidFile },
    });
    let holderPid = 0;
    try {
      registerOwnedChild(host);
      for (let waited = 0; waited < 8000 && holderPid === 0; waited += 100) {
        holderPid = Number(await readFile(holderPidFile, 'utf8').catch(() => '0'));
        if (holderPid === 0) await sleep(100);
      }
      assert.ok(holderPid > 0, 'the host must spawn the holder');
      const record = {
        event: 'worker-launched',
        pid: holderPid,
        pgid: host.pid,
        sid: null,
        identity: String(captureProcessIdentity(holderPid)),
        starttime: linuxStarttimeOf(holderPid),
      };
      const logPath = join(parent, 'single-record-launches.jsonl');
      await writeFile(logPath, `${JSON.stringify(record)}\n`, 'utf8');
      const workerExit = await settleWorkerExits(logPath, Date.now() - 1, host.pid);
      assert.equal(workerExit, 'verified-exited',
        'post-budget cleanup must still verify the shared-group worker through the settlement-window budget');
      let holderAlive = true;
      try { process.kill(holderPid, 0); } catch { holderAlive = false; }
      assert.equal(holderAlive, true, 'the covered holder is not signaled separately');
    } finally {
      try { process.kill(-host.pid, 'SIGKILL'); } catch { try { host.kill('SIGKILL'); } catch { /* already gone */ } }
      if (holderPid > 0) { try { process.kill(holderPid, 'SIGKILL'); } catch { /* already gone */ } }
      await waitUntilSettled(host.pid, 5_000);
      settleOwnedGroups();
    }
  });
});

test('cleanup after the deadline validates the RETAINED record, never a rewritten one', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The reviewer's P1 shape: an OWNED worker exits, its pid is recycled
    // by an unrelated live group, and the model-writable log is REWRITTEN
    // with the replacement's real identity. The signal must validate the
    // RETAINED registration record against the live table — which the
    // replacement fails — never the rewritten log entry.
    const holderPidFile = join(parent, 'wait-route-retain-holder.pid');
    const hostScript = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      'const w = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });',
      'writeFileSync(process.env.HOLDER_PID_FILE, String(w.pid));',
      'setTimeout(() => {}, 60000);',
    ].join('\n');
    const host = spawn(process.execPath, ['-e', hostScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, HOLDER_PID_FILE: holderPidFile },
    });
    let holderPid = 0;
    let unrelated = null;
    try {
      registerOwnedChild(host);
      for (let waited = 0; waited < 8000 && holderPid === 0; waited += 100) {
        holderPid = Number(await readFile(holderPidFile, 'utf8').catch(() => '0'));
        if (holderPid === 0) await sleep(100);
      }
      assert.ok(holderPid > 0, 'the host must spawn the holder');
      const retainedRecord = {
        event: 'worker-launched',
        pid: holderPid,
        pgid: holderPid,
        sid: null,
        identity: String(captureProcessIdentity(holderPid)),
        starttime: linuxStarttimeOf(holderPid),
      };
      // The trusted boundary owns and retains the record.
      ownRecordedWorkerGroups([retainedRecord], { trustedHostPid: host.pid });
      // The holder exits; an unrelated live group leader takes a fresh group.
      process.kill(holderPid, 'SIGKILL');
      await waitUntilSettled(holderPid, 5_000);
      unrelated = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
      await sleep(150);
      // The REWRITTEN log: the attested pid named with the UNRELATED
      // leader's real identity and group.
      const rewritten = {
        event: 'worker-launched',
        pid: holderPid,
        pgid: unrelated.pid,
        sid: null,
        identity: String(captureProcessIdentity(unrelated.pid)),
        starttime: linuxStarttimeOf(unrelated.pid),
      };
      const logPath = join(parent, 'rewritten-launches.jsonl');
      await writeFile(logPath, `${JSON.stringify(rewritten)}\n`, 'utf8');
      const workerExit = await settleWorkerExits(logPath, Date.now() + 5_000, host.pid);
      let unrelatedAlive = true;
      try { process.kill(unrelated.pid, 0); } catch { unrelatedAlive = false; }
      assert.equal(unrelatedAlive, true,
        'the unrelated recycled-group leader must never be signaled from a rewritten record');
      // The OWNED pid did exit (the test killed it): exit credit is honest.
      // The security property is that the rewritten identity was never
      // used for a signal — the unrelated group survives.
      assert.equal(workerExit, 'verified-exited',
        'the owned pid did exit; the rewritten identity never reached a signal');
    } finally {
      try { host.kill('SIGKILL'); } catch { /* already gone */ }
      if (holderPid > 0) { try { process.kill(holderPid, 'SIGKILL'); } catch { /* already gone */ } }
      if (unrelated !== null) { try { unrelated.kill('SIGKILL'); } catch { /* already gone */ } }
      await waitUntilSettled(host.pid, 5_000);
      settleOwnedGroups();
    }
  });
});

test('covered live workers are handed back and integrity-failed logs settle unresolved', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // Two settlement-honesty behaviors: (1) a shared-group worker that is
    // STILL ALIVE at cleanup is handed back to the caller (coveredWorkerPids)
    // instead of being silently assumed settled — the caller verifies it
    // after the host group's own signal; (2) a log whose integrity failed
    // (oversized/truncated record) settles `unresolved` even with zero
    // readable records — incomplete evidence is never `not-started`.
    const holderPidFile = join(parent, 'wait-route-covered-holder.pid');
    const hostScript = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      'const w = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });',
      'writeFileSync(process.env.HOLDER_PID_FILE, String(w.pid));',
      'setTimeout(() => {}, 60000);',
    ].join('\n');
    const host = spawn(process.execPath, ['-e', hostScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, HOLDER_PID_FILE: holderPidFile },
    });
    let workerPid = 0;
    try {
      registerOwnedChild(host);
      for (let waited = 0; waited < 8000 && workerPid === 0; waited += 100) {
        workerPid = Number(await readFile(holderPidFile, 'utf8').catch(() => '0'));
        if (workerPid === 0) await sleep(100);
      }
      assert.ok(workerPid > 0, 'the host must spawn the shared-group worker');
      const record = {
        event: 'worker-launched',
        pid: workerPid,
        pgid: host.pid,
        sid: null,
        identity: String(captureProcessIdentity(workerPid)),
        starttime: linuxStarttimeOf(workerPid),
      };
      ownRecordedWorkerGroups([record], { trustedHostPid: host.pid });
      const logPath = join(parent, 'covered-launches.jsonl');
      await writeFile(logPath, `${JSON.stringify(record)}\n`, 'utf8');
      const coveredWorkerPids = [];
      const workerExit = await settleWorkerExits(logPath, Date.now() + 5_000, host.pid, coveredWorkerPids);
      assert.equal(workerExit, 'verified-exited',
        'the covered worker is honestly verified (not unresolved) while the host lives');
      assert.deepEqual(coveredWorkerPids, [workerPid],
        'the alive covered worker must be handed back for post-signal verification');
      // (2) integrity-failed log: an oversized single record carries zero
      // readable records and must settle unresolved.
      const tornPath = join(parent, 'torn-launches.jsonl');
      await writeFile(tornPath, JSON.stringify({ event: 'worker-launched', pid: 1, pgid: 1, sid: null, identity: 'x'.repeat(96 * 1024) }) + '\n', 'utf8');
      const tornExit = await settleWorkerExits(tornPath, Date.now() + 5_000, host.pid);
      assert.equal(tornExit, 'unresolved',
        'a truncated launch log must settle unresolved, never not-started');
    } finally {
      try { process.kill(-host.pid, 'SIGKILL'); } catch { try { host.kill('SIGKILL'); } catch { /* already gone */ } }
      if (workerPid > 0) { try { process.kill(workerPid, 'SIGKILL'); } catch { /* already gone */ } }
      await waitUntilSettled(host.pid, 5_000);
      settleOwnedGroups();
    }
  });
});

test('the launch-log reader stops at the pending-record cap on an unterminated record', { timeout: 30_000 }, async () => {
  await withTempDirectory(async (parent) => {
    // A regular-file log whose single record exceeds the 64 KiB per-record
    // cap WITHOUT ever being newline-terminated: the pending-carry check
    // must stop the reader at the cap mid-stream (before the final read),
    // report truncation and return zero records. The reader no longer
    // accepts non-regular logs at all (the FIFO guard), so the mid-stream
    // stop is proven on a regular file where the cap fires BEFORE EOF.
    const logPath = join(parent, 'worker-launches.jsonl');
    const valid = JSON.stringify({ event: 'worker-launched', pid: 7, pgid: 7, sid: 7, identity: 'lstart=x|comm=node' });
    await writeFile(logPath, `${valid}\n${'x'.repeat(96 * 1024)}`, 'utf8');
    const result = await readWorkerLaunchRecords(logPath);
    assert.equal(result.truncated, true, 'the oversized unterminated record must be reported as truncation');
    assert.equal(result.records.length, 1, 'only the complete in-bound record may be returned');
    assert.equal(result.records[0].pid, 7, 'the returned record must be the valid one');
    assert.equal(result.incomplete, false, 'a byte-bound truncation is reported as truncated, not incomplete');
  });
});

test('the observation deadline is absolute: setup delay cannot extend it', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // Directly driven seam: the child exits 0 immediately while a DETACHED
    // inheritor holds stdout, writes the marker at ~316 ms and closes the
    // pipe at ~320 ms. With a 100 ms budget and a simulated 300 ms slow
    // inspection, the committed relative timer fired only AFTER the
    // observation had completed, so expiry was never recorded (timedOut:
    // false, clean result). The deadline must be ABSOLUTE - computed
    // before the synchronous setup - so the fire lands while the
    // observation is still open and expiry is recorded honestly.
    const childScriptPath = join(parent, 'wait-route-absdead-child.mjs');
    await writeFile(childScriptPath, [
      "import { spawn } from 'node:child_process';",
      "const writer = spawn(process.execPath, ['-e', 'const marker = process.argv[1]; setTimeout(() => { process.stdout.write(JSON.stringify({ final: marker }) + String.fromCharCode(10)); }, 316); setTimeout(() => {}, 320);', 'WAIT_ROUTE_PROBE_WORKER_DONE'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
      'setTimeout(() => process.exit(0), 20);',
    ].join('\n'), 'utf8');
    const result = await runBoundedSubprocess(process.execPath, [childScriptPath], {
      cwd: parent,
      env: process.env,
      deadlineMs: 100,
      setupDelayMs: 300,
      stdoutMaxBytes: 64 * 1024,
      markerText: COMPLETION_MARKER,
    });
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.timedOut, true,
      'the observation expired at the absolute deadline even though synchronous setup delayed arming');
    assert.ok(result.markerAtMs !== null && result.markerAtMs > result.deadlineAtMs,
      'the post-budget marker stays recorded as evidence');
  });
});

test('forced drain resolution destroys the retained stdio streams', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // Directly driven seam: the child exits immediately while a DETACHED
    // inheritor holds its stdout and stderr pipes for 20 s — far past the
    // deadline and the drain grace. The bounded drain must resolve around
    // deadline+grace (never at the inheritor's exit) and DESTROY the
    // driver's own stream handles, so an unowned descendant's pipe never
    // keeps the run alive.
    const childScriptPath = join(parent, 'wait-route-drain-child.mjs');
    await writeFile(childScriptPath, [
      "import { spawn } from 'node:child_process';",
      "import { writeFile } from 'node:fs/promises';",
      "const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
      "await writeFile(process.argv[2], String(holder.pid));",
      'process.exit(0);',
    ].join('\n'), 'utf8');
    const holderPidFile = join(parent, 'wait-route-holder.pid');
    const result = await runBoundedSubprocess(process.execPath, [childScriptPath, holderPidFile], {
      cwd: parent,
      env: process.env,
      deadlineMs: 1_200,
      stdoutMaxBytes: 64 * 1024,
    });
    const holderPid = Number(await readFile(holderPidFile, 'utf8').catch(() => '0'));
    try {
      assert.ok(Number.isSafeInteger(holderPid) && holderPid > 0, 'the child must record its pipe holder');
      assert.equal(result.code, 0, JSON.stringify(result));
      assert.ok(result.durationMs >= 3_000 && result.durationMs <= 9_000,
        `the bounded drain must resolve around deadline+grace, got ${result.durationMs} ms`);
      assert.equal(result.child.stdout.destroyed, true, 'the retained stdout stream must be destroyed on forced drain');
      assert.equal(result.child.stderr.destroyed, true, 'the retained stderr stream must be destroyed on forced drain');
    } finally {
      if (holderPid > 0) { try { process.kill(holderPid, 'SIGKILL'); } catch { /* already gone */ } }
      await waitUntilSettled(holderPid, 5_000);
    }
  });
});

test('a recorded survivor that left the group is not evidence for it', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  const perl = '/usr/bin/perl';
  let perlUsable = false;
  try { perlUsable = lstatSync(perl).isFile(); } catch { perlUsable = false; }
  if (!perlUsable) return; // no setpgid-capable interpreter on this host
  await withTempDirectory(async (parent) => {
    // A survivor that MOVES OUT of the tracked group (setpgid/setsid) keeps
    // its start token — but it is no longer evidence FOR that group. When
    // the old group's other members are gone and only an unrecorded process
    // (the recycled-id equivalent) keeps it alive, the interrupt must fail
    // closed instead of trusting the departed survivor's token.
    const descendantScript = [
      "import { spawn } from 'node:child_process';",
      "import { writeFile } from 'node:fs/promises';",
      'const pidFile = process.argv[2];',
      'setTimeout(async () => {',
      "  const nephew = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
      '  await writeFile(pidFile, String(nephew.pid));',
      '  process.exit(0);',
      '}, 600);',
    ].join('\n');
    const descendantScriptPath = join(parent, 'wait-route-descendant-script.mjs');
    await writeFile(descendantScriptPath, descendantScript, 'utf8');
    const departorPidFile = join(parent, 'departor.pid');
    const descendantPidFile = join(parent, 'descendant.pid');
    const nephewPidFile = join(parent, 'nephew.pid');
    const leaderScript = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      // The departor: recorded as a member at the leader's exit, then leaves
      // the group via setpgrp (its start token is unchanged by that).
      "const p1 = spawn('/usr/bin/perl', ['-e', 'sleep(1); setpgrp(0,0); sleep(30);'], { stdio: 'ignore' });",
      "const d = spawn(process.execPath, [process.env.WAIT_ROUTE_DESCENDANT_SCRIPT, process.env.WAIT_ROUTE_NEPHEW_FILE], { stdio: 'ignore' });",
      "writeFileSync(process.env.WAIT_ROUTE_DEPARTOR_FILE, String(p1.pid));",
      "writeFileSync(process.env.WAIT_ROUTE_DESCENDANT_FILE, String(d.pid));",
      'process.exit(0);',
    ].join('\n');
    const leader = spawn(process.execPath, ['-e', leaderScript], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        WAIT_ROUTE_DESCENDANT_SCRIPT: descendantScriptPath,
        WAIT_ROUTE_NEPHEW_FILE: nephewPidFile,
        WAIT_ROUTE_DEPARTOR_FILE: departorPidFile,
        WAIT_ROUTE_DESCENDANT_FILE: descendantPidFile,
      },
    });
    let nephewPid = 0;
    try {
      registerOwnedChild(leader);
      for (const pidFile of [departorPidFile, descendantPidFile]) {
        for (let waited = 0; waited < 8000; waited += 250) {
          const recorded = await readFile(pidFile, 'utf8').then(() => true, () => false);
          if (recorded) break;
          await sleep(250);
        }
      }
      const departorPid = Number(await readFile(departorPidFile, 'utf8').catch(() => '0'));
      const descendantPid = Number(await readFile(descendantPidFile, 'utf8').catch(() => '0'));
      assert.ok(Number.isSafeInteger(departorPid) && departorPid > 0, 'the leader must record the departor pid');
      assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0, 'the leader must record the descendant pid');
      // The leader exits; evidence re-anchors to BOTH recorded survivors.
      assert.equal(await waitUntilSettled(leader.pid, 5_000), true, 'the leader must exit early');
      for (let waited = 0; waited < 8000; waited += 250) {
        nephewPid = Number(await readFile(nephewPidFile, 'utf8').catch(() => '0'));
        if (nephewPid > 0) break;
        await sleep(250);
      }
      assert.ok(Number.isSafeInteger(nephewPid) && nephewPid > 0, 'the descendant must spawn the nephew');
      assert.equal(await waitUntilSettled(descendantPid, 5_000), true, 'the descendant must exit');
      // The departor leaves the group at ~1 s under its own schedule
      // (perl sleep(1) + setpgrp) — WAIT for the actual departure instead
      // of a fixed sleep: under load the setpgrp can land later, and the
      // interrupt must be exercised only after the member truly departed.
      const pgidOf = (pid) => {
        const r = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8', timeout: 2_000 });
        const value = r.status === 0 ? Number(r.stdout.trim()) : null;
        return Number.isSafeInteger(value) ? value : null;
      };
      let departed = false;
      for (let waited = 0; waited < 8_000; waited += 100) {
        const observed = pgidOf(departorPid);
        if (observed === departorPid) { departed = true; break; }
        // A ps failure under load is NOT a departure: retry until the
        // member is verifiably gone from the tracked group.
        await sleep(100);
      }
      assert.ok(departed, 'staging: the departor never verifiably left the tracked group');
      let departorAlive = true;
      try { process.kill(departorPid, 0); } catch { departorAlive = false; }
      assert.ok(departorAlive, 'the departed survivor must still be running in its own group');
      const lines = [];
      handleDriverSignal('SIGINT', { exitImpl: () => {}, writeImpl: (line) => lines.push(line) });
      assert.match(lines.join(''), /0 owned process group/,
        'a departed survivor is not evidence for the tracked group: fail closed');
      assert.equal(await waitUntilSettled(nephewPid, 500), false,
        'the unrecorded process keeping the old group alive must never be signaled');
    } finally {
      try { leader.kill('SIGKILL'); } catch { /* already exited */ }
      const departorPid = Number(await readFile(departorPidFile, 'utf8').catch(() => '0'));
      if (departorPid > 0) { try { process.kill(departorPid, 'SIGKILL'); } catch { /* already gone */ } }
      if (nephewPid > 0) { try { process.kill(nephewPid, 'SIGKILL'); } catch { /* already gone */ } }
      await waitUntilSettled(leader.pid, 5_000);
    }
  });
});

test('the startup identity is retained only as a per-run salted fingerprint', () => {
  // The raw identity string can carry the Node installation's user-home path
  // (macOS ps comm may return the executable PATH), and the trace is
  // retained — so the server must store only a salted fingerprint, and
  // cleanup must compare live identities through the same fingerprint.
  const rawIdentity = '/Users/someone/.nvm/versions/node/bin/node|ppid=42|comm=/Users/someone/.nvm/versions/node/bin/node';
  const fingerprint = fingerprintProcessIdentity(HEX_NONCE, rawIdentity);
  assert.match(fingerprint, /^[0-9a-f]{32}$/, 'the fingerprint must be a truncated hex digest');
  assert.ok(!fingerprint.includes('/Users/'), 'the fingerprint must never carry a raw path fragment');
  assert.equal(fingerprintProcessIdentity(HEX_NONCE, rawIdentity), fingerprint, 'the same identity and nonce must fingerprint identically');
  assert.notEqual(fingerprintProcessIdentity('b'.repeat(64), rawIdentity), fingerprint, 'a different per-run salt must produce a different fingerprint');
  assert.notEqual(fingerprintProcessIdentity(HEX_NONCE, rawIdentity + ' '), fingerprint, 'a different identity must produce a different fingerprint');
});

test('a group-rejected worker record is never killed via the coarse identity fallback', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // A record WITH a usable group field whose validation rejects it (the
    // named group is not the worker's) must never fall through to the
    // coarser lstart/ppid/comm kill: on Linux a recycled pid can reproduce
    // that whole coarse triple while its /proc starttime differs. The
    // holder's REAL coarse identity is recorded, so the committed fallback
    // kills the live holder; ownership-restricted cleanup must not.
    const fakeCodex = await writeFakeCodex(parent, 'exit-worker-then-hold');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const unrelated = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    try {
      const casePromise = runWaitRouteCase({ caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 20_000, sourceCodexHome: sourceHome });
      for (let waited = 0; waited < 8000; waited += 250) {
        const recorded = await readFile(join(parent, 'wait-route-descendant.pid'), 'utf8').then(() => true, () => false);
        if (recorded) break;
        await sleep(250);
      }
      // The holder's real coarse identity, but a group it does not belong
      // to: group validation rejects, and that rejection must be final.
      const launchLog = join(output, 'workspace', 'worker-launches.jsonl');
      await appendFile(launchLog, `${JSON.stringify({ event: 'worker-launched', pid: holder.pid, pgid: unrelated.pid, sid: null, identity: captureProcessIdentity(holder.pid), starttime: linuxStarttimeOf(holder.pid) })}\n`, 'utf8');
      await sleep(1_000);
      const summary = await casePromise;
      let holderAlive = true;
      try { process.kill(holder.pid, 0); } catch { holderAlive = false; }
      assert.equal(holderAlive, true,
        'a record rejected by group validation must never be killed via the coarse identity fallback');
      let unrelatedAlive = true;
      try { process.kill(unrelated.pid, 0); } catch { unrelatedAlive = false; }
      assert.equal(unrelatedAlive, true, 'the unrelated named group must never be signaled');
      assert.equal(summary.cleanup.workerExit, 'unresolved', JSON.stringify(summary));
    } finally {
      try { unrelated.kill('SIGKILL'); } catch { /* already settled */ }
      try { holder.kill('SIGKILL'); } catch { /* already settled */ }
      await waitUntilSettled(unrelated.pid, 5_000);
      await waitUntilSettled(holder.pid, 5_000);
    }
  });
});

test('worker cleanup signals all validated workers against one shared deadline', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // Three live workers in separate groups, all validated: settlement must
    // signal them together and wait against ONE shared grace window — never
    // accumulate a per-record grace that pushes the case N× past its budget.
    const fakeCodex = await writeFakeCodex(parent, 'exit-then-three-detached-workers');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const startedAt = Date.now();
    const summary = await runWaitRouteCase({ caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 2_500, sourceCodexHome: sourceHome });
    const elapsed = Date.now() - startedAt;
    assert.equal(summary.outcome, 'budget-exhausted', JSON.stringify(summary));
    assert.equal(summary.cleanup.workerExit, 'terminated', JSON.stringify(summary));
    assert.ok(elapsed < 7_000,
      `worker cleanup must share one deadline (budget ${2_500} ms + one grace), got ${elapsed} ms total`);
    for (const index of [0, 1, 2]) {
      const workerPid = Number(await readFile(join(parent, `wait-route-worker-${index}.pid`), 'utf8').catch(() => '0'));
      assert.ok(Number.isSafeInteger(workerPid) && workerPid > 0, `worker ${index} must have recorded its pid`);
      assert.equal(await waitUntilSettled(workerPid, 500), true, `worker ${index} must be settled`);
    }
  });
});

test('the fixture worker records its identity when the node path contains spaces', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // macOS ps can return the full executable PATH in comm. When Node lives
    // under a space-containing path, the recorded identity must keep the
    // parent pid and the whole comm — a whitespace split shifts the fields,
    // so the worker token never matches and ownership/cleanup both fail.
    const output = await newRunDirectory(parent);
    const fixture = await buildWaitRouteFixture({ outputDir: output, serverPath: serverModulePath });
    const spaceyDir = join(parent, 'node dir with space');
    await mkdir(spaceyDir, { mode: 0o700 });
    const spaceyNode = join(spaceyDir, 'my node');
    copyFileSync(process.execPath, spaceyNode);
    await chmod(spaceyNode, 0o755);
    const workerPath = fixture.workerPath;
    const child = spawn(spaceyNode, [workerPath], { stdio: 'ignore' });
    assert.equal(await waitUntilSettled(child.pid, 10_000), true, 'the worker must run to completion');
    const record = JSON.parse(await readFile(join(output, 'plugins', PLUGIN_NAME, 'workers', 'worker-launches.jsonl'), 'utf8'));
    assert.match(String(record.identity), /\|ppid=\d+\|comm=/, 'the recorded identity must keep numeric ppid and comm fields');
    assert.ok(String(record.identity).includes('my node'), 'the recorded comm must retain the full spacey executable path');
    assert.ok(Number(record.pgid) > 0, 'the worker must record its process group');
  });
});

test('the ps identity line parser preserves spaces inside the executable field', () => {
  // ps prints `lstart ppid comm` on one line where lstart itself contains
  // spaces (its final token is the 4-digit year) and comm — the executable
  // PATH on some installations — may contain spaces too. The parser must
  // split at the year/parent-pid boundary and keep the WHOLE remainder as
  // comm, so the recorded identity round-trips against the driver's
  // start-token extraction.
  const parsed = parseProcessIdentityLine('Thu Oct  1 12:48:26 2026     76961 /Users/Some Dir 20/my node bin');
  assert.deepEqual(parsed, { lstart: 'Thu Oct 1 12:48:26 2026', ppid: '76961', comm: '/Users/Some Dir 20/my node bin' });
  const identity = `${parsed.lstart}|ppid=${parsed.ppid}|comm=${parsed.comm}`;
  assert.equal(identity.split('|ppid=')[0], parsed.lstart, 'round-trip: lstart');
  assert.equal(identity.slice(identity.indexOf('|comm=') + '|comm='.length), parsed.comm, 'round-trip: comm keeps its spaces');
  if (process.platform === 'win32') return;
  // A real capture must parse back to the same fields (self-consistency).
  // POSIX-only: captureProcessIdentity explicitly returns null on Windows.
  const live = captureProcessIdentity(process.pid);
  assert.ok(live !== null, 'the live identity must be capturable');
  const liveLstart = live.split('|ppid=')[0];
  const livePpid = live.slice(live.indexOf('|ppid=') + '|ppid='.length, live.indexOf('|comm='));
  const liveComm = live.slice(live.indexOf('|comm=') + '|comm='.length);
  assert.deepEqual(parseProcessIdentityLine(`${liveLstart} ${livePpid} ${liveComm}`), { lstart: liveLstart, ppid: livePpid, comm: liveComm });
  // CONSECUTIVE whitespace inside the comm PATH must survive verbatim: the
  // live capture preserves it, so the recorded identity has to too.
  const spacey = parseProcessIdentityLine(`Thu Oct  1 12:48:26 2026 777 /app  double  space/node`);
  assert.equal(spacey.lstart, 'Thu Oct 1 12:48:26 2026');
  assert.equal(spacey.ppid, '777');
  assert.equal(spacey.comm, '/app  double  space/node');
});

test('an expired observation is reported even when the group entry was already forgotten', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The host exits 0 immediately; a DETACHED inheritor (its own group —
    // the ownership paths must never signal it) holds stdout and writes the
    // completion marker only AFTER the observation budget has expired. The
    // host group is forgotten as empty at the leader's exit, but the
    // observation expiry must still be recorded and the post-budget output
    // must not classify the case as a clean smoke success.
    const fakeCodex = await writeFakeCodex(parent, 'detached-writer-after-budget');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const startedAt = Date.now();
    const summary = await runWaitRouteCase({ caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 1_000, sourceCodexHome: sourceHome });
    const elapsed = Date.now() - startedAt;
    assert.equal(summary.hostExit.state, 'killed', JSON.stringify(summary));
    assert.equal(summary.trace.markerObserved, true, 'the post-budget marker is still observed evidence');
    assert.equal(summary.outcome, 'budget-exhausted',
      'a marker written after the observation budget must never classify the case as a clean smoke success');
    // The bounded drain must still apply: resolution around deadline+grace,
    // not at the inheritor's own exit.
    assert.ok(elapsed < 9_000, `the case must resolve on the bounded drain, got ${elapsed} ms`);
    const workerPid = Number(await readFile(join(parent, 'wait-route-descendant.pid'), 'utf8').catch(() => '0'));
    const writerPid = Number(await readFile(join(parent, 'wait-route-writer.pid'), 'utf8').catch(() => '0'));
    try {
      assert.ok(Number.isSafeInteger(writerPid) && writerPid > 0, 'the fake host must record the detached writer pid');
      let writerAlive = true;
      try { process.kill(writerPid, 0); } catch { writerAlive = false; }
      assert.equal(writerAlive, true, 'the unowned detached writer must never be signaled');
      assert.equal(await waitUntilSettled(workerPid, 500), true, 'the recorded worker is owned and settled');
    } finally {
      if (workerPid > 0) { try { process.kill(workerPid, 'SIGKILL'); } catch { /* already gone */ } }
      if (writerPid > 0) { try { process.kill(writerPid, 'SIGKILL'); } catch { /* already gone */ } }
      await waitUntilSettled(workerPid, 5_000);
      await waitUntilSettled(writerPid, 5_000);
    }
  });
});

test('an orphaned observation deadline never signals a later registration', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The child exits childless while a DETACHED inheritor keeps its
    // observation open: the group entry is forgotten and the deadline timer
    // is orphaned but still armed. A LATER subprocess reusing the pid (a
    // registration through the ownership seam) is not authority for that
    // old timer: its fire must record expiry only — never deliver a kill —
    // and the orphaned timer must not survive the observation's completion.
    const childScriptPath = join(parent, 'wait-route-orphan-child.mjs');
    await writeFile(childScriptPath, [
      "import { spawn } from 'node:child_process';",
      "import { writeFile } from 'node:fs/promises';",
      "const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2200)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
      "await writeFile(process.argv[2], String(holder.pid));",
      "await writeFile(process.argv[3], String(process.pid));",
      'process.exit(0);',
    ].join('\n'), 'utf8');
    const holderPidFile = join(parent, 'wait-route-holder.pid');
    const childPidFile = join(parent, 'wait-route-child.pid');
    const firesBefore = groupDeadlineFireCount();
    const resultPromise = runBoundedSubprocess(process.execPath, [childScriptPath, holderPidFile, childPidFile], {
      cwd: parent,
      env: process.env,
      deadlineMs: 1_500,
      stdoutMaxBytes: 64 * 1024,
    });
    // The child exits childless at ~100 ms: its registration is forgotten
    // and the deadline timer is orphaned while the observation stays open
    // through the holder. Simulate the pid-reused-by-a-later-subprocess
    // registration BEFORE the orphaned deadline fires: a later registration
    // over the same pid must not become authority for that timer.
    for (let waited = 0; waited < 3000; waited += 100) {
      const recorded = await readFile(childPidFile, 'utf8').then(() => true, () => false);
      if (recorded) break;
      await sleep(100);
    }
    const childPid = Number(await readFile(childPidFile, 'utf8').catch(() => '0'));
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0, 'the child must record its own pid');
    await sleep(300);
    const laterRegistration = { pid: childPid, exitCode: null, signalCode: null, once: () => {}, kill: () => true };
    registerOwnedChild(laterRegistration);
    const result = await resultPromise;
    // Wait past the orphaned deadline (~1.5 s) and the observation's
    // completion (holder exits at ~2.2 s).
    await sleep(2_800);
    assert.equal(groupDeadlineFireCount(), firesBefore,
      'the orphaned deadline must record expiry only — never deliver a kill for a later registration');
    assert.equal(result.timedOut, true, 'the expired observation must still be reported');
    const holderPid = Number(await readFile(holderPidFile, 'utf8').catch(() => '0'));
    assert.equal(await waitUntilSettled(holderPid, 500), true, 'the holder must have completed the observation');
    // No late fire after the observation completed either.
    assert.equal(groupDeadlineFireCount(), firesBefore, 'the orphaned timer must not survive its observation');
    try { process.kill(holderPid, 'SIGKILL'); } catch { /* already gone */ }
    await waitUntilSettled(holderPid, 5_000);
  });
});

test('late handler completion during the drain is never observed-before-budget-expiry', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The capture server survives OUTSIDE the killed host group (launched
    // detached through a relay) and its handler completion lands at ~2 s —
    // after a 1 s budget, during the bounded drain. The late completion
    // stays in the trace as evidence, but the classification must not claim
    // observed-before-budget-expiry from it.
    const fakeCodex = await writeFakeCodex(parent, 'entry-late-completion');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    let completerPid = 0;
    let holderPid = 0;
    try {
      const summary = await runWaitRouteCase({ caseLabel: 'hook-entry', codexPath: fakeCodex, outputDir: output, budgetMs: 1_000, sourceCodexHome: sourceHome });
      assert.equal(summary.trace.handlerEntered, true, JSON.stringify(summary));
      assert.equal(summary.trace.handlerCompleted, true, 'the late completion stays recorded as evidence');
      assert.equal(summary.outcome, 'budget-exhausted', JSON.stringify(summary));
      assert.equal(summary.reason, 'observation-budget-exhausted', JSON.stringify(summary));
    } finally {
      // The detached completer and holder are NOT in the host group and the
      // startup trace names the already-exited fake host, so the driver's
      // cleanup cannot settle them: the test owns their lifetime.
      completerPid = Number(await readFile(join(parent, 'wait-route-completer.pid'), 'utf8').catch(() => '0'));
      holderPid = Number(await readFile(join(parent, 'wait-route-holder.pid'), 'utf8').catch(() => '0'));
      if (completerPid > 0) { try { process.kill(completerPid, 'SIGKILL'); } catch { /* already gone */ } }
      if (holderPid > 0) { try { process.kill(holderPid, 'SIGKILL'); } catch { /* already gone */ } }
      if (completerPid > 0) await waitUntilSettled(completerPid, 2_000);
      if (holderPid > 0) await waitUntilSettled(holderPid, 2_000);
    }
  });
});

test('a second re-anchor snapshot never replaces the first as signal authority', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The leader exits; the ONE exit-time snapshot records the surviving
    // member A. A spawns the unrecorded nephew R and exits: at the
    // signaling boundary the stored evidence ({A}) no longer validates,
    // so the entry fails closed — a SECOND process-table snapshot must
    // never refresh the evidence with R and make it signal authority.
    const descendantScript = [
      "import { spawn } from 'node:child_process';",
      "import { writeFile } from 'node:fs/promises';",
      'const nephewPidFile = process.argv[2];',
      'setTimeout(async () => {',
      "  const nephew = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
      '  await writeFile(nephewPidFile, String(nephew.pid));',
      '  process.exit(0);',
      '}, 400);',
      'setTimeout(() => {}, 60000);',
    ].join('\n');
    const descendantScriptPath = join(parent, 'wait-route-descendant-script.mjs');
    await writeFile(descendantScriptPath, descendantScript, 'utf8');
    const descendantPidFile = join(parent, 'descendant.pid');
    const nephewPidFile = join(parent, 'nephew.pid');
    const leaderScript = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const d = spawn(process.execPath, [process.env.WAIT_ROUTE_DESCENDANT_SCRIPT, process.env.WAIT_ROUTE_NEPHEW_FILE], { stdio: 'ignore' });",
      "writeFileSync(process.env.WAIT_ROUTE_DESCENDANT_FILE, String(d.pid));",
      'process.exit(0);',
    ].join('\n');
    const leader = spawn(process.execPath, ['-e', leaderScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, WAIT_ROUTE_DESCENDANT_SCRIPT: descendantScriptPath, WAIT_ROUTE_NEPHEW_FILE: nephewPidFile, WAIT_ROUTE_DESCENDANT_FILE: descendantPidFile },
    });
    let nephewPid = 0;
    try {
      registerOwnedChild(leader);
      for (const pidFile of [descendantPidFile, nephewPidFile]) {
        for (let waited = 0; waited < 8000; waited += 100) {
          const recorded = await readFile(pidFile, 'utf8').then(() => true, () => false);
          if (recorded) break;
          await sleep(100);
        }
      }
      const descendantPid = Number(await readFile(descendantPidFile, 'utf8').catch(() => '0'));
      nephewPid = Number(await readFile(nephewPidFile, 'utf8').catch(() => '0'));
      assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0, 'the leader must record its descendant pid');
      assert.ok(Number.isSafeInteger(nephewPid) && nephewPid > 0, 'the descendant must record the nephew pid');
      // FIRST snapshot: the descendant is alive and is recorded as the
      // group's evidence.
      reAnchorHostGroupEvidence(leader.pid);
      // The descendant exits; the unrecorded nephew keeps the group alive.
      assert.equal(await waitUntilSettled(descendantPid, 5_000), true, 'the descendant must exit after the first snapshot');
      // The duplicate exit-path snapshot: must NOT refresh the evidence.
      reAnchorHostGroupEvidence(leader.pid);
      assert.ok(ownedGroupsSnapshot().has(leader.pid),
        'the leader group must still be registered when the interrupt runs');
      const lines = [];
      handleDriverSignal('SIGINT', { exitImpl: () => {}, writeImpl: (line) => lines.push(line) });
      assert.match(lines.join(''), /0 owned process group/,
        'the stored evidence no longer validates: fail closed, never refresh');
      assert.equal(await waitUntilSettled(nephewPid, 500), false,
        'the unrecorded nephew must never be signaled by the refreshed evidence');
    } finally {
      try { leader.kill('SIGKILL'); } catch { /* already exited */ }
      const descendantPid = Number(await readFile(descendantPidFile, 'utf8').catch(() => '0'));
      if (descendantPid > 0) { try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already gone */ } }
      if (nephewPid > 0) { try { process.kill(nephewPid, 'SIGKILL'); } catch { /* already gone */ } }
      await waitUntilSettled(leader.pid, 5_000);
    }
  });
});

test('an in-budget marker grants the smoke even when later noise exceeds the budget', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The recorded worker prints the completion marker WITHIN the budget,
    // then an unowned detached writer adds noise after the deadline: the
    // marker's own arrival time governs the smoke grant — later unrelated
    // stdout must not retroactively invalidate an in-budget marker.
    const fakeCodex = await writeFakeCodex(parent, 'marker-then-late-noise');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({ caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 1_000, sourceCodexHome: sourceHome });
    assert.equal(summary.trace.markerObserved, true, JSON.stringify(summary));
    assert.equal(summary.trace.workerLaunches, 1, JSON.stringify(summary));
    assert.equal(summary.outcome, 'shell-smoke-completed', JSON.stringify(summary));
    assert.equal(summary.reason, 'observed-before-budget-expiry', JSON.stringify(summary));
  });
});

test('the smoke completes when the output directory has spaces and shell metacharacters', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The shell prompt names two absolute paths for the host's shell tool. A
    // perfectly valid directory name with spaces or shell metacharacters must
    // not split the command or trigger shell interpretation: both paths are
    // quoted for the selected shell.
    const fakeCodex = await writeFakeCodex(parent, 'shell');
    const sourceHome = await newSourceHome(parent);
    const output = join(parent, 'run; dir with $space');
    await mkdir(output, { mode: 0o700 });
    const summary = await runWaitRouteCase({ caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 25_000, sourceCodexHome: sourceHome });
    assert.equal(summary.outcome, 'shell-smoke-completed', JSON.stringify(summary));
    assert.equal(summary.trace.markerObserved, true);
    assert.equal(summary.trace.workerLaunches, 1);
    assert.equal(summary.trace.possibleDuplicateLaunch, false);
  });
});

test('settleOwnedTarget retains the direct-child fallback where process groups do not exist', { timeout: 20_000 }, async () => {
  // win32 has no process groups: an interrupt that only ever inspected
  // groups would forget every registered child WITHOUT signaling it and then
  // exit, abandoning the running host. The decision is factored into
  // settleOwnedTarget with an injectable platform so the direct-child
  // fallback stays honestly testable off-Windows; the real win32 process
  // behavior itself cannot be exercised on this host.
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    assert.equal(settleOwnedTarget(holder.pid, holder, 'win32'), true, 'the win32 branch must signal the retained direct-child handle');
    assert.equal(await waitUntilSettled(holder.pid, 5_000), true, 'the direct child must be settled by the fallback');
    assert.equal(settleOwnedTarget(holder.pid, null, 'win32'), false, 'without a retained child handle nothing can be signaled on win32');
  } finally {
    try { holder.kill('SIGKILL'); } catch { /* already settled */ }
  }
  const groupHolder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: true });
  try {
    assert.equal(settleOwnedTarget(groupHolder.pid, groupHolder), true, 'the POSIX branch signals the whole group');
    assert.equal(await waitUntilSettled(groupHolder.pid, 5_000), true, 'the POSIX branch settles the group members');
  } finally {
    try { groupHolder.kill('SIGKILL'); } catch { /* already settled */ }
  }
});

test('the shell worker command is shell-specific: POSIX quoting and a PowerShell call operator', () => {
  // POSIX form is unchanged: POSIX single-quoting around BOTH paths, no call
  // operator, and spaces or metacharacters stay inert literal text.
  assert.equal(
    buildShellWorkerCommand('/bin/Node', '/tmp/run; dir with $space/wait-route-worker.mjs', 'darwin'),
    `'/bin/Node' '/tmp/run; dir with $space/wait-route-worker.mjs'`,
    'the POSIX form must stay single-quoted with no call operator',
  );
  // win32 (Codex's default PowerShell): a bare quoted executable is a
  // PowerShell parser error, so the call operator must precede it; single
  // quotes are PowerShell's non-expanding form and embedded ones double.
  assert.equal(
    buildShellWorkerCommand('C:\\Program Files\\node.exe', 'C:\\temp\\run dir\\wait-route-worker.mjs', 'win32'),
    `& 'C:\\Program Files\\node.exe' 'C:\\temp\\run dir\\wait-route-worker.mjs'`,
    'the win32 form must carry the PowerShell call operator before the quoted executable',
  );
  assert.equal(
    buildShellWorkerCommand("C:\\o'brien\\node.exe", 'C:\\temp\\w.mjs', 'win32'),
    `& 'C:\\o''brien\\node.exe' 'C:\\temp\\w.mjs'`,
    'embedded single quotes must be doubled inside the non-expanding quotes',
  );
});

test('a spawn failure is a bounded instrument failure whose cleanup still runs', { timeout: 20_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // A regular executable file with no valid program image: argument
    // validation passes, the spawn itself fails, and the driver must still
    // run its finally-cleanup and reject with a closed instrument code.
    const badCodex = join(parent, 'bad-codex');
    await writeFile(badCodex, 'this is not an executable program image\n', { encoding: 'utf8', mode: 0o755 });
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    await expectErrorCode(
      runWaitRouteCase({ caseLabel: 'hook-entry', codexPath: badCodex, outputDir: output, budgetMs: 15_000, sourceCodexHome: sourceHome }),
      'WAIT_ROUTE_DRIVER_SPAWN_FAILED',
    );
    const leftovers = await readdir(output);
    assert.deepEqual(leftovers, ['trace'], 'the spawn-failure path must leave exactly the private trace behind');
  });
});

test('an occupied output directory is rejected with every pre-existing sentinel intact', { timeout: 30_000 }, async () => {
  await withTempDirectory(async (parent) => {
    const fakeCodex = await writeFakeCodex(parent, 'entry');
    const output = join(parent, 'occupied-run');
    await mkdir(output, { mode: 0o700 });
    // Sentinels in exactly the state-directory names the driver cleans up on
    // its own exits: a reused previous run directory must survive rejection.
    for (const name of ['codex-home', 'home', 'tmp', 'workspace', 'marketplace']) {
      await mkdir(join(output, name), { mode: 0o700 });
      await writeFile(join(output, name, 'sentinel.txt'), name, 'utf8');
    }
    // A pre-existing private trace with a LIVE recorded server whose startup
    // identity matches: the rejected invocation must never read that trace
    // for cleanup, or the recorded process would be signaled.
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      await mkdir(join(output, 'trace'), { mode: 0o700 });
      const sentinelTrace = join(output, 'trace', 'events.jsonl');
      await appendTraceEvent({
        runDirectory: join(output, 'trace'), runNonce: HEX_NONCE,
        event: { kind: 'server-started', serverPid: holder.pid, identityHash: fingerprintProcessIdentity(HEX_NONCE, captureProcessIdentity(holder.pid)) },
      });
      const traceBefore = await readFile(sentinelTrace, 'utf8');
      await expectErrorCode(
        runWaitRouteCase({ caseLabel: 'hook-entry', codexPath: fakeCodex, outputDir: output, budgetMs: 20_000 }),
        'WAIT_ROUTE_DRIVER_OUTPUT_NOT_EMPTY',
      );
      for (const name of ['codex-home', 'home', 'tmp', 'workspace', 'marketplace']) {
        await assert.doesNotReject(() => readFile(join(output, name, 'sentinel.txt'), 'utf8'),
          `the pre-existing ${name} sentinel must survive the rejection`);
      }
      assert.equal(await readFile(sentinelTrace, 'utf8'), traceBefore, 'the pre-existing trace must never be appended to');
      assert.equal(await waitUntilSettled(holder.pid, 500), false,
        'the pre-existing recorded server must never be signaled by a rejected invocation');
    } finally {
      try { holder.kill('SIGKILL'); } catch { /* already settled */ }
    }
    await waitUntilSettled(holder.pid, 5_000);
  });
});

test('cleanup ownership verifies exit, refuses unverified identities, and terminates only verified servers', { timeout: 20_000 }, async () => {
  await withTempDirectory(async (parent) => {
    const traceDir = join(parent, 'trace');
    // No server-started event: nothing to own.
    assert.equal(await ensureServerExitByTrace({ runDirectory: traceDir, runNonce: HEX_NONCE, graceMs: 300 }), 'not-started');
    // A dead recorded pid is verified exited without signaling; identity is
    // only consulted before a signal.
    await appendTraceEvent({ runDirectory: traceDir, runNonce: HEX_NONCE, event: { kind: 'server-started', serverPid: 2_000_000_000 } });
    assert.equal(await ensureServerExitByTrace({ runDirectory: traceDir, runNonce: HEX_NONCE, graceMs: 300 }), 'verified-exited');
    if (posix) {
      const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
      try {
        // A live process recorded WITHOUT a startup identity must never be
        // signaled: identity verification fails closed.
        await appendTraceEvent({ runDirectory: join(parent, 'trace-2'), runNonce: HEX_NONCE, event: { kind: 'server-started', serverPid: holder.pid } });
        assert.equal(await ensureServerExitByTrace({ runDirectory: join(parent, 'trace-2'), runNonce: HEX_NONCE, graceMs: 300 }), 'unresolved',
          'a recorded server without a startup identity must never be signaled');
        // A live process whose recorded startup identity does not match the
        // running process (e.g. a recycled pid) must never be signaled —
        // even when the command name still looks like the Node binary.
        await appendTraceEvent({
          runDirectory: join(parent, 'trace-3'), runNonce: HEX_NONCE,
          event: { kind: 'server-started', serverPid: holder.pid, identityHash: fingerprintProcessIdentity(HEX_NONCE, 'not-a-real-kernel-start|ppid=1|comm=node') },
        });
        assert.equal(await ensureServerExitByTrace({ runDirectory: join(parent, 'trace-3'), runNonce: HEX_NONCE, graceMs: 300 }), 'unresolved',
          'a recorded server whose captured identity does not match must never be signaled');
        let alive = true;
        try { process.kill(holder.pid, 0); } catch { alive = false; }
        assert.ok(alive, 'the unverified process must survive the refusals');
        // A live node server recorded WITH its real captured startup identity
        // is terminated.
        await appendTraceEvent({
          runDirectory: join(parent, 'trace-4'), runNonce: HEX_NONCE,
          event: { kind: 'server-started', serverPid: holder.pid, identityHash: fingerprintProcessIdentity(HEX_NONCE, captureProcessIdentity(holder.pid)) },
        });
        assert.equal(await ensureServerExitByTrace({ runDirectory: join(parent, 'trace-4'), runNonce: HEX_NONCE, graceMs: 300 }), 'terminated');
      } finally {
        try { holder.kill('SIGKILL'); } catch { /* already gone */ }
      }
      await waitUntilSettled(holder.pid, 5_000);
    }
  });
});

test('process inspection resolves fixed absolute candidates, never a PATH shadow', async (t) => {
  await withTempDirectory(async (parent) => {
    if (skipFakeHostOnWindows(t)) return;
    const shadowDir = join(parent, 'shadow-bin');
    await mkdir(shadowDir, { mode: 0o700 });
    const shadowPs = join(shadowDir, 'ps');
    await writeFile(shadowPs, '#!/bin/sh\necho shadowed\n', { encoding: 'utf8', mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${shadowDir}:${originalPath ?? ''}`;
    try {
      // Membership in the fixed candidates (not equality with the first one):
      // on usrmerge systems /bin/ps is a symlink, so the resolver correctly
      // falls through to /usr/bin/ps. The shadow-path inequality is the actual
      // discriminator — a PATH-resolving implementation would return the
      // shadow and fail both assertions.
      const resolved = resolveProcessInspectionExecutable();
      assert.ok(PROCESS_INSPECTION_CANDIDATES.includes(resolved),
        'the resolver must pick one of the fixed absolute candidates');
      assert.notEqual(resolved, shadowPs,
        'a shadowing ps on the caller\'s PATH must not win over the fixed candidates');
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
});

test('the interrupt path signals owned process groups and flushes a bounded notice', { timeout: 20_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: true });
    try {
      registerOwnedChild(holder);
      const lines = [];
      const notice = handleDriverSignal('SIGINT', { exitImpl: () => {}, writeImpl: (line) => lines.push(line) });
      assert.equal(await waitUntilSettled(holder.pid, 5_000), true, 'the interrupt handler must settle owned process groups');
      const written = lines.join('');
      assert.match(written, /SIGINT/, 'the notice must name the received signal');
      assert.match(written, /1 owned process group/, 'the notice must bound the signaled count');
      assert.equal(notice, lines[0], 'the handler returns exactly the notice it wrote');
      assert.ok(!written.includes(parent), 'the notice must stay redacted of private paths');
      assert.equal(handleDriverSignal('SIGINT', { exitImpl: () => {}, writeImpl: (line) => lines.push(line) }).match(/(\d+) owned/)?.[1], '0',
        'a second interrupt is idempotent: already-settled groups are not signaled again');
    } finally {
      try { holder.kill('SIGKILL'); } catch { /* already settled */ }
    }
    // The once-guard is observable: the first install adds exactly one SIGINT
    // and one SIGTERM listener (harmless no-op impls via the injectable seam),
    // and a second install must add none. Installed listeners are removed so
    // the test-runner process is left exactly as it was found.
    const listenersBefore = {
      SIGINT: process.listeners('SIGINT'),
      SIGTERM: process.listeners('SIGTERM'),
    };
    try {
      const noop = () => {};
      installDriverSignalHandlers({ exitImpl: noop, writeImpl: noop });
      assert.equal(process.listenerCount('SIGINT'), listenersBefore.SIGINT.length + 1,
        'the first install adds exactly one SIGINT handler');
      assert.equal(process.listenerCount('SIGTERM'), listenersBefore.SIGTERM.length + 1,
        'the first install adds exactly one SIGTERM handler');
      installDriverSignalHandlers({ exitImpl: noop, writeImpl: noop });
      assert.equal(process.listenerCount('SIGINT'), listenersBefore.SIGINT.length + 1,
        'a second install must not add another SIGINT handler (once-guard)');
      assert.equal(process.listenerCount('SIGTERM'), listenersBefore.SIGTERM.length + 1,
        'a second install must not add another SIGTERM handler (once-guard)');
    } finally {
      for (const signalName of ['SIGINT', 'SIGTERM']) {
        for (const listener of process.listeners(signalName)) {
          if (!listenersBefore[signalName].includes(listener)) process.removeListener(signalName, listener);
        }
      }
    }
  });
});

test('a cleanup command spawn failure is contained: state dirs still go and failures are recorded', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    const fakeCodex = await writeFakeCodex(parent, 'self-delete');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({ caseLabel: 'hook-entry', codexPath: fakeCodex, outputDir: output, budgetMs: 20_000, sourceCodexHome: sourceHome });
    assert.equal(summary.outcome, 'server-not-started', JSON.stringify(summary));
    assert.deepEqual(summary.cleanup.failures, ['plugin-remove-failed', 'marketplace-remove-failed'],
      'both cleanup commands that could no longer spawn are recorded as failures');
    assert.equal(summary.cleanup.isolatedHomeRemoved, true, 'state-dir removal still runs after a cleanup spawn failure');
    assert.equal(summary.cleanup.marketplaceRemoved, false, 'a failed removal is never reported as done');
    const leftovers = await readdir(output);
    assert.deepEqual(leftovers, ['trace'], 'the contained failure must leave exactly the private trace behind');
  });
});

test('the shell-window smoke runs the harmless worker with no plugin install', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    const fakeCodex = await writeFakeCodex(parent, 'shell');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({ caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 25_000, sourceCodexHome: sourceHome });
    assert.equal(summary.outcome, 'shell-smoke-completed', JSON.stringify(summary));
    assert.equal(summary.trace.markerObserved, true);
    assert.equal(summary.trace.possibleDuplicateLaunch, false);
    assert.equal(summary.cleanup.marketplaceRemoved, false, 'the shell smoke never installs the probe plugin');
    assert.equal(summary.cleanup.isolatedHomeRemoved, true);
    assert.ok(!JSON.stringify(summary).includes(output), 'the summary must be redacted of private paths');
  });
});

test('a second synthetic launch is flagged by the smoke, never silently accepted', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // A fake host that launches the worker twice produces two worker-bearing
    // stdout events; the smoke must flag the duplicate instead of passing.
    const fakeCodexPath = join(parent, 'fake-codex-dup.mjs');
    const body = [
      `#!${process.execPath}`,
      'import { spawn } from "node:child_process";',
      'const args = process.argv.slice(2);',
      'if (args.includes("--version")) { process.stdout.write("codex-cli 0.159.2 (wait-route fixture fake)\\n"); process.exit(0); }',
      'if (args.join(" ").includes("plugin")) { process.stdout.write("{}\\n"); process.exit(0); }',
      'if (args[0] === "exec") {',
      `  const escaped = ${JSON.stringify(WORKER_FILE_NAME.replace('.', '\\.'))};`,
      '  const joined = args.join(" ");',
      '  // Same extraction as the driver-launched fake host: the shell command',
      '  // quotes both paths, so the single-quoted form wins when present.',
      `  const match = joined.match(new RegExp("'([^']*" + escaped + ")'")) || joined.match(new RegExp("(\\\\S+" + escaped + ")"));`,
      '  const worker = match ? (match[1] ?? match[0]) : null;',
      '  if (!worker) process.exit(4);',
      '  for (let index = 0; index < 2; index += 1) {',
      '    await new Promise((resolve, reject) => {',
      '      const child = spawn(process.execPath, [worker], { stdio: "inherit" });',
      '      child.on("exit", resolve); child.on("error", reject);',
      '    });',
      '  }',
      `  process.stdout.write(JSON.stringify({ final: ${JSON.stringify(COMPLETION_MARKER)} }) + "\\n");`,
      '  process.exit(0);',
      '}',
      'process.exit(2);',
      '',
    ].join('\n');
    await writeFile(fakeCodexPath, body, { encoding: 'utf8', mode: 0o755 });
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({ caseLabel: 'shell-window', codexPath: fakeCodexPath, outputDir: output, budgetMs: 25_000, sourceCodexHome: sourceHome });
    assert.equal(summary.outcome, 'inconclusive');
    assert.equal(summary.reason, 'duplicate-launch');
    assert.equal(summary.trace.possibleDuplicateLaunch, true, 'a duplicate launch must be flagged');
  });
});

test('the smoke requires worker execution evidence, not just the marker', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // A host stream that merely prints the completion marker — a model
    // response or another command — must never pass as a completed smoke:
    // only the worker's own launch log corroborates execution.
    const fakeCodex = await writeFakeCodex(parent, 'marker-only');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({ caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 25_000, sourceCodexHome: sourceHome });
    assert.equal(summary.trace.markerObserved, true, 'the marker alone must be observed but insufficient');
    assert.equal(summary.trace.workerLaunches, 0, 'the worker never launched');
    assert.notEqual(summary.outcome, 'shell-smoke-completed', 'the marker without worker evidence must not qualify the smoke');
    assert.equal(summary.outcome, 'inconclusive');
    assert.equal(summary.reason, 'worker-launch-evidence-missing');
  });
});

test('a torn launch record fails the smoke closed even with one valid launch', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // One valid launch record plus a torn trailing record is INCOMPLETE
    // evidence: the worker launched once, but the log cannot prove there
    // was no second launch, so the smoke must fail closed instead of
    // treating the single valid record as complete execution evidence.
    const fakeCodex = await writeFakeCodex(parent, 'torn-launch-log');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({ caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 25_000, sourceCodexHome: sourceHome });
    assert.equal(summary.trace.markerObserved, true, 'the marker must still be observed');
    assert.equal(summary.trace.workerLaunches, 1, 'exactly one valid launch record must be counted');
    assert.notEqual(summary.outcome, 'shell-smoke-completed', 'incomplete launch evidence must never qualify the smoke');
    assert.equal(summary.outcome, 'inconclusive');
    assert.equal(summary.reason, 'worker-launch-evidence-missing');
  });
});

test('authority and lifecycle cases report explicit not-instrumented outcomes', { timeout: 20_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    const fakeCodex = await writeFakeCodex(parent, 'entry');
    for (const caseLabel of ['authority', 'lifecycle']) {
      const output = join(parent, `${caseLabel}-run`);
      await mkdir(output, { mode: 0o700 });
      const summary = await runWaitRouteCase({ caseLabel, codexPath: fakeCodex, outputDir: output, budgetMs: 20_000 });
      assert.equal(summary.outcome, 'not-instrumented');
      assert.match(summary.reason, /candidate/);
      assert.equal(summary.cleanup.isolatedHomeRemoved, true);
    }
  });
});

// ---------------------------------------------------------------------------
// Task 3: configured shell observation windows. These tests cover the
// instrument seams only: the worker's duration/noise/signal modes, the
// fixture-only cap and synthetic-Role config options, the bounded session
// summarizer, and the driver's profile prompt/classification against a FAKE
// host. No live host, model, or provider run starts from these tests.
// ---------------------------------------------------------------------------

/** Spawns the generated fixture worker directly through process.execPath. */
async function spawnWorker(workerPath, workerArgs) {
  const child = spawn(process.execPath, [workerPath, ...workerArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  /** @type {number|null} */
  let code = null;
  /** @type {NodeJS.Signals|null} */
  let signal = null;
  await new Promise((resolveExit) => {
    child.on('exit', (exitCode, exitSignal) => { code = exitCode; signal = exitSignal; resolveExit(null); });
    child.on('error', () => { code = null; resolveExit(null); });
  });
  return { child, stdout, code, signal, pid: child.pid ?? null };
}

test('the fixture worker honors an exact duration before printing the completion marker', { timeout: 20_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    const fixture = await buildWaitRouteFixture({ outputDir: await newRunDirectory(parent), serverPath: serverModulePath });
    const startedAt = Date.now();
    const early = await new Promise((resolveEarly) => {
      const child = spawn(process.execPath, [fixture.workerPath, '--duration-ms', '900'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { output += chunk; });
      setTimeout(() => resolveEarly({ at: Date.now(), output }), 350);
      child.on('exit', () => {});
    });
    assert.equal(early.output.includes(COMPLETION_MARKER), false, 'the marker must not appear before the requested duration');
    const result = await spawnWorker(fixture.workerPath, ['--duration-ms', '900']);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.includes(COMPLETION_MARKER), true);
    assert.ok(Date.now() - startedAt >= 900, 'the worker must actually wait the requested duration');
  });
});

test('the fixture worker noise output never contains the completion marker', { timeout: 20_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    const fixture = await buildWaitRouteFixture({ outputDir: await newRunDirectory(parent), serverPath: serverModulePath });
    const result = await spawnWorker(fixture.workerPath, ['--duration-ms', '1200', '--noise-interval-ms', '100']);
    assert.equal(result.code, 0);
    const lines = result.stdout.split('\n').filter((line) => line.length > 0);
    const noiseLines = lines.filter((line) => !line.includes(COMPLETION_MARKER));
    assert.ok(noiseLines.length >= 5, `expected noisy output, got ${noiseLines.length} noise lines`);
    for (const line of noiseLines) {
      assert.equal(line.includes(COMPLETION_MARKER), false, 'a noise line must never contain the completion marker');
    }
    assert.equal(lines.filter((line) => line.includes(COMPLETION_MARKER)).length, 1, 'exactly one completion marker line');
    assert.equal(lines.at(-1)?.includes(COMPLETION_MARKER), true, 'the marker is the terminal line');
    const { records } = await readWorkerLaunchRecords(join(dirname(fixture.workerPath), 'worker-launches.jsonl'));
    assert.equal(records.length, 1, 'exactly one launch record: the noisy worker must not launch twice');
    assert.equal(records[0].pid, result.pid, 'the launch record carries the exact spawned process identity');
  });
});

for (const [signalName, expectedCode] of [['SIGTERM', 143], ['SIGINT', 130]]) {
  test(`the fixture worker handles ${signalName} gracefully with a distinct signal marker`, { timeout: 20_000 }, async (t) => {
    if (skipFakeHostOnWindows(t)) return;
    await withTempDirectory(async (parent) => {
      const fixture = await buildWaitRouteFixture({ outputDir: await newRunDirectory(parent), serverPath: serverModulePath });
      const child = spawn(process.execPath, [fixture.workerPath, '--duration-ms', '30000'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      await sleep(300);
      const signalAt = Date.now();
      child.kill(signalName);
      /** @type {number|null} */
      let code = null;
      await new Promise((resolveExit) => { child.once('exit', (exitCode) => { code = exitCode; resolveExit(null); }); });
      assert.ok(code === expectedCode, `expected graceful exit code ${expectedCode}, got ${code}`);
      assert.ok(Date.now() - signalAt < 5000, 'the worker must exit promptly on the signal, never run to its duration');
      assert.ok(stdout.includes(`${WORKER_SIGNALLED_MARKER_PREFIX} ${signalName}`), 'the worker must record the signal distinctly');
      assert.equal(stdout.includes(COMPLETION_MARKER), false, 'an interrupted run must never print the completion marker');
    });
  });
}

test('the fixture worker rejects invalid profile arguments', { timeout: 20_000 }, async () => {
  await withTempDirectory(async (parent) => {
    const fixture = await buildWaitRouteFixture({ outputDir: await newRunDirectory(parent), serverPath: serverModulePath });
    const result = await spawnWorker(fixture.workerPath, ['--duration-ms', 'not-a-number']);
    assert.equal(result.code, 2, 'invalid profile arguments must fail closed');
    assert.equal(result.stdout.includes(COMPLETION_MARKER), false);
  });
});

test('the fixture config can declare a raised background terminal cap', async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    const codexHome = join(parent, 'codex-home-a');
    await mkdir(codexHome, { mode: 0o700 });
    const { configPath } = await writeFixtureConfig({ codexHome, backgroundTerminalMaxTimeoutMs: 3_600_000 });
    const body = await readFile(configPath, 'utf8');
    assert.match(body, /background_terminal_max_timeout = 3600000/, 'the raised cap must be declared');
    assert.match(body, /\[features\]\nhooks = true/, 'the hooks feature stays enabled');
    const codexHomeDefault = join(parent, 'codex-home-b');
    await mkdir(codexHomeDefault, { mode: 0o700 });
    const defaultConfig = await writeFixtureConfig({ codexHome: codexHomeDefault });
    const defaultBody = await readFile(defaultConfig.configPath, 'utf8');
    assert.doesNotMatch(defaultBody, /background_terminal_max_timeout/, 'the default fixture config must not declare a cap');
  });
});

test('the fixture config rejects invalid cap and role options', async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    const codexHome = join(parent, 'codex-home');
    await mkdir(codexHome, { mode: 0o700 });
    for (const cap of [4999, 3_600_001, 1500.5, Number.NaN]) {
      await expectErrorCode(
        writeFixtureConfig({ codexHome, backgroundTerminalMaxTimeoutMs: cap }),
        'WAIT_ROUTE_FIXTURE_CONFIG_CAP_INVALID',
      );
    }
    await expectErrorCode(
      writeFixtureConfig({ codexHome, agentRoles: [{ name: 'x', description: '', configPath: '/tmp/role.toml' }] }),
      'WAIT_ROUTE_FIXTURE_CONFIG_ROLE_INVALID',
    );
    // Every rejection above must have refused to write anything.
    const entries = await readdir(codexHome);
    assert.deepEqual(entries, [], 'a rejected fixture config must not leave a config.toml behind');
  });
});

test('the synthetic role fixture writes a clearly labeled probe-only role file', async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    const built = await buildWaitRouteSyntheticRole({ outputDir: parent });
    assert.equal(built.roleName, SYNTHETIC_ROLE_NAME);
    const body = await readFile(built.rolePath, 'utf8');
    assert.match(body, /background_terminal_max_timeout = 3600000/, 'the synthetic role declares the raised cap');
    assert.match(body, new RegExp(`name = "${SYNTHETIC_ROLE_NAME}"`), 'the role file names the synthetic role');
    assert.match(body, /SYNTHETIC PROBE-ONLY/, 'the role file is clearly labeled as a synthetic probe control');
  });
});

test('the session summarizer counts model decisions from a bounded rollout', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions', '2026', '10', '01');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'meta' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'PRIVATE ASSISTANT TEXT that must never be retained' }] } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: "PRIVATECMD 'node' 'worker'", yield_time_ms: 30000 }), call_id: 'call_a' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:32.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_a', output: '{"output":"PRIVATE OUTPUT","status":"timeout"}' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:33.000Z', type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', arguments: JSON.stringify({ input: '', yield_time_ms: 60000 }), call_id: 'call_b' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:33.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_b', output: '{}' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:34.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [] } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: join(parent, 'sessions') });
    assert.equal(summary.present, true);
    assert.equal(summary.files, 1);
    assert.equal(summary.truncated, false);
    assert.equal(summary.assistantMessages, 1);
    assert.equal(summary.reasoningItems, 1);
    assert.equal(summary.functionCalls, 2);
    assert.equal(summary.functionCallOutputs, 2);
    assert.equal(summary.initialExecCalls, 1);
    assert.equal(summary.emptyPolls, 1);
    assert.equal(summary.otherFunctionCalls, 0);
    assert.deepEqual(summary.requestedYieldsMs, [30000, 60000]);
    assert.equal(summary.parallelToolCallViolations, 0, 'a strict call/output alternation has no parallel poll');
    assert.equal(summary.firstFunctionCallAtMs, Date.parse('2026-10-01T00:00:02.000Z'));
    assert.equal(summary.firstEmptyPollAtMs, Date.parse('2026-10-01T00:00:33.000Z'));
    assert.equal(summary.lastFunctionCallOutputAtMs, Date.parse('2026-10-01T00:01:33.000Z'));
    const serialized = JSON.stringify(summary);
    assert.equal(serialized.includes('PRIVATE'), false, 'the summary must retain no rollout content');
    assert.deepEqual(summary.toolNames, { exec_command: 1, write_stdin: 1 });
  });
});

test('the session summarizer flags a parallel second poll while the first is pending', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', arguments: JSON.stringify({ input: '', yield_time_ms: 60000 }), call_id: 'call_a' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:03.000Z', type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', arguments: JSON.stringify({ input: '', yield_time_ms: 60000 }), call_id: 'call_b' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:03.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_a', output: '{}' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:04.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_b', output: '{}' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.emptyPolls, 2);
    assert.equal(summary.parallelToolCallViolations, 1, 'the second poll while the first was pending must be flagged');
  });
});

test('the session summarizer reports bounds and absent directories honestly', async () => {
  await withTempDirectory(async (parent) => {
    const absent = await summarizeCodexSessions({ sessionsDirectory: join(parent, 'missing') });
    assert.equal(absent.present, false);
    assert.equal(absent.files, 0);
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    for (const name of ['a.jsonl', 'b.jsonl']) {
      await writeFile(join(sessions, name), `${JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } })}\n`, { encoding: 'utf8', mode: 0o600 });
    }
    const capped = await summarizeCodexSessions({ sessionsDirectory: sessions, maxFiles: 1 });
    assert.equal(capped.files, 1, 'the file cap bounds the scan');
    assert.equal(capped.truncated, true, 'crossing the file cap reports truncation');
    await writeFile(join(sessions, 'big.jsonl'), `x${'y'.repeat(4096)}\n`, { encoding: 'utf8', mode: 0o600 });
    const bounded = await summarizeCodexSessions({ sessionsDirectory: sessions, maxFiles: 16, maxLineBytes: 1024 });
    assert.equal(bounded.truncated, true, 'an oversized rollout line reports truncation');
  });
});

test('parseDriverArguments accepts the Task 3 profile flags with closed validation', async () => {
  await withTempDirectory(async (parent) => {
    const codex = join(parent, 'codex');
    await writeFile(codex, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const output = await newRunDirectory(parent);
    const parsed = parseDriverArguments([
      '--case', 'shell-window', '--codex', codex, '--output-dir', output, '--budget-ms', '60000',
      '--worker-duration-ms', '420000', '--worker-noise-interval-ms', '2000',
      '--exec-yield-ms', '30000', '--poll-yield-ms', '3600000',
      '--background-terminal-max-timeout-ms', '3600000',
    ]);
    assert.equal(parsed.workerDurationMs, 420000);
    assert.equal(parsed.workerNoiseIntervalMs, 2000);
    assert.equal(parsed.execYieldMs, 30000);
    assert.equal(parsed.pollYieldMs, 3600000);
    assert.equal(parsed.backgroundTerminalMaxTimeoutMs, 3600000);
    const bare = parseDriverArguments(['--case', 'shell-window', '--codex', codex, '--output-dir', output, '--budget-ms', '60000']);
    assert.equal(bare.workerDurationMs, 0, 'absent profile flags default to the current immediate-worker behavior');
    assert.equal(bare.backgroundTerminalMaxTimeoutMs, 0, 'absent cap flag keeps the fixture default configuration');
    for (const argv of [
      ['--case', 'shell-window', '--codex', codex, '--output-dir', output, '--budget-ms', '60000', '--worker-duration-ms', '-1'],
      ['--case', 'shell-window', '--codex', codex, '--output-dir', output, '--budget-ms', '60000', '--worker-duration-ms', '1500.5'],
      ['--case', 'shell-window', '--codex', codex, '--output-dir', output, '--budget-ms', '60000', '--worker-noise-interval-ms', '60001'],
      ['--case', 'shell-window', '--codex', codex, '--output-dir', output, '--budget-ms', '60000', '--exec-yield-ms', '249'],
      ['--case', 'shell-window', '--codex', codex, '--output-dir', output, '--budget-ms', '60000', '--poll-yield-ms', '3600001'],
      ['--case', 'shell-window', '--codex', codex, '--output-dir', output, '--budget-ms', '60000', '--background-terminal-max-timeout-ms', '4999'],
      ['--case', 'hook-entry', '--codex', codex, '--output-dir', output, '--budget-ms', '60000', '--poll-yield-ms', '60000'],
    ]) {
      try {
        parseDriverArguments(argv);
        assert.fail(`expected ${JSON.stringify(argv)} to be rejected`);
      } catch (error) {
        assert.match(String(error.code ?? error.message), /WAIT_ROUTE_DRIVER_PROFILE_INVALID/);
      }
    }
  });
});

test('the shell-window profile run classifies a noisy completed run and echoes its profile', { timeout: 40_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    const fakeCodex = await writeFakeCodex(parent, 'shell-profile');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({
      caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 30_000, sourceCodexHome: sourceHome,
      workerDurationMs: 1200, workerNoiseIntervalMs: 100, execYieldMs: 30000, pollYieldMs: 60000,
    });
    assert.equal(summary.outcome, 'shell-smoke-completed', JSON.stringify(summary));
    assert.equal(summary.trace.markerObserved, true, 'the marker is observed despite the noise');
    assert.equal(summary.trace.workerLaunches, 1, 'noisy output must not cause a second launch');
    assert.deepEqual(summary.requestedProfile, { workerDurationMs: 1200, workerNoiseIntervalMs: 100, execYieldMs: 30000, pollYieldMs: 60000 });
    assert.equal(summary.fixture.backgroundTerminalMaxTimeoutMs, null, 'no cap declared without the flag');
    assert.equal(summary.session.present, false, 'a fake host writes no session rollouts');
    assert.equal(summary.session.files, 0);
    assert.ok(!JSON.stringify(summary).includes(output), 'the summary must be redacted of private paths');
  });
});

test('the noisy held run is budget-interrupted without a false completion', { timeout: 30_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    const fakeCodex = await writeFakeCodex(parent, 'shell-profile');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({
      caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 2_500, sourceCodexHome: sourceHome,
      workerDurationMs: 30000, workerNoiseIntervalMs: 200, execYieldMs: 30000, pollYieldMs: 60000,
    });
    assert.equal(summary.outcome, 'budget-exhausted', JSON.stringify(summary));
    assert.equal(summary.reason, 'observation-budget-exhausted');
    assert.equal(summary.trace.markerObserved, false, 'interrupted noisy output must never be mistaken for the terminal marker');
    assert.notEqual(summary.cleanup.workerExit, 'unresolved', 'the bounded interruption settles the recorded worker');
  });
});

test('a launched worker whose own record disagrees with the requested profile is inconclusive', { timeout: 40_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The fake host DROPS the requested --duration-ms: the worker records
    // its actual (default) duration, and the case must not report a clean
    // smoke under the requested profile's remaining-lifetime math.
    const fakeCodex = await writeFakeCodex(parent, 'shell-profile-altered');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({
      caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 30_000, sourceCodexHome: sourceHome,
      workerDurationMs: 1200, workerNoiseIntervalMs: 0, execYieldMs: 30000, pollYieldMs: 60000,
    });
    assert.equal(summary.outcome, 'inconclusive', JSON.stringify(summary));
    assert.equal(summary.reason, 'worker-profile-mismatch');
  });
});

test('the role-control case prepares the synthetic role and completes under the fake host', { timeout: 40_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    const fakeCodex = await writeFakeCodex(parent, 'role-control');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    const summary = await runWaitRouteCase({
      caseLabel: 'role-control', codexPath: fakeCodex, outputDir: output, budgetMs: 30_000, sourceCodexHome: sourceHome,
      workerDurationMs: 1000, workerNoiseIntervalMs: 0, execYieldMs: 30000, pollYieldMs: 60000,
    });
    assert.equal(summary.outcome, 'role-control-completed', JSON.stringify(summary));
    assert.equal(summary.fixture.agentRoles.includes(SYNTHETIC_ROLE_NAME), true, 'the synthetic role is registered in the fixture config');
    assert.equal(summary.fixture.multiAgentFeature, true, 'the collab feature is enabled for the role control');
    assert.equal(summary.trace.workerLaunches, 1);
    assert.equal(summary.cleanup.isolatedHomeRemoved, true);
    assert.ok(!JSON.stringify(summary).includes(output), 'the summary must be redacted of private paths');
  });
});

test('the session summarizer classifies the custom exec tool calls of newer hosts', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: `const r = await tools.exec_command({cmd:"'node' 'worker' --duration-ms 420000",yield_time_ms:30000});text(r.output);\n` } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:32.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'Script completed\nWall time 0.0 seconds\n' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:33.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'const r = await tools.write_stdin({id:"s1",input:"",yield_time_ms:60000});text(r.output);\n' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:33.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'still running\n' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.functionCalls, 2);
    assert.equal(summary.functionCallOutputs, 2);
    assert.equal(summary.initialExecCalls, 1, 'the custom exec_command shape counts as the initial exec');
    assert.equal(summary.emptyPolls, 1, 'the custom write_stdin shape with empty input counts as the empty poll');
    assert.deepEqual(summary.requestedYieldsMs, [30000, 60000]);
    assert.equal(summary.parallelToolCallViolations, 0);
    assert.equal(summary.firstEmptyPollAtMs, Date.parse('2026-10-01T00:00:33.000Z'));
    assert.equal(summary.lastFunctionCallOutputAtMs, Date.parse('2026-10-01T00:01:33.000Z'));
    assert.equal(JSON.stringify(summary).includes('worker'), false, 'no command text is retained');
  });
});

test('shell cases run the host with process inspection available, never the denied workspace sandbox', async () => {
  // The installed 0.160.0 workspace-write sandbox denies /bin/ps (exit 126),
  // so the worker's process-identity evidence is structurally unavailable
  // under it. The shell cases must select the flag set that keeps the
  // instrument's identity evidence working; this seam pins that choice.
  const { EXEC_FLAG_SELECTIONS } = await import('../tools/wait-route-probe/driver.mjs');
  assert.ok(EXEC_FLAG_SELECTIONS.shell.includes('--dangerously-bypass-approvals-and-sandbox'), 'shell cases bypass the sandbox that denies ps');
  assert.equal(EXEC_FLAG_SELECTIONS.shell.includes('-s'), false, 'shell cases do not pass a conflicting -s mode');
  assert.ok(EXEC_FLAG_SELECTIONS.hookEntry.includes('-s', 'workspace-write'), 'the hook case keeps its Task 2 flags');
});

test('the session summarizer samples per-call timing for clamp analysis', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.exec_command({cmd:"x",yield_time_ms:30000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:05:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'running' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:05:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'const r = await tools.write_stdin({id:"s",input:"",yield_time_ms:3600000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:10:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'still running' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.deepEqual(summary.calls, [
      { atMs: Date.parse('2026-10-01T00:00:02.000Z'), kind: 'initial-exec', name: 'exec', yieldTimeMs: 30000 },
      { atMs: Date.parse('2026-10-01T00:05:03.000Z'), kind: 'empty-poll', name: 'exec', yieldTimeMs: 3600000 },
    ], 'per-call samples carry the requested yield and the call time for clamp analysis');
    assert.equal(summary.callsTruncated, false);
  });
});

test('the session summarizer never classifies quoted or commented operation mentions as shell operations', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // The script PRINTS a write_stdin mention and COMMENTS an exec_command:
      // neither is a shell operation, so neither may be classified as one
      // and neither may supply child-execution evidence.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: `text('write_stdin({id:"s",input:""})');\n// exec_command({cmd:"echo fake"})\n` } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'ok' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.initialExecCalls, 0, 'a commented exec_command mention is not an initial exec');
    assert.equal(summary.emptyPolls, 0, 'a quoted write_stdin mention is not an empty poll');
    assert.equal(summary.otherFunctionCalls, 1, 'the unclassifiable script stays counted as other');
  });
});

test('the session summarizer leaves indirect write_stdin arguments unclassified', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // Indirect argument shapes: a bare identifier or a spread object can
      // carry a nonempty input the rollout never shows, so the absence of a
      // literal `chars`/`input` key is NOT proof of an empty poll.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.write_stdin(pollArgs);text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'ok' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'const r = await tools.write_stdin({...pollArgs});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:05.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'ok' } }),
      // The positive control: a self-contained literal object with an empty
      // input IS an empty poll.
      JSON.stringify({ timestamp: '2026-10-01T00:00:06.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c3', input: 'const r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:07.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c3', output: 'ok' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.emptyPolls, 1, 'only the self-contained literal argument object counts as the empty poll');
    assert.equal(summary.otherFunctionCalls, 2, 'indirect argument shapes stay unclassified');
  });
});

test('the session summarizer keeps a yielded initial-exec script pending', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // The initial exec_command script YIELDS a cell: its inner operation
      // is still outstanding, so an overlapping second poll is a violation.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.exec_command({cmd:"x",yield_time_ms:30000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:32.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'Script running with cell ID 7\n' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:33.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'const r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:33.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'still running' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 1, 'the overlapping poll while the yielded cell is outstanding is a violation');
  });
});

test('the session summarizer preserves quoted yield keys (the documented @exec directive form)', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // The DOCUMENTED directive form quotes the key: the wrapper bound
      // must survive the string-stripped view and govern the call sample.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: '// @exec: {"yield_time_ms": 3600000}\nconst r = await tools.exec_command({cmd:"x",yield_time_ms:30000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:33.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      // A directive MENTION inside a cmd string VALUE is stripped content:
      // it must never be recorded as a requested yield.
      JSON.stringify({ timestamp: '2026-10-01T00:01:00.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'const r = await tools.exec_command({cmd:"echo // @exec: {\\"yield_time_ms\\": 120000}",yield_time_ms:30000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:31.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.requestedYieldsMs[0], 3600000, 'the quoted directive key survives stripping and records the wrapper bound');
    assert.deepEqual(summary.calls[0].yieldTimeMs, 3600000, 'the first (directive) yield governs the call sample');
    assert.equal(summary.requestedYieldsMs.includes(120000), false, 'a directive mention inside a cmd string value is stripped content');
    assert.equal(summary.requestedYieldsMs.filter((ms) => ms === 30000).length, 2, 'the inner bare-key yields are still recorded');
  });
});

test('role evidence requires the spawn arguments to name the synthetic role', async () => {  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const wrap = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    const meta = (id, parentId) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'session_meta', payload: { id, parent_thread_id: parentId } });
    const buildRoot = (agentType) => [
      meta('root-t'),
      wrap({ type: 'function_call', call_id: 'rc-spawn', name: 'spawn_agent', arguments: JSON.stringify({ agent_type: agentType }) }),
      wrap({ type: 'function_call_output', call_id: 'rc-spawn', output: 'ok' }),
    ].join('\n');
    // The child rollout carries the non-Root initial-exec evidence and the
    // parent-thread link both variants need; only the spawn ARGUMENTS differ.
    const childRollout = [
      meta('child-t', 'root-t'),
      wrap({ type: 'function_call', call_id: 'rc-exec', name: 'exec_command', arguments: JSON.stringify({ cmd: 'run the probe worker', yield_time_ms: 30000 }) }),
      wrap({ type: 'function_call_output', call_id: 'rc-exec', output: 'done' }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), childRollout, { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(sessions, 'rollout-root.jsonl'), buildRoot('default'), { encoding: 'utf8', mode: 0o600 });
    // roleChildProven receives the WAIT-ROUTE summary whose `session` field
    // carries the rollouts summary.
    const wrongRole = { session: await summarizeCodexSessions({ sessionsDirectory: sessions }) };
    assert.equal(roleChildProven(wrongRole), false, 'a spawn for a different role must not corroborate the managed-child lifecycle');
    await writeFile(join(sessions, 'rollout-root.jsonl'), buildRoot(SYNTHETIC_ROLE_NAME), { encoding: 'utf8', mode: 0o600 });
    const rightRole = { session: await summarizeCodexSessions({ sessionsDirectory: sessions }) };
    assert.equal(roleChildProven(rightRole), true, 'a spawn naming the synthetic role corroborates the lifecycle');
  });
});

test('child-execution attribution waits for Root resolution and the parent-linked child rollout', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const line = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    const meta = (id, parentId) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'session_meta', payload: parentId === undefined ? { id } : { id, parent_thread_id: parentId } });
    // A SINGLE Root rollout whose structured exec precedes its spawn_agent:
    // no child rollout exists, so the run proves nothing.
    const execThenSpawn = [
      meta('root-t'),
      line({ type: 'function_call', call_id: 'e1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'run the probe worker', yield_time_ms: 30000 }) }),
      line({ type: 'function_call_output', call_id: 'e1', output: 'done' }),
      line({ type: 'function_call', call_id: 's1', name: 'spawn_agent', arguments: JSON.stringify({ agent_type: SYNTHETIC_ROLE_NAME }) }),
      line({ type: 'function_call_output', call_id: 's1', output: JSON.stringify({ task_name: 'probe' }) }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-root.jsonl'), execThenSpawn, { encoding: 'utf8', mode: 0o600 });
    const noChild = { session: await summarizeCodexSessions({ sessionsDirectory: sessions }) };
    assert.equal(roleChildProven(noChild), false, 'a Root exec before the spawn marker must not become child-execution evidence');
    // A child rollout WITHOUT the parent link proves nothing either.
    const childNoMeta = [
      line({ type: 'function_call', call_id: 'e2', name: 'exec_command', arguments: JSON.stringify({ cmd: 'run the probe worker', yield_time_ms: 30000 }) }),
      line({ type: 'function_call_output', call_id: 'e2', output: 'done' }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), childNoMeta, { encoding: 'utf8', mode: 0o600 });
    const unlinkedChild = { session: await summarizeCodexSessions({ sessionsDirectory: sessions }) };
    assert.equal(roleChildProven(unlinkedChild), false, 'a child rollout without the parent-thread link must not corroborate the lifecycle');
    // With the parent link the run is proven (single synthetic spawn + its
    // output + the linked child's initial exec).
    await writeFile(join(sessions, 'rollout-child.jsonl'), `${meta('child-t', 'root-t')}\n${childNoMeta}`, { encoding: 'utf8', mode: 0o600 });
    const linkedChild = { session: await summarizeCodexSessions({ sessionsDirectory: sessions }) };
    assert.equal(roleChildProven(linkedChild), true, 'the parent-linked child rollout corroborates the managed-child lifecycle');
  });
});

test('role evidence never matches the synthetic role outside the role argument', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const line = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    const rootRollout = [
      line({ type: 'function_call', call_id: 's1', name: 'spawn_agent', arguments: JSON.stringify({ agent_type: 'default', message: `Please simulate ${SYNTHETIC_ROLE_NAME}` }) }),
      line({ type: 'function_call_output', call_id: 's1', output: JSON.stringify({ task_name: 'probe' }) }),
    ].join('\n');
    const childRollout = [
      line({ type: 'function_call', call_id: 'e1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'run the probe worker', yield_time_ms: 30000 }) }),
      line({ type: 'function_call_output', call_id: 'e1', output: 'done' }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), childRollout, { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(sessions, 'rollout-root.jsonl'), rootRollout, { encoding: 'utf8', mode: 0o600 });
    const summary = { session: await summarizeCodexSessions({ sessionsDirectory: sessions }) };
    assert.equal(roleChildProven(summary), false, 'a role mention in a non-role argument must not prove the synthetic spawn');
  });
});

test('completion clears only its own cell, preserving an unrelated outstanding yield', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // A yields cell 1; overlapping B completes WITHOUT yielding; B's
      // completion must not retire A. The subsequent poll C is therefore
      // the SECOND violation.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'a1', input: 'const r = await tools.exec_command({cmd:"x",yield_time_ms:30000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:32.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'a1', output: 'Script running with cell ID 1\n' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:33.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'b1', input: 'const r = await tools.exec_command({cmd:"y",yield_time_ms:30000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'b1', output: 'done' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'still running' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 2, 'the non-yielding completion must not retire the outstanding cell');
  });
});

test('a script carrying multiple observation operations reports the inner concurrency', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const [a, b] = await Promise.all([tools.write_stdin({id:"s1",input:"",yield_time_ms:60000}), tools.write_stdin({id:"s2",input:"",yield_time_ms:60000})]);text(a.output + b.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.emptyPolls, 2, 'each inner observation site is counted');
    assert.equal(summary.parallelToolCallViolations, 1, 'two observations inside one script call are the forbidden concurrency');
  });
});

test('receiver cardinality and longer key names stay honest', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // A SINGLETON receiver: exactly one invocation, no overlap.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: '[17].map(async () => await tools.write_stdin({session_id:17,chars:"",yield_time_ms:60000}));' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      // A longer property name ending in the yield key never overrides.
      JSON.stringify({ timestamp: '2026-10-01T00:00:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'const r = await tools.write_stdin({session_id:1,chars:"",yield_time_ms:60000,previous_yield_time_ms:5000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:05.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 0, 'a singleton receiver cannot overlap');
    assert.deepEqual(summary.requestedYieldsMs, [60000, 60000], 'each poll records its own yield; the longer property name never overrides it');
  });
});

test('computed cmd properties fail the invocation decode closed', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const line = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    const meta = (id, parentId) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'session_meta', payload: { id, parent_thread_id: parentId } });
    const exactCommand = "node '/tmp/run/wait-route-worker.mjs' --duration-ms 1000";
    const rootRollout = [
      meta('root-t'),
      line({ type: 'function_call', call_id: 's1', name: 'spawn_agent', arguments: JSON.stringify({ agent_type: SYNTHETIC_ROLE_NAME }) }),
      line({ type: 'function_call_output', call_id: 's1', output: 'ok' }),
    ].join('\n');
    // A computed property can override the cmd at runtime: fail closed.
    const computedChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `tools.exec_command({cmd:${JSON.stringify(exactCommand)},["cmd"]: "echo ${COMPLETION_MARKER}"});` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), computedChild, { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(sessions, 'rollout-root.jsonl'), rootRollout, { encoding: 'utf8', mode: 0o600 });
    const computed = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(computed), false, 'a computed cmd override voids the invocation decode');
  });
});

test('helper dispatch attribution stays per-dispatch and recognizes named callbacks', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // A polling helper dispatched through .map over two elements: overlap.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'async function poll() { const r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output); }\nawait Promise.all([1, 2].map(poll));' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      // Two SEQUENTIAL awaited dispatches of one invocation each: no overlap.
      JSON.stringify({ timestamp: '2026-10-01T00:01:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'async function poll() { const r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output); }\nawait Promise.all([poll()]);\nawait Promise.all([poll()]);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 1, 'the .map(poll) dispatch overlaps; sequential single-invocation dispatches do not');
  });
});

test('command decoding runs on the comment-stripped segment', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const line = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    const meta = (id, parentId) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'session_meta', payload: { id, parent_thread_id: parentId } });
    const exactCommand = "node '/tmp/run/wait-route-worker.mjs' --duration-ms 1000";
    const rootRollout = [
      meta('root-t'),
      line({ type: 'function_call', call_id: 's1', name: 'spawn_agent', arguments: JSON.stringify({ agent_type: SYNTHETIC_ROLE_NAME }) }),
      line({ type: 'function_call_output', call_id: 's1', output: 'ok' }),
    ].join('\n');
    // A COMMENTED cmd with the real one commented OUT and another active:
    // the commented invocation never satisfies correlation.
    const commentedChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `tools.exec_command({/* cmd: ${JSON.stringify(exactCommand)}, */ cmd: "echo done"});` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), commentedChild, { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(sessions, 'rollout-root.jsonl'), rootRollout, { encoding: 'utf8', mode: 0o600 });
    const commented = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(commented), false, 'a commented-out cmd never satisfies correlation');
    // A comment BETWEEN the key and its colon keeps the correlation.
    const spacedChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `tools.exec_command({cmd /* invocation */ : ${JSON.stringify(exactCommand)},yield_time_ms:30000});` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), spacedChild, { encoding: 'utf8', mode: 0o600 });
    const spaced = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(spaced), true, 'a comment between the key and its colon keeps the invocation');
  });
});

test('a profiled run whose marker arrives while the worker still runs is inconclusive', { timeout: 40_000 }, async (t) => {
  if (skipFakeHostOnWindows(t)) return;
  await withTempDirectory(async (parent) => {
    // The fake host ignores the requested duration (spawning a LONG worker)
    // and prints the marker immediately: the marker cannot be terminal
    // evidence, and settlement kills the still-running worker.
    // The recorded worker prints the marker at 300 ms and STAYS ALIVE (a
    // 20 s keep-alive): on a profiled run the marker cannot be terminal
    // evidence — settlement terminates the still-running worker.
    const fakeCodex = await writeFakeCodex(parent, 'marker-then-late-noise');
    const sourceHome = await newSourceHome(parent);
    const output = await newRunDirectory(parent);
    // The 1 s budget expires while the kept-alive worker still runs: the
    // in-budget marker + terminated settlement must refuse the grant.
    const summary = await runWaitRouteCase({
      caseLabel: 'shell-window', codexPath: fakeCodex, outputDir: output, budgetMs: 1_000, sourceCodexHome: sourceHome,
      workerDurationMs: 1200, workerNoiseIntervalMs: 0, execYieldMs: 30000, pollYieldMs: 60000,
    });
    assert.equal(summary.outcome, 'inconclusive', JSON.stringify(summary));
    assert.equal(summary.reason, 'worker-still-running-at-marker', JSON.stringify(summary));
  });
});

test('named callbacks outside combinators and non-polling helper sites stay honest', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // A NAMED polling callback dispatched via forEach outside any
      // combinator: overlap.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'async function poll() { const r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output); }\n[1,2].forEach(poll);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      // An unrelated non-polling helper dispatched twice must not flag the
      // trailing sequential poll.
      JSON.stringify({ timestamp: '2026-10-01T00:01:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'const f = async () => 1; await Promise.all([(async () => f())(), (async () => f())()]); await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 1, 'the named forEach(poll) dispatch overlaps; the unrelated helper never does');
  });
});

test('a command-shaped string value never satisfies correlation', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const line = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    const meta = (id, parentId) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'session_meta', payload: { id, parent_thread_id: parentId } });
    const exactCommand = "node '/tmp/run/wait-route-worker.mjs' --duration-ms 1000";
    const rootRollout = [
      meta('root-t'),
      line({ type: 'function_call', call_id: 's1', name: 'spawn_agent', arguments: JSON.stringify({ agent_type: SYNTHETIC_ROLE_NAME }) }),
      line({ type: 'function_call_output', call_id: 's1', output: 'ok' }),
    ].join('\n');
    // Another argument's value contains a COMMAND-SHAPED object text; the
    // actual cmd is "other" — the decode must select the real property.
    const shapedChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `tools.exec_command({justification:'{cmd: ${JSON.stringify(exactCommand)}}', cmd: "other"});` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), shapedChild, { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(sessions, 'rollout-root.jsonl'), rootRollout, { encoding: 'utf8', mode: 0o600 });
    const shaped = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(shaped), false, 'a command-shaped string value is not the command property');
  });
});

test('formatted cmd keys, anchored decode, and sliced gaps stay honest', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const line = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    const meta = (id, parentId) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'session_meta', payload: { id, parent_thread_id: parentId } });
    const exactCommand = "node '/tmp/run/wait-route-worker.mjs' --duration-ms 1000";
    const rootRollout = [
      meta('root-t'),
      line({ type: 'function_call', call_id: 's1', name: 'spawn_agent', arguments: JSON.stringify({ agent_type: SYNTHETIC_ROLE_NAME }) }),
      line({ type: 'function_call_output', call_id: 's1', output: 'ok' }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-root.jsonl'), rootRollout, { encoding: 'utf8', mode: 0o600 });
    // FORMATTED key (`{ cmd: ... }` with whitespace) and a comment between
    // key and colon: correlation succeeds.
    const formattedChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `tools.exec_command({ cmd /* invocation */ : ${JSON.stringify(exactCommand)} });` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), formattedChild, { encoding: 'utf8', mode: 0o600 });
    const formatted = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(formatted), true, 'a whitespace-formatted cmd key with a comment correlates');
    // An expression tail (`"other" || "<expected>"`) passes "other": the
    // anchored decode must not credit the second operand.
    const tailChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `tools.exec_command({cmd: "other" || ${JSON.stringify(exactCommand)}});` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), tailChild, { encoding: 'utf8', mode: 0o600 });
    const tail = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(tail), false, 'an expression tail passes its first operand');
    // A long command literal must not shift the serialized-gap offsets.
    const sessions2 = join(parent, 'sessions2');
    await mkdir(sessions2, { recursive: true, mode: 0o700 });
    const longLiteral = 'x'.repeat(400);
    const gapRollout = [
      line({ type: 'custom_tool_call', name: 'exec', call_id: 'd1', input: `const p = tools.write_stdin({id:"s1",input:"${longLiteral}",yield_time_ms:60000});const q = tools.write_stdin({id:"s2",input:"",yield_time_ms:60000});await p;await q;` }),
      line({ type: 'custom_tool_call_output', call_id: 'd1', output: 'done' } ),
      // Overlapping starts followed by LATER awaits: two violations.
      line({ type: 'custom_tool_call', name: 'exec', call_id: 'd2', input: 'const p2 = tools.write_stdin({id:"s3",input:"",yield_time_ms:60000});const q2 = tools.write_stdin({id:"s4",input:"",yield_time_ms:60000});await p2;await q2;' } ),
      line({ type: 'custom_tool_call_output', call_id: 'd2', output: 'done' } ),
      '',
    ].join('\n');
    await writeFile(join(sessions2, 'rollout-1.jsonl'), gapRollout, { encoding: 'utf8', mode: 0o600 });
    const gapSummary = await summarizeCodexSessions({ sessionsDirectory: sessions2 });
    assert.equal(gapSummary.parallelToolCallViolations, 2, 'both start-before-await shapes overlap; the long literal and later awaits never serialize them');
  });
});

test('round-58 adversarial shapes stay honest', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const line = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    const meta = (id, parentId) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'session_meta', payload: { id, parent_thread_id: parentId } });
    const exactCommand = "node '/tmp/run/wait-route-worker.mjs' --duration-ms 1000";
    // An UNREADABLE rollout hides a second spawn: the scan fails closed.
    const sealed = join(sessions, 'sealed.jsonl');
    await writeFile(sealed, `${meta('x-t')}${line({ type: 'function_call', call_id: 'z1', name: 'spawn_agent', arguments: JSON.stringify({ agent_type: SYNTHETIC_ROLE_NAME }) })}`, { encoding: 'utf8', mode: 0o600 });
    await chmod(sealed, 0o000);
    const rootRollout = [
      meta('root-t'),
      line({ type: 'function_call', call_id: 's1', name: 'spawn_agent', arguments: JSON.stringify({ agent_type: SYNTHETIC_ROLE_NAME }) }),
      line({ type: 'function_call_output', call_id: 's1', output: 'ok' }),
    ].join('\n');
    // apply_patch is NOT the executable wrapper: its DSL text is data.
    const patchChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'a1', name: 'apply_patch', input: '*** Add File: x.ts\n+await tools.exec_command({cmd:"boom",yield_time_ms:30000});' }),
      line({ type: 'custom_tool_call_output', call_id: 'a1', output: 'ok' }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), patchChild, { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(sessions, 'rollout-root.jsonl'), rootRollout, { encoding: 'utf8', mode: 0o600 });
    try {
      const sealedScan = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
      assert.equal(sealedScan.session.truncated, true, 'an unreadable rollout marks the scan incomplete');
      assert.equal(roleChildProven(sealedScan), false, 'an incomplete scan cannot satisfy the exactly-one-spawn grant');
      assert.equal(sealedScan.session.initialExecCalls, 0, 'apply_patch input is data, not an executable wrapper script');
    } finally {
      await chmod(sealed, 0o600);
    }
    // A plain (non-async) arrow helper dispatched twice: overlap.
    const sessions2 = join(parent, 'sessions2');
    await mkdir(sessions2, { recursive: true, mode: 0o700 });
    const arrowRollout = [
      line({ type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const poll = () => tools.write_stdin({session_id:17,chars:""}); await Promise.all([poll(),poll()]);' }),
      line({ type: 'custom_tool_call_output', call_id: 'c1', output: 'done' }),
      // Helper calls wrapped in callbacks: multiplicity counts.
      line({ type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'const poll = () => tools.write_stdin({session_id:17,chars:""}); await Promise.all([1,2].map(() => poll()));' }),
      line({ type: 'custom_tool_call_output', call_id: 'c2', output: 'done' }),
      // Printed "await p" does not serialize; both polls start first.
      line({ type: 'custom_tool_call', name: 'exec', call_id: 'c3', input: 'const p = tools.write_stdin({id:"s1",input:"",yield_time_ms:60000}); text("await p"); const q = tools.write_stdin({id:"s2",input:"",yield_time_ms:60000}); await p; await q;' }),
      line({ type: 'custom_tool_call_output', call_id: 'c3', output: 'done' }),
      '',
    ].join('\n');
    await writeFile(join(sessions2, 'rollout-1.jsonl'), arrowRollout, { encoding: 'utf8', mode: 0o600 });
    const arrowSummary = await summarizeCodexSessions({ sessionsDirectory: sessions2 });
    assert.equal(arrowSummary.parallelToolCallViolations, 3, 'plain arrow helpers, callback-wrapped helper dispatches, and printed-await non-serialization all count');
  });
});

test('the cmd decode locates the actual property lexically', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const line = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    const meta = (id, parentId) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'session_meta', payload: { id, parent_thread_id: parentId } });
    const exactCommand = "node '/tmp/run/wait-route-worker.mjs' --duration-ms 1000";
    const rootRollout = [
      meta('root-t'),
      line({ type: 'function_call', call_id: 's1', name: 'spawn_agent', arguments: JSON.stringify({ agent_type: SYNTHETIC_ROLE_NAME }) }),
      line({ type: 'function_call_output', call_id: 's1', output: 'ok' }),
    ].join('\n');
    // Another argument's string VALUE mentions the expected command; the
    // actual cmd is "other" — correlation must fail.
    const decoyChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `tools.exec_command({justification: 'cmd: ${JSON.stringify(exactCommand)},', cmd: "other"});` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), decoyChild, { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(sessions, 'rollout-root.jsonl'), rootRollout, { encoding: 'utf8', mode: 0o600 });
    const decoy = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(decoy), false, 'a string value mentioning the command is not the command');
    // An unquoted computed yield key can evaluate to anything: fail closed.
    const sessions2 = join(parent, 'sessions2');
    await mkdir(sessions2, { recursive: true, mode: 0o700 });
    const computedRollout = [
      line({ type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const yield_time_ms = "max_tokens";\nconst r = await tools.write_stdin({session_id:1,chars:"",[yield_time_ms]:5000});text(r.output);' }),
      line({ type: 'custom_tool_call_output', call_id: 'c1', output: 'done' }),
      '',
    ].join('\n');
    await writeFile(join(sessions2, 'rollout-1.jsonl'), computedRollout, { encoding: 'utf8', mode: 0o600 });
    const computed = await summarizeCodexSessions({ sessionsDirectory: sessions2 });
    assert.deepEqual(computed.requestedYieldsMs, [], 'an identifier computed key never records a request');
  });
});

test('awaited loop bodies stay sequential and busy-wait prefixes delay the poll start', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // An AWAITED loop body: one active observation at a time — no overlap.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'for (let i = 0; i < 2; i++) { const r = await tools.write_stdin({session_id:17, chars:"",yield_time_ms:60000});text(r.output); }' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      // A semicolon-free busy-wait before the poll delays its start past
      // the call timestamp: the start stays unproven.
      JSON.stringify({ timestamp: '2026-10-01T00:01:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'while (Date.now() === 0) { break; }\ntext(await tools.write_stdin({id:"s",input:"",yield_time_ms:60000}))' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 0, 'the awaited loop body serializes its iterations');
    assert.equal(summary.emptyPolls, 2, 'both polls are counted');
    assert.equal(summary.firstEmptyPollAtMs, null, 'the busy-wait prefix leaves the poll start unproven');
  });
});

test('named callback multiplicity follows the receiver', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // A polling helper over a SINGLETON receiver: one invocation.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'async function poll() { const r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output); }\nawait Promise.all([1].map(poll));' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      // Over a TWO-element receiver: overlap (each script carries its own
      // helper declaration — attribution is per-script).
      JSON.stringify({ timestamp: '2026-10-01T00:01:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'async function poll() { const r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output); }\nawait Promise.all([1, 2].map(poll));' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 1, 'only the two-element receiver overlaps');
  });
});

test('loop bodies and non-async helper dispatches are repeated executions', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // A for-loop re-executes its body poll N times: overlap.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'for (let i = 0; i < 2; i++) { tools.write_stdin({session_id:17, chars:"",yield_time_ms:60000}); }' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      // A NON-async promise-returning helper dispatched twice: overlap.
      JSON.stringify({ timestamp: '2026-10-01T00:01:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'function poll() { return tools.write_stdin({id:"s",input:"",yield_time_ms:60000}); }\nawait Promise.all([poll(), poll()]);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'done' } }),
      // A DSL wait continuation records its own requested yield.
      JSON.stringify({ timestamp: '2026-10-01T00:02:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c3', input: 'const r = await tools.wait({cell_id:7, yield_time_ms:60000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:03:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c3', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 2, 'the loop body and the non-async helper dispatch both overlap');
    assert.deepEqual(summary.requestedYieldsMs, [60000, 60000, 60000, 60000], 'the DSL wait continuation and the twice-dispatched helper record their requested yields');
  });
});

test('conditional awaits never serialize; mixed exec+poll wrappers fail closed', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const line = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    const mk = (callId, input, output) => [
      line({ type: 'custom_tool_call', name: 'exec', call_id: callId, input }),
      line({ type: 'custom_tool_call_output', call_id: callId, output }),
    ].join('\n');
    const inputs = [
      'async function poll() { return tools.write_stdin({id:"s",input:"",yield_time_ms:60000}); }\nconst p = tools.write_stdin({id:"s2",input:"",yield_time_ms:60000}); const q = tools.write_stdin({id:"s3",input:"",yield_time_ms:60000}); await p; await q;',
      'async function poll() { return tools.write_stdin({id:"s",input:"",yield_time_ms:60000}); }\nconst a = poll(); await a; const b = poll(); await b;',
    ];
    // c1: an UNREACHABLE conditional await in the gap never serializes the
    // two started polls.
    const rollout1 = [mk('c1', inputs[0], 'done'), mk('c1b', inputs[1], 'done'), ''].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout1, { encoding: 'utf8', mode: 0o600 });
    const s1 = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(s1.parallelToolCallViolations >= 1, true, 'a conditional gap await never serializes started polls');
    // A mixed exec+poll wrapper's aggregate output is ambiguous: the chain
    // is not credited.
    const exactCommand = "node '/tmp/run/wait-route-worker.mjs' --duration-ms 1000";
    const line2 = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    const meta = (id, parentId) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'session_meta', payload: { id, parent_thread_id: parentId } });
    const rootRollout = [
      meta('root-t'),
      line2({ type: 'function_call', call_id: 's1', name: 'spawn_agent', arguments: JSON.stringify({ agent_type: 'wait-probe-synthetic' }) }),
      line2({ type: 'function_call_output', call_id: 's1', output: 'ok' }),
    ].join('\n');
    const COMPLETION_MARKER_VALUE = 'WAIT_ROUTE_PROBE_WORKER_DONE';
    const mixedChild = [
      meta('child-t', 'root-t'),
      line2({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `tools.exec_command({cmd:${JSON.stringify(exactCommand)},yield_time_ms:30000});\nconst r = await tools.write_stdin({session_id:999,chars:"",yield_time_ms:60000});text(r.output);` }),
      line2({ type: 'custom_tool_call_output', call_id: 'e1', output: COMPLETION_MARKER_VALUE }),
    ].join('\n');
    const sessions2 = join(parent, 'sessions2');
    await mkdir(sessions2, { recursive: true, mode: 0o700 });
    await writeFile(join(sessions2, 'rollout-child.jsonl'), mixedChild, { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(sessions2, 'rollout-root.jsonl'), rootRollout, { encoding: 'utf8', mode: 0o600 });
    const mixed = { session: await summarizeCodexSessions({ sessionsDirectory: sessions2, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(mixed), false, "a mixed exec+poll wrapper's aggregate output is ambiguous");
  });
});

test('vanished rollouts, free helper invocations, and opaque arguments stay honest', async () => {
  await withTempDirectory(async (parent) => {
    const sessions2 = join(parent, 'sessions2');
    await mkdir(sessions2, { recursive: true, mode: 0o700 });
    const mk = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    const inputs = [
      'async function poll() { return tools.write_stdin({id:"s",input:"",yield_time_ms:60000}); }\nconst a = poll(); const b = poll(); await a; await b;',
      'async function poll() { return tools.write_stdin({id:"s",input:"",yield_time_ms:60000}); }\nconst a = poll(); await a; const b = poll(); await b;',
      'const r = await tools.write_stdin({session_id: (function () { while (Date.now() % 2 === 0) { return 17; } return 18; })(), chars:"",yield_time_ms:60000});text(r.output);',
    ];
    const rollout = [mk({ type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: inputs[0] }), mk({ type: 'custom_tool_call_output', call_id: 'c1', output: 'done' }), mk({ type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: inputs[1] }), mk({ type: 'custom_tool_call_output', call_id: 'c2', output: 'done' }), mk({ type: 'custom_tool_call', name: 'exec', call_id: 'c3', input: inputs[2] }), mk({ type: 'custom_tool_call_output', call_id: 'c3', output: 'done' }), ''].join('\n');
    await writeFile(join(sessions2, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const helperSummary = await summarizeCodexSessions({ sessionsDirectory: sessions2 });
    assert.equal(helperSummary.parallelToolCallViolations, 1, 'free unawaited helper invocations overlap; awaited ones are sequential');
    assert.equal(helperSummary.emptyPolls, 5, 'all five ACTUAL polls count (helper invocations count per multiplicity)');
    assert.equal(helperSummary.firstEmptyPollAtMs, null, 'the opaque-argument poll start stays unproven');
  });
});

test('over-cap scripts skip expensive passes; IIFE helpers execute once', { timeout: 60_000 }, async () => {
  await withTempDirectory(async (parent) => {
    const wrap = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    // 18k awaited polls: over the 512-site cap — the expensive serialization
    // passes must be SKIPPED immediately (bounded time, truncation reported).
    const polls = [];
    for (let i = 0; i < 18000; i += 1) polls.push('await tools.write_stdin({id:"s' + i + '",input:"",yield_time_ms:60000});');
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const bigRollout = [
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'c0', input: polls.join('') }),
      wrap({ type: 'custom_tool_call_output', call_id: 'c0', output: 'done' }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-big.jsonl'), bigRollout, { encoding: 'utf8', mode: 0o600 });
    const startedAt = Date.now();
    const big = await summarizeCodexSessions({ sessionsDirectory: sessions });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 30000, `over-cap analysis must be skipped immediately (took ${elapsed} ms)`);
    assert.equal(big.truncated, true, 'an over-cap scan reports truncation');
    // An IIFE helper executes its body ONCE at the declaration itself: the
    // executed command and requested yield are recorded without any later
    // `p()` call.
    const sessions2 = join(parent, 'sessions2');
    await mkdir(sessions2, { recursive: true, mode: 0o700 });
    const exactCommand = "node '/tmp/run/wait-route-worker.mjs' --duration-ms 1000";
    const line = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    const meta = (id, parentId) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'session_meta', payload: { id, parent_thread_id: parentId } });
    const iifeScript = 'const p = (async () => await tools.exec_command({cmd:' + JSON.stringify(exactCommand) + ',yield_time_ms:30000}))();\ntext((await p).output);';
    const rootRollout = [
      meta('root-t'),
      line({ type: 'function_call', call_id: 's1', name: 'spawn_agent', arguments: JSON.stringify({ agent_type: 'wait-probe-synthetic' }) }),
      line({ type: 'function_call_output', call_id: 's1', output: 'ok' }),
    ].join('\n');
    const iifeChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: iifeScript }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: 'WAIT_ROUTE_PROBE_WORKER_DONE' }),
    ].join('\n');
    await writeFile(join(sessions2, 'rollout-child.jsonl'), iifeChild, { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(sessions2, 'rollout-root.jsonl'), rootRollout, { encoding: 'utf8', mode: 0o600 });
    const iife = { session: await summarizeCodexSessions({ sessionsDirectory: sessions2, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(iife), true, 'an immediately-invoked helper executes its body once');
  });
});

test('analysis bounds, unconditional loop awaits, named callbacks, and printed mentions stay honest', { timeout: 60_000 }, async () => {
  await withTempDirectory(async (parent) => {
    const wrap = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    // 14k sequential awaited polls: the analysis must bound itself and
    // report truncation rather than blocking cleanup indefinitely.
    const polls = [];
    for (let i = 0; i < 14000; i += 1) {
      polls.push(`await tools.write_stdin({id:"s${i}",input:"",yield_time_ms:60000});`);
    }
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const bigRollout = [
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'c0', input: polls.join('') }),
      wrap({ type: 'custom_tool_call_output', call_id: 'c0', output: 'done' }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-big.jsonl'), bigRollout, { encoding: 'utf8', mode: 0o600 });
    const startedAt = Date.now();
    const big = await summarizeCodexSessions({ sessionsDirectory: sessions });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 30000, `oversized analysis must stay bounded (took ${elapsed} ms)`);
    assert.equal(big.truncated, true, 'an analysis over its time budget reports truncation');
    // Conditional loop-body awaits never serialize iterations.
    const sessions2 = join(parent, 'sessions2');
    await mkdir(sessions2, { recursive: true, mode: 0o700 });
    const conditionalRollout = [
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'for (let i = 0; i < 2; i++) { const p = tools.write_stdin({id:"s",input:"",yield_time_ms:60000}); if (false) await p; }' }),
      wrap({ type: 'custom_tool_call_output', call_id: 'c1', output: 'done' }),
      // Named callback outside combinators: multiplicity counts.
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'async function poll() { return tools.write_stdin({id:"s",input:"",yield_time_ms:60000}); }\n[1,2].forEach(poll);' }),
      wrap({ type: 'custom_tool_call_output', call_id: 'c2', output: 'done' } ),
      // A printed poll() mention never fabricates an invocation.
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'c3', input: 'async function poll() { return tools.write_stdin({id:"s",input:"",yield_time_ms:60000}); }\ntext("poll() runs later");' } ),
      wrap({ type: 'custom_tool_call_output', call_id: 'c3', output: 'done' } ),
      '',
    ].join('\n');
    await writeFile(join(sessions2, 'rollout-1.jsonl'), conditionalRollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions2 });
    assert.ok(summary.parallelToolCallViolations >= 2, 'the conditional-await loop and the named forEach dispatch overlap');
    assert.equal(summary.emptyPolls, 3, 'the named dispatch runs two polls and the loop body one; the printed mention never runs one');
  });
});

test('conflicting structured handle aliases and pathological padding stay honest', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const line = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    const meta = (id, parentId) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'session_meta', payload: { id, parent_thread_id: parentId } });
    const exactCommand = "node '/tmp/run/wait-route-worker.mjs' --duration-ms 1000";
    const rootRollout = [
      meta('root-t'),
      line({ type: 'function_call', call_id: 's1', name: 'spawn_agent', arguments: JSON.stringify({ agent_type: SYNTHETIC_ROLE_NAME }) }),
      line({ type: 'function_call_output', call_id: 's1', output: 'ok' }),
    ].join('\n');
    // CONFLICTING structured aliases (`session_id:999` + `id:17`): the
    // effective handle is host-defined — the marker never credits.
    const crossChild = [
      meta('child-t', 'root-t'),
      line({ type: 'function_call', call_id: 'e1', name: 'exec_command', arguments: JSON.stringify({ cmd: exactCommand, yield_time_ms: 30000 }) }),
      line({ type: 'function_call_output', call_id: 'e1', output: 'Script running with session ID 17\n' }),
      line({ type: 'function_call', call_id: 'p1', name: 'write_stdin', arguments: JSON.stringify({ session_id: 999, id: 17, chars: '' }) }),
      line({ type: 'function_call_output', call_id: 'p1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), crossChild, { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(sessions, 'rollout-root.jsonl'), rootRollout, { encoding: 'utf8', mode: 0o600 });
    const cross = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(cross), false, 'conflicting handle aliases leave the effective handle unproven');
    // A heavily PADDED argument object must not make yield extraction
    // quadratic: 10k padding spaces parse in bounded time.
    const sessions2 = join(parent, 'sessions2');
    await mkdir(sessions2, { recursive: true, mode: 0o700 });
    const paddedInput = 'const r = await tools.write_stdin({' + ' '.repeat(10000) + 'session_id:1,chars:"",yield_time_ms:60000});text(r.output);';
    const paddedRollout = [
      line({ type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: paddedInput }),
      line({ type: 'custom_tool_call_output', call_id: 'c1', output: 'done' }),
      '',
    ].join('\n');
    await writeFile(join(sessions2, 'rollout-1.jsonl'), paddedRollout, { encoding: 'utf8', mode: 0o600 });
    const startedAt = Date.now();
    const padded = await summarizeCodexSessions({ sessionsDirectory: sessions2 });
    const elapsed = Date.now() - startedAt;
    assert.equal(padded.emptyPolls, 1, 'the padded poll is still classified');
    assert.ok(elapsed < 1000, `padded extraction must stay fast (took ${elapsed} ms)`);
  });
});

test('awaited joins serialize; padded cmd keys stay linear', async () => {
  await withTempDirectory(async (parent) => {
    const wrap = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    // An awaited JOIN (`await Promise.all([p])`) settles the stored poll
    // before the next observation: sequential, no overlap.
    const joinRollout = [
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const p = tools.write_stdin({id:"s1",input:"",yield_time_ms:60000}); await Promise.all([p]); await tools.write_stdin({id:"s2",input:"",yield_time_ms:60000});' }),
      wrap({ type: 'custom_tool_call_output', call_id: 'c1', output: 'done' }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), joinRollout, { encoding: 'utf8', mode: 0o600 });
    const joinSummary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(joinSummary.parallelToolCallViolations, 0, 'the awaited join serializes the stored poll');
    // A heavily padded cmd segment must decode in bounded (linear) time.
    const paddedInput = 'const r = await tools.exec_command({' + ' '.repeat(40000) + 'cmd:"x",yield_time_ms:30000});text(r.output);';
    const paddedRollout = [
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: paddedInput }),
      wrap({ type: 'custom_tool_call_output', call_id: 'c2', output: 'done' }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-2.jsonl'), paddedRollout, { encoding: 'utf8', mode: 0o600 });
    const startedAt = Date.now();
    const padded = await summarizeCodexSessions({ sessionsDirectory: sessions });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 1000, `padded cmd decoding must stay fast (took ${elapsed} ms)`);
    assert.equal(padded.initialExecCalls, 1, 'the padded exec classifies as an initial exec');
  });
});

test('over-cap scripts skip helper analysis; completed wrappers exposing live cells stay pending', { timeout: 60_000 }, async () => {
  await withTempDirectory(async (parent) => {
    const wrap = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    // A script with 3000 polling-helper DECLARATIONS: over the site cap,
    // helper discovery/invocation/multiplicity analysis must be skipped
    // immediately (bounded time, truncation reported).
    const decls = [];
    for (let i = 0; i < 3000; i += 1) {
      decls.push('async function poll' + i + '() { return tools.write_stdin({id:"s' + i + '",input:"",yield_time_ms:60000}); }');
    }
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const declRollout = [
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'c0', input: decls.join('\n') }),
      wrap({ type: 'custom_tool_call_output', call_id: 'c0', output: 'done' }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-big.jsonl'), declRollout, { encoding: 'utf8', mode: 0o600 });
    const startedAt = Date.now();
    const big = await summarizeCodexSessions({ sessionsDirectory: sessions });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 15000, `over-cap helper analysis must be skipped (took ${elapsed} ms)`);
    assert.equal(big.truncated, true, 'an over-cap scan reports truncation');
    // A wrapped wait completing with a LIVE INNER CELL: the original pending
    // call stays pending — a subsequent fresh poll counts as an overlap.
    const sessions2 = join(parent, 'sessions2');
    await mkdir(sessions2, { recursive: true, mode: 0o700 });
    const liveCellRollout = [
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'd1', input: 'const r = await tools.exec_command({cmd:"x",yield_time_ms:30000});text(r.output);' }),
      wrap({ type: 'custom_tool_call_output', call_id: 'd1', output: 'Script running with cell ID 7\n' }),
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'd2', input: 'const r = await tools.wait({cell_id:7, yield_time_ms:60000});text(r.output);' }),
      wrap({ type: 'custom_tool_call_output', call_id: 'd2', output: 'Script completed\nProcess running with cell ID 7\n' }),
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'd3', input: 'const r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output);' }),
      wrap({ type: 'custom_tool_call_output', call_id: 'd3', output: 'done' }),
      '',
    ].join('\n');
    await writeFile(join(sessions2, 'rollout-1.jsonl'), liveCellRollout, { encoding: 'utf8', mode: 0o600 });
    const liveCell = await summarizeCodexSessions({ sessionsDirectory: sessions2 });
    assert.ok(liveCell.parallelToolCallViolations >= 1, 'a fresh poll while a live inner cell is pending counts as an overlap');
  });
});

test('a wrapper completion restores pending state under the SURVIVING inner cell', async () => {
  await withTempDirectory(async (parent) => {
    const wrap = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    // wait(cell 7) → wrapper cell 10 → cell 10 completes exposing live
    // cell 7 → cell 7 itself completes: the retired pending state must
    // come back under cell SEVEN (the surviving announced cell) so the
    // surviving cell's own completion settles the chain and a later
    // clean call reports NO violation. Restoring under the COMPLETED
    // wrapper cell strands the ids forever (a false overlap afterwards).
    const rollout = [
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'd1', input: 'const r = await tools.exec_command({cmd:"x",yield_time_ms:30000});text(r.output);' }),
      wrap({ type: 'custom_tool_call_output', call_id: 'd1', output: 'Script running with cell ID 7\n' }),
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'd2', input: 'const r = await tools.wait({cell_id:7, yield_time_ms:60000});text(r.output);' }),
      wrap({ type: 'custom_tool_call_output', call_id: 'd2', output: 'Script running with cell ID 10\n' }),
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'd3', input: 'const r = await tools.wait({cell_id:10, yield_time_ms:60000});text(r.output);' }),
      wrap({ type: 'custom_tool_call_output', call_id: 'd3', output: 'Script completed\nProcess running with cell ID 7\n' }),
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'd4', input: 'const r = await tools.wait({cell_id:7, yield_time_ms:60000});text(r.output);' }),
      wrap({ type: 'custom_tool_call_output', call_id: 'd4', output: 'Script completed\n' }),
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'd5', input: 'const r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output);' }),
      wrap({ type: 'custom_tool_call_output', call_id: 'd5', output: 'done' }),
      '',
    ].join('\n');
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 0, 'the surviving cell settles the chain at its own completion; a later clean call is not a false overlap');
  });
});

test('helper invocations count toward the site cap', { timeout: 60_000 }, async () => {
  await withTempDirectory(async (parent) => {
    const wrap = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    // 30k sequential `await poll()` calls: only ONE literal operation site
    // exists (the helper body), but the INVOCATIONS enter the same
    // serialization scans — they must count toward the site cap so the
    // analysis truncates instead of blocking.
    const script = 'async function poll(){ return tools.write_stdin({id:"s",input:"",yield_time_ms:60000}); }\n'
      + Array.from({ length: 30000 }, () => 'await poll();').join('');
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const bigRollout = [
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'c0', input: script }),
      wrap({ type: 'custom_tool_call_output', call_id: 'c0', output: 'done' }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-big.jsonl'), bigRollout, { encoding: 'utf8', mode: 0o600 });
    const startedAt = Date.now();
    const big = await summarizeCodexSessions({ sessionsDirectory: sessions });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 15000, `over-cap helper invocations must be skipped (took ${elapsed} ms)`);
    assert.equal(big.truncated, true, 'a helper-invocation over-cap scan reports truncation');
  });
});

test('golden recorded-shape samples: the real measured 0.160.0 rollout shapes classify correctly', async () => {
  await withTempDirectory(async (parent) => {
    // FIXTURE-TESTED golden samples: transcribed from the verbatim rollout
    // lines recorded in report §7.0/§7.8 (the raw rollouts were deleted with
    // their isolated homes, so these recordings are the surviving real
    // material; handles/paths are placeholders). They pin the SUPPORTED
    // grammar only — never future arbitrary scripts.
    const wrap = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    // §7.8 initial exec: requested 30000 → Wall time 30.2 (host output).
    const execBody = `const r = await tools.exec_command({cmd:"'node' '<worker-path>' --duration-ms 420000",yield_time_ms:30000});text(r.output);`;
    // §7.8 decisive poll: leading @exec directive + one write_stdin
    // requesting 3600000 → one 380.1 s observation to "Script completed".
    const directivePoll = `// @exec: {"yield_time_ms": 3600000}\ntext(await tools.write_stdin({session_id:17,chars:"",yield_time_ms:3600000}));`;
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'g1', input: execBody }),
      wrap({ type: 'custom_tool_call_output', call_id: 'g1', output: 'Script running with cell ID 3\nWall time 30.2 seconds' }),
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'g2', input: directivePoll }),
      wrap({ type: 'custom_tool_call_output', call_id: 'g2', output: 'Script completed\nWall time 380.1 seconds' }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const decisive = await summarizeCodexSessions({ sessionsDirectory: sessions });
    // The §7.3/§7.8 raised-config decisive run: TWO tool decisions, the
    // directive requests 3600000, one empty poll.
    assert.equal(decisive.initialExecCalls, 1, 'the recorded exec body classifies as the initial exec');
    assert.equal(decisive.emptyPolls, 1, 'the recorded directive poll classifies as one empty poll');
    // Established counting semantics (pinned by the quoted-yield-keys test):
    // a directive call records BOTH the directive bound (which governs the
    // call sample) AND its argument yield — the §7.2 runs had no directive
    // calls, so their arrays are exactly one-per-call.
    assert.deepEqual(decisive.requestedYieldsMs, [30000, 3600000, 3600000], 'the recorded requested yields: exec 30000, then the directive bound and its argument');
    assert.deepEqual(decisive.toolNames, { exec: 2 }, 'the recorded decisions are two exec-tool calls');
    // NO parallelToolCallViolations assertion: the decisive run's recorded
    // 0-violations fact (§7.2/§7.3 run-time summaries) was computed on the
    // REAL rollouts, whose handle-linkage OUTPUT text is elided in §7.8 —
    // this reconstruction's `Script running with cell ID 3` output makes the
    // session_id poll a non-referencing second observation under the
    // instrument's kind-binding (cell→wait, session→write_stdin), which is
    // the DOCUMENTED semantic for the reconstructed text, not a defect. The
    // zero-concurrency derivation therefore cannot be re-verified from
    // surviving material and is recorded as such in §7.10.
  });
});

test('regex literal contents are not shell operations', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const wrap = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    const rollout = [
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'text(/write_stdin({session_id:17,chars:"",yield_time_ms:60000})/.source);' }),
      wrap({ type: 'custom_tool_call_output', call_id: 'c1', output: 'done' }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.emptyPolls, 0, 'regex contents are not an empty poll');
    assert.equal(summary.initialExecCalls, 0, 'regex contents are not an initial exec');
    assert.deepEqual(summary.requestedYieldsMs, [], 'regex contents never request a yield');
  });
});

test('regex character-class slashes and quotes stay inside the literal', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const wrap = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    // The class holds BOTH a slash and a quote (/[/"]/): the literal ends at
    // its final slash — the in-class characters must not end it early and the
    // `"]` remainder must not open a string that swallows the real poll.
    const rollout = [
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const sep = /[/"]/;\nconst r = await tools.write_stdin({session_id:17,chars:"",yield_time_ms:60000});text(r.output);' }),
      wrap({ type: 'custom_tool_call_output', call_id: 'c1', output: 'Script running with cell ID 7\n' }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.emptyPolls, 1, 'the write_stdin after the regex literal is a real empty poll');
    assert.deepEqual(summary.requestedYieldsMs, [60000], 'the poll after the regex literal still requests its yield');
  });
});

test('function-form declarations end at their closing brace; same-line invocations are real', async () => {
  await withTempDirectory(async (parent) => {
    const wrap = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    // Multiplicity loop: ONE invocation sharing the line after the body is a
    // REAL invocation — the body's poll executes (and requests) exactly once,
    // never swallowed into the declaration.
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const single = [
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'async function poll(){ const r = await tools.write_stdin({session_id:17,chars:"",yield_time_ms:60000}); text(r.output); } poll();' }),
      wrap({ type: 'custom_tool_call_output', call_id: 'c1', output: 'Script running with cell ID 7\n' }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), single, { encoding: 'utf8', mode: 0o600 });
    const one = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(one.emptyPolls, 1, 'the same-line invocation runs the helper body once');
    assert.deepEqual(one.requestedYieldsMs, [60000], 'the executed poll requests its yield');
    // helperCallStarts loop: TWO unawaited same-line invocations overlap —
    // the serialization scan must see both call positions.
    const sessions2 = join(parent, 'sessions2');
    await mkdir(sessions2, { recursive: true, mode: 0o700 });
    const twin = [
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'async function poll(){ const r = await tools.write_stdin({session_id:17,chars:"",yield_time_ms:60000}); text(r.output); } poll(); poll();' }),
      wrap({ type: 'custom_tool_call_output', call_id: 'c1', output: 'done' }),
      '',
    ].join('\n');
    await writeFile(join(sessions2, 'rollout-1.jsonl'), twin, { encoding: 'utf8', mode: 0o600 });
    const two = await summarizeCodexSessions({ sessionsDirectory: sessions2 });
    assert.equal(two.emptyPolls, 2, 'both invocations execute the helper body');
    assert.equal(two.parallelToolCallViolations, 1, 'two unawaited same-line invocations overlap (exactly one violation)');
    // Direct-site exclusion uses the SAME declaration boundary: a DIRECT
    // poll sharing the line after the closing brace is NOT inside the
    // helper body — it must stay in the serialization pairs and overlap
    // the concurrent helper invocation.
    const sessions3 = join(parent, 'sessions3');
    await mkdir(sessions3, { recursive: true, mode: 0o700 });
    const mixed = [
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'async function poll(){ await tools.write_stdin({session_id:17,chars:"",yield_time_ms:60000}); } tools.write_stdin({session_id:17,chars:"",yield_time_ms:60000}); await poll();' }),
      wrap({ type: 'custom_tool_call_output', call_id: 'c1', output: 'done' }),
      '',
    ].join('\n');
    await writeFile(join(sessions3, 'rollout-1.jsonl'), mixed, { encoding: 'utf8', mode: 0o600 });
    const mixedSummary = await summarizeCodexSessions({ sessionsDirectory: sessions3 });
    assert.equal(mixedSummary.parallelToolCallViolations, 1, 'the direct same-line poll and the concurrent helper invocation overlap');
    // Control: an AWAITED direct poll before the awaited helper invocation
    // is sequential — the exclusion must still apply to real body sites.
    const sessions4 = join(parent, 'sessions4');
    await mkdir(sessions4, { recursive: true, mode: 0o700 });
    const sequential = [
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'async function poll(){ await tools.write_stdin({session_id:18,chars:"",yield_time_ms:60000}); }\nawait tools.write_stdin({session_id:17,chars:"",yield_time_ms:60000});\nawait poll();' }),
      wrap({ type: 'custom_tool_call_output', call_id: 'c1', output: 'done' }),
      '',
    ].join('\n');
    await writeFile(join(sessions4, 'rollout-1.jsonl'), sequential, { encoding: 'utf8', mode: 0o600 });
    const sequentialSummary = await summarizeCodexSessions({ sessionsDirectory: sessions4 });
    assert.equal(sequentialSummary.parallelToolCallViolations, 0, 'an awaited direct poll then an awaited helper invocation serialize');
  });
});

test('live inner cells stay pending; loop awaits serialize; accessor yields fail closed', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const wrap = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    const rollout = [
      wrap({ type: "custom_tool_call", name: "exec", call_id: "c1", input: "const r = await tools.exec_command({cmd:\"x\",yield_time_ms:30000});text(r.output);" }),
      wrap({ type: "custom_tool_call_output", call_id: "c1", output: "Script running with cell ID 7\n" }),
      wrap({ type: "custom_tool_call", name: "exec", call_id: "c2", input: "for (let i = 0; i < 2; i++) { const p = tools.write_stdin({id:\"s\",input:\"\",yield_time_ms:60000}); await p; text(p.output); }" }),
      wrap({ type: "custom_tool_call_output", call_id: "c2", output: "done" }),
      wrap({ type: "custom_tool_call", name: "exec", call_id: "c3", input: "const r = await tools.write_stdin({session_id:17, chars:\"\",yield_time_ms:60000, get yield_time_ms(){ return 5000; }});text(r.output);" }),
      wrap({ type: "custom_tool_call_output", call_id: "c3", output: "WAIT_ROUTE_PROBE_WORKER_DONE" }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    // c1 exec yields cell 7; c2's awaited loop is sequential (no overlap);
    // c3's follow-up poll of the live cell chain is a continuation.
    assert.equal(summary.parallelToolCallViolations, 2, 'the two awaited loop polls still overlap the live cell-7 observation (correctly flagged)');
    // The accessor-overridden yield (c3) leaves its request unclassified:
    // no yield is recorded for that call (the c2 loop polls legitimately
    // request 60000; the accessor call records null).
    const accessorCall = summary.calls[summary.calls.length - 1];
    assert.equal(accessorCall.yieldTimeMs, null, 'an accessor-overridden yield stays unclassified');
    assert.equal(summary.requestedYieldsMs.includes(5000), false, 'the accessor value never becomes a request');
  });
});

test('ASI awaits serialize and completed cells retire despite live handles', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const wrap = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    const rollout = [
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'c0', input: 'const r = await tools.exec_command({cmd:"x",yield_time_ms:30000});text(r.output);' }),
      wrap({ type: 'custom_tool_call_output', call_id: 'c0', output: 'Script running with cell ID 7\n' }),
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.wait({cell_id:7, yield_time_ms:60000});text(r.output);' }),
      // The awaited CELL completed; the SAME output announces the live
      // session: the cell retires AND the live session becomes the new
      // chain target.
      wrap({ type: 'custom_tool_call_output', call_id: 'c1', output: 'Script completed\nProcess running with session ID 17\n' }),
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'const r = await tools.write_stdin({session_id:17, chars:"",yield_time_ms:60000});text(r.output);' }),
      wrap({ type: 'custom_tool_call_output', call_id: 'c2', output: 'Script completed\n' }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 0, 'the completed cell retires; the live-session poll is a sequential chain continuation');
  });
});

test('mixed helper and direct polls count their overlap', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const wrap = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    const rollout = [
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'async function poll() { return tools.write_stdin({id:"s1",input:"",yield_time_ms:60000}); }\nconst p = poll(); await tools.write_stdin({id:"s2",input:"",yield_time_ms:60000}); await p;' }),
      wrap({ type: 'custom_tool_call_output', call_id: 'c1', output: 'done' }),
      wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'async function poll() { return tools.write_stdin({id:"s1",input:"",yield_time_ms:60000}); }\nconst p = poll(); await p; await tools.write_stdin({id:"s2",input:"",yield_time_ms:60000});' }),
      wrap({ type: 'custom_tool_call_output', call_id: 'c2', output: 'done' }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 1, 'the helper-promise-overlap counts; the compliant mixed shape does not');
  });
});

test('cross-observation polls never credit the chain; text-wrapped polls keep their start', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const line = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    const meta = (id, parentId) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'session_meta', payload: { id, parent_thread_id: parentId } });
    const exactCommand = "node '/tmp/run/wait-route-worker.mjs' --duration-ms 1000";
    const rootRollout = [
      meta('root-t'),
      line({ type: 'function_call', call_id: 's1', name: 'spawn_agent', arguments: JSON.stringify({ agent_type: SYNTHETIC_ROLE_NAME }) }),
      line({ type: 'function_call_output', call_id: 's1', output: 'ok' }),
    ].join('\n');
    // The worker suspends in CELL 7; a write_stdin naming session 999 (with
    // an inert cell_id:7 field) is a DIFFERENT observation — its marker
    // never credits the chain.
    const crossChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `tools.exec_command({cmd:${JSON.stringify(exactCommand)},yield_time_ms:30000});` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: 'Script running with cell ID 7\n' }),
      line({ type: 'custom_tool_call', call_id: 'p1', name: 'exec', input: 'const r = await tools.write_stdin({session_id:999, cell_id:7, chars:"",yield_time_ms:60000});text(r.output);' }),
      line({ type: 'custom_tool_call_output', call_id: 'p1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), crossChild, { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(sessions, 'rollout-root.jsonl'), rootRollout, { encoding: 'utf8', mode: 0o600 });
    const cross = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(cross), false, 'a write_stdin observing another session never credits a cell chain');
    // The text()-wrapped awaited poll (the recorded continuation shape)
    // keeps its immediate start timestamp.
    const sessions2 = join(parent, 'sessions2');
    await mkdir(sessions2, { recursive: true, mode: 0o700 });
    const wrappedRollout = [
      line({ type: "custom_tool_call", name: "exec", call_id: "c1", input: "// @exec: {\"yield_time_ms\": 3600000}\ntext(await tools.write_stdin({session_id:17, chars:\"\",yield_time_ms:60000}));" }),
      line({ type: 'custom_tool_call_output', call_id: 'c1', output: 'done' }),
      '',
    ].join('\n');
    await writeFile(join(sessions2, 'rollout-1.jsonl'), wrappedRollout, { encoding: 'utf8', mode: 0o600 });
    const wrapped = await summarizeCodexSessions({ sessionsDirectory: sessions2 });
    assert.equal(wrapped.emptyPolls, 1, 'the wrapped poll is counted');
    assert.notEqual(wrapped.firstEmptyPollAtMs, null, 'the text()-wrapped immediate poll keeps its start timestamp');
  });
});

test('a wrapped wait yielding a new cell stays a sequential continuation', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // A yields cell 7; wait1 for cell 7 ITSELF yields cell 10; resuming
      // cell 10 is a continuation (no overlap), and its completion settles
      // the whole chain — the trailing sequential poll stays clean.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'a1', input: 'const r = await tools.exec_command({cmd:"x",yield_time_ms:30000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:32.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'a1', output: 'Script running with cell ID 7\n' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:33.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'wait', call_id: 'w1', arguments: JSON.stringify({ cell_id: 7 }) } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'w1', output: 'Script running with cell ID 10\n' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'wait', call_id: 'w2', arguments: JSON.stringify({ cell_id: 10 }) } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'w2', output: 'Script completed' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:05.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:03:05.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 0, 'the wrapped-wait chain is sequential end to end');
  });
});

test('an arbitrary intervening await does not serialize two started polls', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // Poll A starts, an UNRELATED await runs, poll B starts before A is
      // awaited: the observations overlap.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const p = tools.write_stdin({id:"s1",input:"",yield_time_ms:60000});await Promise.resolve();const q = tools.write_stdin({id:"s2",input:"",yield_time_ms:60000});await p;await q;' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      // The compliant shape: the await references the preceding poll's own
      // promise — sequential.
      JSON.stringify({ timestamp: '2026-10-01T00:01:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'const p = tools.write_stdin({id:"s1",input:"",yield_time_ms:60000});await p;const q = tools.write_stdin({id:"s2",input:"",yield_time_ms:60000});await q;' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 1, 'only the unrelated-await shape overlaps');
  });
});

test('spaced computed yield keys participate in last-property-wins', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.write_stdin({session_id:1,chars:"",yield_time_ms:60000, ["yield_time_ms"]:5000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      // A spaced DYNAMIC key could override unresolvably: fail closed.
      JSON.stringify({ timestamp: '2026-10-01T00:02:00.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'const r = await tools.write_stdin({session_id:1,chars:"",yield_time_ms:60000, [k]:5000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:03:00.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.deepEqual(summary.requestedYieldsMs, [5000], 'the spaced supported computed key resolves last-property-wins');
    assert.deepEqual(summary.calls.map((call) => call.yieldTimeMs), [5000, null], 'the spaced dynamic key leaves the yield unclassified');
  });
});

test('poll storage order and formatting helpers stay honest about concurrency', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // BOTH polls start before either is awaited: overlap.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const p = tools.write_stdin({id:"s1",input:"",yield_time_ms:60000});const q = tools.write_stdin({id:"s2",input:"",yield_time_ms:60000});await p;await q;' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      // One poll plus an UNRELATED map formatter: sequential, no overlap.
      JSON.stringify({ timestamp: '2026-10-01T00:01:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'const r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output.split("\\n").map(line => line.trim()).join("\\n"));' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 1, 'the start-before-await shape overlaps; the formatting map stays sequential');
  });
});

test('computed yield keys resolve last-property-wins or fail closed', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // A SUPPORTED computed key: last property wins (5000).
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.write_stdin({session_id:1,chars:"",yield_time_ms:60000,["yield_time_ms"]:5000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      // An UNRESOLVABLE computed key could override the yield: fail closed.
      JSON.stringify({ timestamp: '2026-10-01T00:02:00.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'const r = await tools.write_stdin({session_id:1,chars:"",yield_time_ms:60000,[k]:5000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:03:00.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.deepEqual(summary.requestedYieldsMs, [5000], 'the supported computed key participates in last-property-wins');
    assert.deepEqual(summary.calls.map((call) => call.yieldTimeMs), [5000, null], 'an unresolvable computed key leaves the yield unclassified');
  });
});

test('repeated non-combinator dispatches overlap; awaited promise variables stay sequential', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // [1,2].forEach(callback-with-poll): one lexical site, TWO polls.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: '[1,2].forEach(async () => await tools.write_stdin({session_id:17,chars:"",yield_time_ms:60000}));' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      // Each promise stored and awaited BEFORE the next poll: strictly
      // sequential — no overlap.
      JSON.stringify({ timestamp: '2026-10-01T00:01:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'const p = tools.write_stdin({id:"s1",input:"",yield_time_ms:60000});await p;const q = tools.write_stdin({id:"s2",input:"",yield_time_ms:60000});await q;' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 1, 'the repeated forEach dispatch overlaps; awaited promise variables stay sequential');
  });
});

test('delayed argument evaluation leaves the poll start unproven', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.write_stdin({session_id: await new Promise(resolve => setTimeout(() => resolve(17), 60000)),chars:"",yield_time_ms:60000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.emptyPolls, 1, 'the poll is still counted');
    assert.equal(summary.firstEmptyPollAtMs, null, 'an awaiting argument delays the poll past the call timestamp');
  });
});

test('a nested yield key never overrides the outer request', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.write_stdin({session_id:1,chars:"",yield_time_ms: 60000 + ({yield_time_ms:5000}).yield_time_ms});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.deepEqual(summary.requestedYieldsMs, [], 'the expression request (with a nested key) stays unclassified');
  });
});

test('command-string contents never void the exact worker invocation', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const line = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    const meta = (id, parentId) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'session_meta', payload: { id, parent_thread_id: parentId } });
    // The exact command CONTAINS `...` and `cmd:` inside its quoted value:
    // content, never executable syntax.
    const exactCommand = "node '/tmp/run.../wait-route-worker.mjs' --duration-ms 1000 --flag 'cmd: not real'";
    const rootRollout = [
      meta('root-t'),
      line({ type: 'function_call', call_id: 's1', name: 'spawn_agent', arguments: JSON.stringify({ agent_type: SYNTHETIC_ROLE_NAME }) }),
      line({ type: 'function_call_output', call_id: 's1', output: 'ok' }),
    ].join('\n');
    const childRollout = [
      meta('child-t', 'root-t'),
      line({ type: 'function_call', call_id: 'e1', name: 'exec_command', arguments: JSON.stringify({ cmd: exactCommand, yield_time_ms: 30000 }) }),
      line({ type: 'function_call_output', call_id: 'e1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), childRollout, { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(sessions, 'rollout-root.jsonl'), rootRollout, { encoding: 'utf8', mode: 0o600 });
    const summary = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(summary), true, 'command-string contents are not executable syntax');
  });
});

test('helper identifiers containing operation names and accessor properties stay honest', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // A helper NAMED like an operation runs no shell tool.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const my_exec_command = (x) => x;\nmy_exec_command("a");' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'a' } }),
      // A getter computes its value at read time: the effective stdin
      // input is unprovable.
      JSON.stringify({ timestamp: '2026-10-01T00:00:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'const r = await tools.write_stdin({session_id:17, get chars(){return "x"}, yield_time_ms:60000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:05.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'ok' } }),
      // The positive control: the REAL operation name still counts.
      JSON.stringify({ timestamp: '2026-10-01T00:00:06.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c3', input: 'const r = await tools.exec_command({cmd:"x",yield_time_ms:30000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:36.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c3', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.initialExecCalls, 1, 'only the real operation name counts as the initial exec');
    assert.equal(summary.emptyPolls, 0, 'an accessor-property write is not an empty poll');
    assert.equal(summary.parallelToolCallViolations, 0, 'no false concurrency from a helper name');
  });
});

test('template-literal and block-comment operation mentions are not operations', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'text(`exec_command({cmd:"not executed"})`);\n/* write_stdin({id:"s",input:""}) */\n' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'ok' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.initialExecCalls, 0, 'a template-literal exec_command mention is not an initial exec');
    assert.equal(summary.emptyPolls, 0, 'a block-commented write_stdin mention is not an empty poll');
    assert.equal(summary.otherFunctionCalls, 1, 'the unclassifiable script stays counted as other');
  });
});

test('a spread or duplicate key voids an explicit empty-input poll proof', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // An explicit literal empty input IS an empty poll.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.write_stdin({session_id:1,chars:"",yield_time_ms:60000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'ok' } }),
      // A trailing spread can override the earlier literal: not provable.
      JSON.stringify({ timestamp: '2026-10-01T00:00:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'const r = await tools.write_stdin({session_id:1,chars:"",...args});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:05.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'ok' } }),
      // A duplicate key can override the first literal: not provable.
      JSON.stringify({ timestamp: '2026-10-01T00:00:06.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c3', input: 'const r = await tools.write_stdin({chars:"",chars:"\\u0003"});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:07.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c3', output: 'ok' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.emptyPolls, 1, 'only the unoverridden literal empty input counts as the empty poll');
    assert.equal(summary.otherFunctionCalls, 2, 'overridden empties stay unclassified');
  });
});

test('sequential awaited observations in one script are not concurrency', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const a = await tools.write_stdin({id:"s1",input:"",yield_time_ms:60000});text(a.output);\nconst b = await tools.write_stdin({id:"s2",input:"",yield_time_ms:60000});text(b.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      // Comments and parens between `await` and the receiver are valid
      // syntax: both calls remain sequential.
      JSON.stringify({ timestamp: '2026-10-01T00:01:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'const a = await /* observation */ tools.write_stdin({id:"s1",input:"",yield_time_ms:60000});text(a.output);\nconst b = await (tools.write_stdin({id:"s2",input:"",yield_time_ms:60000}));text(b.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.emptyPolls, 4, 'all sequential observations are counted');
    assert.equal(summary.parallelToolCallViolations, 0, 'await-chained observations — including commented and parenthesized awaits — are sequential');
  });
});

test('escaped quotes stay string contents during operation scanning', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.exec_command({cmd:"echo \\"write_stdin({id:\\"s\\",input:\\"\\"})\\" logged",yield_time_ms:30000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:33.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.initialExecCalls, 1, 'the real exec_command is counted');
    assert.equal(summary.emptyPolls, 0, 'an escaped-quote mention inside the cmd string is not an empty poll');
    assert.equal(summary.parallelToolCallViolations, 0, 'no false concurrency from string contents');
  });
});

test('ordinary comments never request a yield window', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: '// example: {yield_time_ms:3600000}\nconst r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.deepEqual(summary.requestedYieldsMs, [60000], 'a commented yield example is not a request; only the real parameter counts');
  });
});

test('role evidence fails closed on a second spawn or a truncated scan', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const line = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    const meta = (id, parentId) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'session_meta', payload: { id, parent_thread_id: parentId } });
    // TWO synthetic-role spawns: the executed child's identity is
    // ambiguous, so the run proves nothing even with a linked child exec.
    const rootRollout = [
      meta('root-t'),
      line({ type: 'function_call', call_id: 's1', name: 'spawn_agent', arguments: JSON.stringify({ agent_type: SYNTHETIC_ROLE_NAME }) }),
      line({ type: 'function_call_output', call_id: 's1', output: 'ok' }),
      line({ type: 'function_call', call_id: 's2', name: 'spawn_agent', arguments: JSON.stringify({ agent_type: SYNTHETIC_ROLE_NAME }) }),
      line({ type: 'function_call_output', call_id: 's2', output: 'ok' }),
    ].join('\n');
    const childRollout = [
      meta('child-t', 'root-t'),
      line({ type: 'function_call', call_id: 'e1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'run the probe worker', yield_time_ms: 30000 }) }),
      line({ type: 'function_call_output', call_id: 'e1', output: 'done' }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), childRollout, { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(sessions, 'rollout-root.jsonl'), rootRollout, { encoding: 'utf8', mode: 0o600 });
    const twoSpawns = { session: await summarizeCodexSessions({ sessionsDirectory: sessions }) };
    assert.equal(roleChildProven(twoSpawns), false, 'a second spawn makes the executed child ambiguous');
    // A truncated scan cannot establish the spawn count: fail closed.
    await writeFile(join(sessions, 'rollout-root.jsonl'), [
      meta('root-t'),
      line({ type: 'function_call', call_id: 's1', name: 'spawn_agent', arguments: JSON.stringify({ agent_type: SYNTHETIC_ROLE_NAME }) }),
      line({ type: 'function_call_output', call_id: 's1', output: 'ok' }),
    ].join('\n'), { encoding: 'utf8', mode: 0o600 });
    const truncated = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, maxLineBytes: 64 }) };
    assert.equal(roleChildProven(truncated), false, 'a truncated scan fails closed');
  });
});

test('a second wait for an unanswered cell overlaps the first', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // A yields cell 7; TWO waits for cell 7 are dispatched before either
      // returns: the first is the continuation, the second overlaps it.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'a1', input: 'const r = await tools.exec_command({cmd:"x",yield_time_ms:30000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:32.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'a1', output: 'Script running with cell ID 7\n' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:33.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'wait', call_id: 'w1', arguments: JSON.stringify({ cell_id: 7 }) } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:34.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'wait', call_id: 'w2', arguments: JSON.stringify({ cell_id: 7 }) } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:34.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'w1', output: 'Script completed' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:34.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'w2', output: 'Script completed' } }),
      // After both waits settle, a sequential poll is clean.
      JSON.stringify({ timestamp: '2026-10-01T00:02:35.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:03:35.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 1, 'the second concurrent wait overlaps the unanswered first');
  });
});

test('a wait answered with a live handle retires its mapping for later sequential waits', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // Long observation: wait1 returns STILL RUNNING (its mapping must
      // retire), then a SEQUENTIAL wait2 for the same cell — no overlap.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'a1', input: 'const r = await tools.exec_command({cmd:"x",yield_time_ms:30000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:32.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'a1', output: 'Script running with cell ID 7\n' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:33.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'wait', call_id: 'w1', arguments: JSON.stringify({ cell_id: 7 }) } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:33.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'w1', output: 'Script running with cell ID 7\n' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:34.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'wait', call_id: 'w2', arguments: JSON.stringify({ cell_id: 7 }) } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:34.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'w2', output: 'Script completed' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:35.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:03:35.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 0, 'a returned wait no longer occupies its cell; the sequential wait is clean');
  });
});

test('the effective structured input field decides the poll classification', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // Both fields EMPTY: an empty poll.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', call_id: 's1', arguments: JSON.stringify({ input: '', chars: '' }) } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:03.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 's1', output: '{}' } }),
      // Legacy empty `input` with a NONEMPTY `chars` (Ctrl-C): the
      // effective write is the interrupt — conflicting fields stay
      // unclassified, never an empty poll.
      JSON.stringify({ timestamp: '2026-10-01T00:00:04.000Z', type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', call_id: 's2', arguments: JSON.stringify({ input: '', chars: '\\u0003' }) } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:05.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 's2', output: '{}' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.emptyPolls, 1, 'only the consistently empty write is an empty poll');
    assert.equal(summary.otherFunctionCalls, 1, 'the conflicting interrupt write stays unclassified');
  });
});

test('quoted strings inside template interpolations stay opaque', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'text(`${"exec_command({})"}`);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'ok' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.initialExecCalls, 0, 'a printed string inside an interpolation is not an initial exec');
    assert.equal(summary.otherFunctionCalls, 1, 'the unclassifiable script stays counted as other');
  });
});

test('structured waits resolve against every outstanding cell', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // A yields cell 1; overlapping B yields cell 2 (the ONE violation);
      // then waits for BOTH cells — each is a continuation of its own
      // cell, and each completion retires only that cell. The trailing
      // sequential poll is clean.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'a1', input: 'const r = await tools.exec_command({cmd:"x",yield_time_ms:30000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:32.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'a1', output: 'Script running with cell ID 1\n' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:33.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'b1', input: 'const r = await tools.exec_command({cmd:"y",yield_time_ms:30000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'b1', output: 'Script running with cell ID 2\n' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'wait', call_id: 'w1', arguments: JSON.stringify({ cell_id: 1 }) } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:34.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'w1', output: 'Script completed' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:35.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'wait', call_id: 'w2', arguments: JSON.stringify({ cell_id: 2 }) } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:05.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'w2', output: 'Script completed' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:06.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:03:06.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 1, 'only the overlapping launch is flagged; waits for older cells are continuations that retire their own cell');
  });
});

test('waits completing in reverse order still settle their own cells', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // A yields cell 7; overlapping B yields cell 8 (violation #1). Their
      // waits complete in REVERSE order: cell 8 first (clearing the
      // latest-yield flag), then cell 7 — whose mapped completion must
      // still retire A. The trailing sequential poll stays clean.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'a1', input: 'const r = await tools.exec_command({cmd:"x",yield_time_ms:30000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:32.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'a1', output: 'Script running with cell ID 7\n' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:33.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'b1', input: 'const r = await tools.exec_command({cmd:"y",yield_time_ms:30000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'b1', output: 'Script running with cell ID 8\n' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'wait', call_id: 'w8', arguments: JSON.stringify({ cell_id: 8 }) } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:34.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'w8', output: 'Script completed' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:35.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'wait', call_id: 'w7', arguments: JSON.stringify({ cell_id: 7 }) } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:05.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'w7', output: 'Script completed' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:06.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:03:06.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 1, 'the reverse-order completion must not strand cell 7; only the launch overlap counts');
  });
});

test('a continuation script carrying its own fresh poll still overlaps', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // A yields cell 7. The next script is a continuation of cell 7 BUT
      // also launches a fresh poll: the poll part overlaps — the
      // exemption covers the wait, never the additional observation.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'a1', input: 'const r = await tools.exec_command({cmd:"x",yield_time_ms:30000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:32.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'a1', output: 'Script running with cell ID 7\n' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:33.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'w1', input: 'const p = await tools.write_stdin({id:"s1",input:"",yield_time_ms:60000});text(p.output);\nconst r = await tools.wait({cell_id:7});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:33.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'w1', output: 'Script completed' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 1, 'the fresh poll inside the continuation script overlaps cell 7');
  });
});

test('a duplicate cell_id key makes the wait continuation unclassified', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // A yields cell 7. `wait({cell_id:7,cell_id:999})` passes 999 in
      // JavaScript: it is NOT cell 7's continuation (violation #1), and
      // its completion must not retire cell 7 — the next poll overlaps
      // again (violation #2).
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'a1', input: 'const r = await tools.exec_command({cmd:"x",yield_time_ms:30000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:32.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'a1', output: 'Script running with cell ID 7\n' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:33.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'w1', input: 'const r = await tools.wait({cell_id:7,cell_id:999});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:33.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'w1', output: 'Script completed' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:34.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:34.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'still running' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 2, 'the ambiguous wait is an overlap and its completion never retires cell 7');
  });
});

test('content-item outputs feed observation state and the completion marker', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const line = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    const meta = (id, parentId) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'session_meta', payload: { id, parent_thread_id: parentId } });
    const rootRollout = [
      meta('root-t'),
      line({ type: 'function_call', call_id: 's1', name: 'spawn_agent', arguments: JSON.stringify({ agent_type: SYNTHETIC_ROLE_NAME }) }),
      line({ type: 'function_call_output', call_id: 's1', output: 'ok' }),
    ].join('\n');
    // The linked child's exec result arrives as CONTENT ITEMS (the pinned
    // code-mode rollout shape): the marker must still credit, and the
    // yielded-script completion must still settle pending state.
    const exactCommand = "node '/tmp/run/wait-route-worker.mjs' --duration-ms 1000";
    const childRollout = [
      meta('child-t', 'root-t'),
      line({ type: 'function_call', call_id: 'e1', name: 'exec_command', arguments: JSON.stringify({ cmd: exactCommand, yield_time_ms: 30000 }) }),
      line({ type: 'function_call_output', call_id: 'e1', output: [{ type: 'input_text', text: 'Script running with cell ID 5\n' }] }),
      line({ type: 'custom_tool_call', call_id: 'p1', name: 'exec', input: 'const r = await tools.wait({cell_id:5});text(r.output);' }),
      line({ type: 'custom_tool_call_output', call_id: 'p1', output: [{ type: 'input_text', text: COMPLETION_MARKER }] }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), childRollout, { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(sessions, 'rollout-root.jsonl'), rootRollout, { encoding: 'utf8', mode: 0o600 });
    const summary = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(summary), true, 'content-item outputs carry the marker and the live handle');
  });
});

test('a Promise.allSettled dispatch counts the overlapping polls', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'await Promise.allSettled([1,2].map(async () => await tools.write_stdin({id:"s",chars:"",yield_time_ms:60000})));' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 1, 'allSettled is a concurrent dispatch like all');
  });
});

test('a diagnostic sample overflow does not reject valid role evidence', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const line = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    const meta = (id, parentId) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'session_meta', payload: { id, parent_thread_id: parentId } });
    // A LONG root run: the spawn + 70 wait_agent calls overflow the 64-call
    // diagnostic sample, but the FULL-scan facts (spawn count, spawn
    // answer) remain complete.
    const exactCommand = "node '/tmp/run/wait-route-worker.mjs' --duration-ms 1000";
    const rootRollout = [
      meta('root-t'),
      line({ type: 'function_call', call_id: 's1', name: 'spawn_agent', arguments: JSON.stringify({ agent_type: SYNTHETIC_ROLE_NAME }) }),
      line({ type: 'function_call_output', call_id: 's1', output: 'ok' }),
      ...Array.from({ length: 70 }, (_, i) => line({ type: 'function_call', call_id: `w${i}`, name: 'wait_agent', arguments: JSON.stringify({ wait_ms: 1000 }) })),
    ].join('\n');
    const childRollout = [
      meta('child-t', 'root-t'),
      line({ type: 'function_call', call_id: 'e1', name: 'exec_command', arguments: JSON.stringify({ cmd: exactCommand, yield_time_ms: 30000 }) }),
      line({ type: 'function_call_output', call_id: 'e1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), childRollout, { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(sessions, 'rollout-root.jsonl'), rootRollout, { encoding: 'utf8', mode: 0o600 });
    const summary = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(summary.session.callsTruncated, true, 'the diagnostic sample overflows as constructed');
    assert.equal(roleChildProven(summary), true, 'sample truncation is diagnostic; the role proof stands on the full-scan facts');
  });
});

test('role evidence requires the linked child exec to reference the probe worker', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const line = (payload) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'response_item', payload });
    const meta = (id, parentId) => JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'session_meta', payload: { id, parent_thread_id: parentId } });
    const rootRollout = [
      meta('root-t'),
      line({ type: 'function_call', call_id: 's1', name: 'spawn_agent', arguments: JSON.stringify({ agent_type: SYNTHETIC_ROLE_NAME }) }),
      line({ type: 'function_call_output', call_id: 's1', output: 'ok' }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-root.jsonl'), rootRollout, { encoding: 'utf8', mode: 0o600 });
    // The EXACT invocation the driver built (a private-path shape) is the
    // evidence token.
    const exactCommand = "node '/tmp/run/wait-route-worker.mjs' --duration-ms 1000";
    // A mere MENTION (`echo` of the basename and flags) is a printer, not
    // a runner: it must never qualify as the child's worker execution.
    const mentionChild = [
      meta('child-t', 'root-t'),
      line({ type: 'function_call', call_id: 'e1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'echo wait-route-worker.mjs --duration-ms 1000', yield_time_ms: 30000 }) }),
      line({ type: 'function_call_output', call_id: 'e1', output: 'hello' }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), mentionChild, { encoding: 'utf8', mode: 0o600 });
    const mention = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(mention), false, 'a basename mention (echo) is not the worker invocation');
    const exactChild = [
      meta('child-t', 'root-t'),
      line({ type: 'function_call', call_id: 'e1', name: 'exec_command', arguments: JSON.stringify({ cmd: exactCommand, yield_time_ms: 30000 }) }),
      line({ type: 'function_call_output', call_id: 'e1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), exactChild, { encoding: 'utf8', mode: 0o600 });
    const exact = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(exact), true, 'the exact worker invocation in the linked child — with its own completion result — corroborates the lifecycle');
    // An exact-command match whose own result is an error (invalid
    // argument) is an ATTEMPT, never execution: no credit.
    const failedChild = [
      meta('child-t', 'root-t'),
      line({ type: 'function_call', call_id: 'e1', name: 'exec_command', arguments: JSON.stringify({ cmd: exactCommand, yield_time_ms: 99999999 }) }),
      line({ type: 'function_call_output', call_id: 'e1', output: 'Error: invalid yield_time_ms' }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), failedChild, { encoding: 'utf8', mode: 0o600 });
    const failed = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(failed), false, 'an exact-command attempt without a completion result proves nothing');
    // A LONG-RUNING observation: the matched exec returns a LIVE session
    // handle, and the completion marker arrives in a LATER poll OF THAT
    // HANDLE — the child IS proven through its poll chain.
    const longRunningChild = [
      meta('child-t', 'root-t'),
      line({ type: 'function_call', call_id: 'e1', name: 'exec_command', arguments: JSON.stringify({ cmd: exactCommand, yield_time_ms: 30000 }) }),
      line({ type: 'function_call_output', call_id: 'e1', output: 'Process running with session ID s1\n' }),
      line({ type: 'custom_tool_call', call_id: 'p2', name: 'exec', input: 'const r = await tools.write_stdin({id:"s1",input:"",yield_time_ms:60000});text(r.output);' }),
      line({ type: 'custom_tool_call_output', call_id: 'p2', output: `${COMPLETION_MARKER}\nWall time 0.0 seconds\n` }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), longRunningChild, { encoding: 'utf8', mode: 0o600 });
    const longRunning = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(longRunning), true, 'the marker arriving in a poll OF THE RETURNED HANDLE proves the long-running child');
    // A cell-handle variant: the exec yields cell 3 and a wait continuation
    // OF THAT CELL carries the marker.
    const cellChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `tools.exec_command({cmd:${JSON.stringify(exactCommand)},yield_time_ms:30000});` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: 'Script running with cell ID 3\n' }),
      line({ type: 'custom_tool_call', call_id: 'w1', name: 'exec', input: 'const r = await tools.wait({cell_id:3});text(r.output);' }),
      line({ type: 'custom_tool_call_output', call_id: 'w1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), cellChild, { encoding: 'utf8', mode: 0o600 });
    const cellChain = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(cellChain), true, 'the marker arriving in a wait OF THE YIELDED CELL proves the child');
    // A wait for a DIFFERENT cell whose output echoes the marker is an
    // unrelated observation — it never credits this chain.
    const unrelatedWaitChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `tools.exec_command({cmd:${JSON.stringify(exactCommand)},yield_time_ms:30000});` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: 'Script running with cell ID 3\n' }),
      line({ type: 'custom_tool_call', call_id: 'w1', name: 'exec', input: 'const r = await tools.wait({cell_id:999});text(r.output);' }),
      line({ type: 'custom_tool_call_output', call_id: 'w1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), unrelatedWaitChild, { encoding: 'utf8', mode: 0o600 });
    const unrelatedWait = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(unrelatedWait), false, 'a wait for a different handle never credits this chain');
    // Concatenated or duplicated cmd properties have a different EFFECTIVE
    // command: neither credits the exact invocation.
    const concatenatedChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `tools.exec_command({cmd:${JSON.stringify(exactCommand)} + " && echo extra",yield_time_ms:30000});` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), concatenatedChild, { encoding: 'utf8', mode: 0o600 });
    const concatenated = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(concatenated), false, 'a concatenated cmd has a different effective command');
    const duplicatedChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `tools.exec_command({cmd:${JSON.stringify(exactCommand)}, cmd: replacement,yield_time_ms:30000});` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), duplicatedChild, { encoding: 'utf8', mode: 0o600 });
    const duplicated = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(duplicated), false, 'a duplicated cmd property is ambiguous');
    // A quoted MENTION of the handle (`text("id:17")`) never ties a later
    // poll of a DIFFERENT handle to the chain.
    const quotedHandleChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `tools.exec_command({cmd:${JSON.stringify(exactCommand)},yield_time_ms:30000});` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: 'Process running with session ID 17\n' }),
      line({ type: 'custom_tool_call', call_id: 'w1', name: 'exec', input: 'text("id:17");\nconst r = await tools.write_stdin({id:"999",input:"",yield_time_ms:60000});text(r.output);' }),
      line({ type: 'custom_tool_call_output', call_id: 'w1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), quotedHandleChild, { encoding: 'utf8', mode: 0o600 });
    const quotedHandle = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(quotedHandle), false, 'a quoted handle mention cannot tie an unrelated poll to the chain');
    // The structured session_id shape: a function-call host polls the
    // long-running worker with {session_id, chars} — the chain continues.
    const structuredPollChild = [
      meta('child-t', 'root-t'),
      line({ type: 'function_call', call_id: 'e1', name: 'exec_command', arguments: JSON.stringify({ cmd: exactCommand, yield_time_ms: 30000 }) }),
      line({ type: 'function_call_output', call_id: 'e1', output: 'Process running with session ID 17\n' }),
      line({ type: 'function_call', call_id: 'p1', name: 'write_stdin', arguments: JSON.stringify({ session_id: 17, chars: '' }) }),
      line({ type: 'function_call_output', call_id: 'p1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), structuredPollChild, { encoding: 'utf8', mode: 0o600 });
    const structuredPoll = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(structuredPoll), true, 'a structured {session_id} poll continues the worker chain');
    // A numeric EXPRESSION polls a different handle: `session_id:17 + 1`
    // is 18, never 17 — its marker output cannot credit the chain.
    const expressionPollChild = [
      meta('child-t', 'root-t'),
      line({ type: 'function_call', call_id: 'e1', name: 'exec_command', arguments: JSON.stringify({ cmd: exactCommand, yield_time_ms: 30000 }) }),
      line({ type: 'function_call_output', call_id: 'e1', output: 'Process running with session ID 17\n' }),
      line({ type: 'custom_tool_call', call_id: 'p1', name: 'exec', input: 'const r = await tools.write_stdin({session_id:17 + 1,chars:"",yield_time_ms:60000});text(r.output);' }),
      line({ type: 'custom_tool_call_output', call_id: 'p1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), expressionPollChild, { encoding: 'utf8', mode: 0o600 });
    const expressionPoll = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(expressionPoll), false, 'a numeric expression (`17 + 1`) polls a different handle');
    // A multi-exec script shares ONE outer call id: a failed worker attempt
    // followed by an inner echo of the marker must not be attributed to the
    // worker.
    const multiExecChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `tools.exec_command({cmd:${JSON.stringify(exactCommand)},yield_time_ms:30000});\ntools.exec_command({cmd:"echo failed",yield_time_ms:30000});` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: `Error: spawn failed\n${COMPLETION_MARKER}` }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), multiExecChild, { encoding: 'utf8', mode: 0o600 });
    const multiExec = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(multiExec), false, "a multi-exec script's aggregate output cannot prove the matched invocation");
    // A spread can override the literal cmd at runtime: fail closed.
    const spreadCmdChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `tools.exec_command({cmd:${JSON.stringify(exactCommand)}, ...opts,yield_time_ms:30000});` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), spreadCmdChild, { encoding: 'utf8', mode: 0o600 });
    const spreadCmd = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(spreadCmd), false, 'a spread can override the literal cmd');
    // A `role` alias is NOT the host's role field: agent_type is the
    // source-pinned SpawnAgentArgs field, and a default agent_type with a
    // synthetic-looking role alias never exercises the synthetic config.
    const aliasRoleChild = [
      meta('child-t', 'root-t'),
      line({ type: 'function_call', call_id: 's1', name: 'spawn_agent', arguments: JSON.stringify({ agent_type: 'default', role: SYNTHETIC_ROLE_NAME }) }),
      line({ type: 'function_call_output', call_id: 's1', output: 'ok' }),
      line({ type: 'function_call', call_id: 'e1', name: 'exec_command', arguments: JSON.stringify({ cmd: exactCommand, yield_time_ms: 30000 }) }),
      line({ type: 'function_call_output', call_id: 'e1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), aliasRoleChild, { encoding: 'utf8', mode: 0o600 });
    const aliasRole = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(aliasRole), false, "a `role` alias cannot make a default agent_type the synthetic role");
    // A digit-only handle passed as a STRING still continues the chain.
    const quotedNumericChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `tools.exec_command({cmd:${JSON.stringify(exactCommand)},yield_time_ms:30000});` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: 'Process running with session ID 17\n' }),
      line({ type: 'custom_tool_call', call_id: 'p1', name: 'exec', input: 'const r = await tools.write_stdin({id:"17",input:"",yield_time_ms:60000});text(r.output);' }),
      line({ type: 'custom_tool_call_output', call_id: 'p1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), quotedNumericChild, { encoding: 'utf8', mode: 0o600 });
    const quotedNumeric = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(quotedNumeric), true, 'a quoted numeric handle continues the chain');
    // The COMPLETE observation chain with QUOTED keys: the poll's own
    // `{"session_id":17}` key must correlate like the bare form.
    const quotedKeysChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `tools.exec_command({cmd:${JSON.stringify(exactCommand)},yield_time_ms:30000});` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: 'Process running with session ID 17\n' }),
      line({ type: 'custom_tool_call', call_id: 'p1', name: 'exec', input: 'const r = await tools.write_stdin({"session_id":17,"chars":"","yield_time_ms":60000});text(r.output);' }),
      line({ type: 'custom_tool_call_output', call_id: 'p1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), quotedKeysChild, { encoding: 'utf8', mode: 0o600 });
    const quotedKeys = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(quotedKeys), true, 'quoted property keys correlate the observation chain');
    // The handle KIND is preserved: a CELL handle (suspended script) is
    // referenced only through cell_id — a poll of session_id 7 observes a
    // DIFFERENT process, and its marker never credits the chain.
    const crossNamespaceChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `tools.exec_command({cmd:${JSON.stringify(exactCommand)},yield_time_ms:30000});` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: 'Script running with cell ID 7\n' }),
      line({ type: 'custom_tool_call', call_id: 'p1', name: 'exec', input: 'const r = await tools.write_stdin({session_id:7,chars:"",yield_time_ms:60000});text(r.output);' }),
      line({ type: 'custom_tool_call_output', call_id: 'p1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), crossNamespaceChild, { encoding: 'utf8', mode: 0o600 });
    const crossNamespace = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(crossNamespace), false, 'a session-namespace poll never credits a cell handle');
    // A script whose own text prints the marker fabricates the aggregate
    // output: attribution is ambiguous, so it fails closed.
    const fabricatedChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `tools.exec_command({cmd:${JSON.stringify(exactCommand)},yield_time_ms:30000});text("${COMPLETION_MARKER}");` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: 'Error: spawn failed' }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), fabricatedChild, { encoding: 'utf8', mode: 0o600 });
    const fabricated = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(fabricated), false, 'a script printing its own marker cannot fabricate completion');
    // A STRUCTURED JSON running result carries the handle in `session_id`:
    // the chain continues and a matching poll's marker proves the child.
    const structuredHandleChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `text(await tools.exec_command({cmd:${JSON.stringify(exactCommand)},yield_time_ms:30000}));` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: '{"status":"running","session_id":"s9"}' }),
      line({ type: 'custom_tool_call', call_id: 'p1', name: 'exec', input: 'const r = await tools.write_stdin({id:"s9",input:"",yield_time_ms:60000});text(r.output);' }),
      line({ type: 'custom_tool_call_output', call_id: 'p1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), structuredHandleChild, { encoding: 'utf8', mode: 0o600 });
    const structuredHandle = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(structuredHandle), true, 'a structured JSON process handle keeps the chain alive');
    // A STRUCTURED yield return with NO running text is still live: the
    // handle's presence without a completed/exited status keeps the chain.
    const structuredSilentChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `text(await tools.exec_command({cmd:${JSON.stringify(exactCommand)},yield_time_ms:30000}));` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: '{"session_id":17,"output":"","wall_time_seconds":30}' }),
      line({ type: 'custom_tool_call', call_id: 'p1', name: 'exec', input: 'const r = await tools.write_stdin({id:"17",input:"",yield_time_ms:60000});text(r.output);' }),
      line({ type: 'custom_tool_call_output', call_id: 'p1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), structuredSilentChild, { encoding: 'utf8', mode: 0o600 });
    const structuredSilent = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(structuredSilent), true, 'a structured yield return without running text keeps the chain alive');
    // A structured result declaring COMPLETION ends the chain: a later
    // poll's marker cannot resurrect it.
    const structuredDoneChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `text(await tools.exec_command({cmd:${JSON.stringify(exactCommand)},yield_time_ms:30000}));` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: '{"session_id":17,"status":"completed"}' }),
      line({ type: 'custom_tool_call', call_id: 'p1', name: 'exec', input: 'const r = await tools.write_stdin({id:"17",input:"",yield_time_ms:60000});text(r.output);' }),
      line({ type: 'custom_tool_call_output', call_id: 'p1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), structuredDoneChild, { encoding: 'utf8', mode: 0o600 });
    const structuredDone = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(structuredDone), false, 'a structured completed status ends the chain');
    // A completed WRAPPER over a LIVE inner result: the header does not
    // decide liveness — the inner structured result does.
    const wrappedLiveChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `text(await tools.exec_command({cmd:${JSON.stringify(exactCommand)},yield_time_ms:30000}));` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: 'Script completed\n{"session_id":21,"output":"","wall_time_seconds":30}' }),
      line({ type: 'custom_tool_call', call_id: 'p1', name: 'exec', input: 'const r = await tools.write_stdin({id:"21",input:"",yield_time_ms:60000});text(r.output);' }),
      line({ type: 'custom_tool_call_output', call_id: 'p1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), wrappedLiveChild, { encoding: 'utf8', mode: 0o600 });
    const wrappedLive = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(wrappedLive), true, 'an inner live result survives the outer Script-completed header');
    // A continuation script that PRINTS the marker fabricates completion:
    // registration refuses it.
    const fabricatedPollChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `tools.exec_command({cmd:${JSON.stringify(exactCommand)},yield_time_ms:30000});` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: 'Process running with session ID s1\n' }),
      line({ type: 'custom_tool_call', call_id: 'p1', name: 'exec', input: `const r = await tools.write_stdin({id:"s1",input:"",yield_time_ms:60000});text("${COMPLETION_MARKER}");` }),
      line({ type: 'custom_tool_call_output', call_id: 'p1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), fabricatedPollChild, { encoding: 'utf8', mode: 0o600 });
    const fabricatedPoll = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(fabricatedPoll), false, 'a continuation script printing its own marker cannot fabricate completion');
    // A DUPLICATE handle key polls the LAST value: `{session_id:17,
    // session_id:999}` polls 999 — its marker never credits handle 17.
    const duplicateHandleChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `tools.exec_command({cmd:${JSON.stringify(exactCommand)},yield_time_ms:30000});` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: 'Process running with session ID 17\n' }),
      line({ type: 'custom_tool_call', call_id: 'p1', name: 'exec', input: 'const r = await tools.write_stdin({session_id:17,session_id:999,chars:"",yield_time_ms:60000});text(r.output);' }),
      line({ type: 'custom_tool_call_output', call_id: 'p1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), duplicateHandleChild, { encoding: 'utf8', mode: 0o600 });
    const duplicateHandle = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(duplicateHandle), false, 'a duplicate handle key polls the last value, not the matched one');
    // A multi-poll script (worker handle AND an unrelated handle) has an
    // unattributable aggregate output: fail closed.
    const multiPollChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `tools.exec_command({cmd:${JSON.stringify(exactCommand)},yield_time_ms:30000});` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: 'Process running with session ID 17\n' }),
      line({ type: 'custom_tool_call', call_id: 'p1', name: 'exec', input: 'const a = await tools.write_stdin({id:"17",input:"",yield_time_ms:60000});text(a.output);\nconst b = await tools.write_stdin({id:"999",input:"",yield_time_ms:60000});text(b.output);' }),
      line({ type: 'custom_tool_call_output', call_id: 'p1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), multiPollChild, { encoding: 'utf8', mode: 0o600 });
    const multiPoll = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(multiPoll), false, "a multi-poll script's aggregate output cannot prove the matched observation");
    // An output carrying the marker BEFORE the matched exec proves nothing
    // about THAT invocation.
    const earlyMarkerChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call_output', call_id: 'old', output: COMPLETION_MARKER }),
      line({ type: 'function_call', call_id: 'e1', name: 'exec_command', arguments: JSON.stringify({ cmd: exactCommand, yield_time_ms: 30000 }) }),
      line({ type: 'function_call_output', call_id: 'e1', output: 'Error: validation failed' }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), earlyMarkerChild, { encoding: 'utf8', mode: 0o600 });
    const earlyMarker = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(earlyMarker), false, 'a marker output preceding the matched invocation never credits it');
    // A FAILED matched exec followed by an echo of the marker: the echo's
    // output is not the observation's result — no credit.
    const echoMarkerChild = [
      meta('child-t', 'root-t'),
      line({ type: 'function_call', call_id: 'e1', name: 'exec_command', arguments: JSON.stringify({ cmd: exactCommand, yield_time_ms: 30000 }) }),
      line({ type: 'function_call_output', call_id: 'e1', output: 'Error: spawn failed' }),
      line({ type: 'function_call', call_id: 'e2', name: 'exec_command', arguments: JSON.stringify({ cmd: `echo ${COMPLETION_MARKER}`, yield_time_ms: 30000 }) }),
      line({ type: 'function_call_output', call_id: 'e2', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), echoMarkerChild, { encoding: 'utf8', mode: 0o600 });
    const echoMarker = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(echoMarker), false, 'an echo of the marker after a failed exec is not the observation result');
    // A comment mentioning the command, with the EFFECTIVE cmd an echo:
    // the commented cmd is not the executed one.
    const commentCmdChild = [
      meta('child-t', 'root-t'),
      line({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `tools.exec_command({/* cmd: ${JSON.stringify(exactCommand)} */ cmd: "echo done"});` }),
      line({ type: 'custom_tool_call_output', call_id: 'e1', output: COMPLETION_MARKER }),
    ].join('\n');
    await writeFile(join(sessions, 'rollout-child.jsonl'), commentCmdChild, { encoding: 'utf8', mode: 0o600 });
    const commentCmd = { session: await summarizeCodexSessions({ sessionsDirectory: sessions, workerEvidenceToken: exactCommand }) };
    assert.equal(roleChildProven(commentCmd), false, 'a commented-out cmd is not the executed command');
  });
});

test('a failed discovery subtree fails the scan closed', { skip: !posix }, async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const unreadable = join(sessions, 'sealed');
    await mkdir(unreadable, { mode: 0o700 });
    await chmod(unreadable, 0o000);
    await mkdir(join(sessions, 'open'), { mode: 0o700 });
    await writeFile(join(sessions, 'open', 'rollout.jsonl'), `${JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'session_meta', payload: { id: 't' } })}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
      assert.equal(summary.truncated, true, 'an unreadable subtree makes the scan incomplete');
    } finally {
      await chmod(unreadable, 0o700);
    }
  });
});

test('computed property keys keep the effective stdin input unproven', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.write_stdin({session_id:17, ["chars"]:"\\u0003"});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'ok' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.emptyPolls, 0, 'a computed-key interrupt is not an empty poll');
    assert.equal(summary.otherFunctionCalls, 1, 'the computed-key shape stays unclassified');
  });
});

test('discovery bounds the inspected tree and reports truncation', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    // A hostile model-writable tree: more entries than the discovery cap.
    await Promise.all(Array.from({ length: 600 }, (_, i) => writeFile(join(sessions, `noise-${i}.txt`), 'x', { encoding: 'utf8', mode: 0o600 })));
    await writeFile(join(sessions, 'rollout.jsonl'), `${JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', type: 'session_meta', payload: { id: 't' } })}\n`, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions, maxFiles: 1 });
    assert.equal(summary.present, true);
    assert.equal(summary.truncated, true, 'a tree beyond the discovery cap reports truncation');
  });
});

test('a concurrent dispatch scope makes locally awaited polls concurrent', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'await Promise.all([ (async () => { const a = await tools.write_stdin({id:"s1",input:"",yield_time_ms:60000});text(a.output); })(), (async () => { const b = await tools.write_stdin({id:"s2",input:"",yield_time_ms:60000});text(b.output); })() ]);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      // ONE lexical site dispatched N times concurrently is still overlap.
      JSON.stringify({ timestamp: '2026-10-01T00:01:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'await Promise.all([1,2].map(async () => await tools.write_stdin({id:"s",chars:"",yield_time_ms:60000})));' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'done' } }),
      // Mentions in comments or strings are NOT dispatch constructs: a
      // single awaited poll stays sequential.
      JSON.stringify({ timestamp: '2026-10-01T00:02:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c3', input: '// Example: Promise.all(async callback)\nconst a = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(a.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:03:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c3', output: 'done' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:03:05.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c4', input: 'text("Promise.all with an async callback planned");\nconst b = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(b.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:04:05.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c4', output: 'done' } }),
      // A dispatch that FINISHES before the polls cannot overlap them.
      JSON.stringify({ timestamp: '2026-10-01T00:04:06.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c5', input: 'await Promise.all([1].map(async (x) => x + 1));\nconst c = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(c.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:05:06.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c5', output: 'done' } }),
      // An ASYNC HELPER dispatched N times inside a span runs its poll N
      // times concurrently.
      JSON.stringify({ timestamp: '2026-10-01T00:05:07.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c6', input: 'const poll = async () => await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});\nawait Promise.all([poll(), poll()]);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:06:07.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c6', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 3, 'real overlap counts: two dispatch shapes plus the dispatched async helper; mentions and finished dispatches stay sequential');
  });
});

test('a delayed inner poll has no proven start timestamp', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'await sleep(60000);\nconst r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      // A HELPER-BODIED poll: the site sits inside `async function poll()`,
      // invoked long after the call started — its start is unproven even
      // though the definition text has it as the first await.
      JSON.stringify({ timestamp: '2026-10-01T00:02:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'async function poll() { const r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output); }\nawait sleep(120000);\nawait poll();' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:04:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.emptyPolls, 2, 'both delayed polls are still counted');
    assert.equal(summary.firstEmptyPollAtMs, null, 'neither delayed poll start is proven (helper body or preceding await)');
  });
});

test('yields are extracted from the directive and effective tool arguments only', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // An UNRELATED object literal requests nothing; the poll's own 5000
      // governs.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const unused = {yield_time_ms:3600000};\nconst r = await tools.write_stdin({session_id:1,chars:"",yield_time_ms:5000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:32.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      // Duplicate yield keys: the LAST value is effective.
      JSON.stringify({ timestamp: '2026-10-01T00:01:00.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'const r = await tools.write_stdin({session_id:1,chars:"",yield_time_ms:7000,yield_time_ms:9000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:30.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'done' } }),
      // A duplicate whose LAST value is an unsupported expression overrides
      // the earlier literal: the effective request is unclassified.
      JSON.stringify({ timestamp: '2026-10-01T00:02:00.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c3', input: 'const r = await tools.write_stdin({session_id:1,chars:"",yield_time_ms:7000,yield_time_ms:60*1000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:30.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c3', output: 'done' } }),
      // A spread AFTER the yield key can override it: unclassified.
      JSON.stringify({ timestamp: '2026-10-01T00:03:00.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c4', input: 'const r = await tools.write_stdin({session_id:1,chars:"",yield_time_ms:5000,...opts});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:03:30.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c4', output: 'done' } }),
      // An interpolation EXECUTES its expression: the poll inside counts.
      JSON.stringify({ timestamp: '2026-10-01T00:04:00.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c5', input: 'text(`${await tools.write_stdin({session_id:17,chars:"",yield_time_ms:60000})}`);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:05:00.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c5', output: 'done' } }),
      // A TRAILING directive comment is not a request: the poll's own
      // 60000 governs the call sample.
      JSON.stringify({ timestamp: '2026-10-01T00:06:00.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c6', input: 'const r = await tools.write_stdin({session_id:1,chars:"",yield_time_ms:60000});text(r.output);\n// @exec: {"yield_time_ms":3600000}' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:06:30.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c6', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.deepEqual(summary.requestedYieldsMs, [5000, 9000, 60000, 60000], 'only effective tool-argument yields count; overridden values stay unclassified; interpolation polls are sampled');
    assert.equal(summary.emptyPolls, 5, 'explicit literal empty inputs are empty polls even when their YIELD is ambiguous; the spread shape stays unclassified');
    assert.deepEqual(summary.calls[summary.calls.length - 1].yieldTimeMs, 60000, 'a trailing directive comment never governs the call sample');
    assert.equal(summary.parallelToolCallViolations, 0, 'the sequential shape stays clean');
  });
});

test('dispatched helper concurrency requires a polling helper body', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // A FUNCTION-DECLARATION polling helper dispatched N times: overlap.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'async function poll() { const r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output); }\nawait Promise.all([poll(), poll()]);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      // A NON-polling helper dispatched and fully awaited before a single
      // sequential poll: no overlap.
      JSON.stringify({ timestamp: '2026-10-01T00:01:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'const f = async () => 1;\nawait Promise.all([f(), f()]);\nconst r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'done' } }),
      // ONE direct call in the range executes once: no overlap.
      JSON.stringify({ timestamp: '2026-10-01T00:02:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c3', input: 'await Promise.all([tools.write_stdin({session_id:8,chars:"",yield_time_ms:60000})]);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:03:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c3', output: 'done' } }),
      // TWO awaited polls inside ONE callback are sequential: no overlap.
      JSON.stringify({ timestamp: '2026-10-01T00:03:05.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c4', input: 'await Promise.all([async () => { const a = await tools.write_stdin({id:"s1",chars:"",yield_time_ms:60000});text(a.output); const b = await tools.write_stdin({id:"s2",chars:"",yield_time_ms:60000});text(b.output); }()]);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:04:05.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c4', output: 'done' } }),
      // A SINGLE polling-helper invocation cannot overlap anything.
      JSON.stringify({ timestamp: '2026-10-01T00:04:06.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c5', input: 'async function poll() { const r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output); }\nawait Promise.all([poll()]);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:05:06.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c5', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 1, 'only the dispatched polling helper (twice) overlaps; single calls, one-callback awaits, and a single helper invocation stay sequential');
  });
});

test('a comment between a key and its colon keeps the stdin effective value', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.write_stdin({session_id:1, chars /* interrupt */: "\\u0003"});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'ok' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.emptyPolls, 0, 'an interrupt written across a comment is not an empty poll');
    assert.equal(summary.otherFunctionCalls, 1, 'the comment-separated key stays unclassified');
  });
});

test('an inner poll after an awaited exec has no independently observed start time', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // One script: await exec, THEN poll. The poll's start is not the
      // call timestamp — timing stays unproven while the poll still counts.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'await tools.exec_command({cmd:"x",yield_time_ms:30000});\nconst r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.initialExecCalls, 1);
    assert.equal(summary.emptyPolls, 1, 'the inner poll is still counted');
    assert.equal(summary.firstEmptyPollAtMs, null, 'the inner poll start is unproven (the call timestamp is the exec start)');
  });
});

test('an unassociated completion never settles a pending cell', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // A yields cell 1; an unrelated text-only call returns 'Script
      // completed' — it referenced no cell, so A must stay pending and
      // the next poll must count as overlapping.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'a1', input: 'const r = await tools.exec_command({cmd:"x",yield_time_ms:30000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:32.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'a1', output: 'Script running with cell ID 1\n' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:33.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 't1', input: 'text("hello");' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:34.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 't1', output: 'Script completed' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:35.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:35.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'still running' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 2, 'the outstanding cell survives: both the text call and the later poll overlap it');
  });
});

test('shorthand and computed properties keep the effective stdin input unproven', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // Shorthand property: the variable may hold nonempty input.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const chars = "x"; const r = await tools.write_stdin({session_id:1, chars});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'ok' } }),
      // The positive control: a literal empty value IS an empty poll.
      JSON.stringify({ timestamp: '2026-10-01T00:00:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'const r = await tools.write_stdin({session_id:1, chars:""});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:05.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'ok' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.emptyPolls, 1, 'only the literal empty value counts as the empty poll');
    assert.equal(summary.otherFunctionCalls, 1, 'the shorthand property stays unclassified');
  });
});

test('block comments never request a yield window', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: '/* example: {yield_time_ms:3600000} */\nconst r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.deepEqual(summary.requestedYieldsMs, [60000], 'a block-commented example is not a request; only the real parameter counts');
  });
});

test('a quoted wait mention never establishes continuation identity', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // A yields cell 7; then a script that only PRINTS a wait mention and
      // a fresh poll: the poll OVERLAPS the outstanding cell — a violation.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'a1', input: 'const r = await tools.exec_command({cmd:"x",yield_time_ms:30000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:32.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'a1', output: 'Script running with cell ID 7\n' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:33.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'm1', input: "text('wait({cell_id:7})');" } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:34.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'm1', output: 'ok' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:35.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:35.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'still running' } }),
      // An EXPRESSION cell reference (`3 + 1` = cell 4) is not a
      // continuation of cell 3: a completed output for it must not retire
      // cell 3's pending calls.
      JSON.stringify({ timestamp: '2026-10-01T00:01:36.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'w1', input: 'const r = await tools.wait({cell_id:3 + 1});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:36.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'w1', output: 'Script completed' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 3, 'the mention call, the fresh poll, AND the expression wait all overlap; none retires the outstanding cell');
  });
});

test('a commented operation mention in a continuation script never yields', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      // A yields cell 7; the wait continuation's comment mentions
      // write_stdin — the script is still ONLY a wait: its completion must
      // settle cell 7 through the wait-cell handler, and the trailing
      // sequential poll stays clean.
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'a1', input: 'const r = await tools.exec_command({cmd:"x",yield_time_ms:30000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:32.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'a1', output: 'Script running with cell ID 7\n' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:00:33.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'w1', input: '// Resume the write_stdin observation\nconst r = await tools.wait({cell_id:7});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:33.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'w1', output: 'Script completed' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:34.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.write_stdin({id:"s",input:"",yield_time_ms:60000});text(r.output);' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:02:34.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.parallelToolCallViolations, 0, 'the commented mention never registers a yield; the completion settles cell 7');
  });
});

test('whitespace before the call paren keeps awaited chains sequential', async () => {
  await withTempDirectory(async (parent) => {
    const sessions = join(parent, 'sessions');
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const rollout = [
      JSON.stringify({ timestamp: '2026-10-01T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'await tools.exec_command ({cmd:"x",yield_time_ms:30000}); await tools.write_stdin ({session_id:1,chars:"",yield_time_ms:60000});' } }),
      JSON.stringify({ timestamp: '2026-10-01T00:01:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' } }),
      '',
    ].join('\n');
    await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, { encoding: 'utf8', mode: 0o600 });
    const summary = await summarizeCodexSessions({ sessionsDirectory: sessions });
    assert.equal(summary.initialExecCalls, 1, 'the spaced-paren exec is counted');
    assert.equal(summary.emptyPolls, 1, 'the spaced-paren poll is counted');
    assert.equal(summary.parallelToolCallViolations, 0, 'await-chained observations with spaced parens are sequential');
  });
});
