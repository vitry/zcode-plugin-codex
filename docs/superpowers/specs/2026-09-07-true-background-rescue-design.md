# Session-Bound True Background Rescue Design

Status: product scope approved by the user; self-review corrections recorded below. Implementation will be handed to another agent in a new development worktree.

Validated against design worktree commit `ddd409e` and the reference implementation in `codex-plugin-cc`.

## Executive decision

Background Rescue will use a true detached runner. The Codex Rescue Child validates and durably reserves one exact job, launches one thin runner, receives only the operating system's successful-spawn signal, returns a queued acknowledgement, and may exit. The runner then claims and executes that already-authorized job independently of the child.

Execution remains session-bound. The detached runner is not a second lifecycle owner: the existing job record, Host lifecycle epoch, exact Rescue binding, immutable SessionEnd receipt, worker claim/lease, accepted ZCode turn boundary, and terminal election remain authoritative. Host SessionEnd ends the run's authority and must converge both the exact remote turn and the exact local runner tree.

This design deliberately copies the small useful part of `codex-plugin-cc`—detached/unref execution, immediate queued acknowledgement, durable Status/Result—and retains this project's stronger authorization and recovery model. It supersedes the background-placement portions of the 2026-09-02 Host-managed Rescue design. Foreground Rescue remains attached.

## Why this is feasible

The current code already provides nearly every hard correctness primitive:

- reservation under the prior-epoch receipt fence;
- exact child, workspace, permission, operation, anchor job, and ZCode-session binding;
- locked one-winner execution claim plus a process-lifetime worker lease;
- running/session publication before send and exact accepted-turn boundary publication after send;
- fail-closed handling of ambiguous send admission and boundary-publication failure;
- exact remote stop/reread and natural-success-versus-cancel terminal election;
- durable progress, logs, result artifacts, Status/Result recovery, and PromptSubmit notification fallback;
- POSIX process-group and Windows process-tree termination primitives.

The required work is therefore an execution-placement change plus lifecycle integration, not a replacement scheduler. The material gaps are bounded: atomically persist private execution input, add a Host-owned runner entry point, route pre-start failure through the correct binding transaction, exempt new queued jobs from age-only recovery, terminate writable detached runners at stop boundaries, and amend delivery/ADR semantics.

## Goals

- Return control to the Host interaction after durable enqueue and successful OS process creation, without waiting for runner claim, ZCode startup, or completion.
- Let a background Rescue continue after its initiating Rescue Child exits normally.
- Stop authorization at the owning Host SessionEnd boundary.
- Preserve exact continuation, permission equality, one writable job per canonical workspace, and first-writer-wins terminal state.
- Preserve durable Status, Result, progress, cancellation, crash recovery, and missed-notification behavior.
- Support macOS, Linux, and Windows with one state model.
- Keep lifecycle decisions behind the Rescue Lifecycle Reconciler.

## Placement contract

`--wait` selects attached foreground execution and its terminal result; `--background` selects detached execution and queued acknowledgement. The flags remain mutually exclusive. Without a flag, preserve existing Host/skill inference and the low-level CLI default. Fresh/resume is independent of placement: qualify all four combinations. `status --wait` observes a job without changing its placement.

## Non-goals

- No run may continue by product contract after Host SessionEnd.
- No automatic runner retry or restart in v1.
- No readiness handshake, heartbeat, watchdog, retry scheduler, or new daemon.
- No second ownership ledger, sealed job-spec protocol, capability reservation, or independent runner authority for normal Host-owned Rescue.
- No latest-thread, latest-session, or latest-job fallback.
- No replay or rollback of workspace file changes made by an accepted ZCode turn.
- No change to foreground Rescue placement.
- No rewrite of historical detached Rescue or current read-only background formats.
- No promise that a hard crash without a delivered SessionEnd receipt immediately stops the process. Later resume compensation remains responsible for the preceding epoch.

## Comparison with `codex-plugin-cc`

