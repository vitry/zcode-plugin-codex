// @ts-check
/**
 * Bounded fail-closed evidence observer for the native shell long-wait
 * qualification (research-only). It inspects only actually observed host call
 * shapes — direct function calls, bounded consecutive code-mode statements, and
 * the linked outer continuation that resolves a pending yielded cell — and
 * never infers an invocation from quoted message text.
 *
 * Missing or ambiguous records are reported as inconclusive, never as a zero
 * decision count. An unknown or truncated script shape is flagged for manual
 * adjudication with one STRUCTURAL excerpt whose raw body is suppressed and
 * never numerically scanned or serialized when non-string (only fixed
 * allowlisted public tool names and directive key names, statement count, the
 * withheld body's byte length, and — for a non-string body — a fixed bodyType
 * classification with no size fact; yield/timeout facts live on SUPPORTED
 * paths, where arguments are validated);
 * parsed-call excerpts are projected onto the validated public
 * protocol fields with every nonempty/malformed chars value suppressed; and a
 * sentinel-mismatch excerpt withholds the terminal output body behind its
 * size, exit status and the sentinel outcome. The private frame itself —
 * preparation/task/capability content — never reaches an excerpt or a record.
 * It is inconclusive, not zero. A
 * returned-but-still-live cell, a yield expiry while the worker is
 * still running, or a cap return can never qualify completion. No general
 * rollout interpreter lives here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RESCUE_ENVELOPE_MAX_BYTES, validateRescuePreparation } from '../../scripts/lib/rescue-preparation.mjs';

// P2 round-29: module-INIT snapshot of THIS module's executing source — read
// synchronously at initialization (the closest instant to the bytes Node
// actually loaded) and threaded to the driver so the observer provenance
// digest always describes the code that actually adjudicates, independent of
// any awaited fixture build/install that follows.
export const EXECUTING_EVIDENCE_SOURCE = readFileSync(fileURLToPath(import.meta.url));

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
// R1 correction: the noise/repeat2 records (report §§7.4/8.2, field-presence
// inspection) show the installed host ALSO emits an OPTIONAL bounded
// `yield_time_ms` argument between the `+"\n"` segment and
// `max_output_tokens` (`…)+"\n",yield_time_ms:1000,max_output_tokens:…`).
// That argument is accepted here as a bounded numeric literal (1–9 digits),
// captured onto the reconstructed call value as a validated supported-path
// directive fact — still NO eval, NO general JS parser, still exactly one LF
// after the envelope, and the write keeps its one-shot preparation admission
// instead of degrading to an unsupported shape or an empty terminal poll.
const PREPARATION_PATTERN = /^text\(await tools\.write_stdin\(\{session_id:(\d{1,12}),chars:JSON\.stringify\((\{[\s\S]{1,4096}?\})\)\+"\\n"(?:,yield_time_ms:(\d{1,9}))?(?:,max_output_tokens:\d{1,9})?\}\)\);\n?$/u;
// The directive capture is LAZY so it stops at the directive line's own
// newline; a greedy capture would backtrack to the input's last newline and
// swallow the wrapper after it (surfaced by the Task 4 directive regression).
const DIRECTIVE_PATTERN = /^\/\/ @exec: ([\s\S]{1,512}?)\n/u;
const PENDING_CELL_PREFIX = 'Script running with cell ID ';
// Both pinned host header forms report the decisive observation's wall time.
// The DIRECT unified-exec form (67727e7c, codex-rs/core/src/tools/context.rs
// response_header + response_text) is the FIRST input_text item: an OPTIONAL
// `Chunk ID: …` line, the `Wall time: <seconds> seconds` line, OPTIONAL
// process/token lines (`Process exited with code …`, `Process running with
// session ID …`, `Original token count: …`), then the ALWAYS-present
// `Output:` delimiter — and response_text appends the companion stdout IN THE
// SAME ITEM after that delimiter. Timing is therefore extracted ONLY from the
// validated header PREFIX through `Output:`; stdout (whatever follows) is
// never scanned, and a standalone wall-time line without the `Output:`
// delimiter is not the real framing and yields null.
// The code-mode wrapper/cell header (codex-rs/core/src/tools/code_mode/
// output.rs): `{status}\nWall time {seconds:.1} seconds\nOutput:\n` (no colon)
// inside the FIRST input_text item, the Wall time line framed before the
// Output: marker. When experimental_show_cell_overhead is enabled, output.rs
// appends an OPTIONAL ` (code-mode N seconds; overhead N seconds)` suffix to
// that line — overhead may be zero or negative (output_tests.rs pins all
// three framings) — which is accepted here but never retained: only the TOTAL
// wall time is kept.
// Timing is extracted ONLY from those validated header positions — never by
// searching arbitrary stdout, result bodies, or later items; with no trusted
// header the wall time is null, never a number recovered from withheld text.
// The installed build's exact form is a separate Task 4 observation.
const DIRECT_WALL_TIME_HEADER_PATTERN = /^(?:Chunk ID: [^\n]*\n)?Wall time: (\d+(?:\.\d+)?) seconds(?:\n(?:Process exited with code [^\n]+|Process running with session ID [^\n]+|Original token count: [^\n]+))*\nOutput:(?:\n([\s\S]*))?$/u;
const CODE_MODE_WALL_TIME_HEADER_PATTERN = /^(?:[^\n]*\n)?Wall time (\d+(?:\.\d+)?) seconds(?: \(code-mode -?\d+(?:\.\d+)? seconds; overhead -?\d+(?:\.\d+)? seconds\))?\nOutput:\n?$/u;
// NATIVE PENDING code-mode string body (67727e7c, code_mode/mod.rs
// format_script_status + output.rs CodeModeToolOutput::new/
// set_handler_duration_ms): a poll that yields before printing has EMPTY
// content items, and the singleton header serializes as a PLAIN STRING —
// the pending-cell line, the wall-time line (whose optional overhead suffix
// may be zero or negative), then the Output: delimiter. Only the cell id is
// decoded (bounded like the array form); the pending wall-time line is never
// retained as a value.
const NATIVE_PENDING_STRING_PATTERN = /^Script running with cell ID ([^\n]{1,128})\n(?:Wall time \d+(?:\.\d+)? seconds(?: \(code-mode -?\d+(?:\.\d+)? seconds; overhead -?\d+(?:\.\d+)? seconds\))?\n)?Output:\n?$/u;

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

// (No numeric extraction pattern exists: see the note below the tool-name
// pattern — allowlisted field names inside private string content would leak
// their numbers, so unclassified bodies yield no numeric facts at all.)
// The nearest wrapped tool name in an unclassifiable script cell — a
// candidate extracted from raw content, then checked against the fixed
// public allowlist below before anything is retained.
const WRAPPED_TOOL_NAME_PATTERN = /\btools\.([A-Za-z_][A-Za-z0-9_]{0,63})/u;
// NO numeric extraction happens from unclassified bodies. An allowlisted
// field NAME does not establish that a matched value is a public protocol
// argument: the scan would read private task/chars string content too (a task
// text like "PIN max_output_tokens: 74923411" would retain the PIN). Proving
// a match sits outside every string literal AND outside a preparation frame
// would require JS-lexer-grade parsing of arbitrary model-written code, so
// the fail-closed choice is to retain no numbers at all; yield/timeout facts
// remain available on SUPPORTED paths, where arguments are validated — which
// is where the cap discriminator needs them.
// Fixed allowlists of the PUBLIC protocol identifiers this instrument may
// name in an excerpt or record: the observed observational/host tool family
// and the known directive key names. Identifier syntax alone does not
// establish that content is public — a private string can be shaped like a
// tool or key name — so any unknown name is withheld behind a null fact or a
// count instead of being retained verbatim.
const KNOWN_TOOL_NAMES = new Set(['exec_command', 'write_stdin', 'wait', 'spawn_agent', 'wait_agent']);
const KNOWN_DIRECTIVE_KEYS = new Set(['yield_time_ms', 'timeout_ms', 'max_output_tokens', 'window']);
// The validated public protocol fields per sanctioned observational shape,
// confirmed against the supported-path parsers, the qualified-record
// fixtures, and the PINNED native tool specs (67727e7c:
// codex-rs/core/src/tools/handlers/shell_spec.rs, handlers/unified_exec/
// exec_command.rs, tools/code_mode/wait_spec.rs): exec_command carries the
// authorized command, the native options tty/login (booleans), shell
// (a shell-binary path — string content suppressed to presence/length),
// environment_id (identifier — length only), the approval-request fields
// sandbox_permissions (pinned enum values only)/justification (suppressed to
// presence/length)/prefix_rule/additional_permissions (tolerated, never
// projected), and the wait bounds and token caps; write_stdin addresses the
// handle and carries only its chars and wait bounds; wait references the
// pending cell, addresses the handle, and carries the native wait options
// max_tokens (number) and terminate (boolean — TRUE stops the running exec
// cell, so its carried value is a retained structural fact), with the
// tolerated alias set never projected (canonical-match
// discipline lives in the sequence analysis). Excerpt projection applies THIS
// schema BEFORE copying any value: unknown tools project nothing, out-of-
// schema fields are dropped behind a count, and in-schema values keep their
// type validation. The table is
// prototype-isolated (null prototype) and every lookup is Object.hasOwn-guarded,
// so a hostile call NAMED like an inherited Object.prototype property
// resolves no schema and degrades to the structural unsupported-tool facts
// instead of crashing adjudication.
const SANCTIONED_CALL_FIELDS = /** @type {Record<string, readonly string[]>} */ (Object.assign(Object.create(null), {
  exec_command: [
    'cmd', 'workdir', 'tty', 'login', 'shell', 'environment_id',
    'yield_time_ms', 'max_output_tokens', 'timeout_ms',
    'sandbox_permissions', 'justification', 'prefix_rule', 'additional_permissions',
  ],
  write_stdin: ['session_id', 'chars', 'yield_time_ms', 'max_output_tokens'],
  wait: ['cell_id', 'cellId', 'call_id', 'id', 'session_id', 'yield_time_ms', 'max_tokens', 'terminate'],
  // Root-control interrupt surfaces (P2-5 review fix): the ONLY projected
  // argument is the target, under the id-shaped-or-suppressed rule.
  interrupt_agent: ['target'],
  send_input: ['target'],
}));

// The pinned sandbox_permissions enum (shell_spec.rs create_approval_parameters).
const SANDBOX_PERMISSION_VALUES = new Set(['use_default', 'with_additional_permissions', 'require_escalated']);

/**
 * Look up a tool's sanctioned field allowlist; only OWN entries resolve.
 * @param {string} kind
 * @returns {readonly string[] | undefined}
 */
function sanctionedCallFields(kind) {
  return Object.hasOwn(SANCTIONED_CALL_FIELDS, kind) ? SANCTIONED_CALL_FIELDS[kind] : undefined;
}

/**
 * Return the tool name only when it is on the fixed public allowlist; any
 * unknown name (including attacker-shaped `tools.<name>` fragments from raw
 * content) is withheld as `null`.
 * @param {unknown} name
 */
function classifyToolName(name) {
  return typeof name === 'string' && KNOWN_TOOL_NAMES.has(name) ? name : null;
}

/**
 * Build the STRUCTURAL excerpt for a call whose raw body cannot safely be
 * classified as a supported shape. Path-only scrubbing cannot certify that a
 * failed classification removed private preparation/task content, so the raw
 * body is NEVER retained here, and NO numeric scan runs over it either (an
 * allowlisted field name can occur inside private task/chars strings): for a
 * STRING body the excerpt keeps only shape facts — the allowlisted public
 * tool name (unknown names are withheld), statement-line count, directive
 * presence and only allowlisted public directive key names (anything else
 * degrades to a withheld count), and the suppressed body's byte length. A
 * NON-STRING body is never serialized at all (JSON.stringify can throw
 * RangeError on deeply nested objects, which would abort adjudication from
 * outside the extraction guard): it retains only a fixed `bodyType`
 * classification with `inputBytes: null`. The verdict stays inconclusive with
 * manual adjudication, but its reason never carries the private frame.
 * @param {unknown} rawInput the unclassifiable call body (only structural facts are derived from it)
 * @param {string} classification the observer's failure classification
 * @param {readonly string[]} redactions
 * @param {string | null} [knownTool] the payload-declared tool name when available
 */
function structuralExcerptForUnclassifiedInput(rawInput, classification, redactions, knownTool = null) {
  const isString = typeof rawInput === 'string';
  const raw = isString ? rawInput : '';
  const bodyType = isString ? 'string'
    : rawInput === null ? 'null'
      : Array.isArray(rawInput) ? 'array'
        : typeof rawInput;
  let tool = classifyToolName(knownTool);
  let directivePresent = false;
  let directiveKeys = null;
  let withheldDirectiveKeys = 0;
  let inputLines = null;
  try {
    if (isString) {
      const toolMatch = tool === null ? WRAPPED_TOOL_NAME_PATTERN.exec(raw) : null;
      if (toolMatch) tool = classifyToolName(toolMatch[1]);
      const directive = DIRECTIVE_PATTERN.exec(raw);
      if (directive) {
        directivePresent = true;
        try {
          const parsedDirective = JSON.parse(directive[1]);
          if (parsedDirective && typeof parsedDirective === 'object' && !Array.isArray(parsedDirective)) {
            const parsedKeys = Object.keys(parsedDirective);
            // Key names are attacker-controlled here: keep only the fixed
            // allowlisted public key names, and degrade the rest — however
            // identifier-shaped — to a withheld count.
            directiveKeys = parsedKeys.filter((key) => KNOWN_DIRECTIVE_KEYS.has(key)).slice(0, 16);
            withheldDirectiveKeys = parsedKeys.length - directiveKeys.length;
          }
        } catch { /* an unparsable directive keeps only its presence */ }
      }
      inputLines = raw.split('\n').length;
    }
  } catch { /* structural extraction must never throw into the caller */ }
  let excerptFactsJson;
  try {
    // The facts are instrument-constructed primitives, so this cannot throw
    // today; the guard keeps a future field from reintroducing an abort path.
    excerptFactsJson = JSON.stringify({
      suppressed: 'the call body could not be classified as a supported shape; its raw content is withheld',
      classification,
      tool,
      bodyType,
      inputLines,
      directivePresent,
      directiveKeys,
      withheldDirectiveKeys,
      inputBytes: isString ? Buffer.byteLength(raw, 'utf8') : null,
    });
  } catch {
    excerptFactsJson = '{"suppressed":"the call body could not be classified as a supported shape; its structural facts are withheld"}';
  }
  return scrubExcerpt(excerptFactsJson, redactions);
}

