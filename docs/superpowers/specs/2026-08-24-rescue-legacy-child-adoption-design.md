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

Adoption is permitted only when ordinary plus durable routed executor
resolution ends in exact `EXECUTOR_IDENTITY_NOT_FOUND`. Expired, state-mismatched,
ambiguous, invalid, route-invalid, or Role-invalid results are terminal. Any
surviving Hook route, executor, or `subagent-start` binding that contradicts the
host also remains terminal.

Complete historical absence cannot distinguish “an old plugin never wrote the
record” from “all current-plugin Hook files were deleted.” The design does not
claim that distinction. For an otherwise exact named child, authoritative Codex
parent + Role + managed path + cwd, joined to the current one-shot parent-turn
preparation, is deliberately the replacement trust boundary. Partial or
contradictory plugin evidence cannot use that replacement boundary.

## Planning and Selection

The activation union gains exact first-adoption and later-continuation variants:

```json
{
  "kind": "legacy-adopt",
  "childThreadId": "01a0273d-…",
  "agentPathDigest": "<sha256>"
}
```

```json
{
  "kind": "legacy-bound",
  "childThreadId": "01a0273d-…",
  "agentPathDigest": "<sha256>",
  "bindingKey": "<sha256>"
}
```

The root-facing directive remains task-free but advances to version two so Root
does not need retained historical spawn provenance to choose the fixed child
assignment:

```json
{"version":2,"action":"followup","target":"/root/zcode_rescue_task","assignment":"zcode-rescue"}
```

The exact `assignment` vocabulary is `zcode-rescue` or `default`. It contains no
task or authority data. The planner derives it from the same joined host/executor
proof used for selection. Root must use it to choose the existing fixed named or
generic launcher assignment and must not infer assignment from conversation
history. This v2 shape applies only to follow-up. Spawn keeps the existing exact
v1 `{version:1, action:"spawn", taskName}` directive and its bounded named-to-
generic schema negotiation; it carries no assignment because the actual Role is
not known until that negotiation finishes. The amended Skill accepts exactly v2
follow-up or existing v1 spawn and rejects every other version/action pairing.

The planner binds `childThreadId` to the exact returned row and the digest to its
exact managed path. It exposes neither value; only the path and fixed assignment
class cross the private preparation boundary.

Selection rules are deterministic:

- `fresh`: prefer the stronger exact executor-backed set; inside that set prefer
  the managed base path, otherwise the newest compatible child. Only when the
  proven set is empty may the planner select a named legacy-adoption candidate,
  again using base path then newest order;
- `resume`: first select the unique exact bound executor-backed or previously
  adopted child; if none is bound and exactly one named unbound legacy candidate
  exists, select it rather than spawning a replacement. Multiple unbound legacy
  children are ambiguous because no ZCode binding identifies the requested
  operation and therefore fail closed. The restored child may then return the
  existing exact `RESUME_CANDIDATE_NOT_FOUND` if no parent-owned ZCode operation
  can be resumed;
- a valid bound `/root/zcode_rescue_task_2` therefore wins resume selection over
  an unbound host-only base child;
- no compatible child: allocate the first collision-free managed spawn name as
  before.

Selecting an unbound host-only candidate emits generation-one `legacy-adopt`.
Selecting a child through its exact existing adoption binding emits
`legacy-bound` with that binding key, regardless of whether the new preparation
is generation one in a new parent turn or a later generation in the same turn. Executor-backed
selection keeps the existing Hook activation contract.

Ambiguous exact bindings remain terminal. A host-only adoption candidate is not
itself a ZCode-session binding.

## Preparation Contract

Preparation version three keeps its outer record schema and adds `legacy-adopt`
and `legacy-bound` as strict activation alternatives. Their exact proofs bind:

- current parent session and turn;
- canonical execution workspace and current permission;
- exact child thread ID;
- exact managed agent-path digest;
- creation and expiry timestamps;
- one atomic consumer.

`legacy-adopt` is valid only on generation one and has no `bindingKey`.
`legacy-bound` is valid on any generation, carries the exact existing binding
key, and is emitted only after the planner proves that binding records
`codex-legacy-adoption` for the same parent, child, path, and execution
workspace. Its exact `requiredExecutorAgentId` is the same child. The
preparation store chooses and validates generation under its existing lock;
the planner never predicts generation. A new parent turn may therefore create
generation-one `legacy-bound`, while a same-turn continuation may create
generation two or later. Each authorizes one current invocation and neither
recreates nor replaces the original adoption. A failed proof does not consume
or rewrite the record. Replay returns the existing consumed error.

The preparation TTL remains the existing safety bound. It is not child
lifetime, executor lifetime, or a limit on future operation continuation.

## Child-Side Adoption

