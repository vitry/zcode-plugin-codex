# Rescue Progress and Foreground Lifecycle Design

## Problem

Foreground `$zcode:rescue` currently sends one ZCode turn and then waits only for
its terminal `state.updated` notification. A healthy delegated task can therefore
produce no visible output for minutes even while ZCode is actively running tools.
If the foreground companion is interrupted, its durable job may also remain
`running` until a later same-owner reconciliation.

The same owner-only recovery becomes a permanent workspace denial of service
when the Codex session or worker disappears without completing the signal path.
Writable exclusion scans every active Rescue in the workspace, but startup
reconciliation currently scans only the new caller's jobs. A later Codex session
therefore cannot reserve a Rescue even when the old executor is provably gone.

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
- Settle a writable Rescue whose exact executor has disappeared so it cannot
  block the workspace forever after owner-session death, parent crash, or pipe
  loss.
- Preserve exact user-visible ownership while allowing bounded internal
  lifecycle maintenance to act on a validated durable job.
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
- Do not transfer, adopt, expose, or grant user-facing access to another Codex
  session's job, result, permission snapshot, or ZCode session.
- Do not release the writable guard while an exact worker lease is held or a
  remote stop remains unacknowledged.
- Do not add a public force-release command or a read-only Rescue mode.

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
families to stable phases and fixed public messages. Unknown safe reasons produce
the generic message `ZCode reported activity`; their raw value and patch are not
rendered. Terminal reasons become `finalizing`. Invalid, oversized, cross-session,
or non-`state.updated` notifications are ignored.

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

## Orphaned Writable Rescue

A nonterminal claimed job is orphaned only when an internal nonblocking attempt
can acquire its exact worker lease. The operating system releases the advisory
lock when the worker exits; timestamps and PIDs are not used to evict a claimed
lease. A held lease ends recovery immediately without remote inspection, stop,
or state mutation.

An unclaimed queued reservation has no persisted lease identity to probe. It
retains the existing five-minute worker-claim grace period: during that interval
maintenance leaves it untouched so a foreground caller or newly spawned child
can claim it. After the grace expires, the reservation becomes a failed launch
under the cancellation lock. This bounded compatibility rule closes the crash
window between reservation and lease claim without treating a known held lease
as stale.

Before reserving a new writable Rescue, the companion first attempts the normal
same-owner reconciliation. If atomic reservation still reports
`WRITABLE_JOB_EXISTS`, it runs one internal workspace scavenging pass over active
writable blockers and retries reservation once. Each blocker is settled under
its existing per-job cancellation lock and is reread after lock acquisition.
The final reservation remains under the existing workspace state lock, so two
new sessions racing through scavenging can admit at most one writable Rescue.
No remote I/O occurs while the workspace state lock is held.

The scavenger derives a Lifecycle Maintenance Principal from the validated
durable job's original `ownerSessionId`. It uses that stable internal principal
and the workspace-private broker credential only to restore the job's existing
broker ownership, inspect its one persisted ZCode session, stop it when required,
and settle local state. The new caller cannot supply this identity. The
scavenger does not change `ownerSessionId`, return old remote content, or bypass
the existing owner checks used by status, result, cancel, and resume.

After a claimed worker lease is proven free, or an unclaimed reservation exceeds
the claim grace period:

- A queued job, a job without an accepted remote session, or a missing remote
  session becomes `failed` with a bounded lifecycle error.
- A remote `completed` or `idle` turn is extracted through the existing accepted
  turn boundary, persisted as an owner-scoped result artifact, and becomes
  `succeeded`.
- A remote terminal error or paused turn becomes `failed` when the durable job
  was `running`. A `cancelling` job in paused state repeats `session/stop` and
  becomes `cancelled` only after acknowledgement.
- A remote `running` or `waiting` turn is stopped. After acknowledgement, the
  session is read once more: a provable completed result wins and becomes
  `succeeded`; otherwise a `cancelling` job becomes `cancelled` and a `running`
  lost-executor job becomes `failed`.
