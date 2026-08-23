# Rescue Legacy Child Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Restore exact persisted named Rescue children without historical Hook executor artifacts and prevent unrelated child Roles from blocking valid Rescue recovery.

**Architecture:** Classify exact-parent Codex rows before Hook lookup, and represent true executor absence as a private legacy-adopt preparation activation. The resumed child rereads its own Codex identity, resolves the current parent and linked execution workspace through the identity ledger, consumes the preparation atomically, and passes an explicit codex-legacy-adoption authority into versioned binding storage without synthesizing Hook provenance.

**Tech Stack:** Node.js ESM, Codex app-server JSON-RPC, strict private JSON codecs, node:test, Hook/identity/StateStore primitives, GitHub Actions.

---

## File Structure

- scripts/lib/rescue-route-planner.mjs: candidate classification and deterministic route selection.
- scripts/lib/codex-app-server.mjs: exact child identity read without a supplied parent.
- scripts/lib/rescue-preparation.mjs: legacy-adopt activation, proof, and authority identity.
- scripts/lib/rescue-binding.mjs: versioned child-authority binding codec.
- scripts/lib/state.mjs: atomic reservations for Hook or adoption authority.
- scripts/zcode-companion.mjs: child-side adoption and fake-ZCode pipeline.
- Focused tests in tests/rescue-*.test.mjs, tests/codex-app-server.test.mjs, and tests/state.test.mjs.
- Incident integration in tests/integration/companion.test.mjs and tests/integration/skills.test.mjs.
- Qualification, bilingual docs, security, changelog, and generated marketplace snapshot.

## Task 0: Freeze reviewed design and plan

**Files:**
- Commit: docs/superpowers/specs/2026-08-24-rescue-legacy-child-adoption-design.md
- Commit: docs/superpowers/plans/2026-08-24-rescue-legacy-child-adoption.md

- [ ] **Step 1: Commit the independently reviewed contract before source work**

    git diff --check
    git add docs/superpowers/specs/2026-08-24-rescue-legacy-child-adoption-design.md docs/superpowers/plans/2026-08-24-rescue-legacy-child-adoption.md
    git commit -m "docs: plan legacy Rescue child adoption"

## Task 1: Classify hosts before Rescue authority lookup

**Files:**
- Modify: scripts/lib/rescue-route-planner.mjs
- Test: tests/rescue-route-planner.test.mjs
- Test: tests/integration/companion.test.mjs

- [ ] **Step 1: Write the ordinary-child pollution RED test**

Create newest-first exact-parent rows for /root/t1_spec_review Role default, /root/plan_audit Role explorer, host-only /root/zcode_rescue_task Role zcode-rescue, and bound /root/zcode_rescue_task_2 Role zcode-rescue. Record every resolver call. Require resume to return exact followup /root/zcode_rescue_task_2 and require no resolver call for the ordinary rows.

    assert.deepEqual(planned.directive, {
      version: 2, action: 'followup', target: '/root/zcode_rescue_task_2',
      assignment: 'zcode-rescue',
    });
    assert.deepEqual(resolvedIds, ['legacy-base', 'bound-ordinal']);

- [ ] **Step 2: Run RED**

    node --test --test-name-pattern='ordinary persisted children are occupancy-only' tests/rescue-route-planner.test.mjs

Expected: FAIL with EXECUTOR_ROLE_UNAPPROVED or an unexpected ordinary-child resolver call.

- [ ] **Step 3: Write the legacy-base RED test**

The only host is named zcode-rescue, managed base path, status notLoaded, and the resolver throws exactly EXECUTOR_IDENTITY_NOT_FOUND. Require:

    assert.deepEqual(planned.activation, {
      kind: 'legacy-adopt',
      childThreadId: 'legacy-base',
      agentPathDigest: digest('/root/zcode_rescue_task'),
    });
    assert.deepEqual(planned.directive, {
      version: 2, action: 'followup', target: '/root/zcode_rescue_task',
      assignment: 'zcode-rescue',
    });

Add negative cases for generic/null without an exact default executor, explicit default/explorer Role, non-managed path, active host-only status, corrupt/ambiguous executor evidence, and duplicate host identity.

