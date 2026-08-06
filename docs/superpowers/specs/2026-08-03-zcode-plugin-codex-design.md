# ZCode Plugin for Codex Design

## Summary

`zcode-plugin-codex` is a native Codex plugin that lets a Codex user delegate reviews, repairs, and conversation handoff to ZCode. Codex remains the host that interprets the user's intent, owns permissions, tracks work, and presents results. ZCode is the external execution engine.

The first release reproduces the eight user-visible workflows from `codex-plugin-cc` as closely as the two hosts allow, while using Codex-native skills and hooks rather than copying Claude Code internals.

## Goals

- Publish eight Codex skills under the `$zcode:` namespace: `review`, `adversarial-review`, `rescue`, `transfer`, `status`, `result`, `cancel`, and `setup`.
- Preserve the arguments, outcomes, and foreground/background behavior of `codex-plugin-cc` unless a Codex- or ZCode-specific difference is documented here.
- Use ZCode Protocol directly so session creation, model selection, history import, progress, cancellation, and permission requests are real protocol operations.
- Keep orchestration reliable across Codex turns through durable, workspace-scoped tracked jobs.
- Support macOS, Linux, and Windows in the runtime and fake-protocol tests, with real ZCode qualification on macOS first.
- Ship as a Codex marketplace plugin owned by `vitry` and intended for the public repository `vitry/zcode-plugin-codex`.

## Non-goals

- Installing, upgrading, or authenticating ZCode on the user's behalf.
- Providing an npm or `npx` installer in the first release.
- Claiming real-CLI qualification on Linux or Windows before those platforms are exercised with ZCode 0.16.1 or newer.
- Reproducing Claude Code implementation details such as slash-command files, `AskUserQuestion`, Claude background Bash, or Claude's `Agent` tool.
- Providing an OS sandbox around ZCode. The integration mediates ZCode protocol permission requests but does not represent that mediation as kernel-level isolation.
- Cloning Codex tool state, hidden reasoning, or turn identifiers into ZCode during transfer.

## Reference Responsibilities

The implementation is a selective composition, not a wholesale fork of any one reference repository:

- `cc-plugin-codex` supplies the current Codex-host patterns: plugin packaging, skills, hooks, tracked jobs, session ownership, result routing, rendering, and built-in forwarding subagents.
- `codex-plugin-cc` defines the public eight-command behavioral contract.
- `zcode-plugin-cc` supplies the initial ZCode broker and protocol knowledge, updated for ZCode CLI 0.16.1.

Code reused or materially adapted from these repositories must retain Apache-2.0 notices and appropriate OpenAI, Sendbird, and ZCode-adapter attribution.

## Architecture

The plugin has four layers with one-way dependencies. The companion talks to two
peer adapters: one for the Codex Host and one for the ZCode Engine.

```text
Codex user
    |
    v
Codex skills and hooks
    |
    v
Companion command interface
    |-- orchestration, tracked jobs, rendering, setup
    |-- Codex host adapter --> short-lived Codex app-server
    `-- ZCode adapter -----> ZCode broker / CLI 0.16.1+
