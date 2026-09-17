# ZCode Dual Foreground Wait Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a 60-second same-handle shell wait baseline and explicit-only MCP-backed ZCode Skill variants that reuse the exact existing Companion, Rescue binding, placement, cancellation, and lifecycle implementation.

**Architecture:** Canonical Skills continue to invoke the Companion CLI and observe one process with empty-input `write_stdin`. MCP siblings call narrow tools on a plugin-root stdio MCP server; each handler resolves a trusted per-call thread/turn/workspace capability, then enters `runDirectInvocation` with fixed argv. Rescue preparation version 5 carries a private `foregroundAdapter` selector through one-shot preparation and pending choice state without adding it to Rescue Binding or Tracked Job identity.

**Tech Stack:** Node.js 22 ESM, `node:test`, `@modelcontextprotocol/sdk` 1.30.0, Codex plugin `.mcp.json`, Codex Skills/Role templates, existing private preparation and lifecycle stores, npm packed-install and marketplace snapshot qualification.

**Spec:** `docs/superpowers/specs/2026-09-18-zcode-dual-foreground-wait-adapters-design.md`

---

## Handoff constraints

- Work only in the dedicated `feat/dual-foreground-wait-adapters` worktree.
- Preserve the existing binding, placement, permission, Tracked Job, cancellation, and lifecycle modules as the sole authorities. MCP is transport and waiting only.
- Task 2 is a hard real-Host gate. Do not execute Tasks 3–10 unless every required probe assertion passes. If it fails, keep the shell repair, leave MCP Skills unshipped, and amend the design before further implementation.
- Tasks 3–10 are a conditional implementation blueprint, not an executable continuation of Task 2 as currently written. After the real-Host probe passes, replace every `QUALIFIED_*` symbol below with the recorded field name/shape and timeout/cancellation behavior, add the redacted qualification record, and obtain a fresh independent review of this plan before Task 3. No worker may infer those values while implementing.
- Never derive MCP authority from tool arguments, server cwd, startup environment, latest-record lookup, or uniqueness assumptions.
- The MCP server name is `zcode_companion`; raw tool names remain the eight names in the spec. Skill prose may refer to their host-exposed `mcp__zcode_companion__...` names only in generated adapter regions.
- Use RED → GREEN for every behavior task. Commit after each task.
- Run focused tests during development. Run the full suite before marketplace generation.
- The checked-in marketplace snapshot must be generated from an exact clean source commit. Commit source/tests/docs first, generate the snapshot from that commit, then commit snapshot bytes separately.
- Do not include root-workspace `.DS_Store`, `task_plan.md`, `findings.md`, or `progress.md` in any commit.

## File responsibilities

| File | Responsibility |
|---|---|
| `skills/{rescue,review,adversarial-review,status}/SKILL.md` | Canonical shell adapter and 60-second same-handle observation |
| `skills/{rescue-mcp,review-mcp,adversarial-review-mcp,status-mcp}/` | Generated explicit-only MCP Skill surface and UI metadata |
| `agents/zcode-rescue.toml.template` | One existing Rescue Role with exact shell and MCP task-free assignments |
| `scripts/generate-mcp-skills.mjs` | Deterministically derive MCP siblings and reject unallowlisted drift |
| `scripts/lib/rescue-preparation.mjs` | Version-5 adapter-bearing preparation with v3/v4 shell compatibility |
| `scripts/lib/rescue-route-planner.mjs` | Admit v5 without changing route or binding selection semantics |
| `scripts/lib/invocation.mjs` | Persist and atomically consume the originating Rescue adapter on choice |
| `scripts/lib/mcp-invocation-context.mjs` | Parse and brand trusted per-call thread/turn/workspace metadata |
| `scripts/lib/direct-invocation-result.mjs` | One shell/MCP rendering and control-outcome mapping |
| `scripts/lib/codex-app-server.mjs` | Bounded current-Child-turn Host correlation used by MCP Rescue preflight |
| `scripts/zcode-companion.mjs` | Existing deep entry; adapter and trusted-turn revalidation before atomic consume |
| `scripts/zcode-mcp-server.mjs` | Long-lived stdio MCP server with fixed empty-input tool schemas |
| `.mcp.json` | `zcode_companion` server declaration and 100-hour production tool ceiling |
| `tools/mcp-context-probe/server.mjs` | Disposable real-Host metadata/cancellation/timeout qualification server |
| `tools/mcp-context-probe/build-fixture.mjs` | Build an installable temporary probe-only plugin, never the production root |
| `tools/mcp-context-probe/qualify.mjs` | Drive and collect the repeatable real-Host qualification matrix |
| `tools/mcp-context-probe/observer.mjs` | Mode-0600 append-only evidence surviving server disconnect/exit |
| `tests/e2e/codex-mcp-context-e2e.test.mjs` | Opt-in real-Host gate; no provider/ZCode task execution |
| `tests/mcp-*.test.mjs` | Unit/contract tests for metadata, result mapping, schemas, and cancellation |
| `tests/rescue-preparation.test.mjs`, `tests/invocation.test.mjs` | Version-5 and pending-choice adapter contracts |
| `tests/skills-contracts.test.mjs`, `tests/codex-rescue-qualification.test.mjs` | Generated Skill/Role parity and exact Child assignment behavior |
| `tests/integration/{skills,companion,plugin-layout,package-install,marketplace-install}.test.mjs` | End-to-end adapter, package, and installed-layout parity |
| `scripts/lib/codex-config.mjs` | Setup-visible packaged/qualified MCP diagnostics |
| `package.json`, `npm-shrinkwrap.json` | MCP SDK bundled runtime dependency and shipped `.mcp.json`/server assets |
| `scripts/build-marketplace-snapshot.mjs`, `tests/marketplace-snapshot.test.mjs` | Snapshot payload and provenance coverage |
| `README.md`, `README.zh-CN.md`, `SECURITY.md`, `CHANGELOG.md` | Public experiment, security boundary, and operational guidance |

## Task 1: Set the canonical shell adapter to fixed 60-second empty waits

**Files:**
- Modify: `skills/rescue/SKILL.md`
- Modify: `skills/review/SKILL.md`
- Modify: `skills/adversarial-review/SKILL.md`
- Modify: `skills/status/SKILL.md`
- Modify: `agents/zcode-rescue.toml.template`
- Modify: `tests/skills-contracts.test.mjs`
- Modify: `tests/codex-rescue-qualification.test.mjs`
- Modify: `tests/helpers/rescue-skill-contract.mjs`

- [ ] **Step 1: Write failing canonical wait-contract tests**

Require every canonical foreground command to request an initial yield up to 30000 ms, then observe only the returned handle with empty input and exactly 60000 ms:

```js
for (const name of ['review', 'adversarial-review', 'status']) {
  const source = skill(name);
  assert.match(source, /initial `exec_command`[^\n]+30000/);
  assert.match(source, /empty-input `write_stdin`[^\n]+60000/);
  assert.match(source, /same (?:process )?handle/i);
  assert.doesNotMatch(source, /write_stdin[^\n]+chars[^\n]+[^"'`\s]/i);
}

