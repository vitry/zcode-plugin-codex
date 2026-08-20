# Rescue Forwarder and Progress Compatibility Design

Status: proposed for maintainer review

This design amends the hook-input, forwarder-completion, and progress-source
portions of `2026-08-09-rescue-native-subagent-progress-design.md`. It explicitly
supersedes the earlier no-`session/read`-polling non-goal only for the bounded
compatibility fallback defined here. Existing ownership, result, cancellation,
permission, accepted-turn, and parent-nonrelay contracts remain unchanged.

## Problem

Real Codex 0.147 and ZCode 0.16.3 runs exposed three independent failures in
the Rescue path:

1. Codex adds `agent_id` and `agent_type` to `UserPromptSubmit` input for a
   subagent, while the plugin's exact hook-input schema rejects those fields.
   Every Rescue child turn therefore reports a failed prompt hook.
2. A long companion command can yield an execution handle before the command
   exits. The managed Rescue Role can mistake the yielded output for the final
   result, finish the child turn, and leave the companion running after the
   trusted child executor has stopped.
3. A successful `v4/conversation/subscribe` acknowledgement does not guarantee
   usable online frames. In observed ZCode 0.16.3 runs, real tool calls occurred
   while the durable preview remained at `ZCode started the delegated turn.`
   ZCode's own diagnostics reported v4 hydration and telemetry normalization
   failures, but those internal implementation failures are outside this
   repository's control.

The plugin must remain useful when the installed ZCode produces compatible
conversation frames, incompatible frames, or no frames. The fix must not
require changes to ZCode and must not expose raw protocol data, reasoning, tool
output, file contents, credentials, or authorization material.

## Goals

- Accept the documented Codex 0.147 subagent prompt-hook shape without minting
  a parent caller capability from a forwarding child.
- Keep the Rescue child alive until its one companion command reaches a real
  terminal result.
- Distinguish compatible frames, rejected frames, and silent subscriptions at
  the plugin protocol boundary using bounded structural diagnostics.
- Preserve semantic progress through a bounded `session/read` snapshot fallback
  when online frames are absent or unusable.
- Keep progress observational: compatibility failures must not change job
  ownership, permissions, accepted-turn completion, cancellation, results, or
  exit status.
- Qualify the behavior with real long-running native-subagent execution as well
  as deterministic fake-protocol tests.

## Non-goals

- Do not modify, patch, or depend on private implementation changes in ZCode.
- Do not parse ZCode log files or model-I/O artifacts.
- Do not relay continuous child progress into the parent model context.
- Do not expose arbitrary assistant text, reasoning, raw tool input/output,
  environment values, or raw protocol objects as progress.
- Do not turn progress compatibility into a prerequisite for successful Rescue
  completion.
- Do not add retry, polling, cancellation, or result interpretation authority
  to the parent Codex agent.

## Chosen Approach

Use a plugin-owned compatibility pipeline with three independently testable
boundaries:

1. **Hook classification** recognizes subagent prompt input and returns neutral
   output before caller identity creation.
2. **Forwarder completion** treats yielded execution as nonterminal and follows
   only the original execution handle until the command exits.
3. **Progress compatibility** probes structural protocol facts, normalizes
   compatible frames, and falls back to bounded session snapshots when semantic
   frames are unavailable.

This approach keeps all remediation inside the plugin. Parsing ZCode logs was
rejected because logs are not a stable protocol, may be disabled or relocated,
and can contain information that is not safe for progress output. Treating a
subscribe acknowledgement as proof of health was rejected because it is the
behavior that produced the silent failure. Heartbeats alone were rejected as
the final behavior because they prove liveness but do not explain real tool
activity.

## Hook Classification

`UserPromptSubmit` accepts optional `agent_id` and `agent_type` fields matching
the Codex 0.147 wire schema. The fields must either both be absent or both be
valid bounded identifiers.

When both fields are present, the hook treats the input as a subagent prompt and
returns `{}` without calling caller-turn creation, workspace fingerprinting, or
unread-job notification. `SubagentStart` remains the only event that binds a
Rescue child to its exact parent turn and Role. A child prompt can therefore
neither replace the parent's active turn nor create a caller credential.

