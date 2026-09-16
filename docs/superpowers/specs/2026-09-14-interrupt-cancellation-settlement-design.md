# Cancellation Settlement After an Explicit Interrupt

Date: 2026-09-14. Status: specification for implementation handoff. The user approved the direction; this document defines the implementation contract. The user additionally requires repair of the exact incident data described in section 10. This authorizes that bounded repair after validation, not application development or plugin publication.

## 1. Problem and objective

A Host-managed writable Rescue can remain `cancelling` indefinitely after a successful stop response because no readable current-turn terminal message follows. Explicit cancellation must not require the model to produce a final written report.

The adjacent `codex-plugin-cc` and `zcode-plugin-cc` repositories provide the reference behavior: the plugin settles cancellation itself. Unlike their behavior of marking a job cancelled even when interruption fails, this design requires exact stop authority, evidence that the remote interruption request was acknowledged or that the current turn ended, and evidence of managed-executor cleanup.

For an authorized cancellation of one exact job, a qualified stop acknowledgement and completed cleanup may publish `cancelled` without a final assistant message. Uncertainty retains the guard. Confirmed natural outcomes retain their precedence as defined in section 4.4.

## 2. Verified protocol facts

Evidence: `log/2026-09-14-session-inactive-investigation.md`. In the inspected ZCode 0.16.5 build, `session/stop` normally returns `{}`. It calls abort when a controller exists, can also return `{}` without a controller, and does not wait for execution to unwind. A `received` log entry is not proof that the caller received a response.

`session/read` requires a resident runtime in the current AppServer. A persisted session can exist while read reports inactive. Native resume can restore history, but performs initialization, hooks, and persistence side effects; the experiment also observed revision resetting to 0. Neither list's idle default nor a reconstructed runtime's idle state proves that the old turn stopped.

Do not rename or interpret `stopAcknowledged` as `remoteStopped`. Under this design, `cancelled` means the authorized plugin cancellation procedure has settled according to this contract; it does not guarantee that all external detached descendants have physically exited.

## 3. Scope and non-goals

Cover user cancel, supported foreground signal cancellation, SessionEnd, host-coordination-loss, and status/result/wait reconciliation of a persisted stop intent for Host-managed writable Rescue. All entry points share the decision rules and supply their own validated authority and evidence.

Do not change ordinary success classification, weaken turn identity or revision checks, or change historical behavior for read-only tasks and legacy jobs. Do not add fresh fallback, automatic cold resume, direct database reads, manual status edits, cross-owner adoption, or global termination of shared brokers. The explicit, audited incident repair in section 10 is the only exception to the restriction on live plugin-data changes. Continuing Neon Strike development remains outside scope.

## 4. Settlement requirements

### 4.1 Exact identity and authority

Persist stopIntent before stopping. Reuse existing owner, workspace partition, binding generation, job, and worker-lease validation and the cancellation lock. Evidence belongs to one exact execution and must not be reused for a successor, a later recovery pass, or a reconstructed runtime.

### 4.2 Remote evidence

There are two permitted paths:

1. **Terminal evidence exists:** a validated current-turn interrupted snapshot or lifecycle supports the existing cancellation path. No written report is required.
2. **No final report, but cancellation was performed:** the caller actually received a successful stop response over the exact managed control path, and cleanup meets section 4.3. An empty stop response from a reconstructed runtime without old-turn attribution cannot qualify.

For the second path, the same cancellation attempt must obtain at least one valid pre-stop snapshot attributable to the current turn under `persistedTurnBoundary`. The subsequent read, stop, and reread must use the same upstream protocol generation without reconstruction. The implementation must prove continuity; retaining the same JavaScript client object is insufficient. If the broker's control path cannot establish continuity, that entry point must remain cancelling. Do not start or resume a new runtime to obtain qualifying evidence. An initial read failure may still permit best-effort stop, but without valid pre-stop evidence the empty response cannot qualify for cancellation without a report.

This is a deliberate cancellation policy: acknowledgement plus verified local cleanup does not prove that the remote executor is fully quiescent. It denotes completion of the plugin's cancellation procedure. It does not claim that an executor ignoring abort, or any detached tool, stopped. A product requirement for guaranteed remote quiescence would require a stronger AppServer protocol; this change must not invent that guarantee.

If stop fails, only independent terminal interruption evidence attributable to the current turn can substitute for its acknowledgement. Local worker death, broker unreachability, list omission, session inactive, absence of an active controller, or a log that stops growing are not substitutes. This change does not introduce global process-death inference.

