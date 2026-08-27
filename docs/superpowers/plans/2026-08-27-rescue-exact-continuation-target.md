# Rescue Exact Continuation Target Implementation Plan

> **Execution requirement:** implement this plan with ordinary Codex subagents
> only. Do not invoke ZCode Rescue at any point. Use one fresh implementation
> worker per task, then a fresh spec-compliance reviewer and a different fresh
> code-quality reviewer. Resolve and re-review every Critical or Important
> finding before the next task.

**Goal:** Let Root privately identify the exact stopped Rescue child it intends
to continue so multiple valid bindings no longer force the wrong global
ambiguity, while preserving the public Rescue facade, exact binding authority,
privacy, targetless compatibility, and one-writable-job policy.

**Source of truth:**
`docs/superpowers/specs/2026-08-27-rescue-exact-continuation-target-design.md`
at its committed revision. ADR 0014 records only the deferred future
writable-concurrency decision and authorizes no runtime change.

**Architecture:** Evolve the private preparation envelope from exact v1 to an
exact v2 form with `continuationTarget: null | {childId, agentPath}` while still
accepting targetless v1 frames. Root builds the pair only from one linked
spawn/start lifecycle. The route planner validates all host metadata, narrows
to the exact pair before executor/binding reads, and then uses the existing
binding/session authority. The prepared child still receives only the constant
assignment and independently proves ambient identity.

**Technology:** Node.js 22 ESM, `node:test`, Codex app-server child discovery,
private JSON preparation records, existing StateStore/binding codecs, generated
marketplace snapshot, npm package/install qualification.

---

## Global execution rules

- Start each production task with failing tests and capture the RED output.
- Make the minimum production change that satisfies the committed spec.
- Use `apply_patch` for edits. Do not overwrite or revert another worker's
  changes; all workers share this worktree.
- Keep `skills/rescue/launcher.mjs`, managed child Role text, public command
  syntax, binding schema, StateStore writable admission, recovery,
  cancellation, and SessionEnd behavior unchanged unless this plan explicitly
  names a documentation/test-only expectation.
- Never weaken an old failure test to make the new behavior pass. Targetless
  two-binding resume must remain ambiguous.
- Commit only after the task's focused tests and `git diff --check` pass.
- Review each task commit first against the spec, then for code quality. A
  reviewer reports only concrete Critical/Important findings with file/line
  evidence; "no findings" is an acceptable result.

## Task 1: Version the private envelope and select one exact planner target

**Files:**

- Modify: `scripts/lib/rescue-preparation.mjs`
- Modify: `scripts/lib/rescue-route-planner.mjs`
- Test: `tests/rescue-preparation.test.mjs`
- Test: `tests/rescue-route-planner.test.mjs`

### RED: exact envelope compatibility and target semantics

Add tests in `tests/rescue-preparation.test.mjs` before production edits:

- Export/latest envelope version is 2, while a separate private constant or
  literal preserves persisted preparation record v1 classification.
- Exact v1 four-key targetless envelopes still parse and defensively copy.
- Exact v2 five-key envelopes parse with `continuationTarget: null` and with a
  complete `{childId, agentPath}`; nested objects are defensively copied.
- Reject v2 missing/extra top-level keys; partial/extra/null pair members;
  empty, non-string, control-bearing, or more-than-512-byte child IDs; unsafe,
  relative, control-bearing, or more-than-1024-byte paths; duplicate JSON keys;
  and a non-null target unless `options.resume === 'resume'`.
- Prove one maximum valid pair plus maximum task fits the exported envelope
  byte limit and one byte beyond the bound fails.
- Round-trip v2 envelopes through preparation-record schema v3, replacement
  generations, and consumption. Retain one legacy persisted record-v1 test so
  changing the envelope version cannot silently reclassify it.

Run and record the expected failure:

```bash
node --test tests/rescue-preparation.test.mjs
```

Add planner tests in `tests/rescue-route-planner.test.mjs` before planner edits:

- Two complete usable bindings plus child 2's exact pair follows only child 2.
  Repeat with reversed list order/timestamps and target the base child in one
  case to prove no suffix/latest preference.
- Assert executor and binding adapters are never called for structurally valid
  non-target siblings.
- Missing target, same-ID/wrong-path, same-path/wrong-ID, unmanaged, unbound,
  revoked, and ineligible selected children return `RESCUE_BINDING_INVALID`
  without spawn or sibling fallback.
