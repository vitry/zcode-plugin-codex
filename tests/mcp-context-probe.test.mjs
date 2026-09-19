// @ts-nocheck
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildProbeMarketplace } from '../tools/mcp-context-probe/build-fixture.mjs';
import {
  PROBE_CONTEXT_ASSERTIONS,
  PROBE_EVENTS_MAX_BYTES,
  PROBE_LIFECYCLE_CASES,
  PROBE_PHASES,
  appendProbeEvent,
  hashProbeValue,
  readProbeEvents,
  reduceProbeEvents,
  reduceProbeResult,
} from '../tools/mcp-context-probe/observer.mjs';
import { createProbeServer, DISCONNECT_EXIT_GRACE_MS, probeObserverFromEnv, SERVER_EXIT_GRACE_MS, scheduleDisposalExit } from '../tools/mcp-context-probe/server.mjs';
import { APP_SERVER_CAPTURE_PROMPT, appServerCaptureEvidenceGate, boundedStdoutLines, startAppServerSession, mcpCallStatusesFromCounts, ensureHooksFeatureFlag, spawnAgentHandleFromFrame, correlateTurnSet, appServerInitializeParams, appServerThreadStartParams, appServerTurnInterruptParams, appServerTurnStartParams, appServerTurnStatusFromNotifications, appendMcpServerConfig, freshCaptureJoinFacts, assertAuthoritativeIdentityCorrelation, assertProcessIdentity, assertResumeThreadIdentity, assertToolUnavailableTranscript, assembleAppServerTurnInterruptObservation, captureProcessIdentity, cleanupTargetMatchesIdentity, concurrentChildHookFacts, deriveCandidateStrategies, deriveTimeoutToolCallOutcome, deriveTransportState, HOLD_PROMPT, qualifyMcpContext, resolveProcessInspectionExecutable, returnedChildHandleFacts, saltedHashSetsEqual } from '../tools/mcp-context-probe/qualify.mjs';

const serverModulePath = fileURLToPath(new URL('../tools/mcp-context-probe/server.mjs', import.meta.url));
const hookObserverModulePath = fileURLToPath(new URL('../tools/mcp-context-probe/hook-observer.mjs', import.meta.url));
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

/**
 * A capture-started body whose hashes are distinct on every call. All four
 * candidate fields (envelope threadId, inner session_id/thread_id/turn_id)
 * are present, matching a healthy probe capture on the qualified Host.
 */
function captureStartedBody(overrides = {}) {
  fixtureCounter += 1;
  const seed = String(fixtureCounter);
  return {
    kind: 'capture-started',
    callNonce: newCallNonce(),
    identityComplete: true,
    threadHash: fakeHash(`inner-thread-${seed}`),
    turnHash: fakeHash(`inner-turn-${seed}`),
    workspaceHash: null,
    metaHash: fakeHash(`meta-${seed}`),
    envelopeThreadIdHash: fakeHash(`envelope-thread-${seed}`),
    innerSessionIdHash: fakeHash(`inner-session-${seed}`),
    ...overrides,
  };
}

function captureSettledBody(callNonceValue) { return { kind: 'capture-settled', callNonce: callNonceValue }; }

function serverStartedBody(observerPaths = { eventsPath: join('/run', 'events.jsonl'), lockPath: join('/run', 'events.lock') }) {
  return { kind: 'server-started', serverPid: process.pid, eventsPath: observerPaths.eventsPath, lockPath: observerPaths.lockPath };
}

function holdStartedBody() { return { kind: 'hold-started', callNonce: newCallNonce() }; }

function holdSettledBody(callNonceValue, settlement = 'signal-abort') {
  return { kind: 'hold-settled', callNonce: callNonceValue, settlement };
}

function phaseBody(phase, observed = true) { return { kind: 'phase-observed', phase, observed }; }

function hookObservedBody(hook, overrides = {}) {
  return { kind: 'hook-observed', hook, sessionHash: fakeHash(`hook-session-${hook}`), turnHash: null, agentHash: null, ...overrides };
}

function authorityHashBody(authority, scope, overrides = {}) {
  return { kind: 'authority-hash', authority, scope, hash: fakeHash(`${authority}-${scope}`), ...overrides };
}

function equalityFactBody(scope, candidate, authority, equal) {
  return { kind: 'equality-fact', scope, candidate, authority, equal };
}

/** A schema-valid lifecycle observation body for one closed case. */
function lifecycleObservedBody(lifecycleCase, overrides = {}) {
  return {
    kind: 'lifecycle-observed',
    lifecycleCase,
    hostProcess: 'unknown',
    turnTerminalStatus: 'not-observed',
    toolCallOutcome: 'not-observed',
    handlerSettlement: 'not-observed',
    transportState: 'not-observed',
    hookEvent: 'not-observed',
    unknownReason: 'none',
    ...overrides,
  };
}

/** The candidate/authority vocabulary of the salted equality matrix (plan Step 3). */
const THREAD_CANDIDATES = ['envelopeThreadId', 'innerSessionId', 'innerThreadId'];
const ROOT_THREAD_AUTHORITIES = ['appServerThreadId', 'hookSessionId'];
const CHILD_THREAD_AUTHORITIES = ['appServerThreadId', 'hookSessionId', 'hookAgentId', 'returnedChildHandle'];
const TURN_AUTHORITIES = ['appServerTurnId', 'hookTurnId'];

/** The exact equality-matrix key list the plan and e2e both compute. */
function expectedEqualityKeys() {
  const keys = [];
  for (const candidate of THREAD_CANDIDATES) {
    for (const authority of ROOT_THREAD_AUTHORITIES) keys.push(`root:${candidate}==${authority}`);
    for (const authority of CHILD_THREAD_AUTHORITIES) keys.push(`child:${candidate}==${authority}`);
  }
  for (const authority of TURN_AUTHORITIES) {
    keys.push(`root:innerTurnId==${authority}`);
    keys.push(`child:innerTurnId==${authority}`);
  }
  return keys.sort();
}

/**
 * The complete synthetic qualification log under the amended schema: the
 * negative control, the matrix conversation (root, child, child later turn,
 * two concurrent children, resume) with its authority hashes and equality
 * facts, then one held call and one honest observation per lifecycle phase.
 * Matrix-phase captures carry complete candidate hashes; hook observations
 * appear only in the app-server phase (exec conversations do not fire
 * plugin hooks on this host).
 */
function qualifiedEventSequence(observerPaths = null) {
  const nonce = HEX_NONCE;
  const now = new Date().toISOString();
  const events = [];
  const push = (body) => events.push({ runNonce: nonce, timestamp: now, event: body });
  const settledCapture = (body) => { push(body); push(captureSettledBody(body.callNonce)); };
  const serverStarted = () => push(serverStartedBody(observerPaths ?? { eventsPath: join('/run', 'events.jsonl'), lockPath: join('/run', 'events.lock') }));
  // Phase: negative control (marker only — its window must stay free of
  // server/capture events).
  push(phaseBody('negative-control'));
  // Phase: matrix — one Root capture, one Child capture, the Child's later
  // turn, two concurrent Children, and the Root resume.
  push(phaseBody('matrix'));
  serverStarted();
  const root = captureStartedBody();
  const child = captureStartedBody();
  const later = captureStartedBody({ threadHash: child.threadHash });
  const concurrentOne = captureStartedBody();
  const concurrentTwo = captureStartedBody();
  const resume = captureStartedBody({ threadHash: root.threadHash });
  for (const capture of [root, child, later, concurrentOne, concurrentTwo, resume]) settledCapture(capture);
  push(authorityHashBody('stdoutThreadId', 'root'));
  // Phase: cli-sigint — one held call, no settlement, honest observation.
  push(phaseBody('cli-sigint'));
  serverStarted();
  push(holdStartedBody());
  push(lifecycleObservedBody('cliSigint', {
    hostProcess: 'exited-clean',
    turnTerminalStatus: 'not-observed',
    toolCallOutcome: 'pending',
    handlerSettlement: 'not-observed',
    transportState: 'server-exited',
    hookEvent: 'not-observed',
    unknownReason: 'process-exited-first',
  }));
  // Phase: cli-sigkill — one held call settled as transport close.
  push(phaseBody('cli-sigkill'));
  serverStarted();
  const holdSigkill = holdStartedBody();
  push(holdSigkill);
  push(holdSettledBody(holdSigkill.callNonce, 'transport-close'));
  push(lifecycleObservedBody('cliSigkill', {
    hostProcess: 'exited-signal',
    turnTerminalStatus: 'not-observed',
    toolCallOutcome: 'pending',
    handlerSettlement: 'transport-close',
    transportState: 'stdin-eof',
    hookEvent: 'not-observed',
    unknownReason: 'none',
  }));
  // Phase: app-server-interrupt — captures, hook observations, a held call
  // settled by the explicit interrupt, and the honest observation.
  push(phaseBody('app-server-interrupt'));
  serverStarted();
  const appServerRoot = captureStartedBody();
  const appServerChild = captureStartedBody();
  settledCapture(appServerRoot);
  settledCapture(appServerChild);
  push(hookObservedBody('session-start', { sessionHash: fakeHash('appsrv-session'), turnHash: null, agentHash: null }));
  push(hookObservedBody('user-prompt-submit', { sessionHash: fakeHash('appsrv-session'), turnHash: fakeHash('appsrv-turn'), agentHash: null }));
  push(hookObservedBody('subagent-start', { sessionHash: fakeHash('appsrv-child-session'), turnHash: fakeHash('appsrv-child-turn'), agentHash: fakeHash('appsrv-agent') }));
  push(authorityHashBody('appServerThreadId', 'root'));
  push(authorityHashBody('appServerTurnId', 'root'));
  push(authorityHashBody('appServerThreadId', 'child'));
  push(authorityHashBody('appServerTurnId', 'child'));
  const holdInterrupt = holdStartedBody();
  push(holdInterrupt);
  push(holdSettledBody(holdInterrupt.callNonce, 'signal-abort'));
  push(hookObservedBody('stop', { sessionHash: fakeHash('appsrv-session'), turnHash: fakeHash('appsrv-turn'), agentHash: null }));
  push(lifecycleObservedBody('appServerTurnInterrupt', {
    hostProcess: 'running',
    turnTerminalStatus: 'interrupted',
    toolCallOutcome: 'pending',
    handlerSettlement: 'signal-abort',
    transportState: 'open',
    hookEvent: 'stop',
    unknownReason: 'none',
  }));
  // Equality facts: the app-server chains qualify via the app-server
  // authorities, and the winning candidates join the Hook authorities (the
  // exact Host/Hook chain the release gate requires); non-winning
  // contradictions are recorded honestly.
  push(equalityFactBody('root', 'innerThreadId', 'appServerThreadId', true));
  push(equalityFactBody('root', 'innerTurnId', 'appServerTurnId', true));
  push(equalityFactBody('root', 'innerThreadId', 'hookSessionId', true));
  push(equalityFactBody('root', 'innerTurnId', 'hookTurnId', true));
  push(equalityFactBody('child', 'innerThreadId', 'appServerThreadId', true));
  push(equalityFactBody('child', 'innerTurnId', 'appServerTurnId', true));
  // The Task 4 join table: the Child thread authority is the Hook agent id
  // (true), while the child's inner thread_id contrasts with the Hook
  // session id (false) — both recorded honestly.
  push(equalityFactBody('child', 'innerThreadId', 'hookSessionId', false));
  push(equalityFactBody('child', 'innerThreadId', 'hookAgentId', true));
  push(equalityFactBody('child', 'innerThreadId', 'returnedChildHandle', true));
  push(equalityFactBody('child', 'innerTurnId', 'hookTurnId', true));
  // Phase: plugin-tool-timeout — held call stays pending; honest observation.
  push(phaseBody('plugin-tool-timeout'));
  serverStarted();
  push(holdStartedBody());
  push(lifecycleObservedBody('pluginToolTimeout', {
    hostProcess: 'running',
    turnTerminalStatus: 'pending',
    toolCallOutcome: 'pending',
    handlerSettlement: 'pending',
    transportState: 'open',
    hookEvent: 'not-observed',
    unknownReason: 'ceiling-reached',
  }));
  // Phase: direct-config-timeout — held call stays pending; honest observation.
  push(phaseBody('direct-config-timeout'));
  serverStarted();
  push(holdStartedBody());
  push(lifecycleObservedBody('directConfigToolTimeout', {
    hostProcess: 'running',
    turnTerminalStatus: 'pending',
    toolCallOutcome: 'pending',
    handlerSettlement: 'pending',
    transportState: 'open',
    hookEvent: 'not-observed',
    unknownReason: 'ceiling-reached',
  }));
  return events;
}