### 4.3 Cleanup evidence

**Marked background runner:** reuse termination with identity revalidation, a clean descendant sweep, and publication protected by the worker lease. `unproven`, exhausted budgets, and merely sending SIGTERM without confirming exit are not successful cleanup. Never kill a shared broker.

**Attached foreground worker:** `unmarked` does not mean exited. The foreground executor may provide internal finalization evidence that it has stopped sending for this turn, released its original transport turn, and entered its exit path. An external management command or hook must use exact lease release or existing validated child/executor termination evidence. If the executor can still initiate work for the turn, retain cancelling. Local cleanup alone cannot replace remote acknowledgement.

Releasing a local turn, closing a socket, or calling releaseTurn only revokes local capability; none proves remote termination. Internal finalization evidence must originate in that executor's own cancellation path, never from an external caller's inference about its PID.

**Recovery after the local worker is gone:** publication requires acquisition of the exact lease and existing generation revalidation. PID absence is not a lease substitute.

The path without a final report requires dedicated guarded publication. Within the existing cancellation lock, an external caller acquires the exact worker lease, revalidates owner, partition, binding generation, session, worker claim, and stopIntent, and publishes through CAS. A foreground worker already holding that lease must use an owner-held publication path available only from its internal finalization flow; it must not reacquire its own lease. Existing `recovery.cancelJob` calls finishJob directly and does not inherently provide these protections. Reusing that helper is not evidence of the new path's safety. Conflicts return the durable winner or retain cancelling. Do not change lease semantics for the existing authoritative-terminal path.

Adapters must produce cleanup evidence. The shared reconciler must not accept an arbitrary caller-supplied `true` that bypasses validation.

### 4.4 Outcome precedence

| Evidence | Outcome |
|---|---|
| A durable terminal winner already exists | Preserve the winner |
| Current-turn succeeded/failed confirmed before stop | Preserve the natural outcome and result |
| Succeeded confirmed after stop | Preserve succeeded |
| Current-turn interrupted and cleanup permits publication | Cancelled |
| Qualified exact stop acknowledgement in this attempt, cleanup permits publication, no contrary evidence | Cancelled; a final report is optional |
| Stop failed and no independent interruption evidence exists | Cancelling |
| Stop acknowledged but cleanup is unknown or incomplete | Cancelling |
| Only inactive, idle, an old response, regressed revision, or historical success exists | Cancelling |

Perform one bounded reread after stop to prefer an observed natural outcome. A read failure or missing assistant finish no longer independently vetoes a path that already has complete qualifying cancellation evidence. If the read explicitly shows active execution for this turn or mismatched identity, retain cancelling; acknowledgement cannot override contrary evidence.

Natural-outcome precedence applies only to authoritative evidence observed in this attempt or an already published durable winner. A remote result completed after the last reread but not retrieved before cancellation CAS cannot be guaranteed precedence locally. Once cancellation wins CAS, a late result must not overwrite it. Tests must cover this local settlement boundary without claiming distributed atomic ordering of completion.

## 5. Control flow and recovery

1. Select and validate the exact job; return an existing terminal winner.
2. Persist stopIntent and revalidate generation under the lock.
3. Attempt a bounded read and prefer any validated natural terminal outcome.
4. A read failure must not unconditionally skip stop for a session with exact stop authority. Do not create or resume another runtime to manufacture evidence.
5. Combine the stop response, one reread, and executor cleanup as internal evidence. Complete cleanup before guarded publication.
6. Publish cancellation through CAS or return the concurrent winner. Release the writable guard only through successful terminal publication.

In this first implementation, evidence for cancellation without a report is held only in the same controlled cancellation attempt. Do not add a persisted `stopAcknowledged` field that can be replayed across processes. If the process crashes after acknowledgement, the next pass must reobserve or retry; an old received log is not a durable receipt. Other historical unresolved jobs can remain unresolved under this limitation. The named incident is an explicit repair deliverable under section 10; do not pretend its missing historical acknowledgement can satisfy this automatic path.

## 6. Status and result presentation

Reuse `cancelled`, `stopCause`, and existing completion-time fields. Clear an obsolete lastCancelError on cancellation and retain existing partial logs and output. When no final report is available, display: `Run cancelled; no final ZCode report was produced.` Do not fabricate a model success report or test verdict.