| Concern | `codex-plugin-cc` | This design |
| --- | --- | --- |
| Background process | Detached, hidden on Windows, ignored stdio, `unref()` | Same process placement |
| Initial response | Immediate queued result | Immediate queued result after durable reservation and OS spawn |
| Readiness | No worker-ready handshake | No worker-ready handshake |
| Restart | No automatic restart | No automatic restart |
| Durable state | Task job record | Existing Tracked Job remains the single ledger |
| Worker failure | Wrapper publishes failure; earlier failures may strand queued | Evidence-backed pre-start settlement; uncertainty remains queued |
| Continuation | Thread-oriented task continuation | Exact child/operation/anchor/ZCode-session binding |
| Session boundary | SessionEnd kills tracked processes and clears tasks | Receipt-first exact remote settlement plus exact runner-tree termination |
| Ambiguous remote state | Simpler terminal tracking | Durable Writable Guard and authoritative turn evidence |

The additional machinery is not a reason to copy cc less closely at the process boundary. It is the reason not to copy cc's weaker ownership and continuation assumptions.

### Relative complexity

| Approach | User-visible benefit | Correctness/engineering cost | Decision |
| --- | --- | --- | --- |
| Keep current attached "background" | Existing lifecycle integration | Rescue Child and companion remain occupied until terminal; not true background | Superseded for background Rescue |
| Copy cc wholesale | Small detached task loop and immediate response | Loses exact binding, epoch fencing, durable uncertainty, and authoritative stop/result evidence | Rejected |
| Thin runner over the existing ledger | cc-style process independence and response latency plus stronger continuation/settlement | Private input and persistent runner-format discriminator in the existing job, runner entry, lifecycle cleanup, race/platform qualification | Selected |

The selected design is stronger than cc for exact continuation, boundary recovery, duplicate exclusion, and ambiguous writable outcomes. It is intentionally more complex in those areas and intentionally no stronger than cc on runner readiness or automatic restart.

## Domain model

### Rescue Child

The Host child that obtains private Rescue input, proves exact Host authority, chooses fresh or continuation through the existing route, and invokes the companion. For a background run it supervises enqueue only; it is not required to remain alive during execution.

### Detached Rescue Runner

A short-lived internal process that executes exactly one already-reserved Host-owned background Rescue job. It has no independent authorization, queue, retry policy, or lifecycle record. Its authority is wholly derived from the current job/binding/epoch evidence and ends when those checks reject it.

### Queued Rescue Acknowledgement

Confirmation only that the job and its bounded private execution input are durably accepted for execution. The enqueue implementation waits for the operating system's successful-spawn event so it can surface a locally observed launch error, but that transient event is neither persisted evidence nor part of the public queued guarantee. Queued does not prove that the runner claimed the job, began execution, opened ZCode, sent a turn, or remains alive.

### Host-managed Companion Run

A Companion Run whose authorization and stop lifecycle remain owned by the Codex Host through exact persisted Host evidence. The process executing it may be attached to the Rescue Child or be a Detached Rescue Runner.

## Product invariants

1. **One authoritative ledger.** Reuse the existing job/binding/receipt system; the runner introduces no separate ownership record or scheduler.
2. **One execution winner.** Only `claimJobWorkerForExecution` may grant dispatch to a runner; duplicate and late runners lose.
3. **Runner is placement, not authority.** PID, process existence, or runner output never authorizes a turn.
4. **Queued is weak by design.** It means accepted for execution, not claimed or started.
5. **No time-derived terminal claims.** Elapsed time and missing observation alone cannot fail a new Host-owned background job.
6. **Session-bound authority.** A matching immutable SessionEnd receipt authorizes exact stop reconciliation. It does not itself prove stop success.
7. **Uncertainty retains exclusion.** Any possibly active writable turn retains its Writable Guard until authoritative settlement.
8. **Remote evidence decides remote outcome.** Process death and a bare `session/stop` acknowledgement are not terminal proof.
9. **Natural success may win.** A coherent exact terminal result observed during cancellation publishes `succeeded` and its artifact.
10. **Continuation is new authority.** No recovery path resends an uncertain turn or automatically creates a successor.
11. **Private data remains private.** Task content, execution input, binding evidence, PID/lease, and ZCode session identifiers never appear in the queued acknowledgement or public Status projection.

## Architecture

```text
Codex Host
  -> Rescue Child
     -> companion: validate + reserve + spawn
        -> Detached Rescue Runner
           -> existing managed ZCode broker/client
              -> ZCode Engine

Durable authority across all arrows:
Host epoch + job + exact binding + worker claim/lease + turn boundary + receipt
```

The Codex app-server remains a Host metadata reader used for exact thread/child evidence. It is not the ZCode execution engine. The runner continues to use the existing ZCode broker/client path.

