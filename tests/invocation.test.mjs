import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createInvocationStore, parseRecordedInvocation, readPendingLegacyChildAuthorityContext } from '../scripts/lib/invocation.mjs';
import { createConsumedLegacyChildAuthority, createRescuePreparationStore } from '../scripts/lib/rescue-preparation.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';

const JOB_ID = 'a'.repeat(64);

async function pendingLegacyFixture() {
  const root = await mkdtemp(join(tmpdir(), 'zcode-invocation-')); const dataRoot = join(root, 'data');
  const workspace = join(root, 'workspace'); await mkdir(workspace); const canonical = await realpath(workspace);
  const preparation = createRescuePreparationStore({ dataRoot });
  const activation = { kind: 'legacy-bound', childThreadId: 'legacy-child', agentPathDigest: 'a'.repeat(64), bindingKey: 'b'.repeat(64) };
  const base = { sessionId: 'parent', turnId: 'turn-a', workspace: canonical, permissionMode: 'workspace-write',
    recordedPrompt: '$zcode:rescue continue', envelope: { version: 1, source: 'explicit', task: 'task', options: {} }, activation };
  await preparation.save(base);
  const receipt = await preparation.consume({ ...base, executorAgentId: 'legacy-child', activationProof: activation });
  const authority = createConsumedLegacyChildAuthority(receipt, { authorizingParentGenerationId: 'c'.repeat(64),
    originWorkspace: canonical, executionWorkspace: canonical });
  const pending = createInvocationStore({ dataRoot });
  const route = { /** @type {'bound'} */ routeKind: 'bound', candidateJobId: 'd'.repeat(64), expectedOperationId: 'e'.repeat(64), expectedCurrentJobId: 'f'.repeat(64) };
  /** @type {any} */ const save = { sessionId: 'parent', turnId: 'turn-a', workspace: canonical, permissionMode: 'workspace-write', command: 'rescue',
    source: 'explicit', executorAgentId: 'legacy-child', spec: { argv: ['rescue', 'task'] }, ...route, legacyAuthority: authority };
  return { authority, canonical, dataRoot, pending, route, save };
}

async function pendingLegacyAdoptionFixture() {
  const root = await mkdtemp(join(tmpdir(), 'zcode-invocation-adoption-')); const dataRoot = join(root, 'data');
  const workspace = join(root, 'workspace'); await mkdir(workspace); const canonical = await realpath(workspace);
  const preparation = createRescuePreparationStore({ dataRoot });
  const activation = { kind: 'legacy-adopt', childThreadId: 'legacy-child', agentPathDigest: 'a'.repeat(64) };
  const base = { sessionId: 'parent', turnId: 'turn-a', workspace: canonical, permissionMode: 'workspace-write',
    recordedPrompt: '$zcode:rescue task', envelope: { version: 1, source: 'explicit', task: 'task', options: {} }, activation };
  await preparation.save(base);
  const receipt = await preparation.consume({ ...base, executorAgentId: 'legacy-child', activationProof: activation });
  const authority = createConsumedLegacyChildAuthority(receipt, { authorizingParentGenerationId: 'c'.repeat(64),
    originWorkspace: canonical, executionWorkspace: canonical });
  const pending = createInvocationStore({ dataRoot });
  /** @type {any} */ const save = { sessionId: 'parent', turnId: 'turn-a', workspace: canonical, permissionMode: 'workspace-write', command: 'rescue',
    source: 'explicit', executorAgentId: 'legacy-child', spec: { argv: ['rescue', 'task'] }, routeKind: 'legacy',
    candidateJobId: 'd'.repeat(64), legacyAuthority: authority };
  return { authority, canonical, dataRoot, pending, save };
}

