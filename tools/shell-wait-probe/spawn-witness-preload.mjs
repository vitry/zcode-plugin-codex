// @ts-check
/**
 * The GENERATED SPAWN-WITNESS PRELOAD seam (research-only; user-review task 4
 * completion, report §33): the fixture-generated passive spawn-boundary
 * witness preload source, its writer, and the closed env contract both the
 * generated source and the fixture share.
 *
 * WHAT THIS WIRES (the §32.6/§28.6 fixture-boundary capture gap): the REAL
 * installed-plugin chain's spawn boundaries — the Companion→daemon hop
 * (production `spawnDaemon`, scripts/lib/process.mjs) and the daemon→
 * transport hop (production `spawnProcess`, via spawnZCodeProtocol) — live
 * INSIDE production processes the research suite may never modify. The
 * fixture-owned instrument reaches them the same way the §19.3 capture seam
 * and the §25.4 identity records do: a fixture-GENERATED CJS preload riding
 * NODE_OPTIONS into the armed chain. The generated preload is active ONLY in
 * the two gated roles (the launcher invocation and the broker daemon), wraps
 * `child_process.spawn` (the ORIGINAL call always runs first and its handle
 * is returned untouched), and — when the spawned child matches the role's
 * declared child gate — emits exactly ONE spawn-ancestry witness through the
 * observer module (dynamic import of the absolute URL baked in at generation
 * time). The emitter's own discipline is unchanged: OS-verified double reads
 * of the writer and the child, the exact identity capture under the
 * fixture-scope `ZCODE_SHELL_WAIT_KINFO_EXACT=1` opt-in (degrading
 * fail-closed off-darwin or on any bridge failure), and the wx-exclusive
 * 0600 record write. A failed or refused emission is the named ABSENCE of
 * the record (the runtime admission reports it), never a thrown preload
 * error and never a fabricated witness.
 *
 * SEPARATION FROM THE CAPTURE PRELOAD (the §28.4 prohibition-4 pin): the
 * §19.3 stdout-capture preload's bytes are untouched — this is a SECOND
 * artifact with its own file name, its own gates and no stdout-capture
 * machinery. The capture preload never gains witness references, and this
 * preload never intercepts stdout/stderr or alters exit behavior.
 *
 * THE ESM FACE (report §33.12, codex review round 6): the generated source
 * re-points the builtin's already-loaded ESM namespace at the wrapper
 * (`module.syncBuiltinESMExports()`, called INSIDE the gated branch right
 * after the install) — an EARLIER inherited NODE_OPTIONS preload that
 * initialized the `node:child_process` ESM namespace would otherwise keep
 * the named `spawn` import of ESM consumers (the production
 * scripts/lib/process.mjs form) bound to the ORIGINAL spawn, so the real
 * spawn boundaries would produce no witnesses despite passing preflight.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Module-INIT snapshot of THIS module's executing source (the provenance
// discipline, the same as closure-preload.mjs): the observer's v4 digest
// binds these bytes.
export const EXECUTING_SPAWN_WITNESS_PRELOAD_SOURCE = readFileSync(fileURLToPath(import.meta.url));

/** The generated preload's fixed file name inside the disposable fixture. */
export const SPAWN_WITNESS_PRELOAD_FILE_NAME = 'spawn-ancestry-witness-preload.cjs';

/**
 * The declared transport entry variable (the hop-2 child gate): the fixture
 * composes the fake-ZCode transport's resolved realpath so the daemon role
 * witnesses exactly the protocol spawn. Absent → the daemon role's gate is
 * disabled and the preload stays inert for the daemon's spawns.
 */
export const WITNESS_TRANSPORT_ENTRY_VARIABLE = 'ZCODE_SHELL_WAIT_WITNESS_TRANSPORT_ENTRY';

/**
 * The transport child's OWN nonce variable (the hop-2 child verification):
 * the driver composes it (FAKE_ZCODE_PROCESS_NONCE) and the transport
 * inherits it; the preload reads the value for the childNonce it declares.
 */
export const WITNESS_TRANSPORT_NONCE_VARIABLE = 'FAKE_ZCODE_PROCESS_NONCE';

/**
 * The §32.2 registered exact-reader opt-in variable. The reader's own gate
 * (local-process-observation.mjs) reads this exact literal at read time; the
 * witness arming composes `=1` into the fixture-scope env so the REAL chain's
 * emitters capture the closed exact forms. Non-darwin hosts and any bridge
 * failure degrade fail-closed to the ps whole-second path (the reader's own
 * discipline) — never a duty-establishing precondition.
 */
export const EXACT_READER_VARIABLE = 'ZCODE_SHELL_WAIT_KINFO_EXACT';

