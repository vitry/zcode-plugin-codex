# Resume Runtime, Effective Workspace, and Compact Launcher Recovery Design

## Status and scope

This design addresses three independent failures observed while continuing an
existing ZCode Rescue operation:

1. a cold `session/resume` returns `ZCODE_RUNTIME_MODEL_UNAVAILABLE` because
   the app-server has restored the persisted session but has not materialized
   its runtime model adapter;
2. direct `status`, `result`, and `cancel` commands reject a valid Rescue
   execution worktree as `ACTIVE_TURN_WORKSPACE_INELIGIBLE`; and
3. a mid-turn Codex context compaction removes the trusted Rescue launcher
   descriptor before Root later selects Rescue in the same turn.

The fixes remain inside the ZCode Codex plugin and use existing ZCode
app-server and Codex hook contracts. They do not modify Codex, ZCode, the
public Rescue command syntax, the binding identity model, or the conservative
one-active-writable-Rescue-per-canonical-workspace policy.

## Incident findings

### Cold resume runtime materialization

The historical ZCode session and its model tuple are valid. A new app-server
process can restore the session, but the first cold `session/resume` snapshot
may carry:

```json
{
  "projection": {
    "lastError": {
      "type": "ZCODE_RUNTIME_MODEL_UNAVAILABLE"
    }
  }
}
```

The current executor accepts that snapshot, performs no model materialization
when the request and plugin workspace policy omit a model, and later reaches a
failure boundary. A real local experiment proved the supported recovery
sequence:

```text
session/resume without runtime input
read effective ~/.zcode/cli/config.json only after the exact warning
session/setModel with the selected provider/model tuple
session/send
```

After `session/setModel`, the warning clears and the same process treats later
resumes as warm. A warm resume therefore does not require another CLI config
read.

### Direct command execution workspace

`status`, `result`, and `cancel` enter the generic direct-invocation path with
the ambient cwd. That path resolves the active turn without an execution
workspace binding mode, so lifecycle v3 accepts only the origin workspace.
When Rescue has immutably bound a distinct linked worktree as its execution
workspace, a command invoked from that valid worktree is rejected before job
inspection.

Changing only the authorization check would be incorrect. Pending invocation
state, job selection, results, logs, cancellation, broker ownership, model
policy, reconciliation, and Rescue binding closure must all use the same
authoritative effective workspace.

### Launcher loss across mid-turn compaction

The affected rollout proves this exact sequence:

1. the owned parent `UserPromptSubmit` hook emitted one valid installed
   `[zcode-rescue-launcher]` descriptor;
2. Codex performed a mid-turn context compaction;
3. the replacement history did not retain that descriptor;
4. Codex ran `SessionStart(source="compact")` before continuing the same turn;
5. the plugin reinjected only the generic lifecycle-active sentence; and
6. Root later selected Rescue, found no trusted launcher descriptor, and
   correctly stopped before any launcher, Companion, child, or ZCode call.

This is a compact-context rehydration gap. It is not a launcher executable,
workspace, binding, ZCode session, or app-server failure.

## Design principles

- Recovery is driven by exact structured state, never by message text,
  timestamps, latest-session guesses, or broad exception matching.
- One subsystem owns each decision: ZCode config owns its default model,
  lifecycle identity owns the effective workspace, and the executing hook
  instance owns the launcher path.
- Every recovery is lazy and bounded. Normal fresh and warm paths pay no
  additional config or discovery cost.
- Existing fail-closed boundaries remain effective. No fix scans unrelated
  workspaces, adopts sibling state, retries indefinitely, or falls back to a
  fresh operation.
- Configuration secrets, private binding identifiers, prompts, and job state
  do not enter new public output.

## Cold resume runtime recovery

### Trigger and order

The executor first calls `session/resume` exactly as it does today. Immediately
after the schema-validated snapshot returns, it inspects only:

```text
snapshot.projection.lastError.type
```

