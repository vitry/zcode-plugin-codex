# Effective Job Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make direct status, result, and cancel operate on the lifecycle-authoritative Rescue execution workspace from either eligible origin or exact target.

**Architecture:** Add an atomic, read-only IdentityStore `effective` workspace mode distinct from Rescue `execution` and `claim`. A backward-readable optional private lifecycle-v3 recovery pointer preserves exact job observation across same-session/same-origin prompt replacement without inheriting per-turn Rescue execution authority. Resolve once in direct invocation and propagate the returned workspace through every job, artifact, broker, cancellation, and binding operation.

**Tech Stack:** Node.js 22.13 ESM, native `node:test`, lifecycle v3 identity store, durable workspace-scoped state.

---

### Task 1: Atomic effective identity resolution

**Files:**

- Modify: `scripts/lib/identity.mjs`
- Modify: `tests/identity.test.mjs`

- [ ] Write tests first for unbound origin, bound origin projection, bound target projection, unrelated repository, sibling worktree, stale/corrupt lifecycle, legacy exact behavior, and zero state mutation.
- [ ] Verify RED with `IDENTITY_INPUT_INVALID` because `effective` is not allowlisted.
- [ ] Add `effective` to the narrow JSDoc and validation union.
- [ ] Under the existing lifecycle lock implement:

```js
if (mode === 'effective') {
  if (!lifecycleRecordsConsistent(active, ledger)) throw invalidAuthorizationRecord('identity session');
  const effectiveWorkspace = active.executionWorkspace ?? active.recoveryWorkspace ?? active.originWorkspace;
  if (effectiveWorkspace === active.originWorkspace) {
    if (candidate !== active.originWorkspace) throw workspaceIneligible();
    return { kind: 'resolved', caller: publicActiveTurn(active, active.originWorkspace, false) };
  }
  if (candidate !== active.originWorkspace && candidate !== effectiveWorkspace) {
    throw workspaceIneligible();
  }
  return { kind: 'resolved', caller: publicActiveTurn(active, effectiveWorkspace, active.executionWorkspace !== null) };
}
```

- [ ] Do not change `execution`, `preview`, `claim`, `persistClaim`, or legacy behavior.
- [ ] Run focused IdentityStore tests; verify GREEN.

#### Cross-turn recovery amendment

- [ ] Write tests first proving a real same-origin prompt replacement resets
  `executionWorkspace` yet status/result/cancel still select the prior exact
  target without a manual claim.
- [ ] Extend lifecycle v3 with an optional private `recoveryWorkspace`; accept
  historical records without it and never expose it through public caller
  projections.
- [ ] Under the existing lifecycle lock, carry
  `existing.executionWorkspace ?? existing.recoveryWorkspace ?? null` only for
  same-session, same-origin replacement. Duplicates retain existing state and
  cross-origin replacement carries nothing.
- [ ] In `effective` only, prefer current execution, then validated recovery,
  then origin. Require the recovery pointer to be canonical and included in
  `knownWorkspaces`; malformed or contradictory state fails closed without
  mutation.
- [ ] Prove a new current-turn claim remains allowed, takes precedence, and is
  the pointer carried by the following replacement. Never infer a target from
  the ledger or scan partitions.

### Task 2: Direct command propagation

**Files:**

- Modify: `scripts/zcode-companion.mjs`
- Modify: `tests/integration/skills.test.mjs`

- [ ] Write linked-worktree integration tests first for status/result/cancel from origin and target with origin decoy jobs.
- [ ] Cover no-ID latest, explicit ID, `status --all`, result artifact, queued/running cancel, broker stop, Rescue binding closure, unrelated/sibling worktree, foreign owner, and unbound same-workspace regression.
- [ ] Verify RED from ineligible workspace or wrong origin partition.
- [ ] Use `workspaceBinding: 'effective'` only for command names `status`, `result`, and `cancel`.
- [ ] Assign `invocationWorkspace = caller.workspace` once and use it for pending invocation storage, `runCompanion` cwd, state/controller selection, results/logs, model policy, reconciliation, client construction, cancellation, and binding closure.
- [ ] Do not enable this mode for Rescue, review, adversarial-review, transfer, or setup.
- [ ] Never scan or merge workspace partitions; explicit IDs retain owner/workspace confinement.
- [ ] Run IdentityStore and skills integration tests; verify GREEN.

### Task 3: Installed local-marketplace smoke

**Files:**

- Modify: `tests/integration/marketplace-install.test.mjs`

- [ ] Add one installed-plugin bound-worktree direct status proof in the isolated `CODEX_HOME` harness.
- [ ] Assert the local marketplace snapshot is used and the origin decoy is absent.
- [ ] Run:

```bash
node --test tests/identity.test.mjs tests/integration/skills.test.mjs \
  tests/integration/marketplace-install.test.mjs
```

- [ ] Commit:

```bash
git add scripts/lib/identity.mjs scripts/zcode-companion.mjs \
  tests/identity.test.mjs tests/integration/skills.test.mjs \
  tests/integration/marketplace-install.test.mjs
git commit -m "fix: resolve bound job workspace"
```

### Review gate

- [ ] Fresh spec-compliance reviewer checks command scope, atomicity, target projection, and no scanning.
- [ ] Original implementer fixes gaps; reviewer rechecks until approved.
- [ ] Fresh code-quality reviewer checks race safety, storage propagation, ownership, and legacy compatibility.
- [ ] Original implementer fixes Critical/Important findings; reviewer rechecks until approved.
