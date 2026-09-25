// @ts-nocheck
/**
 * Read-only inventory and classification of documented plugin entry
 * candidates for the direct `mcpServer/tool/call` feasibility probe. The
 * module is pure: it describes which documented component COULD receive a
 * user's explicit action and reach the session's owning Host connection,
 * and it never counts a driver-owned RPC as a product entry.
 *
 * Evidence discipline: a row field is `documented` (an official page or
 * installed manifest states it), `measured` (a live measurement recorded in
 * the current run demonstrates it), or `unproven`. A candidate missing ANY
 * of the six required demonstrations — owning-host access, deterministic
 * dispatch, user authorization, wait ownership, terminal delivery,
 * cancellation routing — cannot classify `proven`, even if a driver direct
 * call succeeds. A candidate whose access depends on a separate host or an
 * external architecture (`installedPluginBoundary: 'external'`) never
 * classifies `proven`. Classifier `proven` is a candidate-level readiness
 * judgment only: it never establishes full G4 by itself — `classifyDirectGateG4`
 * additionally requires the plan Task 6 Step 2 installed-fixture acceptance
 * (one explicit action dispatched exactly once on the ACTUAL installed user
 * session, a hold beyond two 60-second legacy wait intervals, zero model
 * decisions, terminal delivery to the original Root/Child, and routed user
 * interruption), and the disposable driver's own app-server thread is never
 * that session.
 */

/** The closed per-field evidence marks. */
export const ENTRY_FIELD_MARKS = Object.freeze(['documented', 'measured', 'unproven']);

/** The closed row: one field per plan-mandated inventory column. */
export const ENTRY_ROW_FIELDS = Object.freeze([
  'userAction',
  'receivingComponent',
  'owningHostAccess',
  'authorizationSource',
  'waitOwner',
  'outputRoute',
  'cancellationRoute',
  'externalDependency',
]);

/** The closed dispatch modes. Only an explicit deterministic user action can ever dispatch deterministically. */
export const ENTRY_DISPATCH_MODES = Object.freeze([
  'explicit-deterministic',
  'model-selected',
  'lifecycle-automatic',
  'driver-owned',
]);

/**
 * The closed installed-plugin boundary values. `within` means the candidate's
 * access lives inside the supported plugin installation; `external` means it
 * depends on a separate host or external architecture (a separate app-server
 * host, a custom UI, a fork, or an external coordinator), which per the spec
 * can never pass G4 for the current plugin goal.
 */
export const ENTRY_BOUNDARIES = Object.freeze(['within', 'external']);

/**
 * The six required demonstrations every `proven` entry candidate needs: the
 * plan's four-aspect floor (owning-host access, deterministic dispatch,
 * terminal delivery, cancellation routing) tightened per the spec's G4
 * requirements — a user-authorized workflow and an identified owner of the
 * pending call — to also require user authorization and wait ownership. A
 * candidate missing any one of them stays `unproven`; a repeatable
 * observation contradicting one under the recorded tested conditions
 * rejects the candidate.
 */
export const ENTRY_REQUIRED_ASPECTS = Object.freeze([
  'owning-host-access',
  'deterministic-dispatch',
  'user-authorization',
  'wait-ownership',
  'terminal-delivery',
  'cancellation-routing',
]);

/**
 * The closed classification states. They map onto the spec's gate vocabulary
 * rather than repeating it: `proven` corresponds to a gate recorded
 * `proven`; `unproven` corresponds to a gate recorded `not-proven`;
 * `rejected` records a candidate contradicted under the recorded tested
 * conditions.
 */
export const ENTRY_CLASSIFICATION_STATES = Object.freeze(['proven', 'unproven', 'rejected']);

/**
 * The closed G4 gate decision codes (`classifyDirectGateG4`). The gate never
 * invents a pass outside this list: with no ready candidate it records the
 * concrete missing link (`no-supported-entry-candidate` plus the required
 * aspects no within-boundary candidate demonstrates); a ready candidate
 * still needs the plan Task 6 Step 2 installed-fixture demonstration on the
 * ACTUAL user session, and the disposable driver's own app-server thread is
 * never that session.
 */
