# ZCode for Codex

This context describes how Codex users delegate work to ZCode while Codex remains the user-facing host.

## Language

**Codex Host**:
The Codex session that receives the user's request and owns orchestration and result presentation.
_Avoid_: Caller, frontend

**Rescue Child**:
The Codex Host child agent that invokes and supervises one Rescue interaction with the ZCode Engine.
_Avoid_: ZCode child, engine process

**ZCode Engine**:
The external coding agent to which the Codex Host delegates review or task work.
_Avoid_: Backend, subagent

**Skill**:
A Codex-native reusable workflow invoked explicitly with a `$zcode:<skill>` name or selected automatically from its description.
_Avoid_: Command, slash command

**Companion Run**:
One invocation of ZCode initiated by a Skill, producing either review findings or task output.
_Avoid_: Command execution, request

**Foreground Companion Run**:
A Companion Run for which the Codex Host keeps the initiating interaction attached until a terminal result or interruption.
_Avoid_: Wait mode, synchronous job

**Host-managed Companion Run**:
A Companion Run whose live execution and observation remain owned by a Codex Host Rescue Child, whether that child is placed in the foreground or background.
_Avoid_: Plugin worker job, detached execution

**Session-bound Background Run**:
A Companion Run that may outlive its initiating interaction but not its owning Codex Host session. The Host SessionEnd Boundary ends its authority to continue.
_Avoid_: Durable detached job, independent background run

**Host SessionEnd Boundary**:
The lifecycle boundary explicitly reported by the Codex Host when it ends or unloads the owning session. It is distinct from a completed turn, child error, usage limit, or context compaction.
_Avoid_: Genuine SessionEnd, logout signal, child termination

**Host Lifecycle Epoch**:
One loaded lifetime of a Codex Host session between SessionStart and SessionEnd, identified privately so work authorized before a resume cannot be confused with work authorized after it.
_Avoid_: Codex session, turn, login session

**SessionEnd Receipt**:
The first bounded durable record of a Host SessionEnd Boundary for one Host Lifecycle Epoch. It authorizes later exact stop reconciliation but is not proof that any turn stopped.
_Avoid_: Cancellation acknowledgement, cleanup result, job stop intent

**Resumable Companion Session**:
A preserved ZCode session and binding whose active turn has stopped. It retains conversation history for a later explicitly authorized turn but has no authority to execute across a Host SessionEnd Boundary.
_Avoid_: Suspended run, durable background job, automatic continuation

**Explicit Run Cancellation**:
A user-authorized stop of one exact Companion Run. It ends the current turn without deleting its Resumable Companion Session; any later turn requires new explicit authorization and the same exact binding proof.
_Avoid_: Session deletion, binding revocation, pause

**Stop Cause**:
The structured reason attached to a cancelled Companion Run, such as `user`, `session-end`, or `host-coordination-loss`. It explains one shared terminal status without creating parallel terminal state machines.
_Avoid_: Job status, error message

**Resumability Indicator**:
A public `status` or `result` field stating whether an exact preserved binding currently permits a later authorized turn. It may provide a user-level Rescue instruction but never exposes the internal ZCode session ID or resumes automatically.
_Avoid_: Resume authorization, session identifier

**Rescue Lifecycle Reconciler**:
The deep module that joins validated Host child observation, executor route, exact binding and current job, worker lease, and ZCode turn evidence; it owns lifecycle ordering and races and returns one bounded public outcome to its callers.
_Avoid_: Lifecycle helper, state wrapper, status classifier

**Host Coordination Loss**:
Loss of the Codex Host's ability to supervise a nonterminal Companion Run without an observed Host SessionEnd Boundary, such as a Rescue Child usage limit, crash, or missing lifecycle hook.
_Avoid_: ZCode failure, SessionEnd

**Durable Stop Intent**:
A persisted lifecycle decision that one exact Companion Run is no longer authorized to continue, retained until cancellation or another authoritative terminal outcome is proven.
_Avoid_: Cancelled status, timeout, process kill

**Writable Guard**:
The exclusive claim that prevents another writable Rescue from entering the same workspace while an earlier writer may still be active.
_Avoid_: Lock file, job ownership

**Engine Terminal Failure**:
A terminal unsuccessful result reported by the ZCode Engine for its own turn, including a ZCode provider usage limit.
_Avoid_: Host coordination loss, Codex usage limit

**Tracked Job**:
A persisted record of a Companion Run, including its ownership, lifecycle state, progress, and stored result.
_Avoid_: Process, thread

**Completion Notice**:
A concise Codex Host message announcing a background Companion Run's authoritative terminal outcome while leaving the complete stored output to Result.
_Avoid_: Full result, next-prompt reminder

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
