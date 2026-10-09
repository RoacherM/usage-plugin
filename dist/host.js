// src/host/backfill.js
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

// src/host/records.js
var int = (value) => Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
function usageFields(usage) {
  const u = usage ?? {};
  const fields = { in: int(u.inputTokens), out: int(u.outputTokens), cr: int(u.cacheReadTokens), cw: int(u.cacheWriteTokens), rs: int(u.reasoningTokens) };
  fields.tot = int(u.totalTokens) || fields.in + fields.out + fields.cr + fields.cw;
  return fields;
}
var FIRST_TOKEN = /* @__PURE__ */ new Set(["text-delta", "reasoning-delta", "tool-call-delta", "block-start"]);
var isFirstTokenChunk = (chunk) => FIRST_TOKEN.has(chunk?.type);
function streamFinish(stream) {
  for (let i = (stream?.length ?? 0) - 1; i >= 0; i--) {
    const record = stream[i];
    if (record?.type === "chunk" && record.chunk?.type === "finish") return record.chunk.reason;
  }
  return void 0;
}
var streamStart = (stream) => {
  const first = stream?.[0];
  return first?.time0 ?? first?.time;
};
function createSessionFold(sessionId, { emitTool, emitCall, calls = false, before = Infinity } = {}) {
  const pending = /* @__PURE__ */ new Map();
  let stepStart;
  let lastEventTime;
  let context = {};
  return function fold(event) {
    if (!event || typeof event.type !== "string") return;
    const time = event.time;
    const data = event.data ?? {};
    switch (event.type) {
      case "request/context":
        context = { p: data.provider, m: data.model };
        break;
      case "step/start":
        stepStart = time;
        break;
      case "tool/call":
        if (time < before) pending.set(data.callId, { t: time, n: data.name });
        break;
      case "tool/result": {
        const id = data.message?.toolCallId;
        const call = pending.get(id);
        if (!call) break;
        pending.delete(id);
        const failed = data.error !== void 0 || data.message?.isError === true;
        emitTool?.({ t: call.t, s: sessionId, n: call.n, ...failed ? { err: 1, code: data.error?.code } : {}, d: Math.max(0, time - call.t) }, id);
        break;
      }
      case "assistant/message": {
        if (!calls || time >= before) break;
        const source = data.message?.source ?? {};
        const start = stepStart ?? lastEventTime ?? time;
        const first = streamStart(data.stream);
        const finish = streamFinish(data.stream)?.kind ?? (data.interrupted ? "aborted" : void 0);
        emitCall?.({
          t: start,
          d: Math.max(0, time - start),
          ...first !== void 0 && first >= start ? { ft: first - start } : {},
          p: source.provider ?? context.p ?? "unknown",
          m: source.model ?? context.m ?? "unknown",
          s: sessionId,
          pu: "chat",
          ...usageFields(data.usage),
          f: finish ?? "stop",
          src: "log"
        }, data.message?.id);
        stepStart = void 0;
        break;
      }
      case "turn/end": {
        if (calls && time < before && data.reason?.kind === "error" && data.reason.error) {
          const start = stepStart ?? lastEventTime ?? time;
          emitCall?.({
            t: start,
            d: Math.max(0, time - start),
            p: context.p ?? "unknown",
            m: context.m ?? "unknown",
            s: sessionId,
            pu: "chat",
            ...usageFields(void 0),
            f: "error",
            e: String(data.reason.error.code ?? "error"),
            src: "log"
          }, `${sessionId}#turn-error#${event.seq}`);
        }
        stepStart = void 0;
        pending.clear();
        break;
      }
      default:
        break;
    }
    lastEventTime = time;
  };
}

