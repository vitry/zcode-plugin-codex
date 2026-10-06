# Rescue Native Shell Long-Wait Qualification

Status: **research-only**. Task 1 executed 2026-10-05; Task 4 live measurements recorded 2026-10-06 under the plan
[2026-10-05-rescue-shell-long-wait](../superpowers/plans/2026-10-05-rescue-shell-long-wait.md)
under the spec
[2026-10-05-rescue-shell-long-wait-design](../superpowers/specs/2026-10-05-rescue-shell-long-wait-design.md).
Worktree base commit `703fdcee958f4729a83d1a978c3b0e5cfa25f90a` (branch base `6638878e910154d7d1bc4effd4c9aa62f149f23a`, merged PR #65).
This document authorizes **no production change**: canonical Skills, Role template, Companion stores, hooks,
packaging, user configuration and `../codex` are untouched. §7 records Task 4 installed observations and
precise limits; §8–§9 and §11 remain unexecuted Task 5–7 skeletons. §2–§6 retain the source/design findings,
§10 is the current not-proven register, and §12 records fixture-tested instrument behavior and its limits.

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
setup/inspection clients never prove managed-Child inheritance).

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
| [run4](/tmp/shell-wait-t4-case0d.jHqZlH/rescue-long.record.json) | `7edb8adb1781404301f0a29bcc3bd7de6ab45972` | Model went off-script and never launched the Companion; unsupported inline private preparation variant. Host exit 0, route/linkage/counts unknown; observation cleanup complete, 0 errors. Model nonadherence, retained without further retry |

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
- [repeat2](/tmp/shell-wait-t4-repeat2.9hJDAp/rescue-repeat.record.json): first action wrote the private
  preparation envelope in an unsupported inline variant. **Model nonadherence**, recorded and not retried;
  inconclusive `unsupported-call-shape`, host exit 0, unknown Child/count/result facts; observation cleanup
  complete, fixture disposed, 0 errors.

No comparable successful repeat interval or repeat cadence was established. Neither failure is evidence
against the installed long-wait mechanism, nor does either count as repeat qualification.

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

## 8. Lifecycle, results, placement, Status sidecar (Task 5)

Executed 2026-10-07 at source `074fb07` (instrument as amended through the Task 4 gate fixes), installed
Codex `0.160.1`, same resolved executable `/Users/zhangzikai/.codex/packages/standalone/releases/0.160.1-aarch64-apple-darwin/bin/codex`.
Three live cases ran once each; no case was retried out of the record. Model nonadherence dominated this
task: two of three cases ended before the observation flow the case prompts for, which the plan records as
an outcome rather than a retry trigger.

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

### 8.2 `rescue-noise`: inconclusive — model nonadherence (`installed-observed` outcome, checks `not-proven`)

Record: `/tmp/shell-wait-t5-noise.o7vg44/rescue-noise.record.json` (worker 130000 ms, raised cap,
budget 360000 ms). The model left the prompted flow before the observation phase and the observer retained
an `unsupported-call-shape` cell for manual adjudication, so the same-handle/no-replacement-Status/no-relay/
exact-stdout checks could not be observed. This is recorded as model nonadherence; the instrument's
fail-closed verdict (`inconclusive`, never zero) behaved correctly. The existing conversation/progress
output remains the only sanctioned progress surface; no heartbeat protocol was added.

### 8.3 `background` compatibility: inconclusive — host ended before the boundary (`installed-observed` outcome)

Record: `/tmp/shell-wait-t5-background.ty0i87/background.record.json`. Route selected `named`, but
`companionLaunchCount: 0`, `modelCalls: 0`, and the host exited before the held completion boundary
(`inconclusive: "the host ended before the held completion boundary; the pending-observation claim is
inconclusive"`). The model never performed the explicit `--background` flow, so the new installed evidence
for the background placement branch is not established. The placement matrix's inherited contract coverage
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

### 9.1 Outcomes (`installed-observed` for what was observed; long-wait qualification `not-proven`)

