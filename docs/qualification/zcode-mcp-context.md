# Codex MCP Invocation Context Qualification

Status: **plugin loading and identity visibility proven; authority namespace join and lifecycle partially characterized; production release not yet qualified.** The original all-true gate incorrectly treated undocumented cancellation/timeout mechanisms as requirements, while also failing to prove which metadata namespace joins existing app-server/Hook authority. The MCP wait-adapter Skills remain unshipped and unpackaged while those bounded characterization tasks and lifecycle feasibility checks complete. This report contains no identity values; only field names, JSON types, exit codes, timing facts, and observations.

- Date: 2026-09-18 (amended rerun; original failing run recorded the same day)
- Host under test: `codex-cli 0.154.0` (arm64 macOS, canonical target resolved from the externally supplied launcher path and pinned by device/inode)
- Probe harness: `tools/mcp-context-probe/` (disposable plugin marketplace + stdio MCP server + durable mode-0600 observer + driver), unit-covered by `tests/mcp-context-probe.test.mjs` and gated by the opt-in `tests/e2e/codex-mcp-context-e2e.test.mjs`
- Result record: none. `qualification/mcp-context.json` is deliberately absent; a machine-readable record may only be created by a passing gate.

## Outcome

The amended loading/context plan was applied (positive runs omit `--ignore-user-config` and use `--ignore-rules`; the negative control keeps `--ignore-user-config`). The probe server loads and per-call metadata distinguishes Root, Child, later turns, and concurrent Children. It did not prove which metadata field equals the app-server/Hook identity used by Caller Context and Rescue executor records. The historical reducer produced six true and two false booleans; the last two are lifecycle observations rather than failed context assertions.

| Boolean | Outcome |
|---|---|
| `rootIdentityComplete` | true |
| `laterTurnDistinct` | true |
| `concurrentChildrenDistinct` | true |
| `metadataChangesAcrossTurns` | true |
| `serverLoadedWithConfig` | true |
| `cancelDelivered` | **false** |
| `connectionLossDelivered` | true |
| `shortTimeoutSettled` | **false** |

The historical reducer correctly refused to write its obsolete all-true `result.json` and exited nonzero. The revised plan replaces that schema with a qualified context record plus a lifecycle characterization record; it does not rewrite the observed false values.

## Proven facts (amendment verification)

### Blocker 1 from the original run is resolved by the amended argv

With the fixed base argv for new conversations

```text
exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox
  --ignore-rules -C <workspace> <prompt>
```

and continuations

```text
exec resume --json --all --skip-git-repo-check
  --dangerously-bypass-approvals-and-sandbox --ignore-rules <root-thread-id> <prompt>
```

the installed probe plugin's MCP server starts (durable `server-started` with canonical observer paths) and successful probe tool calls follow. The A/B negative control — same isolated marketplace and plugin, argv adding `--ignore-user-config` — completed its conversation with the tool unavailable and left the durable event log window provably free of any `server-started` and `capture-started` event. The failure is therefore configuration loading under that flag, not fixture packaging, exactly as the amendment hypothesized.

### Observed per-call metadata (names and JSON types only; no values)

`_meta` envelope:

| Field | Type |
|---|---|
| `progressToken` | number |
| `callId` | string |
| `plugin_id` | string |
| `threadId` | string |
| `itemId` | string |
| `x-codex-turn-metadata` | object |

`_meta["x-codex-turn-metadata"]`:

| Field | Type |
|---|---|
| `session_id` | string |
| `thread_id` | string |
| `turn_started_at_unix_ms` | number |
| `turn_id` | string |
| `node_repl_disabled` | boolean |
| `thread_source` | string |
| `sandbox` | string |
| `sandbox_mode` | string |
| `auto_review_enabled` | boolean |
| `node_repl_auto_review_required` | boolean |
| `model` | string |
| `codex_version` | string |
| `reasoning_effort` | string |

There is no workspace/cwd field of any kind, in root turns, child turns, or resumed turns, and the MCP `roots/list` request returns `{"roots": []}` on this host. Workspace derivation must come from the Task 4 authority join, not `_meta`.

### Identity semantics proven by per-run-salted hashes

- The Root, the initial Child, and the two concurrent Children carry four distinct thread hashes; the Child's followup turn carries the Child's thread hash with a different turn hash (`laterTurnDistinct`).
- The scripted Root resume (`exec resume --all <root-thread-id>` with cwd equal to the Root workspace) exits 0 and produces one durable capture with the same inner `thread_id` hash, a new inner `turn_id` hash, and a new metadata hash (`metadataChangesAcrossTurns`). This proves stability within that namespace, not its equality to Hook/app-server authority.
- Recorded namespace fact: the stdout `thread.started` id — the identifier `exec resume` consumes — is **not** the same value as `_meta["x-codex-turn-metadata"].thread_id`. Production code must not equate those two fields. The resume observation is available within the inner metadata namespace, whose authority relation remains to be characterized.

