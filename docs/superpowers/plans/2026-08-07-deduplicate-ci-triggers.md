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