for (const source of [skill('rescue'), roleTemplate]) {
  assert.match(source, /initial[^\n]+30000/);
  assert.match(source, /empty-input[^\n]+60000/);
  assert.doesNotMatch(source, /yield-time_ms:\s*300000/);
}
```

Retain the separate assertion that Rescue preparation sends exactly one JSON frame plus LF after `preparation-input-ready`.

- [ ] **Step 2: Run tests to verify RED**

Run: `node --test tests/skills-contracts.test.mjs tests/codex-rescue-qualification.test.mjs`

Expected: FAIL because Rescue still says 300000 ms and the other Skills do not state the fixed observation contract.

- [ ] **Step 3: Update only the shell observation regions**

Use this exact behavior in all four canonical Skills and both named/generic Rescue forwarder instructions:

```text
Start the constant command once with the longest initial exec_command yield, up to 30000 ms. If it returns a live process handle, observe only that handle with empty-input write_stdin calls using yield_time_ms: 60000. Send no characters, do not start another process, and do not replace terminal observation with Status polling or sleep. This applies identically to Rescue's named and generic Role assignments; the initial launcher yield is 30000, subsequent same-handle observations are 60000.
```

Do not change Rescue's intentional one-frame preparation write or its exact status sidecar rules.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `node --test tests/skills-contracts.test.mjs tests/codex-rescue-qualification.test.mjs tests/integration/skills.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/rescue/SKILL.md skills/review/SKILL.md skills/adversarial-review/SKILL.md skills/status/SKILL.md agents/zcode-rescue.toml.template tests/skills-contracts.test.mjs tests/codex-rescue-qualification.test.mjs tests/helpers/rescue-skill-contract.mjs
git commit -m "fix: lengthen canonical foreground observations"
```

## Task 2: Prove the real Codex MCP invocation contract

**Files:**
- Create: `tools/mcp-context-probe/.codex-plugin/plugin.json`
- Create: `tools/mcp-context-probe/.agents/plugins/marketplace.json.template`
- Create: `tools/mcp-context-probe/server.mjs`
- Create: `tools/mcp-context-probe/.mcp.json`
- Create: `tools/mcp-context-probe/skills/context/SKILL.md`
- Create: `tools/mcp-context-probe/skills/context/agents/openai.yaml`
- Create: `tools/mcp-context-probe/build-fixture.mjs`
- Create: `tools/mcp-context-probe/qualify.mjs`
- Create: `tools/mcp-context-probe/observer.mjs`
- Create: `tests/e2e/codex-mcp-context-e2e.test.mjs`
- Create: `tests/mcp-context-probe.test.mjs`
- Create: `docs/qualification/zcode-mcp-context.md`
- Create: `qualification/mcp-context.json`
- Modify: `package.json`
- Modify: `npm-shrinkwrap.json`

- [ ] **Step 1: Install the probe/runtime SDK dependency**

Run: `npm install --save-exact @modelcontextprotocol/sdk@1.30.0`

Expected: `package.json` contains production dependency `"@modelcontextprotocol/sdk": "1.30.0"` and the shrinkwrap records it. The production server added later reuses this exact dependency.

- [ ] **Step 2: Write the probe fixture and observer tests first**

`build-fixture.mjs --output <empty-dir> --server <absolute-source-server>` must create a complete local marketplace, not a bare plugin directory:

```text
<output>/.agents/plugins/marketplace.json
<output>/plugins/zcode-mcp-context-probe/.codex-plugin/plugin.json
<output>/plugins/zcode-mcp-context-probe/.mcp.json
<output>/plugins/zcode-mcp-context-probe/skills/context/{SKILL.md,agents/openai.yaml}
```

The marketplace name is `zcode-mcp-probe`, its sole local plugin is `zcode-mcp-context-probe`, and the only Skill is explicitly invoked as `$zcode-mcp-context-probe:context`. The generated descriptor uses the validated absolute server path, so its SDK resolves from this worktree; the temporary marketplace never adds an MCP descriptor to the production plugin before the gate. Tests parse the generated marketplace, resolve its local source path, validate both manifests, and reject output outside the supplied empty mode-0700 directory.

The probe modules expose these exact testable interfaces:

```js
export declare function buildProbeMarketplace(input: { output:string, server:string, toolTimeoutSec:2|30 }): Promise<void>;
export declare function appendProbeEvent(input: { runDirectory:string, runNonce:string, event:ProbeEvent }): Promise<void>;
export declare function readProbeEvents(input: { runDirectory:string, runNonce:string }): Promise<ProbeEvent[]>;
export declare function reduceProbeResult(input: { runDirectory:string, runNonce:string }): Promise<ProbeResult>;
export declare function qualifyMcpContext(input: { codexPath:string, runDirectory:string }): Promise<ProbeResult>;
```

These are interface declarations, not implementation snippets. Each function's complete required behavior, filesystem modes, validation, locking, subprocess commands, and result schema are specified by Steps 2–7 and their tests. Implementation must not add options or ambient fallbacks.

`observer.mjs` owns `<run>/events.jsonl`; the final reducer alone owns `<run>/result.json`. Each event contains only a random probe-run nonce, a closed event enum, a call nonce, and hashes/equality booleans—never raw metadata. Every append runs under the existing `withFileLock(<run>/events.lock, ...)`, opens the mode-0600 JSONL with `O_NOFOLLOW`, appends, fsyncs, and closes, so concurrent servers and disconnect/exit are durable. Reject symlinks, pre-existing wrong-mode files, duplicate terminal events, oversized files, and foreign run nonces. After every Host/server process exits, the driver takes the same lock, validates the complete log, and atomically writes mode-0600 `result.json`; no MCP handler writes or overwrites the result.

Run: `node --test tests/mcp-context-probe.test.mjs`

Expected: FAIL because the installable fixture, durable observer, and collector do not exist.

- [ ] **Step 3: Write the opt-in qualification assertion test**

The test must skip unless `ZCODE_CODEX_MCP_E2E=1`; when enabled it reads only a private probe artifact path supplied in `ZCODE_MCP_PROBE_RESULT` and validates this closed, redacted shape:

```js
assert.deepEqual(Object.keys(result).sort(), [
  'cancelDelivered', 'concurrentChildrenDistinct', 'connectionLossDelivered',
  'laterTurnDistinct', 'metadataChangesAcrossTurns', 'rootContextComplete',
  'shortTimeoutSettled', 'workspaceDistinct',
]);
for (const value of Object.values(result)) assert.equal(value, true);
```

The result must contain booleans only—no raw thread, turn, workspace, task, binding, or job values.

- [ ] **Step 4: Run the opt-in test to verify RED**

Run: `ZCODE_CODEX_MCP_E2E=1 ZCODE_MCP_PROBE_RESULT=/nonexistent node --test tests/e2e/codex-mcp-context-e2e.test.mjs`

Expected: FAIL with `MCP probe result is unavailable`.

- [ ] **Step 5: Implement the installable disposable stdio probe**

Use `@modelcontextprotocol/sdk`'s low-level `Server`, `ListToolsRequestSchema`, `CallToolRequestSchema`, and `StdioServerTransport`. Expose only:

```js
const tools = [
  'capture_context',       // validates and hashes per-call metadata into durable evidence
  'hold_until_cancelled',  // resolves only after extra.signal aborts
  'read_assertions',       // reduces durable evidence to the closed boolean result
];
```

Read metadata from `request.params._meta`; never accept identity arguments. Hash raw values immediately with the per-run nonce and retain no raw value. Compare root, initial Child, later same-Child turn, two concurrent children, and two workspaces by hash equality/inequality. `metadataChangesAcrossTurns` proves that the Host supplies a different current-turn identity after the follow-up; it does not claim that the Host itself rejects a replayed stale request. Every handler writes its start and settlement event through the durable observer before returning. `read_assertions` returns an in-memory preview reduced under the event lock but does not write `result.json`. The short-timeout fixture uses `tool_timeout_sec: 2` and `shortTimeoutSettled` is true only when the final reducer sees an abort/settled event for that exact held-call nonce after its start. `connectionLossDelivered` is likewise reduced from durable server-side settlement written before process exit. Stale/wrong metadata rejection remains a local `mcp-invocation-context` and authority-join contract test in Task 4, not a fabricated real-Host result.

The source `.mcp.json` is only a template. `build-fixture.mjs` emits the plugin-root descriptor declaring only this probe server with `node <absolute-server>`, starts with `tool_timeout_sec: 30`, and can emit a separate 2-second marketplace. The fixture identity cannot collide with production `zcode`.

- [ ] **Step 6: Implement one exact qualification driver and execute it**

`qualify.mjs` treats `--codex <entry-path>` as an externally supplied qualification target. It resolves one launcher symlink with `realpath`, requires the canonical target to be a regular executable file, records its device/inode and `<canonical-path> --version`, and rechecks all three before every spawn; it never calls PATH internally and does not call this binary repository-locked. It requires `--source-codex-home <dir>`, opens that real directory and its regular nonsymlink `auth.json`, copies only that file into fresh `<run>/codex-home/auth.json`, chmods it 0600, and requires `login status` to pass. Missing/unusable authentication reports `qualification-unavailable`, not protocol failure. No auth path or bytes enter logs, result artifacts, MCP arguments, or MCP `env_vars`.

It creates fresh 30-second and 2-second marketplaces, workspaces A/B, isolated HOME/USERPROFILE, and the isolated Codex home inside one mode-0700 `mkdtemp` run directory. Every plugin command and Host process uses those homes. The 30-second phase executes exactly:

```bash
CODEX_HOME=<run>/codex-home <codex> plugin marketplace add <absolute-marketplace-root> --json
CODEX_HOME=<run>/codex-home <codex> plugin add zcode-mcp-context-probe@zcode-mcp-probe --json
```

The generated descriptor has exactly `env_vars: ["ZCODE_MCP_PROBE_EVENTS","ZCODE_MCP_PROBE_LOCK","ZCODE_MCP_PROBE_NONCE"]`; this is only an allowlist. Before every Host spawn, the driver explicitly sets `env.ZCODE_MCP_PROBE_EVENTS=<run>/events.jsonl`, `env.ZCODE_MCP_PROBE_LOCK=<run>/events.lock`, and `env.ZCODE_MCP_PROBE_NONCE=<runNonce>` (plus isolated `CODEX_HOME`, `HOME`, `USERPROFILE`). The driver asserts the server's first durable event contains the same nonce and canonical event/lock paths. It starts a fresh real Host after installation and drives one scripted qualification conversation. The driver uses this fixed base argv for new conversations:

```text
exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox
  --ignore-user-config -C <workspace> <prompt>
