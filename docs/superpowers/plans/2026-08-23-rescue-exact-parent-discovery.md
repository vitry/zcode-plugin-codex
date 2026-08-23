# Rescue Exact-Parent Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Rescue route planning discover empty-preview persisted children from Codex's exact parent spawn graph so it never prescribes a colliding spawn name.

**Architecture:** Keep `listCodexThreadSpawnChildren` as the sole discovery interface, but initialize app-server with experimental API capability and scope every page to the exact `parentThreadId`. Retain all current validation and planner authorization; exact-parent rows are a complete occupied-path set, while only rows joined to private stopped-executor provenance are eligible for follow-up.

**Tech Stack:** Node.js 22.13 ESM, built-in `node:test`, Codex 0.147 app-server JSONL protocol, existing Companion/planner seams, verified marketplace builder.

---

### Task 1: Exact-parent app-server discovery

**Files:**
- Modify: `tests/helpers/fake-codex-app-server.mjs`
- Modify: `tests/codex-app-server.test.mjs`
- Modify: `scripts/lib/codex-app-server.mjs`

- [ ] **Step 1: Write the failing empty-preview relationship test**

Extend the fake server so `thread/list` can distinguish an unscoped global
query from an exact `parentThreadId` query. Add a test whose direct child has
`preview: ""`; assert the client returns it and records both:

```js
assert.deepEqual(calls[0].params.capabilities, { experimentalApi: true });
assert.equal(listCall.params.parentThreadId, parentId);
assert.equal(children[0].agentPath, '/root/zcode_rescue_task');
```

The fake global behavior must omit this row so removing the exact parent filter
makes the test fail with an empty child list.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test --test-name-pattern='empty-preview exact-parent' tests/codex-app-server.test.mjs
```

Expected: FAIL because initialize still sends `capabilities: null` and
`thread/list` omits `parentThreadId`, reproducing the production empty list.

- [ ] **Step 3: Implement the minimal protocol change**

Change only the list operation's app-server initialization/request behavior:

```js
const LIST_INITIALIZE_PARAMS = {
  clientInfo: INITIALIZE_PARAMS.clientInfo,
  capabilities: { experimentalApi: true },
};

request('thread/list', {
  parentThreadId,
  sourceKinds: ['subAgentThreadSpawn'],
  limit: pageSize,
  sortKey: 'created_at',
  sortDirection: 'desc',
  ...(cursor === null ? {} : { cursor }),
});
```

Do not change `thread/read` initialization. Remove the global foreign-row skip
from the list path: every row returned by an exact-parent query must pass the
existing full raw child validation for that parent.

- [ ] **Step 4: Add fail-closed exact-parent cases**

Cover missing/foreign/contradictory parent rows, unsupported capability or
request errors, duplicate IDs/paths across pages, cursor bounds, cancellation,
and reaping. Update old global-compatibility assertions so they no longer claim
that unrelated global rows are part of this interface.

- [ ] **Step 5: Run Task 1 verification**

Run:

```bash
node --test tests/codex-app-server.test.mjs
npm run lint
npm run typecheck
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 6: Commit Task 1**

```bash
git add scripts/lib/codex-app-server.mjs tests/codex-app-server.test.mjs tests/helpers/fake-codex-app-server.mjs
git commit -m "fix: discover exact persisted child graph"
```

### Task 2: Lock the collision incident and distribution contract

**Files:**
- Modify: `tests/integration/companion.test.mjs`
- Modify if required by copied critical bytes: `tests/plugin-contracts.test.mjs`
- Modify generated snapshot: `marketplace/`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write the failing Companion incident regression**

Add an installed-style prepare scenario where the fake exact-parent app-server
returns an empty-preview host child at `/root/zcode_rescue_task`, but the plugin
has no stopped-executor provenance for it. Assert:

```js
assert.deepEqual(prepared.route, {
  version: 1,
  action: 'spawn',
  taskName: 'zcode_rescue_task_2',
});
```

Also assert one exact-parent list request, zero follow-up/invoke actions, no
second prepare, and no private task text in public output.

- [ ] **Step 2: Run the incident regression and verify RED if Task 1 is reverted**

Run the new test green on Task 1, then temporarily execute it against the Task 1
parent commit (or revert only the Task 1 production hunk without committing).
Expected: the old client produces `zcode_rescue_task` or an empty discovery,
proving the test catches the reported collision. Restore Task 1 immediately.

- [ ] **Step 3: Update release guidance**

Document bilingually that direct-child discovery uses Codex's exact relationship
query because global listing omits empty-preview restored agents. State that an
unsupported exact-parent API fails preparation closed and never retries a spawn.
Record the fix under Unreleased in `CHANGELOG.md`.

- [ ] **Step 4: Regenerate the marketplace from a clean committed source**

Commit source/test/docs changes, temporarily remove only the three untracked
planning files from the worktree, run the repository's verified marketplace
builder, restore the planning files, and commit the generated snapshot. Never
hand-edit generated provenance.

- [ ] **Step 5: Run focused and full verification**

Run:

```bash
node --test tests/codex-app-server.test.mjs tests/integration/companion.test.mjs
npm run check
git diff --check origin/main...HEAD
```

The clean-source full gate must show zero failures. Opt-in authenticated Codex
and real ZCode skips remain documented rather than counted as qualification.

- [ ] **Step 6: Commit Task 2**

```bash
git add tests/integration/companion.test.mjs tests/plugin-contracts.test.mjs README.md README.zh-CN.md CHANGELOG.md marketplace
git commit -m "test: cover empty-preview Rescue collision"
```

### Task 3: Review, PR update, and CI

**Files:**
- Review: `origin/main...HEAD`

- [ ] **Step 1: Run independent spec review**

Require explicit confirmation that exact-parent discovery covers the incident,
host-only rows remain occupancy-only, and unsupported APIs fail closed.

- [ ] **Step 2: Run independent code-quality review**

Review validation bounds, experimental capability scope, pagination,
cancellation/reaping, fake-server fidelity, and whether tests would fail on the
old global implementation. Resolve every important finding and re-review.

- [ ] **Step 3: Push the existing PR branch**

```bash
git push origin fix/rescue-child-recovery
```

- [ ] **Step 4: Monitor PR #41 until all checks pass**

Use `gh pr checks --watch 41`. For each failure, read the exact job log, add a
red regression at the correct seam, fix only the confirmed root cause, rerun
local verification, and push. Finish only when the PR head matches local HEAD,
the merge state is clean, and every required matrix job succeeds.