/**
 * Project one parsed call's arguments onto the validated PUBLIC protocol
 * fields. Parsing an object never certifies its contents safe: the authorized
 * launcher command is retained (it is the fixture-rendered public command),
 * every other command body is withheld behind its length, numeric
 * handle/wait facts survive with type validation, the workdir keeps only
 * path-scrubbed text, and EVERY nonempty or malformed `chars` value — string,
 * object, or array — is replaced by a fixed marker. Unknown fields are
 * dropped entirely behind a withheld count.
 * @param {unknown} value
 * @param {string} kind
 * @param {string} command the exact authorized launcher command
 * @param {readonly string[]} redactions
 */
function projectPublicCallArguments(value, kind, command, redactions) {
  /** @type {Record<string, unknown>} */
  const source = value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};
  /** @type {Record<string, unknown>} */
  const projected = {};
  const allowedFields = sanctionedCallFields(kind);
  // The per-tool schema gates projection BEFORE any value is copied: an
  // unknown tool projects NOTHING (structural counts only), and an
  // out-of-schema field on a known tool is dropped behind the count, never
  // retained — however protocol-shaped its name or numeric its value.
  let withheldArgumentFields = 0;
  if (allowedFields === undefined) {
    withheldArgumentFields = Object.keys(source).length;
    if (withheldArgumentFields > 0) projected.withheldArgumentFields = withheldArgumentFields;
    return projected;
  }
  for (const key of Object.keys(source)) {
    if (!allowedFields.includes(key)) {
      withheldArgumentFields += 1;
      continue;
    }
    switch (key) {
      case 'cmd': {
        const cmd = source.cmd;
        if (typeof cmd === 'string') {
          projected.cmd = cmd === command
            ? cmd
            : { suppressed: 'unclassified command content withheld', length: cmd.length };
        }
        break;
      }
      case 'workdir': {
        const workdir = source.workdir;
        if (typeof workdir === 'string' && workdir.length > 0) {
          // A workdir suffix is untrusted filesystem text: string type never
          // authorizes content. Retain only a validated fixture-location
          // marker, never the path or its tail.
          const insideFixtureRoot = redactions.some((root) => typeof root === 'string' && root.length > 0
            && (workdir === root || workdir.startsWith(`${root}/`)));
          projected.workdir = insideFixtureRoot ? '<fixture-root>' : '<unclassified-path>';
        }
        break;
      }
      case 'session_id': {
        const session = source.session_id;
        if (readHandleId(session) !== null) projected.session_id = session;
        break;
      }
      case 'yield_time_ms':
      case 'timeout_ms':
      case 'max_output_tokens': {
        const numeric = source[key];
        if (typeof numeric === 'number' && Number.isSafeInteger(numeric) && numeric >= 0) projected[key] = numeric;
        break;
      }
      case 'max_tokens': {
        const maxTokens = source.max_tokens;
        if (typeof maxTokens === 'number' && Number.isSafeInteger(maxTokens) && maxTokens > 0) projected.max_tokens = maxTokens;
        break;
      }
      case 'terminate': {
        const terminate = source.terminate;
        if (typeof terminate === 'boolean') {
          // The carried value is semantically distinct (true stops the running
          // exec cell), so the boolean itself is the retained structural fact.
          projected.terminate = terminate;
        }
        break;
      }
      case 'tty':
      case 'login': {
        const flag = source[key];
        if (typeof flag === 'boolean') {
          // The carried value is semantically distinct (true allocates a PTY /
          // enables login semantics), so the boolean itself is the retained
          // structural fact.
          projected[key] = flag;
        }
        break;
      }
      case 'shell':
      case 'justification': {
        const freeText = source[key];
        if (typeof freeText === 'string' && freeText.length > 0) {
          // Arbitrary model-authored string content (a shell path, an approval
          // question): string type never authorizes content — only the
          // presence and length are visible, like the withheld command body.
          projected[key] = { suppressed: 'unclassified string content withheld', length: freeText.length };
        }
        break;
      }
      case 'environment_id': {
        const environment = source.environment_id;
        if (typeof environment === 'string' && environment.length > 0) {
          // A host-generated identifier: length-only, like a cell reference.
          projected.environment_id = { length: environment.length };
        }
        break;
      }
      case 'sandbox_permissions': {
        const permission = source.sandbox_permissions;
        // Only the pinned public enum literals are retained; any other value
        // is dropped without being retained.
        if (typeof permission === 'string' && SANDBOX_PERMISSION_VALUES.has(permission)) projected.sandbox_permissions = permission;
        break;
      }
      case 'prefix_rule':
      case 'additional_permissions': {
        // Sanctioned approval-request structures: tolerated by the schema,
        // never projected (their content is not needed by the observer).
        break;
      }
      case 'cell_id': {
        const cellId = source.cell_id;
        if (typeof cellId === 'string' && cellId.length > 0) {
          // A cell reference is model-controlled text; its length is the only
          // safe excerpt fact (its match against the pending cell is decided
          // by the sequence analysis and recorded as a boolean, never as a
          // value).
          projected.cell_id = { length: cellId.length };
        }
        break;
      }
      case 'chars': {
        projected.chars = source.chars === '' ? '' : '<private-input>';
        break;
      }
      case 'target': {
        const target = source.target;
        // Root-control target (interrupt_agent/send_input): recorded only
        // when id-shaped or the known fixture task marker — the same public
        // rendered-surface rule as the interrupt extractor. Any other value
        // is suppressed to its structural length, never retained.
        if (typeof target === 'string' && target.length > 0) {
          if (INTERRUPT_TARGET_ID_PATTERN.test(target) || target === INTERRUPT_FIXTURE_TASK_NAME) projected.target = target;
          else projected.target = { suppressed: 'unclassified target withheld', chars: target.length };
        }
        break;
      }
      default: {
        // Tolerated alias fields (cellId/call_id/id): accepted by the
        // sequence analysis under its exact-match discipline, never projected.
        break;
      }
    }
  }
  if (withheldArgumentFields > 0) projected.withheldArgumentFields = withheldArgumentFields;
  return projected;
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
  // A blank line BETWEEN statements is separator formatting and carries no
  // statement content (P2-3 round-13 fix: the observed multi-statement cells
  // separate the sanctioned preparation write and the real empty-input poll
  // with an empty line). A blank line AFTER the last statement is emitted
  // cell content beyond the last parseable statement — like any unsupported
  // trailing line it fails the cell closed.
  let lastContentLine = -1;
  for (const [index, line] of lines.entries()) {
    if (line.trim().length > 0) lastContentLine = index;
  }
  if (lastContentLine === -1) return null;
  const calls = [];
  for (const [index, line] of lines.entries()) {
    // Preparation's existing parser accepts no directive; attach the parsed
    // directive separately after validating it through the wrapper parser.
    // Only discard padding at a statement line's boundary. Every CONTENT
    // line still reaches the strict parser, and any bad line rejects the
    // entire cell.
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      if (index > lastContentLine) return null;
      continue;
    }
    const call = parseCallEvent({ payload: { ...payload, input: trimmedLine } });
    if (!call) return null;
    if (prefix) {
      const framed = parseWrappedToolInput(`${prefix}text(await tools.wait({cell_id:"directive"}));`);
      if (!framed) return null;
      call.directive = framed.directive;
    }
    calls.push(call);
  }
  return calls.length > 0 ? calls : null;
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
  // sanctioned inside the identified child rollout. A NON-STRING arguments
  // value is rejected before any JSON.parse coercion (JSON.parse would
  // string-coerce arrays like ['{"…"}'] into a supported-looking call): it
  // fails closed here and the fail-closed scan routes it to structural
  // suppression with a bodyType classification.
  if (payload?.type === 'function_call' && typeof payload.name === 'string' && payload.name.length > 0) {
    if (typeof payload.arguments !== 'string') return null;
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
        // The optional observed yield argument is a regex-validated numeric
        // literal (1–9 digits), so carrying it as a number is safe: it is a
        // supported-path write_stdin field (yield/timeout facts live where
        // arguments are validated), never a caller-controllable flag.
        value: {
          session_id: Number(preparationMatch[1]),
          chars: `${JSON.stringify(envelope)}\n`,
          ...(preparationMatch[3] !== undefined ? { yield_time_ms: Number(preparationMatch[3]) } : {}),
        },
        directive: null,
        wrapped: true,
      };
    }
    // The narrow Root-control path (P2-5 review fix): an owning-session
    // interrupt delivery in the anchored awaited-call form is a RECOGNIZED
    // call shape, so the fail-closed scan cannot fail the whole case on it.
    // The recognized kinds are NOT part of the observational family: inside
    // the identified Child rollout the sequence discipline still counts them
    // as unsupported calls, and their excerpt projection is limited to the
    // sanitized target below.
    const rootControlMatch = ROOT_CONTROL_WRAPPER_PATTERN.exec(payload.input);
    if (rootControlMatch) {
      const value = parseWrapperArguments(rootControlMatch[2]);
      if (!value) return null;
      return { kind: rootControlMatch[1], value, directive: null, wrapped: true };
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
/**
 * Decode the native unified-exec direct response body (context.rs
 * to_response_item → function_tool_response → FunctionCallOutputBody::Text,
 * serialized by protocol/src/models.rs as a PLAIN STRING): the metadata is
 * decoded ONLY from the validated header prefix before the "Output:"
 * delimiter (exit code, session id), and the text after the delimiter becomes
 * the command output (the sentinel checks read it there). Stdout is never
 * scanned for timing or metadata. Returns null when the text is not the
 * pinned framing.
 * @param {string} text
 * @returns {Record<string, unknown> | null}
 */
function decodeDirectResponse(text) {
  const directMatch = DIRECT_WALL_TIME_HEADER_PATTERN.exec(text);
  if (!directMatch) return null;
  // Metadata is scanned ONLY in the header prefix before the "Output:"
  // delimiter — stdout could contain similarly shaped lines and is never
  // read for anything but the command-output field below.
  const headerPrefix = directMatch[0].slice(0, directMatch[0].indexOf('\nOutput:'));
  // CARDINALITY: the pinned response_header() emits each status line at most
  // once. A repeated exit-code, session-id, or token-count line means a
  // malformed or mixed response — fail closed (null), never decode a
  // first-match value into completion evidence. Lines are classified EXACTLY
  // (whole-line pinned shapes) within the prefix.
  const metadataCounts = { exited: 0, session: 0, tokens: 0 };
  /** @type {RegExpExecArray | null} */
  let exitCodeMatch = null;
  /** @type {RegExpExecArray | null} */
  let sessionMatch = null;
  for (const line of headerPrefix.split('\n')) {
    const exited = /^Process exited with code (-?\d+)$/u.exec(line);
    if (exited) {
      metadataCounts.exited += 1;
      if (metadataCounts.exited === 1) exitCodeMatch = exited;
      continue;
    }
    const running = /^Process running with session ID (\d+)$/u.exec(line);
    if (running) {
      metadataCounts.session += 1;
      if (metadataCounts.session === 1) sessionMatch = running;
      continue;
    }
    if (/^Original token count: \d+$/u.test(line)) metadataCounts.tokens += 1;
  }
  if (metadataCounts.exited > 1 || metadataCounts.session > 1 || metadataCounts.tokens > 1) return null;
  // P2-2 round-26 fix: exited and running statuses are MUTUALLY EXCLUSIVE —
  // a header claiming both (neither repeats, so the cardinality guard alone
  // passes it) is a contradictory mixed response: fail the decode closed so
  // it can never supply terminal-completion evidence.
  if (metadataCounts.exited > 0 && metadataCounts.session > 0) return null;
  /** @type {Record<string, unknown>} */
  const result = { output: directMatch[2] ?? '' };
  if (exitCodeMatch) result.exit_code = Number(exitCodeMatch[1]);
  if (sessionMatch) result.session_id = Number(sessionMatch[1]);
  return result;
}

/**
 * Parse one host tool output. Completed outputs carry
 * `[{type:'input_text',text:'Script completed\n'},{type:'input_text',text:json}]`;
 * a pending yielded cell keeps the `Script running with cell ID <id>` shape.
 * Exported for the driver's background child-settlement watch, which must use
 * the SAME battle-tested output decoder as the observer (never a weaker
 * duplicate regex).
 * @param {unknown} output
 * @returns {{ state: 'pending', cellId: string, result?: undefined, wallTimeMs?: undefined }
 *   | { state: 'completed', result: Record<string, unknown>, wallTimeMs: number | null }
 *   | null}
 */
export function parseToolOutput(output) {
  // NATIVE persisted direct form: a PLAIN STRING output is the
  // FunctionCallOutputBody::Text body (response_header() + "\n" + stdout).
  // A yielded code-mode poll serializes the same way with the PENDING
  // code-mode header, so decode that shape FIRST (cell id only, before any
  // direct-response decoding); every OTHER non-string shape (numbers,
  // objects, arrays of non-JSON) stays rejected/fail-closed as before — no
  // coercion.
  if (typeof output === 'string') {
    const pendingMatch = NATIVE_PENDING_STRING_PATTERN.exec(output);
    if (pendingMatch) return { state: 'pending', cellId: pendingMatch[1] };
    const decoded = decodeDirectResponse(output);
    if (!decoded) return null;
    return { state: 'completed', result: decoded, wallTimeMs: extractWallTimeMs(output) };
  }
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
  /** @type {Record<string, unknown> | undefined} */
  let result;
  for (const item of /** @type {any[]} */ (output)) {
    if (item?.type !== 'input_text' || typeof item.text !== 'string' || item.text.length > 65536) continue;
    try {
      const parsed = JSON.parse(item.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) result = parsed;
    } catch { /* header and progress text items are not JSON */ }
  }
  // NATIVE unified-exec direct form via the singleton-array representation:
  // a single InputText body of response_header() + "\n" + stdout — never a
  // JSON item. Same validated-prefix decoding as the string form above.
  if (!result && first?.type === 'input_text' && typeof first.text === 'string') {
    const decoded = decodeDirectResponse(first.text);
    if (decoded) result = decoded;
  }
  if (!result) return null;
  return { state: 'completed', result, wallTimeMs: extractWallTimeMs(output) };
}

/**
 * Extract the tool-reported wall time (milliseconds) from a completed host
 * output's VALIDATED header position: the ENTIRE first input_text item in the
 * direct unified-exec form (or the native PLAIN STRING body, which is that
 * same item's text), or the Wall time line framed before the Output:
 * marker inside the first item in the code-mode cell form. Result bodies,
 * companion stdout, and later items are never scanned — with no trusted
 * header the wall time is `null`, never a number recovered from withheld
 * private text.
 * @param {unknown} output a native string body or an input_text item array
 */
function extractWallTimeMs(output) {
  const first = typeof output === 'string'
    ? output
    : /** @type {any[]} */ (output)?.[0];
  const header = typeof first === 'string'
    ? first
    : first?.type === 'input_text' && typeof first.text === 'string' ? first.text : null;
  if (header === null) return null;
  const match = DIRECT_WALL_TIME_HEADER_PATTERN.exec(header) ?? CODE_MODE_WALL_TIME_HEADER_PATTERN.exec(header);
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

/** @param {unknown} value @returns {number | null} */
function readHandleId(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) > 0 ? /** @type {number} */ (value) : null;
}

/** @param {unknown} value @returns {string | null} */
function boundedText(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_COMMAND_BYTES ? value : null;
}

// --- R4 owning-session interrupt interaction extraction ---------------------
// The owning Root turn delivers a native exact-Child interrupt through the
// model-facing V2 `interrupt_agent` tool (or the legacy V1
// `send_input {interrupt:true}` flag). These helpers parse that interaction
// from the collected rollouts WITHOUT weakening any privacy rule: target
// values are recorded only when they are id-shaped or the known fixture task
// marker (everything else is suppressed to its structural length), rejection
// reasons are recorded as structural KINDS (never raw messages), and no call
// body or output text ever enters the extracted facts.

const INTERRUPT_TARGET_ID_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,64})$/iu;
const INTERRUPT_FIXTURE_TASK_NAME = 'shell-wait-probe-fixture-task';
const INTERRUPT_STATUS_PATTERN = /^[a-z_]{1,32}$/u;
// The Root-control interrupt surfaces are recognized ONLY in the anchored
// awaited-call statement form — the same wrapper grammar the observational
// family uses, anchored to the whole cell line. A substring search would
// fabricate an attempt out of any tool-looking text inside a string literal
// or comment (a cell that merely PRINTS
// `tools.interrupt_agent({"target":…})` is not a delivery).
const ROOT_CONTROL_WRAPPER_PATTERN = /^text\(await tools\.(interrupt_agent|send_input)\((\{[\s\S]{1,4096}?\})\)\);\n?$/u;
// The Root-side control calls the fail-closed scan tolerates OUTSIDE the
// Child's observational sequence (P2-5 review fix): they are recognized call
// shapes with validated arguments, so an owning-session interrupt delivery
// cannot fail the whole case before the Child evidence adjudicates. They are
// still UNSUPPORTED inside the identified Child rollout (the sequence
// discipline is unchanged there).
const ROOT_CONTROL_TOOLS = new Set(['interrupt_agent', 'send_input']);

