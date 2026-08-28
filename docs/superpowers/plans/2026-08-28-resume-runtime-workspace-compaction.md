# Resume Runtime, Effective Workspace, and Compact Launcher Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cold ZCode session resume materialize its configured runtime exactly once, make direct job commands use the lifecycle-authoritative execution workspace, and restore the trusted Rescue launcher after mid-turn Codex compaction.

**Architecture:** Add narrow seams for a secret-safe lazy ZCode CLI model reader, an atomic read-only `effective` observer mode, an exact locked job-creator partition selector, and compact-only launcher context rendering. Preserve all current public syntax, persisted schemas, ownership boundaries, and fail-closed behavior.

**Tech Stack:** Node.js 22.13 ESM, native `node:test`, existing JSON-RPC ZCode client, Codex lifecycle hooks, npm marketplace snapshot builder, ESLint, TypeScript check mode.

---

## File map

### Runtime materialization

- Create `scripts/lib/zcode-runtime-config.mjs`: bounded, secret-safe reader for effective ZCode CLI `model.main`.
- Create `tests/zcode-runtime-config.test.mjs`: reader unit tests.
- Modify `scripts/lib/review.mjs`: exact snapshot-warning trigger and one-shot `session/setModel` recovery before send.
- Modify `scripts/zcode-companion.mjs`: inject the lazy runtime-model resolver into job execution.
- Modify `tests/job-control.test.mjs`: executor-level cold/warm and error semantics.
- Modify `tests/fixtures/fake-zcode-cli.mjs`: deterministic cold-runtime fixture behavior.
- Modify `tests/integration/companion.test.mjs`: real Companion request-order coverage using an isolated home.

### Effective workspace

- Modify `scripts/lib/identity.mjs`: add atomic read-only `workspaceBinding: 'effective'`, exact live-proof recovery carry, and the locked idempotent job-workspace selector.
- Modify `scripts/zcode-companion.mjs`: apply effective mode to observers, select the partition before non-Rescue creator pending/reservation work, and propagate `caller.workspace` everywhere.
- Modify `tests/identity.test.mjs`: identity-mode unit matrix.
- Modify `tests/integration/skills.test.mjs`: origin/target/foreign direct-command integration matrix.
- Modify `tests/integration/marketplace-install.test.mjs`: installed local-marketplace smoke coverage.

### Compact launcher

- Modify `hooks/session-lifecycle-hook.mjs`: compact-only launcher/error context rendering.
- Modify `scripts/lib/plugin-data.mjs`: trust the exact SessionStart runtime entry.
- Modify `tests/hooks.test.mjs`: lifecycle sequence, duplication, authority-preservation, and unsafe-path tests.
- Modify `tests/plugin-data.test.mjs`: exact entry/provenance tests if current plugin-data cases live there; otherwise add them beside the existing plugin-data tests in `tests/plugin-contracts.test.mjs`.

### Release surfaces

- Modify `README.md`, `README.zh-CN.md`, `SECURITY.md`, and `CHANGELOG.md`.
- Modify `skills/status/SKILL.md`, `skills/result/SKILL.md`, and `skills/cancel/SKILL.md` only for user-facing effective-workspace wording; do not change argv.
- Modify `tests/release-contracts.test.mjs`, `tests/skills-contracts.test.mjs`, and affected plugin/marketplace contract tests.
- Regenerate `marketplace/plugins/zcode/**` only through `scripts/build-marketplace-snapshot.mjs` after reviewed source commits are clean.

## Task 1: Add lazy, one-shot cold runtime materialization

**Files:**

- Create: `scripts/lib/zcode-runtime-config.mjs`
- Create: `tests/zcode-runtime-config.test.mjs`
- Modify: `scripts/lib/review.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Modify: `tests/job-control.test.mjs`
- Modify: `tests/fixtures/fake-zcode-cli.mjs`
- Modify: `tests/integration/companion.test.mjs`

- [ ] **Step 1: Write failing config-reader tests**

Cover an isolated `HOME`, Windows `USERPROFILE` fallback, first-slash parsing,
missing/unreadable files, oversized JSON, invalid JSON, missing or malformed
`model.main`, and a config containing credential-like sibling fields. The
returned value and thrown public error must never contain those sibling bytes.

Use the wished-for API:

```js
import { readZCodeCliMainModel } from '../scripts/lib/zcode-runtime-config.mjs';

