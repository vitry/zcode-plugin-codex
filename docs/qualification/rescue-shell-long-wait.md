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
behavior and its limits (§12.9 records the R5 campaign's instrument facts).

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
0.161.0), corrected by the 2026-10-06 review adjudication: the qualified unraised trial observed a
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

  R5 outcome (2026-10-08), corrected by the 2026-10-06 review adjudication: the unraised trial observed
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
remain `not-proven` (§7.3–§7.4).

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

R5 update (2026-10-08, installed 0.161.0), corrected by the 2026-10-06 review adjudication: a qualified
cap-limited unraised trial observed the cap return qualitatively, but its exact duration was not
separately retained (the record's `decisiveWallMs` is the terminal observation's — §7.7), so M is
bounded-but-imprecise and the raised-cap discriminator is POSITIVE-but-M-imprecise; the four
0.160.1 records above remain the historical Task 4 attempts — §7.7.

### 7.4 Repeat outcome (`not-proven`)

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

### 7.7 R5 campaigns: cap-limited return observed (M bounded-but-imprecise), propagation POSITIVE-but-M-imprecise, repeat QUALIFIED; off-script retrials recorded (`installed-observed`, 2026-10-08; M adjudication corrected 2026-10-06 review)

R5 ran the plan amendment's bounded follow-up trials on installed **codex-cli 0.161.0** (§1.2.2) with the
fixture installing committed source `5026009b6199f5f2d43ca8a567e536078e95080d` and the working-tree
(R0–R4-corrected) observer whose per-record digest is carried in every record's `provenance.observer`
block (§12.5). Ten trials produced retained records, each run exactly once; no outcome was retried out of
the record. All rescue-family trials used the candidate variant and `--poll-ms 3600000`; the unraised M
control omitted `--cap-ms` (parser default `null`), every other case passed `--cap-ms 3600000` explicitly.