/**
 * Parse one event's rollout timestamp into epoch milliseconds. Accepts the
 * real RolloutLine ISO shape or a finite positive numeric ms value; anything
 * else (including absent timestamps) is unmeasurable, never guessed.
 * @param {unknown} event
 * @returns {number | null}
 */
function interruptEventTimestampMs(event) {
  const raw = /** @type {any} */ (event)?.timestamp;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && raw.length > 0 && raw.length <= 40) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** @param {string} value @param {string[]} redactions @returns {string} */
function scrubInterruptText(value, redactions) {
  let text = value;
  for (const redaction of redactions) text = text.split(redaction).join('[redacted]');
  return text;
}

/**
 * Sanitize one interrupt target. Id-shaped values and the fixture task marker
 * are public rendered surfaces (like job IDs); every other value is withheld
 * to its structural length.
 * @param {unknown} rawTarget
 * @returns {{ kind: 'agent-id' | 'task-name' | null | 'unknown', value: string | null, suppressed: boolean, chars: number | null }}
 */
function sanitizeInterruptTarget(rawTarget) {
  if (typeof rawTarget !== 'string' || rawTarget.length === 0 || rawTarget.length > 256) {
    return { kind: typeof rawTarget === 'string' && rawTarget.length > 256 ? 'unknown' : null, value: null, suppressed: typeof rawTarget === 'string' && rawTarget.length > 256, chars: typeof rawTarget === 'string' && rawTarget.length > 0 ? rawTarget.length : null };
  }
  if (INTERRUPT_TARGET_ID_PATTERN.test(rawTarget)) return { kind: 'agent-id', value: rawTarget, suppressed: false, chars: rawTarget.length };
  if (rawTarget === INTERRUPT_FIXTURE_TASK_NAME) return { kind: 'task-name', value: rawTarget, suppressed: false, chars: rawTarget.length };
  return { kind: 'unknown', value: null, suppressed: true, chars: rawTarget.length };
}

/**
 * Classify one interrupt rejection structurally. The raw message never
 * leaves this function.
 * @param {unknown} message
 * @returns {'target-root' | 'target-self' | 'target-unknown' | 'unclassified'}
 */
function classifyInterruptRejection(message) {
  const text = typeof message === 'string' ? message : JSON.stringify(message ?? '');
  if (/root is not a spawned agent/iu.test(text)) return 'target-root';
  if (/cannot interrupt itself|interrupt itself/iu.test(text)) return 'target-self';
  if (/unknown|not[ -]?found|ThreadNotFound/iu.test(text)) return 'target-unknown';
  return 'unclassified';
}

/**
 * Parse an interrupt tool output body. Supports the plain-JSON
 * function_call_output string shape and the array-of-input_text shape.
 * @param {unknown} output
 * @returns {Record<string, unknown> | null}
 */
function parseInterruptOutputBody(output) {
  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? /** @type {Record<string, unknown>} */ (parsed) : null;
    } catch { return null; }
  }
  if (!Array.isArray(output)) return null;
  for (const item of /** @type {any[]} */ (output)) {
    if (item?.type !== 'input_text' || typeof item.text !== 'string' || item.text.length > 65536) continue;
    try {
      const parsed = JSON.parse(item.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return /** @type {Record<string, unknown>} */ (parsed);
    } catch { /* header and progress text items are not JSON */ }
  }
  return null;
}

// The pinned AgentStatus enum (67727e7c, protocol.rs, snake_case): unit
// variants serialize as plain strings; the payload variants `completed` and
// `errored` serialize as tagged single-key objects whose value is the final
// answer or error message. Only the LABEL is public surface — the embedded
// message is suppressed everywhere (R0 discipline).
const AGENT_STATUS_LABELS = new Set(['pending_init', 'running', 'interrupted', 'completed', 'errored', 'shutdown', 'not_found']);

/**
 * Decode an interrupt result's `previous_status` into its status label:
 * a plain string passes through (the caller applies the label pattern), and
 * a TAGGED single-key object whose key is a pinned AgentStatus variant
 * decodes to that label. Any other shape — including a tagged key outside
 * the pinned enum — returns null (fail closed), and embedded payload
 * content is never returned.
 * @param {unknown} value
 * @returns {string | null}
 */
function interruptStatusLabel(value) {
  // P2-4 round-7 fix: STRING statuses are validated against the pinned enum
  // too — an arbitrary string (a malformed or hostile response) never
  // decodes and is never retained verbatim; the caller keeps the response
  // output-unparseable. Tagged single-key objects decode to their pinned
  // label as before.
  if (typeof value === 'string') return AGENT_STATUS_LABELS.has(value) ? value : null;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && AGENT_STATUS_LABELS.has(keys[0])) return keys[0];
  }
  return null;
}

/**
 * Classify a NATIVE plain-text failure response (P2-2 round-6): the pinned
 * host's ToolRuntime::failure_response (67727e7c, tools/parallel.rs) emits a
 * tool rejection as FunctionCallOutputBody::Text — the bare message string
 * with success:false — never a JSON {error:...} object. Only the KNOWN
 * rejection kinds decode here (the pinned root/self messages and the
 * ThreadNotFound-shaped unknown); any other plain text returns null so the
 * caller keeps output-unparseable. The raw text never leaves this function.
 * @param {unknown} output
 * @returns {'target-root' | 'target-self' | 'target-unknown' | null}
 */
function classifyPlainInterruptRejection(output) {
  let text = null;
  if (typeof output === 'string') text = output;
  else if (Array.isArray(output)) {
    for (const item of /** @type {any[]} */ (output)) {
      if (item?.type === 'input_text' && typeof item.text === 'string' && item.text.length <= 4096) { text = item.text; break; }
    }
  }
  if (typeof text !== 'string' || text.length === 0 || text.length > 4096) return null;
  const kind = classifyInterruptRejection(text);
  return kind === 'unclassified' ? null : kind;
}

/**
 * A supported multi-statement cell prints one JSON result per completed
 * statement, in order. Return the INTERRUPT STATEMENT's own result object —
 * never the first statement's (P2-3 round-6) — or null when that statement's
 * result is absent (a yielded or unexecuted statement stays unresolved).
 * @param {unknown} output
 * @param {number} statementIndex
 * @param {number} statementCount
 * @returns {Record<string, unknown> | null}
 */
function ownStatementResult(output, statementIndex, statementCount) {
  if (!Number.isSafeInteger(statementIndex) || statementIndex < 0
    || !Number.isSafeInteger(statementCount) || statementCount < 1 || statementIndex >= statementCount) return null;
  const results = parseStatementOutputs(output, statementCount);
  const own = results[statementIndex];
  return own?.state === 'completed' ? /** @type {Record<string, unknown>} */ (own.result) : null;
}

/**
 * Derive the exact-Child observation binding used for interrupt ordering
 * (P2-3 review fix): the single rollout whose session metadata carries the
 * observed exact Child thread id, keyed to the ORIGINAL handle the sequence
 * machinery tracks for the exact launcher command. Only that handle's polls
 * and their linked accepted continuations are attributable Child events;
 * every other shell output (a Root-side cat, the launch handshake itself)
 * never supplies pending/terminal ordering or timing. Any unresolvable
 * binding fails closed to `null` — ordering facts then stay unknown instead
 * of being guessed from unbound events.
 * @param {unknown} rollouts
 * @param {{ childThreadId?: unknown, command?: unknown } | null} [options]
 * @returns {{ childRolloutIndex: number, originalHandleId: number, attributableCallIds: Set<string>, attributableStatements: Map<string, { statementIndex: number, statementCount: number }>, pollIntervals: { callId: string, callIndex: number, responseIndex: number | null, callAtMs: number | null, responseAtMs: number | null }[] } | null}
 */