/** @param {string} message @returns {TypeError} */
function invalidWitnessPreloadInput(message) {
  return new TypeError(`Invalid spawn witness preload input: ${message}`);
}

/**
 * The fixture-generated passive spawn-boundary witness preload source (CJS,
 * loaded through `--require`). Pure text: no repository import at load time,
 * and the observer module is reached only through the dynamic import of the
 * caller-baked absolute URL at emit time — the executable copy exists only
 * inside the disposable fixture.
 *
 * ROLE GATES (the §19.3 P1-gate discipline, mirrored):
 * - invocation: the entry realpaths to the DECLARED launcher entry
 *   (ZCODE_SHELL_WAIT_CAPTURE_ENTRY_REALPATH) AND argv.slice(2) deep-equals
 *   ['invoke-prepared','rescue'] — the frozen §19.3 selector.
 * - broker-daemon: the entry realpaths to the DECLARED broker entry
 *   (ZCODE_SHELL_WAIT_CAPTURE_BROKER_ENTRY_REALPATH) AND argv is exactly
 *   [broker, config] (three segments, nonempty config) — the §25.4 broker
 *   selector.
 * Any other process (hooks, the prepare launcher, the transport itself)
 * installs NOTHING.
 *
 * CHILD GATES:
 * - invocation role: a spawn whose first argument realpaths to the declared
 *   broker entry with exactly [brokerEntry, config] — the REAL daemon spawn.
 * - broker-daemon role: a spawn whose command or first argument matches the
 *   declared transport entry AND whose arguments include 'app-server' — the
 *   REAL protocol spawn (the 'app-server' discriminator excludes the
 *   discovery '--version' probe so a probe child can never take the
 *   one-witness-per-role slot).
 *
 * The wrapper never alters spawn semantics: the original call runs first,
 * its child handle is returned unchanged, and every bookkeeping failure is
 * swallowed (the record's absence is the named fact at the admission).
 * @param {{ observerUrl: string }} input
 * @returns {string}
 */
