# Rescue Placement Semantics Parity Design

Status: approved on 2026-09-16. Implementation planning may proceed.

## Executive decision

ZCode Rescue will model two independent decisions:

1. **Host placement** — whether Root joins the Rescue Child in the initiating interaction.
2. **Companion execution** — whether the Rescue Child holds an attached Companion process to terminal or receives queued acknowledgement from a detached runner.

The current private `options.execution` enum conflates these decisions. New Rescue preparation will carry them independently so explicit placement flags and no-flag complexity inference reproduce `codex-plugin-cc` behavior without weakening ZCode's private task boundary.

The placement change and the separate foreground observation/token-cost repair have independent specs and implementation plans. They are one release unit: the placement change must not ship before the foreground repair passes its acceptance budget.

## Problem

The public word `background` currently names two different lifetimes:

- the Host may let a Rescue Child continue without Root waiting;
- the Companion may detach execution from the Rescue Child and return queued.

Current ZCode Rescue selects one `options.execution` value before preparation and uses it for both. Consequently explicit `--background` starts Companion detached execution, returns queued, and ends the child. CC instead consumes the explicit flag at the Host Agent layer and strips it before its Companion task.

CC also supports a distinct no-flag behavior: small work remains Companion foreground, while its Rescue Agent may select `task --background` for complex, open-ended, multi-step, or likely long work. ZCode already has the equivalent detached runner, but its selection must be separated from explicit Host placement.

## Goals

- Match CC's four observable Rescue placement branches.
- Make explicit `--background` and `--wait` Host-only controls.
- Preserve automatic detached Companion background for no-flag complex work.
- Keep the existing detached runner, queued acknowledgement, Status/Result, cancellation, recovery, and lifecycle ledger unchanged in purpose.
- Preserve the task-free Rescue Child assignment and private preparation channel.
- Make Host waiting behavior depend only on Host placement.
- Make detached execution depend only on Companion execution.
- Provide deterministic contract and integration tests for every branch.

## Non-goals

- No change to foreground `exec_command`/`write_stdin` observation; that is owned by the separate foreground observation spec.
- No change to detached runner execution, claim/lease, queued semantics, or completion delivery.
- No task text in the Rescue Child assignment, agent message, task name, or public output.
- No new public placement flag.
- No automatic worker retry, readiness handshake, polling daemon, or notification daemon.
- No change to Review or Adversarial Review placement.
- No migration or reinterpretation of already-reserved jobs.

## Placement vocabulary

### Host placement

`foreground` means Root joins the exact Rescue Child through native child completion before returning the initiating interaction.

`background` means Root starts the exact Rescue Child and does not join it in that interaction. The Codex Host continues tracking the child and owns its later completion/error delivery.

### Companion execution

`foreground` means the Rescue Child starts one attached Companion process and observes that exact process to terminal stdout.

`background` means the Rescue Child durably reserves one job, starts the existing detached runner, receives queued acknowledgement, and exits. Status/Result and PromptSubmit fallback remain the completion surfaces.

Neither enum implies the other.

## Authoritative decision matrix

| User request | Host placement | Companion execution | Root behavior | Rescue Child lifetime | Initial user-visible outcome |
|---|---|---|---|---|---|
| Explicit `--background` | background | foreground | Spawn; do not `wait_agent` | Lives until attached Companion reaches terminal | Bounded Host launch acknowledgement; later native completion/error delivery |
| Explicit `--wait` | foreground | foreground | Spawn; join exact child | Lives until attached Companion reaches terminal | Terminal Companion result |
| No flag, small and clearly bounded | foreground | foreground | Spawn; join exact child | Lives until attached Companion reaches terminal | Terminal Companion result |
| No flag, complex/open-ended/multi-step/likely long | foreground | background | Spawn; join child until queued acknowledgement | Exits after queued | Queued job with Status/Result guidance |

Explicit flags are authoritative and mutually exclusive. With no flag, Root applies the existing complexity rubric. It does not ask an extra placement question.

## Privacy-preserving decision ownership

CC lets its Rescue Agent see the raw request and decide whether a no-flag task should use `task --background`. ZCode intentionally gives the Rescue Child a fixed task-free assignment and supplies the business task only through the private preparation/launcher channel.

Therefore Root performs ZCode's no-flag complexity inference. This is a Host adaptation, not a semantic difference:

- explicit flag: Root selects Host placement and fixes Companion execution to foreground;
- no flag: Root fixes Host placement to foreground and selects Companion execution from task complexity.

The Rescue Child executes the prepared decision but never interprets task complexity or sees task text in its assignment.

