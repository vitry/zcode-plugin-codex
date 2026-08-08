---
status: accepted
---

# Settle orphaned jobs with an internal maintenance principal

When a writable Rescue's exact worker lease is free, internal lifecycle maintenance may derive the original broker owner ID only from that schema-validated durable job and use it to inspect, stop, and settle the job. This does not transfer ownership: public status, result, cancel, and resume selection remain bound to the original Codex session, and the maintenance path returns no old-job content to the session that triggered it.

## Considered Options

Same-owner-only recovery was rejected because workspace-global writable exclusion lets a dead owner permanently block every later session. SessionEnd-only settlement was rejected because crashes and force exits can skip the hook. Cross-session job adoption and force release were rejected because they would expose another session's work or permit two agents to mutate one workspace while the old remote session may still be active.

## Consequences

SessionEnd uses only an already healthy broker to read, stop, reread, and settle its exact active writable job before generic owner release; generic released mappings are not treated as stop acknowledgements. Writable reservation performs the crash fallback. Both paths use the existing per-job cancellation lock; claimed-job orphan detection additionally requires the exact worker lease to be free, while an unclaimed reservation retains the existing bounded worker-claim grace period. A remote stop that cannot be acknowledged retains the writable guard and an actionable bounded error rather than claiming a false terminal state.