```

### Plugin package

The distributable contains `.codex-plugin/plugin.json`, eight skill directories, Codex hooks, prompts, schemas, a Node.js companion runtime, and local marketplace metadata. Codex auto-discovers the default `hooks/hooks.json`; the optional manifest hook-path override is omitted. Skills are intentionally thin: they resolve the plugin root, validate user intent where interaction is necessary, invoke the companion, and faithfully present its output.

### Companion runtime

The companion is the deep module and stable integration boundary. Its public command interface covers setup, review, adversarial review, rescue/task execution, transfer, status, result, cancellation, and internal result routing. It owns argument parsing, prompt construction, foreground/background orchestration, durable state, ZCode adapter calls, and user-facing rendering.

Skill files do not know ZCode wire methods, broker framing, filesystem layouts, or permission request schemas.

### Codex host integration

Codex-native `SessionStart` records `session_id`; `UserPromptSubmit` records
`session_id`, Codex `turn_id`, workspace, and the documented `permission_mode`.
Supported permission values are `default`, `acceptEdits`, `plan`, `dontAsk`, and
`bypassPermissions`. `SubagentStart` provides the same permission field for
diagnostics, but a background job uses the immutable parent-turn snapshot stored
when that job was reserved. Missing hooks or unrecognized values produce an
`unknown` snapshot and never gain high-risk permission.

`UserPromptSubmit` writes a private active-turn record bound to the exact
`session_id`, `turn_id`, canonical workspace, permission mode, original prompt,
and expiry. The record key is derived from the exact session and workspace; it
is never a workspace-wide "current session" pointer. Hook output contains no
credential and the model never receives an authorization secret.

For Codex CLI 0.146, runtime prototyping observed that a normal Skill shell
child inherits `CODEX_THREAD_ID`, and that value matches the Codex session/thread
identity supplied to lifecycle hooks. This is a version-pinned, runtime-observed
dependency, not a claim that OpenAI documents the variable as stable. Every
Skill-facing command except setup resolves its caller from the ambient
`CODEX_THREAD_ID`, canonical working directory, and the matching private
active-turn record. Missing, malformed, expired, session-mismatched, or
workspace-mismatched state fails closed with setup/compatibility guidance.
Sibling sessions in the same workspace have disjoint records.

Skills invoke only a constant direct-companion command and do not interpolate
the user's prompt, task text, identifiers, or secrets into a shell command. The
companion obtains public command arguments from the hook-recorded original
prompt and parses them in Node without shell interpretation. For implicit Skill
activation, the Skill supplies only its constant command name and the original
prompt becomes review focus or Rescue task according to that command's grammar.
Optional status/result/cancel job IDs are likewise parsed from the saved prompt.

If the first invocation needs a wait/background or resume/fresh answer, the
companion stores the normalized command specification and task as a private
pending invocation bound to the exact session, workspace, and originating turn.
A later answer turn may invoke only a fixed enum action such as
`invoke-choice rescue resume`; the companion resolves the same session and
workspace, atomically consumes the one pending invocation, and rejects replay,
free-form replacement text, or sibling-session access.

Internal execution uses different, narrower authorization. Reserving a
background job generates a single-use execution capability bound to that job,
owner session, workspace, immutable permission snapshot, and normalized spec.
Production Node starts the background worker itself and supplies this capability
through a protected child-process channel; neither the Codex model nor a
forwarding subagent receives or retransmits it. The capability is consumed
atomically exactly once and cannot run a different job or select a different
session. A failed child launch may be retried only by production Node creating a
new capability for the same still-queued job.

Foreground work remains in the invoking turn. Background work is launched and
reaped by the companion runtime, and completion stays available through durable
status/result records without requiring a model to carry private capability
material.

Loop prevention and ownership checks stop assistant-to-assistant delegation cycles and prevent one Codex session from silently adopting another session's work.

The Codex host adapter is a separate, typed module used by Transfer and setup.
For each bounded operation it spawns `codex app-server` over stdio, performs the
`initialize` handshake, sends the requested method, enforces a 15-second default
timeout, and terminates the child. It does not attempt to attach to the app-server
that owns the current UI session.

### ZCode adapter

The adapter owns CLI discovery, broker startup, protocol transport, request correlation, asynchronous state notifications, permission replies, session lifecycle, and version-specific compatibility. The rest of the plugin consumes typed operations such as create session, send prompt, read session, resume session, stop session, set model, set thought level, and import history.

## Public Skill Contracts

### Review

```text
$zcode:review
  [--wait | --background]
  [--base <git-ref>]
  [--scope auto|working-tree|branch]
```

Review is always read-only. `auto` selects an appropriate Git comparison from repository state. If neither execution flag is supplied, the skill may estimate the review size and ask whether to wait or run in the background, matching upstream behavior.

### Adversarial review

```text
$zcode:adversarial-review
  [--wait | --background]
  [--base <git-ref>]
  [--scope auto|working-tree|branch]
  [review focus...]
```

Adversarial review is always read-only and emphasizes hidden failure modes, unsafe assumptions, and counterexamples. Free text after the flags narrows the review focus.

### Rescue

```text
$zcode:rescue
  [--background | --wait]
  [--resume | --fresh]
  [--model <provider/model|alias>]
  [--effort none|minimal|low|medium|high|xhigh]
  <task...>
