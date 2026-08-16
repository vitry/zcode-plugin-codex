// @ts-nocheck
import assert from 'node:assert/strict';

const markers = [
  ['foreground owner', 'Exactly one `exec_command` companion process may own the foreground Rescue execution'],
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

const initialCommand = 'invoke rescue';
const routeOpenings = Object.freeze({
  named: 'You are the installed ZCode Rescue forwarder.',
  generic: 'Act only as the installed ZCode Rescue forwarder.',
});

export function replaceLastInstalledLifecycleMarker(source, expected, replacement) {
  const index = source.lastIndexOf(expected);
  assert.ok(index >= 0, 'lifecycle mutation target must exist');
  return `${source.slice(0, index)}${replacement}${source.slice(index + expected.length)}`;
}

export function installedShortLifecycleDecoy() {
  return [...markers.slice(0, 10).map(([, marker]) => marker), markers.at(-1)[1]].join('\n');
}

export function installedLifecycleContractMutations(source, route) {
  const relayMarker = markers.find(([label]) => label === 'relay start')[1];
  const rawMarker = markers.find(([label]) => label === 'raw progress prohibition')[1];
  const rawAllowance = replaceLastInstalledLifecycleMarker(source, rawMarker, 'Relay detailed `[zcode]` lines and arbitrary stderr');
  const relocated = moveInstalledRelayAfterTerminal(source, route);
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

/** @param {string} source @param {{route:'named'|'generic', assertionPrefix?:string}} input */
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
  return { start, end, text: source.slice(start, end), positions: Object.fromEntries(positions.map(({ label, start: position }) => [label, position])) };
}

/** @param {string} source @param {'named'|'generic'} route @param {{assertionPrefix?:string}} [options] */
export function assertInstalledForwarderLifecycleContract(source, route, options = {}) {
  parseInstalledForwarderLifecycleContract(source, { route, assertionPrefix: options.assertionPrefix });
  return true;
}

export function moveInstalledRelayAfterTerminal(source, route) {
  const parsed = parseInstalledForwarderLifecycleContract(source, { route });
  const start = parsed.positions['relay start'];
  const end = parsed.positions['status boundary'];
  const terminal = parsed.positions['terminal return'];
  assert.ok(start >= parsed.start && end > start && terminal > end, `${route} relay mutation requires exact bounded lifecycle regions`);
  const relay = source.slice(start, end);
  return `${source.slice(0, start)}${source.slice(end, terminal)}${source.slice(terminal)}\n${relay}`;
}
