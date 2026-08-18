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
There is no second spawn and, on Codex 0.147, no second SubagentStart event.
The original executor record remains stopped and retains its original parent
turn. The companion uses a restricted stopped-continuation authorization path:
it requires that exact stopped executor, a fresh preparation bound to the new
active parent turn, and a durable operation binding whose parent session,
executor, canonical workspace, and permission all match. It does not rewrite or
pretend to refresh the old executor record. Only after all three independent
pieces of private evidence agree may it resume the anchor job's exact ZCode
session.

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
  "executorAgentType": "zcode-rescue",
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
and the already-partitioned canonical workspace. Records are stored beneath a
hashed parent-session directory so one abandoned session cannot consume another
session's capacity. `operationId` is a random
generation token used for compare-and-swap updates and ABA protection. Closed
records are tombstones whose reason is `fresh`, `session-ended`, or
`invalidated`.

The storage uses the same private-directory, bounded-read, exact-schema,
symlink-resistant, atomic-write, and lock-identity controls as existing durable
state. Active bindings do not expire after 30 minutes. Initial invocation and
legacy choice retain the existing executor TTL. Exact bound continuation uses a
narrow durable-provenance rule: the original executor record must still exist,
be structurally valid, carry the approved role, and be stopped, but its age does
not invalidate a matching binding. The binding preserves and cross-checks that
original agent type. A fresh preparation for the current parent turn and the
exact binding are also mandatory. Thus long-running and terminal operations
remain continuable without making expired unbound executors usable. Ordinary
executor resolution no longer deletes expired provenance; SessionEnd remains its
authority cleanup boundary.

## Transaction Boundary

Binding mutation and job reservation are serialized by StateStore's existing
`.state.lock` transaction.
The public legacy `reserveJob` interface and job schema remain unchanged. New
deep Rescue-only operations validate and serialize publication of the
prospective job and binding state:

- reserve a fresh operation and replace the old generation;
- reserve an exact continuation and advance only `currentJobId`;
- adopt an explicitly validated legacy candidate and reserve its continuation;
- resolve the exact anchor/current jobs;
- close the exact generation for SessionEnd.

The filesystem cannot atomically publish multiple files, so each route has an
explicit safe publication order:

- Fresh publishes a new binding generation pointing to the prospective job
  first, then publishes owner binding, canonical job, and index marker. A crash
  may leave a dangling new generation that fails closed; it can never return to
  the discarded old session automatically.
- Continuation publishes owner binding, canonical job, and index marker first,
  then CAS-advances `currentJobId`. A crash may leave an extra job and stale
  status, but the old binding and anchor remain safe and resumable.
- Legacy adoption first publishes a binding whose anchor/current both identify
  the explicitly chosen candidate, then publishes the continuation job, then
  CAS-advances current. A crash can establish the chosen exact identity without
  ever substituting a different candidate.

Tests assert that partial states are safe and recoverable or fail closed, not
that multi-file publication is physically atomic.

The anchor is stable for the operation. Continuation jobs may fail before or
after contacting ZCode without changing the exact session identity. Status reads
`currentJobId`; resume reads `anchorJobId`. Both jobs are revalidated against
the parent session, canonical workspace, Rescue command, and expected lifecycle.

## Routing Semantics

Routing precedence is:

1. An active Rescue child is rejoined through its existing live handle. Root
   does not prepare, spawn, or invoke another companion process.
2. An explicit `--fresh` or `--resume` remains authoritative.
3. Any explicit invocation with a bound or legacy candidate but no choice still
   returns `needs-choice`; Root asks once and uses the same child for
   `invoke-choice`.
4. For a proactive request where a stopped child is clearly the same logical
   operation, Root materializes `resume` in a new private preparation and
   follows up the exact child. The plugin resolves only that child's binding.
5. Other proactive clear continuation or independent-task routes remain a Root decision,
   materialized respectively as `resume` or `fresh`; genuine ambiguity is asked
   before prepare/spawn/followup.

A bound same-child continuation must carry `resume`. The forwarder does not
silently reinterpret an omitted option. A bound `fresh` starts a new generation;
normal Root orchestration should use a new child for independent work, but the
runtime remains safe if an explicit fresh operation intentionally reuses the
same child.

When no binding exists, the existing legacy candidate behavior remains
available. When presenting `needs-choice`, the companion persists the exact
candidate job ID and a fixed route kind in the private, executor-bound,
single-use pending record; it never emits that identity to the child or Root
rollout. For a bound candidate it also snapshots the expected `operationId`. A
bound snapshot also records `expectedCurrentJobId`, because ordinary continuation
advances current without changing the operation generation. A requested resume
consumes that record and either CAS-continues the same bound generation/current
pair or, for a still-missing legacy slot, revalidates and adopts precisely the
selected candidate. A later job cannot replace the presented candidate, and a
fresh or continued operation created while the answer is pending invalidates the
stale choice rather than changing its meaning.
Pending records created by an older plugin version without an exact candidate
cannot safely resume after upgrade and fail with an instruction to rerun the
explicit command; a fresh choice remains safe. Only a truly missing binding may
enter this compatibility path. A present but invalid binding never falls back to
latest-job selection or `needs-choice`.

