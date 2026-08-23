# Rescue Persisted Child Reactivation Design

Status: approved for implementation on 2026-08-23

## Problem

Codex persists spawned V2 subagent identities with their thread history, parent
thread, canonical agent path, Role, and working directory. Resuming the parent
Codex thread restores those identities into the agent registry without loading
each child runtime. An exact `followup_task` to the persisted agent path lazily
loads the same child thread and continues its history.

The current Rescue instructions cannot use that behavior safely. Root relies on
its current in-memory agent listing and, when the old child is absent there,
attempts a new `spawn_agent` with the same presentation name. Codex rejects the
spawn because the persisted path is already registered:

```text
live agent path collision at /root/zcode_rescue_task
```

The rejected spawn creates no new child. The original child still exists, but
the plugin has no programmatic route plan telling Root to follow it up.

Following up the old child manually is also insufficient. Current preparation
generation one is intentionally unbound, while a stopped executor is accepted
only through an existing durable Rescue binding or a same-parent-turn
generation greater than one. A stopped legacy child that failed before it
published a binding therefore reaches `EXECUTOR_IDENTITY_NOT_FOUND`, even when
Codex successfully restored its original thread.

The reported compatibility case spans all of these boundaries:

```text
old plugin creates /root/zcode_rescue_task in a linked worktree
  -> child stops before a usable Rescue binding exists
  -> Codex and plugin are upgraded
  -> parent Codex thread is resumed
  -> persisted child identity exists but runtime is unloaded
  -> Root does not see a live child and attempts the same spawn name
  -> Codex rejects the path collision before creating a child
```

Collision handling is the visible symptom. The missing feature is a plugin-owned
cross-parent-turn reactivation protocol for an exact persisted Rescue child.

## Goals

- Recover the exact persisted Rescue child thread and history after its parent
  Codex thread resumes.
- Make the plugin decide whether Root must follow up an existing child or spawn
  a new one before Root performs either host action.
- Use the public Codex app-server protocol rather than Codex private SQLite,
  rollout parsing, internal Rust APIs, or an upstream Codex change.
- Join Codex host identity with existing plugin executor provenance so neither
  source alone authorizes Rescue execution.
- Introduce a current-turn, one-shot reactivation authority for a stopped child
  without weakening same-parent-turn continuation generations.
- Support a stopped legacy child created by the previous plugin when its exact
  host identity and plugin executor provenance remain valid.
- Preserve PR #39 linked-worktree late binding and PR #40 origin-route
  resolution.
- Keep task text, thread IDs, parent IDs, workspace paths, permission snapshots,
  and private route fields out of public Root/child messages.
- Keep every app-server request, pagination loop, artifact read, and route scan
  explicitly bounded.
- Regenerate and verify the installed marketplace snapshot.

## Non-goals

- Do not use ZCode Rescue to implement, review, or repair this change.
- Do not modify Codex, require a new Codex collaboration API, or read its private
  state database directly.
- Do not start a child turn through app-server `turn/start`. The existing Codex
  agent manager remains the owner of child runtime loading and follow-up.
- Do not treat a spawn collision as proof that the colliding child is Rescue or
  as permission to follow it up.
- Do not infer a child from its display name alone.
- Do not revive a child whose plugin executor provenance is missing, corrupt,
  ambiguous, belongs to another parent, or points to another immutable
  workspace route.
- Do not make preparations, pending choices, caller capabilities, or
  reactivation records timeless or reusable.
- Do not change ordinary subagent restoration, generic Codex resume behavior,
  ZCode session ownership, or broker reconciliation.
- Do not expose a public thread-list, executor-list, path lookup, or arbitrary
  follow-up command.

## Considered Approaches

### 1. Query Codex app-server and join plugin provenance (chosen)

The plugin lists persisted thread-spawn subagents through a short-lived
`codex app-server` connection. It validates and filters the bounded response to
the exact active parent thread, then joins each candidate by child thread ID to
the plugin's routed executor records. A successful join provides both facts
required for recovery:

- Codex proves the persisted thread's canonical agent path and parent relation.
- The plugin proves that the same thread was an authorized Rescue executor for
  the exact parent and immutable execution workspace.

The preparation transaction persists the selected action and, for follow-up,
the exact executor identity. Root receives only a bounded task-free route
directive and executes the prescribed collaboration action.

Advantages:

- recovers existing children without private storage coupling;
- handles unloaded runtimes because thread metadata is persisted;
- obtains the exact agent path that hooks do not currently receive;
- retains current hook-state authority and worktree routing;
- extends an app-server client seam the plugin already owns and tests.

### 2. Use only a new plugin-local child registry

Future spawns could reserve a name and let `SubagentStart` attach the child
thread ID. Current hooks do not receive the canonical agent path, so the
registry cannot reconstruct old paths and cannot solve the reported legacy
session without guessing. It would also duplicate host-owned thread metadata.

This is rejected as the primary design. The private preparation still records
the chosen route, but Codex remains the source of truth for persisted path and
parent relation.

### 3. Start a turn directly on the child thread through app-server

The plugin could resume the old thread and call `turn/start` itself. That would
create a second runtime owner outside the active parent's collaboration manager.
Child notification, wait, interrupt, hook lifecycle, and parent/child causality
would split between two app-server processes.

This is rejected. The plugin plans and authorizes; Codex's existing
`followup_task` continues to own lazy loading and collaboration lifecycle.

## Chosen Architecture

The design adds two deep interfaces and one private authority concept:

1. `codex-app-server` lists bounded persisted thread-spawn children.
2. a Rescue route planner joins those host records to validated hook-state
   executor routes and allocates a follow-up or spawn action;
3. `RescuePreparationStore` persists an optional one-shot cross-turn
   reactivation target separately from same-turn generation continuation.

The external flow is:

```text
Root role-status rescue
  -> parent prepare rescue receives the private task through the existing TTY
  -> plugin lists persisted thread-spawn children for this Codex home
  -> plugin filters exact current parent and validates bounded host metadata
  -> plugin joins host child ID to exact routed Rescue executor provenance
  -> plugin atomically saves preparation plus route activation
  -> plugin prints one task-free route directive
       followup: exact persisted agent path
       spawn: exact free presentation task name
  -> Root performs exactly that one collaboration action
  -> child runs the unchanged fixed invoke-prepared launcher
  -> child consumes preparation using ambient CODEX_THREAD_ID
  -> plugin verifies the activation, lifecycle, route, workspace, and permission
  -> ordinary Rescue execution continues
```

The app-server client never performs a child action. The Root-facing skill does
not choose a candidate, construct a fallback name, or interpret a collision.

## Stable Codex App-Server Discovery

Extend the existing bounded, short-lived app-server client with a conceptually
equivalent interface:

```js
listCodexThreadSpawnChildren(options)
  -> [{ id, parentThreadId, agentPath, agentRole, cwd, status,
        createdAt, updatedAt }]
```

The actual return type is defensively copied and exposes only fields required
by the route planner.

### Protocol sequence

The client:

1. starts the configured `codex app-server` without a shell;
2. initializes with `capabilities: null`, preserving the current stable client
   contract and opting into no experimental API;
3. calls `thread/list` with
   `sourceKinds: ["subAgentThreadSpawn"]`, bounded `limit`, newest-first
   ordering, and the current pagination cursor;
4. locally filters the stable nested spawn parent inside
   `source.subAgent.thread_spawn`, reconciling the top-level
   `thread.parentThreadId` compatibility field as described below;
5. follows `nextCursor` until completion or a strict page/item budget;
6. terminates and reaps the app-server on success or every failure.

