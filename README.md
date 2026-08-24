# ZCode for Codex

ZCode for Codex is a native Codex marketplace plugin that delegates independent reviews, repairs, and conversation handoff to ZCode while Codex remains the permission-owning host.

[简体中文](README.zh-CN.md)

## Requirements and installation

- Codex with native plugins and hooks enabled.
- ZCode CLI `>=0.16.1`, installed and configured for at least one model.
- Node.js `>=22.13.0` (the plugin packages its production native lock dependency).

Install from the production snapshot published on this repository's `marketplace` branch; the source-code root on `main` is not itself a marketplace catalog:

```bash
codex plugin marketplace add vitry/zcode-plugin-codex --ref marketplace
codex plugin add zcode@vitry
```

The release workflow builds `.agents/plugins/marketplace.json` plus `plugins/zcode/` with production dependencies on that branch. Restart Codex after installation so the plugin itself is loaded, then run `$zcode:setup` in the target workspace. Setup normally reconciles the managed Role in that one run. On the first run, setup may instead add the marketplace-qualified plugin data directory to Codex's writable roots; this writable-root bootstrap is the only separate setup restart case, so if it reports `restart-required`, restart Codex and rerun `$zcode:setup`. Do not copy hooks out of the installed plugin cache.

Discovery checks `ZCODE_PATH`, `zcode` on `PATH`, platform locations, and on macOS the bundled `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`. Setup reports missing, outdated, unconfigured, unauthenticated, or untrusted installations; it does not download ZCode, configure a provider, or sign in for you.

ZCode Desktop and ZCode CLI keep model-provider settings separately. Configure a model provider in ZCode CLI itself before running `$zcode:setup`; a provider configured only in Desktop is not sufficient for `zcode app-server`. API-key users do not need an OAuth login when an API-key provider is configured in the CLI. The plugin does not read or copy Desktop provider settings or API keys, and it never logs or persists those keys.

## Commands

| Skill | Purpose |
|---|---|
| `$zcode:review [--wait \| --background] [--base <ref>] [--scope auto\|working-tree\|branch]` | Read-only code review. |
| `$zcode:adversarial-review [--wait \| --background] [--base <git-ref>] [--scope auto\|working-tree\|branch] [review focus...]` | Read-only challenge review for assumptions and hidden failures. |
| `$zcode:rescue [--background \| --wait] [--resume \| --fresh] [--model <provider/model\|alias>] [--effort none\|minimal\|low\|medium\|high\|xhigh] <task...>` | Delegate investigation or edits; foreground by default. |
| `$zcode:transfer [--source <codex-thread-id>]` | Import visible Codex turns into a resumable ZCode session. |
| `$zcode:status [job-id] [--wait] [--timeout-ms <milliseconds>] [--all]` | Inspect durable jobs; wait defaults to 240 seconds. |
| `$zcode:result [job-id]` | With no ID, read the latest finished outcome owned by the current Codex session in this workspace; an exact job ID remains supported. Succeeded jobs return the exact stored result artifact, while failed or cancelled jobs return a bounded stored outcome or failure report. |
| `$zcode:cancel [job-id]` | Cancel an owned queued or running job. |
| `$zcode:setup [--enable-review-gate \| --disable-review-gate]` | Diagnose readiness and configure the optional review gate. |

No public command provides unrestricted execution shortcuts. Review commands are always read-only. Rescue can modify the workspace, but ZCode permission requests are evaluated against the initiating Codex turn: missing or unknown permission state is restrictive, and high-risk operations require Codex `bypassPermissions` mode. Background workers inherit the reservation snapshot and cannot elevate it later.

## Isolated Rescue role and inspection

