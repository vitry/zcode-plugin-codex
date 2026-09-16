# Rescue Placement Semantics Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate Host child placement from Companion execution so explicit placement flags control only Root waiting, while no-flag complex Rescue retains the existing detached runner.

**Architecture:** Root records two closed placement enums in a private version-4 preparation. The Rescue Child maps only `companionExecution` into Companion argv and passes `hostPlacement` separately as lifecycle evidence. Durable runner-format evidence, rather than Host placement, selects detached-runner admission and child-loss policy; version-3 preparations keep their historical coupled behavior.

**Tech Stack:** Node.js ESM, `node:test`, Codex skills and collaboration tools, private PTY preparation, existing StateStore/file locks, Rescue Lifecycle Reconciler, and the session-bound detached runner.

**Spec:** `docs/superpowers/specs/2026-09-16-rescue-placement-semantics-parity-design.md`

---

## Handoff constraints

- Read the approved spec before implementation. Its four-row decision matrix is normative.
- Implement in a dedicated Git worktree so the source tree is clean enough for exact-SHA marketplace generation and the user's untracked root files remain untouched.
- Do not implement the separate foreground `write_stdin` observation/token-cost repair in this plan. Do not publish or install this placement change until that repair passes its own acceptance budget.
- Preserve the task-free child assignment. Task text and private selectors remain confined to the single post-readiness preparation frame.
- Remove compatibility only for private preparation **envelope** versions 1 and 2. Do not remove versioned preparation records, route directives, bindings, jobs, runner evidence, execution capabilities, or migration formats that happen to use version 1 or 2.
- Preserve user-owned/untracked files. Record `git status --short` before starting and never include unrelated root `task_plan.md`, `findings.md`, `progress.md`, or `.DS_Store` files in commits.
- Use RED → GREEN for every behavior task. Commit source/tests before refreshing the checked-in marketplace snapshot; the snapshot provenance must name the exact clean source commit it packages.

## File responsibilities

| File | Responsibility |
|---|---|
| `skills/rescue/SKILL.md` | Root placement inference, v4 preparation, spawn/follow-up waiting behavior |
| `agents/zcode-rescue.toml.template` | Task-free Child behavior expressed in Companion-execution terms rather than conflated placement |
| `scripts/lib/rescue-preparation.mjs` | Closed v4/v3 envelope validation and removal of envelope v1/v2 readers |
| `scripts/lib/rescue-route-planner.mjs` | v3/v4 path-only exact continuation selection |
| `scripts/lib/rescue-child-reconciliation.mjs` | v3/v4 path-only selection during stuck-child reconciliation |
| `scripts/zcode-companion.mjs` | Prepared-envelope adaptation, separate lifecycle placement, Companion foreground/background routing, runner admission |
| `scripts/lib/rescue-execution-input.mjs` | Shared predicate for valid detached Rescue runner-format evidence |
| `scripts/lib/state.mjs` | Persist/validate runner evidence independently of Host placement |
| `scripts/lib/review.mjs` | Preserve remote work after interruption for either Host background or detached Companion execution |
| `scripts/lib/rescue-lifecycle.mjs` | Join both placement dimensions and derive Host Coordination Loss only for attached Host-foreground work |
| `scripts/lib/recovery.mjs` | Project runner evidence into joined lifecycle state and centralize SubagentStop decisions |
| `hooks/subagent-hook.mjs` | Submit an observation to the reconciler instead of pre-classifying child loss from Host placement alone |
| `tests/rescue-preparation.test.mjs`, `tests/rescue-route-planner.test.mjs`, `tests/rescue-child-reconciliation.test.mjs` | Envelope and exact-continuation contracts |
| `tests/skills-contracts.test.mjs` | Root-side four-row decision matrix and task-free child boundary |
| `tests/rescue-execution-input.test.mjs`, `tests/state.test.mjs`, `tests/rescue-runner-entry.test.mjs` | Detached marker, persistence, and runner admission |
| `tests/rescue-lifecycle.test.mjs`, `tests/recovery.test.mjs`, `tests/integration/companion.test.mjs` | Child loss, SessionEnd, and end-to-end cross-combinations |
| `README.md`, `README.zh-CN.md`, `SECURITY.md`, `CHANGELOG.md` | Public and security contract |
| `docs/adr/0013-bind-rescue-child-to-zcode-session.md`, `docs/adr/0015-select-session-bound-background-by-complexity.md`, `docs/adr/0018-use-host-managed-session-bound-execution.md`, `docs/adr/0021-run-rescue-background-in-a-session-bound-runner.md` | Exact continuation and two-layer placement decisions |
| `tests/release-contracts.test.mjs`, `tests/plugin-contracts.test.mjs` | Documentation and source/marketplace parity |