### Deep-module boundary

ADR 0019's Rescue Lifecycle Reconciler remains the lifecycle decision owner. Enqueue and runner execution are internal capabilities behind it, not a second public state machine.

The Reconciler's bounded request/outcome vocabulary gains the ability to request background enqueue and to report queued acceptance. Private composition may use two internal operations:

```text
enqueueBackgroundRescue(validated reservation, private execution input)
  -> queued acknowledgement | fail-closed

runBackgroundRescueJob(canonical workspace, exact job id)
  -> terminal | retained uncertainty
```

Callers do not receive raw binding/receipt/lease state and do not assemble mutation plans. The runner entry point calls the same StateStore claim, exact continuation validation, `executeReserved`/`executeJob`, progress, terminal, and result primitives used by attached execution.

The historical `run-reserved-job` entry remains unchanged. New Host-owned jobs must not be routed by removing its Host-lifecycle rejection: that path carries a different sealed-spec/capability ownership protocol retained only for compatibility.

## Durable record changes

### Private execution input

Only new true-background fresh and continuation reservations add these closed-schema fields. Foreground and historical attached-background records do not gain them:

```json
{
  "rescueRunnerVersion": 1,
  "rescueExecutionInput": {
    "version": 1,
    "task": "bounded private task",
    "model": "optional validated model request",
    "effort": "optional validated effort"
  }
}
```

Rules:

- The structure contains execution parameters, not authorization.
- `task` retains the current 64 KiB UTF-8 limit. Optional `model` is a nonempty string of at most 4 KiB UTF-8 and passes existing model validation; `effort` uses the existing closed enum. Rescue does not accept review-only scope/base/focus fields. Limit the serialized input envelope to 512 KiB to accommodate JSON escaping. Check bounds before reservation and on runner reads.
- The record is written through the current private directory and atomic JSON writer.
- The field is committed inside job JSON in the existing locked reservation publication. Job and binding files remain separate atomic writes under publication guards; preserve their established recoverable partial-publication states. Spawn only after complete reservation succeeds. There is no separate request file or payload-publication gap.
- Resume session ID, operation ID, child identity, permission, lifecycle epoch, and workspace are derived from authoritative job/binding state, not trusted from this field.
- Claim/dispatch rejects unknown keys, wrong types, oversized input, or missing input.
- The field is deleted atomically when queued becomes running or terminal. Crash recovery may still read it only while the job remains queued.
- Every public projection uses an allowlist and excludes this field. Extending the current delete-list projection is insufficient.

No launch token, pre-claim worker lease, heartbeat, or readiness field is added.

`rescueRunnerVersion: 1` is immutable execution-format evidence, retained through terminal state and hidden publicly. It requires the complete Host lifecycle trio, writable Rescue, and background placement. It identifies detached jobs after input removal and distinguishes missing input from a legacy job. Unknown versions fail closed. Absence preserves historical attached-background/legacy detached handling: never infer a process-group leader solely from `hostPlacement: background`. This discriminator is in the existing ledger and adds no owner.

### Existing lifecycle fields

The existing Host lifecycle trio remains:

```json
{
  "ownerLifecycleEpoch": "digest",
  "executionOwner": "host-child",
  "hostPlacement": "background"
}
```

For compatibility, `executionOwner: host-child` continues to mean Host-owned authorization, not that the Rescue Child process remains the executor. A later schema cleanup may rename the enum only through an explicit migration; this feature does not add a second value with duplicate semantics.

`childPid` continues as the compatibility field for the actual executing companion/runner process. Internal comments and validation must call it the executor PID. `workerLeaseId` remains the exact process-lifetime proof paired with that PID.

### Public queued response

The response is a bounded allowlisted projection:

```json
{
  "type": "background",
  "job": {
    "id": "public job id",
    "command": "rescue",
    "status": "queued",
    "createdAt": "RFC3339"
  },
  "resultCommand": "$zcode:result",
  "statusCommand": "$zcode:status"
}
```

Rendering must say that the run is queued, not running. It may tell the user how to inspect it; it must not mention readiness or startup completion.

The acknowledgement is a reservation snapshot, not a current Status read: a fast runner may already be running or terminal when it arrives. Never overwrite newer job state. Delivery failure after successful spawn must not fail, cancel, or relaunch the accepted job; Status/Result/PromptSubmit can discover it later.

