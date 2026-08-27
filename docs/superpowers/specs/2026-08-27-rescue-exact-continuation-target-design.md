# Rescue Exact Continuation Target Amendment

## Status and precedence

This amendment is accepted for the exact continuation-routing defect observed
on 2026-08-27. It supersedes the targetless selection rules in the 2026-08-25
Rescue exact-binding migration amendment and ADR 0013 only when Root supplies
the private exact continuation target defined here. Every other safety rule
remains effective, including exact parent discovery, full child metadata
validation, durable binding and original-session validation, canonical
workspace and permission checks, lock/CAS publication, one-use preparation,
writable-job exclusion, bounded parsing, and fail-closed errors.

The motivating incident is
`log/2026-08-27T103515+0800-zcode-rescue-child-ambiguous.txt`. The active Root
had two complete resumable Rescue bindings. Root intended to continue
`/root/zcode_rescue_task_3`, but the private preparation frame carried only
`resume`; the planner therefore had no semantic selector and correctly failed
with `RESCUE_CHILD_AMBIGUOUS` before following either child.

The correction is narrow: Root retains the exact child handle returned by the
host lifecycle and supplies it only in the existing private preparation frame.
The plugin validates that selector against its own complete evidence before it
emits a follow-up route. No public Rescue argument or child assignment changes.

## Terms and invariants

An **exact continuation target** is the private pair:

```json
{
  "childId": "<exact Codex child thread ID>",
  "agentPath": "/root/<exact canonical agent path>"
}
```

Root forms this pair only after exactly correlating one successful
`spawn_agent` call, its output, and one `sub_agent_activity.started` record
through both equalities:

```text
started.event_id == spawn.call_id
started.agent_thread_id == spawn.output.agent_id
```

The retained child ID is `spawn.output.agent_id`; the retained path is the
matched started record's `agent_path`. Either record may arrive first, so Root
waits for its unique counterpart before retaining the pair. Missing,
duplicate, or mismatched output/activity counterparts fail closed. Root must not pair a partial, unmatched, or mismatched lifecycle, and it must never guess, derive, or synthesize the path from `taskName` or another presentation value. Root retains the unchanged pair across follow-up,
stopping, restoration, and later conversation turns with the logical Rescue
operation. The pair is a selector, not authority:
the plugin must independently rediscover the exact parent child and validate
its Role/type, path, state, workspace, stopped-executor provenance, permission,
binding, operation, generation, jobs, and original non-empty ZCode session.

The following invariants are absolute:

- Public syntax remains `$zcode:rescue ... --resume`; no child, session, job,
  binding, or operation selector is added to the command line.
- The launcher argv and child assignment remain the constants `prepare rescue`
  and `invoke-prepared rescue`; the target exists only in the private LF frame
  and the private preparation record.
- Root chooses a target from exact host handles it previously received. It
  never derives a target from path suffix, timestamps, list order, latest job,
  latest session, or workspace proximity.
- Targeting narrows discovery but grants no authority. Every existing exact
  binding and child proof remains mandatory.
- A missing, malformed, cross-paired, duplicated, ineligible, or changed target
  fails closed with no sibling substitution, fresh fallback, mutation, or ZCode
  RPC.
- Omitting the target preserves the existing compatibility behavior: exactly
  one complete usable binding may resume; two or more remain
  `RESCUE_CHILD_AMBIGUOUS`.
- `fresh` never carries a continuation target and retains collision-free new
  child allocation.
- The one-active-writable-job-per-canonical-workspace policy is unchanged.

## Private preparation protocol

### Envelope versions

The reader accepts two exact private envelope schemas:

```json
{"version":1,"source":"explicit","task":"...","options":{"resume":"resume"}}
```

Version 1 is retained as a targetless compatibility frame and has exactly its
existing four top-level keys.

```json
{
  "version":2,
  "source":"explicit",
  "task":"...",
  "options":{"resume":"resume"},
  "continuationTarget":{"childId":"...","agentPath":"/root/..."}
}
```

Version 2 has exactly five top-level keys. `continuationTarget` is either
`null` or the exact two-key object above. New Skill instructions always emit
version 2. A non-null target is valid only when `options.resume` is `resume`;
fresh or a non-resume request must use `null`.

The implementation must split the private envelope version constants from the
persisted preparation-record version constants. Envelope evolution must not
change classification of legacy v1 preparation records. The persisted record
remains schema v3 and stores the validated envelope without adding a duplicate
target field.

`childId` is a non-empty, control-free UTF-8 string of at most 512 bytes.
`agentPath` is a canonical absolute Codex agent path matching the existing
agent-path grammar and bounded to at most 1024 bytes. Unknown, extra, missing,
duplicate, null object members, invalid UTF-8, control characters, excess
bytes, and target-plus-fresh are rejected before child discovery. Validation
returns defensive copies. The envelope byte limit must explicitly cover the
maximum valid pair.

