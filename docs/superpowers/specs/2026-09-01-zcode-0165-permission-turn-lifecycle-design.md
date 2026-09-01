# ZCode 0.16.5 Permission Turn Lifecycle Design

## Context

The executor already treats ZCode 0.16.5 `state.updated` notifications with reason `prompt_completed` as legacy liveness signals. True completion is established by the v4 conversation observer or a coherent current-turn snapshot. However, `executeJob` obtains the liveness signal through `client.waitForCompletion()`, whose public contract consumes completion and deletes the protocol client's active-turn state.

ZCode 0.16.5 can emit that legacy notification immediately after admission, then request tool permission while the real runtime turn is still active. Once the legacy waiter deletes the turn, the permission request fails the exact-active-turn check and is returned as JSON-RPC `-32000` (`ZCODE_PERMISSION_SESSION_INVALID`). This is independent of the configured Codex permission mode: the incident job already carried `bypassPermissions`.

### Follow-up incident: managed broker boundary

The first implementation preserved the executor-side broker client turn, but production uses two protocol layers. The managed broker still registered `consumeTerminalsWith()` on its upstream appserver connection. That callback consumed the same admission-time legacy notification, settled permission routes, and deleted the broker's active session before the executor could perform authoritative v4/snapshot reconciliation. The resumed incident therefore failed before `decidePermission()` was reached even though the persisted snapshot was `bypassPermissions` and the installed plugin matched the fix byte-for-byte.

ZCode 0.16.5 permission requests also carry a numeric `requestedAt` field. The captured fixture omitted it and the strict protocol validator rejected it. Compatibility must accept this bounded transport metadata while continuing to reject unknown fields.

## Goals

- Keep the exact turn armed after an admission-time legacy completion wake so later permission requests can be evaluated normally.
- Preserve the current destructive behavior of `waitForCompletion()` for every existing caller.
- Clear local turn state when `executeJob` reaches its real terminal or cleanup boundary.
- Keep the managed broker's upstream turn and permission route alive until the executor confirms its authoritative terminal/cleanup boundary.
- Accept the observed 0.16.5 `requestedAt` permission-request field.
- Cover the captured 0.16.5 event ordering with deterministic regression tests.

## Non-goals

- No change to `decidePermission`, permission snapshots, risk mapping, or offered-response validation.
- No new appserver flag, permission policy, broker ownership rule, or persisted schema.
- No reinterpretation of legacy completion as authoritative success or failure.
- No broad refactor of the protocol or executor lifecycle.

## Design

### Non-destructive legacy observation

Add a narrowly named protocol/client operation for observing the next validated completion notification without consuming the active turn. It must apply the same session, timeout, active-turn, duplicate-waiter, and `isCompletionFor` validation used by `waitForCompletion()`, but resolution must not call `abortTurn()` and must not consume turn ownership.

An observer timeout removes only that observer; it does not silently acquire authority to end the turn. Executor teardown remains responsible for local release. Add an idempotent client-level local release operation that cancels outstanding local completion observation and clears the protocol turn without sending an upstream stop request.

The existing `waitForCompletion()` remains unchanged in observable behavior: queued or live completion resolution consumes the turn, while timeout and cancellation retain their present destructive cleanup semantics.

Only `executeJob` switches its `legacyWake` construction to the non-destructive observer. The coordinator continues to use the wake solely to trigger authoritative v4/snapshot reconciliation.

### Explicit executor cleanup

Because the wake no longer consumes local state, `executeJob` must explicitly release the protocol turn after the authoritative lifecycle has finished. Cleanup belongs in the executor's existing unconditional teardown, after any terminal/cancellation reconciliation that may still need permission and turn identity, and before client close completes.

The cleanup operation is local and idempotent. It must not send `session/stop`, alter durable job state, or replace the existing cancellation paths. Successful terminal, provider failure, remote interruption, local abort, timeout, and error cleanup all converge on the same local turn release when a session was created or resumed.

### Managed broker terminal acknowledgement

For a direct appserver client, `releaseTurn()` remains local. For an authenticated managed-broker client, release first sends a narrow broker-only acknowledgement for the exact session turn, then clears the downstream local turn. The broker validates session ownership and the exact active socket/token, locally releases the corresponding upstream protocol turn, settles only that turn's pending permission tasks, and removes its active route. It must not call `session/stop`, release durable session ownership, or accept a stale/foreign acknowledgement.

The broker no longer treats a legacy `prompt_completed` notification as authority to delete its route. It forwards the validated notification to the active client as a wake and retains the upstream turn. Existing authoritative stop, owner-release, disconnect, protocol-close, and explicit terminal-acknowledgement paths remain responsible for cleanup.

### Permission request compatibility

The strict request validator accepts optional `requestedAt` only when it is a finite, non-negative safe integer timestamp. All existing required fields, risk levels, option validation, exact offered-response validation, and unknown-field rejection remain unchanged. The captured 0.16.5 fixture includes this field so broker and direct-client tests exercise the production request shape.

### Safety invariants

- A validated early legacy completion leaves `turnState(sessionId) === 'armed'`.
- A later permission request for that session reaches the configured handler and returns one offered response.
- A managed broker retains the exact route after an early legacy completion and forwards a later permission request.
- Only the exact owning client can acknowledge and release the broker turn.
- A 0.16.5 request with bounded `requestedAt` is accepted; malformed timestamps and unknown fields remain rejected.
- Authoritative executor teardown leaves `turnState(sessionId) === null`.
- Ordinary `waitForCompletion()` still leaves `turnState(sessionId) === null` immediately after resolution.
- Permission policy and durable job outcomes are unchanged.

## Testing

1. Add a protocol/client regression proving non-destructive observation preserves the armed turn and permits a subsequent permission request.
2. Retain or strengthen the destructive waiter assertion so its compatibility contract is explicit.
3. Add an executor regression with captured 0.16.5 ordering: admission, early legacy wake, later permission request, authoritative terminal, successful result, and final local turn cleanup.
4. Exercise cleanup on a non-success path so an observer cannot leave an armed turn behind.
5. Run focused tests, then `npm run check` before review and PR creation.
6. Add a broker-level captured-order regression where permission follows the false legacy completion, and assert explicit acknowledgement releases both protocol layers.
7. Exercise fresh and resumed managed execution with the same captured ordering.

## Rollout and compatibility

This is an internal additive API and a one-call-site migration. No user configuration or data migration is required. Older ZCode versions continue to produce the same wake signal, and all callers outside `executeJob` retain existing semantics.