- Malformed, stale, or ambiguous remote state follows the same stop-proof rule.
  An acknowledged stop permits status-appropriate terminalization: `cancelled`
  from `cancelling`, or `failed` from `running`. An unacknowledged stop retains
  `running`, records a bounded `lastCancelError`, and continues to guard the
  workspace.

Scavenging is internal lifecycle settlement, not a user cancellation. It returns
no old-job payload. If the blocker cannot be safely settled, the public command
keeps the stable `WRITABLE_JOB_EXISTS` envelope with an honest remedy to retry
later or inspect the redacted workspace list using `$zcode:status --all`.

## SessionEnd Settlement

The SessionEnd hook continues to target only the ending Codex session and never
starts a new broker or ZCode process. Before generic owner release, it prioritizes
the ending owner's active writable job and settles it under the job cancellation
lock. An unclaimed queued reservation is cancelled atomically; a later worker
claim then fails. A claimed queued job whose lease remains held is left for the
worker or later scavenging; if that exact lease is already free, SessionEnd
cancels the abandoned pre-remote reservation.

For a job with an accepted remote session, the hook uses a bounded
existing-broker-only client for the job's exact wire profile and original owner.
This client may read, stop, and reread through a healthy broker that already
exists, but it cannot call broker ensure/start or spawn ZCode. It reads before
stopping so a completed turn becomes `succeeded`. If the turn is active, it
requests `session/stop`; after acknowledgement it reads once more so completion
that raced the stop still wins. Otherwise the explicit owner-session end becomes
`cancelled`. Missing broker, timeout, malformed state, or unacknowledged stop
leaves the job nonterminal for reservation-time scavenging.

Only after this job settlement attempt does the hook call the existing generic
owner-release routine to stop untracked or read-only sessions and remove exact
owner mappings. Generic `releasedSessionIds` are cleanup results, not durable
cancellation evidence: a historical mapping can be released without a live
protocol or `session/stop`, so those IDs never drive job transitions. The hook
then removes ending-session caller, turn, and gate state. All work stays within
the existing bounded advisory hook budget; reservation-time scavenging is the
correctness fallback for crashes, missed hooks, and unavailable brokers.

## Locking and Race Order

The recovery lock order remains:

1. per-job cancellation lock;
2. state reread and nonblocking exact worker-lease acquisition;
3. broker ownership/client operation;
4. result-artifact lock when completion is recovered;
5. atomic state transition.

Executor completion, user cancellation, SessionEnd, and orphan scavenging all
serialize on the same cancellation lock before terminal publication. Terminal
state is never overwritten. A late worker cannot revive a terminal job, and a
second scavenger observes the first outcome idempotently. The workspace state
lock continues to serialize only state reads/writes and final reservation; it is
never nested around broker calls.

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
- Orphan settlement never changes the job's owner or exposes its result to the
  session that triggered maintenance.
- Lifecycle maintenance accepts no public owner or remote-session identifier;
  both come from a schema-validated job in the canonical workspace.
- A held worker lease or unacknowledged remote stop keeps the writable guard.

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
- cross-owner scavenging with held and released worker leases, remote completed,
  missing, active-acknowledged, and active-unacknowledged states;
- concurrent scavenging and reservation admitting at most one writable Rescue;
- SessionEnd acknowledged, failed, queued, terminal-race, and sibling-owner
  settlement;
- unchanged same-owner status, result, cancel, and resume isolation after an
  internally recovered result;
- the corrected `WRITABLE_JOB_EXISTS` remedy without an invented read-only Rescue
  surface;
- the complete existing `npm run check` suite.

## Release Notes

The patch updates both READMEs and `CHANGELOG.md` to describe live foreground
activity, status previews, heartbeat behavior, foreground cancellation, and safe
orphan settlement. The package version remains unchanged until the release step
selected by the maintainer.
