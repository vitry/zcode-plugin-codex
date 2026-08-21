# Rescue Worktree Late Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one active owned Codex parent turn automatically bind Rescue to an eligible linked worktree at private preparation time, without a visible handoff or weakened identity checks.

**Architecture:** Add one deep `RescueAuthorityStore` at a data-root lifecycle seam. The prompt hook records an unbound Rescue turn derived from exact SessionStart proof, Role readiness previews it read-only, and private prepare atomically binds one canonical same-repository execution workspace before accepting task bytes. Existing generic caller identity stays workspace-local; all downstream Rescue state stays strictly local to the bound target.

**Tech Stack:** Node.js 22.13 ESM, strict JSON/file identity helpers, advisory file locks, Git CLI without shell, `node:test`, Codex hook integration tests, authenticated ZCode 0.16.3 opt-in qualification, generated marketplace snapshot, GitHub Actions.

---

## File and Module Map

- Create `scripts/lib/rescue-authority.mjs`: deep module owning the record codec, private data-root storage, Git common-dir eligibility, atomic preview/bind/end operations, legacy absence distinction, and fixed errors.
- Create `tests/rescue-authority.test.mjs`: tests only the module interface with real temporary repositories/worktrees and injected bounded process seams where necessary.
- Modify `hooks/user-prompt-hook.mjs`: derive Rescue authority from the exact origin SessionStart record and clean a replaced target preparation.
- Modify `scripts/zcode-companion.mjs`: preview authority for installed Role readiness, bind before private preparation transport, and resolve the bound target at child/invocation boundaries.
- Modify `hooks/lib/hook-state.mjs` and `hooks/subagent-hook.mjs`: split origin forwarding markers from target executor records and locate only authority-named workspaces.
- Modify `hooks/stop-review-gate-hook.mjs` and `hooks/session-end-hook.mjs`: revoke global authority first, then clean only validated returned targets under existing budgets.
- Modify `tests/identity.test.mjs`, `tests/hooks.test.mjs`, `tests/integration/companion.test.mjs`, `tests/integration/skills.test.mjs`, and `tests/rescue-binding.test.mjs`: preserve legacy exact-workspace behavior and exercise the complete late-binding route.
- Modify `tests/helpers/codex-rescue-qualification.mjs`, `tests/codex-rescue-qualification.test.mjs`, `tests/e2e/codex-skills-e2e.test.mjs`, and `tests/e2e/real-zcode.test.mjs`: distinguish origin and execution workspaces and qualify raw authority transitions plus real responses.
- Modify `README.md`, `README.zh-CN.md`, `SECURITY.md`, `CHANGELOG.md`, `docs/adr/0010-use-thread-bound-direct-companion.md`, `docs/adr/0013-bind-rescue-child-to-zcode-session.md`, and `tests/release-contracts.test.mjs`: publish the automatic, immutable, same-repository contract.
- Regenerate `marketplace/plugins/zcode/**`, `.agents/plugins/marketplace.json`, and `.agents/plugins/provenance.json` only with `scripts/build-marketplace-snapshot.mjs` from a clean exact source SHA.

## Task 1: Deep Rescue Authority Module

**Files:**
- Create: `scripts/lib/rescue-authority.mjs`
- Create: `tests/rescue-authority.test.mjs`

- [ ] **Step 1: Write RED tests for the external interface and exact record**

Create a real temporary Git repository, commit one file, and create two linked
worktrees. Exercise this wished-for interface:

```js
import { createRescueAuthorityStore } from '../scripts/lib/rescue-authority.mjs';

const authority = createRescueAuthorityStore({ dataRoot });
const begun = await authority.beginTurn({
  sessionId: 'parent-session',
  turnId: 'parent-turn',
  originWorkspace: root,
  permissionMode: 'workspace-write',
  prompt: 'repair the worktree',
  sessionStartedAt: '2026-08-21T06:00:00.000Z',
  sessionSource: 'startup',
  now: '2026-08-21T06:00:01.000Z',
});
assert.deepEqual(begun, { replacedTurn: null });

const preview = await authority.previewTurn({
  sessionId: 'parent-session', candidateWorkspace: worktreeA,
});
assert.equal(preview.workspace, await realpath(worktreeA));
assert.equal(preview.turnId, 'parent-turn');
assert.equal((await readPersistedAuthority()).activeTurn.executionWorkspace, null);

const bound = await authority.bindTurn({
  sessionId: 'parent-session', candidateWorkspace: worktreeA,
});
assert.equal(bound.workspace, await realpath(worktreeA));
assert.equal((await authority.resolveBoundTurn({
  sessionId: 'parent-session', workspace: worktreeA,
})).workspace, await realpath(worktreeA));
```

