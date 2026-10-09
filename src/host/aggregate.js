/**
 * Pure aggregation of ledger records for one time range, in the viewer's time zone.
 *
 * Bucket times are returned as "local epoch" milliseconds (wall-clock time encoded as if it were
 * UTC), so the page formats them with getUTC* and never re-applies its own zone.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;
export const RANGES = ['today', '7d', '30d', '90d', 'all'];
export const TOP_MODELS = 6;
/** Tools whose time is spent waiting for the user, not working. */
export const WAIT_TOOLS = new Set(['ask_user_question', 'exit_plan_mode']);
/** Thresholds for the "worth knowing" notes. */
export const CONTEXT_WARN = 400_000;
const REBUILD_MIN = 20_000;
const CACHE_TTL = 5 * 60_000;
const IDLE_NOTE_MIN = 200_000;
const FAIL_NOTE_MIN = 5;

const promptOf = (call) => (call.in ?? 0) + (call.cr ?? 0) + (call.cw ?? 0);

export const modelKey = (p, m) => `${p}|${m}`;

export function zoneOffset(timeZone) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  const cache = new Map();
  // Offsets only change on hour boundaries (DST), so one lookup per hour is enough.
  return (t) => {
    const hour = Math.floor(t / HOUR);
    let offset = cache.get(hour);
    if (offset === undefined) {
      const parts = {};
      for (const part of fmt.formatToParts(new Date(hour * HOUR))) parts[part.type] = part.value;
      offset = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute) - hour * HOUR;
      cache.set(hour, offset);
    }
    return offset;
  };
}

/** Start of the local day containing `t`, as a real epoch time. */
function localDayStart(t, offset) {
  const local = t + offset(t);
  const day = Math.floor(local / DAY) * DAY;
  return day - offset(day - offset(t));
}

/** { from, to, bucket, prevFrom } for a range name. */
export function resolveRange(range, { now = Date.now(), offset, earliest }) {
  const today = localDayStart(now, offset);
  const days = { today: 1, '7d': 7, '30d': 30, '90d': 90 }[range];
  if (days) {
    const from = days === 1 ? today : localDayStart(today - (days - 1) * DAY + 12 * HOUR, offset);
    return { from, to: now, bucket: days === 1 ? 'hour' : 'day', prevFrom: from - (now - from) };
  }
  const from = earliest !== undefined ? localDayStart(earliest, offset) : today;
  const span = (now - from) / DAY;
  return { from, to: now, bucket: span > 180 ? 'week' : 'day', prevFrom: undefined };
}

function bucketStart(t, bucket, offset) {
  const local = t + offset(t);
  if (bucket === 'hour') return Math.floor(local / HOUR) * HOUR;
  const day = Math.floor(local / DAY) * DAY;
  if (bucket === 'day') return day;
  const weekday = (new Date(day).getUTCDay() + 6) % 7; // Monday-based weeks
  return day - weekday * DAY;
}
const nextBucket = (at, bucket) => at + (bucket === 'hour' ? HOUR : bucket === 'day' ? DAY : 7 * DAY);

const emptyTotals = () => ({ calls: 0, errors: 0, aborted: 0, in: 0, out: 0, cr: 0, cw: 0, rs: 0, tot: 0, gOut: 0, gMs: 0, fts: [], dSum: 0, dN: 0, ftSum: 0, ftN: 0 });
function addCall(target, call) {
  target.calls++;
  if (call.f === 'error') target.errors++;
  if (call.f === 'aborted') target.aborted++;
  target.in += call.in ?? 0; target.out += call.out ?? 0; target.cr += call.cr ?? 0; target.cw += call.cw ?? 0; target.rs += call.rs ?? 0; target.tot += call.tot ?? 0;
  if (call.f !== 'error' && Number.isFinite(call.d)) { target.dSum += call.d; target.dN++; }
  if (Number.isFinite(call.ft)) { target.ftSum += call.ft; target.ftN++; target.fts.push(call.ft); }
  // Generation speed: output over the time after the first token, from calls long enough to measure.
  if (call.f !== 'error' && (call.out ?? 0) >= 50 && call.d > 0) { target.gOut += call.out; target.gMs += Math.max(1, call.d - (call.ft ?? 0)); }
}
function finishTotals(t) {
  const { dSum, dN, ftSum, ftN, gOut, gMs, fts, ...rest } = t;
  const prompt = t.in + t.cr + t.cw;
  fts.sort((a, b) => a - b);
  return {
    ...rest, avgMs: dN ? Math.round(dSum / dN) : undefined, avgTtft: ftN ? Math.round(ftSum / ftN) : undefined, cacheRate: prompt ? t.cr / prompt : undefined,
    avgPrompt: t.calls - t.errors > 0 ? Math.round(prompt / (t.calls - t.errors)) : undefined,
    speed: gMs ? Math.round(gOut / (gMs / 1000)) : undefined, ttftMed: fts.length ? fts[fts.length >> 1] : undefined,
  };
}
const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : undefined);

