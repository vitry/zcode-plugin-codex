// @ts-nocheck
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { planRescueActivation, validateRescueRouteDirective } from '../scripts/lib/rescue-route-planner.mjs';
import { rescueBindingKey } from '../scripts/lib/rescue-binding.mjs';
import { PluginError } from '../scripts/lib/errors.mjs';

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

function adoptionBinding(input, host, overrides = {}) {
  const authority = {
    kind: 'codex-legacy-adoption',
    authorityId: 'c'.repeat(64),
    childAgentId: host.id,
    childAgentType: 'zcode-rescue',
    authorizingParentTurnId: 'turn-adopted',
    authorizingParentGenerationId: 'd'.repeat(64),
    authorizingPermissionMode: input.caller.permissionMode,
    originWorkspace: input.caller.originWorkspace,
    executionWorkspace: input.caller.workspace,
    agentPathDigest: digest(host.agentPath),
    ...overrides.childAuthority,
  };
  const binding = {
    version: 2,
    key: rescueBindingKey({ parentSessionId: input.caller.sessionId, executorAgentId: host.id, workspace: input.caller.workspace }),
    operationId: 'e'.repeat(64),
    state: 'active',
    parentSessionId: input.caller.sessionId,
    childAuthority: authority,
    workspace: input.caller.workspace,
    permissionMode: input.caller.permissionMode,
    anchorJobId: 'f'.repeat(64),
    currentJobId: '1'.repeat(64),
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    closedAt: null,
    closeReason: null,
    ...overrides,
  };
  binding.childAuthority = authority;
  return binding;
}

function modernBinding(input, host, overrides = {}) {
  const authority = {
    kind: 'subagent-start', childAgentId: host.id, childAgentType: 'zcode-rescue',
    parentTurnId: 'turn-old', parentPermissionMode: input.caller.permissionMode,
    agentPath: host.agentPath,
    ...overrides.childAuthority,
  };
  const binding = {
    version: 3,
    key: rescueBindingKey({ parentSessionId: input.caller.sessionId, executorAgentId: host.id, workspace: input.caller.workspace }),
    operationId: '7'.repeat(64), state: 'active', parentSessionId: input.caller.sessionId,
    childAuthority: authority, workspace: input.caller.workspace, permissionMode: input.caller.permissionMode,
    anchorJobId: '8'.repeat(64), currentJobId: '8'.repeat(64), superseded: [],
    createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
    closedAt: null, closeReason: null, ...overrides,
  };
  binding.childAuthority = authority;
  return binding;
}

function legacyHookBinding(input, host, version = 1, overrides = {}) {
  const modern = modernBinding(input, host);
  const common = {
    version,
    key: modern.key,
    operationId: modern.operationId,
    state: 'closed',
    parentSessionId: modern.parentSessionId,
    workspace: modern.workspace,
    permissionMode: modern.permissionMode,
    anchorJobId: modern.anchorJobId,
    currentJobId: modern.currentJobId,
    createdAt: modern.createdAt,
    updatedAt: '2026-08-20T01:00:00.000Z',
    closedAt: '2026-08-20T01:00:00.000Z',
    closeReason: 'session-ended',
    ...overrides,
  };
  if (version === 1) return {
    ...common,
    executorAgentId: host.id,
    executorAgentType: 'zcode-rescue',
    executorParentTurnId: 'turn-old',
    executorParentPermissionMode: input.caller.permissionMode,
  };
  return {
    ...common,
    childAuthority: {
      kind: 'subagent-start',
      childAgentId: host.id,
      childAgentType: 'zcode-rescue',
      parentTurnId: 'turn-old',
      parentPermissionMode: input.caller.permissionMode,
      ...overrides.childAuthority,
    },
  };
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
    resolveBinding: async ({ executor: found, host }) => bindings.get(found?.agentId ?? host.id) ?? { kind: 'missing' },
  };
}