## Task 1: Introduce the closed v4 preparation envelope

**Files:**
- Modify: `tests/rescue-preparation.test.mjs`
- Modify: `scripts/lib/rescue-preparation.mjs`

- [ ] **Step 1: Write failing envelope tests**

Add table-driven tests that accept the three matrix-authorized v4 placement pairs, retain v3 coupled input, and reject v1/v2 plus partial, mixed, or unauthorized v4 options. Use exact assertions:

```js
const v4 = (hostPlacement, companionExecution) => ({
  version: 4,
  source: 'explicit',
  task: 'repair the parser',
  options: { hostPlacement, companionExecution, resume: 'fresh' },
  continuationTarget: null,
});

for (const pair of [
  ['foreground', 'foreground'],
  ['background', 'foreground'],
  ['foreground', 'background'],
]) assert.deepEqual(validateRescuePreparation(v4(...pair)), v4(...pair));

assert.deepEqual(validateRescuePreparation({
  version: 3, source: 'explicit', task: 'legacy',
  options: { execution: 'background', resume: 'fresh' }, continuationTarget: null,
}).options.execution, 'background');

for (const invalid of [
  { ...v4('foreground', 'foreground'), version: 1 },
  { ...v4('foreground', 'foreground'), version: 2 },
  { ...v4('foreground', 'foreground'), options: { hostPlacement: 'foreground' } },
  { ...v4('foreground', 'foreground'), options: { companionExecution: 'foreground' } },
  v4('background', 'background'),
  { ...v4('foreground', 'foreground'), options: { hostPlacement: 'foreground', companionExecution: 'foreground', execution: 'background' } },
]) assert.throws(() => validateRescuePreparation(invalid), { code: 'RESCUE_PREPARATION_INVALID' });
```

- [ ] **Step 2: Run the test to verify RED**

Run: `node --test tests/rescue-preparation.test.mjs`

Expected: FAIL because version 4 and its split option keys are not accepted, while v1/v2 are still accepted.

- [ ] **Step 3: Implement version-specific closed validation**

In `scripts/lib/rescue-preparation.mjs`:

```js
export const RESCUE_PREPARATION_VERSION = 4;
const LEGACY_RESCUE_ENVELOPE_VERSION = 3;
const PLACEMENTS = new Set(['foreground', 'background']);
const V3_OPTION_KEYS = new Set(['effort', 'execution', 'model', 'resume']);
const V4_OPTION_KEYS = new Set(['companionExecution', 'effort', 'hostPlacement', 'model', 'resume']);
```

Make outer envelope validation accept exactly v3 or v4 with `continuationTarget`. Validate options against the version-specific key set. Require both v4 placement fields, reject the unauthorized background/background pair, reject `execution` in v4, preserve optional v3 `execution`, and preserve the existing `resume`, `model`, `effort`, task-size, duplicate-key, selector, record, expiry, and single-consume rules. Remove only the v1/v2 envelope constants, branches, and tests; keep `LEGACY_PREPARATION_RECORD_VERSION`, `V1_RECORD_KEYS`, `V2_RECORD_KEYS`, pending-fresh record handling, and their tests. Where a test needs a legacy preparation-record v1/v2 shape, embed a valid envelope v3 inside it so the test proves record compatibility without reopening envelope compatibility.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run: `node --test tests/rescue-preparation.test.mjs`

