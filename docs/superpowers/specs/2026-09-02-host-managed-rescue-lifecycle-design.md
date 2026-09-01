# Host-Managed Rescue Lifecycle and Reconciliation Design

Status: approved for implementation planning on 2026-09-02

## Executive decision

Normal ZCode Rescue execution becomes Host-managed. A foreground Rescue keeps its native Rescue Child attached to the exact companion process until the durable terminal result. A background Rescue uses the same attached execution path but lets the Codex Host continue serving the user while the Rescue Child remains active. Neither inferred nor explicit background placement authorizes execution across the owning Host SessionEnd boundary.

Durable state remains essential, but its purpose changes: it records exact authority, progress, stop intent, terminal winners, results, and abnormal-path reconciliation. It is not an independent execution owner for new Rescue runs.

The implementation preserves the codebase's mature identity, binding, state, protocol, cancellation, progress, and compatibility machinery. It concentrates their lifecycle ordering in one Rescue Lifecycle Reconciler rather than replacing them or adding another parallel state machine.

## Problem and incident evidence

The triggering incident had this sequence:

1. A Host Rescue Child reported a Codex usage-limit failure.
2. The user logged out, changed account, later resumed the Codex conversation, and sent `go`.
3. The corresponding ZCode turn and durable writable job survived the logout and eventually completed.

Usage-limit itself was not Host SessionEnd. The later successful logout should have caused Codex to dispatch SessionEnd. The installed ZCode 0.16.5 app server has a real `session/stop` method that aborts the exact active turn without deleting its reusable session. The surviving job therefore was not caused by missing ZCode stop semantics.

Durable artifacts show that the plugin did not complete its first SessionEnd mutation: the original session, executor, route, forwarding, broker-owner, and job records remained unchanged; no stop error was recorded. Current SessionEnd code performs `identity.cleanupSession()` before Rescue settlement. The Host gives the hook three seconds, while that first cleanup can wait up to the generic five-second file-lock timeout without receiving the SessionEnd abort signal. Historical lock contention is not proven, but this ordering is a concrete failure mechanism matching the zero-mutation evidence.

The architectural defect is broader than one timeout. Normal background Rescue currently creates a detached `unref` worker, while Root, the Rescue Child, route planning, hook state, SessionEnd, status, cancellation, and orphan recovery each interpret only part of the lifecycle. This creates two execution owners and no single interface that can decide the joined state.

## Goals

- Record stop authority at every genuine Host SessionEnd boundary and converge every matching session-bound run to a durable terminal winner.
- Preserve a ZCode session after its active turn stops so a later separately authorized turn may resume it.
- Make foreground and background Rescue Host-managed without losing durable progress, status, result, cancellation, or crash recovery.
- Persist the ending-session decision before fallible cleanup or remote control.
- Reuse existing exact binding, authorization, StateStore, cancellation, worker-lease, v4 progress, terminal, and result machinery.
- Put lifecycle ordering, race resolution, and public outcome selection behind one deep module interface.
- Keep historical detached jobs manageable without creating new detached Rescue jobs or bulk-cancelling old work during upgrade.
- Preserve one active writable Rescue per canonical workspace.
- Make the real incident and its nearby races deterministic acceptance tests.

## Non-goals

- No `--durable` or `--detach` product mode.
- No automatic continuation across SessionEnd, cancel, usage-limit, or engine failure.
- No repository-wide rewrite of StateStore, the ZCode client, hooks, commands, or tests.
- No public ZCode session ID or child ID.
- No latest-session or latest-job fallback for Rescue continuation.
- No permission-mode migration for an existing binding.
- No retroactive reopening of historical `closed/cancel` bindings.
- No Host-managed migration for Review or Adversarial Review in this change.
- No concurrent writable Rescue in one canonical worktree.
- No claim that an empty `session/stop` acknowledgement alone proves terminal cancellation.
- No provider call in ordinary unit or integration tests.

## Product invariants