## Private preparation schema

New preparations use a new envelope version with independent closed enums:

```json
{
  "version": 4,
  "source": "explicit",
  "task": "<private normalized objective>",
  "options": {
    "hostPlacement": "foreground",
    "companionExecution": "background",
    "resume": "fresh",
    "model": "<optional>",
    "effort": "<optional>"
  },
  "continuationTarget": null
}
```

Rules:

- `hostPlacement` and `companionExecution` are required for every new Rescue preparation.
- Each is exactly `foreground` or `background`.
- Version 4 accepts only the three combinations produced by the authoritative matrix: foreground/foreground, background/foreground, and foreground/background. Background/background has no authorized entry and fails closed.
- Explicit `--background` maps only to `hostPlacement: background`; explicit `--wait` maps only to `hostPlacement: foreground`. Both force `companionExecution: foreground`.
- No-flag inference forces `hostPlacement: foreground` and selects `companionExecution` by complexity.
- Public flags are removed before task normalization and never reconstructed from task text.
- `resume`, `model`, `effort`, and `continuationTarget` retain their existing meanings and validation.
- Version 4 retains version 3's path-only exact `continuationTarget` selection and activation/binding checks. Splitting placement must not weaken exact-child continuation.
- Version 3 remains the only accepted legacy private preparation envelope. Its `options.execution` retains the historical coupled meaning and updated instructions never emit it.
- Version 1 targetless and version 2 child-ID/path-pair private preparation envelopes are removed rather than carried into this change. They are short-lived preparation inputs, not durable Rescue job or binding formats, and receive no migration.

The exact field names may change only if implementation discovery finds an existing closed-schema naming convention that represents the same two dimensions without ambiguity. The two independent values and matrix are normative.

## Root orchestration

Root always prepares first, then starts or follows up the plugin-prescribed exact Rescue Child.

After child activation:

- `hostPlacement: foreground`: Root joins only the exact child with the longest native `wait_agent` operation until the child returns terminal output or queued acknowledgement.
- `hostPlacement: background`: Root does not enter the `wait_agent` loop in the initiating interaction. It returns a bounded Host launch acknowledgement that claims only that the child was created—not that Companion work was queued, accepted, started, or completed—and relies on native child completion/error delivery plus durable fallback.

Root's wait decision must never inspect `companionExecution`.

For `hostPlacement: foreground, companionExecution: background`, joining ends when the child returns the queued acknowledgement. Root does not poll the detached job afterward.

## Rescue Child and Companion routing

The Rescue Child starts one mapped Companion invocation.

- `companionExecution: foreground`: use the existing attached execution path and return only its authoritative terminal public stdout.
- `companionExecution: background`: use the existing reserve/spawn/queued path and return only its bounded queued acknowledgement.
- Internal Companion argv is derived only from `companionExecution`: add the existing internal `--background` switch only for Companion background, and add no placement switch for Companion foreground. `hostPlacement` is persisted as lifecycle evidence but never converted into Companion argv.

The child must never derive Companion placement from `hostPlacement`, public task wording, elapsed time, progress, or Host child status.

Companion execution selection must not change exact binding, permission snapshot, resume/fresh choice, model/effort selection, workspace admission, or terminal election.

## Child-stop and coordination-loss policy

Host placement alone is insufficient to interpret Rescue Child exit after the split.

- `companionExecution: foreground`: the child is the live observer. Existing Host Coordination Loss policy continues to use actual Host placement: loss of a Host-foreground child may authorize exact stop reconciliation, while a Host-background child follows the existing background coordination-loss policy.
- `companionExecution: background`: child exit after accepted enqueue is expected handoff completion, even though actual Host placement is foreground. It must not create a `host-coordination-loss` stop intent, cancel the detached job, or revoke its binding merely because SubagentStop observes the child exit.
- Child loss before deterministic enqueue success is handled by the existing detached pre-start/uncertainty rules. It is never reclassified as attached foreground loss solely from `hostPlacement: foreground`.

The lifecycle reconciler and SubagentStop adapter must join actual Host placement with detached-runner evidence. A valid new runner-format marker selects detached child-exit semantics; absence selects attached semantics. Job status, accepted-turn boundary, stop receipt, and terminal evidence remain authoritative for settlement. A queued acknowledgement is presentation, not authority, and failure to deliver it does not cancel or relaunch an already accepted detached job.

## Durable state

New jobs continue to persist `hostPlacement` for lifecycle policy. It records actual Host placement only.

Detached execution remains identified by its existing runner-format evidence, including `rescueRunnerVersion`, execution input while queued, worker claim/lease, and executor PID. Code must not infer detachment from `hostPlacement`.

