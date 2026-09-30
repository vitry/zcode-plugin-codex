# Isolate MCP research tests from routine development

Date: 2026-09-30

## Goal and boundary

Routine `npm test` and `npm run check` must not load or execute the four MCP feasibility-research test files. The tests remain in the repository and run through one explicit research command. This is a test-selection change, not a change to MCP gate decisions, the installed plugin, or production release qualification.

The four research entries are:

- `tests/mcp-context-probe.test.mjs`
- `tests/e2e/codex-mcp-context-e2e.test.mjs`
- `tests/direct-mcp-probe.test.mjs`
- `tests/e2e/codex-direct-mcp-feasibility.test.mjs`

Functional tests of production MCP code, including `mcp-result` and `mcp-lifecycle-controller`, remain in the routine suite. Existing explicit qualification commands retain their current meaning. The special `tests/integration/marketplace-snapshot-build.mjs` invocation remains part of `npm test`.

## Selected design

Keep the four files and the frozen reports at their current paths. Replace only the routine `npm test` auto-discovery invocation with a small cross-platform Node test-selection entry point that recursively lists the repository's test entry files, excludes exactly the four research paths, and passes the remaining entries to Node's test runner with the existing single-file concurrency setting. A separate `npm run test:mcp-research` explicitly invokes all four research files. Neither route silently promotes an opt-in real-host check: the two e2e validators retain their own opt-in requirements and must report skips honestly.

This is preferable to moving/renaming the test files, which would invalidate path references in the frozen investigation reports, and to `--test-skip-pattern`, which would still load the research test files and clutter routine output with skips. Direct `node --test` remains Node's unfiltered auto-discovery mode; the guaranteed routine boundary is the repository's documented `npm test` / `npm run check` path, including CI.

## Failure behavior and regression checks

- The selection entry point fails closed if a listed research path is missing, duplicated, or accidentally included in the routine file set. It uses Node APIs rather than shell globs so Windows and POSIX select the same files.
- A focused regression test first demonstrates that the previous `npm test` command still selects research files, then verifies the new routine selection excludes exactly those four and retains representative production tests. It also verifies the explicit research selection contains exactly those four.
- Update existing package-script contract tests that pin the old literal `npm test` command. Preserve their intent: routine tests and the marketplace snapshot integration both run.
- Run the selection regression test, `npm test`, `npm run lint`, `npm run typecheck`, `npm run check:line-endings`, and the explicit research command. The research e2e skips must be reported, never counted as live qualification.
- Do not modify `qualification/mcp-lifecycle.json`, `qualification/direct-mcp-feasibility.json`, or either frozen evidence report merely to change test selection.

## Out of scope

No probe implementation changes, new host experiments, production MCP adapter, or release-gate promotion. This design does not make bare `node --test` a routine-development command; callers who use it directly opt into Node's default discovery, which includes research files.
