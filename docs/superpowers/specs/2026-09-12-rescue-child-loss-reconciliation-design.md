# Rescue Continuation After Child Termination

Status: implemented and validated on `fix/rescue-child-loss-reconciliation` (baseline `99bc12c`); all eight acceptance criteria below are verified by the named tests recorded in the Acceptance validation section at the end of this document, and the turn-evidence adapter is qualified against sanitized real local app-server 0.154.0 records captured from the incident. Baseline: `99bc12c`.

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

## Acceptance validation

Validated on branch `fix/rescue-child-loss-reconciliation` by the delivery commit's runs. Focused suites: `node --test --test-concurrency=1 tests/codex-app-server.test.mjs tests/hooks.test.mjs tests/integration/two-session-hooks.test.mjs tests/rescue-child-reconciliation.test.mjs tests/recovery.test.mjs tests/rescue-lifecycle.test.mjs` (539 pass, 0 fail) and `node --test --test-concurrency=1 tests/rescue-preparation.test.mjs tests/rescue-route-planner.test.mjs tests/integration/companion.test.mjs` (492 pass, 0 fail). Evidence per criterion (test file — test name — what it proves):

1. Incident recovery: `tests/rescue-child-reconciliation.test.mjs` — "reconciles the terminal-job incident: exact failed Host turn, succeeded job, three active records, zero remote stops" — active executor plus exact failed Host turn plus succeeded job and no receipt reconciles all three stale records to stopped while the job result, exit code, completion time, and binding stay unchanged and no remote stop is sent. `tests/integration/companion.test.mjs` — "real-entry prepare reconciles the terminated Rescue child and follows up the original child without an engine send or spawn" — the real prepare entry returns the same-child followup with no engine send and no new child.
2. Other terminal turns and thread-status insufficiency: `tests/codex-app-server.test.mjs` — "qualifies completed and interrupted turns and every non-active thread status" — completed and interrupted turns return the same correlated proof the coordinator consumes, and `notLoaded`/`idle`/`systemError` thread status alone neither qualifies nor blocks. `tests/rescue-child-reconciliation.test.mjs` — "fails closed with unavailable evidence and no writes when the Host cannot prove the terminal turn" — a non-active thread without a correlated terminal turn recovers nothing.
3. Nonterminal foreground: `tests/rescue-child-reconciliation.test.mjs` — "settles nonterminal foreground work through the existing reconciler and blocks continuation while the remote stop is unconfirmed" and "an authoritative natural success during the coordination-loss stop settles the job and reconciles the child" — settlement reuses the existing reconciler and a natural success wins. `tests/recovery.test.mjs` — "child-owned settlement stops a foreground job for host coordination loss only without a matching receipt". `tests/integration/companion.test.mjs` — "unresolved foreground settlement blocks the real-entry prepare as pending while retaining the durable stop intent" — pending work keeps its guard and produces no prepared response.
4. Background and SessionEnd: `tests/rescue-child-reconciliation.test.mjs` — "nonterminal background work without a receipt or intent stays pending without any stop". `tests/recovery.test.mjs` — "child-owned settlement observes a background job without a receipt and never stops it". `tests/rescue-child-reconciliation.test.mjs` — "a matching SessionEnd receipt published before settlement keeps session-end precedence over the placement" and "a SessionEnd receipt intervening before the stop intent is persisted wins the durable cause and keeps the child records"; `tests/recovery.test.mjs` — "child-owned settlement follows the matching-epoch receipt precedence over the placement" — SessionEnd precedence is unchanged.
5. No recovery writes on mismatch: `tests/codex-app-server.test.mjs` — "rejects every uncorrelated or unprovable child evidence shape with unavailable evidence" (active thread with `activeFlags`, newer turns, unknown statuses, truncation, identity drift; diagnostics stay redacted). `tests/rescue-child-reconciliation.test.mjs` — "rejects Host evidence whose agentPath, agentRole, or cwd diverges from the binding on the first read", "rejects Host evidence whose binding identity diverges on the second read with zero stop-state writes", "a permission change between the capture and the stop writes supersedes the recovery without touching any record", "a changed caller permission between capture and the stop stage supersedes the recovery", "a changed parent epoch across the executor, binding, and job join supersedes the recovery", "a parent generation advanced between capture and the stop stage supersedes the recovery with zero stop writes", "rejects two stuck children with the preserved ambiguity error instead of choosing one"; `tests/integration/companion.test.mjs` — "ambiguous stuck children preserve the planner ambiguity diagnostic without any evidence read".
6. Successor protection: `tests/hooks.test.mjs` — "settleExactForwardingStop never deactivates a successor SubagentStart that races in between the staged locks", "settleExactForwardingStop refuses an old tuple whose executor file a successor generation republished", "settleExactForwardingStop refuses a successor generation republished over the old tuple route records", "settleExactForwardingStop reports superseded when the stopped lookup observes a successor executor". `tests/integration/two-session-hooks.test.mjs` — "a delayed old Rescue child stop never deactivates a successor generation child in real hooks". `tests/integration/companion.test.mjs` — "a successor SubagentStart landing inside recovery supersedes it before any stop write or preparation" and "a recovery-prepared continuation rejects an intervening binding advance at consume without consuming"; the existing save/consume revalidation suite (`tests/rescue-preparation.test.mjs`, e.g. "v2 records reject generation and required executor cross-field mismatches", "consumed v3 reactivation rejects an executor that differs from its activation") still passes.
7. Concurrency and partial writes: `tests/integration/companion.test.mjs` — "concurrent prepares of one continuation race to exactly one consumable preparation". `tests/rescue-child-reconciliation.test.mjs` — "concurrent duplicate recoveries reconcile idempotently without duplicate writers or a changed winner", "concurrent recovery over nonterminal foreground work waits inside the shared budget and both calls reconcile", "resumes this recovery own partially stopped tuple: stopped route, active executor", "a partial state belonging to a different tuple keeps skipping without writes". `tests/hooks.test.mjs` — "settleExactForwardingStop reports partial writes per stage and a retry finishes the same tuple". `tests/recovery.test.mjs` — "child-owned settlement preserves a terminal winner and discharges its execution reservation through the existing cleanup".
8. Normal flows and snapshot parity: `tests/hooks.test.mjs` — "the SubagentStop Hook path keeps its derived behavior when a successor executor owns the record". `tests/integration/companion.test.mjs` — "real-entry prepare with a normally stopped child keeps the original flow with zero evidence reads". notLoaded migration: `tests/rescue-route-planner.test.mjs` — "legacy migration planning accepts only exact notLoaded v1/v2 evidence and rejects mismatches"; `tests/integration/companion.test.mjs` — "exact notLoaded task_2 migrates without SubagentStop provenance and resumes its original session" and "active-v3 exact notLoaded task_2 resumes without SubagentStop provenance". Snapshot parity: `marketplace/` regenerated with the actual `scripts/build-marketplace-snapshot.mjs` CLI at the delivery commit; `tests/marketplace-snapshot.test.mjs`, `tests/release-contracts.test.mjs`, and `tests/integration/marketplace-snapshot-build.mjs` pass.

Qualification status: the authentic Host correlation is QUALIFIED, not blocked. `tests/fixtures/codex-rescue/child-terminal-evidence.json` still records `correlation.verified: true` with real-host provenance (app-server 0.154.0, read-only `thread/read` of the 2026-09-12 incident child thread and other real local threads; synthetic identities; prompts, message contents, and full host error texts excluded), and `tests/codex-app-server.test.mjs` — "keeps the evidence fixture aligned with the synthetic test identities" and "returns exact correlated terminal evidence for the incident-shaped failed child turn" prove the adapter against it. The separately opt-in real-ZCode E2E suites (`tests/e2e/codex-skills-e2e.test.mjs`, `tests/e2e/real-zcode.test.mjs`) remain SKIPPED without `ZCODE_REAL_E2E=1` on an authenticated macOS installation, as designed; they are unchanged by this work and are not the adapter's Host-evidence qualification. `npm run check` passes at the delivery commit (line endings, lint, typecheck, full suite with `--test-concurrency=1` including the marketplace-snapshot-build integration, and `test:qualified` skipped as opt-in).