The design deliberately does not use `thread/list.parentThreadId`. That request
parameter is experimental in the current Codex protocol and would require the
`experimentalApi` capability. Stable source filtering plus local exact-parent
filtering provides the needed behavior without that dependency.

Codex 0.117 exposes a global `thread/list` compatibility shape in which the
stable nested spawn parent can safely prove that a row is foreign while the
top-level parent is `null`. A row is provably foreign and may be ignored before
full child validation only when its bounded stable nested spawn parent differs
from the requested parent and its top-level parent is either `null` or the same
value as that nested parent. Even then, a bounded safe foreign thread ID
participates in duplicate detection across the whole response. A current-parent
row, a contradictory top-level parent, or any missing, non-string, control-
bearing, oversized, or otherwise unsafe parent evidence is rejected and fails
closed rather than being classified as foreign.

The client must reject:

- malformed JSON-RPC frames or ambiguous result/error envelopes;
- duplicate, cyclic, control-bearing, oversized, or unsafe pagination cursors;
- a response exceeding line, total-output, depth, node, page, or item limits;
- current-parent or unproven thread records with missing, contradictory, or
  unsafe parent/source identity;
- invalid, relative, noncanonical, control-bearing, or oversized agent paths;
- duplicate thread IDs with unequal metadata;
- duplicate agent paths assigned to unequal child thread IDs;
- unsupported source shapes masquerading as thread-spawn children.

An unloaded persisted child remains eligible. Its runtime status is not used as
plugin authorization. Hook executor state and the selected operation mode own
that decision.

## Rescue Route Planning

The planner runs inside `prepare rescue`, after the private task envelope and
active parent authority have been validated but before the preparation is
published. It receives no caller-supplied child ID, path, target workspace, or
task name.

For every exact-parent host child, the planner asks the existing hook-state deep
module to resolve the child by ID from its recorded origin cwd. PR #40 route
resolution then validates an origin route and the target executor when the
executor lives in a linked worktree.

Candidate collection requires all of the following:

- host `parentThreadId` equals the current active parent session;
- source parent ID independently equals that same value;
- host child ID equals the hook executor `agentId`;
- the executor has trusted Rescue Role evidence under existing named or
  qualified-generic compatibility rules;
- the executor parent session equals the active parent session;
- origin and target workspaces are canonical and match the immutable lifecycle
  binding;
- permission and parent generation provenance are structurally valid;
- the executor is stopped for reactivation, not active, pending, or malformed;
- the host agent path is a bounded canonical child of `/root` and not `/root`.

Age alone does not discard stopped provenance during this planner. The current
turn's new activation supplies fresh one-shot authority. Every structural,
ownership, Role, workspace, and route check remains mandatory.

### Candidate selection

Selection is operation-aware:

- For an explicit or materialized `resume`, select only the executor attached
  to the exact eligible durable Rescue binding and candidate session.
- For `fresh`, prefer the exact managed base path when it is an eligible Rescue
  executor. Otherwise choose the newest eligible stopped Rescue executor by
  `(createdAt, childId)` after the full set has been validated.
- A duplicate child ID, duplicate agent path, multiple binding matches, or tied
  contradictory metadata is ambiguity and fails closed.
- A host child without plugin executor provenance is not reactivation-eligible.
  Its path still remains occupied for spawn-name allocation.

Choosing any validated stopped executor for a fresh operation is safe because
the child is a session-scoped Rescue forwarder, not the owner of one permanent
ZCode operation. The new preparation remains the sole business operation and
the existing StateStore still owns fresh replacement semantics. Therefore a
fresh operation means a new independent ZCode operation and peer session, not a
guarantee of a newly allocated Codex child; reactivation never resumes the
prior ZCode binding or session. A collision remains occupancy input only and is
never authority for selecting the executor or operation mode.

### Spawn allocation

When no eligible persisted executor exists, the planner allocates a free
presentation name from the existing Rescue grammar. It compares the canonical
path that Codex will derive for each candidate name against every validated
persisted child path under the parent, including non-Rescue children.

