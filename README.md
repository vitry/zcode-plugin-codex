# ZCode for Codex

ZCode for Codex is a native Codex marketplace plugin that delegates independent reviews, repairs, and conversation handoff to ZCode while Codex remains the permission-owning host.

[简体中文](README.zh-CN.md)

## Requirements and installation

- Codex with native plugins and hooks enabled.
- ZCode CLI `>=0.16.1`, installed and authenticated for at least one model.
- Node.js `>=18.18.0` (the plugin packages its production native lock dependency).

Install from the production snapshot published on this repository's `marketplace` branch; the source-code root on `main` is not itself a marketplace catalog:

```bash
codex plugin marketplace add vitry/zcode-plugin-codex --ref marketplace
codex plugin add zcode@vitry
```

The release workflow builds `.agents/plugins/marketplace.json` plus `plugins/zcode/` with production dependencies on that branch. Restart Codex after installation, then run `$zcode:setup` in the target workspace. Do not copy hooks out of the installed plugin cache.

Discovery checks `ZCODE_PATH`, `zcode` on `PATH`, platform locations, and on macOS the bundled `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`. Setup reports missing, outdated, unauthenticated, or untrusted installations; it does not download ZCode or sign in for you.

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

Pass an advertised ZCode model as `provider/model`, an unambiguous exact model ID, or a configured alias. Configure aliases before starting Codex with JSON in `ZCODE_MODEL_ALIASES`, for example:

```json
{"fast":{"providerId":"provider","modelId":"model"}}
```

The plugin never silently changes the selected model. Invalid aliases, model IDs, or effort levels fail explicitly.

## Jobs, Transfer, and review gate

Every run is reserved as a durable, owner-scoped job. Plugin state lives beneath `${PLUGIN_DATA}/workspaces/<workspace-hash>/` with private permissions; prompts, results, session IDs, and logs are never written into the repository. `$zcode:status`, `$zcode:result`, and `$zcode:cancel` work across later turns in the same Codex session, while sibling sessions cannot adopt a job.

Transfer reads a persisted Codex thread through `codex app-server` and imports only ordered visible user/assistant text. It does not transfer hidden reasoning, tools, permissions, or ZCode job ownership.

The optional Stop review gate runs a bounded foreground read-only review only after a changed, user-driven parent turn. Enable or disable it with `$zcode:setup`; a Codex restart may be required. Missing, outdated, or unauthenticated ZCode fails open with setup guidance. Once a review session starts, malformed, failed, or timed-out review output blocks conservatively.

## Troubleshooting and platform status

- `ZCODE_NOT_FOUND` / `ZCODE_VERSION_UNSUPPORTED`: install or upgrade ZCode, set `ZCODE_PATH` if needed, then run `$zcode:setup`.
- `INTERNAL_AUTHORIZATION_INVALID`: restart Codex, verify plugin hooks are enabled/trusted, and run `$zcode:setup`; never paste a caller-context token into a command.
- Authentication unavailable: authenticate with ZCode itself, then rerun setup.
- Background work: use `$zcode:status <job-id> --wait`, `$zcode:result <job-id>`, or `$zcode:cancel <job-id>` exactly as reported.
- Hook trust or restart required: let setup trust only this installed plugin's exact hook hashes, restart Codex, and rerun setup.

macOS with ZCode Desktop 3.6.5 and CLI 0.16.1+ is the release qualification target. Run `ZCODE_REAL_E2E=1 node --test tests/e2e/real-zcode.test.mjs` on an authenticated machine before marking a release qualified; an ordinary local skip is explicitly unqualified and this repository does not claim that an unrun E2E passed. Linux and Windows are code-supported by fake-protocol CI, but are not real-CLI qualified yet.

## License and provenance

Licensed under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for OpenAI Codex, `codex-plugin-cc`, Sendbird/ZCode adapter, and `zcode-plugin-cc` provenance.