| Trial | Retained record | Outcome |
| --- | --- | --- |
| M — `rescue-long`, UNRAISED (no `--cap-ms`), worker 420000 ms, budget 1200000 ms | [record](/tmp/shell-wait-r5-m.OIcGg0/rescue-long.record.json) | **QUALIFIED, `inconclusive: null` — cap-limited return OBSERVED, exact duration NOT separately retained; M bounded-but-imprecise (corrected 2026-10-06 review).** Named route, launch 1/send 1, original handle checked; the record retains TWO empty-input polls and `decisiveWallMs: 85000`, `pollStartedAtElapsedMs: 71287`, `holdDeadlineElapsedMs: 458855` (worker completion), `remainingLifetimeMs: 387568` (basis `hold-deadline-at-poll-start`); sentinel in linked output, exit 0. **The cap-limited shape held:** the first poll returned to the model while the 420000-ms worker was still running (no requested-yield expiry — the requested yield was 3600000 ms; no other ender: `interrupt.requested: false`, cleanup label `observation`), and the model re-polled to the normal sentinel completion afterwards. **Adjudication correction:** `decisiveWallMs` is `sequence.lastCompletedOnHandle` — the TERMINAL observation (exit 0 + sentinel) — not the earlier nonterminal cap return; the record retains call arguments only (no per-poll output headers), so the cap return's duration is unrecoverable from the retained data. M is bounded by [>0, return-before-worker-end] — the return demonstrably preceded the worker's end — and needs RE-MEASUREMENT with the per-poll-timing observer (§12.8) before any numeric use |
| Case B fresh — `rescue-long --cap-ms 3600000`, worker 420000 ms | [record](/tmp/shell-wait-r5-rescue-long.Vx9i4a/rescue-long.record.json) | **QUALIFIED.** Named; `decisiveWallMs: 388300`, `outerReturns: 0`, `modelCalls: 2`, `rootJoins: 1`, `capVerified: true`, sentinel in linked output, exit 0 — one 388.3-s observation spanning poll start to worker completion, with no intervening return |
| `rescue-repeat --cap-ms 3600000`, worker 420000 ms | [record](/tmp/shell-wait-r5-rescue-repeat.EXZjWv/rescue-repeat.record.json) | **QUALIFIED.** Named; `decisiveWallMs: 388300`, `outerReturns: 0`, `rootJoins: 7`, sentinel true, exit 0. A **DISTINCT Child** — `01a11857-f6e4-7b43-b63d-4af8a54319c6` vs Case B fresh's `01a11850-998d-7063-b993-484ab338470b`; the equal 388300 wall time is a **return-granularity coincidence** (both spans are poll-start→worker-completion of ≈388.2 s, rounded to the same 388.3-s tool-reported header value) |
| `rescue-baseline --cap-ms 3600000 --poll-ms 60000` | [record](/tmp/shell-wait-r5-rescue-baseline.DDgO8y/rescue-baseline.record.json) | Inconclusive `unsupported-call-shape`: the model wrote an unclassified 4-line cell (478 bytes); R0 structural suppression held (excerpt carries no private content). Route, linkage and cadence facts remain `null`. Recorded exactly as found |
| `rescue-noise` (raised, worker 130000 ms) | [record](/tmp/shell-wait-r5-noise2.xFe3Mu/rescue-noise.record.json) | Inconclusive `unsupported-call-shape` again — a **different shape than the R1-fixed preparation grammar**: the model again wrote an unclassified 4-line cell (300 bytes); R0 suppression held. The FIRST noise attempt (`/tmp/shell-wait-r5-rescue-noise.qocK37`) left an EMPTY output directory — an orchestrator invocation artifact (a mis-issued invocation whose grep filter hid a driver-level failure) that ran NO trial; the noise2 record is the corrected trial |
| `background` (R3-corrected prompt/lifecycle, worker 120000 ms, budget 600000 ms) | [record](/tmp/shell-wait-r5-bg2.LmTfLv/background.record.json) | Inconclusive `unsupported-call-shape`; budget-cleanup at `endedAtElapsedMs: 600021` (`codexTerminated: true`); `rootAcknowledgementAtElapsedMs: 41333` recorded but no Child linkage — the model went off-script before the background flow. First attempt directory empty (invocation artifact) |
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

