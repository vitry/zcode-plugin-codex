# Rescue Worktree Late Binding Design

Status: approved for implementation on 2026-08-21

## Problem

Codex can start a parent conversation in a repository root and create or enter a
linked Git worktree later in the same user turn. The installed Rescue launcher
then runs from the worktree. Today ZCode binds all parent authority to the cwd
captured by `UserPromptSubmit`, so `role-status rescue` looks for both the active
turn and SessionStart proof in the worktree partition, finds neither, and
returns `caller-unavailable`.

This is not a caller TTL, Role installation, or ZCode App Server failure. The
parent session and turn are still active; only the execution directory changed.
Requiring a user-visible handoff would expose an implementation detail and make
ordinary worktree creation unnecessarily fragile. Blindly accepting any cwd at
Rescue start would fix the usability problem but discard ZCode's exact parent,
turn, permission, executor, and cleanup guarantees.

## Goals

- Let one active owned parent turn start in an origin workspace and run Rescue
  from the origin or a linked worktree without a manual handoff.
- Keep `role-status rescue` read-only. The first trusted parent `prepare rescue`
  atomically binds the execution workspace before task bytes are accepted.
- Permit only the origin itself or a canonical linked worktree from the same
  Git common directory. An unrelated repository or arbitrary directory cannot
  claim the turn.
- Make the first execution-workspace binding immutable for the turn; concurrent
  contenders have exactly one winner.
- Keep preparation, executor, job, binding, broker, result, and continuation
  state strictly scoped to the bound execution workspace.
- Route SubagentStart/Stop and parent Stop/SessionEnd cleanup correctly even
  when Codex hooks continue to report the origin cwd.
- Preserve same-workspace behavior, non-Git exact-origin behavior, legacy
  installed state, lifecycle-bound active turns, 30-minute caller/preparation
  TTLs, and existing public status vocabulary.
- Prove the route with deterministic qualification and an authenticated real
  ZCode two-turn response check in the target worktree.
- Regenerate the marketplace only from a clean exact source commit.

## Non-goals

- Do not use ZCode Rescue to implement or review this change.
- Do not make every ZCode command workspace-mobile. Generic caller contexts,
  review, adversarial review, transfer, status, result, and cancel retain their
  current exact-workspace contracts.
- Do not trust a caller-supplied path, Git display name, branch name, repository
  remote, or process environment as authority.
- Do not let Role inspection, a child agent, progress, a heartbeat, or a ZCode
  response create or change the execution-workspace binding.
- Do not scan every workspace partition to guess where a session or executor
  lives.
- Do not copy an active-turn record from one workspace to another.
- Do not add a public flag, handoff command, task field, or child-visible token.
- Do not weaken the exact stopped-child, one-shot preparation, permission
  snapshot, binding CAS, or owner-session checks delivered by PR #38.
- Do not change ordinary completion, request, cancellation, or review-gate
  timeout semantics.

## Considered Approaches

### 1. Trust the cwd at every Rescue command

This matches `codex-plugin-cc`: each command canonicalizes its current cwd and
uses that workspace. It is simple and worktree-friendly, but it cannot prove
that the current directory was selected by the same active parent turn. A child
or stale process with ambient session material could redirect work.

### 2. Deepen IdentityStore with a compatible active-turn v3 (chosen)

`IdentityStore` already owns active-turn creation, resolution, replacement, and
cleanup. Deepen that module so one versioned active turn can distinguish origin
from execution workspace. Existing callers keep the exact same
`resolveActiveTurn({sessionId, workspace})` origin semantics. Rescue callers add
one explicit `workspaceBinding` value to the same resolution interface:
`preview`, `claim`, or `execution`. Generic caller tokens and workspace-local
state remain unchanged.

This preserves one semantic source of truth: "the active parent turn". Git
lineage, global v3 storage, legacy fallback, locking, target ledger, and caller
projection stay behind the existing IdentityStore seam.

### 3. Add a separate Rescue authority module

This would reduce edits inside IdentityStore, but it would create two modules
that independently answer which parent turn is current. Replacement prompt,
Stop, SessionEnd, malformed-state compatibility, and tests would have to keep
both truths synchronized. The duplicated semantic is rejected.

## Authority Model

There are two distinct workspace concepts:

- `originWorkspace`: the canonical cwd whose SessionStart and
  UserPromptSubmit hooks proved the parent session and active turn.
- `executionWorkspace`: initially null, then the immutable canonical cwd where
  the first trusted parent preparation occurred.

The authority state machine is:

```text
SessionStart(origin)
  -> UserPromptSubmit(origin)
       -> ACTIVE_UNBOUND

role-status(candidate)
  -> preview only
  -> ACTIVE_UNBOUND or ACTIVE_BOUND_TO(candidate): continue inspection
  -> bound elsewhere / ineligible / missing / corrupt: caller-unavailable

prepare(candidate), before TTY ready or task read
  -> ACTIVE_UNBOUND + eligible candidate: ACTIVE_BOUND_TO(candidate)
  -> ACTIVE_BOUND_TO(candidate): idempotent caller resolution
  -> ACTIVE_BOUND_TO(other): reject

SubagentStart / invoke-prepared / continuation
  -> require ACTIVE_BOUND_TO(executionWorkspace)

replacement UserPromptSubmit
  -> replaces the active turn with ACTIVE_UNBOUND

turn-ending Stop
  -> revokes the exact active turn before advisory target cleanup

SessionEnd
  -> terminalizes the session authority before all origin/target cleanup
```

`role-status` deliberately does not claim a workspace. A failed, outdated, or
conflicting Role inspection must not consume the one binding choice. `prepare`
claims before enabling raw TTY transport or reading the private task frame, so
rejected candidates cannot disclose or persist task material.

## Deepened IdentityStore

Extend `scripts/lib/identity.mjs`. It already owns validation, canonicalization,
authorization storage, locking, compatibility, and fixed private errors. The
deepened implementation additionally hides repository-lineage checks and the
active-turn v3 lifecycle. Hooks and the companion do not manipulate record
bytes directly.

State is stored outside workspace partitions:

```text
<dataRoot>/identity-lifecycle/
  session-locks/
  active-turns/<sha256(sessionId)>.json
  sessions/<sha256(sessionId)>.json
```

The directory and files retain the existing private 0700/0600 guarantees. The
active record uses the new exact schema:

```json
{
  "version": 3,
  "kind": "active-turn",
  "key": "sha256 session slot key",
  "sessionId": "parent Codex session",
  "generationId": "random 256-bit digest",
  "turnId": "current parent turn",
  "originWorkspace": "/canonical/origin",
  "executionWorkspace": null,
  "permissionMode": "workspace-write",
  "prompt": "bounded private prompt",
  "createdAt": "RFC3339 timestamp",
  "status": "active"
}
```

The companion session ledger is a second exact internal record:

```json
{
  "version": 1,
  "kind": "identity-session",
  "key": "sha256 session slot key",
  "sessionId": "parent Codex session",
  "sessionStartedAt": "RFC3339 timestamp",
  "sessionSource": "startup",
  "knownWorkspaces": ["/canonical/origin-or-worktree"],
  "endedAt": null,
  "updatedAt": "RFC3339 timestamp"
}
```

All object keys are exact. Identifiers, paths, prompt bytes, timestamps, file
size, record count, and the workspace ledger are bounded. The ledger has a
fixed maximum of 16 canonical entries. Claiming a seventeenth distinct target
fails closed rather than dropping cleanup provenance.

The existing interface gains compatible return metadata and one optional
resolution discriminator:

```js
beginCallerTurn({ sessionId, turnId, workspace, permissionMode, prompt,
                  sessionStartedAt?, sessionSource?, lifecycleResult? })
resolveActiveTurn({ sessionId, workspace,
                    workspaceBinding?: 'preview' | 'claim' | 'execution' })
endCallerTurn({ sessionId, turnId, workspace })
cleanupSession(workspace, sessionId)
```

Existing callers that omit SessionStart proof keep writing and resolving the
current workspace-local v2/legacy representation only. The trusted prompt hook
passes both proof fields together, causing IdentityStore to publish the global
v3 representation and exact session ledger plus the unchanged workspace-local
caller token. It does not publish a second active-turn mirror. No-option
`resolveActiveTurn` reads v3 with exact `originWorkspace` semantics when v3
exists, otherwise the legacy workspace record. A lifecycle session ledger of
any state suppresses legacy fallback, even if its active record is absent,
pending, ended, invalid, or future-versioned. `resolveOnlyActiveTurn` follows a
bounded exact origin index stored in that workspace and validates its global v3
target; it does not scan unrelated global slots. Omitting `workspaceBinding`
therefore preserves today's observable exact origin-workspace behavior.
`preview` is read-only and accepts an unbound eligible candidate or the exact
bound target. `claim` performs the one null-to-canonical transition and returns
the same caller shape. `execution` accepts only the validated origin or exact
bound path and projects `workspace` to the already-bound target; this lets an
origin-cwd hook discover the target without trusting a caller-supplied path.
`endCallerTurn` and `cleanupSession` additionally return only canonical
workspaces already named by validated records so callers can perform advisory
cleanup without scans. Existing callers that ignore return values remain
compatible.

