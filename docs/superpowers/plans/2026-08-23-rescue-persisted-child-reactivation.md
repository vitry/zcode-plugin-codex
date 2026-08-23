# Rescue Persisted Child Reactivation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover an exact persisted stopped Rescue child across a resumed parent Codex turn, with the plugin planning one follow-up-or-spawn action from public app-server metadata plus private executor provenance.

**Architecture:** A bounded Codex app-server adapter returns sanitized persisted thread-spawn children. A new Rescue route planner joins that host identity to the existing routed stopped-executor proof, while preparation v3 stores a one-shot spawn or reactivate activation. The Companion prepares the route and independently rereads child host metadata at consume time; Root only executes the task-free directive.

**Tech Stack:** Node.js 22.13 ESM, built-in `node:test`, Codex 0.147 app-server JSONL protocol, existing private JSON state/locks, ESLint, TypeScript checkJs, verified marketplace builder.

---

## File Structure

- Modify `scripts/lib/codex-app-server.mjs`: one bounded sequential app-server transport, sanitized thread-spawn list/read APIs, pagination and metadata validation.
- Modify `tests/fixtures/fake-codex-app-server.mjs`: deterministic `thread/list` page responses.
- Modify `tests/codex-app-server.test.mjs`: protocol, pagination, validation, redaction, and process-lifecycle coverage.
- Modify `scripts/lib/rescue-preparation.mjs`: version-three activation codec and atomic save/consume proof.
- Modify `tests/rescue-preparation.test.mjs`: activation RED/GREEN and compatibility mutation matrix.
- Modify `hooks/lib/hook-state.mjs`: narrow stopped routed-executor proof wrapper with no new storage or authority.
- Modify `tests/hooks.test.mjs`: wrapper expiry, route, Role, state, and no-mutation coverage.
- Create `scripts/lib/rescue-route-planner.mjs`: host/plugin identity join, binding-aware candidate selection, occupied-path allocation, exact route directive.
- Create `tests/rescue-route-planner.test.mjs`: focused planner and directive tests.
- Modify `scripts/zcode-companion.mjs`: prepare route planning and child-side host proof/activation consumption.
- Modify `tests/integration/companion.test.mjs`: incident-shaped cross-parent-turn stopped-unbound fresh regression and exact resume coverage.
- Modify `tests/integration/skills.test.mjs`: linked-worktree installed-style reactivation.
- Modify `skills/rescue/SKILL.md` and `tests/helpers/rescue-skill-contract.mjs`: Root consumes exactly one plugin-prescribed directive.
- Modify `tests/skills-contracts.test.mjs`: exact route/no-fallback public contract.
- Modify `tests/helpers/codex-rescue-qualification.mjs`, `tests/codex-rescue-qualification.test.mjs`, and `tests/e2e/codex-skills-e2e.test.mjs`: separate restored-child captured qualification.
- Modify `tests/e2e/real-zcode.test.mjs`: pre-credit installed recovery preflight.
- Modify `README.md`, `README.zh-CN.md`, `SECURITY.md`, `CHANGELOG.md`, and `tests/release-contracts.test.mjs`: public recovery and security semantics.
- Modify `scripts/build-marketplace-snapshot.mjs`, `tests/marketplace-snapshot.test.mjs`, and `tests/plugin-contracts.test.mjs`: critical payload and source/mirror parity.
- Regenerate `marketplace/plugins/zcode/**` from a clean committed source SHA.

### Task 1: Bounded persisted child discovery through Codex app-server

**Files:**
- Modify: `tests/codex-app-server.test.mjs`
- Modify: `tests/fixtures/fake-codex-app-server.mjs`
- Modify: `scripts/lib/codex-app-server.mjs`

- [ ] **Step 1: Lock the existing Transfer read contract before refactoring**

Add assertions to the existing first test so `readCodexThread()` still returns the raw complete thread and sends exactly:

```js
assert.deepEqual(calls[0].params, {
  clientInfo: { name: 'zcode-plugin-codex', title: 'ZCode plugin for Codex', version: '0.1.0' },
  capabilities: null,
});
assert.deepEqual(calls[2], {
  id: 2,
  method: 'thread/read',
  params: { threadId: 'thread-1', includeTurns: true },
});
```

- [ ] **Step 2: Add failing list/read sanitization tests**

Add a full 0.147 child factory and helpers:

```js
function childThread(overrides = {}) {
  return {
    id: 'child-1', sessionId: 'parent-1', parentThreadId: 'parent-1',
    ephemeral: false, preview: '', projectId: null, historyMode: 'legacy',
    modelProvider: 'openai', createdAt: 1, updatedAt: 2, recencyAt: 2,
    status: { type: 'notLoaded' }, path: null, cwd: '/repo',
    source: { subAgent: { thread_spawn: {
      parent_thread_id: 'parent-1', depth: 1,
      agent_path: '/root/zcode_rescue_task', agent_nickname: null,
      agent_role: 'zcode-rescue',
    } } },
    canAcceptDirectInput: null, threadSource: null, agentNickname: null,
    agentRole: 'zcode-rescue', gitInfo: null, name: null, turns: [],
    ...overrides,
  };
}
```

Test two list pages, local exact-parent filtering, `notLoaded` acceptance, and child reread:

```js
const children = await listCodexThreadSpawnChildren('parent-1', options);
assert.deepEqual(children, [{
  id: 'child-1', parentThreadId: 'parent-1',
  agentPath: '/root/zcode_rescue_task', agentRole: 'zcode-rescue',
  cwd: '/repo', status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2,
}]);
assert.equal(calls.some((call) => Object.hasOwn(call.params ?? {}, 'parentThreadId')), false);
assert.deepEqual(await readCodexThreadSpawnChild('child-1', 'parent-1', options), children[0]);
```

Add table-driven failures for contradictory parent/source parent, top-level/nested Role mismatch, missing/relative/control-bearing agent path, unsafe cwd, unknown status, duplicate ID, duplicate path, unsafe/repeated cursor, page/item limits, malformed result, JSON-RPC error, timeout, and disconnect. Assert error chains do not contain injected IDs, paths, or remote secrets.

- [ ] **Step 3: Run RED and confirm the missing exports fail for the intended reason**

Run:

```bash
node --test tests/codex-app-server.test.mjs
```

Expected: FAIL because `listCodexThreadSpawnChildren` and `readCodexThreadSpawnChild` are not exported.

- [ ] **Step 4: Extend the fake app-server with deterministic list pages**

Add `threadListIndex` and the request branch:

```js
let threadListIndex = 0;

if (request.method === 'thread/list') {
  const pages = JSON.parse(process.env.FAKE_CODEX_THREAD_LIST_RESULTS_JSON ??
    '{"data":[],"nextCursor":null,"backwardsCursor":null}');
  const result = Array.isArray(pages)
    ? pages[Math.min(threadListIndex++, pages.length - 1)]
    : pages;
  write({ id: request.id, result });
  return;
}
```

Keep the existing generic hang/malformed/oversize/error/ambiguous branches ahead of this handler.

- [ ] **Step 5: Refactor one bounded transport and implement the sanitized APIs**

Keep `readCodexThread` externally unchanged. Add exports with exact signatures:

```js
export async function listCodexThreadSpawnChildren(parentThreadId, options = {}) {}
export async function readCodexThreadSpawnChild(threadId, parentThreadId, options = {}) {}
```

Use one short-lived sequential request runner with a single global timeout and output budget. List requests must use:

```js
{
  sourceKinds: ['subAgentThreadSpawn'],
  limit: pageSize,
  sortKey: 'created_at',
  sortDirection: 'desc',
  ...(cursor === null ? {} : { cursor }),
}
```

Do not send the experimental `parentThreadId`. Add strict bounds such as `pageSize <= 100`, `maxPages <= 32`, `maxItems <= 1024`, and a bounded cursor set. Sanitize every record through one private `validateThreadSpawnChild(thread, expectedParentId, expectedChildId)` and defensively clone its status.

