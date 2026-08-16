# Rescue Live Progress Relay Design

Status: approved in conversational design; awaiting written-spec review

This design amends the progress-source, parent-nonrelay, forwarder authority,
and status portions of
`2026-08-15-rescue-forwarder-progress-compatibility-design.md` and
`2026-08-09-rescue-native-subagent-progress-design.md`. It preserves their
hook-bound executor identity, one foreground Rescue execution, same-child
choice continuation, accepted-turn result, cancellation, ownership, worker
lease, orphan recovery, dynamic display naming, and final-stdout contracts.

## Problem and Diagnostic Evidence

Foreground Rescue does not provide the observable progress expected from the
reference `codex-plugin-cc` implementation. The selected Rescue child and the
parent commonly show only a heartbeat or `ZCode started the delegated turn.`
The parent can then mistake a quiet child for a stopped delegation and cease
waiting even though the original companion process and ZCode turn remain live.

Deterministic tests and owner-scoped persisted state prove two independent
causes:

1. The plugin already maps `state.updated` and `v4/conversation/frame` input to
   semantic progress and writes it to foreground stderr, but the installed
   Rescue contract and qualification deliberately reject any child stderr or
   intermediate progress that reaches a parent-visible event.
2. A real subscribed run acknowledged the conversation subscription and
   received at least 255 frames, but accepted only one online frame. The
   bounded `sequence` and `row-kind` rejection counters both saturated at 255,
   while the durable preview remained at the startup line. The current strict
   frame interpreter is therefore incompatible with normal observed ZCode
   traffic even when subscription succeeds.

The absence of progress is not evidence that ZCode stopped, and a heartbeat is
not a terminal result.

## Reference Alignment

The reference `../codex-plugin-cc` uses a thin Rescue subagent that runs one
foreground Bash command. Its companion:

- consumes structured app-server lifecycle events rather than guessing from
  arbitrary agent prose;
- maps turn, item, tool, edit, verification, error, and completion events into
  progress records;
- writes foreground progress to stderr;
- persists phase and a bounded progress preview for status;
- reserves stdout for the final rendered result; and
- treats the foreground command exit status as the host-visible completion
  boundary.

Claude Code displays nested Bash activity while the Agent invocation remains
active. Codex does not reliably project a child `exec_command` stream through
`wait_agent`, so exact stderr-only copying would preserve the current user
failure. This design aligns the companion behavior and adds a Codex-specific,
bounded child-to-parent liveness relay.

The reference Rescue subagent forbids independent status polling. This design
intentionally adds a narrower Codex-only status sidecar because Codex does not
provide the same nested Bash visibility. The sidecar is bound to the current
trusted Rescue executor and cannot select a job supplied by the model.

## Goals

- Make real ZCode activity visible inside the selected Rescue child with
  cc-style semantic progress.
- Give the top-level parent bounded, fixed progress and liveness updates so it
  continues waiting for the same child and foreground execution.
- Accept normal observed conversation traffic without letting unknown row
  kinds or sequence gaps suppress all later safe progress.
- Preserve pure final stdout and terminal-exit completion semantics.
- Permit the Rescue child to read a safe snapshot of only its currently bound
  Rescue job through one exact companion command.
- Keep progress and status observational: neither can claim success, failure,
  completion, cancellation, or permission.
- Qualify named and generic routes, same-child resume/fresh continuation,
  installed behavior, privacy, failure isolation, and marketplace parity.

## Non-goals

- Do not expose a raw PTY. ZCode runs through the app-server JSON protocol, not
  a user-facing terminal stream.
- Do not relay raw ZCode frames, stderr diagnostics, tool output, file contents,
  environment values, assistant drafts, reasoning, permissions, credentials,
  capabilities, or authorization records.
- Do not infer progress by parsing arbitrary natural-language agent output.
- Do not let progress or status replace the original foreground execution
  handle, final session snapshot, exit code, or stdout.
- Do not allow the child to choose a job ID, list jobs, fetch results, cancel,
  start a second Rescue turn, or inspect another session or workspace.