`lifecycleResult: true` is valid only with the exact SessionStart proof pair.
It returns `{token, replacedTurn}` where `replacedTurn` is null or the previous
validated `{turnId, generationId, executionWorkspace}`. Existing callers omit
the flag and continue receiving the token string.

### Session proof

`UserPromptSubmit` must first resolve the existing workspace-local SessionStart
record, not merely test a boolean. It passes that record's exact `startedAt` and
`source` into `beginCallerTurn`. The method accepts both proof fields together
or neither; a partial pair is invalid. Therefore v3 authority is derived only
from the existing trusted hook chain. Role preflight no longer needs a
SessionStart record in the target worktree; it resolves the original record
using the validated `originWorkspace` returned by IdentityStore.

A compact SessionStart never silently replaces a stronger startup/resume/clear
proof. A record terminalized by SessionEnd cannot reopen unless a strictly newer
valid SessionStart proof reaches a later UserPromptSubmit.

### Workspace eligibility

The candidate is canonicalized with the existing realpath-based workspace
resolver. It is eligible when either:

1. it exactly equals `originWorkspace`; or
2. origin and candidate are both inside Git worktrees, the candidate exactly
   equals its canonical `--show-toplevel`, and their bounded, shell-free
   `git rev-parse --path-format=absolute --is-inside-work-tree --show-toplevel
   --git-common-dir` results prove the same canonical common directory.

Git inspection uses an explicit executable and argv, no shell, bounded output,
and a short fixed deadline. If either directory is non-Git, only exact-origin
binding is allowed. Remote URL, branch name, index content, and working-tree
content are irrelevant. A symlink alias is accepted only after both the
workspace and common directory resolve canonically.

### Linearization and lock order

v3 creation, `claim` resolution, `endCallerTurn`, and `cleanupSession` linearize
under a bounded, digest-striped per-session lifecycle lock. The fixed stripe
pool prevents attacker-controlled lock-path growth; a digest collision may
briefly serialize unrelated sessions but cannot run Git or other slow external
work while holding the stripe. Two candidate worktrees racing to claim can
produce only one winner. Resolving the already selected exact target is
idempotent; claiming any other target is always rejected.

Changed-turn publication is fail-closed across the session lifecycle and origin
workspace locks:

1. under the session lock, validate the ledger, capture replaced-turn metadata,
   append the new origin to `knownWorkspaces`, and publish a new random
   generation with `status: "pending"`; pending suppresses every resolver and
   every legacy fallback;
2. after releasing the session lock, reacquire that same session lock, require
   the exact pending generation before any workspace mutation, then acquire
   each affected workspace identity lock in the single permitted
   session-to-workspace order; remove every old caller token for this session
   and write the new unreachable random token plus the exact origin index;
3. while retaining the session lock, revalidate the exact generation and
   replace only `status` with `"active"`; only then release locks and return the
   token/result. A superseded publisher fails before touching a newer token or
   index.

A crash or injected failure before step 3 leaves no usable authority. Retrying
the exact pending generation repairs and publishes it; a conflicting begin
supersedes it with another pending generation. An exact duplicate hook input
with identical session proof, turn, origin, permission, and prompt is
idempotent and retains the current generation and execution binding while
rotating the caller token. Reusing the same turn ID with any changed authority
field creates a new generation, resets execution to null, and invalidates the
old generation. Fault-injection tests cover every publication point.

The only nested lifecycle lock order is session lifecycle followed by workspace
identity during fenced publication or exact cleanup. No code acquires a session
lifecycle lock while holding a workspace lock, and lifecycle code never nests
preparation, hook-state, job, binding, or broker locks. The required order is:

```text
session lifecycle lock -> workspace identity lock
```

Git eligibility inspection happens outside the session lock; `claim` then
reacquires the session lock and revalidates the exact generation/state before
publishing ledger-first and active-record-last. This prevents slow Git from
blocking unrelated sessions and prevents cleanup/preparation lock inversion.
Callers must re-resolve the bound authority at the next security-sensitive
boundary rather than trust a stale object across an asynchronous workspace
mutation.

## Production Integration

### UserPromptSubmit

The prompt hook keeps creating the existing origin-scoped caller context and
gate baseline. Its active-turn representation becomes v3 when proof is present:

1. resolves the exact origin SessionStart record;
2. calls the deepened `IdentityStore.beginCallerTurn()` with
   `lifecycleResult: true`, which publishes the compatible v3 generation and
   returns the prior validated target, if replaced;