| Command | Record | Observed outcome | Long-wait qualification |
| --- | --- | --- | --- |
| `review-wait` | `/tmp/shell-wait-t6-review-wait.JYhGH8/review-wait.record.json` | The model invoked Review with focus text; the Companion returned its exact public error result `{"error":{"code":"ARGUMENT_INVALID","category":"validation","message":"Review does not accept focus text.",…}}` (final-agent-message adjudication excerpt), then the host exited before the held boundary. `sendCount: 0` | **`not-proven`** — the error path was observed, the 130-second hold was not |
| `adversarial-review-wait` | `/tmp/shell-wait-t6-adversarial-review-wait.iMiSBx/adversarial-review-wait.record.json` | One `session/send` reached the fake peer, but no child linkage, launcher, terminal exit or sentinel applied; the case ended inconclusive | **`not-proven`** |
| `status-wait` | `/tmp/shell-wait-t6-status-wait.DIXml7/status-wait.record.json` | The model invoked Status without the required 64-character job ID; the Companion returned its exact public error result `{"error":{"code":"ARGUMENT_INVALID","category":"validation","message":"Expected one 64-character job ID.",…}}`; host exited before the boundary. `sendCount: 0` | **`not-proven`** — including the cancellation subcase (native interruption is separately `not-proven`, §10) |

The two `ARGUMENT_INVALID` results are genuine command-level public results observed through the retained
final-agent-message adjudication excerpts — the Renderer's exact error contract held — but they are error
paths, not the requested 130-second observation, and the plan forbids presenting them as command
qualification.

### 9.2 Instrument gap discovered by Task 6 (`not-proven` prerequisite for a root-family campaign)

The driver's completion contract is **Rescue-shaped**: it qualifies exact Child linkage, the Rescue
launcher invocation, and the original Child handle. Root-family cases intentionally have no Rescue Child,
so `adversarial-review-wait`'s record reads "child linkage is not exact; the exact launcher command was
observed in no identified child rollout" even when the Root-side flow ran — the verdict frame, not the
host, rejected the case. A root-family campaign needs its own bounded observation contract (Root's own
process handle, the constant Companion command, the command-specific renderer result, decision cadence,
and — for `status-wait` — observation cancellation that leaves the job running) before any Root command can
be qualified. Building that contract is a reviewed instrument change, out of scope for this campaign.

### 9.3 Model adherence

All three root-family cases also surfaced the same model-adherence flakiness recorded in Task 5: the model
invoked commands with wrong arguments (focus text, missing job ID) or ended its turn early. Per the plan,
each command keeps its own outcome; no command is declared impossible or qualified from another's run.

## 10. Not-proven register (updated after Task 4)

