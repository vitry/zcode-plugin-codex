# Rescue Progress and Foreground Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make delegated ZCode work visibly alive, inspectable through `$zcode:status`, and durably cancelled when a foreground invocation is interrupted.

**Architecture:** Normalize the existing same-session `state.updated` notification stream into bounded public progress events, then feed a reporter with foreground stderr and durable-state sinks. Add an abort path at the executable boundary which stops the owned ZCode session and settles the existing job state machine without changing background semantics.

**Tech Stack:** Node.js 22.13+ ESM, `node:test`, ZCode 0.16.1 JSON-lines app-server protocol, existing private state store and advisory locks.

---

## File Map

- Create `scripts/lib/progress.mjs`: notification normalization, deduplicated reporting, heartbeat lifecycle, and abort-aware completion helper.
- Modify `scripts/lib/state.mjs`: schema-validated `updateJobProgress` operation and persisted progress fields.
- Modify `scripts/lib/review.mjs`: subscribe an active job to progress, drain it before finalization, and settle interruption through the cancellation lock.
- Modify `scripts/zcode-companion.mjs`: pass foreground progress/abort dependencies and map process signals to conventional exit codes.
- Modify `scripts/lib/render.mjs`: detailed status rendering and compact list summaries.
- Modify `tests/fixtures/fake-zcode-cli.mjs`: optionally emit safe intermediate notifications.
- Create `tests/progress.test.mjs`: progress normalizer, reporter, heartbeat, and abort helper unit tests.
- Modify `tests/state.test.mjs`: durable progress schema and terminal-race tests.
- Modify `tests/job-control.test.mjs`: executor subscription and interruption tests.
- Modify `tests/integration/companion.test.mjs`: real CLI progress and status integration tests.
- Modify `README.md`, `README.zh-CN.md`, and `CHANGELOG.md`: user-visible behavior and cancellation boundary.

### Task 1: Safe Progress Event Boundary

**Files:**
- Create: `scripts/lib/progress.mjs`
- Create: `tests/progress.test.mjs`

- [ ] **Step 1: Write failing notification-normalization tests**

Cover a same-session known reason, terminal reason, unknown reason, cross-session event, non-session scope, control character, oversized reason, and arbitrary secret-bearing patch. Assert that no patch content or unknown raw reason is returned.

```js
test('normalizes only bounded same-session activity without exposing patch data', () => {
  const known = normalizeZCodeProgress(notification('tool_call_started'), 'session-a', now);
  assert.deepEqual(known, {
    phase: 'running',
    message: 'ZCode started a tool call.',
    observedAt: now,
  });
  assert.equal(
    normalizeZCodeProgress(notification('future_secret_reason', { apiKey: 'never' }), 'session-a', now).message,
    'ZCode reported activity.',
  );
  assert.equal(normalizeZCodeProgress(notification('tool_call_started'), 'session-b', now), null);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/progress.test.mjs`

Expected: FAIL because `scripts/lib/progress.mjs` does not exist.

- [ ] **Step 3: Implement the bounded normalizer**

Export `PROGRESS_PHASES`, `normalizeZCodeProgress`, and constants for four preview entries, 256 message bytes, and a 20-second heartbeat. Use fixed mappings for known reasons and a generic fixed message for unknown safe reasons. Reject non-object frames, wrong method/scope/session, empty/oversized reason, C0/C1 controls, and invalid timestamps.

```js
const KNOWN = new Map([
  ['prompt_started', ['starting', 'ZCode started the delegated turn.']],
  ['model_streaming', ['running', 'ZCode is generating a response.']],
  ['tool_call_started', ['running', 'ZCode started a tool call.']],
  ['tool_call_progress', ['running', 'ZCode tool work is still running.']],
  ['tool_call_result', ['running', 'ZCode completed a tool call.']],
  ['api_retry', ['waiting', 'ZCode is retrying the model request.']],
  ['prompt_completed', ['finalizing', 'ZCode completed the delegated turn.']],
  ['prompt_failed', ['finalizing', 'ZCode reported a failed delegated turn.']],
]);
```

- [ ] **Step 4: Add reporter and heartbeat tests, then verify RED**

Use injected `write`, `persist`, `setInterval`, `clearInterval`, and `now` functions. Assert immediate `[zcode]` lines, duplicate suppression, serialized persistence, 20-second heartbeat text, no heartbeat persistence, and idempotent `close()`.

Run: `node --test tests/progress.test.mjs`

Expected: normalization tests PASS; reporter tests FAIL because `createProgressReporter` is missing.

- [ ] **Step 5: Implement the reporter minimally**

Export `createProgressReporter({ sessionId, write, persist, now, setInterval, clearInterval })` returning `{ observe, flush, close }`. `observe(message)` normalizes, deduplicates consecutive `(phase,message)` pairs, writes synchronously when a writer exists, and appends persistence work to one promise chain. `close()` clears its unref-capable heartbeat and `flush()` awaits the persistence chain.