Expected: PASS, including v3 compatibility and v1/v2 envelope rejection.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/rescue-preparation.mjs tests/rescue-preparation.test.mjs
git commit -m "feat: split rescue preparation placement"
```

## Task 2: Preserve exact continuation routing under v4

**Files:**
- Modify: `tests/rescue-route-planner.test.mjs`
- Modify: `tests/rescue-child-reconciliation.test.mjs`
- Modify: `scripts/lib/rescue-route-planner.mjs`
- Modify: `scripts/lib/rescue-child-reconciliation.mjs`

- [ ] **Step 1: Add failing v4 exact-selector tests**

Clone the existing version-3 canonical-path cases as version 4 and assert that sibling IDs never become Root input:

```js
const envelope = {
  version: 4, source: 'explicit', task: 'continue exact operation',
  options: { hostPlacement: 'foreground', companionExecution: 'foreground', resume: 'resume' },
  continuationTarget: { agentPath: '/root/zcode_rescue_task_2' },
};
const planned = await planRescueActivation({ ...input, envelope });
assert.deepEqual(planned.directive, {
  version: 2, action: 'followup', target: '/root/zcode_rescue_task_2', assignment: 'zcode-rescue',
});
```

Add the same v4 selector to stuck-child reconciliation tests. Assert wrong path, duplicate path, changed binding, and missing exact host fail closed without selecting a sibling or fresh route. Delete only tests whose purpose is accepting v1 targetless or v2 `{childId, agentPath}` envelope input.

Mechanically migrate ordinary planner/reconciliation fixtures that still use envelope v1/v2 to v4. Keep explicit v3 fixtures only where the test is proving v3 read compatibility; do not confuse route-directive/binding version numbers with envelope versions.

- [ ] **Step 2: Run both tests to verify RED**

Run: `node --test tests/rescue-route-planner.test.mjs tests/rescue-child-reconciliation.test.mjs`

Expected: FAIL where `envelope.version === 3` is the only path-only selector branch.

- [ ] **Step 3: Make the accepted envelope contract path-only**

Because Task 1 admits only v3 and v4, update `validRescueSelectionRequest`, remove its v1/v2 and child-ID-pair branches, and require a present `continuationTarget` key whose value is null or path-only. Remove child-ID selector branches from both modules and select only by canonical path:

```js
const selectedHost = hostChildren.find(
  (host) => host.agentPath === continuationTarget.agentPath,
);
```

Keep all independent child graph, executor, permission, workspace, binding, operation, generation, job, and original ZCode-session joins unchanged.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `node --test tests/rescue-route-planner.test.mjs tests/rescue-child-reconciliation.test.mjs tests/rescue-preparation.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/rescue-route-planner.mjs scripts/lib/rescue-child-reconciliation.mjs tests/rescue-route-planner.test.mjs tests/rescue-child-reconciliation.test.mjs
git commit -m "fix: retain exact rescue routing in v4"
```

## Task 3: Encode the four Root placement branches in the Rescue skill

**Files:**
- Modify: `tests/skills-contracts.test.mjs`
- Modify: `skills/rescue/SKILL.md`
- Modify: `agents/zcode-rescue.toml.template`

- [ ] **Step 1: Replace the conflated skill assertions with the four-row matrix**

Require the installed source prose to state all four mappings and the independent wait rules:

```js
assert.match(source, /explicit `--background`[\s\S]+Host[^\n]+background[\s\S]+Companion[^\n]+foreground/i);
assert.match(source, /explicit `--wait`[\s\S]+Host[^\n]+foreground[\s\S]+Companion[^\n]+foreground/i);
assert.match(source, /no flag[\s\S]+small[^\n]+Host[^\n]+foreground[^\n]+Companion[^\n]+foreground/i);
assert.match(source, /no flag[\s\S]+complex[^\n]+Host[^\n]+foreground[^\n]+Companion[^\n]+background/i);
assert.match(source, /`hostPlacement`[^\n]+`foreground`[^\n]+`background`/i);
assert.match(source, /`companionExecution`[^\n]+`foreground`[^\n]+`background`/i);
assert.match(source, /Host placement[^\n]+only[^\n]+`wait_agent`/i);
assert.match(source, /Companion execution[^\n]+only[^\n]+detached runner/i);
assert.doesNotMatch(source, /private `execution` enum/);
```

Also require exact v4 preparation keys, v3-only read compatibility, and explicit rejection/removal of v1/v2 envelope compatibility.

- [ ] **Step 2: Run the contract test to verify RED**

Run: `node --test tests/skills-contracts.test.mjs`

Expected: FAIL on the old single `options.execution` contract and old wait exception.

- [ ] **Step 3: Rewrite only the placement/preparation/wait sections of the skill**

Use this normative v4 shape:

```json
{"version":4,"source":"explicit","task":"<normalized objective>","options":{"hostPlacement":"foreground","companionExecution":"background","resume":"fresh","model":"<model>","effort":"<effort>"},"continuationTarget":null}
```

Specify:

```text
explicit --background => hostPlacement background; companionExecution foreground
explicit --wait       => hostPlacement foreground; companionExecution foreground
no flag small         => hostPlacement foreground; companionExecution foreground
no flag complex       => hostPlacement foreground; companionExecution background
```

For Host foreground, Root joins the exact child with the longest native `wait_agent` until terminal stdout or queued acknowledgement. For Host background, Root starts/follows the exact child, performs no `wait_agent` in the initiating interaction, and reports only that the Host child was launched. For Companion background, the child returns queued and Root does not poll Status/Result. Keep the fixed task-free child messages and private preparation transport unchanged.

Update `agents/zcode-rescue.toml.template` so the Child describes only its mapped Companion execution: foreground observes the original process to terminal; background returns queued after the detached runner is spawned. State that Host placement is parent-owned, never changes the fixed Child assignment, and never causes the Child to infer placement from task text.

- [ ] **Step 4: Run the contract test to verify GREEN**

Run: `node --test tests/skills-contracts.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/rescue/SKILL.md agents/zcode-rescue.toml.template tests/skills-contracts.test.mjs
git commit -m "feat: separate rescue host and companion placement"
```

## Task 4: Route prepared v4 execution without recoupling the enums

**Files:**
- Modify: `tests/integration/skills.test.mjs`
- Modify: `tests/integration/companion.test.mjs`
- Modify: `scripts/zcode-companion.mjs`

- [ ] **Step 1: Add failing prepared-invocation tests**

Exercise the three authorized v4 pairs through `invoke-prepared rescue`. Stub attached execution and runner spawning separately, then assert:

```js
assert.deepEqual(observed, [
  { hostPlacement: 'foreground', detached: false },
  { hostPlacement: 'background', detached: false },
  { hostPlacement: 'foreground', detached: true },
]);
```

The first two must produce no `rescueRunnerVersion`; the last must reserve bounded execution input and return the queued acknowledgement. Add a v3 `execution: background` regression that remains coupled (`hostPlacement: background`, detached runner). Assert neither public `--wait` nor explicit Host `--background` appears in the normalized task.

Migrate ordinary integration preparation fixtures from envelope v1/v2 to v4. Retain v3 only in named compatibility cases. Do not alter versioned job, capability, route, or binding fixtures.

- [ ] **Step 2: Run focused integration tests to verify RED**

Run: `node --test tests/integration/skills.test.mjs tests/integration/companion.test.mjs`

Expected: FAIL because prepared argv and lifecycle placement still derive from the same field.

- [ ] **Step 3: Add one prepared-envelope adapter**

Replace `rescueArgvFromPreparation` with one adapter returning both values:

```js
function rescueInvocationFromPreparation(envelope) {
  const companionExecution = envelope.version === 4
    ? envelope.options.companionExecution
    : envelope.options.execution ?? 'foreground';
  const hostPlacement = envelope.version === 4
    ? envelope.options.hostPlacement
    : companionExecution === 'background' ? 'background' : 'foreground';
  const argv = ['rescue'];
  if (companionExecution === 'background') argv.push('--background');
  if (envelope.options.resume) argv.push(`--${envelope.options.resume}`);
  if (envelope.options.model) argv.push('--model', envelope.options.model);
  if (envelope.options.effort) argv.push('--effort', envelope.options.effort);
  argv.push('--', envelope.task);
  return { argv, hostPlacement };
}
```

Pass `hostPlacement` into `runCompanion` as a private context property. In both fresh and continuation reservation branches, persist that context value in the lifecycle trio. Continue using parsed internal `options.execution` only for attached-versus-runner routing and execution-input creation. For non-prepared historical/direct paths, retain the old coupled fallback.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run: `node --test tests/integration/skills.test.mjs tests/integration/companion.test.mjs tests/args.test.mjs`

Expected: PASS; public argument parsing remains unchanged because the internal Companion `--background` switch still uses the existing parser.

- [ ] **Step 5: Commit**

```bash
git add scripts/zcode-companion.mjs tests/integration/skills.test.mjs tests/integration/companion.test.mjs
git commit -m "feat: route rescue placement dimensions independently"
```

## Task 5: Admit detached runners independently of Host placement

**Files:**
- Modify: `tests/rescue-execution-input.test.mjs`
- Modify: `tests/state.test.mjs`
- Modify: `tests/rescue-runner-entry.test.mjs`
- Modify: `scripts/lib/rescue-execution-input.mjs`
- Modify: `scripts/lib/state.mjs`
- Modify: `scripts/zcode-companion.mjs`

- [ ] **Step 1: Add failing marker, persistence, and admission tests**

Create Host-owned foreground and background lifecycle records with complete runner evidence. Assert both are valid detached records and both runner entries can claim. Keep negative tests for missing marker/input, read-only jobs, non-Rescue jobs, incomplete lifecycle, wrong epoch, malformed input, held lease, stop intent, and terminal state.

```js
assert.equal(validDetachedRescueRunnerRecord({
  command: 'rescue', readOnly: false, rescueRunnerVersion: 1,
  ownerLifecycleEpoch: 'a'.repeat(64), executionOwner: 'host-child',
  hostPlacement: 'foreground',
}), true);
```

- [ ] **Step 2: Run the three tests to verify RED**

Run: `node --test tests/rescue-execution-input.test.mjs tests/state.test.mjs tests/rescue-runner-entry.test.mjs`

Expected: FAIL because StateStore and runner entry still require `hostPlacement: background`.

- [ ] **Step 3: Centralize detached runner-format recognition**

Export a closed predicate from `scripts/lib/rescue-execution-input.mjs`:

```js
export function validDetachedRescueRunnerRecord(record) {
  return record !== null && typeof record === 'object' && !Array.isArray(record)
    && record.command === 'rescue' && record.readOnly === false
    && record.rescueRunnerVersion === RESCUE_RUNNER_VERSION
    && validHostLifecycleRecord(record);
}
```

Import `validHostLifecycleRecord` from `rescue-binding.mjs`; do not infer detachment from `hostPlacement`.

- [ ] **Step 4: Relax only the obsolete Host-placement gates**

In `scripts/lib/state.mjs`, let `hostOwnedExecutionInput` accept either valid Host placement and require writable Rescue plus complete Host lifecycle. In persisted job validation, require `validDetachedRescueRunnerRecord(job)` for a marker instead of `job.hostPlacement === 'background'`. Keep queued input presence, input schema, immutable marker, worker lease, claim, stop fence, and terminal retention rules unchanged.

In `readRunnableHostRescueJob` in `scripts/zcode-companion.mjs`, replace the Host-background check with the shared predicate, then retain queued status and execution-input revalidation.

- [ ] **Step 5: Run tests to verify GREEN**

Run: `node --test tests/rescue-execution-input.test.mjs tests/state.test.mjs tests/rescue-runner-entry.test.mjs tests/rescue-binding.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/rescue-execution-input.mjs scripts/lib/state.mjs scripts/zcode-companion.mjs tests/rescue-execution-input.test.mjs tests/state.test.mjs tests/rescue-runner-entry.test.mjs
git commit -m "fix: admit detached rescue runners by marker"
```

## Task 6: Make child-loss policy depend on both placement dimensions

**Files:**
- Modify: `tests/rescue-lifecycle.test.mjs`
- Modify: `tests/recovery.test.mjs`
- Modify: `tests/integration/companion.test.mjs`
- Modify: `scripts/lib/rescue-lifecycle.mjs`
- Modify: `scripts/lib/recovery.mjs`
- Modify: `scripts/lib/review.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Modify: `hooks/subagent-hook.mjs`

