# Rescue Continuation After Child Termination

Status: design specified; implementation and validation pending. Baseline: `99bc12c`.

## Objective and references

Restore continuation of the same Rescue operation when a terminated child leaves active executor records. Refer to `log/2026-09-12-t2-resume-executor-state-mismatch.txt` and `log/2026-09-12T093512+0800-t2-forwarder-usage-limit.txt` for the incident.

This supplements the “SubagentStop or the next lifecycle observation” requirement in `2026-09-02-host-managed-rescue-lifecycle-design.md`, following ADRs 0016, 0018, 0019, 0021 and CONTEXT.md. A usage limit is not a Host SessionEnd Boundary. Do not manufacture a SessionEnd Receipt.

Read-only evidence establishes a succeeded business job, its current binding, three stale active records, no matching receipt, and no stopIntent. The stopped lookup rejects `selected.active !== false`. Whether the Hook was absent, failed, or received mismatched identity remains unknown.

## Decision and entry point

Add bounded recovery to the plugin execution path; retain SubagentStop as the normal fast path. A Hook-only fix cannot cover missing delivery. Relaxing planner checks directly could allow duplicate execution.

Introduce `scripts/lib/rescue-child-reconciliation.mjs` to join trusted Host evidence, the exact binding/job, and Hook-state updates. Delegate business settlement to the existing Rescue Lifecycle Reconciler rather than duplicating remote-stop algorithms.

Call it in the prepare branch of `scripts/zcode-companion.mjs`, after validating the private envelope and before `planRescueActivation()`. Run only for resume or requests already resolved as continuation. Explicit fresh skips recovery. Role status remains read-only advisory; the planner remains read-only. Do not choose a target by catching arbitrary EXECUTOR_STATE_MISMATCH errors.

## Selection and evidence

Use complete child discovery, continuationTarget, and existing binding rules to select one operation. Preserve ambiguity errors. Match current parent, canonical workspace, child ID/path/role, permission, operation, and currentJobId. Never select the latest job or match error text.

Add `readCodexRescueChildTurnEvidence()` using controlled app-server `thread/read` with includeTurns. Require all of:

1. Child provenance, parent, path, role, and cwd match the binding.
2. The thread is not active. systemError, idle, and notLoaded alone are insufficient.
3. The latest known returned turn is explicitly terminal and correlates exactly with executor.childTurnId; no newer or in-progress turn exists. completed, failed, and interrupted qualify.
4. Unknown, truncated, unsupported, insufficient, or uncorrelatable data yields unavailable evidence. Timestamps cannot substitute for turn identity.

Validate correlation against the supported local Codex schema and a sanitized authentic fixture. Do not assume Hook turn_id always equals thread turn.id. Unsupported Host versions remain blocked with an evidence-unavailable diagnostic; do not weaken checks to pass tests.

Return only `{ child, observedTurnId, terminalStatus }`, using the existing child sanitizer. This is internal evidence, not a model-supplied capability or public parameter. Never expose message contents.

## Business settlement

| Exact state | Action |
| --- | --- |
| Host active or termination unproven | No recovery writes or new preparation |
| Old turn terminal, job terminal | Preserve winner; proceed to child settlement |
| Old turn terminal, foreground job nonterminal | Existing host-coordination-loss stop/reread; proceed only after settlement |
| Old turn terminal, background job nonterminal, no matching SessionEnd | Do not stop; block continuation pending original job completion |
| Matching SessionEnd or existing intent | Follow existing epoch/intent precedence |
| Remote stop unconfirmed, cleanup incomplete, or writable guard retained | Preserve unresolved obligations; do not declare resumable |

Do not send another session/stop to a terminal job or change its result, exitCode, completion time, or binding. Execution reservations/leases with outstanding cleanup must be discharged through existing cleanup/reconciliation; status alone cannot erase these duties.

## State updates and races

Introduce `settleExactForwardingStop(expected, validate)`. expected holds the old executor identity tuple: parent, child, childTurnId, parentGenerationId, epoch, workspace, createdAt, and matching route/forward identities. validate rechecks current caller/binding/job and captured Host evidence at each stage.

Preserve staged file-lock order. Never hold two workspace locks or make network calls inside Hook file locks. Bracket business settlement with two exact Host observations and compare snapshots before committing. Under each write lock, compare the expected tuple again. New SubagentStart generations or changed currentJobId, permissions, or parent epoch invalidate old recovery.

There is no Host/filesystem transaction. A concurrent new Host turn must still pass SubagentStart and prepared-invocation checks before execution. Eligibility, preparation save, and consume must revalidate; a Host snapshot is not permanent authority.

Reuse SubagentStop write order: exact route to stopped, forwarding to inactive, then matching executor to inactive. Return reconciled only when all three agree and the existing stopped lookup succeeds. Partial failure is not success. Retry may finish the same tuple's partial updates; never modify a published successor.

Share the conditional write primitive between SubagentStop and recovery. Native Hook identity authorizes the former; trusted Host terminal evidence plus a settled job authorize the latter. Do not fabricate Hook input for markForwarding or delete state globally. Preserve normal Hook ordering for stopping running foreground work.

After recovery, rerun the original planner and preparation.save. Do not directly invoke followup/spawn or start ZCode. Preserve operation and child identity.

## Bounds and diagnostics

Process at most one child per prepare, with at most two exact Host reads and one existing business reconciliation. Share a five-second recovery budget, respecting any shorter upstream signal. Do not loop after timeout; retain durable stop intent.

Preserve existing validation errors. Add `RESCUE_CHILD_EVIDENCE_UNAVAILABLE`, `RESCUE_CHILD_RECOVERY_PENDING`, and `RESCUE_CHILD_RECOVERY_SUPERSEDED`. Redact private IDs, messages, and permission payloads. Distinguish active execution, insufficient evidence, and pending settlement rather than recommending indefinite waiting on a known-failed child.

No scheduled service, background observer, automatic task restart, user configuration, or new binding schema. Preserve SessionEnd, background, cancellation, permission-equality, and migration policies.

## Acceptance

1. No SubagentStop/SessionEnd, exact failed old turn, terminal job, three active records: prepare returns same-child followup; result unchanged, no remote stop.
2. Exact completed/interrupted old turns also recover; a non-active thread alone does not.
3. Nonterminal foreground work uses existing stop settlement; authoritative natural success wins. Pending work retains its guard and produces no prepared response.
4. Background work is not stopped merely by child loss; SessionEnd regressions remain unchanged.
5. Wrong identity/permission/epoch, ambiguity, newer turns, activeFlags, and unknown/truncated evidence permit no recovery writes.
6. Successors inserted between observations, file writes, or preparation save/consume remain protected.
7. Concurrent prepares, duplicate recovery, and partial-write retries produce neither duplicate writers nor changed terminal winners.
8. Normal Hook continuation and notLoaded migration tests pass; source and marketplace snapshots match.

Before release, qualify the adapter with a sanitized terminal-turn fixture from a real supported Host. Read-only incident records suffice; do not exhaust usage or launch real tasks. Report unavailable qualification as a blocker; synthetic fixtures are not production evidence.