- [ ] **Step 6: Verify GREEN and commit**

Run: `node --test tests/progress.test.mjs`

Expected: all progress tests PASS with no warnings.

Commit: `feat: add safe zcode progress reporting`

### Task 2: Durable Progress and Status Rendering

**Files:**
- Modify: `scripts/lib/state.mjs`
- Modify: `scripts/lib/render.mjs`
- Modify: `tests/state.test.mjs`
- Create: `tests/render-progress.test.mjs`

- [ ] **Step 1: Write failing durable-state tests**

Add tests proving that `updateJobProgress(workspace, jobId, event)`:

- updates only running/cancelling jobs;
- keeps the newest four messages;
- updates `phase`, `lastActivityAt`, and monotonic `updatedAt`;
- deduplicates an identical final preview entry;
- returns a terminal job unchanged when completion wins;
- rejects unknown phases, invalid timestamps, more than 256 UTF-8 bytes, controls, arrays, and extra fields.

```js
const progressed = await store.updateJobProgress(workspace, running.id, {
  phase: 'running',
  message: 'ZCode started a tool call.',
  observedAt: new Date().toISOString(),
});
assert.equal(progressed.phase, 'running');
assert.deepEqual(progressed.progressPreview, ['ZCode started a tool call.']);
```

- [ ] **Step 2: Run state tests and verify RED**

Run: `node --test tests/state.test.mjs`

Expected: FAIL because `updateJobProgress` is undefined.

- [ ] **Step 3: Implement progress persistence and schema validation**

Add `phase`, `lastActivityAt`, and `progressPreview` to the strict job schema. Implement `updateJobProgress` under the existing workspace state lock. Read and validate the current job, no-op for terminal/queued jobs, cap the preview at four, atomically rewrite the job, and never modify lifecycle identity fields.

- [ ] **Step 4: Verify state tests GREEN**

Run: `node --test tests/state.test.mjs`

Expected: all state tests PASS.

- [ ] **Step 5: Write failing status-rendering tests**

Test a detailed active job and an `--all` list. Require status, phase, timestamps, elapsed/duration, last activity, and each preview line. Require the compact list to contain only the latest preview. Ensure Markdown/control injection is escaped or rejected at state ingress.

- [ ] **Step 6: Implement status rendering**

Keep result rendering unchanged. Replace the one-line `value.job` branch with a bounded human-readable report and enrich the `value.jobs` branch with phase/latest activity. Compute elapsed/duration at render time from persisted ISO timestamps. Preserve `renderOutput(..., { json: true })` and redaction behavior.

- [ ] **Step 7: Verify GREEN and commit**

Run: `node --test tests/state.test.mjs tests/render-progress.test.mjs`

Expected: all focused tests PASS.

Commit: `feat: persist and render zcode job progress`

### Task 3: Wire ZCode Notifications Into Active Jobs

**Files:**
- Modify: `scripts/lib/review.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Modify: `tests/fixtures/fake-zcode-cli.mjs`
- Modify: `tests/job-control.test.mjs`
- Modify: `tests/integration/companion.test.mjs`

- [ ] **Step 1: Write failing executor tests**

Provide a client stub whose `subscribe` captures a handler. During `waitForCompletion`, deliver intermediate same-session and sibling-session notifications. Assert that only the same-session event reaches the injected writer and `store.updateJobProgress`, that reporter persistence drains before the succeeded transition, and that unsubscribe/heartbeat cleanup occurs on success and failure.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test tests/job-control.test.mjs`

Expected: FAIL because `executeJob` does not subscribe or accept progress dependencies.

- [ ] **Step 3: Integrate the reporter at the accepted-turn boundary**

Extend `executeJob` with optional `progressWriter`, `progressDependencies`, and `signal`. After the running job is persisted and before `client.send`, create a reporter bound to the returned ZCode session, subscribe it to protocol notifications, and emit a fixed starting event. In `finally`, unsubscribe, close, flush, and then close the client. Pass the writer only from foreground `main`; direct module calls and background workers stay quiet.

- [ ] **Step 4: Add fake-peer intermediate events and integration RED test**

When `FAKE_ZCODE_PROGRESS=1`, emit `model_streaming`, `tool_call_started`, and `tool_call_result` notifications with increasing revisions before the terminal notification. Spawn the real companion foreground path, assert `[zcode]` lines on stderr and final result on stdout, then query status JSON and assert the persisted phase/activity/preview.

- [ ] **Step 5: Pass foreground writer dependencies and verify GREEN**

Thread `progressWriter` and the reporter's injected timer/clock dependencies from
`main` through `runDirectInvocation`, `runCompanion`, `executeWithWorkerLease`,
and `executeJob`. Do not derive foreground/background state inside the progress
module; the executable boundary supplies a writer only for a foreground process.

Run: `node --test tests/progress.test.mjs tests/state.test.mjs tests/job-control.test.mjs tests/integration/companion.test.mjs`

