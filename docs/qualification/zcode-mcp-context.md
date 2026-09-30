# Codex MCP Invocation Context Qualification

## 0.155.1 requalification (current)

Status: **authority namespace NOT qualified on 0.155.1; lifecycle re-characterized; Task 4 stays blocked.** The amended app-server probe separated the two variables the 0.154.0 runs had confounded — Skill resolution and model MCP-tool selection — and proved the first: the installed probe Skill resolves through the Host's own `skills/list` and is injected as a structured Skill input item. The second did not follow: the app-server model made zero probe MCP calls in BOTH the structured-Skill treatment turn and the text-only control turn, so the authority gate never opened and `qualification/mcp-context.json` remains absent. The `mcpServer/tool/call` transport control recorded only an error result of undetermined origin (diagnostic; see below), never authority or lifecycle evidence. The explicit-interrupt dimension also stays unproven: the held call never became durable, so under the amended discipline `turn/interrupt` was NOT sent at all. `qualification/mcp-lifecycle.json` records the five honest 0.155.1 observations with `selectedStrategies` unchanged (`explicitInterrupt: release-blocked` re-frozen per this run's evidence). This section contains no identity values; only field names, JSON types, method shapes, and observations.

- Date: 2026-09-21
- Host under test: `codex-cli 0.155.1` (arm64 macOS). The default launcher (`~/.local/bin/codex`, symlinked to the standalone `current` release) was canonicalized with `realpath`, pinned by device/inode, and re-version-checked before every spawn. The source home was only read for a mode-0600 `auth.json` copy into each isolated home.
- Probe harness: `tools/mcp-context-probe/` as amended for 0.155.1 — bounded `skills/list` Skill resolution (probe workspace, `forceReload: true`) with a pure fail-closed resolver; the structured `{type:'skill', name, path}` treatment turn input alongside the existing compliance-voice text; the historical text-only control capture turn whose captures never feed the authority gate; the diagnostic-only `mcpServer/tool/call` transport control; the durable-hold-gated `turn/interrupt` discipline (interrupt only after `hold_for_lifecycle` durably enters the handler; handler cancellation never inferred from `turn/completed.status === 'interrupted'`); streamed delta notifications counted redacted without retention; and a 900-second Host conversation outer deadline. Unit-covered by `tests/mcp-context-probe.test.mjs`, gated by `tests/e2e/codex-mcp-context-e2e.test.mjs`.
- Request shapes verified against the pinned binary's generated app-server JSON Schema and live: `skills/list` `{cwds, forceReload}` → `{data:[{cwd, errors, skills:[{name, path, enabled, pluginId, …}]}]}`; Skill input item `{type:'skill', name, path}`; `turn/start` `{threadId, input:[…]}`; `turn/interrupt` `{threadId, turnId}`; `mcpServer/tool/call` `{server, threadId, tool, arguments?}` → `{content, isError?, structuredContent?}`.
- Result records: `qualification/mcp-context.json` (absent — context not qualified) and `qualification/mcp-lifecycle.json` (status `characterized`, `codexVersion` `codex-cli 0.155.1`), reduced from one durable event log (113 events, 7 phases, 6 captures — the scripted matrix's five plus the Root resume — 4 held calls, 21 recorded equality facts, and exactly five durable `app-server-control` events — the five controls' count is the only delta from the earlier-revision run's 108) under a single per-run nonce.

### Outcome

Five of six context assertions true; `identityNamespaceQualified` false:

| Assertion | Outcome |
|---|---|
| `identityFieldsVisible` | true |
| `identityNamespaceQualified` | **false** |
| `laterTurnDistinct` | true |
| `concurrentChildrenDistinct` | true |
| `metadataChangesAcrossTurns` | true |
| `serverLoadedWithConfig` | true |

No authority field path is recorded (`authorityFields` are null for Root thread, Child thread, and turn): the app-server capture-evidence gate never opened because the bounded structured-Skill treatment turn — although it COMPLETED — durably produced zero probe MCP captures. Zero winners means `qualification/mcp-context.json` stays absent; no path was guessed.

### The three-way Skill-resolution / tool-selection distinction

The 0.154.0 failure ("the app-server model never invoked the probe MCP tool") mixed two variables. This run separates them:

1. **Skill resolution (explicit structured injection): proven at the schema/transport level.** A bounded `skills/list` request over the probe workspace with `forceReload: true` resolved the installed probe Skill by its exact host-reported name and path; the treatment turn's input carried the compliance-voice text item plus the structured `{type:'skill', name, path}` item, so app-server injected the full Skill instructions. The turn completed without protocol error.
2. **Marker-only resolution (text-only control): recorded as its own observation.** The control turn sent the historical text-only shape (the `$zcode-mcp-context-probe:context` marker in the prompt alone) on a separate thread and also completed.
3. **Model MCP-tool selection on the app-server path: absent in BOTH turns.** The structured turn and the control turn each produced zero durable `capture_context` calls (the transcript-level MCP engagement counts were zero in both windows). The structured injection changed nothing about tool selection.

Consequence: on 0.155.1 the app-server-path blocker is the model's MCP-tool selection itself, not Skill delivery. The same prompts and the same fixture achieve full exec-path compliance in the same run (the scripted matrix's five captures plus the Root-resume capture, all settled), so prompt voice, fixture packaging, descriptor loading, and server health are all ruled out as the explanation. The authority join therefore remains bounded by app-server-path model behavior, exactly as the 0.154.0 baseline recorded — now with the Skill-resolution hypothesis experimentally excluded.

