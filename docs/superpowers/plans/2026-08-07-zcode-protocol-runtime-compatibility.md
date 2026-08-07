# ZCode Protocol Runtime Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make rescue work with ZCode CLI 0.16.1 server requests and make CLI model-provider failures actionable.

**Architecture:** Keep JSON-RPC compatibility inside `zcode-protocol.mjs`: server request IDs gain a separately bounded string form while ordinary response correlation remains integer-only. Carry only a safe remote error discriminator to `codex-config.mjs`, where setup maps `model_config_missing` to an API-key/provider-specific diagnostic.

**Tech Stack:** Node.js 22.13+, native `node:test`, JSON-RPC over JSONL, hermetic fake ZCode CLI.

---

### Task 1: Support ZCode 0.16.1 runtime-preference server requests

**Files:**
- Modify: `tests/fixtures/fake-zcode-cli.mjs`
- Modify: `tests/zcode-client.test.mjs`
- Modify: `scripts/lib/zcode-protocol.mjs`

- [ ] **Step 1: Write failing protocol tests**

Add fixture controls that make `session/create` first send a string-ID
`session/requestRuntimePreferences` request and wait for its response. Add a
test that expects `createSession()` to succeed after an exact-ID `-32601`
response, plus cases proving empty, oversized, and control-bearing string IDs
fail with `ZCODE_PROTOCOL_MALFORMED`.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test tests/zcode-client.test.mjs
```

Expected: the real-shape runtime-preferences test fails with
`ZCODE_PROTOCOL_MALFORMED` because `server-1` is not an integer.

- [ ] **Step 3: Implement the minimal protocol change**

Add a private server-request-ID predicate accepting a safe integer or
`isSafeIdentifier()` string. Use it only in `handleServerRequest()`. Preserve
integer-only validation in `handleResponse()`. Existing unsupported server
requests return `-32601` with the exact received ID.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node --test tests/zcode-client.test.mjs
```

Expected: all protocol tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/zcode-protocol.mjs tests/fixtures/fake-zcode-cli.mjs tests/zcode-client.test.mjs
git commit -m "fix: support zcode runtime preference requests"
```

### Task 2: Report missing CLI model providers precisely

**Files:**
- Modify: `tests/fixtures/fake-zcode-cli.mjs`
- Modify: `tests/setup.test.mjs`
- Modify: `scripts/lib/zcode-protocol.mjs`
- Modify: `scripts/lib/codex-config.mjs`

- [ ] **Step 1: Write failing setup tests**

Make the fixture emit a JSON-RPC error with
`data.code = "model_config_missing"` for `session/create`. Assert that
`diagnoseZCodeAuth()` returns `ready: false`, status `unauthenticated`, a reason
mentioning the ZCode CLI model provider, and a remedy mentioning API-key
provider configuration rather than mandatory login.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test tests/setup.test.mjs
```

Expected: the new diagnostic assertions fail because setup currently returns
the generic authenticate-with-ZCode remedy.

- [ ] **Step 3: Implement bounded error propagation and mapping**

When a remote error contains a bounded safe string `data.code`, include it as
`details.remoteCode` on `ZCODE_REQUEST_FAILED`. In `diagnoseZCodeAuth()`, map
only `model_config_missing` to the CLI provider/API-key explanation. Keep the
generic diagnostic for every other error.

- [ ] **Step 4: Verify GREEN and regression safety**

Run:

```bash
node --test tests/setup.test.mjs tests/zcode-client.test.mjs
npm test
```

Expected: all tests pass; credential-gated E2E tests may remain skipped.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/zcode-protocol.mjs scripts/lib/codex-config.mjs tests/fixtures/fake-zcode-cli.mjs tests/setup.test.mjs
git commit -m "fix: diagnose missing zcode cli model provider"
```

### Task 3: Real CLI verification and release documentation

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: Document the compatibility and configuration distinction**

Record string-ID server-request compatibility and explain that Desktop and CLI
model-provider configuration are separate; API-key users do not need OAuth
when the CLI provider is configured.

- [ ] **Step 2: Run real protocol smoke verification**

Launch the discovered ZCode 0.16.1 `app-server` in a temporary workspace,
issue `session/create`, respond `-32601` to runtime-preference requests, and
confirm the next result is the expected bounded `model_config_missing` error in
the current environment rather than `ZCODE_PROTOCOL_MALFORMED`.

- [ ] **Step 3: Run release checks**

```bash
npm run check
```

Expected: lint/type/manifest checks and all hermetic tests pass; only explicit
credential-gated E2E tests may be skipped.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md README.md README.zh-CN.md
git commit -m "docs: explain zcode cli provider setup"
```