const model = await readZCodeCliMainModel({ env: { HOME: home } });
assert.deepEqual(model, { providerId: 'bigmodel', modelId: 'GLM-5.2/variant' });
```

Run:

```bash
node --test tests/zcode-runtime-config.test.mjs
```

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement the minimal bounded reader**

Implement a focused reader with dependency injection for tests:

```js
export async function readZCodeCliMainModel({
  env = process.env,
  home = env.HOME || env.USERPROFILE || homedir(),
  maxBytes = 64 * 1024,
} = {}) {
  const path = join(home, '.zcode', 'cli', 'config.json');
  const contents = await readBoundedRegularFile(path, maxBytes);
  const parsed = JSON.parse(contents);
  const main = parsed?.model?.main;
  const slash = typeof main === 'string' ? main.indexOf('/') : -1;
  if (slash < 1 || slash === main.length - 1) throw runtimeConfigUnavailable();
  return { providerId: main.slice(0, slash), modelId: main.slice(slash + 1) };
}
```

Use existing filesystem safety helpers where they already provide bounded
regular-file and no-follow semantics. Map every read/parse/shape failure to one
fixed `PluginError` whose message and details do not include the path, raw
config, provider options, or secrets.

Run the new test and `npm run lint -- --quiet` if supported; otherwise run
`npm run lint`.

Expected: reader tests PASS.

- [ ] **Step 3: Write failing executor tests for the exact cold trigger**

Add focused tests around `executeJob()` proving:

```text
resume snapshot lastError.type = ZCODE_RUNTIME_MODEL_UNAVAILABLE
resolveRuntimeRecoveryModel called once
setModel called once even when tuple equals snapshot current
setThoughtLevel occurs after setModel when effort exists
send occurs once after recovery
```

Also prove:

- warm resume with no exact warning never calls the resolver or recovery setModel;
- other `lastError.type` values never recover;
- missing/invalid config preserves the original runtime-unavailable error;
- setModel rejection is authoritative;
- a genuine send/provider rejection after recovery is authoritative;
- no branch creates a new session, retries recovery, or sends twice.

Run the exact new `node --test --test-name-pattern` cases.

Expected: FAIL because `executeJob()` ignores the cold warning.

- [ ] **Step 4: Implement one-shot recovery before send**

Extend the `executeJob` input contract with:

```js
resolveRuntimeRecoveryModel?: () => Promise<{providerId:string,modelId:string}>
```

After `resumeSession` and before progress subscription/model/effort/send:

```js
let selectedModel = input.modelRequest
  ? resolveModel(input.modelRequest, input.modelAliases, snapshot.settings.model.available)
  : input.model;

if (input.resumeSessionId
  && snapshot.projection?.lastError?.type === 'ZCODE_RUNTIME_MODEL_UNAVAILABLE') {
  const recoveryModel = selectedModel ?? await input.resolveRuntimeRecoveryModel?.();
  if (!recoveryModel) throw runtimeModelUnavailable(snapshot);
  snapshot = await boundedStep(() => client.setModel(activeSessionId, recoveryModel), input.signal);
  selectedModel = recoveryModel;
}

if (selectedModel && !recoveryWasApplied
  && !sameModel(snapshot.settings.model.current, selectedModel)) {
  snapshot = await boundedStep(() => client.setModel(activeSessionId, selectedModel), input.signal);
}
```

Preserve the original structured error when the lazy resolver cannot supply a
tuple. Do not broad-catch `setModel` or `send`. Apply requested effort after the
model branch. Keep `sendAttempted` false until the single actual send begins.

In `executeReserved`, pass a lazy callback that calls
`readZCodeCliMainModel({ env })`; do not read config during argument parsing,
fresh create, warm resume, setup, or status.

Run focused executor tests.

Expected: PASS.

- [ ] **Step 5: Add fake-peer and Companion integration coverage**

Add a fixture switch that returns a valid resume snapshot with the exact
runtime warning and rejects materialization until `session/setModel` receives
the expected tuple. In an isolated home, write only a test CLI config and run
the real Companion path. Assert the recorded request order contains:

```js
assert.deepEqual(relevantMethods, [
  'session/resume',
  'session/setModel',
  'session/send',
]);
```

Run:

```bash
node --test tests/zcode-runtime-config.test.mjs tests/job-control.test.mjs tests/integration/companion.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add scripts/lib/zcode-runtime-config.mjs scripts/lib/review.mjs scripts/zcode-companion.mjs \
  tests/zcode-runtime-config.test.mjs tests/job-control.test.mjs \
  tests/fixtures/fake-zcode-cli.mjs tests/integration/companion.test.mjs
git commit -m "fix: materialize cold resume runtime"
```

## Task 2: Resolve and propagate the effective job workspace

**Files:**

- Modify: `scripts/lib/identity.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Modify: `tests/identity.test.mjs`
- Modify: `tests/integration/skills.test.mjs`
- Modify: `tests/integration/marketplace-install.test.mjs`