`$zcode:setup` owns one digest-backed managed `zcode-rescue` Role under the stable plugin data root, not under a versioned plugin cache. It writes only the exact user-config Role registration and reconciles a fresh install or owned upgrade in one setup run. A proven numeric-v1 receipt is migrated in that same run. ZCode does not own `hide_spawn_agent_metadata`; the Codex host owns the collaboration tool schema, including whether `agent_type` is supplied. Setup only removes a legacy target-layer `false` when the numeric-v1 receipt, Role bytes, and exact registration prove that old ZCode setup wrote it. Setup never adopts or overwrites a collision: a foreign `zcode-rescue` registration, a project Role with the same name, or a higher-precedence override fails closed with a setup diagnostic. The receipt, Role file, and effective registration must all match exactly.

This release changes the managed Role bytes and therefore its managed Role digest. `role-status rescue` may report `upgrade-required`; rerun `$zcode:setup` after updating so the compatible owned Role upgrade is reconciled before Rescue is used.

A source checkout and an installed plugin use intentionally isolated namespaces: source development defaults to `zcode`, while an installed marketplace instance uses `zcode-<marketplace>`. Existing installed and source-development data remain unchanged in the same locations. The plugin does not merge, search, redirect, or copy state across the installed or source namespace boundary; a source checkout can still work when its own hook lifecycle has proved its own session.

On every owned parent turn, the owned `UserPromptSubmit` hook injects one machine-rendered, instance-bound launcher command derived from the exact plugin instance that executed the hook. Root and its Rescue child reuse those exact bytes and append only fixed Rescue arguments. They never construct a path from cwd or Skill prose, never call the direct companion form `node scripts/zcode-companion.mjs`, and never use PATH, a global package, or a cache search to select another plugin instance. This removes model-authored path selection without weakening instance or namespace isolation.

Rescue distinguishes the conversation's origin workspace from its execution workspace. When Root creates or enters a linked worktree during the same parent turn, the first trusted `prepare rescue` automatically binds execution there; no manual handoff is needed. The origin itself or a canonical linked-worktree top level is eligible only when it shares the same canonical Git common-dir. That target is immutable for the turn, so another worktree or an unrelated repository is rejected. Role inspection is read-only and a child cannot claim or change the target. Root `Stop`, a new prompt, and `SessionEnd` revoke or replace authority before cleanup across the origin and bound target.

`source-session-unproven` is terminal for that Rescue route: use the launcher from the active owned lifecycle context, but do not run `$zcode:setup`, prepare, follow up, or spawn from the unproven source checkout. A launcher error caused by a shell-unsafe install path is also terminal and provides a fixed reinstall remedy; reinstall the plugin to a shell-safe path and retry from a new owned parent turn. Neither condition authorizes a fallback launcher or automatic redirect.

Rescue has two equivalent entry forms. An explicit `$zcode:rescue` request is literal and applicable; Root may also choose Rescue proactively from the complete business objective. This is automatic routing and there is no `--auto` option. Explicit `--fresh` or `--resume` remains authoritative; clear proactive continuations materialize resume and clear independent work materializes fresh before any child starts.

Root starts `prepare rescue` on a raw-capable TTY. The companion enables raw mode before it emits the exact task-free readiness line; readiness is nonterminal. Only after that line does Root send one JSON line terminated by LF over private stdin, with no EOF or U+0004. The companion consumes that one frame, restores raw mode, and commits exact session, turn, workspace, and executor-bound prepared state. Non-TTY or raw-mode failure stops before task delivery and no child is spawned. Tool output never contains or echoes the payload; only the task-free readiness and final prepared acknowledgement cross back. The named Role and generic child then run the same constant `invoke-prepared rescue` forwarder, without receiving the task, options, capability, or authorization material. If an active `rescueChildId` already exists, Root rejoins and waits for that exact Rescue child instead of repeating preflight, preparation, spawn, or invocation.

