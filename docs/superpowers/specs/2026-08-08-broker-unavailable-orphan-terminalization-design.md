# Broker-Unavailable Orphan Terminalization

## Context

A writable Rescue job can outlive its Codex owner or worker. The plugin already
uses an exact worker lease to distinguish a live executor from a local orphan,
then tries to inspect and stop the persisted ZCode session through the existing
workspace broker. Today, if that broker is absent, unreachable, or no longer has
an existing ZCode Protocol child, recovery leaves the job active. The durable
writable guard then blocks every later Rescue even though the plugin no longer
has a usable control channel.

Codex exposes `SessionEnd`, but an older orphan may have missed that hook or may
have been created before the lifecycle fix was installed. Both SessionEnd and
reservation-time scavenging therefore need the same terminal policy.

## Decision

Treat loss of the existing ZCode control channel as a terminal orphan condition
after local liveness has been resolved. Transition the exact durable job to
`failed`, preserve a bounded diagnostic explaining that the orphan was archived
because its broker control channel was unavailable, and release the workspace
writable guard.

This is an abandonment policy, not proof that ZCode acknowledged `session/stop`.
The plugin must not describe the job as cancelled or claim that the remote turn
was confirmed stopped.

Use the existing `failed` status rather than introducing `abandoned`. The error
message carries the distinction while the public state model remains small:

- `succeeded`: completion and result were proven.
- `cancelled`: cancellation was confirmed or a queued reservation was cancelled
  before remote execution.
- `failed`: execution failed, recovery proved the session missing, or the plugin
  abandoned an orphan after losing its control channel.
- `running` or `cancelling`: execution may still be controllable and retains the
  writable guard.

## Eligibility and Boundaries

Reservation-time scavenging may terminalize a broker-unavailable job only after
the existing orphan selection rules prove its worker lease is free. A held exact
worker lease continues to block admission and prevents any remote inspection.
Because this path is entered by a new Rescue request, it may use the existing
managed-client behavior to start or recover a broker and query the persisted
session before giving up. SessionEnd remains existing-only and never starts a
broker or ZCode process.

SessionEnd may terminalize only the ending Codex session's exact active writable
Rescue job after proving its exact worker lease is free. A held lease prevents
broker-unavailable archival for queued, running, and cancelling jobs. SessionEnd
retains its existing owner lifecycle authority to inspect and stop an accepted
running turn through a reachable broker even while that worker lease is held.

The terminal broker-unavailable cases are:

1. No healthy identity exists for the exact writable Rescue broker profile.
2. Existing-only client lookup returns `null`, explicitly proving that no
   healthy broker is available for SessionEnd.
3. The broker is reachable, but existing-only access reports that it has no
   existing ZCode Protocol child.
4. A previously established control connection reports `ZCODE_DISCONNECTED`.

A correctly queried `session/list` that omits the persisted `zcodeSessionId`
remains a separate, already-terminal missing-session condition: the session was
created previously but is no longer present in the queried ZCode catalog.

The following conditions remain nonterminal:

- An exact worker lease is held.
- Client creation fails with a local configuration, storage, validation, or
  other error that is not an explicit control-channel-unavailable code.
- A healthy broker and protocol are reachable, but `session/read` fails or times
  out for a reason other than an explicit disconnect.
- A healthy broker and protocol receive `session/stop`, but the request is
  rejected, times out, or otherwise lacks acknowledgement.

These distinctions prevent a transient operation failure on a known-live
control channel from being mistaken for total loss of that channel.

## Data Flow

For reservation-time recovery:

1. Select the durable active writable Rescue and acquire its cancellation lock.
2. Reread and validate owner, command, status, and exact worker lease.
3. If the lease is held, return unchanged.
4. If the lease is free, reconcile the durable owner mapping and establish the
   normal managed recovery client, starting or recovering a broker if needed.
5. If the exact control channel is unavailable, transition the job to `failed`.
6. The caller performs its one existing atomic reservation retry, which can now
   admit the new Rescue.

For SessionEnd:

1. Select only the ending owner's active writable Rescue under its cancellation
   lock and reread it.
2. Preserve the queued-worker lease rules and completion-wins race handling.
3. Attempt existing-only settlement without spawning a broker or ZCode process.
4. If the exact control channel is unavailable, reacquire the exact worker lease
   without waiting and transition the job to `failed` only when that proves the
   worker is gone. A held lease leaves the job active.
5. Continue generic owner release and caller-state cleanup as advisory cleanup.

## Concurrency and Ownership

All terminal transitions remain under the per-job cancellation lock. Executors
publish successful artifacts under the same lock, so a proven completion that
wins the lock remains `succeeded`; maintenance must reread and return that
winner. A maintenance terminal transition prevents a late executor from writing
or publishing a result.

The internal reconciler derives `ownerId` only from the schema-validated durable
job. Public status, result, cancel, and resume ownership does not change. A
sibling session can trigger reservation-time maintenance but cannot adopt or
read the old job.

## Diagnostics and User Experience

The terminal error must be bounded by the existing recovery-message limit and
must distinguish at least:

- existing broker unavailable during SessionEnd settlement;
- managed broker/control channel unavailable during orphan recovery;
- existing ZCode Protocol unavailable within a reachable broker;
- persisted ZCode session missing from the correct session catalog.

`$zcode:status --all` remains redacted. Users only need to retry Rescue; no
manual force command, job-file deletion, or protocol-level recovery is exposed.

## Tests

Add test-first coverage proving:

- SessionEnd with a free exact worker lease and an absent or unreachable exact
  broker records `failed`, starts no broker or ZCode child, and still cleans
  caller state.
- SessionEnd with a reachable broker but no existing protocol records `failed`.
- SessionEnd with a held exact worker lease and an unavailable broker remains
  active, while reachable-broker read/stop settlement remains available.
- Native and caller-defined abort reasons propagate exactly and never archive
  the durable job; generic client-creation failures remain active with a bounded
  diagnostic.
- Reservation scavenging with a free exact worker lease and absent/unreachable
  broker records `failed`, then admits the new owner in the same Rescue attempt.
- The historical-orphan shape (persisted session ID, dead worker, no broker)
  becomes terminal on the next reservation.
- A held exact worker lease still prevents inspection and leaves owner B blocked.
- A reachable protocol whose `session/stop` is rejected or times out remains
  active and continues to block.
- Completion and terminal-publication races retain the existing winner semantics.
- Owner-only access and redacted workspace status remain unchanged.

Update English and Chinese lifecycle documentation and the Unreleased changelog
to describe broker-unavailable orphan archival without claiming confirmed remote
stop.
