// @ts-check
/**
 * Bounded fail-closed evidence observer for the native shell long-wait
 * qualification (research-only). It inspects only actually observed host call
 * shapes — direct function calls, bounded consecutive code-mode statements, and
 * the linked outer continuation that resolves a pending yielded cell — and
 * never infers an invocation from quoted message text.
 *
 * Missing or ambiguous records are reported as inconclusive, never as a zero
 * decision count. An unknown or truncated script shape keeps one sanitized
 * decisive excerpt and is flagged for manual adjudication; it is inconclusive,
 * not zero. A returned-but-still-live cell, a yield expiry while the worker is
 * still running, or a cap return can never qualify completion. No general
 * rollout interpreter lives here.
 */
import { RESCUE_ENVELOPE_MAX_BYTES, validateRescuePreparation } from '../../scripts/lib/rescue-preparation.mjs';

const MAX_COMMAND_BYTES = 4096;
const MAX_WRAPPER_ARGUMENT_CHARS = 4096;
const MAX_EXCERPT_CHARS = 2048;
const MAX_EVENTS_PER_ROLLOUT = 20_000;
const MAX_STATEMENTS_PER_CELL = 16;
const MAX_DIAGNOSTIC_EXCERPTS = 64;
// The const-r wrapper's tail has two observed forms: the pinned
// `text(JSON.stringify(r))` and the installed 0.160.1 `text(r)` (Task 4 Case 0
// launch call, single-quoted JavaScript literals). Both are supported, with
// an optional terminal semicolon as observed in the second Case 0 record.
const WRAPPER_PATTERN = /^const r = await tools\.(exec_command|write_stdin)\((\{[\s\S]{1,4096}?\})\);\s*text\((?:JSON\.stringify\(r\)|r)\);?\n?$/u;
// The installed 0.160.1 host additionally observes the inline wrapper form
// `text(await tools.<tool>({...}));` (first live observation 2026-10-06, Task 4
// Case 0: `text(await tools.exec_command({cmd:"cat …",max_output_tokens:20000}));`).
const INLINE_WRAPPER_PATTERN = /^text\(await tools\.(exec_command|write_stdin|wait)\((\{[\s\S]{1,4096}?\})\)\);\n?$/u;
// The sanctioned private v5 preparation frame, observed live in the CHILD
// rollout (Task 4 Case 0): the child writes the prepared task envelope to the
// launcher handle before the empty-input terminal observations. This is the
// one sanctioned nonempty write (spec S2); everything else stays injection.
const PREPARATION_PATTERN = /^text\(await tools\.write_stdin\(\{session_id:(\d{1,12}),chars:JSON\.stringify\((\{[\s\S]{1,4096}?\})\)\+"\\n"(?:,max_output_tokens:\d{1,9})?\}\)\);\n?$/u;
// The directive capture is LAZY so it stops at the directive line's own
// newline; a greedy capture would backtrack to the input's last newline and
// swallow the wrapper after it (surfaced by the Task 4 directive regression).
const DIRECTIVE_PATTERN = /^\/\/ @exec: ([\s\S]{1,512}?)\n/u;
const PENDING_CELL_PREFIX = 'Script running with cell ID ';
// Both pinned host header forms report the decisive observation's wall time:
// - direct unified-exec output header (codex-rs/core/src/tools/context.rs
//   response_header): `Wall time: {seconds:.4} seconds` (with colon);
// - code-mode wrapper/cell header (codex-rs/core/src/tools/code_mode/output.rs):
//   `{status}\nWall time {seconds:.1} seconds\nOutput:\n` (no colon).
// The installed build's exact form is a separate Task 4 observation.
const WALL_TIME_PATTERN = /Wall time:? (\d+(?:\.\d+)?) seconds/u;

/** @param {string} message @returns {TypeError} */
function invalidEvidenceInput(message) {
  return new TypeError(`Invalid shell wait evidence input: ${message}`);
}

/**
 * Rollout events come from persisted JSONL records whose exact host schema is
 * deliberately observed loosely here (unknown fields stay unknown); every
 * strict extraction is bounded and validated below.
 * @param {unknown} value
 * @returns {value is any[][]}
 */
function isEventArray(value) {
  return Array.isArray(value) && value.every((event) => event === null || typeof event === 'object');
}

/**
 * Scrub a decisive excerpt: replace every caller-supplied private value, drop
 * control characters, bound the length, and record the truncation explicitly.
 * @param {string} text
 * @param {readonly string[]} redactions
 */
function scrubExcerpt(text, redactions) {
  let scrubbed = String(text ?? '');
  for (const secret of redactions) {
    if (typeof secret === 'string' && secret.length > 0) scrubbed = scrubbed.split(secret).join('<redacted>');
  }
  scrubbed = [...scrubbed].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 8 || (code >= 11 && code <= 31) || code === 127 ? ' ' : character;
  }).join('');
  const truncated = scrubbed.length > MAX_EXCERPT_CHARS;
  if (truncated) scrubbed = `${scrubbed.slice(0, MAX_EXCERPT_CHARS)}<truncated>`;
  return { text: scrubbed, truncated };
}

/**
 * Parse each consecutive line using the existing single-statement parsers.
 * One optional cell directive applies to every statement. Never accept a
 * partial prefix: a bad line or the statement bound rejects the whole cell.
 * @param {any} event
 * @returns {NonNullable<ReturnType<typeof parseCallEvent>>[] | null}
 */
export function parseCallStatements(event) {
  const payload = event?.payload;
  if (payload?.type !== 'custom_tool_call') {
    const call = parseCallEvent(event);
    return call ? [call] : null;
  }
  if (typeof payload.input !== 'string') return null;
  let source = payload.input;
  let prefix = '';
  const directive = DIRECTIVE_PATTERN.exec(source);
  if (directive) { prefix = directive[0]; source = source.slice(prefix.length); }
  const lines = source.replace(/\n$/u, '').split('\n');
  if (lines.length === 0 || lines.length > MAX_STATEMENTS_PER_CELL) return null;
  const calls = [];
  for (const line of lines) {
    // Preparation's existing parser accepts no directive; attach the parsed
    // directive separately after validating it through the wrapper parser.
    // Only discard padding at a statement line's boundary. Empty/whitespace
    // lines still reach the strict parser and reject the entire cell.
    const call = parseCallEvent({ payload: { ...payload, input: line.trim() } });
    if (!call) return null;
    if (prefix) {
      const framed = parseWrappedToolInput(`${prefix}text(await tools.wait({cell_id:"directive"}));`);
      if (!framed) return null;
      call.directive = framed.directive;
    }
    calls.push(call);
  }
  return calls;
}

/**
 * Parse one host call event into a bounded value. Supported shapes:
 *  1. direct function calls (`function_call` payloads named exec_command,
 *     write_stdin or wait with JSON arguments);
 *  2. simple code-mode wrapper calls (`custom_tool_call` payloads whose input
 *     is one bounded `const r = await tools.<tool>({...}); text(...)` script,
 *     or inline `text(await tools.<tool>({...}));`, optionally led by one
 *     `// @exec: {...}` directive line).
 * Shared with the launch observation gate so literal spelling cannot change
 * whether an exact command is recognized.
 * Anything else — including truncated JSON — returns `null` so the caller can
 * fail closed.
 * @param {{ type?: string, payload?: any }} event
 * @returns {{ kind: string, value: Record<string, unknown>, directive: Record<string, unknown> | null, wrapped: boolean } | null}
 */
