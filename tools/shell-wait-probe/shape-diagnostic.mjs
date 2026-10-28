// @ts-check
/**
 * Bounded, NON-EVALUATING, memory-only call-shape classifier for the opt-in
 * controlled shape diagnosis (research-only; plan
 * `docs/superpowers/plans/2026-10-16-rescue-shell-wait-shape-diagnostic.md`
 * Task 2, schema v1 frozen in
 * `docs/qualification/rescue-shell-long-wait.md` §15.1).
 *
 * CANONICAL-EXACT ARCHITECTURE (round-10 adjudication). Positive recognition
 * is the set of pinned grammar mirrors ALONE (the verbatim
 * WRAPPER/INLINE/PREPARATION/ROOT_CONTROL statement shapes below) plus a
 * SMALL, EXPLICIT set of direct mechanical variants of those mirrors: the
 * frozen 8-record discrimination set (generalized binding identifier,
 * missing tail, changed tail, unsupported argument form, extra statement,
 * trailing blank formatting), the trivia-tolerant emission (`text (r)`,
 * `text /*␟/ (r)` — masked comments ARE trivia), and the awaited-call
 * statement (the wrapper skeleton without the binding prefix, which the
 * split-declaration and comma-declarator forms require). Each statement slot
 * is segmented at top-level semicolons (and a depth-closing `}`), and EVERY
 * segment must match one of these positive statement forms, anchored over the
 * string/comment-MASKED code; a form is positive only in a proven statement
 * position (cell start, after `;`/`}`, or after a positively completed
 * statement — and completion is only ever asserted FROM THE PINNED POSITIVE
 * GRAMMAR: the awaited-call/emission forms are anchored complete productions
 * (the emission requires a closed `text(…)`; the awaited-call requires a
 * properly closed pinned `tools.<name>(…)` call), a declaration proves
 * completion only through that same pinned call production, and the
 * slot-level `;` boundary is the other proof. ANY other tail (an operator, a
 * dot, `new`, an open paren, …) leaves completion unproven — a following
 * line withholds (it continues that expression) and end of input is
 * truncation. A dangling
 * pending declaration licenses ONLY its own initializer continuation (the
 * awaited-call, declaration, pending and token-free plain heads) — an
 * emission after it is the initializer expression, never a top-level
 * emission, and withholds. Comment-only lines are formatting: they carry no
 * statement node at all.
 *
 * EVERYTHING ELSE takes the ONE conservative unknown path BY CONSTRUCTION:
 * a non-matching segment, a public-reference token (`tools`/`text`, exact
 * identifier boundaries) outside a pinned position, a bracket depth other
 * than the top level, a backslash escape ANYWHERE in code position (an
 * identifier escape makes every reference spelling undecidable — never a
 * confident presence OR absence claim), or any lexically broken/withheld
 * state classifies the whole slot unknown (head/tool 'unknown', coverage
 * 'partial', wholeInputConsumed false, bindingEquality 'unknown'). The
 * boundary-helper web this replaces (member/private/escape/split reference
 * positions, cross-line carried contexts, nested declarations, generators,
 * constructors, arrow bodies) cannot under-report a hostile form because
 * only the pinned mirrors ever establish a public fact.
 *
 * The classifier runs a string/comment-aware LINEAR lexical scan over the raw
 * call text BEFORE any structural classification, replacing every string
 * literal's content and every comment with same-length filler so tool-like
 * text inside a private string literal can never produce a syntax fact while
 * masked offsets keep the raw literal lengths measurable. It never evaluates,
 * resolves, interpolates or executes anything: no `eval`, no `Function`, no
 * `vm`, no variable resolution, no expression evaluation. Unsupported lexical
 * features (template literals, regex literals, a division operator) fail the
 * affected statement closed to `lexical: 'unsupported-syntax'` with
 * `head`/`tool` unknown — never probed further.
 *
 * Every returned field is a boolean or a member of a fixed closed enum over
 * PUBLIC syntax relations (schema v1). Unknown identifiers/literals map to
 * fixed `other`/`unknown` classes — never a spelling, prefix, length series
 * or per-token hash. The only count-like facts are `statementCount` and the
 * `statements` array length (the schema's fixed statement slots); no string
 * value extracted from the input is ever retained, and the argument literal
 * decoder reuses the existing grammar's bounded in-memory literal semantics
 * while discarding every decoded value.
 *
 * The `parserStage` value DIAGNOSES the response of the existing
 * `parseCallStatements` grammar (its pinned shapes are mirrored verbatim
 * below so this module stays import-cycle-free and testable in isolation);
 * `parse-accepted` is that diagnosis, NEVER an admission verdict and never a
 * validated-call object. Agreement with the real parser is pinned by tests.
 *
 * This module launches nothing when imported and never attaches input text
 * to any error or return value.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The frozen schema version (report §15.1) this module implements. */
export const SHAPE_DIAGNOSTIC_SCHEMA_VERSION = 1;

// Module-INIT snapshot of THIS module's executing source (mirrors
// evidence.mjs): read synchronously at initialization so the driver's
// observer-provenance digest can bind the classifier bytes that Node actually
// loaded, independent of any later on-disk edit (which the record-time re-read
// then detects as sourcesChangedDuringRun without relabelling loaded code).
export const EXECUTING_SHAPE_DIAGNOSTIC_SOURCE = readFileSync(fileURLToPath(import.meta.url));

// Frozen input bounds (report §15.1). The argument bound matches
// MAX_WRAPPER_ARGUMENT_CHARS in evidence.mjs; the excerpt/diagnostic record
// stays bounded by the existing 2048-character excerpt budget.
const MAX_SHAPE_INPUT_BYTES = 8192;
const MAX_SHAPE_STATEMENT_SLOTS = 16;
const MAX_SHAPE_ARGUMENT_CHARS = 4096;

