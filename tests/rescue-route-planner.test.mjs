// @ts-nocheck
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { planRescueActivation, validateRescueRouteDirective } from '../scripts/lib/rescue-route-planner.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');

async function context(overrides = {}) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'zpc-route-planner-')));
  const caller = { sessionId: 'parent-1', turnId: 'turn-new', workspace, originWorkspace: workspace, permissionMode: 'workspace-write', generationId: 'generation-new' };
  return { dataRoot: join(workspace, 'data'), caller, envelope: { version: 1, source: 'explicit', task: 'private task', options: { resume: 'fresh' } }, ...overrides };
}

function child(cwd, overrides = {}) {
  return { id: 'child-1', parentThreadId: 'parent-1', agentPath: '/root/zcode_rescue_task', agentRole: 'zcode-rescue', cwd, status: { type: 'notLoaded' }, createdAt: 100, updatedAt: 200, ...overrides };
}

function executor(workspace, overrides = {}) {
  return { active: false, agentId: 'child-1', agentType: 'zcode-rescue', childTurnId: 'child-turn', createdAt: '2026-08-20T00:00:00.000Z', kind: 'subagent-executor', originWorkspace: workspace, parentGenerationId: 'a'.repeat(64), parentPermissionMode: 'workspace-write', parentSessionId: 'parent-1', parentTurnId: 'turn-old', workspace, ...overrides };
}

function adapters(children, executors, bindings = new Map()) {
  return {
    listChildren: async (parentId) => { assert.equal(parentId, 'parent-1'); return children; },
    resolveStoppedExecutor: async (_dataRoot, origin, id) => {
      const found = executors.get(id);
      if (!found) throw Object.assign(new Error('secret missing identity'), { code: 'EXECUTOR_IDENTITY_NOT_FOUND' });
      assert.equal(origin, children.find((item) => item.id === id).cwd);
      return found;
    },
    resolveBinding: async ({ executor: found }) => bindings.get(found.agentId) ?? { kind: 'missing' },
  };
}

test('fresh planning joins a stopped root executor and returns the exact base followup activation', async () => {
  const input = await context(); const host = child(input.caller.workspace); const trusted = executor(input.caller.workspace);
  const planned = await planRescueActivation({ ...input, ...adapters([host], new Map([[host.id, { executor: trusted, executionWorkspace: input.caller.workspace }]])) });
  assert.deepEqual(planned, {
    activation: { kind: 'reactivate', executorAgentId: 'child-1', agentPathDigest: digest('/root/zcode_rescue_task') },
    directive: { version: 1, action: 'followup', target: '/root/zcode_rescue_task' },
  });
});

test('planning joins a stopped executor from its origin route into an immutable linked-worktree target', async () => {
  const origin = await realpath(await mkdtemp(join(tmpdir(), 'zpc-route-origin-')));
  const target = await realpath(await mkdtemp(join(tmpdir(), 'zpc-route-target-')));
  const input = await context({ caller: { sessionId: 'parent-1', turnId: 'new', workspace: target, originWorkspace: origin, permissionMode: 'workspace-write', generationId: 'new' } });
  const host = child(origin); const trusted = executor(target, { originWorkspace: origin });
  const planned = await planRescueActivation({ ...input, ...adapters([host], new Map([[host.id, { executor: trusted, executionWorkspace: target }]])) });
  assert.equal(planned.directive.action, 'followup'); assert.equal(planned.directive.target, host.agentPath);
});

test('resume selects only the exact eligible durable binding', async () => {
  const input = await context(); input.envelope.options.resume = 'resume';
  const older = child(input.caller.workspace); const exact = child(input.caller.workspace, { id: 'child-2', agentPath: '/root/zcode_rescue_task_2', createdAt: 200 });
  const values = new Map([[older.id, { executor: executor(input.caller.workspace), executionWorkspace: input.caller.workspace }], [exact.id, { executor: executor(input.caller.workspace, { agentId: exact.id }), executionWorkspace: input.caller.workspace }]]);
  const bindings = new Map([[exact.id, { kind: 'bound', binding: { executorAgentId: exact.id } }]]);
  const planned = await planRescueActivation({ ...input, ...adapters([older, exact], values, bindings) });
  assert.equal(planned.directive.target, exact.agentPath);
});

