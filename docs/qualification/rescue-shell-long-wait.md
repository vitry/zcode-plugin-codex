# Rescue Native Shell Long-Wait Qualification

Status: **research-only**. Task 1 executed 2026-10-05; Task 4 live measurements recorded 2026-10-06 under the plan
[2026-10-05-rescue-shell-long-wait](../superpowers/plans/2026-10-05-rescue-shell-long-wait.md)
under the spec
[2026-10-05-rescue-shell-long-wait-design](../superpowers/specs/2026-10-05-rescue-shell-long-wait-design.md).
Worktree base commit `703fdcee958f4729a83d1a978c3b0e5cfa25f90a` (branch base `6638878e910154d7d1bc4effd4c9aa62f149f23a`, merged PR #65).
This document authorizes **no production change**: canonical Skills, Role template, Companion stores, hooks,
packaging, user configuration and `../codex` are untouched. §7 records Task 4 installed observations and
precise limits (§7.7 adds the R5 campaign of 2026-10-08); §8–§9 record Tasks 5–6 executed 2026-10-07, with
inconclusive and `not-proven` outcomes preserved (§9.4 adds the R5 root-family outcomes); §11 is the
coverage/delta/handoff section, updated through R5. §2–§6 retain the source/design findings,
§10 is the current not-proven register (updated through R5), and §12 records fixture-tested instrument
behavior and its limits (§12.9 records the R5 campaign's instrument facts). §13 opens the 2026-10-13
follow-up campaign (Task 1: provenance re-pin and measurement-seam verification, no live run;
§1.2.3 records the re-pinned provenance). §13.10–§13.11 record the 2026-10-15 documentation
close-out amendment (a boundary-assessment scope correction and a read-only Codex source
re-investigation at a new source pin; no host launch, no code change, production scope still
ZERO changes). §14 is the LATEST state: the 2026-10-16 config-path-a execution log (Tasks 1–4 of
`docs/superpowers/plans/2026-10-16-rescue-shell-wait-config-path-a.md`) and its §14.1 close-out —
final run ledger (A0 spent, the campaign's only live run; A1/C0/C1 unspent with recorded causes),
full verification battery, S1–S7/Q1–Q6 mapping and the smallest next decision.

Evidence labels are strict: `source-confirmed` (cited commit+path in the Codex source checkout, revision pinned
below), `installed-observed` (measured on the installed CLI), `fixture-tested`, `not-proven`. No claim mixes
labels, and no source/binary mapping is claimed anywhere in this report.

## 1. Provenance

### 1.1 Plugin worktree (this report's authoring provenance)

| Fact | Value |
| --- | --- |
| Worktree | `.worktrees/rescue-shell-long-wait`, branch `docs/rescue-shell-long-wait` |
| HEAD at execution start | `703fdcee958f4729a83d1a978c3b0e5cfa25f90a` — "docs: add native shell long-wait qualification spec and plan" |
| Working tree | Clean except the planning-session scratch files `task_plan.md`, `findings.md`, `progress.md` (untracked, preserved, not committed) |
| Remote state | `git fetch origin` clean; `origin/main` = `6638878e910154d7d1bc4effd4c9aa62f149f23a`; branch is ahead 1 (the spec/plan commit) |
| Selection tests | `node --test tests/test-selection.test.mjs` — 4 tests, 4 pass, 0 fail (recorded before any tracing) |

### 1.2 Installed CLI (the only live surface for later tasks)

| Fact | Value |
| --- | --- |
| `command -v codex` | `/Users/zhangzikai/.local/bin/codex` |
| `codex --version` | `codex-cli 0.160.0` (recorded fresh on 2026-10-05) |
| Package dependency | `scripts/lib/tool-launch.mjs` defaults to `node_modules/@openai/codex/bin/codex.js` (the repo's pinned dependency) unless `CODEX_BINARY` names an absolute native executable. Task 4 uses the resolved regular executable below; the symlink is not accepted by the driver. |

### 1.2.1 Task 4 installed-run provenance (`installed-observed`)

| Fact | Value |
| --- | --- |
| Installed executable | `/Users/zhangzikai/.codex/packages/standalone/releases/0.160.1-aarch64-apple-darwin/bin/codex` |
| Resolution | `readlink -f /Users/zhangzikai/.local/bin/codex`; the driver requires a regular executable, so `--codex` and `CODEX_BINARY` use this absolute target rather than the symlink or package dependency |
| Version/platform | `codex-cli 0.160.1`, macOS arm64 (`Darwin arm64`); **auto-updated from 0.160.0 during the pipeline**. The Task 1 version above remains historical |
| Main Task 4 source | `7edb8adb1781404301f0a29bcc3bd7de6ab45972` — Case B, Case A, Case 0 run4 and both repeats |
| Earlier Case 0 source pins | run1 `b580e78952d72e95fda1f5bae98100728a39c656`; run2 `9b2bbcdbd1bd3db1081b7fd75d048fc14a871930`; run3 `cede2d84e1b91881a7a61750e429fb62a6922025`. These are the records' actual pins; not all runs used `7edb8ad` |
| Recorded CLI versions | Every collected Case 0/A/B/repeat2 record says `0.160.1`; repeat1 has `codexVersion: null` because lifecycle failure preceded evidence collection, so its version is not independently established by that record |
| Fixture/permissions | `zcode@vitry` `0.1.0`, isolated installed setup, real preparation/binding/launcher with fake ZCode; sandbox and hook trust bypassed as disposable fixture controls, **not persisted production-trust qualification** |
| Setup/config | Records report session established, launcher descriptor published, role ready, two setup attempts; A/B/repeats report fixture cap verified. Case 0 writes no override (`requestedCapMs: null`). Fixture key verification alone is not Child cap-propagation proof |
| Evidence retention | Fresh private OS-temporary output directories outside credential homes; redacted records retained after fixture disposal. Raw fixture paths/private preparation input are not public results |

The source SHA above pins the plugin/instrument snapshot, not the separate Codex source revision in §1.3.
The documentation amendment changes this worktree's final HEAD; it does not rewrite historical case pins.

### 1.2.2 R5 installed-run provenance (`installed-observed`, 2026-10-08)

| Fact | Value |
| --- | --- |
| Installed executable | `/Users/zhangzikai/.local/bin/codex` → the standalone package (`~/.codex/packages/standalone/current` family, §3.3's R4 probe). **Auto-updated from 0.160.1 to 0.161.0 between Task 6 and R5 and re-pinned by direct probe before the trials** |
| Version | `codex-cli 0.161.0`, macOS arm64. Every R5 record that established a version says `0.161.0`; the failed `status-wait` record has `codexVersion: null` because its failure preceded version establishment |
| Fixture source | `5026009b6199f5f2d43ca8a567e536078e95080d` — the fixture installs committed source; the R0–R4 instrument corrections are working-tree-only and never enter the installed snapshot |
| Observer | `working-tree-uncommitted` with a per-record sha256 digest in `provenance.observer` (§12.5): `27bc1715…` for the eight pre-fix trials, `cd41ef07…` for the two post-defaults-fix `r5c` trials (the R5 driver defaults fix changed `driver.mjs` bytes mid-campaign — §7.7, §12.9) |
| Trials and artifacts | Ten retained records under `/tmp/shell-wait-r5*` (§7.7); eight additional empty output directories are recorded orchestrator invocation artifacts that ran NO trial and carry no measurement |

### 1.2.3 Follow-up Task 1 provenance re-pin (2026-10-13; no live run)

Task 1 of the follow-up plan re-pinned the provenance before any live run, with the same conventions as
§1.2.1/§1.2.2. No host was launched; the planning-session `0.162.1` observation (follow-up plan §2) is
confirmed by this non-authenticated probe.

| Fact | Value |
| --- | --- |
| Installed executable | `/Users/zhangzikai/.codex/packages/standalone/releases/0.162.1-aarch64-apple-darwin/bin/codex` |
| Resolution | `realpath` of `command -v codex` (`/Users/zhangzikai/.local/bin/codex` resolves through the standalone package family, §1.2.2); the driver requires a regular executable, so any later case passes this absolute target to `--codex`/`CODEX_BINARY`. This is NOT the `node_modules/@openai/codex` development pin (`0.147.0`), which remains the repo dependency default |
| Version/platform | `codex-cli 0.162.1`, macOS arm64 (`Darwin arm64`, macOS 26.5.2). **Auto-updated from 0.161.0 since R5 and re-pinned 2026-10-13.** The 0.160.1/0.161.0 qualified records keep their own recorded scope; cross-version comparison stops here — every follow-up live measurement re-pins and records its own boundary (follow-up plan Task 1) |
| Follow-up source pin | `e9751d9fe7ee53d11c3f556dcda1527d5547fce7` — worktree `.worktrees/rescue-shell-wait-qualification-next`, branch `docs/rescue-shell-wait-qualification-next`, HEAD "docs: add 2026-10-13 shell long-wait follow-up qualification plan", one setup commit on the merged baseline `41e5b0aa24189903f77acb971931df6de04a170e`; `git status --short` clean at the pin (the documentation commit recording this section postdates it and does not rewrite the pin) |
| Fixture source | The same pin — the fixture installs committed source, and with a clean tree the committed source and the working-tree bytes coincide (`shell_source_sha` = `git rev-parse HEAD` = `e9751d9f…`) |
| Executing observer | Schema revision label `working-tree-uncommitted` with the §12.5/§12.9 per-record construction (`zcode-shell-wait-observer-v1`, NUL-separated module-init snapshot of `evidence.mjs` + `driver.mjs`): digest `e28ec61949e24c027c4d2b85934ffd91c60344b3d3e67063a75b9ba4d91a6dfe`. The tree being clean, these bytes are identical to the committed pin; live records recompute the digest at case start with record-time reconciliation (round-28/29) |
| Module digests (informational sha256) | `evidence.mjs` `aad51e632860df15507f748c2ce433b9fa17db8ef10b67c8b00ab89e53f2e018`; `driver.mjs` `ba42eebf2592702109e377a095ea0a274a9e537962771b9c5c481c93ed4b7e4e`; `fixture.mjs` `8b93ecc8ab1237d3073fec611b1223d81f692adadcc7062a5ba36f9c76cc0335`. The observer digest covers `evidence.mjs` + `driver.mjs` only |
| Codex source checkout | Unchanged from §1.3: `67727e7cf114cf3e1b71db368d74b24e32f6cb12` (main), `git status --short` clean on 2026-10-13. Read-only throughout; the checkout's existence still proves no source/binary correspondence |
| Driver check | `node tools/shell-wait-probe/driver.mjs --help` prints the usage line and all nine case labels (`rescue-baseline`, `rescue-long`, `rescue-repeat`, `rescue-noise`, `rescue-interrupt`, `review-wait`, `adversarial-review-wait`, `status-wait`, `background`) |
| Per-run fields (model, effective isolated configuration, route, instruction variant) | **Captured at first live run.** The record schema defines the retention (`buildCaseRecord`, `driver.mjs`): numeric wait bounds (`requestedCapMs`/`requestedPollMs`/`requestedWorkerDurationMs`/`requestedBudgetMs`/`requestedStatusQueryTimeoutMs`), the observation-cap key's verified application as the record persists it — `requestedCapMs` plus the `isolatedSetup` verified facts incl. `capVerified` (the post-setup regex check that `background_terminal_max_timeout = <capMs>` survived the isolated production setup's configuration writes). The fixture ALSO computes a `capConfiguration` before/after sha256 pair for the config write (fixture.mjs), but that object is fixture-INTERNAL provenance: `buildCaseRecord` never reads it and it is NOT persisted in the case record — if a later executing task needs those hashes in the record, persisting them is a recorded instrument gap for that task to decide, not an existing retention. File digest/mode is retained only for the touched instruction artifacts (`instructionVariants.appliedArtifacts`, `renderedNamedRoleSha256`/`genericMessageSha256`, `commandSkillVariants` — never paragraph text), beside the verified setup booleans, `route.requested`/`route.actual`, and the live `codexVersion`. The executing model is deliberately `null` (`provenance.observer.model` — the instrument cannot observe it and never infers it from hashes) |
| Retention boundary | Verified against the record builder: only the whitelisted redacted facts above persist — never full TOML, authentication, tokens, private preparation input or arbitrary environment values; schema-unknown values stay `null` |
| Selection tests | `node --test tests/test-selection.test.mjs` — 6 tests, 6 pass, 0 fail (recorded before any live attempt, §13.1) |

### 1.3 Codex source checkout (read-only; not matched to any binary)

| Fact | Value |
| --- | --- |
| Location | `/Users/zhangzikai/Workspace/Codes/github/codex` (from this worktree: `../../../codex`) |
| Revision (`git rev-parse HEAD`) | `67727e7cf114cf3e1b71db368d74b24e32f6cb12` (main, committed 2026-09-30) — the same pin as the prior record [source-guided foreground wait](source-guided-foreground-wait.md) |
| Dirty state (`git status --short`) | Clean (no output) |
| Binary mapping | **None established.** Every `source-confirmed` claim below is about this revision's code, not the installed 0.160.0 binary. All inspection used `git -C /Users/zhangzikai/Workspace/Codes/github/codex show 67727e7c…:<path>`. |

## 2. Control path (Q1): native spawn → Child config → Role overlay → session process manager → empty-poll clamp

All citations in §2.1–2.6 are `source-confirmed` at `67727e7cf114cf3e1b71db368d74b24e32f6cb12`. Path convention
(throughout this report): citations that start with a crate or top-level directory (`codex-rs/…`,
`codex-rs/config/src/…`) are full paths under the source root; all other Rust-source paths
(`agent/…`, `session/…`, `unified_exec/…`, `tools/…`, `config/…`) are relative to `codex-rs/core/src/`, so a
citation `agent/role.rs` L36 reproduces as
`git show 67727e7cf114cf3e1b71db368d74b24e32f6cb12:codex-rs/core/src/agent/role.rs` at line 36. Prior-record facts
(section 2 of [source-guided-foreground-wait](source-guided-foreground-wait.md)) are reused, not re-derived.

### 2.1 Native spawn and Child config derivation

- The model-facing `spawn_agent` tool handlers build the Child config through one shared function:
  `tools/handlers/multi_agents/spawn.rs` L98–118 (V1) and `tools/handlers/multi_agents_v2/spawn.rs` L133 (V2)
  call `prepare_agent_spawn_config`, then hand `prepared.config` to
  `agent_control.spawn(SpawnRequest { config, … })` (`multi_agents/spawn.rs` L111–118).
- `agent/child_config.rs` `prepare_agent_spawn_config` (L51–100): the base is
  `build_agent_spawn_config(&session.get_base_instructions(), step_context)` whose
  `build_agent_shared_config` (L131–133) starts from **`turn.config.clone()`** — a full clone of the invoking
  (parent) turn's effective `Config`. Layered afterwards: requested model/reasoning overrides
  (L62–69, L196–253), the Role overlay (`apply_spawn_agent_role` L283–316, applying `apply_role_to_config` at
  L290), service tier (L83, L255–281), and live-turn runtime overrides (L84, L171–194: approval policy, cwd,
  permission profile). **No step in this derivation writes `background_terminal_max_timeout`.**
- The prepared config becomes the Child thread: `agent/control/spawn.rs` `spawn_agent_internal` (L634) →
  `state.spawn_new_thread_with_source(config.clone(), …)` (L751–764). The Child session is then constructed
  from that same config object.

### 2.2 Role overlay whitelist

- `agent/role.rs` `AgentRoleOverrides` (L36–48) admits exactly: `developer_instructions`, `model`,
  `model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`, `personality`, `service_tier`,
  a disable-only `features` subset (L91–105), and `skills` (L106–117). `background_terminal_max_timeout`
  is **not admittable**: the role file is loaded and deserialized for validation (L130–162, user-defined roles
  via `read_sensitive_file_to_string` + `parse_agent_role_file_contents`; built-ins via embedded assets), but
  `build_next_config` (L174–236) clones the incoming config and writes only whitelisted fields. A role file
  declaring the cap would be **silently dropped**.
- The built-in `awaiter` role is still commented out at this pin — "Awaiter is temp removed"
  (`role.rs` L382–399) — while the asset remains embedded (`role.rs` L406–414;
  `codex-rs/core/assets/agent/builtins/awaiter.toml` L1 declares `background_terminal_max_timeout = 3600000`).
  That declaration is therefore **declaration-only**: it proves a source-supported value, not any live Role or
  Child inheritance.

### 2.3 Session process manager

- Per session: `session/session.rs` L1704–1706 constructs
  `unified_exec_manager: UnifiedExecProcessManager::new(config.background_terminal_max_timeout)`.
  Root and each Child resolve independently — each from its own session config; for a spawned Child that config
  is the parent-derived clone of §2.1.
- `unified_exec/mod.rs` `UnifiedExecProcessManager::new` (L176–182) stores
  `max_write_stdin_yield_time_ms = value.max(MIN_EMPTY_YIELD_TIME_MS)`.

### 2.4 Empty-poll clamp and initial exec clamp

- Empty `write_stdin` (empty `chars`): `unified_exec/process_manager.rs` L1013–1022 —
  `yield_time_ms.max(MIN_YIELD_TIME_MS)` then `.clamp(MIN_EMPTY_YIELD_TIME_MS, self.max_write_stdin_yield_time_ms)`
  for empty input; non-empty writes keep `.min(MAX_YIELD_TIME_MS)`. Constants (`unified_exec/mod.rs` L73–78):
  `MIN_YIELD_TIME_MS = 250`, `MIN_EMPTY_YIELD_TIME_MS = 5_000`, `MAX_YIELD_TIME_MS = 30_000`,
  `DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS = 300_000`. Output is collected inside the wait until deadline or
  output closure (`process_manager.rs` L1023–1026).
- The initial `exec_command` yield is clamped to `[250, 30_000]` ms regardless of config
  (`unified_exec/mod.rs` `clamp_yield_time` L218–225).
- Tool description text is static and is not runtime proof: `tools/handlers/shell_spec.rs` L134 ("empty polls
  wait 5000-300000 ms by default").

### 2.5 Effective unraised/default cap observable in source

- Resolution: `config/mod.rs` L3913–3916 —
  `cfg.background_terminal_max_timeout.unwrap_or(DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS).max(MIN_EMPTY_YIELD_TIME_MS)`;
  struct field `config/mod.rs` L1092 (`u64`, doc comment "Default: `300000` (5 minutes)"); user-config TOML key
  `codex-rs/config/src/config_toml.rs` L342 (top-level `Option<u64>`); packaged default
  `codex-rs/config/defaults.toml` L10 `background_terminal_max_timeout = 300000`; schema
  `codex-rs/core/config.schema.json` L6650.
- **Conclusion (`source-confirmed`): the effective unraised default is 300000 ms**, floored at 5000 ms, with no
  source-level upper bound — a user/session-level top-level key raises the empty-poll ceiling. **Installed
  equivalent: not-proven in this task** (no binary mapping; the prior record's Root-surface directive-cap return
  of exactly 300.0 s on 0.160.0 is consistent with this default but is a Root observation, not a Child one).

### 2.6 Configuration layers that reach the managed Child's process manager (Q1 answer, source side)

| Layer | Reaches the Child's cap? | Mechanism |
| --- | --- | --- |
| User/session configuration (`background_terminal_max_timeout` top-level key) | **Yes** (`source-confirmed`) | Resolved into the parent's effective Config → cloned into the Child's base config (`child_config.rs` L131–133) → survives the role overlay (`role.rs` L177–236 never writes the field) → Child session process manager (`session.rs` L1704–1706). |
| Role file (named `zcode-rescue` or any role) | **No** (`source-confirmed`) | Whitelist `AgentRoleOverrides` (role.rs L36–48) drops the field; `build_next_config` never writes it. |
| Built-in awaiter Role | **No** (`source-confirmed`) | Registration commented out (role.rs L382–399); asset declaration only. |
| Spawn-time runtime overrides (approval/cwd/permissions) and model/reasoning/service-tier overrides | **No effect on the cap** (`source-confirmed`) | Disjoint config fields (child_config.rs L62–94, L171–194). |

Whether this inheritance actually holds on the **installed** build remains `not-proven` after Task 4
(0.160.1; §7.3): no cap-limited unraised Child measurement M was established (the prior record's
`scripts/lib/codex-config.mjs` caveat is preserved:
setup/inspection clients never prove managed-Child inheritance). R5 update (2026-10-08, installed
0.161.0), corrected by the post-trials review-loop adjudication: the qualified unraised trial observed a
cap-limited return before the worker's end, but its exact duration was NOT separately retained — the
record's `decisiveWallMs` carries the TERMINAL observation (§7.7) — so M is **bounded but imprecise**
pending re-measurement, and raised-cap propagation is **POSITIVE-but-M-imprecise** against the
observed shape — §7.7. The source-side derivation above is unchanged; no binary mapping is claimed.

## 3. Exact Child interruption surface and Root Status observation

All claims in this section are `source-confirmed` at the pin unless labelled otherwise. Availability on the
installed build is separately labelled.

### 3.1 Candidate exact-interrupt interactions

- **V2 tool `interrupt_agent`** — spec `tools/handlers/multi_agents_spec.rs` L355–376: target is "Agent id or
  canonical task name to interrupt (from spawn_agent)"; description: "Interrupt an agent's current turn, if any,
  and return its previous status. The agent remains available for messages and follow-up tasks." Handler
  `tools/handlers/multi_agents_v2/interrupt_agent.rs` L33–75: resolves the target in the calling session and
  calls `agent_control.interrupt(session.thread_id, AgentTarget::Id(agent_id), V2)`.
- **V1 tool `send_input { interrupt: true }`** — spec `tools/handlers/multi_agents_spec.rs` L160–196; handler
  `tools/handlers/multi_agents/send_input.rs` L66–70 routes the interrupt flag into the same control path.
- **Dispatch** — `agent/control/api.rs` L177–194: V2 → `interrupt_spawned_agent`; V1/Disabled →
  `inspect_agent` + `interrupt_agent` **directly**. The two families have different targeting rules
  (`source-confirmed`):
  - **V2**: the Root session calls its own in-process `LocalAgentControl`, and the targeting rule is that the
    target must be a **known, non-root, non-self agent in the shared in-process registry** —
    `ensure_agent_known` (`agent/control/runtime_context.rs` L25–29, registry metadata or `ThreadNotFound`)
    plus the root/self rejections (`agent/control/interrupt.rs` L22–39). No second process or connection is
    involved.
  - **V1/Disabled**: `api.rs` L186–190 bypasses `interrupt_spawned_agent` entirely — a raw
    `AgentTarget::Id` is accepted without registry validation (`agent/control/target.rs` L20), and
    `inspect_agent` accepts a loaded thread without requiring registry metadata
    (`agent/control/inspection.rs` L14–29; metadata defaults, L26) before the unguarded `Op::Interrupt`. A
    mistaken root or self ID therefore lacks the V2 rejection on this path; qualifying V1 interruption
    requires **explicit exact-child identity validation by the caller** — a Task 5 measurement obligation
    (**installed behavior: not-proven**).
  Parent-ownership validation (`agent/control/spawn.rs` `validate_loaded_v2_child` L293–312) is **not** part
  of either interrupt path: it belongs to the V2 load/ensure/reload paths (called at spawn.rs L395 inside
  `ensure_v2_agent_loaded`, and L612/L622 in the reload path).
- **`interrupt_spawned_agent`** — `agent/control/interrupt.rs` L16–51: rejects root and self targets; takes the
  status snapshot first; an unloaded/dead runtime counts as a successful interruption (never reloads it).
- **Delivery to the live Child turn** — `agent/control.rs` `interrupt_agent` L299–314 sends
  `Op::Interrupt` to the target's live thread via `state.send_op(...)`; the child's turn-abort path cancels the
  turn's cancellation token (`tasks/mod.rs` L926) and ends the turn (graceful wait, `task.handle.abort()`,
  session task abort — L944–956). **Nested-poll cancellation is qualified, not unconditional**
  (`source-confirmed`): the abort path terminates active code-mode cells only when
  `reason == TurnAbortReason::Interrupted` **and** `Feature::CodeModeInterrupt` is enabled
  (`tasks/mod.rs` L927–937), a feature that defaults false (`codex-rs/features/src/lib.rs` L1103–1108); nested
  code-mode dispatch runs in an independently spawned task keyed by a per-cell cancellation token that gates
  new submissions and is handed to `host.submit_tool` (`tools/code_mode/delegate.rs` L202–240). For the pinned
  source's plain function-call dispatch, the aborted turn drops its own pending tool future; for an
  already-yielded cell continued through `wait` — the shape the installed 0.160.0 script wrapper uses (prior
  record §7.0) — turn abortion alone does not establish inner-poll cancellation: the outcome depends on the
  feature, backend and continuation shape. The official test demonstrates terminated cells/nested tools only
  **with the feature explicitly enabled**: `core/tests/suite/code_mode.rs` L5883
  `code_mode_interrupt_terminates_active_cells_and_nested_tools` (enables `CodeModeInterrupt` L5900, submits
  `Op::Interrupt` L5971, asserts the nested tool outcome `Aborted` L5976–5977). Task 5 must therefore qualify
  actual observation cancellation separately from turn interruption and never treat the latter as proof of the
  former; **installed cancellation and settlement: not-proven in this task**. Interrupt hooks would run
  root-only and are irrelevant here (prior record section 2; unchanged at this pin).

**Verdict (`source-confirmed`): an exact, in-process, target-specific Child-turn interruption surface exists at
the pinned source** — the Root session's own `interrupt_agent` (V2) or `send_input {interrupt: true}` (V1) tool,
reaching the exact pending Child turn through `Op::Interrupt`. **Installed availability: not-proven in this
task.** The prior installed role-control run (`source-guided-foreground-wait.md` §7.5) showed an active
`spawn_agent`/`wait_agent` function-tool family on 0.160.0, which makes one of these families very likely
present, but this task performed no live run and the prior run did not exercise interruption. Task 4/5 must
record which family the actual Root tool list exposes.

Explicit non-surfaces: the app-server `turn/interrupt` RPC is useful only on a verified connection owning that
live target — a separate diagnostic app-server is **not** the running CLI session; probe-budget expiry is an
outer kill, **not** exact Child interruption (`installed-observed` on the Root surface, prior record §7.4);
Root SIGINT was never a measured surface in the prior record — restating it as an outer, non-exact kill is a
task boundary, not a prior observation; hook-based interruption stays root-only and ≤3 s with no control effect
(prior record section 2).

### 3.2 Root Status observation

- `wait_agent` (V2 spec `tools/handlers/multi_agents_spec.rs` L297–307; handler
  `tools/handlers/multi_agents_v2/wait.rs` L40–110) subscribes to the Root session's input-queue activity and
  waits until a deadline for mailbox updates (queued messages, final-status notifications); it returns a
  summary, not content. `timeout_ms` is clamped by `multi_agent_v2.min/max/default_wait_timeout_ms`
  (`wait.rs` L53–65); defaults `config/mod.rs` L258–260: min 10 000, **max 3 600 000 (1 h)**, default 30 000 ms.
  The Skill's prescribed `wait_agent({ timeout_ms: 600000 })` fits the 1-hour max.
- This is the Root-side observation channel; it observes Child mailbox/status only and never observes the
  Child's inner shell handle.

### 3.3 R4 addendum: what the installed owning session actually exposes (investigated 2026-10-08)

Fresh source pin: `git -C ../../../codex rev-parse HEAD` = `67727e7cf114cf3e1b71db368d74b24e32f6cb12`,
working tree clean (0 dirty entries). Installed binary re-pinned by direct probe: `codex --version` =
**codex-cli 0.161.0** (`/Users/zhangzikai/.local/bin/codex` → the standalone package
`~/.codex/packages/standalone/current`, `codex-package.json` version 0.161.0, aarch64-apple-darwin) — the
0.160.1 provenance of §1.2 is historical; auto-update moved the installed surface. No authenticated turn
was launched; every installed probe below is a non-authenticated CLI/file probe.

**Family (installed-observed): V2, and it is config-enabled on the live machine.**

- `codex features list` under the real `CODEX_HOME` reports `multi_agent_v2 stable true` and
  `multi_agent stable true`; under a fresh temporary `CODEX_HOME` (binary defaults) it reports
  `multi_agent_v2 stable false`. The delta is the live user `config.toml`, which contains
  `[features.multi_agent_v2] enabled = true` with `default_wait_timeout_ms = 600000` and
  `min_wait_timeout_ms = 600000` (plus the `[agents.zcode-rescue]` role registration). **Config-block
  authorship: NOT ESTABLISHED.** The installed plugin (0.1.0 cache) and its entire git history write only
  `features.hooks`, `hooks.state`, the `features.multi_agent_v2.hide_spawn_agent_metadata` leaf (a
  DELETION), and `[agents.zcode-rescue]` (`scripts/lib/codex-config.mjs` edits list;
  `scripts/lib/managed-agent-role.mjs` :132/:296/:727; `git log -S default_wait_timeout_ms --all` hits
  only a docs commit); the CLI's marketplace/plugin command at the pin performs no config-feature writes.
  Nothing here attributes the enable/timeout block to the plugin or to any other writer. Source pin
  behavior: `features.multi_agent_v2.enabled` is a hard session override
  (`multi_agent_version_override()` → V2), so every live session on this machine — including the owning
  `codex exec` Root — resolves to **V2** regardless of model catalog.
- `codex debug models` (bundled catalog of the installed 0.161.0 binary, dumped non-authenticated from a
  temporary home) declares `multi_agent_version: "v2"` for the current default-capable models
  (gpt-6-astra, gpt-6.1-sol, gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-daybreak-blue/red);
  `gpt-5.6-luna` declares v1 and `gpt-5.5` null — corroboration, not the operative gate.
- The installed Mach-O binary carries the exact V2 `interrupt_agent` spec strings (read-only `strings`
  probe: "Agent id or canonical task name to interrupt (from spawn_agent)" and "Interrupt an agent's
  current turn, if any, and return its previous status").

**Registration reachability (source-confirmed at the pin):** `add_collaboration_tools`
(`core/src/tools/spec_plan.rs`) registers the whole V2 family — `spawn_agent`, `send_message`/
`followup_task` (unless `disable_direct_message`, default false), `wait_agent` (when
`wait_agent_enabled`, default TRUE, `config/mod.rs` `defaults_for_max_concurrency`), and **unconditionally
`interrupt_agent` + `list_agents`** — whenever `collab_tools_enabled`. The V2 gate is
`session_source.get_agent_path().is_none() || model_info.multi_agent_version == Some(V2)`: the **ROOT of a
normal exec session qualifies** — `interrupt_agent` is NOT restricted to special agent setups. The V2
handler (`tools/handlers/multi_agents_v2/interrupt_agent.rs`) resolves the target and calls
`agent_control.interrupt(root_thread, AgentTarget::Id, V2)` → `interrupt_spawned_agent`
(`agent/control/interrupt.rs`): registry-known target (`ensure_agent_known`), root rejection, self
rejection, status snapshot first, dead/unloaded runtime counts as success, then `Op::Interrupt` to the
live Child thread. The V1 fallback (`send_input {interrupt:true}`, Collab default family when MAV2 is
absent) keeps its unguarded direct path (`api.rs`) as §3.1 records — on this machine V1 is not the
resolved family.

**Exact delivery vs inner settlement:** unchanged from §3.1 and now installed-corroborated —
`codex features list` reports `code_mode_interrupt false` (and `instant_interrupt false`), so the
turn-abort path cancels nested code-mode cells only under `TurnAbortReason::Interrupted` AND
`Feature::CodeModeInterrupt` (`tasks/mod.rs`), which is off. An exact-Child TURN interruption is therefore
reachable and wired; inner-poll settlement is NOT guaranteed for an already-yielded cell and stays a
measured R5 outcome, never an inference.

**Rejected/unavailable paths (all re-verified):** the app-server `turn/interrupt` RPC requires a verified
connection owning the live target — a separate diagnostic app-server is not the running exec session; the
exec CLI registers no interrupt subcommand (`codex --help` probed: `queue`/`resume`/`fork`/`archive`
exist, none interrupts a live turn); there is no model-facing self-interrupt tool, so cancelling the Root
turn's own Status observation from inside the session has no native model surface — its cancellation is
exercised at the production wait boundary (the Status command's external observation signal), which
provably sends no job stop/cancel (§12.8).

**R4 wiring consequence:** the reachable in-exec-session delivery path IS the model-facing tool called by
the owning Root turn, so the `rescue-interrupt` case prompt now directs exactly one `interrupt_agent`
delivery to the exact spawn-acknowledgement agent id while the observation is pending, with collateral
interruption explicitly forbidden; the observer records the delivery facts fail-closed (§12.8). The live
delivery measurement itself happens in R5 through this wired path — R4 ran no authenticated turn.

## 4. Current plugin flow (production, this worktree)

All paths relative to the plugin worktree; behavior facts are repository-text facts (a read of the shipped files
at this worktree), **not** installed-observed delivery — the installed delivery of each text is a Task 4
verification item.

- **Skill contract** (`skills/rescue/SKILL.md`): immutable launcher descriptor gate (L10–24); Role preflight
  (L50–54); one-shot private preparation with a raw-capable TTY and the single post-readiness `write_stdin`
  frame (L94–116), emitting the **version 5** envelope (`scripts/lib/rescue-preparation.mjs` L18
  `RESCUE_PREPARATION_VERSION = 5`; option keys include `foregroundAdapter`, L29); prepared-route object
  validation (SKILL L116).
- **Named vs generic routes**: prepared `spawn` route prefers the named `spawn_agent({…, agent_type:
  'zcode-rescue', …})` with the fixed assignment literal (SKILL L126–135); the generic route is the fixed
  task-blind forwarder message without `agent_type` (SKILL L150–173). Schema negotiation is bounded by the
  table at SKILL L139–148: only a proven pre-child `agent_type` field rejection may continue with the one
  generic child-producing call; a Role-value rejection, collision, timeout, or any returned agent ID is
  terminal. The route directives come from `scripts/lib/rescue-route-planner.mjs`: followup
  `{version:2, action:'followup', target, assignment: 'zcode-rescue'|'default'}` (L107–115) and spawn
  `{version:1, action:'spawn', taskName}` (L199–204).
- **Fresh/choice/prepared continuation**: `needs-choice` → exact continuation strings sent via
  `followup_task({target: rescueChildPath, …})` (SKILL L195–208); `fresh` consumes a `parent-replan` and
  retires the old child (SKILL L210); proactive resume generation is one-shot within the still-active parent
  turn (SKILL L157 / Role template L7).
- **Managed Role**: the rendered Role is `developer_instructions` only
  (`agents/zcode-rescue.toml.template` L1–40) — **it declares no `background_terminal_max_timeout`** (and could
  not propagate one per §2.2). Its fixed wait policy (template L14): initial `exec_command` yield up to
  30000 ms, then same-handle **empty-input `write_stdin` with `yield_time_ms: 60000`** in plain argument form;
  outer-cell continuation rule (L16); between-polls-only status sidecar (L20–22). Registration is
  `agents.zcode-rescue = {description, config_file: <rolePath>}` written through
  `scripts/lib/managed-agent-role.mjs` (`renderManagedRescueRole` L35–54; `expectedRegistration` L663; journal +
  receipt + rollback L66–177) into the Codex config target file.
- **Private preparation TTY writes vs Child empty observations**: preparation writes carry the task bytes once
  inside the single post-readiness `write_stdin` frame on the launcher handle (SKILL L100–116); the Child's
  terminal observations are empty-input polls of the companion handle (template L14). These are different
  channels with different rules; the empty-input long-poll policy can only change the Child observation side,
  never the preparation frame.
- **Preparation consumption, executor/binding validation and exact reservation** (repository-text facts): the
  chain runs SubagentStart forwarding publication → `invoke-prepared rescue` → one-shot consume → private
  route. (1) At SubagentStart, `hooks/subagent-hook.mjs` L59 resolves the parent's exact active turn (identity
  store, workspace binding `execution`) and `markForwarding` (`hooks/lib/hook-state.mjs` L575) publishes the
  exact `executor-route` record — agentId, agentType, parentSessionId, parentGenerationId, parentTurnId,
  parentPermissionMode, childTurnId, origin/target workspace, state `pending` (L619) — under a file lock that
  rejects conflicting or stopped-replay routes (`EXECUTOR_ROUTE_INVALID` L622–623) and links the child to the
  exact active parent turn (`EXECUTOR_PARENT_TURN_MISMATCH` L614–617); session-start epoch evidence is
  revalidated before the executor is published (L672–674), and the route transitions `pending`→`active`
  (L696) or `stopped` (L690). (2) `invoke-prepared rescue` (`scripts/zcode-companion.mjs`
  `runDirectInvocation`, gate L822–823) requires the ambient `CODEX_THREAD_ID` (L831), resolves the executor
  from that published exact route (`resolvePreparedExecutionContext` L1122–1128 →
  `resolveRoutedForwardingExecutor`, `hooks/lib/hook-state.mjs` L1004), and requires the child's parent
  turn/permission/generation to match the active caller (`assertExecutorMatchesCaller` L1301–1305).
  (3) One-shot preparation consumption — **not** the authoritative reservation
  (`scripts/lib/rescue-preparation.mjs` `consume` L321–379): it runs under a preparation lock keyed by
  session+turn+workspace and only marks the preparation consumed — identity mismatch, already-consumed
  (`RESCUE_PREPARATION_CONSUMED` L336–337), a non-consuming transport/adapter mismatch
  (`RESCUE_FOREGROUND_ADAPTER_MISMATCH` L347), required executor-agent-id and activation-proof mismatches, and
  expiry all fail closed before the consumed record is atomically written (L376). The `beforeConsume` hook
  (`scripts/zcode-companion.mjs` L889) is scoped to **exact-reactivate activations only** — it returns early
  for every other activation kind (L890–891) — and then re-reads the host child and validates exact identity
  (`validateExecutorHostIdentity` L1202–1209: host id, parent session, role, origin workspace) plus the
  activation's `executorAgentId` and agentPath sha256 digest, requiring a fully equal durable binding via
  `readRescueBindingMigrationProof` + `resolveRescueBindingForResume` (any field difference →
  `RESCUE_BINDING_INVALID`). `fresh` requires activation kind `spawn` (L952–953), and the spawn path derives
  `/root/${taskName}` whose sha256 must equal the prepared activation digest (L976–979) — the child target is
  the prepared activation, never an inferred value.
  (3b) The authoritative atomic job/binding reservation happens **later**, under the state lock
  (`scripts/zcode-companion.mjs` L1524–1544): the epoch gate (`reservationEpochGate`, L1840) is passed as
  `beforePersist`, and inside each reservation's own `withFileLock` critical section
  (`scripts/lib/state.mjs` `reserveFreshRescueJob` L413–462 and `reserveBoundRescueContinuation` L468–525) it
  runs the fail-closed pending prior-epoch receipt check **before any binding or job record is written** (the
  atomic epoch fence at the `beforePersist` call sites in both functions). The fresh reservation validates the
  binding expectation (`expectedOperationId`/`expectedAnchorJobId`/`expectedCurrentJobId` →
  `staleRescueBinding`) against the read-only binding snapshot, re-verifies the slot under the lock, and
  publishes job+binding atomically (`publishRescueReservation`, binding-first); the bound continuation resolves
  the binding under the same lock and rejects any expected-field difference
  (`expectedCurrentJobId`/`expectedAnchorJobId`/`expectedBindingKey`/`expectedBindingUpdatedAt`/
  `expectedResumeSessionId` → `staleRescueBinding`). Because consumption only marks the preparation consumed, a
  stale-binding or epoch rejection at this later boundary can still fail the invocation after consumption —
  consumption cannot substitute for this reservation boundary.
  (4) Prepared follow-up target and assignment authority: `scripts/lib/rescue-route-planner.mjs` resolves the
  single usable bound candidate through `resolveExactBinding` (L96–102; more than one →
  `RESCUE_CHILD_AMBIGUOUS`; resume with none → `RESCUE_BINDING_INVALID`) and emits the followup directive
  `{version:2, action:'followup', target: selected.host.agentPath, assignment: selected.executor.agentType}`
  with assignment only `'zcode-rescue'` or `'default'` (L105–115, exact-shape validation L212–216); a spawn
  plan allocates the collision-free task name (L199–204). Root must follow `prepared.route.target` — the
  plugin-prescribed agent path, never a guessed child ID — and selects `routeSpecificPreparedAssignment` only
  from that task-free `assignment` value: the exact named literal for `zcode-rescue`, the complete fixed
  generic message for `default`, with a host rejection terminal and no spawn fallback
  (`skills/rescue/SKILL.md` L118–124).
- **Native follow-up / waiting route (Root)**: Root joins the exact child with the longest native
  `wait_agent` for Host-foreground placement and performs no `wait_agent` for Host-background (SKILL L33,
  L175–177); prescribed shape `wait_agent({ timeout_ms: 600000 })` (SKILL L181–187). Root never polls the
  Child's shell handle and never inspects private binding state.
- **Hooks** (`hooks/hooks.json`): SessionStart, UserPromptSubmit, SubagentStart/SubagentStop
  (`hooks/subagent-hook.mjs` — forwarding publication plus an advisory, observation-only SubagentStop
  settlement, L92–144), Stop review gate, SessionEnd. None of these intercepts the Child's shell tool.
- **Binary selection**: `scripts/lib/tool-launch.mjs` L56–66 — `CODEX_BINARY` (absolute, no `.cmd`/`.bat`)
  overrides; default is the repo's pinned dependency entry point. The managed Child does not select a binary
  itself; it inherits the host CLI that spawned it.

## 5. Existing harness limitations (recorded, not changed)

The canonical E2E qualifier `tests/e2e/codex-skills-e2e.test.mjs` pins, at repository state `703fdce`:

- **Supported Codex lines**: `SUPPORTED_CODEX_LINES = ['0.147']` (L55) and the devDependency pin
  `@openai/codex` `0.147.0` (L459–460) — the installed 0.160.0 host is outside its qualification scope.
- **Old v4 prepared expectations**: version-4 envelopes at L833 and L1370 (the current production preparation
  emits version 5, `rescue-preparation.mjs` L18).
- **60000-ms observation policy**: `appliedPollYieldMs: 60000` / `appliedRootWaitMs: 600000` (L610–612), the
  installed poll input `yield_time_ms: 60000` (L3383), and 60 000-ms wait helpers throughout
  (L1308, L1312, L1355–1356, L2045–2046).

This task edits and relaxes nothing. Research uses the current **v5 production preparation** and a separate,
small research observer (Task 3); the canonical oracle keeps its pins. Launch authority is always the real
stores/launcher — no manually manufactured authority records.

## 6. Narrow hypothesis and first discriminating trial (design; Task 4 outcomes in §7)

### 6.1 Hypothesis (source-backed, narrow)

Because the Child's base Config is a clone of the parent's effective config
(`child_config.rs` L131–133) and the Role overlay cannot write `background_terminal_max_timeout`
(`role.rs` L36–48, L177–236), a cap declared in the **fixture session/user configuration** (top-level
`background_terminal_max_timeout = 3600000` in the fixture `CODEX_HOME` `config.toml`) should reach the managed
Child's `UnifiedExecProcessManager` unchanged, exactly as it reaches Root's. The delivered instructions, not the
Role file, decide the argument form; on the installed 0.160.0 Root surface the prior record demonstrated that
the **directive-led** poll form converts the raised cap into a single long observation while the plain
`yield_time_ms` argument clamps every model-visible wrapper re-entry at ≈31 s — a wrapper behavior that is
**not** in the pinned source and must be re-observed on the actual Child, not assumed.

**Cap placement: fixture session/user configuration first.** The cap must **not** be placed in the managed Role
file merely because the awaiter asset contains it: the whitelist drops it (`source-confirmed`, §2.2) and the
awaiter registration is commented out — the asset's 3600000 is a declaration only, verified here as
unregistered at the pin.

### 6.2 First discriminating live trial (design; propagation remains `not-proven`)

- **Fixture**: Task 3's isolated installed-plugin fixture; exact installed executable
  (resolved regular executable in §1.2.1, 0.160.1 at live execution); fake-ZCode hold; worker duration and probe
  budget are sized from the measured unraised default (Case 0 below), not from a hard-coded 420000 ms.
- **Case 0 — unraised-cap control, M measurement (runs FIRST)**: fixture WITHOUT the raised cap, running the
  **same candidate long-request waiting paragraph as Case B** — identical long inner request (the `// @exec`
  directive-led same-handle empty poll) and identical long outer request. **M is assigned only when the
  observation is demonstrably cap-limited**: the inner poll returns COMPLETED to the model while the original
  worker remains running, its wall time is strictly below the requested long yield (requested-yield expiry
  excluded), and no other ender produced the return. Requested-yield expiry, an outer-cell continuation
  return, early process exit, interruption, or probe-budget expiry each leave **M not-proven** — the run
  records only the observed duration. The pinned source's 300000 ms default is a source fact (§2.5) — it is
  NOT the trial's reference, and the prior record's exactly-300.0 s return was measured on Root, not a Child.
  The Case 0 worker duration is sized so the held worker can outlive a poll of any plausible cap (sized
  generously; a worker exit before the poll returns leaves M not-proven for that run).
- **Case A — `rescue-baseline`** (cap-matched current-instruction control): fixture cap 3600000 + the
  **unmodified** v5 named assignment and Role text (30000 initial / 60000 plain empty polls). Case A vs
  Case B isolates the instruction policy at the same raised cap.
- **Case B — `rescue-long`** (candidate / propagation case): fixture cap 3600000; the SAME waiting paragraph
  and identical inner/outer requests as Case 0. **The ONLY difference between Case 0 and Case B is the cap
  configuration** (unraised vs 3600000) — that pair alone isolates configuration propagation.
- **Discriminator**: configuration propagation is concluded only against **M**: because Case 0 and Case B
  carry identical requests, if Case B's observed observation window decisively exceeds M (e.g., a single
  cap-limited observation to process exit beyond M), the raised cap demonstrably reached the Child's process
  manager through the used argument form — the criterion is "decisively exceeds the MEASURED default", never
  "exceeds 300000 ms" (an installed Child with a different unraised default could otherwise pass the threshold
  while ignoring the override). Until M is established under Case 0's cap-limited rule, the trial reports only
  the observed durations and configuration propagation stays **not-proven**.
  Separately, if Case A shows only ≈31 s re-entries while Case B shows one long observation, the trial
  demonstrates that on this build the directive path is the surface that avoids the ≈31 s model-visible
  re-entry cadence for the managed Child — no stronger "only effective surface" conclusion follows, and
  whether the plain-argument path could eventually reach a longer inner observation stays not-proven (prior
  record §7.3's corrected note: a single long poll measures the wrapper's yield granularity, not an inner-cap
  effect). Validity precondition: the decisive poll must start with ≥ M + 30000 ms of worker lifetime
  remaining, else the case is inconclusive for cap behavior; if M leaves too little lifetime at the planned
  worker duration, the run is sized or repeated — never adjudicated against a smaller reference.

  R5 outcome (2026-10-08), corrected by the post-trials review-loop adjudication: the unraised trial observed
  a **cap-limited return before the worker's end** (the §6.2 rule's qualitative elements held), but the
  cap return's exact duration was **not separately retained** in the record — the retained
  `decisiveWallMs` is the terminal observation's (§7.7) — so M is **bounded but imprecise** and the
  discriminator is **POSITIVE-but-M-imprecise** (raised Case B fresh: 388300 ms, zero re-entries; the
  numeric M ratio and the M + 30000 precondition cannot be recomputed at retained precision) — §7.7.
  Re-measurement with the per-poll-timing observer (§12.8) re-adjudicates.
- **Same-rollout recording**: which collab tool family the actual Root session exposes (V1 namespace vs V2 flat
  `spawn_agent`/`wait_agent`/`interrupt_agent`) — this records the installed interrupt-surface verdict for §3.1
  without a separate campaign.

## 7. Managed Child live measurements (Task 4)

### 7.1 Case B: qualified named-route long observation (`installed-observed`)

**Zero outer re-entries: one long observation through process exit instead of the baseline cadence.**
The candidate invocation is **QUALIFIED** for this observed named route on installed 0.160.1.
This is current-invocation completion and reduced re-entry evidence; cap propagation and repeatability
remain `not-proven` at that stage (§7.3–§7.4) — historical: R5 closed repeatability QUALIFIED and
propagation POSITIVE-but-M-imprecise (§7.7/§10).

Record: [Case B](/tmp/shell-wait-t4-rescue-long.TNpWiR/rescue-long.record.json).
Executed `rescue-long --cap-ms 3600000 --worker-duration-ms 420000 --poll-ms 3600000 --budget-ms 1200000`
through `tools/shell-wait-probe/driver.mjs`, with `ZCODE_SHELL_WAIT_E2E=1`, the resolved installed executable
in both `--codex` and `CODEX_BINARY`, `--source-sha 7edb8adb1781404301f0a29bcc3bd7de6ab45972`, and a fresh
private output. The candidate changes only the fixture waiting paragraphs; production launch authority remains
preparation/binding plus the admitted original launcher command.

| Recorded fact | Case B |
| --- | --- |
| Route actually selected | **named** |
| Native Child linkage | `childLinkageChecked: true`; child `01a111c2-af71-7f40-a924-7b86a0538a36`, parent `01a111c2-1fe5-7341-a2f0-6218615d0048` |
| Companion | `companionLaunchCount: 1`, `companionSendCount: 1` |
| Original handle | `originalHandleChecked: true`; poll `session_id: 5648` |
| Child cadence | `outerReturns: 0`, `modelCalls: 2` |
| Decisive observation | `decisiveWallMs: 386600`: **one 386.6-second observation spanning to process exit**, not a sum of polls |
| Other observation fields | `remainingLifetimeMs: 33400`, `pendingInnerAtEnd: false` |
| Root joins | `rootJoins: 1`, separately counted from Child calls and outer returns |
| Terminal result | `processExit: 0`, `hostExit: 0`, `publicResultMatchedSentinel: true`, `terminalStdoutChecked: true` |
| Cleanup | `label: observation`, `fixtureDisposed: true`, `cleanupComplete: true`, `cleanupErrorCount: 0` |
| Inconclusive | `null` |

The two retained, untruncated Child call excerpts are the initial `invoke-prepared rescue`
`exec_command` (`yield_time_ms: 30000`) and the original-handle empty `write_stdin`
(`session_id: 5648`, `chars: ""`, `yield_time_ms: 3600000`, `max_output_tokens: 10000`). The candidate requests
both a directive-led long outer window (`// @exec: {"yield_time_ms": 3600000}`) and that long inner yield.
The redacted excerpts normalize tool arguments rather than retaining the wrapper source; the single completed
386.6-second observation and absence of outer continuations are the measured outcomes.

The sentinel `ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C` occurs **byte-exactly in the linked terminal public output**.
As defined in §12.4, this checks unchanged sentinel bytes within the existing renderer's output, not equality
of the whole rendered stdout with a bare result body or an assistant-message echo. Two Child model calls are
not zero whole-operation decisions; zero describes only outer re-entries during the held observation.
No token savings were measured.

`remainingLifetimeMs` is the instrument's arithmetic residual, `workerDurationMs - decisiveWallMs`
(`420000 - 386600 = 33400`), not a directly measured poll-start lifetime. The record cannot establish the
§6.2 M + 30000 poll-start validity precondition because M is unknown.

### 7.2 Case A: cap-matched current-instruction control (`installed-observed`)

Record: [Case A](/tmp/shell-wait-t4-baseline2.sq14ox/rescue-baseline.record.json).
Executed `rescue-baseline --cap-ms 3600000 --worker-duration-ms 420000 --poll-ms 60000 --budget-ms 1200000`
with the same source pin, installed executable, sandbox/hook controls and permissions as Case B, in a fresh
fixture. Its baseline named Role/Skill hashes are unchanged from the installed production artifacts;
Case B's record separately retains the applied candidate hashes (§1.2.1, §12.2).

Actual route **named**; Child linkage checked; child `01a111d7-ae3f-7fc1-824c-dd588b9a7b38`, parent
`01a111d7-0ebd-7b02-bc7d-15c23cf8e7fd`. Launch **1**, send **1**, `outerReturns: 15`, `modelCalls: 23`,
`rootJoins: 7`. Terminal facts: `processExit: 0`, `hostExit: 0`, sentinel **true**, stdout checked **true**;
cleanup `observation`, complete, fixture disposed, **0** errors.

**Completion remains `not-proven` under the observer:** `originalHandleChecked: false` and
`pendingInnerAtEnd: true`. The observer could not link the consecutive wrapper polls and their
`wait cell_id` continuations to its tracked pending cell. Its inconclusive reason records unresolved or
ambiguous outer continuations and a pending inner tail. This is an **instrument linkage limitation**,
not an installed host rejection or proof of overlapping live polls. Recorded `decisiveWallMs: 0` and
`remainingLifetimeMs: 420000` do not establish a qualified decisive duration or measured poll-start lifetime.

Per-call excerpt evidence (23 retained excerpts, untruncated) includes this sequence:

```json
{"tool":"write_stdin","arguments":{"session_id":22258,"chars":"","yield_time_ms":60000}}
{"tool":"wait","arguments":{"cell_id":"2","yield_time_ms":10000}}
{"tool":"wait","arguments":{"cell_id":"2","yield_time_ms":10000}}
{"tool":"write_stdin","arguments":{"session_id":22258,"chars":"","yield_time_ms":60000}}
{"tool":"wait","arguments":{"cell_id":"3","yield_time_ms":10000}}
{"tool":"wait","arguments":{"cell_id":"3","yield_time_ms":10000}}
```

The complete excerpt list contains seven empty 60000-ms polls on handle `22258`; two continuations each for
cells `2`, `3`, `4`, and three each for `5`, `6`, `7`: **15 outer re-entries over the same requested
420-second hold versus 0 for Case B**. These observable call/cadence facts stand despite the completion
linkage limitation. Root joins remain separate; per-call wall durations and cap causality are not inferred.

### 7.3 Case 0: unraised Child cap M not established (`not-proven`)

Run-level facts below are `installed-observed`; the M verdict remains `not-proven`.
All four candidate-policy runs omit `--cap-ms`, request `--poll-ms 3600000`, and use a 420000-ms worker.
Run1 budget is 720000 ms; runs2–4 use 1200000 ms. No run satisfies the cap-limited completed-inner-poll
rule in §6.2. Unknown counts in unsupported-shape records remain **null**, never zero.

| Run / retained record | Actual source pin | Recorded outcome and distinct cause |
| --- | --- | --- |
| [run1](/tmp/shell-wait-t4-case0.CsuXgR/rescue-long.record.json) | `b580e78952d72e95fda1f5bae98100728a39c656` | Inconclusive `unsupported-call-shape`: multi-statement diagnostic cell exceeded the then one-statement grammar. Instrument gap fixed in `9b2bbcd`; budget cleanup complete, 0 errors |
| [run2](/tmp/shell-wait-t4-case0b.bJLmLH/rescue-long.record.json) | `9b2bbcdbd1bd3db1081b7fd75d048fc14a871930` | Inconclusive `unsupported-call-shape`: compact no-space wrapper tail (including terminal semicolon). Distinct grammar gap fixed in `cede2d8`; budget cleanup complete, 0 errors |
| [run3](/tmp/shell-wait-t4-case0c.Lj2npB/rescue-long.record.json) | `cede2d84e1b91881a7a61750e429fb62a6922025` | Full production flow observed: named route, exact Child/handle, launch 1, send 1, process/host exit 0, outer returns 0, model calls 3, Root joins 7, decisive 82400 ms, pending inner false. Inconclusive under the then-strict whole-stdout sentinel rule (`publicResultMatchedSentinel: false`); rule and retention fixed in `7edb8ad`. Observation cleanup complete, 0 errors |
| [run4](/tmp/shell-wait-t4-case0d.jHqZlH/rescue-long.record.json) | `7edb8adb1781404301f0a29bcc3bd7de6ab45972` | **INSTRUMENT GRAMMAR LIMITATION** (manually adjudicated retained excerpt): preparation write includes `yield_time_ms:1000`, excluded by `PREPARATION_PATTERN`; removing only that argument makes the excerpt parse. Execution behavior and route/linkage/counts unknown; host exit 0, observation cleanup complete, 0 errors. Inconclusive verdict preserved, no further retry |

Run3's `evidence.count: 0` is the old excerpt-retention defect, not absence of collected calls (§12.4).
Its 82.4-second decisive observation ended with process exit, not a cap-limited return while the worker
remained running. It cannot establish M even after the sentinel rule correction, and its disposed stdout
cannot be retrospectively requalified. Each follow-up addressed one distinct established cause;
**no host-behavior outcome was retried out of the record**.

**M: `not-proven`. Raised-cap propagation onto the Child: `not-proven`.** The Case B observation of
**386.6 seconds exceeds the source-pinned 300000-ms default**, establishing an effective observation ceiling
on that Child of **at least 386.6 seconds** (`installed-observed`). This bound does not establish that the
fixture override caused it: an unknown installed unraised default could also allow that observation.
The spec requires discrimination against measured M, not against the unmatched source default. The A/B
instruction comparison is still useful independently of this configuration-causality gap.

R5 update (2026-10-08, installed 0.161.0), corrected by the post-trials review-loop adjudication: a qualified
cap-limited unraised trial observed the cap return qualitatively, but its exact duration was not
separately retained (the record's `decisiveWallMs` is the terminal observation's — §7.7), so M is
bounded-but-imprecise and the raised-cap discriminator is POSITIVE-but-M-imprecise; the four
0.160.1 records above remain the historical Task 4 attempts — §7.7.

### 7.4 Repeat outcome (`not-proven`)

> **Historical record:** this section adjudicates the Task 4-era attempts on installed 0.160.1. Repeat
> was subsequently closed **QUALIFIED** at R5 on distinct Children (§7.7, §10, §11.1); §11.1 carries
> the current mapping.

The recorded failure outcomes are `installed-observed`; repeat qualification remains `not-proven`.
Both attempts requested `rescue-repeat --cap-ms 3600000 --worker-duration-ms 420000 --poll-ms 3600000
--budget-ms 1200000` at source `7edb8adb1781404301f0a29bcc3bd7de6ab45972` with fresh outputs.

- [repeat1](/tmp/shell-wait-t4-rescue-repeat.LX9ij8/rescue-repeat.record.json): `status: failed`;
  **instrument lifecycle failure** before evidence collection: the exact fake-ZCode process remained alive
  during natural-exit verification. The retained reason is truncated after “during natural”. Route,
  cadence, terminal result and CLI version remain null. Failure cleanup verified exact-process and host
  termination; fixture disposed, cleanup complete, 0 errors. The requested path
  `/tmp/shell-wait-t4-repeat.LX9ij8` is absent; this is the actual retained record directory.
- [repeat2](/tmp/shell-wait-t4-repeat2.9hJDAp/rescue-repeat.record.json): **INSTRUMENT GRAMMAR LIMITATION**,
  manually adjudicated from the retained preparation-write excerpt. `PREPARATION_PATTERN` excludes its
  `yield_time_ms:1000`; removing only that argument makes the excerpt parse. Execution behavior is unknown,
  with no evidence of departure from the prompted flow. Inconclusive `unsupported-call-shape` preserved,
  host exit 0, unknown Child/count/result facts; observation cleanup complete, fixture disposed, 0 errors.
  Recorded without retry.

No comparable successful repeat interval or repeat cadence was established. Neither failure is evidence
against the installed long-wait mechanism, nor does either count as repeat qualification.

R5 update (2026-10-08, installed 0.161.0): the repeat dimension was subsequently **QUALIFIED** by a fresh
raised run on a distinct Child — §7.7. The two 0.160.1 attempts above remain the historical Task 4 record.

### 7.5 Task 4 coverage (partial report closure; Task 7 mapping)

| Spec item | Evidence label and Task 4 scope |
| --- | --- |
| S1 preparation/binding authority | **Partial — `installed-observed`**: Case B exact native Child/parent linkage, production preparation/binding admission, one launcher invocation/send. Unsupported preparation cases retained. **`fixture-tested`**: §12 observer/preparation negatives. Full mismatch/one-shot production regression coverage belongs to Tasks 5/7 |
| S2 original-handle/outer-cell ownership | **Partial — `installed-observed`**: Case B original handle `5648`, one settled long observation, no pending inner tail. **`fixture-tested`**: §12 foreign/overlap/continuation negatives. Case A completion linkage is **`not-proven`** due to instrument limitation; noise/interruption ownership remains Task 5 |
| S3 exact public/terminal/control outcomes | **Partial — `installed-observed`**: Case B terminal/host exit 0, byte-exact sentinel in linked terminal output; Case A exit/sentinel facts. **`fixture-tested`**: renderer/sentinel negatives in §12. Choice/error and other waiting-command outcomes remain **`not-proven`** in this task (Tasks 5/6) |
| Q1 effective Child configuration | **`not-proven`**: fixture cap key verified, Child observation ceiling at least 386.6 s (`installed-observed`), but M missing; propagation cannot be distinguished from unknown installed default |
| Q2 effective Child instructions | **`installed-observed`**, named-route invocation only: candidate long empty-poll request yields one 386.6-s observation; current instruction control yields 15 continuations. **`fixture-tested`**: named/generic artifact paragraph synchronization. Generic installed behavior and universal directive support remain **`not-proven`** |
| Q3 cadence and repeat | **`installed-observed`**: Case A 15 outer returns/23 Child calls/7 Root joins; Case B 0/2/1. **`not-proven`**: comparable repeat, per-token savings and reproducibility beyond this invocation |

R5 and the inherited-contract re-recordings (§8.5) superseded rows S1/S3/Q1/Q3 above: the production
mismatch/one-shot/result/choice/error suites were re-recorded (§8.5); M/propagation are adjudicated per
§7.7 and §10 (M bounded-but-imprecise, propagation POSITIVE-but-M-imprecise) and repeat closed QUALIFIED
(§7.7); §11.1 is the current mapping.

The host selected the named route wherever a route was established. Generic installed-route qualification
remains `not-proven`; there was no forced generic fallback. Structural paragraph parity is only
`fixture-tested` (§12), not evidence of a second installed route. Native interrupt delivery, full tool-family
exposure, routine progress relay absence and long-wait Status responsiveness are not established by these
retained call excerpts; those dimensions remain open for Task 5.

### 7.6 Documentation-amendment gates

Fresh gates for this report/plan amendment (`fixture-tested`; no new authenticated live run):

| Command | Result |
| --- | --- |
| `node --test tests/test-selection.test.mjs` | **6/6 pass**, 0 fail, 0 skipped |
| `npm run lint` | Exit 0 |
| `npm run typecheck` | Exit 0 |
| `git diff --check` | Exit 0 |
| `npm run test:shell-research` (one run) | **173 tests, 169 pass, 4 fail, 0 skipped**, 10 suites, exit 1; 16.37 s |

All four shell-research failures are the recorded **sandbox artifacts**, not host long-wait outcomes:
real-builder failure-path prune and real marketplace-install tests hit npm-cache `open EPERM` outside the
writable roots; the two real macOS process-identity/lifecycle tests hit process-inspection `spawn EPERM`.
The observer regressions passed; no test expectation or instrument code was changed for this documentation
amendment, and no second shell-research run was used to erase failures. Gate log:
`/tmp/rescue-shell-long-wait-task4-gates.log`. The suite is not reported as fully green.

Only the tracked report and plan are updated by this amendment; `git add -u` preserves untracked
`task_plan.md`, `findings.md`, `progress.md`. No push or production change is part of this task.

### 7.7 R5 campaigns: cap-limited return observed (M bounded-but-imprecise), propagation POSITIVE-but-M-imprecise, repeat QUALIFIED; inconclusive unclassified-cell retrials recorded (`installed-observed`, 2026-10-08; M adjudication corrected by the post-trials review loop that converged before commit `60b9fc5`)

R5 ran the plan amendment's bounded follow-up trials on installed **codex-cli 0.161.0** (§1.2.2) with the
fixture installing committed source `5026009b6199f5f2d43ca8a567e536078e95080d` and the working-tree
(R0–R4-corrected) observer whose per-record digest is carried in every record's `provenance.observer`
block (§12.5). Ten trials produced retained records, each run exactly once; no outcome was retried out of
the record. All rescue-family trials used the candidate variant and `--poll-ms 3600000`; the unraised M
control omitted `--cap-ms` (parser default `null`), every other case passed `--cap-ms 3600000` explicitly.

| Trial | Retained record | Outcome |
| --- | --- | --- |
| M — `rescue-long`, UNRAISED (no `--cap-ms`), worker 420000 ms, budget 1200000 ms | [record](/tmp/shell-wait-r5-m.OIcGg0/rescue-long.record.json) | **QUALIFIED, `inconclusive: null` — cap-limited return OBSERVED, exact duration NOT separately retained; M bounded-but-imprecise (corrected by the post-trials review loop).** Named route, launch 1/send 1, original handle checked; the record retains TWO empty-input polls and `decisiveWallMs: 85000`, `pollStartedAtElapsedMs: 71287`, `holdDeadlineElapsedMs: 458855` (worker completion), `remainingLifetimeMs: 387568` (basis `hold-deadline-at-poll-start`); sentinel in linked output, exit 0. **The cap-limited shape held:** the first poll returned to the model while the 420000-ms worker was still running (no requested-yield expiry — the requested yield was 3600000 ms; no other ender: `interrupt.requested: false`, cleanup label `observation`), and the model re-polled to the normal sentinel completion afterwards. **Adjudication correction:** `decisiveWallMs` is `sequence.lastCompletedOnHandle` — the TERMINAL observation (exit 0 + sentinel) — not the earlier nonterminal cap return; the record retains call arguments only (no per-poll output headers), so the cap return's duration is unrecoverable from the retained data. M is bounded by [>0, return-before-worker-end] — the return demonstrably preceded the worker's end — and needs RE-MEASUREMENT with the per-poll-timing observer (§12.8) before any numeric use |
| Case B fresh — `rescue-long --cap-ms 3600000`, worker 420000 ms | [record](/tmp/shell-wait-r5-rescue-long.Vx9i4a/rescue-long.record.json) | **QUALIFIED.** Named; `decisiveWallMs: 388300`, `outerReturns: 0`, `modelCalls: 2`, `rootJoins: 1`, `capVerified: true`, sentinel in linked output, exit 0 — one 388.3-s observation spanning poll start to worker completion, with no intervening return |
| `rescue-repeat --cap-ms 3600000`, worker 420000 ms | [record](/tmp/shell-wait-r5-rescue-repeat.EXZjWv/rescue-repeat.record.json) | **QUALIFIED.** Named; `decisiveWallMs: 388300`, `outerReturns: 0`, `rootJoins: 7`, sentinel true, exit 0. A **DISTINCT Child** — `01a11857-f6e4-7b43-b63d-4af8a54319c6` vs Case B fresh's `01a11850-998d-7063-b993-484ab338470b`; the equal 388300 wall time is a **return-granularity coincidence** (both spans are poll-start→worker-completion of ≈388.2 s, rounded to the same 388.3-s tool-reported header value) |
| `rescue-baseline --cap-ms 3600000 --poll-ms 60000` | [record](/tmp/shell-wait-r5-rescue-baseline.DDgO8y/rescue-baseline.record.json) | Inconclusive `unsupported-call-shape`: an unclassified 4-line cell (478 bytes) — the observer could not classify it, and the retained evidence does not establish whether this was a further instrument parser gap or a departure from the prompted flow; R0 structural suppression held (excerpt carries no private content). Route, linkage and cadence facts remain `null`. Recorded exactly as found |
| `rescue-noise` (raised, worker 130000 ms) | [record](/tmp/shell-wait-r5-noise2.xFe3Mu/rescue-noise.record.json) | Inconclusive `unsupported-call-shape` again — a **different shape than the R1-fixed preparation grammar**: another unclassified 4-line cell (300 bytes) — cause not established from the retained evidence (the R1-fixed preparation grammar was a CONFIRMED parser gap; this different shape is not yet adjudicated); R0 suppression held. The FIRST noise attempt (`/tmp/shell-wait-r5-rescue-noise.qocK37`) left an EMPTY output directory — an orchestrator invocation artifact (a mis-issued invocation whose grep filter hid a driver-level failure) that ran NO trial; the noise2 record is the corrected trial |
| `background` (R3-corrected prompt/lifecycle, worker 120000 ms, budget 600000 ms) | [record](/tmp/shell-wait-r5-bg2.LmTfLv/background.record.json) | Inconclusive `unsupported-call-shape`; budget-cleanup at `endedAtElapsedMs: 600021` (`codexTerminated: true`); `rootAcknowledgementAtElapsedMs: 41333` recorded but no Child linkage — the run ended before the background flow with an unclassified cell where the prompted invocation was expected; whether this was a further parser gap or a departure from the prompted flow is not established. First attempt directory empty (invocation artifact) |
| `rescue-interrupt` (R4-wired, worker 420000 ms, budget 900000 ms) | [record](/tmp/shell-wait-r5-int2.kAZOHe/rescue-interrupt.record.json) | Inconclusive `unsupported-call-shape`; interrupt facts: `requested: true`, `previousStatus: "running"`, `family: "v2"`, but `attempted`/`delivered`/`settled` all `null` — `missingPrerequisite`: "the owning-session interrupt delivery could not be observed in this run: the evidence collection did not complete (rollouts unavailable or the held observation failed before evidence collection)". First attempt directory empty (invocation artifact) |
| `review-wait` (raised, hold 130000 ms) | [record](/tmp/shell-wait-r5c-review-wait.2FAUqV/review-wait.record.json) | Executed; Root-side linkage recorded (`mode: "root"`, `rootThreadId: 01a118a6-ecb0-…`, launch 1, send 0); the host ended before the held completion boundary (`endedAtElapsedMs: 14477`, cleanup `early-exit`) — inconclusive per the record (§9.4) |
| `adversarial-review-wait` (raised, hold 130000 ms) | [record](/tmp/shell-wait-r5c-adversarial-review-wait.YVs57X/adversarial-review-wait.record.json) | Executed through the Root observer: `rootThreadId: 01a118a7-7abd-…`, launch 1, send 1, `decisiveWallMs: 98100`; the **narrower renderer check FAILED** — the command-rendered result markers were missing from the linked terminal output (`sentinelPresent: false`, 420-char withheld output) — inconclusive (§9.4). The Root-family observation contract itself adjudicated the flow; the run did not qualify |
| `status-wait` (raised, explicit `--status-query-timeout-ms 120000`) | [record](/tmp/shell-wait-r5-status-wait.IfS62s/status-wait.record.json) | `status: "failed"`: the **fail-closed `statusQuery` validation fired** (`validation.valid: false` — "no launch acknowledgement with a reserved job ID was observed in the live session rollout"; 0 distinct IDs on both extraction sides), so the Status query had no in-session target and the case failed closed instead of guessing (§9.4) |

**Driver defaults bug found and fixed during R5 (instrument defect, not host behavior).** `review-wait`
and `adversarial-review-wait` were initially unrunnable: the shared per-case defaults set
`statusQueryTimeoutMs` (240000) for all three root-family cases while `validateCaseInput` correctly
rejects that option for non-Status cases — every invocation failed the case-input gate before any trial.
Fixed in the working tree (defaults split: only `status-wait` carries the field) with a regression test;
the fix changed `driver.mjs` bytes, so the two `r5c` records carry the post-fix observer digest
`cd41ef07…`, distinct from the pre-fix digest `27bc1715…` in the eight earlier records (§12.9). Two
further invocation attempts passed `--status-query-timeout-ms` to review/adversarial-review and were
correctly rejected fail-closed. Eight empty output directories across the campaign
(`…-rescue-noise.qocK37`, `…-background.nLc77B`, `…-rescue-interrupt.D8zFgb`, `…-review-wait.3JwLl9`,
`…-rw2.hOL3XX`, `…-r5b-review-wait.qck7VJ`, `…-r5b-adversarial-review-wait.vgzS3x`,
`…-adversarial-review-wait.hMllsU` — eight directories total, all trialless) are recorded as orchestrator
invocation artifacts that ran NO trial and carry no measurement.

**Headline adjudications** (M corrected by the post-trials review-loop adjudication; propagation softened
accordingly).

- **M (installed unraised Child cap): bounded-but-imprecise (`installed-observed`) — re-measurement
  needed.** The M trial's cap-limited return is QUALITATIVELY established (it returned to the model
  while the worker still ran, strictly below the requested 3600000-ms yield, no other ender — §6.2's
  rule on every element it can check), but its EXACT DURATION WAS NOT SEPARATELY RETAINED: the
  record's `decisiveWallMs` (85000) is `sequence.lastCompletedOnHandle` — the TERMINAL poll
  (exit 0 + sentinel) — while the earlier nonterminal cap return has no surviving timing of its own,
  and the retained excerpts carry call arguments only (never output headers). M is therefore bounded
  by [>0, return-before-worker-end] and MUST NOT be used as a number. The prior §6.2 design caution
  stands: the reference is the MEASURED default, never the source-pinned 300000 ms (§2.5) — and no
  binary mapping is claimed between them (§10). Every future M trial retains per-poll wall times
  (each poll's own tool-reported header) so the cap return is measured directly (§12.8).
- **Raised-cap propagation: POSITIVE-but-M-imprecise.** The fresh raised Case B ran one 388300-ms
  observation from a single poll with **zero outer re-entries**, sustained by the held worker to its
  natural completion — on the same binary, candidate paragraph, requested yields and worker duration
  as the M trial, differing ONLY in the fixture cap key. That shape is the discriminator's positive
  signal: under any unraised ceiling in the observed class the same poll would have returned
  cap-limited with the worker still running, exactly as the M trial's return did. But the NUMERIC
  comparison (388300 / 85000 ≈ 4.57×) inherited the unattributable M number and is withdrawn; the
  margin is qualitative until M is re-measured with the per-poll-timing observer. The raised fixture
  configuration demonstrably reached the installed Child's process manager through the used argument
  form (the observation window is bounded only by the worker's end, with no intervening return).
- **Repeat: QUALIFIED.** Two independent qualified 388.3-s raised runs on distinct Children (Case B fresh
  and `rescue-repeat`), each with zero outer re-entries and the terminal sentinel, close the repeat
  dimension as designed (comparable intervals; per-token savings remain unmeasured and unclaimed).
- **Validity precondition: NOT recomputable at retained precision.** §6.2 requires the decisive poll to
  start with ≥ M + 30000 ms of worker lifetime remaining. The R5 close had verified `85000 + 30000 =
  115000 ≤ 388169` (Case B fresh's `remainingLifetimeMs` on basis `hold-deadline-at-poll-start`,
  `holdDeadlineElapsedMs 457916 − pollStartedAtElapsedMs 69747`; the repeat's figure is 388188 ms).
  That verification inherited the withdrawn M number: with M bounded-but-imprecise, `firstPollMs +
  30000 ≤ 388169` cannot be evaluated from the retained data — the precondition check is re-run by
  the re-measurement (§12.8). The remaining-lifetime measurements themselves (conservative lower
  bounds that can only understate, §12.5) stand unchanged.

The 388.3-second figures are fresh 0.161.0 measurements; they neither requalify nor replace the
historical 0.160.1 records (§7.1: 386.6 s; §8.1: 387.1 s), which keep their own recorded scope.

## 8. Lifecycle, results, placement, Status sidecar (Task 5)

Executed 2026-10-07 with installed Codex `0.160.1`, same resolved executable
`/Users/zhangzikai/.codex/packages/standalone/releases/0.160.1-aarch64-apple-darwin/bin/codex`.
The actual fixture source pins below come from each retained record's `provenance.sourceSha`.
They select the fixture snapshot; they do **not** identify the executing observer revision. No separate
observer revision/hash is retained in these records, so attribution of execution to amended `074fb07`
is unavailable.

| Task 5 record | Actual fixture source pin | Executing observer revision |
| --- | --- | --- |
| `/tmp/shell-wait-t5-noise.o7vg44/rescue-noise.record.json` | `7edb8adb1781404301f0a29bcc3bd7de6ab45972` | Unknown — not retained |
| `/tmp/shell-wait-t5-background.ty0i87/background.record.json` | `7edb8adb1781404301f0a29bcc3bd7de6ab45972` | Unknown — not retained |
| `/tmp/shell-wait-t5-interrupt.aQ5gyF/rescue-interrupt.record.json` | `81882a86e7202770c21df7be85e9b0ae6c23d560` | Unknown — not retained |
| `/tmp/shell-wait-t5-statuswait.tQsvBt/status-wait.record.json` (preliminary command-rendering failure) | `81882a86e7202770c21df7be85e9b0ae6c23d560` | Unknown — not retained |

The preliminary Status record failed before evidence collection because the Rescue launcher renderer
rejected its command path (§9); it is not a fourth completed live case. Three live cases ran once each;
no case was retried out of the record. Noise is blocked by an instrument grammar limitation (§8.2), and
background retains an early host exit (§8.3); neither establishes model nonadherence.

Compared with both historical fixture pins, amended `074fb07` changed pending-header handling
(full result lists plus a pending header stay unresolved), timing attribution (whole-cell wall time is
cell-scoped rather than a single observation's duration), and launch-gate parsing (bounded multi-statement
cells rather than single calls). Those changes matter when interpreting apparent completion, decisive
observation duration, or failure to reach the held launch boundary. The retained interrupt excerpts show
single-statement calls; the noise excerpt cannot parse; background retains zero collected Child calls.
These summaries do not establish that the amended observer executed or retroactively requalify any record.

### 8.1 `rescue-interrupt`: qualified pending observation, delivery not exercised (`installed-observed` / delivery `not-proven`)

Record: `/tmp/shell-wait-t5-interrupt.aQ5gyF/rescue-interrupt.record.json`. The pending long observation
QUALIFIED end to end: route `named`; `companionLaunchCount: 1`, `companionSendCount: 1`,
`originalHandleChecked: true`; `outerReturns: 0`, `modelCalls: 2`, single decisive observation
`decisiveWallMs: 387100` with `remainingLifetimeMs: 32900`; `processExit: 0`, `hostExit: 0`,
`publicResultMatchedSentinel: true`; cleanup `observation`/complete with 0 errors; `inconclusive: null`.

The interrupt record itself is honest about its boundary: `requested: true`, `delivered: null`,
`missingPrerequisite: "the exact native interrupt delivery interaction is bound by the Task 5 live path;
this run only qualifies the pending observation"`. The driver's interrupt case does not yet deliver a
native exact-Child interrupt during the pending window, so per the plan's own rule this is **not** native
interruption proof: delivery, target, pending interval, delivery-to-settlement latency and collateral
cancellation all remain **`not-proven`** (§3.1's surface and §10's register). No probe-budget kill is
presented as interruption; the cleanup label is `observation`.

### 8.2 `rescue-noise`: inconclusive — INSTRUMENT GRAMMAR LIMITATION (checks `not-proven`)

Record: `/tmp/shell-wait-t5-noise.o7vg44/rescue-noise.record.json` (worker 130000 ms, raised cap,
budget 360000 ms). Manual adjudication of the retained `unsupported-call-shape` excerpt identifies an
**INSTRUMENT GRAMMAR LIMITATION**: the preparation write includes `yield_time_ms:1000`, which
`PREPARATION_PATTERN` excludes. Removing only that argument makes the retained excerpt parse, just as
for Case 0 run4 (§7.3) and repeat2 (§7.4). This is an excerpt-level parser check, not replayed execution.
Execution behavior remains unknown; the excerpt does not establish departure from the prompted flow.
The same-handle/no-replacement-Status/no-relay/exact-stdout checks remain **`not-proven`**, and the
fail-closed verdict stays inconclusive, never zero. The existing conversation/progress output remains
the only sanctioned progress surface; no heartbeat protocol was added.

### 8.3 `background` compatibility: inconclusive — host ended before the boundary (`installed-observed` outcome)

Record: `/tmp/shell-wait-t5-background.ty0i87/background.record.json`. Route selected `named`, but
`companionLaunchCount: 0`, `modelCalls: 0`, and the host exited before the held completion boundary
(`inconclusive: "the host ended before the held completion boundary; the pending-observation claim is
inconclusive"`). The retained zero-launch/early-exit facts do not establish the explicit `--background` execution
flow or its cause, so new installed evidence for the background placement branch is not established.
The placement matrix's inherited contract coverage
(small no-flag, complex detached, Review/Adversarial enqueue-only, same-child choices, owner-only queries)
remains with the current functional tests and is not claimed as new installed evidence.

### 8.4 Status sidecar: structural coverage only (`fixture-tested`/inherited; latency `not-proven`)

The exact no-argument Child Status intents and the between-polls, at-most-once, observation-only sidecar
policy remain covered structurally by the existing production suites recorded below. The native interface
did not permit a safe live steering observation in this campaign, so sidecar response delay under a long
wait stays a recorded usability limitation, not a measured value.

### 8.5 Focused production regressions (recorded at `074fb07`)

Exact file presence checked first (`rg --files tests`); no seam was renamed, so the plan's file list ran
verbatim, with `rescue-binding-repair.test.mjs` present as an additional existing neighbor (not required by
the plan, not run here):

```text
node --test tests/rescue-preparation.test.mjs tests/rescue-binding.test.mjs tests/rescue-route-planner.test.mjs
  → 417 tests, 417 pass, 0 fail, 0 skipped
node --test tests/rescue-lifecycle.test.mjs tests/rescue-child-reconciliation.test.mjs tests/rescue-progress-relay.test.mjs
  → 126 tests, 126 pass, 0 fail, 0 skipped
node --test tests/job-control.test.mjs tests/mcp-result.test.mjs
  → 213 tests, 213 pass, 0 fail, 0 skipped
```

### 8.6 Task 5 coverage

S5's pending-observation side gained a second qualified long observation with identical linkage facts
(independent of Case B), while actual native interrupt delivery, stop/reconciliation-live checks, noise
observations and installed background placement remain **`not-proven`** with the exact causes above and in
§10. Budget/failure cleanup is still never labelled native interruption (`nativeInterruptionClaimed` stays
a literal `false` in every record).

## 9. Root waiting commands (Task 6)

Executed 2026-10-07 at source `9a4c736` (includes the probe-local `renderCompanionCommand` fix, with its
regression, for the root-family cases: the Rescue launcher renderer's `/skills/rescue/launcher.mjs` leaf
check had rejected every companion script path, so `status-wait` could not even start before it). Each of
the three commands ran once with a 130000-ms hold, raised cap, budget 360000 ms; no case was retried.

### 9.1 Outcomes (assistant-reported errors; renderer and long-wait qualification `not-proven`)

| Command | Record | Observed outcome | Long-wait qualification |
| --- | --- | --- | --- |
| `review-wait` | `/tmp/shell-wait-t6-review-wait.JYhGH8/review-wait.record.json` | **ASSISTANT-REPORTED** Review error `{"error":{"code":"ARGUMENT_INVALID","category":"validation","message":"Review does not accept focus text.",…}}` (retained final-agent-message diagnostic only). Invocation, original handle, linked terminal output and process exit are unknown; host exited before the held boundary. `sendCount: 0` | **`not-proven`** — renderer/error-path execution and the 130-second hold are unverified |
| `adversarial-review-wait` | `/tmp/shell-wait-t6-adversarial-review-wait.iMiSBx/adversarial-review-wait.record.json` | One `session/send` reached the fake peer, but no child linkage, launcher, terminal exit or sentinel applied; the case ended inconclusive | **`not-proven`** |
| `status-wait` | `/tmp/shell-wait-t6-status-wait.DIXml7/status-wait.record.json` | **ASSISTANT-REPORTED** Status error `{"error":{"code":"ARGUMENT_INVALID","category":"validation","message":"Expected one 64-character job ID.",…}}` (retained final-agent-message diagnostic only). Invocation, original handle, linked terminal output and process exit are unknown; host exited before the boundary. `sendCount: 0` | **`not-proven`** — renderer/error-path execution, hold and cancellation subcase (native interruption is separately `not-proven`, §10) |

The two `ARGUMENT_INVALID` diagnostics are **ASSISTANT-REPORTED errors**, retained only as
final-agent-message excerpts. The driver extraction contract forbids inferring execution from assistant
text: neither diagnostic proves a Companion invocation, original handle, linked terminal public output,
process exit, or the exact renderer contract. Renderer/error-path verification remains **`not-proven`**
unless linked command/output evidence is retained; the requested 130-second observation also remains
**`not-proven`**. Zero recorded sends does not supply the missing execution evidence.

### 9.2 Instrument gap discovered by Task 6 (`not-proven` prerequisite for a root-family campaign)

The driver's completion contract is **Rescue-shaped**: it qualifies exact Child linkage, the Rescue
launcher invocation, and the original Child handle. Root-family cases intentionally have no Rescue Child,
so `adversarial-review-wait`'s record reads "child linkage is not exact; the exact launcher command was
observed in no identified child rollout" even when the Root-side flow ran — the verdict frame, not the
host, rejected the case. A root-family campaign needs its own bounded observation contract (Root's own
process handle, the constant Companion command, the command-specific renderer result, decision cadence,
and — for `status-wait` — observation cancellation that leaves the job running) before any Root command can
be qualified. That scope statement was **wrong and is corrected per the plan amendment (2026-10-07)**:
Root observer work was **in scope under Task 6/spec Q5 all along** — it was an unimplemented instrument
capability being presented as a campaign boundary, exactly the confusion the review flagged. R2
implemented the reviewed root-family observation contract (§12.6) and the R5 root runs exercised it live
(§9.4); the contract is no longer a missing prerequisite.

### 9.3 Model adherence

The Review and Status assistant diagnostics suggest argument errors (focus text, missing job ID), but
without linked command/output evidence they do not establish executed arguments or model nonadherence.
Early host exit and the root-family contract gap remain recorded limitations. Task 5's noise grammar
limitation is separate (§8.2). Each command keeps its own outcome; no command is declared impossible
or qualified from another's run.

### 9.4 R5 root-family outcomes (2026-10-08, installed 0.161.0): real recorded outcomes; all three commands still `not-proven`

The R2 root-family observation contract (§12.6) adjudicated all three R5 runs — the §9.1 outcomes above
remain the historical 0.160.1 attempts. Each command ran once (records and provenance in §7.7); the two
pre-`r5c` invocation attempts (the `--status-query-timeout-ms` mis-issue, correctly rejected fail-closed,
and the driver defaults bug, §7.7/§12.9) ran no trial.

- **`review-wait`**: the flow started — Root-side linkage recorded (`mode: "root"`,
  `rootThreadId: 01a118a6-ecb0-77a2-afd2-87fcf435ce96`), the exact companion invocation observed
  (launch 1, send 0) — and then **the host ended before the held completion boundary**
  (`endedAtElapsedMs: 14477`, cleanup `early-exit`; the record's inconclusive reason is the generic
  early-exit one). Long-wait qualification: **`not-proven`**.
- **`adversarial-review-wait`**: the flow RAN through the Root observer — `rootThreadId: 01a118a7-7abd-…`,
  launch 1, send 1, one 98.1-s decisive observation (`decisiveWallMs: 98100`) — but **the narrower
  renderer check failed**: the command-rendered result markers were missing from the linked terminal
  output (`sentinelPresent: false`, withheld 420-char output). The Root-family contract WORKED — the
  record adjudicates handle, cadence and exit facts that §9.2's Rescue-shaped frame could never express —
  and the run still did not qualify. Long-wait qualification: **`not-proven`**.
- **`status-wait`**: `status: "failed"` — **the fail-closed `statusQuery` validation fired**
  (`validation.valid: false`: "the live session produced no unambiguous reserved-job acknowledgement";
  0 distinct IDs on both the acknowledgement and query extraction sides, timeout 120000 recorded). The
  Status query had no in-session target, and the case failed closed instead of guessing — exactly the
  R3-designed behavior. Long-wait qualification and the cancellation subcase: **`not-proven`**.

Each command keeps its own outcome; none is declared impossible or qualified from another's run. The
useful next step for each is recorded in §10 and §11.2.

## 10. Not-proven register (updated through Tasks 4–6 and R5)

| Unresolved claim | Evidence and reason | Useful next step / owner |
| --- | --- | --- |
| Source/binary mapping | **`not-proven`**: Codex source `67727e7c` is not mapped to the installed binary (0.160.1 at Tasks 4–5; re-pinned **0.161.0** by R4's non-authenticated probe, 2026-10-08, §3.3 — **0.161.0 was the R5 live-run version**, §1.2.2); 0.160.0 was the historical Task 1/Root version; the 2026-10-13 follow-up Task 1 re-pin found the installed CLI auto-updated again to **0.162.1** before any follow-up live run (§1.2.3). The R5-observed unraised Child return differs from the pinned source default (300000 ms, §2.5) — recorded as facts on different surfaces, never a mapping claim | Keep source facts separate; qualify any later installed version independently (Task 7) |
| Installed unraised Child cap M | **BOUNDED-BUT-IMPRECISE (2026-10-08 observed; adjudication corrected by the post-trials review loop, `installed-observed`, 0.161.0)**: the qualified unraised trial's cap-limited return is established QUALITATIVELY (returned to the model with the 420000-ms worker still running, strictly below the requested 3600000-ms yield, no other ender), but its exact duration was NOT separately retained — the record's `decisiveWallMs` (85000) is the TERMINAL observation, the earlier nonterminal return has no surviving timing, and the retained excerpts carry call arguments only (§7.7). M is bounded by [>0, return-before-worker-end]; it is not a usable number. The four Task 4 0.160.1 records (§7.3) remain historical attempts. **2026-10-13 re-measurement attempt on 0.162.1 (§13.4): the unraised control ended inconclusive (`unsupported-call-shape`, unclassified `exec_command` cell, cause not established) — M is `not-proven` on that pin (not even bounded); the 0.161.0 bounded-but-imprecise state stands for its own pin** | Re-measure M with the per-poll-timing observer (§12.8) before any numeric use; re-measure on any future installed version before reuse; on 0.162.1 the unclassified-cell adjudication (§13.4) is the blocking prerequisite |
| Raised fixture cap propagation onto the Child | **POSITIVE-but-M-imprecise (2026-10-08, `installed-observed`; adjudication corrected by the post-trials review loop)**: fresh raised Case B ran one 388300-ms observation with zero outer re-entries, worker held to natural completion; same binary/paragraph/yields/worker as the M trial, differing ONLY in the fixture cap key — the positive discriminator shape. The NUMERIC comparison (≈4.57× M) and the M + 30000 ≤ 388169 precondition verification inherited the withdrawn M number and are withdrawn; the remaining-lifetime measurements (388169/388188 ms, conservative lower bounds) stand (§7.7). **2026-10-13 raised run on 0.162.1 (§13.4): also inconclusive (`unsupported-call-shape`, same family; `capVerified: true` is fixture-configuration retention only) — the M + 30000 precondition is UNEVALUABLE and propagation is `not-proven` on that pin; no positive shape is attributable there, so 0.162.1 does not even reach POSITIVE-but-M-imprecise** | Re-run the precondition against a re-measured M (§12.8) before the human adoption decision (§11.2); never promote a Role cap field (§2 whitelist); on 0.162.1 the unclassified-cell adjudication blocks the measurement itself (§13.4) |
| Case A qualified completion | **`not-proven`**: Task 4's consecutive `wait cell_id` linkage unresolved in the observer; original-handle check false/pending tail true. Cadence 15 returns and exit/sentinel facts remain `installed-observed`. The R5 raised re-run of the baseline control also ended inconclusive (`unsupported-call-shape`, cause not established, recorded exactly as found, §7.7). **The 2026-10-13 baseline re-run on 0.162.1 (§13.4) ended inconclusive on the same family — no outer-return count is attributable on that pin; the re-entry comparison stays unknown there, never zero** | Narrow observer work on the actual continuation sequence, with linkage negatives preserved; no host rejection inferred; on 0.162.1 the unclassified-cell adjudication blocks it (§13.4) |
| Repeat qualification | **QUALIFIED (2026-10-08, `installed-observed`)**: fresh raised `rescue-repeat` — 388300 ms, 0 outer returns, sentinel true, exit 0, on a DISTINCT Child (`01a11857-f6e4-…` vs Case B fresh's `01a11850-998d-…`); the equal wall time is a return-granularity coincidence (§7.7). The Task 4 attempts (§7.4) remain historical. **2026-10-13 repeat attempt on 0.162.1 (§13.4): no qualified raised run exists on that pin to repeat; the executed `rescue-repeat` run itself ended inconclusive (`unsupported-call-shape`, same family). QUALIFIED stands on 0.161.0 only** | Repeat is closed on 0.161.0; a future version repeats the measurement independently; on 0.162.1 the unclassified-cell adjudication blocks it (§13.4) |
| Generic route and broader instruction support | **`not-proven`** installed; only named was observed (Task 4 and all qualified R5 runs). Artifact synchronization/structural parity is `fixture-tested`; the candidate's named invocation is `installed-observed`; no R5 trial forced a generic fallback. **2026-10-14 Task 6 on 0.162.1 (§13.8): the plan's unavailable branch CLOSED with a structural cause — the host genuinely SUPPORTS the generic spawn shape (pinned-source `67727e7c`: `agent_type` an optional parser-known field; no-`agent_type` calls resolve the built-in `default` role and yield an `agentRole: null` child = the planner's `'generic'` class), but it is NOT genuinely reachable under ordinary capability conditions: the managed-Role registration that makes the preflight `ready` IS an `agent_roles` entry, so every route-decision-capable state exposes `agent_type` in the V2 schema and mandates named, while the exposing-free state fails closed before any preparation exists; no fixture seam, no live run, no code change** | Keep conclusion named-scoped; no generic fallback after Role-value rejection, no universal wrapper claim (Tasks 5/7); a generic observation would require a genuinely changed host/form (e.g. an installed binary whose schema omits `agent_type` while the Role preflight passes — impossible at the pinned source by construction), recorded per the §13.8 decision |
| Exact native interrupt/tool-family availability and pending-inner cancellation | **Family and delivery path ESTABLISHED by R4** (§3.3, §12.8): family = V2, enabled on the live machine by the `features.multi_agent_v2` block present in the live config (`enabled = true`; the block's AUTHORSHIP is not established — the plugin's own setup writes only `features.hooks`, `hooks.state`, the metadata leaf and `[agents.zcode-rescue]`; the `features list` true/false probe is reproduced either way) (installed binary re-pinned 0.161.0); `interrupt_agent` is registered in the owning normal-exec Root turn (source pin 67727e7c) and targets the exact known non-root non-self child via the shared in-process registry; the case prompt is wired and the record carries measured delivery/settlement facts or an explicit investigated reason (14 new R4 instrument tests). **Live delivery remains `not-proven` after R5**: both wired-path runs ended inconclusive before delivery on an unclassified cell (cause not established — attributed neither to model nonadherence nor to host rejection) — the retained R5 record shows the intent was requested (`requested: true`, `previousStatus: "running"`, `family: "v2"`) with `attempted`/`delivered`/`settled` null and the explicit missing-prerequisite reason (evidence collection did not complete; `unsupported-call-shape` unclassified cell, §7.7). Turn interrupt alone is insufficient (`code_mode_interrupt` installed-observed false). **Post-R5 instrument correction:** the R5 failure cause — a Root-side `interrupt_agent` wrapper cell failing the whole-case scan (`unsupported-call-shape`, §12.8) — is fixed by the narrow root-control-call path, so a retry adjudicates the Child evidence instead of failing the scan. **2026-10-13 Task 3 run on 0.162.1 (§13.5): that one retry executed and again ended inconclusive — but the model DID emit exactly ONE V2 `interrupt_agent` interaction whose tool response success-decoded to the ACTIVE `previous_status: "running"`, the first run with a parsed AND counted V2 interrupt interaction (`callCount: 1`, target-shape facts retained) under the §12.8-corrected anchored grammar, and the first on this pin (the R5 record had already retained a parsed interaction with the same active `previous_status` and `family: "v2"`, §7.7, but under the since-corrected unanchored grammar — §7.7's retained R5 row lists no count or target facts, and its case failed the whole-case scan); the call's target was suppressed (23 chars, neither id-shaped nor the fixture marker) and the ordering never bound (the case evidence failed fail-closed on the same unclassified `exec_command`-cell family, new 3-line/314-B shape), so exact-target delivery, pending-window ordering, settlement and every production layer stay `not-proven` on this pin** | On 0.162.1 the one run and its cause-directed follow-up decision are consumed/recorded (§13.5); the remaining step on this pin is the narrow unclassified-cell adjudication (§13.4's blocking prerequisite, reserved to Task 4's allowance) before any further interrupt measurement; the 0.160.1/0.161.0 records keep their own scope |
| Installed `multi_agent_v2` configuration/bounds | **Partially established by R4** (`installed-observed`, non-authenticated file/CLI probes, §3.3): the live config sets `features.multi_agent_v2.enabled = true` with `default_wait_timeout_ms = 600000` and `min_wait_timeout_ms = 600000` (max unset → source default 3 600 000 ms); `wait_agent_enabled`/`disable_direct_message` are unset → source defaults true/false at the pin. A live `wait_agent` timeout-bound measurement on the installed binary was still unmeasured at R5 (the qualified R5 runs recorded Root joins but no timeout-bound probe) | Record actual wait/timeout bounds only if a later campaign needs them; source defaults stay separate |
| Noise, progress relay, Status sidecar latency, background placement, stop/loss/ceiling | **`not-proven`** as new installed evidence: Task 5 ran each live case once — `rescue-noise` has an instrument grammar limitation (manually adjudicated excerpt; execution behavior unknown, §8.2), `background` ended with the host exiting before the boundary and zero launches (§8.3), the Status sidecar stayed structural (§8.4), and stop/reconciliation live checks were not exercised. **R5 re-runs with the corrected instrument also ended inconclusive on unclassified cells** (§7.7; cause not established): `rescue-noise` hit `unsupported-call-shape` again (a DIFFERENT unclassified-cell shape than the R1-fixed preparation grammar; R0 suppression held), and `background` (R3-corrected prompt/lifecycle) ended before the background flow with an unclassified cell (`unsupported-call-shape`, budget-cleanup at 600021 ms, Root acknowledgement recorded at 41333 ms, no Child linkage). Neither run establishes model nonadherence. **2026-10-13 Task 4 on 0.162.1 (§13.6): both cases ran exactly once each behind the plan's new bounded structural diagnostic — both again inconclusive `unsupported-call-shape`, but the family is now SHAPE-ADJUDICATED** (noise: a single-content-line `write_stdin`-headed script statement, 387 B, failing both pinned grammars — a variant outside them, defect and nonadherence both non-demonstrable, fingerprint `38c33f61…`; background: a 4-statement cell whose leading statements reference no observational tool, 583 B, fingerprint `a9d65bb2…`, Root host result at 46384 ms with the Child-settlement watch running the full budget to a 600010-ms budget-cleanup termination, never labelled interruption). Noise checks, noise and background placement stay `not-proven` on this pin; the sidecar structural policy re-verified 162/162 + 76/76 while installed sidecar latency stays `not-proven` (no qualified pending observation existed to steer) | The R1 grammar fix removed the OLD blocker; the remaining unclassified-cell family is adjudicated to the retention design's limit (§13.6): further measurement needs content-level evidence (a privacy-authority decision outside the plan's authority) or a host/form change — no parser expansion. Budget/failure cleanup is never native user interruption |
| Review/Adversarial Review/Status waiting commands | **`not-proven`**: Task 6 ran each once (§9.1) — two retain only ASSISTANT-REPORTED `ARGUMENT_INVALID` diagnostics. **R5 produced the first real Root-side outcomes** (§9.4, 0.161.0): the R2 root-family contract adjudicated all three — `review-wait` host ended before the held boundary after the observed companion invocation; `adversarial-review-wait` ran end-to-end through the Root observer (launch/send/98.1-s observation recorded) but the command-rendered result markers were missing from the linked terminal output; `status-wait` failed closed exactly as designed (`statusQuery.validation.valid: false` — no unambiguous reserved-job acknowledgement in the live rollout). **2026-10-13 Task 5 on 0.162.1 (§13.7), one run each behind the corrected production-contract marker: `adversarial-review-wait` QUALIFIED (`inconclusive: null` — exact Root linkage, launch 1/send 1, one 97800-ms poll on the original handle, `processExit` 0, the rendered findings-document marker matched, natural completion, no termination; the R5 miss was a demonstrated probe-side instrument/dependency mismatch — the review pipeline renders only the schema-validated findings document, never the sentinel — corrected RED→GREEN in the probe spec only); `status-wait` QUALIFIED (`inconclusive: null` — `validateStatusWaitFlow` `valid: true` on the in-session owned acknowledgement → exact-id query in the SAME session, the production 120000-ms query deadline fired un-extended (exit 1, JOB_WAIT_TIMEOUT framing matched, one 87500-ms poll against a 3600000-ms window request), natural completion through the hold gate, no termination; live Status-observation cancellation stays `not-proven` — no supported native interaction owns a Root session's own running observation, source-pinned root/self rejection at `67727e7c`); `review-wait` `not-proven` with the R5 early-exit shape CONFIRMED and traced (launch 1/send 0, no poll, host exit 0 at 15214 ms, cause: the command reached its own terminal without ever sending the review turn, so the gate-held observation never existed; why no-send is not adjudicable from retained facts)** | Per-command state on 0.162.1: adversarial-review-wait and status-wait carry single-run qualified long-wait observations (no repeat claimed — the plan requested none for Root commands); review-wait needs its command-side no-send cause established (production-scope investigation, outside the probe); review-wait's follow-up was NOT consumed. Status-observation cancellation would need a supported native interaction that does not exist at the source pin |
| Production release/version generalization/token savings | **`not-proven`**: disposable sandbox/hook bypass and no token measurements throughout. Qualified claims span two installed versions measured at execution time — 0.160.1 (Task 4) and 0.161.0 (R5, §1.2.2); auto-update limits attribution in both directions and no release generalization is claimed | Obtain a separate human adoption decision (§11.2); no production rollout implied |

The earlier absence of managed-Child wrapper observations is resolved **only within §7's scope**:
Case B's single long observation and Case A's outer continuation cadence are `installed-observed`.
The fail-closed M discriminator and every independent release dimension above remain intact.

2026-10-14 Task 7 close-out: no row above changed state in the close-out itself — Task 7 launched no
host. The register stands with §13.9's executed-case ledger as its run ledger. §13.9 additionally
records the close-out's environmental npm adjudication, with the occurrences enumerated exactly as
§13.9 enumerates them — the shell-research real-builder fixture pair failed in the SHELL-RESEARCH suite
runs (§13.8's full-suite gate, then this close-out's run), the three routine-suite npm-install tests
failed inside the FIRST clean-source `npm test` run, and the single-variable `package-install`
experiment separately isolates the host package-transport environment — all inside npm's own install
machinery, all adjudicated ENVIRONMENTAL with controlled reproduction evidence (failures-with-cause,
never silently green) — together with the pending-backfill codex review state (§11.3).

2026-10-15 close-out amendment (documentation-only; no host launch, no code change; no row above
changed): the register's current-state reading is corrected in one respect. The §13.6-derived
next-step wording in the noise row above ("further measurement needs content-level evidence … or a
host/form change — no parser expansion") is ACCURATE for the two cells §13.6 actually scanned, but it
must NOT be read family-wide: the five §13.4/§13.5 rescue-family cells ran BEFORE the diagnostic gate
existed (observer provenance `e28ec619…` in all five records vs `b237a6e1…` in §13.6; the gate code
landed in commit `1fb30bd`), so their `wholeBodyStatementMatch` is UNMEASURED, and "only relax privacy
or wait for a host change" is over-strong as a conclusion about those five (§13.10 — corrected scope,
exact `wholeBodyStatementMatch` semantics, irretraceable boundaries, and the Path A next-phase
candidate). The measured values, run ledger and original verdicts in every row above stand
byte-unchanged. The current recommendation, restated: production scope remains ZERO changes
(canonical/config unchanged); §13.11's 2026-10-15 read-only source re-investigation at new source pin
`dffa0deb…` (three distinct wait layers, effective-Config inheritance to the actual Child, the
2026-08-07-introduced outer default, and the 2026-10-07 `code_mode_interrupt` Stable/default-true
flip — source-only, presence evidence only on the installed 0.162.1, no source/binary mapping) is
recorded as a next-phase input, and §13.10's Path A gated diagnostic run is a NEXT-PHASE CANDIDATE
only (not implemented, not run, no allowance reset).

2026-10-16 config-path-a close-out pointer (documentation-only close-out; the campaign's one host
launch is §14's recorded A0; no code change): the register above is UNCHANGED by the config-path-a
campaign — §14 records its execution log and §14.1 its close-out (run ledger A0 SPENT / A1 unspent,
not justified / C0–C1 unspent, blocked — 1 of 4 live runs; recognition NOT restored and config-default
efficacy NOT demonstrated, kept as separate conclusions; production scope still ZERO changes). No row
above changed state in the close-out.

## 11. Coverage mapping, proposed next delta, and execution handoff (Task 7)

### 11.1 Spec coverage mapping

| Spec item | Task and evidence |
| --- | --- |
| S1 preparation/binding authority | 1 (§4 four-stage chain, repository-text facts); 3 (§12.1 fixture uses production preparation/launcher/binding); 4 (§7.1 Case B: launch 1 / send 1 / original handle checked, `installed-observed`); production mismatch/one-shot tests re-recorded §8.5 |
| S2 original-handle/outer-cell ownership | 3 (§12.4 fail-closed observer: empty-chars discipline, single launch, exact-cell linkage, event-order overlap, pending headers); 4 (§7.1/§7.2: Case B 0 overlaps + Case A 15 re-entries, `installed-observed`) |
| S3 exact public/terminal/control outcomes | 4 (§7.1: byte-exact sentinel present in linked terminal output, `processExit: 0`); production result/choice/error suites re-recorded §8.5 |
| S4 placement/background/Status observation-only | 5 (§8.3 background case inconclusive — early host exit, cause unknown; §8.4 sidecar structural-only); inherited placement matrix suites §8.5; R5 re-ran the R3-corrected background prompt/lifecycle — ended inconclusive before the flow (unclassified cell, cause not established), `not-proven` (§7.7) |
| S5 interruption/loss/timeouts/ceiling | 5 (§8.1: pending observation qualified; native interrupt delivery NOT exercised); R4 wired the established V2 delivery path (§12.8); R5's wired runs ended inconclusive before delivery (unclassified cell, cause not established) — live delivery/settlement `not-proven` (§7.7); budget cleanup never labelled interruption; 100-hour ceiling untouched (production semantics unchanged) |
| S6 named/generic parity and no fallback weakening | 1 (§3/§4 route authority); 4 (§7.1: route actually selected = `named`; generic `not-proven`, no fallback forced); 6 (§13.8: generic route host-supported but NOT reachable under the ordinary capability conditions — pinned-source + installed preflight evidence recorded; no seam, no run, nothing forced) |
| S7 isolation/no production changes | 2 (§ selection isolation), 3 (§12 fixture-owned clone/homes/cleanup), 7 (§1 provenance; final diff = docs + probe files only; production Skills/Role/Companion/config/packaging untouched) |
| Q1/Q2 effective Child configuration/instructions | 1 (§2 config layers); 4 (§7.3 historical attempts; §7.1 candidate instructions delivered and followed on the named route); **R5 (§7.7, corrected by the post-trials review loop): cap-limited return OBSERVED (M bounded-but-imprecise — exact duration not separately retained) and raised-cap propagation POSITIVE-but-M-imprecise (388300 ms, zero re-entries; numeric ratio and precondition withdrawn with the M number), `installed-observed` on 0.161.0** |
| Q3 cadence and repeat | 4 (§7.2 A 15 returns vs §7.1 B 0, `installed-observed`); **R5 (§7.7): repeat QUALIFIED — two independent qualified 388.3-s raised runs on distinct Children**; Task 4's repeat attempts (§7.4) remain historical |
| Q4 noise/native interruption/sidecar latency | 5 (§8.1–§8.4: all `not-proven` except the qualified interrupt-case pending observation); R5: noise and background re-runs inconclusive on unclassified cells (`unsupported-call-shape`), interrupt delivery unobserved (unclassified cell; intent recorded) — all still `not-proven` (§7.7) |
| Q5 other waiting commands | 6 (§9.1 historical); R5 (§9.4): the R2 root-family contract adjudicated all three — review-wait host-early-exit, adversarial-review-wait flow ran but renderer markers missing, status-wait fail-closed validation fired; all three still `not-proven`, each with its own recorded outcome |
| Q6 version scope and smallest adoption delta | 7 (§11.2 below); version scope now 0.160.1 (Tasks 4–6) and 0.161.0 (R5, §1.2.2), auto-update caveat in both directions |

No missing evidence is silently marked passed: every row above names its label, and §10 carries the full
`not-proven` register with causes and next steps.

2026-10-14 Task 7 close-out addendum: the follow-up campaign's final per-item labels are recorded in
§13.9's close-out mapping table — adversarial-review-wait and status-wait QUALIFIED
(`installed-observed`, 0.162.1, single runs, no repeat claimed; status's timeout non-extension
confirmed with observation cancellation separately `not-proven`); review-wait, noise/background
placement, native interruption/settlement, M/propagation/repeat/re-entry on the current pin and
installed generic behavior all `not-proven` with precise recorded causes; every S1–S7 inherited
production invariant re-verified by the close-out regression matrix. The rows above stand unchanged as
historical scope.

### 11.2 Proposed next delta (updated through the 2026-10-13/14 follow-up; no production rollout recommended yet)

The spec's positive managed-Rescue recommendation requires the actual Child route, a discriminating long
observation against measured M, repeat, reduced re-entry, exact handle/terminal linkage, and observed
native interruption/settlement. After R5 (with the post-trials review loop's M correction) the measurement
side is CLOSED POSITIVE only in shape (`installed-observed`, 0.161.0, §7.7): route `named` (met since
Task 4), **cap-limited return observed with M bounded-but-imprecise (the retained `decisiveWallMs` is
the terminal observation; re-measurement needed)**, **propagation POSITIVE-but-M-imprecise (388300 ms,
zero re-entries; the numeric 4.57× comparison and the M + 30000 precondition are withdrawn with the M
number)**, **repeat QUALIFIED (two independent qualified runs on distinct Children)**, reduced re-entry
(15 → 0, Task 4) and exact handle/terminal linkage (met). The remaining OPEN items are behavioral, and
the smallest useful next delta is still a **scoped follow-up campaign**, not a production change:

0. M re-measurement (NEW, first): one unraised trial with the per-poll-timing observer (§12.8) so the
   cap return's own duration is retained; it re-adjudicates M, the propagation ratio, and the
   §6.2 validity precondition (`firstPollMs + 30000 ≤ remainingLifetimeMs`) from the same run's facts.

1. Native interrupt live delivery-to-settlement: the R4-wired owning-session path (§12.8) has yet to be
   exercised by a completed on-script run — both R5 runs ended inconclusive on unclassified cells
   before delivery (§7.7). One cause-directed retry with a pending observation that survives long
   enough for evidence collection.
2. Noise and background placement: both R5 re-runs ended inconclusive on unclassified cells
   (`unsupported-call-shape`); each needs its own bounded adjudication of that cell shape before the
   measurements can complete. **2026-10-13 Task 4 update: that bounded adjudication was built and
   executed (§13.6) — a gated structural whitelist in the observer plus the two case runs on 0.162.1.
   The family is adjudicated to the retention design's limit (script cells outside the two pinned
   grammars, per-run structural fingerprints retained; defect and nonadherence both
   non-demonstrable), and both measurements remain `not-proven` on this pin. The next step is no
   longer an instrument task: it needs content-level evidence via a privacy-authority decision
   outside the plan's authority, or a host/form change.**
3. Root command qualification: the instrument is no longer the blocker (R2 contract implemented §12.6;
   exercised §9.4). Per-command causes: review-wait's host must survive its held boundary;
   adversarial-review-wait's flow completed but its renderer-marker contract needs re-examination
   against the actual rendered bytes; status-wait needs a live run whose turn-1 launch acknowledgement is
   actually emitted and observable. **2026-10-13 Task 5 update (§13.7): executed on 0.162.1 —
   adversarial-review-wait QUALIFIED (the marker contract WAS the re-examination: a demonstrated
   probe-side instrument/dependency mismatch, corrected in the probe spec only) and status-wait
   QUALIFIED (the acknowledgement was emitted, observed and owned-queried in-session, with the query
   deadline verified un-extended); review-wait's early exit is now CONFIRMED and traced with the
   command-side no-send cause recorded, remaining `not-proven` on a production-scope question; live
   Status-observation cancellation stays `not-proven` (no supported native interaction exists for a
   Root session's own observation).**
4. Generic route parity: never observed or forced; the candidate paragraph reaches the generic
   assignment only as `fixture-tested` structural parity. **2026-10-14 Task 6 update (§13.8): the
   follow-up plan's discovery question is CLOSED on this pin — generic is host-supported but not
   genuinely reachable under ordinary capability conditions (the Role preflight's own registration
   populates the `agent_roles` map that forces the V2 schema to expose `agent_type`, mandating named;
   the omitting state fails closed before any preparation), so the unavailable branch was executed
   with source + installed evidence and NO seam/run; any future generic observation requires a
   genuinely changed host/form, not a forced call.**

2026-10-13 Task 2 update: delta item 0 (M re-measurement) was executed on the re-pinned 0.162.1 host
together with the raised candidate, repeat and baseline runs (§13.4) — all four ended inconclusive on
the recurring `unsupported-call-shape` family (unclassified `exec_command` cells, cause not established,
instruction-variant-independent, 4/4 runs). On this pin M is `not-proven` (not even bounded), the
M + 30000 precondition is unevaluable, propagation/repeat/re-entry comparisons are `not-proven`, and no
positive raised shape is attributable. The campaign's measured dimensions on a current pin are now
blocked by that single prerequisite: the narrow unclassified-cell adjudication (bounded diagnostic with
only whitelisted structural facts) that the follow-up plan reserves to Task 4's allowance must extend to
the rescue-family cases it now blocks before any of items 0–4 can complete on this host. The 0.160.1/0.161.0
records (including the 0.161.0 POSITIVE-but-M-imprecise propagation clue and QUALIFIED repeat) keep their
own recorded scope; no cross-version claim is made in either direction.

2026-10-13 Task 3 update: delta item 1 (native interrupt live delivery-to-settlement) was executed once
on the SAME 0.162.1 pin (§13.5) — the first run with a parsed, counted V2 interrupt interaction
(`callCount: 1`, target-shape facts retained) under the corrected anchored grammar and the first on
this pin (the R5 record had already retained a parsed interaction with an active
`previous_status: "running"` under the since-corrected unanchored grammar, §7.7/§12.8); its tool
response success-decoded to that ACTIVE status, but the case evidence again failed fail-closed on the
recurring unclassified-cell family (new 3-line/314-B shape), so exact-target delivery, pending-window
ordering,
delivery-to-settlement latency, all four settlement layers (native Child turn interruption, inner
poll-cell settlement, exact Companion process cleanup, durable job/reconciler settlement) and live
no-collateral preservation stay `not-proven` on this pin. The separately named
`native-short-window-responsiveness-control` run was deliberately NOT spent: its latency reference
serves only the delivery-to-settlement comparison, which is `not-proven`. No code changed (no
instrument defect demonstrated); item 1 on this pin remains behind the same unclassified-cell
prerequisite as items 0 and 2 (§13.4).

2026-10-13 Task 4 update: the plan's bounded-diagnostic mechanism (the §13.4 blocking prerequisite
reserved to Task 4's allowance) was built and executed (§13.6) — the campaign's first instrument
change (a gated structural whitelist in the unclassified-cell excerpt; default retention unchanged
and pinned; observer digest `e28ec619…` → `b237a6e1…`) — and the two Task 4 cases each ran exactly
once on the SAME 0.162.1 pin: `rescue-noise`'s initial run WAS the diagnostic (formal flags plus the
retention-only gate), and `background` ran its formal trial with the same gate. Both ended
inconclusive on the adjudicated unclassified-cell family with NEW structural fingerprints
(noise `38c33f61…`, background `a9d65bb2…`); both cases' cause-directed follow-ups were NOT consumed
(no concrete cause with a single changeable variable), and both cases stopped per §3. Delta items 0–2
all remain behind the same family on this pin, now adjudicated to the retention design's limit: the
next step needs content-level evidence (a privacy-authority decision outside the plan's authority) or
a host/form change — never a parser expansion. The sidecar structural policy re-verified (162/162 +
76/76); installed sidecar latency stays `not-proven` (no qualified pending observation existed to
steer).

2026-10-13 Task 5 update: delta item 3 (root command qualification) was executed on the SAME 0.162.1
pin (§13.7) — one run per command behind a corrected probe instrument. The R5
adversarial-review-wait marker miss was demonstrated to be a probe-side instrument/dependency
mismatch (the production review pipeline renders only the schema-validated structured findings
document; the Rescue sentinel can appear in no render path) and corrected RED→GREEN in the probe
spec only (`resultMarkers` → the rendered findings-document line; observer digest
`b237a6e1…` → `562981ce…`). Outcomes, each on its own record: **`adversarial-review-wait` QUALIFIED**
(exact Root linkage, launch 1/send 1, one 97800-ms same-handle poll, `processExit` 0, the corrected
marker matched, natural completion, no termination) and **`status-wait` QUALIFIED**
(`validateStatusWaitFlow` `valid: true` on the in-session owned acknowledgement → exact-id query in
the SAME session with the fixture reserving NO job; the production 120000-ms query deadline fired
UN-EXTENDED against the requested 3600000-ms observation window — exit 1 with the JOB_WAIT_TIMEOUT
framing matched; natural completion through the hold gate, no termination) — each a single-run
qualification on this pin with NO repeat claimed. **`review-wait` stays `not-proven`** with the R5
early-exit shape CONFIRMED and traced with redacted bounded evidence (launch 1/send 0, no poll ever,
host exit 0 at 15214 ms — the command reached its own terminal without ever sending the review turn,
so the gate-held observation never existed; WHY no send is not adjudicable from retained facts, a
production-scope question outside the probe). Live Status-observation cancellation stays
`not-proven`: no supported native interaction owns a Root session's own running observation
(source-pinned root/self rejection at `67727e7c`; app-server `turn/interrupt` excluded by rule;
SIGINT never assumed observation-only). Background Review/Adversarial remain enqueue-only — no live
background run was launched; the controlled timeout/ownership/result tests re-ran unmodified
(451/451 + the focused R3/background suites 25/25 — `node --test --test-name-pattern='status-wait owned-job setup and query-deadline separation|background placement flow and child-settlement lifecycle' tests/shell-wait-probe.test.mjs` — corrected from the unreproducible `18/18`, §13.7 + selection 6/6).

2026-10-14 Task 6 update: delta item 4 (generic route parity) was adjudicated on the SAME 0.162.1 pin
with NO host launch and NO code change (§13.8): the trace (production preflight + pinned source
`67727e7c`, clean) established that the host genuinely supports the generic spawn shape (optional
`agent_type`, built-in `default` role resolution, `agentRole: null` children = the planner's
`'generic'` class) but the generic route is NOT genuinely reachable under ordinary capability
conditions — the managed-Role registration that satisfies the Role preflight is itself an
`agent_roles` entry, so every state in which the Rescue flow can act exposes `agent_type` in the V2
`spawn_agent` schema and the Skill mandates named, while any role-free state fails closed before a
preparation exists. The plan's unavailable branch was executed: source + installed schema/preflight
evidence recorded (features list, read-only config probes, the non-authenticated prompt-input render
surface limitation, and the historical all-named spawn records), no fixture seam added, no run
forced, the group's one run deliberately unspent. Installed generic long-wait behavior stays
`not-proven` with this precise structural cause; the closing paragraph's "generic assignment touched
only after generic parity is demonstrated" guard stands unchanged, and parity now has a defined
unreachable-condition boundary instead of an open question.

2026-10-14 Task 7 close-out: the follow-up campaign is CLOSED on this pin with ZERO proposed production
changes (§13.9). Spec §8's positive managed-Rescue recommendation criteria are NOT met on 0.162.1: the
actual Child route, discriminating long observation, repeat, reduced re-entry and native
interruption/settlement are all `not-proven` on this pin behind the single unclassified-cell
prerequisite (§13.4–§13.6), while adversarial-review-wait and status-wait carry single-run
qualifications and review-wait keeps its traced early-exit cause (§13.7). A future campaign that could
reopen the recommendation needs, minimally: (a) the unclassified-cell shape-classification prerequisite
resolved — which requires content-level evidence via a privacy-authority decision outside the plan's
authority, or a genuinely changed host/form (§13.6's adjudication limit; no parser expansion) — and
(b) re-measurement of M, propagation, repeat, re-entry and interrupt delivery on a current 0.162.x pin
under that resolved prerequisite. The 0.161.0 records (bounded-but-imprecise M clue,
POSITIVE-but-M-imprecise propagation clue, QUALIFIED repeat) keep their own recorded scope; no
cross-version claim is made in either direction.

2026-10-15 close-out amendment (documentation-only; no host launch, no code change): the
recommendation state above is corrected in scope and extended with read-only source findings
(§§13.10–13.11), on three points. (i) Corrected feasibility boundary: the §13.6 two-cell adjudication
limit does NOT extrapolate to the five §13.4/§13.5 rescue-family cells — they predate the diagnostic
gate (observer `e28ec619…` vs `b237a6e1…`; gate code landed in `1fb30bd`) and their
`wholeBodyStatementMatch` is unmeasured and retroactively unmeasurable (records deleted); a fresh
gated run adjudicates only the fresh cell it observes, so a defect-path resolution for the family is
NOT excluded, and §13.10's Path A (one gated diagnostic run on a new delegation) is a NEXT-PHASE
CANDIDATE only. (ii) Source findings (source pin `dffa0deb…`, distinct from the executed campaign's
`67727e7c`; presence evidence only on the installed 0.162.1): the three wait layers are distinct —
inner terminal observation capped by `background_terminal_max_timeout` (default 300000 ms, an upper
bound that still requires an explicit long yield; an omitted yield is ≈5000 ms, so the Skill's
60000-ms window does not become an hour by raising the cap alone), the outer code-mode cell default
`features.code_mode.default_exec_yield_time_ms` (core default 30000 ms, no fixed 30-second hard cap
in the examined paths; an explicit shorter `@exec` pragma wins; an already-yielded outer `wait` keeps
its own 10000-ms default), and Root-for-Child V2 `default_wait_timeout_ms` (source default 30000 ms,
hard max 3600000 ms); both reachable Child keys travel through the full parent effective-Config
clone, not prompt-only inheritance, and are NOT Role-whitelist fields. The outer default is NOT new —
introduced 2026-08-07 by `d0c8f422…` and present in the old pin `67727e7c` — so it is a previously
under-exploited/unverified entry point, never "the host only now supports long waits". The genuine
default change is `72c95952…` (2026-10-07) flipping `code_mode_interrupt` to Stable/default true,
which supports cancelling an active cell/pending poll without waiting out the observation window but
is NOT terminal-process stop, Companion/ZCode-job stop or durable settlement. (iii) The production
recommendation is UNCHANGED: ZERO changes; canonical/config unchanged; spec §8's positive
managed-Rescue criteria remain unmet on every measured pin. The 0.162.1 `unsupported-call-shape`
outcome was insufficient evidence, not a host-capability removal — the shell route is not concluded
infeasible.

(Pre-close-out formulation, retained unchanged: it describes what a production change WOULD have looked
like had the human adoption happened on the 0.161.0-era evidence — the 2026-10-14 Task 7 close-out
paragraph above records that the adoption criteria are NOT met on the current pin and proposes ZERO
production changes, §13.9.)
If a human adopts the now-measured configuration/instruction findings, the smallest production change
would be: session/user-level `background_terminal_max_timeout` configuration guidance (never a Role
field — §2 whitelist), the candidate directive-led waiting paragraph in the named Role, and
version-scoped setup notes — each requiring a separate human-approved production plan, with the generic
assignment touched **only after** generic parity is demonstrated. No wrapper pragma is claimed universal;
no token-savings claim is made (no measurements). The unproven interruption dimension does not block a
human decision on the measured wait-behavior findings; it remains a recorded release dimension.

### 11.3 Execution handoff (updated through the 2026-10-13/14 follow-up, 2026-10-08)

- Provenance: Tasks 4–6 live runs on installed `0.160.1` (auto-updated mid-pipeline from `0.160.0`); R5
  live runs on installed **0.161.0** (auto-updated again; re-pinned before the trials, §1.2.2); fixture
  source pins recorded per run in §7/§8/§9/§7.7; the R5 records additionally carry the working-tree
  observer digest per record (§12.5). Scratch files `task_plan.md`/`findings.md`/`progress.md` remained
  untracked throughout.
- **Current closure status (2026-10-10 document revision):** the R0–R5 work is committed as `60b9fc5`
  ("fix: close the shell long-wait remediation review findings (R0-R5)"; the commit message records
  442 shell-research tests) and pushed to PR #66. Review closure for the accumulated remediation tree:
  a 30-round plain codex `review` loop — every finding in rounds 1–29 fixed test-first, round 30 zero
  findings — plus the independent ZCode dual-axis review (spec acceptance ACCEPT / standards ACCEPT /
  close-out CLOSE). Remote state fresh-verified 2026-10-10 via `gh`: PR #66 head `60b9fc5`, state
  OPEN, MERGEABLE, all 6 checks pass (Actions run 37862214745) — CI runs the full routine and
  marketplace suites on six platform/node combinations, covering the clean-tree check that had not
  run at R5 close. The dated bullets below record the status at their own phases, not the current
  state.
- Gates: Tasks 1–3 closed at codex zero-findings (rounds 5 / 4 / 17). Tasks 4–7 artifacts were produced
  under a recorded double-quota deviation: both reviewer channels hit hard quota ceilings on
  2026-10-06/07, before the report commit. The platforms announced quota resets at 2026-10-08 23:22
  (ZCode subagents) and 2026-10-10 05:11 (codex); these are reset times, not exhaustion times.
  The Task 4 gate ran once (`needs-attention`, 3 findings) and all three were fixed with regressions
  at `074fb07`. The codex side recovered early via an account switch on 2026-10-07, and the catch-up
  review ran that day; the resulting per-fix gates are recorded in §12.4.
- Amendment-phase review status (phase record; superseded clause updated inline): R0's corrections
  additionally passed the recorded codex-gate rounds (§12.4); **ZCode self-reviews are recorded for
  R0–R4** (§12.5–§12.8 and progress), and **independent codex backfill reviews for the R1–R3 phase
  gates (and R4/R5) remained pending at that phase** — they later ran: the accumulated working tree
  passed a 30-round plain codex `review` loop (all findings in rounds 1–29 fixed test-first; round 30
  zero findings) plus the ZCode dual-axis review (ACCEPT/ACCEPT/CLOSE) before commit `60b9fc5`.
- Uncommitted work (**historical status at the R5 documentation phase; superseded — see the Current
  closure status bullet above**): **all R0–R4 instrument fixes (plus this R5 documentation amendment)
  are uncommitted working-tree changes on top of `5026009`** — commit authorization has not been
  granted. The final routine/marketplace clean-tree `npm test` check therefore did NOT run at R5
  close; it needs either commit authorization or the spec §2 park-and-restore method (used once
  before at `4352796`, below).
- Historical final verification at `4352796` (tree fully committed — commits authorized by the user's PR
  requirement): `npm test` exit 0 with the routine suite at **3397 tests / 3394 pass / 0 fail / 3
  skipped** (the three skips are the inherited opt-in E2E guards, not win32) and the marketplace
  snapshot build **2/2**; plus `npm run test:shell-research` **177/177**, selection **6/6**, lint,
  typecheck, line endings and `git diff --check` clean, zero probe worktree registrations. The three
  untracked planning scratch files were parked outside the tree for the clean-source check and restored
  afterwards (spec §2 method, documented here). Later commits `dd156b7`, `6f8d5bc` and `31921b8`
  postdate that anchor and each recorded its own per-fix gates in §12.4. Current-head gate record at
  `31921b8`: shell-research **195/195 pass**. R5-close gate record at the uncommitted working tree:
  shell-research **293/293**, selection 6/6, lint, typecheck, line endings and `git diff --check` clean.
- Records: the eight Task 4 records (four Case 0 runs, Case A, Case B, repeat1 and repeat2),
  three live Task 5 records plus the preliminary Status command-rendering
  failure (§8), and three Task 6 records live under
  `/tmp/shell-wait-t4-*` and `/tmp/shell-wait-t5-*`, `/tmp/shell-wait-t6-*`; the ten R5 records live
  under `/tmp/shell-wait-r5*` with eight additional empty invocation-artifact directories (§7.7). All
  are OS-temporary; the report's tables are the durable summaries, as the plan intends.
  **2026-10-13 follow-up (Task 1):** the follow-up plan's Task 1 re-pinned provenance before any live
  run — installed CLI **0.162.1** (auto-updated again; §1.2.3), plugin pin `e9751d9f`, executing-observer
  digest `e28ec619…`, Codex source unchanged `67727e7c` clean — and re-ran the existing seam regressions
  green (§13.1). No live run had executed under the follow-up plan at that point. **2026-10-13 Task 2
  update:** the four Task 2 live runs have now executed on the 0.162.1 pin (§13.4) — all four inconclusive
  on the unclassified-cell family; the §11.2 delta list's measured dimensions stay `not-proven` on this
  pin, and no code changed (no instrument defect demonstrated). **2026-10-13 Task 3 update:** the
  `rescue-interrupt` run has now executed on the same pin (§13.5) — inconclusive on the same family; the
  first parsed-and-counted on-script V2 interrupt interaction under the corrected anchored grammar on
  this pin (one call, success-decoded active `previous_status`; the R5 record had already retained a
  parsed interaction with the same active status under the since-corrected grammar, §7.7/§12.8) is
  recorded there as surviving structural facts, every dependent production
  dimension stays `not-proven`, the responsiveness control was deliberately not spent, and no code
  changed. **2026-10-13 Task 4 update:** the noise diagnostic (the case's initial run, formal flags
  plus a retention-only gate) and the background formal trial have now executed on the same pin
  (§13.6) — both inconclusive on the adjudicated unclassified-cell family with new structural
  fingerprints (`38c33f61…` / `a9d65bb2…`); the bounded-diagnostic instrument seam was added (the
  campaign's first code change: gated, default retention unchanged, RED→GREEN + privacy regressions,
  observer digest `b237a6e1…`); both cases' follow-ups were NOT consumed and both cases stopped; the
  sidecar structural policy re-verified (162/162 + 76/76) and its installed latency stays
  `not-proven` (no qualified pending observation existed to steer). The two Task 4 records live under
  private OS-temp dirs `…/tmp.Y8ONkaeHm6` (noise, record digest `f0f677ca…`) and `…/tmp.MwsOB6nhkP`
  (background, record digest `32db5479…`) with the §13.4 per-run convention. Editorial note: this
  update rewrote the Task 1 note's stale closing sentence IN PLACE — "No live run has executed under the follow-up plan yet;
  the §11.2 delta list stands." became "No live run had executed under the follow-up plan at that
  point." — to avoid leaving a falsehood in the current-state handoff; the remainder of the Task 1 note
  is unchanged, and no earlier section was touched. **2026-10-14 Task 6 update:** the generic-route
  discovery item has executed with NO host launch, NO instrument change, and NO new record (§13.8) —
  the trace closed the plan's unavailable branch (generic host-supported, not genuinely reachable
  under ordinary capability conditions; precise structural cause recorded), so no generic-case record
  exists and the §13.4–§13.7 record set is unchanged; the pin stayed 0.162.1 throughout.
- Backfill cause/provenance correction: noise, Case 0 run4 and repeat2 are manually adjudicated
  **INSTRUMENT GRAMMAR LIMITATIONS**, with execution behavior unknown and inconclusive verdicts preserved.
  The R1 fix removed that preparation-grammar blocker; the R5 noise re-run failed on a DIFFERENT
  unclassified-cell shape (§7.7, cause not established). Task 5 fixture pins and unavailable executing-observer
  revisions are separated in §8; Review/Status diagnostics remain ASSISTANT-REPORTED, renderer `not-proven`.
- Human decisions open (updated 2026-10-10; commit authorization was granted and exercised — see the
  Current closure status bullet above): PR #66 merge, the §11.2 follow-up campaign (per-poll M
  re-measurement and the numeric discriminator, live interrupt delivery, noise/background, Root
  commands, generic route), and any eventual production adoption. **2026-10-14 status of the generic
  route within that list: adjudicated `not-proven` with a structural unreachable-condition cause
  (§13.8) — no live generic observation is obtainable on this pin without a genuinely changed host or
  form; the remaining open decisions are unchanged.**
- **2026-10-14 Task 7 close-out review and gate status:** the campaign's contract regression matrix,
  final clean-source `npm test`, environmental npm adjudication, executed-case ledger and S1–S7/Q1–Q6
  close-out mapping are recorded in §13.9 (plugin HEAD `a6771a4`, clean tree — committed bytes are the
  executing bytes under the delegated commit authority; observer digest `562981ce…`). Review-state
  handoff, recorded honestly: Tasks 1–4 closed at codex review gates with ZERO findings (final amended
  SHAs `3fa035a`, `67d327d`, `0e50444`, `1fb30bd`); Task 5 (`afa26ba`) and Task 6 (`a6771a4`) carry
  clean self-reviews while their codex review gates are PENDING BACKFILL — the codex review service
  suffered four consecutive network failures (2026-10-14 14:26→15:22 local: chatgpt.com connection
  failed + workspace routing discovery failed; review interrupted), accumulating backfill range
  `1fb30bd..a6771a4`; the whole-branch close-out codex review is pending on the same service recovery.
  A tooling outage is NOT authority to switch coding agents silently — this state is recorded as
  pending, never as passed. Cleanup verified at close-out: ZERO surviving
  `zcode-shell-wait-fixture-*` or campaign case-output directories in OS temp (§13.9).
- **2026-10-15 codex backfill review EXECUTED (zero findings); the pending state above is RESOLVED:**
  after the host proxy (`127.0.0.1:7890`) was restored — the outage above ultimately totaling SIX
  consecutive connection failures (2026-10-14 14:26→17:23 local; the 2026-10-14 record captured the
  first four, 14:26→15:22) — the whole-branch codex review ran to completion: `codex review --base
  41e5b0aa24189903f77acb971931df6de04a170e` over the full branch diff (`41e5b0aa..a1420f7`) returned
  ZERO findings ("No actionable regressions were identified"). This single review serves as BOTH the
  whole-branch overall review AND the backfill for the pending per-task codex gates of Task 5
  (`afa26ba`), Task 6 (`a6771a4`) and Task 7 (`5224a76`..`a1420f7`) — their commits are all inside
  the reviewed range. The reviewer's own sandbox run showed 4 test failures it attributed to its own
  sandbox permissions (npm cache access, process inspection), consistent with the campaign's
  environmental adjudication (§13.9) — which was then VERIFIED BY PREDICTION: with the proxy
  restored, `npm run test:shell-research` re-run on HEAD `a1420f7` on 2026-10-15 returned **451
  tests / 451 pass / 0 fail / 0 skipped** (46 suites, ≈29.5 s) — the two previously-failing
  real-builder fixture tests now pass, confirming the recorded verdict (the failures were the host's
  dead proxy + npm's install machinery under the fixture's sandboxed HOME, not instrument or product
  regressions). Review state complete: Tasks 1–4 per-task zero-finding gates plus Tasks 5–7
  backfilled via the whole-branch zero-finding review — recorded as executed and passed, resolving
  (never silently replacing) the pending record above.
- **2026-10-15 documentation close-out gate status (the §13.10–13.11 amendment; recorded as its own
  state):** the amendment is documentation-only, uncommitted working-tree state at HEAD `a386b73`
  pending the user's delegated commit/PR step, and its recorded verification is `git diff --check`
  clean, `node scripts/check-line-endings.mjs` clean, and `node --test tests/test-selection.test.mjs`
  6/6 (the isolation check) — no full-suite rerun was manufactured for a documentation edit. Gate
  attribution stays separated: the boundary assessment's own review provenance (an independent
  double-adversarial verifier returning CONFIRMED-WITH-CORRECTIONS with 4×P3 fixed, then a read-only
  codex adversarial gate ×3 converging to CORRECTIONS-ADEQUATE on 65 assertions) is ASSESSMENT-side
  record, restated in §13.10, not re-executed by this session; the per-task and whole-branch reviews
  above belong to their tested HEADs and reviewed range (`41e5b0aa..a1420f7`), which does NOT include
  this amendment; and this amendment's own commit-level CI/review, once a doc commit exists, will be
  recorded as its own — no result is reused across them.

## 12. Fixture (Task 3) — instrument facts only, no live claims

This section records what the Task 3 instrument does, at which seams it is tested, which of its behaviors are
fail-closed, and what it deliberately does **not** claim. Instrument behavior and Node regressions in
`tests/shell-wait-probe.test.mjs` are `fixture-tested`. The Task 4 diagnosis entries cite historical
`installed-observed` records collected in §7; their fixes do not retroactively qualify those cases.
No source/design discriminator or production contract is weakened by instrument evidence.

### 12.1 Modules and public interfaces

| Module | Responsibility |
| --- | --- |
| `tools/shell-wait-probe/fixture.mjs` | `createShellWaitFixture({ sourceRoot, sourceSha, codexBinary, output, variant, capMs })` → `{ workspace, codexHome, installedRoot, env, dispose, record }`. Also exports the exact process-identity primitives (`captureVerifiedProcessIdentity`, `inspectVerifiedProcessIdentity`, `terminateVerifiedProcess`, `validateProcessMarker`, `releaseCompletionGate`) used by the driver's bounded lifecycle; every captured identity carries one canonical `nonce` field shared by capture, re-verification, and termination. |
| `tools/shell-wait-probe/driver.mjs` | `parseShellWaitArguments(argv)` → validated closed case input; `runShellWaitCase(input, dependencies?)` → bounded redacted case record; `runHeldHostTurn(input)` → the bounded host/gate lifecycle record; closed-case CLI (9 labels, shared duration arguments, `--help` prints usage and launches nothing). Importing any module launches nothing. |
| `tools/shell-wait-probe/evidence.mjs` | `inspectShellWaitEvidence(input)` → supported facts or an explicit inconclusive reason (with `manualAdjudicationRequired` and one sanitized excerpt for unsupported shapes). |

Two deliberate interface additions beyond the plan's arrow shapes, both recorded here: (1) the fixture returns a
sixth `record` property carrying the fixture-tested provenance (instruction hashes, applied artifact digests and
modes, cap placement, owned worktree path) because the plan also requires capturing those values and the five
documented handles are all paths/env/ functions; (2) `createShellWaitFixture` accepts an optional second
`dependencies` argument (mirroring the plan's own `runShellWaitCase(input, dependencies?)` pattern) that injects
fast fakes for the snapshot build, plugin install, credential copy, and owned-worktree removal. The documented single-argument call shape
is unchanged.

### 12.2 What the fixture does (fixture-tested)

- Clears every inherited `GIT_*` variable for **every fixture Git invocation** (including validation,
  workspace init/add/commit, clone/worktree creation and disposal) and for the **builder/installed environment**.
  This covers repository, worktree, common-directory, index, object/alternate-object, namespace,
  graft/shallow/replace and discovery overrides, plus config paths/parameters/count and numbered config
  keys/values; future Git overrides are cleared too. A hostile-environment regression verifies an unrelated
  repository remains byte-for-byte untouched, its staged content and prunable worktree canary survive, and
  fixture creation, builder Git selection and disposal succeed.
- Creates a fixture-owned temporary **isolated clone** (`git clone --shared --no-checkout`) and adds a
  **clean detached source worktree** at `sourceSha` through that clone's Git metadata (`git worktree add
  --detach`). The production `buildMarketplaceSnapshot` runs against this clean worktree; its staging
  registrations and failure-path `worktree prune --expire=now` are confined to the clone's metadata. Only
  read-only Git objects are shared with the caller. The caller's registrations and uncommitted docs and
  progress files remain untouched, and nothing is committed to obtain a clean tree.
- Installs through the **exact chosen binary** (`env.CODEX_BINARY` is set to the caller's absolute executable;
  `codexLaunch` dispatches native binaries directly and `.js` entry points through Node) into an isolated
  `CODEX_HOME` plus isolated `HOME`/`USERPROFILE`, with `ZCODE_PATH` pointing at the repository's
  `tests/fixtures/fake-zcode-cli.mjs` and `FAKE_ZCODE_GATE_RESULT` fixed to the harmless public sentinel
  `ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C`. Real `codex plugin marketplace add` + `plugin add` were exercised
  headlessly with the pinned dependency CLI (no auth needed, ≈0.3 s).
- Applies the variant **before** any isolated setup: `baseline` keeps the installed
  `agents/zcode-rescue.toml.template` and `skills/rescue/SKILL.md` byte-identical; `candidate` replaces exactly
  the one waiting-policy paragraph (unique single line in both artifacts — pinned by test) in the temporary
  installed named Role template and generic assignment skill with the directive-led long-window request
  (`// @exec: {"yield_time_ms": <pollMs>}` plus the same `yield_time_ms` argument), leaving every authority
  sentence, fixed command line, initial/choice assignment literal, and terminal rule byte-identical (test walks
  the line diff and the preserved literals). `background_terminal_max_timeout` never enters the Role template.
- Writes the cap as a **prepended top-level key** `background_terminal_max_timeout = <capMs>` in the fixture
  `CODEX_HOME/config.toml` (fresh installs contain TOML table headers, so appending would silently land inside a
  table). `capMs: null` (the parser default) writes no key — the unraised-cap Case 0 shape.
- Records provenance without private paths: before/after SHA-256 and file modes of the two touched artifacts,
  rendered named Role hash via the production `renderManagedRescueRole`, extracted generic-message fence hash,
  plugin version, and the owned clean-source worktree path (inside the fixture's own temporary root).
- Disposal is attempted on **every** path after fixture creation: a live-executor failure disposes the fixture
  before the error propagates (aggregated with any disposal failure), and disposal completes **before** the record
  is persisted so the case record carries the ACTUAL disposal outcome — `cleanup.fixtureDisposed: true | false`
  plus a path-scrubbed `disposalError` on failure, never a hardcoded claim. The CLI exits nonzero when disposal
  failed.
- `dispose()` attempts both cleanup outcomes independently: the exact owned detached worktree registration
  (`worktree remove --force` through the clone's metadata) **and** the whole fixture temporary root, including
  the clone root and all its Git metadata — the credential home's parent, so copied
  `auth.json` bytes are destroyed even when the worktree-removal outcome fails — and both failures are surfaced
  to the caller (AggregateError when both fail). Registration removal is restricted to the verified owned entry
  in the clone: fixture disposal never runs `worktree prune`, and a failed targeted removal is surfaced rather
  than pruned away, and a failed registration listing is treated as an unknown/failure state, never as successful
  disposal. Registration verification compares canonical paths (`git worktree list` reports `/private/var/...`
  for a `/var/...` registration on macOS; the first commit's literal comparison was vacuous there and is
  corrected in this amendment). A real-builder regression forces its targeted staging removal to fail,
  verifies that the resulting prune uses only clone metadata, and confirms an unrelated prunable registration
  in the shared source repository survives unchanged. The suite-wide ownership canary remains in place and
  also verifies that the entire shared registration listing is unchanged after the suite. The production
  builder remains unmodified.
- `runShellWaitCase` writes the redacted case record into the caller's private output directory and asserts that
  directory stays outside the fixture credential homes before writing.

### 12.3 Instrument seams and the fast/real test split (measured, recorded honestly)

- Most fixture tests inject `buildSnapshot`/`installPlugin` fakes (the installer materializes the two installed
  files plus a config.toml with real TOML table headers, exactly the shape the real install produces) while the
  **git worktree add/remove and its registration discipline run for real in every fast fixture test**.
- Exactly one focused test exercises the real `buildMarketplaceSnapshot` + real `codex plugin add` path end to
  end (≈22 s including the build): provenance `sourceSha` matches, installed artifacts received the candidate
  paragraph, the cap key is prepended, and dispose removes the registration. The real path was measured fast
  enough (~10 s) to keep the whole suite a fast regression; the suite currently completes in ≈24 s wall time.
- `runHeldHostTurn` accepts injected `launch`, `waitForGate`, `waitForObservation`, identity capture/read/
  terminate, `waitForProcessExit`, `sleep`, `now`, and `releaseGate`. The observation budget is **polled against
  the injectable clock**, so instrument tests drive budget expiry deterministically instead of waiting wall time.
- The identity primitive is tested against a real spawned Node child carrying `FAKE_ZCODE_PROCESS_NONCE`
  (double-read `ps`/`/proc` start identity plus environment marker), and against injected readers for the stale,
  reparented, restarted, and nonce-mismatched cases.

### 12.4 Fail-closed behaviors (fixture-tested)

- **Multiple completed terminal polls in one cell block qualification (closure review fix).** The
  observer counts completed original-handle `write_stdin` statements by their owning cell and records
  a terminal observation discipline violation on the second poll, whether completion arrives inline
  or through an accepted exact-cell continuation. A pending poll retains its owning cell and preparation
  classification; its completion is counted exactly once against that cell when the continuation resolves
  it, excluding the validated one-shot private preparation write. Spec §4 prohibits batching polls to
  manufacture fewer model decisions:
  two sequential 60000-ms empty-input polls cannot qualify even with zero outer returns and a terminal
  sentinel. The mapped record retains the blocking reason. Single-poll cells (including Case B), a
  launcher plus one poll, and preparation plus one poll still qualify; pre-launch `exec_command`
  diagnostics are unaffected. The two-poll timing regression now asserts blocked qualification while
  retaining `observations.cellWallTimeMs === 120000` and `decisiveWallMs === null`, so cell timing
  remains distinct from an observation duration. Both batching expectations failed before the guard
  (**RED 0/2**) and passed after it with the four legitimate controls (**GREEN 6/6**).
  The one shell-research run reported **193 tests / 189 pass / 4 fail / 0 skipped**; all four failures
  were sandbox `EPERM` artifacts (two npm-cache accesses and two macOS process-inspection spawns).
  Selection **6/6**, lint, typecheck and `git diff --check` passed.
  The second closure pass adds the yielded boundary: two polls completed through one accepted outer
  continuation fail qualification and preserve the mapped batching reason; a yielded single poll resolved
  by an exact-cell continuation still qualifies. Before the continuation fix, these regressions were
  **RED 1/2** (the batch incorrectly qualified); afterward, both passed within **GREEN 108/108** observer
  tests, including the preparation-plus-one-poll exact-continuation control and unchanged timing checks.
  The single shell-research run reported **195 tests / 191 pass / 4 fail / 0 skipped**: both new regressions
  passed, and the original 193 tests retained 189 passes and the same four sandbox `EPERM` artifacts
  (two npm-cache accesses and two macOS process-inspection spawns). Selection **6/6**, lint, typecheck
  and `git diff --check` passed.

- **Call IDs belong to events before statement expansion (backfill review fix).** Every call/response
  event must carry a nonempty string `call_id`, without type coercion. IDs are unique among call events
  within each rollout; a response must belong to exactly one preceding call event, with at most one
  response record per ID. Missing/malformed IDs, duplicate call IDs, duplicate responses, orphan responses
  and responses preceding their call produce `ambiguous-call-linkage` inconclusive before correlation.
  Shared IDs are allowed only for statements expanded from **one** event, using ordered per-statement
  results. A missing response stays unresolved. The reproduced launcher plus empty-input poll sharing
  an ID with only one terminal response cannot qualify completion; the valid single-event multi-statement
  launcher/poll control still qualifies. Fifteen new regressions failed before implementation (**RED
  0/15**) and passed after (**GREEN 15/15**, plus the single-event control **1/1**). The one shell-research
  run reported **192 tests / 188 pass / 4 fail / 0 skipped**: all 15 new tests passed, and the original
  177 test assertions are preserved (173 passed; four sandbox artifacts: two npm-cache `EPERM` failures
  and two macOS process-inspection `spawn EPERM` failures). The foreign-preparation test fixture now
  removes the replaced call's response too, so it tests the same foreign-handle violation without an
  unrelated orphan response. Selection **6/6**, lint, typecheck and `git diff --check` passed.

- **Pending multi-statement cells never qualify on their own results (Task 4 gate fix).** A cell whose
  output carries the pending `Script running with cell ID …` header is unresolved regardless of how many
  per-statement result objects accompany it: full results plus a standing pending header is contradictory
  evidence, so nothing in the cell resolves (`parseStatementOutputs` refuses the cell) and completion stays
  blocked until an exact-cell terminal continuation settles it.
- **Whole-cell wall time is cell-scoped, never an observation duration (Task 4 gate fix).** A
  multi-statement cell's host wall time (e.g. two 60000-ms polls inside one 120-second cell) is recorded as
  `observations.cellWallTimeMs` on the cell's last entry and never attributed to a single observation:
  individual statement `wallTimeMs` stays `null` unless the host measured it per observation, so the
  decisive-observation ceiling cannot be inflated by shared cell timing. Single-statement cells keep the
  pinned per-observation header semantics.
- **The launch-observation gate shares the bounded whole-cell parser (Task 4 gate fix).**
  `waitForLauncherObservation` recognizes the exact launcher command inside multi-statement cells through
  the same `parseCallStatements` grammar the observer uses, so a valid launcher-plus-poll cell opens the
  gate instead of holding the worker until budget cleanup; malformed suffixes still reject the whole cell.

- **Third Case 0 collection diagnosis and retention (Task 4).** Read
  `/tmp/shell-wait-t4-case0c.Lj2npB/rescue-long.record.json` (source `cede2d8`, installed Codex
  `0.160.1`). Its `evidence.count: 0` counts **retained excerpts**, not collected calls.
  `mapShellWaitLiveFacts` initialized an empty excerpt list and copied neither successful call evidence
  nor `companion.preLaunchDiagnostics.excerpts`; only unsupported-call or early-exit diagnostics could
  populate it. This was a retention/mapping bug, **not** a directory, filename, ID-matching or JSON-parse
  failure. The named route, child/parent IDs, launch count, original-handle check, terminal process exit
  and 82400-ms wall time all originate in `inspectShellWaitEvidence` over parsed rollouts; held-turn
  tracking supplies host exit, gate/process-liveness and cleanup facts, not those rollout facts.
  The loader recursively scans the fixture's `CODEX_HOME/sessions` (depth 6, at most 64 JSONL files,
  16 MiB/file). The inspected Codex checkout at `67727e7c` uses
  `sessions/YYYY/MM/DD/rollout-<timestamp>-<thread_id>[_<rollout_id>].jsonl`
  (`codex-rs/rollout/src/recorder.rs`, `precompute_new_rollout_path`, and `rollout_file_name.rs`).
  It assigns `session_meta.id` from the thread/conversation ID separately from `session_id`.
  This matches the observer's successful collection; the installed `0.160.1` standalone package has a
  native `bin/codex` entrypoint, no JS rollout-path wrapper. The child is matched by **metadata ID**
  against the parent's `SubAgentActivity.agent_thread_id`, then checked against `parent_thread_id`
  and the exact agent path. The Case 0c IDs are child `01a111a3-0ef3-7892-930f-58d3775f6e3b`
  and parent `01a111a2-66f2-7b53-8101-7c784edce02e`; filenames and `session_id` are not match keys.
  A filesystem regression exercises that dated layout with those IDs, a distinct session ID and a
  suffixed filename; no speculative layout rewrite was necessary.
  The persisted record now carries `evidence.rolloutCount` and `evidence.childToolCallCount` separately
  from excerpt `count`, plus scrubbed `rollout-tool-call` and `pre-launch-diagnostic` excerpts.
  Private preparation input is replaced with `<private-input>` before retaining call arguments.
  Counts remain complete while excerpt lists/strings stay capped at 64/2048 with explicit truncation.
  Missing directories/files already yielded `rollouts-unavailable` inconclusive rather than completion
  with zero calls; parse/discovery exceptions now use that same explicit classification. Unavailable
  collection counts remain `null`. Both absence and invalid JSON have regressions.
- **Third Case 0 terminal mismatch and sentinel interpretation (Task 4).** The sentinel is exactly
  `ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C`, the fake peer's result body. The old comparison was
  `lastCompletedOnHandle.result.output === input.publicResult`: the **entire companion terminal
  output** against that bare body, not the child assistant's final message and not the host's
  `held.result.stdout`. The production `formatDirectInvocationSuccess` calls `renderOutput`, whose
  result branch appends LF, a `Resumable: yes/no` indicator when known, and a resume hint when applicable.
  Those bytes alone invalidate whole-output equality. The host is launched with `exec --json`; Codex's
  inspected JSONL processor emits serialized events on stdout, whereas its human-output processor uses
  `println!("{message}")` for a final assistant message. Neither host framing is the compared field.
  Case 0c's exact extra bytes cannot be recovered: its fixture was disposed and terminal output was
  not retained. Production rendering is a concrete reproducible cause of this overly strict comparison,
  rather than a claim about the unavailable live bytes.
  `publicResultMatchedSentinel` now means the **nonempty sentinel occurs byte-for-byte in the linked
  companion terminal public output**. It performs no trimming, case conversion, re-rendering or
  summarization; quoted assistant messages, host JSONL and foreign-handle results cannot supply the match.
  This accepts the existing renderer's framing while retaining S3's byte-preservation requirement and
  all linkage, terminal-exit and observation checks. It checks sentinel identity, not equality of the
  entire child assistant echo; the production stdout renderer/forwarder contract remains unchanged.
  A mismatch retains a `terminal-stdout-mismatch` excerpt whose output body is now WITHHELD (R0 privacy
  correction: unclassified companion stdout may echo the private task prompt) — the marker keeps only the
  exit status, the sentinel-present boolean, and the output length/bytes; the byte-exact sentinel
  presence check itself is unchanged. It is retained **first**, so list capping cannot hide it. A regression uses the real production
  formatter; altered sentinel bytes still fail even when a quoted message contains the correct sentinel.
  No existing test expectation changed. Eight new regressions first failed 0/8 before implementation;
  the final baseline replay with only the loader export enabled passed the layout control and failed
  seven assertions (RED 1/8), then passed 8/8 with the fixes. Observer and record-mapping tests passed
  108/108; selection passed 6/6 and lint/typecheck/diff checks passed. The one shell-research run
  passed 169/173: all eight added tests passed, and the 165 original expectations stayed unchanged
  (161 passed, four sandbox artifacts: two npm-cache `open EPERM`, two macOS process-inspection
  `spawn EPERM`). No authenticated live turn was run and this correction does not requalify Case 0c.
- **Launch observation gate.** Uses the evidence observer's shared bounded call parser and compares the
  extracted `exec_command` `cmd` **exactly**. Direct calls, const-r wrappers and inline wrappers have identical
  recognition, including single-quoted JavaScript literals with raw double quotes in the command. Quoted
  command text in another property, another tool, a command suffix or an unsupported script cannot open
  the gate. Both single-quoted wrapper forms and these false-positive cases have regressions.
- **Live gate.** `runShellWaitCase` without `ZCODE_SHELL_WAIT_E2E=1` and without an injected live executor
  returns a `refused` record, creates no fixture, and launches nothing (the injected-fixture spy is asserted
  uncalled).
- **Closed CLI.** Unknown case labels, unknown options, duplicate options, relative or `.cmd`/`.bat` executables,
  malformed SHAs, non-positive durations, and a contradictory baseline `--poll-ms` all fail closed; the CLI exits
  1 with the usage text; `--help` exits 0 without launching.
- **Output privacy.** `output` must be a real (non-symlink), empty, group/other-inaccessible directory; the record
  writer rejects an output inside the fixture credential homes; the record contains no fixture-private absolute
  paths (asserted by pattern in tests) and caps decisive excerpts at 64 with explicit truncation flags.
- **Evidence observer.** Supports only three observed call shapes — direct `function_call` tools
  (`exec_command`/`write_stdin`/`wait`), the simple bounded code-mode wrapper (`const r = await tools.<tool>({…});
  text(JSON.stringify(r))`, optionally led by one `// @exec: {…}` directive), and the linked outer continuation
  whose `wait` output resolves a pending `Script running with cell ID` cell. An outer continuation is accepted —
  and the pending inner observation cleared — ONLY when its canonical `cell_id` string matches the EXACT pending
  cell of the original handle; alias fields never substitute for it, any alias that disagrees with the pending
  cell or with the canonical `cell_id` is a conflicting linkage, and missing, foreign, conflicting, or ambiguous
  linkage is recorded as a violation, leaves the observation pending, and can never qualify completion — so an
  unrelated `wait` returning the sentinel cannot fabricate terminal linkage, a foreign `cell_id` cannot be
  smuggled in through a matching alias, and reference values are compared at their original types with no string
  coercion: a non-string canonical `cell_id` or a non-string alias (array, object) is a malformed reference that
  retains pending state. Completion further requires every original-handle observation to be settled: a pending or
  unresolved poll tail after the terminal record blocks qualification. Any other or truncated call — an
  unparsable wrapper, a direct `function_call` whose bounded arguments fail JSON.parse, or an argument value of an
  unsupported shape — makes the whole inspection `inconclusive` with `manualAdjudicationRequired: true` and one
  scrubbed bounded excerpt — never a zero count. Invocation is never inferred from quoted message text. Missing
  metadata, missing fake-peer records, unattributable child rollouts, and rollout-collection failures all stay
  `null`/inconclusive with their own reason, never zero. An unavailable or malformed fake-peer record blocks
  qualification explicitly: the single-send requirement must be established, never skipped, so degraded evidence
  cannot qualify. Every free-text reason that can embed a raw error passes the private-path scrubber before it
  enters the persisted record.
- **Consecutive statement cells (Task 4 Case 0 correction).** The first live Case 0 record at
  `/tmp/shell-wait-t4-case0.CsuXgR/rescue-long.record.json` retained a single cell containing consecutive
  inline `cat` and `role-status rescue` wrappers; the one-statement observer rejected it as
  `unsupported-call-shape`. The observer now accepts **1–16 consecutive statement lines**, with at most one
  leading `// @exec: {…}` directive. Each line must independently pass an existing inline wrapper, const-r
  wrapper (both `text(r)` and `text(JSON.stringify(r))` tails), or preparation-frame parser. A blank,
  unsupported or malformed line, or a seventeenth statement, rejects the **entire** cell; no supported prefix
  is counted. One final LF is allowed. Ordered printed result objects are linked individually to statements;
  a missing or extra completed result list cannot lend its terminal result to another statement. A yielded
  cell's completed prefix is resolved before its pending statement, which still requires an exact-cell outer
  continuation. Unresolved suffixes block qualification. Same-cell awaited statements resolve in statement
  order; calls in other cells retain their actual call/response event order for overlap checks.
- **Statement whitespace boundaries (Task 4 second Case 0 correction).** The const-r call-to-`text`
  boundary now accepts zero or more whitespace characters in place of the pinned single space, with the
  same tool names, bounded arguments and two exact tails.
  Consecutive statement lines now discard surrounding whitespace before independent parsing, preserving
  blank-line rejection, the 16-line bound and rejection of the entire cell on any unsupported line.
  The inline and preparation patterns already accept compact tails and have no single-space statement
  boundary to change; directive and token spacing remain unchanged.
  The second retained record at `/tmp/shell-wait-t4-case0b.bJLmLH/rescue-long.record.json` also ends its
  const-r tail with a semicolon, so both exact tails (`text(r)` and `text(JSON.stringify(r))`) now accept
  one optional terminal semicolon, while a different tail, extra semicolon or extra statement remains
  unsupported.
- **Pre-launch diagnostics and the observation window (S2).** The original companion handle comes from the
  `exec_command` whose `cmd` exactly equals the authorized `invoke-prepared rescue` launcher invocation,
  using the gate's exact-match discipline. Earlier unrelated `exec_command` calls are pre-launch diagnostics,
  not additional companion launches. They remain recorded in observer facts under
  `companion.preLaunchDiagnostics`: the full count plus at most 64 scrubbed argument excerpts, each bounded
  to 2048 characters with explicit excerpt/list truncation flags. Model-call counts still include their cells.
  A diagnostic whose response or process lifetime remains unresolved at launch overlaps the companion window
  and blocks qualification. Every duplicate exact launcher invocation and every unrelated `exec_command`
  issued after the authorized launch blocks qualification, including calls after terminal observation.
  This applies S2's observation discipline to the companion observation window while retaining pre-launch
  diagnostics as evidence; diagnostics are never silently dropped. The existing unrelated `npm test` launch
  regression already occurs after the authorized launch and keeps its original failure expectation.
  **No existing test expectation changed** for this correction. The added regressions first produced RED
  (3/13 passed, 10 failed against the original observer), then GREEN (13/13); they cover the live diagnostic
  cell, the bound and per-line rejection, preparation/result linkage, pending continuation, duplicate and
  post-launch commands, and an overlapping pre-launch diagnostic. Observer tests passed 75/75, selection
  passed 6/6, and lint/typecheck/whitespace gates passed. The single shell-research run passed 148/152:
  all four failures were sandbox artifacts (two npm-cache `open EPERM`, two macOS process-inspection
  `spawn EPERM`); the 139 original tests retained every expectation. These are instrument fixture facts;
  this correction does not itself qualify a new live run.
- **Preparation exception.** Exactly one nonempty write to the original launcher handle is sanctioned, before
  any terminal observation (including a poll that returns nonterminal output). Its complete version-5 envelope
  must pass the production `validateRescuePreparation` contract: exact required keys, a nonempty bounded task,
  closed source/options enums and types, required placement and adapter selectors, and valid continuation-target
  semantics. Both direct and wrapped writes must carry the envelope followed by exactly one LF with no additional
  input. Raw preparation frames also undergo the production reader's pre-parse duplicate-key scan: repeated
  top-level or nested keys (including escaped spellings of the same key) are rejected before `JSON.parse` can
  discard them. The observer mirrors the private `rejectDuplicateObjectKeys` scanner in
  `scripts/lib/rescue-preparation.mjs`, including its depth bound and per-object decoded-key comparisons.
  The observed `JSON.stringify(envelope)+"\n"` wrapper reconstructs string `chars`; it adds no preparation
  metadata to tool arguments, and caller-supplied `preparation: true` never grants an exemption or changes poll
  counts. The sanctioned write exempts only its nonempty input and poll count; its response still passes through
  the original-handle pending-cell and event-order machinery. Missing/unparseable responses remain unresolved,
  pending cells require a correctly linked continuation, and a poll issued before preparation or continuation
  resolution is an overlap that blocks qualification. Incomplete envelopes, object-valued `chars`, trailing input,
  late frames, foreign handles, and second frames cannot qualify completion. A wrapper with an unsupported
  suffix stays inconclusive with manual
  adjudication; a parsed invalid frame or input-injection write records a violation. Regressions retain the valid
  one-shot positive and duplicate-frame negative alongside missing, pending and delayed preparation responses,
  a correctly linked continuation, duplicate top-level/nested keys, and the earlier framing/validation bypasses.
- **Decisive wall time.** The observer extracts the tool-reported wall time from the last completed output on the
  original handle — including a cap return that carries no exit code, which is exactly the decisive observation the
  measured-M discriminator needs — and falls back to the harness-provided value only when the host reported none;
  `null` when neither exists. Both pinned header forms are matched (`source-confirmed` at `67727e7c…`): the direct
  unified-exec header (`codex-rs/core/src/tools/context.rs` `response_header`: an optional `Chunk ID: …` line, the
  `Wall time: <seconds> seconds` line, optional `Process exited with code …`/`Process running with session ID …`/
  `Original token count: …` lines, then the always-present `Output:` delimiter — `response_text` appends the
  companion stdout in the SAME item, serialized by `to_response_item`/`function_tool_response` as ONE `InputText`
  text body with NO separate JSON result item) and
  the code-mode wrapper/cell header `<status>\nWall time <seconds> seconds\nOutput:` (no colon,
  `codex-rs/core/src/tools/code_mode/output.rs`), including the OPTIONAL ` (code-mode N seconds; overhead N
  seconds) suffix that output.rs appends when experimental_show_cell_overhead is enabled — overhead may be zero
  or negative (output_tests.rs pins all framings); only the TOTAL wall time is retained from it (round-eight
  correction: the anchored pattern previously rejected the overhead framing and silently dropped the decisive
  measurement). Extraction validates header POSITION as well as shape (round-four
  privacy correction; round-nine correction for the direct form): only the FIRST `input_text` item is inspected —
  the direct form must be that item's header PREFIX through the `Output:` delimiter (a standalone wall-time line
  without the delimiter is not the real framing and yields `null`), and
  the code-mode form must be its Wall time line framed before the `Output:` marker. Withheld result bodies, companion
  stdout (whatever follows `Output:`) and later items are never scanned, so private timing-shaped text in a terminal error fabricates no duration
  and retains no number; an untrusted or absent header yields `null`. Completion evidence decodes the native
  single-item body as well (round-ten correction): when the JSON-item scan finds no result, the validated header
  prefix supplies `exit_code`/`session_id` and the text after `Output:` becomes the command output for the
  sentinel-presence check — with CARDINALITY validation (round-thirteen correction): the pinned `response_header()`
  emits each status line at most once, so a repeated `Process exited with code …`, `Process running with session
  ID …`, or `Original token count: …` line (malformed or mixed response) fails the whole decode closed to `null`
  instead of decoding a first-match value into completion evidence — stdout is never read for anything else, and the multi-item JSON form stays fully
  supported. The persisted native body is a PLAIN STRING (round-eleven correction:
  `FunctionCallOutputBody::Text` is an untagged serde variant that models.rs serializes as a bare string, so
  `parseToolOutput` accepts a string output explicitly — decoding it through the same validated-prefix rules —
  while numbers, objects, and non-JSON arrays stay rejected fail-closed; the regressions replay launch, cap
  return and terminal completion through the REAL persistence path, `parseCodexRolloutJsonl`, so the fixture can
  no longer mask the serialization). A yielded code-mode poll serializes its PENDING header the same way
  (round-twelve correction: an empty-content yield collapses to a bare string
  `Script running with cell ID <id>\nWall time <n>[ (code-mode N seconds; overhead N seconds)] seconds\nOutput:\n`,
  decoded BEFORE direct-response decoding in the string branch — the pending cell id (bounded like the array
  form) is the only retained fact, the pending wall-time line is never retained as a value, and exact-cell
  linkage is unchanged: a foreign-cell pending string still blocks qualification). Residual limitation: the installed 0.160.0
  build's exact header form may differ from both pinned forms; on that build the extraction returns `null` (with the
  harness override still available) until Task 4 observes the installed shape, and this never blocks the fail-closed
  counts above.
- **Linkage and completion negatives.** Incomplete or wrong Child linkage (missing/duplicated spawn or start
  events, child metadata not retaining the parent id or agent path), duplicate launcher invocations, foreign-handle
  polls, overlapping inner polls (a poll is resolved only by a completed host result), a live pending cell at the
  end, and a yield expiry while the worker is still alive each block completion qualification with an explicit
  reason. A qualified completion additionally requires a byte-for-byte public-result match and a terminal exit on
  the original handle.
- **Process identity.** `terminateVerifiedProcess` re-verifies PID, PPID, start identity, and nonce before every
  signal and re-validates whatever its reader returns — a stale, reparented, restarted, or nonce-mismatched PID is
  never signalled (asserted with a kill spy). An unavailable process marker during cleanup means nothing is
  signalled; the host-controlled Codex process is still terminated.
- **Cleanup labelling.** Budget expiry releases the gate, terminates only the verified exact process, labels the
  cleanup `budget-cleanup`, and never claims native interruption (`nativeInterruptionClaimed: false` in every
  cleanup path). Early host exit is labelled `early-exit`; a completed observation is labelled `observation`. The
  bounded lifecycle wraps its entire post-timer body in one cancellation finally: the budget/observation signal
  aborts on EVERY exit path — early exit, completion, rejection (including a rejecting host result), failure, and
  budget expiry — so losing gate or observation polls settle instead of reading and sleeping indefinitely,
  including after fixture deletion, and the CLI can always terminate after completed cleanup. Exact-process
  termination returns an explicit outcome (`attempted`/`signalled`/`exited`/`failure`) instead of resolving
  silently: a thrown signal is never a success while the process is still live, escalation verifies exit after
  SIGKILL within a bounded deadline, and a surviving process is reported as a failure that lands in the cleanup
  errors. The mapped case record persists that outcome on every branch — redacted cleanup-error reasons, the
  verified-process and host termination fields, and an explicit `cleanupComplete` verdict — so after fixture
  deletion it is still clear WHICH cleanup obligation failed, and an incomplete cleanup makes the CLI exit
  nonzero instead of leaving a possibly-surviving owned process behind an exit-0 record. Captured process
  identities carry one canonical nonce-bearing shape shared by capture, re-verification, and termination
  (`captureVerifiedProcessIdentity`), so a live observation's re-check and its exact-process cleanup accept the
  inspector's actual return shape.
- **Unsupported-call and final-message excerpts fail closed on CONTENT, not only on paths (R0 privacy
  correction, 2026-10-07).** The completion review found that an unclassifiable call body — for example the
  observed legal v5 preparation write whose optional `yield_time_ms:1000` argument falls outside
  `PREPARATION_PATTERN`, or a truncated/malformed call — was passed through path-only `scrubExcerpt` into a
  retained `unsupported-call-shape` excerpt, persisting private preparation/task content into historical
  records (§§7.4/8.2). `tools/shell-wait-probe/evidence.mjs` now suppresses the raw body on every
  content-classification failure and retains only structural facts under an explicit suppression marker: only
  fixed ALLOWLISTED public tool names (`exec_command`, `write_stdin`, `wait`, `spawn_agent`, `wait_agent`;
  identifier syntax alone never establishes that content is public, so payload-declared or
  `tools.<name>`-shaped unknown names — however identifier-like — are withheld behind a null fact),
  statement-line count, directive presence and only allowlisted public directive key names (`yield_time_ms`,
  `timeout_ms`, `max_output_tokens`, `window`; any other key degrades to a withheld count), and the withheld
  body's byte length. A NON-STRING body is never serialized at all (round-six correction): `JSON.stringify` can
  throw `RangeError` on a deeply nested object — outside the extraction guard, aborting adjudication — so such a
  body retains only a fixed `bodyType` classification (`object`/`array`/`number`/`null`) with `inputBytes: null`,
  and the helper's own facts serialization carries a degrading guard. NO numeric extraction runs over
  unclassified bodies (round-three correction): an
  allowlisted field NAME does not establish that a matched value is a public protocol argument, and the scan
  would read private task/chars string content too — a task text like `Authorization PIN max_output_tokens:
  74923411` previously retained the PIN as a `numericArguments` fact through evidence, mapping and the case
  record. Proving a match sits outside every string literal and outside a preparation frame would require
  JS-lexer-grade parsing of arbitrary model-written code, so the recorded limitation is: unclassified-body
  excerpts retain NO numbers; declared `yield_time_ms`/timeout facts remain available on SUPPORTED paths
  (validated argument projection), which is where the cap discriminator needs them. The same
  fail-closed rule now covers direct function-call arguments that fail `JSON.parse`, are not strings at all
  (a non-string value goes straight to structural suppression with its `bodyType` — `JSON.parse` would
  string-coerce an array like `['{"…"}']` into a supported-looking call that even qualified completion with its
  numeric payload retained, fixed in the round-seven correction), or have an unsupported
  shape, input-injection violations in `tools/shell-wait-probe/evidence.mjs` (the injected `chars` length is
  recorded, never its content), and the early-exit `final-agent-message` excerpt in
  `tools/shell-wait-probe/driver.mjs` (assistant text may echo the private task prompt, so the record keeps
  only presence, length, and a suppression flag — never the message body). Supported-path parsed-call excerpts
  are likewise projected onto the VALIDATED public protocol fields instead of a raw argument spread, and the
  per-tool schema gates projection BEFORE any value is copied (round-four correction): an unknown tool projects
  nothing (structural counts only), an out-of-schema field on a known tool — however protocol-shaped its name —
  is dropped behind the `withheldArgumentFields` count and never retained. The schema table is
  prototype-isolated (null prototype, own-property-guarded lookups), so a hostile call named like an inherited
  `Object.prototype` property (`constructor`/`__proto__`/`toString`/`hasOwnProperty`) resolves no schema and
  degrades to the structural unsupported-tool facts instead of aborting adjudication (round-five correction).
  Within schema, the excerpt keeps: the exact authorized launcher command, a validated fixture-location marker
  for `workdir` (inside-fixture-root vs unclassified — never the path or its tail), the pinned native exec
  options `tty`/`login` (booleans — the carried value is the structural fact), `shell`/`justification
  (arbitrary string content suppressed to presence and length), `environment_id` (length-only identifier),
  `sandbox_permissions` (only the pinned enum literals are retained), and tolerated `prefix_rule`/
  `additional_permissions` (never projected); numeric `session_id`/`yield_time_ms`/
  `timeout_ms`/`max_output_tokens`, a length-only `cell_id` reference (string type never authorizes
  content — never the reference value), and every nonempty or malformed `chars`
  value — strings, objects, arrays — replaced by `<private-input>`; pre-launch diagnostic command bodies are withheld behind their
  length. Extra arguments outside a sanctioned launch/poll/continuation shape are additionally a discipline
  violation that blocks qualification (a correctness fix: an unclassified field previously still qualified),
  and a `terminal-stdout-mismatch` excerpt now withholds the output body behind its size, exit status and the
  sentinel-present boolean. The wait schema additionally carries its pinned native options (`67727e7c`,
  `wait_spec.rs`): `max_tokens` (positive integer) and `terminate` (boolean) — a correctly linked continuation
  carrying them stays qualified, and the carried `terminate` value is retained as a visible structural fact
  because `terminate: true` stops the cell and is semantically distinct from ordinary observation (round-seven
  supported-path restoration). Wall-time extraction likewise reads only validated host-header positions — the
  first `input_text` item in one of the two pinned framings — never withheld stdout or result bodies, so
  private timing-shaped text fabricates no duration. Outer-linkage and contradictory-continuation reasons carry fixed classifications
  only — canonical/alias field names, reference lengths, and match booleans — never raw reference values, so
  a linkage failure cannot bypass excerpt suppression through `completion.reason`. An inconclusive
  verdict still carries its structural reason (shape class, allowlisted tool name, error
  classification) without the private frame. Eleven canary regressions with synthetic `CANARY-*`
  task/envelope/capability/echo/path/reference values — including identifier-shaped directive-key and quoted `tools.<name>`
  positions, an extra private poll field, a terminal error echo, workdir/foreign-cell_id value canaries, and
  overlong-canonical/conflicting-alias reason canaries, with a production-valid v5 preparation
  fixture (focused via `--test-name-pattern='preparation privacy'`) — the first nine failed
  **0/9** against the committed `5026009` instrument under a `git archive` replay, and the two round-two
  reference-value regressions first failed **0/2** against the intermediate fix, and all pass **11/11** after
  the fixes; the
  full shell-research suite passes **206/206**, selection **6/6**, and lint, typecheck, line-endings and
  `git diff --check` pass, all against the uncommitted working tree at `5026009` (this phase has no commit
  authority).
- **Existing-record remediation status — cleanup EXECUTED 2026-10-08 with user approval.** Field-presence
  inspection (no payload printed or copied) had shown the pre-R0 records carrying raw-text excerpts across
  three classes: five `unsupported-call-shape` records with unredacted preparation/task bodies
  (`t4-case0.CsuXgR`, `t4-case0b.bJLmLH`, `t4-case0d.jHqZlH`, `t4-repeat2.9hJDAp`, `t5-noise.o7vg44`),
  three `final-agent-message` records with assistant-text content (`t5-background.ty0i87`,
  `t6-review-wait.JYhGH8`, `t6-status-wait.DIXml7`), and three `rollout-tool-call` records whose excerpts
  are redacted-path protocol facts with empty `chars` (`t4-rescue-long.TNpWiR` — the §7.1 Case B evidence —
  `t4-baseline2.sq14ox`, `t5-interrupt.aQ5gyF`). On 2026-10-08 the user approved destructive cleanup and the
  **eight contaminated records (the five unsupported-call-shape plus the three final-agent-message files)
  were deleted**; the three protocol-fact records were RETAINED (redacted paths, empty chars, cited
  qualification evidence). Evidence impact: the raw excerpts are gone; the verdict summaries in §§7.4/8.2/9.1
  remain the record of those outcomes (the §9.1 error results were already labelled assistant-reported, and
  their raw carriers no longer exist). The same cleanup deleted four stale `zcode-shell-wait-fixture-*`
  temporary roots (2026-10-06 hard-killed runs; one contained a copied `auth.json` credential and session
  rollouts — see the fixture docstring's hard-kill leak window). All newly collected evidence is private-safe
  on both supported and unsupported paths, and every R5 record on disk carries structural-only excerpts.

### 12.5 R1 corrections: bounded parsing, unknown counts and timing provenance (fixture-tested, 2026-10-07)

All four R1 plan items are implemented in the uncommitted working tree on top of the R0 corrections; no
commit exists for this phase either. Every fix was developed test-first, with the focused RED runs retained
below; the numbers describe instrument behavior, not host behavior.

- **The observed legal preparation shape with `yield_time_ms:1000` is the sanctioned one-shot preparation
  (§§7.4/8.2 grammar limitation fixed).** Field-presence inspection of the retained repeat2 record (no
  payload printed) showed the installed host writes the sanctioned preparation as
  `text(await tools.write_stdin({session_id:N,chars:JSON.stringify({…v5 envelope…})+"\n",yield_time_ms:N,max_output_tokens:N}));`
  — an optional bounded `yield_time_ms` BETWEEN the `+"\n"` segment and `max_output_tokens`, which
  `PREPARATION_PATTERN` excluded, routing the legal write to `unsupported-call-shape` and blocking the
  repeat/noise measurements. The pattern now accepts that one optional numeric literal (1–9 digits) in the
  observed position and captures it onto the reconstructed call value as a validated supported-path
  `write_stdin.yield_time_ms` fact (where yield/timeout facts are allowed). Still NO `eval`, NO general JS
  parser, still exactly one LF after the envelope, still never treated as an empty terminal poll, and the
  one-shot/v5/original-handle discipline is unchanged: a second frame (even observed-shaped) still reports
  the one-shot violation, a foreign handle still reports the foreign-handle violation, trailing input after
  the wrapper still fails closed as `unsupported-call-shape` (never parsed as a sanctioned write), an
  invalid envelope still reports the v5 validation violation, and an unresolved/overlapping prepared write
  still blocks qualification through the same pending-cell machinery. The R0 canary regression that pinned
  the old classification of this exact shape now asserts the SUPPORTED path suppression instead
  (projected excerpt carries `yield_time_ms:1000` and `<private-input>`, never the task body or the
  embedded PIN, through evidence, mapping and the persisted record) plus a genuinely unclassifiable
  corrupted-cell control for the unsupported path. RED: 3 new tests 0/3 (first verdict `inconclusive`
  `unsupported-call-shape`; the negative tests crashed on the suppressed facts) — GREEN 5/5 focused with
  the neighboring preparation controls.
- **Unavailable Root joins are unknown (null), never a fabricated zero.** `rootJoins` was computed over
  `parentEvents ?? []`, so any case without a uniquely identified parent rollout (no parent rollout
  collected, or several ambiguous spawn rollouts) reported `0` even when the child rollout carried a
  `wait_agent` call. The count is now computed only over an IDENTIFIED parent rollout (exactly one rollout
  exposing `spawn_agent`); otherwise it is `null`. Zero still requires that positive identification and is
  then exact (parent present, no `wait_agent`); nonzero counts and the separated outer-return counting are
  unchanged; a `wait_agent` inside the CHILD rollout remains a withheld-name discipline violation, never a
  Root join. RED 0/2 (both null tests reported the fabricated `0`) — GREEN 4/4 including the
  positively-identified zero control and the separate-counts control. Root-mode accounting itself remains
  R2's work.
- **Observer provenance is recorded separately from the fixture source SHA.** `buildCaseRecord`'s
  provenance now carries an `observer` block computed from the ACTUAL instrument (round-28 update,
  refined in round-29: the digest is captured at OBSERVER MODULE INITIALIZATION — a module-init
  snapshot of the executing source threaded from `evidence.mjs` to `driver.mjs` — so it binds to
  the code that actually adjudicates, immune to edits during the awaited fixture build/install;
  the record-time re-read DETECTS mid-run source changes and records them as explicit facts —
  `sourcesChangedDuringRun: true` with the `recordTimeDigest` — instead of silently attributing
  the run to newer bytes; any read failure keeps the null-digest collection-failed rules): `revision: 'working-tree-uncommitted'` and a
  stable sha256 `digest` over the working-tree bytes of `evidence.mjs` and `driver.mjs`
  (NUL-separated under a version tag, `digestInput` records the construction). The fixture `sourceSha` stays a separate field — the fixture installs committed source
  while the adjudicating observer may carry uncommitted corrections, and this digest is what exposes that
  difference (the R5 clean-source concern). Runtime facts the instrument cannot actually observe — the
  executing `model`, the host's `reachableToolFamily` — stay `null`, never inferred from hashes; the
  binary version stays in `provenance.codexVersion`. RED 0/1 (the block did not exist) — GREEN 1/1
  (block exists, digest equals an independently recomputed hash of the two files, differs from
  `sourceSha`, `model`/`reachableToolFamily` null, stable across two record builds, persisted into the
  written record).
- **Remaining lifetime is hold-deadline-relative at a MEASURED poll start; the old arithmetic is retired
  from new records.** `workerDurationMs - decisiveWallMs` measured the decisive observation's duration
  against the requested worker duration — not the lifetime remaining when the poll started — and
  overstated it whenever the model started late. The observer no longer computes it:
  `inspectShellWaitEvidence` reports `remainingLifetimeMs: null` with an explicit
  `remainingLifetimeBasis: 'unavailable'` (the tool-reported `decisiveWallMs` is unchanged), and four
  existing assertions that had encoded the arithmetic were corrected to the new semantics. The driver's
  `runHeldHostTurn` now records the ACTUAL held-phase timeline on one documented comparable clock
  (`timeline.clock: 'held-turn-monotonic-elapsed-ms'` — elapsed milliseconds from held-turn start on the
  injectable clock whose DEFAULT is Node's true monotonic `performance.now()` rounded to whole
  milliseconds, never the stepping wall clock; tests may inject a deterministic `now` instead):
  `launchedAtElapsedMs`, `observationDetectedAtElapsedMs` (launcher observed), `pollStartedAtElapsedMs`
  (a new concurrent `waitForPollStart` watch — the live executor watches for the first EMPTY-input
  `write_stdin` statement, which the nonempty validated preparation write cannot trigger — recorded only
  when detected at or before the hold deadline), `holdDeadlineElapsedMs` and `endedAtElapsedMs`, with
  `null` for points never reached. `mapShellWaitLiveFacts` computes `remainingLifetimeMs` ONLY as
  `holdDeadlineElapsedMs - pollStartedAtElapsedMs` (basis `'hold-deadline-at-poll-start'`), keeps the full
  `held.timeline`, and otherwise records `null` with basis `'unavailable'`. Detection-direction
  limitation: `pollStartedAtElapsedMs` is the watch's DETECTION time — it lags the actual poll start by
  the rollout-append plus scan latency, so the computed remaining lifetime is a conservative LOWER bound
  that can only understate the true remaining lifetime, never overstate it (the safe direction for the
  "at least M + 30000 remaining" discriminator). The M + 30000 discriminator is
  never retroactively qualified from any of this: the retired arithmetic survives only in the historical
  JSON records already on disk, which are not rewritten. RED: 2 timeline tests 0/2 (`held.timeline`
  absent), 3 mapping/record tests 0/3 (no `pollStartedAtElapsedMs`, no hold-deadline-derived lifetime), and
  the 4 corrected arithmetic assertions 0/4 — GREEN 9/9 focused, including the delayed-model-start
  regression where the old arithmetic (200000 − 30000 = 170000) would have overstated the actual
  measured remaining lifetime (229000 − 149000 = 80000) by more than a factor of two.

Self-review P3 notes (2026-10-07): the three stale `shell-wait-suite-canary-*` worktree registrations
left by earlier suite runs were removed surgically (the exact `.git/worktrees/<entry>` admin entries
whose `gitdir` pointers matched the deleted temporary canary directories — the suite's own after-hook
discipline; no global `git worktree prune` ran, and all other registrations are intact). Deferred, not
fixed: (a) `observerProvenance()` was computed at record-build time only — IMPLEMENTED since the
round-28 review (2026-10-06): the digest is captured at case start, the record-time re-read detects
mid-run instrument changes, and changed runs record `sourcesChangedDuringRun` with the record-time
digest while staying attributed to the case-start revision; (b) parent-rollout
identification still means "exactly one rollout exposing `spawn_agent`" without additionally binding the
parent's session metadata — tightening that belongs to R2's Root-observer work.

Gates for this phase (uncommitted working tree on `5026009`): full `npm run test:shell-research` runs are
recorded in the R5 verification box; selection `node --test tests/test-selection.test.mjs` 6/6, `npm run
lint`, `npm run typecheck`, `node scripts/check-line-endings.mjs` and `git diff --check` pass. A first
full run at 229 tests failed only the two R0 canary assertions that had pinned the pre-R1 classification
of the now-supported shape (both described above) — no other expectation moved; that run's output is
retained at `/tmp/shell-wait-r1-full.log`, and the final run passes 229/229 with exit 0.

### 12.6 R2: Root-family observer and instruction-delivery seam (fixture-tested, 2026-10-07)

R2 implements the reviewed root-family observation contract that §9.2 identified as the missing
prerequisite, plus the R1-carried parent-identification tightening. It is **fixture-tested instrument
readiness only**: no installed root-family command has been qualified, no live trial ran, and §9.1's
per-command outcomes are unchanged.

**Observer contract selection by case family.** `inspectShellWaitEvidence` now takes `mode`
(`'rescue'` default, `'root'`; anything else fails closed with a `TypeError`). Rescue mode is
byte-for-byte the pre-R2 contract (exact Child linkage, one launcher invocation, the fake-peer
single-send requirement, one-shot v5 preparation sanction, sentinel result). Root mode never consults
the Rescue Child checks — an absent Rescue Child cannot disqualify a root case — and qualifies only on:

- the **exact validated Companion invocation**: the single rollout whose supported calls contain the
  exact rendered command (`renderCompanionCommand(<installed>/scripts/zcode-companion.mjs)` +
  `invoke review|invoke adversarial-review|invoke status`); a command that appears only inside quoted
  assistant text or a delay script never qualifies;
- the **exact Root process handle**: the launched host turn IS the Root-side process, keyed to the
  launch's own unified-exec session id; foreign-handle polls, overlapping inner polls, unresolved
  cells, and unsettled observations-after-terminal block qualification through the SAME
  sequence/linkage/overlap/pending machinery as Rescue (reused, keyed to the Root handle);
- the **settled outer-cell continuations**: the Root turn's own code-mode polls with exact-cell
  linkage — a foreign-cell response is contradictory evidence that blocks, and the cadence
  (`outerReturns`) counts the Root case's own continuations;
- the **terminal exit** on the Root handle; and
- the **command-specific rendered result** (`publicResultMarkers`, all must be present in the linked
  terminal output): Review/Adversarial Review check the fake peer's final public result sentinel
  inside the verbatim-presented rendered review output; Status checks the stable rendered job-status
  field lines (`render.mjs` `renderJob`). Each is the NARROWER marker-presence check — the record's
  `resultCheckLabel` says so explicitly, and full rendered-output equality is never claimed.

Unavailable Root facts stay `null` (never guesses or zeros): root identification binds the identified
Root rollout's session metadata id (`linkage.rootThreadId`, with `linkage.mode: 'root'`);
`rootJoins` stays `null` for root cases — it remains the Rescue-mode Rescue-Child-join metric, and the
Root case's own polls are its cadence accounting. A Rescue-shaped private preparation write in a root
case is input injection (the v5 preparation sanction is Rescue-specific). Root-mode excerpts reuse the
R0 `projectPublicCallArguments` suppression unchanged, so every R0 privacy rule holds on the new path.
Root positives: review-wait / adversarial-review-wait / status-wait each qualify with NO Rescue Child.
Root negatives: foreign handle, foreign-cell result, quoted invocation, unresolved cell, overlapping
poll, duplicated launch, truncated evidence (inconclusive), renderer mismatch (with the body-withholding
`terminal-stdout-mismatch` excerpt), a spawned delay script, and an assistant success claim.

**R1-carried parent-binding tightening (Rescue mode).** Exact Child linkage now additionally requires
the identified parent rollout to expose session metadata: an unbound parent (no `session_meta`) keeps
`linkage.exact === false` and `parentThreadId === null` even when the child's own metadata carries
`parent_thread_id: null` — the null-vs-null comparison could previously fabricate an exact binding.
This closes the deferral recorded in §12.5.

**Candidate-policy delivery seam.** The fixture takes `commandSkillVariant` (`'baseline'` default;
`'candidate'` requires `variant: 'candidate'`, else the creation is refused fail-closed). For a
root-family candidate case the driver requests it, and the fixture applies the candidate waiting
paragraph — the same directive-led single-long-window discipline as the Rescue candidate edit, in the
command Skills' own wording — to the ISOLATED installed copies of the Review, Adversarial Review, and
Status Skills, replacing the installed 60000 paragraph. Commands, arguments, renderer, ownership, and
placement stay byte-identical (only the waiting instructions move; the constant-command sentence is
asserted unchanged against the repository Skill text). The fixture record carries
`commandSkillVariants` (variant, per-Skill before/after SHA-256 and mode, sanitized paragraph
differences, and the note that a raised fixture cap or a `--poll-ms` record alone is NOT proof of Root
instruction delivery — the delivered Skill text is); the case record maps it into
`provenance.instructionVariants.commandSkillVariants`. A candidate root-family fixture's installed
Skills contain the delivered candidate paragraph; a baseline root-family fixture's stay byte-identical
with identical hashes. A broken installed Skill (paragraph absent) fails the fixture closed.

Gates at the R2 working tree (uncommitted on `5026009`, all slices RED before GREEN): the root-observer
slice ran RED at 2/14 (twelve expected failures — every positive rejected by the Rescue verdict frame
and every mode-keyed fact null; the two already-fail-closed negatives passed and stayed as guards), the
binding regression was verified RED by temporarily disabling the check (it observed the fabricated
exact `true` binding without it), the delivery-seam slice ran RED at 0/5 (the installed Skills still
carried the 60000 paragraph), and the mapping/record slice ran RED with 4 failures; GREEN totals:
`npm run test:shell-research` **253/253 pass, exit 0**
(229 pre-R2 expectations unchanged + 24 new), selection 6/6, `npm run lint` clean, `npm run typecheck`
clean, `node scripts/check-line-endings.mjs` clean (533 files), `git diff --check` clean, zero
shell-wait worktree registrations after the run.

### 12.7 R3: Status in-session owned targets, query-deadline separation and the background lifecycle (fixture-tested, 2026-10-07)

R3 closes the two completion-review defects: the Status case had NO actual owned target/query
timeout (the model was prompted vaguely and the Companion's `ARGUMENT_INVALID` error would surface
only as an assistant-reported failure), and the explicit Rescue `--background` prompt requested a
`queued` acknowledgement — the Companion-background branch semantics — while S4's placement matrix
requires the Host-background branch: Root acknowledges the exact launched Child without joining,
and the Child itself observes its foreground Companion to terminal. A self-review P1 then reworked
the first defect's fix: the initially implemented fixture-reserved job was owned by the
fixture-setup session, which can never run the live query (production selects explicit Status
targets OWNER-SCOPED, `selectOwned` filters `listOwnedJobs(workspace, caller.sessionId)` —
reproduced end-to-end: session A reserves, session B queries → `OWNED_JOB_NOT_FOUND`). The live
contract below supersedes it; every R3 claim remains fixture-tested instrument readiness, and all
installed-command outcomes stay open until R5.

**The live status-wait contract: the job is created INSIDE the live host session.** The case is a
TWO-TURN SAME-SESSION flow. Turn 1 (the case's constant prompt) launches the held job through the
live session's own recorded production command — `$zcode:review --background`, the documented
enqueue-only background creator whose acknowledgement render (`render.mjs`: "Reserved background
job <id>.") carries the reserved job ID; with the direct-invocation `autoLaunchBackground` the
detached worker claims the job and its fake-ZCode engine blocks on the fixture completion gate, so
the job stays running — held — exactly through the seams the fixture already uses. The driver then
extracts the acknowledgement's job ID from turn 1's OBSERVED rollout as a validated fact, and
turn 2 resumes the SAME session (`codex exec resume <SESSION_ID> <PROMPT>` — exec CLI subcommand,
source-pinned; the exact installed surface is pinned at R5) with the explicit invocation
`$zcode:status <id> --wait --timeout-ms <ms>` rendered by `statusWaitInvocation` from the OBSERVED
ID. Ownership is inherently correct because the job was created in the querying session. Two
production facts shaped this design and are recorded honestly: (a) the live session cannot invoke
plain `rescue` (the direct `invoke rescue` entry is `PREPARED_INVOCATION_REQUIRED`), and (b) the
explicit `--background` rescue mapping's launched-Child acknowledgement deliberately carries NO job
ID (the Skill: it claims nothing about Companion work), so the production creator reachable
in-session whose acknowledgement carries the ID is the enqueue-only review/adversarial-review
background surface — the self-review's literal `rescue --background` wording is corrected to this.

**Observed-flow validation (fail-closed, never pick-one).** `extractStatusLaunchAcknowledgement`
and `extractStatusQueryJobId` extract the launch acknowledgement ID (both production acknowledgement
render shapes) and the queried job ID (renderJob's `Job: <id>` field line) from OBSERVED tool
outputs only — assistant message text is never evidence (R0 suppression applies); zero matches stay
`null`, multiple distinct IDs are AMBIGUOUS and never resolved by picking one.
`validateStatusWaitFlow` binds the two facts with per-condition rejections: missing or ambiguous
acknowledgement, missing or ambiguous queried job, missing launch/query session id, query session
different from the launch session (ownership unproven), queried job different from the launched
acknowledgement, and a missing/invalid explicit timeout. The record carries the full
`statusQuery` fact set (both IDs and sessions, the timeout, and the validation verdict); an
invalid flow is inconclusive, never silently accepted. `renderExecResumeLaunch` assembles the
resume argv (`resume <launchSessionId> <queryPrompt>`) and refuses a missing launch session or
prompt.

**The fixture seam is instrument-level test setup only.** The fixture's
`reserveOwnedStatusJob` (real companion CLI `rescue --background --fresh` as a bounded fd3 child,
the caller envelope minted by the real identity store for the hook-recorded owning turn, the
returned queued acknowledgement as the only ID source, ownership/held state re-verified read-only
through the production store) remains EXPORTED but is now labelled the OWNING-SESSION TEST SETUP:
it proves the production reservation path and the timeout semantics on real durable records, and
the instrument tests query from that owning session — valid for exactly what they prove. The LIVE
path never requests it (`runShellWaitCase` passes no `reserveStatusJob`), the fixture record labels
the reservation's `setupScope`, and a missing owning turn still fails closed inside production
(`callerMatchesActive` requires the proved, generation-matched caller record).

**Query-deadline separation (process timeout vs job completion).** The measured proof runs the
production commands against the instrument reservation: `runCompanion(['status', jobId, '--wait',
'--timeout-ms', '50'])` rejects with `JOB_WAIT_TIMEOUT` while the job is non-terminal and the job
is still held afterwards — the query deadline expired independently of any job completion and the
expired wait left the job held. The rendered deadline is independent of the held-turn windows:
`workerDurationMs`/`budgetMs` never leak into `--timeout-ms` (asserted positively and negatively),
the case default equals `parseStatus`'s production default 240000 ms (read from
`scripts/lib/args.mjs`, whose parser also proves `--wait` requires an explicit job ID and
`--timeout-ms` requires `--wait`), and the `--status-query-timeout-ms` CLI option (positive
integer, refused for every non-Status case) renders verbatim. The cancelled Status-observation
subcase stays pending R4.

**Background prompt/flow corrections.** The `background` case spec now requests the exact
launched-Child acknowledgement — "Return only the exact acknowledgement that the Host child was
launched, claiming nothing about Companion work being queued, accepted, started, or completed" —
with Root performing no join (`rootJoinsChild: false`, no join instruction in the prompt) and
naming the Child's own foreground-Companion observation to terminal (the S4 explicit
`--background` mapping). The queued wording is deleted. Distinctness is enforced by spec facts:
the five Host-foreground Rescue cases carry `rootJoinsChild: true` with their terminal-public-result
prompts; Review/Adversarial/Status carry neither background fact; `backgroundFlow: true` exists
ONLY on `background`, so no other case can inherit the settlement lifecycle.

**Probe lifecycle: Root acknowledgement is not Child settlement.** `runHeldHostTurn` gains the
child-settlement phase: when a case declares `backgroundFlow` and the boundary is the host RESULT
(Root exited with its acknowledgement), the held turn records `rootAcknowledgementAtElapsedMs`,
first opens the Child's completion path (the experiment-control gate release — the gate race is
already settled by that boundary), then runs the `waitForChildSettlement` watch within the
remaining budget, and only then settles: the exact fake process is terminated AFTER the watch, so
Root's acknowledgement can never kill the Child or end the observation early. The watch
(`waitForChildSettlementObservation`) polls the collected rollouts for the structural settlement
basis `exact-command-launch-then-completed-exit-code-output` — decoded with the SAME
`parseToolOutput` the observer uses (now exported); an aborted or expired watch resolves
unobserved, never fabricated. The record carries a `child` section and the held timeline the two
new timestamps; cleanup labels distinguish `child-settlement-observed`,
`child-settlement-unobserved` and `budget-cleanup`. Only a declared background case with an
OBSERVED settlement drops the generic "host ended before the held completion boundary"
inconclusive — the same held shape in any foreground case keeps it. Fixture disposal remains
strictly after the held turn settles. §8.3's measured installed result (early host exit, zero
launches) stands unchanged as the honest measurement of the OLD prompt; R5 must re-run the case
with the corrected prompt and this lifecycle before any installed background claim.

**Fixture disposal limitation (recorded from environment debris).** Fixture cleanup is
IN-PROCESS: a hard-killed run (SIGKILL of the probe, host crash) cannot run dispose, so that
run's temporary root — including the copied credential source inside the isolated home and any
session rollouts — leaks under the caller's tmpdir. Such leftovers (four `zcode-shell-wait-fixture-*`
directories from the 2026-10-06 dev runs are known to exist, one containing a real copied
credential and session rollouts) are user-approved-deletion debris; no later run auto-cleans them,
and each leaked root is bounded to one disposable mkdtemp directory.

**Gates.** Plan R3's "relevant existing job/placement tests" ran unchanged and green:
`node --test tests/job-control.test.mjs` **209/209** (the suite that pins owner-scoped explicit
target selection) and `node --test tests/rescue-route-planner.test.mjs` **161/161** (the placement
matrix planner); no production file was touched by R3, so no production expectation changed.
Plan-R3 checkbox updates are deferred to R5's box-update ownership (deliberate, matching the
R0-R2 handling). RED/GREEN at the rework: the 7 new/reworked live-flow tests failed against the
fixture-reservation design (seam requested by the live path, extraction/validation/resume helpers
absent, turn-1 contract absent) and pass after the rework; the instrument owning-session tests
kept passing unchanged. A second-review P1 fixed the turn-2 argv composition:
`renderExecResumeLaunch` had duplicated `CODEX_EXEC_COMMON_ARGUMENTS`, producing
`codex exec … exec … resume …` — the second literal `exec` would consume the PROMPT positional and
the resume subcommand could never parse (turn 2 would usage-error or start a fresh mangled
session, making same-session ownership unreachable live). `renderExecResumeLaunch` now returns
ONLY the subcommand tokens (`['resume', <launchSessionId>, <queryPrompt>]`), the turn launcher
composes the common argv exactly once through the new tested
`composeHostLaunchArguments` seam, and a composition-level test asserts EVERY token of the full
turn-2 argv (exec exactly once, `resume` first after the flags and workspace). A mapping-level
test also pins the invalid-flow verdict: an observed launch/query ID mismatch maps to an
inconclusive record with the full `statusQuery` facts, and a matching flow maps to `null`
inconclusive. Final totals: `npm run test:shell-research` **277/277 pass, exit 0**
(253 pre-R3 + 24 R3), selection 6/6, `npm run lint` clean, `npm run typecheck` clean,
`node scripts/check-line-endings.mjs` clean (533 files), `git diff --check` clean, zero shell-wait
worktree registrations and zero new fixture temp directories after the run.

### 12.8 R4: owning-session interrupt delivery recording and Status-observation cancellation (fixture-tested, 2026-10-08)

R4 closes the completion review's P2 "native interrupt case is only a placeholder" at the instrument level.
The installed owning-session surface is established (§3.3: V2 `interrupt_agent`, enabled on the live
machine by the `features.multi_agent_v2` block present in the live config — block authorship NOT
ESTABLISHED, §3.3 — registered in a normal exec Root turn, targeting
the exact child through the shared in-process registry). Because the only in-exec-session delivery path is
the model-facing tool call inside the owning Root turn, the wiring is three-part, all fixture-tested
(`fixture-tested`; live delivery measurement is R5's through this wired path):

- **Case prompt wiring** (`SHELL_WAIT_CASE_SPECS['rescue-interrupt']`): the prompt now directs exactly one
  `interrupt_agent` delivery to the exact agent id the spawn acknowledgement returned, only while the
  observation is pending, with "do not interrupt any other agent" explicit. Every other case prompt is
  pinned free of the directive.
- **Interaction extraction** (`evidence.mjs` `extractInterruptInteraction`): parses the Root rollout for
  the V2 `interrupt_agent` call (and the legacy V1 `send_input {interrupt:true}` flag, which is NOT an
  interrupt without the flag), its output (success `previous_status`, structural rejection kinds
  `target-unknown`/`target-root`/`target-self`/`output-unparseable`/`unclassified`, or unknown), the
  sanitized target (recorded only when id-shaped or the known fixture task marker; anything else is
  suppressed to its structural length), and the pending/terminal ordering facts with rollout-event
  timestamps when present. No call body, output text, or raw rejection message ever enters the facts.
- **Driver mapping/record**: the persisted `interrupt` block now carries `attempted`, `family`,
  `delivered`, `rejection`, `previousStatus`, `target`, `exactTargetMatch` (bound against the observed
  exact Child thread id), `settled` + `settledBasis`, `pendingIntervalMs` + `deliveryToSettlementMs` +
  `timingBasis`, and `missingPrerequisite`. The fail-closed behaviors are test-pinned: unsent intent keeps
  `delivered: null` with the explicit investigated-surface reason (the retired "Task 5 live path"
  placeholder is gone); a wrong target records the rejection and leaves the qualified observation
  decisive; a post-completion delivery is recorded but NEVER attributed as interrupt settlement
  (`post-completion-delivery-not-attributed`); an external budget kill stays `budget-cleanup` and is never
  labeled native; and turn interruption WITHOUT inner-poll settlement records
  `settled: false` / `turn-interrupted-pending-observation-survives` — the yielded cell surviving the
  abort is the measured result, never proof of observation cancellation. A delivered EXACT-target
  interaction against the confirmed pending observation (never a post-completion delivery) is the
  interrupt case's own contract: the early-exit/completion inconclusives do not bury it (mirroring R3's
  settled-background exemption); a late-only delivery keeps the generic adjudication with its facts
  recorded (this exemption was subsequently NARROWED by the post-trials review loop — see the review-round
  corrections below). `cleanup.nativeInterruptionClaimed` stays hard `false`.

**Review-round corrections to the interrupt rules (`fixture-tested`, post-trials review loop; seven P2
findings fixed with 13 new regressions, all RED first):**

- **Ordering bound to the EXACT Child observation.** `extractInterruptInteraction` previously collected
  EVERY completed shell output in any rollout as potential Child completion, so a Root-side command that
  merely finished before the interrupt call set `sameRolloutCompletedBeforeCall: true` and misclassified
  a genuine pending-Child interruption as post-completion, while unrelated outputs could supply
  settlement latency. Ordering/timing events are now bound to the exact Child's ORIGINAL HANDLE and its
  linked continuations: the driver derives a binding from the supported evidence's exact child thread id
  plus the exact launcher command, the binding reuses the sequence machinery (single rollout carrying
  the child's session metadata id, `collectCalls` + `analyzeCallSequence` → original handle, attributable
  call ids = that handle's polls + accepted `wait` continuations), and only those events feed
  pending/terminal ordering. With no resolvable binding the ordering facts FAIL CLOSED:
  `orderingBound: false`, `pendingBeforeCall.observed: false`, `sameRolloutCompletedBeforeCall: null`,
  null timing — never guessed booleans. A bound completed event at/before the call also feeds the
  post-completion classification (`completedBeforeCall`), and an unbound delivery is recorded as
  `ordering-unbound-not-attributed` instead of a claimed post-completion fact.
- **The delivered-exact exemption is narrowed to the interruption-specific terminal failure.** The old
  `interruptDeliveredExact` flag suppressed EVERY completion failure once the delivery reported
  delivered + exact target; a synthetic rollout with two launcher invocations, two session sends and no
  pending observation adjudicated `inconclusive: null`. The exemption now requires CONFIRMED
  pending-window delivery (`orderingBound`, the pending observation demonstrably before the call, never
  post-completion) AND every structural completion check — exact linkage, exactly one launch, exactly
  one observed send, observation discipline, `structuralViolationCount === 0` (evidence completion now
  splits its violations into structural checks and the interruption-sensitive terminal ones: missing
  exit code, missing result markers, an observation left unsettled at the end). Only those terminal
  failures are excused — the Child was interrupted before completing — and the two-launcher/two-send
  regression pins that such a run stays unqualified with its reasons.
- **Root-control calls no longer fail the whole case.** The fail-closed scan ran
  `parseCallStatements` over every rollout with a grammar that excluded the interrupt tools, so the
  observed R5 shape — a Root-side `text(await tools.interrupt_agent({…}));` wrapper cell — failed the
  case `unsupported-call-shape` before the Child evidence adjudicated (the R5 interrupt record's
  missingPrerequisite cause). A NARROW validated Root-control path now recognizes `interrupt_agent` /
  `send_input` as root-control calls (shared with the main scan; excerpt projection limited to the
  sanitized target: id-shaped or the fixture task marker retained, anything else suppressed to its
  structural length). They remain UNSUPPORTED inside the identified Child rollout — the Child sequence
  discipline is unchanged and still counts them as violations.
- **The attempt grammar is anchored.** The old wrapper pattern was an unanchored substring search, so a
  cell that merely PRINTED `tools.interrupt_agent({"target":…})` inside a string fabricated an attempted
  V2 delivery and removed the missing-delivery prerequisite. Attempts are recognized only in the
  complete anchored awaited-call statement form (the same wrapper grammar the observational family
  uses); the quoted-print regression pins that printed text is never an attempt.
- **Family-specific success decoding.** The pinned V1 `send_input {interrupt:true}` handler returns
  `{ submission_id: … }`, not `{ previous_status: … }` — successful V1 delivery previously decoded as
  `delivered: null` + `output-unparseable` (masked by a V2-shaped test fixture). Success decoding is now
  family-specific (V2 → `previous_status`; V1 → `submission_id` presence, `previousStatus` stays null),
  cross-shaped bodies stay unparseable, and the test uses the real V1 response shape.
- **Per-poll wall times are retained (the M-trial instrument correction).** The R5 M record's
  `decisiveWallMs` is `sequence.lastCompletedOnHandle` — the TERMINAL observation — and no per-poll
  output timing survived, leaving the cap return's duration unattributable (§7.7's M correction). The
  sequence machinery now retains `pollWallTimesMs`: each completed original-handle observation's OWN
  tool-reported wall-time header value in event order (single-statement polls already carried it on
  their output; multi-statement cells keep cell-scope timing and contribute per-statement nulls),
  surfaced through the evidence facts (`handle.pollWallTimesMs`,
  `observations.pollWallTimesMs`), the mapped live facts, and the persisted record — so any future M
  trial measures the cap return directly and the §6.2 precondition recomputes as
  `firstPollMs + 30000 ≤ remainingLifetimeMs`.

**Review round 2 refinements to the interrupt/timing rules (`fixture-tested`, second plain review; 3
findings, 5 new tests, RED first):**

- **Settlement (and its latency) require the EXACT target.** Chronological ordering alone never
  establishes interruption: a successful delivery to ANOTHER agent while the observed Child is pending
  — even when that Child subsequently completes normally through its own terminal observation — is
  never attributed as settlement (`settled` stays null,
  `settledBasis: 'delivery-target-unmatched-no-settlement-claim'`), the surviving-pending basis is not
  claimed either, and the delivery-to-settlement latency is computed only for `exactTargetMatch: true`
  deliveries (an unrelated completion supplies no interruption timing; the pending-window interval
  stays recorded as chronology). The qualified Child completion remains the run's decisive fact.
- **Exactly-one-delivery contract.** The extractor already counts EVERY interrupt-shaped call
  (`callCount`), but the count was neither persisted nor checked: a rollout that interrupted a foreign
  agent and THEN the exact Child retained only the final delivery's facts under the exemption. The
  count is now persisted in the interrupt facts and the case record (`interrupt.callCount`), and
  `callCount !== 1` fails closed: settlement is never attributed
  (`settledBasis: 'multiple-delivery-attempts-not-attributed'`) and the exemption cannot fire —
  collateral interruption is recorded, never hidden behind the last call.
- **`pollWallTimesMs` stays aligned 1:1 with polls.** The preparation exemption now applies to the
  per-poll timing array as well: a sanctioned preparation write that yields and settles through its
  own linked outer continuation contributes NO duration (previously its header value was appended
  after the pending cell cleared, producing e.g. `[2000, 30000]` beside `pollCount: 1`). The array
  exists to make the cap return separately measurable, so it contains only actual poll durations.

**Review round 3 refinements to the interrupt/timing/settlement wiring (`fixture-tested`, third
plain review; 6 findings, 9 new tests + 1 reworked watch test, all RED first — the two poll-watch
negatives hang under the pre-fix signature and were RED as runner timeouts):**

- **The completion exemption is scoped to the interrupt case.** The exemption never checked
  `input.case`: an unexpected interrupt during `rescue-long`/`rescue-repeat` excused that case's own
  terminal-completion failures (pending observation + no exit + no sentinel → `inconclusive: null`).
  The exemption now requires `input.case === 'rescue-interrupt'`; interrupt facts stay recorded in
  every case, but only the interrupt case's own contract excuses terminal failures.
- **A resolved pending observation is no longer pending.** The extractor treated a poll's pending
  output as pending-state evidence forever — only exit-code outputs counted as completions — so an
  interrupt delivered AFTER a later poll resolved the cell to a still-running state still saw a
  confirmed pending window. Bound observation events now carry their resolution kind, and ANY later
  bound completed response (exit-code OR still-running nonterminal) between the pending header and
  the call resolves the pending state: no pending window, no pending interval, no exemption.
- **The background settlement watch binds to the launch handle.** After the exact command launched,
  ANY later exit-code output in that rollout counted as Child settlement — an unrelated command's
  output reproduced `observed: true` while the Companion stayed pending. The watch now grounds the
  ORIGINAL handle through the launch's own output session id (the launch output is the handshake,
  never the settlement) and resolves only through that handle's OWN polls and their linked
  continuations (basis relabelled `exact-launch-handle-linked-completed-exit-code-output`).
- **The poll-start watch binds to the selected rollout and the original handle.** The full-history
  scan treated ANY empty-input `write_stdin` as the measured poll start — a preflight/diagnostic
  empty poll anywhere would be taken as the poll start, overstating `remainingLifetimeMs` and
  falsely satisfying the cap precondition. The watch now takes the command argument, selects the
  rollout exposing the exact launch, grounds the handle from the launch's own output, and fires only
  on an empty-input poll to THAT handle.
- **`pollWallTimesMs` carries the INNER POLL's own timing.** For a poll resolved through an outer
  continuation the array retained the continuation's header — that measures the wait request, not
  the poll (a 300 s poll with a 5 s continuation was retained as `[5000]`). A continuation-resolved
  poll now keeps an UNKNOWN duration (`null`): only a poll whose OWN response completed contributes
  its reported duration, so the metric measures cap returns. (The round-2 preparation exemption
  stands; the terminal observation's own header still feeds `decisiveWallMs`.)
- **The poll-start watch compares on one clock origin.** `elapsed` (relative to the turn origin) was
  compared against `holdDeadlineMs` (absolute monotonic) — always true for a nonzero origin, so a
  watch resolving after gate release still populated `pollStartedAtElapsedMs`. The callback now
  compares `now()` against the absolute deadline and records the poll start only for a detection at
  or before it; post-hold detection leaves the fact unknown (null).

**Review round 4 refinements (`fixture-tested`, fourth plain review; 2 findings, 8 new tests, 7 RED
first — one test is the fail-closed control that pins the pre-fix unbounded behavior):**

- **Interrupt wrappers decode with the supported literal parser.** The extractor re-parsed the
  anchored Root-control wrapper body with `JSON.parse` only, while `parseCallStatements` (the
  fail-closed scan) already accepted the bounded JS-literal fallback — a real successful delivery
  emitted as `text(await tools.interrupt_agent({target:"<agent-id>"}));` (unquoted key) recorded
  `attempted: false` / `callCount: 0`, losing delivery/settlement evidence. The wrapper body now
  decodes through the SAME bounded `parseWrapperArguments` (JSON first, string-aware JS-literal
  fallback, bounded length), so both classifications agree; the R0 suppression rules still apply —
  the decoded target goes through the id-shaped-or-suppressed sanitizer (a literal with a private
  target stays suppressed to its structural length; regression pinned).
- **The Status query turn is measured alone when the boundary holds.** The two-turn Status flow
  resumes the SAME session, so the identified Root rollout retains the turn-1 SETUP observations: a
  legitimate setup poll on the background launch's own handle counted as foreign-handle polling and
  the settled launch as an overlapping diagnostic, unqualifying a valid turn-2 Status completion.
  The driver now establishes the boundary from the OBSERVED post-turn-1 rollout state
  (`findStatusSetupTurnBoundary`: the launch session's rollout event count — an append-stable setup
  prefix) and the evidence request carries it (`rootQueryTurn`, Status cases only). The root
  analysis applies it ONLY when the identified Root session matches: the `calls`, sequence, and
  model-call cadence scope to the measured query turn, the setup turn neither counts as
  foreign-handle polling nor as an overlap, and the applied boundary is recorded in the linkage
  facts (`queryTurnScoped`, `queryTurnSetupEventCount`). A missing, non-matching, or malformed
  boundary fails closed: the whole-rollout analysis runs and the setup observations count (regressions
  pin the unbounded-unqualified control, the scoped-qualified case, and the mismatched-session
  fail-closed case).

**Review round 5 refinements (`fixture-tested`, fifth plain review; 2 findings, 4 new tests, all RED
first):**

- **Interrupts are counted per supported statement, not per whole cell.** The extractor applied its
  anchored wrapper regex to the WHOLE cell body, so an interrupt inside a directive-prefixed or
  multi-statement cell was silently dropped from the count — a supported cell (exec_command followed
  by a collateral interrupt_agent) plus a separate exact-target interrupt reported `callCount: 1`,
  incorrectly satisfying the exactly-one-delivery exemption over a hidden collateral interruption.
  The extractor now extracts and counts interrupt statements with the SAME bounded per-statement
  parser the supported-call path uses (`parseCallStatements`), so directive-prefixed,
  multi-statement, and single-statement cells all contribute (each statement's target still goes
  through the id-shaped-or-suppressed sanitizer; a cell that fails the bounded parser contributes
  nothing here and still fails the whole case closed in the main scan). Regressions: the
  exec-then-collateral-interrupt cell plus a separate exact interrupt counts two deliveries and
  fails the exactly-one-delivery contract in the driver (`multiple-delivery-attempts-not-attributed`,
  no exemption), and a directive-prefixed interrupt cell counts.
- **Child settlement runs for EITHER gate/acknowledgement ordering.** The held-turn race only ran
  the background settlement phase when Root's acknowledgement won (`result` boundary); when the fake
  peer reached its gate FIRST (`held` boundary), the held branch never invoked
  `waitForChildSettlement` — it waited only for Root's result and the fake process's exit, neither
  of which establishes that the Child consumed its terminal observation, so evidence could be
  collected incompletely and the fixture disposed while the Child was still polling. The held branch
  now runs the SAME settlement lifecycle when a settlement watch is declared: after the gate release
  and Root's natural exit, the Child-settlement watch runs within the remaining budget, the cleanup
  label and `childSettlement` facts carry the measured outcome (observed/unobserved), and a budget
  expiry during the watch fails exactly like the acknowledgement-first ordering (regression: a
  gate-wins race with an observing watch records `child-settlement-observed` before disposal).

**Review round 6 refinements (`fixture-tested`, sixth plain review; 4 findings, 7 new tests — 4 RED
first, 3 controls pinning preserved fail-closed behavior; native shapes pinned at source `67727e7c`):**

- **The background no-join contract gates the settlement exemption.** A settled background
  acknowledgement dropped the early-exit inconclusive regardless of joins, so a supported rollout
  with `rootJoins: 1` (Root issuing a short `wait_agent` before its acknowledgement — explicitly
  forbidden by the background prompt) adjudicated `inconclusive: null`. The exemption now requires an
  observed ZERO join count: `rootJoins === 0` (a placement regression can never qualify; an
  unestablishable count — null, unidentifiable parent — fails closed the same way). The shared
  background mapping fixture now carries the no-join shape.
- **Native plain-text failure responses decode structurally.** The pinned host's
  `ToolRuntime::failure_response` (67727e7c, `tools/parallel.rs`) emits a tool rejection as
  `FunctionCallOutputBody::Text` — the bare message with `success: false` — never a JSON
  `{error:...}` object, so a real root/self/unknown-target rejection recorded `delivered: null` +
  `output-unparseable`. Only the KNOWN rejection kinds decode from a plain-text body of the last
  interrupt call (the pinned root/self messages and the `ThreadNotFound`-shaped unknown →
  `target-root`/`target-self`/`target-unknown`); any other plain text stays `output-unparseable`
  (fail closed), and the raw text never leaves the classifier (R0 discipline).
- **A wrapped interrupt's result is its OWN statement's output.** For a supported cell (exec_command
  followed by exactly one interrupt) the delivery decode took the FIRST JSON object in the cell body
  — the exec's result — reporting `delivered: null` even with a valid `{previous_status}` present.
  The registration now retains the interrupt statement's index and the cell's statement count, and a
  multi-statement cell resolves delivery from that statement's OWN result position (a
  missing/yielded own result stays unresolved); single-statement cells and direct calls keep the
  prior whole-body decode.
- **Tagged native AgentStatus values decode to their labels.** The pinned `AgentStatus` enum
  (67727e7c, protocol.rs, snake_case) serializes unit variants as strings and the payload variants
  as tagged single-key objects (`{completed: <final answer>}`, `{errored: <message>}`) — the
  string-only check misclassified these successful V2 responses as unparseable. The decode now
  accepts a tagged single-key object whose key is a pinned enum variant (`pending_init`, `running`,
  `interrupted`, `completed`, `errored`, `shutdown`, `not_found`), retains ONLY the status label,
  and suppresses the embedded message; a tagged key outside the pinned enum fails closed to
  `output-unparseable` (never decoded, content never retained).

**Review round 7 refinements (`fixture-tested`, seventh plain review; 4 findings, 7 new tests, all RED
first — plus three superseded prior-round expectations updated to the deliberate new semantics):**

- **The Status deadline trial has an observation-only lifecycle and result contract.** The background
  launch only RESERVES a queued job and neither it nor the Status query starts the fake peer, so the
  completion gate is never reachable and an ADHERENT Status trial was inherently inconclusive: the
  host's end classified as an early exit AND the configured success markers rejected the timeout
  output. The Status case now runs a dedicated lifecycle (`statusDeadlineFlow`): the host ending at
  the query deadline is the EXPECTED terminal — recorded as `statusDeadlineReached: true` with the
  dedicated `status-query-deadline` cleanup label (never the generic early exit) — and the observer
  accepts EITHER the rendered success markers OR the confirmed production `JOB_WAIT_TIMEOUT` framing
  (`publicResultAlternativeMarkers`: the pinned `"code":"JOB_WAIT_TIMEOUT"` / `"category":"timeout"`
  / `Timed out waiting for job ` envelope lines from `job-control.mjs` `waitTimeout` → `errorEnvelope`),
  recording which set matched (`resultMarkerSetMatched`). The queried-job fact reads the awaited ID
  from the confirmed deadline framing identically to the rendered `Job:` line (same 64-hex shape,
  same single-distinct rule), so the two-turn flow validation binds on a deadline outcome too. The
  job-continues-running assertions are untouched, and an output WITHOUT the confirmed framing fails
  closed (unqualified, never decoded as a deadline outcome).
- **Background placement holds for BOTH gate orderings.** The no-join + observed-settlement
  requirement was checked only inside the ended-before-gate branch, so a gate-wins background trial
  (Root incorrectly joining) with observed Child completion adjudicated `inconclusive: null`. The
  placement contract now runs for EVERY background trial regardless of which boundary won: zero
  Root joins AND an observed Child settlement, or a dedicated
  `the background placement contract failed: …` inconclusive reason.
- **Qualifying the interrupt case requires the pending-window exact delivery.** Ordinary terminal
  completion bypassed every interrupt-specific requirement: a model ignoring the interrupt
  instruction (attempted false / delivered null / missing-prerequisite) produced `inconclusive: null`
  from `completion.qualified` alone, and rejected/wrong-target/late deliveries passed the same route.
  Qualifying `rescue-interrupt` now requires ONE observed exact-target delivery during the confirmed
  pending window — the delivery-side contract of the exemption — even when terminal completion
  succeeds; every unmet delivery outcome keeps the trial inconclusive with its recorded reason
  (the missing-prerequisite investigated-surface text, the rejection kind, the unobserved outcome,
  `the delivery targeted another agent`, `multiple delivery attempts were recorded`, the unbound
  ordering, the missing pending window, or `the delivery followed the Child completion`).
- **String statuses are validated against the pinned enum.** An arbitrary string `previous_status`
  (e.g. a private-task canary) was accepted with only a shape check and persisted verbatim. Strings
  must now be members of the pinned `AgentStatus` enum set; unsupported strings leave the response
  `output-unparseable` with the content never retained. (Two prior fixtures used the non-enum
  `'succeeded'` label and were updated to the pinned `'completed'`.)

**Review round 8 refinements (`fixture-tested`, eighth plain review; 3 findings, 4 new tests, all RED
first):**

- **Fixture disposal is guaranteed across provenance collection.** Both record-building sites awaited
  `observerProvenance()` BEFORE disposal, so a mid-trial unreadable observer source rejected ahead of
  the cleanup path and left the isolated home, copied credentials, and private rollouts behind on
  BOTH the executed and the failed-record paths. The provenance read is now injected through the
  case dependencies and failure-tolerant: a rejection yields an explicit collection-failed
  provenance record (`revision: 'collection-failed'`, `digest: null` — never a fabricated value, the
  redacted message attached) and the failure is merged into the record's inconclusive reason
  (`the observer provenance could not be collected: …`), while the R0 disposal guarantee runs
  unconditionally on every path. Regressions: an executed trial and a failed trial with a rejecting
  provenance both dispose (`fixtureDisposed: true`), persist the failure reason, and carry the null
  digest.
- **The latency field carries the settlement attribution guards.** `deliveryToSettlementMs` measured
  from the LAST attempt whenever it was delivered to the exact target, even when the settlement
  itself was unattributable (multiple attempts) — an ambiguous delivery produced a responsiveness
  measurement. The field is now gated on `interruptSettled === true` (the delivery actually
  attributed as this Child's interruption), so ambiguous deliveries produce no measurement; the
  attributed single-delivery cases keep their recorded latency.
- **The reservation outcome drains the child's stdio before resolving.** The bounded
  protected-descriptor child spawn resolved its outcome on the child's `exit` event, but exit does
  not guarantee the parent drained the pipes — a child exiting mid-buffer yielded a truncated
  internal response and a SUCCESSFUL reservation was rejected as a missing/malformed
  acknowledgement. The exit path now waits (bounded at 1 s, well inside the child timeout) for every
  captured readable stream to end before constructing the outcome. The spawn primitive is exported
  as the instrument's own seam, and the regression drives a REAL child that writes a ~300 KB valid
  envelope to fd4 and exits immediately, asserting the full envelope is collected.

**Review round 9 refinements (`fixture-tested`, ninth plain review; 3 findings, 4 new tests, all RED
first):**

- **A poll's call-to-response interval is pending-state evidence.** The extractor recognized pending
  observations only from yielded output headers — but the candidate directive keeps a cell inside
  ONE long observation, so the poll's yield output may not exist yet when the interrupt lands. The
  exact-Child binding now carries each original-handle poll's CALL-TO-RESPONSE interval (call event
  index/timestamp, response event index/timestamp), and a poll whose call is recorded and whose
  response has not arrived at the interruption moment is an OUTSTANDING observation: the interrupt
  landing inside that interval observes the pending window (the interval anchor doubles as the
  pending interval's start), never misclassified as post-completion when a terminal output follows.
- **The drained reservation outcome is constructed AFTER drainage completes.** The round-8 fix
  waited for the captured streams to end but snapshotted the accumulators BEFORE the wait —
  drainage callbacks appended to the live strings while the outcome object held stale references,
  so bytes arriving after the child's exit event (an external fd writer) were lost. The outcome is
  now built INSIDE the final completion callback (`buildOutcome()` at each finish site), reading the
  live accumulators at completion time. The regression uses a REAL grandchild inheriting the child's
  fd4 (spawn accepts integer fds) and writing the second half ~300 ms after the child exited.
- **The drainage payload is generated inside the child.** The round-8 regression passed a >300 KiB
  expected envelope as a single argv element — on Linux (4 KiB pages, `MAX_ARG_STRLEN` 128 KiB) that
  spawn fails E2BIG before the drainage behavior is exercised. The child now receives a small size
  argument and generates the payload itself in bounded 64 KiB writes (head + pad + terminator),
  retaining the expected value only in the parent for comparison; a structure regression pins the
  size-argument form (no payload-sized argv).

**Review round 10 refinements (`fixture-tested`, tenth plain review; 3 findings, 4 new tests, RED
first — the P2-1 flip repro and the P2-3 leak delta are the genuinely RED pair; the P2-2 contract
test pins the deployed source shape):**

- **Event-index comparisons never cross rollout boundaries.** The round-9 poll-interval rule compared
  CHILD-rollout indices against `lastCall.index` — which belongs to the interrupt's OWN rollout
  (usually the Root's) — so appending unrelated Root events moved `lastCall.index` across the child's
  response index and FLIPPED `pendingBeforeCall.observed` on identical timestamps (reproduced: one
  unrelated Root diagnostic → observed, three → false), while an interrupt before the poll could be
  admitted by the same cross-rollout arithmetic. Both index comparisons are now guarded with rollout
  identity (`lastCall.rolloutIndex === binding.childRolloutIndex`); cross-rollout ordering is
  established by rollout timestamps exclusively.
- **The launch-failure record carries structural output facts only.** A failed Status setup turn
  embedded its stderr or JSONL stdout in the thrown error persisted with the failed record —
  `redactPrivatePaths` replaces paths and truncates but does not suppress private task, preparation,
  or echoed-assistant content. The failure message now retains ONLY the exit code, which stream
  carried output, and its byte size (`exit code N, stderr N bytes (content withheld)`) — the same R0
  suppression standard as every other excerpt path. The contract test pins the deployed source shape
  (the pre-fix raw-embedding form is gone; the canary never survives).
- **The drainage deadline releases the captured pipes.** When a descendant retains stdout/stderr/fd4
  past the child's exit, the drainage timer resolved the promise but left the captured streams OPEN
  — each held-descriptor run leaked one live pipe socket and kept the event loop alive past the
  advertised bound. The bound now DESTROYS the captured streams before resolving; the regression
  measures the per-run socket delta across two held-descriptor runs (pre-fix: +1 per run).

**Review round 11 refinements (`fixture-tested`, eleventh plain review; 2 findings, 5 new tests, all
RED first):**

- **Interruption evidence binds only to TERMINAL polls and their continuations.** The round-9
  attribution treated the ONE-SHOT PREPARATION WRITE like a poll: an interruption arriving while the
  preparation was awaiting its response mapped a preparation-only rollout (`pollCount: 0`) to
  `inconclusive: null` — claiming an interruption during a "pending observation" that exercised no
  long empty-input poll. The binding now EXCLUDES preparation writes (identified by
  `parsePreparationFrame` over the write's chars) and preparation continuations (accepted waits
  resolving a preparation-owned pending cell): a preparation-only rollout yields an empty
  attributable set → `orderingBound: false` → the trial stays inconclusive with its recorded reason.
  Regressions: an interrupt during the preparation write, during a preparation continuation, and the
  mapped preparation-only rollout all fail to bind.
- **The Status deadline outcome derives from the VERIFIED timeout result.** The round-7 deadline
  branch ran on the `result` boundary itself, so a host exiting early (an immediate command failure,
  exit 1) still recorded `statusDeadlineReached: true` / `endedBeforeGate: false` / cleanup
  `status-query-deadline` — false lifecycle facts surviving into the persisted record. The branch
  now VERIFIES the production framing first (exit 0 with every pinned
  `JOB_WAIT_TIMEOUT` marker in stdout): a verified expiry marks the deadline reached; any other
  outcome keeps the honest early-exit classification (`endedBeforeGate: true`, `early-exit`), and
  the observer's fail-closed framing check still rejects unconfirmable outputs at adjudication.
  Regression: an immediate nonzero exit in the Status flow keeps `early-exit` with
  `statusDeadlineReached` false.

**Review round 12 refinements (`fixture-tested`, twelfth plain review; 2 findings, 4 regressions,
3 RED first):**

- **Status deadline evidence is decoded from the host transport.** The live executor captures
  `codex exec --json` stdout as JSONL, whose string fields escape the Companion error's quotes.
  Deadline verification unwraps completed `item.completed` responses and rollout `payload`
  responses, accepts only `function_call_output` / `custom_tool_call_output` bodies, and uses the
  observer's existing `parseToolOutput` / direct-response decoder. Every pinned timeout marker must
  appear in one decoded command-output text or decoded Companion error envelope, with host exit 0,
  before recording `statusDeadlineReached` and `status-query-deadline` cleanup. Assistant echoes
  supply no evidence. Bare Companion stdout retains the direct marker check for non-JSON transport.
  Regressions cover escaped JSON response fields and the resulting deadline lifecycle.
- **Cross-rollout pending windows require affirmative response ordering.** Once the bound Child
  poll call is proven to precede the Root interrupt, an existing response must have a timestamp
  strictly later than the interrupt to establish the call-to-response pending window; an absent
  response (`responseIndex === null`) also establishes it. An existing untimed response leaves
  `pendingBeforeCall.observed: false` and its timing anchors null, preserving the recorded
  unconfirmed-pending-window reason. Same-rollout event-order logic is unchanged. Regressions cover
  the untimed completed response and a timestamp-proven response after the interrupt.

**Review round 13 refinements (`fixture-tested`, thirteenth plain review; 3 findings — the exec-item
schema decode landed first, the two remaining REDs were completed on takeover):**

- **The Status deadline evidence reads the REAL `codex exec --json` item schema.** The host transport
  wraps command results in `item.completed` envelopes whose `command_execution` items carry the
  command's output in `aggregated_output` (67727e7c, exec_events.rs `CommandExecutionItem`,
  snake_case) — the pinned timeout markers are validated against that decoded aggregated output
  beside the persisted-rollout output shapes, and the deadline lifecycle (`statusDeadlineReached`,
  `status-query-deadline` cleanup) verifies through the same decode. Regressions drive the realistic
  `command_execution` shape through both the evidence check and the held-host lifecycle.
- **An untimed continuation completion cannot confirm a cross-rollout pending window.** The
  call-to-response interval rule now tracks a yielded poll's CLOSING response — the first accepted
  continuation completion resolving the poll's cell — so the round-12 response-ordering rule applies
  to continuation-completed windows too: an existing UNTIMED closing response in a different rollout
  than the interrupt leaves `pendingBeforeCall.observed: false` (the window provably closed, but the
  closing moment is unprovable relative to the interruption), an ABSENT response stays an outstanding
  observation, and a timestamp-proven post-interrupt completion still establishes the window.
  Regressions cover the untimed continuation beside the round-9/10/12 in-interval, timestamp-flip,
  and untimed-direct-response cases.
- **Preparation ownership is tracked per STATEMENT.** A supported cell can carry the validated
  preparation write and the real empty-input poll as two statements of ONE event (both share the
  event's call id): the interruption binding keys preparation ownership by statement position within
  the cell, so only the preparation statement is preparation-owned and the poll statement keeps its
  normal poll semantics (attributable, interruption-binding, poll-counting). Surfacing that cell
  required one splitter correction with its own fail-closed rule: a blank line BETWEEN statements is
  separator formatting (the observed multi-statement cells separate the preparation write and the
  poll with an empty line), while a blank line AFTER the last statement is emitted content beyond
  the last parseable statement and still fails the cell closed — the trailing-blank and
  padded-cell boundary regressions keep their `unsupported-call-shape` verdicts. Regressions cover
  the shared cell end to end (main observer: 1 preparation + 1 poll + 0 violations; the unresponded
  poll leaves the window unestablished, not binding).
- Takeover hygiene: the predecessor's leftover debug instrumentation (binding stderr lines) and an
  orphaned duplicate of the deadline-evidence decoder were removed; the deployed decoder remains the
  driver's tested export.

Suite state after review round 13: `npm run test:shell-research` **371/371 pass, exit 0**
(367 prior + 4 new), selection 6/6, `npm run lint` clean, `npm run typecheck` clean,
`node scripts/check-line-endings.mjs` clean (533 files), `git diff --check` clean at worktree state
`docs/rescue-shell-long-wait` on top of `5026009`. All changes UNCOMMITTED.

**Review round 14 refinements (`fixture-tested`, fourteenth plain review; 2 findings, 7 new tests,
6 RED first):**

- **A later statement's start requires preceding-completion evidence (never the cell submission).**
  A supported cell can await the validated preparation write and THEN issue the real empty-input
  poll; the rollout records one timestamp for the whole cell's SUBMISSION, so anchoring the later
  poll's pending-window interval at that timestamp reported a confirmed pending observation while
  the preparation was still pending. The interruption binding now anchors a later statement's
  interval start at the cell's own response event and ONLY when that response evidences the
  preceding awaited statements' completed results (`precedingStatementsCompleted` over the shared
  per-statement decoder); without that evidence (no response, untimed response across rollouts) the
  later poll's start and ordering stay UNKNOWN — `pendingBeforeCall.observed: false`, no anchor, and
  the interrupt case keeps its inconclusive reason. First-statement polls keep the submission anchor
  (the round-9 in-interval semantics are unchanged). The driver's poll-start watch
  (`waitForPollObservation`) applies the same rule: a later empty-input statement of a shared cell
  is detected only when the cell's response evidences the preceding completions, so
  `pollStartedAtElapsedMs` can no longer be recorded from a bare submission. Regressions cover the
  untimed yield, the missing response, the timestamp-proven yield (anchored at the response, never
  the submission), the mapping inconclusive, and both watch directions.
- **The hold continues independently of a winning acknowledgement.** The background lifecycle's
  acknowledgement-first branch released the completion gate immediately — before `holdMs` — so the
  gate-dependent fake worker could complete at once and a default 120-second background trial could
  qualify Child settlement without exercising the intended long observation (the gate-first ordering
  held it for the requested duration, making the experiment scheduling-dependent). The branch now
  runs the same held phase as the gate-first ordering: the hold deadline is recorded, the turn waits
  out `holdMs` (budget expiry during the hold is budget cleanup), the gate releases only after the
  hold, and the Child-settlement watch runs as usual within the remaining budget. Regression: with
  `holdMs: 5000` and the acknowledgement winning the race, the gate release is asserted at or after
  the recorded hold deadline on one injected clock (pre-fix the branch released immediately and
  recorded no hold deadline).

Suite state after review round 14: `npm run test:shell-research` **378/378 pass, exit 0**
(371 prior + 7 new), selection 6/6, `npm run lint` clean, `npm run typecheck` clean,
`node scripts/check-line-endings.mjs` clean (533 files), `git diff --check` clean at worktree state
`docs/rescue-shell-long-wait` on top of `5026009`. All changes UNCOMMITTED.

**Review round 15 refinements (`fixture-tested`, fifteenth plain review; 3 findings, 6 new tests,
all RED first):**

- **A wrapped interrupt anchors at its OWN execution boundary, never the cell submission.** An
  interrupt following another awaited statement of a shared cell inherited the whole cell's
  SUBMISSION timestamp, so a Child that completed mid-cell could be reported as a pending-window
  delivery with settlement timing and `inconclusive: null` for an already-completed Child. The
  interrupt statement now starts UNPROVEN (`atMs: null`) when it is a later statement of its cell,
  and its boundary is anchored ONLY by the cell's own response event when that response evidences
  the preceding awaited statements' completed results (the round-14 `precedingStatementsCompleted`
  machinery) AND carries a timestamp; otherwise the ordering stays unproven — all stamped ordering
  relations stay null and the case keeps its honest inconclusive reason. Single-statement and
  first-statement interrupts keep the submission anchor. Regressions cover the boundary anchor
  (response timestamp, not submission), the unproven variant, and the end-to-end mapping (the
  mid-cell Child completion now classifies the delivery post-completion: `settled: null`, no
  pending interval, inconclusive retained).
- **The hold starts at worker READINESS, not at the acknowledgement.** The background
  acknowledgement-first branch started `holdMs` at the acknowledgement, so a delayed fake worker
  received less than the requested hold and the completion gate could even open before the worker
  started. The branch now awaits the worker's gate-reached marker first (under the same budget
  race — budget expiry during the wait is budget cleanup) and only then runs the full hold and
  releases the gate. Regression: a gate-reached marker resolving long after both the
  acknowledgement and the pre-fix hold must be observed before the release; the two superseded
  round-5 fixtures and the round-14 hold fixture now resolve readiness after the acknowledgement
  (the corrected lifecycle).
- **One experiment budget across both Status turns.** The query turn was launched with a FRESH
  full `budgetMs` timeout even after the budget expired during the awaited setup turn or rollout
  loading, and `runHeldHostTurn` installed its budget-abort listener only after the launch closure
  returned — missing an already-fired abort. The budget-abort outcome is now installed BEFORE the
  launch closure runs, the launch closure receives the SHARED experiment cancellation signal and
  the remaining deadline, every turn's timeout is that remaining deadline (never a fresh full
  budget), the turn controllers propagate the budget abort, and the executor refuses to resume the
  query turn after expiry (fail closed). Regressions: a budget that expires mid-launch is budget
  cleanup (never an early exit) with the shared signal observed aborted and the remaining deadline
  at zero, plus a source-contract test pinning the deployed wiring.

Suite state after review round 15: `npm run test:shell-research` **384/384 pass, exit 0**
(378 prior + 6 new), selection 6/6, `npm run lint` clean, `npm run typecheck` clean,
`node scripts/check-line-endings.mjs` clean (533 files), `git diff --check` clean at worktree state
`docs/rescue-shell-long-wait` on top of `5026009`. All changes UNCOMMITTED.

**Review round 16 refinements (`fixture-tested`, sixteenth plain review; 2 findings, 6 new tests,
5 RED first + 1 control):**

- **Shared-cell interrupt timing is bounded, never exact.** Round 15's response-event anchor made
  the cell response timestamp the interrupt statement's execution time — but that timestamp ALSO
  covers any statements AFTER the interrupt, so a cell that interrupts at 7 s and then awaits a
  command until 17 s (Child finishing at 12 s) was falsely recorded post-completion (the opposite
  error of round 15's). A later-statement interrupt now records EXECUTION-TIME BOUNDS —
  `callNotBeforeMs` (the cell submission) and `callNotAfterMs` (the completion-evidencing cell
  response) — with the exact `callAtMs` UNKNOWN. Ordering claims use the bounds conservatively: a
  pending window is observed only when it provably SPANS the whole bounds (the pending observation
  before `notBefore` and every resolution at/after `notAfter`); a completion inside the bounds
  overlaps the possible execution window and claims neither window nor post-completion; a
  completion provably before `notBefore` remains honestly post-completion, and one provably after
  `notAfter` remains an honest post-delivery latency. Regressions cover the overlap (unproven,
  never post-completion — at the interaction level and through the mapping), the spanned window
  (observed stands), and the provably-before completion.
- **A malformed poll response is never an absent response.** A poll whose response was OBSERVED
  but is unparseable (malformed body, missing or ambiguous per-statement results) previously kept
  a null response boundary and was treated like an outstanding request: a poll submitted at 10 s
  with a malformed response at 11 s falsely established a pending window for an interrupt at 12 s.
  Such intervals are now UNESTABLISHED (the poll yields no pending-window claim, and the interrupt
  exemption cannot qualify them); only a genuinely ABSENT response remains an outstanding
  observation. Regressions cover the interaction (observed false with the binding still exact) and
  the mapping (no pending interval; inconclusive retained).

Suite state after review round 16: `npm run test:shell-research` **390/390 pass, exit 0**
(384 prior + 6 new), selection 6/6, `npm run lint` clean, `npm run typecheck` clean,
`node scripts/check-line-endings.mjs` clean (533 files), `git diff --check` clean at worktree state
`docs/rescue-shell-long-wait` on top of `5026009`. All changes UNCOMMITTED.

**Review round 17 refinements (`fixture-tested`, seventeenth plain review; 3 findings, 5 new tests,
all RED first):**

- **Both Status-flow prompts parse through the REAL production parsers.** The prompts carried their
  explanatory prose AFTER the skill invocation, and the production recorded-invocation parser
  tokenizes everything after the marker: the launch prompt rendered `ARGUMENT_INVALID: Review does
  not accept focus text` (review rejects any positional), and the rendered Status query prompt
  produced `ARGUMENT_INVALID: Duplicate flag: --timeout-ms` (its prose itself names the flag).
  Neither turn could execute as intended. All explanation now PRECEDES the invocation; the marker
  line ends the prompt carrying only the real arguments (`$zcode:review --background`;
  `$zcode:status <owned-job-id> --wait --timeout-ms <ms>`). Both prompts are tested through
  `parseRecordedInvocation` AND `parseArgs` (the real production parsers): the launch argv is
  exactly `['review', '--background']` (execution `background`), the query argv exactly
  `['status', <id>, '--wait', '--timeout-ms', '<ms>']` with the owned job positional.
- **The Status deadline is honored when the worker gate wins the boundary race.** Production
  `invoke review --background` starts a real background worker, so the worker gate can win the
  race while the query turn has already finished at its deadline — the held-worker branch ran the
  full hold and a completed timeout response was ignored until budget cleanup (10 ms query result
  + 200 ms hold + 80 ms budget reproduced it). The held phase now races the query result: a
  VERIFIED production JOB_WAIT_TIMEOUT framing ends the turn at the query deadline exactly like
  the acknowledgement-first ordering (`statusDeadlineReached`, `status-query-deadline`,
  `endedBeforeGate: false`, budget never consumed); an early UNVERIFIED result leaves the held
  lifecycle unchanged (the settled result is re-awaitable at the post-hold join, so no outcome is
  lost). Regression drives the repro shape end to end.
- **Bounds ordering applies to OUTSTANDING poll intervals too.** For a bounded shared-cell
  interrupt (`callAtMs` deliberately unknown), the interval rule skipped every cross-rollout
  OUTSTANDING poll even when its call-to-response interval provably spanned both bounds — a valid
  pending-window interruption was rejected. The interval rule now orders bounded interrupts
  against the bounds: a poll issued at/before `notBefore` whose interval spans the whole bounds
  (genuinely no closing response, or a closing response at/after `notAfter`) observes the window
  anchored at the poll call; a closing response inside the bounds overlaps the possible execution
  window (unproven); one at/before `notBefore` closed the window before the earliest execution; an
  untimed closing cross-rollout response stays unproven (round-12 rule). Regressions cover the
  spanning interval at the interaction level (observed, anchored at the poll call) and through the
  mapping (the exemption qualifies: `inconclusive: null`).

Suite state after review round 17: `npm run test:shell-research` **395/395 pass, exit 0**
(390 prior + 5 new), selection 6/6, `npm run lint` clean, `npm run typecheck` clean,
`node scripts/check-line-endings.mjs` clean (533 files), `git diff --check` clean at worktree state
`docs/rescue-shell-long-wait` on top of `5026009`. All changes UNCOMMITTED.

**Review round 18 refinements (`fixture-tested`, eighteenth plain review; 3 findings, 5 new tests,
4 RED first + 1 control):**

- **Budget cancellation stays effective during held Status races.** Once the query result had
  settled and been consumed (unverified), it won every subsequent hold race instantly — a
  microtask busy loop that starved the budget timer and accumulated one pending sleep per
  iteration (150 ms hold + 50 ms budget finished with `budgetExpired: false`). After the first
  consumption the held phase awaits only real ticks, so the budget signal cancels the hold
  normally (budget cleanup, never a fabricated observation).
- **A successful observed Root acknowledgement is required before background placement qualifies —
  on BOTH orderings.** A Root that FAILED after spawning its Child (exit 1, no acknowledgement
  output) while the Child completed without joins was treated as a settled background
  acknowledgement (`inconclusive: null`). The placement contract now requires exit 0 AND the
  reserved-job acknowledgement output (`Reserved background job …`) in addition to zero joins and
  observed Child settlement — in the settled-acknowledgement exemption (acknowledgement-first
  ordering) and in the every-ordering placement-contract check (gate-first ordering), with the
  missing-acknowledgement cause recorded. Child completion alone never establishes the
  acknowledgement contract. Regression covers both orderings plus the successful-acknowledgement
  control; the three superseded background mapping fixtures now carry the acknowledgement output.
- **The Root acknowledgement timestamp is the result-resolution time.** When the worker gate won
  the race, Root could acknowledge DURING the hold, but the timestamp was assigned only after
  hold + gate release + natural worker exit (an acknowledgement at ~11 ms recorded at ~151 ms) —
  conflating Root acknowledgement with Child completion. A resolution watcher now stamps
  `rootAcknowledgementAtElapsedMs` the moment the Root result resolves (never before the launch;
  a rejecting result carries no acknowledgement), and the downstream fallback assignments only
  fill a still-null value. Regression: a ~10 ms acknowledgement during a 150 ms hold is recorded
  before the hold deadline.

Suite state after review round 18: `npm run test:shell-research` **400/400 pass, exit 0**
(395 prior + 5 new), selection 6/6, `npm run lint` clean, `npm run typecheck` clean,
`node scripts/check-line-endings.mjs` clean (533 files), `git diff --check` clean at worktree state
`docs/rescue-shell-long-wait` on top of `5026009`. All changes UNCOMMITTED.

**Review round 19 refinements (`fixture-tested`, nineteenth plain review; 3 findings, 6 new tests,
5 RED first + 1 control):**

- **The background acknowledgement validates the launched-Child contract, never a job
  reservation.** Round 18's check required the `Reserved background job …` render — but for a
  compliant Host-background run the prompt and skills/rescue/SKILL.md's background branch are
  explicit that Root acknowledges ONLY that the Host child was LAUNCHED ("a bounded
  acknowledgement claiming only that the Host child was launched — never that Companion work was
  queued, accepted, started, or completed"); the reservation wording belongs only to the R3
  status flow (a different case). The validator now requires exit 0 AND the launched-child
  acknowledgement, in BOTH the settled-acknowledgement exemption and the placement contract.
  Regressions: the launched-child acknowledgement qualifies (inconclusive null); the
  reservation-only wording is the WRONG contract and fails through the placement contract's
  acknowledgement cause (gate-first ordering). The round-18 fixtures and tests now carry the
  launched-Child wording.
- **Child settlement resolves from the LINKED statement's own output.** In a supported cell with
  an original-handle poll followed by another command, all statements share the call id and the
  whole-body decode selects the LAST JSON — a still-running poll followed by an unrelated command
  made the settlement watch report Child settlement from that command's exit code, ending the
  background lifecycle before the Child observation settled. The settlement watch now tracks each
  linked call id's statement position and decodes the poll/continuation's OWN result through the
  round-6 statement-correlation machinery (new shared `statementOutputAt` decoder). Regressions:
  the unrelated command's exit code never settles (abort-bounded negative); the linked poll's own
  completed result settles.
- **A shared call id is attributable only after the poll's execution is established.** The
  interruption binding admitted the cell's call id BEFORE checking whether the preparation
  completed: a cell still yielding its preparation (pending header, no completed prefix) attributed
  its pending header to an UNEXECUTED poll and fabricated a pending window (timestamped repro:
  observed true + pending interval although the terminal observation never started). Admission is
  now positional-execution evidence: with the cell response OBSERVED, the poll is attributable only
  when the preceding awaited statements each carry a completed result (a positional completed-count
  check — the strict whole-list decode would also reject a contradictory-shape yield's EXECUTION
  evidence); with the response genuinely ABSENT the poll stays attributable (round-14) but its
  start stays unanchored and no interval is pushed. Regressions: the preparation-pending yield
  binds nothing (`orderingBound: false`, no pending interval, inconclusive retained).

Suite state after review round 19: `npm run test:shell-research` **406/406 pass, exit 0**
(400 prior + 6 new), selection 6/6, `npm run lint` clean, `npm run typecheck` clean,
`node scripts/check-line-endings.mjs` clean (533 files), `git diff --check` clean at worktree state
`docs/rescue-shell-long-wait` on top of `5026009`. All changes UNCOMMITTED.

**Review round 20 refinements (`fixture-tested`, twentieth plain review; 2 findings, 7 new tests,
5 RED first + 2 controls):**

- **The background acknowledgement is validated on the DECODED final Root reply, never raw stdout
  occurrences.** With `codex exec --json` the stdout stream interleaves command telemetry with the
  final reply, so the round-19 substring search accepted a stdout containing `echo launched` even
  when the final reply acknowledged a queued job, and also accepted "The child was NOT launched."
  The validator now decodes the final agent reply through the observer's own final-agent-message
  machinery and validates the launched-Child contract against THAT text: exit 0, a non-empty final
  reply carrying the launched claim, and NO negated launch claim (`not launched`). Regressions:
  telemetry-only `launched` and the negated reply each keep the trial inconclusive through the
  placement contract's acknowledgement cause; a decoded reply claiming the launch qualifies
  (control). The superseded background mapping fixtures now carry the final agent reply in their
  rollouts.
- **Terminal observed Child statuses are excluded from interrupt qualification.** When the V2
  delivery returns `previous_status` `completed` (payload variant), `shutdown`, or `not_found`
  (unit variants of the pinned AgentStatus enum, 67727e7c), tool success does NOT establish
  interruption of an active turn — interrupt_spawned_agent explicitly succeeds for dead/unloaded
  runtimes, and a previously yielded cell can remain pending after its Child turn ends. A terminal
  previous status now blocks both the completion exemption and the delivery contract, is recorded
  in the interrupt facts (`previousStatusTerminal`), keeps the trial inconclusive with the honest
  reason ("the interrupt landed on an already-terminal Child"), and never receives settlement or a
  surviving-turn claim (`previous-status-terminal-no-interruption-claim`). Regressions cover all
  three terminal statuses end to end; the `running` control keeps the qualifying shape.

Suite state after review round 20: `npm run test:shell-research` **413/413 pass, exit 0**
(406 prior + 7 new), selection 6/6, `npm run lint` clean, `npm run typecheck` clean,
`node scripts/check-line-endings.mjs` clean (533 files), `git diff --check` clean at worktree state
`docs/rescue-shell-long-wait` on top of `5026009`. All changes UNCOMMITTED.

**Review round 21 refinements (`fixture-tested`, twenty-first plain review; 2 findings, 4 new tests,
2 RED first + 2 controls):**

- **The acknowledgement is read from the PARENT rollout, order-independently.**
  `extractFinalAgentMessage` over ALL collected rollouts returns the LAST message, so a parent
  rollout collected BEFORE the Child rollout yielded the Child's sentinel as the "final reply" — a
  valid background run with zero joins and observed Child settlement became inconclusive merely
  because the Child's sentinel lacks "launched", and reversing the same rollout arrays made it
  qualify (order-dependent verdicts). The mapping now selects the rollout identified by the
  linkage facts' `parentThreadId` BEFORE extracting the acknowledgement, and an unidentifiable
  parent rollout fails closed (no acknowledgement). Regressions: both array orders produce the
  same qualifying verdict, and a parent rollout whose reply negates the launch stays
  unacknowledged in both orders (the Child sentinel can never smuggle an acknowledgement from
  another rollout). The background mapping fixtures now carry the parent session meta in their
  reply rollouts.
- **`errored` previous statuses are terminal.** The pinned `agent/status.rs::is_final()` includes
  `Errored`: an already-FAILED Child is exactly as non-interruptible as a completed one. With
  `previous_status: {errored: …}` the terminal guard previously classified the Child as
  nonterminal and the mapper could record `turn-interrupted-pending-observation-survives` with
  `inconclusive: null` — falsely qualifying an active-turn interruption while a yielded shell
  observation remained pending. `errored` is now in the terminal guard. Regression: the errored
  variant keeps the honest inconclusive reason ("already-terminal"), `settled: null`, the
  `previous-status-terminal` basis, and `previousStatusTerminal: true`.

Suite state after review round 21: `npm run test:shell-research` **417/417 pass, exit 0**
(413 prior + 4 new), selection 6/6, `npm run lint` clean, `npm run typecheck` clean,
`node scripts/check-line-endings.mjs` clean (533 files), `git diff --check` clean at worktree state
`docs/rescue-shell-long-wait` on top of `5026009`. All changes UNCOMMITTED.

**Review round 22 refinements (`fixture-tested`, twenty-second plain review; 2 findings, 4 new tests,
3 RED first + 1 control):**

- **An already-interrupted previous status never qualifies an active-turn interruption.** The
  pinned enum's `Interrupted` variant is an ALREADY-INTERRUPTED turn: another `interrupt_agent`
  call can succeed for it without interrupting an active turn, and its resumability does not
  establish active execution. `interrupted` now joins the non-active exclusion set — V2
  interruption qualification requires an ACTIVE previous status — and the honest inconclusive
  reason is generalized accordingly ("the interrupt landed on a Child whose observed previous
  status is not an active turn (terminal or already interrupted)"). Regression: the interrupted
  variant keeps the trial inconclusive, `settled: null`, the terminal-basis label, and
  `previousStatusTerminal: true`.
- **The background acknowledgement must be POSITIVE and LAUNCH-ONLY.** The round-20 decoded-reply
  check still accepted replies whose `/launched/` substring was negated ("The Host child was never
  launched.") and replies carrying FORBIDDEN work-status claims ("…launched and Companion work was
  accepted and started."). The decoded final reply must now affirmatively claim the launch
  (`\blaunched\b`), contain NO negated launch (`not|never [been] launched`), and contain NO
  work-status claims (`queued`/`accepted`/`started`/`completed` — the SKILL.md contract wording);
  unsupported or contradictory replies stay inconclusive through the placement contract's
  acknowledgement cause. Regressions cover both reproduced replies plus the compliant positive
  control.

Suite state after review round 22: `npm run test:shell-research` **421/421 pass, exit 0**
(417 prior + 4 new), selection 6/6, `npm run lint` clean, `npm run typecheck` clean,
`node scripts/check-line-endings.mjs` clean (533 files), `git diff --check` clean at worktree state
`docs/rescue-shell-long-wait` on top of `5026009`. All changes UNCOMMITTED.

**Review round 23 refinements (`fixture-tested`, twenty-third plain review; 1 finding, 3 new tests,
2 RED first + 1 control):**

- **The affirmative launch claim must match a SUPPORTED statement shape.** The round-22 word
  search (`\blaunched\b`) still accepted contraction negations ("The Host Rescue child wasn't
  launched.") and hypotheticals ("Only one child should be launched.") — both reproduced
  `inconclusive: null` with otherwise-qualified background facts. The decoded final reply must now
  match a SUPPORTED affirmative launch statement shape anchored to the SKILL.md background
  branch's affirmative production phrasing ("the Host child was launched"; the observed
  "the Host Rescue child was launched" variant), with the auxiliaries was/is/has been — and the
  explicit rejections remain as defense in depth: negations (`not`/`never [been] launched`),
  contractions (`n't … launched`, covering wasn't/won't/isn't), hypotheticals
  (`should/would/could/must/shall/may/might/will [be] launched`), and work-status claims
  (`queued`/`accepted`/`started`/`completed`). Anything not matching the supported affirmative
  shapes fails closed. Regressions: both reproduced replies keep the trial inconclusive through
  the placement contract's acknowledgement cause; the supported affirmative statement qualifies
  (control).

Suite state after review round 23: `npm run test:shell-research` **424/424 pass, exit 0**
(421 prior + 3 new), selection 6/6, `npm run lint` clean, `npm run typecheck` clean,
`node scripts/check-line-endings.mjs` clean (533 files), `git diff --check` clean at worktree state
`docs/rescue-shell-long-wait` on top of `5026009`. All changes UNCOMMITTED.

**Review round 24 refinements (`fixture-tested`, twenty-fourth plain review; 1 finding, 2 new tests,
2 RED first):**

- **Interrupt ordering is bound to the poll statement's own result.** In a supported cell with an
  original-handle poll followed by another command, all statements share one call id while the
  attributable set bound the ENTIRE cell and `parseToolOutput` decoded the whole body — selecting
  the LAST JSON result, so a still-running poll followed by `exec_command('true')` recorded that
  UNRELATED command's exit as the Child's `completedAfterCall`/`completedBeforeCall` (completion
  validation rejects the extra command, but the interrupt facts still reported the wrong ordering
  for the failed trial). The binding now preserves each attributable call id's statement position
  (`attributableStatements`: call id → statement index/count, recorded for polls and linked
  continuations on admission), and the interaction scan decodes the LINKED statement's own output
  through the round-19 `statementOutputAt` machinery — exactly as the Child-settlement watch
  already does. Regressions: an unrelated command exit AFTER the interrupt never records a
  post-delivery completion latency, and one BEFORE the interrupt never records a pre-delivery
  completion (`sameRolloutCompletedBeforeCall` stays the honest computed negative).

Suite state after review round 24: `npm run test:shell-research` **426/426 pass, exit 0**
(424 prior + 2 new), selection 6/6, `npm run lint` clean, `npm run typecheck` clean,
`node scripts/check-line-endings.mjs` clean (533 files), `git diff --check` clean at worktree state
`docs/rescue-shell-long-wait` on top of `5026009`. All changes UNCOMMITTED.

**Review round 25 refinements (`fixture-tested`, twenty-fifth plain review; 3 findings, 4 new tests,
3 RED first + 1 control):**

- **The affirmative acknowledgement must be a COMPLETE supported sentence.** The round-23 shapes
  were unanchored substring expressions: "I cannot confirm that the Host Rescue child was
  launched." matched and passed the rejection checks — producing `inconclusive: null` despite NOT
  acknowledging the launch (the phrase embedded in uncertain prose). The supported shapes now
  anchor to STATEMENT START (`^the Host [Rescue ]child was/is/has been launched`); an uncertain,
  quoted, or otherwise unsupported reply fails closed. Regression: the cannot-confirm repro keeps
  the trial inconclusive through the placement contract's acknowledgement cause; the complete
  supported sentence qualifies (control).
- **Survival attribution requires a CONFIRMED pending window.** An exact-target interrupt that
  PRECEDED the first poll left a subsequently yielded poll reaching the survival branch — the
  record claimed `settled: false` + `turn-interrupted-pending-observation-survives` although that
  observation never existed at interruption time (the overall inconclusive verdict does not
  correct false outcome facts). The surviving-turn outcome now requires
  `pendingBeforeCall.observed === true`; without the confirmed window the settlement outcome stays
  UNKNOWN (`settled: null`, `settlement-unavailable`). Regression: an interrupt at 03 s before a
  poll yielded at 09 s records no pending interval, unknown settlement, and the honest basis.
- **The caller pipe (fd3) is destroyed when the reservation spawn finishes.** `callerPipe.end()`
  closes only the writable half: on POSIX a descendant inheriting fd3 kept the parent-side socket
  active beyond the timeout, and a long-lived descriptor holder could prevent probe exit
  indefinitely. `finish` now destroys fd3 alongside the other owned streams. Regression: two runs
  whose child spawns a detached fd3-holding descendant leave no socket delta (settle-bounded
  sampling; the pre-fix descendant keeps the socket alive indefinitely).

Suite state after review round 25: `npm run test:shell-research` **430/430 pass, exit 0**
(426 prior + 4 new), selection 6/6, `npm run lint` clean, `npm run typecheck` clean,
`node scripts/check-line-endings.mjs` clean (533 files), `git diff --check` clean at worktree state
`docs/rescue-shell-long-wait` on top of `5026009`. All changes UNCOMMITTED.

**Review round 26 refinements (`fixture-tested`, twenty-sixth plain review; 2 findings, 4 new tests,
2 RED first):**

- **Unparseable continuation responses BLOCK pending-window qualification.** If a linked wait
  received an OBSERVED but UNPARSEABLE response before `interrupt_agent`, the binding ignored that
  response and left the original poll interval OPEN — in-memory replay reported
  `pendingBeforeCall.observed: true` + pending-observation-survived + `inconclusive: null`,
  although the continuation could already have completed or terminated the cell. The binding now
  records the closing boundary for an observed-but-unreadable continuation response (never
  treating it as an absent response — the round-12/13 guards then keep the window unestablished
  unless that arrival is provable), and the interaction scan records such a linked response as
  `unparseable` bound evidence that BLOCKS the pending-window checks: after an unparseable
  response the window's resolution state is UNKNOWN — never observed, never resolved.
  Regressions: the unparseable-continuation repro keeps the interaction unobserved and the mapping
  inconclusive with no pending interval.
- **Exited and running process statuses are mutually exclusive.** A native header carrying BOTH
  `Process exited with code 0` AND `Process running with session ID 5` passed the cardinality
  guard (neither field repeats) and decoded BOTH fields — a poll carrying the expected sentinel
  then produced `completion.qualified: true` despite the CONTRADICTORY process status.
  `decodeDirectResponse` now fails the decode closed when the header combines exited and running
  statuses, so mixed responses can never supply terminal-completion evidence. Regressions: the
  mixed header decodes to null, and a mixed-header poll carrying the sentinel never qualifies
  completion.

Suite state after review round 26: `npm run test:shell-research` **434/434 pass, exit 0**
(430 prior + 4 new), selection 6/6, `npm run lint` clean, `npm run typecheck` clean,
`node scripts/check-line-endings.mjs` clean (533 files), `git diff --check` clean at worktree state
`docs/rescue-shell-long-wait` on top of `5026009`. All changes UNCOMMITTED.

**Review round 27 refinements (`fixture-tested`, twenty-seventh plain review; 1 finding, 1 new test,
1 RED first):**

- **Unreadable post-interrupt continuation responses block the interruption exemption.** When a
  yielded poll is interrupted successfully (running) and its linked wait SUBSEQUENTLY returns an
  unparseable response, the exemption accepted the trial (`inconclusive: null`) and reported
  `settled: false` + `turn-interrupted-pending-observation-survives` — but the unreadable response
  could itself represent COMPLETION or TERMINATION, so survival is unknown. The extractor now
  exposes `unparseableBoundResponses` (observed linked responses that fail their own statement
  decode), and the driver treats any such response as BLOCKING evidence BEFORE applying the
  interruption exemption: the exemption and the delivery contract require no unreadable
  continuation response, the failure reason records "an unreadable continuation response left the
  settlement outcome unknown", and the settled chain attributes an explicit UNKNOWN settlement
  (`settled: null`, `unparseable-continuation-settlement-unknown`) before any completion or
  surviving-turn claim. The fact is recorded in the interrupt facts
  (`unreadableContinuationObserved`). Regression: the interrupted-then-unparseable-wait repro
  keeps the trial inconclusive with the unknown settlement.

Suite state after review round 27: `npm run test:shell-research` **435/435 pass, exit 0**
(434 prior + 1 new), selection 6/6, `npm run lint` clean, `npm run typecheck` clean,
`node scripts/check-line-endings.mjs` clean (533 files), `git diff --check` clean at worktree state
`docs/rescue-shell-long-wait` on top of `5026009`. All changes UNCOMMITTED.

**Review round 28 refinements (`fixture-tested`, twenty-eighth plain review; 1 finding, 3 new tests,
2 RED first + 1 preserved-rule control):**

- **The observer digest binds to the executing revision.** Provenance was collected only after the
  case finished: if either observer module was EDITED during a long-running trial, the hash
  reflected the UPDATED filesystem contents while Node continued executing the modules loaded at
  startup — records could attribute their evidence to an observer revision that never adjudicated
  it. `runShellWaitCase` now captures the digest at CASE START (after fixture creation, before any
  observation — the cleanest seam with the existing injectable `observerProvenance` dependency,
  with the fixture available for redaction), and the record-time read is RECONCILED against it
  (round-29 refinement: the case-start capture is the MODULE-INIT snapshot of the executing
  source threaded from `evidence.mjs` — an edit during the AWAITED fixture build/install can no
  longer slip into the attribution, since the snapshot was taken before the build ran):
  the record attributes the run to the case-start revision, and a mid-run source change is
  RECORDED as an explicit fact (`sourcesChangedDuringRun: true` with the `recordTimeDigest`) instead
  of silently attributing the run to newer bytes. The R8 rules hold on every path: any read failure
  (case-start or record-time) keeps the null digest, the `collection-failed` revision, and the
  redacted failure merged into the inconclusive reason. The `ShellWaitObserverProvenance` typedef
  gained `sourcesChangedDuringRun`/`recordTimeDigest`. Regressions use the round-8 harness with a
  count-recording injected reader: a mid-run digest change attributes digest A and records the
  change with the record-time digest B; a case-start read failure keeps the collection-failed
  provenance; a record-time read failure fails closed (null digest, never a partial attribution).
  §12.5's digest description and its self-review deferral note were updated (the deferred
  case-start snapshot hardening is now implemented).

Suite state after review round 28: `npm run test:shell-research` **438/438 pass, exit 0**
(435 prior + 3 new), selection 6/6, `npm run lint` clean, `npm run typecheck` clean,
`node scripts/check-line-endings.mjs` clean (533 files), `git diff --check` clean at worktree state
`docs/rescue-shell-long-wait` on top of `5026009`. All changes UNCOMMITTED.

**Root Status-observation cancellation (separate interaction, fixture-tested through production):** using
R3's production reservation machinery, the REAL `runCompanion(['status', <ownedJobId>, '--wait',
'--timeout-ms', …])` is cancelled mid-flight through the wait's own external observation signal. The wait
ends with the abort reason (never its query deadline, never `JOB_WAIT_TIMEOUT`), and BOTH held jobs — the
observed one and an UNRELATED harmless job reserved by a second owning session in its own workspace
(production admits one active writable Rescue job per workspace) — stay `queued` in the production state
store with NO `stopIntent`. Ending the observation therefore causes no job stop/cancel request. This is
instrument-level evidence about the production wait boundary (there is no model-facing self-interrupt
surface to wire); it establishes none of Child interruption or Root joins, which remain distinct.

Suite state after R4: `npm run test:shell-research` 291/291 (277 prior + 14 new R4), selection 6/6, lint,
typecheck, line-ending and `git diff --check` gates green at worktree state
`docs/rescue-shell-long-wait` on top of `5026009`.

### 12.9 R5 campaign instrument facts: per-record observer digests and the driver defaults fix (2026-10-08)

§7.7/§9.4 record the R5 measured outcomes; this subsection records the instrument facts, which are
`fixture-tested` claims about how the records were produced.

- **Per-record observer digests, including a mid-campaign change.** Every R5 record carries
  `provenance.observer = { revision: 'working-tree-uncommitted', digest, digestInput }` (§12.5). The
  eight trials from the M run through `status-wait` carry digest `27bc1715…`; the two `r5c` root-family
  trials carry `cd41ef07…` because the driver defaults fix below changed `driver.mjs` bytes between the
  runs. Both digests are honest provenance, not a defect; the fixture's installed source (`5026009`) is
  unaffected by any of it.
- **Driver defaults bug found and fixed during R5.** `shellWaitCaseDefaults` grouped
  review-wait/adversarial-review-wait/status-wait and defaulted `statusQueryTimeoutMs: 240000` onto all
  three, while `validateCaseInput` correctly refuses `statusQueryTimeoutMs` for every non-Status case —
  so `review-wait` and `adversarial-review-wait` could not be invoked at all (every attempt failed the
  case-input gate before any fixture was created; their early output directories are empty, §7.7). The
  fix splits the shared defaults so only `status-wait` carries the field, with a regression test
  asserting: review/adversarial parse without the flag and with `statusQueryTimeoutMs === undefined`,
  still refuse an explicit `--status-query-timeout-ms`, and `status-wait` keeps 240000 rendered verbatim.
  RED 1/1 (parsed default was 240000) before, GREEN after; the `--status-query-timeout-ms` mis-issue
  attempts were the fail-closed validation working as designed. This was an instrument defect that
  BLOCKED trials — it is not host behavior and qualifies nothing.
- **Instrument behavior observed across the R5 records.** The four unclassified-cell rescue records
  (baseline/noise/background/interrupt) each retained exactly one `unsupported-call-shape` excerpt whose
  content is fully suppressed (structural classification, line count, byte length only) — the R0
  suppression held on every unclassified body with zero private content in any R5 excerpt. The
  `status-wait` run exercised the R3 fail-closed flow validation end to end (`validation.valid: false`
  with the explicit reason, never a guessed target). The two `r5c` runs exercised the R2 Root-mode
  adjudication live for the first time (root-thread binding, Root-handle cadence, the narrower
  renderer-marker check). The R4 interrupt wiring recorded the requested intent fail-closed
  (`requested: true`, `family: "v2"`, delivery `null` with the explicit missing-prerequisite reason)
  when evidence collection did not complete.
- **R5-close gates at the uncommitted working tree of `5026009`**: `npm run test:shell-research`
  **293/293 pass, exit 0**, selection 6/6, `npm run lint` clean, `npm run typecheck` clean,
  `node scripts/check-line-endings.mjs` clean, `git diff --check` clean. The clean-tree routine/marketplace
  `npm test` check did NOT run (requires commit authorization or the spec §2 park-and-restore method;
  §11.3).

### 12.10 What this instrument deliberately does NOT claim

- No live Codex trial ran during Task 3. Task 4 installed observations are in §7. Every live-run path requires
  `ZCODE_SHELL_WAIT_E2E=1`; fixture regression results above remain instrument correctness, not host behavior.
- The driver's default live executor (per-case Root prompts, gate files, rollout collection, evidence mapping) is
  implemented and exercised by Task 4 within §7's limited scope; the observed legal preparation shape with its
  optional `yield_time_ms` argument is the sanctioned supported preparation (§12.5), while every other
  unsupported call shape and baseline continuation still fails closed. Task 4 surfaced the bounded corrections recorded in §12.4. Its observation poll retries a bounded number of consecutive transient rollout
  read/parse failures of an actively appended rollout instead of aborting the held turn; the final post-run load
  keeps its own distinguished, private-path-scrubbed failure reason.
- The unraised-default cap M remains unmeasured after Task 4. Named Child candidate behavior and fixture
  artifact hashes are recorded in §7; these do not prove an effective Child cap or generic delivery. The
  stored rendered Role hash is fixture provenance, not a runtime introspection of the Child config.
- The historical Task 5 `rescue-interrupt` run (§8.1) recorded `delivered: null` with the then-current
  prerequisite note; since R4 the record carries either measured interaction facts or an explicit
  investigated reason (§12.8), and no run shape — past or future — can be counted as interruption evidence
  without a delivered exact-target interaction.
- The fixture's hook-trust/approval bypass and credential copy are fixture controls inside the disposable
  temporary root. They are not persisted production-trust qualification and authorize nothing outside the run.
- The `review-wait`, `adversarial-review-wait`, `status-wait`, and `background` case prompts approximate
  the installed Skill entry points; Task 6 pins their exact live command surfaces before any Root-command
  conclusion. (R2 added the exact rendered-command contract, the candidate-policy delivery seam and the
  command-specific renderer markers, §12.6; the R5 root runs used them, §9.4 — the command
  qualifications themselves remain `not-proven`.)

## 13. Follow-up campaign Task 1: provenance re-pin and measurement-seam verification (2026-10-13; no live run)

Task 1 of the follow-up plan
[2026-10-13-rescue-shell-wait-follow-up](../superpowers/plans/2026-10-13-rescue-shell-wait-follow-up.md):
verification and documentation only. No live host was launched, no instrument code changed, and no new
installed behavior is claimed anywhere in this section. The re-pinned provenance is §1.2.3; the plan
required §§7.7, 10, 11.2 and 12.8 to be read before any of this work, and they were.

### 13.1 Already-repaired seam regressions (re-run before authentication)

The plan's Task 1 regression selection — the R4-era review-round corrections ("review adjudication
fixes" and rounds 2–3), native interrupt interaction recording, the root-family observer contract, and
the unsupported-call/final-message preparation privacy set — all pass at the re-pinned pin, zero
failures as the plan expects:

| Command | Result |
| --- | --- |
| `node --test --test-name-pattern='review adjudication fixes\|review round 2 refinements\|review round 3 refinements\|native interrupt interaction recording\|root-family observer contract\|unsupported-call and final-message preparation privacy' tests/shell-wait-probe.test.mjs` | **79 tests / 79 pass / 0 fail / 0 skipped** (6 suites: R0 canaries, R2 root-family observer contract, R4 interrupt recording, and the three R4+ review-round suites) |
| `node --test tests/test-selection.test.mjs` | **6 tests / 6 pass / 0 fail / 0 skipped** |

The fail-closed boundaries the plan calls out are unchanged and pinned by these suites: `pollWallTimesMs`
covers individual polls only (a sanctioned preparation continuation contributes no duration; a
shared-cell wall time is not a cap duration), and the Root-control wrapper recognition
(`interrupt_agent`/`send_input` as root-control calls) stays forbidden inside the identified Child
rollout, where those calls still count as discipline violations.

### 13.2 How a nonterminal poll's own timing links to the live original process, pending cell and eventual exit

Survey result for the plan's named functions (`mapShellWaitLiveFacts`, `extractInterruptInteraction`,
`analyzeCallSequence`, `waitForPollObservation`, `waitForChildSettlementObservation` and their tests):
the linkage is complete with the EXISTING seams. No new API is required, and no instrument defect was
demonstrated, so no code changed. This is the reading rule Tasks 2–3 adjudication uses.

1. **One original handle, grounded independently on three surfaces.** Post-run, `analyzeCallSequence`
   grounds `originalHandleId` from the exact launcher `exec_command`'s own completed output
   (`launch.output.result.session_id`, `tools/shell-wait-probe/evidence.mjs`, `analyzeCallSequence`
   opening), and every poll is a `write_stdin` to that id. Live, both watches re-ground the SAME id
   from the launch's own response decoded at its statement position (`waitForPollObservation` and
   `waitForChildSettlementObservation`, `tools/shell-wait-probe/driver.mjs` — `statementOutputAt` for
   shared cells) and fire only on empty-input polls to THAT handle. The interrupt ordering binding
   (`deriveChildObservationBinding`, `evidence.mjs`) reuses the sequence machinery so only that
   handle's polls and accepted `wait` continuations are attributable ordering evidence
   (`attributableCallIds`/`attributableStatements`/`pollIntervals`).
2. **A poll's own duration exists only when its OWN response completes.** `analyzeCallSequence` pushes
   the output's tool-reported wall-time header onto `pollWallTimesMs` at its event position when a poll
   is answered by its own completed output (`null` when no trusted header), and marks the terminal from
   that result's `exit_code` (`terminalIndex`). A poll that YIELDS instead opens the event-order
   `pendingCell` (cell id + owning call id) and contributes no timing; if an accepted `wait`
   continuation with the exact canonical `cell_id` resolves the cell, the poll's entry stays `null` —
   the continuation's header measures the wait request, never the poll (§12.8 round 3), and the
   preparation exemption keeps the array 1:1 with actual polls. The cap-limited return — a poll whose
   own completed response carries a still-running result and no exit code — is therefore a numeric
   `pollWallTimesMs` entry at its event position, while the eventual exit is the entry whose result
   carries the exit code (or, when the terminal resolves through a continuation,
   `decisiveWallMs = sequence.lastCompletedOnHandle.wallTimeMs`).
3. **Identification convention in the persisted record (documented; no new field).** The record
   retains `observations.pollWallTimesMs` in event order beside `decisiveWallMs` and the timeline facts
   (`buildCaseRecord`). The terminal entry is the LAST poll-owned completed response (its header equals
   `decisiveWallMs` when the terminal was poll-owned; a continuation-resolved terminal leaves its array
   entry `null` while `decisiveWallMs` carries the header). Every EARLIER numeric entry is a
   nonterminal original-handle return — the M candidate — attributable only with the linked return
   shape: `remainingLifetimeMs > 0` on basis `hold-deadline-at-poll-start` (the worker's hold deadline
   had not passed at the poll-start detection), no interrupt intent/outcome
   (`interrupt.requested`/`delivered` null or false), cleanup label `observation` (no other ender), and
   the worker still running. Missing fields stay `null` on every path (the pre-turn failure branch maps
   every observation field to `null`).
4. **The live remaining-lifetime arithmetic is measured, never derived from wall times.**
   `runHeldHostTurn` records `timeline.holdDeadlineElapsedMs` from the absolute monotonic hold
   deadline; the concurrent poll-start watch stamps `timeline.pollStartedAtElapsedMs` only for a
   detection at or before that deadline on one clock (§12.8 round 7); `mapShellWaitLiveFacts` computes
   `remainingLifetimeMs = holdDeadlineElapsedMs − pollStartedAtElapsedMs` with basis
   `hold-deadline-at-poll-start` — a conservative lower bound (detection lags the true poll start).
   The §6.2 validity precondition compares ACROSS the two comparable runs: `M + 30000 ≤
   remainingLifetimeMs`, where `M` is the UNRAISED control run's attributable cap-return duration
   (identified per the point-3 convention from the unraised run's own record) and `remainingLifetimeMs`
   is the RAISED trial's `hold-deadline-at-poll-start` measurement at its decisive poll start. The
   historical §12.8/§6.2 formula `firstPollMs + 30000 ≤ remainingLifetimeMs` names the same UNRAISED
   measurement — in the unraised M trial the cap return was expected to be that run's first poll — and
   never substitutes the raised trial's first `pollWallTimesMs` entry (which in a natural-completion
   raised shape is the raised terminal duration, not a cap; using it would wrongly reject valid
   discriminator trials). The first-poll-stamp caveat applies ONLY to the lifetime measurement:
   `timeline.pollStartedAtElapsedMs` is stamped ONCE, by the first-poll watch
   (`waitForPollObservation` returns on the first empty-input poll to the exact handle), so in a
   multi-poll raised shape the recorded remaining lifetime is measured at the first poll's detection and
   could overstate the lifetime at a later decisive poll — a later-decisive-poll shape therefore leaves
   the precondition UNEVALUABLE from the record.
5. **Pending-cell and eventual-exit linkage for interruption adjudication (feeds Task 3).**
   `extractInterruptInteraction` binds ordering to the exact Child: `boundObservations` carry each
   bound response's resolution kind (`pending` / `completed-exit` / `completed-running` /
   `unparseable`) — a still-running nonterminal completion RESOLVES a historical pending header — and
   an outstanding poll's call-to-response interval (`binding.pollIntervals`, `callAtMs`/`responseAtMs`)
   is pending-state evidence. `pendingBeforeCall.atMs` anchors `interrupt.pendingIntervalMs`, and
   `deliveryToSettlementMs`/`timingBasis` (`rollout-event-timestamps`) are attributed only for a
   settled exact-target delivery. The live settlement watch resolves only through the launch handle's
   own polls/linked continuations decoding a completed exit-code result at the linked statement's own
   position (`basis: 'exact-launch-handle-linked-completed-exit-code-output'`).

### 13.3 Research note: per-entry resolution labels beside `pollWallTimesMs` (optional hardening; NOT implemented, NOT needed)

One seam candidate surfaced during the survey and was investigated to a "not needed" verdict.
`pollWallTimesMs` carries durations only — no per-entry resolution kind or event index — so identifying
which entry is the cap-limited return relies on the §13.2 positional convention (terminal = the entry
matching `decisiveWallMs` / the last poll-owned completed response; earlier numeric entries =
nonterminal returns). For the plan's adjudication shapes this is unambiguous: the M trial expects at
most one nonterminal cap return plus one terminal poll (or a continuation-resolved terminal), and event
order preserves relative position even with multiple nonterminal returns. No attribution gap exists, so
per the plan's bounded-execution rule no code changed. Should a future measured shape ever make the
positional convention insufficient, the minimal research-only seam would be a PARALLEL array, never a
reinterpretation of `pollWallTimesMs` itself — e.g. `observations.pollResolutionKinds`
(`'completed-running' | 'completed-exit' | 'continuation-resolved' | 'preparation'`) pushed at exactly
the same sites that push to `pollWallTimesMs` (`analyzeCallSequence`, the own-response branch and the
continuation-resolution branch), asserted 1:1 by a regression extending the existing round-2/3 timing
fixtures in `tests/shell-wait-probe.test.mjs` with one nonterminal return plus one terminal poll.
Recorded here so Tasks 2–3 adjudication documents its reading rule instead of assuming one.

### 13.4 Follow-up campaign Task 2: M measurement and cap-discriminator adjudication on one comparable host (2026-10-13, installed 0.162.1) — all four live runs inconclusive on the recurring unclassified-cell family; M `not-proven` on this pin

Task 2 executed the follow-up plan's four listed live runs on ONE pinned executable, exactly one run per
listed case label/group, no cause-directed follow-up consumed anywhere (see the allowance ledger below).
Every run: fixture installed from committed source `3fa035a9eed568d163f6057fbf26623d3adc84a7` (worktree
HEAD at execution, clean tree), the pinned executable in both `--codex` and `CODEX_BINARY`, fresh private
`mktemp -d` output (OS-temporary; only redacted/whitelisted facts are repeated here), and the per-record
observer digest recomputed at case start — every record carries `e28ec619…` (`working-tree-uncommitted`,
`sourcesChangedDuringRun: false`), matching §1.2.3. The pin was re-verified (`realpath` of `command -v
codex` → the 0.162.1 standalone binary, `codex-cli 0.162.1`, worktree HEAD, clean tree) immediately before
EVERY run; the pin never changed, so all four records share one comparable pin. Driver exit 0 in all four
runs means execution/cleanup completed — it does NOT mean any case qualified.

Per-run provenance (the fields §1.2.3 defined as "captured at first live run"): `codexVersion` 0.162.1 in
all four records; the executing model is retained as `null` — the instrument cannot observe it and never
infers it from hashes (§1.2.3); the observation-cap key's verified application facts are
`requestedCapMs` + `isolatedSetup.capVerified` (run 1: `requestedCapMs: null`, unraised control — no cap
verification applies; runs 2–4: `requestedCapMs: 3600000`, `capVerified: true` — the raised cap verifiably
survived the isolated production setup's configuration writes; this is fixture-configuration retention,
NOT propagation evidence); wait bounds `requestedPollMs`/`requestedWorkerDurationMs`/`requestedBudgetMs`
as listed per run; `roleStatus: "ready"`, `setupAttempts: 2` (the fixture's documented normal data-root
bootstrap re-run — documented in the fixture source, the `tools/shell-wait-probe/fixture.mjs` bootstrap
re-run comment), `fixtureVariant` candidate/candidate/candidate/baseline; instruction artifacts carry
before/after sha256 + mode per record (baseline run: before == after on both artifacts, byte-identical
as designed).

| Run | Case and flags | Retained record digest (sha256; private OS-temp dir) | Outcome |
| --- | --- | --- | --- |
| 1 — UNRAISED M control | `rescue-long`, NO `--cap-ms`, worker 420000, poll 3600000, budget 1200000 | `8df4026ff0b95fcdaa28beadfb805302c5bc8d9adb582d4c0b4fdbda1efa4620` (`…/tmp.a4Da3YEWp1`) | `executed`, **inconclusive `unsupported-call-shape`**: one unclassified `exec_command` script cell (3 content lines, 443 bytes, `directivePresent: false`, content withheld by the R0 structural-suppression design) failed the whole-case fail-closed scan. Route/linkage/observations all `null`; M **not established** |
| 2 — RAISED candidate | `rescue-long --cap-ms 3600000`, worker 420000, poll 3600000, budget 1200000 | `befd4e76c2b46afd9b13aa427253011eb23f5ff38c36801db9a09d3fd3af3b05` (`…/tmp.rixDv8c4uN`) | `executed`, **inconclusive `unsupported-call-shape`**: same family, DIFFERENT shape facts (2 lines, 246 bytes, no directive). `capVerified: true`. All attributable observations `null` |
| 3 — repeat | `rescue-repeat`, same raised flags/worker/budget as run 2 | `43b9496f10c71db2ed99c610f2932ac23e8e933f9709b9926e5d6a711c43ded6` (`…/tmp.h8sQOMlOjU`) | `executed`, **inconclusive `unsupported-call-shape`**: same family again (4 lines, 336 bytes, no directive). `capVerified: true`. All attributable observations `null` |
| 4 — baseline instruction control | `rescue-baseline --cap-ms 3600000 --poll-ms 60000`, worker 420000, budget 1200000 (baseline variant: artifacts byte-identical) | `341a26890a54d42b5274a0f263ef4d8894db6c60989654c874a877025b2dce78` (`…/tmp.pUvpLEtU8T`) | `executed`, **inconclusive `unsupported-call-shape`**: same family (3 lines, 443 bytes — same shape facts as run 1). `capVerified: true`. All attributable observations `null`; outer-re-entry counts UNKNOWN, never zero |

Facts that ARE attributable in every run (all four): the live flow demonstrably progressed — the driver's
held-turn watch detected the observation (40018/62640/47451/53056 ms) and the first empty-input poll on
the original handle (77372/95631/82659/85479 ms, basis `held-turn-monotonic-elapsed-ms`), the turn ended
naturally at the hold gate (`cleanupLabel: "observation"`, `gateReleased: true`, `endedBeforeGate: false`),
host exit 0, cleanup complete with 0 errors, fixture disposed; `interrupt.requested: false` everywhere.
Facts that are NOT attributable anywhere: route actually selected, parent/Child linkage, companion
launch/send, `originalHandleChecked`, `outerReturns`/`modelCalls`/`rootJoins`, `decisiveWallMs`,
**`pollWallTimesMs` (no per-poll timings exist in any record)**, `remainingLifetimeMs`, sentinel/terminal
checks — each `null` with the recorded fail-closed cause, never zero.

**Adjudications.**

- **M (unraised Child cap on 0.162.1): `not-proven`.** The §13.2 point-3 convention has nothing to
  attribute: no nonterminal original-handle return is observable because the whole-case fail-closed scan
  blocks every record at the first unclassified cell, so no `pollWallTimesMs` entry, no linked return
  shape, and no cap-limited return exists. M is not even bounded on this pin. The R5 0.161.0
  bounded-but-imprecise state (§7.7) stands for that version only.
- **Raised-run precondition: UNEVALUABLE.** The §13.2 point-4 arithmetic needs M (unattributable) AND the
  raised trial's `hold-deadline-at-poll-start` `remainingLifetimeMs` at its decisive poll start — the
  raised run retains no attributable decisive poll at all, so neither side of `M + 30000 ≤
  remainingLifetimeMs` exists. The first-poll-stamp caveat never came into play.
- **Raised-cap propagation on 0.162.1: `not-proven` — the campaign does not even reach
  `POSITIVE-but-M-imprecise` on this pin.** No raised observation shape is attributable (no single long
  observation, no re-entry counts), so there is no positive discriminator signal here. The 0.161.0
  POSITIVE-but-M-imprecise clue (§7.7/§10) stands unchanged for that pin.
- **Repeat on 0.162.1: not executable as designed — no qualified raised run exists on this pin to
  repeat.** The executed `rescue-repeat` run (run 3) is itself inconclusive with the same cause. Repeat
  remains QUALIFIED only on 0.161.0 (§7.7); the 0.160.1 attempts (§7.4) remain historical.
- **Baseline/re-entry comparison on 0.162.1: inconclusive.** Runs 2 and 4 differ in instruction variant
  and poll request exactly as designed, but no outer-return count is attributable in either, so the
  current-version re-entry comparison could not be established. Unknown linkage/counts stay unknown, not
  zero. The Task 4-era 15-vs-0 comparison remains pinned to its own recorded versions.
- **Cause adjudication of the blocker (the only cause-directed investigation, performed on retained
  records — no host was relaunched for it):** the `unsupported-call-shape` family recurred in 4/4 runs,
  across BOTH instruction variants (run 4 rules out candidate-paragraph linkage), with VARYING shape
  facts (3 lines/443 B, 2/246, 4/336, 3/443 — the last identical to the first), always an
  `exec_command` `custom_tool_call` with no directive and withheld content. This is the same
  unknown-shape family R5 recorded for baseline/noise/background/interrupt on 0.161.0 (§7.7, cause not
  established there either), now systematic on 0.162.1 and instruction-independent. The retained
  structural facts cannot adjudicate WHY the cells fail classification: content is withheld by the R0
  privacy design (§12.4, §12.10 — working exactly as documented), and no additional live diagnostic is
  permitted (every case's one-run allowance is spent; a fresh diagnostic would count against it).

**Instrument defect: none demonstrated — no code changed.** The fail-closed scan, structural excerpt
retention and privacy suppression behaved exactly as documented and test-pinned (§12.4/§12.10, §13.1);
what is not demonstrable is that the parser SHOULD have accepted the withheld cell shapes (no byte-level
evidence can exist under the retention design), so the plan's defect path (regression RED → minimal
correction) has no demonstrated trigger. The grammar limitation is real and is now the campaign's
blocking prerequisite: any future measured dimension on this pin needs the narrow unclassified-cell
adjudication the follow-up plan reserves to Task 4's bounded-diagnostic allowance, extended to the
rescue-family cases it now blocks. Per §3 the recurring unknown shape is retained and every case stops
here; no generic parser expansion was attempted.

**Run/follow-up allowance ledger.** `rescue-long` comparable group: BOTH planned runs consumed (unraised
control + raised candidate), both inconclusive; the group's one cause-directed follow-up was NOT consumed
— no concrete cause with a single changeable variable exists (the blocker is instruction-independent and
shape-variable; no case flag governs it; a re-run would be a forbidden model-behavior retry; the §6.2
resized-group remediation targets lifetime sizing, which is not the observed cause, and its
`workerDurationMs = max(420000, ceil(M) + 90000)` formula has no input while M is unattributable).
`rescue-repeat`: one run consumed, inconclusive, no follow-up (same cause). `rescue-baseline`: one run
consumed, inconclusive, no follow-up (same cause). No other host was launched.

### 13.5 Follow-up campaign Task 3: native pending-observation interruption and owned settlement (2026-10-13, installed 0.162.1) — one run, again inconclusive on the unclassified-cell family; the delivery contract and every settlement layer `not-proven` on this pin

Task 3 executed its single listed live run plus the two no-launch work items (delivery-path trace and
strict adjudication). No cause-directed follow-up was consumed, the optional responsiveness control was
NOT spent, and no code changed (no instrument defect demonstrated — see the defect note below).

**Delivery-path trace (no host launched).** Re-confirmed against the read-only Codex source checkout,
unchanged and clean at `67727e7cf114cf3e1b71db368d74b24e32f6cb12` (`git rev-parse HEAD` + `git status
--short` re-run 2026-10-13; the checkout still proves no source/binary correspondence). The concrete
mechanism the repaired case uses is the historical V2 hypothesis, confirmed at the pin:

1. **Registration in the owning session.** `codex-rs/core/src/tools/spec_plan.rs`:
   `add_collaboration_tools` (:1299) registers the V2 `interrupt_agent` tool UNCONDITIONALLY inside the
   V2 branch (it is gated by neither `wait_agent_enabled` nor `disable_direct_message`; :1382–1391),
   whenever `collab_tools_enabled` (:672) holds — for V2 that is
   `session_source.get_agent_path().is_none() || model_info.multi_agent_version == Some(V2)`, so the
   ROOT of a normal `codex exec` session (the owning Root of the Rescue Child) qualifies.
   `config.multi_agent_version_override()` (`core/src/config/mod.rs` :1592) hard-resolves V2 when
   `features.multi_agent_v2` is enabled (the live user config's block, §3.3 — authorship not
   established); in the fixture's isolated home (which carries only the production setup's
   `[agents.zcode-rescue]` role and hook writes, never a `features.multi_agent_v2.enabled` block —
   `scripts/lib/managed-agent-role.mjs` :132/:296/:727) the version can still resolve V2 through the
   model catalog declaration (`multi_agent_version_for_model` :1612; §3.3's `codex debug models`
   corroboration). The qualified live `wait_agent` joins recorded since R5 (§7.7) corroborate that the
   fixture's owning sessions resolve the V2 family in practice.
2. **Exact tool/flag the repaired case sends.** The case prompt (`SHELL_WAIT_CASE_SPECS['rescue-interrupt']`,
   `tools/shell-wait-probe/driver.mjs`) directs exactly ONE model-facing V2 `interrupt_agent` call with
   `{ "target": <the exact agent id the spawn acknowledgement returned> }`, only while the observation is
   pending, with collateral interruption forbidden. Source spec (`multi_agents_spec.rs` :355
   `create_interrupt_agent_tool_v2`): `ToolSpec::Function`, name `interrupt_agent`, single required
   `target` argument. The legacy V1 `send_input` is recognized ONLY with `{interrupt: true}` (V1 is not
   the resolved family on this machine, §3.3, and was not used); no separate app-server `turn/interrupt`
   was touched.
3. **Delivery and status semantics.** `core/src/tools/handlers/multi_agents_v2/interrupt_agent.rs`:
   handler `ToolName::plain("interrupt_agent")`, args `{target}` (`deny_unknown_fields`), resolves the
   target then calls `agent_control.interrupt(session.thread_id, AgentTarget::Id, V2)` →
   `interrupt_spawned_agent` (`core/src/agent/control/interrupt.rs`): registry-known check, root and
   self rejection, status SNAPSHOT FIRST (`inspect_agent` — the returned `previous_status` is the status
   observed before the interrupt request was handled), then `Op::Interrupt` to the live Child thread
   (`core/src/agent/control.rs` :299), tolerating `ThreadNotFound`/`InternalAgentDied` as success;
   returns `{ previous_status }` (pinned snake_case `AgentStatus`, protocol.rs — `running` is the
   ACTIVE label; `completed`/`errored`/`shutdown`/`not_found`/`interrupted` are the terminal set the
   driver pins at `TERMINAL_INTERRUPT_PREVIOUS_STATUSES`).
4. **Inner settlement is NOT part of the delivery.** `core/src/tasks/mod.rs` :925–936: the turn-abort
   path cancels nested code-mode cells only under `TurnAbortReason::Interrupted` AND
   `Feature::CodeModeInterrupt` — installed `code_mode_interrupt false` (§3.3) — so an exact-Child turn
   interruption guarantees nothing about an already-yielded poll cell. Companion-process cleanup and
   durable job/reconciler settlement are separate production layers entirely.
5. **Installed 0.162.1 rollout grammar (probe parsers).** `tools/shell-wait-probe/evidence.mjs`
   recognizes the interaction in TWO shapes: a direct `function_call` named `interrupt_agent`
   (dotted namespaces tolerated) with JSON args, and a code-mode cell statement in the anchored awaited
   form `text(await tools.interrupt_agent({...}));` (bounded per-statement parser, ≤4096-char body,
   JSON-first with a string-aware JS-literal fallback; the unanchored-substring false-attempt hole is
   closed, §12.8). The run below is itself the installed-grammar datum: the 0.162.1 host emitted a
   recognizable V2 interaction that the parsers counted (once), family-classified (`v2`) and
   success-decoded — the record does not retain which event shape carried it (not a persisted field).

**Re-pin before the run.** `realpath` of `command -v codex` →
`/Users/zhangzikai/.codex/packages/standalone/releases/0.162.1-aarch64-apple-darwin/bin/codex` (regular
executable), `codex --version` → `codex-cli 0.162.1` — IDENTICAL to §1.2.3/§13.4; the pin did not move,
so this run stays on the Task 2 comparable pin and cross-version comparison rules are unchanged.
Worktree HEAD `67d327d7fd206bd2fb87245b6d720d29d73e4924`, clean tree.

**The run (exactly one).** `rescue-interrupt` with the plan's exact flags (worker 420000, cap 3600000,
poll 3600000, budget 900000), the pinned executable in both `--codex` and `CODEX_BINARY`, fixture
installed from committed source `67d327d7…` (clean tree, committed bytes = working tree), fresh private
`mktemp -d` output — retained record sha256
`592675051bd0f87147531d798bc2084b6a2b7772fbfb3022cbc94c8db8ba706a` (`…/tmp.iX0612W7DO`, OS-temporary
private dir, the §13.4 per-run convention) — observer digest recomputed at case start `e28ec619…`
(`working-tree-uncommitted`, `sourcesChangedDuringRun: false`, `model: null`) — matching §1.2.3.
Per-run provenance per the Task 1 schema: `codexVersion` "0.162.1", `requestedCapMs` 3600000 with
`isolatedSetup.capVerified: true` (fixture-configuration retention, NOT propagation evidence),
`requestedPollMs`/`requestedWorkerDurationMs`/`requestedBudgetMs` as listed, `roleStatus: "ready"`,
`setupAttempts: 2` (the fixture's documented normal bootstrap re-run), `fixtureVariant: "candidate"`,
instruction artifacts with before/after sha256 + mode retained in the record. Driver exit 0 —
execution/cleanup completed (`fixtureDisposed: true`, `cleanupComplete: true`, 0 errors, no budget
kill, no external termination: `verifiedTerminated`/`codexTerminated` both false), which does NOT mean
the case qualified.

**Outcome: `executed`, INCONCLUSIVE `unsupported-call-shape` — the same recurring family as §13.4, new
shape facts.** The whole-case fail-closed scan blocked on one unclassified `exec_command` script cell
(3 content lines, **314 bytes**, `directivePresent: false`, content withheld by the R0
structural-suppression design — §13.4's runs: 443/246/336/443 bytes). Whether that cell is a parser gap
or a model departure remains unestablishable from withheld content. Driver-watch timeline (monotonic,
NOT rollout-attributable): observation detected at 50121 ms, Root host result resolved at 72767 ms,
turn ended naturally at the hold gate (`endedAtElapsedMs: 470128`, `holdDeadlineElapsedMs: 470121`,
`gateReleased: true`, `endedBeforeGate: false`, cleanup label `observation`), host exit 0.

**The interrupt block: degraded nulls with cause, PLUS surviving structural facts that advance the
campaign.** Because the case evidence failed fail-closed, the driver persisted the could-not-observe
form (`attempted: null`, `delivered: null`, the explicit evidence-collection `missingPrerequisite`;
`driver.mjs`'s evidence-failed branch overrides these two fields) — the nulls are a DEGRADED-RECORD
consequence, not an observed "no call". The fields the override does not touch record what the
extractor actually parsed from the collected rollouts:

| Field | Persisted value | Reading |
| --- | --- | --- |
| `requested` | `true` | case directive active |
| `callCount` | `1` | exactly ONE interrupt-shaped interaction existed |
| `family` | `"v2"` | the V2 `interrupt_agent` grammar (V1 would need `{interrupt:true}`) |
| `previousStatus` | `"running"` | the call's own output success-decoded to the PINNED ACTIVE AgentStatus label — the target agent was mid-turn when the interrupt landed (tool-acknowledgement level only) |
| `target` | `{ kind: "unknown", value: null, suppressed: true, chars: 23 }` | the target string was NEITHER id-shaped NOR the known fixture task marker → suppressed to its structural length (23 chars) by the R0 sanitizer; WHAT it named is not retained |
| `exactTargetMatch` | `null` | unbindable: the target is suppressed AND the case evidence carried no child thread id to bind against |
| `orderingBound` | `false` | no supported evidence → no exact-Child binding options → fail-closed ordering |
| `settled` / `settledBasis` | `null` / `"ordering-unbound-not-attributed"` | the basis is itself proof the underlying interaction was attempted with a non-rejected outcome, then failed the ordering gate |
| `pendingIntervalMs` / `deliveryToSettlementMs` / `timingBasis` | `null` / `null` / `"unavailable"` | no attributable pending anchor, no attributable settlement, no rollout-event timing |

This is the first run with a PARSED AND COUNTED V2 interrupt interaction (`callCount: 1`, target-shape
facts retained) under the §12.8-corrected anchored grammar, and the first on this pin (0.162.1). The
novelty is scoped, not absolute: the R5 0.161.0 record had ALREADY retained a parsed on-script
interaction with the same active `previousStatus: "running"` and `family: "v2"` (§7.7), but that parse
ran under the since-corrected unanchored grammar (§12.8 — a shape that could fabricate attempts);
§7.7's retained R5 row lists no count or target-shape facts (the row's basis: the record itself is
gone, so absence is verifiable only from the retained row, never from the artifact), and its case
failed the whole-case scan; §13.4's four runs all
had no interrupt interaction at all. The model demonstrably ANSWERED the interrupt directive with
exactly one V2 call whose tool response reported an active (`running`) previous status. It still
qualifies nothing.

**Adjudication (strict, per the plan's qualification rule).** NOT QUALIFIED — `attempted`/`delivered`
are null-with-cause in the persisted record, `exactTargetMatch: null`, `callCount: 1` (the only field
on its side of the contract), `orderingBound: false`, `settled: null`, `settledBasis:
"ordering-unbound-not-attributed"`, all timing null. There is no ONE exact-target delivery, no active
prior status bound to the EXACT Child (`previousStatus: "running"` attributes an active turn to the
UNNAMED target only), no attributable pending original-handle observation at delivery, and no linked
post-delivery outcome. Terminal-before-interrupt, wrong target, multiple delivery, unreadable
continuation and external budget kill did not arise; the case is inconclusive on the fail-closed scan,
which never qualifies.

**The four distinctions the plan requires (all `not-proven` on this pin).**

- **Native Child turn interruption (exact): `not-proven`.** A successful interrupt TOOL response alone
  proves none of the layers below, and here even the tool response is unbound: the target was withheld
  (23 suppressed chars) and the ordering was never bound to the exact Child's pending observation.
- **Inner poll-cell settlement: `not-proven`.** No attributable observation exists (`pollWallTimesMs`
  null), no settlement watch fact is attributable, `settled: null`. Whether an interrupted turn left
  the pending poll alive is UNADJUDICABLE in this record — `orderingBound: false` means the
  `turn-interrupted-pending-observation-survives` shape could not even be evaluated, let alone
  recorded as observed.
- **Exact Companion process cleanup: `not-proven`.** No companion launch/send/handle linkage survived
  the fail-closed scan (all null); `child.settlement.observed: false` with basis null.
- **Durable job/reconciler settlement: `not-proven`.** The bounded production-store read was NOT
  exercised: with every linkage field null there was no attributable original job, stop cause/intent or
  terminal winner to read through the existing seams, and no accepted running work became untracked.
  Nothing sanitized existed to retain.

**Distinction ledger demanded by the plan.** Missing model call: RULED OUT (callCount 1 — the model
called). Tool rejection: RULED OUT (the response success-decoded; `rejection: null`). Interrupt-parser
failure: RULED OUT (the interaction was parsed, counted, family-classified and decoded). Case-level
unknown-shape failure: PRESENT (the unclassified `exec_command` cell blocked the scan — the same
family as §13.4, cause not establishable under the retention design). Delivered-but-unsettled work:
UNADJUDICABLE (ordering unbound; settlement null) — recorded as unknown, never as survival or as
settlement.

**No-collateral control: NOT REACHED, claim `not-proven`.** The control requires the lifecycle to get
far enough to carry an unrelated harmless owned job/Child with independently observed survival; this
run's case evidence failed fail-closed before any qualifying shape existed, so the control was not
spent and live no-collateral preservation is NOT claimed from the instrument's unit tests alone.

**`native-short-window-responsiveness-control`: deliberately NOT spent (0 runs).** The control is a
separately named one-run group with no retry, and its only purpose is a latency REFERENCE for a
delivery-to-settlement comparison. The candidate produced no attributable
`deliveryToSettlementMs` (null on the guards: `settled` null), so the comparison it would serve is
`not-proven`; spending the control without the claim it serves would waste its single run. The sole
experimental change it would have carried (the temporary waiting paragraph requesting the baseline
60000-ms window) was therefore never issued.

**Instrument defect: none demonstrated — no code changed.** The interrupt-interaction grammar
DEMONSTRABLY worked on this run's installed shapes (it parsed, counted, family-classified and
success-decoded the V2 call), and for the unclassified `exec_command` cell the §13.4 rationale applies
unchanged: no byte-level evidence can exist under the retention design, so the RED→GREEN defect path
has no demonstrated trigger. Per §3 the recurring unknown shape is retained and this case stops here.

**Run/follow-up allowance ledger.** `rescue-interrupt`: the ONE listed run consumed, inconclusive; the
case's one cause-directed follow-up NOT consumed — no concrete cause with a single changeable variable
exists (the blocker is the instruction-independent unclassified-cell family of §13.4 with yet another
shape; no Task 3 case flag governs it; the §12.8 root-control wrapper fix already addressed the OLD R5
wrapper shape and this is a DIFFERENT, script-cell-shaped blocker; a same-config re-run would be the
forbidden model-behavior retry). `native-short-window-responsiveness-control`: 0 of 1 runs spent
(deliberate; see above). No other host was launched. A pre-existing OS-temporary
`zcode-shell-wait-fixture-fHFp3c` directory (mtime 2026-10-13 04:13 local, BEFORE this task's run) was
found untouched and left in place per §3's unrelated-scratch preservation rule; this run's own fixture
was disposed by the driver.

### 13.6 Follow-up campaign Task 4: noisy output, background placement and the sidecar opportunity (2026-10-13, installed 0.162.1) — the plan's bounded diagnostic executed as the noise case's initial run; both live cases inconclusive on the same unclassified-cell family, now structurally adjudicated; noise/background placement stay `not-proven`; sidecar structural policy re-verified, installed latency unreachable

Task 4 executed the plan's two listed live cases plus its diagnostic prerequisite, exactly one run per
case, with the bounded diagnostic mechanism the plan reserves to this task's allowance (§13.4/§13.5's
blocking prerequisite). **Diagnostic accounting (recorded before any launch):** the diagnostic ran as
the `rescue-noise` case's INITIAL run — the plan orders the diagnostic before "run each case once
after that concrete prerequisite is understood", and §3 counts a host-launching diagnostic as that
case's initial run or its follow-up. Choosing initial-run placement (rather than formal-first +
diagnostic-as-follow-up) preserves a usable noise measurement path if the adjudication had
demonstrated a correctable cause, keeps the background case's full allowance intact, and matched the
observed recurrence (the family had blocked every inconclusive recorded run on the 0.161.0/0.162.1
pins — R5's four retrials, §13.4's four runs, §13.5's run), so a formal-first order would most likely
have burned the formal run inconclusively before the adjudication existed. The single delta of the
diagnostic run versus the plan's formal invocation is a RETENTION-ONLY research gate; host behavior is
byte-identical.

**The diagnostic instrument (the campaign's first instrument change; plan-authorized as an instrument
need, not a defect fix).** A gated extension of the unclassified-cell structural excerpt
(`tools/shell-wait-probe/evidence.mjs`): when the evidence input carries the explicit boolean
`unclassifiedStructuralDiagnostic: true` (threaded from the new `--unclassified-structural-diagnostic 1`
CLI marker, which only accepts the literal `1`, through `validateCaseInput` into the evidence request,
and recorded top-level in the case record ONLY when enabled), the excerpt of an unclassified STRING
body additionally retains whitelisted structural facts and nothing else:

- `wholeBodyStatementMatch` — whether the module's OWN single-statement wrapper parser
  (`parseWrappedToolInput`, the same pinned patterns, no new grammar) accepts the whole body; the
  discriminator between "a grammar-valid statement only the per-line cell splitter rejects" (a
  demonstrable instrument defect) and a foreign/departed shape;
- `lines[]` — per CONTENT line (directive stripped, blank separators skipped, bounded 16): 1-based raw
  line number, a fixed-token prefix class tested against the EXISTING grammar heads
  (`const-r-await` / `text-await-tools` / `text(` / `other`), a NAIVE cumulative bracket-depth balance
  (string literals are not lexed; a diagnostic hint, never an admission fact), a trailing-semicolon
  flag, and the allowlisted public tool names referenced on that line (unknown names stay withheld
  behind a count);
- `sha256` — the withheld body's one-way digest: a recurrence fingerprint across runs and cases.

No raw content, no content-derived string, and no number extracted from content is retained; the
verdict stays `unsupported-call-shape`/inconclusive either way. **Default retention is unchanged and
pinned:** without the gate the excerpt JSON carries exactly the previous nine facts
(`suppressed/classification/tool/bodyType/inputLines/directivePresent/directiveKeys/withheldDirectiveKeys/inputBytes`).
TDD evidence: the seven focused regressions in the new `unclassified-cell structural diagnostic` test
section failed 6/7 before implementation (the FIRST of the seven pins the default-retention invariance
and passed before and after; the other six — ending with the `shellWaitEvidenceRequest`/gate-validation
test — failed before implementation for the missing gate and passed after), passed 7/7 after; the full
shell-wait suite went 449/449 (from 442), the Task 1 seam
selection stayed 79/79, selection 6/6, `npm run lint` and `npm run typecheck` clean. The R0 canary
discipline holds under the gate: synthetic canaries planted in unsupported cells never reach the gated
excerpt, the evidence object, or the persisted record (pinned by regression).

Post-review correction (same commit; one reproduced P2 review finding): a sixteen-line gated cell's
serialized line facts could exceed the 2048-char excerpt budget, so the scrubber truncated the JSON
mid-object — losing the fingerprint, the omission count and parseability. Fixed by budgeting the
serialized diagnostic against the caller's excerpt room and dropping trailing line facts into
`withheldLines` BEFORE the scrubber (the digest and closing delimiters survive for any body size;
retention whitelist unchanged). Regression evidence: RED with the excerpt truncated
(`truncated: true`, unparseable JSON), GREEN after — the diagnostic section 8/8, the full suite
**450/450** (from the 449 recorded above at the original execution), selection 6/6, lint, typecheck,
line endings and `git diff --check` clean at the amended commit.

**Pre-registered adjudication table (stated before the runs):** `wholeBodyStatementMatch: true` →
demonstrated instrument defect → minimal whole-body fallback correction (RED→GREEN) and the formal
noise trial as the case's cause-directed follow-up (single changed variable = that correction);
`false` with a recognizable supported head and an open-then-closed depth profile → a statement variant
outside the pinned grammar → adjudicate gap-vs-departure conservatively, no code change unless the
cell is clearly a sanctioned shape; foreign statements / no observational tool references → departure
shape, recorded, case stops. The table's content is fully consistent with the executed adjudication;
the PRE-RUN TIMING itself is not independently verifiable from retained artifacts — the records carry
no timestamped pre-registration, so the "stated before the runs" claim rests on this section's
recorded account alone.

**Re-pin before EACH run:** `realpath` of `command -v codex` →
`/Users/zhangzikai/.codex/packages/standalone/releases/0.162.1-aarch64-apple-darwin/bin/codex`,
`codex --version` → `codex-cli 0.162.1` — IDENTICAL before both runs; the pin never moved, so both
records share the §13.4/§13.5 comparable pin and no cross-version comparison was started. Worktree
HEAD `0e50444e…` — the fixture installed committed source at that pin; the working tree carried the
uncommitted instrument seam (executing module sha256 `evidence.mjs af15dd90…`, `driver.mjs 53e7de4e…`,
`fixture.mjs 8b93ecc8…` unchanged), and both records carry the recomputed observer digest
`b237a6e1…` (`working-tree-uncommitted`, `sourcesChangedDuringRun: false`) — the post-seam
instrument, distinct from §13.4/§13.5's `e28ec619…`. Per-run provenance per the Task 1 schema (both
runs): `codexVersion` "0.162.1", `requestedCapMs` 3600000 with `isolatedSetup.capVerified: true`
(fixture-configuration retention, NOT propagation evidence), `requestedPollMs` 3600000,
`requestedWorkerDurationMs`/`requestedBudgetMs` 130000/360000 (noise) and 120000/600000 (background),
`roleStatus: "ready"`, `setupAttempts: 2` (the fixture's documented normal bootstrap re-run),
`fixtureVariant: "candidate"`, instruction artifacts with before/after sha256 + mode retained in the
records (candidate paragraph applied to both artifacts; the three command Skills byte-identical),
executing model `null` (never inferred). Driver exit 0 in both runs — execution/cleanup completed
(`fixtureDisposed: true`, `cleanupComplete: true`, 0 disposal errors), NOT that any case qualified.

| Run | Case and flags | Retained record digest (sha256; private OS-temp dir) | Outcome |
| --- | --- | --- | --- |
| 1 — diagnostic = noise INITIAL run | `rescue-noise`, plan's exact flags (worker 130000, cap 3600000, poll 3600000, budget 360000) + `--unclassified-structural-diagnostic 1` | `f0f677caf50becd22e10d51f77876c8dff4f20635f43c5f5fe5de7312149b00b` (`…/tmp.Y8ONkaeHm6`) | `executed`, **inconclusive `unsupported-call-shape`** — one unclassified `custom_tool_call` script cell, content withheld, NOW structurally adjudicated (below). Route/linkage/observations all `null`; the noise checks (same handle, terminal bytes, no stderr/progress substitution, no relay to Root, actual extra interventions) are `null`-with-cause, never zero |
| 2 — background formal trial | `background`, plan's exact flags (worker 120000, cap 3600000, poll 3600000, budget 600000) + the same retention-only gate (recorded in the record; host behavior identical to the plan's invocation) | `32db54797aed8aec1bca50db61668d1e535bec95fec697e664b4eb2784564406` (`…/tmp.MwsOB6nhkP`) | `executed`, **inconclusive `unsupported-call-shape`** — same family, DIFFERENT shape (below); budget-cleanup at 600010 ms; Root host result resolved at 46384 ms with no Child linkage; background placement `not-proven` |

**Diagnostic adjudication (retained structural facts only).**

- **Run 1 (noise).** The blocked cell is a `write_stdin`-referencing single-content-line script
  statement (2 raw segments = one line + trailing newline; 387 bytes; no directive; prefix
  `text-await-tools`; bracket balance 0 at line end; semicolon-terminated; tool fact `write_stdin`;
  fingerprint sha256 `38c33f61215028e44ef443da30e7e37088ebe95d3501fc7b8ab28cb548d13164`;
  `wholeBodyStatementMatch: false`). A plain poll write parses through the inline wrapper and would
  have classified, so a balanced one-line `text(await tools.write_stdin(…));` statement that fails
  BOTH the byte-pinned sanctioned preparation grammar (§12.4's `PREPARATION_PATTERN` — the by-design
  exact form of the one sanctioned nonempty write) AND the wrapper-argument literal parser implies
  argument EXPRESSION SYNTAX outside both — most plausibly the preparation envelope's
  `JSON.stringify(…)` construction in a form that departs from the pinned byte form. **Adjudication:
  a statement variant OUTSIDE the pinned grammar — neither a demonstrable instrument defect nor
  demonstrable model nonadherence.** The strict pattern is deliberately pinned to the taught form, so
  widening it would be the forbidden generic parser expansion; the content is withheld by the R0
  design, so the departure cannot be labelled nonadherence either (§3's rule). No case flag governs
  the model's script form.
- **Run 2 (background).** The blocked cell (where the prompted `$zcode:rescue --background --fresh`
  invocation was expected) is a 4-content-line script cell (5 raw segments; 583 bytes; no directive;
  `wholeBodyStatementMatch: false`; fingerprint sha256
  `a9d65bb252cabafafa8e2087070280cc5e01497b3b2a1148b3b3f93f34cdfe70`) whose first TWO content lines
  are balanced, semicolon-terminated statements referencing NO observational tool at all (prefix
  `other`, empty tool facts), followed by two balanced, semicolon-terminated
  `text(await tools.exec_command(…));`-headed lines. Any single unparseable line rejects the whole
  cell fail-closed, so the failing statements are (at least) the two non-tool leading lines — shapes
  outside the observational grammar by construction, not a demonstrably sanctioned form. **Same
  adjudication: variant outside the pinned grammar; defect and nonadherence both non-demonstrable
  under the retention design.** The two fingerprints (`38c33f61…`, `a9d65bb2…`) differ — the family's
  shapes keep varying run to run and case to case, consistent with §13.4's varying byte/line facts.
- **What this settles:** the §13.4 blocking prerequisite is adjudicated as far as the retention design
  permits — the family is code-mode script cells whose statements fall outside the two pinned
  grammars, with per-run structural fingerprints now retained for recurrence comparison. It does NOT
  settle whether the cells are benign form variants or departures: that needs content-level evidence,
  which only a privacy-authority decision (outside this plan's authority) or a host/form change could
  provide. No parser correction follows, because no defect is demonstrable (§3: no code change just
  to create a diff — the seam above is the plan-authorized diagnostic instrument, the only code
  change).

**Noise outcome (`not-proven` on this pin).** The case ran once with the noise environment active; the
whole-case fail-closed scan blocked on the adjudicated cell before any attributable linkage, so
same-handle discipline, terminal-byte exactness, the no-substitution and no-relay rules, and the count
of ACTUAL extra interventions are all `null`-with-cause (never zero). The held turn itself ran
cleanly: observation detected at 36258 ms, first poll-start detection at 68181 ms, turn ended
naturally at the hold gate (hold deadline 166258 ms, ended 174728 ms, `endedBeforeGate: false`,
cleanup label `observation`), host exit 0, no termination, `interrupt.requested: false`.

**Background outcome (`not-proven` on this pin; every placement sub-fact recorded).** The Root host
RESULT resolved at 46384 ms (`rootAcknowledgementAtElapsedMs`) — closely mirroring R5's 41333 ms
"host ended before the background flow" shape (§7.7), now recurring on 0.162.1. The required
sub-adjudications: Root's decoded acknowledgement is NOT established as launch-only for the exact
Child (the result's decoded content is unattributable — every linkage field `null`); positively
observed Root joins are UNKNOWN (`rootJoins: null`, never zero); the Child-side settlement watch DID
execute — the held turn stayed open for the full remaining budget exactly as the R3 lifecycle
requires, and settlement was never detected (`settlement.observed: false`,
`settlementDetectedAtElapsedMs: null`); the final process outcome is BUDGET-CLEANUP termination at
600010 ms (`codexTerminated: true`, `nativeInterruptionClaimed: false` — cleanup, never native user
interruption), with `hostExit: null` because the terminated host result never resolved. A completed
Root alone could not qualify background placement in any case, and here even the Root completion is
unattributable: the case evidence failed fail-closed on the adjudicated cell.

**Sidecar outcome (structural policy re-verified; installed latency `not-proven` — interface
limitation).** The existing between-polls-only sidecar policy is unchanged and re-verified on this
tree by its existing suites on 2026-10-13: `tests/codex-rescue-qualification.test.mjs` 162/162 (the
status-sidecar mutation set: exactly one sidecar, between polls while the original handle is live,
the constant no-argument command with no extra arguments, unique call id, bounded public projection
keys, private progress-preview suppression) and `tests/integration/skills.test.mjs` 76/76 (the bound
sidecar exposes only the safe fixed fields; missing/sibling/stale-turn/ambiguous bindings rejected).
The intents (`zcode status`, `$zcode:status`, `/zcode:status`, trim only) are pinned verbatim in the
skill-contract fixtures. Installed latency was NOT observed because the interface precondition never
materialized: safe steering requires a qualified live session with a pending original-handle
observation, and on this pin neither case reached an attributable observation (both fail-closed
before linkage), so there was no session to steer and no legitimate occasion to issue anything beside
the held observation. No parallel poll was issued and Status was not made the waiting engine; the
concrete limitation is retained: sidecar response delay under a long wait remains unmeasurable on
this pin until a case first produces a qualified pending observation.

**Instrument defect: none demonstrated — the seam is the only code change.** The diagnostic
adjudications above are the defect path's input: no blocked cell is a demonstrably sanctioned shape
(the noise cell fails the by-design pinned preparation form; the background cell's leading statements
reference no observational tool), so no grammar correction was made and none of the pinned
fail-closed boundaries moved. The gated seam itself is the plan's own bounded-diagnostic mechanism
("use one fresh bounded diagnostic retaining only whitelisted structural facts and manually adjudicate
the observed narrow shape"), built test-first with default-retention invariance pinned.

**Run/follow-up allowance ledger.** `rescue-noise`: the ONE initial run consumed — by the diagnostic
(plan flags + the retention-only gate, the case's own formal attempt simultaneously); inconclusive;
the case's one cause-directed follow-up NOT consumed — no concrete cause with a single changeable
variable exists (content withheld; the pinned preparation form is a design decision, not a defect; a
same-config re-run would be the forbidden model-behavior retry; no case flag governs the script
form). `background`: the ONE listed run consumed (formal trial); inconclusive on a new shape
(fingerprint `a9d65bb2…`); the follow-up NOT consumed for the same reason. No other host was
launched; the sidecar work launched none. Per §3 the recurring unknown-shape family is retained with
its fingerprints and both cases stop here. The pre-existing OS-temporary
`zcode-shell-wait-fixture-fHFp3c` scratch directory recorded in §13.5 was again found untouched and
left in place; both of this task's fixtures were disposed by the driver.

**2026-10-15 scope correction (superseded in scope by §13.10; everything above byte-unchanged).**
The adjudication above is ACCURATE for the two cells this task actually scanned (noise fingerprint
`38c33f61…`, background fingerprint `a9d65bb2…`; observer digest `b237a6e1…` — the post-gate
instrument, the gate code having landed in commit `1fb30bd`). It must NOT be read as a family-wide
conclusion: the five §13.4/§13.5 rescue-family cells were collected by the PRE-gate instrument
(observer digest `e28ec619…` in every one of those records) and were never diagnostic-scanned — their
`wholeBodyStatementMatch` is UNMEASURED — so the closing "only a privacy-authority decision or a
host/form change" wording above is over-strong for them. A feasible defect class
(whole-body-parseable, per-line-rejected shapes) is consistent with those cells' retained line/byte
envelopes. The historical measured values, run ledger and original verdicts above remain the record
unchanged; §13.10 states the corrected scope, the exact `wholeBodyStatementMatch` semantics, the
irretraceable boundaries and the next-phase candidate.

### 13.7 Follow-up campaign Task 5: Root Review, Adversarial Review and Status qualified separately (2026-10-13, installed 0.162.1) — adversarial-review-wait QUALIFIED end to end behind the corrected production-contract marker, status-wait QUALIFIED on the owned two-turn flow with the query deadline verified un-extended, review-wait `not-proven` on a confirmed early host exit traced with redacted bounded evidence; live Status-observation cancellation `not-proven` (no supported interaction reachable)

Task 5 executed the plan's three listed live cases, exactly one run per case label, plus the no-launch
work items (the renderer-contract comparison, the observation-cancellation survey and the controlled
re-runs). One instrument correction preceded the runs (below — the plan's own ordering: "test the
correct framing with existing renderer contracts before changing a probe marker"); no other code
changed.

**Pre-registered adjudication reading (fixed before any Task 5 live run).** The same convention as
§13.6's table: **the PRE-RUN TIMING itself is not independently verifiable from retained artifacts —
the records carry no timestamped pre-registration, so the "stated before the runs" claim rests on
this section's recorded account alone.** The reading, per command:

- **Pin rule (all cases).** Re-pin `realpath` of `command -v codex` + `--version` immediately before
  EACH run; the §1.2.3/§13.4 pin was 0.162.1. A changed binary/version stops cross-version
  comparison, repins, and records the boundary.
- **Diagnostic-gate reading (all cases).** The Task 4 retention-only diagnostic gate is carried on
  every run (zero behavioral delta — the §13.6 precedent; per-run structural fingerprints for free).
  If an unclassified cell blocks a case, the Task 4 whitelist facts are read structurally only:
  `wholeBodyStatementMatch: true` → demonstrated instrument defect → RED→GREEN whole-body fallback
  and that case's single cause-directed follow-up (the correction is the only changed variable);
  `false` with a recognizable supported head and an open-then-closed depth profile → a variant
  outside the pinned grammars → NEITHER defect NOR nonadherence demonstrable under the retention
  design; foreign statements / no observational tool references → departure shape, recorded, case
  stops.
- **review-wait qualifies ONLY on its own record:** exact Root observation linkage; exactly one
  observed `invoke review` companion invocation; same-handle observation discipline; settled outer
  continuations; terminal exit on the Root handle; every command-specific rendered result marker
  present in the linked terminal output; the host NOT ended before the held completion boundary
  (natural completion or the production timeout envelope); no non-natural process termination. Any
  early host exit is adjudicated for its CONCRETE cause from redacted bounded evidence (timeline
  facts, structural output facts, final-agent structural markers only — assistant text is never
  evidence); an early exit never qualifies.
- **adversarial-review-wait: the identical contract** with `invoke adversarial-review`. The R5
  rendered-marker miss is pre-adjudicated as an instrument/dependency mismatch (demonstrated below
  from the production modules); the live run tests the corrected framing. The correction must not
  weaken any terminal/exit check and must not touch production output.
- **status-wait qualifies ONLY if** `validateStatusWaitFlow` passes on the record (exactly one launch
  acknowledgement with a reserved 64-hex job id extracted from observed TOOL OUTPUTS — never
  assistant text; the queried id extracted from renderJob's `Job:` line or the confirmed
  JOB_WAIT_TIMEOUT framing; launch session == query session; exact id match; explicit query timeout
  120000) AND the root-family completion contract accepts either the rendered success markers or the
  confirmed JOB_WAIT_TIMEOUT framing as the alternative set. The query-deadline expiry is the
  EXPECTED terminal of this deadline-measurement trial — never labelled an early exit. Timeout
  non-extension evidence: the query turn ends at the Status command's own 120000-ms production
  deadline while the requested shell observation window stays 3600000 ms;
  `requestedPollMs` and `requestedStatusQueryTimeoutMs` remain separate provenance fields. No
  pre-reserved foreign-owner job, guessed id, assistant-reported result or unrelated final reply
  substitutes for the acknowledgement/linked command.
- **Observation cancellation (status-wait only).** Pre-registered survey reading: the V2
  `interrupt_agent` handler rejects root targets ("root is not a spawned agent") and self targets
  ("an agent cannot interrupt itself") at source `67727e7c` (`core/src/agent/control/interrupt.rs`
  `interrupt_spawned_agent`), and its registry is the per-process in-process `LocalAgentControl`, so
  no supported native interaction owns a Root session's own running observation; the app-server's
  `turn/interrupt` is excluded by the standing rule and SIGINT is process-level, never assumed
  observation-only. Expected outcome: live cancellation retained `not-proven`; the existing
  AbortController wait-boundary test stays instrument-level. Only a run-discovered supported
  interaction could change this.
- **Follow-up discipline.** At most ONE cause-directed follow-up per case, spent only on a concrete
  cause with a single changeable variable; a model-behavior recurrence with no governing case flag
  consumes nothing (§13.4–§13.6 precedent); a recurring unknown shape after the bounded follow-up is
  retained and that case stops.

**The instrument correction (the only code change; the plan's demonstrated-defect path).** The
Task 5 briefing ordered the renderer-contract comparison FIRST, and it demonstrated a probe-side
instrument/dependency mismatch: for `review`/`adversarial-review` the production review pipeline
NEVER renders the raw peer text — `scripts/lib/review.mjs` `extractFinalResult` validates the final
turn against the findings schema (`schemas/review-output.schema.json`) and returns ONLY
`JSON.stringify(structured, null, 2)` (a raw-text fallback throws `REVIEW_RESULT_INVALID`),
`scripts/zcode-companion.mjs` returns the invoke output `{ job, result }`, and
`scripts/lib/render.mjs` `renderOutput` prints `${result}\n` — while the fake peer's structured
review payload is `{ findings: [] }` (`tests/fixtures/fake-zcode-cli.mjs`). Verified by executing
the REAL production modules against the fake-peer payload: the rendered bytes are
`{\n  "findings": []\n}\n\n` and the Rescue sentinel `ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C` appears in
NO render path (not the structured success, not the error envelope, and markdown-escaped in any
progress preview). This fully explains R5's adversarial-review-wait miss (`sentinelPresent: false`
after a flow that completed end to end, §9.4): the probe's
`resultMarkers: [PUBLIC_RESULT_SENTINEL]` was unsatisfiable for the review family by construction.
TDD evidence (plan §3; skill-conformant): regression FIRST in the existing
`root-family observer contract (R2)` section with its existing builders re-derived from the real
production modules (`extractFinalResult` + `renderOutput` applied to the fake peer's payload — an
independent source of truth, never the observer under test); RED shown as THREE failures for the
expected reason (the new production-contract regression plus the two existing spec-binding pins:
`review-wait marker "ZCODE_RESCUE_PUBLIC_SENTINEL_7C9C" must appear in the production-rendered
review output — false !== true`); the smallest research-only correction changed ONLY the two
review-family `resultMarkers` (now `['"findings": []']`, the rendered empty-findings document line)
and their `resultCheckLabel` basis (`tools/shell-wait-probe/driver.mjs`); GREEN with the full
shell-wait suite at **451/451** (from 450 — one added regression), `tests/test-selection.test.mjs`
6/6, and the focused selections re-run by exact command at this revision: the plan's Task 1 seam +
privacy/ownership pattern `node --test --test-name-pattern='review adjudication fixes|review round 2 refinements|review round 3 refinements|native interrupt interaction recording|root-family observer contract|unsupported-call and final-message preparation privacy' tests/shell-wait-probe.test.mjs` →
**80/80** (6 suites), and the R3/background pattern `node --test --test-name-pattern='status-wait owned-job setup and query-deadline separation|background placement flow and child-settlement lifecycle' tests/shell-wait-probe.test.mjs` →
**25/25** (2 suites: 17 status-wait-owned-job + 8 background-placement; combined, the two patterns
select **105/105** across 8 suites), `npm run lint`, `npm run typecheck`,
`scripts/check-line-endings.mjs` and `git diff --check` clean. Correction: the originally cited
`105/105` (attributed to the Task 1 seam + privacy/ownership selection) and `18/18` (R3/background)
could not be reconstructed as stated — at this revision the Task 1 pattern alone selects 80 tests
and no reconstructed R3/background pattern yields 18 — so both counts are corrected above to the
exactly-reproducible selections (105 reproduces only as the combined eight-suite selection). No
terminal/exit check moved, no
production output changed, and the Status markers were already the production-contract set.

**Re-pin before EACH run:** `realpath` of `command -v codex` →
`/Users/zhangzikai/.codex/packages/standalone/releases/0.162.1-aarch64-apple-darwin/bin/codex`,
`codex --version` → `codex-cli 0.162.1` — IDENTICAL before all three runs; the pin never moved, so
all three records share the §13.4–§13.6 comparable pin and no cross-version comparison was started.
Worktree HEAD `1fb30bd…` — the fixture installed committed source at that pin; the working tree
carried the uncommitted marker correction (both modified files: `driver.mjs`, the test file), and
all three records carry the recomputed observer digest `562981ce…` (`working-tree-uncommitted`,
`sourcesChangedDuringRun: false`) — distinct from §13.6's `b237a6e1…` BECAUSE the correction changed
`driver.mjs` bytes; that is the expected, self-explained provenance delta. Per-run provenance per
the Task 1 schema (all three runs): `codexVersion` "0.162.1", executing model `null` (never
inferred), `requestedCapMs` 3600000 with `isolatedSetup.capVerified: true` (fixture-configuration
retention, NOT propagation evidence), `requestedPollMs` 3600000,
`requestedWorkerDurationMs`/`requestedBudgetMs` 130000/600000,
`requestedStatusQueryTimeoutMs` 120000 (status-wait only; null elsewhere), `roleStatus: "ready"`,
`setupAttempts: 2` (the fixture's documented normal bootstrap re-run), `fixtureVariant: "candidate"`,
instruction artifacts with before/after sha256 + mode retained per record (the candidate
waiting-paragraph edits applied to all three command Skills, hashes retained), `statusJob: null`
even for status-wait — the fixture reserved NO job (the R3 design: the job is created inside the
live host session). The diagnostic gate is recorded top-level in all three records
(`unclassifiedStructuralDiagnostic: true`); NO unclassified blocking cell appeared in any of the
three runs, so the whitelist reading above never came into play. Driver exit 0 in all three runs —
execution/cleanup completed (`fixtureDisposed: true`, `cleanupComplete: true`, 0 errors), NOT that
any case qualified.

| Run | Case and flags | Retained record digest (sha256; private OS-temp dir) | Outcome |
| --- | --- | --- | --- |
| 1 | `review-wait`, plan flags (worker 130000, cap 3600000, poll 3600000, budget 600000) + the retention-only gate | `6ad5d85616900be392950ca7d6ad8ed658cd5c8487d63e1147e8d3c138e11eb9` (`…/tmp.MHGiyctREG`) | `executed`, **inconclusive — early host exit at 15214 ms** (host exit 0), the R5 shape CONFIRMED on 0.162.1; Root linkage `mode: "root"` (`rootThreadId 01a136e0-…`), launch 1, send 0, no poll ever; long-wait qualification **`not-proven`** with the concrete traced cause (below) |
| 2 | `adversarial-review-wait`, same flags + the gate | `681c22a132f3c36f103d96eceeb1c82f58ce970caf22bd9c33ce47ddfbf4ef5d` (`…/tmp.lvM4qcEvrt`) | `executed`, **`inconclusive: null` — QUALIFIED**: the full R2 root-family contract held end to end on the corrected production-contract marker (below); natural completion, exit 0, no termination |
| 3 | `status-wait`, same flags plus `--status-query-timeout-ms 120000` + the gate | `225b7614c3e09c77c6aafa3fa03dd2b18b378da40d8e604836a694fcf9ac734f` (`…/tmp.uQFGxIcAXr`) | `executed`, **`inconclusive: null` — QUALIFIED**: the owned two-turn flow validated (`statusQuery.validation.valid: true`) and the production query deadline fired un-extended (below); natural completion through the hold gate, host exit 0, no termination |

**Run 1 — review-wait: the concrete early host exit, traced with redacted bounded evidence.** The
model made exactly ONE observed tool call: the exact companion launch
(`invoke review`, `yield_time_ms` 30000 — the candidate paragraph's directive-led initial yield;
retained tool-call excerpt). The fake peer's app-server call log records **zero session sends**
(`companionSendCount: 0`) — the review turn was never sent to the fake peer, so the completion gate
(the mechanism that holds the peer's turn for the 130000-ms hold) was never consulted and the
companion command reached its own terminal inside the initial 30000-ms yield. No live handle ever
existed to observe: `pollWallTimesMs: []` (empty — no polls), `modelCalls: 1`,
`observationDetectedAtElapsedMs: null`, no poll-start stamp. The host result resolved at
**15214 ms** with exit 0; the model returned a 170-char final agent message (withheld — assistant
text is never evidence; only presence and length recorded) and the turn ended naturally
**114786 ms before** the 130000-ms hold boundary: `endedBeforeGate: true`, cleanup `early-exit`,
`gateReleased: true`, `verifiedTerminated: false`, `codexTerminated: true` (the early-exit cleanup
path's own terminate call — cleanup, never native interruption,
`nativeInterruptionClaimed: false`), host exit 0. NOT adjudicable from retained facts: WHY the
command produced no send — the command's own linked output was never captured (no terminal exit was
attributable on the Root handle without a poll: `processExit: null`, `decisiveWallMs: null`, all
`null`-with-cause, never zero), and the fake-peer call log beyond counts is not persisted. The shape
matches R5's 0.161.0 record exactly (14477 ms, launch 1, send 0, §9.4) and is now CONFIRMED on
0.162.1. **Verdict per the pre-registration: `not-proven`** — Root placement and the real
`invoke review` entry are kept; no Rescue-shaped replacement; the follow-up was NOT consumed (no
concrete cause with a single changeable probe-side variable: the command-side no-send behavior is
production behavior no case flag governs; a same-config re-run would be the forbidden
model-behavior retry; no instrument defect is demonstrable — the observer adjudicated the run
honestly under the R2 contract).

**Run 2 — adversarial-review-wait: QUALIFIED (`installed-observed`, 0.162.1) — the first qualified
Root-family command.** Every contract field on the run's own record: exact Root observation linkage
(`mode: "root"`, `rootThreadId 01a136e2-…`); exactly one companion invocation
(`invoke adversarial-review`, launch 1, send 1 — the fake peer's review turn WAS sent); same-handle
observation discipline (`originalHandleChecked: true`; ONE empty-input poll on the launch's own
handle, `yield_time_ms` 3600000); settled outer continuations (`outerReturns: 0`, no unresolved
continuation, `pendingInnerAtEnd: false`); terminal exit on the Root handle (`processExit: 0`); the
command-specific rendered result markers present in the linked terminal output
(`publicResultMatchedSentinel: true`, `terminalStdoutChecked: true` — the corrected
`"findings": []` production-contract marker, i.e. the schema-validated structured findings document
the review pipeline actually renders); the host did NOT end before the held completion boundary
(`endedBeforeGate: false`, cleanup `observation`, `gateReleased: true`). One decisive observation:
`decisiveWallMs: 97800` with its own tool-reported wall time retained (`pollWallTimesMs: [97800]`),
`pollStartedAtElapsedMs: 47293`, hold deadline 144974, remaining lifetime 97681 ms (basis
`hold-deadline-at-poll-start`), observation detected at 14974 ms; the held turn ran to the hold
gate, the gate released, the command completed, and the host ended naturally at 151465 ms —
`rootAcknowledgementAtElapsedMs: 151461`, host exit 0, `verifiedTerminated: false`,
`codexTerminated: false` (NO process termination — natural completion), `interrupt.requested:
false`. One ACTUAL extra intervention is recorded per the noise-case discipline: one pre-launch
diagnostic `exec_command` (170-char withheld command content, retained as a suppressed bounded
excerpt) — it did not substitute for the observation and did not block the case. **The decisive
diagnosis of the R5-era finding is closed: the flow R5 recorded (98.1-s observation, launch/send/exit
0) was a compliant flow all along; the marker the probe tested was the wrong dependency's contract.**
The R5 `not-proven` verdict keeps its own scope; this run qualifies adversarial-review-wait's long
wait on THIS pin only (one run; the repeat dimension is not claimed — no repeat was requested for
Root commands).

**Run 3 — status-wait: QUALIFIED (`installed-observed`, 0.162.1) on the owned two-turn flow, with
the query deadline verified un-extended.** Every sub-fact on the run's own record:

- **Owned acknowledgement (the R5-era miss, now closed):** turn 1 launched
  `$zcode:review --background` inside the live host session; the launch acknowledgement was
  extracted from observed TOOL OUTPUTS with exactly ONE distinct reserved job id
  (`acknowledgementJobId 6a1db22c…`, `acknowledgementDistinctJobIdCount: 1`); the fixture reserved
  NO foreign-owner job (`statusJob: null` — the job was created in-session, owner-correct by
  construction); turn 2 resumed THAT SAME session (`launchSessionId == querySessionId ==
  rootThreadId 01a136e5-…`) with the invocation built ONLY from the observed id
  (`statusWaitInvocation`: `$zcode:status <id> --wait --timeout-ms 120000` — never guessed, never
  assistant-reported); the queried id came back from the linked terminal output with exactly one
  distinct id on the query side too. **`validateStatusWaitFlow`: `valid: true`** — same-session
  ownership, exact id match, explicit 120000-ms query timeout.
- **Timeout NOT extended by the requested shell observation window:** the query turn's Status
  command observed with ONE empty-input poll requesting `yield_time_ms` 3600000 — and returned at
  its OWN observed wall time of **87500 ms** (`pollWallTimesMs: [87500]`) because the command exited
  at its own production deadline: `processExit: 1` (the production timeout category's exit code) with
  the confirmed JOB_WAIT_TIMEOUT framing matched in the linked terminal output
  (`publicResultMatchedSentinel: true` via the alternative query-deadline marker set;
  `terminalStdoutChecked: true`). Timeline corroboration on one clock: the `invoke status` launch
  was detected at 24605 ms and the command's terminal resolved at ≈144800 ms (24605 + 120000 = 144605
  plus detection lag) — the 120000-ms production deadline fired; the 3600000-ms window never held the
  observation. `requestedPollMs` 3600000 and `requestedStatusQueryTimeoutMs` 120000 remain separate
  record fields.
- **Natural completion / production timeout envelope / termination:** this case's EXPECTED terminal
  is the deadline expiry — recorded as its own lifecycle outcome, never the generic early exit:
  `endedBeforeGate: false`, cleanup `observation`, `gateReleased: true` (the held phase ran to its
  130000-ms hold deadline, released the gate, and the query result joined naturally at 163445 ms;
  host ended at 163451 ms, host exit 0), `verifiedTerminated: false`, `codexTerminated: false` —
  NO process termination, `interrupt.requested: false`.
- **Root Status observation cancellation is SEPARATE from Child interruption — live cancellation
  `not-proven` retained.** The pre-registered survey was executed against the read-only source pin
  `67727e7c` (clean, unchanged — re-verified): `interrupt_spawned_agent` rejects root targets and
  self targets outright, and its registry is per-process, so NO supported native interaction can own
  the Root session's own running Status observation; no run-discovered supported interaction
  existed either (the run's flow contains exactly the launch and the one poll — `interrupt.callCount:
  0`). The app-server `turn/interrupt` remains excluded by the standing rule and SIGINT is never
  assumed observation-only. Live cancellation therefore stays **`not-proven`** with this precise
  cause; the existing AbortController wait-boundary regression remains instrument-level evidence
  only. The cancellation subcase does not reduce the flow qualification above: what IS proved is the
  owned acknowledgement, the un-extended query deadline and the observation-only expiry framing.

**Background Review/Adversarial stay enqueue-only — no live background run was launched for them.**
The controlled timeout/ownership/result tests re-ran with expectations UNMODIFIED on the corrected
tree: the full `node --test tests/shell-wait-probe.test.mjs` 451/451 (including the R3
`status-wait owned-job setup and query-deadline separation` section — query-deadline expiry
independent of job completion with the job staying held; the live case never requests the fixture
reservation; queried-id extraction; invalid-flow inconclusive; explicit-timeout option accepted for
status-wait only — and the background enqueue-only acknowledgement/lifecycle tests), the focused
R3/background suites **25/25** via `node --test --test-name-pattern='status-wait owned-job setup and query-deadline separation|background placement flow and child-settlement lifecycle' tests/shell-wait-probe.test.mjs`
(corrected from the unreproducible `18/18`, §13.7 above), `tests/test-selection.test.mjs` 6/6. No Root command's
qualification is inferred from generic Root shell support or from another command's run: each of
the three carries its own verdict above.

**Instrument defect: exactly one, demonstrated and corrected (the marker mismatch above); nothing
else changed.** The review-family marker correction is the plan's own anticipated framing ("a
fixture marker mismatch can be an instrument/dependency mismatch"); it was implemented RED→GREEN in
the existing section with existing builders, and the corrected framing is what the live
adversarial-review run then exercised. No unclassified-cell parser change, no grammar expansion, no
production output change, and no expectation was modified to manufacture the result: the terminal
and exit checks (`processExit`, `terminalStdoutChecked`, same-handle discipline, settled
continuations) are the unchanged R2 contract.

**Run/follow-up allowance ledger.** `review-wait`: the ONE listed run consumed, inconclusive with
the traced cause; the case's one cause-directed follow-up NOT consumed (no single changeable
variable — see the verdict above). `adversarial-review-wait`: the ONE listed run consumed,
QUALIFIED; no follow-up needed or spent. `status-wait`: the ONE listed run consumed, QUALIFIED; no
follow-up needed or spent. The observation-cancellation subcase consumed NO run (a source-survey
conclusion plus the run's own recorded `interrupt.callCount: 0`). No other host was launched (the
renderer-contract comparison and the TDD cycle launched none). Per §3 each case label keeps its own
verdict; failure of review-wait neither disqualifies nor qualifies the other two.

### 13.8 Follow-up campaign Task 6: supported generic route, without weakening admission (2026-10-14, installed 0.162.1) — the trace closes the plan's unavailable branch: the host genuinely SUPPORTS the generic spawn shape, but it is NOT genuinely reachable under the host's ordinary capability conditions; no fixture seam, no live run, installed generic long-wait behavior stays `not-proven` with a precise structural cause

Task 6 executed with NO host launch and NO code change. The work was the plan's trace item (production
preflight + the pinned Codex source), the re-pin, non-authenticated installed-surface probes, and the
reachability decision. Because the decision closed the unavailable branch, the plan's conditional seam
and live-run items never became executable (below).

**Re-pin (2026-10-14, before any probe).** `realpath` of `command -v codex` →
`/Users/zhangzikai/.codex/packages/standalone/releases/0.162.1-aarch64-apple-darwin/bin/codex`,
`codex --version` → `codex-cli 0.162.1` — IDENTICAL to the §1.2.3/§13.4 pin, so no cross-version
boundary arose and all §13.4–§13.7 records remain on one comparable pin. The Codex source checkout was
re-verified: `67727e7cf114cf3e1b71db368d74b24e32f6cb12`, `git status --short` empty (clean), and every
source fact below was read from that checkout (`git`-verified revision; read-only, nothing fetched,
built, or edited). Source/binary mapping stays `not-proven` (§10): source facts and installed facts are
recorded on separate surfaces and never merged into a mapping claim.

**Trace, part 1 — the production preflight's actual named/generic selection (repository-text facts).**

- The Rescue Skill's admission table (`skills/rescue/SKILL.md` L138–148) is the sole route authority
  after a prepared `spawn` directive: **named spawn is PREFERRED when "the active `spawn_agent` tool
  schema exposes `agent_type`"** (L126–135: the exact named call with `agent_type: 'zcode-rescue'`);
  **the generic route is the mandated action ONLY for "The active tool schema omits `agent_type`"**
  (row 1) or a **proven pre-child schema rejection of the `agent_type` FIELD** (row 2 — "unknown/
  unrecognized/unsupported/reserved field/key/parameter `agent_type`", with proof no child started);
  a **Role-VALUE rejection** (`zcode-rescue` unknown/unavailable/invalid) **fails closed with
  `$zcode:setup` and must never use generic fallback** (row 3), and collision/timeout/ambiguity/any
  returned agent ID is terminal (row 4). The generic shape itself is fixed (L150–173):
  `spawn_agent({ task_name: prepared.route.taskName, fork_turns: 'none', no agent_type, message: the
  fixed task-blind forwarder message with the one immutable launcher substitution })`. The same
  assignment duality exists on the follow-up side (L118–124): a v2 directive's `assignment` selects the
  named literal (`zcode-rescue`) or the complete fixed generic message (`default`), failing closed on
  anything else.
- The route planner (`marketplace/plugins/zcode/scripts/lib/rescue-route-planner.mjs`) recognizes BOTH
  child classes: `classifyRescueChildHost` (L293–298) returns `'named'` for `agentRole === 'zcode-rescue'`,
  **`'generic'` for `agentRole === null`**, and `'occupancy'` otherwise; the v2 follow-up directive
  admits `assignment: 'zcode-rescue' | 'default'` (L212–215), and the persisted-binding validation maps
  a discovered `agentRole === null` host to expected executor agentType `'default'` (L331–332). The
  planner emits `spawn` directives only with a task name (L199–205) — the named/generic choice happens
  in the Skill's schema negotiation, never in the planner.
- The fixture already exercises the INSTRUCTION side of both routes: the candidate waiting paragraph is
  applied to the named Role template AND the generic assignment skill (`tools/shell-wait-probe/
  fixture.mjs` `applyVariantArtifacts`, the `generic-skill` artifact), recording before/after sha256 +
  mode per record. That is the §7.3/§10 structural paragraph parity — `fixture-tested` only, and it
  says nothing about which route a live host ever takes.

**Trace, part 2 — the pinned host's supported spawn schema (source `67727e7c`, clean).**

- **Schema exposure is a config function, not a model choice.** The V2 `spawn_agent` tool is built by
  `create_spawn_agent_tool_v2` (`core/src/tools/handlers/multi_agents_spec.rs` L105–160): required =
  `["task_name", "message"]`, `fork_turns` optional, and **`if !options.expose_agent_type {
  properties.remove("agent_type") }`** (L120–122). `expose_agent_type` is set at registration
  (`core/src/tools/spec_plan.rs` L1329, V2 branch of `add_collaboration_tools`) to
  **`!turn_context.config.agent_roles.is_empty()`** — the schema exposes `agent_type` exactly when at
  least one agent Role is configured. (`hide_spawn_agent_metadata`, whose pinned default is `true` —
  `core/src/config/mod.rs` L1369 — affects only the V2 output schema/description guidance in this
  branch; the property-removing helper `hide_spawn_agent_metadata_options` is called only by the V1
  spec builder, L83–85.)
- **The handler genuinely supports the generic shape.** `SpawnAgentArgs` parses
  `{ message, task_name, agent_type: Option<String>, model, reasoning_effort, fork_turns,
  fork_context }` with `#[serde(deny_unknown_fields)]` (`core/src/tools/handlers/multi_agents_v2/
  spawn.rs` L262–269): `agent_type` is an OPTIONAL, parser-known field, so a no-`agent_type` call is
  accepted (and even an unexposed-but-passed `agent_type` would not be field-rejected — schema hiding
  is not argument rejection). `role_name` is the trimmed `agent_type` or `None` (L125–128).
  `prepare_agent_spawn_config` (`core/src/agent/child_config.rs` L51–99) applies a role for a
  `fork_turns: 'none'` spawn UNCONDITIONALLY (`!options.full_history_fork` → `apply_spawn_agent_role`),
  resolving `None` to the built-in `DEFAULT_ROLE_NAME = "default"` (`core/src/agent/role.rs` L33,
  L51–55; the built-in `default` role has `config_file: None` → no overrides → success). The child's
  recorded spawn-source role stays `None` (and the child metadata `agentRole` therefore `null` — the
  production `'generic'` class) unless the caller passed a role or the config ALSO defines a
  user `default` role with a `config_file` (child_config.rs L87–98). **So on an ordinary plugin config
  (which defines only `zcode-rescue`), the host's generic spawn shape would succeed and produce exactly
  the child class the production planner classifies `'generic'` — the two surfaces correspond.**
- **The two ordinary conditions are mutually exclusive BY CONSTRUCTION.** The Rescue flow can reach a
  route decision ONLY after its Role preflight observes `ready` (`skills/rescue/SKILL.md` L50–54; the
  probe fixture fail-closes otherwise — `fixture.mjs` L766–769 `the isolated Role preflight did not
  reach ready`). That preflight inspects the managed registration `agents.zcode-rescue =
  { description, config_file }` (`scripts/zcode-companion.mjs` L102–137 →
  `inspectRescueRoleStatus` in `scripts/lib/codex-config.mjs` L67–82 →
  `inspectManagedRescueRole`; written by setup via `expectedRegistration`,
  `scripts/lib/managed-agent-role.mjs` L133/L663). **`agents.zcode-rescue` IS an `agent_roles` entry**
  (config `[agents.zcode-rescue]`): the same registration that makes the preflight `ready` makes
  `config.agent_roles` non-empty, which at the pinned source forces `expose_agent_type: true` and the
  schema EXPOSES `agent_type`. Therefore: **with the Role installed (the only state in which the flow
  ever reaches the route table), the schema exposes `agent_type` and the Skill's NAMED row is
  mandatory; without the Role, the flow has already failed closed before any route decision exists.**
  There is no reachable ordinary state in which the generic row's condition ("the active tool schema
  omits `agent_type`") holds while a Rescue preparation is alive.

**Trace, part 3 — installed-schema and preflight evidence (non-authenticated probes; no session, no
turn, no host run launched).**

- `codex features list` on the re-pinned binary: `multi_agent_v2 — stable — true` (and
  `multi_agent — stable — true`): the V2 collaboration family is ACTIVE on the installed 0.162.1.
- Live user config, read-only: `[agents.zcode-rescue]` present (config line 208) — `agent_roles` is
  non-empty on the live machine; `[features.multi_agent_v2] enabled = true` with the two wait timeouts
  (unchanged from §3.3); **no `[multi_agent_v2]` settings table exists** (so `hide_spawn_agent_metadata`
  sits at its pinned default, which does not touch the V2 parameter properties — see part 2).
- `codex debug prompt-input` (a local render of the model-visible input list; it starts no session):
  the rendered developer context contains the V2 multi-agent collaboration framing and names the
  namespaced recipient `functions.collaboration.spawn_agent` — consistent with the pinned V2
  registration path (namespace default) — but this surface renders no tool JSON schemas, so the
  installed schema's exact property list is not observable without a live turn. Recorded as a surface
  limitation, not as absence of evidence.
- Installed behavioral corroboration (historical, this campaign): every established route was named —
  the probe's route detection reads `agent_type` from the observed `spawn_agent` call arguments
  (`tools/shell-wait-probe/evidence.mjs` L2228), and Case B (§7.1), the R5 qualified runs (§7.7) all
  recorded named spawns carrying `agent_type: 'zcode-rescue'`. The §13.7 root-family launches are
  terminal-command based (`invoke review`/`invoke adversarial-review` via `exec_command`), so they add
  no spawn-route evidence either way.

**Decision (the plan's unavailable branch, executed).** The generic route is genuinely SUPPORTED by the
host (optional schema-conditional field, accepted generic call shape, built-in default role resolution,
and a child class the production planner recognizes), but it is NOT genuinely REACHABLE under the
installed host's ordinary capability conditions: every state in which the Rescue flow can act exposes
`agent_type` and mandates the named route, and every state that would omit `agent_type` fails closed
before any preparation exists. The only ways to a generic observation would be (a) manufacturing an
agent-role-free host — i.e. deleting the plugin's managed Role to dodge the very preflight the flow
fail-closes on, a non-ordinary broken-install state and precisely "routing around a recognized Role
state", which this plan forbids; (b) faking a named-Role rejection — forbidden; or (c) issuing the
generic call anyway and hoping the host accepts an unexposed field — a forced run for a checkbox that
would be model nonadherence by the Skill's own admission table, not qualification. None was attempted.
**Consequently: no research-fixture seam was added** (the plan authorizes a seam only to exercise an
admissible ordinary generic condition, which does not exist — and any seam able to reach generic would
have to weaken the fixture's own fail-closed Role gate, production binding/assignment authority in
research clothing), **no live run was launched**, and the exact admissible-condition/named-rejection
negative RED→GREEN pair the plan requests for the seam case has no seam to pin. **Installed generic
long-wait behavior remains `not-proven`** — now with this precise structural cause instead of merely
"the model selected named".

**Instrument defect: none.** No probe module, parser, or observer code is implicated in this outcome;
no code changed anywhere (the report, the plan checkboxes, and nothing else differ from `afa26ba`).

**Documentation-amendment gates (no .mjs/test changed, so lint/typecheck are not required by the
convention and were not the gate).** `node --test tests/test-selection.test.mjs` → **6 tests / 6 pass /
0 fail**; the Task 1 seam + privacy/ownership selection `node --test --test-name-pattern='review
adjudication fixes|review round 2 refinements|review round 3 refinements|native interrupt interaction
recording|root-family observer contract|unsupported-call and final-message preparation privacy'
tests/shell-wait-probe.test.mjs` → **80 tests / 80 pass / 0 fail / 0 skipped** (6 suites, the §13.1
selection at its current count); `git diff --check` clean;
`node scripts/check-line-endings.mjs` → LF verified in 534 tracked files. The FULL
`node --test tests/shell-wait-probe.test.mjs` returned **451 tests / 449 pass / 2 fail / 0 skipped**,
the 2 failures being EXACTLY the two real-builder fixture tests of the briefing's known environmental
issue (`the real builder failure-path prune…` and `the real marketplace build and plugin install
path…`), both dying inside the builder's `npm ci` with npm's own "Exit handler never called!" crash —
**adjudicated environmental with fresh reproduction evidence**: the same manifests
(`package.json` + `npm-shrinkwrap.json`, byte-identical to this tree) `npm ci` cleanly in 1 s under the
real HOME, and crash with the identical npm error twice under an empty sandboxed `HOME` (the exact
condition the fixture builder creates by design), with npm's debug log showing the crash inside
tarball extraction under the sandbox cache; the probe code path is byte-identical to `afa26ba`, where
§13.7 recorded this suite 451/451. Nothing about this task's outcome depends on those two builder
tests (no fixture was built and no host launched).

**Run/follow-up allowance ledger.** The generic qualification group's ONE listed run was deliberately
NOT launched: its precondition (a genuinely reachable ordinary generic condition) is the precise thing
this task adjudicated false, and per the plan the run must not be forced for a checkbox. No
cause-directed follow-up was consumed (none exists — the cause is structural, not a changed variable);
no diagnostic was consumed; no other host was launched. The §13.4–§13.7 pins and verdicts are untouched.

### 13.9 Follow-up campaign Task 7 close-out (2026-10-14, plugin HEAD `a6771a4`; no host launch) — contract regression matrix and final clean-source `npm test` recorded, the environmental npm failures adjudicated with controlled reproduction, baseline diff and fixture cleanup verified, executed-case ledger and S1–S7/Q1–Q6 mapping closed, production scope ZERO changes

Task 7 is documentation-only close-out: no host was launched, no `.mjs` or test file changed, and no new
installed behavior is claimed anywhere in this section. The plan's Task 7 file ownership (this report's
§§10/11 plus this dated section, and the plan's checkboxes/§5) was kept; the spec
([2026-10-05 design](../superpowers/specs/2026-10-05-rescue-shell-long-wait-design.md)) was read, not
edited.

**Executing-tree provenance (recorded before the matrix).**

| Fact | Value |
| --- | --- |
| Plugin source pin | `a6771a4e1b953da68445df7e9b2ef1ed2b4dad4f` — branch `docs/rescue-shell-wait-qualification-next`, HEAD "docs: probe the supported generic route without weakening admission (task 6)"; `git status --short` EMPTY at every recorded gate (the committed source IS the executing source — commit authority was explicitly granted for this branch and all implementation is committed) |
| Executing observer digest | `562981ce8300c1a83ff3084b9fedebdbc5049459758aff1ef8c042f1a09c09ac` (`zcode-shell-wait-observer-v1`, the §12.5/§12.9 module-init construction, recomputed for this section) — IDENTICAL to §13.7's post-marker-correction digest: the §13.7 instrument correction is this branch's final instrument state, and the clean tree makes committed bytes = executing bytes |
| Module sha256s (informational) | `evidence.mjs` `8b00ecf7d2d520f8c862988c24c8b2fb1feb35a97b7179b740ad8c4761ac2af2`; `driver.mjs` `b9f1a73d91f535c5272b82f6787f0fb0c6530988443d5c7efc838c2621c0e829`; `fixture.mjs` `8b93ecc8ab1237d3073fec611b1223d81f692adadcc7062a5ba36f9c76cc0335` — the fixture bytes never changed in this campaign (§1.2.3) |
| Codex source checkout | `67727e7cf114cf3e1b71db368d74b24e32f6cb12` (main), `git status --short` clean, re-verified 2026-10-14; read-only throughout; still proves no source/binary correspondence |

**Contract regression matrix (exact commands, counts, skips, failures).**

| Command | Result |
| --- | --- |
| `npm run test:shell-research` | **451 tests / 449 pass / 2 fail / 0 skipped** (46 suites). The 2 failures are EXACTLY the known real-builder fixture pair (`the real builder failure-path prune stays inside clone metadata and preserves shared registrations`, `the real marketplace build and plugin install path yields an installable isolated fixture`) — adjudicated ENVIRONMENTAL below; recorded as failures-with-cause, never silently green |
| `node --test tests/test-selection.test.mjs` | **6 / 6 pass**, 0 skipped |
| `node --test tests/rescue-preparation.test.mjs tests/rescue-binding.test.mjs tests/rescue-route-planner.test.mjs` | **417 / 417 pass**, 0 skipped |
| `node --test tests/rescue-lifecycle.test.mjs tests/rescue-child-reconciliation.test.mjs tests/rescue-progress-relay.test.mjs` | **126 / 126 pass**, 0 skipped |
| `node --test tests/job-control.test.mjs tests/mcp-result.test.mjs` | **213 / 213 pass**, 0 skipped |
| `npm run lint` | exit 0, clean |
| `npm run typecheck` | exit 0, clean |
| `node scripts/check-line-endings.mjs` | LF verified in 534 tracked files |
| `git diff --check` | clean (exit 0) |
| `git status --short` | EMPTY |

Instrument-scope note: `git diff afa26ba..HEAD --stat -- tools/ tests/` is EMPTY — the shell-wait
instrument and test bytes at this HEAD are byte-identical to the §13.7 tree where the same suite
recorded **451/451**, so the two builder failures below cannot be an instrument or content regression.

**Environmental adjudication: the two real-builder shell-research failures (fresh reproduction on this
watch).** Both failures die inside the fixture's real marketplace-snapshot builder
(`buildMarketplaceSnapshot`), at the builder's consumer-side `npm install` step
(`scripts/build-marketplace-snapshot.mjs:175`), with the identical signature: the harness's own
`ZCODE_PROCESS_TIMEOUT` at 120000 ms and `capturedOutputBytes: 0` — npm hung without emitting anything,
npm's documented "Exit handler never called!" failure class. The builder runs under the fixture's
BY-DESIGN isolated home (`HOME`/`USERPROFILE` pointed at a fixture-owned empty sandbox directory,
`fixture.mjs`). Controlled reproduction for this close-out used byte-identical manifests
(`package.json` + `npm-shrinkwrap.json` copied to OS temp), so the only variable in each pair is the
HOME/cache environment:

| Arm | Environment | Result |
| --- | --- | --- |
| Control | real HOME (warm cache) | `npm ci --ignore-scripts --no-audit --no-fund` exit 0, 185 packages, ≈1 s |
| Experimental, twice | EMPTY sandboxed HOME (fresh cache), live registry | npm's own internal failure **"Exit handler never called!" both times** (70.2 s / 70.3 s); the npm debug log shows the run dying inside its fetch/extraction phase under the sandbox cache |
| Experimental, seeded | sandboxed HOME with the npm cache pre-seeded from the warm cache, `--prefer-offline` | **exit 0**, 185 packages, ≈2 s — the sandboxed HOME itself is NOT fatal; the failures track npm's fetch/extract path under the changed HOME |

Host-context facts recorded honestly: this host routes package traffic through a local proxy
(`http(s)_proxy` = `127.0.0.1:7890` in the inherited environment), and that proxy was observed REFUSING
connections during the reproduction window (a port probe was refused), which is why the two
empty-sandbox arms' debug logs show `ECONNREFUSED` on registry fetches. The failing test run itself had
progressed PAST the builder's `npm ci` and `npm pack` (both succeeded inside the fixture) before
hanging at the consumer install, so the test-run hang is the same npm-internal zero-output failure
class rather than the proxy refusal itself. The common adjudicated fact across the recorded occurrences
of this npm-install failure family — enumerated explicitly so the count is reconstructible: §13.8's
full-suite gate at this same HEAD (451 tests / 449 pass / 2 fail, EXACTLY this pair), this close-out's
shell-research run (the second recorded suite run with this exact pair), the first `npm test` run's
three npm-install tests, and the single-variable `package-install` experiment — is: npm malfunctions
inside its own install machinery specifically under the fixture's by-design sandboxed-HOME condition on
this host, every non-builder test passes regardless, and the identical instrument bytes recorded
451/451 at §13.7 under a healthy host environment.

**Verdict: ENVIRONMENTAL** — not an instrument, content or product regression; this is the SECOND
recorded suite run in which exactly this pair failed inside the builder (after §13.8's gate), within
the wider recorded npm-install failure family enumerated above. Reported as
failures-with-cause; no test was retried out of the record and no expectation was relaxed.

**Final `npm test` gate on clean exact source.** Commit authority WAS explicitly granted for this
branch, all implementation is committed, and the tree is clean — so the fully committed source at HEAD
`a6771a4` is the clean exact source, and no parking was needed for the IMPLEMENTATION. Three runs are
recorded, in order:

1. **First run, inherited host environment:** **3397 tests / 3391 pass / 3 fail / 3 skipped** (exit 1).
   The 3 failures — `isolated Codex marketplace lists and installs the eight-skill snapshot`
   (`tests/integration/marketplace-install.test.mjs:130`), `packed production install loads and locks
   on Node 22.13` (`tests/integration/package-install.test.mjs:25`), `future writable-concurrency ADR
   remains absent from real package and marketplace artifacts`
   (`tests/release-contracts.test.mjs:281`) — are the SAME environmental npm family as the
   shell-research pair: all three died as `ZCODE_PROCESS_TIMEOUT` at 120000 ms with
   `capturedOutputBytes: 0`, two inside `buildMarketplaceSnapshot`'s consumer `npm install` step and
   one inside the package-install test's own `npm install` step. None of the three test files is
   touched by this branch (`git diff 41e5b0aa..HEAD --stat` over them is EMPTY).
2. **Decisive single-variable experiment** (same committed source, same window): the identical
   `package-install` test FAILS with the host's proxy environment and **PASSES 1/1 with the proxy
   environment variables removed** (npm's direct egress works from this host) — isolating the host
   package-transport environment, not the source, as the failing variable.
3. **Full rerun with the proxy environment removed:** **3397 tests / 3393 pass / 1 fail / 3 skipped**.
   The single remaining failure is `isolated Codex marketplace lists and installs the eight-skill
   snapshot` failing in 31 ms with `Marketplace source tree must be clean, including tracked and
   untracked files.` — the clean-tree marketplace check running against THIS TASK'S OWN uncommitted
   close-out documentation edits, which were being written in the same worktree while that rerun
   executed. That is the spec §2-documented execution-order artifact (the same shape as the
   planning-session drafting failure recorded there), not a source or environment defect; every other
   routine test passed in that run.
4. **Definitive gate** (proxy environment removed AND the two close-out documentation files parked per
   the spec §2 owned park-and-restore method — documentation only, all tested implementation present,
   pre/post content hashes recorded and verified identical: report `c9b441b6…`, plan `a38380c8…`):
   **exit 0 — 3397 tests / 3394 pass / 0 fail / 3 skipped, plus the marketplace snapshot 2/2 pass** —
   exactly the planning baseline (**3397 tests / 3394 pass / 0 fail / 3 skipped** + marketplace
   snapshot **2/2**; the 3 skips are the inherited opt-in E2E guards, not win32). The parked files
   (exact paths `docs/qualification/rescue-shell-long-wait.md` and
   `docs/superpowers/plans/2026-10-13-rescue-shell-wait-follow-up.md`, sole occupants of stash entry
   "task7 close-out docs park for clean-tree npm test") were restored immediately afterwards and their
   restored bytes verified hash-identical. `test:mcp-research` and authenticated ordinary E2E were NOT
   run — the plan forbids inventing them as a new routine gate.

**Baseline diff and cleanup verification.**

- `git diff 41e5b0aa24189903f77acb971931df6de04a170e..HEAD --stat -- skills/ agents/ scripts/ hooks/
  .codex-plugin/ marketplace/ docs/superpowers/specs/` is **EMPTY** — no production, spec or
  marketplace change anywhere on the branch.
- The branch's TOTAL diff touches exactly five files: `docs/qualification/rescue-shell-long-wait.md`,
  `docs/superpowers/plans/2026-10-13-rescue-shell-wait-follow-up.md`,
  `tools/shell-wait-probe/driver.mjs`, `tools/shell-wait-probe/evidence.mjs`,
  `tests/shell-wait-probe.test.mjs`. `fixture.mjs` is untouched.
- Fixture-owned cleanup: a scan of the OS temp roots (`/tmp`, `$TMPDIR`) found **ZERO** surviving
  `zcode-shell-wait-fixture-*` directories (the fixture's mkdtemp prefix; the failed builder runs'
  disposal guarantee held on the failure path) and **ZERO** surviving campaign case-output directories
  (all ten §13.4–§13.7 private record directories are gone; §13.5's pre-existing
  `zcode-shell-wait-fixture-fHFp3c` scratch is no longer present either) and no
  `zcode-marketplace-build-*` leftovers. Nothing was deleted by this task.
- Unrelated OS-temp scratch observed and left untouched, recorded basename-only per the plan's
  preservation rule: `$TMPDIR/tmp.sKRbsPhH0o` (contains only a `package.json`; not campaign-owned), and
  this task's own reproduction scratch under `/tmp/task7-*` (six directories and nine log/hash files —
  known-temporary, disposable).

**Executed case ledger (Tasks 2–6: every live run of the follow-up campaign, all on the single
re-pinned 0.162.1 comparable pin of §1.2.3; Task 7 launched no host).**

| Task | Case / group | Runs | Outcome | Cause-directed follow-up |
| --- | --- | --- | --- | --- |
| 2 | `rescue-long` UNRAISED (M control) | 1 | inconclusive `unsupported-call-shape`; M `not-proven` on this pin | NOT consumed (no concrete cause with a single changeable variable) |
| 2 | `rescue-long` RAISED candidate | 1 | inconclusive, same family; `capVerified: true` is fixture-configuration retention only | (the comparable group's one follow-up left unspent) |
| 2 | `rescue-repeat` | 1 | inconclusive, same family; no qualified raised run exists on this pin to repeat | not consumed |
| 2 | `rescue-baseline` | 1 | inconclusive, same family; outer-return counts UNKNOWN, never zero | not consumed |
| 3 | `rescue-interrupt` | 1 | inconclusive; the first parsed AND counted V2 interrupt interaction on this pin (`callCount: 1`, success-decoded `previous_status: "running"`); target suppressed, ordering unbound | NOT consumed |
| 3 | `native-short-window-responsiveness-control` | **0 of 1** | deliberately NOT spent (no attributable `deliveryToSettlementMs` exists for it to serve) | n/a (separately named one-run group, no retry) |
| 4 | `rescue-noise` (its initial run WAS the plan's bounded diagnostic, retention-only gate) | 1 | inconclusive; the family is STRUCTURALLY ADJUDICATED (a statement variant outside both pinned grammars; fingerprint `38c33f61…`) | NOT consumed |
| 4 | `background` | 1 | inconclusive (fingerprint `a9d65bb2…`); budget-cleanup at 600010 ms; the settlement watch executed and never detected settlement; never labelled interruption | NOT consumed |
| 5 | `review-wait` | 1 | inconclusive — the early host exit CONFIRMED and traced (launch 1 / send 0, no poll, host exit 0 at 15214 ms; the command-side no-send cause is production-scope) | NOT consumed |
| 5 | `adversarial-review-wait` | 1 | **QUALIFIED** (`inconclusive: null`, §13.7) | none needed |
| 5 | `status-wait` | 1 | **QUALIFIED** (`inconclusive: null`; query deadline verified un-extended, §13.7) | none needed |
| 6 | generic qualification group | **0 of 1** | deliberately unspent — the precondition (a genuinely reachable ordinary generic condition) was adjudicated FALSE by the trace (§13.8) | none exists (structural cause) |
| 7 | close-out | 0 host runs | this section (matrix, final gate, mapping, handoff) | n/a |

Total: **10 live runs on one comparable pin**; every case-level cause-directed follow-up left
deliberately unspent; both separately named one-run groups (`native-short-window-responsiveness-control`
and the generic qualification group) left unspent. No case was retried out of the record.

**S1–S7 / Q1–Q6 close-out mapping** (per-item label, version, scope and precise remaining cause; the
historical rows of §11.1 stand unchanged as their own scope):

| Spec item | Close-out state |
| --- | --- |
| S1 preparation, atomic binding, one-shot/resume authority | `fixture-tested` fail-closed seams (§12) plus the inherited controlled suites re-verified green in the matrix above (preparation/binding/route-planner 417/417); `installed-observed` named-route launch-1/send-1/original-handle linkage on 0.160.1 (§7.1) and 0.161.0 (§7.7); on 0.162.1 the Rescue-Child-side preparation/binding linkage is `not-proven` (blocked by the unclassified-cell family, §13.4), while the Root-family qualified runs re-observed the owned two-turn flow (§13.7). Production negatives unchanged (zero production diff, below) |
| S2 one launch, original handle, empty observations, pending-cell ownership | `installed-observed` 0.161.0 (§7.7: one launch, one poll on the original handle, zero outer returns to natural completion); `fixture-tested` fail-closed observer (§12.4); 0.162.1 Root-family same-handle discipline observed in both qualified runs (§13.7); Rescue-Child pending-cell ownership on this pin `not-proven` (blocked) |
| S3 exact public output, errors, choice/resume/control | inherited result/choice/error suites re-verified green (job-control + mcp-result 213/213); byte-exact sentinel with `processExit: 0` `installed-observed` 0.161.0 (§7.7); on 0.162.1 the production-contract rendered marker matched in adversarial-review-wait and the confirmed JOB_WAIT_TIMEOUT framing matched in status-wait (§13.7); Rescue-Child terminal-byte linkage on this pin `not-proven` (blocked) |
| S4 placement matrix, background and Status observation-only | inherited placement suites green (matrix); background placement `not-proven` (R5 §7.7; 0.162.1 §13.6 — Root acknowledgement unattributable, budget-cleanup termination, settlement watch executed, never labelled interruption); Status observation-only behavior CONFIRMED on the qualified run's own record — the production 120000-ms query deadline fired UN-EXTENDED against the requested 3600000-ms observation window (`requestedPollMs`/`requestedStatusQueryTimeoutMs` remain separate record fields, §13.7); Review/Adversarial background enqueue-only re-verified by the controlled suites with no live background run |
| S5 interruption, reconciliation/loss, deadlines and ceiling | inherited loss/timeout/ceiling suites re-verified green (lifecycle/reconciliation/relay 126/126; no literal 100-hour run); native interruption: delivery path `source-confirmed` (V2 `interrupt_agent`, registered unconditionally in the owning exec Root at `67727e7c`, §13.5 trace) with ONE parsed counted interaction retained on 0.162.1 (`callCount: 1`, success-decoded active `previous_status`), delivery/settlement `not-proven` (§13.5); live Status-observation cancellation `not-proven` (no supported native interaction exists at the pin, §13.7); budget cleanup never labelled interruption (§13.6) |
| S6 named/generic alignment, no fallback weakening | named route `installed-observed` 0.160.1/0.161.0 (§7.1/§7.7); the generic spawn shape `source-confirmed` SUPPORTED at `67727e7c` yet PRECISELY UNAVAILABLE under ordinary capability conditions — mutually exclusive by construction (Role-preflight-ready ⇒ `agent_roles` non-empty ⇒ the V2 schema exposes `agent_type` ⇒ named is mandatory; the omitting state fails closed before any preparation exists, §13.8); parity guard unchanged; no fallback forced, faked or routed around |
| S7 isolation, no production/canonical/config changes | VERIFIED at close-out (below): the production/spec/marketplace diff against `41e5b0aa` is EMPTY; the branch's total diff is the report + plan + `driver.mjs`/`evidence.mjs` + `tests/shell-wait-probe.test.mjs` only, with `fixture.mjs` untouched; zero surviving fixture/case-output temp dirs; no user config, cache or Codex-source change |
| Q1/Q2 effective Child configuration and delivered instructions | configuration layers `source-confirmed` at `67727e7c` (§2); the installed Child's effective unraised cap M `not-proven` on 0.162.1 (§13.4 — the unclassified-cell blocker; the 0.161.0 bounded-but-imprecise state stands for its own pin, §7.7); delivered route instructions `installed-observed` named on 0.160.1/0.161.0 and `not-proven` on this pin (blocked); `capVerified: true` is fixture-configuration retention, never propagation evidence |
| Q3 timing, discriminator, re-entry and repeat | M `not-proven` (0.162.1, §13.4); raised-cap propagation `not-proven` on this pin with the M + 30000 precondition UNEVALUABLE (the 0.161.0 POSITIVE-but-M-imprecise clue stands for its own pin, §7.7); repeat QUALIFIED on 0.161.0 ONLY (§7.7 — the 0.162.1 repeat run itself ended inconclusive); the current-version re-entry comparison NOT ESTABLISHED (unknown counts stay unknown, §13.4) |
| Q4 noise, native interruption and sidecar latency | noise `not-proven` (the family shape-adjudicated to the retention design's limit, §13.6); native interruption delivery/settlement `not-proven` (§13.5); the sidecar structural policy `fixture-tested` and re-verified (162/162 + 76/76, §13.6; both suites re-green in the matrix), installed sidecar latency `not-proven` (no qualifying pending observation ever existed on this pin to steer) |
| Q5 Root waiting Skills | `adversarial-review-wait` QUALIFIED (`installed-observed`, 0.162.1, single run, no repeat claimed — exact Root linkage, launch 1/send 1, one 97800-ms same-handle poll, `processExit: 0`, the corrected production-contract marker matched, natural completion, no termination, §13.7); `status-wait` QUALIFIED (owned in-session acknowledgement → exact-id query, `validateStatusWaitFlow` `valid: true`, deadline un-extended; observation cancellation separately `not-proven`); `review-wait` `not-proven` (early exit confirmed and traced; launch 1/send 0; the command-side no-send cause is a production-scope question outside the probe). Each command carries its own verdict; none is inferred from another |
| Q6 smallest supported/version-scoped next delta | CLOSED at this close-out: proposed production scope = **ZERO changes** (below); spec §8's positive-recommendation criteria are NOT met on this pin; a future campaign needs the cell-shape classification prerequisite plus a current-pin re-measurement; version scope recorded per pin (0.160.1 / 0.161.0 / 0.162.1), never merged |

**Review-state record (honest, at close-out).** Tasks 1–4 closed with codex review gates at ZERO
findings (final amended SHAs `3fa035a`, `67d327d`, `0e50444`, `1fb30bd`). Task 5 (`afa26ba`) and Task 6
(`a6771a4`) carry clean self-reviews; their codex review gates are PENDING BACKFILL — the codex review
service suffered four consecutive network failures (2026-10-14 14:26→15:22 local: chatgpt.com
connection failed + workspace routing discovery failed; review interrupted), accumulating backfill
range `1fb30bd..a6771a4`. The whole-branch close-out codex review (the plan's independent Spec and
Standards review item) is also pending on the same service recovery. A tooling outage is NOT authority
to switch coding agents silently: this state is recorded as pending, never as passed, and no coding
agent was switched.

**Close-out independent Spec-and-Standards review: EXECUTED and recorded (2026-10-15).** A fresh
reviewer within the established ZCode-subagent workflow — NOT a substitution for the codex gates —
returned verdict FINDINGS with 4×P3 and zero P1/P2: spec conformance (scope/authority, coverage
honesty, claim honesty, completion rules, bounded-execution ledger: 10 live runs) and standards
(instrument discipline, docs conventions, commit hygiene, gates) otherwise CLEAN. The 3 fixable P3s
were applied in the dedicated close-out fix commit `f536375` — no rebase, because this report cites
exact SHAs as durable record (the attribution adjudication is that commit's body) — and the reviewer's
narrow recheck returned CLEAN with zero collateral change. P3-4 — the retention-only diagnostic flag
carried on Task 5's three formal runs — stands disclosed in §13.7 and is visible for the backfill
review. This closes the plan's Task 7 item 5 (recorded at its checkbox). The codex backfill state is
UNCHANGED and still pending: per-task gates for Task 5 (`afa26ba`), Task 6 (`a6771a4`) and Task 7
(`5224a76` onward, including this verdict record) plus the whole-branch review — the accumulated
backfill range now extends `1fb30bd..HEAD` — recorded pending, never passed.

**Codex backfill review: EXECUTED and recorded (2026-10-15); both pending records above are
RESOLVED.** After the host proxy (`127.0.0.1:7890`) was restored — the review service's outage
ultimately totaling SIX consecutive connection failures (2026-10-14 14:26→17:23 local; the
2026-10-14 records above captured the first four, 14:26→15:22) — the whole-branch codex review ran
to completion: `codex review --base 41e5b0aa24189903f77acb971931df6de04a170e` over the full branch
diff (`41e5b0aa..a1420f7`) returned ZERO findings ("No actionable regressions were identified").
This single review serves as BOTH the whole-branch overall review AND the backfill for the pending
per-task codex gates of Task 5 (`afa26ba`), Task 6 (`a6771a4`) and Task 7 (`5224a76`..`a1420f7`) —
their commits are all inside the reviewed range. The reviewer's own sandbox run showed 4 test
failures it attributed to its own sandbox permissions (npm cache access, process inspection),
consistent with this section's environmental adjudication — which was then VERIFIED BY PREDICTION:
with the proxy restored, `npm run test:shell-research` was re-run on HEAD `a1420f7` on 2026-10-15
and returned **451 tests / 451 pass / 0 fail / 0 skipped** (46 suites, ≈29.5 s) — the two
previously-failing real-builder fixture tests now pass, confirming the recorded verdict (the
failures were the host's dead proxy + npm's install machinery under the fixture's sandboxed HOME,
not instrument or product regressions). Review state complete: Tasks 1–4 per-task zero-finding gates
plus Tasks 5–7 backfilled via the whole-branch zero-finding review — recorded as executed and
passed, resolving (never silently replacing) the pending records above.

**Proposed production scope: ZERO changes (decision handoff).** The campaign's positive recommendation
criteria (spec §8: the actual Child route, a discriminating long observation and repeat, reduced
re-entry, exact handle/terminal linkage, and observed native interruption/settlement) are NOT met on
this pin — on 0.162.1 every measured managed-Rescue dimension is blocked by the single
unclassified-cell prerequisite (§13.4–§13.6), and the two qualified Root commands do not carry the
managed-Rescue recommendation. The current canonical remains the existing shell adapter and
instructions; MCP remains in its prior recorded state; nothing is auto-promoted. A future campaign that
could reopen the recommendation needs, minimally: (a) the unclassified-cell shape-classification
prerequisite resolved — which requires content-level evidence via a privacy-authority decision outside
the plan's authority, or a genuinely changed host/form (§13.6's adjudication limit; never a parser
expansion) — and (b) re-measurement of M, raised-cap propagation, repeat, re-entry and native interrupt
delivery/settlement on a current 0.162.x pin under that resolved prerequisite. Only after an explicit
human adoption decision may a separate production-change plan be written.

**2026-10-15 scope correction (superseded in scope by §13.10; everything above byte-unchanged).**
The "(a)" prerequisite above restates §13.6's adjudication limit; as a statement about the blocked
FAMILY it is over-strong — §13.6 adjudicated only the two cells its gate scanned, while the five
§13.4/§13.5 rescue-family cells predate the gate (observer provenance `e28ec619…` vs `b237a6e1…`;
the gate code landed in commit `1fb30bd`) and their `wholeBodyStatementMatch` is unmeasured and
retroactively unmeasurable. §13.10 records the corrected boundary (including the exact
`wholeBodyStatementMatch` semantics and the Path A next-phase candidate — not implemented, not run,
no allowance reset) and §13.11 the 2026-10-15 read-only source re-investigation at source pin
`dffa0deb…` (distinct from the executed campaign's `67727e7c…`; presence evidence only on the
installed binary, no source/binary mapping). The production scope above (ZERO changes) is unchanged.

**Temporary handoff (links).** Spec:
[2026-10-05-rescue-shell-long-wait-design](../superpowers/specs/2026-10-05-rescue-shell-long-wait-design.md)
(read-only; S1–S7, Q1–Q6, §8). Follow-up plan:
[2026-10-13-rescue-shell-wait-follow-up](../superpowers/plans/2026-10-13-rescue-shell-wait-follow-up.md)
(Tasks 1–7 checkboxes with recorded outcomes; §5 final review status). This report: §§1.2.3, 6.2, 7.7,
10, 11.1–11.3 and 13.1–13.11. Historical execution ledger:
[2026-10-05-rescue-shell-long-wait plan](../superpowers/plans/2026-10-05-rescue-shell-long-wait.md). Records: all ten live
case records are OS-temporary and now gone (ledger above + §13.4–§13.7 tables are the durable
summaries, as the plan intends); the campaign's durable review record is §11.3's gate/backfill state.

### 13.10 Close-out amendment (2026-10-15): boundary-assessment scope correction — the §13.6 two-cell adjudication limit does not extrapolate to the five pre-gate rescue-family cells; `wholeBodyStatementMatch` semantics stated exactly; Path A recorded as a NEXT-PHASE CANDIDATE only (documentation-only; no host launch, no code change, no allowance change)

This amendment incorporates a 2026-10-15 read-only feasibility assessment of the probe's call-shape
recognition boundary. The assessment's own provenance: scratch experiments against the REAL
instrument modules only (`evidence.mjs`/`driver.mjs` as committed at this HEAD), synthetic
candidates only, no repository file modified, no withheld content reconstructed, no host launched,
no user configuration read. This session verified the assessment's repo-side and checkout-side facts
directly before recording them (worktree HEAD `a386b73`, clean; the Codex checkout facts in §13.11).
The amendment changes no run record, no measured value, no verdict and no allowance; §13.6's and
§13.9's original texts above stand byte-unchanged, each with a dated superseded-in-scope pointer.

**The corrected conclusion scope.** §13.6's adjudication covered exactly TWO cells — the noise cell
(fingerprint `38c33f61…`) and the background cell (fingerprint `a9d65bb2…`) — both scanned by the
diagnostic gate (observer digest `b237a6e1…`; the gate code landed in commit `1fb30bd`, §13.6). The
five §13.4/§13.5 rescue-family cells (§13.4 runs 1–4: `exec_command` cells of 3 lines/443 B,
2/246, 4/336, 3/443; §13.5's run: 3/314 — all directive-less, content withheld) ran BEFORE the gate
existed: every one of those records carries the pre-gate observer digest `e28ec619…`, so their
`wholeBodyStatementMatch` is UNMEASURED. The assessment demonstrated — against the real modules —
that shapes consistent with those five cells' retained line/byte envelopes exist on BOTH sides of
the discriminator: defect-class members the module's own whole-body parser already accepts today
(e.g. a pretty-printed two-line `const r` form, or a >16-line single statement — the line bound is
splitter-only), and members outside both parsers. Line/byte facts do not discriminate. Therefore the
family-wide reading "only a privacy-authority decision or a host/form change can move this" is
OVER-STRONG for the five unmeasured cells; it remains correct for the two cells §13.6 actually
adjudicated (their whitelisted structural facts cannot select among the constructible form classes,
§13.6).

**Irretraceable boundaries are preserved, not relaxed.** All raw records are deleted (§13.9's
cleanup verification; §11.3); the withheld content of every historical cell is unresolvable without
new evidence — and unresolvable PERIOD for the five historical cells. The synthetic examples in the
assessment are FEASIBLE DEFECT CLASSES consistent with retained structural facts, NOT recovered
historical calls. A future gated run adjudicates only the NEW cell it observes; it can never
adjudicate the five historical flags retroactively. The model's shapes also varied run to run and
case to case (§13.4's varying byte/line facts; §13.6's two distinct fingerprints), so a fresh run may
show yet another shape or none at all.

**`wholeBodyStatementMatch` semantics, exactly.** The flag is computed by
`parseWrappedToolInput(raw)` (`tools/shell-wait-probe/evidence.mjs:284`) — the anchored WRAPPER+INLINE
statement patterns ONLY, not the full `parseCallEvent`, which additionally tries
`PREPARATION_PATTERN` and `ROOT_CONTROL_WRAPPER_PATTERN` first
(`tools/shell-wait-probe/evidence.mjs:685,713`). Consequences, per the final assessment: TRUE proves
a wrapper/inline-shaped, per-line-splitter-rejected cell — the pre-registered defect row (§13.6's
table). FALSE rules out the wrapper/inline-form defect classes ONLY — it does NOT exclude shapes the
existing `parseCallEvent` already accepts: demonstrated, a pretty-printed preparation with a LITERAL
envelope is accepted whole-body via `PREPARATION_PATTERN` (its envelope group spans newlines) and
reconstructs `chars` byte-identically to the pinned one-line form, while the flag records FALSE. Only
for the confirmed `exec_command` family — precisely the five §13.4/§13.5 cells — does FALSE carry the
narrowed exclusion "outside the whole-body grammar", because the preparation/root-control patterns
match only `write_stdin` / `interrupt_agent`|`send_input` heads and have no `exec_command` path, so
both FALSE readings coincide there.

**Path A: a NEXT-PHASE CANDIDATE, nothing more.** The candidate is ONE gated diagnostic run
(the existing `--unclassified-structural-diagnostic 1` retention-only gate; zero code change needed
for the diagnostic itself) of one rescue-family case (e.g. `rescue-long`) on a re-pinned current
binary, under a NEW plan delegation. `wholeBodyStatementMatch: true` → the campaign's own
pre-registered defect row (§13.6's table) → only then consider the minimal RED→GREEN fallback below.
FALSE → for an `exec_command` cell, that coincides with "outside the whole-body grammar" on that
FRESH run, and the §13.6-style conservative adjudication holds for it. NOT implemented, NOT run in
this close-out; no historical allowance is reset or silently reused — the `rescue-long` group's
formally unspent follow-up remains unreachable inside the closed plan (§13.4's ledger), and a Path A
run is a new plan's budget, recorded as such, with the binary re-pinned first (auto-update risk, §10).

**Candidate fallback safety constraints (recorded so a future implementation cannot drift).** Any
minimal fallback reuses the module's OWN parser (`parseCallEvent`) on the RAW body — directive
INCLUDED, never pre-stripped; strip-then-parse is FORBIDDEN (it bypasses directive validation and
silently drops a valid directive). It must preserve: directive validation and reattachment
(invalid-directive cells keep rejecting exactly as today; a parsed directive is reattached to the
returned statement so reconstruction/preparation semantics are unchanged); whole-body anchoring with
hidden-trailing-statement rejection (the anchored patterns reject any cell with content beyond the
one statement — no smuggling path); and all existing bounds. Honest coverage limit: the
PREPARATION and ROOT_CONTROL branches match the unstripped input first and cannot match
directive-prefixed input, so a raw-parse fallback would NOT admit directive-prefixed
preparation/root-control cells — a fail-closed COVERAGE LIMITATION, not a safety problem; one branch
does not cover all forms. NOT permitted in the candidate: unknown statements, skipping unparseable
lines, trailing content after a statement, widening the tool alternation, trailing commas or unknown
literal syntax, eval/Function/vm, any general interpreter — the spec's own boundary ("no general
interpreter", spec §4/§7).

**Review provenance (attribution kept precise).** The assessment carries its own recorded review
chain — the assessor's boundary assessment; an independent double-adversarial verifier returning
CONFIRMED-WITH-CORRECTIONS with four P3 findings, all fixed; then a read-only codex adversarial gate
executed three times, converging to CORRECTIONS-ADEQUATE (65 assertions checked). These are
ASSESSMENT-side records: this close-out session did not re-execute them and inherits them as
recorded history only. The campaign's existing test and whole-branch reviews belong to their tested
HEADs and reviewed range (§11.3 — the whole-branch review covered `41e5b0aa..a1420f7`, which does
not include this amendment). This amendment's own verification is recorded as its own state in
§11.3's dated note; any commit-level CI/review for the eventual doc commit will be recorded as its
own. No result is reused across them.

**Delivery boundary (unchanged).** Production recommendation: ZERO changes; canonical/config
unchanged; spec untouched; no closed-plan task reopened. The two qualified Root observations (§13.7)
and the Status-observation-cancellation `not-proven` keep their own boundaries — no extrapolation to
all commands.

### 13.11 Source re-investigation (2026-10-15, read-only, source pin `dffa0deb…`): the three wait layers are distinct, inheritance is config-real, the outer default is NOT new, and the genuine default change is `code_mode_interrupt` — presence evidence only on the installed binary; no source/binary mapping, no production change

All claims in this section are `source-confirmed` at
`dffa0deb69268ed4ac31578794c9ea897b336ae3` unless labelled otherwise; every citation reproduces as
`git show dffa0deb69268ed4ac31578794c9ea897b336ae3:<path>` at the recorded line range. The user's
Codex source checkout (`/Users/zhangzikai/Workspace/Codes/github/codex`; from this worktree
`../../../codex`) was re-verified 2026-10-15: this NEW pin is DISTINCT from the executed campaign's
pin `67727e7cf114cf3e1b71db368d74b24e32f6cb12` (2026-09-30), which remains the pin of §§2/3/13.5/13.8's
`source-confirmed` records — both pins are recorded and never mixed. Read-only throughout: no fetch,
build, test run, or edit; no user configuration was read. The installed CLI at investigation time was
0.162.1 (the §1.2.3 pin); a read-only strings-level check found the three known configuration-name
strings (`background_terminal_max_timeout`, `default_exec_yield_time_ms`, `code_mode_interrupt`) in
the installed binary — PRESENCE EVIDENCE ONLY: no source/binary correspondence is claimed, no
configuration is claimed effective, deployed or verified, installed interruption behavior is not
claimed, and no token measurement exists anywhere in this section.

**The three wait layers are DISTINCT — no single configuration is a universal switch.**

| Layer | Mechanism at the pin | Limits that must be preserved |
| --- | --- | --- |
| Inner terminal observation (empty `write_stdin`) | Empty-input polls clamp to `[5000, manager cap]`; the manager cap resolves `background_terminal_max_timeout.unwrap_or(300000).max(5000)` (constants `MIN_EMPTY_YIELD_TIME_MS = 5000`, `DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS = 300000` — `codex-rs/core/src/unified_exec/mod.rs:68-74`; clamp `codex-rs/core/src/unified_exec/process_manager.rs:1029-1043`; resolution `codex-rs/core/src/config/mod.rs:4027-4030`; TOML field `codex-rs/config/src/config_toml.rs:345-347`) | The cap is an UPPER BOUND — a long observation still requires an explicit long `yield_time_ms`; an omitted yield is ≈5000 ms (the argument's 250-ms default is clamped up — `codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs:23-32`). Non-empty writes stay ≤30000 ms and the first `exec_command` yield clamps to `[250, 30000]` ms (Windows floor 10000) regardless of config (`codex-rs/core/src/unified_exec/mod.rs:212-218`). Raising the cap alone lengthens nothing: the production Skill's 60000-ms window does not become an hour by raising the cap alone |
| Outer code-mode cell | `features.code_mode.default_exec_yield_time_ms` (`codex-rs/features/src/feature_configs.rs:36-43`) is the wait filled into exec requests WITHOUT an explicit pragma — core default 30000 ms (`codex-rs/core/src/config/mod.rs:1200,1219`; resolution `:2778-2792`; filled via `get_or_insert`, `codex-rs/core/src/tools/code_mode/mod.rs:130-135`). The protocol's bare 10000-ms constants are NOT the effective core default (`codex-rs/code-mode-protocol/src/runtime.rs:15-16`). In the examined core-default paths there is NO fixed 30-second outer hard cap: the runtime applies `min()` only against a session-EXPLICIT `max_yield_time_ms` (`codex-rs/code-mode-runtime/src/service.rs:29,71,140,201`) | An explicit shorter `@exec` pragma wins over the configured default; an ALREADY-YIELDED cell's outer `wait` has its own independent 10000-ms default and does NOT read the exec default (`codex-rs/core/src/tools/code_mode/wait_handler.rs:30,37-39,134-141`); an active explicit yield, user input/preempt, resource limits, cancellation and REAL JS completion can each return earlier than any configured window (ordinary output buffers do not end the observation; only the `Result`-terminated completion path does — `codex-rs/core/src/tools/code_mode/execute_handler.rs:135,146-147`) |
| Root-for-Child V2 wait | `features.multi_agent_v2.default_wait_timeout_ms` with min/max — source defaults 30000 / 10000 / 3600000 ms (`codex-rs/core/src/config/mod.rs:257-264`; struct `:1369`; validation `:3957-3992`); the V2 wait handler reads them from the per-turn config (`codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs:53`) | A Child's long wait says nothing about the Root not waking early: mailbox/user-input activity can wake the wait before the deadline (`codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs:213-220`). The machine's ACTUAL runtime configuration was NOT read this round — only source defaults are recorded |

**Inheritance is config-real, not prompt-only.** The inner cap and the code-mode default reach the
actual Child through the full parent effective-`Config` clone — `build_agent_shared_config` starts
from `turn.config.clone()` (`codex-rs/core/src/agent/child_config.rs:110-164`; the same clone-based
helper serves fresh spawn and resume) — and the Child session constructs its terminal manager and
code-mode service from that config: `UnifiedExecProcessManager::new(config.background_terminal_max_timeout)`
(`codex-rs/core/src/session/session.rs:1725-1732`) and `CodeModeService::new(…, &config.code_mode, …)`,
which copies `default_exec_yield_time_ms` into the service field
(`codex-rs/core/src/session/session.rs:1818-1823`; `codex-rs/core/src/tools/code_mode/mod.rs:86-103`).
The two keys are NOT in the Role typed whitelist (`codex-rs/core/src/agent/role.rs:36-47`) — adding
arbitrary fields to a Role file does not achieve a Role-scoped override. Loaded sessions do not
hot-reload: an already-loaded Child is reused as-is, and an owner-validated reload builds a NEW
Session from a fresh clone — a running service never picks up config-file edits automatically.

**The outer default is NOT new.** It was introduced 2026-08-07 by
`d0c8f422eaaa40b3927b43a0fff7e753e8514f34` ("Configure the default code-mode exec yield timeout
(#37352)", 2026-08-07T01:41:54Z), which is an ancestor of the OLD pin `67727e7c…` (verified by
merge-base), so the executed campaign's own source pin already contained it. Correct framing: a
PREVIOUSLY UNDER-EXPLOITED/UNDER-VERIFIED entry point whose verification coverage should be filled
in — never "the host only now supports long waits".

**The genuine default change is interruption.** `72c959528ee4ca74abdb8575fbbc4e36960a8c47`
(2026-10-07, "Enable code mode interruption by default (#51835)") flipped `code_mode_interrupt` from
UnderDevelopment/default-false to Stable/default-true (`codex-rs/features/src/lib.rs:1197-1202` at
`dffa0deb…`; the old pin records `Stage::UnderDevelopment` / `default_enabled: false` at
`codex-rs/features/src/lib.rs:1103-1108`). Consequence chain at the new pin: the turn-abort path
awaits `interrupt_active_cells()` when the abort reason is `Interrupted` AND the feature is enabled
(`codex-rs/core/src/tasks/mod.rs:960-971`), which terminates each active code-mode cell
(`codex-rs/core/src/tools/code_mode/mod.rs:164-178`) and cancels nested pending tool futures — so a
native Interrupt, or an exact-Child `interrupt_agent`, need not wait out a long observation window.
Boundaries that survive: this does NOT auto-clear the terminal process store (a cancelled poll future
releases only its own process clone; the terminate-all path is the separate clean/shutdown route); it
is NOT Companion-process stop, ZCode-job stop or durable settlement — the plugin's exact
stop/reconciliation/no-collateral-cancellation contract still needs its own verification; and the
interrupt tool's `previous_status` is a PRE-interruption status snapshot, not a completion
confirmation (consistent with §13.5's recording).

**Token framing (mechanism only; nothing measured).** The source turn loop awaits the drain of
in-flight tool futures within one sampling (`codex-rs/core/src/session/turn.rs:2565,3280`) — there is
no wall-clock re-sampling that restarts the model on a timer. Shortened observations that return to
the model add repeat decision/sampling opportunities, so lengthened windows have a MECHANISTIC BASIS
for fewer repeat samplings — and nothing more: no whole-task-zero-token claim, no infinite-wait
claim, no percentage-savings claim.

**Priority framing.** The 0.162.1 campaign's `unsupported-call-shape` outcome (§13.4–§13.6) was
INSUFFICIENT EVIDENCE — it is not evidence that the host removed or lacks long-wait capability, and
the shell route must not be concluded infeasible from the inconclusive. The sensible next sequence
(as the source investigation itself recommends): first confirm the installed host's two-layer
effective configuration and interruption capability, and resolve the probe recognition boundary
(§13.10's Path A candidate); only then consider small-scale verification. This section authorizes no
production Skill/Role/config change (spec S7; §13.10's delivery boundary).

## 14. 2026-10-16 config-path-a execution log

Task 1 of the 2026-10-16 plan (`docs/superpowers/plans/2026-10-16-rescue-shell-wait-config-path-a.md`)
was executed on 2026-10-16 in worktree
`.worktrees/rescue-shell-wait-config-path-a` (branch `docs/rescue-shell-wait-config-path-a`).
Read-only throughout: zero model turns, zero authenticated host launches, no managed fixture, no
code or test modification, no user configuration read or written (every installed-CLI probe ran with
a throwaway empty `CODEX_HOME`). The run ledger stands at **A0/A1/C0/C1 all unspent** — local CLI
inspections (`--version`, `--help`, `features list`) are not qualification runs and consumed no
label. This section records new facts only; §§1–13 and every historical flag/verdict above stand
byte-unchanged, and current-state pointers remain for the close-out task to update.

**Pins (re-pinned at execution time, per the plan's re-pin requirement).**
Committed plugin baseline `61853ab0faa0ceb55c68504d737daed3e91b9ee8` (the PR #67 merge; pre-commit
worktree status: only the untracked plan plus the three preserved drafting scratch files, zero
modified tracked files). Installed native CLI, resolved by realpath of `command -v codex` (never the
npm development-dependency pin): `/Users/zhangzikai/.codex/packages/standalone/releases/0.163.0-aarch64-apple-darwin/bin/codex`,
reporting `codex-cli 0.163.0`, sha256
`8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31` — the same 0.163.0 as the
drafting observation; the re-pin is recorded regardless. Codex source checkout still exactly
`dffa0deb69268ed4ac31578794c9ea897b336ae3` with an empty `git status --short` (clean; the drafting
pin needed no correction, and no newer checkout bytes were read). Model selection basis: the probe's
host argv carries no model flag (`CODEX_EXEC_COMMON_ARGUMENTS` / `composeHostLaunchArguments`,
`tools/shell-wait-probe/driver.mjs:1780-1784` and `:1703-1711`), so `codex exec` resolves the
installed CLI's own default and the instrument cannot observe it — records persist `model: null` by
design (`EXECUTING_OBSERVER_PROVENANCE`, `driver.mjs:49-60`); the fixture's synthetic `model: 'gpt'`
hook payload (`fixture.mjs:737-738`) is fixture plumbing, not a live selection fact.

**§13.11 recheck: every citation re-verified at the recorded pin via `git show dffa0deb…:<path>`;
all CONFIRMED; none contradicted, none absent.** The three wait layers stand exactly as §13.11
records them: inner clamp constants `codex-rs/core/src/unified_exec/mod.rs:68-74` with the
`process_manager.rs:1029-1036` clamp, `core/src/config/mod.rs:4026-4029` resolution,
`codex-rs/config/src/config_toml.rs:345-347` TOML field, `write_stdin.rs:23-32` serde-default
argument and `unified_exec/mod.rs:212-218` exec-yield clamp; outer code-mode default
`codex-rs/features/src/feature_configs.rs:38-43` (field at :43), core default
`core/src/config/mod.rs:1200` (`30_000`) and `:1219`, resolution `:2778-2792` (table lookup
`:3060-3066`), and the `CodeModeService::execute` absent-yield fill
`core/src/tools/code_mode/mod.rs:130-137` (`get_or_insert`); protocol 10_000 constants
`code-mode-protocol/src/runtime.rs:15-16` with the runtime `min()` only against a session-explicit
`max_yield_time_ms` (`code-mode-runtime/src/service.rs:201-212`, fallback :71, `YieldAfter`
:76/:140); independent wait handler `tools/code_mode/wait_handler.rs:30,38-40,134-141` (10_000,
never reads the exec default); non-`Yielded`-only cell end `tools/code_mode/execute_handler.rs:135,146-149`;
V2 wait constants `core/src/config/mod.rs:257-259`, struct `:1368-1373`, validation `:3957-3992`,
per-turn-config reads `handlers/multi_agents_v2/wait.rs:53-55` and mailbox wake `:213-220`;
config-real inheritance `agent/child_config.rs:132-133` (`turn.config.clone()`, serving spawn
:110-122 and resume :124-130) with `session/session.rs:1730-1731` and `:1818-1823` constructing both
services from the child config; Role whitelist `agent/role.rs:36-47` excluding both keys (bool-only
`features` map). Interrupt path at the pin: `features/src/lib.rs:1197-1202` (Stable,
default-enabled), `tasks/mod.rs:960-971` (feature-gated `interrupt_active_cells()`),
`tools/code_mode/mod.rs:164-179`, `session/turn.rs:2565,3280`. Historical cross-checks
re-verified: old-pin `code_mode_interrupt` `UnderDevelopment`/false at `67727e7c…`
`features/src/lib.rs:1103-1108`; flip commit `72c959528ee4ca74abdb8575fbbc4e36960a8c47`
(2026-10-07, #51835); `d0c8f422…` an ancestor of the old pin by merge-base. Exact at-pin line
numbers drift from §13.11's recorded ranges by at most ±3 lines and are recorded in the plan's
execution ledger; the drift changes no claim.

**Config transport: the candidate is accepted as the supported seam; Task 4 will use it unchanged.**
The decision (recorded locally by Task 1; the driver change itself belongs to Task 4): add
`-c features.code_mode.default_exec_yield_time_ms=<finite positive integer ms>` to the isolated host
argv inside `CODEX_EXEC_COMMON_ARGUMENTS` — after the existing `-c shell_environment_policy.inherit=all`,
still before `-C <workspace>` and the prompt — preserving every existing argument; the driver already
ships a dotted `-c` override in exactly that block. Source mapping at the pin: clap-global
`CliConfigOverrides` (`codex-rs/utils/cli/src/config_override.rs:19`, with `parse_overrides` at
:49-84 parsing the value as TOML and falling back to a raw string at :72-78); dotted-path layer
`codex-rs/config/src/overrides.rs:9-27`; CLI layer
merged last, highest precedence (`codex-rs/config/src/loader/mod.rs:256-265,346-347`);
`FeaturesToml.code_mode: Option<FeatureToml<CodeModeConfigToml>>` (`features/src/lib.rs:871-872`;
untagged enum :990-993) resolving through `resolve_code_mode_config` into `Config.code_mode` and the
service field (session.rs:1818-1823; get_or_insert mod.rs:130-137). The fixture home's
`config.toml` contains no competing `[features.code_mode]` table (setup writes only the cap key,
`fixture.mjs:853-862`). Acceptance evidence (installed 0.163.0, isolated empty `CODEX_HOME`, no
model turn): `-c features.code_mode.default_exec_yield_time_ms=30000` and `=240000` with
`features list` exit 0 with the full feature table — that command loads and deserializes the config,
so acceptance is real. Negatives: `…=abc` and a bogus subkey `features.code_mode.not_a_real_key=1`
both exit 1 with `data did not match any variant of untagged enum FeatureToml in features.code_mode`,
proving the key path and numeric type are genuinely validated against `CodeModeConfigToml`; an
unrelated dotted key (`definitely.not_a.key=1`) exits 0 silently ignored (the driver passes no
`--strict-config`). Recorded caveat: `codex -c … --version` short-circuits BEFORE config
deserialization — even the malformed value exits 0 there — so `--version` is argv-parse acceptance
only and is never cited as key-validation evidence. Privacy projection: the current driver persists
NO argv (`HeldTurnRecord`, `driver.mjs:1263-1282`; `buildCaseRecord`, `driver.mjs:545-588` —
whitelisted facts only), no config content and no auth material anywhere; the fixture `config.toml`
lives in the disposed fixture home and survives in records only as the `capVerified` boolean plus
the whitelisted `requestedCapMs` numeric. Task 4 must add its own closed whitelisted numeric
provenance field for the selected value; until then the record schema stays byte-identical. As
always: successful parsing is acceptance, not effective runtime proof — propagation to the actual
Child is precisely what C0/C1 must establish.

**`code_mode_interrupt` — four separated evidence classes; no force-enable, no live interrupt, no
Companion/job-settlement inference.** Source at `dffa0deb…`: Stable/default-true
(`features/src/lib.rs:1197-1202`) gating the abort-path `interrupt_active_cells()`
(`tasks/mod.rs:960-968` → `tools/code_mode/mod.rs:164-178`). Default: flipped 2026-10-07 by
`72c95952…` (#51835); the old campaign pin records `UnderDevelopment`/false. Installed-accepted
(0.163.0 binary only): `codex features list` prints `code_mode_interrupt  stable  true` under an
isolated home; strings presence in the binary (`code_mode_interrupt` ×7, `default_exec_yield_time_ms`
×14, `background_terminal_max_timeout` ×25); `--help` documents `--enable/--disable <FEATURE>` as
`-c features.<name>=true/false`. Not proven: any runtime effect — installed poll/Companion-job
cancellation, durable/no-collateral settlement, plugin stop/reconciliation — which remains a later
qualification obligation under spec S5.

**Test suites (nothing fixed, no dependency changes, no `npm audit fix`).**
`npm run test:shell-research`: 451 tests, 451 passed, 0 failed, 0 skipped (46 suites).
`node --test tests/test-selection.test.mjs`: 6/6 passed. `node scripts/check-line-endings.mjs`:
exit 0, LF verified in 534 tracked files.

**Exit state.** Execution pins and a supported candidate config transport are recorded with no
installed wait/cancellation claim. Source/binary correspondence remains UNESTABLISHED — both are
0.163.0-generation and the source key validates on the installed binary, but no effective runtime
effect has been demonstrated. Tasks 2–5 of the plan remain open; no live allowance was spent and no
historical record, claim, flag or pointer above was altered.

**Task 2 (2026-10-16): A0 SPENT — the fresh-cell adjudication is the plan §3 FALSE-with-confirmed-`exec_command` branch: decisive exclusion for that ONE fresh cell; no parser defect demonstrated; A1 not justified; C0/C1 remain unspent with admission blocked.** Task 2 of the plan was executed in the
same worktree (branch `docs/rescue-shell-wait-config-path-a`) at committed HEAD
`1f8f684cb0a264e9b2c470937c8394ff2eb312fa` — the exact state passed as `--source-sha` and the exact
state the executing observer ran. The plan's Task 2 command was run EXACTLY ONCE, verbatim: no flag
changed, `--cap-ms` omitted entirely (recognition hold, not the cap discriminator — `requestedCapMs`
and `capVerified` are null by design), `--unclassified-structural-diagnostic 1` active (record
`unclassifiedStructuralDiagnostic: true`), private fresh output dir
`/var/folders/vw/4_44w0fs2sbgkzyzzvdn6jx40000gn/T/tmp.Bdv8eaYDJ7` (outside the repo; sole record
`rescue-long.record.json`), combined stdout+stderr captured to a scratch log under `/tmp`. Driver
exit **0** — which per §3 is not a qualified case — wall ≈212 s (02:43:21Z→02:46:53Z), inside the
360000 ms budget. No code or test file was modified before or during the run (tracked
`tools/`/`tests/` diff against the merged baseline `61853ab…` is EMPTY); no raw cell body, auth
material, full config or private preparation content was persisted anywhere in the repo.

**At-run pins.** Binary unchanged from Task 1's re-pin: realpath
`/Users/zhangzikai/.codex/packages/standalone/releases/0.163.0-aarch64-apple-darwin/bin/codex`,
`codex-cli 0.163.0`, sha256 `8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31` —
no auto-update, no re-pin needed. Record provenance: `codexVersion: "0.163.0"`, plugin
`zcode@vitry` 0.1.0, `sourceSha: 1f8f684c…`, `sourceWorktreeOwnedByFixture: true`,
`sourcesChangedDuringRun: false`; executing observer `working-tree-uncommitted`, digest
`9e764bfde1c8fbabfa4711a1d21efb1aa3778f686a18676d323b7a495c1a0c33` (digestInput
`zcode-shell-wait-observer-v1 || evidence.mjs || driver.mjs`, executing module-init snapshot,
NUL-separated). **`model: null` and `reachableToolFamily: null` persist by design**
(`EXECUTING_OBSERVER_PROVENANCE`): the instrument cannot observe the CLI's own default-model
resolution, so no model claim exists. Fixture controls recorded as fixture controls:
`fixtureVariant: "candidate"`, sandbox/hooksTrust bypasses "not persisted production trust".

**Fresh-cell fingerprint (sanctioned structural facts only; raw content withheld by the gate).**
Exactly ONE unclassified cell was collected (`evidence.count: 1`, `truncated: false`; classification
`unclassified-script-cell`; the gate's own suppression text records that the raw body is withheld).
Confirmed tool family **`exec_command`** — both the top-level `tool` field and the diagnostic's
per-line `tools: ["exec_command"]`. Envelope: `bodyType: "string"`, **2 input lines / 243 bytes**,
directive absent (`directivePresent: false`, `directiveKeys: null`, `withheldDirectiveKeys: 0`).
Gate line diagnostic: a single listed line (line 1) with prefix class `const-r-await`,
`braceDepthEnd: 0`, `endsWithSemicolon: true`. **`wholeBodyStatementMatch: false`.** Fresh cell
sha256 `fa76ae3ce693cbcbd090d47056d7ccb27639dafc0565f763365a7ce2b3a0ad40` (fresh flag + cell
fingerprint pair for this run). The case outcome is `unsupported-call-shape` (needs manual
adjudication) — a NOT-QUALIFIED case; no wait/capability claim follows from it in either direction.

**Decision-branch application (§3, per fresh cell, never historical).** The FALSE branch fired with a
CONFIRMED `exec_command` family, so §3's second branch applies: **the wrapper/inline exclusion is
decisive for this fresh exec family, and no fallback is justified by this cell.** Instrument-side
verification at this HEAD (read-only; code identical to the merged baseline): `wholeBodyStatementMatch`
is computed by `parseWrappedToolInput` (`tools/shell-wait-probe/evidence.mjs:284`, implementation
:853-873), which tries ONLY `WRAPPER_PATTERN` (:49) and `INLINE_WRAPPER_PATTERN` (:53);
`parseCallEvent`'s other whole-body paths are `PREPARATION_PATTERN` (:67, `write_stdin` head) and
`ROOT_CONTROL_WRAPPER_PATTERN` (:1052, `interrupt_agent`/`send_input` heads) — there is NO
`exec_command` path outside the wrapper/inline patterns, so both FALSE readings coincide (§13.10's
recorded semantics) and the proposed Task-3 fallback (which reuses `parseCallEvent` on the raw event)
could not accept this cell. Consequences, exactly per §3: **A1 remains unspent and NOT justified**
(no demonstrated parser defect; Task 3 is not applicable with this recorded cause), and because
admission remained blocked (below), **dependent managed-Child trials stop — C0 and C1 remain
unspent/BLOCKED**, and Task 4's model turns are gated off. Boundaries kept: this adjudicates ONLY
the fresh cell sha `fa76ae3c…` at observer digest `9e764bfd…`; the five historical 0.162.1
pre-gate rescue-family flags (§13.4/§13.5) are NOT relabeled and their content remains unknowable;
FALSE does not prove long waits impossible — it classifies one cell against one observer grammar;
no new grammar is authorized and none was added.

**Measurability of the managed route: exact managed-Child linkage NO; the fresh cell's shape YES
(measured by the gate).** `route.requested: "rescue-foreground"` but `route.actual: null`;
`childLinkageChecked`, `originalHandleChecked`, `companionLaunchCount`, `companionSendCount`,
`rootThreadId`, `childThreadId`, `parentThreadId`: all null — the case terminated at the
unsupported-call-shape gate before route/ownership verification, so the route was NOT measurable in
this run. Per-dimension unknowns, each with cause: `outerReturns`, `modelCalls`, `rootJoins`,
`decisiveWallMs`, `pollWallTimesMs`, `pendingInnerAtEnd` — all null, and
`remainingLifetimeBasis: "unavailable"` — cause: admission blocked at shape classification before
any measurable outer-return/poll state existed. Exact terminal stdout/error/choice linkage NOT
established: `publicResultMatchedSentinel`, `terminalStdoutChecked`, `resultCheck`,
`resultCheckLabel` null (`hostExit: 0` recorded; `processExit` null). Child settlement NOT observed
(`settlement.observed: false`, `settlementDetectedAtElapsedMs` null). Held-turn timeline (monotonic
elapsed-ms, sanctioned): launched 1, observationDetected 34750, pollStarted 68787, holdDeadline
164750, rootAcknowledgement 185197, ended 185201, `gateReleased: true`, `endedBeforeGate: false`,
cleanup label `observation`. `interrupt.callCount: 0` / `requested: false` (no interrupt, by plan).
Instruction provenance: `isolatedSetup` `sessionEstablished: true`,
`launcherDescriptorPublished: true`, `setupAttempts: 2`, `roleStatus: "ready"`, owningSessionId
`b7cb574e-0d07-413d-83c3-0d33b758de2e`; named/generic variants applied (before/after hashes in the
record; `namedRoleSha256: d2d2aa35…`, `genericMessageSha256: 1b7762…`), the three Root-owned command
Skills at `baseline` with zero differences.

**Cleanup: owned fixture cleanup happened (driver-reported).** `fixtureDisposed: true`,
`disposalError: null`, `cleanupComplete: true`, `cleanupErrorCount: 0` (and
`cleanupErrors.count: 0`). Recorded honestly alongside: `processTermination.verifiedTerminated:
false` / `codexTerminated: false` — the "observation"-label cleanup is budget cleanup, NOT native
cancellation or verified process termination (§3), and it supports no settlement/interruption claim.

**Ledger and claim discipline.** Run ledger after Task 2: **A0 SPENT (the one-shot allowance is
consumed); A1 unspent and not justified; C0/C1 unspent and blocked — no live run remains reachable
under §3's dependency rules, and no new run authority is created by this outcome.** This entry adds
recognition facts ONLY, consistent with S1–S7/Q1–Q6 discipline: no long-wait measurement exists, no
M/raised-cap propagation claim, no interrupt or settlement claim, no config-effect claim, and no
production or user configuration change followed (zero production/config edits; the only repo writes
are this log's block and the plan's ledger/checkbox updates). Current-state pointers remain for the
close-out task; §§1–13 and all historical records above stand byte-unchanged.

**Tasks 3–4 adjudicated NOT APPLICABLE (recorded 2026-10-16, Task 4's record commit; purely
additive).** The root adjudicated both conditional tasks under the plan's own conditional discipline;
no host was launched, no code or test file changed (the tracked `tools/`/`tests/` diff against the
merged baseline `61853ab…` remains EMPTY), and only the plan and this log were written.

**Task 3 (conditional raw-body fallback + A1): NOT APPLICABLE.** Cause: A0's fresh cell was
`exec_command` with `wholeBodyStatementMatch: false` — §3 branch 2 — so no parser defect was
demonstrated, and the fallback algorithm could not have accepted that shape: `parseCallEvent` has no
`exec_command` whole-body path outside the wrapper/inline patterns (verified instrument-side at this
HEAD, `evidence.mjs` :49/:53/:67/:284/:853-873/:1052; consistent with §13.10's recorded semantics).
A1 is therefore unspent/not justified. Governing plan rule: "No speculative parser implementation if
A0 did not demonstrate the defect."

**Task 4 (config-default seam + C0/C1): NOT APPLICABLE as a live comparison, and its code work
skipped.** Cause chain, kept precise: Task 1 DID find a supported transport — this is NOT the
no-seam case — but Task 4's own gate fails: "Only proceed to model turns if the managed route can be
admitted/measured after Tasks 2/3." A0 left `route.actual: null` with admission blocked at
`unsupported-call-shape`, and §3 branch 2 orders "stop dependent managed-Child trials". C0 and C1
are therefore unspent/blocked; no comparison pair ran, and the one-changed-variable discipline was
never reached. The `--wait-policy`/`--exec-default-ms` options, the isolated waiting-paragraph
variant and the synthetic comparison tests are NOT implemented: their only consumer under this
plan's finite ledger would be the blocked C0/C1, and the conditional discipline (Task 3's
"no speculative parser implementation" analogue) forbids building unreachable instrument code. A
future plan may re-derive its own instrument fresh; nothing here presumes or pre-provisions it.
Task 1's transport acceptance evidence stands unchanged as acceptance-only (never propagation
proof), and its hygiene rules (closed validation, whitelisted provenance) remain the recorded
template for any re-derivation.

**Classification and ledger.** The C-prerequisite is classified **`not-proven` with a precise
bounded cause**: recognition/admission blocked at A0 — the actual named managed route was not
measurable in this campaign, so the configured outer exec default's effect was never exercised.
Run ledger after adjudication: **A0 SPENT; A1 unspent/not-justified; C0 unspent/blocked; C1
unspent/blocked (dependent on C0). Total live runs spent: 1 of 4. No new run authority is created.**

**Two conclusions kept separate, and the standing boundaries.** Recognition was NOT restored — the
fresh `exec_command` cell remains excluded by the executing observer's whole-body grammar, and no
grammar change was made or authorized. Config-default efficacy was NOT demonstrated — and, equally,
it was NOT refuted: FALSE `wholeBodyStatementMatch` classifies one cell against one observer
grammar; it does NOT prove long waits impossible, does not exclude shapes on other surfaces, and
carries no claim about the host's wait capability. The §13.10/§13.11 boundaries all stand: the five
historical 0.162.1 pre-gate flags remain unknowable and unrelabeled; `code_mode_interrupt` remains
presence/acceptance evidence only with installed cancellation still unproven; Task 1's `-c`
transport remains acceptance-only; S5's installed-interruption obligation, S6's generic route, and
spec §8's production scope remain open and untouched. Production/config/user-cache changes: ZERO.
Current-state pointers remain for the close-out task (plan Task 5), which must also carry the
S1–S7/Q1–Q6 mapping — no mapping is asserted here.

### 14.1 Close-out (2026-10-16, plan Task 5): exact pins, final run ledger, full gate battery, S1–S7/Q1–Q6 mapping and the smallest next decision — documentation-only; no host launched, no model turn, no code change; production scope ZERO

Task 5 is close-out recording plus the full verification battery. No host was launched, no model turn
occurred, and no code, test, production, configuration or user-cache file changed: the tracked diff
against the merged baseline `61853ab0faa0ceb55c68504d737daed3e91b9ee8` is exactly this report's §14
additions plus the plan file — the `tools/`/`tests/` diff is EMPTY, and the prohibited-path diff
(recorded below) is EMPTY. Nothing here rewrites any historical record: §§1–13 and §14's Task 1–4
entries above stand byte-unchanged.

**Exact pins.**

| Pin | Value |
| --- | --- |
| Plugin baseline / merge base | `61853ab0faa0ceb55c68504d737daed3e91b9ee8` (PR #67 merge) |
| Task commits, branch `docs/rescue-shell-wait-config-path-a` | Task 1 `1f8f684cb0a264e9b2c470937c8394ff2eb312fa` → Task 2 `b93aaa4c83a3d12ed8b0056a6cee4f718a7289be` → Tasks 3–4 adjudication `7261da8bb135ff6d699af3e364eb950db4d98f95` |
| Installed native CLI (identical at the Task 1 pin and the A0 run; no auto-update) | `codex-cli 0.163.0`, sha256 `8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31` |
| Codex source pin | `dffa0deb69268ed4ac31578794c9ea897b336ae3`, `git status --short` clean |
| A0 `--source-sha` / run-tree HEAD | `1f8f684cb0a264e9b2c470937c8394ff2eb312fa` |
| Executing observer digest at A0 | `9e764bfde1c8fbabfa4711a1d21efb1aa3778f686a18676d323b7a495c1a0c33` (digestInput `zcode-shell-wait-observer-v1 \|\| evidence.mjs \|\| driver.mjs`, NUL-separated module-init snapshot); independently recomputed at close-out from the `7261da8b…` HEAD instrument bytes — identical, confirming the executing observer was working-tree-identical to the committed HEAD bytes (the instrument itself is byte-identical to the merged baseline) |
| A0 instruction provenance | fresh isolated fixture, `sessionEstablished: true`, `roleStatus: "ready"`; named/generic variant hashes as persisted in the record (`namedRoleSha256: d2d2aa35…`, `genericMessageSha256: 1b7762…`, with the before/after hashes); the three Root-owned command Skills at `baseline`, zero differences; `model: null` by design |
| A0 fresh cell fingerprint | sha256 `fa76ae3ce693cbcbd090d47056d7ccb27639dafc0565f763365a7ce2b3a0ad40` |

**Final run ledger — 1 of 4 live runs spent; no new run authority created.**

- **A0 — attempted and SPENT** (the campaign's only live run of the four). The plan's Task 2 command run
  EXACTLY ONCE, verbatim (`--cap-ms` omitted; `--unclassified-structural-diagnostic 1`), private output
  dir `/var/folders/vw/4_44w0fs2sbgkzyzzvdn6jx40000gn/T/tmp.Bdv8eaYDJ7`. Measured: exactly one
  unclassified fresh cell, tool family `exec_command`, 2 input lines / 243 bytes, directive absent, gate
  prefix class `const-r-await` (single listed line, `braceDepthEnd: 0`, `endsWithSemicolon: true`),
  `wholeBodyStatementMatch: false`, case outcome `unsupported-call-shape`; driver exit 0 (not a
  qualified case), wall ≈212 s against the 360000 ms probe budget. Adjudication: §3's
  FALSE-with-confirmed-`exec_command` branch — decisive wrapper/inline exclusion for that ONE fresh
  cell/family.
- **A1 — unspent, NOT justified.** No demonstrated parser defect (§3 branch 2), and the governing rule
  "No speculative parser implementation if A0 did not demonstrate the defect" applies. Instrument-side
  verification: `parseCallEvent`'s only whole-body acceptors are `WRAPPER_PATTERN`
  (`tools/shell-wait-probe/evidence.mjs:49`), `INLINE_WRAPPER_PATTERN` (:53), `PREPARATION_PATTERN`
  (:67, `write_stdin` head) and `ROOT_CONTROL_WRAPPER_PATTERN` (:1052) — this cell's raw input matches
  none of them, so the planned `parseCallEvent` fallback could not have rescued THIS cell (pattern-based,
  independent of any statement-form characterization; user correction 2026-10-16: no multi-line claim).
- **C0 — unspent, BLOCKED.** Task 4's own gate fails: the managed route was not measurable after
  Tasks 2/3 (`route.actual: null`, admission blocked at `unsupported-call-shape`); §3 orders stopping
  dependent managed-Child trials.
- **C1 — unspent, BLOCKED** (dependent on C0, which never ran).
- **The one-changed-variable comparison was never reached.** No config-default arm exists. The transport
  (`-c features.code_mode.default_exec_yield_time_ms=<n>` inside `CODEX_EXEC_COMMON_ARGUMENTS`, after
  `-c shell_environment_policy.inherit=all`, before `-C <workspace>`) remains acceptance-only verified
  (positive/negative `codex features list` probes under a throwaway `CODEX_HOME`; the recorded
  `--version`-short-circuits-before-config-load caveat stands), and propagation to the actual Child was
  NEVER proven — C0/C1 never ran.

**Measured vs null facts (A0 record; every per-dimension null carries its cause).** Measured: the
fresh-cell structural facts above; the held-turn timeline (launched 1 ms, observationDetected 34750,
pollStarted 68787, holdDeadline 164750, rootAcknowledgement 185197, ended 185201; `gateReleased: true`);
the fixture setup facts (`isolatedSetup` `sessionEstablished: true`, `launcherDescriptorPublished: true`,
`setupAttempts: 2`, `roleStatus: "ready"`); `interrupt.callCount: 0` / `requested: false` (no interrupt,
by plan). Null with cause: `route.requested: "rescue-foreground"` but `route.actual: null`;
`childLinkageChecked`, `originalHandleChecked`, `companionLaunchCount`, `companionSendCount`,
`rootThreadId`, `childThreadId`, `parentThreadId` — all null, the case having terminated at the
unsupported-call-shape gate before route/ownership verification; `outerReturns`, `modelCalls`,
`rootJoins`, `decisiveWallMs`, `pollWallTimesMs`, `pendingInnerAtEnd` — all null;
`remainingLifetimeBasis: "unavailable"`; `publicResultMatchedSentinel`, `terminalStdoutChecked`,
`resultCheck`, `resultCheckLabel` — null (`hostExit: 0`, `processExit: null`);
`settlement.observed: false`; `model` and `reachableToolFamily` null by design.

**Cleanup outcomes.** Driver-reported owned fixture cleanup succeeded: `fixtureDisposed: true`,
`disposalError: null`, `cleanupComplete: true`, `cleanupErrorCount: 0`. Recorded honestly alongside:
`processTermination.verifiedTerminated: false` / `codexTerminated: false` — the cleanup is BUDGET
cleanup, not native cancellation or verified settlement, and supports no interruption claim. The
redacted A0 record (`rescue-long.record.json`) remains preserved at its private OS-temp path; this
worktree's three drafting scratch files remain untracked and preserved; zero user configuration or
cache edits.

**Source default vs installed-accepted vs not-proven (kept separate; source facts are mechanism
statements, not runtime guarantees).** Source at `dffa0deb…`: outer code-mode exec default **30000 ms**
(`core/config/mod.rs:1200`, resolution `:2778-2792`, absent-yield fill
`tools/code_mode/mod.rs:130-137`); protocol constants **10000 ms**
(`code-mode-protocol/src/runtime.rs:15-16`) are NOT the core default; the independent wait handler
default **10000 ms** (`tools/code_mode/wait_handler.rs:30,38-40,134-141`) never reads the exec default;
`code_mode_interrupt` Stable/**default-true** (`features/src/lib.rs:1197-1202`; flipped 2026-10-07 by
`72c95952…`/#51835; the old campaign pin records `UnderDevelopment`/false). Installed-accepted
(0.163.0 binary only): `features list` prints `code_mode_interrupt  stable  true`; the
`-c features.code_mode.default_exec_yield_time_ms=<n>` key validates both positively and negatively
under a throwaway home. NOT PROVEN: every runtime effect — propagation of either the configured default
or an enabled interrupt to an actual Child, any configured-default long observation, installed native
interruption, durable/no-collateral settlement (no live interrupt was sent; C0/C1 never ran).

**S1–S7 / Q1–Q6 mapping** (structure exactly as the plan's Task 5 checkbox prescribes):

- **S1–S3 — preserved and observed only where attributable.** A0's case terminated at the
  unsupported-call-shape gate before route/ownership/terminal-linkage verification, so this campaign
  adds NO new S1–S3 observation; every historical S1–S3 record keeps its own pin/surface scope.
- **S4 — placement, Root and Status: unchanged and not newly qualified.** No placement or Status
  surface was exercised by this campaign.
- **S5 — source interrupt capability is DISTINCT from still-unproved installed native interruption and
  durable/no-collateral settlement.** The Stable/default-true flip is a source/default fact;
  installed-accepted evidence is presence only; no live interrupt, no settlement claim
  (`interrupt.callCount: 0`; `verifiedTerminated: false` recorded as budget cleanup).
- **S6 — the generic route remains separately unavailable/unqualified.** Untouched by this campaign;
  §13.8's structural unavailability stands and the generic-paragraph parity work was never reached
  (Task 4 not applicable).
- **S7 — zero production/config edits.** Canonical Skills, Role templates, production
  scripts/hooks/packaging, marketplace snapshots, installed caches, user configuration and `../codex`
  unchanged; the prohibited-path diff recorded below is EMPTY.
- **Q1/Q2 — the outer-Child inheritance question gained evidence ONLY from Task 1's read-only source
  recheck.** What was gained: every §13.11 citation CONFIRMED at pin `dffa0deb…` — config-real
  inheritance through `turn.config.clone()` (`agent/child_config.rs:132-133`) with both services
  constructed from the child config (`session/session.rs:1730-1731`, `:1818-1823`), and the Role
  whitelist (`agent/role.rs:36-47`) excluding both numeric keys — so the only candidate transport is a
  host-argv `-c` override, which a Role cannot carry. What was NOT gained: any installed proof that the
  override (or the host default) actually reaches a real Child's `CodeModeService`/process manager —
  Task 1's evidence is acceptance-only, and Q1/Q2's installed half remains open.
- **Q3 — full M / raised-cap / repeat acceptance still outstanding.** The inner cap stayed unraised and
  identical by design; no M measurement, no raised-cap trial, no repeat — untouched by this campaign.
- **Q4 — noise/sidecar/interrupt not rerun.** §13.6's shape-adjudicated noise/background records and
  §8.4's structural sidecar coverage stand unchanged.
- **Q5 — per-command historical verdicts unchanged.** §9.4/§13.7 stand byte-unmodified.
- **Q6 — the proposed deployment seam is NOT release authorization.** The
  `-c features.code_mode.default_exec_yield_time_ms` transport is a proposed research-only seam,
  acceptance-only; no production recommendation and no release follow from it.

**Two conclusions, kept separate.** (1) **Recognition was NOT restored**: the fresh `exec_command` cell
remains excluded by the executing observer's whole-body grammar (`wholeBodyStatementMatch: false`); the
bounded cause — pattern-based, independent of any statement-form characterization — is that no existing
observer whole-body acceptor path outside the wrapper/inline patterns matches this cell's raw input, so
even the planned `parseCallEvent` fallback could not have accepted THIS cell; and what FALSE plus that
analysis establish is exactly and only that the EXISTING parser set and the PLANNED fallback cannot
accept this cell — whether a NEW finite whitelist recognition form could accept it is unknown and was
not assessed (user correction 2026-10-16: no broader impossibility conclusion exists); the scope is
this one fresh cell/family — it does not exclude shapes on other surfaces and does not prove long waits
impossible. (2) **Config-default efficacy was NOT demonstrated — and equally NOT
refuted**: the bounded cause is that admission was blocked upstream at `unsupported-call-shape`, so the
configured default was never exercised and the transport's acceptance evidence never became a
propagation claim. Neither conclusion is evidence that long waits are infeasible.

**Full verification battery (exact results; nothing fixed, no dependency changes, no `npm audit fix`).**

| Command | Result |
| --- | --- |
| `npm test` (routine at the clean exact source) | **3397 tests / 3393 pass / 1 fail / 3 skipped / 0 cancelled** (657 s). The `&&`-chained `tests/integration/marketplace-snapshot-build.mjs` did not execute because the routine suite exited nonzero. The single failure — `isolated Codex marketplace lists and installs the eight-skill snapshot` (`tests/integration/marketplace-install.test.mjs:130`, ≈26 ms) — died in `verifyCleanExactSource` (`Marketplace source tree must be clean, including tracked and untracked files.`): that check requires fully empty `git status --porcelain -untracked-files=all`, and the only status content was the three preserved untracked scratch files this plan forbids staging. Controlled reproduction (the spec §2 / §13.9 maneuver): with ONLY the three scratch files temporarily moved out, the same focused test passed the clean-tree check and proceeded into the snapshot builder, failing there with the §13.9-adjudicated environmental npm-install hang signature (`ZCODE_PROCESS_TIMEOUT` 120000 ms, `capturedOutputBytes: 0`); the scratch files were restored byte-identical immediately after (verified by `git status`). Adjudicated cause: preserved-scratch artifact plus the known environmental npm family — no source, instrument or content regression (the implementation diff is EMPTY). Recorded limitation (review P3): the ambient proxy state was NOT captured during the reproduction, so the builder-stage classification rests on the §13.9 family signature match (`ZCODE_PROCESS_TIMEOUT` 120000 ms, `capturedOutputBytes: 0`) rather than a fresh proxy-removed single-variable isolation; the CURRENT ambient state (recorded at this amendment, explicitly NOT a retroactive observation of the reproduction window) is `all_proxy`/`http_proxy`/`https_proxy` all set. Stated plainly (user correction 2026-10-16): this is ONE recorded failure — **3393 pass / 1 FAIL** — with its cause and environmental clues recorded; it REMAINS a recorded failure, and neither the zero-implementation delta nor any independent-review adjudication converts it into a pass |
| `npm run test:shell-research` | **451 tests / 451 pass / 0 fail / 0 skipped** (46 suites) |
| `node --test tests/test-selection.test.mjs` | **6 / 6 pass**, 0 skipped |
| `node --test tests/rescue-preparation.test.mjs tests/rescue-binding.test.mjs tests/rescue-route-planner.test.mjs` | **417 / 417 pass**, 0 skipped |
| `node --test tests/rescue-lifecycle.test.mjs tests/rescue-child-reconciliation.test.mjs tests/rescue-progress-relay.test.mjs` | **126 / 126 pass**, 0 skipped |
| `node --test tests/job-control.test.mjs tests/mcp-result.test.mjs` | **213 / 213 pass**, 0 skipped |
| `npm run lint` | exit 0, clean |
| `npm run typecheck` | exit 0, clean |
| `node scripts/check-line-endings.mjs` | exit 0 — LF verified in **535** tracked files (run AFTER the close-out edits, gating the final content; one more than Task 1's recorded 534 because the plan file itself became tracked at Task 1's commit) |
| `git diff --check` | clean, exit 0 (run AFTER the close-out edits) |
| Prohibited-path diff: `git diff 61853ab0faa0ceb55c68504d737daed3e91b9ee8 --stat -- skills/ agents/ scripts/ hooks/ .codex-plugin/ marketplace/ docs/superpowers/specs/` | **EMPTY** (run AFTER the close-out edits; expected final diff over prohibited paths confirmed empty) |

Sequencing note: `npm test` ran BEFORE the documentation-only close-out edits, at HEAD `7261da8b…` with
the tree clean except the three preserved scratch files — the clean exact source containing ALL changed
implementation (the implementation diff vs the merged baseline is EMPTY, so HEAD is that source). The
six suite/lint/typecheck runs also preceded the edits (they are content-independent of them); the three
tree-state gates at the table's end ran AFTER the edits, so they gate the final committed content.

**Independent review.** The independent whole-branch review (spec fidelity; executability;
measurement/privacy safety) is **CLEAN** on the branch diff
`61853ab0faa0ceb55c68504d737daed3e91b9ee8..35d7a71be56d2a91a9c94c227a47e63ecb689301` — the reviewed
bytes are the four-commit branch diff at `35d7a71b…`. The reviewer independently recomputed the
executing-observer digest (`9e764bfd…` — identical at `1f8f684c…`/`7261da8b…`/`35d7a71b…`), the
prohibited-path and implementation diffs (both EMPTY) and the LF count (535), and cross-checked the
A0 record field-by-field. Regarding the `npm test` failure, the reviewer's finding was a NON-BLOCKING
adjudication, not a pass (wording corrected 2026-10-16 after user review): the suite result remains
**3393 pass / 1 FAIL** — one failure whose cause and environmental clues are recorded on the battery
row above — and it REMAINS a recorded failure; the zero-implementation delta and this non-blocking
adjudication do NOT convert it into a pass. The reviewer returned two P3 notes, both applied and
narrowly rechecked in that amendment: the uniform Task 5 tick convention in the plan, and the
reproduction's proxy-state caveat recorded on the `npm test` battery row above. Remaining pipeline
step: the final codex whole-branch gate — its verdict is recorded in the root's close-out report, not
pre-written here.

**Pre-PR correction round (2026-10-16, user review).** Before PR submission the user reviewed the
branch, this report and the retained A0 structural record and required three wording corrections,
applied in this round with dated flags and never silently: (i) conclusion scope — the FALSE result
plus the instrument-side pattern analysis establishes exactly and only that the EXISTING parser set
and the PLANNED `parseCallEvent` fallback cannot accept THIS cell, not that any bounded recognition
scheme is impossible (whether a new finite whitelist recognition form could accept the cell is unknown
and was not assessed); (ii) shape — the "multi-line statement" characterization was NOT established by
the diagnostic (the retained facts are line-1-only, `withheldLines` 0 / listed set complete, exactly
one non-empty content line; whether the second line was an empty/trailing-newline line is unknown;
the pattern-based proof does not depend on that characterization and stands unchanged); (iii)
`npm test` — recorded as one FAIL (3393 pass / 1 FAIL) with cause and environmental clues, REMAINING a
recorded failure — neither the zero-implementation delta nor any reviewer adjudication converts it
into a pass. The user CONFIRMED that stopping A1/C0/C1 was correct per the plan (execution agent no
fault) and confirmed the campaign's standing characterization: the measurement instrument blocks
verification — long waits are NOT proven infeasible. The user's stated priority for any next plan:
controlled shape diagnosis under the isolated fixture — in-memory analysis only, retain redacted
structure — to determine which finite call form is missing, then decide a minimal recognition
adaptation; explicitly NOT a forced binary between privacy relaxation and waiting for a host update.
Self-reference note (dated 2026-10-16): the Independent review paragraph's byte-range citations
(`…35d7a71b…`) name the bytes as reviewed when written; the close-out commit has since been amended
in place — once for the P3 application (tip before this round
`fcbcd43560612ef268b0692d331efbcad7510adf`) and again by this correction round (message unchanged,
`docs: record config path-a close-out, S/Q mapping and full gate battery (task 5)`) — a commit cannot
contain its own hash, so the exact corrected-tip SHA is set by this round's amend and is recorded in
the branch log and the root's PR submission.

**Smallest next decision (neutral and bounded; the user decides — nothing below was executed, designed
or requested by this close-out).** The measured blocker is precise and bounded (user-corrected
2026-10-16): the A0 cell reached the executing observer inside raw input the existing whole-body
grammar cannot accept, with the retained record holding ONLY — a 2-physical-input-lines / 243-byte
envelope, directive absent, exactly one listed diagnostic line (line 1: prefix class `const-r-await`,
`braceDepthEnd: 0`, `endsWithSemicolon: true`, tools `["exec_command"]`), `withheldLines` 0 (recorded
as the field's absence — the instrument emits it only when > 0, `tools/shell-wait-probe/evidence.mjs:322`
— so the retained listed-lines set is complete) and therefore exactly one non-empty content line;
whether the second line was an empty/trailing-newline line is unknown, and the specific statement form
(single- vs multi-line syntax) is NOT established. No raw body is retained, none is reproduced here,
no grammar-extension design is proposed, and no automatic privacy-relaxation request is made. What the
FALSE result plus the instrument-side pattern analysis establish is exactly and only that the EXISTING
parser set and the PLANNED `parseCallEvent` fallback cannot accept THIS cell; whether a NEW finite
whitelist recognition form could accept it is unknown and was not assessed. The user's stated priority
for any next plan (recorded 2026-10-16): controlled shape diagnosis under the isolated fixture —
in-memory analysis only, retain redacted structure — to determine which finite call form is missing,
then decide a minimal recognition adaptation; explicitly NOT a forced binary between privacy
relaxation and waiting for a host update. Production scope remains **ZERO**: spec §8 still requires
the current-route quantitative long discriminator and repeat, reduced re-entry, exact output linkage,
and native pending-observation interruption with owned/no-collateral settlement — all outstanding;
§13.10/§13.11's boundaries (five unknowable pre-gate flags; per-pin scoping) stand.

## 15. 2026-10-16 shape-diagnostic campaign execution log

> Continuation under the same spec (S1–S7, Q1–Q6, §8) authorized by plan
> `docs/superpowers/plans/2026-10-16-rescue-shell-wait-shape-diagnostic.md`. Budget ledger resets to
> zero here: D0/D1/C0/C1 all unspent until a §15 entry states otherwise. Process-channel facts first
> recorded in §15.1 apply to later entries until corrected.

### 15.1 Task 1: pins, seam survey, frozen diagnostic schema, model/config transport recheck (2026-10-16; no code change, no live run, no model turn)

**Process-channel record (dated; not a code fact).** Three environmental degradations were recorded as
OPEN at execution start (2026-10-16 ~09:35Z): (1) the local proxy `http://127.0.0.1:7890`'s FOREIGN
upstream was down (github/google/chatgpt unreachable through it and directly, domestic 200), making
network-dependent codex review submission impossible and recorded pending-backfill, never passed;
(2) the general-purpose subagent channel was provider-rejected on five dispatch attempts spanning
~15 minutes (including a trivial probe) while the harness's Explore (read-only) agent type worked, so
this task's read-only survey evidence was produced by Explore agents and the root performed only the
mechanical doc edits, schema synthesis from that evidence, and the commits — a recorded degradation for
THIS docs-only task, with code tasks (Task 2+) still held to the standard
implementer→self-review→codex-gate chain; (3) no live model-turn run was attempted (plan §3 makes
failed startup launches count against the run ledger). **Recovery record (~11:15Z, 2026-10-16):** the
foreign upstream was restored (google 200 through the proxy; chatgpt 403 on bare curl = normal bot
protection per the standing service-recovery rule), the general-purpose channel probe succeeded, and
the pending Task 1 review was submitted the same day through the plain non-adversarial `review`
channel (user-directed; no focus text required because the plan/report/spec ride in the reviewed
diff): background job `review-mvavfwqo-dqcqv4`, full branch diff against `7fe8cbb…`, verdict **zero
actionable findings** ("The diff changes only research documentation and does not modify executable
code or existing contracts. No actionable regressions were identified; the six test-selection tests
and diff whitespace checks passed."). No backfill remains owed for Task 1. Self-reference note: the
review ran against the task commit as it stood before this verdict-recorded amendment (HEAD
`492604d…`); the amend that records the verdict sets the final task SHA in the branch log, and the
amend adds only this process-channel paragraph plus the plan's matching one-line recovery note — no
reviewed claim is altered.

**Pins (all re-verified today at execution start).** `shell_plugin_sha` =
`7fe8cbb80489664eb6ea56917c795cb9a17233cb` (worktree
`.worktrees/rescue-shell-wait-shape-diagnostic`, branch `docs/rescue-shell-wait-shape-diagnostic`,
fresh worktree exactly on merged PR #68; dirty state = only the plan file itself plus root scratch
`findings.md` / `progress.md` / `task_plan.md`, all untracked and never committed).
`shell_codex_binary` = `/Users/zhangzikai/.codex/packages/standalone/releases/0.163.0-aarch64-apple-darwin/bin/codex`
(realpath of `command -v codex` via `~/.local/bin/codex`; the npm devDependency is NOT used —
driver `--help` documents an explicit `--codex <absolute executable>` argument with no
devDependency fallback), `codex --version` = `codex-cli 0.163.0`,
SHA-256 = `8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31`. Codex source checkout
`/Users/zhangzikai/Workspace/Codes/github/codex` HEAD = `dffa0deb69268ed4ac31578794c9ea897b336ae3`,
`git status --short` empty (clean); inspected read-only via `git show <pin>:<path>` only. Source/binary
correspondence remains UNPROVEN (unchanged from §13.11); the pin pair is recorded for attribution, not
as an equivalence claim. Driver `--help` on this pin lists only the pre-Task-2 option set (no `--model`,
no `--unclassified-shape-diagnostic`, no `--wait-policy`).

**Seam survey (read-only, Explore-produced; file:line on the worktree at `7fe8cbb…`).** All named
helpers exist under their exact names in `tools/shell-wait-probe/evidence.mjs`:
`structuralExcerptForUnclassifiedInput` (evidence.mjs:368, private; builds the JSON fact excerpt —
`suppressed`, `classification`, `tool`, `bodyType`, `inputLines`, `directivePresent/Keys`,
`withheldDirectiveKeys`, `inputBytes` — ends in `scrubExcerpt`:431); `parseCallStatements` (:605,
exported; per-line single-statement parse via `parseCallEvent`, any bad/trailing content line rejects
the whole cell); `parseCallEvent` (:668, exported; dispatches `function_call` string-JSON args,
`custom_tool_call` preparation :685 / root-control :713 / `parseWrappedToolInput` :719; returns
`{kind, value, directive, wrapped}` or null); `parseWrapperArguments` (:809, private; bounded by
`MAX_WRAPPER_ARGUMENT_CHARS` 4096 at :40, JSON-first with a string-aware JS-literal fallback);
`inspectShellWaitEvidence` (:1970, exported; whole-evidence adjudicator returning
`{status:'supported', facts}` at :2167-2190 or `{status:'inconclusive', inconclusive:{reason, detail,
manualAdjudicationRequired?, excerpt?}, facts:null}` via the private `inconclusive()` helper at
:2193-2196). Privacy scrubber `scrubExcerpt`
(:130, private; redaction-string replacement, control-char drop, 2048-char `MAX_EXCERPT_CHARS` :41
truncation at :139-140); driver-side `redactPrivatePaths` (driver.mjs:443, path-only error redaction).
Fixture disposal `dispose` (fixture.mjs:457-478; worktree-registration removal then `rm -rf` of the
temporary root; error-path cleanup :479-489).

**Raw-call lifecycle seam (the location Task 2 must use).** Raw text lives only in memory on
`payload.input` of events in the in-memory `rollouts` array (`loadShellWaitRollouts` driver.mjs:1791,
loaded at :2288). During the held turn the watches (`waitForLauncherObservation` driver.mjs:1905,
`waitForPollObservation` :1963/:1990, settlement watch :2054) call `parseCallStatements` per event and
retain nothing for unknown shapes. Post-run, `inspectShellWaitEvidence` re-scans every event
(evidence.mjs:2032-2105): for `custom_tool_call`, when `parseCallStatements(event) !== null` the call is
admitted (:2043), and otherwise the raw `payload.input` flows to
`structuralExcerptForUnclassifiedInput` (:2048) producing
`inconclusive('unsupported-call-shape', …, {manualAdjudicationRequired: true, excerpt})` (:2055-2057);
function_call non-string/unparsable/non-object args take the same path at :2066-2102. **The in-memory
seam for a future `inspectCallShape(raw)` is evidence.mjs:2043-2048 (and the analog :2065-2102)** —
after the existing-parser rejection and BEFORE the suppression/fact-projection — where the raw string
is still in scope and the `diagnosticEnabled` gate (:2026-2030, threaded from driver.mjs:2311) already
exists. Raw bytes persist only in the in-memory rollouts originating from fixture-owned session
rollouts deleted by fixture disposal; the record already carries only a one-way `sha256` digest.
Opting in keeps that boundary: classification consumes the raw in memory, projects closed enums through
the existing serialization (`buildCaseRecord` driver.mjs:545-688 → `record.evidence.excerpts[]`
(≤`MAX_CASE_EXCERPTS` :693) → `writeCaseRecord` :704-714, `JSON.stringify` at 0600), and never attaches
the raw string to the object graph or an exception message.

**Existing redacted-record flow (downstream of the seam).** `mapShellWaitLiveFacts`
(driver.mjs:2713-2715) turns the inconclusive into `inconclusive = {reason: reason + ': ' + detail}` +
`excerpts.push({kind: 'unsupported-call-shape', ...excerpt})`; `record.inconclusive = {reason}` only
(:686) and the optional `unclassifiedStructuralDiagnostic: true` marker at :555; CLI echo at
:3069-3070. Today's structural-diagnostic retention (evidence.mjs:280-330) is:
`wholeBodyStatementMatch`, per-line `{line, prefix, braceDepthEnd, endsWithSemicolon, tools,
withheldToolNames}`, `withheldLines` (emitted only when >0, :322), `sha256` digest, and a
`diagnosticBudgetChars` (:340-342) with end-dropping at :325-328. Cleanup-error text is path-redacted
(driver.mjs:2391-2393). The Task 2 shape diagnostic must join THIS record as additional closed facts
projected by the same budget rules — missing budget room means dropping whole optional facts with an
incomplete marker, never mid-JSON truncation, raw fallback, or a claimed-complete classification.

**Naive brace hint verdict.** The existing counter is `unclassifiedStructuralDiagnosticFacts`
(evidence.mjs:288-295), reporting per-line `braceDepthEnd` (:310) as a cumulative +1/−1 over
`([{/)]}` on retained content lines with no lexer. It cannot distinguish string-vs-code braces (its own
contract states this at :253-259), gives no one-vs-multiple statement count (only per-line prefix classes
from `DIAGNOSTIC_LINE_PREFIX_TESTS` :232-236 — `const-r-await`, `text-await-tools`, `text(`, `other` —
plus `wholeBodyStatementMatch` :284), and exposes trailing post-closing content only as an
`other`-prefix line or nonzero residual depth (`parseCallStatements` rejects trailing content at
:622-628). Verdict: NOT information-sufficient for the seven synthetic hypotheses below; a bounded
string-aware static scan (string/comment-aware linear lexical scan; no AST, no evaluation) is required
and is specified as the Task 2 implementation basis.

**Synthetic information-sufficiency alternative set (design; Task 2 tests these as RED candidates).
Seven hypothesis classes share A0's known envelope class (2 physical input lines ≈243 bytes, exactly one
listed nonempty diagnostic line, `withheldLines` 0, prefix class `const-r-await`, `wholeBodyStatementMatch`
false — §14.1); they appear as EIGHT concrete records below because the missing/changed-emission-tail
class is split into two records, and they are DIFFERENT hypotheses sharing only that envelope, never
reconstructions of A0:**

1. `S-canonical` — accepted canonical wrapper control: `const r = await tools.exec_command({cmd:"…"});`
   + `text(r);`. Expected: `parserStage: parse-accepted`, `wholeInputConsumed: true` (this is the
   already-admitted family, listed as the falsifiability control: records 3–5 and 7–8 are each
   expected to diverge from it on a specific closed fact; records 2 and 6 are expected to be
   indistinguishable from it on the syntax/decision facts — record 6 on EVERY retained fact
   (string-boundary rule: tool-like text inside a private literal produces no syntax fact), record 2
   solely excepting the `parserStage` diagnosis, which necessarily reports the existing wrapper stage
   because the existing grammar pins the canonical `r` spelling (WRAPPER_PATTERN, evidence.mjs:49;
   `parseWrappedToolInput` :853-873 has no other accepting path for a `const <binding>` wrapper form —
   its inline `text(await tools.…)` alternative, evidence.mjs:53, cannot match that shape) — no
   binding-spelling-dependent syntax/decision fact exists).
2. `S-binding` — changed result binding: `const q = …; text(q);` (binding spelling varies; identical
   syntax relations; retained facts must be identical apart from the existing sanctioned
   digest/envelope AND apart from the `parserStage` diagnosis — the existing grammar pins the `r`
   spelling (WRAPPER_PATTERN, evidence.mjs:49), so a changed binding necessarily reports the wrapper
   stage, exactly as the plan's Task 2 example asserts via `parseCallStatements(…) === null` for a
   noncanonical binding; no binding-spelling-dependent syntax/decision fact exists).
3. `S-tail-missing` — missing emission tail: first statement only.
4. `S-tail-changed` — changed emission tail: `text(JSON.stringify(r));` or `text(r.status);`.
5. `S-arg-unsupported` — unsupported argument expression: `{cmd: buildCmd()}` or spread.
6. `S-string-contained` — tool-like text inside a private literal: `cmd:"prep text(r) tools.exec_command
   (prompt) alias"`; lexer boundaries first, so NO syntax fact may be derived from that content.
7. `S-extra` — extra hidden statement: a third plausible statement after the accepted pair.
8. `S-trailing-blank` — trailing blank formatting after the final statement (`;\n\n`, trailing blanks).

**Closed decision dimensions (each alternative is expected to differ on a specific subset; one
dimension per existing failure family):** whole-wrapper mismatch (head class + whole-body coverage);
argument decoding rejection (literal-object vs unsupported vs over-limit); output projection (tail
class); extra/unresolved content (residual statements / trailing formatting / slot-limit); lexical
state (complete vs unterminated vs unsupported syntax); parser stage (which existing stage rejects);
directive state (absent/valid/invalid/unknown); tool family (`exec_command` vs other). These dimensions
are the Task 1-frozen discriminator set; the classifier reports closed enums ONLY.

**FROZEN diagnostic schema v1 (`inspectCallShape` — Task 2 implements exactly this; local
investigation decision under plan §2 privacy contract).** A pure, non-evaluating static classifier over
the raw call string; fixed input bounds: byte length ≤ 8192 (UTF-8), ≤ 16 statement slots, argument
literal ≤ 4096 chars (matches `MAX_WRAPPER_ARGUMENT_CHARS`); excerpt/diagnostic record still bounded by
the existing 2048-char budget. Truncated input NEVER becomes success; a fact that cannot be established
inside these bounds is dropped whole with an incomplete marker.

```jsonc
{
  "version": 1,
  "coverage": "complete | partial | over-budget | over-scope",   // classification coverage ONLY, never admission
  "statements": [ {                                              // ≤16 nodes; dropped whole (with statementCount retained) when unsayable
      "head":       "bound-await | bare-await | emission | other | unknown",
      "tool":       "exec_command | other | no-call | unknown",    // allowlist = {"exec_command"}; any other established name, incl. spelling, is "other"; unknown only when lexical state blocks classification
      "argument":   "literal-object | unsupported | none | over-limit",
      "lexical":    "complete | unterminated | invalid | unsupported-syntax",
      "tail":       "text-binding | text-stringify-binding | text-public-field | text-other | none | unknown"
  } ],
  "statementCount":   "<integer 0..16> | over-limit",
  "tool":             "exec_command | other | no-call | unknown", // top-level mirror: tool class of the LAST call-carrying statement ('no-call' when none)
  "head":             "bound-await | bare-await | emission | other | unknown",  // top-level mirror: FIRST statement's head
  "tail":             "text-binding | text-stringify-binding | text-public-field | text-other | none | unknown",  // top-level mirror: LAST statement's tail
  "bindingEquality":  "equal | not-equal | unrelated | unknown", // head binding identifier == tail emission identifier (equality only; spelling never retained)
  "parserStage":      "parse-accepted | wrapper | arguments | output | residual | directive | unknown",  // existing-parser stage order (diagnosis only)
  "directive":        "absent | valid | invalid | unknown",      // directive verdict read from the existing parseCallEvent directive readback; keys never retained
  "wholeInputConsumed": <boolean>                                // classification coverage only
}
```

**Schema v1 amendment (close-out correction, 2026-10-17, user-commissioned two-axis review;
adjudicated — the frozen block above is NOT rewritten).** One record-budget retention field joins
the PROJECTED shape block, quoted field line:

```jsonc
  "retention": "full | partial",   // record-budget serialization marker: 'partial' when any fact was dropped for the excerpt budget ('statements' array or everything), 'full' when every fact was serialized — NEVER a classification verdict
```

It describes SERIALIZATION only — `coverage`/`wholeInputConsumed` keep describing CLASSIFICATION
and are unchanged in every tier. The projector sets it on every tier and budgets it with them:
full facts → `retention: 'full'`; the `statements`-dropped tier → `retention: 'partial'`;
and the minimal marker becomes `{ "version": 1, "coverage": "over-budget", "retention":
"partial" }` — the redundant `wholeInputConsumed` field is OMITTED there ('over-budget' always
means `false`, so the classification meaning is unchanged) because the tightest observed tier
budget (67 serialized characters at sixteen slots — 2048 − baseJson 296 − diagnosticJson 1662 −
23 separator characters, re-derived from the projector's own formula) otherwise could not hold
both the marker and the retention field; when even the 60-character marker does not fit, the
block is omitted
entirely (no unmarked partial result exists). Provenance: the evidence.mjs byte change flows
into the observer digest automatically (designed behavior).

Retains-a-count note (plan §2 anchoring): beyond booleans/enums, the ONLY new count-like facts are
`statementCount` and the `statements` array length — both directly represent the schema-projected
syntax tree's fixed statement-slot count, which plan §2 expressly allows ("fixed public node kinds,
fixed child slots and binding-equality relations, at most 64 nodes/depth 8/16 statement slots"); no
other numeric series (string lengths, source offsets, per-token counts) is retained.

Field semantics fixed at freeze: `head` from the first significant token class (declaration-binding of
an await → `bound-await`; bare await statement → `bare-await`; emission-first (`text(…)` as its own
head) → `emission`; anything else → `other`/`unknown`). `tail` 'value' classes: `text(<result binding
identifier>)` → `text-binding`; `text(JSON.stringify(<identifier>))` → `text-stringify-binding`;
`text(<identifier>.<allowlisted public result field>)` → `text-public-field` (allowlist table is EMPTY
at v1 — no public field is enumerated, so any property projection stays `text-other`; extending it
requires a new adjudication); anything else inside `text(…)` → `text-other`; no emission → `none`.
`tail` at top level mirrors the LAST statement's tail; top-level `tool` and `head` are the remaining
mirror fields the plan's Task 2 example pins — top-level `tool` is the tool class of the LAST
call-carrying statement (`no-call` when none), top-level `head` mirrors the FIRST statement's head —
so the plan's single-call example (`const alias = await …; text(alias);`) projects
`head: bound-await`, `tool: exec_command`, `tail: text-binding` with no binding spelling retained.
`bindingEquality` compares only identifier
equality between an earlier statement's bound result and the final emission's argument identifier — no
name retained (the plan's example asserts `JSON.stringify(facts)` does not contain `alias`). Public
syntax strings (`exec_command`, `text(`, `JSON.stringify`) exist ONLY as fixed enum labels. Lexical
state unsupported features (template literals, regex literals, class fields, optional chaining, etc.)
map the affected statement to `lexical: unsupported-syntax` and `head/tool: unknown` — never probed
further. Statement slot order: lexical string/comment boundaries are applied BEFORE structural
classification, so tool-like text inside task strings never produces `tool` facts. `parserStage`
mirrors the classification order of existing `parseCallStatements` stages (wrapper → arguments →
output → residual → directive); `parse-accepted` is a diagnosis report of that parser's response, NOT
an admission verdict and NEVER a fake validated-call object (`parseCallStatements`' own null/parsed
outcome stays pinned separately as the plan's example requires). Directive state read from the
in-memory `parseCallEvent` directive value with the existing private-key withholding; errors →
`unknown`.

**Model comparison provenance (source-verified read-only at `dffa0deb…`).** The `-m/--model` option:
`codex-rs/utils/cli/src/shared_options.rs:22-23` — plain `Option<String>` built into the interactive
CLI (`codex`/`codex resume`/`codex fork` via TuiSharedCliOptions; codex-rs/tui/src/cli.rs:71,110-142)
and `codex exec` (ExecSharedCliOptions; codex-rs/exec/src/cli.rs:121, flattened at :25) with
`mark_exec_global_args` promoting it so `codex exec resume/fork/review` accept `-m` (exec/src/cli.rs:164).
Clap applies NO charset/length validation; an unknown slug downgrades to "Unknown model … will use
fallback model metadata." (models-manager/src/model_info.rs:94-99), while the plugin-side
`spawn_agent` Child path separately rejects unknown requested models against its preset list
(core/src/agent/child_config.rs:327-348). Precedence: CLI `-m` overrides `-c model=…` overrides
profile overrides config.toml (`core/src/config/mod.rs:3401,4083,4409`; loader docs
config/src/loader/README.md:26-37). Design resolved (Task 2 implements): optional research
`--model <id>` on the probe driver, forwarded as a SEPARATE `-m <id>` argv item to the probe's codex
child, validated at CLI and programmatic boundaries by a bounded safe-identifier check (allowlist of
name/visible-ASCII-without-shell-metacharacters; no arbitrary argv passthrough), with requested-model
recorded separately from effective host/Child metadata which may remain unknown
(`model:(…)`-stays-null contract at driver.mjs:58/:93). `codex features list` runs offline (main.rs:1870-1896;
errors from the bounded cloud-config refresh are ignored, 20 s cap; no auth/model turn needed).
**Validated `shell_trial_model`: NOT established.** The scoped repo docs deliberately never name an
authorized model id (report §92 — the executing observer is contractually blind to model identity;
historical runs pinned "SAME model" as a provenance requirement without an id string, spec :127; the
only concrete ids are §306-309's `codex debug models` catalog dump explicitly recorded as
corroboration, not authorization). Today's offline `codex debug models` (isolated empty CODEX_HOME,
unauthenticated, bundled catalog data) lists 11 entries, 8 with `list` visibility
(`gpt-6.1-sol` priority 1, `gpt-6-astra` 2, `gpt-6-sol` 3, `gpt-6-luna` 4, `gpt-5.6-sol` 5,
`gpt-5.6-terra` 8, `gpt-5.6-luna` 9, `gpt-5.5` 13) plus 3 hidden (`gpt-daybreak-blue-latest`,
`gpt-daybreak-red-latest`, `codex-auto-review`). Compared against the 0.161.0 dump recorded at
§306-309 (8 default-capable `multi_agent_version:"v2"` slugs — the six non-daybreak ones, plus the
plain `gpt-daybreak-blue` / `gpt-daybreak-red` pair counted as two slugs — with `gpt-5.6-luna`
recorded as v1 and `gpt-5.5` as null): the eight non-daybreak visible slugs match that recorded
eight-slug non-daybreak set one-for-one, the daybreak pair appears on 0.163.0 only as hidden `*-latest`
rebindings, and `codex-auto-review` is new-hidden (absent from the §306-309 record); no binding
relationship beyond the catalog entries is claimed. Consequence recorded:
authenticating the real account-default model needs foreign network + auth (outage-state, §15.1
channel record), and no explicit selection can be VALIDATED against the deliberately-unnamed
historical pin. Until a user-authorized model id exists for this campaign, D0/D1 run with model
`unknown`-preserved (diagnosis is single-run and cannot make model claims), and C0/C1's shared
explicit-selection prerequisite is UNMET: per plan Task 4 they remain unspent rather than run as two
silent-default arms.

**Config transport recheck (isolated `CODEX_HOME=$(mktemp -d)`, no model turn, true exit codes):**
baseline `features list` exit 0 offline; `-c features.code_mode.default_exec_yield_time_ms=30000`
exit 0 (key deserializes through the feature-table path); `=0` exit 0; `=abc` exit 1 with "failed to
load bootstrap configuration … did not match any variant of untagged enum FeatureToml in
features.code_mode"; `=-5` exit 1; `-c …=abc --version` prints the version and exits 0 (version/help
path does not deserialize the key — consistent with report §14's positive/malformed rows, plus today's
zero-accept and negative-reject boundary evidence). No force-enable of interruption was performed and
installed settlement remains unclaimed; root-join / inner-cap / exec-default / outer-continuation
defaults stay distinct as recorded in §14.

**Baseline gates on this fresh worktree (2026-10-16):** `npm run test:shell-research` = 451 tests /
46 suites / pass 451 / fail 0 / skipped 0 (matches the plan's drafting baseline 451/451);
`node --test tests/test-selection.test.mjs` = 6 tests / pass 6 / fail 0; tracked LF check
(`node scripts/check-line-endings.mjs`) = 535 tracked files verified, exit 0. The three high-severity
npm audit advisories disclosed in plan §4 stand disclosed, not adjudicated or fixed.

**Task 1 exit statement.** Concrete safe schema (frozen above), raw-call lifecycle seam
(evidence.mjs:2043-2048/:2065-2102), model/control limits (`shell_trial_model` unestablished; request
channel designed and source-verified; C0/C1 comparability prerequisite unmet until user-authorized),
and parser-stage distinctions (closed dimension set + frozen schema) are recorded. Unknown host syntax
is still an investigation result, not a frozen API: acceptance of any live form remains gated by
existing `parseCallStatements`, and the schema's `parse-accepted` value diagnoses rather than admits.

### 15.2 Task 2: opt-in shape-diagnostic classifier, provenance binding and model seam implemented (2026-10-16; no live run, no model turn, research-only code)

**Deliverable (commit amended in place on `docs/rescue-shell-wait-shape-diagnostic`; file:line at this
commit — anchors REFRESHED to the final canonical-exact state by the round-10 redesign paragraph
below).** New pure helper `tools/shell-wait-probe/shape-diagnostic.mjs` implementing the FROZEN schema
v1 exactly: `SHAPE_DIAGNOSTIC_SCHEMA_VERSION` (=1) at :84; executing module-init snapshot
`EXECUTING_SHAPE_DIAGNOSTIC_SOURCE` :91; frozen input bounds 8192 UTF-8 bytes / 16 statement slots /
4096 argument characters :96-98; verbatim mirrors of the existing pinned patterns
(DIRECTIVE/WRAPPER/INLINE/PREPARATION/ROOT_CONTROL + the wrapper head prefix) :104-113; the public
`inspectCallShape(raw, callContext)` :1105 (never throws, never evaluates: no `eval`/`Function`/
`vm`, no variable resolution or interpolation; the optional context withholds the wrapper-stage
verdict for a direct function_call's arguments so the persisted parserStage can never contradict
the real parser's response for the call type) over the CELL-level length-preserving FORWARD STATE
MACHINE `lexCellLines`/`lexCellLine` :203/:269 (kept VERBATIM through the redesign; the codex
round-11 fix below extends the line-comment mask to end at EACH ECMAScript line terminator —
LF, CR, U+2028, U+2029 — with lexing continuing over the masked terminators in code state) —
quoted strings
(including backslash-newline AND backslash-CRLF line continuations), block comments AND the typed
bracket-delimiter stack carry ACROSS newline slots, and when the lexer meets a boundary it cannot
prove (template literals with their escape-sensitive delimiters, optional chaining/nullish
coalescing, a lone slash, or a MISMATCHED delimiter) the remainder of the CELL is WITHHELD
conservatively (unknown classes, coverage 'partial'), so private content after any lexer boundary
can never establish a public syntax fact; string content becomes same-length filler, so the raw
argument bound stays measurable while no literal or comment content survives anywhere
classification reads — plus the CANONICAL-EXACT classification core :423-1091 (the round-10
redesign below): ECMAScript identifier classes with `$` AND `_` spelled out on top of
`\p{ID_Start}`/`\p{ID_Continue}` :432-437 (an underscore-initial binding is an ordinary
identifier); the positive statement forms, each a DIRECT mechanical variant of the pinned
mirrors — the dangling pending declaration :440, the awaited declarator (comma-separated
declarator lists handled POSITIONALLY; non-awaited declarators carry no binding and are skipped
positionally when token-free) :444-446, the awaited-call statement (the wrapper skeleton
without the binding prefix) :448, the trivia-tolerant emission head :450 (`text\s*\(` — masked
comments ARE trivia), the inline-wrapper call position :454, and the frozen tail argument forms
:460-462; the EXACT public-reference token boundaries :451-458 (`tools`/`text` with identifier-
continuation lookarounds, surrogate-pair exact under /u — `$tools`, `πtools`, `𐐀text` are single
identifiers, never public tokens); top-level segmentation at `;` and at a depth-closing `}` :506
(the grammar's proven statement boundaries); the pinned tools-call extraction :567 (exact
adjacency, balanced argument span, empty residual) with the bounded argument verdict :551; the
awaited-expression verdict :584 (pinned call, or token-free — a tools token outside the pinned
position withholds, never a confident no-call); per-segment classification :639; per-slot
classification `classifyStatementSlot` :770 (the codex-round-16
new-statement-head gate :799-808) — EVERY non-positive segment, any public-reference
token outside a pinned position, any backslash escape in code position (an identifier escape
anywhere makes reference spellings undecidable — never a confident presence OR absence), any slot
inside a spanning bracket construct, or an unproven statement position (cell start, after
`;`/`}`, or after a positively COMPLETED statement are the proven starts; a dangling pending
declaration licenses only its own initializer continuation — awaited/declaration/pending/
token-free-plain heads — NEVER an emission head; const-anchored heads are gated like every
other) takes the ONE conservative
unknown path: head/tool 'unknown', coverage 'partial', wholeInputConsumed false; tool calls are
collected POSITIONALLY per segment and the LAST call-carrying segment mirrors the top-level tool
fact; result bindings are POSITIONAL top-level declarators with the slot's END-OF-SLOT binding
kept separate from its pre-emission binding so a binding declared after a slot-local emission
still binds a later final emission; a declaration SPLIT across slots (`const s =\nawait
tools.…`) is carried as a pending declaration adopted ONLY when the continuation slot itself
STARTS the awaited initializer (`const s =\n0; await …` is never adopted — the split and joined
layouts agree); the existing grammar's bounded in-memory literal decoder ported verbatim :899
(values discarded), the verbatim `parseCallStatements` acceptance mirror (:957-1055, used ONLY to
diagnose `parserStage` in the frozen stage order wrapper → arguments → output → residual →
directive :1073), the await-token boundary (an identifier continuation — `await$secret`,
`awaitπ` — after `await` is a plain statement, not the keyword), the final-emission
binding-equality rule (UNCERTAINTY PRECEDES EQUALITY: any unknown-classified slot anywhere, or
between the binding and the final emission, forces 'unknown' regardless of slot layout; no
relation recovered past unclassified slots) and the whole-input coverage rule in
`inspectCallShapeBody` :1130-1315 (the codex-round-12/13/14 EOF-truncation check `truncatedAtEnd` :1214). Evidence integration: `inspectCallShape` import :31, the
budgeted whole-fact drop projection `projectShapeFactsWithinBudget` :364 (full facts → drop the
`statements` array whole with `statementCount` retained → fixed minimal closed marker → omit), the
shape block assembly inside the gated excerpt :478-493 after the structural diagnostic's room is
reserved, the shape gate AND-combined with the structural gate at the evidence input boundary :2106,
and the classifier invoked ONLY for unknown raw calls at the existing seam (:2130 custom_tool_call;
:2150/:2165 function_call analogs — string bodies only). Driver: `--unclassified-shape-diagnostic`
added to the closed option set :287 with the literal-`1` gate :325 and the pair requirement
:328 (:523 programmatic, validated before any side effect); opt-in record marker `unclassifiedShapeDiagnostic`
:608 (the schema `version` inside the projected `shape` block is the closed version marker);
`--model` validated by the bounded safe-identifier pattern :270-275, forwarded as separate
`-m <id>` argv items :1772 threaded into the held-turn launch :2278, with `provenance.requestedModel`
recorded only when present :628 (effective host/Child model metadata stays `null`); observer provenance
bumped to `zcode-shell-wait-observer-v2` :41 hashing evidence.mjs ⊥ shape-diagnostic.mjs ⊥ driver.mjs
module-init bytes in BOTH the executing snapshot and the record-time re-read (a helper-only change
changes the executing digest; a two-file construction provably does not reproduce it — negative
control pinned by test). No admission path, parser, fixture, or production surface changed; default
retention (no gates) is byte-identical and pinned by test.

**Tests and gates (final counts at this correction commit — refreshed by the round-10 redesign,
self-review-round-3, the codex-round-11 through -15 paragraphs and the close-out corrections
below; history in the disposition paragraphs below).** Focused
`node --test --test-name-pattern='controlled shape diagnosis' tests/shell-wait-probe.test.mjs` =
102 tests / 5 suites / pass 102 / fail 0 (the pre-redesign count was 80, the post-redesign count
84, the post-round-3 count 88, the post-round-11 count 90, the post-round-12 count 92, the
post-round-13 count 94, the post-round-14 count 96, the post-round-15 count 98 and the
post-round-16 count 100; the +2 delta over 100 is the close-out-correction tests; the plan's
pinned example verbatim; the §15.1 eight-record
synthetic set with per-record divergence; record-6 fact-identity; the two-line accepted pair;
privacy canaries over strings/nested objects/templates/comments/identifiers/property names/
malformed directives; bounds over-budget/over-scope/argument-over-limit; unterminated string and
comment; template/regex unsupported-syntax; optional-chaining/nullish declared-unsupported family;
cross-line comment/template carrying; unmatched/mismatched delimiters incl. cross-line truncation;
Unicode invariance and raw-control-char mechanical rejection; nested-emission tail rule;
final-emission binding rule; partial-coverage rule; complete-reference rule; non-string fixed
result; never-throws battery; `parserStage` ⇔ `parseCallStatements` agreement over 12 inputs;
driver flag pair at CLI + programmatic + record + spawnSync-negative boundaries; evidence seam
projection, legacy byte-identity, budget tiers, shape-only refusal; provenance v2 binding with
negative control; model seam at CLI parse, argv composition, programmatic and CLI-negative
boundaries; quoted-string LF and CRLF continuations, withheld remainders after unsupported
syntax, invalid delimiters and templates, and the full round-2-through-round-9 boundary family
re-pinned to the canonical-exact expectations below).
`npm run test:shell-research` = 553/553 pass, 51 suites, 0 fail/skip (pre-Task-2 baseline on this
branch: 451/451 in 46 suites; the pre-redesign Task-2 count was 531, the post-redesign count 535,
the post-round-3 count 539, the post-round-11 count 541, the post-round-12 count 543, the
post-round-13 count 545, the post-round-14 count 547, the post-round-15 count 549 and the
post-round-16 count 551 — the deltas are the round-10, round-3, round-11 through round-16 and the
close-out finding tests). `node --test
tests/test-selection.test.mjs` = 6/6 (untouched — no isolation defect exists: the helper is imported
by the existing suite, no new test entry was created). `npm run lint` and `npm run typecheck` clean;
`node scripts/check-line-endings.mjs` = 537 tracked files verified, exit 0; `git diff --check` clean.
Importing the new helper launches nothing (Node builtins only; no spawn surface).

**Interpretive decisions as implemented (schema corners the frozen block leaves open; flagged for
the D0 adjudication, not silently).** (a) Non-string input returns the fixed out-of-scope result
`{version:1, coverage:'over-scope', statements:[], statementCount:0, tool:'no-call', head:'unknown',
tail:'none', bindingEquality:'unknown', parserStage:'unknown', directive:'unknown',
wholeInputConsumed:false}` — the schema has no invalid-input member, so "over-scope" reads as
outside the classifier's scope. (b) Record-budget overflow of the excerpt projection reuses
`coverage:'over-budget'` on the minimal marker — the incomplete marker semantics, not a new enum
member. (c) Statement slots are NEWLINE slots (mirroring the existing per-line cell splitter), so
the wrapper+emission pair on ONE line is ONE schema node carrying both head and tail — this is what
lets the plan's single-line example project `head:'bound-await'`/`tail:'text-binding'` as pinned.
(d) `parserStage` is the mechanical RAW-line mirror of the existing grammar (e.g. raw control
characters inside a JSON string literal reject the decode → 'arguments'; lexically broken lines →
'wrapper'), which can differ from the string-boundary-aware statement facts by design: the facts
describe the shape, the stage diagnoses the parser's response. (e) Trailing blank formatting keeps
every statement fact identical to the canonical control and diverges only on
`parserStage:'residual'` (the existing grammar rejects a blank line after the last statement).

**Self-review disposition (2026-10-16, commit `bde4bb6` reviewed; fixes amended into the same
commit).** Independent self-review verdict: CLEAN of P1/P2, five P3 findings. Findings 1, 2 and 4
were FIXED test-first (each RED observed for the stated reason, then GREEN): (1) the tail now
classifies the OUTERMOST emission's argument (shape-diagnostic.mjs:232 — `text(f(text(r)))` reports
`tail:'text-other'`/`bindingEquality:'unrelated'` instead of reading the nested `text(r)`; sibling
emissions keep last-top-level semantics), RED: tail was 'text-binding'; (2) coverage is
whole-input — any unknown-classified statement node (lexical not 'complete' or head 'unknown') now
yields `coverage:'partial'`/`wholeInputConsumed:false` (shape-diagnostic.mjs:600), RED: an
unsupported-syntax cell claimed 'complete'; the earlier "scan completed" interpretation is
superseded by this adjudication; (4) the pair invariant is total at the evidence API boundary too —
`unclassifiedShapeDiagnostic` alone projects NO shape block (evidence.mjs:2092), RED: shape-only
still projected the block. Findings 3 and 5 are ADJUDICATED, NO CODE CHANGE: (3) multi-call
`bindingEquality` is judged against the FINAL top-level emission only (refined to exactly this by
codex round 1, finding 4): the final emission's own argument must be a result-binding identifier for
any relation to hold, and only bindings at or before the final emission's own slot are compared —
the correct natural reading of §15.1's "an earlier statement's bound result vs the final emission's
argument identifier"; spellings never retained; recorded here as the v1 semantics, revisitable only
by a new adjudication. (5) The shape
budget assumes `scrubExcerpt` does not EXPAND the serialized JSON; a caller redaction string shorter
than the text it replaces could push serialized output past 2048, where the pre-existing scrubber
truncates honestly with `truncated:true` (never mid-JSON into a claimed-complete fact set — the
same exposure the legacy structural diagnostic has had since its introduction; pre-existing
pattern, not a Task 2 regression; no live or record-path change made this round).

**Codex gate round 1 disposition (2026-10-16, commit `5a51eed` reviewed; fixes amended into the
same task commit).** The independent codex review returned five P2 findings — all accuracy/privacy
defects where the classifier OVER-REPORTED on hostile or malformed input. All five were FIXED
test-first in the frozen v1 schema (no enum or bounds change needed), each RED observed for the
stated reason before the fix: (1) lexical state now carries ACROSS newline slots
(shape-diagnostic.mjs:150/:195) — the finding's `/*\ncode\n*/` comment-wrapped wrapper verbatim
previously leaked `exec_command` + equal-binding facts from COMMENT CONTENT (RED: middle slot
classified 'bound-await'); comment/template continuation slots are now unknown-classified and the
cell reports coverage 'partial'/wholeInputConsumed:false; (2) delimiters are tracked BY TYPE with
the stack carried across lines (:195, cell-end truncation rule in `lexCellLines` :150) — truncated
`…({cmd:"x"}` was 'complete'/wholeInputConsumed:true (RED) and is now 'unterminated' with coverage
'partial'; a mismatched `]` is now 'invalid'; the observed pretty-printed wrapper (delimiters
across lines) stays lexically sound; (3) `?.`/`?.[` and `??` are detected as the DECLARED
unsupported family BEFORE structural classification (:255) — `text(r?.status)` established a
'text-other' output diagnosis (RED) and is now 'unsupported-syntax'/head/tool unknown/'wrapper'
stage/coverage 'partial' (plain ternaries unaffected); class-field syntax has no reliably lexible
detector at v1 and is disclosed as not specially detected; (4) `bindingEquality` is judged ONLY
against the FINAL top-level emission (:721) — `const r = …; text(r);\ntext("done");` reported
'equal' from the EARLIER emission (RED) and is now 'unrelated' with the final emission keeping its
'text-other' class; (5) public tool/emission facts require COMPLETE references (:323/:345) —
`$tools.exec_command(…)` established the allowlisted tool fact (RED: `` treats `$` as a boundary)
and is now 'no-call', and `obj.text(r)` established a binding tail + 'equal' (RED) and is now
tail 'none'/'unrelated'. Implementation choices disclosed: the complete-reference left boundary
excludes `.` in addition to identifier characters (STRICTER than the finding's letter, matching its
"arbitrary member accesses" defect class); unsupported-syntax slots diagnose `parserStage:'wrapper'`
(the pinned patterns cannot match a form the grammar does not know — consistent with the
lexically-broken rule); no EXISTING assertion encoded the defective behavior, so none was updated —
the only test correction was this round's OWN new finding-5 test (a newline-slot indexing premise).
Gates rerun after the fixes, all green at that round: focused 47/47 (5 suites);
`npm run test:shell-research` 498/498 pass in 51 suites, 0 fail/skip; selection 6/6; lint clean;
typecheck clean; LF 537 tracked files; `git diff --check` clean. Canonical/record-2/record-6
invariances and the evidence seam's legacy byte-identity all re-pinned green after the rewrite
(final counts at this amended commit are in the Tests-and-gates paragraph above).

**Codex gate round 2 disposition (2026-10-16, commit `40fe233` reviewed; fixes amended into the
same task commit).** A second independent codex review returned five NEW P2 findings of the same
class (lexer-state/attribution corners where private content could still establish public syntax
facts); round 1's fixes were verified good. All five were FIXED test-first inside the frozen schema,
each RED observed for the stated reason before the fix: (1) quoted-string state now carries across
backslash-newline line continuations (:210 — the finding's `cmd:'x'}); text(r);` continuation line
was previously lexed as CODE and produced tool/binding facts; it is now string content, unknown-
classified); (2) lexical boundaries are no longer abandoned after an unsupported token — the lexer
meets the finding's `x?.y; /*\ncode\n*/` shape by withholding the whole cell remainder once ANY
unsupported token is seen, so the trailing comment content can never be rediscovered as code;
(3) template literals (declared unsupported, escape-sensitive delimiters) now withhold the rest of
the cell on FIRST contact — an escaped backtick no longer "closes" anything and a later closed
template cannot restore code state; (4) the complete-reference boundary (`followsPrivateExpression`
:342, used by both `completeToolCall` :382 and `outermostEmissionIndex` :361) now skips
whitespace/comment trivia back to the significant preceding character (a `.` there means member
access — `obj. tools. …` and `obj. text(…)` stay private) and honors a bounded Unicode ID_Continue
class plus `$` (`πtools. …` stays private) while keyword boundaries survive (`await tools. …` stays
public); (5) `bindingEquality` is never recovered past unclassified slots (:781) — `const r = …;
text(r);\ntext(` `done` `);` reports 'unknown', not 'equal'. SYSTEMATIC HARDENING (review
direction): rather than five point fixes, the lexer is now ONE forward state machine over the whole
cell whose states are exactly the constructs it tracks reliably (code, single/double-quoted strings
with line-continuation carry, block comments, the typed delimiter stack), and EVERY boundary it
cannot prove (templates, optional chaining, nullish coalescing, lone slashes) triggers the
conservative cell-remainder withhold (unknown classes + coverage 'partial' +
wholeInputConsumed:false) — over-reporting is structurally excluded rather than patched per case.
Disclosures: withholding after a lone slash makes a mid-cell division operator withhold the rest of
the cell (conservative; no observed wrapper family contains one); class-field syntax remains
undetected (no reliably lexible detector at v1, carried disclosure); one new round-2 test premise
corrected BEFORE its RED run (the escaped-backtick case originally ended at the closing template
and passed — strengthened to the finding's full shape with post-template code). Gates rerun after
the fixes, all green at that round: focused 52/52 (5 suites); `npm run test:shell-research` 503/503
pass in 51 suites, 0 fail/skip; selection 6/6; lint/typecheck/LF/diff-check clean
(final counts at this amended commit are in the Tests-and-gates paragraph above).

**Codex gate round 3 disposition (2026-10-16, commit `d3ece34` reviewed; fixes amended into the
same task commit).** A third independent codex review returned four NEW P2 findings of the same
lexer/boundary class (5→5→4, narrowing); the reviewer's sandbox could not execute the test suite,
so its reproductions were code-read-based — each was still treated as a real defect and proven with
this implementer's own RED→GREEN runs. All four were FIXED inside the frozen schema: (1) a
MISMATCHED delimiter now also conservatively withholds the cell remainder (:295-307) — the
finding's `]; /*\ncode\n*/` shape previously resumed the next line in code state and leaked
bound-await/exec_command/text-binding facts from comment content (RED observed); the failing line
keeps its own 'invalid' verdict while the remainder is 'unsupported-syntax' unknown-classified;
(2) reference-boundary context now carries ACROSS newline slots (:510/:833-841,
`maskedEndsWithSignificantDot` :385) — `obj.\ntools.exec_command({cmd:"x"})` established the public
tool fact and `obj.\ntext(r)` a public emission (both RED observed); a trailing member dot on the
previous masked line now makes the next line's leading references private while the lines stay
fully sayable (coverage 'complete'); (3) the boundary check reads the COMPLETE preceding Unicode
code point (`identifierContinuationBefore` :343, surrogate-pair aware) — `𐐀tools.exec_command(…)`
(astral ID_Start previously split into a lone low surrogate) reported public exec_command and
`𐐀text(r)` a binding tail (both RED observed), now 'no-call'/'none'; (4) emission matching is
TRIVIA-INSENSITIVE (:406): the `text` token is matched to its opening parenthesis across
whitespace and masked comments, so `text (r)` and `text /* c */ (r)` keep their 'text-binding'
tail and 'equal' relation (previously 'none'/'unrelated' — RED observed), the emission-first head
class survives the same spacing, longer identifiers (`textx (`) stay excluded, and — recorded
interpretation — `parserStage` stays the MECHANICAL mirror of the existing grammar, which rejects
the noncanonical spacing at its output stage ('output'), the same dual-report treatment as record
2's binding spelling. The output-stage rule was generalized accordingly (a pinned-head slot the
pinned skeleton does not accept diagnoses 'output' once the earlier wrapper/arguments stages pass).
Disclosures: the head-emission check was made trivia-tolerant (`^text\s*\(`) for consistency with
the tail rule beyond the finding's letter; the cross-line dot context is carried only as a
trailing-dot fact (a bare identifier at the previous line's end stays a token boundary, so the
genuine multi-line canonical family is unaffected); no EXISTING assertion encoded the defective
behavior — the only correction was this round's OWN new finding-1 test (its remainder assertion
over-pinned 'invalid' for the withheld lines; corrected before GREEN). Gates rerun after the
fixes, all green at that round: focused 56/56 (5 suites); `npm run test:shell-research` 507/507
pass in 51 suites, 0 fail/skip; selection 6/6; lint/typecheck/LF/diff-check clean
(final counts at this amended commit are in the Tests-and-gates paragraph above).

**Codex gate round 4 disposition (2026-10-16, commit `ffc5bfd` reviewed; fixes amended into the
same task commit).** A fourth independent codex review returned five NEW P2 findings of the same
class (5→5→4→5). Under the review's CONVERGENCE DIRECTIVE — per-corner cleverness is the problem;
where two treatments are admissible, take the conservative one — all five were FIXED test-first
inside the frozen schema: (1) quoted-string state now carries across backslash-CRLF line
continuations (:210 — a backslash-CR at end-of-line was previously consumed as an ordinary escape
and the next line resumed in code state, leaking exec_command/literal-object/text-binding facts
from private string content; RED observed); (2) the carried member-reference context is consulted
whenever leading trivia is skipped (`followsPrivateExpression` :384) and trivia-only lines keep it
alive (:833-843) — `obj.\n  tools.exec_command(…)` and `obj.\n  text(r);` and a comment-only
intervening line previously established public facts (RED observed); (3) emission candidates are
now TOP-LEVEL CALLS only (`depthBefore` :413 excludes in-braces candidates such as the method
definition `{text(r) {}}`; `precededByFunctionKeyword` :429 excludes `function text(r) {}`
declarations) — appending either to a wrapper previously re-established tail 'text-binding' from
the declaration (RED observed); the top-level-emission question is reliably decidable with the
depth rule, so the conservative-and-precise verdict is tail 'none' rather than 'unknown'
(disclosed); (4) a PUBLIC-POSITION trivia-split tool reference (`tools . exec_command(`,
`tools /* c */ . exec_command(`) is unknown-classified with coverage 'partial' instead of a
confident no-call claim under complete coverage (`publicPositionTriviaSplitToolReference` :503;
the preferred conservative treatment; RED observed) while reliably-decidable private references
and the canonical exact reference keep their precise facts — an initial over-broad version of this
check also unknown-classified reliably-decidable private references and was corrected before GREEN
(disclosed); (5) `inspectCallShape` now takes the call-type context
(`'custom-tool-cell' | 'direct-arguments'`, threaded through evidence.mjs :404/:2110/:2130/:2144/
:2157) — a direct function_call's wrapper-shaped arguments string previously persisted the
wrapper-stage diagnosis (the reviewer's `const r` example reads 'parse-accepted'; this
implementer's RED with a noncanonical binding read 'wrapper' — the same contradiction class), and
the direct-call context now withholds the verdict ('unknown') so the persisted parserStage can
never contradict the real parser's response for that call type. No enum or bounds change; no
existing assertion encoded a defective behavior and none was updated. Gates rerun after the fixes,
all green at that round: focused 61/61 (5 suites); `npm run test:shell-research` 512/512 pass in
51 suites, 0 fail/skip; selection 6/6; lint/typecheck/LF/diff-check clean (final counts at this
amended commit are in the Tests-and-gates paragraph above).

**Codex gate round 5 disposition (2026-10-16, commit `045d74b` reviewed; fixes amended into the
same task commit).** A fifth independent codex review returned three NEW P2 findings of the same
class (5→5→4→5→3, narrowing). Under the standing convergence directive, all three were FIXED
test-first inside the frozen schema: (1) per-line emission depth is CELL-RELATIVE — `depthBefore`
(:435) now adds the lexer's carried delimiter-stack depth for the line, so `text(r) {}` inside an
object spanning lines (`const obj = {\ntext(r) {}\n};`) is a method declaration at cell depth 1
and no longer established tail 'text-binding'/'equal' (RED observed; the genuine emission keeps
its facts); (2) identifier ESCAPES keep references private — `precededByUnicodeEscape` (:379)
detects a `\u{...}` escape immediately before the candidate (`privat\u{65}tools` spells
`privatetools`), treating the boundary as not reliably decidable and the reference as non-public
(previously the raw `}` read as a public boundary; RED observed for both the tool and the emission
fact); (3) the emission-token guard extends to `function*` generator declarations
(`precededByFunctionKeyword` :452) and `new` constructor invocations
(`precededByNewKeyword` :464), and beyond the reliable skips the candidate must sit in a PROVEN
call position (`provenCallPosition` :482: start-of-slot or after `;`/`}`/`{`) — an unproven context
(e.g. an assignment `const assigned = text(r);`) withholds the tail as 'unknown' AND the binding
relation as 'unknown' (RED observed for all three), per the convergence directive: withhold rather
than assert where the preceding-token context is not reliably decidable. Disclosures: the proven-
position allowlist is deliberately narrow (start/`;`/`}`/`{`), so ordinary-call positions after
other tokens now withhold rather than bind — conservative within the frozen contract; a relation
is never asserted while any undecidable emission exists in the cell. No enum or bounds change; no
existing assertion encoded a defective behavior and none was updated. Gates rerun after the fixes,
all green at that round: focused 64/64 (5 suites); `npm run test:shell-research` 515/515 pass in
51 suites, 0 fail/skip; selection 6/6; lint/typecheck/LF/diff-check clean (final counts at this
amended commit are in the Tests-and-gates paragraph above).

**Codex gate round 6 disposition (2026-10-16, commit `85a923e` reviewed; fixes amended into the
same task commit).** A sixth independent codex review returned three NEW P2 findings of the same
family — new instances the round-5 allowlist narrowing had not yet covered. Under the standing
convergence directive, all three were FIXED test-first inside the frozen schema: (1) UNCERTAINTY
PRECEDES IDENTIFIER EQUALITY — the binding-equality rule is now global: ANY undecidable emission
in the cell (even one SHARING a slot with a proven emission:
`const r = await tools.exec_command({cmd:"x"}); text(r); const assigned = text(other);` reported
'equal' — RED observed), or ANY unknown-classified slot between the binding and the final
emission, forces 'unknown' regardless of slot layout; (2) call-position context carries ACROSS
newline slots — start-of-slot is a proven call position ONLY when the previous content line ended
at a proven statement boundary (`;` or `}`; `maskedEndsWithStatementBoundary` :481), so an
arrow-body continuation (`const f = () =>\ntext(other);`) withholds as 'unknown' instead of
reporting 'text-other'/'not-equal' under complete coverage (RED observed), and a trailing `new`
carries across the break (`maskedEndsWithIdentifierNew` :492 / `precededByNewKeyword` :466) so
`new\ntext(r);` stays a constructor invocation ('none'; RED observed); (3) the await token
requires a COMPLETE boundary — the head regexes now reject an identifier continuation after
`await` (`(?![\p{ID_Continue}$])`), so `await$secret` no longer reports head 'bound-await' +
'equal' and `awaitπ;` no longer reports 'bare-await' (both RED observed; renaming a private
identifier no longer changes retained facts). Disclosures: the cell start counts as a proven
statement boundary (the canonical first-slot emission family stays recognized); a trivia-only
line keeps all carried contexts; no enum or bounds change; no existing assertion encoded a
defective behavior and none was updated. Gates rerun after the fixes, all green at that round: focused 67/67
(5 suites); `npm run test:shell-research` 518/518 pass in 51 suites, 0 fail/skip; selection 6/6;
lint/typecheck/LF/diff-check clean (final counts at this amended commit are in the Tests-and-gates
paragraph above).

**Self-review round 2 disposition, post-codex-round-6 (2026-10-16, commit `a2b1f41` reviewed;
fixes amended into the same task commit).** A fresh full-diff self-review returned one P2 and two
P3 findings, all FIXED test-first inside the frozen schema: (1) [P2] a public tools reference SPLIT
across newline slots (`const r = await tools.\nexec_command({cmd:"x"}); …` and
`const r = await tools\n.exec_command({cmd:"x"}); …`) yielded a confident tool 'no-call' under
complete coverage while the identical same-line trivia split is unknown-classified — a new carried
context (`maskedEndsWithSplitToolReference` :510: the previous line's significant tail is the bare
`tools` token or `tools` + member dot) now routes the continuation slot through the SAME round-4
conservative relabeling (unknown-classified, coverage 'partial', never a confident 'no-call';
RED: the continuation slot was lexical 'complete' with tool 'no-call'; GREEN observed for both
demonstrated inputs); (2) [P3] RULE CHANGE, conservative per the round-5 directive: when the FINAL
top-level emission occurrence is UNDECIDABLE, the top-level tail itself is now 'unknown' — an
earlier proven emission is never asserted over it (`const r = await tools.exec_command({cmd:"x"});
text(r); if (x) text(s);` previously asserted tail 'text-binding' while only the relation was
withheld; the pinned round-5 regression test was EXTENDED with this case, disclosed here as the
one existing-test update, and it encoded the defective behavior by omission); (3) [P3] the §15.2
decoder anchor was stale (:629 → the function head :617 at review time; re-measured to :639 after
this round's own insertions shifted it again — the deliverable paragraph above always carries the
FINAL amended-state anchors). No enum or bounds change; no live run. Gates rerun after the fixes,
all green at that round: focused 68/68 (5 suites); `npm run test:shell-research` 519/519 pass in
51 suites, 0 fail/skip; selection 6/6; lint/typecheck/LF/diff-check clean (final counts at this
amended commit are in the Tests-and-gates paragraph above; anchors re-measured after every
round's insertions).

**Codex gate round 7 disposition (2026-10-16, commit `db23163` reviewed; fixes amended into the
same task commit).** A seventh independent codex review returned four NEW P2 findings of the same
conservative family, all confirmed reaching the persisted evidence projection. All four were FIXED
test-first inside the frozen schema: (1) an emission reference SPLIT across a newline slot
(`const r = await tools.exec_command({cmd:"x"}); text(r);\ntext\n(other);` — the scan only
searched the current line for the opening parenthesis, so the final emission was missed and the
EARLIER emission asserted 'equal' under complete coverage; RED observed) — a new carried context
(`maskedEndsWithSplitEmissionReference` :532: a line whose significant tail is the bare `text`
token, including the ORIGINATING slot itself) routes the continuation through the round-4
conservative treatment (unknown-classified, coverage 'partial', relation 'unknown');
(2) SUBSEQUENT result bindings within one slot (`const r = await …; const s = await …; text(s);`
persisted 'not-equal' from the FIRST declaration while the split layout reported 'equal' — RED
observed for both layouts) — the slot now tracks POSITIONAL result bindings and the relation uses
the last binding BEFORE the final emission point (the implementer's chosen treatment: the finding's
option (a) — the binding preceding the final emission IS reliably decidable positionally, so both
layouts now agree on the truthful 'equal' rather than withholding; disclosed); (3) PRIVATE-NAME
suffixes (`this.#tools.exec_command(…)`) persisted tool 'exec_command' because the boundary check
accepted `#` (RED observed) — a `#` immediately before the candidate now keeps the reference
private ('no-call', the reliably-decidable treatment); (4) ESCAPED identifier continuations after
await (`const r = await\u0061; text(r);` — the identifier `awaita`, not the keyword) persisted
head 'bound-await' + 'equal' because the lookahead accepted the backslash as a boundary (RED
observed) — the await-token lookaheads now also reject a following backslash (any escape), for
both the bound-await and bare-await checks. No enum or bounds change; no existing assertion
encoded a defective behavior and none was updated. Gates rerun after the fixes, all green at
that round: focused 72/72 (5 suites); `npm run test:shell-research` 523/523 pass in 51 suites,
0 fail/skip; selection 6/6; lint/typecheck/LF/diff-check clean (final counts at this amended
commit are in the Tests-and-gates paragraph above).

**Codex gate round 8 disposition (2026-10-16, commit `b2dc633` reviewed; fixes amended into the
same task commit).** An eighth independent codex review returned four NEW P2 findings under a
UNIFYING DIRECTION: replace the remaining piecemeal first/last-match scans with POSITIONAL,
token-based per-slot analysis (the round-7 `bindings` array as the model), make identifier
tokenization Unicode-aware via the bounded ID_Continue/ID_Start classes, and carry declaration
state across slots like the other carried contexts; where a question remains undecidable, withhold.
All four were FIXED test-first inside the frozen schema: (1) NESTED-DECLARATION bindings — the
binding scan now keeps TOP-LEVEL declarations only (cell-relative depth via `depthBefore`), so a
function-local `const s = await other();` can no longer supply the top-level emission's binding
(`…async function f() { const s = await other(); } text(r);` persisted 'not-equal' — RED observed;
now 'equal', agreeing with the split layout); (2) UNICODE identifier tokens — tool names, binding
identifiers, and emission-tail identifier patterns use the bounded ID_Continue/ID_Start classes:
`await tools.工具({});` persisted a confident 'no-call' under complete coverage (RED observed) and
now reports the fixed 'other' class for the recognized non-allowlisted call, and
`const π = await tools.exec_command({cmd:"x"}); text(π);` persisted 'unrelated' (RED observed)
and now participates in bindingEquality as 'equal' with head 'bound-await'/tail 'text-binding'
(the finding's conservative unknown-fallback was NOT needed — full Unicode tokenization is
reachable with the existing bounded classes); (3) declarations SPLIT across slots — a new carried
context (`pendingDeclarationIdentifier` :550, top-level only) makes `const s =\nawait
tools.exec_command({cmd:"x"});\ntext(s);` bind the next slot's call (persisted 'unrelated' — RED
observed; now 'equal', agreeing with the joined layout); (4) LATER tool-calling statements within
a slot — tool calls are collected POSITIONALLY (`completeToolCalls` :640) and the LAST one mirrors
the top-level tool fact, so `await tools.other({}); await tools.exec_command({cmd:"x"});` now
mirrors 'exec_command' like the split layout (persisted 'other' — RED observed); the slot's
argument class pairs with the same last call. No enum or bounds change; no existing assertion
encoded a defective behavior and none was updated. Gates rerun after the fixes, all green at
that round: focused 76/76 (5 suites); `npm run test:shell-research` 527/527 pass in 51 suites,
0 fail/skip; selection 6/6; lint/typecheck/LF/diff-check clean (final counts at this amended
commit are in the Tests-and-gates paragraph above).

**Codex gate round 9 disposition (2026-10-16, commit `add2d85` reviewed; fixes amended into the
same task commit).** A ninth independent codex review returned four NEW P2 findings. All four
were FIXED test-first inside the frozen schema: (1) UNSUPPORTED-REFERENCE checks now fire
INDEPENDENTLY of canonical matches — `await tools.exec_command({cmd:"x"}); await tools
.other({});` previously hid the trivia-split reference behind the earlier canonical call
(persisted tool 'exec_command' under complete coverage; RED observed) and now relabels the slot
unknown/partial; the trivia-split pattern was tightened to require ACTUAL trivia adjacent to the
member dot so it never relabels a canonical call (the canonical-only invariance stays pinned);
(2) a binding declared AFTER a slot-local emission now still binds a LATER final emission — the
slot keeps its END-OF-SLOT binding state separately from its pre-emission binding
(`const r = await f(); text(r); const s = await g();\ntext(s);` persisted 'not-equal' while the
split layout gave 'equal' — RED observed for the disagreement; both layouts now 'equal');
(3) a PENDING binding is adopted ONLY when the continuation slot establishes the corresponding
AWAITED initializer — `const s =\n0;\ntext(s);` persisted 'equal' (RED observed; a non-await
initializer can never become an awaited-result binding) and now discards the pending identifier
to 'unrelated', agreeing with the joined layout, while the awaited continuation stays 'equal';
(4) an identifier-START escape in reference position (`await \u0074ools.exec_command({cmd:"x"});
` — spelling `tools` through an escape) persisted a confident tool 'no-call' under complete
coverage (RED observed) and now withholds the slot unknown/partial
(`containsIdentifierStartEscape` :396; escapes BETWEEN identifier characters remain reliably
handled by the boundary device, disclosed). No enum or bounds change; no existing assertion
encoded a defective behavior and none was updated. Gates rerun after the fixes, all green:
focused 80/80 (5 suites); `npm run test:shell-research` 531/531 pass in 51 suites, 0 fail/skip;
selection 6/6; lint clean; typecheck clean; LF 537 tracked files; `git diff --check` clean;
canonical/record-2/record-6 invariances and the evidence seam's legacy byte-identity re-pinned
green.

**Canonical-exact design evaluation (root adjudication requested; NOT redesigned this round).**
After nine rounds of carried-context corners, a "canonical-exact recognition + everything
non-canonical unknown/partial" design would likely be a SIMPLER TERMINATING SHAPE: pros — one
positive grammar (the pinned wrapper/inline/preparation/root-control patterns already exist),
every non-match falls to a single unknown/partial path (no carried-context matrix to grow), the
frozen 8-record set is fully discriminated by exactly that grammar, and the review surface
shrinks from ~20 boundary helpers to pattern-conjunction checks; cons — the current classifier
additionally answers questions the canonical grammar cannot (e.g. distinguishing an
unsupported-argument wrapper from a foreign statement, the trivia-tolerant `text (r)` emission,
and per-statement head/tail classes for partial cells), so a naive collapse would lose that
diagnostic richness unless the unknown path also carried a small coarse-fact block (statement
count, byte class, await presence); effort — a focused rewrite of `classifyStatementSlot` +
`diagnoseParserStage` (~200 lines) plus re-pinning ~30 of the 80 focused tests, est. one session.
Root's call; the current design remains within contract.

**Canonical-exact redesign (round 10 adjudication, EXECUTED; 2026-10-16, same amended task
commit).** After codex round 10 returned four more P2 findings (stable ~4/round, all living in the
classifier's carried-context/boundary-helper web), the root adjudicated the redesign this
evaluation paragraph anticipated, a first attempt was abandoned mid-rewrite and rolled back
cleanly, and this rewrite was executed at full capacity. ARCHITECTURE: positive recognition is now
the pinned grammar mirrors ALONE — every statement slot is segmented at top-level `;`/`}`
boundaries over the string/comment-masked code (the lexer `lexCellLines`/`lexCellLine` is kept
verbatim), and EVERY segment must match one explicit positive statement form anchored in a proven
statement position; the positive forms are the frozen 8-record discrimination set expressed as
direct mechanical variants of the verbatim WRAPPER/INLINE mirrors (generalized binding
identifier, missing tail, changed tail incl. `text(JSON.stringify(r))`/`text(r.<prop>)`,
unsupported argument form, extra statement, trailing blank formatting), the trivia-tolerant
emission (`text\s*\(` — masked comments ARE trivia), and the awaited-call statement (the wrapper
skeleton without the binding prefix, required by the split-declaration and comma-declarator
variants); the mechanical parser-stage mirror (`diagnoseParserStage` and its raw-line helpers) is
kept verbatim as variant (c). EVERYTHING ELSE collapses into ONE conservative unknown path BY
CONSTRUCTION — a non-matching segment, a `tools`/`text` token (exact identifier boundaries,
surrogate-pair exact) outside a pinned position, any backslash escape in code position, a slot
inside a spanning bracket construct, or an unproven statement position classifies the whole slot
unknown (head/tool 'unknown', coverage 'partial', wholeInputConsumed false, bindingEquality
'unknown') — which is what DELETES the boundary-helper web wholesale (eleven helpers:
`identifierContinuationBefore`, `precededByUnicodeEscape`, `containsIdentifierStartEscape`,
`followsPrivateExpression`, `maskedEndsWithSignificantDot`, `maskedEndsWithIdentifierNew`,
`maskedEndsWithSplitToolReference`, `maskedEndsWithSplitEmissionReference`,
`pendingDeclarationIdentifier`, `provenCallPosition`, `publicPositionTriviaSplitToolReference`,
plus `depthBefore`, `completeToolCalls`, `outermostEmissionIndex`, `precededByFunctionKeyword`,
`precededByNewKeyword`; only the trivial `maskedEndsWithStatementBoundary` survives as the
carried proven-start bit). The frozen schema v1 is UNCHANGED (same enums, bounds, mirrors,
budget projection, truncation-never-success); evidence.mjs/driver.mjs interfaces stay as-is;
provenance digest v2 bytes changed automatically with the helper rewrite (designed behavior,
pinned by the negative-control tests). ROUND-10 CLASSES, CORRECT BY CONSTRUCTION, EACH PINNED AS
A TEST: (i) `const _r = await tools.exec_command({cmd:"x"}); text(_r);` binds normally — `$` and
`_` are ECMAScript identifier-start characters NOT inside `\p{ID_Start}` (the low line U+005F is
a separate property), so the identifier classes spell both out; head 'bound-await', tail
'text-binding', bindingEquality 'equal', coverage 'complete' (test 'an underscore-initial binding
is an ordinary JavaScript identifier (round 10, class i)'; the pre-redesign classifier reported
head 'other'/tail 'text-other'/'unrelated' — a genuine defect); (ii) `const r =\n0; await
tools.exec_command({cmd:"x"}); text(r);` — the pending declaration is adopted ONLY when the
continuation slot itself STARTS the awaited initializer, so the split layout reports
'unrelated', AGREEING with the joined `const r = 0; …` layout (test 'a pending declaration is
adopted only when the continuation starts the awaited initializer (round 10, class ii)';
pre-redesign: 'equal' vs joined 'unrelated' — a layout disagreement defect); (iii) `const r =
await tools.exec_command({cmd:"x"}), s = await tools.exec_command({cmd:"y"}); text(s);` —
comma-separated declarators are handled POSITIONALLY (the last awaited binding before the final
emission binds it): both layouts 'equal' (test 'comma-separated declarators bind positionally
like the split layout (round 10, class iii)'; pre-redesign: 'not-equal' vs split 'equal'); (iv)
an identifier escape ANYWHERE inside a reference token (`await \u0074ools.exec_command(…)`,
`await tools.exec_comman\u0064(…)`, `privat\u{65}tools…`) withholds the slot unknown/partial —
never a confident presence OR absence (test 'an identifier escape anywhere in a reference token
withholds the slot (round 10, class iv)'; pre-redesign: the escape-at-end form persisted a
confident 'no-call' under COMPLETE coverage — the over-reporting defect class all ten rounds
kept finding). EIGHT-RECORD + PARSER-STAGE NON-COARSENING, VERIFIED EXPLICITLY: records 1-8
re-verified at this commit with FULL fact-set equality against the frozen expectations (record 1
canonical 'parse-accepted'/'equal' deep-equal; record 2 identical facts except parserStage
'wrapper'; record 3 'output'/'none'/'unrelated'; record 4 stringify canonical and property
'text-other'/'output'/'equal'; record 5 'unsupported' at the 'arguments' stage; record 6
fact-identical to the canonical control AND still accepted by the real parser; record 7 'other'
statement at 'residual' with 'equal'; record 8 residual-stage-only divergence), and the
`parserStage` ⇔ `parseCallStatements` agreement holds over all 12 pinned inputs. COARSENING
DISCLOSURES (per item; every affected existing test re-pinned to the honest new expectation —
each is the plan's "smallest finite classifier" + honest-unknown semantics doing exactly what
they sanction: a public syntax fact the canonical grammar cannot positively recognize is no
longer asserted): (1) same-line member-receiver emission `obj.text(r)` — was tail 'none'/
'unrelated' under complete coverage, now the slot withholds unknown/partial (test 'public syntax
facts require COMPLETE tool and emission references'); (2) trivia-after-dot references `obj.
tools.…`/`obj. text(…)` — was 'no-call'/'none', now withheld unknown/partial (test
'complete-reference checks skip trivia and honor Unicode identifier continuations'; the
Unicode-continuation `πtools` case KEEPS its precise 'no-call' — it is a single identifier, so
the token scan is reliably decidable); (3) cross-line member chains `obj.\ntools.…`,
`obj.\n  tools.…`, `obj.\ntext(r);`, and the comment-line-carried variant — was
'no-call'/'none' under complete coverage, now withheld unknown/partial (tests 'reference
boundaries carry across newline slots', 'member-reference context survives leading trivia and
trivia-only lines'); (4) identifier-escape references `privat\u{65}tools…`/`…privat\u{65}text(r)`
— was 'no-call'/'none', now withheld (round-10 class iv; test 'identifier escapes keep
references private'); (5) function/generator declarations, method definitions and constructor
invocations carrying the emission token (`function text(r) {}`, `function* text(r) {}`,
`{text(r) {}}` incl. the spanning-object case, `new text(r);`, `new\ntext(r);`) — was tail
'none' under complete coverage, now withheld unknown/partial; the safety property (these never
establish an emission) is now true BY CONSTRUCTION rather than by exclusion lists (tests
'declarations and method definitions are not emission calls', 'generators, constructors and
unproven contexts are not emission calls', 'per-line emission depth is cell-relative across
spanning objects' — the spanning case additionally coarsens bindingEquality 'equal'→'unknown'
and coverage 'complete'→'partial' because unclassified slots follow the final emission); (6)
unproven-position assignments (`const assigned = text(other);`) — tail/relation stay 'unknown'
but coverage coarsens 'complete'→'partial' (test 'uncertainty precedes identifier equality
regardless of slot layout'); (7) private-name class bodies (`this.#tools.…`) — was 'no-call'
under complete coverage, now withheld unknown/partial (test 'private-name suffixes never
establish the public tool reference'); (8) escaped await continuations (`await\u0061`) — was
head 'other'/'unrelated', now withheld 'unknown' (test 'escaped identifier continuations after
await are not the keyword'; the `await$secret`/`awaitπ` cases KEEP their precise 'other' heads —
token-boundary failures are decidable without escapes); (9) the trivia-split and cross-line
split reference slots keep their unknown classification but the slot's LEXICAL verdict is now
the lexer's honest 'complete' (the withhold is a classification verdict, not a broken-lexical
verdict — the old 'unsupported-syntax' label on lexically sound lines is retired) in tests 'a
trivia-split tool reference is unknown-classified, never a no-call claim', 'a tool reference
split across newline slots is unknown-classified, never a confident no-call', 'an emission
reference split across a newline slot withholds the relation', 'unsupported references relabel a
slot even when a canonical call shares it', 'escaped references in reference position are
unknown-classified'; (10) `await tools.工具({});` KEEPS its recognized 'other' call class
(Unicode tool names are inside the pinned call form); the astral `𐐀tools` case KEEPS its precise
'no-call' (𐐀 is ID_Start ⊂ ID_Continue, so `𐐀tools` is one identifier — no re-pin needed).
Net: 17 existing tests re-pinned, 4 tests added, focused suite 84/84, shell-research 535/535;
all gates re-run green after the rewrite (focused 84/84 in 5 suites; selection 6/6; lint clean;
typecheck clean; LF 537 tracked files; `git diff --check` clean; canonical/record-2/record-6
invariances, the evidence seam's legacy byte-identity and the privacy canary battery re-pinned
green). At that round the helper was 1184 lines (was 1246): the deleted boundary-helper/scanner
web exceeded the added explicit grammar and segmentation machinery even with the expanded module
documentation.

**Self-review round 3 (post-redesign) disposition (2026-10-16, commit `49e33cc` reviewed;
fixes amended into the same task commit).** An independent full-diff self-review of the
redesign returned three P2 and two P3 findings; the architecture itself held (anchoring
verified for awaited/emission/plain heads, the 8-record set un-coarsened, the deleted helpers
confirmed gone), and all five were FIXED test-first inside the frozen schema (each RED observed
for the stated reason before the fix; the round-10 by-construction tests, the 8-record
fact-set equality and the parser-stage agreement were all re-verified after the fixes).
(1) [P2] TRIVIA-ONLY SLOTS BECAME PHANTOM STATEMENT NODES — `// nothing here` alone reported
statementCount 1/head 'other'/complete/consumed-true, a canonical cell plus a trailing `// done`
reported tail 'none' (truth 'text-binding') and count 2, and a leading `/* lead */` blanked the
head (truth 'bound-await'): a comment-only line is now FORMATTING — it carries NO statement
node, skipped like a blank line for the mirrors, the statement count and whole-input coverage
(RED: the three shapes asserted; GREEN: count 0 / tail 'text-binding' / head 'bound-await'; a
line whose lexed view is blank but NOT complete — an unterminated comment opener, a withheld
remainder — stays real unrecognized content). parserStage stays the mechanical raw mirror: the
trailing comment line still rejects the existing grammar at its residual stage (pinned); the
one sanctioned re-pin is the comment-only intervening line in 'member-reference context
survives leading trivia and trivia-only lines', whose tools slot moved from index 2 to index 1
(the phantom node is gone). (2) [P2] THE CONST-ANCHORED EXEMPTION RECOGNIZED PUBLIC FACTS AT
UNPROVEN STATEMENT POSITIONS — `foo.\nconst r = await tools…; text(r);` and the invalid-JS
`if (x)\nconst r = …` reported complete/consumed-true with the full wrapper fact set because
the withholding gate covered only awaited/emission/plain heads. TREATMENT (the review's
preferred option (a), consistency with the pre-redesign rounds-2/6 direction): EVERY head now
requires a proven statement position — cell start, a previous content slot that ended at
`;`/`}`, or a previous POSITIVELY COMPLETED statement (the declaration/awaited-call/emission
forms are anchored complete statements even without their optional trailing `;`, which keeps
the observed two-line pair recognized — its first line ends on the completed emission form).
The false module comment claiming const-anchored forms are self-proven was rewritten.
`foo.`/`if (x)` continuations now withhold unknown/partial; cell-start, after-`;`-statement and
the pair keep their facts (RED→GREEN pinned in 'const-anchored heads require a proven statement
position (self-review round 3, finding 2)'). (3) [P2] A PENDING DECLARATION'S NON-AWAIT
CONTINUATION WAS ASSERTED AS A STANDALONE STATEMENT — `const s =\ntext(x); await tools…`
reported complete with statements[1] emission/text-binding and top-level tail 'text-binding'
while the joined `const s = text(x); await …` withholds. TREATMENT: a dangling pending
declaration licenses ONLY its own initializer continuation (awaited-call, declaration, pending
and token-free plain heads — `const r =\n0;` stays the recognized initializer); an EMISSION
head after a pending declaration withholds exactly like the joined layout (RED→GREEN pinned in
'a pending declaration withholds emission continuations (self-review round 3, finding 3)';
both layouts now unknown/partial, layouts agree). (4) [P3] ONE NON-AWAITED DECLARATOR
DOWNGRADED THE WHOLE DECLARATION — `const r = await f(), s = 2; text(r);` collapsed to plain
('unrelated'/'other') while the split layout reported 'equal'. TREATMENT (the review's
positional option, disclosed): mixed declarator lists are handled PER-DECLARATOR — non-awaited
declarators are skipped positionally (they carry no result binding) when token-free, so the
awaited bindings survive in both layouts ('equal'/'bound-await' in both, pinned in 'mixed
declarator lists keep the awaited bindings positionally (self-review round 3, finding 4)'); a
non-awaited declarator carrying a public-reference token is never silently ignored — the slot
withholds (pinned in the same test). (5) [P3] ANCHOR DRIFT — the deliverable paragraph cited
the pending-declaration pattern at :403 (actually :408 at that commit); all deliverable
anchors were re-measured and refreshed to this commit's final state (the classifier file is
now 1221 lines). Gates rerun after the fixes, all green: focused
`node --test --test-name-pattern='controlled shape diagnosis' tests/shell-wait-probe.test.mjs`
= 88/88 in 5 suites (the +4 delta over the post-redesign 84 is this round's four
finding tests); `npm run test:shell-research` = 539/539 in 51 suites, 0 fail/skip; selection
6/6; lint clean; typecheck clean; LF 537 tracked files; `git diff --check` clean; the 8-record
fact-set equality, the 12-input parser-stage agreement and the round-10 by-construction tests
re-verified green after the fixes.

**Codex gate channel record (rounds 7/11; 2026-10-16).** The plain `review` channel died 4/4
attempts on the post-redesign diff, all with the same signature: the reviewer's
`node --input-type=module -e` reproduction wedged and the job was lost ~10 minutes later (jobs
review-mvb31x8r-nckguf, review-mvb4449r-cd5kba, review-mvbaymia-bca13k, review-mvbdjvrk-ou80vi).
The review was then completed via the adversarial-review channel with an honest scope statement —
root adjudication after the user-directed plain-channel preference proved mechanically blocked;
the deviation is recorded here, not silently substituted.

**Codex gate round 11 disposition (2026-10-16, commit `655b926` reviewed; fix amended into the
same task commit).** The adversarial review of the post-round-3 state returned needs-attention
with ONE finding, FIXED test-first inside the frozen schema (RED observed verbatim before the
fix): the line-comment mask ended only at the LF the slot split consumed, so `// lead<U+2028>
const alias = await tools.exec_command({cmd:"x"}); text(alias);` (and the CR and U+2029
variants) swallowed the ENTIRE remaining slot into the comment — zero statements, tool
'no-call', coverage 'complete', wholeInputConsumed true — a confident wrong absence reaching the
persisted evidence projection. TREATMENT (the review's preferred option (a), verified): the
comment mask now terminates at EACH ECMAScript line terminator (LF, CR, U+2028, U+2029 —
`isEcmascriptLineTerminator` :240; the terminators themselves are masked trivia) and lexing
CONTINUES over them in code state, so the remainder of the slot is still fully lexed and private
content after the separator stays masked; the post-separator code is then classified normally
by the top-level segmenter — the finding's verbatim inputs now report the TRUE facts
(bound-await/exec_command/text-binding/equal/complete) for all three separators. Regressions
pinned at both seams: 'a line comment ends at every ECMAScript line terminator (codex round 11)'
(classifier; asserts true facts + no binding spelling for U+2028/U+2029/CR) and 'a line comment
ended by a non-LF separator cannot hide the carried call (codex round 11)' (evidence
projection; asserts the persisted shape block carries tool 'exec_command' with the fail-closed
verdict unchanged and no canary survival). Invariances re-verified after the fix: whole-line
comments stay formatting, block-comment content stays masked (the round-1 leak pin), string
content after a separator produces no fake tokens or leaks, a non-canonical remainder after a
separator still withholds, and the 8-record fact-set equality plus the 12-input parser-stage
agreement hold. Gates rerun after the fix, all green: focused 90/90 in 5 suites (the +2 delta
over the post-round-3 88 is this round's two seam tests); `npm run test:shell-research` =
541/541 in 51 suites, 0 fail/skip; selection 6/6; lint clean; typecheck clean; LF 537 tracked
files; `git diff --check` clean.

**Codex gate round 12 disposition (2026-10-16, commit `a28678e` reviewed; fix amended into the
same task commit).** The twelfth adversarial review returned ONE finding (converging), FIXED
test-first inside the frozen schema (RED observed verbatim before the fix): a cell ending in a
dangling pending declaration — `const unfinished =` at end of input, alone or appended to a
canonical wrapper — reported coverage 'complete'/wholeInputConsumed true, and the appended form
even preserved bindingEquality 'equal', violating §15.1's truncation rule (never turn truncated
input into success): the slot loop carries `pendingIdentifier` but the completeness checks only
consulted unknown heads and lexical failures, so EOF never invalidated the unresolved
initializer. TREATMENT: the EOF-truncation flag (then `unresolvedPendingAtEnd` at :1156; generalized to
`truncatedAtEnd` :1189 by the round-13/14 fixes below) — the carried pending binding at end
of input (trailing blank and comment-only formatting lines do not resolve it; a genuine awaited
continuation resolves it inside the slot loop) — then folded into the whole-input coverage check
(now :1219) and takes precedence in the binding-equality chain (now :1265-1267): the cell reports
coverage 'partial'/wholeInputConsumed false with bindingEquality 'unknown' whenever the
initializer never arrived. All four required directions pinned in 'a dangling pending
declaration at end of input is unresolved truncation (codex round 12)': (i) `const unfinished
=` alone → partial/false/'unknown'; (ii) canonical wrapper + the dangling pending → the
wrapper's relation is NOT asserted ('unknown'); (iii) the valid split
`const s =\nawait tools…;\ntext(s);` stays 'equal'/complete; (iv) trailing blank/comment lines
do not resolve the dangling pending. The evidence-projection regression for (ii) is pinned in
'a dangling pending declaration at end of input never persists equal/complete (codex round
12)' — the persisted shape block reports bindingEquality 'unknown'/coverage
'partial'/wholeInputConsumed false with the fail-closed verdict unchanged. No existing
assertion encoded the defect and none was re-pinned. Gates rerun after the fix, all green:
focused 92/92 in 5 suites (the +2 delta over the post-round-11 90 is this round's two seam
tests); `npm run test:shell-research` = 543/543 in 51 suites, 0 fail/skip; selection 6/6; lint
clean; typecheck clean; LF 537 tracked files; `git diff --check` clean; the 8-record fact-set
equality and the 12-input parser-stage agreement re-verified green after the fix.

**Codex gate round 13 disposition (2026-10-16, commit `c0e74c2` reviewed; fix amended into the
same task commit).** The thirteenth adversarial review returned ONE finding (1/round for three
rounds — converging), FIXED test-first inside the frozen schema (RED observed verbatim before
the fix): `const alias = await receiver.\ntext(value);` — valid JavaScript for ONE member call
`receiver.text(value)` — was classified as a standalone emission (tail 'text-binding', a
'not-equal' relation, complete coverage, wholeInputConsumed true), and the constructor
continuation `const alias = await new\ntext(value);` fabricated the same; both reached the
gated evidence projection. ROOT CAUSE: the token-free awaited-expression fallback accepted
UNFINISHED fragments (a trailing member dot, a trailing `new` keyword), and
`endsInCompleteStatement` treated every declaration/awaited segment as completed regardless.
TREATMENT (the review's withhold option, chosen for consistency with the joined layouts —
DISCLOSED: the joined member/constructor forms already withhold unknown/partial, so the split
layouts now agree on the truthful withheld verdict rather than recognizing the continuation):
`expressionEndsUnfinished` (a denylist: a trailing member dot or a trailing `new` keyword —
deleted by the round-14 inversion below) gave every declaration/awaited segment an expression-
completion verdict, `endsInCompleteStatement` (now :852) is set only for a positively completed
statement, and the round-12 EOF flag was generalized to `truncatedAtEnd` (now :1189 = an
unresolved pending binding OR an unproven end) so an unfinished expression at end of input is truncation too — the cell
reports partial/wholeInputConsumed-false with the relation 'unknown' in every direction, and
the continuation slot withholds through the existing unproven-start gate instead of
fabricating a standalone emission. The module header's completeness claim was rewritten
accordingly. Regressions pinned at both seams: 'an unfinished awaited expression withholds its
continuation (codex round 13)' (classifier; both verbatim inputs, both continuation statements
unknown, joined-layout agreement, the EOF variant, and the canonical split-initializer/canonical
invariances) and 'an unfinished awaited expression never persists a fabricated emission (codex
round 13)' (evidence projection; the persisted shape blocks report tail 'unknown'/relation
'unknown'/partial/false with the fail-closed verdict unchanged). No existing assertion encoded
the defect and none was re-pinned. Gates rerun after the fix, all green: focused 94/94 in 5
suites (the +2 delta over the post-round-12 92 is this round's two seam tests);
`npm run test:shell-research` = 545/545 in 51 suites, 0 fail/skip; selection 6/6; lint clean;
typecheck clean; LF 537 tracked files; `git diff --check` clean; the 8-record fact-set equality
and the 12-input parser-stage agreement re-verified green after the fix.

**Codex gate round 14 disposition (2026-10-16, commit `a35ee1c` reviewed; fix amended into the
same task commit).** The fourteenth adversarial review returned ONE finding and its own
recommendation became the fix's shape: enumerating unfinished expression tails (dot, `new`, now
`+`, …) can never terminate, because JavaScript expressions continue after a LARGE open token
set — the round-13 denylist accepted `const alias = await receiver +\ntext(value);` as a
standalone emission (tail 'text-binding', a 'not-equal' relation, complete coverage,
wholeInputConsumed true; same facts in the gated evidence excerpt) and claimed complete
coverage for `const alias = await receiver +` alone at EOF. STRUCTURAL FIX — THE ALLOWLIST
INVERSION (the terminating generalization of rounds 12-14: completion is only ever asserted
from the pinned positive grammar): the `expressionEndsUnfinished` denylist is DELETED;
`expressionComplete` is now a positive proof — the segment's awaited expression IS a properly
closed pinned `tools.<name>(…)` call (`pinnedToolsCall`, the wrapper skeleton's own production,
balanced delimiters + empty residual) — and `endsInCompleteStatement` (:875) is set only for a
positively completed statement (the emission's closed `text(…)` counts as its own production).
ANY other awaited/declaration tail — an operator, a dot, `new`, an open paren, a comma,
anything — leaves completion unproven: a following line withholds through the existing
unproven-start gate (it continues that expression → unknown/partial, agreeing with the joined
layouts) and end of input is truncation through `truncatedAtEnd` (:1214 = an unresolved pending
binding OR an unproven end) → partial/false/'unknown'. The slot-level `;`/`}` boundary remains
the other completion proof, so `;`-terminated declarations (e.g. `const s = await other();`)
still prove completion. Regressions pinned at both seams: 'completion is proven only by the
pinned grammar, never by tail denial (codex round 14)' (classifier; the `receiver +`
continuation verbatim, BOTH round-13 forms routed through the same new rule, the `receiver +`
EOF truncation, and the pinned-call/`;`-boundary/canonical invariances) and 'an
operator-continued expression never persists a fabricated emission (codex round 14)' (evidence
projection; the persisted shape blocks report partial/false/'unknown' relation with the
fail-closed verdict unchanged — one test premise corrected before its GREEN run: the EOF
cell's persisted tail is 'none', the honest no-emission value, since truncation rides
coverage/relation). No existing assertion encoded the defect and none was re-pinned. Gates
rerun after the fix, all green: focused 96/96 in 5 suites (the +2 delta over the
post-round-13 94 is this round's two seam tests); `npm run test:shell-research` = 547/547 in
51 suites, 0 fail/skip; selection 6/6; lint clean; typecheck clean; LF 537 tracked files;
`git diff --check` clean; the 8-record fact-set equality and the 12-input parser-stage
agreement re-verified green after the fix.

**Codex gate round 15 disposition (2026-10-16, commit `a95034a` reviewed; fix amended into the
same task commit).** The fifteenth adversarial review returned ONE finding (same family — the
allowlist rule's application to MIXED declarator lists), FIXED test-first inside the frozen
schema (RED observed verbatim before the fix): `const alias = await tools.exec_command({cmd:
"x"}), other = receiver +\ntext(alias);` persisted complete/true with bindingEquality 'equal',
classifying the second line as a standalone emission — it actually continues `other`'s
initializer (the joined equivalent correctly withholds), and ending at `+` alone also claimed
complete coverage. ROOT CAUSE: the round-14 completion proof consulted `lastAwaitedExpression`
even when a LATER non-awaited declarator continues the declaration. TREATMENT: the declaration's
completion proof derives from the FINAL declarator's production (:663-678, :691-692 — a trailing
non-awaited initializer is the declaration's tail and has no allowlist production, so the
statement did NOT complete): the following line withholds through the existing unproven-start
gate (never a standalone emission/relation) and end of input is truncation through
`truncatedAtEnd` (:1202). Regressions pinned at both seams: 'declaration completion comes from
the FINAL declarator (codex round 15)' (classifier; the verbatim split, its EOF variant, the
joined-equivalent agreement, and the invariances — an all-awaited list completes through its
final declarator's pinned production pinned-closed without `;`, a `;`-closed list completes
through the boundary, and the round-14/class-iii positional binding pins keep passing) and 'a
non-awaited trailing declarator never persists a fabricated emission (codex round 15)' (evidence
projection; the persisted shape block reports tail 'unknown'/relation 'unknown'/partial/false
with the fail-closed verdict unchanged). No existing assertion encoded the defect and none was
re-pinned. Gates rerun after the fix, all green: focused 98/98 in 5 suites (the +2 delta over
the post-round-14 96 is this round's two seam tests); `npm run test:shell-research` = 549/549
in 51 suites, 0 fail/skip; selection 6/6; lint clean; typecheck clean; LF 537 tracked files;
`git diff --check` clean; the 8-record fact-set equality and the 12-input parser-stage
agreement re-verified green after the fix.

**Close-out corrections (2026-10-17, user-commissioned independent two-axis review of the
closed campaign; ONE dedicated correction commit on top of the task commits — cross-task
findings, not amended into them).** Two P3 findings, both FIXED test-first (RED observed before
each fix): (P3-1) the record-budget projection dropped facts without an explicit
serialization marker — `projectShapeFactsWithinBudget` (evidence.mjs :364, now EXPORTED for the
tier algebra) now sets the closed `retention: 'full' | 'partial'` field on EVERY tier (full
facts → 'full'; the `statements`-dropped tier → 'partial'; the minimal marker → 'partial'),
describing SERIALIZATION only — `coverage`/`wholeInputConsumed` keep describing the
CLASSIFICATION and are unchanged — and the minimal marker omits the redundant
`wholeInputConsumed` ('over-budget' always means false) so marker + retention fit the tightest
observed tier budget (67 serialized chars at sixteen slots; marker 60 chars); below even the
marker nothing projects. Tests: 'the shape projection marks record-budget retention on every
tier (close-out correction)' (unit tier algebra incl. the insufficient tier), 'the persisted
excerpt carries the retention marker when facts drop (close-out correction)' (the reviewer's
eight-slot reproduction through the gated excerpt), and the budget-tier test re-pinned with
retention assertions (the one disclosed re-pin). The §15.1 frozen schema record carries the
dated v1 amendment note quoting the field line. (P3-2) §15.4's environmental attribution
narrowed by the dated correction note appended in place: the base-worktree failure SUPPORTS
pre-existing environmental instability but load is NOT isolated as the unique cause (machine
state and other environmental factors not separated), CI-on-identical-production-files is NOT a
passing CI result for this research branch, and the categorical phrases are superseded by the
evidence-bounded reading — both local runs stay recorded FAILED and all counts/records stand.
Gates after both fixes: focused
`node --test --test-name-pattern='controlled shape diagnosis' tests/shell-wait-probe.test.mjs`
= 102/102 in 5 suites (the +2 delta over the post-round-16 100 is the two close-out tests);
`npm run test:shell-research` = 553/553 in 51 suites, 0 fail/skip; selection 6/6; lint clean;
typecheck clean; LF 537 tracked files; `git diff --check` clean; prohibited-path diff EMPTY;
no live run launched.

**Task 2 exit statement (updated at the redesign).** Opt-in diagnosis is informative on the
synthetic alternative set and cannot serialize private source or values (canary assertions across
every adversarial input class);
`parserStage:'parse-accepted'` diagnoses and never admits; the default admission and legacy
retention regressions are intact (structural-only and plain excerpts stay byte-identical, pinned).
D0/D1 remain unspent; the plan's Task 3 command is now runnable against this branch but no live
turn was launched.

### 15.3 Task 3: D0 executed — the fresh cell was admitted naturally; measurement restored; D1/C0/C1 dispositions (2026-10-17, live run 1/4)

**Task 2 closure record (opening note, kept out of the Task 2 commit to preserve the approved bytes).**
Task 2 closed at `7e5fbc7…` after 17 codex gate rounds: rounds 1–10 (pre-redesign architecture) produced
37 fixed findings (trajectory 5→5→4→5→3→3→4→4→4→4, all fixed test-first, every round's disposition in
§15.2); the root then adjudicated the canonical-exact redesign (§15.2), and rounds 11–16 on the
redesigned architecture produced 6 further fixed findings (1 each in rounds 12–16), with round 17
(job `review-mvbh2zud-9fb2fq`, adversarial channel, full branch diff `bf98839..7e5fbc7`) returning
**approve — zero material findings** ("No defensible material blocker found in bf98839..7e5fbc7 within
the stated scope"). This §15.3 entry is the first record AFTER that approval; the approved task commit
`7e5fbc7…` is byte-identical to what the review certified. Channel summary for Task 2: the plain
`review` channel completed rounds 1–6 and died 4/4 attempts on the post-redesign diff (recorded in
§15.2's channel record); the adversarial-review channel with an honest scope statement completed every
round thereafter — the root's channel switch is recorded as an adjudicated deviation, not a silent
substitution.

**D0 execution (ledger: spent 1 of 4; D1/C0/C1 unspent).** Command exactly per plan Task 3 (fresh
private output directory `tmp.XyQbWNUQwq`, record `rescue-long.record.json`; no `--cap-ms`; both
`--unclassified-structural-diagnostic 1` and `--unclassified-shape-diagnostic 1`; `--worker-duration-ms
130000 --poll-ms 3600000 --budget-ms 360000`; NO `--model` — model stays unknown per §15.1's unmet
model-control record). Pins: `shell_plugin_sha` = `7fe8cbb…` (the PLUGIN source pin — verified
identical to the executing HEAD `7e5fbc7…` on every prohibited path: `git diff 7fe8cbb..7e5fbc7 --
skills/ agents/ scripts/ hooks/ .codex-plugin/ marketplace/` is EMPTY; the research instrument differs
and is bound by the observer digest, not the plugin sha); `shell_codex_binary` =
`/Users/zhangzikai/.codex/packages/standalone/releases/0.163.0-aarch64-apple-darwin/bin/codex`
(sha256 `8813367…dee31`, codex-cli 0.163.0); executing observer digest v2 =
`e53f20a0833304b4267b03e671496080dcd03d895305e542d390498a5c5233d6` (binds evidence.mjs ⊥
shape-diagnostic.mjs ⊥ driver.mjs module-init bytes; `sourcesChangedDuringRun: false`). Driver exit 0.
One honesty note on the provenance label: the record's `observer.revision` reads
`working-tree-uncommitted` although the worktree was clean at `7e5fbc7…` — this is the driver's
commit-resolution label inside a linked worktree; the authoritative binding is the v2 digest plus
`sourcesChangedDuringRun: false`, and the label is recorded here as observed.

**Fresh-cell adjudication (plan Task 3, fixed facts only).** The A0 blocker did NOT recur: BOTH tool
cells of this run were admitted naturally by the existing grammar — the record contains two
`rollout-tool-call` excerpts (`exec_command` launcher invocation with `yield_time_ms: 30000`, and the
`write_stdin` empty poll with `yield_time_ms: 3600000`), `inconclusive: null`, and NO
`unsupported-call-shape` cell — the opt-in shape diagnostic was present and armed but had NOTHING to
classify. Per plan: no recognizer is invented for an admitted cell, and no multi-line-syntax claim is
inferred from anything. What this adjudicates is exactly and only that THIS fresh cell was admissible;
A0's historical cell stays unreconstructed and its envelope facts stay historical (§14.1); "a new
run's form may differ; each diagnosis belongs only to its own fresh cell" (plan §3) — so this result
does NOT retroactively explain A0.

**Managed-route measurement (the §2 goal's second clause is reachable).** Route: requested
`rescue-foreground`, actual `named`. Linkage: child linkage checked (mode `rescue`), child thread
`01a1469d-e23e-…` under parent `01a1469d-797c-…` (distinct namespaces), companionLaunchCount 1,
companionSendCount 1 (one mapped launch/send), originalHandleChecked true. Held turn (monotonic
elapsed): launch 1 ms, observation detected 32436 ms, poll started 65010 ms, hold deadline 162436 ms,
root acknowledgement 171552 ms, ended 171557 ms. Poll: `pollWallTimesMs [97500]` — the empty original-handle
poll occupied the entire remaining hold window (65010 + 97500 = 162510 ≈ deadline 162436, Δ≈74 ms);
`remainingLifetimeMs 97426` at poll start (the ≥60000 ms interpretability headroom holds);
`outerReturns: 0`; `modelCalls: 2`; `rootJoins: 1`; `pendingInnerAtEnd: false`. Terminal:
`processExit 0`, `hostExit 0`, `publicResultMatchedSentinel true`, `terminalStdoutChecked true`.
Cleanup: `observation` label, fixture disposed, 0 cleanup errors. Honest null observations: Child
settlement was NOT observed (`child.settlement.observed: false` — the Root acknowledged and ended
before any Child settlement was detected), and no interruption was requested (by design for D0).
`setupAttempts: 2` (setup retried once, then `roleStatus: ready`).

**D1 disposition: unspent — both prongs cause-less.** Prong 1 (diagnostic refinement) requires D0 to
be insufficient — it was sufficient (the cell admitted; route/handle/poll/terminal evidence all
measurable, no missing discriminator). Prong 2 (adapted replay) requires a demonstrated finite
adaptation — none was needed or built (plan: "If code is already admitted naturally, do not invent a
recognizer"). D1 stays unspent under §3's "not both" ledger.

**C0/C1 disposition: unspent — the model-control prerequisite remains UNMET.** D0 satisfied Task 4's
measurability precondition ("only after actual managed-route observation can be fully admitted/
measured" — it now is), so the ONLY blocker is the Task 1 record: no authorized model id exists for
this campaign (§15.1: `shell_trial_model` NOT established; scoped docs deliberately name none), and
plan Task 4 forbids running the two arms on two silent defaults ("record both arms unspent rather than
assume two default models match"). The `--wait-policy config-default` / `--exec-default-ms` transport
is likewise NOT implemented (plan Task 4 bullet 1): with the arms blocked on a user-owned input,
building the transport now would be unreachable comparison work. Unblocking requires exactly one
user input — an authorized model id — after which the transport implementation (TDD) and the two
runs remain available under this plan's ledger (2 of 4 runs would remain).

**Task 3 exit statement.** Recognition was restored by the host itself on the fresh cell (no adapter),
attributable actual-route evidence is measured (route/handle/empty-poll/hold-deadline/terminal with
97.4 s headroom), and D0/D1 use and choice are explicit (D0 spent, D1 unspent-cause-less, C0/C1
unspent-model-prerequisite). The plan's remaining §8 production gates (quantitative long discriminator
and repeat, reduced re-entry, exact terminal linkage, native pending-observation interruption with
owned/no-collateral settlement) are untouched by this result and still required before any production
recommendation; production scope remains ZERO.

### 15.4 Task 5: verification, gates, S/Q mapping, honest limits and the next decision (2026-10-17, no host launch beyond D0)

**Task 2 closure restated for this section's baseline.** Task 2 closed at `7e5fbc7…` (17 codex gate
rounds, final round APPROVE with zero material findings — §15.3 opening note); Task 3 recorded D0 at
`f2eb938…`. This section's gates ran on the branch at its Task 5 state (HEAD `f2eb938…` plus the
scratch-relocation procedure below; the Task 5 doc commit follows this entry and carries only report/
plan records).

**Full gate battery (exact plan commands, this date, this worktree):** `npm run test:shell-research` =
**551/551 pass** (51 suites, 0 fail, 0 skipped); `node --test tests/test-selection.test.mjs` = **6/6**;
`node --test tests/rescue-preparation.test.mjs tests/rescue-binding.test.mjs
tests/rescue-route-planner.test.mjs` = **417/417**; `node --test tests/rescue-lifecycle.test.mjs
tests/rescue-child-reconciliation.test.mjs tests/rescue-progress-relay.test.mjs` = **126/126**;
`node --test tests/job-control.test.mjs tests/mcp-result.test.mjs` = **213/213**; `npm run lint` exit 0;
`npm run typecheck` exit 0; `node scripts/check-line-endings.mjs` = 537 tracked files, exit 0;
`git diff --check` clean; final prohibited-path diff
(`git diff 7fe8cbb… --stat -- skills/ agents/ scripts/ hooks/ .codex-plugin/ marketplace/
docs/superpowers/specs/`) = **EMPTY** — production scope ZERO holds on the branch.

**Full routine `npm test` (once, against the clean exact source including the new helper):**
executed with the plan's scratch procedure — the session's three owned untracked scratch files
(`findings.md`, `progress.md`, `task_plan.md`) were moved to a private OS-temp directory
(`/tmp/shape-dg-scratch.qCpV`, sha256 `10e5e039…`, `942f6b98…`, `6e61391e…`), the suite ran, and the
files were restored by the same script's finalizer (restore exit 0; the three files verified present
afterwards; nothing else was stashed and no expectation changed). Result: **3397 tests, 3392 pass,
2 fail, 3 skipped, duration ≈ 894 s.** Both failures are the same environmental class —
`ZCODE_PROCESS_TIMEOUT` (~120 s) spawning the real external ZCode binary:
`tests/integration/package-install.test.mjs` ("packed production install loads and locks on Node
22.13") and `tests/release-contracts.test.mjs` ("future writable-concurrency ADR remains absent…" via
`buildMarketplaceSnapshot`). Neither test imports anything this branch changed (the prohibited-path
diff above is empty, so the test infrastructure is byte-identical to the merged base). **Attribution
experiment (recorded, decisive):** the complete `npm test` was then run on the plugin-identical,
instrument-free worktree `.worktrees/rescue-shell-wait-config-path-a` (`b5cd056…`): it ALSO failed —
**3393 pass / 1 fail**, and the failing test is a DIFFERENT member of the same class
(`tests/integration/marketplace-install.test.mjs` "isolated Codex marketplace lists and installs…",
external-process spawn timeout). Conclusion: full-suite external-process spawn timeouts on this
machine are load-dependent run lottery, present on the merged base and NOT attributable to this
branch. The failed local runs stay failed with this cause recorded — neither run is relabeled as
passed, consistent with the standing rule; the same precedent (local full-suite spawn-timeout
failure, CI green on the identical plugin source) is on record from the config-path-a campaign
(report §14.1/§15.1 predecessor notes).

**Correction (2026-10-17, user-commissioned close-out review):** the attribution conclusion
above is narrowed to evidence-bounded inference; nothing else in the record changes. What the
experiment ESTABLISHES: both local full-suite runs stand recorded FAILED (never relabeled — two
DISTINCT external-process spawn timeouts of the same environmental class, ~120 s, on
`package-install.test.mjs`/`release-contracts.test.mjs` and
`marketplace-install.test.mjs` respectively), and the complete `npm test` on the
plugin-identical, instrument-free base worktree (`b5cd056…`, prohibited-path diff empty so the
test infrastructure is byte-identical) ALSO failed with a spawn timeout on a DIFFERENT failing
member of the same class. That SUPPORTS pre-existing environmental instability on this machine.
What it does NOT establish: load is NOT isolated as the unique cause (no load measurement
accompanied either run), machine state and other environmental factors are NOT separated, and
the base failure does not conclusively exclude every branch effect — it excludes only the claim
that this branch's presence is NECESSARY for such timeouts. A green CI run on identical
production files is likewise NOT a passing CI result for THIS research branch (different runner,
different load, different environment). ROOT CAUSE: UNISOLATED (load vs machine state vs other
environmental factors not separated). The three categorical phrases above — "(recorded,
decisive)", "load-dependent run lottery", and "NOT attributable to this branch" — are superseded
by this bounded reading; the failed-run records, counts and precedent citations stand unchanged.

**S1–S7 mapping (this campaign's deltas; all prior campaign mappings in §9–§14 carry forward
unchanged):**
- **S1 (entry points, binding, preparation):** unchanged and exercised — D0's route reached
  `rescue-foreground`→`named` through the existing launcher/preparation/binding path with
  child-linkage and original-handle checks all true (§15.3); no new `_meta`/workspace/binding
  mechanism introduced (production diff empty). Fixture regressions: the prep/binding/route-planner
  battery (417/417).
- **S2 (one Companion, one handle, empty input, no second inner poll):** observed on the live route —
  companionLaunchCount 1, companionSendCount 1, originalHandleChecked true, empty-poll excerpt
  (`write_stdin` chars ""), outerReturns 0, `pendingInnerAtEnd` false (§15.3). The outer-cell
  continuation semantics were not separately stressed by D0 (the single poll occupied the hold
  window) — carried, not newly proved.
- **S3 (terminal/exit semantics):** processExit 0, hostExit 0, publicResultMatchedSentinel true,
  terminalStdoutChecked true on the live run (§15.3); job-control/mcp-result battery 213/213.
  Child-side settlement remained unobserved (honest null) — the terminal evidence is Root-side
  measured, and exact Child-terminal linkage stays with §8's outstanding production gates.
- **S4 (placement matrix):** untouched by this campaign (production diff empty; the fixture pins the
  rescue-foreground→named path only). Review/Adversarial/Status scopes remain their own (§13.7).
- **S5 (interruption/timeouts/ceiling):** no interruption requested or claimed (D0 by design);
  `nativeInterruptionClaimed: false` recorded. The source/default capability is STILL NOT installed
  native interruption with durable no-collateral settlement — §13.11's distinction and §8's
  requirement stand unchanged. No new timeout or ceiling introduced (production diff empty).
- **S6 (named/generic alignment):** the D0 route exercised the named Role only; the generic message's
  wait instructions and matching contracts are unchanged (production diff empty). No generic-route
  claim follows from D0.
- **S7 (production surface unchanged):** verified by the empty prohibited-path diff at the Task 5
  state; the fixture's candidate/instruction variants were isolated to the disposable fixture home
  and disposed with 0 cleanup errors (§15.3).

**Q1–Q6 mapping (deltas only):**
- **Q1 (actual Child route/config layers):** already qualified in prior campaigns; D0 re-confirmed the
  installed-route reachability on 0.163.0 (route actual=named; plugin identity `zcode@vitry` 0.1.0;
  codex 0.163.0). No new configuration-layer claim.
- **Q2 (longer observation on named + generic):** the named route carried the empty poll holding
  97.5 s within the authorized 130 s worker window (§15.3) — a live re-confirmation on the current
  pin, NOT a new raised-cap result. Generic route: no new evidence; prior scopes stand.
- **Q3 (re-entry reduction vs 30000/60000):** NOT measured — this is exactly C0/C1's comparison, and
  the arms remain unspent on the model-control prerequisite (§15.3). D0's single poll with
  `outerReturns: 0` is one managed-route data point, not the discriminating A/B pair; no
  re-entry/token-savings claim is made.
- **Q4 (noise/interruption during pending observation):** not exercised this campaign (no interruption
  requested; no noise case run). §13.6's not-proven status and §8's requirement stand.
- **Q5 (Root Review/Adversarial/Status eligibility):** untouched; §13.7's separate qualifications
  stand (review-wait not-proven on early host exit; adversarial-review-wait/status-wait qualified on
  their own pins).
- **Q6 (smallest deployment change):** unchanged from §14.1 — the config-path-a close-out's candidate
  (supported numeric `-c` transport, re-verified §15.1) remains the evidence-bounded candidate;
  D0 adds no deployment recommendation, and no config efficacy was measured (C0/C1 unspent).

**Honest limits of this campaign.** (1) The shape diagnostic shipped and survived its gate, but on
the only live cell observed (D0) it had nothing to classify — its value on a REAL unknown cell is
fixture-proven (90 focused tests incl. adversarial/privacy batteries) and gate-approved, never
live-proven. (2) A0's historical form remains unexplained: this campaign proves only that a fresh
cell admitted naturally; per-run form variance is real (plan §3 anticipated it) and a future run may
produce another unknown cell — the instrument for that case now exists. (3) The configured
outer-wait default's runtime effect remains unproven (C0/C1 unspent on the model id) — the config
efficacy question is exactly where this campaign hands off. (4) Local full-suite spawn-timeout
failures are recorded as environmental with the base-attribution experiment; CI remains the
authoritative green for the identical plugin source until a PR exists.

**Next decision (smallest evidence-backed step; user-owned).** Provide one authorized model id for
this campaign (`shell_trial_model`) — Task 4's transport implementation (TDD) and the two remaining
ledger runs (C0 at 30000 ms default, C1 at 240000 ms) then execute unblocked on an already-measured
route, answering the campaign's remaining question: whether the configured outer default actually
holds the managed Rescue Child past the short outer window. No other input is missing; no new plan or
authority is needed for those two runs (2/4 ledger remains). Alternatively, close the campaign here:
the §15 records are complete, the research instrument is qualified, production scope is ZERO, and all
§8 production gates (quantitative long discriminator + repeat, reduced re-entry, exact terminal
linkage, native pending-observation interruption with owned settlement) remain outstanding before any
production recommendation — research completion is not release completion.

### 15.5 Task 4: model selection established, transport implemented through its gate, C0/C1 executed — adjudication `inconclusive`/`timing-borderline` (2026-10-17, live runs 2-3 of 4; ledger closes 3/4 spent, D1 unspent)

**Model selection (the §15.3 blocker, resolved by discovery).** Per the user's handoff directive
("establish approved/current selection through supported bounded read-only means; if still
unavailable, ask the user"), the AUTHENTICATED catalog was taken read-only on 2026-10-17
(`codex debug models` with the real CODEX_HOME; network restored; NO model turn; no config/auth
dump): 9 entries, 7 `list`-visible — `gpt-6.1-sol` at priority **0** (the account's current default
candidate; default reasoning level medium), `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`,
`gpt-5.6-terra`, `gpt-5.6-luna`, plus hidden `gpt-reserve`/`codex-auto-review`. This differs from the
§15.1 offline bundled catalog (no `gpt-5.5`; `gpt-reserve` new) — the authenticated view is the
operative one. `shell_trial_model` = **`gpt-6.1-sol`** (the discovered CURRENT selection; a user
confirmation prompt went unanswered, and the handoff's primary path — read-only discovery of the
current selection — resolved; the selection is recorded as REQUESTED on every run and remains
user-overridable; effective host/Child metadata stays `null`/never-inferred as always).

**Transport implementation (plan Task 4 bullets 1-3; commit chain e372579→…→`efb1fce…`, ONE amended
task commit).** Implemented by a fresh implementer subagent and hardened through its full review
loop: an independent self-review (2 rounds: pin-matrix gap fixed with genuine RED; tautological
assertion replaced by an independent literal oracle) then the codex adversarial gate — **7 rounds
(4→3→2→1→1→1 findings → approve, zero material findings)**. The gate's findings, each fixed
test-first, materially hardened the instrument BEFORE any live run: the paragraph's yield
continuation now continues the RETURNED CELL via the sanctioned `tools.wait` + `cell_id` +
`yield_time_ms: 240000` instead of a second inner poll; the comparator adjudicates on a newly derived
`decisiveFirstReturnWallMs` (rollout-event timestamps, pending yields measured like completions)
instead of `pollWallTimesMs[0]`; requires `decisiveCallSurface = code-mode-wrapper` on both arms
(direct-native ⇒ `different-surface`); requires identity evidence PRESENT (normalized instruction
hashes, observer digest, codexVersion, plugin identity+version, and — round 5 — the launched
binary's SHA-256 `provenance.codexBinarySha256`; missing ⇒ `missing-identity-evidence`, different
⇒ `mismatched-pin`); requires affirmative structural qualification (inconclusive/handle failures ⇒
`unqualified-arm`); matching actual inner yields (= each other and requestedPollMs ⇒ else
`mismatched-inner-yield`); a two-sided control timing band with tolerance max(1000, 10%·controlDefault)
(basis: D0's own measured overheads; inside-band ⇒ `timing-borderline`, below-band ⇒
`control-returned-early`, above-band ⇒ `no-config-effect-observed`); a standalone single-statement
decisive cell (shared cells ⇒ basis `shared-cell` ⇒ timing `null` ⇒ unknown); matching `route.actual
=== 'named'` on both arms (⇒ else `mismatched-route`); and — round 6 — `decisiveFirstReturnState`
(`yielded-pending`/`completed`/`unknown`): a COMPLETED control ⇒ `control-completed-without-yield`,
and `config-effect-observed` requires an OBSERVED pending control yield WITH its verified sanctioned
continuation. Reasons enum: 18 closed values; verdict enum: 6 closed values. Gates at `efb1fce…`:
file-level tests 593/593 (55 suites; task-4 subset 40/40), selection 6/6, lint/typecheck/LF clean,
prohibited-path diff EMPTY.

**C0 (ledger run 2/4; the plan's control arm).** Command exactly per plan (fresh private dir; worker
180000; poll 240000; budget 600000; `--model gpt-6.1-sol`; both diagnostic flags;
`--wait-policy config-default --exec-default-ms 30000`). Driver exit 0; `status: executed`;
`inconclusive: null`. Route actual=named; linkage 1 launch/1 send, handle checked; outerReturns 1;
modelCalls 3; rootJoins 1; remainingLifetimeMs 148472; process/host exit 0; sentinel matched.
`requestedModel: gpt-6.1-sol`; `codexBinarySha256` recorded (equals the §15.1 pin `8813367…`);
normalized instruction hashes recorded. **waitPolicyObservation: `decisiveFirstReturnWallMs` 31007,
state `yielded-pending`, surface `code-mode-wrapper`, innerYield 240000, explicitYield absent** — the
model followed the paragraph exactly: the decisive poll yielded pending at ≈ the 30000 ms default
(+1007 ms) and the model continued the SAME cell with the sanctioned explicit wait (the `wait`
cell_id excerpt is in the retained evidence).

**C1 (ledger run 3/4; the raised arm).** Same command changing ONLY `--exec-default-ms 240000`; NEW
private dir. Driver exit 0; `status: executed`; `inconclusive: null`. Route actual=named; linkage 1/1
handle-checked; outerReturns 0; modelCalls 2; rootJoins 3 (counted separately per plan; no gate
hinges on it); remainingLifetimeMs 148734; process/host exit 0; sentinel matched; same
requestedModel/binary digest; **normalized instruction hashes byte-identical to C0**
(`f0367925…`/`e39d2941…`). **waitPolicyObservation: `decisiveFirstReturnWallMs` 148838, state
`completed`, surface `code-mode-wrapper`, innerYield 240000, explicitYield absent** — with the raised
default the decisive poll NEVER yielded: the Companion's work completed at ≈148.8 s inside the
240000 ms window (real completion — a legitimate alternative ender, disclosed per plan bullet 6).

**Adjudication (the exported `adjudicateWaitComparison`, run on the two retained records):**
**`{ verdict: 'inconclusive', reason: 'timing-borderline' }`.** Trace: every identity/pin/qualification/
surface/state/inner-yield/route/headroom gate PASSES (both arms qualified, named×named, wrapper×wrapper,
identity complete and equal, instructions identical, model shared and explicit); the CONTROL's first
return 31007 ms falls inside the frozen tolerance band (30000, 33000] — 1007 ms of overhead above the
default — and the codex-round-2 semantics the gate itself demanded classify exactly this band as
`timing-borderline`: indistinguishable from overhead, therefore inconclusive, NEVER a verdict. The
plan's bullet-6 alternative enders are all ruled OUT on the control (yielded-pending + verified
continuation, no early return, no completion), but the +1007 ms overshoot cannot be attributed within
the frozen tolerance. **Label: INCONCLUSIVE (timing-borderline) with actual basis — installed-config
effect is NOT proven by this pair.** No quantified token/re-entry/latency claim follows; rootJoins are
counted, not interpreted; the C1 completion at 148.8 s means the raised default's own boundary was
never reached (the work finished inside it), so even the direction of the contrast — C0 yielding at
≈31 s vs C1 completing at ≈148.8 s without yielding, both sentinel-matched exit-0 — is recorded as
OBSERVED BUT NOT ADJUDICATED-POSITIVE evidence, exactly the fail-closed behavior the gate demanded.
Per plan §3: no new budget from an inconclusive result; **the ledger closes at 3/4 spent (D0, C0, C1),
D1 unspent (cause-less), no registered label remains.**

### 15.6 Task 5 refresh for the Task 4/correction commits (2026-10-17)

**New commits since §15.4:** `e372579…` (close-out corrections: retention marker + narrowed
attribution — narrow recheck CLEAN after 2 numeric P3s fixed, codex adversarial gate APPROVE),
`efb1fce…` (task 4 transport — self-review 2 rounds CLEAN + codex gate 7 rounds to APPROVE), and the
Task 4 execution records (this entry + plan ticks). **Refreshed gates on the final state:**
`npm run test:shell-research` = **593/593** (55 suites; the file-level suite subsumes the classifier
and task-4 subsets — 102 classifier-pattern and 40 task-4 tests pass inside it); selection **6/6**;
lint/typecheck exit 0; LF 538 tracked files exit 0; `git diff --check` clean; prohibited-path diff vs
`7fe8cbb…` **EMPTY** (production scope ZERO holds at the final state). The full routine `npm test` was
NOT rerun for the task-4/correction commits: §15.4's environmental attribution record (as narrowed by
the §15.4 correction note) stands for the machine-level spawn-timeout lottery, and no prohibited or
shared-infrastructure path changed since (the prohibited-path diff above is the operative check).
Branch final state: `docs/rescue-shell-wait-shape-diagnostic` at the Task 4 records commit; **not
pushed — push/PR remains separate user authority.**

**Campaign-final S/Q deltas (superseding §15.4's Q3 line only):** Q3's config-effect question is now
MEASURED-AND-INCONCLUSIVE (timing-borderline) instead of unspent-blocked: the managed route carried
both arms end-to-end with the model following the isolation paragraph, and the fail-closed instrument
refused the positive verdict on a 1007 ms control overshoot inside its frozen tolerance. All other
S/Q lines stand as §15.4 recorded them. Spec §8's production gates (quantitative long discriminator
and repeat, reduced re-entry, exact terminal linkage, native pending-observation interruption with
owned/no-collateral settlement) remain entirely outstanding; production scope remains ZERO; research
completion is not release completion.

### 15.7 Close-out correction 2 and the versioned re-adjudication (2026-10-17, offline; no live run)

**Origin.** The user's close-out review of `531cc30…` returned one P2 (comparator false negative: the
control band was documented two-sided but implemented asymmetrically — 27000 accepted, 31007 refused
as `timing-borderline`, contradicting "|firstReturn − controlDefault| ≤ tolerance") and one spec gap
(the plan's final-source `npm test` gate had not been run on the final source). No new spec/plan, no
new live run.

**Correction 2 (commit `e34a5dd…`, amended from `9b2921e…` after a narrow recheck).** The control
band is now genuinely symmetric: a control return within **[controlDefault − tolerance,
controlDefault + tolerance], both edges inclusive, IS default expiry and PROCEEDS** to the
raised-arm comparison; above the upper band stays `no-config-effect-observed`; below the lower band
stays `control-returned-early`; raised-side rules unchanged (`timing-borderline` remains reachable
ONLY from the raised arm — disclosed). Every returned verdict now carries **`adjudicationVersion: 2`**
(exported `WAIT_ADJUDICATION_VERSION = 2`; v1 semantics had no field), so the two adjudications of the
same pair are distinguishable in records. Disclosed supersession: the round-2 control-arm
borderline pins (30001/31000/33000) were re-pinned to observed per the user-commissioned ruling; the
symmetric rule also satisfies round-2's original concern (an overhead-pushed expected contrast is no
longer rejected as no-effect). Narrow independent recheck: CLEAN on function — band symmetry, version
coverage of all 23 return branches, and the re-adjudication reproduced independently; differential
sweep over 26000+ arm-return combinations confirms the v1→v2 behavioral delta is confined EXACTLY to
control ∈ (30000, 33000]; two stale-comment P3s fixed in the same commit.

**Versioned re-adjudication of the RETAINED C0/C1 records (offline, read-only, records unmodified —
hash-verified):** v1 (as published in §15.5, preserved as history): `inconclusive`/
`timing-borderline`. **v2 (adjudicationVersion 2): `config-effect-observed`** — the control's
yielded-pending return at 31007 ms is IN-BAND default expiry (31007 ∈ [27000, 33000]) with its
verified sanctioned continuation (outerReturns 1), and the raised arm held past the whole band to
completion at 148838 ms; every identity/pin/qualification/surface/state/inner-yield/route/headroom
gate passes on both arms. **Label supersession: installed-config effect OBSERVED on this single
measured pair (v2).** The plan's bullet-7 caveats are unchanged and binding: this pair involves NO
repeat, and NO inner-cap M/propagation, quantified token-savings, native-cancellation or
production-readiness claim follows from it; spec §8's quantitative long discriminator and repeat,
reduced re-entry, exact terminal linkage and native pending-observation interruption requirements
remain entirely outstanding. Q3's §15.6 wording ("MEASURED-AND-INCONCLUSIVE (timing-borderline)") is
hereby SUPERSEDED by the v2 record: Q3's config-effect question is MEASURED with an OBSERVED positive
on one pair, repeat outstanding.

**Final-source `npm test` (the spec-gap closure; plan Task 5's exact procedure).** Executed once at
the branch's final source (correction 2 included) with the scratch-relocation procedure (the same
three owned scratch files moved to `/tmp/shape-dg-scratch2.euO9`, sha256 `10e5e039…`/`942f6b98…`/
`6e61391e…`; restored by the script's finalizer, restore exit 0, files verified): **exit 0 — 3397
tests, 3394 pass, 0 fail, 3 skipped, duration ≈ 683 s.** This is the plan-required final verification
on the final source, and it PASSES; §15.4's two local spawn-timeout failures remain historical facts
on their own runs (never relabeled), and §15.4's narrowed-attribution correction note stands as the
record of that episode.

**Gates at the final state (`e34a5dd…` + this record):** `npm run test:shell-research` = 594/594
(55 suites; the +1 test over 593 is correction 2's boundary-matrix test); task-4 subset 41/41;
selection 6/6; lint/typecheck exit 0; LF 538 tracked files; `git diff --check` clean; prohibited-path
diff vs `7fe8cbb…` EMPTY. Branch head after the records commit: see the branch log (this entry's own
commit postdates the reviewed correction commit `e34a5dd…`, which the codex gate for this correction
covers together with the working-tree records).