`invoke-prepared rescue` no longer requires Hook executor resolution before it
can inspect the preparation. It follows this bounded order:

1. Read the ambient `CODEX_THREAD_ID`; this is the proposed child ID.
2. Try the existing routed Hook executor resolution.
3. If and only if ordinary plus durable resolution ends in exact
   `EXECUTOR_IDENTITY_NOT_FOUND`, perform a bounded app-server `thread/read` by
   exact child ID without a caller-supplied parent. Every expired, state,
   ambiguity, invalid, route, or Role error is terminal.
   Raw validation still requires equal top-level and nested parent, Role, and
   path metadata.
4. Require exact named Role `zcode-rescue`, managed path, non-empty parent ID,
   and canonical host cwd.
5. Resolve that parent's active turn through the existing identity ledger with
   the ambient canonical cwd and `workspaceBinding: execution`. This returns
   the current parent turn, generation, permission, origin, and exact linked
   execution workspace. No scan or prompt inference is allowed.
6. Require host cwd equal the resolved canonical origin, and require ambient cwd
   equal either that origin or the exact execution workspace. An unrelated
   linked worktree is ineligible.
7. Read and atomically consume the preparation in that execution workspace.
   Require generation-one `legacy-adopt` or binding-backed `legacy-bound`, plus
   ambient child ID, path digest, parent, current turn, generation, permission,
   origin, and execution workspace to agree. The bound variant additionally
   requires its exact active adoption binding key at any generation.
8. Rejection happens before job reservation or any ZCode RPC. Successful
   consumption creates an explicit in-memory legacy-adoption authority.

The consumer makes a fresh app-server proof; planner-time metadata alone is not
sufficient. It does not assume that Codex emits another `SubagentStart` when a
persisted child is lazily loaded.

If Codex does emit a new exact `SubagentStart` between planning and invocation,
ordinary Hook resolution wins for either `legacy-adopt` or `legacy-bound`. The
child still consumes that selected host-backed preparation only after its
executor ID, named Role, parent, path digest, origin, execution workspace,
current turn, generation, permission, and (for `legacy-bound`) binding key all
match. Downstream authority is then `subagent-start`; a first adoption persists
Hook authority, while an already-bound child keeps its immutable existing
adoption binding and uses the new Hook proof only for the current reservation.
A mismatched new executor is terminal. This is convergence to stronger current
evidence, not reconstruction.

The app-server client therefore adds one bounded child-identity read that does
not require the parent as input but still validates that the returned
top-level and nested parent IDs agree. Existing reads with an expected parent
remain unchanged.

## Explicit Child Authority

Downstream Rescue reservation accepts a closed union:

- `subagent-start`: the existing exact Hook executor and route provenance;
- `codex-legacy-adoption`: the newly consumed preparation plus current Codex
  child and parent-turn proofs that establish the durable binding;
- `codex-legacy-continuation`: a newly consumed binding-backed preparation,
  current Codex child and parent-turn proofs, plus the exact existing adoption
  binding key. This variant authorizes a request but is never persisted as the
  binding's child authority.

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

The transient continuation variant has this exact schema:

```json
{"kind":"codex-legacy-continuation","preparationAuthorityId":"<sha256>","bindingKey":"<sha256>","childAgentId":"…","childAgentType":"zcode-rescue","authorizingParentTurnId":"…","authorizingParentGenerationId":"<sha256>","authorizingPermissionMode":"…","originWorkspace":"…","executionWorkspace":"…","agentPathDigest":"<sha256>"}
```

`preparationAuthorityId` is SHA-256 over the exact JSON tuple
`["rescue-legacy-bound-authority-v1", key, childThreadId, generation,
createdAt, bindingKey]` from the consumed `legacy-bound` record. The distinct
domain and bound key prevent first-adoption/continuation type confusion.
StateStore accepts it only when `bindingKey` resolves to the one active binding
whose durable authority is `codex-legacy-adoption` and whose parent, child,
Role, path digest, origin, and execution workspace match. The current turn,
generation, permission, preparation consumer, and one-shot state must match the
new preparation. Wrong binding kind, key, path, workspace, or permission fails
before job publication. The transient object is discarded after reservation.

It has no historical child turn, historical spawn parent turn, historical
permission, Hook route, or `subagent-executor` kind. The implementation must not
write Hook executor/route artifacts or synthesize their fields.

Companion and StateStore use the union explicitly rather than passing a fake
executor object. Existing executor-backed callers are normalized once at the
boundary.

## Durable Rescue Binding

The binding key hash domain remains `rescue-binding-v1` and continues to use
parent session, exact child ID, and canonical execution workspace. Record
version two has these exact top-level fields:

```text
version, key, operationId, state, parentSessionId, childAuthority, workspace,
permissionMode, anchorJobId, currentJobId, createdAt, updatedAt, closedAt,
closeReason
```

