# Rescue Continuation Rollback and Historical Repair Design

## Status and scope

This design fixes one exact lifecycle defect in writable Rescue continuation:
an active v3 binding advances to a newly reserved continuation job before any
external RPC, but a failure while that job is still queued can terminalize the
job without restoring the prior binding. The resulting active binding names a
failed current job with no `zcodeSessionId`; every later exact reactivation
then fails closed with `RESCUE_BINDING_INVALID`.

The change has two deliberately separate surfaces:

1. normal runtime rollback for future active-continuation failures; and
2. an explicit, repository-only maintenance tool for already-persisted poison
   created by older plugin versions.

There is no new public Skill, companion command, automatic startup migration,
target selector, session substitution, prompt resend, or fresh fallback. The
maintenance tool is excluded from the npm/plugin payload and never runs from
prepare, invoke, setup, hooks, broker, recovery, or SessionEnd.

## Incident and invariant violation

The retained Neon Strike operation is bound to canonical child path
`/root/zcode_rescue_task_3`. Its active v3 binding has:

- a succeeded anchor job with the original non-empty ZCode session ID; and
- a failed current continuation job created before the cold-runtime correction,
  with no `startedAt`, `zcodeSessionId`, accepted input, or send boundary.

The continuation reservation correctly linearized before external work: it
persisted a new queued job containing `rescueContinuationOrigin.priorBinding`,
then advanced `binding.currentJobId` to that job under the workspace StateStore
lock. The remote resume failed before the job entered `running`. Generic queued
failure settlement deleted `rescueContinuationOrigin`, retained the advanced
binding, and therefore destroyed both resumability and the exact rollback proof.

The required invariant is:

> An active bound continuation that fails while still queued and before any
> durable ZCode session/send boundary must leave its failed job as history and
> atomically restore its exact prior active binding.

Once the job enters `running`, the current binding remains on that job. Running
or post-send failures are not rolled back because remote acceptance may already
have occurred and durable reconciliation owns that ambiguity.

## Considered approaches

### Defer `currentJobId` until success

Rejected. The early binding advance is the operation's durable execution claim.
Deferring it would let concurrent prepares reserve and send multiple prompts to
one ZCode session, and would leave cancellation, SessionEnd, and crash recovery
unable to identify the active attempt.

### Add a pending job field to the binding schema

Rejected for this correction. A `pendingJobId` two-phase schema could work, but
every reader and lifecycle transition would need to understand it. It adds a
new durable schema and migration surface without eliminating the need for an
early persisted claim or failed-claim cleanup.

### Restore the prior binding on exact pre-running failure

Selected. The queued continuation already persists a defensive copy of the
prior binding, so future rollback can reuse the existing exact authority and
StateStore lock/CAS discipline. Historical records that already lost that proof
use a separate explicit repair with stricter operator-supplied expectations.

## Future runtime rollback

### StateStore boundary

StateStore gains one narrow operation for failing an active continuation before
the running boundary. Its input includes canonical workspace, exact queued job
ID, and the durable `rescueContinuationOrigin` proof already present on that
job. The operation runs under the existing workspace StateStore file lock.

Under the lock it re-reads and validates all of the following:

- the job is the exact canonical writable Rescue job and remains `queued`;
- the job is owned by the prior binding's parent session and permission mode;
- `rescueContinuationOrigin.kind` is `active-continuation` and its
  `priorBinding` is a valid active binding;
- the current partition record is exactly the expected prior binding advanced
  only to this job with its current `updatedAt`;
- the binding still names this job as current and retains the same operation,
  anchor, child authority, workspace, permission, and generation lineage;
- no contradictory migration rollback or revoked binding has won; and
- the terminal transition is `failed`, with a bounded public error and no
  caller-supplied identity or session mutation.

The atomic lifecycle result is:

- the queued job becomes `failed` and retains ordinary terminal metadata;
- its private execution claim, commitment, and continuation-origin fields are
  removed according to terminal job schema;
- the exact prior active binding is restored byte-for-byte except for an
  `updatedAt` value advanced monotonically beyond both records; and
- the failed job remains in owner indexes and job history.

The binding restoration and job terminalization use an ordered, crash-recoverable
publication protocol under the same stable lock. A crash at any injected seam
must be classifiable and retryable without authorizing execution, losing the
prior proof, or permitting two current bindings. The operation is idempotent:
an apply-then-throw retry returns or recognizes the same durable terminal job
and restored binding; any different winner fails closed.

### Execution integration

`executeReserved` installs a pre-running failure settlement for every reserved
active continuation, not only for legacy session-ended migration. The callback
may run when `session/resume` itself fails or after resume returns but model
materialization, verification, thought-level selection, subscription setup, or
another pre-running step fails. In all cases the job is still queued and no
prompt has been sent.

