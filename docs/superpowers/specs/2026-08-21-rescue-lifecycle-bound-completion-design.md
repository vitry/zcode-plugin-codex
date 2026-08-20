# Rescue Lifecycle-Bound Completion Design

Status: approved for implementation on 2026-08-21

## Problem

Foreground Rescue currently imposes a plugin-local 60-minute completion
deadline. `ZCodeProtocolClient.waitForCompletion()` synthesizes
`ZCODE_COMPLETION_TIMEOUT` when that deadline expires. `executeJob()` then
treats the timeout as an uncertain execution failure, calls `session/stop`, and
marks the durable job failed. A ZCode turn that is still producing valid tool,
verification, or heartbeat progress is therefore terminated solely because
wall-clock time elapsed.

The timeout also conflicts with four plugin-local 30-minute lifetimes:

- caller contexts and active parent turns;
- Rescue executor provenance;
- pending interactive choices;
- private Rescue preparations.

The first incident ran for 60 minutes. When Root immediately attempted to
continue the exact stopped Rescue child in the same user turn, the parent
active-turn record had already expired. `role-status rescue` collapsed that
identity failure into the catch-all public status `unsupported`, incorrectly
suggesting `$zcode:setup` even though the managed Role was not the cause.

Removing only the completion deadline is insufficient. A long turn that later
needs automatic continuation would still lose parent authority after 30
minutes, and the current preparation store permits only one preparation for a
given parent turn even after that preparation has been consumed.

## Goals

- Let ordinary foreground Rescue wait for an authoritative ZCode terminal
  result without a plugin-defined wall-clock deadline.
- Preserve bounded request, transport, stop-review-gate, and qualification
  deadlines where their callers explicitly require them.
- Bind parent active-turn authority to the actual Codex hook lifecycle instead
  of a fixed 30-minute lifetime.
- Permit the exact stopped Rescue child to continue the exact bound operation
  automatically in the same long-lived parent turn.
- Keep replayable one-shot caller contexts, pending choices, preparations, and
  unbound executor provenance bounded.
- Distinguish caller-lifecycle and transient inspection failures from actual
  managed Role readiness failures without exposing private diagnostics.
- Preserve explicit `$zcode:cancel`, signal interruption, SessionEnd cleanup,
  durable exact-session binding, and fail-closed identity checks.
- Prove the protocol changes with deterministic tests and an authenticated real
  ZCode response qualification.
- Regenerate and verify the installed marketplace snapshot from source.

## Non-goals

- Do not use ZCode Rescue to implement or review this change. Development and
  review use Codex-native collaboration subagents only.
- Do not remove individual RPC request deadlines, stream drain deadlines,
  permission deadlines, stop-review-gate budgets, or explicit test budgets.
- Do not make pending choices, caller tokens, execution capabilities, or
  preparations valid indefinitely.
- Do not authorize an unbound or sibling executor after its ordinary lifetime.
- Do not let progress or heartbeat messages renew authorization.
- Do not introduce a new public Rescue flag, task deadline option, or child
  assignment field.
- Do not expose parent session IDs, turn IDs, child IDs, preparation generations,
  ZCode session IDs, paths, configuration errors, or raw exceptions.
- Do not redesign broker persistence or solve broker-process restart fencing in
  this change. Existing reconciliation remains required before reservation;
  broker restart during an accepted active turn remains a separately tracked
  durability concern.
- Do not change the separately bounded stop review gate into an unbounded task.

## Chosen Architecture

The implementation deepens three existing modules at their current interfaces:

1. `IdentityStore` owns lifecycle-bound active parent turns separately from
   replayable caller contexts.
2. `ZCodeProtocolClient` owns optional completion budgets; absence of an
   explicit budget means wait for a real terminal notification.
3. `RescuePreparationStore` owns sequential, executor-bound preparation
   generations for same-parent-turn continuation.

Root orchestration remains task-blind at the child seam. The child continues to
receive only the fixed `invoke-prepared rescue` assignment. No generation,
identity, route, or task value is added to child-visible data.

The long-running lifecycle is:

```text
UserPromptSubmit
  -> create lifecycle-bound active parent turn
  -> prepare generation 1
  -> exact Rescue child starts the bound ZCode turn
  -> wait for authoritative terminal with no ordinary Rescue deadline
  -> if the operation needs automatic continuation in the same parent turn:
       role-status using the same active parent record
       save resume-only preparation generation 2
       follow up the same stopped child
       consume generation 2 and resume the exact bound ZCode session
  -> Root Stop, a replacement parent prompt, or SessionEnd revokes authority
```

## Lifecycle-Bound Active Parent Turns

