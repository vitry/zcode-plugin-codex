# Rescue Lifecycle-Bound Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the plugin-defined ordinary Rescue completion deadline, bind active parent authority to hook lifecycle, and permit exact same-child continuation through private preparation generations while preserving bounded one-shot credentials and explicit cancellation.

**Architecture:** Version lifecycle-owned active-turn and preparation records independently from their existing replayable envelopes. Make completion budgets opt-in at the protocol waiter, reuse the existing stopped-executor binding/CAS machinery for same-turn continuation, and classify Role readiness failures at a single bounded public boundary. Keep Root/child assignments task-blind and leave request, review-gate, qualification, and cancellation deadlines explicit.

**Tech Stack:** Node.js ESM, `node:test`, private atomic JSON state, Codex lifecycle hooks, ZCode JSON-RPC/App Server, ESLint, TypeScript check mode, GitHub Actions.

---

## File map

- `scripts/lib/identity.mjs`: separate lifecycle-owned active-turn v2 records from 30-minute caller token records and retain strict legacy expiry.
- `tests/identity.test.mjs`: active-turn schema, long-duration resolution, legacy compatibility, ambiguity, and fail-closed coverage.
- `tests/hooks.test.mjs`: lifecycle integration assertions for prompt replacement, Root Stop, BLOCK, and SessionEnd.
- `scripts/lib/zcode-protocol.mjs`: make completion budgets optional while retaining explicit timeout cleanup.
- `scripts/lib/zcode-client.mjs`: document and forward the optional completion budget without supplying a default.
- `tests/zcode-client.test.mjs`: unbounded default waiter, explicit timeout, terminal, disconnect, and stop cleanup.
- `tests/job-control.test.mjs`: prove elapsed wall time alone neither stops nor fails an ordinary active job.
- `scripts/lib/rescue-preparation.mjs`: strict v1/v2 record codec and atomic consumed-slot generation replacement.
- `tests/rescue-preparation.test.mjs`: generation, compatibility, executor binding, replay, expiry, concurrency, and cleanup tests.
- `scripts/zcode-companion.mjs`: enforce stopped required-executor provenance, propagate exact binding CAS route, and publish refined Role statuses.
- `scripts/lib/managed-agent-role.mjs`: distinguish unusable inspection/configuration from genuine unsupported host capability.
- `tests/integration/companion.test.mjs`: same-parent-turn continuation, client option, zero-side-effect rejection, and Role-status integration.
- `skills/rescue/SKILL.md`: authorize same-active-parent-turn automatic continuation and status-specific remedies.
- `agents/zcode-rescue.toml.template`: keep the fixed task-blind forwarder valid for same-parent-turn continuation.
- `tests/helpers/rescue-skill-contract.mjs`: exact private routing and status remedy contract helpers.
- `tests/skills-contracts.test.mjs`: Skill and Role public contract coverage.
- `tests/managed-agent-role.test.mjs`: Role byte/digest upgrade and genuine-unsupported classification.
- `tests/helpers/codex-rescue-qualification.mjs`: capture sequential consumed generations in one parent-turn slot.
- `tests/codex-rescue-qualification.test.mjs`: synthetic same-turn lifecycle and privacy qualification.
- `tests/e2e/codex-skills-e2e.test.mjs`: installed same-child, zero-spawn lifecycle qualification.
- `tests/e2e/real-zcode.test.mjs`: explicitly bounded authenticated verification with two completed turns in one real ZCode session.
- `README.md`, `README.zh-CN.md`, `SECURITY.md`, `CHANGELOG.md`: document lifecycle-bound completion, bounded artifacts, cancellation, and upgrade behavior.
- `marketplace/plugins/zcode/**`: generated source mirror refreshed from a clean exact commit.

### Task 1: Version lifecycle-bound active parent turns

**Files:**
- Modify: `tests/identity.test.mjs`
- Modify: `scripts/lib/identity.mjs:9,61-98,343-353,461-469`
- Modify: `tests/hooks.test.mjs:135-166,355-383,603-684`

- [ ] **Step 1: Write failing active-turn lifecycle and legacy tests**

Replace the current active-turn expiry assertion with lifecycle assertions and add a strict legacy fixture:

