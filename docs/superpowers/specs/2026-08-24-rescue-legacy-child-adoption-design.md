# Rescue Legacy Child Adoption Design

**Date:** 2026-08-24
**Status:** approved compatibility amendment
**Amends:**

- `2026-08-23-rescue-persisted-child-reactivation-design.md`
- `2026-08-23-rescue-exact-parent-discovery-design.md`

## Problem

PR #42 made persisted-child discovery complete by using Codex's exact-parent
relationship query. Two production replays show that discovery completeness is
not enough:

1. Parent `01a022d7-aa12-7112-abe0-78036571802e` contains the exact persisted
   named Rescue child `01a0273d…` at `/root/zcode_rescue_task`, but the older
   plugin left no Hook executor record for that child. The merged planner treats
   the path as occupied and prescribes `spawn zcode_rescue_task_2`. This avoids
   a collision but does not restore the original child.
2. A later same-operation continuation has a valid stopped and bound Rescue
   child at `/root/zcode_rescue_task_2`. The planner scans an unrelated
   `/root/t1_spec_review` child first, resolves its ordinary `default` executor,
   and aborts with `EXECUTOR_ROLE_UNAPPROVED` before selecting the valid Rescue
   binding.

The product contract is stronger than collision avoidance: an exact compatible
persisted Rescue child must be restored when current Codex and plugin authority
can prove the restoration. Ordinary children must neither authorize nor block
Rescue.

## Goals

- Restore an exact persisted named Rescue child without historical Hook
  executor artifacts.
- Keep executor-backed reactivation unchanged and preferred when its exact
  provenance exists.
- Keep every persisted child path in collision allocation while classifying
  unrelated children as occupancy-only.
- Preserve one-shot preparation, current parent-turn, permission, origin, and
  linked-worktree authority.
- Persist the source of child authority explicitly; never invent a historical
  `SubagentStart`, child turn, executor route, or spawn permission.
- Support both fresh and resume preparation without substituting a new Codex
  child merely because the old plugin omitted executor artifacts.

## Non-Goals

- Recover a generic/null-Role child without historical qualified executor
  provenance.
- Follow a child selected only from an agent-path collision.
- Reconstruct missing historical Hook records.
- Change Codex, read Codex private SQLite, or execute app-server turns directly.
- Make a legacy child eligible after parent, Role, path, cwd, active-turn,
  permission, or workspace ambiguity.

## Approaches Considered

### Global adoption locator

The parent could publish a private global record keyed by child thread ID that
points to the preparation's execution worktree. This works, but introduces a
second authority store, cross-file publication and consumption ordering,
additional crash recovery, bounded garbage collection, and three lifecycle
cleanup integrations.

### Exact child read plus the current identity ledger — selected

The restored child already has one trustworthy ambient identity:
`CODEX_THREAD_ID`. A bounded `thread/read` supplies the persisted child's exact
parent, Role, path, and cwd. The existing identity ledger can resolve that
parent's current active turn from either its canonical origin or claimed
execution workspace and returns the exact execution workspace. The child can
therefore locate and atomically consume the existing preparation without a new
locator.

This approach adds no independent authority or cleanup lifecycle. It also
revalidates the Codex child at consumption time instead of trusting the
planner's earlier snapshot.

### Host-only direct follow-up

Following the path without a private activation would restore the child but
would not bind it to the current task, parent turn, permission, or execution
workspace. It is rejected.

## Host Classification

Exact-parent discovery still validates every row completely and every path
enters the occupied set. Candidate classification happens before any Hook
executor lookup.

A **named Rescue host** has all of these properties:

- direct managed path `/root/<taskName>`;
- `taskName` passes the existing bounded `zcode_rescue_*` grammar;
- exact Codex Role `zcode-rescue`.

A **generic compatibility host** has the same managed path and a null Codex
Role. It is eligible only when the existing qualified `default` Hook executor
proves its identity. It is never eligible for legacy adoption.

Every other valid host row—including explicit `default`, `explorer`, other
Roles, and ordinary non-Rescue paths—is **occupancy-only**. The planner never
looks up its executor, validates it as Rescue, or lets its state cause a Rescue
error. Duplicate IDs or paths and malformed/foreign exact-parent metadata still
fail before classification.

For a named Rescue host:

- exact stopped executor found: use the existing executor-backed candidate;
- exact executor missing and host status `notLoaded`: it is a legacy-adoption
  candidate;
- corrupt, ambiguous, active, mismatched, or otherwise invalid executor
  evidence: fail closed rather than downgrade to adoption.

Adoption is permitted only for true `EXECUTOR_IDENTITY_NOT_FOUND`. It cannot
turn damaged current-plugin provenance into host-only authority.

