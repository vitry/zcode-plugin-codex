# ZCode 0.16.5 Permission Turn Lifecycle Design

## Context

The executor already treats ZCode 0.16.5 `state.updated` notifications with reason `prompt_completed` as legacy liveness signals. True completion is established by the v4 conversation observer or a coherent current-turn snapshot. However, `executeJob` obtains the liveness signal through `client.waitForCompletion()`, whose public contract consumes completion and deletes the protocol client's active-turn state.

ZCode 0.16.5 can emit that legacy notification immediately after admission, then request tool permission while the real runtime turn is still active. Once the legacy waiter deletes the turn, the permission request fails the exact-active-turn check and is returned as JSON-RPC `-32000` (`ZCODE_PERMISSION_SESSION_INVALID`). This is independent of the configured Codex permission mode: the incident job already carried `bypassPermissions`.

## Goals

- Keep the exact turn armed after an admission-time legacy completion wake so later permission requests can be evaluated normally.
- Preserve the current destructive behavior of `waitForCompletion()` for every existing caller.
- Clear local turn state when `executeJob` reaches its real terminal or cleanup boundary.
- Cover the captured 0.16.5 event ordering with deterministic regression tests.

## Non-goals

- No change to `decidePermission`, permission snapshots, risk mapping, or offered-response validation.
- No new appserver flag, permission field, broker authorization rule, or persisted schema.
- No reinterpretation of legacy completion as authoritative success or failure.
- No broad refactor of the protocol or executor lifecycle.

## Design

### Non-destructive legacy observation

Add a narrowly named protocol/client operation for observing the next validated completion notification without consuming the active turn. It must apply the same session, timeout, active-turn, duplicate-waiter, and `isCompletionFor` validation used by `waitForCompletion()`, but resolution must not call `abortTurn()` and must not consume turn ownership.

The existing `waitForCompletion()` remains unchanged in observable behavior: queued or live completion resolution consumes the turn, while timeout and cancellation retain their present destructive cleanup semantics.

Only `executeJob` switches its `legacyWake` construction to the non-destructive observer. The coordinator continues to use the wake solely to trigger authoritative v4/snapshot reconciliation.

### Explicit executor cleanup

Because the wake no longer consumes local state, `executeJob` must explicitly release the protocol turn after the authoritative lifecycle has finished. Cleanup belongs in the executor's existing unconditional teardown, after any terminal/cancellation reconciliation that may still need permission and turn identity, and before client close completes.

The cleanup operation is local and idempotent. It must not send `session/stop`, alter durable job state, or replace the existing cancellation paths. Successful terminal, provider failure, remote interruption, local abort, timeout, and error cleanup all converge on the same local turn release when a session was created or resumed.

### Safety invariants

- A validated early legacy completion leaves `turnState(sessionId) === 'armed'`.
- A later permission request for that session reaches the configured handler and returns one offered response.
- Authoritative executor teardown leaves `turnState(sessionId) === null`.
- Ordinary `waitForCompletion()` still leaves `turnState(sessionId) === null` immediately after resolution.
- Permission policy and durable job outcomes are unchanged.

## Testing

1. Add a protocol/client regression proving non-destructive observation preserves the armed turn and permits a subsequent permission request.
2. Retain or strengthen the destructive waiter assertion so its compatibility contract is explicit.
3. Add an executor regression with captured 0.16.5 ordering: admission, early legacy wake, later permission request, authoritative terminal, successful result, and final local turn cleanup.
4. Exercise cleanup on a non-success path so an observer cannot leave an armed turn behind.
5. Run focused tests, then `npm run check` before review and PR creation.

## Rollout and compatibility

This is an internal additive API and a one-call-site migration. No user configuration or data migration is required. Older ZCode versions continue to produce the same wake signal, and all callers outside `executeJob` retain existing semantics.