test('v3 first-adoption pending is a strict legacy-route one-shot closed-union variant', async () => {
  const fixture = await pendingLegacyAdoptionFixture(); await fixture.pending.savePending(fixture.save);
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace: fixture.canonical });
  const directory = join(storage.directory, 'invocations', 'pending'); const [name] = await readdir(directory); const path = join(directory, name);
  const record = JSON.parse(await readFile(path, 'utf8')); assert.equal(record.version, 3); assert.equal(record.routeKind, 'legacy');
  assert.equal(record.expectedOperationId, undefined); assert.deepEqual(record.legacyAuthority, fixture.authority);
  const otherWorkspace = join(fixture.canonical, '..', 'first-adoption-other'); await mkdir(otherWorkspace);
  const exact = { sessionId: 'parent', workspace: fixture.canonical, command: 'rescue', choice: 'resume', executorAgentId: 'legacy-child',
    turnId: 'turn-a', permissionMode: 'workspace-write', parentGenerationId: 'c'.repeat(64), originWorkspace: fixture.canonical, executionWorkspace: fixture.canonical };
  for (const mutation of [{ sessionId: 'other-parent' }, { workspace: otherWorkspace }, { executorAgentId: 'sibling' }, { turnId: 'other-turn' }, { permissionMode: 'read-only' },
    { parentGenerationId: '9'.repeat(64) }, { originWorkspace: '/private/other' }, { executionWorkspace: '/private/other' }]) {
    await assert.rejects(fixture.pending.consumePending({ ...exact, ...mutation }), { code: 'PENDING_INVOCATION_NOT_FOUND' });
  }
  const consumed = await fixture.pending.consumePending(exact); assert.deepEqual(consumed.route, { routeKind: 'legacy', candidateJobId: 'd'.repeat(64) });
  assert.equal(readPendingLegacyChildAuthorityContext(consumed.authority).parentSessionId, 'parent');
  assert.throws(() => readPendingLegacyChildAuthorityContext(structuredClone(consumed.authority)), { code: 'PENDING_INVOCATION_INVALID' });
  await assert.rejects(fixture.pending.consumePending(exact), { code: 'PENDING_INVOCATION_NOT_FOUND' });
});

test('v3 first-adoption pending rejects path, candidate, authority-kind, and route mutations without consumption', async () => {
  for (const mutate of [
    (/** @type {any} */ record) => { record.legacyAuthority.agentPathDigest = '9'.repeat(64); },
    (/** @type {any} */ record) => { record.candidateJobId = '9'.repeat(64); },
    (/** @type {any} */ record) => { record.legacyAuthority.kind = 'codex-legacy-continuation'; },
    (/** @type {any} */ record) => { record.routeKind = 'bound'; },
  ]) {
    const fixture = await pendingLegacyAdoptionFixture(); await fixture.pending.savePending(fixture.save);
    const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace: fixture.canonical });
    const directory = join(storage.directory, 'invocations', 'pending'); const [name] = await readdir(directory); const path = join(directory, name);
    const record = JSON.parse(await readFile(path, 'utf8')); mutate(record); await writeFile(path, `${JSON.stringify(record, null, 2)}\n`); const before = await readFile(path);
    await assert.rejects(fixture.pending.consumePending({ sessionId: 'parent', workspace: fixture.canonical, command: 'rescue', choice: 'fresh', executorAgentId: 'legacy-child',
      turnId: 'turn-a', permissionMode: 'workspace-write', parentGenerationId: 'c'.repeat(64), originWorkspace: fixture.canonical, executionWorkspace: fixture.canonical }),
    { code: 'PENDING_INVOCATION_NOT_FOUND' });
    assert.deepEqual(await readFile(path), before);
  }
});

