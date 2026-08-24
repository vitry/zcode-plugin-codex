# Rescue Persistent Child Rejoin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve and safely rejoin completed Rescue child operations across SessionEnd, plugin restart, and Root resume while keeping explicit cancellation and fresh replacement irreversible.

**Architecture:** Keep the existing durable binding and job records. Stop using SessionEnd as operation revocation, add a lock-protected legacy migration for exact `session-ended` tombstones, and make route planning validate the exact persisted child before publishing a resumed route. Preserve the constant private child assignment and original ZCode session.

**Tech Stack:** Node.js ESM, `node:test`, private JSON state files, Codex app-server child discovery, ESLint, TypeScript checks.

---

### Task 1: Add the failing state migration tests

**Files:**
- Modify: `tests/state.test.mjs`
- Modify: `tests/integration/companion.test.mjs`

- [ ] **Step 1: Add a state-level RED test for exact `session-ended` migration**

Create a binding with a succeeded anchor job, close it only through the `session-ended` path, then call the new resume resolver with the exact parent, child, workspace, permission, and migration proof. Assert that it returns the same operation ID, anchor job, current job, and active binding. Assert a second call is idempotent and does not create another job or binding record.

- [ ] **Step 2: Add state-level RED tests for non-migratable closures**

Cover `fresh`, cancel/invalidation, wrong parent session, wrong workspace, wrong child, missing anchor job, and missing ZCode session. Each assertion must expect the existing closed/invalid error and must assert the binding partition and job list are unchanged.

- [ ] **Step 3: Run only the new tests and verify the expected RED failure**

```bash
node --test --test-concurrency=1 --test-name-pattern='session-ended migration|non-migratable closure' tests/state.test.mjs
```

Expected: failures because no migration API exists and SessionEnd closures are currently rejected.

- [ ] **Step 4: Add the integration RED test for Root resume after SessionEnd**

Extend the existing legacy adoption fixture in `tests/integration/companion.test.mjs`: complete the first Rescue job, invoke the exact SessionEnd binding lifecycle, begin a resumed Root turn with the same session ID, prepare a proactive resume, and assert the second invocation uses the original ZCode session and creates no child replacement.

- [ ] **Step 5: Run the integration RED test**

```bash
node --test --test-concurrency=1 --test-name-pattern='resume after SessionEnd' tests/integration/companion.test.mjs
```

Expected: failure with the current closed-binding behavior.

### Task 2: Implement lock-safe binding migration and SessionEnd preservation

**Files:**
- Modify: `scripts/lib/state.mjs`
- Modify: `scripts/lib/rescue-binding.mjs`
- Modify: `hooks/session-end-hook.mjs`

- [ ] **Step 1: Add an exact migration input contract**

Define an internal state-store operation that accepts the canonical workspace, parent session, child identity, permission snapshot, operation ID, and the validated child/path/session proof supplied by route planning. Reject every missing or malformed field before mutation.

- [ ] **Step 2: Implement `session-ended` migration under the existing state lock**

Read the binding partition and exact anchor/current job records. Permit only an active structural binding or a closed binding whose sole close reason is `session-ended`. For a closed record, compare the complete expected snapshot, replace it with an active record using the same operation/anchor/current IDs, and publish via the existing guarded partition writer. A competing writer must return the current exact state or fail closed; it must not duplicate records.

- [ ] **Step 3: Stop closing valid Rescue bindings from SessionEnd**

Remove the unconditional `closeRescueBindingsForSession` call from `hooks/session-end-hook.mjs`. Preserve the existing writable-job settlement, broker cleanup, and preparation cleanup. Do not change explicit cancel/fresh close paths.

- [ ] **Step 4: Run the state tests GREEN**

```bash
node --test --test-concurrency=1 --test-name-pattern='session-ended migration|non-migratable closure' tests/state.test.mjs
```

Expected: all migration and fail-closed tests pass.

### Task 3: Integrate exact child rejoin into route planning

**Files:**
- Modify: `scripts/lib/rescue-route-planner.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Modify: `tests/rescue-route-planner.test.mjs`
- Modify: `tests/integration/companion.test.mjs`

- [ ] **Step 1: Add planner RED coverage for a closed legacy binding**

Provide a stopped persisted host with the exact child ID/path and a `session-ended` binding. Assert that resume planning returns the existing follow-up directive with `legacy-bound`, never a spawn directive.

- [ ] **Step 2: Pass exact child/path proof to migration**

When the planner has identified the stopped host and canonical origin/execution workspaces, validate the persisted authority view and path digest before requesting migration. The migration resolver must receive the exact host ID, agent role, agent path digest, parent session, and execution workspace.

- [ ] **Step 3: Preserve the original operation and ZCode session**

Ensure the prepared activation and reservation path continue using the binding operation ID and current/anchor job IDs. Do not call fresh reservation or create a new ZCode peer for this route.

- [ ] **Step 4: Run planner and integration tests GREEN**

```bash
node --test --test-concurrency=1 tests/rescue-route-planner.test.mjs tests/integration/companion.test.mjs
```

Expected: existing route tests and the new resume-after-SessionEnd scenario pass.

### Task 4: Preserve explicit revocation and sibling isolation

**Files:**
- Modify: `tests/hooks.test.mjs`
- Modify: `tests/integration/companion.test.mjs`
- Modify: `SECURITY.md`
- Modify: `docs/adr/0013-bind-rescue-child-to-zcode-session.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: Add SessionEnd and sibling lifecycle tests**

Assert that SessionEnd leaves completed bindings for the exact owner intact, does not alter another parent session's binding, and does not allow an active writable job to bypass existing settlement/guard behavior.

- [ ] **Step 2: Add explicit revocation tests**

Assert that cancel and fresh replacement close the old operation and that the migration path rejects those records. Assert that a new fresh operation gets a new operation ID and ZCode session.

- [ ] **Step 3: Update security and architecture documentation**

Replace statements claiming SessionEnd permanently revokes all Rescue bindings with the precise rule: SessionEnd removes runtime ownership and performs writable-job settlement, while exact persisted completed bindings are rejoinable; explicit cancel/fresh/invalidation remain revocation boundaries.

- [ ] **Step 4: Run focused lifecycle tests**

```bash
node --test --test-concurrency=1 --test-name-pattern='SessionEnd|sibling|fresh|cancel|migration' tests/hooks.test.mjs tests/integration/companion.test.mjs
```

Expected: all lifecycle, revocation, and isolation tests pass.

### Task 5: Full verification and handoff

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a changelog entry describing persistent child rejoin**

State that Root resume after runtime/session restart reuses the exact child and ZCode session, while explicit cancellation and fresh replacement remain terminal.

- [ ] **Step 2: Run formatting and static checks**

```bash
npm run check:line-endings
npm run lint
npm run typecheck
```

Expected: exit code 0 for all commands.

- [ ] **Step 3: Run the complete test suite**

```bash
npm test
```

Expected: all unit, integration, and marketplace snapshot tests pass.

- [ ] **Step 4: Run qualified tests if prerequisites are available**

```bash
npm run test:qualified
```

Expected: qualified tests pass; if the environment is not authenticated or the installed fixture is unavailable, record the exact prerequisite failure without weakening the local proof.

- [ ] **Step 5: Review the final diff and commit implementation**

```bash
git diff --check
git status --short
git diff --stat
```

Then commit only the implementation/spec/documentation files belonging to this change with:

```bash
git commit -m "fix: preserve Rescue child rejoin across session resume"
```
