# Rescue Worktree Late Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one active owned Codex parent turn automatically bind Rescue to an eligible linked worktree at private preparation time, without a visible handoff or weakened identity checks.

**Architecture:** Deepen the existing `IdentityStore` with a compatible v3 active-turn representation and optional `workspaceBinding` resolution semantics. The prompt hook supplies exact SessionStart proof, Role readiness previews read-only, and private prepare atomically claims one canonical same-repository execution workspace before accepting task bytes. Existing callers omit the option and retain exact-origin behavior; all downstream Rescue state stays strictly local to the bound target.

**Tech Stack:** Node.js 22.13 ESM, strict JSON/file identity helpers, advisory file locks, Git CLI without shell, `node:test`, Codex hook integration tests, authenticated ZCode 0.16.3 opt-in qualification, generated marketplace snapshot, GitHub Actions.

---

## File and Module Map

- Modify `scripts/lib/identity.mjs`: deepen the existing IdentityStore with compatible v3 active-turn modes, private data-root lifecycle storage, Git common-dir eligibility, atomic preview/claim/execution resolution, session target ledger, legacy fallback, and fixed errors.
- Modify `tests/identity.test.mjs`: test the same IdentityStore interface with real temporary repositories/worktrees and injected bounded process seams where necessary.
- Modify `hooks/user-prompt-hook.mjs`: derive compatible v3 active-turn authority from the exact origin SessionStart record while retaining the current caller-token and gate behavior.
- Modify `scripts/zcode-companion.mjs`: preview authority for installed Role readiness, bind before private preparation transport, and resolve the bound target at child/invocation boundaries.
- Modify `hooks/lib/hook-state.mjs` and `hooks/subagent-hook.mjs`: split origin forwarding markers from target executor records and locate only authority-named workspaces.
- Modify `hooks/stop-review-gate-hook.mjs` and `hooks/session-end-hook.mjs`: revoke global authority first, then clean only validated returned targets under existing budgets.
- Modify `tests/identity.test.mjs`, `tests/hooks.test.mjs`, `tests/integration/companion.test.mjs`, `tests/integration/skills.test.mjs`, and `tests/rescue-binding.test.mjs`: preserve legacy exact-workspace behavior and exercise the complete late-binding route.
- Modify `tests/helpers/codex-rescue-qualification.mjs`, `tests/codex-rescue-qualification.test.mjs`, `tests/e2e/codex-skills-e2e.test.mjs`, and `tests/e2e/real-zcode.test.mjs`: distinguish origin and execution workspaces and qualify raw authority transitions plus real responses.
- Modify `README.md`, `README.zh-CN.md`, `SECURITY.md`, `CHANGELOG.md`, `docs/adr/0010-use-thread-bound-direct-companion.md`, `docs/adr/0013-bind-rescue-child-to-zcode-session.md`, and `tests/release-contracts.test.mjs`: publish the automatic, immutable, same-repository contract.
- Regenerate `marketplace/plugins/zcode/**`, `.agents/plugins/marketplace.json`, and `.agents/plugins/provenance.json` only with `scripts/build-marketplace-snapshot.mjs` from a clean exact source SHA.

## Task 1: Deepen IdentityStore for Compatible Workspace Binding

**Files:**
- Modify: `scripts/lib/identity.mjs`
- Modify: `tests/identity.test.mjs`

- [ ] **Step 1: Write RED tests for the external interface and exact record**

Create a real temporary Git repository, commit one file, and create two linked
worktrees. Exercise the compatible existing interface:

```js
const identity = createIdentityStore({ dataRoot });
const token = await identity.beginCallerTurn({
  sessionId: 'parent-session',
  turnId: 'parent-turn',
  workspace: root,
  permissionMode: 'workspace-write',
  prompt: 'repair the worktree',
  sessionStartedAt: '2026-08-21T06:00:00.000Z',
  sessionSource: 'startup',
  now: '2026-08-21T06:00:01.000Z',
});
assert.match(token, /^[A-Za-z0-9_-]+$/);

const preview = await identity.resolveActiveTurn({
  sessionId: 'parent-session', workspace: worktreeA, workspaceBinding: 'preview',
});
assert.equal(preview.workspace, await realpath(worktreeA));
assert.equal(preview.turnId, 'parent-turn');
assert.equal((await readPersistedActiveTurn()).executionWorkspace, null);

const bound = await identity.resolveActiveTurn({
  sessionId: 'parent-session', workspace: worktreeA, workspaceBinding: 'claim',
});
assert.equal(bound.workspace, await realpath(worktreeA));
assert.equal((await identity.resolveActiveTurn({
  sessionId: 'parent-session', workspace: worktreeA, workspaceBinding: 'execution',
})).workspace, await realpath(worktreeA));
```