```js
test('lifecycle-bound active turns resolve after 30 minutes, 60 minutes, and 24 hours', async () => {
  const { identity, workspaceA } = await fixture();
  const now = new Date('2026-08-04T00:00:00.000Z');
  await identity.beginCallerTurn({
    sessionId: 'session-a', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'workspace-write', prompt: '$zcode:rescue repair auth', now,
  });
  for (const elapsed of [30 * 60_000, 60 * 60_000, 24 * 60 * 60_000]) {
    const active = await identity.resolveActiveTurn({
      sessionId: 'session-a', workspace: workspaceA,
      now: new Date(now.getTime() + elapsed),
    });
    assert.equal(active.version, 2);
    assert.equal(active.kind, 'active-turn');
    assert.equal(active.turnId, 'turn-a');
    assert.equal(Object.hasOwn(active, 'expiresAt'), false);
  }
});

test('legacy unversioned active turns retain their exact expiry boundary', async () => {
  const { dataRoot, identity, workspaceA } = await fixture();
  const now = new Date('2026-08-04T00:00:00.000Z');
  const storage = await resolveWorkspaceStorage({ dataRoot, workspace: workspaceA });
  const key = createHash('sha256').update(JSON.stringify(['legacy-session', storage.workspacePath])).digest('hex');
  await mkdir(join(storage.directory, 'identity', 'active-turns'), { recursive: true });
  await writeFile(join(storage.directory, 'identity', 'active-turns', `${key}.json`), `${JSON.stringify({
    key, sessionId: 'legacy-session', turnId: 'legacy-turn', workspace: storage.workspacePath,
    permissionMode: 'workspace-write', prompt: 'legacy', createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
  })}\n`);
  assert.equal((await identity.resolveActiveTurn({ sessionId: 'legacy-session', workspace: workspaceA, now })).turnId, 'legacy-turn');
  await assert.rejects(identity.resolveActiveTurn({
    sessionId: 'legacy-session', workspace: workspaceA,
    now: new Date(now.getTime() + 30 * 60_000),
  }), { code: 'ACTIVE_TURN_EXPIRED' });
});
```

Add table-driven corrupt cases for an unknown `version`, wrong `kind`, v2 with `expiresAt`, and legacy with `version`/`kind`; assert `resolveActiveTurn()` reports `ACTIVE_TURN_NOT_FOUND` or `AUTHORIZATION_RECORD_INVALID` exactly as the existing boundary requires and never upgrades the bytes.

- [ ] **Step 2: Run the focused identity tests and verify RED**

Run:

```bash
node --test --test-name-pattern='lifecycle-bound active|legacy unversioned active|active turn resolvers' tests/identity.test.mjs
```

Expected: FAIL because newly written active records still have `expiresAt`, have no `version/kind`, and expire after 30 minutes.

- [ ] **Step 3: Implement strict current and legacy active record classification**

Keep `CALLER_LIFETIME_MS` for caller records only. Replace the active record constructor and validator with strict schemas:

```js
const ACTIVE_TURN_VERSION = 2;
const ACTIVE_TURN_KEYS = Object.freeze([
  'createdAt', 'key', 'kind', 'permissionMode', 'prompt',
  'sessionId', 'turnId', 'version', 'workspace',
]);
const LEGACY_ACTIVE_TURN_KEYS = Object.freeze([
  'createdAt', 'expiresAt', 'key', 'permissionMode', 'prompt',
  'sessionId', 'turnId', 'workspace',
]);

function activeTurnRecord(input, workspacePath) {
  const createdAt = toTimestamp(input.now);
  return {
    version: ACTIVE_TURN_VERSION,
    kind: 'active-turn',
    key: activeTurnKey(input.sessionId, workspacePath),
    sessionId: input.sessionId,
    turnId: input.turnId,
    workspace: workspacePath,
    permissionMode: input.permissionMode,
    prompt: input.prompt ?? '',
    createdAt: new Date(createdAt).toISOString(),
  };
}

function activeTurnRecordKind(record) {
  if (isCurrentActiveTurnRecord(record)) return 'current';
  if (isLegacyActiveTurnRecord(record)) return 'legacy';
  return null;
}
```

Use exact sorted-key comparison in both validators. In `resolveActiveTurn()`, skip wall time only for `current`; for `legacy`, retain `ACTIVE_TURN_EXPIRED`. In `resolveOnlyActiveTurn()`, include every valid current record and only unexpired legacy records. In `endCallerTurn()`, accept both valid record kinds and delete only the matching exact turn.

- [ ] **Step 4: Run identity tests and verify GREEN**

Run:

```bash
node --test tests/identity.test.mjs
```

Expected: PASS; caller-token tests still prove the independent 30-minute expiry.

- [ ] **Step 5: Strengthen hook lifecycle integration without changing hook behavior**

In the existing prompt lifecycle suite, read the active-turn file and assert:

```js
assert.equal(active.version, 2);
assert.equal(active.kind, 'active-turn');
assert.equal(Object.hasOwn(active, 'expiresAt'), false);
```

In the existing Root Stop/SessionEnd tests, assert exact revocation through `resolveActiveTurn()`: the ended session rejects with `ACTIVE_TURN_NOT_FOUND`, while the sibling session still resolves. Preserve the existing BLOCK assertion that the exact active turn remains usable.

- [ ] **Step 6: Run hook/setup tests and commit**

Run:

```bash
node --test tests/hooks.test.mjs tests/setup.test.mjs
npm run lint
npm run typecheck
```

Expected: PASS.

Commit:

```bash
git add scripts/lib/identity.mjs tests/identity.test.mjs tests/hooks.test.mjs
git commit -m "fix: bind active turns to hook lifecycle"
```

### Task 2: Make ordinary completion waiting deadline-free

**Files:**
- Modify: `tests/zcode-client.test.mjs:379-503`
- Modify: `scripts/lib/zcode-protocol.mjs:12-18,93-125`
- Modify: `scripts/lib/zcode-client.mjs:104,136-162`
- Modify: `tests/job-control.test.mjs:492-659`
- Modify: `tests/integration/companion.test.mjs:457-465`

- [ ] **Step 1: Write a failing protocol test for an unbounded default waiter**

Add a test using the existing fake peer and an explicitly undefined client budget:

```js
test('default completion wait has no timer and accepts a delayed terminal', async () => {
  await withClient(async (client) => {
    const created = await client.createSession({ workspace: '/repo' });
    await client.send(created.session.sessionId, 'wait without a task deadline');
    const waiting = client.waitForCompletion(created.session.sessionId);
    assert.equal([...client.protocol.completionWaiters][0]?.timer, null);
    const completion = await waiting;
    assert.equal(completion.reason, 'prompt_completed');
    assert.equal(client.protocol.completionWaiters.size, 0);
  }, { FAKE_ZCODE_COMPLETION_DELAY_MS: '100' }, { completionTimeoutMs: undefined });
});
```

Use the file's existing completion-gate helper rather than sleeping. If protocol internals are intentionally hidden by the helper, inject the timer functions and assert no completion timer was scheduled.

- [ ] **Step 2: Run the completion tests and verify RED**

Run:

```bash
node --test --test-name-pattern='default completion wait|completion timeout and stop' tests/zcode-client.test.mjs
```

Expected: FAIL because the constructor substitutes `3_600_000` and always creates a timer.

- [ ] **Step 3: Implement optional completion budgets**

Store an optional validated value:

```js
this.completionTimeoutMs = options.completionTimeoutMs === undefined
  ? undefined
  : boundedInteger(options.completionTimeoutMs, undefined, 1, 86_400_000);
```

Make the waiter conditional:

```js
waitForCompletion(sessionId, timeoutMs) {
  const effectiveTimeoutMs = timeoutMs ?? this.completionTimeoutMs;
  if (!nonEmpty(sessionId)
    || effectiveTimeoutMs !== undefined && (!Number.isSafeInteger(effectiveTimeoutMs) || effectiveTimeoutMs <= 0)
    || this.turns.get(sessionId)?.status !== 'armed'
    || this.waiterSessions.has(sessionId)) return Promise.reject(protocolInputError());
  // queued completion path remains unchanged
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const waiter = { reject, timer: null, unsubscribe, sessionId };
    this.waiterSessions.add(sessionId);
    if (effectiveTimeoutMs !== undefined) {
      waiter.timer = setTimeout(() => {
        this.completionWaiters.delete(waiter);
        this.waiterSessions.delete(sessionId);
        this.abortTurn(sessionId);
        unsubscribe();
        reject(new PluginError('ZCODE_COMPLETION_TIMEOUT', 'ZCode completion did not arrive within the explicit budget.', {
          category: 'timeout', remedy: 'Read or resume the session before retrying.',
          details: { sessionId, timeoutMs: effectiveTimeoutMs },
        }));
      }, effectiveTimeoutMs);
      waiter.timer.unref?.();
    }
    // subscribe and terminal resolve preserve the existing validation;
    // clear waiter.timer only when it is non-null.
  });
}
```

Update every completion waiter cleanup (`cancelTurn`, terminal resolve, disconnect/close rejection) to clear only a non-null timer. Keep request deadlines unchanged. Update JSDoc in `zcode-client.mjs`; do not add a default in any ordinary Companion client factory.

- [ ] **Step 4: Prove explicit budgets and cleanup still work**