## Planning and Selection

The activation union gains an exact `legacy-adopt` variant:

```json
{
  "kind": "legacy-adopt",
  "childThreadId": "01a0273d-…",
  "agentPathDigest": "<sha256>"
}
```

The root-facing directive remains unchanged and task-free:

```json
{"version":1,"action":"followup","target":"/root/zcode_rescue_task"}
```

The planner binds `childThreadId` to the exact returned row and the digest to
its exact managed path. It never exposes either value beyond the private
preparation record.

Selection rules are deterministic:

- `fresh`: consider both exact executor-backed and named legacy-adoption
  candidates; prefer the managed base path, otherwise the newest compatible
  child using the existing order;
- `resume`: first select the unique exact bound executor-backed or previously
  adopted child; if none is bound, select the deterministic named legacy child
  rather than spawning a replacement. The restored child may then return the
  existing exact `RESUME_CANDIDATE_NOT_FOUND` if no parent-owned ZCode operation
  can be resumed;
- a valid bound `/root/zcode_rescue_task_2` therefore wins resume selection over
  an unbound host-only base child;
- no compatible child: allocate the first collision-free managed spawn name as
  before.

Ambiguous exact bindings remain terminal. A host-only adoption candidate is not
itself a ZCode-session binding.

## Preparation Contract

Preparation version three keeps its record schema and adds `legacy-adopt` as a
strict activation alternative. Its exact proof binds:

- current parent session and turn;
- canonical execution workspace and current permission;
- exact child thread ID;
- exact managed agent-path digest;
- creation and expiry timestamps;
- one atomic consumer.

`legacy-adopt` is valid only on generation one. Later generations remain bound
to the child identity established by the consumed generation. A generation
greater than one may use the host-backed consumer only when its exact
`requiredExecutorAgentId` equals the ambient child and the durable binding for
that child explicitly records `codex-legacy-adoption`; it never recreates a
generation-one activation. A failed proof does not consume or rewrite the
record. Replay returns the existing consumed error.

The preparation TTL remains the existing safety bound. It is not child
lifetime, executor lifetime, or a limit on future operation continuation.

## Child-Side Adoption

`invoke-prepared rescue` no longer requires Hook executor resolution before it
can inspect the preparation. It follows this bounded order:

1. Read the ambient `CODEX_THREAD_ID`; this is the proposed child ID.
2. Try the existing routed Hook executor resolution.
3. If and only if it returns an allowed absence/state result, perform a bounded
   app-server `thread/read` by exact child ID without a caller-supplied parent.
   Raw validation still requires equal top-level and nested parent, Role, and
   path metadata.
4. Require exact named Role `zcode-rescue`, managed path, non-empty parent ID,
   and canonical host cwd equal to the current active turn's origin workspace.
5. Resolve that parent's active turn through the existing identity ledger with
   the ambient canonical cwd and `workspaceBinding: execution`. This returns
   the current parent turn, generation, permission, origin, and exact linked
   execution workspace. No scan or prompt inference is allowed.
6. Read and atomically consume the preparation in that execution workspace.
   Require `legacy-adopt`, ambient child ID, path digest, parent, current turn,
   generation, permission, origin, and execution workspace to agree.
7. Rejection happens before job reservation or any ZCode RPC. Successful
   consumption creates an explicit in-memory legacy-adoption authority.

The consumer makes a fresh app-server proof; planner-time metadata alone is not
sufficient. It does not assume that Codex emits another `SubagentStart` when a
persisted child is lazily loaded.

The app-server client therefore adds one bounded child-identity read that does
not require the parent as input but still validates that the returned
top-level and nested parent IDs agree. Existing reads with an expected parent
remain unchanged.

## Explicit Child Authority

Downstream Rescue reservation accepts a closed union:

- `subagent-start`: the existing exact Hook executor and route provenance;
- `codex-legacy-adoption`: the newly consumed preparation plus current Codex
  child and parent-turn proofs.

The legacy variant contains only facts actually proved now:

- exact child ID and `zcode-rescue` Role;
- exact parent session;
- current authorizing parent turn, generation, and permission;
- exact origin and execution workspaces;
- exact agent-path digest;
- preparation creation/consumption identity.

Its `authorityId` is the SHA-256 digest of a domain-separated tuple containing
the preparation key, exact child ID, generation, and canonical creation time.
It is computed only after the exact preparation has been consumed. It uniquely
names this private authority without adding another stored capability or
placing randomness in the root-facing route.

It has no historical child turn, historical spawn parent turn, historical
permission, Hook route, or `subagent-executor` kind. The implementation must not
write Hook executor/route artifacts or synthesize their fields.