export function spawnWitnessPreloadSource({ observerUrl }) {
  if (typeof observerUrl !== 'string' || !observerUrl.startsWith('file:')) {
    throw invalidWitnessPreloadInput('the witness preload needs an absolute file URL of the observer module.');
  }
  return `'use strict';
// Fixture-generated passive spawn-boundary witness preload (research-only;
// report §33). Generated into the disposable fixture by the research
// fixture; the repository never ships an executable copy.
// ROLE GATES: active only in the gated invocation/broker-daemon processes
// (the declared capture entry variables); every other process installs
// NOTHING. OBSERVATION: child_process.spawn is wrapped — the ORIGINAL spawn
// runs first (same arguments, same child handle, same semantics), then a
// matched child triggers exactly ONE witness emission through the observer
// module's emitSpawnAncestryWitness (its own OS-verified double reads, the
// exact identity capture under the fixture-scope opt-in env, and the
// wx-exclusive 0600 record). After the install the builtin's ESM namespace
// is re-synced (syncBuiltinESMExports) so an ESM consumer's named spawn
// binding reaches the wrapper too — an earlier inherited preload may have
// initialized the namespace before this preload ran (report §33.12). A
// failed emission is the named ABSENCE of the record — never a thrown
// preload error, never a fabricated witness, and no stdout/stderr/exit
// change of any kind.
(function () {
  var FS = require('node:fs');
  var DIRECTORY = process.env[${JSON.stringify('ZCODE_SHELL_WAIT_CAPTURE_DIR')}];
  var NONCE = process.env[${JSON.stringify('ZCODE_SHELL_WAIT_CAPTURE_NONCE')}];
  var ENTRY = process.env[${JSON.stringify('ZCODE_SHELL_WAIT_CAPTURE_ENTRY_REALPATH')}];
  var BROKER = process.env[${JSON.stringify('ZCODE_SHELL_WAIT_CAPTURE_BROKER_ENTRY_REALPATH')}];
  var TRANSPORT = process.env[${JSON.stringify(WITNESS_TRANSPORT_ENTRY_VARIABLE)}];
  var TRANSPORT_NONCE = process.env[${JSON.stringify(WITNESS_TRANSPORT_NONCE_VARIABLE)}];
  var OBSERVER_URL = ${JSON.stringify(observerUrl)};
  var ENV_OK = typeof DIRECTORY === 'string' && DIRECTORY.charAt(0) === '/'
    && typeof NONCE === 'string' && /^[a-f0-9]{64}$/.test(NONCE)
    && typeof ENTRY === 'string' && ENTRY.charAt(0) === '/'
    && typeof BROKER === 'string' && BROKER.charAt(0) === '/';
  var entryRealpath = null;
  if (ENV_OK) { try { entryRealpath = FS.realpathSync(process.argv[1]); } catch (error) { entryRealpath = null; } }
  var role = null;
  if (ENV_OK && entryRealpath !== null && entryRealpath === ENTRY
    && process.argv.length === 4 && process.argv[2] === 'invoke-prepared' && process.argv[3] === 'rescue') {
    role = 'invocation';
  } else if (ENV_OK && entryRealpath !== null && entryRealpath === BROKER
    && process.argv.length === 3 && typeof process.argv[2] === 'string' && process.argv[2].length > 0) {
    role = 'broker-daemon';
  }
  if (role === null) return;
  var CP = require('node:child_process');
  var originalSpawn = CP.spawn;
  var attempted = false;
  function realpathOrNull(value) { try { return FS.realpathSync(value); } catch (error) { return null; } }
  CP.spawn = function patchedSpawn(command, args, options) {
    var child = originalSpawn.apply(this, arguments);
    try {
      if (attempted || !Array.isArray(args) || !(child && typeof child.pid === 'number' && child.pid > 0)) return child;
      var matched = false;
      var childNonce = null;
      var childNonceVariable = 'ZCODE_SHELL_WAIT_CAPTURE_NONCE';
      if (role === 'invocation') {
        matched = args.length === 2 && typeof args[0] === 'string' && args[0].length > 0 && realpathOrNull(args[0]) === BROKER;
        childNonce = NONCE;
      } else if (role === 'broker-daemon' && typeof TRANSPORT === 'string' && TRANSPORT.charAt(0) === '/') {
        var entryMatch = (typeof args[0] === 'string' && (args[0] === TRANSPORT || realpathOrNull(args[0]) === TRANSPORT))
          || command === TRANSPORT || realpathOrNull(command) === TRANSPORT;
        matched = entryMatch && args.indexOf('app-server') !== -1
          && typeof TRANSPORT_NONCE === 'string' && /^[a-f0-9]{64}$/.test(TRANSPORT_NONCE);
        childNonce = TRANSPORT_NONCE;
        childNonceVariable = ${JSON.stringify(WITNESS_TRANSPORT_NONCE_VARIABLE)};
      }
      if (!matched) return child;
      attempted = true;
      var childPid = child.pid;
      import(OBSERVER_URL).then(function (observer) {
        return observer.emitSpawnAncestryWitness({
          captureDirectory: DIRECTORY, nonce: NONCE, role: role,
          childPid: childPid, childNonce: childNonce, childNonceVariable: childNonceVariable,
        });
      }).catch(function (error) { /* the record's absence is the named fail-closed fact at the admission */ });
    } catch (error) { /* bookkeeping never affects the spawn */ }
    return child;
  };
  // The builtin-ESM sync (report §33.12; codex review round 6): an earlier
  // inherited preload that initialized the node:child_process ESM namespace
  // would keep the named spawn import of ESM consumers (the production
  // scripts/lib/process.mjs form) bound to the ORIGINAL spawn — the real
  // spawn boundaries would produce no witnesses despite passing preflight.
  // syncBuiltinESMExports() re-points the ALREADY-LOADED namespace's live
  // bindings at the current CommonJS exports (the wrapper). Repeated calls
  // are harmless (each call re-reads the current exports; the LAST installer
  // of the export owns the ESM face) and the call sits INSIDE the gated
  // branch, after the install — non-gated processes install nothing and
  // never reach it.
  require('node:module').syncBuiltinESMExports();
})();
`;
}

/**
 * Write the fixture-generated witness preload into a private directory. The
 * write is the only side effect and happens after the input validation.
 * @param {string} directory an absolute private directory (the disposable
 *   fixture root)
 * @param {{ observerUrl: string }} input
 * @returns {Promise<{ path: string, sha256: string, nodeOptionsFragment: string }>}
 */
export async function writeSpawnWitnessPreload(directory, input) {
  if (typeof directory !== 'string' || directory.length === 0 || !isAbsolute(directory)) {
    throw invalidWitnessPreloadInput('the preload directory must be an absolute path.');
  }
  const source = spawnWitnessPreloadSource(input ?? {});
  const path = join(directory, SPAWN_WITNESS_PRELOAD_FILE_NAME);
  await writeFile(path, source, { mode: 0o600 });
  // The same NODE_OPTIONS quoting discipline as the capture preload (only
  // U+0020 separates arguments; a quoted path with spaces must stay one
  // argument or node exits before any entry runs).
  const quotedPath = `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return {
    path,
    sha256: createHash('sha256').update(source, 'utf8').digest('hex'),
    nodeOptionsFragment: `--require ${quotedPath}`,
  };
}
