# ZCode 0.16.5 True Turn Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Rescue/review execution wait for the real ZCode runtime turn terminal under 0.16.5 while retaining compatibility with earlier versions and additive upstream fields.

**Architecture:** Treat v4 `turnHeader` lifecycle as the preferred terminal signal, then verify the current turn through a shared snapshot classifier. Use legacy `prompt_completed` only to start snapshot fallback. Foreground, recovery, and cancellation reuse the same classifier, while all upstream response validators accept unused additive fields.

**Tech Stack:** Node.js ESM, built-in `node:test`, ZCode JSON-RPC app-server protocol, existing state/CAS and broker abstractions.

---

### Task 1: Open-world upstream response compatibility

**Files:**
- Modify: `scripts/lib/zcode-client.mjs`
- Modify: `scripts/zcode-broker.mjs`
- Modify: `scripts/lib/conversation-progress.mjs`
- Test: `tests/zcode-client.test.mjs`
- Test: existing managed-broker protocol tests selected by implementation
- Test: `tests/conversation-progress.test.mjs`

- [ ] **Step 1: Write failing acknowledgement tests**

Add tests showing direct and managed-broker `subscribeConversation()` accept an acknowledgement containing valid consumed fields plus nested `openTiming` and unrelated future metadata, while still rejecting missing or malformed `subscriptionId`, `mode`, and `logEpoch`. Show that direct and managed-broker `unsubscribeConversation()` accept any bounded plain-object result, ignore additive fields, and still reject a malformed non-object response.

- [ ] **Step 2: Run the acknowledgement tests and verify RED**

Run: `node --test tests/zcode-client.test.mjs --test-name-pattern='subscribe.*additive|subscribe.*consumed'`

Expected: the additive-field case fails with `ZCODE_OUTPUT_INVALID`; malformed consumed-field cases retain their current failures.

- [ ] **Step 3: Implement projection-based acknowledgement validation**

Replace exact-key equality with validation of only the consumed fields, and validate unsubscribe as a bounded plain object without requiring it to be empty:

```js
const ack = result?.ack;
if (!plainObject(ack)
  || !isBoundedPublicIdentifier(ack.subscriptionId)
  || !['snapshot', 'resume'].includes(ack.mode)
  || !isBoundedPublicIdentifier(ack.logEpoch)) throw outputError('v4/conversation/subscribe');
```

Retain the existing safe JSON/frame bounds below the client transport.

- [ ] **Step 4: Write failing additive-frame tests**

Add a captured-frame test with harmless extra fields on the outer notification, params, frame, payload, delta, and recognized row. Assert the same progress events are produced and none of the extra values are exposed.

- [ ] **Step 5: Run the frame test and verify RED**

Run: `node --test tests/conversation-progress.test.mjs --test-name-pattern='additive upstream fields'`

Expected: failure from the current `exactKeys` checks.

- [ ] **Step 6: Implement open-world frame validation**

Change upstream-owned object checks from exact key sets to required consumed-field checks. Continue to validate wire version, topic/subscription identity, sequence continuity, row kind/state/status, identifiers, timestamps, JSON depth/node/byte limits, and path containment.

Audit the remaining upstream response validators in `zcode-client.mjs` and `zcode-broker.mjs`, including runtime-model update/set responses. Convert only response-side exact-object checks to consumed-field projections; caller input, request, persistence, capability, and CAS shapes remain exact.

- [ ] **Step 7: Run focused tests and commit**

Run: `node --test tests/zcode-client.test.mjs tests/conversation-progress.test.mjs`

Expected: all tests pass.

Commit: `fix: accept additive ZCode protocol fields`

### Task 2: Expose validated v4 turn lifecycle

**Files:**
- Modify: `scripts/lib/conversation-progress.mjs`
- Modify: `scripts/lib/progress.mjs`
- Test: `tests/conversation-progress.test.mjs`
- Test: `tests/progress.test.mjs`

- [ ] **Step 1: Write failing lifecycle tests**

Define the desired observer contract:

```js
const terminal = observer.waitForTurnTerminal();
observer.beginTurnBoundary();
await observer.observe(turnRow({ rowId: 101, state: 'running' }), observedAt);
await observer.observe(turnRow({ rowId: 101, state: 'completedSuccess' }), observedAt);
assert.deepEqual(await terminal, { kind: 'succeeded', turnId: 'turn-1' });
```

Also test that a historical terminal before the boundary, a different row/turn, post-gap online frames, and terminal-without-new-running cannot resolve the current turn.

- [ ] **Step 2: Run lifecycle tests and verify RED**

Run: `node --test tests/conversation-progress.test.mjs --test-name-pattern='turn terminal authority'`

Expected: failure because the deferred observer exposes no boundary or terminal promise.

- [ ] **Step 3: Implement the lifecycle API**

Extend the deferred observer with a small API such as:

```js
{
  beginTurnBoundary(),
  waitForTurnTerminal(),
  terminalAuthorityState(),
  observe(), bind(), fail(), markGap(), markTerminal()
}
```

Resolve only after a post-boundary `running` row transitions to `completedSuccess`, `completedInterrupted`, or `failed`. Map them to `succeeded`, `interrupted`, and `failed`. Disable authority on subscription failure or an unrecovered gap so callers can select snapshot fallback.

Downgrade legacy `prompt_completed` and `prompt_failed` to activity/wakeup events. They must not set `terminalSequence`, dispatch the terminal fence, or discard later v4 frames. The real v4/snapshot settlement path owns terminal fencing.

- [ ] **Step 4: Run focused tests and commit**

Run: `node --test tests/conversation-progress.test.mjs tests/progress.test.mjs`

Expected: all tests pass.

Commit: `feat: expose authoritative ZCode turn terminals`

### Task 3: Shared current-turn snapshot classifier and foreground coordinator

**Files:**
- Create: `scripts/lib/turn-terminal.mjs`
- Modify: `scripts/lib/review.mjs`
- Test: `tests/turn-terminal.test.mjs`
- Test: `tests/job-control.test.mjs`

- [ ] **Step 1: Write classifier tests and verify RED**

Test a pure classifier with `{ beforeMessageIds, inputId, stateRevision }`. Required outputs are `pending`, `succeeded`, `failed`, and `interrupted`. Cover initial-invalid read, empty idle, new user only, unfinished assistant, running projection, completed linked assistant, explicit error, hidden assistant, and unrelated historical messages.

Run: `node --test tests/turn-terminal.test.mjs`

Expected: module-not-found or missing-export failure.

- [ ] **Step 2: Implement the pure classifier**

The classifier must reuse the same real-user and linked-assistant semantics as final result extraction and require assistant completion evidence (`time.completed`, `finish`, or explicit error) before returning terminal success/failure.

- [ ] **Step 3: Write the captured 0.16.5 foreground regression and verify RED**

In `tests/job-control.test.mjs`, make the fake client emit legacy completion first, then return transitional reads, then resolve a v4 `completedSuccess` and final coherent snapshot. Assert `executeJob()` remains pending until the true terminal and publishes one result. Add a subscription-unavailable case that succeeds through snapshot fallback.

Run: `node --test tests/job-control.test.mjs --test-name-pattern='0.16.5|true turn terminal|snapshot fallback'`

Expected: current execution reads once and fails or terminalizes early.

- [ ] **Step 4: Implement the coordinator in `executeJob()`**

After the initial subscription snapshot establishes the historical baseline, arm the observer immediately before `client.send()`. Persist the accepted send boundary before awaiting or publishing a terminal candidate:

```js
conversationObserver.beginTurnBoundary();
const sendResult = await client.send(...);
await persistAcceptedBoundary(sendResult);
const legacyWake = waitForCompletionOrAbort(client.waitForCompletion(sessionId), signal);
const terminalSnapshot = await awaitCurrentTurnTerminal({
  legacyWake,
  conversationObserver,
  readSnapshot: () => client.readSession(sessionId),
  turnBoundary,
  signal,
});
```

