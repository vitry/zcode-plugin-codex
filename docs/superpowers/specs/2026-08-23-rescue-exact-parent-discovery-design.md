# Rescue Exact-Parent Discovery Design

Status: approved compatibility amendment on 2026-08-23

## Problem

PR #41 plans Rescue activation from `codex app-server` persisted child metadata.
Its first implementation calls global `thread/list` with
`sourceKinds: ["subAgentThreadSpawn"]`, then filters rows locally by the parent
thread ID. That query is not a complete view of a restored parent's agent
registry.

The production incident at 2026-08-23T21:43:12+08:00 reproduced the gap:

- parent `01a022d7-aa12-7112-abe0-78036571802e` was resumed;
- global spawn-child listing returned no matching rows;
- preparation prescribed `spawn zcode_rescue_task`;
- Codex rejected `/root/zcode_rescue_task` as already existing;
- the same app-server, queried with the exact `parentThreadId`, returned the
  persisted `notLoaded` child at `/root/zcode_rescue_task` and a sibling at
  `/root/plan_audit`.

Both returned children have an empty preview. Codex global thread listing
excludes empty-preview records, while relationship listing deliberately sets
`include_empty_preview=true` and reads the spawn-edge graph. Codex restores its
V2 agent registry from that same graph, so the global list and the registry can
legitimately disagree.

## Goals

- Discover the same exact direct-child set that Codex uses to restore the
  resumed parent's agent-path registry.
- Treat every validated direct child path as occupied, including children with
  no task preview and children without plugin executor provenance.
- Preserve the existing rule that only a host child joined to exact private
  stopped-executor provenance may be followed up.
- Keep discovery, pagination, output, time, and child-count bounds.
- Fail closed when exact-parent discovery is unsupported, rejected, malformed,
  incomplete, or ambiguous.
- Keep Codex 0.147 as the pinned qualified host line and cover the observed
  Codex 0.149 behavior without claiming a new qualified line.

## Non-goals

- Do not read Codex SQLite, rollout JSONL, or other private storage.
- Do not infer occupancy from a spawn rejection or retry after a collision.
- Do not follow up a host-only child whose Hook executor provenance is absent.
- Do not combine global and relationship results or guess that either partial
  set is complete.
- Do not use ZCode Rescue to implement, review, or validate this change.

## Considered Approaches

### Exact-parent relationship query (chosen)

Initialize app-server with `capabilities.experimentalApi: true` and call
`thread/list` with the exact `parentThreadId`, the existing
`subAgentThreadSpawn` source filter, and the existing bounded pagination.

This is the only public app-server query whose storage semantics match Codex's
restored agent registry and include empty-preview children. The query works on
the pinned Codex 0.147 binary and the incident's Codex 0.149 binary.

### Global query plus relationship fallback

Rejected. A nonempty global result is still not proof of completeness, so the
relationship query must always run. Keeping both sources adds ambiguity and
failure modes without reducing compatibility risk.

### Plugin-local occupancy records

Rejected. Hook records do not contain canonical host paths for every ordinary
or legacy child, and missing plugin provenance is exactly a case where path
occupancy still matters.

## Protocol Contract

`listCodexThreadSpawnChildren(parentThreadId, options)` remains the public deep
interface. Internally it changes only its app-server request contract:

1. initialize with the same bounded client identity and
   `{ "experimentalApi": true }` capability;
2. validate the initialized `userAgent` as a Codex version whose protocol is
   known to implement `thread/list.parentThreadId` (semver 0.141.0 or newer),
   without assuming a fixed originator prefix;
3. send `thread/list` with:
   - `parentThreadId` equal to the validated requested parent;
   - `sourceKinds: ["subAgentThreadSpawn"]`;
   - the existing page size, cursor, created-at descending sort, and limits;
4. validate every returned row with both top-level and nested parent fields
   equal to the requested parent;
5. reject rather than ignore any foreign, missing, contradictory, unsafe, or
   duplicate row because the server has promised an exact direct-child set;
6. require pagination to terminate within the existing bounds;
7. terminate and reap app-server on every outcome.

The request does not need `ancestorThreadId`: Rescue activation is owned only by
the current parent's direct children. It does not need `useStateDbOnly`; the
relationship filter already selects the spawn graph and normal app-server
repair behavior remains available.

If initialize or `thread/list.parentThreadId` is unavailable, the operation
returns the existing controlled discovery failure. It must not fall back to the
incomplete global query or prescribe a spawn.

This explicit support check is required for older Codex versions such as 0.117:
their JSON decoder accepts `experimentalApi` but silently ignores the unknown
`parentThreadId` request field, turning the request into an incomplete global
list. An empty response therefore cannot serve as a feature probe. Unknown or
unparseable Codex versions fail closed; the plugin does not claim completeness
from a response whose relationship-query semantics are unproven. The parser
handles a slash-bearing Codex originator and semver prerelease/build suffixes,
while preserving normal semver ordering at the 0.141.0 support boundary.

## Authorization and Planning

The route planner remains unchanged in authority:

- every validated returned path enters the occupied set;
- a stopped child becomes a follow-up candidate only after exact Hook executor
  resolution and the existing Role, parent, permission, origin, target, and
  workspace checks;
- a host-only `/root/zcode_rescue_task` therefore forces
  `zcode_rescue_task_2`, but never authorizes follow-up;
- an exact stopped Rescue executor still receives the one-shot reactivation
  authority and exact follow-up route.

## Testing

The app-server regression must model the actual failing distinction, not merely
assert the new request field:

- the fake server holds an empty-preview direct Rescue child and an unrelated
  child;
- without `parentThreadId`, its global response omits the empty-preview child;
- with exact relationship filtering, it returns the child;
- the production client must emit the experimental capability and exact parent
  filter, then return the child;
- a foreign row in an exact-parent response must fail closed rather than be
  silently skipped.

The Companion integration regression must replay the incident outcome:

- exact-parent discovery returns a host-only child at the base Rescue path;
- no stopped executor provenance exists for that child;
- preparation returns `spawn zcode_rescue_task_2`, not the colliding base name;
- no follow-up, retry, direct invocation, or private payload exposure occurs.

Existing restored-child follow-up, linked-worktree fake ZCode response,
cancellation, pagination, malformed metadata, marketplace, and qualification
tests remain mandatory.