export const ENTRY_GATE_G4_DECISION_CODES = Object.freeze([
  'no-supported-entry-candidate',
  'entry-demonstration-missing',
  'driver-thread-not-user-session',
  'entry-demonstration-incomplete',
  'installed-entry-demonstrated',
]);

/**
 * The recorded wall-clock hold the plan Task 6 Step 2 acceptance requires: a
 * held interval spanning at least two 60-second legacy wait intervals
 * (120000 ms). Tests may inject shorter clocks into fixtures, but a gate
 * `proven` requires the recorded real interval.
 */
export const ENTRY_GATE_G4_MIN_HOLD_MS = 120000;

/**
 * The closed installed-fixture demonstration contract (plan Task 6 Step 2):
 * one explicit action dispatched exactly once on the ACTUAL installed user
 * session, a hold beyond two 60-second legacy wait intervals, zero model
 * decisions during the hold, one terminal result to the original Root/Child,
 * a routed user interruption, and the recorded wall-clock hold duration plus
 * comparison baseline.
 */
const G4_DEMONSTRATION_KEYS = Object.freeze([
  'onInstalledUserSession',
  'dispatchOnce',
  'heldBeyondTwoWaitIntervals',
  'modelDecisionsDuringHold',
  'terminalDelivered',
  'cancellationRouted',
  'holdDurationMs',
  'comparisonBaselineRecorded',
]);

/** The row field that backs each required aspect inside the candidate shape. */
const ASPECT_BACKING_FIELDS = Object.freeze({
  'owning-host-access': 'owningHostAccess',
  'user-authorization': 'authorizationSource',
  'wait-ownership': 'waitOwner',
  'terminal-delivery': 'outputRoute',
  'cancellation-routing': 'cancellationRoute',
});

/** The closed candidate contract keys; anything else fails validation closed. */
const CANDIDATE_CONTRACT_KEYS = Object.freeze(['id', 'dispatch', 'installedPluginBoundary', 'fields', 'contradictions']);

/** @param {string} code @param {string} message */
function entryError(code, message) {
  const error = /** @type {Error & {code:string}} */ (new Error(`${code}: ${message}`));
  error.code = code;
  return error;
}

/** @param {unknown} value */
function isBoundedText(value) {
  // The regex deliberately matches control characters: rejecting them is the
  // entire purpose of this check.
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Validates one candidate against the closed row vocabulary and returns it.
 * Throws `ENTRY_CANDIDATE_INVALID` on any unknown field, mark, dispatch
 * mode, or contradiction so a malformed candidate can never silently
 * classify.
 * @param {unknown} candidate
 */
function validateEntryCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw entryError('ENTRY_CANDIDATE_INVALID', 'The entry candidate must be an object.');
  }
  const record = /** @type {Record<string, unknown>} */ (candidate);
  for (const key of Object.keys(record)) {
    if (!CANDIDATE_CONTRACT_KEYS.includes(key)) {
      throw entryError('ENTRY_CANDIDATE_INVALID', `The entry candidate rejects unknown key ${key}.`);
    }
  }
  if (!isBoundedText(record.id)) throw entryError('ENTRY_CANDIDATE_INVALID', 'The entry candidate requires a bounded id.');
  if (!ENTRY_DISPATCH_MODES.includes(/** @type {string} */ (record.dispatch))) {
    throw entryError('ENTRY_CANDIDATE_INVALID', 'The entry candidate requires a closed dispatch mode.');
  }
  if (!ENTRY_BOUNDARIES.includes(/** @type {string} */ (record.installedPluginBoundary))) {
    throw entryError('ENTRY_CANDIDATE_INVALID', 'The entry candidate requires a closed installed-plugin boundary.');
  }
  const fields = record.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw entryError('ENTRY_CANDIDATE_INVALID', 'The entry candidate requires a row object.');
  }
  const row = /** @type {Record<string, unknown>} */ (fields);
  for (const key of Object.keys(row)) {
    if (!ENTRY_ROW_FIELDS.includes(key)) throw entryError('ENTRY_CANDIDATE_INVALID', `The entry row rejects unknown field ${key}.`);
  }
  for (const key of ENTRY_ROW_FIELDS) {
    const field = row[key];
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      throw entryError('ENTRY_CANDIDATE_INVALID', `The entry row field ${key} must be an object.`);
    }
    const entry = /** @type {Record<string, unknown>} */ (field);
    for (const fieldKey of Object.keys(entry)) {
      if (fieldKey !== 'mark' && fieldKey !== 'note') {
        throw entryError('ENTRY_CANDIDATE_INVALID', `The entry row field ${key} rejects unknown key ${fieldKey}.`);
      }
    }
    if (!ENTRY_FIELD_MARKS.includes(entry.mark)) {
      throw entryError('ENTRY_CANDIDATE_INVALID', `The entry row field ${key} requires a closed mark.`);
    }
    if (!isBoundedText(entry.note)) {
      throw entryError('ENTRY_CANDIDATE_INVALID', `The entry row field ${key} requires a bounded note.`);
    }
  }
  const contradictions = record.contradictions;
  if (!Array.isArray(contradictions)) {
    throw entryError('ENTRY_CANDIDATE_INVALID', 'The entry candidate requires an explicit contradictions array.');
  }
  const seen = new Set();
  for (const aspect of contradictions) {
    if (!ENTRY_REQUIRED_ASPECTS.includes(aspect)) {
      throw entryError('ENTRY_CANDIDATE_INVALID', `Unknown entry contradiction aspect ${String(aspect)}.`);
    }
    if (seen.has(aspect)) throw entryError('ENTRY_CANDIDATE_INVALID', `Duplicate entry contradiction aspect ${String(aspect)}.`);
    seen.add(aspect);
  }
  return record;
}

