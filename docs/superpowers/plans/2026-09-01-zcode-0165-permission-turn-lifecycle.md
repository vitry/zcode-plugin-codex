# ZCode 0.16.5 Permission Turn Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the active protocol turn across an admission-time legacy completion wake so later ZCode permission requests succeed, then release the local turn at the executor's authoritative cleanup boundary.

**Architecture:** Add a non-destructive completion observer alongside the existing destructive waiter in the protocol/client layer. Migrate only `executeJob` to that observer and explicitly release its local turn during unconditional teardown; retain compatibility fallbacks for injected test clients that expose only the historical interface.

**Tech Stack:** Node.js 22.13, ECMAScript modules, `node:test`, the existing JSON-RPC protocol client and job executor.

---

## File map

- Modify `scripts/lib/zcode-protocol.mjs`: share completion validation/wait registration while distinguishing destructive consumption from observation; add local turn release behavior.
- Modify `scripts/lib/zcode-client.mjs`: expose `observeCompletion()` and `releaseTurn()` without changing `waitForCompletion()`.
- Modify `scripts/lib/review.mjs`: use non-destructive observation for `legacyWake` and release the local turn during teardown.
- Modify `tests/process-zcode.test.mjs`: cover low-level observer, permission, timeout, release, and destructive-wait invariants.
- Modify `tests/job-control.test.mjs`: cover captured 0.16.5 executor ordering and success/error cleanup.

### Task 1: Add non-destructive completion observation

**Files:**
- Modify: `scripts/lib/zcode-protocol.mjs:95-145`
- Modify: `scripts/lib/zcode-client.mjs:125-135`
- Test: `tests/process-zcode.test.mjs`

- [ ] **Step 1: Write failing protocol tests**

Add tests that construct `ZCodeProtocolClient` with `PassThrough` streams, arm a turn, start `observeCompletion(sessionId)`, emit a matching `prompt_completed`, and assert:

```js
const completion = protocol.observeCompletion(sessionId);
protocol.handleLine(JSON.stringify({ method: 'state.updated', params: matchingCompletion }));
assert.equal((await completion).reason, 'prompt_completed');
assert.equal(protocol.turnState(sessionId), 'armed');
```

Then emit `interaction/requestPermission` for the same session, return an offered allow response from the handler, and verify the protocol writes the allow result instead of `ZCODE_PERMISSION_SESSION_INVALID`. Add companion assertions that `waitForCompletion()` still clears the turn, observer timeout leaves it armed, and `releaseTurn()` clears it and rejects any still-pending observer.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test --test-name-pattern='non-destructive completion|completion observer|destructive completion' tests/process-zcode.test.mjs
```

Expected: FAIL because `observeCompletion` and `releaseTurn` do not exist.

- [ ] **Step 3: Implement the minimal protocol behavior**

Refactor the current waiter registration into one internal path with an explicit consumption mode. Preserve the public destructive path exactly, and add:

```js
observeCompletion(sessionId, timeoutMs) {
  return this.waitForCompletionMode(sessionId, timeoutMs, false);
}

releaseTurn(sessionId) {
  if (!nonEmpty(sessionId)) throw protocolInputError();
  this.cancelTurn(sessionId, localTurnReleasedError(sessionId));
}
```

For observation mode, peek at an already queued completion rather than shifting it, do not call `abortTurn()` on resolution or timeout, and always unregister the observer. For destructive mode, keep the current shift, timeout cleanup, and `abortTurn()` behavior. Continue enforcing one waiter/observer per session with `waiterSessions`.

Expose the two operations from `ZCodeClient` with normal session-ID validation/documentation:

```js
observeCompletion(sessionId, timeoutMs) {
  requireSessionId(sessionId);
  return this.protocol.observeCompletion(sessionId, timeoutMs);
}

