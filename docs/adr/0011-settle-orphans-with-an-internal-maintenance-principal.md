---
status: accepted
---

# Settle orphaned jobs with an internal maintenance principal

When a writable Rescue's exact worker lease is free, internal lifecycle maintenance may derive the original broker owner ID only from that schema-validated durable job and use it to inspect, stop, and settle the job. This does not transfer ownership: public status, result, cancel, and resume selection remain bound to the original Codex session, and the maintenance path returns no old-job content to the session that triggered it.

## Considered Options

Same-owner-only recovery was rejected because workspace-global writable exclusion lets a dead owner permanently block every later session. SessionEnd-only settlement was rejected because crashes and force exits can skip the hook. Cross-session job adoption and force release were rejected because they would expose another session's work or permit two agents to mutate one workspace while the old remote session may still be active.

## Consequences

SessionEnd uses only an already healthy broker to read, stop, reread, and settle its exact active writable job before generic owner release; generic released mappings are not treated as stop acknowledgements. Writable reservation performs the crash fallback. Both paths use the existing per-job cancellation lock; claimed-job orphan detection additionally requires the exact worker lease to be free, while an unclaimed reservation retains the existing bounded worker-claim grace period. A remote stop that cannot be acknowledged retains the writable guard and an actionable bounded error rather than claiming a false terminal state.

The Host SessionEnd Boundary first persists a SessionEnd Receipt and then exact Durable Stop Intents within the remaining hook budget. If bounded settlement cannot prove cancellation or another terminal winner, resume-time SessionStart performs only bounded local recognition; when the previous Host Lifecycle Epoch lacks a receipt, it writes a compensation receipt before publishing the resumed epoch, but never opens broker or ZCode control. Reconciliation is retried by the first subsequent UserPromptSubmit, same-owner status/result/cancel, and the next writable reservation. Status exposes `cancelling` plus a bounded `lastCancelError`; status wait repeatedly reconciles until a terminal result or that wait's timeout. Confirmed cancellation becomes `cancelled`, natural success remains authoritative, and a provably vanished unrecoverable executor may become `failed`. No elapsed-time policy releases the Writable Guard while an old writer may still be active.

All confirmed stop paths share the existing `cancelled` terminal status and persist a structured Stop Cause such as `user`, `session-end`, or `host-coordination-loss`. The cause is diagnostic and does not create a second lifecycle dimension: unresolved stop intent remains `cancelling`, while natural success or proven failure still wins as above.