// VERBATIM mirrors of the pinned patterns in evidence.mjs (DIRECTIVE_PATTERN,
// WRAPPER_PATTERN, INLINE_WRAPPER_PATTERN, PREPARATION_PATTERN,
// ROOT_CONTROL_WRAPPER_PATTERN). They exist ONLY to diagnose which existing
// stage would respond to the input; the classifier never admits anything.
const DIRECTIVE_PATTERN = /^\/\/ @exec: ([\s\S]{1,512}?)\n/u;
const WRAPPER_PATTERN = /^const r = await tools\.(exec_command|write_stdin)\((\{[\s\S]{1,4096}?\})\);\s*text\((?:JSON\.stringify\(r\)|r)\);?\n?$/u;
const INLINE_WRAPPER_PATTERN = /^text\(await tools\.(exec_command|write_stdin|wait)\((\{[\s\S]{1,4096}?\})\)\);\n?$/u;
const PREPARATION_PATTERN = /^text\(await tools\.write_stdin\(\{session_id:(\d{1,12}),chars:JSON\.stringify\((\{[\s\S]{1,4096}?\})\)\+"\\n"(?:,yield_time_ms:(\d{1,9}))?(?:,max_output_tokens:\d{1,9})?\}\)\);\n?$/u;
const ROOT_CONTROL_WRAPPER_PATTERN = /^text\(await tools\.(interrupt_agent|send_input)\((\{[\s\S]{1,4096}?\})\)\);\n?$/u;
// The pinned wrapper stage's head prefix (binding and tool family exactly as
// WRAPPER_PATTERN pins them): a slot starting like this whose failure sits
// DOWNSTREAM of the wrapper skeleton diagnoses the arguments/output stage
// instead of the wrapper stage. Native-acceptance review round: the binding
// class is the FROZEN BOUNDED-NAME grammar (the anchored non-`r` family's
// BOUND_RESULT_WRAPPER_PATTERN in evidence.mjs, mirrored verbatim below), so
// a generalized binding with a failure downstream of the skeleton diagnoses
// arguments/output exactly like the pinned `r` head does.
const WRAPPER_HEAD_PREFIX_PATTERN = /^const [A-Za-z_][A-Za-z0-9_]{0,63} = await tools\.(?:exec_command|write_stdin)\(/u;
// VERBATIM mirror of evidence.mjs's BOUND_RESULT_WRAPPER_PATTERN (the
// anchored bounded-name wrapper family, report §24.11 amendment): the
// non-`r` bounded-binding whole-body statement with the §23.2 emission-
// junction tolerances and the structural equality backreference. It exists
// ONLY to diagnose which existing stage would respond to the input; the
// classifier never admits anything.
const BOUND_RESULT_WRAPPER_PATTERN = /^const (?!(?:r) = await )([A-Za-z_][A-Za-z0-9_]{0,63}) = await tools\.(exec_command|write_stdin)\((\{[^\n]{1,4096}?\})\);[ \t]*text[ \t]{0,8}\([ \t]{0,8}\1[ \t]{0,8}\);?[ \t]*\r?\n?$/u;

// The public tool allowlist at v1: any other established name (including its
// spelling) is the fixed `other` class.
/** @type {Set<string>} */
const KNOWN_SHAPE_TOOLS = new Set(['exec_command']);
// EMPTY at v1: no public result field is enumerated, so every property
// projection stays `text-other`. Extending requires a new adjudication.
/** @type {Set<string>} */
const TEXT_PUBLIC_RESULT_FIELDS = new Set([]);

/**
 * @typedef {'bound-await' | 'bare-await' | 'emission' | 'other' | 'unknown'} ShapeHeadClass
 * @typedef {'exec_command' | 'other' | 'no-call' | 'unknown'} ShapeToolClass
 * @typedef {'literal-object' | 'unsupported' | 'none' | 'over-limit'} ShapeArgumentClass
 * @typedef {'complete' | 'unterminated' | 'invalid' | 'unsupported-syntax'} ShapeLexicalClass
 * @typedef {'text-binding' | 'text-stringify-binding' | 'text-public-field' | 'text-other' | 'none' | 'unknown'} ShapeTailClass
 * @typedef {'complete' | 'partial' | 'over-budget' | 'over-scope'} ShapeCoverageClass
 * @typedef {'parse-accepted' | 'wrapper' | 'arguments' | 'output' | 'residual' | 'directive' | 'unknown'} ShapeParserStageClass
 * @typedef {'absent' | 'valid' | 'invalid' | 'unknown'} ShapeDirectiveClass
 * @typedef {{
 *   version: typeof SHAPE_DIAGNOSTIC_SCHEMA_VERSION,
 *   coverage: ShapeCoverageClass,
 *   statements?: { head: ShapeHeadClass, tool: ShapeToolClass, argument: ShapeArgumentClass, lexical: ShapeLexicalClass, tail: ShapeTailClass }[],
 *   statementCount: number | 'over-limit',
 *   tool: ShapeToolClass,
 *   head: ShapeHeadClass,
 *   tail: ShapeTailClass,
 *   bindingEquality: 'equal' | 'not-equal' | 'unrelated' | 'unknown',
 *   parserStage: ShapeParserStageClass,
 *   directive: ShapeDirectiveClass,
 *   wholeInputConsumed: boolean,
 * }} ShapeFacts
 */

/**
 * One classified statement slot plus INTERNAL relation fields (identifier
 * strings used only for equality comparison — never serialized). A slot with
 * `head: 'unknown'` is UNKNOWN-CLASSIFIED (the conservative withheld path);
 * every other slot was positively recognized by the canonical grammar or one
 * of its explicit mechanical variants.
 * @typedef {{
 *   head: ShapeHeadClass, tool: ShapeToolClass, argument: ShapeArgumentClass,
 *   lexical: ShapeLexicalClass, tail: ShapeTailClass,
 *   boundBinding: string | null,
 *   trailingBinding: string | null,
 *   tailIdentifier: string | null,
 *   hasEmission: boolean,
 *   pendingIdentifier: string | null,
 *   endsInCompleteStatement: boolean,
 * }} ClassifiedSlot
 */

/**
 * The fixed out-of-scope result for input the schema cannot say anything
 * about (non-string input, or an unexpected internal failure): bounded,
 * closed, and free of any input-derived value.
 * @returns {ShapeFacts}
 */
function fixedOutOfScopeResult() {
  return {
    version: 1,
    coverage: 'over-scope',
    statements: [],
    statementCount: 0,
    tool: 'no-call',
    head: 'unknown',
    tail: 'none',
    bindingEquality: 'unknown',
    parserStage: 'unknown',
    directive: 'unknown',
    wholeInputConsumed: false,
  };
}

/**
 * Lex ONE cell with a SINGLE FORWARD STATE MACHINE over all of its lines,
 * carrying every literal/comment boundary across newline slots: quoted strings
 * (a backslash-newline line continuation keeps the string open), block
 * comments, and the typed bracket-delimiter stack all span lines. When the
 * lexer meets syntax it does not track reliably (template literals — declared
 * unsupported, including their escaped delimiters — optional chaining/nullish
 * coalescing, or a lone slash standing for a regex/division), the remainder of
 * the CELL is WITHHELD conservatively: every following line is unknown-
 * classified, so private content after a lexer boundary can never establish a
 * public syntax fact. Fail-closed conservatism is the contract; over-reporting
 * is not.
 * @param {string} source the directive-stripped cell source
 * @returns {{ lexical: ShapeLexicalClass, masked: string, entryDepth: number }[]} one entry per source line, with the delimiter depth carried INTO the line
 */
function lexCellLines(source) {
  /** @type {{ lexical: ShapeLexicalClass, masked: string, entryDepth: number }[]} */
  const results = [];
  let state = /** @type {'code' | 'single' | 'double' | 'block-comment'} */ ('code');
  /** @type {string[]} */
  let stack = [];
  let remainderWithheld = false;
  let firstUncleanExit = -1;
  const lines = source.split('\n');
  for (const [index, line] of lines.entries()) {
    const blanked = ' '.repeat(line.length);
    const entryDepth = stack.length;
    if (remainderWithheld) {
      results.push({ lexical: 'unsupported-syntax', masked: blanked, entryDepth });
      continue;
    }
    const lexed = lexCellLine(line, state, stack);
    results.push({ lexical: lexed.lexical, masked: lexed.masked, entryDepth });
    state = lexed.exitState;
    stack = lexed.exitStack;
    if (lexed.withholdRemainder === true) remainderWithheld = true;
    if (state !== 'code' || stack.length > 0) {
      if (firstUncleanExit === -1) firstUncleanExit = index;
    }
  }
  // End-of-cell truncation: an open construct or a nonempty delimiter stack
  // at end-of-input means the cell never completed — every line still
  // claiming 'complete' from the first participating line onward is
  // poisoned to 'unterminated' (never a claimed-complete classification
  // over truncated input).
  if (state !== 'code' || stack.length > 0) {
    for (let index = firstUncleanExit === -1 ? 0 : firstUncleanExit; index < results.length; index += 1) {
      if (results[index].lexical === 'complete') results[index] = { lexical: 'unterminated', masked: results[index].masked, entryDepth: results[index].entryDepth };
    }
  }
  return results;
}

/**
 * Whether the unit is an ECMAScript line terminator: a line comment ends at
 * EACH of LF, CR, U+2028 and U+2029 — not only at the LF the slot split
 * consumed.
 * @param {string} unit
 */
function isEcmascriptLineTerminator(unit) {
  return unit === '\n' || unit === '\r' || unit === '\u2028' || unit === '\u2029';
}

/**
 * Lex ONE line with the carried entry state ('code', inside a single- or
 * double-quoted string, or inside a block comment) and the carried delimiter
 * stack. The masking is length-preserving; the line's verdict is 'complete'
 * only when it begins AND ends in code state with no broken construct. A line
 * that begins inside any construct is not a sayable statement. Quoted strings
 * continue across a line boundary ONLY through a backslash-newline escape
 * (the last consumed character before end-of-line being a lone backslash);
 * any other unterminated string is plain truncation. Delimiters are tracked
 * BY TYPE: a closer that mismatched the innermost opener (or arrives with an
 * empty stack) is 'invalid'. Unsupported syntax (template literals, optional
 * chaining, nullish coalescing, a lone slash) fails the line closed AND asks
 * the caller to withhold the rest of the cell.
 * @param {string} line
 * @param {'code' | 'single' | 'double' | 'block-comment'} entryState
 * @param {string[]} entryStack the open delimiter types carried from earlier lines
 * @returns {{ lexical: ShapeLexicalClass, masked: string, exitState: 'code' | 'single' | 'double' | 'block-comment', exitStack: string[], withholdRemainder?: boolean }}
 */
function lexCellLine(line, entryState, entryStack) {
  const units = line.split('');
  let index = 0;
  let state = entryState;
  /** @type {string[]} */
  const stack = [...entryStack];
  while (index < units.length) {
    if (state === 'block-comment') {
      const end = line.indexOf('*/', index);
      if (end === -1) {
        for (let fill = index; fill < units.length; fill += 1) units[fill] = ' ';
        return { lexical: 'unterminated', masked: units.join(''), exitState: 'block-comment', exitStack: stack };
      }
      for (let fill = index; fill < end + 2; fill += 1) units[fill] = ' ';
      index = end + 2;
      state = 'code';
      continue;
    }
    if (state === 'single' || state === 'double') {
      const quote = state === 'single' ? "'" : '"';
      let closed = false;
      let endsWithLineContinuation = false;
      while (index < units.length) {
        const unit = units[index];
        if (unit === '\\') {
          units[index] = 'x';
          if (index + 1 < units.length) {
            const escaped = units[index + 1];
            units[index + 1] = 'x';
            // A backslash-CR at end-of-line is the CRLF line continuation
            // (the LF was consumed by the slot split): the string continues
            // on the next line exactly like a backslash-LF escape.
            if (escaped === '\r' && index + 2 === units.length) {
              index += 2;
              endsWithLineContinuation = true;
              continue;
            }
            index += 2;
            continue;
          }
          // A backslash as the line's last character escapes the NEWLINE:
          // the string legitimately continues on the next line.
          index += 1;
          endsWithLineContinuation = true;
          continue;
        }
        if (unit === quote) { closed = true; index += 1; break; }
        units[index] = 'x';
        index += 1;
      }
      if (closed) { state = 'code'; continue; } // resume code on the rest of the line
      if (endsWithLineContinuation) {
        return { lexical: 'unterminated', masked: units.join(''), exitState: state, exitStack: stack };
      }
      return { lexical: 'unterminated', masked: units.join(''), exitState: 'code', exitStack: stack };
    }
    const character = units[index];
    if (character === '"' || character === "'") {
      state = character === '"' ? 'double' : 'single';
      index += 1;
      continue;
    }
    if (character === '`') {
      // Declared-unsupported feature with escape-sensitive delimiters: the
      // rest of the line AND the rest of the cell are withheld.
      for (let fill = index; fill < units.length; fill += 1) units[fill] = ' ';
      return { lexical: 'unsupported-syntax', masked: units.join(''), exitState: 'code', exitStack: stack, withholdRemainder: true };
    }
    if (character === '/' && units[index + 1] === '/') {
      // A line comment ends at EACH ECMAScript line terminator (LF, CR,
      // U+2028, U+2029) — not only at the LF the slot split consumed: code
      // carried after a separator inside one newline slot is real CODE and
      // must stay unmasked (the mask would otherwise swallow executable
      // statements into a confident wrong absence). The terminators
      // themselves are masked trivia, and lexing CONTINUES over them in
      // code state, so the remainder of the slot is still fully lexed and
      // private content after the separator stays masked.
      while (index < units.length && !isEcmascriptLineTerminator(units[index])) {
        units[index] = ' ';
        index += 1;
      }
      while (index < units.length && isEcmascriptLineTerminator(units[index])) {
        units[index] = ' ';
        index += 1;
      }
      continue;
    }
    if (character === '/' && units[index + 1] === '*') {
      const end = line.indexOf('*/', index + 2);
      if (end === -1) {
        for (let fill = index; fill < units.length; fill += 1) units[fill] = ' ';
        return { lexical: 'unterminated', masked: units.join(''), exitState: 'block-comment', exitStack: stack };
      }
      for (let fill = index; fill < end + 2; fill += 1) units[fill] = ' ';
      index = end + 2;
      continue;
    }
    if (character === '?' && (units[index + 1] === '.' || units[index + 1] === '?')) {
      // Optional chaining (`?.`, `?.[`) and nullish coalescing (`??`) are in
      // the declared-unsupported family (§15.1): failed closed BEFORE any
      // structural classification, with the rest of the cell withheld so no
      // later boundary is tracked past the unsupported token.
      return { lexical: 'unsupported-syntax', masked: units.join(''), exitState: 'code', exitStack: stack, withholdRemainder: true };
    }
    // A lone slash would be a regex literal or a division operator: an
    // unsupported lexical feature, failed closed rather than guessed, with
    // the rest of the cell withheld.
    if (character === '/') return { lexical: 'unsupported-syntax', masked: units.join(''), exitState: 'code', exitStack: stack, withholdRemainder: true };
    if (character === '(' || character === '[' || character === '{') {
      stack.push(character);
      index += 1;
      continue;
    }
    if (character === ')' || character === ']' || character === '}') {
      const opener = stack.pop();
      const expected = character === ')' ? '(' : character === ']' ? '[' : '{';
      if (opener !== expected) {
        // A mismatched delimiter is an unreliable boundary: the rest of the
        // cell is withheld (the comment/template opener after it would
        // otherwise be skipped and the next line would resume in code state).
        return { lexical: 'invalid', masked: units.join(''), exitState: 'code', exitStack: [], withholdRemainder: true };
      }
      index += 1;
      continue;
    }
    index += 1;
  }
  // A line that began inside an open construct is not a sayable statement
  // even when the construct closes mid-line: its statement structure is
  // broken by the carried state, so it stays unknown-classified.
  if (entryState !== 'code') return { lexical: 'unterminated', masked: units.join(''), exitState: state, exitStack: stack };
  return { lexical: 'complete', masked: units.join(''), exitState: state, exitStack: stack };
}

/**
 * The balanced bracket span starting at `openIndex` in MASKED code (string
 * content and comments are inert there, so bracket counting is exact).
 * @param {string} code @param {number} openIndex
 * @returns {string | null} the span including both brackets, or null when it never closes
 */
function balancedSpan(code, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < code.length; index += 1) {
    const unit = code[index];
    if (unit === '(' || unit === '[' || unit === '{') depth += 1;
    else if (unit === ')' || unit === ']' || unit === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(openIndex, index + 1);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// CANONICAL-EXACT CLASSIFICATION CORE
//
// JavaScript identifier classes: `$` AND `_` are identifier-start characters
// in ECMAScript on TOP of the Unicode ID_Start property (the low line U+005F
// is NOT inside \p{ID_Start}), so both are spelled out explicitly. The /u
// flag makes the regex engine read astral characters as complete code points,
// so the identifier-boundary lookarounds below are surrogate-pair exact.
// ---------------------------------------------------------------------------

const IDENTIFIER_START_CLASS = '[\\p{ID_Start}$_]';
const IDENTIFIER_CONTINUE_CLASS = '[\\p{ID_Continue}$_]';
const IDENTIFIER = `${IDENTIFIER_START_CLASS}${IDENTIFIER_CONTINUE_CLASS}*`;
// The await keyword requires a COMPLETE token boundary: `await$secret`,
// `awaitπ` and `await\u0061` are private identifiers, not the keyword.
const AWAIT_KEYWORD = `await(?!${IDENTIFIER_CONTINUE_CLASS}|\\\\)`;

/** A dangling `const|let|var <identifier> =` (the declaration's initializer continues on the next slot). */
const PENDING_DECLARATION_PATTERN = new RegExp(`^(?:const|let|var)\\s+(${IDENTIFIER})\\s*=$`, 'u');
/** The declaration statement's declarator LIST (comma-separated declarators are handled positionally). */
const DECLARATION_PATTERN = /^(?:const|let|var)\s+([\s\S]+)$/u;
/** One declarator: `<identifier> = await <expression>` — only awaited initializers can become result bindings. */
const DECLARATOR_PATTERN = new RegExp(`^(${IDENTIFIER})\\s*=\\s*${AWAIT_KEYWORD}\\s*([\\s\\S]*)$`, 'u');
/** A non-awaited declarator (`<identifier> = <expression>`): carries NO result binding. */
const NON_AWAITED_DECLARATOR_PATTERN = new RegExp(`^(${IDENTIFIER})\\s*=\\s*([\\s\\S]+)$`, 'u');
/** The awaited-call statement: the wrapper skeleton without the binding prefix. */
const AWAITED_PATTERN = new RegExp(`^${AWAIT_KEYWORD}\\s*([\\s\\S]+)$`, 'u');
/** The emission token at a segment start; trivia before the parenthesis is allowed (masked comments ARE trivia). */
const EMISSION_HEAD_PATTERN = /^text(?![\p{ID_Continue}$_])\s*\(/u;
/** The PINNED tools call at an expression start: exact adjacency, no trivia inside the reference. */
const TOOLS_CALL_HEAD_PATTERN = new RegExp(`^tools\\.(${IDENTIFIER_CONTINUE_CLASS}+)\\s*\\(`, 'u');
/** The pinned tools call inside an emission argument (the inline-wrapper form), optionally awaited. */
const INLINE_TOOLS_CALL_PATTERN = new RegExp(`^(?:${AWAIT_KEYWORD}\\s+)?tools\\.(${IDENTIFIER_CONTINUE_CLASS}+)\\s*\\(`, 'u');
/** An exact `tools` token (identifier boundaries on both sides — `πtools`/`$tools`/`textx` never match). */
const TOOLS_TOKEN_PATTERN = /(?<![\p{ID_Continue}$_])tools(?![\p{ID_Continue}$_])/gu;
/** An exact `text` token. */
const TEXT_TOKEN_PATTERN = /(?<![\p{ID_Continue}$_])text(?![\p{ID_Continue}$_])/gu;
// The frozen tail argument forms (verbatim classes of the old tail rule).
const TAIL_STRINGIFY_PATTERN = new RegExp(`^JSON\\.stringify\\(\\s*(${IDENTIFIER})\\s*\\)$`, 'u');
const TAIL_BINDING_PATTERN = new RegExp(`^(${IDENTIFIER})$`, 'u');
const TAIL_PROPERTY_PATTERN = new RegExp(`^(${IDENTIFIER})\\.(${IDENTIFIER})$`, 'u');

/** @param {string} code @returns {boolean} any backslash in MASKED code is code-position (string/comment backslashes are masked away) — an identifier escape makes every reference spelling undecidable */
function containsBackslash(code) {
  return code.includes('\\');
}

/** @param {string} code @returns {boolean} */
function containsToolsToken(code) {
  TOOLS_TOKEN_PATTERN.lastIndex = 0;
  return TOOLS_TOKEN_PATTERN.test(code);
}

/** @param {string} code @returns {boolean} */
function containsTextToken(code) {
  TEXT_TOKEN_PATTERN.lastIndex = 0;
  return TEXT_TOKEN_PATTERN.test(code);
}

/**
 * The unbalanced bracket depth immediately before `at` (the masked code is
 * inert, so counting is exact).
 * @param {string} code @param {number} at
 */
function bracketDepthBefore(code, at) {
  let depth = 0;
  for (let index = 0; index < at; index += 1) {
    const unit = code[index];
    if (unit === '(' || unit === '[' || unit === '{') depth += 1;
    else if (unit === ')' || unit === ']' || unit === '}') depth -= 1;
  }
  return depth;
}

/**
 * Split masked code at TOP-LEVEL occurrences of `separator` (brackets make
 * separators inside argument spans inert). With `breakAfterClose`, a `}`
 * that closes the depth back to 0 is also a statement boundary (the
 * grammar's proven statement positions are `;` and `}`), so `…} text(r)`
 * segments like a semicolon-separated pair. The final part is returned even
 * when unterminated (`text(r)` without its `;` is the pinned pair form).
 * @param {string} code @param {';' | ','} separator @param {boolean} [breakAfterClose]
 * @returns {string[]}
 */
function splitTopLevel(code, separator, breakAfterClose = false) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < code.length; index += 1) {
    const character = code[index];
    if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' || character === ']' || character === '}') {
      depth -= 1;
      if (breakAfterClose && character === '}' && depth === 0 && index + 1 < code.length) {
        parts.push(code.slice(start, index + 1));
        start = index + 1;
      }
    } else if (character === separator && depth === 0) {
      parts.push(code.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(code.slice(start));
  return parts;
}

/**
 * Whether a `text` token occurrence in an awaited expression sits at the
 * expression's TOP level: a depth-0 occurrence is not a pinned position, so
 * the slot is withheld; occurrences inside bracketed sub-expressions are
 * inert (they can never be a top-level emission of the slot).
 * @param {string} expression
 */
function hasTopLevelTextToken(expression) {
  TEXT_TOKEN_PATTERN.lastIndex = 0;
  let match = TEXT_TOKEN_PATTERN.exec(expression);
  while (match !== null) {
    if (bracketDepthBefore(expression, match.index) === 0) return true;
    match = TEXT_TOKEN_PATTERN.exec(expression);
  }
  return false;
}

/**
 * The argument-literal verdict for a pinned call's balanced argument span
 * (the MASKED span — decoded values are discarded, only the class survives).
 * @param {string} argumentSpan the balanced `(…)` span
 * @returns {ShapeArgumentClass}
 */
function classifyCallArgument(argumentSpan) {
  const inner = argumentSpan.slice(1, -1).trim();
  if (!inner.startsWith('{')) return 'unsupported';
  const braces = balancedSpan(inner, 0);
  if (braces === null || braces.length !== inner.length) return 'unsupported';
  return braces.length > MAX_SHAPE_ARGUMENT_CHARS ? 'over-limit'
    : decodeBoundedLiteralObject(braces) !== null ? 'literal-object' : 'unsupported';
}

/**
 * A PINNED tools call at the very start of `code`: exact `tools.<name>(`
 * adjacency (a trivia-split reference never matches and withholds the slot),
 * a balanced argument span, and nothing but trivia after the span.
 * @param {string} code
 * @returns {{ name: string, argumentSpan: string } | null}
 */
function pinnedToolsCall(code) {
  const head = TOOLS_CALL_HEAD_PATTERN.exec(code);
  if (head === null) return null;
  const open = head[0].length - 1;
  const span = balancedSpan(code, open);
  if (span === null) return null;
  if (code.slice(open + span.length).trim().length > 0) return null;
  return { name: head[1], argumentSpan: span };
}

/**
 * Classify the expression after `await` in a declaration or awaited-call
 * statement. `null` means WITHHOLD (a tools reference outside the pinned
 * position, or a top-level emission token) — never a confident no-call.
 * @param {string} expression
 * @returns {{ tool: ShapeToolClass, argument: ShapeArgumentClass } | null}
 */
function classifyAwaitedExpression(expression) {
  const trimmed = expression.trim();
  const pinned = pinnedToolsCall(trimmed);
  if (pinned !== null) {
    return {
      tool: KNOWN_SHAPE_TOOLS.has(pinned.name) ? 'exec_command' : 'other',
      argument: classifyCallArgument(pinned.argumentSpan),
    };
  }
  if (containsToolsToken(trimmed)) return null;
  if (hasTopLevelTextToken(trimmed)) return null;
  return { tool: 'no-call', argument: 'none' };
}

/**
 * @typedef {{
 *   kind: 'declaration' | 'awaited' | 'emission' | 'plain' | 'pending',
 *   headClass: ShapeHeadClass, tool: ShapeToolClass, argument: ShapeArgumentClass,
 *   tail: ShapeTailClass, tailIdentifier: string | null,
 *   bindings: string[], hasEmission: boolean,
 *   startsWithAwait: boolean, isPending: boolean, pendingIdentifier: string | null,
 *   expressionComplete: boolean, headTokenIsIdentifier: boolean,
 * }} ClassifiedSegment
 */

/**
 * @returns {ClassifiedSegment}
 */
function plainSegment() {
  return { kind: 'plain', headClass: 'other', tool: 'no-call', argument: 'none', tail: 'none', tailIdentifier: null, bindings: [], hasEmission: false, startsWithAwait: false, isPending: false, pendingIdentifier: null, expressionComplete: false, headTokenIsIdentifier: false };
}

/**
 * Classify ONE top-level statement segment (a `;`-separated part of the
 * slot's masked code). Returns null when the segment is NOT positively
 * recognized — the caller withholds the whole slot (the one conservative
 * unknown path). The positive forms are the mechanical variants of the
 * pinned statement mirrors only:
 * - pending:   `const <id> =` (the initializer continues on the next slot;
 *              adopted there ONLY when that slot itself starts the awaited
 *              initializer)
 * - declaration: `const|let|var <id> = await <expr>(, <id> = await <expr>)*`
 *              (comma-separated declarators are handled POSITIONALLY)
 * - awaited:   `await <expr>` (the wrapper skeleton minus the binding prefix)
 * - emission:  `text <trivia> ( <argument> )` — the trivia-tolerant tail
 *              form; the inline-wrapper call inside the argument is the
 *              pinned tool position
 * - plain:     a statement with NO public-reference token at all
 * `<expr>` is either the pinned `tools.<name>(…)` call or free of public
 * reference tokens (a tools token at a non-pinned position withholds; a
 * `text` token inside a bracketed sub-expression of the awaited expression is
 * inert).
 * @param {string} rawSegment
 * @returns {ClassifiedSegment | null}
 */
function classifySegment(rawSegment) {
  const segment = rawSegment.trim();
  if (segment.length === 0) return null;
  const pending = PENDING_DECLARATION_PATTERN.exec(segment);
  if (pending !== null) {
    return { kind: 'pending', headClass: 'other', tool: 'no-call', argument: 'none', tail: 'none', tailIdentifier: null, bindings: [], hasEmission: false, startsWithAwait: false, isPending: true, pendingIdentifier: pending[1], expressionComplete: false, headTokenIsIdentifier: true };
  }
  const hasPublicToken = containsToolsToken(segment) || containsTextToken(segment);
  const declaration = DECLARATION_PATTERN.exec(segment);
  if (declaration !== null) {
    /** @type {{ identifier: string, tool: ShapeToolClass, argument: ShapeArgumentClass }[]} */
    const declarators = [];
    /** @type {string | null} */
    let lastAwaitedExpression = null;
    /** @type {boolean} */
    let finalDeclaratorAwaited = false;
    for (const part of splitTopLevel(declaration[1], ',')) {
      const trimmedPart = part.trim();
      const declarator = DECLARATOR_PATTERN.exec(trimmedPart);
      if (declarator !== null) {
        const call = classifyAwaitedExpression(declarator[2]);
        if (call === null) return null;
        lastAwaitedExpression = declarator[2];
        finalDeclaratorAwaited = true;
        declarators.push({ identifier: declarator[1], tool: call.tool, argument: call.argument });
        continue;
      }
      // A non-awaited declarator carries NO result binding: it is skipped
      // POSITIONALLY when it is free of public-reference tokens (a mixed
      // list keeps its awaited bindings); one carrying a public reference is
      // never silently ignored — the slot withholds. It also becomes the
      // declaration's TAIL: the completion proof below derives from the
      // FINAL declarator, so a trailing non-awaited initializer cannot hide
      // behind an earlier awaited one.
      const nonAwaited = NON_AWAITED_DECLARATOR_PATTERN.exec(trimmedPart);
      if (nonAwaited !== null && !containsToolsToken(nonAwaited[2]) && !containsTextToken(nonAwaited[2])) {
        finalDeclaratorAwaited = false;
        lastAwaitedExpression = null;
        continue;
      }
      // Not a well-formed declarator at all: sayable only when the whole
      // segment is free of public-reference tokens (then it is a plain
      // statement), withheld otherwise.
      return hasPublicToken ? null : plainSegment();
    }
    if (declarators.length === 0) return hasPublicToken ? null : plainSegment();
    let tool = /** @type {ShapeToolClass} */ ('no-call');
    let argument = /** @type {ShapeArgumentClass} */ ('none');
    for (const declarator of declarators) {
      if (declarator.tool !== 'no-call') { tool = declarator.tool; argument = declarator.argument; }
    }
    // POSITIVE COMPLETION PROOF (ALLOWLIST — completion is only ever
    // asserted from the pinned positive grammar): the segment proves the
    // next slot's statement position ONLY when its FINAL declarator's
    // awaited expression is a PINNED completed call — a properly closed
    // `tools.<name>(…)` span (the wrapper skeleton's own production). A
    // LATER non-awaited declarator is the declaration's tail: its
    // initializer has no allowlist production, so the statement did NOT
    // complete. ANY other expression tail — an identifier, an operator, a
    // dot, `new`, an open paren, anything — also leaves completion unproven
    // (an expression continues after a large open token set; enumerating
    // unfinished tails can never terminate): a following line then
    // withholds (it continues that expression) and end of input is
    // truncation. The slot-level `;` boundary remains the other completion
    // proof.
    const expressionComplete = finalDeclaratorAwaited && lastAwaitedExpression !== null
      && pinnedToolsCall(lastAwaitedExpression.trim()) !== null;
    return { kind: 'declaration', headClass: 'bound-await', tool, argument, tail: 'none', tailIdentifier: null, bindings: declarators.map((declarator) => declarator.identifier), hasEmission: false, startsWithAwait: true, isPending: false, pendingIdentifier: null, expressionComplete, headTokenIsIdentifier: true };
  }
  const awaited = AWAITED_PATTERN.exec(segment);
  if (awaited !== null) {
    const call = classifyAwaitedExpression(awaited[1]);
    if (call === null) return null;
    const expressionComplete = pinnedToolsCall(awaited[1].trim()) !== null;
    return { kind: 'awaited', headClass: 'bare-await', tool: call.tool, argument: call.argument, tail: 'none', tailIdentifier: null, bindings: [], hasEmission: false, startsWithAwait: true, isPending: false, pendingIdentifier: null, expressionComplete, headTokenIsIdentifier: true };
  }
  const emissionHead = EMISSION_HEAD_PATTERN.exec(segment);
  if (emissionHead !== null) {
    const open = emissionHead[0].length - 1;
    const span = balancedSpan(segment, open);
    if (span === null || segment.slice(open + span.length).trim().length > 0) return null;
    const inner = span.slice(1, -1).trim();
    // The frozen tail argument forms (anything else inside text(…) is the
    // fixed text-other class; a nested emission never classifies the tail).
    const stringify = TAIL_STRINGIFY_PATTERN.exec(inner);
    const binding = TAIL_BINDING_PATTERN.exec(inner);
    const property = TAIL_PROPERTY_PATTERN.exec(inner);
    /** @type {ShapeTailClass} */
    let tail = 'text-other';
    /** @type {string | null} */
    let tailIdentifier = null;
    if (stringify !== null) { tail = 'text-stringify-binding'; tailIdentifier = stringify[1]; }
    else if (binding !== null) { tail = 'text-binding'; tailIdentifier = binding[1]; }
    else if (property !== null) {
      tail = TEXT_PUBLIC_RESULT_FIELDS.has(property[2]) ? 'text-public-field' : 'text-other';
      tailIdentifier = property[1];
    }
    // The inline-wrapper call is the pinned tool position of an emission;
    // any OTHER tools token inside the argument withholds the slot. Nested
    // `text(` occurrences are inert (the anchored form consumed the segment).
    let tool = /** @type {ShapeToolClass} */ ('no-call');
    let argument = /** @type {ShapeArgumentClass} */ ('none');
    const inlineCall = INLINE_TOOLS_CALL_PATTERN.exec(inner);
    if (inlineCall !== null) {
      const inlineOpen = inlineCall[0].length - 1;
      const inlineSpan = balancedSpan(inner, inlineOpen);
      if (inlineSpan === null || inner.slice(inlineOpen + inlineSpan.length).trim().length > 0) return null;
      tool = KNOWN_SHAPE_TOOLS.has(inlineCall[1]) ? 'exec_command' : 'other';
      argument = classifyCallArgument(inlineSpan);
    } else if (containsToolsToken(inner)) return null;
    return { kind: 'emission', headClass: 'emission', tool, argument, tail, tailIdentifier, bindings: [], hasEmission: true, startsWithAwait: false, isPending: false, pendingIdentifier: null, expressionComplete: true, headTokenIsIdentifier: true };
  }
  // No pinned form matched: sayable only as a plain statement with no
  // public-reference token anywhere.
  return hasPublicToken ? null : plainSegment();
}

/**
 * Classify one statement slot from its precomputed lexed view. String/comment
 * content is physically absent from every match below, so private literals
 * can never contribute a tool, binding, emission or argument fact. The slot
 * is positively classified only when EVERY top-level segment matches one of
 * the pinned statement forms; anything else — a non-matching segment, a
 * public-reference token outside a pinned position, a backslash escape
 * anywhere, a slot inside a spanning bracket construct, or a broken lexical
 * state — takes the ONE conservative unknown path.
 * @param {{ lexical: ShapeLexicalClass, masked: string, entryDepth: number }} lexed
 * @param {boolean} [provenStart] the carried statement-position context: the slot starts at the cell boundary, after a proven statement boundary (`;`/`}`), or continuing a dangling pending declaration
 * @param {string | null} [prefixPendingBinding] the carried pending-declaration identifier from the previous slot's dangling `const <id> =`
 * @returns {ClassifiedSlot}
 */
function classifyStatementSlot(lexed, provenStart = true, prefixPendingBinding = null, provenByTerminator = true) {
  if (lexed.lexical !== 'complete') {
    return { head: 'unknown', tool: 'unknown', argument: 'unsupported', lexical: lexed.lexical, tail: 'unknown', boundBinding: null, trailingBinding: null, tailIdentifier: null, hasEmission: false, pendingIdentifier: null, endsInCompleteStatement: false };
  }
  const code = lexed.masked.trim();
  const withheld = () => ({ head: /** @type {ShapeHeadClass} */ ('unknown'), tool: /** @type {ShapeToolClass} */ ('unknown'), argument: /** @type {ShapeArgumentClass} */ ('unsupported'), lexical: lexed.lexical, tail: /** @type {ShapeTailClass} */ ('unknown'), boundBinding: null, trailingBinding: null, tailIdentifier: null, hasEmission: false, pendingIdentifier: null, endsInCompleteStatement: false });
  // A backslash anywhere in code position (an identifier escape, or any
  // other escape the lexer did not already mask away) makes every reference
  // spelling in the slot undecidable: withheld, never a confident presence
  // OR absence. A slot inside a spanning bracket construct is likewise not a
  // top-level statement.
  if (containsBackslash(code) || lexed.entryDepth > 0) return withheld();
  /** @type {ClassifiedSegment[]} */
  const segments = [];
  for (const part of splitTopLevel(code, ';', true)) {
    if (part.trim().length === 0) continue;
    const classified = classifySegment(part);
    if (classified === null) return withheld();
    segments.push(classified);
  }
  if (segments.length === 0) return withheld();
  const first = segments[0];
  const last = segments[segments.length - 1];
  // A dangling pending declaration stands alone at the end of its slot.
  if (last.isPending && segments.length > 1) return withheld();
  // Statement-position gate: EVERY head requires a proven statement position
  // (the cell start, a previous content slot that ended at `;`/`}`, or a
  // previous positively completed statement). A dangling pending declaration
  // (`const <id> =` from the previous slot) licenses ONLY its own
  // initializer continuation — the awaited-call, declaration, pending and
  // token-free plain heads; an EMISSION head after a pending declaration is
  // the initializer expression, never a top-level emission of the slot, so
  // it withholds exactly like the joined layout. An unproven continuation —
  // an arrow body, a carried `new`, a member dot, an `if` head, the second
  // half of a split reference — withholds instead of asserting.
  const pendingContinuation = prefixPendingBinding !== null;
  if (!provenStart && !(pendingContinuation && first.kind !== 'emission')) {
    return withheld();
  }
  // A completion proven WITHOUT an explicit terminator (`;`/`}` — the
  // pinned-call or closed-emission productions) must additionally verify
  // the next content slot STARTS A NEW STATEMENT: its first significant
  // token is an identifier head (a declaration keyword, `await`, or an ASI
  // identifier expression). Any punctuation head (`[`, `(`, `.`, an
  // operator, a template literal, …) CONTINUES the previous expression —
  // the slot withholds instead of fabricating a standalone statement.
  if (provenStart && !provenByTerminator && !first.headTokenIsIdentifier) {
    return withheld();
  }
  // head: the FIRST segment's class; tool/argument: the LAST call-carrying
  // segment (the last-call-carrying-statement mirror rule); tail: the LAST
  // emission-carrying segment.
  const head = first.headClass;
  let tool = /** @type {ShapeToolClass} */ ('no-call');
  let argument = /** @type {ShapeArgumentClass} */ ('none');
  for (const segment of segments) {
    if (segment.tool !== 'no-call') { tool = segment.tool; argument = segment.argument; }
  }
  let tail = /** @type {ShapeTailClass} */ ('none');
  let tailIdentifier = null;
  let hasEmission = false;
  let emissionSegmentIndex = -1;
  for (const [index, segment] of segments.entries()) {
    if (segment.hasEmission) {
      tail = segment.tail;
      tailIdentifier = segment.tailIdentifier;
      hasEmission = true;
      emissionSegmentIndex = index;
    }
  }
  // Positional result bindings with the END-OF-SLOT binding state kept
  // separate from the binding consumed by the slot's own emission (a binding
  // declared after the slot's emission still binds a later final emission).
  /** @type {{ identifier: string, segmentIndex: number }[]} */
  const bindings = [];
  for (const [index, segment] of segments.entries()) {
    for (const identifier of segment.bindings) bindings.push({ identifier, segmentIndex: index });
  }
  const trailingBinding = bindings.length > 0 ? bindings[bindings.length - 1].identifier : null;
  let boundBinding = null;
  if (hasEmission) {
    for (const binding of bindings) {
      if (binding.segmentIndex < emissionSegmentIndex) boundBinding = binding.identifier;
    }
  } else {
    boundBinding = trailingBinding;
  }
  if (boundBinding === null && prefixPendingBinding !== null && first.startsWithAwait) {
    // A declaration SPLIT across slots (`const s =\nawait tools.…`): the
    // carried pending identifier binds this slot's call ONLY when the slot
    // itself STARTS the awaited initializer — a non-await continuation
    // (`const s =\n0; await …`) is never adopted, so the split and joined
    // layouts agree.
    boundBinding = prefixPendingBinding;
  }
  // A positively completed statement proves the next slot's start —
  // COMPLETION IS ONLY EVER ASSERTED FROM THE PINNED POSITIVE GRAMMAR: the
  // awaited-call and emission forms are anchored complete productions (the
  // emission requires a closed `text(…)`; the awaited-call/declaration
  // require a properly closed pinned `tools.<name>(…)` call), and the
  // slot-level `;`/`}` boundary is the other proof. ANY other tail — an
  // operator, a dot, `new`, an open paren, anything — leaves completion
  // unproven: a following line then withholds (it continues that
  // expression) instead of fabricating a standalone emission, and end of
  // input is truncation.
  const endsInCompleteStatement = (last.kind === 'declaration' || last.kind === 'awaited' || last.kind === 'emission') && last.expressionComplete;
  return { head, tool, argument, lexical: 'complete', tail, boundBinding, trailingBinding, tailIdentifier, hasEmission, pendingIdentifier: last.isPending ? last.pendingIdentifier : null, endsInCompleteStatement };
}

/**
 * Whether a masked line's significant last character is a proven
 * statement boundary (`;` or a `}`): the carried statement-position context
 * for the next content slot.
 * @param {string} masked
 */
function maskedEndsWithStatementBoundary(masked) {
  let cursor = masked.length - 1;
  while (cursor >= 0 && /\s/u.test(masked[cursor])) cursor -= 1;
  return cursor >= 0 && (masked[cursor] === ';' || masked[cursor] === '}');
}

/**
 * Decode one bounded wrapper argument literal — a verbatim in-memory port of
 * the existing grammar's literal decoder (JSON first, then the string-aware
 * JavaScript-literal fallback). The decoded VALUE never survives: callers use
 * only the verdict (and, in the preparation mirror, the version-value type).
 * @param {unknown} text
 * @returns {Record<string, unknown> | null}
 */
function decodeBoundedLiteralObject(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_SHAPE_ARGUMENT_CHARS) return null;
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

/** @param {string} text @returns {ShapeDirectiveClass} */
function directiveVerdict(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? 'valid' : 'invalid';
  } catch { return 'invalid'; }
}

/**
 * Whether one content line parses under the EXISTING grammar (verbatim mirror
 * of parseCallEvent's dispatch order: preparation, root control, then the
 * pinned wrapper/inline patterns with the directive re-parse, the argument
 * bound and the literal decode). Diagnosis only — never admission.
 * @param {string} line
 */
function existingLineParses(line) {
  const preparation = PREPARATION_PATTERN.exec(line);
  if (preparation !== null) {
    const envelope = decodeBoundedLiteralObject(preparation[2]);
    return envelope !== null && typeof envelope.version === 'number';
  }
  const rootControl = ROOT_CONTROL_WRAPPER_PATTERN.exec(line);
  if (rootControl !== null) return decodeBoundedLiteralObject(rootControl[2]) !== null;
  // The anchored bounded-name family (the real whole-body branch's response
  // for these single-line bodies; the §23.2 emission-junction divergence for
  // the pinned `r` spelling is unchanged below).
  const boundResult = BOUND_RESULT_WRAPPER_PATTERN.exec(line);
  if (boundResult !== null) return decodeBoundedLiteralObject(boundResult[3]) !== null;
  let source = line;
  const directiveMatch = DIRECTIVE_PATTERN.exec(source);
  if (directiveMatch !== null) {
    if (directiveVerdict(directiveMatch[1]) !== 'valid') return false;
    source = source.slice(directiveMatch[0].length);
  }
  const wrapper = WRAPPER_PATTERN.exec(source) ?? INLINE_WRAPPER_PATTERN.exec(source);
  if (wrapper === null) return false;
  if (wrapper[2].length > MAX_SHAPE_ARGUMENT_CHARS) return false;
  return decodeBoundedLiteralObject(wrapper[2]) !== null;
}

/**
 * Whether the WHOLE raw input parses under the existing per-line grammar
 * (verbatim mirror of parseCallStatements for a `custom_tool_call` input
 * string: directive strip, per-line split with the statement bound, blank
 * separators allowed only between statements, every content line through the
 * pinned statement parsers, directive validity through the framed probe).
 * @param {string} raw
 */
function existingGrammarAccepts(raw) {
  let source = raw;
  let prefix = '';
  const directive = DIRECTIVE_PATTERN.exec(source);
  if (directive !== null) { prefix = directive[0]; source = source.slice(prefix.length); }
  if (prefix !== '' && directiveVerdict(prefix.slice('// @exec: '.length, prefix.length - 1)) !== 'valid') return false;
  const lines = source.replace(/\n$/u, '').split('\n');
  if (lines.length === 0 || lines.length > MAX_SHAPE_STATEMENT_SLOTS) return false;
  let lastContentLine = -1;
  for (const [index, line] of lines.entries()) {
    if (line.trim().length > 0) lastContentLine = index;
  }
  if (lastContentLine === -1) return false;
  for (const [index, line] of lines.entries()) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      if (index > lastContentLine) return false;
      continue;
    }
    if (!existingLineParses(trimmedLine)) return false;
  }
  return true;
}