export function parseCallEvent(event) {
  const payload = event?.payload;
  // ANY direct function_call is collected — including unsupported tool names —
  // so the sequence analysis can flag them; only the observational family is
  // sanctioned inside the identified child rollout.
  if (payload?.type === 'function_call' && typeof payload.name === 'string' && payload.name.length > 0) {
    let value;
    try { value = JSON.parse(payload.arguments); } catch { return null; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return { kind: payload.name, value, directive: null, wrapped: false };
  }
  if (payload?.type === 'custom_tool_call' && typeof payload.input === 'string') {
    const preparationMatch = PREPARATION_PATTERN.exec(payload.input);
    if (preparationMatch) {
      const envelope = parseWrapperArguments(preparationMatch[2]);
      if (!envelope || typeof envelope.version !== 'number') return null;
      return {
        kind: 'write_stdin',
        // Reconstruct the actual string input; never put observer metadata in
        // tool arguments where a caller-supplied flag could impersonate it.
        value: { session_id: Number(preparationMatch[1]), chars: `${JSON.stringify(envelope)}\n` },
        directive: null,
        wrapped: true,
      };
    }
    return parseWrappedToolInput(payload.input);
  }
  return null;
}

/** @param {unknown} chars @returns {Record<string, unknown> | null} */
function parsePreparationFrame(chars) {
  if (typeof chars !== 'string' || !chars.startsWith('{') || !chars.endsWith('}\n')
    || chars.slice(0, -1).includes('\n') || Buffer.byteLength(chars) > RESCUE_ENVELOPE_MAX_BYTES) return null;
  try {
    const text = chars.slice(0, -1);
    rejectDuplicatePreparationKeys(text);
    const envelope = JSON.parse(text);
    return envelope && typeof envelope === 'object' && !Array.isArray(envelope) ? envelope : null;
  } catch { return null; }
}

// Match the raw-text duplicate-key scan in production readRescuePreparation
// (scripts/lib/rescue-preparation.mjs: rejectDuplicateObjectKeys, called BEFORE
// JSON.parse). That private scanner is not exported: retain its decoded-key
// comparison, per-object key sets, array traversal and depth-64 bound here.
// Object validation alone cannot recover keys discarded by JSON.parse.
/** @param {string} text */
function rejectDuplicatePreparationKeys(text) {
  let offset = 0;
  const whitespace = () => { while (/\s/u.test(text[offset] ?? '')) offset += 1; };
  const string = () => {
    if (text[offset] !== '"') throw invalidEvidenceInput('invalid preparation JSON frame.');
    const start = offset++;
    let escaped = false;
    while (offset < text.length) {
      const character = text[offset++];
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character === '"') {
        try { return JSON.parse(text.slice(start, offset)); } catch { throw invalidEvidenceInput('invalid preparation JSON frame.'); }
      }
    }
    throw invalidEvidenceInput('invalid preparation JSON frame.');
  };
  const value = (depth = 0) => {
    if (depth > 64) throw invalidEvidenceInput('invalid preparation JSON frame.');
    whitespace();
    if (text[offset] === '{') return object(depth + 1);
    if (text[offset] === '[') return array(depth + 1);
    if (text[offset] === '"') { string(); return; }
    const start = offset;
    while (offset < text.length && !/[\s,\]}]/u.test(text[offset])) offset += 1;
    if (offset === start) throw invalidEvidenceInput('invalid preparation JSON frame.');
  };
  /** @param {number} depth */
  const object = (depth) => {
    offset += 1; whitespace();
    const keys = new Set();
    if (text[offset] === '}') { offset += 1; return; }
    while (offset < text.length) {
      whitespace(); const key = string(); whitespace();
      if (keys.has(key)) throw invalidEvidenceInput('invalid preparation JSON frame.');
      keys.add(key);
      if (text[offset++] !== ':') throw invalidEvidenceInput('invalid preparation JSON frame.');
      value(depth); whitespace();
      if (text[offset] === '}') { offset += 1; return; }
      if (text[offset++] !== ',') throw invalidEvidenceInput('invalid preparation JSON frame.');
    }
    throw invalidEvidenceInput('invalid preparation JSON frame.');
  };
  /** @param {number} depth */
  const array = (depth) => {
    offset += 1; whitespace();
    if (text[offset] === ']') { offset += 1; return; }
    while (offset < text.length) {
      value(depth); whitespace();
      if (text[offset] === ']') { offset += 1; return; }
      if (text[offset++] !== ',') throw invalidEvidenceInput('invalid preparation JSON frame.');
    }
    throw invalidEvidenceInput('invalid preparation JSON frame.');
  };
  whitespace(); value(); whitespace();
  if (offset !== text.length) throw invalidEvidenceInput('invalid preparation JSON frame.');
}

/**
 * Parse one bounded wrapper argument literal. Wrapper scripts are model
 * written: JSON parses first, and a string-aware JavaScript-literal fallback
 * covers the observed installed shape (unquoted keys, single-quoted strings,
 * true/false/null barewords). Anything else stays `null` — fail closed, never
 * guessed — and a value that is not a plain object is never accepted.
 * @param {unknown} text
 * @returns {Record<string, unknown> | null}
 */