The serialized pair and `continuationTarget` object may exist only in the
private frame/record. The individual `childId` and `agentPath` necessarily
exist in their original linked host lifecycle/tool results. The plugin must not
additionally propagate the pair or `childId` into Rescue argv, environment
variables, status/result output, relay messages, progress, child transcript,
public route fields, or the ZCode request. The `agentPath` is already a host
routing value: after it is independently rediscovered and validated, it may
also appear by itself in the existing follow-up route's `target`. That
occurrence is not treated as private selector propagation and does not
authorize the route.

## Root selection contract

For an exact resume, Root:

1. Resolves the user's intended logical Rescue operation from the current
   conversation and its own prior spawn/follow-up tool results.
2. Retrieves that operation's exact retained `childId` and `agentPath` pair,
   whose members came from the same linked spawn/start lifecycle.
3. Runs the unchanged fixed `prepare rescue` launcher command.
4. Sends one version-2 private JSON frame containing the pair through the
   existing preparation PTY only after the readiness line.
5. Executes only the route directive returned by the plugin.

Before preparation, an explicit request with neither `--resume` nor `--fresh`
is classified by counting only retained stopped operations whose logical
operations could match the complete request semantics. These are semantic
candidates; unrelated retained operations do not count.

The zero, one, and more than one semantic-candidate branches below apply only to an explicit no-choice request.

Zero semantic
candidates means `fresh` with `continuationTarget: null` and no clarification.
With one semantic candidate and total retained stopped operations more than one,
Root asks exactly once before prepare whether to resume or start fresh. A resume
answer uses that candidate's exact pair; a fresh answer uses
`continuationTarget: null`. With more than one semantic candidate, Root asks exactly once before prepare,
follow-up, or spawn. One answer simultaneously resolves both dimensions:
either `fresh`, which uses `continuationTarget: null`, or `resume` plus one
logical operation, which uses that operation's exact retained pair. Root does
not ask a separate operation question and then a separate resume/fresh
question. The legacy targetless choice flow remains available only when the total retained stopped operations is exactly one and it is the sole semantic candidate: Root omits `resume`, sends
`continuationTarget: null`, follows the plugin's unique route, and the selected
child may return the same-child `needs-choice` result. This single-operation
compatibility path cannot be used when any additional retained stopped
operation would make targetless planning ambiguous.

Proactive routing remains outside this triage. For a proactive clear continuation, Root materializes `resume`; if its exact retained pair is unavailable, it clarifies or fails closed and never uses fresh/null as a fallback. A proactive clear independent task still materializes `fresh`.

Root does not put the pair in commentary, the public Rescue command, launcher
argv, child assignment, or a ZCode prompt. Root also does not manufacture or
repair one member from another, including by concatenating a returned task name
with `/root/`. If its history does not identify one intended operation and both
members from one linked lifecycle, it asks the user which prior Rescue to
continue; the plugin never guesses.

Root does not read or decide private binding validity; it counts only retained
host lifecycle operations, while the plugin discovers and validates bindings.

For a first independent operation, explicit fresh request, or targetless
compatibility flow, Root supplies `continuationTarget: null`.

## Planner contract

The planner processes a private target in this exact order:

1. Validate the envelope and target before discovery.
2. Canonicalize origin and execution workspaces.
3. List only `thread_spawn` children of the exact active parent.
4. Validate the complete child list and global duplicate child-ID/path
   invariants. Malformed or contradictory app-server metadata retains its
   existing `CODEX_CHILD_METADATA_INVALID` failure before this planner seam.
5. When a target is present, require exactly one host child whose ID and full
   canonical path both match the target, then discard all structurally valid
   non-target siblings from executor/binding resolution.
6. Classify the selected child, resolve its stopped-executor proof when
   present, and join its exact durable binding and jobs.
7. Apply every existing Role, state, parent, workspace, permission, binding,
   operation, generation, anchor/current job, and original-session check.
8. Emit one exact follow-up activation/directive only after that join succeeds.

Global host ambiguity is checked before target filtering so a target cannot
hide duplicate IDs or paths in an otherwise sanitized child list. Malformed or
contradictory parent/path/Role metadata is rejected earlier as
`CODEX_CHILD_METADATA_INVALID`; it is never hidden by a target. Unrelated
structurally valid siblings are neither binding candidates nor a source of
ambiguity after a target matches, and their executor/binding state must not be
read.

Targetless behavior retains the existing all-candidate unique-eligibility
algorithm. Fresh behavior continues to use the full validated child list only
for collision-free path occupancy.

## Error and side-effect contract

- Invalid envelope/target shape, bounds, or target-plus-fresh returns the
  existing sanitized preparation or `RESCUE_ROUTE_INVALID` class before child
  discovery.