1. **One owner for normal live Rescue execution.** The native Rescue Child owns and observes the attached companion process. Durable state journals the run but does not execute it.
2. **Session-bound authority.** Host background placement may outlive the initiating interaction but never the owning Host session.
3. **Turn stop is not session deletion.** SessionEnd, explicit cancel, and foreground Host Coordination Loss stop the exact active turn while preserving a resumable exact binding when the new schema permits it.
4. **Durable truth wins.** A completion notice, child status, process exit, stop acknowledgement, or elapsed time cannot replace the durable job winner and exact ZCode turn evidence.
5. **Natural success may win a stop race.** If the exact turn completed successfully before cancellation settled, publish `succeeded` and its result artifact.
6. **Uncertainty retains exclusion.** An unresolved writable stop remains `cancelling`, retains the Writable Guard, and exposes bounded retry information.
7. **Continuation is new authority.** Preserved history never starts work by itself; a later Host turn must select resume and pass exact binding and permission validation.
8. **Historical compatibility is read/control compatibility, not architectural continuation.** Old detached records remain operable, but new Rescue never launches that worker path.

## Existing investment: reuse versus replacement

| Existing area | Decision | Reason |
| --- | --- | --- |
| Caller identity, parent/child provenance, canonical workspace routing | Reuse | These are authorization assets independent of worker ownership. |
| Private Rescue preparation envelope and task-free child assignment | Reuse | They prevent task, identity, and capability leakage through the model boundary. |
| Exact child-path selection and ZCode session binding | Reuse and extend | Exact continuation remains correct; new cancellation semantics add resumable cancelled anchors. |
| Permission snapshots and permission decision policy | Reuse unchanged | Resume still requires the same Codex permission mode. |
| StateStore, native advisory locks, CAS transitions, one-writer admission | Reuse | They provide the durable winner and workspace safety. |
| ZCode broker/client, `session/stop`, v4 frames, snapshot classifier | Reuse | They already provide exact control and authoritative terminal evidence. |
| Cancellation election, pre-stop revalidation, stop/reread, natural-success winner | Reuse behind Reconciler | The primitives are mature; their orchestration is currently scattered. |
| Worker leases and historical capability/job-spec formats | Retain for compatibility | They remain necessary for old detached jobs and read-only detached commands. |
| Foreground progress relay and durable progress/log/result artifacts | Reuse | Host-managed background can use the same live observer and durable output. |
| UserPromptSubmit unread terminal markers | Retain as fallback | They cover lost Host delivery and historical detached jobs, not the new primary path. |
| Detached Rescue worker launch | Stop using for new Rescue | It creates a second normal execution owner and conflicts with SessionEnd authority. |
| Scattered lifecycle interpretation in route/hooks/status/cancel/recovery | Replace at caller seam | The deep Reconciler must own the joined decision and ordering. |

## Execution ownership matrix

| Command and placement | Normal execution owner | SessionEnd behavior | Completion delivery |
| --- | --- | --- | --- |
| Rescue foreground | Foreground Rescue Child plus attached companion | Exact bounded stop and durable settlement | Full result returned in the initiating interaction |
| Rescue background, inferred or explicit | Background Rescue Child plus attached companion | Exact bounded stop and durable settlement | Immediate concise Host Completion Notice; full output through Result |
| Review/Adversarial foreground | Existing foreground companion | Ends with the foreground invocation | Existing foreground output |
| Review/Adversarial background | Existing detached worker | Session-bound stop/settlement; retain durable record | Existing status/result and PromptSubmit fallback |
| Historical detached Rescue | Historical detached worker until it converges | Existing owner may status/result/cancel; SessionEnd/recovery settles it | Existing status/result and PromptSubmit fallback only |

Rescue chooses foreground for small, clearly bounded work and background for complex, open-ended, multi-step, or likely long work. It does not ask an extra placement question. Explicit `--wait` and `--background` override inference. Review and Adversarial Review continue to ask when no placement flag is supplied.

## Rescue Lifecycle Reconciler

### External seam

The module exports one factory and one operation. Production composition supplies the adapters once; lifecycle callers invoke only `reconcile(request)`. Callers must not receive raw host/executor/binding/job/remote state and then decide what to mutate.

