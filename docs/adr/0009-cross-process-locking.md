---
status: accepted
---

# Use native advisory locks for cross-process state

Node.js 18 has no built-in cross-platform advisory file-lock API or filesystem compare-and-delete primitive. The plugin must nevertheless serialize job transitions and authorization consumption across processes on local macOS, Linux, and Windows workspaces. It therefore keeps one persistent lockfile for each lock scope, opens that file for the lifetime of a critical section, and uses the exactly pinned `fs-native-extensions@1.5.0` fd lock. The operating system grants ownership atomically and releases it when the fd closes or the process exits; the plugin never renames or unlinks the active lockfile.

## Rejected alternatives

Directory leases with heartbeat timestamps were rejected because stale takeover and release require a conditional rename or delete that portable Node filesystem APIs cannot provide. A precheck followed by rename has an ABA window in which an old holder can move a new owner's lock and permit parallel critical sections. Adding hostnames and PIDs does not close that window, and PID reuse can make a dead owner appear permanently alive unless platform-specific process-incarnation data is also maintained. More metadata would increase recovery complexity without creating the missing atomic primitive.

## Consequences

Every state and authorization participant must open and lock the same persistent lockfile; advisory locking cannot protect against a participant that ignores the protocol. The runtime carries native prebuilds for supported macOS, Linux, and Windows architectures, and `bare-addon-resolve` is overridden to exactly `1.9.4` so binding resolution remains compatible with Node 18.18. Clean production installation, packed-plugin installation, binding loading, and lock acquisition/release must be tested in CI on all three operating systems. Release review must also audit the dependency's Apache-2.0 license, shipped prebuilds, package integrity, and security advisories.
