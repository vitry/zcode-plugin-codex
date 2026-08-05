// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';
import { createStateStore } from '../scripts/lib/state.mjs';
import { createManagedZCodeClient, releaseManagedZCodeOwner } from '../scripts/lib/zcode-client.mjs';
import { ownerIdForSession } from '../scripts/lib/job-control.mjs';
import { ensureZCodeBroker, reconcileBrokerOwnership } from '../scripts/zcode-broker.mjs';

const root = new URL('../', import.meta.url).pathname;
const fakeZCode = join(root, 'tests/fixtures/fake-zcode-cli.mjs');

async function jsonFiles(directory) {
  const found = []; let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) { const path = join(directory, entry.name); if (entry.isDirectory()) found.push(...await jsonFiles(path)); else if (entry.name.endsWith('.json')) found.push(path); }
  return found;
}

async function runHook(script, input, env = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [options.absolute ? script : join(root, 'hooks', script)], {
      cwd: input.cwd ?? root,
      env: { ...process.env, PLUGIN_ROOT: root, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr, json: stdout.trim() ? JSON.parse(stdout) : null }));
    child.stdin.end(options.raw ?? JSON.stringify(input));
  });
}

async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), 'zpc-hooks-workspace-'));
  const data = await mkdtemp(join(tmpdir(), 'zpc-hooks-data-'));
  await new Promise((resolve, reject) => {
    const child = spawn('git', ['init', '-q'], { cwd });
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`git init ${code}`)));
  });
  await writeFile(join(cwd, 'tracked.txt'), 'before\n');
  await new Promise((resolve, reject) => {
    const child = spawn('git', ['add', '.'], { cwd }); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`git add ${code}`)));
  });
  await new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init'], { cwd }); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`git commit ${code}`)));
  });
  return { cwd, data, env: { PLUGIN_DATA: data } };
}

async function writeGateConfig(data, cwd, value) { const storage = await resolveWorkspaceStorage({ dataRoot: data, workspace: cwd }); await mkdir(join(storage.directory, 'config'), { recursive: true }); await writeFile(join(storage.directory, 'config/review-gate.json'), JSON.stringify(value)); }
function stopFields(input) { const copy = { ...input }; delete copy.prompt; return copy; }
function processAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