test('v3 pending legacy authority is strict, exact-current, one-shot, and clone resistant', async () => {
  const fixture = await pendingLegacyFixture(); await fixture.pending.savePending(fixture.save);
  const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace: fixture.canonical });
  const directory = join(storage.directory, 'invocations', 'pending'); const [name] = await readdir(directory); const path = join(directory, name);
  const persisted = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(persisted.version, 3); assert.deepEqual(persisted.legacyAuthority, fixture.authority);
  const otherWorkspace = join(fixture.canonical, '..', 'other-workspace'); await mkdir(otherWorkspace);
  const exact = { sessionId: 'parent', workspace: fixture.canonical, command: 'rescue', choice: 'resume', executorAgentId: 'legacy-child',
    turnId: 'turn-a', permissionMode: 'workspace-write', parentGenerationId: 'c'.repeat(64), originWorkspace: fixture.canonical, executionWorkspace: fixture.canonical };
  for (const mutation of [
    { sessionId: 'sibling' }, { workspace: otherWorkspace }, { executorAgentId: 'sibling-child' },
    { turnId: 'turn-b' }, { permissionMode: 'read-only' }, { parentGenerationId: '9'.repeat(64) },
    { originWorkspace: '/private/other' }, { executionWorkspace: '/private/other' },
  ]) await assert.rejects(fixture.pending.consumePending({ ...exact, ...mutation }), { code: 'PENDING_INVOCATION_NOT_FOUND' });
  assert.deepEqual(await readFile(path, 'utf8'), `${JSON.stringify(persisted, null, 2)}\n`);
  const consumed = await fixture.pending.consumePending(exact);
  assert.deepEqual(consumed.argv, ['rescue', '--resume', 'task']); assert.deepEqual(consumed.route, fixture.route);
  assert.equal(readPendingLegacyChildAuthorityContext(consumed.authority).parentSessionId, 'parent');
  assert.throws(() => readPendingLegacyChildAuthorityContext(structuredClone(consumed.authority)), { code: 'PENDING_INVOCATION_INVALID' });
  await assert.rejects(fixture.pending.consumePending(exact), { code: 'PENDING_INVOCATION_NOT_FOUND' });
});

test('v3 pending rejects authority and binding mutations without consuming the record', async () => {
  for (const mutate of [
    (/** @type {any} */ record) => { record.legacyAuthority.kind = 'codex-legacy-adoption'; },
    (/** @type {any} */ record) => { record.legacyAuthority.bindingKey = '9'.repeat(64); },
    (/** @type {any} */ record) => { record.legacyAuthority.agentPathDigest = '9'.repeat(64); },
    (/** @type {any} */ record) => { record.legacyAuthority.extra = true; },
    (/** @type {any} */ record) => { record.routeKind = 'legacy'; },
    (/** @type {any} */ record) => { record.expectedOperationId = 'short'; },
  ]) {
    const fixture = await pendingLegacyFixture(); await fixture.pending.savePending(fixture.save);
    const storage = await resolveWorkspaceStorage({ dataRoot: fixture.dataRoot, workspace: fixture.canonical });
    const directory = join(storage.directory, 'invocations', 'pending'); const [name] = await readdir(directory); const path = join(directory, name);
    const record = JSON.parse(await readFile(path, 'utf8')); mutate(record); await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
    const before = await readFile(path);
    await assert.rejects(fixture.pending.consumePending({ sessionId: 'parent', workspace: fixture.canonical, command: 'rescue', choice: 'fresh', executorAgentId: 'legacy-child',
      turnId: 'turn-a', permissionMode: 'workspace-write', parentGenerationId: 'c'.repeat(64), originWorkspace: fixture.canonical, executionWorkspace: fixture.canonical }),
    { code: 'PENDING_INVOCATION_NOT_FOUND' });
    assert.deepEqual(await readFile(path), before);
  }
});

test('v2 exact route pending remains compatible beside the private v3 authority variant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zcode-invocation-v2-')); const dataRoot = join(root, 'data'); const workspace = join(root, 'workspace'); await mkdir(workspace);
  const pending = createInvocationStore({ dataRoot });
  /** @type {{routeKind:'bound',candidateJobId:string,expectedOperationId:string,expectedCurrentJobId:string}} */
  const route = { routeKind: 'bound', candidateJobId: 'a'.repeat(64), expectedOperationId: 'b'.repeat(64), expectedCurrentJobId: 'c'.repeat(64) };
  await pending.savePending({ sessionId: 'parent', turnId: 'turn', workspace, permissionMode: 'workspace-write', command: 'rescue', source: 'explicit', executorAgentId: 'child', spec: { argv: ['rescue', 'task'] }, ...route });
  await assert.rejects(pending.consumePending({ sessionId: 'parent', workspace, command: 'rescue', choice: 'fresh', executorAgentId: 'child', requireLegacyAuthority: true }),
  { code: 'PENDING_INVOCATION_NOT_FOUND' });
  assert.deepEqual((await pending.consumePending({ sessionId: 'parent', workspace, command: 'rescue', choice: 'fresh', executorAgentId: 'child' })).route, route);
});

