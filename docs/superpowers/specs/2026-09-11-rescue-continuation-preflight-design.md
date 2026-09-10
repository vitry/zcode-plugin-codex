# Parent-scoped Rescue continuation preflight

## Problem

A new Codex Host session can read an existing project's progress and interpret
"continue T1" as resuming an old Rescue operation. The current Skill asks the Host
to choose `resume` before Companion exposes whether the current parent owns any
continuation evidence. Preparation then rejects the request with
`RESCUE_BINDING_INVALID`. Project continuity and operation identity are distinct.

## Decision

Extend the existing owned-parent `role-status rescue` preflight, when Role readiness
is `ready`, with a bounded advisory `continuation` observation:

```json
{"type":"role-status","role":"zcode-rescue","status":"ready","continuation":{"state":"none"}}
```

The closed state vocabulary is `none`, `present`, and `blocked`:

- `none`: inspection proves no continuation evidence for the current authenticated
  parent in the requested canonical execution workspace. Other parents' histories
  do not count. Valid legacy evidence must not accidentally look like absence.
- `present`: current-parent continuation evidence exists. This is NOT proof that
  any child is stopped or that a particular operation is resumable. Retained exact
  selection and existing preparation authorization remain required.
- `blocked`: evidence is unreadable, malformed, partial, inconsistent, or cannot be
  inspected safely. Inspection failure must never be converted into `none`.

The observation exposes no private parent/child/job/session identifiers, paths,
credentials, binding contents, or routes. Role readiness stays separate from this
advisory. Non-ready Role responses preserve their existing status/remedy behavior.

## Routing contract

1. An already active exact Rescue Child is still rejoined before preflight.
2. For new preparation, perform Role preflight before choosing an inferred mode.
3. With `none`, a request to continue project work without an explicit operation
   constraint chooses `fresh` with a null target, preserving the worktree and task
   progress. Do not ask the user to approve "not resuming" a nonexistent operation.
4. With `present`, retain the existing exact-child selection, ambiguity and
   preparation rules. Missing retained identity is not repaired by guessing.
5. With `blocked` or a missing/invalid observation, do not infer `fresh` from absence.
   Report the unavailable observation for inferred continuation. Never rewrite or
   repair private records in this preflight.
6. Explicit `--resume`, explicit same-operation requirements, and explicit `--fresh`
   remain authoritative. `none` does not authorize replacing an explicitly requested
   resume with fresh; explain the lack of current-parent continuity instead.
7. An explicitly independent/fresh operation keeps existing spawn authorization and
   writable guards. Advisory evidence never grants activation authority. Preparation
   revalidates current state, so preflight cannot bypass races or stale observations.

## Scope and non-goals

Use the existing trusted launcher and owned-parent identity path. Inspect the
execution workspace through existing preview validation for linked worktrees; do
not bind/consume a caller turn during preflight. Keep observation reads local and
nonmutating (no job/binding/route writes, migrations, ZCode RPC, or spawned child).
Do not adopt operations across parents, delete stale records, weaken executor
stopped checks, change model settings, or redesign lifecycle reconciliation.

## Acceptance evidence

- A new parent with only another parent's project history observes `none`.
- Same-parent evidence observes `present`, including valid legacy continuity where
  applicable; multiple siblings do not falsely authorize an arbitrary selection.
- Invalid/incomplete records or read failures observe `blocked`, never `none`.
- Linked-worktree preview inspects the target without changing turn ownership.
- Role preflight leaves binding/job/route data unchanged and starts no ZCode process.
- Explicit resume/fresh semantics and strict prepare authorization remain covered.
- Skill routing tests cover new-parent project continuation versus same-operation
  continuation, including unavailable advisory data.

This fixes routing guidance. It does not claim to reproduce or repair the earlier
`EXECUTOR_STATE_MISMATCH` incident, whose exact historical state was not captured.
