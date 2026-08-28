# Rescue Canonical-Path Continuation Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Use ordinary Codex subagents only;
> never invoke ZCode Rescue while executing or reviewing this plan.

**Goal:** Correct stopped Rescue continuation so Root selects its intended
operation with the exact canonical `task_name` returned by `spawn_agent`, while
the plugin privately resolves and authorizes the corresponding host child ID.

**Architecture:** Add exact private preparation envelope v3 with
`continuationTarget: null | {agentPath}` while retaining v1/v2 read
compatibility. The route planner validates the complete exact-parent child
graph, selects one host child by canonical path, then uses that host record's
ID to perform the unchanged executor, binding, workspace, generation, job, and
ZCode-session joins. Skill and qualification fixtures must model the real
Codex 0.147/0.148 boundary: Root receives `task_name`; only internal activity
contains `agent_thread_id`.

**Tech Stack:** Node.js 22.13 ESM, `node:test`, Codex app-server child
discovery, private JSON preparation records, generated marketplace snapshot,
plugin and packaged-install validation.

**Source of truth:**
`docs/superpowers/specs/2026-08-27-rescue-continuation-path-selector-design.md`
at commit `c8aae02`.

---

## Global execution rules

- [ ] Start every production task by adding the specified tests and recording
  a meaningful RED failure before changing production code.
- [ ] Use one ordinary implementation worker at a time. After each task, use a
  fresh spec-compliance reviewer and then a different code-quality reviewer.
- [ ] Resolve and re-review every Critical or Important finding before moving
  to the next task.
- [ ] Preserve public `$zcode:rescue ... --resume` syntax, launcher argv,
  managed child assignment, binding schema, prepared route schema, original
  ZCode session identity, and one-active-writable-Rescue admission policy.
- [ ] Do not weaken targetless ambiguity, duplicate-child, privacy, replay,
  permission, workspace, generation, or fail-closed tests.
- [ ] Use `apply_patch`; preserve unrelated user changes; run
  `git diff --check`; commit only green focused suites.

## Task 1: Parse v3 path selectors and resolve the internal child ID

**Files:**

- Modify: `scripts/lib/rescue-preparation.mjs`
- Modify: `scripts/lib/rescue-route-planner.mjs`
- Test: `tests/rescue-preparation.test.mjs`
- Test: `tests/rescue-route-planner.test.mjs`
- Test: `tests/integration/companion.test.mjs`

### RED

- [ ] In `tests/rescue-preparation.test.mjs`, require the latest exported
  envelope version to be 3. Add exact v3 parsing for `null` and the one-key
  `{agentPath}` target, defensive nested copies, canonical path/byte/control
  bounds, duplicate/extra/missing key rejection, and the requirement that a
  non-null target accompanies `options.resume === 'resume'`.
- [ ] Add named cases `v3 accepts an exact canonical-path continuation target`
  and `v3 rejects pair-shaped and non-resume continuation targets`. Before the
  parser change, the first must fail because version 3 is unsupported; the
  second must not be satisfied by merely relabeling the old v2 pair parser.
- [ ] Keep explicit coverage that exact v1 targetless and v2
  `null | {childId, agentPath}` envelopes still parse and that persisted record
  versions remain unchanged and independent from envelope v3.
- [ ] Round-trip v3 through preparation record schema v3 and assert the selector
  exists only at `record.envelope.continuationTarget`; assert no duplicate
  top-level `record.continuationTarget` or `record.agentPath`. The initial RED
  must be the unsupported v3 envelope, not a changed record version.
- [ ] In `tests/rescue-route-planner.test.mjs`, create two fully resumable
  siblings and prove a v3 path selector follows only the selected child,
  regardless of list order, timestamps, base/suffix naming, or sibling
  eligibility order. Assert executor/binding readers are not called for the
  non-selected sibling.
- [ ] Name the main case `v3 canonical path selects one host before binding
  reads`; its pre-implementation failure should be `RESCUE_ROUTE_INVALID`
  because planner validation does not know the v3 one-key target. After GREEN,
  assert the selected directive path and exact binding/session ID.