/**
 * Decides one candidate's closed entry state plus closed reasons.
 *
 * `proven` requires ALL six required aspects to be backed by live
 * `measured` evidence (for deterministic dispatch: an explicit-deterministic
 * dispatch mode with a measured user action AND receiving component) and no
 * contradiction. A driver-owned direct call never satisfies deterministic
 * dispatch. Any contradicted aspect rejects the candidate outright. A
 * candidate whose access depends on a separate host or an external
 * architecture (`installedPluginBoundary: 'external'`) never classifies
 * `proven`, regardless of its other evidence.
 * @param {unknown} candidate
 * @returns {{status: string, reasons: string[]}}
 */
export function classifyEntryCandidate(candidate) {
  const record = validateEntryCandidate(candidate);
  const row = /** @type {Record<string, {mark: string, note: string}>} */ (record.fields);
  const contradicted = new Set(/** @type {string[]} */ (record.contradictions));

  const contradictedReasons = ENTRY_REQUIRED_ASPECTS
    .filter((aspect) => contradicted.has(aspect))
    .map((aspect) => `${aspect}-contradicted`);
  if (contradictedReasons.length > 0) return { status: 'rejected', reasons: contradictedReasons };

  const reasons = [];
  const dispatchMode = /** @type {string} */ (record.dispatch);
  for (const aspect of ENTRY_REQUIRED_ASPECTS) {
    const backingField = ASPECT_BACKING_FIELDS[aspect];
    if (backingField) {
      if (row[backingField].mark !== 'measured') reasons.push(`${aspect}-unproven`);
      continue;
    }
    // The deterministic-dispatch aspect: an explicit deterministic mode whose
    // user action and receiving component are both live-measured.
    if (
      dispatchMode !== 'explicit-deterministic'
      || row.userAction.mark !== 'measured'
      || row.receivingComponent.mark !== 'measured'
    ) {
      reasons.push(`${aspect}-unproven`);
    }
  }
  if (dispatchMode !== 'explicit-deterministic') reasons.push(`dispatch-${dispatchMode}`);
  if (/** @type {string} */ (record.installedPluginBoundary) === 'external') {
    reasons.push('installed-plugin-boundary-external');
  }
  return reasons.length === 0 ? { status: 'proven', reasons: [] } : { status: 'unproven', reasons };
}