test('v1 executor-bound pending compatibility remains fresh-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zcode-invocation-v1-')); const dataRoot = join(root, 'data'); const workspace = join(root, 'workspace'); await mkdir(workspace);
  const pending = createInvocationStore({ dataRoot });
  await pending.savePending({ sessionId: 'parent', turnId: 'turn', workspace, permissionMode: 'workspace-write', command: 'rescue', source: 'proactive', executorAgentId: 'child', spec: { argv: ['rescue', 'task'] } });
  assert.deepEqual(await pending.consumePending({ sessionId: 'parent', workspace, command: 'rescue', choice: 'fresh', executorAgentId: 'child' }), {
    argv: ['rescue', '--fresh', 'task'], source: 'proactive', caller: { sessionId: 'parent', turnId: 'turn', workspace: await realpath(workspace), permissionMode: 'workspace-write' },
  });
});

test('expired v3 pending authority is deleted without issuing a brand', async () => {
  const fixture = await pendingLegacyFixture(); const now = new Date('2026-08-24T00:00:00.000Z');
  await fixture.pending.savePending({ ...fixture.save, now });
  const input = { sessionId: 'parent', workspace: fixture.canonical, command: 'rescue', choice: 'resume', executorAgentId: 'legacy-child',
    turnId: 'turn-a', permissionMode: 'workspace-write', parentGenerationId: 'c'.repeat(64), originWorkspace: fixture.canonical, executionWorkspace: fixture.canonical };
  await assert.rejects(fixture.pending.consumePending({ ...input, now: new Date(now.getTime() + 30 * 60_000) }), { code: 'PENDING_INVOCATION_EXPIRED' });
  await assert.rejects(fixture.pending.consumePending({ ...input, now }), { code: 'PENDING_INVOCATION_NOT_FOUND' });
});

test('embedded result marker in prose does not consume prose as arguments', () => {
  assert.deepEqual(parseRecordedInvocation('result', '通过 $zcode:result 可以查到结果吗'), {
    argv: ['result'],
    explicit: true,
  });
});

test('embedded result marker extracts only an immediately following exact job ID', () => {
  assert.deepEqual(parseRecordedInvocation('result', `please use $zcode:result ${JOB_ID} when ready`), {
    argv: ['result', JOB_ID],
    explicit: true,
  });
});

test('embedded cancel marker accepts an exact ID and otherwise ignores prose', () => {
  assert.deepEqual(parseRecordedInvocation('cancel', 'can $zcode:cancel stop the job'), {
    argv: ['cancel'],
    explicit: true,
  });
  assert.deepEqual(parseRecordedInvocation('cancel', `please $zcode:cancel ${JOB_ID} now`), {
    argv: ['cancel', JOB_ID],
    explicit: true,
  });
});

test('command-form result invocation retains strict tokenization', () => {
  assert.deepEqual(parseRecordedInvocation('result', '$zcode:result not-an-id'), {
    argv: ['result', 'not-an-id'],
    explicit: true,
  });
  assert.deepEqual(parseRecordedInvocation('result', `  $zcode:result ${JOB_ID}  `), {
    argv: ['result', JOB_ID],
    explicit: true,
  });
});

test('status invocation retains its current option grammar', () => {
  assert.deepEqual(parseRecordedInvocation('status', `$zcode:status ${JOB_ID} --wait --timeout-ms 1000`), {
    argv: ['status', JOB_ID, '--wait', '--timeout-ms', '1000'],
    explicit: true,
  });
});