The coordinator races validated v4 authority with legacy-triggered snapshot reconciliation, retries only recognized transitional read failures, has no normal completion timeout, and returns only a coherent terminal snapshot.

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test tests/turn-terminal.test.mjs tests/job-control.test.mjs`

Expected: all tests pass.

Commit: `fix: wait for coherent ZCode turn completion`

### Task 4: Recovery and cancellation convergence

**Files:**
- Modify: `scripts/lib/recovery.mjs`
- Modify: `scripts/lib/job-control.mjs` if the existing cancellation seam requires it
- Modify: `scripts/zcode-companion.mjs` to provide `readSession` to cancellation
- Test: `tests/recovery.test.mjs`
- Test: `tests/job-control.test.mjs`
- Test: `tests/session-end.test.mjs`

- [ ] **Step 1: Write failing recovery tests**

Add a running job with a persisted boundary whose read is `idle + no current-turn messages`. Assert recovery retains it rather than failing/cancelling it. Then advance through running and coherent terminal snapshots and assert recovery publishes the result once.

- [ ] **Step 2: Write failing cancellation-gap tests**

Simulate first stop acknowledgement before the current turn appears, followed by a running snapshot. Assert the job remains `cancelling`, bounded observation occurs while the cancellation lock and managed client remain active, a guarded second stop occurs, and local cancellation is published only after coherent interrupted/failed evidence. Also assert completed success wins normally, while observation expiry or uncertainty preserves the writable guard and returns `JOB_CANCEL_FAILED` for later retry.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test tests/recovery.test.mjs tests/job-control.test.mjs tests/session-end.test.mjs --test-name-pattern='admission gap|unresolved empty idle|second guarded stop'`

Expected: current recovery or cancellation terminalizes after the first idle/stop acknowledgement.

- [ ] **Step 4: Reuse the shared classifier**

Replace direct `projection.status` terminal decisions with the shared classification. The controller observes the persisted boundary before stopping, skips an admission-pending turn, stops only after current-turn activity appears, and rereads for coherent settlement. Preserve all existing ownership revalidation, worker lease, binding CAS, and terminal winner rules. Do not change persistent schemas or add a daemon.

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test tests/recovery.test.mjs tests/job-control.test.mjs tests/session-end.test.mjs`

Expected: all tests pass.

Commit: `fix: reconcile ZCode cancellation admission gaps`

### Task 5: Integration, real 0.16.5 qualification, and release artifacts

**Files:**
- Modify: `tests/fixtures/fake-zcode-cli.mjs`
- Modify: `tests/integration/companion.test.mjs`
- Modify generated marketplace snapshot files only through the repository build command

- [ ] **Step 1: Add an end-to-end fake-peer regression**

The fixture must emit the exact 0.16.5 order: accepted send, false legacy completion, delayed v4 running, delayed v4 terminal, and coherent final read. Test fresh and continuation execution, plus harmless additive fields.

- [ ] **Step 2: Verify RED before fixture-aware production integration**

Run: `node --test tests/integration/companion.test.mjs --test-name-pattern='0.16.5 true terminal'`

Expected: the companion exits or fails before the delayed true terminal.

- [ ] **Step 3: Complete minimal fixture/integration wiring and verify GREEN**

Run: `node --test tests/integration/companion.test.mjs --test-name-pattern='0.16.5 true terminal'`

Expected: fresh and continuation cases pass without early job terminalization.

- [ ] **Step 4: Run the authenticated isolated real-ZCode probe**

Use a newly created `/tmp/zcode-0165-qualification.*` workspace and a no-tools prompt. Verify the legacy notification precedes the v4 terminal while the plugin waits for the latter and returns the completed result. Remove the empty temporary workspace afterward.

- [ ] **Step 5: Run repository verification**

Run: `npm run check`

Expected: lint, typecheck, full tests, marketplace snapshot verification, and qualified tests all exit zero (credential-spending tests may report their documented opt-in skips).

- [ ] **Step 6: Build generated release surfaces and verify the diff**

Run the repository's documented marketplace snapshot build command, then rerun `npm run check`. Inspect `git diff --check` and ensure no diagnostic probes or temporary data remain.

- [ ] **Step 7: Commit**

Commit: `test: qualify ZCode 0.16.5 true terminals`
