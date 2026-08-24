# Rescue Persistent Child Rejoin Hardening Plan (sol/medium revision)

This is a corrective implementation plan after the initial implementation and
independent sol/medium audit. The revised spec is the source of truth:
docs/superpowers/specs/2026-08-24-rescue-persistent-child-rejoin-design.md.
Do not reintroduce eager standalone migration.

## Acceptance gates

The change is complete only when:

1. Every binding, residency, job, revocation, migration, sibling, and
   no-mutation requirement in the revised spec has a named test.
2. Source and marketplace/plugins/zcode runtime/docs copies pass the
   repository's byte-identity/snapshot contracts.
3. Independent sol/medium specification review and quality/security review
   both report no unresolved high/medium findings.
4. npm run check:line-endings, npm run lint, npm run typecheck, all focused
   suites, and npm test pass. Qualified/native tests must either pass with
   captured exact evidence or be explicitly blocked by an external
   prerequisite; skipped output is not acceptance evidence.
5. Final diff, PR checks, and CI matrix are reviewed before claiming completion.

## Task 1 — Freeze the state model and version contract

Owners: scripts/lib/rescue-binding.mjs, scripts/lib/state.mjs,
tests/rescue-binding.test.mjs, tests/state.test.mjs.

- Define orthogonal binding, residency, and job semantics in code comments and
  validation. Keep v1/v2 readable under their historical schemas; write v3
  only for new/replaced records.
- Persist exact modern subagent-start agent_path; preserve legacy adoption path
  digest/provenance. Reject unknown versions, mixed malformed records, duplicate
  supersession operations, and capacity overflow without mutation.
- Record bounded same-child fresh supersession history. Fresh child B must not
  modify child A; stale same-child writers must fail CAS.
- Add tests for schema compatibility, path mismatch, supersession, sibling
  byte equality, and all malformed/oversized/duplicate cases.

## Task 2 — Make close/cancel operations exact and child-scoped

Owners: scripts/lib/state.mjs, scripts/zcode-companion.mjs,
scripts/lib/job-control.mjs, relevant hooks/tests.

- Replace any session-wide binding close API with exact
  (workspace,parentSessionId,childAgentId,operationId,reason) CAS closure.
- Durable cancellation of the exact current bound job closes only that
  operation with cancel. Linearize cancellation and binding closure so a
  continuation cannot publish between them. A failed/unacknowledged remote
  stop remains running/guarded and does not become cancel.
- Preserve explicit invalidation and same-child fresh replacement as permanent
  revocations; repeated/different closure reasons fail closed.
- Test cancellation races, historical anchor cancellation, orphan settlement,
  sibling isolation, same-child replacement, cross-process locking, and zero
  mutation on rejection.

## Task 3 — Implement exact resident/notLoaded rejoin

Owners: scripts/lib/rescue-route-planner.mjs, scripts/zcode-companion.mjs,
hook discovery/state readers, route/planner and companion tests.

- Use exact-parent persisted child graph evidence: same thread ID and
  thread_spawn parent, approved Role/type, exact agent_path, canonical
  origin/execution workspaces, and unambiguous identity.
- Permit resident exact children and notLoaded children. Rejoin follows the
  same child thread and never spawns or emits a new SubagentStart.
- Keep legacy host-only adoption as a separate compatibility route. Do not
  downgrade modern bindings to legacy.
- Preserve precise existing error families for active contradictions,
  mismatches, stale CAS, missing binding, and ambiguity.
- Test resident, unloaded, missing, contradictory, duplicate, pagination,
  unsupported parent-filter, path/Role drift, and zero-side-effect failures.

## Task 4 — Make migration lazy, atomic, and remote-safe

Owners: scripts/lib/state.mjs, reservation/review flow, companion and
state/integration tests.

- Migration proof lookup is read-only. It returns a closed session-ended
  tombstone plus complete operation/anchor/current/path proof; it never
  activates the binding.
- Only continuation reservation consumes that proof. Under one state lock,
  re-read and compare every exact field and supersession record, validate local
  anchor/current structure and non-empty anchor zcodeSessionId, then
  atomically publish the queued continuation and active successor binding.
- Ensure two consumers of one proof produce one winner and one stale loser.
  Do not allow proof A to resolve a newer same-child operation B.
- Before sending work, call remote session/resume for exactly the anchor ZCode
  session. On rejection, mismatch, broker failure, or timeout, fail the new
  attempt and preserve/rollback the closed tombstone with exact CAS; never
  fall back to session/create, another session, or another child.
- Test legacy and modern migration, missing/wrong remote sessions, rollback,
  competing reservations, operation/anchor/current mismatch, and no mutation.

## Task 5 — Preserve SessionEnd semantics and documentation

Owners: SessionEnd hook, source and marketplace docs/copies, changelog,
snapshot/provenance tests.

- SessionEnd settles jobs, cleans runtime/preparation/broker ownership, and
  preserves durable jobs/bindings. It must not revoke siblings or valid
  completed operations.
- Update source and marketplace README/Chinese README, SECURITY, ADR, and
  CHANGELOG. Explain the three orthogonal state dimensions, exact mapping,
  same-child versus sibling fresh, cancel, and writable exclusion.
- Update marketplace mirrored runtime files and verify source/marketplace byte
  identity rather than hand-editing only source files.

## Task 6 — Native qualification and verification

Owners: qualification/e2e helpers and final verification.

- Add captured/native evidence for same Root session, same child thread ID,
  notLoaded lazy reload, one follow-up, zero spawn, exact session/resume, and
  no private-envelope leakage.
- Cover installed marketplace and package snapshot flows. Run
  npm run test:qualified when prerequisites exist; record exact external
  blockers otherwise.
- Run line endings, lint, typecheck, focused lifecycle/state/planner/companion
  suites, marketplace/snapshot tests, and full npm test.
- Perform sol/medium spec review, then sol/medium security/quality review,
  fix all findings, inspect final diff, open PR, and verify CI.
