# Rescue Canonical-Path Continuation Selector Amendment

## Status and precedence

This amendment corrects the Root-to-plugin continuation boundary introduced by
the 2026-08-27 Rescue Exact Continuation Target Amendment. It supersedes that
amendment wherever it requires Root to retain or provide a Codex child thread
ID, correlate `spawn.output.agent_id`, or correlate a flattened
`sub_agent_activity.started.event_id`. All existing authorization, binding,
workspace, Role, permission, job, ZCode-session, one-use preparation, and
fail-closed requirements remain effective.

The correction is deliberately narrow. Root selects a logical Rescue operation
with the canonical agent path returned by its own successful `spawn_agent`
call. The plugin resolves the corresponding host child ID inside the exact
parent scope, then validates the existing durable binding that already contains
both the host-issued child ID and canonical path. The public Rescue syntax,
launcher commands, child assignment, follow-up command, binding identity, and
ZCode protocol remain unchanged.

This amendment does not change the conservative rule that one canonical
workspace admits at most one active writable Rescue. The value and possible
future relaxation of that rule remain deferred by the existing ADR.

## Chosen approach and alternatives

The chosen approach uses the canonical path as Root's selector and keeps the
Codex child ID inside the plugin. It is the smallest approach that matches the
actual collaboration output while preserving the plugin's existing identity
checks.

An opaque plugin-issued continuation handle would also avoid exposing a Codex
thread ID, but it would add a new issuance, return, retention, rotation, and
recovery lifecycle for information the binding already stores. It is deferred
unless canonical-path uniqueness within the exact parent scope proves
insufficient. Changing Codex v2 to return `agent_id` would restore the previous
design's assumption, but it is an external host API change and would still
leave this plugin incompatible with existing 0.147 and 0.148 sessions.

## Corrected host contract

For Codex multi-agent v2, the model-visible result of a successful spawn is an
exact object containing the canonical task path and, depending on host
configuration, an optional nickname. The required identity-bearing field is:

```json
{"task_name":"/root/zcode_rescue_task_3"}
```

The host separately owns an internal activity item shaped like:

```json
{
  "type": "SubAgentActivity",
  "id": "<spawn call ID>",
  "kind": "started",
  "agent_thread_id": "<Codex child thread ID>",
  "agent_path": "/root/zcode_rescue_task_3"
}
```

That internal item is valid qualification evidence for the host implementation,
but its child ID is not part of the Root model's `spawn_agent` result and is not
a value the Rescue Skill may require Root to retain. Real Codex 0.147 and 0.148
captures both use this boundary. Qualification fixtures must preserve it rather
than synthesize `spawn.output.agent_id` or `started.event_id`.

## Terms and trust boundaries

A **canonical-path continuation selector** is the private object:

```json
{"agentPath":"/root/zcode_rescue_task_3"}
```

The selector identifies Root's intended logical Rescue operation. It is not
authority. Root obtains `agentPath` only as the exact canonical `task_name`
returned by the successful spawn call for that operation. Root retains that
unchanged value with the operation across later turns, restoration, and
stopping. Root does not construct it from a requested task name, suffix,
nickname, display name, list order, timestamp, workspace, binding, job, or
ZCode session.

A **host child ID** is the Codex-issued child thread ID received by the plugin
through trusted lifecycle and child-discovery boundaries. It remains private
plugin identity. It is not a plugin-generated operation ID, ZCode session ID,
or public routing argument.

The plugin's binding remains authoritative only after the selected host child,
binding authority, stopped-executor evidence when present, and durable jobs all
agree on the same parent session, child ID, canonical path, Role, workspace,
permission snapshot, operation generation, and original ZCode session.

## Private preparation protocol

The private preparation reader adds envelope version 3:

```json
{
  "version": 3,
  "source": "explicit",
  "task": "<normalized non-empty objective>",
  "options": {"resume":"resume"},
  "continuationTarget": {"agentPath":"/root/zcode_rescue_task_3"}
}
```

Version 3 has exactly the existing five top-level keys. Its
`continuationTarget` is either `null` or an exact one-key object containing
`agentPath`. A non-null target is valid only with `options.resume` equal to
`resume`. Fresh, independent, and targetless choice preparation uses `null`.
The path uses the existing canonical Codex agent-path grammar and 1024-byte
bound. Unknown, missing, duplicate, extra, malformed, noncanonical, control-
bearing, or oversized values fail before host discovery.

Private envelope version constants remain independent from persisted
preparation-record versions. Existing exact envelope v1 and v2 readers remain
compatible so already-created preparations can still be validated and
consumed. Version 2 retains its exact historical `null` or
`{childId, agentPath}` target schema; new Skill instructions never emit it.
Persisted preparation records retain their current version and store the
validated envelope without a duplicate selector field.

The serialized selector may appear only in the one private Root `write_stdin`
frame and private preparation record. It does not enter argv, environment
variables, child assignments, commentary, progress, status/result output,
relay messages, ZCode requests, or logs added by the plugin. After independent
validation, the same canonical path may continue to appear alone in the host
follow-up directive because it is the existing host routing handle.

## Root contract

For every successful Rescue spawn, Root retains the exact canonical
`spawn_agent` result `task_name` with the logical operation. No activity-event
correlation and no child ID are required at the Root boundary.

For stopped same-operation continuation, Root:

1. Selects the intended logical operation from conversation semantics and its
   own prior spawn/follow-up history.
2. Retrieves that operation's unchanged canonical path returned by spawn.
3. Runs the unchanged fixed `prepare rescue` launcher command.
4. Sends one version-3 private frame with the path selector after readiness.
5. Executes only the route directive returned by the plugin.

If Root cannot identify one intended operation and its exact retained canonical
path, it clarifies instead of guessing. The existing semantic-candidate,
explicit `--resume`/`--fresh`, proactive continuation, active-child rejoin, and
targetless single-operation choice rules remain unchanged except that every
new exact resume uses the version-3 path selector.

Root does not read rollout JSONL, inspect private bindings, synthesize a path,
or ask the user for a child ID. Public syntax remains `$zcode:rescue ...
--resume`; the selector is not appended to the command.

## Plugin resolution and authorization

The planner processes a version-3 path selector in this order:

1. Validate the exact envelope and selector before discovery.
2. Canonicalize origin and execution workspaces.
3. List only persisted `thread_spawn` children of the exact active parent.
4. Validate every child record and reject duplicate IDs or duplicate canonical
   paths globally before target filtering.
5. Require exactly one validated host child whose full canonical path equals
   the selector. Absence or multiplicity fails closed.
6. Obtain the host-issued child ID from that selected host record.
7. Resolve only that child's stopped-executor evidence and durable binding.
8. Require the binding authority's `childAgentId` and `agentPath` to equal the
   selected host child ID and path, then apply every existing Role, parent,
   state, workspace, permission, operation, generation, job, and original
   ZCode-session check.
9. Emit the existing exact `followup` directive targeting the independently
   validated canonical path.

The selector narrows candidates but cannot authorize an unbound, unmanaged,
revoked, ambiguous, malformed, foreign, or changed child. A path match with a
different binding child ID fails; a child ID match under a different path
fails. No target failure may inspect a sibling binding as fallback, spawn a
replacement, choose a latest session, mutate preparation/binding/job state, or
perform a ZCode RPC.

Existing version-2 pair handling remains exact and fail closed for compatibility.
Existing targetless handling still requires globally unique eligibility.
Fresh handling still validates the complete child list and treats every
persisted path as occupied for collision-free allocation.

## Why the child ID remains internal

The host child ID remains part of the binding key and ambient-child execution
proof. It prevents a reused or mismatched route from consuming another child's
preparation or operation. Removing it from the Root selector does not remove
or weaken those checks: the plugin rediscovers the ID from the exact parent
child graph and compares it with the trusted hook/binding identity before any
continuation action.

The plugin must not derive a missing binding identity from path alone. Path is
only the first selection key; authorization still requires the independently
persisted host child ID and all existing binding evidence.

## Qualification and regression evidence

Tests must add minimized captures that preserve the real host boundary for at
least Codex 0.147 and 0.148:

- `spawn_agent` output contains canonical `task_name` and no `agent_id`;
- the internal started activity is nested under `event_msg.payload.item`;
- its correlation field is `item.id`, not `event_id`;
- its `agent_thread_id` agrees with child session metadata and plugin binding;
- Root prepares version 3 using only the returned canonical path;
- the plugin resolves the host child ID and resumes the original ZCode session.

Qualification may inspect internal host events to prove the implementation's
end-to-end identity chain. Skill conformance must inspect only values available
to Root and must fail any instruction that requires Root to recover an internal
thread ID.

Synthetic fixtures must not normalize the host capture into a fictional public
schema. The checked-in regression may minimize unrelated fields and redact
private task content, but the field locations and tool output shape remain
byte-faithful to the observed lifecycle boundary.

## Acceptance criteria

1. With two complete resumable bindings, a version-3 selector for
   `/root/zcode_rescue_task_3` follows only that child and resumes its original
   non-empty ZCode session regardless of sibling order, timestamps, or suffixes.
2. The same path paired in durable state with a different child ID fails before
   preparation consumption, follow-up, mutation, or ZCode RPC.
3. Duplicate host IDs or paths remain globally ambiguous even when one path
   text equals the selector.
4. Missing, unmanaged, unbound, ineligible, malformed, or changed selected
   children fail closed without sibling or fresh fallback.
5. Real-shape 0.147 and 0.148 fixtures pass without any
   `spawn.output.agent_id` or `started.event_id` field.
6. New Skill text retains the exact `spawn_agent` result `task_name`, emits a
   private version-3 path selector, and never asks Root or the user for a child
   ID.
7. Existing v1 targetless, v2 null/pair, persisted preparation, binding
   migration, active-child, foreground/background, result, cancel, and transfer
   behavior remains compatible.
8. The serialized selector stays confined to the authorized private frame and
   record; public surfaces do not gain child IDs, selectors, or new arguments.
9. Source, installed marketplace snapshot, security/release documentation, and
   qualification helpers describe one consistent contract.
10. Full source, packed marketplace, plugin validation, and release contract
    suites pass on the supported CI matrix.

## Out of scope

- Public `--resume <selector>` syntax.
- Exposing Codex child IDs through Root-facing collaboration tools.
- Reading local rollout files during normal operation.
- Replacing host-issued child IDs with plugin-generated IDs.
- Opaque continuation-handle issuance.
- Changing same-workspace writable concurrency.
- Broad refactoring of binding, job, or ZCode-session storage.