Add a previously-adopted bound candidate case that emits exact
`legacy-bound` with child ID, path digest, and binding key without predicting
the preparation generation; an unbound
generation-one host emits `legacy-adopt` without a binding key.

- [ ] **Step 4: Run RED**

    node --test --test-name-pattern='legacy named Rescue host is adopted' tests/rescue-route-planner.test.mjs

Expected: FAIL because current output is spawn zcode_rescue_task_2.

- [ ] **Step 5: Implement minimal classification and selection**

All validated paths remain occupied. Only direct managed task names with Role zcode-rescue or null enter executor resolution. Named final NOT_FOUND plus notLoaded becomes a legacy candidate; generic absence stays occupancy-only; every expired/state/ambiguous/invalid/route/Role result and every surviving contradictory Hook or subagent-start binding remains terminal. Fresh selects base then newest inside the proven set and uses legacy only when no proven candidate exists. Resume selects a unique exact bound proven/previously-adopted candidate first; one unbound legacy candidate may follow, while multiple unbound legacy candidates fail ambiguous. Every follow-up is v2 with exact task-free assignment. Spawn retains the exact v1 route with no assignment so existing named-to-generic schema negotiation remains unchanged.

- [ ] **Step 6: Verify GREEN**

    node --test tests/rescue-route-planner.test.mjs tests/codex-app-server.test.mjs tests/integration/companion.test.mjs
    npm run lint
    npm run typecheck
    git diff --check

- [ ] **Step 7: Commit**

    git add scripts/lib/rescue-route-planner.mjs tests/rescue-route-planner.test.mjs tests/integration/companion.test.mjs
    git commit -m "fix: isolate persisted Rescue candidates"

## Task 2: Add exact host-backed preparation proof

**Files:**
- Modify: scripts/lib/codex-app-server.mjs
- Modify: scripts/lib/rescue-preparation.mjs
- Test: tests/codex-app-server.test.mjs
- Test: tests/rescue-preparation.test.mjs

- [ ] **Step 1: Write child-identity read RED tests**

Specify readCodexThreadSpawnChildIdentity(threadId, options). A valid raw thread/read with equal top-level/nested parent, Role, path, and requested child ID returns the defensive SpawnChild. Contradictory/missing parent, Role drift, malformed status, wrong child, timeout, abort, and output overflow fail with bounded existing errors and reap the process.

- [ ] **Step 2: Run RED**

    node --test --test-name-pattern='reads exact persisted child identity without a supplied parent' tests/codex-app-server.test.mjs

- [ ] **Step 3: Implement the bounded read**

Reuse the sequential JSON-RPC transport and raw validator. Do not scan and do not weaken the existing read with expected parent.

- [ ] **Step 4: Write legacy-adopt codec RED tests**

Use:

    const activation = {
      kind: 'legacy-adopt',
      childThreadId: 'legacy-child',
      agentPathDigest: 'c'.repeat(64),
    };
    const proof = {
      kind: 'legacy-adopt',
      agentPathDigest: 'c'.repeat(64),
    };

Require generation-one `legacy-adopt` plus `legacy-bound` round trips at both new-turn generation one and same-turn generation two, ambient consumer ID equality, exact proof, one-shot consume, expiry, and authority IDs. The bound activation additionally binds the exact existing adoption `bindingKey`:

    sha256(JSON.stringify([
      'rescue-legacy-adoption-authority-v1',
      record.key,
      record.executorAgentId,
      record.generation,
      record.createdAt,
    ]))

and for continuation:

    sha256(JSON.stringify([
      'rescue-legacy-bound-authority-v1',
      record.key,
      record.executorAgentId,
      record.generation,
      record.createdAt,
      record.activation.bindingKey,
    ]))

Reject wrong child/digest/binding/kind, unknown keys, missing proof, `legacy-adopt` after generation one, and `legacy-bound` without an exact existing adoption binding or without consuming. Do not reject `legacy-bound` merely because its locked record generation is one.

- [ ] **Step 5: Run RED**

    node --test --test-name-pattern='legacy-adopt' tests/rescue-preparation.test.mjs

