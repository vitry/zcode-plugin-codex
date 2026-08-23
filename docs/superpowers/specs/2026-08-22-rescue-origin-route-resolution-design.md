# Rescue Origin Route Resolution Design

Status: approved for implementation on 2026-08-22

## Problem

PR #39 lets an active parent turn start in an origin workspace and bind Rescue
to an eligible linked worktree at `prepare rescue`. The binding is correct and
immutable. `SubagentStart` also writes an exact route in the origin partition
and the executor record in the bound execution-workspace partition.

Codex spawned children do not inherit the working directory of the parent's
last terminal call. They inherit the conversation's origin working directory.
Consequently, the real child runs `invoke-prepared rescue` from the origin even
when preparation and all Rescue state belong to the linked worktree. The
current companion resolves an executor only in its ambient cwd partition and
returns `EXECUTOR_IDENTITY_NOT_FOUND` before it can follow the existing route.

The production incident is:

```text
parent conversation cwd       = /repo
role-status / prepare cwd      = /repo/.worktrees/task
origin executor-route          = /repo -> /repo/.worktrees/task
target executor + preparation  = /repo/.worktrees/task
spawned child cwd              = /repo
current executor lookup        = /repo only
result                         = EXECUTOR_IDENTITY_NOT_FOUND
```

This is not a failure to choose or create the target. It is the missing
origin-to-target resolution half of the late-binding design.

## Goals

- Let a trusted Rescue child launched from the Codex conversation origin find
  its already-bound execution worktree through the exact route published by
  `SubagentStart`.
- Keep the prepare-time execution-workspace binding immutable. Child commands
  can resolve that binding but cannot create, claim, replace, or redirect it.
- Apply the same routed executor semantics to initial prepared execution,
  status observation, pending choice, direct compatibility invocation, and
  stopped same-child continuation.
- Reuse already-persisted PR #39 route and executor records without migration.
- Preserve exact-workspace and legacy behavior when the child already runs in
  the executor workspace.
- Keep all Rescue state, ZCode sessions, jobs, bindings, preparation, results,
  and code changes in the bound execution workspace.
- Reproduce the real Codex cwd behavior in deterministic integration,
  qualification, and authenticated real-ZCode verification.

## Non-goals

- Do not change how `prepare rescue` chooses or claims an execution workspace.
- Do not move, copy, or adopt Rescue state from the origin workspace.
- Do not choose an origin job, binding, executor, or session merely because it
  exists there.
- Do not scan every workspace partition, select a latest route, or fall back to
  another session or child.
- Do not add a public handoff command, path argument, environment variable, or
  child-visible target workspace.
- Do not duplicate the executor authority in origin and target partitions.
- Do not use ZCode Rescue to implement or review this change.

## Authority Invariants

The following invariants are mandatory:

1. Only parent `prepare rescue` may claim an unbound target.
2. The route resolver is read-only and never calls a claim operation.
3. The ambient child supplies only its trusted `CODEX_THREAD_ID` and cwd. It
   does not supply a target path, parent ID, generation, turn, or permission.
4. Origin lookup is confined to the canonical ambient workspace's bounded
   private `hook-state` partition.
5. A selected route must match the exact child ID and must validate its full
   existing schema, canonical origin, state, timestamps, parent generation,
   parent turn, permission snapshot, child turn, and target workspace.
6. The target executor must independently validate and exactly match the
   selected route. The route alone never authorizes execution.
7. The active parent lifecycle, immutable execution binding, preparation, and
   any durable Rescue binding must independently match the routed executor.
8. Missing, corrupt, expired, stopped/active-state-mismatched, or ambiguous
   authority fails closed without another route or workspace fallback.
9. An ambient executor record that exists but is inactive, invalid, expired,
   noncanonical, duplicated, malformed, or incompatible with the requested mode
   is existing authority or corrupt authority, not absence. Its failure is
   terminal and cannot trigger origin-route resolution.

## Considered Approaches

### 1. Resolve the existing origin route by exact child ID (chosen)

Deepen `hooks/lib/hook-state.mjs` with one routed executor resolution interface.
It first performs the existing bounded ambient executor-set validation inside
the hook-state module. Every executor record is read through the current
bounded/nofollow path and validated before absence can be established. If the
canonical executor exists, or a noncanonical/duplicate record claims the same
child, it follows the existing direct success or terminal failure semantics
without route substitution. If and only if the complete valid ambient set has
zero claims for the child does the private probe return structured `absent`.
The implementation may then inspect the bounded route records in that same
partition, select exactly one full-schema route for the child ID, and resolve
the target executor through the existing executor validator. It returns the
validated executor and canonical execution workspace as one result.

