# Rescue Continuation Rollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a pre-running active-v3 Rescue continuation failure from leaving its binding pointed at an unusable job, and provide a strict repository-only repair tool for the one already-corrupted retained binding.

**Architecture:** Keep reservation-time binding advancement for concurrency safety. Add one StateStore transaction that, under the workspace lock, proves the queued continuation and exact current binding still match, restores the saved prior binding, and terminalizes the failed attempt. Wire every pre-running resume failure through it. Expose the same invariant checks through a dry-run-by-default maintenance tool; never place historical repair logic on the normal plugin path.

**Tech Stack:** Node.js ES modules, `node:test`, filesystem state and lock helpers, ZCode companion integration tests, SHA-pinned marketplace snapshot builder.

---

## Task 1: Add the active-continuation rollback transaction

**Files:**

- Modify: `scripts/lib/state.mjs`
- Modify: `tests/rescue-binding.test.mjs`

- [ ] Add focused StateStore tests before production changes. Reserve a normal active-v3 continuation, then prove a new `finishActiveRescueContinuationFailure(workspace, jobId, proof, 'failed', patch)` operation:
  - leaves the attempt as a retained failed job;
  - restores the byte-equivalent prior binding except for a strictly monotonic `updatedAt`;
  - removes private continuation/execution proof from the terminal job;
  - rejects a changed binding key, operation, current job, prior binding, non-queued job, started job, claimed job, or mismatched workspace;
  - is idempotent when the first call restored the binding and terminalized the same job;
  - converges safely when a publication checkpoint throws after binding restoration but before job publication.

- [ ] Run the new tests and confirm RED because the StateStore method does not exist:

```bash
node --test --test-name-pattern='active continuation failure' tests/rescue-binding.test.mjs
```

- [ ] Implement the smallest locked transaction in `scripts/lib/state.mjs`. It must accept only the exact `job.rescueContinuationOrigin` proof, require a writable queued Rescue attempt with no running/lease/session/boundary/result evidence, require the active-v3 binding to point at that job with the same key and operation as `priorBinding`, restore the prior record with a monotonic timestamp, then publish the failed job. Re-entry may return the already-terminal job only after verifying that the exact prior binding is restored.

```js
await store.finishActiveRescueContinuationFailure(
  workspace,
  job.id,
  job.rescueContinuationOrigin,
  'failed',
  { error: serializeError(error) },
);
```

- [ ] Use the existing guarded binding-partition publication and checkpoint hooks; do not add a second lock or a normal-runtime scan. Run the focused test, then all binding tests:

```bash
node --test --test-name-pattern='active continuation failure' tests/rescue-binding.test.mjs
node --test tests/rescue-binding.test.mjs
```

- [ ] Commit this task:

```bash
git add scripts/lib/state.mjs tests/rescue-binding.test.mjs
git commit -m 'fix: roll back failed Rescue continuations'
```

## Task 2: Route all pre-running active continuation failures through rollback

**Files:**

- Modify: `scripts/zcode-companion.mjs`
- Modify: `scripts/lib/review.mjs` only if the existing callback contract cannot cover the failure boundary
- Modify: `tests/integration/companion.test.mjs`
- Modify: `tests/job-control.test.mjs` only for background-worker coverage not expressible in the companion fixture

- [ ] Add integration tests first for foreground and background continuations. Force `session/resume`, runtime-model resolution, and an outer pre-execution dependency to fail separately. After each failure assert that the failed attempt remains inspectable, the original binding is restored, and a later invocation for the same child/session resumes successfully without calling `session/create`.

- [ ] Extend the cold-runtime-update rejection regression so its next invocation resumes the original session successfully. Run only the new cases and confirm RED because the binding still points at the failed attempt:

```bash
node --test --test-name-pattern='rolls back active continuation|cold runtime.*retry' tests/integration/companion.test.mjs tests/job-control.test.mjs
```

- [ ] In `executeReserved`, install an `onResumeFailure` handler for `rescueContinuationOrigin.kind === 'active-continuation'` as well as the existing legacy migration handler. Ensure failures before `executeJob` reaches that callback use the same transaction from the outer catch. Never roll back after `onResumeSucceeded`, after `startedAt`, or after any persisted task boundary.

