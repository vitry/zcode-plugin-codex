# Cold Resume Runtime Materialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover an exact cold resumed ZCode session by lazily materializing the configured CLI runtime model once before the first send.

**Architecture:** Inspect the schema-validated resume snapshot for the exact `ZCODE_RUNTIME_MODEL_UNAVAILABLE` type. Only then resolve the highest-priority model, lazily reading `~/.zcode/cli/config.json` `model.main` when necessary, apply it once with `session/setModel`, then send once.

**Tech Stack:** Node.js 22.13 ESM, native `node:test`, existing ZCode JSON-RPC client.

---

### Task 1: Secret-safe CLI model reader

**Files:**

- Create: `scripts/lib/zcode-runtime-config.mjs`
- Create: `tests/zcode-runtime-config.test.mjs`

- [ ] Write tests first for HOME/USERPROFILE selection, first-slash parsing, missing/malformed/oversized config, invalid `model.main`, and secret non-disclosure.
- [ ] Run `node --test tests/zcode-runtime-config.test.mjs`; verify RED because the module is absent.
- [ ] Implement a bounded regular-file JSON reader returning only `{providerId, modelId}` from `<home>/.zcode/cli/config.json` `model.main`.
- [ ] Map every filesystem/JSON/shape failure to one fixed bounded `PluginError` that contains no path, raw bytes, provider options, endpoint, key, token, or secret.
- [ ] Run the reader tests; verify GREEN.

Required public API:

```js
export async function readZCodeCliMainModel({
  env = process.env,
  home = env.HOME || env.USERPROFILE || homedir(),
  maxBytes = 64 * 1024,
} = {})
```

### Task 2: Exact one-shot executor recovery

**Files:**

- Modify: `scripts/lib/review.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Modify: `tests/job-control.test.mjs`

- [ ] Write executor tests first for exact cold warning, warm resume, other warning type, missing resolver result, setModel rejection, effort ordering, and genuine send failure.
- [ ] Verify RED: current executor does not react to the resume snapshot warning.
- [ ] Add `resolveRuntimeRecoveryModel?: () => Promise<ModelTuple>` to `executeJob`.
- [ ] Resolve explicit/workspace model first; on exact resumed warning force one `setModel` even when equal to current; otherwise lazily call the resolver.
- [ ] Apply requested effort after recovered model materialization.
- [ ] Preserve the original runtime warning when config cannot supply a tuple; propagate setModel/send failures unchanged; never loop, resend, create a session, or select fresh.
- [ ] Inject `readZCodeCliMainModel({env})` lazily from `executeReserved`; do not read config for fresh or warm paths.
- [ ] Run focused job-control tests; verify GREEN.

Required order:

```text
session/resume
if exact cold warning: session/setModel
if requested: session/setThoughtLevel
session/send exactly once
```

### Task 3: Protocol-shaped integration proof

**Files:**

- Modify: `tests/fixtures/fake-zcode-cli.mjs`
- Modify: `tests/integration/companion.test.mjs`

- [ ] Add a fake-peer mode whose resume snapshot carries the exact warning and whose runtime becomes usable only after the expected setModel tuple.
- [ ] Add an isolated-home Companion test with `.zcode/cli/config.json` and assert `resume -> setModel -> send`.
- [ ] Add warm and truly unsupported model negatives; assert zero config fallback loops and zero extra sends.
- [ ] Run:

```bash
node --test tests/zcode-runtime-config.test.mjs tests/job-control.test.mjs \
  tests/integration/companion.test.mjs
```

- [ ] Commit:

```bash
git add scripts/lib/zcode-runtime-config.mjs scripts/lib/review.mjs scripts/zcode-companion.mjs \
  tests/zcode-runtime-config.test.mjs tests/job-control.test.mjs \
  tests/fixtures/fake-zcode-cli.mjs tests/integration/companion.test.mjs
git commit -m "fix: materialize cold resume runtime"
```

### Review gate

- [ ] Fresh spec-compliance reviewer checks every cold/warm/error acceptance criterion.
- [ ] Original implementer fixes all gaps; reviewer rechecks until approved.
- [ ] Fresh code-quality reviewer checks bounded I/O, secret handling, error preservation, and one-shot ordering.
- [ ] Original implementer fixes Critical/Important findings; reviewer rechecks until approved.