Advantages:

- works with PR #39 records already on disk;
- adds no new authority schema or publication transaction;
- keeps route selection and executor validation in one deep module;
- remains bounded to one known origin partition;
- lets every companion entry use the same small interface.

The bounded origin scan is acceptable because `hook-state` already enforces a
strict record-count limit. It is not a workspace scan and does not inspect job
or binding records.

### 2. Add a new origin index keyed by child ID

`SubagentStart` could publish a second route-index record whose filename is
derived from the child ID. Lookup would be direct, but existing PR #39 sessions
would not contain that index. Supporting them would still require approach 1
as a fallback. The extra publication, cleanup, crash recovery, and schema add
complexity without removing the compatibility lookup, so this is rejected.

### 3. Mirror the executor into the origin partition

Copying the executor would make current lookup succeed, but creates two
authority records whose active/stopped state and cleanup must remain atomic
across partitions. It also makes the origin look executable when it is only a
route. The duplicated truth is rejected.

## Deep Module Interface

The hook-state module owns route storage and executor validation, so the seam
belongs there. Add one interface conceptually equivalent to:

```js
resolveRoutedForwardingExecutor(dataRoot, ambientWorkspace, agentId, options)
  -> { executor, executionWorkspace }
```

The caller learns only the validated execution workspace it must use next. It
does not learn route filename conventions or perform route/executor matching.
The implementation may reuse private helpers and the existing
`resolveForwardingExecutor`; those details are not part of the interface.

Resolution proceeds as follows:

```text
canonicalize ambient workspace
  -> bounded-read and validate the complete ambient executor set as today
  -> canonical exact executor exists here
       -> validate executor and its route as today
       -> return its canonical workspace
       -> any invalid/inactive/expired/mode failure is terminal
  -> noncanonical or duplicate same-child claim exists
       -> preserve existing invalid/ambiguous terminal failure
  -> any malformed ambient executor exists
       -> preserve existing terminal failure
  -> complete valid ambient executor set contains zero child claims
       -> return private structured absent result
       -> read only bounded route records in ambient hook-state
       -> validate all relevant record bytes and schemas
       -> collect every route whose agentId is the ambient child without
          filtering by active/stopped/pending invocation mode
       -> zero claims: EXECUTOR_IDENTITY_NOT_FOUND
       -> multiple claims: EXECUTOR_IDENTITY_AMBIGUOUS
       -> exactly one claim: validate route state and time for this mode
       -> require route.originWorkspace == canonical ambient workspace
       -> resolve executor in route.targetWorkspace
       -> require executorMatchesRoute(executor, route)
       -> return executor + target workspace
```

Public `EXECUTOR_IDENTITY_NOT_FOUND` is not a sufficient fallback signal. The
current direct resolver uses that code both when a record is absent and when an
existing executor is inactive. Routed resolution therefore cannot be layered
as `catch (EXECUTOR_IDENTITY_NOT_FOUND)`. The executor-set probe and fallback
decision stay private to the deep hook-state implementation. Only a successful
bounded validation of the complete ambient executor set followed by zero child
claims permits the origin-route form. Canonical-path `ENOENT` alone is never
sufficient.

Route claims are counted before invocation-mode filtering. Two claims for the
same child are ambiguous even if one is active and one is stopped, or only one
would otherwise fit the requested operation. The resolver must never select a
claim by state. An exact single route with `pending` state is never executable,
whether it is inside or beyond the 30-second pending publication budget. A
route whose `createdAt` or `updatedAt` is in the future is invalid. Corruption,
unsupported Role, expiry, state mismatch, or any other validation failure is
terminal and cannot be converted into another lookup.

The existing stopped/durable options remain authoritative. Route resolution
does not silently change an active lookup into a stopped continuation or vice
versa.

## Companion Integration

Every child-side Rescue entry resolves one execution context before reading
workspace-local state:

```text
ambient cwd + child thread ID
  -> routed executor context
  -> active parent turn at executionWorkspace
  -> exact preparation / pending choice / binding / status
  -> run ZCode with cwd = executionWorkspace
```

Apply the context to:

- `invoke-prepared rescue`: consume preparation and launch or resume ZCode in
  the execution workspace;
- `invoke-status rescue`: read only the exact bound job from the execution
  workspace;
- `invoke-choice rescue`: consume the exact pending choice and preserve the
  stopped executor's target;
- installed Rescue direct compatibility paths that already require trusted
  executor identity;
- same-child prepared continuation after the original child stopped.

No child command may reuse ambient cwd for identity, preparation, pending
choice, state-store, broker, result, or execution after routed resolution.

## Error Semantics