- [ ] Add fail-closed cases for missing/unmanaged/unbound/ineligible selected
  paths, selected-host/binding child-ID drift, path drift, and malformed
  targets. Preserve global duplicate ID/path rejection before target filtering.
- [ ] Retain at least one v2 exact-pair success and mismatch case and the
  unchanged targetless multiple-binding ambiguity case.
- [ ] In `tests/integration/companion.test.mjs`, change the exact-selection raw
  TTY flow to a private v3 path-only frame and prove it resumes the selected
  original non-empty ZCode session without putting a selector or child ID in
  public output, argv, or ZCode wire data.
- [ ] Name that case `private v3 canonical path resumes only the selected
  original session`; before GREEN it must fail during preparation validation
  and the fake ZCode recorder must remain empty.

Run and capture the expected failures:

```bash
node --test tests/rescue-preparation.test.mjs
node --test tests/rescue-route-planner.test.mjs
node --test tests/integration/companion.test.mjs
```

### GREEN

- [ ] In `scripts/lib/rescue-preparation.mjs`, set
  `RESCUE_PREPARATION_VERSION = 3`, name v1/v2 legacy envelope constants
  separately, and accept only these exact schemas:

  ```js
  // v1: four keys, no continuationTarget
  // v2: five keys, null | { childId, agentPath }
  // v3: five keys, null | { agentPath }
  ```

  Reuse current canonical-path validation and bounded input policy; preserve
  record v1/v2/v3 classification and copy each accepted object defensively.
- [ ] In `scripts/lib/rescue-route-planner.mjs`, validate v2 and v3 targets
  according to `envelope.version`. After complete child-list validation and
  global duplicate checks, v3 selects exactly one host by full `agentPath`;
  v2 continues selecting by exact ID/path pair. No target still uses existing
  eligibility/ambiguity behavior.
- [ ] Feed only the selected host record into stopped-executor and binding
  resolution. Obtain `childAgentId` from `selectedHost.id`, then require the
  binding's ID and path to match it before any preparation consumption,
  mutation, follow-up, spawn, or ZCode RPC.
- [ ] Leave fresh path occupancy and directive schemas unchanged.

### Verify, commit, and review

```bash
node --test tests/rescue-preparation.test.mjs tests/rescue-route-planner.test.mjs \
  tests/integration/companion.test.mjs
node --test tests/rescue-binding.test.mjs tests/state.test.mjs
git diff --check
git add scripts/lib/rescue-preparation.mjs scripts/lib/rescue-route-planner.mjs \
  tests/rescue-preparation.test.mjs tests/rescue-route-planner.test.mjs \
  tests/integration/companion.test.mjs
git commit -m "fix: resolve rescue continuation by canonical path"
```

- [ ] Spec reviewer checks version separation, full-list validation order,
  internal-ID authorization, v2 compatibility, no sibling fallback, and
  original-session preservation.
- [ ] Quality reviewer checks schema exactness, defensive copies, byte bounds,
  adapter side effects, error sanitization, and test signal.

## Task 2: Match Root and qualification to the real Codex lifecycle boundary

**Files:**

- Modify: `skills/rescue/SKILL.md`
- Modify: `tests/skills-contracts.test.mjs`
- Modify: `tests/helpers/rescue-skill-contract.mjs`
- Modify: `tests/helpers/codex-rescue-qualification.mjs`
- Modify: `tests/codex-rescue-qualification.test.mjs`
- Modify: `tests/e2e/codex-skills-e2e.test.mjs`
- Add: `tests/fixtures/codex-rescue/0.147-continuation-lifecycle.json`
- Add: `tests/fixtures/codex-rescue/0.148-continuation-lifecycle.json`

### RED

- [ ] Update Skill contract tests first: Root must retain the exact canonical
  `task_name` from one successful `spawn_agent` result and later send v3
  `{agentPath}`. The tests must reject instructions requiring
  `spawn.output.agent_id`, flattened `started.event_id`, rollout inspection,
  path synthesis, or asking the user for a child ID.
- [ ] Require new fresh/independent frames to use v3 with `null`, exact resumes
  to use the retained path, and unavailable/ambiguous semantic intent to
  clarify instead of guessing. Public command and prepared route behavior stay
  unchanged.
