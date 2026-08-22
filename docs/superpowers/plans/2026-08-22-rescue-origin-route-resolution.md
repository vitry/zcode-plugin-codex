# Rescue Origin Route Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task, and superpowers:test-driven-development for every behavior change.

**Goal:** Allow a trusted Rescue child whose Codex process starts in the conversation origin workspace to resolve and execute against the immutable linked-worktree target already published by PR #39.

**Architecture:** Deepen `hooks/lib/hook-state.mjs` so it owns both direct executor resolution and the exact origin-route compatibility lookup. The resolver returns one validated `{ executor, executionWorkspace }` context; `scripts/zcode-companion.mjs` then uses that target context for lifecycle, preparation, choices, status, jobs, and ZCode cwd. The fallback is permitted only after a complete bounded ambient executor-set validation proves zero claims for the child.

**Tech Stack:** Node.js ESM, `node:test`, private JSON state under workspace partitions, Git worktrees, GitHub Actions.

---

## Preconditions and fixed constraints

- Work only in `/Users/zhangzikai/Workspace/Codes/github/zcode-plugin-codex/.worktrees/rescue-origin-route-resolution` on branch `fix/rescue-origin-route-resolution`.
- Treat `docs/superpowers/specs/2026-08-22-rescue-origin-route-resolution-design.md` as normative.
- Do not use ZCode Rescue for implementation, review, or verification.
- Do not change prepare-time target selection, add a public target parameter, scan workspace partitions, rewrite old authority records, or merge the PR.
- Each implementation task uses RED → GREEN → REFACTOR, commits its own changes, then receives separate spec-compliance and code-quality reviews before the next task begins.

## Task 1: Add the deep routed executor resolver

**Files:**

- Modify: `hooks/lib/hook-state.mjs`
- Modify: `tests/hooks.test.mjs`

### 1.1 RED: specify the public result and the production route

- [ ] Import the new `resolveRoutedForwardingExecutor` export in `tests/hooks.test.mjs`.
- [ ] Extend the existing linked origin/target hook-state scenario so direct target lookup still returns the executor, while origin lookup returns:

```js
{
  executor: targetExecutor,
  executionWorkspace: canonicalTarget,
}
```

- [ ] Snapshot the origin route and target executor bytes before/after routed lookup and assert byte equality.
- [ ] Run:

```bash
node --test --test-name-pattern='origin route|routed executor' tests/hooks.test.mjs
```

Expected RED: import/export or function failure because routed resolution does not exist. The failure must not be a fixture typo.

### 1.2 GREEN: implement only the active happy path and preserve direct behavior

- [ ] Refactor the body of `resolveForwardingExecutor` into private helpers without changing its observable API or errors.
- [ ] The ambient probe must bounded-read and validate every `executor-*.json` entry exactly as today, enforce the 1,024 executor limit, reject malformed records, reject a noncanonical same-agent claim, and return a private structured result only when the valid complete set has zero claims:

```js
{ kind: 'absent', store }
// or
{ kind: 'selected', store, executor }
```

- [ ] Keep role, timestamp, expiry, active/stopped, and durable-provenance checks separate from structural absence. Never implement fallback by catching public `EXECUTOR_IDENTITY_NOT_FOUND`.
- [ ] Add:

```js
export async function resolveRoutedForwardingExecutor(
  dataRoot,
  ambientWorkspace,
  agentId,
  options = {},
) {
  // direct selected executor, or exact route lookup after structural absence
  return { executor, executionWorkspace };
}
```

- [ ] In this slice, make only the single valid active-route happy path GREEN plus unchanged direct lookup. Do not pre-implement duplicate, malformed, pending/future, stopped-mode, count-limit, or nofollow boundary behavior before its failing test in 1.3.
- [ ] Do not hold the origin `.lock` while resolving the target executor: target validation may resolve the origin route and reacquire the origin lock. Capture the immutable validated route snapshot under the origin lock, release it, validate target authority, then require the target executor to match that exact snapshot.

### 1.3 RED/GREEN: fail-closed matrix

- [ ] Add one focused test per failure category before adding the smallest implementation needed for it:

  - canonical executor missing + noncanonical same-child claim;
  - duplicate/noncanonical executor claim;
  - malformed ambient executor;
  - inactive, expired, future, wrong-role, or mode-incompatible ambient executor with an otherwise valid target route;
  - zero, unrelated, duplicate, malformed, pending, future, active/stopped mixed, or mode-mismatched route claims;
  - a malformed route that appears unrelated still terminates instead of being skipped;
  - target executor mismatch, wrong generation, expired executor, record-count overflow, symlink/nofollow violation.

