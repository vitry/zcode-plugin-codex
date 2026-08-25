# Rescue Persistent Child Rejoin Hardening Plan (sol/medium revision)

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to execute the remaining unchecked steps.
> Checkboxes record branch state and must be updated only with captured
> evidence.

**Goal:** Preserve native Codex resident/notLoaded/completed-but-resumable
child semantics while keeping every rejoin, migration, execution, and
revocation decision exact, private, crash-safe, and fail closed.

**Architecture:** A child-scoped durable binding maps one exact persisted Codex
child to one anchor ZCode session. Read-only discovery and lazy migration feed
one locked reservation state machine; private reservation, origin/rollback,
worker claim, and owner evidence authorize execution and recovery without
guessing. SessionEnd releases runtime ownership but does not revoke a valid
binding.

**Tech Stack:** Node.js ESM, file-backed JSON state with process locks and
atomic rename, Codex app-server child discovery, managed ZCode RPC, Node test
runner, ESLint, and TypeScript checking.

---

The revised design is the source of truth:
`docs/superpowers/specs/2026-08-24-rescue-persistent-child-rejoin-design.md`.
Do not reintroduce eager standalone migration, workspace/latest-job guessing,
or SessionEnd revocation.

## Progress after source HEAD `b125a6d`

- [x] Lifecycle implementation and prior named regression coverage are complete
  through `b125a6d`.
- [x] The post-`b125a6d` background sequencing fix publishes only an
  authenticated encrypted v2 task payload before claim, opens it only after the
  atomic claim, and retains exact v1 job-spec compatibility.
- [x] The post-`d4cdb14` format hardening rejects unknown/non-exact schemas,
  binds new capabilities to `sealed-v2`, replaces the public plaintext digest
  with a capability-keyed commitment independently pinned on the private queued
  job before exposure, and limits exact v1 plaintext reading to genuinely old
  untyped capability plus locked historical publication evidence.
- [x] Twelve iterative sol/medium spec/semantic review rounds historically
  reported no unresolved high/medium findings at `246acbf`.
- [x] The historical focused lifecycle verification passed at `246acbf`:
  `node --test --test-concurrency=1 tests/rescue-binding.test.mjs tests/integration/companion.test.mjs`
  (`289` passed, `0` failed).
- [ ] Regenerate marketplace artifacts from the final reviewed source commit;
  the checked-in marketplace runtime predates the post-`a5df681` hardening.
- [ ] Run the complete local verification and required qualification gates from
  a clean worktree.
- [ ] Complete independent final quality/security review of the whole branch.
- [ ] Push, open the PR, and keep all required CI checks green.

## Acceptance gates

The change is complete only when every item below is checked:

- [x] Named tests cover binding/residency/job separation, SessionEnd resumability,
  exact child mapping, sibling isolation, revocation, migration rollback,
  reservation/origin/claim privacy, and no-mutation failures.
- [x] Named tests cover claim/revoke linearization, exact PID/lease ownership,
  direct/claim consistency, ordinary-unadvanced recovery, v1/v2 compatibility,
  and classless owner-v1 plus v3 fail-closed behavior.
- [x] Named background tests prove revoke-first leaves no plaintext task/focus
  or prompt/RPC artifact, claim-first opens the exact task, and a claimed crash
  terminalizes without exposing the sealed payload.
- [x] Named background tests cover model plus resume secrecy, unknown versions,
  sealed-v2 to v1 replacement, non-exact v1 records, and a real detached worker
  killed after claim and before decryption followed by orphan recovery.
- [ ] Source and `marketplace/plugins/zcode` runtime/docs copies satisfy the
  repository byte-identity, provenance, package, and install snapshot contracts.
- [x] Independent sol/medium specification review reports no unresolved
  high/medium findings for source HEAD `246acbf`.
- [ ] Independent quality/security review reports no unresolved high/medium
  findings for the final source and generated marketplace diff.
- [ ] `npm run check:line-endings`, `npm run lint`, `npm run typecheck`, focused
  suites, and `npm test` pass at the final commit.
- [ ] Native/qualified tests pass with captured exact evidence. An unavailable
  external prerequisite is reported as blocked and is not counted as a pass;
  skipped or unauthenticated output is not acceptance evidence.
- [ ] The final diff, PR checks, and CI matrix are reviewed before completion is
  claimed.

## Task 1 — Freeze the state model and version contract

**Files:** `scripts/lib/rescue-binding.mjs`, `scripts/lib/state.mjs`,
`tests/rescue-binding.test.mjs`, `tests/state.test.mjs`.

- [x] Keep binding, Codex residency, and job state orthogonal. Preserve readable
  v1/v2 historical schemas and write v3 only for new or replaced bindings.
