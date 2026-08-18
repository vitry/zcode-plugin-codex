# Exact Rescue Child Session Binding Design

Status: approved for implementation on 2026-08-18

## Problem

Codex Root can keep using the same dedicated Rescue subagent across parent turns,
but the plugin currently cannot associate that child identity with the exact
ZCode session it created. Once the original child turn has stopped, Rescue falls
back to the latest eligible job owned by the Root session. That preserves legacy
usability, but it is not a safe definition of "continue the same subagent": a
different Rescue operation in the same Root session can become the latest job.

The forwarding subagent must not decide whether work is fresh or a continuation.
Root owns that semantic decision. The plugin must make Root's decision reliable
by persisting an exact, private association between the trusted Rescue executor
and the ZCode session-bearing job.

## Goals

- Make same-Root-session, same-Rescue-child continuation resume the exact ZCode
  session previously used by that child.
- Keep Root as the routing authority and the Rescue child as a task-blind,
  single-hop forwarder.
- Never identify an operation by task name, child display name, task text, job
  ordering, or "latest session" heuristics.
- Preserve active-child rejoin, proactive fresh/resume routing, explicit
  `--fresh`/`--resume`, and the existing legacy `needs-choice` flow.
- Upgrade a legacy unbound operation after one explicit, validated resume so
  later same-child continuations are exact.
- Preserve existing job records and public CLI compatibility.
- Fail closed on corrupt, dangling, mismatched, ambiguous, or unauthorized
  binding state.
- Keep installed plugin snapshots, qualification evidence, and documentation in
  lockstep with the source implementation.

## Non-goals

- Do not let the Rescue child infer fresh versus resume.
- Do not use `task_name`, agent path, task text, or latest-job ordering as a
  durable identity.
- Do not automatically continue a binding from a different Root session.
- Do not migrate or add optional fields to existing persisted job records.
- Do not expose agent IDs, job IDs, operation IDs, or ZCode session IDs in model
  prompts, child assignments, command arguments, progress, or status prose.
- Do not change ZCode's terminal lifecycle or classify project command failures
  such as `npm test` as Rescue failures.
- Do not add a public `--auto` flag or a new child-facing companion command.

## Chosen Architecture

The implementation adds a versioned private Rescue-operation binding. The
binding is partitioned by canonical workspace and keyed by the exact pair of
parent Codex session and trusted Rescue executor ID. It is stored separately
from jobs for backward compatibility, while publication and job reservation are
linearized by the existing StateStore lock.

The identity chain is:

```text
current trusted Rescue executor
  -> exact active operation binding
  -> anchor job
  -> authoritative persisted zcodeSessionId
```

The binding never copies the ZCode session ID. The anchor job remains the source
of truth for that value. A second `currentJobId` records the latest job created
for the operation so bound status can remain exact across parent turns without
changing the anchor used for resume.

The installed child continues to run the existing constant command:

```text
invoke-prepared rescue
```

On a later parent turn, Root prepares a `resume` envelope and sends the same
fixed assignment to the exact stopped Rescue child through `followup_task`.
There is no second spawn. SubagentStart refreshes the trusted executor record;
the companion consumes the new prepared envelope, resolves the binding, and
resumes the anchor job's exact ZCode session.

## Binding Record

Each record has an exact versioned schema:

```json
{
  "version": 1,
  "key": "sha256 binding key",
  "operationId": "random 256-bit generation",
  "state": "active",
  "parentSessionId": "root session",
  "executorAgentId": "trusted rescue child",
  "workspace": "canonical workspace",
  "permissionMode": "workspace-write",
  "anchorJobId": "job that owns the ZCode session",
  "currentJobId": "latest job in this operation",
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp",
  "closedAt": null,
  "closeReason": null
}
```

The key is derived from the version marker, parent session ID, executor agent ID,
and the already-partitioned canonical workspace. `operationId` is a random
generation token used for compare-and-swap updates and ABA protection. Closed
records are tombstones whose reason is `fresh`, `session-ended`, or
`invalidated`.

The storage uses the same private-directory, bounded-read, exact-schema,
symlink-resistant, atomic-write, and lock-identity controls as existing durable
state. Active bindings do not expire after 30 minutes: live authorization still
requires a fresh trusted executor record for the current parent turn, while the
durable binding must survive a long-running or terminal ZCode operation.

## Transaction Boundary

Binding mutation is part of StateStore's existing `.state.lock` transaction.
The public legacy `reserveJob` interface and job schema remain unchanged. New
deep Rescue-only operations atomically validate and publish both the prospective
job and binding state:

- reserve a fresh operation and replace the old generation;
- reserve an exact continuation and advance only `currentJobId`;
- adopt an explicitly validated legacy candidate and reserve its continuation;
- resolve the exact anchor/current jobs;
- close the exact generation for SessionEnd.

Binding publication must not occur as an independent post-reservation write.
Otherwise a crash could publish a job without its identity or overwrite a valid
old binding with a job that never acquires a ZCode session.

The anchor is stable for the operation. Continuation jobs may fail before or
after contacting ZCode without changing the exact session identity. Status reads
`currentJobId`; resume reads `anchorJobId`. Both jobs are revalidated against
the parent session, canonical workspace, Rescue command, and expected lifecycle.

## Routing Semantics

Routing precedence is:

1. An active Rescue child is rejoined through its existing live handle. Root
   does not prepare, spawn, or invoke another companion process.
2. For a stopped child that Root identifies as the same logical operation, Root
   materializes `resume` in a new private preparation and follows up the exact
   child. The plugin resolves only that child's binding.
3. An explicit `--fresh` or `--resume` remains authoritative.
4. An explicit legacy invocation with a candidate but no choice still returns
   `needs-choice`; Root asks once and uses the same child for `invoke-choice`.
5. A proactive clear continuation or independent task remains a Root decision,
   materialized respectively as `resume` or `fresh`; genuine ambiguity is asked
   before prepare/spawn/followup.

A bound same-child continuation must carry `resume`. The forwarder does not
silently reinterpret an omitted option. A bound `fresh` starts a new generation;
normal Root orchestration should use a new child for independent work, but the
runtime remains safe if an explicit fresh operation intentionally reuses the
same child.

When no binding exists, the existing legacy candidate behavior remains
available. A requested legacy resume must revalidate the exact selected job and
then atomically adopt it into the current child binding. Only a truly missing
binding may use this compatibility path. A present but invalid binding never
falls back to latest-job selection or `needs-choice`.

## Trusted Identity and Authorization

Every invocation still requires the hook-established Rescue executor to match:

- exact executor agent ID and Rescue role;
- exact current parent session and active parent turn;
- canonical workspace;
- current permission mode;
- executor freshness and active/continuation state required by the command.

Automatic exact continuation additionally requires the binding's parent
session, executor ID, workspace, and permission mode to match. A permission
change cannot silently inherit an older automatic authorization. An explicit
legacy resume may adopt the selected historical job under the current trusted
permission mode; subsequent automatic continuation must match that adopted
mode.

Neither preparation records nor pending-choice records carry the binding or
session identity in model-visible data. `invoke-prepared` and `invoke-choice`
pass the trusted executor only through internal runtime context.

## Lifecycle

- `SubagentStop` marks transient executor state inactive but preserves the
  durable operation binding.
- A new parent prompt refreshes turn identity and cleans old preparations, not
  operation bindings.
- Root Stop cleans the current preparation and turn identity, not the binding.
- Job success or failure preserves the binding because terminal ZCode sessions
  remain resumable.
- SessionEnd closes exact bindings for that parent session. Jobs remain durable
  for explicit history or job-ID workflows, but a new Root session cannot claim
  the old child binding automatically.
- Closed tombstones are retained for bounded cleanup rather than immediately
  deleted, preventing stale writers from recreating an earlier generation.

## Failure and Crash Semantics

- Binding missing: preserve the legacy candidate/choice path.
- Binding corrupt, duplicated, oversized, symlinked, identity-mismatched,
  permission-mismatched, or dangling: fixed task-free failure; never guess.
- Anchor without a persisted ZCode session: not resumable; never fall back to a
  different job.
- Cancelled anchor: not resumable.
- Fresh reservation crash: the new generation prevents automatic return to the
  old session.
- Continuation reservation crash: the stable anchor still identifies the exact
  session; current-job status may report the failed/queued continuation.
- Remote ZCode session creation before job persistence remains the existing
  broker/recovery boundary. Binding logic never reconstructs that session from
  ordering or prose.
- Stale writers update only their expected `operationId`; compare-and-swap
  rejects updates to a newer generation.

All errors remain bounded and contain no task, executor, job, operation, or
ZCode session identity.

## Compatibility and Upgrade

Existing job files remain byte/schema compatible. Older plugin versions ignore
the new binding directory and retain their historical behavior. After upgrade:

- old jobs without bindings continue through the existing explicit choice or
  clear proactive resume route;
- the first validated resume establishes the binding;
- later same-child continuations become exact;
- corrupt new binding state never masquerades as legacy absence;
- installed Role byte changes produce `upgrade-required`, and one
  `$zcode:setup` refreshes the managed Role.

The public Rescue CLI grammar is unchanged. Marketplace artifacts are regenerated
from a clean exact source commit and remain byte-identical for all critical
runtime, hook, skill, Role, and documentation files.

## Testing Strategy

TDD coverage is required at five layers:

1. Binding codec/store tests: exact key/schema, private storage, permission and
   identity mismatch, corruption, duplicate/oversized records, symlink and lock
   replacement, concurrent fresh/continue/adopt, operation-generation ABA,
   lifecycle closing, and Windows path/handle compatibility.
2. Runtime tests: executor propagation through `invoke-prepared` and
   `invoke-choice`, fresh binding, exact continuation, legacy choice/adoption,
   invalid-binding no-fallback, background jobs, current-job status, replay,
   sibling/workspace/session/permission attacks, and unchanged public CLI/jobs.
3. Skill/Role tests: active rejoin, stopped same-child followup with zero spawn,
   independent fresh spawn, explicit choice preservation, constant task-blind
   assignment, and no nested Rescue.
4. Qualification/E2E tests: named and generic forwarders across two parent turns,
   one child ID, exact ZCode `session/resume`, no `needs-choice` for a valid bound
   continuation, and fail-closed mutations.
5. Installed marketplace, release, lint, typecheck, full test, qualification,
   and CI checks.

The central regression fixture must create two eligible jobs in one Root session
and prove that continuing the first Rescue child resumes its bound ZCode session,
not the later job.
