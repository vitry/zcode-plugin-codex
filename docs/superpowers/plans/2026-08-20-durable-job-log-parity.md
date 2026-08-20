# Durable Job Log Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a private per-job log beside each persisted job JSON, expose its path only in exact-owner detailed status, and record safe semantic progress plus authoritative visible output without persisting raw tool output or reasoning.

**Architecture:** A new deep `job-log.mjs` module owns exact path derivation, private-file validation, formatting, and serialized appends. State stores an optional exact `logFile`; the progress reporter gets an independent observational archive sink; terminal and recovery paths append selected visible assistant/final output only after existing authoritative validation. Root relay, status grammar, four-entry previews, task-blind Rescue routing, and terminal authority remain unchanged.

**Tech Stack:** Node.js 22.13 ESM, `node:test`, existing private workspace storage and advisory locks, existing ZCode structured progress/session schemas, Git worktrees, GitHub CLI.

---

## Execution gate and parallel topology

Implementation is intentionally paused while another repository PR is in flight. Do not run Task 1 or create worker worktrees until that PR is merged or otherwise settled.

When work resumes, Root owns the integration worktree:

```text
.worktrees/progress-history
branch: feature/zcode-job-logs
```

Root first rebases this branch onto the latest `origin/main`, reruns the clean baseline, and then creates worker worktrees from the rebased integration commit. Use neutral directory names because installed-host qualification rejects sensitive task/job words inside launcher paths.

Wave 1 runs three implementation agents concurrently in separate worktrees:

```text
.worktrees/history-storage   branch feature/history-storage
.worktrees/history-status    branch feature/history-status
.worktrees/history-docs      branch feature/history-docs
```

Wave 2 starts only after Root integrates Wave 1:

```text
.worktrees/history-runtime   branch feature/history-runtime
```

Each worker owns only the files listed in its task. Workers must not edit another worker's files, must not revert concurrent work, and must commit their own branch. Root cherry-picks the worker commits into `feature/zcode-job-logs`, runs focused tests after each integration, then runs the full suite.

## File responsibility map

### New module

- `scripts/lib/job-log.mjs`: exact job-log path derivation, private creation, safe formatting, append serialization, and observational sink lifecycle.
- `tests/job-log.test.mjs`: storage, identity, containment, formatting, ordering, and failure-isolation tests for that interface.

### State and rendering

- `scripts/lib/state.mjs`: optional `logFile` job field, exact computed-path validation, and one attach method for active jobs.
- `scripts/zcode-companion.mjs`: preserve `logFile` only in same-owner public job projections; omit it from foreign projections and bound status.
- `scripts/lib/render.mjs`: display `Log:` only for an exact-owner detailed job.
- `tests/state.test.mjs`: legal attachment, persistence, corrupt path rejection, lifecycle restrictions.
- `tests/render-progress.test.mjs`: detailed/compact/foreign/JSON rendering behavior.
- `tests/job-control.test.mjs`: owner and `--all` projections remain isolated.

### Runtime integration

- `scripts/lib/progress.mjs`: independent bounded `archive` sink, separate from writer, preview persistence, probe persistence, and coarse relay.
- `scripts/lib/review.mjs`: create/attach the log, archive progress, append current-turn visible assistant output and successful final output.
- `scripts/lib/recovery.mjs`: append recovered authoritative output after a successful recovery winner.
- `scripts/lib/transfer.mjs`: create/attach the log and append the authoritative Transfer final output without inventing assistant text.
- `tests/progress.test.mjs`: archive ordering, bounded queue, failure isolation, flush/close behavior.
- `tests/job-control.test.mjs`: foreground success/failure/cancellation and exact output blocks.
- `tests/recovery.test.mjs`: recovered result logging and terminal-winner races.
- `tests/transfer.test.mjs`: Transfer log creation/final output and failure isolation.
- `tests/integration/companion.test.mjs`: real CLI status path, foreground/background persistence, and absence of raw content.

