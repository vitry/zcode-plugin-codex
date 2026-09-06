---
status: accepted
---

# Concentrate Rescue lifecycle in a deep module

The host-managed migration introduces one Rescue Lifecycle Reconciler as the decision seam shared by preparation/routing, child lifecycle handling, SessionEnd, status/result/cancel reconciliation, and orphan maintenance. Its small interface joins validated Host observation, executor route, exact binding/current job, worker lease, and ZCode control evidence, then returns a bounded lifecycle outcome such as `spawn-child`, `followup-child`, `wait-current`, `return-result`, `settled-terminal`, `unresolved-stop`, or `fail-closed`.

The module must own exact identity and binding validation, remote terminal authority, durable stop ordering, cancellation-versus-success winner election, safe executor repair, Stop Cause publication, historical-record convergence, and bounded public errors. It is not a pure classifier: through injected internal state and ZCode control adapters it persists stop intent, performs bounded control, rereads authority, and publishes the durable winner in the required order. Callers no longer combine raw states, execute returned mutation plans, or independently choose lifecycle actions; they receive only the bounded outcome. Host and ZCode dependencies remain internal seams with production and test adapters and are not expanded into the public interface.

This is a staged Rescue vertical slice, not a repository-wide rewrite. Existing shallow logic directly involved in the migration is replaced as its callers move behind the reconciler interface; unrelated commands and modules remain unchanged. Tests move to the reconciler interface and cover the joined incident/race matrix rather than layering another suite over duplicated internal decisions. A pass-through facade that merely forwards the current scattered decisions does not satisfy this decision.
