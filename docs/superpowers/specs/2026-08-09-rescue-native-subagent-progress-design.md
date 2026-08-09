# Rescue Native Subagent and Semantic Progress Design

Status: approved in design review; awaiting written-spec review

This design supersedes the foreground execution and progress-source portions of
`2026-08-08-rescue-progress-lifecycle-design.md`. It preserves that design's
durable job state, revision-guarded completion, acknowledged cancellation,
ownership, worker-lease, and orphan-recovery contracts.

## Problem

`$zcode:rescue` currently runs the ZCode companion through a terminal tool in the
main Codex agent. The companion streams progress on stderr, and Codex aggregates
terminal stdout and stderr into that agent's tool history. Long Rescue runs can
therefore consume the main agent's context with execution detail even though
the useful handoff is normally the final ZCode result.

The current progress normalizer also treats `state.updated` as the activity
stream. Real ZCode 0.16.1 turns emit that notification at the start and terminal
boundary but do not emit useful intermediate tool activity there. Rich activity
is available through the online conversation-frame stream, including tool
names, shell commands, file operations, searches, statuses, and durations.

Codex 0.147 supports native subagent threads and named Agent Roles, but a Codex
plugin cannot register a Role directly from its manifest. Agent Roles are loaded
from Codex configuration layers. The active spawn schema can also hide
`agent_type` even when the Role is installed. The plugin therefore needs a
managed Role installation lifecycle and a narrowly defined compatibility
fallback.

## Goals

- Run foreground Rescue in an isolated Codex subagent thread rather than the
  main agent's terminal context.
- Ship, install, verify, and prefer a named `zcode-rescue` Agent Role.
- Preserve a generic native-subagent fallback only when setup has verified the
  Role but the active Codex host cannot route `agent_type`.
- Keep the parent experience aligned with Codex-native multi-agent behavior:
  native activity while running and the final public result when complete.
- Let users inspect detailed execution by switching to the Rescue child thread
  with `/agent` or `/subagents`.
- Produce sparse, cc-style semantic progress inside the child thread and in the
  durable job preview.
- Preserve exact task, permission, session, cancellation, result, background,
  and recovery semantics.
- Keep caller and execution capabilities out of model-visible text, argv,
  progress, logs, and artifacts.
- Deliver the change through tracer-bullet tickets, subagent-driven TDD,
  independent reviews, a pull request, and passing required CI.

## Non-goals

- Do not forward continuous semantic progress into the parent with
  `send_message` or another model-visible relay.
- Do not make the parent agent interpret raw ZCode frames or terminal output.
- Do not provide a UI-only progress channel that Codex does not support.
- Do not fall back to running the companion inline in the parent.
- Do not pass the Rescue task, job ID, caller capability, execution capability,
  broker credential, or permission snapshot in a spawn prompt.
- Do not replace `state.updated` as the authoritative revision-guarded turn
  completion boundary.
- Do not change the public Rescue argument grammar, default foreground behavior,
  explicit background behavior, model selection, or effort selection.
- Do not change review, adversarial-review, transfer, status, result, or cancel
  routing except where shared progress rendering or setup diagnostics require it.
- Do not automatically overwrite, adopt, or remove a foreign Agent Role.
- Do not merge the feature branch into `main` as part of this work.

## Chosen Architecture

The design uses Codex-native isolation.

1. `$zcode:setup` installs and registers the managed `zcode-rescue` Role.
2. `$zcode:rescue` performs a small read-only Role readiness check.
3. The parent spawns the named Role with a fresh context and waits.
4. When the active host cannot express `agent_type`, and only after setup has
   verified the managed Role, the parent spawns a generic subagent with the same
   fixed forwarder contract.
5. The child runs one constant direct-companion command. The private prompt hook
   remains the source of the original arguments and task.
6. Companion stderr and tool history remain in the child thread. The parent sees
   native subagent activity and the final child result.
