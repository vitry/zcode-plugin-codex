# Rescue Task Boundary and Automatic Routing Design

Status: approved in design review; awaiting written-spec review

## Problem

The Rescue integration currently derives an explicit invocation from everything
after the first `$zcode:rescue` marker in the recorded user prompt. That works
when the entire prompt is a command, but it fails when a user embeds the marker
inside a larger Root instruction. In the observed incident, the real development
objective appeared before the marker while the trailing text told Codex to stop
and report if Rescue failed. The parser discarded the development objective and
sent the Root-only stop policy to ZCode as its complete authorized objective.

ZCode then encountered a normal project test failure while working, performed
another agent turn, and chose to stop because the malformed objective told it to
do so. The companion waited for ZCode's authoritative terminal lifecycle signal;
it did not terminate merely because `npm test` failed. The defect is therefore a
task/control boundary failure, not project-output classification or premature
protocol completion.

The existing candidate behavior also always requires a user choice when neither
`--fresh` nor `--resume` is present. That is appropriate for an explicit user
command, but it prevents Root from using ZCode like a normal managed subagent:
starting a fresh child for an independent objective, resuming a related session,
and rejoining an active child without needless user intervention.

## Goals

- Preserve the complete user-authorized business objective delivered to ZCode.
- Keep Root-only orchestration policy out of `AUTHORIZED RESCUE OBJECTIVE`.
- Distinguish explicit command entry from proactive Root-managed entry using
  structured state captured at the trusted prompt boundary.
- Preserve explicit `--fresh` and `--resume` as authoritative user choices.
- Preserve one-time user confirmation for an explicit command with a resumable
  candidate and no explicit choice.
- Let Root automatically select fresh or resume for a proactive invocation when
  semantic intent is clear, asking the user only when it is genuinely ambiguous.
- Rejoin the same active Rescue child rather than spawning or invoking again.
- Keep the dedicated Rescue child a task-blind, capability-free, single-hop
  forwarder.
- Treat only companion, protocol, or authoritative ZCode lifecycle termination
  as Rescue failure; project tool output remains part of ZCode's internal work.
- Protect the behavior with unit, integration, installed-skill, and snapshot
  regression tests.

## Non-goals

- Do not add special cases for `npm test`, test runners, builds, lint, or shell
  exit codes appearing inside ZCode's work.
- Do not infer success or failure by parsing arbitrary ZCode prose or tool output.
- Do not add a public `--auto` option.
- Do not change the ZCode protocol completion boundary.
- Do not add task text to the Rescue child spawn message.
- Do not let ordinary subagents invoke Rescue or let the Rescue forwarder spawn
  nested agents.
- Do not change session/history/status presentation or prune accumulated jobs.
- Do not change review, adversarial-review, transfer, status, result, cancel, or
  setup semantics except for shared parsing helpers required by this design.
- Do not merge the feature branch into `main` as part of delivery.

## Chosen Architecture

The design adds a private preparation boundary and separates three concerns that
are currently conflated:

1. **Root normalization** uses the model's understanding of the user request to
   separate the business objective from host-only orchestration policy and to
   classify the entry as explicit or proactive.
2. **Private preparation** accepts one bounded JSON envelope over stdin, binds
   it to the exact active parent turn and canonical workspace, and stores it in
   private plugin state. Task or routing text never appears in process argv or a
   child message.
3. **Root orchestration** decides proactive fresh/resume semantics before the
   fixed child forwarder consumes the prepared invocation.

The companion remains the execution authority for durable jobs and candidate
validation. ZCode remains the authority for its own multi-turn reasoning and
terminal result. Neither layer interprets intermediate project command output.

## Task Boundary

### Explicit command form

The canonical explicit form remains:

```text
$zcode:rescue [options] <task...>
```

For this form, only text belonging to that command is parsed as Rescue options
and task. Host instructions such as "if Rescue itself returns an error, stop and
report it" belong outside the command and are consumed by Root, not by ZCode.

