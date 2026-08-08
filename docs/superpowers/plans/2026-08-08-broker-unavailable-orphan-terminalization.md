# Broker-Unavailable Orphan Terminalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an exact writable Rescue orphan terminal when its worker is gone and its existing ZCode control channel is unavailable, so SessionEnd and later Rescue admission do not leave a permanent writable guard.

**Architecture:** Keep selection, ownership, worker-lease fencing, and terminal races in `scripts/lib/recovery.mjs`. Distinguish total control-channel loss from a reachable protocol whose read or stop operation fails: only the former becomes `failed`; the latter retains the active guard. Reuse the existing `failed` state and bounded recovery error rather than adding a public status.

**Tech Stack:** Node.js ESM, `node:test`, durable JSON state, file locks, local JSONL ZCode Protocol, Markdown release contracts.

---

## File Structure

- `scripts/lib/recovery.mjs`: classify existing-control-channel absence and perform terminal transitions under the existing cancellation lock.
- `tests/recovery.test.mjs`: unit coverage for reservation-time orphan selection and settlement policy.
- `tests/session-end.test.mjs`: unit coverage for exact-owner SessionEnd terminalization and race behavior.
- `tests/hooks.test.mjs`: real hook coverage proving no process spawn and caller cleanup.
- `tests/integration/companion.test.mjs`: public Rescue admission coverage for historical orphans and live-lease fences.
- `README.md`, `README.zh-CN.md`, `CHANGELOG.md`: user-facing lifecycle semantics.
- `tests/release-contracts.test.mjs`: exact bilingual release-contract assertions.

### Task 1: Write the Full Failing Lifecycle Slice

**Files:**
- Modify: `tests/recovery.test.mjs`
- Modify: `tests/session-end.test.mjs`
- Modify: `tests/hooks.test.mjs`
- Modify: `tests/integration/companion.test.mjs`

- [ ] **Step 1: Write reservation-time failing tests**

Add focused tests that construct a running writable Rescue with a free exact
worker lease and assert that managed-client establishment failure and an
explicit protocol disconnect produce a terminal failure:

```js
test('reservation scavenging archives an orphan when its existing broker is unavailable', async () => {
  const input = await fixture();
  const orphan = await job(input, { status: 'running', withBoundary: true });
  await scavengeWritableJobs({
    ...input,
    createClient: async () => { throw new PluginError(
      'ZCODE_DISCONNECTED',
      'The ZCode process connection failed.',
      { category: 'runtime', remedy: 'Restart the operation.' },
    ); },
    reconcileOwnership: async () => {},
  });
  const stored = await input.store.readJob(input.workspace, orphan.id);
  assert.equal(stored.status, 'failed');
  assert.match(stored.error.message, /broker.*unavailable.*orphan/i);
});

test('reservation scavenging archives an orphan when its established control channel disconnects', async () => {
  const input = await fixture();
  const orphan = await job(input, { status: 'running', withBoundary: true });
  await scavengeWritableJobs({
    ...input,
    reconcileOwnership: async () => {},
    createClient: async () => ({
      listSessions: async () => { throw new PluginError(
        'ZCODE_DISCONNECTED',
        'The ZCode process disconnected.',
        { category: 'state', remedy: 'Retry later.' },
      ); },
      close: async () => {},
    }),
  });
  assert.equal((await input.store.readJob(input.workspace, orphan.id)).status, 'failed');
});
```

- [ ] **Step 2: Write SessionEnd failing tests**

Change the absent-client expectation from active-with-`lastCancelError` to a
terminal `failed` record, then add the reachable-broker/no-protocol case:

```js
test('SessionEnd archives its exact writable job when the existing broker is unavailable', async () => {
  const input = await fixture();
  const value = await job(input, { status: 'running', withBoundary: true });
  const settled = await settle(input, async () => null);
  assert.equal(settled.status, 'failed');
  const stored = await input.store.readJob(input.workspace, value.id);
  assert.equal(stored.status, 'failed');
  assert.match(stored.error.message, /SessionEnd.*broker.*unavailable/i);
  assert.equal(stored.lastCancelError, undefined);
});
```

Retain explicit tests proving a reachable client's `readSession` timeout and
`stopSession` rejection remain `running` with a bounded `lastCancelError`.

- [ ] **Step 3: Change the real SessionEnd hook test to require terminal archival**

Update `SessionEnd never starts a broker when exact existing settlement is
unavailable` to assert:

```js
assert.equal((await store.readJob(cwd, value.id)).status, 'failed');
await assert.rejects(readFile(record, 'utf8'), { code: 'ENOENT' });
await assert.rejects(identity.resolveActiveTurn({ sessionId: 'absent-owner', workspace: cwd }), {
  code: 'ACTIVE_TURN_NOT_FOUND',
});
```

Keep the source assertion proving `createExistingManagedZCodeClient` is used and
the hook cannot supply launch configuration.

- [ ] **Step 4: Add a historical-orphan Rescue admission test**

Create an owner-A writable Rescue with a persisted `zcodeSessionId`, dead
`childPid`, free exact worker lease, and a managed-client factory that cannot
establish a control channel. Invoke owner B's normal Rescue path once. Assert
owner A becomes `failed`, owner B obtains the only active writable reservation,
and owner B cannot read/cancel/resume owner A's record.

```js
const oldJob = await store.readJob(context.workspace, orphan.id);
assert.equal(oldJob.status, 'failed');
assert.match(oldJob.error.message, /control channel.*unavailable.*orphan/i);
assert.equal(result.job.ownerSessionId, context.ownerSessionId);
assert.equal(result.job.status, 'queued');
```

