# Rescue Exact-Binding Migration Amendment

## Status and precedence

This amendment is the implementation source of truth only for the Rescue bug
and lifecycle edges described below. It supersedes PR #44's 2026-08-24
spec/plan and ADR 0013 only where their routing or migration rules conflict
with this amendment. Every other safety mechanism merged in PR #44 remains
effective, including private state,
canonical-workspace validation, owner isolation, lock/CAS publication,
worker leases, writable-job exclusion, bounded parsing, and fail-closed errors.

The two production incidents motivating this amendment are:

- `2026-08-24T140927+0800-zcode-rescue-binding-invalid.txt`: an exact
  same-operation resume failed before route publication with
  `RESCUE_BINDING_INVALID`.
- `2026-08-25T142541+0800-zcode-rescue-executor-identity-invalid.txt`: the
  prescribed fresh retry followed `/root/zcode_rescue_task` and then failed
  inside that persisted child with `EXECUTOR_IDENTITY_INVALID`.

The correction is narrow: existing persisted children are continued only by
their exact binding; fresh work is assigned only to a newly spawned child.

## Terms and invariants

An **exact child binding** is the unique durable record selected by:

`(parentSessionId, childAgentId, exact agent path, approved Role/type,
canonicalWorkspace)`

The binding also fixes its operation, anchor job, current job, generation,
permission snapshot, and original non-empty `zcodeSessionId`. The path is the
canonical persisted Codex `agent_path`; historical path authority may be the
existing exact digest where that is all the v1/v2 schema contains.

An **exact follow-up** targets that same persisted Codex child ID/path and
operation. It does not spawn, substitute, adopt an unbound child, or select
another binding.

Exact child authority comes from Root's native explicit `followup_task` target,
whose child-local ambient identity names that child when it runs, or one
uniquely eligible complete binding. This adds no selector or public API.

An **independent fresh child** is created by the active parent planner through
the ordinary collision-free spawn route. It has no prior Rescue binding and
starts one new ZCode session with `session/create`.

The following invariants are absolute:

- A Codex child maps to at most one usable Rescue binding in one canonical
  workspace, and that binding maps to one original ZCode session.
- A same-child continuation never calls `session/create`.
- Fresh never follows, resumes, reactivates, adopts, or replaces an existing
  stopped/resumable child.
- Path suffixes are identities, not preferences. In particular,
  `/root/zcode_rescue_task_2` must recover its own binding and session.
- Missing, corrupt, contradictory, or ambiguous required evidence fails closed;
  a valid revoked record is ineligible and cannot authorize.

## Routing contract

### Same Codex child follow-up

For an ordinary continuation or explicit `resume` of the bound child, the
planner:

1. Canonicalizes the execution workspace with the existing workspace rules.
2. Lists only persisted `thread_spawn` children of the exact parent session.
3. Joins child ID, full path, Role/type, parent graph, and canonical workspace
   to durable Rescue bindings.
4. Uses native follow-up ambient child authority when present; otherwise
   requires exactly one complete eligible binding.
5. Reads the binding's original ZCode session from its exact anchor job.
6. Emits one follow-up to the same child path and reserves a normal
   continuation against the binding's current generation.
7. Uses ordinary ZCode `session/resume` for that exact `zcodeSessionId`, then
   sends the new turn through the existing execution path.

No step may rank candidates by base path, `createdAt`, updated time, list
position, latest job, latest session, or workspace proximity. No failure may
fall back to another child, `session/create`, or fresh.

Without native exact-child authority, two or more complete usable bindings are
ambiguous and fail with `RESCUE_CHILD_AMBIGUOUS`, zero mutation, and zero RPC.
Duplicate child IDs/paths or disagreement between top-level and nested
parent/path/Role metadata fails the same way.

### Fresh

`fresh` is valid only for the first turn of a new independent Codex child. When
no binding exists for that newly spawned child, the child reserves a fresh job
and calls `session/create` once. Fresh is never an operation on an old child.