## Enqueue and execution flow

### Background enqueue

1. Resolve the canonical workspace and exact Rescue Child/route evidence.
2. Validate the permission snapshot and fresh/continuation choice.
3. Under the existing workspace state lock, run the prior-epoch receipt gate and atomically publish the job, binding advancement, lifecycle trio, and `rescueExecutionInput`.
4. Spawn the same installed Node entry with a private Host-runner subcommand and only the canonical workspace/job selector. Use `detached: true`, `stdio: 'ignore'`, `windowsHide: true`, `shell: false` and the inherited bounded runtime environment.
5. Await only the child process `spawn` event. This catches deterministic OS creation errors and is not a runner-readiness handshake.
6. On `spawn`, call `unref()` and return the queued acknowledgement. Do not wait for claim, a pipe ACK, ZCode discovery, session resume/create, send, progress, or terminal state.
7. On a synchronous/OS spawn error, settle the still-queued job through pre-start failure policy and surface the launch error. Do not return queued.

The current `background-worker.mjs` ACK pipe is not used by this path. Its acknowledgement is presently emitted only after accepted-turn boundary persistence and is much stronger than the agreed queued contract.

### Runner execution

1. Read the exact private job from the canonical workspace and validate Host-owned background placement plus `rescueExecutionInput`.
2. Generate the existing random worker lease ID and hold its file lease for the complete process lifetime.
3. Claim via `claimJobWorkerForExecution`, publishing the actual runner PID, lease, and exact binding classification. A terminalized, cancelled, already-claimed, stale-binding, wrong-epoch, or malformed job rejects dispatch.
4. Derive fresh versus continuation from the job's reservation/binding proof. For continuation, reread the exact anchor job and obtain its ZCode session ID; never select a latest session.
5. Revalidate receipt/stop, binding generation, current job, child authority, workspace, and permission immediately before remote create/resume/send.
6. Enter the existing execution path. Publish running plus the accepted session before send; hold the cancellation admission lock across final stop revalidation, `session/send`, and accepted-boundary persistence.
7. Atomically remove `rescueExecutionInput` on running publication.
8. Reuse current progress/log/result/terminal publication. Release the worker lease only after terminal publication or retained-error cleanup completes.

### Admission and authority checks

The existing claim validates binding/worker identity but does not load Host receipts. Add matching-receipt/current-epoch checks at the shared claim and final send-admission seams. Any receipt for the job's epoch, pending or settled, prevents a new dispatch. Reuse persisted exact child proof after normal background child exit: a live child or current-turn capability is not required. SubagentStop after enqueue is not background stop authority; foreground coordination-loss policy remains intact.

Keep cancellation-lock then workspace-state-lock ordering. The runner holds its lease across execution; controllers probe it nonblocking and never wait for a runner that may need their locks. Receipt publication remains independent. A receipt racing after the final admission check owns in-flight stop/reconciliation; missing turn evidence retains uncertainty. Disk receipt publication and remote send are not an atomic transaction.

The internal runner accepts only an exact workspace/job selector and resolves data root from installed runtime configuration. It cannot reserve work, override task/owner/permission/session, or reuse a terminal job. The private local store remains the trust boundary; public knowledge of a job ID is not public execution authorization. Keep task and credentials out of argv and model-visible output.

## Pre-start settlement and binding policy

"Pre-start" means the job is still queued and no accepted ZCode session/turn has created an ambiguous remote effect.

| Cause | Fresh job | Active continuation | Session-ended migration continuation |
| --- | --- | --- | --- |
| Deterministic spawn/setup/integrity failure | Fail job; current fresh operation remains non-resumable | Atomically fail B and restore prior binding A | Atomically fail B and restore prior tombstone/binding |
| Explicit user cancel before accepted session | Cancel and close the current operation | Cancel and close the current operation | Cancel under existing migration policy |
| Matching SessionEnd before accepted session | Cancel and close the current operation | Cancel and close the current operation | Cancel under existing migration policy |
| Hard death with no conclusive evidence | Retain queued | Retain queued with rollback proof intact | Retain queued with migration proof intact |

Infrastructure failure is not user abandonment. For an active continuation it must use the existing `finishActiveRescueContinuationFailure` transaction (or a generalized equivalent with identical proof and publication guards), not generic `finishJob`. The transaction consumes the private origin only after restoring the prior binding and publishing the terminal attempt.