- [ ] Keep legacy session-ended migration behavior unchanged and avoid a fresh-session fallback. Run focused and neighboring suites:

```bash
node --test tests/integration/companion.test.mjs tests/job-control.test.mjs tests/rescue-binding.test.mjs
```

- [ ] Commit this task:

```bash
git add scripts/zcode-companion.mjs scripts/lib/review.mjs tests/integration/companion.test.mjs tests/job-control.test.mjs
git commit -m 'fix: restore Rescue binding before execution starts'
```

## Task 3: Add the strict one-time repair API and repository-only CLI

**Files:**

- Modify: `scripts/lib/state.mjs`
- Create: `tools/repair-rescue-continuation-binding.mjs`
- Create: `tests/rescue-binding-repair.test.mjs`
- Modify: `tests/integration/package-install.test.mjs`

- [ ] Write tests first for dry-run, apply, repeated apply, and fail-closed mutation cases. The request must include exact data root, workspace, parent session, child agent/path, binding key, operation ID, anchor job ID, failed current job ID, and expected binding `updatedAt`.

- [ ] Test that repair is allowed only when the active-v3 hook binding exactly matches, the anchor is resumable with a ZCode session, the current job is failed and has no `startedAt`, `zcodeSessionId`, input/start revision, boundary, or result, and no writable active job exists. Also test that the failed job is never edited and the CLI makes no ZCode RPC.

- [ ] Test CLI behavior: dry-run is the default, `--apply` is explicit, machine-readable output distinguishes `repairable`, `repaired`, and `already-repaired`, malformed/partial arguments fail, and package/marketplace artifacts exclude `tools/repair-rescue-continuation-binding.mjs`.

- [ ] Run and confirm RED:

```bash
node --test tests/rescue-binding-repair.test.mjs tests/integration/package-install.test.mjs
```

- [ ] Implement a locked/CAS StateStore maintenance operation using the same binding validator and guarded partition writer as runtime state. Dry-run performs every validation without writing. Apply restores `currentJobId` to the exact anchor, advances `updatedAt`, preserves operation/authority/history and the failed job, and treats the exact already-restored result as idempotent. Do not export this through a skill, companion command, startup hook, `package.json` `files`, or marketplace payload.

- [ ] Implement the thin CLI argument parser and JSON result writer. It must require an explicit `--data-root` and all expected identity/CAS fields; never discover a candidate by scanning.

- [ ] Run focused tests and commit:

```bash
node --test tests/rescue-binding-repair.test.mjs tests/integration/package-install.test.mjs
git add scripts/lib/state.mjs tools/repair-rescue-continuation-binding.mjs tests/rescue-binding-repair.test.mjs tests/integration/package-install.test.mjs
git commit -m 'feat: add guarded Rescue binding repair tool'
```

## Task 4: Document the invariant and refresh distributable parity

**Files:**

- Modify: `docs/adr/0013-bind-rescue-child-to-zcode-session.md`
- Modify: `CHANGELOG.md`
- Modify if required by contracts: `scripts/build-marketplace-snapshot.mjs`
- Modify: `tests/release-contracts.test.mjs`
- Modify: `tests/marketplace-snapshot.test.mjs`
- Regenerate: `marketplace/plugins/zcode/**`
- Regenerate: `marketplace/.agents/plugins/marketplace.json`
- Regenerate: `marketplace/.agents/plugins/provenance.json`

- [ ] Add release-contract assertions before prose changes: runtime StateStore and companion fixes must ship in source/package/marketplace parity, while the repository-only repair CLI must not ship.

- [ ] Amend ADR 0013 with reservation-time advancement, exact pre-running rollback, idempotency/crash convergence, and the separation between runtime correction and operator maintenance. Add a concise changelog entry.

- [ ] Run source release tests, commit all non-generated source changes, and ensure the tree is clean:

```bash
node --test tests/release-contracts.test.mjs tests/marketplace-snapshot.test.mjs tests/plugin-contracts.test.mjs
git add docs/adr/0013-bind-rescue-child-to-zcode-session.md CHANGELOG.md scripts/build-marketplace-snapshot.mjs tests/release-contracts.test.mjs tests/marketplace-snapshot.test.mjs
git commit -m 'docs: record Rescue continuation rollback invariant'
```

- [ ] Generate the marketplace only from the clean exact commit; do not hand-edit generated files:

```bash
SOURCE_SHA="$(git rev-parse HEAD)"
SNAPSHOT_PARENT="$(mktemp -d)"
node scripts/build-marketplace-snapshot.mjs \
  --output "$SNAPSHOT_PARENT/marketplace-snapshot" \
  --source-ref "$SOURCE_SHA" \
  --source-sha "$SOURCE_SHA"
rsync -a --delete "$SNAPSHOT_PARENT/marketplace-snapshot/plugins/zcode/" marketplace/plugins/zcode/
cp "$SNAPSHOT_PARENT/marketplace-snapshot/.agents/plugins/marketplace.json" marketplace/.agents/plugins/marketplace.json
cp "$SNAPSHOT_PARENT/marketplace-snapshot/.agents/plugins/provenance.json" marketplace/.agents/plugins/provenance.json
```

- [ ] Verify and commit the generated snapshot:

```bash
node --test tests/marketplace-snapshot.test.mjs tests/plugin-contracts.test.mjs tests/release-contracts.test.mjs
node --test tests/integration/marketplace-snapshot-build.mjs
MARKETPLACE_SNAPSHOT="$SNAPSHOT_PARENT/marketplace-snapshot" \
MARKETPLACE_SOURCE_REF="$SOURCE_SHA" MARKETPLACE_SOURCE_SHA="$SOURCE_SHA" \
  node --test tests/integration/marketplace-install.test.mjs
git add marketplace
git commit -m 'build: refresh ZCode marketplace snapshot'
```

## Task 5: Qualify, review, publish, and repair the retained incident

**Files:** No new implementation files; fix review or CI findings in their owning task files.

- [ ] Run repository qualification from a clean tree:

```bash
npm run check:line-endings
npm run lint
npm run typecheck
npm test
npm run test:qualified
```

- [ ] Request a final branch review against the design spec and this plan. Resolve every Critical or Important issue, rerun affected tests, then rerun the full qualification above.

- [ ] Push `fix/rescue-continuation-rollback`, create the PR with the incident semantics, tests, and repair safety called out, and monitor every required GitHub check. For any failure, inspect logs, fix locally with TDD, obtain task-level reviews for material changes, push, and continue until all checks are successful.

- [ ] Only after CI is green, use the reviewed branch tool for an exact dry-run against the retained incident:

```bash
node tools/repair-rescue-continuation-binding.mjs \
  --data-root /Users/zhangzikai/.codex/plugins/data/zcode-vitry \
  --workspace /Users/zhangzikai/Workspace/Codes/tmp/zcodeplugin/.worktrees/neon-strike \
  --parent-session-id 01a022d7-aa12-7112-abe0-78036571802e \
  --child-agent-id 01a04106-1b1c-7d30-948e-06338cd76a0d \
  --child-agent-path /root/zcode_rescue_task_3 \
  --binding-key 73c9ce0d876c281ab613b04fcec74cb99840018297dc60f8cdd320fd9e13714b \
  --operation-id 06882c57a4856a53ae7904c837d47ac11c493d0960de41be2e545e7cac911b3b \
  --anchor-job-id 76fb0632bf9bd8936ea6b1ae21a73157ccceb001b629e7a940907b17696aa53f \
  --failed-current-job-id 78633a022684e5d528710579ae742510f6df9689950177313be45f437b6d98a5 \
  --expected-binding-updated-at 2026-08-28T23:10:22.291Z
```

- [ ] Require the dry-run result to be exactly `repairable`; then repeat with `--apply`. Perform a final read-only invocation and require `already-repaired`. Independently verify the binding points to the anchor session `sess_0dc45ef1-c2ae-4e17-8840-b33660c94666`, the failed attempt is unchanged, and no ZCode session was created or resumed by the repair.