7. The user can switch into the child thread to inspect detailed progress.

The rejected alternatives are:

- Parent inline execution: best direct streaming, but no context isolation.
- Child-to-parent semantic relay: preserves parent-visible detail, but every
  relayed update enters the parent rollout and recreates bounded context
  pollution with additional orchestration and failure modes.

## Managed Agent Role

### Canonical artifact

The plugin package contains a canonical TOML Role template. The installed Role
has the stable name `zcode-rescue`, a human-facing description, and strict
developer instructions that make it a thin forwarder. The rendered instructions
pin the canonical active plugin root but contain no task or authorization value.

The Role must:

- accept only the fixed forwarder assignment from the parent;
- run the constant direct `invoke rescue` command through the available terminal
  tool without interpolating user text;
- preserve ordinary stdio so progress is visible in the child thread;
- return public companion stdout verbatim;
- return a `needs-choice` response verbatim rather than choosing resume or fresh;
- perform no independent code inspection, implementation, polling, cancellation,
  retry, result interpretation, or workspace selection;
- never print, persist, request, or forward private authorization material.

### Stable installation

Setup writes the rendered Role atomically beneath the stable writable ZCode
plugin-data root. Codex user configuration registers `[agents.zcode-rescue]` and
points `config_file` at that absolute stable path. The configuration must not
point at a versioned plugin cache directory.

Setup updates only the target leaves:

- the `agents.zcode-rescue` registration; and
- the Multi-Agent V2 setting needed to expose spawn metadata, including
  `agent_type`, when the installed Codex version supports that setting.

Setup must not replace the complete `agents`, `features`, or
`features.multi_agent_v2` tables.

### Ownership receipt

Setup stores a private ownership receipt with:

- Role name;
- plugin identity and version;
- canonical active plugin root;
- selected Codex configuration target;
- canonical managed Role path;
- Role template/schema version;
- SHA-256 of the installed Role bytes; and
- the prior value of any shared spawn-metadata setting that setup changes, when
  that value can be proven.

The receipt never stores task text, capabilities, broker credentials, or
permission snapshots.

### Collision and shadowing policy

Before writing, setup examines applicable config layers and discovered Role
locations.

- An exact receipt/config/file match is managed state and may be upgraded.
- A same-name definition without matching ownership evidence is foreign and must
  not be overwritten or adopted.
- A project Role that shadows the user-level managed Role is a hard conflict.
- A missing receipt, modified registration, modified file, or digest mismatch is
  configuration drift and fails closed.
- A higher-precedence managed requirement that prevents the needed effective
  configuration is a setup failure with an actionable diagnostic.

### Transaction and readiness

Setup first completes the existing writable plugin-data bootstrap. It then
writes the Role file, performs an optimistic leaf configuration write against
the expected config version, and re-reads the effective configuration.

Setup reports ready only when a fresh Codex session structurally verifies all of
the following:

- the receipt owns the installed bytes;
- the registered absolute path matches the receipt;
- the effective Role is not shadowed;
- the effective Role description and digest match the packaged version; and
- the effective config read has no Role-loading error for the managed definition.

Setup does not execute a Rescue or spawn a probe child merely to claim readiness.
Actual named-role selection remains a Rescue routing operation and an installed
E2E qualification requirement.

Because an existing turn's spawn tool schema is fixed, a first install or any
Role/spawn-metadata change returns `restart-required`. The user must restart
Codex or open a fresh session and rerun setup before Rescue treats the Role as
ready.

Failures must not leave a silently ready half-installation. Setup rolls back
writes it can prove it owns. If complete rollback is impossible, it records no
ready marker and reports the exact remaining paths and recovery action.

Codex plugins have no reliable uninstall hook for Role cleanup. Initial delivery
documents that raw plugin uninstall can leave a stale registration and managed
file. A future explicit cleanup operation may remove them only when the receipt,
current registration, and file digest all prove ownership. It must not restore a
shared spawn-metadata setting unless its prior value and exclusive ownership are
also proven.