Caller contexts and active turns currently share `CALLER_LIFETIME_MS`, but they
serve different purposes. The implementation splits their representations and
lifetimes.

### Caller contexts

Caller contexts remain replayable token records with the existing 30-minute
expiry and all existing exact session, turn, workspace, permission, digest,
consumption, and revocation checks. This design does not broaden their
interface.

### Active-turn records

New active-turn records use an exact versioned lifecycle schema:

```json
{
  "version": 2,
  "kind": "active-turn",
  "key": "sha256 active-turn key",
  "sessionId": "parent Codex session",
  "turnId": "current parent turn",
  "workspace": "canonical workspace",
  "permissionMode": "workspace-write",
  "prompt": "bounded recorded prompt",
  "createdAt": "RFC3339 timestamp"
}
```

The record has no `expiresAt`. Its authority is the hook lifecycle:

- `UserPromptSubmit` atomically revokes older active turns for the exact parent
  session and writes the new record.
- Root `Stop` deletes the exact current turn after the review-gate decision
  actually ends the turn.
- `SessionEnd` deletes all identity state for the ending parent session.
- Starting a later prompt in the same session replaces any record left by a
  missed or interrupted Stop hook.

`resolveActiveTurn()` and `resolveOnlyActiveTurn()` accept the new exact schema
without consulting wall time. They continue to require the exact ambient
session, canonical workspace, bounded valid record, and unique active selection.

Legacy unversioned active-turn records keep their existing expiry semantics.
An expired legacy record is never promoted merely because new code reads it.
The next valid `UserPromptSubmit` overwrites it with the new schema. Corrupt,
unknown-version, wrong-session, wrong-workspace, and ambiguous records remain
fail closed.

This does not turn an environment variable into a new security boundary. It
preserves the existing same-UID trust model: ambient `CODEX_THREAD_ID` selects a
private hook-created record, while Stop, replacement prompt, and SessionEnd are
the revocation authorities.

## Completion and Cancellation Semantics

`requestTimeoutMs` and `completionTimeoutMs` become distinct optional concepts.

- `requestTimeoutMs` retains its current bounded default and continues to cover
  one protocol request.
- `completionTimeoutMs` has no implicit default. A caller must provide a finite
  positive value to request a bounded completion wait.
- `waitForCompletion(sessionId)` without an explicit client or call budget
  subscribes until it receives a validated `prompt_completed` or
  `prompt_failed`, the protocol disconnects, or the session is explicitly
  stopped.
- `waitForCompletion(sessionId, timeoutMs)` retains the finite-budget behavior
  required by stop-review-gate and controlled tests.

Ordinary Rescue client creation supplies no completion budget. Therefore wall
time alone cannot produce `ZCODE_COMPLETION_TIMEOUT` in `executeJob()` and cannot
enter its uncertain-failure stop branch.

The stop review gate continues to create a client with its explicit gate budget.
Real qualification may also supply an explicit test budget so an unavailable
external dependency cannot hang CI or local verification indefinitely.

Cancellation remains explicit and authoritative:

- `$zcode:cancel` elects and stops the exact durable job through the existing
  cancellation controller.
- `SIGINT` and `SIGTERM` become `JOB_INTERRUPTED` and use the existing stop and
  durable terminalization path.
- A protocol disconnect, malformed terminal, corrupt final snapshot, or other
  non-time execution failure may still stop an unproven active remote turn.
- Natural `prompt_completed` and `prompt_failed` notifications remain the only
  successful completion boundary.

Status waiting remains observational. Its timeout returns the latest running
state and never calls `session/stop`, reserves a replacement, or marks the job
failed.

## Same-Turn Preparation Generations

The current preparation record is keyed by parent session, turn, and workspace.
Once saved, it blocks every later save for that turn, even after consumption.
The implementation versions the record and adds a private monotonic generation
plus an optional exact required executor:

```json
{
  "version": 2,
  "generation": 2,
  "key": "sha256 preparation slot key",
  "sessionId": "parent session",
  "turnId": "same long-lived parent turn",
  "workspace": "canonical workspace",
  "permissionMode": "workspace-write",
  "source": "proactive",
  "envelope": {
    "version": 1,
    "source": "proactive",
    "task": "private task",
    "options": { "execution": "foreground", "resume": "resume" }
  },
  "createdAt": "RFC3339 timestamp",
  "expiresAt": "RFC3339 timestamp",
  "consumedAt": null,
  "executorAgentId": null,
  "requiredExecutorAgentId": "exact previously consuming child"
}
```

Each generation retains the existing 30-minute preparation lifetime. Save and
consume remain serialized by the preparation lock.

The first generation for a turn has `generation: 1` and no required executor.
An existing unconsumed generation always rejects replacement. A consumed record
may be atomically replaced only when all of these hold:

- the new envelope is `source: proactive` with `resume: resume`;
- the prior record was valid and consumed by one bounded executor ID;
- the active parent session, turn, canonical workspace, and permission are
  unchanged;
- the new generation is exactly the previous generation plus one;
- no concurrent writer replaced the slot.

The replacement carries the prior consuming executor into
`requiredExecutorAgentId`. Consumption requires that exact executor. The
consumer must also pass the existing stopped durable-provenance, fresh
preparation, exact binding, permission, workspace, generation/current-job, and
session validation in the Companion and StateStore. A sibling, fresh route,
permission change, active/unbound executor, concurrent save, malformed record,
or replay fails before job reservation.

The consumed record is replaced rather than accumulated. Generation is private
ABA protection for the slot, not public history. Root Stop and SessionEnd remove
the slot through the existing cleanup paths. Marketplace qualification captures
each consumed generation at the relevant seam before replacement when raw
evidence is required.

## Same-Parent-Turn Automatic Continuation

The Rescue Skill and managed Role contracts expand the existing stopped-child
route to cover the same still-active parent turn after a long foreground result.
Root may continue automatically only when the user's terminal condition and the
complete request semantics require continuing the same operation.

The route is:

1. The original foreground Companion reaches a real terminal result and exits.
2. Codex records the exact Rescue child as stopped.
3. Root retains the exact `rescueChildId` and operation selection.
4. Root runs read-only Role preflight using the still-active lifecycle record.
5. Root saves a proactive `resume` preparation as the next same-turn generation.
6. Root sends the unchanged fixed `invoke-prepared rescue` assignment to the
   exact same stopped child with `followup_task`.
7. The Companion consumes the executor-bound generation and resumes only the
   exact durable binding's anchor ZCode session.

No second child, generic fallback, latest-session selection, task-derived name,
or second execution for one generation is permitted. A true active child is
still rejoined rather than prepared again.

## Role Readiness Status Model

`role-status rescue` returns only a bounded public vocabulary. Managed Role
inspection results retain their existing exact statuses:

- `ready`;
- `restart-required`;
- `install-required`;
- `upgrade-required`;
- `drift`;
- `foreign-conflict`;
- `project-shadowed`;
- `higher-precedence-conflict`;
- `unsupported` only when the host capability itself is actually unsupported.

The Companion adds two non-setup failure classes:

- `caller-unavailable`: the ambient parent, active lifecycle record, or recorded
  SessionStart cannot be proven. Remedy: retry from an active owned parent turn.
- `inspection-unavailable`: Codex configuration/App Server inspection failed
  transiently or returned an unusable result. Remedy: retry Role preflight.

Source checkout provenance keeps `source-session-unproven` and its existing
instance-bound remedy.

Only managed Role installation, upgrade, drift, conflict, or genuine capability
states recommend `$zcode:setup`. Public status never includes the caught error,
path, config layer, session identity, or stack. Private debug/test seams may
assert the original typed code without rendering it.

The Rescue Skill accepts only the fixed status object and stops before prepare
for every non-ready status. It presents the status-specific fixed remedy instead
of treating all failures as setup mutations.

## Compatibility and Upgrade

- Existing caller-context, execution-capability, binding, job, and pending-choice
  records are unchanged.
- Legacy active-turn records remain readable only under their old expiry rules.
- Legacy version-1 preparation records remain consumable once under their
  existing rules. They cannot create a second same-turn generation; a new
  preparation after a replacement prompt writes version 2.
- A current consumed version-1 preparation may be upgraded to generation 2 only
  through the exact proactive bound-resume path and only when its consuming
  executor, parent identity, workspace, and permission are valid.
- Managed Role bytes and receipt digest change because forwarder instructions
  gain same-parent-turn continuation and refined Role-status remedies. Existing
  owned installations report `upgrade-required`; setup performs the normal
  managed upgrade. Drift and foreign ownership remain fail closed.
- Public commands and flags do not change.
- Source files remain authoritative. Generated marketplace files are rebuilt,
  never edited independently.

## Error Handling and Safety Invariants

- No implicit elapsed-time event may stop an ordinary Rescue job.
- Every explicit stop must target the exact owned ZCode session and publish one
  coherent durable terminal result or retain the running guard when stop is not
  acknowledged.
- An active-turn record is valid only while its exact hook lifecycle remains
  active; replacement prompt, Root Stop, and SessionEnd revoke it.
- Missing Stop cleanup cannot authorize a different prompt because the next
  `UserPromptSubmit` atomically replaces the prior session record.
- Same-turn preparation replacement requires a consumed prior generation and
  exact bound resume. Unconsumed overwrite is always forbidden.