**Headline adjudications** (M corrected by the 2026-10-06 review adjudication; propagation softened
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
| Source/binary mapping | **`not-proven`**: Codex source `67727e7c` is not mapped to the installed binary (0.160.1 at Tasks 4–5; re-pinned **0.161.0** by R4's non-authenticated probe, 2026-10-08, §3.3 — **0.161.0 was the R5 live-run version**, §1.2.2); 0.160.0 was the historical Task 1/Root version. The R5-observed unraised Child return differs from the pinned source default (300000 ms, §2.5) — recorded as facts on different surfaces, never a mapping claim | Keep source facts separate; qualify any later installed version independently (Task 7) |
| Installed unraised Child cap M | **BOUNDED-BUT-IMPRECISE (2026-10-08 observed; corrected 2026-10-06 review adjudication, `installed-observed`, 0.161.0)**: the qualified unraised trial's cap-limited return is established QUALITATIVELY (returned to the model with the 420000-ms worker still running, strictly below the requested 3600000-ms yield, no other ender), but its exact duration was NOT separately retained — the record's `decisiveWallMs` (85000) is the TERMINAL observation, the earlier nonterminal return has no surviving timing, and the retained excerpts carry call arguments only (§7.7). M is bounded by [>0, return-before-worker-end]; it is not a usable number. The four Task 4 0.160.1 records (§7.3) remain historical attempts | Re-measure M with the per-poll-timing observer (§12.8) before any numeric use; re-measure on any future installed version before reuse |
| Raised fixture cap propagation onto the Child | **POSITIVE-but-M-imprecise (2026-10-08, `installed-observed`; corrected 2026-10-06 review)**: fresh raised Case B ran one 388300-ms observation with zero outer re-entries, worker held to natural completion; same binary/paragraph/yields/worker as the M trial, differing ONLY in the fixture cap key — the positive discriminator shape. The NUMERIC comparison (≈4.57× M) and the M + 30000 ≤ 388169 precondition verification inherited the withdrawn M number and are withdrawn; the remaining-lifetime measurements (388169/388188 ms, conservative lower bounds) stand (§7.7) | Re-run the precondition against a re-measured M (§12.8) before the human adoption decision (§11.2); never promote a Role cap field (§2 whitelist) |
| Case A qualified completion | **`not-proven`**: Task 4's consecutive `wait cell_id` linkage unresolved in the observer; original-handle check false/pending tail true. Cadence 15 returns and exit/sentinel facts remain `installed-observed`. The R5 raised re-run of the baseline control also ended inconclusive (`unsupported-call-shape`, recorded exactly as found, §7.7) | Narrow observer work on the actual continuation sequence, with linkage negatives preserved; no host rejection inferred |
| Repeat qualification | **QUALIFIED (2026-10-08, `installed-observed`)**: fresh raised `rescue-repeat` — 388300 ms, 0 outer returns, sentinel true, exit 0, on a DISTINCT Child (`01a11857-f6e4-…` vs Case B fresh's `01a11850-998d-…`); the equal wall time is a return-granularity coincidence (§7.7). The Task 4 attempts (§7.4) remain historical | Repeat is closed on 0.161.0; a future version repeats the measurement independently |
| Generic route and broader instruction support | **`not-proven`** installed; only named was observed (Task 4 and all qualified R5 runs). Artifact synchronization/structural parity is `fixture-tested`; the candidate's named invocation is `installed-observed`; no R5 trial forced a generic fallback | Keep conclusion named-scoped; no generic fallback after Role-value rejection, no universal wrapper claim (Tasks 5/7) |
| Exact native interrupt/tool-family availability and pending-inner cancellation | **Family and delivery path ESTABLISHED by R4** (§3.3, §12.8): family = V2, enabled on the live machine by the `features.multi_agent_v2` block present in the live config (`enabled = true`; the block's AUTHORSHIP is not established — the plugin's own setup writes only `features.hooks`, `hooks.state`, the metadata leaf and `[agents.zcode-rescue]`; the `features list` true/false probe is reproduced either way) (installed binary re-pinned 0.161.0); `interrupt_agent` is registered in the owning normal-exec Root turn (source pin 67727e7c) and targets the exact known non-root non-self child via the shared in-process registry; the case prompt is wired and the record carries measured delivery/settlement facts or an explicit investigated reason (14 new R4 instrument tests). **Live delivery remains `not-proven` after R5**: both wired-path runs went off-script before delivery — the retained R5 record shows the intent was requested (`requested: true`, `previousStatus: "running"`, `family: "v2"`) with `attempted`/`delivered`/`settled` null and the explicit missing-prerequisite reason (evidence collection did not complete; `unsupported-call-shape` off-script cell, §7.7). Turn interrupt alone is insufficient (`code_mode_interrupt` installed-observed false). **Post-R5 instrument correction:** the R5 failure cause — a Root-side `interrupt_agent` wrapper cell failing the whole-case scan (`unsupported-call-shape`, §12.8) — is fixed by the narrow root-control-call path, so a retry adjudicates the Child evidence instead of failing the scan | The R4-wired path exists and is untested by a completed on-script run; one cause-directed retry through the same owning-session prompt path (with the observation surviving long enough for evidence collection) is the remaining step |
| Installed `multi_agent_v2` configuration/bounds | **Partially established by R4** (`installed-observed`, non-authenticated file/CLI probes, §3.3): the live config sets `features.multi_agent_v2.enabled = true` with `default_wait_timeout_ms = 600000` and `min_wait_timeout_ms = 600000` (max unset → source default 3 600 000 ms); `wait_agent_enabled`/`disable_direct_message` are unset → source defaults true/false at the pin. A live `wait_agent` timeout-bound measurement on the installed binary was still unmeasured at R5 (the qualified R5 runs recorded Root joins but no timeout-bound probe) | Record actual wait/timeout bounds only if a later campaign needs them; source defaults stay separate |
| Noise, progress relay, Status sidecar latency, background placement, stop/loss/ceiling | **`not-proven`** as new installed evidence: Task 5 ran each live case once — `rescue-noise` has an instrument grammar limitation (manually adjudicated excerpt; execution behavior unknown, §8.2), `background` ended with the host exiting before the boundary and zero launches (§8.3), the Status sidecar stayed structural (§8.4), and stop/reconciliation live checks were not exercised. **R5 re-runs with the corrected instrument also went off-script** (§7.7): `rescue-noise` hit `unsupported-call-shape` again (a DIFFERENT unclassified-cell shape than the R1-fixed preparation grammar; R0 suppression held), and `background` (R3-corrected prompt/lifecycle) went off-script before the background flow (`unsupported-call-shape`, budget-cleanup at 600021 ms, Root acknowledgement recorded at 41333 ms, no Child linkage). Neither run establishes model nonadherence | The R1 grammar fix removed the OLD blocker; the remaining off-script shape needs its own bounded adjudication before noise/background measurements can complete. Budget/failure cleanup is never native user interruption |
| Review/Adversarial Review/Status waiting commands | **`not-proven`**: Task 6 ran each once (§9.1) — two retain only ASSISTANT-REPORTED `ARGUMENT_INVALID` diagnostics. **R5 produced the first real Root-side outcomes** (§9.4, 0.161.0): the R2 root-family contract adjudicated all three — `review-wait` host ended before the held boundary after the observed companion invocation; `adversarial-review-wait` ran end-to-end through the Root observer (launch/send/98.1-s observation recorded) but the command-rendered result markers were missing from the linked terminal output; `status-wait` failed closed exactly as designed (`statusQuery.validation.valid: false` — no unambiguous reserved-job acknowledgement in the live rollout). Root commands remain `not-proven`, each with its own recorded outcome | Per-command cause-directed follow-ups: review-wait needs the host to survive its held boundary; adversarial-review-wait needs the renderer-marker contract re-examined against the actual rendered bytes (the flow itself completed); status-wait needs a live run whose turn-1 launch acknowledgement is actually emitted and observable; the instrument is no longer the blocker (§12.6, §12.9) |
| Production release/version generalization/token savings | **`not-proven`**: disposable sandbox/hook bypass and no token measurements throughout. Qualified claims span two installed versions measured at execution time — 0.160.1 (Task 4) and 0.161.0 (R5, §1.2.2); auto-update limits attribution in both directions and no release generalization is claimed | Obtain a separate human adoption decision (§11.2); no production rollout implied |

The earlier absence of managed-Child wrapper observations is resolved **only within §7's scope**:
Case B's single long observation and Case A's outer continuation cadence are `installed-observed`.
The fail-closed M discriminator and every independent release dimension above remain intact.

## 11. Coverage mapping, proposed next delta, and execution handoff (Task 7)

### 11.1 Spec coverage mapping

| Spec item | Task and evidence |
| --- | --- |
| S1 preparation/binding authority | 1 (§4 four-stage chain, repository-text facts); 3 (§12.1 fixture uses production preparation/launcher/binding); 4 (§7.1 Case B: launch 1 / send 1 / original handle checked, `installed-observed`); production mismatch/one-shot tests re-recorded §8.5 |
| S2 original-handle/outer-cell ownership | 3 (§12.4 fail-closed observer: empty-chars discipline, single launch, exact-cell linkage, event-order overlap, pending headers); 4 (§7.1/§7.2: Case B 0 overlaps + Case A 15 re-entries, `installed-observed`) |
| S3 exact public/terminal/control outcomes | 4 (§7.1: byte-exact sentinel present in linked terminal output, `processExit: 0`); production result/choice/error suites re-recorded §8.5 |
| S4 placement/background/Status observation-only | 5 (§8.3 background case inconclusive — early host exit, cause unknown; §8.4 sidecar structural-only); inherited placement matrix suites §8.5; R5 re-ran the R3-corrected background prompt/lifecycle — off-script before the flow, `not-proven` (§7.7) |
| S5 interruption/loss/timeouts/ceiling | 5 (§8.1: pending observation qualified; native interrupt delivery NOT exercised); R4 wired the established V2 delivery path (§12.8); R5's wired runs went off-script before delivery — live delivery/settlement `not-proven` (§7.7); budget cleanup never labelled interruption; 100-hour ceiling untouched (production semantics unchanged) |
| S6 named/generic parity and no fallback weakening | 1 (§3/§4 route authority); 4 (§7.1: route actually selected = `named`; generic `not-proven`, no fallback forced) |
| S7 isolation/no production changes | 2 (§ selection isolation), 3 (§12 fixture-owned clone/homes/cleanup), 7 (§1 provenance; final diff = docs + probe files only; production Skills/Role/Companion/config/packaging untouched) |
| Q1/Q2 effective Child configuration/instructions | 1 (§2 config layers); 4 (§7.3 historical attempts; §7.1 candidate instructions delivered and followed on the named route); **R5 (§7.7, corrected 2026-10-06 review): cap-limited return OBSERVED (M bounded-but-imprecise — exact duration not separately retained) and raised-cap propagation POSITIVE-but-M-imprecise (388300 ms, zero re-entries; numeric ratio and precondition withdrawn with the M number), `installed-observed` on 0.161.0** |
| Q3 cadence and repeat | 4 (§7.2 A 15 returns vs §7.1 B 0, `installed-observed`); **R5 (§7.7): repeat QUALIFIED — two independent qualified 388.3-s raised runs on distinct Children**; Task 4's repeat attempts (§7.4) remain historical |
| Q4 noise/native interruption/sidecar latency | 5 (§8.1–§8.4: all `not-proven` except the qualified interrupt-case pending observation); R5: noise and background re-runs off-script (`unsupported-call-shape`), interrupt delivery unobserved (off-script, intent recorded) — all still `not-proven` (§7.7) |
| Q5 other waiting commands | 6 (§9.1 historical); R5 (§9.4): the R2 root-family contract adjudicated all three — review-wait host-early-exit, adversarial-review-wait flow ran but renderer markers missing, status-wait fail-closed validation fired; all three still `not-proven`, each with its own recorded outcome |
| Q6 version scope and smallest adoption delta | 7 (§11.2 below); version scope now 0.160.1 (Tasks 4–6) and 0.161.0 (R5, §1.2.2), auto-update caveat in both directions |

No missing evidence is silently marked passed: every row above names its label, and §10 carries the full
`not-proven` register with causes and next steps.

### 11.2 Proposed next delta (updated through R5; no production rollout recommended yet)

The spec's positive managed-Rescue recommendation requires the actual Child route, a discriminating long
observation against measured M, repeat, reduced re-entry, exact handle/terminal linkage, and observed
native interruption/settlement. After R5 (with the 2026-10-06 review's M correction) the measurement
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
   exercised by a completed on-script run — both R5 runs went off-script before delivery (§7.7). One
   cause-directed retry with a pending observation that survives long enough for evidence collection.
2. Noise and background placement: both R5 re-runs went off-script (`unsupported-call-shape`); each
   needs its own bounded adjudication of the off-script cell shape before the measurements can complete.
3. Root command qualification: the instrument is no longer the blocker (R2 contract implemented §12.6;
   exercised §9.4). Per-command causes: review-wait's host must survive its held boundary;
   adversarial-review-wait's flow completed but its renderer-marker contract needs re-examination
   against the actual rendered bytes; status-wait needs a live run whose turn-1 launch acknowledgement is
   actually emitted and observable.
4. Generic route parity: never observed or forced; the candidate paragraph reaches the generic
   assignment only as `fixture-tested` structural parity.

If a human adopts the now-measured configuration/instruction findings, the smallest production change
would be: session/user-level `background_terminal_max_timeout` configuration guidance (never a Role
field — §2 whitelist), the candidate directive-led waiting paragraph in the named Role, and
version-scoped setup notes — each requiring a separate human-approved production plan, with the generic
assignment touched **only after** generic parity is demonstrated. No wrapper pragma is claimed universal;
no token-savings claim is made (no measurements). The unproven interruption dimension does not block a
human decision on the measured wait-behavior findings; it remains a recorded release dimension.

### 11.3 Execution handoff (updated through R5, 2026-10-08)

- Provenance: Tasks 4–6 live runs on installed `0.160.1` (auto-updated mid-pipeline from `0.160.0`); R5
  live runs on installed **0.161.0** (auto-updated again; re-pinned before the trials, §1.2.2); fixture
  source pins recorded per run in §7/§8/§9/§7.7; the R5 records additionally carry the working-tree
  observer digest per record (§12.5). Scratch files `task_plan.md`/`findings.md`/`progress.md` remained
  untracked throughout.
- Gates: Tasks 1–3 closed at codex zero-findings (rounds 5 / 4 / 17). Tasks 4–7 artifacts were produced
  under a recorded double-quota deviation: both reviewer channels hit hard quota ceilings on
  2026-10-06/07, before the report commit. The platforms announced quota resets at 2026-10-08 23:22
  (ZCode subagents) and 2026-10-10 05:11 (codex); these are reset times, not exhaustion times.
  The Task 4 gate ran once (`needs-attention`, 3 findings) and all three were fixed with regressions
  at `074fb07`. The codex side recovered early via an account switch on 2026-10-07, and the catch-up
  review ran that day; the resulting per-fix gates are recorded in §12.4.
- Amendment-phase review status: R0's corrections additionally passed the recorded codex-gate rounds
  (§12.4); **ZCode self-reviews are recorded for R0–R4** (§12.5–§12.8 and progress), and **independent
  codex backfill reviews for the R1–R3 phase gates (and R4/R5) remain pending** — they must run before
  any merge.
- Uncommitted work: **all R0–R4 instrument fixes (plus this R5 documentation amendment) are uncommitted
  working-tree changes on top of `5026009`** — commit authorization has not been granted. The final
  routine/marketplace clean-tree `npm test` check therefore did NOT run at R5 close; it needs either
  commit authorization or the spec §2 park-and-restore method (used once before at `4352796`, below).
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
- Backfill cause/provenance correction: noise, Case 0 run4 and repeat2 are manually adjudicated
  **INSTRUMENT GRAMMAR LIMITATIONS**, with execution behavior unknown and inconclusive verdicts preserved.
  The R1 fix removed that preparation-grammar blocker; the R5 noise re-run failed on a DIFFERENT
  off-script shape (§7.7). Task 5 fixture pins and unavailable executing-observer
  revisions are separated in §8; Review/Status diagnostics remain ASSISTANT-REPORTED, renderer `not-proven`.
- Human decisions open: commit authorization for the uncommitted R0–R5 work, PR merge, the §11.2
  follow-up campaign (interrupt delivery, noise/background, Root commands, generic route), and any
  eventual production adoption.

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
  recorded (this exemption was subsequently NARROWED by the 2026-10-06 review — see the review-round
  corrections below). `cleanup.nativeInterruptionClaimed` stays hard `false`.

**Review-round corrections to the interrupt rules (`fixture-tested`, 2026-10-06 review; seven P2
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
- **Instrument behavior observed across the R5 records.** The four off-script rescue records
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