- [ ] **Step 1: Write failing IdentityStore tests**

Add `workspaceBinding: 'effective'` cases that prove:

```js
const fromOrigin = await identity.resolveActiveTurn({
  sessionId, workspace: origin, workspaceBinding: 'effective',
});
const fromTarget = await identity.resolveActiveTurn({
  sessionId, workspace: execution, workspaceBinding: 'effective',
});
assert.equal(fromOrigin.workspace, canonicalExecution);
assert.equal(fromTarget.workspace, canonicalExecution);
```

Before a target is bound, origin resolves to origin without mutation and a
linked worktree is rejected. After binding, unrelated and sibling worktrees are
rejected. Legacy state remains exact-workspace only. Snapshot active/session
files before and after to prove the new mode is read-only.

Run the exact IdentityStore cases.

Expected: FAIL with `IDENTITY_INPUT_INVALID` because the mode is not allowlisted.

- [ ] **Step 2: Implement the atomic effective mode**

Update the JSDoc and validation allowlist, then add one branch inside the
existing lifecycle lock:

```js
if (mode === 'effective') {
  if (active.executionWorkspace === null) {
    if (candidate !== active.originWorkspace) throw workspaceIneligible();
    return { kind: 'resolved', caller: publicActiveTurn(active, active.originWorkspace, false) };
  }
  if (candidate !== active.originWorkspace && candidate !== active.executionWorkspace) {
    throw workspaceIneligible();
  }
  return { kind: 'resolved', caller: publicActiveTurn(active, active.executionWorkspace, true) };
}
```

Do not change `execution`, `preview`, or `claim`. Do not call `persistClaim` or
probe Git from the new branch. Preserve legacy fallback behavior.

Run IdentityStore tests.

Expected: PASS.

- [ ] **Step 3: Write failing direct-command integration tests**

Create origin and linked execution partitions containing deliberate decoy jobs.
For `status`, `result`, and `cancel`, invoke from both eligible origin and exact
target and prove only the target job is selected. Cover:

- no-ID latest selection;
- explicit exact job ID;
- `status --all` without merging origin jobs;
- result artifact lookup in target only;
- queued and running cancel using target broker/state;
- Rescue binding closure in target only;
- unrelated/sibling worktree and foreign owner rejection;
- unbound same-workspace regression.

Run the exact new integration cases.

Expected: FAIL with `ACTIVE_TURN_WORKSPACE_INELIGIBLE` or wrong-partition selection.

- [ ] **Step 4: Propagate one effective workspace through direct invocation**

In `runDirectInvocation`, select `workspaceBinding: 'effective'` only when
`command` is `status`, `result`, or `cancel`. After resolution, set:

```js
const invocationWorkspace = caller.workspace;
```

Use that value for pending invocation storage/consumption and for
`runCompanion({ cwd: invocationWorkspace })`. Inside ordinary command handling,
continue using the `cwd` passed to `runCompanion`; do not retain the original
ambient cwd in selection, result, logs, client construction, cancellation,
binding closure, or reconciliation.

Do not enable the new mode for Rescue, review, adversarial-review, transfer, or
setup.

Run IdentityStore and direct-command integration tests.

Expected: PASS.

- [ ] **Step 5: Extend installed local-marketplace smoke coverage**

Use the existing isolated Codex marketplace harness to cover at least one
bound execution-worktree `status` invocation and assert no origin-partition
job leaks into output. Keep the marketplace source local and the test Codex
home isolated.

Run:

```bash
node --test tests/integration/marketplace-install.test.mjs tests/integration/skills.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add scripts/lib/identity.mjs scripts/zcode-companion.mjs \
  tests/identity.test.mjs tests/integration/skills.test.mjs \
  tests/integration/marketplace-install.test.mjs
git commit -m "fix: resolve bound job workspace"
```

## Task 2A: Make the most recently selected job partition authoritative

**Files:**

