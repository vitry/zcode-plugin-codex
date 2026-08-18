---
status: accepted
supersedes: stopped-rescue-choice-continuation-in-adr-0010
---

# Bind a stopped Rescue child to its exact ZCode session

## Decision

Root may send the constant `invoke-prepared rescue` assignment to the same stopped child after privately preparing a new turn. The durable binding keeps the original `anchorJobId` and advances `currentJobId` only after a successful continuation. Those identifiers, the task, permissions, workspace identity, and executor provenance remain private plugin state and never enter a child assignment.

An active exact child is rejoined without preparation or invocation. A stopped exact same-operation child is re-authorized by the new prepared turn and followed up without another spawn or `SubagentStart`. A fresh or independent operation prepares `fresh` and creates a new child. Root alone decides these semantics; the child only executes its fixed assignment once per child turn.

## Compatibility and lifecycle

Legacy jobs-only state may be adopted only when it supplies one exact eligible candidate and no conflicting pending state. A permission change prevents resume and requires an explicit fresh operation to capture the current permission snapshot. `SessionEnd` closes the ending Codex session's whole binding partition. Missing, invalid, closed, corrupt, ambiguous, wrong-workspace, wrong-executor, or provenance-mismatched state must fail closed without selecting a latest session or another child.

This replaces ADR 0010 only where that decision treated a stopped child as reusable solely for the immediate `needs-choice` exchange. Choice continuation remains same-child; this decision also permits a later prepared turn for the exact durably bound operation.