Generic queued recovery must preserve the marker until it chooses one of these policies. New Host-owned background jobs are excluded from `LEGACY_QUEUED_STALE_MS`; time alone never selects failure. Historical jobs retain existing compatibility behavior.

A queued job with a recorded claim whose exact lease is acquired by recovery is a proven local orphan, unlike an unclaimed job. While holding that lease, apply eligible pre-start failure settlement; a winning stop intent/receipt selects cancellation instead. Integrity failures allow settlement only with independently valid job/owner/binding/lease evidence; corrupt authority retains exclusion. Fresh pre-session failure has no resumable remote history: a later fresh operation needs a newly authorized child.

**Required CAS correction:** at baseline `ddd409e`, `finishQueuedJobAfterRecoveryLease` passes its expected lease in transition options, but `transitionStoredJob` checks the patch for `recoveryWorkerLeaseId`, skipping the comparison. Fix this before runner integration. Regression-test stale `null` and stale digest expectations against a newly published claim. Terminal-first rejection alone does not prove the reverse race safe.

An interruption after `session/send` may have been accepted is not pre-start failure and never invokes binding rollback. The plugin does not undo workspace modifications.

## Stop and SessionEnd flow

### Explicit cancel

Explicit cancel enters the Rescue Lifecycle Reconciler with cause `user`:

1. Persist/revalidate the exact stop decision under the cancellation and state locks. A claimed queued job retains `stopIntent` while queued; claim, queued-to-running, send admission, and failure rollback must respect it. Adapt validation and reconciliation so a timed-out queued cancel cannot be forgotten.
2. If no runner has claimed the queued job, terminalize it; any late claim loses.
3. If a claimed runner exists, perform the applicable exact remote stop/reread first.
4. Terminate the exact runner tree when PID identity is still proven by the held worker lease.
5. Reconcile once more after lease release if the queued/running record has not reached a durable winner.
6. Publish only an evidence-backed success/failure/cancellation winner; otherwise retain queued/running/cancelling exclusion with bounded diagnostic state.

### SessionEnd

SessionEnd keeps receipt-first ordering:

1. Publish the immutable matching-epoch SessionEnd receipt before generic cleanup or remote control.
2. Discover the receipt's exact writable obligation.
3. For an unclaimed queued job, cancel atomically and close its non-resumable operation.
4. For a claimed queued job, persist the session-end stop intent, terminate the identified runner tree, then acquire its exact lease and revalidate job/claim under the state lock before terminalizing. If budget expires first, retain the pending receipt and nonterminal job.
5. For running/cancelling with a known session, persist `stopIntent: session-end`, revalidate exact binding/generation, stop and reread the exact turn, and elect any natural terminal winner.
6. Terminate the proven local runner tree on every remote-control exit path, including timeout/unavailability.
7. Reconcile after local termination. Local death never upgrades uncertain remote state to cancelled.
8. Settle the receipt only when each obligation is terminal or has an exact durable stop intent satisfying the existing receipt rule.

A queued stop intent does not currently discharge a receipt; keep it pending. A cancelling job with an exact stop intent may discharge the receipt, but subsequent job reconciliation must retry local runner cleanup too. Reserve local-termination time inside the existing total hook deadline (below three seconds), capping remote work before it consumes that reserve. Remote timeout must not cancel the remaining local cleanup budget. A remote terminal winner does not excuse skipping cleanup of a still-held marked runner lease. Ordinary observation after child exit performs no process kill.

The local runner is not the broker. Process-tree termination targets only the runner's process group/tree. The separately managed broker remains controlled through its owner/session protocol and must not be killed as a runner descendant.

### PID safety

Signal a recorded PID only when:

- the job has a valid paired executor PID and worker lease ID;
- the runner-format marker and exact owner/epoch/job/claim still match the cleanup selection;
- a nonblocking lease probe proves the lease is held;
- an immediate second probe just before signaling still proves it held.

If the lease is free, do not signal: the runner may have exited and the PID may have been reused. Use existing bounded POSIX process-group termination and Windows `taskkill /T` behavior within the shared lifecycle deadline.