Keep the existing 20ms timeout/retry test and add invalid explicit values (`0`, negative, fractional, over 24 hours). Run:

```bash
node --test tests/zcode-client.test.mjs
```

Expected: PASS; explicit timeout still returns `ZCODE_COMPLETION_TIMEOUT`, and stop/disconnect/terminal paths leave no waiter or turn.

- [ ] **Step 5: Write and pass an execution-level no-elapsed-stop test**

Add a controlled `executeJob` test with a pending completion promise and a `stopSession` counter:

```js
assert.equal((await store.readJob(workspace, job.id)).status, 'running');
assert.equal(stopCalls, 0);
complete({ reason: 'prompt_completed', revision: 2 });
const output = await execution;
assert.equal(output.job.status, 'succeeded');
assert.equal(stopCalls, 0);
```

Advance the injected clock beyond 60 minutes before resolving; do not wait in real time. Extend the injected Companion client factory assertion with:

```js
assert.equal(Object.hasOwn(clientOptions, 'completionTimeoutMs'), false);
```

Run:

```bash
node --test tests/job-control.test.mjs tests/integration/companion.test.mjs
```

Expected: PASS; ordinary elapsed time has no stop/fail side effect.

- [ ] **Step 6: Preserve the explicitly bounded Stop gate and commit**

Run:

```bash
node --test --test-name-pattern='Stop gate.*conservatively blocks bad reviews' tests/hooks.test.mjs
npm run lint
npm run typecheck
```

Expected: PASS; the injected two-second gate still times out, stops once, and blocks conservatively because `stop-review-gate-hook.mjs` explicitly passes `completionTimeoutMs`.

Commit:

```bash
git add scripts/lib/zcode-protocol.mjs scripts/lib/zcode-client.mjs tests/zcode-client.test.mjs tests/job-control.test.mjs tests/integration/companion.test.mjs
git commit -m "fix: remove implicit Rescue completion deadline"
```

### Task 3: Add private same-turn preparation generations

**Files:**
- Modify: `tests/rescue-preparation.test.mjs`
- Modify: `scripts/lib/rescue-preparation.mjs:18-34,99-175,345-390`

- [ ] **Step 1: Write failing strict v2 generation tests**

Change only the persisted record version expectation; the public envelope remains version 1. Add:

```js
test('consumed preparation advances only to one proactive resume generation', async () => {
  const { store, workspaceA } = await storeFixture();
  const base = {
    sessionId: 'parent', turnId: 'turn-a', workspace: workspaceA,
    permissionMode: 'workspace-write', recordedPrompt: '$zcode:rescue initial',
  };
  await store.save({ ...base, envelope: validEnvelope });
  const first = await store.consume({ ...base, executorAgentId: 'rescue-child' });
  assert.equal(first.generation, 1);
  await store.save({
    ...base, recordedPrompt: '$zcode:rescue initial',
    envelope: { version: 1, source: 'proactive', task: 'continue exact operation', options: { execution: 'foreground', resume: 'resume' } },
  });
  await assert.rejects(store.consume({ ...base, executorAgentId: 'sibling-child' }), { code: 'RESCUE_PREPARATION_MISMATCH' });
  const second = await store.consume({ ...base, executorAgentId: 'rescue-child' });
  assert.equal(second.generation, 2);
  assert.equal(second.requiredExecutorAgentId, 'rescue-child');
});
```

Add table cases proving replacement rejects an unconsumed record (including an expired unconsumed record), explicit/fresh input, changed permission, malformed/unknown record, missing prior executor, generation overflow, and a sibling. Add a 16-way concurrent replacement test with exactly one fulfilled save. Also prove that an expired consumed tombstone may produce exactly one bound proactive-resume successor whose own lifetime is a fresh 30 minutes.

- [ ] **Step 2: Run preparation tests and verify RED**

Run:

```bash
node --test tests/rescue-preparation.test.mjs
```

Expected: FAIL because records are v1, have no generation fields, and every second save returns `RESCUE_PREPARATION_EXISTS`.

- [ ] **Step 3: Split envelope and record versions with strict codecs**

Keep:

```js
export const RESCUE_PREPARATION_VERSION = 1;
```

Add:

```js
const RESCUE_PREPARATION_RECORD_VERSION = 2;
const V1_RECORD_KEYS = Object.freeze([
  'consumedAt', 'createdAt', 'envelope', 'executorAgentId', 'expiresAt', 'key',
  'permissionMode', 'sessionId', 'source', 'turnId', 'version', 'workspace',
]);
const V2_RECORD_KEYS = Object.freeze([
  'consumedAt', 'createdAt', 'envelope', 'executorAgentId', 'expiresAt', 'generation', 'key',
  'permissionMode', 'requiredExecutorAgentId', 'sessionId', 'source', 'turnId', 'version', 'workspace',
]);
```