Public errors remain bounded and keep the existing executor vocabulary.

- No direct executor and no exact origin route:
  `EXECUTOR_IDENTITY_NOT_FOUND`.
- More than one valid route claims the child:
  `EXECUTOR_IDENTITY_AMBIGUOUS`.
- A route is malformed, mismatched, points to an invalid target executor, or
  disagrees with lifecycle authority:
  `EXECUTOR_ROUTE_INVALID` or the existing more specific lifecycle error.
- Active/stopped or durable provenance mode is wrong:
  the existing `EXECUTOR_STATE_MISMATCH`/expiry behavior.

Errors must not render origin paths, target paths, route fields, session IDs,
turn IDs, generations, task text, or preparation contents.

## Compatibility

- Existing unconsumed PR #39 preparations and routes can be resolved because
  the chosen design consumes their current schema.
- A child already running in the target uses the existing direct lookup first.
- A non-worktree exact-origin Rescue remains unchanged because origin and target
  are the same partition.
- Legacy executor records remain readable only under their existing legacy
  authority rules; route recovery must not create lifecycle authority for them.
- Named `zcode-rescue` and qualified generic/default children use identical
  routing semantics.

## Test Strategy

### Deterministic RED/GREEN regression

Change the linked-worktree integration scenario so:

1. parent lifecycle begins at origin;
2. prepare claims the linked target;
3. SubagentStart hook runs with origin cwd;
4. child `invoke-prepared` also runs with origin cwd, matching real Codex;
5. fake ZCode records that `session/create` and execution cwd are the target;
6. root receives no job, binding, preparation, or execution state.

The test must fail with `EXECUTOR_IDENTITY_NOT_FOUND` before implementation and
pass afterward. Red/green must be demonstrated, not inferred.

### Hook-state tests

Cover:

- direct target lookup remains unchanged;
- exact origin route resolves the target executor;
- an existing inactive, invalid, expired, or mode-incompatible ambient executor
  fails directly and cannot fall through to a target route;
- a missing canonical file with a noncanonical same-child claim, duplicate or
  noncanonical claims, or any malformed ambient executor preserves the existing
  invalid/ambiguous failure and cannot fall through to a target route;
- missing route, unrelated route, duplicate child route, malformed route,
  target executor mismatch, wrong generation, wrong Role, state mismatch, and
  expired executor all fail closed;
- active/stopped mixed duplicate claims are ambiguous before mode filtering;
- future route `createdAt`/`updatedAt` and both fresh and aged pending routes
  are rejected without selecting another claim;
- route resolution never mutates active-turn, route, executor, or workspace
  partition bytes;
- record-count and nofollow/bounded-read protections remain enforced.

### Frozen PR #39 compatibility fixture

Check in raw fixed fixture bytes representing the merged PR #39 schemas for:

- one v3 active turn and session ledger bound from origin to target;
- one origin v1 `executor-route` and forwarding record;
- one current target `subagent-executor`;
- one prepared invocation and, where needed, pending/bound continuation state.

The fixture must not call the current `SubagentStart` or other publication code
to create these records. From an origin-cwd child it must exercise prepared,
status, choice, and stopped continuation resolution. Snapshot every frozen
authority file before and after each read/consume boundary and assert that route,
executor, and lifecycle bytes are never migrated or rewritten. Only the
operation's existing one-shot preparation or pending state may be consumed by
its documented command.

This fixture is the compatibility oracle: changing a producer and consumer
together cannot make an incompatible schema change appear safe.

### Companion lifecycle tests

Run from origin cwd and prove target behavior for:

- initial `invoke-prepared`;
- `invoke-status` during foreground execution;
- `invoke-choice` for both fresh and resume;
- stopped same-child prepared continuation;
- named and generic/default child routes;
- unrelated root jobs/bindings cannot be selected.

### Qualification and real ZCode

Update captured/installed qualification so its child command runs from origin
while the expected execution workspace remains the linked target. The evidence
must prove route, executor, preparation, broker/session workspace, job, and
cleanup remain target-scoped.

Run authenticated real ZCode directly, without ZCode Rescue, and require an
actual response from a child-origin invocation whose ZCode session workspace is
the linked worktree.

## Delivery

- Work on `fix/rescue-origin-route-resolution` in its isolated worktree.
- Use TDD and subagent-driven implementation with separate spec-compliance and
  code-quality reviews, followed by a final independent review.
- Regenerate the marketplace snapshot only from a clean reviewed source commit.
- Open a follow-up PR against `main` and continue fixing platform-specific
  failures until every required GitHub Actions matrix check succeeds.
- Do not merge the PR unless separately requested.