3. after the method releases its locks, cleans the replaced target's exact
   preparation; its 30-minute TTL remains a fail-safe if advisory cleanup fails;
4. only emits the installed Rescue launcher context after publication succeeds.

Starting a newer prompt for the same session replaces only the active turn;
the bounded workspace ledger remains available for SessionEnd cleanup.

### Role readiness

Installed `role-status rescue` calls `resolveActiveTurn()` with
`workspaceBinding: 'preview'`, the ambient parent session, and current cwd. An
unbound eligible candidate or the exact bound candidate may continue to managed
Role inspection. An ineligible, different-bound, absent, ended, or invalid
record maps to the existing fixed `caller-unavailable` status. No path, session,
turn, prompt, Git output, or private error is rendered.

Source-checkout setup keeps its existing exact-workspace active-turn and
SessionStart diagnostics. This design changes installed Rescue readiness only.

### Private prepare

`prepare rescue` calls `resolveActiveTurn()` with `workspaceBinding: 'claim'`
before `withPrivatePreparationTransport()`. Only after claim succeeds may the
launcher write readiness, switch to raw mode, or read the LF-terminated private
envelope. Preparation is then saved using the returned caller with
`workspace === executionWorkspace`.

IdentityStore may resolve the existing workspace v2 or unversioned active-turn
record only when both the global active slot and lifecycle session ledger are
truly absent. Any valid, pending, ended, malformed, future-version, or mismatched
global lifecycle bytes suppress fallback.

### Subagent lifecycle

SubagentStart resolves the parent's turn with `workspaceBinding: 'execution'`,
`input.session_id`, and origin hook cwd. IdentityStore projects the caller
workspace to the bound target. The forwarding marker and an exact bounded
`executor-route` pointer remain in the hook origin; the pointer binds agent,
parent session/turn/generation, child turn, and canonical target. The executor
record is written to the target and gains the same parent generation ID.
SubagentStop follows only that exact origin pointer, revalidates the target
executor, and marks it stopped even if the current active turn has since been
replaced. It never searches the workspace ledger or data-root partitions.

Forwarding suppression may inspect at most the two validated locations already
named by the authority: origin and execution workspace. It never enumerates
workspace partitions. Sibling agents, child ambient thread IDs, wrong
generations, turns, permissions, and unapproved Role types remain rejected.

### Invocation and durable state

`invoke-prepared`, choice continuation, bound status, state reservation, job
artifacts, broker ownership, and ZCode session creation continue to use only the
bound execution workspace. They must call `resolveActiveTurn()` with
`workspaceBinding: 'execution'` at their current authorization boundary. The
origin workspace is never substituted into a job, preparation, executor,
binding, artifact, or peer request.

### Stop and SessionEnd

When Root Stop actually ends the turn, it first calls the existing
`endCallerTurn()`; the deepened method revokes both generic and v3 authority and
returns the validated bound target. It then cleans the exact preparation in
that target, if any. A BLOCK outcome retains the active authority exactly as it
does today.

SessionEnd first calls the existing `cleanupSession()`, whose v3 lifecycle path
sets the session ledger `endedAt`, clears the active turn, and returns every
validated entry in bounded `knownWorkspaces`. Every proved begin appends its
origin; every successful claim appends its target. Authorization is
therefore revoked even if later advisory cleanup is interrupted. Local
preparation, executor, identity, and binding cleanup runs only for those
returned workspaces. Remote job settlement and broker release share the
existing absolute SessionEnd budget and may be attempted in bounded parallel;
unacknowledged work retains its durable guard for normal scavenging.

Cleanup failures never restore authority. A later SessionEnd/recovery pass may
read an ended tombstone for its bounded workspace ledger but cannot authorize
new Role, prepare, child, or invocation work.

## Compatibility and Migration

- Existing workspace-scoped v2 and legacy active-turn records retain their
  exact semantics for generic commands.
- Only when both global lifecycle files are truly absent may installed Rescue
  use the old exact-workspace route. It cannot late-bind or scan for another
  workspace. A session tombstone permanently suppresses stale v2 fallback.
- The first valid post-upgrade UserPromptSubmit creates the v3 record; no
  explicit setup, cache migration, or user handoff is required.
- Once a v3 slot exists, any invalid bytes or identity mismatch fail closed
  and suppress legacy fallback.
- Existing caller tokens, preparations, executors, jobs, bindings, results,
  model policy, and broker records are not rewritten.
- Marketplace Role template and public child assignment text do not change, so
  this feature does not require a Role receipt or schema bump.
- Plugin version remains unchanged; the Unreleased changelog documents the
  behavior.