test('ambiguous embedded result syntax remains strict for downstream validation', () => {
  assert.deepEqual(parseRecordedInvocation('result', 'please $zcode:result --wait for it'), {
    argv: ['result', '--wait', 'for', 'it'],
    explicit: true,
  });
  assert.deepEqual(parseRecordedInvocation('result', `please $zcode:result $zcode:cancel ${JOB_ID}`), {
    argv: ['result', '$zcode:cancel', JOB_ID],
    explicit: true,
  });
  assert.deepEqual(parseRecordedInvocation('result', 'please $zcode:result tell me --wait now'), {
    argv: ['result', 'tell', 'me', '--wait', 'now'],
    explicit: true,
  });
  assert.deepEqual(parseRecordedInvocation('result', `please $zcode:result tell me $zcode:cancel ${JOB_ID}`), {
    argv: ['result', 'tell', 'me', '$zcode:cancel', JOB_ID],
    explicit: true,
  });
  assert.deepEqual(parseRecordedInvocation('result', `please $zcode:result ${JOB_ID} then $zcode:cancel`), {
    argv: ['result', JOB_ID, 'then', '$zcode:cancel'],
    explicit: true,
  });
});

test('quoted and escaped command-shaped tokens retain strict tokenization', () => {
  assert.deepEqual(parseRecordedInvocation('cancel', 'please $zcode:cancel "--wait"'), {
    argv: ['cancel', '--wait'],
    explicit: true,
  });
  assert.deepEqual(parseRecordedInvocation('result', 'please $zcode:result "$zcode:cancel"'), {
    argv: ['result', '$zcode:cancel'],
    explicit: true,
  });
  assert.deepEqual(parseRecordedInvocation('cancel', String.raw`please $zcode:cancel \--wait`), {
    argv: ['cancel', '--wait'],
    explicit: true,
  });
  assert.deepEqual(parseRecordedInvocation('result', String.raw`please $zcode:result \$zcode:cancel`), {
    argv: ['result', '$zcode:cancel'],
    explicit: true,
  });
});

test('quoted and escaped embedded exact IDs retain strict tokenization', () => {
  assert.deepEqual(parseRecordedInvocation('result', `please $zcode:result "${JOB_ID}"`), {
    argv: ['result', JOB_ID],
    explicit: true,
  });
  assert.deepEqual(parseRecordedInvocation('cancel', `please $zcode:cancel '${JOB_ID}'`), {
    argv: ['cancel', JOB_ID],
    explicit: true,
  });
  assert.deepEqual(parseRecordedInvocation('result', `please $zcode:result \\${JOB_ID}`), {
    argv: ['result', JOB_ID],
    explicit: true,
  });
});

test('ordinary embedded prose punctuation and internal hyphens do not trigger strict mode', () => {
  assert.deepEqual(parseRecordedInvocation('result', 'please $zcode:result tell me state-of-the-art news, thanks'), {
    argv: ['result'],
    explicit: true,
  });
  assert.deepEqual(parseRecordedInvocation('result', `please $zcode:result ${JOB_ID} state-of-the-art, thanks`), {
    argv: ['result', JOB_ID],
    explicit: true,
  });
  assert.deepEqual(parseRecordedInvocation('result', "please $zcode:result what's the latest?"), {
    argv: ['result'],
    explicit: true,
  });
  assert.deepEqual(parseRecordedInvocation('result', `please $zcode:result ${JOB_ID} what's next?`), {
    argv: ['result', JOB_ID],
    explicit: true,
  });
  assert.deepEqual(parseRecordedInvocation('cancel', "can $zcode:cancel what's currently running?"), {
    argv: ['cancel'],
    explicit: true,
  });
});

test('embedded result marker rejects ID-looking tokens that are not exact lowercase digests', () => {
  for (const token of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
    assert.deepEqual(parseRecordedInvocation('result', `please $zcode:result ${token} afterward`), {
      argv: ['result'],
      explicit: true,
    });
  }
});