## Rescue Routing

### Readiness preflight

Before any ZCode job reservation or execution, the parent runs a constant,
read-only Role status command. It returns a bounded public state and performs no
task execution. It distinguishes:

- ready managed Role;
- restart required;
- absent or outdated managed Role;
- digest/config drift;
- foreign or project shadowing conflict; and
- unsupported Codex Role configuration.

Any state except ready stops Rescue with an exact `$zcode:setup` remedy. The
preflight does not make a malformed installation eligible for fallback.

### Named Role path

When the active spawn tool exposes Role selection, the parent spawns:

- `agent_type: "zcode-rescue"`;
- `fork_turns: "none"`; and
- a fixed task name and fixed forwarder message.

The spawn message contains no original Rescue task, command arguments, job ID,
workspace choice, model choice, caller context, or capability. Full-history
forking is forbidden because explicit Role selection rejects it and because the
forwarder does not need parent conversational context.

An `unknown agent_type`, unavailable Role, effective-role mismatch, or Role
configuration error is treated as managed-state failure. It does not retry as a
generic child.

### Generic subagent fallback

Fallback is permitted only when:

1. readiness preflight has verified the installed managed Role; and
2. the active Codex host does not expose `agent_type`, or explicitly rejects that
   field as an unsupported/reserved spawn-schema capability.

The generic child receives a fixed, bounded copy of the forwarder contract and
the canonical plugin root. It uses a fresh context and the same constant direct
invocation. It receives no user task or secret. Before spawning it, the parent
may emit one fixed compatibility notice. That notice is not appended to or
substituted for the verbatim ZCode result.

No error caused by a missing, damaged, shadowed, or outdated Role is eligible
for generic fallback. No route is eligible for parent-inline fallback.

### Waiting and final result

The parent waits for the existing child and does not start another executor when
a wait times out, returns before final completion, or is interrupted by steering.
It may wait again, inspect the existing agent, or use durable job status.

On terminal success the child returns companion stdout verbatim. Child terminal
stderr remains in the child thread. The parent presents the final public result
without adding a second interpretation.

## Resume/Fresh Choice

When the first child invocation returns `needs-choice`:

1. The child returns that public response verbatim and becomes idle.
2. The parent asks the user once whether to resume or start fresh.
3. The parent sends a follow-up task to the same child.
4. The child runs only the corresponding constant `invoke-choice rescue resume`
   or `invoke-choice rescue fresh` command.
5. The parent waits for that same child and returns its terminal result.

The pending invocation remains exact-session, exact-workspace, exact-turn, and
single-use. A second child must not consume it. Invalid or expired pending choice
state fails with the existing recovery commands instead of starting a new job.

## Thread-Bound Authorization

ADR 0010 remains the authorization model. The original `UserPromptSubmit` hook
records exact private session, turn, workspace, permission, arguments, and task
state. The child runs a constant command, and the companion resolves the private
record from runtime-observed thread identity plus the canonical workspace.

Observed Codex 0.147 children inherit a usable parent `CODEX_THREAD_ID`, but this
is a version-pinned runtime dependency rather than a public stability guarantee.
The supported Codex version matrix must be qualified by real installed-plugin
E2E tests.

The companion fails closed when identity is absent, malformed, expired,
mismatched, belongs to a sibling, or cannot select exactly one active caller
turn. A child must not receive an execution capability as a substitute. The old
background capability remains confined to production Node over protected file
descriptors for explicit `--background` execution.

## Child-Local Semantic Progress

### Sources

`state.updated` remains additive and authoritative for terminal completion. Its
revision must be later than the accepted turn baseline before it can settle the
wait.

After session creation, the ZCode client attempts
`v4/conversation/subscribe` for the exact conversation topic. Progress consumes
only online delivery. The initial snapshot is ignored so historical rows do not
appear as current work.

