# Rescue Dynamic Agent Naming Design

Status: proposed for maintainer review

This design introduces human-readable dynamic task names for native Rescue
children. It changes only the display-name convention and its conformance
qualification. It does not change Rescue identity, authorization, routing,
hook trust, companion authority, or same-child continuation.

## Problem

The installed Rescue skill currently spawns every child with the fixed task
name `zcode_rescue`, so every native child appears as `/root/zcode_rescue`.
This hides the purpose of the delegated work and differs from ordinary Codex
subagents, whose task paths usually carry a short task-specific name.

Simply treating a `zcode_rescue_*` prefix as a Rescue marker would create a
security and correctness defect. Any ordinary child could use that name, and a
real Rescue child could be renamed or represented differently by the host.
Display naming must therefore remain independent of trusted Rescue identity in
both directions.

## Non-Negotiable Identity Invariant

`task_name` and `agent_path` are presentation metadata. They are neither
sufficient nor necessary evidence that a child is a Rescue subagent.

Consequently:

- a child named `zcode_rescue_fix_progress` is not classified, authorized, or
  routed as Rescue because of that name;
- a trusted Rescue child with a nonconforming name remains a Rescue child and
  retains its existing execution and continuation behavior;
- hooks and the companion runtime must not import, call, or reproduce the
  display-name validator as an authorization check; and
- name conformance failures may fail a naming contract test, but must not mint,
  revoke, downgrade, or redirect Rescue authority at runtime.

Trusted Rescue identity continues to come from the existing route facts: the
managed `agent_type` where the named route exposes it, the exact returned child
ID, parent-child linkage, child session metadata, fixed forwarder contract, and
hook-issued session, turn, workspace, executor, and pending-choice bindings.
The generic compatibility route continues to use its existing fixed-message,
exact-child, exact-execution, and hook-binding evidence. It must not substitute
the display prefix for its absent named Role metadata.

## Goals

- Let the top-level Codex agent choose a short task-specific Rescue display
  name before spawning the single Rescue child.
- Produce native paths such as `/root/zcode_rescue_fix_progress` while keeping
  `agent_type: zcode-rescue` unchanged on the named route.
- Keep the name bounded, structurally predictable, and free of raw user task
  text or sensitive identifiers.
- Preserve the exact child ID and observed path throughout foreground waits and
  `needs-choice` continuation.
- Separate identity qualification from display-name conformance so tests cannot
  accidentally turn a naming prefix into a trust signal.

## Non-Goals

- Do not change ZCode, the companion protocol, hooks, capabilities, ownership,
  permissions, result interpretation, cancellation, or progress reporting.
- Do not use the task name or agent path to discover or authenticate Rescue.
- Do not relay the original prompt, command arguments, paths, job/session IDs,
  credentials, authorization material, or other private text through the name.
- Do not rename a child after spawn or create a second child to improve a name.
- Do not add a runtime warning or status field solely for name conformance.

## Considered Approaches

### Keep the fixed name

This is the smallest implementation, but it does not provide task-specific
native paths and does not meet the requested UX.

### Treat a reserved prefix as the Rescue discriminator

This makes routing superficially simple, but it is rejected. Names are supplied
as spawn metadata and can be spoofed, omitted, or changed independently of the
trusted child identity. This approach violates the identity invariant.

### Use an independent dynamic display convention

This is the chosen approach. The skill chooses a readable bounded name, the
host displays it, and a separate conformance assertion checks the convention.
All identity and authorization logic continues to use existing trusted facts.
This provides readable native paths without widening the trust interface.

## Display-Name Convention

After the readiness preflight succeeds, the top-level agent chooses one
`rescueTaskName` before spawn. Its form is:

```text
zcode_rescue_<semantic_slug>[_<ordinal>]
```

The structural grammar is:

```text
semantic_word = [a-z][a-z0-9]{0,15}
semantic_slug = semantic_word ("_" semantic_word){0,2}
ordinal       = an integer from 2 through 9999 without leading zeroes
task_name     = "zcode_rescue_" semantic_slug ["_" ordinal]
```

The complete UTF-8 task name must not exceed 64 bytes. Examples include:

```text
zcode_rescue_fix_progress
zcode_rescue_review_hooks
zcode_rescue_debug_ci
zcode_rescue_fix_progress_2
```

The semantic slug is a generic description selected by the main agent, not a
copy or mechanical transformation of user input. It must not contain prompt
fragments, repository or filesystem paths, personal names, issue/job/session
identifiers, hashes, credentials, capability material, or authorization data.
If the main agent cannot produce a safe semantic description, it uses the
valid fallback `zcode_rescue_task`.

