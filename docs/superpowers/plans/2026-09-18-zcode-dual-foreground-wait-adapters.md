# ZCode Dual Foreground Wait Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a 60-second same-handle shell wait baseline and explicit-only MCP-backed ZCode Skill variants that reuse the exact existing Companion, Rescue binding, placement, cancellation, and lifecycle implementation.

**Architecture:** Canonical Skills continue to invoke the Companion CLI and observe one process with empty-input `write_stdin`. MCP siblings call narrow tools on a plugin-root stdio MCP server; each handler resolves trusted per-call thread/turn identity, then joins that identity to the Root-created preparation/Rescue Binding (or Root Caller Context) to derive and verify workspace before entering `runDirectInvocation` with fixed argv. Rescue preparation version 5 carries a private `foregroundAdapter` selector through one-shot preparation and pending choice state without adding it to Rescue Binding or Tracked Job identity.

**Tech Stack:** Node.js 22 ESM, `node:test`, `@modelcontextprotocol/sdk` 1.30.0, Codex plugin `.mcp.json`, Codex Skills/Role templates, existing private preparation and lifecycle stores, npm packed-install and marketplace snapshot qualification.

**Spec:** `docs/superpowers/specs/2026-09-18-zcode-dual-foreground-wait-adapters-design.md`

**Qualification amendment:** Codex CLI 0.154.0 qualification showed that `--ignore-user-config` skips the `$CODEX_HOME/config.toml` that contains marketplace/plugin registration, so it also prevents the installed plugin MCP server from loading. Positive Host runs use an isolated `CODEX_HOME` with copied auth and plugin config, omit `--ignore-user-config`, and use `--ignore-rules` if rule isolation is needed. The negative control intentionally uses `--ignore-user-config` and must show no probe server. The official docs define the flag as skipping `$CODEX_HOME/config.toml` and document plugin marketplace configuration separately.

**Current evidence status:** Plugin loading and per-call identity visibility are proven on Codex CLI 0.154.0, but the metadata-to-app-server/Hook authority namespace join is not yet qualified. Lifecycle behavior is characterized for CLI SIGINT, CLI SIGKILL, and plugin `tool_timeout_sec`; app-server `turn/interrupt` and direct-config timeout remain open. Task 3 and Task 5 may proceed immediately. Task 4 waits for the identity namespace record. Task 6 begins with a bounded lifecycle-feasibility spike and may create the production server only after selecting strategies. Packaging, MCP Skill enablement, marketplace publication, and final release remain gated by Tasks 8–10.

---

## Handoff constraints

- Work only in the dedicated `feat/dual-foreground-wait-adapters` worktree.
- Preserve the existing binding, placement, permission, Tracked Job, cancellation, and lifecycle modules as the sole authorities. MCP is transport and waiting only.
- Task 2 separates qualification from characterization. Trustworthy identity/configuration assertions are pass/fail authority gates. Cancellation, process loss, transport close, and timeout cases record one closed observed outcome each; they are not forced to reduce to `true` or to a presumed `AbortSignal` mechanism.
- Task 3 and Task 5 are transport/authority independent and may continue now. Task 4 requires the completed identity namespace record. Task 6 consumes characterization observations, runs a bounded feasibility spike, and freezes selected lifecycle strategies before production server work. Tasks 9–10 remain the hard packaging/release gate.
- Characterization may change mechanisms but may not delete or weaken any spec release outcome. If no branch proves an outcome, record `release-blocked`; do not redefine the outcome as optional or best effort.
- No worker may preselect inner `thread_id`, envelope `threadId`, `session_id`, or another metadata field before the namespace characterization proves its exact relation to app-server/Hook authority. Workspace never comes from `_meta`.
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
| `scripts/lib/mcp-invocation-context.mjs` | Parse only namespace-qualified per-call identity fields and resolve branded Root/Child authority plus workspaces |
| `scripts/lib/mcp-lifecycle-controller.mjs` | Adapt characterized explicit-interrupt, Host-loss, and timeout observations to existing lifecycle seams |
| `scripts/lib/direct-invocation-result.mjs` | One shell/MCP rendering and control-outcome mapping |
| `scripts/lib/codex-app-server.mjs` | Bounded current-Child-turn Host correlation used by MCP Rescue preflight |
| `scripts/zcode-companion.mjs` | Existing deep entry; adapter and trusted-turn revalidation before atomic consume |
| `scripts/zcode-mcp-server.mjs` | Long-lived stdio MCP server with fixed empty-input tool schemas |
| `.mcp.json` | `zcode_companion` server declaration and 100-hour production tool ceiling |
| `tools/mcp-context-probe/server.mjs` | Disposable real-Host identity and lifecycle-characterization server |
| `tools/mcp-context-probe/build-fixture.mjs` | Build an installable temporary probe-only plugin, never the production root |
| `tools/mcp-context-probe/qualify.mjs` | Drive and collect the repeatable real-Host qualification matrix |
| `tools/mcp-context-probe/observer.mjs` | Mode-0600 append-only evidence surviving server disconnect/exit |
| `tests/e2e/codex-mcp-context-e2e.test.mjs` | Opt-in real-Host identity gate and closed lifecycle-observation validation; no provider/ZCode task execution |
| `qualification/mcp-context.json` | Redacted qualified identity/configuration facts |
| `qualification/mcp-lifecycle.json` | Redacted Host lifecycle observations and selected implementation strategy |
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

## Task 2: Qualify invocation identity and characterize Host lifecycle behavior

**Files:**
- Create: `tools/mcp-context-probe/.codex-plugin/plugin.json`
- Create: `tools/mcp-context-probe/.agents/plugins/marketplace.json.template`
- Create: `tools/mcp-context-probe/server.mjs`
- Create: `tools/mcp-context-probe/.mcp.json`
- Create: `tools/mcp-context-probe/skills/context/SKILL.md`
- Create: `tools/mcp-context-probe/skills/context/agents/openai.yaml`
- Create: `tools/mcp-context-probe/hooks/hooks.json`
- Create: `tools/mcp-context-probe/hook-observer.mjs`
- Create: `tools/mcp-context-probe/build-fixture.mjs`
- Create: `tools/mcp-context-probe/qualify.mjs`
- Create: `tools/mcp-context-probe/observer.mjs`
- Create: `tests/e2e/codex-mcp-context-e2e.test.mjs`
- Create: `tests/mcp-context-probe.test.mjs`
- Create: `docs/qualification/zcode-mcp-context.md`
- Create: `qualification/mcp-context.json`
- Create: `qualification/mcp-lifecycle.json`
- Modify: `package.json`
- Modify: `npm-shrinkwrap.json`

