---
status: accepted
supersedes: stopped-rescue-choice-continuation-in-adr-0010
---

# Bind a stopped Rescue child to its exact ZCode session

## Decision

Root may send the constant `invoke-prepared rescue` assignment to the same stopped child after privately preparing a new turn. The durable binding keeps the original `anchorJobId` and advances `currentJobId` when the continuation job is durably reserved and published, even if that job later queues, fails, or is cancelled. Those identifiers, the task, permissions, workspace identity, and executor provenance remain private plugin state and never enter a child assignment.

An active exact child is rejoined without preparation or invocation. A stopped exact same-operation child is re-authorized by the new prepared turn and followed up without another spawn or `SubagentStart`. A fresh or independent operation prepares `fresh` and creates a new child. Root alone decides these semantics; the child only executes its fixed assignment once per child turn.

## Compatibility and lifecycle

Legacy jobs-only state may be adopted only when it supplies one exact eligible candidate and no conflicting pending state. A permission change prevents resume and requires an explicit fresh operation to capture the current permission snapshot. `SessionEnd` closes the ending Codex session's whole binding partition. Missing, invalid, closed, corrupt, ambiguous, wrong-workspace, wrong-executor, or provenance-mismatched state must fail closed without selecting a latest session or another child.

For linked worktrees, the prompt-proved origin workspace and the Rescue execution workspace are distinct. The first trusted prepare automatically binds one immutable execution target for the turn, without manual handoff, and only an exact canonical linked worktree sharing the same canonical Git common-dir is eligible. A child cannot claim the target. The stopped child's generation-bound route and all durable binding state remain in that execution workspace; Root Stop, a new prompt, and SessionEnd revoke or replace the origin authority before cleaning the target.

This replaces ADR 0010 only where that decision treated a stopped child as reusable solely for the immediate `needs-choice` exchange. Choice continuation remains same-child; this decision also permits a later prepared turn for the exact durably bound operation.