// src/host/backfill.js
var defaultSessionsDir = () => join(homedir(), ".dsh", "sessions");
var MAGIC = [40, 181, 47, 253];
function decodeFrames(raw) {
  const starts = [];
  for (let i = 0; i <= raw.length - 4; i++) {
    if (raw[i] === MAGIC[0] && raw[i + 1] === MAGIC[1] && raw[i + 2] === MAGIC[2] && raw[i + 3] === MAGIC[3]) starts.push(i);
  }
  if (!starts.length) return "";
  const parts = [];
  let from = 0;
  for (let k = 1; k <= starts.length; k++) {
    const end = k < starts.length ? starts[k] : raw.length;
    try {
      parts.push(zstdDecompressSync(raw.subarray(starts[from], end)));
      from = k;
    } catch (error) {
      if (k === starts.length) {
        if (parts.length) break;
        throw error;
      }
    }
  }
  return Buffer.concat(parts).toString("utf8");
}
async function readLog(file) {
  const raw = await readFile(file);
  const text = file.endsWith(".zstd") ? decodeFrames(raw) : raw.toString("utf8");
  const events = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
    }
  }
  return events;
}
async function findLogs(root) {
  const logs = [];
  let workspaces;
  try {
    workspaces = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return logs;
    throw error;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const sessions = await readdir(join(root, workspace.name), { withFileTypes: true }).catch(() => []);
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const dir = join(root, workspace.name, session.name);
      const files = (await readdir(dir).catch(() => [])).map((name2) => ({ name: name2, version: Number(/^session\.v(\d+)\.jsonl(\.zstd)?$/.exec(name2)?.[1]) })).filter((f) => Number.isFinite(f.version)).sort((a, b) => b.version - a.version || (a.name.endsWith(".zstd") ? -1 : 1));
      if (files[0]) logs.push(join(dir, files[0].name));
    }
  }
  return logs;
}
async function scanSessionLogs({ root = defaultSessionsDir(), before = Infinity, onProgress } = {}) {
  const logs = await findLogs(root);
  const calls = [];
  const tools = [];
  const sessions = {};
  const seenCalls = /* @__PURE__ */ new Set();
  const seenTools = /* @__PURE__ */ new Set();
  const failed = [];
  let done = 0;
  for (const file of logs) {
    let events;
    try {
      events = await readLog(file);
    } catch (error) {
      failed.push({ file, error: error.message });
      continue;
    }
    const header = events[0]?.type === "session" ? events[0] : void 0;
    const id = header?.id;
    if (!id) continue;
    const info = { cwd: header.cwd, parent: header.parentSession, origin: header.origin, createdAt: header.createdAt };
    const fold = createSessionFold(id, {
      calls: true,
      before,
      emitCall: (record, key) => {
        if (key && seenCalls.has(key)) return;
        if (key) seenCalls.add(key);
        calls.push(record);
      },
      emitTool: (record, key) => {
        if (key && seenTools.has(key)) return;
        if (key) seenTools.add(key);
        tools.push(record);
      }
    });
    for (let i = 1; i < events.length; i++) {
      const event = events[i];
      if (event.type === "session/title" && event.data?.title) info.title = event.data.title;
      if (event.time !== void 0) info.lastAt = event.time;
      fold(event);
    }
    sessions[id] = info;
    done++;
    onProgress?.(done, logs.length);
    await new Promise((resolve) => setImmediate(resolve));
  }
  calls.sort((a, b) => a.t - b.t);
  tools.sort((a, b) => a.t - b.t);
  return { calls, tools, sessions, files: logs.length, failed };
}