/**
 * Recursively freezes one shipped candidate: the entry itself, its row map,
 * every leaf `{mark, note}` field object, and the contradictions list, so
 * shipped evidence rows cannot be mutated in place.
 * @param {object} entry
 */
function deepFreezeEntry(entry) {
  for (const field of Object.values(entry.fields)) Object.freeze(field);
  Object.freeze(entry.fields);
  Object.freeze(entry.contradictions);
  return Object.freeze(entry);
}

/**
 * The shipped inventory of documented entry candidates, frozen. Marks are
 * conservative: only live measurements recorded in the current run may mark
 * a field `measured`; facts stated by the official pages, the installed
 * manifests, or committed qualification reports stay `documented`, and
 * unknown Host behavior stays `unproven` rather than guessed.
 */
export const ENTRY_CANDIDATES = Object.freeze([
  deepFreezeEntry({
    id: 'skill-model-selected',
    dispatch: 'model-selected',
    installedPluginBoundary: 'within',
    fields: Object.freeze({
      userAction: { mark: 'unproven', note: 'A `$zcode:<skill>` mention is explicit and per-invocation for the Skill workflow, and model selection from the description is not a user action at all; neither is a demonstrated per-invocation action for a particular direct MCP call (0.155.1: zero app-server-path MCP calls).' },
      receivingComponent: { mark: 'documented', note: 'The Codex Host model inside the active turn; the Skill scripts run as session exec commands.' },
      owningHostAccess: { mark: 'unproven', note: 'No documented mechanism for a Skill script to send app-server JSON-RPC (e.g. mcpServer/tool/call) on the owning session connection.' },
      authorizationSource: { mark: 'unproven', note: 'Unproven for the direct-call path: the Host session identity plus companion binding/permission checks are exec-path context (recorded in docs/qualification/zcode-mcp-context.md, where the MCP authority join remains blocked) and do not transfer to a direct mcpServer/tool/call.' },
      waitOwner: { mark: 'unproven', note: 'Shell-path context only: the shipped shell wait adapter observes the companion CLI process (the only shipped foreground wait adapter per the 0.155.1 record); no owner of a pending direct MCP call is established.' },
      outputRoute: { mark: 'unproven', note: 'Shell-path context only: companion stdout returns through the model turn; terminal delivery of a direct-call result to the original user/Child is not established.' },
      cancellationRoute: { mark: 'unproven', note: 'A user interrupt cancels the model turn; no demonstrated route from that interrupt to one specific pending direct MCP operation.' },
      externalDependency: { mark: 'documented', note: 'Model MCP-tool selection: the 0.155.1 qualification recorded zero app-server-path MCP calls, so dispatch is not deterministic.' },
    }),
    contradictions: Object.freeze([]),
  }),
  deepFreezeEntry({
    id: 'skill-structured-input',
    dispatch: 'driver-owned',
    installedPluginBoundary: 'external',
    fields: Object.freeze({
      userAction: { mark: 'unproven', note: 'No user action exists in the user session: the structured {type:"skill",name,path} turn-input item is sent by the connected app-server client process (app-server doc), so there is no per-invocation user action for a direct MCP call.' },
      receivingComponent: { mark: 'documented', note: 'app-server injects the Skill instructions into the model turn of the thread owned by the connected client.' },
      owningHostAccess: { mark: 'unproven', note: 'Reaches only threads owned by the connecting client; thread/resume restores stored threads, not an independently started CLI/UI session (app-server doc).' },
      authorizationSource: { mark: 'unproven', note: 'Connection-level thread ownership is transport setup only: the app-server connection owns its threads (driver-owned threads), which is not authority from the actual user action for the specific operation and turn.' },
      waitOwner: { mark: 'unproven', note: 'No user session is attached; any pending call would be owned by the driver process.' },
      outputRoute: { mark: 'unproven', note: 'Transport-level only: the turn result returns to the connecting app-server client; no original user/Child is attached, so terminal delivery to one is not established.' },
      cancellationRoute: { mark: 'unproven', note: 'Turn-level interruption only: turn/interrupt cancels the client-owned turn per the app-server doc; no route to a durable held MCP handler call is demonstrated — the Task 5 direct-call lifecycle campaign left the held worker durably unsettled under the configured timeout, client disconnect, and host stop, and the explicit-interrupt case was not-sent (no controlled active turn).' },
      externalDependency: { mark: 'documented', note: 'A separate codex app-server process; the 0.155.1 record measured zero model MCP-tool selection on this path.' },
    }),
    contradictions: Object.freeze([]),
  }),
  deepFreezeEntry({
    id: 'hook-user-prompt-submit',
    dispatch: 'lifecycle-automatic',
    installedPluginBoundary: 'within',
    fields: Object.freeze({
      userAction: { mark: 'unproven', note: 'Generic per-invocation input only: a prompt submission is explicit and per-invocation, but the user is prompting the Host, not acting to initiate a direct MCP call; no per-invocation user action for a direct call is documented.' },
      receivingComponent: { mark: 'documented', note: 'The installed hook command (hooks/user-prompt-hook.mjs) launched by the Host at the prompt-submit lifecycle point.' },
      owningHostAccess: { mark: 'unproven', note: 'No documented interface for a hook process to call app-server methods on the owning session connection.' },
      authorizationSource: { mark: 'unproven', note: 'Hook trust is configurable (features.hooks plus trusted_hash per the 0.155.1 report), but no documented authorization for Host RPC from hooks.' },
      waitOwner: { mark: 'unproven', note: 'Shell-hook context only: the installed hook command runs to completion or its installed 10-second timeout (hooks.json); no owner of a pending direct MCP call is established.' },
      outputRoute: { mark: 'unproven', note: 'Shell-hook context only: hook stdout JSON (additionalContext) is injected into session context; terminal delivery of a direct-call result to the original user/Child is not established.' },
      cancellationRoute: { mark: 'unproven', note: 'No documented route from the user to a pending operation inside a running hook.' },
      externalDependency: { mark: 'documented', note: 'The hooks feature flag and per-hook trusted entries (0.155.1 report records both gates).' },
    }),
    contradictions: Object.freeze([]),
  }),
  deepFreezeEntry({
    id: 'hook-stop-gate',
    dispatch: 'lifecycle-automatic',
    installedPluginBoundary: 'within',
    fields: Object.freeze({
      userAction: { mark: 'unproven', note: 'Fires when the model stops; no explicit user action exists.' },
      receivingComponent: { mark: 'documented', note: 'The installed Stop hook command (hooks/stop-review-gate-hook.mjs).' },
      owningHostAccess: { mark: 'unproven', note: 'Same missing documented hook-to-Host RPC interface as the other lifecycle hooks.' },
      authorizationSource: { mark: 'unproven', note: 'No documented authorization for Host RPC from hooks.' },
      waitOwner: { mark: 'unproven', note: 'Shell-hook context only: the hook command runs up to its installed 900-second timeout (hooks.json); no owner of a pending direct MCP call is established.' },
      outputRoute: { mark: 'unproven', note: 'A Stop-hook decision/feedback returns into the model loop, not a terminal result to an original user/Child request.' },
      cancellationRoute: { mark: 'unproven', note: 'No documented user cancellation route into a running Stop hook operation.' },
      externalDependency: { mark: 'documented', note: 'The hooks feature flag and per-hook trusted entries.' },
    }),
    contradictions: Object.freeze([]),
  }),
  deepFreezeEntry({
    id: 'plugin-mcp-server',
    dispatch: 'model-selected',
    installedPluginBoundary: 'within',
    fields: Object.freeze({
      userAction: { mark: 'unproven', note: 'One-time installation only: installing the plugin (documented) neither authorizes nor initiates a particular direct call; later tool calls are model-selected, and no explicit per-invocation user action for a direct MCP call is documented.' },
      receivingComponent: { mark: 'documented', note: 'The plugin-bundled MCP server process (stdio or streamable HTTP per its .mcp.json).' },
      owningHostAccess: { mark: 'unproven', note: 'The server receives model-initiated calls; the only documented server-to-host request is mcpServer/elicitation/request — no documented mcpServer/tool/call route from a server into the owning session.' },
      authorizationSource: { mark: 'unproven', note: 'Approval modes gate which tools the model may call; no documented authority for a server-initiated Host RPC.' },
      waitOwner: { mark: 'unproven', note: 'tool_timeout_sec bounds the tool call (documented default 60s); the 0.155.1 report measured no timeout propagation to the handler.' },
      outputRoute: { mark: 'unproven', note: 'A tool result returns to the model turn that called it, not to an original user request.' },
      cancellationRoute: { mark: 'unproven', note: 'The 0.155.1 report measured no cancellation delivery to a pending stdio handler.' },
      externalDependency: { mark: 'documented', note: 'Not installed in the shipped plugin; only the disposable probe fixture installs an MCP server.' },
    }),
    contradictions: Object.freeze([]),
  }),
  deepFreezeEntry({
    id: 'subagent-rescue-forwarder',
    dispatch: 'model-selected',
    installedPluginBoundary: 'within',
    fields: Object.freeze({
      userAction: { mark: 'unproven', note: 'Model dispatch only: the parent model spawns the Rescue Child and sends an exact assignment (installed template); no explicit per-invocation user action for a direct MCP call is documented.' },
      receivingComponent: { mark: 'documented', note: 'The Rescue Child agent turn.' },
      owningHostAccess: { mark: 'unproven', note: 'The Child observes exec process handles (exec_command/write_stdin); no documented direct app-server RPC from a Child.' },
      authorizationSource: { mark: 'unproven', note: 'Unproven for the direct-call path: the prepared envelope plus executor/binding validation installed in the template is exec-path context (recorded in the qualification report, not re-measured in this run) and does not transfer to a direct MCP call.' },
      waitOwner: { mark: 'unproven', note: 'Exec-path context only: the Child polls the foreground companion handle with 60-second yields; no owner of a pending direct MCP call is established.' },
      outputRoute: { mark: 'unproven', note: 'Exec-path context only: the Child terminal result returns to the parent through the native child completion mechanism; terminal delivery of a direct-call result is not established.' },
      cancellationRoute: { mark: 'unproven', note: 'No route from a user interruption to the exact companion operation short of cancelling the whole turn.' },
      externalDependency: { mark: 'documented', note: 'Model tool-use decisions for exec/write_stdin observation.' },
    }),
    contradictions: Object.freeze([]),
  }),
  deepFreezeEntry({
    id: 'app-server-client-external',
    dispatch: 'driver-owned',
    installedPluginBoundary: 'external',
    fields: Object.freeze({
      userAction: { mark: 'unproven', note: 'Operator setup, not a per-invocation user action: no per-invocation user action exists in the user session; the operator starts codex app-server themselves.' },
      receivingComponent: { mark: 'documented', note: 'The external app-server client process after the initialize handshake (app-server doc).' },
      owningHostAccess: { mark: 'documented', note: 'The client owns the threads it creates (thread/start, turn/start, turn/interrupt, mcpServerStatus/list, mcpServer/tool/call, skills/list); it is only a probe host, never the user session.' },
      authorizationSource: { mark: 'unproven', note: 'Transport setup only: the documented initialize handshake establishes a connection, not authority for the actual user, operation, or turn; non-loopback WebSocket listeners currently allow unauthenticated connections by default during rollout (app-server doc).' },
      waitOwner: { mark: 'documented', note: 'The client process awaits its own JSON-RPC response.' },
      outputRoute: { mark: 'unproven', note: 'Transport-level only: the JSON-RPC response returns to the client process; no original user/Child is attached, so terminal delivery to one is not established.' },
      cancellationRoute: { mark: 'unproven', note: 'Turn-level interruption only: turn/interrupt {threadId,turnId} requests cancellation of the client-owned turn (app-server doc); no route to a durable held MCP handler call is demonstrated — the Task 5 direct-call lifecycle campaign left the held worker durably unsettled under the configured timeout, client disconnect, and host stop, and the explicit-interrupt case was not-sent (no controlled active turn).' },
      externalDependency: { mark: 'documented', note: 'A separate process and transport; documented as unable to attach to an independently started interactive session.' },
    }),
    contradictions: Object.freeze([]),
  }),
  deepFreezeEntry({
    id: 'remote-ui-client',
    dispatch: 'driver-owned',
    installedPluginBoundary: 'external',
    fields: Object.freeze({
      userAction: { mark: 'unproven', note: 'For the installed plugin: none; remote TUI mode requires deliberate operator setup (app-server --listen, then codex --remote), which is not a per-invocation user action for a direct MCP call.' },
      receivingComponent: { mark: 'documented', note: 'The Codex CLI UI connecting to a listening app-server (documented remote TUI mode).' },
      owningHostAccess: { mark: 'documented', note: 'In that architecture the app-server connection IS the session host connection — but it is a separate host started with --listen, not the installed plugin architecture.' },
      authorizationSource: { mark: 'unproven', note: 'Transport authentication only: documented --ws-auth capability/bearer tokens or --remote-auth-token-env authenticate the connection, which is not authority from the actual user action for the specific operation and turn.' },
      waitOwner: { mark: 'unproven', note: 'No documented plugin-side holder; the remote UI session owns waits.' },
      outputRoute: { mark: 'unproven', note: 'Terminal output routes to the remote UI session, not the installed plugin user flow.' },
      cancellationRoute: { mark: 'unproven', note: 'turn/interrupt exists, but a route from the installed plugin into that session is not established.' },
      externalDependency: { mark: 'documented', note: 'A separate listening app-server host: a different product architecture (external architecture candidate per the spec).' },
    }),
    contradictions: Object.freeze([]),
  }),
]);

