# ZCode 0.16.5 True Turn Terminal Compatibility Design

## Problem

ZCode CLI 0.16.5 changed `app.sendInput()` into a two-stage admission API. The legacy `session/send` adapter awaits admission but does not await the returned `completion` promise, so it emits `state.updated/prompt_completed` and clears its active abort controller before the runtime turn starts. The plugin currently treats that legacy notification as authoritative completion, reads a transitional snapshot, and may fail the job or acknowledge a stop that does not cancel the later turn.

The same ZCode release still publishes the real runtime lifecycle through `v4/conversation/frame`. A `turnHeader` row transitions from `running` to `completedSuccess`, `completedInterrupted`, or `failed`. The plugin currently discards this channel because the 0.16.5 subscribe acknowledgement added an `openTiming` field and the plugin rejects response objects with additional fields.

## Compatibility Principle

ZCode app-server responses and notifications are upstream-owned, open-world protocol objects. The plugin validates every field it consumes, together with existing byte, depth, cardinality, identifier, path, and prototype-safety bounds, but it must not reject a response merely because it contains an additional field.

Plugin-owned requests, persistent records, capabilities, and CAS inputs remain closed-world and strictly shaped.

No version-specific `0.16.5` branch or `openTiming` special case will be introduced. Compatible additive fields are ignored by default.

## Authoritative Completion Model

The legacy `prompt_completed` notification becomes a liveness/wakeup signal only. It cannot terminalize a job.

The primary success/failure signal is a validated v4 `turnHeader` lifecycle observed after the accepted send boundary:

- `running` identifies the new runtime turn.
- `completedSuccess` is a successful terminal candidate.
- `completedInterrupted` is an interrupted terminal candidate.
- `failed` is a failed terminal candidate.

Historical or replayed terminal rows cannot finish the current turn. The observer must correlate a terminal row with a new `turnHeader` first observed after the current send boundary. Recovery/snapshot frames may restore lifecycle continuity but cannot silently substitute an unrelated historical turn.

After a v4 terminal candidate, the plugin performs an authoritative `session/read`. A successful result is published only when the snapshot contains the current turn's message lineage and completed assistant record.

## Snapshot Fallback

The v4 stream is preferred but not mandatory. Subscription may be unavailable, rejected, disconnected, overflowed, or temporarily require recovery. After the legacy notification wakes the completion path, a bounded-cadence snapshot reconciliation loop remains active until it proves one of these states:

- current-turn success: a new real-user root beyond `beforeMessageIds`, a linked assistant record that is completed, and a non-active projection;
- current-turn failure: an explicit terminal error attributable after the accepted boundary;
- current-turn interruption/cancellation: explicit terminal lifecycle and coherent snapshot evidence;
- still pending: initial-empty projection, schema-transitional read, empty idle snapshot, current user without a completed assistant, or active projection.

Schema-invalid reads during this known transition are retryable only inside the accepted-turn coordinator. Ordinary `session/read` callers retain fail-closed validation.

There is no normal completion timeout. Existing abort/session-end/cancellation control remains responsible for ending an indefinitely running model turn.

## Cancellation and Recovery

An empty successful `session/stop` response is not sufficient cancellation proof during the 0.16.5 admission/start gap. A job remains `cancelling` while current-turn evidence is unresolved. If the current turn later appears active, cancellation issues another guarded stop. The job becomes `cancelled` only after coherent terminal/cancelled evidence; otherwise it remains recoverable rather than being falsely terminalized.

Foreground execution, orphan recovery, session-end settlement, and cancellation must share one current-turn snapshot classifier. They may choose different actions for the same classification, but they cannot disagree about whether `idle + no current-turn messages` is terminal.

Binding and job storage schemas do not change. This repair requires no binding migration.

## Components

1. `zcode-client.mjs` accepts additive upstream response fields while validating the fields it consumes.
2. `conversation-progress.mjs` exposes a bounded, validated current-turn lifecycle signal in addition to public progress descriptions.
3. A focused turn-terminal module classifies snapshots and coordinates v4 terminal signals with snapshot fallback.
4. `review.mjs` uses the coordinator instead of treating legacy completion as terminal.
5. `recovery.mjs` and cancellation settlement reuse the classifier and preserve unresolved jobs.

## Error Handling

- Malformed or missing consumed fields still fail closed.
- Unknown additive fields are ignored and never rendered, persisted, or interpreted.
- Conversation gaps or incompatible frames disable event authority and fall back to snapshots.
- Transitional read errors are not published as job failures while the accepted turn remains unresolved.
- Explicit ZCode terminal failures retain their bounded public error message.
- Local storage/CAS/ownership errors keep their existing precedence and compensation behavior.

## Testing

Tests will reproduce the captured 0.16.5 ordering:

1. legacy `prompt_completed` before the true runtime start;
2. initial-invalid, empty-idle, running-user, unfinished-assistant, and completed-assistant snapshots;
3. v4 `turnHeader` running-to-terminal lifecycle;
4. additive fields on acknowledgements, frames, deltas, and rows;
5. fresh and continuation turns;
6. subscription unavailable/gapped fallback;
7. stop acknowledged before runtime start, followed by a guarded second stop;
8. recovery refusing to terminalize an unresolved empty-idle snapshot;
9. unchanged normal behavior for the existing 0.16.3 fixtures.

Focused tests must demonstrate RED before production changes, then GREEN. The full repository check and real isolated 0.16.5 probe are required before the PR is considered ready.
