---
status: accepted
---

# Keep read-only background runs detached and session-bound

This migration changes normal Rescue execution to Host-managed ownership but retains the existing detached worker for background Review and Adversarial Review. Those read-only paths are outside the writable Rescue incident and deep-module vertical slice, and their job tracking, worker startup, progress, status, result, and test investment remain useful.

Detached does not mean independently durable. Review and Adversarial Review background runs remain Session-bound Background Runs: the Host SessionEnd Boundary records stop intent, performs a bounded exact remote stop attempt where a ZCode turn exists, then terminates only the exact recorded local worker process tree and retains the durable terminal or unresolved record for status/result/reconciliation. Local process termination is not remote terminal proof. This matches `codex-plugin-cc`'s product rule that ending-session Review workers are stopped, while improving on its process-kill-and-delete implementation by preserving evidence and not claiming an unproved remote cancellation.

The Rescue Lifecycle Reconciler remains Rescue-specific. Shared low-level cancellation, protocol, StateStore, and rendering primitives may be reused by read-only settlement, but this decision does not generalize the writable Rescue lifecycle interface or create a second Host-managed Review child architecture. A later migration of read-only commands requires a separate value and compatibility assessment.
