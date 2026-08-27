---
status: accepted
supersedes: stopped-rescue-choice-continuation-in-adr-0010
---

# Bind a stopped Rescue child to its exact ZCode session

## Decision

Root may send the constant `invoke-prepared rescue` assignment to the same stopped child after privately preparing a new turn. The durable binding keeps the original `anchorJobId` and advances `currentJobId` when the continuation job is durably reserved and published, even if that job later queues, fails, or is cancelled. Those identifiers, the task, permissions, workspace identity, and executor provenance remain private plugin state and never enter a child assignment.

An active exact child is rejoined without preparation or invocation. A stopped exact same-operation child is re-authorized by the new prepared turn and followed up without another spawn or `SubagentStart`. A fresh or independent operation prepares `fresh` and creates a new child. Root alone decides these semantics; the child only executes its fixed assignment once per child turn.

## Compatibility and lifecycle

Legacy jobs-only state may be adopted only when it supplies one exact eligible candidate and no conflicting pending state. A permission change prevents resume and requires an explicit fresh operation to capture the current permission snapshot. `SessionEnd` means runtime ownership loss: it may settle writable jobs and clean runtime resources, but preserves exact durable bindings for a later Root resume. Missing, invalid, revoked, corrupt, ambiguous, wrong-workspace, wrong-executor, or provenance-mismatched state must fail closed without selecting a latest session or another child.

The lifecycle distinguishes resident, unloaded but resumable, completed but resumable, and revoked. Mapping is exact child-scoped by parent session, canonical workspace, child identity/path/Role, and binding operation. A fresh operation on a different child does not close the first child's binding; only an explicit same-child replacement may supersede that child. Contradictory or ambiguous mappings fail closed. `WRITABLE_JOB_EXISTS` remains a separate conservative writable-exclusion policy and does not promise parallel writable operations.

When Root has retained one exact child ID and canonical agent-path pair from the same successful spawn lifecycle, it may place that selector only in the private preparation envelope. Multiple otherwise valid sibling bindings are then not an authorization ambiguity by themselves: the plugin first requires the pair to match exactly one child of the exact parent, and that selected child must still pass the complete Role, path, workspace, permission, executor, durable binding, operation, generation, job, and original ZCode-session join. The selector grants no authority and cannot hide malformed or duplicate host metadata. A missing, cross-paired, changed, unbound, or ineligible selector fails closed without sibling substitution or fresh fallback. Without an exact selector, multiple usable bindings remain ambiguous.

For linked worktrees, the prompt-proved origin workspace and the Rescue execution workspace are distinct. The first trusted prepare automatically binds one immutable execution target for the turn, without manual handoff, and only an exact canonical linked worktree sharing the same canonical Git common-dir is eligible. A child cannot claim the target. The stopped child's generation-bound route and all durable binding state remain in that execution workspace; Root Stop and a new prompt revoke or replace the origin authority before cleaning the target, while SessionEnd only removes runtime ownership and preserves exact resumable bindings.

This replaces ADR 0010 only where that decision treated a stopped child as reusable solely for the immediate `needs-choice` exchange. Choice continuation remains same-child; this decision also permits a later prepared turn for the exact durably bound operation.

Amendment: [the 2026-08-25 exact-binding migration spec](../superpowers/specs/2026-08-25-rescue-exact-binding-migration-design.md) supersedes this ADR only where its routing or migration rules permit same-child fresh replacement, active-only rejoin, non-exact legacy adoption, or unconditional SessionEnd preservation. Fresh always spawns an independent child. Targetless new-turn routing and migration require one uniquely eligible complete binding before follow-up; multiple usable bindings remain ambiguous, and later child ambient identity is not a selector. [The 2026-08-27 exact-continuation amendment](../superpowers/specs/2026-08-27-rescue-exact-continuation-target-design.md) permits Root's private exact same-lifecycle selector to narrow that join without replacing any binding authority. A retained-child pending choice may reuse its already-fixed native target without affecting migration selection. `SessionEnd` preserves completed/no-active-attempt bindings and exact v1/v2 `closed/session-ended` candidates, while confirmed stop/cancellation may close only the exact active operation and never siblings.