The raw record assertion must require the exact v1 keys from the design, one
null-to-canonical binding transition, a canonical key/filename match, private
file modes, and no caller token, launcher command, task frame, job/child/ZCode
ID, or Git output.

- [ ] **Step 2: Run the focused test and record the expected RED**

Run:

```bash
node --test tests/rescue-authority.test.mjs
```

Expected: FAIL because `scripts/lib/rescue-authority.mjs` does not exist. Do not
write production code until this exact failure is observed.

- [ ] **Step 3: Add RED coverage for eligibility, contention, lifecycle, and corruption**

Add separate tests requiring:

```js
assert.equal((await authority.previewTurn({ sessionId, candidateWorkspace: origin })).workspace, canonicalOrigin);
await assert.rejects(authority.previewTurn({ sessionId, candidateWorkspace: unrelatedRepo }), { code: 'RESCUE_WORKSPACE_INELIGIBLE' });
await assert.rejects(authority.previewTurn({ sessionId, candidateWorkspace: nonGitDirectory }), { code: 'RESCUE_WORKSPACE_INELIGIBLE' });

const outcomes = await Promise.allSettled([
  ...Array.from({ length: 8 }, () => authority.bindTurn({ sessionId, candidateWorkspace: worktreeA })),
  ...Array.from({ length: 8 }, () => authority.bindTurn({ sessionId, candidateWorkspace: worktreeB })),
]);
const winners = outcomes.filter((entry) => entry.status === 'fulfilled');
assert.ok(winners.length >= 1);
assert.equal(new Set(winners.map((entry) => entry.value.workspace)).size, 1);
```

Also require idempotent same-target bind, immutable other-target rejection,
session/turn/permission isolation, defensive returned copies, replacement turn
metadata, exact endTurn, crash-safe endSession tombstone, strictly newer
SessionStart reopening, 16-workspace capacity, malformed/duplicate/oversized/
future-version record failure, symlink/path identity failure, Git timeout and
output bounds, and fixed errors that contain none of the private sentinels.

- [ ] **Step 4: Implement the minimal deep module**

Expose only:

```js
export function createRescueAuthorityStore({ dataRoot, dependencies = {} }) {
  return Object.freeze({ beginTurn, previewTurn, bindTurn, resolveBoundTurn, endTurn, endSession });
}
```

Keep the Git runner, strict codec, bounded reader, storage paths, record key,
eligibility comparison, and test-only dependency seams private. Canonicalize
workspaces with `resolveWorkspaceStorage`. Execute Git with `execFile` and exact
argv `['rev-parse', '--path-format=absolute', '--git-common-dir']`, `shell:false`,
bounded buffer, and fixed timeout. Treat non-Git origin/candidate as eligible
only when their canonical workspace paths are equal.

Linearize every record mutation under `<dataRoot>/rescue-authority/.lock` and
never acquire a workspace lock inside it. Validate the complete persisted record
before reading any authority field. Return fresh caller-shaped objects:

```js
{
  sessionId: record.sessionId,
  turnId: record.activeTurn.turnId,
  workspace: candidateCanonicalPath,
  permissionMode: record.activeTurn.permissionMode,
  prompt: record.activeTurn.prompt,
  sessionStartedAt: record.sessionStartedAt,
  sessionSource: record.sessionSource,
}
```

- [ ] **Step 5: Verify GREEN and regression safety**

Run:

```bash
node --test tests/rescue-authority.test.mjs tests/identity.test.mjs
npm run lint
npm run typecheck
git diff --check
```

Expected: all selected tests pass, lint/typecheck exit 0, and no whitespace
errors.

- [ ] **Step 6: Self-review and commit**

Inspect exact bytes, locks, error causes, test seams, and `git diff`. Confirm the
module passes the deletion test: removing it would force Git proof, codec,
locking, and lifecycle logic into multiple callers. Commit only assigned files:

```bash
git add scripts/lib/rescue-authority.mjs tests/rescue-authority.test.mjs
git commit -m "feat: add Rescue workspace authority"
```

## Task 2: Prompt, Role Preview, and Private Prepare Binding