async function appendAll(runDirectory, nonce, bodies) {
  for (const body of bodies) await appendProbeEvent({ runDirectory, runNonce: nonce, event: body });
}

test('buildProbeMarketplace creates the complete installable probe marketplace in plugin-server mode', async () => {
  await withProbeRun('zcode-probe-fixture-', async (run) => {
    const output = join(run, 'marketplace');
    await mkdir(output, { mode: 0o700 });
    await buildProbeMarketplace({ output, server: serverModulePath, toolTimeoutSec: 30, mode: 'plugin-server' });
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
    const skill = await readFile(join(plugin, 'skills', 'context', 'SKILL.md'), 'utf8');
    assert.match(skill, /\$zcode-mcp-context-probe:context/);
    // The Skill must instruct the model to call the hold tool under its
    // committed server.mjs name, never a stale renamed tool.
    assert.match(skill, /mcp__zcode-mcp-context-probe__hold_for_lifecycle/);
    assert.doesNotMatch(skill, /hold_until_cancelled/);
    assert.ok((await readFile(join(plugin, 'skills', 'context', 'agents', 'openai.yaml'), 'utf8')).length > 0);
    // The fixture carries the six observation hooks and the hook observer.
    const hooks = JSON.parse(await readFile(join(plugin, 'hooks', 'hooks.json'), 'utf8'));
    assert.deepEqual(Object.keys(hooks.hooks).sort(), ['SessionEnd', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit']);
    for (const group of Object.values(hooks.hooks)) {
      assert.equal(group.length, 1);
      assert.equal(group[0].hooks[0].type, 'command');
      assert.match(group[0].hooks[0].command, /\$PLUGIN_ROOT\/hook-observer\.mjs/);
      // The hook timeout must exceed the observer's complete worst-case
      // budget (2s input read + 5s event-lock acquisition + node startup +
      // fsync margin): event-lock contention must never kill the observer
      // mid-append and silently drop hook evidence.
      assert.equal(group[0].hooks[0].timeout, 15);
    }
    const wrapper = await readFile(join(plugin, 'hook-observer.mjs'), 'utf8');
    assert.ok(wrapper.includes(pathToFileURL(hookObserverModulePath).href), 'the emitted wrapper must import the checked-in hook observer source by file URL');
  });
});

test('buildProbeMarketplace emits the separate short-timeout marketplace', async () => {
  await withProbeRun('zcode-probe-fixture-', async (run) => {
    const output = join(run, 'marketplace-2s');
    await mkdir(output, { mode: 0o700 });
    await buildProbeMarketplace({ output, server: serverModulePath, toolTimeoutSec: 2, mode: 'plugin-server' });
    const descriptor = JSON.parse(await readFile(join(output, 'plugins', 'zcode-mcp-context-probe', '.mcp.json'), 'utf8'));
    assert.equal(Object.values(descriptor.mcpServers)[0].tool_timeout_sec, 2);
  });
});

test('buildProbeMarketplace skill-only mode omits the MCP descriptor but keeps hooks and skills', async () => {
  await withProbeRun('zcode-probe-fixture-', async (run) => {
    const output = join(run, 'marketplace-skill-only');
    await mkdir(output, { mode: 0o700 });
    await buildProbeMarketplace({ output, server: serverModulePath, toolTimeoutSec: 2, mode: 'skill-only' });
    const plugin = join(output, 'plugins', 'zcode-mcp-context-probe');
    await assert.rejects(() => readFile(join(plugin, '.mcp.json'), 'utf8'), (error) => error.code === 'ENOENT');
    const hooks = JSON.parse(await readFile(join(plugin, 'hooks', 'hooks.json'), 'utf8'));
    assert.equal(Object.keys(hooks.hooks).length, 6);
    await readFile(join(plugin, 'hook-observer.mjs'), 'utf8');
    assert.match(await readFile(join(plugin, 'skills', 'context', 'SKILL.md'), 'utf8'), /\$zcode-mcp-context-probe:context/);
  });
});

test('buildProbeMarketplace rejects unsafe output directories, servers, and modes', async () => {
  await withProbeRun('zcode-probe-fixture-', async (run) => {
    await writeFile(join(run, 'stray.txt'), 'occupied');
    await assert.rejects(
      () => buildProbeMarketplace({ output: run, server: serverModulePath, toolTimeoutSec: 30, mode: 'plugin-server' }),
      /empty/i,
    );
    await rm(join(run, 'stray.txt'));
    const wrongMode = join(run, 'wrong-mode');
    await mkdir(wrongMode, { mode: 0o755 });
    if (posix) await assert.rejects(
      () => buildProbeMarketplace({ output: wrongMode, server: serverModulePath, toolTimeoutSec: 30, mode: 'plugin-server' }),
      /0700/,
    );
    const linked = join(run, 'linked');
    await symlink(run, linked);
    await assert.rejects(() => buildProbeMarketplace({ output: linked, server: serverModulePath, toolTimeoutSec: 30, mode: 'plugin-server' }));
    await assert.rejects(() => buildProbeMarketplace({ output: join(run, 'absent'), server: serverModulePath, toolTimeoutSec: 30, mode: 'plugin-server' }));
    await assert.rejects(
      () => buildProbeMarketplace({ output: join(run, 'fresh-a'), server: 'server.mjs', toolTimeoutSec: 30, mode: 'plugin-server' }),
      /absolute/i,
    );
    const linkedServer = join(run, 'server-link.mjs');
    await symlink(serverModulePath, linkedServer);
    await assert.rejects(
      () => buildProbeMarketplace({ output: join(run, 'fresh-b'), server: linkedServer, toolTimeoutSec: 30, mode: 'plugin-server' }),
    );
    await assert.rejects(
      () => buildProbeMarketplace({ output: join(run, 'fresh-c'), server: serverModulePath, toolTimeoutSec: 15, mode: 'plugin-server' }),
      /toolTimeoutSec/,
    );
    await assert.rejects(
      () => buildProbeMarketplace({ output: join(run, 'fresh-d'), server: serverModulePath, toolTimeoutSec: 30, mode: 'both' }),
      /mode/i,
    );
    await assert.rejects(
      () => buildProbeMarketplace({ output: join(run, 'fresh-e'), server: serverModulePath, toolTimeoutSec: 30 }),
      /mode/i,
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
    await assert.rejects(
      () => appendProbeEvent({ runDirectory: run, runNonce: nonce, event: phaseBody('workspace-b') }),
      /phase/i,
    );
  });
});

test('appendProbeEvent validates the new hook, authority, equality, and lifecycle vocabulary', async () => {
  await withProbeRun('zcode-probe-events-', async (run) => {
    const nonce = runNonce();
    // hook-observed: closed hook names, salted hash shapes, exact key set.
    await appendProbeEvent({ runDirectory: run, runNonce: nonce, event: hookObservedBody('session-start') });
    await appendProbeEvent({ runDirectory: run, runNonce: nonce, event: hookObservedBody('subagent-start', { turnHash: fakeHash('turn'), agentHash: fakeHash('agent') }) });
    await assert.rejects(() => appendProbeEvent({ runDirectory: run, runNonce: nonce, event: hookObservedBody('pre-tool-use') }), /hook/i);
    await assert.rejects(() => appendProbeEvent({ runDirectory: run, runNonce: nonce, event: { ...hookObservedBody('stop'), sessionHash: 'short' } }), /hash|64/i);
    await assert.rejects(() => appendProbeEvent({ runDirectory: run, runNonce: nonce, event: { ...hookObservedBody('stop'), cwd: '/srv' } }), /unknown field/i);
    // authority-hash: closed authorities and scopes.
    await appendProbeEvent({ runDirectory: run, runNonce: nonce, event: authorityHashBody('appServerThreadId', 'root') });
    await appendProbeEvent({ runDirectory: run, runNonce: nonce, event: authorityHashBody('returnedChildHandle', 'child') });
    await assert.rejects(() => appendProbeEvent({ runDirectory: run, runNonce: nonce, event: authorityHashBody('hookSessionId', 'root') }), /authority/i);
    await assert.rejects(() => appendProbeEvent({ runDirectory: run, runNonce: nonce, event: authorityHashBody('appServerThreadId', 'child-of') }), /scope/i);
    // equality-fact: closed candidates, authorities, scopes, boolean equal.
    await appendProbeEvent({ runDirectory: run, runNonce: nonce, event: equalityFactBody('root', 'innerThreadId', 'appServerThreadId', true) });
    await assert.rejects(() => appendProbeEvent({ runDirectory: run, runNonce: nonce, event: equalityFactBody('root', 'workspace', 'appServerThreadId', true) }), /candidate/i);
    await assert.rejects(() => appendProbeEvent({ runDirectory: run, runNonce: nonce, event: equalityFactBody('root', 'innerThreadId', 'appServerThreadId', 'yes') }), /equal/i);
    // lifecycle-observed: closed case and closed observation enums.
    await appendProbeEvent({ runDirectory: run, runNonce: nonce, event: lifecycleObservedBody('cliSigint') });
    await assert.rejects(() => appendProbeEvent({ runDirectory: run, runNonce: nonce, event: lifecycleObservedBody('cliSigkill', { hostProcess: 'killed' }) }), /hostProcess/i);
    await assert.rejects(() => appendProbeEvent({ runDirectory: run, runNonce: nonce, event: lifecycleObservedBody('cliSigkill', { unknownReason: 'because' }) }), /unknownReason/i);
    await assert.rejects(() => appendProbeEvent({ runDirectory: run, runNonce: nonce, event: lifecycleObservedBody('resumeTurn') }), /lifecycleCase|case/i);
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

test('reduceProbeEvents reduces the amended matrix to six true assertions and honest observations', () => {
  const result = reduceProbeEvents(qualifiedEventSequence(), { runNonce: HEX_NONCE });
  assert.deepEqual(Object.keys(result), ['context', 'lifecycle']);
  assert.deepEqual(Object.keys(result.context), ['assertions', 'authorityFields', 'equalityMatrix']);
  for (const value of Object.values(result.context.assertions)) assert.equal(value, true);
  assert.deepEqual(Object.keys(result.context.authorityFields), ['rootThread', 'childThread', 'turn']);
  assert.match(result.context.authorityFields.rootThread, /^_meta\./);
  assert.match(result.context.authorityFields.childThread, /^_meta\./);
  assert.match(result.context.authorityFields.turn, /^_meta\./);
  assert.deepEqual(Object.keys(result.context.equalityMatrix).sort(), expectedEqualityKeys());
  for (const value of Object.values(result.context.equalityMatrix)) assert.equal(typeof value, 'boolean');
  assert.equal(result.context.equalityMatrix['root:innerThreadId==appServerThreadId'], true);
  assert.equal(result.context.equalityMatrix['child:innerThreadId==appServerThreadId'], true);
  assert.equal(result.context.equalityMatrix['root:innerThreadId==hookSessionId'], true);
  assert.deepEqual(Object.keys(result.lifecycle).sort(), [...PROBE_LIFECYCLE_CASES].sort());
  assert.equal(result.lifecycle.appServerTurnInterrupt.handlerSettlement, 'signal-abort');
  assert.equal(result.lifecycle.appServerTurnInterrupt.turnTerminalStatus, 'interrupted');
  assert.equal(result.lifecycle.cliSigint.handlerSettlement, 'not-observed');
  assert.equal(result.lifecycle.cliSigkill.handlerSettlement, 'transport-close');
  assert.equal(result.lifecycle.pluginToolTimeout.handlerSettlement, 'pending');
  assert.equal(result.lifecycle.directConfigToolTimeout.unknownReason, 'ceiling-reached');
});

test('identityNamespaceQualified fails and authority fields empty when a chain cell is false', () => {
  const mutated = (mutator) => {
    const events = qualifiedEventSequence();
    mutator(events);
    return reduceProbeEvents(events, { runNonce: HEX_NONCE });
  };
  const broken = mutated((events) => {
    for (const record of events) {
      if (record.event.kind === 'equality-fact' && record.event.scope === 'child' && record.event.authority === 'appServerThreadId') record.event.equal = false;
    }
  });
  assert.equal(broken.context.assertions.identityNamespaceQualified, false);
  assert.equal(broken.context.authorityFields.childThread, null);
  assert.match(broken.context.authorityFields.rootThread, /^_meta\./);
  assert.equal(broken.context.assertions.laterTurnDistinct, true, 'distinctness alone must not requalify the namespace');
  const brokenTurn = mutated((events) => {
    for (const record of events) {
      if (record.event.kind === 'equality-fact' && record.event.scope === 'root' && record.event.authority === 'appServerTurnId') record.event.equal = false;
    }
  });
  assert.equal(brokenTurn.context.assertions.identityNamespaceQualified, false);
  const missing = mutated((events) => {
    const index = events.findIndex((record) => record.event.kind === 'equality-fact' && record.event.scope === 'root' && record.event.authority === 'appServerThreadId');
    events.splice(index, 1);
  });
  assert.equal(missing.context.assertions.identityNamespaceQualified, false);
  assert.equal(missing.context.equalityMatrix['root:innerThreadId==appServerThreadId'], false);
});

test('the namespace cannot qualify without the Host/Hook join facts', () => {
  // App-server facts alone are not enough: the required chain includes the
  // Host/Hook join for the winning candidates (SessionStart/SubagentStart
  // evidence paired into the hook columns), so a log whose hook evidence is
  // absent or malformed stays unqualified — the reducer must not set
  // identityNamespaceQualified from app-server facts alone.
  const withoutHooks = qualifiedEventSequence().filter((record) => {
    if (record.event.kind === 'hook-observed') return false;
    if (record.event.kind === 'equality-fact' && record.event.authority.startsWith('hook')) return false;
    return true;
  });
  const result = reduceProbeEvents(withoutHooks, { runNonce: HEX_NONCE });
  assert.equal(result.context.assertions.identityNamespaceQualified, false);
  // The app-server cells stay recorded and true — only the missing hook
  // join suppresses qualification; the observation path is untouched.
  assert.equal(result.context.equalityMatrix['root:innerThreadId==appServerThreadId'], true);
  assert.equal(result.context.equalityMatrix['child:innerThreadId==appServerThreadId'], true);
});

test('a hook-contradicted winning candidate cannot qualify the namespace', () => {
  // The winning thread candidate matches the app-server authority but
  // CONTRADICTS the corresponding Hook session id: the exact Host/Hook
  // authority chain is broken, so the namespace must not qualify — hook
  // facts merely existing is not enough, the winning hook cells must be
  // true (at least one fact and every fact true).
  const events = qualifiedEventSequence();
  for (const record of events) {
    if (record.event.kind === 'equality-fact' && record.event.scope === 'root'
      && record.event.candidate === 'innerThreadId' && record.event.authority === 'hookSessionId') {
      record.event.equal = false;
    }
  }
  const result = reduceProbeEvents(events, { runNonce: HEX_NONCE });
  assert.equal(result.context.assertions.identityNamespaceQualified, false);
  // The app-server cells stay true — the hook contradiction alone blocks it.
  assert.equal(result.context.equalityMatrix['root:innerThreadId==appServerThreadId'], true);
  assert.equal(result.context.equalityMatrix['root:innerThreadId==hookSessionId'], false);
});

test('the Child winner qualifies through its hookAgentId join', () => {
  // The Task 4 join table makes the Hook agent id the Child thread
  // authority: a child winner with a true hookAgentId cell qualifies even
  // when its hookSessionId cell contrasts — pre-fix, requiring the child
  // hookSessionId cell falsely blocked a fully successful app-server
  // capture, since the recorded matrix joins the child's innerThreadId to
  // hookAgentId, not hookSessionId.
  const result = reduceProbeEvents(qualifiedEventSequence(), { runNonce: HEX_NONCE });
  assert.equal(result.context.assertions.identityNamespaceQualified, true);
  assert.equal(result.context.equalityMatrix['child:innerThreadId==hookAgentId'], true);
  assert.equal(result.context.equalityMatrix['child:innerThreadId==hookSessionId'], false);
  assert.equal(result.context.equalityMatrix['child:innerTurnId==hookTurnId'], true);
});

test('a child winner with a contradicted hookAgentId cell cannot qualify', () => {
  // Mirror of the root rule: the child winner's own hook authority cell
  // (hookAgentId) must be true — a contradiction there blocks qualification.
  const events = qualifiedEventSequence();
  for (const record of events) {
    if (record.event.kind === 'equality-fact' && record.event.scope === 'child'
      && record.event.candidate === 'innerThreadId' && record.event.authority === 'hookAgentId') {
      record.event.equal = false;
    }
  }
  const result = reduceProbeEvents(events, { runNonce: HEX_NONCE });
  assert.equal(result.context.assertions.identityNamespaceQualified, false);
  assert.equal(result.context.equalityMatrix['child:innerThreadId==hookAgentId'], false);
});

test('identityFieldsVisible requires complete candidate hashes on every matrix capture', () => {
  const mutated = qualifiedEventSequence();
  let seenCaptures = 0;
  for (const record of mutated) {
    if (record.event.kind === 'capture-started') {
      seenCaptures += 1;
      if (seenCaptures === 6) record.event.envelopeThreadIdHash = null;
    }
  }
  const result = reduceProbeEvents(mutated, { runNonce: HEX_NONCE });
  assert.equal(result.context.assertions.identityFieldsVisible, false);
  assert.equal(result.context.assertions.metadataChangesAcrossTurns, true, 'the turn-change observation stands independently');
});

test('serverLoadedWithConfig requires the negative window, positive startup, and a positive tool call', () => {
  const mutated = (mutator) => {
    const events = qualifiedEventSequence();
    mutator(events);
    return reduceProbeEvents(events, { runNonce: HEX_NONCE });
  };
  assert.equal(mutated((events) => {
    for (const record of events.filter((entry) => entry.event.kind === 'server-started')) events.splice(events.indexOf(record), 1);
  }).context.assertions.serverLoadedWithConfig, false);
  assert.equal(mutated((events) => {
    events.unshift({ runNonce: HEX_NONCE, timestamp: new Date().toISOString(), event: serverStartedBody() });
  }).context.assertions.serverLoadedWithConfig, false);
  assert.equal(mutated((events) => {
    for (const record of events) {
      if (record.event.kind === 'phase-observed' && record.event.phase === 'negative-control') record.event.observed = false;
    }
  }).context.assertions.serverLoadedWithConfig, false);
  assert.equal(mutated((events) => {
    // Remove every positive capture (successful tool call) but keep holds.
    let index = 0;
    while (index < events.length) {
      if (events[index].event.kind === 'capture-started' || events[index].event.kind === 'capture-settled') { events.splice(index, 1); continue; }
      index += 1;
    }
  }).context.assertions.serverLoadedWithConfig, false);
  const canonical = qualifiedEventSequence({ eventsPath: join('/run-dir', 'events.jsonl'), lockPath: join('/run-dir', 'events.lock') });
  const positive = reduceProbeEvents(canonical, { runNonce: HEX_NONCE, runDirectory: '/run-dir' });
  assert.equal(positive.context.assertions.serverLoadedWithConfig, true);
});

test('serverLoadedWithConfig requires canonical observer paths for positive startup events', () => {
  const mutated = qualifiedEventSequence();
  for (const record of mutated) {
    if (record.event.kind === 'server-started') {
      record.event.eventsPath = join('/elsewhere', 'events.jsonl');
      record.event.lockPath = join('/elsewhere', 'events.lock');
    }
  }
  const result = reduceProbeEvents(mutated, { runNonce: HEX_NONCE, runDirectory: '/run-dir' });
  assert.equal(result.context.assertions.serverLoadedWithConfig, false);
});

test('the initial Child must be a thread distinct from the Root', () => {
  const events = qualifiedEventSequence();
  const captures = events.filter((record) => record.event.kind === 'capture-started');
  captures[1].event.threadHash = captures[0].event.threadHash;
  captures[2].event.threadHash = captures[0].event.threadHash;
  const result = reduceProbeEvents(events, { runNonce: HEX_NONCE });
  assert.equal(result.context.assertions.laterTurnDistinct, false);
});

test('the Root resume must be the same thread carrying a different turn', () => {
  const events = qualifiedEventSequence();
  const captures = events.filter((record) => record.event.kind === 'capture-started');
  captures[5].event.threadHash = captures[1].event.threadHash;
  const result = reduceProbeEvents(events, { runNonce: HEX_NONCE });
  assert.equal(result.context.assertions.metadataChangesAcrossTurns, false);
});

test('the driver correlates durable captures with the authoritative Root thread', () => {
  const records = qualifiedEventSequence();
  assert.doesNotThrow(() => assertAuthoritativeIdentityCorrelation(records));
  const captures = records.filter((record) => record.event.kind === 'capture-started').map((record) => record.event);
  const diverged = qualifiedEventSequence();
  const divergedCaptures = diverged.filter((record) => record.event.kind === 'capture-started').map((record) => record.event);
  divergedCaptures[5].threadHash = divergedCaptures[1].threadHash;
  assert.throws(() => assertAuthoritativeIdentityCorrelation(diverged), /Root thread identity/);
  const withoutResume = records.filter((record) => record.event.callNonce !== captures[5].callNonce);
  assert.throws(() => assertAuthoritativeIdentityCorrelation(withoutResume), /Root thread identity/);
});

test('reduceProbeResult writes result.json once with the closed context-plus-lifecycle shape', async () => {
  await withProbeRun('zcode-probe-result-', async (run) => {
    const nonce = runNonce();
    await appendAll(run, nonce, qualifiedEventSequence({ eventsPath: join(run, 'events.jsonl'), lockPath: join(run, 'events.lock') }).map((record) => record.event));
    const result = await reduceProbeResult({ runDirectory: run, runNonce: nonce });
    assert.deepEqual(Object.keys(result), ['context', 'lifecycle']);
    for (const value of Object.values(result.context.assertions)) assert.equal(value, true);
    const resultPath = join(run, 'result.json');
    if (posix) assert.equal((await lstat(resultPath)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(resultPath, 'utf8')), result);
    await assert.rejects(() => reduceProbeResult({ runDirectory: run, runNonce: nonce }), /exists|overwrite/i);
  });
});

test('reduceProbeResult refuses structurally incomplete logs without writing a result', async () => {
  await withProbeRun('zcode-probe-result-', async (run) => {
    const nonce = runNonce();
    // Missing the direct-config lifecycle observation: the characterization
    // never reached that case, so the census must refuse the record.
    const withoutDirect = qualifiedEventSequence({ eventsPath: join(run, 'events.jsonl'), lockPath: join(run, 'events.lock') })
      .filter((record) => record.event.kind !== 'lifecycle-observed' || record.event.lifecycleCase !== 'directConfigToolTimeout');
    await appendAll(run, nonce, withoutDirect.map((record) => record.event));
    await assert.rejects(() => reduceProbeResult({ runDirectory: run, runNonce: nonce }), /lifecycle|directConfigToolTimeout/i);
    const written = await readFile(join(run, 'result.json'), 'utf8').then(() => true, (error) => error.code === 'ENOENT' ? false : undefined);
    assert.equal(written, false);
  });
});

test('the final reducer rejects a log with extra hold invocations', async () => {
  await withProbeRun('zcode-probe-result-', async (run) => {
    const nonce = runNonce();
    const bodies = qualifiedEventSequence({ eventsPath: join(run, 'events.jsonl'), lockPath: join(run, 'events.lock') }).map((record) => record.event);
    bodies.push(holdStartedBody());
    await appendAll(run, nonce, bodies);
    await assert.rejects(() => reduceProbeResult({ runDirectory: run, runNonce: nonce }), /hold|census|incomplete/i);
  });
});

test('the final reducer rejects a log with extra matrix capture invocations', async () => {
  await withProbeRun('zcode-probe-result-', async (run) => {
    const nonce = runNonce();
    const bodies = qualifiedEventSequence({ eventsPath: join(run, 'events.jsonl'), lockPath: join(run, 'events.lock') });
    // An extra capture inside the scripted matrix phase violates the exact
    // census; late best-effort captures outside the matrix are tolerated.
    const matrixMarker = bodies.findIndex((record) => record.event.kind === 'phase-observed' && record.event.phase === 'cli-sigint');
    const extraCapture = captureStartedBody();
    bodies.splice(matrixMarker, 0,
      { runNonce: nonce, timestamp: new Date().toISOString(), event: extraCapture },
      { runNonce: nonce, timestamp: new Date().toISOString(), event: captureSettledBody(extraCapture.callNonce) });
    await appendAll(run, nonce, bodies.map((record) => record.event));
    await assert.rejects(() => reduceProbeResult({ runDirectory: run, runNonce: nonce }), /capture|census|incomplete/i);
  });
});

test('the final reducer requires durable positive server startup evidence', async () => {
  await withProbeRun('zcode-probe-server-start-', async (run) => {
    const nonce = runNonce();
    const withoutServerStarts = qualifiedEventSequence()
      .filter((record) => record.event.kind !== 'server-started');
    await appendAll(run, nonce, withoutServerStarts.map((record) => record.event));
    await assert.rejects(() => reduceProbeResult({ runDirectory: run, runNonce: nonce }), /server-started/);
  });
});

test('the final reducer rejects non-canonical observer startup paths', async () => {
  await withProbeRun('zcode-probe-paths-', async (run) => {
    const nonce = runNonce();
    const foreignPaths = qualifiedEventSequence({ eventsPath: join('/elsewhere', 'events.jsonl'), lockPath: join('/elsewhere', 'events.lock') });
    await appendAll(run, nonce, foreignPaths.map((record) => record.event));
    await assert.rejects(() => reduceProbeResult({ runDirectory: run, runNonce: nonce }), /canonical|server-started/);
  });
});

test('the final reducer rejects phases recorded out of canonical order', async () => {
  await withProbeRun('zcode-probe-order-', async (run) => {
    const nonce = runNonce();
    const events = qualifiedEventSequence({ eventsPath: join(run, 'events.jsonl'), lockPath: join(run, 'events.lock') });
    const markerIndex = events.findIndex((record) => record.event.kind === 'phase-observed' && record.event.phase === 'negative-control');
    const [marker] = events.splice(markerIndex, 1);
    const matrixMarkerIndex = events.findIndex((record) => record.event.kind === 'phase-observed' && record.event.phase === 'matrix');
    events.splice(matrixMarkerIndex + 1, 0, marker);
    await appendAll(run, nonce, events.map((record) => record.event));
    await assert.rejects(() => reduceProbeResult({ runDirectory: run, runNonce: nonce }), /qualification log/);
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
    const meta = {
      progressToken: 7,
      threadId: 'probe-envelope-thread',
      'x-codex-turn-metadata': { thread_id: 'probe-thread-root', turn_id: 'probe-turn-1', session_id: 'probe-session', workspace: '/probe/legacy-workspace' },
    };
    const capture = await client.request({ method: 'tools/call', params: { name: 'capture_context', arguments: {}, _meta: meta } }, CallToolResultSchema);
    assert.equal(capture.isError ?? false, false);
    const events = await readProbeEvents({ runDirectory: run, runNonce: nonce });
    const captureBodies = events.filter((record) => record.event.kind === 'capture-started').map((record) => record.event);
    assert.equal(captureBodies.length, 1);
    const captureBody = captureBodies[0];
    assert.equal(captureBody.identityComplete, true);
    assert.equal(await hashProbeValue(nonce, 'probe-thread-root'), captureBody.threadHash);
    assert.equal(await hashProbeValue(nonce, 'probe-turn-1'), captureBody.turnHash);
    assert.equal(await hashProbeValue(nonce, 'probe-envelope-thread'), captureBody.envelopeThreadIdHash);
    assert.equal(await hashProbeValue(nonce, 'probe-session'), captureBody.innerSessionIdHash);
    assert.equal(captureBody.workspaceHash, null);
    assert.match(captureBody.metaHash, /^[0-9a-f]{64}$/);
    assert.ok(events.some((record) => record.event.kind === 'capture-settled' && record.event.callNonce === captureBody.callNonce));
    const rawLog = await readFile(join(run, 'events.jsonl'), 'utf8');
    for (const raw of ['probe-thread-root', 'probe-turn-1', 'probe-session', 'probe-envelope-thread', '/probe/legacy-workspace']) {
      assert.equal(rawLog.includes(raw), false, `raw identity leaked: ${raw}`);
    }
    await client.close();
  });
});

test('capture_context fails closed when the trusted turn metadata is incomplete', async () => {
  await withProbeRun('zcode-probe-server-', async (run) => {
    const nonce = runNonce();
    const { client } = await connectProbeClient(run, nonce);
    const missingTurn = await client.request({
      method: 'tools/call',
      params: { name: 'capture_context', arguments: {}, _meta: { 'x-codex-turn-metadata': { thread_id: 'probe-thread-only' } } },
    }, CallToolResultSchema);
    assert.equal(missingTurn.isError, true);
    const events = await readProbeEvents({ runDirectory: run, runNonce: nonce });
    assert.equal(events.filter((record) => record.event.kind === 'capture-started').length, 0, 'an incomplete identity must not persist as a capture');
    await client.close();
  });
});

test('the probe server settles held lifecycle calls when the transport closes', async () => {
  await withProbeRun('zcode-probe-server-', async (run) => {
    const nonce = runNonce();
    const { client } = await connectProbeClient(run, nonce);
    const heldCall = client.request({ method: 'tools/call', params: { name: 'hold_for_lifecycle', arguments: {} } }, CallToolResultSchema).then(
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

test('pending holds settle durably as transport-close on forced disconnect', async () => {
  await withProbeRun('zcode-probe-server-', async (run) => {
    const nonce = runNonce();
    const server = createProbeServer({ observer: { runDirectory: run, runNonce: nonce } });
    const client = new Client({ name: 'probe-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const heldCall = client.request({ method: 'tools/call', params: { name: 'hold_for_lifecycle', arguments: {} } }, CallToolResultSchema).then(
      () => 'returned',
      () => 'abandoned',
    );
    await waitUntilHoldStarted(run, nonce);
    assert.equal(typeof server.probeDisconnect?.settlePendingHoldsOnDisconnect, 'function', 'the server must expose the forced-disconnect settlement seam');
    server.probeDisconnect.settlePendingHoldsOnDisconnect();
    const settled = await waitUntilHoldSettled(run, nonce);
    assert.equal(settled.settlement, 'transport-close');
    assert.equal(await heldCall, 'returned', 'the forced disconnect resolves the held handler');
    await client.close();
  });
});

test('the probe server settles held calls when the client dies abruptly over real stdio', { skip: !posix }, async () => {
  await withProbeRun('zcode-probe-stdio-', async (run) => {
    const nonce = runNonce();
    const helper = spawn(process.execPath, ['-e', STDIO_DISCONNECT_HELPER], {
      stdio: 'ignore',
      env: {
        ...process.env,
        ZCODE_MCP_PROBE_EVENTS: join(run, 'events.jsonl'),
        ZCODE_MCP_PROBE_LOCK: join(run, 'events.lock'),
        ZCODE_MCP_PROBE_NONCE: nonce,
      },
    });
    await new Promise((resolve) => helper.on('close', resolve));
    const settled = await waitUntilHoldSettled(run, nonce, 12_000);
    assert.equal(settled.settlement, 'transport-close', 'an abruptly disconnected client must still produce a durable settlement');
  });
});

const STDIO_DISCONNECT_HELPER = `
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const transport = new StdioClientTransport({
  command: ${JSON.stringify(process.execPath)},
  args: [${JSON.stringify(serverModulePath)}],
  env: { ...process.env },
});
const client = new Client({ name: 'probe-stdio-disconnect', version: '0.0.0' });
await client.connect(transport);
client.request({ method: 'tools/call', params: { name: 'hold_for_lifecycle', arguments: {} } }, {}).catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 800));
process.kill(process.pid, 'SIGKILL');
`;

async function waitUntilHoldStarted(runDirectory, nonce, deadlineMs = 10_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const started = (await readProbeEvents({ runDirectory, runNonce: nonce }))
      .map((record) => record.event)
      .find((body) => body.kind === 'hold-started');
    if (started) return started;
    if (Date.now() > deadline) throw new Error('hold-started never became durable');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitUntilHoldSettled(runDirectory, nonce, deadlineMs = 10_000) {
  const deadline = Date.now() + deadlineMs;
  const started = await waitUntilHoldStarted(runDirectory, nonce, deadlineMs);
  for (;;) {
    const settled = (await readProbeEvents({ runDirectory, runNonce: nonce }))
      .map((record) => record.event)
      .find((body) => body.kind === 'hold-settled' && body.callNonce === started.callNonce);
    if (settled) return settled;
    if (Date.now() > deadline) throw new Error('hold settlement never became durable');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Bounds a promise with a descriptive rejection instead of an indefinite hang. */
async function withDeadline(promise, deadlineMs, failureMessage) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(failureMessage)), deadlineMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('a disconnect during the hold-started append still settles the registered hold', async () => {
  await withProbeRun('zcode-probe-server-', async (run) => {
    const nonce = runNonce();
    let releaseStartAppend;
    const startAppendGate = new Promise((resolve) => { releaseStartAppend = resolve; });
    let enterStartAppend;
    const startAppendEntered = new Promise((resolve) => { enterStartAppend = resolve; });
    let appendCallCount = 0;
    const appendImpl = async (appendOptions) => {
      appendCallCount += 1;
      if (appendCallCount === 1) {
        enterStartAppend();
        await startAppendGate;
      }
      return appendProbeEvent(appendOptions);
    };
    const server = createProbeServer({ observer: { runDirectory: run, runNonce: nonce }, appendImpl });
    const client = new Client({ name: 'probe-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const heldOutcome = client.request({ method: 'tools/call', params: { name: 'hold_for_lifecycle', arguments: {} } }, CallToolResultSchema)
        .then(() => 'resolved', () => 'rejected');
      await withDeadline(startAppendEntered, 5_000, 'the hold-started append never began');
      server.probeDisconnect.settlePendingHoldsOnDisconnect();
      releaseStartAppend();
      const settled = await waitUntilHoldSettled(run, nonce, 10_000);
      assert.equal(settled.settlement, 'transport-close', 'the in-flight hold must settle as a durable transport close');
      const outcome = await Promise.race([
        heldOutcome,
        new Promise((resolve) => setTimeout(() => resolve('timed out'), 5_000)),
      ]);
      assert.equal(outcome, 'resolved', 'the held tool call must resolve after the delayed settlement');
    } finally {
      await client.close().catch(() => {});
    }
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
        _meta: { 'x-codex-turn-metadata': { thread_id: 't', turn_id: 'u' } },
      },
    }, CallToolResultSchema);
    assert.equal(identityArgument.isError, true);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['capture_context', 'hold_for_lifecycle', 'read_assertions']);
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
    assert.deepEqual(Object.keys(structured), ['context', 'lifecycle']);
    assert.deepEqual(Object.keys(structured.context), ['assertions', 'authorityFields', 'equalityMatrix']);
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
    process.env.ZCODE_MCP_PROBE_EVENTS = join(tmpdir(), 'events.jsonl');
    process.env.ZCODE_MCP_PROBE_LOCK = join(tmpdir(), 'events.lock');
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

test('disconnect settlement grace is at least the disposal exit grace', () => {
  assert.ok(
    DISCONNECT_EXIT_GRACE_MS >= SERVER_EXIT_GRACE_MS,
    `disconnect grace ${DISCONNECT_EXIT_GRACE_MS} must be at least the disposal grace ${SERVER_EXIT_GRACE_MS}`,
  );
});

test('process identity resolution is PATH-independent and validated', () => {
  const executable = resolveProcessInspectionExecutable();
  if (executable === null) return;
  assert.ok(isAbsolute(executable), `${executable} must be an absolute path`);
  const stats = statSync(executable);
  assert.ok(stats.isFile() && (stats.mode & 0o111) !== 0, `${executable} must be a regular executable file`);
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

test('the negative-control transcript must show the tool-unavailable shape', () => {
  const frameAccount = (entries, excerpts = [], nestedEntries = []) => ({
    malformed: 0,
    frameTypes: new Map(entries),
    nestedItemTypes: new Map(nestedEntries),
    excerpts,
  });
  // The recorded Blocker-1 shape: the model attempted the probe tool and the
  // Host reported it as an error frame naming the tool.
  assert.doesNotThrow(() => assertToolUnavailableTranscript(
    frameAccount(
      [['thread.started', 1], ['error', 2]],
      [{ frameType: 'error', nestedItemType: null, itemStatus: null, excerpt: '{"type":"error","message":"unknown tool: capture_context"}' }],
    ),
    'phase-negative-control',
  ));
  // The recorded 0.154.0 shape: the model reports the tool unavailable in
  // its agent message, which names the tool and states the unavailability.
  assert.doesNotThrow(() => assertToolUnavailableTranscript(
    frameAccount(
      [['thread.started', 1], ['error', 5]],
      [{ frameType: 'item.completed', nestedItemType: 'agent_message', itemStatus: null, excerpt: '{"type":"item.completed","item":{"type":"agent_message","text":"I found and read the context skill, but mcp__zcode-mcp-context-probe__capture_context is unavailable in this session."}}' }],
    ),
    'phase-negative-control',
  ));
  // A failed non-MCP item naming the probe tool is a genuine failure surface.
  assert.doesNotThrow(() => assertToolUnavailableTranscript(
    frameAccount(
      [['thread.started', 1]],
      [{ frameType: 'item.completed', nestedItemType: 'exec_command', itemStatus: 'failed', excerpt: '{"type":"item.completed","item":{"type":"exec_command","status":"failed","text":"capture_context unavailable"}}' }],
    ),
    'phase-negative-control',
  ));
  // Without any error frame the model never attempted the tool, so the
  // transcript proves nothing about the configuration being skipped.
  assert.throws(
    () => assertToolUnavailableTranscript(frameAccount([['thread.started', 1]]), 'phase-negative-control'),
    /tool-unavailable|PROBE_NEGATIVE_CONTROL_SHAPE/,
  );
  // A transient model/network error that never references the probe tool or
  // server proves nothing about --ignore-user-config hiding the plugin.
  assert.throws(
    () => assertToolUnavailableTranscript(
      frameAccount(
        [['thread.started', 1], ['error', 1]],
        [{ frameType: 'error', nestedItemType: null, itemStatus: null, excerpt: '{"type":"error","message":"model overloaded, retry later"}' }],
      ),
      'phase-negative-control',
    ),
    /tool-unavailable|PROBE_NEGATIVE_CONTROL_SHAPE/,
  );
  // A successful/neutral item mentioning the probe tool must not satisfy the
  // gate on its own — only a genuine failure surface counts.
  assert.throws(
    () => assertToolUnavailableTranscript(
      frameAccount(
        [['thread.started', 1]],
        [{ frameType: 'item.completed', nestedItemType: 'reasoning', itemStatus: 'completed', excerpt: '{"type":"item.completed","item":{"type":"reasoning","status":"completed","text":"capture_context should exist"}}' }],
      ),
      'phase-negative-control',
    ),
    /tool-unavailable|PROBE_NEGATIVE_CONTROL_SHAPE/,
  );
  // An agent message that merely mentions the tool without stating its
  // unavailability is not a failure surface either.
  assert.throws(
    () => assertToolUnavailableTranscript(
      frameAccount(
        [['thread.started', 1]],
        [{ frameType: 'item.completed', nestedItemType: 'agent_message', itemStatus: null, excerpt: '{"type":"item.completed","item":{"type":"agent_message","text":"capture_context is a useful tool."}}' }],
      ),
      'phase-negative-control',
    ),
    /tool-unavailable|PROBE_NEGATIVE_CONTROL_SHAPE/,
  );
});

test('failed-attempt engagement with a matching excerpt and zero successful calls is accepted', () => {
  const frameAccount = (entries, excerpts = [], nestedEntries = []) => ({
    malformed: 0,
    frameTypes: new Map(entries),
    nestedItemTypes: new Map(nestedEntries),
    excerpts,
  });
  const failedAttempt = (index) => ({
    frameType: 'item.completed',
    nestedItemType: 'mcp_tool_call',
    itemStatus: 'failed',
    excerpt: `{"type":"item.completed","item":{"type":"mcp_tool_call","status":"failed","tool":"mcp__zcode-mcp-context-probe__capture_context","attempt":${index}}}`,
  });
  // The bimodal shape the negative-control flake exposed: four
  // attempted-and-errored mcp_tool_call items plus one matching failure
  // excerpt, zero successful calls — attempted, errored, never executed.
  // The durable window (checked separately by the caller) remains the hard
  // proof that the server never loaded.
  assert.doesNotThrow(() => assertToolUnavailableTranscript(
    frameAccount(
      [['thread.started', 1], ['item.completed', 4]],
      [
        failedAttempt(1),
        failedAttempt(2),
        failedAttempt(3),
        failedAttempt(4),
        { frameType: 'error', nestedItemType: null, itemStatus: null, excerpt: '{"type":"error","message":"unknown tool: mcp__zcode-mcp-context-probe__capture_context"}' },
      ],
      [['mcp_tool_call', 4]],
    ),
    'phase-negative-control',
  ));
  // The failed call items' own excerpts satisfy the matching-failure-excerpt
  // requirement even without a separate error frame.
  assert.doesNotThrow(() => assertToolUnavailableTranscript(
    frameAccount([['thread.started', 1]], [failedAttempt(1)], [['mcp_tool_call', 1]]),
    'phase-negative-control',
  ));
});

test('successful or unclassified mcp_tool_call evidence is never tool-unavailable proof', () => {
  const frameAccount = (entries, excerpts = [], nestedEntries = []) => ({
    malformed: 0,
    frameTypes: new Map(entries),
    nestedItemTypes: new Map(nestedEntries),
    excerpts,
  });
  // A completed call item is real server interaction — never unavailability
  // proof, even beside a matching failure excerpt.
  assert.throws(
    () => assertToolUnavailableTranscript(
      frameAccount(
        [['thread.started', 1]],
        [
          { frameType: 'item.completed', nestedItemType: 'mcp_tool_call', itemStatus: 'completed', excerpt: '{"type":"item.completed","item":{"type":"mcp_tool_call","status":"completed","tool":"capture_context"}}' },
          { frameType: 'error', nestedItemType: null, itemStatus: null, excerpt: '{"type":"error","message":"unknown tool: capture_context"}' },
        ],
        [['mcp_tool_call', 1]],
      ),
      'phase-negative-control',
    ),
    /tool-unavailable|PROBE_NEGATIVE_CONTROL_SHAPE/,
  );
  // A call item whose status is neither failed/error nor completed/ok is
  // unclassified: no failed-attempt engagement, no other evidence.
  assert.throws(
    () => assertToolUnavailableTranscript(
      frameAccount(
        [['thread.started', 1]],
        [{ frameType: 'item.started', nestedItemType: 'mcp_tool_call', itemStatus: 'in_progress', excerpt: '{"type":"item.started","item":{"type":"mcp_tool_call","status":"in_progress","tool":"capture_context"}}' }],
        [['mcp_tool_call', 1]],
      ),
      'phase-negative-control',
    ),
    /tool-unavailable|PROBE_NEGATIVE_CONTROL_SHAPE/,
  );
  // A bare call-item count with no excerpted engagement is zero engagement.
  assert.throws(
    () => assertToolUnavailableTranscript(
      frameAccount([['thread.started', 1]], [], [['mcp_tool_call', 1]]),
      'phase-negative-control',
    ),
    /tool-unavailable|PROBE_NEGATIVE_CONTROL_SHAPE/,
  );
});

test('the resume Host must re-emit exactly one thread.started matching the Root id', () => {
  const account = (threadIds) => ({ malformed: 0, frameTypes: new Map(), threadIds, excerpts: [] });
  assert.doesNotThrow(() => assertResumeThreadIdentity(account(['root-thread-id']), 'root-thread-id'));
  assert.throws(() => assertResumeThreadIdentity(account([]), 'root-thread-id'), /thread\.started/);
  assert.throws(() => assertResumeThreadIdentity(account(['root-thread-id', 'root-thread-id']), 'root-thread-id'), /thread\.started/);
  assert.throws(() => assertResumeThreadIdentity(account(['other-thread-id']), 'root-thread-id'), /Root thread id/);
  assert.throws(() => assertResumeThreadIdentity(account(['root-thread-id', 'other-thread-id']), 'root-thread-id'), /thread\.started/);
});

test('candidate strategies follow the closed characterization table', () => {
  const baseCase = () => lifecycleObservedBody('cliSigint');
  // Row 1 only: an explicit abort settlement proves direct abort; without a
  // Stop hook, row 2 does not join.
  assert.deepEqual(deriveCandidateStrategies({
    appServerTurnInterrupt: { handlerSettlement: 'signal-abort', turnTerminalStatus: 'interrupted', hookEvent: 'not-observed', hostProcess: 'running', toolCallOutcome: 'pending', transportState: 'open', unknownReason: 'none' },
    cliSigint: baseCase(), cliSigkill: baseCase(), pluginToolTimeout: baseCase(), directConfigToolTimeout: baseCase(),
  }).explicitInterrupt, ['direct-abort']);
  // Rows 1+2: matching rows are independently additive, so a case matching
  // several rows retains every matching candidate for Task 6.
  assert.deepEqual(deriveCandidateStrategies({
    appServerTurnInterrupt: { handlerSettlement: 'signal-abort', turnTerminalStatus: 'interrupted', hookEvent: 'stop', hostProcess: 'running', toolCallOutcome: 'pending', transportState: 'open', unknownReason: 'none' },
    cliSigint: baseCase(), cliSigkill: baseCase(), pluginToolTimeout: baseCase(), directConfigToolTimeout: baseCase(),
  }).explicitInterrupt, ['direct-abort', 'durable-stop-intent', 'release-blocked']);
  // Row 2: an interrupted turn plus a Stop hook keeps both durable candidates.
  assert.deepEqual(deriveCandidateStrategies({
    appServerTurnInterrupt: { handlerSettlement: 'not-observed', turnTerminalStatus: 'interrupted', hookEvent: 'stop', hostProcess: 'running', toolCallOutcome: 'pending', transportState: 'open', unknownReason: 'host-omitted-event' },
    cliSigint: baseCase(), cliSigkill: baseCase(), pluginToolTimeout: baseCase(), directConfigToolTimeout: baseCase(),
  }).explicitInterrupt, ['durable-stop-intent', 'release-blocked']);
  // Row 3: neither abort nor Stop hook observed blocks the release branch.
  assert.deepEqual(deriveCandidateStrategies({
    appServerTurnInterrupt: { handlerSettlement: 'not-observed', turnTerminalStatus: 'pending', hookEvent: 'not-observed', hostProcess: 'running', toolCallOutcome: 'pending', transportState: 'open', unknownReason: 'ceiling-reached' },
    cliSigint: baseCase(), cliSigkill: baseCase(), pluginToolTimeout: baseCase(), directConfigToolTimeout: baseCase(),
  }).explicitInterrupt, ['release-blocked']);
  // Host loss: any tested held-call case's exited-* host is loss evidence —
  // not only the SIGKILL case. The recorded cliSigint exited-clean and both
  // timeout phases exited-clean also qualify.
  assert.deepEqual(deriveCandidateStrategies({
    appServerTurnInterrupt: baseCase(),
    cliSigint: { ...lifecycleObservedBody('cliSigint'), hostProcess: 'exited-clean' },
    cliSigkill: baseCase(), pluginToolTimeout: baseCase(), directConfigToolTimeout: baseCase(),
  }).hostLoss, ['durable-supervision', 'release-blocked']);
  // Host loss: the SIGKILL case alone still proves both candidates.
  assert.deepEqual(deriveCandidateStrategies({
    appServerTurnInterrupt: baseCase(), cliSigint: baseCase(),
    cliSigkill: { hostProcess: 'exited-signal', turnTerminalStatus: 'not-observed', toolCallOutcome: 'pending', handlerSettlement: 'transport-close', transportState: 'stdin-eof', hookEvent: 'not-observed', unknownReason: 'none' },
    pluginToolTimeout: baseCase(), directConfigToolTimeout: baseCase(),
  }).hostLoss, ['durable-supervision', 'release-blocked']);
  // Host loss: when no tested case observed any host exit, no supervision
  // evidence exists and the dimension falls back to release-blocked alone.
  assert.deepEqual(deriveCandidateStrategies({
    appServerTurnInterrupt: baseCase(), cliSigint: baseCase(), cliSigkill: baseCase(),
    pluginToolTimeout: baseCase(), directConfigToolTimeout: baseCase(),
  }).hostLoss, ['release-blocked']);
  // Host timeout: abort plus timed-out proves host-abort on that case only.
  assert.deepEqual(deriveCandidateStrategies({
    appServerTurnInterrupt: baseCase(), cliSigint: baseCase(), cliSigkill: baseCase(),
    pluginToolTimeout: { hostProcess: 'running', turnTerminalStatus: 'pending', toolCallOutcome: 'timed-out', handlerSettlement: 'signal-abort', transportState: 'open', hookEvent: 'not-observed', unknownReason: 'none' },
    directConfigToolTimeout: baseCase(),
  }).hostTimeout, ['host-abort', 'server-deadline', 'durable-supervision', 'release-blocked']);
  // Host timeout: no abort on either case keeps only the non-abort candidates.
  assert.deepEqual(deriveCandidateStrategies({
    appServerTurnInterrupt: baseCase(), cliSigint: baseCase(), cliSigkill: baseCase(),
    pluginToolTimeout: { hostProcess: 'running', turnTerminalStatus: 'pending', toolCallOutcome: 'pending', handlerSettlement: 'pending', transportState: 'open', hookEvent: 'not-observed', unknownReason: 'ceiling-reached' },
    directConfigToolTimeout: { hostProcess: 'running', turnTerminalStatus: 'pending', toolCallOutcome: 'pending', handlerSettlement: 'pending', transportState: 'open', hookEvent: 'not-observed', unknownReason: 'ceiling-reached' },
  }).hostTimeout, ['server-deadline', 'durable-supervision', 'release-blocked']);
});

test('the committed lifecycle record stays derivable from its recorded cases', async () => {
  const record = JSON.parse(await readFile(new URL('../qualification/mcp-lifecycle.json', import.meta.url), 'utf8'));
  assert.deepEqual(deriveCandidateStrategies(record.cases), record.candidateStrategies);
});

test('the app-server request-shape builders pin the exact JSON-RPC payloads', () => {
  assert.deepEqual(appServerInitializeParams(), {
    clientInfo: { name: 'zcode-mcp-context-probe', title: 'ZCode MCP Context Probe', version: '0.1.0' },
    capabilities: null,
  });
  assert.deepEqual(appServerThreadStartParams('/workspace-a'), { cwd: '/workspace-a' });
  assert.deepEqual(appServerTurnStartParams('thread-1', 'hold prompt'), {
    threadId: 'thread-1',
    input: [{ type: 'text', text: 'hold prompt' }],
  });
  // The phase inputs flow verbatim: the driver passes the exported prompt
  // constants as the turn input text.
  assert.deepEqual(appServerTurnStartParams('thread-1', APP_SERVER_CAPTURE_PROMPT), {
    threadId: 'thread-1',
    input: [{ type: 'text', text: APP_SERVER_CAPTURE_PROMPT }],
  });
  assert.deepEqual(appServerTurnStartParams('thread-1', HOLD_PROMPT), {
    threadId: 'thread-1',
    input: [{ type: 'text', text: HOLD_PROMPT }],
  });
  // The explicit user-cancellation entry point carries exactly the
  // interrupted thread and turn ids.
  assert.deepEqual(appServerTurnInterruptParams('thread-1', 'turn-9'), { threadId: 'thread-1', turnId: 'turn-9' });
});

test('the app-server turn inputs carry the exec-compliance prompts', () => {
  // The capture turn must require the Skill, exactly one Root capture,
  // exactly one spawned Child (the matrix prompt's mechanism) with one
  // capture, a wait, and no other MCP tools — the compliance voice that
  // achieved exec-path compliance. Identity-free: no thread or turn values.
  assert.equal(APP_SERVER_CAPTURE_PROMPT, 'Use $zcode-mcp-context-probe:context. Call capture_context exactly once in Root. Spawn exactly one Child, have it call capture_context once, and wait for it. Do not call any other MCP tool.');
  // The held turn must require the Skill, exactly one held call, and
  // nothing else — the shared exec hold voice, unchanged.
  assert.equal(HOLD_PROMPT, 'Use $zcode-mcp-context-probe:context and call hold_for_lifecycle exactly once. Wait for that tool and do nothing else.');
});

test('the turn/completed notification mapping reduces to the closed terminal statuses', () => {
  const completedFrames = (status, threadId = 'thread-1', turnId = 'turn-9') => ([
    { method: 'turn/started', params: { threadId, turn: { id: turnId } } },
    { method: 'turn/completed', params: { threadId, turn: { id: turnId, status } } },
  ]);
  assert.equal(appServerTurnStatusFromNotifications(completedFrames('completed'), 'thread-1', 'turn-9'), 'completed');
  assert.equal(appServerTurnStatusFromNotifications(completedFrames('failed'), 'thread-1', 'turn-9'), 'failed');
  assert.equal(appServerTurnStatusFromNotifications(completedFrames('interrupted'), 'thread-1', 'turn-9'), 'interrupted');
  // A terminal frame outside the closed status vocabulary is unknown, never guessed.
  assert.equal(appServerTurnStatusFromNotifications(completedFrames('in-progress'), 'thread-1', 'turn-9'), 'unknown');
  // No matching terminal frame yet: null — the value the driver polls on
  // until the ceiling turns it into the null-at-ceiling observation.
  assert.equal(appServerTurnStatusFromNotifications([], 'thread-1', 'turn-9'), null);
  assert.equal(appServerTurnStatusFromNotifications(completedFrames('completed', 'other-thread'), 'thread-1', 'turn-9'), null);
  assert.equal(appServerTurnStatusFromNotifications(completedFrames('completed', 'thread-1', 'other-turn'), 'thread-1', 'turn-9'), null);
  assert.equal(appServerTurnStatusFromNotifications([{ method: 'turn/completed', params: { threadId: 'thread-1' } }], 'thread-1', 'turn-9'), null);
});

test('the appServerTurnInterrupt observation assembles from the recorded event facts', () => {
  // The recorded 0.154.0 shape: the app-server stayed alive, the held turn
  // completed, no held call ever became durable, and no hook fired — the
  // committed record's exact observation.
  assert.deepEqual(assembleAppServerTurnInterruptObservation({
    appServerAlive: true, turnStatus: 'completed', heldCallObserved: false, interruptSettlement: null, hookEvent: 'not-observed',
  }), {
    hostProcess: 'running',
    turnTerminalStatus: 'completed',
    toolCallOutcome: 'not-observed',
    handlerSettlement: 'not-observed',
    transportState: 'open',
    hookEvent: 'not-observed',
    unknownReason: 'host-omitted-event',
  });
  // Contrasting shape: the interrupt landed on a live held call whose
  // handler settled as a durable signal abort — interrupted turn, pending
  // outcome, the settlement recorded, no unknown reason left.
  assert.deepEqual(assembleAppServerTurnInterruptObservation({
    appServerAlive: true, turnStatus: 'interrupted', heldCallObserved: true, interruptSettlement: 'signal-abort', hookEvent: 'stop',
  }), {
    hostProcess: 'running',
    turnTerminalStatus: 'interrupted',
    toolCallOutcome: 'pending',
    handlerSettlement: 'signal-abort',
    transportState: 'open',
    hookEvent: 'stop',
    unknownReason: 'none',
  });
  // Null at the ceiling: the turn never reached a terminal status, so the
  // turn status is pending and the ceiling reason is recorded.
  assert.deepEqual(assembleAppServerTurnInterruptObservation({
    appServerAlive: true, turnStatus: null, heldCallObserved: true, interruptSettlement: null, hookEvent: 'not-observed',
  }), {
    hostProcess: 'running',
    turnTerminalStatus: 'pending',
    toolCallOutcome: 'pending',
    handlerSettlement: 'not-observed',
    transportState: 'open',
    hookEvent: 'not-observed',
    unknownReason: 'ceiling-reached',
  });
  // A dead app-server session records unknown/server-exited honestly.
  assert.deepEqual(assembleAppServerTurnInterruptObservation({
    appServerAlive: false, turnStatus: 'failed', heldCallObserved: true, interruptSettlement: null, hookEvent: 'session-end',
  }), {
    hostProcess: 'unknown',
    turnTerminalStatus: 'failed',
    toolCallOutcome: 'pending',
    handlerSettlement: 'not-observed',
    transportState: 'server-exited',
    hookEvent: 'session-end',
    unknownReason: 'host-omitted-event',
  });
  // A terminal frame outside the closed vocabulary stays unknown.
  assert.equal(assembleAppServerTurnInterruptObservation({
    appServerAlive: true, turnStatus: 'unknown', heldCallObserved: false, interruptSettlement: null, hookEvent: 'not-observed',
  }).turnTerminalStatus, 'unknown');
});

test('appendMcpServerConfig appends the direct stanza without erasing the plugin registration', () => {
  const stanza = ['[mcp_servers.zcode-mcp-context-probe]', 'command = "node"', 'tool_timeout_sec = 2', ''].join('\n');
  // The just-installed skill-only plugin's registration (features, plugin,
  // hooks) must survive verbatim; the stanza joins after one blank line.
  const pluginConfig = '[features]\nhooks = true\n\n[plugins.zcode-mcp-context-probe]\nsource = "local"\n';
  const merged = appendMcpServerConfig(pluginConfig, stanza);
  assert.ok(merged.startsWith(pluginConfig), 'the existing plugin registration must survive verbatim');
  assert.ok(merged.includes('source = "local"\n\n[mcp_servers.zcode-mcp-context-probe]\n'), 'the stanza must start on its own line after one blank line');
  assert.equal(merged.match(/\[mcp_servers\.zcode-mcp-context-probe\]/g).length, 1, 'the server key must never be duplicated');
  // Existing content without a trailing newline still merges without gluing.
  const glued = appendMcpServerConfig('[features]\nhooks = true', stanza);
  assert.equal(glued, '[features]\nhooks = true\n\n[mcp_servers.zcode-mcp-context-probe]\ncommand = "node"\ntool_timeout_sec = 2\n');
  // An existing server table wins: the TOML is returned unchanged.
  const existing = '[mcp_servers.zcode-mcp-context-probe]\ncommand = "node"\n';
  assert.equal(appendMcpServerConfig(existing, stanza), existing);
  // An empty config carries exactly the stanza.
  assert.equal(appendMcpServerConfig('', stanza), stanza);
});

test('ensureHooksFeatureFlag patches the features table and fails closed on unsafe shapes', () => {
  // No features table: appended after the existing registration.
  assert.equal(
    ensureHooksFeatureFlag('[hooks.state."a"]\ntrusted_hash = "h"\n'),
    '[hooks.state."a"]\ntrusted_hash = "h"\n\n[features]\nhooks = true\n',
  );
  // Features table without hooks: the key is added inside the table.
  assert.equal(ensureHooksFeatureFlag('[features]\nother = 1\n'), '[features]\nhooks = true\nother = 1\n');
  // hooks = false: flipped to true, other keys preserved.
  assert.equal(ensureHooksFeatureFlag('[features]\nother = 1\nhooks = false\n'), '[features]\nother = 1\nhooks = true\n');
  // hooks = true: no-op.
  const enabled = '[features]\nhooks = true\nother = 1\n';
  assert.equal(ensureHooksFeatureFlag(enabled), enabled);
  // Patch only within the features table, never later tables.
  assert.equal(
    ensureHooksFeatureFlag('[features]\nhooks = false\n\n[mcp_servers.x]\ncommand = "node"\n'),
    '[features]\nhooks = true\n\n[mcp_servers.x]\ncommand = "node"\n',
  );
  // Unrecognized features-table shapes fail closed: the qualification must
  // never silently run with the required Hook evidence disabled.
  assert.throws(() => ensureHooksFeatureFlag('["features"]\nhooks = false\n'), /cannot patch|features table/);
  assert.throws(() => ensureHooksFeatureFlag('[features.sub]\nhooks = false\n'), /cannot patch|features table/);
  // An empty config carries exactly the table.
  assert.equal(ensureHooksFeatureFlag(''), '[features]\nhooks = true\n');
});

test('array-of-tables and dotted-key features shapes fail closed as PROBE_CONFIG_PATCH', () => {
  // These shapes are equally unpatchable: they fail closed with the
  // intended error instead of appending an invalid duplicate table and
  // failing later at config parse.
  assert.throws(() => ensureHooksFeatureFlag('[[features]]\nhooks = false\n'), /cannot patch|features table/);
  assert.throws(() => ensureHooksFeatureFlag('features.hooks = false\n'), /cannot patch|features table/);
});

test('spawnAgentHandleFromFrame validates the documented agent field, never UUID sweeps', () => {
  const distractor = '11111111-1111-1111-1111-111111111111';
  const handle = '22222222-2222-2222-2222-222222222222';
  const otherUuid = '33333333-3333-3333-3333-333333333333';
  // Structured output carrying the spawn result's agentId: the handle is
  // the ONLY value picked — distractor UUIDs elsewhere in the frame are not.
  assert.equal(spawnAgentHandleFromFrame({
    type: 'item.completed',
    item: {
      type: 'collab_tool_call', status: 'completed', tool: 'spawn_agent',
      input: { task: 'capture once', thread_id: distractor },
      output: { agentId: handle, thread_id: otherUuid },
    },
  }), handle);
  // JSON-string output: parsed, then the agent field validated.
  assert.equal(spawnAgentHandleFromFrame({
    type: 'item.completed',
    item: {
      type: 'collab_tool_call', status: 'completed', tool: 'spawn_agent',
      input: { thread_id: distractor },
      output: JSON.stringify({ agent_id: handle, note: distractor }),
    },
  }), handle);
  // The agent field directly on the item is also the documented shape.
  assert.equal(spawnAgentHandleFromFrame({
    type: 'item.completed',
    item: { type: 'collab_tool_call', status: 'completed', tool: 'spawn_agent', agent: handle, input: { thread_id: distractor } },
  }), handle);
  // Frames without the agent field are rejected — no UUID sweeps even when
  // other UUID-shaped values exist.
  assert.equal(spawnAgentHandleFromFrame({
    type: 'item.completed',
    item: { type: 'collab_tool_call', status: 'completed', tool: 'spawn_agent', input: { thread_id: distractor }, output: { thread_id: otherUuid } },
  }), null);
  // Non-completed or non-collab items: null.
  assert.equal(spawnAgentHandleFromFrame({ type: 'item.completed', item: { type: 'collab_tool_call', status: 'in_progress', output: { agentId: handle } } }), null);
  assert.equal(spawnAgentHandleFromFrame({ type: 'item.completed', item: { type: 'exec_command', status: 'completed', output: { agentId: handle } } }), null);
  assert.equal(spawnAgentHandleFromFrame(null), null);
});

test('the timeout toolCallOutcome maps the closed enum with timed-out attribution', () => {
  // Timeout-attributed settlement plus an abnormal Host-reported call shape:
  // the call ended because of the configured timeout.
  assert.equal(deriveTimeoutToolCallOutcome({ settlement: 'signal-abort', mcpCallStatuses: ['failed'], hostExitObserved: false }), 'timed-out');
  assert.equal(deriveTimeoutToolCallOutcome({ settlement: 'transport-close', mcpCallStatuses: ['error'], hostExitObserved: true }), 'timed-out');
  // A failure without the timeout-attributed settlement stays failed — a
  // failure not attributable to the configured timeout.
  assert.equal(deriveTimeoutToolCallOutcome({ settlement: null, mcpCallStatuses: ['failed'], hostExitObserved: true }), 'failed');
  // A completed call is never timed-out, even with a settlement.
  assert.equal(deriveTimeoutToolCallOutcome({ settlement: 'signal-abort', mcpCallStatuses: ['completed'], hostExitObserved: false }), 'completed');
  // No transcript evidence: pending while a settlement landed or nothing is
  // observed yet, not-observed only after an observed exit.
  assert.equal(deriveTimeoutToolCallOutcome({ settlement: 'signal-abort', mcpCallStatuses: [], hostExitObserved: false }), 'pending');
  assert.equal(deriveTimeoutToolCallOutcome({ settlement: null, mcpCallStatuses: [], hostExitObserved: false }), 'pending');
  // The recorded run's shape: clean exit, no statuses, no settlement.
  assert.equal(deriveTimeoutToolCallOutcome({ settlement: null, mcpCallStatuses: [], hostExitObserved: true }), 'not-observed');
});

test('mcpCallStatusesFromCounts expands the never-overflowing status tally', () => {
  // The frame accounting tallies mcp_tool_call statuses in a count map that
  // cannot overflow the way the 32-entry diagnostic excerpt list can; the
  // assembly expands it into the status list the outcome seam consumes.
  const counts = new Map([['failed', 40], ['completed', 1]]);
  const statuses = mcpCallStatusesFromCounts(counts);
  assert.equal(statuses.length, 41);
  assert.equal(statuses.filter((status) => status === 'failed').length, 40);
  // A tally past the diagnostic excerpt cap still derives the outcome —
  // the observed failed call is not lost to the excerpt bound.
  assert.equal(deriveTimeoutToolCallOutcome({ settlement: 'signal-abort', mcpCallStatuses: statuses, hostExitObserved: true }), 'timed-out');
  assert.equal(deriveTimeoutToolCallOutcome({ settlement: null, mcpCallStatuses: statuses, hostExitObserved: false }), 'failed');
  assert.deepEqual(mcpCallStatusesFromCounts(new Map()), []);
  assert.deepEqual(mcpCallStatusesFromCounts(undefined), []);
});

test('saltedHashSetsEqual correlates the concurrent-Child group without positional assumptions', () => {
  // The capture order is completion-dependent: swapped order still proves
  // the group bijection where positional pairing would have compared each
  // capture with the wrong Child.
  assert.equal(saltedHashSetsEqual(['h-b', 'h-a'], ['h-a', 'h-b']), true);
  // Any mismatch or missing record fails the group.
  assert.equal(saltedHashSetsEqual(['h-a', 'h-b'], ['h-a', 'h-c']), false);
  assert.equal(saltedHashSetsEqual(['h-a', 'h-b'], ['h-a', null]), false);
  assert.equal(saltedHashSetsEqual(['h-a', 'h-b'], ['h-a']), false);
  // Multiset semantics: a duplicated capture hash is not interchangeable.
  assert.equal(saltedHashSetsEqual(['h-a', 'h-a'], ['h-a', 'h-b']), false);
  assert.equal(saltedHashSetsEqual([], []), true);
});

test('the fresh capture join pairs thread candidates always and the driver-known turn when known', () => {
  const capture = { envelopeThreadIdHash: 'thread-1', innerSessionIdHash: 'sess-1', threadHash: 'thread-1', turnHash: 'turn-9' };
  // Thread evidence pairs all three thread candidates against the salted
  // thread id (the matching candidate true, the others honest contrasts);
  // the driver-known turn id (the Root capture turn, from the driver's own
  // turn/start response) joins only innerTurnId — so the turn cell carries
  // app-server-path turn evidence, not just the exec path's.
  assert.deepEqual(freshCaptureJoinFacts(capture, { scope: 'root', threadHash: 'thread-1', turnHash: 'turn-9' }), [
    { scope: 'root', candidate: 'envelopeThreadId', authority: 'appServerThreadId', equal: true },
    { scope: 'root', candidate: 'innerSessionId', authority: 'appServerThreadId', equal: false },
    { scope: 'root', candidate: 'innerThreadId', authority: 'appServerThreadId', equal: true },
    { scope: 'root', candidate: 'innerTurnId', authority: 'appServerTurnId', equal: true },
  ]);
  // Without a driver-known turn id (the spawn Child's turn comes only from
  // thread/read), no turn fact is fabricated.
  const withoutTurn = freshCaptureJoinFacts(capture, { scope: 'child', threadHash: 'thread-1', turnHash: null });
  assert.deepEqual(withoutTurn.filter((fact) => fact.authority === 'appServerTurnId'), []);
  assert.equal(withoutTurn.some((fact) => fact.scope === 'child' && fact.candidate === 'innerThreadId'), true);
  // The turn join contrasts honestly against a different turn id — the
  // join targets the capture turn, never any other turn.
  assert.deepEqual(freshCaptureJoinFacts(capture, { scope: 'root', threadHash: 'thread-1', turnHash: 'held-turn' }).filter((fact) => fact.authority === 'appServerTurnId'), [
    { scope: 'root', candidate: 'innerTurnId', authority: 'appServerTurnId', equal: false },
  ]);
});

test('the persisted-turn correlation is identity-based, not positional', () => {
  const salt = (value) => `salt-${value}`;
  const captures = [{ turnHash: 'salt-t1' }, { turnHash: 'salt-t2' }];
  // thread/read's turn ordering is non-contractual: newest-first and
  // oldest-first arrays must produce the same fact.
  const oldestFirst = correlateTurnSet(captures, [{ id: 't1' }, { id: 't2' }], salt);
  const newestFirst = correlateTurnSet(captures, [{ id: 't2' }, { id: 't1' }], salt);
  assert.equal(oldestFirst.equal, true);
  assert.equal(newestFirst.equal, true);
  assert.deepEqual(newestFirst.saltedTurnIdHashes.sort(), oldestFirst.saltedTurnIdHashes.sort());
  assert.deepEqual(oldestFirst.saltedTurnIdHashes, ['salt-t1', 'salt-t2']);
  // Child scope: the initial Child carries TWO turns (the original call and
  // the followup), so BOTH Child captures join the persisted turn set —
  // identical facts under either ordering.
  assert.equal(correlateTurnSet([{ turnHash: 'salt-c1' }, { turnHash: 'salt-c2' }], [{ id: 'c2' }, { id: 'c1' }], salt).equal, true);
  assert.equal(correlateTurnSet([{ turnHash: 'salt-c1' }, { turnHash: 'salt-c2' }], [{ id: 'c1' }, { id: 'c2' }], salt).equal, true);
  // Any mismatch — a foreign turn id, a missing turn, a missing capture
  // hash — reduces false.
  assert.equal(correlateTurnSet(captures, [{ id: 't1' }, { id: 't3' }], salt).equal, false);
  assert.equal(correlateTurnSet(captures, [{ id: 't1' }], salt).equal, false);
  assert.equal(correlateTurnSet([{ turnHash: 'salt-t1' }, { turnHash: null }], [{ id: 't1' }, { id: 't2' }], salt).equal, false);
});

test('the app-server capture gate requires a completed turn with attributable Root/Child captures', () => {
  const capture = (envelopeThreadIdHash, innerSessionIdHash, threadHash) => ({ envelopeThreadIdHash, innerSessionIdHash, threadHash });
  // Completed turn plus Root/Child captures attributable to the
  // app-server-created threads: the equality evidence may be collected.
  assert.deepEqual(appServerCaptureEvidenceGate({
    turnStatus: 'completed',
    freshCaptures: [capture('root-hash', 'root-hash', 'root-hash'), capture('child-hash', 'child-hash', 'child-hash')],
    rootThreadCandidateHashes: ['root-hash'],
    childThreadCandidateHashes: [['child-hash']],
  }), { collected: true, rootCaptureIndex: 0, childCaptureIndex: 1, childRecordIndex: 0 });
  // Attribution is by ANY candidate hash — discovery, not preselection.
  // A capture matching only via the envelope threadId opens the gate...
  assert.deepEqual(appServerCaptureEvidenceGate({
    turnStatus: 'completed',
    freshCaptures: [capture('root-hash', null, null), capture('child-hash', null, null)],
    rootThreadCandidateHashes: ['root-hash'],
    childThreadCandidateHashes: [['child-hash']],
  }), { collected: true, rootCaptureIndex: 0, childCaptureIndex: 1, childRecordIndex: 0 });
  // ...only via the inner session_id...
  assert.deepEqual(appServerCaptureEvidenceGate({
    turnStatus: 'completed',
    freshCaptures: [capture(null, 'root-hash', null), capture(null, 'child-hash', null)],
    rootThreadCandidateHashes: ['root-hash'],
    childThreadCandidateHashes: [['child-hash']],
  }), { collected: true, rootCaptureIndex: 0, childCaptureIndex: 1, childRecordIndex: 0 });
  // ...only via the inner thread_id...
  assert.deepEqual(appServerCaptureEvidenceGate({
    turnStatus: 'completed',
    freshCaptures: [capture(null, null, 'root-hash'), capture(null, null, 'child-hash')],
    rootThreadCandidateHashes: ['root-hash'],
    childThreadCandidateHashes: [['child-hash']],
  }), { collected: true, rootCaptureIndex: 0, childCaptureIndex: 1, childRecordIndex: 0 });
  // ...and the Child may match through a different candidate than the Root.
  assert.deepEqual(appServerCaptureEvidenceGate({
    turnStatus: 'completed',
    freshCaptures: [capture('root-hash', null, null), capture(null, 'child-hash', null)],
    rootThreadCandidateHashes: ['root-hash'],
    childThreadCandidateHashes: [['child-hash']],
  }), { collected: true, rootCaptureIndex: 0, childCaptureIndex: 1, childRecordIndex: 0 });
  // Capture order is completion-dependent: the Child capture may precede
  // the Root capture.
  assert.deepEqual(appServerCaptureEvidenceGate({
    turnStatus: 'completed',
    freshCaptures: [capture('child-hash', 'child-hash', 'child-hash'), capture('root-hash', 'root-hash', 'root-hash')],
    rootThreadCandidateHashes: ['root-hash'],
    childThreadCandidateHashes: [['child-hash']],
  }), { collected: true, rootCaptureIndex: 1, childCaptureIndex: 0, childRecordIndex: 0 });
  // The turn never reached a terminal status: evidence stays not-collected.
  assert.deepEqual(appServerCaptureEvidenceGate({
    turnStatus: null,
    freshCaptures: [capture('root-hash', 'root-hash', 'root-hash'), capture('child-hash', 'child-hash', 'child-hash')],
    rootThreadCandidateHashes: ['root-hash'],
    childThreadCandidateHashes: [['child-hash']],
  }), { collected: false, rootCaptureIndex: null, childCaptureIndex: null, childRecordIndex: null });
  // No Root-attributable capture: the model never called capture_context on
  // the app-server Root.
  assert.equal(appServerCaptureEvidenceGate({
    turnStatus: 'completed',
    freshCaptures: [capture('elsewhere-hash', 'elsewhere-hash', 'elsewhere-hash')],
    rootThreadCandidateHashes: ['root-hash'],
    childThreadCandidateHashes: [['child-hash']],
  }).collected, false);
  // Root captured but no Child capture on an app-server-created thread.
  assert.equal(appServerCaptureEvidenceGate({
    turnStatus: 'completed',
    freshCaptures: [capture('root-hash', 'root-hash', 'root-hash')],
    rootThreadCandidateHashes: ['root-hash'],
    childThreadCandidateHashes: [['child-hash']],
  }).collected, false);
  // A capture on a thread that is neither the app-server Root nor one of its
  // persisted children is not Child evidence.
  assert.equal(appServerCaptureEvidenceGate({
    turnStatus: 'completed',
    freshCaptures: [capture('root-hash', null, null), capture('unknown-hash', 'unknown-hash', 'unknown-hash')],
    rootThreadCandidateHashes: ['root-hash'],
    childThreadCandidateHashes: [['child-hash']],
  }).collected, false);
  // The children list read failed (empty): attribution stays closed.
  assert.equal(appServerCaptureEvidenceGate({
    turnStatus: 'completed',
    freshCaptures: [capture('root-hash', 'root-hash', 'root-hash'), capture('child-hash', 'child-hash', 'child-hash')],
    rootThreadCandidateHashes: ['root-hash'],
    childThreadCandidateHashes: [],
  }).collected, false);
  // The Root capture cannot double as the Child capture.
  assert.equal(appServerCaptureEvidenceGate({
    turnStatus: 'completed',
    freshCaptures: [capture('root-hash', 'root-hash', 'root-hash')],
    rootThreadCandidateHashes: ['root-hash'],
    childThreadCandidateHashes: [['root-hash']],
  }).collected, false);
});


test('transportState comes from server-side observations, never from the Host exit', () => {
  // Only a transport-close settlement is the server's own observation that
  // its stdin ended — whatever killed the Host.
  assert.equal(deriveTransportState({ settlement: 'transport-close', serverAlive: false }), 'stdin-eof');
  assert.equal(deriveTransportState({ settlement: 'transport-close', serverAlive: true }), 'stdin-eof');
  // A signal-abort settlement does NOT imply the transport closed: in a Host
  // that propagates cancellation through the SDK abort the server stays up,
  // so the observed server liveness decides.
  assert.equal(deriveTransportState({ settlement: 'signal-abort', serverAlive: true }), 'open');
  assert.equal(deriveTransportState({ settlement: 'signal-abort', serverAlive: false }), 'server-exited');
  // A driver-observed live server process is an open transport.
  assert.equal(deriveTransportState({ settlement: null, serverAlive: true }), 'open');
  // A driver-observed dead server process is real server-exit evidence.
  assert.equal(deriveTransportState({ settlement: null, serverAlive: false }), 'server-exited');
  // Host exit observed with no server evidence at all: nothing is known
  // about any server — 'not-observed', NEVER the host-inferred
  // 'server-exited' (the server's pending handler may outlive the Host).
  assert.equal(deriveTransportState({ settlement: null, serverAlive: null }), 'not-observed');
});


test('boundedStdoutLines keeps the JSON-RPC client inside the 4 MiB discipline', () => {
  const FOUR_MIB = 4 * 1024 * 1024;
  let state = { buffer: '', totalBytes: 0, overflow: false };
  // Multi-chunk line assembly; the incomplete tail stays buffered.
  let folded = boundedStdoutLines(state, '{"id":1,"res', FOUR_MIB);
  state = folded.state;
  assert.deepEqual(folded.lines, []);
  folded = boundedStdoutLines(state, 'ult":{}}\n{"id":2}\n{"id":3', FOUR_MIB);
  state = folded.state;
  assert.deepEqual(folded.lines, ['{"id":1,"result":{}}', '{"id":2}']);
  // At exactly the bound there is no overflow.
  folded = boundedStdoutLines({ buffer: '', totalBytes: 0, overflow: false }, 'x'.repeat(FOUR_MIB), FOUR_MIB);
  assert.equal(folded.state.overflow, false);
  // Crossing the bound overflows: the flag is sticky and no further lines
  // are produced (the caller drains and discards).
  folded = boundedStdoutLines({ buffer: '', totalBytes: FOUR_MIB, overflow: false }, 'x', FOUR_MIB);
  assert.equal(folded.state.overflow, true);
  assert.deepEqual(folded.lines, []);
  folded = boundedStdoutLines(folded.state, '{"id":9}\n', FOUR_MIB);
  assert.deepEqual(folded.lines, []);
  assert.equal(folded.state.overflow, true);
});

test('notification overflow fails the bounded app-server session closed', async () => {
  // A synthetic server streaming notifications past the bounded cap: the
  // session must terminate — settling pending requests through the
  // disconnect path — instead of silently discarding frames a turn/completed
  // could live in and degrading the characterization into a false pending.
  const fakeServer = [
    'let count = 0;',
    'const timer = setInterval(() => {',
    '  for (let i = 0; i < 16; i += 1) {',
    "    count += 1;",
    "    process.stdout.write(JSON.stringify({ method: 'probe/noise', params: { n: count } }) + '\\n');",
    '  }',
    '}, 25);',
  ].join('\n');
  const session = startAppServerSession({ command: process.execPath, args: ['-e', fakeServer], env: process.env, cwd: tmpdir() });
  try {
    await assert.rejects(
      session.request('initialize', { capabilities: null }, 10_000),
      (error) => error.code === 'PROBE_APP_SERVER_DISCONNECTED',
      'notification overflow must settle pending requests through the disconnect path',
    );
    // The redacted counter reflects the discarded frames (a getter over the
    // live session state, not a creation-time snapshot).
    assert.ok(session.notificationsOverflow >= 1, 'the overflow counter must count the discarded notifications');
  } finally {
    await session.terminate();
  }
});

test('concurrentChildHookFacts correlate hooks to captures without positional assumptions', () => {
  const captures = [
    { envelopeThreadIdHash: 'env-1', innerSessionIdHash: 'sess-1', threadHash: 'thread-1', turnHash: 'turn-1' },
    { envelopeThreadIdHash: 'env-2', innerSessionIdHash: 'sess-2', threadHash: 'thread-2', turnHash: 'turn-2' },
  ];
  // The hook order is creation-dependent and the capture order is
  // completion-dependent: swapped order still proves the bijection where
  // positional pairing would have compared each capture with the wrong hook.
  const hooks = [
    { sessionHash: 'sess-2', turnHash: 'turn-2', agentHash: 'env-2' },
    { sessionHash: 'sess-1', turnHash: 'turn-1', agentHash: 'env-1' },
  ];
  const facts = concurrentChildHookFacts(captures, hooks);
  const cell = (candidate, authority) => facts.find((fact) => fact.candidate === candidate && fact.authority === authority);
  assert.equal(cell('innerSessionId', 'hookSessionId').equal, true);
  assert.equal(cell('innerTurnId', 'hookTurnId').equal, true);
  assert.equal(cell('envelopeThreadId', 'hookAgentId').equal, true);
  // Contrast namespaces stay false as sets, exactly as the per-pair facts did.
  assert.equal(cell('innerThreadId', 'hookAgentId').equal, false);
  assert.equal(cell('envelopeThreadId', 'hookSessionId').equal, false);
  assert.equal(facts.every((fact) => fact.scope === 'child'), true);
  // A missing authority hash is missing evidence, not a contradiction: the
  // pair is skipped instead of recorded false.
  const partial = concurrentChildHookFacts(captures, [
    { sessionHash: 'sess-1', turnHash: 'turn-1', agentHash: null },
    { sessionHash: 'sess-2', turnHash: 'turn-2', agentHash: 'env-2' },
  ]);
  assert.equal(partial.some((fact) => fact.authority === 'hookAgentId'), false);
  assert.equal(partial.find((fact) => fact.candidate === 'innerSessionId' && fact.authority === 'hookSessionId').equal, true);
  // Multiset semantics: a duplicated candidate hash is not interchangeable.
  const duplicated = concurrentChildHookFacts(
    [
      { envelopeThreadIdHash: 'e1', innerSessionIdHash: 's1', threadHash: 't1', turnHash: 'u1' },
      { envelopeThreadIdHash: 'e1', innerSessionIdHash: 's2', threadHash: 't2', turnHash: 'u2' },
    ],
    [
      { sessionHash: 's1', turnHash: 'u1', agentHash: 'a1' },
      { sessionHash: 's2', turnHash: 'u2', agentHash: 'a2' },
    ],
  );
  assert.equal(duplicated.find((fact) => fact.candidate === 'envelopeThreadId' && fact.authority === 'hookAgentId').equal, false);
});

test('returnedChildHandleFacts come from the parsed spawn handles, never from the app-server ids', () => {
  const initialCapture = { envelopeThreadIdHash: 'env-1', innerSessionIdHash: 'sess-1', threadHash: 'thread-1' };
  const concurrentCaptures = [{ threadHash: 'thread-2' }, { threadHash: 'thread-3' }];
  // Three parsed handles: per-pair facts for the initial Child (the first
  // handle — its spawn completed before the concurrent pair) and a set fact
  // for the concurrent pair, whose handle order is completion-dependent.
  const facts = returnedChildHandleFacts(initialCapture, concurrentCaptures, ['thread-1', 'thread-3', 'thread-2']);
  assert.deepEqual(facts.filter((fact) => fact.candidate === 'innerThreadId' && fact.authority === 'returnedChildHandle').map((fact) => fact.equal), [true, true]);
  // Contrast candidates whose fixture values differ from the handle stay false.
  assert.equal(facts.find((fact) => fact.candidate === 'envelopeThreadId').equal, false);
  assert.equal(facts.find((fact) => fact.candidate === 'innerSessionId').equal, false);
  // A wrong first handle fails the initial pair.
  const wrong = returnedChildHandleFacts(initialCapture, concurrentCaptures, ['other', 'thread-2', 'thread-3']);
  assert.equal(wrong.find((fact) => fact.candidate === 'innerThreadId').equal, false);
  // Fewer parsed handles than children: the missing authority is honestly
  // absent — the initial pair still holds from the one parsed handle, and
  // no concurrent fact is fabricated.
  const partial = returnedChildHandleFacts(initialCapture, concurrentCaptures, ['thread-1']);
  assert.deepEqual(partial.filter((fact) => fact.candidate === 'innerThreadId').map((fact) => fact.equal), [true]);
  // No parsed handles at all: no facts.
  assert.deepEqual(returnedChildHandleFacts(initialCapture, concurrentCaptures, []), []);
  // An incomplete capture hash is a false pair, consistent with the
  // per-pair candidate semantics.
  const incomplete = returnedChildHandleFacts({ envelopeThreadIdHash: null, innerSessionIdHash: 'sess-1', threadHash: 'thread-1' }, concurrentCaptures, ['thread-1', 'thread-2', 'thread-3']);
  assert.equal(incomplete.find((fact) => fact.candidate === 'envelopeThreadId').equal, false);
});

test('probe phases, assertions, and lifecycle cases are the closed qualification vocabulary', () => {
  assert.deepEqual(PROBE_PHASES, ['negative-control', 'matrix', 'cli-sigint', 'cli-sigkill', 'app-server-interrupt', 'plugin-tool-timeout', 'direct-config-timeout']);
  assert.deepEqual([...PROBE_CONTEXT_ASSERTIONS].sort(), [
    'concurrentChildrenDistinct', 'identityFieldsVisible', 'identityNamespaceQualified',
    'laterTurnDistinct', 'metadataChangesAcrossTurns', 'serverLoadedWithConfig',
  ]);
  assert.deepEqual([...PROBE_LIFECYCLE_CASES].sort(), [
    'appServerTurnInterrupt', 'cliSigint', 'cliSigkill', 'directConfigToolTimeout', 'pluginToolTimeout',
  ]);
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

test('the qualification rejects a nonempty run directory', async () => {
  await withProbeRun('zcode-probe-nonempty-', async (run) => {
    await writeFile(join(run, 'leftover.txt'), 'pre-existing state');
    await assert.rejects(
      () => qualifyMcpContext({ codexPath: '/bin/true', runDirectory: run, sourceCodexHome: run }),
      /PROBE_RUN_DIRECTORY_NOT_EMPTY|must be empty/,
    );
  });
});