Implement strict `recordKind(record)` returning `legacy`, `current`, or `null`. For current records require a safe positive `generation`, `requiredExecutorAgentId` either null or a bounded non-empty identifier, and exact keys. Treat a consumed v1 record as implicit generation 1 only inside the authorized replacement path.

- [ ] **Step 4: Implement atomic replacement after consumed generation**

Inside the existing preparation lock, read the current slot when it exists. Reject unconsumed state. Permit replacement only through this predicate:

```js
const boundResume = envelope.source === 'proactive'
  && envelope.options.resume === 'resume'
  && current.sessionId === input.sessionId
  && current.turnId === input.turnId
  && current.workspace === storage.workspacePath
  && current.permissionMode === input.permissionMode
  && current.consumedAt !== null
  && nonempty(current.executorAgentId)
  && createdAt >= Date.parse(current.consumedAt);
```

Compute the generation internally (`legacy ? 2 : current.generation + 1`) and reject unsafe overflow. Write one v2 record in the same slot with `requiredExecutorAgentId: current.executorAgentId`, `consumedAt: null`, and `executorAgentId: null`. Apply the explicit prompt marker/source check only for an empty first-generation slot; replacement is intentionally proactive even when the original recorded prompt was explicit.

The prior generation's `expiresAt` still bounds its unconsumed authority and consume path. It does not block replacement after the record is already an exact-executor consumed tombstone; otherwise a ZCode turn lasting beyond 30 minutes would make same-parent-turn continuation impossible. The successor always starts a new independent 30-minute lifetime from the lock-linearized save time.

- [ ] **Step 5: Enforce the exact executor during consume and preserve cleanup**

Before consumption:

```js
if (record.requiredExecutorAgentId !== null
  && record.requiredExecutorAgentId !== input.executorAgentId) {
  throw preparationError('RESCUE_PREPARATION_MISMATCH', 'The Rescue preparation executor does not match.');
}
```