```text
createRescueLifecycleReconciler(adapters) -> {
  reconcile(request) -> outcome
}

request.intent =
  prepare
  | observe
  | stop(user | session-end | host-coordination-loss)
  | wait

outcome =
  spawn-child
  | followup-child
  | wait-current
  | return-result
  | settled-terminal
  | unresolved-stop
  | fail-closed
```

The request contains only the intent, validated caller or maintenance authority, canonical workspace, bounded wait budget when applicable, and an authorized public or private exact selector already permitted at that caller seam. It does not contain a caller-assembled lifecycle snapshot.

The outcome is bounded and task-free where it crosses into Root or a child directive. Private exact identifiers remain inside the plugin except for existing public job references.

### Owned implementation behavior

The Reconciler loads and joins:

- Codex child observation (`active`, `idle`, `notLoaded`, `systemError`, or absent);
- executor route and forwarding provenance;
- exact binding, anchor job, and current job;
- execution owner and Host placement;
- worker lease or historical execution reservation;
- accepted ZCode turn boundary;
- v4 and snapshot terminal evidence;
- SessionEnd receipt and durable stop intent;
- cancellation-attempt and terminal-winner state.

It then owns the complete mutation order. It may persist stop intent, transition the job, open an existing ZCode control adapter, stop, reread, publish success/cancellation/failure, clean a terminal execution reservation, and return the final bounded outcome. It is not a pure classifier and never returns a mutation plan for the caller to execute.

### Internal seams

The module accepts internal adapters for:

- StateStore and lifecycle receipt storage;
- Codex child discovery;
- executor/binding lookup;
- ZCode existing-broker control and terminal observation;
- clock and cancellation budget;
- result artifact and notification publication.

Production adapters reuse current modules. Tests use filesystem-backed StateStore fixtures and in-memory Host/ZCode adapters. These adapters are private to the Reconciler implementation; they do not widen its external interface.

### Caller migration

These callers become thin adapters to the Reconciler:

- Rescue preparation and route planning;
- Rescue Child/SubagentStop lifecycle handling;
- SessionEnd Rescue settlement;
- UserPromptSubmit pending-stop and missed-delivery handling;
- Rescue status, result, cancel, and status wait;
- writable Rescue reservation and orphan maintenance.

Low-level codecs, stores, protocol clients, terminal classifiers, result writers, and renderers remain separate modules behind internal seams.

## Durable lifecycle records

### SessionEnd Receipt

SessionEnd must make one bounded durable write before generic identity cleanup, broker release, worker termination, or remote control. The private receipt is scoped to one exact Host lifecycle epoch:

```json
{
  "version": 1,
  "kind": "host-session-end",
  "sessionId": "private exact Host session",
  "sessionStartedAt": "RFC3339",
  "endedAt": "RFC3339",
  "epoch": "bounded digest",
  "origin": "session-end-hook",
  "workspaceHints": ["private canonical workspaces"],
  "state": "pending"
}
```

`origin` is `session-end-hook` for a normal boundary and `resume-compensation` when a later resume proves that the preceding epoch ended without a receipt. The epoch is `sha256(["host-lifecycle-epoch-v1", sessionId, sessionStartedAt])`; the filename is a bounded digest of the epoch, and the record remains private. A new `sessionStartedAt` therefore creates a new epoch even when a resumed Host reuses the same session ID. Workspace hints are discovery aids, not authorization. They are canonicalized, sorted, deduplicated, limited to 128 entries, and limited to 4,096 UTF-8 bytes each. Reconciliation still validates exact job ownership, lifecycle epoch, timestamps, binding, and workspace.

The receipt uses an epoch-specific path and atomic idempotent publication without the generic shared identity lock. Creation is first-writer-wins for `endedAt` and `origin`; a repeated hook may only merge validated workspace hints under the same bounded receipt-specific lock. It cannot move the boundary later or weaken a pending receipt. Lock acquisition and atomic publication share the local abort budget. The complete local receipt phase has a 500 ms budget; all SessionEnd sub-budgets together must stay below 2.75 seconds, leaving at least 250 ms before the Host's three-second hard deadline. If exact per-job stop intents cannot be published within the remaining budget, the pending receipt remains the durable compensation authority. It never claims that any job has stopped.