**Files:**
- Modify: `hooks/user-prompt-hook.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Modify: `tests/hooks.test.mjs`
- Modify: `tests/integration/companion.test.mjs`

- [ ] **Step 1: Write the root-to-linked-worktree RED integration test**

Build a fixture that runs the real SessionStart and UserPromptSubmit hooks at a
repository root, creates a real linked worktree afterward, and then calls:

```js
const status = await runCompanion(['role-status', 'rescue'], {
  cwd: linkedWorktree,
  env: { ...installedEnv, CODEX_THREAD_ID: parentSessionId },
  dependencies: { inspectRescueRoleStatus: undefined, /* existing fake App Server seams */ },
});
assert.deepEqual(status, { type: 'role-status', role: 'zcode-rescue', status: 'ready' });
assert.equal(rawAuthority.activeTurn.executionWorkspace, null);

const prepared = await runDirectInvocation(['prepare', 'rescue'], {
  cwd: linkedWorktree,
  env: { ...installedEnv, CODEX_THREAD_ID: parentSessionId },
  input: framedPrivateTTY(envelope),
  preparationTransport: observingTransport,
});
assert.deepEqual(prepared, { type: 'prepared', command: 'rescue' });
assert.equal(observingTransport.bindingExistedBeforeReady, true);
assert.equal((await readPreparation()).workspace, await realpath(linkedWorktree));
```

Use the existing installed Role fixtures rather than bypassing caller proof
with `inspectRescueRoleStatus` dependency injection.

- [ ] **Step 2: Run and record RED**

Run:

```bash
node --test --test-name-pattern='linked worktree|late bind|caller unavailable' tests/hooks.test.mjs tests/integration/companion.test.mjs
```

Expected: the new role-status assertion returns `caller-unavailable`, and
prepare fails `ACTIVE_TURN_NOT_FOUND` before TTY readiness.

- [ ] **Step 3: Add negative RED cases**

Require that role-status does not mutate or touch task/preparation/job/broker
state; unrelated repository and non-Git target map to exact bounded
`caller-unavailable`; child ambient ID cannot preview or bind; target A remains
usable after target B fails; malformed global authority suppresses legacy
fallback; true absence still permits the old same-workspace path. Assert every
public result is exact and below the current byte bound, with path/session/turn/
prompt/error sentinels absent.

- [ ] **Step 4: Integrate UserPromptSubmit**

Replace the boolean-only session check with the existing exact resolver:

```js
const session = await resolveRecordedSessionStart(dataRoot, input.cwd, input.session_id);
const replaced = await createRescueAuthorityStore({ dataRoot }).beginTurn({
  sessionId: input.session_id,
  turnId: input.turn_id,
  originWorkspace: input.cwd,
  permissionMode: input.permission_mode,
  prompt: input.prompt,
  sessionStartedAt: session.startedAt,
  sessionSource: session.source,
});
```

After releasing the authority lock, clean `replaced.replacedTurn` preparation
only in its validated returned bound workspace. Keep generic `beginCallerTurn`,
gate baseline, unread jobs, and launcher rendering origin-scoped. Emit launcher
context only after authority succeeds.

- [ ] **Step 5: Integrate read-only Role preview and prepare binding**

For installed Role readiness, call `previewTurn({sessionId: CODEX_THREAD_ID,
candidateWorkspace: cwd})`; use its recorded SessionStart timestamp for Role
inspection. Keep source-checkout setup on the existing exact-workspace path.

For private prepare, call `bindTurn()` before entering
`withPrivatePreparationTransport`. Use the returned caller for preparation save.
Fallback to existing `resolveActiveTurn` only when the authority module returns
its exact true-absence code. Never fallback on invalid/ineligible/ended/mismatch.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
node --test tests/rescue-authority.test.mjs tests/hooks.test.mjs tests/integration/companion.test.mjs
npm run lint
npm run typecheck
git diff --check
```

Then commit only this task's files:

```bash
git add hooks/user-prompt-hook.mjs scripts/zcode-companion.mjs tests/hooks.test.mjs tests/integration/companion.test.mjs
git commit -m "fix: bind Rescue to a prepared worktree"
```

## Task 3: Child Routing and Cross-Workspace Cleanup

