// @ts-nocheck
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildProbeMarketplace } from '../tools/mcp-context-probe/build-fixture.mjs';
import {
  PROBE_EVENTS_MAX_BYTES,
  PROBE_PHASES,
  PROBE_RESULT_KEYS,
  appendProbeEvent,
  hashProbeValue,
  readProbeEvents,
  reduceProbeEvents,
  reduceProbeResult,
} from '../tools/mcp-context-probe/observer.mjs';
import { createProbeServer, probeObserverFromEnv, SERVER_EXIT_GRACE_MS, scheduleDisposalExit } from '../tools/mcp-context-probe/server.mjs';
import { assertAuthoritativeIdentityCorrelation, assertProcessIdentity, captureProcessIdentity, cleanupTargetMatchesIdentity, qualifyMcpContext, resolveProcessInspectionExecutable } from '../tools/mcp-context-probe/qualify.mjs';

const serverModulePath = fileURLToPath(new URL('../tools/mcp-context-probe/server.mjs', import.meta.url));
const posix = process.platform !== 'win32';
const HEX_NONCE = 'a'.repeat(64);

function runNonce() { return randomBytes(32).toString('hex'); }
function newCallNonce() { return randomBytes(16).toString('hex'); }

async function withProbeRun(prefix, setup) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await chmod(directory, 0o700);
  try { return await setup(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

let fixtureCounter = 0;

/** Deterministic, distinct, valid 64-hex fake hash for fixtures. */
function fakeHash(label) {
  return createHash('sha256').update(label).digest('hex');
}

/** A capture-started body whose hashes are distinct on every call. */
function captureStartedBody(overrides = {}) {
  fixtureCounter += 1;
  const seed = String(fixtureCounter);
  return {
    kind: 'capture-started',
    callNonce: newCallNonce(),
    identityComplete: true,
    threadHash: fakeHash(`thread-${seed}`),
    turnHash: fakeHash(`turn-${seed}`),
    workspaceHash: fakeHash(`workspace-${seed}`),
    metaHash: fakeHash(`meta-${seed}`),
    ...overrides,
  };
}

function serverStartedBody(observerPaths = { eventsPath: '/run/events.jsonl', lockPath: '/run/events.lock' }) {
  return { kind: 'server-started', serverPid: process.pid, eventsPath: observerPaths.eventsPath, lockPath: observerPaths.lockPath };
}

function holdStartedBody() { return { kind: 'hold-started', callNonce: newCallNonce() }; }

function holdSettledBody(callNonceValue, settlement = 'signal-abort') {
  return { kind: 'hold-settled', callNonce: callNonceValue, settlement };
}

function captureSettledBody(callNonceValue) { return { kind: 'capture-settled', callNonce: callNonceValue }; }

function phaseBody(phase, observed = true) { return { kind: 'phase-observed', phase, observed }; }

/**
 * The complete all-true synthetic qualification log: matrix (root, child,
 * child later turn, two concurrent children), workspace B, sigint cancel,
 * sigkill disconnect, and the 2-second host timeout phase.
 */
function qualifiedEventSequence(observerPaths = null) {
  const nonce = HEX_NONCE;
  const now = new Date().toISOString();
  const events = [];
  const push = (body) => events.push({ runNonce: nonce, timestamp: now, event: body });
  const settledCapture = (body) => { push(body); push(captureSettledBody(body.callNonce)); };
  if (observerPaths) push(serverStartedBody(observerPaths));
  push(phaseBody('matrix'));
  // A real workspace field is stable within workspace A: every matrix
  // capture hashes the same invocation workspace, and workspace B differs.
  const workspaceAHash = fakeHash('workspace-a');
  const root = captureStartedBody({ workspaceHash: workspaceAHash });
  const child = captureStartedBody({ workspaceHash: workspaceAHash });
  const later = captureStartedBody({ threadHash: child.threadHash, workspaceHash: workspaceAHash });
  const concurrentOne = captureStartedBody({ workspaceHash: workspaceAHash });
  const concurrentTwo = captureStartedBody({ workspaceHash: workspaceAHash });
  settledCapture(root); settledCapture(child); settledCapture(later);
  settledCapture(concurrentOne); settledCapture(concurrentTwo);
  push(phaseBody('workspace-b'));
  settledCapture(captureStartedBody({ workspaceHash: fakeHash('workspace-b') }));
  push(phaseBody('sigint-cancel'));
  const heldOne = holdStartedBody(); push(heldOne); push(holdSettledBody(heldOne.callNonce, 'signal-abort'));
  push(phaseBody('sigkill-disconnect'));
  const heldTwo = holdStartedBody(); push(heldTwo); push(holdSettledBody(heldTwo.callNonce, 'transport-close'));
  push(phaseBody('short-timeout'));
  const heldThree = holdStartedBody(); push(heldThree); push(holdSettledBody(heldThree.callNonce, 'signal-abort'));
  return events;
}

async function appendAll(runDirectory, nonce, bodies) {
  for (const body of bodies) await appendProbeEvent({ runDirectory, runNonce: nonce, event: body });
}

test('buildProbeMarketplace creates the complete installable probe marketplace', async () => {
  await withProbeRun('zcode-probe-fixture-', async (run) => {
    const output = join(run, 'marketplace');
    await mkdir(output, { mode: 0o700 });
    await buildProbeMarketplace({ output, server: serverModulePath, toolTimeoutSec: 30 });
    const plugin = join(output, 'plugins', 'zcode-mcp-context-probe');
    const marketplace = JSON.parse(await readFile(join(output, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
    assert.equal(marketplace.name, 'zcode-mcp-probe');
    assert.equal(marketplace.plugins.length, 1);
    assert.equal(marketplace.plugins[0].name, 'zcode-mcp-context-probe');
    assert.equal(marketplace.plugins[0].source.source, 'local');
    assert.equal(marketplace.plugins[0].source.path, './plugins/zcode-mcp-context-probe');
    const manifest = JSON.parse(await readFile(join(plugin, '.codex-plugin', 'plugin.json'), 'utf8'));
    assert.equal(manifest.name, 'zcode-mcp-context-probe');
    const descriptor = JSON.parse(await readFile(join(plugin, '.mcp.json'), 'utf8'));
    assert.equal(Object.keys(descriptor.mcpServers).length, 1);
    const server = Object.values(descriptor.mcpServers)[0];
    assert.equal(server.command, 'node');
    assert.deepEqual(server.args, [serverModulePath]);
    assert.equal(server.enabled, true);
    assert.deepEqual(server.env_vars, ['ZCODE_MCP_PROBE_EVENTS', 'ZCODE_MCP_PROBE_LOCK', 'ZCODE_MCP_PROBE_NONCE']);
    assert.equal(server.tool_timeout_sec, 30);
    assert.match(await readFile(join(plugin, 'skills', 'context', 'SKILL.md'), 'utf8'), /\$zcode-mcp-context-probe:context/);
    assert.ok((await readFile(join(plugin, 'skills', 'context', 'agents', 'openai.yaml'), 'utf8')).length > 0);
  });
});

test('buildProbeMarketplace emits the separate short-timeout marketplace', async () => {
  await withProbeRun('zcode-probe-fixture-', async (run) => {
    const output = join(run, 'marketplace-2s');
    await mkdir(output, { mode: 0o700 });
    await buildProbeMarketplace({ output, server: serverModulePath, toolTimeoutSec: 2 });
    const descriptor = JSON.parse(await readFile(join(output, 'plugins', 'zcode-mcp-context-probe', '.mcp.json'), 'utf8'));
    assert.equal(Object.values(descriptor.mcpServers)[0].tool_timeout_sec, 2);
  });
});

test('buildProbeMarketplace rejects unsafe output directories and servers', async () => {
  await withProbeRun('zcode-probe-fixture-', async (run) => {
    await writeFile(join(run, 'stray.txt'), 'occupied');
    await assert.rejects(
      () => buildProbeMarketplace({ output: run, server: serverModulePath, toolTimeoutSec: 30 }),
      /empty/i,
    );
    await rm(join(run, 'stray.txt'));
    const wrongMode = join(run, 'wrong-mode');
    await mkdir(wrongMode, { mode: 0o755 });
    if (posix) await assert.rejects(
      () => buildProbeMarketplace({ output: wrongMode, server: serverModulePath, toolTimeoutSec: 30 }),
      /0700/,
    );
    const linked = join(run, 'linked');
    await symlink(run, linked);
    await assert.rejects(() => buildProbeMarketplace({ output: linked, server: serverModulePath, toolTimeoutSec: 30 }));
    await assert.rejects(() => buildProbeMarketplace({ output: join(run, 'absent'), server: serverModulePath, toolTimeoutSec: 30 }));
    await assert.rejects(
      () => buildProbeMarketplace({ output: join(run, 'fresh-a'), server: 'server.mjs', toolTimeoutSec: 30 }),
      /absolute/i,
    );
    const linkedServer = join(run, 'server-link.mjs');
    await symlink(serverModulePath, linkedServer);
    await assert.rejects(
      () => buildProbeMarketplace({ output: join(run, 'fresh-b'), server: linkedServer, toolTimeoutSec: 30 }),
    );
    await assert.rejects(
      () => buildProbeMarketplace({ output: join(run, 'fresh-c'), server: serverModulePath, toolTimeoutSec: 15 }),
      /toolTimeoutSec/,
    );
  });
});

test('appendProbeEvent appends durable mode-0600 events under the advisory lock', async () => {
  await withProbeRun('zcode-probe-events-', async (run) => {
    const nonce = runNonce();
    await appendProbeEvent({ runDirectory: run, runNonce: nonce, event: serverStartedBody() });
    const eventsPath = join(run, 'events.jsonl');
    if (posix) {
      assert.equal((await lstat(eventsPath)).mode & 0o777, 0o600);
      assert.equal((await lstat(join(run, 'events.lock'))).mode & 0o777, 0o700);
      assert.equal((await lstat(join(run, 'events.lock', 'advisory.lock'))).mode & 0o777, 0o600);
    }
    const lines = (await readFile(eventsPath, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.runNonce, nonce);
    assert.equal(typeof record.timestamp, 'string');
    assert.equal(record.event.kind, 'server-started');
  });
});

test('appendProbeEvent serializes concurrent writers without tearing lines', async () => {
  await withProbeRun('zcode-probe-events-', async (run) => {
    const nonce = runNonce();
    await Promise.all(Array.from({ length: 16 }, () => appendProbeEvent({ runDirectory: run, runNonce: nonce, event: serverStartedBody() })));
    assert.equal((await readProbeEvents({ runDirectory: run, runNonce: nonce })).length, 16);
  });
});

test('appendProbeEvent rejects foreign run nonces', async () => {
  await withProbeRun('zcode-probe-events-', async (run) => {
    await assert.rejects(
      () => appendProbeEvent({ runDirectory: run, runNonce: runNonce(), event: { runNonce: runNonce(), ...serverStartedBody() } }),
      /nonce/i,
    );
  });
});

test('appendProbeEvent rejects symlinked, wrong-mode, and oversized event logs', async () => {
  await withProbeRun('zcode-probe-events-', async (run) => {
    const nonce = runNonce();
    if (posix) {
      await symlink(join(run, 'elsewhere.jsonl'), join(run, 'events.jsonl'));
      await assert.rejects(
        () => appendProbeEvent({ runDirectory: run, runNonce: nonce, event: serverStartedBody() }),
        /symlink|nofollow/i,
      );
      await rm(join(run, 'events.jsonl'));
      await writeFile(join(run, 'events.jsonl'), '');
      await chmod(join(run, 'events.jsonl'), 0o644);
      await assert.rejects(
        () => appendProbeEvent({ runDirectory: run, runNonce: nonce, event: serverStartedBody() }),
        /0600|mode/i,
      );
      await rm(join(run, 'events.jsonl'));
    }
    const line = `${JSON.stringify({ runNonce: nonce, timestamp: new Date().toISOString(), event: phaseBody('matrix') })}\n`;
    const filler = line.repeat(Math.ceil((PROBE_EVENTS_MAX_BYTES + 4096) / Buffer.byteLength(line)));
    await writeFile(join(run, 'events.jsonl'), filler, { mode: 0o600 });
    if (posix) await chmod(join(run, 'events.jsonl'), 0o600);
    await assert.rejects(
      () => appendProbeEvent({ runDirectory: run, runNonce: nonce, event: serverStartedBody() }),
      /bound|size|oversized/i,
    );
  });
});

test('appendProbeEvent rejects unknown, malformed, duplicate-terminal, and startless terminal events', async () => {
  await withProbeRun('zcode-probe-events-', async (run) => {
    const nonce = runNonce();
    await assert.rejects(() => appendProbeEvent({ runDirectory: run, runNonce: nonce, event: { kind: 'unknown-kind' } }), /kind/i);
    await assert.rejects(
      () => appendProbeEvent({ runDirectory: run, runNonce: nonce, event: { kind: 'capture-started', callNonce: newCallNonce() } }),
      /hash|identity|field/i,
    );
    const capture = captureStartedBody();
    await appendProbeEvent({ runDirectory: run, runNonce: nonce, event: capture });
    await appendProbeEvent({ runDirectory: run, runNonce: nonce, event: captureSettledBody(capture.callNonce) });
    await assert.rejects(
      () => appendProbeEvent({ runDirectory: run, runNonce: nonce, event: captureSettledBody(capture.callNonce) }),
      /terminal|duplicate/i,
    );
    await assert.rejects(
      () => appendProbeEvent({ runDirectory: run, runNonce: nonce, event: holdSettledBody(newCallNonce()) }),
      /start/i,
    );
  });
});

test('readProbeEvents returns ordered events and rejects foreign logs', async () => {
  await withProbeRun('zcode-probe-events-', async (run) => {
    const nonce = runNonce();
    assert.deepEqual(await readProbeEvents({ runDirectory: run, runNonce: nonce }), []);
    const first = captureStartedBody(); const second = captureStartedBody();
    await appendProbeEvent({ runDirectory: run, runNonce: nonce, event: first });
    await appendProbeEvent({ runDirectory: run, runNonce: nonce, event: captureSettledBody(first.callNonce) });
    await appendProbeEvent({ runDirectory: run, runNonce: nonce, event: second });
    const events = await readProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.equal(events.length, 3);
    assert.equal(events[0].event.callNonce, first.callNonce);
    assert.equal(events[2].event.callNonce, second.callNonce);
    await assert.rejects(() => readProbeEvents({ runDirectory: run, runNonce: runNonce() }), /nonce/i);
  });
});

test('reduceProbeEvents reduces the full matrix to eight true booleans', () => {
  const result = reduceProbeEvents(qualifiedEventSequence(), { runNonce: HEX_NONCE });
  assert.deepEqual(Object.keys(result).sort(), [...PROBE_RESULT_KEYS].sort());
  for (const value of Object.values(result)) assert.equal(value, true);
});

test('reduceProbeEvents marks exactly the failed assertions false', () => {
  const nonce = HEX_NONCE;
  const mutated = (mutator) => {
    const events = qualifiedEventSequence();
    mutator(events);
    return reduceProbeEvents(events, { runNonce: nonce });
  };
  const capturesOf = (events) => events.filter((record) => record.event.kind === 'capture-started').map((record) => record.event);

  assert.equal(mutated((events) => { capturesOf(events)[0].identityComplete = false; }).rootContextComplete, false);
  assert.equal(mutated((events) => { capturesOf(events)[2].turnHash = capturesOf(events)[1].turnHash; }).laterTurnDistinct, false);
  assert.equal(mutated((events) => { capturesOf(events)[4].threadHash = capturesOf(events)[3].threadHash; }).concurrentChildrenDistinct, false);
  assert.equal(mutated((events) => { capturesOf(events)[5].workspaceHash = capturesOf(events)[0].workspaceHash; }).workspaceDistinct, false);
  assert.equal(mutated((events) => { capturesOf(events)[1].metaHash = capturesOf(events)[0].metaHash; }).metadataChangesAcrossTurns, false);
  const unsettled = mutated((events) => {
    const index = events.findIndex((record) => record.event.kind === 'hold-settled' && record.event.settlement === 'signal-abort');
    events.splice(index, 1);
  });
  assert.equal(unsettled.cancelDelivered, false);
  assert.equal(unsettled.rootContextComplete, true);
  const failedPhase = mutated((events) => {
    for (const record of events) {
      if (record.event.kind === 'phase-observed' && record.event.phase === 'sigkill-disconnect') record.event.observed = false;
    }
  });
  assert.equal(failedPhase.connectionLossDelivered, false);
  assert.equal(failedPhase.cancelDelivered, true);
  assert.equal(mutated((events) => { events.splice(events.findIndex((record) => record.event.kind === 'phase-observed' && record.event.phase === 'workspace-b'), 1); }).workspaceDistinct, false);
});

test('reduceProbeResult writes result.json once with the closed boolean shape', async () => {
  await withProbeRun('zcode-probe-result-', async (run) => {
    const nonce = runNonce();
    await appendAll(run, nonce, qualifiedEventSequence({ eventsPath: join(run, 'events.jsonl'), lockPath: join(run, 'events.lock') }).map((record) => record.event));
    const result = await reduceProbeResult({ runDirectory: run, runNonce: nonce });
    assert.deepEqual(Object.keys(result).sort(), [...PROBE_RESULT_KEYS].sort());
    for (const value of Object.values(result)) assert.equal(value, true);
    const resultPath = join(run, 'result.json');
    if (posix) assert.equal((await lstat(resultPath)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(resultPath, 'utf8')), result);
    await assert.rejects(() => reduceProbeResult({ runDirectory: run, runNonce: nonce }), /exists|overwrite/i);
  });
});

test('reduceProbeResult refuses invalid logs without writing a result', async () => {
  await withProbeRun('zcode-probe-result-', async (run) => {
    const nonce = runNonce();
    const capture = captureStartedBody();
    await appendProbeEvent({ runDirectory: run, runNonce: nonce, event: capture });
    await appendProbeEvent({ runDirectory: run, runNonce: nonce, event: captureSettledBody(capture.callNonce) });
    await appendProbeEvent({ runDirectory: run, runNonce: nonce, event: captureSettledBody(capture.callNonce) }).catch(() => {});
    await assert.rejects(() => reduceProbeResult({ runDirectory: run, runNonce: nonce }));
    const written = await readFile(join(run, 'result.json'), 'utf8').then(() => true, (error) => error.code === 'ENOENT' ? false : undefined);
    assert.equal(written, false);
  });
});

async function connectProbeClient(runDirectory, nonce) {
  const server = createProbeServer({ observer: { runDirectory, runNonce: nonce } });
  const client = new Client({ name: 'probe-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test('the probe server records hashed context through the MCP seam without retaining identity', async () => {
  await withProbeRun('zcode-probe-server-', async (run) => {
    const nonce = runNonce();
    const { client } = await connectProbeClient(run, nonce);
    const workspaceValue = join(run, 'workspace-a');
    const meta = { 'x-codex-turn-metadata': { thread_id: 'probe-thread-root', turn_id: 'probe-turn-1', workspace: workspaceValue } };
    const capture = await client.request({ method: 'tools/call', params: { name: 'capture_context', arguments: {}, _meta: meta } }, CallToolResultSchema);
    assert.equal(capture.isError ?? false, false);
    const events = await readProbeEvents({ runDirectory: run, runNonce: nonce });
    const captureBodies = events.filter((record) => record.event.kind === 'capture-started').map((record) => record.event);
    assert.equal(captureBodies.length, 1);
    const captureBody = captureBodies[0];
    assert.equal(captureBody.identityComplete, true);
    for (const key of ['threadHash', 'turnHash', 'workspaceHash', 'metaHash']) assert.match(captureBody[key], /^[0-9a-f]{64}$/);
    assert.ok(events.some((record) => record.event.kind === 'capture-settled' && record.event.callNonce === captureBody.callNonce));
    const rawLog = await readFile(join(run, 'events.jsonl'), 'utf8');
    for (const raw of ['probe-thread-root', 'probe-turn-1', workspaceValue]) assert.equal(rawLog.includes(raw), false, `raw identity leaked: ${raw}`);
    assert.equal(await hashProbeValue(nonce, workspaceValue), captureBody.workspaceHash);
    await client.close();
  });
});

test('the probe server settles held calls when the transport closes', async () => {
  await withProbeRun('zcode-probe-server-', async (run) => {
    const nonce = runNonce();
    const { client } = await connectProbeClient(run, nonce);
    const heldCall = client.request({ method: 'tools/call', params: { name: 'hold_until_cancelled', arguments: {} } }, CallToolResultSchema).then(
      () => 'returned',
      () => 'abandoned',
    );
    await client.close();
    assert.equal(await heldCall, 'abandoned');
    let holdBodies = [];
    for (let attempt = 0; attempt < 200 && holdBodies.length < 2; attempt += 1) {
      holdBodies = (await readProbeEvents({ runDirectory: run, runNonce: nonce }))
        .map((record) => record.event)
        .filter((body) => body.kind === 'hold-started' || body.kind === 'hold-settled');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const started = holdBodies.find((body) => body.kind === 'hold-started');
    const settled = holdBodies.find((body) => body.kind === 'hold-settled');
    assert.ok(started, 'hold-started must be durable');
    assert.ok(settled, 'hold settlement must be durable before process exit');
    assert.equal(settled.callNonce, started.callNonce);
  });
});

test('the probe server rejects identity arguments and missing metadata and exposes only three tools', async () => {
  await withProbeRun('zcode-probe-server-', async (run) => {
    const nonce = runNonce();
    const { client } = await connectProbeClient(run, nonce);
    const missingMeta = await client.request({ method: 'tools/call', params: { name: 'capture_context', arguments: {} } }, CallToolResultSchema);
    assert.equal(missingMeta.isError, true);
    const identityArgument = await client.request({
      method: 'tools/call',
      params: {
        name: 'capture_context',
        arguments: { threadId: 'smuggled' },
        _meta: { 'x-codex-turn-metadata': { thread_id: 't', turn_id: 'u', workspace: '/w' } },
      },
    }, CallToolResultSchema);
    assert.equal(identityArgument.isError, true);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['capture_context', 'hold_until_cancelled', 'read_assertions']);
    for (const tool of tools.tools) assert.deepEqual(tool.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
    await client.close();
  });
});

test('read_assertions previews the reduced result without writing result.json', async () => {
  await withProbeRun('zcode-probe-server-', async (run) => {
    const nonce = runNonce();
    const { client } = await connectProbeClient(run, nonce);
    await appendProbeEvent({ runDirectory: run, runNonce: nonce, event: phaseBody('matrix', false) });
    const preview = await client.request({ method: 'tools/call', params: { name: 'read_assertions', arguments: {} } }, CallToolResultSchema);
    assert.equal(preview.isError ?? false, false);
    const structured = /** @type {any} */ (preview).structuredContent;
    assert.deepEqual(Object.keys(structured).sort(), [...PROBE_RESULT_KEYS].sort());
    for (const value of Object.values(structured)) assert.equal(typeof value, 'boolean');
    const written = await readFile(join(run, 'result.json'), 'utf8').then(() => true, (error) => error.code === 'ENOENT' ? false : undefined);
    assert.equal(written, false);
    await client.close();
  });
});

test('probeObserverFromEnv requires the three probe environment variables', () => {
  const names = ['ZCODE_MCP_PROBE_EVENTS', 'ZCODE_MCP_PROBE_LOCK', 'ZCODE_MCP_PROBE_NONCE'];
  const previous = { ...process.env };
  try {
    for (const name of names) delete process.env[name];
    assert.throws(() => probeObserverFromEnv(), /ZCODE_MCP_PROBE/);
    process.env.ZCODE_MCP_PROBE_EVENTS = '/tmp/events.jsonl';
    process.env.ZCODE_MCP_PROBE_LOCK = '/tmp/events.lock';
    process.env.ZCODE_MCP_PROBE_NONCE = HEX_NONCE;
    const observer = probeObserverFromEnv();
    assert.equal(observer.runNonce, HEX_NONCE);
  } finally {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, previous);
  }
});

test('qualifyMcpContext validates inputs before touching the Codex host', async () => {
  await withProbeRun('zcode-probe-qualify-', async (run) => {
    await assert.rejects(
      () => qualifyMcpContext({ codexPath: 'codex', sourceCodexHome: run, runDirectory: run }),
      /absolute/i,
    );
    await assert.rejects(
      () => qualifyMcpContext({ codexPath: '/usr/bin/codex', sourceCodexHome: run, runDirectory: join(run, 'absent') }),
      /run directory/i,
    );
    const emptyHome = join(run, 'empty-home');
    await mkdir(emptyHome, { mode: 0o700 });
    // The qualification-unavailable cases need a usable, still-empty run
    // directory; the outer run now hosts the fixture homes.
    await withProbeRun('zcode-probe-qualify-run-', async (qualifyRun) => {
      await assert.rejects(
        () => qualifyMcpContext({ codexPath: '/usr/bin/codex', sourceCodexHome: emptyHome, runDirectory: qualifyRun }),
        /qualification-unavailable/,
      );
      await assert.rejects(
        () => qualifyMcpContext({ codexPath: '/usr/bin/codex', sourceCodexHome: run, runDirectory: qualifyRun }),
        /qualification-unavailable/,
      );
    });
  });
});

test('cleanup signaling rechecks the captured start identity and refuses mismatches', { skip: !posix || resolveProcessInspectionExecutable() === null }, async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const identity = captureProcessIdentity(child.pid);
  assert.ok(identity, 'a live process must expose a captured start identity');
  assert.equal(cleanupTargetMatchesIdentity(child.pid, identity), true);
  assert.equal(cleanupTargetMatchesIdentity(child.pid, 'bogus-not-the-captured-lstart'), false);
  assert.equal(cleanupTargetMatchesIdentity(child.pid, null), false);
  child.kill('SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(cleanupTargetMatchesIdentity(child.pid, identity), false);
});

test('server disposal waits at least the event-lock budget before the forced exit', () => {
  assert.ok(SERVER_EXIT_GRACE_MS >= 6_000, `disposal grace ${SERVER_EXIT_GRACE_MS} must cover the 5s lock budget plus an fsync margin`);
  const scheduled = [];
  const fakeTimer = { unref() { scheduled.push('unref'); } };
  const fakeServer = { onclose: null };
  scheduleDisposalExit(fakeServer, { scheduleTimeout: (fn, ms) => { scheduled.push(ms); void fn; return fakeTimer; } });
  assert.equal(typeof fakeServer.onclose, 'function', 'scheduling installs the close handler');
  fakeServer.onclose();
  assert.deepEqual(scheduled, [SERVER_EXIT_GRACE_MS, 'unref']);
});

test('the final reducer rejects a log with extra hold invocations', async () => {
  await withProbeRun('zcode-probe-result-', async (run) => {
    const nonce = runNonce();
    const bodies = qualifiedEventSequence({ eventsPath: join(run, 'events.jsonl'), lockPath: join(run, 'events.lock') }).map((record) => record.event);
    const extraHold = holdStartedBody();
    bodies.push(extraHold);
    bodies.push(holdSettledBody(extraHold.callNonce, 'signal-abort'));
    await appendAll(run, nonce, bodies);
    await assert.rejects(() => reduceProbeResult({ runDirectory: run, runNonce: nonce }), /hold|census|incomplete/i);
    const written = await readFile(join(run, 'result.json'), 'utf8').then(() => true, (error) => error.code === 'ENOENT' ? false : undefined);
    assert.equal(written, false);
  });
});

test('the final reducer requires durable canonical server startup evidence', async () => {
  await withProbeRun('zcode-probe-server-start-', async (run) => {
    const nonce = runNonce();
    // The default synthetic sequence carries no server-started event.
    await appendAll(run, nonce, qualifiedEventSequence().map((record) => record.event));
    await assert.rejects(() => reduceProbeResult({ runDirectory: run, runNonce: nonce }), /server-started/);
    const written = await readFile(join(run, 'result.json'), 'utf8').then(() => true, (error) => error.code === 'ENOENT' ? false : undefined);
    assert.equal(written, false);
  });
});

test('the qualification rejects a nonempty run directory', async () => {
  await withProbeRun('zcode-probe-nonempty-', async (run) => {
    await writeFile(join(run, 'leftover.txt'), 'pre-existing state');
    await assert.rejects(
      () => qualifyMcpContext({ codexPath: '/bin/true', runDirectory: run, sourceCodexHome: run }),
      /PROBE_RUN_DIRECTORY_NOT_EMPTY|must be empty/,
    );
  });
});

test('the initial Child must be a thread distinct from the Root', () => {
  const events = qualifiedEventSequence();
  const captures = events.filter((record) => record.event.kind === 'capture-started');
  // A host that reports the Root thread for the initial Child also reports it
  // for the Child's follow-up turn: both the Child and its later turn carry
  // the Root hash, and the later-turn assertion must fail, not pass vacuously.
  captures[1].event.threadHash = captures[0].event.threadHash;
  captures[2].event.threadHash = captures[0].event.threadHash;
  const result = reduceProbeEvents(events, { runNonce: HEX_NONCE });
  assert.equal(result.laterTurnDistinct, false);
});

test('workspaceDistinct requires one stable workspace-A value across all matrix captures', () => {
  const events = qualifiedEventSequence();
  const matrixCaptures = events.filter((record) => record.event.kind === 'capture-started').slice(0, 5);
  for (const [index, record] of matrixCaptures.entries()) {
    record.event.workspaceHash = fakeHash(`drifting-workspace-${index}`);
  }
  const result = reduceProbeEvents(events, { runNonce: HEX_NONCE });
  assert.equal(result.workspaceDistinct, false);
});

test('the final reducer rejects a log with extra capture invocations', async () => {
  await withProbeRun('zcode-probe-result-', async (run) => {
    const nonce = runNonce();
    const bodies = qualifiedEventSequence({ eventsPath: join(run, 'events.jsonl'), lockPath: join(run, 'events.lock') }).map((record) => record.event);
    const extraCapture = captureStartedBody();
    bodies.push(extraCapture);
    bodies.push(captureSettledBody(extraCapture.callNonce));
    await appendAll(run, nonce, bodies);
    await assert.rejects(() => reduceProbeResult({ runDirectory: run, runNonce: nonce }), /capture|census|incomplete/i);
    const written = await readFile(join(run, 'result.json'), 'utf8').then(() => true, (error) => error.code === 'ENOENT' ? false : undefined);
    assert.equal(written, false);
  });
});

test('process identity resolution is PATH-independent and validated', () => {
  const executable = resolveProcessInspectionExecutable();
  if (executable === null) return;
  assert.ok(isAbsolute(executable), `${executable} must be an absolute path`);
  const stats = statSync(executable);
  assert.ok(stats.isFile() && (stats.mode & 0o111) !== 0, `${executable} must be a regular executable file`);
});

test('the driver correlates durable captures with the authoritative Host facts', async () => {
  const nonce = runNonce();
  const rootThreadId = 'authoritative-root-thread';
  const workspaceA = '/authoritative/workspace-a';
  const workspaceB = '/authoritative/workspace-b';
  const records = qualifiedEventSequence();
  // Stamp the synthetic captures with the authoritative hashes.
  let matrixSeen = 0;
  for (const record of records) {
    const event = record.event;
    if (event.kind !== 'capture-started') continue;
    if (event.workspaceHash === fakeHash('workspace-a')) {
      event.threadHash = matrixSeen === 0 ? await hashProbeValue(nonce, rootThreadId) : event.threadHash;
      event.workspaceHash = await hashProbeValue(nonce, workspaceA);
      matrixSeen += 1;
    } else if (event.workspaceHash === fakeHash('workspace-b')) {
      event.workspaceHash = await hashProbeValue(nonce, workspaceB);
    }
  }
  await assertAuthoritativeIdentityCorrelation(records, { runNonce: nonce, rootThreadId, workspaceA, workspaceB });
  // The Root thread hash must be the parsed Root thread's hash.
  await assert.rejects(() => assertAuthoritativeIdentityCorrelation(records, {
    runNonce: nonce, rootThreadId: 'a-different-thread', workspaceA, workspaceB,
  }), /Root thread identity/);
  // Workspace A must be the exact workspace-A directory.
  await assert.rejects(() => assertAuthoritativeIdentityCorrelation(records, {
    runNonce: nonce, rootThreadId, workspaceA: '/authoritative/other', workspaceB,
  }), /workspace A/);
  // Workspace B must be the exact workspace-B directory.
  await assert.rejects(() => assertAuthoritativeIdentityCorrelation(records, {
    runNonce: nonce, rootThreadId, workspaceA, workspaceB: '/authoritative/other-b',
  }), /workspace B/);
  // A drifting per-call workspace value cannot pass correlation.
  const drifting = records.map((record) => record.event.kind === 'capture-started' && record.event.workspaceHash !== fakeHash('workspace-b')
    ? { ...record, event: { ...record.event, workspaceHash: fakeHash(`drift-${record.event.callNonce}`) } }
    : record);
  await assert.rejects(() => assertAuthoritativeIdentityCorrelation(drifting, {
    runNonce: nonce, rootThreadId, workspaceA, workspaceB,
  }), /workspace A/);
});

test('durable probe events reject unknown fields', async () => {
  await withProbeRun('zcode-probe-extra-field-', async (run) => {
    const nonce = runNonce();
    const body = captureStartedBody();
    await assert.rejects(
      () => appendProbeEvent({ runDirectory: run, runNonce: nonce, event: { ...body, thread_id: 'raw-identity-leak' } }),
      /unknown field/,
    );
    const held = holdStartedBody();
    await assert.rejects(
      () => appendProbeEvent({ runDirectory: run, runNonce: nonce, event: { ...held, workspace: '/srv/raw' } }),
      /unknown field/,
    );
    const written = await readFile(join(run, 'events.jsonl'), 'utf8').then(() => true, (error) => error.code === 'ENOENT' ? false : undefined);
    assert.equal(written, false, 'a rejected event must not reach the durable log');
  });
});

test('in-phase signalling fails closed without a verifiable identity', { skip: !posix || resolveProcessInspectionExecutable() === null }, async () => {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const identity = captureProcessIdentity(child.pid);
    assert.ok(identity, 'a live process must expose a start identity');
    assertProcessIdentity(child.pid, identity);
    assert.throws(() => assertProcessIdentity(child.pid, null), /refusing to signal/);
    assert.throws(() => assertProcessIdentity(child.pid, 'unrelated start identity'), /refusing to signal/);
  } finally {
    child.kill('SIGKILL');
  }
});

test('probe phases and result keys are the closed qualification vocabulary', () => {
  assert.deepEqual(PROBE_PHASES, ['matrix', 'workspace-b', 'sigint-cancel', 'sigkill-disconnect', 'short-timeout']);
  assert.deepEqual([...PROBE_RESULT_KEYS].sort(), [
    'cancelDelivered', 'concurrentChildrenDistinct', 'connectionLossDelivered',
    'laterTurnDistinct', 'metadataChangesAcrossTurns', 'rootContextComplete',
    'shortTimeoutSettled', 'workspaceDistinct',
  ]);
});