Keep the existing held-lease and reachable-unacknowledged-stop integration tests
unchanged so the RED slice also guards the nonterminal boundaries.

- [ ] **Step 5: Run the complete behavior slice and verify RED**

Run:

```bash
node --test tests/recovery.test.mjs tests/session-end.test.mjs tests/hooks.test.mjs tests/integration/companion.test.mjs
```

Expected: the new absent-client, disconnect, real-hook, and public-admission
assertions fail because recovery currently restores or leaves the old job
`running`.

- [ ] **Step 6: Commit the RED tests**

```bash
git add tests/recovery.test.mjs tests/session-end.test.mjs tests/hooks.test.mjs tests/integration/companion.test.mjs
git commit -m "test: require broker-loss orphan archival"
```

### Task 2: Implement Control-Channel-Loss Terminalization

**Files:**
- Modify: `scripts/lib/recovery.mjs`

- [ ] **Step 1: Implement the minimal classification**

In `scripts/lib/recovery.mjs`, add narrow helpers that recognize only total
existing-control-channel loss:

```js
const CONTROL_CHANNEL_UNAVAILABLE = new Set([
  'ZCODE_BROKER_PROTOCOL_UNAVAILABLE',
  'ZCODE_DISCONNECTED',
]);

function controlChannelUnavailable(error) {
  return error instanceof PluginError && CONTROL_CHANNEL_UNAVAILABLE.has(error.code);
}

function unavailableError(context) {
  return recoveryError(`The existing ZCode broker is unavailable; the ${context} orphan was archived.`);
}
```

Move ownership reconciliation outside the client-establishment `try` so a local
owner-store failure does not masquerade as broker loss. Update `reconcileOrphan`
so managed-client establishment failure calls `failJob` with the
reservation-time diagnostic. Once a client exists, terminalize only explicit
`ZCODE_BROKER_PROTOCOL_UNAVAILABLE` or `ZCODE_DISCONNECTED`; retain timeouts,
request rejections, malformed results, and unacknowledged stops.

Update `settleEndedRemoteJob` so a `null` client and recognized existing-protocol
unavailability call `failJob` with the SessionEnd diagnostic. Keep read/stop
timeouts, rejections, malformed responses, and unacknowledged stops routed to
`retainAfterStopFailure`.

Do not change worker-lease selection, public ownership, or terminal conflict
handling.

- [ ] **Step 2: Run the full behavior slice and verify GREEN**

Run:

```bash
node --test tests/recovery.test.mjs tests/session-end.test.mjs tests/hooks.test.mjs tests/integration/companion.test.mjs
```

Expected: all tests pass, including existing completion-wins, cancellation-lock,
held-worker-lease, and unacknowledged-stop cases.

- [ ] **Step 3: Commit Task 2**

```bash
git add scripts/lib/recovery.mjs
git commit -m "fix: archive broker-unavailable rescue orphans"
```

### Task 3: Update Lifecycle Contracts and Documentation

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `CHANGELOG.md`
- Modify: `tests/release-contracts.test.mjs`

- [ ] **Step 1: Write failing bilingual release-contract assertions**

Require both READMEs to state that a free orphan worker plus unavailable existing
broker becomes a failed terminal job, while a reachable unacknowledged stop
retains the guard. Scope the regexes to the lifecycle paragraph rather than
scanning for broad forbidden phrases.

```js
assert.match(englishLifecycle, /existing broker.*unavailable.*failed.*writable guard/i);
assert.match(chineseLifecycle, /现存 broker.*不可用.*failed.*writable guard/i);
assert.match(englishLifecycle, /reachable.*unacknowledged.*keeps the writable guard/i);
```

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```bash
node --test tests/release-contracts.test.mjs
```

Expected: FAIL because the current docs say any unacknowledged stop retains the
guard and do not describe broker-unavailable orphan archival.

- [ ] **Step 3: Update English, Chinese, and changelog text**

Replace the lifecycle paragraph with aligned language that says:

```text
When the exact worker lease is free and the existing broker control channel is
unavailable, SessionEnd or the next Rescue archives the orphan as failed and
releases the writable guard. This is abandonment, not confirmed remote stop. A
reachable broker whose session/stop is unacknowledged still retains the guard.
```

Use the corresponding Chinese wording. Update the Unreleased entry to describe
the same distinction. Do not advertise manual force release, cross-owner job
access, or guaranteed remote termination.

- [ ] **Step 4: Run contract tests and verify GREEN**

Run:

```bash
node --test tests/release-contracts.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add README.md README.zh-CN.md CHANGELOG.md tests/release-contracts.test.mjs
git commit -m "docs: explain broker-loss orphan archival"
```

### Task 4: Full Verification

**Files:**
- Verify only

- [ ] **Step 1: Run the lifecycle regression suite**

```bash
node --test tests/recovery.test.mjs tests/session-end.test.mjs tests/hooks.test.mjs tests/integration/companion.test.mjs tests/job-control.test.mjs tests/state.test.mjs tests/release-contracts.test.mjs
```

Expected: zero failures, cancellations, or skips.

- [ ] **Step 2: Run static gates**

```bash
npm run lint
npm run typecheck
git diff --check origin/main...HEAD
```

Expected: all commands exit 0.

- [ ] **Step 3: Run the full test suite**

```bash
npm test
```

Expected: all tests pass with no unexpected stderr.

- [ ] **Step 4: Inspect the final diff and repository state**

```bash
git status --short --branch
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
```

Expected: only the approved spec, plan, recovery behavior, focused tests, and
lifecycle documentation differ from `origin/main`; the worktree is clean after
commits.
