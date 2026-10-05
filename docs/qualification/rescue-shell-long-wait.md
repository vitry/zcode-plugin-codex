# Rescue Native Shell Long-Wait Qualification

Status: **research-only**. Executed 2026-10-05 as Task 1 of the plan
[2026-10-05-rescue-shell-long-wait](../superpowers/plans/2026-10-05-rescue-shell-long-wait.md)
under the spec
[2026-10-05-rescue-shell-long-wait-design](../superpowers/specs/2026-10-05-rescue-shell-long-wait-design.md).
Worktree base commit `703fdcee958f4729a83d1a978c3b0e5cfa25f90a` (branch base `6638878e910154d7d1bc4effd4c9aa62f149f23a`, merged PR #65).
This document authorizes **no production change**: canonical Skills, Role template, Companion stores, hooks,
packaging, user configuration and `../codex` are untouched. Only §7–§9 and §11 are placeholder skeletons for
later tasks and are explicitly **not yet executed**; §3–§6 and §10 record Task 1's delivered findings, and §12
records Task 3's fixture instrument facts (no live claims).

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
| Package dependency | `scripts/lib/tool-launch.mjs` defaults to `node_modules/@openai/codex/bin/codex.js` (the repo's pinned dependency) unless `CODEX_BINARY` names an absolute native executable. Every live case must set `CODEX_BINARY=/Users/zhangzikai/.local/bin/codex`; a dependency version is not the current host. |

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

Whether this inheritance actually holds on the **installed** 0.160.0 build is exactly what Task 4's trial
measures — `not-proven` until then (the prior record's `scripts/lib/codex-config.mjs` caveat is preserved:
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

## 6. Narrow hypothesis and first discriminating trial (design only; Task 4 executes)

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

### 6.2 First discriminating live trial (design; `not-proven` until run)

- **Fixture**: Task 3's isolated installed-plugin fixture; exact installed executable
  (`CODEX_BINARY=/Users/zhangzikai/.local/bin/codex`, 0.160.0); fake-ZCode hold; worker duration and probe
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

## 7. A/B measurements (Tasks 4) — not yet executed

Not yet executed. Placeholder for: cap-matched current-instruction control and candidate runs, requested vs
actual directives/yields, outer-return and pending-inner counts, exact handle linkage, remaining lifetime,
process exit, route actually selected (named/generic), repeat outcome, and the recorded unraised/default cap
measurements on the actual Child.

## 8. Lifecycle, results, placement, Status sidecar (Task 5) — not yet executed

Not yet executed. Placeholder for: noise case, native interrupt delivery and settlement (via the §3.1 surface,
if the installed family exposes it), stop/reconciliation checks, exact no-argument Child Status intents and
sidecar latency, background compatibility case, and focused production regressions.

## 9. Root waiting commands (Task 6) — not yet executed

Not yet executed. Placeholder for: `review-wait`, `adversarial-review-wait`, `status-wait` observations with
their real entry points, decision cadence, ownership and cancellation behavior.

## 10. Limitations and unresolved prerequisites (Task 1 scope)

Every unverified installed step is named here explicitly:

1. **No source/binary mapping**: pinned source `67727e7c` vs installed `codex-cli 0.160.0`. All §2–§3 claims
   are about the pinned source; the installed build may differ (the prior record already proved the installed
   wrapper layer differs from the pinned source's plain function-call shape).
2. **Installed wrapper behavior on the Child**: the ≈30 s plain-yield clamp and the `@exec` directive are
   `installed-observed` Root behaviors from the prior record (§7.3); they are **not** source-derived and have
   never been observed on the managed Rescue Child.
3. **Installed cap propagation to the Child**: the §2.6 inheritance chain is source-confirmed; the installed
   equivalent is the exact object of Task 4's trial — `not-proven` now.
4. **Installed collab tool family (V1 vs V2) and `interrupt_agent` presence**: not observed in this task; the
   prior role-control run did not record it. Interrupt qualification stops until a live Root session shows the
   tool (or the precise gap, if absent). Per §3.1, whether a Child turn interrupt cancels the pending inner
   observation (feature/backend/continuation shape, including the installed script wrapper) is separately
   **not-proven** and must be measured, not assumed, in Task 5.
5. **Effective default cap on the installed build**: source default 300000 ms (source fact, §2.5); no fresh
   Child-level measurement exists. Both the trial's remaining-lifetime validity requirement AND the
   configuration-propagation verdict threshold must use the measured installed unraised Child cap (§6.2
   Case 0 — the unraised-cap control run carrying the SAME long requests as Case B, so the cap configuration
   is the only difference) — never the source-confirmed 300000 ms value. M is assigned only after a
   cap-limited completed inner poll on a still-running worker; every other ender (requested-yield expiry,
   outer continuation, process exit, interruption, budget expiry) leaves M not-proven with only the observed
   duration recorded, and until M is established configuration propagation stays **not-proven**.
6. **`multi_agent_v2` configuration of the installed host** (wait_agent gating `wait_agent_enabled`, timeout
   bounds overrides): unknown; affects Root `wait_agent` bounds and V2 tool exposure.

## 11. Proposed delta (Task 7) — not yet drafted

Not yet drafted. Placeholder for the smallest adoption delta scoped to qualified surfaces only (configuration
location per the actual Child/Root trace, compatible instruction form, named/generic synchronization, setup
guidance, version/latency limits), separated from release-blocking findings.

## 12. Fixture (Task 3) — instrument facts only, no live claims

This section records what the Task 3 instrument does, at which seams it is tested, which of its behaviors are
fail-closed, and what it deliberately does **not** claim. Everything here is labelled `fixture-tested` (fast
Node test regressions in `tests/shell-wait-probe.test.mjs`); nothing in this section is `installed-observed`,
and no statement in §1–§11 is re-derived or weakened by it.

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

- No live Codex trial ran in this task. Every live-run path requires `ZCODE_SHELL_WAIT_E2E=1`, and the suite
  green above is instrument correctness, not host behavior.
- The driver's default live executor (per-case Root prompts, gate files, rollout collection, evidence mapping) is
  implemented but **not yet live-validated**; its first real execution belongs to Task 4, which may surface
  bounded fixture corrections. Its observation poll retries a bounded number of consecutive transient rollout
  read/parse failures of an actively appended rollout instead of aborting the held turn; the final post-run load
  keeps its own distinguished, private-path-scrubbed failure reason.
- The unraised-default cap M is not measured, no instruction delivery into a real Child was observed, and the
  rendered/delivered hash comparison the fixture prepares (repository vs running Role) is a Task 4 measurement.
- `rescue-interrupt` records the interrupt as requested-but-not-delivered with the missing prerequisite named:
  the exact native interrupt delivery interaction is bound by the Task 5 live path. This run shape can never be
  counted as interruption evidence.
- The fixture's hook-trust/approval bypass and credential copy are fixture controls inside the disposable
  temporary root. They are not persisted production-trust qualification and authorize nothing outside the run.
- The `review-wait`, `adversarial-review-wait`, `status-wait`, and `background` case prompts approximate the
  installed Skill entry points; Task 6 pins their exact live command surfaces before any Root-command conclusion.