**Files:**
- Modify: `hooks/lib/hook-state.mjs`
- Modify: `hooks/subagent-hook.mjs`
- Modify: `hooks/stop-review-gate-hook.mjs`
- Modify: `hooks/session-end-hook.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Modify: `tests/hooks.test.mjs`
- Modify: `tests/integration/skills.test.mjs`
- Modify: `tests/rescue-binding.test.mjs`

- [ ] **Step 1: Write RED hook lifecycle tests**

Use origin cwd in the raw SubagentStart/SubagentStop/Stop/SessionEnd hook inputs
after authority has bound a linked worktree. Require:

```js
assert.equal((await resolveForwardingExecutor(dataRoot, target, childAgentId)).workspace, canonicalTarget);
await runSubagentStopAtOrigin();
assert.equal((await resolveForwardingExecutor(dataRoot, target, childAgentId, {
  continuation: true, durableProvenance: true,
})).active, false);
```

Also require forwarding Stop suppression, target preparation cleanup on a
turn-ending Root Stop, BLOCK retention, authority-first SessionEnd revocation,
target binding closure, target executor/preparation cleanup, sibling-session
preservation, and ended-tombstone retry after injected cleanup failure.

- [ ] **Step 2: Run and record RED**

Run:

```bash
node --test --test-name-pattern='origin cwd|bound worktree|cross-workspace cleanup' tests/hooks.test.mjs tests/integration/skills.test.mjs tests/rescue-binding.test.mjs
```

Expected: executor lookup and cleanup remain in origin storage and the new
target assertions fail.

- [ ] **Step 3: Deepen hook-state placement without workspace scans**

Change `markForwarding` to accept a validated `executionWorkspace`. Keep the
forwarding marker at the hook origin and write/read the executor at the target.
Add an interface helper that checks at most authority-provided origin and target
locations for forwarding suppression. Do not enumerate `workspaces/`.

SubagentStart resolves `resolveBoundTurn({sessionId: input.session_id,
workspace: target})` through the authority module before executor creation.
SubagentStop obtains the exact bound target from authority and updates only the
matching child record. Legacy true-absence continues using input cwd.

- [ ] **Step 4: Make Stop and SessionEnd revoke before cleanup**

Root Stop ending paths call `authority.endTurn(...)` before generic identity and
preparation cleanup. Use returned target metadata to remove the exact old turn's
preparation. BLOCK paths do not call endTurn.

SessionEnd calls `authority.endSession(...)` first. Use its validated bounded
workspace list for local `cleanupSession`, identity/preparation cleanup, Rescue
binding closure, writable settlement, and broker release. Share the current
absolute remote deadline; attempt workspace remote cleanup with bounded
concurrency and retain durable guards on ambiguity. Never restore authority.

- [ ] **Step 5: Re-resolve bound authority at child invocation seams**

Before `invoke-prepared`, choice continuation, and bound status consume
workspace state, require `resolveBoundTurn` for the parent session and exact
executor workspace. True-absence may use legacy exact-workspace behavior;
invalid or mismatched global authority is terminal. Keep preparation/executor/
binding/job calls on `caller.workspace` only.

- [ ] **Step 6: Verify GREEN, concurrency, and cleanup regressions**

Run:

```bash
node --test tests/rescue-authority.test.mjs tests/hooks.test.mjs tests/integration/companion.test.mjs tests/integration/skills.test.mjs tests/rescue-binding.test.mjs tests/rescue-preparation.test.mjs
npm run lint
npm run typecheck
git diff --check
```

Expected: all pass. Inspect subprocess leftovers and temporary worktrees after
the test run.

- [ ] **Step 7: Self-review and commit**

Check lock ordering, SessionEnd deadlines, legacy absence discrimination,
sibling isolation, and privacy. Commit:

```bash
git add hooks/lib/hook-state.mjs hooks/subagent-hook.mjs hooks/stop-review-gate-hook.mjs hooks/session-end-hook.mjs scripts/zcode-companion.mjs tests/hooks.test.mjs tests/integration/skills.test.mjs tests/rescue-binding.test.mjs
git commit -m "fix: route Rescue lifecycle through its bound worktree"
```

## Task 4: Qualification, Documentation, and Real ZCode Response

**Files:**
- Modify: `tests/helpers/codex-rescue-qualification.mjs`
- Modify: `tests/codex-rescue-qualification.test.mjs`
- Modify: `tests/e2e/codex-skills-e2e.test.mjs`
- Modify: `tests/e2e/real-zcode.test.mjs`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/adr/0010-use-thread-bound-direct-companion.md`
- Modify: `docs/adr/0013-bind-rescue-child-to-zcode-session.md`
- Modify: `tests/release-contracts.test.mjs`

- [ ] **Step 1: Write RED qualification mutations**

