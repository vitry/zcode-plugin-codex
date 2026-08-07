# Plugin Data Root Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make installed `$zcode:*` skills resolve and bootstrap a stable writable plugin data directory when `PLUGIN_DATA` is absent.

**Architecture:** Introduce a focused plugin-data path resolver, use it at every companion and hook entry point, and extend setup's existing Codex app-server configuration transaction to preserve and add the required writable root before any state write. Installed cache identity determines the marketplace-qualified namespace; source checkouts use an unqualified development namespace.

**Tech Stack:** Node.js 18.18+ ESM, Codex app-server JSONL configuration API, Node built-in test runner, JSDoc/TypeScript checking, ESLint.

---

### Task 1: Resolve and bootstrap plugin data safely

**Files:**
- Create: `scripts/lib/plugin-data.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Modify: `scripts/lib/codex-config.mjs`
- Modify: `hooks/session-lifecycle-hook.mjs`
- Modify: `hooks/user-prompt-hook.mjs`
- Modify: `hooks/subagent-hook.mjs`
- Modify: `hooks/stop-review-gate-hook.mjs`
- Modify: `hooks/session-end-hook.mjs`
- Modify: `tests/setup.test.mjs`
- Modify: `tests/integration/marketplace-install.test.mjs`
- Create or modify: `tests/plugin-data.test.mjs`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write failing resolver tests**

Cover explicit `ZCODE_DATA_ROOT`, validated injected roots, installed cache identity,
marketplace-qualified fallback, source-checkout fallback, `CODEX_HOME`, symlink-equivalent
paths, and rejection/ignoring of foreign injected roots.

- [ ] **Step 2: Run the resolver tests and verify RED**

Run: `node --test tests/plugin-data.test.mjs`

Expected: FAIL because the shared resolver does not exist.

- [ ] **Step 3: Implement the minimal shared resolver**

Create `scripts/lib/plugin-data.mjs` with pure path/identity functions and a single
`resolvePluginDataRoot({ env, pluginRoot })` public entry point. Do not create files in
the resolver.

- [ ] **Step 4: Run resolver tests and verify GREEN**

Run: `node --test tests/plugin-data.test.mjs`

Expected: PASS.

- [ ] **Step 5: Write failing setup bootstrap tests**

Exercise the real companion setup entry without `PLUGIN_DATA`. Assert that it derives
the installed root, preserves existing `sandbox_workspace_write.writable_roots`, emits
one version-checked `config/batchWrite`, returns `restart-required`, performs no plugin
state write before restart, and honors an already-effective writable root on rerun.

- [ ] **Step 6: Run setup tests and verify RED**

Run: `node --test tests/setup.test.mjs tests/integration/marketplace-install.test.mjs`

Expected: FAIL with the current `DATA_ROOT_REQUIRED` or missing writable-root edit.

- [ ] **Step 7: Integrate resolver and setup bootstrap**

Resolve the data root before companion routing. Reorder setup so Codex configuration is
read and the writable root is installed before model or gate state is accessed. Preserve
existing roots and user-layer version checks. Return restart guidance without writing
state when the sandbox root has just changed or is overridden.

- [ ] **Step 8: Use the resolver in hooks**

Replace direct `process.env.PLUGIN_DATA` assumptions with the shared resolver so hooks
and skills select the same root while retaining fail-closed hook behavior.

- [ ] **Step 9: Run focused tests and verify GREEN**

Run: `node --test tests/plugin-data.test.mjs tests/setup.test.mjs tests/hooks.test.mjs tests/integration/marketplace-install.test.mjs`

Expected: PASS.

- [ ] **Step 10: Update user-facing documentation**

Document the derived plugin-data location, marketplace qualification, restart-required
setup behavior, and the fact that state never lives in the repository or plugin cache.

- [ ] **Step 11: Run the complete quality gate**

Run: `npm run check`

Expected: PASS with only the documented credential-gated E2E skips.

- [ ] **Step 12: Self-review and commit**

Run `git diff --check`, inspect the full diff for unrelated changes and secret/path
leaks, then commit with a focused bug-fix message.