- Modify: `scripts/lib/identity.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Modify: `tests/identity.test.mjs`
- Modify: `tests/integration/skills.test.mjs`

- [x] **Step 1: Add the interrupted-cleanup carry regression**

Create a bound execution target, inject failure immediately after cleanup writes
the ended tombstone, and begin a strictly newer same-origin resume proof. Assert
that the new active record has no `recoveryWorkspace`, effective resolution
selects origin, and the old target is ineligible.

- [x] **Step 2: Require an exact live ledger proof before carry**

Carry `existing.executionWorkspace ?? existing.recoveryWorkspace` only when
the canonical origin matches, `ledger.endedAt === null`, and the ledger's exact
`sessionStartedAt` and `sessionSource` equal the incoming proof. Preserve
duplicate and same-proof pending-publication recovery.

- [x] **Step 3: Add the locked selector unit matrix**

Exercise origin clearing, exact non-origin selection, no recovery-pointer public
projection, idempotent retry without rewrite, ledger non-member rejection,
stale generation rejection, and a conflicting non-null execution claim.

- [x] **Step 4: Implement exact job workspace selection**

Add `IdentityStore.selectJobWorkspace()` with exact
`sessionId`/`turnId`/`generationId`/`originWorkspace` authority. Canonicalize
the requested paths, operate under the existing session lock, require a live
consistent ledger containing the target, clear recovery at origin, store the
exact member otherwise, and never modify `executionWorkspace`.

- [x] **Step 5: Wire all non-Rescue direct creators before durable work**

For `review`, `adversarial-review`, and `transfer`, resolve `preview`, then call
the selector with ambient cwd before pending-choice persistence or reservation.
Use the selected caller workspace for both `invoke` and `invoke-choice`.
Status/result/cancel keep `effective`; Rescue keeps `execution`; public argv is
unchanged.

- [x] **Step 6: Add end-to-end partition lifecycle tests**

Prove Rescue target to next origin creator to later status/result/cancel stays
in origin, old target and explicit historical IDs are not merged, retarget
failure creates no job, reservation failure leaves the selected pointer,
pending choice uses the same partition, delayed older invocation is fenced,
same-turn execution conflict rejects, and exact retries are idempotent.

## Task 3: Rehydrate the launcher after compact SessionStart

**Files:**

- Modify: `hooks/session-lifecycle-hook.mjs`
- Modify: `scripts/lib/plugin-data.mjs`
- Modify: `tests/hooks.test.mjs`
- Modify: existing plugin-data tests

- [ ] **Step 1: Write failing lifecycle-sequence tests**

Run a real hook sequence:

```text
SessionStart(source=startup)
UserPromptSubmit
SessionStart(source=compact)
```

Capture the ordinary launcher line and assert compact SessionStart returns one
byte-identical launcher line. Snapshot identity and session files before the
compact call and prove the compact hook neither rotates the active turn nor
changes the original trusted startup source.

Also assert:

- startup/resume/clear SessionStart contain no launcher marker;
- a second compact call is deterministic;
- the context stays below the manifest limit;
- unsafe installed paths return only the fixed launcher-error context.

Run the exact hook tests.

Expected: FAIL because compact SessionStart emits only the generic sentence.

- [ ] **Step 2: Write failing plugin-entry provenance tests**

Add the exact `hooks/session-lifecycle-hook.mjs` entry to the runtime-entry test
matrix. Prove a correct installed cache entry resolves its lexical plugin
instance, while a foreign/wrong-target entry and traversal fail closed.

Run the focused plugin-data tests.

Expected: FAIL because the SessionStart entry is not allowlisted.

- [ ] **Step 3: Implement compact-only context rendering**

Add `['hooks', 'session-lifecycle-hook.mjs']` to
`TRUSTED_RUNTIME_ENTRIES`. Refactor the one-line SessionStart hook for clarity
without changing record ordering:

```js
const input = await readHookInput('SessionStart');
const pluginRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const pluginData = resolvePluginDataContext({
  env: process.env,
  pluginRoot,
  entryPath: process.argv[1],
});
await recordSession(pluginData.dataRoot, input);

let additionalContext = 'ZCode companion lifecycle is active for this parent session.';
if (input.source === 'compact') {
  try {
    const command = renderRescueLauncherCommand(
      join(pluginData.runtimePluginRoot, 'skills', 'rescue', 'launcher.mjs'),
    );
    additionalContext = renderRescueUserPromptContext(command, []);
  } catch {
    additionalContext = RESCUE_LAUNCHER_ERROR_CONTEXT;
  }
}
```

Emit `hookEventName: 'SessionStart'`. Do not call active-turn or preparation
APIs and do not attach unread-job notices. Reuse the shared renderer rather
than constructing JSON or quoting a path locally.

Run focused hook and plugin-data tests.

Expected: PASS.

- [ ] **Step 4: Commit Task 3**

```bash
git add hooks/session-lifecycle-hook.mjs scripts/lib/plugin-data.mjs \
  tests/hooks.test.mjs tests/plugin-contracts.test.mjs tests/plugin-data.test.mjs
git commit -m "fix: restore launcher after compaction"
```

Only add test paths that actually changed.

## Task 4: Align public contracts and release documentation

**Files:**

- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`
- Modify: `skills/status/SKILL.md`
- Modify: `skills/result/SKILL.md`
- Modify: `skills/cancel/SKILL.md`
- Modify: `tests/release-contracts.test.mjs`
- Modify: `tests/skills-contracts.test.mjs`

