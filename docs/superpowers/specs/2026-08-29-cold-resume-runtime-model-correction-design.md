# Cold Resume Runtime Model Correction Design

## Status and scope

This design corrects only the cold-runtime portion of the merged
`2026-08-28-resume-runtime-workspace-compaction-design.md`. The effective
workspace and compact-launcher designs remain unchanged.

The correction stays inside the Codex plugin. It does not modify ZCode,
Codex, Rescue routing, public command syntax, binding state, or writable-job
concurrency policy.

## Corrected finding

ZCode 0.16.3 accepts a cold `session/resume` without runtime input and returns
a schema-valid snapshot whose `projection.lastError.type` is
`ZCODE_RUNTIME_MODEL_UNAVAILABLE`. The plugin then attempted tuple-only
`session/setModel` recovery. Although that call succeeded, the restored
session retained its runtime-unavailable warning, so the plugin emitted the
incident error before sending the prompt.

The previous design was wrong in two places:

1. a provider/model tuple is model selection, not a complete runtime adapter;
2. a successful `session/setModel` response is not proof that a cold provider
   runtime was materialized.

The AppServer's complete runtime model contains a revision, generation time,
selected model, provider definition, model definitions, and any credential
reference or inline credential needed by that provider. The public workspace
catalog may omit effective built-in fields such as `baseURL`, so it cannot be
used as the sole reconstruction source.

## Verified AppServer sequence

The exact incident workspace and session were probed directly against the
installed ZCode 0.16.3 AppServer without sending a prompt:

```text
session/resume
  -> snapshot warning ZCODE_RUNTIME_MODEL_UNAVAILABLE
read bounded effective ZCode CLI configuration
session/updateRuntimeModelConfig(applyModelSelection=true)
  -> changed=true and applied revision equals the supplied revision
session/read
  -> no runtime-unavailable warning and expected model remains selected
```

This sequence is the selected design. It is preferable to supplying runtime
configuration before every resume because warm resumes perform no config I/O.
It is preferable to retrying resume because it makes exactly one resume state
transition and uses the AppServer method dedicated to updating a resident
session runtime.

## Runtime configuration resolution

Only after an exact cold warning, resolve one desired model tuple using the
existing precedence:

1. explicit `--model` resolved against the resume snapshot catalog;
2. plugin workspace model policy; or
3. the effective ZCode CLI `model.main`.

Read the bounded regular file at the effective
`<home>/.zcode/cli/config.json`. Resolve the selected provider under
`provider.<providerId>` and the selected model under that provider's model
map. Normalize only the fields admitted by the ZCode 0.16.3 runtime model
schema:

- generate a fresh bounded revision and `generatedAt` timestamp;
- copy the exact selected provider/model tuple;
- map provider identity, kind, label, API format, base URL, API-key
  requirement, headers, provider options, source, logo, and models-dev ID when
  present and valid;
- map the provider's model map into the runtime model array with only supported
  model metadata;
- represent a configured API key as an inline credential only in memory;
- include thought level only when it is valid and belongs to the selected
  runtime.

The resolver rejects missing, oversized, malformed, unsupported, or
inconsistent provider/model configuration with a fixed configuration error.
It never guesses another provider, first model, alias, endpoint, or secret.

## Privacy and lifetime

The normalized runtime model may contain an inline credential. It therefore:

- exists only in bounded process memory;
- travels only through the existing local authenticated Companion-to-broker
  and broker-to-AppServer request path;
- is never placed in argv, job state, bindings, prompt artifacts, result
  artifacts, progress, logs, diagnostics, or public JSON;
- is not cached between invocations;
- is dropped after the runtime update request settles.

Errors expose only fixed plugin codes and safe method/model identifiers. They
must not attach raw config, provider objects, request params, headers,
endpoints, or credential values as error details or causes rendered publicly.

## Execution flow

For a resume operation:

1. call `session/resume` exactly once with the exact session ID;
2. if there is no exact runtime-unavailable warning, continue unchanged and
   do not read CLI config;
3. if the warning is exact, resolve the selected full runtime model;
4. call `session/updateRuntimeModelConfig` exactly once with
   `applyModelSelection: true`;
5. call `session/read` and require the warning to be absent and the expected
   tuple to be current;
6. apply requested effort using the refreshed live catalog;
7. subscribe and send the prompt exactly once.

No branch retries resume, creates a replacement session, falls back to fresh,
selects a different model, retries send, or loops on runtime recovery.

An AppServer rejection of the supplied runtime configuration is authoritative.
If the post-update read still carries the exact warning, emit the existing
`ZCODE_REQUEST_FAILED` envelope with remote code
`ZCODE_RUNTIME_MODEL_UNAVAILABLE`. Other structured AppServer failures retain
their existing error identity.

## Client boundary

`ZCodeClient` gains a narrow `updateRuntimeModelConfig(sessionId,
runtimeModel)` method. It validates the normalized input, sends
`session/updateRuntimeModelConfig` with `applyModelSelection: true`, and
validates the session ID, applied revision, and boolean `changed` result.

The broker admits this method as an owner-scoped, non-turn request. It must
remain subject to the same exact session ownership, operation lease,
disconnect, timeout, and bounded-frame rules as `session/setModel`.

## Tests and acceptance

TDD must prove:

- the old tuple-only fixture fails to recover the corrected scenario;
- a cold snapshot triggers exactly one bounded full-config read, one runtime
  update, one post-update read, and one send;
- a warm resume and any other warning trigger none of those recovery actions;
- explicit/workspace/default tuple precedence selects an exact configured
  provider and model;
- malformed, missing, oversized, unsupported, and mismatched config fails
  before effort or send;
- runtime update rejection and a warning that remains after update send no
  prompt and perform no resume retry;
- one genuine send failure is propagated without retry;
- the wire request uses the normalized full runtime model and
  `applyModelSelection: true`;
- broker ownership protects the new method;
- secrets and private config values are absent from public/internal output,
  persisted artifacts, and error serialization;
- source, installed marketplace, packed-install, lint, typecheck, line-ending,
  and full test suites remain green.