Expected: all focused tests PASS with no unhandled rejections.

- [ ] **Step 6: Commit**

Commit: `feat: surface live zcode task activity`

### Task 4: Foreground Signal Cancellation

**Files:**
- Create: `scripts/lib/signals.mjs`
- Modify: `scripts/lib/progress.mjs`
- Modify: `scripts/lib/review.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Create: `tests/signals.test.mjs`
- Modify: `tests/job-control.test.mjs`
- Modify: `tests/integration/companion.test.mjs`

- [ ] **Step 1: Write failing signal-controller tests**

With an injected EventEmitter-like process, assert that foreground installation registers one `SIGINT` and one `SIGTERM` listener, the first signal aborts with a `JOB_INTERRUPTED` `PluginError` carrying exit code 130 or 143, repeated signals do not duplicate work, cleanup removes listeners, and background mode installs none.

- [ ] **Step 2: Run signal tests and verify RED**

Run: `node --test tests/signals.test.mjs`

Expected: FAIL because `scripts/lib/signals.mjs` does not exist.

- [ ] **Step 3: Implement temporary signal handling and abort-aware wait**

Export `createForegroundSignalController` and `waitForCompletionOrAbort`. The controller owns an `AbortController`, records the first conventional exit code, and removes handlers in `finally`. The wait helper races the existing completion promise with the abort signal while keeping rejection handlers attached.

Call `signal.throwIfAborted()` at safe setup boundaries before discovery, before
session creation/resume, and before send. An already-running bounded RPC retains
its existing request timeout; the next boundary observes the interruption.

- [ ] **Step 4: Write failing interruption lifecycle tests**

Abort after accepted send and assert one `stopSession`, durable `running -> cancelling -> cancelled`, `finishedAt`, and no result artifact. Add a stop-failure case asserting the job returns to `running` with `lastCancelError`. Add a completion-wins race asserting success is not overwritten.

- [ ] **Step 5: Implement cancellation under the existing cancellation lock**

In `executeJob`, distinguish interruption from ordinary failure. Under `withJobCancellationLock`, stop the exact `zcodeSessionId`; after acknowledgement transition to cancelled. On stop failure, restore running with a bounded error and rethrow the interruption. Do not run the ordinary failure terminalization for this branch.

In `main`, install handlers only when not setup and not `ZCODE_BACKGROUND_WORKER=1`, pass the signal through, emit a concise stderr interruption message, suppress the normal JSON error envelope for `JOB_INTERRUPTED`, and set `process.exitCode` to the captured 130/143.

- [ ] **Step 6: Verify signal integration GREEN**

Run: `node --test tests/signals.test.mjs tests/job-control.test.mjs tests/integration/companion.test.mjs`

Expected: all focused tests PASS; spawned foreground interruption exits 130, acknowledges stop, and leaves no running job.

- [ ] **Step 7: Commit**

Commit: `fix: cancel foreground zcode jobs on interrupt`

### Task 5: Documentation and Full Qualification

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `CHANGELOG.md`
- Modify: relevant contract tests if documentation wording is asserted

- [ ] **Step 1: Write or update failing documentation contract tests**

Require both READMEs to document foreground activity, 20-second heartbeat, status previews, explicit background cancellation, and the `session/stop` boundary. Require the changelog to mention the behavior change without changing the package version.

- [ ] **Step 2: Run contract tests and verify RED**

Run: `node --test tests/release-contracts.test.mjs tests/plugin-contracts.test.mjs`

Expected: FAIL on missing documentation text.

- [ ] **Step 3: Update English/Chinese documentation and changelog**

Document visible examples without claiming that this plugin can kill arbitrary detached grandchildren created by nested tools. Keep all command syntax and ownership rules unchanged.

- [ ] **Step 4: Run focused tests GREEN**

Run: `node --test tests/release-contracts.test.mjs tests/plugin-contracts.test.mjs`

Expected: all focused tests PASS.

- [ ] **Step 5: Run complete verification**

Run: `npm run lint`

Expected: exit 0, no lint errors.

Run: `npm run typecheck`

Expected: exit 0, no TypeScript diagnostics.

Run: `npm test`

Expected: exit 0, no failed tests; authenticated real E2E tests may remain explicitly skipped unless their opt-in environment variables are present.

Run: `npm run test:qualified`

Expected: exit 0; qualification tests either pass or report only their documented opt-in skips.

Run: `git diff --check`

Expected: no output and exit 0.

- [ ] **Step 6: Commit**

Commit: `docs: explain zcode progress and interruption behavior`

## Final Review

After all five tasks:

1. Dispatch a spec-compliance reviewer against
   `docs/superpowers/specs/2026-08-08-rescue-progress-lifecycle-design.md`.
2. Resolve every missing or extra behavior and request re-review.
3. Dispatch an independent code-quality reviewer over the full branch diff.
4. Resolve every Critical or Important issue and request re-review.
5. Re-run `npm run check` and `git diff --check` immediately before reporting completion.