function parseWrapperArguments(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_WRAPPER_ARGUMENT_CHARS) return null;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { /* the bounded literal fallback below */ }
  let out = '';
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '"' || character === "'") {
      let value = '';
      index += 1;
      while (index < text.length && text[index] !== character) {
        if (text[index] === '\\') { value += text.slice(index, index + 2); index += 2; continue; }
        value += text[index];
        index += 1;
      }
      if (index >= text.length) return null;
      index += 1;
      const normalized = character === '"' ? value : value.replace(/\\'/gu, "'").replace(/"/gu, '\\"');
      out += `"${normalized}"`;
      continue;
    }
    if (/[A-Za-z_$]/u.test(character)) {
      let word = '';
      while (index < text.length && /[A-Za-z0-9_$]/u.test(text[index])) { word += text[index]; index += 1; }
      let lookahead = index;
      while (lookahead < text.length && /\s/u.test(text[lookahead])) lookahead += 1;
      if (text[lookahead] === ':') out += `"${word}"`;
      else if (word === 'true' || word === 'false' || word === 'null') out += word;
      else return null;
      continue;
    }
    out += character;
    index += 1;
  }
  try {
    const value = JSON.parse(out);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

/** @param {string} input */
function parseWrappedToolInput(input) {
  let source = input;
  /** @type {Record<string, unknown> | null} */
  let directive = null;
  const directiveMatch = DIRECTIVE_PATTERN.exec(source);
  if (directiveMatch) {
    try {
      const parsed = JSON.parse(directiveMatch[1]);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      directive = parsed;
    } catch { return null; }
    source = source.slice(directiveMatch[0].length);
  }
  const wrapperMatch = WRAPPER_PATTERN.exec(source);
  const match = wrapperMatch ?? INLINE_WRAPPER_PATTERN.exec(source);
  if (!match) return null;
  if (match[2].length > MAX_WRAPPER_ARGUMENT_CHARS) return null;
  const value = parseWrapperArguments(match[2]);
  if (!value) return null;
  return { kind: match[1], value, directive, wrapped: true };
}

/**
 * Parse one host tool output. Completed outputs carry
 * `[{type:'input_text',text:'Script completed\n'},{type:'input_text',text:json}]`;
 * a pending yielded cell keeps the `Script running with cell ID <id>` shape.
 * @param {unknown} output
 * @returns {{ state: 'completed', result: Record<string, unknown>, wallTimeMs: number | null } | { state: 'pending', cellId: string } | null}
 */
function parseToolOutput(output) {
  if (!Array.isArray(output)) return null;
  const first = output[0];
  if (output.length >= 1 && first?.type === 'input_text' && typeof first.text === 'string'
    && first.text.startsWith(PENDING_CELL_PREFIX)) {
    const cellId = first.text.slice(PENDING_CELL_PREFIX.length).split('\n')[0]?.trim();
    if (!cellId || cellId.length > 128) return null;
    return { state: 'pending', cellId };
  }
  // The host prepends its response header (chunk id, wall time, exit code) to
  // the output text, so the result JSON is located by parsing the bounded
  // input_text items rather than by fixed positions.
  let result;
  for (const item of /** @type {any[]} */ (output)) {
    if (item?.type !== 'input_text' || typeof item.text !== 'string' || item.text.length > 65536) continue;
    try {
      const parsed = JSON.parse(item.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) result = parsed;
    } catch { /* header and progress text items are not JSON */ }
  }
  if (!result) return null;
  return { state: 'completed', result, wallTimeMs: extractWallTimeMs(output) };
}

/**
 * Extract the tool-reported wall time (milliseconds) from a completed host
 * output's header text; `null` when the host did not report one.
 * @param {unknown[]} output
 */
function extractWallTimeMs(output) {
  for (const item of /** @type {any[]} */ (output)) {
    if (item?.type !== 'input_text' || typeof item.text !== 'string') continue;
    const match = WALL_TIME_PATTERN.exec(item.text);
    if (!match) continue;
    const seconds = Number(match[1]);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.round(seconds * 1000);
  }
  return null;
}

/** @param {unknown} value @returns {number | null} */
function readHandleId(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) > 0 ? /** @type {number} */ (value) : null;
}

/** @param {unknown} value @returns {string | null} */
function boundedText(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_COMMAND_BYTES ? value : null;
}

/**
 * Inspect shell wait evidence and return supported facts or an explicit
 * inconclusive reason. See the module documentation for the supported shapes
 * and the fail-closed rules.
 * @param {ShellWaitEvidenceInput} input
 * @returns {{ status: 'supported', inconclusive: null, facts: Record<string, unknown> }
 *   | { status: 'inconclusive', inconclusive: { reason: string, detail: string, manualAdjudicationRequired?: boolean, excerpt?: { text: string, truncated: boolean } }, facts: null }}
 */
export function inspectShellWaitEvidence(input) {
  if (!input || typeof input !== 'object') throw invalidEvidenceInput('the evidence input must be an object.');
  const rollouts = input.rollouts;
  if (!Array.isArray(rollouts) || !rollouts.every(isEventArray)) {
    throw invalidEvidenceInput('rollouts must be an array of parsed rollout event arrays.');
  }
  const command = boundedText(input.command);
  if (!command) throw invalidEvidenceInput('command must be the bounded exact launcher command string.');
  const redactions = Array.isArray(input.redactions) ? input.redactions : [];
  if (rollouts.length === 0) return inconclusive('rollouts-unavailable', 'No rollout evidence was collected.');
  for (const events of rollouts) {
    if (events.length > MAX_EVENTS_PER_ROLLOUT) return inconclusive('rollouts-overflow', 'A rollout exceeds the observer event bound.');
  }

  // Fail closed on any observed call shape this instrument does not support:
  // an unparseable simple wrapper OR a direct function call whose bounded
  // arguments are truncated or not a plain object is inconclusive, never zero.
  for (const events of rollouts) {
    for (const event of /** @type {any[]} */ (events)) {
      const payload = event?.payload;
      if (payload?.type === 'custom_tool_call') {
        if (parseCallStatements(event) !== null) continue;
        const excerpt = scrubExcerpt(typeof payload.input === 'string' ? payload.input : JSON.stringify(payload.input), redactions);
        return inconclusive('unsupported-call-shape',
          'A collected tool call does not match a supported shape (direct call, simple wrapper, or linked outer continuation); the case needs manual adjudication.',
          { manualAdjudicationRequired: true, excerpt });
      }
      // EVERY direct function_call is validated — including unsupported tool
      // names — so a truncated or non-object payload cannot bypass the
      // fail-closed scan just because its tool is not part of the observational
      // family.
      if (payload?.type === 'function_call' && typeof payload.name === 'string' && payload.name.length > 0) {
        let value;
        try { value = JSON.parse(payload.arguments); } catch {
          const excerpt = scrubExcerpt(typeof payload.arguments === 'string' ? payload.arguments : JSON.stringify(payload.arguments), redactions);
          return inconclusive('unsupported-call-shape',
            'A collected direct tool call has truncated or unparsable arguments; the case needs manual adjudication.',
            { manualAdjudicationRequired: true, excerpt });
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          const excerpt = scrubExcerpt(typeof payload.arguments === 'string' ? payload.arguments : JSON.stringify(payload.arguments), redactions);
          return inconclusive('unsupported-call-shape',
            'A collected direct tool call has arguments of an unsupported shape; the case needs manual adjudication.',
            { manualAdjudicationRequired: true, excerpt });
        }
      }
    }
  }

  // Validate event ownership before expanding statements or correlating any
  // response. One event may own several statements, but two events can never
  // share an ID, and one event can never have multiple response records.
  for (const events of rollouts) {
    const ambiguity = inspectCallOwnership(events);
    if (ambiguity !== null) return inconclusive('ambiguous-call-linkage', ambiguity);
  }

  const withMeta = rollouts.filter((events) => /** @type {any[]} */ (events).some((event) => event?.type === 'session_meta' && typeof event?.payload?.id === 'string'));
  if (withMeta.length === 0) {
    return inconclusive('rollouts-unavailable', 'No rollout exposes session metadata; parent and child rollouts cannot be identified.');
  }

  const linkage = inspectLinkage(rollouts);
  const calls = linkage.childEvents ? collectCalls(linkage.childEvents) : null;
  const companion = inspectCompanion(calls, command, input.zcodeCalls, redactions);
  const sequence = calls === null ? null : analyzeCallSequence(calls, command);
  const handle = {
    originalHandleId: sequence?.originalHandleId ?? null,
    pollCount: sequence?.pollCount ?? null,
    preparationFrameWrites: sequence?.preparationWrites ?? null,
    foreignHandlePolls: sequence?.foreignHandlePolls ?? null,
    overlappingInnerPolls: sequence?.overlappingInnerPolls ?? null,
    originalHandleChecked: sequence === null ? null : sequence.originalHandleChecked,
  };
  const observations = inspectObservations(linkage, calls, input, sequence);
  const completion = inspectCompletion(linkage, companion, handle, sequence, observations, input);

  return {
    status: 'supported',
    inconclusive: null,
    facts: {
      linkage: linkage.facts, companion, handle, observations, completion,
      collection: {
        rolloutCount: rollouts.length,
        childToolCallCount: calls?.length ?? null,
        truncated: (calls?.length ?? 0) > MAX_DIAGNOSTIC_EXCERPTS,
        // Pre-launch diagnostics already have their own excerpt kind. Keep
        // successful launch/observation evidence too; count is not an excerpt
        // count. Never retain a private preparation prompt in call arguments.
        excerpts: (calls ?? []).slice(0, MAX_DIAGNOSTIC_EXCERPTS)
          .filter((entry) => !(entry.call.kind === 'exec_command' && entry.call.value.cmd !== command
            && entry.callIndex < (calls?.find((call) => call.call.kind === 'exec_command' && call.call.value.cmd === command)?.callIndex ?? -1)))
          .map(({ call }) => ({ kind: 'rollout-tool-call', ...scrubExcerpt(JSON.stringify({
            tool: call.kind,
            arguments: { ...call.value, ...(typeof call.value.chars === 'string' && call.value.chars.length > 0 ? { chars: '<private-input>' } : {}) },
          }), redactions) })),
      },
    },
  };
}