Do not automatically set resumable to true. Continue deriving it from existing exact-binding and permission rules. Result/Status return the durable winner; rendering must not independently infer cancellation.

Diagnostics must distinguish stop-request failure, incomplete cleanup, and continued remote activity, within existing length and privacy limits. Record internal stop responses and cleanup outcomes through existing safe diagnostics without exposing private identity or credentials.

## 7. Acceptance matrix

Exercise real control-chain composition rather than only Boolean decisions. Every case that permits cancellation without a report must satisfy section 4.2's pre-stop attribution and continuity requirements.

- Stop returns `{}`, the final assistant is unfinished, marked-runner cleanup succeeds: cancelled, with the no-final-report notice.
- Verify the equivalent foreground internal-finalization and external-management paths separately.
- Stop errors or times out and the worker has exited, but the remote outcome is unknown: cancelling.
- Stop is acknowledged but cleanup is pending, fails, or the required lease remains held: cancelling, guard retained.
- Current-turn interruption is independently confirmed despite stop failure: cancelled after required cleanup.
- Success observed before/after stop, or another publisher's durable success winning the publication race: publish the success report once and preserve it. Unretrieved remote success follows section 4.4's CAS boundary.
- Confirmed failure before stop remains failed; cancellation-caused failure follows existing semantics.
- An inactive read still leads to an exact stop attempt when authorized; if stop is also inactive, retain cancelling.
- New-runtime idle/revision 0, historical completion, or wrong generation cannot qualify for cancellation without a report.
- The same session ID with a replaced broker/upstream generation, or an initial read that never obtained a current-turn snapshot followed by `{}`, cannot qualify.
- Repeated cancel/status/result/wait and interrupted-publication retries neither reuse receipts across jobs nor resend tasks.
- SessionEnd and child-loss use the same rules. Hooks remain bounded, and expiry does not bypass existing local cleanup duty.
- Unmarked records, PID reuse, shared brokers, and incomplete descendant sweeps cannot bypass protections.
- Queued cancellation before execution, legacy jobs, and read-only tasks retain existing tested behavior.

## 8. Delivery requirements

Design, implementation, tests, and public documentation must describe the same cancellation semantics. Deliver RED/GREEN evidence for the new behavior and full check results. Do not claim that arbitrary detached tools are guaranteed to have exited. Deliver both the implementation and the explicitly scoped incident repair in section 10. Passing code tests alone is insufficient to claim the overall task complete; if live repair is blocked by missing authority or evidence, report that remaining blocker separately.

## 9. Document review history

On 2026-09-14, independent subagent `/root/review_cancel_docs` reviewed the original specification, plan, and relevant code in two read-only rounds. The first round identified four blocking/important issues: runtime-continuity evidence, residual cancellation risk, dedicated guarded publication, and natural-success race boundaries. After revision, the second round returned **PASS, no new blockers, suitable for development handoff**. Two nonblocking wording suggestions were also incorporated. That verdict applies to the original documents, not implementation or runtime tests.

The English rewrite received a fresh independent review from `/root/review_english_cancel_docs` on 2026-09-14. The reviewer read both English documents, compared them with the original Chinese versions, and checked the referenced lifecycle and publisher entry points. Verdict: **PASS; no blocking or important issues found**. The reviewer confirmed semantic fidelity, consistent evidence and publication requirements, explicit CAS boundaries, and suitability for development handoff. This is a document-review verdict only, not an implementation, runtime-test, or incident-recovery result.


## 10. Required repair of the discovered incident data

### 10.1 Exact scope and known evidence

Repair only this job and the consistency records that its existing StateStore transaction owns:

- Project partition: `/Users/zhangzikai/Workspace/Codes/tmp/zcodeplugin`.
- Job: `7f1324964b40824f2146c479c684534946285173ecb8c4db9fbea363fcb7fa22`.
- Existing session: `sess_6ec276f7-c33c-4b6e-92f0-d71f286bedf5`.
- Observed state: `cancelling`, phase `running`, no finished timestamp; last cancellation diagnostic reports session/read inactive.
- Existing history contains 79 messages at investigation time; the last turn has an unfinished assistant and Bash tool record. A native load/read experiment succeeded but returned idle/revision 0, not a terminal result.
- Partial baseline artifacts recorded 58 passing target tests. This is neither completed T2 work nor a final result. Do not relabel it as successful implementation.