### Documentation and distribution

- `README.md`, `README.zh-CN.md`: private per-job logs, status path, retained safety exclusions.
- `SECURITY.md`: log content allowlist and owner/path constraints.
- `CHANGELOG.md`: unreleased feature entry.
- `docs/manual-uninstall.md`: logs retained with job history and erased only through proven workspace cleanup.
- `tests/release-contracts.test.mjs`, `tests/plugin-contracts.test.mjs`: documentation/security and no-raw-output contracts.
- `marketplace/plugins/zcode/**`: generated mirror refreshed only by Root through the established marketplace build/snapshot workflow.

## Task 0: Resume gate, rebase, and clean baseline

**Owner:** Root only

**Files:** No source changes.

- [ ] **Step 1: Confirm the competing PR is settled**

Run:

```bash
gh pr list --state open --limit 50
git fetch origin --prune
```

Expected: identify the previously in-flight repository PR and confirm it is merged or closed before proceeding.

- [ ] **Step 2: Verify the integration worktree is clean**

Run:

```bash
git -C .worktrees/progress-history status --short
```

Expected: no output.

- [ ] **Step 3: Rebase onto current main**

Run from `.worktrees/progress-history`:

```bash
git rebase origin/main
```

Expected: successful rebase with the design and plan commits retained. If conflicts occur, use the `resolving-merge-conflicts` skill and do not begin implementation until resolved.

- [ ] **Step 4: Reinstall exact dependencies**

Run:

```bash
npm ci
```

Expected: exit 0 and no lockfile modification.

- [ ] **Step 5: Run the complete rebased baseline**

Run:

```bash
npm test
```

Expected: exit 0; opt-in authenticated tests may remain skipped with their existing qualification messages.

- [ ] **Step 6: Create Wave 1 worker worktrees**

Run from the repository root:

```bash
git worktree add .worktrees/history-storage -b feature/history-storage feature/zcode-job-logs
git worktree add .worktrees/history-status -b feature/history-status feature/zcode-job-logs
git worktree add .worktrees/history-docs -b feature/history-docs feature/zcode-job-logs
```

Expected: three isolated clean worktrees at the same integration commit.

## Task 1: Deep job-log module

**Owner:** Wave 1 storage worker

**Files:**
- Create: `scripts/lib/job-log.mjs`
- Create: `tests/job-log.test.mjs`

- [ ] **Step 1: Write failing exact-path and private-file tests**

Create tests that resolve workspace storage, derive the exact sibling paths, and assert:

```js
const jobId = 'a'.repeat(64);
const logFile = await resolveJobLogFile({ dataRoot, workspace, jobId });
const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
assert.equal(logFile, join(storage.directory, 'jobs', `${jobId}.log`));

const created = await createJobLog({ dataRoot, workspace, jobId, title: 'Rescue' });
assert.equal(created, logFile);
assert.equal((await stat(created)).mode & 0o777, 0o600);
```

Also assert invalid/uppercase/short IDs, a symlinked `jobs` directory, a symlink log leaf, and a replaced file identity reject with stable `PluginError` codes and do not modify the symlink target.

- [ ] **Step 2: Run the new storage tests and observe failure**

Run:

```bash
node --test tests/job-log.test.mjs
```

Expected: FAIL because `scripts/lib/job-log.mjs` does not exist.

- [ ] **Step 3: Implement exact resolution and creation**

Export these functions:

```js
export async function resolveJobLogFile({ dataRoot, workspace, jobId }) {}
export async function createJobLog({ dataRoot, workspace, jobId, title }) {}
export async function appendJobLogEvent({ dataRoot, workspace, jobId, event }) {}
export async function appendJobLogBlock({ dataRoot, workspace, jobId, title, body }) {}
export async function createJobLogSink({ dataRoot, workspace, jobId }) {}
```

