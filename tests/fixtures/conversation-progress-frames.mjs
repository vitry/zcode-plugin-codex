// @ts-nocheck
// ZCode 0.16.3 bundle evidence (zcode.cjs): wire version 3 complete frames use
// the eight outer and six inner keys below. Snapshot frames use the bounded
// protocol-version-1 body fixture; delta frames use the five production ops.
// Tool rows retain these exact lifecycle fields and status values.
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
// These neutral values preserve only the captured 0.16.3 key names and bounded
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