- Do not make optional progress delivery a prerequisite for a successful
  Rescue result.
- Do not change explicit background Rescue control through public
  `$zcode:status`, `$zcode:result`, and `$zcode:cancel`.

## Chosen Architecture

The implementation has five independently testable units:

1. **Compatible event interpreter** converts structurally valid ZCode lifecycle
   and conversation events into bounded semantic progress.
2. **Progress reporter** writes child-local detail to stderr, persists bounded
   owner status, and emits a separate fixed coarse relay record.
3. **Rescue forwarder relay** observes only the original foreground execution,
   forwards validated coarse relay records to `/root`, and continues polling
   the same execution handle.
4. **Root waiting contract** treats relay records as liveness only and waits for
   the exact original child's terminal result.
5. **Bound status sidecar** exposes a safe snapshot of the exact job selected
   from hook-bound executor state rather than model input.

```text
ZCode app-server notification
        |
        v
compatible event interpreter
        |
        +--> detailed safe stderr --> selected Rescue child
        |
        +--> phase + last four events --> durable owner status
        |
        +--> fixed coarse relay record --> child send_message --> /root
                                                        |
                                                        v
                                              keep same child active

original foreground handle exits
        |
        v
validated final session/read -> durable terminal job -> final stdout -> root
```

Writing all progress to stdout was rejected because it would multiplex
intermediate frames with the final result and `needs-choice` response. Relying
only on stderr was rejected because it reproduces the Codex host visibility
failure. Parent polling alone was rejected because it is delayed, creates
avoidable sidecar processes, and does not make the selected child transcript
behave like the reference foreground Bash call.

## Compatible Event Interpretation

### Lifecycle events

Validated same-session `state.updated` events retain their current fixed
mappings for start, generation, tool activity, retry, and terminal lifecycle.
Unknown bounded reasons produce only the fixed generic activity message. Their
payloads are never rendered.

`prompt_completed` and `prompt_failed` remain revision-guarded remote terminal
signals. Progress mapping does not change their authoritative completion role.

### Conversation frames

Envelope, wire version, topic, subscription ID, identifiers, timestamps, and
bounded collection sizes remain fail-closed. Once the envelope is valid, row
compatibility follows the reference app-server strategy:

- known row kinds are interpreted independently;
- unknown row kinds are ignored rather than rejecting the complete frame;
- duplicate or stale logical frames are ignored;
- a sequence gap increments a bounded diagnostic and requests recovery, but it
  does not permanently block later independently safe lifecycle or known-row
  progress;
- recovery delivery may replace the observational row watermark without
  changing accepted-turn or completion state; and
- per-row and per-tool lifecycle deduplication emits at most one meaningful
  start and one terminal event.

The observer is deliberately tolerant because progress is observational and
all rendered output is companion-owned. A malformed envelope, foreign topic,
foreign subscription, unsafe identifier, oversized value, invalid known row,
or unbounded collection remains rejected without rendering content.

### Child-local detail

Child-local stderr retains the established cc-aligned mappings: turn lifecycle,
tool category and status, verification/edit phases, and existing validated
bounded command or query previews. Existing control removal, length limits,
path containment, row bounds, and privacy exclusions remain in force.

Unknown tools may use only a validated bounded tool label. Unknown rows never
produce a guessed description. Assistant prose and reasoning may be retained in
private result/log handling where already authorized, but never become progress
through this pipeline.

## Parent Relay Protocol

The progress reporter produces a second relay representation after a semantic
event has passed validation. A relay record has the exact logical shape:

```text
{
  version: 1,
  sequence: positive bounded integer,
  phase: starting | investigating | editing | verifying | running | waiting | finalizing,
  code: fixed allowlisted progress code,
  observedAt: RFC3339 timestamp
}
```

The record contains no free-form message and no task, command, query, tool
argument, path, identifier, job/session/workspace value, result, or error text.
The companion serializes it with a dedicated fixed prefix on stderr so it
cannot be confused with ordinary diagnostics or detailed `[zcode]` lines.