- [ ] **Step 6: Run focused GREEN, lint, and typecheck**

Run:

```bash
node --test tests/codex-app-server.test.mjs
npm run lint
npm run typecheck
```

Expected: all exit 0.

- [ ] **Step 7: Commit the adapter**

```bash
git add scripts/lib/codex-app-server.mjs tests/codex-app-server.test.mjs tests/fixtures/fake-codex-app-server.mjs
git commit -m "feat: discover persisted Codex child threads"
```

### Task 2: Version-three preparation activation

**Files:**
- Modify: `tests/rescue-preparation.test.mjs`
- Modify: `scripts/lib/rescue-preparation.mjs`

- [ ] **Step 1: Add failing spawn/reactivate round-trip tests**

Define exact fixtures:

```js
const spawnActivation = {
  kind: 'spawn', taskName: 'zcode_rescue_task', agentPathDigest: 'a'.repeat(64),
};
const reactivateActivation = {
  kind: 'reactivate', executorAgentId: 'rescue-child', agentPathDigest: 'b'.repeat(64),
};
```

Save generation one with each activation and consume with a host proof:

```js
await store.save({ ...base, envelope: validEnvelope, activation: reactivateActivation });
const record = await store.consume({
  ...base, executorAgentId: 'rescue-child',
  activationProof: { kind: 'reactivate', agentPathDigest: 'b'.repeat(64) },
});
assert.equal(record.version, 3);
assert.deepEqual(record.activation, reactivateActivation);
```

Add failures for sibling executor, wrong kind/digest/task name, replay, expiry, missing proof, unknown keys, invalid digest, spawn containing an executor, reactivate containing a task name, generation-one non-null required executor, and generation-greater-than-one non-null activation.

- [ ] **Step 2: Prove legacy and same-turn continuation behavior stays unchanged**

Extend the generation 2–4 test with:

```js
assert.equal(current.activation, null);
assert.equal(current.requiredExecutorAgentId, 'rescue-child');
```

Keep v1 and v2 fixtures readable and consumable under their current strict rules. A consumed v1/v2 record replaced by proactive same-turn resume must produce version 3, generation 2, `activation: null`, and the exact required executor.

- [ ] **Step 3: Run RED**

Run:

```bash
node --test tests/rescue-preparation.test.mjs
```

Expected: FAIL because `activation` and `activationProof` are not accepted.

- [ ] **Step 4: Implement the v3 codec and atomic proof**

Bump the record version and add exact keys/codecs:

```js
const RESCUE_PREPARATION_RECORD_VERSION = 3;
const V3_RECORD_KEYS = Object.freeze([
  'activation', 'consumedAt', 'createdAt', 'envelope', 'executorAgentId',
  'expiresAt', 'generation', 'key', 'permissionMode',
  'requiredExecutorAgentId', 'sessionId', 'source', 'turnId', 'version',
  'workspace',
]);
```

Generation-one save requires a validated activation. Generation successors set
`activation: null`; they must not inherit the prior cross-turn activation.
During consume, validate `activationProof` and compare kind/digest plus the
reactivate executor under the existing preparation lock before publication of
`consumedAt`.

- [ ] **Step 5: Run focused GREEN and adjacent tests**

Run:

```bash
node --test tests/rescue-preparation.test.mjs tests/integration/companion.test.mjs
npm run lint
npm run typecheck
```

Expected: all exit 0; existing companion fixtures may require explicit legacy-compatible save defaults only if the tests prove the production caller has not yet been migrated.

- [ ] **Step 6: Commit the activation codec**

```bash
git add scripts/lib/rescue-preparation.mjs tests/rescue-preparation.test.mjs
git commit -m "feat: bind Rescue preparations to child activation"
```

### Task 3: Deep Rescue route planner and stopped executor proof

**Files:**
- Modify: `hooks/lib/hook-state.mjs`
- Modify: `tests/hooks.test.mjs`
- Create: `scripts/lib/rescue-route-planner.mjs`
- Create: `tests/rescue-route-planner.test.mjs`