test('fresh prefers the managed base path and otherwise the deterministic newest compatible child', async () => {
  const input = await context(); const base = child(input.caller.workspace, { createdAt: 1 }); const newest = child(input.caller.workspace, { id: 'child-z', agentPath: '/root/ordinary_newest', createdAt: 300, updatedAt: 300 });
  const tiedLower = child(input.caller.workspace, { id: 'child-a', agentPath: '/root/ordinary_tied', createdAt: 300, updatedAt: 300 });
  const values = new Map([base, newest, tiedLower].map((host) => [host.id, { executor: executor(input.caller.workspace, { agentId: host.id }), executionWorkspace: input.caller.workspace }]));
  assert.equal((await planRescueActivation({ ...input, ...adapters([newest, base, tiedLower], values) })).directive.target, base.agentPath);
  values.delete(base.id);
  assert.equal((await planRescueActivation({ ...input, ...adapters([newest, tiedLower], values) })).directive.target, newest.agentPath);
});

test('unproved children remain occupied and spawn allocation chooses the first free bounded ordinal', async () => {
  const input = await context(); const occupied = [
    child(input.caller.workspace, { id: 'other-1' }),
    child(input.caller.workspace, { id: 'other-2', agentPath: '/root/zcode_rescue_task_2' }),
  ];
  const planned = await planRescueActivation({ ...input, ...adapters(occupied, new Map()) });
  assert.deepEqual(planned, {
    activation: { kind: 'spawn', taskName: 'zcode_rescue_task_3', agentPathDigest: digest('/root/zcode_rescue_task_3') },
    directive: { version: 1, action: 'spawn', taskName: 'zcode_rescue_task_3' },
  });
});

test('generic compatibility requires matching null host Role and qualified default executor provenance', async () => {
  const input = await context(); const host = child(input.caller.workspace, { agentRole: null });
  const trusted = executor(input.caller.workspace, { agentType: 'default' });
  assert.equal((await planRescueActivation({ ...input, ...adapters([host], new Map([[host.id, { executor: trusted, executionWorkspace: input.caller.workspace }]])) })).directive.action, 'followup');
});

test('wrong parent, Role, permission, or immutable workspace rejects without public metadata', async (t) => {
  const input = await context(); const secrets = ['child-secret', '/root/private_path', input.caller.workspace, 'secret-role'];
  const cases = [
    ['parent', child(input.caller.workspace, { id: 'child-secret', agentPath: '/root/private_path', parentThreadId: 'wrong-parent' }), executor(input.caller.workspace, { agentId: 'child-secret' }), 'CODEX_CHILD_METADATA_INVALID'],
    ['role', child(input.caller.workspace, { id: 'child-secret', agentPath: '/root/private_path', agentRole: 'secret-role' }), executor(input.caller.workspace, { agentId: 'child-secret' }), 'EXECUTOR_ROLE_UNAPPROVED'],
    ['permission', child(input.caller.workspace, { id: 'child-secret', agentPath: '/root/private_path' }), executor(input.caller.workspace, { agentId: 'child-secret', parentPermissionMode: 'read-only' }), 'EXECUTOR_IDENTITY_INVALID'],
    ['workspace', child(input.caller.workspace, { id: 'child-secret', agentPath: '/root/private_path' }), executor('/private/other', { agentId: 'child-secret', originWorkspace: input.caller.workspace }), 'EXECUTOR_ROUTE_INVALID'],
  ];
  for (const [name, badHost, badExecutor, code] of cases) await t.test(name, async () => {
    let caught; try { await planRescueActivation({ ...input, ...adapters([badHost], new Map([[badHost.id, { executor: badExecutor, executionWorkspace: badExecutor.workspace }]])) }); } catch (error) { caught = error; }
    assert.equal(caught?.code, code); const publicError = JSON.stringify({ code: caught.code, message: caught.message, remedy: caught.remedy, details: caught.details });
    for (const secret of secrets) assert.equal(publicError.includes(secret), false);
  });
});