- Duplicate IDs/paths in the injected validated-list seam remain
  `RESCUE_CHILD_AMBIGUOUS` before filtering. Existing malformed app-server
  metadata remains `CODEX_CHILD_METADATA_INVALID`.
- A target plus fresh and a target plus omitted `resume` each fail as
  `RESCUE_ROUTE_INVALID` before `listChildren`.
- A targetless v1 direct planner input with omitted resume keeps its existing
  compatibility behavior; absence is normalized as no target, not as a target.
- Targeted modern v3 and exact legacy v1/v2 migration fixtures both preserve
  existing activation/session behavior.
- Keep the old targetless two-usable-bindings ambiguity test unchanged.

Run and record the expected failure:

```bash
node --test tests/rescue-route-planner.test.mjs
```

### GREEN: minimal parser and planner seam

In `scripts/lib/rescue-preparation.mjs`:

- Separate envelope versions from record versions. A representative structure
  is:

  ```js
  export const RESCUE_PREPARATION_VERSION = 2;
  const LEGACY_PREPARATION_RECORD_VERSION = 1;
  const V1_ENVELOPE_KEYS = ['options', 'source', 'task', 'version'];
  const V2_ENVELOPE_KEYS = [...V1_ENVELOPE_KEYS, 'continuationTarget'];
  const CONTINUATION_TARGET_KEYS = ['agentPath', 'childId'];
  ```

- Accept only exact v1/four-key or v2/five-key schemas. Validate/copy a null or
  exact pair for v2. Reuse the same bounded/control-free ID and canonical path
  semantics as the planner; do not import a circular dependency.
- Require non-null target only for explicit `resume` semantics. Preserve all
  existing option/task/source checks and duplicate-key rejection.
- Keep record schema v3 and every legacy record v1/v2 branch intact. Replace
  only the accidental use of the envelope constant in `recordKind`.
- Ensure `RESCUE_ENVELOPE_MAX_BYTES` explicitly covers the maximum valid v2
  serialization without creating an unbounded reader.

In `scripts/lib/rescue-route-planner.mjs`:

- Validate the already-parsed target again as defense in depth in
  `validatePlannerInput`; normalize an absent v1 field to no target. Whenever
  the field is present and non-null (or the normalized target is non-null),
  require `options.resume === 'resume'` before discovery. This rejects both
  fresh and omitted-resume targeted inputs without breaking targetless v1.
- After `validateChildren` has checked the complete child list, require one
  child matching both ID and path when the target is non-null. On no exact pair
  throw `RESCUE_BINDING_INVALID`; do not reconstruct either member.
- Run executor and binding resolution only over the narrowed list. Preserve the
  complete list for fresh name occupancy and preserve the old full-list path
  when target is absent.
- Leave activation/directive schemas and binding resolver behavior unchanged.
  The existing exact join remains the only authority.

### Verify and commit

```bash
node --test tests/rescue-preparation.test.mjs tests/rescue-route-planner.test.mjs
node --test tests/rescue-binding.test.mjs tests/state.test.mjs
git diff --check
git status --short
git add scripts/lib/rescue-preparation.mjs scripts/lib/rescue-route-planner.mjs \
  tests/rescue-preparation.test.mjs tests/rescue-route-planner.test.mjs
git diff --cached --check
git commit -m "fix: select exact rescue continuation target"
```

Give this commit and the accepted spec to a fresh spec reviewer. After all spec
findings are fixed and re-reviewed, give the resulting diff to a different
quality reviewer to inspect schema/version coupling, bounds, duplicate handling,
filter order, side effects, error sanitization, and test signal. Re-run the
focused commands after every fix.

## Task 2: Teach Root's Skill and companion boundary the private handle flow

**Files:**

- Modify: `skills/rescue/SKILL.md`
- Modify only if typing/explicit omission requires it:
  `scripts/zcode-companion.mjs`
- Modify: `docs/adr/0013-bind-rescue-child-to-zcode-session.md`
- Test: `tests/skills-contracts.test.mjs`
- Test: `tests/integration/skills.test.mjs`
- Test: `tests/integration/companion.test.mjs`
- Test: `tests/rescue-launcher.test.mjs`
- Test: `tests/plugin-contracts.test.mjs`

### RED: Root lifecycle, end-to-end route, and no propagation

Add contract/integration tests first:

- Skill requires Root to retain the child ID from one successful `spawn_agent`
  output together with that same call's linked
  `sub_agent_activity.started.agent_path`; it retains the unchanged pair across
  stop/restore/follow-up and never synthesizes a path from `taskName`.