The raw record assertion must require exact v3 active-turn (including random
generation ID and `active` status), v1 session-ledger, and origin-index keys,
one pending-to-active publication and null-to-canonical binding transition,
canonical key/filename matches, private file modes, and no caller token,
launcher command, task frame,
job/child/ZCode ID, or Git output. Existing no-option resolution must still
accept only `root` and return the existing caller shape.

- [ ] **Step 2: Run the focused test and record the expected RED**

Run:

```bash
node --test --test-name-pattern='workspace binding|active turn' tests/identity.test.mjs
```

Expected: FAIL because `workspaceBinding` and persisted v3 lifecycle records do
not exist. Do not write production code until this exact failure is observed.

- [ ] **Step 3: Add RED coverage for eligibility, contention, lifecycle, and corruption**

Add separate tests requiring:

```js
assert.equal((await identity.resolveActiveTurn({ sessionId, workspace: origin, workspaceBinding: 'preview' })).workspace, canonicalOrigin);
await assert.rejects(identity.resolveActiveTurn({ sessionId, workspace: unrelatedRepo, workspaceBinding: 'preview' }), { code: 'ACTIVE_TURN_WORKSPACE_INELIGIBLE' });
await assert.rejects(identity.resolveActiveTurn({ sessionId, workspace: nonGitDirectory, workspaceBinding: 'preview' }), { code: 'ACTIVE_TURN_WORKSPACE_INELIGIBLE' });

const outcomes = await Promise.allSettled([
  ...Array.from({ length: 8 }, () => identity.resolveActiveTurn({ sessionId, workspace: worktreeA, workspaceBinding: 'claim' })),
  ...Array.from({ length: 8 }, () => identity.resolveActiveTurn({ sessionId, workspace: worktreeB, workspaceBinding: 'claim' })),
]);
const winners = outcomes.filter((entry) => entry.status === 'fulfilled');
assert.ok(winners.length >= 1);
assert.equal(new Set(winners.map((entry) => entry.value.workspace)).size, 1);
```

Also require idempotent same-target claim, immutable other-target rejection,
session/turn/permission isolation, defensive returned copies, exact
`endCallerTurn` target return, crash-safe `cleanupSession` tombstone, 16-workspace
capacity, malformed/duplicate/oversized/future-version record failure,
symlink/path identity failure, Git timeout/output bounds, and fixed errors that
contain none of the private sentinels. Existing v2 and unversioned active-turn
bytes must remain readable only at their exact workspace and never be rewritten.
A begin call without SessionStart proof must keep the legacy v2 path; a call
with the exact proof pair must write v3 plus the v1 session ledger and no v2
active mirror. Partial proof is invalid. No-option resolution and
`resolveOnlyActiveTurn` must preserve exact origin semantics across both stores.
Any lifecycle ledger, including pending/ended/corrupt state, suppresses legacy
fallback. Add stale-v2 tests for each. An exact duplicate begin retains the
generation and binding; same turn ID with changed prompt/permission creates a
new generation and resets the binding. All prior session caller tokens are
revoked, not only differing turn IDs.

- [ ] **Step 4: Implement the minimal deep module**

Keep the existing `createIdentityStore({dataRoot})` return object. Extend only
these existing methods:

```js
beginCallerTurn(input)
resolveActiveTurn({ sessionId, workspace, workspaceBinding? })
endCallerTurn(input)
cleanupSession(workspace, sessionId)
```

Keep the Git runner, strict codec, bounded reader, storage paths, record key,
eligibility comparison, and test-only dependency seams private. Canonicalize
workspaces with `resolveWorkspaceStorage`. Execute Git with `execFile` and exact
argv for `rev-parse --path-format=absolute --is-inside-work-tree
--show-toplevel --git-common-dir`, `shell:false`, bounded buffer, and fixed
timeout. Cross-worktree binding requires candidate === canonical top-level and
equal canonical common dirs. Treat non-Git origin/candidate as eligible only
when their canonical workspace paths are equal.

