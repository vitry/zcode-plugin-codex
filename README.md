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

The release workflow builds `.agents/plugins/marketplace.json` plus `plugins/zcode/` with production dependencies on that branch. Restart Codex after installation, then run `$zcode:setup` in the target workspace. On the first run, setup may add the marketplace-qualified plugin data directory to Codex's writable roots; if it reports `restart-required`, restart Codex and rerun setup. Do not copy hooks out of the installed plugin cache.

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
| `$zcode:result [job-id]` | Read a completed job's full stored output. |
| `$zcode:cancel [job-id]` | Cancel an owned queued or running job. |
| `$zcode:setup [--enable-review-gate \| --disable-review-gate]` | Diagnose readiness and configure the optional review gate. |

No public command provides unrestricted execution shortcuts. Review commands are always read-only. Rescue can modify the workspace, but ZCode permission requests are evaluated against the initiating Codex turn: missing or unknown permission state is restrictive, and high-risk operations require Codex `bypassPermissions` mode. Background workers inherit the reservation snapshot and cannot elevate it later.

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

`SessionEnd` performs best-effort settlement of the ending session's writable Rescue. If the process exits before that completes, a later Rescue uses a reservation-time crash fallback and may settle a provably orphaned writable job; settlement does not transfer ownership, and only the original owner can access its result. A held worker lease or an unacknowledged `session/stop` keeps the writable guard in place. Other sessions can use `$zcode:status --all` only for redacted workspace inspection.

Foreground runs stream ZCode activity to the current terminal. If no new activity arrives, they emit a 20-second heartbeat so a long model or tool call remains visibly alive. The same safe activity is stored on the job; `$zcode:status <job-id>` shows its phase, last activity time, and recent progress previews. For example:

```text
$zcode:rescue --wait repair the failing tests
[zcode] ZCode started a tool call.
[zcode] Still waiting for ZCode; last activity 20s ago.

$zcode:status <job-id>
Status: running
Phase: running
Progress:
  - ZCode started a tool call.
```

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

macOS with ZCode Desktop 3.6.5 and CLI 0.16.1+ is the release qualification target. The protocol client handles the string-ID runtime-preference server request sent by CLI 0.16.1. Run `ZCODE_REAL_E2E=1 ZCODE_REAL_E2E_MODEL='provider/model' npm run test:qualified` on a machine with a working CLI model provider before marking a release qualified. To include the installed-marketplace-to-real-Codex bridge, also set `ZCODE_CODEX_SKILLS_E2E=1`; this consumes authenticated Codex credits. Missing opt-in, provider configuration or authentication, model, or credits produces a structured `unqualified` skip, never a pass. An unknown execution failure remains a test failure. Linux and Windows are code-supported by fake-protocol CI, but are not real-CLI qualified yet.

## License and provenance

Licensed under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for OpenAI Codex, `codex-plugin-cc`, Sendbird/ZCode adapter, and `zcode-plugin-cc` provenance.
