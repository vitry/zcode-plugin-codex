---
status: accepted
supersedes: caller-capability-through-model-and-fd
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

For native Rescue subagents on qualified Codex 0.147, shell commands observe the
child thread ID in `CODEX_THREAD_ID`, not the parent ID. `SubagentStart` records
that child `agent_id` together with its parent session, child turn, Role,
canonical workspace, and the exact parent active-turn and permission snapshot
that existed at spawn. Initial Rescue invocation requires exactly one active
approved record and the same still-active parent snapshot. Codex emits
`SubagentStop` after the child's first final response and does not emit another
`SubagentStart` for `followup_task`, so named `zcode-rescue` choice continuation
instead consumes the stopped executor record bound into pending state, within
the same TTL. Parent-direct, sibling, stale/missing stop, missing, ambiguous,
expired, corrupt, and wrong-workspace callers fail closed. The answer may arrive
in a later parent turn; execution still restores the originating turn and
permission snapshot. Codex 0.147 reports every role-less generic child only as
`agent_type: "default"`; this cannot distinguish the intended forwarder from a
general sibling. The compatibility route may perform one initial invocation
under the exact active parent turn, but it cannot persist or consume an
interactive choice. A generic `needs-choice` response instructs the user to make
a new original Rescue request with an explicit `--resume` or `--fresh`. This is
an integrity check inside the existing private `0700` same-UID trust boundary,
not a claim that environment variables or local files are cryptographically
unforgeable by a hostile process running as that UID.

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