/**
 * Whether a content line matches a pinned statement skeleton by PATTERN ONLY
 * (argument bound/decode failures belong to the arguments stage below).
 * @param {string} rawLine
 */
function slotMatchesPinnedSkeleton(rawLine) {
  const preparation = PREPARATION_PATTERN.exec(rawLine);
  if (preparation !== null) {
    const envelope = decodeBoundedLiteralObject(preparation[2]);
    return envelope !== null && typeof envelope.version === 'number';
  }
  const rootControl = ROOT_CONTROL_WRAPPER_PATTERN.exec(rawLine);
  if (rootControl !== null) return decodeBoundedLiteralObject(rootControl[2]) !== null;
  const boundResult = BOUND_RESULT_WRAPPER_PATTERN.exec(rawLine);
  if (boundResult !== null) return decodeBoundedLiteralObject(boundResult[3]) !== null;
  const wrapper = WRAPPER_PATTERN.exec(rawLine) ?? INLINE_WRAPPER_PATTERN.exec(rawLine);
  return wrapper !== null;
}

/**
 * Whether a content line matched a pinned pattern but the existing grammar's
 * argument bound or literal decode rejected it (the raw-mirror arguments
 * stage — exactly the mechanical response, including rejects caused by raw
 * control characters or unsupported tokens inside the argument literal).
 * @param {string} rawLine
 */