The allocation chooses the base name first and then bounded ordinals. It
persists the exact expected presentation name in the preparation. It does not
reserve or create a Codex child itself.

If app-server discovery is unavailable or cannot prove the complete bounded
set, the planner fails. It does not guess a random name, attempt a spawn, or use
the resulting collision as a fallback protocol.

## Private Preparation and Reactivation Authority

Version the private preparation record to add a route activation distinct from
the existing envelope and same-turn generation fields:

```json
{
  "version": 3,
  "generation": 1,
  "sessionId": "current parent thread",
  "turnId": "current parent turn",
  "workspace": "immutable execution workspace",
  "permissionMode": "current permission",
  "envelope": "existing private Rescue envelope",
  "activation": {
    "kind": "reactivate",
    "executorAgentId": "persisted child thread",
    "agentPathDigest": "digest of canonical persisted agent path"
  },
  "requiredExecutorAgentId": null,
  "createdAt": "RFC3339",
  "expiresAt": "RFC3339",
  "consumedAt": null,
  "executorAgentId": null
}
```

A spawn preparation instead records:

```json
{
  "activation": {
    "kind": "spawn",
    "taskName": "bounded selected Rescue presentation",
    "agentPathDigest": "digest of the canonical path derived from that name"
  }
}
```

The exact field representation may be flattened if existing codecs remain
clearer, but these invariants are mandatory:

- activation is present on every new-version generation one record;
- `reactivate` contains one exact executor ID and a path digest, never a
  persisted public path;
- `spawn` contains no executor ID and binds the expected task name to its
  derived path digest;
- generation one `requiredExecutorAgentId` remains null;
- generation greater than one retains the current exact
  `requiredExecutorAgentId` same-turn continuation contract;
- activation and required-executor authority cannot both target different
  executors;
- save and consume remain create-only, atomic, one-shot, bounded, and private.

This separation prevents two meanings from being overloaded:

- activation answers which host child may enter this new parent-turn
  preparation;
- generation continuation answers which already-consuming child may consume a
  later preparation in the same still-active parent turn.

### Reactivation consume

Before either activation kind may consume the preparation, the child performs
one bounded `thread/read` for its ambient `CODEX_THREAD_ID` through the same
short-lived app-server client. It validates the returned child ID, exact parent
thread, source parent, agent path, Role, and cwd. This is an independent
child-side host proof; it does not trust the Root-facing directive or copy the
planner's earlier response into the consumer.

For a spawn activation, the child additionally requires the host Role and
canonical path to match the selected task name and stored path digest before
ordinary active-executor consumption proceeds. This closes the race between
planning a free name and Codex creating the child. A collision, substituted
task name, unexpected Role, or app-server read failure rejects consumption
before reservation or ZCode RPC.

A stopped child may consume generation one only when:

- activation kind is `reactivate`;
- ambient `CODEX_THREAD_ID` exactly equals the activation executor ID;
- the independently reread host path digest and persisted activation digest
  match;
- the executor and routed target independently pass the same validations used
  by the planner;
- the active parent session, new parent turn, workspace, permission, and
  lifecycle binding match the preparation;
- no sibling has consumed or replaced the preparation;
- the preparation has not expired.

The stopped hook record is not rewritten to active. Codex follow-up may load an
existing child without emitting a new `SubagentStart`; the one-shot activation
is the current execution authority. A later `SubagentStop` remains idempotent.

For `fresh`, the reactivated child may create a new Rescue operation even when
its earlier attempt never produced a durable binding. For `resume`, every
existing exact binding and candidate guard remains mandatory. Reactivation
never converts a requested resume into fresh.

### Legacy compatibility

No persisted legacy preparation is rewritten in place. A new parent prompt
creates a new version-three generation-one preparation.