### Transport control (diagnostic only)

One bounded `mcpServer/tool/call` sent `capture_context` directly through app-server for the configured probe server on a dedicated thread. Observed outcome: **`error-result-undetermined-origin`** — the call returned an error result with no durable capture, and the driver retains no response content, so the error's ORIGIN is undetermined: a handler-generated error is indistinguishable from a host-generated refusal wrapped in a success frame. (The probe handler has no deliberate fail-closed-on-identity gate: reached with incomplete metadata, a `capture_context` fails at durable-append validation and returns an error result without a durable capture — indistinguishable, without retained content, from a host refusal; reached with complete metadata it would have produced a durable capture. No shape here attributes the error to the handler.) What this control proves is only that app-server accepts and answers a direct `mcpServer/tool/call` for the configured server; transport-level reachability of the SERVER (not the handler) is separately supported by the durable `server-started` events in the same phase window, and handler reachability remains unproven. Per the decision rules it cannot substitute for the Skill entry point: it is not a model turn, its metadata is never treated as an active model turn, it fed no equality fact and no lifecycle case, and it cannot satisfy the authority gate.

### Equality matrix (no app-server winner, again)

- **Hook-authority columns (all proven true from the exec windows, replicating 0.154.0 exactly):** Root — envelope `threadId`, inner `session_id`, and inner `thread_id` all equal the hook session id; inner `turn_id` equals the hook turn id. Child — envelope `threadId` and inner `thread_id` equal the hook `agent_id` (the spawn handle is the child thread id); inner `session_id` equals the hook session id; inner `turn_id` equals the hook turn id. The cross contrasts (envelope `threadId` vs hook session id, inner `session_id` vs hook `agent_id`, inner `thread_id` vs hook session id) are false.
- **App-server-authority columns (fact-less):** every `appServerThreadId` and `appServerTurnId` cell is false because the capture-evidence gate never opened — the structured-Skill treatment turn produced no attributable captures. These cells are fact-less false, not contradicted.
- **Returned-Child-handle column (fact-less):** handle facts are recorded only inside the capture-evidence branch, so no handle fact was fabricated.

### Lifecycle characterization (all five cases; honest observations)

| Case | hostProcess | turnTerminalStatus | toolCallOutcome | handlerSettlement | transportState | hookEvent | unknownReason |
|---|---|---|---|---|---|---|---|
| `appServerTurnInterrupt` | running | completed | not-observed | not-observed | open | stop | host-omitted-event |
| `cliSigint` | exited-clean | not-observed | pending | not-observed | server-exited | session-end | process-exited-first |
| `cliSigkill` | exited-signal | not-observed | pending | transport-close | stdin-eof | not-observed | none |
| `pluginToolTimeout` | exited-clean | not-observed | failed | not-observed | server-exited | stop | process-exited-first |
| `directConfigToolTimeout` | exited-clean | not-observed | failed | not-observed | server-exited | stop | process-exited-first |