/**
 * Classifies the shipped inventory. Returns one entry per candidate with its
 * closed decision and reasons; the reducer of the report uses these rows
 * verbatim.
 */
export function inventoryEntryCandidates() {
  return ENTRY_CANDIDATES.map((candidate) => ({ candidate, decision: classifyEntryCandidate(candidate) }));
}

/**
 * Validates one installed-fixture demonstration record against the closed
 * plan Task 6 Step 2 contract and returns it. Throws
 * `ENTRY_DEMONSTRATION_INVALID` on any unknown key, wrong type, or negative
 * count so a malformed acceptance can never silently pass the G4 gate.
 * @param {unknown} demonstration
 */
function validateEntryDemonstration(demonstration) {
  if (!demonstration || typeof demonstration !== 'object' || Array.isArray(demonstration)) {
    throw entryError('ENTRY_DEMONSTRATION_INVALID', 'The G4 demonstration must be an object.');
  }
  const record = /** @type {Record<string, unknown>} */ (demonstration);
  for (const key of Object.keys(record)) {
    if (!G4_DEMONSTRATION_KEYS.includes(key)) {
      throw entryError('ENTRY_DEMONSTRATION_INVALID', `The G4 demonstration rejects unknown key ${key}.`);
    }
  }
  for (const key of G4_DEMONSTRATION_KEYS) {
    const value = record[key];
    if (key === 'modelDecisionsDuringHold') {
      if (!Number.isInteger(value) || value < 0) {
        throw entryError('ENTRY_DEMONSTRATION_INVALID', 'The G4 demonstration requires a non-negative integer model decision count.');
      }
      continue;
    }
    if (key === 'holdDurationMs') {
      if (!Number.isInteger(value) || value < 0) {
        throw entryError('ENTRY_DEMONSTRATION_INVALID', 'The G4 demonstration requires a non-negative integer recorded hold duration.');
      }
      continue;
    }
    if (typeof value !== 'boolean') {
      throw entryError('ENTRY_DEMONSTRATION_INVALID', `The G4 demonstration field ${key} must be a boolean.`);
    }
  }
  return record;
}