- [ ] **Step 6: Implement minimal codec**

Extend the activation union without changing the outer v3 record. Export an authority-ID helper that accepts only a validated consumed `legacy-adopt` or `legacy-bound` record. Binding-backed preparations at any generation use exact `legacy-bound`, `bindingKey`, and `requiredExecutorAgentId`; they never recreate first adoption. Generation remains chosen inside the preparation-store lock, not by the planner.

- [ ] **Step 7: Verify and commit**

    node --test tests/codex-app-server.test.mjs tests/rescue-preparation.test.mjs
    npm run lint
    npm run typecheck
    git diff --check
    git add scripts/lib/codex-app-server.mjs scripts/lib/rescue-preparation.mjs tests/codex-app-server.test.mjs tests/rescue-preparation.test.mjs
    git commit -m "feat: bind legacy Rescue adoption proof"

## Task 3: Persist explicit child-authority provenance

**Files:**
- Modify: scripts/lib/rescue-binding.mjs
- Modify: scripts/lib/state.mjs
- Test: tests/rescue-binding.test.mjs
- Test: tests/state.test.mjs

- [ ] **Step 1: Write binding v2 RED tests**

New writes persist the spec's exact v2 top-level fields and one exact childAuthority union. Hook authority contains kind subagent-start, exact child ID/type, historical parent turn, and historical permission. Adoption authority contains kind codex-legacy-adoption, authorityId, exact named child, current authorizing turn/generation/permission, origin/execution workspace, and path digest.

Require v1 fixture bytes to remain readable as Hook authority without rewriting. Keep the binding-key domain stable on parent session, child ID, and workspace. Reject mixed variants, unknown keys, invalid digest/generation, default adoption Role, wrong workspace, and mismatched key.

- [ ] **Step 2: Run RED**

    node --test --test-name-pattern='child authority|version one binding' tests/rescue-binding.test.mjs

- [ ] **Step 3: Implement the versioned codec**

Parse exact v1 and v2 record variants. createRescueBinding writes v2. close, partition, byte/count bounds, ordering, CAS, and file identity checks accept both. Add version-neutral helpers for child ID/type and authority kind. Never bulk-migrate.

- [ ] **Step 4: Write StateStore RED tests**

Require reservation input to contain exactly one Hook executor, first-adoption authority, or transient continuation authority. Prove first adopted fresh atomically publishes one job and binding; the same child cannot obtain parallel slots; later continuation requires the exact active legacy authority binding and never persists its transient proof; v1 Hook bindings remain valid; and every child/turn/generation/permission/workspace/path/binding/authority mutation fails before publication.

- [ ] **Step 5: Run RED**

    node --test --test-name-pattern='legacy adoption authority' tests/state.test.mjs

- [ ] **Step 6: Implement explicit StateStore authority**

Normalize durable Hook/adoption authority through one private bindingAuthorityIdentity function and validate the transient `codex-legacy-continuation` only against the exact durable adoption binding. Preserve current executor callers. Do not create Hook executor/route files or executor-shaped adoption objects.

- [ ] **Step 7: Verify and commit**

    node --test tests/rescue-binding.test.mjs tests/state.test.mjs
    npm run lint
    npm run typecheck
    git diff --check
    git add scripts/lib/rescue-binding.mjs scripts/lib/state.mjs tests/rescue-binding.test.mjs tests/state.test.mjs
    git commit -m "feat: persist Rescue child authority source"

## Task 4: Execute legacy adoption through Companion

**Files:**
- Modify: scripts/zcode-companion.mjs
- Modify: skills/rescue/SKILL.md
- Test: tests/integration/companion.test.mjs
- Test: tests/integration/skills.test.mjs
- Test: tests/integration/two-session-hooks.test.mjs
- Test: tests/e2e/real-zcode.test.mjs
- Test: tests/e2e/codex-skills-e2e.test.mjs
- Test: tests/skills-contracts.test.mjs

- [ ] **Step 1: Write the full incident RED integration**

Create an active resumed parent bound from origin to a linked execution worktree, exact host-only named notLoaded base child, no Hook executor files, base followup preparation, child invocation from origin with the old ambient ID, child-side active host read, and fake ZCode create/send returning done.