Extend evidence with explicit `originWorkspace`, `executionWorkspace`, and raw
authority snapshots. The deterministic fixture must show:

```text
SessionStart(origin) < UserPromptSubmit(origin)
  < authority ACTIVE_UNBOUND
  < role-status(execution, no mutation)
  < prepare(execution)
  < authority ACTIVE_BOUND_TO(execution)
  < SubagentStart(origin hook input, execution executor storage)
  < peer session/create(execution)
```

Add one mutation per missing claim, second target, swapped origin/target,
rewritten turn/permission/session, binding before prompt, role-status mutation,
executor in origin, peer create in origin, invalid Git lineage, and cleanup
before revocation. Each mutation must fail a stable qualification code and keep
private values out of public projections.

- [ ] **Step 2: Run and record RED**

Run:

```bash
node --test tests/codex-rescue-qualification.test.mjs tests/e2e/codex-skills-e2e.test.mjs tests/e2e/real-zcode.test.mjs
```

Expected: new origin/execution and authority-transition assertions fail while
authenticated tests remain explicit opt-in skips.

- [ ] **Step 3: Implement deterministic and installed qualification**

Update validators so generic same-workspace evidence remains valid with
`originWorkspace === executionWorkspace`, while the worktree fixture requires
different canonical paths with one shared canonical Git common directory. Read
authority bytes only from raw evidence, never public child/parent output.

Update the installed capture to create a linked worktree inside one parent turn,
run preflight and private prepare at the target, start one child, and require
the fake/real peer create workspace, job, executor, preparation, and binding to
remain target-scoped. Keep one spawn, one child, one parent turn, one peer
session, and all existing task/privacy checks.

- [ ] **Step 4: Strengthen real ZCode qualification**

In the opt-in real suite, create an isolated linked worktree and explicitly pass
that workspace to the managed client/Companion qualification seam. In one exact
ZCode session perform two send/wait/read cycles. Require for each accepted input
a distinct new non-empty visible assistant message whose parent relation matches
the accepted input (or the already-qualified sole real-user-root compatibility
path). Keep explicit 180-second per-completion test budgets and a total test
timeout that covers both cycles. Stop and close in `finally`.

- [ ] **Step 5: Update release documentation and contracts**

Document, in English and Chinese, the exact phrases and concepts required by the
design: origin versus execution workspace, automatic first-prepare binding, no
manual handoff, same canonical Git common-dir only, immutable target for the
turn, child cannot claim, and Stop/new prompt/SessionEnd revocation. Update
SECURITY, the Unreleased changelog without a version bump, and the current Rescue
authorization ADR. Add byte-level release-contract assertions so deleting or
weakening these statements fails tests.

- [ ] **Step 6: Verify GREEN and commit source/docs**

Run:

```bash
node --test tests/rescue-authority.test.mjs tests/codex-rescue-qualification.test.mjs tests/e2e/codex-skills-e2e.test.mjs tests/e2e/real-zcode.test.mjs tests/release-contracts.test.mjs
npm run lint
npm run typecheck
git diff --check
```

Expected: deterministic tests pass; authenticated tests are either successful
when enabled or report their exact opt-in skip. Commit all source qualification
and documentation changes, but not marketplace output:

```bash
git add tests/helpers/codex-rescue-qualification.mjs tests/codex-rescue-qualification.test.mjs tests/e2e/codex-skills-e2e.test.mjs tests/e2e/real-zcode.test.mjs README.md README.zh-CN.md SECURITY.md CHANGELOG.md docs/adr tests/release-contracts.test.mjs
git commit -m "test: qualify Rescue worktree late binding"
```

## Task 5: Generated Marketplace, Full Verification, Reviews, and PR

**Files:**
- Generate: `marketplace/plugins/zcode/**`
- Generate: `.agents/plugins/marketplace.json`
- Generate: `.agents/plugins/provenance.json`
- Modify only for review fixes: files owned by Tasks 1-4

- [ ] **Step 1: Verify clean source and build an external snapshot**

Run from the feature worktree:

```bash
git status --short
SOURCE_SHA="$(git rev-parse HEAD)"
SNAPSHOT_PARENT="$(mktemp -d)"
node scripts/build-marketplace-snapshot.mjs \
  --output "$SNAPSHOT_PARENT/marketplace-snapshot" \
  --source-ref "$SOURCE_SHA" \
  --source-sha "$SOURCE_SHA"
```

