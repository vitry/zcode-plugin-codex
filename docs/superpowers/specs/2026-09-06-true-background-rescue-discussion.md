# True Background Rescue — discussion decisions

Status: superseded as the working decision log by `2026-09-07-true-background-rescue-design.md`; retained as validation evidence.

## Established scope

Follow `/tmp/handoff-true-background-rescue-design.md`: adapt codex-plugin-cc's detached execution, immediate queued acknowledgement, and pull status/result model while preserving this project's single ownership ledger, exact binding, epoch fencing, immutable boundary receipts, and authoritative terminal election. A SessionEnd boundary ends execution authority; missing observation alone does not establish a boundary. Existing ADR wording must be updated explicitly where the final design changes it.

## Confirmed decisions

### Queued acknowledgement

The user confirmed that queued means durably accepted, not that the runner has taken responsibility or execution has started. Reserve through the existing authorization and epoch fence before spawning. Do not require a runner-readiness handshake before returning queued. Before execution, the runner must acquire the existing execution claim and revalidate applicable stop and epoch conditions. Detectable launch failures must be surfaced; later failures converge through the existing job record and reconciliation.

### No automatic runner restart in the first version

The user confirmed a single launch attempt, following the simple cc model. If evidence establishes startup failure, settle and expose that failure through the existing ledger; another attempt requires a new user request and the applicable exact-binding rules. If runner state is uncertain, retain the unresolved record. Elapsed time or missing observation alone does not prove failure, release the writable guard, or authorize a replacement executor. This decision does not add a retry scheduler or weaken existing reconciliation.

### Initial platform support

The user confirmed that the first version must support macOS, Linux, and Windows. Reuse existing cross-platform launch and bounded termination primitives, with one lifecycle model. Qualify process independence, SessionEnd stop behavior, and failure recovery separately on each platform; platform support is a requirement, not a claim that qualification has passed.

## Pending design work

- Define and run platform-specific qualification for macOS, Linux, and Windows.
- Specify request handoff and the reserve/spawn/claim/SessionEnd races using existing authority and execution evidence.
- Verify that reconciliation distinguishes an unclaimed launch from a delayed or already active executor.
- Specify exact-binding continuation after prior-epoch settlement, without replaying uncertain writes.
- Draft explicit amendments to ADR 0017 and ADR 0018 for the agreed background execution and notification model.

### Existing job schema may evolve

The user confirmed that minimal internal fields may be added to the existing job record when their necessity is demonstrated. A single ownership ledger is mandatory; an unchanged field set is not. Prefer existing claim, lease, binding, and locking mechanisms. Do not introduce a separate spec/capability/lease ownership system to avoid extending the job schema. This permission does not approve any particular proposed field.

## Proposed implementation shape — for review

The following is an engineering proposal, not an additional set of user-confirmed decisions.

### Execution handoff

1. The existing child-authorized companion validates the exact route and permission snapshot and reserves the job through the epoch fence.
2. Publish a bounded, private execution request in the same job ledger before spawn. Prefer one reservation transaction so an executable job cannot be visible without its request. The payload selects task/model/effort and the already-proven continuation; it grants no authority. Field names, limits, retention, and redaction require schema review.
3. Launch a thin internal runner for that exact workspace/job with detached stdio and unref. Reuse the low-level launch mechanics of `spawnDaemon`, adapting its broker-specific errors. An OS spawn event is not a runner-readiness handshake. Surface locally observed spawn errors; otherwise return queued without awaiting claim or engine startup.
4. The runner reads the exact job and request, acquires the existing worker lease and execution claim, and validates binding, epoch, and stop evidence before dispatch. Add missing checks at the shared claim/dispatch seam rather than creating runner-specific authorization rules.
5. The runner uses the existing managed ZCode client, progress handling, result publication, and terminal election. Its lifetime is independent of the child; its authority remains that of the reserved job.
6. Status/Result and PromptSubmit reuse existing reconciliation and delivery. Child completion after enqueue is an acknowledgement, not a job Completion Notice, and must not mark an unfinished job notified.

The historical `run-reserved-job` path currently rejects Host lifecycle records and expects sealed specs and capabilities. Do not simply remove that rejection or route new jobs through the historical machinery. Add a narrow internal entry point sharing execution primitives, with the existing authority checks adapted for the approved process shape. Historical and read-only compatibility remains intact.

### Single-ledger argument and remaining proof obligations

| Event | Existing authority/evidence to retain | Required adaptation or proof |
| --- | --- | --- |
| Reservation | Owner epoch, exact binding, writable fence | Publish executable input before spawn |
| Delayed or duplicate runner | Worker lease and locked execution claim | Only one claimant dispatches; terminalized or stopped jobs reject late claims |
| Completion | Exact turn evidence, result artifact, terminal winner | Runner uses existing publication ordering |
| Startup failure | Job status, claim evidence, guarded settlement | Failure must fence out any delayed claimant before releasing the guard |
| Observer or runner loss | Lease and attributable engine evidence | Neither timeout nor child disappearance alone authorizes restart or proves terminal failure |
| SessionEnd | Immutable receipt, durable stop intent, exact stop | Receipt/claim/dispatch races converge without new owner state |
| Explicit continuation | Prior settlement, exact child/session binding, permission equality | New job/turn; never restart an uncertain prior attempt |

An unclaimed queued record is not by itself proof that a runner cannot start later. The design must use the existing locked terminal/claim exclusion, or extend that shared transaction if needed. A reconciler may only publish a startup failure when its evidence and fencing make that claim valid. Do not add an age-based failure threshold as a substitute.