Reading of each case:

1. **`appServerTurnInterrupt` (amended discipline).** The held turn carried the structured Skill treatment alongside its text; the model never invoked `hold_for_lifecycle`, so no held call became durable within the bounded durable-start wait. Under the amended discipline `turn/interrupt` was **NOT sent** (no durable held call to interrupt — interrupting would only characterize a rejection against a live or terminal turn). The held turn ran to its own terminal `completed` state, the app-server session stayed `running`/`open` throughout, and a `Stop` hook fired in the window. The explicit-interrupt dimension stays unproven on this host: no abort settlement, no interrupted-turn shape, and not even a held call to interrupt.
2. **`cliSigint`.** Same shape as 0.154.0: SIGINT to the pinned Host PID exited the Host cleanly inside the 10-second window with no durable settlement, the `SessionEnd` hook fired, and the phase's server had already exited — cancellation is still not delivered to a pending stdio handler on this path.
3. **`cliSigkill`.** Same shape as 0.154.0: SIGKILL orphans the stdio server, whose own stdin-EOF watcher settles the held call durably as `transport-close` and exits.
4. **`pluginToolTimeout` (2-second plugin fixture).** Same shape as 0.154.0: clean Host exit inside the 30-second ceiling, the nested `mcp_tool_call` item rendered as failed in the transcript, and no handler notification — no abort, no transport close.
5. **`directConfigToolTimeout` (2-second direct `[mcp_servers.*]` config, skill-only fixture).** Identical to the plugin fixture on 0.155.1 as on 0.154.0: direct configuration versus plugin descriptor loading still makes no behavioral difference for tool-timeout cancellation.

### Gate outcomes (decision rules)

- **Authority gate: NOT proven.** The model-driven structured-Skill app-server path did not create attributable Root+Child MCP captures (`identityNamespaceQualified` false via the structured path; zero attributable captures at all). The `mcpServer/tool/call` control cannot satisfy this gate. `qualification/mcp-context.json` stays absent; Task 4 and authority-dependent MCP work remain blocked.
- **Interruption gate: NOT proven.** No durable held call ever existed on the app-server path, so no `turn/interrupt` was delivered and no handler settlement was observed; nothing licenses a lifecycle change. `explicitInterrupt` stays frozen at `release-blocked`; Task 6's other selections (`hostLoss: durable-supervision`, `hostTimeout: server-deadline`) are unchanged and remain within this run's re-derived candidate table.
- The shell baseline and adapter binding behavior of PR #62 are unaffected: the canonical shell Skills remain the only shipped foreground wait adapter.

### 0.155.1 run provenance note

THIS section's record is the FINAL confirmation run, produced by the exact committed driver (`tools/mcp-context-probe/` at the single requalification commit on `feat/dual-foreground-wait-adapters`, tree clean, no code changes for the run) after the harness was hardened through an eleven-round review loop. The driver pinned the installed `codex-cli 0.155.1` binary fail-closed (`PROBE_CODEX_UNSUPPORTED` on anything else), resolved the probe Skill through app-server `skills/list` (`forceReload`, probe workspace), and executed all seven phases under one per-run nonce. The earlier driver revision's first 0.155.1 campaign is preserved in this file's git history: six attempts there, the first five aborting fail-closed on instrument calibrations that 0.155.1 outgrew (the 600-second outer deadline, the unavailability vocabulary, the retained-notification delta cap, and the introspective negative-control engagement shape), each fixed test-first with no gate weakened. Those calibrations are baked into the committed driver this run used; none fired here.

Every control durably recorded exactly one `app-server-control` event with a closed-enum outcome — the five events that make the final log the committed driver's proof transcript:

| Durable `app-server-control` event | Outcome |
|---|---|
| `skill-resolution` | `resolved` |
| `structured-treatment-turn` | `completed` (zero captures) |
| `text-only-control-turn` | `completed` (zero captures) |
| `transport-control` | `error-result-undetermined-origin` |
| `held-turn-interrupt` | `not-sent` |

The final run replicated the earlier revision's recorded outcome exactly — same six assertion values, same five lifecycle observations verbatim, same 8 true hook-authority equality cells with every app-server-authority cell fact-less false — so the regenerated `qualification/mcp-lifecycle.json` is byte-identical to the committed record and `qualification/mcp-context.json` stays absent (zero winning candidates; none guessed). The driver exited 1 by design when the six-boolean context gate failed; cleanup ran to completion (probe plugin and marketplaces removed from each isolated home, tracked PIDs stopped by verified start identity, isolated `auth.json` copies deleted, temporary homes removed). No evidence was rewritten: `result.json` is the closed reduction of exactly the durable log this run produced, and the committed record changes follow mechanically from it.

## 0.154.0 baseline (historical, preserved verbatim)

Status: **authority namespace NOT qualified on this run; lifecycle characterized; Task 4 stays blocked.** The amended Task 2 separates pass/fail authority assertions from closed lifecycle observations. On this rerun five of the six context assertions reduced true, but `identityNamespaceQualified` reduced **false**: the hardened attribution gate requires MCP captures attributable to the app-server-created threads, and the app-server model never called the probe tool, so every app-server authority cell stayed fact-less and no authority field path could be recorded. `qualification/mcp-context.json` was therefore deleted (no proven authority namespace), and `qualification/mcp-lifecycle.json` records five honest lifecycle observations with candidate strategies (`selectedStrategies` stays null; Task 6 owns selection). This report contains no identity values; only field names, JSON types, exit codes, field-path equalities, and observations.

- Date: 2026-09-19 (three completed amended-characterization runs with the hardened harness, plus two additional attempts that aborted in the negative-control phase — a transcript-shape flake since fixed in the harness, which now accepts the failed-attempts engagement shape; see the provenance note. The earlier same-week run established the loading/distinctness facts re-proven below)
- Host under test: `codex-cli 0.154.0` (arm64 macOS). Newly observed host fact: the machine's default launcher (`~/.local/bin/codex`) had auto-updated to 0.155.1, so the run pinned the still-installed 0.154.0 standalone release binary — a regular executable the driver re-pinned by device/inode and re-version-checked before every spawn. The records stay truthful to the binary actually tested.
- Probe harness: `tools/mcp-context-probe/` (disposable plugin marketplaces in `plugin-server` and `skill-only` modes + stdio MCP server + durable mode-0600 observer + fixture hooks + driver), unit-covered by `tests/mcp-context-probe.test.mjs` and gated by the opt-in `tests/e2e/codex-mcp-context-e2e.test.mjs`
- Result records: `qualification/mcp-context.json` (deleted — context not qualified) and `qualification/mcp-lifecycle.json` (status `characterized`), reduced from one durable event log (98 events) under a single per-run nonce.

## Outcome

Five of six context assertions reduced true; `identityNamespaceQualified` reduced false:

| Assertion | Outcome |
|---|---|
| `identityFieldsVisible` | true |
| `identityNamespaceQualified` | **false** |
| `laterTurnDistinct` | true |
| `concurrentChildrenDistinct` | true |
| `metadataChangesAcrossTurns` | true |
| `serverLoadedWithConfig` | true |

No authority field path is recorded: the reducer's `authorityFields` are null for Root thread, Child thread, and turn. Because the record's schema requires the actual equality-matrix winners and zero candidates won the app-server authority, `qualification/mcp-context.json` was deleted; Task 4 remains blocked until a run proves the app-server/Hook authority join.

## Proven facts

### Loading and distinctness (settled, re-proven under the hardened harness)