function slotArgumentRejected(rawLine) {
  const preparation = PREPARATION_PATTERN.exec(rawLine);
  if (preparation !== null) {
    const envelope = decodeBoundedLiteralObject(preparation[2]);
    return envelope === null || typeof envelope.version !== 'number';
  }
  const rootControl = ROOT_CONTROL_WRAPPER_PATTERN.exec(rawLine);
  if (rootControl !== null) return decodeBoundedLiteralObject(rootControl[2]) === null;
  const boundResult = BOUND_RESULT_WRAPPER_PATTERN.exec(rawLine);
  if (boundResult !== null) return decodeBoundedLiteralObject(boundResult[3]) === null;
  const wrapper = WRAPPER_PATTERN.exec(rawLine) ?? INLINE_WRAPPER_PATTERN.exec(rawLine);
  if (wrapper === null) return false;
  return wrapper[2].length > MAX_SHAPE_ARGUMENT_CHARS || decodeBoundedLiteralObject(wrapper[2]) === null;
}

/**
 * Whether a content line starts like the pinned wrapper skeleton's head (the
 * binding and tool family exactly as WRAPPER_PATTERN pins them), so a failure
 * sits DOWNSTREAM of the wrapper stage.
 * @param {string} rawLine
 */
function slotHasWrapperHeadPrefix(rawLine) {
  return WRAPPER_HEAD_PREFIX_PATTERN.test(rawLine.trim());
}