> **Resumption note:** This task's rerun is a delta amendment of the already-committed harness (commits 56aff12, b5af4c5, b9244a0, and 7a10934 created and hardened the probe). The rerun must preserve the already-proven loading/distinctness facts, add authority namespace characterization, and replace the erroneous all-true lifecycle gate with observations plus later feasibility-based strategy selection. RED/GREEN evidence comes from tests for those deltas.

> **Current checkpoint:** Do not recreate the SDK dependency or original harness files from scratch. Begin with RED delta tests for the result schema, fixture hook/equality matrix, app-server `turn/interrupt`, and skill-only direct-config timeout case. Because prior run directories were securely removed and no machine artifact remains, run the amended driver through its full matrix once after those changes; the rerun regenerates A/B, distinctness, SIGINT, SIGKILL, and plugin-timeout evidence under one nonce so the equality matrix and two records have a single provenance. Task 3 and Task 5 may run independently in parallel. Do not start Task 4 until `qualification/mcp-context.json` records a proven authority namespace.

- [ ] **Step 1: Install the probe/runtime SDK dependency**

Run: `npm install --save-exact @modelcontextprotocol/sdk@1.30.0`

Expected: `package.json` contains production dependency `"@modelcontextprotocol/sdk": "1.30.0"` and the shrinkwrap records it. The production server added later reuses this exact dependency.

- [ ] **Step 2: Write the probe fixture and observer tests first**

`build-fixture.mjs --output <empty-dir> --server <absolute-source-server>` must create a complete local marketplace, not a bare plugin directory:

```text
<output>/.agents/plugins/marketplace.json
<output>/plugins/zcode-mcp-context-probe/.codex-plugin/plugin.json
<output>/plugins/zcode-mcp-context-probe/skills/context/{SKILL.md,agents/openai.yaml}
<output>/plugins/zcode-mcp-context-probe/hooks/hooks.json
<output>/plugins/zcode-mcp-context-probe/hook-observer.mjs
```

`mode:'plugin-server'` additionally emits `<plugin>/.mcp.json`. `mode:'skill-only'` must not emit that file. Fixture tests assert presence in plugin-server mode and `ENOENT` in skill-only mode; this absence is required for the direct-config timeout differential.

The marketplace name is `zcode-mcp-probe`, its sole local plugin is `zcode-mcp-context-probe`, and the only Skill is explicitly invoked as `$zcode-mcp-context-probe:context`. The fixture hook records salted equality evidence for `SessionStart`, `UserPromptSubmit`, and `SubagentStart` fields through the same locked observer; it never records raw IDs, cwd, prompt, or task. In plugin-server mode, the descriptor uses the validated absolute server path so its SDK resolves from this worktree; the temporary marketplace never adds an MCP descriptor to the production plugin before the gate. Tests parse the generated marketplace, resolve its local source path, validate manifests/hooks and mode-specific descriptor presence, and reject output outside the supplied empty mode-0700 directory. The A/B negative/positive outcome itself proves the tested Host loads the MCP server declared by the plugin-root `.mcp.json` manifest (spec:147); the tests assert this via the A/B combination rather than by filename inference.

The probe modules expose these exact testable interfaces:

```js
export declare function buildProbeMarketplace(input: { output:string, server:string, toolTimeoutSec:2|30, mode:'plugin-server'|'skill-only' }): Promise<void>;
export declare function appendProbeEvent(input: { runDirectory:string, runNonce:string, event:ProbeEvent }): Promise<void>;
export declare function readProbeEvents(input: { runDirectory:string, runNonce:string }): Promise<ProbeEvent[]>;
export declare function reduceProbeResult(input: { runDirectory:string, runNonce:string }): Promise<ProbeResult>;
export declare function qualifyMcpContext(input: { codexPath:string, runDirectory:string }): Promise<ProbeResult>;
```

These are interface declarations, not implementation snippets. Each function's complete required behavior, filesystem modes, validation, locking, subprocess commands, and result schema are specified by Steps 2–7 and their tests. Implementation must not add options or ambient fallbacks.

`observer.mjs` owns `<run>/events.jsonl`; the final reducer alone owns `<run>/result.json`. Each event contains only a random probe-run nonce, a closed event enum, a call nonce, and hashes/equality booleans—never raw metadata. Every append runs under the existing `withFileLock(<run>/events.lock, ...)`, opens the mode-0600 JSONL with `O_NOFOLLOW`, appends, fsyncs, and closes, so concurrent servers and disconnect/exit are durable. Reject symlinks, pre-existing wrong-mode files, duplicate terminal events, oversized files, and foreign run nonces. After every Host/server process exits, the driver takes the same lock, validates the complete log, and atomically writes mode-0600 `result.json`; no MCP handler writes or overwrites the result.

Run: `node --test tests/mcp-context-probe.test.mjs`

Expected: FAIL because the installable fixture, durable observer, and collector do not exist. (Original build only; on the rerun see the resumption note above.)

- [ ] **Step 3: Replace the all-true gate with qualified facts and closed observations**

The test must skip unless `ZCODE_CODEX_MCP_E2E=1`; when enabled it reads only a private probe artifact path supplied in `ZCODE_MCP_PROBE_RESULT` and validates this closed, redacted shape:

```js
assert.deepEqual(Object.keys(result), ['context', 'lifecycle']);
assert.deepEqual(result.context.assertions, {
  identityFieldsVisible: true,
  identityNamespaceQualified: true,
  laterTurnDistinct: true,
  concurrentChildrenDistinct: true,
  metadataChangesAcrossTurns: true,
  serverLoadedWithConfig: true,
});
assert.match(result.context.authorityFields.rootThread, /^_meta\./);
assert.match(result.context.authorityFields.childThread, /^_meta\./);
assert.match(result.context.authorityFields.turn, /^_meta\./);
const threadCandidates = ['envelopeThreadId', 'innerSessionId', 'innerThreadId'];
const rootAuthorities = ['appServerThreadId', 'hookSessionId'];
const childAuthorities = ['appServerThreadId', 'hookSessionId', 'hookAgentId', 'returnedChildHandle'];
const turnAuthorities = ['appServerTurnId', 'hookTurnId'];
const equalityKey = (scope, candidate, authority) => `${scope}:${candidate}==${authority}`;
const expectedEqualityKeys = [
  ...threadCandidates.flatMap((candidate) => rootAuthorities.map((authority) => equalityKey('root', candidate, authority))),
  ...threadCandidates.flatMap((candidate) => childAuthorities.map((authority) => equalityKey('child', candidate, authority))),
  ...turnAuthorities.map((authority) => equalityKey('root', 'innerTurnId', authority)),
  ...turnAuthorities.map((authority) => equalityKey('child', 'innerTurnId', authority)),
].sort();
assert.deepEqual(Object.keys(result.context.equalityMatrix).sort(), expectedEqualityKeys);
for (const value of Object.values(result.context.equalityMatrix)) assert.equal(typeof value, 'boolean');
assert.deepEqual(Object.keys(result.lifecycle).sort(), [
  'appServerTurnInterrupt', 'cliSigint', 'cliSigkill',
  'directConfigToolTimeout', 'pluginToolTimeout',
]);
for (const observation of Object.values(result.lifecycle)) {
  assert.match(observation.hostProcess, /^(running|exited-clean|exited-signal|not-observed|unknown)$/);
  assert.match(observation.turnTerminalStatus, /^(completed|interrupted|failed|pending|not-observed|unknown)$/);
  assert.match(observation.toolCallOutcome, /^(completed|failed|timed-out|pending|not-observed|unknown)$/);
  assert.match(observation.handlerSettlement, /^(signal-abort|transport-close|completed|pending|server-exited|not-observed|unknown)$/);
  assert.match(observation.transportState, /^(open|stdin-eof|closed|server-exited|not-observed|unknown)$/);
  assert.match(observation.hookEvent, /^(stop|session-end|none|not-observed|unknown)$/);
  assert.match(observation.unknownReason, /^(none|ceiling-reached|host-omitted-event|process-exited-first|unsupported)$/);
}
```

The result contains only the six context booleans, a salted equality matrix naming field paths but no values, and lifecycle observations—no raw thread, turn, workspace, task, binding, job, PID, timing, or path values. `identityNamespaceQualified` is true only when recorded Root/Child/turn field paths equal the exact app-server/Hook authority pairs needed by Task 4; stable but unrelated inner IDs do not satisfy it. A lifecycle outcome is evidence, not a failure merely because it is not `signal-abort`. The real Host probe does not claim that `_meta` contains workspace or that Host lifecycle mechanics satisfy production invariants by themselves; Task 4 verifies the authority join and Tasks 6/8 verify the selected lifecycle strategies.

- [ ] **Step 4: Run the opt-in test to verify RED**

Run: `ZCODE_CODEX_MCP_E2E=1 ZCODE_MCP_PROBE_RESULT=/nonexistent node --test tests/e2e/codex-mcp-context-e2e.test.mjs`

Expected: FAIL with `MCP probe result is unavailable`; after supplying the old flat eight-boolean artifact it must instead fail with `MCP probe result uses the obsolete all-true schema`.

- [ ] **Step 5: Implement the installable disposable stdio probe**

Use `@modelcontextprotocol/sdk`'s low-level `Server`, `ListToolsRequestSchema`, `CallToolRequestSchema`, and `StdioServerTransport`. Expose only:

```js
const tools = [
  'capture_context',       // validates and hashes per-call metadata into durable evidence
  'hold_for_lifecycle',    // records whichever characterized lifecycle event actually occurs
  'read_assertions',       // reduces durable evidence to the closed boolean result
];
```

Read metadata from `request.params._meta`; never accept identity arguments. Hash each candidate field immediately with the per-run nonce and retain no raw value. Candidate fields are envelope `threadId` plus inner `session_id`, `thread_id`, and `turn_id`. The driver and fixture hook independently hash stdout `thread.started.thread_id`, app-server `thread.id`/`turn.id`, Hook `session_id`/`turn_id`/`agent_id`, and the exact Child handle returned by `spawn_agent`. The reducer emits only named equality booleans between those hashes. `identityFieldsVisible` means the candidate metadata is complete; `identityNamespaceQualified` requires one exact thread/turn field pair to match the Host/Hook authority namespace used by Caller Context and executor records. Distinctness alone is insufficient. `serverLoadedWithConfig` requires the negative/positive A/B window, a positive server start, and a successful positive tool call. `laterTurnDistinct` and `metadataChangesAcrossTurns` remain observations, not proof of authority namespace equivalence.

Every lifecycle call writes a durable start and records the generic observation fields from Step 3. The driver independently records Host process, turn, tool-call, handler-settlement, transport, and Hook states; missing evidence is `not-observed` or `unknown` with a bounded reason, never a guessed event. The reducer must not relabel pending or process exit as delivered cancellation. `read_assertions` returns an in-memory preview reduced under the event lock but does not write `result.json`. Workspace derivation and stale/wrong metadata rejection remain Task 4 authority-join contract tests.

The source `.mcp.json` is only a template. In `plugin-server` mode, `build-fixture.mjs` emits the plugin-root descriptor declaring only this probe server with `node <absolute-server>` and the requested 30- or 2-second timeout. In `skill-only` mode it emits no descriptor. The fixture identity cannot collide with production `zcode`.

- [ ] **Step 6: Implement one exact qualification driver and execute it**

`qualify.mjs` treats `--codex <entry-path>` as an externally supplied qualification target. It resolves one launcher symlink with `realpath`, requires the canonical target to be a regular executable file, records its device/inode and `<canonical-path> --version`, and rechecks all three before every spawn; it never calls PATH internally and does not call this binary repository-locked. It requires `--source-codex-home <dir>`, opens that real directory and its regular nonsymlink `auth.json`, copies only that file into fresh `<run>/codex-home/auth.json`, chmods it 0600, and requires `login status` to pass. Missing/unusable authentication reports `qualification-unavailable`, not protocol failure. No auth path or bytes enter logs, result artifacts, MCP arguments, or MCP `env_vars`.

