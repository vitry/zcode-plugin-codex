# ADR 0012: Enforce LF Line Endings

## Status

Accepted — 2026-08-12

## Context

Windows checkout conversion has repeatedly changed release payload bytes from LF
to CRLF. Those changes surfaced later as misleading TOML, Markdown, snapshot,
and integration-test failures. A `.gitattributes` rule reduces that risk, but it
does not prove that every release path continues to enforce the same policy.

## Decision

All Git-tracked text files use LF line endings. This includes generated
marketplace text payloads. The repository root keeps this normalization rule:

```gitattributes
* text=auto eol=lf
```

`npm run check:line-endings` is the single executable policy. It obtains its
candidate set from Git, reads tracked working-tree files as bounded byte
sequences, skips binary data containing NUL, and rejects CRLF in every tracked
text file outside an explicit checker allowlist. The allowlist is empty unless a
future tracked fixture has a documented need for literal CRLF data.

CI runs the checker in a distinct named step immediately after `npm ci` and
before lint, typechecking, tests, packaging, or snapshot work. `npm run check`
also starts with the checker so local and CI verification use the same entry
point. Diagnostics contain portable repository-relative paths and never expose
absolute checkout paths.

CRLF remains permitted as runtime or test-generated data when a test needs to
exercise protocol compatibility. Such data must be created dynamically and
must not be committed as an unallowlisted text fixture. Untracked, ignored,
credential, dependency, and temporary files are outside this repository policy.

## Consequences

- A line-ending violation fails early, before platform-sensitive tests can emit
  secondary failures.
- Generated marketplace payloads are covered because they are Git-tracked.
- Windows, macOS, and Linux use identical committed text bytes.
- Any exception requires an explicit checker allowlist entry and corresponding
  documentation and tests.