This yields two valid combinations for new Rescue jobs:

- `hostPlacement: background` with no detached runner marker: explicit Host background plus attached Companion foreground;
- `hostPlacement: foreground` with detached runner marker: no-flag complex Companion background.

For compatibility, `executionOwner: host-child` continues to mean Host-owned authorization, not that the child process is necessarily the executor. The detached runner remains placement, not a second lifecycle owner.

Current runner admission requires `hostPlacement: background`; that condition must be replaced for new split-schema jobs. New runner admission requires complete Host lifecycle authority plus valid detached Companion execution evidence (`rescueRunnerVersion`, bounded execution input while queued, exact binding, epoch, claim/lease and stop fences). `hostPlacement: foreground` must neither authorize nor reject a runner by itself. Historical runner formats keep their historical validation.

Historical records retain their stored interpretation. No upgrade rewrites active or terminal jobs.

## Completion and failure behavior

Attached Companion foreground preserves native child completion and durable result publication. Companion background preserves queued acknowledgement and pull/PromptSubmit completion.

If Host-background child creation fails, no Companion run is authorized. If an attached Companion fails, the child returns its bounded terminal failure through native completion. If detached enqueue fails before accepted acknowledgement, existing pre-start settlement applies and the foreground Host child returns that failure.

If a detached job is accepted but its queued acknowledgement is not delivered because the Host-foreground child exits, the job remains discoverable through Status/Result and PromptSubmit fallback. No replacement child or runner is started automatically.

Host background does not authorize execution past Host SessionEnd. Existing SessionEnd receipt, exact stop, settlement, and resumability rules remain unchanged.

## Compatibility and documentation

- Continue accepting private preparation envelope version 3 under its historical coupled placement contract during the compatibility window.
- Reject private preparation envelope versions 1 and 2 after upgrade and remove their validators and compatibility fixtures. This removal is scoped only to the private preparation envelope protocol; it does not authorize deleting unrelated versioned preparation records, route directives, bindings, jobs, runner evidence, execution capabilities, or other persisted schemas.
- Emit only the split new schema after upgrade.
- Preserve readers/controllers for historical detached jobs.
- Amend ADR 0018 so explicit Host background is attached Companion foreground.
- Amend ADR 0021 so detached writable Rescue applies to no-flag complexity inference, not explicit `--background`.
- Amend ADR 0015 and user-facing Rescue documentation to use the two placement terms consistently.
- Do not reuse the unqualified phrase “background Rescue” where the layer is ambiguous.

## Verification

Contract and integration coverage must prove:

1. Explicit `--background` produces Host background plus Companion foreground, never a detached runner or queued job.
2. Explicit `--wait` produces Host foreground plus Companion foreground.
3. No-flag small work produces Host foreground plus Companion foreground.
4. No-flag complex work produces Host foreground plus Companion background and queued acknowledgement.
5. Version 4 rejects Host background plus Companion background because no authoritative branch emits it.
6. Explicit flags are absent from normalized task text and Companion argv.
7. Root waiting depends only on Host placement.
8. Companion routing depends only on Companion execution.
9. Both authorized cross-combinations persist correct lifecycle evidence without inferring detachment from `hostPlacement`.
10. Normal SubagentStop after detached enqueue does not create Host Coordination Loss or cancel the job; loss before or during enqueue follows existing pre-start/uncertainty settlement without duplicate launch.
11. New runner admission accepts `hostPlacement: foreground` only when complete detached Companion evidence is valid, and rejects foreground jobs without that evidence.
12. Resume/fresh, model/effort, permission, exact binding, cancellation, SessionEnd, Status/Result, and terminal winner behavior remain unchanged.
13. Version 3 envelopes retain their coupled read-compatibility behavior; version 1 and 2 private preparation envelopes fail closed, while unrelated versioned durable formats remain accepted as required by their own contracts.
14. Source, generated plugin, packaged artifact, and installed qualification fixtures agree.

The placement suite must not make a provider call. A real Host qualification must separately exercise explicit Host background completion and no-flag complex queued execution.

## Release gate

This design may be implemented and tested independently, but it must not be released before the separate foreground observation/token-cost repair is approved and passes its real-Host acceptance budget. Explicit `--background` will route long work through attached Companion foreground; releasing it with known high-frequency child model re-entry would trade semantic correctness for unacceptable token cost.

Companion background regression tests are a release gate: no-flag complex work must still return queued promptly, the detached runner must continue independently, and Status/Result/Cancel must remain correct.