Subscription failure is a compatibility degradation. Rescue continues with the
existing lifecycle messages and heartbeat. It must not alter completion or
timeout behavior.

### Describer

A companion-owned describer converts allowlisted frame deltas into bounded
public progress. The child model never interprets raw frames.

The cc-aligned mappings include:

- Bash start/completion with a command preview;
- Edit/Write start/completion with contained workspace-relative file context;
- WebSearch start with a query preview;
- Read, Grep, and Glob activity;
- other tools by validated bounded tool name; and
- turn start, success, failure, and finalization.

Command and query previews are normalized to one control-free line and shortened
to 96 characters. This choice intentionally favors cc fidelity. Shortening is
not secret detection, so documentation warns that a secret included in a shell
command or search query can appear in the child transcript and durable public
progress.

Allowed additional fields are contained workspace-relative paths, aggregate
file counts, fixed statuses, and bounded durations. The describer never emits:

- reasoning or chain-of-thought text;
- assistant drafts;
- raw tool output;
- file contents or Edit old/new strings;
- environment values;
- authorization or broker material; or
- raw protocol objects.

Per tool call, progress emits only the first meaningful start and one terminal
state. It ignores duplicate, stale, reordered, initial-snapshot, foreign-session,
and post-terminal events. Existing message and durable-preview byte/count bounds
remain in force.

### Sinks and failure isolation

Semantic progress has two sinks:

1. child-process stderr, visible in the Rescue child thread; and
2. the existing bounded durable job preview used by `$zcode:status`.

It does not have a parent-agent message sink.

A progress-only render, stderr, subscription, or preview update failure is
observational. It records a bounded diagnostic where safe and disables the
affected sink, but it cannot turn a successful ZCode turn into a failed Rescue.
Critical job/result persistence remains fail-closed; only optional progress
updates are decoupled.

Companion stdout remains reserved for the final public protocol/result envelope.

## User Inspection Model

The parent shows Codex-native subagent activity and the terminal result. It does
not reproduce detailed child progress.

In Codex 0.147 TUI:

- `/agent` or `/subagents` opens the agent-thread picker;
- selecting `zcode-rescue` exposes its transcript and tool execution;
- `/ps` lists background terminals owned by the currently active thread and
  renders their command plus recent chunks; and
- `/stop` stops background terminals for the currently active thread.

Therefore `/ps` is not the subagent selector. After switching to the child, a
long-running yielded companion terminal can be inspected through that child's
transcript and `/ps`. A short command may complete before it becomes a background
terminal.

The operating-system `ps` command is unrelated. Native Codex subagents are
logical threads in the Codex process; OS `ps` can show a separate Node/ZCode
process and its argv but cannot show model activity or transcript content.

Viewing a terminal through `/ps` is a UI action. It does not copy child output
into the parent model context. Tool output enters only the agent thread whose
tool call receives it.

## Background Rescue

Public `--background` semantics remain production-owned. The Role child invokes
the same constant Rescue entry point, which reserves and acknowledges the
production background worker, then returns the public queued result. Production
Node transports the one-time execution capability over protected descriptors;
neither the named Role, generic child, nor parent sees it.

After acknowledgement, the child may complete while the detached worker
continues. `$zcode:status`, `$zcode:result`, and `$zcode:cancel` remain the public
control surfaces.

## Steering, Cancellation, and Recovery

Ordinary user steering does not implicitly cancel the child or ZCode session.
The parent may respond and later resume waiting for the same child/job. It must
not spawn a replacement merely because a wait ended.

Explicit cancellation targets the exact owned job and accepted ZCode session.
The job becomes cancelled only after `session/stop` acknowledgement. A failed or
ambiguous stop preserves the conservative nonterminal guard and records a
bounded diagnostic.

If the child, parent turn, or Codex process disappears, existing durable job,
worker lease, SessionEnd settlement, and reservation-time orphan recovery apply.
Recovery must rejoin or settle the existing job and must never double execute a
Rescue. Terminal state remains immutable, and a late progress update or child
completion cannot revive it.