- [ ] **Step 1: Add a failing narrow stopped-executor wrapper test**

Reuse the existing linked-worktree fixture, stop its exact child, and assert:

```js
const resolved = await resolveRoutedStoppedForwardingExecutor(
  fixture.data, fixture.origin, fixture.start.agent_id,
  { now: new Date(Date.parse(fixture.start.created_at) + 31 * 60_000) },
);
assert.equal(resolved.executor.active, false);
assert.equal(resolved.executionWorkspace, await realpath(fixture.target));
```

Assert active, wrong Role, corrupt/ambiguous route, and target drift fail without mutating hook-state bytes.

- [ ] **Step 2: Implement only the narrow wrapper**

```js
export async function resolveRoutedStoppedForwardingExecutor(
  dataRoot, originWorkspace, agentId, options = {},
) {
  return resolveRoutedForwardingExecutor(dataRoot, originWorkspace, agentId, {
    ...options, continuation: true, durableProvenance: true,
  });
}
```

Validate options so callers cannot override the fixed stopped/durable flags.

- [ ] **Step 3: Add failing planner tests**

Test the wished-for interface with injected adapters:

```js
const planned = await planRescueActivation({
  dataRoot, caller, envelope,
  listChildren: async () => [persistedChild],
  resolveStoppedExecutor: async () => ({ executor, executionWorkspace }),
  resolveBinding: async () => ({ kind: 'missing' }),
});
assert.deepEqual(planned.directive, {
  version: 1, action: 'followup', target: '/root/zcode_rescue_task',
});
assert.deepEqual(planned.activation, {
  kind: 'reactivate', executorAgentId: executor.agentId,
  agentPathDigest: createHash('sha256').update('/root/zcode_rescue_task').digest('hex'),
});
```

Cover root and linked-worktree joins, exact binding selection for resume,
base-then-newest compatible selection for fresh, incompatible occupied paths,
first free ordinal spawn, wrong parent/Role/permission/workspace, ambiguous
binding/path/ID, incomplete discovery, and exact directive key validation.

- [ ] **Step 4: Run planner RED**

Run:

```bash
node --test tests/hooks.test.mjs tests/rescue-route-planner.test.mjs
```

Expected: FAIL because the wrapper and planner module do not exist.

- [ ] **Step 5: Implement the planner as one deep module**

Export only the high-level planner and exact directive validator/renderer:

```js
export async function planRescueActivation(input) {}
export function validateRescueRouteDirective(value) {}
```

The planner calls stable child discovery by default, resolves each potential
Rescue candidate through the stopped wrapper, treats exact not-found as an
occupied noncandidate, propagates corruption/ambiguity, checks parent session
and immutable execution workspace, consults exact binding only for resume, and
returns `{ activation, directive }`. No public error may include a child ID,
path, workspace, Role record, or app-server payload.

- [ ] **Step 6: Run focused GREEN**

```bash
node --test tests/hooks.test.mjs tests/rescue-route-planner.test.mjs
npm run lint
npm run typecheck
```

Expected: all exit 0.

- [ ] **Step 7: Commit the planner**

```bash
git add hooks/lib/hook-state.mjs tests/hooks.test.mjs scripts/lib/rescue-route-planner.mjs tests/rescue-route-planner.test.mjs
git commit -m "feat: plan persisted Rescue child routes"
```

### Task 4: Companion prepare and child reactivation

**Files:**
- Modify: `scripts/zcode-companion.mjs`
- Modify: `tests/integration/companion.test.mjs`
- Modify: `tests/integration/skills.test.mjs`

- [ ] **Step 1: Add the incident-shaped failing integration test**

Beside the same-parent-turn continuation tests, create an old stopped child in
a linked worktree, stop it, replace the parent active turn, leave it unbound,
and inject app-server discovery/read adapters. Assert prepare returns:

```js
assert.deepEqual(prepared, {
  type: 'prepared', command: 'rescue',
  route: { version: 1, action: 'followup', target: '/root/zcode_rescue_task' },
});
```