- The amended argv (positive runs omit `--ignore-user-config` and use `--ignore-rules`; the negative control adds `--ignore-user-config`) still holds: the negative-control window is provably free of any `server-started` and `capture-started` event, and its transcript shows the recorded tool-unavailable shape — the model's agent message names `mcp__zcode-mcp-context-probe__capture_context` as unavailable, and no nested `mcp_tool_call` item ever appears. The failure under the flag is configuration loading, not fixture packaging.
- The Root, the initial Child, and the two concurrent Children carry distinct thread hashes; the Child's followup turn carries the Child's thread hash with a different turn hash; the scripted Root resume re-emits exactly the same stdout `thread.started` id with a new inner turn hash (verified by durable hashes this run).
- `_meta` candidates are exactly the four identity fields (envelope `threadId`, inner `session_id`, `thread_id`, `turn_id`); the probe reads no workspace from `_meta` and claims none — workspace derivation remains the Task 4 authority join.

### Authority namespace (the equality matrix; no winner this run)

The driver hashed the `_meta` candidates, the stdout `thread.started` id, the fixture-hook `session_id`/`turn_id`/`agent_id` values, and the returned Child handle, then recorded salted equality facts. The app-server columns additionally require the app-server-path capture evidence gate: the bounded capture turn must complete with Root/Child captures whose thread hashes match the app-server-created threads learned independently from JSON-RPC. This run the app-server capture turn completed but the model issued no probe MCP calls there (zero captures in that phase), so the gate stayed closed and **no app-server-path or returned-Child-handle equality fact was recorded** — those cells are fact-less false, not contradicted. The reduced matrix:

- **Hook-authority columns (recorded from exec-window pairings):** Root — envelope `threadId`, inner `session_id`, and inner `thread_id` all equal the hook session id (true); inner `turn_id` equals the hook turn id (true). Child — envelope `threadId` and inner `thread_id` equal the hook `agent_id` (true — the spawn handle is the child thread id); inner `session_id` equals the hook session id (true — `SubagentStart` reports the child's own session); the cross contrasts (envelope `threadId` vs hook session id, inner `session_id` vs hook `agent_id`, inner `thread_id` vs hook session id) are false; inner `turn_id` equals the hook turn id (true).
- **App-server-authority columns (fact-less on all three completed runs):** every `root:candidate==appServerThreadId`, `child:candidate==appServerThreadId`, and `innerTurnId==appServerTurnId` cell is false because the gate stayed closed — the app-server model omitted the tool call, even after the capture prompt was strengthened to the exec-compliance voice (explicit tool naming, exact call counts, explicit wait, every other MCP tool forbidden).
- **Returned-Child-handle column (fact-less this run):** one spawn handle was parsed and hashed as durable authority evidence, but per-pair handle facts are recorded only inside the capture-evidence branch, so no handle fact was fabricated.
- The recorded namespace fact that inner `thread_id` differs from the stdout `thread.started` id on `exec` remains true and is preserved: no equality above is asserted against stdout ids.
- Consequence: unlike the prior run's exec-read-back correlation, the hardened harness only qualifies the namespace from MCP metadata observed on the app-server Root/Child path itself. On 0.154.0 the app-server model never calls the probe tool, so the join is bounded by that model behavior, not by a transport fact.

### Lifecycle characterization (all five cases; honest observations)

| Case | hostProcess | turnTerminalStatus | toolCallOutcome | handlerSettlement | transportState | hookEvent | unknownReason |
|---|---|---|---|---|---|---|---|
| `cliSigint` | exited-clean | not-observed | pending | not-observed | server-exited | session-end | process-exited-first |
| `cliSigkill` | exited-signal | not-observed | pending | transport-close | stdin-eof | not-observed | none |
| `appServerTurnInterrupt` | running | completed | not-observed | not-observed | open | stop | host-omitted-event |
| `pluginToolTimeout` | exited-clean | not-observed | failed | not-observed | server-exited | stop | process-exited-first |
| `directConfigToolTimeout` | exited-clean | not-observed | failed | not-observed | server-exited | stop | process-exited-first |

Reading of each case:

1. **`cliSigint`.** SIGINT to the pinned Host PID made the Host exit cleanly within the 10-second window, no durable settlement was written for the held call, and the `SessionEnd` hook fired. The server never observed anything. Cancellation is not delivered to a pending stdio handler on this path.
2. **`cliSigkill`.** SIGKILL orphans the stdio server; the server's own stdin-EOF watcher settles the held call durably as `transport-close` and exits. Host loss after a durable start is observable only through that self-watching pattern.
3. **`appServerTurnInterrupt`.** The held turn completed before the interrupt: the model never invoked `hold_for_lifecycle`, so no held call ever became durable and `turn/interrupt` for that exact thread/turn was rejected because the turn had already reached a terminal state. A `Stop` hook fired in the window. The explicit-interrupt dimension stays unproven on this host: no abort settlement, no interrupted-with-Stop-hook shape, and not even a held call to interrupt.
4. **`pluginToolTimeout` (2-second plugin fixture).** The Host exited cleanly inside the 30-second ceiling with no durable settlement. The new richer observation: the Host transcript itself recorded the nested `mcp_tool_call` item as failed (the configured timeout rendered as a call failure), yet the handler was never notified — no abort, no transport close; the handler simply outlived its call while the Host moved on and exited.
5. **`directConfigToolTimeout` (2-second direct `[mcp_servers.*]` config, `skill-only` fixture without `.mcp.json`).** The direct-configured server started (durable start observed through the identical env allowlist) and the differential produced the same shape as the plugin fixture: clean Host exit inside the ceiling, a failed nested call item in the transcript, no settlement. Direct configuration versus plugin descriptor loading makes **no behavioral difference** for tool-timeout cancellation on this host.

### Instrument facts the production design must absorb

- `@modelcontextprotocol/sdk` 1.30.0's `StdioServerTransport` listens only for stdin `'data'`/`'error'`; abrupt client death never fires `onclose` and never aborts in-flight handlers. A production stdio server that must record durable interruption settlements has to watch its own stdin `end`/`close` and settle pending work itself. The probe harness does exactly this (the SIGKILL phase proves the mechanism works when the disconnect is observable).
- `tool_timeout_sec` semantics (per the official config documentation) bound the MCP tool call; nothing in the documented behavior or in either measured shape propagates that timeout to the handler as cancellation — the timeout surfaces only as a failed call item in the Host transcript.
- `turn/interrupt` is the real cancellation entry (app-server JSON-RPC over stdio, `{threadId, turnId}`), but it requires an active turn: an already-terminal turn rejects the interrupt, so explicit cancellation can only be characterized when the interrupted turn is still in flight. On this host the app-server model omitted both the capture and the held tool calls, so the explicit-interrupt observation and the app-server authority join are both bounded by that model behavior, not by a transport fact.
- The app-server capture-evidence gate is the qualification path for the authority namespace: the app-server-path equality facts may be recorded only when a completed app-server turn durably produces Root/Child captures attributable to the app-server-created threads (attribution by ANY salted candidate hash — envelope, inner session, or inner thread — against the JSON-RPC-learned thread ids and the persisted spawn-children list, so the discovery does not preselect which `_meta` field carries the identity). Exec-read-back correlation alone no longer qualifies. On 0.154.0 the app-server model ignored even the strengthened exec-compliance prompt on all three completed runs, so the gate has never opened in the hardened harness and the any-candidate attribution path remains unexercised against the live host.
- The exec phases' `transportState` column is a server-side observation, never an inference from the Host's exit: a durable hold settlement reads as `stdin-eof`, and otherwise the driver checks the liveness of the server process whose durable `server-started` event is the phase's own (alive → `open`, exited → `server-exited`; no durable startup → `not-observed`). The run that exercised this corrected semantics observed the same enum values the earlier inference had produced — `stdin-eof` for `cliSigkill` (its settlement fired) and `server-exited` for `cliSigint` and both timeout phases (each phase's server had exited by observation time) — so the Host-exit inference is now replaced by, and agrees with, direct server-side evidence.
- Plugin hooks fire in `codex exec` and app-server conversations once two host gates are satisfied: `features.hooks = true` in `$CODEX_HOME/config.toml` and per-hook `trusted_hash` entries under `[hooks.state."…"]` (read from the app-server `hooks/list` `currentHash`); untrusted hooks are silently skipped. The fixture harness enables and trusts its own disposable hooks; `Stop`, `SessionEnd`, and `SubagentStart` observations are what make the `hookEvent` column measurable.
- Deadlines and bounds: CLI commands keep a 180-second outer deadline; real Host conversations get a 600-second outer deadline. The 10-second signal window covers exit and settlement together, and the 30-second timeout ceiling starts at the durable held-call start. The app-server JSON-RPC client is bounded like every other subprocess read: 4 MiB per stream and a capped notification buffer, with a sticky overflow terminating the bounded session instead of growing the driver.

