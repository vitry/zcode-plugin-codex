# ZCode Terminal Result Parity Design

## Problem

The incident recorded in `log/20260820-104134-zcode-rescue-protocol-failure.txt` exposed two related lifecycle failures:

1. ZCode emitted a failed terminal turn after provider stream recovery was exhausted, but the Companion attempted to extract a successful assistant result and reported `ZCODE_RESULT_MISSING` instead of the real terminal failure.
2. The natural-language prompt `通过 $zcode:result 可以查到结果吗` was reconstructed as `result 可以查到结果吗`, causing the trailing prose to be rejected as a malformed job ID instead of performing the documented no-ID lookup.

The sibling implementation `../codex-plugin-cc` is the highest-authority behavioral reference for this repair. It treats completed, failed, and cancelled jobs as finished results; preserves failure messages; and defaults result lookup to the latest finished job owned by the current host session.

## Goals

- Preserve an explicit ZCode terminal failure instead of replacing it with a missing-result error.
- Never promote intermediate assistant text or tool output to an authoritative final result.
- Make failed and cancelled jobs queryable through `$zcode:result`, matching `codex-plugin-cc` semantics.
- Show persisted terminal errors through both `$zcode:result` and `$zcode:status`.
- Make natural-language no-ID result requests equivalent to an empty optional job-ID argument.
- Preserve exact explicit job-ID lookup and rejection of command-form malformed IDs.
- Keep ownership, workspace, and private Rescue boundaries unchanged.

## Non-goals

- Recovering a successful result that ZCode never produced.
- Returning partial assistant prose from a failed turn.
- Reading raw ZCode logs or reopening a ZCode session during result/status queries.
- Adding job-ID prefix matching; the local plugin's exact 64-character ID contract remains unchanged.
- Redesigning hook identity storage or adding a new structured invocation transport.
- Migrating historical failed job records whose stored error already lost the underlying reason.

## Reference Behavior

`codex-plugin-cc` provides the following authoritative behavior:

- `resolveResultJob` selects any terminal job: completed, failed, or cancelled.
- A no-ID result lookup selects the newest terminal job scoped to the current host session.
- `renderStoredJobResult` returns captured output when available, otherwise renders the stored terminal error.
- Status rendering includes failed-job diagnostics.
- Explicit host command arguments arrive through `$ARGUMENTS`; the Codex plugin must adapt its recorded-prompt bridge to equivalent optional `[job-id]` semantics.

## Design

### 1. Classify terminal ZCode failure before success extraction

After `waitForCompletion` and the authoritative final `session/read`, foreground execution will inspect `finalSnapshot.projection.status` before calling `extractFinalResult`.

- When status is `error`, throw a stable `PluginError` with code `ZCODE_TURN_FAILED`.
- Use the schema-validated `projection.lastError.message` as the bounded public reason when present.
- Fall back to a fixed generic message when the protocol supplies no usable reason.
- Persist the resulting error through the existing failed-job finalization path.
- Only `completed` or `idle` success-compatible terminal states may proceed to assistant-result extraction.
- Any other status observed after the completion wait is an ambiguous protocol terminal and fails closed with a distinct fixed protocol error; it must not enter success extraction.

The existing orphan-recovery behavior already classifies `projection.status === 'error'` before attempting result recovery. Foreground execution will follow that established pattern.

The assistant message's broad `info.error` object may prove that a response failed, but it is not the primary public error source. The strict projection `lastError` contract is preferred. Partial or earlier assistant text remains ineligible.

### 2. Treat every terminal job as result-eligible

Implicit result selection will use the same terminal set as the reference implementation:

- `succeeded`
- `failed`
- `cancelled`

The current owner-session and canonical-workspace restrictions remain mandatory. Explicit IDs continue to require the exact 64-character local job ID and the same owner.

Result behavior by status:

- `succeeded`: read and return the immutable result artifact exactly as today.
- `failed`: return a bounded stored failure report containing job ID, command, status, and persisted error message.
- `cancelled`: return a bounded stored cancellation report containing job ID, command, and status, plus a persisted cancellation reason when one exists.
- active states: remain ineligible for implicit result selection and produce the existing unfinished/status guidance when explicitly queried.

No failed or cancelled job receives a fabricated success artifact.

### 3. Render terminal errors in result and status

The public renderer will expose terminal failure information from the already validated job record.