Keep the 30-minute per-generation expiry and the existing one-slot cleanup APIs. Ensure `cleanupTurn`, `cleanupOlderTurns`, and `cleanupSession` accept strict v1 and v2 records.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
node --test tests/rescue-preparation.test.mjs
npm run lint
npm run typecheck
```

Expected: PASS, including concurrency, privacy, symlink, byte-bound, and cleanup tests.

Commit:

```bash
git add scripts/lib/rescue-preparation.mjs tests/rescue-preparation.test.mjs
git commit -m "feat: add Rescue preparation generations"
```

### Task 4: Route exact same-parent-turn stopped-child continuation

**Files:**
- Modify: `tests/integration/companion.test.mjs:959-1047`
- Modify: `scripts/zcode-companion.mjs:128-149,193-212`

- [ ] **Step 1: Write a failing same-parent-turn lifecycle integration test**

Build on the existing stopped-child continuation fixture:

```js
test('a stopped Rescue child consumes the next same-parent-turn generation and resumes its exact binding', async () => {
  const context = await fixture();
  const parentSessionId = 'same-turn-parent';
  const parentTurnId = 'same-turn';
  const childId = 'same-child';
  await beginPreparedChild(context, { parentSessionId, parentTurnId, childId });
  const first = await runDirectInvocation(['invoke-prepared', 'rescue'], {
    cwd: context.workspace, env: { ...context.env, CODEX_THREAD_ID: childId },
  });
  await stopExecutor(context, childId);
  await saveProactiveResumeGeneration(context, { parentSessionId, parentTurnId });
  const second = await runDirectInvocation(['invoke-prepared', 'rescue'], {
    cwd: context.workspace, env: { ...context.env, CODEX_THREAD_ID: childId },
  });
  assert.equal(second.job.zcodeSessionId, first.job.zcodeSessionId);
  assert.equal(reservedJobs.length, 2);
  assert.equal(createdZCodeSessions.length, 1);
});
```

Add sibling, active-child, unbound-child, stale-current-job, wrong-operation, and permission-change cases; capture job count before each rejection and assert zero new reservations/sends.

- [ ] **Step 2: Run the focused integration test and verify RED**

Run:

```bash
node --test --test-name-pattern='same-parent-turn generation|stopped Rescue child' tests/integration/companion.test.mjs
```

Expected: FAIL because the store cannot yet provide the required generation semantics to Companion or the resolved binding snapshot is discarded.

- [ ] **Step 3: Enforce stopped provenance and propagate the exact binding route**

After `consume()`, treat `requiredExecutorAgentId !== null` as a continuation-only record. Reject an active executor before reservation. For a stopped executor, resolve the exact binding once and pass its CAS snapshot:

```js
const binding = await createStateStore({ dataRoot }).resolveRescueBinding({
  ...bindingLookup(executor, cwd),
  ...(prepared.envelope.options.resume === 'resume' ? { permissionMode: caller.permissionMode } : {}),
});
if (binding.kind !== 'bound') throw boundExecutorMissing();
const rescueRoute = {
  routeKind: 'bound',
  candidateJobId: binding.anchorJobId,
  expectedOperationId: binding.operationId,
  expectedCurrentJobId: binding.currentJobId,
};
```

Pass `rescueRoute` into recursive `runCompanion()`. Keep public prepare output exactly `{ type: 'prepared', command: 'rescue' }`; do not render generation, child, binding, or session identifiers.

- [ ] **Step 4: Run integration, StateStore, and privacy tests**

Run:

```bash
node --test tests/integration/companion.test.mjs tests/rescue-binding.test.mjs
node --test tests/codex-rescue-qualification.test.mjs
```

Expected: PASS; StateStore schema remains unchanged, same child resumes exact anchor, and rejections have zero publication side effects.

- [ ] **Step 5: Commit the continuation slice**

```bash
git add scripts/zcode-companion.mjs tests/integration/companion.test.mjs
git commit -m "feat: resume Rescue within the active parent turn"
```

### Task 5: Refine Role readiness failures and update forwarder contracts

**Files:**
- Modify: `tests/integration/companion.test.mjs:331-455`
- Modify: `tests/managed-agent-role.test.mjs`
- Modify: `scripts/lib/managed-agent-role.mjs:57-60,179-213`
- Modify: `scripts/zcode-companion.mjs:39-79,740-758`
- Modify: `skills/rescue/SKILL.md:39-75`
- Modify: `agents/zcode-rescue.toml.template`
- Modify: `tests/helpers/rescue-skill-contract.mjs`
- Modify: `tests/skills-contracts.test.mjs`

- [ ] **Step 1: Write failing fixed-vocabulary Role-status tests**

Change catch-all expectations and add privacy assertions:

```js
assert.deepEqual(await roleStatusWithMissingInstalledCaller(), {
  type: 'role-status', role: 'zcode-rescue', status: 'caller-unavailable',
  remedy: 'Retry from an active owned parent turn.',
});
assert.deepEqual(await roleStatusWithInspectionError(new Error('PRIVATE_PATH_SENTINEL')), {
  type: 'role-status', role: 'zcode-rescue', status: 'inspection-unavailable',
  remedy: 'Retry Role preflight.',
});
assert.deepEqual(await roleStatusWithManagedResult({ status: 'unsupported' }), {
  type: 'role-status', role: 'zcode-rescue', status: 'unsupported', remedy: '$zcode:setup',
});
```

Assert rendered output excludes private thread, workspace, path, caught error, configuration layer, and stack. Keep source checkout `source-session-unproven` behavior unchanged.

- [ ] **Step 2: Run Role-status tests and verify RED**

Run:

```bash
node --test --test-name-pattern='role-status' tests/integration/companion.test.mjs tests/managed-agent-role.test.mjs
```

Expected: FAIL because missing caller, inspection exceptions, invalid results, and unusable config currently collapse to `unsupported/$zcode:setup`.

- [ ] **Step 3: Add one pure public classification boundary**

Add fixed status/remedy maps and a pure stage-aware classifier:

```js
const ROLE_REMEDIES = Object.freeze({
  'source-session-unproven': SOURCE_SESSION_REMEDY,
  'caller-unavailable': 'Retry from an active owned parent turn.',
  'inspection-unavailable': 'Retry Role preflight.',
});