The plugin's Companion, during preparation and before any replacement spawn, discovers the parent's persisted Codex children through the app-server's exact parent relationship query. The global thread listing omits restored children whose preview is empty, so it is never used to prove a spawn name is free. If the installed Codex line cannot prove support for the exact-parent API, preparation fails closed instead of retrying or guessing a spawn. An executor-backed stopped child keeps the normal Hook-proven recovery path. For compatibility with an older plugin, one exact unloaded, direct, named `zcode-rescue` child at a managed path may instead be adopted once even when its historical Hook executor no longer exists. The child is read again by its exact Codex ID, and the current parent turn, origin-to-execution worktree link, permission snapshot, and one-shot preparation are all re-proved before any job is reserved. The adoption is recorded explicitly; the plugin never fabricates a historical `SubagentStart`, executor, or route. Generic `default` compatibility still requires its real executor provenance. Unrelated `default` and `explorer` children are occupancy-only and cannot veto a valid Rescue candidate or grant follow-up authority. Ambiguous or contradictory evidence fails closed. Protocol versions are action-specific: follow-up directives are strict version two and carry the fixed assignment; spawn directives remain strict version one without an assignment, preserving named-to-generic schema negotiation. Root executes the selected task-free directive but does not discover or choose a child identity. An active Rescue child is rejoined through the existing active-child path. Neither 30-minute age nor a name or path collision is authority and neither authorizes recovery or replacement.

A durable Rescue binding now keeps one exact stopped Rescue child attached to one exact ZCode session. Its private `anchorJobId` identifies the adopted operation, and `currentJobId` advances when each continuation job is durably reserved and published, even if that job later queues, fails, or is cancelled; neither identifier is sent in a child message. A clear proactive continuation prepares resume and follows up the same stopped child, which runs the same `invoke-prepared rescue` assignment with no second `SubagentStart`. An explicit bound request without `--resume` or `--fresh` also follows up that same child and lets its bound `needs-choice` result drive the one user choice. `--fresh` always prepares a new independent ZCode operation, but it need not allocate a fresh Codex child: the planner may reactivate and follow up a qualified stopped Rescue child, preferring the managed base and then the deterministic newest compatible executor, and prescribes a spawn only when none exists. Reusing a Codex child does not resume its prior ZCode binding or session; the new operation creates a peer session with the current permission snapshot. A name or path collision is never authority for that choice.

Ordinary foreground Rescue completion has no plugin-defined wall-clock deadline. Active parent authority is lifecycle-bound rather than time-bound, so a clear continuation in that still-active parent turn can replace the consumed one-shot preparation with the next 30-minute generation, follow up the exact stopped child, and reuse the exact bound ZCode session. Caller credentials and every preparation generation remain bounded to 30 minutes: that TTL is only the one-shot capability window in which a prepared child may start, not a lifetime for the Codex child, the Rescue binding, or the ZCode operation. Request RPCs, the optional Stop review gate, qualification harnesses, and explicit status waits also retain finite budgets. Root `Stop`, a replacement `UserPromptSubmit`, `SessionEnd`, `$zcode:cancel`, `SIGINT`, and `SIGTERM` remain authoritative termination or revocation boundaries.

Legacy jobs-only state may adopt the exact eligible continuation candidate once; ambiguous or previously pending legacy state is rejected instead of guessed. A permission change cannot resume the old binding, while `--fresh` captures the current permission snapshot. `SessionEnd` closes the ending Codex session's Rescue binding so it cannot be revived. An invalid binding, executor mismatch, wrong workspace, closed session, or inconsistent provenance must fail closed without latest-session fallback. Because the managed Role bytes changed, `role-status rescue` can report `upgrade-required`; rerun `$zcode:setup` before continuing.

Foreground Rescue runs the constant forwarder in one native child thread. When the host supports `agent_type`, Codex selects the named `zcode-rescue` Role. A generic child is a host-only compatibility fallback permitted only when the active spawn schema omits `agent_type` or proves that field unsupported before any child starts; missing, shadowed, drifted, or foreign Role state is never fallback-eligible. The parent runs only the read-only Role preflight and private preparation rollout, shows native lifecycle activity, and returns the child's final public stdout; it does not execute Rescue inline or copy child stderr, tool output, raw conversation frames, or intermediate progress into the parent thread.