An old child is compatible when current app-server metadata proves its exact
parent/path/thread relationship and current plugin hook state proves its exact
Rescue executor and route provenance. Existing stopped-age expiry is bypassed
only inside this freshly published reactivation activation. Missing or corrupt
hook evidence cannot be reconstructed from host metadata and therefore cannot
reactivate the old child.

If an incompatible old child occupies the base path, spawn allocation skips it
and creates a bounded ordinal Rescue child. The plugin never sends the launcher
assignment to a child it cannot authenticate as Rescue.

## Root-Facing Route Directive

Successful preparation prints exactly one machine-readable, task-free
directive. Conceptually:

```json
{"version":1,"action":"followup","target":"/root/zcode_rescue_task"}
```

or:

```json
{"version":1,"action":"spawn","taskName":"zcode_rescue_task_2"}
```

The renderer and parser own exact keys, byte limits, action vocabulary, path
grammar, and task-name grammar. No directive contains task text, child thread
ID, parent ID, workspace, permission, preparation key, binding, or ZCode
session ID.

The Rescue skill must execute exactly one prescribed action:

- `followup` -> `followup_task(target, fixed launcher assignment)`;
- `spawn` -> `spawn_agent(task_name, Role or qualified generic fallback, fixed
  launcher assignment)`.

It must not spawn first, derive ordinals itself, substitute a target, retry on a
collision, or fall back from a failed follow-up to spawn. Any host rejection is
terminal for that preparation; Root must run a new readiness/preparation cycle
so the plugin can inspect fresh state.

Existing active-child rejoin remains higher precedence before preparing a new
operation. The new route planner addresses stopped or unloaded persisted
children, not concurrent messaging into an active Rescue execution.

## Error Semantics

Errors remain task-free and metadata-free:

- app-server unavailable, timeout, disconnect, incompatible protocol, or
  bounded-list exhaustion: `CODEX_CHILD_DISCOVERY_FAILED`;
- malformed or contradictory host child metadata:
  `CODEX_CHILD_METADATA_INVALID`;
- multiple exact recovery candidates or contradictory path ownership:
  `RESCUE_CHILD_AMBIGUOUS`;
- host candidate exists but plugin provenance or immutable route is invalid:
  preserve the existing executor/route corruption family;
- reactivation consumer differs from the selected executor:
  `EXECUTOR_IDENTITY_MISMATCH`;
- route directive is malformed or inconsistent with its stored preparation:
  `RESCUE_ROUTE_INVALID`;
- host follow-up/spawn action is rejected: preparation remains unconsumed and
  expires or is cleaned by the existing parent-turn lifecycle; no automatic
  second host action occurs.

Public remedies may say to restart Codex, rerun the Rescue request, or create a
new parent prompt. They must not render candidate counts, IDs, paths, Role
records, origin/target workspace, or raw app-server errors.

## Security and Privacy Invariants

1. App-server metadata is discovery evidence, never sufficient execution
   authority.
2. Hook executor provenance is plugin authority, but cannot supply an agent
   path; the exact join is mandatory for reactivation.
3. Root receives a task-free action and presentation target only.
4. The child receives the same fixed launcher assignment used today.
5. Ambient child thread identity is the only child-supplied identity input.
6. Task text remains confined to the parent TTY preparation envelope and
   private preparation storage.
7. Agent path is never accepted from task text, prompt parsing, argv,
   environment overrides, or child output.
8. All host and plugin records are bounded, exact-schema, nofollow where stored,
   and validated before selection.
9. Ambiguity, partial discovery, unsupported versions, and stale current-turn
   authority fail closed.
10. Reactivation authority is current-turn, expiring, atomic, and single-use.

## Compatibility

- Current named `zcode-rescue` children retain their exact Role path.
- Qualified generic/default fallback children remain supported only when their
  existing hook provenance independently qualifies them as Rescue.
- Existing version-one and version-two preparations retain their strict current
  read/consume behavior; only new saves use the new activation schema.
