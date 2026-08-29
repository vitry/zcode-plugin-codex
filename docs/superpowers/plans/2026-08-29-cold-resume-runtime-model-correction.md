# Cold Resume Runtime Model Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Materialize a cold ZCode 0.16.3 session from its complete bounded CLI runtime configuration while preserving one resume, one send, lazy warm-resume behavior, and private secrets.

**Architecture:** Keep the existing resume-first exact-warning trigger. Replace tuple-only `session/setModel` recovery with a focused full-runtime config resolver and the owner-scoped `session/updateRuntimeModelConfig` AppServer method, then reread the session to prove the warning cleared before effort or send.

**Tech Stack:** Node.js 22.13 ESM, JSON-RPC over the existing authenticated local broker, `node:test`, ESLint, TypeScript check-JS.

---

## File map

- `scripts/lib/zcode-runtime-config.mjs`: bounded CLI config parsing and allowlisted runtime-model normalization.
- `scripts/lib/zcode-client.mjs`: validated `session/updateRuntimeModelConfig` client method.
- `scripts/zcode-broker.mjs`: owner-scoped admission for the new AppServer method.
- `scripts/lib/review.mjs`: exact cold-warning orchestration.
- `scripts/zcode-companion.mjs`: inject the runtime resolver without persisting its result.
- `tests/zcode-runtime-config.test.mjs`: config normalization, invalid-shape, bound, and privacy matrix.
- `tests/zcode-client.test.mjs`: exact wire/result validation and broker ownership coverage.
- `tests/job-control.test.mjs`: executor red/green ordering and failure semantics.
- `tests/fixtures/fake-zcode-cli.mjs`: protocol-faithful runtime update behavior.
- `tests/integration/companion.test.mjs`: installed-style cold/warm/privacy integration proof.
- `docs/superpowers/specs/2026-08-28-resume-runtime-workspace-compaction-design.md`, `README.md`, `README.zh-CN.md`, `CHANGELOG.md`, `SECURITY.md`: correct tuple-only release claims.
- `.agents/plugins/marketplace.json`: regenerated plugin snapshot after source changes.

### Task 1: Normalize the complete ZCode CLI runtime model

**Files:**
- Modify: `scripts/lib/zcode-runtime-config.mjs`
- Modify: `tests/zcode-runtime-config.test.mjs`

- [ ] **Step 1: Write failing config-normalization tests**

Add tests that create an isolated `~/.zcode/cli/config.json` containing `model.main`, one provider, provider options, and two model records. Require a new API:

```js
const runtime = await readZCodeCliRuntimeModel({
  home,
  now: () => 1_788_000_000_000,
  revision: () => 'codex-runtime-test',
});
assert.deepEqual(runtime.model, { providerId: 'bigmodel', modelId: 'GLM-5.2' });
assert.equal(runtime.revision, 'codex-runtime-test');
assert.equal(runtime.generatedAt, 1_788_000_000_000);
assert.deepEqual(runtime.provider.apiKey, { source: 'inline', value: 'PRIVATE_API_KEY' });
assert.deepEqual(runtime.provider.models.map(({ modelId }) => modelId), ['GLM-5.2', 'glm-4.7']);
```

Also require an optional exact tuple to override only `model.main`, while still requiring that provider and model to exist in the same config. Add table cases for missing provider/model, unsupported kind, missing required base URL/key, control/oversized strings, too many providers/models, unexpected arrays, malformed JSON, symlink/non-regular file, and oversized file. Assert every failure is the fixed `ZCODE_RUNTIME_MODEL_CONFIG_INVALID` envelope without raw values.

- [ ] **Step 2: Run the focused tests and observe RED**

Run:

```bash
node --test tests/zcode-runtime-config.test.mjs
```

Expected: FAIL because `readZCodeCliRuntimeModel` is not exported.

- [ ] **Step 3: Implement the minimal bounded normalizer**

Keep `readZCodeCliMainModel` compatible. Add:

```js
export async function readZCodeCliRuntimeModel(input = {}) {
  const config = await readEffectiveConfig(input);
  const model = input.model ?? parseMainModel(config);
  const provider = normalizeProvider(config.provider?.[model.providerId], model);
  return {
    revision: (input.revision ?? defaultRevision)(),
    generatedAt: (input.now ?? Date.now)(),
    model: { ...model },
    provider,
  };
}
```

