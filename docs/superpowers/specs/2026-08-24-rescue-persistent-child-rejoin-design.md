# Rescue Persistent Child Rejoin Design (sol/medium revision)

## Goal

Match native Codex child semantics: Root `SessionEnd`, companion/plugin
restart, app-server/broker restart, and Root resume remove runtime residency
but do not revoke a valid child operation. A later active Root turn may follow
the same persisted child thread and resume the same persisted ZCode session.
No replacement child or ZCode session may be selected by name, path, latest
job, or timestamp.

This feature does not make explicit cancellation, invalidation, or an explicit
same-child fresh replacement reversible. Missing, corrupt, contradictory, or
temporarily unverifiable evidence fails closed without writing a revocation.

## Orthogonal state dimensions

These dimensions are independent; they are not one four-state enum.

| Dimension | Values | Meaning |
| --- | --- | --- |
| Binding | `active`; legacy `closed/session-ended`; revoked `cancel`, `invalidated`, or same-child `fresh` superseded | Durable operation authorization. Only the legacy session-ended value is migration-eligible. |
| Codex residency | `resident`; `notLoaded`; `missing`; `contradictory` | Host runtime state. `resident` can be followed up directly; `notLoaded` is lazily reloaded from the same persisted thread. |
| Job | `queued`; `running`; `cancelling`; `succeeded`; `failed`; `cancelled` | Attempt state. Exact anchor/current validation defines which combinations are resumable. |

The binding remains resumable for a valid resident or notLoaded exact child
when its anchor contains a non-empty ZCode session ID and the current attempt
is not explicitly cancelled. Orphan settlement may turn an abandoned attempt
into `failed` without revoking the binding. A cancelled current attempt is
revoked. `running`/`cancelling` attempts retain existing stop/lease safety
and must not be guessed resumable after an unacknowledged stop.

## Ownership and SessionEnd

`SessionEnd` removes active Root-turn/runtime authority, consumes or cleans
preparation capabilities, performs bounded writable-job settlement, and
conditionally releases broker ownership. It does not change durable job
ownership or valid binding records. A later Root turn must establish fresh
active caller authority for the same persisted parent session before rejoin.
Timeout or partial cleanup is handled by existing orphan/lease safety; it is
not converted into binding revocation.

The plugin retains the conservative one-active-writable-job-per-canonical-
workspace rule. It is independent of child lifecycle: a writable conflict or
failed remote stop must not close, migrate, supersede, or advance either
sibling binding.

## Exact child-scoped mapping

The binding slot is:

`(parentSessionId, childAgentId, canonicalExecutionWorkspace)`

It additionally fixes child authority: kind, approved Role/type, exact
persisted `agent_path` for modern `subagent-start`, or legacy path digest and
origin/execution provenance for adoption, plus operation ID, anchor/current
job IDs, permission, and supersession history.

`anchorJobId -> zcodeSessionId` selects the original ZCode session.
`currentJobId` is the exact CAS generation/current attempt; it is not the
source of the ZCode session. No value may be inferred from latest-job order.

Multiple child slots may coexist. Fresh on child B leaves child A byte-identical
and resumable. Fresh on child A must CAS against A's exact operation/anchor/
current snapshot and retain a bounded durable `fresh` supersession record for
A only. A stale competing writer fails without changing siblings.

## Native Codex rejoin contract

Exact-parent child discovery is required. The child must have the same
persisted thread ID and `thread_spawn` parent; top-level and nested Role/path
metadata must agree; duplicate IDs/paths or contradictory active state fail
closed. `notLoaded` children are accepted for lazy reload of that same thread.
Rejoin sends the existing fixed `invoke-prepared rescue` assignment and causes
follow-up on the original thread; it never calls `spawn_agent` or emits a new
`SubagentStart`.

Resident children are eligible for direct follow-up. Executor cleanup after
SessionEnd may remove Hook route records, so modern v3 binding authority is
also sufficient to validate the exact persisted child path; legacy adoption
is a compatibility-only path.

## Lazy migration and atomic reservation