- Skill emits exact v2 frames for new flows: fresh/non-resume uses
  `continuationTarget: null`; a semantically exact resume uses its retained
  pair. If one linked pair or the intended operation is unavailable, Root asks
  for clarification rather than guessing or invoking the plugin.
- Skill keeps public syntax, `prepare rescue`, `invoke-prepared rescue`, named
  and generic child assignments, and prepared route execution unchanged.
- Two valid sibling bindings through raw TTY v2 preparation select the exact
  pair, emit one follow-up path, and resume only the selected original ZCode
  session. Targetless v1 and v2 compatibility cases retain ambiguity.
- Cross-pair/path drift, sibling ambient invocation, binding drift after
  planning, and replay fail before preparation consumption or ZCode RPC.
- The reconstructed Rescue argv and fake ZCode frames contain neither the
  `continuationTarget` object nor child ID. The independently validated path may
  appear only as the existing prepared follow-up route target.
- Launcher argv acceptance tests remain byte-for-byte unchanged.

Run and capture RED:

```bash
node --test tests/skills-contracts.test.mjs tests/integration/skills.test.mjs \
  tests/integration/companion.test.mjs tests/rescue-launcher.test.mjs \
  tests/plugin-contracts.test.mjs
```

### GREEN: Skill contract and boundary preservation

In `skills/rescue/SKILL.md`:

- Replace the old statement that stopped resume needs no retained handle with
  the exact same-lifecycle pair contract. Root chooses semantic intent and
  supplies the selector; the companion still owns all authorization.
- Specify exact v2 five-key frames and v1 only as accepted compatibility, not
  new emission. Preserve omission rules inside `options`.
- Require the pair only in the single post-readiness `write_stdin` frame.
  Explicitly forbid pair/child-ID propagation into commands, environment,
  assignment, output, child transcript, relay, status/result, and ZCode.
- Keep the returned route authoritative: Root follows only
  `prepared.route.target`; it never directly follows the retained pair.
- After a successful new spawn, require Root to retain the returned ID and
  linked started path for future continuation. Preserve active-child priority
  and the existing no-followup rule for an active child.

In `scripts/zcode-companion.mjs`, rely on the validated envelope already passed
to `planRescueActivation` and stored by the preparation store. Make only the
smallest explicit typing/copy change needed. `rescueArgvFromPreparation` must
continue reading only task/options and must never propagate the selector.

Amend ADR 0013 narrowly: when Root has one exact retained selector, multiple
valid sibling bindings are not an authorization ambiguity; the selected child
must still pass the complete durable join. Targetless multiple mappings remain
ambiguous. Do not mention or enable concurrent writable jobs.

### Verify and commit

```bash
node --test tests/skills-contracts.test.mjs tests/integration/skills.test.mjs \
  tests/integration/companion.test.mjs tests/rescue-launcher.test.mjs \
  tests/plugin-contracts.test.mjs
node --test tests/rescue-preparation.test.mjs tests/rescue-route-planner.test.mjs
git diff --check
git add skills/rescue/SKILL.md scripts/zcode-companion.mjs \
  docs/adr/0013-bind-rescue-child-to-zcode-session.md \
  tests/skills-contracts.test.mjs tests/integration/skills.test.mjs \
  tests/integration/companion.test.mjs tests/rescue-launcher.test.mjs \
  tests/plugin-contracts.test.mjs
git diff --cached --check
git commit -m "feat: carry private rescue continuation handles"
```

If `scripts/zcode-companion.mjs` or a listed test is byte-identical, do not add
it merely to match the list. Spec review must check same-lifecycle provenance,
clarification behavior, route authority, exact-session continuation, and every
privacy boundary. Quality review must check that launcher/Role/public syntax
did not drift, no selector entered argv/output, and races still fail closed.

## Task 3: Qualify captured and restored exact-target lifecycles

**Files:**

- Modify: `tests/helpers/codex-rescue-qualification.mjs`
- Modify: `tests/codex-rescue-qualification.test.mjs`
- Modify: `tests/e2e/codex-skills-e2e.test.mjs`
- Modify only if the existing helper contract requires it:
  `tests/helpers/installed-rescue-lifecycle-contract.mjs`

### RED: qualification mutations and privacy sentinels

Update/add qualification tests before helper implementation:

- Captured named and generic resume fixtures contain the same ID/path in the
  successful spawn output, linked started/stopped activity, private v2 frame,
  validated preparation activation, prepared route path, and invoked ambient
  child. Two valid sibling bindings prove the pair, not order/latest, selects.