/**
 * The G4 gate decision for the installed product entry (plan Task 6),
 * derived ONLY from the candidates themselves plus the recorded
 * installed-fixture demonstration. EVERY inventory candidate is reclassified
 * inside the gate with `classifyEntryCandidate` BEFORE any boundary
 * filtering — a supplied `decision` is never trusted (gate-review backfill
 * P2), and a malformed row (unknown mark, missing boundary, non-object
 * candidate) fails closed through the classifier's validation instead of
 * being silently skipped by a boundary prefilter (gate-review re-review P2).
 * Only validated candidates are then filtered by installed boundary.
 * Precedence follows the deepest missing link:
 *
 * 1. No within-boundary candidate classifies `proven` (candidate-level
 *    readiness) — the Task 1 checkpoint: no documented candidate both
 *    receives an actual user action and reaches the session's owning Host
 *    connection. The gate stops here and records `no-supported-entry-candidate`
 *    with `missingAspects`, the required aspects NO within-boundary candidate
 *    demonstrates. A demonstration record without a ready candidate is never
 *    promoted (a fabricated acceptance cannot pass).
 * 2. A ready candidate with no demonstration record — the acceptance is
 *    later-task evidence, `entry-demonstration-missing`.
 * 3. A demonstration that did not run on the actual installed user session —
 *    the plan's rule that the disposable driver's own app-server thread is
 *    never the user's CLI/UI session, `driver-thread-not-user-session`.
 * 4. A demonstration missing any required fact — `entry-demonstration-incomplete`.
 * 5. Everything demonstrated on the installed session — `proven`.
 * @param {{inventory: {candidate: Record<string, unknown>, decision?: {status: string, reasons: string[]}}[], demonstration?: Record<string, unknown>}} input
 * @returns {{status: string, reasonCode: string, missingAspects?: string[], evidenceRefs: number[]}}
 */