| Unresolved claim | Evidence and reason | Useful next step / owner |
| --- | --- | --- |
| Source/binary mapping | **`not-proven`**: Codex source `67727e7c` is not mapped to installed 0.160.1; 0.160.0 was the historical Task 1/Root version | Keep source facts separate; qualify any later installed version independently (Task 7) |
| Installed unraised Child cap M | **`not-proven`**: four Case 0 records (§7.3); two grammar gaps, one terminal-rule mismatch/process-exit ender, then model nonadherence. None is a cap-limited inner completion on a still-running worker | A separately commissioned discriminating Case 0 must preserve the rule and leave enough measured worker lifetime; no further retry is claimed here |
| Raised fixture cap propagation onto the Child | **`not-proven`**: M absent. Case B's ≥386.6-s ceiling is `installed-observed`, beyond the source's 300000 ms, but cannot distinguish fixture override from unknown installed default | Establish M before causality or adoption guidance; never promote a Role cap field (§2 whitelist, Task 7) |
| Case A qualified completion | **`not-proven`**: consecutive `wait cell_id` linkage unresolved in observer; original-handle check false/pending tail true. Cadence 15 returns and exit/sentinel facts remain `installed-observed` | Narrow observer work on the actual continuation sequence, with linkage negatives preserved; no host rejection inferred |
| Repeat qualification | **`not-proven`**: repeat1 instrument natural-exit verification failure; repeat2 unsupported inline preparation/model nonadherence, not retried (§7.4) | Diagnose lifecycle failure separately; any new live repeat requires explicit scope, and cannot erase these records |
| Generic route and broader instruction support | **`not-proven`** installed; only named was observed. Artifact synchronization/structural parity is `fixture-tested`; the candidate's named invocation is `installed-observed` | Keep conclusion named-scoped; no generic fallback after Role-value rejection, no universal wrapper claim (Tasks 5/7) |
| Exact native interrupt/tool-family availability and pending-inner cancellation | **`not-proven`**: Task 5's `rescue-interrupt` (§8.1) qualified the pending observation but the driver never DELIVERED a native interrupt (`delivered: null` with the prerequisite recorded), so delivery, target, interval, settlement and collateral cancellation are unmeasured; retained records do not establish full tool exposure | Wire the §3.1 surface into the owning native session, deliver to the exact pending Child and measure settlement; turn interrupt alone is insufficient (Task 7 follow-up) |
| Installed `multi_agent_v2` configuration/bounds | **`not-proven`**: no installed configuration inventory or timeout-bound measurement | Record actual reachable family and bounds during Task 5/6; source defaults are separate |
| Noise, progress relay, Status sidecar latency, background placement, stop/loss/ceiling | **`not-proven`** as new installed evidence: Task 5 ran each live case once — `rescue-noise` ended in model nonadherence before the observation flow (§8.2), `background` ended with the host exiting before the boundary and zero launches (§8.3), the Status sidecar stayed structural (§8.4), and stop/reconciliation live checks were not exercised; unchanged inherited contracts and fixture cleanup do not qualify these dimensions | Any new campaign must first address the model-adherence flakiness these two cases exposed; budget/failure cleanup is not native user interruption |
| Review/Adversarial Review/Status waiting commands | **`not-proven`**: Task 6 ran each once (§9.1) — two observed their exact Companion `ARGUMENT_INVALID` error paths (real public results, not holds) and none reached a 130-second observation; the instrument's Rescue-shaped completion contract also cannot adjudicate root-family cases (§9.2) | Build a reviewed root-family observation contract (Root handle, constant command, command-specific renderer, cancellation-leaves-job-running) and rerun with a held job for Status |
| Production release/version generalization/token savings | **`not-proven`**: single named fixture invocation on 0.160.1, disposable sandbox/hook bypass, no token measurements; auto-update limits attribution to the earlier 0.160.0 record | Finish Tasks 5–7 and obtain separate adoption decision; no production rollout implied |

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
| S4 placement/background/Status observation-only | 5 (§8.3 background case inconclusive — model nonadherence; §8.4 sidecar structural-only); inherited placement matrix suites §8.5; **`not-proven` as new installed evidence** |
| S5 interruption/loss/timeouts/ceiling | 5 (§8.1: pending observation qualified; native interrupt delivery NOT exercised — `not-proven`); budget cleanup never labelled interruption; 100-hour ceiling untouched (production semantics unchanged) |
| S6 named/generic parity and no fallback weakening | 1 (§3/§4 route authority); 4 (§7.1: route actually selected = `named`; generic `not-proven`, no fallback forced) |
| S7 isolation/no production changes | 2 (§ selection isolation), 3 (§12 fixture-owned clone/homes/cleanup), 7 (§1 provenance; final diff = docs + probe files only; production Skills/Role/Companion/config/packaging untouched) |
| Q1/Q2 effective Child configuration/instructions | 1 (§2 config layers), 4 (§7.3: M `not-proven`; §7.1: candidate instructions delivered and followed on the named route) |
| Q3 cadence and repeat | 4 (§7.2 A 15 returns vs §7.1 B 0, `installed-observed`; repeat `not-proven` §7.4) |
| Q4 noise/native interruption/sidecar latency | 5 (§8.1–§8.4: all `not-proven` except the qualified interrupt-case pending observation) |
| Q5 other waiting commands | 6 (§9: all three `not-proven`; error-path public results observed; root-family contract gap recorded) |
| Q6 version scope and smallest adoption delta | 7 (§11.2 below; single-version scope 0.160.1, auto-update caveat §7.1) |

No missing evidence is silently marked passed: every row above names its label, and §10 carries the full
`not-proven` register with causes and next steps.

### 11.2 Proposed next delta (scoped; no production rollout recommended yet)

The spec's positive managed-Rescue recommendation requires the actual Child route (met: `named`),
a discriminating long observation **and repeat** (repeat `not-proven`), reduced re-entry (met:
15 → 0), exact handle/terminal linkage (met), and observed native interruption/settlement
(`not-proven`). The adoption decision therefore stays open, and the smallest useful next delta is a
**scoped follow-up campaign**, not a production change:

1. Measure M (unraised installed Child cap) with a case whose model flow completes — the four §7.3
   attempts each failed for a different recorded cause; the instrument is now grammar-complete and
   retains terminal stdout on mismatch, so the next attempt is diagnostic by construction.
2. Establish cap propagation against the measured M (raised-config Case B pair), then one fresh repeat.
3. Wire the §3.1 native interrupt surface into the driver and measure delivery-to-settlement during a
   pending observation.
4. Build the reviewed root-family observation contract (§9.2) before re-attempting Review /
   Adversarial Review / Status `--wait`.