```

and this fixed argv for continuations, launched with process cwd equal to the target workspace:

```text
exec resume --json --all --skip-git-repo-check
  --dangerously-bypass-approvals-and-sandbox --ignore-user-config <root-thread-id> <prompt>
```

The state machine is exact:

```js
const MATRIX_PROMPT = 'Use $zcode-mcp-context-probe:context. Call capture_context once in Root. Spawn one Child, have it call capture_context, wait for it, then follow up that exact Child and have it call capture_context again. Then spawn two new Children concurrently and have each call capture_context once. Wait for both. Do not call any other MCP tool.';
const WORKSPACE_B_PROMPT = 'Use $zcode-mcp-context-probe:context and call capture_context exactly once in Root. Do not spawn a Child.';
const HOLD_PROMPT = 'Use $zcode-mcp-context-probe:context and call hold_until_cancelled exactly once. Wait for that tool and do nothing else.';
```

1. Run one workspace-A `codex exec` prompt that requires Root `capture_context`, one Child capture, `followup_task` to that exact Child for a second capture, and two additional concurrently spawned Child captures. Parse stdout strictly as bounded JSONL; require exactly one `thread.started.thread_id`, zero malformed frames, exit 0, and the corresponding durable event count before continuing.
2. Launch `codex exec resume ... --all <root-thread-id>` with cwd workspace B and require one Root `capture_context`; require exit 0 and its durable event.
3. Launch a separate workspace-A `codex exec` asking only for `hold_until_cancelled`; after the exact call nonce's durable `hold-started` event appears, send SIGINT to the recorded Codex PID. Require exit within 10 seconds and a matching abort/settled event; otherwise SIGKILL the exact PID and fail the cancel assertion.
4. Launch another held call; after its durable start event, SIGKILL the exact Codex PID to close stdio. Require the server-side connection-close/abort settlement within 10 seconds and no surviving recorded Host PID.
5. Stop remaining phase-30 Host/server processes, then remove its plugin and marketplace. Do not install the 2-second fixture before both removal commands succeed.
6. Repeat the exact marketplace-add/plugin-add commands against the 2-second marketplace under the same names, then start a new workspace-A Host with `HOLD_PROMPT`. Require `hold-started`, Host timeout/exit within 30 seconds, and the matching durable abort/settled event.
7. Stop phase-2 processes and remove its plugin/marketplace. Under the event lock, reduce the shared log and atomically write `<run>/result.json`; then run the opt-in assertion test.

Every subprocess has a 180-second outer deadline and bounded 4 MiB stdout/stderr. The driver tracks PID plus start identity before signalling, never uses process-name matching, and runs ordered cleanup in `finally`. Failure to stop a process, remove the plugin/marketplace, delete isolated `auth.json`, or remove the temporary homes makes qualification fail with a redacted cleanup error.

Cleanup commands are exact and run even after failure:

```bash
CODEX_HOME=<run>/codex-home <codex> plugin remove zcode-mcp-context-probe@zcode-mcp-probe --json
CODEX_HOME=<run>/codex-home <codex> plugin marketplace remove zcode-mcp-probe --json
```

Run:

```bash
probe_run="$(mktemp -d "${TMPDIR:-/tmp}/zcode-mcp-probe.XXXXXX")"
chmod 700 "$probe_run"
node tools/mcp-context-probe/qualify.mjs \
  --codex "$(command -v codex)" \
  --source-codex-home "${CODEX_HOME:-$HOME/.codex}" \
  --run-directory "$probe_run"
ZCODE_CODEX_MCP_E2E=1 ZCODE_MCP_PROBE_RESULT="$probe_run/result.json" \
  node --test tests/e2e/codex-mcp-context-e2e.test.mjs