- [ ] **Step 1: Write failing release-contract assertions**

Add bilingual contract checks for:

- exact-warning, lazy, one-shot CLI `model.main` cold recovery;
- no config read on warm resume and no fallback to fresh;
- status/result/cancel using one immutable bound execution workspace from
  either eligible origin or target, without partition scanning/merging;
- compact SessionStart rehydrating the same instance-bound launcher;
- unchanged public argv and writable-concurrency policy.

Run:

```bash
node --test tests/release-contracts.test.mjs tests/skills-contracts.test.mjs
```

Expected: FAIL because the docs do not state the new contracts.

- [ ] **Step 2: Update docs and Skill descriptions narrowly**

Document behavior without exposing internal selectors or promising automatic
success for unsupported models. Keep every Skill command invocation byte-for-
byte unchanged. Clarify that direct job commands follow the active lifecycle's
effective workspace; do not suggest users pass a workspace argument.

Add three concise Unreleased changelog bullets. Preserve version `0.1.0` and
the existing concurrency ADR deferral.

Run release and Skill contract tests, lint, and typecheck.

Expected: PASS.

- [ ] **Step 3: Commit Task 4**

```bash
git add README.md README.zh-CN.md SECURITY.md CHANGELOG.md \
  skills/status/SKILL.md skills/result/SKILL.md skills/cancel/SKILL.md \
  tests/release-contracts.test.mjs tests/skills-contracts.test.mjs
git commit -m "docs: explain resume lifecycle recovery"
```

## Task 5: Review source, publish the marketplace snapshot, and verify

**Files:**

- Modify generated files under: `marketplace/plugins/zcode/**`
- Modify as required by builder: `marketplace/.agents/plugins/provenance.json`

- [ ] **Step 1: Run source-only focused verification**

```bash
npm run check:line-endings
npm run lint
npm run typecheck
node --test tests/zcode-runtime-config.test.mjs tests/identity.test.mjs \
  tests/hooks.test.mjs tests/job-control.test.mjs \
  tests/integration/skills.test.mjs tests/integration/companion.test.mjs \
  tests/release-contracts.test.mjs tests/skills-contracts.test.mjs
```

Expected: PASS with zero failures and no unexpected warnings.

- [ ] **Step 2: Run the final whole-source review gate**

Compare the implementation against the complete design acceptance criteria.
Resolve every Critical or Important review finding through the original task's
implementer and rerun its focused tests. Do not generate the marketplace from
unreviewed source.

- [ ] **Step 3: Ensure the source tree is committed and clean**

```bash
git status --short
git log --oneline --decorate -6
```

Expected: no source changes remain uncommitted. The design, runtime,
workspace, compact-hook, and documentation commits are present.

- [ ] **Step 4: Generate the marketplace snapshot through the supported builder**

Resolve the exact clean source SHA and run the repository's documented
snapshot command/API. Do not manually copy or edit marketplace files. The
builder must perform its own detached clean-source install and record matching
source SHA/version/dependency-lock provenance.

Use the command already exercised by
`tests/integration/marketplace-snapshot-build.mjs`; if the repository exposes a
documented CLI wrapper, prefer that exact wrapper. Verify:

```bash
node --test tests/marketplace-snapshot.test.mjs \
  tests/integration/marketplace-snapshot-build.mjs \
  tests/integration/marketplace-install.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit generated marketplace bytes**

```bash
git add marketplace
git commit -m "build: refresh recovery marketplace snapshot"
```

- [ ] **Step 6: Run complete verification on the final commit**

With Node 22.13 and lockfile-installed development dependencies:

```bash
npm ci --include=dev
npm run check
python3 /Users/zhangzikai/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  marketplace/plugins/zcode
git diff --check origin/main...HEAD
git status --short
```

Expected: all commands exit 0 and the worktree is clean.

- [ ] **Step 7: Open the PR and monitor CI**

```bash
git push -u origin fix/resume-runtime-workspace-compaction
gh pr create --base main --head fix/resume-runtime-workspace-compaction \
  --title "Fix resume runtime and lifecycle recovery" \
  --body-file <prepared-pr-body-file>
gh pr checks --watch
```

The PR body must summarize the three independent fixes, security boundaries,
TDD coverage, marketplace generation, and verification commands. If CI fails,
inspect the exact failed job logs, reproduce locally where possible, dispatch a
focused fix subagent, rerun review and verification, push the fix, and continue
watching until every required check succeeds.
