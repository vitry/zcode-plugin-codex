---
status: accepted
supersedes: caller-capability-through-model-and-fd
amended: 2026-08-20; 2026-08-21
---

# Use a thread-bound direct companion for installed Skills

Codex CLI 0.146 was observed to propagate `CODEX_THREAD_ID` from an actual Codex
turn into ordinary shell-tool child processes. The value is treated as a
version-pinned runtime dependency, not as an officially stable field. Native
`UserPromptSubmit` hooks already receive the exact `session_id`, `turn_id`,
workspace, permission mode, and original prompt, so they write a private
active-turn record keyed by the exact session and canonical workspace. A Skill
runs only a constant direct-companion command. The companion combines ambient
`CODEX_THREAD_ID` with the current canonical workspace to resolve that exact
record and fails closed when the variable or matching record is absent,
malformed, expired, or inconsistent.

This supersedes the original caller-capability path. That design placed a secret
in hook `additionalContext` and required the model to create file descriptors 3
and 4 for the companion. Normal Codex Skills can request ordinary shell commands
but cannot construct arbitrary protected child descriptors, so the production
path was not callable even though a test harness could synthesize those FDs.
Secrets must not be entrusted to the model or command line.

Original command arguments and Rescue task text come from the private hook
record and are parsed by Node; they are never interpolated into shell syntax.
When interaction is required, the companion persists one normalized pending
invocation bound to the exact session/workspace/turn. A later turn can atomically
consume it only through a fixed wait/background/resume/fresh enum action.
Background workers remain capability-bound, but production Node creates,
transports, starts, and reaps them without a Codex subagent or model seeing the
capability.

This background-worker ownership paragraph is superseded for new normal Rescue runs by [ADR 0018](0018-use-host-managed-session-bound-execution.md). Historical detached jobs retain compatibility and reconciliation requirements, but the normal session-bound background path is owned by the Codex Host Rescue Child.

For native Rescue subagents on qualified Codex 0.147, shell commands observe the
child thread ID in `CODEX_THREAD_ID`, not the parent ID. `SubagentStart` records
that child `agent_id` together with its parent session, child turn, Role,
canonical workspace, and the exact parent active-turn and permission snapshot
that existed at spawn. Initial Rescue invocation requires exactly one active
approved record and the same still-active parent snapshot. Codex emits
`SubagentStop` after the child's first final response and does not emit another
`SubagentStart` for `followup_task`, so choice continuation consumes the stopped
executor record bound into pending state, within the same TTL. Parent-direct,
sibling, stale/missing stop, missing, ambiguous,
expired, corrupt, and wrong-workspace callers fail closed. The answer may arrive
in a later parent turn; execution still restores the originating turn and
permission snapshot. Codex 0.147 reports every role-less generic child only as
`agent_type: "default"`; this cannot distinguish the intended forwarder from a
general sibling and therefore is not the named Role identity guarantee. The
approved generic compatibility contract instead relies on the host-issued child
ID, fixed fresh-context assignment and command mapping, one-spawn/unique-active
checks, cooperative agent behavior, and the private pending record bound to that
same stopped executor ID. Both routes may persist and atomically consume one
interactive choice. This is an integrity check inside the existing private
`0700` same-UID trust boundary, not a claim that environment variables or local
files are cryptographically unforgeable by a hostile process running as that
UID.

## Rescue launcher amendment (2026-08-20)

The statement above that every Skill runs a direct-companion command is amended
for Rescue by the
[Rescue root-provenance diagnostics design](../superpowers/specs/2026-08-19-rescue-root-provenance-diagnostics-design.md).
Rescue now receives one machine-rendered, instance-bound launcher command from
the owned parent `UserPromptSubmit` lifecycle context. Root and the Rescue child
reuse those exact bytes; they do not derive the companion path from cwd, PATH, a
source checkout, or another installed cache entry.

The launcher accepts only the fixed Rescue argv shapes in its allowlist and
imports the companion relative to its own module. In the same process it
dispatches those validated arguments to the companion; it does not create an
additional process hop or authorization boundary. Consequently, the original
single-hop trust model remains preserved: the one ordinary shell-tool child
still presents its ambient `CODEX_THREAD_ID`, and the companion still resolves
and authorizes the exact private active-turn record for the canonical workspace.
The launcher selects the plugin instance; it neither supplies caller identity
nor bypasses the private thread-bound authorization described by this decision.

All earlier rationale about keeping secrets out of model-visible commands,
binding child identity through native lifecycle hooks, and failing closed is
retained. Only Rescue command-location selection is superseded: the model no
longer constructs or directly invokes `scripts/zcode-companion.mjs`.

## Rescue worktree late-binding amendment (2026-08-21)

The active parent turn now distinguishes its trusted origin workspace from one optional execution workspace. The first trusted prepare automatically binds an immutable target for the turn, without manual handoff. A different target is eligible only when it is an exact canonical linked-worktree top level with the same canonical Git common-dir as the origin workspace. Role inspection remains read-only and a child cannot claim or redirect this authority.

SubagentStart and SubagentStop may continue to arrive at the origin workspace. A generation-bound private route points to executor storage in the execution workspace, where preparation, job, binding, broker, and peer state remain isolated. Root Stop, a new prompt, and SessionEnd revoke or replace authority before advisory cleanup. This deepens the existing thread-bound active-turn semantic; it does not create a second handoff authority or weaken the launcher boundary.

## Rejected alternative

A bundled stdio MCP server would provide structured arguments, and current
plugin documentation permits Skills and MCP servers in one package. It was not
selected because the documented bundled-MCP contract does not expose trusted
per-call Codex thread and turn identity. A long-lived MCP startup environment is
not a caller identity, and placing identity or a secret in model-supplied tool
arguments recreates the authorization flaw. MCP can be reconsidered only after
an installed-plugin E2E demonstrates trusted per-call identity metadata.

## Consequences

Codex auto-discovers native hooks at the default `hooks/hooks.json` path, so the
optional plugin-manifest hook override is omitted. Integration tests must install
the marketplace snapshot, prove discovery through real Codex app-server, execute
the installed hook, and call the installed companion through ordinary stdio.
Tests cover absent and mismatched thread identity, two sessions in one workspace,
pending-choice replay, shell metacharacters in tasks, and production-owned
background launch. An opt-in authenticated `codex exec` E2E is the final
model-driven proof; environments without authentication, credits, or a
configured model report unqualified rather than passing.
