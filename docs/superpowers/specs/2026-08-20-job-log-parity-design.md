# Durable Job Log Parity Design

Date: 2026-08-20
Status: Approved design

## Objective

Add a private, durable, human-readable log for each ZCode job. Match the useful observability semantics of `codex-plugin-cc` while preserving ZCode's stricter task-blind Rescue routing, owner isolation, and authoritative terminal-result boundary.

The public status command keeps its current grammar:

```text
$zcode:status [job-id] [--wait] [--timeout-ms <milliseconds>] [--all]
```

No `--log` option or separate log command is added. An exact-owner detailed job status displays the log path as `Log: <absolute-private-path>`, matching `codex-plugin-cc`. Compact listings and other-owner projections never expose it.

## Non-goals

- Do not persist raw command stdout or stderr.
- Do not persist arbitrary tool input, output, errors, metadata, file contents, patch bodies, environment values, credentials, capabilities, or raw reasoning.
- Do not relay detailed log contents to Root.
- Do not make the Rescue child task-aware.
- Do not add log export, search, rotation, expiry, deletion, or reading commands.
- Do not import `codex-plugin-cc`'s 50-job pruning policy. ZCode's existing durable retention and manual-cleanup model remains authoritative.
- Do not let a log or progress record establish terminal completion.

## Storage layout

Follow the `codex-plugin-cc` co-located job-file layout inside the existing private ZCode workspace store:

```text
$CODEX_HOME/plugins/data/zcode-<marketplace>/
└── workspaces/<workspace-hash>/
    └── jobs/
        ├── <job-id>.json
        └── <job-id>.log
```

After log creation succeeds, the job record gains an optional `logFile` field containing the exact absolute path computed for that job. It is valid only when it equals the canonical workspace jobs directory joined with `<job-id>.log`. A logging-disabled job omits the field. Arbitrary paths, traversal, another job's path, symbolic links, non-regular files, and replaced path identities fail closed.

The log is private plugin data. It is never written into the repository, plugin source, or plugin cache. It is retained with the durable job by default and is removed only through the existing proven workspace-data cleanup process.

## Job log module

Add a deep `job-log.mjs` module with this interface:

```js
createJobLog({ dataRoot, workspace, jobId, title })
appendJobLogEvent({ dataRoot, workspace, jobId, event })
appendJobLogBlock({ dataRoot, workspace, jobId, title, body })
resolveJobLogFile({ dataRoot, workspace, jobId })
```

Callers cannot supply a filesystem path. The implementation owns:

- exact path derivation;
- private directory and file permissions;
- symbolic-link, containment, and file-identity checks;
- timestamped human-readable formatting;
- serialization of appends for one job;
- bounded accepted input shapes;
- conversion of logging failures into an observationally disabled sink.

The module interface is the test seam. State, progress, execution, recovery, rendering, and tests do not reproduce path or append logic.

## Recorded content

### Semantic events

Every progress event already accepted by the existing schema-validated and allowlisted progress pipeline is appended as one timestamped line. Examples include:

```text
[2026-08-20T10:00:00.000Z] ZCode started the delegated turn.
[2026-08-20T10:00:01.000Z] Running command: npm test.
[2026-08-20T10:00:02.000Z] Command completed: npm test (1200ms).
[2026-08-20T10:00:03.000Z] Editing: src/example.ts.
[2026-08-20T10:00:04.000Z] Edit completed.
```

The existing `progressPreview` remains a four-entry window for compact status. While its sink remains healthy, the log retains every safe event successfully dispatched by the existing bounded progress pipeline; it does not broaden which events are accepted or override the pipeline's existing overflow behavior.

### Assistant messages

After the authoritative terminal session read, append current-turn assistant text only when it is:

- schema-valid;
- visible and not ignored;
- linked to the exact accepted input/current turn by the existing result-linkage rules; and
- not a historical, unrelated, synthetic, hidden, or reasoning-only message.

Use a block format:

```text
[2026-08-20T10:00:05.000Z] Assistant message
Visible assistant text
```

ZCode `reasoning` parts are not equivalent to Codex app-server `reasoningSummary` items and are not persisted. A future explicit, schema-validated summary field may be added through a separate design.

### Final output

After authoritative result extraction succeeds, append the rendered public result as the `Final output` block. The result artifact remains the source of truth for `$zcode:result`; the log is observational duplication for inspection.

For failed or cancelled jobs, append only existing safe fixed lifecycle/error projections. Never append raw exception objects, provider payloads, transport stderr, or rejected frame contents.

## Data flow