The parent planner treats all existing stopped, completed, resumable,
`notLoaded`, or bound children as occupied. It allocates a collision-free new
path and emits `spawn`; it never emits `followup` for fresh.

A pending choice resolved as `fresh` is consumed or invalidated by the existing
pending mechanism, then control returns to the parent planner to spawn a new
child. The old child performs no action. There is no same-child replacement,
fresh supersession, permission replacement through fresh, or fresh adoption.

## Exact lazy migration

Migration exists only for a legacy v1/v2 binding whose state is
`closed/session-ended`. It is lazy: no startup scan, eager rewrite, or
jobs-only adoption occurs.

Read-only discovery may identify a candidate, but activation occurs only while
holding the existing canonical workspace state lock. Under that lock, the
implementation re-reads and exactly matches all of:

- parent session and canonical workspace;
- child thread ID and exact path or historical exact path digest;
- approved Role/type and existing child-authority kind;
- binding schema, key, operation, state, and `session-ended` close reason;
- anchor job and current job, including their owner, workspace, Rescue command,
  status eligibility, and exact relationship to the binding;
- the selected current-or-anchor job identity used by the continuation;
- the original non-empty `zcodeSessionId`, equal wherever persisted evidence
  represents the same session;
- the expected binding current job, generation, and existing CAS inputs.

Only one complete match may be activated. The existing lock/CAS atomically
changes that exact binding to active continuation state and reserves the next
job. A competing or stale consumer performs no write and no RPC.

Resolve exact child authority, then binding eligibility. In the incident,
`/root/zcode_rescue_task_2` is the sole complete eligible binding; an unbound,
host-only, revoked, nonmatching, or incomplete base is only a distractor. `_2`
wins by eligibility, never suffix. If both are usable without native exact
authority, return `RESCUE_CHILD_AMBIGUOUS`; an explicit native follow-up to
`_2` instead supplies its ambient exact authority inside that child.

The following are never migration authority:

- jobs-only history or an unbound persisted child;
- a host-only/adoption candidate without an exact binding;
- latest job/session, base path, timestamps, list order, or workspace guessing;
- a v3 record presented as historical migration evidence;
- a cancelled, invalidated, explicitly closed, or otherwise revoked binding;
- incomplete, corrupt, duplicate, contradictory, or ambiguous evidence.

These grant no authority. A safely classified distractor is ineligible;
unclassifiable evidence or no unique eligible result fails closed. Migration
does not replace a session or child, or authorize fresh.

## Lifecycle and SessionEnd

`SessionEnd` removes active root-turn/runtime authority and cleans preparation
and runtime ownership according to the existing implementation. It preserves
only an exact completed binding with no active current attempt, plus an exact
v1/v2 `closed/session-ended` migration candidate. Those remain resumable by
the same parent session and child; the legacy state is compatibility
resumability state and is lazily migrated by the exact rules above.

An active writable job continues to use PR #44's existing orphan, stop,
cancellation-lock, worker-lease, and writable-guard safety. After SessionEnd
confirms remote stop/cancellation it may close that exact active operation. An
unacknowledged stop retains the guard and does not infer completion or
resumability. Completion observed before or after a stop race is reconciled
through durable state and its result artifact.

Otherwise a binding becomes permanently closed only through explicit cancel,
close/revoke, or invalidation of that exact child operation. App-server unload,
broker restart, failed observation, and sibling activity do not revoke an
eligible completed binding. Every close or cancel must leave sibling bindings
byte-identical.

## Response loss

Response loss introduces no new protocol and no new action. If a foreground or
background response is lost after work may have been accepted, reuse the
existing durable job and these existing paths:

- `status` and `result` over the owned durable job;
- `reconcileOwnedJobs` for exact owner recovery;
- ZCode `readSession` for the persisted `zcodeSessionId` and accepted boundary;
- existing `resultArtifact` publication and retry behavior.