The reserve-time epoch fence alone is insufficient: SessionEnd can arrive between reserve and dispatch. The final spec must identify the dispatch/stop ordering and test both sides, including the case where the engine accepted work before its identity was published locally. Uncertainty remains durable and blocks conflicting writes; a bounded hook return is not proof of remote termination.

### Binding and continuation

Keep the original child/path, owner, workspace, permission snapshot, binding generation, and exact ZCode session as the authority join. A runner is an executor, not a replacement Rescue Child identity. On a later authorized resume, settle old-epoch obligations first, then use the existing exact route and continuation reservation to create a new job. Its selected placement determines attached versus detached execution.

Reuse the existing pre-running continuation rollback only within its current proof boundaries. It restores reservation/binding state after an eligible setup failure; it does not undo files modified by an accepted engine turn. A resumed turn continues the preserved conversation under new authorization rather than blindly replaying the old request.

### Boundary and process cleanup

Keep receipt-first shutdown, bounded exact engine stop/reread, immutable winner semantics, and durable unresolved obligations. Apply the existing recorded-process cleanup approach to the validated runner identity; local process death never proves an engine terminal outcome. A runner must not create or shut down the shared broker as though it were a private child tree.

Use existing lease/claim evidence before considering new heartbeats. A PID alone does not establish executor identity; delayed PID publication, PID reuse, and runner exit before cleanup are explicit test cases. Windows taskkill uses the existing shared local deadline; POSIX process-group behavior requires separate qualification. No platform may convert lack of stop evidence into a successful cancellation claim.

### Governance and glossary changes

The final ADR must explicitly supersede ADR 0018's normal-path detached-worker prohibition and its requirement that the child observe until terminal. Preserve its ban on a second lifecycle owner and its exact-binding requirements. Explicitly amend ADR 0017 so pull/PromptSubmit delivery is a supported normal background path. Revise Host-managed Companion Run terminology to distinguish Host authorization from executor and observer lifetimes; do not silently retain an inaccurate definition or repurpose `executionOwner: host-child` without documenting its meaning.

### Relative complexity and rollout

| Approach | Benefit | Cost |
| --- | --- | --- |
| Current attached background | Existing lifecycle integration | Child and observation remain live until terminal |
| Copy cc wholesale | Small enqueue/worker implementation | Loses this project's exact ownership, boundary evidence, and continuation guarantees |
| Thin runner over existing ledger | cc-style return and process independence with retained guarantees | Shared schema/claim changes, race coverage, ADR updates, platform qualification |

Implement the new path only for new background Rescue; foreground retains its placement semantics. First validate private request storage and claim fencing, then detached launch and failure settlement, then boundary/resume and delivery integration. Keep historical and read-only paths compatible. Before release, qualify all three platforms and update packaged artifacts and documented semantics.

Acceptance must cover: reserve-before-spawn; no readiness wait; no automatic restart; parent exit after queued; missing or malformed private request; delayed and duplicate claims; SessionEnd at every launch/dispatch boundary; runner loss with a still-active engine turn; exact-binding resume after compensation; permission mismatch; natural completion racing stop; PID identity uncertainty; public redaction; and source/package parity. These checks have not been executed in this design session.

## Targeted verification of existing rollback and recovery

Verified against the design worktree at `ddd409e`, without runtime code changes. Existing `rescue-binding`, `recovery`, and `rescue-lifecycle` test files passed, as did the selected companion integration tests matching `rolls back active continuation|active continuation rollback convergence`.

A temporary diagnostic at `/tmp/rescue-handoff-probe.UI7Ss1/probe.mjs` used real StateStore and `reconcileOwnedJobs` against isolated temporary data. It created a successful job A with an exact child binding and engine session, then reserved continuation B with the Host lifecycle trio and background placement. No engine process or provider was invoked.

| Diagnostic branch | B after settlement | Binding current | Strict binding lookup | Late claim of B |
| --- | --- | --- | --- | --- |
| Explicit `finishActiveRescueContinuationFailure` | failed | A restored | accepted | rejected |
| Unclaimed B, generic recovery after existing claim grace | failed | B retained | `RESCUE_BINDING_INVALID` | rejected |
| Claimed B with free lease, generic recovery | failed | B retained | `RESCUE_BINDING_INVALID` | rejected |

The strict lookup exercised `readRescueBindingMigrationProof`, which is used by the route planner and companion and validates the current job's accepted session. Generic queued recovery terminalizes B through `finishQueuedJobAfterRecoveryLease`; it does not call the active-continuation rollback transaction, and generic terminal publication removes `rescueContinuationOrigin`. B has no accepted session, so that lookup rejects it. A lower-level continuation reservation alone still succeeds; that result must not be misreported as proof that the complete public resume route succeeds.

Consequences:

- Existing lease probing, locked terminal/claim exclusion, and explicit startup rollback are reusable. There is no need to invent a second recovery system.
- Generic orphan settlement and restoration of an active continuation are not equivalent. The thin-runner design must explicitly join eligible startup-failure recovery to the existing rollback transaction before losing its proof. Exact evidence, lease exclusion, and idempotent publication remain mandatory.
- This is a demonstrated existing recovery-path inconsistency at the module boundary, not a failure exclusive to detached execution. The diagnostic did not kill a real Host or exercise the entire public resume workflow.
- Generic recovery currently also has an unclaimed reservation grace policy (`LEGACY_QUEUED_STALE_MS`). Reusing it unchanged would conflict with the newly confirmed policy that age alone does not establish runner startup failure. Define the new path's evidence and fencing explicitly; do not silently change historical behavior.
- Full detached-runner, SessionEnd/dispatch, cross-platform, and installed-plugin qualification remains pending. Passing existing suites does not qualify the proposed feature.