## Errors and Privacy

Internal authority errors use fixed task-free messages and codes for missing,
invalid, ineligible, unbound, bound-to-other, ended, capacity, and lock failure.
Public Role readiness continues to expose only:

```json
{
  "type": "role-status",
  "role": "zcode-rescue",
  "status": "caller-unavailable",
  "remedy": "Retry from an active owned parent turn."
}
```

No public output may include either workspace path, Git common directory,
session or turn identity, prompt/task text, permission mode, child identity,
record key, exception message/stack, or workspace-ledger contents. Authority
records never contain caller tokens, launcher commands, preparation frames,
ZCode session IDs, job IDs, or child IDs.

## Test and Qualification Requirements

### Unit tests

- Exact v3 active-turn and v1 session-ledger schemas, file bounds, private
  permissions, defensive copies, and
  fixed errors.
- Exact-origin and same-common-dir eligibility; unrelated repo, non-Git target,
  nested subdirectory, bare/admin directory, moved worktree, symlink escape,
  malformed Git output, timeout, and oversized output reject.
- Preview is read-only. Bind is idempotent for the winner and immutable against
  a second target.
- Sixteen-way two-target contention produces one target winner and one exact
  stored binding.
- Pending/publication failure at every persistence seam, exact duplicate
  idempotence, same-turn-ID changed-authority generation replacement, Stop
  revocation, SessionEnd tombstone/retry, origin index bounds, 16-workspace
  capacity, session isolation, malformed/future records, and strict fallback.
- Tombstone-plus-stale-v2, corrupt-ledger-plus-v2, and pending-plus-v2 never
  authorize. Unrelated corrupt global slots cannot block indexed setup.
- Child session IDs and wrong session/generation/turn/permission cannot claim
  or resolve.

### Hook and integration tests

- SessionStart and UserPromptSubmit at repository root, followed by creation of
  a real linked worktree in the same parent turn.
- Worktree role-status succeeds without mutation; prepare then binds before
  TTY readiness and saves the one-shot task only in the worktree.
- Two sibling worktrees race; exactly one can prepare and the loser reveals no
  path or task.
- Bound target A rejects role-status, prepare, SubagentStart, invoke-prepared,
  and continuation from target B while A remains usable.
- SubagentStart/Stop reporting origin cwd still creates and closes the executor
  in the target through the exact generation-bound route pointer; replacement
  before SubagentStop does not lose that route. Forwarding suppression remains
  exact.
- Turn-ending Stop and SessionEnd received at origin revoke first and clean the
  target without touching sibling sessions. BLOCK Stop retains authority. A
  three-turn fixture with two origins and two targets proves the full bounded
  ledger, partial cleanup failure, and tombstone retry.
- Same-workspace and non-Git exact-origin routes remain green.
- Legacy exact-workspace installed state works; invalid v3 state never
  falls back.

### Qualification and authenticated response

Qualification evidence must distinguish `originWorkspace` from
`executionWorkspace`. SessionStart/UserPromptSubmit/parent Stop occur at the
origin; preflight, prepare, executor, job, binding, broker, and peer
`session/create.workspace` occur at the target. Raw evidence includes the
unbound-to-bound authority transition and rejects missing, rewritten,
second-target, wrong-turn, wrong-permission, or reordered mutations.

The opt-in authenticated real ZCode qualification creates an isolated linked
worktree, performs two sends in the same exact ZCode session at that target,
and requires a new non-empty visible assistant result linked to each accepted
input. Each operation has an explicit qualification-only completion budget;
ordinary Rescue remains deadline-free.

### Regression and release verification

- Focused authority, identity, hook, companion, preparation, binding, skill,
  qualification, release-contract, and marketplace tests.
- `npm run check` on the source tree.
- Authenticated installed Rescue and real ZCode opt-in suites where available.
- Build marketplace from a clean exact source SHA; compare every mirrored file
  byte-for-byte and verify provenance/lock digest.
- Independent spec/security review, then independent code-quality review.
- Pull request CI must pass Ubuntu, macOS, and Windows on Node 22.13 and LTS.

## Documentation

Update English and Chinese README operation sections to state:

- conversation origin and Rescue execution workspace are separate;
- linked-worktree selection is automatic at first trusted prepare;
- no visible handoff is needed;
- binding is immutable for that turn and unrelated repositories are rejected;
- Stop/new prompt/SessionEnd revoke or replace authority across the origin and
  bound target.

Update `SECURITY.md`, the Unreleased changelog, release-contract tests, and the
Rescue authorization ADR. Generated marketplace files are never hand edited.