/** @param {string} reason @param {string} detail @param {{ manualAdjudicationRequired?: boolean, excerpt?: { text: string, truncated: boolean } }} [extra] @returns {{ status: 'inconclusive', inconclusive: { reason: string, detail: string, manualAdjudicationRequired?: boolean, excerpt?: { text: string, truncated: boolean } }, facts: null }} */
function inconclusive(reason, detail, extra = {}) {
  return { status: 'inconclusive', inconclusive: { reason, detail, ...extra }, facts: null };
}

/**
 * Identify the parent and child rollouts and check the exact native Child
 * linkage: exactly one spawn_agent call, exactly one SubAgentActivity start,
 * and exactly one retained child rollout whose metadata retains the original
 * child id, parent id, and agent path.
 * @param {any[][]} rollouts
 */
function inspectLinkage(rollouts) {
  /** @type {Record<string, unknown>[] | undefined} */
  let parentEvents;
  /** @type {string | null} */
  let parentThreadId = null;
  const spawnCandidates = rollouts.filter((events) => /** @type {any[]} */ (events).some((event) => event?.payload?.type === 'function_call' && event.payload?.name === 'spawn_agent'));
  if (spawnCandidates.length === 1) {
    parentEvents = spawnCandidates[0];
    const meta = /** @type {any} */ (parentEvents.find((event) => event?.type === 'session_meta'));
    parentThreadId = typeof meta?.payload?.id === 'string' ? meta.payload.id : null;
  }
  const started = parentEvents?.filter((/** @type {any} */ event) => event?.type === 'event_msg'
    && event.payload?.item?.type === 'SubAgentActivity' && event.payload.item.kind === 'started') ?? [];
  const spawnEvents = parentEvents?.filter((/** @type {any} */ event) => event?.payload?.type === 'function_call' && event.payload?.name === 'spawn_agent') ?? [];
  const spawnCount = spawnEvents.length;
  /** @type {string | null} */
  let agentType = null;
  if (spawnEvents.length === 1) {
    try {
      const arguments_ = JSON.parse(/** @type {any} */ (spawnEvents[0].payload).arguments);
      if (arguments_ && typeof arguments_ === 'object' && typeof arguments_.agent_type === 'string') agentType = arguments_.agent_type;
    } catch { /* an unparsable spawn record leaves the agent type unknown */ }
  }
  const firstStarted = /** @type {any} */ (started[0]);
  const childThreadId = started.length === 1 && typeof firstStarted?.payload?.item?.agent_thread_id === 'string'
    ? firstStarted.payload.item.agent_thread_id
    : null;
  const agentPath = started.length === 1 && typeof firstStarted?.payload?.item?.agent_path === 'string'
    ? firstStarted.payload.item.agent_path
    : null;
  const childCandidates = childThreadId === null
    ? []
    : rollouts.filter((events) => /** @type {any[]} */ (events).some((event) => event?.type === 'session_meta' && event.payload?.id === childThreadId));
  const childEvents = childCandidates.length === 1 ? childCandidates[0] : undefined;
  const childMeta = childCandidates.length === 1
    ? /** @type {any} */ (childCandidates[0].find((event) => event?.type === 'session_meta'))?.payload
    : undefined;
  let reason;
  if (spawnCandidates.length === 0) reason = 'no parent rollout exposes a spawn_agent call';
  else if (spawnCandidates.length > 1) reason = 'more than one parent rollout exposes spawn_agent calls';
  else if (spawnCount !== 1) reason = `the parent exposes ${String(spawnCount)} spawn_agent calls`;
  else if (started.length === 0) reason = 'the child start event is missing';
  else if (started.length > 1) reason = `the parent exposes ${String(started.length)} child start events`;
  else if (childCandidates.length === 0) reason = 'no retained child rollout matches the started child thread id';
  else if (childCandidates.length > 1) reason = `the child thread id matches ${String(childCandidates.length)} retained rollouts`;
  else if (childMeta?.parent_thread_id !== parentThreadId) reason = 'the child metadata does not retain the original parent thread id';
  else if (childMeta?.source?.subagent?.thread_spawn?.agent_path !== agentPath) reason = 'the child metadata does not retain the original agent path';
  const exact = reason === undefined;
  return {
    exact,
    reason,
    spawnCount,
    startCount: started.length,
    childThreadId,
    parentThreadId,
    agentPath,
    agentType,
    childEvents,
    parentEvents,
    facts: {
      checked: true,
      exact,
      reason: exact ? null : `incomplete or wrong Child linkage: ${reason}.`,
      spawnCount,
      startCount: started.length,
      childThreadId,
      parentThreadId,
      agentPath,
      agentType,
    },
  };
}

/**
 * Validate call/response IDs at event scope, before statement expansion.
 * Missing responses remain unresolved; malformed, orphaned, duplicated or
 * out-of-order responses cannot supply execution evidence.
 * @param {any[]} events
 * @returns {string | null}
 */
function inspectCallOwnership(events) {
  const callIds = new Set();
  const responseIds = new Set();
  for (const event of events) {
    const payload = event?.payload;
    const isCall = payload?.type === 'custom_tool_call' || payload?.type === 'function_call';
    const isResponse = payload?.type === 'custom_tool_call_output' || payload?.type === 'function_call_output';
    if (!isCall && !isResponse) continue;
    const callId = payload.call_id;
    if (typeof callId !== 'string' || callId.trim().length === 0) {
      return 'A call or response event lacks a nonempty string call ID; response ownership is unknown.';
    }
    if (isCall) {
      if (callIds.has(callId)) return 'Separate call events share a call ID; response ownership is ambiguous.';
      callIds.add(callId);
    } else {
      if (!callIds.has(callId)) return 'A response has no preceding call event with its exact ID; response ownership is unknown.';
      if (responseIds.has(callId)) return 'Multiple response events share a call ID; response ownership is ambiguous.';
      responseIds.add(callId);
    }
  }
  return null;
}