function deriveChildObservationBinding(rollouts, options) {
  try {
    if (!options || typeof options !== 'object' || !Array.isArray(rollouts)) return null;
    const childThreadId = options.childThreadId;
    const command = boundedText(options.command);
    if (typeof childThreadId !== 'string' || childThreadId.length === 0 || childThreadId.length > 128 || command === null) return null;
    const childIndices = [];
    for (const [index, events] of rollouts.entries()) {
      if (!Array.isArray(events)) continue;
      if (events.some((event) => event?.type === 'session_meta' && event?.payload?.id === childThreadId)) childIndices.push(index);
    }
    if (childIndices.length !== 1) return null;
    const childEvents = /** @type {any[]} */ (rollouts[childIndices[0]]);
    if (inspectCallOwnership(childEvents) !== null) return null;
    const calls = collectCalls(childEvents);
    const sequence = analyzeCallSequence(calls, command, 'rescue');
    const originalHandleId = sequence.originalHandleId;
    if (originalHandleId === null) return null;
    const attributableCallIds = new Set();
    // P2 round-24 fix: each attributable call id carries the LINKED
    // statement's position within its cell — a supported cell's statements
    // share one call id, so the response decode must read the LINKED poll or
    // continuation's OWN result, never the whole-body last-JSON selection.
    /** @type {Map<string, { statementIndex: number, statementCount: number }>} */
    const attributableStatements = new Map();
    // P2-1 round-9 fix: a poll's CALL-TO-RESPONSE interval is pending-state
    // evidence too. When the candidate directive keeps a cell inside ONE long
    // observation, the poll's response (its yield output) has not arrived at
    // the interruption moment — a poll whose call is recorded and whose
    // response has not arrived is an OUTSTANDING observation, and an
    // interrupt landing inside that interval observes a pending window even
    // though no yielded-cell header existed yet.
    // P2-1 round-11 fix: the ONE-SHOT PREPARATION WRITE and its linked
    // continuations are NEVER attributable interruption evidence — the
    // preparation is not the observation the interrupt case measures, and a
    // valid preparation-only rollout (pollCount 0) must never claim an
    // interruption during a "pending observation". Preparation writes are
    // identified by their chars (parsePreparationFrame) and preparation
    // continuations by their accepted-wait linkage to a preparation-owned
    // pending cell.
    /** @type {{ callId: string, callIndex: number, responseIndex: number | null, callAtMs: number | null, responseAtMs: number | null }[]} */
    const pollIntervals = [];
    const responsesByCallId = new Map();
    for (const [eventIndex, event] of childEvents.entries()) {
      const payload = /** @type {any} */ (event)?.payload;
      if (payload?.type === 'function_call_output' || payload?.type === 'custom_tool_call_output') {
        responsesByCallId.set(payload.call_id, { eventIndex, atMs: interruptEventTimestampMs(event), output: payload.output });
      }
    }
    /** Preparation-owned write STATEMENTS (per-statement key) and the
     * pending cells the attributable polls opened. */
    // P2-3 round-13 fix: preparation ownership is tracked PER STATEMENT —
    // in a supported cell the validated preparation write and the real
    // empty-input poll share the event's call id, so a call-id-keyed mark
    // would discard the ACTUAL poll and mark its pending cell preparation-
    // owned. Statement position within the cell (the same granularity the
    // main observer uses) keys the ownership instead: only the preparation
    // statement is preparation-owned, the poll statement keeps its normal
    // poll semantics, and a continuation stays attributable exactly when it
    // continues a TERMINAL POLL cell (never a preparation-owned one).
    /** @type {Set<string>} */
    const preparationStatements = new Set();
    /** @type {Set<string>} */
    const pollCells = new Set();
    /** @type {Map<string, { callId: string, callIndex: number, responseIndex: number | null, callAtMs: number | null, responseAtMs: number | null }>} */
    const intervalByPendingCell = new Map();
    for (const entry of calls) {
      if (entry.call.kind !== 'write_stdin') continue;
      if (parsePreparationFrame(entry.call.value?.chars) !== null) preparationStatements.add(`${entry.callId}#${entry.statementIndex ?? 0}`);
    }
    for (const entry of calls) {
      const isPreparationWrite = preparationStatements.has(`${entry.callId}#${entry.statementIndex ?? 0}`);
      const isPoll = entry.call.kind === 'write_stdin'
        && readHandleId(entry.call.value?.session_id) === originalHandleId
        && !isPreparationWrite;
      if (!isPoll) continue;
      const callEventIndex = Math.floor(entry.callIndex);
      const response = responsesByCallId.get(entry.callId) ?? null;
      // P2-1 round-14 fix: a LATER statement of a shared cell starts only
      // when its preceding awaited statements have FINISHED — the cell
      // submission's timestamp dates the whole cell, never this statement
      // (an interrupt can arrive while a preceding preparation is still
      // pending). Anchor the interval start at the cell's own response event,
      // and ONLY when that response evidences the preceding statements'
      // completed results; without that evidence the later statement's start
      // (and any pending window built on it) stays UNKNOWN.
      // P2-3 round-19 fix: the shared call ID is admitted into the
      // attributable set ONLY AFTER the poll's execution is established —
      // for a later statement that means the cell response evidences the
      // preceding awaited statements' completed results. A cell still
      // yielding its PREPARATION has not reached the poll; admitting the call
      // ID early attributed the cell's pending header to an UNEXECUTED poll
      // and fabricated a pending window from it.
      let startIndex = callEventIndex;
      let startAtMs = interruptEventTimestampMs(childEvents[callEventIndex]);
      if ((entry.statementIndex ?? 0) > 0) {
        const statementCount = entry.statementCount ?? 0;
        // P2-3 round-19 fix: with the cell's response OBSERVED, the poll is
        // attributable only when the preceding awaited statements' completed
        // results are present — a cell still yielding its PREPARATION has not
        // reached the poll, and its pending header is never interruption
        // evidence. With the response genuinely ABSENT the poll stays
        // attributable (round-14) but its start stays unanchored: no interval
        // is pushed for it, so the submission timestamp never dates it.
        if (response !== null) {
          const executionEvidenced = Number.isSafeInteger(statementCount) && statementCount > 1
            && precedingStatementsCompleted(response.output, /** @type {number} */ (entry.statementIndex), statementCount);
          if (!executionEvidenced) continue;
          startIndex = /** @type {{ eventIndex: number }} */ (response).eventIndex;
          startAtMs = /** @type {{ atMs: number | null }} */ (response).atMs;
        } else {
          attributableCallIds.add(entry.callId);
          attributableStatements.set(entry.callId, {
            statementIndex: /** @type {number} */ (entry.statementIndex ?? 0),
            statementCount: /** @type {number} */ (entry.statementCount ?? 1),
          });
          continue;
        }
      }
      attributableCallIds.add(entry.callId);
      attributableStatements.set(entry.callId, {
        statementIndex: /** @type {number} */ (entry.statementIndex ?? 0),
        statementCount: /** @type {number} */ (entry.statementCount ?? 1),
      });
      // P2-1 round-13 fix: the interval's RESPONSE boundary is the moment the
      // poll's pending window ENDS — a completed exit-code or still-running
      // response that settles/advances the poll. The poll's own YIELD header
      // (pending output) does NOT end the window: it OPENS it (that yield is
      // exactly the pending observation the interrupt case measures). A
      // yielded poll therefore keeps responseIndex/responseAtMs null here and
      // the window is closed only by its accepted continuation's completion
      // (tracked below) or a non-yield response.
      // P2-2 round-16 fix: a poll whose response was OBSERVED but is
      // UNPARSEABLE (malformed body, missing per-statement result, ambiguous
      // result list) has NO established response boundary — it is never
      // treated as "absent": the interval stays unestablished (this poll
      // yields no pending-window claim). Only a genuinely absent response
      // remains an outstanding observation.
      if (response !== null && entry.output === null) continue;
      const responseIsSettling = response !== null && entry.output?.state === 'completed';
      const interval = {
        callId: entry.callId,
        callIndex: startIndex,
        responseIndex: responseIsSettling ? response?.eventIndex ?? null : null,
        callAtMs: startAtMs,
        responseAtMs: responseIsSettling ? response?.atMs ?? null : null,
      };
      pollIntervals.push(interval);
      // Track the pending cell this TERMINAL poll opened so its continuations
      // are attributed back to the observation, and so the window's CLOSING
      // response is known when a continuation completes it.
      const output = entry.output ?? null;
      if (output?.state === 'pending' && typeof output.cellId === 'string') {
        pollCells.add(output.cellId);
        intervalByPendingCell.set(output.cellId, interval);
      }
    }
    for (const entry of calls) {
      const isAcceptedContinuation = entry.call.kind === 'wait' && sequence.acceptedWaitCallIds.has(entry.callId);
      if (!isAcceptedContinuation) continue;
      // Preparation continuations (accepted waits resolving a preparation-
      // owned pending cell) never become attributable interruption evidence;
      // a continuation continuing a TERMINAL POLL cell does.
      const continuesPollCell = typeof entry.call.value?.cell_id === 'string' && pollCells.has(entry.call.value.cell_id);
      if (continuesPollCell) {
        attributableCallIds.add(entry.callId);
        attributableStatements.set(entry.callId, {
          statementIndex: /** @type {number} */ (entry.statementIndex ?? 0),
          statementCount: /** @type {number} */ (entry.statementCount ?? 1),
        });
      }
      // P2-2 round-13 fix: record the yielded window's CLOSING response — the
      // FIRST accepted continuation completion that resolves the poll's cell
      // (calls arrive in event order, so the first completion is the earliest
      // resolution). Without this, an untimed cross-rollout completion would
      // leave the interval looking "response absent" (still outstanding) even
      // though the window it measures demonstrably closed — just at an
      // unprovable moment relative to the interrupt.
      if (!continuesPollCell) continue;
      const interval = typeof entry.call.value?.cell_id === 'string'
        ? intervalByPendingCell.get(entry.call.value.cell_id) ?? null
        : null;
      if (!interval || interval.responseIndex !== null) continue;
      const closing = responsesByCallId.get(entry.callId) ?? null;
      // P2-1 round-26 fix: an OBSERVED but UNPARSEABLE continuation response
      // is UNKNOWN evidence that BLOCKS pending-window qualification — the
      // wait demonstrably received a response (it could already have
      // completed or terminated the cell), so the interval is never treated
      // as "absent-response outstanding": the closing boundary is recorded
      // and the round-12/13 guards keep the window unestablished unless that
      // arrival is provable. A parsed PENDING continuation response keeps the
      // window open — nothing to record.
      const observedResponse = responsesByCallId.has(entry.callId);
      if (entry.output?.state === 'completed' || (observedResponse && entry.output === null)) {
        interval.responseIndex = closing?.eventIndex ?? null;
        interval.responseAtMs = closing?.atMs ?? null;
      }
    }
    if (attributableCallIds.size === 0) return null;
    return { childRolloutIndex: childIndices[0], originalHandleId, attributableCallIds, attributableStatements, pollIntervals };
  } catch { return null; }
}

/**
 * Extract the owning session's native interrupt interaction facts from the
 * collected rollouts. The returned facts are LOW-LEVEL observations only:
 * whether an interrupt-shaped model tool call exists (V2 `interrupt_agent` or
 * V1 `send_input {interrupt:true}`), its sanitized target, its delivery
 * outcome (success output, structural rejection kind, or unknown), and the
 * pending/terminal ordering facts with rollout-event timestamps when present.
 * Ordering/timing events are bound to the EXACT Child's original handle and
 * its linked continuations when `options` carries the observed child thread
 * id and the exact launcher command; with no resolvable binding the ordering
 * facts fail closed (`orderingBound: false`, unknown booleans, null timing).
 * Settlement attribution (exact target binding, post-completion classification,
 * latencies) belongs to the driver mapping, which binds these facts to the
 * case's evidence. Success decoding is FAMILY-SPECIFIC: V2 delivers through
 * `previous_status`, V1 through `submission_id` presence (the pinned V1
 * handler never returns `previous_status`).
 * @param {unknown} rollouts
 * @param {string[]} [redactions]
 * @param {{ childThreadId?: unknown, command?: unknown } | null} [bindingOptions]
 * @returns {{
 *   attempted: boolean, family: 'v2' | 'v1' | null, callCount: number,
 *   delivered: boolean | null, rejection: string | null, previousStatus: string | null,
 *   orderingBound: boolean,
 *   target: { kind: 'agent-id' | 'task-name' | 'unknown' | null, value: string | null, suppressed: boolean, chars: number | null },
 *   pendingBeforeCall: { observed: boolean, at: string | null, atMs: number | null },
 *   callAt: string | null, callAtMs: number | null,
 *   callNotBeforeMs: number | null, callNotAfterMs: number | null,
 *   unparseableBoundResponses: number,
 *   completedBeforeCall: { at: string | null, atMs: number | null },
 *   completedAfterCall: { at: string | null, atMs: number | null },
 *   sameRolloutCompletedBeforeCall: boolean | null,
 * }}
 */