- [x] Persist exact modern child path authority and legacy adoption digest/
  provenance. Reject malformed, unknown, duplicate, oversized, ambiguous, or
  mismatched evidence without mutation.
- [x] Record bounded same-child fresh supersession. Preserve sibling bindings
  byte-for-byte and reject stale same-child writers under CAS.
- [x] Retain `session-ended` tombstones through age/capacity collection; collect
  only explicitly revoked history under the bounded policy.

## Task 2 — Make close, cancel, and SessionEnd exact

**Files:** `scripts/lib/state.mjs`, `scripts/lib/job-control.mjs`,
`scripts/lib/recovery.mjs`, `scripts/zcode-companion.mjs`,
`hooks/session-end-hook.mjs`, and their tests.

- [x] Replace session-wide closure with exact child/operation CAS closure.
- [x] Linearize durable cancellation with binding revocation. Preserve the first
  committed `cancel`, `invalidated`, or `session-ended` tombstone and retain a
  writable guard after an unacknowledged stop.
- [x] Make SessionEnd settle active ownership and preparation state without
  revoking valid completed/resumable bindings or siblings.
- [x] Cover cancellation/recovery races, orphan settlement, child-scoped close,
  same-child replacement, sibling fresh, and zero-mutation rejection.

## Task 3 — Implement exact resident/notLoaded child rejoin

**Files:** `scripts/lib/codex-app-server.mjs`,
`scripts/lib/rescue-route-planner.mjs`, `scripts/zcode-companion.mjs`, and
route/planner/companion tests.

- [x] Discover children only through the exact persisted parent graph and
  validate child thread ID, `thread_spawn` parent, Role/type, exact path,
  canonical origin/execution workspace, permission, and uniqueness.
- [x] Follow resident or notLoaded exact children on the original thread. Never
  spawn a replacement child or emit `SubagentStart` during rejoin.
- [x] Reconstruct route-less modern v3 authority only from the exact binding and
  child graph. Keep legacy adoption isolated as a compatibility route.
- [x] Fail closed for missing, contradictory, duplicate, paginated/incomplete,
  unsupported, transiently unavailable, or stale evidence.

## Task 4 — Make migration, reservation, and execution crash-safe

**Files:** `scripts/lib/state.mjs`, `scripts/lib/rescue-migration.mjs`,
`scripts/lib/job-control.mjs`, `scripts/lib/recovery.mjs`,
`scripts/lib/render.mjs`, `scripts/zcode-companion.mjs`, and state/integration
tests.

- [x] Keep migration lookup read-only. Consume a complete tombstone digest only
  during locked continuation reservation and permit at most one CAS winner.
- [x] Publish the private rollback marker on the queued successor before binding
  advance. Restore the exact v1/v2/v3 tombstone on every queued terminal path;
  clear rollback/origin/claim only in the locked running or terminal commit.
- [x] Resume exactly the anchor ZCode session and never fall back to create,
  latest session, another child, or another workspace. Roll back on rejection,
  mismatch, broker failure, launch failure, worker loss, cancel, or recovery.
- [x] Publish private bound/unbound reservation evidence in the canonical job and
  owner record. Validate job, owner, child binding, permission, origin/rollback,
  PID, lease, and revocation under one lock before publishing an execution claim
  or performing artifacts/session/model/thought side effects.
- [x] Publish new background task/focus/resume data only as a
  capability-authenticated encrypted v2 job-spec; authenticate before capability
  consumption, decrypt only after the execution claim, expose only a keyed
  commitment independently pinned to the private queued job, reject
  unknown/non-exact records and valid same-capability re-sealing, and retain
  exact v1 reading solely with an old untyped capability plus exact classless
  owner-v1/v1-v2 or markerless rollback evidence for in-flight compatibility
  and recovery; never issue a `legacy-v1` format label.
- [x] Read-validate historical capability and StateStore proof before reserving
  consumption; revalidate one exact inspection digest at claim, release on a
  rejection only after locked proof of an unclaimed or exact-own lease, and
  commit `consumedAt` only after the durable claim. Preserve the reservation on
  an exact foreign winner or unreadable state for winner commit or terminal
  recovery/retry. Use one exact six-field v1 parser for execution, controller
  cancellation, and recovery.
- [x] Publish a child/public-private execution recovery authority before worker
  exposure, CAS-bind it to the exact attempt lease before Identity reservation,
  retain it through terminal settlement, and let orphan recovery release by
  exact capability digest/reservation/owner/workspace/job/lease under terminal
  State proof without the bearer. Clear authority only after release; make both
  steps idempotent and fail closed on foreign, nonterminal, missing, corrupt, or
  mismatched proof.
