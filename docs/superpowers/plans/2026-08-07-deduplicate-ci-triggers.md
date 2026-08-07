# Deduplicate CI Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure an open pull-request branch creates only one six-job CI matrix while merged commits continue to run CI on `main`.

**Architecture:** Preserve the existing matrix and steps. Narrow only the workflow event boundary, and enforce it through the existing release contract suite.

**Tech Stack:** GitHub Actions YAML, Node.js built-in test runner

---

### Task 1: Restrict branch push CI to main

**Files:**
- Modify: `tests/release-contracts.test.mjs`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the failing trigger contract**

Add these assertions to the existing CI release-contract test:

```js
assert.match(workflow, /^  push:\n    branches: \[main\]$/m);
assert.match(workflow, /^  pull_request:\s*$/m);
```

- [ ] **Step 2: Verify the contract fails for the broad push trigger**

Run: `node --test --test-name-pattern='CI runs full' tests/release-contracts.test.mjs`

Expected: FAIL because `.github/workflows/ci.yml` has an unrestricted `push` trigger.

- [ ] **Step 3: Apply the minimal workflow change**

Change the event block to:

```yaml
on:
  push:
    branches: [main]
  pull_request:
```

- [ ] **Step 4: Verify the focused and complete suites**

Run: `node --test --test-name-pattern='CI runs full' tests/release-contracts.test.mjs`

Expected: PASS.

Run: `npm run check`

Expected: zero failures; only the two credential-gated real E2E tests may be skipped.

- [ ] **Step 5: Commit the implementation**

```bash
git add .github/workflows/ci.yml tests/release-contracts.test.mjs
git commit -m "ci: avoid duplicate pull request matrices"
```

### Task 2: Stabilize intended timeout seams on Node 22.13

**Files:**
- Modify: `tests/zcode-client.test.mjs`
- Modify: `tests/fixtures/stop-gate-with-timeout.mjs`
- Modify: `tests/hooks.test.mjs`

- [ ] **Step 1: Reproduce the request-budget failures under contention**

Run the stderr-tail test repeatedly under Node 22.13 with parallel workers and confirm at least one `ZCODE_REQUEST_TIMEOUT` occurs before `session/list`.

Run the Stop-gate timeout group repeatedly under Node 22.13 with parallel workers and confirm at least one result has no `decision` because only `session/create` was recorded.

- [ ] **Step 2: Give only the stderr-tail scenario a two-second request budget**

Pass this options object as the third `withClient` argument in the stderr-tail test:

```js
{ requestTimeoutMs: 2_000 }
```

Keep the helper's 500 ms default unchanged.

- [ ] **Step 3: Make the deliberate Stop completion timeout platform-neutral**

In `tests/fixtures/stop-gate-with-timeout.mjs`, use:

```js
const timeoutMs = 2_000;
```

This keeps the intended suppressed completion as the timeout source on every platform without changing production defaults.

- [ ] **Step 4: Prove the Stop timeout reaches the intended seam**

For the timeout case in `tests/hooks.test.mjs`, assert the recorded calls include `session/send` before accepting the conservative block result. Retain the existing `session/stop` assertion.

- [ ] **Step 5: Verify focused stress and full suites**

Run the Node 22.13 targeted stress commands from the diagnosis, then run `npm run check` and `git diff --check`.

Expected: no targeted timeouts before the intended seam, zero suite failures, and only the two credential-gated real E2E skips.

- [ ] **Step 6: Commit**

```bash
git add tests/zcode-client.test.mjs tests/fixtures/stop-gate-with-timeout.mjs tests/hooks.test.mjs
git commit -m "test: stabilize Node 22 timeout scenarios"
```
