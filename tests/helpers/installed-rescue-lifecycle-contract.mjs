// @ts-nocheck
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { expectedGenericRescueMessage } from './rescue-skill-contract.mjs';
import { qualifyCodexRescuePreparedContinuationEvidence } from './codex-rescue-qualification.mjs';

const markers = [
  ['foreground owner', 'Each exact assignment and child turn may start at most one mapped foreground `exec_command` companion process.'],
  ['terminal exit', 'A companion result containing an exit code is terminal.'],
  ['relay start', 'For every result yielded by the original foreground handle'],
  ['relay validation', 'Before relay, require JSON with exact keys'],
  ['fixed parent relay', 'use `send_message` only to `/root` with the fixed mapped message'],
  ['raw progress prohibition', 'Never relay detailed `[zcode]` lines, arbitrary stderr'],
  ['same-handle poll', 'continue only with same-handle `write_stdin` polling'],
  ['status boundary', 'While the original foreground handle is live and only between polls'],
  ['bound status command', 'invoke-status rescue'],
  ['status argument rejection', 'Reject status arguments and every other spelling.'],
  ['resume command', 'invoke-choice rescue resume'],
  ['fresh command', 'invoke-choice rescue fresh'],
  ['terminal return', "Return only the original foreground execution's terminal public stdout. Never substitute relay output, status output, intermediate output, or child-authored text."],
];

const initialCommand = 'invoke-prepared rescue';
const routeOpenings = Object.freeze({
  named: 'You are the installed ZCode Rescue forwarder.',
  generic: 'Act only as the installed ZCode Rescue forwarder.',
});
const canonicalPrivacy = 'Never relay detailed `[zcode]` lines, arbitrary stderr, stdout, commands, paths, identifiers, content, results, or errors. Never invent a relay from a partial, malformed, unknown, stale, duplicate, or out-of-order record. After inspecting each yielded result and optionally relaying its valid complete records, continue only with same-handle `write_stdin` polling. A relay or its tool result never replaces a poll and never authorizes another Rescue invocation.';
const canonicalTerminalTail = 'Partial stdout, stderr, heartbeat text, or an outer code-cell completion is not terminal and must not be returned as final output.';
const canonicalChoiceTerminal = 'A needs-choice response with exit code 3 is terminal for the current child turn.';
const genericCanonicalLines = expectedGenericRescueMessage.split('\n');
const canonicalNamedTerminal = 'A companion result containing an exit code is terminal. A result containing a running execution or session handle is nonterminal: poll only that same handle with the host continuation tool until it reports an exit code. Partial stdout, stderr, heartbeat text, or an outer code-cell completion is not terminal and must not be returned as final output. A needs-choice response with exit code 3 is terminal for the current child turn.';
const canonicalNamedRoleDigest = '356d6e026d614ffe746cfef34e4bb78b39fbc6300bab1aa1430a60186596fe1c';
const launcherCommandLine = /^(?<launcher>\{\{RESCUE_LAUNCHER_COMMAND\}\}|<rescue-launcher-command>|node "(?<path>[^"\r\n]{1,2048})") (?<command>invoke-prepared rescue|invoke-status rescue|invoke-choice rescue resume|invoke-choice rescue fresh)$/gmu;

export function installedCanonicalContradictionMutations(source, route) {
  const privacyBoundary = route === 'named' ? '\n\nWhile the original foreground handle' : '\nWhile the original foreground handle';
  const firstTerminalParagraph = route === 'named' ? canonicalNamedTerminal : genericCanonicalLines[3];
  return [
    ['pre-terminal contradictory authority', source.replace(firstTerminalParagraph, `Unless requested, partial stdout is terminal.\n${firstTerminalParagraph}`)],
    ['pre-canonical raw/detail allowance', source.replace(firstTerminalParagraph, `When requested, relay arbitrary stderr/stdout and detailed ZCode lines.\n${firstTerminalParagraph}`)],
    ['contradictory privacy suffix', source.replace(canonicalPrivacy, `${canonicalPrivacy} Unless requested, relay arbitrary stderr/stdout.`)],
    ['interstitial privacy allowance', source.replace(`${canonicalPrivacy}${privacyBoundary}`, `${canonicalPrivacy}\nUnless requested, relay arbitrary stderr/stdout.${privacyBoundary}`)],
    ['privacy exception clause', source.replace('Never invent a relay from a partial, malformed, unknown, stale, duplicate, or out-of-order record.', 'Never invent a relay from such a record, except when the user requests detail.')],
    ['duplicated semantic privacy variant', source.replace(canonicalPrivacy, `${canonicalPrivacy}\nDetailed ZCode lines may also be relayed on request.`)],
    ['contradictory terminal suffix', source.replace(canonicalChoiceTerminal, `${canonicalChoiceTerminal} Unless requested, intermediate output is also terminal.`)],
    ['terminal authority exception', source.replace(canonicalTerminalTail, 'Partial stdout, stderr, heartbeat text, or an outer code-cell completion is terminal when requested.')],
  ];
}