function roleFailureStatus({ error, provenance, inspectionStarted }) {
  if (!inspectionStarted && provenance === 'source' && sourceRoleSessionFailure(error)) {
    return 'source-session-unproven';
  }
  if (!inspectionStarted) return 'caller-unavailable';
  return 'inspection-unavailable';
}
```

Accept `unsupported` only when returned as an exact managed host-capability result. Unknown/malformed results become `inspection-unavailable`. Change unusable config in `managed-agent-role.mjs` to a typed inspection-unavailable outcome or throw a fixed internal `PluginError`; do not infer from arbitrary message/category.

- [ ] **Step 4: Update Skill and Role fixed contracts**

Update the stopped-child route so the same still-active parent turn may prepare exactly one proactive `resume` generation and follow up the same stopped child. Update non-ready handling:

```text
caller-unavailable: retry from an active owned parent turn; never run setup.
inspection-unavailable: retry Role preflight; never prepare, spawn, or mutate setup.
source-session-unproven: use the active instance-bound launcher; never run setup.
managed install/upgrade/drift/conflict/unsupported: present the fixed setup remedy.
```

Keep the child assignment exactly unchanged and task-free. Update the Role template bytes so existing owned receipts become `upgrade-required` through the normal digest comparison.

- [ ] **Step 5: Run contract tests and commit**

Run:

```bash
node --test tests/integration/companion.test.mjs tests/managed-agent-role.test.mjs tests/skills-contracts.test.mjs
npm run lint
npm run typecheck
```

Expected: PASS; public output remains bounded and private identifiers never render.

Commit:

```bash
git add scripts/lib/managed-agent-role.mjs scripts/zcode-companion.mjs skills/rescue/SKILL.md agents/zcode-rescue.toml.template tests/integration/companion.test.mjs tests/managed-agent-role.test.mjs tests/helpers/rescue-skill-contract.mjs tests/skills-contracts.test.mjs
git commit -m "fix: classify Rescue readiness failures"
```

### Task 6: Qualify the full lifecycle, document behavior, and refresh marketplace mirrors

**Files:**
- Modify: `tests/helpers/codex-rescue-qualification.mjs:92-94,1181-1234`
- Modify: `tests/codex-rescue-qualification.test.mjs`
- Modify: `tests/e2e/codex-skills-e2e.test.mjs:876-964,1355-1468`
- Modify: `tests/e2e/real-zcode.test.mjs:36-146`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`
- Regenerate: `marketplace/plugins/zcode/**`

- [ ] **Step 1: Write failing synthetic qualification for one parent turn and two generations**

Replace the helper assertion that parent turn IDs differ. Capture generation 1 before replacement and generation 2 after replacement, then assert:

```js
assert.equal(initialPreparation.turnId, continuationPreparation.turnId);
assert.equal(initialPreparation.generation, 1);
assert.equal(initialPreparation.requiredExecutorAgentId, null);
assert.equal(continuationPreparation.generation, 2);
assert.equal(continuationPreparation.requiredExecutorAgentId, childThreadId);
assert.equal(spawnCalls.length, 1);
assert.equal(invokePreparedCalls.length, 2);
assert.equal(zcodeSessionIds.size, 1);
```

Advance injected time beyond the old 30-minute and 60-minute thresholds. Assert the active v2 turn still resolves, caller token/preparation generation TTLs remain bounded, and exactly one child/one ZCode session is used.

- [ ] **Step 2: Run qualification tests and verify RED**

Run:

```bash
node --test tests/codex-rescue-qualification.test.mjs tests/e2e/codex-skills-e2e.test.mjs
```

Expected: FAIL because current qualification expects two parent turns/two slots and v1 preparation records.

- [ ] **Step 3: Update deterministic and installed lifecycle qualification**

Capture consumed preparation bytes at each seam before same-slot replacement. Preserve all current privacy scans, one-execution-per-child-turn checks, fixed assignment checks, relay ordering, and zero second `SubagentStart`. Add negative mutations for generation, required executor, same-turn identity, and exact binding CAS values.

- [ ] **Step 4: Extend real authenticated ZCode qualification with an explicit test budget**

Wrap only the E2E Companion client creation:

```js
dependencies: {
  createManagedZCodeClient: (options) => createManagedZCodeClient({
    ...options,
    completionTimeoutMs: 180_000,
  }),
},
```

On one direct real `sessionId`, run two sequential `send`/`waitForCompletion`/`readSession` cycles and require two non-empty visible assistant results. Retain discovery, authentication, duplicate-send fencing, explicit stop, permission abort, model selection, and history import. This is controlled verification only; do not invoke a ZCode Rescue skill or delegate implementation/review to ZCode.

- [ ] **Step 5: Update release/security documentation**

Document these exact points in English and Chinese:

- ordinary Rescue completion has no plugin wall-clock deadline;
- request, review-gate, qualification, and one-shot artifact budgets remain bounded;
- Root Stop, replacement prompt, SessionEnd, `$zcode:cancel`, SIGINT, and SIGTERM remain authoritative termination boundaries;
- same-parent-turn continuation reuses the exact stopped child and exact bound ZCode session;
- Role-status distinguishes caller/inspection availability from managed setup states;
- existing owned managed Role installations require the normal one-time upgrade.