```

Rescue may modify the workspace. It runs in the foreground unless `--background` is explicit. `--wait` is accepted as an explicit foreground choice for upstream compatibility. If a resumable ZCode session exists and neither `--resume` nor `--fresh` is supplied, the skill asks the user which behavior they want. A resume candidate must be the newest job in the same workspace, owned by the same Codex session, created by `rescue`, and contain a ZCode session ID. Review and Transfer sessions are never implicit Rescue candidates.

The Codex-specific `spark` alias is not supported. The model argument must be a configured alias, a precise ZCode model identifier, or `provider/model`.

### Transfer

```text
$zcode:transfer [--source <codex-thread-id>]
```

Without `--source`, transfer reads the current Codex thread. In this plugin, `--source` deliberately means a Codex thread ID rather than a Claude JSONL file. This is the only intentional reinterpretation of an upstream public argument.

The source thread is explicit `--source` when provided; otherwise it is the
exact session ID from the validated active-turn record. The adapter starts
a short-lived `codex app-server`, initializes it, and calls `thread/read` with
`{threadId, includeTurns: true}`. An explicit ID is visible only if that
app-server can read it from the same Codex home; a missing, unknown, inaccessible,
or ephemeral-only thread is a configuration error and no ZCode session is
created.

The runtime converts ordered user and assistant text and passes it to ZCode's
`session/create.importedHistory`. It does not parse the hook transcript file
because that format is documented as unstable.

ZCode 0.16.1 accepts only `claudeCode` as the imported-history source discriminator. The adapter contains that compatibility value in one place, while user-facing output labels the session as imported from Codex. Transfer returns the created session ID and a resume command using the resolved ZCode launcher.

### Job inspection and control

```text
$zcode:status [job-id] [--wait] [--timeout-ms <milliseconds>] [--all]
$zcode:result [job-id]
$zcode:cancel [job-id]
```

`status` reads durable job state. With `--wait`, it requires a job ID and polls
until the job reaches a terminal state or the timeout elapses. The default wait
timeout is 240,000 ms. Supplying `--timeout-ms` without `--wait`, a non-finite
value, or a negative value is a configuration error. `result` renders the stored
complete result; for an unfinished job it reports the state and exact follow-up
command.

`cancel` atomically changes an active job to `cancelling`, calls ZCode
`session/stop`, and marks it `cancelled` only after ZCode acknowledges the stop or
session reconciliation proves it has stopped. If the stop request fails while
the session may still be active, the job returns to `running` with
`lastCancelError`; the command fails and never reports successful cancellation.
Cancelling an already terminal job is idempotent and reports its actual state.

When no job ID is given, status selects the newest owned job, cancel selects the
newest owned job whose state is `queued`, `running`, or `cancelling`, and result
selects the newest owned `succeeded` job that has a complete result artifact. An explicit job ID retains
the command's existing semantics, including reporting a terminal or unfinished
record rather than silently selecting another job. Every selection is confined
to the exact Codex session and workspace. `--all` on status includes all jobs
visible to that workspace while clearly marking ownership.

### Setup

```text
$zcode:setup [--enable-review-gate | --disable-review-gate]
```

Setup discovers the CLI, validates its version and ability to run, reports
authentication readiness, and controls the optional review gate. Native hooks
remain inside the active marketplace plugin cache and are never copied or edited
by setup. Setup may enable Codex's stable `features.hooks` gate and, after
verifying that the hook source belongs to this active plugin, trust the exact
current hook hashes through Codex app-server `config/batchWrite`. It removes no
unrelated hook source and reports when a Codex restart is required.

Setup never downloads ZCode, alters ZCode authentication, silently changes the
configured model, or writes the removed `features.plugin_hooks` setting.

No first-release public command exposes `--force`, `--prompt-file`, or `--write`. These remain internal concerns unless a later user-facing requirement justifies them.

## Execution Flows

### Foreground review or rescue

1. The Skill runs a constant `invoke <command>` direct-companion command. The companion resolves the exact active-turn record and parses the original prompt without shell interpolation.
2. If a choice is required, the companion saves a normalized pending invocation; a later turn supplies only a fixed enum through `invoke-choice`, which atomically consumes the same-session pending record.
3. The companion snapshots Codex thread, workspace, and current-turn permission information.
4. It reserves a tracked job before starting ZCode.
5. The adapter creates or resumes a ZCode session, applies model and thought-level settings, and sends the generated prompt.
6. ZCode permission requests are answered through the headless permission policy.
7. The companion follows state notifications until completion, persists the result, transitions the job atomically, and renders the output.

### Background work

1. The parent turn reserves a job and the production companion starts a detached worker.
2. Reservation creates a single-use execution capability bound to the job, owner, workspace, operation, and captured permission snapshot.
3. Production Node passes the capability through a protected child-process descriptor and reaps/escalates the child on launch failure; no model or subagent handles the capability.
4. Status and result remain queryable even if the originating turn ends.
5. Completion is routed once to the owning Codex session; unread results remain durable.

### Transfer

1. Resolve the current or explicitly named Codex thread through app-server.
2. Select ordered user and assistant turns and convert supported text content.
3. Create a ZCode session with imported history and no fabricated prompt standing in for the conversation.
4. Persist the transfer record and return a usable ZCode resume command.

## Tracked Job Model

Each companion run has a durable record:

```text
TrackedJob
  id
  command: review | adversarial-review | rescue | transfer
  status: queued | running | cancelling | succeeded | failed | cancelled
  zcodeSessionId?
  codexThreadId
  ownerSessionId
  workspace
  readOnly
  permissionSnapshot
  model?
  effort?
  inputId?
  startRevision?
  beforeMessageIds?
  createdAt
  startedAt?
  finishedAt?
  promptArtifact?
  resultArtifact?
  error?