The Root skill instructions must teach and enforce the boundary when a larger
natural-language request contains `$zcode:rescue`: Root constructs a private
preparation envelope from the complete business objective and chosen routing
options. It must not mechanically treat text before or after the marker as the
task. The original recorded prompt remains authorization evidence but is no
longer the task parser for the prepared route.

### Proactive form

When the user asks Root to use ZCode as a subagent without writing the literal
command, Root prepares the business objective with source `proactive`, then
invokes the same fixed forwarder. Host-only delivery requirements remain Root
policy and are excluded during normalization.

No task text travels through `spawn_agent`, child messages, process arguments,
environment variables, status output, or progress relays. It travels once over
the stdin of the parent-owned preparation process and is then stored beneath the
existing private plugin-data boundary.

### Private preparation protocol

After the constant readiness preflight, the parent starts one constant private
command, `prepare rescue`, over ordinary stdio. The process reads exactly one
newline-terminated JSON object from stdin, requires EOF, emits only a bounded
task-free acknowledgement, and exits. The exact envelope is:

```json
{
  "version": 1,
  "source": "explicit",
  "task": "the normalized business objective",
  "options": {
    "execution": "foreground",
    "resume": "fresh",
    "model": "provider/model",
    "effort": "high"
  }
}
```

`source` is `explicit` or `proactive`. `task` is non-empty and bounded to the
existing 64 KiB limit. `options` admits only the existing Rescue option values;
optional keys are omitted, never null. Unknown keys, duplicate JSON keys,
trailing bytes, invalid UTF-8, an inactive/mismatched parent turn, or a second
preparation for that exact turn fail closed. Preparation neither reserves a job
nor starts ZCode.

The subsequent constant child command changes from `invoke rescue` to
`invoke-prepared rescue`. Consumption is atomic and requires the exact active
parent turn plus the hook-bound Rescue executor. A prepared record cannot be
consumed by the parent, a sibling, another workspace, another session, or a
second child. If preparation or spawn fails before consumption, bounded
turn/session cleanup removes the stale record.

### Control-policy exclusion

Root-level instructions govern what Root does after the child returns. They are
never appended to the Rescue task. Examples include:

- stop and report if the companion invocation itself fails;
- review the resulting diff after ZCode completes;
- wait in foreground or launch in background;
- choose or ask about fresh versus resume;
- retain or rejoin an existing child.

Tests must reproduce the original failure shape and prove that the authorized
objective contains the development task while excluding the stop/report policy.

## Entry Source and Routing

Invocation source is a structured enum with two values:

- `explicit`: the exact top-level prompt contains the applicable
  `$zcode:rescue` marker;
- `proactive`: Root selected Rescue for a request without that marker.

It is selected by Root, cross-checked against the recorded prompt marker, and
persisted in the prepared record with the exact caller turn. `explicit` requires
an applicable literal marker. `proactive` requires its absence. A mismatch fails
closed, preventing Root from silently bypassing explicit-command confirmation.
The child and companion do not guess source from task wording. Pending choice
records preserve the normalized invocation, source, and originating turn.

Routing precedence is:

1. If an active Rescue child already exists for the Root operation, rejoin only
   that exact child. Do not spawn or invoke again.
2. An explicit `--fresh` or `--resume` choice wins.
3. For an explicit entry with an eligible candidate and no choice, return the
   current `needs-choice` response and ask the user exactly once.
4. For a proactive entry, Root evaluates semantic relationship before prepare:
   clear continuation uses resume; clear independent work uses fresh; genuine
   ambiguity is resolved with one user question.
5. The companion still validates that a requested resume candidate exists and
   fails closed if private state no longer matches.

Automatic routing is therefore a Root orchestration capability, not a companion
heuristic. No `--auto` flag is needed. Root materializes its decision as the
existing `resume` option in the private preparation envelope before the child
runs.