After every matching obligation is terminal or has its own exact durable stop intent, the receipt becomes `settled`; unresolved per-job intents continue reconciliation independently. Pending receipts are never age-evicted. Settled receipts are retained for 30 days and capped at the newest 512 per plugin data root. A failed or killed hook therefore leaves evidence distinguishing non-dispatch from post-receipt failure.

### Job lifecycle additions

New Rescue records add closed, validated fields:

```json
{
  "ownerLifecycleEpoch": "bounded digest",
  "executionOwner": "host-child",
  "hostPlacement": "foreground",
  "stopIntent": {
    "version": 1,
    "cause": "user",
    "requestedAt": "RFC3339"
  },
  "stopCause": "user"
}
```

- `ownerLifecycleEpoch` binds the job to the SessionStart epoch that authorized it. A later resume can therefore stop only pre-boundary jobs.
- `executionOwner` is `host-child` for new Rescue. Historical absence is interpreted only through validated legacy schema evidence, never by guesswork.
- `hostPlacement` is `foreground` or `background` and controls Host Coordination Loss policy. It does not control companion detachment.
- `stopIntent` is optional before a stop is authorized and mandatory before a new-schema non-queued stop attempt. It remains persisted through terminal settlement.
- `stopCause` exists only on a confirmed `cancelled` terminal winner and is one of `user`, `session-end`, or `host-coordination-loss`.
- `resumable` is derived from the exact current binding and job evidence for Status/Result; it is not persisted as independent authority.
- Existing `lastCancelError`, result artifact, progress, accepted-turn boundary, cancellation-attempt, and terminal fields are reused.

Queued cancellation before a ZCode session is accepted may become `cancelled` but is not resumable because no remote session exists.

## Binding and resume semantics

New-schema cancellation no longer revokes the exact binding merely because the current job becomes `cancelled`. The binding retains the ZCode session, operation, exact child authority, workspace, and permission snapshot. A later authorized resume advances `currentJobId` through the existing reservation CAS and starts exactly one new ZCode turn.

Resume eligibility requires all of the following:

- the job has an accepted ZCode session;
- the binding is exact, current, non-corrupt, and belongs to the same Host session and workspace;
- the exact Codex child/path and executor provenance are valid or validly persisted/notLoaded;
- the current permission mode equals the binding snapshot;
- there is no unresolved stop, active turn, conflicting generation, or writable exclusion;
- the user/Host selected continuation rather than a fresh operation.

Status and Result expose `resumable: true|false` and a user-level Rescue hint. They never expose the internal ZCode session ID. Explicit `--resume` and `--fresh` remain authoritative. Semantic selection and the existing single-question ambiguity flow remain unchanged; no `--resume-job` flag is added.

Historical `closed/cancel` bindings remain closed. The upgrade does not infer that an old cancellation meant pause. Historical completed/session-ended migration rules remain supported as already specified.

## Lifecycle flows

### New foreground Rescue

1. Root classifies placement or honors `--wait`.
2. Existing preflight and private preparation select fresh or exact continuation.
3. The Reconciler returns one task-free spawn/followup directive.
4. The Rescue Child runs the constant `invoke-prepared rescue` attached command.
5. The companion reserves the job with the current `ownerLifecycleEpoch`, `executionOwner: host-child`, and `hostPlacement: foreground`; it does not seal or launch a detached worker.
6. Existing permission, broker, v4 progress, accepted-turn, terminal, artifact, and job-log logic runs.
7. The child returns only after the durable terminal winner, and Root presents the full result.

### New background Rescue

Steps 1–6 are identical except `hostPlacement: background`. Root announces background placement and does not block the user-facing interaction on the child. The same Rescue Child and attached companion remain the execution observer. Progress continues through the existing bounded relay. After the durable terminal winner and result artifact are published, the child emits one concise Host Completion Notice. Full output remains available through Result.

The companion never maps `hostPlacement: background` to `startBackgroundWorker()` for new Rescue.

### Foreground Host Coordination Loss

A Rescue Child usage-limit, crash, `systemError`, or other loss without a SessionEnd receipt matching the job's `ownerLifecycleEpoch` is Host Coordination Loss, not Engine Terminal Failure.