releaseTurn(sessionId) {
  requireSessionId(sessionId);
  this.protocol.releaseTurn(sessionId);
}
```

- [ ] **Step 4: Run focused and adjacent tests and verify GREEN**

Run:

```bash
node --test tests/process-zcode.test.mjs tests/zcode-client.test.mjs
```

Expected: PASS, including all existing destructive completion and permission tests.

- [ ] **Step 5: Self-review and commit**

Check that no existing call site changed and that observer cleanup cannot retain a timer, subscriber, or waiter-session entry. Then commit:

```bash
git add scripts/lib/zcode-protocol.mjs scripts/lib/zcode-client.mjs tests/process-zcode.test.mjs
git commit -m "fix: observe legacy completion without ending turn"
```

### Task 2: Migrate executor wake and own local cleanup

**Files:**
- Modify: `scripts/lib/review.mjs:220-360`
- Test: `tests/job-control.test.mjs`

- [ ] **Step 1: Write the captured-ordering regression test**

Extend the existing `0.16.5 foreground execution treats legacy completion as admission` fixture client with `observeCompletion`, `releaseTurn`, and a permission handler capture. Make `observeCompletion` publish the legacy wake first, then invoke the captured permission handler with a medium-risk Write request offering allow/deny. Assert the handler returns allow while the executor remains running, then publish the v4 authoritative terminal and assert success plus one local release:

```js
assert.deepEqual(permissionDecision, { decision: 'allow' });
assert.equal(releaseTurnCalls, 1);
assert.equal(releasedSessionId, sessionId);
```

Add an error-path test where observation or authoritative reconciliation fails after admission; assert `releaseTurn(sessionId)` still runs once before `close()`.

- [ ] **Step 2: Run the executor regressions and verify RED**

Run:

```bash
node --test --test-name-pattern='0.16.5 foreground execution|releases local turn' tests/job-control.test.mjs
```

Expected: FAIL because `executeJob` still calls destructive `waitForCompletion()` and never releases the local turn explicitly.

- [ ] **Step 3: Implement the executor migration**

Construct `legacyWake` from `client.observeCompletion(activeSessionId)` when available. Keep a fallback to `client.waitForCompletion(activeSessionId)` only for existing injected test doubles that predate the internal interface:

```js
const observeLegacyCompletion = typeof client.observeCompletion === 'function'
  ? client.observeCompletion.bind(client)
  : client.waitForCompletion.bind(client);
const legacyWake = waitForCompletionOrAbort(observeLegacyCompletion(activeSessionId), input.signal);
```

In unconditional teardown, after all terminal/cancellation/error reconciliation and progress cleanup but before `client.close()`, release the known local session exactly once when supported:

```js
try {
  if (sessionId && typeof client.releaseTurn === 'function') client.releaseTurn(sessionId);
} catch (cleanupError) {
  if (!primaryError) primaryError = cleanupError;
}
```

Preserve the primary-error and cleanup-error conventions already used by the executor. Do not send an upstream stop from this release path and do not modify `decidePermission`.

- [ ] **Step 4: Run focused and executor-adjacent tests and verify GREEN**

Run:

```bash
node --test tests/job-control.test.mjs tests/integration/companion.test.mjs
```

Expected: PASS with the captured ordering, cleanup tests, and existing cancellation behavior unchanged.

- [ ] **Step 5: Self-review and commit**

Inspect the diff for exactly one production caller migration, one unconditional local cleanup, and no permission-policy changes. Then commit:

```bash
git add scripts/lib/review.mjs tests/job-control.test.mjs
git commit -m "fix: retain active turn through legacy wake"
```

### Task 3: Verify contracts and release readiness

**Files:**
- Modify if required by generated parity checks: checked-in marketplace mirrors only through the repository's existing builder
- Test: repository-wide verification

- [ ] **Step 1: Run permission-policy and protocol contract tests**

Run:

```bash
node --test --test-name-pattern='permission|completion' tests/process-zcode.test.mjs tests/zcode-client.test.mjs tests/job-control.test.mjs
```

Expected: PASS; Rescue permission decisions remain unchanged and destructive completion callers retain their contract.

- [ ] **Step 2: Run the full repository check**

Run:

```bash
npm run check
```

Expected: PASS for line endings, lint, typecheck, all tests, qualification tests, and marketplace parity/build checks.

- [ ] **Step 3: Inspect final scope**

Run:

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- scripts/lib/review.mjs scripts/lib/zcode-client.mjs scripts/lib/zcode-protocol.mjs
```

Expected: no whitespace errors; changes remain limited to the completion lifecycle, tests, and approved docs.

- [ ] **Step 4: Commit any verification-only generated parity update**

If and only if the repository's official check regenerates tracked marketplace parity files, review and commit those exact generated changes:

```bash
git add marketplace
git commit -m "build: refresh marketplace snapshot"
```

If there are no generated tracked changes, skip this commit.
