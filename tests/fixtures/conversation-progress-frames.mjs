// @ts-nocheck
// Captured ZCode 0.16.1 v4 conversation wire shape. Keep field names exact.
export function conversationFrame({
  sessionId = 'session-1', subscriptionId = 'sub-1', deliveryKind = 'online',
  ordinal = 1, fromSeq = ordinal, toSeq = ordinal, deltas = [],
} = {}) {
  const topic = `conversation/${sessionId}`;
  return {
    method: 'v4/conversation/frame',
    params: {
      wireVersion: 3, kind: 'complete', deliveryKind,
      logicalFrameId: `frame-${ordinal}`, logicalFrameOrdinal: ordinal,
      topic, subscriptionId,
      frame: { topic, subscriptionId, fromSeq, toSeq, sentAt: '2026-08-09T00:00:00.000Z', payload: { kind: 'deltas', deltas } },
    },
  };
}

export function toolRow({ rowId = 1, toolCallId = `tool-${rowId}`, toolName = 'Bash', status = 'inputStreaming', input = {}, startedAt = '2026-08-09T00:00:00.000Z', endedAt } = {}) {
  return { op: 'row.upserted', row: { rowId, turnId: 'turn-1', createdAt: '2026-08-09T00:00:00.000Z', createdAtSeq: rowId, kind: 'toolCall', toolCallId, toolName, status, input, inputText: JSON.stringify(input), ...(startedAt === undefined ? {} : { startedAt }), ...(endedAt === undefined ? {} : { endedAt }) } };
}

export function turnRow({ rowId = 100, state = 'running' } = {}) {
  return { op: 'row.upserted', row: { rowId, turnId: 'turn-1', createdAt: '2026-08-09T00:00:00.000Z', createdAtSeq: rowId, kind: 'turnHeader', origin: 'userInput', state, startedAt: '2026-08-09T00:00:00.000Z' } };
}