/**
 * Diagnose which existing stage would respond to the input, in the frozen
 * stage order (wrapper → arguments → output → residual → directive). This is
 * a DIAGNOSIS of the mirrored grammar's mechanical response, never an
 * admission verdict: lexically broken lines and non-skeleton statements land
 * at the wrapper stage; pattern-matched-but-undecodable arguments and
 * established calls with a non-literal argument form land at the arguments
 * stage; a pinned-head wrapper with a missing or unpinned emission lands at
 * the output stage; unrecognizable content beyond a sayable first slot and
 * trailing blank formatting land at the residual stage.
 * @param {string} raw
 * @param {string[]} rawSlots the content lines
 * @param {ClassifiedSlot[]} slots the classified content slots
 * @param {boolean} trailingBlankFormatting
 * @param {ShapeDirectiveClass} directive
 * @returns {ShapeParserStageClass}
 */
function diagnoseParserStage(raw, rawSlots, slots, trailingBlankFormatting, directive) {
  if (existingGrammarAccepts(raw)) return 'parse-accepted';
  const firstRaw = rawSlots[0] ?? null;
  if (firstRaw === null) return 'unknown';
  if (!slotMatchesPinnedSkeleton(firstRaw) && !slotHasWrapperHeadPrefix(firstRaw)) return 'wrapper';
  // A lexically broken or unsupported-syntax slot never formed a sayable
  // statement: the existing grammar mechanically rejects that line at its
  // first (wrapper) stage.
  if (slots.some((slot) => slot.lexical !== 'complete')) return 'wrapper';
  if (rawSlots.some((line) => slotArgumentRejected(line))) return 'arguments';
  // The argument-form dimension: an established call whose argument is not a
  // decodable bounded literal-object (unsupported form or over the bound) is
  // the arguments family; a no-call slot ('none') is not.
  if (slots.some((slot) => (slot.argument === 'unsupported' || slot.argument === 'over-limit')
    && (slot.tool === 'exec_command' || slot.tool === 'other'))) return 'arguments';
  // The output dimension: a pinned-head wrapper slot whose pinned statement
  // form the existing grammar does not accept — a missing emission, an
  // unpinned emission form, or a RECOGNIZED emission with noncanonical
  // spacing (`text (r)`, the mechanical mirror's rejection).
  const outputStageFails = slots.some((slot, index) => !slotMatchesPinnedSkeleton(rawSlots[index])
    && slotHasWrapperHeadPrefix(rawSlots[index]));
  if (outputStageFails) return 'output';
  if (rawSlots.slice(1).some((line) => !slotMatchesPinnedSkeleton(line) && !slotHasWrapperHeadPrefix(line))) return 'residual';
  if (trailingBlankFormatting) return 'residual';
  if (directive === 'invalid') return 'directive';
  return 'unknown';
}