/**
 * Collect the bounded host calls of one rollout with their linked outputs.
 * Event IDs have already passed inspectCallOwnership; only statements
 * expanded from the same event may share that event's response.
 * @param {any[]} events
 */
function collectCalls(events) {
  /** @type {Map<string, { output: unknown, index: number }>} */
  const outputs = new Map();
  for (const [index, event] of events.entries()) {
    const payload = event?.payload;
    if (payload?.type === 'custom_tool_call_output' || payload?.type === 'function_call_output') {
      outputs.set(payload.call_id, { output: payload.output, index });
    }
  }
  /** @type {{ callId: string, call: NonNullable<ReturnType<typeof parseCallEvent>>, output: ReturnType<typeof parseToolOutput>, callIndex: number, outputIndex: number | null, cellWallTimeMs: number | null }[]} */
  const calls = [];
  for (const [index, event] of events.entries()) {
    const parsed = parseCallStatements(event);
    if (!parsed) continue;
    const callId = event.payload.call_id;
    const response = outputs.get(callId);
    const results = parseStatementOutputs(response?.output, parsed.length);
    // A multi-statement cell's host wall time covers every awaited statement,
    // so it is recorded at cell scope (on the cell's last entry) and never
    // attributed to one observation's duration.
    const cellWallTimeMs = parsed.length > 1 && Array.isArray(response?.output)
      ? extractWallTimeMs(response.output)
      : null;
    for (const [statementIndex, call] of parsed.entries()) {
      const output = results[statementIndex] ?? null;
      const callIndex = index + statementIndex / MAX_STATEMENTS_PER_CELL;
      // Completed earlier statements in a strict awaited sequence resolve
      // before the next line. The last result resolves at the host response;
      // missing/ambiguous results retain their actual outstanding position.
      const resolvedInline = parsed.length > 1 && statementIndex < parsed.length - 1
        && output?.state === 'completed' && response && response.index > index;
      calls.push({ callId, call, output, callIndex,
        outputIndex: resolvedInline ? callIndex + 1 / (2 * MAX_STATEMENTS_PER_CELL) : response?.index ?? null,
        cellWallTimeMs: statementIndex === parsed.length - 1 ? cellWallTimeMs : null });
    }
  }
  return calls;
}

/**
 * A cell prints one JSON object per completed awaited statement in order.
 * Refuse incomplete/extra completed result lists instead of assigning the last
 * object to every call. A yielded cell's completed prefix precedes its pending
 * statement; unexecuted suffixes stay unresolved and cannot qualify completion.
 * @param {unknown} output
 * @param {number} count
 * @returns {ReturnType<typeof parseToolOutput>[]}
 */
function parseStatementOutputs(output, count) {
  if (count === 1) return [parseToolOutput(output)];
  if (!Array.isArray(output)) return [];
  /** @type {ReturnType<typeof parseToolOutput>[]} */
  const results = [];
  for (const item of output) {
    if (item?.type !== 'input_text' || typeof item.text !== 'string' || item.text.length > 65536) continue;
    try {
      const result = JSON.parse(item.text);
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        results.push({ state: /** @type {const} */ ('completed'), result, wallTimeMs: null });
      }
    } catch { /* bounded header text */ }
  }
  const pending = parseToolOutput(output);
  // The pending header is authoritative regardless of how many completed
  // result objects accompany it: a cell that reports every statement's result
  // while its pending header stands has NOT completed its last awaited
  // statement. Full results plus a pending status is contradictory evidence,
  // so nothing in the cell resolves and completion stays blocked.
  if (pending?.state === 'pending') {
    if (results.length < count) return [...results, pending];
    return [];
  }
  if (results.length !== count) return [];
  return results;
}

/**
 * Count the exact launcher invocations and the fake-peer sends.
 * @param {ReturnType<typeof collectCalls> | null} calls
 * @param {string} command
 * @param {unknown} zcodeCalls
 * @param {readonly string[]} redactions
 */