Role preflight uses fixed readiness vocabulary: `caller-unavailable` asks for an active owned parent turn, and `inspection-unavailable` asks to retry inspection without mutating setup. Managed states such as install, upgrade, drift, conflict, restart, or genuine host `unsupported` direct the user to `$zcode:setup`. Existing owned managed Role installations need the normal one-time `$zcode:setup` upgrade because these Role bytes changed.

Rescue children use the task-independent native display base `zcode_rescue_task`, with a bounded ordinal on sibling collision. No objective or task text is encoded in this metadata. Names and paths are for navigation only: matching `zcode_rescue_*` neither proves Rescue nor grants authority; a different display name does not remove authority from an otherwise trusted Rescue child.

Use `/agent` or `/subagents` to select the Rescue child and inspect its transcript. `/ps` is different: it lists background terminals owned by the currently active thread, so switch to the child first if a long-running yielded child terminal still exists. A short command may finish before appearing there. The operating-system `ps` command can show processes and argv, but not Codex model activity or thread transcripts. The noninteractive qualification harness does not expose these TUI events, so it emits the machine-readable scoped observation `{ "observed": false, "code": "tui-evidence-not-exposed", "qualificationScope": "tui" }`. That observation is not a qualification result and does not claim that the UI passed or failed.

The child subscribes to online conversation progress when ZCode supports it and structurally probes whether that subscription is actually delivering usable online frames. Allowlisted online tool activity may include a control-free, one-line command or search-query preview shortened to 96 characters. Truncation is not secret redaction: a secret placed in an online command or query can remain visible in the child transcript and durable status preview.

If accepted online frames remain unavailable, Rescue can fall back to already schema-validated session snapshots at no more than heartbeat frequency. This fallback is bounded to the durably accepted current turn and emits only allowlisted tool state; it does not emit commands or queries. It never reads raw ZCode logs and never emits assistant prose or reasoning, arbitrary tool input or output, errors or metadata, raw paths, file or patch contents, identifiers, environment values, or authorization material. Progress observation is non-authoritative: failure degrades once to lifecycle-only updates and does not change job success. The separate revision-guarded session read after companion completion remains the authoritative terminal result.

The selected Rescue child shows cc-style semantic progress derived from structured ZCode events. Root receives fixed coarse liveness updates, not raw child output. These updates keep the original child wait active but are observational only: progress and status never prove completion; the original foreground terminal exit and final stdout do. Raw PTY data, tool output, file contents, reasoning, credentials, and capabilities are never relayed to root.

Inside that selected Rescue child only, the exact trimmed spellings `zcode status`, `$zcode:status`, and `/zcode:status` inspect only the job bound to that child. This bound status sidecar accepts no job ID or option, cannot select another job, and never starts or replaces the original foreground execution. The public `$zcode:status` command listed above remains the owner-scoped control for ordinary durable jobs.

Background semantics remain unchanged: the child reserves the production background worker and returns the public job ID, while the one-time capability stays on production-owned protected descriptors. Use `$zcode:status`, `$zcode:result`, and `$zcode:cancel` for durable recovery. Ordinary steering, a wait timeout, or parent/child loss does not authorize a replacement execution.

Codex 0.147 is the only installed-host line pinned and targeted by this release's native Rescue qualification suite. Default CI replays sanitized captured 0.147 rollouts independently for both the named Role and generic fallback, including yielded foreground and same-child choice continuations. The authenticated live test still records only the one route Codex actually selects; it does not claim to exercise both routes in one live turn. A build is qualified only when the strict authenticated suite completes; a default machine-readable `unqualified` result is not compatibility evidence. No other Codex version is claimed compatible until its own installed qualification succeeds. Uninstalling the plugin does not automatically delete its stable private data, managed Role receipt/file, job history, or exact user-config leaves. Finish or cancel owned jobs first, then follow the receipt-gated [manual uninstall and residual-state cleanup guide](docs/manual-uninstall.md); never delete a colliding user or project Role.

## Models

Pass an advertised ZCode model as `provider/model`, an unambiguous exact model ID, or a configured alias. Model policy is private and scoped to the canonical workspace. Put the setup variables in the environment that launches Codex, then invoke `$zcode:setup` inside Codex:

```bash
ZCODE_SETUP_DEFAULT_MODEL=fast \
ZCODE_SETUP_MODEL_ALIASES_JSON='{"fast":{"providerId":"provider","modelId":"model","variant":"optional"}}' \
codex
# In the Codex session: $zcode:setup
```

Setup persists `$CODEX_HOME/plugins/data/zcode-<marketplace>/workspaces/<workspace-hash>/config/models.json` (the hook-provided `PLUGIN_DATA` resolves to the same root) with this schema:

```json
{"version":1,"defaultModel":"fast","models":{"fast":{"providerId":"provider","modelId":"model","variant":"optional"}}}
```

Resolution order is explicit `--model`, the persisted workspace default, then ZCode's own default. Runtime-only `ZCODE_MODEL_ALIASES` is ignored; aliases must be persisted through setup. The plugin verifies the exact model and advertised effort returned by ZCode before sending the task, so mismatches fail explicitly.

To verify configuration, rerun `$zcode:setup`, then run `$zcode:rescue --fresh --model fast <task>` and inspect the job with `$zcode:status <job-id>`.

## Jobs, Transfer, and review gate

Every run is reserved as a durable, owner-scoped job. Installed plugin state lives beneath `$CODEX_HOME/plugins/data/zcode-<marketplace>/workspaces/<workspace-hash>/` with private permissions; prompts, results, session IDs, and logs are never written into the repository or plugin cache. `$zcode:status`, `$zcode:result`, and `$zcode:cancel` work across later turns in the same Codex session, while sibling sessions cannot adopt a job.

`SessionEnd` performs best-effort settlement of the ending session's writable Rescue. A claimed queued reservation remains unchanged while its worker lease is held. If the process exits before settlement completes, a later Rescue uses a reservation-time crash fallback and may settle a provably orphaned writable job; settlement does not transfer ownership, and only the original owner can access its result. During this reservation-time crash fallback, a held exact worker lease keeps the writable guard in place. When the exact worker lease is free and the existing broker control channel is unavailable, `SessionEnd` or the next Rescue archives the orphan as `failed` and releases the writable guard. This is abandonment, not confirmed remote stop. On a reachable broker, an unacknowledged `session/stop` still keeps the writable guard. Other sessions can use `$zcode:status --all` only for redacted workspace inspection.

Foreground runs stream ZCode activity to the current terminal. If no new activity arrives, they emit a 20-second heartbeat so a long model or tool call remains visibly alive. Every accepted safe semantic progress event successfully dispatched by the existing bounded pipeline is also appended to a private, durable, human-readable `workspaces/<workspace-hash>/jobs/<job-id>.log`, beside `<job-id>.json`; the job's `progressPreview` remains only the last four events. The exact-owner detailed `$zcode:status <job-id>` displays progress previews, its phase and last activity time, plus `Log: <absolute-private-path>`. For example:

```text
$zcode:rescue --wait repair the failing tests
[zcode] ZCode started a tool call.
[zcode] Still waiting for ZCode; last activity 20s ago.

$zcode:status <job-id>
Status: running
Phase: running
Progress:
  - ZCode started a tool call.
Log: <absolute-private-path>
```

The per-job log may also store current-turn visible assistant text selected by the exact existing linkage rules and the authoritative final output. Raw command stdout/stderr, arbitrary tool payloads (input/output/errors/metadata), raw reasoning, file or patch contents, environment values, credentials, capabilities, and hidden messages are never directly ingested as log source fields. This allowlist is not a semantic secret-redaction boundary: if visible assistant or final text itself quotes or paraphrases sensitive material, that selected text is retained. Keep secrets out of visible model text and protect the private log accordingly. Logs and progress are observational and cannot establish or alter terminal authority.