- [ ] Count route claims by `agentId` before mode/state filtering. A fresh or aged `pending` route and any future `createdAt` or `updatedAt` must fail closed.
- [ ] For every slice, extend the implementation only after observing the exact new test fail. The completed resolver must bounded-read and schema-validate the complete ambient `route-*.json` set before selecting any child claim. A malformed record whose `agentId` cannot be trusted is terminal even if it appears unrelated. Only after the complete set validates may it count exact `agentId` claims, validate the single route's state/time for `options`, and resolve/match target authority.
- [ ] Run after each RED/GREEN slice, then run the whole file:

```bash
node --test tests/hooks.test.mjs
```

Expected GREEN: all hook tests pass with no warnings.

### 1.4 Refactor and commit

- [ ] Ensure `resolveForwardingExecutor` remains backward compatible and delegates to the same private validation primitives.
- [ ] Run `git diff --check` and inspect the diff for any authority relaxation.
- [ ] Commit:

```bash
git add hooks/lib/hook-state.mjs tests/hooks.test.mjs
git commit -m 'fix: resolve Rescue executors through origin routes'
```

## Task 2: Route every child-side companion entry to the execution workspace

**Files:**

- Modify: `scripts/zcode-companion.mjs`
- Modify: `tests/integration/skills.test.mjs`
- Add: `tests/fixtures/pr39-origin-route-compatibility.mjs`

### 2.1 RED: reproduce the real child cwd

- [ ] In `origin hook cwd executes prepared Rescue only in its bound linked worktree`, change only the child `invoke-prepared rescue` cwd from `canonicalTarget` to `ctx.workspace`.
- [ ] Keep assertions that fake ZCode `session/create`, jobs, and state remain target-scoped, and add assertions that origin contains no preparation, pending choice, job, binding, or ZCode session state.
- [ ] Run:

```bash
node --test --test-name-pattern='origin hook cwd executes prepared Rescue' tests/integration/skills.test.mjs
```

Expected RED: exit code 1 with `EXECUTOR_IDENTITY_NOT_FOUND`, matching the production incident.

### 2.2 GREEN: resolve one execution context before workspace-local reads

- [ ] Import `resolveRoutedForwardingExecutor` instead of performing child-side direct-only executor lookup for the prepared entry.
- [ ] Introduce one small companion helper returning `{ executor, executionWorkspace }` for an active prepared executor. In this slice, leave the existing stopped/durable fallback as a direct-workspace lookup so target-cwd legacy behavior stays intact but origin-cwd stopped continuation remains RED for 2.3.
- [ ] In this slice only, replace ambient `cwd` with `executionWorkspace` for `invoke-prepared rescue` lifecycle lookup, preparation consume, binding, state/broker/session metadata, pending-choice publication, and ZCode cwd.
- [ ] Preserve the existing `invoke rescue` rejection with `PREPARED_INVOCATION_REQUIRED`; this change does not re-enable that compatibility entry.
- [ ] Do not yet wire status, choice, or stopped continuation, and do not change non-Rescue commands.
- [ ] Re-run the focused test until GREEN.

### 2.3 RED/GREEN: wire remaining lifecycle entries one slice at a time

- [ ] Add one focused origin-cwd foreground-status test, run it to the expected ambient lookup/state failure, then wire `invoke-status rescue` to the routed context and rerun GREEN.
- [ ] Add focused origin-cwd choice tests for `fresh` and `resume`, run them RED, then wire pending consume, caller snapshot, and execution to the same routed target and rerun GREEN.
- [ ] Add a focused stopped same-child prepared-continuation test and run it RED against the intentionally direct-only stopped fallback from 2.2. Then extend only the stopped/durable fallback to resolve and preserve the routed target without converting inactive ambient authority into structural absence, and rerun GREEN.
- [ ] Add named `zcode-rescue` and qualified `default` child tests, run them RED if their compatibility path is not already covered, and wire only the missing shared routing behavior.
- [ ] Seed unrelated origin jobs/bindings and prove they cannot be selected.
- [ ] Add automatic public-error assertions for each failure family: stdout/stderr must not contain origin/target paths or fixed agent/session/turn/generation identifiers.
- [ ] For each behavior, first run the new test against the smallest prior implementation state and confirm the intended failure, then implement only what makes it pass. Preserve the explicit `invoke rescue` rejection.

### 2.4 Frozen PR #39 compatibility oracle