The Rescue child may relay only a structurally valid record with the expected
version, increasing sequence, allowlisted phase/code, and valid timestamp. It
maps the code to a fixed parent message owned by the installed Role/skill and
sends that message to the canonical top-level `/root` task. Rescue is restricted
to top-level invocation, so `/root` is the only permitted relay target.

The installed Role uses the native `send_message` collaboration tool when that
tool is present in its active schema. The generic route receives the same fixed
relay instructions. If the active child schema lacks `send_message`, relay
degrades to child-local stderr and durable status without changing execution;
the Role must not imitate relay through final responses or arbitrary tools.

The child never relays arbitrary stderr, detailed `[zcode]` messages, stdout,
tool output, or malformed records. Repeated identical phases are coalesced. A
20-second heartbeat relay is allowed when no newer semantic activity exists.
Relay failure is observational and does not stop polling the original handle.

The parent accepts progress only from the exact `rescueChildId` it spawned. It
may show the fixed message and updates its waiting rationale, but it must not
interpret the message as terminal evidence, change ownership, run a companion
command, or spawn another child. Steering and wait timeouts continue to rejoin
the same child.

## Foreground Execution and Completion

The Rescue child starts exactly one foreground `invoke rescue` or approved
same-child `invoke-choice` execution. A returned running/session handle is
nonterminal, and every continuation polls only that handle.

Completion has three layers:

1. A later revision `prompt_completed` or `prompt_failed` notification releases
   the remote wait.
2. The companion performs the authoritative final `session/read`, validates the
   exact accepted input boundary, extracts the final assistant result, writes
   the result artifact, and atomically transitions the job terminal.
3. The original foreground process exits and returns final public stdout.

Success requires `job.status = succeeded`, durable `exitCode = 0`, original
foreground exit code 0, and valid final stdout. Failure produces a terminal job
and nonzero original foreground exit. Exit code 3 plus an exact `needs-choice`
response is terminal only for the current child turn and is neither job success
nor failure; the parent asks once and resumes the same child.

Progress, heartbeat, status `succeeded`, child idleness, absence of output, and
outer wait completion never replace the original foreground terminal evidence.
If the child disappears without that evidence, the outcome is interrupted or
unknown and existing recovery applies.

## Bound Rescue Status Sidecar

The direct companion adds exactly:

```text
node "<canonical-plugin-root>/scripts/zcode-companion.mjs" invoke-status rescue
```

It accepts no extra positionals or options. It resolves the ambient child thread
through `resolveForwardingExecutor`, then selects exactly one current job bound
to that executor's parent session, parent turn, canonical workspace, and Rescue
command. Ambiguous, missing, expired, sibling, stopped-without-pending, foreign-
workspace, or terminally unrelated binding fails closed.

The response contains only:

- public job status;
- coarse phase;
- last activity timestamp;
- up to four already-safe progress preview lines;
- whether the original foreground job is terminal; and
- the existing fixed status remedy where applicable.

It omits job ID, ZCode session ID, owner IDs, workspace, PID, worker lease,
artifacts, prompt, result, errors, permissions, capabilities, and raw probe
state. The command is read-only and never creates or connects a new ZCode turn.

The Role and generic forwarder explicitly permit this one short-lived sidecar
between polls or after a user enters the Rescue child and asks for status. The
only user-facing status spellings accepted by the forwarder are exact trimmed
`zcode status`, `$zcode:status`, and `/zcode:status`, with no argument or option.
They all map to the same constant `invoke-status rescue` command; the model
never constructs argv from the user's text. Any suffix, job reference, option,
or different control command remains rejected.

While the original foreground handle is live, a status request displays the
short sidecar result in the selected child and then resumes polling that exact
handle; it must not produce a final child response. After the original handle
is terminal, the existing final-result path remains authoritative. The sidecar
is not counted as a second Rescue execution. It cannot replace, terminate, or
detach the original foreground handle. Ordinary `status`, `--all`, job
references, `result`, `cancel`, and a second `invoke rescue` remain forbidden.

