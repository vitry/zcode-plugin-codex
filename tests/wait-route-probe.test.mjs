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
import { basename, isAbsolute, join } from 'node:path';
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
  WORKER_FILE_NAME,
  buildWaitRouteFixture,
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
  runBoundedSubprocess,
  runWaitRouteCase,
  settleOwnedTarget,
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
    '    await appendFile(join(workspace, "worker-launches.jsonl"), JSON.stringify({ event: "worker-launched", pid: worker.pid, pgid: worker.pid, sid: null, identity, starttime }) + "\\n", "utf8");',
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
    '    await appendFile(join(workspace, "worker-launches.jsonl"), JSON.stringify({ event: "worker-launched", pid: worker.pid, pgid: worker.pid, sid: null, identity, starttime }) + "\\n", "utf8");',
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
    assert.deepEqual([...CASE_LABELS], ['shell-window', 'hook-entry', 'authority', 'lifecycle']);
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
