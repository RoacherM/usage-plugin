/**
 * Live recording. Model calls are observed around the stream itself (`llm/stream`), which also
 * sees calls that never reach a session log — compaction summaries and title generation — and
 * measures latency and time to first token. Tool calls and session titles come from the
 * session event feed, folded exactly like the log backfill folds them.
 */
import { createSessionFold, isFirstTokenChunk, usageFields } from './records.js';

/** Wrap one model stream; yields every chunk unchanged and records the call when it settles. */
export async function* observeStream(options, stream, record, now = Date.now) {
  const t = now();
  let firstToken;
  let usage;
  let finish;
  let thrown;
  try {
    for await (const chunk of stream) {
      if (firstToken === undefined && isFirstTokenChunk(chunk)) firstToken = now() - t;
      if (chunk?.type === 'usage') usage = { ...usage, ...chunk.usage };
      else if (chunk?.type === 'finish') finish = chunk.reason;
      yield chunk;
    }
  } catch (error) {
    thrown = error;
    throw error;
  } finally {
    try {
      let kind = finish?.kind;
      let code = finish?.failure?.code;
      if (!kind) {
        if (options?.signal?.aborted) kind = 'aborted';
        else if (thrown) { kind = 'error'; code = thrown?.code ?? thrown?.name ?? 'exception'; }
        else kind = 'aborted'; // the consumer stopped reading before the model finished
      }
      record({
        t, d: now() - t, ...(firstToken !== undefined ? { ft: firstToken } : {}),
        p: options?.provider ?? 'unknown', m: options?.model ?? 'unknown',
        ...(options?.sessionId ? { s: String(options.sessionId) } : {}),
        pu: options?.purpose ?? (options?.sessionId ? 'chat' : 'other'),
        ...usageFields(usage), f: kind, ...(kind === 'error' && code ? { e: String(code) } : {}), src: 'live',
      });
    } catch { /* recording must never break a model call */ }
  }
}

export function installRecorder(ctx, ledger) {
  ctx.on('llm/stream', (options, next) => observeStream(options, next(), ledger.addCall), { global: true });

  const folds = new Map();
  const foldFor = (id) => {
    let fold = folds.get(id);
    if (!fold) folds.set(id, (fold = createSessionFold(id, { emitTool: ledger.addTool })));
    return fold;
  };
  ctx.on('session/event', (session, event) => {
    try {
      const id = String(session?.id ?? '');
      if (!id) return;
      if (event.type === 'session/title' && event.data?.title) {
        const header = session.header ?? {};
        ledger.noteSession(id, { title: event.data.title, cwd: header.cwd, parent: header.parentSession, origin: header.origin, createdAt: header.createdAt });
      }
      if (event.type === 'tool/call' || event.type === 'tool/result' || event.type === 'turn/end') foldFor(id)(event);
    } catch { /* observers must not affect the session */ }
  });
  ctx.on('session/disposed', (session) => { folds.delete(String(session?.id ?? '')); });
}