test('duplicate IDs, duplicate paths, and multiple exact resume bindings fail as ambiguous', async () => {
  const input = await context(); const one = child(input.caller.workspace); const duplicateId = child(input.caller.workspace, { agentPath: '/root/other' }); const duplicatePath = child(input.caller.workspace, { id: 'child-2' });
  await assert.rejects(planRescueActivation({ ...input, ...adapters([one, duplicateId], new Map()) }), { code: 'RESCUE_CHILD_AMBIGUOUS' });
  await assert.rejects(planRescueActivation({ ...input, ...adapters([one, duplicatePath], new Map()) }), { code: 'RESCUE_CHILD_AMBIGUOUS' });
  input.envelope.options.resume = 'resume';
  const values = new Map([[one.id, { executor: executor(input.caller.workspace), executionWorkspace: input.caller.workspace }], [duplicatePath.id, { executor: executor(input.caller.workspace, { agentId: duplicatePath.id }), executionWorkspace: input.caller.workspace }]]);
  const bound = new Map([[one.id, { kind: 'bound' }], [duplicatePath.id, { kind: 'bound' }]]);
  await assert.rejects(planRescueActivation({ ...input, ...adapters([one, { ...duplicatePath, agentPath: '/root/zcode_rescue_task_2' }], values, bound) }), { code: 'RESCUE_CHILD_AMBIGUOUS' });
});

test('incomplete discovery fails closed and redacts adapter payloads', async () => {
  const input = await context();
  for (const listChildren of [async () => null, async () => { throw Object.assign(new Error('secret app-server payload'), { code: 'CODEX_THREAD_LIST_LIMIT' }); }]) {
    let caught; try { await planRescueActivation({ ...input, listChildren }); } catch (error) { caught = error; }
    assert.equal(caught?.code, 'CODEX_CHILD_DISCOVERY_FAILED'); assert.doesNotMatch(JSON.stringify(caught), /secret app-server payload|private task/);
  }
});

test('host discovery boundary rejects malformed exact SpawnChild records before followup or occupied allocation', async (t) => {
  const input = await context(); const valid = child(input.caller.workspace);
  const mutations = [
    ['extra key', (value) => ({ ...value, secret: true })],
    ['missing status', (value) => { const copy = { ...value }; delete copy.status; return copy; }],
    ['invalid status type', (value) => ({ ...value, status: { type: 'unknown' } })],
    ['status extra key', (value) => ({ ...value, status: { type: 'idle', extra: true } })],
    ['duplicate active flags', (value) => ({ ...value, status: { type: 'active', activeFlags: ['waitingOnApproval', 'waitingOnApproval'] } })],
    ['oversized ID', (value) => ({ ...value, id: 'i'.repeat(513) })],
    ['noncanonical agent path', (value) => ({ ...value, agentPath: '/root/../private' })],
    ['oversized Role', (value) => ({ ...value, agentRole: 'r'.repeat(257) })],
    ['relative cwd', (value) => ({ ...value, cwd: 'relative/workspace' })],
    ['noncanonical cwd', (value) => ({ ...value, cwd: `${input.caller.workspace}/../elsewhere` })],
    ['control-bearing cwd', (value) => ({ ...value, cwd: `${input.caller.workspace}\nsecret` })],
    ['negative created timestamp', (value) => ({ ...value, createdAt: -1 })],
    ['negative updated timestamp', (value) => ({ ...value, updatedAt: -1 })],
    ['non-integer timestamp', (value) => ({ ...value, createdAt: 1.5 })],
    ['unsafe timestamp', (value) => ({ ...value, updatedAt: Number.MAX_SAFE_INTEGER + 1 })],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    const malformed = mutate(valid);
    const proved = new Map([[valid.id, { executor: executor(input.caller.workspace), executionWorkspace: input.caller.workspace }]]);
    await assert.rejects(planRescueActivation({ ...input, ...adapters([malformed], proved) }), { code: 'CODEX_CHILD_METADATA_INVALID' });
    await assert.rejects(planRescueActivation({ ...input, ...adapters([malformed], new Map()) }), { code: 'CODEX_CHILD_METADATA_INVALID' });
  });
});