- [x] Reject one-sided v1 resume/candidate identity before capability proof and
  make failed-claim terminal compensation an exact worker-lease CAS, so a
  same-capability retry loser cannot terminate the winning queued claim.
- [x] Linearize claim-first/revoke-first behavior. Require an exact explicit PID
  and lease for claimed queued-to-running; clear claims on running/terminal
  commit while preserving the first revocation.
- [x] Apply one classification matrix to production claim and direct transition:
  classless owner-v1 ordinary or exact v1/v2-bound jobs remain compatible;
  classless owner-v1 plus v3 continuation/adoption/fresh/ordinary state fails
  closed; allow only an exact markerless v1/v2-to-v3 migration successor.
- [x] Recognize ordinary-unadvanced adoption remnants only from one complete
  exact prior binding, permit safe terminalization with prior bytes unchanged,
  and forbid execution. Reject markerless migration before any durable write
  when job-spec evidence is absent, incomplete, contradictory, v3, or ambiguous.
- [x] Strip reservation class, origin, rollback, claim, permission, and
  capability evidence from child/public output.

## Task 5 — Align source documentation and release contracts

**Files:** `README.md`, `README.zh-CN.md`, `SECURITY.md`, `CHANGELOG.md`,
`docs/adr/0013-bind-rescue-child-to-zcode-session.md`, this design/plan, and
release-contract tests.

- [x] Document SessionEnd resumability, exact child mapping, same-child versus
  sibling fresh, permanent cancel/invalidation, migration rollback, writable
  exclusion, and fail-closed compatibility.
- [x] Update source release-contract tests for the lifecycle contract.
- [ ] After this final docs commit, run the whole-branch quality/security review;
  route any concrete finding back through a named regression test and re-review.

## Task 6 — Regenerate and verify the marketplace snapshot

**Files:** generated `marketplace/plugins/zcode/**` and
`marketplace/.agents/plugins/{marketplace,provenance}.json` only.

- [ ] From a clean reviewed source commit, build outside the repository:

```bash
git status --short
SOURCE_SHA="$(git rev-parse HEAD)"
SNAPSHOT_PARENT="$(mktemp -d)"
node scripts/build-marketplace-snapshot.mjs \
  --output "$SNAPSHOT_PARENT/marketplace-snapshot" \
  --source-ref "$SOURCE_SHA" \
  --source-sha "$SOURCE_SHA"
```

  Expected: the source tree is clean before generation and the generated
  provenance names the exact `SOURCE_SHA`.

- [ ] Synchronize only generated output and commit it separately:

```bash
rsync -a --delete "$SNAPSHOT_PARENT/marketplace-snapshot/plugins/zcode/" marketplace/plugins/zcode/
cmp -s "$SNAPSHOT_PARENT/marketplace-snapshot/.agents/plugins/marketplace.json" marketplace/.agents/plugins/marketplace.json || cp "$SNAPSHOT_PARENT/marketplace-snapshot/.agents/plugins/marketplace.json" marketplace/.agents/plugins/marketplace.json
cmp -s "$SNAPSHOT_PARENT/marketplace-snapshot/.agents/plugins/provenance.json" marketplace/.agents/plugins/provenance.json || cp "$SNAPSHOT_PARENT/marketplace-snapshot/.agents/plugins/provenance.json" marketplace/.agents/plugins/provenance.json
git add marketplace/plugins/zcode marketplace/.agents/plugins/marketplace.json marketplace/.agents/plugins/provenance.json
git commit -m 'build: refresh Rescue marketplace snapshot'
```

- [ ] Verify parity and installability:

```bash
node --test tests/marketplace-snapshot.test.mjs tests/plugin-contracts.test.mjs tests/release-contracts.test.mjs
node --test tests/integration/marketplace-snapshot-build.mjs
MARKETPLACE_SNAPSHOT="$SNAPSHOT_PARENT/marketplace-snapshot" \
MARKETPLACE_SOURCE_REF="$SOURCE_SHA" \
MARKETPLACE_SOURCE_SHA="$SOURCE_SHA" \
node --test tests/integration/marketplace-install.test.mjs
```

  Expected: all tests pass and generated runtime/docs are byte-identical to the
  reviewed source payload.

## Task 7 — Full verification, qualification, PR, and CI

- [ ] Run local static and full non-qualified gates from the final clean commit:

```bash
npm run check:line-endings
npm run lint
npm run typecheck
npm test
git diff --check
git status --short
```

  Expected: every command exits `0`; `git status --short` is empty.

- [ ] Run required native qualification with authenticated prerequisites:

```bash
ZCODE_CODEX_SKILLS_E2E=1 ZCODE_CODEX_RESCUE_E2E=1 ZCODE_REAL_E2E=1 ZCODE_REAL_E2E_MODEL='provider/model' npm run test:qualification-required
```

  Expected: same parent session and child thread, notLoaded reload, one
  follow-up, zero spawn, exact anchor `session/resume`, installed marketplace
  execution, and no private evidence leakage. If an external prerequisite is
  unavailable, record the exact blocker and leave this checkbox unchecked.

- [ ] Re-run independent sol/medium spec and quality/security reviews on the
  final source plus marketplace diff. Resolve every high/medium finding and
  repeat verification before proceeding.
- [ ] Push `fix/rescue-persistent-child-rejoin`, open a PR against `main`, and
  include the incident, lifecycle model, migration/claim compatibility matrix,
  test evidence, qualification evidence or explicit blocker, and review record.
- [ ] Monitor every required GitHub Actions job. Diagnose failures, add a named
  failing regression test for behavior defects, fix, regenerate marketplace if
  source payload changed, re-review, push, and repeat until all checks are green.
- [ ] Confirm the PR is mergeable and leave it unmerged unless separately
  authorized.

## Task 8 — Fence historical v1 execution before Identity reservation

**Files:** `scripts/lib/state.mjs`, `scripts/lib/identity.mjs`,
`scripts/lib/recovery.mjs`, `scripts/lib/render.mjs`,
`scripts/zcode-companion.mjs`, `tests/fixtures/legacy-fence-worker.mjs`,
`tests/integration/companion.test.mjs`, `tests/state.test.mjs`, and
`tests/identity.test.mjs`.

- [ ] Add a real two-worker RED fixture. Worker A pauses after the State fence
  and Identity reservation; worker B uses the same historical v1 bearer with a
  different lease. Assert B gets a foreign-lease conflict without terminalizing
  or releasing A, then release A and assert exactly one claim, consumption, and
  remote execution.

```js
await gate.wait('a-reserved');
await workerB.exit();
assert.equal((await store.readJob(workspace, jobId)).status, 'queued');
await gate.release('a');
assert.equal((await workerA.exit()).code, 0);
```

- [ ] Add a real crash RED fixture. Kill worker A after its State fence and
  Identity reservation without retaining the bearer in the recovery process;
  run the production orphan scavenger twice and assert terminal settlement,
  exact Identity reservation release, private-authority clearing, and
  idempotence.

```js
await gate.wait('a-reserved');
workerA.kill('SIGKILL');
await scavengeWritableJobs({ dataRoot, workspace });
await scavengeWritableJobs({ dataRoot, workspace });
assert.equal((await store.readJob(workspace, jobId)).rescueExecutionReservation, undefined);
```

- [ ] Add zero-mutation RED controls for malformed v1 pairing, corrupt or
  ambiguous historical proof, and State CAS rejection. Compare the exact job
  and capability bytes before and after each rejection and require no fence or
  Identity reservation.

- [ ] Extend the private execution-authority schema with an exact historical
  v1 variant carrying `specDigest`, and add one StateStore API that atomically
  revalidates the prior inspection/proof and either installs the exact lease
  fence, returns the same-lease fence idempotently, or rejects a foreign lease.

```js
await store.fenceJobWorkerExecution(workspace, jobId, worker, rollback,
  executionAuthorization, expectedInspection, executionReservation);
await identity.reserveExecutionCapability(token, expected, reservationId, worker.workerLeaseId);
```

- [ ] Make claim, failure reconciliation, terminal cleanup, Identity
  release-by-reservation, and orphan recovery consume the same sealed-v2 or
  historical-v1 authority union. Foreign, nonterminal, corrupt, mismatched, or
  unreadable evidence remains fail closed; release then State clearing remains
  crash-idempotent.

- [ ] Strip both authority variants from every public/render/job-spec path and
  add direct assertions that capability digest, reservation, worker lease, and
  legacy spec digest never appear.

- [ ] Run the focused real-worker tests first, then the complete
  identity/state/binding/controller/recovery/SessionEnd/hooks/companion/skills
  suites, followed by `npm run typecheck`, `npm run lint`,
  `npm run check:line-endings`, and `git diff --check`. Commit only source,
  tests, spec, and plan; marketplace remains for the later generation task.

## Completion evidence

- Final design and executable plan commits.
- Focused and full test commands with pass counts and exact commit SHA.
- Generated marketplace provenance and source/snapshot byte-identity evidence.
- Authenticated native same-child rejoin evidence, or an explicit unresolved
  external qualification blocker that prevents completion.
- Final spec and quality/security reviews with no unresolved high/medium
  findings.
- PR URL, mergeable state, and all required CI checks green.