export function extractInterruptInteraction(rollouts, redactions = [], bindingOptions = null) {
  const safeRedactions = Array.isArray(redactions)
    ? redactions.filter((value) => typeof value === 'string' && value.length > 0).slice(0, 64)
    : [];
  const binding = deriveChildObservationBinding(rollouts, bindingOptions);
  const orderingBound = binding !== null;
  /** @type {{ rolloutIndex: number, index: number, atMs: number | null, notBeforeMs: number | null, notAfterMs: number | null, family: 'v2' | 'v1', callId: string | null, target: unknown, statementIndex: number | null, statementCount: number | null } | null} */
  let lastCall = null;
  let callCount = 0;
  // Bound Child observation events with their resolution kind (P2-2 round-3
  // fix): a poll's pending output is pending-state evidence only while it is
  // OUTSTANDING — a later bound completed response, INCLUDING a still-running
  // nonterminal completion, resolves it (the model received a definitive
  // response), so a historical pending header can never stand in for a
  // pending observation at the interrupt call. Only exit-code completions
  // remain settlement evidence.
  /** @type {{ kind: 'pending' | 'completed-exit' | 'completed-running' | 'unparseable', rolloutIndex: number, index: number, atMs: number | null }[]} */
  const boundObservations = [];
  /** @type {{ rolloutIndex: number, index: number, atMs: number | null }[]} */
  const completedOutputs = [];
  /** @type {number | null} */
  let lastCallDelivered = null;
  /** @type {string | null} */
  let lastCallRejection = null;
  /** @type {string | null} */
  let lastCallPreviousStatus = null;
  /** @type {ReturnType<typeof sanitizeInterruptTarget>} */
  let lastCallTarget = { kind: null, value: null, suppressed: false, chars: null };
  const rolloutList = Array.isArray(rollouts) ? rollouts : [];
  for (let rolloutIndex = 0; rolloutIndex < rolloutList.length && rolloutIndex < 512; rolloutIndex += 1) {
    const events = rolloutList[rolloutIndex];
    if (!Array.isArray(events)) continue;
    for (let index = 0; index < events.length && index < 20_000; index += 1) {
      const event = events[index];
      const payload = /** @type {any} */ (event)?.payload;
      if (!payload || typeof payload !== 'object') continue;
      const atMs = interruptEventTimestampMs(event);
      if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
        // Only the EXACT Child's own polls and their linked continuations are
        // pending/terminal ordering evidence (P2-3 review fix): a Root-side
        // command that merely finishes before the interrupt call is never a
        // Child completion, and unrelated outputs never supply settlement
        // latency. With no resolvable binding no event is collected.
        const isBoundChildEvent = orderingBound && binding?.childRolloutIndex === rolloutIndex
          && binding.attributableCallIds.has(payload.call_id);
        // P2 round-24 fix: a supported cell's statements SHARE one call id —
        // the whole-body decode would select an UNRELATED statement's result
        // (a still-running poll followed by exec_command('true') recorded
        // that command's exit as the Child's completion ordering). Decode the
        // LINKED statement's own result position instead (the round-19
        // statement-correlation machinery).
        const linkedStatement = isBoundChildEvent
          ? binding?.attributableStatements?.get(payload.call_id) ?? null
          : null;
        const parsed = linkedStatement !== null
          ? statementOutputAt(payload.output, linkedStatement.statementIndex, linkedStatement.statementCount)
          : parseToolOutput(payload.output);
        if (isBoundChildEvent) {
          if (parsed?.state === 'pending') boundObservations.push({ kind: 'pending', rolloutIndex, index, atMs });
          else if (parsed?.state === 'completed') {
            const kind = Number.isSafeInteger(parsed.result?.exit_code) ? 'completed-exit' : 'completed-running';
            boundObservations.push({ kind, rolloutIndex, index, atMs });
            if (kind === 'completed-exit') completedOutputs.push({ rolloutIndex, index, atMs });
          }
          // P2-1 round-26 fix: a linked response that was OBSERVED but fails
          // its own statement decode is UNKNOWN evidence — recorded so the
          // pending-window checks treat the window as blocked (the
          // continuation could already have completed or terminated the
          // cell), never as an absent response.
          else if (parsed === null && linkedStatement !== null) {
            boundObservations.push({ kind: 'unparseable', rolloutIndex, index, atMs });
          }
        }
        // Resolve the LAST interrupt call's own output by call id. A wrapped
        // multi-statement cell resolves from the INTERRUPT STATEMENT's own
        // result position (P2-3 round-6 fix) — the first JSON object in the
        // cell body belongs to the first statement, never to the interrupt.
        if (lastCall !== null && lastCall.rolloutIndex === rolloutIndex && lastCall.callId !== null
          && payload.call_id === lastCall.callId && lastCallDelivered === null && index > lastCall.index) {
          // P2-1 round-15 fix: a later statement of a shared cell has NO
          // proven execution time at the cell submission — anchor the
          // interrupt's OWN execution boundary at this response event ONLY
          // when it evidences the preceding awaited statements' completed
          // results AND carries a timestamp (the interrupt demonstrably ran
          // before the cell completed); otherwise the ordering stays UNPROVEN
          // (atMs null), never the submission timestamp.
          // P2-1 round-16 fix: that response timestamp is only an UPPER BOUND
          // (it also covers any statements AFTER the interrupt), so it fills
          // `notAfterMs` — the exact `atMs` stays UNKNOWN.
          if ((lastCall.statementIndex ?? 0) > 0 && lastCall.atMs === null) {
            const statementCount = lastCall.statementCount ?? 0;
            const completionEvidenced = Number.isSafeInteger(statementCount) && statementCount > 1
              && precedingStatementsCompleted(payload.output, /** @type {number} */ (/** @type {any} */ (lastCall).statementIndex), statementCount);
            if (completionEvidenced && atMs !== null) lastCall.notAfterMs = atMs;
          }
          const body = lastCall.statementCount !== null && lastCall.statementCount > 1
            ? ownStatementResult(payload.output, /** @type {{ statementIndex: number }} */ (lastCall).statementIndex, lastCall.statementCount)
            : parseInterruptOutputBody(payload.output);
          /** @type {{ delivered: 0 | 1 | null, rejection: string | null, previousStatus?: string | null }} */
          let resolution = { delivered: null, rejection: null };
          if (body !== null && lastCall.family === 'v2') {
            // P2-4 round-6 fix: the pinned AgentStatus enum (67727e7c,
            // protocol.rs, snake_case) serializes unit variants as strings
            // and the payload variants as tagged single-key objects —
            // `{completed: <final answer>}` / `{errored: <message>}`. Decode
            // the supported variants and retain ONLY the status label; the
            // embedded message is suppressed (R0 discipline).
            const statusLabel = interruptStatusLabel(body.previous_status);
            if (statusLabel !== null) {
              resolution = { delivered: 1, rejection: null, previousStatus: INTERRUPT_STATUS_PATTERN.test(statusLabel) ? statusLabel : null };
            } else if (body.error !== undefined) {
              resolution = { delivered: 0, rejection: classifyInterruptRejection(scrubInterruptText(
                typeof body.error === 'string' ? body.error : JSON.stringify(body.error), safeRedactions,
              )) };
            }
          } else if (body !== null && lastCall.family === 'v1') {
            // The pinned V1 handler returns `{ submission_id: ... }` on
            // successful delivery; it has no previous_status.
            if (typeof body.submission_id === 'string' && body.submission_id.length > 0) {
              resolution = { delivered: 1, rejection: null };
            } else if (body.error !== undefined) {
              resolution = { delivered: 0, rejection: classifyInterruptRejection(scrubInterruptText(
                typeof body.error === 'string' ? body.error : JSON.stringify(body.error), safeRedactions,
              )) };
            }
          }
          if (resolution.delivered === null && resolution.rejection === null) {
            // P2-2 round-6 fix: the pinned host's ToolRuntime::failure_response
            // (67727e7c, tools/parallel.rs) emits a tool rejection as a PLAIN
            // TEXT body (FunctionCallOutputBody::Text with success:false) —
            // never a JSON {error:...} object. Decode ONLY the known rejection
            // kinds from a plain-text body; the raw text never leaves the
            // classifier (R0 discipline), and any other plain text stays
            // output-unparseable (fail closed).
            const kind = classifyPlainInterruptRejection(payload.output);
            resolution = kind !== null
              ? { delivered: 0, rejection: kind }
              : { delivered: null, rejection: 'output-unparseable' };
          }
          lastCallDelivered = resolution.delivered;
          lastCallRejection = resolution.rejection;
          if (resolution.previousStatus !== undefined) lastCallPreviousStatus = resolution.previousStatus;
        }
        continue;
      }
      if (payload.type !== 'function_call' && payload.type !== 'custom_tool_call') continue;
      /** @type {'v2' | 'v1' | null} */
      let family = null;
      /** @type {unknown} */
      let target;
      /** @type {string | null} */
      let callId = null;
      if (payload.type === 'function_call') {
        const name = typeof payload.name === 'string' ? payload.name : '';
        if (/(?:^|\.)interrupt_agent$/u.test(name)) family = 'v2';
        else if (/(?:^|\.)send_input$/u.test(name)) family = 'v1';
        if (family !== null) {
          try {
            const args = typeof payload.arguments === 'string' && payload.arguments.length <= 4096
              ? JSON.parse(payload.arguments)
              : null;
            if (family === 'v1' && (args === null || typeof args !== 'object' || args.interrupt !== true)) family = null;
            else if (args && typeof args === 'object') target = args.target;
          } catch { family = null; }
        }
        callId = typeof payload.call_id === 'string' ? payload.call_id : null;
      } else {
        // The owning event's call id FIRST: every statement of the cell
        // shares it, and the per-statement registration below must carry it
        // so the cell's own output resolves the delivery.
        callId = typeof payload.call_id === 'string' ? payload.call_id : null;
        // P2-1 round-5 fix: extract and count interrupt statements with the
        // SAME bounded per-statement parser the supported-call path uses
        // (parseCallStatements) — statement-level, not a whole-cell regex,
        // so directive-prefixed, multi-statement, and single-statement cells
        // all contribute and a collateral interrupt inside a supported cell
        // can never be silently dropped from the exactly-one-delivery count
        // (the whole-cell regex ignored anything but a lone wrapper). Each
        // statement's decoded target still goes through the sanitizer (R0
        // rules); a cell that fails the bounded parser contributes nothing
        // here and fails the whole case closed in the main scan.
        const statements = parseCallStatements(event);
        if (statements) {
          for (const [statementIndex, statement] of statements.entries()) {
            if (!ROOT_CONTROL_TOOLS.has(statement.kind)) continue;
            /** @type {'v2' | 'v1' | null} */
            let statementFamily = null;
            let statementTarget;
            if (statement.kind === 'interrupt_agent') {
              statementFamily = 'v2';
              statementTarget = statement.value?.target;
            } else if (statement.value && typeof statement.value === 'object' && /** @type {any} */ (statement.value).interrupt === true) {
              statementFamily = 'v1';
              statementTarget = statement.value.target;
            }
            if (statementFamily === null) continue;
            callCount += 1;
            lastCall = {
              rolloutIndex, index,
              // P2-1 round-15 fix: a later statement of a shared cell has no
              // proven execution time at the cell SUBMISSION — the submission
              // timestamps the whole cell, never this statement (the cell may
              // await an earlier statement long past it). It starts UNPROVEN
              // (null) and is anchored only by its cell's response event when
              // that evidences the preceding completions (below).
              // P2-1 round-16 fix: the response timestamp is only an UPPER
              // BOUND on the statement's execution (the cell response also
              // covers any later statements), so a bounded statement records
              // EXECUTION-TIME BOUNDS {notBefore: submission, notAfter:
              // response} with the exact time UNKNOWN — ordering claims use
              // the bounds conservatively (overlap with pending = unproven,
              // never a claimed post-completion).
              atMs: statementIndex > 0 ? null : atMs,
              notBeforeMs: statementIndex > 0 ? atMs : null,
              notAfterMs: null,
              family: statementFamily, callId, target: statementTarget,
              statementIndex,
              statementCount: statements.length,
            };
            lastCallDelivered = null;
            lastCallRejection = null;
            lastCallPreviousStatus = null;
            lastCallTarget = sanitizeInterruptTarget(statementTarget);
          }
        }
      }
      if (family === null) continue;
      callCount += 1;
      lastCall = { rolloutIndex, index, atMs, notBeforeMs: null, notAfterMs: null, family, callId, target, statementIndex: null, statementCount: null };
      lastCallDelivered = null;
      lastCallRejection = null;
      lastCallPreviousStatus = null;
      lastCallTarget = sanitizeInterruptTarget(target);
    }
  }
  // Same-rollout post-completion ordering: a bound completed exit-code output
  // at a strictly earlier index of the call's own rollout is authoritative
  // even without timestamps (event order inside one rollout is monotonic).
  // Without a resolvable binding the ordering booleans stay unknown (null).
  const sameRolloutCompletedBeforeCall = lastCall !== null && orderingBound
    ? completedOutputs.some((completed) => completed.rolloutIndex === lastCall.rolloutIndex && completed.index < lastCall.index)
    : null;
  const attempted = lastCall !== null;
  /** @type {{ observed: boolean, at: string | null, atMs: number | null }} */
  const pendingBeforeCall = { observed: false, at: null, atMs: null };
  /** @type {{ at: string | null, atMs: number | null }} */
  const completedBeforeCall = { at: null, atMs: null };
  /** @type {number | null} */
  let completedAfterCallMs = null;
  let completedBeforeCallMs = null;
  if (attempted && lastCall !== null) {
    for (const pending of boundObservations) {
      if (pending.kind !== 'pending') continue;
      const sameRolloutBefore = pending.rolloutIndex === lastCall.rolloutIndex && pending.index < lastCall.index;
      const stampedBefore = pending.atMs !== null && lastCall.atMs !== null && pending.atMs <= lastCall.atMs;
      // P2-1 round-16 fix: for a BOUNDED shared-cell interrupt the exact-time
      // eligibility checks cannot run (atMs is unknown); the bounded branch
      // below applies its own bounds-based eligibility, so only the
      // exact-time guard is skipped here.
      if (!sameRolloutBefore && !stampedBefore
        && !(lastCall.atMs === null && (lastCall.notBeforeMs !== null || lastCall.notAfterMs !== null))) continue;
      // P2-1 round-26 fix: an OBSERVED but unparseable bound response after
      // the pending observation leaves the window's resolution state UNKNOWN
      // (the continuation could already have completed or terminated the
      // cell) — the window is unestablished: never observed, never resolved.
      const blockedByUnparseable = boundObservations.some((resolved) => resolved.kind === 'unparseable'
        && ((resolved.rolloutIndex === pending.rolloutIndex && resolved.index > pending.index)
          || (resolved.atMs !== null && pending.atMs !== null && resolved.atMs >= pending.atMs)));
      if (blockedByUnparseable) continue;
      // P2-1 round-16 fix: a BOUNDED shared-cell interrupt (no exact time —
      // only {notBefore: submission, notAfter: response}) claims a pending
      // window only when the window provably SPANS the whole bounds: the
      // pending observation before the earliest possible execution and every
      // resolution provably at/after the latest possible execution. Any
      // resolution INSIDE the bounds overlaps the interrupt's possible
      // execution window — the claim stays UNPROVEN (never observed, never
      // post-completion).
      if (lastCall.atMs === null && (lastCall.notBeforeMs !== null || lastCall.notAfterMs !== null)) {
        const boundsEligible = sameRolloutBefore
          || (pending.atMs !== null && lastCall.notBeforeMs !== null && pending.atMs <= lastCall.notBeforeMs);
        if (!boundsEligible) continue;
        let resolvedBeforeBounds = false;
        let resolvedThroughBounds = false;
        let resolutionOverlapsBounds = false;
        for (const resolved of boundObservations) {
          if (resolved.kind === 'pending') continue;
          const afterPending = (resolved.rolloutIndex === pending.rolloutIndex && resolved.index > pending.index)
            || (resolved.atMs !== null && pending.atMs !== null && resolved.atMs >= pending.atMs);
          if (!afterPending) continue;
          if (resolved.atMs !== null && lastCall.notBeforeMs !== null && resolved.atMs <= lastCall.notBeforeMs) resolvedBeforeBounds = true;
          else if (resolved.atMs !== null && lastCall.notAfterMs !== null && resolved.atMs >= lastCall.notAfterMs) resolvedThroughBounds = true;
          else resolutionOverlapsBounds = true;
        }
        if (resolvedBeforeBounds || resolutionOverlapsBounds) continue;
        if (!resolvedThroughBounds) continue;
        pendingBeforeCall.observed = true;
        if (pendingBeforeCall.atMs === null || (pending.atMs !== null && pending.atMs > pendingBeforeCall.atMs)) {
          pendingBeforeCall.atMs = pending.atMs;
          pendingBeforeCall.at = pending.atMs !== null ? new Date(pending.atMs).toISOString() : null;
        }
        continue;
      }
      // P2-2 round-3 fix: the pending observation counts at the call only
      // while it was OUTSTANDING — any bound completed response (exit-code OR
      // a still-running nonterminal completion) between the pending header
      // and the call resolves it. Each relation mirrors the existing
      // pairwise convention: same-rollout event order OR rollout timestamps.
      // P2-2 round-13 fix (final): a pending observation whose RESOLUTION is
      // known to have arrived BEFORE the interrupt never confirms the window.
      // A resolution whose arrival relative to the interrupt is genuinely
      // UNKNOWN (untimed completion in a different rollout — the round-10
      // rule keeps cross-rollout indices incomparable, so it may have landed
      // before the interruption) also leaves the window unestablished.
      // A resolution provably AFTER the interrupt is the opposite: it PROVES
      // the poll was still pending at the interruption moment.
      let resolvedAfterInterrupt = false;
      const resolvedBeforeCallKnown = boundObservations.some((resolved) => {
        if (resolved.kind === 'pending') return false;
        const afterPending = (resolved.rolloutIndex === pending.rolloutIndex && resolved.index > pending.index)
          || (resolved.atMs !== null && pending.atMs !== null && resolved.atMs >= pending.atMs);
        if (!afterPending) return false;
        const beforeCallSameRollout = resolved.rolloutIndex === lastCall.rolloutIndex && resolved.index < lastCall.index;
        const beforeCallStamped = resolved.atMs !== null && lastCall.atMs !== null && resolved.atMs <= lastCall.atMs;
        if (beforeCallSameRollout || beforeCallStamped) return true;
        // Known AFTER the interrupt: a stamped completion past the call, or a
        // same-rollout completion ordered after the call event.
        const afterCallSameRollout = resolved.rolloutIndex === lastCall.rolloutIndex && resolved.index > lastCall.index;
        const afterCallStamped = resolved.atMs !== null && lastCall.atMs !== null && resolved.atMs >= lastCall.atMs;
        if (afterCallSameRollout || afterCallStamped) resolvedAfterInterrupt = true;
        return false;
      });
      if (resolvedBeforeCallKnown) continue;
      if (resolvedAfterInterrupt) {
        pendingBeforeCall.observed = true;
        if (pendingBeforeCall.atMs === null || (pending.atMs !== null && pending.atMs > pendingBeforeCall.atMs)) {
          pendingBeforeCall.atMs = pending.atMs;
          pendingBeforeCall.at = pending.atMs !== null ? new Date(pending.atMs).toISOString() : null;
        }
        continue;
      }
      const resolutionUnestablished = boundObservations.some((resolved) => resolved.kind !== 'pending'
        && ((resolved.rolloutIndex === pending.rolloutIndex && resolved.index > pending.index)
          || (resolved.atMs !== null && pending.atMs !== null && resolved.atMs >= pending.atMs)));
      if (resolutionUnestablished) continue;
      pendingBeforeCall.observed = true;
      if (pendingBeforeCall.atMs === null || (pending.atMs !== null && pending.atMs > pendingBeforeCall.atMs)) {
        pendingBeforeCall.atMs = pending.atMs;
        pendingBeforeCall.at = pending.atMs !== null ? new Date(pending.atMs).toISOString() : null;
      }
    }
    // P2-1 round-9 fix: a bound poll whose CALL is recorded and whose
    // RESPONSE has not arrived at the interruption moment is an OUTSTANDING
    // observation — the candidate directive keeps a cell inside ONE long
    // observation, so the yielded-cell header may not exist yet. The
    // interrupt landing inside the call-to-response interval observes the
    // pending window; the interval anchor doubles as the pending interval's
    // start.
    // P2-1 round-10 fix: the interval indices belong to the CHILD rollout
    // while lastCall.index belongs to the interrupt's OWN rollout — they are
    // comparable ONLY when both events live in that same rollout. Cross-
    // rollout ordering is established by ROLLOUT TIMESTAMPS exclusively
    // (event indices from different arrays cannot order anything), so the
    // index branches are guarded with rollout identity on both sides.
    for (const interval of binding?.pollIntervals ?? []) {
      const lastCallInChildRollout = lastCall.rolloutIndex === binding?.childRolloutIndex;
      // P2-3 round-17 fix: a BOUNDED shared-cell interrupt (exact time
      // deliberately unknown, bounds only) orders OUTSTANDING poll intervals
      // against its EXECUTION BOUNDS: a poll issued at/before notBefore whose
      // interval provably spans the whole bounds (genuinely no closing
      // response yet, or a closing response at/after notAfter) observes the
      // pending window; a closing response INSIDE the bounds overlaps the
      // possible execution window — unproven; a closing response at/before
      // notBefore closed the window before the earliest possible execution.
      if (lastCall.atMs === null && (lastCall.notBeforeMs !== null || lastCall.notAfterMs !== null)) {
        if (interval.callAtMs === null || lastCall.notBeforeMs === null || interval.callAtMs > lastCall.notBeforeMs) continue;
        const supersededByLaterCallBounded = (binding?.pollIntervals ?? []).some((later) =>
          later.callId !== interval.callId
          && (later.callAtMs !== null && interval.callAtMs !== null && later.callAtMs > interval.callAtMs)
          && (later.callAtMs !== null && lastCall.notBeforeMs !== null && later.callAtMs <= lastCall.notBeforeMs));
        if (supersededByLaterCallBounded) continue;
        if (interval.responseIndex !== null) {
          // The window CLOSED; only a closing response at/after notAfter
          // proves it stood through the whole bounded execution window. An
          // untimed closing response or one inside the bounds stays unproven.
          if (interval.responseAtMs !== null && lastCall.notAfterMs !== null && interval.responseAtMs >= lastCall.notAfterMs) {
            pendingBeforeCall.observed = true;
            if (pendingBeforeCall.atMs === null || (interval.callAtMs !== null && interval.callAtMs > pendingBeforeCall.atMs)) {
              pendingBeforeCall.atMs = interval.callAtMs;
              pendingBeforeCall.at = interval.callAtMs !== null ? new Date(interval.callAtMs).toISOString() : null;
            }
          }
          continue;
        }
        // Genuinely outstanding: no closing response — the interval spans the bounds.
        pendingBeforeCall.observed = true;
        if (pendingBeforeCall.atMs === null || (interval.callAtMs !== null && interval.callAtMs > pendingBeforeCall.atMs)) {
          pendingBeforeCall.atMs = interval.callAtMs;
          pendingBeforeCall.at = interval.callAtMs !== null ? new Date(interval.callAtMs).toISOString() : null;
        }
        continue;
      }
      const callSameRolloutBefore = lastCallInChildRollout && interval.callIndex < lastCall.index;
      const callStampedBefore = interval.callAtMs !== null && lastCall.atMs !== null && interval.callAtMs <= lastCall.atMs;
      if (!callSameRolloutBefore && !callStampedBefore) continue;
      // P2-1 round-13 fix: a LATER poll call on the same handle supersedes
      // this interval — the model moved on to a new observation, so the old
      // window ended before the newer poll began (well before the interrupt).
      const supersededByLaterCall = (binding?.pollIntervals ?? []).some((later) =>
        later.callId !== interval.callId
        && ((lastCallInChildRollout && later.callIndex > interval.callIndex)
          || (later.callAtMs !== null && interval.callAtMs !== null && later.callAtMs > interval.callAtMs))
        && ((lastCallInChildRollout && later.callIndex < lastCall.index)
          || (later.callAtMs !== null && lastCall.atMs !== null && later.callAtMs <= lastCall.atMs)));
      if (supersededByLaterCall) continue;
      // P2-2 round-13 fix: a SETTLING response that is UNTIMED and lives in a
      // DIFFERENT rollout than the interrupt cannot prove the window stood at
      // the interruption moment — it may have arrived before it. Fail closed:
      // the window is unestablished unless the response's arrival is provably
      // after the interrupt.
      if (interval.responseIndex !== null
        && interval.responseAtMs === null
        && binding?.childRolloutIndex !== lastCall.rolloutIndex) continue;
      const responseArrivedBeforeCall = lastCallInChildRollout && interval.responseIndex !== null
        ? interval.responseIndex < lastCall.index
        : interval.responseAtMs !== null && lastCall.atMs !== null && interval.responseAtMs <= lastCall.atMs;
      const responseArrivedStampedBefore = interval.responseAtMs !== null && lastCall.atMs !== null && interval.responseAtMs <= lastCall.atMs;
      if (responseArrivedBeforeCall || responseArrivedStampedBefore) continue;
      pendingBeforeCall.observed = true;
      if (pendingBeforeCall.atMs === null || (interval.callAtMs !== null && interval.callAtMs > pendingBeforeCall.atMs)) {
        pendingBeforeCall.atMs = interval.callAtMs;
        pendingBeforeCall.at = interval.callAtMs !== null ? new Date(interval.callAtMs).toISOString() : null;
      }
    }
    for (const completed of completedOutputs) {
      // P2-1 round-16 fix: for a BOUNDED shared-cell interrupt a completion
      // inside the bounds overlaps the possible execution window — it can
      // never claim post-completion (before) nor a post-delivery latency
      // (after); only a completion provably OUTSIDE a bound is ordered.
      if (lastCall.atMs === null && (lastCall.notBeforeMs !== null || lastCall.notAfterMs !== null)) {
        if (completed.atMs !== null && lastCall.notBeforeMs !== null && completed.atMs <= lastCall.notBeforeMs) {
          if (completedBeforeCallMs === null || (completed.atMs !== null && completed.atMs > completedBeforeCallMs)) completedBeforeCallMs = completed.atMs;
        } else if (completed.atMs !== null && lastCall.notAfterMs !== null && completed.atMs >= lastCall.notAfterMs) {
          if (completedAfterCallMs === null || (completed.atMs !== null && completed.atMs < completedAfterCallMs)) completedAfterCallMs = completed.atMs;
        }
        continue;
      }
      const sameRolloutAfter = completed.rolloutIndex === lastCall.rolloutIndex && completed.index > lastCall.index;
      const stampedAfter = completed.atMs !== null && lastCall.atMs !== null && completed.atMs >= lastCall.atMs;
      if (sameRolloutAfter || stampedAfter) {
        if (completedAfterCallMs === null || (completed.atMs !== null && completed.atMs < completedAfterCallMs)) completedAfterCallMs = completed.atMs;
      }
      const sameRolloutBefore = completed.rolloutIndex === lastCall.rolloutIndex && completed.index < lastCall.index;
      const stampedBefore = completed.atMs !== null && lastCall.atMs !== null && completed.atMs <= lastCall.atMs;
      if (sameRolloutBefore || stampedBefore) {
        if (completedBeforeCallMs === null || (completed.atMs !== null && completed.atMs > completedBeforeCallMs)) completedBeforeCallMs = completed.atMs;
      }
    }
  }
  completedBeforeCall.atMs = completedBeforeCallMs;
  completedBeforeCall.at = completedBeforeCallMs !== null ? new Date(completedBeforeCallMs).toISOString() : null;
  return {
    attempted,
    family: lastCall?.family ?? null,
    callCount,
    delivered: attempted ? (lastCallDelivered === null ? null : lastCallDelivered === 1) : null,
    rejection: attempted ? lastCallRejection : null,
    previousStatus: attempted ? lastCallPreviousStatus : null,
    orderingBound,
    target: lastCallTarget,
    pendingBeforeCall,
    callAt: lastCall?.atMs !== null && lastCall?.atMs !== undefined ? new Date(lastCall.atMs).toISOString() : null,
    callAtMs: lastCall?.atMs ?? null,
    // P2-1 round-16 fix: a shared-cell interrupt's exact execution time is
    // UNKNOWN — the bounds that ARE established (notBefore: the cell
    // submission, notAfter: the completion-evidencing cell response) are
    // recorded so ordering claims can be made conservatively against them.
    callNotBeforeMs: lastCall?.notBeforeMs ?? null,
    callNotAfterMs: lastCall?.notAfterMs ?? null,
    unparseableBoundResponses: boundObservations.filter((resolved) => resolved.kind === 'unparseable').length,
    completedBeforeCall,
    completedAfterCall: { at: completedAfterCallMs !== null ? new Date(completedAfterCallMs).toISOString() : null, atMs: completedAfterCallMs },
    sameRolloutCompletedBeforeCall,
  };
}