Linearize every v3 record mutation under a fixed, digest-striped per-session
lock below `<dataRoot>/identity-lifecycle/session-locks/`. Preserve the existing
workspace identity lock for caller tokens, capabilities, gates, legacy records,
and one bounded origin index. The only nested order is session lifecycle ->
workspace identity; no path may acquire those locks in reverse, and Git runs
outside both before exact generation/state revalidation. Changed-turn begin
uses: session pending generation -> release -> reacquire and fence exact
generation -> origin caller/index write while retaining the session lock ->
exact active publication -> release. A superseded publisher must fail before
workspace mutation. Resolvers reject pending. Retry repairs the exact pending
generation. Claim publishes its workspace ledger entry before the bound active
record, repairs a missing ledger entry idempotently, and revalidates after the
lock-free Git probe. Add injected failure/crash-reopen tests at every write.
Validate the complete persisted record before reading any authority field.
Return fresh caller-shaped objects:

```js
{
  sessionId: record.sessionId,
  generationId: record.generationId,
  turnId: record.turnId,
  workspace: candidateCanonicalPath,
  permissionMode: record.permissionMode,
  prompt: record.prompt,
  originWorkspace: record.originWorkspace,
  executionWorkspace: record.executionWorkspace,
}
```

For proved lifecycle turns, persist caller contexts with an exact private
`caller-context` version and `generationId`. Keep the public opaque token and
consume projection unchanged. Consumption may discover the session under a
workspace lock, but must release it before acquiring the session stripe and
then re-read in the sole session -> workspace order. If lifecycle state exists,
require one active v3 record whose generation/session/turn/origin/permission
matches the caller. Ended, pending, active-missing, malformed, future, or
superseded lifecycle state revokes the token before advisory file deletion.
Only true absence of both lifecycle files permits legacy caller consumption.
Keep `createCallerContext` as the compatible minting entry: true absence writes
the byte-compatible 30-minute legacy record; an exact active v3
session/turn/canonical-origin/permission match writes a generation-bound proved
record with the unchanged opaque token and public projection. Pending, ended,
missing, malformed, future, superseded, or mismatched lifecycle state writes no
artifact. Fence publication from replacement and cleanup under the sole
session -> workspace lock order.

`workspaceBinding:'execution'` accepts only the origin or exact bound target and
returns `workspace` as the bound target. `resolveOnlyActiveTurn` follows the
workspace origin index; it never scans unrelated global slots. Every proved
origin and claimed target enters ledger `knownWorkspaces` (maximum 16).

- [ ] **Step 5: Verify GREEN and regression safety**

Run:

```bash
node --test tests/identity.test.mjs
npm run lint
npm run typecheck
git diff --check
```

Expected: all selected tests pass, lint/typecheck exit 0, and no whitespace
errors.

- [ ] **Step 6: Self-review and commit**

Inspect exact bytes, locks, error causes, test seams, and `git diff`. Confirm the
deepened module keeps callers unaware of Git proof, codec, locking, lifecycle
storage, and fallback rules. Commit only assigned files:

```bash
git add scripts/lib/identity.mjs tests/identity.test.mjs
git commit -m "feat: add compatible active-turn workspace binding"
```

## Task 2: Prompt, Role Preview, and Private Prepare Binding

**Files:**
- Modify: `hooks/user-prompt-hook.mjs`
- Modify: `scripts/lib/plugin-data.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Modify: `skills/rescue/launcher.mjs`
- Modify: `tests/hooks.test.mjs`
- Modify: `tests/integration/companion.test.mjs`
- Modify: `tests/plugin-data.test.mjs`

- [ ] **Step 1: Write the root-to-linked-worktree RED integration test**

Build a fixture that runs the real SessionStart and UserPromptSubmit hooks at a
repository root, creates a real linked worktree afterward, and then calls:

```js
const status = await runCompanion(['role-status', 'rescue'], {
  cwd: linkedWorktree,
  env: { ...installedEnv, CODEX_THREAD_ID: parentSessionId },
});
assert.deepEqual(status, { type: 'role-status', role: 'zcode-rescue', status: 'ready' });
assert.equal(rawActiveTurn.executionWorkspace, null);

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
usable after target B fails; malformed v3 authority suppresses legacy
fallback; only absence of both lifecycle files permits the old same-workspace
path. Assert every
public result is exact and below the current byte bound, with path/session/turn/
prompt/error sentinels absent.