Companion and StateStore use the union explicitly rather than passing a fake
executor object. Existing executor-backed callers are normalized once at the
boundary.

## Durable Rescue Binding

The binding codec evolves to distinguish authority provenance while preserving
existing version-one records:

- existing records parse as `subagent-start` authority;
- new writes use the current codec and persist either `subagent-start` or
  `codex-legacy-adoption` explicitly;
- the binding key remains based on parent session, exact child ID, and canonical
  execution workspace so the two authority kinds cannot create parallel slots;
- a legacy-adoption binding carries its private preparation authority identity
  and path digest, not invented Hook fields;
- parser, partition, byte, count, CAS, close, and publication guarantees remain
  exact and bounded.

A fresh adopted child atomically publishes its first job and durable binding
through the existing StateStore reservation transaction. A later preparation
for that child uses the persisted adoption binding for exact resume selection,
then creates a new one-shot `legacy-adopt` authority for the current parent
turn. Permission replacement remains allowed only by the existing explicit
fresh semantics; resume requires the binding's exact current permission.

Version-one Hook-backed bindings remain byte-readable and are rewritten only by
an existing legal state transition. No bulk migration or history scan occurs.

## Failure and Lifecycle Semantics

- Child read missing, malformed, foreign, contradictory, or unsupported: fail
  closed.
- Parent turn ended or replaced: active-turn resolution or preparation consume
  fails before reservation.
- Wrong child, path, Role, cwd, permission, generation, or worktree: fail before
  preparation consumption or reservation as appropriate.
- Concurrent child invocation: exactly one preparation consumer wins.
- Consumed preparation followed by reservation failure: no replay; the parent
  must prepare a new turn. This matches existing one-shot activation safety.
- New prompt, Root Stop, and SessionEnd continue cleaning the preparation; no
  new locator or cleanup namespace exists.
- Ordinary child corruption cannot affect Rescue planning because no executor
  lookup occurs for occupancy-only rows.

Public errors remain fixed and task-free. No private child ID, parent ID,
workspace, preparation content, permission, binding, or path digest appears in
the root-facing directive or diagnostic.

## Testing

### Deterministic incident regressions

1. **Legacy base restoration**
   - exact-parent discovery returns the real incident-shaped not-loaded named
     base child;
   - no Hook executor record exists;
   - preparation returns exact `followup` to the base path, never `_2`;
   - child-side app-server read returns the same exact identity;
   - origin identity resolution reaches the linked execution worktree;
   - exactly that ambient child consumes once and starts a fresh fake ZCode
     operation with a terminal response;
   - zero spawn, Hook record fabrication, retry, or private output occurs.

2. **Ordinary Role isolation**
   - exact-parent discovery contains an ordinary `default` spec-review child
     with valid executor provenance, an `explorer`, the old host-only base
     child, and the exact bound `_2` Rescue child;
   - `resume` returns exact `followup /root/zcode_rescue_task_2`;
   - the planner never calls executor resolution for the ordinary children;
   - changing ordinary executor bytes cannot change the result.

### Negative coverage

- named Role changed to default/null/explorer;
- generic/null child without exact default executor provenance;
- non-managed path or non-direct path;
- executor corruption versus true absence;
- active host-only child;
- planner/consumer child, parent, Role, path, cwd, or digest drift;
- current turn, generation, permission, origin, or execution-worktree drift;
- sibling ambient ID, replay, expiry, and concurrent consume;
- binding v1 compatibility and every new authority discriminator mutation;
- no mutation, job reservation, ZCode create/resume/send, or public leak on
  every rejection.

### Required gates

- focused planner, preparation, app-server, binding, StateStore, Companion, and
  installed integration suites;
- captured restored-child qualification updated to prove the no-Hook legacy
  path and a real fake ZCode response;
- bilingual documentation, security contract, changelog, marketplace critical
  payload, and clean-source snapshot regeneration;
- complete local `npm run check` and all CI operating-system/Node jobs.

## Acceptance Criteria

- The first production incident prepares `followup /root/zcode_rescue_task`,
  not `spawn zcode_rescue_task_2`.
- The second production incident prepares
  `followup /root/zcode_rescue_task_2`, not `EXECUTOR_ROLE_UNAPPROVED`.
- The legacy child produces a verified fake ZCode response through the linked
  execution worktree without historical Hook executor artifacts.
- Existing executor-backed, generic compatibility, spawn, fresh, resume,
  choice, cancellation, and cleanup behavior remains qualified.
- No code path represents legacy adoption as historical `SubagentStart`
  provenance.