- [ ] Add separately checked-in, minimized 0.147 and 0.148 regression captures
  at the exact fixture paths above, derived from the observed raw JSONL without
  flattening or field renaming. Preserve raw record order and the complete
  identity-bearing records; redact only task text and unrelated payloads. In
  each, spawn output
  is exactly real-shaped `{"task_name":"/root/..."}` and contains no
  `agent_id`; the internal start is nested at
  `event_msg.payload.item` as `SubAgentActivity`, with `item.id` equal to the
  spawn call ID and `agent_thread_id` agreeing with child session metadata and
  the plugin binding.
- [ ] Name the fixture test `real 0.147 and 0.148 captures expose only canonical
  task_name to Root`. Before helper changes it must fail because the current
  reader expects public `agent_id` and flattened `event_id`; also assert those
  fictional fields are absent from fixture bytes.
- [ ] Update qualification/e2e expectations to build Root's v3 frame only from
  spawn-result `task_name`, while internal qualification proves the host
  correlation separately. Record RED against the current fictional pair
  parser/fixture.
- [ ] Name the Skill case `Root retains returned task_name and keeps child ID
  internal`; before the Skill edit its negative assertion must fail on the
  existing `spawn.output.agent_id` text.

Run and capture RED:

```bash
node --test tests/skills-contracts.test.mjs \
  tests/codex-rescue-qualification.test.mjs \
  tests/e2e/codex-skills-e2e.test.mjs
```

### GREEN

- [ ] Rewrite only the affected lifecycle section in `skills/rescue/SKILL.md`:
  retain exact returned `task_name` with the logical operation, prepare one
  private v3 path selector after readiness, and execute only the companion's
  returned route. Explicitly keep child ID internal and forbid selectors in
  command syntax, argv, env, assignments, commentary, status/result, relay,
  logs, or ZCode requests.
- [ ] In `tests/helpers/codex-rescue-qualification.mjs`, parse the real public
  spawn result and separately correlate trusted internal activity by
  `item.id === spawn.call_id`, canonical path, and `agent_thread_id`. Do not
  normalize the capture into fictional public fields.
- [ ] Update synthetic e2e lifecycle builders to emit the same nested real
  shapes. Root preparations use v3/path-only; binding and hook fixtures retain
  the independently issued child thread ID.
- [ ] Keep v2 compatibility solely as explicit legacy-reader coverage, not as
  new Skill emission.

### Verify, commit, and review

```bash
node --test tests/skills-contracts.test.mjs \
  tests/codex-rescue-qualification.test.mjs \
  tests/e2e/codex-skills-e2e.test.mjs
node --test tests/integration/skills.test.mjs tests/rescue-launcher.test.mjs \
  tests/plugin-contracts.test.mjs
python3 /Users/zhangzikai/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  skills/rescue
git diff --check
git add skills/rescue/SKILL.md tests/skills-contracts.test.mjs \
  tests/helpers/codex-rescue-qualification.mjs \
  tests/helpers/rescue-skill-contract.mjs \
  tests/codex-rescue-qualification.test.mjs tests/e2e/codex-skills-e2e.test.mjs \
  tests/fixtures/codex-rescue/0.147-continuation-lifecycle.json \
  tests/fixtures/codex-rescue/0.148-continuation-lifecycle.json
git commit -m "fix: retain real codex rescue task paths"
```

- [ ] Spec reviewer compares fixture shapes with the committed amendment and
  confirms Root never depends on internal activity or a child ID.
- [ ] Quality reviewer checks correlation uniqueness, parser strictness,
  redaction/privacy, false-positive fixture tests, and backward compatibility.

## Task 3: Align security, ADR, release docs, and generated marketplace

**Files:**

- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/adr/0013-bind-rescue-child-to-zcode-session.md`
- Modify as required: `tests/release-contracts.test.mjs`
- Modify as required: `tests/plugin-contracts.test.mjs`
- Regenerate: `marketplace/` via `scripts/build-marketplace-snapshot.mjs`

### RED and source documentation

- [ ] Add release/security contract assertions that new flows use private v3
  canonical paths, plugin discovery supplies child ID, v2 pair is read-only
  compatibility, and public syntax has no selector. Run them against the old
  docs and record RED.
- [ ] Update English/Chinese README, SECURITY, CHANGELOG, and ADR 0013 to the
  same boundary. Record that canonical path selects but never authorizes; the
  durable child-ID/path binding remains authoritative.
- [ ] Keep the single-active-writable-Rescue policy unchanged. Preserve its ADR
  record as a valuable future concurrency capability: it could improve
  parallel Rescue throughput, but needs a separate isolation/admission design
  and is not authorized by this fix.

Run focused source checks:

```bash
node --test tests/release-contracts.test.mjs tests/plugin-contracts.test.mjs
git diff --check
git add README.md README.zh-CN.md SECURITY.md CHANGELOG.md \
  docs/adr/0013-bind-rescue-child-to-zcode-session.md \
  tests/release-contracts.test.mjs tests/plugin-contracts.test.mjs
git commit -m "docs: align rescue continuation identity boundary"
```

### Generate marketplace from a clean committed source

- [ ] Use an external temporary output directory because the builder rejects
  dirty/uncommitted source and in-tree output. Build with exact committed ref
  and SHA, compare/replace only the repository's generated `marketplace/`
  contents using the project's established snapshot workflow, then run parity
  tests. Never hand-edit marketplace copies.

Representative builder invocation (use the final source commit values):

```bash
snapshot_dir="$(mktemp -d)/marketplace"
source_sha="$(git rev-parse HEAD)"
node scripts/build-marketplace-snapshot.mjs \
  --output "$snapshot_dir" --source-ref "$source_sha" --source-sha "$source_sha"
```

Then use the repository's non-destructive snapshot replacement procedure and:

```bash
rsync -a --delete "$snapshot_dir/plugins/zcode/" marketplace/plugins/zcode/
cmp -s "$snapshot_dir/.agents/plugins/marketplace.json" \
  marketplace/.agents/plugins/marketplace.json || \
  cp "$snapshot_dir/.agents/plugins/marketplace.json" \
  marketplace/.agents/plugins/marketplace.json
cmp -s "$snapshot_dir/.agents/plugins/provenance.json" \
  marketplace/.agents/plugins/provenance.json || \
  cp "$snapshot_dir/.agents/plugins/provenance.json" \
  marketplace/.agents/plugins/provenance.json
node --test tests/marketplace-snapshot.test.mjs \
  tests/release-contracts.test.mjs tests/plugin-contracts.test.mjs
node --test tests/integration/marketplace-snapshot-build.mjs
MARKETPLACE_SNAPSHOT="$snapshot_dir" MARKETPLACE_SOURCE_REF="$source_sha" \
MARKETPLACE_SOURCE_SHA="$source_sha" \
  node --test tests/integration/marketplace-install.test.mjs
git diff --check
git add marketplace/.agents/plugins/marketplace.json \
  marketplace/.agents/plugins/provenance.json marketplace/plugins/zcode
git commit -m "build: refresh ZCode marketplace snapshot"
```

- [ ] Spec reviewer checks source/marketplace parity and no public/private
  contract drift.
- [ ] Quality reviewer checks provenance, generated-file integrity, bilingual
  consistency, and release-test signal.

## Final verification, independent review, PR, and CI

- [ ] Run all focused suites again, then fresh full verification:

```bash
npm run check
node --test tests/integration/package-install.test.mjs
python3 /Users/zhangzikai/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  skills/rescue
python3 /Users/zhangzikai/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
git diff --check
git status --short
```

- [ ] Ask a fresh ordinary subagent for a full branch spec review against
  `c8aae02`; ask a different fresh subagent for a full code/security review.
  Fix and re-review all Critical/Important findings, then rerun full tests.
- [ ] Confirm no uncommitted changes and inspect the complete diff against
  `main` without disturbing user files outside this worktree.
- [ ] Push `fix/rescue-continuation-path-selector`, create a PR summarizing the
  real host boundary, v3/v2 compatibility, tests, and explicitly unchanged
  writable-concurrency policy.
- [ ] Monitor every required GitHub check to completion. Diagnose and fix any
  failure on the branch, rerun local verification, push, and repeat until CI is
  green. Report the PR URL, final commit SHA, exact local verification, and CI
  result.