Migration lookup is read-only and may return a validated closed tombstone. It
does not publish an active binding. Only continuation reservation may consume
the proof. The proof includes a digest of the complete validated tombstone, not
only selected identity fields. Under one state lock, reservation re-reads and
compares that digest and the exact binding, parent, child, path/Role,
permission, operation, anchor/current IDs, and supersession state; then
validates local ZCode ID presence and atomically publishes the continuation job
plus a v3 active successor binding. Two consumers of one proof yield at most
one publication; the loser fails stale with no mutation.

Actual remote resumability is proven by `session/resume` for exactly the
anchor's ZCode session before sending work. If it rejects, returns a mismatched
session/workspace, or broker access is unavailable, the new attempt is failed
without fallback to `session/create`, another session, or another child. The
closed legacy tombstone remains closed (or an exact rollback restores the
pre-reservation snapshot, including its original v1/v2/v3 schema, under CAS).
Rollback metadata is a private field of the queued job published before the
active successor binding under the same state lock; job-spec is not its source
of truth. It is removed when remote resume commits the job to `running`, and it
must never enter public or child-facing output. Preparation, capability
delivery, launch failure, worker death, orphan settlement, and ordinary queued
`$zcode:cancel` must all restore an eligible migrated tombstone before
terminalizing the queued attempt.

Every newly published writable Rescue job also fixes a private reservation
class (`bound` or `unbound`) in both the canonical job and its independently
published owner binding. The owner binding is published first. Queued-to-
running and queued-to-terminal transitions compare both records under the
state lock. Thus deleting a migration marker and its child binding cannot turn
a bound attempt into an ordinary unbound job; missing or contradictory class
evidence fails closed. Historical records that predate this class remain
eligible only when their exact persisted child binding or rollback evidence
proves the transition—absence alone is deliberately not guessed.

Migration requires: closed + `session-ended`; exact canonical workspace and
parent; exact persisted child ID/thread/path/Role; valid anchor/current jobs;
non-empty original ZCode ID; no cancel/invalidation/fresh supersession; and
state-lock CAS. V1/V2 historical records remain readable under historical
validation. New/replaced records use binding schema v3 with exact modern path
authority and bounded same-child supersession records.

`session-ended` tombstones are resumability state, not ordinary revoked
history. Age- or capacity-based garbage collection must retain them. Only
explicitly revoked tombstones may be collected under the existing bounded
history policy.

## Revocation rules

- Exact durable cancellation of the current bound job closes only that child
  operation with `cancel`. A stop failure or unacknowledged stop is not cancel.
- Explicit invalidation closes only the exact child/operation under operation
  CAS.
- Same-child fresh replacement records `fresh` supersession for only the old
  operation. Fresh on a different child does not close siblings.
- Repeated close with a different operation/reason fails stale/closed; it never
  reopens an operation.

## Acceptance matrix

Tests must cover every mutation and no-mutation outcome for:

- resident and notLoaded modern child rejoin, same child ID/path/Role, zero
  spawn and exact `session/resume`;
- legacy session-ended migration, repeated read-only proof lookup, competing
  reservations, complete-proof mutation, v1/v2-to-v3 upgrade, exact historical
  rollback, and remote-resume failure with closed-tombstone preservation;
- background preparation, capability delivery, launch, worker-crash, orphan,
  and queued-cancel rollback, plus age/capacity retention of session-ended
  tombstones;
- cancel current job, invalidation, same-child fresh, sibling fresh, orphan
  settlement, failed/unacknowledged stop, and child-scoped close;
- mismatched origin/execution workspace, parent, child ID/thread, exact path or
  digest, Role/kind, permission, operation, anchor/current job, and ZCode ID;
- duplicate IDs/paths, unknown schema, duplicate JSON keys, oversized history,
  symlink/path or lock replacement, pagination/unsupported parent filtering,
  malformed host metadata, and transient discovery failure;
- same-process and cross-process writable races, preserving sibling bytes and
  `WRITABLE_JOB_EXISTS` semantics;
- source/marketplace byte identity, installed package snapshots, private
  envelope secrecy, and qualified native Codex evidence. Skipped or
  unauthenticated qualification is not acceptance evidence.

## Non-goals

Do not redesign the ZCode protocol, remove writable exclusion, allow latest
session fallback, infer authority from collisions, or make explicit cancel,
invalidation, or same-child fresh supersession reversible.