// src/host/ledger.js
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir as readdir2, readFile as readFile2, rename, writeFile } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
var defaultDataDir = () => process.env.DSH_USAGE_DIR ?? join2(homedir2(), ".dsh", "plugin-data", "usage");
var month = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile2(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}
async function writeAtomic(file, text) {
  const temp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  await writeFile(temp, text);
  await rename(temp, file);
}
function parseLines(text, into) {
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      into.push(JSON.parse(line));
    } catch {
    }
  }
}
function createLedger({ dir = defaultDataDir(), onChange = () => {
} } = {}) {
  const state = {
    live: { calls: [], tools: [] },
    history: { calls: [], tools: [], importedAt: void 0, files: 0, error: void 0 },
    meta: { version: 1, cutoff: void 0, sessions: {} }
  };
  let queue = Promise.resolve();
  const exclusive = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {
    });
    return run;
  };
  let metaTimer;
  async function load() {
    try {
      await mkdir(dir, { recursive: true });
      const stored = await readJson(join2(dir, "meta.json"), {});
      state.meta = { ...state.meta, ...stored, sessions: { ...stored.sessions, ...state.meta.sessions } };
      const history = await readJson(join2(dir, "history.json"), void 0);
      if (history) Object.assign(state.history, { calls: history.calls ?? [], tools: history.tools ?? [], importedAt: history.importedAt, files: history.files ?? 0 });
      for (const name2 of (await readdir2(dir)).sort()) {
        const kind = /^(calls|tools)-\d{4}-\d{2}\.jsonl$/.exec(name2)?.[1];
        if (kind) parseLines(await readFile2(join2(dir, name2), "utf8"), state.live[kind]);
      }
      if (state.meta.cutoff === void 0) {
        state.meta.cutoff = Math.min(state.live.calls[0]?.t ?? Infinity, ...early.map(([, r]) => r.t), Date.now());
        await saveMeta();
      }
    } finally {
      const held = early;
      early = void 0;
      for (const [kind, record] of held) append(kind, record);
    }
    return ledger;
  }
  const saveMeta = () => exclusive(() => writeAtomic(join2(dir, "meta.json"), JSON.stringify(state.meta)));
  const saveMetaSoon = () => {
    clearTimeout(metaTimer);
    metaTimer = setTimeout(() => {
      saveMeta().catch(() => {
      });
    }, 1e3);
  };
  let early = [];
  function append(kind, record) {
    if (early) {
      early.push([kind, record]);
      return;
    }
    state.live[kind].push(record);
    const line = JSON.stringify(record) + "\n";
    exclusive(() => appendFile(join2(dir, `${kind}-${month(record.t)}.jsonl`), line)).catch(() => {
    });
    onChange();
  }
  const ledger = {
    dir,
    load,
    get cutoff() {
      return state.meta.cutoff;
    },
    addCall: (record) => append("calls", record),
    addTool: (record) => append("tools", record),
    calls: () => state.history.calls.length ? state.history.calls.concat(state.live.calls) : state.live.calls,
    tools: () => state.history.tools.length ? state.history.tools.concat(state.live.tools) : state.live.tools,
    history: () => ({ importedAt: state.history.importedAt, files: state.history.files, calls: state.history.calls.length, tools: state.history.tools.length, error: state.history.error }),
    sessions: () => state.meta.sessions,
    /** Merge what is known about a session (title, cwd, parent, origin); unknown fields are kept. */
    noteSession(id, info) {
      if (!id) return;
      const current = state.meta.sessions[id] ?? {};
      const next = { ...current };
      for (const [key, value] of Object.entries(info)) if (value !== void 0 && value !== null && value !== "") next[key] = value;
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      state.meta.sessions[id] = next;
      saveMetaSoon();
      onChange();
    },
    async replaceHistory({ calls, tools, files, sessions }) {
      const importedAt = Date.now();
      await exclusive(() => writeAtomic(join2(dir, "history.json"), JSON.stringify({ version: 1, importedAt, files, calls, tools })));
      Object.assign(state.history, { calls, tools, files, importedAt, error: void 0 });
      for (const [id, info] of Object.entries(sessions ?? {})) {
        state.meta.sessions[id] = { ...info, ...state.meta.sessions[id] };
      }
      await saveMeta();
      onChange();
    },
    failHistory(error) {
      state.history.error = error;
      onChange();
    },
    async flush() {
      clearTimeout(metaTimer);
      await saveMeta();
      await queue;
    }
  };
  return ledger;
}

// src/host/recorder.js
async function* observeStream(options, stream, record, now = Date.now) {
  const t = now();
  let firstToken;
  let usage;
  let finish;
  let thrown;
  try {
    for await (const chunk of stream) {
      if (firstToken === void 0 && isFirstTokenChunk(chunk)) firstToken = now() - t;
      if (chunk?.type === "usage") usage = { ...usage, ...chunk.usage };
      else if (chunk?.type === "finish") finish = chunk.reason;
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
        if (options?.signal?.aborted) kind = "aborted";
        else if (thrown) {
          kind = "error";
          code = thrown?.code ?? thrown?.name ?? "exception";
        } else kind = "aborted";
      }
      record({
        t,
        d: now() - t,
        ...firstToken !== void 0 ? { ft: firstToken } : {},
        p: options?.provider ?? "unknown",
        m: options?.model ?? "unknown",
        ...options?.sessionId ? { s: String(options.sessionId) } : {},
        pu: options?.purpose ?? (options?.sessionId ? "chat" : "other"),
        ...usageFields(usage),
        f: kind,
        ...kind === "error" && code ? { e: String(code) } : {},
        src: "live"
      });
    } catch {
    }
  }
}
function installRecorder(ctx, ledger) {
  ctx.on("llm/stream", (options, next) => observeStream(options, next(), ledger.addCall), { global: true });
  const folds = /* @__PURE__ */ new Map();
  const foldFor = (id) => {
    let fold = folds.get(id);
    if (!fold) folds.set(id, fold = createSessionFold(id, { emitTool: ledger.addTool }));
    return fold;
  };
  ctx.on("session/event", (session, event) => {
    try {
      const id = String(session?.id ?? "");
      if (!id) return;
      if (event.type === "session/title" && event.data?.title) {
        const header = session.header ?? {};
        ledger.noteSession(id, { title: event.data.title, cwd: header.cwd, parent: header.parentSession, origin: header.origin, createdAt: header.createdAt });
      }
      if (event.type === "tool/call" || event.type === "tool/result" || event.type === "turn/end") foldFor(id)(event);
    } catch {
    }
  });
  ctx.on("session/disposed", (session) => {
    folds.delete(String(session?.id ?? ""));
  });
}