Use `resolveWorkspaceStorage`, the existing canonical 64-lowercase-hex job ID contract, `ensurePrivateDirectoryWithin`, and handle/path identity checks modeled on result artifacts. Place the log at `join(storage.directory, 'jobs', `${jobId}.log`)`. The first creation uses exclusive/private semantics; reopening an existing log for resume or recovery is allowed only after the same containment, regular-file, owner-permission, and path/handle identity checks pass. Never accept a caller-provided path.

Format output exactly as:

```text
[<RFC3339>] <single normalized event line>

[<RFC3339>] <normalized block title>
<body preserved after accepted-content validation>
```

The async sink factory resolves only after secure creation or verified reopening. It serializes appends, permanently disables itself after its first create/append failure, and returns `{ logFile, appendEvent, appendBlock, flush, close, get disabled() }` without throwing observational write failures to callers. On creation/reopen failure it returns a disabled sink with `logFile: undefined`; callers never need a fallback filesystem path.

- [ ] **Step 4: Add ordering and content-bound tests**

Test concurrent `appendEvent` calls resolve into invocation order within one process, blocks do not merge with adjacent lines, control characters in titles/events are normalized, oversized event/title/body inputs are rejected or bounded by explicit exported constants, and arbitrary bodies are accepted only through `appendBlock` after the caller has selected safe content. Test secure reopening separately so recovery appends rather than truncates an existing log.

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --test tests/job-log.test.mjs tests/windows-compat.test.mjs
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit the storage module**

Run:

```bash
git add scripts/lib/job-log.mjs tests/job-log.test.mjs
git commit -m "feat: add private durable job logs"
```

Expected: one commit containing only the two owned files.

## Task 2: State schema and exact-owner status rendering

**Owner:** Wave 1 status worker

**Files:**
- Modify: `scripts/lib/state.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Modify: `scripts/lib/render.mjs`
- Modify: `tests/state.test.mjs`
- Modify: `tests/render-progress.test.mjs`
- Modify: `tests/job-control.test.mjs` only in the owner-projection test section

- [ ] **Step 1: Write failing state attachment tests**

Add tests for a new state method:

```js
const reserved = await store.reserveJob({ workspace, ...jobInput });
const storage = await resolveWorkspaceStorage({ dataRoot, workspace });
const logFile = join(storage.directory, 'jobs', `${reserved.id}.log`);
const attached = await store.attachJobLog(workspace, reserved.id, logFile);
assert.equal(attached.logFile, logFile);
assert.equal((await store.readJob(workspace, reserved.id)).logFile, logFile);
```

Reject another job's filename, a relative path, a path outside `jobs/`, an uppercase ID, a second different attachment, and attachment after a terminal state. Repeating the identical attachment is idempotent.

- [ ] **Step 2: Write failing render/projection tests**

Add exact assertions:

```js
assert.match(renderOutput({ job: { ...ownedJob, logFile } }), new RegExp(`^Log: ${escapeForRegExp(logFile)}$`, 'm'));
assert.doesNotMatch(renderOutput({ jobs: [{ ...ownedJob, logFile }] }), /Log:/);
assert.doesNotMatch(renderOutput({ job: foreignProjection }), /logFile|Log:/);
```

JSON for an exact same-owner single job may include `logFile`; foreign `--all`, compact lists, terminal result envelopes, and bound Rescue status must omit it. Add an argument-contract assertion that `$zcode:status <id> --log` remains invalid.

- [ ] **Step 3: Run focused tests and observe failures**

Run:

```bash
node --test tests/state.test.mjs tests/render-progress.test.mjs tests/job-control.test.mjs tests/args.test.mjs
```

Expected: FAIL because `attachJobLog` and `Log:` rendering do not exist.

- [ ] **Step 4: Implement exact state validation**

Add `logFile` to the optional persisted job schema, but not to general transition patch fields. Implement:

```js
async attachJobLog(workspace, jobId, logFile) {
  // lock exact workspace state
  // load and validate the exact job
  // require queued/running/cancelling and exact jobs/<jobId>.log path
  // preserve identical existing attachment, reject replacement
  // atomically rewrite the job JSON
}
```

Validation derives the expected absolute path from the canonical workspace storage; it never trusts basename matching alone. Legacy jobs without `logFile` remain valid.

- [ ] **Step 5: Implement owner projection and rendering**

Keep `publicJob`'s foreign branch allowlist unchanged so it cannot expose `logFile`. Same-owner detailed output retains the validated field. In `renderJob`, add the line after timing and before progress:

```js
...(typeof job.logFile === 'string' ? [`Log: ${safePath(job.logFile)}`] : []),
```

Implement `safePath` with existing public-text normalization and a bounded single-line contract; do not render invalid values. Do not add `Log:` to `renderCompactJob`.

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --test tests/state.test.mjs tests/render-progress.test.mjs tests/job-control.test.mjs tests/args.test.mjs
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit state and rendering**

Run:

```bash
git add scripts/lib/state.mjs scripts/zcode-companion.mjs scripts/lib/render.mjs tests/state.test.mjs tests/render-progress.test.mjs tests/job-control.test.mjs
git commit -m "feat: expose owned job log paths"
```

Expected: one commit containing only the listed files.

## Task 3: Documentation and static safety contracts

**Owner:** Wave 1 docs worker

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/manual-uninstall.md`
- Modify: `tests/release-contracts.test.mjs`
- Modify: `tests/plugin-contracts.test.mjs`

