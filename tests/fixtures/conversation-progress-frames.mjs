// @ts-nocheck
// ZCode wire-v3 envelope evidence was originally recorded from 0.16.3 and was
// re-verified against the installed 0.16.5 zcode.cjs bundle and the controlled
// probe-v4-terminal.mjs run. Only fields consumed by these tests are asserted;
// upstream responses and events remain open-world.
export function conversationFrame({
  sessionId = 'session-1', subscriptionId = 'sub-1', deliveryKind = 'online',
  ordinal = 1, fromSeq = Math.max(0, ordinal - 1), toSeq = ordinal, deltas = [], snapshot,
} = {}) {
  const topic = `conversation/${sessionId}`;
  return {
    method: 'v4/conversation/frame',
    params: {
      wireVersion: 3, kind: 'complete', deliveryKind,
      logicalFrameId: `frame-${ordinal}`, logicalFrameOrdinal: ordinal,
      topic, subscriptionId,
      frame: {
        topic, subscriptionId, fromSeq, toSeq, sentAt: 1_786_233_600_000,
        payload: snapshot === undefined ? { kind: 'deltas', deltas } : { kind: 'snapshot', snapshot },
      },
    },
  };
}

// The snapshot body is deliberately opaque to the public progress projection.
// These neutral values preserve only the re-verified 0.16.5 key names and bounded
// JSON shape; tests must not turn private nested snapshot fields into a contract.
export function boundedSnapshotFixture(overrides = {}) {
  return {
    availability: {}, backgroundWorks: [],
    config: { provider: '', model: '', thought: '', thoughtLevels: [], followupMode: 'queue', mode: 'build' },
    control: {
      phase: 'draft', sessionEnded: false, canStop: false, stopState: 'idle',
      stopTargetKind: 'unknown', activeWorks: [], lastError: null, apiRetry: null,
    },
    goal: null, inputRouting: {}, logEpoch: 'epoch-1', meta: { title: '', titleSource: 'default' }, modelTransition: null,
    pendingCommands: [], pendingInteractions: [], plan: null, protocolVersion: 1,
    queue: { items: [], autoDrain: true }, revision: 1, rows: { firstRowId: null, totalCount: 0, window: [] },
    seq: 484, sessionId: 'session-1', subagents: { revision: 0, childSessionIds: [], running: [], endedTotal: 0 },
    usage: { contextWindow: null, cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    workspaceHookAdmission: null, ...overrides,
  };
}

export function toolRow({ rowId = 1, toolCallId = `tool-${rowId}`, toolName = 'Bash', status = 'inputStreaming', input = {}, startedAt = 1_786_233_600_000, endedAt } = {}) {
  return { op: 'row.upserted', row: { rowId, turnId: 'turn-1', createdAt: 1_786_233_600_000, createdAtSeq: rowId, kind: 'toolCall', toolCallId, toolName, status, input, inputText: JSON.stringify(input), ...(startedAt === undefined ? {} : { startedAt }), ...(endedAt === undefined ? {} : { endedAt }) } };
}

export function turnRow({ rowId = 100, state = 'running' } = {}) {
  return { op: 'row.upserted', row: { rowId, turnId: 'turn-1', createdAt: 1_786_233_600_000, createdAtSeq: rowId, kind: 'turnHeader', origin: 'userInput', state, startedAt: 1_786_233_600_000 } };
}

// Shape and lifecycle states observed by the controlled ZCode 0.16.5 terminal
// probe: userInput turnHeader running, followed by the same rowId/turnId in a
// terminal state. Synthetic variants in unit tests change only correlation data.
export function captured0165TurnRow({ rowId = 100, turnId = 'turn-1', origin = 'userInput', state = 'running' } = {}) {
  const delta = turnRow({ rowId, state });
  delta.row.turnId = turnId;
  delta.row.origin = origin;
  return delta;
}