Invoke the original child ID and assert a fresh job succeeds with zero prior
binding. Capture job count and fake ZCode calls before each mutation; wrong
ambient child, wrong read path/parent/Role, wrong workspace/permission, replay,
expiry, and missing executor provenance must fail before either count changes.

- [ ] **Step 2: Add exact resume and active-spawn regressions**

Add a second cross-parent-turn test where `resume` follows only the exact bound
child/session. Add a spawn-route test proving the new active child rereads its
host metadata, matches task name/path digest, and retains
`assertExecutorMatchesCaller`. Keep the existing generation-greater-than-one
unbound continuation rejection unchanged.

- [ ] **Step 3: Run RED**

```bash
node --test --test-name-pattern='reactivat|persisted|same-parent-turn' tests/integration/companion.test.mjs tests/integration/skills.test.mjs
```

Expected: FAIL because prepare still returns the legacy acknowledgement and
stopped unbound execution still requires a binding.

- [ ] **Step 4: Integrate prepare-time planning**

In the prepare branch:

```js
const planned = await (runtime.dependencies?.planRescueActivation ?? planRescueActivation)({
  dataRoot, caller, envelope, env: codexAppServerOptions(env, caller.workspace),
});
await createRescuePreparationStore({ dataRoot }).save({
  ...caller, recordedPrompt: caller.prompt, envelope,
  activation: planned.activation, signal: runtime.signal,
});
return { type: 'prepared', command: 'rescue', route: planned.directive };
```

Preserve the raw TTY ordering: readiness, one private frame, plan/save, final
task-free directive, transport close.

- [ ] **Step 5: Integrate child-side independent host proof**

For `invoke-prepared`, reread the ambient child through
`readCodexThreadSpawnChild`, derive its path digest, resolve active spawn or
exact stopped activation, then pass the proof to preparation consume.

Branch after consume:

```js
const reactivatedFresh = prepared.generation === 1
  && prepared.activation?.kind === 'reactivate'
  && prepared.envelope.options.resume === 'fresh';
```

Only `reactivatedFresh` may skip prior binding. Resume and generation greater
than one retain exact binding resolution and reservation guards. Do not rewrite
the stopped executor record to active.

- [ ] **Step 6: Run focused GREEN and the entire integration file**

```bash
node --test tests/integration/companion.test.mjs tests/integration/skills.test.mjs
npm run lint
npm run typecheck
```

Expected: all exit 0.

- [ ] **Step 7: Commit Companion integration**

```bash
git add scripts/zcode-companion.mjs tests/integration/companion.test.mjs tests/integration/skills.test.mjs
git commit -m "fix: reactivate persisted Rescue children"
```

### Task 5: Root skill contract and captured qualification

**Files:**
- Modify: `skills/rescue/SKILL.md`
- Modify: `tests/helpers/rescue-skill-contract.mjs`
- Modify: `tests/skills-contracts.test.mjs`
- Modify: `tests/helpers/codex-rescue-qualification.mjs`
- Modify: `tests/codex-rescue-qualification.test.mjs`
- Modify: `tests/e2e/codex-skills-e2e.test.mjs`
- Modify: `tests/e2e/real-zcode.test.mjs`

- [ ] **Step 1: Write failing exact Skill-contract tests**

Replace the old “Root chooses presentation name” expectation with assertions
that the Skill:

```js
assert.match(block, /active[^\n]+rejoin[^\n]+first/i);
assert.match(block, /prepared[^\n]+action[^\n]+followup[\s\S]+exact[^\n]+target/i);
assert.match(block, /prepared[^\n]+action[^\n]+spawn[\s\S]+exact[^\n]+taskName/i);
assert.match(block, /must not[^\n]+collision[^\n]+fallback/i);
assert.doesNotMatch(block, /Root chooses[^\n]+rescueTaskName/i);
```

Add malformed/extra-key/wrong-action/path/task-name rejection language and
one-action-only assertions.

- [ ] **Step 2: Add a separate failing restored-child qualification fixture**

