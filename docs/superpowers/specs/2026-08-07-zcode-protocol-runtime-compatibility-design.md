# ZCode Protocol Runtime Compatibility Design

## Problem

ZCode CLI 0.16.1 sends a server-initiated JSON-RPC request during
`session/create`:

```json
{"id":"server-1","method":"session/requestRuntimePreferences","params":{"sessionId":"sess_...","scope":"runtime-materialization"}}
```

The plugin currently accepts only integer server-request IDs and therefore
closes the connection with `ZCODE_PROTOCOL_MALFORMED`. After replying with the
standard JSON-RPC `-32601` unsupported-method response, the same CLI proceeds
correctly and falls back to its default runtime preferences.

The next real CLI failure is independently actionable: the Desktop API-key
provider lives in `~/.zcode/v2/config.json`, while `zcode app-server` reads
`~/.zcode/cli/config.json`, which has no explicit model provider. Setup currently
collapses this into a generic authentication failure.

## Design

### Protocol compatibility

Accept a server-request ID when it is either a safe integer or a bounded,
control-free string. Echo the exact ID in the JSON-RPC response. Continue to
handle `interaction/requestPermission` as before. Return `-32601` for every
other well-formed server request, including
`session/requestRuntimePreferences`; ZCode 0.16.1 owns the fallback behavior.

Malformed, empty, oversized, or control-bearing string IDs remain fatal
protocol errors. Client-originated request and response IDs remain integers,
so an unexpected string response still fails closed.

### Actionable setup diagnostics

Preserve a bounded, nonsecret remote error discriminator from a failed ZCode
response as `details.remoteCode`. When `session/create` reports
`model_config_missing`, setup reports that the ZCode CLI model provider is not
configured and instructs the user to configure an API-key provider in the CLI
configuration. It does not recommend OAuth as mandatory.

Other failures retain the existing unauthenticated status and generic remedy.
No Desktop configuration or API key is read, copied, logged, or persisted by
the plugin.

## Testing

- Extend the hermetic ZCode fixture to emit a string-ID
  `session/requestRuntimePreferences` request before `session/create` and wait
  for the client's response.
- Prove the plugin returns `-32601`, preserves the string ID, and completes
  `session/create`.
- Prove unsafe string IDs still produce `ZCODE_PROTOCOL_MALFORMED`.
- Emit a fixture `model_config_missing` RPC error and prove setup returns the
  specific API-key/provider diagnostic without exposing remote data.
- Run focused protocol/setup tests, the complete test suite, and a raw real
  ZCode 0.16.1 protocol smoke test.

## Non-goals

- Copying Desktop provider configuration into CLI configuration.
- Reading or migrating API keys.
- Implementing runtime-preference UI or shell-selection policy in Codex.
- Changing public rescue arguments or model selection semantics.