- `renderJob` will include a bounded, control-safe terminal error line when `job.error.message` is present.
- Failed/cancelled result fallback will reuse the same safe job rendering instead of creating a second unbounded formatting path.
- Private owner session, turn, permission snapshot, prompt artifact, worker lease, and Rescue binding metadata remain redacted under existing public-job rules.

Result/status reads remain local and side-effect free. They do not inspect raw logs, contact ZCode, resume sessions, or reconcile result content beyond the existing owned-job reconciliation step.

### 4. Normalize optional job ID from natural-language Skill prompts

The Codex host does not provide a direct `$ARGUMENTS` variable. `parseRecordedInvocation` must adapt the recorded user prompt to the reference command's optional `[job-id]` interface.

For `result` and `cancel`:

- A command-form prompt whose trimmed text begins with the exact Skill marker keeps strict token parsing. This preserves malformed-ID rejection for direct invocations such as `$zcode:result not-an-id`.
- A marker embedded after natural-language text is treated as a Skill reference. The parser extracts a job ID only when the first argument-shaped token after the marker is an exact 64-character lowercase hexadecimal ID.
- If no exact ID immediately follows the embedded marker, trailing prose is not interpreted as command arguments and the invocation becomes a no-ID lookup.
- Flags or multiple marker occurrences remain governed by existing validation and fail closed where ambiguous.

`status` is excluded from this normalization because it has a broader option grammar (`--wait`, `--timeout-ms`, and `--all`). Rescue and review parsing are unchanged.

## Error Handling

- `ZCODE_TURN_FAILED` is a protocol/runtime terminal outcome, not a missing-result condition.
- Its remedy directs the user to inspect stored status/result details and retry only after resolving the reported ZCode/provider cause.
- `ZCODE_RESULT_MISSING` remains valid when a success-compatible terminal snapshot has no acceptable current-turn assistant response.
- An active, paused, waiting, or otherwise non-success status observed after the completion wait is reported as an ambiguous terminal-state protocol failure.
- Malformed command-form job IDs continue returning `ARGUMENT_INVALID`.
- Natural-language no-ID result requests reach owner-scoped terminal selection; if no terminal job exists, they return `OWNED_JOB_NOT_FOUND` with status guidance.

## Testing

Tests will be written before production changes and observed failing for the intended reason.

### Focused unit tests

- A final snapshot with `projection.status: 'error'` and `lastError` produces `ZCODE_TURN_FAILED`, not `ZCODE_RESULT_MISSING`.
- A success-compatible terminal snapshot without a visible final response still produces `ZCODE_RESULT_MISSING`.
- `通过 $zcode:result 可以查到结果吗` parses as `['result']`.
- An embedded marker followed by an exact job ID parses as `['result', id]`.
- `$zcode:result not-an-id` remains a strict malformed-ID invocation.
- Implicit result selection chooses the latest failed/cancelled/succeeded terminal job owned by the caller.

### Integration tests

- A simulated terminal ZCode provider failure persists the real bounded failure reason and exits nonzero.
- Installed-style `invoke result` against the original Chinese prompt returns the latest owned terminal job rather than `ARGUMENT_INVALID`.
- Result retrieval for a failed job renders its stored error.
- Status for a failed job renders the same stored error.
- A succeeded job continues returning its exact result artifact.
- Sibling-owner and cross-workspace lookups remain rejected.

### Verification

- Run the focused unit and integration files during red/green cycles.
- Run line-ending checks, lint, typecheck, and the complete non-qualified test suite.
- Rebuild the marketplace snapshot and verify source/snapshot parity.
- Run qualified tests only when their existing environmental prerequisites are available; report an unavailable qualification separately from product-test failures.

## Files Expected to Change

- `scripts/lib/review.mjs`
- `scripts/lib/invocation.mjs`
- `scripts/lib/job-control.mjs`
- `scripts/lib/render.mjs`
- `scripts/zcode-companion.mjs`
- focused tests under `tests/`
- generated marketplace snapshot counterparts
- `CHANGELOG.md` if required by repository release conventions

## Compatibility and Security

- No new child-facing fields, launcher arguments, environment variables, or authorization data are introduced.
- No task, prompt, job ID, session ID, or permission data moves into Rescue child messages.
- Existing exact owner and workspace selection stays authoritative.
- Error rendering is bounded and control-safe.
- Existing success result artifacts and review schemas are unchanged.
- The repair aligns public lifecycle behavior with `codex-plugin-cc` while retaining Codex-host-specific capability boundaries.