Runtime recovery is eligible only when all of the following are true:

- the operation is resuming an existing session;
- the exact type is `ZCODE_RUNTIME_MODEL_UNAVAILABLE`; and
- no runtime recovery has already been attempted for this execution.

All other resume snapshots continue through the existing path unchanged.
Ordinary resume errors, authentication errors, transport failures, timeouts,
and other `lastError` types are not recovery triggers.

### Model selection precedence

For an eligible cold resume, select one tuple in this order:

1. an explicit public `--model` resolved through the returned live catalog;
2. the existing plugin workspace model policy, if present; or
3. the effective ZCode CLI configuration `model.main`.

The third branch is a compatibility recovery, not a new public model choice.
It is read only when the exact cold warning occurs and neither higher-priority
source supplies the tuple. The plugin does not fall back to a different alias,
catalog default, Desktop configuration, historical usage database, environment
secret, or arbitrary first model.

Even when the selected tuple text equals `snapshot.settings.model.current`,
the executor calls `session/setModel` once. The call is the runtime adapter
materialization action; textual equality is not proof that a cold adapter
exists. The existing client continues to send
`persistAsWorkspaceLastUsed: false` and verify that ZCode applied the exact
tuple.

If an effort was requested, effort application occurs after the recovered
model is materialized. Then the executor sends the prompt once. No prompt is
sent before this recovery sequence, so recovery never resends user work or
creates a second input boundary.

### Effective CLI configuration reader

A focused module reads only:

```text
<effective-home>/.zcode/cli/config.json -> model.main
```

The effective home follows the execution environment (`HOME`, then
`USERPROFILE`, then the platform home fallback). The reader uses a bounded
regular-file read, bounded JSON parsing, an exact supported object shape for
the required field, and splits `provider/model` at the first slash. It returns
only:

```json
{"providerId":"provider","modelId":"model"}
```

It never returns, logs, persists, copies, or includes in an error any provider
options, endpoint, API key, token, secret, or raw configuration bytes.

Missing, unreadable, oversized, malformed, or unusable `model.main` leaves the
original runtime-unavailable condition authoritative. The public error remains
bounded and task-free. A `session/setModel` rejection or a later real
`session/send` provider/model failure is propagated through its existing
structured error path. Recovery is attempted at most once and never loops,
creates a replacement session, selects fresh, or mutates CLI configuration.

## Lifecycle-authoritative effective workspace

### New read-only identity mode

IdentityStore gains a distinct atomic resolution mode for generic job
commands. It does not change the existing strict `execution` mode used by
prepared Rescue.

For lifecycle v3:

- when no execution workspace is bound, only the canonical origin is eligible
  and the effective workspace is that origin;
- when an execution workspace is bound, either the canonical origin or that
  exact canonical execution target may invoke the command, and the returned
  effective workspace is always the bound target;
- an unrelated repository, nested directory, sibling/competing worktree,
  stale generation, contradictory record, or malformed lifecycle fails
  closed.

Legacy lifecycle state retains exact-workspace behavior. The resolution occurs
under the existing identity lock so a binding cannot race between separate
origin and execution probes. This mode is read-only: it performs no late
binding claim, Git probing for a new target, caller rotation, or state repair.

### Command scope and propagation

Only direct `status`, `result`, and `cancel` use the new mode. Review,
adversarial review, transfer, setup, and Rescue preparation keep their current
workspace contracts.

The direct invocation resolves the caller once and passes
`caller.workspace` as the effective workspace through every downstream
operation, including:

- pending invocation creation and consumption;
- job lookup, latest selection, `--all`, waiting, and result artifacts;
- private log and model-policy storage;
- orphan and broker reconciliation;
- cancellation and remote stop; and
- exact Rescue binding closure after cancellation.

The plugin never merges origin and target partitions and never scans all
workspace partitions. An explicit job ID does not weaken owner-session or
canonical-workspace confinement. `--all` remains a view of one authoritative
workspace partition.