- Same-parent-turn proactive continuation remains generation based and retains
  the exact previously consuming executor.
- PR #39 worktree binding remains immutable.
- PR #40 origin-to-target route resolution is reused rather than duplicated.
- Existing active-child wait/rejoin behavior remains first precedence.
- Older Codex versions without the required stable `thread/list` source data
  fail readiness/recovery with an upgrade remedy rather than guessing.

## Test Strategy

### App-server client unit tests

- initialize then page stable `subAgentThreadSpawn` results;
- filter exact parent locally without sending experimental parameters;
- accept an unloaded persisted child with valid source metadata;
- reject contradictory parent/source IDs, invalid paths, duplicate IDs,
  duplicate paths, unsafe cursors, malformed frames, output limits, page limits,
  item limits, timeout, disconnect, and JSON-RPC error;
- terminate and reap the child process on every terminal path;
- prove no app-server response can reach public errors unredacted.

### Route planner tests

- join one stopped root-workspace executor to its exact persisted host child;
- join one stopped linked-worktree executor through its PR #40 origin route;
- select an exact bound executor for resume;
- select the managed base executor, then deterministic newest compatible
  executor, for fresh;
- treat incompatible host paths as occupied while excluding them from
  reactivation;
- allocate the first free bounded spawn name;
- fail on missing complete discovery, ambiguous binding, duplicate metadata,
  corrupt route, wrong parent, wrong Role, wrong permission, or workspace drift;
- return only the exact task-free directive fields.

### Preparation and Companion TDD regression

Create a generation-one reactivation test reproducing the incident:

1. old hook artifacts contain one stopped Rescue executor in a linked worktree;
2. the child has no durable Rescue binding;
3. app-server lists the same child under the resumed parent and base agent path;
4. a new parent turn prepares a fresh Rescue operation;
5. preparation returns `followup` rather than `spawn`;
6. the same ambient child ID consumes the preparation;
7. a sibling ID, wrong path digest, wrong workspace, wrong permission, replay,
   expiry, or missing executor evidence fails before reservation or ZCode RPC;
8. the exact reactivated child may start fresh without an old binding.

Add a separate resume case proving a reactivated child resumes only its exact
binding. Keep existing generation-two same-parent-turn tests unchanged and add
cross-field codec mutation coverage for every activation variant.

### Installed qualification

Extend the captured Codex qualification with an old-child restoration fixture:

- initial parent spawns one Rescue child in a linked worktree;
- child stops;
- parent is resumed with child runtime initially unloaded;
- app-server metadata is discovered through the installed client path;
- Root performs one exact follow-up and zero spawn calls;
- the child thread ID and agent path remain the original values;
- one fixed child launcher call executes in the immutable target worktree;
- private task text appears only in the preparation transport and private
  evidence;
- no collision error is used as evidence.

The authenticated real-ZCode route remains opt-in, but its preflight must prove
the installed app-server discovery and reactivation contract before spending
model credits.

### Full verification

Run focused tests during RED/GREEN, then:

```bash
npm run check:line-endings
npm run lint
npm run typecheck
npm test
npm run test:qualified
```

Regenerate the marketplace snapshot through the repository's verified builder
and rerun source/marketplace parity tests. The final branch receives an
independent spec review and code-quality review before the PR is opened.

## Documentation

Update the English and Chinese Rescue guidance to state:

- persisted stopped children are recovered before a new child is spawned;
- recovery restores the original Codex child thread and history;
- the plugin plans the route through Codex app-server metadata plus private
  executor provenance;
- a missing or ambiguous recovery proof fails closed;
- an active child is still waited/rejoined rather than reactivated;
- neither a 30-minute executor age nor a spawn collision is the recovery
  authority.

Add an Unreleased changelog entry. Do not document private commands, activation
fields, thread IDs, storage paths, or app-server response shapes as public API.