All public errors preserve exact actionable follow-ups using `$zcode:setup`,
`$zcode:status`, `$zcode:result`, or `$zcode:cancel` as appropriate.

## Security Invariants

- No user task, caller capability, execution capability, broker credential,
  permission snapshot, or private hook record appears in spawn messages, argv,
  progress, logs, result artifacts, or agent-to-agent messages.
- Named and generic child prompts contain only fixed instructions and the
  canonical plugin root required to locate the constant executable.
- Thread-bound resolution requires exact session, active turn, canonical
  workspace, operation, and permission consistency.
- Project Role shadowing and foreign same-name roles fail closed.
- Managed files are atomically written beneath the canonical writable plugin
  data root and are not followed through unsafe symlinks.
- Receipt/config/file comparison is exact and digest-backed.
- Conversation frames are untrusted input. Only companion-generated allowlisted
  descriptions cross the public progress boundary.
- Workspace paths are rendered only after canonical containment and are made
  relative; paths outside the workspace are not exposed.
- Child output remains isolated from the parent rollout unless it is the final
  public result or a native lifecycle status generated by Codex.
- Explicit background execution capabilities remain single-use and protected by
  production-owned descriptors.

## Compatibility and Failure Matrix

| Condition | Behavior |
|---|---|
| Managed Role ready and `agent_type` supported | Spawn named `zcode-rescue` with a fresh context. |
| Managed Role ready but active host hides/rejects `agent_type` | Spawn the fixed generic subagent fallback. |
| Role absent, outdated, corrupt, shadowed, or foreign | Stop and require `$zcode:setup`; no fallback. |
| Role changed during current session | Return restart/setup diagnostic; no fallback. |
| Child thread identity does not resolve exact caller turn | Fail closed; do not request or expose a capability. |
| Conversation subscription unavailable | Continue with lifecycle progress and heartbeat. |
| Progress-only sink fails | Disable that sink, preserve job execution and final result. |
| Wait returns while child remains active | Wait/rejoin the same child; never respawn. |
| Child returns `needs-choice` | Ask once and continue the same child. |
| Stop is unacknowledged | Preserve nonterminal state and writable guard. |
| Parent/subagent disappears | Use durable ownership, lease, and orphan settlement; never double run. |

## Testing Strategy

All production behavior follows red-green-refactor. Every implementation ticket
must include observed RED evidence before the minimal GREEN change.

### Role installation and setup

Tests cover first install, idempotent setup, package upgrade, stable managed
path, receipt/digest creation, exact leaf config edits, config-version races,
rollback, restart-required, and fresh-session revalidation. They also cover
foreign same-name Roles, project shadowing, modified files, missing receipts,
higher-precedence overrides, unsafe paths/symlinks, and preservation of unrelated
agents/features.

### Routing and skill contracts

Tests prove named Role preference, fresh-context spawn, fixed messages, generic
fallback only for host schema incompatibility, and hard failure for managed Role
problems. They prove the parent never runs the companion inline and that neither
spawn path contains task text or private values.

Choice tests prove that `needs-choice` asks once and reuses the same child through
a fixed follow-up. Wait timeout/interruption tests prove no duplicate spawn.

### Progress

Fixture tests feed initial and online conversation frames for Bash, Edit, Write,
Read, Grep, Glob, WebSearch, unknown tools, success, failure, and terminal turn
states. They cover 96-character shortening, multibyte bounds, controls, huge
strings, duplicates, reordering, cross-session frames, path traversal, post-
terminal events, and subscription fallback.

Adversarial tests prove that reasoning, assistant drafts, tool output, file
contents, environment data, capability-like strings outside approved command or
query previews, and raw frames do not cross the describer boundary. Progress-only
sink failures must leave the authoritative result unchanged.

### Installed Codex and real ZCode qualification