Only the exact-owner detailed status exposes the private path. Compact lists, foreign `--all` projections, sibling sessions, the bound Rescue status sidecar, Root relays, and terminal notices do not expose `logFile` or a log path. The status grammar remains `$zcode:status [job-id] [--wait] [--timeout-ms <milliseconds>] [--all]`: there is no `--log` option or log-reading command. Logs use the existing durable retention and remain after uninstall or selective runtime cleanup; there is no rotation, expiry, pruning, per-log delete, export, or search. They are deleted only by proven plugin-owned workspace-data erasure.

Background jobs have a separate lifecycle: ending the launching foreground command or Codex turn does not automatically cancel them. Use `$zcode:status <job-id>` to inspect one and `$zcode:cancel <job-id>` for explicit cancellation; ownership remains limited to the Codex session that reserved the job.

On supported foreground paths, `SIGINT` and `SIGTERM` are observed at safe protocol boundaries. Before a ZCode session exists, interruption cancels the queued reservation. Once the exact persisted ZCode session ID exists, the plugin sends `session/stop` only for that session. A confirmed stop durably marks the job cancelled; if `session/stop` fails or times out, the job remains running with the cancellation error available through status so cancellation can be retried. This is intentionally a session-level boundary: the plugin does not claim to stop or kill arbitrary detached grandchildren created by ZCode or nested tools.

Transfer reads a persisted Codex thread through `codex app-server` and imports only ordered visible user/assistant text. It does not transfer hidden reasoning, tools, permissions, or ZCode job ownership.

The optional Stop review gate runs a bounded foreground read-only review only after a changed, user-driven parent turn. Enable or disable it with `$zcode:setup`; a Codex restart may be required. Missing, outdated, or unauthenticated ZCode fails open with setup guidance. Once a review session starts, malformed, failed, or timed-out review output blocks conservatively.

## Troubleshooting and platform status

- `ZCODE_NOT_FOUND` / `ZCODE_VERSION_UNSUPPORTED`: install or upgrade ZCode, set `ZCODE_PATH` if needed, then run `$zcode:setup`.
- `INTERNAL_AUTHORIZATION_INVALID`: restart Codex, verify plugin hooks are enabled/trusted, and run `$zcode:setup`; never paste a caller-context token into a command.
- `model_config_missing`: configure a model provider in ZCode CLI itself, then rerun setup. Desktop provider settings are separate; an API-key provider does not require OAuth.
- Authentication unavailable for the configured CLI provider: authenticate with ZCode itself, then rerun setup.
- Background work: use `$zcode:status <job-id> --wait`, `$zcode:result <job-id>`, or `$zcode:cancel <job-id>` exactly as reported.
- Hook trust or restart required: let setup trust only this installed plugin's exact hook hashes, restart Codex, and rerun setup.
- `plugin-data-root-added`: setup added the stable plugin data root to Codex configuration without writing plugin state; restart Codex and rerun setup.

macOS with ZCode Desktop 3.6.5 and CLI 0.16.1+ is the release qualification target. The protocol client handles the string-ID runtime-preference server request sent by CLI 0.16.1. Before marking a release qualified, run the complete strict command on a machine with a working CLI model provider and authenticated Codex credits: `ZCODE_CODEX_SKILLS_E2E=1 ZCODE_CODEX_RESCUE_E2E=1 ZCODE_REAL_E2E=1 ZCODE_REAL_E2E_MODEL='provider/model' npm run test:qualification-required`. `ZCODE_REAL_MODEL` remains a deprecated alias; when both variables are non-empty, a conflict fails closed unless their trimmed values are exactly equal. The default `npm run test:qualified` is an opt-in diagnostic whose structured `unqualified` skips keep ordinary CI portable and are not qualification evidence. The required script turns missing opt-ins, provider configuration or authentication, model, credits, and other unqualified runtime results into a nonzero failure. The scoped `tui-evidence-not-exposed` observation is not a runtime qualification result and never claims UI qualification. An unknown execution failure also remains a test failure. Linux and Windows are code-supported by fake-protocol CI, but are not real-CLI qualified yet.

## License and provenance

Licensed under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for OpenAI Codex, `codex-plugin-cc`, Sendbird/ZCode adapter, and `zcode-plugin-cc` provenance.