## Lifecycle observations: no CLI SIGINT or plugin-timeout abort reached a pending handler

The repaired probe server settles a held call durably as soon as it can observe the abort, and the driver enforces the plan's ceilings exactly. Two of the three delivery shapes fail on this host:

1. **SIGINT (`cancelDelivered` = false).** After the held call's durable start, SIGINT to the recorded Host PID made the Host exit within the 10-second grace. No durable abort/settled event was written for that call. The run does not distinguish whether the server was killed, failed to observe EOF in time, or ended through another Host process-tree action.
2. **Tool timeout (`shortTimeoutSettled` = false).** With the 2-second `tool_timeout_sec` fixture, the held call produced no durable settlement within the 30-second ceiling. The Host did not exit and the probe observed neither SDK cancellation nor handler termination during that window. This may leave work without the supervision assumed by the original design; direct-config comparison and production lifecycle tests must determine the actual risk.
3. **Disconnect (`connectionLossDelivered` = true).** SIGKILL to the Host orphans the stdio server; the server detects its own stdin end/close, settles the held call durably as a transport close (observed ~250 ms after the kill), and exits. Delivery after a Host crash is therefore possible — but only because the probe server watches stdin itself.

### Instrument fact the production design must absorb

`@modelcontextprotocol/sdk` 1.30.0's `StdioServerTransport` listens only for stdin `'data'`/`'error'`. An abrupt client death therefore never fires the transport's `onclose`, and the SDK's in-flight handler aborts (verified present in `Protocol._onclose` and via InMemory transport tests) never run over real stdio. A production stdio MCP server that must record durable interruption settlements before becoming unsupervised has to watch its own stdin `end`/`close` and settle pending work itself. The probe harness now does exactly this; the timeout and SIGINT findings above are not artifacts of that gap (the disconnect phase proves the mechanism works when the disconnect is observable).

A second recorded harness instrument fact concerns outer deadlines: `codex` CLI commands (version, flag pre-check, marketplace/plugin install and removal, `login status`) keep a 180-second outer deadline, while real Host conversations get a 600-second outer deadline. On 0.154.0 the matrix's first durable capture alone landed ~140s into the conversation, so the CLI command bound cannot contain a healthy multi-turn Host session. The 10-second signal grace and the 30-second tool-timeout ceiling remain unchanged protocol assertions.

## Matrix assertion notes

- `rootIdentityComplete`, `laterTurnDistinct`, `concurrentChildrenDistinct`, `metadataChangesAcrossTurns`, `serverLoadedWithConfig`: reduced true from the durable log; the driver additionally verified the resume capture against the authoritative parsed facts by hash before correlation.
- `cancelDelivered`, `shortTimeoutSettled`: reduced false; the census refused the qualification as designed.
- Stale/wrong-metadata rejection and workspace derivation remain Task 4 authority-join obligations and are not claimed here.

## Cleanup and blast radius

Every driver run removed the probe plugin and marketplace (`plugin remove`/`plugin marketplace remove` exit 0, in `finally`), killed all tracked Host and server PIDs by verified start identity, deleted the isolated `auth.json` copy, and removed the temporary isolated homes. The real `~/.codex` home was only read for `auth.json` bytes (mode-0600 copy into the run directory); it was never written. Run directories live outside the repository and are not committed.

## Consequences

- Metadata visibility/distinctness, amended argv, and A/B configuration loading are settled facts. Task 3 and Task 5 may proceed without rerunning them; Task 4 waits for the authority namespace mapping.
- CLI SIGINT, CLI SIGKILL, and plugin timeout results are settled observations, not requirements that must all become signal aborts. The harness must preserve them in the new generic lifecycle schema.
- Task 2 still needs three bounded characterization results: metadata-to-app-server/Hook identity namespace equality, real app-server `turn/interrupt`, and direct `config.toml` versus plugin `.mcp.json` timeout behavior. Those observations produce candidate strategies; Task 6 freezes independent explicit-interrupt, Host-loss, and timeout strategies only after local feasibility tests.
- Production MCP server/Skill packaging remains blocked until authority mapping and all selected lifecycle strategies prove the unchanged feature outcomes. Independent adapter-state and result-formatting work is not blocked.
- The canonical shell Skills remain the only shipped foreground wait adapter until the final installed-plugin gate passes.
