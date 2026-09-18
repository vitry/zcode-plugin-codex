# Codex MCP Invocation Context Qualification

Status: **unqualified — the real-Host gate failed.** The MCP wait-adapter Skills remain unshipped and unpackaged. This report contains no identity values; only field names, JSON types, exit codes, and frame counts.

- Date: 2026-09-18
- Host under test: `codex-cli 0.154.0` (arm64 macOS, canonical target resolved from the externally supplied launcher path)
- Probe harness: `tools/mcp-context-probe/` (disposable plugin marketplace + stdio MCP server + durable mode-0600 observer + driver), unit-covered by `tests/mcp-context-probe.test.mjs` and gated by the opt-in `tests/e2e/codex-mcp-context-e2e.test.mjs`
- Result record: none. `qualification/mcp-context.json` is deliberately absent; a machine-readable record may only be created by a passing gate.

## Outcome

The driver failed hard in the first Host phase; no eight-boolean result could be produced, so no assertion was marked true or false by the reducer. Two independent blockers were observed.

### Blocker 1: the plan's fixed Host argv cannot load plugin MCP servers

The plan-mandated base argv is:

```text
exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox
  --ignore-user-config -C <workspace> <prompt>
```

On codex-cli 0.154.0, `--ignore-user-config` skips the entire `$CODEX_HOME/config.toml`, and plugin/marketplace registrations created by `codex plugin marketplace add` and `codex plugin add` live exactly there (`[marketplaces.*]`, `[plugins."name@marketplace"]`). Under this argv the probe plugin's MCP server is never started: the durable event log contained only the driver's phase marker, never a `server-started` or `capture-started` event, and the model spent its turn budget searching its tool list for `capture_context` (the Host transcript ended with frames `thread.started:1, turn.started:1, error:5, item.completed:5, item.started:2, turn.completed:1` and no `mcp_tool_call`).

Controlled A/B evidence with the identical probe plugin and server, same isolated `CODEX_HOME`:

- with `--ignore-user-config`: the model reports the tool is not available; zero MCP server events.
- without `--ignore-user-config`: the same tool is exposed as `mcp__<server>__recon`, is called successfully, and the server receives the metadata documented below.

Both marketplace add and plugin add exit 0 and write `config.toml`; the plugin cache is populated. The failure is purely the loading step under the fixed argv.

### Blocker 2: no authoritative per-call workspace in the host metadata

With the server reachable (Blocker 1 bypassed for diagnosis only), every observed plugin MCP tool call carried `request.params._meta` with this exact shape (names and JSON types only):

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

There is no workspace/cwd field of any kind, in root turns or resumed turns. The MCP `roots/list` request returns `{"roots": []}` on this host. This proves that workspace must not be required from `_meta`. It does not, by itself, prove that the existing Root preparation/Rescue Binding cannot supply the execution workspace after the exact Child `thread_id`/`turn_id` is joined to an authoritative Host/app-server Child record. That binding join was not exercised by this failed probe and remains an explicit qualification gate.

## Matrix assertions

None were satisfied or refuted through the plan's argv; the probe could not reach its server:

- `rootIdentityComplete`: not reduced because the server was unreachable under the plan's argv; the observed metadata does contain thread/turn identity when the server is reachable.
- `laterTurnDistinct`: evidence exists that it would be provable — `codex exec resume --all <thread-id> <prompt>` works on 0.154.0 and the next call on the same thread carried the same `thread_id` with a different `turn_id` — but it was not reduced through a full matrix run.
- `concurrentChildrenDistinct`: not exercised (`collaboration.spawn_agent`/`followup_task` are present in exec mode, but the server was unreachable).
- `metadataChangesAcrossTurns`: turn identity does change across `exec resume` turns (see above); full reduction not run.
- `workspaceDistinct`: removed from the real-Host metadata result; workspace derivation is a local Root/Child binding-join assertion, not a claim about `_meta`.
- `cancelDelivered`, `connectionLossDelivered`, `shortTimeoutSettled`: not exercised; the held-call phases require a reachable server.

Harness design facts (not Host claims): the MCP SDK aborts an in-flight tool handler's `extra.signal` both on `notifications/cancelled` and on transport close, and a stdio server cannot distinguish the two from the signal alone; the probe records the settlement kind and relies on driver phase markers for attribution. A tool handler that settles and writes durable evidence before process exit is the only redaction-safe way to prove delivery after disconnect.

## Cleanup and blast radius

Every driver run removed the probe plugin and marketplace (`plugin remove`/`plugin marketplace remove` exit 0, in `finally`), deleted the isolated `auth.json` copy, and killed all tracked Host PIDs. The real `~/.codex` home was only read for `auth.json` bytes (mode 0600 copy into the run directory); it was never written. Run directories live outside the repository and are not committed.

## Consequences

- Tasks 3–10 of the dual-foreground-wait-adapters plan are stopped; no production `.mcp.json`, MCP server, `skills/*-mcp`, or qualification record may be created.
- The canonical shell Skills (Task 1, committed) are unaffected and remain the only foreground wait adapter.
- A future attempt requires a design amendment covering at least: (a) a Host argv that loads plugin MCP servers while still isolating configuration (the positive run must omit `--ignore-user-config`; the negative control may use it), and (b) an exact Child thread/turn to Host/app-server Child record to Root preparation/Rescue Binding join that derives and verifies the execution workspace. A workspace field in MCP `_meta` is not required, but the join and all cancellation/timeout assertions must pass before production MCP work resumes.
