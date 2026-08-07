# Rescue Progress and Foreground Lifecycle Design

## Problem

Foreground `$zcode:rescue` currently sends one ZCode turn and then waits only for
its terminal `state.updated` notification. A healthy delegated task can therefore
produce no visible output for minutes even while ZCode is actively running tools.
If the foreground companion is interrupted, its durable job may also remain
`running` until a later same-owner reconciliation.

The observed failure mode was not a CPU deadlock: the nested Codex task continued
editing and running commands while the outer companion stayed silent. The user
could not distinguish that state from a dead process.

## Goals

- Surface bounded, user-safe ZCode activity during foreground review, adversarial
  review, and Rescue runs.
- Persist the latest activity so `$zcode:status` explains what an active job is
  doing without requiring private log inspection.
- Emit a periodic foreground heartbeat when ZCode has not produced a new activity
  event.
- Turn foreground `SIGINT` and `SIGTERM` into an acknowledged ZCode session stop
  and a durable cancelled job whenever the remote stop succeeds.
- Preserve the existing result, ownership, permission, recovery, and background
  execution contracts.

## Non-goals

- Do not expose model reasoning, message text, tool inputs, command arguments, or
  arbitrary `state.updated.patch` contents.
- Do not infer or kill process identifiers belonging to plugins or tools nested
  inside ZCode. `session/stop` is the supported cancellation boundary.
- Do not add a polling loop around `session/read`; progress must use notifications
  already delivered on the active protocol connection.
- Do not change the one-hour completion timeout or make inactivity itself a
  failure. A quiet but healthy task remains valid.
- Do not change `--background` semantics. Background work survives the launching
  Codex turn and is stopped through `$zcode:cancel` or session lifecycle cleanup.

## Approach

Use the existing ZCode protocol subscription as the common event boundary. A new
progress module converts only same-session `state.updated` notifications into a
small public event:

```js
{
  phase: 'starting' | 'running' | 'waiting' | 'finalizing',
  message: 'ZCode activity: tool call started',
  observedAt: '2026-08-08T00:00:00.000Z'
}
```

The normalizer accepts a bounded, control-free `reason` and maps known reason
families to stable phases. Unknown safe reasons are humanized without inspecting
their patch. Terminal reasons become `finalizing`. Invalid, oversized, cross-
session, or non-`state.updated` notifications are ignored.

The reporter has two sinks:

1. Foreground stderr receives `[zcode] <message>` immediately.
2. The durable job stores `phase`, `lastActivityAt`, and the four most recent
   progress messages. Messages are bounded and schema-validated by the state
   store. Repeated identical activity is deduplicated.

Progress persistence is serialized behind a small internal promise chain. It may
not overturn terminal state: if cancellation or completion wins first, a late
progress update observes the terminal job and becomes a no-op. Before publishing
the final result, the executor drains the progress chain.

## Heartbeat

Foreground commands start a 20-second unref'd heartbeat after the remote turn is
accepted. If no new activity has arrived, stderr receives a line such as:

```text
[zcode] Still waiting for ZCode; last activity 42s ago.
```

The heartbeat is observational only. It does not update `lastActivityAt`, does
not enter the durable progress preview, and never extends a timeout. Background
workers do not emit heartbeats because their stdio is intentionally detached.

## Status Rendering

`$zcode:status <job-id>` renders:

- job ID, command, status, and phase;
- start/finish timestamps and elapsed/duration;
- last ZCode activity timestamp;
- up to four recent progress messages;
- the existing model-policy summary.

`$zcode:status --all` keeps one compact line per job and adds phase plus the most
recent progress message. JSON output includes the same public fields through the
existing redaction boundary. `$zcode:result` remains unchanged.

## Foreground Interruption

The executable entry point installs temporary `SIGINT` and `SIGTERM` handlers for
foreground invocations only and passes an `AbortSignal` through the companion to
the active executor. Once a ZCode turn has been accepted:

1. Abort rejects the completion wait with a stable interruption error.
2. The executor requests `session/stop` on its existing authenticated client.
3. After stop acknowledgement, it transitions `running -> cancelling ->
   cancelled`, records `finishedAt`, and closes the client.
4. The process exits with 130 for `SIGINT` or 143 for `SIGTERM` and emits a concise
   stderr explanation rather than a misleading protocol error envelope.

If ZCode does not acknowledge the stop, the job remains `running` with a bounded
`lastCancelError`. That conservative state allows existing recovery to inspect
the remote session later instead of falsely claiming cancellation.

Signals received before a remote turn is accepted abort local setup and allow the
existing failure path to settle the reservation. Background workers retain their
current signal behavior so explicit cancellation remains the single owner of
their terminal transition.

## State and Security Invariants

- `phase` is from a fixed public vocabulary.
- `progressPreview` contains at most four control-free strings, each at most 256
  UTF-8 bytes.
- `lastActivityAt` is an ISO timestamp not earlier than `startedAt` and not later
  than the job's updated timestamp.
- Notification content never reaches output unless it passes the bounded
  normalizer.
- Progress updates do not change ownership, permission snapshots, worker leases,
  accepted-turn boundaries, result artifacts, or terminal status.
- Existing redaction still removes capabilities, tokens, and permission state
  from JSON output.

## Testing

Tests follow red-green-refactor and cover:

- safe same-session normalization, known/unknown reasons, terminal mapping,
  cross-session rejection, control characters, and byte limits;
- foreground stderr delivery, deduplication, heartbeat timing, and cleanup;
- durable progress schema validation, terminal no-op behavior, and retention of
  only four messages;
- status text/JSON rendering for active and terminal jobs;
- interruption after accepted send, acknowledged stop, stop failure, correct exit
  codes, and absence of signal handling in background workers;
- integration with the fake ZCode peer emitting intermediate notifications;
- the complete existing `npm run check` suite.

## Release Notes

The patch updates both READMEs and `CHANGELOG.md` to describe live foreground
activity, status previews, heartbeat behavior, and the foreground cancellation
boundary. The package version remains unchanged until the release step selected
by the maintainer.