```

State changes are atomic and validated. Terminal jobs never return to a running
state. `cancelling` is nonterminal; a failed stop may transition it back to
`running` while recording `lastCancelError`. Every foreground or background
Review, Adversarial Review, Rescue, and Transfer worker acquires and durably
claims an exact worker lease before discovery, history reads, Git inspection, or
ZCode session work. Foreground work therefore also receives a job record so
interruption does not erase its outcome. Multiple read-only reviews may coexist
in one workspace; only one writable rescue may run there by default to prevent
concurrent edits.

For every accepted ZCode turn, the job persists the minimum recovery boundary:
the `inputId`, accepted state revision, and the set of assistant message IDs
visible before send. On the next start, status, result, or cancel invocation,
the companion locks each owned nonterminal job, reconnects the broker, restores
ownership, and reconciles through `session/read` and, when needed,
`session/list`. A remotely completed turn with a complete boundary extracts only
assistant output beyond that boundary, writes the result artifact, and becomes
`succeeded` even if local status was `cancelling`. A remotely paused/stopped turn
becomes `cancelled`; a proven missing or terminal-error session becomes
`failed`. Known active or protocol-ambiguous sessions receive a best-effort
`session/stop`; only an acknowledged stop permits terminalization. If stop is
not acknowledged, recovery retains the nonterminal job and writable guard with
a bounded error so a later cancellation can retry. A live exact lease is never
reconciled away; an orphan claimed queued job fails safely, while a legacy
lease-less queued record receives a conservative bounded stale grace period.
Orphan Transfer jobs stop a known imported session before failing; without a
known session they may fail safely because no mutating turn was sent.

## Model and Thought-Level Selection

Model resolution order is:

1. Explicit `--model`.
2. Plugin workspace configuration.
3. ZCode's current default.

Private workspace configuration stores an optional default and aliases as
`defaultModel` plus `models.<alias> = {providerId, modelId, variant?}` beneath
that canonical workspace's plugin data directory. Setup may write these values
only from explicit setup input or the documented
`ZCODE_SETUP_DEFAULT_MODEL`/`ZCODE_SETUP_MODEL_ALIASES_JSON` environment
variables; run
commands always read the persisted workspace configuration and do not treat a
process-only `ZCODE_MODEL_ALIASES` value as runtime configuration. An explicit `provider/model`
splits at the first slash; an unqualified value must match a configured alias or
an exact model ID advertised by the current ZCode registry. The resolved
`{providerId, modelId, variant?}` is supplied on `session/create`; resumed
sessions use `session/setModel` when a change is requested. Model choice is never
represented only as prompt text.

The accepted public effort tokens are sent as the same lowercase thought-level
ID after case-insensitive matching against the selected model's advertised
`thoughtLevels`. There is no guessed cross-provider translation: if `none`,
`minimal`, `low`, `medium`, `high`, or `xhigh` is not advertised, the companion
fails before the first prompt and lists the available levels. The matched value
is applied with `session/setThoughtLevel`. The runtime does not silently
downgrade or ignore either model or effort.

After `session/setModel`, the adapter requires the response's current model to
exactly equal the requested provider/model/variant tuple. After
`session/setThoughtLevel`, it requires the returned current level to equal the
advertised requested level case-insensitively. A missing or mismatched current
value fails before `session/send`; an acknowledgement alone is insufficient.

## Permission Policy

ZCode's protocol-level permission request is not an OS sandbox. The plugin applies the following conservative policy:

| Companion run | Low risk | Medium risk | High or critical risk | Unknown |
|---|---:|---:|---:|---:|
| Review or adversarial review | deny mutation | deny | deny | deny |
| Writable rescue, normal Codex mode | allow | allow | deny | deny |
| Writable rescue, `bypassPermissions` turn | allow | allow | allow | deny |

Read-only review permits operations required to inspect the workspace but denies every request classified as mutating. A background job retains the permission snapshot from the turn that launched it; later Codex turns cannot implicitly elevate it. Missing, stale, or unrecognized permission information chooses the restrictive outcome.

The companion resolves the exact per-session, per-turn active record using the
runtime-observed thread ID and canonical workspace. Reserving a job copies that
record into the job before ZCode starts. Active records are keyed by the exact
session and workspace, not by a workspace-level latest pointer. Only the exact documented value
`bypassPermissions` enables the high-risk row; `default`, `acceptEdits`, `plan`,
`dontAsk`, `unknown`, or a snapshot from a different session/turn does not.

## Turn-end Review Gate

When enabled for a workspace, the gate runs from the Codex `Stop` hook and uses a
dedicated, foreground, read-only ZCode review with a bounded prompt and a
15-minute hook timeout. `UserPromptSubmit` records a Git working-tree fingerprint
before the turn in a baseline keyed by the exact `session_id` and `turn_id`.
`Stop` calls a private gate entrypoint with its hook JSON on stdin; that entrypoint
accepts only `hook_event_name: "Stop"`, atomically consumes the matching baseline,
and never accepts a caller-context or job-execution capability. It compares the
baseline with the current fingerprint and skips ZCode when there were no net
tracked or untracked changes or no baseline exists.

The gate is suppressed for plugin-owned background workers, externally hosted or
nested sessions, and a `Stop` continuation already created by this gate. It also
records a run ID and the before/after fingerprints so the same session, turn, and
fingerprint pair cannot trigger a duplicate review. Active Companion jobs are
reported to Codex but do not by themselves block the turn.

The gate prompt requires a first semantic marker of `ALLOW:` or `BLOCK:`.
`ALLOW:` lets the turn end. `BLOCK:` returns Codex's `Stop` decision
`{"decision":"block","reason":"..."}` so Codex continues the turn with the
findings. Empty, malformed, failed, or timed-out ZCode reviews block conservatively
and direct the user to `$zcode:review --wait` or to disable the gate. A missing,
outdated, or unauthenticated ZCode installation is treated as setup-not-ready:
the hook emits setup guidance, records a skipped result, and fails open so a
broken optional integration cannot trap every Codex turn.

## Runtime Discovery and Lifecycle

The CLI discovery order is:

1. Explicit plugin configuration.
2. `zcode` on `PATH`.
3. platform-standard installation locations.
4. on macOS, `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`.

The runtime requires ZCode CLI 0.16.1 or newer. Discovery results may be cached with their version and observation time, but every launch verifies that the resolved target still exists. A JavaScript entrypoint is launched through the current Node executable; a native executable is launched directly.

The broker starts lazily for the first active session and is reused while healthy. Codex lifecycle hooks release session ownership and stop an idle broker. Cleanup must not stop sessions or jobs owned by sibling Codex sessions. After an abnormal exit, the next start, status, result, or cancel invocation reconciles owned nonterminal jobs, including jobs left in `cancelling`, from persisted worker leases, turn boundaries, and ZCode session state while holding the job's recovery/cancellation lock. Unsafe ambiguity retains the job guard until remote terminal/missing proof or acknowledged stop.

## Local Storage

Plugin state lives under a user-level Codex data location and is partitioned by a stable workspace key:

```text
zcode-plugin-codex/
  config.json
  workspaces/<workspace-key>/
    jobs/
    prompts/
    results/
    logs/
  runtime/
