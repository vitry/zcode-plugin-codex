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
published owner binding. The owner binding is published first. Before any
prompt artifact or ZCode session/configuration RPC, execution compares the job,
owner binding, child binding, rollback/origin proof, permission snapshot, and
worker lease under the state lock, then publishes a private worker-bound
execution claim. A revoke that commits before this claim prevents execution; a
revoke after it does not retroactively withdraw that one already-authorized
attempt, but the closed binding remains unavailable to every later follow-up.
For background execution, the pre-claim job-spec is a v2 authenticated,
capability-encrypted envelope. Its public structure contains only exact
job/owner/workspace binding, a capability-keyed commitment, and cryptographic
metadata; it contains no plaintext task, focus, prompt, model, or resume
payload and no unkeyed plaintext-derived digest that permits offline guessing.
The worker authenticates this exact sealed envelope and consumes a capability
explicitly bound to `sealed-v2`, but decrypts and validates the normalized spec
in memory only after the atomic execution claim succeeds. Unknown versions and
non-exact outer schemas fail closed. Newly reserved jobs never persist a
plaintext spec. Version-1 plaintext job-specs remain readable only with their
exact six-field outer schema and an older untyped or explicitly `legacy-v1`
capability carrying the exact normalized-spec digest. An untyped capability is
not sufficient by itself: the locked StateStore classification must also prove
an exact classless owner-v1 reservation or one exact markerless migration
rollback. A modern `sealed-v2` capability or modern reservation without that
historical proof cannot be downgraded by replacing its file. Queued
cancel/recovery classifies a v2 record from durable job/binding state without
decrypting its task payload.
Every modern writable Rescue reservation requires this claim before
queued-to-running. The advancing caller must explicitly submit both its PID
and lease (inherited persisted values are not arguments); both must match the
job and claim exactly. The transition then clears the claim. Queued/running
cancellation, queued terminalization, and orphan recovery also clear it while
preserving the first committed `cancel`, `invalidated`, or `session-ended`
tombstone instead of overwriting its close reason. The claim, continuation
origin, and migration rollback marker are removed only by the same locked
commit that enters `running` or a terminal state. A crash before that commit
leaves the evidence available for an idempotent retry.

The production claim path and every direct queued transition use the same
classification rules. Thus deleting a migration marker and its child binding
cannot turn a bound attempt into an ordinary unbound job; missing,
contradictory, or ambiguous reservation, origin, rollback, binding, permission,
PID, lease, or claim evidence fails closed. No execution claim, prompt artifact,
plaintext task/prompt publication, sealed-payload decryption, job-spec rewrite,
or remote RPC may occur before this classification succeeds. A pre-claim v2
sealed-envelope publication is permitted because it exposes no task artifact
or guessable plaintext commitment and remains format-bound to the single-use
execution capability.

Historical writable records that predate reservation classes are compatible
only when the canonical job omits the class and its exact owner binding has the
legacy v1 format. A classless owner-v1 job may be ordinary unbound, or may be
bound by complete and exact historical v1/v2 child evidence. Production
execution upgrades that authority only by publishing a private v2 execution
claim under the state lock. A classless owner-v1 job associated with any v3
child binding fails closed, whether it appears as a continuation, adoption,
migration, fresh/ordinary reservation, production claim, or direct transition.
The existence or absence of one field is never enough to infer the class.

An old adoption publication remnant whose binding was not advanced is
terminal-only. It is recognized only when its private origin reconstructs one
complete, exact prior binding and the anchor, current job, permission snapshot,
child ID/path/Role authority, timestamps, operation, and supersession history
all agree with the persisted partition. It may then be cancelled or failed
while leaving the prior binding byte-identical; it may never run. Corrupt or
multiple matches fail closed. Likewise, markerless legacy migration inspection
is read-only until one unique complete v1/v2 tombstone and queued successor are
proven. Missing job-spec data, absent migration fields, v3 ambiguity, or any
contradiction fails before publishing a rollback marker or any other durable
state.

Reservation class, continuation origin, migration rollback, execution claim,
permission snapshot, and capability data are child-private.
Status, list, result, background reservation output, logs, errors, and rendered
diagnostics must remove these fields and must not reveal enough data to replay
them.

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
- private reservation/origin/rollback/claim publication order, crash retry,
  pre-claim sealed-payload confidentiality/authentication, v1 job-spec
  compatibility, public-output filtering, exact PID/lease matching, and
  claim-first versus revoke-first linearization through foreground, background,
  controller, recovery, and direct transition paths;
- classless owner-v1 ordinary-unbound and exact v1/v2-bound compatibility, plus
  fail-closed classless-v3 continuation, adoption, migration, fresh/ordinary,
  production-claim, and direct-transition cases;
- exact old adoption publication-remnant terminalization with a byte-identical
  prior binding, rejection before execution side effects, and markerless
  migration rejection with zero durable mutation;
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