- Duplicate host IDs/paths in a validated/injected child list remains
  `RESCUE_CHILD_AMBIGUOUS`, even if one duplicate matches the target. Malformed
  or contradictory app-server child metadata retains
  `CODEX_CHILD_METADATA_INVALID`.
- A well-formed target absent from the exact parent's validated child list, an
  ID/path cross-pair, an unmanaged target, or a target with no eligible binding
  returns `RESCUE_BINDING_INVALID`.
- Existing specific sanitized errors remain authoritative for selected-child
  executor, Role, state, route, workspace, permission, binding, job, operation,
  generation, and ZCode-session mismatches.
- No target failure may fall back to another child or fresh, reserve or modify
  a job/binding/preparation activation, call `session/create`,
  `session/resume`, `session/send`, or `session/stop`, or expose private values.

## Lifecycle and compatibility

The planner-selected activation already captures exact executor ID, path
digest, binding key, operation, generation inputs, current/anchor jobs, and
original `zcodeSessionId`. Preparation save and child consumption retain their
existing one-use and ambient-child proof. A host or binding change after
planning therefore fails before continuation RPC and cannot redirect the
prepared turn.

Version-1 targetless frames and targetless version-2 frames remain compatible
with the unique-global-binding rule. Persisted preparation record v1/v2/v3,
legacy binding migration, foreground/background execution, result recovery,
cancel, SessionEnd, and source/marketplace packaging retain their existing
semantics except where tests must recognize the new private envelope version.

## Acceptance

1. **Exact choice among siblings:** two complete usable bindings plus a target
   for child 2 follows only child 2 and resumes its original ZCode session.
   Reversing child order, timestamps, names, and suffixes does not change it.
2. **Targetless compatibility:** the same two bindings without a target remain
   `RESCUE_CHILD_AMBIGUOUS`; one usable binding still resumes normally. Root
   never sends that ambiguous multi-operation no-choice frame: after filtering
   retained operations by request semantics, zero candidates means fresh with
   no question, one keeps the targetless same-child `needs-choice` flow, and
   more than one asks one combined operation-and-resume/fresh question before
   preparation.
3. **Cross-pair and absence:** same ID/wrong path, same path/wrong ID, missing,
   unbound, unmanaged, revoked, and ineligible targets fail without fallback,
   mutation, preparation consumption, or ZCode RPC.
4. **Global ambiguity:** duplicate ID/path in a validated child list remains
   ambiguous before filtering; malformed or contradictory app-server parent,
   path, or Role metadata fails as `CODEX_CHILD_METADATA_INVALID` before
   filtering.
5. **Exact authority:** selected-child path, Role, state, parent, workspace,
   permission, executor proof, binding, job, operation, generation, or session
   drift fails before continuation RPC; the valid v3 and exact legacy migration
   paths each retain their current behavior.
6. **Schema:** version 2 accepts `null` or a complete bounded pair, rejects all
   partial/extra/duplicate/control/oversized/target-plus-fresh variants, makes
   defensive copies, and does not break legacy persisted record v1 parsing.
7. **Privacy:** qualification permits individual child ID/path values in their
   original linked host lifecycle/tool results, but proves the serialized pair
   and target key appear only in the authorized private frame/record. It proves
   there is no additional plugin-controlled propagation of the pair or child
   ID into public syntax, argv, environment, child assignment/transcript,
   relay/status/result, output, or ZCode frames. The independently rediscovered
   agent path may additionally appear alone as the existing follow-up route
   target.
8. **Release parity:** shipped source and generated marketplace
   Skill/runtime/docs have byte parity; focused tests, full checks, packed
   installation, and required CI pass on supported operating systems and Node
   versions. The future-concurrency ADR 0014 is a source-repository decision
   record and is not added to the packaged/marketplace payload by this change.
9. **Writable exclusion:** all existing one-writer admission, scavenging,
   recovery, cancellation, and SessionEnd concurrency tests remain unchanged
   and passing.

## Out of scope

- A public selector, `zcode rescue --resume <handle>`, launcher argument,
  environment selector, new ZCode API, or direct Root-to-child execution.
- Ranking, latest/base/suffix/timestamp selection, automatic repair, jobs-only
  adoption, sibling substitution, or fresh fallback.
- Binding, job, operation, cancellation, recovery, SessionEnd, StateStore,
  filesystem, lock, lease, broker, or ZCode session protocol redesign.
- More than one active writable Rescue in one canonical workspace, automatic
  worktree allocation, scheduling, merging, or conflict resolution.

## Implementation boundary

Prefer the smallest seam: versioned private-envelope parsing, one exact target
filter in the route planner, Skill/qualification contract changes, focused
regressions, and mechanically regenerated marketplace output. Reuse all
existing binding and lifecycle authority. Do not change the launcher command,
managed child Role assignment, public Rescue syntax, durable binding schema,
or writable admission policy.