- [ ] Check in four independent literal raw PR #39 scenario templates. Each template declares exact origin/target relative filenames and bytes; no current hook or store producer may create the oracle records:

  - prepared: global `identity/active-turns/<key>.json`, `identity/sessions/<key>.json`, origin `hook-state/route-<key>.json` + `forward-<key>.json`, target caller/index + `hook-state/executor-<key>.json`, and target one-shot preparation;
  - status: the same active authority plus exact durable binding, owner index, bound foreground job, and broker/session metadata required by `invoke-status`;
  - choice: stopped route/executor plus pending invocation snapshot, durable binding, exact bound job, and broker/session metadata for each `fresh`/`resume` direction;
  - stopped continuation: stopped route/executor plus generation > 1 prepared record whose required executor, lifecycle generation, durable binding, job, and ZCode session all match.

- [ ] Copy one scenario at a time into isolated temporary origin/target partitions, deriving only canonical path placeholders while preserving every other fixture byte. From origin cwd, exercise prepared, status, choice, and stopped continuation.
- [ ] Before each command, classify files into immutable authority (route, executor, forwarding, active-turn/session ledger, caller/index) and documented operation state. Assert immutable files remain byte-identical. Assert only the consumed preparation/pending record changes as its existing store contract specifies, and explicitly snapshot/assert expected job, binding, broker/session, result, and cleanup additions or transitions rather than treating them as immutable.
- [ ] Run:

```bash
node --test tests/integration/skills.test.mjs
```

Expected GREEN: all integration tests pass.

### 2.5 Commit

- [ ] Run `git diff --check`, inspect error messages for path/ID leakage, and commit:

```bash
git add scripts/zcode-companion.mjs tests/integration/skills.test.mjs tests/fixtures/pr39-origin-route-compatibility.mjs
git commit -m 'fix: execute routed Rescue children in bound worktrees'
```

## Task 3: Reproduce Codex origin cwd in qualification and authenticated ZCode

**Files:**

- Modify: `tests/e2e/codex-skills-e2e.test.mjs`
- Modify: `tests/e2e/real-zcode.test.mjs`
- Modify if required by captured qualification helpers: `tests/helpers/codex-rescue-qualification.mjs`
- Modify if required by core qualification tests: `tests/codex-rescue-qualification.test.mjs`
- Modify: `CHANGELOG.md`

### 3.1 Qualification verification: installed child starts at origin

- [ ] Change linked-worktree qualification invocations so `SubagentStart` and child launcher run at the origin while `prepare rescue` and expected ZCode execution remain at the bound worktree.
- [ ] Assert evidence for route at origin and executor, preparation, broker/session, job, result, and cleanup at target.
- [ ] This is post-implementation qualification, so expect GREEN rather than manufacturing a second RED. Run the exact captured test:

```bash
node --test --test-concurrency=1 --test-name-pattern='installed continuation capture qualifies one parent turn from origin hooks into a linked execution worktree' tests/e2e/codex-skills-e2e.test.mjs
```

### 3.2 GREEN: qualification and installed artifact behavior

- [ ] Keep the child host execution envelope strict, but distinguish `originWorkspace` (Codex child launcher cwd) from `executionWorkspace` (executor, preparation, broker/session, job, result, and cleanup). Do not weaken validation to accept an arbitrary cwd.
- [ ] Make only the helper/expectation changes needed for the installed plugin to reproduce real Codex cwd behavior.
- [ ] Run:

```bash
node --test tests/e2e/codex-skills-e2e.test.mjs
node --test tests/codex-rescue-qualification.test.mjs
```

Expected GREEN: captured/installed E2E tests pass.

### 3.3 Authenticated direct ZCode verification

- [ ] In the real-ZCode fixture, change `invokePrepared` cwd from `executionWorkspace` to `originWorkspace` while retaining assertions that the actual ZCode session workspace is the linked target. This is post-implementation validation and should be GREEN; the production-shaped RED was recorded in Task 2.1.
- [ ] Run ZCode directly, never through Rescue:

```bash
ZCODE_REAL_E2E=1 ZCODE_REAL_E2E_MODEL='bigmodel/GLM-5.2' node --test --test-concurrency=1 tests/e2e/real-zcode.test.mjs
```

Expected GREEN: the authenticated test receives a non-empty real ZCode response and proves target-scoped workspace/session evidence.

### 3.4 Documentation and commit

- [ ] Add a changelog entry explaining backward-compatible origin-route resolution for children restored or launched from the conversation root.
- [ ] Run focused E2E files again and commit:

```bash
git add tests/e2e/codex-skills-e2e.test.mjs tests/e2e/real-zcode.test.mjs tests/helpers/codex-rescue-qualification.mjs tests/codex-rescue-qualification.test.mjs CHANGELOG.md
git commit -m 'test: qualify Rescue origin route compatibility'
```

If the helper is untouched, omit it from `git add`.

## Task 4: Full verification, independent review, marketplace snapshot, and PR

**Files:**

- Modify generated marketplace artifact only through the repository's documented build command.
- No source behavior changes unless a failing test or review finding requires a new RED first.

### 4.1 Local verification before review

- [ ] Run:

```bash
npm run check
git diff --check
git status --short
```

Expected: main suite, marketplace build checks, and qualification all pass; no unexpected files.

### 4.2 Reviews

- [ ] Dispatch an independent whole-branch spec review against `docs/superpowers/specs/2026-08-22-rescue-origin-route-resolution-design.md`.
- [ ] After spec approval, dispatch an independent code-quality/security review against `origin/main...HEAD`.
- [ ] Route every finding back to the responsible implementation subagent. For behavior fixes, require a new failing regression test first. Repeat both reviews until approved.

### 4.3 Clean-source marketplace snapshot

- [ ] From a clean reviewed source commit, build outside the repository:

```bash
git status --short
SOURCE_SHA="$(git rev-parse HEAD)"
SNAPSHOT_PARENT="$(mktemp -d)"
node scripts/build-marketplace-snapshot.mjs \
  --output "$SNAPSHOT_PARENT/marketplace-snapshot" \
  --source-ref "$SOURCE_SHA" \
  --source-sha "$SOURCE_SHA"
```

- [ ] Mechanically synchronize the verified output; never hand-edit generated files:

```bash
rsync -a --delete "$SNAPSHOT_PARENT/marketplace-snapshot/plugins/zcode/" marketplace/plugins/zcode/
cmp -s "$SNAPSHOT_PARENT/marketplace-snapshot/.agents/plugins/marketplace.json" marketplace/.agents/plugins/marketplace.json || cp "$SNAPSHOT_PARENT/marketplace-snapshot/.agents/plugins/marketplace.json" marketplace/.agents/plugins/marketplace.json
cmp -s "$SNAPSHOT_PARENT/marketplace-snapshot/.agents/plugins/provenance.json" marketplace/.agents/plugins/provenance.json || cp "$SNAPSHOT_PARENT/marketplace-snapshot/.agents/plugins/provenance.json" marketplace/.agents/plugins/provenance.json
```

- [ ] Verify parity and installability:

```bash
node --test tests/marketplace-snapshot.test.mjs tests/plugin-contracts.test.mjs tests/release-contracts.test.mjs
node --test tests/integration/marketplace-snapshot-build.mjs
MARKETPLACE_SNAPSHOT="$SNAPSHOT_PARENT/marketplace-snapshot" \
MARKETPLACE_SOURCE_REF="$SOURCE_SHA" \
MARKETPLACE_SOURCE_SHA="$SOURCE_SHA" \
node --test tests/integration/marketplace-install.test.mjs
```

- [ ] Commit generated artifacts separately, rerun `npm run check`, and verify the generated snapshot exactly matches source:

```bash
git add marketplace/plugins/zcode marketplace/.agents/plugins/marketplace.json marketplace/.agents/plugins/provenance.json
git commit -m 'build: refresh ZCode marketplace snapshot'
npm run check
```

### 4.4 Push and PR

- [ ] Push `fix/rescue-origin-route-resolution` and open a PR against `main` summarizing the incident, immutable-route design, frozen PR #39 compatibility, RED/GREEN evidence, and authenticated real-ZCode evidence.
- [ ] Monitor every required GitHub Actions job. Diagnose platform-specific failures, add a failing regression test where applicable, fix, review, push, and repeat until all required checks are green.
- [ ] Confirm the PR is mergeable and leave it unmerged.

## Completion evidence

- Approved design and implementation plan commits.
- Recorded production-shaped RED: origin child fails with `EXECUTOR_IDENTITY_NOT_FOUND` before implementation.
- Frozen PR #39 fixtures pass without authority-file rewrites.
- Full `npm run check` passes from a clean worktree.
- Authenticated direct ZCode child returns an actual response with target-worktree session evidence.
- Separate spec and code-quality reviews are approved.
- PR URL, mergeable state, and all required GitHub Actions checks green.