export function classifyDirectGateG4({ inventory, demonstration }) {
  if (!Array.isArray(inventory)) {
    throw entryError('ENTRY_INVENTORY_INVALID', 'The G4 gate requires the classified entry inventory.');
  }
  // The derived decisions, recomputed from EVERY candidate's own fields
  // BEFORE any boundary filtering (gate-review re-review P2): a malformed
  // row fails closed through the classifier's validation whatever boundary
  // it claims or omits, and only validated candidates are then filtered by
  // installed boundary. The supplied `decision` (if any) is deliberately
  // unread: the shipped rows' decisions are themselves this classifier's
  // output, so deriving inside the gate is identical for honest input and
  // immune to tampered input.
  const derivedEntries = inventory
    .map((entry) => ({ candidate: entry.candidate, derived: classifyEntryCandidate(entry.candidate) }));
  const withinEntries = derivedEntries
    .filter((entry) => entry.candidate.installedPluginBoundary === 'within');
  const ready = withinEntries.some((entry) => entry.derived.status === 'proven');
  if (!ready) {
    // The concrete missing link, computed from the DERIVED decisions: a
    // rejected candidate demonstrates nothing, and an unproven candidate
    // misses exactly the aspects its `<aspect>-unproven` reasons name.
    const missingAspects = ENTRY_REQUIRED_ASPECTS.filter((aspect) => withinEntries.every((entry) => {
      if (entry.derived.status !== 'unproven') return true;
      return entry.derived.reasons.includes(`${aspect}-unproven`);
    }));
    return { status: 'not-proven', reasonCode: 'no-supported-entry-candidate', missingAspects, evidenceRefs: [] };
  }
  if (!demonstration) {
    return { status: 'not-proven', reasonCode: 'entry-demonstration-missing', evidenceRefs: [] };
  }
  const record = validateEntryDemonstration(demonstration);
  if (record.onInstalledUserSession !== true) {
    return { status: 'not-proven', reasonCode: 'driver-thread-not-user-session', evidenceRefs: [] };
  }
  const incomplete = record.dispatchOnce !== true
    || record.heldBeyondTwoWaitIntervals !== true
    || record.modelDecisionsDuringHold !== 0
    || record.terminalDelivered !== true
    || record.cancellationRouted !== true
    || record.holdDurationMs < ENTRY_GATE_G4_MIN_HOLD_MS
    || record.comparisonBaselineRecorded !== true;
  if (incomplete) {
    return { status: 'not-proven', reasonCode: 'entry-demonstration-incomplete', evidenceRefs: [] };
  }
  return { status: 'proven', reasonCode: 'installed-entry-demonstrated', evidenceRefs: [] };
}