Assert exact followup, zero spawn, zero Hook executor/route files, one consumed preparation, one v2 adoption binding, one execution-worktree job, one fake create/send, and terminal response.

- [ ] **Step 2: Run RED**

    node --test --test-name-pattern='host-only legacy Rescue child is adopted into linked worktree' tests/integration/companion.test.mjs

Expected: FAIL at missing executor resolution.

- [ ] **Step 3: Implement host-backed consumption**

Preserve ordinary plus durable Hook resolution. Only after final exact EXECUTOR_IDENTITY_NOT_FOUND may Companion read the exact child identity, validate named managed Rescue Role/path, resolve its parent active turn from ambient cwd with workspaceBinding execution, then require host cwd equals caller.originWorkspace and ambient cwd is origin or exact execution workspace, consume the execution-worktree preparation, build the explicit adoption authority, and pass it mutually exclusively with executor to StateStore. Every other resolver error is terminal.

If a matching SubagentStart appears after planning, consume the same selected host-backed preparation only after full host/executor/current-turn agreement. For `legacy-adopt`, persist subagent-start authority; for `legacy-bound`, keep the immutable adoption binding and use the stronger Hook proof for the current reservation. Add no-event and emitted-event tests for both activation variants.

For `legacy-bound` at any generation, require ambient child equality, exact binding key, and an existing durable `codex-legacy-adoption` binding. Construct the spec's transient `codex-legacy-continuation` proof from the consumed preparation and current host/parent proofs, pass it to StateStore, and never persist it as child authority.

Add both lifecycle end-to-end tests: first adoption followed by a new-parent-turn generation-one resume, and first adoption followed by same-parent-turn generation-two continuation. Both reuse the exact binding without Hook fabrication. Mutate binding kind/key, path digest, origin/execution workspace, and permission; each must fail before job or fake ZCode publication.

- [ ] **Step 4: Add fail-before-side-effect matrices**

Mutate child, parent, Role, path, digest, host cwd, current turn/generation/permission, origin/execution worktree, preparation generation, authority kind, expiry, and replay. Assert no job, reservation, fake ZCode frame, Hook artifact, retry, fallback spawn, or private output. Concurrent invocation has exactly one winner.

- [ ] **Step 5: Replace the historical ordinal regression**

The PR #42 fixture that expects spawn zcode_rescue_task_2 must now require a v2 base followup with assignment zcode-rescue and a fake ZCode response. Retain a separate incompatible generic/unrelated host fixture that still allocates a collision-free ordinal. Add the second incident fixture proving ordinary children cannot block bound ordinal resume. Update the Root Skill so v2 follow-up uses the exact route assignment instead of retained spawn provenance, while v1 spawn preserves named/schema-omitted/pre-child-rejection generic negotiation. Add a resumed-parent/no-retained-provenance contract test and mechanically migrate every prepared follow-up fixture/acknowledgement in `tests/integration/skills.test.mjs`, `tests/integration/two-session-hooks.test.mjs`, `tests/e2e/codex-skills-e2e.test.mjs`, and helper contracts; do not change preparation-envelope, relay, owner-record, or spawn versions merely because they also equal one.

- [ ] **Step 6: Verify and commit**

    node --test tests/integration/companion.test.mjs tests/integration/skills.test.mjs tests/integration/two-session-hooks.test.mjs tests/e2e/real-zcode.test.mjs tests/e2e/codex-skills-e2e.test.mjs tests/skills-contracts.test.mjs
    npm run lint
    npm run typecheck
    git diff --check
    git add scripts/zcode-companion.mjs skills/rescue/SKILL.md tests/integration/companion.test.mjs tests/integration/skills.test.mjs tests/integration/two-session-hooks.test.mjs tests/e2e/real-zcode.test.mjs tests/e2e/codex-skills-e2e.test.mjs tests/skills-contracts.test.mjs
    git commit -m "fix: adopt persisted legacy Rescue children"

## Task 5: Qualification, documentation, and distribution