Two probes reduce stale-PID risk but do not create an atomic OS process handle; a probe-to-signal race remains. This is the existing best-effort identity policy, not absolute PID-reuse immunity. Never target unmarked attached companions with detached process-group termination. Do not spawn runner-owned descendants after lease release.

## Failure and race matrix

| Window | Durable outcome | Required convergence |
| --- | --- | --- |
| Validation/receipt gate fails before reservation | No job | Return error |
| Parent dies after reservation but before spawn | Queued, unclaimed | No age failure; SessionEnd/cancel may terminalize; otherwise unresolved |
| OS spawn rejects | Queued record exists | Pre-start failure transaction; no queued acknowledgement |
| Spawn succeeds, runner dies before claim | Queued, unclaimed | Unresolved absent stronger evidence; no retry |
| Duplicate/delayed runner | At most one claim | Claim CAS selects one; losers exit without remote calls |
| Cancel/SessionEnd wins before claim | Terminal queued job | Late claim rejects |
| Claim wins before cancel/SessionEnd | Queued with PID/lease | Stop path terminates exact runner and settles/retains by evidence |
| Runner fails setup before running | Queued with exact claim | Pre-start failure; continuation rollback where applicable |
| Resume succeeds but no turn is sent | No workspace write attributable to new turn | Existing exact setup-failure policy; never latest-session fallback |
| Send errors with unknown admission | Running, no durable turn boundary | Best-effort exact stop; retain Writable Guard; never resend |
| Send accepted but boundary publication fails | Running, no durable turn boundary | Same fail-closed guard even after a bare stop acknowledgement |
| Runner dies after durable boundary while remote active | Running, orphaned | Status/recovery observes exact turn; do not fail active work merely due to process death |
| Runner dies after durable remote completion | Running locally | Status/Result recovery publishes same job's terminal result without resend |
| SessionEnd races natural completion | Stop intent plus remote evidence | Coherent natural success may win; otherwise evidence-backed cancellation/uncertainty |
| Local kill succeeds but remote stop is unproven | Nonterminal guard/stop intent | Retain uncertainty and pending reconciliation |
| Terminalization wins before private-input cleanup | Terminal | Transition removes private input idempotently |

## Host crash and resume compensation

A runner may continue as a physical side effect if the Host process disappears without delivering SessionEnd. That is not a promise of durable execution beyond the Host session. On a later SessionStart/resume that proves a new lifecycle epoch, the existing compensation path publishes the prior-epoch receipt, reconciles the old exact job, stops the remote turn, terminates the old runner tree, and blocks new writable reservation until the prior obligation is terminal or durably delegated.

Receipt discharge and writable admission are separate: a delegated cancelling job still holds the workspace Writable Guard. A successor writable job cannot start until that guard is released by authoritative settlement. The resumed Host never adopts the old runner, resends its task, or treats process survival as authorization for a new turn.

## Exact binding and re-ignition after a boundary

Detachment does not remove or replace any continuation proof. The binding still joins the original Codex parent session, exact Rescue Child/path, canonical workspace, permission snapshot, operation ID, anchor/current job, and exact ZCode session. The runner contributes only its PID/lease while it is executing; it is not part of continuation identity.

After SessionEnd, a runner is never restarted to continue its old job. Re-ignition is a new authorized Rescue turn:

1. Receipt reconciliation first stops/settles the prior exact turn and terminates its runner. An unresolved prior obligation keeps the reservation gate closed.
2. The resumed Host/Rescue Child proves the existing exact binding and unchanged permission mode and explicitly selects continuation.
3. Reservation creates a new job in the new Host lifecycle epoch and atomically advances `currentJobId`; the old job remains historical evidence.
4. The new invocation's placement decides the executor: foreground uses the attached companion, background spawns a new thin runner.
5. The executor resumes the exact bound ZCode session and sends one new turn. It never replays the old request and never falls back to a latest session.

If the prior turn modified files before it stopped, those workspace changes remain ordinary task state. Continuation may inspect and repair them using the preserved conversation and repository state. Binding rollback applies only to an eligible new continuation that failed before execution; it is not a filesystem transaction and cannot undo the earlier turn.

## Completion and user experience

The child exits after queued acknowledgement, so the current attached `background-terminal` stdout path is no longer the normal completion channel.

