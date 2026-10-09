/**
 * Record shapes (short keys: there can be hundreds of thousands of lines).
 *
 *   call: { t, d?, ft?, p, m, s?, pu, in, out, cr, cw, rs, tot, f, e?, src }
 *         t start (ms) · d duration · ft time to first token · p provider · m model · s session
 *         pu purpose (chat | compaction | session-title | other) · f finish kind · e error code
 *         in uncached input · cr cache read · cw cache write · out output · rs reasoning (part of out)
 *         src live | log
 *   tool: { t, s?, n, err?, code?, d? }
 */

const int = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0);

/** DSH's TokenUsage → record fields. `inputTokens` excludes cache reads and writes. */
export function usageFields(usage) {
  const u = usage ?? {};
  const fields = { in: int(u.inputTokens), out: int(u.outputTokens), cr: int(u.cacheReadTokens), cw: int(u.cacheWriteTokens), rs: int(u.reasoningTokens) };
  fields.tot = int(u.totalTokens) || fields.in + fields.out + fields.cr + fields.cw;
  return fields;
}

const FIRST_TOKEN = new Set(['text-delta', 'reasoning-delta', 'tool-call-delta', 'block-start']);
export const isFirstTokenChunk = (chunk) => FIRST_TOKEN.has(chunk?.type);

/** The finish reason a recorded assistant stream ended with, if it kept the chunk. */
function streamFinish(stream) {
  for (let i = (stream?.length ?? 0) - 1; i >= 0; i--) {
    const record = stream[i];
    if (record?.type === 'chunk' && record.chunk?.type === 'finish') return record.chunk.reason;
  }
  return undefined;
}
const streamStart = (stream) => { const first = stream?.[0]; return first?.time0 ?? first?.time; };

/**
 * Follow one session's events in order and emit records. Live mode passes `calls: false` (model
 * calls are recorded around the stream itself); the log backfill reads calls from the log.
 */
export function createSessionFold(sessionId, { emitTool, emitCall, calls = false, before = Infinity } = {}) {
  const pending = new Map();
  let stepStart;
  let lastEventTime;
  let context = {};

  return function fold(event) {
    if (!event || typeof event.type !== 'string') return;
    const time = event.time;
    const data = event.data ?? {};
    switch (event.type) {
      case 'request/context': context = { p: data.provider, m: data.model }; break;
      case 'step/start': stepStart = time; break;
      case 'tool/call':
        if (time < before) pending.set(data.callId, { t: time, n: data.name });
        break;
      case 'tool/result': {
        const id = data.message?.toolCallId;
        const call = pending.get(id);
        if (!call) break;
        pending.delete(id);
        const failed = data.error !== undefined || data.message?.isError === true;
        emitTool?.({ t: call.t, s: sessionId, n: call.n, ...(failed ? { err: 1, code: data.error?.code } : {}), d: Math.max(0, time - call.t) }, id);
        break;
      }
      case 'assistant/message': {
        if (!calls || time >= before) break;
        const source = data.message?.source ?? {};
        const start = stepStart ?? lastEventTime ?? time;
        const first = streamStart(data.stream);
        const finish = streamFinish(data.stream)?.kind ?? (data.interrupted ? 'aborted' : undefined);
        emitCall?.({
          t: start, d: Math.max(0, time - start), ...(first !== undefined && first >= start ? { ft: first - start } : {}),
          p: source.provider ?? context.p ?? 'unknown', m: source.model ?? context.m ?? 'unknown', s: sessionId, pu: 'chat',
          ...usageFields(data.usage), f: finish ?? 'stop', src: 'log',
        }, data.message?.id);
        stepStart = undefined;
        break;
      }
      case 'turn/end': {
        // A turn that ended on a model error has no assistant message for the failed request.
        if (calls && time < before && data.reason?.kind === 'error' && data.reason.error) {
          const start = stepStart ?? lastEventTime ?? time;
          emitCall?.({
            t: start, d: Math.max(0, time - start), p: context.p ?? 'unknown', m: context.m ?? 'unknown', s: sessionId, pu: 'chat',
            ...usageFields(undefined), f: 'error', e: String(data.reason.error.code ?? 'error'), src: 'log',
          }, `${sessionId}#turn-error#${event.seq}`);
        }
        stepStart = undefined;
        pending.clear();
        break;
      }
      default: break;
    }
    lastEventTime = time;
  };
}