For a foreground job, SubagentStop or the next lifecycle observation invokes `stop(host-coordination-loss)`. The Reconciler persists stop intent, revalidates the exact job/binding/generation, performs bounded stop/reread, and settles the winner. It never promotes the run to background. If no acknowledgement or terminal evidence is available, the job remains `cancelling` with its Writable Guard.

### Background Host Coordination Loss

For a background job whose `ownerLifecycleEpoch` has no matching SessionEnd receipt or stop intent, loss of the Rescue Child does not authorize stop. The ZCode turn may continue in the broker without a live Host observer. Durable status, the first later prompt, result/cancel, or reservation reconciliation reads the exact remote state and publishes its winner. Immediate Host completion may be lost; PromptSubmit remains the fallback.

A later genuine SessionEnd receipt matching that lifecycle epoch overrides this continuation policy and requires stop. A retained receipt from an older epoch has no authority over a post-resume job.

### Explicit cancel

Cancel persists `stopIntent.cause = user` before remote control. It reuses the existing cancellation election and exact pre-stop guard. Confirmed interruption publishes `cancelled` plus `stopCause: user`; natural success publishes `succeeded`; unresolved observation stays `cancelling`. The exact session/binding remains resumable only under the new schema and only after the stop is terminally settled.

### Genuine SessionEnd

1. Validate the strict hook input.
2. Persist the SessionEnd Receipt as the first mutation.
3. Discover matching session-owned jobs using the receipt epoch and validated workspace/job state.
4. Publish exact per-job `stopIntent.cause = session-end` where the current budget permits.
5. Reconcile in bounded parallelism, using only an existing healthy broker; do not lazily spawn ZCode during shutdown.
6. Stop/reread each session-bound active Rescue and detached read-only run.
7. Preserve natural successes; publish confirmed cancellations with `stopCause: session-end`; leave uncertainty durable.
8. Release broker ownership only where durable state proves it safe.
9. Perform generic identity, preparation, and hook-state cleanup with the remaining budget.
10. Mark the receipt settled only when every exact obligation is terminal or durably delegated to a retained unresolved intent according to the receipt schema.

The hook must remain bounded below the native three-second deadline. Every file-lock and remote request receives the shared abort signal and a stage-specific sub-budget. A hook exit of zero means the shutdown decision is safely recorded, not necessarily that every remote stop reached terminal settlement.

### Resume after SessionEnd

`SessionStart(source=resume)` atomically reads the previous recorded epoch before publishing the new epoch. If the previous epoch has nonterminal owned jobs but no SessionEnd Receipt, it writes a local `resume-compensation` receipt whose `endedAt` is the new resume timestamp. It also recognizes existing pending receipts. This hook does not open the broker, call ZCode, or wait on remote settlement. `SessionStart(source=compact)` remains in the same epoch and never synthesizes a boundary.

Before the first subsequent UserPromptSubmit establishes new Rescue work, the plugin retries matching pending reconciliation. The same retry occurs for status, result, cancel, and new writable reservation. If reconciliation remains unresolved, a new writable Rescue is blocked; status/result remain available. Once terminally settled, the user may explicitly resume the preserved exact session or start fresh.

### Engine Terminal Failure

A ZCode provider usage-limit or ZCode execution error is Engine Terminal Failure and publishes `failed`, not `cancelled`. If the ZCode session was accepted and the exact binding remains valid, Status/Result report it resumable. A later explicit resume starts a new turn and does not rewrite the prior failed outcome. Failure before session acceptance requires fresh.

### Read-only detached background commands

Review and Adversarial Review retain their existing detached worker path. They remain session-bound. SessionEnd records the boundary, performs bounded exact remote stop when a ZCode turn exists, then terminates the exact recorded worker process tree. Process termination does not count as remote terminal proof; the job remains unresolved when stop/reread cannot establish a winner. They do not use the Rescue Lifecycle Reconciler's writable binding interface.

### Historical detached Rescue