/**
 * Inspect shell wait evidence and return supported facts or an explicit
 * inconclusive reason. See the module documentation for the supported shapes
 * and the fail-closed rules.
 *
 * The observer contract is SELECTED BY THE CASE FAMILY through `mode`:
 *  - `rescue` (default, the pre-R2 contract): exact native Child linkage, the
 *    Rescue launcher invocation, the original Child handle, the sanctioned
 *    one-shot v5 preparation, and the fake-peer single-send requirement.
 *  - `root`: the root-family command contract (review/adversarial-review/
 *    status `--wait`). The launched host turn IS the Root-side process; there
 *    is no Rescue Child and none is required. Qualification rests on the exact
 *    validated Companion invocation, the exact Root process handle (keyed to
 *    the launch's own unified-exec session id), the Root turn's own code-mode
 *    polls and settled outer-cell continuations (the same
 *    linkage/overlap/pending rules as Rescue, keyed to the Root handle), the
 *    terminal exit, and the COMMAND-SPECIFIC rendered result markers.
 *    Unavailable Root facts stay `null`; the Rescue Child-join metric
 *    (`rootJoins`) stays `null` here. An unknown mode fails closed.
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
  const mode = input.mode ?? 'rescue';
  if (mode !== 'rescue' && mode !== 'root') {
    throw invalidEvidenceInput('mode must be exactly "rescue" or "root".');
  }
  // The command-specific rendered-result markers (root mode): every marker
  // must be present in the linked terminal output. Each marker is a bounded
  // instrument-selected string (never caller/private content). Validated here
  // at the boundary; the completion check reads the validated field.
  if (input.publicResultMarkers !== undefined && input.publicResultMarkers !== null) {
    if (!Array.isArray(input.publicResultMarkers) || input.publicResultMarkers.length === 0 || input.publicResultMarkers.length > 16
      || !input.publicResultMarkers.every((marker) => typeof marker === 'string' && marker.length > 0 && Buffer.byteLength(marker, 'utf8') <= 512)) {
      throw invalidEvidenceInput('publicResultMarkers must be a bounded nonempty array of nonempty marker strings.');
    }
  }
  // The ALTERNATIVE result-marker set (P2-1 round-7 fix): for the Status
  // deadline-measurement trial the CONFIRMED production JOB_WAIT_TIMEOUT
  // framing is the command's real result, accepted beside the rendered
  // success markers. Validated identically; every marker must still be
  // present in the linked terminal output (fail closed otherwise). The
  // completion check reads the validated field from the input directly.
  if (input.publicResultAlternativeMarkers !== undefined && input.publicResultAlternativeMarkers !== null) {
    if (!Array.isArray(input.publicResultAlternativeMarkers) || input.publicResultAlternativeMarkers.length === 0 || input.publicResultAlternativeMarkers.length > 16
      || !input.publicResultAlternativeMarkers.every((marker) => typeof marker === 'string' && marker.length > 0 && Buffer.byteLength(marker, 'utf8') <= 512)) {
      throw invalidEvidenceInput('publicResultAlternativeMarkers must be a bounded nonempty array of nonempty marker strings.');
    }
  }
  // The Status query-turn boundary (P2-2 round-4 fix): the two-turn Status
  // flow resumes the SAME session, so the rollout retains the turn-1 setup
  // observations (the background launch's own handle poll). When the driver
  // can establish the boundary — the observed launch session id plus that
  // rollout's setup-turn event count — the root analysis scopes itself to the
  // MEASURED query turn; a missing or non-matching boundary fails closed
  // (the whole-rollout analysis runs, and the setup observations count).
  let rootQueryTurn = null;
  if (input.rootQueryTurn !== undefined && input.rootQueryTurn !== null) {
    const queryTurn = /** @type {any} */ (input.rootQueryTurn);
    if (!queryTurn || typeof queryTurn !== 'object' || Array.isArray(queryTurn)
      || typeof queryTurn.sessionId !== 'string' || queryTurn.sessionId.length === 0 || queryTurn.sessionId.length > 128
      || !Number.isSafeInteger(queryTurn.setupEventCount) || queryTurn.setupEventCount < 0) {
      throw invalidEvidenceInput('rootQueryTurn must be { sessionId: string, setupEventCount: nonnegative integer }.');
    }
    rootQueryTurn = /** @type {{ sessionId: string, setupEventCount: number }} */ (queryTurn);
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
        // Fail closed on CONTENT, not only on paths: an unclassifiable call
        // body can carry the private preparation/task frame, so only its
        // structural facts are retained — the raw body never reaches any
        // excerpt or record through path-only scrubbing.
        const excerpt = structuralExcerptForUnclassifiedInput(
          payload.input,
          'unclassified-script-cell',
          redactions,
        );
        return inconclusive('unsupported-call-shape',
          'A collected tool call does not match a supported shape (direct call, simple wrapper, or linked outer continuation); the case needs manual adjudication.',
          { manualAdjudicationRequired: true, excerpt });
      }
      // EVERY direct function_call is validated — including unsupported tool
      // names — so a truncated, non-object, or NON-STRING payload cannot
      // bypass the fail-closed scan just because its tool is not part of the
      // observational family. A non-string arguments value goes directly to
      // structural suppression BEFORE JSON.parse could string-coerce an array
      // like ['{"…"}'] into a supported-looking call.
      if (payload?.type === 'function_call' && typeof payload.name === 'string' && payload.name.length > 0) {
        if (typeof payload.arguments !== 'string') {
          const excerpt = structuralExcerptForUnclassifiedInput(
            payload.arguments,
            'non-string-direct-arguments',
            redactions,
            payload.name,
          );
          return inconclusive('unsupported-call-shape',
            'A collected direct tool call has non-string arguments; the body type is recorded and its content withheld.',
            { manualAdjudicationRequired: true, excerpt });
        }
        let value;
        try { value = JSON.parse(payload.arguments); } catch {
          const excerpt = structuralExcerptForUnclassifiedInput(
            payload.arguments,
            'unparsable-direct-arguments',
            redactions,
            payload.name,
          );
          return inconclusive('unsupported-call-shape',
            'A collected direct tool call has truncated or unparsable arguments; the case needs manual adjudication.',
            { manualAdjudicationRequired: true, excerpt });
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          const excerpt = structuralExcerptForUnclassifiedInput(
            payload.arguments,
            'unsupported-direct-argument-shape',
            redactions,
            payload.name,
          );
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
  // The observation contract is selected by the case family: Rescue mode
  // adjudicates the identified CHILD rollout; root mode adjudicates the
  // identified ROOT rollout (the single rollout exposing the exact companion
  // command). The Rescue linkage machinery itself stays UNCHANGED.
  // P2-2 round-4 fix: the two-turn Status flow resumes the SAME session, so
  // the identified Root rollout can retain the turn-1 SETUP observations.
  // When the driver-established boundary matches the identified Root session,
  // the analysis scopes itself to the MEASURED query turn: the setup turn's
  // launch, handle, and settled poll neither count as foreign-handle polling
  // nor as an overlap violation. Any other case — or a boundary that cannot
  // be established (missing, non-matching session, oversized count) — keeps
  // the whole-rollout fail-closed analysis.
  const rootIdentification = mode === 'root' ? identifyRootRollout(rollouts, command) : null;
  let rootQueryEvents = rootIdentification !== null ? rootIdentification.rootEvents : undefined;
  let queryTurnScoped = false;
  if (mode === 'root' && rootQueryTurn !== null && rootIdentification !== null
    && rootIdentification.exact === true && rootIdentification.rootThreadId === rootQueryTurn.sessionId
    && Array.isArray(rootIdentification.rootEvents)
    && rootIdentification.rootEvents.length >= rootQueryTurn.setupEventCount) {
    rootQueryEvents = rootIdentification.rootEvents.slice(rootQueryTurn.setupEventCount);
    queryTurnScoped = true;
  }
  if (rootIdentification !== null) {
    rootIdentification.facts.queryTurnScoped = queryTurnScoped;
    rootIdentification.facts.queryTurnSetupEventCount = queryTurnScoped ? rootQueryTurn?.setupEventCount ?? null : null;
  }
  const calls = mode === 'root' && rootIdentification !== null
    ? (rootQueryEvents ? collectCalls(rootQueryEvents) : null)
    : (linkage.childEvents ? collectCalls(linkage.childEvents) : null);
  const companion = inspectCompanion(calls, command, input.zcodeCalls, redactions);
  const sequence = calls === null ? null : analyzeCallSequence(calls, command, mode);
  const handle = {
    originalHandleId: sequence?.originalHandleId ?? null,
    pollCount: sequence?.pollCount ?? null,
    preparationFrameWrites: sequence?.preparationWrites ?? null,
    foreignHandlePolls: sequence?.foreignHandlePolls ?? null,
    overlappingInnerPolls: sequence?.overlappingInnerPolls ?? null,
    originalHandleChecked: sequence === null ? null : sequence.originalHandleChecked,
    // Per-poll wall times (P2-1 review fix): each completed original-handle
    // observation's OWN tool-reported wall time, in event order — the fact a
    // future M trial needs to measure the cap return directly (§12.8).
    pollWallTimesMs: sequence?.pollWallTimesMs ?? null,
  };
  const observations = inspectObservations(linkage, calls, input, sequence, mode, rootIdentification, rootQueryEvents);
  const completion = inspectCompletion(linkage, companion, handle, sequence, observations, input, mode, rootIdentification);

  return {
    status: 'supported',
    inconclusive: null,
    facts: {
      linkage: mode === 'root' && rootIdentification !== null ? rootIdentification.facts : linkage.facts, companion, handle, observations, completion,
      collection: {
        rolloutCount: rollouts.length,
        childToolCallCount: calls?.length ?? null,
        truncated: (calls?.length ?? 0) > MAX_DIAGNOSTIC_EXCERPTS,
        // Pre-launch diagnostics already have their own excerpt kind. Keep
        // successful launch/observation evidence too; count is not an excerpt
        // count. Never retain a private preparation prompt in call arguments:
        // excerpts are projected onto the validated public protocol fields,
        // never a raw argument spread.
        excerpts: (calls ?? []).slice(0, MAX_DIAGNOSTIC_EXCERPTS)
          .filter((entry) => !(entry.call.kind === 'exec_command' && entry.call.value.cmd !== command
            && entry.callIndex < (calls?.find((call) => call.call.kind === 'exec_command' && call.call.value.cmd === command)?.callIndex ?? -1)))
          .map(({ call }) => ({ kind: 'rollout-tool-call', ...scrubExcerpt(JSON.stringify({
            tool: classifyToolName(call.kind),
            arguments: projectPublicCallArguments(call.value, call.kind, command, redactions),
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
 * child id, parent id, and agent path. The parent's session metadata id must
 * be BOUND: an identified parent rollout that carries no session metadata
 * cannot ground the child's parent-thread binding, so the linkage stays
 * inexact and the id stays `null` (R2 tightening of the R1 parent
 * identification — unavailable facts are nulls, never guesses).
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
  else if (typeof parentThreadId !== 'string' || parentThreadId.length === 0) reason = 'the parent rollout does not expose session metadata to bind the child linkage';
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
 * Identify the ROOT rollout for a root-family case: the single rollout that
 * exposes the exact companion command as a supported observed call AND is the
 * LAUNCHED Root session — the exec session's own thread, carrying NO
 * parent_thread_id and NO subagent source metadata (P2-4 review fix). A
 * rollout carrying subagent markers is a spawned subagent, no matter which
 * command it exposes: a command moved into a subagent must never count as
 * Root-owned qualification, so such a candidate is rejected and the
 * identification stays inexact. When the metadata is unavailable the bound
 * thread id stays `null`, never a guess. Rollout-identification reasons carry
 * only counts and fixed classifications, never reference values.
 * @param {any[][]} rollouts
 * @param {string} command
 */
function identifyRootRollout(rollouts, command) {
  const candidates = rollouts.filter((events) => /** @type {any[]} */ (events).some((event) => {
    const statements = parseCallStatements(event);
    return statements?.some((call) => call.kind === 'exec_command' && call.value.cmd === command) ?? false;
  }));
  const meta = candidates.length === 1
    ? /** @type {any} */ (candidates[0].find((event) => event?.type === 'session_meta'))
    : null;
  const rootThreadId = typeof meta?.payload?.id === 'string' && meta.payload.id.length > 0 ? meta.payload.id : null;
  const subagentPayload = candidates.length === 1 ? /** @type {any} */ (meta)?.payload : undefined;
  const subagentRollout = subagentPayload !== undefined && subagentPayload !== null
    && ((subagentPayload.parent_thread_id !== undefined && subagentPayload.parent_thread_id !== null && subagentPayload.parent_thread_id !== '')
      || (subagentPayload.source?.subagent !== undefined && subagentPayload.source?.subagent !== null));
  /** @type {string | undefined} */
  let reason;
  if (candidates.length === 0) reason = 'no collected rollout exposes the exact companion command as a supported call';
  else if (candidates.length > 1) reason = `${String(candidates.length)} collected rollouts expose the exact companion command`;
  else if (subagentRollout) reason = 'the rollout exposing the exact companion command carries subagent metadata (a parent thread id or a subagent source), so it is a spawned subagent and not the launched Root session';
  else if (rootThreadId === null) reason = 'the rollout exposing the exact companion command does not expose session metadata to bind the Root observation';
  const exact = reason === undefined;
  return {
    exact,
    reason,
    rootThreadId,
    commandRolloutCount: candidates.length,
    rootEvents: candidates.length === 1 && !subagentRollout ? candidates[0] : undefined,
    facts: {
      checked: true,
      exact,
      mode: /** @type {const} */ ('root'),
      reason: exact ? null : `incomplete or wrong Root observation linkage: ${reason}.`,
      rootThreadId,
      commandRolloutCount: candidates.length,
      // The Status query-turn boundary (P2-2 round-4 fix): whether the
      // analysis was scoped to the measured query turn, and the setup prefix
      // length it sliced off (null when no boundary was established).
      queryTurnScoped: false,
      queryTurnSetupEventCount: /** @type {number | null} */ (null),
    },
  };
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
        kind: 'pre-launch-diagnostic', ...scrubExcerpt(JSON.stringify({
          tool: classifyToolName(call.kind),
          arguments: projectPublicCallArguments(call.value, call.kind, command, redactions),
        }), redactions),
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
  /** @type {{ callId: string, call: NonNullable<ReturnType<typeof parseCallEvent>>, output: ReturnType<typeof parseToolOutput>, callIndex: number, outputIndex: number | null, cellWallTimeMs: number | null, statementIndex: number, statementCount: number }[]} */
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
        cellWallTimeMs: statementIndex === parsed.length - 1 ? cellWallTimeMs : null,
        // P2-3 round-13: the STATEMENT position within its cell — the
        // preparation-ownership key shares the event's call id across
        // statements, so statement granularity is required to distinguish
        // the sanctioned preparation write from the real empty-input poll
        // sharing one supported cell.
        statementIndex,
        // P2-1 round-14: the cell's statement total — a later statement's
        // start anchor needs to know how many awaited statements precede it.
        statementCount: parsed.length,
      });
    }
  }
  return calls;
}

/**
 * The LINKED statement's OWN parsed output at its position within the cell
 * (the round-6 statement-correlation decoder, shared with the driver's
 * settlement watch). A multi-statement cell's whole-body decode would select
 * an UNRELATED statement's result; a missing, ambiguous, or contradictory
 * result list decodes to null — never to another statement's result.
 * @param {unknown} output
 * @param {number} statementIndex
 * @param {number} statementCount
 * @returns {ReturnType<typeof parseToolOutput> | null}
 */
export function statementOutputAt(output, statementIndex, statementCount) {
  if (!Number.isSafeInteger(statementIndex) || statementIndex < 0
    || !Number.isSafeInteger(statementCount) || statementCount < 1 || statementIndex >= statementCount) return null;
  return parseStatementOutputs(output, statementCount)[statementIndex] ?? null;
}

/**
 * Whether the awaited statements BEFORE `statementIndex` of one cell carry
 * COMPLETED results in the cell's own output — the only evidence that they
 * finished and a later statement of the same cell can have started (P2-1
 * round-14). The cell submission itself dates the whole cell, never a later
 * statement. A missing, ambiguous, or contradictory result list is never
 * evidence (fail closed).
 * @param {unknown} output
 * @param {number} statementIndex
 * @param {number} statementCount
 * @returns {boolean}
 */
export function precedingStatementsCompleted(output, statementIndex, statementCount) {
  if (!Number.isSafeInteger(statementIndex) || statementIndex < 1
    || !Number.isSafeInteger(statementCount) || statementIndex >= statementCount) return false;
  // P2-3 round-19 fix: EXECUTION evidence is positional — the completed JSON
  // objects correspond to the awaited statements in order, and a pending
  // header anywhere marks the still-running statement. The strict whole-list
  // decode (parseStatementOutputs) rejects a contradictory or incomplete list
  // wholesale, which is right for completion claims but would also reject
  // this EXECUTION evidence (an observed yielded cell whose earlier
  // statements each carry a completed result). Admission only asks whether
  // every preceding statement carries its completed result.
  if (!Array.isArray(output)) return false;
  let completedCount = 0;
  for (const item of output) {
    if (item?.type !== 'input_text' || typeof item.text !== 'string' || item.text.length > 65536) continue;
    if (item.text.startsWith(PENDING_CELL_PREFIX)) continue;
    try {
      const parsed = JSON.parse(item.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) completedCount += 1;
    } catch { /* header and progress text items are not JSON */ }
  }
  return completedCount >= statementIndex;
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
 * Walk the observed rollout's call sequence once and resolve every observation
 * invariant: one original handle, empty-input polls of only that handle, no
 * overlapping inner polls, and outer continuations that link back to the EXACT
 * pending cell they continue. A completed wait output is accepted as a result
 * on the original handle only when it resolves that handle's pending cell;
 * missing, foreign, or ambiguous linkage is rejected — pending state stays
 * pending, the output never qualifies completion, and a violation is recorded.
 * The same machinery serves both observer contracts, keyed to whichever
 * process handle the mode's launch produced: Rescue's original Child handle,
 * or the Root case's own Companion handle. The one-shot private v5 preparation
 * sanction exists ONLY in rescue mode; in root mode every nonempty write to
 * the handle is input injection (root commands carry no private preparation).
 * @param {ReturnType<typeof collectCalls>} calls
 * @param {string} command
 * @param {'rescue' | 'root'} [mode]
 */
function analyzeCallSequence(calls, command, mode = 'rescue') {
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
  /** @type {{ matches: false, outstandingChars: number, returnedChars: number } | null} */
  let contradictedContinuation = null;
  /** @type {'unresolved' | null} */
  let unresolvedContinuation = null;
  /** @type {{ outputIndex: number | null } | null} */
  let awaitingResolution = null;
  /** @type {{ result: Record<string, unknown>, wallTimeMs: number | null, index: number } | null} */
  let lastCompletedOnHandle = null;
  // Per-poll wall times (P2-1 review fix): EVERY completed original-handle
  // observation retains its OWN tool-reported wall-time header value, in
  // event order (null when that output carries no trusted header). Without
  // this, a cap-limited return's duration cannot be separated from the later
  // terminal observation's — exactly the conflation that left the R5 M
  // trial's decisive number unattributable (report §7.7/§12.8).
  /** @type {(number | null)[]} */
  const pollWallTimesMs = [];
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
  // tool call here — a forbidden sleep, list, or anything else — is recorded
  // by COUNT: tool names are model-controlled strings, so unknown names are
  // withheld, never quoted into the reason.
  const unsupportedToolCallCount = calls
    .filter(({ call }) => !['exec_command', 'write_stdin', 'wait'].includes(call.kind))
    .length;
  if (unsupportedToolCallCount > 0) {
    disciplineViolations.push(`${String(unsupportedToolCallCount)} unsupported tool call(s) in the ${mode === 'root' ? 'root' : 'child'} rollout with withheld unclassified tool name(s)`);
  }
  // Sanctioned observational shapes carry exactly the validated public
  // protocol fields: an unexpected extra argument on an exact launch, poll,
  // or continuation is a discipline violation (its content never reaches an
  // excerpt, and a launch/poll carrying it can never qualify completion).
  for (const { call } of calls) {
    const allowedFields = sanctionedCallFields(call.kind);
    if (!allowedFields) continue;
    const extraFieldCount = Object.keys(call.value ?? {}).filter((key) => !allowedFields.includes(key)).length;
    if (extraFieldCount > 0) {
      disciplineViolations.push(`${String(extraFieldCount)} unclassified argument field(s) outside the sanctioned ${call.kind} protocol shape (content withheld)`);
    }
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
      // analysis grants the exception, never an argument-level flag. The
      // sanction is Rescue-specific: root-family commands carry no private
      // preparation, so root mode never grants it.
      const preparationEnvelope = mode === 'rescue' ? parsePreparationFrame(call.value?.chars) : null;
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
        } else if (!sanctionedPreparation && typeof charsValue === 'string' && charsValue !== '') {
          // The injected content itself is never quoted: it may be the private
          // preparation/task frame, so the violation keeps only its length.
          disciplineViolations.push(`an original-handle observation sent nonempty input of ${String(charsValue.length)} character(s) instead of empty input (input injection into the observed companion process; the injected content is withheld)`);
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
          if (!sanctionedPreparation) pollWallTimesMs.push(output.wallTimeMs ?? null);
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
        outerLinkageViolations.push('the outer continuation does not reference the pending cell through its canonical cell_id (canonical cell_id missing; alias-only references are insufficient); its linkage is missing, foreign, or conflicting');
        continue;
      }
      if (canonical !== pendingCellId) {
        // Reference values are model-controlled strings; the violation keeps
        // only the length classification and the match outcome — never a
        // value, so this reason cannot bypass excerpt suppression.
        outerLinkageViolations.push(`the outer continuation does not reference the pending cell through its canonical cell_id (canonical cell_id withheld: ${String(canonical.length)} character(s) that do not match the pending cell); its linkage is missing, foreign, or conflicting`);
        continue;
      }
      if (malformedAliases.length > 0) {
        outerLinkageViolations.push(`the outer continuation's reference fields ${malformedAliases.map(({ field, value }) => `${field} of type ${typeof value}`).join(', ')} are not strings; its linkage is malformed`);
        continue;
      }
      if (conflictingAliases.length > 0) {
        outerLinkageViolations.push(`the outer continuation's reference fields conflict: the canonical cell_id matched the pending cell while ${conflictingAliases.map(({ field, value }) => `${field} withheld a non-matching value of ${String(/** @type {string} */ (value).length)} character(s)`).join(', ')}; its linkage is conflicting`);
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
      // (same family as the exact-cell linkage rules). Only lengths and the
      // mismatch boolean are recorded — never the reference values.
      if (output?.state === 'pending' && pendingCell !== null && output.cellId !== pendingCell.cellId) {
        contradictedContinuation = {
          matches: false,
          outstandingChars: pendingCell.cellId.length,
          returnedChars: output.cellId.length,
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
        const resolvesSanctionedPreparation = pendingCell !== null && pendingCell.sanctionedPreparation;
        if (pendingCell !== null && !pendingCell.sanctionedPreparation) {
          countCompletedPoll(pendingCell.ownerCallId);
        }
        pendingCell = null;
        lastCompletedOnHandle = { result: output.result, wallTimeMs: output.wallTimeMs, index };
        // P2-3 round-2 fix: the preparation exemption applies to the
        // per-poll timing array too — pollWallTimesMs must align 1:1 with
        // the actual polls (it exists to make the cap return separately
        // measurable), so a preparation write resolved through its own outer
        // continuation contributes NO duration.
        // P2-5 round-3 fix: the continuation's own header measures the WAIT
        // request, never the inner poll. The poll's own timing was not
        // established when it yielded (its pending header is never retained
        // as a value), so the poll's duration stays UNKNOWN (null) here —
        // only a poll whose OWN response completed contributes its reported
        // duration.
        if (!resolvesSanctionedPreparation) pollWallTimesMs.push(null);
        if (Number.isSafeInteger(output.result?.exit_code)) terminalIndex = index;
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
    pollWallTimesMs,
    observationsAfterTerminal,
  };
}

/**
 * Count model-visible decisions, outer continuations, and Root joins as three
 * separated observations, carrying the harness-reported decisive wall
 * time when the host tool actually reported one.
 * @param {ReturnType<typeof inspectLinkage>} linkage
 * @param {ReturnType<typeof collectCalls> | null} calls
 * @param {ShellWaitEvidenceInput} input
 * @param {'rescue' | 'root'} mode
 * @param {ReturnType<typeof identifyRootRollout> | null} rootIdentification
 * @param {any[] | undefined} rootQueryEvents
 */
function inspectObservations(linkage, calls, input, /** @type {any} */ sequence, mode, rootIdentification, /** @type {any[] | undefined} */ rootQueryEvents) {
  // Root joins are counted ONLY over an identified parent rollout (exactly one
  // rollout exposing spawn_agent). When the parent linkage is unavailable — no
  // parent rollout collected, or several ambiguous spawn rollouts — the count
  // is UNKNOWN (null), never a fabricated zero: zero requires the positively
  // identified parent rollout (R1 correction). A wait_agent observed inside
  // the child rollout is a child discipline violation, not a Root join.
  // rootJoins stays the RESCUE-mode metric: a root-family case has no Rescue
  // Child, so its join count is not defined and stays null — the Root case's
  // own outer-continuation cadence below is its observation accounting.
  const rootJoins = mode === 'root'
    ? null
    : linkage.parentEvents === undefined
      ? null
      : /** @type {any[]} */ (linkage.parentEvents).filter((event) => event?.payload?.type === 'function_call' && event.payload?.name === 'wait_agent').length;
  const outerReturns = calls === null ? null : calls.filter(({ call }) => call.kind === 'wait').length;
  // The model-call cadence counts the MEASURED turn: in root mode with an
  // applied query-turn boundary this is the query turn alone (P2-2 round-4).
  const modelCallEvents = mode === 'root'
    ? (rootQueryEvents !== undefined ? rootQueryEvents : rootIdentification?.rootEvents ?? undefined)
    : linkage.childEvents;
  const modelCalls = modelCallEvents === undefined || modelCallEvents === null ? null : /** @type {any[]} */ (modelCallEvents).filter((event) => {
    const payload = event?.payload;
    return payload?.type === 'function_call' || payload?.type === 'custom_tool_call';
  }).length;
  const pendingInnerAtEnd = calls === null ? null : sequence.pendingInnerAtEnd;
  // Per-poll wall times (P2-1 review fix): surfaced beside the decisive wall
  // time so the cap return's own duration is never conflated with the
  // terminal observation's.
  const pollWallTimesMs = sequence === null || sequence === undefined ? null : /** @type {any} */ (sequence).pollWallTimesMs ?? null;
  // Whole-cell host wall time (cell scope, not one observation's duration):
  // the terminal multi-statement cell's total, when the host reported one.
  const cellWallTimeMs = calls === null ? null
    : /** @type {any[]} */ (calls).reduce((/** @type {number | null} */ last, entry) => (
      typeof entry?.cellWallTimeMs === 'number' ? entry.cellWallTimeMs : last), null);
  // Decisive wall times are filled in by the caller once the terminal tool
  // output is known (tool-reported value first, harness override as fallback).
  const decisiveWallMs = typeof input.observedWallMs === 'number' && Number.isSafeInteger(input.observedWallMs) ? input.observedWallMs : null;
  // R1 timing correction: the observer NEVER derives a poll-start remaining
  // lifetime. The retired `workerDurationMs - decisiveWallMs` arithmetic
  // measured the decisive observation's DURATION against the requested worker
  // duration — not the lifetime remaining when the poll started — and
  // overstated it whenever the model started late. Only the driver's measured
  // held-phase timeline may supply the value (mapping layer); at evidence
  // scope the fact stays explicitly unavailable.
  const remainingLifetimeMs = null;
  const remainingLifetimeBasis = /** @type {const} */ ('unavailable');
  return { outerReturns, rootJoins, modelCalls, pendingInnerAtEnd, cellWallTimeMs, decisiveWallMs, pollWallTimesMs, remainingLifetimeMs, remainingLifetimeBasis };
}

/**
 * Qualify completion only when the mode's exact contract held end to end:
 *  - rescue: exact Child linkage, exactly one launcher invocation, the fake
 *    peer's single send, same-handle observation, a terminal exit observed on
 *    the original handle, and the byte-exact public sentinel in the linked
 *    terminal output.
 *  - root: exact Root observation linkage, exactly one companion invocation,
 *    same-handle observation, settled outer continuations, a terminal exit on
 *    the Root handle, and the COMMAND-SPECIFIC rendered result markers in the
 *    linked terminal output (a narrower renderer check — the marker presence
 *    is recorded, never claimed as full stdout equality).
 * @param {ReturnType<typeof inspectLinkage>} linkage
 * @param {ReturnType<typeof inspectCompanion>} companion
 * @param {ReturnType<typeof analyzeCallSequence> | null} sequence
 * @param {ReturnType<typeof inspectObservations>} observations
 * @param {ShellWaitEvidenceInput} input
 * @param {'rescue' | 'root'} mode
 * @param {ReturnType<typeof identifyRootRollout> | null} rootIdentification
 */
function inspectCompletion(linkage, companion, /** @type {any} */ handle, /** @type {any} */ sequence, observations, input, mode, rootIdentification) {
  const terminal = sequence?.lastCompletedOnHandle ?? null;
  const terminalResult = terminal?.result ?? null;
  const processExit = terminalResult && Number.isSafeInteger(terminalResult.exit_code) ? /** @type {number} */ (terminalResult.exit_code) : null;
  // The expected public result is the mode's contract: the Rescue fake-peer
  // sentinel substring, or the root case's command-specific rendered result
  // markers (every marker must be present). The bytes are compared only in
  // the linked terminal output, never host JSONL or messages.
  const expectedResultMarkers = input.publicResultMarkers ?? (typeof input.publicResult === 'string' && input.publicResult.length > 0 ? [input.publicResult] : null);
  // P2-1 round-7 fix: the ALTERNATIVE accepted result set — for the Status
  // deadline-measurement trial, the confirmed production JOB_WAIT_TIMEOUT
  // framing IS the command's real result. Either set satisfies the contract;
  // the matched set is recorded.
  const alternativeResultMarkers = input.publicResultAlternativeMarkers ?? null;
  const primaryMarkersMatched = expectedResultMarkers !== null && terminalResult
    ? typeof terminalResult.output === 'string' && expectedResultMarkers.every((marker) => terminalResult.output.includes(marker))
    : null;
  const alternativeMarkersMatched = alternativeResultMarkers !== null && terminalResult
    ? typeof terminalResult.output === 'string' && alternativeResultMarkers.every((marker) => terminalResult.output.includes(marker))
    : null;
  const publicResultMatched = primaryMarkersMatched === true || alternativeMarkersMatched === true
    ? true
    : primaryMarkersMatched === false || alternativeMarkersMatched === false
      ? false
      : null;
  const resultMarkerSetMatched = publicResultMatched === true
    ? (alternativeMarkersMatched === true ? /** @type {const} */ ('query-deadline') : /** @type {const} */ ('rendered-result'))
    : null;
  // The byte-exact sentinel PRESENCE check above stays a boolean computation;
  // only the retained excerpt changes. A mismatching terminal output is
  // unclassified companion stdout that may echo the private task prompt, so
  // its body is withheld: the marker keeps the exit status, the sentinel
  // outcome, and the output size — never the bytes.
  const terminalOutput = typeof terminalResult?.output === 'string' ? terminalResult.output : null;
  const terminalStdoutExcerpt = publicResultMatched === false && processExit !== null && terminalOutput !== null
    ? {
      kind: 'terminal-stdout-mismatch',
      suppressed: true,
      detail: 'the terminal output is withheld: unclassified companion stdout may echo the private task prompt; only its size, exit status, and the sentinel outcome are recorded',
      processExit,
      sentinelPresent: publicResultMatched,
      outputChars: terminalOutput.length,
      outputBytes: Buffer.byteLength(terminalOutput, 'utf8'),
    }
    : null;
  const decisiveEnd = processExit !== null
    ? 'process-exit'
    : observations.pendingInnerAtEnd === true ? 'cell-pending' : input.workerStillAliveAfterObservation === true ? 'yield-expiry' : 'unknown';
  // The tool-reported wall time is the authoritative decisive measurement; the
  // harness override applies only when the host did not report one.
  const decisiveWallMs = terminal?.wallTimeMs
    ?? observations.decisiveWallMs;
  observations.decisiveWallMs = decisiveWallMs;
  // R1 timing correction: remaining lifetime is never derived here from
  // workerDurationMs - decisiveWallMs. The driver's measured hold-clock
  // timeline is the only sanctioned source; evidence scope keeps the fact
  // explicitly unavailable.
  observations.remainingLifetimeMs = null;
  observations.remainingLifetimeBasis = 'unavailable';
  // Violations split into STRUCTURAL checks (linkage, launch/send counts,
  // observation discipline, outer linkage, unsupported calls — these can
  // never be excused) and the INTERRUPTION-SENSITIVE terminal-completion
  // failures (no exit code on the handle, missing result markers, an
  // observation left unsettled at the end): after a delivered pending-window
  // interrupt, exactly those terminal failures are the EXPECTED shape — the
  // Child was interrupted before completing (P2-2 review fix; the driver
  // reads structuralViolationCount to scope its exemption).
  const violations = /** @type {string[]} */ ([]);
  let structuralViolationCount = 0;
  /** @param {string} message @param {'structural' | 'terminal'} [kind] */
  const violation = (message, kind = 'structural') => {
    violations.push(message);
    if (kind === 'structural') structuralViolationCount += 1;
  };
  const rolloutNoun = mode === 'root' ? 'root rollout' : 'child rollout';
  if (mode === 'root') {
    if (rootIdentification?.exact !== true) violation(rootIdentification?.reason === undefined ? 'the Root observation linkage is not exact' : `the Root observation linkage is not exact: ${rootIdentification.reason}`);
  } else if (linkage.exact !== true) violation('child linkage is not exact');
  if (companion.launchCount !== 1) violation(`the exact launcher command was observed ${companion.launchCount === null ? `in no identified ${rolloutNoun}` : `${String(companion.launchCount)} times`}`);
  if (mode !== 'root') {
    if (!companion.sendCountKnown) violation('the fake peer session/send record was unavailable, so the single-send requirement could not be established');
    else if (companion.sendCount !== 1) violation(`the fake peer observed ${String(companion.sendCount)} session sends instead of exactly one`);
  }
  if (handle.originalHandleChecked === false) violation('the original-handle observation discipline did not hold');
  if (sequence !== null) {
    for (const outerViolation of sequence.outerLinkageViolations) violation(outerViolation);
    for (const discipline of sequence.disciplineViolations) violation(discipline);
    if (sequence.unresolvedContinuation) violation('an accepted outer continuation response was missing or unparseable, so its evidence can never be attributed to the original handle');
    if (sequence.contradictedContinuation) violation(`an accepted outer continuation returned a pending response naming a different cell (${String(sequence.contradictedContinuation.returnedChars)} character(s) while ${String(sequence.contradictedContinuation.outstandingChars)} character(s) were outstanding; reference values withheld); its contradictory evidence blocks qualification`);
    if (sequence.observationsAfterTerminal) violation('observations of the original handle continue after the terminal record, so not every original-handle observation is settled');
    if (sequence.pendingInnerAtEnd) violation('an unresolved or pending inner observation remains at the end of the rollout', 'terminal');
  }
  if (processExit === null) violation('no terminal exit code was observed on the original handle', 'terminal');
  if (publicResultMatched !== true) {
    violation(mode === 'root'
      ? 'the command-specific rendered result markers were missing from the linked terminal output (a narrower renderer check; full stdout equality is not claimed)'
      : 'the terminal public result was missing or did not match byte-for-byte', 'terminal');
  }
  const qualified = violations.length === 0;
  return {
    qualified,
    reason: qualified ? null : `completion cannot be qualified: ${violations.join('; ')}.`,
    structuralViolationCount,
    processExit,
    publicResultMatched,
    resultCheck: mode === 'root' ? 'command-rendered-result-markers' : 'rescue-public-sentinel',
    expectedResultMarkers,
    alternativeResultMarkers,
    resultMarkerSetMatched,
    terminalStdoutExcerpt,
    decisiveEnd,
    decisiveWallMs,
  };
}

/**
 * @typedef {{
 *   rollouts: unknown,
 *   zcodeCalls?: unknown,
 *   command: unknown,
 *   mode?: 'rescue' | 'root',
 *   publicResult?: string | null,
 *   publicResultMarkers?: string[] | null,
 *   publicResultAlternativeMarkers?: string[] | null,
 *   rootQueryTurn?: { sessionId: string, setupEventCount: number } | null,
 *   requestedPollMs?: number | null,
 *   observedWallMs?: number | null,
 *   workerDurationMs?: number | null,
 *   workerStillAliveAfterObservation?: boolean | null,
 *   redactions?: string[],
 * }} ShellWaitEvidenceInput
 */