- Status and Result are the authoritative pull interfaces.
- The next UserPromptSubmit uses existing notification claim/finalization to present an unread terminal result. Concurrent delivery is deduplicated; a crash after output but before marker finalization can cause redelivery. Do not promise transactional exactly-once delivery to the Host UI.
- If a terminal result is already present when Status/Result runs, existing reconciliation may publish/return it.
- Enqueue delivery must not mark the job's Completion Notice as delivered.
- No new Host callback, observer child, or notification daemon is introduced.
- Full output remains in Result; notification stays bounded and task-free.

This explicitly changes ADR 0017's live-notice-primary rule for true-background Rescue while preserving its durable single-delivery rules.

## Compatibility and governance

### Risk register

| Risk | Consequence | Required control |
| --- | --- | --- |
| Hard runner death before claim | Job can remain queued indefinitely | Honest queued semantics, explicit cancel/SessionEnd settlement, no timeout failure or auto-retry |
| Remote accepts send before local boundary persists | Workspace may change without attributable terminal evidence | Keep running Writable Guard, best-effort exact stop, never resend or roll back binding |
| Runner killed during workspace edits | Partial repository changes may remain | Treat files as task state; preserve exact ZCode session for later explicitly authorized repair |
| SessionEnd budget expires | Runner or remote turn may outlive the hook briefly | Pending immutable receipt, blocked successor reservation, later compensation/reconciliation |
| PID reuse | Cleanup could signal an unrelated process | Signal only after two immediate held-lease probes; never signal a free-lease PID |
| Private task leaks through projection | User/model boundary exposes sensitive task data | Closed schema, private permissions, allowlisted queued/Status/Result projections |
| Windows detachment differs from POSIX | Parent exit or tree cleanup behaves differently | Required native Windows qualification; do not infer support only from unit mocks |
| Source/cache/package drift | Installed plugin runs older lifecycle semantics | Source/package parity checks and installed-plugin qualification in the implementation plan |

### ADR changes required

A follow-up ADR must explicitly:

- supersede ADR 0018's prohibition on detached normal Rescue and its requirement that a background Rescue Child observe until terminal;
- preserve ADR 0018's single-owner, exact-binding, SessionEnd, and uncertainty rules;
- amend ADR 0017 so Status/Result plus PromptSubmit fallback are the normal true-background completion path;
- retain ADR 0019's Rescue Lifecycle Reconciler as the single lifecycle seam;
- apply ADR 0020's exact process-tree termination and uncertainty principles to writable detached Rescue.

### Unchanged paths

- Foreground Rescue remains attached.
- Historical detached Rescue retains sealed job specs/capabilities and its current reader/controller compatibility.
- Review and Adversarial Review retain current read-only detached behavior.
- Existing public job IDs and Status/Result commands remain compatible.
- Verify source and generated/packed plugin parity in an isolated install. Do not edit the user's live installed cache or reinstall their active plugin as part of implementation without a separate deployment request.

## Implementation slices

1. Correct the queued recovery lease CAS and test both race orders; extend reservation with persistent `rescueRunnerVersion` and bounded private `rescueExecutionInput`, with retention/redaction rules above.
2. Generalize queued pre-start settlement so active-continuation failure restores its prior binding, while cancel/SessionEnd retain intentional close semantics.
3. Add the private Host-owned runner entry and factor existing claim/execute code so attached foreground and detached background share execution below placement.
4. Replace the Host-owned background attached branch with reserve/spawn/queued response; do not reuse the existing ACK-pipe worker launcher.
5. Distinguish new Host-owned queued jobs from legacy age-based recovery.
6. Extend the Rescue Lifecycle Reconciler's cancel/SessionEnd adapters to terminate the exact writable runner tree and perform post-kill reconciliation.
7. Change completion delivery and public rendering to pull/PromptSubmit semantics.
8. Update ADRs, glossary, packaged artifacts, and platform qualification.

## Acceptance tests

### Reservation and enqueue

- Job, binding, lifecycle trio, and private input publish atomically before spawn.
- Publication failure never spawns.
- OS spawn failure does not return queued and performs correct fresh/continuation settlement.
- Hold the runner at a pre-claim barrier and verify enqueue still returns after OS spawn. Also test a fast runner that finishes before acknowledgement delivery. No ordering between acknowledgement and claim is promised without a test barrier.
- Parent/Rescue Child exit after queued does not terminate the runner.
- Failed acknowledgement delivery leaves the same durable job and does not launch a replacement.
- Qualify explicit flags, no-flag selection, mutual exclusion, foreground result waiting, and all fresh/resume × foreground/background combinations.
- Public outputs never expose task, execution input, PID/lease, binding, receipt, or ZCode session ID.