Add an Unreleased changelog entry; do not bump package/plugin version.

- [ ] **Step 6: Run deterministic qualification and commit source changes**

Run:

```bash
node --test tests/codex-rescue-qualification.test.mjs tests/e2e/codex-skills-e2e.test.mjs
node --test tests/plugin-contracts.test.mjs tests/release-contracts.test.mjs
git diff --check
```

Expected: PASS, with only the documented opt-in authenticated tests skipped.

Commit:

```bash
git add tests/helpers/codex-rescue-qualification.mjs tests/codex-rescue-qualification.test.mjs tests/e2e/codex-skills-e2e.test.mjs tests/e2e/real-zcode.test.mjs README.md README.zh-CN.md SECURITY.md CHANGELOG.md
git commit -m "test: qualify lifecycle-bound Rescue continuation"
```

- [ ] **Step 7: Generate marketplace mirrors from the clean exact source commit**

Build outside the repository from the clean commit:

```bash
SOURCE_SHA="$(git rev-parse HEAD)"
SNAPSHOT_PARENT="$(mktemp -d)"
node scripts/build-marketplace-snapshot.mjs \
  --output "$SNAPSHOT_PARENT/marketplace-snapshot" \
  --source-ref "$SOURCE_SHA" \
  --source-sha "$SOURCE_SHA"
```

Replace the checked-in `marketplace/plugins/zcode/` tree with the generated `plugins/zcode/` using the repository's existing snapshot refresh workflow, never by editing individual mirrors. Copy generated provenance/catalog files only when the builder output differs. Verify source/mirror parity:

```bash
node --test tests/marketplace-snapshot.test.mjs tests/integration/marketplace-snapshot-build.mjs
MARKETPLACE_SNAPSHOT="$SNAPSHOT_PARENT/marketplace-snapshot" \
MARKETPLACE_SOURCE_REF="$SOURCE_SHA" \
MARKETPLACE_SOURCE_SHA="$SOURCE_SHA" \
node --test tests/integration/marketplace-install.test.mjs
```

Expected: PASS.

Commit:

```bash
git add marketplace
git commit -m "build: refresh ZCode marketplace snapshot"
```

### Task 7: Final review, full verification, PR, and CI

**Files:**
- Review: all changes from `origin/main...HEAD`
- Modify only when a verified test/review/CI defect requires a fix.

- [ ] **Step 1: Run the complete local gate**

Run:

```bash
npm run check:line-endings
npm run lint
npm run typecheck
npm test
npm run test:qualified
git diff --check
git status --short
```

Expected: every deterministic check passes; credential-gated qualification may only use its existing structured skip.

- [ ] **Step 2: Run authenticated real-ZCode verification**

Run with the configured real model and installed CLI:

```bash
ZCODE_REAL_E2E=1 \
ZCODE_REQUIRE_QUALIFIED=1 \
ZCODE_REAL_E2E_MODEL="$ZCODE_REAL_E2E_MODEL" \
node --test tests/e2e/real-zcode.test.mjs
```

Expected: PASS with discovery/authentication, a non-empty read-only response, natural completion, duplicate-send fencing, explicit stop, permission abort, model selection, history import, and two sequential completed turns in one session. Record the exact command result without exposing credentials.

- [ ] **Step 3: Perform independent full-branch reviews**

Dispatch one fresh spec-compliance reviewer and then one fresh code-quality reviewer over:

```bash
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Fix every Critical or Important finding through the responsible implementer, rerun its focused tests, and request re-review until both reviewers approve.

- [ ] **Step 4: Push and create the PR**

```bash
git push -u origin fix/rescue-timeout-lifecycle
gh pr create --base main --head fix/rescue-timeout-lifecycle \
  --title "Fix lifecycle-bound Rescue completion" \
  --body-file /tmp/zcode-rescue-timeout-pr-body.md
```

The PR body must summarize incident cause, lifecycle-bound design, explicit remaining budgets, same-child generation safety, Role-status correction, deterministic/authenticated evidence, and the explicit statement that ZCode Rescue was not used for development or review.

- [ ] **Step 5: Monitor and repair CI until all required checks succeed**

```bash
gh pr checks --watch --fail-fast=false
gh pr view --json url,state,mergeStateStatus,statusCheckRollup
```

Diagnose any failure from its exact job log, fix on the same branch without force-push, rerun the relevant local check, push, and continue monitoring until every required check reports success.