- [ ] **Step 1: Write failing documentation-contract tests**

Require English and Chinese docs to state all of these facts:

```text
jobs/<job-id>.log is private durable history
exact-owner detailed status displays Log:
status has no --log option
raw tool output, file content, capabilities, credentials, and raw reasoning remain excluded
logs are retained after uninstall until proven workspace-data erasure
logs and progress are observational, not terminal authority
```

Add a static implementation contract that conversation/session progress code still does not parse raw ZCode log files.

- [ ] **Step 2: Run documentation tests and observe failure**

Run:

```bash
node --test tests/release-contracts.test.mjs tests/plugin-contracts.test.mjs
```

Expected: FAIL because the release documents do not yet describe per-job log parity.

- [ ] **Step 3: Update release and security documentation**

Document the exact co-located layout:

```text
workspaces/<workspace-hash>/jobs/<job-id>.json
workspaces/<workspace-hash>/jobs/<job-id>.log
```

State that detailed owner status displays the absolute private path, compact/foreign views omit it, four previews remain, and no log-reading command is introduced. In `SECURITY.md`, replace the blanket claim that logs never contain assistant text with the narrower approved allowlist: current-turn visible assistant/final text may be stored, while raw tool content/reasoning/capabilities remain forbidden.

- [ ] **Step 4: Run documentation tests**

Run:

```bash
node --test tests/release-contracts.test.mjs tests/plugin-contracts.test.mjs
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit documentation**

Run:

```bash
git add README.md README.zh-CN.md SECURITY.md CHANGELOG.md docs/manual-uninstall.md tests/release-contracts.test.mjs tests/plugin-contracts.test.mjs
git commit -m "docs: describe durable job log history"
```

Expected: one commit containing only documentation and its static contract tests.

## Task 4: Integrate Wave 1 and create the runtime worktree

**Owner:** Root only

**Files:** Integration metadata only.

- [ ] **Step 1: Review each worker diff before integration**

Run:

```bash
git -C .worktrees/history-storage show --stat --oneline HEAD
git -C .worktrees/history-status show --stat --oneline HEAD
git -C .worktrees/history-docs show --stat --oneline HEAD
```

Expected: each commit touches only its assigned files.

- [ ] **Step 2: Cherry-pick Wave 1 commits**

Run from `.worktrees/progress-history`:

```bash
git cherry-pick <history-storage-sha>
git cherry-pick <history-status-sha>
git cherry-pick <history-docs-sha>
```

Expected: clean cherry-picks. Resolve no semantic conflict by dropping a worker's requirements.

- [ ] **Step 3: Run the combined Wave 1 tests**

Run:

```bash
node --test tests/job-log.test.mjs tests/state.test.mjs tests/render-progress.test.mjs tests/job-control.test.mjs tests/args.test.mjs tests/release-contracts.test.mjs tests/plugin-contracts.test.mjs
```

Expected: all selected tests pass.

- [ ] **Step 4: Create the Wave 2 runtime worktree**

Run from the repository root:

```bash
git worktree add .worktrees/history-runtime -b feature/history-runtime feature/zcode-job-logs
```

Expected: runtime worker starts from the integrated Wave 1 commit.

## Task 5: Independent progress archive sink

**Owner:** Wave 2 runtime worker

**Files:**
- Modify: `scripts/lib/progress.mjs`
- Modify: `tests/progress.test.mjs`

- [ ] **Step 1: Write failing archive-sink tests**

Instantiate `createProgressReporter` with independent sinks:

```js
const reporter = createProgressReporter({
  sessionId: 'session-a',
  write: (line) => writer.push(line),
  persist: (event) => previews.push(event.message),
  archive: (event) => archived.push(event.message),
  relay: (record) => relays.push(record),
  now: () => observedAt,
});
```

Assert archive receives every dispatched safe event in order even after more than four preview events. A throwing/rejecting archive disables only archive; writer, preview persistence, relay, flush, terminal dispatch, and close remain correct. A stalled archive is bounded by the existing flush deadline and cannot hold terminal completion.

- [ ] **Step 2: Run the archive tests and observe failure**

Run:

```bash
node --test --test-name-pattern='archive' tests/progress.test.mjs
```

Expected: FAIL because `archive` is not a supported reporter option.

- [ ] **Step 3: Implement the independent bounded archive queue**

Add `archive` beside `persist`, with its own:

```js
archivePending
archiveInFlight
archiveEpoch
archiveDisabled
enqueueArchive(entry)
startArchive(entry)
drainArchive()
disableArchive()
```

Dispatch writer, preview persistence, archive, and relay independently:

```js
enqueueWriter(event, sequence);
enqueuePersist(event, sequence);
enqueueArchive(event, sequence);
if (relaySource !== 'none') relayEvent(event, relaySource);
```

Use the existing bounded pending-event policy and include archive draining in `flush`. Archive failures produce one fixed `archive-disabled` diagnostic for other healthy sinks without exposing the exception.

- [ ] **Step 4: Run progress tests**

Run:

```bash
node --test tests/progress.test.mjs
```

Expected: all progress tests pass.

- [ ] **Step 5: Commit the progress sink**

Run:

```bash
git add scripts/lib/progress.mjs tests/progress.test.mjs
git commit -m "feat: archive safe progress independently"
```

Expected: one commit containing only progress reporter files.

## Task 6: Execution, terminal, recovery, and Transfer integration

**Owner:** Same Wave 2 runtime worker after Task 5

**Files:**
- Modify: `scripts/lib/review.mjs`
- Modify: `scripts/lib/recovery.mjs`
- Modify: `scripts/lib/transfer.mjs`
- Modify: `tests/job-control.test.mjs`
- Modify: `tests/recovery.test.mjs`
- Modify: `tests/transfer.test.mjs`
- Modify: `tests/integration/companion.test.mjs`

- [ ] **Step 1: Write failing foreground integration tests**

For a real fake-peer foreground Rescue, assert:

```js
assert.equal(job.logFile, join(workspaceStorage.directory, 'jobs', `${job.id}.log`));
const log = await readFile(job.logFile, 'utf8');
assert.match(log, /ZCode started the delegated turn\./);
assert.match(log, /Running command: npm test\./);
assert.match(log, /Assistant message\n.*final result/s);
assert.match(log, /Final output\n.*final result/s);
assert.doesNotMatch(log, /RAW_TOOL_OUTPUT|PRIVATE_REASONING|CAPABILITY_TOKEN/);
```

Send at least six distinct safe progress events and assert all six are in the log while status retains only the final four previews.

- [ ] **Step 2: Write failing failure-isolation tests**

Inject a job-log sink whose create or append rejects. Assert `executeJob` still returns the authoritative result, persists the result artifact, and terminalizes the job successfully. Assert a result-artifact failure still fails/recoverably retains the job even when the log succeeded.

- [ ] **Step 3: Write failing recovery and Transfer tests**

For recovered success, assert the recovered authoritative result is appended once as `Final output` only after the durable success winner. For Transfer, assert the log is attached and contains the Transfer final output but no fabricated `Assistant message`. Cancellation/failure winners must not receive a success block.

- [ ] **Step 4: Run focused tests and observe failure**

Run:

```bash
node --test tests/job-control.test.mjs tests/recovery.test.mjs tests/transfer.test.mjs tests/integration/companion.test.mjs
```

Expected: FAIL because execution paths do not create or append logs.

- [ ] **Step 5: Attach a log sink in execution paths**

In `executeJob`, create the sink before progress reporter construction and attach only a successfully created exact path:

```js
const jobLog = await createJobLogSink({ dataRoot, workspace, jobId: job.id });
if (jobLog.logFile) running = await input.store.attachJobLog(workspace, job.id, jobLog.logFile);
```

Pass `archive: jobLog.appendEvent` to `createProgressReporter`. Flush the job-log sink within the existing optional progress deadline; never let it extend terminal authority.

After `extractTerminalResultForStatus` succeeds, append the already-selected result as `Assistant message`. After `publishSuccessfulResult` returns a durable success winner, append `Final output` using `output.result`. Do not scan snapshot parts a second time and do not read reasoning/tool parts.

- [ ] **Step 6: Integrate recovery and Transfer**

Use the same module and exact state attachment. Recovery appends `Final output` only after `finishRecoveredResult` returns a succeeded winner. Transfer appends only its successful `Final output`. Every append is observational and must not replace the existing winner/race logic.

- [ ] **Step 7: Run runtime tests**

Run:

```bash
node --test tests/progress.test.mjs tests/job-log.test.mjs tests/job-control.test.mjs tests/recovery.test.mjs tests/transfer.test.mjs tests/integration/companion.test.mjs
```

Expected: all selected tests pass.

- [ ] **Step 8: Commit runtime integration**

Run:

```bash
git add scripts/lib/review.mjs scripts/lib/recovery.mjs scripts/lib/transfer.mjs tests/job-control.test.mjs tests/recovery.test.mjs tests/transfer.test.mjs tests/integration/companion.test.mjs
git commit -m "feat: persist safe job execution history"
```

Expected: one commit containing only runtime integration files.

## Task 7: Integrate Wave 2 and refresh marketplace payload

**Owner:** Root only

**Files:** Generated `marketplace/plugins/zcode/**` mirror as determined by the established builder.

- [ ] **Step 1: Review and cherry-pick Wave 2**

Run:

```bash
git -C .worktrees/history-runtime show --stat --oneline HEAD~1..HEAD
git cherry-pick <history-runtime-progress-sha>
git cherry-pick <history-runtime-execution-sha>
```

Expected: clean integration with only the planned files.

- [ ] **Step 2: Run all focused feature tests**

Run:

```bash
node --test tests/job-log.test.mjs tests/progress.test.mjs tests/state.test.mjs tests/render-progress.test.mjs tests/job-control.test.mjs tests/recovery.test.mjs tests/transfer.test.mjs tests/integration/companion.test.mjs tests/release-contracts.test.mjs tests/plugin-contracts.test.mjs
```

Expected: all selected tests pass.

- [ ] **Step 3: Discover and run the repository's marketplace refresh command**

Read `package.json` and the marketplace snapshot tests, then run the existing declared build/sync command exactly. Do not hand-copy files. Expected: source and `marketplace/plugins/zcode` critical files are byte-identical under existing snapshot contracts.

- [ ] **Step 4: Run mirror and layout tests**

Run:

```bash
node --test tests/marketplace-snapshot.test.mjs tests/integration/plugin-layout.test.mjs tests/integration/package-install.test.mjs
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit generated parity**

Run:

```bash
git add marketplace/plugins/zcode
git commit -m "build: sync durable job log runtime"
```

Expected: generated marketplace changes only.

## Task 8: Two-stage review and complete verification

**Owner:** Root coordinating fresh review subagents

**Files:** Review only unless a reviewer identifies a required fix.

- [ ] **Step 1: Dispatch a spec-compliance reviewer**

Give the reviewer the complete approved spec text, the base commit, and the feature HEAD. Require a requirement-by-requirement report covering storage layout, owner projection, no new status grammar, safety exclusions, failure isolation, recovery, docs, and tests.

Expected: `APPROVED` or a concrete list of missing/extra behavior. The original owning implementer fixes every gap, and the same reviewer rechecks until approved.

- [ ] **Step 2: Dispatch a code-quality reviewer**

After spec approval, review the complete diff for storage safety, symlink/file-identity races, lock/append ordering, unbounded memory/disk amplification, terminal-winner interference, owner leakage, cross-platform behavior, and test quality.

Expected: `APPROVED` or actionable findings. The owning implementer fixes findings, then the reviewer rechecks until approved.

- [ ] **Step 3: Run diff hygiene checks**

Run:

```bash
git diff --check origin/main...HEAD
git status --short
```

Expected: no whitespace errors and a clean worktree.

- [ ] **Step 4: Run the complete suite**

Run:

```bash
npm test
```

Expected: exit 0; authenticated opt-in suites may retain only their documented skips.

- [ ] **Step 5: Inspect the final diff and commits**

Run:

```bash
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git diff --name-status origin/main...HEAD
```

Expected: only spec, plan, implementation, tests, docs, and generated marketplace files described above.

## Task 9: Push, create PR, and drive CI to green

**Owner:** Root only

**Files:** No additional source changes unless CI exposes a verified defect.

- [ ] **Step 1: Rebase once more before publication**

Run:

```bash
git fetch origin --prune
git rebase origin/main
npm test
```

Expected: clean rebase and full suite exit 0.

- [ ] **Step 2: Push the feature branch**

Run:

```bash
git push -u origin feature/zcode-job-logs
```

Expected: remote branch created or updated without force unless the rebase requires `--force-with-lease` and Root has first verified the remote branch is session-owned.

- [ ] **Step 3: Create the pull request**

Run:

```bash
gh pr create --base main --head feature/zcode-job-logs --title "feat: add durable private job logs" --body-file <prepared-pr-body.md>
```

The PR body must summarize behavior, privacy exclusions, exact status compatibility, worktree/parallel development, test evidence, and rollout risk. Expected: one PR URL.

- [ ] **Step 4: Watch CI**

Run:

```bash
gh pr checks --watch --fail-fast=false
```

Expected: all required checks pass.

- [ ] **Step 5: Diagnose and fix CI failures**

For each failed check, inspect the exact log with `gh run view`/`gh run watch`, reproduce locally, use `superpowers:systematic-debugging`, add or correct a regression test first, implement the minimal fix, rerun the focused and full suites, obtain spec/code-quality re-review for material changes, commit, and push.

Expected: no speculative retries and no weakening of tests or security contracts.

- [ ] **Step 6: Confirm final green state**

Run:

```bash
gh pr view --json url,state,mergeStateStatus,statusCheckRollup
```

Expected: PR remains open with merge-ready status and every required CI check successful. Report the PR URL, final commit, test totals, and CI result to the user.