/**
 * Classify the raw call text into the frozen closed schema v1 (report
 * §15.1). Pure, bounded and non-evaluating: the input is only ever lexed,
 * never run. Coverage describes CLASSIFICATION coverage only and is never an
 * authorization to run or admit anything; `parse-accepted` diagnoses the
 * existing parser's response and never substitutes for it.
 * @param {unknown} raw the raw call string (memory-only; never persisted)
 * @param {'custom-tool-cell' | 'direct-arguments'} [callContext] which existing
 *   grammar the raw text was presented to: the wrapper-stage mirror diagnoses
 *   ONLY a custom-tool cell — for a direct function_call's arguments the
 *   verdict is withheld ('unknown'), so the persisted parserStage can never
 *   contradict the real parser's response for that call type
 * @returns {ShapeFacts}
 */
export function inspectCallShape(raw, callContext = 'custom-tool-cell') {
  try {
    return inspectCallShapeBody(raw, callContext);
  } catch {
    // The classifier never throws and never attaches input text to an error:
    // an unexpected internal failure degrades to the fixed closed result.
    return fixedOutOfScopeResult();
  }
}

/**
 * @param {unknown} raw
 * @param {'custom-tool-cell' | 'direct-arguments'} callContext
 * @returns {ShapeFacts}
 */