// src/host/aggregate.js
var HOUR = 36e5;
var DAY = 864e5;
var RANGES = ["today", "7d", "30d", "90d", "all"];
var TOP_MODELS = 6;
var WAIT_TOOLS = /* @__PURE__ */ new Set(["ask_user_question", "exit_plan_mode"]);
var CONTEXT_WARN = 4e5;
var REBUILD_MIN = 2e4;
var CACHE_TTL = 5 * 6e4;
var IDLE_NOTE_MIN = 2e5;
var FAIL_NOTE_MIN = 5;
var promptOf = (call) => (call.in ?? 0) + (call.cr ?? 0) + (call.cw ?? 0);
var modelKey = (p, m) => `${p}|${m}`;
function zoneOffset(timeZone) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }
  const cache = /* @__PURE__ */ new Map();
  return (t) => {
    const hour = Math.floor(t / HOUR);
    let offset = cache.get(hour);
    if (offset === void 0) {
      const parts = {};
      for (const part of fmt.formatToParts(new Date(hour * HOUR))) parts[part.type] = part.value;
      offset = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute) - hour * HOUR;
      cache.set(hour, offset);
    }
    return offset;
  };
}
function localDayStart(t, offset) {
  const local = t + offset(t);
  const day = Math.floor(local / DAY) * DAY;
  return day - offset(day - offset(t));
}
function resolveRange(range, { now = Date.now(), offset, earliest }) {
  const today = localDayStart(now, offset);
  const days = { today: 1, "7d": 7, "30d": 30, "90d": 90 }[range];
  if (days) {
    const from2 = days === 1 ? today : localDayStart(today - (days - 1) * DAY + 12 * HOUR, offset);
    return { from: from2, to: now, bucket: days === 1 ? "hour" : "day", prevFrom: from2 - (now - from2) };
  }
  const from = earliest !== void 0 ? localDayStart(earliest, offset) : today;
  const span = (now - from) / DAY;
  return { from, to: now, bucket: span > 180 ? "week" : "day", prevFrom: void 0 };
}
function bucketStart(t, bucket, offset) {
  const local = t + offset(t);
  if (bucket === "hour") return Math.floor(local / HOUR) * HOUR;
  const day = Math.floor(local / DAY) * DAY;
  if (bucket === "day") return day;
  const weekday = (new Date(day).getUTCDay() + 6) % 7;
  return day - weekday * DAY;
}
var nextBucket = (at, bucket) => at + (bucket === "hour" ? HOUR : bucket === "day" ? DAY : 7 * DAY);
var emptyTotals = () => ({ calls: 0, errors: 0, aborted: 0, in: 0, out: 0, cr: 0, cw: 0, rs: 0, tot: 0, gOut: 0, gMs: 0, fts: [], dSum: 0, dN: 0, ftSum: 0, ftN: 0 });
function addCall(target, call) {
  target.calls++;
  if (call.f === "error") target.errors++;
  if (call.f === "aborted") target.aborted++;
  target.in += call.in ?? 0;
  target.out += call.out ?? 0;
  target.cr += call.cr ?? 0;
  target.cw += call.cw ?? 0;
  target.rs += call.rs ?? 0;
  target.tot += call.tot ?? 0;
  if (call.f !== "error" && Number.isFinite(call.d)) {
    target.dSum += call.d;
    target.dN++;
  }
  if (Number.isFinite(call.ft)) {
    target.ftSum += call.ft;
    target.ftN++;
    target.fts.push(call.ft);
  }
  if (call.f !== "error" && (call.out ?? 0) >= 50 && call.d > 0) {
    target.gOut += call.out;
    target.gMs += Math.max(1, call.d - (call.ft ?? 0));
  }
}
function finishTotals(t) {
  const { dSum, dN, ftSum, ftN, gOut, gMs, fts, ...rest } = t;
  const prompt = t.in + t.cr + t.cw;
  fts.sort((a, b) => a - b);
  return {
    ...rest,
    avgMs: dN ? Math.round(dSum / dN) : void 0,
    avgTtft: ftN ? Math.round(ftSum / ftN) : void 0,
    cacheRate: prompt ? t.cr / prompt : void 0,
    avgPrompt: t.calls - t.errors > 0 ? Math.round(prompt / (t.calls - t.errors)) : void 0,
    speed: gMs ? Math.round(gOut / (gMs / 1e3)) : void 0,
    ttftMed: fts.length ? fts[fts.length >> 1] : void 0
  };
}
var percentile = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : void 0;
function aggregate({ calls, tools, sessions = {}, range = "7d", timeZone = "UTC", filter, now = Date.now(), recent = 60 }) {
  const offset = zoneOffset(timeZone);
  let earliest;
  for (const call of calls) if (earliest === void 0 || call.t < earliest) earliest = call.t;
  const { from, to, bucket, prevFrom } = resolveRange(RANGES.includes(range) ? range : "7d", { now, offset, earliest });
  const matches = (call) => !filter || modelKey(call.p, call.m) === filter;
  const inRange = [];
  const prev = emptyTotals();
  for (const call of calls) {
    if (!matches(call)) continue;
    if (call.t >= from && call.t <= to) inRange.push(call);
    else if (prevFrom !== void 0 && call.t >= prevFrom && call.t < from) addCall(prev, call);
  }
  inRange.sort((a, b) => a.t - b.t);
  const totals = emptyTotals();
  const models = /* @__PURE__ */ new Map();
  const bySession = /* @__PURE__ */ new Map();
  const purposes = {};
  const errorCodes = {};
  const hours2 = Array.from({ length: 24 }, () => ({ calls: 0, tot: 0 }));
  const durations = [];
  let modelMs = 0;
  const lastEnd = /* @__PURE__ */ new Map();
  const idle = { calls: 0, tokens: 0 };
  for (const call of inRange) {
    if (Number.isFinite(call.d)) modelMs += call.d;
    if (call.s && call.f !== "error") {
      const end = lastEnd.get(call.s);
      if (end !== void 0 && call.t - end > CACHE_TTL && (call.cw ?? 0) > REBUILD_MIN && call.cw > promptOf(call) / 2) {
        idle.calls++;
        idle.tokens += call.cw;
      }
      lastEnd.set(call.s, call.t + (call.d ?? 0));
    }
    addCall(totals, call);
    const key = modelKey(call.p, call.m);
    let model = models.get(key);
    if (!model) models.set(key, model = { key, provider: call.p, model: call.m, ...emptyTotals(), lastAt: 0, sources: {} });
    addCall(model, call);
    model.lastAt = Math.max(model.lastAt, call.t);
    model.sources[call.src ?? "live"] = (model.sources[call.src ?? "live"] ?? 0) + 1;
    const purpose = call.pu ?? "chat";
    purposes[purpose] ??= { calls: 0, tot: 0 };
    purposes[purpose].calls++;
    purposes[purpose].tot += call.tot ?? 0;
    if (call.f === "error") errorCodes[call.e ?? "error"] = (errorCodes[call.e ?? "error"] ?? 0) + 1;
    const hour = new Date(call.t + offset(call.t)).getUTCHours();
    hours2[hour].calls++;
    hours2[hour].tot += call.tot ?? 0;
    if (call.f !== "error" && Number.isFinite(call.d)) durations.push(call.d);
    if (call.s) {
      let session = bySession.get(call.s);
      if (!session) bySession.set(call.s, session = { id: call.s, ...emptyTotals(), lastAt: 0, models: /* @__PURE__ */ new Set(), ctxFirst: void 0, ctxPeak: 0 });
      addCall(session, call);
      if (call.f !== "error" && (call.pu ?? "chat") === "chat") {
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
  const seriesKeys = modelList.length > TOP_MODELS ? [...topKeys, "other"] : topKeys;
  const slot = new Map(seriesKeys.map((key, i) => [key, i]));
  const series = [];
  const index = /* @__PURE__ */ new Map();
  for (let at = bucketStart(from, bucket, offset), end = bucketStart(to, bucket, offset); at <= end; at = nextBucket(at, bucket)) {
    index.set(at, series.length);
    series.push({ at, tok: seriesKeys.map(() => 0), calls: seriesKeys.map(() => 0), errors: 0 });
    if (series.length > 800) break;
  }
  for (const call of inRange) {
    const row = series[index.get(bucketStart(call.t, bucket, offset))];
    if (!row) continue;
    const i = slot.get(modelKey(call.p, call.m)) ?? slot.get("other");
    if (i !== void 0) {
      row.tok[i] += call.tot ?? 0;
      row.calls[i]++;
    }
    if (call.f === "error") row.errors++;
  }
  const toolRows = /* @__PURE__ */ new Map();
  let toolCalls = 0;
  let toolErrors = 0;
  let toolMs = 0;
  let waitMs = 0;
  const failures = /* @__PURE__ */ new Map();
  const sessionsInRange = filter ? new Set(bySession.keys()) : void 0;
  for (const tool of tools) {
    if (tool.t < from || tool.t > to) continue;
    if (sessionsInRange && !sessionsInRange.has(tool.s)) continue;
    let row = toolRows.get(tool.n);
    if (!row) toolRows.set(tool.n, row = { name: tool.n, calls: 0, errors: 0, dSum: 0, dN: 0, codes: {} });
    row.calls++;
    toolCalls++;
    if (tool.err) {
      row.errors++;
      toolErrors++;
      if (tool.code) row.codes[tool.code] = (row.codes[tool.code] ?? 0) + 1;
    }
    if (Number.isFinite(tool.d)) {
      row.dSum += tool.d;
      row.dN++;
      if (WAIT_TOOLS.has(tool.n)) waitMs += tool.d;
      else toolMs += tool.d;
    }
    if (tool.err) {
      const key = `${tool.n}\0${tool.code ?? ""}`;
      failures.set(key, (failures.get(key) ?? 0) + 1);
    }
  }
  const toolList = [...toolRows.values()].map(({ dSum, dN, codes, ...row }) => ({ ...row, avgMs: dN ? Math.round(dSum / dN) : void 0, topError: Object.entries(codes).sort((a, b) => b[1] - a[1])[0]?.[0] })).sort((a, b) => b.calls - a.calls);
  const describe = (id) => {
    const info = sessions[id] ?? {};
    return { title: info.title, cwd: info.cwd, origin: info.origin, parent: info.parent };
  };
  const sessionList = [...bySession.values()].map((s) => ({ ...finishTotals(s), models: [...s.models], ...describe(s.id) })).sort((a, b) => b.tot - a.tot).slice(0, 20);
  const recentCalls = inRange.slice(-recent).reverse().map((call) => ({
    ...call,
    title: call.s ? sessions[call.s]?.title : void 0,
    origin: call.s ? sessions[call.s]?.origin : void 0
  }));
  const notes = [];
  const bloated = [...bySession.values()].filter((s) => s.ctxPeak >= CONTEXT_WARN).sort((a, b) => b.ctxPeak - a.ctxPeak);
  if (bloated.length) {
    const top = bloated[0];
    notes.push({ kind: "context", session: top.id, title: sessions[top.id]?.title, first: top.ctxFirst, peak: top.ctxPeak, calls: top.calls, others: bloated.length - 1 });
  }
  if (idle.tokens >= IDLE_NOTE_MIN) notes.push({ kind: "cacheIdle", calls: idle.calls, tokens: idle.tokens, share: totals.cw ? idle.tokens / totals.cw : void 0 });
  const [failKey, failCount] = [...failures.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (failCount >= FAIL_NOTE_MIN) {
    const [tool, code] = failKey.split("\0");
    notes.push({ kind: "toolFail", tool, code: code || void 0, count: failCount });
  }
  const today = bucketStart(now, "day", offset);
  const startDay = today - (52 * 7 + (new Date(today).getUTCDay() + 6) % 7) * DAY;
  const days = Math.round((today - startDay) / DAY) + 1;
  const activity = { start: startDay, tot: new Array(days).fill(0), calls: new Array(days).fill(0) };
  for (const call of calls) {
    if (!matches(call) || call.t > now) continue;
    const i = Math.round((bucketStart(call.t, "day", offset) - startDay) / DAY);
    if (i >= 0 && i < days) {
      activity.tot[i] += call.tot ?? 0;
      activity.calls[i]++;
    }
  }
  const final = finishTotals(totals);
  return {
    range: { name: range, from, to, bucket, fromLocal: from + offset(from), toLocal: to + offset(to), timeZone },
    totals: {
      ...final,
      models: models.size,
      sessions: bySession.size,
      toolCalls,
      toolErrors,
      modelMs,
      toolMs,
      waitMs,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95)
    },
    previous: prevFrom !== void 0 ? finishTotals(prev) : void 0,
    series: { keys: seriesKeys, labels: seriesKeys.map((key) => key === "other" ? null : models.get(key)?.model), rows: series },
    models: modelList,
    purposes,
    errorCodes: Object.entries(errorCodes).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([code, count]) => ({ code, count })),
    hours: hours2,
    tools: toolList.slice(0, 40),
    toolCount: toolList.length,
    sessions: sessionList,
    notes: notes.slice(0, 3),
    activity,
    recent: recentCalls,
    earliest
  };
}

// src/host/routes.js
var json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});
function registerRoutes(ctx, { ledger, changes, importHistory, importState }) {
  const summary = (url) => {
    const q = url.searchParams;
    return {
      ...aggregate({
        calls: ledger.calls(),
        tools: ledger.tools(),
        sessions: ledger.sessions(),
        range: q.get("range") ?? "7d",
        timeZone: q.get("tz") ?? "UTC",
        filter: q.get("model") || void 0
      }),
      history: { ...ledger.history(), ...importState() },
      cutoff: ledger.cutoff,
      revision: changes.revision
    };
  };
  const routes = [
    ["GET", "/api/usage/summary", async (request, url) => json(summary(url))],
    ["GET", "/api/usage/wait", async (request, url) => {
      const since = Number(url.searchParams.get("revision") ?? -1);
      if (changes.revision === since) {
        await new Promise((resolve) => {
          const timer = setTimeout(done, 5e3);
          const unsubscribe = changes.subscribe(done);
          request.signal?.addEventListener("abort", done, { once: true });
          function done() {
            clearTimeout(timer);
            unsubscribe();
            resolve();
          }
        });
      }
      return json({ revision: changes.revision });
    }],
    ["POST", "/api/usage/import", async () => {
      importHistory().catch(() => {
      });
      return json({ started: true });
    }]
  ];
  for (const [method, path, fn] of routes) {
    ctx.effect(() => ctx.connection.fetch.register({
      path,
      methods: [method],
      requestBody: "buffered",
      fetch: async (request) => {
        try {
          return await fn(request, new URL(request.url));
        } catch (error) {
          return json({ error: error?.message ?? String(error) }, 500);
        }
      }
    }), "dsh-usage: " + path);
  }
}

