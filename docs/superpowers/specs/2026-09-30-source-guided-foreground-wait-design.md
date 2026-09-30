# Source-guided Foreground Wait Qualification

Status: source-backed investigation design, not a production adapter design or release authorization. Installed-host behavior remains to be qualified. Independent spec/plan review and focused amendment re-review completed on 2026-10-01 with no unresolved P1/P2 findings; see the plan's document review record. Delegation follows the current user authorization.

## 1. Decision and baseline

Investigate two narrowly scoped routes against the existing ZCode foreground goals:

1. Configure a longer empty-input `write_stdin` observation window while preserving the current shell invocation.
2. Characterize host-executed `mcp_tool` hooks as a candidate deterministic entry into the owning session's MCP runtime.

Use source inspection first to identify host behavior and existing tests; use small, discriminating installed-host experiments for integration, policy, model behavior, and timing. Do not rebuild the previous evidence framework or impose an undocumented host callback as a requirement.

This new worktree starts from PR [#64](https://github.com/vitry/zcode-plugin-codex/pull/64), head `b908cdab0608d86f51240c436d33a6be4adcb967`. PR #62 is merged into remote main at `ad6bcd433e67caf4b629cc77050b6bb9629817ea`. Reconcile remote state before later execution; do not amend either PR as part of this task.

Read the [original dual-adapter design](2026-09-18-zcode-dual-foreground-wait-adapters-design.md), [placement design](2026-09-16-rescue-placement-semantics-parity-design.md), [direct-RPC investigation](2026-09-24-codex-app-server-direct-mcp-feasibility-design.md), and [frozen report](../../qualification/codex-app-server-direct-mcp.md). Their measured results remain unchanged. A host-executed MCP hook is a different entry from `mcpServer/tool/call`; positive evidence for it cannot retroactively qualify the direct-RPC or model-selected routes.

The actual task is reducing model intervention during waiting without changing Companion behavior. Possession of an app-server connection is not independently required if a supported host mechanism supplies equivalent invocation authority, waiting, terminal delivery, and lifecycle outcomes. The original one-pending-MCP-call requirement is retained for any proposed MCP adapter.

## 2. What is known, and what is not

Source inspected: local `../codex` at `67727e7cf114cf3e1b71db368d74b24e32f6cb12` on 2026-09-30. Installed CLI reports `codex-cli 0.159.2`. The source commit has not been matched to that binary; source findings below are not claims about a measured 0.159.2 integration. Official tests cited below were read, not executed during drafting.

| Source-confirmed behavior | Consequence | Installed qualification still needed |
| --- | --- | --- |
| Empty `write_stdin` clamps to configured `background_terminal_max_timeout`; nonempty input uses the fixed short cap. Config defaults to 300000 ms and applies a minimum, not a separate five-minute maximum. | Five minutes is not a universal core hard limit. | Effective parent/Child config, tool wrapper limits, explicit requested yield, interrupt responsiveness. |
| Built-in awaiter sets the configuration to 3600000 ms. | One-hour observation is an intentional source-supported configuration. | Actual observed window and model adherence in our Role/Skill, not only awaiter. |
| Core collects output inside the wait until deadline or process/output closure. | Ordinary output does not inherently require repeated model decisions. | A noisy synthetic process and the exact existing foreground wrapper. |
| Hook configuration supports `type: mcp_tool`; local hooks await the owning MCP runtime and inject host-owned `threadId`. | A hook does not need to call back into app-server or ask the model to select MCP. | Installed plugin support, hook trust, server readiness, per-operation authority, terminal delivery. |
| Local synchronous hooks in one event are polled concurrently; executor-scoped hooks are scheduled asynchronously. | Declaration order is not a dependency barrier; not every MCP hook owns an awaited foreground result. | Ordering with current authorization hooks and environment/Child placement. |
| Hook arguments expand host event fields such as turn_id; UserPromptSubmit/PreToolUse use host-generated event data. | Exact turn information can be carried separately from model-authored tool input. | Session/thread namespace join, stale-turn rejection, actual event availability. |
| Hook executor returns joined text and raises errors for MCP isError; hook output uses command-hook parsing. | A hook result is not an ordinary MCP tool result visible to a Skill. | Lossless public text, errors, needs-choice, parent-replan, queued and status outcomes. |
| Root Interrupt hooks exist but skip subagents and are capped at three seconds; SessionEnd MCP hooks are unsupported. | Interrupt may send a bounded stop intent, not synchronously complete lengthy settlement. | Exact Child interruption, concurrent-call isolation, durable settlement, and host-loss handling. |
| Direct MCP RPC finds a supplied target thread, injects threadId, and spawns a call task. Model calls build metadata from their own issuing turn. | Target correlation, model-call identity, and hook authority are different paths. | No assumption that a thread ID alone authorizes a particular preparation or operation. |

Portable primary-source references, pinned to the inspected commit:

- [Configured empty wait](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/core/src/unified_exec/process_manager.rs#L1013): `write_stdin`, `collect_output_until_deadline`.
- [Config resolution](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/core/src/config/mod.rs#L3913) and [awaiter configuration](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/core/assets/agent/builtins/awaiter.toml#L1).
- [Hook configuration](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/config/src/hook_config.rs#L186) and [owning-runtime execution](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/core/src/hook_mcp_executor.rs#L18).
- [Concurrent local/async executor dispatch](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/hooks/src/engine/dispatcher.rs#L131) and [event argument expansion](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/hooks/src/engine/mcp_runner.rs#L27).
- [Official model-hidden hook test](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/core/tests/suite/hooks_mcp.rs#L511): `mcp_tool_hook_passes_thread_metadata_to_model_hidden_tools`.
- [Interrupt root/Child behavior](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/core/src/hook_runtime.rs#L502), [hook timeout policy](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/hooks/src/engine/discovery.rs#L742), and [SessionEnd MCP exclusion](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/hooks/src/engine/discovery.rs#L591).
- [Local tool-task interruption](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/core/src/tools/parallel.rs#L247), [direct RPC entry](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/app-server/src/request_processors/mcp_processor.rs#L685), and [model-call turn metadata](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/core/src/mcp_tool_call.rs#L1326).

## 3. Scope and alternatives

Route S (recommended first): configured shell observation. Lowest disruption; retains original command, handle, public stdout and lifecycle. It reduces decision frequency but does not promise one uninterrupted wait for every possible job duration, or force the model to choose a large yield. A parent config is not assumed to propagate unchanged to a managed Child.

Route H: host-executed MCP hook. Source-supported deterministic dispatch and host-owned context make this worth a small experiment. It has additional sequencing, readiness, presentation and Child cancellation questions. Only an installed, correctly awaited hook qualifies; source support alone is insufficient.

Route D: resume direct-RPC investigation. Keep its old record available, but do not repeat the large campaign without a concrete newly supported product entry or a changed host path. A successful disposable app-server client is still not the installed user session.

This plan implements disposable qualification artifacts only. It does not edit canonical Skills, Role templates, installed hooks, user Codex configuration, MCP packaging, binding formats, or existing frozen reports. Temporary fixture configuration is permitted. Do not launch real provider work or mutate user projects for qualification.

## 4. Unchanged product requirements

These are release requirements, not presumed host mechanisms. A failed observation leaves the candidate unqualified; it never deletes a requirement.

R1. Reuse `runDirectInvocation` and existing preparation, binding, job, execution and lifecycle modules. Do not create a competing execution engine, binding identity, cancellation machine or generic argv tool.

R2. Preserve Root semantic fresh/resume selection, Role preflight, private preparation transport, prescribed single-hop spawn/follow-up, exact canonical Child path, SubagentStart evidence, pending choices, and adapter checks at atomic consumption. Automatic/proactive Rescue and explicit use must both remain possible in a future canonical switch. Parsing the original user prompt in a hook must not replace Root's semantic preparation.

R3. A trusted invocation must join the exact Root/Child, issuing turn and authorized operation. Preserve stale-turn, wrong-executor, duplicate, cross-workspace, worktree, permission and concurrent-Child rejection. Workspace comes from the existing authoritative join; no workspace `_meta` field is required. Server cwd, newest-turn lookup, request arguments and singleton assumptions are not authority.

R4. Preserve the independent placement matrix:

| Rescue branch | Host placement | Companion execution | Wait behavior |
| --- | --- | --- | --- |
| Explicit --background | background | foreground | Root acknowledges the exact launched Child without joining; Child waits to terminal. |
| Explicit --wait | foreground | foreground | Root joins exact Child; Child waits to terminal. |
| Small bounded no-flag | foreground | foreground | Same exact Child join and terminal wait. |
| Complex no-flag | foreground | background | Existing detached runner, queued acknowledgement and later status/result. |

Review/adversarial-review background stays enqueue-only. Status --wait is observation: cancelling the wait must not cancel the target job. Preserve owner-only status/result/cancel and redacted --all behavior.

R5. Shell observes only the original process handle with empty stdin, never another launch or a replacement status poll. A configured larger window changes observation frequency, not operation timeout or job state. A proposed MCP foreground adapter retains one pending call with no periodic model waiting decisions until the current invocation's authoritative outcome. No hidden model loop may implement the hold.

R6. Preserve byte-for-byte public result text and terminal election. Test terminal success, PluginError, interrupted invocation, needs-choice, parent-replan, queued acknowledgement and nonterminal-job status snapshot separately. Neither hook additionalContext nor an outer cell completion proves Companion termination. Never expose private capability, binding, task, identity or permission material as hook output.

R7. Preserve exact explicit-interruption, host/process/transport loss, configured timeout, existing durable stop-intent/reconciliation and 100-hour safety-ceiling semantics. No accepted work becomes untracked or falsely successful. No arbitrary six-hour timeout or inactivity watchdog is introduced. Long waits must retain the existing ability to interrupt and recover; unrelated work must survive.

R8. Shell remains the available canonical adapter until separately authorized release. Any eventual MCP Skills remain distinct and explicit-only during human evaluation; no automated canonical promotion. Preserve background support in the same shared implementation rather than inventing a new background adapter.

## 5. Candidate questions to investigate, not freeze

### 5.1 Shell effective configuration

Test a synthetic 130-second process with an initial 30000 ms yield and subsequent empty polls requesting 60000 versus 180000 ms. Compare default and `background_terminal_max_timeout = 3600000` fixture configuration; use a separate 420-second process for the increased-cap control. Measure remaining process lifetime when the first empty poll actually starts: it must exceed the default 300000 ms cap by at least 30000 ms, or the sample cannot distinguish cap behavior and is inconclusive. Collect host tool calls and model request boundaries, requested/observed yields, process exit and the exact final output. A Node script's own elapsed time is not evidence of the host tool window.

Investigate managed Role configuration and wrapper caps before recommending deployment. Do not assume a Skill can alter host configuration or that increasing the cap changes an explicitly short requested yield. Report Root and Child separately, including a noisy process and interrupt responsiveness.

### 5.2 Hook entry, ordering and readiness

First demonstrate one installed disposable local MCP hook calling a model-hidden capture tool on the owning user session. Begin with a two-second bounded handler, independent of Companion authority. This proves transport/entry only.

Assess UserPromptSubmit, PreToolUse and PostToolUse as candidates, without choosing one by assumption. UserPromptSubmit is early enough to precede Root preparation; same-event hooks can race the current `beginCallerTurn`. PreToolUse tool_input is model-authored, not authorization. PostToolUse must not double-launch work already started by the original command. Executor-scoped hooks do not automatically provide synchronous terminal delivery. A candidate must preserve both proactive and explicit workflows.

Any sequencing bridge must use a supported event boundary or exact durable preparation/receipt join, not declaration order, a timing sleep, newest-state lookup or a synthetic turn. Verify missing server readiness and disabled/untrusted hooks fail before acceptance; the current hook executor explicitly does not wait for startup. Distinguish load failure from dispatch failure and handler rejection.

### 5.3 Authority and terminal-delivery integration

Build the smallest fixture that uses the real identity/preparation/binding/result seams with a harmless synthetic execution dependency. Do not accept a hand-built substitute store as proof of parity. Trace separately host threadId, hook session_id, hook turn_id, actual Child identity and the operation consumed under lock. Event-derived identity arguments are trusted only when delivered by a proven owned hook path and joined to existing authority; other MCP entry paths must not impersonate that path.

Include one otherwise identity-matching request through a non-hook ingress against the same disposable candidate before the eligible preparation is consumed. A duplicate-consume failure or model-hidden discovery flag does not prove channel authority. The non-hook request must fail before admission unless a separately supported exact authorization mechanism establishes its authority; it must never acquire hook authority merely by copying event/metadata fields. If the candidate cannot distinguish provenance or this control cannot reach its actual admission boundary, leave the authority qualification not-proven. The supported discriminator is a research question, not a preselected host token or callback requirement.

Evaluate text-only hook result delivery against the existing renderer and control outcomes. A candidate that merely inserts a summary into model context, changes an error into success, loses pending-choice authority, or needs periodic model decisions does not satisfy the MCP goal. Establish a deterministic, supported terminal route; do not prescribe an unverified receipt/no-op launcher or updatedInput mechanism.

### 5.4 Cancellation and settlement

Root Interrupt may be a bounded durable stop-intent writer, subject to exact operation ownership and ordering. It cannot be assumed to run for Rescue Child, run after Root's initiating background turn is complete, or settle a worker inside its three-second budget.

Characterize Child interruption and existing SubagentStop/host-loss reconciliation. Prove durable settlement on real shared lifecycle code, including a Child interrupted after Root returned for Host background placement, later same-child continuation, concurrent unrelated Child, and status observation cancellation. Dropping a Rust future, returning a timeout/error, or seeing interrupted turn status is not downstream settlement evidence. If no supported exact Child route exists, record that candidate as unqualified and continue independent shell work.

## 6. Evidence and bounded work

Keep records labeled `source-confirmed`, `fixture-tested`, `installed-observed`, or `not-proven`; never upgrade source facts or mocks to installed qualification. Record exact CLI/binary identity, source revision when known, host surface, model, effective relevant configuration, plugin/fixture commit, and local versus executor-scoped hook selection. A source/binary mismatch is explicit provenance, not a fabricated match.

Retain only bounded event kinds, ordering, counts, durations, closed outcomes and salted identity comparisons. Keep raw traces private and ephemeral; no user paths, prompts, private descriptors, IDs, full metadata or credentials in retained logs. Fixture outputs are synthetic. Use the existing owned process-group cleanup; Node fixtures should use `process.execPath` directly to avoid the proven env-to-node identity race.

Minimal campaign: one small entry smoke per candidate; one MCP 130-second hold only after that candidate's MCP entry/ordering succeeds; independent shell measurements, including default/configured cap controls with 420-second processes, after shared instrument/cleanup tests and a short actual-shell smoke pass. Failed or inconclusive MCP smoke never blocks shell holds. Run targeted authority/lifecycle cases only on a viable integration. Repeat a decisive result once with a fresh fixture. An inconsistent repeat is inconclusive and permits one cause-directed diagnostic, not an unrestricted campaign. Continue safe independent tasks when a dependent route cannot progress. Use short injected clocks for the 100-hour branch through production lifecycle logic; do not wait 100 real hours.

New research tests must be excluded explicitly from routine npm test, following [research isolation](2026-09-30-isolate-mcp-research-tests-design.md). Keep production parity/lifecycle tests in the routine suite. Avoid a new generic evidence schema, tamper-proof reducer or exhaustive simulator unless a specific measured failure requires it.

## 7. Completion and release boundary

Complete this investigation with a source index, minimal probe, exact observations, candidate comparison, requirement-to-evidence matrix and a recommendation. Each candidate is qualified only for its demonstrated surface and conditions; untested cases remain not-proven.

Shell recommendation requires measured larger host-tool windows and preserved exact handle, output and interruption behavior, plus an explicit config/Role deployment proposal. It is independent of MCP readiness and does not satisfy the MCP requirement by substitution.

An MCP production design recommendation requires supported installed entry, exact authority/atomic consumption, one pending foreground call without periodic model decisions, lossless terminal/control delivery, and all R1-R8 lifecycle/placement/ownership outcomes. A hook smoke alone is not sufficient. No production design or packaging is authorized by this document; after results, write a focused production delta plan for the proven route. Architecture expansion such as a custom UI, fork or external host needs a new user decision.

Do not rewrite the old frozen records. Record new findings in `docs/qualification/source-guided-foreground-wait.md`; describe the omitted hook candidate precisely without calling the old measurements invalid or asserting global MCP impossibility.

## 8. Execution handoff

Read this spec, the [task plan](../plans/2026-09-30-source-guided-foreground-wait.md), and the linked baseline contracts. Execute in the new worktree, not main or PR #64's worktree. Do not request a user decision for ordinary unknown implementation details: investigate within the plan and record the branch outcome. Ask only when authority or product scope must expand. Use inline self-checks and independent reviews when authorized by the user; retain human evaluation as the eventual canonical-switch decision.