**Files:**
- Modify: tests/codex-rescue-qualification.test.mjs
- Modify: tests/helpers/codex-rescue-qualification.mjs
- Modify: tests/plugin-contracts.test.mjs
- Modify: README.md
- Modify: README.zh-CN.md
- Modify: SECURITY.md
- Modify: CHANGELOG.md
- Generate: marketplace/**

- [ ] **Step 1: Write qualification RED assertions**

Captured restored-child evidence must omit historical Hook executor/route for the base child and prove exact relationship discovery, base followup, child-side identity read, current parent-turn preparation, explicit adoption authority, v2 binding, zero spawn/fabrication, and terminal fake response. Add ordinary Role isolation with valid bound ordinal resume.

- [ ] **Step 2: Run RED**

    node --test --test-name-pattern='legacy adopted child|ordinary persisted child' tests/codex-rescue-qualification.test.mjs

- [ ] **Step 3: Update qualification and public contracts**

Keep raw rollout accounting, privacy scans, response linkage, single-use preparation, and no-extra-call assertions. Document exact named adoption versus generic compatibility, occupancy-only ordinary children, no Hook reconstruction, current parent-turn/worktree/permission reproving, and that preparation TTL is not child/operation lifetime. Record both incidents in CHANGELOG and the authority union in SECURITY.

- [ ] **Step 4: Verify and commit source**

    node --test tests/codex-rescue-qualification.test.mjs tests/plugin-contracts.test.mjs tests/skills-contracts.test.mjs
    npm run lint
    npm run typecheck
    git diff --check
    git add tests/codex-rescue-qualification.test.mjs tests/helpers/codex-rescue-qualification.mjs tests/plugin-contracts.test.mjs README.md README.zh-CN.md SECURITY.md CHANGELOG.md
    git commit -m "docs: qualify legacy Rescue child adoption"

- [ ] **Step 5: Regenerate marketplace from clean committed source**

Use the existing verified builder only; do not hand-edit generated files.

    source_sha=$(git rev-parse HEAD)
    snapshot_root=$(mktemp -d)
    git worktree add --detach "$snapshot_root/source" "$source_sha"
    npm --prefix "$snapshot_root/source" ci --include=dev
    node "$snapshot_root/source/scripts/build-marketplace-snapshot.mjs" \
      --output "$snapshot_root/output" \
      --source-ref HEAD \
      --source-sha "$source_sha"
    rsync -a --delete "$snapshot_root/output/" marketplace/
    git worktree remove "$snapshot_root/source"
    rm -rf "$snapshot_root"
    node --test tests/integration/marketplace-snapshot-build.mjs tests/integration/marketplace-install.test.mjs
    git diff --check

- [ ] **Step 6: Commit generated distribution**

    git add marketplace
    git commit -m "build: refresh legacy adoption snapshot"

## Task 6: Final verification and PR delivery

**Files:**
- No planned source edits; repair only evidence-backed failures through new TDD commits.

- [ ] **Step 1: Replay both incidents three consecutive times**

Require stable base adoption and bound ordinal resume, zero spawn/collision/Role failure.

- [ ] **Step 2: Run the complete clean-source gate**

    npm run check
    git diff --check
    git status --short

Expected: zero failures and only task_plan.md, findings.md, and progress.md untracked.

- [ ] **Step 3: Run independent final Standards and Spec reviews**

Review origin/main...HEAD separately. Resolve every Critical/Important finding through an implementer, rerun affected tests, and obtain re-approval.

- [ ] **Step 4: Push and open the follow-up PR**

    git push -u origin fix/rescue-legacy-adoption
    gh pr create --base main --head fix/rescue-legacy-adoption \
      --title "fix: adopt persisted legacy Rescue children" \
      --body $'## Summary\n\n- restore exact persisted named Rescue children through one-shot legacy adoption\n- isolate unrelated child Roles from Rescue candidate authority\n- persist explicit Hook or Codex-adoption authority and qualify both incidents\n\n## Verification\n\n- npm run check\n- both incident regressions pass three consecutive times'

- [ ] **Step 5: Monitor CI to success**

Inspect each failed job, reproduce when possible, add RED evidence before source fixes, obtain independent repair review, push, and continue until every required Linux, macOS, and Windows Node job succeeds.