The identifiers above are selectors for an authorized repair, not credentials. Resolve the record using its exact partition and existing ownership checks. Do not scan for the latest job, substitute another session, or reuse another owner's credentials. The inconsistent job identifier in the original incident summary must be documented as corrected rather than used as a repair target.

### 10.2 Repair procedure

1. Capture the current exact job, owned binding/claim references, auxiliary cancellation records, and relevant logs without exposing secrets in the report. Revalidate that this remains the same nonterminal generation; if a successor or terminal winner exists, stop mutation and report it.
2. Create a private backup and a manifest with paths, hashes, timestamps, and exact scope before mutation. Include every record the repair transaction can change, not only the job JSON. Capture a coherent backup under the relevant cancellation/record locks and exact lease, or revalidate every pre-repair hash under those protections immediately before apply. If any dependent record changed, abort the plan and recapture/rehearse as needed; generation CAS alone does not validate an auxiliary-record backup. Preserve original diagnostics and partial output.
3. Rehearse the repair on isolated copies with no live brokers or engine calls. Validate schema, transaction behavior, repeated execution, and guarded rollback. Copies alone do not authorize live operation.
4. Prefer normal reconciliation using the implemented rules if current qualifying evidence exists. The incident's old received log, reconstructed idle, or missing finish cannot manufacture that evidence.
5. If automatic reconciliation cannot settle the old incomplete record, use a narrowly scoped **administrative cancellation repair**, distinct from engine-confirmed interruption. Require exact original executor/claim validation, a free worker lease, completed applicable managed-descendant cleanup, and a bounded inspection excluding known live execution associated with this job. If any known original execution remains active, stop it through its authorized lifecycle and recheck; if identity or cleanup remains ambiguous, leave the repair blocked. A new empty AppServer alone does not qualify.
6. Execute the administrative transaction through a reviewed maintenance entry point under the original owner's authorized context. Reuse owner/generation/lease/CAS checks and StateStore finalization. Do not edit JSON ad hoc, invoke unchecked internal writes, fabricate an AppServer acknowledgement, or bypass ownership errors. The user's request authorizes this specific repair, but does not replace runtime capability checks.
7. Set cancelled with a truthful administrative-repair diagnostic and the repair-time completion timestamp; preserve the original stop cause when valid. Do not invent an original stop time, assistant finish, historical success report, or engine event. Keep audit evidence that distinguishes this repair from automatic cancellation. Update binding, claim, writable guard, and auxiliary attempt records only through their applicable consistency transitions; do not delete session history or unrelated records.
8. Requery through official status/result in the owning context and verify the durable cancelled state, absence of a fabricated final report, consistent guard/binding state, preserved same-session identity, and idempotent repeated inspection. Verify resumability through existing read-only preparation/eligibility checks where available; do not send a new task or assert resumable merely because native loading worked.

The administrative path does not strengthen remote-stop guarantees beyond the explicit policy in section 4.2. Its audit must state the evidence collected, remaining detached-execution limits, and that the original engine terminal result was unavailable. It must never become the automatic fallback for all unreadable jobs.

### 10.3 Repair acceptance and rollback

Deliver a before/after summary, private backup location, affected-record manifest, rehearsal results, official status/result output, and a rollback procedure. Rollback may restore records only under the same locks with unchanged post-repair hashes and no successor, new work, or newer lifecycle evidence. Otherwise refuse rollback and reconcile; never blindly restore a workspace data snapshot over concurrent activity.

The code change, rehearsal, and actual incident repair are separate reported outcomes. Success requires the actual exact incident to be settled consistently, not merely a test fixture. If the original owner's capability or required evidence is unavailable, supply the precise owning-session action and mark live repair incomplete; do not announce a successful repair or repeatedly retry unauthorized commands.

This section supersedes earlier statements that excluded all incident-data repair. It does not authorize a blanket migration of historical jobs, engine-database mutation, or resuming application development.

### 10.4 Review of the scope extension

On 2026-09-14, independent subagent `/root/review_incident_scope` reviewed section 10 and plan Task 7 and returned **PASS**. The review confirmed the explicit live-data scope exception, honest administrative-repair semantics, original-owner checks, exact tuple, lease/CAS, guard consistency, rehearsal, and protected rollback. Its backup-consistency recommendation was incorporated: capture under the relevant protections or revalidate all pre-repair hashes before apply. This verdict covers documents only; live data has not been repaired by this documentation update.