Errors before `executeJob` is entered, such as launcher discovery or managed
client creation, use the same settlement in the outer `executeReserved` catch.
Legacy migration continues to use its tombstone-specific rollback. Interruption
and explicit cancellation semantics remain unchanged unless the exact active
continuation rollback operation is explicitly selected by the existing error
path; no broad terminal transition silently reopens cancelled operations.

The original execution error remains authoritative. If rollback validation or
publication fails, the rollback error replaces the original only where the
plugin cannot prove a safe durable outcome, matching existing fail-closed state
handling.

## Historical repair tool

Older terminal jobs may already have lost `rescueContinuationOrigin`, so they
cannot use the future rollback API. A repository-only Node maintenance tool
invokes a separate StateStore historical repair operation. It is not included
by the package `files` list or marketplace snapshot.

The tool requires explicit values for:

- data root and canonical workspace;
- parent session ID and child agent ID;
- canonical child agent path;
- expected binding key and operation ID;
- expected anchor and current job IDs; and
- expected binding `updatedAt` generation.

It supports a default dry run and an explicit `--apply`. Both modes acquire the
StateStore lock and perform the same bounded validation. Dry run returns a safe
repairable/not-repairable result without writing. Apply re-reads every expected
value under the lock before publication.

Historical repair is permitted only when:

- the exact record is an active v3 Hook binding for the supplied child path;
- every supplied binding identity and generation value matches exactly;
- anchor and current are different exact jobs in the same owner/workspace;
- the anchor is a resumable terminal Rescue job with one safe non-empty
  `zcodeSessionId`;
- current is `failed`, has never entered `running`, and has no `startedAt`,
  `zcodeSessionId`, input ID, start revision, accepted-message boundary, result
  artifact, or other evidence of prompt acceptance;
- no queued, running, or cancelling writable command exists in the canonical
  workspace, because the StateStore enforces workspace-wide writable exclusivity
  across Rescue, review, adversarial review, and transfer; and
- owner index, binding authority, partition, job records, and stable lock
  identity are all valid.

Apply restores `currentJobId` to the supplied anchor and advances `updatedAt`
monotonically. It does not modify, delete, rewrite, or hide the failed current
job. It never reads prompt artifacts, starts a broker, contacts ZCode, resumes a
session, sends a prompt, or changes Codex child state. Re-running the same apply
after success reports an already-repaired result only when the binding now names
the exact expected anchor and all other immutable identity still matches.

Any structural mismatch, concurrent winner, active writable attempt, missing
session, accepted-boundary evidence, or unsafe filesystem state performs zero
repair writes and returns a fixed maintenance error. Raw task text, credentials,
prompt artifacts, and arbitrary persisted error contents never enter output.

## Data repair sequencing

The maintenance repair for the retained Neon Strike binding is an operational
step after the implementation PR's required CI checks succeed. Before apply,
the tool runs dry and its exact expected generation is captured from the still
current binding. Apply then runs once. Verification re-reads StateStore and
asserts that:

- the binding is still active v3 for `/root/zcode_rescue_task_3`;
- `currentJobId` equals the exact anchor job;
- anchor/current resolve to the original ZCode session ID; and
- the historical failed job remains terminal and byte-identical.

Verification does not invoke prepare, follow the child, or contact ZCode. A
later user-initiated Rescue resume will create a normal new continuation job.

## Tests

TDD coverage must include:

- StateStore RED/GREEN coverage for exact queued active-continuation failure,
  monotonic prior-binding restoration, retained failed job, retry idempotence,
  and injected crashes at each job/binding publication seam;
- rejection of stale operation, current job, generation, child path, permission,
  owner, workspace, revoked binding, running job, accepted boundary, migration
  proof, and concurrent-winner mutations with zero reopening;
- foreground and background integration where `session/resume` fails before
  running, then a later prepare/invoke resumes the same child and original
  ZCode session without `session/create`;
- cold-runtime update rejection after a successful resume, followed by a
  corrected retry that resumes the same session and sends once;
- outer pre-execution discovery/client failure using the same active rollback;
- historical repair dry-run/apply/idempotent verification against an isolated
  incident-shaped fixture;
- historical repair rejection for every missing or contradictory safety proof,
  including any active writable job or accepted-boundary evidence;
- proof that the maintenance tool is absent from npm and marketplace artifacts;
- source/marketplace runtime byte parity, packed install, line endings, lint,
  typecheck, full tests, qualified tests, and required CI platforms.

## Documentation and compatibility

ADR 0013 receives a narrow amendment: durable publication still advances
`currentJobId` at reservation time, while an exact active continuation that
fails before entering `running` restores its prior binding. The changelog
records both the future rollback and the repository-only historical repair.
Public README command syntax and Skill instructions remain unchanged.

The marketplace snapshot includes the generic StateStore and companion runtime
fix but excludes the repository-only maintenance tool. Existing valid bindings,
legacy migration behavior, active/running attempts, cancellation semantics,
fresh child allocation, owner isolation, one-writer exclusion, and exact
session/path authorization remain unchanged.
