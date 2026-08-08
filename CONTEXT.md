# ZCode for Codex

This context describes how Codex users delegate work to ZCode while Codex remains the user-facing host.

## Language

**Codex Host**:
The Codex session that receives the user's request and owns orchestration and result presentation.
_Avoid_: Caller, frontend

**ZCode Engine**:
The external coding agent to which the Codex Host delegates review or task work.
_Avoid_: Backend, subagent

**Skill**:
A Codex-native reusable workflow invoked explicitly with a `$zcode:<skill>` name or selected automatically from its description.
_Avoid_: Command, slash command

**Companion Run**:
One invocation of ZCode initiated by a Skill, producing either review findings or task output.
_Avoid_: Command execution, request

**Tracked Job**:
A persisted record of a Companion Run, including its ownership, lifecycle state, progress, and stored result.
_Avoid_: Process, thread

**Orphaned Job**:
A nonterminal Tracked Job whose exact worker-lifetime lease is no longer held, proving that its local executor has disappeared.
_Avoid_: Stale job, dead session

**Lifecycle Maintenance Principal**:
Internal authority derived only from a validated Orphaned Job's original owner and used to settle that job without transferring user-visible ownership.
_Avoid_: Impersonated owner, adopted owner

**Review**:
A read-only Companion Run that evaluates repository changes and returns findings without modifying the workspace.
_Avoid_: Audit

**Rescue**:
A delegated Companion Run in which ZCode investigates or changes the workspace to pursue a requested outcome.
_Avoid_: Task, fix

**Transfer**:
A handoff that creates a new ZCode session containing the ordered user and assistant turns converted from the current Codex conversation.
_Avoid_: Session clone, seeded prompt

**Headless Permission Policy**:
The rule by which the Codex Host answers ZCode operation requests when no person is attached to ZCode's permission prompt.
_Avoid_: Sandbox, auto-approval

**Caller Context**:
An opaque, turn-scoped capability created by a Codex hook that lets a Skill prove
its originating Codex session, turn, workspace, and permission mode to the
companion runtime.
_Avoid_: Current session marker, thread environment