It creates fresh 30-second and 2-second marketplaces, workspace A, isolated HOME/USERPROFILE, and the isolated Codex home inside one mode-0700 `mkdtemp` run directory. Every plugin command and Host process uses those homes. Workspace B and cross-workspace binding checks are created later by Task 4 integration fixtures, not claimed by this Host metadata probe. The 30-second phase executes exactly:

```bash
CODEX_HOME=<run>/codex-home <codex> plugin marketplace add <absolute-marketplace-root> --json
CODEX_HOME=<run>/codex-home <codex> plugin add zcode-mcp-context-probe@zcode-mcp-probe --json
```

The generated descriptor has exactly `env_vars: ["ZCODE_MCP_PROBE_EVENTS","ZCODE_MCP_PROBE_LOCK","ZCODE_MCP_PROBE_NONCE"]`; this is only an allowlist. Before every Host spawn, the driver explicitly sets `env.ZCODE_MCP_PROBE_EVENTS=<run>/events.jsonl`, `env.ZCODE_MCP_PROBE_LOCK=<run>/events.lock`, and `env.ZCODE_MCP_PROBE_NONCE=<runNonce>` (plus isolated `CODEX_HOME`, `HOME`, `USERPROFILE`). The driver asserts the server's first durable event contains the same nonce and canonical event/lock paths. It starts a fresh real Host after installation and drives one scripted qualification conversation. The driver uses this fixed base argv for new conversations:

```text
exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox
  --ignore-rules -C <workspace> <prompt>
```

and this fixed argv for continuations, launched with process cwd equal to the target workspace:

```text
exec resume --json --all --skip-git-repo-check
  --dangerously-bypass-approvals-and-sandbox --ignore-rules <root-thread-id> <prompt>
```

`--ignore-rules` acceptance on 0.154.0 is fail-closed: if a Host spawn rejects the flag, that spawn failure fails the gate. It may be cheaply pre-checked by including the flag in the version/preflight spawn.

The state machine is exact:

```js
const MATRIX_PROMPT = 'Use $zcode-mcp-context-probe:context. Call capture_context once in Root. Spawn one Child, have it call capture_context, wait for it, then follow up that exact Child and have it call capture_context again. Then spawn two new Children concurrently and have each call capture_context once. Wait for both. Do not call any other MCP tool.';
const NEGATIVE_CONTROL_PROMPT = 'Use $zcode-mcp-context-probe:context and call capture_context exactly once in Root. Do not spawn a Child.';
const HOLD_PROMPT = 'Use $zcode-mcp-context-probe:context and call hold_for_lifecycle exactly once. Wait for that tool and do nothing else.';
```

Before the positive matrix, run a negative-control Host with the same isolated marketplace and plugin but add `--ignore-user-config`, driven with `NEGATIVE_CONTROL_PROMPT`. The durable absence proof is exact: the driver snapshots the durable event log before and after the negative-control Host completes and requires zero `server-started` and zero `capture-started` events across that window; only then does it record the durable phase marker `negative-control` (recorded by the driver like every other phase, and by nothing else). The bounded JSONL tool-unavailable outcome of that Host is still required. Remove that Host, then run the positive matrix without `--ignore-user-config`; require both a `server-started` event and a successful probe tool call before `serverLoadedWithConfig` can be true. The assertion is therefore the A/B combination, not startup alone: the same fixture is absent under the flag and callable without it. This proves the failure is configuration loading, not fixture packaging.

1. Run one workspace-A `codex exec` prompt that requires Root `capture_context`, one Child capture, `followup_task` to that exact Child for a second capture, and two additional concurrently spawned Child captures. Parse stdout strictly as bounded JSONL; require exactly one `thread.started.thread_id`, zero malformed frames, exit 0, corresponding hook observations, and the durable MCP event count. Reduce salted equalities among envelope/inner metadata, stdout thread ID, Hook session/turn/agent IDs, and the returned Child handle; do not yet select an authority field.
2. Launch `codex exec resume ... --all <root-thread-id>` with cwd workspace A and require one Root `capture_context`; require exit 0, the same stdout `thread.started.thread_id`, a different observed turn, and durable MCP/hook events. Preserve the proven fact that inner `thread_id` is not stdout `thread.started.thread_id`.
3. Launch a separate workspace-A `codex exec` with `HOLD_PROMPT`; after its durable start, send SIGINT to the pinned Host PID. Observe for 10 seconds, then record `cliSigint` from the actual Host exit state and handler event. If the Host or server remains alive, stop it during cleanup, but do not convert cleanup into a cancellation observation.
4. Launch another held CLI call; after its durable start, SIGKILL the pinned Host PID. Observe stdin EOF/close and server exit for 10 seconds and record `cliSigkill`. Require cleanup to leave no surviving recorded PID, but accept the closed observed enum rather than requiring SDK abort.
5. Start `codex app-server` in the same isolated home and initialize it. First run a bounded capture turn that captures Root and one spawned Child, then add salted equality facts for app-server Root/Child thread/turn records against the MCP, Hook, and returned-Child-handle candidates; `identityNamespaceQualified` becomes true only if this completes both exact Root and Child authority chains. Then start a turn that explicitly invokes `hold_for_lifecycle`, wait for the durable start, and send `turn/interrupt` for that exact thread/turn. Read through `turn/completed` or the 30-second observation ceiling and record `appServerTurnInterrupt`. This is the explicit-user-cancellation characterization; CLI SIGINT is not its substitute.
6. Stop phase-30 processes and remove its plugin/marketplace. Install the 2-second plugin fixture, run `HOLD_PROMPT`, and observe for 30 seconds after durable start. Record `pluginToolTimeout` whether the Host returns a tool-timeout result, exits, remains waiting, or advances while the handler remains pending. Stop tracked processes only after recording the observation.
7. Remove the plugin/marketplace. In a fresh isolated Codex home with the same copied authentication, install a separately generated `mode:'skill-only'` fixture whose plugin contains the probe Skill and hooks but no `.mcp.json`. Configure the identical server directly under `[mcp_servers.zcode-mcp-context-probe]` with `tool_timeout_sec = 2`. Run the same Skill-driven held call, require its durable start before beginning the 30-second ceiling, and record `directConfigToolTimeout`. This differential isolates Host timeout semantics from plugin descriptor propagation without relying on the model to invent a raw tool name.
8. Stop all tracked processes. Under the event lock, reduce the shared log and atomically write `<run>/result.json`; run the opt-in assertion test. The context section must pass all six booleans. Every lifecycle case must contain a schema-valid observation, but no particular observation is required merely to make characterization “pass.”