If those close positive, the smallest production adoption would be: session/user-level
`background_terminal_max_timeout` configuration guidance (never a Role field — §2 whitelist), the
candidate directive-led waiting paragraph in the named Role and generic assignment **only after** generic
parity is demonstrated, and version-scoped setup notes — each requiring a separate human-approved
production plan. No wrapper pragma is claimed universal; no token-savings claim is made (no measurements).

### 11.3 Execution handoff

- Provenance: all live runs on installed `0.160.1` (auto-updated mid-pipeline from `0.160.0`; §1), source
  pins recorded per run in §7/§8/§9; scratch files `task_plan.md`/`findings.md`/`progress.md` remained
  untracked throughout.
- Gates: Tasks 1–3 closed at codex zero-findings (rounds 5 / 4 / 17). Tasks 4–7 artifacts were produced
  under a recorded double-quota deviation (both reviewer channels exhausted — ZCode 2026-10-08 23:22,
  codex 2026-10-10 05:11): the Task 4 gate ran once (`needs-attention`, 3 findings) and all three were
  fixed with regressions at `074fb07`; the re-review and the Task 5/6/7 + overall reviews are
  **pending backfill** and must run before any merge decision.
- Final verification at `4352796` (tree fully committed — commits authorized by the user's PR
  requirement): `npm test` exit 0 with the routine suite at **3397 tests / 3394 pass / 0 fail / 3
  skipped** (the three skips are the inherited opt-in E2E guards, not win32) and the marketplace
  snapshot build **2/2**; plus `npm run test:shell-research` **177/177**, selection **6/6**, lint,
  typecheck, line endings and `git diff --check` clean, zero probe worktree registrations. The three
  untracked planning scratch files were parked outside the tree for the clean-source check and restored
  afterwards (spec §2 method, documented here).
- Records: the seven Task 4 records, three Task 5 records and three Task 6 records live under
  `/tmp/shell-wait-t4-*` and `/tmp/shell-wait-t5-*`, `/tmp/shell-wait-t6-*` (OS-temporary; the report's
  tables are the durable summaries, as the plan intends).
- Human decisions open: PR merge, the §11.2 follow-up campaign, and any eventual production adoption.

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
  A mismatch retains a `terminal-stdout-mismatch` excerpt of the actual linked terminal output,
  with private-path redaction, control-character scrubbing, a 2048-character cap and an explicit truncation
  flag. It is retained **first**, so list capping cannot hide it. A regression uses the real production
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
  unified-exec header `Wall time: <seconds> seconds` (`codex-rs/core/src/tools/context.rs` `response_header`) and
  the code-mode wrapper/cell header `<status>\nWall time <seconds> seconds\nOutput:` (no colon,
  `codex-rs/core/src/tools/code_mode/output.rs`). Residual limitation: the installed 0.160.0 build's exact header
  form may differ from both pinned forms; on that build the extraction returns `null` (with the harness override
  still available) until Task 4 observes the installed shape, and this never blocks the fail-closed counts above.
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

### 12.5 What this instrument deliberately does NOT claim

- No live Codex trial ran during Task 3. Task 4 installed observations are in §7. Every live-run path requires
  `ZCODE_SHELL_WAIT_E2E=1`; fixture regression results above remain instrument correctness, not host behavior.
- The driver's default live executor (per-case Root prompts, gate files, rollout collection, evidence mapping) is
  implemented and exercised by Task 4 within §7's limited scope; unsupported preparation and baseline
  continuation shapes still fail closed. Task 4 surfaced the bounded corrections recorded in §12.4. Its observation poll retries a bounded number of consecutive transient rollout
  read/parse failures of an actively appended rollout instead of aborting the held turn; the final post-run load
  keeps its own distinguished, private-path-scrubbed failure reason.
- The unraised-default cap M remains unmeasured after Task 4. Named Child candidate behavior and fixture
  artifact hashes are recorded in §7; these do not prove an effective Child cap or generic delivery. The
  stored rendered Role hash is fixture provenance, not a runtime introspection of the Child config.
- `rescue-interrupt` records the interrupt as requested-but-not-delivered with the missing prerequisite named:
  the exact native interrupt delivery interaction is bound by the Task 5 live path. This run shape can never be
  counted as interruption evidence.
- The fixture's hook-trust/approval bypass and credential copy are fixture controls inside the disposable
  temporary root. They are not persisted production-trust qualification and authorize nothing outside the run.
- The `review-wait`, `adversarial-review-wait`, `status-wait`, and `background` case prompts approximate the
  installed Skill entry points; Task 6 pins their exact live command surfaces before any Root-command conclusion.