Ordinary parent prompts retain the existing exact schema, session ownership
check, caller-turn creation, optional gate baseline, and unread-job context.
Unknown fields still fail closed.

## Forwarder Completion Contract

The managed Role still runs exactly one constant companion command for an
initial invocation or one approved same-child continuation. Its authority does
not expand.

The Role instructions additionally define terminal completion:

- a result with an exit code is terminal;
- a result containing a running execution/session handle is nonterminal;
- the child must poll only that same handle with the host's continuation tool;
- partial stdout, stderr, heartbeat text, or an outer code-cell completion is
  never a terminal companion result; and
- the child returns only after the original command exits, preserving public
  stdout verbatim under the existing Rescue contract.

The generic compatibility forwarder receives the same completion contract.
Setup upgrades the managed Role digest through the existing ownership and drift
checks. No parent retry or second child spawn is introduced.

## Progress Compatibility Pipeline

### Structural probe

The existing authenticated client observes notifications before semantic
description. A bounded probe records only counters and fixed classifications:

- subscription acknowledged;
- conversation frame received;
- initial, online, or recovery delivery;
- accepted frame;
- rejected frame by a fixed reason code such as wire version, envelope shape,
  sequence, topic, row kind, or row shape; and
- snapshot fallback active or unavailable.

The probe never stores raw frames, identifiers from frame content, previews,
commands, paths, reasoning, tool output, or validation exception text. Counter
storage is bounded per job. Public diagnostics use fixed strings; detailed
counter state is available only through existing owner-scoped status JSON.

The conversation describer changes from silent `null` rejection to an internal
fixed rejection result. Valid-frame behavior and all existing public bounds stay
unchanged.

### ZCode 0.16.3 complete-frame compatibility

The structural boundary accepts wire-version-3 complete frames with the exact
outer topic and subscription binding. A bounded protocol-version-1 snapshot may
arrive as an initial frame, an online overflow reset, or a recovery frame. Its
session identity, log epoch, sequence, revision, and bounded 60-row window are
validated, but its historical rows are never replayed or interpreted. The
snapshot silently replaces the observational sequence and lifecycle baseline.

Delta payloads follow ZCode 0.16.3's exclusive sequence baseline and accept at
most 500 operations within the one-MiB complete-frame bound. The supported
operations are `row.appended`, `row.upserted`, `row.removed`, `row.delta`, and
`state.updated`. Only exact, allowlisted `toolCall` and `turnHeader` rows from
append/upsert operations may produce public events. Removal updates local
deduplication state silently; row text appends and state patches are bounded,
validated, and ignored. No snapshot, patch, text append, unknown row, assistant
draft, tool output, or historical terminal row is rendered. Public event fanout
remains capped at 64 per frame and tracked lifecycle state at 256 rows.

After any accepted baseline, a normal online delta must have the next logical
ordinal and `fromSeq` exactly equal to the last accepted `toSeq`. Overlapping
replays and ordinal or sequence gaps are rejected before applying operations;
the rejected frame does not advance either trusted watermark. Further online
deltas remain fenced until a valid recovery delivery or a bounded authoritative
snapshot establishes a new baseline. An online overflow snapshot may reset from
sequence zero while fenced.

A delta recovery is valid only when its range covers the last trusted sequence:
`fromSeq` is no greater than the trusted `toSeq`, and its new `toSeq` does not
move backward. A recovery range that begins after the trusted sequence leaves a
hole, is rejected without advancing either watermark, and keeps recovery
fencing active. An equal-sequence empty recovery remains a valid no-op baseline.

Fragment frames remain unsupported. Their rejection is observational and uses
the existing bounded session-snapshot fallback; it cannot affect authoritative
completion, cancellation, or result handling.

### Compatibility state

Each foreground Rescue progress reporter has one of four observational states:

- `probing`: subscription may still produce a usable online frame;
- `online`: at least one usable online frame has been accepted;
- `snapshot-fallback`: no usable semantic frame was available by the first
  heartbeat boundary, or a bounded rejected-frame threshold was reached; or
