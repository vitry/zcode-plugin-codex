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

## Rejected alternative

A bundled stdio MCP server would provide structured arguments, and current
plugin documentation permits Skills and MCP servers in one package. It was not
selected because the documented bundled-MCP contract does not expose trusted
per-call Codex thread and turn identity. A long-lived MCP startup environment is
not a caller identity, and placing identity or a secret in model-supplied tool
arguments recreates the authorization flaw. MCP can be reconsidered only after
an installed-plugin E2E demonstrates trusted per-call identity metadata.

## Consequences

The plugin manifest must explicitly declare its native hooks. Integration tests
must install the marketplace snapshot, discover the Skill through real Codex
app-server, execute the installed hook, and call the installed companion through
ordinary stdio. Tests cover absent and mismatched thread identity, two sessions
in one workspace, pending-choice replay, shell metacharacters in tasks, and
production-owned background launch. An opt-in authenticated `codex exec` E2E is
the final model-driven proof; environments without authentication, credits, or a
configured model report unqualified rather than passing.