- Mutate one link at a time: spawn output ID, started ID/path, stopped path,
  private child ID/path, app-server child pair, activation ID/path digest,
  follow-up route path, ambient invoked ID, binding/session. Each mismatch must
  fail the named qualification reason without accepting a sibling.
- Keep one captured targetless v1 fixture to prove compatibility and convert
  newly generated fresh/resume fixtures to v2 (`null` for fresh, exact pair for
  resume).
- Privacy scans allow individual ID/path only in original linked host events;
  require the serialized pair/key only in the authorized `write_stdin` frame
  and private record. Forbid additional plugin-controlled appearance in argv,
  env, assignments, relay/status/result, stdout/stderr, child transcript, and
  fake ZCode request/response frames. Allow independently validated path alone
  in the prepared route and follow-up host call.
- Correct the existing qualifier mismatch so `followup_task.target` is the
  plugin-prescribed route path, not an independently chosen thread ID.

Run and capture RED:

```bash
node --test tests/codex-rescue-qualification.test.mjs \
  tests/e2e/codex-skills-e2e.test.mjs
```

### GREEN: exact qualification implementation

In `tests/helpers/codex-rescue-qualification.mjs`:

- Parse exact v1/four-key and v2/five-key envelopes; validate null/pair shapes
  and bounds consistently with production.
- Link one spawn output to one `sub_agent_activity.started` event by call/event
  identity before accepting its pair. For restored history require the same
  retained pair through stopped metadata and the new resume frame.
- Match non-null target to app-server child metadata, exact preparation
  activation ID/path digest, prepared route path, and ambient invocation.
- Scope private-value scans by event/boundary rather than globally banning raw
  ID/path strings.
- Keep production validation helpers as the final oracle for stored records and
  prepared directives; do not duplicate binding authority in fixture logic.

Update captured E2E fixtures to demonstrate the original 2026-08-27 shape:
multiple valid logical Rescue children, exact private selection of one, one
follow-up, zero spawn, original `session/resume`, and no selector propagation.

### Verify and commit

```bash
node --test tests/codex-rescue-qualification.test.mjs \
  tests/e2e/codex-skills-e2e.test.mjs
node --test tests/skills-contracts.test.mjs tests/integration/companion.test.mjs
git diff --check
git add tests/helpers/codex-rescue-qualification.mjs \
  tests/codex-rescue-qualification.test.mjs tests/e2e/codex-skills-e2e.test.mjs \
  tests/helpers/installed-rescue-lifecycle-contract.mjs
git diff --cached --check
git commit -m "test: qualify exact rescue continuation targeting"
```

Do not stage an unchanged optional helper. Spec review checks all nine
acceptance items, especially original lifecycle provenance and privacy.
Quality review checks mutation isolation, deterministic fixtures, diagnostic
specificity, bounded parsing, and that qualifiers do not bless behavior the
runtime rejects.

## Task 4: Publish the private-routing contract without exposing a public selector

**Files:**

- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`
- Test: `tests/public-text.test.mjs`
- Test: `tests/release-contracts.test.mjs`

### RED and GREEN

First update contract tests to require:

- English and Chinese docs say `--resume` remains argument-free and Root
  privately retains one exact host child ID/path pair.
- The pair is a selector only; durable binding/session/permission/workspace
  validation remains authority, and targetless multiple bindings fail closed.
- SECURITY documents the authorized private v2 frame, original host-event
  exceptions, no additional propagation, and target drift/cross-pair failure.
- CHANGELOG Unreleased describes the fixed multiple-binding ambiguity without
  promising same-workspace writable concurrency.
- ADR 0014 remains source-only and is absent from package/marketplace allowlists.

Run the tests to capture RED, make the smallest bilingual/security/changelog
edits, then run:

```bash
node --test tests/public-text.test.mjs tests/release-contracts.test.mjs
node --test tests/skills-contracts.test.mjs tests/plugin-contracts.test.mjs
git diff --check
git add README.md README.zh-CN.md SECURITY.md CHANGELOG.md \
  tests/public-text.test.mjs tests/release-contracts.test.mjs