```

Expected: the driver prints its exact marketplace-add/plugin-add/start/interrupt/disconnect/plugin-remove/marketplace-remove transcript with identifiers redacted, then the test PASSes with all eight booleans true. Record the exact noninteractive continuation mechanism exposed by the supplied Codex version; if it exposes no reproducible same-Child later turn or explicit interrupt, mark the gate failed rather than converting the check to a unit test.

- [ ] **Step 7: Apply the hard gate and freeze the observed protocol**

If authentication is unavailable, do not commit Task 2's dependency or probe changes; report `qualification-unavailable` and preserve only the already committed Task 1. If authentication succeeds but any protocol assertion is false, write a redacted `docs/qualification/zcode-mcp-context.md` failure report (no machine-readable qualified record), then stop this plan after committing only Task 1 and the probe harness:

```bash
git add tools/mcp-context-probe tests/mcp-context-probe.test.mjs tests/e2e/codex-mcp-context-e2e.test.mjs docs/qualification/zcode-mcp-context.md package.json npm-shrinkwrap.json
git commit -m "test: record unsupported codex mcp context"
```

The failure branch must prove `git status --short` contains no production root `.mcp.json`, no `skills/*-mcp`, no `scripts/zcode-mcp-server.mjs`, and no `qualification/mcp-context.json`. Amend the design with the observed bounded fact before any MCP production work. The success branch alone creates and commits `qualification/mcp-context.json`.

If all assertions pass, record the supported Codex version, exact install/launch commands, exact trusted metadata field names and JSON types, workspace normalization observed, abort delivery ordering, timeout result, and disconnect result in the qualification document without recording identity values. Generate and commit `qualification/mcp-context.json` with exact keys `{version:1,status:'qualified',codexVersion,contextSchemaVersion,metadataFields,observedAt}` and no identity values. Replace every `QUALIFIED_*` token in Tasks 3–10 with those exact facts, add exact expected error/result shapes, and obtain an independent plan re-review before continuing.

- [ ] **Step 8: Commit the passing probe harness and evidence contract**

```bash
git add tools/mcp-context-probe tests/mcp-context-probe.test.mjs tests/e2e/codex-mcp-context-e2e.test.mjs docs/qualification/zcode-mcp-context.md qualification/mcp-context.json package.json npm-shrinkwrap.json
git commit -m "test: qualify codex mcp invocation context"
```

## Task 3: Add adapter-bearing Rescue preparation and choice state

**Files:**
- Modify: `scripts/lib/rescue-preparation.mjs`
- Modify: `scripts/lib/rescue-route-planner.mjs`
- Modify: `scripts/lib/invocation.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Modify: `tests/rescue-preparation.test.mjs`
- Modify: `tests/rescue-route-planner.test.mjs`
- Modify: `tests/invocation.test.mjs`
- Modify: `tests/integration/companion.test.mjs`

- [ ] **Step 1: Write failing version-5 tests**

Add helpers and exact assertions:

```js
const v5 = (foregroundAdapter) => ({
  version: 5,
  source: 'explicit',
  task: 'repair the parser',
  options: {
    hostPlacement: 'foreground',
    companionExecution: 'foreground',
    foregroundAdapter,
    resume: 'fresh',
  },
  continuationTarget: null,
});

for (const adapter of ['shell', 'mcp']) {
  assert.deepEqual(validateRescuePreparation(v5(adapter)), v5(adapter));
}
for (const adapter of [undefined, 'auto', 'MCP']) {
  assert.throws(() => validateRescuePreparation(v5(adapter)), { code: 'RESCUE_PREPARATION_INVALID' });
}
```

Assert v4 and v3 remain readable and imply `shell`. Feed v5 through `validRescueSelectionRequest` and `planRescueActivation` for fresh and continuation routes and require the same route directives as equivalent v4. Assert pending Rescue choice records persist the v5 envelope and reject a choice whose expected adapter differs. Assert adapter mismatch occurs before job reservation and provider calls.

- [ ] **Step 2: Run tests to verify RED**

Run: `node --test tests/rescue-preparation.test.mjs tests/rescue-route-planner.test.mjs tests/invocation.test.mjs tests/integration/companion.test.mjs`

Expected: FAIL because version 5 and `foregroundAdapter` are unknown.

- [ ] **Step 3: Implement the closed version-5 codec**

Use:

```js
export const RESCUE_PREPARATION_VERSION = 5;
const LEGACY_RESCUE_ENVELOPE_VERSIONS = new Set([3, 4]);
const FOREGROUND_ADAPTERS = new Set(['shell', 'mcp']);
const V5_OPTION_KEYS = new Set([
  'companionExecution', 'effort', 'foregroundAdapter',
  'hostPlacement', 'model', 'resume',
]);
```

Version 5 requires the exact adapter. Version 4 retains split placement and implies shell; version 3 retains coupled placement and implies shell. Preserve all task, selector, activation, expiry, duplicate-key, and one-shot rules.

In `rescue-route-planner.mjs`, make 5 the current version and admit exactly `{3,4,5}` wherever the shared selection request validates an envelope. Keep continuation-target and route-selection rules identical. Run `rg -n "version === 4|version !== 4|version: 4|\\[3, 4\\]" scripts/lib/rescue-route-planner.mjs scripts/zcode-companion.mjs scripts/lib/invocation.mjs scripts/lib/rescue-preparation.mjs` and classify every production match as v5-native or intentional legacy translation in the commit notes.

Add required `expectedForegroundAdapter` to the private runtime used by `runDirectInvocation` for Rescue initial/choice only. The shell CLI supplies `shell`; MCP handlers later supply `mcp`. Revalidate it inside locked `consume()` and `consumePending()`. Update all existing `zcode-companion.mjs` version conversions: `tombstoneEnvelopeFromReceipt` passes v5 through and translates v3/v4 to v5+shell; `replayHostPlacementFromReceipt` reads split placement for v4/v5; companion/host placement selection reads split placement for v4/v5. Preserve v5 adapter in pending-fresh state and emit shell only while translating legacy state.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `node --test tests/rescue-preparation.test.mjs tests/rescue-route-planner.test.mjs tests/invocation.test.mjs tests/integration/companion.test.mjs`

Expected: PASS, including shell compatibility and pre-reservation mismatch refusal.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/rescue-preparation.mjs scripts/lib/rescue-route-planner.mjs scripts/lib/invocation.mjs scripts/zcode-companion.mjs tests/rescue-preparation.test.mjs tests/rescue-route-planner.test.mjs tests/invocation.test.mjs tests/integration/companion.test.mjs
git commit -m "feat: bind rescue preparation to wait adapter"
```

## Task 4: Build the trusted MCP invocation-context boundary

**Files:**
- Create: `scripts/lib/mcp-invocation-context.mjs`
- Modify: `scripts/lib/codex-app-server.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Create: `tests/mcp-invocation-context.test.mjs`
- Modify: `tests/codex-app-server.test.mjs`
- Modify: `tests/integration/companion.test.mjs`

- [ ] **Step 1: Write failing parser and authority-join tests**

After Task 2 has replaced the `QUALIFIED_*` symbols, cover those exact accepted metadata fields and reject missing, extra, control-bearing, oversized, stale, wrong-workspace, wrong-turn, wrong-child, and concurrent-child substitutions. The public API is:

```js
const authority = resolveMcpInvocationContext(request.params._meta);
assert.deepEqual(readMcpInvocationContext(authority), {
  threadId: 'child-thread',
  turnId: 'current-child-turn',
  workspace: '/canonical/workspace',
});
```

`readMcpInvocationContext` must accept only a factory-branded in-process object. Add app-server tests for:

```js
await readCodexThreadCurrentTurnIdentity(childThreadId, options);
// => { threadId, turnId, workspace }
```

The reader must require the current/latest active turn for the exact thread and canonical workspace and stay bounded/abortable.

- [ ] **Step 2: Run tests to verify RED**

Run: `node --test tests/mcp-invocation-context.test.mjs tests/codex-app-server.test.mjs tests/integration/companion.test.mjs`

Expected: FAIL because the module, branded authority, and current-turn reader do not exist.

- [ ] **Step 3: Implement strict metadata parsing and branding**

Use a module-private `WeakSet` and return a frozen object. Parse only the Task-2-qualified per-call fields. Canonicalize workspace with the same native realpath rule as direct invocation, then preserve its exact value for comparison. The fixed server mapping supplies `canonicalSkill` (`$zcode:rescue`, `$zcode:review`, `$zcode:adversarial-review`, or `$zcode:status`); it is never a tool argument. Errors use one fixed code and that exact fallback:

```js
throw new PluginError(
  'MCP_INVOCATION_CONTEXT_UNAVAILABLE',
  'The trusted Codex MCP invocation context is unavailable.',
  { category: 'authorization', remedy: `Use the canonical ${canonicalSkill} Skill.` },
);
```

- [ ] **Step 4: Join context before atomic business consumption**

In `runDirectInvocation`:

Use this command-specific join table; there is no “origin-or-effective” alternative:

| MCP tool family | Authority thread | Authority turn | Authority workspace | Durable/Host join before consume |
|---|---|---|---|---|
| Review, Adversarial Review, Status initial/wait | active Root `CallerContext.sessionId` | active Root `CallerContext.turnId` | Host invocation cwd = `realpath(CallerContext.originWorkspace)` | `resolveActiveTurn` by origin first; then independently select/verify `CallerContext.workspace` as job execution workspace |
| prepared Rescue | routed `executor.agentId` / exact Host Child thread | current active turn returned for that exact Child | Host Child cwd = `realpath(executor.originWorkspace)` | resolve exact executor from Child thread+cwd; then independently require resolved `executionWorkspace === preparation.workspace`; preparation remains unconsumed |
| Rescue resume/fresh choice | pending record's exact `executorAgentId` / exact Host Child thread | current active later turn returned for that exact Child | Host Child cwd = `realpath(executor.originWorkspace)` | resolve exact executor from Child thread+cwd; then independently require resolved `executionWorkspace === pending.workspace`; no preparation lookup |

For each row, validate the branded metadata shape, canonicalize the Host invocation workspace, query the exact current Host turn, resolve the exact Root/Child authority at that origin cwd, then separately validate the selected execution workspace and route joins before locked `consume()`/`consumePending()`. Never use invocation cwd as the selected execution workspace merely because they are equal in a simple checkout. Any failure returns `MCP_INVOCATION_CONTEXT_UNAVAILABLE` with zero preparation consumption, reservation, binding mutation, session creation, or provider call. Never compare a later Child turn to the executor's initial `childTurnId` or the receipt's parent `originatingTurnId`.

The deep invocation API is explicit and cannot consult ambient MCP-shaped environment variables:

```js
await runDirectInvocation(argv, {
  cwd, env, signal,
  invocationTransport: 'mcp',
  mcpAuthority: authority,
  expectedForegroundAdapter: argv[0].startsWith('invoke') && argv.includes('rescue') ? 'mcp' : undefined,
});
```

When `invocationTransport === 'mcp'`, a branded `mcpAuthority` is mandatory and `CODEX_THREAD_ID`, cwd, process environment, and argv are never accepted as authority. When transport is `shell`, `mcpAuthority` is forbidden. This discriminated boundary is checked before command dispatch.

The exact metadata extractor remains intentionally named with placeholders until the gate amendment:

```js
const raw = request.params?._meta;
const identity = {
  threadId: raw.QUALIFIED_THREAD_FIELD,
  turnId: raw.QUALIFIED_TURN_FIELD,
  workspace: raw.QUALIFIED_WORKSPACE_FIELD,
};
```

- [ ] **Step 5: Run tests to verify GREEN**

Run: `node --test tests/mcp-invocation-context.test.mjs tests/codex-app-server.test.mjs tests/integration/companion.test.mjs`

Expected: PASS with zero reservation/provider side effects for every rejected context.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/mcp-invocation-context.mjs scripts/lib/codex-app-server.mjs scripts/zcode-companion.mjs tests/mcp-invocation-context.test.mjs tests/codex-app-server.test.mjs tests/integration/companion.test.mjs
git commit -m "feat: validate trusted mcp invocation context"
```

## Task 5: Centralize shell and MCP result mapping

**Files:**
- Create: `scripts/lib/direct-invocation-result.mjs`
- Modify: `scripts/zcode-companion.mjs`
- Create: `tests/mcp-result.test.mjs`
- Modify: `tests/integration/companion.test.mjs`

- [ ] **Step 1: Write failing transport-parity tests**

Define fixtures for ordinary terminal output, nonterminal Status snapshot, queued/background output, `needs-choice`, `parent-replan`, PluginError, and `JOB_INTERRUPTED`. Require:

```js
assert.deepEqual(formatDirectInvocationSuccess(needsChoice), {
  text: renderOutput(needsChoice), outcome: 'needs-choice', isError: false, exitCode: 3, stderr: '',
});
assert.equal(formatDirectInvocationSuccess(statusSnapshot).outcome, 'terminal');
assert.equal(formatDirectInvocationSuccess(queued).outcome, 'terminal');
assert.equal(formatDirectInvocationError(pluginError).isError, true);
assert.equal(formatDirectInvocationError(interrupted).text, '');
```

For every fixture, assert MCP text equals CLI stdout byte-for-byte.

Lock the interruption contract to the Task-2 observation before starting Task 3: if the Host delivers `extra.signal`, the handler awaits existing cleanup and then returns the observed MCP result shape; if the Host discards a cancelled/timed-out response, assert the formatter result at the handler boundary plus the durable settlement marker. Connection loss uses the same abort path and may have no deliverable MCP response. The Task-2 gate amendment must write the exact observed response/discard behavior here and the independent re-review must approve it; no worker may implement Task 5 while this sentence remains unresolved.

- [ ] **Step 2: Run tests to verify RED**

Run: `node --test tests/mcp-result.test.mjs tests/integration/companion.test.mjs`

Expected: FAIL because mapping is embedded in `runCompanionCli`.

- [ ] **Step 3: Extract the pure shared formatter**

Return only `{text, stderr, exitCode, outcome, isError}`. Use `renderOutput(output)` for success and `renderOutput(errorEnvelope(error), {json:true})` for ordinary errors. Preserve shell's interruption behavior: empty stdout, bounded interruption stderr, signal exit code. MCP maps that same interruption to the exact response shape recorded by Task 2 before Host delivery/discard. Map only `needs-choice`, `parent-replan`, and error specially; all other completed tool invocations are `terminal`.

Refactor `runCompanionCli` to apply the formatter without changing completion-notice delivery, background failure handling, or process-signal cleanup.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `node --test tests/mcp-result.test.mjs tests/integration/companion.test.mjs tests/render-progress.test.mjs`

Expected: PASS with unchanged CLI bytes and exit codes.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/direct-invocation-result.mjs scripts/zcode-companion.mjs tests/mcp-result.test.mjs tests/integration/companion.test.mjs
git commit -m "refactor: share direct invocation result mapping"
```

## Task 6: Add the narrow production MCP server

**Files:**
- Create: `.mcp.json`
- Create: `scripts/zcode-mcp-server.mjs`
- Modify: `package.json`
- Modify: `npm-shrinkwrap.json`
- Create: `tests/mcp-server.test.mjs`
- Modify: `tests/plugin-contracts.test.mjs`
- Modify: `tests/integration/plugin-layout.test.mjs`

- [ ] **Step 1: Write failing server and descriptor tests**

Require `.mcp.json` to contain exactly one enabled server:

```json
{
  "mcpServers": {
    "zcode_companion": {
      "command": "node",
      "args": ["./scripts/zcode-mcp-server.mjs"],
      "cwd": ".",
      "enabled": true,
      "env_vars": [
        "CLAUDE_PLUGIN_DATA", "CODEX_HOME", "HOME", "PATH",
        "PLUGIN_DATA", "USERPROFILE", "ZCODE_DATA_ROOT", "ZCODE_PATH"
      ],
      "startup_timeout_sec": 10,
      "tool_timeout_sec": 360000
    }
  }
}
```

Allow only the environment variables required by existing plugin-data/ZCode discovery; do not pass thread, turn, workspace, task, binding, or permission values. Keep `.codex-plugin/plugin.json` unchanged and assert it still rejects `mcpServers`.

Require the server's `tools/list` result to contain exactly:

```js
[
  'choose_adversarial_review_wait', 'choose_rescue_fresh',
  'choose_rescue_resume', 'choose_review_wait',
  'invoke_adversarial_review', 'invoke_prepared_rescue',
  'invoke_review', 'invoke_status',
]
```

Every input schema is `{type:'object',properties:{},additionalProperties:false}`. Task 6 runs from the worktree dependency installed by Task 2; distributable bundling is owned solely by Task 9.

- [ ] **Step 2: Run tests to verify RED**

Run: `node --test tests/mcp-server.test.mjs tests/plugin-contracts.test.mjs tests/integration/plugin-layout.test.mjs`

Expected: FAIL because the production descriptor/server do not exist.

- [ ] **Step 3: Implement fixed handlers**

Use this immutable mapping:

```js
const TOOL_INVOCATIONS = Object.freeze({
  invoke_prepared_rescue: { argv: ['invoke-prepared', 'rescue'], adapter: 'mcp', canonicalSkill: '$zcode:rescue' },
  choose_rescue_resume: { argv: ['invoke-choice', 'rescue', 'resume'], adapter: 'mcp', canonicalSkill: '$zcode:rescue' },
  choose_rescue_fresh: { argv: ['invoke-choice', 'rescue', 'fresh'], adapter: 'mcp', canonicalSkill: '$zcode:rescue' },
  invoke_review: { argv: ['invoke', 'review'], canonicalSkill: '$zcode:review' },
  choose_review_wait: { argv: ['invoke-choice', 'review', 'wait'], canonicalSkill: '$zcode:review' },
  invoke_adversarial_review: { argv: ['invoke', 'adversarial-review'], canonicalSkill: '$zcode:adversarial-review' },
  choose_adversarial_review_wait: { argv: ['invoke-choice', 'adversarial-review', 'wait'], canonicalSkill: '$zcode:adversarial-review' },
  invoke_status: { argv: ['invoke', 'status'], canonicalSkill: '$zcode:status' },
});
```

For each call: reject nonempty arguments; resolve the branded context from `_meta`; call `runDirectInvocation` once with fixed argv, canonical cwd, `invocationTransport:'mcp'`, `mcpAuthority`, `expectedForegroundAdapter`, and `extra.signal`; do not inject `CODEX_THREAD_ID` for MCP. Map through Task 5 and return:

```js
{
  content: [{ type: 'text', text: formatted.text }],
  structuredContent: { outcome: formatted.outcome },
  isError: formatted.isError,
}
```

Never exit the server for a tool result and never retry or fall back to shell.

The server entry uses a dependency-injected export for tests and one executable wrapper:

```js
export function createZcodeMcpServer({ runDirectInvocationImpl = runDirectInvocation } = {}) {
  const server = new Server({ name: 'zcode_companion', version: pluginVersion }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    invokeMappedTool({ request, extra, runDirectInvocationImpl }));
  return server;
}
if (isMain(import.meta.url)) await createZcodeMcpServer().connect(new StdioServerTransport());
```

Handler cancellation is `extra.signal` only after Task 2 confirms it; otherwise the gate fails and this task is not executed.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `node --test tests/mcp-server.test.mjs tests/plugin-contracts.test.mjs tests/integration/plugin-layout.test.mjs`

Expected: PASS, including cancellation forwarded through the qualified signal and an alive server after error results.

- [ ] **Step 5: Commit**

```bash
git add .mcp.json scripts/zcode-mcp-server.mjs package.json npm-shrinkwrap.json tests/mcp-server.test.mjs tests/plugin-contracts.test.mjs tests/integration/plugin-layout.test.mjs
git commit -m "feat: expose narrow zcode mcp wait tools"
```

## Task 7: Generate explicit-only MCP Skill siblings and dual Rescue assignments

**Files:**
- Create: `scripts/generate-mcp-skills.mjs`
- Create: `skills/rescue-mcp/SKILL.md`
- Create: `skills/rescue-mcp/agents/openai.yaml`
- Create: `skills/review-mcp/SKILL.md`
- Create: `skills/review-mcp/agents/openai.yaml`
- Create: `skills/adversarial-review-mcp/SKILL.md`
- Create: `skills/adversarial-review-mcp/agents/openai.yaml`
- Create: `skills/status-mcp/SKILL.md`
- Create: `skills/status-mcp/agents/openai.yaml`
- Modify: `skills/rescue/SKILL.md`
- Modify: `agents/zcode-rescue.toml.template`
- Modify: `package.json`
- Modify: `tests/skills-contracts.test.mjs`
- Modify: `tests/managed-agent-role.test.mjs`
- Modify: `scripts/lib/codex-config.mjs`
- Modify: `skills/setup/SKILL.md`
- Modify: `tests/setup.test.mjs`
- Create: `tests/rescue-mcp-contract.test.mjs`

- [ ] **Step 1: Write failing generation/parity tests**

Require twelve Skill directories total, four MCP frontmatter names, and descriptions/default prompts that contain `Only use when the user explicitly names $zcode:<name>-mcp`. Normalize only marked adapter regions, then assert the remaining canonical and MCP text is identical.

Require the single `zcode-rescue` Role to accept exactly six assignments: shell/MCP initial, shell/MCP resume, shell/MCP fresh. MCP assignments map only to the matching raw MCP tool; shell assignments retain the launcher commands. Reject cross-adapter continuation text.

Add a deterministic contract trace that feeds generated `$zcode:rescue-mcp` preparation and the exact MCP Role assignment through the route/handler seams, recording: v5/mcp preparation, prescribed existing Child identity, `invoke_prepared_rescue` mapped call, and pre-provider adapter consume. A negative trace passes the same preparation through the shell launcher and requires `RESCUE_FOREGROUND_ADAPTER_MISMATCH` before reservation/provider activity. This is the local RED/GREEN contract; the independent real-Host proof remains Task 10.

- [ ] **Step 2: Run tests to verify RED**

Run: `node --test tests/skills-contracts.test.mjs tests/managed-agent-role.test.mjs tests/setup.test.mjs tests/rescue-mcp-contract.test.mjs`

Expected: FAIL because MCP siblings and dual assignments do not exist.

- [ ] **Step 3: Add deterministic marked-region generation**

Add paired HTML comment markers around name/description, foreground adapter, Rescue assignment, and MCP interaction regions. The generator must:

```js
generateMcpSkill({ canonical: 'review', sibling: 'review-mcp', tool: 'invoke_review' });
generateMcpSkill({ canonical: 'adversarial-review', sibling: 'adversarial-review-mcp', tool: 'invoke_adversarial_review' });
generateMcpSkill({ canonical: 'status', sibling: 'status-mcp', tool: 'invoke_status' });
generateMcpSkill({ canonical: 'rescue', sibling: 'rescue-mcp', tool: 'invoke_prepared_rescue' });
```

Write atomically with LF endings. Add `"generate:mcp-skills": "node scripts/generate-mcp-skills.mjs"` and `"check:mcp-skills": "node scripts/generate-mcp-skills.mjs --check"` to package scripts. Runtime never invokes the generator.

The MCP Rescue preparation frame uses version 5 with `foregroundAdapter: "mcp"`; canonical Rescue uses `"shell"`. Both use the same route planner and same Child. The Role calls one MCP tool to completion, offers no in-flight status sidecar for MCP, and uses the matching MCP choice tool on later exact continuation.

Extend `runSetup`/`reportAndPersist` in `scripts/lib/codex-config.mjs` with a closed diagnostic:

```js
mcp: {
  packaged: await packagedMcpAssetsPresent(pluginRoot),
  qualification: await readMcpQualificationRecord(pluginRoot),
}
```

The record exposes only `{status:'qualified'|'unqualified', codexVersion, contextSchemaVersion}` from the checked-in redacted Task-2 evidence. Missing descriptor/server/SDK or a running Codex version not exactly equal to the single recorded `codexVersion` reports `unqualified` and tells users to use canonical Skills; a range requires a future record-schema/spec change. Setup never claims that one live invocation is authorized. Update `skills/setup/SKILL.md` to display this field without auto-selecting MCP.

- [ ] **Step 4: Generate files and run tests to verify GREEN**

Run: `npm run generate:mcp-skills && npm run check:mcp-skills && node --test tests/skills-contracts.test.mjs tests/managed-agent-role.test.mjs tests/setup.test.mjs tests/rescue-mcp-contract.test.mjs`

Expected: PASS; a deliberate edit outside a marked sibling region makes `check:mcp-skills` fail.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate-mcp-skills.mjs scripts/lib/codex-config.mjs skills agents/zcode-rescue.toml.template package.json tests/skills-contracts.test.mjs tests/managed-agent-role.test.mjs tests/setup.test.mjs tests/rescue-mcp-contract.test.mjs
git commit -m "feat: add explicit mcp skill variants"
```

## Task 8: Prove lifecycle, placement, cancellation, and output parity

**Files:**
- Modify: `tests/integration/companion.test.mjs`
- Modify: `tests/integration/skills.test.mjs`
- Modify: `tests/integration/true-background-rescue.test.mjs`
- Modify: `tests/rescue-lifecycle.test.mjs`
- Modify: `tests/job-control.test.mjs`
- Modify: `tests/mcp-server.test.mjs`

- [ ] **Step 1: Add failing adapter-parity matrices**

For equivalent recorded state, run shell and MCP adapters and compare:

```js
assert.equal(mcp.content[0].text, shell.stdout);
assert.deepEqual(projectDurableState(mcpState), projectDurableState(shellState));
```

Cover:

- all four Rescue placement rows;
- fresh, resume, needs-choice resume, needs-choice fresh/parent-replan;
- Review and Adversarial Review foreground/background/choice;
- Status snapshot, wait terminal, explicit timeout, and cancellation;
- missing metadata, wrong workspace/turn/Child, concurrent children, and adapter mismatch;
- cancellation before start, during accepted foreground execution, after terminal election, connection loss, and injected host-timeout abort.

Assert execution calls settle through existing interruption paths; Status abort only removes its observer. Assert no duplicate launch, silent shell fallback, second binding state, or additional durable fields.

- [ ] **Step 2: Run the matrix to verify RED**

Run: `node --test tests/mcp-server.test.mjs tests/integration/skills.test.mjs tests/integration/companion.test.mjs tests/integration/true-background-rescue.test.mjs tests/rescue-lifecycle.test.mjs tests/job-control.test.mjs`

Expected: FAIL at any missing abort bridge, choice adapter check, or parity mapping.

- [ ] **Step 3: Implement the already-specified parity bridges**

Make only these changes if the RED matrix requires them: pass the qualified abort signal into the existing `runDirectInvocation` signal slot; translate Task-5 formatted results into MCP content without changing text; carry v5 `foregroundAdapter` through preparation/pending tombstones; apply the Task-4 authority table before atomic consumption. Any failure requiring a change to `runCompanion`, Rescue Binding, StateStore, JobController, Rescue Lifecycle Reconciler, or a newly invented progress protocol stops the plan and requires a spec amendment. MCP progress notifications are absent by design.

- [ ] **Step 4: Run the matrix to verify GREEN**

Run the Step 2 command again.

Expected: PASS with identical durable projections and rendered text.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/mcp-invocation-context.mjs scripts/lib/direct-invocation-result.mjs scripts/zcode-mcp-server.mjs scripts/zcode-companion.mjs tests/mcp-server.test.mjs tests/integration/skills.test.mjs tests/integration/companion.test.mjs tests/integration/true-background-rescue.test.mjs tests/rescue-lifecycle.test.mjs tests/job-control.test.mjs
git commit -m "test: prove dual wait adapter lifecycle parity"
```

## Task 9: Ship package, security, and user documentation

**Files:**
- Modify: `package.json`
- Modify: `scripts/build-marketplace-snapshot.mjs`
- Modify: `tests/integration/package-install.test.mjs`
- Modify: `tests/integration/marketplace-install.test.mjs`
- Modify: `tests/marketplace-snapshot.test.mjs`
- Modify: `tests/release-contracts.test.mjs`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/adr/0013-bind-rescue-child-to-zcode-session.md`
- Modify: `docs/adr/0018-use-host-managed-session-bound-execution.md`

- [ ] **Step 1: Write failing package and release-contract tests**

Require npm pack and marketplace installs to contain `.mcp.json`, the server, the two new libraries, all four generated Skill directories, `qualification/mcp-context.json`, and the SDK runtime. Require `bundleDependencies` to list both `fs-native-extensions` and `@modelcontextprotocol/sdk`; require `verifyLockedRuntimePayload` to traverse both locked dependency trees. Copy the installed plugin to an isolated directory whose ancestors contain no `node_modules`, then run MCP stdio initialize/tools-list there. Tampering with or omitting the qualification record must make installed setup report `unqualified`, never crash or claim qualification. Require installed `check:mcp-skills` parity and docs to state:

- canonical names are shell baseline;
- `*-mcp` names are explicit-only evaluation variants;
- 60-second empty shell waits and 100-hour MCP host ceiling;
- no inactivity watchdog;
- MCP Rescue has no in-flight Child Status sidecar;
- missing trusted context fails closed to the named canonical Skill;
- human maintainers alone decide promotion.

- [ ] **Step 2: Run tests to verify RED**

Run: `node --test tests/integration/package-install.test.mjs tests/integration/marketplace-install.test.mjs tests/marketplace-snapshot.test.mjs tests/release-contracts.test.mjs`

Expected: FAIL on missing packaged MCP assets and documentation.

- [ ] **Step 3: Add assets and documentation**

Add `.mcp.json` and `qualification/mcp-context.json` explicitly to `package.json.files`, add `@modelcontextprotocol/sdk` to `bundleDependencies`, and generalize `verifyLockedRuntimePayload(pluginRoot, lock)` to seed its queue from the two exact runtime roots. Add the qualification record, MCP files, and generated siblings to `REQUIRED_RESCUE_PAYLOAD`; validate the record's closed schema while building the snapshot. Document that `foregroundAdapter` is private transport state, never binding/job authority. Amend ADR 0013 for the two exact task-free Child assignments and ADR 0018 for adapter-independent Host/Companion placement.

- [ ] **Step 4: Run tests to verify GREEN**

Run the Step 2 command plus `npm run check:mcp-skills`.

Expected: PASS.

- [ ] **Step 5: Commit source/package/docs before snapshot generation**

```bash
git add .mcp.json package.json npm-shrinkwrap.json scripts skills agents tests README.md README.zh-CN.md SECURITY.md CHANGELOG.md docs/adr
git commit -m "docs: publish dual wait adapter experiment"
```

## Task 10: Run final qualification and refresh the marketplace snapshot

**Files:**
- Modify: `marketplace/plugins/zcode/**` (generated snapshot only)
- Modify: marketplace provenance generated by `scripts/build-marketplace-snapshot.mjs`
- Create: `tools/qualify-installed-mcp.mjs`
- Create: `tests/e2e/codex-installed-mcp-e2e.test.mjs`

- [ ] **Step 1: Verify the source worktree is clean**

Run: `git status --short`

Expected: no output.

- [ ] **Step 2: Run static and full source verification**

Run: `npm run check:line-endings && npm run lint && npm run typecheck && npm run check:mcp-skills && npm test`

Expected: all tests pass; only credential-gated real ZCode/provider tests may skip under their existing opt-in rules.

- [ ] **Step 3: Re-run the protocol probe gate unchanged**

Run:

```bash
probe_run="$(mktemp -d "${TMPDIR:-/tmp}/zcode-mcp-probe.XXXXXX")"
chmod 700 "$probe_run"
node tools/mcp-context-probe/qualify.mjs \
  --codex "$(command -v codex)" \
  --source-codex-home "${CODEX_HOME:-$HOME/.codex}" \
  --run-directory "$probe_run"
ZCODE_CODEX_MCP_E2E=1 ZCODE_MCP_PROBE_RESULT="$probe_run/result.json" \
  node --test tests/e2e/codex-mcp-context-e2e.test.mjs
```

Expected: PASS for context, concurrency, cancellation, connection loss, current-turn metadata changes, and short-timeout settlement. Stale/wrong metadata rejection is verified by Task 4 authority tests and is not claimed by this Host gate. This gate qualifies Host protocol only and does not count as production plugin qualification.

- [ ] **Step 4: Qualify the installed production plugin and full Rescue-MCP chain**

First write `tests/e2e/codex-installed-mcp-e2e.test.mjs` with the six required booleans below and verify RED:

```bash
ZCODE_CODEX_MCP_E2E=1 ZCODE_INSTALLED_MCP_RESULT=/nonexistent \
  node --test tests/e2e/codex-installed-mcp-e2e.test.mjs
```

Expected: FAIL with `Installed MCP qualification result is unavailable`.

Then implement `tools/qualify-installed-mcp.mjs`. It packs and installs the exact clean HEAD as a temporary marketplace/plugin into a fresh mode-0700 Codex home, canonicalizes and pins the externally supplied `--codex` target exactly as Task 2, and securely copies/removes only `auth.json` from required `--source-codex-home` using the same qualification-unavailable and cleanup rules. Credentials are never included in production MCP `env_vars`. It lists exactly eight production tools and invokes all eight against fake/preflight-only state so no provider request is possible. It then runs the exact Task-7 `$zcode:rescue-mcp` scenario and deliberate same-Child shell-misroute scenario.

For the real Rescue chain, the qualification server writes a mode-0600 event for every call containing `{runNonce, callNonce, toolName, metadataHash, settlement}` and returns that `callNonce` in `structuredContent` for this opt-in qualification host. The driver collects the Child's `codex exec --json` transcript and requires one matching `custom_tool_call` with `toolName:'invoke_prepared_rescue'`, the same Child thread/turn as the server event's metadata hash, and a returned `callNonce` equal to the server event. It separately requires the v5 preparation record to name `foregroundAdapter:'mcp'` and the exact existing Child agent path; preparation contains no metadata hash and no new durable identity field. The correlation is solely the qualified Host transcript's Child thread/turn plus the server call nonce and metadata hash, all retained in the temporary qualification evidence and omitted from the final boolean result. The negative shell case requires a `custom_tool_call` for the shell launcher, a server/companion `RESCUE_FOREGROUND_ADAPTER_MISMATCH`, and no reservation/provider event. `mcpToolObserved` is true only when all these joins hold; a generated Role string or handler unit test alone cannot set it. After all Host/server processes exit it writes only booleans and tool-name/schema digests to `<run>/result.json` mode 0600.

Run:

```bash
production_run="$(mktemp -d "${TMPDIR:-/tmp}/zcode-installed-mcp.XXXXXX")"
chmod 700 "$production_run"
node tools/qualify-installed-mcp.mjs \
  --codex "$(command -v codex)" \
  --source-codex-home "${CODEX_HOME:-$HOME/.codex}" \
  --source "$(git rev-parse HEAD)" \
  --run-directory "$production_run"
ZCODE_CODEX_MCP_E2E=1 ZCODE_INSTALLED_MCP_RESULT="$production_run/result.json" \
  node --test tests/e2e/codex-installed-mcp-e2e.test.mjs
```

Expected: PASS, including `fullRescueMcpChain`, `sameChild`, `mcpToolObserved`, `shellMismatchRejectedBeforeReservation`, `allEightSchemas`, and `noProviderCalls`.

- [ ] **Step 5: Commit the production qualification harness, then restore cleanliness**

```bash
git add tools/qualify-installed-mcp.mjs tests/e2e/codex-installed-mcp-e2e.test.mjs
git commit -m "test: qualify installed mcp adapter chain"
```

Run: `git status --short`

Expected: no output before snapshot generation.

- [ ] **Step 6: Generate the marketplace snapshot from exact HEAD**

Run:

```bash
source_sha="$(git rev-parse HEAD)"
snapshot_parent="$(mktemp -d)"
snapshot_dir="$snapshot_parent/marketplace-snapshot"
node scripts/build-marketplace-snapshot.mjs \
  --output "$snapshot_dir" \
  --source-ref "$source_sha" \
  --source-sha "$source_sha"
test "$(node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(p.sourceSha)' "$snapshot_dir/.agents/plugins/provenance.json")" = "$source_sha"
rsync -a --delete "$snapshot_dir/" marketplace/
```

Do not copy individual payload files or edit generated provenance manually.

Expected: generated `marketplace/plugins/zcode/` includes byte-identical `.mcp.json`, `qualification/mcp-context.json`, server/libraries, generated Skills, SDK runtime lock, and provenance for exact HEAD.

- [ ] **Step 7: Run installed and snapshot verification**

Run: `node --test tests/integration/marketplace-snapshot-build.mjs tests/integration/marketplace-install.test.mjs tests/integration/package-install.test.mjs tests/marketplace-snapshot.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit generated marketplace bytes**

```bash
git add marketplace
git commit -m "build: refresh marketplace snapshot for mcp waits"
```

- [ ] **Step 9: Run the final branch suite**

Run: `npm run check`

Expected: lint, typecheck, unit/integration tests, packed installs, marketplace build, and configured qualification tests pass; paid/authenticated tests retain their explicit opt-in skips.

- [ ] **Step 10: Record the handoff boundary**

Report the final commits, test counts, supported Codex version from the probe, and the explicit fact that canonical promotion has not occurred. Do not rename/remove canonical shell Skills or automatically enable implicit routing for MCP siblings.