### Run provenance note

Three full-matrix runs of the hardened harness produced the same outcome, on a driver whose app-server capture prompt was strengthened to the exec-compliance voice between the first and second runs, whose capture-evidence gate later moved to any-candidate-hash attribution (discovery, not preselection), and whose exec-phase `transportState` observation moved from Host-exit inference to the phase server's own durably recorded pid liveness. Each completed run executed all seven phases under one nonce (98 durable events, exact capture and held-call census) and each driver wrote and reduced its own `result.json` before exiting. On every completed run the app-server capture turn completed with the model issuing no probe MCP calls, so the capture-evidence gate stayed closed, the held call never became durable, and `turn/interrupt` was rejected against an already-terminal turn — neither the strengthened prompt nor the widened attribution changed app-server-path model behavior.

Two further attempts aborted fail-closed in the negative-control phase before any durable evidence existed: the negative-control model issued four failed `mcp_tool_call` attempts (all errored, one matching failure excerpt) instead of the recorded zero-item "names the tool unavailable" shape, and the transcript-shape assertion — which then accepted only the zero-item shape — rejected the transcript. Those two aborts were an instrument flake this fix removes, not a host fact: the shape is bimodal model behavior on this host, and the assertion was stricter than the control's purpose, rejecting the strongest engagement evidence (attempted, errored, never executed) because the engagement rendered as items rather than an agent message. The assertion now accepts either engagement shape — the zero-item agent-message shape, or failed-attempt engagement (at least one failed/errored `mcp_tool_call` item plus a matching failure excerpt, with zero successful call evidence) — and always fails closed on successful call items, which remain real-server-interaction proof, never unavailability. The division of labor is unchanged: this assert proves genuine model engagement only, while the durable window (zero `server-started`/`capture-started` events, which held in every attempt) remains the hard proof that the server never loaded. The gate's security claim is unaffected: no server ever loaded under `--ignore-user-config` in any attempt.

The driver exits 1 by design when the six-boolean context gate fails; cleanup still ran to completion each time (probe plugin and marketplaces removed from each isolated home, tracked PIDs stopped, isolated auth copies deleted). No evidence was rewritten: `result.json` is the closed reduction of exactly the durable log each run produced, and the committed record changes follow mechanically from it.

## Cleanup and blast radius

The driver run removed the probe plugin and marketplaces from each isolated home, killed all tracked Host/server PIDs by verified start identity, deleted both isolated `auth.json` copies, and removed the temporary isolated homes. The real `~/.codex` home was only read for `auth.json` bytes (mode-0600 copies); it was never written. Run directories live outside the repository and are not committed.

## Consequences

- **Task 4 is blocked:** `qualification/mcp-context.json` no longer exists because no authority field path is proven. Safe caller/binding resolution from MCP metadata is unavailable until a run proves the app-server/Hook authority join.
- Task 3 and Task 5 remain independent and unaffected.
- Task 6 receives `qualification/mcp-lifecycle.json` with `explicitInterrupt: ['release-blocked']`, `hostLoss: ['durable-supervision', 'release-blocked']`, and `hostTimeout: ['server-deadline', 'durable-supervision', 'release-blocked']`, with `selectedStrategies: null`. Explicit interruption is release-blocked unless a future host/version proves a direct abort or an interrupted-turn-plus-Stop-hook shape; Host loss and timeouts require durable supervision or a server-side deadline, never the Host's configured timeout.
- Production MCP server/Skill packaging remains blocked until Task 6 freezes feasible strategies and Tasks 8–10 prove the unchanged feature outcomes. The canonical shell Skills remain the only shipped foreground wait adapter.