- [ ] **Step 1: Add failing lifecycle matrix tests**

Extend the lifecycle fixture with `companionExecution`. For Host loss without a matching SessionEnd receipt, assert:

```js
const expected = [
  ['foreground', 'foreground', 'host-coordination-loss'],
  ['background', 'foreground', null],
  ['foreground', 'background', null],
  ['background', 'background', null],
];
```

For `foreground/background`, assert normal SubagentStop performs no `session/stop`, writes no stop intent, does not cancel, and leaves the detached job queued/running. Add a pre-enqueue failure case that follows existing failure settlement without a duplicate runner. Keep matching SessionEnd and explicit user Cancel authoritative for every combination.

- [ ] **Step 2: Run lifecycle/recovery tests to verify RED**

Run: `node --test tests/rescue-lifecycle.test.mjs tests/recovery.test.mjs tests/integration/companion.test.mjs`

Expected: FAIL because foreground Host placement alone still authorizes coordination-loss settlement.

- [ ] **Step 3: Add Companion execution to joined lifecycle state**

In every joined-state adapter (`scripts/lib/recovery.mjs` and `scripts/zcode-companion.mjs`), derive:

```js
companionExecution: validDetachedRescueRunnerRecord(job) ? 'background' : 'foreground',
```

In `scripts/lib/rescue-lifecycle.mjs`, validate the new closed enum and gate Host Coordination Loss with one helper:

```js
function attachedForegroundHostLoss(joined) {
  return joined.hostPlacement === 'foreground'
    && joined.companionExecution === 'foreground';
}
```

Use it for both observed Host loss and an explicit `host-coordination-loss` intent. SessionEnd and user cancellation keep their existing authority.

- [ ] **Step 4: Centralize SubagentStop as observation**

In `hooks/subagent-hook.mjs` and `settleRescueChildOwnedJob`, stop deriving an explicit stop solely from `hostPlacement`. Submit `{ kind: 'observe' }` with the proven receipt evidence; the reconciler derives coordination loss from the complete joined state. Preserve shared deadlines, receipt revalidation, exact job selection, and unavailable-outcome retention.

- [ ] **Step 5: Preserve remote work for detached execution interruptions**

In `scripts/lib/review.mjs`, rename the current Host-background-only helper and retain the remote turn when either condition is true:

```js
function interruptionRetainsRemoteTurn(job) {
  return validHostLifecycleRecord(job)
    && (job.hostPlacement === 'background' || validDetachedRescueRunnerRecord(job));
}
```

Use it at all three current interruption branches. This prevents runner-process/child loss from being reclassified as permission to stop the remote turn; normal recovery, lease cleanup, SessionEnd, and explicit Cancel remain unchanged.