The upgrade stops creating new detached Rescue jobs but continues to validate historical job specs, capabilities, reservations, leases, and bindings. The original owner may use Status, Result, and Cancel; lifecycle maintenance may reconcile them. Upgrade does not cancel them, adopt them into a new Host child, or require manual deletion. Completion uses existing durable delivery and PromptSubmit fallback only.

## Progress and completion delivery

The existing v4 conversation subscription remains the primary live progress and terminal-candidate channel. A terminal v4 frame is not itself the public result. The companion must first confirm the current turn through the shared terminal classifier, write the result artifact when that terminal outcome has one, and publish the durable terminal job winner.

Delivery order for new Host-managed background Rescue is:

```text
v4/snapshot terminal evidence
  -> durable terminal job and result artifact
  -> concise Host Completion Notice
  -> mark live delivery as notified
```

If live delivery fails, no false notified marker is written. A later UserPromptSubmit may emit the existing bounded missed-delivery reminder. Successful live delivery suppresses duplicate prompt reminders. Historical detached and read-only detached jobs continue to use the existing fallback behavior.

The notice contains job ID, terminal status, bounded Stop Cause or failure summary when applicable, `resumable`, and the Result command. It does not contain full output, private paths, prompts, child IDs, session IDs, capabilities, or raw protocol errors.

## Status and Result behavior

Status invokes reconciliation before rendering an owned job. `status --wait` repeats through the same Reconciler until a durable terminal winner or the command's wait timeout. A wait timeout is observational and never authorizes stop or force release.

Result also reconciles an owned selected job before deciding whether output is available. Terminal views include:

- `succeeded`: full stored result and `resumable` when exact continuation remains valid;
- `failed`: bounded terminal error and `resumable`;
- `cancelled`: Stop Cause and `resumable`;
- `cancelling`: no terminal claim, bounded `lastCancelError`, and status-wait/cancel recovery guidance.

Implicit Result selection continues to ignore active jobs. Public projections remove permission snapshots, internal execution ownership proof, stop receipts, binding details, worker/capability data, and ZCode session IDs.

## Race and failure rules

| Observed condition | Required outcome |
| --- | --- |
| Stop races with exact natural success | `succeeded` with the authoritative artifact |
| Stop acknowledged and reread proves current-turn interruption/failure | `cancelled` with Stop Cause |
| Stop acknowledgement but current turn remains ambiguous | `cancelling`; retain guard and retry evidence |
| Existing broker unavailable but exact executor may still exist | unresolved unless worker/remote absence is safely proven |
| Exact worker lease is free and remote turn is absent/unrecoverable | `failed` with bounded recovery reason |
| Host child is `systemError/notLoaded`, foreground job running | persist foreground stop intent and reconcile |
| Host child is lost, background job running, owner session active | keep running; reconcile later |
| Host child is lost and a SessionEnd receipt matches `ownerLifecycleEpoch` | stop and settle |
| Host child is lost and only an older-epoch receipt exists | apply foreground/background Host Coordination Loss policy; the old receipt grants no stop authority |
| Binding/job generation changes before stop | stale caller performs zero stop and returns current winner |
| New writable reservation encounters unresolved old writer | reconcile once, then reject while guard remains |
| SessionEnd hook loses budget after receipt | exit bounded; later prompt/status/reservation continues reconciliation |
| SessionEnd hook cannot persist the initial receipt | exit nonzero with bounded stage diagnostic; never claim cleanup |

No elapsed-time threshold alone changes a writable job to terminal or releases its guard.

## Security and privacy

- Existing same-UID trust assumptions remain unchanged.
- The model never receives capabilities, ZCode session IDs, child IDs, binding keys, permission snapshots, raw stop receipts, or sealed historical job specs.
- Root supplies only the existing retained canonical child path through the private preparation channel; the path selects but grants no authority.
- Resume requires exact parent, child/path, workspace, permission, binding, job, generation, and ZCode session joins.
- SessionEnd receipts are private, bounded, schema-validated, and epoch-scoped.
- Public errors remain allowlisted/bounded; raw filesystem, broker, provider, or protocol errors are not rendered.
- Review and Adversarial Review remain read-only under their existing permission policy even while detached.

## Module and file impact

Expected primary changes:

- Add a Rescue lifecycle reconciler module and focused interface tests.
- Adapt `scripts/lib/rescue-route-planner.mjs` to delegate joined lifecycle decisions; retain child discovery as the Host-observation adapter and retain the existing directive codecs.
- Adapt `scripts/lib/recovery.mjs` and `scripts/lib/job-control.mjs` so their Rescue orchestration enters the Reconciler while low-level primitives remain reusable.
- Extend `scripts/lib/state.mjs` and binding codecs for new execution ownership, stop intent/cause, and resumable cancelled anchors with legacy read compatibility.
- Change `scripts/zcode-companion.mjs` so new Rescue background placement remains attached and never calls `startBackgroundWorker`; retain historical `run-reserved-job` support.
- Update `skills/rescue/SKILL.md`, the managed Role template, and their contract tests for complexity placement and Host-managed foreground/background behavior.
- Change `hooks/session-end-hook.mjs` to persist the receipt first and use shared bounded cancellation; extend session-bound settlement to read-only detached jobs.
- Change `hooks/subagent-hook.mjs` from marker-only handling to a bounded Rescue lifecycle trigger after recording the exact child transition.
- Change `hooks/session-lifecycle-hook.mjs` to local-only pending receipt recognition on resume.
- Change `hooks/user-prompt-hook.mjs` to reconcile pending receipts before new Rescue authority and retain unread delivery only as fallback.
- Reuse `conversation-progress.mjs`, `rescue-progress-relay.mjs`, `turn-terminal.mjs`, result artifacts, job logs, ZCode client/broker, permissions, and native locking.
- Update Status/Result renderers, README/README.zh-CN/SECURITY/CHANGELOG, ADR cross-references, generated Role content, package payload, and marketplace snapshot.

The exact file split is an implementation-plan decision. The design requirement is behavioral locality at the Reconciler interface, not a prescribed filename count.

## Migration and rollout

Implementation is staged inside one feature program:

1. Introduce lifecycle receipt and new optional job/binding schema fields with legacy read compatibility.
2. Build the Reconciler against current primitives and make incident/race tests pass while current execution remains available behind test adapters.
3. Route foreground Rescue lifecycle callers through the Reconciler.
4. Switch new background Rescue from detached worker ownership to Host child placement.
5. Add live background completion delivery and keep PromptSubmit fallback.
6. Extend SessionEnd settlement to existing read-only detached jobs.
7. Verify historical detached Rescue status/result/cancel/recovery and prevent new creation.
8. Regenerate installed Role and marketplace artifacts only after source tests pass.

No installation step scans and rewrites all historical jobs. New readers accept old records. New writers emit the new schema. Historical `closed/cancel` remains closed. Compatibility removal requires a future explicit migration decision.

## Acceptance tests

### Reconciler interface matrix

The primary suite tests through the Reconciler interface, not by duplicating its internal decisions in callers:

1. Host child `active`, `idle`, `notLoaded`, `systemError`, and absent crossed with exact job `queued`, `running`, `cancelling`, `succeeded`, `failed`, and `cancelled`.
2. Foreground versus background Host placement for every nonterminal child-loss case.
3. Exact binding valid, stale generation, wrong child/path, wrong workspace, wrong permission, ambiguous sibling, closed historical cancel, and legacy session-ended migration.
4. Stop success, stop failure, acknowledgement without terminal evidence, natural-success race, terminal failure, missing broker, lost worker lease, and changed winner before stop.
5. SessionEnd receipt pending/settled, hook budget exhaustion, lock contention before former identity cleanup, resume epoch, and new post-resume job exclusion.

### Host execution tests

- New background Rescue starts zero detached workers, writes no new execution capability/job spec, and keeps one attached child companion handle.
- Foreground Root waits; background Root returns while the exact child remains active.
- Inferred placement selects foreground for bounded work and background for complex work; flags override without extra questions.
- Foreground child loss attempts exact stop; background child loss with an active owner does not stop.
- Genuine SessionEnd stops both placements.
- A background durable terminal winner is published before one Host Completion Notice; successful delivery suppresses PromptSubmit duplication.

### Resume and cancellation tests

