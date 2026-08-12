# CI Line-Ending Constitution

## Problem

Windows checkout conversion has repeatedly changed committed LF payloads into
CRLF files. The resulting failures appeared far from checkout: exact TOML and
Markdown contracts changed bytes, generated marketplace payloads diverged, and
large Windows test runs produced misleading cascades. A `.gitattributes` rule
alone prevents the usual conversion but does not make the policy durable or
prove that CI still enforces it.

## Decision

The repository will enforce LF line endings at three independent layers:

1. ADR `docs/adr/0012-enforce-lf-line-endings.md` is the normative CI
   constitution. Every Git-tracked text file and generated marketplace text
   payload must contain LF line endings. CRLF is allowed only as data created
   inside a test at runtime; a tracked fixture containing literal CRLF must be
   explicitly documented and allowlisted in the checker.
2. Root `.gitattributes` normalizes text checkouts with
   `* text=auto eol=lf` on every operating system.
3. A repository checker scans Git-tracked files as bytes, rejects every CRLF
   sequence outside the explicit allowlist, and prints each violating relative
   path. CI runs this checker immediately after `npm ci`, before lint,
   typechecking, tests, package installation, or snapshot generation.

The checker reads its candidate set from Git rather than recursively walking the
working tree. It therefore excludes dependencies, temporary files, ignored
credentials, and build staging directories while still covering committed
marketplace output. It uses literal argv with `shell: false`, bounds aggregate
input and per-file size, rejects malformed Git output, and reports only relative
repository paths.

## CI and Local Entry Points

`npm run check:line-endings` is the single implementation entry point. The CI
workflow invokes it as a distinct named step immediately after dependency
installation, and `npm run check` invokes it before lint so local verification
matches CI. A violation exits nonzero before platform-sensitive tests can emit
secondary failures.

## Tests

Tests must prove:

- the checker accepts the current repository;
- a tracked CRLF file is rejected with its relative path;
- untracked and ignored CRLF files do not affect the result;
- the ADR, `.gitattributes`, package scripts, and CI step cannot be removed
  without failing the release-contract suite;
- the scan includes committed `marketplace/` payloads;
- Windows-style path separators in Git output are normalized safely.

The implementation will be developed RED first: release-contract assertions
will initially fail because the ADR, checker, scripts, and CI step do not exist.

## Scope

This decision changes repository checkout and verification policy only. It does
not normalize protocol frames, user-authored workspace files, runtime input, or
temporary test data. Existing tests may continue to synthesize CRLF in memory to
verify protocol compatibility.