Its exact `childAuthority` union is:

```json
{"kind":"subagent-start","childAgentId":"…","childAgentType":"zcode-rescue|default","parentTurnId":"…","parentPermissionMode":"…"}
```

or:

```json
{"kind":"codex-legacy-adoption","authorityId":"<sha256>","childAgentId":"…","childAgentType":"zcode-rescue","authorizingParentTurnId":"…","authorizingParentGenerationId":"<sha256>","authorizingPermissionMode":"…","originWorkspace":"…","executionWorkspace":"…","agentPathDigest":"<sha256>"}
```

The codec preserves existing version-one records:

- active and closed version-one records parse without byte rewriting and expose
  their historical executor fields through a `subagent-start` authority view;
- new writes use the current codec and persist either `subagent-start` or
  `codex-legacy-adoption` explicitly;
- mixed version-one/version-two partitions remain strictly sorted, bounded, and
  unique by the unchanged key so the authority kinds cannot create parallel
  slots;
- a legacy-adoption binding carries its private preparation authority identity
  and path digest, not invented Hook fields;
- parser, partition, byte, count, CAS, close, and publication guarantees remain
  exact and bounded.

A first adopted child atomically publishes its first job and durable binding
through the existing StateStore reservation transaction. A later preparation
for that child uses the persisted adoption binding for exact resume selection,
then consumes a new one-shot `legacy-bound` authority for the current parent
turn. This applies to both later `fresh` replacement and `resume`; it never
re-adopts the child. Permission replacement remains allowed only by the existing
explicit fresh semantics; resume requires the binding's exact current permission.

The durable `childAuthority` records the authority that established the current
operation and remains immutable across later continuations and fresh operation
replacement for the same child. The transient continuation repeats the stable
child ID/type, path digest, origin, and execution workspace and supplies current
turn/generation/permission proof; its permission must equal the binding
permission except where the existing explicit fresh replacement semantics
atomically replace that top-level permission. A legal close preserves the
record version and authority bytes. A legal fresh replacement of a version-one
Hook slot may write version two; no read or unrelated transition does.

Version-one Hook-backed bindings remain byte-readable and are rewritten only by
an existing legal state transition. No bulk migration or history scan occurs.

### Pending choice continuation amendment

A `legacy-adopt` or `legacy-bound` preparation may intentionally omit both
`fresh` and `resume`. After the child consumes that preparation, it saves one
of two closed private version-three pending variants. First adoption carries
the exact legacy candidate route plus the consumed adoption authority; bound
continuation carries the exact durable binding snapshot plus its consumed
continuation authority. Both atomically inherit the exact child, path digest,
parent session/turn/generation, permission, origin, and execution workspace;
only the bound variant carries a binding key. Neither stores or synthesizes a
Hook executor or route artifact.

The later fixed `invoke-choice rescue resume|fresh` first prefers an exact
current Hook executor. Only final exact `EXECUTOR_IDENTITY_NOT_FOUND` may use
the same ambient child app-server read and active-parent execution-workspace
join as prepared invocation. The pending record is consumed only when the
current child, parent turn/generation, permission, origin, and execution
workspace match. Consumption issues one in-process, one-shot branded
continuation authority; StateStore accepts that exact object identity and
rejects raw persisted objects, clones, replay, and every field mutation before
publication. The durable adoption authority remains unchanged. A matching new
Hook may authorize the current reservation while the pending record still
supplies the exact one-shot choice and binding snapshot.

Version-one and version-two pending records retain their existing compatibility
rules. Only a genuine consumed `legacy-adopt` or `legacy-bound` preparation
authority can create its matching version-three variant. The first-adoption
variant may resume its exact parent-owned candidate or choose fresh; either
choice uses the same child and atomically creates the durable version-two
adoption binding. Expiry or mismatch cannot publish a job, reserve a ZCode
operation, or consume unrelated preparation state.

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
- Ordinary child executor bytes or state cannot affect Rescue planning because
  no executor lookup occurs for occupancy-only rows. Malformed, foreign, or
  duplicate host metadata still fails before classification.

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
   - the directive contains exact assignment `zcode-rescue`, so Root needs no
     retained spawn provenance;
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
- each non-NOT_FOUND resolver error and every surviving contradictory Hook or
  binding artifact;
- active host-only child;
- planner/consumer child, parent, Role, path, cwd, or digest drift;
- current turn, generation, permission, origin, or execution-worktree drift;
- sibling ambient ID, replay, expiry, and concurrent consume;
- no-event and newly-emitted exact `SubagentStart` convergence;
- fresh mixed proven/legacy precedence and multi-unbound-legacy resume ambiguity;
- origin cwd, exact execution cwd, and unrelated linked-worktree invocation;
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