- The next preparation generation is consumable only by the exact previous
  executor and still requires stopped durable binding proof.
- Progress is observational and cannot extend authority, choose a route, or
  prove completion.
- `unsupported` cannot be used as a generic wrapper for caller or inspection
  failures.
- No new private identifier appears in argv, environment, stdout, stderr,
  progress relay, job status, task name, child assignment, or public error.

## Test Strategy

All production changes follow test-driven development. Tests use injected time
and dependencies; no deterministic test waits 30 or 60 real minutes.

### Identity and hooks

- New active turns resolve after simulated 30 minutes, 60 minutes, and 24 hours.
- Exact Root Stop revokes the turn.
- A later prompt atomically replaces the prior turn and permission snapshot.
- SessionEnd clears all session identity.
- Legacy unexpired records resolve; legacy expired records fail; corrupt and
  unknown-version records fail closed.
- Concurrent prompts, wrong session/workspace, and ambiguous records cannot
  select authority.

### Preparation generations

- A second save over an unconsumed generation fails.
- A consumed generation permits only the next proactive bound-resume generation.
- The same executor consumes the next generation; a sibling cannot.
- Fresh, explicit, permission-changed, malformed, expired, replayed, and
  concurrent replacement attempts fail before reservation.
- Multiple sequential same-turn resume generations work and remain bounded.
- Root Stop and SessionEnd clean the slot.

### Completion and cancellation

- A default completion wait creates no deadline and succeeds when a terminal is
  delivered after simulated time greater than 60 minutes.
- Explicit finite completion budgets still produce the exact timeout and clean
  protocol waiters.
- Ordinary `executeJob()` cannot stop or fail solely because injected wall time
  advances.
- `$zcode:cancel`, SIGINT, and SIGTERM each stop the exact session once and
  publish the correct durable state.
- Stop failure retains the running/cancelling guard and bounded diagnostic.
- Status wait expiry leaves the job running.

### Role status

- Managed installation/upgrade/drift/conflict states keep setup remedies.
- Missing or ended caller lifecycle returns `caller-unavailable`.
- Transient config/App Server errors return `inspection-unavailable`.
- Genuine unsupported host capability alone returns `unsupported`.
- Source provenance retains `source-session-unproven`.
- No private caught error appears in output.

### Full lifecycle and qualification

- One parent turn prepares generation 1, starts one child and one ZCode session,
  receives a real terminal, prepares generation 2 without another
  `UserPromptSubmit`, follows up the same stopped child with zero new spawns, and
  resumes the exact original ZCode session.
- Injected time crosses both old 30-minute and 60-minute thresholds.
- Named and qualified generic routes preserve one execution per child turn and
  identical public output.
- Installed marketplace qualification validates source/snapshot parity and the
  managed Role upgrade.

Authenticated macOS qualification runs `tests/e2e/real-zcode.test.mjs` with an
explicit test budget. It must prove discovery, authentication, a non-empty
read-only response, natural completion, duplicate-send fencing during an active
turn, explicit stop and permission abort, model selection, history import, and
two sequential completed turns in one real ZCode session. This is controlled
verification only; ZCode does not implement or review the change.

Normal PR CI may retain the existing structured real-ZCode skip when credentials
are unavailable. Local release evidence must include an authenticated real run,
and all GitHub required checks must succeed before delivery.

## Subagent Development and Review

Implementation uses Codex-native collaboration subagents with explicit file
ownership. No worker may invoke ZCode Rescue or revert concurrent/user changes.

1. Identity and hook lifecycle worker owns `identity.mjs`, hook integration, and
   focused identity/hook tests.
2. Preparation-generation worker owns `rescue-preparation.mjs`, its tests, and
   the narrow Companion integration needed to consume generations.
3. Completion/status worker owns protocol completion defaults, execution tests,
   Role-status classification, and focused Companion tests.
4. Contract/qualification worker owns Skill/Role text, documentation, managed
   Role upgrade tests, real/fake qualification, and marketplace regeneration.

Tasks execute in dependency order where files or semantics overlap. Each task
is reviewed first for spec compliance and then for code quality by independent
Codex subagents. Critical and important findings are fixed and re-reviewed
before the next dependent task.

## Verification and Delivery

Before PR creation, run focused suites after each task and then:

```bash
npm run check:line-endings
npm run lint
npm run typecheck
npm test
npm run test:qualified
git diff --check
```

Run the authenticated real-ZCode E2E separately with the configured real model
and record its exact pass/fail result. Review the complete branch diff against
this spec and the implementation plan. Push the feature branch, create the pull
request, and monitor GitHub Actions until every required check succeeds. CI
failures are diagnosed and repaired on the same branch; no force-push is needed.