/**
 * @param input.calls / input.tools  ledger records (any order)
 * @param input.sessions             { [id]: { title, cwd, parent, origin } }
 * @param input.filter               optional model key (provider|model): everything is limited to it
 */
export function aggregate({ calls, tools, sessions = {}, range = '7d', timeZone = 'UTC', filter, now = Date.now(), recent = 60 }) {
  const offset = zoneOffset(timeZone);
  let earliest;
  for (const call of calls) if (earliest === undefined || call.t < earliest) earliest = call.t;
  const { from, to, bucket, prevFrom } = resolveRange(RANGES.includes(range) ? range : '7d', { now, offset, earliest });
  const matches = (call) => !filter || modelKey(call.p, call.m) === filter;

  const inRange = [];
  const prev = emptyTotals();
  for (const call of calls) {
    if (!matches(call)) continue;
    if (call.t >= from && call.t <= to) inRange.push(call);
    else if (prevFrom !== undefined && call.t >= prevFrom && call.t < from) addCall(prev, call);
  }
  inRange.sort((a, b) => a.t - b.t);

  const totals = emptyTotals();
  const models = new Map();
  const bySession = new Map();
  const purposes = {};
  const errorCodes = {};
  const hours = Array.from({ length: 24 }, () => ({ calls: 0, tot: 0 }));
  const durations = [];
  let modelMs = 0;
  const lastEnd = new Map();
  const idle = { calls: 0, tokens: 0 };
  for (const call of inRange) {
    if (Number.isFinite(call.d)) modelMs += call.d;
    // A large cache write after the session sat idle past the cache lifetime: context re-cached.
    if (call.s && call.f !== 'error') {
      const end = lastEnd.get(call.s);
      if (end !== undefined && call.t - end > CACHE_TTL && (call.cw ?? 0) > REBUILD_MIN && call.cw > promptOf(call) / 2) { idle.calls++; idle.tokens += call.cw; }
      lastEnd.set(call.s, call.t + (call.d ?? 0));
    }
    addCall(totals, call);
    const key = modelKey(call.p, call.m);
    let model = models.get(key);
    if (!model) models.set(key, (model = { key, provider: call.p, model: call.m, ...emptyTotals(), lastAt: 0, sources: {} }));
    addCall(model, call);
    model.lastAt = Math.max(model.lastAt, call.t);
    model.sources[call.src ?? 'live'] = (model.sources[call.src ?? 'live'] ?? 0) + 1;
    const purpose = call.pu ?? 'chat';
    purposes[purpose] ??= { calls: 0, tot: 0 };
    purposes[purpose].calls++; purposes[purpose].tot += call.tot ?? 0;
    if (call.f === 'error') errorCodes[call.e ?? 'error'] = (errorCodes[call.e ?? 'error'] ?? 0) + 1;
    const hour = new Date(call.t + offset(call.t)).getUTCHours();
    hours[hour].calls++; hours[hour].tot += call.tot ?? 0;
    if (call.f !== 'error' && Number.isFinite(call.d)) durations.push(call.d);
    if (call.s) {
      let session = bySession.get(call.s);
      if (!session) bySession.set(call.s, (session = { id: call.s, ...emptyTotals(), lastAt: 0, models: new Set(), ctxFirst: undefined, ctxPeak: 0 }));
      addCall(session, call);
      if (call.f !== 'error' && (call.pu ?? 'chat') === 'chat') {
        session.ctxFirst ??= promptOf(call);
        session.ctxPeak = Math.max(session.ctxPeak, promptOf(call));
      }
      session.lastAt = Math.max(session.lastAt, call.t);
      session.models.add(call.m);
    }
  }
  durations.sort((a, b) => a - b);

  const modelList = [...models.values()].map(finishTotals).sort((a, b) => b.tot - a.tot || b.calls - a.calls);
  const topKeys = modelList.slice(0, TOP_MODELS).map((m) => m.key);
  const seriesKeys = modelList.length > TOP_MODELS ? [...topKeys, 'other'] : topKeys;
  const slot = new Map(seriesKeys.map((key, i) => [key, i]));

  // Contiguous buckets from the range start to now, filled with zeros where nothing happened.
  const series = [];
  const index = new Map();
  for (let at = bucketStart(from, bucket, offset), end = bucketStart(to, bucket, offset); at <= end; at = nextBucket(at, bucket)) {
    index.set(at, series.length);
    series.push({ at, tok: seriesKeys.map(() => 0), calls: seriesKeys.map(() => 0), errors: 0 });
    if (series.length > 800) break;
  }
  for (const call of inRange) {
    const row = series[index.get(bucketStart(call.t, bucket, offset))];
    if (!row) continue;
    const i = slot.get(modelKey(call.p, call.m)) ?? slot.get('other');
    if (i !== undefined) { row.tok[i] += call.tot ?? 0; row.calls[i]++; }
    if (call.f === 'error') row.errors++;
  }

  const toolRows = new Map();
  let toolCalls = 0;
  let toolErrors = 0;
  let toolMs = 0;
  let waitMs = 0;
  const failures = new Map();
  const sessionsInRange = filter ? new Set(bySession.keys()) : undefined;
  for (const tool of tools) {
    if (tool.t < from || tool.t > to) continue;
    if (sessionsInRange && !sessionsInRange.has(tool.s)) continue;
    let row = toolRows.get(tool.n);
    if (!row) toolRows.set(tool.n, (row = { name: tool.n, calls: 0, errors: 0, dSum: 0, dN: 0, codes: {} }));
    row.calls++; toolCalls++;
    if (tool.err) { row.errors++; toolErrors++; if (tool.code) row.codes[tool.code] = (row.codes[tool.code] ?? 0) + 1; }
    if (Number.isFinite(tool.d)) {
      row.dSum += tool.d; row.dN++;
      if (WAIT_TOOLS.has(tool.n)) waitMs += tool.d; else toolMs += tool.d;
    }
    if (tool.err) { const key = `${tool.n}\u0000${tool.code ?? ''}`; failures.set(key, (failures.get(key) ?? 0) + 1); }
  }
  const toolList = [...toolRows.values()]
    .map(({ dSum, dN, codes, ...row }) => ({ ...row, avgMs: dN ? Math.round(dSum / dN) : undefined, topError: Object.entries(codes).sort((a, b) => b[1] - a[1])[0]?.[0] }))
    .sort((a, b) => b.calls - a.calls);

  const describe = (id) => {
    const info = sessions[id] ?? {};
    return { title: info.title, cwd: info.cwd, origin: info.origin, parent: info.parent };
  };
  const sessionList = [...bySession.values()]
    .map((s) => ({ ...finishTotals(s), models: [...s.models], ...describe(s.id) }))
    .sort((a, b) => b.tot - a.tot)
    .slice(0, 20);

  const recentCalls = inRange.slice(-recent).reverse().map((call) => ({
    ...call, title: call.s ? sessions[call.s]?.title : undefined, origin: call.s ? sessions[call.s]?.origin : undefined,
  }));

  // A few plain-language notes, only when something is worth acting on.
  const notes = [];
  const bloated = [...bySession.values()].filter((s) => s.ctxPeak >= CONTEXT_WARN).sort((a, b) => b.ctxPeak - a.ctxPeak);
  if (bloated.length) {
    const top = bloated[0];
    notes.push({ kind: 'context', session: top.id, title: sessions[top.id]?.title, first: top.ctxFirst, peak: top.ctxPeak, calls: top.calls, others: bloated.length - 1 });
  }
  if (idle.tokens >= IDLE_NOTE_MIN) notes.push({ kind: 'cacheIdle', calls: idle.calls, tokens: idle.tokens, share: totals.cw ? idle.tokens / totals.cw : undefined });
  const [failKey, failCount] = [...failures.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (failCount >= FAIL_NOTE_MIN) { const [tool, code] = failKey.split('\u0000'); notes.push({ kind: 'toolFail', tool, code: code || undefined, count: failCount }); }

  // A year of daily totals for the activity board, Monday-first weeks ending today (range-independent).
  const today = bucketStart(now, 'day', offset);
  const startDay = today - (52 * 7 + (new Date(today).getUTCDay() + 6) % 7) * DAY;
  const days = Math.round((today - startDay) / DAY) + 1;
  const activity = { start: startDay, tot: new Array(days).fill(0), calls: new Array(days).fill(0) };
  for (const call of calls) {
    if (!matches(call) || call.t > now) continue;
    const i = Math.round((bucketStart(call.t, 'day', offset) - startDay) / DAY);
    if (i >= 0 && i < days) { activity.tot[i] += call.tot ?? 0; activity.calls[i]++; }
  }

  const final = finishTotals(totals);
  return {
    range: { name: range, from, to, bucket, fromLocal: from + offset(from), toLocal: to + offset(to), timeZone },
    totals: {
      ...final,
      models: models.size, sessions: bySession.size, toolCalls, toolErrors, modelMs, toolMs, waitMs,
      p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95),
    },
    previous: prevFrom !== undefined ? finishTotals(prev) : undefined,
    series: { keys: seriesKeys, labels: seriesKeys.map((key) => (key === 'other' ? null : models.get(key)?.model)), rows: series },
    models: modelList,
    purposes,
    errorCodes: Object.entries(errorCodes).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([code, count]) => ({ code, count })),
    hours,
    tools: toolList.slice(0, 40),
    toolCount: toolList.length,
    sessions: sessionList,
    notes: notes.slice(0, 3),
    activity,
    recent: recentCalls,
    earliest,
  };
}