test('fresh treats stopped, resumable, completed, bound, and notLoaded children as occupancy and spawns the first free child', async () => {
  const input = await context();
  const hosts = [
    child(input.caller.workspace, { id: 'stopped', status: { type: 'idle' } }),
    child(input.caller.workspace, { id: 'resumable', agentPath: '/root/zcode_rescue_task_2', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } }),
    child(input.caller.workspace, { id: 'completed', agentPath: '/root/completed_child', agentRole: 'default', status: { type: 'idle' } }),
    child(input.caller.workspace, { id: 'bound', agentPath: '/root/bound_child', status: { type: 'systemError' } }),
    child(input.caller.workspace, { id: 'not-loaded', agentPath: '/root/not_loaded_child' }),
  ];
  let executorReads = 0; let bindingReads = 0;
  const planned = await planRescueActivation({ ...input, listChildren: async () => hosts,
    resolveStoppedExecutor: async () => { executorReads += 1; throw new Error('must not inspect old executor'); },
    resolveBinding: async () => { bindingReads += 1; throw new Error('must not inspect old binding'); } });
  assert.deepEqual(planned, {
    activation: { kind: 'spawn', taskName: 'zcode_rescue_task_3', agentPathDigest: digest('/root/zcode_rescue_task_3') },
    directive: { version: 1, action: 'spawn', taskName: 'zcode_rescue_task_3' },
  });
  assert.equal(executorReads, 0); assert.equal(bindingReads, 0);
});

test('resume rejoins an unloaded modern Hook binding from the persisted child graph after executor loss', async () => {
  const input = await context(); input.envelope.options.resume = 'resume';
  const host = child(input.caller.workspace); const binding = modernBinding(input, host);
  const planned = await planRescueActivation({ ...input, ...adapters([host], new Map(), new Map([[host.id, { kind: 'bound', binding }]])) });
  assert.deepEqual(planned, {
    activation: { kind: 'reactivate', executorAgentId: host.id, agentPathDigest: digest(host.agentPath) },
    directive: { version: 2, action: 'followup', target: host.agentPath, assignment: 'zcode-rescue' },
  });
});

test('resume rejoins an unloaded historical v1 Hook tombstone after exact child-graph migration proof', async () => {
  const input = await context(); input.envelope.options.resume = 'resume';
  const host = child(input.caller.workspace); const modern = modernBinding(input, host);
  const binding = {
    version: 1, key: modern.key, operationId: modern.operationId, state: 'closed',
    parentSessionId: modern.parentSessionId, executorAgentId: host.id, executorAgentType: 'zcode-rescue',
    executorParentTurnId: 'turn-old', executorParentPermissionMode: input.caller.permissionMode,
    workspace: modern.workspace, permissionMode: modern.permissionMode, anchorJobId: modern.anchorJobId,
    currentJobId: modern.currentJobId, createdAt: modern.createdAt, updatedAt: '2026-08-20T01:00:00.000Z',
    closedAt: '2026-08-20T01:00:00.000Z', closeReason: 'session-ended',
  };
  const planned = await planRescueActivation({ ...input,
    ...adapters([host], new Map(), new Map([[host.id, { kind: 'bound', binding }]])) });
  assert.deepEqual(planned, {
    activation: { kind: 'reactivate', executorAgentId: host.id, agentPathDigest: digest(host.agentPath) },
    directive: { version: 2, action: 'followup', target: host.agentPath, assignment: 'zcode-rescue' },
  });
});

test('resume permits a resident exact modern child without requiring a stopped executor record', async () => {
  const input = await context(); input.envelope.options.resume = 'resume';
  const host = child(input.caller.workspace, { status: { type: 'active', activeFlags: [] } });
  const resident = executor(input.caller.workspace, { active: true });
  const binding = modernBinding(input, host);
  const planned = await planRescueActivation({ ...input, ...adapters([host], new Map([[host.id, { executor: resident, executionWorkspace: input.caller.workspace }]]), new Map([[host.id, { kind: 'bound', binding }]])) });
  assert.equal(planned.directive.action, 'followup');
  assert.equal(planned.directive.target, host.agentPath);
});

test('modern Hook binding path mismatch fails closed without legacy downgrade or replacement spawn', async () => {
  const input = await context(); input.envelope.options.resume = 'resume';
  const host = child(input.caller.workspace);
  const binding = modernBinding(input, host, { childAuthority: { agentPath: '/root/zcode_rescue_task_2' } });
  await assert.rejects(planRescueActivation({ ...input, ...adapters([host], new Map(), new Map([[host.id, { kind: 'bound', binding }]])) }),
    { code: 'RESCUE_BINDING_INVALID' });
});