Expected: source worktree is clean before build; output is outside the repo;
provenance `sourceRef` and `sourceSha` equal `SOURCE_SHA`.

- [ ] **Step 2: Mechanically replace generated files**

Use one mechanical sync from the verified output; never hand edit the mirror:

```bash
rsync -a --delete "$SNAPSHOT_PARENT/marketplace-snapshot/plugins/zcode/" marketplace/plugins/zcode/
cmp -s "$SNAPSHOT_PARENT/marketplace-snapshot/.agents/plugins/marketplace.json" .agents/plugins/marketplace.json || cp "$SNAPSHOT_PARENT/marketplace-snapshot/.agents/plugins/marketplace.json" .agents/plugins/marketplace.json
cmp -s "$SNAPSHOT_PARENT/marketplace-snapshot/.agents/plugins/provenance.json" .agents/plugins/provenance.json || cp "$SNAPSHOT_PARENT/marketplace-snapshot/.agents/plugins/provenance.json" .agents/plugins/provenance.json
```

- [ ] **Step 3: Verify marketplace parity and commit generated output**

Run:

```bash
node --test tests/marketplace-snapshot.test.mjs tests/plugin-contracts.test.mjs tests/release-contracts.test.mjs
node --test tests/integration/marketplace-snapshot-build.mjs
MARKETPLACE_SNAPSHOT="$SNAPSHOT_PARENT/marketplace-snapshot" \
MARKETPLACE_SOURCE_REF="$SOURCE_SHA" \
MARKETPLACE_SOURCE_SHA="$SOURCE_SHA" \
node --test tests/integration/marketplace-install.test.mjs
git diff --check
```

Expected: byte parity, provenance, builder, install, and release contracts pass.
Commit generated files only:

```bash
git add marketplace/plugins/zcode .agents/plugins/marketplace.json .agents/plugins/provenance.json
git commit -m "build: refresh ZCode marketplace snapshot"
```

- [ ] **Step 4: Run fresh full verification**

Run and save the complete result:

```bash
npm run check
```

If the known `background startup timeout terminates and reaps the
unacknowledged worker` timing test fails, rerun it alone, then rerun the complete
`npm run check`; do not call the branch green until one fresh complete run exits
0. Then run authenticated qualification with the known qualified model and
require actual responses, not skips:

```bash
ZCODE_REAL_E2E=1 \
ZCODE_REAL_E2E_MODEL='bigmodel/GLM-5.2' \
ZCODE_CODEX_RESCUE_E2E=1 \
npm run test:qualified
```

- [ ] **Step 5: Independent spec/security review**

Give a fresh reviewer the design, plan, base SHA `f07eb81`, and current HEAD.
Require line-by-line review of first-writer-wins, Git lineage, malformed-state
fallback, child claim prevention, origin/target hook routing, SessionEnd
revocation order/budget, privacy, legacy behavior, qualification truthfulness,
and marketplace provenance. Fix every Critical/Important issue with RED-GREEN
tests and request re-review until approved.

- [ ] **Step 6: Independent code-quality review**

After spec approval, give another fresh reviewer the same SHA range. Require
review of module depth/locality, duplication, lock order, file identities,
bounded Git/process behavior, race handling, cleanup reliability, test
determinism, platform portability, and unnecessary scope. Fix every
Critical/Important issue and request re-review until approved.

- [ ] **Step 7: Push and create the PR**

After fresh full verification and both approvals:

```bash
git push -u origin fix/rescue-worktree-late-binding
gh pr create \
  --base main \
  --head fix/rescue-worktree-late-binding \
  --title "fix: bind Rescue to linked worktrees" \
  --body "Summary: add a two-phase Rescue lifecycle authority, bind one eligible linked worktree at private prepare, route child and cleanup state through the bound target, and qualify real target-workspace responses. Test plan: npm run check; authenticated test:qualified; marketplace build/install parity."
```

The PR body must summarize the two-phase authority, immutable same-repository
claim, cross-workspace hook cleanup, migration/privacy posture, deterministic
qualification, authenticated response evidence, and exact test commands.

- [ ] **Step 8: Follow CI until all required checks pass**

Use:

```bash
gh pr checks --watch --interval 20 <PR_NUMBER>
```

For failures, inspect the exact job log, reproduce locally where possible, add a
RED regression, fix, rerun full verification, push, and watch the replacement
run. Completion requires every required Ubuntu/macOS/Windows × Node 22.13/LTS
check successful and the PR mergeable. Preserve the worktree for follow-up.