// src/host/tools.js
var hostZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
function callerTimeZone(exec) {
  try {
    const messages = exec?.agent?.session?.deriveMessages?.() ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const zone = messages[i]?.role === "user" ? messages[i].source?.clientTimeZone : void 0;
      if (zone) {
        new Intl.DateTimeFormat("en", { timeZone: zone });
        return zone;
      }
    }
  } catch {
  }
  return hostZone();
}
var fmtTokens = (n) => {
  if (!n) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
};
var pct = (x) => x === void 0 ? "\u2014" : (x * 100).toFixed(1) + "%";
var secs = (ms) => ms === void 0 ? "\u2014" : (ms / 1e3).toFixed(1) + "s";
var hours = (ms) => (ms / 36e5).toFixed(1) + "h";
function noteText(note) {
  if (note.kind === "context") return `Session \u300C${note.title ?? note.session}\u300D grew its context from ${fmtTokens(note.first)} to ${fmtTokens(note.peak)} tokens over ${note.calls} calls (every call re-reads it)${note.others ? `; ${note.others} more sessions passed 400K` : ""}. Suggest /compact or a fresh session for long tasks.`;
  if (note.kind === "cacheIdle") return `${note.calls} times the prompt cache expired after >5 idle minutes, re-writing ${fmtTokens(note.tokens)} tokens.`;
  if (note.kind === "toolFail") return `Tool ${note.tool} failed ${note.count} times${note.code ? ` with ${note.code}` : ""}.`;
  return "";
}
function renderReport(report, { rangeLabel }) {
  const t = report.totals;
  const lines = [
    `DSH usage \u2014 ${rangeLabel} (${report.range.timeZone})`,
    `Model calls: ${t.calls} (errors ${t.errors}, aborted ${t.aborted}) across ${t.sessions} sessions and ${t.models} models`,
    `Tokens: total ${fmtTokens(t.tot)} = uncached input ${fmtTokens(t.in)} + cache read ${fmtTokens(t.cr)} + cache write ${fmtTokens(t.cw)} + output ${fmtTokens(t.out)}${t.rs ? ` (reasoning ${fmtTokens(t.rs)})` : ""}`,
    `Cache hit rate ${pct(t.cacheRate)} \xB7 avg latency ${secs(t.avgMs)} (p95 ${secs(t.p95Ms)}) \xB7 avg time to first token ${secs(t.avgTtft)}`,
    `Tool calls: ${t.toolCalls} (errors ${t.toolErrors}) \xB7 agent working time ${hours(t.modelMs + t.toolMs)} (model ${hours(t.modelMs)}, tools ${hours(t.toolMs)}; plus ${hours(t.waitMs)} waiting for the user)`,
    "",
    "| provider | model | calls | errors | input | cache read | output | total | avg latency | speed | first token |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.models.map((m) => `| ${m.provider} | ${m.model} | ${m.calls} | ${m.errors} | ${fmtTokens(m.in + m.cw)} | ${fmtTokens(m.cr)} | ${fmtTokens(m.out)} | ${fmtTokens(m.tot)} | ${secs(m.avgMs)} | ${m.speed ? m.speed + " tok/s" : "\u2014"} | ${secs(m.ttftMed)} |`)
  ];
  if (report.notes?.length) lines.push("", "Worth knowing:", ...report.notes.map((note) => "- " + noteText(note)));
  if (report.tools.length) {
    lines.push("", "Top tools: " + report.tools.slice(0, 10).map((x) => `${x.name} ${x.calls}${x.errors ? ` (${x.errors} failed)` : ""}`).join(", "));
  }
  if (report.sessions.length) {
    lines.push("", "Top sessions by tokens: " + report.sessions.slice(0, 5).map((s) => `\u300C${s.title ?? s.id}\u300D ${fmtTokens(s.tot)}`).join("; "));
  }
  if (report.errorCodes.length) {
    lines.push("", "Model errors: " + report.errorCodes.map((e) => `${e.code} \xD7${e.count}`).join(", "));
  }
  return lines.join("\n");
}
var LABEL = { today: "today", "7d": "last 7 days", "30d": "last 30 days", "90d": "last 90 days", all: "all time" };
function registerTools(ctx, { ledger }) {
  ctx.effect(() => ctx.tools.register({
    name: "usage_report",
    description: [
      "Report DSH model usage from the local usage ledger: tokens (uncached input, cache read/write, output, reasoning), call counts, errors, latency, output speed and cache hit rate per model, agent working time, notes on context growth / cache expiry / repeated tool failures, plus top tools and sessions.",
      `Use it when the user asks how many tokens / calls they have used, which model they use most, cache hit rate, etc. Present the numbers concisely in the user's language and mention they can see charts on the "\u7528\u91CF" (Usage) page in the left sidebar.`
    ].join("\n"),
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        range: { type: "string", enum: RANGES, description: "Time range in the user's time zone: today, 7d, 30d, 90d, or all. Default 7d." },
        model: { type: "string", description: 'Optional: limit to one model id (e.g. "deepseek-chat"); matched against the model name, any provider.' }
      }
    },
    output: {
      schema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } },
      render: (_args, value) => [{ type: "text", text: value.text }]
    },
    async execute(args, exec) {
      const range = RANGES.includes(args?.range) ? args.range : "7d";
      let calls = ledger.calls();
      if (args?.model) calls = calls.filter((c) => c.m === args.model || c.m.endsWith("/" + args.model) || `${c.p}|${c.m}` === args.model);
      const report = aggregate({ calls, tools: ledger.tools(), sessions: ledger.sessions(), range, timeZone: callerTimeZone(exec) });
      return { text: renderReport(report, { rangeLabel: LABEL[range] + (args?.model ? ` \xB7 model ${args.model}` : "") }) };
    }
  }), "dsh-usage: usage_report");
}

