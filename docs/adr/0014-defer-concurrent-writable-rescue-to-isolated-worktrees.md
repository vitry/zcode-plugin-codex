---
status: accepted
decision: defer-concurrency-until-isolated-worktrees
scope: future-rescue-orchestration
---

# Allow concurrent writable Rescue only across isolated execution worktrees

## Context

Rescue may investigate and mutate its execution workspace. Today StateStore
admits at most one queued, running, or cancelling non-read-only job per
canonical workspace and returns `WRITABLE_JOB_EXISTS` for another. Admission is
serialized under the workspace state lock; scavenging may settle a genuine
orphan and retry, but it never bypasses an uncertain writer. Read-only jobs may
still run concurrently.

Exact continuation targeting makes multiple logical Rescue operations
independently addressable. That creates real product value in eventually
running independent operations in parallel, but addressing is not filesystem
isolation. Two coding agents in one worktree can interfere through tracked and
untracked files, the Git index and metadata, generated output, dependency
locks, build caches, formatting, or files discovered dynamically. A declared
path scope cannot prove non-interference for arbitrary commands.

## Decision

Keep the current one-active-writable-Rescue-per-canonical-workspace policy.
The exact-continuation-target change does not modify or refactor writable
admission, reservation locking, scavenging, recovery, cancellation, worker
leases, or SessionEnd assumptions.

Evaluate concurrent writable Rescue later as a separately specified feature
only when each active operation owns a distinct canonical linked worktree and
workspace-local state partition. Prefer a managed linked worktree per
operation. Reject simultaneous writable Rescue operations in the same
canonical worktree even when their requested tasks appear disjoint.

Worktree allocation, authority, routing, lifecycle, cleanup, resource limits,
and integration should form one orchestration module. Callers request an
isolated writable operation; the module hides allocation and crash recovery and
returns independently inspectable changes. Integration must be explicit and
serialized, with conflicts surfaced rather than silently resolved.

## Value assessment

Isolated writable concurrency can materially improve the product:

- independent repairs, investigations, and feature slices finish with lower
  wall-clock latency;
- a long-running operation need not block an urgent unrelated repair;
- multiple ZCode sessions can be utilized while each operation retains an
  exact diff, result, cancellation target, and integration decision;
- speculative or failed work is contained in its own filesystem boundary.

The value is conditional. If task independence is weak, allocation and merge
overhead can cost more than serialized execution. The feature is an advance
over a single implicit continuation only when exact routing, isolation,
lifecycle ownership, and integration are all solved together.

## Required future design work

A future proposal must specify and prove:

- an operation-scoped linked-worktree allocator with atomic unique ownership,
  immutable base/provenance, canonical Git-common-directory validation,
  bounded quotas, and crash-safe cleanup;
- exact operation/job handles for status, result, follow-up, and cancel, with no
  implicit latest selection once several operations are active;
- private authority for several execution targets without weakening the
  current immutable execution-workspace claim for any individual turn;
- recovery, worker leases, cancellation, and SessionEnd settlement scoped to
  exact `{workspace, job, operation, ZCode session}` evidence;
- resource controls for concurrency, processes, disk use, fairness,
  cancellation, and abandoned-worktree retention;
- an explicit merge or cherry-pick flow with deterministic ordering and visible
  conflicts, never automatic resolution of ambiguous changes;
- macOS, Linux, and Windows qualification for worktree, locking, cleanup, crash,
  and integration behavior.

Safe variants worth evaluating are managed worktrees per operation, exact
user-supplied existing worktrees, or a queued UX that remains serialized in
one worktree. Read-only parallelism plus one writer remains supported. Unsafe
same-worktree path-based concurrency is rejected.

## Acceptance criteria for reconsideration

The deferred decision may be revisited only if evidence shows:

1. no two active writable executions share a canonical worktree;
2. concurrent operations in separate linked worktrees produce isolated
   changes, private state, bindings, results, and cancellation targets;
3. allocation races cannot create duplicate ownership or orphaned worktrees;
4. status, result, continuation, cancel, recovery, and SessionEnd always select
   one exact operation without latest fallback;
5. uncertain stop or crash state retains only the affected operation's guard,
   and a stale loser issues no stop against a newer operation;
6. origin and sibling worktrees receive no unintended files or private state;
7. integration conflicts are surfaced and existing single-workspace safety,
   privacy, error, source/marketplace, and CI contracts remain intact; and
8. benchmarks show a material end-to-end latency or throughput improvement
   after allocation and integration overhead.

## Current change boundary

This ADR is retained in the source repository for future product and
architecture evaluation. The current change does not add it to the npm package
or generated marketplace payload; that packaging decision may be revisited
with the deferred feature.

The exact-continuation-target implementation must not change
`makeReservedJob`, `isActiveWritableJob`, `WRITABLE_JOB_EXISTS`, workspace
reservation locks, scavenge-then-retry behavior, one-target-per-turn claims,
SessionEnd/recovery assumptions, or existing one-writer tests. It adds no
worktree allocator, scheduler, concurrency flag, multi-target execution, merge
automation, or same-workspace concurrency behavior.