```

No job record, session ID, prompt, result, or runtime log is written into the user's repository. Writes use temporary files plus atomic rename where the platform supports it. Logs redact known authentication fields, tokens, sensitive environment variables, and permission payload secrets.

## Error Model

Errors have a stable category, code, concise message, actionable remedy, and preserved diagnostic cause:

- Environment: CLI missing, version below 0.16.1, Node unavailable, or ZCode not authenticated.
- Configuration: conflicting flags, unknown model, unsupported thought level, or invalid source thread.
- Session: broker start, create, resume, send, read, import, or stop failure.
- Policy: a ZCode operation was rejected by the captured headless permission policy.
- Task: ZCode ran normally but reported that the requested work failed.
- Plugin: corrupt job state, ownership inconsistency, invalid state transition, or unrecoverable broker bookkeeping.

Starting ZCode successfully does not mark a job successful. A job succeeds only after the protocol reports completion and its result is persisted. Cancellation is distinct from failure. Rendering includes exact recovery commands where a retry, setup run, status lookup, or result lookup is appropriate.

## Testing Strategy

### Unit tests

Cover argument parsing, conflicting flags, the 240-second wait default, model and
alias resolution, advertised thought-level validation, permission snapshot
capture, permission decisions, workspace keys, resume-candidate filtering,
ownership, cancellation transitions, CLI discovery, version comparison, log
redaction, and error rendering.

### Protocol tests

A deterministic fake ZCode broker covers `session/create`, `session/send`, `session/read`, `session/resume`, `session/stop`, `session/list`, `session/setModel`, `session/setThoughtLevel`, permission requests, completion notifications, disconnects, malformed messages, and imported history.

### Integration tests

Exercise all eight public skills through ordinary direct-companion stdio,
foreground and production-launched background execution, resume and
fresh selection, concurrent read-only work, writable-job exclusion, status
waiting and timeout validation, result persistence, acknowledged and failed
cancellation, transfer from a fake Codex app-server, native hook trust setup,
review-gate allow/block/skip/deduplication paths, and broker recovery. A dedicated
test interleaves `SessionStart` and `UserPromptSubmit` for two Codex sessions in
the same workspace and proves that Transfer, permission snapshots, resume
candidates, status defaults, result defaults, and cancellation never cross the
active-turn boundary. Tests also prove absent/mismatched `CODEX_THREAD_ID` fails
closed, same-workspace sibling sessions cannot consume each other's active or
pending invocation, and original task metacharacters never enter shell parsing.
Internal authorization tests reject a forged job ID, an
execution capability used with another session or workspace, a second
consumption of the same capability, and Stop input whose session/turn does not
match the atomically consumed gate baseline.

### Real end-to-end tests

The first release qualifies macOS against ZCode Desktop 3.6.5 with bundled CLI 0.16.1 or a newer compatible installation. Tests verify discovery, authentication diagnostics, a read-only prompt, explicit model selection through the complete companion `--model` path, cancellation, and imported history without relying on a particular model's prose. The release E2E requires a non-empty `ZCODE_REAL_E2E_MODEL`; an unauthenticated, unavailable, or credit-exhausted local runtime reports itself explicitly as unqualified and is never counted as a pass.

The marketplace integration installs the production snapshot, confirms the
Skill through real `codex app-server`, executes the installed hook, and invokes
the installed companion over ordinary stdio with the observed thread identity.
An opt-in authenticated `codex exec` test proves an actual model-driven Skill
call when the environment is eligible. The 2026-08-06 local prototype reached
`thread.started` but was unqualified before Skill execution because the Codex
workspace was out of credits; this is recorded as evidence, not a success.

CI runs fake-protocol tests on macOS, Linux, and Windows. Documentation describes Linux and Windows as code-supported but not real-CLI-qualified until matching end-to-end environments exist.

## Acceptance Criteria

- A marketplace-installed plugin exposes all eight `$zcode:*` skills.
- A marketplace-installed Skill invokes the companion through ordinary stdio; no public contract depends on caller-created file descriptors or a model-visible secret.
- Each public argument above is parsed and behaves as specified.
- Review modes cannot approve a mutating ZCode permission request.
- Rescue defaults to foreground and persists both foreground and background jobs.
- `--model` changes the actual ZCode session model on CLI 0.16.1 or fails explicitly.
- Transfer imports ordered Codex user and assistant turns into a resumable ZCode session.
- Status, result, and cancellation survive a new Codex turn and process restart.
- Sibling Codex sessions cannot steal ownership or terminate one another's active work.
- Two interleaved Codex sessions in one workspace resolve their own Transfer source and permission snapshot from exact hook state plus runtime-observed `CODEX_THREAD_ID`, without a workspace-wide latest marker.
- Background execution consumes a single-use job capability wholly inside production Node; forged, cross-owner, replayed, or model-forwarded capabilities are rejected.
- The Stop gate consumes only the exact session/turn baseline identified by its Codex hook input.
- A failed `session/stop` cannot make a potentially running job appear cancelled.
- The optional Stop review gate runs only for a changed, user-driven parent turn and implements the documented allow, block, skip, failure, and deduplication behavior.
- Missing, outdated, or unauthenticated ZCode installations produce actionable setup diagnostics.
- Unit, fake-protocol, and integration suites pass on macOS, Linux, and Windows; the documented macOS real E2E suite passes before release.
- Package metadata names `vitry`, Apache-2.0 licensing is present, and required provenance is recorded in `NOTICE`.
