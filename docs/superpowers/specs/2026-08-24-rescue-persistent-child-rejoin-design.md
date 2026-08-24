# Rescue Persistent Child Rejoin Design

## Goal

Make Rescue continuation follow Codex native subagent semantics: ending the
Codex runtime, restarting the plugin, or resuming the Root thread must not
destroy a valid completed Rescue operation. A later Root follow-up must be
able to rejoin the exact child and continue the exact persisted ZCode session.

Explicit cancellation, fresh replacement, invalidation, and corrupt or
ambiguous state remain permanently non-resumable.

## Current problem

Rescue already persists a binding containing the parent session, child
identity, canonical execution workspace, anchor/current jobs, operation ID,
and the ZCode session through the job record. However, `SessionEnd` currently
closes the binding with `closeReason: "session-ended"`. Resume then rejects the
closed binding before route planning, even when Codex has resumed the same Root
thread and the child/job/session records remain valid.

The implementation therefore conflates runtime disappearance with explicit
operation revocation.

## Semantics

The lifecycle has four distinct states:

1. **Resident**: the child runtime is loaded and can receive follow-up input.
2. **Unloaded but resumable**: the runtime is gone, but the exact child
   identity, workspace, job, and ZCode session are persisted and can be
   rejoined.
3. **Completed but resumable**: the previous job is terminal, while its
   operation binding remains active for a later follow-up.
4. **Revoked**: explicit `cancel`, explicit `fresh` replacement, explicit
   invalidation, or invalid/corrupt/ambiguous state permanently prevents
   continuation.

`SessionEnd`, plugin replacement, process restart, and Root resume are runtime
events, not revocation events. They must preserve resumability. An active
remote job may still be stopped or settled by the existing orphan-safety
logic; that operational cleanup must not silently convert a valid completed
binding into an explicit revocation.

## Rejoin flow

For a continuation request, the companion must:

1. Resolve the canonical execution workspace and exact Root session.
2. Discover the exact persisted Codex child by parent thread, child ID, agent
   path, and approved Role.
3. Validate the durable binding and its anchor/current jobs.
4. Validate that the original ZCode session ID is present and resumable.
5. If the child runtime is absent, restore the child runtime from persisted
   Codex history; do not spawn a replacement child.
6. Send the continuation through the existing private prepared envelope and
   resume the original ZCode session.

The child-facing assignment remains the constant `invoke-prepared rescue`;
private task and binding data never cross the Root-to-child message boundary.

## Legacy migration

Migration is lazy and exact. A closed binding may be reopened only when all of
the following hold:

- `state === "closed"` and `closeReason === "session-ended"`;
- the requested Root session ID exactly matches the binding owner;
- the canonical workspace and binding key match;
- the exact child ID/path/Role is present in persisted Codex child state;
- anchor/current jobs are structurally valid and the original ZCode session is
  present;
- no later fresh replacement, cancel, or invalidation superseded the binding;
- the transition occurs under the state lock with an atomic compare-and-swap.

Any failed condition keeps the binding closed and fails closed. The migration
must not reopen bindings closed for `fresh`, `cancel`, or `invalidated`.

## Fresh and cancellation

`fresh` creates an independent operation and ZCode session. The previous
operation is marked closed/superseded so one child/workspace cannot have two
unqualified writable current operations. `cancel` remains permanent. Neither
action deletes the workspace or the historical job/result artifacts.

## Testing requirements

The regression suite must prove:

- a completed operation survives SessionEnd and resumes its original ZCode
  session;
- a legacy `session-ended` closed binding migrates exactly once;
- fresh/cancel/invalidation closed bindings never migrate;
- child runtime absence causes rejoin from persisted identity, not spawn;
- workspace, Root session, child, Role, job, or ZCode session mismatches fail
  closed without mutation;
- active-job SessionEnd still preserves existing orphan and writable-exclusion
  safety;
- multiple child bindings remain isolated and one child lifecycle does not
  close siblings;
- existing launcher secrecy and private-envelope contracts remain unchanged.

## Non-goals

This change does not redesign the ZCode protocol, change the child-facing
launcher command, remove workspace canonicalization, permit latest-session
fallback, or make explicit cancellation reversible.