Do not alter the same-turn generation-two fixture. Add a fixture whose parent
is resumed, original child runtime is initially unloaded, preparation contains
generation-one reactivate activation, parent performs one follow-up and zero
spawns, and child performs one fixed launcher execution in the immutable target
worktree. Assert original child thread/path equality and absence of a collision
event.

- [ ] **Step 3: Run RED**

```bash
node --test tests/skills-contracts.test.mjs tests/codex-rescue-qualification.test.mjs tests/e2e/codex-skills-e2e.test.mjs
```

Expected: FAIL on the legacy acknowledgement/name-selection contract.

- [ ] **Step 4: Rewrite the Skill route section and qualification parsers**

The Skill must preserve active-child rejoin as first precedence, run one Role
preflight and one TTY preparation, strictly parse the terminal route object,
then execute exactly:

```text
followup -> followup_task(target, fixed invoke-prepared assignment)
spawn    -> spawn_agent(task_name, fixed Role/generic policy, fixed assignment)
```

It must not derive ordinals, spawn before the directive, follow up another
target, or perform a second host action after rejection. Update qualification
parsers for v3 activation and route directive while retaining privacy scans.

- [ ] **Step 5: Strengthen the real qualification preflight without spending credits**

Before the opt-in authenticated route starts ZCode, prove installed app-server
discovery, route planning, exact original ID/path, and immutable worktree
authority. Leave model-credit execution under its existing environment gate.

- [ ] **Step 6: Run focused GREEN**

```bash
node --test tests/skills-contracts.test.mjs tests/codex-rescue-qualification.test.mjs tests/e2e/codex-skills-e2e.test.mjs tests/e2e/real-zcode.test.mjs
npm run lint
npm run typecheck
```

Expected: all non-opt-in tests pass; authenticated tests report only their
existing explicit unqualified skips when credentials/flags are absent.

- [ ] **Step 7: Commit the host contract**

```bash
git add skills/rescue/SKILL.md tests/helpers/rescue-skill-contract.mjs tests/skills-contracts.test.mjs tests/helpers/codex-rescue-qualification.mjs tests/codex-rescue-qualification.test.mjs tests/e2e/codex-skills-e2e.test.mjs tests/e2e/real-zcode.test.mjs
git commit -m "feat: route Rescue through persisted child recovery"
```