- [ ] **Step 6: Run focused tests to verify GREEN**

Run: `node --test tests/rescue-lifecycle.test.mjs tests/recovery.test.mjs tests/integration/companion.test.mjs tests/job-control.test.mjs tests/session-end.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add hooks/subagent-hook.mjs scripts/lib/rescue-lifecycle.mjs scripts/lib/recovery.mjs scripts/lib/review.mjs scripts/zcode-companion.mjs tests/rescue-lifecycle.test.mjs tests/recovery.test.mjs tests/integration/companion.test.mjs
git commit -m "fix: preserve detached rescue across child exit"
```

## Task 7: Update release contracts, ADRs, and distribution snapshot

**Files:**
- Modify: `tests/release-contracts.test.mjs`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/adr/0013-bind-rescue-child-to-zcode-session.md`
- Modify: `docs/adr/0015-select-session-bound-background-by-complexity.md`
- Modify: `docs/adr/0018-use-host-managed-session-bound-execution.md`
- Modify: `docs/adr/0021-run-rescue-background-in-a-session-bound-runner.md`
- Mechanically refresh: `marketplace/plugins/zcode/**`
- Regenerate: `marketplace/.agents/plugins/provenance.json`

- [ ] **Step 1: Write failing release-document assertions**

Require the release docs to distinguish Host background from Companion background, state the four mappings, name v4 emission/v3-only compatibility, and remove claims that explicit `--background` necessarily creates a detached runner. Assert no release document says envelope v2 remains accepted.

- [ ] **Step 2: Run release contracts to verify RED**

Run: `node --test tests/release-contracts.test.mjs tests/plugin-contracts.test.mjs`

Expected: FAIL on old coupled placement and envelope-v2 compatibility prose.

- [ ] **Step 3: Amend the source documentation**

Apply the approved vocabulary consistently:

```text
Host background: Root does not join the Rescue Child in the initiating interaction.
Companion background: the Rescue Child returns queued after starting the session-bound detached runner.
Explicit --background: Host background + Companion foreground.
No-flag complex Rescue: Host foreground + Companion background.
```

Amend ADR 0013 only for envelope v4/v3/v1-v2 compatibility. Amend ADR 0015 for Root-side no-flag inference. Amend ADR 0018 for explicit Host background with attached Companion foreground. Amend ADR 0021 so its detached runner applies to Companion-background inference, not explicit Host `--background`. Record the unreleased behavior in the changelog. Do not alter Review or Adversarial Review placement.

- [ ] **Step 4: Run source release tests to verify GREEN before snapshot**

Run: `node --test tests/release-contracts.test.mjs`

Expected: documentation assertions pass; source/marketplace byte-parity assertions may remain RED until the snapshot step.

- [ ] **Step 5: Commit the complete source implementation and docs**

```bash
git add agents/zcode-rescue.toml.template skills/rescue/SKILL.md scripts hooks tests README.md README.zh-CN.md SECURITY.md CHANGELOG.md docs/adr/0013-bind-rescue-child-to-zcode-session.md docs/adr/0015-select-session-bound-background-by-complexity.md docs/adr/0018-use-host-managed-session-bound-execution.md docs/adr/0021-run-rescue-background-in-a-session-bound-runner.md docs/superpowers/specs/2026-09-16-rescue-placement-semantics-parity-design.md docs/superpowers/plans/2026-09-16-rescue-placement-semantics-parity.md
git commit -m "feat: align rescue placement with host semantics"
```

Check `git status --short` before committing and unstage any unrelated file. Record the resulting source commit SHA.

- [ ] **Step 6: Build the checked-in marketplace snapshot from that exact clean source commit**

Use an output directory outside the repository:

```bash
snapshot_dir="$(mktemp -d)/marketplace"
source_sha="$(git rev-parse HEAD)"
node scripts/build-marketplace-snapshot.mjs \
  --output "$snapshot_dir" \
  --source-ref "$source_sha" \
  --source-sha "$source_sha"
```

Expected: the builder succeeds from a clean tree and writes provenance whose `sourceSha` equals `source_sha`. Replace the checked-in `marketplace` tree only with this generated output; do not hand-edit generated mirrors or provenance.

Validate the generated identity before replacement, then mirror it exactly:

```bash
test "$(node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(p.sourceSha)' "$snapshot_dir/.agents/plugins/provenance.json")" = "$source_sha"
rsync -a --delete "$snapshot_dir/" marketplace/
```

- [ ] **Step 7: Verify the generated snapshot and commit it separately**

Run:

```bash
node --test tests/plugin-contracts.test.mjs tests/marketplace-snapshot.test.mjs tests/integration/marketplace-snapshot-build.mjs
git diff --check
```

Expected: PASS and exact source/marketplace parity.

Commit:

```bash
git add marketplace
git commit -m "chore: refresh marketplace snapshot for rescue placement"
```

## Task 8: Full verification and release-gate handoff

**Files:**
- Verify only; modify implementation/tests only to fix discovered regressions.

- [ ] **Step 1: Run static and full automated checks**

```bash
npm run check:line-endings
npm run lint
npm run typecheck
npm test
npm run test:qualified
git diff --check
```

Expected: all local checks pass. Report credential/environment skips separately; a skipped qualification is not a real-Host pass.

- [ ] **Step 2: Map every spec acceptance item to evidence**

Record the exact test name covering each of the 14 verification items in the approved spec. Confirm explicitly:

```text
explicit Host background => no runner marker, no queued acknowledgement
explicit wait => attached terminal result
no-flag small => attached terminal result
no-flag complex => foreground Host child returns queued; runner continues
normal detached-child SubagentStop => no host-coordination-loss
matching SessionEnd and explicit Cancel => still stop detached work
v3 => coupled compatibility
v1/v2 envelope => fail closed
```

- [ ] **Step 3: Run real-Host qualification only when the foreground observation repair is ready**

Exercise one explicit Host-background Rescue through later native completion/error delivery and one no-flag complex Rescue through queued Status/Result completion. Measure the separate foreground observation acceptance budget. If that repair is absent or over budget, mark placement implementation complete but release blocked; do not install or publish this change.

- [ ] **Step 4: Final review and handoff**

Report commits, RED/GREEN evidence, full check exit codes, real-Host results or precise skips, and the release-blocked/unblocked decision. Confirm no task text entered child messages and no foreground token-cost claim was made by this implementation.

## Implementation pitfalls

1. `hostPlacement: foreground` no longer proves attached execution; a valid runner marker changes child-loss semantics.
2. `hostPlacement: background` no longer proves detached execution; explicit Host background is attached Companion foreground.
3. The internal Companion `--background` switch is valid for `companionExecution: background`; the user-facing `--background` flag must never be forwarded as that switch.
4. A queued acknowledgement is presentation, not authority. Losing it does not cancel or relaunch an already accepted runner.
5. Removing envelope v1/v2 must not delete preparation-record v1/v2 or binding/job migrations with unrelated version numbers.
6. SessionEnd and explicit Cancel remain authoritative across both placement dimensions.
7. The placement code may be merged and tested independently, but release remains blocked on the separate foreground observation/token-cost repair.