### Claim and execution

- Missing/malformed/oversized/unknown-key execution input fails before remote calls.
- Duplicate and delayed runner claims produce exactly one remote create/resume/send.
- Runner derives and revalidates the exact continuation session.
- Permission, epoch, binding generation, current-job, workspace, or child-authority mismatch prevents dispatch.
- Private input is removed on running and every queued terminal outcome.
- The runner marker survives input removal; historical attached-background jobs never enter detached process-tree cleanup. Missing/unknown marker or invalid input never dispatches.
- Normal SubagentStop before delayed runner claim preserves background authority; a matching receipt prevents dispatch even when its state is settled.

### Failure and rollback

- Spawn/setup failure for continuation B restores binding A and rejects late B claims.
- Generic recovery never deletes continuation rollback proof without applying the selected settlement policy.
- Stale recovery lease observations cannot terminalize a newer claim, including a `null` expectation that races the first claim.
- New queued jobs do not fail from age alone.
- Hard pre-claim runner death remains queued and is never automatically relaunched.
- Ambiguous send and missing-boundary cases retain the Writable Guard and never resend.
- Worker death after a durable boundary recovers exact success/failure through Status/Result.

### Stop lifecycle

- Explicit cancel and SessionEnd are tested before spawn, before claim, after claim, during setup, before send, during send, after accepted boundary, and during terminal publication.
- Claimed queued and running writable runners are terminated only with live lease identity proof.
- Free lease plus reused PID is never signaled.
- Remote stop failure still terminates the local runner but retains remote uncertainty.
- Natural success can beat stop; a bare stop acknowledgement cannot.
- Receipt remains pending when the bounded hook cannot finish local/remote convergence.
- Queued cancel intent survives hook/process exit and prevents dispatch; claimed-orphan recovery distinguishes infrastructure failure from an already-requested stop.
- Resume compensation stops the prior epoch and blocks a successor until settlement/delegation.

### Platforms

Run the complete detached lifecycle qualification on macOS, Linux, and Windows, including parent exit, process-tree descendants, runner crash, SessionEnd, PID-reuse guard, and bounded termination. Existing Windows unit coverage is insufficient because current real detached crash cases are skipped there; Windows release support requires an actual passing CI or controlled-host qualification, not inference from `taskkill` code.

## Validation evidence and remaining implementation proof

At `ddd409e`, existing `rescue-binding`, `recovery`, and `rescue-lifecycle` suites and selected continuation rollback companion tests pass. An isolated StateStore probe demonstrated that `finishActiveRescueContinuationFailure` restores A and rejects a late B claim, while generic queued orphan failure leaves binding current at terminal B and breaks strict lookup. Existing tests also prove:

- accepted send without a durable boundary retains the writable guard after best-effort stop;
- killing a worker after the exact boundary is durable can recover the same job's result through Status/Result without another send;
- terminal-first late-claim rejection is enforced; the reverse stale-recovery race requires the CAS correction identified in self-review;
- read-only detached SessionEnd has the process identity/termination pattern needed by writable Rescue.

The design is therefore implementation-feasible with no unresolved product decision. It is not yet release-qualified: the new runner path, writable process termination, schema changes, delivery behavior, full race suite, and three-platform tests must be implemented and pass before the feature can be called complete.

### Self-review correction record

The initial validation overclaimed recovery CAS safety. A fresh isolated StateStore probe reserved a Host-owned job, published its worker claim, then called `finishQueuedJobAfterRecoveryLease` with the stale expectation `null`. Expected: `WORKER_LEASE_CONFLICT`; observed at `ddd409e`: `failed` while retaining the newer worker lease. No engine/provider or runtime source mutation was involved. Existing passing suites did not cover this race.

Self-review also corrected missing format discrimination between old attached and new detached background jobs, queued stop-intent persistence, current-epoch admission checks, acknowledgement/claim ordering, notice delivery guarantees, unsupported request fields, and receipt discharge versus writable admission. These are implementation requirements within the approved foreground/background product scope. Process PID identity remains best-effort as documented; native three-platform qualification remains pending.