- [ ] **Step 4: Integrate UserPromptSubmit**

Replace the boolean-only session check with the existing exact resolver, then
call the already-deepened `beginCallerTurn` once:

```js
const session = await resolveRecordedSessionStart(dataRoot, input.cwd, input.session_id);
const begun = await createIdentityStore({ dataRoot }).beginCallerTurn({
  sessionId: input.session_id,
  turnId: input.turn_id,
  workspace: input.cwd,
  permissionMode: input.permission_mode,
  prompt: input.prompt,
  sessionStartedAt: session.startedAt,
  sessionSource: session.source,
  lifecycleResult: true,
});
if (begun.replacedTurn?.executionWorkspace !== null) {
  await preparations.cleanupTurn({
    sessionId: input.session_id,
    turnId: begun.replacedTurn.turnId,
    workspace: begun.replacedTurn.executionWorkspace,
  });
}
```

The exact SessionStart resolve is the production proof; caller-token behavior
is unchanged. Keep gate baseline, unread jobs, and launcher rendering
origin-scoped. Replaced preparation cleanup occurs only after IdentityStore has
released its locks; cleanup failure cannot restore old authority, and the
preparation remains TTL-bounded. Emit launcher context only after SessionStart
and active publication succeed.

- [ ] **Step 5: Integrate read-only Role preview and prepare binding**

For installed Role readiness, call `resolveActiveTurn({sessionId:
CODEX_THREAD_ID, workspace: cwd, workspaceBinding: 'preview'})`; resolve the
SessionStart record from its validated `originWorkspace` for Role inspection.
Keep source-checkout setup on the existing exact-workspace path.

For private prepare, split `withPrivatePreparationTransport` into a no-input
TTY/raw-mode capability preflight and a post-claim readiness/input phase. A
preflight or `setRawMode(true)` failure leaves authority unbound. After it
succeeds, call `resolveActiveTurn({sessionId: ambientThreadId, workspace: cwd,
workspaceBinding: 'claim'})`, then write readiness and read the frame. Claim is
the immutable first-writer linearization point: readiness/abort/save failure
retains the target, creates no preparation, permits a same-target retry, and
continues rejecting a second target. Use the returned caller for preparation
save.

Deepen `plugin-data` with one optional trusted lexical runtime entry rather
than duplicating provenance parsing in hooks, launcher, or companion. Allowlist
only the exact UserPrompt hook, Rescue launcher, and companion relative files;
the actual `process.argv[1]` must canonically resolve to that same owned file.
Validate no control bytes or traversal, the exact
`CODEX_HOME/plugins/cache/<marketplace>/zcode/<version>` shape, and canonical
target/root ownership before deriving the existing marketplace namespace and
returning its validated lexical runtime root. The hook renders the sibling
launcher from that root; the launcher imports companion in-process, whose
provenance resolution accepts the same exact launcher entry. Do not forward
provenance in environment variables. Add unit and real-child tests for the
actual cache-symlink hook -> launcher -> companion Role/prepare chain, exact
entry acceptance, wrong target/shape/non-runtime rejection, ordinary installed
copies, source CLI, and module import.
IdentityStore itself owns true-absence legacy fallback and never falls back on
invalid/ineligible/ended/mismatch.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
node --test tests/identity.test.mjs tests/hooks.test.mjs tests/integration/companion.test.mjs
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
preservation, and ended-tombstone retry after injected cleanup failure. Replace
the parent active generation before SubagentStop and prove the route pointer
still closes only the old exact child. Add three turns spanning two proved
origins and two targets; SessionEnd must return/clean all four unique bounded
workspaces, survive one target failure, and retry from the tombstone.

- [ ] **Step 2: Run and record RED**

Run:

```bash
node --test --test-name-pattern='origin cwd|bound worktree|cross-workspace cleanup' tests/hooks.test.mjs tests/integration/skills.test.mjs tests/rescue-binding.test.mjs
```

Expected: executor lookup and cleanup remain in origin storage and the new
target assertions fail.

- [ ] **Step 3: Deepen hook-state placement without workspace scans**