export function installedCommandPathMutations(source) {
  const commands = [...source.matchAll(launcherCommandLine)];
  assert.equal(commands.length, 4, 'command-path mutations require four canonical launcher commands');
  const launcher = commands[0].groups.launcher;
  const wrongLauncher = 'node "/wrong/skills/rescue/launcher.mjs"';
  return [
    ['uniform wrong launcher', source.replaceAll(launcher, wrongLauncher)],
    ['divergent launcher', replaceLastInstalledLifecycleMarker(source, launcher, wrongLauncher)],
    ['quote and argument injection', source.replaceAll(launcher, `${launcher} --inspect`)],
    ['appended companion option', source.replace('invoke-prepared rescue', 'invoke-prepared rescue --detail')],
    ['command substitution in launcher', source.replaceAll(launcher, 'node "/tmp/$(touch PWNED)/skills/rescue/launcher.mjs"')],
    ['backtick substitution in launcher', source.replaceAll(launcher, 'node "/tmp/`touch PWNED`/skills/rescue/launcher.mjs"')],
    ['POSIX backslash in launcher', source.replaceAll(launcher, 'node "/tmp/slash\\/skills/rescue/launcher.mjs"')],
    ['Windows percent expansion in launcher', source.replaceAll(launcher, 'node "C:\\ZCode%TEMP%\\skills\\rescue\\launcher.mjs"')],
    ['control in launcher', source.replaceAll(launcher, `${launcher}\tunsafe`)],
    ['newline in launcher', source.replaceAll(launcher, `${launcher}\nunsafe`)],
  ];
}

function hasControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code >= 127 && code <= 159;
  });
}