Opt-in installed-plugin E2E must prove, on each supported Codex line:

- setup installs and Codex loads `zcode-rescue`;
- spawn metadata selects the named Role when available;
- hidden/rejected metadata uses only the approved generic fallback;
- the child runtime identity resolves the exact parent active turn;
- missing, sibling, stale, and mismatched identities fail closed;
- parent rollout excludes child shell output, raw frames, and secrets;
- child transcript shows semantic progress and the terminal companion result;
- `/agent` or `/subagents` can select the child;
- a long-running yielded child terminal is represented under that child's `/ps`;
- final child output matches companion public stdout;
- resume/fresh, cancel, steering, session loss, and recovery do not double run;
  and
- background capability transport remains production-only.

The full repository verification command remains `npm run check`, including
lint, typecheck, unit/integration tests, and qualified tests. Opt-in authenticated
tests must report unqualified/skipped when credentials, credits, platform, or
ZCode are unavailable; such a skip cannot be represented as qualified evidence
for the compatibility claim.

## Delivery Workflow and Completion Definition

After this written spec is approved:

1. Use `$to-tickets` to draft tracer-bullet vertical slices with explicit
   blocking edges.
2. Obtain user approval of ticket granularity and dependencies.
3. Publish one local ticket file per approved slice in dependency order.
4. Write a detailed TDD implementation plan covering the approved tickets.
5. Execute tickets with fresh implementer subagents in an isolated feature
   worktree.
6. After every ticket, run an independent spec-compliance review followed by an
   independent code-quality/security review. The original implementer fixes all
   Critical and Important findings, and reviewers re-review.
7. Run complete local verification and real qualification tests.
8. Run an independent whole-diff audit for correctness, protocol compatibility,
   security, leakage, races, cancellation, recovery, and regressions. Resolve and
   re-audit every Critical and Important finding.
9. Push the feature branch and open a pull request without merging `main`.
10. Wait for all required pull-request CI checks to finish successfully.

The work is complete only when the PR exists and every required CI check is
successful. An open PR with pending, skipped-required, cancelled, or failed CI is
not complete. The final handoff reports the branch, worktree, commits, PR, local
verification, real qualification status, review/audit findings, and CI evidence.

## Documentation and Release Notes

Update the Chinese README, security guidance where required, changelog, setup
output, Rescue skill guidance, and status/help text to explain:

- mandatory managed Role setup and restart;
- the narrow generic fallback;
- parent activity versus child-thread detail;
- `/agent`/`/subagents` versus `/ps`;
- cc-style command/search previews and their privacy limitation;
- conversation-frame degradation;
- background semantics; and
- PR/CI qualification expectations for maintainers.

Package version changes remain a separate maintainer release decision.

## Acceptance Criteria

- A setup-valid installation provides and prefers a named `zcode-rescue` Role.
- Only active-host `agent_type` incompatibility permits generic subagent fallback.
- Parent-inline Rescue execution is impossible through the public skill.
- No model-visible channel transports caller or execution capabilities or the
  original task.
- Foreground companion execution and detailed progress stay in the child thread.
- Parent rollout contains native lifecycle plus final public result, not child
  terminal output.
- Users can inspect the child through `/agent` or `/subagents`, and `/ps` retains
  its current-thread background-terminal semantics.
- Online conversation frames produce sparse cc-style progress with sanitized,
  96-character command/search previews and no prohibited raw content.
- `state.updated` revision guards remain the authoritative completion boundary.
- Progress-only failures do not change the authoritative Rescue result.
- Choice, steering, cancellation, parent loss, and child loss do not cause
  duplicate execution or false terminal states.
- Unit, integration, installed Codex, and real ZCode qualification evidence
  supports every claimed compatibility path.
- Per-ticket reviews and the final independent audit have no unresolved Critical
  or Important findings.
- A pull request is open, `main` is not merged by this work, and every required CI
  check is successful.