The instrument contract separates outer deadlines: CLI commands (`--version`, the flag pre-check, marketplace/plugin install and removal, `login status`) keep the 180-second outer deadline; real Host conversations get a 600-second outer deadline (the matrix's first durable capture alone landed ~140s into a conversation on 0.154.0, which the CLI bound cannot contain). Every subprocess has bounded 4 MiB stdout/stderr. The driver tracks PID plus start identity before signalling, never uses process-name matching, and runs ordered cleanup in `finally`. Failure to stop a process, remove the plugin/marketplace, delete isolated `auth.json`, or remove the temporary homes makes qualification fail with a redacted cleanup error.

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

Expected: the driver prints its exact marketplace-add/plugin-add/start/turn-interrupt/signal/disconnect/timeout/plugin-remove/marketplace-remove transcript with identifiers redacted, then the test PASSes when the six context facts are true and all five lifecycle cases are honestly classified. Pending or unknown observations remain successful characterization results and may select a blocked or supervisor-based candidate later; they are never rewritten as `signal-abort`.

- [ ] **Step 7: Freeze qualified identity facts and lifecycle candidates**

If authentication is unavailable, report `qualification-unavailable`; do not fabricate either record. If any of the six context assertions is false, Task 4 and later authority-dependent MCP work remain blocked because safe caller/binding resolution is unavailable. Task 3 and Task 5 remain independent. A lifecycle observation never fails merely for being pending, unobserved, or unknown with a bounded reason.

Write `qualification/mcp-context.json` once all six context assertions pass. Its exact schema is:

```ts
type ThreadFieldPath =
  | '_meta.threadId'
  | '_meta.x-codex-turn-metadata.session_id'
  | '_meta.x-codex-turn-metadata.thread_id';
type TurnFieldPath = '_meta.x-codex-turn-metadata.turn_id';
type ContextQualificationRecord = {
  version: 1; status: 'qualified'; codexVersion: 'codex-cli 0.154.0';
  contextSchemaVersion: 1;
  metadataFields: { rootThreadId: ThreadFieldPath; childThreadId: ThreadFieldPath; turnId: TurnFieldPath };
  workspaceSource: 'authority-join'; observedAt: string;
};
```

The three stored paths are the actual Root/Child/turn equality-matrix winners; Root and Child paths may be equal but are recorded independently. The file contains no unexpanded marker. Write `qualification/mcp-lifecycle.json` with this schema and measured enum values:

```ts
type LifecycleCase = 'appServerTurnInterrupt' | 'cliSigint' | 'cliSigkill'
  | 'pluginToolTimeout' | 'directConfigToolTimeout';
type LifecycleObservation = {
  hostProcess: 'running'|'exited-clean'|'exited-signal'|'not-observed'|'unknown';
  turnTerminalStatus: 'completed'|'interrupted'|'failed'|'pending'|'not-observed'|'unknown';
  toolCallOutcome: 'completed'|'failed'|'timed-out'|'pending'|'not-observed'|'unknown';
  handlerSettlement: 'signal-abort'|'transport-close'|'completed'|'pending'|'server-exited'|'not-observed'|'unknown';
  transportState: 'open'|'stdin-eof'|'closed'|'server-exited'|'not-observed'|'unknown';
  hookEvent: 'stop'|'session-end'|'none'|'not-observed'|'unknown';
  unknownReason: 'none'|'ceiling-reached'|'host-omitted-event'|'process-exited-first'|'unsupported';
};
type LifecycleRecord = {
  version: 1; status: 'characterized'; codexVersion: 'codex-cli 0.154.0';
  cases: Record<LifecycleCase, LifecycleObservation>;
  candidateStrategies: {
    explicitInterrupt: Array<'direct-abort'|'durable-stop-intent'|'release-blocked'>;
    hostLoss: Array<'durable-supervision'|'release-blocked'>;
    hostTimeout: Array<'host-abort'|'server-deadline'|'durable-supervision'|'release-blocked'>;
  };
  selectedStrategies: null;
};
```

Task 2 does not claim a strategy is feasible. It derives candidates by this closed table; multiple matching candidates are retained for Task 6:

| Dimension | Observation predicate | Candidate |
|---|---|---|
| explicit interruption | `handlerSettlement === 'signal-abort'` | `direct-abort` |
| explicit interruption | interrupted turn plus `hookEvent === 'stop'` | `durable-stop-intent`, `release-blocked` |
| explicit interruption | neither abort nor Stop Hook observed | `release-blocked` |
| Host loss | any tested Host/process loss after durable call start | `durable-supervision`, `release-blocked` |
| Host timeout | `handlerSettlement === 'signal-abort'` and `toolCallOutcome === 'timed-out'` | `host-abort` |
| Host timeout | Host abort predicate is absent | `server-deadline`, `durable-supervision`, `release-blocked` |

Task 6 proves or rejects these candidates and replaces `selectedStrategies:null` with three independently selected strategies or `release-blocked` values. Explicit interruption, Host loss, and Host timeout are never forced into one mutually exclusive strategy.

Commit the qualified authority evidence, lifecycle observations, and candidates:

```bash
git add tools/mcp-context-probe tests/mcp-context-probe.test.mjs tests/e2e/codex-mcp-context-e2e.test.mjs docs/qualification/zcode-mcp-context.md qualification/mcp-context.json qualification/mcp-lifecycle.json package.json npm-shrinkwrap.json
git commit -m "test: qualify context and characterize mcp lifecycle"
```

- [ ] **Step 8: Continue only the dependencies selected by the records**

Task 3 and Task 5 may proceed immediately. Task 4 requires the qualified context record. Task 6 requires the lifecycle observation record and owns feasibility/selection. Tasks 9–10 require installed-plugin tests to prove every selected strategy against the unchanged product outcomes; they never require an undocumented Host callback merely because an earlier plan guessed one.

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

This task starts only after `qualification/mcp-context.json` records the exact authority field paths. Load those paths rather than hard-coding an observed-but-unjoined namespace. Reject missing, extra, control-bearing, oversized, stale, wrong-workspace, wrong-turn, wrong-child, and concurrent-child substitutions. The public API is:

```js
const identity = parseMcpCallIdentity(request.params._meta, qualificationRecord, 'child');
const authority = await resolveMcpInvocationAuthority({ identity, command: 'rescue', hostReader, stores });
assert.deepEqual(readMcpInvocationAuthority(authority), {
  threadId: 'child-thread',
  turnId: 'current-child-turn',
  originWorkspace: '/canonical/origin',
  executionWorkspace: '/canonical/execution',
});
```

`readMcpInvocationAuthority` must accept only a resolver-branded in-process object. Add app-server tests for:

```js
await readCodexThreadCurrentTurnIdentity(childThreadId, options);
// => { threadId, turnId, originWorkspace }
```

The reader must require the current/latest active turn for the exact thread and its Host Child origin workspace and stay bounded/abortable. The MCP metadata parser does not require a workspace field because the trusted Host Child record and Root-created binding derive it.

- [ ] **Step 2: Run tests to verify RED**

Run: `node --test tests/mcp-invocation-context.test.mjs tests/codex-app-server.test.mjs tests/integration/companion.test.mjs`

Expected: FAIL because the module, branded authority, and current-turn reader do not exist.

- [ ] **Step 3: Implement strict metadata parsing, authority resolution, and branding**

Use separate module-private brands for parsed identity and resolved authority; return frozen objects. Parse only the two field paths in `qualification/mcp-context.json`. The resolver performs the non-consuming command-specific join and is the only function that produces canonical origin/execution workspaces. The fixed server mapping supplies `canonicalSkill` (`$zcode:rescue`, `$zcode:review`, `$zcode:adversarial-review`, or `$zcode:status`); it is never a tool argument. Errors use one fixed code and that exact fallback:

```js
throw new PluginError(
  'MCP_INVOCATION_CONTEXT_UNAVAILABLE',
  'The trusted Codex MCP invocation context is unavailable.',
  { category: 'authorization', remedy: `Use the canonical ${canonicalSkill} Skill.` },
);
```

- [ ] **Step 4: Resolve authority before deep invocation and revalidate it during consumption**

Use this command-specific join table; there is no “origin-or-effective” alternative:

| MCP tool family | Authority thread | Authority turn | Workspace source | Durable/Host join before consume |
|---|---|---|---|---|
| Review, Adversarial Review, Status initial/wait | active Root `CallerContext.sessionId` | active Root `CallerContext.turnId` | persisted Root Caller Context | resolve exact active Root context by thread/turn; use its recorded execution workspace |
| prepared Rescue | routed `executor.agentId` / exact Host Child thread | current active turn returned for that exact Child | Host Child origin cwd joined to Root preparation/Rescue Binding | resolve exact executor from Child thread + Host Child record; independently require selected execution workspace equals preparation.workspace; preparation remains unconsumed |
| Rescue resume/fresh choice | pending receipt's exact `executorAgentId` / exact Host Child thread | current active later turn returned for that exact Child | Host Child origin cwd joined to pending receipt/Rescue Binding | resolve exact executor from Child thread + Host Child record; independently require selected execution workspace equals pending.workspace; no preparation lookup |

For each row, `resolveMcpInvocationAuthority` validates the branded identity, queries the exact current Host turn, resolves the exact Root/Child authority, derives origin cwd from the Host/Hook join, then separately validates the selected execution workspace and route joins. The handler invokes `runDirectInvocation` only after this succeeds. Never use MCP server cwd or a model-authored workspace; never use Child origin cwd as execution workspace merely because they are equal in a simple checkout. Any failure returns `MCP_INVOCATION_CONTEXT_UNAVAILABLE` with zero preparation consumption, reservation, binding mutation, session creation, or provider call. Never compare a later Child turn to the executor's initial `childTurnId` or the receipt's parent `originatingTurnId`.

The deep invocation API is explicit and cannot consult ambient MCP-shaped environment variables:

```js
await runDirectInvocation(argv, {
  cwd: authority.executionWorkspace,
  env: withVerifiedCompatibilityThreadId(env, authority.threadId),
  lifecycleController,
  invocationTransport: 'mcp',
  mcpAuthority: authority,
  expectedForegroundAdapter: argv[0].startsWith('invoke') && argv.includes('rescue') ? 'mcp' : undefined,
});
```

When `invocationTransport === 'mcp'`, a branded resolved `mcpAuthority` is mandatory. `runDirectInvocation` requires runtime cwd and constructed `CODEX_THREAD_ID` to equal the branded authority and atomically revalidates the applicable preparation/pending state before consuming it. Ambient `CODEX_THREAD_ID`, cwd, process environment, and argv are never accepted as authority; the verified compatibility variable is output from the resolver. When transport is `shell`, `mcpAuthority` is forbidden. This discriminated boundary is checked before command dispatch.

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

Task 5 owns only transport-neutral result formatting and may proceed independently of Task 2/4. Lifecycle response/discard behavior belongs to Tasks 6 and 8 after the three strategies are selected; do not bake a guessed SDK callback into this formatter.

- [ ] **Step 2: Run tests to verify RED**

Run: `node --test tests/mcp-result.test.mjs tests/integration/companion.test.mjs`

Expected: FAIL because mapping is embedded in `runCompanionCli`.

- [ ] **Step 3: Extract the pure shared formatter**

Return only `{text, stderr, exitCode, outcome, isError}`. Use `renderOutput(output)` for success and `renderOutput(errorEnvelope(error), {json:true})` for ordinary errors. Preserve shell's interruption behavior: empty stdout, bounded interruption stderr, signal exit code. MCP formats the same domain interruption when its selected lifecycle controller produces one; whether the Host delivers or discards that response is outside this transport-neutral formatter. Map only `needs-choice`, `parent-replan`, and error specially; all other completed tool invocations are `terminal`.

Refactor `runCompanionCli` to apply the formatter without changing completion-notice delivery, background failure handling, or process-signal cleanup.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `node --test tests/mcp-result.test.mjs tests/integration/companion.test.mjs tests/render-progress.test.mjs`

Expected: PASS with unchanged CLI bytes and exit codes.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/direct-invocation-result.mjs scripts/zcode-companion.mjs tests/mcp-result.test.mjs tests/integration/companion.test.mjs
git commit -m "refactor: share direct invocation result mapping"
```

## Task 6: Prove lifecycle feasibility, freeze strategies, and add the narrow MCP server

**Files:**
- Create: `scripts/lib/mcp-lifecycle-controller.mjs`
- Create: `.mcp.json`
- Create: `scripts/zcode-mcp-server.mjs`
- Modify: `package.json`
- Modify: `npm-shrinkwrap.json`
- Modify: `qualification/mcp-lifecycle.json`
- Create: `tests/mcp-lifecycle-controller.test.mjs`
- Create: `tests/mcp-server.test.mjs`
- Modify: `tests/plugin-contracts.test.mjs`
- Modify: `tests/integration/plugin-layout.test.mjs`

- [ ] **Step 1: Write the bounded lifecycle-feasibility tests**

Load Task 2's observations and candidate strategies. Test the three outcome dimensions independently:

- explicit interruption must reach existing interruption settlement through a characterized signal/event or an existing Durable Stop Intent input;
- Host/process loss must be safe even when the MCP server dies before it can append a settlement, so accepted execution must already be owned by an existing durable supervisor/reconciler;
- the 100-hour ceiling must use a characterized Host abort or a server-side deadline that enters existing interruption settlement before the Host ceiling; it cannot rely on an unobserved timeout callback.

The feasibility fixture must prove registration occurs before provider/work admission, simulate MCP server death immediately after admission, and then run the existing reconciler to a durable non-success outcome without a second launch. It must not add binding identity, a second job type, or a second lifecycle state machine.

- [ ] **Step 2: Run lifecycle feasibility tests to verify RED**

Run: `node --test tests/mcp-lifecycle-controller.test.mjs tests/rescue-lifecycle.test.mjs tests/job-control.test.mjs`

Expected: FAIL because no MCP lifecycle controller or selected strategies exist.

- [ ] **Step 3: Implement the minimal feasible controller and freeze three selected strategies**

Implement only adapters over existing interruption, Durable Stop Intent, Host Coordination Loss, Detached Runner/lease, and reconciliation seams. Update `qualification/mcp-lifecycle.json.selectedStrategies` to this closed object only after the corresponding tests pass:

```js
{
  explicitInterrupt: 'direct-abort' | 'durable-stop-intent' | 'release-blocked',
  hostLoss: 'durable-supervision' | 'release-blocked',
  hostTimeout: 'host-abort' | 'server-deadline' | 'durable-supervision' | 'release-blocked',
}
```

`direct-abort` never removes the separate Host-loss requirement. If any dimension is `release-blocked`, commit the characterization/feasibility evidence but do not create `.mcp.json`, the production server, or MCP Skills. Tasks 3 and 5 remain valid completed work; release outcomes are unchanged.

- [ ] **Step 4: Run lifecycle feasibility tests to verify GREEN**

Run the Step 2 command again.

Expected: PASS for all three selected strategies, or PASS for a truthful `release-blocked` decision that proves no existing lifecycle seam can meet the dimension without a forbidden second authority.

- [ ] **Step 5: Write failing server and descriptor tests when no dimension is blocked**

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

- [ ] **Step 6: Run server tests to verify RED**

Run: `node --test tests/mcp-lifecycle-controller.test.mjs tests/mcp-server.test.mjs tests/plugin-contracts.test.mjs tests/integration/plugin-layout.test.mjs`

Expected: FAIL because the production descriptor/server do not exist.

- [ ] **Step 7: Implement fixed handlers**

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

For each call: reject nonempty arguments; parse the Task-2-qualified metadata fields, resolve the full branded authority through Task 4, construct compatibility `CODEX_THREAD_ID` from that verified authority, and call `runDirectInvocation` once with fixed argv, `cwd:authority.executionWorkspace`, `invocationTransport:'mcp'`, `mcpAuthority`, `expectedForegroundAdapter`, and the Task-6 lifecycle controller. Ambient `CODEX_THREAD_ID` and server cwd are ignored. The controller applies the independently selected explicit-interrupt, Host-loss, and timeout strategies; direct abort never substitutes for durable Host-loss ownership. Map through Task 5 and return:

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

Production server steps are not executed when any selected dimension is `release-blocked`. The server must not infer a strategy from Host version or silently substitute one strategy for another; the checked-in lifecycle record and contract tests select each dimension.

- [ ] **Step 8: Run server tests to verify GREEN**

Run the Step 6 command again.

Expected: PASS, including all selected lifecycle-controller contracts and an alive server after ordinary error results. Tests assert durable registration before work, explicit interruption through its selected path, Host-loss reconciliation after simulated server death, timeout settlement through its selected path, and no untracked accepted invocation.

- [ ] **Step 9: Commit**

When all three dimensions are feasible:

```bash
git add .mcp.json scripts/lib/mcp-lifecycle-controller.mjs scripts/zcode-mcp-server.mjs qualification/mcp-lifecycle.json package.json npm-shrinkwrap.json tests/mcp-lifecycle-controller.test.mjs tests/mcp-server.test.mjs tests/plugin-contracts.test.mjs tests/integration/plugin-layout.test.mjs
git commit -m "feat: expose narrow zcode mcp wait tools"
```

When any dimension is `release-blocked`, commit only the feasibility evidence and stop the dependent production-server/Skill/package tasks:

```bash
git add qualification/mcp-lifecycle.json tests/mcp-lifecycle-controller.test.mjs
git commit -m "test: record mcp lifecycle release blocker"
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

The diagnostic exposes only `{status:'qualified'|'unqualified', codexVersion, contextSchemaVersion, lifecycleStrategies}` from the two checked-in redacted records. `lifecycleStrategies` contains the three Task-6-selected dimensions. Missing descriptor/server/SDK/record, any `release-blocked` dimension, or a running Codex version not exactly equal to the recorded version reports `unqualified` and tells users to use canonical Skills; a range requires a future record-schema/spec change. Setup never claims that one live invocation is authorized. Update `skills/setup/SKILL.md` to display this field without auto-selecting MCP.

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
- cancellation before start, during accepted foreground execution, after terminal election, connection loss, and injected host-timeout observation.

Load `qualification/mcp-lifecycle.json` in the tests. Assert the selected explicit-interrupt strategy settles through the existing interruption/stop path; independently assert the selected Host-loss strategy owns accepted work before server death and lets reconciliation finish it; independently assert the selected timeout strategy settles before the 100-hour Host ceiling without relying on an unobserved callback. Status interruption only removes its observer. Assert no accepted invocation becomes untracked, and no duplicate launch, silent shell fallback, second binding state, weakened feature outcome, or additional binding identity field appears.

- [ ] **Step 2: Run the matrix to verify RED**

Run: `node --test tests/mcp-server.test.mjs tests/integration/skills.test.mjs tests/integration/companion.test.mjs tests/integration/true-background-rescue.test.mjs tests/rescue-lifecycle.test.mjs tests/job-control.test.mjs`

Expected: FAIL at any missing selected lifecycle controller, choice adapter check, or parity mapping.

- [ ] **Step 3: Implement the already-specified parity bridges**

Make only the changes selected for each lifecycle dimension. A direct abort feeds the existing interruption slot; durable stop/supervision adapts existing Durable Stop Intent, Host Coordination Loss, lease, and reconciliation seams without creating a second lifecycle state machine; a server deadline must enter that same path before the Host ceiling. In all branches, translate Task-5 formatted results without changing text, carry v5 `foregroundAdapter` through preparation/pending tombstones, and apply the Task-4 authority table before atomic consumption. A need for new binding identity or a second job/lifecycle authority requires a spec amendment; use of an existing lifecycle seam does not. MCP progress notifications remain absent by design.

- [ ] **Step 4: Run the matrix to verify GREEN**

Run the Step 2 command again.

Expected: PASS with identical durable projections and rendered text.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/mcp-invocation-context.mjs scripts/lib/direct-invocation-result.mjs scripts/zcode-mcp-server.mjs scripts/zcode-companion.mjs tests/mcp-server.test.mjs tests/integration/skills.test.mjs tests/integration/companion.test.mjs tests/integration/true-background-rescue.test.mjs tests/rescue-lifecycle.test.mjs tests/job-control.test.mjs
git commit -m "test: prove dual wait adapter lifecycle parity"
```

## Task 9: Prepare package, security, and user documentation

Task 9 prepares artifacts only. Nothing produced here is publishable until Task 10's installed-plugin and selected-lifecycle gates pass and the marketplace snapshot is generated from that passing clean commit.

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

Require npm pack and marketplace installs to contain `.mcp.json`, the server, the invocation-context/result/lifecycle-controller libraries, all four generated Skill directories, both `qualification/mcp-context.json` and `qualification/mcp-lifecycle.json`, and the SDK runtime. Require `bundleDependencies` to list both `fs-native-extensions` and `@modelcontextprotocol/sdk`; require `verifyLockedRuntimePayload` to traverse both locked dependency trees. Copy the installed plugin to an isolated directory whose ancestors contain no `node_modules`, then run MCP stdio initialize/tools-list there. Tampering with or omitting either qualification record must make installed setup report `unqualified`, never crash or claim qualification. Require installed `check:mcp-skills` parity and docs to state:

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

Add `.mcp.json`, `qualification/mcp-context.json`, and `qualification/mcp-lifecycle.json` explicitly to `package.json.files`, add `@modelcontextprotocol/sdk` to `bundleDependencies`, and generalize `verifyLockedRuntimePayload(pluginRoot, lock)` to seed its queue from the two exact runtime roots. Add both qualification records, MCP files, and generated siblings to `REQUIRED_RESCUE_PAYLOAD`; validate both closed schemas while building the snapshot. Document that `foregroundAdapter` is private transport state, never binding/job authority. Amend ADR 0013 for the two exact task-free Child assignments and ADR 0018 for adapter-independent Host/Companion placement.

- [ ] **Step 4: Run tests to verify GREEN**

Run the Step 2 command plus `npm run check:mcp-skills`.

Expected: PASS.

- [ ] **Step 5: Commit source/package/docs before snapshot generation**

```bash
git add .mcp.json package.json npm-shrinkwrap.json scripts skills agents tests README.md README.zh-CN.md SECURITY.md CHANGELOG.md docs/adr
git commit -m "docs: prepare dual wait adapter experiment"
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

- [ ] **Step 3: Re-run context qualification and lifecycle characterization unchanged**

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

Expected: the six context booleans remain true; authority field paths still win the same equality matrix; all five lifecycle cases remain valid observations and exactly match the checked-in `qualification/mcp-lifecycle.json` for the supported Codex version. An observation is not required to be `signal-abort`. A changed observation is a compatibility change that requires selecting and retesting the corresponding dimension, not an instruction to force an old callback. Stale/wrong metadata rejection remains Task 4's authority test and is not claimed by this Host characterization.

- [ ] **Step 4: Qualify the installed production plugin and full Rescue-MCP chain**

First write `tests/e2e/codex-installed-mcp-e2e.test.mjs` with the seven required booleans below and verify RED:

```bash
ZCODE_CODEX_MCP_E2E=1 ZCODE_INSTALLED_MCP_RESULT=/nonexistent \
  node --test tests/e2e/codex-installed-mcp-e2e.test.mjs
```

Expected: FAIL with `Installed MCP qualification result is unavailable`.

Then implement `tools/qualify-installed-mcp.mjs`. It packs and installs the exact clean HEAD as a temporary marketplace/plugin into a fresh mode-0700 Codex home, canonicalizes and pins the externally supplied `--codex` target exactly as Task 2, and securely copies/removes only `auth.json` from required `--source-codex-home` using the same qualification-unavailable and cleanup rules. Every Task 10 real-Host spawn uses the amended positive argv exactly like revised Task 2: no `--ignore-user-config`, with `--ignore-rules`. Credentials are never included in production MCP `env_vars`. It lists exactly eight production tools and invokes all eight against fake/preflight-only state so no provider request is possible. It then runs the exact Task-7 `$zcode:rescue-mcp` scenario and deliberate same-Child shell-misroute scenario.

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

Expected: PASS, including `fullRescueMcpChain`, `sameChild`, `mcpToolObserved`, `shellMismatchRejectedBeforeReservation`, `allEightSchemas`, `noProviderCalls`, and `selectedLifecycleSafe`. `selectedLifecycleSafe` is true only when the installed production plugin demonstrates all three checked-in lifecycle strategies under explicit turn interruption, Host/process loss, and the configured ceiling without an untracked accepted invocation or any reduction of the spec outcomes.

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

Expected: generated `marketplace/plugins/zcode/` includes byte-identical `.mcp.json`, both qualification records, server/libraries, generated Skills, SDK runtime lock, and provenance for exact HEAD.

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