The main agent selects an unused sibling name before the single allowed spawn.
If its preferred semantic name is already occupied, it appends the smallest
available ordinal. It may consult the native agent registry when necessary,
but a collision never authorizes an ambiguous spawn retry or a second Rescue
child after any child ID, start event, or activity exists.

## Spawn and Continuation Flow

The named route changes only the `task_name` field:

```text
spawn_agent({
  task_name: rescueTaskName,
  fork_turns: 'none',
  agent_type: 'zcode-rescue',
  message: 'Run the installed ZCode Rescue forwarder now. Return its public stdout verbatim.',
})
```

The generic schema-hidden route uses the same `rescueTaskName` and retains its
fixed generic forwarder message and absence of `agent_type`. Neither route puts
the task slug in the forwarder message or companion command.

After spawn, the parent records the exact returned child ID and the actual path
reported by the host. Wait, rejoin, and choice operations continue to target
only the child ID. The task name is not regenerated across turns. The actual
path is compared only for native lifecycle consistency; it is never used to
recover authority or select a different child.

## Qualification Seam

Qualification is divided into two independent interfaces:

1. **Rescue identity qualification** validates the named or generic route,
   exact spawn/start linkage, trusted child ID, parent linkage, Role metadata
   where available, fixed forwarder message, exact command execution, terminal
   exit, same-child continuation, and hook-bound lifecycle evidence. It treats
   the task name and path as opaque bounded presentation values.
2. **Display-name conformance** validates the grammar, privacy-oriented source
   contract, and host presentation relationship for the already-qualified
   child. It may report a display-contract defect, but its result is never an
   input to runtime Rescue authorization or routing.

The implementation may expose both results from one test helper, but it must
preserve the logical separation and distinct failure codes. In particular:

- a spoofed `zcode_rescue_*` name with non-Rescue identity evidence fails
  identity qualification;
- a trusted Rescue child with an out-of-pattern name passes identity
  qualification and fails only display-name conformance; and
- a path leaf that differs from the spawned task name is a host presentation
  inconsistency, not a Rescue identity decision.

No production hook or companion module consumes the display-name conformance
result.

## Error Handling

- Unsafe, empty, or unrepresentable semantic text uses
  `zcode_rescue_task`; it is not copied into a best-effort slug.
- A known sibling collision is resolved before spawn with an ordinal.
- A schema rejection of `agent_type` retains the existing narrow generic-route
  rules and reuses the already-selected display name.
- Any ambiguous spawn result, child ID, start event, or activity retains the
  existing fail-closed single-child behavior; naming does not permit a retry.
- A name or path conformance defect does not affect an already-authenticated
  child, its result, or its pending-choice continuation.

## Testing

Implementation follows red-green-refactor and proves these independent facts:

1. Named and generic skill routes choose bounded dynamic task names while
   retaining their exact forwarder messages and command authority.
2. Valid semantic slugs, the safe fallback, ordinal collisions, length bounds,
   invalid characters, excessive words, and leading-zero ordinals are covered.
3. Prompt/path/session/capability sentinels are absent from spawned task names,
   forwarder messages, companion commands, and durable qualification evidence.
4. A matching prefix with wrong Role, parent, child ID, fixed message, or hook
   binding does not qualify as Rescue.
5. A trusted Rescue fixture with a nonconforming display name still qualifies
   its Rescue identity; only the separate naming assertion fails.
6. Spawn task name, start path, child metadata path, child return author, wait,
   and choice continuation remain linked to the exact original child without
   deriving trust from the path.
7. The existing one-spawn, one-exec, same-handle polling, terminal-exit,
   parent-isolation, and choice-continuation tests remain green.
8. Installed named and generic qualification observes a dynamic path and the
   marketplace skill mirror remains byte-identical to the canonical skill.

## Delivery

This is a separate follow-up change to the Rescue progress compatibility work.
If PR #28 is still open, implementation uses a dedicated stacked branch rather
than adding commits to PR #28; it can be retargeted to `main` after PR #28
merges.

Delivery uses subagent-driven development:

1. an implementation subagent owns the agreed skill, qualification, test,
   mirror, and documentation files;
2. an independent review subagent checks the implementation against this Spec
   and repository standards;
3. all Critical and Important findings are resolved and re-reviewed;
4. the branch is verified, committed, and submitted as a PR; and
5. delivery is complete only when required CI checks pass.