## Trusted Identity and Authorization

An initial prepared invocation still requires the hook-established active Rescue
executor to match:

- exact executor agent ID and Rescue role;
- exact current parent session and active parent turn;
- canonical workspace;
- current permission mode;
- executor freshness and active state required by the command.

A same-child prepared continuation does not require or fabricate a new
SubagentStart. It instead requires the exact original executor record to be
stopped and structurally valid, with matching parent session, canonical
workspace, role, and permission. Its historical `parentTurnId` and creation time
remain unchanged; only this exact bound path may accept provenance older than
the ordinary 30-minute executor TTL. Authorization
for the new parent turn comes exclusively from the newly stored preparation,
which must match the current active caller and can be consumed only by that
executor ID, plus the exact durable binding. Missing any one of these proofs
fails before candidate selection or job reservation.

Automatic exact continuation additionally requires the binding's parent
session, executor ID, workspace, and permission mode to match. A permission
change cannot silently inherit an older automatic authorization. An explicit
legacy resume may adopt the selected historical job under the current trusted
permission mode; subsequent automatic continuation must match that adopted
mode.

A structurally valid same-slot binding with an older permission mode blocks
resume, but does not block a newly authorized `fresh` preparation. Fresh inherits
no old ZCode authority, so it may replace that generation under the current
trusted permission. Structural corruption, workspace/session/executor mismatch,
or ambiguous records still fail closed even for fresh.

Neither preparation records nor pending-choice records carry the binding or
session identity in model-visible data. The private pending-choice record may
carry the exact candidate job ID solely to prevent candidate substitution.
`invoke-prepared` and `invoke-choice` pass trusted identity only through internal
runtime context.

`invoke-choice` remains a separate narrow stopped-executor authorization path.
Legacy choices require the same parent session/workspace/executor, the unexpired
stopped executor record, and the single-use pending record from the originating
turn and permission snapshot. A bound choice may use the same durable stopped
provenance exception as prepared continuation, but only while its private
expected generation and candidate still match. Neither form requires the
stopped executor's historical parent turn to equal the new active parent turn;
the pending record is the authority for that one continuation. This exception
does not authorize any other prepared invocation.

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

Binding enumeration is capped at 1,024 child slots per parent session, with one
extra entry read only to detect overflow. Closed tombstones become GC-eligible
after 30 days; active records are never age-GCed. Before creating a new slot in
that session partition, StateStore validates the bounded set and removes
eligible closed tombstones under `.state.lock`; if the session capacity remains
full it fails without publication. Corrupt siblings in the same session fail
closed and cannot be deleted by ordinary GC. SessionEnd may report an advisory
close failure, but removal of session/executor authority still prevents that
binding from being used, and an abandoned session cannot consume capacity in a
new or sibling session.

## Failure and Crash Semantics

- Binding missing: preserve the legacy candidate/choice path.
- Binding corrupt, duplicated, oversized, symlinked, identity-mismatched, or
  dangling: fixed task-free failure; never guess. Permission mismatch rejects
  resume but an otherwise valid same-slot generation may be replaced by an
  authorized fresh route.
- Anchor without a persisted ZCode session: not resumable; never fall back to a
  different job.
- Cancelled anchor: not resumable.
- Fresh reservation crash: the new generation prevents automatic return to the
  old session.
- Continuation reservation crash: the stable anchor still identifies the exact
  session; current-job status may remain stale or report the failed/queued
  continuation depending on the completed publication point.
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
   lifecycle closing, per-session 1,024-entry capacity, over-limit rejection,
   30-day closed tombstone GC, active-never-GC, sibling-session isolation, and
   Windows path/handle compatibility.
2. Runtime tests: executor propagation through `invoke-prepared` and
   `invoke-choice`, fresh binding, exact continuation, immutable private
   candidate/generation selection across an intervening later job or fresh
   generation, legacy choice/adoption, greater-than-30-minute bound continuation,
   invalid-binding no-fallback, background jobs, current-job status, replay,
   sibling/workspace/session/permission attacks, and unchanged public CLI/jobs.
3. Skill/Role tests: active rejoin, stopped same-child followup with zero spawn,
   independent fresh spawn, explicit choice preservation, constant task-blind
   assignment, and no nested Rescue.
4. Qualification/E2E tests: named and generic forwarders across two parent turns,
   one original SubagentStart, one SubagentStop, no second SubagentStart, one
   child ID, exact ZCode `session/resume`, no `needs-choice` for a valid proactive
   bound continuation, explicit no-option `needs-choice`, and fail-closed
   mutations. A forged refresh or historical-turn rewrite must be rejected.
5. Installed marketplace, release, lint, typecheck, full test, qualification,
   and CI checks.

The central regression fixture must create two eligible jobs in one Root session
and prove that continuing the first Rescue child resumes its bound ZCode session,
not the later job.