test('hooks.json registers bounded native lifecycle hooks with no manifest field', async () => {
  const hooks = JSON.parse(await readFile(join(root, 'hooks/hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ['SessionEnd', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit']);
  for (const groups of Object.values(hooks.hooks)) for (const group of groups) for (const hook of group.hooks) {
    assert.match(hook.command, /^node "\$PLUGIN_ROOT\/hooks\/[a-z-]+\.mjs"$/);
    assert.ok(Number.isSafeInteger(hook.timeout) && hook.timeout > 0);
    assert.ok(Number.isSafeInteger(hook.additionalContextLimit) && hook.additionalContextLimit > 0);
  }
  assert.equal(hooks.hooks.Stop[0].hooks[0].timeout, 900);
  assert.ok(hooks.hooks.SessionEnd[0].hooks[0].timeout <= 3);
  const manifest = JSON.parse(await readFile(join(root, '.codex-plugin/plugin.json'), 'utf8'));
  assert.equal('hooks' in manifest, false);
  assert.doesNotMatch(await readFile(join(root, 'hooks/stop-review-gate-hook.mjs'), 'utf8'), /NODE_ENV|ZCODE_TEST/, 'production hook must not expose test-only timeout controls');
});

test('hook input rejects oversized, malformed, extra-field and wrong-event input safely', async () => {
  const { cwd, data, env } = await workspace();
  for (const raw of ['{', JSON.stringify({ session_id: 's', cwd, hook_event_name: 'SessionStart', source: 'startup', extra: true }), JSON.stringify({ session_id: 's\nIGNORE', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }), 'x'.repeat(70 * 1024)]) {
    const result = await runHook('session-lifecycle-hook.mjs', { cwd }, { ...env, PLUGIN_DATA: data }, { raw });
    assert.notEqual(result.code, 0); assert.equal(result.stdout, ''); assert.doesNotMatch(result.stderr, /x{100}|transcript/);
  }
});

test('two sessions in one workspace get isolated caller capabilities, permission snapshots and baselines', async () => {
  const { cwd, data, env } = await workspace();
  for (const session_id of ['session-a', 'session-b']) {
    const start = await runHook('session-lifecycle-hook.mjs', { session_id, cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
    assert.equal(start.code, 0);
  }
  const a = await runHook('user-prompt-hook.mjs', { session_id: 'session-a', turn_id: 'turn-a', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: '/never/read', model: 'gpt', permission_mode: 'plan', prompt: 'hello' }, env);
  const b = await runHook('user-prompt-hook.mjs', { session_id: 'session-b', turn_id: 'turn-b', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'dontAsk', prompt: 'hello' }, env);
  assert.equal(a.code, 0); assert.equal(b.code, 0);
  const ac = a.json.hookSpecificOutput.additionalContext; const bc = b.json.hookSpecificOutput.additionalContext;
  assert.match(ac, /ZCODE_CALLER_CONTEXT=/); assert.match(bc, /ZCODE_CALLER_CONTEXT=/); assert.notEqual(ac, bc);
  assert.doesNotMatch(`${a.stdout}${b.stdout}`, /transcript_path|\/never\/read|brokerToken|executionCapability/);
  const files = await jsonFiles(join(data, 'workspaces'));
  const records = await Promise.all(files.map(async (path) => JSON.parse(await readFile(path, 'utf8'))));
  assert.ok(records.some((record) => record.sessionId === 'session-a' && record.permissionMode === 'plan'));
  assert.ok(records.some((record) => record.sessionId === 'session-b' && record.permissionMode === 'dontAsk'));
  assert.ok(records.filter((record) => record.kind === 'baseline').every((record) => /^[a-f0-9]{64}$/.test(record.fingerprint)));
  const allStored = (await Promise.all((await jsonFiles(data)).map((path) => readFile(path, 'utf8')))).join('\n');
  for (const token of [ac, bc].map((value) => value.match(/ZCODE_CALLER_CONTEXT=([^\s]+)/)?.[1])) assert.ok(token && !allStored.includes(token));
});

test('SubagentStart marks forwarding suppression without changing parent permission snapshot', async () => {
  const { cwd, env } = await workspace();
  await runHook('session-lifecycle-hook.mjs', { session_id: 'parent', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'plan', source: 'startup' }, env);
  await runHook('user-prompt-hook.mjs', { session_id: 'parent', turn_id: 'turn', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'plan', prompt: 'go' }, env);
  const sub = await runHook('subagent-hook.mjs', { session_id: 'parent', turn_id: 'turn', cwd, hook_event_name: 'SubagentStart', transcript_path: null, model: 'gpt', permission_mode: 'bypassPermissions', agent_id: 'agent-1', agent_type: 'zcode-rescue' }, env);
  assert.equal(sub.code, 0); assert.match(sub.json.hookSpecificOutput.additionalContext, /forwarding subagent/i);
  const stop = await runHook('subagent-hook.mjs', { session_id: 'parent', turn_id: 'turn', cwd, hook_event_name: 'SubagentStop', transcript_path: null, model: 'gpt', permission_mode: 'bypassPermissions', agent_id: 'agent-1', agent_type: 'zcode-rescue', agent_transcript_path: null, stop_hook_active: false, last_assistant_message: null }, env);
  assert.equal(stop.code, 0); assert.deepEqual(stop.json, {});
});

test('SessionEnd removes only its session contexts and leaves sibling jobs/session ownership', async () => {
  const { cwd, data, env } = await workspace();
  for (const session_id of ['a', 'b']) {
    await runHook('session-lifecycle-hook.mjs', { session_id, cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
    await runHook('user-prompt-hook.mjs', { session_id, turn_id: `turn-${session_id}`, cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'go' }, env);
  }
  const ended = await runHook('session-end-hook.mjs', { session_id: 'a', cwd, hook_event_name: 'SessionEnd', transcript_path: null, model: 'gpt', reason: 'other' }, env);
  assert.equal(ended.code, 0); assert.equal(ended.stdout, '');
  const contents = (await Promise.all((await jsonFiles(data)).map((path) => readFile(path, 'utf8')))).join('\n');
  assert.doesNotMatch(contents, /"sessionId": "a"/); assert.match(contents, /"sessionId": "b"/);
});

test('SessionEnd releases only its broker owner sessions and lets the idle broker exit', async () => {
  const { cwd, data, env } = await workspace(); const record = join(data, 'zcode-calls.jsonl'); await writeFile(record, '');
  const launch = { command: process.execPath, args: [fakeZCode], target: fakeZCode }; const clients = [];
  for (const sessionId of ['a', 'b']) {
    await runHook('session-lifecycle-hook.mjs', { session_id: sessionId, cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
    const client = await createManagedZCodeClient({ dataRoot: data, workspace: cwd, launch, ownerId: ownerIdForSession(sessionId), env: { ...process.env, FAKE_ZCODE_RECORD: record } });
    clients.push(client); await client.createSession({ workspace: cwd, sessionId: `zcode-${sessionId}` });
  }
  for (const client of clients) await client.close();
  const storage = await resolveWorkspaceStorage({ dataRoot: data, workspace: cwd }); const identity = JSON.parse(await readFile(join(storage.directory, 'broker/identity.json'), 'utf8'));
  const ended = await runHook('session-end-hook.mjs', { session_id: 'a', cwd, hook_event_name: 'SessionEnd', transcript_path: null, model: 'gpt', reason: 'other' }, env);
  assert.equal(ended.code, 0);
  const owners = JSON.parse(await readFile(join(storage.directory, 'broker/session-owners.json'), 'utf8'));
  assert.deepEqual(owners.sessions, { 'zcode-b': ownerIdForSession('b') });
  const calls = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(calls.some((call) => call.method === 'session/stop' && call.params?.sessionId === 'zcode-a'));
  assert.ok(!calls.some((call) => call.method === 'session/stop' && call.params?.sessionId === 'zcode-b'));
  const deadline = Date.now() + 2_000; while (Date.now() < deadline && processAlive(identity.pid)) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(processAlive(identity.pid), false, 'released idle broker must exit promptly');
});

test('owner release spans existing broker profiles and preserves mappings whose stop failed', async () => {
  const { cwd, data } = await workspace(); const record = join(data, 'zcode-calls.jsonl'); await writeFile(record, '');
  const launch = { command: process.execPath, args: [fakeZCode], target: fakeZCode }; const ownerA = ownerIdForSession('a'); const ownerB = ownerIdForSession('b');
  const profiles = [{}, { maxFrameBytes: 16 * 1024 * 1024, maxOutboundBytes: 16 * 1024 * 1024 }];
  for (const [index, profile] of profiles.entries()) {
    const first = await createManagedZCodeClient({ dataRoot: data, workspace: cwd, launch, ownerId: ownerA, env: { ...process.env, FAKE_ZCODE_RECORD: record, ...(index ? { FAKE_ZCODE_ERROR: 'session/stop' } : {}) }, ...profile });
    await first.createSession({ workspace: cwd, sessionId: `owner-a-${index}` }); await first.close();
    const sibling = await createManagedZCodeClient({ dataRoot: data, workspace: cwd, launch, ownerId: ownerB, env: { ...process.env, FAKE_ZCODE_RECORD: record, ...(index ? { FAKE_ZCODE_ERROR: 'session/stop' } : {}) }, ...profile });
    await sibling.createSession({ workspace: cwd, sessionId: `owner-b-${index}` }); await sibling.close();
  }
  const result = await releaseManagedZCodeOwner({ dataRoot: data, workspace: cwd, ownerId: ownerA, requestTimeoutMs: 750 });
  assert.deepEqual(result.releasedSessionIds, ['owner-a-0']); assert.deepEqual(result.failedSessionIds, ['owner-a-1']);
  const storage = await resolveWorkspaceStorage({ dataRoot: data, workspace: cwd }); const brokerFiles = await readdir(join(storage.directory, 'broker')); const stores = brokerFiles.filter((name) => /^session-owners(?:-[a-f0-9]{16})?\.json$/.test(name));
  const mappings = Object.assign({}, ...await Promise.all(stores.map(async (name) => {
    const value = JSON.parse(await readFile(join(storage.directory, 'broker', name), 'utf8')); return value.sessions;
  })));
  assert.deepEqual(mappings, { 'owner-b-0': ownerB, 'owner-a-1': ownerA, 'owner-b-1': ownerB });
  const calls = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(calls.some((call) => call.method === 'session/stop' && call.params?.sessionId === 'owner-a-0'));
  assert.ok(calls.some((call) => call.method === 'session/stop' && call.params?.sessionId === 'owner-a-1'));
  assert.ok(!calls.some((call) => call.method === 'session/stop' && /^owner-b-/.test(call.params?.sessionId ?? '')));
});

test('hung owner stops are broker-bounded and retain every unconfirmed and sibling mapping', async () => {
  const { cwd, data } = await workspace(); const record = join(data, 'zcode-calls.jsonl'); await writeFile(record, ''); const ownerA = ownerIdForSession('hung-a'); const ownerB = ownerIdForSession('hung-b');
  const launch = { command: process.execPath, args: [fakeZCode], target: fakeZCode }; const peerEnv = { ...process.env, FAKE_ZCODE_RECORD: record, FAKE_ZCODE_SUPPRESS_METHOD: 'session/stop' };
  const first = await createManagedZCodeClient({ dataRoot: data, workspace: cwd, launch, ownerId: ownerA, env: peerEnv });
  for (let index = 0; index < 4; index += 1) await first.createSession({ workspace: cwd, sessionId: `hung-owner-${index}` }); await first.close();
  const sibling = await createManagedZCodeClient({ dataRoot: data, workspace: cwd, launch, ownerId: ownerB, env: peerEnv }); await sibling.createSession({ workspace: cwd, sessionId: 'hung-sibling' }); await sibling.close();
  const storage = await resolveWorkspaceStorage({ dataRoot: data, workspace: cwd }); const identity = JSON.parse(await readFile(join(storage.directory, 'broker/identity.json'), 'utf8')); const started = Date.now();
  const result = await releaseManagedZCodeOwner({ dataRoot: data, workspace: cwd, ownerId: ownerA, requestTimeoutMs: 750 });
  assert.ok(Date.now() - started < 2_000, 'broker owner cleanup must finish inside the SessionEnd budget'); assert.deepEqual(result.releasedSessionIds, []); assert.deepEqual(result.failedSessionIds.sort(), ['hung-owner-0', 'hung-owner-1', 'hung-owner-2', 'hung-owner-3']); assert.equal(result.deferredSessionCount, 0);
  const owners = JSON.parse(await readFile(join(storage.directory, 'broker/session-owners.json'), 'utf8')).sessions;
  assert.deepEqual(owners, { 'hung-owner-0': ownerA, 'hung-owner-1': ownerA, 'hung-owner-2': ownerA, 'hung-owner-3': ownerA, 'hung-sibling': ownerB });
  const calls = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); assert.equal(calls.filter((call) => call.method === 'session/stop').length, 4); assert.ok(!calls.some((call) => call.method === 'session/stop' && call.params?.sessionId === 'hung-sibling'));
  const deadline = Date.now() + 2_000; while (Date.now() < deadline && processAlive(identity.pid)) await new Promise((resolve) => setTimeout(resolve, 25)); assert.equal(processAlive(identity.pid), false, 'bounded broker local task must permit fast idle exit');
});

test('owner release does not spawn ZCode when a live broker has only historical ownership', async () => {
  const { cwd, data } = await workspace(); const record = join(data, 'zcode-calls.jsonl'); await writeFile(record, ''); const ownerA = ownerIdForSession('historical-a'); const ownerB = ownerIdForSession('historical-b');
  await reconcileBrokerOwnership({ dataRoot: data, workspace: cwd, ownerId: ownerA, ownedSessionIds: ['historical-a-session'] }); await reconcileBrokerOwnership({ dataRoot: data, workspace: cwd, ownerId: ownerB, ownedSessionIds: ['historical-b-session'] });
  const identity = await ensureZCodeBroker({ dataRoot: data, workspace: cwd, launch: { command: process.execPath, args: [fakeZCode], target: fakeZCode }, env: { ...process.env, FAKE_ZCODE_RECORD: record } }); const started = Date.now();
  const result = await releaseManagedZCodeOwner({ dataRoot: data, workspace: cwd, ownerId: ownerA, requestTimeoutMs: 750 }); assert.ok(Date.now() - started < 2_000); assert.deepEqual(result, { releasedSessionIds: ['historical-a-session'], failedSessionIds: [], deferredSessionCount: 0 }); assert.equal(await readFile(record, 'utf8'), '', 'cleanup must not spawn the configured ZCode peer');
  const storage = await resolveWorkspaceStorage({ dataRoot: data, workspace: cwd }); assert.deepEqual(JSON.parse(await readFile(join(storage.directory, 'broker/session-owners.json'), 'utf8')).sessions, { 'historical-b-session': ownerB });
  const deadline = Date.now() + 2_000; while (Date.now() < deadline && processAlive(identity.pid)) await new Promise((resolve) => setTimeout(resolve, 25)); assert.equal(processAlive(identity.pid), false);
});

test('terminal completion context is routed durably once to its exact owner', async () => {
  const { cwd, data, env } = await workspace(); await runHook('session-lifecycle-hook.mjs', { session_id: 'owner', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
  const store = createStateStore({ dataRoot: data }); const job = await store.reserveJob({ workspace: cwd, ownerSessionId: 'owner', ownerTurnId: 'old', command: 'review', readOnly: true, permissionSnapshot: { permissionMode: 'default' } }); await store.transitionJob(cwd, job.id, ['queued'], 'failed', { error: { message: 'done' }, finishedAt: new Date().toISOString(), exitCode: 1 });
  const input = { session_id: 'owner', turn_id: 'new-1', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'next' };
  const first = await runHook('user-prompt-hook.mjs', input, env); const second = await runHook('user-prompt-hook.mjs', { ...input, turn_id: 'new-2' }, env);
  assert.match(first.json.hookSpecificOutput.additionalContext, new RegExp(job.id)); assert.doesNotMatch(second.json.hookSpecificOutput.additionalContext, new RegExp(job.id));
});

test('Stop suppresses continuation, forwarding and external sessions before starting ZCode', async () => {
  const { cwd, data, env } = await workspace(); const record = join(data, 'zcode-calls.jsonl'); await writeFile(record, '');
  const externalPrompt = await runHook('user-prompt-hook.mjs', { session_id: 'external', turn_id: 'turn', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'x' }, env); assert.deepEqual(externalPrompt.json, {});
  await runHook('session-lifecycle-hook.mjs', { session_id: 'parent', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env); const prompt = { session_id: 'parent', turn_id: 'turn', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'x' }; await runHook('user-prompt-hook.mjs', prompt, env); await writeFile(join(cwd, 'tracked.txt'), 'changed\n');
  const stop = { session_id: 'parent', turn_id: 'turn', cwd, hook_event_name: 'Stop', transcript_path: null, model: 'gpt', permission_mode: 'bypassPermissions', stop_hook_active: true, last_assistant_message: 'done' }; const continuation = await runHook('stop-review-gate-hook.mjs', stop, { ...env, ZCODE_PATH: fakeZCode, FAKE_ZCODE_RECORD: record }); assert.deepEqual(continuation.json, {});
  await runHook('subagent-hook.mjs', { session_id: 'parent', turn_id: 'turn', cwd, hook_event_name: 'SubagentStart', transcript_path: null, model: 'gpt', permission_mode: 'bypassPermissions', agent_id: 'agent', agent_type: 'zcode-rescue' }, env); const forwarding = await runHook('stop-review-gate-hook.mjs', { ...stop, stop_hook_active: false }, { ...env, ZCODE_PATH: fakeZCode, FAKE_ZCODE_RECORD: record }); assert.deepEqual(forwarding.json, {}); assert.equal(await readFile(record, 'utf8'), '');
});

test('Stop gate skips unchanged and atomically consumes exact changed baseline', async () => {
  const { cwd, data, env } = await workspace();
  await writeGateConfig(data, cwd, { enabled: true, setupReady: true });
  await runHook('session-lifecycle-hook.mjs', { session_id: 'parent', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
  const prompt = { session_id: 'parent', turn_id: 'turn-1', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'edit' };
  await runHook('user-prompt-hook.mjs', prompt, env);
  const unchanged = await runHook('stop-review-gate-hook.mjs', { session_id: 'parent', turn_id: 'turn-1', cwd, hook_event_name: 'Stop', transcript_path: null, model: 'gpt', permission_mode: 'default', stop_hook_active: false, last_assistant_message: 'done' }, env);
  assert.equal(unchanged.code, 0); assert.deepEqual(unchanged.json, {});
  await runHook('user-prompt-hook.mjs', { ...prompt, turn_id: 'turn-2' }, env);
  await writeFile(join(cwd, 'tracked.txt'), 'after\n');
  const wrong = await runHook('stop-review-gate-hook.mjs', { session_id: 'other', turn_id: 'turn-2', cwd, hook_event_name: 'Stop', transcript_path: null, model: 'gpt', permission_mode: 'default', stop_hook_active: false, last_assistant_message: 'done' }, env);
  assert.equal(wrong.code, 0); assert.deepEqual(wrong.json, {});
  const input = { session_id: 'parent', turn_id: 'turn-2', cwd, hook_event_name: 'Stop', transcript_path: null, model: 'gpt', permission_mode: 'default', stop_hook_active: false, last_assistant_message: 'done' };
  const [one, two] = await Promise.all([runHook('stop-review-gate-hook.mjs', input, { ...env, ZCODE_PATH: fakeZCode, FAKE_ZCODE_GATE_RESULT: 'ALLOW: clean' }), runHook('stop-review-gate-hook.mjs', input, { ...env, ZCODE_PATH: fakeZCode, FAKE_ZCODE_GATE_RESULT: 'ALLOW: clean' })]);
  assert.equal([one, two].filter((result) => result.json?.decision === 'block').length, 0);
  const snapshots = (await jsonFiles(join(data, 'workspaces'))).filter((path) => path.includes('/gate-runs/'));
  assert.equal(snapshots.length, 1);
});

test('Stop gate suppresses continuation/nested runs, fails open when setup is not ready, and conservatively blocks bad reviews', async (t) => {
  for (const [name, fake, extra, expected] of [['allow', 'ALLOW: looks good', {}, {}], ['block', 'BLOCK: fix issue', {}, { decision: 'block', reason: 'fix issue' }], ['empty', '__EMPTY__', {}, { decision: 'block' }], ['malformed', 'maybe', {}, { decision: 'block' }], ['failure', 'unused', { FAKE_ZCODE_ERROR: 'session/send' }, { decision: 'block' }], ['timeout', 'unused', { FAKE_ZCODE_SUPPRESS_FIRST_COMPLETION: '1' }, { decision: 'block' }]]) await t.test(name, async () => {
    const { cwd, data, env } = await workspace(); const record = join(data, 'zcode-calls.jsonl'); await writeFile(record, ''); await writeGateConfig(data, cwd, { enabled: true, setupReady: true });
    await runHook('session-lifecycle-hook.mjs', { session_id: 's', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
    const base = { session_id: 's', turn_id: 't', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'edit' };
    await runHook('user-prompt-hook.mjs', base, env); await writeFile(join(cwd, 'new.txt'), 'changed');
    const stop = stopFields(base);
    const script = name === 'timeout' ? join(root, 'tests/fixtures/stop-gate-with-timeout.mjs') : 'stop-review-gate-hook.mjs';
    const result = await runHook(script, { ...stop, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' }, { ...env, ZCODE_PATH: fakeZCode, FAKE_ZCODE_RECORD: record, FAKE_ZCODE_GATE_RESULT: fake, ...extra }, { absolute: name === 'timeout' });
    assert.equal(result.code, 0); if (expected.decision) assert.equal(result.json.decision, expected.decision); else assert.deepEqual(result.json, expected);
    if (expected.reason) assert.equal(result.json.reason, expected.reason); if (result.json.reason) assert.ok(result.json.reason.length <= 1000);
    if (name === 'failure' || name === 'timeout') {
      const calls = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      assert.ok(calls.some((call) => call.method === 'session/stop'), `${name} must stop its created review session`);
    }
  });
  const { cwd, data, env } = await workspace(); await writeGateConfig(data, cwd, { enabled: true, setupReady: false, reason: 'untrusted' });
  await runHook('session-lifecycle-hook.mjs', { session_id: 's', cwd, hook_event_name: 'SessionStart', transcript_path: null, model: 'gpt', permission_mode: 'default', source: 'startup' }, env);
  const base = { session_id: 's', turn_id: 't', cwd, hook_event_name: 'UserPromptSubmit', transcript_path: null, model: 'gpt', permission_mode: 'default', prompt: 'edit' };
  await runHook('user-prompt-hook.mjs', base, env); await writeFile(join(cwd, 'new.txt'), 'changed');
  const stop = stopFields(base);
  const notReady = await runHook('stop-review-gate-hook.mjs', { ...stop, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' }, env);
  assert.equal(notReady.code, 0); assert.notEqual(notReady.json.decision, 'block'); assert.match(notReady.json.systemMessage, /\$zcode:setup/);
});
