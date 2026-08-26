import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  consumePendingLegacyChildAuthorityContext,
  createInvocationStore,
  parseRecordedInvocation,
  readPendingLegacyChildAuthorityContext,
} from '../scripts/lib/invocation.mjs';
import { resolveWorkspaceStorage } from '../scripts/lib/workspace.mjs';

const JOB_ID = 'a'.repeat(64);

async function historicalAuthorityPendingFixture(routeKind = 'bound', createdAt = '2026-08-24T00:00:00.000Z') {
  const root = await mkdtemp(join(tmpdir(), 'zcode-invocation-v3-')); const dataRoot = join(root, 'data');
  const workspace = join(root, 'workspace'); await mkdir(workspace); const canonical = await realpath(workspace);
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace: canonical });
  const directory = join(storage.directory, 'invocations', 'pending'); await mkdir(directory, { recursive: true });
  const key = createHash('sha256').update(JSON.stringify(['parent', canonical, 'rescue'])).digest('hex');
  const legacyAuthority = routeKind === 'legacy'
    ? { kind: 'codex-legacy-adoption', authorityId: 'a'.repeat(64), childAgentId: 'legacy-child', childAgentType: 'zcode-rescue',
      authorizingParentTurnId: 'turn-a', authorizingParentGenerationId: 'c'.repeat(64), authorizingPermissionMode: 'workspace-write',
      originWorkspace: canonical, executionWorkspace: canonical, agentPathDigest: 'b'.repeat(64) }
    : { kind: 'codex-legacy-continuation', preparationAuthorityId: 'a'.repeat(64), bindingKey: 'b'.repeat(64),
      childAgentId: 'legacy-child', childAgentType: 'zcode-rescue', authorizingParentTurnId: 'turn-a',
      authorizingParentGenerationId: 'c'.repeat(64), authorizingPermissionMode: 'workspace-write',
      originWorkspace: canonical, executionWorkspace: canonical, agentPathDigest: 'd'.repeat(64) };
  /** @type {any} */ const record = { version: 3, key, sessionId: 'parent', originatingTurnId: 'turn-a', workspace: canonical,
    permissionMode: 'workspace-write', command: 'rescue', spec: { argv: ['rescue', 'task'] }, source: 'explicit',
    executorAgentId: 'legacy-child', routeKind, candidateJobId: 'e'.repeat(64),
    ...(routeKind === 'bound' ? { expectedOperationId: 'f'.repeat(64), expectedCurrentJobId: '1'.repeat(64) } : {}),
    legacyAuthority, createdAt, expiresAt: new Date(Date.parse(createdAt) + 30 * 60_000).toISOString() };
  record.legacyAuthorityDigest = createHash('sha256').update(JSON.stringify([
    'rescue-pending-legacy-authority-v1', record.key, record.sessionId, record.originatingTurnId, record.workspace,
    record.permissionMode, record.executorAgentId, record.routeKind, record.candidateJobId, record.expectedOperationId,
    record.expectedCurrentJobId, record.legacyAuthority,
  ])).digest('hex');
  const path = join(directory, `${key}.json`); await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  return { canonical, dataRoot, path, pending: createInvocationStore({ dataRoot }), record };
}

test('new pending invocations reject historical authority input before publication', async () => {
  const fixture = await historicalAuthorityPendingFixture();
  await assert.rejects(fixture.pending.savePending({ sessionId: 'parent', turnId: 'turn-a', workspace: fixture.canonical,
    permissionMode: 'workspace-write', command: 'rescue', source: 'explicit', executorAgentId: 'legacy-child',
    spec: { argv: ['rescue', 'task'] }, routeKind: 'bound', candidateJobId: 'e'.repeat(64),
    expectedOperationId: 'f'.repeat(64), expectedCurrentJobId: '1'.repeat(64), legacyAuthority: fixture.record.legacyAuthority }),
  { code: 'PENDING_INVOCATION_INVALID' });
  assert.deepEqual(JSON.parse(await readFile(fixture.path, 'utf8')), fixture.record);
});

test('historical v3 adoption and continuation pending records are incompatible one-shots', async () => {
  for (const routeKind of ['legacy', 'bound']) {
    const fixture = await historicalAuthorityPendingFixture(routeKind);
    const input = { sessionId: 'parent', workspace: fixture.canonical, command: 'rescue', choice: 'resume', executorAgentId: 'legacy-child' };
    await assert.rejects(fixture.pending.consumePending(input), { code: 'PENDING_INVOCATION_INCOMPATIBLE' });
    await assert.rejects(fixture.pending.consumePending(input), { code: 'PENDING_INVOCATION_NOT_FOUND' });
  }
});

test('historical v3 authority objects cannot be read, cloned, or consumed as authorization', async () => {
  const fixture = await historicalAuthorityPendingFixture();
  for (const value of [fixture.record.legacyAuthority, structuredClone(fixture.record.legacyAuthority), Object.freeze({})]) {
    assert.throws(() => readPendingLegacyChildAuthorityContext(value), { code: 'PENDING_INVOCATION_INVALID' });
    assert.throws(() => consumePendingLegacyChildAuthorityContext(value), { code: 'PENDING_INVOCATION_INVALID' });
  }
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
    const fixture = await historicalAuthorityPendingFixture(); const record = structuredClone(fixture.record);
    mutate(record); await writeFile(fixture.path, `${JSON.stringify(record, null, 2)}\n`); const before = await readFile(fixture.path);
    await assert.rejects(fixture.pending.consumePending({ sessionId: 'parent', workspace: fixture.canonical, command: 'rescue', choice: 'fresh', executorAgentId: 'legacy-child',
      turnId: 'turn-a', permissionMode: 'workspace-write', parentGenerationId: 'c'.repeat(64), originWorkspace: fixture.canonical, executionWorkspace: fixture.canonical }),
    { code: 'PENDING_INVOCATION_NOT_FOUND' });
    assert.deepEqual(await readFile(fixture.path), before);
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
  const fixture = await historicalAuthorityPendingFixture('bound', '2026-08-24T00:00:00.000Z');
  const input = { sessionId: 'parent', workspace: fixture.canonical, command: 'rescue', choice: 'resume', executorAgentId: 'legacy-child' };
  await assert.rejects(fixture.pending.consumePending({ ...input, now: '2026-08-24T00:30:00.000Z' }),
    { code: 'PENDING_INVOCATION_INCOMPATIBLE' });
  await assert.rejects(fixture.pending.consumePending(input), { code: 'PENDING_INVOCATION_NOT_FOUND' });
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