function inspectCompanion(calls, command, zcodeCalls, redactions) {
  const launchCount = calls === null ? null : calls.filter(({ call }) => call.kind === 'exec_command' && call.value.cmd === command).length;
  // The fake peer's record holds the Companion's JSON-RPC requests: plain
  // objects with a non-empty bounded string `method` (session/*,
  // v4/conversation/*, interaction/*, fixture/*). EVERY entry is validated —
  // one valid send mixed with malformed lines still leaves the peer record
  // unknown, which blocks qualification instead of skipping the send check.
  const entries = Array.isArray(zcodeCalls) ? /** @type {any[]} */ (zcodeCalls) : null;
  /** @param {string} value */
  const hasControlCharacter = (value) => [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
  const isSupportedPeerEntry = (/** @type {any} */ entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    && typeof entry.method === 'string' && entry.method.length > 0 && entry.method.length <= 128
    && !hasControlCharacter(entry.method);
  const validEntries = entries ? entries.filter((entry) => isSupportedPeerEntry(entry)) : [];
  const malformedCount = entries ? entries.length - validEntries.length : 0;
  const sendCount = entries ? validEntries.filter((record) => record.method === 'session/send').length : null;
  const sendCountKnown = entries !== null && malformedCount === 0;
  const sendCountUnknownReason = entries === null
    ? 'the fake-peer record is unavailable'
    : malformedCount > 0
      ? `${String(malformedCount)} of ${String(entries.length)} recorded peer entries do not match a supported JSON-RPC request shape`
      : null;
  const launch = calls?.find(({ call }) => call.kind === 'exec_command' && call.value.cmd === command);
  const diagnostics = launch ? calls?.filter((entry) => entry.call.kind === 'exec_command'
    && entry.call.value.cmd !== command && entry.callIndex < launch.callIndex) ?? [] : [];
  return {
    preLaunchDiagnostics: calls === null ? null : {
      count: diagnostics.length,
      truncated: diagnostics.length > MAX_DIAGNOSTIC_EXCERPTS,
      excerpts: diagnostics.slice(0, MAX_DIAGNOSTIC_EXCERPTS).map(({ call }) => ({
        kind: 'pre-launch-diagnostic', ...scrubExcerpt(JSON.stringify(call.value), redactions),
      })),
    },
    launchCount,
    duplicateLaunch: launchCount !== null && launchCount > 1,
    sendCount,
    sendCountKnown,
    sendCountUnknownReason,
  };
}

/**
 * Walk the child's call sequence once and resolve every observation invariant:
 * one original handle, empty-input polls of only that handle, no overlapping
 * inner polls, and outer continuations that link back to the EXACT pending
 * cell they continue. A completed wait output is accepted as a result on the
 * original handle only when it resolves that handle's pending cell; missing,
 * foreign, or ambiguous linkage is rejected — pending state stays pending, the
 * output never qualifies completion, and a violation is recorded.
 * @param {ReturnType<typeof collectCalls>} calls
 * @param {string} command
 */
function analyzeCallSequence(calls, command) {
  const launch = calls.find(({ call }) => call.kind === 'exec_command' && call.value.cmd === command);
  const originalHandleId = launch && launch.output?.state === 'completed' ? readHandleId(launch.output.result.session_id) : null;
  let pollCount = 0;
  let preparationWrites = 0;
  let foreignHandlePolls = 0;
  let overlappingInnerPolls = 0;
  // EVENT-ORDER state: `pendingCell` is the latest known pending yielded cell
  // (awaiting an outer continuation); `unresolvedObservation` marks an
  // ambiguous/missing output record; `awaitingResolution.outputIndex` is the
  // event index at which the latest original-handle poll's own response
  // arrived — an observation stays outstanding until that position, so a
  // second same-handle poll issued before it is an overlap, even though the
  // rollout's records show a completed result.
  /** @type {{ cellId: string, handleId: number, ownerCallId: string, sanctionedPreparation: boolean } | null} */
  let pendingCell = null;
  /** @type {'unresolved' | null} */
  let unresolvedObservation = null;
  /** @type {boolean} */
  let continuationGap = false;
  /** @type {{ outstanding: string, returned: string } | null} */
  let contradictedContinuation = null;
  /** @type {'unresolved' | null} */
  let unresolvedContinuation = null;
  /** @type {{ outputIndex: number | null } | null} */
  let awaitingResolution = null;
  /** @type {{ result: Record<string, unknown>, wallTimeMs: number | null, index: number } | null} */
  let lastCompletedOnHandle = null;
  let terminalIndex = null;
  let observationsAfterTerminal = false;
  const acceptedWaitCallIds = new Set();
  /** @type {string[]} */
  const outerLinkageViolations = [];
  /** @type {string[]} */
  const disciplineViolations = [];
  /** @type {Map<string, number>} */
  const completedPollsByCell = new Map();
  /** @param {string} ownerCallId */
  function countCompletedPoll(ownerCallId) {
    const completedPolls = (completedPollsByCell.get(ownerCallId) ?? 0) + 1;
    completedPollsByCell.set(ownerCallId, completedPolls);
    if (completedPolls === 2) {
      disciplineViolations.push('batching multiple completed terminal polls in one cell violates the terminal observation discipline (spec section 4)');
    }
  }
  const additionalExecs = calls.filter((entry) => entry.call.kind === 'exec_command' && entry !== launch
    && (entry.call.value.cmd === command || (launch && entry.callIndex > launch.callIndex)));
  if (additionalExecs.length > 0) {
    disciplineViolations.push(`${String(additionalExecs.length)} additional exec_command process launch(es) beyond the single authorized companion command`);
  }
  const overlappingDiagnostics = launch ? calls.filter((entry) => entry.call.kind === 'exec_command'
    && entry.callIndex < launch.callIndex && entry.call.value.cmd !== command
    && (entry.outputIndex === null || entry.outputIndex > launch.callIndex || entry.output?.state !== 'completed'
      || !Number.isSafeInteger(entry.output.result.exit_code) || readHandleId(entry.output.result.session_id) !== null)) : [];
  if (overlappingDiagnostics.length > 0) {
    disciplineViolations.push(`${String(overlappingDiagnostics.length)} pre-launch diagnostic exec_command call(s) overlap the companion observation window or have unresolved lifetime`);
  }
  // Only the observational tool family is sanctioned inside the identified
  // child rollout; the spawn_agent/wait_agent family lives in the PARENT
  // rollout and is analyzed as Root joins there. Any other direct or wrapped
  // tool call here — a forbidden sleep, list, or anything else — is recorded.
  const unsupportedToolNames = [...new Set(calls
    .map(({ call }) => call.kind)
    .filter((kind) => !['exec_command', 'write_stdin', 'wait'].includes(kind)))];
  if (unsupportedToolNames.length > 0) {
    disciplineViolations.push(`unsupported tool call(s) in the child rollout: ${unsupportedToolNames.join(', ')}`);
  }
  for (const [index, entry] of calls.entries()) {
    const { call, output } = entry;
    if (call.kind === 'exec_command') {
      if (entry === launch && output?.state === 'completed' && originalHandleId !== null && readHandleId(output.result.session_id) === originalHandleId) {
        lastCompletedOnHandle = { result: output.result, wallTimeMs: output.wallTimeMs, index };
      }
      continue;
    }
    if (call.kind === 'write_stdin') {
      const pollHandle = readHandleId(call.value.session_id);
      const onOriginalHandle = originalHandleId !== null && pollHandle === originalHandleId;
      // The sanctioned private v5 preparation frame (spec S2): exactly ONE
      // nonempty write to the original handle carrying the prepared task
      // envelope followed by exactly one LF, before ANY terminal observation.
      // Both direct and wrapped calls retain string chars; only our structural
      // analysis grants the exception, never an argument-level flag.
      const preparationEnvelope = parsePreparationFrame(call.value?.chars);
      let sanctionedPreparation = false;
      if (preparationEnvelope !== null) {
        let validEnvelope = false;
        try { validEnvelope = validateRescuePreparation(preparationEnvelope).version === 5; }
        catch { /* malformed envelopes never receive the preparation exception */ }
        if (preparationWrites > 0) disciplineViolations.push('a second private preparation frame was written (the sanctioned frame is one-shot)');
        else if (!onOriginalHandle) disciplineViolations.push('a private preparation frame was written to a foreign handle');
        else if (!validEnvelope) disciplineViolations.push('a private preparation frame carried an invalid or unexpected v5 envelope');
        else if (pollCount > 0) disciplineViolations.push('a private preparation frame was written after a terminal observation');
        else { preparationWrites += 1; sanctionedPreparation = true; }
      }
      // Preparation exempts only the nonempty input and poll count. Its own
      // response, pending cell and event-order resolution use the same state
      // machine as every other original-handle operation below.
      if (!sanctionedPreparation) pollCount += 1;
      if (originalHandleId !== null && !onOriginalHandle) foreignHandlePolls += 1;
      if (onOriginalHandle) {
        // Spec section 4 forbids batching polls to manufacture fewer model
        // decisions. Event-owned call IDs identify the cell; the sanctioned
        // preparation write is not a terminal poll.
        if (!sanctionedPreparation && output?.state === 'completed') {
          countCompletedPoll(entry.callId);
        }
        // Empty-input terminal observation discipline (spec S2): every
        // original-handle observation must send NO characters. Only the
        // validated one-shot preparation above is exempt; any other nonempty
        // or malformed chars value here is input injection.
        const charsValue = call.value?.chars;
        if (!sanctionedPreparation && typeof charsValue !== 'string') {
          disciplineViolations.push(`an original-handle observation sent a malformed chars value of type ${typeof charsValue} instead of empty input`);
        } else if (!sanctionedPreparation && charsValue !== '') {
          disciplineViolations.push(`an original-handle observation sent ${JSON.stringify(charsValue)} instead of empty input (input injection into the observed companion process)`);
        }
        // A poll is resolved only at ITS OWN response's event position: a
        // completed output recorded AFTER a later same-handle poll was issued
        // does not retroactively resolve it, so the later poll overlaps.
        const stillOutstanding = awaitingResolution !== null
          && (awaitingResolution.outputIndex === null || awaitingResolution.outputIndex > entry.callIndex);
        if (stillOutstanding) overlappingInnerPolls += 1;
        if (output?.state === 'pending') {
          pendingCell = { cellId: output.cellId, handleId: pollHandle, ownerCallId: entry.callId, sanctionedPreparation };
          continuationGap = false;
          unresolvedObservation = null;
          awaitingResolution = { outputIndex: null };
        } else if (output?.state === 'completed') {
          // A later successful poll settles ITS OWN observation, but it can
          // never retroactively settle an earlier unparseable response: the
          // ambiguity latches and keeps blocking qualification.
          pendingCell = null;
          lastCompletedOnHandle = { result: output.result, wallTimeMs: output.wallTimeMs, index };
          if (Number.isSafeInteger(output.result.exit_code)) terminalIndex = index;
          awaitingResolution = { outputIndex: entry.outputIndex ?? null };
        } else {
          // An unparseable/missing output never settles: the observation stays
          // outstanding, so any later same-handle poll overlaps it too.
          pendingCell = null;
          unresolvedObservation = 'unresolved';
          awaitingResolution = { outputIndex: null };
        }
      }
      continue;
    }
    if (call.kind === 'wait') {
      if (pendingCell === null && unresolvedObservation === null) {
        outerLinkageViolations.push('an outer continuation arrived without a pending inner observation of the original handle');
        continue;
      }
      if (pendingCell === null && unresolvedObservation !== null) {
        outerLinkageViolations.push('an outer continuation arrived while the previous observation was unresolved or ambiguous');
        continue;
      }
      // The supported canonical reference is an exact `cell_id` string match.
      // Alias fields never substitute for it, and any alias that disagrees —
      // with the pending cell or with the canonical cell_id — is a conflicting
      // linkage: the foreign result must never be attributed to this handle.
      // Reference values are compared at their ORIGINAL types — no string
      // coercion — so an array or object reference can never stringify its way
      // into a match; a present alias with a non-string value is malformed.
      const pendingCellId = /** @type {any} */ (pendingCell).cellId;
      const canonicalRaw = call.value?.cell_id;
      const canonical = typeof canonicalRaw === 'string' ? canonicalRaw : null;
      const aliasEntries = ['cellId', 'call_id', 'id']
        .map((field) => (call.value?.[field] !== undefined ? { field, value: call.value[field] } : null))
        .filter((entry) => entry !== null);
      const malformedAliases = aliasEntries.filter(({ value }) => typeof value !== 'string');
      const conflictingAliases = aliasEntries.filter(({ value }) => typeof value === 'string' && value !== pendingCellId);
      if (canonicalRaw !== undefined && canonical === null) {
        outerLinkageViolations.push(`the outer continuation's canonical cell_id is not a string (${typeof canonicalRaw}); its linkage is malformed`);
        continue;
      }
      if (canonical === null) {
        outerLinkageViolations.push(`the outer continuation does not reference the pending cell (${pendingCellId}) through its canonical cell_id (canonical cell_id missing; alias-only references are insufficient); its linkage is missing, foreign, or conflicting`);
        continue;
      }
      if (canonical !== pendingCellId) {
        outerLinkageViolations.push(`the outer continuation does not reference the pending cell (${pendingCellId}) through its canonical cell_id (canonical cell_id ${canonical}); its linkage is missing, foreign, or conflicting`);
        continue;
      }
      if (malformedAliases.length > 0) {
        outerLinkageViolations.push(`the outer continuation's reference fields ${malformedAliases.map(({ field, value }) => `${field} of type ${typeof value}`).join(', ')} are not strings; its linkage is malformed`);
        continue;
      }
      if (conflictingAliases.length > 0) {
        outerLinkageViolations.push(`the outer continuation's reference fields conflict: canonical cell_id ${canonical} vs ${conflictingAliases.map(({ field, value }) => `${field} ${value}`).join(', ')} while the pending cell is ${pendingCellId}`);
        continue;
      }
      acceptedWaitCallIds.add(entry.callId);
      // A missing or unparseable ACCEPTED-WAIT response is incomplete evidence.
      // It latches ONLY when a later wait for the same cell then RESOLVES it:
      // the resolution cannot be attributed across the unattributable gap. A
      // PARSED PENDING response (the cell is still running) is VALID evidence —
      // legitimate long waits chain multiple outer continuations — and a
      // REPEATED wait for the still-unresolved cell blocks nothing beyond the
      // pending tail itself.
      if (output === null) {
        continuationGap = true;
      }
      // A parsed PENDING response naming a DIFFERENT cell than the outstanding
      // one is contradictory continuation evidence: it can never be attributed
      // to the wait's outstanding cell, so it latches a blocking violation
      // (same family as the exact-cell linkage rules).
      if (output?.state === 'pending' && pendingCell !== null && output.cellId !== pendingCell.cellId) {
        contradictedContinuation = {
          outstanding: pendingCell.cellId,
          returned: output.cellId,
        };
      }
      // pendingCell is only ever assigned inside the onOriginalHandle branch
      // above, so its handleId always equals originalHandleId here — no
      // foreign-handle case exists to guard.
      if (output?.state === 'completed') {
        if (continuationGap) unresolvedContinuation = 'unresolved';
        // Charge the completed poll to its original cell, not this wait's
        // call ID. Clearing pendingCell consumes the completion exactly once;
        // preparation keeps its exemption across pending continuations.
        if (pendingCell !== null && !pendingCell.sanctionedPreparation) {
          countCompletedPoll(pendingCell.ownerCallId);
        }
        pendingCell = null;
        lastCompletedOnHandle = { result: output.result, wallTimeMs: output.wallTimeMs, index };
        if (Number.isSafeInteger(output.result.exit_code)) terminalIndex = index;
        // The linked continuation's own response is the resolution point: a
        // later same-handle poll issued before THIS output index would still
        // overlap, but polls issued after it are sequential.
        awaitingResolution = { outputIndex: entry.outputIndex ?? null };
      }
    }
  }
  if (terminalIndex !== null) {
    for (const [index, entry] of calls.entries()) {
      if (index <= terminalIndex) continue;
      if (entry.call.kind === 'write_stdin' && originalHandleId !== null && readHandleId(entry.call.value.session_id) === originalHandleId) {
        observationsAfterTerminal = true;
      }
    }
  }
  return {
    originalHandleId,
    pollCount,
    preparationWrites,
    foreignHandlePolls,
    overlappingInnerPolls,
    originalHandleChecked: foreignHandlePolls === 0 && overlappingInnerPolls === 0,
    pendingInnerAtEnd: pendingCell !== null || unresolvedObservation !== null,
    unresolvedContinuation,
    contradictedContinuation,
    acceptedWaitCallIds,
    outerLinkageViolations,
    disciplineViolations,
    lastCompletedOnHandle,
    observationsAfterTerminal,
  };
}

/**
 * Count model-visible child decisions, outer continuations, and Root joins as
 * three separated observations, carrying the harness-reported decisive wall
 * time when the host tool actually reported one.
 * @param {ReturnType<typeof inspectLinkage>} linkage
 * @param {ReturnType<typeof collectCalls> | null} calls
 * @param {ShellWaitEvidenceInput} input
 */
function inspectObservations(linkage, calls, input, /** @type {any} */ sequence) {
  const parentEvents = linkage.parentEvents ?? [];
  const rootJoins = /** @type {any[]} */ (parentEvents).filter((event) => event?.payload?.type === 'function_call' && event.payload?.name === 'wait_agent').length;
  const outerReturns = calls === null ? null : calls.filter(({ call }) => call.kind === 'wait').length;
  const modelCalls = linkage.childEvents === undefined ? null : /** @type {any[]} */ (linkage.childEvents).filter((event) => {
    const payload = event?.payload;
    return payload?.type === 'function_call' || payload?.type === 'custom_tool_call';
  }).length;
  const pendingInnerAtEnd = calls === null ? null : sequence.pendingInnerAtEnd;
  // Whole-cell host wall time (cell scope, not one observation's duration):
  // the terminal multi-statement cell's total, when the host reported one.
  const cellWallTimeMs = calls === null ? null
    : /** @type {any[]} */ (calls).reduce((/** @type {number | null} */ last, entry) => (
      typeof entry?.cellWallTimeMs === 'number' ? entry.cellWallTimeMs : last), null);
  // Decisive wall times are filled in by the caller once the terminal tool
  // output is known (tool-reported value first, harness override as fallback).
  const decisiveWallMs = typeof input.observedWallMs === 'number' && Number.isSafeInteger(input.observedWallMs) ? input.observedWallMs : null;
  const workerDurationMs = typeof input.workerDurationMs === 'number' && Number.isSafeInteger(input.workerDurationMs) ? input.workerDurationMs : null;
  const remainingLifetimeMs = decisiveWallMs !== null && workerDurationMs !== null && workerDurationMs >= decisiveWallMs
    ? workerDurationMs - decisiveWallMs
    : null;
  return { outerReturns, rootJoins, modelCalls, pendingInnerAtEnd, cellWallTimeMs, decisiveWallMs, remainingLifetimeMs };
}

/**
 * Qualify completion only when the exact contract held end to end: exact Child
 * linkage, exactly one launcher invocation, same-handle observation, a terminal
 * exit observed on the original handle, and a byte-for-byte public result.
 * @param {ReturnType<typeof inspectLinkage>} linkage
 * @param {ReturnType<typeof inspectCompanion>} companion
 * @param {ReturnType<typeof analyzeCallSequence> | null} sequence
 * @param {ReturnType<typeof inspectObservations>} observations
 * @param {ShellWaitEvidenceInput} input
 */
function inspectCompletion(linkage, companion, /** @type {any} */ handle, /** @type {any} */ sequence, observations, input) {
  const terminal = sequence?.lastCompletedOnHandle ?? null;
  const terminalResult = terminal?.result ?? null;
  const processExit = terminalResult && Number.isSafeInteger(terminalResult.exit_code) ? /** @type {number} */ (terminalResult.exit_code) : null;
  // The sentinel is the fake peer's result body, not the entire rendered
  // companion stdout (which includes LF and resumability text). Compare its
  // bytes only in the linked terminal output, never host JSONL or messages.
  const publicResultMatched = typeof input.publicResult === 'string' && input.publicResult.length > 0 && terminalResult
    ? typeof terminalResult.output === 'string' && terminalResult.output.includes(input.publicResult)
    : null;
  const terminalStdoutExcerpt = publicResultMatched === false && processExit !== null && typeof terminalResult?.output === 'string'
    ? { kind: 'terminal-stdout-mismatch', ...scrubExcerpt(terminalResult.output, input.redactions ?? []) }
    : null;
  const decisiveEnd = processExit !== null
    ? 'process-exit'
    : observations.pendingInnerAtEnd === true ? 'cell-pending' : input.workerStillAliveAfterObservation === true ? 'yield-expiry' : 'unknown';
  // The tool-reported wall time is the authoritative decisive measurement; the
  // harness override applies only when the host did not report one.
  const decisiveWallMs = terminal?.wallTimeMs
    ?? observations.decisiveWallMs;
  const workerDurationMs = typeof input.workerDurationMs === 'number' && Number.isSafeInteger(input.workerDurationMs) ? input.workerDurationMs : null;
  const remainingLifetimeMs = decisiveWallMs !== null && workerDurationMs !== null && workerDurationMs >= decisiveWallMs
    ? workerDurationMs - decisiveWallMs
    : null;
  observations.decisiveWallMs = decisiveWallMs;
  observations.remainingLifetimeMs = remainingLifetimeMs;
  const violations = [];
  if (linkage.exact !== true) violations.push('child linkage is not exact');
  if (companion.launchCount !== 1) violations.push(`the exact launcher command was observed ${companion.launchCount === null ? 'in no identified child rollout' : `${String(companion.launchCount)} times`}`);
  if (!companion.sendCountKnown) violations.push('the fake peer session/send record was unavailable, so the single-send requirement could not be established');
  else if (companion.sendCount !== 1) violations.push(`the fake peer observed ${String(companion.sendCount)} session sends instead of exactly one`);
  if (handle.originalHandleChecked === false) violations.push('the original-handle observation discipline did not hold');
  if (sequence !== null) {
    for (const violation of sequence.outerLinkageViolations) violations.push(violation);
    for (const violation of sequence.disciplineViolations) violations.push(violation);
    if (sequence.unresolvedContinuation) violations.push('an accepted outer continuation response was missing or unparseable, so its evidence can never be attributed to the original handle');
    if (sequence.contradictedContinuation) violations.push(`an accepted outer continuation returned a pending response naming a different cell (${sequence.contradictedContinuation.returned} while ${sequence.contradictedContinuation.outstanding} was outstanding); its contradictory evidence blocks qualification`);
    if (sequence.observationsAfterTerminal) violations.push('observations of the original handle continue after the terminal record, so not every original-handle observation is settled');
    if (sequence.pendingInnerAtEnd) violations.push('an unresolved or pending inner observation remains at the end of the rollout');
  }
  if (processExit === null) violations.push('no terminal exit code was observed on the original handle');
  if (publicResultMatched !== true) violations.push('the terminal public result was missing or did not match byte-for-byte');
  const qualified = violations.length === 0;
  return {
    qualified,
    reason: qualified ? null : `completion cannot be qualified: ${violations.join('; ')}.`,
    processExit,
    publicResultMatched,
    terminalStdoutExcerpt,
    decisiveEnd,
    decisiveWallMs,
    remainingLifetimeMs,
  };
}

/**
 * @typedef {{
 *   rollouts: unknown,
 *   zcodeCalls?: unknown,
 *   command: unknown,
 *   publicResult?: string | null,
 *   requestedPollMs?: number | null,
 *   observedWallMs?: number | null,
 *   workerDurationMs?: number | null,
 *   workerStillAliveAfterObservation?: boolean | null,
 *   redactions?: string[],
 * }} ShellWaitEvidenceInput
 */