git diff --cached --check
git commit -m "docs: publish exact rescue continuation behavior"
```

Spec review checks public/private terminology, bilingual parity, no public
selector, and no concurrency promise. Quality review checks concise wording,
test brittleness, and consistency with shipped Skill/ADR 0013.

## Task 5: Regenerate the marketplace and qualify the complete branch

**Generated scope:**

- Regenerate: `marketplace/.agents/plugins/provenance.json`
- Regenerate only builder-produced files under:
  `marketplace/plugins/zcode/`
- Test: marketplace/build/install/package contracts as produced by the builder

Start from a clean source commit. Do not hand-edit generated files and do not
add source-only ADR 0014 to `package.json` or marketplace payload.

```bash
SOURCE_SHA="$(git rev-parse HEAD)"
SNAPSHOT_PARENT="$(mktemp -d)"
node scripts/build-marketplace-snapshot.mjs \
  --output "$SNAPSHOT_PARENT/marketplace-snapshot" \
  --source-ref "$SOURCE_SHA" \
  --source-sha "$SOURCE_SHA"
rsync -a --delete "$SNAPSHOT_PARENT/marketplace-snapshot/plugins/zcode/" \
  marketplace/plugins/zcode/
cmp -s "$SNAPSHOT_PARENT/marketplace-snapshot/.agents/plugins/marketplace.json" \
  marketplace/.agents/plugins/marketplace.json || \
  cp "$SNAPSHOT_PARENT/marketplace-snapshot/.agents/plugins/marketplace.json" \
  marketplace/.agents/plugins/marketplace.json
cmp -s "$SNAPSHOT_PARENT/marketplace-snapshot/.agents/plugins/provenance.json" \
  marketplace/.agents/plugins/provenance.json || \
  cp "$SNAPSHOT_PARENT/marketplace-snapshot/.agents/plugins/provenance.json" \
  marketplace/.agents/plugins/provenance.json
```

Verify the exact generated snapshot before committing:

```bash
node --test tests/marketplace-snapshot.test.mjs tests/plugin-contracts.test.mjs \
  tests/release-contracts.test.mjs
node --test tests/integration/marketplace-snapshot-build.mjs
MARKETPLACE_SNAPSHOT="$SNAPSHOT_PARENT/marketplace-snapshot" \
MARKETPLACE_SOURCE_REF="$SOURCE_SHA" MARKETPLACE_SOURCE_SHA="$SOURCE_SHA" \
  node --test tests/integration/marketplace-install.test.mjs
git diff --check
git status --short
git add marketplace/.agents/plugins/marketplace.json \
  marketplace/.agents/plugins/provenance.json marketplace/plugins/zcode
git diff --cached --name-only
git commit -m "build: refresh ZCode marketplace snapshot"
```

The generated provenance must identify Task 4's clean source commit, not the
snapshot commit. Remove the temporary directory after verification.

Run fresh complete qualification from the clean branch:

```bash
npm run check
node --test tests/integration/package-install.test.mjs
git diff --check
git status --short
git diff --stat origin/main...HEAD
```

Confirm existing one-writable-job tests remain present and unchanged in
`tests/state.test.mjs`, `tests/integration/companion.test.mjs`, and
`tests/rescue-binding.test.mjs`. Confirm no command or transcript records a
ZCode Rescue invocation during development.

Give the complete `origin/main...HEAD` diff and accepted spec to a fresh final
spec reviewer. Resolve and re-review all Critical/Important findings, regenerate
the marketplace if any shipped source byte changes, and rerun all focused plus
complete checks. Then give the clean final diff to a different quality reviewer
and repeat the same fix/regeneration/verification cycle.

## PR and CI completion

After all local reviews and fresh verification pass:

Create the ignored PR body with `apply_patch` at
`.planning/2026-08-27-rescue-continuation-target/pr-body.md`. It must summarize
the exact private selector, compatibility/error/privacy behavior, verification
evidence, and ADR 0014's out-of-scope boundary. Inspect the complete file and
verify `test -s .planning/2026-08-27-rescue-continuation-target/pr-body.md`
before running:

```bash
git push -u origin feat/rescue-continuation-target
gh pr create --base main --head feat/rescue-continuation-target \
  --title "Fix exact ZCode Rescue continuation targeting" \
  --body-file .planning/2026-08-27-rescue-continuation-target/pr-body.md
gh pr checks --watch
```

The PR body must summarize the private target seam, targetless compatibility,
tests, and ADR 0014's explicit non-implementation boundary. Never include
private incident task/session/job identifiers.

If any required CI job fails, inspect its exact logs, reproduce locally when
possible, add or tighten a regression test first, apply the smallest fix with
an ordinary subagent and the same spec/quality review cycle, regenerate the
marketplace when shipped bytes change, push, and watch again. Stop only when
the PR exists and every required check reports success.
