---
status: accepted
supersedes: ADR-0004
---

# Select session-bound background execution by task complexity

When Rescue receives neither `--wait` nor `--background`, the Codex Host selects foreground execution for small, clearly bounded work and session-bound background execution for complex, open-ended, multi-step, or likely long-running work, matching `codex-plugin-cc`. This inferred placement does not require another user confirmation; the Host announces background placement, while explicit `--wait` and `--background` always override the inference. Both inferred and explicitly requested background placement may outlive the initiating interaction: Host Coordination Loss at the Rescue Child does not stop an already-background run while its owning session remains active. Background placement does not authorize survival beyond the Host SessionEnd Boundary; logout or any other host-reported SessionEnd stops the run. Durable reconciliation exists only to settle abnormal loss of coordination. This replaces deterministic default-foreground placement because keeping complex work attached harms interactivity, while treating a background choice as independently durable would broaden lifecycle authority beyond its owning session.

Execution placement remains command-specific, also matching `codex-plugin-cc`: Review and Adversarial Review ask the user to choose when no execution flag is present and recommend a placement from scope, while status, result, cancel, and setup remain foreground management operations. Rescue alone infers placement without another question.

Execution ownership is also command-specific as specified by [ADR 0020](0020-keep-read-only-background-runs-detached-and-session-bound.md): normal Rescue background is Host-managed, while background Review and Adversarial Review retain their existing detached worker but remain session-bound.

This design introduces no cross-session `--durable` mode. Durable state records outcomes and drives abnormal-path reconciliation; it does not authorize a Companion Run to survive its owning Host SessionEnd Boundary. A future independent-execution mode would require a separate design for ownership, account changes, permissions, notification delivery, and unattended workspace mutation.