Normalize only the fields enumerated by the corrective design. Convert config `provider.<id>.models` to the AppServer model array and config `options.apiKey` to `{ source: 'inline', value }`. Enforce explicit collection, string, byte, timestamp, and nesting limits before constructing output. Do not attach parsed config or a cause to the public error.

- [ ] **Step 4: Run focused tests and observe GREEN**

Run:

```bash
node --test tests/zcode-runtime-config.test.mjs
npm run lint -- --quiet
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit Task 1**

```bash
git add scripts/lib/zcode-runtime-config.mjs tests/zcode-runtime-config.test.mjs
git commit -m "fix: resolve complete ZCode runtime config"
```

### Task 2: Add the owner-scoped runtime update protocol boundary

**Files:**
- Modify: `scripts/lib/zcode-client.mjs`
- Modify: `scripts/zcode-broker.mjs`
- Modify: `tests/zcode-client.test.mjs`
- Modify: `tests/fixtures/fake-zcode-cli.mjs`

- [ ] **Step 1: Write failing client and broker tests**

Extend the typed operations test with:

```js
const updated = await client.updateRuntimeModelConfig(sessionId, runtimeModel);
assert.equal(updated.appliedModelRuntimeRevision, runtimeModel.revision);
assert.equal(typeof updated.changed, 'boolean');
assert.deepEqual(updateCall, {
  method: 'session/updateRuntimeModelConfig',
  params: { sessionId, runtimeModel, applyModelSelection: true },
});
```

Add invalid input/output cases for extra fields, unsafe revision/timestamp/provider/model/credential shapes, mismatched session ID or applied revision, and non-boolean `changed`. Extend broker admission tests so the owner succeeds, a foreign owner is denied, and operation release/retirement behavior matches other owner-scoped session methods.

- [ ] **Step 2: Run focused tests and observe RED**

Run:

```bash
node --test tests/zcode-client.test.mjs
```

Expected: FAIL because the method is absent and the broker rejects it.

- [ ] **Step 3: Implement the narrow method and broker admission**

Add the exact broker method to `LOCAL_BROKER_METHODS` and the owner-scoped session set. Add a client method shaped as:

```js
async updateRuntimeModelConfig(sessionId, runtimeModel) {
  requireSessionId(sessionId);
  validateRuntimeModel(runtimeModel);
  const result = await this.protocol.request('session/updateRuntimeModelConfig', {
    sessionId,
    runtimeModel: copyRuntimeModel(runtimeModel),
    applyModelSelection: true,
  });
  validateRuntimeUpdateResult(result, sessionId, runtimeModel.revision);
  return result;
}
```

Validation and copying must be exact, bounded, recursive only across the documented shallow provider/model structures, and must not stringify sensitive objects in errors. Update the fake CLI to validate the request shape, materialize the session runtime, clear the restore warning, and return the applied revision.

- [ ] **Step 4: Run focused tests and observe GREEN**

Run:

```bash
node --test tests/zcode-client.test.mjs
npm run lint -- --quiet
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit Task 2**

```bash
git add scripts/lib/zcode-client.mjs scripts/zcode-broker.mjs tests/zcode-client.test.mjs tests/fixtures/fake-zcode-cli.mjs
git commit -m "fix: expose runtime config update protocol"
```

### Task 3: Replace tuple-only cold recovery and update release surfaces

**Files:**
- Modify: `scripts/lib/review.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Modify: `tests/job-control.test.mjs`
- Modify: `tests/integration/companion.test.mjs`
- Modify: `docs/superpowers/specs/2026-08-28-resume-runtime-workspace-compaction-design.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `CHANGELOG.md`
- Modify: `SECURITY.md`
- Modify: `tests/release-contracts.test.mjs`
- Modify: `.agents/plugins/marketplace.json`

- [ ] **Step 1: Write failing executor and installed-style tests**

Change the execution fixture so `session/setModel` cannot clear a cold warning. Add `updateRuntimeModelConfig` and a post-update `readSession` transition. Require exact call orders:

```text
cold default: resume -> resolveRuntimeConfig -> updateRuntime -> read -> send
cold effort:  resume -> resolveRuntimeConfig -> updateRuntime -> read -> effort -> send
warm:         resume -> send
other error:  resume -> send (existing behavior)
```

Assert one resume, one update at most, one post-update read, and one send at most. Add rejection cases for config resolution, runtime update, mismatched selected tuple, retained warning, interruption at each boundary, and genuine send failure. No failure may retry resume or fall back to create/fresh.

In the integration fixture, store a private sentinel API key in isolated HOME. Assert the wire update contains the normalized runtime only inside the fake peer record, while stdout, stderr, internal output, job JSON, prompt/result artifacts, progress, and logs contain no sentinel. Remove the config and prove a later warm resume performs no runtime update or config read.

- [ ] **Step 2: Run focused tests and observe RED**

Run:

```bash
node --test --test-name-pattern='cold resume|cold recovery|warm resume|genuine send' tests/job-control.test.mjs
node --test --test-name-pattern='cold resume|unsupported CLI recovery|warm, other-warning' tests/integration/companion.test.mjs
```

Expected: FAIL because production still calls tuple-only `setModel` and rejects the unchanged warning.

- [ ] **Step 3: Implement exact lazy recovery**

Replace the current recovery block with this state machine:

```js
if (runtimeRecoveryRequired) {
  const runtimeModel = await resolveRuntimeRecoveryConfig(recoveryModel);
  await client.updateRuntimeModelConfig(activeSessionId, runtimeModel);
  snapshot = await client.readSession(activeSessionId);
  requireRecoveredRuntime(snapshot, runtimeModel.model);
}
```

The injected resolver must be called only in the exact warning branch and receive the already selected explicit/workspace tuple when present. On missing config, rethrow the existing bounded runtime-unavailable envelope. Propagate structured update failures unchanged. Verify exact tuple equality and absence of the warning before effort/send. Remove tuple-only cold `setModel`, the post-setModel warning assumption, and dead dependencies without changing ordinary model selection.

- [ ] **Step 4: Correct documentation and release-contract tests**

Mark the old tuple-only section as superseded by the 2026-08-29 corrective design. Update English/Chinese release guidance, changelog, and security text to describe full bounded runtime configuration, lazy exact-warning recovery, one runtime update, no resume retry, and ephemeral secret handling. Update release-contract assertions to reject the obsolete `resume -> setModel` claim.

- [ ] **Step 5: Run focused tests and observe GREEN**

Run:

```bash
node --test tests/zcode-runtime-config.test.mjs tests/zcode-client.test.mjs tests/job-control.test.mjs tests/integration/companion.test.mjs tests/release-contracts.test.mjs
npm run check:line-endings
npm run lint
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 6: Regenerate and verify the marketplace snapshot**

Use the repository's existing marketplace build/cachebuster workflow to regenerate `.agents/plugins/marketplace.json`, then run:

```bash
node --test tests/integration/marketplace-snapshot-build.mjs
```

Expected: the generated snapshot matches source and the test exits 0.

- [ ] **Step 7: Commit Task 3**

```bash
git add scripts/lib/review.mjs scripts/zcode-companion.mjs tests/job-control.test.mjs tests/integration/companion.test.mjs \
  docs/superpowers/specs/2026-08-28-resume-runtime-workspace-compaction-design.md README.md README.zh-CN.md CHANGELOG.md SECURITY.md \
  tests/release-contracts.test.mjs .agents/plugins/marketplace.json
git commit -m "fix: materialize cold resume runtime config"
```

## Final verification and delivery

- [ ] Run the full source suite: `npm test`.
- [ ] Run repository checks: `npm run check:line-endings && npm run lint && npm run typecheck`.
- [ ] Run qualified tests and record only expected opt-in skips: `npm run test:qualified`.
- [ ] Run the packed production-install test and marketplace snapshot build test in isolation.
- [ ] Re-run a safe direct ZCode 0.16.3 probe with no prompt send, proving warning -> runtime update -> read clear.
- [ ] Dispatch final independent spec and code-quality reviews; resolve every Critical/Important issue and re-review.
- [ ] Push `fix/cold-resume-runtime-model`, create a follow-up PR to `main`, and monitor all CI checks until every required check succeeds.
