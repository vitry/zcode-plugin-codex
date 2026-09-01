---
status: accepted
---

# Use Host-managed execution for session-bound runs

Foreground and session-bound background Rescue runs are both Host-managed Companion Runs: the Codex Host chooses the Rescue Child's placement, and that child retains live ZCode observation through the authoritative terminal outcome. Normal background execution no longer launches an internal detached `unref` worker; Tracked Jobs remain the durable journal and reconciliation boundary rather than the normal execution owner. This follows the Rescue execution-control pattern of `codex-plugin-cc`, enables existing v4 progress to feed immediate Host completion, and aligns child interruption and SessionEnd with the actual run.

The detached worker provided real independence from Host child failures, immediate return, and host-agnostic background execution, but those benefits implement an independently durable product mode that this design explicitly rejects. Its normal-path process, sealed-spec, capability, lease, and delivery machinery created a second lifecycle owner and made SessionEnd, progress delivery, and cancellation convergence substantially harder. Existing durable records still require compatible reconciliation; abnormal coordination loss must not be mistaken for permission to create or adopt a new detached execution owner.

Upgrade compatibility is non-destructive. New versions stop creating detached jobs for normal execution but continue to recognize historical job schemas and capabilities so the original owner can use status, result, and cancel while lifecycle maintenance safely reconciles them. Installation or first launch neither bulk-cancels historical work nor requires manual state deletion; compatibility can be removed only through a separately designed migration after supported historical records have converged.

Historical detached Rescue jobs retain their existing durable status/result surfaces and UserPromptSubmit missed-delivery fallback. The upgrade does not create a Host child, compatibility monitor, or new immediate completion channel for an already-running historical job; new Host Completion Notices apply only to new Host-managed runs.

Compatibility does not retroactively reopen historical bindings already closed with `closeReason: cancel`. Only stops recorded under the new resumable-session schema preserve continuation authority. Reinterpreting an old explicit cancellation after upgrade would broaden past user intent and require a separately authorized migration.

A Host SessionEnd Boundary stops and settles the exact active turn but does not delete its ZCode session or binding. The result is a Resumable Companion Session: its history may support a later explicitly authorized turn, while no execution survives the boundary. Later routing retains the existing Rescue policy: explicit `--resume` and `--fresh` are authoritative; a semantically clear continuation or independent request may be routed directly; an ambiguous request asks once whether to resume an identified operation or start fresh. Persistence alone never resumes work, and no latest-session fallback may select authority.

Explicit Run Cancellation has the same turn-versus-session distinction: it interrupts and settles the exact current turn but preserves the exact binding and ZCode session for a separately authorized resume. This matches `codex-plugin-cc` retaining a cancelled task's Codex thread after `turn/interrupt`, but rejects its latest-thread fallback; only the exact preserved ZCode binding can authorize continuation.

An Engine Terminal Failure, including a ZCode provider usage limit, also preserves resumability when the ZCode session was accepted and the exact binding remains valid. A later explicit resume starts a new turn; it does not change the failed outcome of the prior job. Failure before session acceptance has no session to preserve and therefore requires a fresh operation. This retains the current eligibility of failed anchors and matches `codex-plugin-cc` treating failed task threads as resumable.

Status and Result expose a structured Resumability Indicator derived from the exact current binding and give a user-level Rescue hint when true. They do not reveal the internal ZCode session identifier, turn the indicator into authorization, or trigger continuation. This adapts `codex-plugin-cc`'s visible resume guidance to ZCode's stricter exact-binding model.

The public interface retains the existing boolean `--resume` and semantic operation selection; it does not add a public job- or session-ID resume selector. When more than one retained operation could match, the Host asks once for the logical operation together with resume versus fresh, then privately supplies the retained exact child path. Complete binding validation remains authoritative, so semantic selection never becomes a latest-job fallback.

Resume also retains the existing exact permission rule: the current Codex permission mode must equal the preserved binding snapshot. A permission-mode change requires a fresh operation and a new snapshot; this migration does not add binding authority migration or treat an account change by itself as a permission change.
