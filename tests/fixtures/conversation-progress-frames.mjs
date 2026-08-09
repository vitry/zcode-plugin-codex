// @ts-nocheck
// ZCode 0.16.1 bundle evidence (zcode.cjs): Mg=3; oo=z.number(); X5e complete
// wire requires the eight outer keys below; e9t requires the six inner keys;
// v9n row upserts are {op,row}; nE/RFt/vsa define these exact row fields and
// tool statuses inputStreaming|pendingApproval|running|success|error|cancelled.
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
      frame: { topic, subscriptionId, fromSeq, toSeq, sentAt: 1_786_233_600_000, payload: { kind: 'deltas', deltas } },
    },
  };
}

export function toolRow({ rowId = 1, toolCallId = `tool-${rowId}`, toolName = 'Bash', status = 'inputStreaming', input = {}, startedAt = 1_786_233_600_000, endedAt } = {}) {
  return { op: 'row.upserted', row: { rowId, turnId: 'turn-1', createdAt: 1_786_233_600_000, createdAtSeq: rowId, kind: 'toolCall', toolCallId, toolName, status, input, inputText: JSON.stringify(input), ...(startedAt === undefined ? {} : { startedAt }), ...(endedAt === undefined ? {} : { endedAt }) } };
}

export function turnRow({ rowId = 100, state = 'running' } = {}) {
  return { op: 'row.upserted', row: { rowId, turnId: 'turn-1', createdAt: 1_786_233_600_000, createdAtSeq: rowId, kind: 'turnHeader', origin: 'userInput', state, startedAt: 1_786_233_600_000 } };
}