## Failure and Cancellation Semantics

- Unsupported or malformed progress is dropped or degraded without changing
  the authoritative Rescue result.
- Relay serialization, child relay, parent display, stderr, preview, and status
  failures are observational and bounded.
- A stalled relay does not imply a stalled ZCode turn; heartbeat and status are
  informational only.
- Original foreground interruption retains existing signal handling,
  acknowledged remote stop, cancellation guard, worker lease, and orphan
  settlement.
- Parent steering never implicitly cancels the child or ZCode turn.
- Terminal cleanup stops subscriptions and relay production before bounded
  drain; late records cannot mutate terminal state or appear after final stdout.
- The status sidecar cannot signal, cancel, resume, retry, or create work.
- No relay or sidecar error may obscure a valid terminal stdout or change its
  exit code.

## Testing Strategy

Implementation follows red-green-refactor. Required tests include:

1. **Observed-traffic regression:** a sanitized structural fixture reproduces
   the real sequence and unknown-row rejection burst. The old observer emits no
   useful progress; the new observer ignores unknown rows, survives gaps, and
   continues known-row progress with bounded counters.
2. **Interpreter privacy:** foreign topics/subscriptions, malformed envelopes,
   unsafe IDs, huge strings/collections, invalid known rows, prose, reasoning,
   tool output, file contents, environment values, capabilities, and raw frame
   sentinels never cross any sink.
3. **Reference semantics:** turn/item/tool/edit/verification/wait/finalizing
   transitions produce cc-aligned child-local stderr, phase persistence, and a
   bounded four-line preview while stdout remains empty until terminal result.
4. **Relay contract:** only valid increasing coarse records from the original
   foreground handle cause exact child-to-`/root` messages. Detailed stderr,
   stdout, malformed records, duplicates, reordered records, private canaries,
   sibling output, and post-terminal output are rejected.
5. **Root behavior:** progress and heartbeat keep the same child wait active;
   neither can cause success/failure, a second spawn, a parent companion call,
   or a terminal response. Only the qualified original exit and final stdout
   complete foreground Rescue.
6. **Status sidecar:** named and generic children resolve only their exact bound
   job. No argument form exists for another job/workspace/session; ambiguous and
   forged identity fails; the sidecar performs no ZCode request and leaves the
   foreground handle running.
7. **Choice continuation:** initial and resume/fresh turns preserve one child,
   one original foreground handle per approved turn, monotonic relay sequences,
   exact exit-3 choice handling, and no sidecar authority drift.
8. **Failure isolation:** closed stderr, failed persistence, failed relay,
   unavailable collaboration delivery, sidecar failure, subscription failure,
   and incompatible frames leave successful final result and exit unchanged.
9. **Installed qualification:** named and generic installed flows hold a real
   foreground process beyond the first yield, observe child-local semantic
   output plus at least one parent relay, optionally read bound status, prove
   same-handle polling and terminal exit, and verify no orphan.
10. **Packaging:** canonical Role, generic skill, marketplace mirrors, English
    and Chinese documentation, changelog, source contracts, and SHA-pinned
    marketplace snapshot remain exact.

Authenticated/credit-spending qualification remains opt-in, but deterministic
installed source, captured rollout, fake-protocol, and process-lifecycle tests
must exercise every call site and failure boundary in default CI.

## Delivery

This is a dedicated follow-up branch from the merged Rescue progress and
dynamic naming work. Delivery uses subagent-driven implementation with
independent spec and standards review. All Critical and Important findings are
fixed and re-reviewed. Completion requires focused tests, full `npm run check`,
exact marketplace mirror/build parity, clean worktree, a pull request, and all
required CI checks passing.

The task is not complete when code is implemented, locally green, committed,
pushed, or merely submitted for review. The terminal acceptance condition is an
opened pull request whose required CI checks have all completed successfully.