// src/host/index.js
var name = "dsh-usage";
var inject = ["connection", "tools"];
function apply(ctx, config = {}) {
  const log = (message) => ctx.logger?.warn?.(message);
  const listeners = /* @__PURE__ */ new Set();
  let pending;
  const changes = {
    revision: 0,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    bump() {
      if (pending) return;
      pending = setTimeout(() => {
        pending = void 0;
        changes.revision++;
        for (const fn of listeners) fn();
      }, 400);
    }
  };
  const ledger = createLedger({ dir: config.dataDir, onChange: () => changes.bump() });
  const ready = ledger.load();
  let importing = { importing: false, progress: void 0 };
  const importState = () => importing;
  async function importHistory() {
    if (importing.importing) return;
    await ready;
    importing = { importing: true, progress: { done: 0, total: 0 } };
    changes.bump();
    try {
      const scan = await scanSessionLogs({
        root: config.sessionsDir,
        before: ledger.cutoff,
        onProgress: (done, total) => {
          importing.progress = { done, total };
          if (done % 10 === 0) changes.bump();
        }
      });
      if (scan.failed.length) log(`dsh-usage: ${scan.failed.length} session logs could not be read (${scan.failed[0].file}: ${scan.failed[0].error})`);
      await ledger.replaceHistory(scan);
    } catch (error) {
      log(`dsh-usage: history import failed: ${error.message}`);
      ledger.failHistory(error.message);
    } finally {
      importing = { importing: false, progress: void 0 };
      changes.bump();
    }
  }
  installRecorder(ctx, ledger);
  registerRoutes(ctx, { ledger, changes, importHistory, importState });
  registerTools(ctx, { ledger });
  ready.then(() => {
    if (!ledger.history().importedAt && config.importHistory !== false) importHistory();
  }).catch((error) => log(`dsh-usage: cannot load ledger: ${error.message}`));
  ctx.effect(() => () => {
    clearTimeout(pending);
    ledger.flush().catch(() => {
    });
  }, "dsh-usage: flush");
}
export {
  apply,
  inject,
  name
};