- `lifecycle-only`: both semantic frames and snapshot fallback are unavailable.

Initial snapshots do not switch the reporter to `online` because historical
activity must not suppress fallback for the current turn. Once an online frame
is accepted, snapshot polling stops. State changes do not affect the
authoritative completion wait.

### Bounded session snapshot fallback

At the first heartbeat boundary with no accepted online frame, the reporter
reads the same session through the existing authenticated client. While fallback
is active, it repeats at most once per heartbeat interval. Only one read may be
in flight, and a read that has not settled is not duplicated.

Snapshot processing uses the existing schema-validated session response and the
accepted current-turn boundary. It ignores messages that existed before send
and data unrelated to the accepted input. A small state map deduplicates tool
call identities and emits the same allowlisted start/terminal descriptions used
by online frames. It never emits assistant prose, reasoning, tool output, file
contents, arbitrary input objects, or historical activity.

If the supported session snapshot cannot represent a tool's in-progress state,
the fallback may emit a terminal observation when it first becomes visible; it
must not invent a start time or status. Snapshot state and deduplication retain
the existing row/tool count bounds.

A snapshot read or normalization failure emits one fixed diagnostic, transitions
to `lifecycle-only`, and preserves the heartbeat and authoritative result wait.
There is no retry faster than the heartbeat interval.

## User-visible Behavior

The parent continues to show native child lifecycle and the terminal Rescue
result only. Detailed progress remains in the selected Rescue child and the
owner-scoped durable preview.

The child can show one fixed compatibility diagnostic before normal progress:

- `ZCode conversation frames were unavailable; using bounded session progress.`
- `ZCode semantic progress is unavailable; lifecycle updates will continue.`

These messages describe capability, not task success or failure. Command and
query previews remain control-free and bounded under the existing policy.

A `needs-choice` companion response remains intentionally terminal for the
current child turn and retains exit code 3 semantics. It is not confused with a
yielded running execution because it contains a complete public response and a
real exit code.

## Failure and Cancellation Semantics

- Hook classification fails closed on malformed or half-present child identity.
- A yielded command remains owned by the original child; child completion cannot
  precede companion exit.
- Parent wait timeout or steering never creates a second child or command.
- SIGINT, SIGTERM, explicit cancellation, SessionEnd, and orphan recovery retain
  their current acknowledged-stop and worker-lease behavior.
- Probe, frame description, snapshot reads, and progress sinks are
  observational. Their failure cannot overwrite a terminal job or result.
- Terminal completion stops heartbeat, online observation, and snapshot polling,
  then drains bounded progress work under the existing cleanup deadline.

## Testing

Implementation follows red-green-refactor and adds these tracer-level tests:

1. A real Codex 0.147-shaped subagent `UserPromptSubmit` succeeds neutrally and
   leaves the exact parent active turn unchanged; malformed identity fails.
2. A managed Role qualification fixture runs longer than the host's initial
   execution yield, emits heartbeats, and proves that the child does not complete
   until the same command exits. Initial and choice continuation use the same
   child.
3. Protocol tests distinguish no frames, accepted frames, malformed frames, and
   rejected-frame bursts without persisting raw payloads.
4. Snapshot fallback starts only after the first heartbeat without an accepted
   online frame, emits bounded deduplicated tool progress, stops after online
   recovery, and degrades safely when reads fail.
5. Existing result, cancellation, ownership, permission, heartbeat, durable
   preview, subscription cleanup, and parent-nonrelay tests remain green.
6. Installed-plugin E2E runs a real long Rescue and verifies that the selected
   child remains active until companion termination and shows either semantic
   progress or one explicit degraded diagnostic rather than silent startup-only
   state.

## Delivery Boundaries

The work is delivered as independent tracer bullets:

1. subagent prompt-hook compatibility;
2. same-execution forwarder completion;
3. bounded structural progress probing; and
4. session snapshot fallback driven by probe state.

The first three can land independently. Snapshot fallback depends on the probe
state and rejection classifications. Release documentation describes the
fallback and clarifies that ZCode log files are never consumed.