- Explicit cancel and SessionEnd produce `cancelled` plus the correct Stop Cause and preserve a new-schema exact binding.
- A later explicit resume starts exactly one new turn in the same ZCode session.
- Cancelled queued-before-session work is not resumable.
- Failed accepted Engine turns are resumable; pre-session failures are not.
- Permission change requires fresh.
- Historical `closed/cancel` remains closed after upgrade.

### SessionEnd and incident regression

- Reproduce the incident shape: foreground child usage-limit, logout SessionEnd, hook contention at the former first cleanup seam, later account/session resume, and `go`.
- Prove the receipt is durable before the hook can be killed.
- Prove a resumed lifecycle synthesizes a local `resume-compensation` receipt when the previous epoch has nonterminal owned jobs but no receipt, without opening the broker during SessionStart.
- Prove retained old-epoch receipts never stop a new post-resume job.
- Prove the later prompt retries exact stop/settlement instead of treating the old turn as authorized background work.
- Prove natural success that won before stop remains succeeded.
- Prove unresolved stop blocks another writable Rescue and is visible through `status --wait`.
- Prove no blind cancellation and no blind continuation.

### Reuse and compatibility tests

- Existing v4/snapshot true-terminal fixtures remain authoritative.
- Existing cancellation election, generation guard, worker lease, permission, linked-worktree, exact child, result artifact, and public-redaction suites remain passing.
- Historical detached Rescue can status/result/cancel and converge without a new monitor child.
- Background Review/Adversarial remains detached but is stopped and durably settled at SessionEnd.
- Old job/binding/preparation versions remain readable according to their current migration limits.
- Marketplace-installed behavior matches source, including hooks, Role, Skill, runtime, docs, and schemas.

### Real qualification

Before release, run a controlled local Codex qualification that proves graceful logout dispatches SessionEnd, the receipt is written, and a resumed conversation recognizes pending settlement. Run the existing opt-in real ZCode 0.16.5 stop qualification at an active permission barrier to prove the exact turn is interrupted and prohibited workspace mutation does not occur. Provider-backed qualification must be explicit and must not run in ordinary CI.

## User-visible changes

- Rescue without a placement flag may now announce background execution for complex work instead of always blocking.
- `--background` Rescue no longer means an independently detached plugin worker; it means Host background placement.
- Logging out or otherwise ending the Host session stops all session-bound work, including explicit background runs.
- A stopped, cancelled, or failed accepted Rescue may later be explicitly resumed when `resumable` is true.
- Status and Result show `resumable` and Stop Cause without exposing internal IDs.
- Background Rescue completion arrives promptly while the Host session is active; full output remains in Result.
- If cancellation is uncertain, users see `cancelling` and recovery guidance instead of a false cancelled/succeeded claim.
- Historical detached jobs continue to work through the existing management commands but do not gain the new live notice channel.

## Impact and breakage assessment

The change is materially valuable because it fixes the observed logout/usage-limit split brain, aligns execution authority with the Host lifecycle, reduces duplicated lifecycle reasoning, and makes the hardest races testable through one interface.

The migration is structurally significant. It changes Rescue background process ownership, job/binding terminal eligibility, SessionEnd ordering, child-stop behavior, notification delivery, and many tests that currently assert detached worker creation. Bugs could cause premature stop, duplicate completion, blocked writable work, lost compatibility, or incorrect resume authority. The staged rollout and interface-level matrix are therefore mandatory.

Expected intentional breakage is limited to semantics that conflict with the accepted design:

- no new detached Rescue worker/capability/job spec;
- no default-foreground guarantee for unflagged Rescue;
- no cross-SessionEnd background continuation;
- no permanent binding revocation for new-schema confirmed active-turn cancellation;
- no primary reliance on next-prompt completion delivery.

All other mature behavior should remain compatible unless an acceptance test proves that it encodes one of these rejected semantics.

## Decision references

This design is governed by ADR 0015 through ADR 0020 and amends older ADR language only where those newer decisions explicitly supersede foreground defaults, detached Rescue ownership, SessionEnd/cancel binding closure, notification primacy, or scattered lifecycle interpretation.