```text
ZCode structured activity
        │
        ├─ child stderr: live [zcode] semantic progress
        ├─ job.json: phase, lastActivityAt, last four previews
        └─ jobs/<job-id>.log: all accepted safe semantic events

revision-guarded terminal session read
        │
        ├─ current-turn visible assistant block in the job log
        ├─ results/<job-id>.md authoritative result artifact
        └─ Final output block in the job log
```

Root continues to receive only the fixed coarse Rescue relay messages and terminal public stdout. Detailed semantic progress stays in the child transcript and private job log.

## Status and ownership

The status command accepts no new flags.

For an explicit exact-owner job query, detailed rendering adds:

```text
Log: /absolute/private/path/jobs/<job-id>.log
```

The path is omitted from:

- compact job listings;
- `--all` projections for another owner;
- sibling-session requests;
- the bound Rescue status sidecar unless that sidecar's existing fixed projection is separately expanded by a future design;
- Root progress relays and terminal notifications.

Knowing a path or job ID does not grant plugin-level access. Existing canonical-workspace and owner checks remain mandatory before detailed status rendering.

## Failure semantics

Logging is observational:

- Failure to create or append a log cannot change the ZCode job's success, failure, cancellation, or recovery result. A create failure leaves `logFile` absent; an append failure retains the already-created path and content.
- After a log sink fails, disable further writes for that execution and retain the existing progress, result, and cancellation flows.
- Expose only a fixed safe diagnostic through existing diagnostic mechanisms; do not include the path or raw filesystem error.
- Progress-preview persistence and job-log persistence fail independently.
- Terminal completion remains authoritative only through the accepted foreground operation and revision-guarded final session read.
- A result artifact publication failure retains its existing authoritative semantics; a successful log append cannot compensate for it.

## Lifecycle

Logs follow ZCode's existing durable-history policy:

- retained by default with job history;
- available after the initiating parent turn or Rescue child is lost;
- not deleted automatically on plugin uninstall;
- retained during selective runtime-state cleanup;
- deleted only when the proven plugin-owned workspace data is explicitly erased.

The manual uninstall documentation must name `jobs/<job-id>.log` as retained diagnostic history. No automatic pruning, retention timeout, log rotation, or per-log delete interface is introduced.

## Implementation isolation and parallel work

All implementation occurs on branch `feature/zcode-job-logs` in the isolated worktree `.worktrees/progress-history`. The baseline suite passed before design changes: 1,516 tests passed, 3 opt-in tests skipped, and both marketplace build integration tests passed.

Parallel work is divided by non-overlapping file ownership:

1. Job-log module and focused storage tests.
2. State schema, owner projection, status rendering, and their tests.
3. Progress and terminal/finalization integration with execution tests.
4. README, SECURITY, changelog/manual-uninstall, and static contract tests.

Agents must not revert or overwrite another workstream. Root integrates the workstreams, resolves intentional interface dependencies, updates mirrored marketplace files through the repository's established build process, and runs the complete suite.

## Test requirements

### Storage

- Resolve the log beside its exact job JSON.
- Create private regular files and preserve exact append order.
- Reject traversal, wrong job IDs, wrong workspace paths, symbolic links, ancestor symbolic links, and replaced file identities.
- Keep concurrent jobs isolated.
- Treat create/append failures as observational.

### Content safety

- Persist every accepted safe semantic event, even when only the last four remain in `progressPreview`.
- Never persist raw tool input/output/error fields, command output, file content, patches, metadata, identifiers outside the allowed preview, credentials, capabilities, hidden messages, or raw reasoning.
- Persist only current-turn visible assistant text selected by existing exact linkage rules.
- Append the authoritative final output once.

### Status and ownership

- Exact-owner detailed status displays `Log:`.
- Compact lists do not display it.
- Foreign `--all` projections and sibling sessions do not display it.
- The status argument grammar remains unchanged and rejects `--log`.

### Lifecycle and integration

- Cover foreground, background, resume, recovery, failure, cancellation, and SessionEnd settlement paths.
- Prove logging failure cannot alter an authoritative terminal winner.
- Prove progress and log ordering remain bounded and deterministic during cleanup.
- Keep source and marketplace payloads byte-consistent where required.
- Run the complete Node test suite and marketplace snapshot build tests.

## Documentation changes

Update English and Chinese README material, SECURITY, CHANGELOG, and manual uninstall guidance to state:

- detailed safe semantic activity is retained in a per-job private log;
- exact-owner detailed status shows its path;
- raw tool output, raw reasoning, file contents, credentials, and capabilities remain excluded;
- logs are retained after uninstall until proven workspace-data cleanup;
- progress and logs remain observational, never terminal authority.