## Single-hop Subagent Contract

The call graph remains:

```text
top-level Codex Root -> dedicated zcode-rescue child -> companion -> ZCode App
```

The dedicated child receives one constant assignment and invokes one constant
prepared-companion command. It never receives or interprets task text, never decides
fresh/resume, never inspects the repository independently, and never spawns
another agent. Ordinary Codex subagents remain forbidden from invoking Rescue.

An active child ID is retained as the sole continuation identity. Wait timeouts,
progress relays, status requests, early tool returns, and ordinary steering are
nonterminal and cannot authorize a second child or companion execution.

## Failure and Completion Semantics

Rescue is running until the original child execution reaches a terminal result
backed by the companion's existing lifecycle contract. A test failure, compiler
error, lint error, failed shell command, or tool exception observed inside an
active ZCode turn is not independently terminal. ZCode may inspect it, edit the
workspace, retry, or choose another approach across subsequent turns.

The plugin reports failure only when an authoritative boundary reports failure,
including companion startup/configuration errors, protocol errors, cancellation,
timeouts defined by the companion, lost execution ownership, or ZCode's terminal
failed completion. This design does not modify those boundaries.

## Data and Security Contracts

- Invocation source and normalized task are bound to exact session, turn, and
  canonical workspace identity.
- Task text retains the existing 64 KiB bound and private filesystem controls.
- Preparation stdin is visible only in the already-authorized Root rollout; it
  is forbidden from child rollouts, argv, environment, output, logs, artifacts,
  and progress. No capability, credential, job ID, session ID, or permission
  snapshot is introduced into model-visible text.
- Prepared records use restrictive directories, atomic writes, bounded counts,
  exact schemas, expiration, single consumption, and turn/session cleanup.
- Parser and record validation fail closed on unknown source values, extra
  fields, malformed records, expired turns, and mismatched executors.
- Shell-like text in a task remains inert data and is never evaluated by a
  shell during parsing or forwarding.

## Testing Strategy

TDD coverage will be added in layers:

1. Preparation-envelope tests for explicit/proactive source, complete task
   preservation, option precedence, malformed stdin, duplicate keys, size
   bounds, and control-policy exclusion.
2. Identity/invocation record tests for exact turn and executor ownership,
   pending-choice preservation, source cross-checking, expiry, cleanup, and
   replay safety.
3. Companion integration tests proving the fake ZCode peer receives only the
   intended authorized objective for both entry sources.
4. Skill-contract tests proving proactive Root routing is automatic when clear,
   explicit candidate routing still asks once, active children are rejoined,
   and ordinary/Rescue children cannot nest Rescue.
5. Installed-route and marketplace snapshot tests proving source and packaged
   plugin behavior remain synchronized.
6. Full lint, typecheck, unit/integration tests, qualified non-credentialed
   checks, and repository-required CI.

The regression fixture modeled on the incident must include a development task,
an embedded `$zcode:rescue`, and a Root-only instruction to stop/report if the
Rescue invocation fails. Its assertion must inspect the fake peer's authorized
objective, not merely CLI output.

## Compatibility and Migration

The public Rescue CLI grammar remains unchanged. Direct public CLI use continues
to parse its own argv. The installed Root/child path migrates to private prepare
plus `invoke-prepared`; an unprepared child invocation fails with an actionable
retry remedy. Existing pending-choice records continue to work. Private records
without the new source and preparation binding are rejected rather than guessed
from arbitrary task prose.

Marketplace artifacts must be regenerated or synchronized through the existing
repository workflow. Setup does not need a new user-facing option.

## Delivery

Implementation will use an isolated worktree, task-by-task TDD with fresh
subagents, a specification-compliance review followed by a code-quality review,
and fresh final verification. The feature branch will be pushed and delivered
as a pull request. Work is complete only when every required CI check on that PR
passes.