## Compact launcher rehydration

### Hook behavior

The existing `SessionStart` hook continues recording lifecycle state exactly as
it does today. Its additional context becomes source-sensitive:

- `startup`, `resume`, and `clear` keep the current generic lifecycle-active
  sentence; the following `UserPromptSubmit` hook supplies the ordinary turn's
  launcher descriptor;
- `compact` emits one freshly machine-rendered Rescue launcher descriptor from
  the executing plugin instance so the immediate post-compaction continuation
  regains the task-free launcher boundary.

The compact hook does not call `beginCallerTurn`, replace permission or prompt
snapshots, create a gate baseline, clean preparations, inspect unread jobs, or
mint any new execution authority. The active turn published by the original
`UserPromptSubmit` remains authoritative.

Launcher rendering reuses the same shared renderer and plugin-instance
provenance rules as `UserPromptSubmit`. The path comes from the executing hook
entry and runtime plugin root, never cwd, PATH, a repository, a global package,
Skill prose, or cache search. The session lifecycle hook becomes an explicitly
trusted runtime entry for this purpose.

If the launcher path is unsafe, the compact hook emits only the existing fixed
`[zcode-rescue-launcher-error]` context. It does not fall back to the generic
lifecycle sentence or another installation.

### Duplicate and trust semantics

This design does not weaken the Rescue Skill gate. Root still accepts exactly
one trusted lifecycle descriptor in its current active context. Missing,
malformed, disagreeing, duplicate, ambiguous, or user/summary-supplied
descriptors remain terminal.

The plugin emits no launcher from ordinary SessionStart sources, preventing a
normal startup duplicate. If a future Codex host retains an earlier descriptor
while also injecting the compact descriptor, the existing duplicate rule fails
closed rather than silently deduplicating or selecting one.

## Compatibility and migration

- No persisted schema migration is required for any of the three fixes.
- Existing jobs, bindings, continuation envelope versions, ZCode session IDs,
  and marketplace-qualified plugin data roots remain valid.
- Fresh sessions retain current model selection and do not read CLI config
  through this recovery path.
- Warm resumed sessions without the exact warning do not read CLI config or
  issue a recovery `session/setModel`.
- Existing explicit/workspace model behavior remains higher priority.
- Existing same-workspace direct job commands remain compatible.
- The public `$zcode:rescue`, `$zcode:status`, `$zcode:result`, and
  `$zcode:cancel` grammar does not change.
- The one-active-writable-Rescue policy remains unchanged and is still tracked
  only as a future ADR evaluation.

## Error handling and observability

New configuration and identity errors use fixed bounded plugin codes and
remedies without embedding absolute private state paths, config bytes, model
provider options, caller tokens, binding selectors, or task text.

The runtime recovery path distinguishes:

- exact cold warning plus successful materialization;
- unavailable or invalid CLI default, which preserves the original warning;
- model-application rejection, which remains the real ZCode error; and
- post-materialization send rejection, which remains the real turn/provider
  error.

The workspace path distinguishes ineligible ambient workspace from corrupt or
stale lifecycle state without searching for a usable job elsewhere. The
compact hook keeps existing safe stderr failure behavior and emits only one
fixed launcher-error context on unsafe provenance.

## Verification strategy

### Cold resume

- Unit-test the CLI config reader for valid first-slash parsing, missing field,
  malformed/oversized input, invalid tuples, home selection, and secret
  non-disclosure.
- Extend the fake ZCode peer with an exact cold warning that clears only after
  `session/setModel`.
- Prove the exact sequence `resume -> setModel -> send`, with no send before
  recovery and no second config read after the session is warm.
- Prove explicit and plugin workspace models retain precedence and are forcibly
  applied even when equal to the cold snapshot's current tuple.
- Prove other warning types, setModel failures, missing config, and genuine
  unsupported models expose their authoritative failure without retry loops or
  fresh fallback.