Change `markForwarding` to accept the v3 caller projected by
`workspaceBinding:'execution'`. Keep the forwarding marker and a strict
`executor-route` pointer at hook origin; write/read the executor at target. The
strict route binds parent generation/permission, canonical origin/target,
bounded `updatedAt`, and `pending | active | stopped`; executor and marker bind
the same identities. Add an interface helper that follows only the exact route
pointer for SubagentStop and forwarding suppression. Use bounded nofollow route
reads, bounded strict directory enumeration, and exact sibling-safe cleanup.
Do not enumerate `workspaces/` or the lifecycle ledger.

Start publishes a fresh pending route, writes the target executor, then under
the origin lock re-resolves exact execution authority and compare-and-set
publishes active. Pending lasts 30 seconds; retry refreshes its lease. Only a
fresh route matching session, turn, generation (or proved legacy absence),
permission, origin, and target may temporarily suppress Root Stop. Stop first
linearizes route stopped/marker false, then stops the executor. Start must
observe a winning Stop and leave its executor inactive.

Treat target executor publication as uncertain: include the write itself and
all finalization in one default-failed `try/finally`. Unless active route
publication succeeds, best-effort deactivate the exact executor even if rename
succeeded and a later chmod/fsync/unlock failed. Preserve the primary private
error; compensation cannot replace it. Never recreate a missing, malformed, or
rewritten route as trusted stopped state. Add deterministic barriers for every
Start/Stop/Root Stop/SessionEnd ordering, expired retry, generation replacement,
target rewrite/move, route removal/corruption, and post-rename write failure.

SubagentStart resolves `resolveActiveTurn({sessionId: input.session_id,
workspace: target, workspaceBinding: 'execution'})` through IdentityStore before
executor creation; origin input is valid and the returned caller workspace is
the target. SubagentStop follows the persisted route pointer and updates only
the matching target child record even after active-turn replacement. Legacy
true-absence continues using input cwd and represents absent generation as
`null` only inside the route schema; IdentityStore must still prove both global
lifecycle files truly absent.

- [ ] **Step 4: Make Stop and SessionEnd revoke before cleanup**

Root Stop ending paths call the existing `identity.endCallerTurn(...)`; its
deepened return includes the validated execution target. Use that metadata to
remove the exact old turn's preparation. BLOCK paths do not end the turn.

SessionEnd calls the existing `identity.cleanupSession(...)` first. Use its
validated bounded `knownWorkspaces` list (every proved origin and claimed
target) for hook-state/preparation cleanup, Rescue
binding closure, writable settlement, and broker release. Share the current
absolute remote deadline; attempt workspace remote cleanup with bounded
concurrency and retain durable guards on ambiguity. Never restore authority.

- [ ] **Step 5: Re-resolve bound authority at child invocation seams**

Before `invoke-prepared`, choice continuation, and bound status consume
workspace state, require `resolveActiveTurn(..., workspaceBinding: 'execution')`
for the parent session and exact executor workspace. True-absence may use legacy
exact-workspace behavior only when both global lifecycle files are absent;
pending/ended/corrupt/mismatched v3 authority is terminal. Keep
preparation/executor/binding/job calls on `caller.workspace` only.

- [ ] **Step 6: Verify GREEN, concurrency, and cleanup regressions**

Run:

```bash
node --test tests/identity.test.mjs tests/hooks.test.mjs tests/integration/companion.test.mjs tests/integration/skills.test.mjs tests/rescue-binding.test.mjs tests/rescue-preparation.test.mjs
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
  < authority PENDING -> ACTIVE_UNBOUND generation N
  < role-status(execution, no mutation)
  < prepare(execution)
  < authority ACTIVE_BOUND_TO(execution) generation N
  < SubagentStart(origin hook input, execution executor storage)
  < peer session/create(execution)
```

Add one mutation per missing claim, second target, swapped origin/target,
rewritten generation/turn/permission/session, binding before publication,
role-status mutation, missing/wrong origin index, executor route/executor
generation drift, peer create in origin, invalid Git lineage, and cleanup before
revocation. Each mutation must fail a stable qualification code and keep private
values out of public projections.

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
node --test tests/identity.test.mjs tests/codex-rescue-qualification.test.mjs tests/e2e/codex-skills-e2e.test.mjs tests/e2e/real-zcode.test.mjs tests/release-contracts.test.mjs
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