test('independent nonnegative host timestamps allow updatedAt before createdAt and selection uses createdAt', async () => {
  const input = await context();
  const newest = child(input.caller.workspace, { id: 'child-z', agentPath: '/root/ordinary_newest', createdAt: 300, updatedAt: 1 });
  const older = child(input.caller.workspace, { id: 'child-a', agentPath: '/root/ordinary_older', createdAt: 200, updatedAt: 500 });
  const values = new Map([newest, older].map((host) => [host.id, { executor: executor(input.caller.workspace, { agentId: host.id }), executionWorkspace: input.caller.workspace }]));
  const planned = await planRescueActivation({ ...input, ...adapters([older, newest], values) });
  assert.equal(planned.directive.target, newest.agentPath);
});

test('stopped executor proof boundary rejects partial, extra, or structurally invalid provenance', async (t) => {
  const input = await context(); const host = child(input.caller.workspace); const valid = executor(input.caller.workspace);
  const mutations = [
    ['extra result key', (proof) => ({ ...proof, extra: true })],
    ['missing executor field', (proof) => { const partial = { ...proof.executor }; delete partial.childTurnId; return { ...proof, executor: partial }; }],
    ['extra executor field', (proof) => ({ ...proof, executor: { ...proof.executor, secret: true } })],
    ['bad kind', (proof) => ({ ...proof, executor: { ...proof.executor, kind: 'executor' } })],
    ['active executor', (proof) => ({ ...proof, executor: { ...proof.executor, active: true } })],
    ['oversized child ID', (proof) => ({ ...proof, executor: { ...proof.executor, agentId: 'i'.repeat(513) } })],
    ['bad timestamp', (proof) => ({ ...proof, executor: { ...proof.executor, createdAt: '2026-08-20' } })],
    ['bad child turn', (proof) => ({ ...proof, executor: { ...proof.executor, childTurnId: 'bad\nturn' } })],
    ['bad parent turn', (proof) => ({ ...proof, executor: { ...proof.executor, parentTurnId: '' } })],
    ['bad generation', (proof) => ({ ...proof, executor: { ...proof.executor, parentGenerationId: 'generation-old' } })],
    ['control-bearing workspace', (proof) => ({ ...proof, executor: { ...proof.executor, workspace: `${input.caller.workspace}\nsecret` } })],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    const proof = mutate({ executor: valid, executionWorkspace: input.caller.workspace });
    await assert.rejects(planRescueActivation({
      ...input, ...adapters([host], new Map([[host.id, proof]])),
    }), { code: 'EXECUTOR_IDENTITY_INVALID' });
  });
});

test('route directives accept only exact bounded task-free keys', () => {
  const followup = { version: 1, action: 'followup', target: '/root/zcode_rescue_task' };
  const spawn = { version: 1, action: 'spawn', taskName: 'zcode_rescue_task_2' };
  assert.deepEqual(validateRescueRouteDirective(followup), followup);
  assert.deepEqual(validateRescueRouteDirective(spawn), spawn);
  for (const invalid of [
    { ...followup, childId: 'secret' }, { ...followup, target: '/root' }, { ...followup, target: '/root/../bad' },
    { ...spawn, target: '/root/zcode_rescue_task_2' }, { ...spawn, taskName: 'zcode_rescue_task_1' },
    { version: 2, action: 'spawn', taskName: 'zcode_rescue_task' }, null,
  ]) assert.throws(() => validateRescueRouteDirective(invalid), { code: 'RESCUE_ROUTE_INVALID' });
});