- Prove requested effort is applied after model recovery.

### Effective workspace

- Unit-test unbound origin, bound origin, bound execution target, unrelated
  repository, sibling worktree, stale/corrupt lifecycle, and legacy exact
  behavior under the new identity mode.
- Integration-test `status`, `result`, and `cancel` from both the origin and
  exact bound execution worktree, with target and origin decoy jobs proving
  that only the target partition is used.
- Prove `--all`, latest selection, explicit IDs, result artifacts, logs,
  broker stop, and binding closure remain owner- and target-confined.
- Prove review, adversarial review, transfer, setup, and Rescue routing retain
  their prior workspace behavior.

### Compact launcher

- Run the hook sequence `startup SessionStart -> UserPromptSubmit -> compact
  SessionStart` and prove the compact output contains exactly one descriptor
  identical to the executing instance's ordinary descriptor.
- Prove compact rehydration preserves the original trusted session source and
  active caller turn without minting or rotating authority.
- Prove repeated compact hooks are deterministic.
- Prove startup/resume/clear SessionStart outputs contain no launcher.
- Prove unsafe, symlinked installed, source, and wrong-entry provenance follow
  the existing fixed renderer and namespace-isolation rules.
- Preserve hook context limits and add marketplace-installed coverage for the
  mirrored hook.

### Release gates

Run focused unit and integration tests first, then line-ending checks, lint,
typecheck, the complete default suite, qualified non-credit tests, packed
marketplace installation, source/marketplace byte parity, plugin validation,
and all GitHub Actions jobs on the supported Node 22.13 platform matrix.

## Documentation and publication

Update the bilingual README, SECURITY, CHANGELOG Unreleased section, affected
Skill descriptions, and release contract tests to describe:

- lazy one-shot CLI-config-backed cold runtime recovery;
- lifecycle-authoritative status/result/cancel workspace selection without
  scanning; and
- compact SessionStart launcher rehydration.

Historical specs remain unchanged; this document supersedes their narrower
non-goals only where it explicitly extends direct job commands or compact
launcher recovery.

After source commits and review, generate the marketplace snapshot through the
existing clean-source builder. Do not hand-edit generated marketplace files or
marketplace installation configuration.

## Acceptance criteria

1. The exact historical cold-resume shape materializes the configured runtime
   once and sends the continuation once in the original ZCode session.
2. Warm resume performs no CLI config read and no recovery setModel call.
3. Invalid/missing config and truly unsupported models remain visible failures
   with no fallback, loop, resend, or replacement session.
4. Status, result, and cancel invoked from either eligible origin or exact
   bound target operate only on the authoritative execution partition.
5. Unrelated or competing workspaces and foreign owners remain rejected, and
   explicit IDs confer no additional authority.
6. After mid-turn compaction, the same active owned parent turn receives one
   freshly rendered launcher descriptor from the same plugin instance and can
   enter the unchanged Rescue gate.
7. Ordinary SessionStart sources do not duplicate the UserPromptSubmit
   descriptor, and unsafe or ambiguous launcher contexts still fail closed.
8. No persisted schema, public command argument, binding identity, concurrency
   policy, Codex source, or ZCode source changes.
9. Source, installed marketplace snapshot, bilingual documentation, security
   contract, and qualification fixtures agree.
10. The PR CI matrix completes successfully.

## Out of scope

- Modifying Codex compaction or hook implementation.
- Modifying ZCode app-server or CLI.
- Persisting endpoints, API keys, provider options, or complete ZCode runtime
  configuration in plugin state.
- Public model-recovery, workspace-selector, launcher, child-ID, or
  continuation-handle arguments.
- Workspace partition scans, latest-session fallback, or job merging.
- Relaxing the one-active-writable-Rescue-per-canonical-workspace policy.
- General refactoring of binding, job, broker, or hook infrastructure beyond
  the shared seams required above.