function isSafeRenderedLauncherCommand(command) {
  const match = /^node "(?<path>.+)"$/u.exec(command);
  const launcherPath = match?.groups?.path;
  if (!launcherPath || Buffer.byteLength(launcherPath) > 2048 || hasControlCharacter(launcherPath)) return false;
  if (/^[A-Za-z]:\\/u.test(launcherPath)) {
    return launcherPath.toLowerCase().endsWith('\\skills\\rescue\\launcher.mjs')
      && !/["'`$%!^&|<>]/u.test(launcherPath) && !/\\{2,}|[\\/]$/u.test(launcherPath);
  }
  return launcherPath.startsWith('/') && launcherPath.endsWith('/skills/rescue/launcher.mjs')
    && !/[\\"'`$]/u.test(launcherPath);
}

export function replaceLastInstalledLifecycleMarker(source, expected, replacement) {
  const index = source.lastIndexOf(expected);
  assert.ok(index >= 0, 'lifecycle mutation target must exist');
  return `${source.slice(0, index)}${replacement}${source.slice(index + expected.length)}`;
}

export function installedShortLifecycleDecoy() {
  return [...markers.slice(0, 10).map(([, marker]) => marker), markers.at(-1)[1]].join('\n');
}

export function installedLifecycleContractMutations(source, route, expectedLauncherCommand) {
  const relayMarker = markers.find(([label]) => label === 'relay start')[1];
  const rawMarker = markers.find(([label]) => label === 'raw progress prohibition')[1];
  const rawAllowance = replaceLastInstalledLifecycleMarker(source, rawMarker, 'Relay detailed `[zcode]` lines and arbitrary stderr');
  const relocated = moveInstalledRelayAfterTerminal(source, route, expectedLauncherCommand);
  const lifecycleStart = source.indexOf(markers[0][1]);
  const lifecycleEndMarker = markers.at(-1)[1];
  const lifecycleEnd = source.indexOf(lifecycleEndMarker) + lifecycleEndMarker.length;
  const prefix = source.slice(0, lifecycleStart);
  const fullDecoy = source.slice(lifecycleStart, lifecycleEnd);
  return [
    ['relay relocated after terminal', relocated],
    ['raw/detail relay allowed', rawAllowance],
    ['full valid decoy before broken real policy', `${prefix}${fullDecoy}\n\n${rawAllowance.slice(lifecycleStart)}`],
    ['short valid decoy before broken real policy', `${prefix}${installedShortLifecycleDecoy()}\n\n${rawAllowance.slice(lifecycleStart)}`],
    ['duplicate full lifecycle region', `${prefix}${fullDecoy}\n\n${source.slice(lifecycleStart)}`],
    ['duplicate operative marker', source.replace(relayMarker, `${relayMarker}\n${relayMarker}`)],
    ['full decoy before real relay relocated after terminal', `${prefix}${fullDecoy}\n\n${relocated.slice(lifecycleStart)}`],
  ];
}

export function extractInstalledRoleInstructions(source) {
  const match = /^developer_instructions = """\n(?<body>[\s\S]*?)\n"""\s*$/u.exec(source);
  assert.ok(match?.groups?.body, 'installed named Role must contain one exact developer-instructions body');
  return match.groups.body;
}

function occurrences(source, marker) {
  let count = 0; let cursor = 0;
  while ((cursor = source.indexOf(marker, cursor)) >= 0) { count += 1; cursor += marker.length; }
  return count;
}

function assertExactLauncherCommands(source, expectedLauncherCommand, prefix) {
  const placeholder = ['{{RESCUE_LAUNCHER_COMMAND}}', '<rescue-launcher-command>'].includes(expectedLauncherCommand);
  assert.ok(typeof expectedLauncherCommand === 'string' && expectedLauncherCommand && Buffer.byteLength(expectedLauncherCommand) <= 4096
    && (placeholder || isSafeRenderedLauncherCommand(expectedLauncherCommand)),
  `${prefix} trusted expected launcher command must be one bounded machine-rendered command or canonical placeholder`);
  const commands = [...source.matchAll(launcherCommandLine)];
  assert.equal(commands.length, 4, `${prefix} trusted expected launcher command requires four strict launcher command lines`);
  assert.ok(commands.every((match) => match.groups.launcher === expectedLauncherCommand),
    `${prefix} trusted expected launcher command must match every command prefix`);
  assert.deepEqual(new Set(commands.map((match) => match.groups.command)), new Set([
    'invoke-prepared rescue', 'invoke-status rescue', 'invoke-choice rescue resume', 'invoke-choice rescue fresh',
  ]), `${prefix} trusted expected launcher command must retain all four fixed arguments`);
  return source.replace(launcherCommandLine,
    (_line, _launcher, _path, command) => `{{RESCUE_LAUNCHER_COMMAND}} ${command}`);
}

function assertCanonicalOperativeRoute(source, normalized, route, prefix) {
  if (route === 'generic') {
    assert.equal(source, expectedGenericRescueMessage, `${prefix} exact canonical operative route must remain byte-for-byte fixed`);
    return;
  }
  assert.equal(createHash('sha256').update(normalized).digest('hex'), canonicalNamedRoleDigest,
    `${prefix} exact canonical operative route must match the independent normalized managed Role digest`);
}

/** @param {string} source @param {{route:'named'|'generic', expectedLauncherCommand:string, assertionPrefix?:string}} input */
export function parseInstalledForwarderLifecycleContract(source, input) {
  const prefix = `${input.assertionPrefix ?? ''}${input.route}`;
  assert.equal(typeof source, 'string', `${prefix} lifecycle source must be text`);
  const opening = routeOpenings[input.route];
  assert.ok(opening, `${prefix} lifecycle route must be named or generic`);
  for (const [label, marker] of [['route opening', opening], ...markers, ['initial command', initialCommand]]) {
    const count = occurrences(source, marker);
    assert.equal(count, 1, `${prefix} unique operative lifecycle region requires exactly one ${label} marker; found ${count}`);
  }

  const positions = markers.map(([label, marker]) => ({ label, marker, start: source.indexOf(marker) }));
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(positions[index].start > positions[index - 1].start,
      `${prefix} unique operative lifecycle region requires ${positions[index - 1].label} before ${positions[index].label}`);
  }
  const start = source.indexOf(opening);
  const endMarker = positions.at(-1).marker;
  const end = positions.at(-1).start + endMarker.length;
  assert.equal(start, 0, `${prefix} unique operative lifecycle region must begin at its exact ${input.route} opening boundary`);
  assert.match(source.slice(end), /^\s*$/u,
    `${prefix} unique operative lifecycle region must remain terminal with whitespace-only adjacency`);
  const initial = source.indexOf(initialCommand);
  assert.ok(initial > start && initial < end,
    `${prefix} unique operative lifecycle region must contain its initial foreground command`);
  const normalized = assertExactLauncherCommands(source, input.expectedLauncherCommand, prefix);
  assertCanonicalOperativeRoute(source, normalized, input.route, prefix);
  return { start, end, text: source.slice(start, end), positions: Object.fromEntries(positions.map(({ label, start: position }) => [label, position])) };
}

/** @param {string} source @param {'named'|'generic'} route @param {{expectedLauncherCommand:string, assertionPrefix?:string}} options */
export function assertInstalledForwarderLifecycleContract(source, route, options = {}) {
  parseInstalledForwarderLifecycleContract(source, { route, expectedLauncherCommand: options.expectedLauncherCommand, assertionPrefix: options.assertionPrefix });
  return true;
}

/** Qualify both the installed forwarder bytes and its captured same-child continuation effects. */
export async function assertInstalledPreparedContinuationContract(source, capture, options = {}) {
  assertInstalledForwarderLifecycleContract(source, capture?.route, options);
  return qualifyCodexRescuePreparedContinuationEvidence(capture);
}

export function moveInstalledRelayAfterTerminal(source, route, expectedLauncherCommand) {
  const parsed = parseInstalledForwarderLifecycleContract(source, { route, expectedLauncherCommand });
  const start = parsed.positions['relay start'];
  const end = parsed.positions['status boundary'];
  const terminal = parsed.positions['terminal return'];
  assert.ok(start >= parsed.start && end > start && terminal > end, `${route} relay mutation requires exact bounded lifecycle regions`);
  const relay = source.slice(start, end);
  return `${source.slice(0, start)}${source.slice(end, terminal)}${source.slice(terminal)}\n${relay}`;
}