test('resume joins a stopped executor from its origin route into an immutable linked-worktree target', async () => {
  const origin = await realpath(await mkdtemp(join(tmpdir(), 'zpc-route-origin-')));
  const target = await realpath(await mkdtemp(join(tmpdir(), 'zpc-route-target-')));
  const input = await context({ caller: { sessionId: 'parent-1', turnId: 'new', workspace: target, originWorkspace: origin, permissionMode: 'workspace-write', generationId: 'new' } });
  input.envelope.options.resume = 'resume';
  const host = child(origin); const trusted = executor(target, { originWorkspace: origin });
  const planned = await planRescueActivation({ ...input, ...adapters([host], new Map([[host.id, { executor: trusted, executionWorkspace: target }]]), new Map([[host.id, { kind: 'bound', binding: { key: 'a'.repeat(64) } }]])) });
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

test('fresh never prefers a base or newest compatible child', async () => {
  const input = await context(); const base = child(input.caller.workspace, { createdAt: 1 }); const newest = child(input.caller.workspace, { id: 'child-z', agentPath: '/root/zcode_rescue_task_3', createdAt: 300, updatedAt: 300 });
  const tiedLower = child(input.caller.workspace, { id: 'child-a', agentPath: '/root/zcode_rescue_task_2', createdAt: 300, updatedAt: 300 });
  const values = new Map([base, newest, tiedLower].map((host) => [host.id, { executor: executor(input.caller.workspace, { agentId: host.id }), executionWorkspace: input.caller.workspace }]));
  assert.deepEqual((await planRescueActivation({ ...input, ...adapters([newest, base, tiedLower], values) })).directive,
    { version: 1, action: 'spawn', taskName: 'zcode_rescue_task_4' });
});

test('unproved children remain occupied and spawn allocation chooses the first free bounded ordinal', async () => {
  const input = await context(); const occupied = [
    child(input.caller.workspace, { id: 'other-1', agentRole: 'default' }),
    child(input.caller.workspace, { id: 'other-2', agentPath: '/root/zcode_rescue_task_2', agentRole: 'explorer' }),
  ];
  const planned = await planRescueActivation({ ...input, ...adapters(occupied, new Map()) });
  assert.deepEqual(planned, {
    activation: { kind: 'spawn', taskName: 'zcode_rescue_task_3', agentPathDigest: digest('/root/zcode_rescue_task_3') },
    directive: { version: 1, action: 'spawn', taskName: 'zcode_rescue_task_3' },
  });
});

test('fresh treats a qualified generic compatibility child as occupancy only', async () => {
  const input = await context(); const host = child(input.caller.workspace, { agentRole: null });
  const trusted = executor(input.caller.workspace, { agentType: 'default' });
  assert.deepEqual((await planRescueActivation({ ...input, ...adapters([host], new Map([[host.id, { executor: trusted, executionWorkspace: input.caller.workspace }]])) })).directive,
    { version: 1, action: 'spawn', taskName: 'zcode_rescue_task_2' });
});

test('managed candidates reject mismatched qualified executor Role instead of downgrading', async () => {
  const input = await context(); input.envelope.options.resume = 'resume'; const host = child(input.caller.workspace);
  const wrongRole = executor(input.caller.workspace, { agentType: 'default' });
  await assert.rejects(planRescueActivation({
    ...input, ...adapters([host], new Map([[host.id, { executor: wrongRole, executionWorkspace: input.caller.workspace }]])),
  }), { code: 'EXECUTOR_ROLE_UNAPPROVED' });
});

test('ordinary persisted children are occupancy-only and cannot block exact bound Rescue resume', async () => {
  const input = await context(); input.envelope.options.resume = 'resume';
  const ordinaryDefault = child(input.caller.workspace, { id: 'ordinary-default', agentPath: '/root/t1_spec_review', agentRole: 'default', createdAt: 400 });
  const ordinaryExplorer = child(input.caller.workspace, { id: 'ordinary-explorer', agentPath: '/root/plan_audit', agentRole: 'explorer', createdAt: 300 });
  const legacyBase = child(input.caller.workspace, { id: 'legacy-base', createdAt: 200 });
  const boundOrdinal = child(input.caller.workspace, { id: 'bound-ordinal', agentPath: '/root/zcode_rescue_task_2', createdAt: 100 });
  const resolvedIds = [];
  const planned = await planRescueActivation({
    ...input,
    listChildren: async () => [ordinaryDefault, ordinaryExplorer, legacyBase, boundOrdinal],
    resolveStoppedExecutor: async (_dataRoot, _origin, id) => {
      resolvedIds.push(id);
      if (id === legacyBase.id) throw Object.assign(new Error('missing'), { code: 'EXECUTOR_IDENTITY_NOT_FOUND' });
      return { executor: executor(input.caller.workspace, { agentId: id }), executionWorkspace: input.caller.workspace };
    },
    resolveBinding: async ({ host }) => host.id === boundOrdinal.id
      ? { kind: 'bound', binding: { key: 'b'.repeat(64) } }
      : { kind: 'missing' },
  });
  assert.deepEqual(resolvedIds, ['legacy-base', 'bound-ordinal']);
  assert.deepEqual(planned, {
    activation: { kind: 'reactivate', executorAgentId: 'bound-ordinal', agentPathDigest: digest('/root/zcode_rescue_task_2') },
    directive: { version: 2, action: 'followup', target: '/root/zcode_rescue_task_2', assignment: 'zcode-rescue' },
  });
});

test('fresh host-only named Rescue child occupies its name without adoption', async () => {
  const input = await context(); const legacy = child(input.caller.workspace, { id: 'legacy-base' });
  const planned = await planRescueActivation({ ...input, ...adapters([legacy], new Map()) });
  assert.deepEqual(planned, {
    activation: { kind: 'spawn', taskName: 'zcode_rescue_task_2', agentPathDigest: digest('/root/zcode_rescue_task_2') },
    directive: { version: 1, action: 'spawn', taskName: 'zcode_rescue_task_2' },
  });
});

test('fresh generic and ordinary host-only children are occupancy without executor reads', async () => {
  const input = await context();
  const hosts = [
    child(input.caller.workspace, { id: 'generic', agentRole: null }),
    child(input.caller.workspace, { id: 'default', agentPath: '/root/zcode_rescue_task_2', agentRole: 'default' }),
    child(input.caller.workspace, { id: 'explorer', agentPath: '/root/zcode_rescue_task_3', agentRole: 'explorer' }),
    child(input.caller.workspace, { id: 'ordinary', agentPath: '/root/unmanaged', agentRole: 'zcode-rescue' }),
  ];
  const resolved = [];
  const planned = await planRescueActivation({
    ...input,
    listChildren: async () => hosts,
    resolveStoppedExecutor: async (_dataRoot, _cwd, id) => { resolved.push(id); throw Object.assign(new Error('missing'), { code: 'EXECUTOR_IDENTITY_NOT_FOUND' }); },
  });
  assert.deepEqual(resolved, []);
  assert.equal(planned.directive.action, 'spawn');
  assert.equal(planned.directive.taskName, 'zcode_rescue_task_4');
});

test('fresh active host-only named Rescue child is occupancy only', async () => {
  const input = await context(); const active = child(input.caller.workspace, { status: { type: 'active', activeFlags: [] } });
  assert.equal((await planRescueActivation({ ...input, ...adapters([active], new Map()) })).directive.taskName, 'zcode_rescue_task_2');
});

test('named legacy adoption downgrades only exact executor identity not found', async (t) => {
  const input = await context(); input.envelope.options.resume = 'resume'; const host = child(input.caller.workspace);
  for (const code of ['EXECUTOR_IDENTITY_EXPIRED', 'EXECUTOR_STATE_MISMATCH', 'EXECUTOR_IDENTITY_AMBIGUOUS', 'EXECUTOR_IDENTITY_INVALID', 'EXECUTOR_ROUTE_INVALID', 'EXECUTOR_ROLE_UNAPPROVED']) {
    await t.test(code, async () => {
      await assert.rejects(planRescueActivation({
        ...input,
        listChildren: async () => [host],
        resolveStoppedExecutor: async () => { throw Object.assign(new Error('private'), { code }); },
      }), { code });
    });
  }
});

test('fresh never lets executor proof outrank occupied names', async () => {
  const input = await context();
  const legacyBase = child(input.caller.workspace, { id: 'legacy-base', createdAt: 300 });
  const proved = child(input.caller.workspace, { id: 'proved', agentPath: '/root/zcode_rescue_task_2', createdAt: 100 });
  const planned = await planRescueActivation({ ...input, ...adapters([legacyBase, proved], new Map([
    [proved.id, { executor: executor(input.caller.workspace, { agentId: proved.id }), executionWorkspace: input.caller.workspace }],
  ])) });
  assert.equal(planned.directive.taskName, 'zcode_rescue_task_3');
  assert.equal(planned.activation.kind, 'spawn');
});

test('resume ignores an unbound base distractor and selects the sole exact legacy task_2 binding by eligibility', async () => {
  const input = await context(); input.envelope.options.resume = 'resume';
  const base = child(input.caller.workspace, { id: 'legacy-base' });
  const exact = child(input.caller.workspace, { id: 'legacy-exact', agentPath: '/root/zcode_rescue_task_2' });
  const binding = legacyHookBinding(input, exact, 1);
  const planned = await planRescueActivation({ ...input,
    ...adapters([base, exact], new Map(), new Map([[exact.id, { kind: 'bound', binding }]])) });
  assert.deepEqual(planned, {
    activation: { kind: 'reactivate', executorAgentId: exact.id, agentPathDigest: digest(exact.agentPath) },
    directive: { version: 2, action: 'followup', target: exact.agentPath, assignment: 'zcode-rescue' },
  });
});

test('resume rejects a host-only child instead of adopting it or spawning a replacement', async () => {
  const input = await context(); input.envelope.options.resume = 'resume';
  const legacy = child(input.caller.workspace, { id: 'legacy-base' });
  await assert.rejects(planRescueActivation({ ...input, ...adapters([legacy], new Map()) }),
    { code: 'RESCUE_BINDING_INVALID' });
});

test('legacy migration planning accepts only exact notLoaded v1/v2 evidence and rejects mismatches', async (t) => {
  const input = await context(); input.envelope.options.resume = 'resume';
  const legacy = child(input.caller.workspace, { id: 'legacy-exact', agentPath: '/root/zcode_rescue_task_2' });
  for (const version of [1, 2]) {
    const planned = await planRescueActivation({ ...input,
      ...adapters([legacy], new Map(), new Map([[legacy.id, { kind: 'bound', binding: legacyHookBinding(input, legacy, version) }]])) });
    assert.equal(planned.directive.target, legacy.agentPath);
  }
  const exact = legacyHookBinding(input, legacy, 2);
  const mutations = [
    ['wrong parent', () => ({ ...exact, parentSessionId: 'other-parent' })],
    ['wrong binding key', () => ({ ...exact, key: '8'.repeat(64) })],
    ['wrong child', () => ({ ...exact, childAuthority: { ...exact.childAuthority, childAgentId: 'other-child' } })],
    ['wrong Role', () => ({ ...exact, childAuthority: { ...exact.childAuthority, childAgentType: 'default' } })],
    ['wrong top-level workspace', () => ({ ...exact, workspace: '/private/other' })],
    ['active legacy binding', () => ({ ...exact, state: 'active', closedAt: null, closeReason: null })],
    ['revoked target', () => ({ ...exact, closeReason: 'invalidated' })],
    ['closed v3 migration target', () => ({ ...modernBinding(input, legacy), state: 'closed',
      updatedAt: exact.updatedAt, closedAt: exact.closedAt, closeReason: 'session-ended' })],
    ['noncanonical timestamp', () => ({ ...exact, updatedAt: '2026-08-20' })],
    ['normalized invalid calendar timestamp', () => ({ ...exact, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-30T00:00:00.000Z' })],
    ['top-level unknown field', () => ({ ...exact, unknown: true })],
    ['top-level missing field', () => { const value = { ...exact }; delete value.operationId; return value; }],
    ['authority unknown field', () => ({ ...exact, childAuthority: { ...exact.childAuthority, unknown: true } })],
    ['authority missing field', () => { const authority = { ...exact.childAuthority }; delete authority.parentTurnId; return { ...exact, childAuthority: authority }; }],
    ['wrong authority version', () => ({ ...exact, childAuthority: { ...exact.childAuthority, kind: 'codex-legacy-continuation' } })],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    await assert.rejects(planRescueActivation({
      ...input,
      ...adapters([legacy], new Map(), new Map([[legacy.id, { kind: 'bound', binding: mutate() }]])),
    }), { code: 'RESCUE_BINDING_INVALID' });
  });
  for (const status of [{ type: 'idle' }, { type: 'systemError' }]) await t.test(`rejects ${status.type} observation`, async () => {
    const observed = { ...legacy, status };
    await assert.rejects(planRescueActivation({ ...input,
      ...adapters([observed], new Map(), new Map([[observed.id, { kind: 'bound', binding: exact }]])) }),
    { code: 'EXECUTOR_STATE_MISMATCH' });
  });
});

test('fresh ignores multiple exact adoption bindings and allocates after them', async () => {
  const input = await context();
  const base = child(input.caller.workspace, { id: 'legacy-base' });
  const ordinal = child(input.caller.workspace, { id: 'legacy-ordinal', agentPath: '/root/zcode_rescue_task_2' });
  const bindings = new Map([
    [base.id, { kind: 'bound', binding: adoptionBinding(input, base) }],
    [ordinal.id, { kind: 'bound', binding: adoptionBinding(input, ordinal) }],
  ]);
  const planned = await planRescueActivation({ ...input, ...adapters([ordinal, base], new Map(), bindings) });
  assert.equal(planned.activation.kind, 'spawn');
  assert.equal(planned.directive.taskName, 'zcode_rescue_task_3');
});

test('fresh does not rank multiple exact adoption bindings by newest', async () => {
  const input = await context();
  const older = child(input.caller.workspace, { id: 'legacy-older', agentPath: '/root/zcode_rescue_task_2', createdAt: 100 });
  const newest = child(input.caller.workspace, { id: 'legacy-newest', agentPath: '/root/zcode_rescue_task_3', createdAt: 300 });
  const bindings = new Map([
    [older.id, { kind: 'bound', binding: adoptionBinding(input, older) }],
    [newest.id, { kind: 'bound', binding: adoptionBinding(input, newest) }],
  ]);
  const planned = await planRescueActivation({ ...input, ...adapters([older, newest], new Map(), bindings) });
  assert.equal(planned.activation.kind, 'spawn');
  assert.equal(planned.directive.taskName, 'zcode_rescue_task');
});

test('fresh does not replace a legacy-bound permission snapshot while resume remains exact', async () => {
  const input = await context();
  input.caller.permissionMode = 'read-only';
  const legacy = child(input.caller.workspace, { id: 'legacy-base' });
  const original = structuredClone(input); original.caller.permissionMode = 'workspace-write';
  const binding = adoptionBinding(original, legacy);
  const route = { ...input, ...adapters([legacy], new Map(), new Map([[legacy.id, { kind: 'bound', binding }]])) };
  const planned = await planRescueActivation(route);
  assert.equal(planned.activation.kind, 'spawn');
  assert.equal(planned.directive.taskName, 'zcode_rescue_task_2');
  input.envelope.options.resume = 'resume';
  await assert.rejects(planRescueActivation(route), { code: 'RESCUE_BINDING_INVALID' });
});

test('fresh proven and adopted children all remain occupancy only', async () => {
  const input = await context();
  const proved = child(input.caller.workspace, { id: 'proved', agentPath: '/root/zcode_rescue_task_3', createdAt: 50 });
  const legacyBase = child(input.caller.workspace, { id: 'legacy-base', createdAt: 300 });
  const legacyOrdinal = child(input.caller.workspace, { id: 'legacy-ordinal', agentPath: '/root/zcode_rescue_task_2', createdAt: 200 });
  const executors = new Map([
    [proved.id, { executor: executor(input.caller.workspace, { agentId: proved.id }), executionWorkspace: input.caller.workspace }],
  ]);
  const bindings = new Map([
    [legacyBase.id, { kind: 'bound', binding: adoptionBinding(input, legacyBase) }],
    [legacyOrdinal.id, { kind: 'bound', binding: adoptionBinding(input, legacyOrdinal) }],
  ]);
  const planned = await planRescueActivation({ ...input, ...adapters([legacyBase, legacyOrdinal, proved], executors, bindings) });
  assert.equal(planned.activation.kind, 'spawn'); assert.equal(planned.directive.taskName, 'zcode_rescue_task_4');
});

test('wrong parent, permission, or immutable workspace rejects without public metadata', async (t) => {
  const input = await context(); input.envelope.options.resume = 'resume'; const secrets = ['child-secret', '/root/private_path', input.caller.workspace, 'secret-role'];
  const cases = [
    ['parent', child(input.caller.workspace, { id: 'child-secret', agentPath: '/root/private_path', parentThreadId: 'wrong-parent' }), executor(input.caller.workspace, { agentId: 'child-secret' }), 'CODEX_CHILD_METADATA_INVALID'],
    ['permission', child(input.caller.workspace, { id: 'child-secret', agentPath: '/root/zcode_rescue_task_9' }), executor(input.caller.workspace, { agentId: 'child-secret', parentPermissionMode: 'read-only' }), 'EXECUTOR_IDENTITY_INVALID'],
    ['workspace', child(input.caller.workspace, { id: 'child-secret', agentPath: '/root/zcode_rescue_task_9' }), executor('/private/other', { agentId: 'child-secret', originWorkspace: input.caller.workspace }), 'EXECUTOR_ROUTE_INVALID'],
  ];
  for (const [name, badHost, badExecutor, code] of cases) await t.test(name, async () => {
    let caught; try { await planRescueActivation({ ...input, ...adapters([badHost], new Map([[badHost.id, { executor: badExecutor, executionWorkspace: badExecutor.workspace }]])) }); } catch (error) { caught = error; }
    assert.equal(caught?.code, code); const publicError = JSON.stringify({ code: caught.code, message: caught.message, remedy: caught.remedy, details: caught.details });
    for (const secret of secrets) assert.equal(publicError.includes(secret), false);
  });
});

test('duplicate IDs, duplicate paths, and two usable resume bindings fail as ambiguous even when one looks ambient', async () => {
  const input = await context(); const one = child(input.caller.workspace); const duplicateId = child(input.caller.workspace, { agentPath: '/root/other' }); const duplicatePath = child(input.caller.workspace, { id: 'child-2' });
  await assert.rejects(planRescueActivation({ ...input, ...adapters([one, duplicateId], new Map()) }), { code: 'RESCUE_CHILD_AMBIGUOUS' });
  await assert.rejects(planRescueActivation({ ...input, ...adapters([one, duplicatePath], new Map()) }), { code: 'RESCUE_CHILD_AMBIGUOUS' });
  input.envelope.options.resume = 'resume';
  const values = new Map([[one.id, { executor: executor(input.caller.workspace), executionWorkspace: input.caller.workspace }], [duplicatePath.id, { executor: executor(input.caller.workspace, { agentId: duplicatePath.id }), executionWorkspace: input.caller.workspace }]]);
  const bound = new Map([[one.id, { kind: 'bound', binding: { key: 'a'.repeat(64) } }], [duplicatePath.id, { kind: 'bound', binding: { key: 'b'.repeat(64) } }]]);
  await assert.rejects(planRescueActivation({ ...input, ...adapters([one, { ...duplicatePath, agentPath: '/root/zcode_rescue_task_2', status: { type: 'active', activeFlags: [] } }], values, bound) }), { code: 'RESCUE_CHILD_AMBIGUOUS' });
});

test('two usable bindings without an explicit choice are ambiguous instead of preferring base or time', async () => {
  const input = await context(); input.envelope.options = {};
  const base = child(input.caller.workspace);
  const newer = child(input.caller.workspace, { id: 'child-2', agentPath: '/root/zcode_rescue_task_2', createdAt: 300, updatedAt: 400 });
  const values = new Map([
    [base.id, { executor: executor(input.caller.workspace), executionWorkspace: input.caller.workspace }],
    [newer.id, { executor: executor(input.caller.workspace, { agentId: newer.id, createdAt: '2026-08-21T00:00:00.000Z' }), executionWorkspace: input.caller.workspace }],
  ]);
  const bindings = new Map([
    [base.id, { kind: 'bound', binding: modernBinding(input, base) }],
    [newer.id, { kind: 'bound', binding: modernBinding(input, newer, { operationId: '9'.repeat(64), anchorJobId: 'a'.repeat(64), currentJobId: 'a'.repeat(64) }) }],
  ]);
  await assert.rejects(planRescueActivation({ ...input, ...adapters([base, newer], values, bindings) }), { code: 'RESCUE_CHILD_AMBIGUOUS' });
});

test('incomplete discovery fails closed and redacts adapter payloads', async () => {
  const input = await context();
  for (const listChildren of [
    async () => null,
    async () => { throw Object.assign(new Error('secret app-server payload'), { code: 'CODEX_THREAD_LIST_LIMIT' }); },
    async () => { throw { code: 'JOB_INTERRUPTED', category: 'interruption', message: 'secret lookalike interruption', details: { token: 'private-token' }, cause: new Error('private-cause') }; },
  ]) {
    let caught; try { await planRescueActivation({ ...input, listChildren }); } catch (error) { caught = error; }
    assert.equal(caught?.code, 'CODEX_CHILD_DISCOVERY_FAILED');
    const chain = `${caught?.stack}\n${JSON.stringify(caught)}\n${String(caught?.cause ?? '')}`;
    assert.doesNotMatch(chain, /secret app-server payload|private task|secret lookalike interruption|private-token|private-cause/);
  }
});

test('trusted discovery interruption preserves the exact PluginError', async () => {
  const input = await context();
  const interruption = new PluginError('JOB_INTERRUPTED', 'Trusted interruption.', { category: 'interruption', remedy: 'Retry.' });
  await assert.rejects(planRescueActivation({ ...input, listChildren: async () => { throw interruption; } }), (error) => error === interruption);
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

test('independent nonnegative host timestamps do not influence fresh allocation', async () => {
  const input = await context();
  const newest = child(input.caller.workspace, { id: 'child-z', agentPath: '/root/zcode_rescue_task_3', createdAt: 300, updatedAt: 1 });
  const older = child(input.caller.workspace, { id: 'child-a', agentPath: '/root/zcode_rescue_task_2', createdAt: 200, updatedAt: 500 });
  const values = new Map([newest, older].map((host) => [host.id, { executor: executor(input.caller.workspace, { agentId: host.id }), executionWorkspace: input.caller.workspace }]));
  const planned = await planRescueActivation({ ...input, ...adapters([older, newest], values) });
  assert.equal(planned.directive.taskName, 'zcode_rescue_task');
});

test('stopped executor proof boundary rejects partial, extra, or structurally invalid provenance', async (t) => {
  const input = await context(); input.envelope.options.resume = 'resume'; const host = child(input.caller.workspace); const valid = executor(input.caller.workspace);
  const mutations = [
    ['extra result key', (proof) => ({ ...proof, extra: true })],
    ['missing executor field', (proof) => { const partial = { ...proof.executor }; delete partial.childTurnId; return { ...proof, executor: partial }; }],
    ['extra executor field', (proof) => ({ ...proof, executor: { ...proof.executor, secret: true } })],
    ['bad kind', (proof) => ({ ...proof, executor: { ...proof.executor, kind: 'executor' } })],
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
  const followup = { version: 2, action: 'followup', target: '/root/zcode_rescue_task', assignment: 'zcode-rescue' };
  const spawn = { version: 1, action: 'spawn', taskName: 'zcode_rescue_task_2' };
  assert.deepEqual(validateRescueRouteDirective(followup), followup);
  assert.deepEqual(validateRescueRouteDirective(spawn), spawn);
  for (const invalid of [
    { ...followup, childId: 'secret' }, { ...followup, target: '/root' }, { ...followup, target: '/root/../bad' },
    { ...followup, assignment: 'explorer' }, { ...followup, version: 1 },
    { ...spawn, target: '/root/zcode_rescue_task_2' }, { ...spawn, taskName: 'zcode_rescue_task_1' },
    { version: 2, action: 'spawn', taskName: 'zcode_rescue_task' },
    { version: 1, action: 'followup', target: '/root/zcode_rescue_task' }, null,
  ]) assert.throws(() => validateRescueRouteDirective(invalid), { code: 'RESCUE_ROUTE_INVALID' });
});