### Task 6: Release documentation, critical payload, and marketplace snapshot

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`
- Modify: `tests/release-contracts.test.mjs`
- Modify: `scripts/build-marketplace-snapshot.mjs`
- Modify: `tests/marketplace-snapshot.test.mjs`
- Modify: `tests/plugin-contracts.test.mjs`
- Regenerate: `marketplace/plugins/zcode/**`

- [ ] **Step 1: Add failing release and payload contract assertions**

Require both languages to explain that persisted stopped children recover
before spawn, the original thread/history is restored, app-server identity is
joined with private executor provenance, active children are rejoined, and
neither 30-minute age nor collision is authority. Add
`scripts/lib/codex-app-server.mjs` and
`scripts/lib/rescue-route-planner.mjs` to the exact critical payload/parity
expectations.

- [ ] **Step 2: Run RED**

```bash
node --test tests/release-contracts.test.mjs tests/marketplace-snapshot.test.mjs tests/plugin-contracts.test.mjs
```

Expected: FAIL because docs and critical payload do not yet state/include the
new recovery surface.

- [ ] **Step 3: Update source documentation and payload declarations**

Update the Rescue operating paragraphs in English and Chinese, add the security
join/activation invariant, and add one Unreleased changelog bullet. Add both
runtime files to `REQUIRED_RESCUE_PAYLOAD` and source/mirror parity lists. Do not
publish private command names, activation fields, thread IDs, storage paths, or
raw app-server shapes.

- [ ] **Step 4: Run source-side focused GREEN and commit**

```bash
node --test tests/release-contracts.test.mjs tests/marketplace-snapshot.test.mjs tests/plugin-contracts.test.mjs
npm run lint
npm run typecheck
git add README.md README.zh-CN.md SECURITY.md CHANGELOG.md tests/release-contracts.test.mjs scripts/build-marketplace-snapshot.mjs tests/marketplace-snapshot.test.mjs tests/plugin-contracts.test.mjs
git commit -m "docs: explain persisted Rescue child recovery"
```

Expected: tests/lint/typecheck exit 0 and the source-side documentation commit
is clean.

- [ ] **Step 5: Build the verified marketplace snapshot from the clean commit**

Resolve explicit paths before the mechanical replacement:

```bash
source_sha=$(git rev-parse HEAD)
snapshot_root=$(mktemp -d)
node scripts/build-marketplace-snapshot.mjs \
  --output "$snapshot_root/output" \
  --source-ref HEAD \
  --source-sha "$source_sha"
test -f "$snapshot_root/output/plugins/zcode/.codex-plugin/plugin.json"
rsync -a --delete "$snapshot_root/output/plugins/zcode/" "$(pwd)/marketplace/plugins/zcode/"
```

The target is the exact version-controlled plugin snapshot, so the mechanical
replacement is recoverable through Git. Do not target the workspace root.

- [ ] **Step 6: Verify mirror parity and commit the generated snapshot**

```bash
node --test tests/plugin-contracts.test.mjs tests/marketplace-snapshot.test.mjs tests/integration/marketplace-snapshot-build.mjs
git diff --check
git add marketplace/plugins/zcode
git commit -m "build: refresh ZCode marketplace snapshot"
```

Expected: all exit 0 and the generated mirror is byte-for-byte qualified.

### Task 7: Whole-change verification and final review

**Files:**
- Review all changes from `fc6fb10051a57b777cc5d6ed8f5cb0fde98faf53` to `HEAD`.

- [ ] **Step 1: Run focused incident and security regressions**

```bash
node --test tests/codex-app-server.test.mjs tests/rescue-preparation.test.mjs tests/rescue-route-planner.test.mjs tests/hooks.test.mjs tests/integration/companion.test.mjs tests/integration/skills.test.mjs tests/skills-contracts.test.mjs tests/codex-rescue-qualification.test.mjs
```

Expected: exit 0.

- [ ] **Step 2: Run the full repository gate**

```bash
npm run check:line-endings
npm run lint
npm run typecheck
npm test
npm run test:qualified
```

Expected: every command exits 0; opt-in authenticated tests may only use their
documented explicit skip/unqualified result under the non-required command.

- [ ] **Step 3: Verify the diff and requirement checklist**

```bash
git status --short
git diff --check origin/main...HEAD
git log --oneline origin/main..HEAD
```

Read the design spec line by line and map every goal, non-goal, invariant,
error, compatibility rule, test, and documentation requirement to code/tests.
Planning files remain untracked and are not part of the PR.

- [ ] **Step 4: Dispatch an independent final spec reviewer**

Provide the reviewer the full design spec, base SHA, head SHA, and exact diff.
Fix every Critical or Important spec gap with a failing regression test first,
then rerun the focused and full gates and re-request review.

- [ ] **Step 5: Dispatch an independent final code-quality reviewer**

Review only after spec compliance is approved. Require attention to protocol
bounds, app-server process cleanup, duplicate/path ambiguity, private data
redaction, lock atomicity, cross-version codecs, worktree routing, and test
quality. Fix and re-review every Critical or Important issue.

- [ ] **Step 6: Prepare the PR**

```bash
git status --short
git push -u origin fix/rescue-child-recovery
gh pr create --base main --head fix/rescue-child-recovery \
  --title "fix: reactivate persisted Rescue children" \
  --body-file /tmp/zcode-rescue-child-recovery-pr.md
```

The PR body must summarize exact child restoration, plugin-owned route planning,
legacy/worktree compatibility, RED/GREEN evidence, full verification, and the
fact that ZCode Rescue was not used.

- [ ] **Step 7: Monitor required CI until success**

```bash
gh pr checks --watch --interval 20 <PR_NUMBER>
```

For any failure, inspect the exact job log, reproduce locally when possible,
add or correct a regression test, commit, push, and watch the new run. Do not
claim completion until every required check reports success on the current PR
head.