function inspectCallShapeBody(raw, callContext) {
  if (typeof raw !== 'string') return fixedOutOfScopeResult();
  // The directive verdict is read BEFORE anything else and only its verdict
  // is kept (keys never retained), mirroring the existing parser's read.
  let source = raw;
  let directive = /** @type {ShapeDirectiveClass} */ ('absent');
  const directiveMatch = DIRECTIVE_PATTERN.exec(source);
  if (directiveMatch !== null) {
    directive = directiveVerdict(directiveMatch[1]);
    source = source.slice(directiveMatch[0].length);
  }
  // Input byte bound (UTF-8): over-budget input drops the whole statement
  // facts behind the incomplete coverage marker — never truncated success.
  if (Buffer.byteLength(raw, 'utf8') > MAX_SHAPE_INPUT_BYTES) {
    const segments = source.replace(/\n$/u, '').split('\n');
    const counted = segments.filter((segment) => segment.trim().length > 0).length;
    return {
      version: 1,
      coverage: 'over-budget',
      statementCount: counted > MAX_SHAPE_STATEMENT_SLOTS ? 'over-limit' : counted,
      tool: 'unknown',
      head: 'unknown',
      tail: 'unknown',
      bindingEquality: 'unknown',
      parserStage: 'unknown',
      directive,
      wholeInputConsumed: false,
    };
  }
  // Statement slots: the newline split mirrors the existing per-line cell
  // splitter; blank separators between statements carry no content, and blank
  // segments after the last content statement are trailing formatting. The
  // WHOLE cell is lexed once with state carried across lines, so constructs
  // spanning newline slots cannot leak per-line syntax facts.
  const segments = source.replace(/\n$/u, '').split('\n');
  const lexedLines = lexCellLines(source);
  /** @type {string[]} */
  const rawSlots = [];
  /** @type {ClassifiedSlot[]} */
  const slots = [];
  // A line is FORMATTING (not a statement) when it is blank or trivia-only:
  // lexically complete with no masked code left (a comment-only line). A
  // formatting line carries NO statement node — skipped for the mirrors, the
  // statement count and whole-input coverage — while every carried context
  // survives it untouched. A line whose lexed view is blank but NOT complete
  // (an unterminated comment opener, a withheld remainder) is real
  // unrecognized content and stays an unknown-classified slot.
  /** @param {number} index @returns {boolean} */
  const isFormattingLine = (index) => {
    const lexed = lexedLines[index];
    return lexed.lexical === 'complete' && lexed.masked.trim().length === 0;
  };
  // The statement-position context carried across newline slots: a slot
  // starts in a proven statement position at the cell boundary, after a
  // previous content slot that ended at `;`/`}`, or after a previous
  // POSITIVELY COMPLETED statement (the declaration/awaited-call/emission
  // forms are anchored complete statements even without their optional
  // trailing `;` — the pinned pair form). Every other start — and the
  // continuation of a dangling pending declaration, which licenses only its
  // own initializer — is decided inside the slot classifier.
  let provenStart = true;
  let provenByTerminator = true;
  let pendingBinding = null;
  for (const [index, segment] of segments.entries()) {
    if (segment.trim().length === 0) continue;
    if (isFormattingLine(index)) continue;
    const lexed = lexedLines[index];
    rawSlots.push(segment);
    slots.push(classifyStatementSlot(lexed, provenStart, pendingBinding, provenByTerminator));
    const slot = slots[slots.length - 1];
    provenByTerminator = maskedEndsWithStatementBoundary(lexed.masked);
    provenStart = provenByTerminator || slot.endsInCompleteStatement;
    pendingBinding = slot.pendingIdentifier;
  }
  // EOF truncation (§15.1): end of input with an UNRESOLVED pending
  // declaration, or after a statement that proved nothing about its
  // completion (an unfinished expression tail, a fragment), is TRUNCATED
  // input — the initializer's or expression's continuation never arrived.
  // Truncated input never becomes success: the cell stays unknown/partial
  // with the input unconsumed and the relation withheld (uncertainty
  // propagates to bindingEquality). Trailing blank and comment-only
  // formatting lines do not resolve it; a genuine awaited continuation
  // resolves the pending inside the slot loop (pendingBinding clears), and
  // a positively completed statement sets provenStart for the next slot.
  const truncatedAtEnd = pendingBinding !== null || !provenStart;
  let lastContentIndex = -1;
  for (const [index, segment] of segments.entries()) {
    if (segment.trim().length > 0 && !isFormattingLine(index)) lastContentIndex = index;
  }
  const trailingBlankFormatting = rawSlots.length > 0 && lastContentIndex < segments.length - 1;
  if (rawSlots.length > MAX_SHAPE_STATEMENT_SLOTS) {
    return {
      version: 1,
      coverage: 'over-scope',
      statementCount: 'over-limit',
      tool: 'unknown',
      head: 'unknown',
      tail: 'unknown',
      bindingEquality: 'unknown',
      parserStage: 'unknown',
      directive,
      wholeInputConsumed: false,
    };
  }
  // Coverage is WHOLE-INPUT: any statement node that classified unknown
  // (broken or withheld → head 'unknown') leaves part of the input without a
  // sayable classification, and so does end-of-input truncation — coverage
  // is 'partial' and the input was not wholly consumed, never a
  // claimed-complete result.
  /** @param {ClassifiedSlot} slot */
  const unknownClassified = (slot) => slot.head === 'unknown' || slot.lexical !== 'complete';
  const anyUnknownClassified = slots.some(unknownClassified) || truncatedAtEnd;
  const coverage = /** @type {ShapeCoverageClass} */ (anyUnknownClassified ? 'partial' : 'complete');
  // Mirror fields: first statement's head, last statement's tail, and the
  // last established call-carrying statement's tool class.
  const head = slots.length > 0 ? slots[0].head : 'unknown';
  const tail = slots.length > 0 ? slots[slots.length - 1].tail : 'none';
  let tool = /** @type {ShapeToolClass} */ ('no-call');
  for (let index = slots.length - 1; index >= 0; index -= 1) {
    if (slots[index].tool !== 'no-call') { tool = slots[index].tool; break; }
  }
  // bindingEquality compares identifier equality only, and only against the
  // FINAL top-level emission: an EARLIER emission's matching identifier never
  // substitutes for the final emission's own argument, unknown-classified
  // slots AFTER the found emission mean the true final emission is inside
  // withheld content (relation 'unknown', never recovered from an earlier
  // emission), and only bindings at or before the final emission's own slot
  // are compared (a wrapper statement binds its result before emitting it in
  // the same slot). Spellings never leave this function.
  let finalEmissionSlot = -1;
  for (let index = slots.length - 1; index >= 0; index -= 1) {
    if (slots[index].hasEmission) { finalEmissionSlot = index; break; }
  }
  const finalEmissionUnclassifiedSuffix = finalEmissionSlot !== -1
    && slots.slice(finalEmissionSlot + 1).some(unknownClassified);
  const finalEmissionIdentifier = finalEmissionSlot !== -1 && !finalEmissionUnclassifiedSuffix
    ? slots[finalEmissionSlot].tailIdentifier
    : null;
  let boundBinding = null;
  let boundBindingSlot = -1;
  if (finalEmissionIdentifier !== null) {
    for (let index = finalEmissionSlot; index >= 0; index -= 1) {
      // The final emission slot consumes its own pre-emission binding; any
      // EARLIER slot contributes its END-OF-SLOT binding state (falling back
      // to a carried pending binding).
      const slot = slots[index];
      const candidate = index === finalEmissionSlot
        ? slot.boundBinding
        : (slot.trailingBinding ?? slot.boundBinding);
      if (candidate !== null) { boundBinding = candidate; boundBindingSlot = index; break; }
    }
  }
  // Uncertainty takes PRECEDENCE over identifier equality: an unknown-
  // classified slot between the binding and the final emission — or
  // end-of-input truncation (an unresolved pending declaration, an
  // unfinished expression) — forces the relation 'unknown' regardless of
  // slot layout.
  const unknownBetweenBindingAndFinal = finalEmissionIdentifier !== null && boundBindingSlot !== -1
    && slots.slice(boundBindingSlot, finalEmissionSlot + 1).some(unknownClassified);
  const bindingEquality = truncatedAtEnd || unknownBetweenBindingAndFinal
    ? 'unknown'
    : finalEmissionIdentifier !== null && boundBinding !== null
      ? (boundBinding === finalEmissionIdentifier ? 'equal' : 'not-equal')
      : (anyUnknownClassified ? 'unknown' : 'unrelated');
  // The wrapper-stage mirror diagnoses ONLY a custom-tool cell: for a direct
  // function_call's arguments the real parser answered through the
  // JSON-argument grammar, so the verdict is withheld rather than risk a
  // persisted diagnosis that contradicts the parser's response for the call
  // type.
  const parserStage = callContext === 'direct-arguments'
    ? /** @type {ShapeParserStageClass} */ ('unknown')
    : diagnoseParserStage(raw, rawSlots, slots, trailingBlankFormatting, directive);
  return {
    version: 1,
    coverage,
    statements: slots.map((slot) => ({ head: slot.head, tool: slot.tool, argument: slot.argument, lexical: slot.lexical, tail: slot.tail })),
    statementCount: slots.length,
    tool,
    head,
    tail,
    bindingEquality,
    parserStage,
    directive,
    wholeInputConsumed: coverage === 'complete',
  };
}