Recovery may observe, reconcile, and publish the already-produced result. It
must not automatically resend the prompt, issue another `session/send`, roll
back an accepted turn, call `session/create`, or reinterpret response loss as
fresh. Existing `readSession`/artifact ambiguity and stop-safety rules remain
authoritative.

## Stale cancellation

Immediately before `session/stop`, cancellation must re-read under the existing
coordination boundaries and prove:

- the exact job ID still belongs to the requesting owner and is still in the
  expected cancellable status;
- for a bound Rescue job, the exact binding still names that job as current and
  has the expected operation/generation;
- the worker lease or explicit lease absence still matches the attempt being
  cancelled.

A stale loser performs zero `session/stop` RPC and does not close a binding.
If the current cancellation lock, StateStore CAS, and worker-lease checks
already jointly establish these facts, implementation is only a named
regression test plus the smallest missing revalidation. This amendment does
not redesign StateStore or the cancellation-attempt state machine.

## Codex identity observation

Local Codex source confirms that `followup_task` ensures the exact target child
is loaded before sending a follow-up that triggers a turn. It also confirms
that app-server `notLoaded` is the default observation for an unloaded or
untracked persisted thread.

Consequently, a separate app-server process returning `notLoaded` for a
persisted child is normal and acceptable only when joined with the exact parent
graph, child ID, path, Role/type, canonical workspace, and durable binding.
`idle`, `systemError`, missing/foreign parent graph, metadata mismatch, or any
binding mismatch is rejected for this rejoin route.

## A. Traceability

| Original problem | Decision | Concrete acceptance test |
| --- | --- | --- |
| 1. 2026-08-24 `RESCUE_BINDING_INVALID` because `SessionEnd` closed a completed binding | Preserve completed/no-active-attempt and exact legacy migration candidates; retain active-job settlement safety | A4: completed resumes, while confirmed active stop may close only that operation and never siblings |
| 2. The real eligible binding is `/root/zcode_rescue_task_2`, never fallback `task` | Eligibility or native exact-child authority decides; suffix/base/latest never does | A1: `_2` sole eligible wins; two usable bindings without exact authority are ambiguous |
| 3. 2026-08-25 `EXECUTOR_IDENTITY_INVALID` from active-only rejection of `notLoaded` | Independent app-server `notLoaded` is acceptable only with exact identity plus binding | A5: accept exact `notLoaded`; reject idle, systemError, or identity/binding mismatch |
| 4. Same child must retain original-thread semantics and `zcodeSessionId` | Follow up the same Codex ID/path and call `session/resume`, never create | A2: same-parent same-child follow-up proves exact thread/path and original session with zero create/spawn |
| 5. Only a new child is fresh; task 2 must not close task 1 | Fresh always collision-free spawns; siblings are byte-identical | A3: existing task 1/task 2 plus fresh yields a third child and one create, with no old follow-up/close |
| 6. Completed/unloaded and exact legacy `session-ended` remain resumable | Limit preservation to no-active-attempt completion/candidate; confirmed active stop and explicit revoke may close exactly one operation | A4: cover preservation, confirmed active settlement, unacknowledged stop guard, and sibling isolation |
| 7. Response loss must use status/result | Reconcile the existing durable job/session/artifact; never resend | A6: lose status and result responses, recover via `status`/`result`, and prove one accepted send |
| 8. Stale cancel must not stop a new operation | Re-read existing job/binding operation, generation, and lease guards immediately before stop | A7: advance the binding, release stale cancel, and prove zero stop plus untouched new operation |

## Acceptance

Acceptance is limited to these eight regressions; parameterized variants may
share one test:

1. **A1 exact `_2` authority/migration:** `_2` is the only complete eligible
   legacy `closed/session-ended` binding while base is parameterized as
   unbound, host-only, revoked, nonmatching, or incomplete; recover `_2`'s
   original `zcodeSessionId` without suffix/order inference. If base and `_2`
   are both usable and no native follow-up supplies exact child authority,
   return `RESCUE_CHILD_AMBIGUOUS` with zero mutation/RPC; an explicit native
   follow-up to `_2` supplies its ambient exact authority without a new API.
2. **A2 same-child continuation:** same parent, Codex child ID/path, operation,
   and workspace produce one follow-up and exact `session/resume`; zero spawn,
   adoption, or `session/create` occurs.
3. **A3 independent fresh:** with stopped/resumable task 1 and task 2, fresh
   collision-free spawns a new child and calls `session/create` once; old
   children receive no follow-up and their bindings remain byte-identical.
4. **A4 lifecycle/revoke:** a completed exact binding with no active current
   attempt, and an exact legacy session-ended candidate, resume after
   `SessionEnd`. For an active attempt, confirmed remote stop/cancellation may
   close only that operation; an unacknowledged stop retains the existing
   guard. Explicit exact revocation also closes only its target; every sibling
   remains byte-identical.
5. **A5 independent observation:** separate app-server `notLoaded` plus exact
   parent graph, child ID/path/Role, workspace, and binding rejoins; idle,
   systemError, foreign/contradictory metadata, jobs-only, duplicate, ambiguous,
   corrupt, or revoked evidence causes zero mutation and zero RPC.
6. **A6 response loss:** lost foreground/background status and result responses
   recover the same durable job through `status`, `result`, `reconcileOwnedJobs`,
   `readSession`, and `resultArtifact`, with exactly one accepted send and no
   rollback, resend, create, or fresh action.
7. **A7 stale cancel:** after a newer job/operation/generation or lease wins, the
   stale loser issues zero `session/stop`, closes no binding, and leaves the
   current job/operation untouched.
8. **A8 release parity:** focused release/public-text tests, full suite,
   packed-artifact checks, and required CI preserve foreground/background and
   source/marketplace behavior without exposing private state.

## B. Rejected detours

| Proposal | Why rejected here | This amendment's replacement |
| --- | --- | --- |
| Atomic/keyed resume; receipt/query; Ed25519/signing; commit-ID stop | New ZCode/public protocol does not explain either observed routing bug | Exact existing binding/session plus current `status`/`result`/stop guard |
| New dispatch-fence schema; stop reservation/retry budget; new claim-evidence schema | Duplicates existing StateStore CAS, cancellation lock, and worker lease for this fix | Smallest missing exact revalidation immediately before current RPC/publication |
| 30-task manifest/tag; JSONL auditor; complex CI governance | Broad governance has no bearing on task `_2` identity or lifecycle semantics | Eight focused regressions and existing release/packed checks |
| StateStore/filesystem/privacy/writable-exclusion redesign | Existing mechanisms remain safety constraints and are not root causes | Reuse current codec, lock/CAS, private projections, and writable guard unchanged |

The implementation plan must not reintroduce any rejected detour unless a
separate spec is approved by the user first.

## Out of scope

- Any new Codex/ZCode API, automatic resend, rollback of an accepted turn, or
  fresh recovery after response loss.
- Jobs-only adoption, unbound-child adoption, base/latest/timestamp selection,
  eager migration, broad data repair, or garbage-collection redesign.
- Dispatch, cancellation, claim, StateStore, filesystem, privacy, writable
  exclusion, broker, lease, cryptography, audit, manifest, or CI redesign.
- Changes to code/tests in this amendment commit. A later implementation plan
  may change only the minimum production/test surfaces required by A1-A8.

## Implementation boundary

Prefer deletion or narrowing of conflicting fresh/adoption selection over new
machinery. Reuse the existing binding codec, canonical workspace resolver,
state lock/CAS, job ownership, worker lease, recovery, status/result, and ZCode
client operations. The implementation plan should add only the production
regressions above and the minimum code required to make them pass.
